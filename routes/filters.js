const express = require('express');
const { auth } = require('../middleware/auth');
const { getMySQLConnection } = require('../config/mysql');
const { successResponse, errorResponse } = require('../utils/response');

const router = express.Router();

//  ============================= For Low Level Filters Composition Details =============================

/**
 * CREATE - Add new filter
 * Creates a new small filter with label and items array
 * @route POST /api/filters/add-filters   Working
 * @body {string} label - Filter label/name
 * @body {array} items - Array of filter items
 * @access Public
 */
router.post("/add-filters", async (req, res) => {
    try {
        const { label, items } = req.body;
        if (!label || !items) {
            return res.status(400).json({ success: false, message: "Label and items are required" });
        }

        const conn = getMySQLConnection();
        await conn.execute(
            "INSERT INTO small_filters (label, items) VALUES (?, ?)",
            [label, JSON.stringify(items)]
        );

        return res.status(201).json({ success: true, message: "Filter created successfully" });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: "Server error" });
    }
});

// ==================== SMALL FILTERS - FULL UPDATE ====================
/**
 * FULL UPDATE SMALL FILTERS
 * - Deletes all existing small_filters
 * - Resets auto increment (ID starts from 1)
 * - Inserts fresh data from payload
 * @route PUT api/filters/composition-details  Working
 */
router.put("/composition-details", async (req, res) => {
    try {
        const filters = req.body;

        // ✅ validation
        if (!Array.isArray(filters)) {
            return res.status(400).json({
                success: false,
                message: "Payload must be an array"
            });
        }

        const conn = getMySQLConnection();

        // 🔥 STEP 1: DELETE ALL + RESET ID
        await conn.execute("TRUNCATE TABLE small_filters");

        // 🔥 STEP 2: INSERT FRESH DATA
        for (const item of filters) {
            if (typeof item !== "object" || item === null) continue;

            const label = Object.keys(item)[0];
            const items = item[label];

            if (!label || !Array.isArray(items)) continue;

            await conn.execute(
                "INSERT INTO small_filters (label, items) VALUES (?, ?)",
                [label, JSON.stringify(items)]
            );
        }

        return res.status(200).json({
            success: true,
            message: "Small filters updated successfully"
        });

    } catch (err) {
        console.error("Update small_filters error:", err);
        return res.status(500).json({
            success: false,
            message: "Server error"
        });
    }
});


/**
 * READ - Get all filters
 * Retrieves all small filters with parsed JSON items
 * @route GET /api/filters/all-filters  Working
 * @access Public
 */
router.get("/all-filters", async (req, res) => {
    try {
        const conn = getMySQLConnection();
        const [rows] = await conn.execute("SELECT * FROM small_filters ORDER BY created_at DESC");

        // parse JSON
        const filters = rows.map(f => ({
            ...f,
            items: JSON.parse(f.items)
        }));

        return res.json({ success: true, data: filters });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: "Server error" });
    }
});

/**
 * READ ONE - Get a single filter by ID
 * Retrieves a specific small filter by its ID with parsed JSON items
 * @route GET /api/filters/get/:id
 * @param {number} id - Filter ID to retrieve
 * @access Public
 */
router.get("/get/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const conn = getMySQLConnection();
        const [rows] = await conn.execute("SELECT * FROM small_filters WHERE id = ?", [id]);

        if (rows.length === 0)
            return res.status(404).json({ success: false, message: "Filter not found" });

        const filter = rows[0];
        filter.items = JSON.parse(filter.items);

        return res.json({ success: true, data: filter });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: "Server error" });
    }
});

/**
 * UPDATE - Update filter
 * Updates an existing small filter's label and/or items
 * @route PUT /api/filters/updates/:id  Working
 * @param {number} id - Filter ID to update
 * @body {string} label - Filter label/name (optional)
 * @body {array} items - Array of filter items (optional)
 * @access Public
 */
