const express = require('express');
const { getMySQLConnection } = require('../config/mysql');
const { auth } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');
const { hymnalMusicUpload, deleteFileFromS3 } = require('../config/s3');
const multer = require('multer');
const xlsx = require('xlsx');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

/* =========================
   Helpers
========================= */
const parseJsonSafe = (value, fallback = null) => {
    if (!value) return fallback;
    try {
        return typeof value === 'string' ? JSON.parse(value) : value;
    } catch {
        return fallback;
    }
};

/* =========================
   Multer Config 
========================= */
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        if (!file.originalname.match(/\.(xlsx|xls|csv)$/i)) {
            return cb(new Error('Only Excel/CSV files allowed'));
        }
        cb(null, true);
    }
});

/* =====================================================
   HYMNAL CATEGORIES
===================================================== */

/* =====================================================
   BULK UPLOAD HYMNAL CATEGORIES
===================================================== */
/**
 * @route   POST /api/hymnal-music/categories/bulk-upload
 * @desc    Bulk upload hymnal categories
 * @access  Private
 *
 * Excel Columns:
 * Category Name | Publisher | Edition Year | Visibility | Abbreviation
 */
router.post('/categories/bulk-upload', [auth, upload.single('file')],
    async (req, res) => {
        try {
            if (!req.file) {
                return errorResponse(res, 'Excel file is required', 400);
            }

            const mysql = getMySQLConnection();
            const userId = req.user.id;
            const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const rows = xlsx.utils.sheet_to_json(sheet, {
                defval: '',
                raw: false,
                blankrows: false
            });

            if (!rows.length) {
                return errorResponse(res, 'Sheet is empty', 400);
            }

            const summary = {
                totalRows: rows.length,
                successCount: 0,
                failedCount: 0,
                errors: []
            };

            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const excelRow = i + 2;

                try {
                    const categoryName = row['Category Name'] || row['categoryName'] || '';
                    const publisher = row['Publisher'] || row['publisher'] || '';
                    const editionYear = row['Edition Year'] || row['editionYear'] || '';
                    const visibility = row['Visibility'] || row['visibility'] || 'public';

                    const abbrevation = row['Abbreviation'] || row['abbrevation'] || row['Hymnal Abbreviation'] || '';
                    if (!categoryName || !publisher || !editionYear || !abbrevation) {
                        throw new Error('Missing required fields');
                    }

                    await mysql.execute(`INSERT INTO hymnal_categories (user_id, category_name, publisher, edition_year, visibility, hymanl_abbrevation)
                    VALUES (?, ?, ?, ?, ?, ?)`,
                        [
                            userId,
                            categoryName.trim(),
                            publisher.trim(),
                            editionYear,
                            visibility || 'public',
                            abbrevation.trim()
                        ]
                    );

                    summary.successCount++;
                } catch (rowErr) {
                    summary.failedCount++;
                    summary.errors.push({
                        row: excelRow,
                        category: row['Category Name'] || 'Unknown',
                        message: rowErr.message
                    });
                }
            }

            return successResponse(
                res,
                summary,
                'Hymnal categories bulk upload completed'
            );
        } catch (err) {
            console.error(err);
            return errorResponse(res, 'Bulk upload failed', 500);
        }
    }
);

/* =====================================================
   SAMPLE SHEET DOWNLOAD
===================================================== */
/**
 * @route   GET /api/hymnal-music/categories/sample-sheet
 * @query   ?type=google_sheet
 */
router.get('/categories/sample-sheet', async (req, res) => {
    try {
        const { type } = req.query;

        const columns = [
            'Category Name',
            'Publisher',
            'Edition Year',
            'Visibility',
            'Abbreviation'
        ];

        const sampleRow = [
            'Catholic Hymnal',
            'Simply Liturgical',
            '2024',
            'public',
            'CH-24'
        ];

        const data = [columns, sampleRow];

        // 🟢 CSV (Google Sheet)
        if (type === 'google_sheet') {
            const sheet = xlsx.utils.aoa_to_sheet(data);
            const csv = xlsx.write(
                { Sheets: { Sample: sheet }, SheetNames: ['Sample'] },
                { bookType: 'csv', type: 'buffer' }
            );

            res.setHeader(
                'Content-Disposition',
                'attachment; filename="hymnal_categories_sample.csv"'
            );
            res.setHeader('Content-Type', 'text/csv');
            return res.send(csv);
        }

        // 🔵 Excel
        const workbook = xlsx.utils.book_new();
        const sheet = xlsx.utils.aoa_to_sheet(data);

        sheet['!cols'] = columns.map(col => ({ wch: col.length + 5 }));

        xlsx.utils.book_append_sheet(workbook, sheet, 'Sample');

        const buffer = xlsx.write(workbook, {
            type: 'buffer',
            bookType: 'xlsx'
        });

        res.setHeader(
            'Content-Disposition',
            'attachment; filename="hymnal_categories_sample.xlsx"'
        );
        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );

        return res.send(buffer);
    } catch (err) {
        console.error(err);
        return errorResponse(res, 'Failed to generate sample sheet', 500);
    }
});


// ➕ Create Category
/**
 * @route   POST /api/hymnal-music/categories
 * @desc    Create a new hymnal-music category
 * @access  Private
 */
