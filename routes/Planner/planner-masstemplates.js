const express = require("express");
const { getMySQLConnection } = require("../../config/mysql");
const { successResponse, errorResponse } = require("../../utils/response");

const router = express.Router();

const TABLE_NAME = "planner_mass_templates";
const CATEGORIES_TABLE = "planner_mass_template_categories";

/**
 * --------------------------------------------------------
 * Categories ab hardcoded nahi, DB se dynamic aate hain.
 * planner_mass_template_categories table se fetch karte hain.
 * --------------------------------------------------------
 */
const getAllowedCategories = async (db) => {
    const [rows] = await db.execute(
        `SELECT category_key FROM ${CATEGORIES_TABLE} ORDER BY display_order ASC, id ASC`
    );
    return rows.map((r) => r.category_key);
};

/**
 * --------------------------------------------------------
 * Flatten frontend payload -> DB rows
 * --------------------------------------------------------
 * Input shape (same as MASS_TEMPLATE_CATEGORIES):
 * {
 *   direct: [ { id: 'sunday', name: 'Sunday Mass', template: {...} }, ... ],
 *   wedding: [...],
 *   funeral: [...],
 *   other: [...],
 *   ...any dynamic category...
 * }
 */
const flattenCategories = (payload, allowedCategories) => {
    const rows = [];

    for (const category of Object.keys(payload)) {
        if (!allowedCategories.includes(category)) continue;

        const items = payload[category];
        if (!Array.isArray(items)) continue;

        items.forEach((item, index) => {
            if (!item || typeof item !== "object") return;
            if (!item.id || !item.name || !item.template) return;

            rows.push({
                category,
                template_key: String(item.id),
                name: item.name,
                template_data: item.template,
                display_order:
                    typeof item.display_order === "number"
                        ? item.display_order
                        : index,
            });
        });
    }

    return rows;
};

/**
 * --------------------------------------------------------
 * DB rows -> original MASS_TEMPLATE_CATEGORIES format
 * --------------------------------------------------------
 */
const transformToOriginalFormat = (rows, allowedCategories) => {
    const result = {};
    allowedCategories.forEach((cat) => {
        result[cat] = [];
    });

    rows
        .sort((a, b) => a.display_order - b.display_order || a.id - b.id)
        .forEach((row) => {
            if (!result[row.category]) return;

            result[row.category].push({
                id: row.template_key,
                name: row.name,
                template:
                    typeof row.template_data === "string"
                        ? JSON.parse(row.template_data)
                        : row.template_data,
            });
        });

    return result;
};

/**
 * ============================================================
 * CATEGORIES CRUD
 * ============================================================
 */

// GET /api/planners/mass-templates/categories
router.get("/categories", async (req, res) => {
    try {
        const db = getMySQLConnection();

        const [rows] = await db.execute(
            `SELECT * FROM ${CATEGORIES_TABLE} ORDER BY display_order ASC, id ASC`
        );

        return successResponse(res, rows, "Categories fetched successfully");
    } catch (err) {
        console.error(err);
        return errorResponse(res, "Failed to fetch categories");
    }
});

// POST /api/planners/mass-templates/categories
// Body: { category_key, label, display_order? }
router.post("/categories", async (req, res) => {
    try {
        const { category_key, label, display_order } = req.body;

        if (!category_key || !label) {
            return errorResponse(res, "category_key and label are required", 400);
        }

        const db = getMySQLConnection();

        await db.execute(
            `INSERT INTO ${CATEGORIES_TABLE} (category_key, label, display_order)
             VALUES (?, ?, ?)`,
            [
                String(category_key),
                label,
                typeof display_order === "number" ? display_order : 0,
            ]
        );

        return successResponse(res, null, "Category created successfully");
    } catch (err) {
        console.error(err);
        if (err.code === "ER_DUP_ENTRY") {
            return errorResponse(res, "Category key already exists", 400);
        }
        return errorResponse(res, "Failed to create category");
    }
});

