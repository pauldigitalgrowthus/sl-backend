const express = require('express');
const { auth } = require('../../middleware/auth');
const { getMySQLConnection } = require('../../config/mysql');
const { successResponse, errorResponse } = require('../../utils/response');
const payoutService = require('../../services/payout.service');

const router = express.Router();

// @route   GET /api/royalty/composer-payouts/my-earnings
// @desc    Get logged-in composer's total earnings, status-wise breakdown, and per-song earnings
// @access  Private (Composer)
router.get('/my-earnings', auth, async (req, res) => {
  try {
    const mysql = getMySQLConnection();
    const composerId = req.user.id;
    const { pay_period, from, to } = req.query;

    let whereClause = 'WHERE ce.composer_id = ?';
    const params = [composerId];

    if (pay_period) {
      whereClause += ' AND ce.pay_period = ?';
      params.push(pay_period);
    }

    if (from && to) {
      whereClause += ' AND DATE(ce.created_at) BETWEEN ? AND ?';
      params.push(from, to);
    }

    // 1. Fetch total and status breakdown (paid vs pending)
    const [[summary]] = await mysql.execute(
      `SELECT 
        COALESCE(SUM(ce.composer_earning), 0) AS totalEarnings,
        COALESCE(SUM(CASE WHEN ce.status = 'paid' THEN ce.composer_earning ELSE 0 END), 0) AS paidEarnings,
        COALESCE(SUM(CASE WHEN ce.status = 'pending' THEN ce.composer_earning ELSE 0 END), 0) AS pendingEarnings,
        COALESCE(SUM(ce.total_deductions), 0) AS totalDeductions,
        COUNT(*) AS totalTransactions
       FROM composer_earnings ce
       ${whereClause}`,
      params
    );

    // 2. Fetch earnings list with song details
    const [earningsList] = await mysql.execute(
      `SELECT 
        ce.id AS earning_id,
        ce.music_publication_id,
        ce.sale_price,
        ce.total_deductions,
        ce.composer_earning,
        ce.source_type,
        ce.pay_period,
        ce.status,
        ce.paid_at,
        ce.created_at,
        mp.composition_title,
        mp.artwork_file_url
       FROM composer_earnings ce
       LEFT JOIN music_publications mp ON mp.id = ce.music_publication_id
       ${whereClause}
       ORDER BY ce.created_at DESC`,
      params
    );

    return successResponse(res, {
      summary: {
        totalEarnings: parseFloat(summary.totalEarnings),
        paidEarnings: parseFloat(summary.paidEarnings),
        pendingEarnings: parseFloat(summary.pendingEarnings),
        totalDeductions: parseFloat(summary.totalDeductions),
        totalTransactions: summary.totalTransactions
      },
      earnings: earningsList
    }, 'Composer earnings fetched successfully');

  } catch (error) {
    console.error('Get my composer earnings error:', error);
    return errorResponse(res, 'Failed to fetch composer earnings', 500);
  }
});