router.post('/categories', auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const userId = req.user.id;
        const { categoryName, publisher, editionYear, visibility, abbrevation } = req.body;

        if (!categoryName || !publisher || !editionYear || !abbrevation) {
            return errorResponse(res, 'All fields are required', 400);
        }

        const [result] = await mysql.execute(
            `INSERT INTO hymnal_categories
       (user_id, category_name, publisher, edition_year, visibility, hymanl_abbrevation)
       VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, categoryName, publisher, editionYear, visibility || 'public', abbrevation]
        );

        successResponse(res, { id: result.insertId }, 'Hymnal category created');
    } catch (err) {
        console.error(err);
        errorResponse(res, 'Failed to create hymnal category', 500);
    }
});

// 📄 Get Categories
/**
 * @route   GET /api/hymnal-music/categories
 * @desc    Get all hymnal-music
 * @access  Private
 */
router.get('/categories', auth, async (_req, res) => {
    try {
        const mysql = getMySQLConnection();
        const [rows] = await mysql.execute(
            `SELECT * FROM hymnal_categories ORDER BY created_at DESC`
        );
        successResponse(res, rows, 'Hymnal categories fetched');
    } catch (err) {
        console.error(err);
        errorResponse(res, 'Failed to fetch hymnals', 500);
    }
});

// ✏️ Update Category
/**
 * @route   PUT /api/hymnal-music/categories/:id
 * @desc    Update hymnal-music category
 * @access  Private
 */
router.put('/categories/:id', auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;
        const { categoryName, publisher, editionYear, visibility, abbrevation } = req.body;

        await mysql.execute(
            `UPDATE hymnal_categories
       SET category_name = ?, publisher = ?, edition_year = ?, visibility = ?, hymanl_abbrevation = ?
       WHERE id = ?`,
            [categoryName, publisher, editionYear, visibility, abbrevation, id]
        );

        successResponse(res, null, 'Hymnal updated');
    } catch (err) {
        console.error(err);
        errorResponse(res, 'Failed to update hymnal', 500);
    }
});

// ❌ Delete Category
/**
 * @route   DELETE /api/hymnal-music/categories/:id
 * @desc    Delete hymnal-music category
 * @access  Private
 */
router.delete('/categories/:id', auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        await mysql.execute(`DELETE FROM hymnal_categories WHERE id = ?`, [req.params.id]);
        successResponse(res, null, 'Hymnal deleted');
    } catch (err) {
        console.error(err);
        errorResponse(res, 'Failed to delete hymnal', 500);
    }
});

/* =====================================================
   HYMNAL MUSIC LIBRARY
===================================================== */
// 📄 Post Songs (JSON-aware)
/**
 * @route   Post /api/hymnal-music/songs
 * @desc    Post all hymnal-music songs with resolved categories
 * @access  Private
 */
router.post('/songs', auth, hymnalMusicUpload.fields([{ name: 'sheetMusic', maxCount: 10 }]),
    async (req, res) => {
        try {
            const mysql = getMySQLConnection();
            const userId = req.user.id;

            const {
                hymnalCategoryId,
                hymnTitle,
                hymnAuthor,
                hymnNumbers,
                audioPreviewUrl,
                musicType
            } = req.body;

            /* ==========================================
               🔥 STEP 1: REQUIRED VALIDATION
            ========================================== */
            if (!hymnalCategoryId || !hymnTitle || !hymnAuthor || !hymnNumbers) {
                return errorResponse(res, 'Required fields missing', 400);
            }

            /* ==========================================
               🔥 STEP 3: CATEGORY PARSING
            ========================================== */
            let categoryArray = [];

            if (typeof hymnalCategoryId === 'string') {
                categoryArray = JSON.parse(hymnalCategoryId);
            }

            categoryArray = categoryArray.filter(Number.isInteger);

            if (!categoryArray.length) {
                return errorResponse(res, 'Invalid hymnalCategoryId', 400);
            }

            /* ==========================================
               🔥 STEP 4: HYMN NUMBERS PARSING (OBJECT)
               expected: {"6":"BB-206","7":"BB-209"}
            ========================================== */
            let hymnNumbersObject;

            if (typeof hymnNumbers === 'string') {
                hymnNumbersObject = JSON.parse(hymnNumbers);
            } else if (typeof hymnNumbers === 'object') {
                hymnNumbersObject = hymnNumbers;
            }

            if (
                !hymnNumbersObject ||
                typeof hymnNumbersObject !== 'object' ||
                Array.isArray(hymnNumbersObject) ||
                Object.keys(hymnNumbersObject).length === 0
            ) {
                return errorResponse(res, 'Invalid hymnNumbers format (must be object)', 400);
            }

            /* ==========================================
               🔥 STEP 5: SHEET MUSIC META
            ========================================== */
            let sheetMusicMeta = {};
            if (req.body.sheetMusicMeta) {
                sheetMusicMeta = JSON.parse(req.body.sheetMusicMeta);
            }

            /* ==========================================
               🔥 STEP 6: SHEET MUSIC FILES + META MERGE
            ========================================== */
            const sheetMusicFiles = req.files?.sheetMusic || [];

            const sheetMusicPayload = sheetMusicFiles.map((file, index) => {
                const meta = sheetMusicMeta[index] || {};

                return {
                    designation: meta.designation || '',
                    instruments: meta.instruments || [],
                    customInstrument: meta.customInstrument || '',
                    file: {
                        url: file.location,
                        name: file.originalname,
                        size: file.size,
                        type: file.mimetype
                    }
                };
            });

            /* ==========================================
               🔥 STEP 7: INSERT DB
            ========================================== */
            await mysql.execute(
                `
          INSERT INTO hymnal_music_library
          (
            user_id,
            hymnal_category_id,
            hymn_title,
            hymn_author,
            hymn_numbers,
            audio_preview_url,
            hymnal_files,
            hymnal_music_type
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
                [
                    userId,
                    JSON.stringify(categoryArray),
                    hymnTitle,
                    hymnAuthor,
                    JSON.stringify(hymnNumbersObject),
                    audioPreviewUrl || null,
                    sheetMusicPayload.length ? JSON.stringify(sheetMusicPayload) : null,
                    musicType || 'original'
                ]
            );

            successResponse(res, null, 'Hymnal song added successfully');
        } catch (err) {
            console.error(err);
            errorResponse(res, 'Failed to add hymnal song', 500);
        }
    }
);


/**
 * @route   GET /api/hymnal-music/songs
 * @desc    Get all hymnal-music songs with resolved categories
 * @access  Private
 */
router.get('/songs', auth, async (req, res) => {
    try {

        const mysql = getMySQLConnection();
        const userId = req.user.id;
        const userType = req.user.user_type;
        const parentUserId = req.user.parent_user_id;

        /* ==========================================
           🔥 STEP 1: FINAL USER ID
        ========================================== */
        let finalUserId = userId;
        if ((userType === 'sub_user' || userType === 'manager') && parentUserId) {
            finalUserId = parentUserId;
        }

        /* ==========================================
           🔥 STEP 2: ALLOWED USER IDS
        ========================================== */

        let allowedUserIds = [userId];

        if ((userType === 'sub_user' || userType === 'manager') && parentUserId) {
            allowedUserIds.push(parentUserId);
        }

        console.log("✅ Allowed IDs (Hymnal):", allowedUserIds);

        /* ==========================================
           🔥 STEP 2: QUERY BUILD
        ========================================== */

        let query = `
        SELECT * 
        FROM hymnal_music_library
      `;

        const params = [];

        // ✅ Library only filter (FIXED FOR MULTIPLE USERS)
        if (req.query.libraryOnly === 'true') {

            const conditions = allowedUserIds.map(() =>
                `JSON_CONTAINS(added_to_users, JSON_ARRAY(?))`
            ).join(' OR ');

            query += ` WHERE (${conditions})`;

            params.push(...allowedUserIds);
        }

        query += ` ORDER BY created_at DESC`;

        /* ==========================================
           🔥 STEP 3: EXECUTE
        ========================================== */

        const [rows] = await mysql.execute(query, params);

        /* ==========================================
           🔥 STEP 4: COLLECT CATEGORY IDS
        ========================================== */

        const allCategoryIds = new Set();

        rows.forEach(row => {
            const ids = parseJsonSafe(row.hymnal_category_id, []);
            ids.forEach(id => allCategoryIds.add(id));
        });

        /* ==========================================
           🔥 STEP 5: FETCH CATEGORIES
        ========================================== */

        let categoriesMap = {};

        if (allCategoryIds.size) {

            const idsArray = [...allCategoryIds];

            const [cats] = await mysql.execute(
                `SELECT *
           FROM hymnal_categories
           WHERE id IN (${idsArray.map(() => '?').join(',')})`,
                idsArray
            );

            categoriesMap = cats.reduce((acc, c) => {
                acc[c.id] = c;
                return acc;
            }, {});
        }

        /* ==========================================
           🔥 STEP 6: TRANSFORM DATA
        ========================================== */

        const formattedRows = rows.map(row => {

            const categoryIds = parseJsonSafe(row.hymnal_category_id, []);

            const addedUsers = parseJsonSafe(row.added_to_users, []);

            const isParent = !addedUsers.includes(userId);

            // ✅ Extract personal library entries for current user
            const personalMusicData = parseJsonSafe(row.user_personal_music, {});
            const userPersonalEntries = personalMusicData[finalUserId] || [];

            return {
                ...row,

                categories: categoryIds
                    .map(id => categoriesMap[id])
                    .filter(Boolean),

                hymnal_category_id: categoryIds,

                hymn_numbers: parseJsonSafe(row.hymn_numbers, {}),

                hymnal_files: parseJsonSafe(row.hymnal_files, []),

                added_to_users: addedUsers,

                source: "Hymnal Music",

                // BONUS
                sourceType: isParent ? "parent" : "self",

                // ✅ Personal library entries embedded in song object
                personalLibraryEntries: userPersonalEntries
            };
        });

        /* ==========================================
           ✅ FINAL RESPONSE
        ========================================== */

        return successResponse(res, formattedRows, 'Hymnal songs fetched');

    } catch (err) {

        console.error("Hymnal Songs Error:", err);

        return errorResponse(res, 'Failed to fetch songs', 500);

    }
});

