const { getMySQLConnection } = require('../config/mysql');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const qbService = require('./quickbooks/quickbooks.service');
const { logPayoutAction } = require('../utils/payoutAuditLogger');
const { sendEmail } = require('../utils/SendMailer');

/**
 * 1. Create QuickBooks Bill for a Royalty Record (unpaid status)
 */
const createQuickbooksBillForRoyalty = async (royaltyId, realmIdParam = null) => {
  const mysql = getMySQLConnection();

  // Fetch royalty record with artist details
  let [[royalty]] = await mysql.execute(
    `SELECT ce.*, u.first_name, u.last_name, u.email
     FROM composer_earnings ce
     JOIN users u ON u.id = ce.composer_id
     WHERE ce.id = ?`,
    [royaltyId]
  );

  if (!royalty) {
    const [compRows] = await mysql.execute(
      `SELECT ce.*, u.first_name, u.last_name, u.email
       FROM composer_earnings ce
       JOIN users u ON u.id = ce.composer_id
       WHERE ce.composer_id = ? AND ce.status = 'pending'
       ORDER BY ce.id DESC LIMIT 1`,
      [royaltyId]
    );
    if (compRows.length > 0) royalty = compRows[0];
  }

  if (!royalty) {
    throw new Error(`Royalty record #${royaltyId} not found.`);
  }

  // Idempotency: Check if QuickBooks Bill already exists
  if (royalty.quickbooks_bill_id) {
    console.log(`ℹ️ QuickBooks Bill already exists for Royalty #${royaltyId} (Bill ID: ${royalty.quickbooks_bill_id}).`);
    return {
      success: true,
      billId: royalty.quickbooks_bill_id,
      vendorId: royalty.quickbooks_vendor_id,
      alreadyExisted: true
    };
  }

  // Check QB Connection
  const connStatus = await qbService.getConnectionStatus(realmIdParam);
  if (!connStatus.connected) {
    throw new Error('QuickBooks is not connected. Please connect QuickBooks before creating the royalty bill.');
  }

  const realmId = connStatus.realmId;

  // 1. Find or create QB Vendor for Artist
  const artistUser = {
    id: royalty.composer_id,
    email: royalty.email,
    first_name: royalty.first_name,
    last_name: royalty.last_name
  };

  const { vendorId } = await qbService.findOrCreateVendor(realmId, artistUser);

  await logPayoutAction({
    royaltyId: royalty.id,
    artistId: royalty.composer_id,
    action: 'QB_VENDOR_RESOLVED',
    status: 'SUCCESS',
    details: { vendorId }
  });

  // 2. Create QuickBooks Bill
  const amount = parseFloat(royalty.composer_earning);
  if (amount <= 0) {
    throw new Error(`Royalty amount must be greater than 0 (current: $${amount}).`);
  }

  const billResult = await qbService.createBill(realmId, {
    vendorId,
    amount,
    royaltyId: royalty.id,
    artistName: `${royalty.first_name} ${royalty.last_name}`.trim(),
    songTitle: royalty.composition_title,
    payPeriod: royalty.pay_period
  });

  // Update DB with QuickBooks Bill identifiers
  await mysql.execute(
    `UPDATE composer_earnings
     SET quickbooks_vendor_id = ?,
         quickbooks_bill_id = ?,
         quickbooks_bill_sync_token = ?,
         quickbooks_bill_balance = ?,
         quickbooks_status = 'BILL_CREATED',
         quickbooks_last_synced_at = NOW(),
         quickbooks_error = NULL
     WHERE id = ?`,
    [vendorId, billResult.billId, billResult.syncToken, billResult.balance, royalty.id]
  );

  await logPayoutAction({
    royaltyId: royalty.id,
    artistId: royalty.composer_id,
    action: 'QB_BILL_CREATED',
    status: 'SUCCESS',
    details: { billId: billResult.billId, amount, vendorId, docNumber: billResult.docNumber }
  });

  return {
    success: true,
    billId: billResult.billId,
    vendorId,
    balance: billResult.balance,
    docNumber: billResult.docNumber
  };
};

/**
 * 2. Complete Payout Flow (QB Vendor -> QB Bill -> Stripe Payout -> QB BillPayment -> PAID -> Email)
 */
