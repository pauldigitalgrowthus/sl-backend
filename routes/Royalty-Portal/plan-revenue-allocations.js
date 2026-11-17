const express = require('express');
const { body } = require('express-validator');
const { auth } = require('../../middleware/auth');
const { validate } = require('../../middleware/validation');
const { successResponse, errorResponse } = require('../../utils/response');
const { getMySQLConnection } = require('../../config/mysql');

const router = express.Router();

// ============================================
// Middleware to check if user is admin/sl_team
// (same pattern as ministry-plans.js)
// ============================================
const isAdmin = async (req, res, next) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const [users] = await mysqlConnection.execute(
      'SELECT role FROM users WHERE id = ?',
      [req.user.id]
    );

    if (users.length === 0 || users[0].role !== 'sl_team') {
      return errorResponse(res, 'Admin access required', 403);
    }
    next();
  } catch (error) {
    console.error('Admin check error:', error);
    errorResponse(res, 'Authorization failed', 500);
  }
};

// Allowed revenue components (mirrors SOW 4.1 categories)
const ALLOWED_COMPONENTS = ['Music', 'Planner', 'Academy', 'Documents'];

// ============================================
// HELPER: VALIDATE THAT A PLAN'S ALLOCATIONS SUM TO 100%
// ============================================
async function getPlanAllocationTotal(planId, mysqlConnection, excludeId = null) {
  let query = 'SELECT COALESCE(SUM(allocation_percent), 0) as total FROM plan_revenue_allocations WHERE plan_id = ?';
  const params = [planId];

  if (excludeId) {
    query += ' AND id != ?';
    params.push(excludeId);
  }

  const [[row]] = await mysqlConnection.execute(query, params);
  return Number(row.total);
}

// @route   GET /api/royalty/plan-revenue-allocations
// @desc    Get all revenue allocations across all plans (grouped by plan)
// @access  Public
router.get('/', async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    const [rows] = await mysqlConnection.execute(`
      SELECT
        pra.id,
        pra.plan_id,
        pra.component_name,
        pra.allocation_percent,
        pra.royalty_eligible,
        pra.notes,
        p.name as plan_name,
        p.slug as plan_slug,
        p.price as plan_price,
        p.billing_cycle
      FROM plan_revenue_allocations pra
      INNER JOIN plans p ON pra.plan_id = p.id
      WHERE p.is_active = TRUE
      ORDER BY p.name, pra.component_name
    `);

    // Group by plan
    const plansMap = {};
    rows.forEach((row) => {
      if (!plansMap[row.plan_id]) {
        plansMap[row.plan_id] = {
          planId: row.plan_id,
          planName: row.plan_name,
          planSlug: row.plan_slug,
          price: row.plan_price,
          billingCycle: row.billing_cycle,
          allocations: []
        };
      }
      plansMap[row.plan_id].allocations.push({
        id: row.id,
        componentName: row.component_name,
        allocationPercent: row.allocation_percent,
        royaltyEligible: !!row.royalty_eligible,
        notes: row.notes
      });
    });

    successResponse(res, {
      plans: Object.values(plansMap),
      total: rows.length
    }, 'Revenue allocations retrieved successfully');

  } catch (error) {
    console.error('Get revenue allocations error:', error);
    errorResponse(res, 'Failed to get revenue allocations', 500);
  }
});

// @route   GET /api/royalty/plan-revenue-allocations/plan/:planId
// @desc    Get revenue allocation breakdown for a single plan
// @access  Public
router.get('/plan/:planId(\\d+)', async (req, res) => {
  try {
    const { planId } = req.params;
    const mysqlConnection = getMySQLConnection();

    const [plans] = await mysqlConnection.execute(
      'SELECT id, name, slug, price, billing_cycle FROM plans WHERE id = ? AND is_active = TRUE',
      [planId]
    );

    if (plans.length === 0) {
      return errorResponse(res, 'Plan not found', 404);
    }

    const [allocations] = await mysqlConnection.execute(
      `SELECT id, component_name, allocation_percent, royalty_eligible, notes
       FROM plan_revenue_allocations
       WHERE plan_id = ?
       ORDER BY component_name`,
      [planId]
    );

    const totalPercent = allocations.reduce((sum, a) => sum + Number(a.allocation_percent), 0);

    successResponse(res, {
      plan: plans[0],
      allocations,
      totalPercent,
      isBalanced: totalPercent === 100
    }, 'Plan revenue allocation retrieved successfully');

  } catch (error) {
    console.error('Get plan revenue allocation error:', error);
    errorResponse(res, 'Failed to get plan revenue allocation', 500);
  }
});