router.put("/updates/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { label, items } = req.body;

        const conn = getMySQLConnection();
        const [existing] = await conn.execute("SELECT id FROM small_filters WHERE id = ?", [id]);
        if (existing.length === 0)
            return res.status(404).json({ success: false, message: "Filter not found" });

        await conn.execute(
            "UPDATE small_filters SET label = COALESCE(?, label), items = COALESCE(?, items) WHERE id = ?",
            [label, items ? JSON.stringify(items) : null, id]
        );

        res.json({ success: true, message: "Filter updated successfully" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

/**
 * DELETE - Delete filter
 * Removes a small filter by its ID
 * @route DELETE /api/filters/deletes/:id   Working
 * @param {number} id - Filter ID to delete
 * @access Public
 */
router.delete("/deletes/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const conn = getMySQLConnection();

        const [result] = await conn.execute("DELETE FROM small_filters WHERE id = ?", [id]);
        if (result.affectedRows === 0)
            return res.status(404).json({ success: false, message: "Filter not found" });

        res.json({ success: true, message: "Filter deleted successfully" });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: "Server error" });
    }
});


// ==================== Type of Music FUNCTIONs ====================
/**
 * ADD TYPE - Add a new music type
 * Creates a new music type entry
 * @route POST /api/filters/add-type     Working
 * @body {string} name - Music type name
 * @access Public
 */
router.post("/add-type", async (req, res) => {
    const { name } = req.body;
    try {
        const conn = getMySQLConnection();
        await conn.execute("INSERT INTO type_of_music (name) VALUES (?)", [name]);
        console.log("✅ Type of music added successfully");
        return res.status(201).json({ success: true, message: "Type of music added successfully" });
    } catch (err) {
        console.error("Failed to add type of music:", err);
        return res.status(500).json({ success: false, message: "Server error" });
    }
});

// ==================== TYPE OF MUSIC - FULL UPDATE ====================
/**
 * FULL UPDATE TYPES OF MUSIC
 * - Deletes all existing entries
 * - Resets auto increment (ID starts from 1)
 * - Inserts fresh data from payload
 * @route PUT api/filters/reorder   Working
 */
router.put("/reorder", async (req, res) => {
    try {
        const { types } = req.body;

        // ✅ validation
        if (!Array.isArray(types) || types.length === 0) {
            return res.status(400).json({
                success: false,
                message: "types must be a non-empty array"
            });
        }

        const conn = getMySQLConnection();

        // 🔥 STEP 1: DELETE ALL + RESET ID
        await conn.execute("TRUNCATE TABLE type_of_music");

        // 🔥 STEP 2: INSERT NEW TYPES
        for (const name of types) {
            if (typeof name !== "string" || !name.trim()) continue;

            await conn.execute(
                "INSERT INTO type_of_music (name) VALUES (?)",
                [name.trim()]
            );
        }

        return res.status(200).json({
            success: true,
            message: "Type of music updated successfully"
        });

    } catch (err) {
        console.error("Update type_of_music error:", err);
        return res.status(500).json({
            success: false,
            message: "Server error"
        });
    }
});


/**
 * DELETE TYPE - Delete a music type by name
 * Removes a music type entry by name
 * @route DELETE /api/filters/delete-type   working
 * @body {string} name - Music type name to delete
 * @access Public
 */
router.delete("/delete-type", async (req, res) => {
    const { name } = req.body;
    try {
        const conn = getMySQLConnection();
        await conn.execute("DELETE FROM type_of_music WHERE name = ?", [name]);
        console.log("✅ Type of music deleted successfully");
        return res.json({ success: true, message: "Type of music deleted successfully" });
    } catch (err) {
        console.error("Failed to delete type of music:", err);
        return res.status(500).json({ success: false, message: "Server error" });
    }
});

/**
 * GET TYPES - Retrieve all music types
 * Returns all music type entries from database
 * @route GET /api/filters/types   Working
 * @access Public
 */
router.get("/types", async (req, res) => {
    try {
        const conn = getMySQLConnection();
        const [rows] = await conn.execute("SELECT * FROM type_of_music");
        return res.json({ success: true, data: rows });
    } catch (err) {
        console.error("Failed to retrieve types of music:", err);
        return res.status(500).json({ success: false, message: "Server error" });
    }
});

/**
 * UPDATE TYPE - Update a music type name by ID
 * Updates an existing music type's name
 * @route PUT /api/filters/update-type    working
 * @body {number} id - Music type ID to update
 * @body {string} name - New music type name
 * @access Public
 */
router.put("/update-type", async (req, res) => {
    const { id, name } = req.body;
    try {
        const conn = getMySQLConnection();
        await conn.execute("UPDATE type_of_music SET name = ? WHERE id = ?", [name, id]);
        return res.json({ success: true, message: "Type of music updated successfully" });
    } catch (err) {
        console.error("Failed to update type of music:", err);
        return res.status(500).json({ success: false, message: "Server error" });
    }
});

module.exports = router;