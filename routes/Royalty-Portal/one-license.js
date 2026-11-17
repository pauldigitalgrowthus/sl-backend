const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const xlsx = require('xlsx');
const { auth } = require('../../middleware/auth');
const { getMySQLConnection } = require('../../config/mysql');
const { successResponse, errorResponse } = require('../../utils/response');
const { recordOneLicenseEarning } = require('../../utils/royaltyEngine');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.match(/\.(xlsx|xls|csv)$/i)) {
      return cb(new Error('Only Excel/CSV files are supported for ONE LICENSE import right now (.xlsx, .xls, .csv)'));
    }
    cb(null, true);
  }
});

/* ============================================================
   WORKSHEET NAME PARSER
   ------------------------------------------------------------
   Parses a ONE LICENSE worksheet tab name into the 3 data points
   the client asked for (License Type, Christian Tradition,
   Territory/Region), matching every pattern in the sample report:

     Annual_Catholic     -> Annual,   Catholic,   US
     Annual_Protestant   -> Annual,   Protestant, US
     Podcast_Catholic    -> Podcast,  Catholic,   US
     Podcast_Protestant  -> Podcast,  Protestant, US
     AU_Annual           -> Annual,   null,       AU
     AU_Podcast          -> Podcast,  null,       AU
     EU_Annual           -> Annual,   null,       EU
     EU_Podcast          -> Podcast,  null,       EU
     Recording           -> Recording, null,      null

   Any worksheet name that doesn't match a known pattern is still
   imported (never skipped) - it just gets revenue_type = the raw
   sheet name and null category/territory, so nothing is silently lost.
============================================================ */
const KNOWN_CATEGORIES = ['Catholic', 'Protestant'];
const KNOWN_TERRITORY_PREFIXES = ['AU', 'EU'];

const parseWorksheetName = (sheetName) => {
  const parts = sheetName.split('_');

  // Single-word sheet, e.g. "Recording"
  if (parts.length === 1) {
    return { revenueType: parts[0], category: null, territoryRegion: null };
  }

  const [first, second] = parts;

  // AU_Annual / AU_Podcast / EU_Annual / EU_Podcast -> territory prefix first
  if (KNOWN_TERRITORY_PREFIXES.includes(first)) {
    return { revenueType: second || null, category: null, territoryRegion: first };
  }

  // Annual_Catholic / Podcast_Protestant -> revenue type first, category second,
  // and per the client's explicit instruction these default to United States
  if (KNOWN_CATEGORIES.includes(second)) {
    return { revenueType: first, category: second, territoryRegion: 'US' };
  }

  // Unrecognized pattern - keep the raw name, don't guess further
  return { revenueType: sheetName, category: null, territoryRegion: null };
};

/* ============================================================
   FUZZY TITLE MATCH (fallback only - NEVER auto-confirmed)
   ------------------------------------------------------------
   Mirrors the exact word-split + AND-LIKE logic used by the public
   composition search (GET /api/user-music-library) so "does this
   ONE LICENSE title match a composition" uses the same matching
   the rest of the app already relies on. ONE LICENSE titles often
   carry the composer's name in parens, e.g.
     "1 Samuel - My Heart Exults in the Lord, My Savior (Johnson)"
   which this search already handles today: punctuation is stripped,
   each remaining word must match somewhere across composition_title
   OR composer_firstname/composer_lastname.

   Per the client's explicit instruction, a title match is ONLY ever
   a suggestion for manual review - it is never used to auto-set
   music_publication_id.
============================================================ */
const findBestTitleMatch = async (mysql, title) => {
  if (!title) return null;

  const cleaned = title.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'’]/g, ' ');
  const keywords = [...new Set(cleaned.split(/\s+/).filter(Boolean))];
  if (keywords.length === 0) return null;

  let where = `WHERE mp.status = 'published' AND mp.toggle = 'active'`;
  const params = [];

  keywords.forEach((keyword) => {
    where += `
      AND (
        mp.composition_title LIKE ?
        OR mp.composer_firstname LIKE ?
        OR mp.composer_lastname LIKE ?
        OR CONCAT(mp.composer_firstname, ' ', mp.composer_lastname) LIKE ?
      )
    `;
    const like = `%${keyword}%`;
    params.push(like, like, like, like);
  });

  const [rows] = await mysql.execute(
    `SELECT mp.id, mp.composition_title
     FROM music_publications mp
     ${where}
     LIMIT 1`,
    params
  );

  return rows[0] || null;
};

