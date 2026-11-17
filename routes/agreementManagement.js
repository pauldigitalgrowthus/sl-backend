const express = require('express');
const { getMySQLConnection } = require('../config/mysql');
const { auth } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');
const { agreementUpload } = require('../config/s3');
const { createAndDeliverNotification } = require('../utils/notificationUtils')
const { sendEmail } = require("../utils/SendMailer")

const router = express.Router();

// @route   POST /api/agreements/upload-file
// @desc    Upload a new agreement file on S3
// @access  Private (User)
router.post('/upload-file', [
    auth,
    agreementUpload.single('agreementFile')
], async (req, res) => {
    try {
        if (!req.file) {
            return errorResponse(res, 'No agreement file uploaded', 400);
        }

        const fileUrl = req.file.location;
        const fileSize = req.file.size;

        successResponse(res, {
            fileUrl,
            fileSize,
            fileName: req.file.originalname,
            fileType: req.file.mimetype
        }, 'Agreement file uploaded successfully');

    } catch (error) {
        console.error('Agreement upload error:', error);
        errorResponse(res, 'Failed to upload agreement file', 500);
    }
});

// @route   POST /api/agreements/saved-agreements
// @desc    Create saved agreement
// @access  Private (Admin)
router.post("/saved-agreements", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();

        const {
            agreement_title,
            agreement_type,
            file_name,
            file_path,
            signature_position
        } = req.body;

        if (!agreement_title || !agreement_type || !file_name) {
            return errorResponse(res, "Required fields missing", 400);
        }

        if (!["Signature", "T&C"].includes(agreement_type)) {
            return errorResponse(res, "Invalid agreement_type", 400);
        }

        if (signature_position && typeof signature_position !== "object") {
            return errorResponse(res, "signature_position must be an object", 400);
        }

        const [result] = await mysqlConnection.execute(
            `
            INSERT INTO saved_agreements
            (
                agreement_title,
                file_name,
                file_path,
                agreement_type,
                signature_position
            )
            VALUES (?, ?, ?, ?, ?)
            `,
            [
                agreement_title,
                file_name,
                file_path || null,
                agreement_type,
                signature_position ? JSON.stringify(signature_position) : null
            ]
        );

        return successResponse(
            res,
            { id: result.insertId },
            "Saved agreement created",
            201
        );

    } catch (error) {
        console.error("Create Saved Agreement Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

// @route   GET /api/agreements/saved-agreements
// @desc    Get all saved agreements
// @access  Private
router.get("/saved-agreements", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();

        const [rows] = await mysqlConnection.execute(
            `
            SELECT
                id,
                agreement_title,
                file_name,
                file_path,
                agreement_type,
                signature_position,
                status,
                uploaded_on,
                updated_at
            FROM saved_agreements
            WHERE status = 1
            ORDER BY uploaded_on DESC
            `
        );

        const data = rows.map(row => ({
            ...row,
            signature_position: row.signature_position
                ? JSON.parse(row.signature_position)
                : null
        }));

        return successResponse(res, data, "Saved agreements fetched");

    } catch (error) {
        console.error("Fetch Saved Agreements Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

// @route   GET /api/agreements/saved-agreements/:id
// @desc    Get saved agreement by ID
// @access  Private
router.get("/saved-agreements/:id", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const { id } = req.params;

        const [rows] = await mysqlConnection.execute(
            `
            SELECT
                id,
                agreement_title,
                file_name,
                file_path,
                agreement_type,
                signature_position,
                status,
                uploaded_on,
                updated_at
            FROM saved_agreements
            WHERE id = ?
            `,
            [id]
        );

        if (!rows.length) {
            return errorResponse(res, "Saved agreement not found", 404);
        }

        const row = rows[0];
        row.signature_position = row.signature_position
            ? JSON.parse(row.signature_position)
            : null;

        return successResponse(res, row, "Saved agreement fetched");

    } catch (error) {
        console.error("Fetch Saved Agreement Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

// @route   PUT /api/agreements/saved-agreements/:id
// @desc    Update saved agreement
// @access  Private (Admin)
router.put("/saved-agreements/:id", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const { id } = req.params;

        const {
            agreement_title,
            agreement_type,
            file_name,
            file_path,
            signature_position,
            status
        } = req.body;

        if (agreement_type && !["Signature", "T&C"].includes(agreement_type)) {
            return errorResponse(res, "Invalid agreement_type", 400);
        }

        await mysqlConnection.execute(
            `
            UPDATE saved_agreements
            SET
                agreement_title     = COALESCE(?, agreement_title),
                agreement_type      = COALESCE(?, agreement_type),
                file_name           = COALESCE(?, file_name),
                file_path           = COALESCE(?, file_path),
                signature_position  = COALESCE(?, signature_position),
                status              = COALESCE(?, status)
            WHERE id = ?
            `,
            [
                agreement_title,
                agreement_type,
                file_name,
                file_path,
                signature_position
                    ? JSON.stringify(signature_position)
                    : null,
                status,
                id
            ]
        );

        return successResponse(res, null, "Saved agreement updated");

    } catch (error) {
        console.error("Update Saved Agreement Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

// @route   DELETE /api/agreements/saved-agreements/:id
// @desc    Deactivate saved agreement
// @access  Private (Admin)
router.delete("/saved-agreements/:id", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const { id } = req.params;

        await mysqlConnection.execute(
            `UPDATE saved_agreements SET status = 0 WHERE id = ?`,
            [id]
        );

        return successResponse(res, null, "Saved agreement deactivated");

    } catch (error) {
        console.error("Delete Saved Agreement Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

// @route   GET /api/agreements
// @desc    Get all agreements with pagination
// @access  Private (SL Team/Admin only)
router.get("/", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;

        const [rows] = await mysqlConnection.execute(
            `SELECT * FROM agreements ORDER BY uploaded_on DESC LIMIT ? OFFSET ?`,
            [limit, offset]
        );

        // Parse badges safely for every row
        const parsedRows = rows.map(row => {
            try {
                row.badges = row.badges ? JSON.parse(row.badges) : [];
            } catch (err) {
                row.badges = [];
            }
            return row;
        });
        successResponse(res, parsedRows, "Agreements fetched successfully", 200);
    } catch (error) {
        console.error(error);
        errorResponse(res, `Failed to Fetch Agreements: ${error.message}`, 500);
    }
});

// @route   POST /api/agreements
// @desc    Create a new agreement (Saved / Custom)
// @access  Private (SL Team/Admin only)
router.post("/", auth, async (req, res) => {
  let mysqlConnection;

  try {
    mysqlConnection = getMySQLConnection();

    let {
      agreement_title,
      agreement_type,
      badges,
      file_name,
      file_path,
      signature_position,
      description,
      userId,               // number | array
      savedAgreementID
    } = req.body;

    const pagelink = process.env.FRONTEND_URL;

    // -------------------------------------------------
    // ✅ LOAD FROM saved_agreements (IF PROVIDED)
    // -------------------------------------------------
    if (savedAgreementID) {
      const [saved] = await mysqlConnection.execute(
        `
        SELECT agreement_title, file_name, file_path, agreement_type, signature_position
        FROM saved_agreements
        WHERE id = ? AND status = 1
        `,
        [savedAgreementID]
      );

      if (!saved.length) {
        return errorResponse(res, "Saved agreement not found", 404);
      }

      agreement_title = saved[0].agreement_title;
      file_name = saved[0].file_name;
      file_path = saved[0].file_path;
      agreement_type = saved[0].agreement_type;

      if (!signature_position && saved[0].signature_position) {
        signature_position = JSON.parse(saved[0].signature_position);
      }
    }

    // -------------------------------------------------
    // 🔴 VALIDATION
    // -------------------------------------------------
    if (!agreement_title || !agreement_type || !file_name || !file_path) {
      return errorResponse(
        res,
        "agreement_title, agreement_type, file_name and file_path are required",
        400
      );
    }

    if (!["Signature", "T&C"].includes(agreement_type)) {
      return errorResponse(res, "Invalid agreement_type", 400);
    }

    if (signature_position && typeof signature_position !== "object") {
      return errorResponse(res, "signature_position must be an object", 400);
    }

    // -------------------------------------------------
    // 👥 NORMALIZE userId → ARRAY
    // -------------------------------------------------
    let userIds = [];
    if (Array.isArray(userId)) {
      userIds = userId.map(id => Number(id));
    } else if (userId) {
      userIds = [Number(userId)];
    }

    // -------------------------------------------------
    // ✅ INSERT AGREEMENT
    // -------------------------------------------------
    const [result] = await mysqlConnection.execute(
      `
      INSERT INTO agreements
      (
        agreement_title,
        file_name,
        file_path,
        agreement_type,
        badges,
        user_ids,
        signature_position,
        description,
        savedAgreementID
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        agreement_title,
        file_name,
        file_path,
        agreement_type,
        badges ? JSON.stringify(badges) : null,
        userIds.length ? JSON.stringify(userIds) : null,
        signature_position ? JSON.stringify(signature_position) : null,
        description ? JSON.stringify(description) : null,
        savedAgreementID || null
      ]
    );

    const agreementId = result.insertId;

    // -------------------------------------------------
    // 👥 FETCH USERS
    // -------------------------------------------------
    const [users] = await mysqlConnection.execute(
      `SELECT id, first_name, last_name, email, badges FROM users`
    );

    const parsedUsers = users.map(u => ({
      ...u,
      badges: u.badges ? JSON.parse(u.badges) : []
    }));

    // -------------------------------------------------
    // 🎯 USER SELECTION LOGIC
    // -------------------------------------------------
    let finalUsers = [];

    if (userIds.length) {
      finalUsers = parsedUsers.filter(u => userIds.includes(u.id));
    } else if (badges?.length) {
      finalUsers = parsedUsers.filter(u =>
        u.badges.some(b => badges.includes(b))
      );
    }

    finalUsers = [...new Map(finalUsers.map(u => [u.id, u])).values()];

    // -------------------------------------------------
    // 🔔 NOTIFICATION + EMAIL
    // -------------------------------------------------
    const notifyAndEmail = async (user) => {
      const metadata = {
        agreement_id: agreementId,
        agreement_title,
        agreement_type,
        signature_required: !!signature_position,
        link: `/dashboard/agreements/${agreementId}`
      };

      await createAndDeliverNotification({
        title: `New Agreement Available: ${agreement_title}`,
        body: `A new agreement has been assigned to you.`,
        metadata,
        channel: "inbox",
        target: { type: "custom", user_ids: [user.id] }
      });

      const emailHtml = `
        <p>Hello <strong>${user.first_name || "there"}</strong>,</p>
        <p>You have a new agreement assigned to you:</p>
        <ul>
          <li><strong>Title:</strong> ${agreement_title}</li>
          <li><strong>Type:</strong> ${agreement_type}</li>
        </ul>
        <a href="${pagelink}/agreements"
           style="background:#4c6fff;color:#fff;padding:10px 18px;
           text-decoration:none;border-radius:8px;">
            View Agreement
        </a>
        <p><strong>Simply Liturgical Team</strong></p>
      `;

      try {
        await sendEmail({
          to: user.email,
          subject: `New Agreement Assigned: ${agreement_title}`,
          html: emailHtml
        });
      } catch (err) {
        console.error(`❌ Email send failed to ${user.email}:`, err.message);
      }
    };

    // -------------------------------------------------
    // 🚀 SEND TO USERS
    // -------------------------------------------------
    for (const user of finalUsers) {
      await notifyAndEmail(user);
    }

    return successResponse(
      res,
      {
        id: agreementId,
        assigned_users: finalUsers.map(u => u.id),
        signature_required: !!signature_position
      },
      "Agreement created successfully",
      201
    );

  } catch (error) {
    console.error("Create Agreement Error:", error);
    return errorResponse(res, error.message, 500);
  }
});

// @route   PUT /api/agreements/:id
// @desc    Update an existing agreement
// @access  Private (SL Team/Admin only)
router.put("/:id", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const agreementId = req.params.id;

        if (!agreementId) {
            return errorResponse(res, "Agreement ID is required", 400);
        }

        const {
            agreement_title,
            agreement_type,

            badges,
            file_name,
            file_path,
            signature_position,
            description
        } = req.body;

        // Fetch existing agreement to validate existence
        const [existing] = await mysqlConnection.execute(
            `SELECT * FROM agreements WHERE id = ?`,
            [agreementId]
        );

        if (existing.length === 0) {
            return errorResponse(res, "Agreement not found", 404);
        }

        // Prepare update fields dynamically
        const updateFields = [];
        const updateValues = [];

        if (agreement_title !== undefined) {
            updateFields.push("agreement_title = ?");
            updateValues.push(agreement_title);
        }

        if (agreement_type !== undefined) {
            updateFields.push("agreement_type = ?");
            updateValues.push(agreement_type);
        }

        if (badges !== undefined) {
            updateFields.push("badges = ?");
            updateValues.push(JSON.stringify(badges));
        }

        if (file_name !== undefined) {
            updateFields.push("file_name = ?");
            updateValues.push(file_name);
        }

        if (file_path !== undefined) {
            updateFields.push("file_path = ?");
            updateValues.push(file_path);
        }

        if (signature_position !== undefined) {
            updateFields.push("signature_position = ?");
            updateValues.push(signature_position ? JSON.stringify(signature_position) : null);
        }

        if (description !== undefined) {
            updateFields.push("description = ?");
            updateValues.push(description ? JSON.stringify(description) : null);
        }

        if (updateFields.length === 0) {
            return errorResponse(res, "No fields provided to update", 400);
        }

        // Execute Update
        updateValues.push(agreementId);

        await mysqlConnection.execute(
            `UPDATE agreements SET ${updateFields.join(", ")} WHERE id = ?`,
            updateValues
        );

        return successResponse(res, { id: agreementId }, "Agreement updated successfully", 200);

    } catch (error) {
        console.error("Error updating agreement:", error);
        return errorResponse(res, `Failed to update agreement: ${error.message}`, 500);
    }
});

// @route   PUT /api/agreements/status/:id
// @desc    Update the status of an agreement
// @access  Private   (SL Team/Admin only)
router.put("/status/:id", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const { id } = req.params;
        const { status } = req.body; // 0 or 1

        await mysqlConnection.execute(
            `UPDATE agreements SET status = ? WHERE id = ?`,
            [status, id]
        );
        successResponse(res, null, "Status updated successfully", 200);

    } catch (error) {
        console.error(error);
        errorResponse(res, `Failed to update status: ${error.message}`, 500);
    }
});

// @route   Post /api/agreements/user/signature
// @desc    Create user new signature (S3 URL based)
// @access  Private (User)
router.post("/user/signature", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const { signature_file_name, signature_file_url } = req.body;

        if (!signature_file_name || !signature_file_url) {
            return res.status(400).json({ error: "File name and URL required" });
        }

        // If only one signature allowed, delete old one
        await mysqlConnection.execute(
            `DELETE FROM user_signatures WHERE user_id = ?`,
            [req.user.id]
        );

        const [result] = await mysqlConnection.execute(
            `INSERT INTO user_signatures 
      (user_id, signature_file_name, signature_file_url)
      VALUES (?, ?, ?)`,
            [req.user.id, signature_file_name, signature_file_url]
        );
        successResponse(res, { id: result.insertId }, "Signature uploaded successfully", 201);
    } catch (error) {
        console.error(error);
        errorResponse(res, `Failed to upload signature: ${error.message}`, 500);
    }
});

// @route   GET /api/agreements/user/signature
// @desc    Get user signature
// @access  Private (User)
router.get("/user/signature", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();

        const [rows] = await mysqlConnection.execute(
            `SELECT * FROM user_signatures 
       WHERE user_id = ? AND deleted_at IS NULL LIMIT 1`,
            [req.user.id]
        );

        if (!rows.length) {
            successResponse(res, { signature: null }, "No signature found", 200);
            return;
        }

        successResponse(res, rows[0], "Signature fetched successfully", 200);

    } catch (error) {
        console.error(error);
        errorResponse(res, `Failed to fetch signature: ${error.message}`, 500);
    }
});

// @route   PUT /api/agreements/user/signature
// @desc    Update user signature
// @access  Private (User)
router.put("/user/signature", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const { signature_file_name, signature_file_url } = req.body;

        if (!signature_file_name || !signature_file_url) {
            return res.status(400).json({ error: "File name and URL required" });
        }

        await mysqlConnection.execute(
            `UPDATE user_signatures 
       SET deleted_at = CURRENT_TIMESTAMP 
       WHERE user_id = ?`,
            [req.user.id]
        );

        await mysqlConnection.execute(
            `INSERT INTO user_signatures 
      (user_id, signature_file_name, signature_file_url)
      VALUES (?, ?, ?)`,
            [req.user.id, signature_file_name, signature_file_url]
        );
        successResponse(res, null, "Signature updated successfully", 200);

    } catch (error) {
        console.error(error);
        errorResponse(res, `Failed to update signature: ${error.message}`, 500);
    }
});

// @route   DELETE /api/agreements/user/signature
// @desc    Delete user signature
// @access  Private (User)
router.delete("/user/signature", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();

        await mysqlConnection.execute(
            `UPDATE user_signatures 
       SET deleted_at = CURRENT_TIMESTAMP 
       WHERE user_id = ? AND deleted_at IS NULL`,
            [req.user.id]
        );
        successResponse(res, null, "Signature deleted successfully", 200);

    } catch (error) {
        console.error(error);
        errorResponse(res, `Failed to delete signature: ${error.message}`, 500);
    }
});

// @route   GET /api/agreements/my-assignments
// @desc    Get user agreements based on badges
// @access  Private (User)

router.get("/my-assignments", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const userId = Number(req.user.id);

        // 1️⃣ Fetch user badges
        const [[user]] = await mysqlConnection.execute(
            `SELECT badges FROM users WHERE id = ? LIMIT 1`,
            [userId]
        );
        if (!user) return errorResponse(res, "User not found", 404);

        let userBadges = [];
        try {
            userBadges = user.badges ? JSON.parse(user.badges) : [];
        } catch (err) {
            userBadges = [];
        }
        if (!Array.isArray(userBadges)) userBadges = [];

        // 2️⃣ Fetch all active agreements
        const [agreements] = await mysqlConnection.execute(
            `SELECT * FROM agreements WHERE status = 1`
        );

        const results = [];
        const included = new Map();

        // Helper: safe parse JSON array fields
        const safeParseArray = (raw) => {
            if (!raw) return [];
            try {
                const parsed = JSON.parse(raw);
                return Array.isArray(parsed) ? parsed : [];
            } catch (e) {
                if (typeof raw === "string") {
                    return raw.split(",").map((s) => s.trim()).filter(Boolean);
                }
                return [];
            }
        };

        for (const ag of agreements) {
            if (included.has(ag.id)) continue;

            const agBadges = safeParseArray(ag.badges);
            const agUserIds = safeParseArray(ag.user_ids);

            const isDirect = agUserIds.includes(userId);
            const badgeMatch = agBadges.length && userBadges.length && agBadges.some(b => userBadges.includes(b));

            if (!isDirect && !badgeMatch) continue;

            // 3️⃣ Fetch signature details
            const [signatureRows] = await mysqlConnection.execute(
                `SELECT * FROM user_signatures_documents WHERE user_id = ? AND document_id = ? AND deleted_at IS NULL LIMIT 1`,
                [userId, ag.id]
            );

            let status = "pending";
            let signature_details = null;
            if (signatureRows && signatureRows.length > 0) {
                status = signatureRows[0].status || "pending";
                signature_details = signatureRows[0];
            }

            results.push({
                agreement_id: ag.id,
                agreement_title: ag.agreement_title,
                agreements_file_name: ag.file_name,
                agreements_file_path: ag.file_path,
                agreement_type: ag.agreement_type,
                badges: agBadges,
                assigned_via: isDirect ? "user" : "badge",
                status,
                signature_details,
                signature_position: ag.signature_position ? safeParseArray(ag.signature_position) : null,
                uploaded_on: ag.uploaded_on
            });

            included.set(ag.id, true);
        }

        // Sort by uploaded_on descending
        results.sort((a, b) => new Date(b.uploaded_on) - new Date(a.uploaded_on));

        return successResponse(res, results, "My assignments fetched successfully");
    } catch (error) {
        console.error("my-assignments error:", error);
        return errorResponse(res, error.message || "Internal server error", 500);
    }
});

// @route POST /api/agreements/user/signature/document
router.post("/user/signature/document", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const { document_id, signature_file_name, signature_file_url } = req.body;

        if (!document_id || !signature_file_name || !signature_file_url) {
            return errorResponse(res, "All fields required", 400);
        }

        const [[agreement]] = await mysqlConnection.execute(
            `SELECT badges FROM agreements WHERE id = ?`,
            [document_id]
        );
        if (!agreement) return errorResponse(res, "Agreement not found", 404);

        const badges = agreement.badges ? JSON.parse(agreement.badges) : [];

        const [result] = await mysqlConnection.execute(
            `
      INSERT INTO user_signatures_documents
      (user_id, document_id, signature_file_name, signature_file_url, badge, history)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
            [
                req.user.id,
                document_id,
                signature_file_name,
                signature_file_url,
                JSON.stringify(badges),
                JSON.stringify([
                    {
                        action: "uploaded",
                        timestamp: new Date().toISOString(),
                        user_id: req.user.id
                    }
                ])
            ]
        );

        return successResponse(
            res,
            { id: result.insertId },
            "Signature uploaded successfully",
            201
        );
    } catch (error) {
        return errorResponse(res, error.message, 500);
    }
});

// @route GET /api/agreements/user/signatures
// @desc    Get user signatures based on badges
// @access Private
router.get("/user/signatures", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();

        const [rows] = await mysqlConnection.execute(
            `SELECT * FROM user_signatures_documents 
       WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC`,
            [req.user.id]
        );

        successResponse(res, rows, "User signatures fetched");
    } catch (error) {
        errorResponse(res, error.message, 500);
    }
});

// @route POST /api/agreements/:id/admin-review
// @desc    review  user signatures by admin status update
// @access Private (Admin)
router.post("/:id/admin-review", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const { id } = req.params;
        const { status, admin_comment } = req.body;

        // Fetch existing record
        const [rows] = await mysqlConnection.execute(
            `SELECT * FROM user_signatures_documents 
       WHERE id = ? AND deleted_at IS NULL`,
            [id]
        );

        if (rows.length === 0) return errorResponse(res, "Record not found", 404);

        const record = rows[0];

        // Update history
        let history = [];
        try {
            history = record.history ? JSON.parse(record.history) : [];
        } catch (err) {
            history = [];
        }

        history.push({
            action: "admin_review",
            status,
            admin_comment,
            timestamp: new Date().toISOString(),
            admin_user_id: req.user.id,
        });

        // Update record
        const [result] = await mysqlConnection.execute(
            `UPDATE user_signatures_documents 
       SET status = ?, 
           admin_comment = ?, 
           history = ?
       WHERE id = ? AND deleted_at IS NULL`,
            [
                status,
                JSON.stringify({
                    previous: record.admin_comment ? JSON.parse(record.admin_comment) : null,
                    new: admin_comment
                }),
                JSON.stringify(history),
                id
            ]
        );

        successResponse(res, null, "Signature reviewed successfully");
    } catch (error) {
        errorResponse(res, error.message, 500);
    }
})

// @route GET /api/agreements/user/signature/:id
// @access Private
router.get("/user/signature/:id", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const { id } = req.params;

        const [rows] = await mysqlConnection.execute(
            `SELECT * FROM user_signatures_documents 
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
            [id, req.user.id]
        );

        if (rows.length === 0) return errorResponse(res, "Record not found", 404);

        successResponse(res, rows[0], "Signature fetched");
    } catch (error) {
        errorResponse(res, error.message, 500);
    }
});

// @route PUT /api/agreements/user/signature/:id
// @access Private
router.put("/user/signature/:id", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const { id } = req.params;
        const { status, signature_file_name, signature_file_url } = req.body;

        // Dynamic update builder
        const fields = [];
        const values = [];

        if (status) { fields.push("status = ?"); values.push(status); }
        if (signature_file_name) { fields.push("signature_file_name = ?"); values.push(signature_file_name); }
        if (signature_file_url) { fields.push("signature_file_url = ?"); values.push(signature_file_url); }

        if (fields.length === 0) {
            return errorResponse(res, "Nothing to update", 400);
        }

        values.push(id, req.user.id);

        const [result] = await mysqlConnection.execute(
            `UPDATE user_signatures_documents 
       SET ${fields.join(", ")} 
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
            values
        );

        if (result.affectedRows === 0) {
            return errorResponse(res, "Record not found", 404);
        }

        successResponse(res, null, "Signature updated successfully");
    } catch (error) {
        errorResponse(res, error.message, 500);
    }
});

// @route DELETE /api/agreements/user/signature/:id
// @access Private
router.delete("/user/signature/:id", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const { id } = req.params;

        const [result] = await mysqlConnection.execute(
            `UPDATE user_signatures_documents 
       SET deleted_at = NOW()
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
            [id, req.user.id]
        );

        if (result.affectedRows === 0) {
            return errorResponse(res, "Record not found", 404);
        }

        successResponse(res, null, "Signature deleted successfully");
    } catch (error) {
        errorResponse(res, error.message, 500);
    }
});

// @route GET /api/agreements/admin/signatures
// @access Private (Admin)
router.get("/admin/signatures", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();

        const [rows] = await mysqlConnection.execute(
            `SELECT usd.*, u.first_name, u.last_name, a.file_name AS document_title, a.agreement_type, a.agreement_title
             FROM user_signatures_documents usd
             JOIN users u ON usd.user_id = u.id
             JOIN agreements a ON usd.document_id = a.id
             WHERE usd.deleted_at IS NULL
             ORDER BY usd.created_at DESC`
        );

        // Badges ko expand karo - har badge ke liye alag entry
        const expandedRows = [];

        for (const row of rows) {
            let badges = [];

            try {
                // Badge ko parse karo (JSON string se array mein)
                badges = typeof row.badge === 'string'
                    ? JSON.parse(row.badge)
                    : (row.badge || []);

                // History ko bhi parse karo
                const history = typeof row.history === 'string'
                    ? JSON.parse(row.history)
                    : (row.history || []);

                // Agar badges array hai aur empty nahi hai
                if (Array.isArray(badges) && badges.length > 0) {
                    // Har badge ke liye separate entry banao
                    for (const badge of badges) {
                        expandedRows.push({
                            ...row,
                            badge: badge,           // Single badge (string)
                            all_badges: badges,     // All badges (array) - reference ke liye
                            history: history        // Parsed history
                        });
                    }
                } else {
                    // Agar koi badge nahi hai, toh bhi entry add karo
                    expandedRows.push({
                        ...row,
                        badge: null,
                        all_badges: [],
                        history: history
                    });
                }
            } catch (parseError) {
                console.error("Error parsing badges/history for row:", row.id, parseError);
                // Parse error ho toh bhi entry add karo
                expandedRows.push({
                    ...row,
                    badge: null,
                    all_badges: [],
                    history: []
                });
            }
        }

        successResponse(res, expandedRows, "All signatures fetched");
    } catch (error) {
        console.error("Error fetching signatures:", error);
        errorResponse(res, error.message, 500);
    }
});

// ============= Agreement CRUD Routes (must be after /user/* routes) =============

// @route   GET /api/agreements/:id
// @desc    Get a single agreement by ID
// @access  Private
router.get("/:id", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const { id } = req.params;

        const [rows] = await mysqlConnection.execute(
            `SELECT * FROM agreements WHERE id = ? LIMIT 1`,
            [id]
        );

        if (!rows.length) {
            return errorResponse(res, "Agreement not found", 404);
        }

        const agreement = rows[0];
        // Parse badges and signature_position
        try {
            agreement.badges = agreement.badges ? JSON.parse(agreement.badges) : [];
            agreement.signature_position = agreement.signature_position
                ? (typeof agreement.signature_position === 'string'
                    ? JSON.parse(agreement.signature_position)
                    : agreement.signature_position)
                : null;
        } catch (e) {
            agreement.badges = [];
            agreement.signature_position = null;
        }

        successResponse(res, agreement, "Agreement fetched successfully", 200);

    } catch (error) {
        console.error(error);
        errorResponse(res, `Failed to fetch agreement: ${error.message}`, 500);
    }
});

// @route   PUT /api/agreements/:id
// @desc    Update an agreement including file URL (S3 based)
// @access  Private (SL Team/Admin only)
router.put("/:id", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const { id } = req.params;

        const {
            agreement_title,
            agreement_type,
            badges,
            file_name,
            file_path,
            signature_position
        } = req.body;

        const updateFields = [];
        const updateValues = [];

        if (agreement_title !== undefined) {
            updateFields.push("agreement_title = ?");
            updateValues.push(agreement_title);
        }
        if (agreement_type !== undefined) {
            updateFields.push("agreement_type = ?");
            updateValues.push(agreement_type);
        }
        if (badges !== undefined) {
            updateFields.push("badges = ?");
            updateValues.push(JSON.stringify(badges));
        }
        if (file_name !== undefined) {
            updateFields.push("file_name = ?");
            updateValues.push(file_name);
        }
        if (file_path !== undefined) {
            updateFields.push("file_path = ?");
            updateValues.push(file_path);
        }
        if (signature_position !== undefined) {
            updateFields.push("signature_position = ?");
            updateValues.push(JSON.stringify(signature_position));
        }

        if (updateFields.length === 0) {
            return errorResponse(res, "No fields to update", 400);
        }

        updateValues.push(id);

        const [result] = await mysqlConnection.execute(
            `UPDATE agreements SET ${updateFields.join(", ")} WHERE id = ?`,
            updateValues
        );
        successResponse(res, result, "Agreement updated successfully", 200);

    } catch (error) {
        console.error(error);
        errorResponse(res, `Failed to update agreement: ${error.message}`, 500);
    }
});

// @route   DELETE /api/agreements/:id
// @desc    Delete an agreement
// @access  Private (SL Team/Admin only)
router.delete("/:id", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const { id } = req.params;

        await mysqlConnection.execute(`DELETE FROM agreements WHERE id = ?`, [id]);
        successResponse(res, null, "Agreement deleted successfully", 200);

    } catch (error) {
        console.error(error);
        errorResponse(res, `Failed to delete agreement: ${error.message}`, 500);
    }
});

// ============= Payment Methods Management =============

// @route POST /api/agreements/payment-methods
// @desc    POST user payment methods
// @access Private
router.post("/payment-methods", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const {
            card_number,
            expiry_month,
            expiry_year,
            card_holder_name,
            billing_address
        } = req.body;

        if (!card_number || !expiry_month || !expiry_year || !card_holder_name) {
            return res.status(400).json({ error: "All required fields missing" });
        }

        const last4 = card_number.slice(-4);

        const cardBrand =
            card_number.startsWith("4") ? "Visa" :
                card_number.startsWith("5") ? "Mastercard" :
                    "Unknown";

        const [result] = await mysql.execute(
            `INSERT INTO user_payment_methods 
      (user_id, card_holder_name, card_last4, card_brand, expiry_month, expiry_year, billing_address)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [req.user.id, card_holder_name, last4, cardBrand, expiry_month, expiry_year, billing_address]
        );

        successResponse(res, { id: result.insertId }, "Card added successfully", 201);
    } catch (err) {
        errorResponse(res, err.message, 500);
    }
});

