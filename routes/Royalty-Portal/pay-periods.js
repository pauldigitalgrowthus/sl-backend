const express = require('express');
const { auth } = require('../../middleware/auth');
const { getMySQLConnection } = require('../../config/mysql');
const { successResponse, errorResponse } = require('../../utils/response');
const {
  getCurrentPayPeriod,
  distributeDocumentSubscriptionPool,
  getPayPeriodMonths,
  resolveCurrentPeriodWindow,
  calculateMusicProRataDistribution,
  calculateEducatorProRataDistribution
} = require('../../utils/royaltyEngine');

const router = express.Router();

// @route   POST /api/royalty/pay-periods/close
// @desc    Admin-triggered: distribute subscription pools for an EXPLICIT
//          date range. Music + Academy use the client's Pro-Rata Factor
//          method (TSS/TAP, weighted by Single Purchase Price - see
//          8_10_26 Pro-Rata spec); Documents keeps the simple usage-count
//          model (client's spec only covers Music/Educator royalties).
// @body    { periodStart, periodEnd, payPeriod }
// @access  Private (Admin)
router.post('/close', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const { periodStart, periodEnd, payPeriod } = req.body;
    if (!periodStart || !periodEnd) {
      return errorResponse(res, 'periodStart and periodEnd are required (YYYY-MM-DD)', 400);
    }

    const mysql = getMySQLConnection();
    const resolvedPayPeriod = payPeriod || getCurrentPayPeriod();

    const musicResult = await calculateMusicProRataDistribution({
      mysql, periodStart, periodEnd, payPeriod: resolvedPayPeriod, runBy: req.user.id
    });

    const educatorResult = await calculateEducatorProRataDistribution({
      mysql, periodStart, periodEnd, payPeriod: resolvedPayPeriod, runBy: req.user.id
    });

    const documentResult = await distributeDocumentSubscriptionPool({
      mysql, periodStart, periodEnd, payPeriod: resolvedPayPeriod
    });

    successResponse(res, {
      payPeriod: resolvedPayPeriod,
      periodStart,
      periodEnd,
      music: musicResult,
      educators: educatorResult,
      documents: documentResult
    }, 'Pay period closed and subscription pools distributed');

  } catch (error) {
    console.error('Close pay period error:', error);
    errorResponse(res, 'Failed to close pay period', 500);
  }
});

// @route   POST /api/royalty/pay-periods/run-pro-rata
// @desc    Run Music + Academy Pro-Rata for the CURRENT period window,
//          auto-resolved from each component's configured period length
//          (royalty_pay_period_settings - default 12 months). This is
//          what a scheduled job should call at the end of each period;
//          /close above is for ad-hoc/backfill runs with explicit dates.
// @access  Private (Admin)
router.post('/run-pro-rata', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const mysql = getMySQLConnection();

    const musicMonths = await getPayPeriodMonths(mysql, 'Music');
    const musicWindow = resolveCurrentPeriodWindow(musicMonths);
    const musicResult = await calculateMusicProRataDistribution({
      mysql, ...musicWindow, runBy: req.user.id
    });

    const academyMonths = await getPayPeriodMonths(mysql, 'Academy');
    const academyWindow = resolveCurrentPeriodWindow(academyMonths);
    const educatorResult = await calculateEducatorProRataDistribution({
      mysql, ...academyWindow, runBy: req.user.id
    });

    successResponse(res, {
      music: { window: musicWindow, ...musicResult },
      educators: { window: academyWindow, ...educatorResult }
    }, 'Pro-Rata distribution run for current period');

  } catch (error) {
    console.error('Run Pro-Rata error:', error);
    errorResponse(res, 'Failed to run Pro-Rata distribution', 500);
  }
});

// @route   GET /api/royalty/pay-periods/pro-rata-runs
// @desc    Audit trail of every Pro-Rata calculation (TAP/TSS/Factor),
//          matching the client's Master Payment Spreadsheet columns -
//          use this to explain/reconcile any composer or educator's
//          royalty for a given period.
// @access  Private (Admin)
router.get('/pro-rata-runs', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const mysql = getMySQLConnection();
    const { component_name, pay_period } = req.query;

    let where = 'WHERE 1=1';
    const params = [];
    if (component_name) { where += ' AND component_name = ?'; params.push(component_name); }
    if (pay_period) { where += ' AND pay_period = ?'; params.push(pay_period); }

    const [runs] = await mysql.execute(
      `SELECT * FROM royalty_pro_rata_runs ${where} ORDER BY created_at DESC`,
      params
    );

    successResponse(res, { runs, total: runs.length }, 'Pro-Rata run history fetched');
  } catch (error) {
    console.error('Get Pro-Rata runs error:', error);
    errorResponse(res, 'Failed to fetch Pro-Rata run history', 500);
  }
});