// @route   GET /api/royalty/composer-payouts/composer/:composerId
// @desc    Admin view for specific composer's earnings
// @access  Private (Admin / Superadmin)
router.get("/composer/:composerId(\\d+)", auth, async (req, res) => {
  try {
    if (!["admin", "superadmin"].includes(req.user.user_type)) {
      return errorResponse(res, "Admin access required", 403);
    }

    const mysql = getMySQLConnection();

    const { composerId } = req.params;
    const { pay_period } = req.query;

    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    let whereClause = "WHERE ce.composer_id = ?";
    const params = [composerId];

    if (pay_period) {
      whereClause += " AND ce.pay_period = ?";
      params.push(pay_period);
    }

    // Summary (No Pagination)
    const [[summary]] = await mysql.execute(
      `
      SELECT
        COALESCE(SUM(ce.composer_earning), 0) AS totalEarnings,
        COALESCE(SUM(CASE WHEN ce.status = 'paid' THEN ce.composer_earning ELSE 0 END), 0) AS paidEarnings,
        COALESCE(SUM(CASE WHEN ce.status = 'pending' THEN ce.composer_earning ELSE 0 END), 0) AS pendingEarnings,
        COALESCE(SUM(ce.total_deductions), 0) AS totalDeductions,
        COUNT(*) AS totalTransactions
      FROM composer_earnings ce
      ${whereClause}
      `,
      params
    );

    // Total records for pagination
    const [[countResult]] = await mysql.execute(
      `
      SELECT COUNT(*) AS total
      FROM composer_earnings ce
      ${whereClause}
      `,
      params
    );

    const total = countResult.total;
    const totalPages = Math.ceil(total / limit);

    // Earnings List (Paginated)
    const [earningsList] = await mysql.execute(
      `
      SELECT
        ce.*,
        mp.composition_title
      FROM composer_earnings ce
      LEFT JOIN music_publications mp
        ON mp.id = ce.music_publication_id
      ${whereClause}
      ORDER BY ce.created_at DESC
      LIMIT ?
      OFFSET ?
      `,
      [...params, limit, offset]
    );

    return successResponse(
      res,
      {
        composerId: Number(composerId),

        summary: {
          totalEarnings: Number(summary.totalEarnings),
          paidEarnings: Number(summary.paidEarnings),
          pendingEarnings: Number(summary.pendingEarnings),
          totalDeductions: Number(summary.totalDeductions),
          totalTransactions: summary.totalTransactions,
        },

        earnings: earningsList,

        pagination: {
          total,
          page,
          limit,
          totalPages,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1,
        },
      },
      "Composer earnings details fetched"
    );
  } catch (error) {
    console.error("Get composer earnings error:", error);
    return errorResponse(
      res,
      "Failed to fetch composer earnings details",
      500
    );
  }
});

