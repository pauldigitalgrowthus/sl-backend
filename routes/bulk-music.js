const express = require('express');
const router = express.Router();
const multer = require('multer');
const xlsx = require('xlsx');

const { auth } = require('../middleware/auth');
// const { requireAnyRole } = require('../middleware/roles'); // optional
const { getMySQLConnection } = require('../config/mysql');
const { successResponse, errorResponse } = require('../utils/response');

/* ------------------------ Multer config (Excel upload) ------------------------ */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
  },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.match(/\.(xlsx|xls|csv)$/i)) {
      return cb(new Error('Only Excel files are allowed (.xlsx, .xls, .csv)'));
    }
    cb(null, true);
  },
});

/* ----------------------------- Helper functions ----------------------------- */

// "A,B,C" -> ["A","B","C"]  OR JSON string -> parsed array
function parseArrayCell(value) {
  if (value == null || value === '') return null;

  if (Array.isArray(value)) return value;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    
    // Check if it's a URL or contains http/https
    if (trimmed.includes('http://') || trimmed.includes('https://')) {
      // Split by whitespace, newline, or comma to handle multiple URLs
      const urls = trimmed
        .split(/[\s,\n]+/)
        .map(v => v.trim())
        .filter(v => v && (v.startsWith('http://') || v.startsWith('https://')));
      
      return urls.length > 0 ? urls : null;
    }
    
    // JSON array/object?
    if (
      (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
      (trimmed.startsWith('{') && trimmed.endsWith('}'))
    ) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
        return [parsed];
      } catch (e) {
        // ignore, fallback to comma separated
      }
    }

    // Simple comma separated
    return trimmed
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }

  // koi primitive type aaya to usko single-element array bana do
  return [value];
}

// JSON column ke liye (agar user ne pure JSON diya ho)
function parseJSONCell(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch (e) {
      return null;
    }
  }
  return null;
}

// Boolean flags (0/1 / true/false / yes/no / haan/na)
function parseBooleanCell(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value ? 1 : 0;

  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'haan', 'ha'].includes(v)) return 1;
  if (['0', 'false', 'no', 'n', 'na'].includes(v)) return 0;
  return null;
}

// Numeric fields
function parseNumberCell(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  return n;
}

/* ------------------------------ Bulk upload API ------------------------------ */

