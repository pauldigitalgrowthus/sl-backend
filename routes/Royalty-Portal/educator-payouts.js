const express = require('express');
const { auth } = require('../../middleware/auth');
const { getMySQLConnection } = require('../../config/mysql');
const { successResponse, errorResponse } = require('../../utils/response');

const router = express.Router();

// @route   GET /api/royalty/educator-payouts/my
// @desc    Logged-in educator's earnings summary & details
router.get('/my', auth, async (req, res) => {
  try {
    const mysql = getMySQLConnection();
    const educatorId = req.user.id;
    const { status, pay_period, from, to } = req.query;

    let whereClause = "WHERE educator_id = ? AND status != 'cancelled'";
    const params = [educatorId];

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
        COALESCE(SUM(educator_earning), 0) AS totalEarning,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN educator_earning ELSE 0 END), 0) AS paidEarnings,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN educator_earning ELSE 0 END), 0) AS pendingEarnings,
        COALESCE(SUM(total_deductions), 0) AS totalDeductions,
        COUNT(*) AS totalSales
       FROM educator_earnings ${whereClause}`,
      params
    );

    const [byCourse] = await mysql.execute(
      `SELECT course_id, course_title, COUNT(*) AS totalPurchases, COALESCE(SUM(educator_earning), 0) AS totalEarning
       FROM educator_earnings ${whereClause}
       GROUP BY course_id, course_title ORDER BY totalEarning DESC`,
      params
    );

    const [earnings] = await mysql.execute(
      `SELECT * FROM educator_earnings ${whereClause} ORDER BY created_at DESC`,
      params
    );

    successResponse(res, {
      totalEarning: total.totalEarning ? Number(total.totalEarning) : 0,
      paidEarnings: total.paidEarnings ? Number(total.paidEarnings) : 0,
      pendingEarnings: total.pendingEarnings ? Number(total.pendingEarnings) : 0,
      totalDeductions: total.totalDeductions ? Number(total.totalDeductions) : 0,
      totalSales: total.totalSales ? Number(total.totalSales) : 0,
      byCourse,
      earnings
    }, 'Educator earnings fetched successfully');
  } catch (error) {
    console.error('Get educator earnings error:', error);
    errorResponse(res, 'Failed to fetch educator earnings', 500);
  }
});

// @route   GET /api/royalty/educator-payouts/:earningId/deductions
router.get('/:earningId(\\d+)/deductions', auth, async (req, res) => {
  try {
    const mysql = getMySQLConnection();
    const { earningId } = req.params;

    const [[earning]] = await mysql.execute(
      `SELECT 
        ee.*,
        u.first_name,
        u.last_name,
        u.email,
        upm.method AS payout_method,
        upm.handle AS payout_handle,
        buyer.first_name AS buyer_first_name,
        buyer.last_name AS buyer_last_name,
        buyer.email AS buyer_email
       FROM educator_earnings ee
       LEFT JOIN users u ON u.id = ee.educator_id
       LEFT JOIN user_payout_methods upm ON upm.user_id = ee.educator_id
       LEFT JOIN users buyer ON buyer.id = ee.buyer_user_id
       WHERE ee.id = ?`,
      [earningId]
    );
    if (!earning) return errorResponse(res, 'Earning record not found', 404);

    if (earning.educator_id !== req.user.id && !['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Access denied', 403);
    }

    let [deductions] = await mysql.execute(
      `SELECT eed.*, rde.name AS entity_name
       FROM educator_earning_deductions eed
       LEFT JOIN royalty_deduction_entities rde ON rde.id = eed.deduction_entity_id
       WHERE eed.educator_earning_id = ?`,
      [earningId]
    );

    // Fallback 1: If educator_earning_deductions is empty, check product_royalty_config
    if ((!deductions || deductions.length === 0) && earning.course_id) {
      const [configs] = await mysql.execute(
        `SELECT prc.*, rde.name AS entity_name
         FROM product_royalty_config prc
         JOIN royalty_deduction_entities rde ON rde.id = prc.deduction_entity_id
         WHERE prc.product_type = 'course' 
           AND prc.product_id = ? 
           AND prc.applies = 1 
           AND rde.is_active = 1`,
        [earning.course_id]
      );

      if (configs && configs.length > 0) {
        const salePrice = Number(earning.sale_price || 0);
        deductions = [];
        for (const c of configs) {
          const pct = Number(c.percent || 0);
          const amt = Number((salePrice * (pct / 100)).toFixed(2));
          deductions.push({
            educator_earning_id: Number(earningId),
            deduction_entity_id: c.deduction_entity_id,
            entity_name: c.entity_name,
            percent: pct,
            amount: amt,
            status: earning.status === 'paid' ? 'paid' : 'pending'
          });

          try {
            await mysql.execute(
              `INSERT INTO educator_earning_deductions (educator_earning_id, deduction_entity_id, percent, amount, status)
               VALUES (?, ?, ?, ?, ?)`,
              [earningId, c.deduction_entity_id, pct, amt, earning.status === 'paid' ? 'paid' : 'pending']
            );
          } catch (insErr) {
            console.warn('Could not auto-insert edu deduction row:', insErr.message);
          }
        }
      }
    }

    successResponse(res, { earning, deductions: deductions || [] }, 'Deduction breakdown fetched');
  } catch (error) {
    console.error('Get educator earning deductions error:', error);
    errorResponse(res, 'Failed to fetch deduction breakdown', 500);
  }
});

// @route   PUT /api/royalty/educator-payouts/mark-paid
// @body    { earning_ids: [1,2,3] }  OR  { educator_id, pay_period }
router.put('/mark-paid', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const { earning_ids, educator_id, pay_period } = req.body;
    const mysql = getMySQLConnection();

    let result;

    if (Array.isArray(earning_ids) && earning_ids.length > 0) {
      const placeholders = earning_ids.map(() => '?').join(',');
      [result] = await mysql.execute(
        `UPDATE educator_earnings SET status = 'paid', paid_at = NOW()
         WHERE id IN (${placeholders}) AND status = 'pending'`,
        earning_ids
      );
    } else if (educator_id && pay_period) {
      [result] = await mysql.execute(
        `UPDATE educator_earnings SET status = 'paid', paid_at = NOW()
         WHERE educator_id = ? AND pay_period = ? AND status = 'pending'`,
        [educator_id, pay_period]
      );
    } else {
      return errorResponse(res, 'Provide either earning_ids[] or { educator_id, pay_period }', 400);
    }

    successResponse(res, { updated: result.affectedRows }, 'Educator earnings marked as paid');
  } catch (error) {
    console.error('Mark educator paid error:', error);
    errorResponse(res, 'Failed to mark earnings as paid', 500);
  }
});

// @route   GET /api/royalty/educator-payouts/pending-by-educator
router.get('/pending-by-educator', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const mysql = getMySQLConnection();
    const { pay_period } = req.query;

    let where = "WHERE ee.status = 'pending'";
    const params = [];
    if (pay_period) { where += ' AND ee.pay_period = ?'; params.push(pay_period); }

    const [rows] = await mysql.execute(
      `SELECT
        ee.educator_id, u.first_name, u.last_name, u.email,
        upm.method AS payout_method, upm.handle AS payout_handle,
        COUNT(*) AS transactionCount,
        SUM(ee.educator_earning) AS totalDue
       FROM educator_earnings ee
       JOIN users u ON u.id = ee.educator_id
       LEFT JOIN user_payout_methods upm ON upm.user_id = ee.educator_id
       ${where}
       GROUP BY ee.educator_id
       ORDER BY totalDue DESC`,
      params
    );

    successResponse(res, { educators: rows, total: rows.length }, 'Pending payouts by educator fetched');
  } catch (error) {
    console.error('Pending by educator error:', error);
    errorResponse(res, 'Failed to fetch pending payouts', 500);
  }
});

// @route   GET /api/royalty/educator-payouts/admin/all
router.get('/admin/all', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const mysql = getMySQLConnection();
    const { status, pay_period, educator_id } = req.query;

    let where = 'WHERE 1=1';
    const params = [];
    if (status) { where += ' AND ee.status = ?'; params.push(status); }
    if (pay_period) { where += ' AND ee.pay_period = ?'; params.push(pay_period); }
    if (educator_id) { where += ' AND ee.educator_id = ?'; params.push(educator_id); }


    const [rows] = await mysql.execute(
      `SELECT 
        ee.*,
        TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))) AS educator_name
       FROM educator_earnings ee
       LEFT JOIN users u ON u.id = ee.educator_id
       ${where} 
       ORDER BY ee.created_at DESC`,
      params
    );

    successResponse(res, { earnings: rows, total: rows.length }, 'Educator earnings fetched');
  } catch (error) {
    console.error('Get all educator earnings error:', error);
    errorResponse(res, 'Failed to fetch educator earnings', 500);
  }
});

module.exports = router;