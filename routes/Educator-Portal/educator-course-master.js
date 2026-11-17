const express = require("express");
const { auth } = require("../../middleware/auth");
const { getMySQLConnection } = require("../../config/mysql");
const { successResponse, errorResponse } = require("../../utils/response");

const router = express.Router();

/* ============================================================
   1️⃣ GET ALL AREAS OF EXPERTISE
   ------------------------------------------------------------
   @route   GET /api/educator/course-master/areas-of-expertise
   @desc    Get all active areas of expertise
   @access  Public
============================================================ */
router.get("/areas-of-expertise", async (req, res) => {
    try {
        const mysql = getMySQLConnection();

        const [rows] = await mysql.execute(
            `
            SELECT
                id,
                type,
                title,
                icon,
                is_active,
                sort_order,
                created_at,
                updated_at
            FROM course_master_data
            WHERE type = 'areas_of_expertise'
              AND is_active = 1
            ORDER BY sort_order ASC, title ASC
            `
        );

        return successResponse(res, rows, "Areas of expertise fetched successfully");

    } catch (error) {
        console.error("Get All Areas Of Expertise Error:", error);
        return errorResponse(res, error.message || "Internal server error", 500);
    }
});

/* ============================================================
   2️⃣ GET AREA OF EXPERTISE BY ID
   ------------------------------------------------------------
   @route   GET /api/educator/course-master/areas-of-expertise/:id
   @desc    Get single area of expertise by ID
   @access  Public
============================================================ */
router.get("/areas-of-expertise/:id", async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;

        /* ============================================================
           VALIDATION
        ============================================================ */
        if (!id || isNaN(id)) {
            return errorResponse(res, "Valid ID is required", 400);
        }

        const [[item]] = await mysql.execute(
            `
            SELECT
                id,
                type,
                title,
                icon,
                is_active,
                sort_order,
                created_at,
                updated_at
            FROM course_master_data
            WHERE id = ?
              AND type = 'areas_of_expertise'
              AND is_active = 1
            LIMIT 1
            `,
            [id]
        );

        /* ============================================================
           NOT FOUND
        ============================================================ */
        if (!item) {
            return errorResponse(res, "Area of expertise not found", 404);
        }

        return successResponse(res, item, "Area of expertise fetched successfully");

    } catch (error) {
        console.error("Get Single Area Of Expertise Error:", error);
        return errorResponse(res, error.message || "Internal server error", 500);
    }
});

/* ============================================================
   3️⃣ CREATE AREA OF EXPERTISE
   ------------------------------------------------------------
   @route   POST /api/educator/course-master/areas-of-expertise
   @desc    Create new area of expertise
   @access  Private (Admin)
============================================================ */
router.post("/areas-of-expertise", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        let { title, icon, sort_order } = req.body;

        /* ============================================================
           VALIDATION
        ============================================================ */
        if (!title || typeof title !== "string" || !title.trim()) {
            return errorResponse(res, "Title is required", 400);
        }

        title = title.trim();

        /* ============================================================
           CHECK DUPLICATE TITLE (CASE INSENSITIVE)
        ============================================================ */
        const [[existing]] = await mysql.execute(
            `
            SELECT id
            FROM course_master_data
            WHERE LOWER(title) = LOWER(?)
              AND type = 'areas_of_expertise'
            LIMIT 1
            `,
            [title]
        );

        if (existing) {
            return errorResponse(res, "Area of expertise with this title already exists", 400);
        }

        /* ============================================================
           INSERT RECORD
        ============================================================ */
        const [result] = await mysql.execute(
            `
            INSERT INTO course_master_data (
                type,
                title,
                icon,
                sort_order
            )
            VALUES ( 'areas_of_expertise', ?, ?, ? )
            `,
            [
                title,
                icon || null,
                sort_order !== undefined && !isNaN(sort_order) ? Number(sort_order) : 0
            ]
        );

        /* ============================================================
           FETCH INSERTED RECORD
        ============================================================ */
        const [[createdRecord]] = await mysql.execute(
            `SELECT * FROM course_master_data WHERE id = ? LIMIT 1`,
            [result.insertId]
        );

        return successResponse(res, createdRecord, "Area of expertise created successfully", 201);

    } catch (error) {
        console.error("Create Area Of Expertise Error:", error);
        return errorResponse(res, error.message || "Internal server error", 500);
    }
});

