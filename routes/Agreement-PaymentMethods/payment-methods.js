const express = require('express');
const { getMySQLConnection } = require('../../config/mysql');
const { auth } = require('../../middleware/auth');
const { successResponse, errorResponse } = require('../../utils/response');
const router = express.Router();

// ============= Payment Methods Management =============

// @route POST /api/agreements/payment-methods
// @desc    POST user payment methods
// @access Private
router.post("/", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const {
            card_number,
            expiry_month,
            expiry_year,
            card_holder_name,
            billing_address
        } = req.body;

        if (!card_number || !expiry_month || !expiry_year || !card_holder_name) {
            return res.status(400).json({ error: "All required fields missing" });
        }

        const last4 = card_number.slice(-4);

        const cardBrand =
            card_number.startsWith("4") ? "Visa" :
                card_number.startsWith("5") ? "Mastercard" :
                    "Unknown";

        const [result] = await mysql.execute(
            `INSERT INTO user_payment_methods 
      (user_id, card_holder_name, card_last4, card_brand, expiry_month, expiry_year, billing_address)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [req.user.id, card_holder_name, last4, cardBrand, expiry_month, expiry_year, billing_address]
        );

        successResponse(res, { id: result.insertId }, "Card added successfully", 201);
    } catch (err) {
        errorResponse(res, err.message, 500);
    }
});

// @route GET /api/agreements/payment-methods
// @desc    Get user payment methods
// @access Private
router.get("/", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();

        const [rows] = await mysql.execute(
            `SELECT * FROM user_payment_methods
       WHERE user_id = ? AND deleted_at IS NULL`,
            [req.user.id]
        );

        successResponse(res, rows, "Payment methods fetched", 200);
    } catch (err) {
        console.log(err)
        errorResponse(res, err.message, 500);
    }
});

// @route PUT /api/agreements/payment-methods/:id
// @desc    Update user payment method
// @access  Private
router.put("/:id", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;

        const {
            card_holder_name,
            expiry_month,
            expiry_year,
            billing_address
        } = req.body;

        const [result] = await mysql.execute(
            `UPDATE user_payment_methods
       SET card_holder_name=?, expiry_month=?, expiry_year=?, billing_address=?
       WHERE id=? AND user_id=? AND deleted_at IS NULL`,
            [card_holder_name, expiry_month, expiry_year, billing_address, id, req.user.id]
        );

        successResponse(res, {}, "Payment method updated", 200);
    } catch (err) {
        errorResponse(res, err.message, 500);
    }
});

// @route DELETE /api/agreements/payment-methods/:id
// @desc    Delete user payment method
// @access  Private
router.delete("/:id", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;

        await mysql.execute(
            `UPDATE user_payment_methods
       SET deleted_at = NOW()
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
            [id, req.user.id]
        );

        successResponse(res, {}, "Payment method removed", 200);
    } catch (err) {
        errorResponse(res, err.message, 500);
    }
});

// @route PUT /api/agreements/payment-methods/:id/default
// @desc    Set default user payment method
// @access  Private
router.put("/:id/default", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;

        // Remove old default
        await mysql.execute(
            `UPDATE user_payment_methods
       SET is_default = 0
       WHERE user_id = ?`,
            [req.user.id]
        );

        // Set new default
        await mysql.execute(
            `UPDATE user_payment_methods
       SET is_default = 1
       WHERE id = ? AND user_id = ?`,
            [id, req.user.id]
        );

        successResponse(res, {}, "Default card updated", 200);
    } catch (err) {
        errorResponse(res, err.message, 500);
    }
});

module.exports = router;