// ✏️ Update Song
/**
 * @route   PUT /api/hymnal-music/songs/:id
 * @desc    Update hymnal-music song
 * @access  Private
 */
router.put('/songs/:id', auth, hymnalMusicUpload.fields([{ name: 'sheetMusic', maxCount: 10 }]),
    async (req, res) => {
        try {
            const mysql = getMySQLConnection();

            const currentUserId = req.user.id;
            const userType = req.user.user_type;
            const parentUserId = req.user.parent_user_id;

            const { id } = req.params;

            const {
                hymnTitle,
                hymnAuthor,
                hymnNumbers,
                audioPreviewUrl,
                musicType,
                hymnalCategoryId,
                sheetMusicMeta,
                convertToLibrary,
            } = req.body;

            /* ==========================================
               🔥 STEP 1: FINAL USER ID (MAIN FIX)
            ========================================== */

            let finalUserId = currentUserId;

            if ((userType === 'sub_user' || userType === 'manager') && parentUserId) {
                finalUserId = parentUserId;
            }

            console.log("✅ Library update for user:", finalUserId);

            /* ==========================================
               CHECK SONG
            ========================================== */

            const [[song]] = await mysql.execute(
                `SELECT id, added_to_users
         FROM hymnal_music_library 
         WHERE id = ?`, [id]
            );

            if (!song) {
                return errorResponse(res, "Song not found", 404);
            }

            /* ==========================================
               CATEGORY PARSE
            ========================================== */

            let categoryJson = null;

            if (hymnalCategoryId !== undefined) {
                let arr = [];

                if (typeof hymnalCategoryId === "string") {
                    const t = hymnalCategoryId.trim();

                    if (t.startsWith("[")) arr = JSON.parse(t);
                    else if (t.includes(",")) arr = t.split(",").map(Number);
                    else arr = [Number(t)];
                }

                arr = arr.filter(Number.isInteger);

                if (!arr.length) {
                    return errorResponse(res, "Invalid hymnalCategoryId", 400);
                }

                categoryJson = JSON.stringify(arr);
            }

            /* ==========================================
               HYMN NUMBERS
            ========================================== */

            let numbersJson = null;

            if (hymnNumbers !== undefined) {
                let numbersObj = {};

                if (typeof hymnNumbers === "string") {
                    numbersObj = JSON.parse(hymnNumbers);
                } else if (typeof hymnNumbers === "object") {
                    numbersObj = hymnNumbers;
                }

                if (!Object.keys(numbersObj).length) {
                    return errorResponse(res, "Invalid hymnNumbers object", 400);
                }

                numbersJson = JSON.stringify(numbersObj);
            }

            /* ==========================================
               SHEET MUSIC
            ========================================== */

            let sheetMusicPayload = null;

            if (req.files?.sheetMusic?.length) {
                const meta = sheetMusicMeta ? JSON.parse(sheetMusicMeta) : {};

                sheetMusicPayload = req.files.sheetMusic.map((file, index) => {
                    const m = meta[index] || {};

                    return {
                        designation: m.designation || "",
                        instruments: m.instruments || [],
                        customInstrument: m.customInstrument || "",
                        file: {
                            url: file.location,
                            name: file.originalname,
                            size: file.size,
                            type: file.mimetype,
                        },
                    };
                });
            }

            /* ==========================================
               UPDATE QUERY BUILD
            ========================================== */

            const fields = [];
            const values = [];

            if (hymnTitle !== undefined) {
                fields.push("hymn_title = ?");
                values.push(hymnTitle);
            }

            if (hymnAuthor !== undefined) {
                fields.push("hymn_author = ?");
                values.push(hymnAuthor);
            }

            if (numbersJson !== null) {
                fields.push("hymn_numbers = ?");
                values.push(numbersJson);
            }

            if (audioPreviewUrl !== undefined) {
                fields.push("audio_preview_url = ?");
                values.push(audioPreviewUrl || null);
            }

            if (musicType !== undefined) {
                fields.push("hymnal_music_type = ?");
                values.push(musicType || "original");
            }

            if (categoryJson !== null) {
                fields.push("hymnal_category_id = ?");
                values.push(categoryJson);
            }

            if (sheetMusicPayload) {
                fields.push("hymnal_files = ?");
                values.push(JSON.stringify(sheetMusicPayload));
            }

            /* ==========================================
               🔥 ADD / REMOVE USER (MAIN FIX)
            ========================================== */

            if (convertToLibrary !== undefined) {

                const usersArray = song.added_to_users
                    ? JSON.parse(song.added_to_users)
                    : [];

                if (convertToLibrary === true || convertToLibrary === "true") {

                    if (!usersArray.includes(finalUserId)) {
                        usersArray.push(finalUserId); // ✅ FIX
                    }

                } else {

                    const index = usersArray.indexOf(finalUserId);

                    if (index !== -1) {
                        usersArray.splice(index, 1);
                    }
                }

                fields.push("added_to_users = ?");
                values.push(JSON.stringify(usersArray));
            }

            if (!fields.length) {
                return errorResponse(res, "No fields to update", 400);
            }

            values.push(id);

            await mysql.execute(
                `UPDATE hymnal_music_library 
         SET ${fields.join(", ")} 
         WHERE id = ?`,
                values
            );

            return successResponse(res, {
                updatedFor: finalUserId
            }, "Hymnal song updated");

        } catch (err) {
            console.error(err);
            return errorResponse(res, "Failed to update song", 500);
        }
    }
);

// ❌ Delete Song
/**
 * @route   DELETE /api/hymnal-music/songs/:id
 * @desc    Delete hymnal-music song + cleanup S3 file
 * @access  Private
 */
router.delete('/songs/:id', auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const userId = req.user.id;
        const { id } = req.params;

        /* -----------------------------
           1️⃣ Fetch record safely
        ------------------------------*/
        const [rows] = await mysql.execute(
            `
        SELECT hymnal_files
        FROM hymnal_music_library
        WHERE id = ? AND user_id = ?
        `,
            [id, userId]
        );

        if (!rows.length) {
            return errorResponse(res, 'Record not found or unauthorized', 404);
        }

        /* -----------------------------
           2️⃣ Delete ALL S3 files
        ------------------------------*/
        const files = parseJsonSafe(rows[0].hymnal_files, []);

        if (Array.isArray(files)) {
            for (const item of files) {
                const url = item?.file?.url;
                if (url) {
                    await deleteFileFromS3(url);
                }
            }
        }

        /* -----------------------------
           3️⃣ Delete DB record
        ------------------------------*/
        await mysql.execute(
            `DELETE FROM hymnal_music_library WHERE id = ? AND user_id = ?`,
            [id, userId]
        );

        successResponse(res, null, 'Hymnal song deleted');
    } catch (err) {
        console.error(err);
        errorResponse(res, 'Failed to delete song', 500);
    }
});