// @route   POST /api/plan-revenue-allocations/admin/:planId/add
// @desc    Add a revenue component allocation to a plan
// @access  Private (Admin only)
router.post('/admin/:planId(\\d+)/add', [
  auth,
  // isAdmin,
  body('component_name')
    .trim()
    .notEmpty()
    .withMessage('Component name is required')
    .isIn(ALLOWED_COMPONENTS)
    .withMessage(`Component name must be one of: ${ALLOWED_COMPONENTS.join(', ')}`),
  body('allocation_percent')
    .isFloat({ min: 0, max: 100 })
    .withMessage('Allocation percent must be between 0 and 100'),
  body('royalty_eligible')
    .optional()
    .isBoolean(),
  body('notes')
    .optional()
    .trim()
], validate, async (req, res) => {
  try {
    const { planId } = req.params;
    let { component_name, allocation_percent, royalty_eligible, notes } = req.body;
    const mysqlConnection = getMySQLConnection();

    // Check if plan exists
    const [plans] = await mysqlConnection.execute(
      'SELECT * FROM plans WHERE id = ?',
      [planId]
    );

    if (plans.length === 0) {
      return errorResponse(res, 'Plan not found', 404);
    }

    // Check if this component is already allocated for this plan
    const [existing] = await mysqlConnection.execute(
      'SELECT id FROM plan_revenue_allocations WHERE plan_id = ? AND component_name = ?',
      [planId, component_name]
    );

    if (existing.length > 0) {
      return errorResponse(res, `${component_name} allocation already exists for this plan. Use update instead.`, 400);
    }

    // Warn (not block) if adding this would push total over 100%
    const currentTotal = await getPlanAllocationTotal(planId, mysqlConnection);
    const newTotal = currentTotal + Number(allocation_percent);

    if (royalty_eligible === undefined) {
      royalty_eligible = component_name !== 'Planner'; // Planner defaults to no royalty per SOW 4.3
    }

    const [result] = await mysqlConnection.execute(`
      INSERT INTO plan_revenue_allocations (plan_id, component_name, allocation_percent, royalty_eligible, notes)
      VALUES (?, ?, ?, ?, ?)
    `, [planId, component_name, allocation_percent, royalty_eligible, notes || null]);

    const [newAllocation] = await mysqlConnection.execute(
      'SELECT * FROM plan_revenue_allocations WHERE id = ?',
      [result.insertId]
    );

    successResponse(res, {
      allocation: newAllocation[0],
      planTotalPercent: newTotal,
      isBalanced: newTotal === 100,
      warning: newTotal !== 100 ? `Plan allocations now total ${newTotal}%, expected 100%` : null
    }, 'Revenue allocation added successfully', 201);

  } catch (error) {
    console.error('Add revenue allocation error:', error);
    errorResponse(res, 'Failed to add revenue allocation', 500);
  }
});

