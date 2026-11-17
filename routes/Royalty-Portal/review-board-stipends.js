const express = require('express');
const { auth } = require('../../middleware/auth');
const { getMySQLConnection } = require('../../config/mysql');
const { successResponse, errorResponse } = require('../../utils/response');

const router = express.Router();

const PAYMENT_METHODS = ['venmo', 'paypal', 'cashapp', 'check', 'other'];

/* ============================================================
   STIPEND RATES (admin-configurable, SOW 7.2)
============================================================ */

// @route   GET /api/royalty/review-board/rates
router.get('/rates', auth, async (req, res) => {
  try {
    const mysql = getMySQLConnection();
    const [rates] = await mysql.execute(
      `SELECT * FROM review_board_stipend_rates ORDER BY type_of_music ASC`
    );
    successResponse(res, { rates, total: rates.length }, 'Stipend rates fetched');
  } catch (error) {
    console.error('Get stipend rates error:', error);
    errorResponse(res, 'Failed to fetch stipend rates', 500);
  }
});

// @route   POST /api/royalty/review-board/rates
// @body    { type_of_music, rate }
router.post('/rates', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const { type_of_music, rate } = req.body;
    if (!type_of_music || rate === undefined) {
      return errorResponse(res, 'type_of_music and rate are required', 400);
    }

    const mysql = getMySQLConnection();
    const [result] = await mysql.execute(
      `INSERT INTO review_board_stipend_rates (type_of_music, rate) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE rate = VALUES(rate), updated_at = NOW()`,
      [type_of_music.trim(), rate]
    );

    successResponse(res, { id: result.insertId }, 'Stipend rate saved', 201);
  } catch (error) {
    console.error('Create stipend rate error:', error);
    errorResponse(res, 'Failed to create stipend rate', 500);
  }
});

// @route   PUT /api/royalty/review-board/rates/:id
router.put('/rates/:id', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const { id } = req.params;
    const { rate, is_active } = req.body;
    const mysql = getMySQLConnection();

    const updates = [];
    const values = [];
    if (rate !== undefined) { updates.push('rate = ?'); values.push(rate); }
    if (is_active !== undefined) { updates.push('is_active = ?'); values.push(is_active ? 1 : 0); }

    if (updates.length === 0) return errorResponse(res, 'No fields to update', 400);

    updates.push('updated_at = NOW()');
    values.push(id);

    await mysql.execute(
      `UPDATE review_board_stipend_rates SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    successResponse(res, null, 'Stipend rate updated');
  } catch (error) {
    console.error('Update stipend rate error:', error);
    errorResponse(res, 'Failed to update stipend rate', 500);
  }
});

/* ============================================================
   STIPEND RECORDS (auto-created by royaltyEngine.logReviewBoardStipend
   on every review-board decision — these routes are for viewing +
   paying them out)
============================================================ */

// @route   GET /api/royalty/review-board/stipends/my
// @desc    Logged-in review board member's own stipends
router.get('/stipends/my', auth, async (req, res) => {
  try {
    const mysql = getMySQLConnection();
    const { status, pay_period } = req.query;

    let where = 'WHERE reviewer_id = ?';
    const params = [req.user.id];

    if (status) { where += ' AND status = ?'; params.push(status); }
    if (pay_period) { where += ' AND pay_period = ?'; params.push(pay_period); }

    const [stipends] = await mysql.execute(
      `SELECT * FROM review_board_stipends ${where} ORDER BY created_at DESC`,
      params
    );

    const total = stipends.reduce((sum, s) => sum + Number(s.rate_applied), 0);

    successResponse(res, { stipends, total, count: stipends.length }, 'Your stipends fetched');
  } catch (error) {
    console.error('Get my stipends error:', error);
    errorResponse(res, 'Failed to fetch stipends', 500);
  }
});

// @route   GET /api/royalty/review-board/stipends/admin
// @desc    All stipends (admin view, with reviewer info + filters)
router.get('/stipends/admin', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin', 'sl_team'].includes(req.user.role) &&
        !['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const mysql = getMySQLConnection();
    const { status, pay_period, reviewer_id } = req.query;

    let where = 'WHERE 1=1';
    const params = [];

    if (status) { where += ' AND rbs.status = ?'; params.push(status); }
    if (pay_period) { where += ' AND rbs.pay_period = ?'; params.push(pay_period); }
    if (reviewer_id) { where += ' AND rbs.reviewer_id = ?'; params.push(reviewer_id); }

    const [stipends] = await mysql.execute(
      `SELECT rbs.*, u.first_name, u.last_name, u.email
       FROM review_board_stipends rbs
       JOIN users u ON u.id = rbs.reviewer_id
       ${where}
       ORDER BY rbs.created_at DESC`,
      params
    );

    successResponse(res, { stipends, total: stipends.length }, 'Stipends fetched');
  } catch (error) {
    console.error('Get admin stipends error:', error);
    errorResponse(res, 'Failed to fetch stipends', 500);
  }
});

// @route   PUT /api/royalty/review-board/stipends/mark-paid
// @desc    Bulk mark stipends as paid for a pay period / reviewer
// @body    { stipend_ids: [1,2,3], payment_method, payment_reference }
router.put('/stipends/mark-paid', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const { stipend_ids, payment_method, payment_reference } = req.body;

    if (!Array.isArray(stipend_ids) || stipend_ids.length === 0) {
      return errorResponse(res, 'stipend_ids array is required', 400);
    }
    if (payment_method && !PAYMENT_METHODS.includes(payment_method)) {
      return errorResponse(res, `payment_method must be one of: ${PAYMENT_METHODS.join(', ')}`, 400);
    }

    const mysql = getMySQLConnection();
    const placeholders = stipend_ids.map(() => '?').join(',');

    const [result] = await mysql.execute(
      `UPDATE review_board_stipends
       SET status = 'paid', payment_method = ?, payment_reference = ?, paid_at = NOW()
       WHERE id IN (${placeholders}) AND status = 'pending'`,
      [payment_method || null, payment_reference || null, ...stipend_ids]
    );

    successResponse(res, { updated: result.affectedRows }, 'Stipends marked as paid');
  } catch (error) {
    console.error('Mark stipends paid error:', error);
    errorResponse(res, 'Failed to mark stipends paid', 500);
  }
});

module.exports = router;