// @route   POST /api/royalty/one-license/upload
// @desc    Upload a ONE LICENSE workbook - processes EVERY worksheet
//          (Annual_Catholic, Annual_Protestant, Podcast_Catholic,
//          Podcast_Protestant, AU_Annual, AU_Podcast, EU_Annual,
//          EU_Podcast, Recording, or any others present), preserving
//          which sheet each row came from. Rows matched by exact SKU
//          are auto-processed through the royalty engine; everything
//          else is flagged 'needs_review' with a suggested candidate.
// @body    multipart/form-data { file, report_period }
//          report_period is REQUIRED - individual rows have no date,
//          so the reporting period applies to the whole batch.
// @access  Private (Admin)
router.post('/upload', [auth, upload.single('file')], async (req, res) => {
  const mysql = getMySQLConnection();
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }
    if (!req.file) {
      return errorResponse(res, 'Excel file is required with field name "file"', 400);
    }

    const { report_period, report_name } = req.body;
    if (!report_period) {
      return errorResponse(res, 'report_period is required (e.g. "Jan-Jun 2026") - ONE LICENSE rows carry no date of their own', 400);
    }

    // Dedupe by file content hash - blocks re-uploading the exact same workbook
    const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const [existingUpload] = await mysql.execute(
      `SELECT id, created_at FROM one_license_uploads WHERE file_hash = ?`,
      [fileHash]
    );
    if (existingUpload.length > 0) {
      return errorResponse(
        res,
        `This exact file was already uploaded on ${existingUpload[0].created_at}. Duplicate uploads are blocked.`,
        400
      );
    }

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });

    if (!workbook.SheetNames.length) {
      return errorResponse(res, 'Workbook has no worksheets', 400);
    }

    const [uploadResult] = await mysql.execute(
      `INSERT INTO one_license_uploads
        (file_name, file_hash, uploaded_by, report_name, report_period, status, total_rows, worksheets_processed)
       VALUES (?, ?, ?, ?, ?, 'processing', 0, 0)`,
      [req.file.originalname, fileHash, req.user.id, report_name || null, report_period]
    );
    const uploadId = uploadResult.insertId;

    let totalRows = 0;
    let matchedCount = 0;
    let needsReviewCount = 0;
    let processedCount = 0;
    const perSheetSummary = [];

    // ------------------------------------------------------------
    // Process EVERY worksheet in the workbook - not just the first.
    // ------------------------------------------------------------
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];

      // Read as raw arrays (not object-keyed) so we can reliably skip
      // the "SIMPLY LITURGICAL MUSIC" grouping row on row 2 regardless
      // of exact header spelling, and handle the COPYRIGHT column
      // (which the client said to ignore entirely).
      const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });

      if (rows.length < 2) continue; // empty sheet

      const { revenueType, category, territoryRegion } = parseWorksheetName(sheetName);
      let sheetRowCount = 0;

      // Data starts after the header row (row 0) and the grouping
      // row (row 1, "SIMPLY LITURGICAL MUSIC") - detect data rows by
      // requiring a non-empty SKU in column index 1 (COPYRIGHT is col 0).
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const sku = String(row[1] || '').trim(); // column B: SKU
        if (!sku) continue; // skips the grouping row and any blanks

        const title = String(row[2] || '').trim();          // column C: TITLE
        const registrations = Number(row[3] || 0);           // column D: REGISTRATIONS
        const value = Number(row[4] || 0);                   // column E: VALUE (full precision, not rounded)

        totalRows++;
        sheetRowCount++;

        // ---- SKU-first matching (primary field per client spec) ----
        let musicPublicationId = null;
        let matchMethod = 'needs_review';
        let suggestedId = null;

        const [[bySku]] = await mysql.execute(
          `SELECT id FROM music_publications WHERE unique_id = ? LIMIT 1`,
          [sku]
        );

        if (bySku) {
          musicPublicationId = bySku.id;
          matchMethod = 'sku_exact';
          matchedCount++;
        } else {
          // SKU didn't match - suggest a title-based candidate, but
          // per the client's explicit instruction, NEVER auto-confirm
          // on title similarity alone. Flag for manual review instead.
          const candidate = await findBestTitleMatch(mysql, title);
          suggestedId = candidate ? candidate.id : null;
          needsReviewCount++;
        }

        // Same SKU can legitimately appear on multiple worksheets -
        // these are inserted as separate rows, never merged.
        const [recordResult] = await mysql.execute(
          `INSERT INTO one_license_records
            (upload_id, music_publication_id, source_sheet, revenue_type, category, territory_region,
             sku, title, report_period, registrations, value, match_method,
             suggested_music_publication_id, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            uploadId, musicPublicationId, sheetName, revenueType, category, territoryRegion,
            sku, title, report_period, registrations, value, matchMethod,
            suggestedId, musicPublicationId ? 'matched' : 'unmatched'
          ]
        );

        if (musicPublicationId) {
          const outcome = await recordOneLicenseEarning({
            mysql,
            oneLicenseRecordId: recordResult.insertId,
            processedByUserId: req.user.id
          });
          if (outcome) processedCount++;
        }
      }

      perSheetSummary.push({ sheetName, revenueType, category, territoryRegion, rows: sheetRowCount });
    }

    await mysql.execute(
      `UPDATE one_license_uploads
       SET status = 'completed', total_rows = ?, matched_rows = ?, needs_review_rows = ?,
           processed_rows = ?, worksheets_processed = ?
       WHERE id = ?`,
      [totalRows, matchedCount, needsReviewCount, processedCount, perSheetSummary.length, uploadId]
    );

    successResponse(res, {
      uploadId,
      reportPeriod: report_period,
      worksheetsProcessed: perSheetSummary.length,
      perSheetSummary,
      totalRows,
      matchedRows: matchedCount,
      needsReviewRows: needsReviewCount,
      processedRows: processedCount
    }, 'ONE LICENSE import completed', 201);

  } catch (error) {
    console.error('ONE LICENSE upload error:', error);
    errorResponse(res, 'Failed to process ONE LICENSE import', 500);
  }
});

// @route   GET /api/royalty/one-license/uploads
// @desc    Upload history (SOW 3.3 "Maintain upload history")
// @access  Private
router.get('/uploads', auth, async (req, res) => {
  try {
    const mysql = getMySQLConnection();

    const {
      page = 1,
      limit = 10,
      sort_by,
      sortBy,
      sort_order,
      sortOrder,
    } = req.query;

    const pageNumber = Math.max(parseInt(page, 10) || 1, 1);
    const pageLimit = Math.max(parseInt(limit, 10) || 10, 1);
    const offset = (pageNumber - 1) * pageLimit;

    const rawSortBy = sort_by || sortBy || 'created_at';
    const rawSortOrder = sort_order || sortOrder || 'DESC';
    const order = String(rawSortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const sortColumnMap = {
      id: 'olu.id',
      file_name: 'olu.file_name',
      fileName: 'olu.file_name',
      report_name: 'olu.report_name',
      reportName: 'olu.report_name',
      report_period: 'olu.report_period',
      reportPeriod: 'olu.report_period',
      status: 'olu.status',
      total_rows: 'olu.total_rows',
      totalRows: 'olu.total_rows',
      matched_rows: 'olu.matched_rows',
      matchedRows: 'olu.matched_rows',
      needs_review_rows: 'olu.needs_review_rows',
      needsReviewRows: 'olu.needs_review_rows',
      processed_rows: 'olu.processed_rows',
      processedRows: 'olu.processed_rows',
      created_at: 'olu.created_at',
      createdAt: 'olu.created_at',
    };

    const orderByColumn = sortColumnMap[rawSortBy] || 'olu.created_at';

    // Total Count
    const [[countResult]] = await mysql.execute(
      `SELECT COUNT(*) AS total
       FROM one_license_uploads`
    );

    const total = Number(countResult.total);
    const totalPages = Math.ceil(total / pageLimit);

    // Upload History
    const [uploads] = await mysql.execute(
      `SELECT
          olu.*,
          u.first_name,
          u.last_name
       FROM one_license_uploads olu
       JOIN users u
         ON u.id = olu.uploaded_by
       ORDER BY ${orderByColumn} ${order}
       LIMIT ?
       OFFSET ?`,
      [pageLimit, offset]
    );

    return successResponse(
      res,
      {
        uploads,
        pagination: {
          total,
          page: pageNumber,
          limit: pageLimit,
          totalPages,
          hasNextPage: pageNumber < totalPages,
          hasPreviousPage: pageNumber > 1,
        },
        sorting: {
          sortBy: rawSortBy,
          sortOrder: order,
        },
      },
      'Upload history fetched'
    );
  } catch (error) {
    console.error('Get uploads error:', error);
    return errorResponse(res, 'Failed to fetch upload history', 500);
  }
});

// @route   GET /api/royalty/one-license/uploads/:id/records
// @desc    View records from an upload with filters & pagination
// @access  Private
router.get('/uploads/:id/records', auth, async (req, res) => {
  try {
    const mysql = getMySQLConnection();

    const {
      status,
      source_sheet,
      revenue_type,
      category,
      territory_region,
      match_method,
      search,
      page = 1,
      limit = 10,
      sort_by,
      sortBy,
      sort_order,
      sortOrder,
    } = req.query;

    const pageNumber = Math.max(parseInt(page, 10) || 1, 1);
    const pageLimit = Math.max(parseInt(limit, 10) || 10, 1);
    const offset = (pageNumber - 1) * pageLimit;

    let where = 'WHERE olr.upload_id = ?';
    const params = [req.params.id];

    // Status Filter
    if (status) {
      const validStatuses = ['unmatched', 'matched', 'processed'];

      if (!validStatuses.includes(status)) {
        return errorResponse(
          res,
          `Invalid status. Allowed values: ${validStatuses.join(', ')}`,
          400
        );
      }

      where += ' AND olr.status = ?';
      params.push(status);
    }

    // Source Sheet Filter
    if (source_sheet) {
      where += ' AND olr.source_sheet = ?';
      params.push(source_sheet);
    }

    // Revenue Type Filter
    if (revenue_type) {
      where += ' AND olr.revenue_type = ?';
      params.push(revenue_type);
    }

    // Category Filter
    if (category) {
      where += ' AND olr.category = ?';
      params.push(category);
    }

    // Territory Filter
    if (territory_region) {
      where += ' AND olr.territory_region = ?';
      params.push(territory_region);
    }

    // Match Method Filter
    if (match_method) {
      where += ' AND olr.match_method = ?';
      params.push(match_method);
    }

    // Search Filter (by title or SKU)
    if (search) {
      where += ' AND (olr.title LIKE ? OR olr.sku LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    // -------------------------------
    // Total Count
    // -------------------------------
    const [[countResult]] = await mysql.execute(
      `
      SELECT COUNT(*) AS total
      FROM one_license_records olr
      ${where}
      `,
      params
    );

    const total = Number(countResult?.total || 0);
    const totalPages = Math.ceil(total / pageLimit);

    // -------------------------------
    // Sorting Configuration
    // -------------------------------
    const rawSortBy = sort_by || sortBy || 'id';
    const rawSortOrder = sort_order || sortOrder || 'ASC';
    const order = String(rawSortOrder).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    const sortColumnMap = {
      id: 'olr.id',
      sku: 'olr.sku',
      title: 'olr.title',
      source_sheet: 'olr.source_sheet',
      sourceSheet: 'olr.source_sheet',
      revenue_type: 'olr.revenue_type',
      revenueType: 'olr.revenue_type',
      category: 'olr.category',
      territory_region: 'olr.territory_region',
      territoryRegion: 'olr.territory_region',
      report_period: 'olr.report_period',
      reportPeriod: 'olr.report_period',
      registrations: 'olr.registrations',
      value: 'olr.value',
      match_method: 'olr.match_method',
      matchMethod: 'olr.match_method',
      status: 'olr.status',
      created_at: 'olr.created_at',
      createdAt: 'olr.created_at',
      suggested_title: 'mp_suggested.composition_title',
      suggestedTitle: 'mp_suggested.composition_title',
    };

    const orderByColumn = sortColumnMap[rawSortBy] || 'olr.id';

    // -------------------------------
    // Records
    // -------------------------------
    const [records] = await mysql.execute(
      `
      SELECT
          olr.*,
          mp_suggested.composition_title AS suggested_title
      FROM one_license_records olr
      LEFT JOIN music_publications mp_suggested
          ON mp_suggested.id = olr.suggested_music_publication_id
      ${where}
      ORDER BY ${orderByColumn} ${order}
      LIMIT ?
      OFFSET ?
      `,
      [...params, pageLimit, offset]
    );

    return successResponse(
      res,
      {
        records,
        pagination: {
          total,
          page: pageNumber,
          limit: pageLimit,
          totalPages,
          hasNextPage: pageNumber < totalPages,
          hasPreviousPage: pageNumber > 1,
        },
        filters: {
          status: status || null,
          source_sheet: source_sheet || null,
          revenue_type: revenue_type || null,
          category: category || null,
          territory_region: territory_region || null,
          match_method: match_method || null,
          search: search || null,
        },
        sorting: {
          sortBy: rawSortBy,
          sortOrder: order,
        },
      },
      'Records fetched successfully'
    );
  } catch (error) {
    console.error('Get records error:', error);
    return errorResponse(res, 'Failed to fetch records', 500);
  }
});

// @route   GET /api/royalty/one-license/needs-review
// @desc    Cross-upload queue of everything still awaiting manual match -
//          the admin's single worklist, regardless of which upload it came from
router.get('/needs-review', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const mysql = getMySQLConnection();
    const [records] = await mysql.execute(
      `SELECT olr.*, mp_suggested.composition_title AS suggested_title,
              olu.file_name, olu.report_period
       FROM one_license_records olr
       LEFT JOIN music_publications mp_suggested ON mp_suggested.id = olr.suggested_music_publication_id
       JOIN one_license_uploads olu ON olu.id = olr.upload_id
       WHERE olr.status = 'unmatched'
       ORDER BY olr.created_at DESC`
    );

    successResponse(res, { records, total: records.length }, 'Records needing review fetched');
  } catch (error) {
    console.error('Get needs-review error:', error);
    errorResponse(res, 'Failed to fetch records needing review', 500);
  }
});

// @route   PUT /api/royalty/one-license/records/:id/match
// @desc    Manually confirm which composition a ONE LICENSE record belongs
//          to (used for every 'needs_review' row - title similarity is
//          only ever a suggestion, this is the actual confirmation step),
//          then immediately runs it through the royalty engine.
// @body    { music_publication_id }
router.put('/records/:id/match', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const { music_publication_id } = req.body;
    if (!music_publication_id) return errorResponse(res, 'music_publication_id is required', 400);

    const mysql = getMySQLConnection();

    const [[record]] = await mysql.execute(
      `SELECT * FROM one_license_records WHERE id = ?`,
      [req.params.id]
    );
    if (!record) return errorResponse(res, 'Record not found', 404);
    if (record.status === 'processed') return errorResponse(res, 'Record already processed', 400);

    await mysql.execute(
      `UPDATE one_license_records
       SET music_publication_id = ?, status = 'matched', match_method = 'manual'
       WHERE id = ?`,
      [music_publication_id, req.params.id]
    );

    const outcome = await recordOneLicenseEarning({
      mysql,
      oneLicenseRecordId: req.params.id,
      processedByUserId: req.user.id
    });

    if (!outcome) {
      return errorResponse(res, 'Matched, but royalty calculation failed - check composer_id on the composition', 500);
    }

    successResponse(res, { earningId: outcome.earningId, composerEarning: outcome.composerEarning }, 'Record matched and processed');
  } catch (error) {
    console.error('Match record error:', error);
    errorResponse(res, 'Failed to match record', 500);
  }
});

module.exports = router;
