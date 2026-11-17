const express = require('express');
const { auth } = require('../middleware/auth');
const { getMySQLConnection } = require('../config/mysql');
const { successResponse, errorResponse } = require('../utils/response');
const router = express.Router();

const transformToOriginalFormat2 = (rows) => {
    const result = [];

    for (const row of rows) {
        const parsed =
            typeof row.full_path === 'string'
                ? JSON.parse(row.full_path)
                : row.full_path;

        result.push(parsed);
    }

    return result;
};

function normalizeWithDepth(data, depth = 0) {
    // STRING
    if (typeof data === "string") {
        return data;
    }

    // ARRAY
    if (Array.isArray(data)) {
        // Agar array sirf strings ka hai
        const isAllStrings = data.every(item => typeof item === "string");

        // ✅ Convert only if depth <= 3
        if (isAllStrings && depth <= 3) {
            return data.map(str => ({ [str]: [] }));
        }

        // ❌ Deeper level → keep as-is (but recurse)
        return data.map(item => normalizeWithDepth(item, depth + 1));
    }

    // OBJECT
    if (typeof data === "object" && data !== null) {
        const result = {};
        for (const key in data) {
            result[key] = normalizeWithDepth(data[key], depth + 1);
        }
        return result;
    }

    return data;
}

const deepMerge = (oldData, newData) => {
    if (Array.isArray(oldData) && Array.isArray(newData)) {
        const merged = [...oldData];

        newData.forEach(newItem => {
            const exists = merged.some(
                oldItem => JSON.stringify(oldItem) === JSON.stringify(newItem)
            );
            if (!exists) merged.push(newItem);
        });

        return merged;
    }

    if (typeof oldData === 'object' && typeof newData === 'object') {
        const result = { ...oldData };

        for (const key of Object.keys(newData)) {
            result[key] = result[key]
                ? deepMerge(result[key], newData[key])
                : newData[key];
        }

        return result;
    }

    return newData;
};


/**
 * ============================================================
 * POST /api/filters/create-filters
 * ============================================================
 * Create new filters with fully nested JSON structure
 *
 * Request Body:
 * [
 *   { "Year A": [ { "Advent (Year A)": ["First Sunday"] } ] },
 *   { "Liturgical Season": ["Advent", "Christmas"] }
 * ]
 *
 * Behavior:
 * - Accepts an array of nested filter objects
 * - Stores each top-level object as one DB row
 *
 * Access: Public (add auth middleware if required)
 */
router.post('/create-filters', async (req, res) => {
    try {
        const filters = req.body;

        if (!Array.isArray(filters)) {
            return errorResponse(res, 'Filters must be an array', 400);
        }

        const db = getMySQLConnection();

        for (const item of filters) {
            if (typeof item !== 'object' || item === null) {
                continue;
            }

            const name = Object.keys(item)[0];

            // 🔥 Normalize BEFORE saving
            const normalizedData = normalizeWithDepth(item);

            await db.execute(
                `INSERT INTO filters (name, full_path) VALUES (?, ?)`,
                [name, JSON.stringify(normalizedData)]
            );
        }

        successResponse(res, null, 'Filters created successfully');
    } catch (error) {
        console.error('Create Filters Error:', error);
        errorResponse(res, 'Failed to create filters');
    }
});

/**
 * ============================================================
 * PUT /api/filters/update-filters
 * ============================================================
 * FULL REPLACE filters
 * - Deletes ALL existing filters
 * - Resets ID from 1
 * - Recreates filters from payload
 * - SAME format as create-filters
 */
router.put('/update-filters', async (req, res) => {
    try {
        const filters = req.body;

        // ✅ Same validation as create-filters
        if (!Array.isArray(filters)) {
            return errorResponse(res, 'Filters must be an array', 400);
        }

        const db = getMySQLConnection();
        const reverseFilters = filters.slice().reverse();

        // 🔥 STEP 1: DELETE ALL + RESET AUTO_INCREMENT
        await db.execute('TRUNCATE TABLE filters');

        // 🔥 STEP 2: INSERT AGAIN (same as create-filters)
        for (const item of reverseFilters) {
            if (typeof item !== 'object' || item === null) continue;

            const name = Object.keys(item)[0];

            // normalize exactly like create
            const normalizedData = normalizeWithDepth(item);

            await db.execute(
                'INSERT INTO filters (name, full_path) VALUES (?, ?)',
                [name, JSON.stringify(normalizedData)]
            );
        }

        successResponse(res, null, 'Filters replaced successfully');
    } catch (error) {
        console.error('Update Filters Error:', error);
        errorResponse(res, 'Failed to update filters');
    }
});