// PUT /api/planners/mass-templates/categories/:id
// Body: { label?, display_order?, category_key? }
router.put("/categories/:id", async (req, res) => {
    try {
        const { label, display_order, category_key } = req.body;

        const fields = [];
        const values = [];

        if (label) {
            fields.push("label = ?");
            values.push(label);
        }
        if (typeof display_order === "number") {
            fields.push("display_order = ?");
            values.push(display_order);
        }
        if (category_key) {
            fields.push("category_key = ?");
            values.push(String(category_key));
        }

        if (!fields.length) {
            return errorResponse(res, "Nothing to update", 400);
        }

        values.push(req.params.id);

        const db = getMySQLConnection();

        const [result] = await db.execute(
            `UPDATE ${CATEGORIES_TABLE} SET ${fields.join(", ")} WHERE id = ?`,
            values
        );

        if (!result.affectedRows) {
            return errorResponse(res, "Category not found", 404);
        }

        return successResponse(res, null, "Category updated successfully");
    } catch (err) {
        console.error(err);
        if (err.code === "ER_DUP_ENTRY") {
            return errorResponse(res, "Category key already exists", 400);
        }
        return errorResponse(res, "Failed to update category");
    }
});

// DELETE /api/planners/mass-templates/categories/:id
// Note: category ke andar agar templates already hain to unhe pehle
// dusri category me move karo ya delete karo, warna consistency issue aayega.
router.delete("/categories/:id", async (req, res) => {
    try {
        const db = getMySQLConnection();

        const [[category]] = await db.execute(
            `SELECT category_key FROM ${CATEGORIES_TABLE} WHERE id = ?`,
            [req.params.id]
        );

        if (!category) {
            return errorResponse(res, "Category not found", 404);
        }

        const [[{ cnt }]] = await db.execute(
            `SELECT COUNT(*) as cnt FROM ${TABLE_NAME} WHERE category = ?`,
            [category.category_key]
        );

        if (cnt > 0) {
            return errorResponse(
                res,
                "Cannot delete category with existing templates. Move or delete those templates first.",
                400
            );
        }

        const [result] = await db.execute(
            `DELETE FROM ${CATEGORIES_TABLE} WHERE id = ?`,
            [req.params.id]
        );

        if (!result.affectedRows) {
            return errorResponse(res, "Category not found", 404);
        }

        return successResponse(res, null, "Category deleted successfully");
    } catch (err) {
        console.error(err);
        return errorResponse(res, "Failed to delete category");
    }
});

/**
 * ============================================================
 * CREATE TEMPLATES
 * POST /api/planners/mass-templates
 * Body: same shape as MASS_TEMPLATE_CATEGORIES (full or partial)
 * ============================================================
 */
router.post("/", async (req, res) => {
    try {
        const payload = req.body;

        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            return errorResponse(
                res,
                "Payload must be an object keyed by category",
                400
            );
        }

        const db = getMySQLConnection();
        const allowedCategories = await getAllowedCategories(db);

        const rows = flattenCategories(payload, allowedCategories);

        if (!rows.length) {
            return errorResponse(res, "No valid templates found in payload", 400);
        }

        for (const row of rows) {
            await db.execute(
                `INSERT INTO ${TABLE_NAME}
                    (category, template_key, name, template_data, display_order)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    name = VALUES(name),
                    template_data = VALUES(template_data),
                    display_order = VALUES(display_order)`,
                [
                    row.category,
                    row.template_key,
                    row.name,
                    JSON.stringify(row.template_data),
                    row.display_order,
                ]
            );
        }

        return successResponse(res, null, "Templates created successfully");
    } catch (err) {
        console.error(err);
        return errorResponse(res, "Failed to create templates");
    }
});

/**
 * ============================================================
 * REPLACE ALL TEMPLATES
 * PUT /api/planners/mass-templates/update-templates
 * Body: full MASS_TEMPLATE_CATEGORIES object
 * ============================================================
 */
router.put("/update-templates", async (req, res) => {
    try {
        const payload = req.body;

        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            return errorResponse(
                res,
                "Payload must be an object keyed by category",
                400
            );
        }

        const db = getMySQLConnection();
        const allowedCategories = await getAllowedCategories(db);

        const rows = flattenCategories(payload, allowedCategories);

        if (!rows.length) {
            return errorResponse(res, "No valid templates found in payload", 400);
        }

        await db.execute(`TRUNCATE TABLE ${TABLE_NAME}`);

        for (const row of rows) {
            await db.execute(
                `INSERT INTO ${TABLE_NAME}
                    (category, template_key, name, template_data, display_order)
                 VALUES (?, ?, ?, ?, ?)`,
                [
                    row.category,
                    row.template_key,
                    row.name,
                    JSON.stringify(row.template_data),
                    row.display_order,
                ]
            );
        }

        return successResponse(res, null, "Templates replaced successfully");
    } catch (err) {
        console.error(err);
        return errorResponse(res, "Failed to update templates");
    }
});

