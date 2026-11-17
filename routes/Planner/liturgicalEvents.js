const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const { getMySQLConnection } = require('../../config/mysql');
const { auth } = require('../../middleware/auth');
const { successResponse, errorResponse } = require('../../utils/response');
const router = express.Router();

/* ======================================================
   MULTER CONFIG
====================================================== */
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
    fileFilter: (req, file, cb) => {
        if (!file.originalname.match(/\.(xlsx|xls|csv)$/i)) {
            return cb(new Error('Only Excel/CSV files are allowed'));
        }
        cb(null, true);
    }
});

function parseJSONCell(value) {
    if (!value) return null;
    try {
        return typeof value === 'object' ? value : JSON.parse(value);
    } catch {
        return null;
    }
}

/**
 * ======================================================
 * @route   POST /api/planners/liturgical-events/bulk-upload
 * @desc    Bulk upload liturgical events (ANY DATE FORMAT SUPPORTED)
 * @access  Admin
 * ======================================================
 */
const safeCell = (val) => val === undefined || val === null ? '' : String(val).trim();

const normalizeCalendarDate = (value) => {
    if (!value) return null;

    // YYYY-MM-DD
    if (
        typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(value)
    ) {
        return value;
    }

    // Excel Date Object
    if (value instanceof Date && !isNaN(value)) {
        const y = value.getFullYear();
        const m = String(value.getMonth() + 1).padStart(2, '0');
        const d = String(value.getDate()).padStart(2, '0');

        return `${y}-${m}-${d}`;
    }

    // Excel Serial Number
    if (typeof value === 'number') {
        const excelEpoch = new Date(Date.UTC(1899, 11, 30));
        const date = new Date(excelEpoch.getTime() + value * 86400000);

        const y = date.getUTCFullYear();
        const m = String(date.getUTCMonth() + 1).padStart(2, '0');
        const d = String(date.getUTCDate()).padStart(2, '0');

        return `${y}-${m}-${d}`;
    }

    // MM/DD/YYYY
    if (
        typeof value === 'string' &&
        /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value)
    ) {
        const [mm, dd, yyyy] = value.split('/');

        return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    }

    return null;
};


