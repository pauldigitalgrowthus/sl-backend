const express = require("express");
const { getMySQLConnection } = require("../../config/mysql");
const { auth } = require("../../middleware/auth");
const { successResponse, errorResponse } = require("../../utils/response");
const router = express.Router();

// @route   Post /api/agreements/user/signature
// @desc    Create user new signature (S3 URL based)
// @access  Private (User)
router.post("/signature", auth, async (req, res) => {
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
    successResponse(
      res,
      { id: result.insertId },
      "Signature uploaded successfully",
      201
    );
  } catch (error) {
    console.error(error);
    errorResponse(res, `Failed to upload signature: ${error.message}`, 500);
  }
});

// @route GET /api/agreements/user/signatures
// @desc    Get user signatures based on badges
// @access Private
router.get("/signatures", auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    const [rows] = await mysqlConnection.execute(
      `SELECT usd.*, a.agreement_format
       FROM user_signatures_documents usd
       LEFT JOIN agreements a ON usd.document_id = a.id
       WHERE usd.user_id = ? AND usd.deleted_at IS NULL
       ORDER BY usd.created_at DESC`,
      [req.user.id]
    );

    successResponse(res, rows, "User signatures fetched");
  } catch (error) {
    errorResponse(res, error.message, 500);
  }
});

// @route   GET /api/agreements/user/signature
// @desc    Get user signature
// @access  Private (User)
router.get("/signature", auth, async (req, res) => {
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
router.put("/signature", auth, async (req, res) => {
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
router.delete("/signature", auth, async (req, res) => {
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

// @route GET /api/agreements/user/signature/:id
// @access Private
router.get("/signature/:id", auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const { id } = req.params;

    const [rows] = await mysqlConnection.execute(
      `SELECT usd.*, a.agreement_format
       FROM user_signatures_documents usd
       LEFT JOIN agreements a ON usd.document_id = a.id
       WHERE usd.id = ? AND usd.user_id = ? AND usd.deleted_at IS NULL`,
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
router.put("/signature/:id", auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const { id } = req.params;
    const { status, signature_file_name, signature_file_url } = req.body;

    // Dynamic update builder
    const fields = [];
    const values = [];

    if (status) {
      fields.push("status = ?");
      values.push(status);
    }
    if (signature_file_name) {
      fields.push("signature_file_name = ?");
      values.push(signature_file_name);
    }
    if (signature_file_url) {
      fields.push("signature_file_url = ?");
      values.push(signature_file_url);
    }

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
router.delete("/signature/:id", auth, async (req, res) => {
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

// @route POST /api/agreements/user/signature/document
// @desc  Submit a signature (or acceptance) for an agreement
// @access Private
router.post("/signature/document", auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const { document_id, signature_file_name, signature_file_url } = req.body;

    if (!document_id) {
      return errorResponse(res, "document_id is required", 400);
    }

    // Fetch agreement to get badges and format
    const [[agreement]] = await mysqlConnection.execute(
      `SELECT badges, agreement_format FROM agreements WHERE id = ?`,
      [document_id]
    );
    if (!agreement) return errorResponse(res, "Agreement not found", 404);

    const agreementFormat = agreement.agreement_format || 'pdf';
    const badges = agreement.badges ? JSON.parse(agreement.badges) : [];

    // PDF agreements require an actual signature image
    if (agreementFormat === 'pdf' && (!signature_file_name || !signature_file_url)) {
      return errorResponse(res, "PDF agreements require signature_file_name and signature_file_url", 400);
    }

    const [result] = await mysqlConnection.execute(
      `
      INSERT INTO user_signatures_documents
      (user_id, document_id, signature_file_name, signature_file_url, badge, history)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        req.user.id,
        document_id,
        signature_file_name || null,
        signature_file_url || null,
        JSON.stringify(badges),
        JSON.stringify([
          {
            action: agreementFormat === 'html' ? "accepted" : "uploaded",
            timestamp: new Date().toISOString(),
            user_id: req.user.id,
          },
        ]),
      ]
    );

    return successResponse(
      res,
      { id: result.insertId },
      agreementFormat === 'html'
        ? "Agreement accepted successfully"
        : "Signature uploaded successfully",
      201
    );
  } catch (error) {
    return errorResponse(res, error.message, 500);
  }
});

module.exports = router;