// @route   POST /api/hymnal-music/stored-folders
// @desc    Create or Update user hymnal stored folders
// @access  Private
router.post("/stored-folders", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { hymnal_category_folders } = req.body;
        const user_id = req.user.id;

        if (!Array.isArray(hymnal_category_folders)) {
            return res.status(400).json({
                success: false,
                message: "hymnal_category_folders must be an array"
            });
        }

        // Check if record exists
        const [existing] = await mysql.execute(
            "SELECT id FROM user_hymnal_stored_files WHERE user_id = ?",
            [user_id]
        );

        if (existing.length > 0) {
            // Update
            await mysql.execute(
                `UPDATE user_hymnal_stored_files 
           SET hymnal_category_folders = ?
           WHERE user_id = ?`,
                [JSON.stringify(hymnal_category_folders), user_id]
            );

            return res.json({
                success: true,
                message: "Hymnal folders updated successfully"
            });
        } else {
            // Insert
            await mysql.execute(
                `INSERT INTO user_hymnal_stored_files 
           (user_id, hymnal_category_folders)
           VALUES (?, ?)`,
                [user_id, JSON.stringify(hymnal_category_folders)]
            );

            return res.json({
                success: true,
                message: "Hymnal folders saved successfully"
            });
        }

    } catch (error) {
        console.error("User Hymnal POST Error:", error);
        res.status(500).json({
            success: false,
            message: "Server error"
        });
    }
});


// @route   GET /api/hymnal-music/stored-folders
// @desc    Get user hymnal stored folders
// @access  Private
router.get("/stored-folders", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const user_id = req.user.id;

        const [rows] = await mysql.execute(
            "SELECT * FROM user_hymnal_stored_files WHERE user_id = ?",
            [user_id]
        );

        if (rows.length === 0) {
            return res.json({
                success: true,
                data: []
            });
        }

        const data = {
            id: rows[0].id,
            user_id: rows[0].user_id,
            hymnal_category_folders: rows[0].hymnal_category_folders
                ? JSON.parse(rows[0].hymnal_category_folders)
                : []
        };

        res.json({
            success: true,
            data
        });

    } catch (error) {
        console.error("User Hymnal GET Error:", error);
        res.status(500).json({
            success: false,
            message: "Server error"
        });
    }
});


/* =====================================================
   BULK UPLOAD HYMNAL SONGS  ✅ FIXED
===================================================== */
/**
 * @route   POST /api/hymnal-music/songs/bulk-upload
 * @desc    Bulk upload hymnal songs using excel sheet
 * @access  Private
 *
 * Expected Excel Headers:
 * Hymnal cateorgy name | Year | Title | Composer | BB | MI |
 * Solo Instrument (e)  | Choral Settings | Source Page
 *
 * FIX 1: normalizeKey() trims ALL header keys (handles trailing spaces like "Hymnal cateorgy name ")
 * FIX 2: category lookup uses category_name (not hymnal_category_id column) → resolves the
 *         "Unknown column 'hymnal_category_id' in field list" error that happened because the
 *         old code was trying to INSERT into a non-existent column path.
 * FIX 3: INSERT only uses columns confirmed in the DB schema. Extra columns (hymnal_mi,
 *         hymnal_solo_instruments, hymnal_choral_settings, hymnal_source_page) are only
 *         inserted when they exist — ensured via ensureTableColumns at startup.
 */
