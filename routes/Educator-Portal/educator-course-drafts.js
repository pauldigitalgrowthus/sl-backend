const express = require("express");
const { auth } = require("../../middleware/auth");
const { getMySQLConnection } = require("../../config/mysql");
const { successResponse, errorResponse } = require("../../utils/response");

const router = express.Router();

/* ============================================================
   1️⃣ GET MY COURSE DRAFT
   ------------------------------------------------------------
   @route   GET /api/educator/course-drafts/my
   @desc    Get logged-in user's course draft
   @access  Private (User)
============================================================ */
router.get("/my", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();

        const [[draft]] = await mysql.execute(
            `
            SELECT
                d.*,
                u.first_name,
                u.last_name,
                u.email AS user_email
            FROM course_drafts d
            LEFT JOIN users u
                ON d.user_id = u.id
            WHERE d.user_id = ?
            LIMIT 1
            `,
            [req.user.id]
        );

        /* ============================================================
           NOT FOUND
        ============================================================ */
        if (!draft) {
            return errorResponse(res, "No course draft found", 404);
        }

        /* ============================================================
           SAFE JSON PARSER
        ============================================================ */
        const parseJSON = (value, defaultValue = {}) => {
            try {
                if (!value) return defaultValue;
                return typeof value === "string" ? JSON.parse(value) : value;
            } catch (err) {
                return defaultValue;
            }
        };

        /* ============================================================
           FORMAT RESPONSE
        ============================================================ */
        const formattedDraft = {
            ...draft,
            draft_data: parseJSON(draft.draft_data)
        };

        return successResponse(res, formattedDraft, "Your course draft fetched successfully");

    } catch (error) {
        console.error("Get My Course Draft Error:", error);
        return errorResponse(res, error.message || "Internal server error", 500);
    }
});

/* ============================================================
   2️⃣ SAVE OR UPDATE COURSE DRAFT
   ------------------------------------------------------------
   @route   POST /api/educator/course-drafts
   @desc    Save or update logged-in user's course draft
   @access  Private (User)
============================================================ */
router.post("", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        let { draft_data } = req.body;

        /* ============================================================
           VALIDATION
        ============================================================ */
        if (!draft_data) {
            return errorResponse(res, "Draft data is required", 400);
        }

        /* ============================================================
           PARSE / STRINGIFY DRAFT DATA
        ============================================================ */
        let preparedDraftData;
        try {
            if (typeof draft_data === "object") {
                preparedDraftData = JSON.stringify(draft_data);
            } else if (typeof draft_data === "string") {
                // Ensure valid JSON string
                JSON.parse(draft_data);
                preparedDraftData = draft_data;
            } else {
                return errorResponse(res, "Invalid draft data format", 400);
            }
        } catch (jsonError) {
            return errorResponse(res, "Invalid JSON format in draft data", 400);
        }

        /* ============================================================
           CHECK EXISTING DRAFT
        ============================================================ */
        const [[existing]] = await mysql.execute(
            `
            SELECT id
            FROM course_drafts
            WHERE user_id = ?
            LIMIT 1
            `,
            [req.user.id]
        );

        let draftId;

        if (existing) {
            /* ============================================================
               UPDATE DRAFT
            ============================================================ */
            await mysql.execute(
                `
                UPDATE course_drafts
                SET
                    draft_data = ?,
                    saved_at = CURRENT_TIMESTAMP
                WHERE user_id = ?
                `,
                [preparedDraftData, req.user.id]
            );
            draftId = existing.id;
        } else {
            /* ============================================================
               INSERT DRAFT
            ============================================================ */
            const [result] = await mysql.execute(
                `
                INSERT INTO course_drafts (
                    user_id,
                    draft_data
                )
                VALUES ( ?, ? )
                `,
                [req.user.id, preparedDraftData]
            );
            draftId = result.insertId;
        }

        /* ============================================================
           FETCH SAVED DRAFT
        ============================================================ */
        const [[savedDraft]] = await mysql.execute(
            `SELECT * FROM course_drafts WHERE id = ? LIMIT 1`,
            [draftId]
        );

        /* ============================================================
           SAFE JSON PARSER
        ============================================================ */
        const parseJSON = (value, defaultValue = {}) => {
            try {
                if (!value) return defaultValue;
                return typeof value === "string" ? JSON.parse(value) : value;
            } catch (err) {
                return defaultValue;
            }
        };

        const formattedResponse = {
            ...savedDraft,
            draft_data: parseJSON(savedDraft.draft_data)
        };

        return successResponse(
            res,
            formattedResponse,
            existing ? "Course draft updated successfully" : "Course draft saved successfully",
            existing ? 200 : 201
        );

    } catch (error) {
        console.error("Save Course Draft Error:", error);
        return errorResponse(res, error.message || "Internal server error", 500);
    }
});

