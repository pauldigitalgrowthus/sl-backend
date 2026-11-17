const express = require("express");
const { auth } = require("../../middleware/auth");
const { getMySQLConnection } = require("../../config/mysql");
const { successResponse, errorResponse } = require("../../utils/response");

const router = express.Router();

/* ============================================================
   1️⃣ GET DIOCESAN AGREEMENTS
   ------------------------------------------------------------
   @route   GET /api/diocese/agreements
   @desc    Fetch all active agreements applicable to diocesan users
   @access  Private (Diocesan Only)
============================================================ */
router.get("/agreements", auth, async (req, res) => {
  try {
    if (!req.user.is_diocesan) {
      return errorResponse(res, "Only diocesan users allowed", 403);
    }

    const mysql = getMySQLConnection();

    const [agreements] = await mysql.execute(
      `
      SELECT *
      FROM agreements
      WHERE status = 1
        AND applies_to_diocesan = 1
      ORDER BY uploaded_on DESC
      `
    );

    return successResponse(
      res,
      agreements,
      "Diocesan agreements fetched successfully"
    );
  } catch (error) {
    return errorResponse(res, error.message, 500);
  }
});

/* ============================================================
   2️⃣ GET DIOCESAN MY ASSIGNMENTS
   ------------------------------------------------------------
   @route   GET /api/diocese/my-assignments
   @desc    Fetch diocesan agreements with signature status
   @access  Private (Diocesan Only)
============================================================ */
router.get("/my-assignments", auth, async (req, res) => {
  try {
    if (!req.user.is_diocesan) {
      return errorResponse(res, "Only diocesan users allowed", 403);
    }

    const mysql = getMySQLConnection();
    const userId = Number(req.user.id);

    const [agreements] = await mysql.execute(
      `
      SELECT *
      FROM agreements
      WHERE status = 1
        AND applies_to_diocesan = 1
      `
    );

    const results = [];

    for (const ag of agreements) {
      const [signatureRows] = await mysql.execute(
        `
        SELECT *
        FROM user_signatures_documents
        WHERE user_id = ?
          AND document_id = ?
          AND deleted_at IS NULL
        LIMIT 1
        `,
        [userId, ag.id]
      );

      let status = "pending";
      let signatureDetails = null;

      if (signatureRows.length > 0) {
        status = signatureRows[0].status || "pending";
        signatureDetails = signatureRows[0];
      }

      results.push({
        agreement_id: ag.id,
        agreement_title: ag.agreement_title,
        agreements_file_name: ag.file_name,
        agreements_file_path: ag.file_path,
        agreement_type: ag.agreement_type,
        assigned_via: "diocesan",
        status,
        signature_details: signatureDetails,
        signature_position: ag.signature_position
          ? JSON.parse(ag.signature_position)
          : null,
        uploaded_on: ag.uploaded_on,
      });
    }

    results.sort((a, b) => new Date(b.uploaded_on) - new Date(a.uploaded_on));

    return successResponse(
      res,
      results,
      "Diocesan assignments fetched successfully"
    );
  } catch (error) {
    return errorResponse(res, error.message, 500);
  }
});