// @route   POST /api/bulk-music/bulk-upload
// @desc    Bulk upload music publications from Excel (ONLY SAMPLE SHEET FIELDS)
// @access  Private (SL Team / Admin preferred)
router.post(
  '/bulk-upload',
  [
    auth,
    // requireAnyRole(['sl_team', 'admin']), // uncomment if you want role restriction
    upload.single('file'),
  ],
  async (req, res) => {
    try {
      if (!req.file) {
        return errorResponse(res, 'Excel file is required with field name "file"', 400);
      }

      const mysqlConnection = getMySQLConnection();
      const uploaderUserId = req.user.id; // SL Team/Admin/Composer
      const composerId = uploaderUserId; // sab rows ka composer same

      // Excel parse karo
      const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      
      // Parse with header row
      const rows = xlsx.utils.sheet_to_json(sheet, {
        defval: '', // empty cells -> empty string
        raw: false, // Convert everything to strings first
        blankrows: false // Skip blank rows
      });

      console.log('📊 Total rows parsed:', rows.length);
      if (rows.length > 0) {
        console.log('🔑 Column headers found:', Object.keys(rows[0]));
        console.log('📝 First row data:', rows[0]);
      }

      if (!rows.length) {
        return errorResponse(res, 'Excel sheet is empty or no data rows found', 400);
      }

      const summary = {
        totalRows: rows.length,
        successCount: 0,
        failedCount: 0,
        errors: [],
      };

      // Har row pe loop
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const excelRowNumber = i + 2; // header = row 1

        try {
          /* ----------------------- EXACT COLUMN NAMES FROM EXCEL ---------------------- */
          
          // Column F: Composition Title (REQUIRED)
          const composition_title =
            row['Composition Title'] ||
            row['composition_title'] ||
            row['CompositionTitle'] ||
            row['Composition title'] ||
            '';

          if (!composition_title || String(composition_title).trim() === '') {
            throw new Error('Composition Title is required (Column F)');
          }

          // Column G: Composition Description
          const composition_description =
            row['Composition Description'] ||
            row['composition_description'] ||
            row['description'] ||
            null;

          // Column H: Composer First Name
          const composer_firstname =
            row['Composer First Name'] ||
            row['composer_firstname'] ||
            row['composerFirstName'] ||
            null;

          // Column I: Composer Last Name
          const composer_lastname =
            row['Composer Last Name'] ||
            row['composer_lastname'] ||
            row['composerLastName'] ||
            null;

          // Column J: Vocal Parts
          const vocalPartsRaw =
            row['Vocal Parts (e.g. S, A, T, B)'] ||
            row['Vocal Parts'] ||
            row['vocal_parts'] ||
            row['vocalParts'] ||
            '';

          const vocal_parts = parseArrayCell(vocalPartsRaw);

          // Column K: Instrumentation
          const instrumentationRaw =
            row['Instrumentation (e.g. Piano, Guitar)'] ||
            row['Instrumentation'] ||
            row['instrumentation'] ||
            '';

          const instrumentation = parseArrayCell(instrumentationRaw);

          // Column L: Type of Music
          const types_of_music =
            row['Type of Music'] ||
            row['types_of_music'] ||
            row['type_of_music'] ||
            null;

          // Column M: Liturgical Text
          const liturgicalText =
            row['Liturgical Text'] ||
            row['liturgicalText'] ||
            row['liturgical_text'] ||
            null;

          // Column N: Verse Style
          const verseStyle =
            row['Verse Style'] ||
            row['verseStyle'] ||
            row['verse_style'] ||
            null;

          // Column O: Feast / Celebration
          const feast =
            row['Feast / Celebration'] ||
            row['Feast/Celebration'] ||
            row['feast'] ||
            row['Feast / Occasion'] ||
            null;

          // Column P: Music File URLs (CRITICAL FIX)
          const musicFilesRaw =
            row['Music File URLs (comma separated)'] ||
            row['Music File URLs'] ||
            row['music_files'] ||
            row['Music Files'] ||
            '';

          console.log(`Row ${excelRowNumber} - Raw Music Files:`, musicFilesRaw);

          // Parse music files with better URL detection
          let music_files = null;
          if (musicFilesRaw) {
            const trimmed = String(musicFilesRaw).trim();
            if (trimmed) {
              // Try JSON first
              const jsonParsed = parseJSONCell(trimmed);
              if (jsonParsed) {
                music_files = jsonParsed;
              } else {
                // Split by comma, space, or newline
                music_files = trimmed
                  .split(/[,\n\s]+/)
                  .map(url => url.trim())
                  .filter(url => url && (url.startsWith('http://') || url.startsWith('https://')));
                
                if (music_files.length === 0) {
                  music_files = null;
                }
              }
            }
          }

          console.log(`Row ${excelRowNumber} - Parsed Music Files:`, music_files);

          // Column Q: Music Video Link
          const music_video_link =
            row['Music Video Link'] ||
            row['music_video_link'] ||
            row['Music Video Link (YouTube or others)'] ||
            null;

          // Column R: Artwork Image URL
          const artwork_file_url =
            row['Artwork Image URL'] ||
            row['artwork_file_url'] ||
            row['Artwork File URL'] ||
            null;

          // Column S: Price
          const priceRaw =
            row['Price (leave 0 for free)'] ||
            row['Price'] ||
            row['price'] ||
            '0';

          const price = parseNumberCell(priceRaw) ?? 0;
          const is_free = price > 0 ? 0 : 1;

          /* --------------------------- INSERT WITH PUBLISHED STATUS ------------------------ */
          
          // Terms accepted by default
          const terms_accepted = 1;

          // Admin approval notes - same for all stages
          const reviewerName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || 'Bulk Upload System';
          const reviewerRole = req.user.user_type === 'superadmin' ? 'Superadmin' : 'Admin';
          const approvalNote = `Approved by ${reviewerRole} (${reviewerName}) via Bulk Upload`;

          const insertSql = `
            INSERT INTO music_publications (
              composer_id,
              status,
              review_stage,

              composition_title,
              composition_description,
              composer_firstname,
              composer_lastname,

              vocal_parts,
              instrumentation,
              types_of_music,

              liturgicalText,
              verseStyle,
              feast,

              music_files,
              music_video_link,
              artwork_file_url,

              price,
              is_free,

              terms_accepted,
              terms_accepted_at,

              published_at,
              published_by,

              stage1_decision,
              stage1_reviewed_by,
              stage1_reviewed_at,
              stage1_notes,

              stage2_decision,
              stage2_reviewed_by,
              stage2_reviewed_at,
              stage2_notes,

              stage3_decision,
              stage3_reviewed_by,
              stage3_reviewed_at,
              stage3_notes,

              stage4_decision,
              stage4_reviewed_by,
              stage4_reviewed_at,
              stage4_notes,

              admin_reviewed_by,
              admin_reviewed_at,
              admin_review_notes
            )
            VALUES (
              ?, 'published', 'published',
              ?, ?, ?, ?,
              ?, ?, ?,
              ?, ?, ?,
              ?, ?, ?,
              ?, ?,
              ?, NOW(),
              NOW(), ?,
              'approved', ?, NOW(), ?,
              'approved', ?, NOW(), ?,
              'approved', ?, NOW(), ?,
              'approved', ?, NOW(), ?,
              ?, NOW(), ?
            )
          `;

          const params = [
            composerId,                                    // composer_id
            composition_title,                             // composition_title
            composition_description,                       // composition_description
            composer_firstname,                            // composer_firstname
            composer_lastname,                             // composer_lastname
            vocal_parts ? JSON.stringify(vocal_parts) : null,  // vocal_parts
            instrumentation ? JSON.stringify(instrumentation) : null,  // instrumentation
            types_of_music,                                // types_of_music
            liturgicalText,                                // liturgicalText
            verseStyle,                                    // verseStyle
            feast,                                         // feast
            music_files ? JSON.stringify(music_files) : null,  // music_files
            music_video_link,                              // music_video_link
            artwork_file_url,                              // artwork_file_url
            price,                                         // price
            is_free,                                       // is_free
            terms_accepted,                                // terms_accepted
            uploaderUserId,                                // published_by
            uploaderUserId, approvalNote,                  // stage1
            uploaderUserId, approvalNote,                  // stage2
            uploaderUserId, approvalNote,                  // stage3
            uploaderUserId, approvalNote,                  // stage4
            uploaderUserId, approvalNote                   // admin
          ];

          console.log(`✅ Inserting row ${excelRowNumber} with music_files:`, music_files);

          await mysqlConnection.execute(insertSql, params);

          summary.successCount += 1;
        } catch (rowError) {
          console.error(`❌ Row ${excelRowNumber} failed:`, rowError);
          summary.failedCount += 1;
          summary.errors.push({
            row: excelRowNumber,
            composition: row['Composition Title'] || 'Unknown',
            message: rowError.message || 'Unknown error',
          });
          // continue to next row
        }
      }

      return successResponse(
        res,
        {
          ...summary,
          message: `Successfully uploaded ${summary.successCount} music publications. ${summary.failedCount} failed.`
        },
        'Bulk music publications upload completed'
      );
    } catch (err) {
      console.error('Bulk upload error:', err);
      if (err instanceof multer.MulterError) {
        return errorResponse(res, `File upload error: ${err.message}`, 400);
      }
      return errorResponse(res, 'Failed to process bulk upload', 500);
    }
  }
);

