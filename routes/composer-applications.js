const express = require('express');
const { getMySQLConnection } = require('../config/mysql');
const { auth } = require('../middleware/auth');
const { requireAnyRole } = require('../middleware/roleAuth');
const { successResponse, errorResponse } = require('../utils/response');
const { composerApplicationUpload, deleteFileFromS3 } = require('../config/s3');
const multer = require('multer');
const xlsx = require('xlsx');
const bcrypt = require('bcryptjs');

const router = express.Router();
const { sendEmail } = require('../utils/SendMailer');
const { createAndDeliverNotification } = require('../utils/notificationUtils');


// Configure multer for Excel file upload
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.originalname.endsWith('.xlsx') ||
      file.originalname.endsWith('.xls')) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel files (.xlsx, .xls) are allowed'), false);
    }
  },
  limits: {
    files: 1 // Only one file per request
  }
});

// @route   POST       
// @desc    Create or update composer application
// @access  Private (Authenticated users)
router.post('/', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Check if user already has an application
    const [existingApplications] = await mysqlConnection.execute(
      'SELECT id, status FROM composer_applications WHERE user_id = ?',
      [userId]
    );

    let applicationId;
    let isNewApplication = false;

    if (existingApplications.length === 0) {
      // Create new application
      const [result] = await mysqlConnection.execute(
        'INSERT INTO composer_applications (user_id, status, application_source) VALUES (?, ?, ?)',
        [userId, 'under_review', 'user_submitted']
      );
      applicationId = result.insertId;
      isNewApplication = true;
    } else {
      applicationId = existingApplications[0].id;

      // Check if application is already approved
      if (existingApplications[0].status === 'approved') {
        return errorResponse(res, 'Application has already been approved and cannot be modified', 400);
      }
    }

    // Update application with all provided data
    let updateFields = [];
    let updateValues = [];

    // Helper function to check if value exists (not undefined, not empty string)
    const hasValue = (val) => val !== undefined && val !== null && val !== '';

    // Basic Information
    if (hasValue(req.body.fullName)) {
      updateFields.push('full_name = ?');
      updateValues.push(req.body.fullName);
    }
    if (hasValue(req.body.email)) {
      updateFields.push('email = ?');
      updateValues.push(req.body.email);
    }
    if (hasValue(req.body.phoneNumber)) {
      updateFields.push('phone_number = ?');
      updateValues.push(req.body.phoneNumber);
    }
    if (hasValue(req.body.streetAddress)) {
      updateFields.push('street_address = ?');
      updateValues.push(req.body.streetAddress);
    }
    if (hasValue(req.body.addressLine2)) {
      updateFields.push('address_line_2 = ?');
      updateValues.push(req.body.addressLine2);
    }
    if (hasValue(req.body.city)) {
      updateFields.push('city = ?');
      updateValues.push(req.body.city);
    }
    if (hasValue(req.body.stateProvince)) {
      updateFields.push('state_province = ?');
      updateValues.push(req.body.stateProvince);
    }
    if (hasValue(req.body.zipCode)) {
      updateFields.push('zip_code = ?');
      updateValues.push(req.body.zipCode);
    }
    if (hasValue(req.body.country)) {
      updateFields.push('country = ?');
      updateValues.push(req.body.country);
    }

    // Music/Composition Background
    if (hasValue(req.body.musicBackground)) {
      updateFields.push('music_background = ?');
      updateValues.push(req.body.musicBackground);
    }
    if (hasValue(req.body.compositionBackground)) {
      updateFields.push('composition_background = ?');
      updateValues.push(req.body.compositionBackground);
    }
    if (req.body.accompanimentTypes && Array.isArray(req.body.accompanimentTypes) && req.body.accompanimentTypes.length > 0) {
      updateFields.push('accompaniment_types = ?');
      updateValues.push(JSON.stringify(req.body.accompanimentTypes));
    }
    if (hasValue(req.body.otherInstrumentation)) {
      updateFields.push('other_instrumentation = ?');
      updateValues.push(req.body.otherInstrumentation);
    }

    // Liturgical Experience and Philosophy
    if (hasValue(req.body.churchAffiliation)) {
      updateFields.push('church_affiliation = ?');
      updateValues.push(req.body.churchAffiliation);
    }
    if (hasValue(req.body.liturgicalDraw)) {
      updateFields.push('liturgical_draw = ?');
      updateValues.push(req.body.liturgicalDraw);
    }
    if (hasValue(req.body.liturgicalPurpose)) {
      updateFields.push('liturgical_purpose = ?');
      updateValues.push(req.body.liturgicalPurpose);
    }

    // Digital Engraving Abilities
    if (hasValue(req.body.notationSoftwareProficiency)) {
      updateFields.push('notation_software_proficiency = ?');
      updateValues.push(req.body.notationSoftwareProficiency);
    }
    if (hasValue(req.body.digitizationMethod)) {
      updateFields.push('digitization_method = ?');
      updateValues.push(req.body.digitizationMethod);
    }
    // FIXED: Handle array properly
    if (req.body.notationSoftwareUsed) {
      updateFields.push('notation_software_used = ?');
      const softwareValue = Array.isArray(req.body.notationSoftwareUsed)
        ? JSON.stringify(req.body.notationSoftwareUsed)
        : req.body.notationSoftwareUsed;
      updateValues.push(softwareValue);
    }

    // Music Submissions - Composition 1
    if (hasValue(req.body.composition1Title)) {
      updateFields.push('composition_1_title = ?');
      updateValues.push(req.body.composition1Title);
    }
    if (hasValue(req.body.composition1LiturgicalUse)) {
      updateFields.push('composition_1_liturgical_use = ?');
      updateValues.push(req.body.composition1LiturgicalUse);
    }
    if (hasValue(req.body.composition1OtherInfo)) {
      updateFields.push('composition_1_other_info = ?');
      updateValues.push(req.body.composition1OtherInfo);
    }
    if (req.body.composition1Files && Array.isArray(req.body.composition1Files) && req.body.composition1Files.length > 0) {
      updateFields.push('composition_1_files = ?');
      updateValues.push(JSON.stringify(req.body.composition1Files));
    }

    // Composition 2
    if (hasValue(req.body.composition2Title)) {
      updateFields.push('composition_2_title = ?');
      updateValues.push(req.body.composition2Title);
    }
    if (hasValue(req.body.composition2LiturgicalUse)) {
      updateFields.push('composition_2_liturgical_use = ?');
      updateValues.push(req.body.composition2LiturgicalUse);
    }
    if (hasValue(req.body.composition2OtherInfo)) {
      updateFields.push('composition_2_other_info = ?');
      updateValues.push(req.body.composition2OtherInfo);
    }
    if (req.body.composition2Files && Array.isArray(req.body.composition2Files) && req.body.composition2Files.length > 0) {
      updateFields.push('composition_2_files = ?');
      updateValues.push(JSON.stringify(req.body.composition2Files));
    }

    // Composition 3
    if (hasValue(req.body.composition3Title)) {
      updateFields.push('composition_3_title = ?');
      updateValues.push(req.body.composition3Title);
    }
    if (hasValue(req.body.composition3LiturgicalUse)) {
      updateFields.push('composition_3_liturgical_use = ?');
      updateValues.push(req.body.composition3LiturgicalUse);
    }
    if (hasValue(req.body.composition3OtherInfo)) {
      updateFields.push('composition_3_other_info = ?');
      updateValues.push(req.body.composition3OtherInfo);
    }
    if (req.body.composition3Files && Array.isArray(req.body.composition3Files) && req.body.composition3Files.length > 0) {
      updateFields.push('composition_3_files = ?');
      updateValues.push(JSON.stringify(req.body.composition3Files));
    }
    if (req.body.publisherName) {
      updateFields.push('publisherName = ?');
      updateValues.push(req.body.publisherName);
    }
    if (req.body.useFullNameAsPublisher) {
      updateFields.push('useFullNameAsPublisher = ?');
      updateValues.push(req.body.useFullNameAsPublisher);
    }

    // Terms & Conditions
    if (req.body.termsAccepted !== undefined) {
      updateFields.push('terms_accepted = ?');
      updateValues.push(req.body.termsAccepted ? 1 : 0);

      if (req.body.termsAccepted) {
        updateFields.push('terms_accepted_at = NOW()');
        // No value needed for NOW()
      }
    }

    if (updateFields.length > 0) {
      updateFields.push('updated_at = NOW()');
      updateValues.push(applicationId);

      const sql = `UPDATE composer_applications SET ${updateFields.join(', ')} WHERE id = ?`;

      // Debug logging
      console.log('SQL:', sql);
      console.log('Values count:', updateValues.length);
      console.log('Placeholders count:', (sql.match(/\?/g) || []).length);

      await mysqlConnection.execute(sql, updateValues);
    }

    // Get updated application
    const [applications] = await mysqlConnection.execute(
      'SELECT * FROM composer_applications WHERE id = ?',
      [applicationId]
    );

    // Parse JSON fields for response
    const application = applications[0];
    if (application.composition_1_files) {
      application.composition_1_files = JSON.parse(application.composition_1_files);
    }
    if (application.composition_2_files) {
      application.composition_2_files = JSON.parse(application.composition_2_files);
    }
    if (application.composition_3_files) {
      application.composition_3_files = JSON.parse(application.composition_3_files);
    }
    if (application.accompaniment_types) {
      application.accompaniment_types = JSON.parse(application.accompaniment_types);
    }
    if (application.notation_software_used) {
      try {
        application.notation_software_used = JSON.parse(application.notation_software_used);
      } catch (e) {
        // If it's already a string or parsing fails, keep as is
      }
    }
    // ================= FETCH BOTH USERS IN ONE QUERY =================
    const [users] = await mysqlConnection.execute(`
    SELECT id, email, first_name, user_type, badges,role
    FROM users
    WHERE is_active = TRUE
    AND role = 'sl_team'
  `);
    const applicantName = req.body.fullName || "User";
    const applicantEmail = req.body.email || "N/A";


    const finalUser = users.filter(
      u =>
        u.user_type === 'superadmin' ||
        u.user_type === 'admin' ||
        (u.badges && JSON.parse(u.badges || "[]").includes("Director of SLC"))
    );
    const extraEmails = process.env.COMPOSER_APPLICATION_EXTRA_EMAILS
    ? process.env.COMPOSER_APPLICATION_EXTRA_EMAILS.split(',').map(e => e.trim())
    : [];

    // 1. Send to platform users
    await Promise.all(
      finalUser.map(user =>
        sendEmail({
          to: user.email,
          subject: "New Composer Application Submitted",
          html: `
            <p>Hi ${user.first_name},</p>
            <p>A new composer application has been submitted.</p>
            <p>
              <strong>Name:</strong> ${applicantName}<br/>
              <strong>Email:</strong> ${applicantEmail}
            </p>
          `
        })
      )
    );
    
    // 2. Send to extra emails (ONLY ONCE)
    await Promise.all(
      extraEmails.map(email =>
        sendEmail({
          to: email,
          subject: "New Composer Application Submitted",
          html: `
            <p>A new composer application has been submitted.</p>
            <p>
              <strong>Name:</strong> ${applicantName}<br/>
              <strong>Email:</strong> ${applicantEmail}
            </p>
          `
        })
      )
    );
    
    // 3. In-app notifications (only for users, not extra emails)
    await Promise.all(
      finalUser.map(user =>
        createAndDeliverNotification({
          title: `New Composer Application`,
          body: `${applicantName} has submitted a new application.`,
          metadata: {
            userId: userId,
            applicationId: applicationId
          },
          channel: "inbox",
          target: { type: "custom", user_ids: [user.id] }
        })
      )
    );

    successResponse(res, {
      application: application,
      isNewApplication
    }, `Application ${isNewApplication ? 'created' : 'updated'} successfully`);

  } catch (error) {
    console.error('Composer application error:', error);
    errorResponse(res, error.message || 'Failed to save application', 500);
  }
});