/* ============================================================
   3️⃣ SIGN DIOCESAN AGREEMENT
   ------------------------------------------------------------
   @route   POST /api/diocese/agreements/sign
   @desc    Diocesan user signs an agreement
   @access  Private (Diocesan Only)
============================================================ */
router.post("/agreements/sign", auth, async (req, res) => {
  try {
    if (!req.user.is_diocesan) {
      return errorResponse(res, "Only diocesan users allowed", 403);
    }

    const { agreement_id, signature_file_name, signature_file_url } = req.body;

    if (!agreement_id || !signature_file_name || !signature_file_url) {
      return errorResponse(res, "All fields are required", 400);
    }

    const mysql = getMySQLConnection();

    const [[agreement]] = await mysql.execute(
      `
      SELECT applies_to_diocesan
      FROM agreements
      WHERE id = ?
        AND status = 1
      `,
      [agreement_id]
    );

    if (!agreement) {
      return errorResponse(res, "Agreement not found", 404);
    }

    if (!agreement.applies_to_diocesan) {
      return errorResponse(
        res,
        "This agreement is not for diocesan users",
        403
      );
    }

    const [[existing]] = await mysql.execute(
      `
      SELECT id
      FROM user_signatures_documents
      WHERE user_id = ?
        AND document_id = ?
        AND deleted_at IS NULL
      `,
      [req.user.id, agreement_id]
    );

    if (existing) {
      return errorResponse(res, "Agreement already signed", 400);
    }

    const history = JSON.stringify([
      {
        action: "uploaded",
        timestamp: new Date().toISOString(),
        user_id: req.user.id,
      },
    ]);

    const [result] = await mysql.execute(
      `
      INSERT INTO user_signatures_documents
      (
        user_id,
        document_id,
        signature_file_name,
        signature_file_url,
        history
      )
      VALUES (?, ?, ?, ?, ?)
      `,
      [
        req.user.id,
        agreement_id,
        signature_file_name,
        signature_file_url,
        history,
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

/* ============================================================
   4️⃣ REVIEW DIOCESAN AGREEMENT (ADMIN)
   ------------------------------------------------------------
   @route   PUT /api/diocese/agreements/review/:id
   @desc    Superadmin approves or rejects diocesan agreement
   @access  Private (Superadmin Only)
============================================================ */
router.put("/agreements/review/:id", auth, async (req, res) => {
  try {
    if (req.user.user_type !== "superadmin") {
      return errorResponse(res, "Only Superadmin allowed", 403);
    }

    const { id } = req.params;
    const { status, admin_notes } = req.body;

    if (!["signed", "reject"].includes(status)) {
      return errorResponse(res, "Invalid status", 400);
    }

    const mysql = getMySQLConnection();

    const [[record]] = await mysql.execute(
      `SELECT * FROM user_signatures_documents WHERE id = ?`,
      [id]
    );

    if (!record) {
      return errorResponse(res, "Record not found", 404);
    }

    let history = [];
    try {
      history = record.history ? JSON.parse(record.history) : [];
    } catch {
      history = [];
    }

    history.push({
      action: status === "signed" ? "approved" : "rejected",
      timestamp: new Date().toISOString(),
      admin_id: req.user.id,
      notes: admin_notes || null,
    });

    await mysql.execute(
      `
      UPDATE user_signatures_documents
      SET status = ?, history = ?
      WHERE id = ?
      `,
      [status, JSON.stringify(history), id]
    );

    if (status === "signed") {
      await mysql.execute(
        `
        UPDATE dioceses
        SET contract_signed = TRUE,
            contract_signed_at = NOW()
        WHERE user_id = ?
        `,
        [record.user_id]
      );
    }

    return successResponse(
      res,
      null,
      status === "signed"
        ? "Agreement approved successfully"
        : "Agreement rejected successfully"
    );
  } catch (error) {
    return errorResponse(res, error.message, 500);
  }
});

/* ============================================================
   5️⃣ ADMIN VIEW ALL DIOCESAN SIGNATURE REQUESTS
   ------------------------------------------------------------
   @route   GET /api/diocese/admin/agreements
   @desc    Fetch all diocesan agreement signature requests
   @access  Private (Superadmin Only)
============================================================ */
router.get("/admin/agreements", auth, async (req, res) => {
  try {
    if (req.user.user_type !== "superadmin") {
      return errorResponse(res, "Unauthorized", 403);
    }

    const mysql = getMySQLConnection();

    const [rows] = await mysql.execute(
      `
      SELECT usd.*, u.first_name, u.last_name, a.agreement_title
      FROM user_signatures_documents usd
      JOIN users u ON usd.user_id = u.id
      JOIN agreements a ON usd.document_id = a.id
      WHERE u.is_diocesan = 1
      ORDER BY usd.created_at DESC
      `
    );

    return successResponse(
      res,
      rows,
      "Diocesan signature requests fetched successfully"
    );
  } catch (error) {
    return errorResponse(res, error.message, 500);
  }
});


module.exports = router;
