const express = require('express');
const { auth } = require('../../middleware/auth');
const { getMySQLConnection } = require('../../config/mysql');
const { successResponse, errorResponse } = require('../../utils/response');

const router = express.Router();

const ALLOWED_COMPONENTS = ['Music', 'Academy', 'Documents'];

// @route   GET /api/royalty/pay-period-settings
// @desc    Get the configured Pay Period length (months) per component
// @access  Private
router.get('/', auth, async (req, res) => {
  try {
    const mysql = getMySQLConnection();
    const [settings] = await mysql.execute(
      `SELECT * FROM royalty_pay_period_settings ORDER BY component_name ASC`
    );
    successResponse(res, { settings }, 'Pay period settings fetched');
  } catch (error) {
    console.error('Get pay period settings error:', error);
    errorResponse(res, 'Failed to fetch pay period settings', 500);
  }
});

// @route   PUT /api/royalty/pay-period-settings/:componentName
// @desc    Update the Pay Period length for one component (e.g. switch
//          Music from 12 months to 6 or 3 months). Only affects FUTURE
//          runs of run-pro-rata - already-closed periods are untouched.
// @body    { period_months }
// @access  Private (Admin / SL Team)
router.put('/:componentName', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const { componentName } = req.params;
    const { period_months } = req.body;

    if (!ALLOWED_COMPONENTS.includes(componentName)) {
      return errorResponse(res, `componentName must be one of: ${ALLOWED_COMPONENTS.join(', ')}`, 400);
    }
    if (!Number.isInteger(period_months) || period_months < 1 || period_months > 24) {
      return errorResponse(res, 'period_months must be a whole number between 1 and 24', 400);
    }

    const mysql = getMySQLConnection();

    await mysql.execute(
      `INSERT INTO royalty_pay_period_settings (component_name, period_months, updated_by)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE period_months = VALUES(period_months), updated_by = VALUES(updated_by), updated_at = NOW()`,
      [componentName, period_months, req.user.id]
    );

    successResponse(res, { componentName, period_months }, 'Pay period length updated');
  } catch (error) {
    console.error('Update pay period settings error:', error);
    errorResponse(res, 'Failed to update pay period settings', 500);
  }
});

module.exports = router;