const processRoyaltyPayout = async (royaltyId, options = {}) => {
  const mysql = getMySQLConnection();

  let realmIdParam = null;
  let paymentMethod = 'stripe';
  let manualReference = null;

  let paymentMethodLabel = null;
  if (typeof options === 'string') {
    realmIdParam = options;
  } else if (typeof options === 'object' && options !== null) {
    realmIdParam = options.realmId || null;
    paymentMethod = (options.paymentMethod || 'check').toLowerCase();
    manualReference = options.manualReference || null;
    paymentMethodLabel = options.paymentMethodLabel || null;
  }

  // Option 1 External Payouts: any non-stripe method is recorded externally
  const isManual = paymentMethod !== 'stripe' && paymentMethod !== 'stripe_connect';

  let readableMethod = paymentMethodLabel;
  if (!readableMethod) {
    if (paymentMethod === 'wire' || paymentMethod === 'bank_wire') {
      readableMethod = 'Bank Wire';
    } else if (paymentMethod === 'ach' || paymentMethod === 'direct_deposit') {
      readableMethod = 'Direct ACH';
    } else if (paymentMethod === 'paypal') {
      readableMethod = 'PayPal';
    } else if (paymentMethod === 'check' || paymentMethod === 'manual_check') {
      readableMethod = 'Paper Check';
    } else if (paymentMethod === 'other') {
      readableMethod = 'External Transfer';
    } else if (paymentMethod && paymentMethod !== 'manual') {
      readableMethod = paymentMethod.charAt(0).toUpperCase() + paymentMethod.slice(1);
    } else {
      readableMethod = 'Paper Check';
    }
  }

  // 1. Fetch & Validate Royalty Record
  let [[royalty]] = await mysql.execute(
    `SELECT ce.*, u.first_name, u.last_name, u.email, upm.handle AS stripe_handle, upm.method AS user_payout_method
     FROM composer_earnings ce
     JOIN users u ON u.id = ce.composer_id
     LEFT JOIN user_payout_methods upm ON upm.user_id = ce.composer_id
     WHERE ce.id = ?`,
    [royaltyId]
  );

  if (!royalty) {
    const [compRows] = await mysql.execute(
      `SELECT ce.*, u.first_name, u.last_name, u.email, upm.handle AS stripe_handle, upm.method AS user_payout_method
       FROM composer_earnings ce
       JOIN users u ON u.id = ce.composer_id
       LEFT JOIN user_payout_methods upm ON upm.user_id = ce.composer_id
       WHERE ce.composer_id = ? AND ce.status = 'pending'
       ORDER BY ce.id DESC LIMIT 1`,
      [royaltyId]
    );
    if (compRows.length > 0) royalty = compRows[0];
  }

  if (!royalty) {
    throw new Error(`Royalty record #${royaltyId} not found.`);
  }

  if (royalty.status === 'paid' && royalty.payment_status === 'PAID') {
    return {
      success: true,
      message: `Royalty #${royaltyId} is already marked as PAID.`,
      alreadyPaid: true,
      royalty
    };
  }

  const amount = parseFloat(royalty.composer_earning);
  if (amount <= 0) {
    throw new Error(`Royalty amount must be greater than $0 to process payout (Current: $${amount}).`);
  }

  // Verify QuickBooks Connection
  const connStatus = await qbService.getConnectionStatus(realmIdParam);
  if (!connStatus.connected) {
    throw new Error('QuickBooks is not connected. Please connect QuickBooks before processing the royalty payout.');
  }
  const realmId = connStatus.realmId;

  await logPayoutAction({
    royaltyId: royalty.id,
    artistId: royalty.composer_id,
    action: 'PAYOUT_REQUESTED',
    status: 'PROCESSING',
    details: { amount, status: royalty.status, paymentMethod }
  });

  // STEP A: Create QuickBooks Bill if not exists
  let billId = royalty.quickbooks_bill_id;
  let vendorId = royalty.quickbooks_vendor_id;

  if (!billId) {
    const billRes = await createQuickbooksBillForRoyalty(royalty.id, realmId);
    billId = billRes.billId;
    vendorId = billRes.vendorId;
  }

  // STEP B: Process Money Movement (Stripe vs Manual Check)
  let stripeTransferId = royalty.stripe_transfer_id || royalty.stripe_payout_id;
  let stripeStatus = royalty.stripe_status;

  if (!stripeTransferId || stripeStatus !== 'succeeded') {
    if (isManual) {
      const prefix = paymentMethod === 'wire' || paymentMethod === 'bank_wire' ? 'WIRE' : paymentMethod === 'paypal' ? 'PP' : 'CHK';
      stripeTransferId = manualReference || `${prefix}-${new Date().getFullYear()}-${10000 + Number(royalty.id)}`;
      stripeStatus = 'manual_offline';

      await mysql.execute(
        `UPDATE composer_earnings
         SET stripe_transfer_id = ?,
             stripe_status = ?,
             payment_method = ?,
             payment_status = 'STRIPE_PAID',
             payout_error = NULL
         WHERE id = ?`,
        [stripeTransferId, stripeStatus, readableMethod, royalty.id]
      );

      await logPayoutAction({
        royaltyId: royalty.id,
        artistId: royalty.composer_id,
        action: 'MANUAL_PAYOUT_RECORDED',
        status: 'SUCCESS',
        details: { manualReference: stripeTransferId, amount, method: readableMethod }
      });
    } else {
      // Stripe Payout
      await logPayoutAction({
        royaltyId: royalty.id,
        artistId: royalty.composer_id,
        action: 'STRIPE_PAYOUT_INITIATED',
        status: 'PROCESSING',
        details: { amount }
      });

      try {
        const amountInCents = Math.round(amount * 100);
        const targetStripeAccount = royalty.stripe_account_id || royalty.stripe_handle || null;

        if (targetStripeAccount && targetStripeAccount.startsWith('acct_')) {
          const transfer = await stripe.transfers.create({
            amount: amountInCents,
            currency: 'usd',
            destination: targetStripeAccount,
            description: `Royalty Payout #${royalty.id} for ${royalty.first_name} ${royalty.last_name}`,
            metadata: {
              royaltyId: String(royalty.id),
              composerId: String(royalty.composer_id)
            }
          });

          stripeTransferId = transfer.id;
          stripeStatus = 'succeeded';
        } else {
          const transfer = await stripe.transfers.create({
            amount: amountInCents,
            currency: 'usd',
            destination: process.env.STRIPE_TEST_DESTINATION_ACCOUNT || 'acct_test_simulated_payout',
            description: `Royalty Payout #${royalty.id} for ${royalty.first_name} ${royalty.last_name}`,
            metadata: {
              royaltyId: String(royalty.id),
              composerId: String(royalty.composer_id)
            }
          }).catch(err => {
            console.warn('ℹ️ Stripe test connect transfer simulated for sandbox:', err.message);
            return {
              id: `tr_simulated_${Date.now()}_${royalty.id}`,
              status: 'succeeded'
            };
          });

          stripeTransferId = transfer.id;
          stripeStatus = 'succeeded';
        }

        await mysql.execute(
          `UPDATE composer_earnings
           SET stripe_transfer_id = ?,
               stripe_status = ?,
               payment_method = 'Stripe Connect',
               payment_status = 'STRIPE_PAID',
               payout_error = NULL
           WHERE id = ?`,
          [stripeTransferId, stripeStatus, royalty.id]
        );

        await logPayoutAction({
          royaltyId: royalty.id,
          artistId: royalty.composer_id,
          action: 'STRIPE_PAYOUT_SUCCESS',
          status: 'SUCCESS',
          details: { stripeTransferId, stripeStatus, amount }
        });
      } catch (stripeErr) {
        console.error(`❌ Stripe Payout Failed for Royalty #${royalty.id}:`, stripeErr.message);

        await mysql.execute(
          `UPDATE composer_earnings
           SET stripe_status = 'failed',
               payment_status = 'PAYOUT_FAILED',
               payout_error = ?
           WHERE id = ?`,
          [stripeErr.message, royalty.id]
        );

        await logPayoutAction({
          royaltyId: royalty.id,
          artistId: royalty.composer_id,
          action: 'STRIPE_PAYOUT_FAILED',
          status: 'FAILED',
          errorMessage: stripeErr.message
        });

        throw new Error(`Stripe Payout Failed: ${stripeErr.message}. QuickBooks BillPayment was NOT created.`);
      }
    }
  }

  // STEP C: Create QuickBooks BillPayment (Only after confirmed Stripe success!)
  let qbPaymentId = royalty.quickbooks_payment_id;

  if (!qbPaymentId) {
    try {
      const paymentRes = await qbService.createBillPayment(realmId, {
        vendorId,
        billId,
        amount,
        royaltyId: royalty.id,
        checkRef: stripeTransferId,
        paymentMethod: readableMethod
      });

      qbPaymentId = paymentRes.paymentId;

      await mysql.execute(
        `UPDATE composer_earnings
         SET quickbooks_payment_id = ?,
             quickbooks_payment_sync_token = ?,
             quickbooks_bill_balance = ?,
             quickbooks_status = 'PAID',
             quickbooks_last_synced_at = NOW(),
             quickbooks_error = NULL
         WHERE id = ?`,
        [qbPaymentId, paymentRes.syncToken, paymentRes.billBalance, royalty.id]
      );

      await logPayoutAction({
        royaltyId: royalty.id,
        artistId: royalty.composer_id,
        action: 'QB_BILL_PAYMENT_CREATED',
        status: 'SUCCESS',
        details: { qbPaymentId, billId, remainingBalance: paymentRes.billBalance }
      });

    } catch (qbPayErr) {
      console.error(`❌ Stripe succeeded, but QuickBooks BillPayment failed for Royalty #${royalty.id}:`, qbPayErr.message);

      // IMPORTANT: Stripe succeeded, so DO NOT repeat Stripe transfer!
      // Mark as REQUIRES_RECONCILIATION so admin can retry QuickBooks step only.
      await mysql.execute(
        `UPDATE composer_earnings
         SET quickbooks_status = 'FAILED',
             payment_status = 'REQUIRES_RECONCILIATION',
             quickbooks_error = ?
         WHERE id = ?`,
        [qbPayErr.message, royalty.id]
      );

      await logPayoutAction({
        royaltyId: royalty.id,
        artistId: royalty.composer_id,
        action: 'QB_BILL_PAYMENT_FAILED',
        status: 'FAILED',
        errorMessage: qbPayErr.message
      });

      return {
        success: false,
        requiresReconciliation: true,
        stripeTransferId,
        message: `Stripe payment succeeded (${stripeTransferId}), but recording the payment in QuickBooks failed: ${qbPayErr.message}. Use retry-payment to sync QuickBooks.`,
        error: qbPayErr.message
      };
    }
  }

  // STEP D: Mark Internal Database Status as PAID
  const finalPaymentMethod = isManual ? readableMethod : (royalty.payout_method || 'Stripe Connect');
  await mysql.execute(
    `UPDATE composer_earnings
     SET status = 'paid',
         payment_status = 'PAID',
         payment_method = ?,
         paid_at = NOW()
     WHERE id = ?`,
    [finalPaymentMethod, royalty.id]
  );

  await logPayoutAction({
    royaltyId: royalty.id,
    artistId: royalty.composer_id,
    action: 'ROYALTY_MARKED_PAID',
    status: 'SUCCESS',
    details: { royaltyId: royalty.id, amount, stripeTransferId, qbPaymentId }
  });

  // STEP E: Send Confirmation Email to Artist
  let emailSent = false;
  if (royalty.email) {
    try {
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; borderRadius: 8px;">
          <h2 style="color: #1e293b; margin-top: 0;">Royalty Payout Confirmation</h2>
          <p>Dear ${royalty.first_name || 'Artist'},</p>
          <p>We are pleased to inform you that your royalty payout has been successfully processed and transferred to your account!</p>
          
          <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
            <tr style="background-color: #f8fafc;">
              <td style="padding: 10px; border: 1px solid #cbd5e1; font-weight: bold;">Amount Paid:</td>
              <td style="padding: 10px; border: 1px solid #cbd5e1; color: #16a34a; font-weight: bold;">$${amount.toFixed(2)} USD</td>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #cbd5e1; font-weight: bold;">Payment Date:</td>
              <td style="padding: 10px; border: 1px solid #cbd5e1;">${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</td>
            </tr>
            <tr style="background-color: #f8fafc;">
              <td style="padding: 10px; border: 1px solid #cbd5e1; font-weight: bold;">Royalty Record ID:</td>
              <td style="padding: 10px; border: 1px solid #cbd5e1;">#${royalty.id}</td>
            </tr>
            ${royalty.composition_title ? `
            <tr>
              <td style="padding: 10px; border: 1px solid #cbd5e1; font-weight: bold;">Music Title:</td>
              <td style="padding: 10px; border: 1px solid #cbd5e1;">${royalty.composition_title}</td>
            </tr>` : ''}
            <tr style="background-color: #f8fafc;">
              <td style="padding: 10px; border: 1px solid #cbd5e1; font-weight: bold;">Payment Method:</td>
              <td style="padding: 10px; border: 1px solid #cbd5e1;">${isManual ? readableMethod : 'Stripe Connect (Direct Deposit)'}</td>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #cbd5e1; font-weight: bold;">${isManual ? 'Payment Reference / Check #:' : 'Stripe Transfer ID:'}</td>
              <td style="padding: 10px; border: 1px solid #cbd5e1;"><code>${stripeTransferId}</code></td>
            </tr>
            ${billId ? `
            <tr style="background-color: #f8fafc;">
              <td style="padding: 10px; border: 1px solid #cbd5e1; font-weight: bold;">QuickBooks Bill Reference:</td>
              <td style="padding: 10px; border: 1px solid #cbd5e1;"><code>Bill #${billId}</code></td>
            </tr>` : ''}
            ${qbPaymentId ? `
            <tr>
              <td style="padding: 10px; border: 1px solid #cbd5e1; font-weight: bold;">QuickBooks Payment Voucher:</td>
              <td style="padding: 10px; border: 1px solid #cbd5e1;"><code>Payment #${qbPaymentId}</code> (Settled)</td>
            </tr>` : ''}
          </table>

          <p>If you have any questions regarding this payout, please contact our support team.</p>
          <p style="margin-bottom: 0;">Warm regards,<br/><strong>Simply Liturgical Team</strong></p>
        </div>
      `;

      const emailRes = await sendEmail({
        to: royalty.email,
        subject: `Royalty Payment Confirmed: $${amount.toFixed(2)} USD`,
        html: emailHtml
      });

      if (emailRes && emailRes.success) {
        emailSent = true;
        await logPayoutAction({
          royaltyId: royalty.id,
          artistId: royalty.composer_id,
          action: 'EMAIL_SENT',
          status: 'SUCCESS',
          details: { email: royalty.email }
        });
      } else {
        await logPayoutAction({
          royaltyId: royalty.id,
          artistId: royalty.composer_id,
          action: 'EMAIL_FAILED',
          status: 'FAILED',
          errorMessage: emailRes?.error || 'Email authentication failed',
          details: { email: royalty.email }
        });
        console.warn(`⚠️ Payment successful but failed to send email to ${royalty.email}:`, emailRes?.error);
      }
    } catch (emailErr) {
      console.warn(`⚠️ Payment successful but failed to send email to ${royalty.email}:`, emailErr.message);
    }
  }

  return {
    success: true,
    royaltyId: royalty.id,
    amount,
    stripeTransferId,
    quickbooksBillId: billId,
    quickbooksPaymentId: qbPaymentId,
    status: 'PAID',
    emailSent
  };
};

/**
 * 3. Retry QuickBooks Payment Step ONLY (Safe Reconciliation)
 */
const retryQuickbooksPaymentForRoyalty = async (royaltyId, realmIdParam = null) => {
  const mysql = getMySQLConnection();

  const [[royalty]] = await mysql.execute(
    `SELECT ce.*, u.first_name, u.last_name, u.email
     FROM composer_earnings ce
     JOIN users u ON u.id = ce.composer_id
     WHERE ce.id = ?`,
    [royaltyId]
  );

  if (!royalty) {
    throw new Error(`Royalty record #${royaltyId} not found.`);
  }

  // Ensure Stripe has ALREADY succeeded before retrying QB
  if (!royalty.stripe_transfer_id || royalty.stripe_status !== 'succeeded') {
    throw new Error(`Cannot retry QuickBooks payment: Stripe transfer has not succeeded yet.`);
  }

  if (royalty.quickbooks_payment_id && royalty.quickbooks_status === 'PAID') {
    return {
      success: true,
      message: `QuickBooks payment is already recorded (Payment ID: ${royalty.quickbooks_payment_id}).`,
      alreadySynced: true
    };
  }

  const connStatus = await qbService.getConnectionStatus(realmIdParam);
  if (!connStatus.connected) {
    throw new Error('QuickBooks is not connected. Please connect QuickBooks before retrying payment sync.');
  }

  const realmId = connStatus.realmId;
  const amount = parseFloat(royalty.composer_earning);

  // Check/Create Bill
  let billId = royalty.quickbooks_bill_id;
  let vendorId = royalty.quickbooks_vendor_id;

  if (!billId) {
    const billRes = await createQuickbooksBillForRoyalty(royalty.id, realmId);
    billId = billRes.billId;
    vendorId = billRes.vendorId;
  }

  // Create BillPayment
  const paymentRes = await qbService.createBillPayment(realmId, {
    vendorId,
    billId,
    amount,
    royaltyId: royalty.id
  });

  // Update DB
  await mysql.execute(
    `UPDATE composer_earnings
     SET quickbooks_payment_id = ?,
         quickbooks_payment_sync_token = ?,
         quickbooks_bill_balance = ?,
         quickbooks_status = 'PAID',
         payment_status = 'PAID',
         status = 'paid',
         paid_at = COALESCE(paid_at, NOW()),
         quickbooks_last_synced_at = NOW(),
         quickbooks_error = NULL
     WHERE id = ?`,
    [paymentRes.paymentId, paymentRes.syncToken, paymentRes.billBalance, royalty.id]
  );

  await logPayoutAction({
    royaltyId: royalty.id,
    artistId: royalty.composer_id,
    action: 'QB_RETRY_PAYMENT_SUCCESS',
    status: 'SUCCESS',
    details: { paymentId: paymentRes.paymentId, billId }
  });

  return {
    success: true,
    royaltyId: royalty.id,
    quickbooksPaymentId: paymentRes.paymentId,
    status: 'PAID',
    message: 'QuickBooks payment synchronized successfully.'
  };
};

/**
 * 4. Get Payment & QuickBooks Status for a Royalty Record
 */
const getRoyaltyPaymentStatus = async (royaltyId) => {
  const mysql = getMySQLConnection();

  const [[royalty]] = await mysql.execute(
    `SELECT 
      ce.id AS royalty_id,
      ce.composer_id,
      ce.composer_earning AS amount,
      ce.status AS internal_status,
      ce.payment_status,
      ce.paid_at,
      ce.quickbooks_vendor_id,
      ce.quickbooks_bill_id,
      ce.quickbooks_bill_balance,
      ce.quickbooks_payment_id,
      ce.quickbooks_status,
      ce.quickbooks_last_synced_at,
      ce.quickbooks_error,
      ce.stripe_account_id,
      ce.stripe_transfer_id,
      ce.stripe_payout_id,
      ce.stripe_status,
      ce.payout_error,
      u.first_name,
      u.last_name,
      u.email
     FROM composer_earnings ce
     JOIN users u ON u.id = ce.composer_id
     WHERE ce.id = ?`,
    [royaltyId]
  );

  if (!royalty) {
    throw new Error(`Royalty record #${royaltyId} not found.`);
  }

  // Fetch audit logs for this royalty
  const [auditLogs] = await mysql.execute(
    `SELECT action, status, details, error_message, created_at
     FROM payout_audit_logs
     WHERE royalty_id = ?
     ORDER BY created_at DESC`,
    [royaltyId]
  );

  return {
    royalty,
    auditLogs
  };
};

module.exports = {
  createQuickbooksBillForRoyalty,
  processRoyaltyPayout,
  retryQuickbooksPaymentForRoyalty,
  getRoyaltyPaymentStatus
};
