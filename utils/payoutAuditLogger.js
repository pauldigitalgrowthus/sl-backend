const { getMySQLConnection } = require('../config/mysql');

/**
 * Log a financial/payout step to the payout_audit_logs table.
 *
 * @param {object} params
 * @param {number} params.royaltyId
 * @param {number} params.artistId
 * @param {string} params.action - E.g. 'QB_BILL_CREATED', 'STRIPE_PAYOUT_INITIATED', 'PAID'
 * @param {string} params.status - E.g. 'SUCCESS', 'FAILED', 'PROCESSING'
 * @param {object} [params.details] - Arbitrary JSON payload with metadata (never contains secrets)
 * @param {string} [params.errorMessage] - Error string if failed
 */
const logPayoutAction = async ({ royaltyId, artistId, action, status, details = null, errorMessage = null }) => {
  try {
    const mysql = getMySQLConnection();
    const cleanDetails = details ? JSON.stringify(details) : null;

    await mysql.execute(
      `INSERT INTO payout_audit_logs (royalty_id, artist_id, action, status, details, error_message)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [royaltyId || 0, artistId || 0, action, status, cleanDetails, errorMessage || null]
    );
  } catch (err) {
    console.error('⚠️ Failed to write payout audit log:', err.message);
  }
};

module.exports = {
  logPayoutAction
};
