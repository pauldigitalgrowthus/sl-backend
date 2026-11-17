const { makeApiRequest, queryQb } = require('./quickbooks.client');
const { getAccountsPayableAccount, getRoyaltyExpenseAccount } = require('./quickbooks.account');

/**
 * Create a QuickBooks Bill for a Royalty Record
 *
 * @param {string} realmId - QuickBooks realmId
 * @param {object} params
 * @param {string} params.vendorId - QuickBooks Vendor ID
 * @param {number} params.amount - Royalty amount
 * @param {number|string} params.royaltyId - Royalty Record ID
 * @param {string} [params.artistName] - Artist Name
 * @param {string} [params.songTitle] - Song / Publication Title
 * @param {string} [params.payPeriod] - Pay Period label
 */
const createBill = async (realmId, { vendorId, amount, royaltyId, artistName = '', songTitle = '', payPeriod = '' }) => {
  if (!vendorId) throw new Error('QuickBooks Vendor ID is required to create a Bill.');
  if (!amount || amount <= 0) throw new Error('Valid royalty amount > 0 is required to create a Bill.');
  if (!royaltyId) throw new Error('Royalty ID is required to create a Bill.');

  // Obtain AP Account and Royalty Expense Account
  const apAccount = await getAccountsPayableAccount(realmId);
  const expenseAccount = await getRoyaltyExpenseAccount(realmId);

  const numericAmount = parseFloat(parseFloat(amount).toFixed(2));
  const docNumber = `ROY-${royaltyId}`.slice(0, 21); // QB DocNumber max length 21 chars

  const privateNote = `Royalty payout for ${artistName || 'Artist'} (Royalty #${royaltyId}${songTitle ? ', Song: ' + songTitle : ''}${payPeriod ? ', Period: ' + payPeriod : ''})`;

  const billPayload = {
    VendorRef: {
      value: vendorId
    },
    APAccountRef: {
      value: apAccount.id
    },
    DocNumber: docNumber,
    PrivateNote: privateNote,
    TxnDate: new Date().toISOString().slice(0, 10),
    Line: [
      {
        Amount: numericAmount,
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: {
          AccountRef: {
            value: expenseAccount.id
          }
        },
        Description: `Royalty Record #${royaltyId}${songTitle ? ' - ' + songTitle : ''}`
      }
    ]
  };

  try {
    const result = await makeApiRequest(realmId, {
      method: 'POST',
      url: '/bill',
      data: billPayload
    });

    const createdBill = result?.Bill;
    if (!createdBill || !createdBill.Id) {
      throw new Error('QuickBooks Online API did not return a valid Bill object.');
    }

    return {
      billId: String(createdBill.Id),
      syncToken: String(createdBill.SyncToken || '0'),
      balance: parseFloat(createdBill.Balance || numericAmount),
      totalAmt: parseFloat(createdBill.TotalAmt || numericAmount),
      docNumber: createdBill.DocNumber,
      bill: createdBill
    };
  } catch (error) {
    console.error(`❌ Failed to create QuickBooks Bill for Royalty #${royaltyId}:`, error.message);
    throw error;
  }
};

/**
 * Get Bill details by Bill ID from QuickBooks
 */
const getBill = async (realmId, billId) => {
  const data = await makeApiRequest(realmId, {
    method: 'GET',
    url: `/bill/${billId}`
  });

  const bill = data?.Bill;
  if (!bill) return null;

  return {
    billId: String(bill.Id),
    syncToken: String(bill.SyncToken || '0'),
    balance: parseFloat(bill.Balance || 0),
    totalAmt: parseFloat(bill.TotalAmt || 0),
    docNumber: bill.DocNumber,
    isPaid: parseFloat(bill.Balance || 0) === 0,
    bill
  };
};

/**
 * Query Bill by DocNumber (ROY-{royaltyId})
 */
const findBillByRoyaltyId = async (realmId, royaltyId) => {
  const docNumber = `ROY-${royaltyId}`.replace(/'/g, "\\'");
  const result = await queryQb(realmId, `SELECT * FROM Bill WHERE DocNumber = '${docNumber}'`);
  const bills = result?.Bill || [];
  return bills.length > 0 ? bills[0] : null;
};

module.exports = {
  createBill,
  getBill,
  findBillByRoyaltyId
};