// @route   POST /api/composer-applications/submit
// @desc    Submit composer application for review
// @access  Private (Authenticated users)
router.post('/submit', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Get user's application
    const [applications] = await mysqlConnection.execute(
      'SELECT * FROM composer_applications WHERE user_id = ?',
      [userId]
    );

    if (applications.length === 0) {
      return errorResponse(res, 'No application found. Please complete the application first.', 404);
    }

    const application = applications[0];

    // Check if application is already approved
    if (application.status === 'approved') {
      return errorResponse(res, 'Application has already been approved', 400);
    }

    // Validate required fields
    const requiredFields = [
      'full_name', 'email', 'phone_number', 'street_address', 'city',
      'state_province', 'zip_code', 'country', 'music_background',
      'composition_background', 'church_affiliation', 'liturgical_draw',
      'liturgical_purpose', 'notation_software_proficiency',
      'notation_software_used', 'composition_1_title', 'composition_1_liturgical_use',
      'terms_accepted'
    ];

    const missingFields = requiredFields.filter(field => !application[field]);

    if (missingFields.length > 0) {
      return errorResponse(res, `Missing required fields: ${missingFields.join(', ')}`, 400);
    }

    // Check if terms are accepted
    if (!application.terms_accepted) {
      return errorResponse(res, 'Terms and conditions must be accepted', 400);
    }

    // Submit application (set status to under_review)
    await mysqlConnection.execute(
      'UPDATE composer_applications SET status = ?, updated_at = NOW() WHERE id = ?',
      ['under_review', application.id]
    );

    successResponse(res, {
      applicationId: application.id,
      status: 'under_review'
    }, 'Application submitted successfully for review');

  } catch (error) {
    console.error('Submit application error:', error);
    errorResponse(res, 'Failed to submit application', 500);
  }
});

// @route   GET /api/composer-applications/my-application
// @desc    Get current user's composer application
// @access  Private (Authenticated users)
router.get('/my-application', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    const [applications] = await mysqlConnection.execute(
      'SELECT * FROM composer_applications WHERE user_id = ?',
      [userId]
    );

    if (applications.length === 0) {
      return successResponse(res, {
        application: null,
        hasApplication: false
      }, 'No application found');
    }

    // Parse JSON fields for response
    const application = applications[0];
    if (application.composition_1_files) {
      application.composition_1_files = JSON.parse(application.composition_1_files);
    }
    if (application.composition_2_files) {
      application.composition_2_files = JSON.parse(application.composition_2_files);
    }
    if (application.composition_3_files) {
      application.composition_3_files = JSON.parse(application.composition_3_files);
    }
    if (application.accompaniment_types) {
      application.accompaniment_types = JSON.parse(application.accompaniment_types);
    }

    successResponse(res, {
      application: application,
      hasApplication: true
    }, 'Application retrieved successfully');

  } catch (error) {
    console.error('Get application error:', error);
    errorResponse(res, 'Failed to get application', 500);
  }
});

// @route   GET /api/composer-applications
// @desc    Get user-submitted composer applications (excludes SL team created composers)
// @query   status (optional) - Filter by application status (under_review, approved, rejected)
// @access  Private (SL Team only)
router.get('/', [auth, requireAnyRole(['sl_team', 'user'])], async (req, res) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;
    const mysqlConnection = getMySQLConnection();

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const offset = (pageNum - 1) * limitNum;

    let whereClause = 'WHERE ca.application_source = "user_submitted"';
    let whereValues = [];

    if (status) {
      whereClause += ' AND ca.status = ?';
      whereValues.push(status);
    }

    /* ---------------- TOTAL COUNT (FAST) ---------------- */
    const [countResult] = await mysqlConnection.execute(
      `SELECT COUNT(*) as total
       FROM composer_applications ca
       ${whereClause}`,
      whereValues
    );

    const total = countResult[0].total;

    /* ---------------- PAGINATED DATA ---------------- */
    const [applications] = await mysqlConnection.execute(
      `SELECT 
          ca.*,
          u.first_name,
          u.last_name,
          u.email AS user_email
       FROM composer_applications ca
       JOIN users u ON ca.user_id = u.id
       ${whereClause}
       ORDER BY ca.created_at DESC
       LIMIT ? OFFSET ?`,
      [...whereValues, limitNum, offset]
    );

    /* ---------------- JSON PARSING ---------------- */
    const parsedApplications = applications.map(app => ({
      ...app,
      composition_1_files: app.composition_1_files ? JSON.parse(app.composition_1_files) : null,
      composition_2_files: app.composition_2_files ? JSON.parse(app.composition_2_files) : null,
      composition_3_files: app.composition_3_files ? JSON.parse(app.composition_3_files) : null,
      accompaniment_types: app.accompaniment_types ? JSON.parse(app.accompaniment_types) : null
    }));

    successResponse(res, {
      applications: parsedApplications,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum)
      }
    }, 'User-submitted applications retrieved successfully');

  } catch (error) {
    console.error('Get applications error:', error);
    errorResponse(res, 'Failed to get applications', 500);
  }
});

// @route   GET /api/composer-applications/all
// @desc    Get all composer applications (both user-submitted and SL team created)
// @query   status (optional) - Filter by application status
// @access  Private (SL Team only)
router.get('/all', [auth, requireAnyRole(['sl_team'])], async (req, res) => {
  try {
    const { status } = req.query;
    const mysqlConnection = getMySQLConnection();

    let whereClause = '';
    let whereValues = [];

    if (status) {
      whereClause = 'WHERE ca.status = ?';
      whereValues.push(status);
    }

    // Get all applications (both user-submitted and SL team created)
    const [applications] = await mysqlConnection.execute(
      `SELECT ca.*, u.first_name, u.last_name, u.email as user_email 
       FROM composer_applications ca 
       JOIN users u ON ca.user_id = u.id 
       ${whereClause} 
       ORDER BY ca.created_at DESC`,
      whereValues
    );

    // Parse JSON fields for each application
    const parsedApplications = applications.map(application => {
      if (application.composition_1_files) {
        application.composition_1_files = JSON.parse(application.composition_1_files);
      }
      if (application.composition_2_files) {
        application.composition_2_files = JSON.parse(application.composition_2_files);
      }
      if (application.composition_3_files) {
        application.composition_3_files = JSON.parse(application.composition_3_files);
      }
      if (application.accompaniment_types) {
        application.accompaniment_types = JSON.parse(application.accompaniment_types);
      }
      return application;
    });

    successResponse(res, {
      applications: parsedApplications,
      total: parsedApplications.length
    }, 'All applications retrieved successfully');

  } catch (error) {
    console.error('Get all applications error:', error);
    errorResponse(res, 'Failed to get applications', 500);
  }
});

// @route   GET /api/composer-applications/test-source
// @desc    Test endpoint to check application_source field
// @access  Public
router.get('/test-source', async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    // Get all applications with their source
    const [applications] = await mysqlConnection.execute(`
      SELECT 
        ca.id,
        ca.user_id,
        ca.status,
        ca.full_name,
        ca.email,
        ca.application_source,
        ca.reviewed_by,
        ca.created_at,
        u.first_name,
        u.last_name
      FROM composer_applications ca 
      JOIN users u ON ca.user_id = u.id 
      ORDER BY ca.created_at DESC
    `);

    // Get count by source
    const [sourceCount] = await mysqlConnection.execute(`
      SELECT 
        application_source,
        status,
        COUNT(*) as count
      FROM composer_applications 
      GROUP BY application_source, status
      ORDER BY application_source, status
    `);

    successResponse(res, {
      totalApplications: applications.length,
      sourceBreakdown: sourceCount,
      allApplications: applications
    }, 'Application source test successful');

  } catch (error) {
    console.error('Test source error:', error);
    errorResponse(res, 'Failed to test source', 500);
  }
});