/* ============================================================
   4️⃣ UPDATE AREA OF EXPERTISE
   ------------------------------------------------------------
   @route   PUT /api/educator/course-master/areas-of-expertise/:id
   @desc    Update area of expertise
   @access  Private (Admin)
============================================================ */
router.put("/areas-of-expertise/:id", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;

        /* ============================================================
           VALIDATION
        ============================================================ */
        if (!id || isNaN(id)) {
            return errorResponse(res, "Valid ID is required", 400);
        }

        /* ============================================================
           FETCH EXISTING RECORD
        ============================================================ */
        const [[existing]] = await mysql.execute(
            `
            SELECT *
            FROM course_master_data
            WHERE id = ?
              AND type = 'areas_of_expertise'
            LIMIT 1
            `,
            [id]
        );

        if (!existing) {
            return errorResponse(res, "Area of expertise not found", 404);
        }

        let { title, icon, sort_order, is_active } = req.body;

        /* ============================================================
           CHECK DUPLICATE TITLE (IF CHANGED)
        ============================================================ */
        if (title && typeof title === "string" && title.trim()) {
            title = title.trim();

            const [[duplicate]] = await mysql.execute(
                `
                SELECT id
                FROM course_master_data
                WHERE LOWER(title) = LOWER(?)
                  AND type = 'areas_of_expertise'
                  AND id != ?
                LIMIT 1
                `,
                [title, id]
            );

            if (duplicate) {
                return errorResponse(res, "Area of expertise with this title already exists", 400);
            }
        }

        /* ============================================================
           UPDATE RECORD
        ============================================================ */
        await mysql.execute(
            `
            UPDATE course_master_data
            SET
                title = ?,
                icon = ?,
                sort_order = ?,
                is_active = ?
            WHERE id = ?
              AND type = 'areas_of_expertise'
            `,
            [
                title || existing.title,
                icon !== undefined ? icon : existing.icon,
                sort_order !== undefined && !isNaN(sort_order) ? Number(sort_order) : existing.sort_order,
                is_active !== undefined ? (is_active ? 1 : 0) : existing.is_active,
                id
            ]
        );

        /* ============================================================
           FETCH UPDATED RECORD
        ============================================================ */
        const [[updatedRecord]] = await mysql.execute(
            `SELECT * FROM course_master_data WHERE id = ? LIMIT 1`,
            [id]
        );

        return successResponse(res, updatedRecord, "Area of expertise updated successfully");

    } catch (error) {
        console.error("Update Area Of Expertise Error:", error);
        return errorResponse(res, error.message || "Internal server error", 500);
    }
});

/* ============================================================
   5️⃣ DELETE AREA OF EXPERTISE (SOFT DELETE)
   ------------------------------------------------------------
   @route   DELETE /api/educator/course-master/areas-of-expertise/:id
   @desc    Soft delete area of expertise
   @access  Private (Admin)
============================================================ */
router.delete("/areas-of-expertise/:id", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;

        /* ============================================================
           VALIDATION
        ============================================================ */
        if (!id || isNaN(id)) {
            return errorResponse(res, "Valid ID is required", 400);
        }

        /* ============================================================
           FETCH EXISTING RECORD
        ============================================================ */
        const [[existing]] = await mysql.execute(
            `
            SELECT id
            FROM course_master_data
            WHERE id = ?
              AND type = 'areas_of_expertise'
            LIMIT 1
            `,
            [id]
        );

        if (!existing) {
            return errorResponse(res, "Area of expertise not found", 404);
        }

        /* ============================================================
           SOFT DELETE
        ============================================================ */
        await mysql.execute(
            `
            UPDATE course_master_data
            SET is_active = 0
            WHERE id = ?
              AND type = 'areas_of_expertise'
            `,
            [id]
        );

        return successResponse(res, { id: Number(id) }, "Area of expertise soft deleted successfully");

    } catch (error) {
        console.error("Delete Area Of Expertise Error:", error);
        return errorResponse(res, error.message || "Internal server error", 500);
    }
});

