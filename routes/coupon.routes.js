const express = require('express');
const { getMySQLConnection } = require('../config/mysql');
const { auth, requireSLTeamWithTypes } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');
const router = express.Router();

// @route   POST /api/coupons
// @desc    Create a new coupon
// @access  Admin
router.post('/', async (req, res) => {
    try {
        const {
            code,
            title,
            description,
            discount_type,
            discount_value,
            max_discount_amount,
            coupon_for,            // subscription | music
            applicable_plan_id,
            max_total_uses,
            max_uses_per_user,
            valid_from,
            valid_till,
            status,
            metadata
        } = req.body;

        const mysqlConnection = getMySQLConnection();

        /* --------------------------------------------------
           1️⃣ VALIDATION
        -------------------------------------------------- */
        if (!code || !discount_type || !discount_value || !coupon_for) {
            return errorResponse(res, 'Required fields are missing', 400);
        }

        /* --------------------------------------------------
           2️⃣ CHECK COUPON EXISTS
        -------------------------------------------------- */
        const [existing] = await mysqlConnection.execute(
            'SELECT id FROM coupons WHERE code = ? AND user_id IS NULL',
            [code.trim()]
        );

        if (existing.length > 0) {
            return errorResponse(res, 'Coupon code already exists', 400);
        }

        /* --------------------------------------------------
           3️⃣ INSERT COUPON
        -------------------------------------------------- */
        const [result] = await mysqlConnection.execute(
            `INSERT INTO coupons (
          code,
          title,
          description,
          discount_type,
          discount_value,
          max_discount_amount,
          coupon_for,
          applicable_plan_id,
          max_total_uses,
          max_uses_per_user,
          valid_from,
          valid_till,
          status,
          metadata,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [
                code.trim(),
                title || null,
                description || null,
                discount_type,
                discount_value,
                max_discount_amount || null,
                coupon_for,
                applicable_plan_id || null,
                max_total_uses || null,
                max_uses_per_user || 1,
                valid_from || null,
                valid_till || null,
                status || 'active',
                JSON.stringify(metadata || {})
            ]
        );

        return successResponse(
            res,
            { id: result.insertId },
            'Coupon created successfully',
            201
        );

    } catch (error) {
        console.error('❌ CREATE COUPON ERROR:', error);
        return errorResponse(res, 'Failed to create coupon', 500);
    }
});

// @route   GET /api/coupons
// @desc    Get all coupons
// @access  Admin
router.get('/', async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();

        /* --------------------------------------------------
           1️⃣ FETCH COUPONS
        -------------------------------------------------- */
        const [coupons] = await mysqlConnection.execute(
            `SELECT * FROM coupons
         WHERE user_id IS NULL
         ORDER BY created_at DESC`
        );

        return successResponse(
            res,
            coupons,
            'Coupons fetched successfully'
        );

    } catch (error) {
        console.error('❌ FETCH COUPONS ERROR:', error);
        return errorResponse(res, 'Failed to fetch coupons', 500);
    }
});

// @route   GET /api/coupons/:id
// @desc    Get coupon by ID
// @access  Admin
router.get('/:id', async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();

        /* --------------------------------------------------
           1️⃣ FETCH COUPON
        -------------------------------------------------- */
        const [rows] = await mysqlConnection.execute(
            'SELECT * FROM coupons WHERE id = ?',
            [req.params.id]
        );

        if (rows.length === 0) {
            return errorResponse(res, 'Coupon not found', 404);
        }

        return successResponse(
            res,
            rows[0],
            'Coupon fetched successfully'
        );

    } catch (error) {
        console.error('❌ FETCH COUPON ERROR:', error);
        return errorResponse(res, 'Failed to fetch coupon', 500);
    }
});

// @route   PUT /api/coupons/:id
// @desc    Update coupon
// @access  Admin
router.put('/:id', async (req, res) => {
    try {
        const {
            title,
            description,
            discount_type,
            discount_value,
            max_discount_amount,
            coupon_for,
            applicable_plan_id,
            max_total_uses,
            max_uses_per_user,
            valid_from,
            valid_till,
            status,
            metadata
        } = req.body;

        const mysqlConnection = getMySQLConnection();

        /* --------------------------------------------------
           1️⃣ CHECK COUPON EXISTS
        -------------------------------------------------- */
        const [existing] = await mysqlConnection.execute(
            'SELECT id FROM coupons WHERE id = ?',
            [req.params.id]
        );

        if (existing.length === 0) {
            return errorResponse(res, 'Coupon not found', 404);
        }

        /* --------------------------------------------------
           2️⃣ UPDATE COUPON
        -------------------------------------------------- */
        await mysqlConnection.execute(
            `UPDATE coupons SET
          title = ?,
          description = ?,
          discount_type = ?,
          discount_value = ?,
          max_discount_amount = ?,
          coupon_for = ?,
          applicable_plan_id = ?,
          max_total_uses = ?,
          max_uses_per_user = ?,
          valid_from = ?,
          valid_till = ?,
          status = ?,
          metadata = ?,
          updated_at = NOW()
        WHERE id = ?`,
            [
                title || null,
                description || null,
                discount_type,
                discount_value,
                max_discount_amount || null,
                coupon_for,
                applicable_plan_id || null,
                max_total_uses || null,
                max_uses_per_user || 1,
                valid_from || null,
                valid_till || null,
                status,
                JSON.stringify(metadata || {}),
                req.params.id
            ]
        );

        return successResponse(
            res,
            null,
            'Coupon updated successfully'
        );

    } catch (error) {
        console.error('❌ UPDATE COUPON ERROR:', error);
        return errorResponse(res, 'Failed to update coupon', 500);
    }
});

// @route   DELETE /api/coupons/:id
// @desc    Delete coupon
// @access  Admin
router.delete('/:id', async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();

        /* --------------------------------------------------
           1️⃣ CHECK COUPON EXISTS
        -------------------------------------------------- */
        const [existing] = await mysqlConnection.execute(
            'SELECT id FROM coupons WHERE id = ?',
            [req.params.id]
        );

        if (existing.length === 0) {
            return errorResponse(res, 'Coupon not found', 404);
        }

        /* --------------------------------------------------
           2️⃣ DELETE COUPON
        -------------------------------------------------- */
        await mysqlConnection.execute(
            'DELETE FROM coupons WHERE id = ?',
            [req.params.id]
        );

        return successResponse(
            res,
            null,
            'Coupon deleted successfully'
        );

    } catch (error) {
        console.error('❌ DELETE COUPON ERROR:', error);
        return errorResponse(res, 'Failed to delete coupon', 500);
    }
});
module.exports = router;