/* ======================================================
   ROUTE
====================================================== */
router.post('/bulk-upload', [auth, upload.single('file')], async (req, res) => {
    try {
        if (!['admin', 'superadmin'].includes(req.user.user_type)) {
            return errorResponse(res, 'Only admins can bulk upload', 403);
        }

        if (!req.file) {
            return errorResponse(res, 'Excel/CSV file is required', 400);
        }

        const mysqlConnection = getMySQLConnection();


        /* ==============================
           Parse Excel
        ============================== */
        const workbook = xlsx.read(req.file.buffer, {
            type: 'buffer',
            cellDates: true,
            raw: true
        });

        const sheet = workbook.Sheets[workbook.SheetNames[0]];

        const rows = xlsx.utils.sheet_to_json(sheet, {
            defval: '',
            raw: true
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

        /* ==============================
           VALIDATE ROW LIMIT
        ============================== */
        if (rows.length > 5000) {
            return errorResponse(res, 'Maximum 5000 rows allowed per upload', 400);
        }

        /* ==============================
           PROCESS
        ============================== */
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const excelRow = i + 2;

            try {
                const event_title = safeCell(row['Event Title']);

                const calendar_date = normalizeCalendarDate(row['Calendar Date']);

                if (!event_title)
                    throw new Error('Event Title is required');

                if (!calendar_date)
                    throw new Error('Invalid Calendar Date');

                const payload = [
                    event_title,
                    calendar_date,
                    safeCell(row['Liturgical Year']),
                    safeCell(row['Season']),
                    safeCell(row['Rank']),
                    safeCell(row['Liturgical Color']),
                    safeCell(row['Lectionary Number']),
                    safeCell(row['First Reading']),
                    safeCell(row['First Reading Description']),
                    safeCell(row['Responsorial Psalm']),
                    safeCell(row['Responsorial Psalm Refrain']),
                    safeCell(row['Second Reading']),
                    safeCell(row['Second Reading Description']),
                    safeCell(row['Gospel Acclamation']),
                    safeCell(row['Gospel']),
                    safeCell(row['Gospel Description']),
                    safeCell(row['USCCB URL']),
                    safeCell(row['Notes']),
                    JSON.stringify(parseJSONCell(row['Metadata']) || {})
                ];

                await mysqlConnection.execute(
                    `INSERT INTO liturgical_events (
                        event_title,
                        calendar_date,
                        liturgical_year,
                        season,
                        rank,
                        liturgical_color,
                        lectionary_number,
                        first_reading,
                        first_reading_description,
                        responsorial_psalm,
                        responsorial_psalm_refrain,
                        second_reading,
                        second_reading_description,
                        gospel_acclamation,
                        gospel,
                        gospel_description,
                        usccb_url,
                        notes,
                        metadata,
                        created_at,
                        updated_at
                    ) VALUES (
                        ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP()
                    )`,
                    payload
                );

                summary.successCount++;
            } catch (err) {
                summary.failedCount++;
                summary.errors.push({
                    row: excelRow,
                    event_title: row['Event Title'] || '',
                    message: err.message
                });
            }
        }

        return successResponse(res, summary, 'Bulk liturgical events upload completed');

    } catch (error) {
        console.error('❌ BULK UPLOAD ERROR:', error);
        return errorResponse(res, 'Bulk upload failed', 500);
    }
});

/**
 * ======================================================
 * @route   GET /api/planners/liturgical-events/sample-sheet
 * @desc    Bulk upload liturgical events
 * @query   ?type=google_sheet
 * @access  Admin
 * ======================================================
 */
router.get('/sample-sheet', async (req, res) => {
    try {
        // if (!['admin', 'superadmin'].includes(req.user.user_type)) {
        //     return errorResponse(res, 'Unauthorized', 403);
        // }
        console.log("Ho")
        const columns = [
            'Event Title',
            'Calendar Date',
            'Liturgical Year',
            'Season',
            'Rank',
            'Liturgical Color',
            'Lectionary Number',
            'First Reading',
            'Responsorial Psalm',
            'Second Reading',
            'Gospel Acclamation',
            'Gospel',
            'USCCB URL',
            'First Reading Description',
            'Responsorial Psalm Refrain',
            'Second Reading Description',
            'Gospel Description',
            'Notes',
            'Metadata'
        ];

        const exampleRow = [
            'Feast of the Baptism of the Lord',
            '2025-01-12',
            'Year C',
            'Christmas',
            'Feast',
            'White',
            '21',
            'Isaiah 40:1-5',
            'Comfort my people',
            'Psalm 104',
            'O bless the Lord, my soul',
            'Titus 3:4-7',
            'Saved through baptism',
            'Alleluia',
            'Luke 3:15-16',
            'Jesus baptized',
            'https://bible.usccb.org',
            'End of Christmas season',
            '{"is_holy_day": false}'
        ];

        const data = [columns, exampleRow];

        /* ---------- GOOGLE SHEET (CSV) ---------- */
        if (req.query.type === 'google_sheet') {
            const ws = xlsx.utils.aoa_to_sheet(data);
            const csv = xlsx.write(
                { Sheets: { Sample: ws }, SheetNames: ['Sample'] },
                { bookType: 'csv', type: 'buffer' }
            );

            res.setHeader(
                'Content-Disposition',
                'attachment; filename="liturgical_events_sample.csv"'
            );
            res.setHeader('Content-Type', 'text/csv');
            return res.send(csv);
        }

        /* ---------- EXCEL ---------- */
        const wb = xlsx.utils.book_new();
        const ws = xlsx.utils.aoa_to_sheet(data);

        ws['!cols'] = columns.map(() => ({ wch: 28 }));
        xlsx.utils.book_append_sheet(wb, ws, 'Sample');

        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

        res.setHeader(
            'Content-Disposition',
            'attachment; filename="liturgical_events_sample.xlsx"'
        );
        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );

        return res.send(buffer);

    } catch (error) {
        console.error('❌ SAMPLE SHEET ERROR:', error);
        return errorResponse(res, 'Failed to generate sample sheet', 500);
    }
});

/**
 * ======================================================
 * @route   POST /api/planners/liturgical-events
 * @desc    Create Liturgical Event (DATE Safe)
 * @access  Admin
 * ======================================================
 */