// @route   GET /api/royalty/composer-payouts/:earningId/deductions
// @desc    Deduction breakdown for a single composer_earnings row (SOW 8.1 dropdown)
router.get('/:earningId(\\d+)/deductions', auth, async (req, res) => {
  try {
    const mysql = getMySQLConnection();
    const { earningId } = req.params;

    const [[earning]] = await mysql.execute(
      `SELECT 
        ce.*,
        mp.artwork_file_url,
        u.first_name,
        u.last_name,
        u.email,
        upm.method AS payout_method,
        upm.handle AS payout_handle,
        buyer.first_name AS buyer_first_name,
        buyer.last_name AS buyer_last_name,
        buyer.email AS buyer_email
       FROM composer_earnings ce
       LEFT JOIN music_publications mp ON mp.id = ce.music_publication_id
       LEFT JOIN users u ON u.id = ce.composer_id
       LEFT JOIN user_payout_methods upm ON upm.user_id = ce.composer_id
       LEFT JOIN users buyer ON buyer.id = ce.buyer_user_id
       WHERE ce.id = ?`,
      [earningId]
    );
    if (!earning) return errorResponse(res, 'Earning record not found', 404);

    if (earning.composer_id !== req.user.id && !['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Access denied', 403);
    }

    let [deductions] = await mysql.execute(
      `SELECT ced.*, rde.name AS entity_name
       FROM composer_earning_deductions ced
       LEFT JOIN royalty_deduction_entities rde ON rde.id = ced.deduction_entity_id
       WHERE ced.composer_earning_id = ?`,
      [earningId]
    );

    // Fallback 1: If composer_earning_deductions is empty, check product_royalty_config
    if ((!deductions || deductions.length === 0) && earning.music_publication_id) {
      const [configs] = await mysql.execute(
        `SELECT prc.*, rde.name AS entity_name
         FROM product_royalty_config prc
         JOIN royalty_deduction_entities rde ON rde.id = prc.deduction_entity_id
         WHERE prc.product_type = 'music' 
           AND prc.product_id = ? 
           AND prc.applies = 1 
           AND rde.is_active = 1`,
        [earning.music_publication_id]
      );

      if (configs && configs.length > 0) {
        const salePrice = Number(earning.sale_price || 0);
        deductions = [];
        for (const c of configs) {
          const pct = Number(c.percent || 0);
          const amt = Number((salePrice * (pct / 100)).toFixed(2));
          deductions.push({
            composer_earning_id: Number(earningId),
            deduction_entity_id: c.deduction_entity_id,
            entity_name: c.entity_name,
            percent: pct,
            amount: amt,
            status: earning.status === 'paid' ? 'paid' : 'pending'
          });

          // Self-heal: insert into composer_earning_deductions so it is persisted
          try {
            await mysql.execute(
              `INSERT INTO composer_earning_deductions (composer_earning_id, deduction_entity_id, percent, amount, status)
               VALUES (?, ?, ?, ?, ?)`,
              [earningId, c.deduction_entity_id, pct, amt, earning.status === 'paid' ? 'paid' : 'pending']
            );
          } catch (insErr) {
            console.warn('Could not auto-insert deduction row:', insErr.message);
          }
        }
      }
    }

    // Fallback 2: If still empty, but total_deductions > 0, check active royalty_deduction_entities or create breakdown
    if ((!deductions || deductions.length === 0) && Number(earning.total_deductions) > 0) {
      const [activeEntities] = await mysql.execute(
        `SELECT id, name FROM royalty_deduction_entities WHERE is_active = 1 ORDER BY id ASC`
      );

      const totalDed = Number(earning.total_deductions);
      const salePrice = Number(earning.sale_price) || totalDed;
      const totalPct = salePrice > 0 ? Number(((totalDed / salePrice) * 100).toFixed(2)) : 0;

      if (activeEntities && activeEntities.length > 0) {
        const entity = activeEntities[0];
        const dedItem = {
          composer_earning_id: Number(earningId),
          deduction_entity_id: entity.id,
          entity_name: entity.name,
          percent: totalPct,
          amount: totalDed,
          status: earning.status === 'paid' ? 'paid' : 'pending'
        };
        deductions = [dedItem];

        try {
          await mysql.execute(
            `INSERT INTO composer_earning_deductions (composer_earning_id, deduction_entity_id, percent, amount, status)
             VALUES (?, ?, ?, ?, ?)`,
            [earningId, entity.id, totalPct, totalDed, earning.status === 'paid' ? 'paid' : 'pending']
          );
        } catch (insErr) {
          console.warn('Could not auto-insert deduction fallback:', insErr.message);
        }
      }
    }

    let oneLicenseInfo = null;
    if (earning.one_license_record_id) {
      const [[record]] = await mysql.execute(
        `SELECT report_name, report_period, registrations, percent, value
         FROM one_license_records WHERE id = ?`,
        [earning.one_license_record_id]
      );
      oneLicenseInfo = record || null;
    }

    successResponse(res, { earning, deductions: deductions || [], oneLicenseInfo }, 'Deduction breakdown fetched');
  } catch (error) {
    console.error('Get earning deductions error:', error);
    errorResponse(res, 'Failed to fetch deduction breakdown', 500);
  }
});

