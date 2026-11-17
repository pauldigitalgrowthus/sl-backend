const { makeApiRequest, queryQb } = require('./quickbooks.client');
const { getBankPaymentAccount } = require('./quickbooks.account');
const { getBill } = require('./quickbooks.bill');

/**
 * Create a QuickBooks BillPayment linked to an existing Bill
 *
 * @param {string} realmId - QuickBooks realmId
 * @param {object} params
 * @param {string} params.vendorId - QuickBooks Vendor ID
 * @param {string} params.billId - QuickBooks Bill ID to pay
 * @param {number} params.amount - Payment amount
 * @param {number|string} params.royaltyId - Royalty Record ID
 * @param {string} [params.bankAccountId] - Optional bank account override
 */
const createBillPayment = async (realmId, { vendorId, billId, amount, royaltyId, bankAccountId = null, checkRef = null, paymentMethod = null }) => {
  if (!vendorId) throw new Error('QuickBooks Vendor ID is required for BillPayment.');
  if (!billId) throw new Error('QuickBooks Bill ID is required for BillPayment.');
  if (!amount || amount <= 0) throw new Error('Valid payment amount > 0 is required for BillPayment.');

  // Identify Bank Account for payment
  let bankAccount;
  if (bankAccountId) {
    bankAccount = { id: bankAccountId };
  } else {
    bankAccount = await getBankPaymentAccount(realmId);
  }

  const numericAmount = parseFloat(parseFloat(amount).toFixed(2));

  const billPaymentPayload = {
    VendorRef: {
      value: vendorId
    },
    PayType: 'Check',
    CheckPayment: {
      BankAccountRef: {
        value: bankAccount.id
      }
    },
    ...(checkRef ? { DocNumber: String(checkRef).slice(0, 21) } : {}),
    TotalAmt: numericAmount,
    TxnDate: new Date().toISOString().slice(0, 10),
    PrivateNote: `BillPayment for Royalty #${royaltyId}${checkRef ? ` - Ref: ${checkRef}` : ''} (${paymentMethod || 'External Payout'})`,
    Line: [
      {
        Amount: numericAmount,
        LinkedTxn: [
          {
            TxnId: billId,
            TxnType: 'Bill'
          }
        ]
      }
    ]
  };

  try {
    const result = await makeApiRequest(realmId, {
      method: 'POST',
      url: '/billpayment',
      data: billPaymentPayload
    });

    const createdPayment = result?.BillPayment;
    if (!createdPayment || !createdPayment.Id) {
      throw new Error('QuickBooks Online API did not return a valid BillPayment object.');
    }

    const paymentId = String(createdPayment.Id);
    const syncToken = String(createdPayment.SyncToken || '0');

    // Read the Bill again to verify Balance = 0
    let verifiedBill = null;
    try {
      verifiedBill = await getBill(realmId, billId);
    } catch (readErr) {
      console.warn(`⚠️ Could not re-read Bill #${billId} post payment:`, readErr.message);
    }

    const remainingBalance = verifiedBill ? verifiedBill.balance : 0;
    const isFullyPaid = remainingBalance === 0;

    return {
      paymentId,
      syncToken,
      billBalance: remainingBalance,
      isFullyPaid,
      billPayment: createdPayment
    };
  } catch (error) {
    console.error(`❌ Failed to create QuickBooks BillPayment for Bill #${billId} (Royalty #${royaltyId}):`, error.message);
    throw error;
  }
};

/**
 * Get BillPayment by ID from QuickBooks
 */
const getBillPayment = async (realmId, paymentId) => {
  const data = await makeApiRequest(realmId, {
    method: 'GET',
    url: `/billpayment/${paymentId}`
  });

  const payment = data?.BillPayment;
  if (!payment) return null;

  return {
    paymentId: String(payment.Id),
    syncToken: String(payment.SyncToken || '0'),
    totalAmt: parseFloat(payment.TotalAmt || 0),
    payment
  };
};

module.exports = {
  createBillPayment,
  getBillPayment
};