/* ============================================================
   6️⃣ GET ALL TARGET AUDIENCE
   ------------------------------------------------------------
   @route   GET /api/educator/course-master/target-audience
   @desc    Get all active target audiences
   @access  Public
============================================================ */
router.get("/target-audience", async (req, res) => {
    try {
        const mysql = getMySQLConnection();

        const [rows] = await mysql.execute(
            `
            SELECT
                id,
                type,
                title,
                icon,
                is_active,
                sort_order,
                created_at,
                updated_at
            FROM course_master_data
            WHERE type = 'target_audience'
              AND is_active = 1
            ORDER BY sort_order ASC, title ASC
            `
        );

        return successResponse(res, rows, "Target audiences fetched successfully");

    } catch (error) {
        console.error("Get All Target Audience Error:", error);
        return errorResponse(res, error.message || "Internal server error", 500);
    }
});

/* ============================================================
   7️⃣ GET TARGET AUDIENCE BY ID
   ------------------------------------------------------------
   @route   GET /api/educator/course-master/target-audience/:id
   @desc    Get single target audience by ID
   @access  Public
============================================================ */
router.get("/target-audience/:id", async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;

        /* ============================================================
           VALIDATION
        ============================================================ */
        if (!id || isNaN(id)) {
            return errorResponse(res, "Valid ID is required", 400);
        }

        const [[item]] = await mysql.execute(
            `
            SELECT
                id,
                type,
                title,
                icon,
                is_active,
                sort_order,
                created_at,
                updated_at
            FROM course_master_data
            WHERE id = ?
              AND type = 'target_audience'
              AND is_active = 1
            LIMIT 1
            `,
            [id]
        );

        /* ============================================================
           NOT FOUND
        ============================================================ */
        if (!item) {
            return errorResponse(res, "Target audience not found", 404);
        }

        return successResponse(res, item, "Target audience fetched successfully");

    } catch (error) {
        console.error("Get Single Target Audience Error:", error);
        return errorResponse(res, error.message || "Internal server error", 500);
    }
});

/* ============================================================
   8️⃣ CREATE TARGET AUDIENCE
   ------------------------------------------------------------
   @route   POST /api/educator/course-master/target-audience
   @desc    Create new target audience
   @access  Private (Admin)
============================================================ */
router.post("/target-audience", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        let { title, icon, sort_order } = req.body;

        /* ============================================================
           VALIDATION
        ============================================================ */
        if (!title || typeof title !== "string" || !title.trim()) {
            return errorResponse(res, "Title is required", 400);
        }

        title = title.trim();

        /* ============================================================
           CHECK DUPLICATE TITLE (CASE INSENSITIVE)
        ============================================================ */
        const [[existing]] = await mysql.execute(
            `
            SELECT id
            FROM course_master_data
            WHERE LOWER(title) = LOWER(?)
              AND type = 'target_audience'
            LIMIT 1
            `,
            [title]
        );

        if (existing) {
            return errorResponse(res, "Target audience with this title already exists", 400);
        }

        /* ============================================================
           INSERT RECORD
        ============================================================ */
        const [result] = await mysql.execute(
            `
            INSERT INTO course_master_data (
                type,
                title,
                icon,
                sort_order
            )
            VALUES ( 'target_audience', ?, ?, ? )
            `,
            [
                title,
                icon || null,
                sort_order !== undefined && !isNaN(sort_order) ? Number(sort_order) : 0
            ]
        );

        /* ============================================================
           FETCH INSERTED RECORD
        ============================================================ */
        const [[createdRecord]] = await mysql.execute(
            `SELECT * FROM course_master_data WHERE id = ? LIMIT 1`,
            [result.insertId]
        );

        return successResponse(res, createdRecord, "Target audience created successfully", 201);

    } catch (error) {
        console.error("Create Target Audience Error:", error);
        return errorResponse(res, error.message || "Internal server error", 500);
    }
});