// @route   GET /api/composer-applications/sl-team-composers
// @desc    Get SL Team composers with pagination & filters
// @access  Public
router.get('/sl-team-composers', async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    // ==============================
    // Pagination
    // ==============================
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    // ==============================
    // Filters
    // ==============================
    const { search, email, status } = req.query;

    let whereConditions = `WHERE 1=1`;
    let values = [];

    // Status filter
    if (status) {
      whereConditions += ` AND ca.status = ?`;
      values.push(status);
    } else {
      whereConditions += ` AND ca.status = 'approved'`;
    }

    // Search by name
    if (search) {
      whereConditions += `
        AND (
          u.first_name LIKE ?
          OR u.last_name LIKE ?
          OR ca.full_name LIKE ?
        )
      `;
      values.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    // Email filter
    if (email) {
      whereConditions += ` AND u.email LIKE ?`;
      values.push(`%${email}%`);
    }

    // ==============================
    // Total Count (for pagination)
    // ==============================
    const [countRows] = await mysqlConnection.execute(
      `
      SELECT COUNT(DISTINCT u.id) AS total
      FROM users u
      INNER JOIN composer_applications ca ON u.id = ca.user_id
      ${whereConditions}
      `,
      values
    );

    const totalComposers = countRows[0]?.total || 0;
    const totalPages = Math.ceil(totalComposers / limit);

    // ==============================
    // Main Query (Paginated)
    // ==============================
    const [composers] = await mysqlConnection.execute(
      `
      SELECT 
        u.id,
        u.first_name,
        u.last_name,
        u.email,
        u.phone,
        u.bio,
        u.avatar,
        u.website_url,
        u.twitter_url,
        u.address,
        u.country,
        u.state_province,
        u.city,
        u.postal_code,
        u.language,
        u.badges,
        u.is_active,
        u.is_composer,
        u.created_at,
        u.updated_at,

        ca.full_name,
        ca.phone_number,
        ca.street_address,
        ca.address_line_2,
        ca.music_background,
        ca.composition_background,
        ca.accompaniment_types,
        ca.other_instrumentation,
        ca.church_affiliation,
        ca.liturgical_draw,
        ca.liturgical_purpose,
        ca.notation_software_proficiency,
        ca.digitization_method,
        ca.notation_software_used,

        ca.composition_1_title,
        ca.composition_1_liturgical_use,
        ca.composition_1_other_info,
        ca.composition_1_files,

        ca.composition_2_title,
        ca.composition_2_liturgical_use,
        ca.composition_2_other_info,
        ca.composition_2_files,

        ca.composition_3_title,
        ca.composition_3_liturgical_use,
        ca.composition_3_other_info,
        ca.composition_3_files,

        ca.status,
        ca.reviewed_by,
        ca.reviewed_at,
        ca.review_notes,
        ca.application_source,
        ca.created_at AS application_created_at,

        COUNT(mp.id) AS total_publications,
        SUM(CASE WHEN mp.status = 'published' THEN 1 ELSE 0 END) AS published_count

      FROM users u
      INNER JOIN composer_applications ca ON u.id = ca.user_id
      LEFT JOIN music_publications mp ON u.id = mp.composer_id
      ${whereConditions}
      GROUP BY u.id, ca.id
      ORDER BY ca.created_at DESC
      LIMIT ? OFFSET ?
      `,
      [...values, limit, offset]
    );

    // ==============================
    // Publications (Only for current page composers)
    // ==============================
    const composerIds = composers.map(c => c.id);
    let publicationsByComposer = {};

    if (composerIds.length) {
      const placeholders = composerIds.map(() => '?').join(',');

      const [publications] = await mysqlConnection.execute(
        `
        SELECT *
        FROM music_publications
        WHERE composer_id IN (${placeholders})
        ORDER BY created_at DESC
        `,
        composerIds
      );

      publications.forEach(pub => {
        if (!publicationsByComposer[pub.composer_id]) {
          publicationsByComposer[pub.composer_id] = [];
        }

        publicationsByComposer[pub.composer_id].push({
          id: pub.id,
          status: pub.status,
          compositionTitle: pub.composition_title,
          compositionDescription: pub.composition_description,
          composerFirstName: pub.composer_firstname,
          composerLastName: pub.composer_lastname,
          vocalParts: pub.vocal_parts ? JSON.parse(pub.vocal_parts) : [],
          instrumentation: pub.instrumentation ? JSON.parse(pub.instrumentation) : [],
          artists: pub.artists ? JSON.parse(pub.artists) : [],
          typesOfMusic: pub.types_of_music,
          firstLineOfComposition: pub.first_line_of_composition,
          compositionCopyrights: pub.composition_copyrights,
          songType: pub.song_type,
          meter: pub.meter,
          season: pub.season,
          psalmNumber: pub.psalm_number,
          textCopyrightNotice: pub.text_copyright_notice,
          tuneCopyrightNotice: pub.tune_copyright_notice,
          musicFiles: pub.music_files ? JSON.parse(pub.music_files) : [],
          artworkFileUrl: pub.artwork_file_url,
          artworkFileSize: pub.artwork_file_size,
          publishedAt: pub.published_at,
          createdAt: pub.created_at
        });
      });
    }

    // ==============================
    // Response Formatting (UNCHANGED FORMAT)
    // ==============================
    const formattedComposers = composers.map(composer => ({
      id: composer.id,
      firstName: composer.first_name,
      lastName: composer.last_name,
      fullName: composer.full_name || `${composer.first_name} ${composer.last_name}`,
      email: composer.email,
      phone: composer.phone || composer.phone_number,
      bio: composer.bio,
      avatar: composer.avatar,
      websiteUrl: composer.website_url,
      twitterUrl: composer.twitter_url,
      address: composer.address || composer.street_address,
      location: {
        country: composer.country,
        stateProvince: composer.state_province,
        city: composer.city,
        postalCode: composer.postal_code
      },
      language: composer.language,
      badges: composer.badges ? JSON.parse(composer.badges) : null,
      isActive: composer.is_active,
      createdAt: composer.created_at,
      updatedAt: composer.updated_at,
      statistics: {
        totalPublications: composer.total_publications || 0,
        publishedCount: composer.published_count || 0
      },
      publications: publicationsByComposer[composer.id] || [],
      application: {
        status: composer.status,
        musicBackground: composer.music_background,
        compositionBackground: composer.composition_background,
        accompanimentTypes: composer.accompaniment_types ? JSON.parse(composer.accompaniment_types) : [],
        otherInstrumentation: composer.other_instrumentation,
        churchAffiliation: composer.church_affiliation,
        liturgicalDraw: composer.liturgical_draw,
        liturgicalPurpose: composer.liturgical_purpose,
        notationSoftwareProficiency: composer.notation_software_proficiency,
        digitizationMethod: composer.digitization_method,
        notationSoftwareUsed: composer.notation_software_used,
        compositions: {
          composition1: {
            title: composer.composition_1_title,
            liturgicalUse: composer.composition_1_liturgical_use,
            otherInfo: composer.composition_1_other_info,
            files: composer.composition_1_files ? JSON.parse(composer.composition_1_files) : []
          },
          composition2: {
            title: composer.composition_2_title,
            liturgicalUse: composer.composition_2_liturgical_use,
            otherInfo: composer.composition_2_other_info,
            files: composer.composition_2_files ? JSON.parse(composer.composition_2_files) : []
          },
          composition3: {
            title: composer.composition_3_title,
            liturgicalUse: composer.composition_3_liturgical_use,
            otherInfo: composer.composition_3_other_info,
            files: composer.composition_3_files ? JSON.parse(composer.composition_3_files) : []
          }
        },
        reviewedBy: composer.reviewed_by,
        reviewedAt: composer.reviewed_at,
        reviewNotes: composer.review_notes,
        applicationSource: composer.application_source,
        applicationCreatedAt: composer.application_created_at
      }
    }));

    return successResponse(res, {
      composers: formattedComposers,
      pagination: {
        page,
        limit,
        totalComposers,
        totalPages
      }
    }, 'SL Team composers retrieved successfully');

  } catch (error) {
    console.error('Get SL team composers error:', error);
    return errorResponse(res, 'Failed to get SL team composers', 500);
  }
});
// @route   GET /api/composer-applications/:id
// @desc    Get specific composer application (Admin only)
// @access  Private (SL Team only)
router.get('/:id', [auth, requireAnyRole(['sl_team'])], async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();

    const [applications] = await mysqlConnection.execute(
      `SELECT ca.*, u.first_name, u.last_name, u.email as user_email 
       FROM composer_applications ca 
       JOIN users u ON ca.user_id = u.id 
       WHERE ca.id = ?`,
      [id]
    );

    if (applications.length === 0) {
      return errorResponse(res, 'Application not found', 404);
    }

    // Parse JSON fields for response
    const application = applications[0];
    if (application.composition_1_files) {
      application.composition_1_files = JSON.parse(application.composition_1_files);
    }
    if (application.composition_2_files) {
      application.composition_2_files = JSON.parse(application.composition_2_files);
    }
    if (application.composition_3_files) {
      application.composition_3_files = JSON.parse(application.composition_3_files);
    }
    if (application.accompaniment_types) {
      application.accompaniment_types = JSON.parse(application.accompaniment_types);
    }

    successResponse(res, {
      application: application
    }, 'Application retrieved successfully');

  } catch (error) {
    console.error('Get application error:', error);
    errorResponse(res, 'Failed to get application', 500);
  }
});

// @route   PUT /api/composer-applications/:id/review
// @desc    Review composer application (Admin only)
// @access  Private (SL Team only)
router.put('/:id/review', [auth, requireAnyRole(['sl_team'])], async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reviewNotes, rejectionReason } = req.body;
    const reviewerId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Get application
    const [applications] = await mysqlConnection.execute(
      'SELECT * FROM composer_applications WHERE id = ?',
      [id]
    );

    if (applications.length === 0) {
      return errorResponse(res, 'Application not found', 404);
    }

    const application = applications[0];

    // Allow multiple reviews - no restriction on already reviewed applications

    // Update application status
    const updateFields = ['status = ?', 'reviewed_by = ?', 'reviewed_at = NOW()'];
    const updateValues = [status, reviewerId];

    if (reviewNotes) {
      updateFields.push('review_notes = ?');
      updateValues.push(reviewNotes);
    }

    if (status === 'rejected' && rejectionReason) {
      updateFields.push('rejection_reason = ?');
      updateValues.push(rejectionReason);
    }

    updateValues.push(id);

    await mysqlConnection.execute(
      `UPDATE composer_applications SET ${updateFields.join(', ')}, updated_at = NOW() WHERE id = ?`,
      updateValues
    );
    const [userRows] = await mysqlConnection.execute(
      `SELECT email, first_name FROM users WHERE id = ?`,
      [application.user_id]
    );

    const user = userRows[0];
    // If approved, update user's is_composer field to true
    if (status === 'approved') {
      await mysqlConnection.execute(
        `UPDATE users SET is_composer = TRUE WHERE id = ?`,
        [application.user_id]
      );

      // ===========================================
      // ✅ Add Composer badge + regenerate permissions
      // ===========================================

      // 1️⃣ Get current badges
      const [userRows] = await mysqlConnection.execute(
        `SELECT badges, role FROM users WHERE id = ?`,
        [application.user_id]
      );

      let currentBadges = userRows[0].badges
        ? JSON.parse(userRows[0].badges)
        : [];

      if (!currentBadges.includes('Composer')) {
        currentBadges.push('Composer');
      }

      // 2️⃣ Fetch permissions for ALL badges
      const placeholders = currentBadges.map(() => '?').join(',');

      const [roles] = await mysqlConnection.execute(
        `SELECT role_name, permissions FROM role_permissions WHERE role_name IN (${placeholders})`,
        currentBadges
      );

      // 3️⃣ Merge permissions (same logic as your admin API)
      const finalPermissions = {};

      const mergePermissions = (source, target) => {
        Object.entries(source).forEach(([key, value]) => {
          if (value === 'x' || value === '-') {
            target[key] = value;
            return;
          }

          if (typeof value === 'object' && value !== null) {
            if (!target[key]) target[key] = {};
            mergePermissions(value, target[key]);
          }
        });
      };

      roles.forEach(r => {
        const perms = JSON.parse(r.permissions || '{}');
        mergePermissions(perms, finalPermissions);
      });

      // 4️⃣ Save badges + permissions
      await mysqlConnection.execute(`UPDATE users SET badges = ?, permissions = ?, is_composer = TRUE WHERE id = ?`,
        [
          JSON.stringify(currentBadges),
          JSON.stringify(finalPermissions),
          application.user_id
        ]
      );

      await sendEmail({
        to: user.email,
        subject: '🎉 Composer Application Approved',
        html: `
          <html>
            <body>
              <p>Hi ${user.first_name || 'Composer'},</p>
      
              <p>
                Great news! Your composer application has been
                <strong>approved</strong>.
              </p>
      
              <p>
                You now have Composer access and can upload and manage
                your compositions on the platform.
              </p>
      
              <p>
                Welcome aboard!
              </p>
      
              <br/>
              <p>
                --<br/>
                Simply Liturgical Team
              </p>
            </body>
          </html>
        `
      });
    } else if (status === 'rejected') {
      await sendEmail({
        to: user.email,
        subject: 'Update on Your Composer Application',
        html: `
    <html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6;">
        <p>Hi ${user.first_name || 'Composer'},</p>

        <p>
          Thank you sincerely for taking the time to apply to become a composer 
          with Simply Liturgical.
        </p>

        <p>
          After careful review, we regret to inform you that your application 
          has not been approved at this time.
        </p>

        ${rejectionReason
            ? `
            <p>
              <strong>Reviewer Feedback:</strong><br/>
              ${rejectionReason}
            </p>
            `
            : ''
          }

        <p>
          We truly value your interest and encourage you to refine your submission 
          and apply again in the future. Many successful composers were approved 
          after making improvements based on feedback.
        </p>

        <p>
          If you have any questions, feel free to reply to this email.
        </p>

        <br/>

        <p>
          With appreciation,<br/>
          — Simply Liturgical Team
        </p>
      </body>
    </html>
  `
      });
    }
    successResponse(res, {
      applicationId: id,
      status,
      reviewedBy: reviewerId
    }, `Application ${status} successfully`);

  } catch (error) {
    console.error('Review application error:', error);
    errorResponse(res, 'Failed to review application', 500);
  }
});

// @route   POST /api/composer-applications/:compositionNumber/upload-files
// @desc    Upload files for a specific composition
// @access  Private (Authenticated users)
router.post('/:compositionNumber/upload-files', [auth, composerApplicationUpload.array('files', 10) // Maximum 10 files per composition
], async (req, res) => {
  try {
    const userId = req.user.id;
    const { compositionNumber } = req.params;
    const mysqlConnection = getMySQLConnection();

    // Validate composition number
    if (!['1', '2', '3'].includes(compositionNumber)) {
      return errorResponse(res, 'Invalid composition number. Must be 1, 2, or 3.', 400);
    }

    if (!req.files || req.files.length === 0) {
      return errorResponse(res, 'No files uploaded', 400);
    }

    // Get user's application
    const [applications] = await mysqlConnection.execute(
      'SELECT * FROM composer_applications WHERE user_id = ?',
      [userId]
    );

    if (applications.length === 0) {
      return errorResponse(res, 'No application found. Please create an application first.', 404);
    }

    const application = applications[0];

    // Check if application is already approved
    if (application.status === 'approved') {
      return errorResponse(res, 'Cannot upload files to an approved application', 400);
    }

    // Get existing files for this composition
    const filesField = `composition_${compositionNumber}_files`;
    let existingFiles = [];
    if (application[filesField]) {
      try {
        existingFiles = JSON.parse(application[filesField]);
      } catch (error) {
        existingFiles = [];
      }
    }

    // Process uploaded files
    const uploadedFiles = req.files.map(file => ({
      filename: file.originalname,
      filetype: file.mimetype,
      filesize: file.size,
      s3Key: file.key,
      s3Url: file.location,
      uploadedAt: new Date().toISOString()
    }));

    // Add new files to existing files
    const updatedFiles = [...existingFiles, ...uploadedFiles];

    // Update application with new files
    await mysqlConnection.execute(
      `UPDATE composer_applications SET ${filesField} = ?, updated_at = NOW() WHERE id = ?`,
      [JSON.stringify(updatedFiles), application.id]
    );

    successResponse(res, {
      compositionNumber: parseInt(compositionNumber),
      uploadedFiles,
      totalFiles: updatedFiles.length
    }, `Files uploaded successfully for composition ${compositionNumber}`);

  } catch (error) {
    console.error('File upload error:', error);
    errorResponse(res, 'Failed to upload files', 500);
  }
});