// @route   GET /api/bulk-music/bulk-upload/sample-sheet
// @desc    Download sample sheet (Excel or Google Sheet CSV)
// @query   ?type=google_sheet
// @access  Private
router.get('/bulk-upload/sample-sheet', async (req, res) => {
  try {
    const { type } = req.query;

    // =============================================================
    // 📌 EXACT COLUMN HEADERS (MATCHING YOUR EXCEL)
    // =============================================================
    const columns = [
      'Composition Title',
      'Composition Description',
      'Composer First Name',
      'Composer Last Name',
      'Vocal Parts (e.g. S, A, T, B)',
      'Instrumentation (e.g. Piano, Guitar)',
      'Type of Music',
      'Liturgical Text',
      'Verse Style',
      'Feast / Celebration',
      'Music File URLs (comma separated)',
      'Music Video Link',
      'Artwork Image URL',
      'Price (leave 0 for free)'
    ];

    // =============================================================
    // 🧪 SAMPLE ROW WITH MULTIPLE URLs
    // =============================================================
    const exampleRow = [
      'Sample Composition Title',
      'This is a sample description for the composition',
      'John',
      'Doe',
      'S, A, T, B',
      'Piano, Guitar',
      'Hymn',
      'Liturgical text example',
      'Verse style example',
      'Christmas',
      'https://example.com/music1.pdf, https://example.com/music2.pdf',  // Multiple URLs separated by comma
      'https://youtube.com/sample-video',
      'https://example.com/artwork.jpg',
      '69'
    ];

    const data = [columns, exampleRow];

    // =============================================================
    // 🟢 GOOGLE SHEET → CSV
    // =============================================================
    if (type === 'google_sheet') {
      const worksheet = xlsx.utils.aoa_to_sheet(data);

      const csvBuffer = xlsx.write(
        { Sheets: { Sample: worksheet }, SheetNames: ['Sample'] },
        { bookType: 'csv', type: 'buffer' }
      );

      res.setHeader(
        'Content-Disposition',
        'attachment; filename="music_bulk_sample.csv"'
      );
      res.setHeader('Content-Type', 'text/csv');

      return res.send(csvBuffer);
    }

    // =============================================================
    // 🔵 DEFAULT → EXCEL (.xlsx)
    // =============================================================
    const workbook = xlsx.utils.book_new();
    const worksheet = xlsx.utils.aoa_to_sheet(data);
    
    // Auto-size columns for better readability
    const maxWidths = columns.map((col, i) => {
      const columnData = [col, exampleRow[i]];
      return Math.max(...columnData.map(val => String(val || '').length)) + 2;
    });
    
    worksheet['!cols'] = maxWidths.map(width => ({ wch: width }));
    
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Sample');

    const excelBuffer = xlsx.write(workbook, {
      type: 'buffer',
      bookType: 'xlsx'
    });

    res.setHeader(
      'Content-Disposition',
      'attachment; filename="music_bulk_sample.xlsx"'
    );
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    return res.send(excelBuffer);
  } catch (error) {
    console.error('Sample sheet error:', error);
    return errorResponse(res, 'Failed to generate sample sheet', 500);
  }
});

module.exports = router;