router.post('/', async (req, res) => {
    try {
        const {
            event_title,
            calendar_date,
            liturgical_year,
            season,
            rank,
            liturgical_color,
            lectionary_number,
            first_reading,
            first_reading_description,
            responsorial_psalm,
            responsorial_psalm_refrain,
            second_reading,
            second_reading_description,
            gospel_acclamation,
            gospel,
            gospel_description,
            usccb_url,
            notes,
            metadata,
            attached_mass_template
        } = req.body;

        const mysqlConnection = getMySQLConnection();

        /* --------------------------------------------------
           1️⃣ VALIDATION
        -------------------------------------------------- */
        if (!event_title || !calendar_date) {
            return errorResponse(res, 'Event title and calendar date are required', 400);
        }

        /* --------------------------------------------------
           2️⃣ NORMALIZE DATE (YYYY-MM-DD)
           Accepts:
           - 2026-03-22
           - 2026-03-22T00:00:00Z
           - any ISO
        -------------------------------------------------- */

        const normalizedDate = normalizeCalendarDate(calendar_date);

        if (!normalizedDate) {
            return errorResponse(res, 'Invalid calendar_date format', 400);
        }

        /* --------------------------------------------------
           3️⃣ INSERT EVENT (DATE STORED)
        -------------------------------------------------- */
        const [result] = await mysqlConnection.execute(
            `INSERT INTO liturgical_events (
                event_title,
                calendar_date,
                liturgical_year,
                season,
                rank,
                liturgical_color,
                lectionary_number,
                first_reading,
                first_reading_description,
                responsorial_psalm,
                responsorial_psalm_refrain,
                second_reading,
                second_reading_description,
                gospel_acclamation,
                gospel,
                gospel_description,
                usccb_url,
                notes,
                metadata,
                created_at,
                updated_at,
                attached_mass_template
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?)`,
            [
                event_title,
                normalizedDate,
                liturgical_year || null,
                season || null,
                rank || null,
                liturgical_color || null,
                lectionary_number || null,
                first_reading || null,
                first_reading_description || null,
                responsorial_psalm || null,
                responsorial_psalm_refrain || null,
                second_reading || null,
                second_reading_description || null,
                gospel_acclamation || null,
                gospel || null,
                gospel_description || null,
                usccb_url || null,
                notes || null,
                JSON.stringify(metadata || {}),
                attached_mass_template ? JSON.stringify(attached_mass_template) : null
            ]
        );

        return successResponse(
            res,
            {
                id: result.insertId,
                calendar_date: normalizedDate
            },
            'Liturgical event created successfully',
            201
        );

    } catch (error) {
        console.error('❌ CREATE LITURGICAL EVENT ERROR:', error);
        return errorResponse(res, 'Failed to create liturgical event', 500);
    }
});

/**
 * ======================================================
 * @route   GET /api/planners/liturgical-events
 * @desc    Fetch Liturgical Events with Pagination, Filters & Sorting *
 * @query   page               Page number (default: 1)
 * @query   limit              Records per page (default: 10) *
 * @query   date               Exact calendar date (YYYY-MM-DD)
 * @query   from_date          Start date for range filter (YYYY-MM-DD)
 * @query   to_date            End date for range filter (YYYY-MM-DD) *
 * @query   liturgical_year    Liturgical year (e.g. Year A, Year B, Year C)
 * @query   season             Liturgical season (Advent, Christmas, Lent, Easter, Ordinary Time)
 * @query   liturgical_color   Liturgical color (White, Green, Purple, Red, Rose)
 * @query   rank               Liturgical rank (Solemnity, Feast, Memorial, Optional Memorial) *
 * @query   search             Keyword search across title, readings & notes *
 * @query   sort_by            Sort field (calendar_date, created_at)
 * @query   sort_order         Sort order (ASC | DESC)
 * @example
 * /api/planners/liturgical-events
 *   ?page=1
 *   &limit=20
 *   &from_date=2025-01-01
 *   &to_date=2025-12-31
 *   &liturgical_year=Year C
 *   &season=Ordinary Time
 *   &liturgical_color=Green
 *   &rank=Feast
 *   &search=Jesus
 *   &sort_by=calendar_date
 *   &sort_order=ASC
 *
 * @access  Admin
 * ======================================================
 */
