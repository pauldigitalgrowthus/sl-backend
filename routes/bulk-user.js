const express = require('express');
const router = express.Router();
const multer = require('multer');
const xlsx = require('xlsx');
const bcrypt = require('bcryptjs');

const { auth } = require('../middleware/auth');
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

// Parse JSON fields
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

// Parse boolean fields
function parseBooleanCell(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value ? 1 : 0;

  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'haan', 'ha'].includes(v)) return 1;
  if (['0', 'false', 'no', 'n', 'na'].includes(v)) return 0;
  return 0;
}

// Parse numeric fields
function parseNumberCell(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  return n;
}

// Validate email format
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Generate random password
function generateRandomPassword() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$';
  let password = '';
  for (let i = 0; i < 12; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

/* ------------------------------ Bulk upload API ------------------------------ */

// @route   POST /api/bulk-users/bulk-upload
// @desc    Bulk upload users from Excel
// @access  Private (Admin/Superadmin only)
router.post('/bulk-upload', [auth, upload.single('file')], async (req, res) => {
  try {
    // Check if user is admin or superadmin
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Only admins can bulk upload users', 403);
    }

    if (!req.file) {
      return errorResponse(res, 'Excel file is required with field name "file"', 400);
    }

    const mysqlConnection = getMySQLConnection();
    const uploaderUserId = req.user.id;

    // Parse Excel
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    const rows = xlsx.utils.sheet_to_json(sheet, {
      defval: '',
      raw: false,
      blankrows: false
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
      userPasswords: [], // Store generated passwords for response
    };

    // Process each row
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const excelRowNumber = i + 2; // header = row 1

      try {
        /* ----------------------- EXTRACT COLUMN DATA ---------------------- */

        // REQUIRED: First Name
        const first_name = (
          row['First Name'] ||
          row['first_name'] ||
          row['FirstName'] ||
          ''
        ).trim();

        if (!first_name) {
          throw new Error('First Name is required');
        }

        // REQUIRED: Last Name
        const last_name = (
          row['Last Name'] ||
          row['last_name'] ||
          row['LastName'] ||
          ''
        ).trim();

        if (!last_name) {
          throw new Error('Last Name is required');
        }

        // REQUIRED: Email
        const email = (
          row['Email'] ||
          row['email'] ||
          row['Email Address'] ||
          ''
        ).trim().toLowerCase();

        if (!email) {
          throw new Error('Email is required');
        }

        if (!isValidEmail(email)) {
          throw new Error('Invalid email format');
        }

        // Check if email already exists
        const [existingUsers] = await mysqlConnection.execute(
          'SELECT id FROM users WHERE email = ?',
          [email]
        );

        if (existingUsers.length > 0) {
          throw new Error('Email already exists in database');
        }

        // Password (generate if not provided)
        let plainPassword = (
          row['Password'] ||
          row['password'] ||
          ''
        ).trim();

        if (!plainPassword) {
          plainPassword = generateRandomPassword();
        }

        const hashedPassword = await bcrypt.hash(plainPassword, 10);

        // Phone
        const phone = (
          row['Phone'] ||
          row['phone'] ||
          row['Phone Number'] ||
          null
        );

        // Role
        let role = (
          row['Role'] ||
          row['role'] ||
          'free_user'
        ).toLowerCase().trim();

        if (!['sl_team', 'user', 'free_user'].includes(role)) {
          role = 'free_user';
        }

        // User Type
        let user_type = (
          row['User Type'] ||
          row['user_type'] ||
          'admin'
        ).toLowerCase().trim();

        if (!['admin', 'sub_user', 'superadmin', 'manager'].includes(user_type)) {
          user_type = 'admin';
        }

        // Plan Status
        let plan_status = (
          row['Plan Status'] ||
          row['plan_status'] ||
          'free'
        ).toLowerCase().trim();

        if (!['free', 'active', 'expired', 'cancelled'].includes(plan_status)) {
          plan_status = 'free';
        }

        // Location
        const country = row['Country'] || row['country'] || null;
        const state_province = row['State/Province'] || row['state_province'] || null;
        const city = row['City'] || row['city'] || null;
        const postal_code = row['Postal Code'] || row['postal_code'] || null;
        const address = row['Address'] || row['address'] || null;

        // Profile
        const bio = row['Bio'] || row['bio'] || null;
        const website_url = row['Website URL'] || row['website_url'] || null;
        const twitter_url = row['Twitter URL'] || row['twitter_url'] || null;

        // Preferences
        const language = row['Language'] || row['language'] || 'en';
        const timezone = row['Timezone'] || row['timezone'] || 'UTC';

        // Boolean flags
        const is_composer = parseBooleanCell(
          row['Is Composer'] || row['is_composer'] || 0
        );
        const is_review_board_member = parseBooleanCell(
          row['Is Review Board Member'] || row['is_review_board_member'] || 0
        );
        const is_active = parseBooleanCell(
          row['Is Active'] || row['is_active'] || 1
        );
        const is_verified = parseBooleanCell(
          row['Is Verified'] || row['is_verified'] || 0
        );

        // Numeric fields
        const max_sub_users = parseNumberCell(
          row['Max Sub Users'] || row['max_sub_users'] || 0
        ) || 0;

        /* --------------------------- INSERT USER ------------------------ */

        const insertSql = `
            INSERT INTO users (
              first_name,
              last_name,
              email,
              password,
              phone,
              role,
              user_type,
              plan_status,
              country,
              state_province,
              city,
              postal_code,
              address,
              bio,
              website_url,
              twitter_url,
              language,
              timezone,
              is_composer,
              is_review_board_member,
              is_active,
              is_verified,
              max_sub_users,
              email_verified_at,
              created_at,
              updated_at
            )
            VALUES (
              ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?,
              ?, ?, ?, ?, NOW(), NOW()
            )
          `;

        const params = [
          first_name,
          last_name,
          email,
          hashedPassword,
          phone,
          role,
          user_type,
          plan_status,
          country,
          state_province,
          city,
          postal_code,
          address,
          bio,
          website_url,
          twitter_url,
          language,
          timezone,
          is_composer,
          is_review_board_member,
          is_active,
          is_verified,
          max_sub_users,
          is_verified ? new Date() : null
        ];

        const [result] = await mysqlConnection.execute(insertSql, params);

        console.log(`✅ Inserted row ${excelRowNumber} - User: ${email}`);

        summary.successCount += 1;
        summary.userPasswords.push({
          row: excelRowNumber,
          name: `${first_name} ${last_name}`,
          email: email,
          password: plainPassword
        });

      } catch (rowError) {
        console.error(`❌ Row ${excelRowNumber} failed:`, rowError);
        summary.failedCount += 1;
        summary.errors.push({
          row: excelRowNumber,
          email: row['Email'] || row['email'] || 'Unknown',
          name: `${row['First Name'] || ''} ${row['Last Name'] || ''}`.trim() || 'Unknown',
          message: rowError.message || 'Unknown error',
        });
      }
    }

    return successResponse(
      res,
      {
        ...summary,
        message: `Successfully uploaded ${summary.successCount} users. ${summary.failedCount} failed.`
      },
      'Bulk users upload completed'
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

// @route   GET /api/bulk-users/sample-sheet
// @desc    Download sample Excel/CSV sheet for user bulk upload
// @query   ?type=google_sheet (optional, for CSV format)
// @access  Private (Admin/Superadmin only)
router.get('/sample-sheet', auth, async (req, res) => {
  try {
    // Check if user is admin or superadmin
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Only admins can download sample sheet', 403);
    }

    const { type } = req.query;

    // =============================================================
    // 📌 EXACT COLUMN HEADERS
    // =============================================================
    const columns = [
      'First Name',
      'Last Name',
      'Email',
      'Password',
      'Phone',
      'Role',
      'User Type',
      'Plan Status',
      'Country',
      'State/Province',
      'City',
      'Postal Code',
      'Address',
      'Bio',
      'Website URL',
      'Twitter URL',
      'Language',
      'Timezone',
      'Is Composer',
      'Is Review Board Member',
      'Is Active',
      'Is Verified',
      'Max Sub Users'
    ];

    // =============================================================
    // 🧪 SAMPLE ROWS
    // =============================================================
    const exampleRow1 = [
      'John',
      'Doe',
      'john.doe@example.com',
      'Password123!',
      '+1234567890',
      'user',
      'admin',
      'active',
      'United States',
      'California',
      'Los Angeles',
      '90001',
      '123 Main Street, Apt 4B',
      'Experienced composer and music educator',
      'https://johndoe.com',
      'https://twitter.com/johndoe',
      'en',
      'America/Los_Angeles',
      '1',
      '0',
      '1',
      '1',
      '5'
    ];

    const exampleRow2 = [
      'Jane',
      'Smith',
      'jane.smith@example.com',
      '',  // Empty password will auto-generate
      '+9876543210',
      'sl_team',
      'manager',
      'active',
      'India',
      'Maharashtra',
      'Mumbai',
      '400001',
      '456 Park Avenue',
      'Music reviewer and board member',
      'https://janesmith.com',
      '',
      'en',
      'Asia/Kolkata',
      '0',
      '1',
      '1',
      '1',
      '10'
    ];

    const data = [columns, exampleRow1, exampleRow2];

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
        'attachment; filename="users_bulk_sample.csv"'
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
      const columnData = data.map(row => row[i]);
      return Math.max(...columnData.map(val => String(val || '').length)) + 2;
    });

    worksheet['!cols'] = maxWidths.map(width => ({ wch: Math.min(width, 50) }));

    xlsx.utils.book_append_sheet(workbook, worksheet, 'Sample');

    const excelBuffer = xlsx.write(workbook, {
      type: 'buffer',
      bookType: 'xlsx'
    });

    res.setHeader(
      'Content-Disposition',
      'attachment; filename="users_bulk_sample.xlsx"'
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