/* ============================================================
   9️⃣ UPDATE TARGET AUDIENCE
   ------------------------------------------------------------
   @route   PUT /api/educator/course-master/target-audience/:id
   @desc    Update target audience
   @access  Private (Admin)
============================================================ */
router.put("/target-audience/:id", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;

        /* ============================================================
           VALIDATION
        ============================================================ */
        if (!id || isNaN(id)) {
            return errorResponse(res, "Valid ID is required", 400);
        }

        /* ============================================================
           FETCH EXISTING RECORD
        ============================================================ */
        const [[existing]] = await mysql.execute(
            `
            SELECT *
            FROM course_master_data
            WHERE id = ?
              AND type = 'target_audience'
            LIMIT 1
            `,
            [id]
        );

        if (!existing) {
            return errorResponse(res, "Target audience not found", 404);
        }

        let { title, icon, sort_order, is_active } = req.body;

        /* ============================================================
           CHECK DUPLICATE TITLE (IF CHANGED)
        ============================================================ */
        if (title && typeof title === "string" && title.trim()) {
            title = title.trim();

            const [[duplicate]] = await mysql.execute(
                `
                SELECT id
                FROM course_master_data
                WHERE LOWER(title) = LOWER(?)
                  AND type = 'target_audience'
                  AND id != ?
                LIMIT 1
                `,
                [title, id]
            );

            if (duplicate) {
                return errorResponse(res, "Target audience with this title already exists", 400);
            }
        }

        /* ============================================================
           UPDATE RECORD
        ============================================================ */
        await mysql.execute(
            `
            UPDATE course_master_data
            SET
                title = ?,
                icon = ?,
                sort_order = ?,
                is_active = ?
            WHERE id = ?
              AND type = 'target_audience'
            `,
            [
                title || existing.title,
                icon !== undefined ? icon : existing.icon,
                sort_order !== undefined && !isNaN(sort_order) ? Number(sort_order) : existing.sort_order,
                is_active !== undefined ? (is_active ? 1 : 0) : existing.is_active,
                id
            ]
        );

        /* ============================================================
           FETCH UPDATED RECORD
        ============================================================ */
        const [[updatedRecord]] = await mysql.execute(
            `SELECT * FROM course_master_data WHERE id = ? LIMIT 1`,
            [id]
        );

        return successResponse(res, updatedRecord, "Target audience updated successfully");

    } catch (error) {
        console.error("Update Target Audience Error:", error);
        return errorResponse(res, error.message || "Internal server error", 500);
    }
});

/* ============================================================
   🔟 DELETE TARGET AUDIENCE (SOFT DELETE)
   ------------------------------------------------------------
   @route   DELETE /api/educator/course-master/target-audience/:id
   @desc    Soft delete target audience
   @access  Private (Admin)
============================================================ */
router.delete("/target-audience/:id", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;

        /* ============================================================
           VALIDATION
        ============================================================ */
        if (!id || isNaN(id)) {
            return errorResponse(res, "Valid ID is required", 400);
        }

        /* ============================================================
           FETCH EXISTING RECORD
        ============================================================ */
        const [[existing]] = await mysql.execute(
            `
            SELECT id
            FROM course_master_data
            WHERE id = ?
              AND type = 'target_audience'
            LIMIT 1
            `,
            [id]
        );

        if (!existing) {
            return errorResponse(res, "Target audience not found", 404);
        }

        /* ============================================================
           SOFT DELETE
        ============================================================ */
        await mysql.execute(
            `
            UPDATE course_master_data
            SET is_active = 0
            WHERE id = ?
              AND type = 'target_audience'
            `,
            [id]
        );

        return successResponse(res, { id: Number(id) }, "Target audience soft deleted successfully");

    } catch (error) {
        console.error("Delete Target Audience Error:", error);
        return errorResponse(res, error.message || "Internal server error", 500);
    }
});

/* ============================================================
   1️⃣1️⃣ GET ALL TOOLS
   ------------------------------------------------------------
   @route   GET /api/educator/course-master/tools
   @desc    Get all active tools
   @access  Public
============================================================ */
router.get("/tools", async (req, res) => {
    try {
        const mysql = getMySQLConnection();

        const [rows] = await mysql.execute(
            `
            SELECT
                id,
                type,
                title,
                icon,
                is_active,
                sort_order,
                created_at,
                updated_at
            FROM course_master_data
            WHERE type = 'tools'
              AND is_active = 1
            ORDER BY sort_order ASC, title ASC
            `
        );

        return successResponse(res, rows, "Tools fetched successfully");

    } catch (error) {
        console.error("Get All Tools Error:", error);
        return errorResponse(res, error.message || "Internal server error", 500);
    }
});

