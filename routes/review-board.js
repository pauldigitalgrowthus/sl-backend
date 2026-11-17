const express = require('express');
const router = express.Router();
const { getMySQLConnection } = require('../config/mysql');
const { auth, requireAnyRole } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');
const { reviewBoardDocumentUpload, reviewBoardPhotoUpload, uploadToS3, deleteFromS3 } = require('../config/s3');
const multer = require('multer');
const XLSX = require('xlsx');
const { sendEmail } = require('../utils/SendMailer');
const { createAndDeliverNotification } = require('../utils/notificationUtils')

// Configure multer for photo upload
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

// Multer for Excel uploads (separate to avoid image restrictions)
const excelUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const name = (file.originalname || '').toLowerCase();
    if (
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      name.endsWith('.xlsx') ||
      name.endsWith('.xls')
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel files (.xlsx, .xls) are allowed'), false);
    }
  }
});

router.post('/apply', auth, async (req, res) => {
  const connection = await getMySQLConnection();
  console.log("req.body:", req.body);
  console.log("req.user:", req.user); // DEBUG: User object check karo

  try {
    // User ID ko pehle check karo
    const userId = req.user?.userId || req.user?.id;

    if (!userId) {
      console.error("User ID not found in request");
      return errorResponse(res, 'User authentication failed', 401);
    }

    console.log("Processing for userId:", userId); // DEBUG

    // Destructure aur immediately null convert karo (empty strings ko bhi null banao)
    let {
      firstName,
      lastName,
      email,
      password,
      phone,
      address,
      gender,
      photo,
      bio
    } = req.body;

    // Empty strings ko null mein convert karo
    phone = phone?.trim() || null;
    address = address?.trim() || null;
    gender = gender?.trim() || null;
    photo = photo?.trim() || null;
    bio = bio?.trim() || null;

    console.log("Processed values:", { // DEBUG
      userId, firstName, lastName, email,
      phone, address, gender, photo, bio: bio ? 'present' : 'null'
    });

    // Check if user already has a pending or approved application
    const [existingApplications] = await connection.execute(
      'SELECT id, status FROM review_board_applications WHERE user_id = ? AND status IN ("pending", "approved")',
      [userId]
    );

    if (existingApplications.length > 0) {
      return errorResponse(res, 'You already have a review board application. Please wait for review or contact support.', 400);
    }

    // Validate required fields
    if (!firstName || !lastName || !email || !password) {
      return errorResponse(res, 'First name, last name, email and password are required', 400);
    }

    // Update user information if provided
    const userUpdateFields = [];
    const userUpdateValues = [];

    if (firstName?.trim()) {
      userUpdateFields.push('first_name = ?');
      userUpdateValues.push(firstName.trim());
    }

    if (lastName?.trim()) {
      userUpdateFields.push('last_name = ?');
      userUpdateValues.push(lastName.trim());
    }

    if (email?.trim()) {
      userUpdateFields.push('email = ?');
      userUpdateValues.push(email.trim());
    }

    // Phone ke liye - only if not null
    if (phone !== null && phone !== '') {
      userUpdateFields.push('phone = ?');
      userUpdateValues.push(phone);
    }

    // Photo/Avatar ke liye
    if (photo !== null && photo !== '') {
      userUpdateFields.push('avatar = ?');
      userUpdateValues.push(photo);
    }

    // Bio ke liye
    if (bio !== null && bio !== '') {
      userUpdateFields.push('bio = ?');
      userUpdateValues.push(bio);
    }

    // Password hashing
    if (password) {
      const bcrypt = require('bcryptjs');
      const hashedPassword = await bcrypt.hash(password, 12);
      userUpdateFields.push('password = ?');
      userUpdateValues.push(hashedPassword);
    }

    // User update query execute karo (agar koi field update karna hai)
    if (userUpdateFields.length > 0) {
      userUpdateFields.push('updated_at = NOW()');
      userUpdateValues.push(userId);

      console.log("Updating user with fields:", userUpdateFields); // DEBUG
      console.log("Update values:", userUpdateValues); // DEBUG

      await connection.execute(
        `UPDATE users SET ${userUpdateFields.join(', ')} WHERE id = ?`,
        userUpdateValues
      );
    }

    // Insert application - Explicitly ensure no undefined values
    const insertParams = [
      userId,
      firstName?.trim() || null,
      lastName?.trim() || null,
      email?.trim() || null,
      phone,
      address,
      gender,
      photo,
      bio,
      'user_submitted'
    ];

    console.log("Insert params:", insertParams); // DEBUG

    // Check for any undefined values
    const hasUndefined = insertParams.some(param => param === undefined);
    if (hasUndefined) {
      console.error("Found undefined in insert params:", insertParams);
      return errorResponse(res, 'Invalid data provided', 400);
    }

    const [result] = await connection.execute(
      `INSERT INTO review_board_applications (
        user_id, first_name, last_name, email, phone, address, gender, photo, bio, application_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      insertParams
    );

    return successResponse(res, {
      message: 'Review board application submitted successfully',
      applicationId: result.insertId
    }, 201);

  } catch (error) {
    console.error('Error submitting review board application:', error);
    console.error('Error stack:', error.stack); // Full stack trace
    return errorResponse(res, 'Failed to submit application', 500);
  }
});

// Upload documents for review board application
router.post('/upload-documents', auth, reviewBoardDocumentUpload.fields([
  { name: 'resume', maxCount: 1 },
  { name: 'portfolio', maxCount: 1 },
  { name: 'additionalDocuments', maxCount: 5 }
]), async (req, res) => {
  const connection = await getMySQLConnection();

  try {
    const userId = req.user.userId;
    const files = req.files;

    if (!files || Object.keys(files).length === 0) {
      return errorResponse(res, 'No files uploaded', 400);
    }

    // Get current application
    const [applications] = await connection.execute(
      'SELECT id FROM review_board_applications WHERE user_id = ? AND status = "pending" ORDER BY created_at DESC LIMIT 1',
      [userId]
    );

    if (applications.length === 0) {
      return errorResponse(res, 'No pending application found', 404);
    }

    const applicationId = applications[0].id;
    const updateFields = [];
    const updateValues = [];

    // Handle resume upload
    if (files.resume && files.resume[0]) {
      updateFields.push('resume_file_url = ?');
      updateValues.push(files.resume[0].location);
    }

    // Handle portfolio upload
    if (files.portfolio && files.portfolio[0]) {
      updateFields.push('portfolio_file_url = ?');
      updateValues.push(files.portfolio[0].location);
    }

    // Handle additional documents
    if (files.additionalDocuments && files.additionalDocuments.length > 0) {
      const additionalDocs = files.additionalDocuments.map(file => ({
        fileName: file.originalname,
        fileUrl: file.location,
        fileSize: file.size,
        fileType: file.mimetype,
        uploadedAt: new Date().toISOString()
      }));
      updateFields.push('additional_documents = ?');
      updateValues.push(JSON.stringify(additionalDocs));
    }

    if (updateFields.length === 0) {
      return errorResponse(res, 'No valid files to upload', 400);
    }

    updateValues.push(applicationId);

    await connection.execute(
      `UPDATE review_board_applications SET ${updateFields.join(', ')} WHERE id = ?`,
      updateValues
    );

    return successResponse(res, {
      message: 'Documents uploaded successfully',
      uploadedFiles: {
        resume: files.resume ? files.resume[0]?.location : null,
        portfolio: files.portfolio ? files.portfolio[0]?.location : null,
        additionalDocuments: files.additionalDocuments ? files.additionalDocuments.map(f => f.location) : []
      }
    });

  } catch (error) {
    console.error('Error uploading documents:', error);
    return errorResponse(res, 'Failed to upload documents', 500);
  } finally {
    connection.release();
  }
});

// Get user's review board application status
router.get('/my-application', auth, async (req, res) => {
  const connection = await getMySQLConnection();

  try {
    const userId = req.user.userId;

    const [applications] = await connection.execute(
      `SELECT 
        id, status, full_name, email, phone, date_of_birth, address, city, state, country, postal_code,
        current_position, organization, years_of_experience, specialization, education_background,
        musical_education, instruments_played, genres_specialized, notable_achievements, awards_received,
        why_join_review_board, areas_of_expertise, previous_review_experience, availability_hours_per_week, preferred_review_categories,
        reference_1_name, reference_1_email, reference_1_phone, reference_1_relationship,
        reference_2_name, reference_2_email, reference_2_phone, reference_2_relationship,
        resume_file_url, portfolio_file_url, additional_documents,
        review_notes, rejection_reason, reviewed_at, created_at, updated_at
       FROM review_board_applications 
       WHERE user_id = ? 
       ORDER BY created_at DESC 
       LIMIT 1`,
      [userId]
    );

    if (applications.length === 0) {
      return successResponse(res, { application: null, message: 'No application found' });
    }

    const application = applications[0];

    // Parse additional documents if they exist
    if (application.additional_documents) {
      try {
        application.additional_documents = JSON.parse(application.additional_documents);
      } catch (e) {
        application.additional_documents = [];
      }
    }

    return successResponse(res, { application });

  } catch (error) {
    console.error('Error fetching application:', error);
    return errorResponse(res, 'Failed to fetch application', 500);
  } finally {
    connection.release();
  }
});

// Get all pending applications (Admin only)
router.get('/pending', auth, requireAnyRole(['admin', 'sl_team']), async (req, res) => {
  const connection = await getMySQLConnection();

  try {
    const [applications] = await connection.execute(
      `SELECT 
        rba.id, rba.user_id, rba.status, rba.full_name, rba.email, rba.phone, rba.current_position, rba.organization,
        rba.years_of_experience, rba.specialization, rba.musical_education, rba.instruments_played,
        rba.why_join_review_board, rba.areas_of_expertise, rba.availability_hours_per_week,
        rba.resume_file_url, rba.portfolio_file_url, rba.additional_documents,
        rba.created_at, rba.updated_at,
        u.username, u.email as user_email
       FROM review_board_applications rba
       JOIN users u ON rba.user_id = u.id
       WHERE rba.status = 'pending'
       ORDER BY rba.created_at ASC`
    );

    // Parse additional documents for each application
    applications.forEach(app => {
      if (app.additional_documents) {
        try {
          app.additional_documents = JSON.parse(app.additional_documents);
        } catch (e) {
          app.additional_documents = [];
        }
      }
    });

    return successResponse(res, {
      applications,
      total: applications.length
    });

  } catch (error) {
    console.error('Error fetching pending applications:', error);
    return errorResponse(res, 'Failed to fetch pending applications', 500);
  } finally {
    connection.release();
  }
});

// Approve/Reject application (Admin only)
router.put('/:id/review', auth, requireAnyRole(['admin', 'sl_team']), async (req, res) => {
  const connection = await getMySQLConnection();
  console.log("Review request body:", req.body); // DEBUG

  try {
    const applicationId = req.params.id;
    const reviewerId = req.user?.userId || req.user?.id;

    // Destructure aur null handling
    let { status, reviewNotes, rejectionReason } = req.body;

    // Undefined ko null mein convert karo
    reviewNotes = reviewNotes?.trim() || null;
    rejectionReason = rejectionReason?.trim() || null;

    console.log("Processed review data:", { // DEBUG
      status,
      reviewerId,
      reviewNotes: reviewNotes ? 'present' : 'null',
      rejectionReason: rejectionReason ? 'present' : 'null'
    });

    // Validation
    if (!['approved', 'rejected'].includes(status)) {
      return errorResponse(res, 'Invalid status. Must be "approved" or "rejected"', 400);
    }

    if (status === 'rejected' && !rejectionReason) {
      return errorResponse(res, 'Rejection reason is required when rejecting an application', 400);
    }

    // -------------------------------------------
    // 1. First get application details to know user_id
    // -------------------------------------------
    const [applicationRows] = await connection.execute(
      `SELECT user_id FROM review_board_applications WHERE id = ?`,
      [applicationId]
    );

    if (applicationRows.length === 0) {
      return errorResponse(res, 'Application not found', 404);
    }

    const userId = applicationRows[0].user_id;

    // -------------------------------------------
    // 2. Update review status - NULL values properly handle karo
    // -------------------------------------------
    const updateParams = [
      status,
      reviewerId,
      reviewNotes,        // Ab yeh null ho sakta hai, undefined nahi
      rejectionReason,    // Ab yeh null ho sakta hai, undefined nahi
      applicationId
    ];

    console.log("Update params:", updateParams); // DEBUG

    const [result] = await connection.execute(
      `UPDATE review_board_applications 
       SET status = ?, reviewed_by = ?, reviewed_at = NOW(), review_notes = ?, rejection_reason = ?
       WHERE id = ? AND status = 'pending'`,
      updateParams
    );

    if (result.affectedRows === 0) {
      return errorResponse(res, 'Application not found or already reviewed', 404);
    }

    // -------------------------------------------
    // 3. If approved → update user.is_composer = true
    // -------------------------------------------
    if (status === 'approved') {
      await connection.execute(
        `UPDATE users SET is_composer = 1 WHERE id = ?`,
        [userId]
      );
    }

    return successResponse(res, {
      message: `Application ${status} successfully`,
      applicationId: parseInt(applicationId),
      updatedUserId: userId
    });

  } catch (error) {
    console.error('Error reviewing application:', error);
    console.error('Error stack:', error.stack); // DEBUG
    return errorResponse(res, 'Failed to review application', 500);
  }
});

// Get all approved review board members (Public)
router.get('/members', async (req, res) => {
  const connection = await getMySQLConnection();

  try {
    const [members] = await connection.execute(
      `SELECT 
        rba.id, rba.first_name, rba.last_name, rba.email, rba.phone, rba.address, rba.gender, rba.photo,
        rba.created_at, rba.updated_at, rba.status,
        u.id as user_id, u.is_active, u.created_at as user_created_at
       FROM review_board_applications rba
       JOIN users u ON rba.user_id = u.id
       WHERE rba.status = 'approved'
       ORDER BY rba.created_at DESC`
    );

    return successResponse(res, {
      members,
      total: members.length
    });

  } catch (error) {
    console.error('Error fetching review board members:', error);
    return errorResponse(res, 'Failed to fetch review board members', 500);
  } finally {
    connection.release();
  }
});

// Public: Get SL Team created and approved review board members
// @route   GET /api/review-board/public/sl-team-members
// @desc    Public list of approved review board members created by SL Team
// @access  Public
router.get('/public/sl-team-members', async (req, res) => {
  let connection;
  try {
    connection = await getMySQLConnection();

    const [members] = await connection.execute(
      `SELECT 
        u.id as user_id,
        rba.id as application_id,
        rba.first_name,
        rba.last_name,
        rba.email,
        rba.phone,
        rba.address,
        rba.gender,
        rba.photo,
        rba.bio,
        rba.reviewed_at as joined_at
       FROM review_board_applications rba
       INNER JOIN users u ON rba.user_id = u.id
       WHERE rba.status = 'approved' AND rba.application_source = 'sl_team_created'
       ORDER BY (rba.reviewed_at IS NULL) ASC, rba.reviewed_at DESC, rba.created_at DESC`
    );

    return successResponse(res, {
      members,
      total: members.length
    });

  } catch (error) {
    console.error('Error fetching public SL team review board members:', error);
    return errorResponse(res, 'Failed to fetch review board members', 500);
  } finally {
    try { if (connection && typeof connection.release === 'function') connection.release(); } catch (_) { }
  }
});

// Get specific review board member details (Public)
router.get('/members/:id', async (req, res) => {
  const connection = await getMySQLConnection();

  try {
    const memberId = req.params.id;

    const [members] = await connection.execute(
      `SELECT 
        rba.id, rba.full_name, rba.email, rba.current_position, rba.organization, rba.specialization,
        rba.musical_education, rba.instruments_played, rba.genres_specialized, rba.areas_of_expertise,
        rba.notable_achievements, rba.awards_received, rba.portfolio_file_url, rba.additional_documents,
        rba.reviewed_at as joined_date,
        u.username, u.avatar
       FROM review_board_applications rba
       JOIN users u ON rba.user_id = u.id
       WHERE rba.id = ? AND rba.status = 'approved'`,
      [memberId]
    );

    if (members.length === 0) {
      return errorResponse(res, 'Review board member not found', 404);
    }

    const member = members[0];

    // Parse additional documents if they exist
    if (member.additional_documents) {
      try {
        member.additional_documents = JSON.parse(member.additional_documents);
      } catch (e) {
        member.additional_documents = [];
      }
    }

    return successResponse(res, { member });

  } catch (error) {
    console.error('Error fetching review board member:', error);
    return errorResponse(res, 'Failed to fetch review board member', 500);
  } finally {
    connection.release();
  }
});

// @route   POST /api/review-board/upload-photo
// @desc    Upload photo for review board member
// @access  Private (SL Team/Admin only)
router.post('/upload-photo', [
  auth,
  requireAnyRole(['sl_team', 'admin']),
  reviewBoardPhotoUpload.single('photo')
], async (req, res) => {
  try {
    if (!req.file) {
      return errorResponse(res, 'No photo file provided', 400);
    }

    // Photo is already uploaded to S3 by multer-s3
    const photoUrl = req.file.location;

    successResponse(res, {
      photoUrl: photoUrl,
      message: 'Photo uploaded successfully'
    }, 'Photo uploaded successfully');

  } catch (error) {
    console.error('Photo upload error:', error);
    errorResponse(res, 'Failed to upload photo', 500);
  }
});

// @route   POST /api/review-board/upload-photo-user
// @desc    Upload photo for review board application (User)
// @access  Private (Authenticated users)
router.post('/upload-photo-user', [
  auth,
  reviewBoardPhotoUpload.single('photo')
], async (req, res) => {
  try {
    if (!req.file) {
      return errorResponse(res, 'No photo file provided', 400);
    }

    // Photo is already uploaded to S3 by multer-s3
    const photoUrl = req.file.location;

    successResponse(res, {
      photoUrl: photoUrl,
      message: 'Photo uploaded successfully'
    }, 'Photo uploaded successfully');

  } catch (error) {
    console.error('Photo upload error:', error);
    errorResponse(res, 'Failed to upload photo', 500);
  }
});

// @route   DELETE /api/review-board/delete-photo
// @desc    Delete photo from S3
// @access  Private (SL Team/Admin only)
router.delete('/delete-photo', [
  auth,
  requireAnyRole(['sl_team', 'admin'])
], async (req, res) => {
  try {
    const { photoUrl } = req.body;

    if (!photoUrl) {
      return errorResponse(res, 'Photo URL is required', 400);
    }

    // Delete from S3
    await deleteFromS3(photoUrl);

    successResponse(res, {
      message: 'Photo deleted successfully'
    }, 'Photo deleted successfully');

  } catch (error) {
    console.error('Photo delete error:', error);
    errorResponse(res, 'Failed to delete photo', 500);
  }
});

// @route   POST /api/review-board/create-member
// @desc    Create review board member directly by SL Team/Admin (auto-approved)
// @access  Private (SL Team/Admin only)
router.post('/create-member', [
  auth,
  requireAnyRole(['sl_team', 'admin']),
  reviewBoardPhotoUpload.single('photo')
], async (req, res) => {
  let connection;
  try {
    const {
      // All fields are now optional
      firstName,
      lastName,
      email,
      password,
      phone,
      address1,
      address2,
      gender,
      photo,
      bio,
      city,
      state,
      zipCode,
      country
    } = req.body;

    // basic validation
    if (!email) {
      return errorResponse(res, 'Email is required', 400);
    }

    connection = await getMySQLConnection();

    // handle uploaded file (multer-s3) if present
    let photoUrl = null;
    if (req.file && req.file.location) {
      photoUrl = req.file.location;
    }

    // check existing user
    const [existingUsers] = await connection.execute(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );
    if (existingUsers.length > 0) {
      return errorResponse(res, 'User with this email already exists', 400);
    }

    // hash password (or generate random one)
    const bcrypt = require('bcryptjs');
    let hashedPassword;
    if (password) {
      hashedPassword = await bcrypt.hash(password, 12);
    } else {
      const randomPassword = Math.random().toString(36).slice(-8);
      hashedPassword = await bcrypt.hash(randomPassword, 12);
    }

    // detect whether users table has is_review_board_member column
    let hasIsReviewBoardMember = false;
    try {
      const [isRbmCol] = await connection.execute(
        "SHOW COLUMNS FROM users LIKE 'is_review_board_member'"
      );
      hasIsReviewBoardMember = isRbmCol.length > 0;
    } catch (_) {
      hasIsReviewBoardMember = false;
    }

    // Build user insert columns/values
    const userColumns = [
      'first_name',
      'last_name',
      'email',
      'password',
      'phone',
      'avatar',
      'role',
      'user_type',
      'is_active',
      'is_composer'
    ];
    const userValues = [
      firstName || 'Review Board',
      lastName || 'Member',
      email,
      hashedPassword,
      phone || null,
      photoUrl || photo || null,
      'sl_team',
      // ensure we don't insert an invalid enum — use a safe fallback
      'sub_user',
      1,
      1
    ];

    if (hasIsReviewBoardMember) {
      userColumns.push('is_review_board_member');
      userValues.push(1);
    }

    const userPlaceholders = userColumns.map(() => '?').join(', ');
    const [userResult] = await connection.execute(
      `INSERT INTO users (${userColumns.join(', ')}) VALUES (${userPlaceholders})`,
      userValues
    );

    const newUserId = userResult.insertId;

    // prepare to create review_board_application
    // detect optional columns
    const [colsTa] = await connection.execute(
      "SHOW COLUMNS FROM review_board_applications LIKE 'terms_accepted'"
    );
    const [colsTAt] = await connection.execute(
      "SHOW COLUMNS FROM review_board_applications LIKE 'terms_accepted_at'"
    );

    // base columns (keep order predictable)
    const appColumns = [
      'user_id',
      'status',
      'application_source',
      'first_name',
      'last_name',
      'email',
      'phone',
      'address',
      'gender',
      'photo',
      'bio'
    ];

    const appValues = [
      newUserId,
      'approved',
      'sl_team_created',
      firstName || 'Review Board',
      lastName || 'Member',
      email,
      phone || null,
      address1 || null,
      gender || null,
      photoUrl || photo || null,
      bio || null
    ];

    // Insert optional terms_accepted and terms_accepted_at before reviewed_by (keep insertion deterministic)
    if (colsTa.length > 0) {
      appColumns.push('terms_accepted');
      appValues.push(1);
    }
    if (colsTAt.length > 0) {
      appColumns.push('terms_accepted_at');
      appValues.push(new Date());
    }

    // reviewed_by / reviewed_at / review_notes
    const reviewedById = req.user?.userId || req.user?.id || null;
    appColumns.push('reviewed_by');
    appValues.push(reviewedById);

    appColumns.push('reviewed_at');
    appValues.push(new Date());

    appColumns.push('review_notes');
    appValues.push('SL Team created member - auto-approved');

    // Add address breakdown columns if present in your schema
    // (We added them earlier in table creation: city, state, Zipcode, country, address2)
    // Use lower camel variable names to map incoming payload properly
    // If your DB column is 'Zipcode' (capital Z) keep that exact name in appColumns
    appColumns.push('city');
    appValues.push(city || null);

    appColumns.push('state');
    appValues.push(state || null);

    // Respect the column name you created earlier: 'Zipcode' (capital Z)
    appColumns.push('Zipcode');
    appValues.push(zipCode || null);

    appColumns.push('country');
    appValues.push(country || null);

    appColumns.push('address2');
    appValues.push(address2 || null);

    const appPlaceholders = appColumns.map(() => '?').join(', ');
    const [appResult] = await connection.execute(
      `INSERT INTO review_board_applications (${appColumns.join(', ')}) VALUES (${appPlaceholders})`,
      appValues
    );

    const applicationId = appResult.insertId;

    // success response (use address1 because that's the incoming field)
    successResponse(
      res,
      {
        message: 'Review board member created successfully',
        member: {
          id: newUserId,
          applicationId,
          firstName: firstName || 'Review Board',
          lastName: lastName || 'Member',
          email,
          phone: phone || null,
          address: address1 || null,
          address2: address2 || null,
          gender: gender || null,
          photo: photoUrl || photo || null,
          bio: bio || null,
          city: city || null,
          state: state || null,
          zipCode: zipCode || null,
          country: country || null,
          status: 'approved',
          applicationSource: 'sl_team_created',
          createdAt: new Date().toISOString()
        }
      },
      'Review board member created successfully'
    );
  } catch (error) {
    console.error('Create review board member error:', error);
    errorResponse(res, 'Failed to create review board member', 500);
  } finally {
    try {
      if (connection && typeof connection.release === 'function') {
        connection.release();
      }
    } catch (_) { }
  }
}
);


// @route   PUT /api/review-board/:id/activate
// @desc    Activate review board member by SL Team/Admin
// @access  Private (SL Team/Admin only)
router.put('/:id/activate', [
  auth,
  requireAnyRole(['sl_team', 'admin'])
], async (req, res) => {
  let connection;
  try {
    const { id } = req.params;
    connection = await getMySQLConnection();

    // Check if review board member exists
    const [member] = await connection.execute(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.is_active, rba.status 
       FROM users u 
       LEFT JOIN review_board_applications rba ON u.id = rba.user_id 
       WHERE u.id = ? AND rba.application_source = 'sl_team_created'`,
      [id]
    );

    if (member.length === 0) {
      return errorResponse(res, 'Review board member not found', 404);
    }

    // Activate the member
    await connection.execute(
      'UPDATE users SET is_active = 1 WHERE id = ?',
      [id]
    );

    // Update application status if exists
    await connection.execute(
      'UPDATE review_board_applications SET status = ? WHERE user_id = ?',
      ['approved', id]
    );

    successResponse(res, {
      message: 'Review board member activated successfully',
      member: {
        id: member[0].id,
        name: `${member[0].first_name} ${member[0].last_name}`,
        email: member[0].email,
        status: 'active'
      }
    }, 'Review board member activated successfully');

  } catch (error) {
    console.error('Activate review board member error:', error);
    errorResponse(res, 'Failed to activate review board member', 500);
  } finally {
    try { if (connection && typeof connection.release === 'function') connection.release(); } catch (_) { }
  }
});

