const express = require('express');
const { auth } = require('../../middleware/auth');
const { getMySQLConnection } = require('../../config/mysql');
const { successResponse, errorResponse } = require('../../utils/response');

const router = express.Router();

// @route   GET /api/royalty/documents/my
// @desc    Logged-in document owner's earnings summary & details
router.get('/my', auth, async (req, res) => {
  try {
    const mysql = getMySQLConnection();
    const ownerId = req.user.id;
    const { status, pay_period, from, to } = req.query;

    let whereClause = "WHERE owner_id = ? AND status != 'cancelled'";
    const params = [ownerId];

    if (status && status !== 'all') {
      whereClause += ' AND status = ?';
      params.push(status);
    }

    if (pay_period) {
      whereClause += ' AND pay_period = ?';
      params.push(pay_period);
    }

    if (from && to) {
      if (status === 'paid') {
        whereClause += ' AND DATE(COALESCE(paid_at, created_at)) BETWEEN ? AND ?';
      } else {
        whereClause += ' AND DATE(created_at) BETWEEN ? AND ?';
      }
      params.push(from, to);
    }

    const [[total]] = await mysql.execute(
      `SELECT 
        COALESCE(SUM(owner_earning), 0) AS totalEarning,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN owner_earning ELSE 0 END), 0) AS paidEarnings,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN owner_earning ELSE 0 END), 0) AS pendingEarnings,
        COALESCE(SUM(total_deductions), 0) AS totalDeductions,
        COUNT(*) AS totalTransactions
       FROM document_royalty_earnings ${whereClause}`,
      params
    );

    const [byDocument] = await mysql.execute(
      `SELECT document_id, document_title, COUNT(*) AS payoutCount, COALESCE(SUM(owner_earning), 0) AS totalEarning
       FROM document_royalty_earnings ${whereClause}
       GROUP BY document_id, document_title ORDER BY totalEarning DESC`,
      params
    );

    const [earnings] = await mysql.execute(
      `SELECT * FROM document_royalty_earnings ${whereClause} ORDER BY created_at DESC`,
      params
    );

    successResponse(res, {
      totalEarning: total.totalEarning ? Number(total.totalEarning) : 0,
      paidEarnings: total.paidEarnings ? Number(total.paidEarnings) : 0,
      pendingEarnings: total.pendingEarnings ? Number(total.pendingEarnings) : 0,
      totalDeductions: total.totalDeductions ? Number(total.totalDeductions) : 0,
      totalTransactions: total.totalTransactions ? Number(total.totalTransactions) : 0,
      byDocument,
      earnings
    }, 'Document royalty earnings fetched');
  } catch (error) {
    console.error('Get document earnings error:', error);
    errorResponse(res, 'Failed to fetch document earnings', 500);
  }
});

// @route   GET /api/royalty/documents/:earningId/deductions
router.get('/:earningId(\\d+)/deductions', auth, async (req, res) => {
  try {
    const mysql = getMySQLConnection();
    const { earningId } = req.params;

    const [[earning]] = await mysql.execute(
      `SELECT 
        dre.*,
        u.first_name,
        u.last_name,
        u.email,
        upm.method AS payout_method,
        upm.handle AS payout_handle
       FROM document_royalty_earnings dre
       LEFT JOIN users u ON u.id = dre.owner_id
       LEFT JOIN user_payout_methods upm ON upm.user_id = dre.owner_id
       WHERE dre.id = ?`,
      [earningId]
    );
    if (!earning) return errorResponse(res, 'Earning record not found', 404);

    if (earning.owner_id !== req.user.id && !['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Access denied', 403);
    }

    let [deductions] = await mysql.execute(
      `SELECT drd.*, rde.name AS entity_name
       FROM document_royalty_deductions drd
       LEFT JOIN royalty_deduction_entities rde ON rde.id = drd.deduction_entity_id
       WHERE drd.document_royalty_earning_id = ?`,
      [earningId]
    );

    // Fallback 1: If document_royalty_deductions is empty, check product_royalty_config
    if ((!deductions || deductions.length === 0) && earning.document_id) {
      const [configs] = await mysql.execute(
        `SELECT prc.*, rde.name AS entity_name
         FROM product_royalty_config prc
         JOIN royalty_deduction_entities rde ON rde.id = prc.deduction_entity_id
         WHERE prc.product_type = 'document' 
           AND prc.product_id = ? 
           AND prc.applies = 1 
           AND rde.is_active = 1`,
        [earning.document_id]
      );

      if (configs && configs.length > 0) {
        const grossAmount = Number(earning.gross_amount || 0);
        deductions = [];
        for (const c of configs) {
          const pct = Number(c.percent || 0);
          const amt = Number((grossAmount * (pct / 100)).toFixed(2));
          deductions.push({
            document_royalty_earning_id: Number(earningId),
            deduction_entity_id: c.deduction_entity_id,
            entity_name: c.entity_name,
            percent: pct,
            amount: amt,
            status: earning.status === 'paid' ? 'paid' : 'pending'
          });

          try {
            await mysql.execute(
              `INSERT INTO document_royalty_deductions (document_royalty_earning_id, deduction_entity_id, percent, amount, status)
               VALUES (?, ?, ?, ?, ?)`,
              [earningId, c.deduction_entity_id, pct, amt, earning.status === 'paid' ? 'paid' : 'pending']
            );
          } catch (insErr) {
            console.warn('Could not auto-insert doc deduction row:', insErr.message);
          }
        }
      }
    }

    successResponse(res, { earning, deductions: deductions || [] }, 'Deduction breakdown fetched');
  } catch (error) {
    console.error('Get document deductions error:', error);
    errorResponse(res, 'Failed to fetch deduction breakdown', 500);
  }
});

// @route   GET /api/royalty/documents/admin/all
// @desc    SL Team full view of document royalty transactions
router.get('/admin/all', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const mysql = getMySQLConnection();
    const { status, pay_period, owner_id } = req.query;

    let where = 'WHERE 1=1';
    const params = [];
    if (status) { where += ' AND dre.status = ?'; params.push(status); }
    if (pay_period) { where += ' AND dre.pay_period = ?'; params.push(pay_period); }
    if (owner_id) { where += ' AND dre.owner_id = ?'; params.push(owner_id); }

    const [rows] = await mysql.execute(
      `SELECT dre.*, u.first_name, u.last_name, u.email
       FROM document_royalty_earnings dre
       JOIN users u ON u.id = dre.owner_id
       ${where}
       ORDER BY dre.created_at DESC`,
      params
    );

    successResponse(res, { earnings: rows, total: rows.length }, 'Document royalty transactions fetched');
  } catch (error) {
    console.error('Get all document earnings error:', error);
    errorResponse(res, 'Failed to fetch document earnings', 500);
  }
});

// @route   PUT /api/royalty/documents/mark-paid
// @body    { earning_ids: [1,2,3] }
router.put('/mark-paid', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const { earning_ids } = req.body;
    if (!Array.isArray(earning_ids) || earning_ids.length === 0) {
      return errorResponse(res, 'earning_ids array is required', 400);
    }

    const mysql = getMySQLConnection();
    const placeholders = earning_ids.map(() => '?').join(',');

    const [result] = await mysql.execute(
      `UPDATE document_royalty_earnings SET status = 'paid', paid_at = NOW()
       WHERE id IN (${placeholders}) AND status = 'pending'`,
      earning_ids
    );

    successResponse(res, { updated: result.affectedRows }, 'Document royalty earnings marked as paid');
  } catch (error) {
    console.error('Mark document paid error:', error);
    errorResponse(res, 'Failed to mark earnings as paid', 500);
  }
});

module.exports = router;