/**
 * ============================================================
 * GET ORIGINAL FORMAT (what the frontend actually consumes,
 * same shape as MASS_TEMPLATE_CATEGORIES)
 * GET /api/planners/mass-templates/get-templates
 * ============================================================
 */
router.get("/get-templates", async (req, res) => {
    try {
        const db = getMySQLConnection();
        const allowedCategories = await getAllowedCategories(db);

        const [rows] = await db.execute(`
            SELECT id, category, template_key, name, template_data, display_order
            FROM ${TABLE_NAME}
            ORDER BY category ASC, display_order ASC, id ASC
        `);

        return successResponse(
            res,
            transformToOriginalFormat(rows, allowedCategories),
            "Templates fetched successfully"
        );
    } catch (err) {
        console.error(err);
        return errorResponse(res, "Failed to fetch templates");
    }
});

/**
 * ============================================================
 * ADMIN LIST (flat, raw rows — for a management/admin table UI)
 * GET /api/planners/mass-templates/get-list
 * ============================================================
 */
router.get("/get-list", async (req, res) => {
    try {
        const db = getMySQLConnection();

        const [rows] = await db.execute(`
            SELECT *
            FROM ${TABLE_NAME}
            ORDER BY category ASC, display_order ASC, id DESC
        `);

        const data = rows.map((row) => ({
            ...row,
            template_data:
                typeof row.template_data === "string"
                    ? JSON.parse(row.template_data)
                    : row.template_data,
        }));

        return successResponse(res, data, "Template list fetched");
    } catch (err) {
        console.error(err);
        return errorResponse(res, "Failed to fetch list");
    }
});

/**
 * ============================================================
 * GET SINGLE TEMPLATE
 * GET /api/planners/mass-templates/template/:id
 * ============================================================
 */
router.get("/template/:id", async (req, res) => {
    try {
        const db = getMySQLConnection();

        const [rows] = await db.execute(
            `SELECT * FROM ${TABLE_NAME} WHERE id = ?`,
            [req.params.id]
        );

        if (!rows.length) {
            return errorResponse(res, "Template not found", 404);
        }

        const row = rows[0];

        row.template_data =
            typeof row.template_data === "string"
                ? JSON.parse(row.template_data)
                : row.template_data;

        return successResponse(res, row, "Template fetched");
    } catch (err) {
        console.error(err);
        return errorResponse(res, "Failed");
    }
});

/**
 * ============================================================
 * UPDATE SINGLE TEMPLATE
 * PUT /api/planners/mass-templates/update-template/:id
 * Body: { name, template, category?, display_order? }
 * (template = the { mass_template_data: { sections: [...] } } object)
 * ============================================================
 */
router.put("/update-template/:id", async (req, res) => {
    try {
        const { name, template, category, display_order } = req.body;

        if (!name || !template || typeof template !== "object") {
            return errorResponse(
                res,
                "name and template are required",
                400
            );
        }

        const db = getMySQLConnection();

        if (category) {
            const allowedCategories = await getAllowedCategories(db);
            if (!allowedCategories.includes(category)) {
                return errorResponse(res, "Invalid category", 400);
            }
        }

        const fields = ["name = ?", "template_data = ?"];
        const values = [name, JSON.stringify(template)];

        if (category) {
            fields.push("category = ?");
            values.push(category);
        }

        if (typeof display_order === "number") {
            fields.push("display_order = ?");
            values.push(display_order);
        }

        values.push(req.params.id);

        const [result] = await db.execute(
            `UPDATE ${TABLE_NAME} SET ${fields.join(", ")} WHERE id = ?`,
            values
        );

        if (!result.affectedRows) {
            return errorResponse(res, "Template not found", 404);
        }

        return successResponse(res, null, "Template updated successfully");
    } catch (err) {
        console.error(err);
        return errorResponse(res, "Failed to update template");
    }
});

/**
 * ============================================================
 * DELETE TEMPLATE
 * DELETE /api/planners/mass-templates/delete-template/:id
 * ============================================================
 */
router.delete("/delete-template/:id", async (req, res) => {
    try {
        const db = getMySQLConnection();

        const [result] = await db.execute(
            `DELETE FROM ${TABLE_NAME} WHERE id = ?`,
            [req.params.id]
        );

        if (!result.affectedRows) {
            return errorResponse(res, "Template not found", 404);
        }

        return successResponse(res, null, "Template deleted successfully");
    } catch (err) {
        console.error(err);
        return errorResponse(res, "Failed to delete template");
    }
});

module.exports = router;