// @route   PUT /api/review-board/:id/deactivate
// @desc    Deactivate review board member by SL Team/Admin
// @access  Private (SL Team/Admin only)
router.put('/:id/deactivate', [
  auth,
  requireAnyRole(['sl_team', 'admin'])
], async (req, res) => {
  let connection;
  try {
    const { id } = req.params;
    connection = await getMySQLConnection();

    // Check if review board member exists
    const [member] = await connection.execute(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.is_active, rba.status 
       FROM users u 
       LEFT JOIN review_board_applications rba ON u.id = rba.user_id 
       WHERE u.id = ? AND rba.application_source = 'sl_team_created'`,
      [id]
    );

    if (member.length === 0) {
      return errorResponse(res, 'Review board member not found', 404);
    }

    // Deactivate the member
    await connection.execute(
      'UPDATE users SET is_active = 0 WHERE id = ?',
      [id]
    );

    // Update application status if exists
    await connection.execute(
      'UPDATE review_board_applications SET status = ? WHERE user_id = ?',
      ['inactive', id]
    );

    successResponse(res, {
      message: 'Review board member deactivated successfully',
      member: {
        id: member[0].id,
        name: `${member[0].first_name} ${member[0].last_name}`,
        email: member[0].email,
        status: 'inactive'
      }
    }, 'Review board member deactivated successfully');

  } catch (error) {
    console.error('Deactivate review board member error:', error);
    errorResponse(res, 'Failed to deactivate review board member', 500);
  } finally {
    try { if (connection && typeof connection.release === 'function') connection.release(); } catch (_) { }
  }
});

// @route   GET /api/review-board/sl-team-members
// @desc    Get all review board members created by SL Team
// @access  Private (SL Team/Admin only)
router.get('/sl-team-members', [
  auth,
  requireAnyRole(['sl_team', 'admin'])
], async (req, res) => {
  let connection;
  try {
    connection = await getMySQLConnection();

    // Get all review board members created by SL team
    const [members] = await connection.execute(`
      SELECT 
        u.id,
        u.first_name,
        u.last_name,
        u.email,
        u.phone,
        u.avatar,
        u.is_active,
        u.created_at,
        rba.id as application_id,
        rba.status,
        rba.application_source,
        rba.first_name as app_first_name,
        rba.last_name as app_last_name,
        rba.address,
        rba.gender,
        rba.photo,
        rba.city,
        rba.address2,
        rba.Zipcode,
        rba.state,
        rba.country,
        rba.bio,
        rba.reviewed_by,
        rba.reviewed_at,
        rba.created_at as application_created_at
      FROM users u
      INNER JOIN review_board_applications rba ON u.id = rba.user_id
      WHERE rba.application_source = 'sl_team_created'
      ORDER BY rba.created_at DESC
    `);

    // Format the response to include photo properly
    const formattedMembers = members.map(member => ({
      id: member.id,
      applicationId: member.application_id,
      firstName: member.first_name || member.app_first_name,
      lastName: member.last_name || member.app_last_name,
      email: member.email,
      phone: member.phone,
      address: member.address,
      gender: member.gender,
      photo: member.photo, // This will include the S3 photo URL
      address2: member.address2,
      city: member.city,
      zipcode: member.Zipcode,
      state: member.state,
      country: member.country,
      bio: member.bio,
      avatar: member.avatar, // User avatar from users table
      status: member.status,
      applicationSource: member.application_source,
      isActive: member.is_active,
      reviewedBy: member.reviewed_by,
      reviewedAt: member.reviewed_at,
      createdAt: member.created_at,
      applicationCreatedAt: member.application_created_at
    }));

    successResponse(res, {
      members: formattedMembers,
      total: formattedMembers.length
    }, 'SL Team created review board members retrieved successfully');

  } catch (error) {
    console.error('Get SL team members error:', error);
    errorResponse(res, 'Failed to retrieve SL team members', 500);
  } finally {
    try { if (connection && typeof connection.release === 'function') connection.release(); } catch (_) { }
  }
});

// @route   PUT /api/review-board/:id/edit
// @desc    Edit review board member by SL Team/Admin
// @access  Private (SL Team/Admin only)
router.put('/:id/edit', [
  auth,
  requireAnyRole(['sl_team', 'admin']),
  reviewBoardPhotoUpload.single('photo')
], async (req, res) => {
  try {
    const { id } = req.params;
    const {
      firstName,
      lastName,
      email,
      password,
      phone,
      address,
      gender,
      photo,
      bio
    } = req.body;

    const connection = await getMySQLConnection();
    // Ensure we know if legacy column exists
    let hasIsReviewBoardMember = false;
    try {
      const [isRbmCol] = await connection.execute("SHOW COLUMNS FROM users LIKE 'is_review_board_member'");
      hasIsReviewBoardMember = isRbmCol.length > 0;
    } catch (_) {
      hasIsReviewBoardMember = false;
    }

    // Handle photo upload
    let photoUrl = null;
    if (req.file) {
      photoUrl = req.file.location; // Photo is already uploaded to S3 by multer-s3
    }

    // Check if review board member exists
    const whereReviewBoard = hasIsReviewBoardMember
      ? "u.is_review_board_member = 1"
      : "u.user_type = 'review_board'";
    const [member] = await connection.execute(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.is_active, rba.id as application_id
       FROM users u 
       LEFT JOIN review_board_applications rba ON u.id = rba.user_id 
       WHERE u.id = ? AND ${whereReviewBoard}`,
      [id]
    );

    if (member.length === 0) {
      return errorResponse(res, 'Review board member not found', 404);
    }

    // Update user information - all fields are optional
    const userUpdateFields = [];
    const userUpdateValues = [];

    if (firstName !== undefined) {
      userUpdateFields.push('first_name = ?');
      userUpdateValues.push(firstName || null);
    }

    if (lastName !== undefined) {
      userUpdateFields.push('last_name = ?');
      userUpdateValues.push(lastName || null);
    }

    if (email !== undefined) {
      // Check if email is already taken by another user
      const [existingEmail] = await connection.execute(
        'SELECT id FROM users WHERE email = ? AND id != ?',
        [email, id]
      );

      if (existingEmail.length > 0) {
        return errorResponse(res, 'Email already exists for another user', 400);
      }

      userUpdateFields.push('email = ?');
      userUpdateValues.push(email);
    }

    if (phone !== undefined) {
      userUpdateFields.push('phone = ?');
      userUpdateValues.push(phone || null);
    }

    if (photoUrl) {
      userUpdateFields.push('avatar = ?');
      userUpdateValues.push(photoUrl);
    } else if (photo !== undefined) {
      userUpdateFields.push('avatar = ?');
      userUpdateValues.push(photo || null);
    }

    if (password !== undefined) {
      if (password) {
        const bcrypt = require('bcryptjs');
        const hashedPassword = await bcrypt.hash(password, 12);
        userUpdateFields.push('password = ?');
        userUpdateValues.push(hashedPassword);
      }
      // If password is empty string, don't update it
    }

    // Always enforce user_type as review_board on edit; also set legacy flag if present
    userUpdateFields.push('user_type = ?');
    userUpdateValues.push('review_board');
    if (hasIsReviewBoardMember) {
      userUpdateFields.push('is_review_board_member = ?');
      userUpdateValues.push(1);
    }

    if (userUpdateFields.length > 0) {
      userUpdateFields.push('updated_at = NOW()');
      userUpdateValues.push(id);

      await connection.execute(
        `UPDATE users SET ${userUpdateFields.join(', ')} WHERE id = ?`,
        userUpdateValues
      );
    }

    // Update review board application if exists - all fields are optional
    const applicationUpdateFields = [];
    const applicationUpdateValues = [];

    if (firstName !== undefined) {
      applicationUpdateFields.push('first_name = ?');
      applicationUpdateValues.push(firstName || null);
    }

    if (lastName !== undefined) {
      applicationUpdateFields.push('last_name = ?');
      applicationUpdateValues.push(lastName || null);
    }

    if (email !== undefined) {
      applicationUpdateFields.push('email = ?');
      applicationUpdateValues.push(email);
    }

    if (phone !== undefined) {
      applicationUpdateFields.push('phone = ?');
      applicationUpdateValues.push(phone || null);
    }

    if (address !== undefined) {
      applicationUpdateFields.push('address = ?');
      applicationUpdateValues.push(address || null);
    }

    if (gender !== undefined) {
      applicationUpdateFields.push('gender = ?');
      applicationUpdateValues.push(gender || null);
    }

    if (photoUrl) {
      applicationUpdateFields.push('photo = ?');
      applicationUpdateValues.push(photoUrl);
    } else if (photo !== undefined) {
      applicationUpdateFields.push('photo = ?');
      applicationUpdateValues.push(photo || null);
    }

    if (bio !== undefined) {
      applicationUpdateFields.push('bio = ?');
      applicationUpdateValues.push(bio || null);
    }

    if (applicationUpdateFields.length > 0) {
      applicationUpdateFields.push('updated_at = NOW()');
      applicationUpdateValues.push(id);

      await connection.execute(
        `UPDATE review_board_applications SET ${applicationUpdateFields.join(', ')} WHERE user_id = ?`,
        applicationUpdateValues
      );
    }

    // Get updated member information
    const [updatedMember] = await connection.execute(
      `SELECT 
        u.id, u.first_name, u.last_name, u.email, u.phone, u.avatar, u.is_active,
        rba.id as application_id, rba.first_name as app_first_name, rba.last_name as app_last_name,
        rba.email as app_email, rba.phone as app_phone, rba.address, rba.gender, rba.photo, rba.bio,
        rba.status, rba.application_source, rba.created_at, rba.updated_at
       FROM users u 
       LEFT JOIN review_board_applications rba ON u.id = rba.user_id 
       WHERE u.id = ? AND ${whereReviewBoard}`,
      [id]
    );

    successResponse(res, {
      message: 'Review board member updated successfully',
      member: updatedMember[0]
    }, 'Review board member updated successfully');

  } catch (error) {
    console.error('Edit review board member error:', error);
    errorResponse(res, 'Failed to update review board member', 500);
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

// @route   GET /api/review-board/:id/details
// @desc    Get review board member details for editing by SL Team/Admin
// @access  Private (SL Team/Admin only)
router.get('/:id/details', [
  auth,
  requireAnyRole(['sl_team', 'admin'])
], async (req, res) => {
  try {
    const { id } = req.params;
    const connection = await getMySQLConnection();

    // Get member details for editing
    const [member] = await connection.execute(
      `SELECT 
        u.id, u.first_name, u.last_name, u.email, u.phone, u.avatar, u.is_active,
        rba.id as application_id, rba.first_name as app_first_name, rba.last_name as app_last_name,
        rba.email as app_email, rba.phone as app_phone, rba.address, rba.gender, rba.photo, rba.bio,
        rba.status, rba.application_source, rba.reviewed_by, rba.reviewed_at,
        rba.created_at, rba.updated_at
       FROM users u 
       LEFT JOIN review_board_applications rba ON u.id = rba.user_id 
       WHERE u.id = ? AND u.is_review_board_member = 1`,
      [id]
    );

    if (member.length === 0) {
      return errorResponse(res, 'Review board member not found', 404);
    }

    successResponse(res, {
      member: member[0]
    }, 'Review board member details retrieved successfully');

  } catch (error) {
    console.error('Get review board member details error:', error);
    errorResponse(res, 'Failed to get review board member details', 500);
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

// =============== SL TEAM IMPORT MEMBERS (EXCEL) =================
// @route   POST /api/review-board/import-members
// @desc    Import review board members from Excel (SL Team/Admin)
// @access  Private
router.post('/import-members', [
  auth,
  requireAnyRole(['sl_team', 'admin']),
  excelUpload.single('file')
], async (req, res) => {
  let connection;

  try {
    if (!req.file) {
      return errorResponse(res, 'Excel file is required', 400);
    }

    const XLSX = require('xlsx');

    // Parse Excel
    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    if (!sheet) {
      return errorResponse(res, "No sheet found in Excel file", 400);
    }

    const rows = XLSX.utils.sheet_to_json(sheet, {
      defval: null,
      raw: false,
      blankrows: false
    });

    if (!rows.length) {
      return errorResponse(res, "Excel file contains no rows", 400);
    }

    console.log("Rows to import:", rows.length);

    connection = await getMySQLConnection();

    const results = { success: 0, failed: 0, skipped: 0, errors: [] };

    const bcrypt = require("bcryptjs");

    // Schema checks (done once)
    const [isRbmCol] = await connection.execute(
      "SHOW COLUMNS FROM users LIKE 'is_review_board_member'"
    );
    const hasIsReviewBoardMember = isRbmCol.length > 0;

    const [colsTa] = await connection.execute(
      "SHOW COLUMNS FROM review_board_applications LIKE 'terms_accepted'"
    );
    const [colsTAt] = await connection.execute(
      "SHOW COLUMNS FROM review_board_applications LIKE 'terms_accepted_at'"
    );

    // ================================
    // MAIN LOOP
    // ================================
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {};
      const rowNum = i + 2; // Since header = row 1

      // Extract fields (normalize headers)
      const firstName = row.firstName ?? row.first_name ?? null;
      const lastName = row.lastName ?? row.last_name ?? null;
      const email = row.email ?? null;
      const password = row.password ?? null;
      const phone = row.phone ?? null;
      const address1 = row.address1 ?? row.address ?? null;
      const address2 = row.address2 ?? null;
      const city = row.city ?? null;
      const state = row.state ?? null;
      const zipCode = row.zipCode ?? row.Zipcode ?? row.zip ?? null;
      const country = row.country ?? null;
      const gender = row.gender ?? null;
      const bio = row.bio ?? null;

      try {
        // Skip empty row
        const isEmptyRow =
          !email &&
          !firstName &&
          !lastName &&
          !phone &&
          !address1 &&
          !address2 &&
          !city &&
          !state &&
          !zipCode &&
          !country &&
          !gender &&
          !bio;

        if (isEmptyRow) {
          console.log(`Row ${rowNum}: Empty row, skipped`);
          results.skipped++;
          continue;
        }

        // Email is required
        if (!email) {
          results.failed++;
          results.errors.push(`Row ${rowNum}: Email is required`);
          continue;
        }

        // -------------------------------------------------------
        // 1️⃣ CHECK IF USER ALREADY EXISTS IN BOTH TABLES
        // -------------------------------------------------------

        const [userRows] = await connection.execute(
          "SELECT id FROM users WHERE email = ?",
          [email]
        );

        let existingUserId = userRows.length > 0 ? userRows[0].id : null;

        // If user exists → check review_board_applications
        // if (existingUserId) {
        //   const [existingApp] = await connection.execute(
        //     "SELECT id FROM review_board_applications WHERE user_id = ? LIMIT 1",
        //     [existingUserId]
        //   );

        //   if (existingApp.length > 0) {
        //     console.log(`Row ${rowNum}: Already exists in review board → SKIPPED`);
        //     results.skipped++;
        //     results.errors.push(`Row ${rowNum}: User already exists in review_board_applications. Skipped.`);
        //     continue;
        //   }
        // }

        // If user exists → check review_board_applications
if (existingUserId) {
  const [existingApp] = await connection.execute(
    "SELECT id FROM review_board_applications WHERE user_id = ? LIMIT 1",
    [existingUserId]
  );

  // Duplicate = already has an application
  if (existingApp.length > 0) {
    if (action === 'validate') {
      results.duplicates.push({ row: rowNum, email, reason: 'already_in_review_board' });
      // Do not change DB in validate mode
      continue;
    }

    if (action === 'merge') {
      // 2a) MERGE: Update existing user basic info and ensure review board flags
      // Determine if users table has is_review_board_member (already detected above)
      const userUpdateCols = [
        'first_name = ?',
        'last_name = ?',
        'phone = ?',
        'is_active = 1',
        'updated_at = NOW()',
        'user_type = ?'
      ];

      const userUpdateVals = [
        firstName || 'Review Board',
        lastName || 'Member',
        phone || null,
        'review_board'
      ];

      if (hasIsReviewBoardMember) {
        userUpdateCols.push('is_review_board_member = 1');
      }

      await connection.execute(
        `UPDATE users SET ${userUpdateCols.join(', ')} WHERE id = ?`,
        [...userUpdateVals, existingUserId]
      );

      // 2b) MERGE: Update existing application row with new values
      const appId = existingApp[0].id;
      const reviewedBy = req.user?.userId || req.user?.id || null;

      await connection.execute(
        `UPDATE review_board_applications SET
          first_name = ?, last_name = ?, email = ?, phone = ?,
          address = ?, gender = ?, bio = ?,
          city = ?, state = ?, Zipcode = ?, country = ?, address2 = ?,
          status = 'approved',
          reviewed_by = ?, reviewed_at = NOW(),
          review_notes = CONCAT(IFNULL(review_notes, ''), ?),
          updated_at = NOW()
        WHERE id = ?`,
        [
          firstName || 'Review Board',
          lastName || 'Member',
          email,
          phone || null,
          address1 || null,
          gender || null,
          bio || null,
          city || null,
          state || null,
          zipCode || null,
          country || null,
          address2 || null,
          reviewedBy,
          `\nMerged via import on ${new Date().toISOString()}`,
          appId
        ]
      );

      results.merged++;
      continue;
    }

    // Default import mode: skip duplicates
    results.skipped++;
    results.errors.push(`Row ${rowNum}: User already exists in review_board_applications. Skipped.`);
    continue;
  }
}


        // -------------------------------------------------------
        // 2️⃣ USER CREATE / UPDATE LOGIC
        // -------------------------------------------------------

        let userId = existingUserId;

        // Hash password
        let hashedPassword;
        if (password) {
          hashedPassword = await bcrypt.hash(String(password), 12);
        } else {
          const randomPassword = Math.random().toString(36).slice(-8);
          hashedPassword = await bcrypt.hash(randomPassword, 12);
        }

        if (!userId) {
          // CREATE NEW USER
          const userColumns = [
            "first_name",
            "last_name",
            "email",
            "password",
            "phone",
            "role",
            "user_type",
            "is_active",
            "is_composer",
          ];

          const userValues = [
            firstName || "Review Board",
            lastName || "Member",
            email,
            hashedPassword,
            phone || null,
            "sl_team",
            "sub_user",
            1,
            1,
          ];

          if (hasIsReviewBoardMember) {
            userColumns.push("is_review_board_member");
            userValues.push(1);
          }

          const placeholders = userColumns.map(() => "?").join(", ");
          const [userResult] = await connection.execute(
            `INSERT INTO users (${userColumns.join(", ")}) VALUES (${placeholders})`,
            userValues
          );

          userId = userResult.insertId;
        }

        // -------------------------------------------------------
        // 3️⃣ CREATE REVIEW BOARD APPLICATION
        // -------------------------------------------------------

        const reviewedBy = req.user?.userId || req.user?.id || null;

        const appColumns = [
          "user_id",
          "status",
          "application_source",
          "first_name",
          "last_name",
          "email",
          "phone",
          "address",
          "gender",
          "bio",
        ];

        const appValues = [
          userId,
          "approved",
          "sl_team_created",
          firstName || "Review Board",
          lastName || "Member",
          email,
          phone || null,
          address1 || null,
          gender || null,
          bio || null,
        ];

        // Optional Terms Columns
        if (colsTa.length > 0) {
          appColumns.push("terms_accepted");
          appValues.push(1);
        }
        if (colsTAt.length > 0) {
          appColumns.push("terms_accepted_at");
          appValues.push(new Date());
        }

        // Review details
        appColumns.push("reviewed_by");
        appValues.push(reviewedBy);

        appColumns.push("reviewed_at");
        appValues.push(new Date());

        appColumns.push("review_notes");
        appValues.push(`Imported by SL Team`);

        // Address breakdown
        appColumns.push("city");
        appValues.push(city || null);

        appColumns.push("state");
        appValues.push(state || null);

        appColumns.push("Zipcode");
        appValues.push(zipCode || null);

        appColumns.push("country");
        appValues.push(country || null);

        appColumns.push("address2");
        appValues.push(address2 || null);

        const appPlaceholders = appColumns.map(() => "?").join(", ");
        await connection.execute(
          `INSERT INTO review_board_applications (${appColumns.join(", ")}) VALUES (${appPlaceholders})`,
          appValues
        );

        results.success++;
      } catch (err) {
        results.failed++;
        const msg = err.message || "Unknown error";
        console.error(`Row ${rowNum} failed:`, msg);
        results.errors.push(`Row ${rowNum}: ${msg}`);
      }
    }

    // Final response
    return successResponse(
      res,
      {
        results,
      },
      `Import completed. ${results.success} added, ${results.skipped} skipped, ${results.failed} failed.`
    );

  } catch (err) {
    console.error("❌ Import error:", err);
    return errorResponse(res, "Failed to import members", 500);
  } finally {
    try {
      if (connection && typeof connection.release === "function") {
        connection.release();
      }
    } catch { }
  }
});


// @route   GET /api/review-board/import-template
// @desc    Download Excel template for review board members import
// @access  Private (SL Team/Admin)
router.get('/import-template', [
  auth,
  requireAnyRole(['sl_team', 'admin'])
], async (req, res) => {
  try {
    // exact headers we want
    const headers = [
      'firstName',
      'lastName',
      'email',
      'password',
      'phone',
      'address1',
      'address2',
      'city',
      'state',
      'zipCode',
      'country',
      'gender',
      'photo',
      'bio'
    ];

    // example values
    const example = {
      firstName: 'John',
      lastName: 'Doe',
      email: 'john.doe@example.com',
      password: 'optionalPassword123',
      phone: '+1234567890',
      address1: '123 Main St',
      address2: 'Apt 4B',
      city: 'Alameda County',
      state: 'CA',
      zipCode: '94501',
      country: 'United States',
      gender: 'male',
      photo: 'https://s3.amazonaws.com/your-bucket/photo.jpg',
      bio: 'Liturgical music specialist'
    };

    const XLSX = require('xlsx'); // ensure XLSX is available

    const book = XLSX.utils.book_new();

    // create empty sheet and then explicitly set header cells and example row
    const sheet = {};

    // Write header row (A1..N1)
    for (let i = 0; i < headers.length; i++) {
      const colLetter = XLSX.utils.encode_col(i); // 0 -> 'A', 1 -> 'B' ...
      const cellAddress = `${colLetter}1`;
      sheet[cellAddress] = { v: headers[i], t: 's' };
    }

    // Write example row (A2..N2) in the same column order
    for (let i = 0; i < headers.length; i++) {
      const colLetter = XLSX.utils.encode_col(i);
      const cellAddress = `${colLetter}2`;
      const key = headers[i];
      sheet[cellAddress] = { v: example[key] ?? '', t: 's' };
    }

    // define sheet range (required)
    sheet['!ref'] = `A1:${XLSX.utils.encode_col(headers.length - 1)}2`;

    // Optional: set column widths for readability
    sheet['!cols'] = [
      { wch: 18 }, // firstName
      { wch: 18 }, // lastName
      { wch: 30 }, // email
      { wch: 20 }, // password
      { wch: 18 }, // phone
      { wch: 30 }, // address1
      { wch: 30 }, // address2
      { wch: 18 }, // city
      { wch: 10 }, // state
      { wch: 12 }, // zipCode
      { wch: 18 }, // country
      { wch: 10 }, // gender
      { wch: 50 }, // photo
      { wch: 50 }  // bio
    ];

    XLSX.utils.book_append_sheet(book, sheet, 'Review Board Members');

    // README sheet
    const readme = [
      { Field: 'email', Required: 'YES', Notes: 'Unique. This field is mandatory.' },
      { Field: 'firstName', Required: 'NO', Notes: "If missing, 'Review Board' will be used." },
      { Field: 'lastName', Required: 'NO', Notes: "If missing, 'Member' will be used." },
      { Field: 'password', Required: 'NO', Notes: 'Optional. If blank, a random password will be generated.' },
      { Field: 'phone', Required: 'NO', Notes: 'Include country code if available.' },
      { Field: 'address1', Required: 'NO', Notes: 'Main address line.' },
      { Field: 'address2', Required: 'NO', Notes: 'Optional secondary address line.' },
      { Field: 'city', Required: 'NO', Notes: '' },
      { Field: 'state', Required: 'NO', Notes: 'State or region.' },
      { Field: 'zipCode', Required: 'NO', Notes: 'Postal / ZIP code.' },
      { Field: 'country', Required: 'NO', Notes: 'Country name.' },
      { Field: 'gender', Required: 'NO', Notes: "Recommended values: 'male', 'female', 'other' or leave blank." },
      { Field: 'photo', Required: 'NO', Notes: 'Public URL (S3 recommended). If provided, used as avatar/photo.' },
      { Field: 'bio', Required: 'NO', Notes: 'Short biography or description.' }
    ];
    const readmeSheet = XLSX.utils.json_to_sheet(readme, { header: ['Field', 'Required', 'Notes'] });
    XLSX.utils.book_append_sheet(book, readmeSheet, 'README');

    // Debug: log first few header cells to ensure server-side correctness
    // (comment out in production if noisy)
    try {
      const debugHeaders = headers.map((_, i) => {
        const addr = `${XLSX.utils.encode_col(i)}1`;
        return sheet[addr] ? sheet[addr].v : null;
      });
      console.log('Export template headers:', debugHeaders);
    } catch (e) {
      console.warn('Header debug failed', e);
    }

    const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=review_board_members_template.xlsx');
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);

  } catch (error) {
    console.error('Generate review board template error:', error);
    return errorResponse(res, 'Failed to generate template', 500);
  }
});

// @route   POST /api/review-board/invite
// @desc    Download Excel template for review board members import
// @access  Private (SL Team/Admin)
router.post('/invite', auth, async (req, res) => {
  try {
    const { id, inviteLink } = req.body;
    const senderUser = req.user;
    const mysqlConnection = getMySQLConnection();

    // Fetch Composer
    const [composerResult] = await mysqlConnection.execute(
      `SELECT * FROM users WHERE id = ?`,
      [id]
    );

    const composer = composerResult[0];

    if (!composer) {
      return errorResponse(res, 'User not found', 404);
    }

    if (composer.is_composer !== 1) {
      return errorResponse(res, 'Selected user is not a verified composer', 400);
    }

    // Generate Invite Link (Login + Review Board Page)

    // Email Template (HTML)
    const emailTemplate = `
      <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
        
        <h2 style="color: #0476D0;">You're Invited to Join the Review Board 🎉</h2>

        <p>Hi <strong>${composer.first_name || ''} ${composer.lastName || ''}</strong>,</p>

        <p>
          You have been selected by the Simply Liturgical team to join the 
          <strong>Review Board</strong> as a composer. 
        </p>

        <p>To get started, please click the link below:</p>

        <a href="${inviteLink}" 
          style="display:inline-block;margin-top:15px;padding:10px 20px;background:#0476D0;color:#fff;text-decoration:none;border-radius:5px;">
          Accept Invite & Login
        </a>

        <br/><br/>

        <p>
          Once logged in, please follow the instructions to begin your 
          **mock review process**.
        </p>

        <p>
          If you have any issues accessing your account, feel free to reply to this email.
        </p>

        <br/>

        <p>Best Regards, <br><strong>${senderUser.firstName || 'Admin'} (Simply Liturgical Team)</strong></p>
      </div>
    `;

    // Send Email
    await sendEmail({
      to: composer.email,
      subject: 'You’re Invited to Join the Review Board - Simply Liturgical',
      html: emailTemplate
    });
    createAndDeliverNotification({
      title: "You're Invited to Join the Review Board",
      body: "Congratulations! You’ve been selected as an SL Composer to join the Review Board. Please check your email for invite details and next steps.",
      metadata: { link: "/review-board" },
      channel: "inbox",
      target: { type: "custom", user_ids: [composer.id] }
    });


    return successResponse(res, { message: 'Invite sent successfully', invitedTo: composer.email }, 200);

  } catch (error) {
    console.error(error);
    return errorResponse(res, 'Something went wrong while sending invite', 500);
  }
});



module.exports = router;