// @route GET /api/agreements/payment-methods
// @desc    Get user payment methods
// @access Private
router.get("/payment-methods", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();

        const [rows] = await mysql.execute(
            `SELECT * FROM user_payment_methods
       WHERE user_id = ? AND deleted_at IS NULL`,
            [req.user.id]
        );

        successResponse(res, rows, "Payment methods fetched", 200);
    } catch (err) {
        errorResponse(res, err.message, 500);
    }
});

// @route PUT /api/agreements/payment-methods/:id
// @desc    Update user payment method
// @access  Private
router.put("/payment-methods/:id", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;

        const {
            card_holder_name,
            expiry_month,
            expiry_year,
            billing_address
        } = req.body;

        const [result] = await mysql.execute(
            `UPDATE user_payment_methods
       SET card_holder_name=?, expiry_month=?, expiry_year=?, billing_address=?
       WHERE id=? AND user_id=? AND deleted_at IS NULL`,
            [card_holder_name, expiry_month, expiry_year, billing_address, id, req.user.id]
        );

        successResponse(res, {}, "Payment method updated", 200);
    } catch (err) {
        errorResponse(res, err.message, 500);
    }
});

// @route DELETE /api/agreements/payment-methods/:id
// @desc    Delete user payment method
// @access  Private
router.delete("/payment-methods/:id", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;

        await mysql.execute(
            `UPDATE user_payment_methods
       SET deleted_at = NOW()
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
            [id, req.user.id]
        );

        successResponse(res, {}, "Payment method removed", 200);
    } catch (err) {
        errorResponse(res, err.message, 500);
    }
});

// @route PUT /api/agreements/payment-methods/:id/default
// @desc    Set default user payment method
// @access  Private
router.put("/payment-methods/:id/default", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;

        // Remove old default
        await mysql.execute(
            `UPDATE user_payment_methods
       SET is_default = 0
       WHERE user_id = ?`,
            [req.user.id]
        );

        // Set new default
        await mysql.execute(
            `UPDATE user_payment_methods
       SET is_default = 1
       WHERE id = ? AND user_id = ?`,
            [id, req.user.id]
        );

        successResponse(res, {}, "Default card updated", 200);
    } catch (err) {
        errorResponse(res, err.message, 500);
    }
});

module.exports = router;
