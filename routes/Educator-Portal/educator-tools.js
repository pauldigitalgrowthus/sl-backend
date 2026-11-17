const express = require("express");
const { auth } = require("../../middleware/auth");
const { getMySQLConnection } = require("../../config/mysql");
const { successResponse, errorResponse } = require("../../utils/response");

const router = express.Router();
const slugify = require('slugify');

const generateUniqueSlug = async (mysql, baseSlug) => {
    let slug = baseSlug;
    let counter = 1;

    while (true) {
        const [[existing]] = await mysql.execute(
            `SELECT id FROM educator_tools WHERE tool_slug = ? LIMIT 1`,
            [slug]
        );

        if (!existing) break;

        slug = `${baseSlug}-${counter}`;
        counter++;
    }

    return slug;
};


/* ============================================================
   1️⃣ CREATE EDUCATOR TOOL
   ------------------------------------------------------------
   @route   POST /api/educator/tools
   @desc    Create new educator tool
   @access  Private (Admin / Superadmin)
============================================================ */
router.post("/", auth, async (req, res) => {
    try {
        if (!["admin", "superadmin"].includes(req.user.user_type)) {
            return errorResponse(res, "Unauthorized", 403);
        }

        const {
            tool_name,
            tool_content,
            tool_type,
            display_order,
            metadata
        } = req.body;

        if (!tool_name || !tool_content) {
            return errorResponse(res, "Tool name & content are required", 400);
        }

        const mysql = getMySQLConnection();
        let baseSlug = slugify(tool_name, {
            lower: true,
            strict: true
        });

        let slug = await generateUniqueSlug(mysql, baseSlug);
        const [result] = await mysql.execute(
            `
      INSERT INTO educator_tools
      (tool_name, tool_slug, tool_content, tool_type, display_order, metadata, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
            [
                tool_name,
                slug || null,
                tool_content,
                tool_type || "general",
                display_order || 0,
                metadata ? JSON.stringify(metadata) : null,
                req.user.id
            ]
        );

        return successResponse(
            res,
            { id: result.insertId },
            "Educator tool created successfully",
            201
        );
    } catch (error) {
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   2️⃣ GET ALL EDUCATOR TOOLS
   ------------------------------------------------------------
   @route   GET /api/educator/tools
   @desc    Fetch all active educator tools
   @access  Private
============================================================ */
router.get("/", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();

        const [tools] = await mysql.execute(
            `
      SELECT *
      FROM educator_tools
      WHERE is_active = 1
        AND deleted_at IS NULL
      ORDER BY display_order ASC, created_at DESC
      `
        );

        return successResponse(
            res,
            tools,
            "Educator tools fetched successfully"
        );
    } catch (error) {
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   3️⃣ GET SINGLE TOOL
   ------------------------------------------------------------
   @route   GET /api/educator/tools/:id
   @desc    Get specific educator tool
   @access  Private
============================================================ */
router.get("/:id", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;

        const [[tool]] = await mysql.execute(
            `
      SELECT *
      FROM educator_tools
      WHERE id = ?
        AND deleted_at IS NULL
      `,
            [id]
        );

        if (!tool) {
            return errorResponse(res, "Tool not found", 404);
        }

        return successResponse(
            res,
            tool,
            "Educator tool fetched successfully"
        );
    } catch (error) {
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   4️⃣ UPDATE EDUCATOR TOOL
   ------------------------------------------------------------
   @route   PUT /api/educator/tools/:id
   @desc    Update educator tool
   @access  Private (Admin / Superadmin)
============================================================ */
router.put("/:id", auth, async (req, res) => {
    try {
        if (!["admin", "superadmin"].includes(req.user.user_type)) {
            return errorResponse(res, "Unauthorized", 403);
        }

        const { id } = req.params;
        const {
            tool_name,
            tool_content,
            tool_type,
            display_order,
            is_active,
            metadata
        } = req.body;

        const mysql = getMySQLConnection();

        const [[existing]] = await mysql.execute(
            `SELECT * FROM educator_tools WHERE id = ?`,
            [id]
        );

        if (!existing) {
            return errorResponse(res, "Tool not found", 404);
        }

        let slug = existing.tool_slug;

        if (tool_name && tool_name !== existing.tool_name) {
            let baseSlug = slugify(tool_name, {
                lower: true,
                strict: true
            });

            slug = await generateUniqueSlug(mysql, baseSlug);
        }

        await mysql.execute(
            `
      UPDATE educator_tools
      SET tool_name = ?,
          tool_slug = ?,
          tool_content = ?,
          tool_type = ?,
          display_order = ?,
          is_active = ?,
          metadata = ?,
          updated_by = ?
      WHERE id = ?
      `,
            [
                tool_name || existing.tool_name,
                slug || existing.tool_slug,
                tool_content || existing.tool_content,
                tool_type || existing.tool_type,
                display_order ?? existing.display_order,
                is_active ?? existing.is_active,
                metadata ? JSON.stringify(metadata) : existing.metadata,
                req.user.id,
                id
            ]
        );

        return successResponse(
            res,
            null,
            "Educator tool updated successfully"
        );
    } catch (error) {
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   5️⃣ DELETE EDUCATOR TOOL (SOFT DELETE)
   ------------------------------------------------------------
   @route   DELETE /api/educator/tools/:id
   @desc    Soft delete educator tool
   @access  Private (Admin / Superadmin)
============================================================ */
router.delete("/:id", auth, async (req, res) => {
    try {
        if (!["admin", "superadmin"].includes(req.user.user_type)) {
            return errorResponse(res, "Unauthorized", 403);
        }

        const { id } = req.params;
        const mysql = getMySQLConnection();

        const [[existing]] = await mysql.execute(
            `SELECT id FROM educator_tools WHERE id = ?`,
            [id]
        );

        if (!existing) {
            return errorResponse(res, "Tool not found", 404);
        }

        await mysql.execute(
            `
      UPDATE educator_tools
      SET deleted_at = NOW(), is_active = 0
      WHERE id = ?
      `,
            [id]
        );

        return successResponse(
            res,
            null,
            "Educator tool deleted successfully"
        );
    } catch (error) {
        return errorResponse(res, error.message, 500);
    }
});

module.exports = router;