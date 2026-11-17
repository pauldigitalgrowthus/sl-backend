const express = require('express');
const xlsx = require('xlsx');
const { auth } = require('../../middleware/auth');
const { getMySQLConnection } = require('../../config/mysql');
const { successResponse, errorResponse } = require('../../utils/response');

const router = express.Router();

/* ============================================================
   HELPER: send either JSON or a CSV file download
============================================================ */
const respondWithData = (req, res, rows, filenameBase) => {
  const format = (req.query.format || 'json').toLowerCase();

  if (format === 'csv') {
    const worksheet = xlsx.utils.json_to_sheet(rows);
    const csvBuffer = xlsx.write(
      { Sheets: { Report: worksheet }, SheetNames: ['Report'] },
      { bookType: 'csv', type: 'buffer' }
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.csv"`);
    res.setHeader('Content-Type', 'text/csv');
    return res.send(csvBuffer);
  }

  return successResponse(res, { rows, total: rows.length }, `${filenameBase} fetched`);
};

/* ============================================================
   8.1 COMPOSER VIEW
   ------------------------------------------------------------
   Filters: date range, music search, type of music
   One row per composition (never repeats), with breakdown columns
============================================================ */
router.get('/composer', auth, async (req, res) => {
  try {
    const composerId = req.user.user_type === 'admin' || req.user.user_type === 'superadmin'
      ? (req.query.composer_id || req.user.id)
      : req.user.id;

    const { from, to, music_search, type_of_music } = req.query;
    const mysql = getMySQLConnection();

    let where = 'WHERE ce.composer_id = ? AND ce.status != \'cancelled\'';
    const params = [composerId];

    if (from && to) { where += ' AND DATE(ce.created_at) BETWEEN ? AND ?'; params.push(from, to); }
    if (music_search) { where += ' AND ce.composition_title LIKE ?'; params.push(`%${music_search}%`); }
    if (type_of_music) { where += ' AND mp.types_of_music LIKE ?'; params.push(`%${type_of_music}%`); }

    const [rows] = await mysql.execute(
      `SELECT
        ce.music_publication_id AS id,
        ce.composition_title,
        mp.types_of_music,
        SUM(CASE WHEN ce.source_type = 'a_la_carte' THEN ce.composer_earning ELSE 0 END) AS aLaCarteSales,
        SUM(CASE WHEN ce.source_type = 'subscription' THEN ce.composer_earning ELSE 0 END) AS subscriptionProRata,
        SUM(CASE WHEN ce.source_type = 'one_license' THEN ce.composer_earning ELSE 0 END) AS oneLicenseRoyalties,
        SUM(ce.total_deductions) AS totalDeductions,
        SUM(ce.composer_earning) AS totalRoyalties
       FROM composer_earnings ce
       LEFT JOIN music_publications mp ON mp.id = ce.music_publication_id
       ${where}
       GROUP BY ce.music_publication_id, ce.composition_title, mp.types_of_music
       ORDER BY totalRoyalties DESC`,
      params
    );

    respondWithData(req, res, rows, `composer-royalty-view-${composerId}`);
  } catch (error) {
    console.error('Composer view error:', error);
    errorResponse(res, 'Failed to fetch composer view', 500);
  }
});

// @route   GET /api/royalty/dashboards/composer/:musicPublicationId/one-license-detail
// @desc    Dropdown detail for the "ONE LICENSE royalties" column (SOW 8.1).
//          Each source worksheet stays a SEPARATE line - the client
//          explicitly wants "ONE LICENSE - Annual / Catholic" and
//          "ONE LICENSE - Podcast / Catholic" shown distinctly, even for
//          the same composition, rather than combined into one total.
router.get('/composer/:musicPublicationId(\\d+)/one-license-detail', auth, async (req, res) => {
  try {
    const mysql = getMySQLConnection();
    const { musicPublicationId } = req.params;

    const [details] = await mysql.execute(
      `SELECT
        olr.source_sheet, olr.revenue_type, olr.category, olr.territory_region,
        olr.report_period, olr.sku, olr.registrations, olr.value AS grossRevenue,
        ce.composer_earning, ce.status AS payoutStatus, ce.created_at
       FROM one_license_records olr
       JOIN composer_earnings ce ON ce.one_license_record_id = olr.id
       WHERE olr.music_publication_id = ? AND ce.composer_id = ?
       ORDER BY ce.created_at DESC`,
      [musicPublicationId, req.user.id]
    );

    const totalEarning = details.reduce((sum, d) => sum + Number(d.composer_earning), 0);

    successResponse(res, {
      details,
      total: details.length,
      totalEarning: Number(totalEarning.toFixed(2))
    }, 'ONE LICENSE detail fetched');
  } catch (error) {
    console.error('ONE LICENSE detail error:', error);
    errorResponse(res, 'Failed to fetch ONE LICENSE detail', 500);
  }
});

/* ============================================================
   8.2 EDUCATOR VIEW
   ------------------------------------------------------------
   Same structure as Composer View (SOW 8.2), but for courses.
   Filters: date range, course search, category.
============================================================ */
router.get('/educator', auth, async (req, res) => {
  try {
    const educatorId = ['admin', 'superadmin'].includes(req.user.user_type)
      ? (req.query.educator_id || req.user.id)
      : req.user.id;

    const { from, to, course_search, category } = req.query;
    const mysql = getMySQLConnection();

    let where = 'WHERE ee.educator_id = ? AND ee.status != \'cancelled\'';
    const params = [educatorId];

    if (from && to) { where += ' AND DATE(ee.created_at) BETWEEN ? AND ?'; params.push(from, to); }
    if (course_search) { where += ' AND ee.course_title LIKE ?'; params.push(`%${course_search}%`); }
    if (category) { where += ' AND c.category = ?'; params.push(category); }

    const [rows] = await mysql.execute(
      `SELECT
        ee.course_id AS id,
        ee.course_title,
        c.category,
        SUM(CASE WHEN ee.source_type = 'a_la_carte' THEN ee.educator_earning ELSE 0 END) AS aLaCarteSales,
        SUM(CASE WHEN ee.source_type = 'subscription' THEN ee.educator_earning ELSE 0 END) AS subscriptionProRata,
        SUM(ee.total_deductions) AS totalDeductions,
        SUM(ee.educator_earning) AS totalRoyalties
       FROM educator_earnings ee
       LEFT JOIN courses c ON c.id = ee.course_id
       ${where}
       GROUP BY ee.course_id, ee.course_title, c.category
       ORDER BY totalRoyalties DESC`,
      params
    );

    respondWithData(req, res, rows, `educator-royalty-view-${educatorId}`);
  } catch (error) {
    console.error('Educator view error:', error);
    errorResponse(res, 'Failed to fetch educator view', 500);
  }
});

/* ============================================================
   8.5 REVIEW BOARD VIEW
   ------------------------------------------------------------
   Same structure as Composer View, plus review counts + stipend totals
============================================================ */
router.get('/review-board', auth, async (req, res) => {
  try {
    const reviewerId = ['admin', 'superadmin'].includes(req.user.user_type)
      ? (req.query.reviewer_id || req.user.id)
      : req.user.id;

    const { from, to, type_of_music } = req.query;
    const mysql = getMySQLConnection();

    let where = 'WHERE reviewer_id = ?';
    const params = [reviewerId];
    if (from && to) { where += ' AND DATE(created_at) BETWEEN ? AND ?'; params.push(from, to); }
    if (type_of_music) { where += ' AND type_of_music = ?'; params.push(type_of_music); }

    const [rows] = await mysql.execute(
      `SELECT
        music_publication_id AS id,
        composition_title,
        type_of_music,
        COUNT(*) AS reviewCount,
        SUM(rate_applied) AS stipendTotal,
        SUM(CASE WHEN status = 'paid' THEN rate_applied ELSE 0 END) AS paidTotal,
        SUM(CASE WHEN status = 'pending' THEN rate_applied ELSE 0 END) AS pendingTotal
       FROM review_board_stipends
       ${where}
       GROUP BY music_publication_id, composition_title, type_of_music
       ORDER BY stipendTotal DESC`,
      params
    );

    const [[overall]] = await mysql.execute(
      `SELECT COUNT(*) AS totalReviews, SUM(rate_applied) AS totalStipends
       FROM review_board_stipends ${where}`,
      params
    );

    if (req.query.format === 'csv') {
      return respondWithData(req, res, rows, `review-board-view-${reviewerId}`);
    }

    successResponse(res, { rows, overall, total: rows.length }, 'Review board view fetched');
  } catch (error) {
    console.error('Review board view error:', error);
    errorResponse(res, 'Failed to fetch review board view', 500);
  }
});

/* ============================================================
   8.3 SL TEAM VIEW — full financial system
============================================================ */
router.get('/sl-team', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const { from, to } = req.query;
    const mysql = getMySQLConnection();
    const dateFilter = from && to ? 'AND DATE(created_at) BETWEEN ? AND ?' : '';
    const dateParams = from && to ? [from, to] : [];

    // Total Income by source
    const [[subscriptionIncome]] = await mysql.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM payment_transactions
       WHERE status = 'completed' AND plan_id IS NOT NULL ${dateFilter}`,
      dateParams
    ).catch(() => [[{ total: 0 }]]);

    const [[aLaCarteIncome]] = await mysql.execute(
      `SELECT COALESCE(SUM(sale_price), 0) AS total FROM composer_earnings
       WHERE source_type = 'a_la_carte' AND status != 'cancelled' ${dateFilter}`,
      dateParams
    );

    const [[oneLicenseIncome]] = await mysql.execute(
      `SELECT COALESCE(SUM(value), 0) AS total FROM one_license_records WHERE status = 'processed'`
    );

    const [[aLaCarteCourseIncome]] = await mysql.execute(
      `SELECT COALESCE(SUM(sale_price), 0) AS total FROM educator_earnings
       WHERE source_type = 'a_la_carte' AND status != 'cancelled' ${dateFilter}`,
      dateParams
    );

    // Total Expenses breakdown
    const [[composerRoyalties]] = await mysql.execute(
      `SELECT COALESCE(SUM(composer_earning), 0) AS total FROM composer_earnings
       WHERE status != 'cancelled' ${dateFilter}`,
      dateParams
    );

    const [[documentRoyalties]] = await mysql.execute(
      `SELECT COALESCE(SUM(owner_earning), 0) AS total FROM document_royalty_earnings
       WHERE status != 'cancelled' ${dateFilter}`,
      dateParams
    );

    const [[educatorRoyalties]] = await mysql.execute(
      `SELECT COALESCE(SUM(educator_earning), 0) AS total FROM educator_earnings
       WHERE status != 'cancelled' ${dateFilter}`,
      dateParams
    );

    const [[reviewBoardStipends]] = await mysql.execute(
      `SELECT COALESCE(SUM(rate_applied), 0) AS total FROM review_board_stipends
       ${from && to ? 'WHERE DATE(created_at) BETWEEN ? AND ?' : ''}`,
      dateParams
    );

    const [[copyrightHolderRoyalties]] = await mysql.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM (
         SELECT ced.amount FROM composer_earning_deductions ced
         JOIN composer_earnings ce ON ce.id = ced.composer_earning_id
         WHERE 1=1 ${from && to ? 'AND DATE(ce.created_at) BETWEEN ? AND ?' : ''}
         UNION ALL
         SELECT drd.amount FROM document_royalty_deductions drd
         JOIN document_royalty_earnings dre ON dre.id = drd.document_royalty_earning_id
         WHERE 1=1 ${from && to ? 'AND DATE(dre.created_at) BETWEEN ? AND ?' : ''}
         UNION ALL
         SELECT eed.amount FROM educator_earning_deductions eed
         JOIN educator_earnings ee ON ee.id = eed.educator_earning_id
         WHERE 1=1 ${from && to ? 'AND DATE(ee.created_at) BETWEEN ? AND ?' : ''}
       ) all_deductions`,
      from && to ? [...dateParams, ...dateParams, ...dateParams] : []
    );

    const [[couponsUsed]] = await mysql.execute(
      `SELECT COUNT(*) AS count, COALESCE(SUM(discount_value), 0) AS totalDiscount
       FROM coupons WHERE status = 'used' ${from && to ? 'AND used_at BETWEEN ? AND ?' : ''}`,
      dateParams
    ).catch(() => [[{ count: 0, totalDiscount: 0 }]]);

    const [[returnsTotal]] = await mysql.execute(
      `SELECT COUNT(*) AS count, COALESCE(SUM(gross_amount_reversed), 0) AS totalLost
       FROM royalty_returns ${from && to ? 'WHERE DATE(returned_at) BETWEEN ? AND ?' : ''}`,
      dateParams
    );

    successResponse(res, {
      totalIncome: {
        subscriptions: subscriptionIncome?.total || 0,
        aLaCarte: Number(aLaCarteIncome.total) + Number(aLaCarteCourseIncome.total),
        oneLicense: oneLicenseIncome.total
      },
      totalExpenses: {
        composerRoyalties: composerRoyalties.total,
        documentRoyalties: documentRoyalties.total,
        educatorRoyalties: educatorRoyalties.total,
        reviewBoardStipends: reviewBoardStipends.total,
        copyrightHolderRoyalties: copyrightHolderRoyalties.total,
        coupons: couponsUsed,
        returns: returnsTotal
      }
    }, 'SL Team financial view fetched');
  } catch (error) {
    console.error('SL Team view error:', error);
    errorResponse(res, 'Failed to fetch SL Team view', 500);
  }
});