// @route   PUT /api/royalty/plan-revenue-allocations/admin/:planId/update/:id
// @desc    Update a revenue component allocation
// @access  Private (Admin only)
router.put('/admin/:planId(\\d+)/update/:id(\\d+)', [
  auth,
  // isAdmin,
  body('allocation_percent')
    .optional()
    .isFloat({ min: 0, max: 100 })
    .withMessage('Allocation percent must be between 0 and 100'),
  body('royalty_eligible')
    .optional()
    .isBoolean(),
  body('notes')
    .optional()
    .trim()
], validate, async (req, res) => {
  try {
    const { planId, id } = req.params;
    const { allocation_percent, royalty_eligible, notes } = req.body;
    const mysqlConnection = getMySQLConnection();

    // Check if allocation exists and belongs to this plan
    const [allocations] = await mysqlConnection.execute(
      'SELECT * FROM plan_revenue_allocations WHERE id = ? AND plan_id = ?',
      [id, planId]
    );

    if (allocations.length === 0) {
      return errorResponse(res, 'Revenue allocation not found for this plan', 404);
    }

    // Dynamic update builder (same pattern as plans update route)
    const updates = [];
    const values = [];

    if (allocation_percent !== undefined) {
      updates.push('allocation_percent = ?');
      values.push(allocation_percent);
    }

    if (royalty_eligible !== undefined) {
      updates.push('royalty_eligible = ?');
      values.push(royalty_eligible === true || royalty_eligible === 'true' ? 1 : 0);
    }

    if (notes !== undefined) {
      updates.push('notes = ?');
      values.push(notes);
    }

    if (updates.length === 0) {
      return errorResponse(res, 'No fields to update', 400);
    }

    updates.push('updated_at = NOW()');
    values.push(id);

    await mysqlConnection.execute(
      `UPDATE plan_revenue_allocations SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    const [updatedAllocation] = await mysqlConnection.execute(
      'SELECT * FROM plan_revenue_allocations WHERE id = ?',
      [id]
    );

    const planTotalPercent = await getPlanAllocationTotal(planId, mysqlConnection);

    return successResponse(res, {
      allocation: updatedAllocation[0],
      planTotalPercent,
      isBalanced: planTotalPercent === 100
    }, 'Revenue allocation updated successfully');

  } catch (error) {
    console.error('Update revenue allocation error:', error);
    return errorResponse(res, 'Failed to update revenue allocation', 500);
  }
});

// @route   DELETE /api/royalty/plan-revenue-allocations/admin/:planId/delete/:id
// @desc    Delete a revenue component allocation
// @access  Private (Admin only)
router.delete('/admin/:planId(\\d+)/delete/:id(\\d+)', [auth, isAdmin], async (req, res) => {
  try {
    const { planId, id } = req.params;
    const mysqlConnection = getMySQLConnection();

    const [allocations] = await mysqlConnection.execute(
      'SELECT * FROM plan_revenue_allocations WHERE id = ? AND plan_id = ?',
      [id, planId]
    );

    if (allocations.length === 0) {
      return errorResponse(res, 'Revenue allocation not found for this plan', 404);
    }

    await mysqlConnection.execute(
      'DELETE FROM plan_revenue_allocations WHERE id = ?',
      [id]
    );

    successResponse(res, {
      deletedId: Number(id)
    }, 'Revenue allocation deleted successfully');

  } catch (error) {
    console.error('Delete revenue allocation error:', error);
    errorResponse(res, 'Failed to delete revenue allocation', 500);
  }
});

// @route   POST /api/royalty/plan-revenue-allocations/admin/:planId/bulk-set
// @desc    Replace ALL revenue allocations for a plan in one call
//          (useful for setting up a full subscription type, e.g. SL Music + Planner)
// @access  Private (Admin only)
router.post('/admin/:planId(\\d+)/bulk-set', [
  auth,
  // isAdmin,
  body('allocations')
    .isArray({ min: 1 })
    .withMessage('Allocations array is required'),
  body('allocations.*.component_name')
    .trim()
    .notEmpty()
    .isIn(ALLOWED_COMPONENTS)
    .withMessage(`Component name must be one of: ${ALLOWED_COMPONENTS.join(', ')}`),
  body('allocations.*.allocation_percent')
    .isFloat({ min: 0, max: 100 })
    .withMessage('Allocation percent must be between 0 and 100'),
  body('allocations.*.royalty_eligible')
    .optional()
    .isBoolean()
], validate, async (req, res) => {
  const mysqlConnection = getMySQLConnection();
  try {
    const { planId } = req.params;
    const { allocations } = req.body;

    const [plans] = await mysqlConnection.execute(
      'SELECT * FROM plans WHERE id = ?',
      [planId]
    );

    if (plans.length === 0) {
      return errorResponse(res, 'Plan not found', 404);
    }

    // Guard against duplicate component names in the same payload
    const names = allocations.map((a) => a.component_name);
    if (new Set(names).size !== names.length) {
      return errorResponse(res, 'Duplicate component_name entries in payload', 400);
    }

    const totalPercent = allocations.reduce((sum, a) => sum + Number(a.allocation_percent), 0);

    // Wipe existing allocations for this plan, then insert fresh set
    await mysqlConnection.execute(
      'DELETE FROM plan_revenue_allocations WHERE plan_id = ?',
      [planId]
    );

    for (const alloc of allocations) {
      const royaltyEligible = alloc.royalty_eligible !== undefined
        ? alloc.royalty_eligible
        : alloc.component_name !== 'Planner';

      await mysqlConnection.execute(`
        INSERT INTO plan_revenue_allocations (plan_id, component_name, allocation_percent, royalty_eligible, notes)
        VALUES (?, ?, ?, ?, ?)
      `, [planId, alloc.component_name, alloc.allocation_percent, royaltyEligible, alloc.notes || null]);
    }


    const [savedAllocations] = await mysqlConnection.execute(
      'SELECT * FROM plan_revenue_allocations WHERE plan_id = ? ORDER BY component_name',
      [planId]
    );

    successResponse(res, {
      allocations: savedAllocations,
      totalPercent,
      isBalanced: totalPercent === 100,
      warning: totalPercent !== 100 ? `Allocations total ${totalPercent}%, expected 100%` : null
    }, 'Plan revenue allocations set successfully', 201);

  } catch (error) {
    console.error('Bulk-set revenue allocation error:', error);
    errorResponse(res, 'Failed to set plan revenue allocations', 500);
  }
});

module.exports = router;