// @route   PUT /api/royalty/composer-payouts/mark-paid
// @desc    Bulk mark composer_earnings rows as paid for a pay period
// @body    { earning_ids: [1,2,3], payment_method, payment_reference }  OR  { composer_id, pay_period, payment_method, payment_reference }
// @access  Private (Admin)
router.put('/mark-paid', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const { earning_ids, composer_id, pay_period, payment_method, payment_reference } = req.body;
    const mysql = getMySQLConnection();

    let result;

    if (Array.isArray(earning_ids) && earning_ids.length > 0) {
      const placeholders = earning_ids.map(() => '?').join(',');
      const params = [];
      let updateSql = `UPDATE composer_earnings SET status = 'paid', paid_at = NOW()`;
      if (payment_method) {
        updateSql += `, payment_method = ?`;
        params.push(payment_method);
      }
      if (payment_reference) {
        updateSql += `, payment_reference = ?`;
        params.push(payment_reference);
      }
      updateSql += ` WHERE id IN (${placeholders}) AND status = 'pending'`;
      params.push(...earning_ids);

      [result] = await mysql.execute(updateSql, params);
    } else if (composer_id && pay_period) {
      const params = [];
      let updateSql = `UPDATE composer_earnings SET status = 'paid', paid_at = NOW()`;
      if (payment_method) {
        updateSql += `, payment_method = ?`;
        params.push(payment_method);
      }
      if (payment_reference) {
        updateSql += `, payment_reference = ?`;
        params.push(payment_reference);
      }
      updateSql += ` WHERE composer_id = ? AND pay_period = ? AND status = 'pending'`;
      params.push(composer_id, pay_period);

      [result] = await mysql.execute(updateSql, params);
    } else {
      return errorResponse(res, 'Provide either earning_ids[] or { composer_id, pay_period }', 400);
    }

    successResponse(res, { updated: result.affectedRows }, 'Composer earnings marked as paid');
  } catch (error) {
    console.error('Mark composer paid error:', error);
    errorResponse(res, 'Failed to mark earnings as paid', 500);
  }
});

// @route   POST /api/royalty/composer-payouts/:royaltyId/quickbooks/bill
// @desc    Create QuickBooks Bill for a royalty record (or batch via body.earning_ids)
// @access  Private (Admin / Superadmin)
router.post('/:royaltyId/quickbooks/bill', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const { royaltyId } = req.params;
    const { earning_ids } = req.body;

    if (Array.isArray(earning_ids) && earning_ids.length > 0) {
      const results = [];
      const errors = [];
      for (const id of earning_ids) {
        try {
          const resBill = await payoutService.createQuickbooksBillForRoyalty(id);
          results.push({ royaltyId: id, ...resBill });
        } catch (err) {
          errors.push({ royaltyId: id, error: err.message });
        }
      }
      return successResponse(res, { results, errors }, 'Batch QuickBooks bill creation completed');
    }

    const billRes = await payoutService.createQuickbooksBillForRoyalty(royaltyId);
    return successResponse(res, billRes, 'QuickBooks Bill created successfully');
  } catch (error) {
    console.error('Create QuickBooks Bill error:', error);
    return errorResponse(res, error.message || 'Failed to create QuickBooks Bill', 500);
  }
});

// @route   POST /api/royalty/composer-payouts/:royaltyId/payout
// @desc    Process complete payout (QB Vendor -> QB Bill -> Stripe Payout -> QB BillPayment -> Mark Paid -> Email)
// @access  Private (Admin / Superadmin)
router.post('/:royaltyId/payout', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const { royaltyId } = req.params;
    const { earning_ids, composer_id, pay_period, payment_method, manual_reference, payment_method_label } = req.body;

    const payoutOptions = {
      paymentMethod: payment_method || 'manual',
      manualReference: manual_reference || null,
      paymentMethodLabel: payment_method_label || null
    };

    // Handle batch payout by earning_ids array
    if (Array.isArray(earning_ids) && earning_ids.length > 0) {
      const results = [];
      const errors = [];
      for (const id of earning_ids) {
        try {
          const pRes = await payoutService.processRoyaltyPayout(id, payoutOptions);
          results.push({ royaltyId: id, ...pRes });
        } catch (err) {
          errors.push({ royaltyId: id, error: err.message });
        }
      }
      return successResponse(res, { results, errors }, 'Batch royalty payout processing completed');
    }

    // Handle batch payout by composer_id & pay_period
    if (composer_id && pay_period) {
      const mysql = getMySQLConnection();
      const [rows] = await mysql.execute(
        `SELECT id FROM composer_earnings WHERE composer_id = ? AND pay_period = ? AND status = 'pending'`,
        [composer_id, pay_period]
      );
      const results = [];
      const errors = [];
      for (const row of rows) {
        try {
          const pRes = await payoutService.processRoyaltyPayout(row.id, payoutOptions);
          results.push({ royaltyId: row.id, ...pRes });
        } catch (err) {
          errors.push({ royaltyId: row.id, error: err.message });
        }
      }
      return successResponse(res, { results, errors }, 'Composer period payout processing completed');
    }

    // Single royalty payout
    const payoutRes = await payoutService.processRoyaltyPayout(royaltyId, payoutOptions);
    return successResponse(res, payoutRes, 'Royalty payout processed successfully');
  } catch (error) {
    console.error('Process royalty payout error:', error);
    return errorResponse(res, error.message || 'Failed to process royalty payout', 500);
  }
});