/* ============================================================
   1️⃣2️⃣ GET TOOL BY ID
   ------------------------------------------------------------
   @route   GET /api/educator/course-master/tools/:id
   @desc    Get single tool by ID
   @access  Public
============================================================ */
router.get("/tools/:id", async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;

        /* ============================================================
           VALIDATION
        ============================================================ */
        if (!id || isNaN(id)) {
            return errorResponse(res, "Valid ID is required", 400);
        }

        const [[item]] = await mysql.execute(
            `
            SELECT
                id,
                type,
                title,
                icon,
                is_active,
                sort_order,
                created_at,
                updated_at
            FROM course_master_data
            WHERE id = ?
              AND type = 'tools'
              AND is_active = 1
            LIMIT 1
            `,
            [id]
        );

        /* ============================================================
           NOT FOUND
        ============================================================ */
        if (!item) {
            return errorResponse(res, "Tool not found", 404);
        }

        return successResponse(res, item, "Tool fetched successfully");

    } catch (error) {
        console.error("Get Single Tool Error:", error);
        return errorResponse(res, error.message || "Internal server error", 500);
    }
});

/* ============================================================
   1️⃣3️⃣ CREATE TOOL
   ------------------------------------------------------------
   @route   POST /api/educator/course-master/tools
   @desc    Create new tool
   @access  Private (Admin)
============================================================ */
router.post("/tools", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        let { title, icon, sort_order } = req.body;

        /* ============================================================
           VALIDATION
        ============================================================ */
        if (!title || typeof title !== "string" || !title.trim()) {
            return errorResponse(res, "Title is required", 400);
        }

        title = title.trim();

        /* ============================================================
           CHECK DUPLICATE TITLE (CASE INSENSITIVE)
        ============================================================ */
        const [[existing]] = await mysql.execute(
            `
            SELECT id
            FROM course_master_data
            WHERE LOWER(title) = LOWER(?)
              AND type = 'tools'
            LIMIT 1
            `,
            [title]
        );

        if (existing) {
            return errorResponse(res, "Tool with this title already exists", 400);
        }

        /* ============================================================
           INSERT RECORD
        ============================================================ */
        const [result] = await mysql.execute(
            `
            INSERT INTO course_master_data (
                type,
                title,
                icon,
                sort_order
            )
            VALUES ( 'tools', ?, ?, ? )
            `,
            [
                title,
                icon || null,
                sort_order !== undefined && !isNaN(sort_order) ? Number(sort_order) : 0
            ]
        );

        /* ============================================================
           FETCH INSERTED RECORD
        ============================================================ */
        const [[createdRecord]] = await mysql.execute(
            `SELECT * FROM course_master_data WHERE id = ? LIMIT 1`,
            [result.insertId]
        );

        return successResponse(res, createdRecord, "Tool created successfully", 201);

    } catch (error) {
        console.error("Create Tool Error:", error);
        return errorResponse(res, error.message || "Internal server error", 500);
    }
});

/* ============================================================
   1️⃣4️⃣ UPDATE TOOL
   ------------------------------------------------------------
   @route   PUT /api/educator/course-master/tools/:id
   @desc    Update tool
   @access  Private (Admin)
============================================================ */
router.put("/tools/:id", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;

        /* ============================================================
           VALIDATION
        ============================================================ */
        if (!id || isNaN(id)) {
            return errorResponse(res, "Valid ID is required", 400);
        }

        /* ============================================================
           FETCH EXISTING RECORD
        ============================================================ */
        const [[existing]] = await mysql.execute(
            `
            SELECT *
            FROM course_master_data
            WHERE id = ?
              AND type = 'tools'
            LIMIT 1
            `,
            [id]
        );

        if (!existing) {
            return errorResponse(res, "Tool not found", 404);
        }

        let { title, icon, sort_order, is_active } = req.body;

        /* ============================================================
           CHECK DUPLICATE TITLE (IF CHANGED)
        ============================================================ */
        if (title && typeof title === "string" && title.trim()) {
            title = title.trim();

            const [[duplicate]] = await mysql.execute(
                `
                SELECT id
                FROM course_master_data
                WHERE LOWER(title) = LOWER(?)
                  AND type = 'tools'
                  AND id != ?
                LIMIT 1
                `,
                [title, id]
            );

            if (duplicate) {
                return errorResponse(res, "Tool with this title already exists", 400);
            }
        }

        /* ============================================================
           UPDATE RECORD
        ============================================================ */
        await mysql.execute(
            `
            UPDATE course_master_data
            SET
                title = ?,
                icon = ?,
                sort_order = ?,
                is_active = ?
            WHERE id = ?
              AND type = 'tools'
            `,
            [
                title || existing.title,
                icon !== undefined ? icon : existing.icon,
                sort_order !== undefined && !isNaN(sort_order) ? Number(sort_order) : existing.sort_order,
                is_active !== undefined ? (is_active ? 1 : 0) : existing.is_active,
                id
            ]
        );

        /* ============================================================
           FETCH UPDATED RECORD
        ============================================================ */
        const [[updatedRecord]] = await mysql.execute(
            `SELECT * FROM course_master_data WHERE id = ? LIMIT 1`,
            [id]
        );

        return successResponse(res, updatedRecord, "Tool updated successfully");

    } catch (error) {
        console.error("Update Tool Error:", error);
        return errorResponse(res, error.message || "Internal server error", 500);
    }
});

