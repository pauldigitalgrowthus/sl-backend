const express = require("express");
const { getMySQLConnection } = require("../../config/mysql");
const { successResponse, errorResponse } = require("../../utils/response");

const router = express.Router();

const TABLE_NAME = "planner_massparts";

/**
 * --------------------------------------------------------
 * Convert DB JSON back to original format
 * --------------------------------------------------------
 */
const transformToOriginalFormat = (rows) =>
    rows.map((row) =>
        typeof row.full_path === "string"
            ? JSON.parse(row.full_path)
            : row.full_path
    );

/**
 * --------------------------------------------------------
 * Normalize Payload
 * --------------------------------------------------------
 */

function normalizeWithDepth(data, depth = 0) {
    if (typeof data === "string") {
        return data;
    }

    if (Array.isArray(data)) {
        const isAllStrings = data.every(
            (item) => typeof item === "string"
        );

        if (isAllStrings && depth <= 3) {
            return data.map((str) => ({
                [str]: [],
            }));
        }

        return data.map((item) =>
            normalizeWithDepth(item, depth + 1)
        );
    }

    if (typeof data === "object" && data !== null) {
        const result = {};

        for (const key in data) {
            result[key] = normalizeWithDepth(
                data[key],
                depth + 1
            );
        }

        return result;
    }

    return data;
}

/**
 * ============================================================
 * CREATE FILTERS
 * POST /mass-filters
 * ============================================================
 */

router.post("/", async (req, res) => {
    try {
        const filters = req.body;
        if (!Array.isArray(filters)) {
            return errorResponse(res, "Filters must be an array", 400);
        }
        const db = getMySQLConnection();
        for (const item of filters) {
            if (!item || typeof item !== "object") continue;
            const name = Object.keys(item)[0];
            const normalized = normalizeWithDepth(item);
            await db.execute(
                `INSERT INTO ${TABLE_NAME} (name, full_path)
                 VALUES (?, ?)`,
                [name, JSON.stringify(normalized)]
            );
        }

        return successResponse(res, null, "Filters created successfully");
    } catch (err) {
        console.error(err);
        return errorResponse(res, "Failed to create filters");
    }
});

/**
 * ============================================================
 * REPLACE ALL FILTERS
 * PUT /mass-filters/update-filters
 * ============================================================
 */

router.put("/update-filters", async (req, res) => {
    try {
        const filters = req.body;

        if (!Array.isArray(filters)) {
            return errorResponse(
                res,
                "Filters must be an array",
                400
            );
        }

        const db = getMySQLConnection();

        await db.execute(`TRUNCATE TABLE ${TABLE_NAME}`);

        for (const item of filters) {
            if (!item || typeof item !== "object") continue;

            const name = Object.keys(item)[0];

            const normalized = normalizeWithDepth(item);

            await db.execute(
                `INSERT INTO ${TABLE_NAME}
                (name,full_path)
                VALUES (?,?)`,
                [name, JSON.stringify(normalized)]
            );
        }

        return successResponse(
            res,
            null,
            "Filters replaced successfully"
        );
    } catch (err) {
        console.error(err);
        return errorResponse(res, "Failed to update filters");
    }
});

/**
 * ============================================================
 * GET ORIGINAL FORMAT
 * GET /mass-filters/get-filters
 * ============================================================
 */

router.get("/get-filters", async (req, res) => {
    try {
        const db = getMySQLConnection();

        const [rows] = await db.execute(`
            SELECT id,name,full_path,created_at
            FROM ${TABLE_NAME}
            ORDER BY id ASC
        `);

        return successResponse(
            res,
            transformToOriginalFormat(rows),
            "Filters fetched successfully"
        );
    } catch (err) {
        console.error(err);
        return errorResponse(res, "Failed to fetch filters");
    }
});

/**
 * ============================================================
 * ADMIN LIST
 * GET /mass-filters/get-list
 * ============================================================
 */

router.get("/get-list", async (req, res) => {
    try {
        const db = getMySQLConnection();

        const [rows] = await db.execute(`
            SELECT *
            FROM ${TABLE_NAME}
            ORDER BY id DESC
        `);

        const data = rows.map((row) => ({
            ...row,
            full_path:
                typeof row.full_path === "string"
                    ? JSON.parse(row.full_path)
                    : row.full_path,
        }));

        return successResponse(
            res,
            data,
            "Filter list fetched"
        );
    } catch (err) {
        console.error(err);
        return errorResponse(res, "Failed to fetch list");
    }
});

/**
 * ============================================================
 * GET SINGLE FILTER
 * GET /mass-filters/filter/:id
 * ============================================================
 */

router.get("/filter/:id", async (req, res) => {
    try {
        const db = getMySQLConnection();

        const [rows] = await db.execute(
            `SELECT *
             FROM ${TABLE_NAME}
             WHERE id=?`,
            [req.params.id]
        );

        if (!rows.length) {
            return errorResponse(res, "Filter not found", 404);
        }

        const row = rows[0];

        row.full_path =
            typeof row.full_path === "string"
                ? JSON.parse(row.full_path)
                : row.full_path;

        return successResponse(
            res,
            row,
            "Filter fetched"
        );
    } catch (err) {
        console.error(err);
        return errorResponse(res, "Failed");
    }
});

/**
 * ============================================================
 * UPDATE SINGLE FILTER
 * PUT /mass-filters/update-filter/:id
 * ============================================================
 */

router.put("/update-filter/:id", async (req, res) => {
    try {
        const filter = req.body;

        if (!filter || typeof filter !== "object") {
            return errorResponse(
                res,
                "Invalid payload",
                400
            );
        }

        const db = getMySQLConnection();

        const name = Object.keys(filter)[0];

        const normalized = normalizeWithDepth(filter);

        const [result] = await db.execute(
            `UPDATE ${TABLE_NAME}
            SET
                name=?,
                full_path=?
            WHERE id=?`,
            [
                name,
                JSON.stringify(normalized),
                req.params.id,
            ]
        );

        if (!result.affectedRows) {
            return errorResponse(
                res,
                "Filter not found",
                404
            );
        }

        return successResponse(
            res,
            null,
            "Filter updated successfully"
        );
    } catch (err) {
        console.error(err);
        return errorResponse(
            res,
            "Failed to update filter"
        );
    }
});

/**
 * ============================================================
 * DELETE FILTER
 * DELETE /mass-filters/delete-filter/:id
 * ============================================================
 */

router.delete("/delete-filter/:id", async (req, res) => {
    try {
        const db = getMySQLConnection();

        const [result] = await db.execute(
            `DELETE
             FROM ${TABLE_NAME}
             WHERE id=?`,
            [req.params.id]
        );

        if (!result.affectedRows) {
            return errorResponse(
                res,
                "Filter not found",
                404
            );
        }

        return successResponse(
            res,
            null,
            "Filter deleted successfully"
        );
    } catch (err) {
        console.error(err);
        return errorResponse(
            res,
            "Failed to delete filter"
        );
    }
});

module.exports = router;