router.get('/', async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        /* =====================================================
           1️⃣ PAGINATION (OPTIONAL)
        ===================================================== */
        const page = parseInt(req.query.page, 10) || 1;
        const limit = req.query.limit ? parseInt(req.query.limit, 10) : null;
        const offset = limit ? (page - 1) * limit : 0;
        /* =====================================================
           2️⃣ FILTER PARAMS
        ===================================================== */
        const {
            date,
            from_date,
            to_date,
            liturgical_year,
            season,
            liturgical_color,
            rank,
            search,
            calendar,
            year
        } = req.query;

        /* =====================================================
           3️⃣ WHERE CLAUSE
        ===================================================== */

        let whereClause = ' WHERE 1=1 ';
        const values = [];

        /* ---------- DATE FILTERS ---------- */

        if (date) {
            whereClause += ' AND calendar_date = ? ';
            values.push(date);
        }

        if (from_date) {
            whereClause += ' AND calendar_date >= ? ';
            values.push(from_date);
        }

        if (to_date) {
            whereClause += ' AND calendar_date <= ? ';
            values.push(to_date);
        }

        /* ---------- YEAR FILTER ---------- */

        if (year) {
            whereClause += ' AND YEAR(calendar_date) = ? ';
            values.push(parseInt(year));
        }

        /* ---------- MONTH FILTER (calendar=jan/feb/etc.) ---------- */

        if (calendar) {
            const monthMap = {
                jan: 1,
                feb: 2,
                mar: 3,
                apr: 4,
                may: 5,
                jun: 6,
                jul: 7,
                aug: 8,
                sep: 9,
                oct: 10,
                nov: 11,
                dec: 12
            };

            const monthNumber = monthMap[calendar.toLowerCase()];

            if (monthNumber) {
                whereClause += ' AND MONTH(calendar_date) = ? ';
                values.push(monthNumber);
            }
        }

        /* ---------- OTHER FILTERS ---------- */

        if (liturgical_year) {
            whereClause += ' AND liturgical_year = ? ';
            values.push(liturgical_year);
        }

        if (season) {
            whereClause += ' AND season = ? ';
            values.push(season);
        }

        if (liturgical_color) {
            whereClause += ' AND liturgical_color = ? ';
            values.push(liturgical_color);
        }

        if (rank) {
            whereClause += ' AND rank = ? ';
            values.push(rank);
        }

        /* ---------- SEARCH ---------- */

        if (search) {
            whereClause += `
                AND (
                    event_title LIKE ?
                OR notes LIKE ?
                OR first_reading LIKE ?
                OR second_reading LIKE ?
                OR gospel LIKE ?
                )
            `;
            const keyword = `%${search}%`;
            values.push(keyword, keyword, keyword, keyword, keyword);
        }

        /* =====================================================
           4️⃣ TOTAL COUNT
        ===================================================== */

        const [countRows] = await mysqlConnection.execute(
            `SELECT COUNT(*) AS total FROM liturgical_events ${whereClause}`,
            values
        );

        const total = countRows[0].total;
        const totalPages = limit ? Math.ceil(total / limit) : 1;

        /* =====================================================
           5️⃣ FETCH DATA
        ===================================================== */

        let fetchQuery = `
            SELECT
                id,
                event_title,
                DATE_FORMAT(calendar_date, '%Y-%m-%d') AS calendar_date,
                liturgical_year,
                season,
                rank,
                liturgical_color,
                lectionary_number,
                first_reading,
                first_reading_description,
                responsorial_psalm,
                responsorial_psalm_refrain,
                second_reading,
                second_reading_description,
                gospel_acclamation,
                gospel,
                gospel_description,
                usccb_url,
                notes,
                metadata,
                liturgical_songs,
                created_at,
                updated_at,
                attached_mass_template
            FROM liturgical_events
            ${whereClause}
            ORDER BY calendar_date ASC, id ASC
        `;

        let queryValues = [...values];

        if (limit) {
            fetchQuery += ' LIMIT ? OFFSET ? ';
            queryValues.push(limit, offset);
        }

        const [rows] = await mysqlConnection.execute(fetchQuery, queryValues);
        const parseJSON = rows.map(row => {
            row.liturgical_songs = row.liturgical_songs ? JSON.parse(row.liturgical_songs) : [];
            row.attached_mass_template = row.attached_mass_template ? JSON.parse(row.attached_mass_template) : null;
            return row;
        });

        /* =====================================================
           6️⃣ RESPONSE
        ===================================================== */

        return successResponse(
            res,
            {
                data: parseJSON,
                pagination: {
                    total,
                    page,
                    limit: limit || 'All',
                    totalPages
                }
            },
            'Liturgical events fetched successfully'
        );

    } catch (error) {
        console.error('❌ FETCH LITURGICAL EVENTS ERROR:', error);
        return errorResponse(res, 'Failed to fetch liturgical events', 500);
    }
});