/* ============================================================
   3️⃣ GET SINGLE COURSE DRAFT BY ID
   ------------------------------------------------------------
   @route   GET /api/educator/course-drafts/:id
   @desc    Get single course draft by ID
   @access  Private (Owner or Admin)
============================================================ */
router.get("/:id", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;

        /* ============================================================
           VALIDATION
        ============================================================ */
        if (!id || isNaN(id)) {
            return errorResponse(res, "Valid draft ID is required", 400);
        }

        /* ============================================================
           FETCH DRAFT
        ============================================================ */
        const [[draft]] = await mysql.execute(
            `
            SELECT
                d.*,
                u.first_name,
                u.last_name,
                u.email AS user_email
            FROM course_drafts d
            LEFT JOIN users u
                ON d.user_id = u.id
            WHERE d.id = ?
            LIMIT 1
            `,
            [id]
        );

        /* ============================================================
           NOT FOUND
        ============================================================ */
        if (!draft) {
            return errorResponse(res, "Course draft not found", 404);
        }

        /* ============================================================
           AUTHORIZATION
        ============================================================ */
        const isAdmin = ["admin", "superadmin"].includes(req.user.user_type);
        const isOwner = Number(draft.user_id) === Number(req.user.id);

        if (!isOwner && !isAdmin) {
            return errorResponse(res, "Unauthorized access", 403);
        }

        /* ============================================================
           SAFE JSON PARSER
        ============================================================ */
        const parseJSON = (value, defaultValue = {}) => {
            try {
                if (!value) return defaultValue;
                return typeof value === "string" ? JSON.parse(value) : value;
            } catch (err) {
                return defaultValue;
            }
        };

        const formattedDraft = {
            ...draft,
            draft_data: parseJSON(draft.draft_data)
        };

        return successResponse(res, formattedDraft, "Course draft fetched successfully");

    } catch (error) {
        console.error("Get Single Course Draft Error:", error);
        return errorResponse(res, error.message || "Internal server error", 500);
    }
});

/* ============================================================
   4️⃣ DELETE COURSE DRAFT
   ------------------------------------------------------------
   @route   DELETE /api/educator/course-drafts/:id
   @desc    Delete course draft
   @access  Private (Owner or Admin)
============================================================ */
router.delete("/:id", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;

        /* ============================================================
           VALIDATION
        ============================================================ */
        if (!id || isNaN(id)) {
            return errorResponse(res, "Valid draft ID is required", 400);
        }

        /* ============================================================
           FETCH EXISTING DRAFT
        ============================================================ */
        const [[existing]] = await mysql.execute(
            `
            SELECT id, user_id
            FROM course_drafts
            WHERE id = ?
            LIMIT 1
            `,
            [id]
        );

        if (!existing) {
            return errorResponse(res, "Course draft not found", 404);
        }

        /* ============================================================
           AUTHORIZATION
        ============================================================ */
        const isAdmin = ["admin", "superadmin"].includes(req.user.user_type);
        const isOwner = Number(existing.user_id) === Number(req.user.id);

        if (!isOwner && !isAdmin) {
            return errorResponse(res, "Unauthorized access", 403);
        }

        /* ============================================================
           DELETE RECORD
        ============================================================ */
        await mysql.execute(
            `
            DELETE FROM course_drafts
            WHERE id = ?
            `,
            [id]
        );

        return successResponse(res, { id: Number(id) }, "Course draft deleted successfully");

    } catch (error) {
        console.error("Delete Course Draft Error:", error);
        return errorResponse(res, error.message || "Internal server error", 500);
    }
});

module.exports = router;