// @route   POST /api/royalty/composer-payouts/:royaltyId/quickbooks/retry-payment
// @desc    Retry QuickBooks BillPayment step ONLY (Safe retry when Stripe succeeded but QB failed)
// @access  Private (Admin / Superadmin)
router.post('/:royaltyId/quickbooks/retry-payment', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const { royaltyId } = req.params;
    const retryRes = await payoutService.retryQuickbooksPaymentForRoyalty(royaltyId);
    return successResponse(res, retryRes, 'QuickBooks payment retry completed successfully');
  } catch (error) {
    console.error('Retry QuickBooks payment error:', error);
    return errorResponse(res, error.message || 'Failed to retry QuickBooks payment sync', 500);
  }
});

// @route   GET /api/royalty/composer-payouts/:royaltyId/payment-status
// @desc    Get detailed payout status, Stripe IDs, QuickBooks IDs, and audit log
// @access  Private (Admin / Superadmin / Composer)
router.get('/:royaltyId/payment-status', auth, async (req, res) => {
  try {
    const { royaltyId } = req.params;
    const statusData = await payoutService.getRoyaltyPaymentStatus(royaltyId);

    // If composer is viewing, enforce ownership check
    if (req.user.user_type === 'composer' && statusData.royalty.composer_id !== req.user.id) {
      return errorResponse(res, 'Access denied', 403);
    }

    return successResponse(res, statusData, 'Royalty payment status fetched successfully');
  } catch (error) {
    console.error('Get payment status error:', error);
    return errorResponse(res, error.message || 'Failed to fetch payment status', 500);
  }
});

// @route   GET /api/royalty/composer-payouts/admin/all
// @desc    Admin view for all composer royalty transactions (paid, pending, etc.)
router.get('/admin/all', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const mysql = getMySQLConnection();
    const { status, pay_period, composer_id } = req.query;

    let where = 'WHERE 1=1';
    const params = [];
    if (status && status !== 'All' && status !== 'all') {
      where += ' AND ce.status = ?';
      params.push(status);
    }
    if (pay_period) {
      where += ' AND ce.pay_period = ?';
      params.push(pay_period);
    }
    if (composer_id) {
      where += ' AND ce.composer_id = ?';
      params.push(composer_id);
    }

    const [rows] = await mysql.execute(
      `SELECT 
        ce.*,
        u.first_name,
        u.last_name,
        u.email,
        COALESCE(ce.payment_method, upm.method, 'Stripe Connect') AS payout_method,
        COALESCE(ce.stripe_account_id, upm.handle) AS payout_handle,
        mp.composition_title,
        mp.artwork_file_url
       FROM composer_earnings ce
       JOIN users u ON u.id = ce.composer_id
       LEFT JOIN user_payout_methods upm ON upm.user_id = ce.composer_id
       LEFT JOIN music_publications mp ON mp.id = ce.music_publication_id
       ${where}
       ORDER BY ce.created_at DESC`,
      params
    );

    return successResponse(res, { earnings: rows, total: rows.length }, 'Composer royalties fetched successfully');
  } catch (error) {
    console.error('Get all composer royalties error:', error);
    return errorResponse(res, 'Failed to fetch composer royalties', 500);
  }
});