// @route   GET /api/royalty/pay-periods/:payPeriod/summary
// @desc    SL Team overview for a pay period (SOW 8.3) - composer + document + educator totals
router.get('/:payPeriod/summary', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const mysql = getMySQLConnection();
    const { payPeriod } = req.params;

    const [[composerTotals]] = await mysql.execute(
      `SELECT
        COUNT(*) AS transactionCount,
        COALESCE(SUM(sale_price), 0) AS grossRevenue,
        COALESCE(SUM(total_deductions), 0) AS totalDeductions,
        COALESCE(SUM(composer_earning), 0) AS totalComposerEarnings
       FROM composer_earnings WHERE pay_period = ?`,
      [payPeriod]
    );

    const [[documentTotals]] = await mysql.execute(
      `SELECT
        COUNT(*) AS transactionCount,
        COALESCE(SUM(gross_amount), 0) AS grossRevenue,
        COALESCE(SUM(total_deductions), 0) AS totalDeductions,
        COALESCE(SUM(owner_earning), 0) AS totalOwnerEarnings
       FROM document_royalty_earnings WHERE pay_period = ?`,
      [payPeriod]
    );

    const [[stipendTotals]] = await mysql.execute(
      `SELECT COUNT(*) AS stipendCount, COALESCE(SUM(rate_applied), 0) AS totalStipends
       FROM review_board_stipends WHERE pay_period = ?`,
      [payPeriod]
    );

    const [[educatorTotals]] = await mysql.execute(
      `SELECT
        COUNT(*) AS transactionCount,
        COALESCE(SUM(sale_price), 0) AS grossRevenue,
        COALESCE(SUM(total_deductions), 0) AS totalDeductions,
        COALESCE(SUM(educator_earning), 0) AS totalEducatorEarnings
       FROM educator_earnings WHERE pay_period = ?`,
      [payPeriod]
    );

    const [proRataRuns] = await mysql.execute(
      `SELECT * FROM royalty_pro_rata_runs WHERE pay_period = ?`,
      [payPeriod]
    );

    const [deductionsByEntity] = await mysql.execute(
      `SELECT rde.name AS entity_name, SUM(ced.amount) AS total
       FROM composer_earning_deductions ced
       JOIN royalty_deduction_entities rde ON rde.id = ced.deduction_entity_id
       JOIN composer_earnings ce ON ce.id = ced.composer_earning_id
       WHERE ce.pay_period = ?
       GROUP BY rde.name
       UNION ALL
       SELECT rde.name AS entity_name, SUM(drd.amount) AS total
       FROM document_royalty_deductions drd
       JOIN royalty_deduction_entities rde ON rde.id = drd.deduction_entity_id
       JOIN document_royalty_earnings dre ON dre.id = drd.document_royalty_earning_id
       WHERE dre.pay_period = ?
       GROUP BY rde.name
       UNION ALL
       SELECT rde.name AS entity_name, SUM(eed.amount) AS total
       FROM educator_earning_deductions eed
       JOIN royalty_deduction_entities rde ON rde.id = eed.deduction_entity_id
       JOIN educator_earnings ee ON ee.id = eed.educator_earning_id
       WHERE ee.pay_period = ?
       GROUP BY rde.name`,
      [payPeriod, payPeriod, payPeriod]
    );

    successResponse(res, {
      payPeriod,
      composer: composerTotals,
      documents: documentTotals,
      educators: educatorTotals,
      reviewBoard: stipendTotals,
      proRataRuns,
      deductionsByEntity
    }, 'Pay period summary fetched');

  } catch (error) {
    console.error('Pay period summary error:', error);
    errorResponse(res, 'Failed to fetch pay period summary', 500);
  }
});

module.exports = router;
