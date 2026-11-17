const express = require('express');
const { auth } = require('../../middleware/auth');
const { getMySQLConnection } = require('../../config/mysql');
const { successResponse, errorResponse } = require('../../utils/response');
const { getDiocesanAdoptionDiscount } = require('../../utils/royaltyEngine');

const router = express.Router();

// @route   GET /api/royalty/diocesan/:dioceseId/adoption
// @desc    Check a diocese's parish adoption % and whether it qualifies
//          for the extra 25% discount (30%+ active parishes, SOW 3.1.D).
//          Call this from the diocesan checkout/renewal flow before
//          applying the final subscription price.
// @access  Private
router.get('/:dioceseId(\\d+)/adoption', auth, async (req, res) => {
  try {
    const mysql = getMySQLConnection();
    const { dioceseId } = req.params;

    const result = await getDiocesanAdoptionDiscount({ mysql, dioceseId });

    if (!result) return errorResponse(res, 'Diocese not found', 404);

    successResponse(res, result, 'Diocesan adoption status fetched');
  } catch (error) {
    console.error('Get diocesan adoption error:', error);
    errorResponse(res, 'Failed to fetch diocesan adoption status', 500);
  }
});

// @route   GET /api/royalty/diocesan/adoption-report
// @desc    SL Team - adoption status across ALL dioceses at once
router.get('/adoption-report', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const mysql = getMySQLConnection();
    const [dioceses] = await mysql.execute(`SELECT id FROM dioceses WHERE status = 'active'`);

    const report = [];
    for (const d of dioceses) {
      const result = await getDiocesanAdoptionDiscount({ mysql, dioceseId: d.id });
      if (result) report.push(result);
    }

    successResponse(res, {
      dioceses: report,
      qualifyingCount: report.filter(r => r.qualifiesForExtraDiscount).length,
      total: report.length
    }, 'Diocesan adoption report fetched');
  } catch (error) {
    console.error('Get adoption report error:', error);
    errorResponse(res, 'Failed to fetch adoption report', 500);
  }
});

module.exports = router;