/* ══════════════════════════════════════════════════════════════
   POST /api/hymnal-music/songs/bulk-upload
   Upload bulk hymnal songs via .xlsx / .xls / .csv

   Expected columns (match sample-sheet template):
   ┌──────────────────┬─────────────────┬───────────────┬─────────────┬───────────────────┬────────────┐
   │   Hymn Title     │   Hymn Author   │ Category Name │ Hymn Number │ Audio Preview URL │ Music Type │
   └──────────────────┴─────────────────┴───────────────┴─────────────┴───────────────────┴────────────┘

   - Hymn Title     : required
   - Hymn Author    : required
   - Category Name  : required  — must match "Category Name (Year)" from dropdown
   - Hymn Number    : required  — e.g. "BB-101" or "BB-101, MI-202" (comma-separated for multiple)
   - Audio Preview URL : optional
   - Music Type     : optional  — must match name from type_of_music table
══════════════════════════════════════════════════════════════ */
router.post('/songs/bulk-upload', [auth, upload.single('file')], async (req, res) => {
    try {
        if (!req.file) {
            return errorResponse(res, 'Excel file is required', 400);
        }

        const mysql = getMySQLConnection();
        const userId = req.user.id;

        /* ══════════════════════════════════════════
           STEP 1 — READ FILE
        ══════════════════════════════════════════ */
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];

        const rows = xlsx.utils.sheet_to_json(sheet, {
            defval: '',
            raw: false,
            blankrows: false,
        });

        if (!rows.length) {
            return errorResponse(res, 'Sheet is empty', 400);
        }

        /* ══════════════════════════════════════════
           STEP 2 — FETCH LOOKUP DATA (Categories / Music Types)
        ══════════════════════════════════════════ */

        // Categories → map  "category name (year)" → id
        const [categories] = await mysql.execute(
            `SELECT id, category_name, edition_year FROM hymnal_categories ORDER BY category_name ASC`
        );

        const categoryMap = {};
        categories.forEach(c => {
            // match exact label used in dropdown: "Category Name (Year)"
            const label = `${c.category_name} (${c.edition_year})`.toLowerCase().trim();
            categoryMap[label] = c.id;

            // also allow plain category_name match as fallback
            categoryMap[c.category_name.toLowerCase().trim()] = c.id;
        });

        // Music Types → map  name → id
        const [musicTypes] = await mysql.execute(
            `SELECT id, name FROM type_of_music ORDER BY id ASC`
        );

        const musicTypeMap = {};
        musicTypes.forEach(t => {
            musicTypeMap[t.name.toLowerCase().trim()] = t.id;
        });

        /* ══════════════════════════════════════════
           STEP 3 — PRELOAD EXISTING SONGS FOR DEDUP/UPDATE
           Build a lookup: "categoryId::HYMN_NUMBER" → existing row
           (This lets us detect "same hymnal + same number" combos
            and UPDATE instead of duplicating.)
        ══════════════════════════════════════════ */
        const [existingSongs] = await mysql.execute(
            `SELECT id, hymnal_category_id, hymn_numbers, hymn_title, hymn_author,
                    audio_preview_url, hymnal_music_type
             FROM hymnal_music_library
             WHERE user_id = ?`,
            [userId]
        );

        // Map key: `${categoryId}::${NORMALIZED_NUMBER}` → { id, categoryIds:Set, hymnNumbers, hymnTitle, hymnAuthor, audioPreviewUrl, hymnalMusicType }
        const existingLookup = new Map();

        const registerLookup = (record) => {
            record.categoryIds.forEach(cid => {
                Object.values(record.hymnNumbers).forEach(numVal => {
                    const key = `${cid}::${String(numVal).toUpperCase().trim()}`;
                    existingLookup.set(key, record);
                });
            });
        };

        existingSongs.forEach(song => {
            let categoryIds = [];
            let hymnNumbers = {};
            try { categoryIds = JSON.parse(song.hymnal_category_id) || []; } catch { categoryIds = []; }
            try { hymnNumbers = JSON.parse(song.hymn_numbers) || {}; } catch { hymnNumbers = {}; }

            const record = {
                id: song.id,
                categoryIds,
                hymnNumbers,
                hymnTitle: song.hymn_title,
                hymnAuthor: song.hymn_author,
                audioPreviewUrl: song.audio_preview_url,
                hymnalMusicType: song.hymnal_music_type,
            };

            registerLookup(record);
        });

        /* ══════════════════════════════════════════
           STEP 4 — SUMMARY
        ══════════════════════════════════════════ */
        const summary = {
            totalRows: rows.length,
            successCount: 0,   // newly inserted
            updatedCount: 0,   // existing songs updated (same category + hymn number)
            failedCount: 0,
            errors: [],
        };

        /* ══════════════════════════════════════════
           STEP 5 — PROCESS ROWS
        ══════════════════════════════════════════ */
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const excelRow = i + 2;

            try {
                /* ── Column Mapping ── */
                const hymnTitle      = (row['Hymn Title']        || '').trim();
                const hymnAuthor     = (row['Hymn Author']       || '').trim();
                const categoryRaw    = (row['Category Name']     || '').trim();
                const hymnNumberRaw  = (row['Hymn Number']       || '').trim();
                const audioPreview   = (row['Audio Preview URL'] || '').trim();
                const musicTypeRaw   = (row['Music Type']        || '').trim();

                /* ── Required Field Validation ── */
                if (!hymnTitle) {
                    throw new Error('Hymn Title is required');
                }
                if (!hymnAuthor) {
                    throw new Error('Hymn Author is required');
                }
                if (!categoryRaw) {
                    throw new Error('Category Name is required');
                }
                if (!hymnNumberRaw) {
                    throw new Error('Hymn Number is required');
                }

                /* ── Resolve Category ID ── */
                const categoryId = categoryMap[categoryRaw.toLowerCase()];
                if (!categoryId) {
                    throw new Error(`Category not found: "${categoryRaw}". Use the dropdown value from the template.`);
                }

                /* ── Build Hymn Numbers Object ──
                   Supports:
                     single  → "BB-101"         → { "BB": "BB-101" }
                     multi   → "BB-101, MI-202"  → { "BB": "BB-101", "MI": "MI-202" }
                ── */
                const hymnNumbers = {};
                const parts = hymnNumberRaw.split(',').map(p => p.trim()).filter(Boolean);

                parts.forEach(part => {
                    // extract prefix (everything before first hyphen or digit run)
                    const match = part.match(/^([A-Za-z]+)/);
                    const key = match ? match[1].toUpperCase() : `KEY${Object.keys(hymnNumbers).length + 1}`;
                    hymnNumbers[key] = part;
                });

                if (!Object.keys(hymnNumbers).length) {
                    throw new Error('Hymn Number could not be parsed');
                }

                /* ── Resolve Music Type (optional) ── */
                let resolvedMusicType = null;
                if (musicTypeRaw) {
                    resolvedMusicType = musicTypeMap[musicTypeRaw.toLowerCase()]
                        ? musicTypeRaw   // store the name as-is (matches DB value)
                        : null;

                    if (!resolvedMusicType) {
                        throw new Error(`Invalid Music Type: "${musicTypeRaw}". Use a value from the dropdown.`);
                    }
                }

                /* ══════════════════════════════════════════
                   ── DUPLICATE CHECK: same Hymnal (Category) +
                      same Hymn Number → UPDATE instead of INSERT
                ══════════════════════════════════════════ */
                let matchedExisting = null;
                for (const numVal of Object.values(hymnNumbers)) {
                    const lookupKey = `${categoryId}::${String(numVal).toUpperCase().trim()}`;
                    if (existingLookup.has(lookupKey)) {
                        matchedExisting = existingLookup.get(lookupKey);
                        break;
                    }
                }

                if (matchedExisting) {
                    /* ── UPDATE existing record ── */

                    // Merge category ids (union — in case row also maps to another category)
                    const mergedCategoryIds = Array.from(
                        new Set([...matchedExisting.categoryIds, categoryId])
                    );

                    // Merge hymn numbers (new values overwrite same-prefix keys, others preserved)
                    const mergedHymnNumbers = {
                        ...matchedExisting.hymnNumbers,
                        ...hymnNumbers,
                    };

                    const finalAudioPreview = audioPreview || matchedExisting.audioPreviewUrl || null;
                    const finalMusicType    = resolvedMusicType || matchedExisting.hymnalMusicType || null;

                    await mysql.execute(
                        `UPDATE hymnal_music_library
                         SET hymnal_category_id = ?,
                             hymn_title = ?,
                             hymn_author = ?,
                             hymn_numbers = ?,
                             audio_preview_url = ?,
                             hymnal_music_type = ?,
                             updated_at = CURRENT_TIMESTAMP
                         WHERE id = ?`,
                        [
                            JSON.stringify(mergedCategoryIds),
                            hymnTitle,
                            hymnAuthor,
                            JSON.stringify(mergedHymnNumbers),
                            finalAudioPreview,
                            finalMusicType,
                            matchedExisting.id,
                        ]
                    );

                    // Refresh in-memory record & lookup so later rows in the SAME
                    // file also see this update (avoids re-duplicating within one upload)
                    matchedExisting.categoryIds = mergedCategoryIds;
                    matchedExisting.hymnNumbers = mergedHymnNumbers;
                    matchedExisting.hymnTitle = hymnTitle;
                    matchedExisting.hymnAuthor = hymnAuthor;
                    matchedExisting.audioPreviewUrl = finalAudioPreview;
                    matchedExisting.hymnalMusicType = finalMusicType;
                    registerLookup(matchedExisting);

                    summary.updatedCount++;

                } else {
                    /* ── INSERT new record ── */
                    const [insertResult] = await mysql.execute(
                        `INSERT INTO hymnal_music_library
                        (
                            user_id,
                            hymnal_category_id,
                            hymn_title,
                            hymn_author,
                            hymn_numbers,
                            audio_preview_url,
                            hymnal_music_type
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        [
                            userId,
                            JSON.stringify([categoryId]),
                            hymnTitle,
                            hymnAuthor,
                            JSON.stringify(hymnNumbers),
                            audioPreview || null,
                            resolvedMusicType || null,
                        ]
                    );

                    // Register this new row in the lookup map immediately, so that
                    // if a LATER row in the SAME file repeats this category+number,
                    // it updates this row instead of creating another duplicate.
                    const newRecord = {
                        id: insertResult.insertId,
                        categoryIds: [categoryId],
                        hymnNumbers,
                        hymnTitle,
                        hymnAuthor,
                        audioPreviewUrl: audioPreview || null,
                        hymnalMusicType: resolvedMusicType || null,
                    };
                    registerLookup(newRecord);

                    summary.successCount++;
                }

            } catch (rowErr) {
                summary.failedCount++;
                summary.errors.push({
                    row: excelRow,
                    hymnTitle: row['Hymn Title'] || 'Unknown',
                    message: rowErr.message,
                });
            }
        }

        /* ══════════════════════════════════════════
           STEP 6 — RESPONSE
        ══════════════════════════════════════════ */
        return successResponse(res, summary, 'Bulk songs upload completed');

    } catch (err) {
        console.error('Bulk songs upload error:', err);
        return errorResponse(res, 'Bulk upload failed', 500);
    }
});


/**
 * =====================================================
 * BULK UPLOAD HYMNAL SONGS
 * =====================================================
 * @route   POST /api/hymnal-music/songs/bulk-upload
 * @desc    Bulk upload hymnal songs using excel sheet
 * @access  Private
 *
 * Excel Columns:
 * Hymnal cateorgy name | Year | Title | Composer | Type of Music |
 * BB | MI | Solo Instrument (e) | Choral Settings | Source Page | G4
 */

// router.post(
//     "/songs/bulk-upload",
//     [auth, upload.single("file")],
//     async (req, res) => {
//         try {
//             if (!req.file) {
//                 return errorResponse(res, "Excel file required", 400);
//             }

//             const mysql = getMySQLConnection();
//             const userId = req.user.id;

//             /* ===============================
//                READ EXCEL
//             ===============================*/
//             const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
//             const sheet = workbook.Sheets[workbook.SheetNames[0]];

//             const rows = xlsx.utils.sheet_to_json(sheet, {
//                 defval: "",
//                 raw: false,
//                 blankrows: false
//             });

//             if (!rows.length) {
//                 return errorResponse(res, "Sheet empty", 400);
//             }

//             /* ===============================
//                GET ALL CATEGORIES
//             ===============================*/
//             const [categories] = await mysql.execute(
//                 `SELECT id, publisher FROM hymnal_categories`
//             );

//             const categoryMap = {};
//             categories.forEach(cat => {
//                 categoryMap[cat.publisher] = cat.id;
//             });

//             /* ===============================
//                SUMMARY
//             ===============================*/
//             const summary = {
//                 totalRows: rows.length,
//                 successCount: 0,
//                 failedCount: 0,
//                 errors: []
//             };

//             /* ===============================
//                PROCESS ROWS
//             ===============================*/
//             for (let i = 0; i < rows.length; i++) {
//                 const row = rows[i];
//                 const excelRow = i + 2;

//                 try {

//                     const publisher = row["Hymnal cateorgy name"]?.trim();

//                     if (!publisher) {
//                         throw new Error("Hymnal cateorgy name missing");
//                     }

//                     const categoryId = categoryMap[publisher];

//                     if (!categoryId) {
//                         throw new Error(`Category not found for publisher: ${publisher}`);
//                     }

//                     const title = row["Title"] || "";
//                     const composer = row["Composer"] || "";
//                     const typeOfMusic = row["Type of Music"] || "";
//                     const sourcePage = row["Source Page"] || "";

//                     if (!title || !composer) {
//                         throw new Error("Title or Composer missing");
//                     }

//                     /* ===============================
//                        HYMN NUMBER OBJECT
//                        { categoryId : sourcePage }
//                     ===============================*/

//                     const hymnNumbers = {};
//                     hymnNumbers[categoryId] = sourcePage;

//                     /* ===============================
//                        INSERT
//                     ===============================*/

//                     await mysql.execute(
//                         `INSERT INTO hymnal_music_library
//               (
//                 user_id,
//                 hymnal_category_id,
//                 hymn_title,
//                 hymn_author,
//                 hymn_numbers,
//                 hymnal_music_type
//               )
//               VALUES (?, ?, ?, ?, ?, ?)`,
//                         [
//                             userId,
//                             JSON.stringify([categoryId]),
//                             title,
//                             composer,
//                             JSON.stringify(hymnNumbers),
//                             typeOfMusic || "original"
//                         ]
//                     );

//                     summary.successCount++;

//                 } catch (err) {

//                     summary.failedCount++;

//                     summary.errors.push({
//                         row: excelRow,
//                         title: row["Title"] || "",
//                         message: err.message
//                     });
//                 }
//             }

//             return successResponse(
//                 res,
//                 summary,
//                 "Hymnal songs bulk upload completed"
//             );

//         } catch (err) {
//             console.error(err);
//             return errorResponse(res, "Bulk upload failed", 500);
//         }
//     }
// );

const ExcelJS = require('exceljs');

/* =====================================================
   SONG SAMPLE SHEET DOWNLOAD (PRODUCTION READY)
===================================================== */
/**
 * @route   GET /api/hymnal-music/songs/sample-sheet
 * @query   ?type=google_sheet
 */
// ─────────────────────────────────────────────────────
// 📥  GET /api/hymnal-music/songs/sample-sheet
//     Download a pre-filled .xlsx template with:
//       - Category dropdown (single column)
//       - Music Type dropdown (from type_of_music table)
// ─────────────────────────────────────────────────────
router.get('/songs/sample-sheet', auth, async (_req, res) => {
    try {
        const mysql = getMySQLConnection();

        /* ── Fetch categories (with abbreviation) ── */
        const [categoryRows] = await mysql.execute(
            `SELECT id, category_name, edition_year, hymanl_abbrevation 
             FROM hymnal_categories 
             ORDER BY category_name ASC`
        );

        if (!categoryRows.length) {
            return errorResponse(res, 'No hymnal categories found. Please create categories first.', 400);
        }

        /* ── Fetch music types ── */
        const [musicTypeRows] = await mysql.execute(
            `SELECT id, name FROM type_of_music ORDER BY id ASC`
        );

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Hymnal Songs');

        /* ══════════════════════════════════════════
           HIDDEN SHEET 1 — Category dropdown source
           Col A: "Category Name (Year)"  
           Col B: DB id
           Col C: Hymnal Abbreviation
        ══════════════════════════════════════════ */
        const refSheet = workbook.addWorksheet('_CategoryRef');
        refSheet.state = 'veryHidden';
        refSheet.columns = [
            { header: 'Label',        key: 'label',        width: 30 },
            { header: 'ID',           key: 'id',            width: 10 },
            { header: 'Abbreviation', key: 'abbreviation',  width: 20 },
        ];
        categoryRows.forEach(cat => {
            refSheet.addRow({
                label: `${cat.category_name} (${cat.edition_year})`,
                id: cat.id,
                abbreviation: cat.hymanl_abbrevation || '',
            });
        });
        const categoryDropdownLastRow = categoryRows.length + 1; // +1 for header

        /* ══════════════════════════════════════════
           HIDDEN SHEET 2 — Music Type dropdown source
           Col A: type name
        ══════════════════════════════════════════ */
        const musicTypeRef = workbook.addWorksheet('_MusicTypeRef');
        musicTypeRef.state = 'veryHidden';
        musicTypeRef.columns = [
            { header: 'Name', key: 'name', width: 30 },
        ];
        musicTypeRows.forEach(t => {
            musicTypeRef.addRow({ name: t.name });
        });
        const musicTypeDropdownLastRow = musicTypeRows.length + 1; // +1 for header

        /* ══════════════════════════════════════════
           MAIN SHEET columns
           Hymn Title | Hymn Author | Category Name | Hymnal Abbreviation |
           Hymn Number | Audio Preview URL | Music Type
        ══════════════════════════════════════════ */
        worksheet.columns = [
            { header: 'Hymn Title',          key: 'hymnTitle',           width: 28 }, // col A
            { header: 'Hymn Author',         key: 'hymnAuthor',          width: 24 }, // col B
            { header: 'Category Name',       key: 'categoryName',        width: 30 }, // col C — dropdown
            { header: 'Hymnal Abbreviation', key: 'hymnalAbbreviation',  width: 22 }, // col D — auto (VLOOKUP)
            { header: 'Hymn Number',         key: 'hymnNumber',          width: 18 }, // col E
            { header: 'Audio Preview URL',   key: 'audioPreviewUrl',     width: 35 }, // col F
            { header: 'Music Type',          key: 'musicType',           width: 22 }, // col G — dropdown
        ];

        /* ── Header row styling ── */
        const headerRow = worksheet.getRow(1);
        headerRow.eachCell(cell => {
            cell.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F1F1F' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
        });
        headerRow.height = 20;

        /* ══════════════════════════════════════════
           DATA VALIDATION + AUTO FORMULA — rows 2→1001
        ══════════════════════════════════════════ */
        for (let r = 2; r <= 1001; r++) {

            /* Col C — Category dropdown */
            worksheet.getCell(`C${r}`).dataValidation = {
                type: 'list',
                allowBlank: true,
                formulae: [`_CategoryRef!$A$2:$A$${categoryDropdownLastRow}`],
                showErrorMessage: true,
                errorTitle: 'Invalid Category',
                error: 'Please select a category from the dropdown list.',
            };

            /* Col D — Hymnal Abbreviation (auto-filled via VLOOKUP based on Col C) */
            const abbrCell = worksheet.getCell(`D${r}`);
            abbrCell.value = {
                formula: `IF(C${r}="","",IFERROR(VLOOKUP(C${r},_CategoryRef!$A$2:$C$${categoryDropdownLastRow},3,FALSE),""))`,
            };
            // Visually mark it as read-only / auto-generated
            abbrCell.font = { italic: true, color: { argb: 'FF666666' } };
            abbrCell.protection = { locked: true };

            /* Col G — Music Type dropdown */
            worksheet.getCell(`G${r}`).dataValidation = {
                type: 'list',
                allowBlank: true,
                formulae: [`_MusicTypeRef!$A$2:$A$${musicTypeDropdownLastRow}`],
                showErrorMessage: true,
                errorTitle: 'Invalid Music Type',
                error: 'Please select a music type from the dropdown list.',
            };
        }

        /* ── Sample data row ── */
        const firstCategory = categoryRows[0];
        const firstMusicType = musicTypeRows[0];

        worksheet.getRow(2).getCell(1).value = 'Amazing Grace';                                           // Hymn Title
        worksheet.getRow(2).getCell(2).value = 'John Newton';                                             // Hymn Author
        worksheet.getRow(2).getCell(3).value = `${firstCategory.category_name} (${firstCategory.edition_year})`; // Category Name
        // Col D (Hymnal Abbreviation) already has the VLOOKUP formula set above; no manual value needed
        worksheet.getRow(2).getCell(5).value = 'BB-101';                                                  // Hymn Number
        worksheet.getRow(2).getCell(6).value = 'https://example.com/audio.mp3';                           // Audio Preview URL
        worksheet.getRow(2).getCell(7).value = firstMusicType ? firstMusicType.name : '';                 // Music Type

        /* ── Freeze header + auto-filter ── */
        worksheet.views = [{ state: 'frozen', ySplit: 1 }];
        worksheet.autoFilter = { from: 'A1', to: 'G1' };

        /* ── Sheet protection so formula in Col D can't be overwritten accidentally ── */
        await worksheet.protect('', {
            selectLockedCells: true,
            selectUnlockedCells: true,
            formatCells: true,
            formatColumns: true,
            formatRows: true,
            insertRows: true,
            deleteRows: true,
            sort: true,
            autoFilter: true,
        });
        // Unlock all editable columns (A, B, C, E, F, G) so only D (abbreviation) stays locked/read-only
        ['A', 'B', 'C', 'E', 'F', 'G'].forEach(col => {
            for (let r = 1; r <= 1001; r++) {
                worksheet.getCell(`${col}${r}`).protection = { locked: false };
            }
        });

        /* ── Stream to client ── */
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="hymnal_bulk_upload_template.xlsx"');

        await workbook.xlsx.write(res);
        res.end();

    } catch (err) {
        console.error(err);
        errorResponse(res, 'Failed to generate sample sheet', 500);
    }
});



/**
 * =====================================================
 * SAMPLE SHEET DOWNLOAD (HYMNAL SONGS)
 * =====================================================
 * @route   GET /api/hymnal-music/songs/sample-sheet
 * @query   ?type=google_sheet
 */

// router.get("/songs/sample-sheet", async (req, res) => {
//     try {

//         const { type } = req.query;

//         const columns = [
//             "Hymnal cateorgy name",
//             "Year",
//             "Title",
//             "Composer",
//             "Type of Music",
//             "BB",
//             "MI",
//             "Solo Instrument (e)",
//             "Choral Settings",
//             "Source Page",
//             "G4"
//         ];

//         const sampleRow = [
//             "BB26",
//             "2026",
//             "’Tis Good, Lord, to Be Here",
//             "SWABIA",
//             "Hymn / Song",
//             "",
//             "",
//             "",
//             "",
//             "126",
//             ""
//         ];

//         const data = [columns, sampleRow];

//         /* ===============================
//            CSV (Google Sheet)
//         ===============================*/
//         if (type === "google_sheet") {

//             const sheet = xlsx.utils.aoa_to_sheet(data);

//             const csv = xlsx.write(
//                 { Sheets: { Sample: sheet }, SheetNames: ["Sample"] },
//                 { bookType: "csv", type: "buffer" }
//             );

//             res.setHeader(
//                 "Content-Disposition",
//                 'attachment; filename="hymnal_songs_sample.csv"'
//             );

//             res.setHeader("Content-Type", "text/csv");

//             return res.send(csv);
//         }

//         /* ===============================
//            Excel
//         ===============================*/
//         const workbook = xlsx.utils.book_new();

//         const sheet = xlsx.utils.aoa_to_sheet(data);

//         sheet["!cols"] = columns.map(col => ({ wch: col.length + 5 }));

//         xlsx.utils.book_append_sheet(workbook, sheet, "Sample");

//         const buffer = xlsx.write(workbook, {
//             type: "buffer",
//             bookType: "xlsx"
//         });

//         res.setHeader(
//             "Content-Disposition",
//             'attachment; filename="hymnal_songs_sample.xlsx"'
//         );

//         res.setHeader(
//             "Content-Type",
//             "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
//         );

//         return res.send(buffer);

//     } catch (err) {
//         console.error(err);
//         return errorResponse(res, "Failed to generate sample sheet", 500);
//     }
// });

/* =====================================================
   USER PERSONAL MUSIC LIBRARY (SEPARATE ENDPOINTS)
===================================================== */

/**
 * @route   POST /api/hymnal-music/personal-library
 * @desc    Add song to personal library WITH file upload support
 * @access  Private
 * @returns { entryId: uuid } - Unique ID for this library entry
 */
router.post('/personal-library', auth, 
  hymnalMusicUpload.fields([{ name: 'customFiles', maxCount: 10 }]),
  async (req, res) => {
    try {
      const mysql = getMySQLConnection();
      const userId = req.user.id;
      const userType = req.user.user_type;
      const parentUserId = req.user.parent_user_id;

      const { hymnalSongId, songName, songAuthor, customNotes, tags } = req.body;

      if (!hymnalSongId) {
        return errorResponse(res, 'hymnalSongId is required', 400);
      }

      let finalUserId = userId;
      if ((userType === 'sub_user' || userType === 'manager') && parentUserId) {
        finalUserId = parentUserId;
      }

      // ✅ Optimized: Only fetch needed columns
      const [rows] = await mysql.execute(
        `SELECT user_personal_music, hymn_title, hymn_author, hymnal_files
         FROM hymnal_music_library
         WHERE id = ? LIMIT 1`,
        [hymnalSongId]
      );

      if (!rows.length) {
        return errorResponse(res, 'Hymnal song not found', 404);
      }

      const song = rows[0];

      // Process files
      const customFiles = req.files?.customFiles || [];
      const customFilesPayload = customFiles.map((file) => ({
        designation: 'user-uploaded',
        instruments: [],
        customInstrument: file.originalname,
        file: {
          url: file.location,
          name: file.originalname,
          size: file.size,
          type: file.mimetype
        }
      }));

      // Parse existing data
      let personalMusicData = song.user_personal_music
        ? JSON.parse(song.user_personal_music)
        : {};

      if (!personalMusicData[finalUserId]) {
        personalMusicData[finalUserId] = [];
      }

      // ✅ Generate unique ID for entry
      const entryId = uuidv4();

      // ✅ Check duplicates early (before building large object)
      const exists = personalMusicData[finalUserId].some(
        item => item.hymnalSongId === hymnalSongId
      );

      if (exists) {
        return errorResponse(res, 'This song is already in your personal library', 400);
      }

      // Build entry with ID
      const baseSongFiles = parseJsonSafe(song.hymnal_files, []);
      const mergedSongFiles = [...baseSongFiles, ...customFilesPayload];
      
      const personalMusicEntry = {
        id: entryId, // ✅ UNIQUE ID
        hymnalSongId: hymnalSongId,
        songName: songName || song.hymn_title,
        songAuthor: songAuthor || song.hymn_author,
        songFiles: mergedSongFiles,
        customNotes: customNotes || null,
        tags: Array.isArray(tags) ? tags : [],
        addedAt: new Date().toISOString()
      };

      personalMusicData[finalUserId].push(personalMusicEntry);

      await mysql.execute(
        `UPDATE hymnal_music_library SET user_personal_music = ? WHERE id = ?`,
        [JSON.stringify(personalMusicData), hymnalSongId]
      );

      successResponse(res, { 
        entryId, 
        ...personalMusicEntry 
      }, 'Song added to personal library');
    } catch (err) {
      console.error(err);
      errorResponse(res, 'Failed to add song to personal library', 500);
    }
  }
);

/**
 * @route   GET /api/hymnal-music/personal-library
 * @desc    Get user's personal music library (optimized)
 * @access  Private
 * @query   ?songId=<hymnalSongId> - Optional: filter for specific hymnal song
 */
router.get('/personal-library', auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const userId = req.user.id;
        const userType = req.user.user_type;
        const parentUserId = req.user.parent_user_id;

        let finalUserId = userId;
        if ((userType === 'sub_user' || userType === 'manager') && parentUserId) {
            finalUserId = parentUserId;
        }

        const { songId } = req.query;

        // ✅ Optimized: Only fetch needed column
        let query = `SELECT id, user_personal_music FROM hymnal_music_library WHERE user_personal_music IS NOT NULL`;
        const params = [];

        if (songId) {
            query += ` AND id = ?`;
            params.push(songId);
        }

        query += ` LIMIT 50`; // ✅ Safety limit

        const [rows] = await mysql.execute(query, params);

        const personalLibrary = [];

        rows.forEach(row => {
            const musicData = parseJsonSafe(row.user_personal_music, {});
            if (musicData[finalUserId]) {
                personalLibrary.push(...musicData[finalUserId]);
            }
        });

        successResponse(res, personalLibrary, 'Personal library fetched');
    } catch (err) {
        console.error(err);
        errorResponse(res, 'Failed to fetch personal library', 500);
    }
});

/**
 * @route   DELETE /api/hymnal-music/personal-library/:hymnalSongId/:entryId
 * @desc    Remove song from personal library by unique entry ID (optimized)
 * @access  Private
 * @param   hymnalSongId - Hymnal music library song ID
 * @param   entryId - Unique entry ID (returned from POST)
 */
router.delete('/personal-library/:hymnalSongId/:entryId', auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const userId = req.user.id;
        const userType = req.user.user_type;
        const parentUserId = req.user.parent_user_id;

        const { hymnalSongId, entryId } = req.params;

        if (!entryId) {
            return errorResponse(res, 'entryId is required in URL', 400);
        }

        let finalUserId = userId;
        if ((userType === 'sub_user' || userType === 'manager') && parentUserId) {
            finalUserId = parentUserId;
        }

        // ✅ Fetch only needed column
        const [rows] = await mysql.execute(
            `SELECT user_personal_music FROM hymnal_music_library WHERE id = ? LIMIT 1`,
            [hymnalSongId]
        );

        if (!rows.length) {
            return errorResponse(res, 'Song not found', 404);
        }

        let personalMusicData = rows[0].user_personal_music
            ? JSON.parse(rows[0].user_personal_music)
            : {};

        if (!personalMusicData[finalUserId]) {
            return errorResponse(res, 'No personal library found', 404);
        }

        // ✅ Find and remove by ID (faster than name matching)
        const initialLength = personalMusicData[finalUserId].length;
        personalMusicData[finalUserId] = personalMusicData[finalUserId].filter(
            item => item.id !== entryId
        );

        if (initialLength === personalMusicData[finalUserId].length) {
            return errorResponse(res, 'Entry not found in personal library', 404);
        }

        // Remove user entry if empty
        if (personalMusicData[finalUserId].length === 0) {
            delete personalMusicData[finalUserId];
        }

        await mysql.execute(
            `UPDATE hymnal_music_library SET user_personal_music = ? WHERE id = ?`,
            [
                Object.keys(personalMusicData).length > 0
                    ? JSON.stringify(personalMusicData)
                    : null,
                hymnalSongId
            ]
        );

        successResponse(res, null, 'Song removed from personal library');
    } catch (err) {
        console.error(err);
        errorResponse(res, 'Failed to remove song', 500);
    }
});

/**
 * @route   PUT /api/hymnal-music/personal-library/:hymnalSongId/:entryId
 * @desc    Update notes and add files to personal library entry (optimized)
 * @access  Private
 * @param   hymnalSongId - Hymnal music library song ID
 * @param   entryId - Unique entry ID (returned from POST)
 * @body    { customNotes: string (optional) }
 * @files   customFiles (optional) - Up to 10 files
 */
router.put('/personal-library/:hymnalSongId/:entryId', auth, hymnalMusicUpload.fields([{ name: 'customFiles', maxCount: 10 }]), async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const userId = req.user.id;
        const userType = req.user.user_type;
        const parentUserId = req.user.parent_user_id;

        const { hymnalSongId, entryId } = req.params;
        const { customNotes } = req.body;

        if (!entryId) {
            return errorResponse(res, 'entryId is required in URL', 400);
        }

        let finalUserId = userId;
        if ((userType === 'sub_user' || userType === 'manager') && parentUserId) {
            finalUserId = parentUserId;
        }

        // Process files
        const newFiles = req.files?.customFiles || [];
        const newFilesPayload = newFiles.map((file) => ({
            designation: 'user-uploaded',
            instruments: [],
            customInstrument: file.originalname,
            file: {
                url: file.location,
                name: file.originalname,
                size: file.size,
                type: file.mimetype
            }
        }));

        // ✅ Fetch only needed column
        const [rows] = await mysql.execute(
            `SELECT user_personal_music FROM hymnal_music_library WHERE id = ? LIMIT 1`,
            [hymnalSongId]
        );

        if (!rows.length) {
            return errorResponse(res, 'Song not found', 404);
        }

        let personalMusicData = rows[0].user_personal_music
            ? JSON.parse(rows[0].user_personal_music)
            : {};

        if (!personalMusicData[finalUserId]) {
            return errorResponse(res, 'No personal library found', 404);
        }

        // ✅ Find entry by ID (faster than name matching)
        const songEntry = personalMusicData[finalUserId].find(
            item => item.id === entryId
        );

        if (!songEntry) {
            return errorResponse(res, 'Entry not found in personal library', 404);
        }

        // Update fields
        if (customNotes !== undefined) {
            songEntry.customNotes = customNotes || null;
        }

        // Merge new files
        if (newFilesPayload.length > 0) {
            songEntry.songFiles = [...(songEntry.songFiles || []), ...newFilesPayload];
        }

        songEntry.updatedAt = new Date().toISOString();

        await mysql.execute(
            `UPDATE hymnal_music_library SET user_personal_music = ? WHERE id = ?`,
            [JSON.stringify(personalMusicData), hymnalSongId]
        );

        successResponse(res, songEntry, 'Personal library entry updated');
    } catch (err) {
        console.error(err);
        errorResponse(res, 'Failed to update personal library entry', 500);
    }
});

module.exports = router;