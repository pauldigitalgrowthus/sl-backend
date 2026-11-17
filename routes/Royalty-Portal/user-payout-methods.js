const express = require('express');
const { auth } = require('../../middleware/auth');
const { getMySQLConnection } = require('../../config/mysql');
const { successResponse, errorResponse } = require('../../utils/response');

const router = express.Router();

const PAYMENT_METHODS = ['venmo', 'paypal', 'cashapp', 'check', 'other'];

// @route   GET /api/royalty/payout-method
// @desc    Get logged-in user's payout method preference
// @access  Private
router.get('/', auth, async (req, res) => {
  try {
    const mysql = getMySQLConnection();
    const [rows] = await mysql.execute(
      `SELECT * FROM user_payout_methods WHERE user_id = ? LIMIT 1`,
      [req.user.id]
    );

    successResponse(res, { payoutMethod: rows[0] || null }, 'Payout method fetched');
  } catch (error) {
    console.error('Get payout method error:', error);
    errorResponse(res, 'Failed to fetch payout method', 500);
  }
});

// @route   PUT /api/royalty/payout-method
// @desc    Set/update payout method
// @body    { method, handle, mailing_address, notes }
// @access  Private
router.put('/', auth, async (req, res) => {
  try {
    const { method, handle, mailing_address, notes } = req.body;

    if (!method || !PAYMENT_METHODS.includes(method)) {
      return errorResponse(res, `method must be one of: ${PAYMENT_METHODS.join(', ')}`, 400);
    }
    if (['venmo', 'paypal', 'cashapp'].includes(method) && !handle) {
      return errorResponse(res, `handle is required for ${method}`, 400);
    }
    if (method === 'check' && !mailing_address) {
      return errorResponse(res, 'mailing_address is required for check payments', 400);
    }

    const mysql = getMySQLConnection();

    await mysql.execute(
      `INSERT INTO user_payout_methods (user_id, method, handle, mailing_address, notes)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         method = VALUES(method), handle = VALUES(handle),
         mailing_address = VALUES(mailing_address), notes = VALUES(notes),
         updated_at = NOW()`,
      [req.user.id, method, handle || null, mailing_address || null, notes || null]
    );

    successResponse(res, null, 'Payout method saved');
  } catch (error) {
    console.error('Update payout method error:', error);
    errorResponse(res, 'Failed to save payout method', 500);
  }
});

module.exports = router;