// @route   DELETE /api/composer-applications/:compositionNumber/files/:fileIndex
// @desc    Delete a specific file from a composition
// @access  Private (Authenticated users)
router.delete('/:compositionNumber/files/:fileIndex', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { compositionNumber, fileIndex } = req.params;
    const mysqlConnection = getMySQLConnection();

    // Validate composition number
    if (!['1', '2', '3'].includes(compositionNumber)) {
      return errorResponse(res, 'Invalid composition number. Must be 1, 2, or 3.', 400);
    }

    // Get user's application
    const [applications] = await mysqlConnection.execute(
      'SELECT * FROM composer_applications WHERE user_id = ?',
      [userId]
    );

    if (applications.length === 0) {
      return errorResponse(res, 'No application found', 404);
    }

    const application = applications[0];

    // Check if application is already approved
    if (application.status === 'approved') {
      return errorResponse(res, 'Cannot delete files from an approved application', 400);
    }

    // Get files for this composition
    const filesField = `composition_${compositionNumber}_files`;
    let files = [];
    if (application[filesField]) {
      try {
        files = JSON.parse(application[filesField]);
      } catch (error) {
        files = [];
      }
    }

    const fileIndexNum = parseInt(fileIndex);
    if (fileIndexNum < 0 || fileIndexNum >= files.length) {
      return errorResponse(res, 'Invalid file index', 400);
    }

    const fileToDelete = files[fileIndexNum];

    // Delete file from S3
    if (fileToDelete.s3Key) {
      await deleteFileFromS3(fileToDelete.s3Url);
    }

    // Remove file from array
    files.splice(fileIndexNum, 1);

    // Update application
    await mysqlConnection.execute(
      `UPDATE composer_applications SET ${filesField} = ?, updated_at = NOW() WHERE id = ?`,
      [JSON.stringify(files), application.id]
    );

    successResponse(res, {
      compositionNumber: parseInt(compositionNumber),
      deletedFile: fileToDelete,
      remainingFiles: files.length
    }, 'File deleted successfully');

  } catch (error) {
    console.error('File deletion error:', error);
    errorResponse(res, 'Failed to delete file', 500);
  }
});

// @route   GET /api/composer-applications/:compositionNumber/files
// @desc    Get all files for a specific composition
// @access  Private (Authenticated users)
router.get('/:compositionNumber/files', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { compositionNumber } = req.params;
    const mysqlConnection = getMySQLConnection();

    // Validate composition number
    if (!['1', '2', '3'].includes(compositionNumber)) {
      return errorResponse(res, 'Invalid composition number. Must be 1, 2, or 3.', 400);
    }

    // Get user's application
    const [applications] = await mysqlConnection.execute(
      'SELECT * FROM composer_applications WHERE user_id = ?',
      [userId]
    );

    if (applications.length === 0) {
      return errorResponse(res, 'No application found', 404);
    }

    const application = applications[0];
    const filesField = `composition_${compositionNumber}_files`;

    let files = [];
    if (application[filesField]) {
      try {
        files = JSON.parse(application[filesField]);
      } catch (error) {
        files = [];
      }
    }

    successResponse(res, {
      compositionNumber: parseInt(compositionNumber),
      files,
      totalFiles: files.length
    }, 'Files retrieved successfully');

  } catch (error) {
    console.error('Get files error:', error);
    errorResponse(res, 'Failed to get files', 500);
  }
});

// @route   PUT /api/composer-applications/:id/approve
// @desc    Approve composer application (Admin only)
// @access  Private (SL Team only)
router.put('/:id/approve', [auth, requireAnyRole(['sl_team'])], async (req, res) => {
  try {
    const { id } = req.params;
    const { reviewNotes } = req.body;
    const reviewerId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Check if application exists
    const [applications] = await mysqlConnection.execute(
      'SELECT * FROM composer_applications WHERE id = ?',
      [id]
    );

    if (applications.length === 0) {
      return errorResponse(res, 'Application not found', 404);
    }

    const application = applications[0];

    // Allow multiple approvals - no restriction on already approved applications

    // Update application status to approved
    const updateFields = ['status = ?', 'reviewed_by = ?', 'reviewed_at = NOW()', 'updated_at = NOW()'];
    const updateValues = ['approved', reviewerId];

    // Review notes are optional
    if (reviewNotes !== undefined) {
      updateFields.push('review_notes = ?');
      updateValues.push(reviewNotes);
    }

    updateValues.push(id);

    await mysqlConnection.execute(
      `UPDATE composer_applications SET ${updateFields.join(', ')} WHERE id = ?`,
      updateValues
    );

    // Get updated application with reviewer info
    const [updatedApplication] = await mysqlConnection.execute(
      `SELECT ca.*, u.first_name, u.last_name, u.email as user_email,
              r.first_name as reviewer_first_name, r.last_name as reviewer_last_name
       FROM composer_applications ca
       JOIN users u ON ca.user_id = u.id
       LEFT JOIN users r ON ca.reviewed_by = r.id
       WHERE ca.id = ?`,
      [id]
    );

    successResponse(res, {
      application: updatedApplication[0]
    }, 'Application approved successfully');

  } catch (error) {
    console.error('Approve application error:', error);
    errorResponse(res, 'Failed to approve application', 500);
  }
});

// @route   PUT /api/composer-applications/:id/reject
// @desc    Reject composer application (Admin only)
// @access  Private (SL Team only)
router.put('/:id/reject', [auth, requireAnyRole(['sl_team'])], async (req, res) => {
  try {
    const { id } = req.params;
    const { rejectionReason, reviewNotes } = req.body;
    const reviewerId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    if (!rejectionReason) {
      return errorResponse(res, 'Rejection reason is required', 400);
    }

    // Check if application exists
    const [applications] = await mysqlConnection.execute(
      'SELECT * FROM composer_applications WHERE id = ?',
      [id]
    );

    if (applications.length === 0) {
      return errorResponse(res, 'Application not found', 404);
    }

    const application = applications[0];

    // Allow multiple rejections - no restriction on already rejected applications

    // Update application status to rejected
    const updateFields = ['status = ?', 'reviewed_by = ?', 'reviewed_at = NOW()', 'rejection_reason = ?', 'updated_at = NOW()'];
    const updateValues = ['rejected', reviewerId, rejectionReason];

    // Review notes are optional
    if (reviewNotes !== undefined) {
      updateFields.push('review_notes = ?');
      updateValues.push(reviewNotes);
    }

    updateValues.push(id);

    await mysqlConnection.execute(
      `UPDATE composer_applications SET ${updateFields.join(', ')} WHERE id = ?`,
      updateValues
    );

    // Get updated application with reviewer info
    const [updatedApplication] = await mysqlConnection.execute(
      `SELECT ca.*, u.first_name, u.last_name, u.email as user_email,
              r.first_name as reviewer_first_name, r.last_name as reviewer_last_name
       FROM composer_applications ca
       JOIN users u ON ca.user_id = u.id
       LEFT JOIN users r ON ca.reviewed_by = r.id
       WHERE ca.id = ?`,
      [id]
    );

    successResponse(res, {
      application: updatedApplication[0]
    }, 'Application rejected successfully');

  } catch (error) {
    console.error('Reject application error:', error);
    errorResponse(res, 'Failed to reject application', 500);
  }
});