// @route   GET /api/royalty/composer-payouts/pending-by-composer
// @desc    SL Team view - pending payout totals grouped by composer (for batch payout runs)
router.get('/pending-by-composer', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const mysql = getMySQLConnection();

    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const {
      pay_period,
      search,
      sort_by,
      sortBy,
      sort_order,
      sortOrder,
    } = req.query;

    let where = "WHERE ce.status = 'pending'";
    const params = [];

    if (pay_period) {
      where += " AND ce.pay_period = ?";
      params.push(pay_period);
    }

    if (search) {
      where += " AND (u.first_name LIKE ? OR u.last_name LIKE ? OR CONCAT(u.first_name, ' ', u.last_name) LIKE ? OR u.email LIKE ?)";
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    // Total composers count
    const [countRows] = await mysql.execute(
      `
      SELECT COUNT(*) AS total
      FROM (
          SELECT ce.composer_id
          FROM composer_earnings ce
          JOIN users u
              ON u.id = ce.composer_id
          ${where}
          GROUP BY ce.composer_id
      ) AS grouped
      `,
      params
    );

    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.ceil(total / limit);

    // Sorting Configuration
    const rawSortBy = sort_by || sortBy || 'totalDue';
    const rawSortOrder = sort_order || sortOrder || 'DESC';
    const order = String(rawSortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const sortColumnMap = {
      totalDue: 'totalDue',
      total_due: 'totalDue',
      amount: 'totalDue',
      earnings: 'totalDue',
      earning: 'totalDue',
      composer_earning: 'totalDue',
      transactionCount: 'transactionCount',
      transaction_count: 'transactionCount',
      count: 'transactionCount',
      transactions: 'transactionCount',
      composer_id: 'ce.composer_id',
      composerId: 'ce.composer_id',
      id: 'ce.composer_id',
      first_name: 'u.first_name',
      firstName: 'u.first_name',
      last_name: 'u.last_name',
      lastName: 'u.last_name',
      name: 'u.first_name',
      composer_name: 'u.first_name',
      composerName: 'u.first_name',
      composer: 'u.first_name',
      email: 'u.email',
      payout_method: 'upm.method',
      payoutMethod: 'upm.method',
      method: 'upm.method',
      payout_handle: 'upm.handle',
      payoutHandle: 'upm.handle',
      handle: 'upm.handle',
    };

    const orderByColumn = sortColumnMap[rawSortBy] || 'totalDue';

    // Data
    const [rows] = await mysql.execute(
      `
      SELECT
          ce.composer_id,
          u.first_name,
          u.last_name,
          u.email,
          upm.method AS payout_method,
          upm.handle AS payout_handle,
          COUNT(*) AS transactionCount,
          SUM(ce.composer_earning) AS totalDue
      FROM composer_earnings ce
      JOIN users u
          ON u.id = ce.composer_id
      LEFT JOIN user_payout_methods upm
          ON upm.user_id = ce.composer_id
      ${where}
      GROUP BY ce.composer_id
      ORDER BY ${orderByColumn} ${order}
      LIMIT ?
      OFFSET ?
      `,
      [...params, limit, offset]
    );

    return successResponse(
      res,
      {
        composers: rows,
        pagination: {
          total,
          page,
          limit,
          totalPages,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1,
        },
        sorting: {
          sortBy: rawSortBy,
          sortOrder: order,
        },
        filters: {
          pay_period: pay_period || null,
          search: search || null,
        },
      },
      "Pending payouts by composer fetched"
    );
  } catch (error) {
    console.error("Pending by composer error:", error);
    return errorResponse(res, "Failed to fetch pending payouts", 500);
  }
});

module.exports = router;