/* ============================================================
   1️⃣5️⃣ DELETE TOOL (SOFT DELETE)
   ------------------------------------------------------------
   @route   DELETE /api/educator/course-master/tools/:id
   @desc    Soft delete tool
   @access  Private (Admin)
============================================================ */
router.delete("/tools/:id", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;

        /* ============================================================
           VALIDATION
        ============================================================ */
        if (!id || isNaN(id)) {
            return errorResponse(res, "Valid ID is required", 400);
        }

        /* ============================================================
           FETCH EXISTING RECORD
        ============================================================ */
        const [[existing]] = await mysql.execute(
            `
            SELECT id
            FROM course_master_data
            WHERE id = ?
              AND type = 'tools'
            LIMIT 1
            `,
            [id]
        );

        if (!existing) {
            return errorResponse(res, "Tool not found", 404);
        }

        /* ============================================================
           SOFT DELETE
        ============================================================ */
        await mysql.execute(
            `
            UPDATE course_master_data
            SET is_active = 0
            WHERE id = ?
              AND type = 'tools'
            `,
            [id]
        );

        return successResponse(res, { id: Number(id) }, "Tool soft deleted successfully");

    } catch (error) {
        console.error("Delete Tool Error:", error);
        return errorResponse(res, error.message || "Internal server error", 500);
    }
});

/**
 * ============================================================
 * GET ALL COURSE FILTERS
 * ------------------------------------------------------------
 * @route   GET /api/educator/course-master/course-filters
 * @desc    Get all course filters
 * @access  Public
 * ============================================================
 */
router.get("/course-filters", async (req, res) => {
    try {
        const mysql = getMySQLConnection();

        const [rows] = await mysql.execute(`
            SELECT
                id,
                label,
                items,
                created_at
            FROM course_filters
            ORDER BY sort_order ASC, id ASC
        `);

        const data = rows.map(item => ({
            ...item,
            items: JSON.parse(item.items || "[]")
        }));

        return successResponse(
            res,
            data,
            "Course filters fetched successfully"
        );

    } catch (error) {
        console.error("Get Course Filters Error:", error);
        return errorResponse(res, error.message, 500);
    }
});


/**
 * ============================================================
 * GET COURSE FILTER BY ID
 * ------------------------------------------------------------
 * @route   GET /api/educator/course-master/course-filters/:id
 * @desc    Get single course filter
 * @access  Public
 * ============================================================
 */
router.get("/course-filters/:id", async (req, res) => {
    try {

        const mysql = getMySQLConnection();
        const { id } = req.params;

        if (!id || isNaN(id)) {
            return errorResponse(res, "Valid ID is required", 400);
        }
        const [[filter]] = await mysql.execute(
            `SELECT id, label, items, sort_order, created_at FROM course_filters WHERE id=? LIMIT 1`,
            [id]
        );
        if (!filter) {
            return errorResponse(res, "Course filter not found", 404);
        }
        filter.items = JSON.parse(filter.items || "[]");
        return successResponse(
            res,
            filter,
            "Course filter fetched successfully"
        );

    } catch (error) {
        console.error("Get Course Filter Error:", error);
        return errorResponse(res, error.message, 500);
    }
});