// @route   POST /api/composer-applications/create-composer
// @desc    Create composer directly by SL Team/Admin (auto-approved)
// @access  Private (SL Team/Admin only)
router.post('/create-composer', [auth, requireAnyRole(['sl_team', 'admin'])], async (req, res) => {
  try {
    const {
      // Login credentials (NEW)
      email,
      password,

      // Basic Information
      fullName,
      phoneNumber,
      streetAddress,
      addressLine2,
      city,
      stateProvince,
      zipCode,
      country,

      // Music/Composition Background
      musicBackground,
      compositionBackground,
      accompanimentTypes,
      otherInstrumentation,

      // Liturgical Experience
      churchAffiliation,
      liturgicalDraw,
      liturgicalPurpose,

      // Digital Engraving
      notationSoftwareProficiency,
      digitizationMethod,
      notationSoftwareUsed,

      // Compositions
      composition1Title,
      composition1LiturgicalUse,
      composition1OtherInfo,
      composition1Files,

      composition2Title,
      composition2LiturgicalUse,
      composition2OtherInfo,
      composition2Files,

      composition3Title,
      composition3LiturgicalUse,
      composition3OtherInfo,
      composition3Files
    } = req.body;

    const creatorId = req.user.id;
    const mysqlConnection = getMySQLConnection();
    const bcrypt = require('bcryptjs');

    // Validate required fields
    if (!email || !password) {
      return errorResponse(res, 'Email and password are required', 400);
    }

    if (!fullName) {
      return errorResponse(res, 'Full name is required', 400);
    }

    // Check if user with this email already exists
    const [existingUsers] = await mysqlConnection.execute(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );

    if (existingUsers.length > 0) {
      return errorResponse(res, 'User with this email already exists', 400);
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create user account with free_user role and composer status
    const [userResult] = await mysqlConnection.execute(
      `INSERT INTO users (first_name, last_name, email, password, phone, role, is_active, is_composer) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fullName.split(' ')[0] || fullName, // First name
        fullName.split(' ').slice(1).join(' ') || '', // Last name
        email,
        hashedPassword,
        phoneNumber || null,
        'free_user',
        1, // Active
        1  // is_composer = 1
      ]
    );

    const newUserId = userResult.insertId;

    // Create composer application with approved status
    const [appResult] = await mysqlConnection.execute(
      `INSERT INTO composer_applications (
        user_id, 
        status,
        application_source,
        full_name,
        email,
        phone_number,
        street_address,
        address_line_2,
        city,
        state_province,
        zip_code,
        country,
        music_background,
        composition_background,
        accompaniment_types,
        other_instrumentation,
        church_affiliation,
        liturgical_draw,
        liturgical_purpose,
        notation_software_proficiency,
        digitization_method,
        notation_software_used,
        composition_1_title,
        composition_1_liturgical_use,
        composition_1_other_info,
        composition_1_files,
        composition_2_title,
        composition_2_liturgical_use,
        composition_2_other_info,
        composition_2_files,
        composition_3_title,
        composition_3_liturgical_use,
        composition_3_other_info,
        composition_3_files,
        terms_accepted,
        terms_accepted_at,
        reviewed_by,
        reviewed_at,
        review_notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, NOW(), ?)`,
      [
        newUserId,
        'approved', // Auto-approved
        'sl_team_created', // Application source
        fullName,
        email,
        phoneNumber || null,
        streetAddress || null,
        addressLine2 || null,
        city || null,
        stateProvince || null,
        zipCode || null,
        country || null,
        musicBackground || null,
        compositionBackground || null,
        accompanimentTypes ? JSON.stringify(accompanimentTypes) : null,
        otherInstrumentation || null,
        churchAffiliation || null,
        liturgicalDraw || null,
        liturgicalPurpose || null,
        notationSoftwareProficiency || 'Beginner',
        digitizationMethod || null,
        notationSoftwareUsed || null,
        composition1Title || null,
        composition1LiturgicalUse || null,
        composition1OtherInfo || null,
        composition1Files ? JSON.stringify(composition1Files) : null,
        composition2Title || null,
        composition2LiturgicalUse || null,
        composition2OtherInfo || null,
        composition2Files ? JSON.stringify(composition2Files) : null,
        composition3Title || null,
        composition3LiturgicalUse || null,
        composition3OtherInfo || null,
        composition3Files ? JSON.stringify(composition3Files) : null,
        true, // terms_accepted
        creatorId, // reviewed_by
        `Created by ${req.user.first_name} ${req.user.last_name} (${req.user.role})` // review_notes
      ]
    );

    // Get the created application with user info
    const [createdApp] = await mysqlConnection.execute(
      `SELECT ca.*, 
              u.first_name, 
              u.last_name, 
              u.email as user_email,
              u.role,
              r.first_name as reviewer_first_name, 
              r.last_name as reviewer_last_name
       FROM composer_applications ca
       JOIN users u ON ca.user_id = u.id
       LEFT JOIN users r ON ca.reviewed_by = r.id
       WHERE ca.id = ?`,
      [appResult.insertId]
    );

    // Send welcome email with credentials
    try {
      const { sendEmail } = require('../utils/SendMailer');

      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
            <h1 style="margin: 0; font-size: 28px;">Welcome to Simply Liturgical!</h1>
            <p style="margin: 10px 0 0 0; font-size: 16px; opacity: 0.9;">Your composer account has been created</p>
          </div>
          
          <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
            <h2 style="color: #333; margin-top: 0;">Account Details</h2>
            <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #667eea;">
              <p style="margin: 0 0 10px 0;"><strong>Email:</strong> ${email}</p>
              <p style="margin: 0 0 10px 0;"><strong>Password:</strong> ${password}</p>
              <p style="margin: 0 0 10px 0;"><strong>Role:</strong> Composer</p>
              <p style="margin: 0;"><strong>Status:</strong> Active & Approved</p>
            </div>
            
            <h3 style="color: #333;">Next Steps</h3>
            <ul style="color: #666; line-height: 1.6;">
              <li>Login to your account using the credentials above</li>
              <li>Complete your composer profile</li>
              <li>Start uploading your musical compositions</li>
              <li>Explore the platform features</li>
            </ul>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/login" 
                 style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">
                Login to Your Account
              </a>
            </div>
            
            <div style="background: #e3f2fd; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <p style="margin: 0; color: #1976d2; font-size: 14px;">
                <strong>Security Note:</strong> Please change your password after your first login for security purposes.
              </p>
            </div>
            
            <p style="color: #666; font-size: 14px; margin-top: 30px;">
              If you have any questions, please contact our support team.
            </p>
          </div>
        </div>
      `;

      await sendEmail({
        to: email,
        subject: 'Welcome to Simply Liturgical - Composer Account Created',
        html: emailHtml
      });

      console.log(`✅ Welcome email sent to ${email}`);
    } catch (emailError) {
      console.error('❌ Failed to send welcome email:', emailError);
      // Don't fail the request if email fails
    }

    successResponse(res, {
      application: createdApp[0],
      user: {
        id: newUserId,
        email: email,
        role: 'composer',
        canLogin: true
      },
      message: 'Composer created successfully with auto-approved application'
    }, 'Composer created successfully', 201);

  } catch (error) {
    console.error('Create composer error:', error);
    errorResponse(res, 'Failed to create composer', 500);
  }
});


// @route   POST /api/composer-applications/:id/create-composer
// @desc    Create composer directly by SL Team/Admin (auto-approved)
// @access  Private (SL Team/Admin only)
router.post('/:id/create-composer', auth, requireAnyRole(['sl_team']), async (req, res) => {
  try {
    const { id } = req.params;                      // this is the USER id (as you intended)
    const creatorId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // 1) Ensure user exists
    const [existingUsers] = await mysqlConnection.execute(
      'SELECT * FROM users WHERE id = ?',
      [id]
    );

    if (!existingUsers || existingUsers.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    const user = existingUsers[0];

    if (user.is_composer) {
      return errorResponse(res, 'User is already a composer', 404);
    }


    // 2) Check if there is already a composer_applications row for this user
    const [apps] = await mysqlConnection.execute(
      `SELECT * FROM composer_applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
      [id]
    );

    let appId = null;

    if (apps && apps.length > 0) {
      const app = apps[0];
      appId = app.id;

      // If not approved, mark as approved
      if (app.status !== 'approved') {
        const updateFields = ['status = ?', 'reviewed_by = ?', 'reviewed_at = NOW()'];
        const updateValues = ["approved", creatorId, app.id]; // include app.id for WHERE
        await mysqlConnection.execute(
          `UPDATE composer_applications SET ${updateFields.join(', ')}, updated_at = NOW() WHERE id = ?`,
          updateValues
        );
      }
    } else {
      // 3) If no application exists, create an auto-approved application seeded from user's data
      const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || null;
      const email = user.email || null;
      const phone = user.phone || null;

      const [insertResult] = await mysqlConnection.execute(
        `INSERT INTO composer_applications (
           user_id, status, application_source, full_name, email, phone_number,
           terms_accepted, terms_accepted_at, reviewed_by, reviewed_at, review_notes, created_at, updated_at
         ) VALUES (?, 'approved', 'sl_team_created', ?, ?, ?, TRUE, NOW(), ?, NOW(),
           ?, NOW(), NOW())`,
        [
          id,
          fullName,
          email,
          phone,
          creatorId,
          `Auto-created and approved by ${req.user.first_name || ''} ${req.user.last_name || ''} (${req.user.role || ''})`
        ]
      );

      appId = insertResult.insertId;
    }

    // 4) Update the user to be a composer (do not change admin/sl_team role)
    await mysqlConnection.execute(
      `UPDATE users SET is_composer = 1, updated_at = NOW() WHERE id = ?`,
      [id]
    );

    // 5) Return the updated application + user
    const [finalAppRows] = await mysqlConnection.execute(
      `SELECT ca.*, u.first_name, u.last_name, u.email as user_email, u.role as user_role
       FROM composer_applications ca
       LEFT JOIN users u ON ca.user_id = u.id
       WHERE ca.id = ?`,
      [appId]
    );

    const [finalUserRows] = await mysqlConnection.execute(
      `SELECT id, first_name, last_name, email, role, is_composer, is_active FROM users WHERE id = ?`,
      [id]
    );

    return successResponse(res, {
      application: finalAppRows[0] || null,
      user: finalUserRows[0] || null
    }, 'Composer created/approved successfully', 200);

  } catch (error) {
    console.error('Create-composer error:', error);
    return errorResponse(res, 'Failed to create/approve composer', 500);
  }
});

// @route   PUT /api/composer-applications/edit-composer/:composerId
// @desc    Edit composer by SL Team/Admin
// @access  Private (SL Team/Admin only)
router.put('/edit-composer/:composerId', [auth, requireAnyRole(['sl_team', 'admin'])], async (req, res) => {
  try {
    const { composerId } = req.params;
    const data = req.body || {};
    const mysqlConnection = getMySQLConnection();
    console.log(data)
    // 1) Split full name
    if (data.full_name) {
      const parts = data.full_name.trim().split(/\s+/);
      data.first_name = parts[0];
      data.last_name = parts.slice(1).join(' ');
    }

    // 2) Email uniqueness check
    if (data.email) {
      const [existing] = await mysqlConnection.execute(
        'SELECT id FROM users WHERE email = ? AND id != ? LIMIT 1',
        [data.email, composerId]
      );
      if (existing.length > 0) {
        return errorResponse(res, 'Email already in use', 400);
      }
    }

    // Allowed fields
    const userFieldsAllow = [
      'first_name', 'last_name', 'email', 'phone', 'address', 'country',
      'state_province', 'city', 'postal_code', 'avatar'
    ];

    const composerFieldsAllow = [
      'full_name', 'email', 'phone_number', 'street_address', 'address_line_2',
      'city', 'state_province', 'zip_code', 'country',
      'music_background', 'composition_background', 'church_affiliation',
      'liturgical_draw', 'liturgical_purpose',
      'notation_software_proficiency', 'digitization_method', 'notation_software_used',
      'composition_1_title', 'composition_1_liturgical_use', 'composition_1_other_info', 'composition_1_files',
      'composition_2_title', 'composition_2_liturgical_use', 'composition_2_other_info', 'composition_2_files',
      'composition_3_title', 'composition_3_liturgical_use', 'composition_3_other_info', 'composition_3_files'
    ];

    // 3) Build user update
    const userCols = [];
    const userVals = [];

    for (const [k, v] of Object.entries(data)) {
      if (userFieldsAllow.includes(k)) {
        userCols.push(`${k} = ?`);
        userVals.push(typeof v === 'object' ? JSON.stringify(v) : v);
      }
    }

    if (userCols.length > 0) {
      userCols.push("updated_at = NOW()");
      userVals.push(composerId);

      await mysqlConnection.execute(
        `UPDATE users SET ${userCols.join(', ')} WHERE id = ?`,
        userVals
      );
    }

    // 4) Build composer update
    const compCols = [];
    const compVals = [];

    for (const [k, v] of Object.entries(data)) {
      if (composerFieldsAllow.includes(k)) {
        compCols.push(`${k} = ?`);
        compVals.push(typeof v === 'object' ? JSON.stringify(v) : v);
      }
    }

    if (compCols.length > 0) {
      compCols.push("updated_at = NOW()");
      compVals.push(composerId);

      await mysqlConnection.execute(
        `UPDATE composer_applications SET ${compCols.join(', ')} WHERE user_id = ?`,
        compVals
      );
    }

    successResponse(res, { composerId });

  } catch (error) {
    console.error("Edit composer error:", error);
    return errorResponse(res, "Failed to edit composer", 500);
  }
});

// @route   PUT /api/composer-applications/composer/:composerId
// @desc    Edit composer by SL Team/Admin
// @access  Private (SL Team/Admin only)
router.get('/composer/:composerId', [auth, requireAnyRole(['sl_team', 'admin'])], async (req, res) => {
  try {
    const { composerId } = req.params;
    const mysqlConnection = getMySQLConnection();

    // Get composer's public profile
    const [composers] = await mysqlConnection.execute(`
      SELECT u.id, u.first_name, u.last_name, u.is_active, ca.*
      FROM users u
      JOIN composer_applications ca ON u.id = ca.user_id
      WHERE u.id = ? AND u.is_composer = 1
    `, [composerId]);
    console.log(composerId);
    if (composers.length === 0) {
      return errorResponse(res, 'Composer not found or inactive', 404);
    }

    const composer = composers[0];

    // Parse JSON fields
    if (composer.composition_1_files) {
      composer.composition_1_files = JSON.parse(composer.composition_1_files);
    }
    if (composer.composition_2_files) {
      composer.composition_2_files = JSON.parse(composer.composition_2_files);
    }
    if (composer.composition_3_files) {
      composer.composition_3_files = JSON.parse(composer.composition_3_files);
    }
    if (composer.accompaniment_types) {
      composer.accompaniment_types = JSON.parse(composer.accompaniment_types);
    }


    // Get all publications for this composer
    const [publications] = await mysqlConnection.execute(`
      SELECT 
        mp.id,
        mp.composer_id,
        mp.composition_title,
        mp.composition_description,
        mp.composer_firstname,
        mp.composer_lastname,
        mp.vocal_parts,
        mp.instrumentation,
        mp.artists,
        mp.types_of_music,
        mp.first_line_of_composition,
        mp.composition_copyrights,
        mp.song_type,
        mp.meter,
        mp.season,
        mp.psalm_number,
        mp.text_copyright_notice,
        mp.tune_copyright_notice,
        mp.music_files,
        mp.artwork_file_url,
        mp.artwork_file_size,
        mp.status,
        mp.published_at,
        mp.created_at
      FROM music_publications mp
      WHERE mp.composer_id = ?
      ORDER BY mp.created_at DESC
    `, [composerId]);

    console.log('Total publications found:', publications.length);

    // Format publications
    const formattedPublications = publications.map(pub => ({
      id: pub.id,
      status: pub.status,
      compositionTitle: pub.composition_title,
      compositionDescription: pub.composition_description,
      composerFirstName: pub.composer_firstname,
      composerLastName: pub.composer_lastname,
      vocalParts: pub.vocal_parts ? JSON.parse(pub.vocal_parts) : [],
      instrumentation: pub.instrumentation ? JSON.parse(pub.instrumentation) : [],
      artists: pub.artists ? JSON.parse(pub.artists) : [],
      typesOfMusic: pub.types_of_music,
      firstLineOfComposition: pub.first_line_of_composition,
      compositionCopyrights: pub.composition_copyrights,
      songType: pub.song_type,
      meter: pub.meter,
      season: pub.season,
      psalmNumber: pub.psalm_number,
      textCopyrightNotice: pub.text_copyright_notice,
      tuneCopyrightNotice: pub.tune_copyright_notice,
      musicFiles: pub.music_files ? JSON.parse(pub.music_files) : [],
      artworkFileUrl: pub.artwork_file_url,
      artworkFileSize: pub.artwork_file_size,
      publishedAt: pub.published_at,
      createdAt: pub.created_at
    }));
    composer.publications = formattedPublications

    successResponse(res, {
      composer: composer,
      // publications: formattedPublications,
      totalPublications: formattedPublications.length,
      publishedCount: formattedPublications.filter(p => p.status === 'published').length
    }, 'Composer profile retrieved successfully');

  } catch (error) {
    console.error('Get composer profile error:', error);
    errorResponse(res, 'Failed to get composer profile', 500);
  }
});

// @route   GET /api/composer-applications/my-application
// @desc    Get current user's composer application
// @access  Private (Authenticated user)
router.get('/my-application', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Get user's application
    const [applications] = await mysqlConnection.execute(
      `SELECT ca.*, 
              r.first_name as reviewer_first_name, 
              r.last_name as reviewer_last_name
       FROM composer_applications ca
       LEFT JOIN users r ON ca.reviewed_by = r.id
       WHERE ca.user_id = ?`,
      [userId]
    );

    if (applications.length === 0) {
      return successResponse(res, {
        application: null,
        message: 'No application found'
      }, 'No application exists for this user');
    }

    const application = applications[0];

    // Parse JSON fields
    if (application.composition_1_files) {
      application.composition_1_files = JSON.parse(application.composition_1_files);
    }
    if (application.composition_2_files) {
      application.composition_2_files = JSON.parse(application.composition_2_files);
    }
    if (application.composition_3_files) {
      application.composition_3_files = JSON.parse(application.composition_3_files);
    }
    if (application.accompaniment_types) {
      application.accompaniment_types = JSON.parse(application.accompaniment_types);
    }

    successResponse(res, {
      application: application
    }, 'Application retrieved successfully');

  } catch (error) {
    console.error('Get my application error:', error);
    errorResponse(res, 'Failed to get application', 500);
  }
});

// @route   DELETE /api/composer-applications/my-application
// @desc    Delete current user's composer application (only if under_review)
// @access  Private (Authenticated user)
router.delete('/my-application', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Get user's application
    const [applications] = await mysqlConnection.execute(
      'SELECT id, status FROM composer_applications WHERE user_id = ?',
      [userId]
    );

    if (applications.length === 0) {
      return errorResponse(res, 'No application found to delete', 404);
    }

    const application = applications[0];

    // Check if application status is under_review
    if (application.status !== 'under_review') {
      return errorResponse(res, `Cannot delete application with status '${application.status}'. Only applications under review can be deleted.`, 400);
    }

    // Delete the application
    await mysqlConnection.execute(
      'DELETE FROM composer_applications WHERE id = ? AND user_id = ?',
      [application.id, userId]
    );

    successResponse(res, {
      deletedApplicationId: application.id,
      message: 'Your composer application has been deleted successfully'
    }, 'Application deleted successfully');

  } catch (error) {
    console.error('Delete my application error:', error);
    errorResponse(res, 'Failed to delete application', 500);
  }
});


// @route   PUT /api/composer-applications/activate-composer/:composerId
// @desc    Activate composer created by SL Team
// @access  Private (SL Team/Admin only)
router.put('/activate-composer/:composerId', [
  auth,
  requireAnyRole(['sl_team', 'admin'])
], async (req, res) => {
  try {
    const { composerId } = req.params;
    const { reason } = req.body; // Optional reason for activation
    const mysqlConnection = getMySQLConnection();

    // Check if composer exists and was created by SL team
    const [composers] = await mysqlConnection.execute(`
      SELECT u.id, u.first_name, u.last_name, u.is_active, ca.application_source
      FROM users u
      INNER JOIN composer_applications ca ON u.id = ca.user_id
      WHERE u.id = ? AND ca.application_source = 'sl_team_created'
    `, [composerId]);

    if (composers.length === 0) {
      return errorResponse(res, 'Composer not found or not created by SL team', 404);
    }

    const composer = composers[0];

    // Allow multiple activations - no restriction

    // Activate the composer
    await mysqlConnection.execute(
      'UPDATE users SET is_active = TRUE, is_composer = TRUE, updated_at = NOW() WHERE id = ?',
      [composerId]
    );

    // Log the activation (reason is optional)
    const activationNote = `\nActivated by SL Team on ${new Date().toISOString()}${reason ? ` - Reason: ${reason}` : ''}`;
    await mysqlConnection.execute(
      'UPDATE composer_applications SET review_notes = CONCAT(IFNULL(review_notes, ""), ?) WHERE user_id = ?',
      [activationNote, composerId]
    );

    successResponse(res, {
      composerId: composerId,
      composerName: `${composer.first_name} ${composer.last_name}`,
      status: 'active',
      is_composer: true,
      is_active: true,
      activatedAt: new Date().toISOString(),
      reason: reason || null
    }, 'Composer activated successfully');

  } catch (error) {
    console.error('Activate composer error:', error);
    errorResponse(res, 'Failed to activate composer', 500);
  }
});

// @route   PUT /api/composer-applications/deactivate-composer/:composerId
// @desc    Deactivate composer created by SL Team
// @access  Private (SL Team/Admin only)
router.put('/deactivate-composer/:composerId', [
  auth,
  requireAnyRole(['sl_team', 'admin'])
], async (req, res) => {
  try {
    const { composerId } = req.params;
    const { reason } = req.body; // Optional reason for deactivation
    const mysqlConnection = getMySQLConnection();

    // Check if composer exists and was created by SL team
    const [composers] = await mysqlConnection.execute(`
      SELECT u.id, u.first_name, u.last_name, u.is_active, ca.application_source
      FROM users u
      INNER JOIN composer_applications ca ON u.id = ca.user_id
      WHERE u.id = ? AND ca.application_source = 'sl_team_created'
    `, [composerId]);

    if (composers.length === 0) {
      return errorResponse(res, 'Composer not found or not created by SL team', 404);
    }

    const composer = composers[0];

    // Allow multiple deactivations - no restriction

    // Deactivate the composer
    await mysqlConnection.execute(
      'UPDATE users SET is_active = FALSE, updated_at = NOW() WHERE id = ?',
      [composerId]
    );

    // Log the deactivation (reason is optional)
    const deactivationNote = `\nDeactivated by SL Team on ${new Date().toISOString()}${reason ? ` - Reason: ${reason}` : ''}`;
    await mysqlConnection.execute(
      'UPDATE composer_applications SET review_notes = CONCAT(IFNULL(review_notes, ""), ?) WHERE user_id = ?',
      [deactivationNote, composerId]
    );

    successResponse(res, {
      composerId: composerId,
      composerName: `${composer.first_name} ${composer.last_name}`,
      status: 'inactive',
      is_composer: false,
      is_active: false,
      deactivatedAt: new Date().toISOString(),
      reason: reason || null
    }, 'Composer deactivated successfully');

  } catch (error) {
    console.error('Deactivate composer error:', error);
    errorResponse(res, 'Failed to deactivate composer', 500);
  }
});

// @route   PUT /api/composer-applications/toggle-composer-status/:composerId
// @desc    Toggle composer active/inactive status
// @access  Private (SL Team/Admin only)
router.put('/toggle-composer-status/:composerId', [
  auth,
  requireAnyRole('sl_team', 'admin')
], async (req, res) => {
  try {
    const { composerId } = req.params;
    const { reason } = req.body; // Optional reason for status change
    const mysqlConnection = getMySQLConnection();

    // Check if composer exists and was created by SL team
    const [composers] = await mysqlConnection.execute(`
      SELECT u.id, u.first_name, u.last_name, u.is_active, ca.application_source
      FROM users u
      INNER JOIN composer_applications ca ON u.id = ca.user_id
      WHERE u.id = ?
    `, [composerId]);

    if (composers.length === 0) {
      return errorResponse(res, 'Composer not found or not created by SL team', 404);
    }

    const composer = composers[0];
    const newStatus = !composer.is_active;
    const action = newStatus ? 'activated' : 'deactivated';

    // Toggle the composer status
    await mysqlConnection.execute(
      'UPDATE users SET is_active = ?, is_composer = ?, updated_at = NOW() WHERE id = ?',
      [newStatus, newStatus, composerId]
    );

    // Log the status change (reason is optional)
    const statusNote = `\n${action} by SL Team on ${new Date().toISOString()}${reason ? ` - Reason: ${reason}` : ''}`;
    await mysqlConnection.execute(
      'UPDATE composer_applications SET review_notes = CONCAT(IFNULL(review_notes, ""), ?) WHERE user_id = ?',
      [statusNote, composerId]
    );

    successResponse(res, {
      composerId: composerId,
      composerName: `${composer.first_name} ${composer.last_name}`,
      previousStatus: composer.is_active ? 'active' : 'inactive',
      newStatus: newStatus ? 'active' : 'inactive',
      action: action,
      changedAt: new Date().toISOString(),
      reason: reason || null
    }, `Composer ${action} successfully`);

  } catch (error) {
    console.error('Toggle composer status error:', error);
    errorResponse(res, 'Failed to toggle composer status', 500);
  }
});

// @route   GET /api/composer-applications/composer-status/:composerId
// @desc    Get composer status and activity info
// @access  Private (SL Team/Admin only)
router.get('/composer-status/:composerId', [
  auth,
  requireAnyRole(['sl_team', 'admin'])
], async (req, res) => {
  try {
    const { composerId } = req.params;
    const mysqlConnection = getMySQLConnection();

    // Get composer status and activity info
    const [composers] = await mysqlConnection.execute(`
      SELECT 
        u.id,
        u.first_name,
        u.last_name,
        u.email,
        u.is_active,
        u.is_composer,
        u.last_login,
        u.created_at,
        u.updated_at,
        ca.status as application_status,
        ca.reviewed_by,
        ca.reviewed_at,
        ca.review_notes,
        COUNT(mp.id) AS total_publications,
        SUM(CASE WHEN mp.status = 'published' THEN 1 ELSE 0 END) AS published_count,
        SUM(CASE WHEN mp.status = 'draft' THEN 1 ELSE 0 END) AS draft_count
      FROM users u
      INNER JOIN composer_applications ca ON u.id = ca.user_id
      LEFT JOIN music_publications mp ON u.id = mp.composer_id
      WHERE u.id = ? AND u.is_composer = TRUE AND ca.reviewed_by IS NOT NULL
      GROUP BY u.id
    `, [composerId]);

    if (composers.length === 0) {
      return errorResponse(res, 'Composer not found or not created by SL team', 404);
    }

    const composer = composers[0];

    successResponse(res, {
      composerId: composer.id,
      composerName: `${composer.first_name} ${composer.last_name}`,
      email: composer.email,
      isActive: composer.is_active,
      isComposer: composer.is_composer,
      applicationStatus: composer.application_status,
      lastLogin: composer.last_login,
      createdAt: composer.created_at,
      updatedAt: composer.updated_at,
      reviewedBy: composer.reviewed_by,
      reviewedAt: composer.reviewed_at,
      reviewNotes: composer.review_notes,
      statistics: {
        totalPublications: composer.total_publications || 0,
        publishedCount: composer.published_count || 0,
        draftCount: composer.draft_count || 0
      }
    }, 'Composer status retrieved successfully');

  } catch (error) {
    console.error('Get composer status error:', error);
    errorResponse(res, 'Failed to get composer status', 500);
  }
});

// @route   PUT /api/composer-applications/:id/re-approve
// @desc    Re-approve a rejected composer application
// @access  Private (SL Team only)
router.put('/:id/re-approve', [
  auth,
  requireAnyRole(['sl_team'])
], async (req, res) => {
  try {
    const { id } = req.params;
    const { reviewNotes } = req.body;
    const reviewerId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Check if application exists
    const [applications] = await mysqlConnection.execute(
      'SELECT * FROM composer_applications WHERE id = ?',
      [id]
    );

    if (applications.length === 0) {
      return errorResponse(res, 'Application not found', 404);
    }

    const application = applications[0];

    // Check if application is rejected (can only re-approve rejected applications)
    if (application.status !== 'rejected') {
      return errorResponse(res, 'Only rejected applications can be re-approved', 400);
    }

    // Update application status to approved
    const updateFields = ['status = ?', 'reviewed_by = ?', 'reviewed_at = NOW()', 'rejection_reason = NULL', 'updated_at = NOW()'];
    const updateValues = ['approved', reviewerId];

    // Review notes are optional
    if (reviewNotes !== undefined) {
      updateFields.push('review_notes = ?');
      updateValues.push(reviewNotes);
    }

    updateValues.push(id);

    await mysqlConnection.execute(
      `UPDATE composer_applications SET ${updateFields.join(', ')} WHERE id = ?`,
      updateValues
    );

    // Update user's is_composer field to true
    await mysqlConnection.execute(
      'UPDATE users SET is_composer = TRUE WHERE id = ?',
      [application.user_id]
    );

    // Get updated application with reviewer info
    const [updatedApplication] = await mysqlConnection.execute(
      `SELECT ca.*, u.first_name, u.last_name, u.email as user_email,
              r.first_name as reviewer_first_name, r.last_name as reviewer_last_name
       FROM composer_applications ca
       JOIN users u ON ca.user_id = u.id
       LEFT JOIN users r ON ca.reviewed_by = r.id
       WHERE ca.id = ?`,
      [id]
    );

    successResponse(res, {
      application: updatedApplication[0]
    }, 'Application re-approved successfully');

  } catch (error) {
    console.error('Re-approve application error:', error);
    errorResponse(res, 'Failed to re-approve application', 500);
  }
});

// @route   PUT /api/composer-applications/:id/re-reject
// @desc    Re-reject an approved composer application
// @access  Private (SL Team only)
router.put('/:id/re-reject', [
  auth,
  requireAnyRole(['sl_team'])
], async (req, res) => {
  try {
    const { id } = req.params;
    const { rejectionReason, reviewNotes } = req.body;
    const reviewerId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    if (!rejectionReason) {
      return errorResponse(res, 'Rejection reason is required', 400);
    }

    // Check if application exists
    const [applications] = await mysqlConnection.execute(
      'SELECT * FROM composer_applications WHERE id = ?',
      [id]
    );

    if (applications.length === 0) {
      return errorResponse(res, 'Application not found', 404);
    }

    const application = applications[0];

    // Check if application is approved (can only re-reject approved applications)
    if (application.status !== 'approved') {
      return errorResponse(res, 'Only approved applications can be re-rejected', 400);
    }

    // Update application status to rejected
    const updateFields = ['status = ?', 'reviewed_by = ?', 'reviewed_at = NOW()', 'rejection_reason = ?', 'updated_at = NOW()'];
    const updateValues = ['rejected', reviewerId, rejectionReason];

    // Review notes are optional
    if (reviewNotes !== undefined) {
      updateFields.push('review_notes = ?');
      updateValues.push(reviewNotes);
    }

    updateValues.push(id);

    await mysqlConnection.execute(
      `UPDATE composer_applications SET ${updateFields.join(', ')} WHERE id = ?`,
      updateValues
    );

    // Update user's is_composer field to false
    await mysqlConnection.execute(
      'UPDATE users SET is_composer = FALSE WHERE id = ?',
      [application.user_id]
    );

    // Get updated application with reviewer info
    const [updatedApplication] = await mysqlConnection.execute(
      `SELECT ca.*, u.first_name, u.last_name, u.email as user_email,
              r.first_name as reviewer_first_name, r.last_name as reviewer_last_name
       FROM composer_applications ca
       JOIN users u ON ca.user_id = u.id
       LEFT JOIN users r ON ca.reviewed_by = r.id
       WHERE ca.id = ?`,
      [id]
    );

    successResponse(res, {
      application: updatedApplication[0]
    }, 'Application re-rejected successfully');

  } catch (error) {
    console.error('Re-reject application error:', error);
    errorResponse(res, 'Failed to re-reject application', 500);
  }
});

// @route   PUT /api/composer-applications/:id/set-under-review
// @desc    Set composer application back to under_review status
// @access  Private (SL Team only)
router.put('/:id/set-under-review', [
  auth,
  requireAnyRole(['sl_team'])
], async (req, res) => {
  try {
    const { id } = req.params;
    const { reviewNotes } = req.body;
    const reviewerId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Check if application exists
    const [applications] = await mysqlConnection.execute(
      'SELECT * FROM composer_applications WHERE id = ?',
      [id]
    );

    if (applications.length === 0) {
      return errorResponse(res, 'Application not found', 404);
    }

    const application = applications[0];

    // Update application status to under_review
    const updateFields = ['status = ?', 'reviewed_by = ?', 'reviewed_at = NOW()', 'rejection_reason = NULL', 'updated_at = NOW()'];
    const updateValues = ['under_review', reviewerId];

    // Review notes are optional
    if (reviewNotes !== undefined) {
      updateFields.push('review_notes = ?');
      updateValues.push(reviewNotes);
    }

    updateValues.push(id);

    await mysqlConnection.execute(
      `UPDATE composer_applications SET ${updateFields.join(', ')} WHERE id = ?`,
      updateValues
    );

    // Get updated application with reviewer info
    const [updatedApplication] = await mysqlConnection.execute(
      `SELECT ca.*, u.first_name, u.last_name, u.email as user_email,
              r.first_name as reviewer_first_name, r.last_name as reviewer_last_name
       FROM composer_applications ca
       JOIN users u ON ca.user_id = u.id
       LEFT JOIN users r ON ca.reviewed_by = r.id
       WHERE ca.id = ?`,
      [id]
    );

    successResponse(res, {
      application: updatedApplication[0]
    }, 'Application set to under review successfully');

  } catch (error) {
    console.error('Set under review error:', error);
    errorResponse(res, 'Failed to set application under review', 500);
  }
});

// @route   PUT /api/composer-applications/:id/change-status
// @desc    Change composer application status to any status (flexible)
// @access  Private (SL Team only)

router.put('/:id/change-status', [
  auth,
  requireAnyRole(['sl_team'])
], async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reviewNotes, rejectionReason } = req.body;
    const reviewerId = req.user.id;

    const mysqlConnection = getMySQLConnection();

    /* =====================================================
       1️⃣ VALIDATION
    ===================================================== */
    const validStatuses = ['under_review', 'approved', 'rejected'];

    if (!validStatuses.includes(status)) {
      return errorResponse(
        res,
        'Invalid status. Must be under_review, approved, or rejected',
        400
      );
    }

    /* =====================================================
       2️⃣ FETCH APPLICATION + USER
    ===================================================== */
    const [applications] = await mysqlConnection.execute(
      `
      SELECT ca.*, u.email, u.first_name, u.badges
      FROM composer_applications ca
      JOIN users u ON ca.user_id = u.id
      WHERE ca.id = ?
      `,
      [id]
    );

    if (!applications.length) {
      return errorResponse(res, 'Application not found', 404);
    }

    const application = applications[0];
    const userId = application.user_id;

    /* =====================================================
       3️⃣ UPDATE APPLICATION STATUS
    ===================================================== */
    const updateFields = [
      'status = ?',
      'reviewed_by = ?',
      'reviewed_at = NOW()',
      'updated_at = NOW()'
    ];

    const updateValues = [status, reviewerId];

    if (reviewNotes !== undefined) {
      updateFields.push('review_notes = ?');
      updateValues.push(reviewNotes);
    }

    if (status === 'rejected' && rejectionReason) {
      updateFields.push('rejection_reason = ?');
      updateValues.push(rejectionReason);
    } else if (status !== 'rejected') {
      updateFields.push('rejection_reason = NULL');
    }

    updateValues.push(id);

    await mysqlConnection.execute(
      `UPDATE composer_applications SET ${updateFields.join(', ')} WHERE id = ?`,
      updateValues
    );

    /* =====================================================
       🔥 4️⃣ BADGES + PERMISSIONS HELPER
    ===================================================== */
    const regeneratePermissions = async (badges) => {
      if (!badges.length) return {};

      const placeholders = badges.map(() => '?').join(',');

      const [roles] = await mysqlConnection.execute(
        `
        SELECT permissions
        FROM role_permissions
        WHERE role_name IN (${placeholders})
        `,
        badges
      );

      const finalPermissions = {};

      const merge = (src, tgt) => {
        Object.entries(src).forEach(([k, v]) => {
          if (v === 'x' || v === '-') {
            tgt[k] = v;
            return;
          }
          if (typeof v === 'object') {
            if (!tgt[k]) tgt[k] = {};
            merge(v, tgt[k]);
          }
        });
      };

      roles.forEach(r => merge(JSON.parse(r.permissions || '{}'), finalPermissions));

      return finalPermissions;
    };

    /* =====================================================
       5️⃣ USER UPDATE BASED ON STATUS
    ===================================================== */
    let badges = application.badges ? JSON.parse(application.badges) : [];

    if (status === 'approved') {
      // add composer badge
      if (!badges.includes('Composer')) badges.push('Composer');

      const permissions = await regeneratePermissions(badges);

      await mysqlConnection.execute(
        `
        UPDATE users
        SET is_composer = TRUE,
            badges = ?,
            permissions = ?
        WHERE id = ?
        `,
        [JSON.stringify(badges), JSON.stringify(permissions), userId]
      );

      /* ================= EMAIL APPROVED ================= */
      await sendEmail({
        to: application.email,
        subject: 'Your SLC Composer Application has been approved',
        html: `
        <p>Hi ${application.first_name || 'Composer'},</p>

        <p>
        Congratulations! Your Simply Liturgical Composer (SLC) application has been approved. 
        We think your skill set will be a perfect addition to our website!
        </p>
        
        <p><strong>Next steps:</strong></p>
        
        <ol>
          <li>
            Log in to your composer portal: 
            <a href="${process.env.FRONTEND_URL}/login">
              ${process.env.FRONTEND_URL}/login
            </a>
          </li>
          <li>Complete/confirm your composer profile.</li>
          <li>Review submission guidelines/resources.</li>
        </ol>
        
        <p>
        If you have questions, reply to this email or contact 
        <a href="mailto:info@slmusic.org">info@slmusic.org</a>.
        </p>
        
        <p>
        God bless,<br/>
        — Simply Liturgical Composer Team
        </p>
        `
      });
      await createAndDeliverNotification({
        title: "Composer Application Approved ",
        body: "Your composer application has been approved. You can now upload music.",
        metadata: {
          type: "composer_application",
          status: "approved",
          applicationId: id
        },
        channel: "inbox",
        target: {
          type: "custom",
          user_ids: [userId]
        }
      });
    }

    else if (status === 'rejected') {
      // remove composer badge
      badges = badges.filter(b => b !== 'Composer');

      const permissions = await regeneratePermissions(badges);

      await mysqlConnection.execute(
        `
        UPDATE users
        SET is_composer = FALSE,
            badges = ?,
            permissions = ?
        WHERE id = ?
        `,
        [JSON.stringify(badges), JSON.stringify(permissions), userId]
      );

      /* ================= EMAIL REJECTED ================= */
      await sendEmail({
        to: application.email,
        subject: 'Update on your SLC Composer Application',
        html: `
          <p>Hi ${application.first_name || 'Applicant'},</p>
          <p>
          Thank you for applying to Simply Liturgical Composer (SLC).
          </p>          
          <p>
          After review, we’re unable to approve your application at this time.
          </p>          
          ${rejectionReason 
            ? `<p><strong>Notes (if helpful):</strong><br/>${rejectionReason}</p>` 
            : ''
          }          
          <p>
          If you'd like clarification or guidance on next steps, reply to this email or reach us at 
          <a href="mailto:info@slmusic.org">info@slmusic.org</a>.
          </p>          
          <p>
          We’re grateful for your desire to serve the Church through sacred music.
          </p>          
          <p>
          God bless,<br/>
          — Simply Liturgical Composer Team
          </p>
        `
      });
      await createAndDeliverNotification({
        title: "Composer Application Update",
        body: rejectionReason
          ? `Your application was rejected. Reason: ${rejectionReason}`
          : "Your composer application was not approved.",
        metadata: {
          type: "composer_application",
          status: "rejected",
          applicationId: id
        },
        channel: "inbox",
        target: {
          type: "custom",
          user_ids: [userId]
        }
      });
    }

    /* =====================================================
       6️⃣ RETURN UPDATED DATA
    ===================================================== */
    const [updatedApplication] = await mysqlConnection.execute(
      `SELECT * FROM composer_applications WHERE id = ?`,
      [id]
    );

    return successResponse(
      res,
      { application: updatedApplication[0] },
      `Application status changed to ${status} successfully`
    );

  } catch (error) {
    console.error('Change status error:', error);
    return errorResponse(res, 'Failed to change application status', 500);
  }
});

// @route   POST /api/composer-applications/import-composers
// @desc    Import composers from Excel file (SL Team only)
// @access  Private (SL Team only)
router.post('/import-composers', [
  auth,
  requireAnyRole(['sl_team', 'admin']),
  upload.single('excelFile')
], async (req, res) => {
  try {
    if (!req.file) {
      return errorResponse(res, 'No Excel file provided', 400);
    }

    const mysqlConnection = getMySQLConnection();
    const action = (req.query.action || 'import').toLowerCase(); // 'validate' | 'import'
    const results = {
      total: 0,
      success: 0,
      failed: 0,
      errors: [],
      duplicates: []
    };

    try {
      // Parse Excel file
      const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = xlsx.utils.sheet_to_json(worksheet);

      results.total = jsonData.length;

      // Process each row
      for (let i = 0; i < jsonData.length; i++) {
        const row = jsonData[i];
        const rowNumber = i + 2; // Excel row number (header is row 1)

        try {
          // Validate required fields (same as create-composer API)
          const requiredFields = ['email', 'password', 'fullName'];
          const missingFields = requiredFields.filter(field => !row[field]);

          if (missingFields.length > 0) {
            results.failed++;
            results.errors.push(`Row ${rowNumber}: Missing required fields: ${missingFields.join(', ')}`);
            continue;
          }

          // Check if user already exists
          // const [existingUsers] = await mysqlConnection.execute(
          //   'SELECT id FROM users WHERE email = ?',
          //   [row.email]
          // );

          // if (existingUsers.length > 0) {
          //   results.failed++;
          //   results.errors.push(`Row ${rowNumber}: User with email ${row.email} already exists`);
          //   continue;
          // }

          // Check if user already exists
          const [existingUsers] = await mysqlConnection.execute(
            'SELECT id FROM users WHERE email = ?',
            [row.email]
          );

          if (existingUsers.length > 0) {
            if (action === 'validate') {
              results.duplicates.push({ row: rowNumber, email: row.email });
              continue;
            }
            results.failed++;
            results.errors.push(`Row ${rowNumber}: User with email ${row.email} already exists`);
            continue;
          }

          // Hash password
          const saltRounds = 10;
          const hashedPassword = await bcrypt.hash(row.password, saltRounds);

          // Create user (same as create-composer API)
          const [userResult] = await mysqlConnection.execute(
            `INSERT INTO users (first_name, last_name, email, password, phone, role, is_active, is_composer) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              row.fullName.split(' ')[0] || row.fullName, // First name
              row.fullName.split(' ').slice(1).join(' ') || '', // Last name
              row.email,
              hashedPassword,
              row.phoneNumber || null,
              'free_user',
              1, // Active
              1  // is_composer = 1
            ]
          );

          const userId = userResult.insertId;
          console.log(`✅ User created with ID: ${userId}`);

          // Create composer application (exact same as create-composer API)
          console.log(`📝 Creating composer application for user ID: ${userId}`);
          const [appResult] = await mysqlConnection.execute(
            `INSERT INTO composer_applications (
              user_id, 
              status,
              application_source,
              full_name,
              email,
              phone_number,
              street_address,
              address_line_2,
              city,
              state_province,
              zip_code,
              country,
              music_background,
              composition_background,
              accompaniment_types,
              other_instrumentation,
              church_affiliation,
              liturgical_draw,
              liturgical_purpose,
              notation_software_proficiency,
              digitization_method,
              notation_software_used,
              composition_1_title,
              composition_1_liturgical_use,
              composition_1_other_info,
              composition_1_files,
              composition_2_title,
              composition_2_liturgical_use,
              composition_2_other_info,
              composition_2_files,
              composition_3_title,
              composition_3_liturgical_use,
              composition_3_other_info,
              composition_3_files,
              terms_accepted,
              terms_accepted_at,
              reviewed_by,
              reviewed_at,
              review_notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, NOW(), ?)`,
            [
              userId,
              'approved', // Auto-approved
              'sl_team_created', // Application source
              row.fullName,
              row.email,
              row.phoneNumber || null,
              row.streetAddress || null,
              row.addressLine2 || null,
              row.city || null,
              row.stateProvince || null,
              row.zipCode || null,
              row.country || null,
              row.musicBackground || null,
              row.compositionBackground || null,
              row.accompanimentTypes ? JSON.stringify(row.accompanimentTypes) : null,
              row.otherInstrumentation || null,
              row.churchAffiliation || null,
              row.liturgicalDraw || null,
              row.liturgicalPurpose || null,
              row.notationSoftwareProficiency || 'Beginner',
              row.digitizationMethod || null,
              row.notationSoftwareUsed || null,
              row.composition1Title || null,
              row.composition1LiturgicalUse || null,
              row.composition1OtherInfo || null,
              row.composition1Files ? JSON.stringify(row.composition1Files) : null,
              row.composition2Title || null,
              row.composition2LiturgicalUse || null,
              row.composition2OtherInfo || null,
              row.composition2Files ? JSON.stringify(row.composition2Files) : null,
              row.composition3Title || null,
              row.composition3LiturgicalUse || null,
              row.composition3OtherInfo || null,
              row.composition3Files ? JSON.stringify(row.composition3Files) : null,
              true, // terms_accepted
              req.user.id, // reviewed_by
              `Created by ${req.user.first_name} ${req.user.last_name} (${req.user.role})` // review_notes
            ]
          );

          console.log(`✅ Composer application created with ID: ${appResult.insertId}`);
          results.success++;

        } catch (rowError) {
          results.failed++;
          console.error(`❌ Row ${rowNumber} error:`, rowError);
          console.error(`❌ Row data:`, row);
          results.errors.push(`Row ${rowNumber}: ${rowError.message}`);
        }
      }

      successResponse(res, {
        importResults: results,
        message: `Import completed. ${results.success} composers imported successfully, ${results.failed} failed.`
      }, 'Composer import completed');

    } catch (parseError) {
      console.error('Excel parse error:', parseError);
      errorResponse(res, 'Failed to parse Excel file', 500);
    }

  } catch (error) {
    console.error('Import composers error:', error);
    errorResponse(res, 'Failed to import composers', 500);
  }
});

