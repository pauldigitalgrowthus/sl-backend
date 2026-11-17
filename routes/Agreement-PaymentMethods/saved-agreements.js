const express = require('express');
const { getMySQLConnection } = require('../../config/mysql');
const { auth } = require('../../middleware/auth');
const { successResponse, errorResponse } = require('../../utils/response');
const { agreementUpload } = require('../../config/s3');
const { createAndDeliverNotification } = require('../../utils/notificationUtils')
const { sendEmail } = require("../../utils/SendMailer")
const router = express.Router();


// @route   POST /api/agreements/saved-agreements
// @desc    Create saved agreement
// @access  Private (Admin)
router.post("/", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();

        const {
            agreement_title,
            agreement_type,
            file_name,
            file_path,
            signature_position,
            agreement_format,
            description
        } = req.body;

        if (!agreement_title || !agreement_type) {
            return errorResponse(res, "Required fields missing", 400);
        }

        if (!["Signature", "T&C"].includes(agreement_type)) {
            return errorResponse(res, "Invalid agreement_type", 400);
        }

        // PDF agreements require a file; HTML agreements require a description
        if (agreement_format === 'pdf' && !file_name) {
            return errorResponse(res, "PDF agreements require file_name", 400);
        }

        if (agreement_format === 'html' && !description) {
            return errorResponse(res, "HTML agreements require a description", 400);
        }

        if (signature_position && typeof signature_position !== "object") {
            return errorResponse(res, "signature_position must be an object", 400);
        }

        const [result] = await mysqlConnection.execute(
            `
            INSERT INTO saved_agreements
            (
                agreement_title,
                file_name,
                file_path,
                agreement_type,
                agreement_format,
                signature_position,
                description
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            `,
            [
                agreement_title,
                file_name || 'test.pdf',
                file_path || null,
                agreement_type,
                agreement_format || null,
                signature_position ? JSON.stringify(signature_position) : null,
                description || null
            ]
        );

        return successResponse(
            res,
            { id: result.insertId },
            "Saved agreement created",
            201
        );

    } catch (error) {
        console.error("Create Saved Agreement Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

// @route   GET /api/agreements/saved-agreements
// @desc    Get all saved agreements
// @access  Private
router.get("/", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();

        const [rows] = await mysqlConnection.execute(
            `
            SELECT
                id,
                agreement_title,
                file_name,
                file_path,
                agreement_type,
                agreement_format,
                signature_position,
                status,
                description,
                uploaded_on,
                updated_at
            FROM saved_agreements
            WHERE status = 1
            ORDER BY uploaded_on DESC
            `
        );

        const data = rows.map(row => ({
            ...row,
            signature_position: row.signature_position
                ? JSON.parse(row.signature_position)
                : null
        }));

        return successResponse(res, data, "Saved agreements fetched");

    } catch (error) {
        console.error("Fetch Saved Agreements Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

// @route   GET /api/agreements/saved-agreements/:id
// @desc    Get saved agreement by ID
// @access  Private
router.get("/:id", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const { id } = req.params;

        const [rows] = await mysqlConnection.execute(
            `
            SELECT
                id,
                agreement_title,
                file_name,
                file_path,
                agreement_type,
                agreement_format,
                signature_position,
                status,
                uploaded_on,
                updated_at
            FROM saved_agreements
            WHERE id = ?
            `,
            [id]
        );

        if (!rows.length) {
            return errorResponse(res, "Saved agreement not found", 404);
        }

        const row = rows[0];
        row.signature_position = row.signature_position
            ? JSON.parse(row.signature_position)
            : null;

        return successResponse(res, row, "Saved agreement fetched");

    } catch (error) {
        console.error("Fetch Saved Agreement Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

// @route   PUT /api/agreements/saved-agreements/:id
// @desc    Update saved agreement
// @access  Private (Admin)
router.put("/:id", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const { id } = req.params;

        const {
            agreement_title,
            agreement_type,
            file_name,
            file_path,
            signature_position,
            agreement_format,
            status
        } = req.body;

        if (agreement_type && !["Signature", "T&C"].includes(agreement_type)) {
            return errorResponse(res, "Invalid agreement_type", 400);
        }

        await mysqlConnection.execute(
            `
            UPDATE saved_agreements
            SET
                agreement_title     = COALESCE(?, agreement_title),
                agreement_type      = COALESCE(?, agreement_type),
                file_name           = COALESCE(?, file_name),
                file_path           = COALESCE(?, file_path),
                agreement_format    = COALESCE(?, agreement_format),
                signature_position  = COALESCE(?, signature_position),
                status              = COALESCE(?, status)
            WHERE id = ?
            `,
            [
                agreement_title     ?? null,
                agreement_type      ?? null,
                file_name           ?? null,
                file_path           ?? null,
                agreement_format    ?? null,
                signature_position
                    ? JSON.stringify(signature_position)
                    : null,
                status              ?? null,
                id
            ]
        );

        return successResponse(res, null, "Saved agreement updated");

    } catch (error) {
        console.error("Update Saved Agreement Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

// @route   DELETE /api/agreements/saved-agreements/:id
// @desc    Deactivate saved agreement
// @access  Private (Admin)
router.delete("/:id", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const { id } = req.params;

        await mysqlConnection.execute(
            `UPDATE saved_agreements SET status = 0 WHERE id = ?`,
            [id]
        );

        return successResponse(res, null, "Saved agreement deactivated");

    } catch (error) {
        console.error("Delete Saved Agreement Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

module.exports = router;