/**
 * ============================================================
 * CREATE COURSE FILTER
 * ------------------------------------------------------------
 * @route   POST /api/educator/course-master/course-filters
 * @desc    Create course filter
 * @access  Private
 * ============================================================
 */
router.post("/course-filters", auth, async (req, res) => {

    try {

        const mysql = getMySQLConnection();

        let { label, items } = req.body;

        if (!label || !label.trim()) {
            return errorResponse(res, "Label is required", 400);
        }

        if (!Array.isArray(items)) {
            return errorResponse(res, "Items must be an array", 400);
        }

        label = label.trim();

        const [[existing]] = await mysql.execute(
            `SELECT id FROM course_filters WHERE LOWER(label)=LOWER(?) LIMIT 1`,
            [label]
        );

        if (existing) {
            return errorResponse(
                res,
                "Course filter already exists",
                400
            );
        }

        const [result] = await mysql.execute(
            `
            INSERT INTO course_filters
            (
                label,
                items,
                sort_order
            )
            VALUES
            (?,?,?)
        `,
            [
                label,
                JSON.stringify(items),
                sort_order !== undefined && !isNaN(sort_order) ? Number(sort_order) : 0
            ]
        );

        const [[created]] = await mysql.execute(
            `SELECT * FROM course_filters WHERE id=?`,
            [result.insertId]
        );
        created.items = JSON.parse(created.items || "[]");
        return successResponse(
            res,
            created,
            "Course filter created successfully",
            201
        );
    } catch (error) {
        console.error(error);
        return errorResponse(res, error.message, 500);
    }

});


/**
 * ============================================================
 * UPDATE COURSE FILTER
 * ------------------------------------------------------------
 * @route   PUT /api/educator/course-master/course-filters/:id
 * @desc    Update course filter & sort_order
 * @access  Private
 * ============================================================
 */
router.put("/course-filters/:id", auth, async (req, res) => {

    try {

        const mysql = getMySQLConnection();        const { id } = req.params;
        let { label, items } = req.body;

        if (!id || isNaN(id)) {
            return errorResponse(res, "Valid ID is required", 400);
        }
        const [[existing]] = await mysql.execute(
            `SELECT * FROM course_filters WHERE id=?`,
            [id]
        );
        if (!existing) {
            return errorResponse(res, "Course filter not found", 404);
        }
        if (label) {
            const [[duplicate]] = await mysql.execute(
                `
                SELECT id
                FROM course_filters
                WHERE LOWER(label)=LOWER(?)
                AND id<>?
                LIMIT 1
            `,
                [label, id]
            );
            if (duplicate) {
                return errorResponse(
                    res,
                    "Course filter already exists",
                    400
                );
            }
        }

        await mysql.execute(
            `
            UPDATE course_filters
            SET
                label=?,
                items=?,
                sort_order=?
            WHERE id=?
        `,
            [
                label || existing.label,
                items
                    ? JSON.stringify(items)
                    : existing.items,
                sort_order !== undefined && !isNaN(sort_order) ? Number(sort_order) : (existing.sort_order ?? 0),
                id
            ]
        );
        const [[updated]] = await mysql.execute(
            `SELECT * FROM course_filters WHERE id=?`,
            [id]
        );
        updated.items = JSON.parse(updated.items || "[]");
        return successResponse(
            res,
            updated,
            "Course filter updated successfully"
        );
    } catch (error) {
        console.error(error);
        return errorResponse(res, error.message, 500);
    }
});
/**
 * ============================================================
 * DELETE COURSE FILTER
 * ------------------------------------------------------------
 * @route   DELETE /api/educator/course-master/course-filters/:id
 * @desc    Delete course filter
 * @access  Private
 * ============================================================
 */
router.delete("/course-filters/:id", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;
        if (!id || isNaN(id)) {
            return errorResponse(res, "Valid ID is required", 400);
        }
        const [result] = await mysql.execute(
            `DELETE FROM course_filters WHERE id=?`,
            [id]
        );
        if (!result.affectedRows) {
            return errorResponse(
                res,
                "Course filter not found",
                404
            );
        }
        return successResponse(
            res,
            { id: Number(id) },
            "Course filter deleted successfully"
        );
    } catch (error) {
        console.error(error);
        return errorResponse(res, error.message, 500);
    }
});
module.exports = router;