// @route   GET /api/composer-applications/import-template
// @desc    Download Excel template for composer import
// @access  Private (SL Team only)
router.get('/import-template', [
  auth,
  requireAnyRole(['sl_team', 'admin'])
], async (req, res) => {
  try {
    // Create template data (same fields as create-composer API)
    const templateData = [
      {
        email: 'john.doe@example.com',
        password: 'password123',
        fullName: 'John Doe',
        phoneNumber: '+1234567890',
        streetAddress: '123 Main St',
        addressLine2: 'Apt 4B',
        city: 'Los Angeles',
        stateProvince: 'California',
        zipCode: '90210',
        country: 'USA',
        musicBackground: 'Classical',
        compositionBackground: 'Choral',
        accompanimentTypes: 'Piano,Organ',
        otherInstrumentation: 'Strings,Brass',
        churchAffiliation: 'Catholic',
        liturgicalDraw: 'Traditional',
        liturgicalPurpose: 'Worship',
        notationSoftwareProficiency: 'Advanced',
        digitizationMethod: 'Manual',
        notationSoftwareUsed: 'Sibelius',
        composition1Title: 'Sample Composition 1',
        composition1LiturgicalUse: 'Mass',
        composition1OtherInfo: 'Sample info',
        composition2Title: 'Sample Composition 2',
        composition2LiturgicalUse: 'Vespers',
        composition2OtherInfo: 'Sample info',
        composition3Title: 'Sample Composition 3',
        composition3LiturgicalUse: 'Matins',
        composition3OtherInfo: 'Sample info'
      }
    ];

    // Create workbook
    const workbook = xlsx.utils.book_new();
    const worksheet = xlsx.utils.json_to_sheet(templateData);

    // Add headers (same fields as create-composer API)
    const headers = [
      'email', 'password', 'fullName', 'phoneNumber',
      'streetAddress', 'addressLine2', 'city', 'stateProvince', 'zipCode', 'country',
      'musicBackground', 'compositionBackground', 'accompanimentTypes', 'otherInstrumentation',
      'churchAffiliation', 'liturgicalDraw', 'liturgicalPurpose',
      'notationSoftwareProficiency', 'digitizationMethod', 'notationSoftwareUsed',
      'composition1Title', 'composition1LiturgicalUse', 'composition1OtherInfo',
      'composition2Title', 'composition2LiturgicalUse', 'composition2OtherInfo',
      'composition3Title', 'composition3LiturgicalUse', 'composition3OtherInfo'
    ];

    xlsx.utils.sheet_add_aoa(worksheet, [headers], { origin: 'A1' });
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Composers');

    // Generate Excel buffer
    const excelBuffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    // Set response headers
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="composer-import-template.xlsx"');
    res.setHeader('Content-Length', excelBuffer.length);

    // Send file
    res.send(excelBuffer);

  } catch (error) {
    console.error('Template download error:', error);
    errorResponse(res, 'Failed to generate template', 500);
  }
});

module.exports = router;