/* ============================================================
   8.4 ICEL / CCD / USCCB / OTHER REPORTING
============================================================ */
router.get('/deduction-entities-report', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const { from, to } = req.query;
    const mysql = getMySQLConnection();
    const dateFilter = from && to ? 'AND DATE(ce.created_at) BETWEEN ? AND ?' : '';
    const dateParams = from && to ? [from, to] : [];

    const [rows] = await mysql.execute(
      `SELECT rde.name AS entity, 'Music' AS module, COUNT(*) AS transactionCount, SUM(ced.amount) AS totalDeducted
       FROM composer_earning_deductions ced
       JOIN royalty_deduction_entities rde ON rde.id = ced.deduction_entity_id
       JOIN composer_earnings ce ON ce.id = ced.composer_earning_id
       WHERE ce.status != 'cancelled' ${dateFilter}
       GROUP BY rde.name

       UNION ALL

       SELECT rde.name AS entity, 'Documents' AS module, COUNT(*) AS transactionCount, SUM(drd.amount) AS totalDeducted
       FROM document_royalty_deductions drd
       JOIN royalty_deduction_entities rde ON rde.id = drd.deduction_entity_id
       JOIN document_royalty_earnings dre ON dre.id = drd.document_royalty_earning_id
       WHERE dre.status != 'cancelled' ${from && to ? 'AND DATE(dre.created_at) BETWEEN ? AND ?' : ''}
       GROUP BY rde.name

       UNION ALL

       SELECT rde.name AS entity, 'Academy' AS module, COUNT(*) AS transactionCount, SUM(eed.amount) AS totalDeducted
       FROM educator_earning_deductions eed
       JOIN royalty_deduction_entities rde ON rde.id = eed.deduction_entity_id
       JOIN educator_earnings ee ON ee.id = eed.educator_earning_id
       WHERE ee.status != 'cancelled' ${from && to ? 'AND DATE(ee.created_at) BETWEEN ? AND ?' : ''}
       GROUP BY rde.name

       ORDER BY entity, module`,
      [...dateParams, ...dateParams, ...dateParams]
    );

    respondWithData(req, res, rows, 'icel-ccd-usccb-report');
  } catch (error) {
    console.error('Deduction entities report error:', error);
    errorResponse(res, 'Failed to fetch deduction entities report', 500);
  }
});

module.exports = router;