/**
 * ======================================================
 * @route   GET /api/planners/liturgical-events/:id
 * @desc    Get Liturgical Event by ID
 * @access  Admin
 * ======================================================
 */
router.get('/:id', async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const eventId = req.params.id;

        /* --------------------------------------------------
           1️⃣ FETCH EVENT
        -------------------------------------------------- */
        const [rows] = await mysqlConnection.execute(
            `SELECT
                id,
                event_title,
                DATE_FORMAT(calendar_date, '%Y-%m-%d') AS calendar_date,
                liturgical_year,
                season,
                rank,
                liturgical_color,
                lectionary_number,
                first_reading,
                first_reading_description,
                responsorial_psalm,
                responsorial_psalm_refrain,
                second_reading,
                second_reading_description,
                gospel_acclamation,
                gospel,
                gospel_description,
                usccb_url,
                notes,
                metadata,
                liturgical_songs,
                created_at,
                updated_at,
                attached_mass_template
            FROM liturgical_events
            WHERE id = ?`,
            [eventId]
        );

        if (rows.length === 0) {
            return errorResponse(res, 'Liturgical event not found', 404);
        }

        const event = rows[0];

        /* --------------------------------------------------
           2️⃣ PARSE JSON FIELDS SAFELY
        -------------------------------------------------- */
        try {
            event.metadata = event.metadata ? JSON.parse(event.metadata) : {};
        } catch {
            event.metadata = {};
        }

        try {
            event.liturgical_songs = event.liturgical_songs
                ? JSON.parse(event.liturgical_songs)
                : [];
        } catch {
            event.liturgical_songs = [];
        }

        try {
            event.attached_mass_template = event.attached_mass_template
                ? JSON.parse(event.attached_mass_template)
                : null;
        } catch {
            event.attached_mass_template = null;
        }

        /* --------------------------------------------------
           3️⃣ RESPONSE
        -------------------------------------------------- */
        return successResponse(
            res,
            event,
            'Liturgical event fetched successfully'
        );

    } catch (error) {
        console.error('❌ FETCH LITURGICAL EVENT ERROR:', error);
        return errorResponse(res, 'Failed to fetch liturgical event', 500);
    }
});

/**
 * ======================================================
 * @route   PUT /api/planners/liturgical-events/:id
 * @desc    Update Liturgical Event
 * @access  Admin
 * ======================================================
 */
