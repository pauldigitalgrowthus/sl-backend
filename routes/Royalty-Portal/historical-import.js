const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const { auth } = require('../../middleware/auth');
const { getMySQLConnection } = require('../../config/mysql');
const { successResponse, errorResponse } = require('../../utils/response');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.match(/\.(xlsx|xls|csv)$/i)) {
      return cb(new Error('Only Excel/CSV files are supported for historical import'));
    }
    cb(null, true);
  }
});

// @route   GET /api/royalty/historical-import/template
// @desc    Download the expected column template for historical royalty data
router.get('/template', auth, async (req, res) => {
  try {
    const columns = [
      'Composer Email', 'Composition Title', 'Sale Date', 'Sale Price',
      'Source Type (a_la_carte/subscription/one_license)', 'ICEL Deducted',
      'USCCB Deducted', 'CCD Deducted', 'Composer Earning', 'Status (pending/paid)'
    ];
    const exampleRow = [
      'composer@example.com', 'Amazing Grace', '2019-06-15', '25.00',
      'a_la_carte', '1.25', '0.50', '0', '6.98', 'paid'
    ];

    const workbook = xlsx.utils.book_new();
    const worksheet = xlsx.utils.aoa_to_sheet([columns, exampleRow]);
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Historical Import');
    const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=historical_royalty_import_template.xlsx');
    res.send(buffer);
  } catch (error) {
    console.error('Template generation error:', error);
    errorResponse(res, 'Failed to generate template', 500);
  }
});

// @route   POST /api/royalty/historical-import/upload
// @desc    Import historical composer earnings (2017-present, SOW Section 9)
//          Rows are inserted AS-IS (pre-calculated values from old records) -
//          this does NOT re-run the royalty engine, since historical data
//          already has its final numbers from the legacy system.
// @access  Private (Admin)
router.post('/upload', [auth, upload.single('file')], async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }
    if (!req.file) return errorResponse(res, 'File is required with field name "file"', 400);

    const mysql = getMySQLConnection();
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const rows = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
      defval: '', raw: false, blankrows: false
    });

    if (!rows.length) return errorResponse(res, 'File is empty', 400);

    const summary = { totalRows: rows.length, successCount: 0, failedCount: 0, errors: [] };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNumber = i + 2;

      try {
        const composerEmail = String(row['Composer Email'] || '').trim().toLowerCase();
        const compositionTitle = String(row['Composition Title'] || '').trim();
        const saleDate = row['Sale Date'];
        const salePrice = Number(row['Sale Price'] || 0);
        const sourceType = String(row['Source Type (a_la_carte/subscription/one_license)'] || 'a_la_carte').trim();
        const icel = Number(row['ICEL Deducted'] || 0);
        const usccb = Number(row['USCCB Deducted'] || 0);
        const ccd = Number(row['CCD Deducted'] || 0);
        const composerEarning = Number(row['Composer Earning'] || 0);
        const status = String(row['Status (pending/paid)'] || 'paid').trim();

        if (!composerEmail) throw new Error('Composer Email is required');
        if (!compositionTitle) throw new Error('Composition Title is required');

        const [[composer]] = await mysql.execute(
          `SELECT id FROM users WHERE email = ? LIMIT 1`,
          [composerEmail]
        );
        if (!composer) throw new Error(`No user found with email "${composerEmail}"`);

        const [[music]] = await mysql.execute(
          `SELECT id FROM music_publications WHERE composition_title = ? AND composer_id = ? LIMIT 1`,
          [compositionTitle, composer.id]
        );

        const totalDeductions = Number((icel + usccb + ccd).toFixed(2));
        const netAfterDeductions = Number((salePrice - totalDeductions).toFixed(2));

        const [result] = await mysql.execute(
          `INSERT INTO composer_earnings (
            composer_id, music_publication_id, composition_title, sale_price,
            platform_fee_pct, platform_fee_amount, composer_earning,
            status, paid_at, source_type, total_deductions, net_after_deductions,
            royalty_percent, created_at
          ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 30.00, ?)`,
          [
            composer.id, music ? music.id : null, compositionTitle, salePrice,
            Number((salePrice - composerEarning).toFixed(2)), composerEarning,
            status, status === 'paid' ? new Date(saleDate) : null, sourceType,
            totalDeductions, netAfterDeductions, new Date(saleDate)
          ]
        );

        const earningId = result.insertId;
        const deductionMap = { ICEL: icel, USCCB: usccb, CCD: ccd };

        for (const [entityName, amount] of Object.entries(deductionMap)) {
          if (amount <= 0) continue;
          const [[entity]] = await mysql.execute(
            `SELECT id FROM royalty_deduction_entities WHERE name = ? LIMIT 1`,
            [entityName]
          );
          if (entity) {
            const pct = salePrice > 0 ? Number(((amount / salePrice) * 100).toFixed(2)) : 0;
            await mysql.execute(
              `INSERT INTO composer_earning_deductions (composer_earning_id, deduction_entity_id, percent, amount)
               VALUES (?, ?, ?, ?)`,
              [earningId, entity.id, pct, amount]
            );
          }
        }

        summary.successCount++;
      } catch (rowError) {
        summary.failedCount++;
        summary.errors.push({ row: rowNumber, message: rowError.message });
      }
    }

    successResponse(res, summary, `Historical import completed: ${summary.successCount} succeeded, ${summary.failedCount} failed`, 201);
  } catch (error) {
    console.error('Historical import error:', error);
    errorResponse(res, 'Failed to process historical import', 500);
  }
});

module.exports = router;