/**
 * ============================================================
 * GET /api/filters/get-filters
 * ============================================================
 * Fetch filters in original nested array format
 *
 * Response:
 * [
 *   { "Year A": [ ... ] },
 *   { "Liturgical Season": [ ... ] }
 * ]
 *
 * Behavior:
 * - Reads all filters from DB
 * - Transforms JSON back to original structure
 *
 * Access: Public
 */
router.get('/get-filters', async (req, res) => {
    try {
        const db = getMySQLConnection();

        const [rows] = await db.execute(`
        SELECT id, name, full_path, created_at
        FROM filters
        ORDER BY id ASC
      `);

        const originalFormat = transformToOriginalFormat2(rows);

        successResponse(
            res,
            originalFormat,
            'Filters retrieved in original format'
        );
    } catch (error) {
        console.error(error);
        errorResponse(res, 'Failed to fetch filters');
    }
});



/**
 * ============================================================
 * GET /api/filters/get-list
 * ============================================================
 * Fetch raw filter records from database
 *
 * Response:
 * [
 *   {
 *     id: 1,
 *     name: "Year A",
 *     full_path: {...},
 *     created_at: "2026-01-09T..."
 *   }
 * ]
 *
 * Use case:
 * - Admin panel
 * - Debugging
 * - Edit/Delete operations
 *
 * Access: Public
 */
router.get('/get-list', async (req, res) => {
    try {
        const db = getMySQLConnection();

        const [rows] = await db.execute(`
        SELECT id, name, full_path, created_at
        FROM filters
        ORDER BY id DESC
      `);

        // 🔥 Parse full_path JSON for each row
        const parsedRows = rows.map(row => ({
            ...row,
            full_path:
                typeof row.full_path === 'string'
                    ? JSON.parse(row.full_path)
                    : row.full_path
        }));

        successResponse(res, parsedRows, 'Filters list fetched');
    } catch (error) {
        console.error(error);
        errorResponse(res, 'Failed to fetch filters');
    }
});

/**
 * ============================================================
 * PUT /api/filters/update-filter/:id
 * ============================================================
 * Update a filter by replacing its full nested JSON structure
 *
 * URL Params:
 * - id: Filter ID
 *
 * Request Body:
 * {
 *   "Year A": [ ...updated nested data... ]
 * }
 *
 * Behavior:
 * - Replaces entire JSON (full_path)
 * - Updates name based on top-level key
 *
 * Access: Public (or Protected)
 */
router.put('/update-filter/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const filterData = req.body;

        if (!filterData || typeof filterData !== 'object') {
            return errorResponse(res, 'Invalid filter data', 400);
        }

        const name = Object.keys(filterData)[0];
        const db = getMySQLConnection();

        const [result] = await db.execute(
            `UPDATE filters SET name = ?, full_path = ? WHERE id = ?`,
            [name, JSON.stringify(filterData), id]
        );

        if (result.affectedRows === 0) {
            return errorResponse(res, 'Filter not found', 404);
        }

        successResponse(res, null, 'Filter updated successfully');
    } catch (error) {
        console.error(error);
        errorResponse(res, 'Failed to update filter');
    }
});

/**
 * ============================================================
 * DELETE /api/filters/delete-filter/:id
 * ============================================================
 * Delete a filter permanently by ID
 *
 * URL Params:
 * - id: Filter ID
 *
 * Behavior:
 * - Removes one complete filter tree
 *
 * Access: Public (or Protected)
 */
router.delete('/delete-filter/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const db = getMySQLConnection();

        const [result] = await db.execute(
            `DELETE FROM filters WHERE id = ?`,
            [id]
        );

        if (result.affectedRows === 0) {
            return errorResponse(res, 'Filter not found', 404);
        }

        successResponse(res, null, 'Filter deleted successfully');
    } catch (error) {
        console.error(error);
        errorResponse(res, 'Failed to delete filter');
    }
});

module.exports = router;