router.put('/:id', async (req, res) => {
    try {
        const eventId = req.params.id;
        const mysqlConnection = getMySQLConnection();
        const body = req.body;

        /* --------------------------------------------------
           1️⃣ FETCH EXISTING ROW
        -------------------------------------------------- */
        const [existingRows] = await mysqlConnection.execute(
            'SELECT * FROM liturgical_events WHERE id = ?',
            [eventId]
        );

        if (existingRows.length === 0) {
            return errorResponse(res, 'Liturgical event not found', 404);
        }

        const existing = existingRows[0];

        /* --------------------------------------------------
           2️⃣ NORMALIZE DATE
        -------------------------------------------------- */
        let normalizedCalendarDate = existing.calendar_date;
        if (body.calendar_date) {
            normalizedCalendarDate = normalizeCalendarDate(body.calendar_date);
            if (!normalizedCalendarDate) {
                return errorResponse(res, 'Invalid calendar_date format', 400);
            }
        }

        /* --------------------------------------------------
           3️⃣ UPDATE WITH FALLBACK TO EXISTING VALUES
        -------------------------------------------------- */
        await mysqlConnection.execute(
            `UPDATE liturgical_events SET
            event_title = ?,
            calendar_date = ?,
            liturgical_year = ?,
            season = ?,
            rank = ?,
            liturgical_color = ?,
            lectionary_number = ?,
            first_reading = ?,
            first_reading_description = ?,
            responsorial_psalm = ?,
            responsorial_psalm_refrain = ?,
            second_reading = ?,
            second_reading_description = ?,
            gospel_acclamation = ?,
            gospel = ?,
            gospel_description = ?,
            usccb_url = ?,
            notes = ?,
            metadata = ?,
            liturgical_songs = ?,
            attached_mass_template = ?,
            updated_at = UTC_TIMESTAMP()
         WHERE id = ?`,
            [
                body.event_title ?? existing.event_title,
                normalizedCalendarDate ?? existing.calendar_date,
                body.liturgical_year ?? existing.liturgical_year,
                body.season ?? existing.season,
                body.rank ?? existing.rank,
                body.liturgical_color ?? existing.liturgical_color,
                body.lectionary_number ?? existing.lectionary_number,
                body.first_reading ?? existing.first_reading,
                body.first_reading_description ?? existing.first_reading_description,
                body.responsorial_psalm ?? existing.responsorial_psalm,
                body.responsorial_psalm_refrain ?? existing.responsorial_psalm_refrain,
                body.second_reading ?? existing.second_reading,
                body.second_reading_description ?? existing.second_reading_description,
                body.gospel_acclamation ?? existing.gospel_acclamation,
                body.gospel ?? existing.gospel,
                body.gospel_description ?? existing.gospel_description,
                body.usccb_url ?? existing.usccb_url,
                body.notes ?? existing.notes,
                JSON.stringify(body.metadata ?? JSON.parse(existing.metadata || '{}')),
                JSON.stringify(body.liturgical_songs ?? JSON.parse(existing.liturgical_songs || '[]')),
                body.attached_mass_template !== undefined
                    ? (body.attached_mass_template ? JSON.stringify(body.attached_mass_template) : null)
                    : existing.attached_mass_template,
                eventId
            ]
        );

        /* --------------------------------------------------
           4️⃣ FETCH UPDATED ROW
        -------------------------------------------------- */
        const [updatedRows] = await mysqlConnection.execute(
            `SELECT
            id,
            event_title,
            DATE_FORMAT(calendar_date, '%Y-%m-%d') AS calendar_date,
            liturgical_year,
            season,
            rank,
            liturgical_color,
            lectionary_number,
            first_reading,
            first_reading_description,
            responsorial_psalm,
            responsorial_psalm_refrain,
            second_reading,
            second_reading_description,
            gospel_acclamation,
            gospel,
            gospel_description,
            usccb_url,
            notes,
            metadata,
            liturgical_songs,
            created_at,
            updated_at,
            attached_mass_template
         FROM liturgical_events
         WHERE id = ?`,
            [eventId]
        );
        updatedRows[0].liturgical_songs = updatedRows[0].liturgical_songs ? JSON.parse(updatedRows[0].liturgical_songs) : [];
        updatedRows[0].metadata = updatedRows[0].metadata ? JSON.parse(updatedRows[0].metadata) : {};
        updatedRows[0].attached_mass_template = updatedRows[0].attached_mass_template ? JSON.parse(updatedRows[0].attached_mass_template) : null;

        return successResponse(
            res,
            updatedRows[0],
            'Liturgical event updated successfully'
        );
    } catch (error) {
        console.error('❌ UPDATE LITURGICAL EVENT ERROR:', error);
        return errorResponse(res, 'Failed to update liturgical event', 500);
    }
});

/**
 * ======================================================
 * @route   DELETE /api/planners/liturgical-events/:id
 * @desc    Delete Liturgical Event
 * @access  Admin
 * ======================================================
 */
router.delete('/:id', async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();

        const [existing] = await mysqlConnection.execute(
            'SELECT id FROM liturgical_events WHERE id = ?',
            [req.params.id]
        );

        if (existing.length === 0) {
            return errorResponse(res, 'Liturgical event not found', 404);
        }

        await mysqlConnection.execute(
            'DELETE FROM liturgical_events WHERE id = ?',
            [req.params.id]
        );

        return successResponse(
            res,
            null,
            'Liturgical event deleted successfully'
        );

    } catch (error) {
        console.error('❌ DELETE LITURGICAL EVENT ERROR:', error);
        return errorResponse(res, 'Failed to delete liturgical event', 500);
    }
});


module.exports = router;