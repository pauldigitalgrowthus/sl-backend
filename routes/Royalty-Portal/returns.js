const express = require('express');
const { auth } = require('../../middleware/auth');
const { getMySQLConnection } = require('../../config/mysql');
const { successResponse, errorResponse } = require('../../utils/response');
const { processRoyaltyReturn } = require('../../utils/royaltyEngine');

const router = express.Router();

// @route   POST /api/royalty/returns
// @desc    Record a return/refund and reverse the linked royalty earning
//          (excludes it from pending/paid totals, logs to royalty_returns)
// @body    { earning_type: 'composer'|'document'|'educator', earning_id, reason }
// @access  Private (Admin)
router.post('/', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const { earning_type, earning_id, reason } = req.body;
    if (!earning_type || !['composer', 'document', 'educator'].includes(earning_type)) {
      return errorResponse(res, "earning_type must be 'composer', 'document', or 'educator'", 400);
    }
    if (!earning_id) return errorResponse(res, 'earning_id is required', 400);

    const mysql = getMySQLConnection();

    const outcome = await processRoyaltyReturn({
      mysql,
      earningType: earning_type,
      earningId: earning_id,
      reason: reason || null,
      processedBy: req.user.id
    });

    if (!outcome.success) {
      return errorResponse(res, outcome.error, 400);
    }

    successResponse(res, outcome, 'Return processed and royalty reversed', 201);
  } catch (error) {
    console.error('Process return error:', error);
    errorResponse(res, 'Failed to process return', 500);
  }
});

// @route   GET /api/royalty/returns
// @desc    List all returns (SL Team - lost revenue report, SOW 8.3 "Returns")
router.get('/', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const mysql = getMySQLConnection();
    const { from, to, earning_type } = req.query;

    let where = 'WHERE 1=1';
    const params = [];
    if (from && to) { where += ' AND DATE(rr.returned_at) BETWEEN ? AND ?'; params.push(from, to); }
    if (earning_type) { where += ' AND rr.earning_type = ?'; params.push(earning_type); }

    const [returns] = await mysql.execute(
      `SELECT rr.*, u.first_name, u.last_name, u.email
       FROM royalty_returns rr
       JOIN users u ON u.id = rr.recipient_id
       ${where}
       ORDER BY rr.returned_at DESC`,
      params
    );

    const totalLostRevenue = returns.reduce((sum, r) => sum + Number(r.gross_amount_reversed), 0);

    successResponse(res, { returns, totalLostRevenue, count: returns.length }, 'Returns fetched');
  } catch (error) {
    console.error('Get returns error:', error);
    errorResponse(res, 'Failed to fetch returns', 500);
  }
});

module.exports = router;
