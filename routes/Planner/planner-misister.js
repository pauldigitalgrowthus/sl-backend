const express = require('express');
const router = express.Router();
const { getMySQLConnection } = require('../../config/mysql');
const { auth } = require('../../middleware/auth');
const { successResponse, errorResponse } = require('../../utils/response');
const { resolveCommunityId } = require('./helpers');
const { sendEmail } = require('../../utils/SendMailer');
const bcrypt = require('bcryptjs');

/**
 * =====================================================
 * POST /api/planners/ministers
 * Create planner minister (Invitation stage)
 * =====================================================
 * Access : Private
 * Role   : Admin / Manager
 * =====================================================
 */
router.post("/", auth, async (req, res) => {
  const connection = getMySQLConnection();

  try {
    const {
      person_name,
      email,
      phone,
      instruments,
      vocal_parts,
      gender,
      marital_status,
      user_type
    } = req.body;

    const parentUser = req.user;

    // =========================
    // ACCESS CONTROL
    // =========================
    if (!["admin", "manager"].includes(parentUser.user_type)) {
      return errorResponse(res, "Only admin or manager can create ministers", 403);
    }

    if (!person_name || !email) {
      return errorResponse(res, "Person name and email required", 400);
    }
    // console.log(parentUser)
    // if (parentUser.plan_status !== "active") {
    //   return errorResponse(res, "Active plan required", 403);
    // }

    // =========================
    // RESOLVE COMMUNITY
    // =========================
    const parentUserId = await resolveCommunityId(connection, parentUser.id);

    // =========================
    // DUPLICATE MINISTER
    // =========================
    const [[existingMinister]] = await connection.execute(
      `SELECT id FROM planner_ministers
       WHERE parent_user_id = ?
       AND email = ?
       AND deleted_at IS NULL`,
      [parentUserId, email.trim()]
    );

    if (existingMinister) {
      return errorResponse(res, "Minister already exists with this email", 409);
    }

    // =========================
    // DUPLICATE USER
    // =========================
    const [[existingUser]] = await connection.execute(
      `SELECT id FROM users WHERE email = ?`,
      [email.trim()]
    );

    if (existingUser) {
      return errorResponse(res, "User already exists with this email", 400);
    }

    // =========================
    // ROLE NORMALIZATION
    // =========================
    const finalUserType = user_type === "Manager" ? "Manager" : "Member";

    // =========================
    // PLAN PERMISSIONS
    // =========================
    let planPermissions = parentUser.plan_permissions;

    if (typeof planPermissions === "string") {
      planPermissions = JSON.parse(planPermissions);
    }

    const memberConfig = planPermissions?.["Member Limit"]?.["Members"];
    const managerConfig = planPermissions?.["Member Limit"]?.["Managers"];

    if (finalUserType === "Member" && memberConfig === "-") {
      return errorResponse(res, "Your plan does not allow adding members", 403);
    }

    if (finalUserType === "Manager" && managerConfig === "-") {
      return errorResponse(res, "Your plan does not allow adding managers", 403);
    }

    let updatedPlanPermissions = JSON.parse(JSON.stringify(planPermissions));

    if (finalUserType === "Member" && typeof memberConfig === "object") {

      if (memberConfig.used >= memberConfig.limit) {
        return errorResponse(res, `Member limit reached (${memberConfig.limit})`, 403);
      }

      updatedPlanPermissions["Member Limit"]["Members"].used += 1;

    }

    if (finalUserType === "Manager" && typeof managerConfig === "object") {

      if (managerConfig.used >= managerConfig.limit) {
        return errorResponse(res, `Manager limit reached (${managerConfig.limit})`, 403);
      }

      updatedPlanPermissions["Member Limit"]["Managers"].used += 1;

    }

    // =========================
    // PASSWORD
    // =========================
    const bcrypt = require("bcryptjs");

    const plainPassword = "12345678";

    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    // =========================
    // NAME SPLIT
    // =========================
    const [firstName, ...rest] = person_name.trim().split(" ");
    const lastName = rest.join(" ") || "";
    const fullName = `${firstName} ${lastName}`;

    const mappedUserType =
      finalUserType === "Manager" ? "manager" : "sub_user";

    const roleLabel =
      mappedUserType === "manager"
        ? "Manager (Minister)"
        : "Member (Minister)";

    // =========================
    // BUILD CHILD PERMISSIONS
    // =========================
    let childPlanPermissions = {};

    if (mappedUserType === "manager") {

      childPlanPermissions = JSON.parse(JSON.stringify(planPermissions));

      if (childPlanPermissions["SL Account"]) {

        delete childPlanPermissions["SL Account"]["Manage Plan (Upgrade)"];
        delete childPlanPermissions["SL Account"]["Agreements"];

      }

    }

    if (mappedUserType === "sub_user") {

      childPlanPermissions = {};

      // MUSIC
      if (planPermissions?.Music?.["My Music"]) {

        childPlanPermissions.Music = {
          "My Music": planPermissions.Music["My Music"]
        };

      }

      // PLANNER
      if (planPermissions?.Planner?.["My Planner"]) {

        childPlanPermissions.Planner = {
          "My Planner": planPermissions.Planner["My Planner"]
        };

      }

      // SL ACCOUNT
      if (planPermissions?.["SL Account"]) {

        childPlanPermissions["SL Account"] = {};

        if (planPermissions["SL Account"]["My Profile"]) {
          childPlanPermissions["SL Account"]["My Profile"] =
            planPermissions["SL Account"]["My Profile"];
        }

        if (planPermissions["SL Account"]["My Ministers"]) {
          childPlanPermissions["SL Account"]["My Ministers"] =
            planPermissions["SL Account"]["My Ministers"];
        }

      }

    }

    // =========================
    // NORMALIZE JSON
    // =========================
    const normalizedInstruments = Array.isArray(instruments)
      ? JSON.stringify(instruments)
      : null;

    const normalizedVocalParts = Array.isArray(vocal_parts)
      ? JSON.stringify(vocal_parts)
      : null;

    // =========================
    // CREATE MINISTER
    // =========================
    const [ministerResult] = await connection.execute(
      `INSERT INTO planner_ministers (
        person_name,
        email,
        phone,
        instruments,
        vocal_parts,
        gender,
        marital_status,
        user_type,
        status,
        parent_user_id,
        has_login_credentials
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'invited', ?, 0)`,
      [
        person_name.trim(),
        email.trim(),
        phone || null,
        normalizedInstruments,
        normalizedVocalParts,
        gender || null,
        marital_status || null,
        finalUserType,
        parentUserId
      ]
    );

    const ministerId = ministerResult.insertId;

    // =========================
    // CREATE USER
    // =========================
    const [userResult] = await connection.execute(
      `INSERT INTO users (
        first_name,
        last_name,
        email,
        password,
        phone,
        role,
        user_type,
        parent_user_id,
        plan_permissions,
        is_active,
        is_verified
      ) VALUES (?, ?, ?, ?, ?, 'user', ?, ?, ?, 1, 1)`,
      [
        firstName,
        lastName,
        email.trim(),
        hashedPassword,
        phone || null,
        mappedUserType,
        parentUserId,
        JSON.stringify(childPlanPermissions)
      ]
    );

    const newUserId = userResult.insertId;

    // =========================
    // UPDATE MINISTER
    // =========================
    await connection.execute(
      `UPDATE planner_ministers
       SET has_login_credentials = 1,
           linked_user_id = ?,
           credentials_created_at = NOW(),
           status = 'active'
       WHERE id = ?`,
      [newUserId, ministerId]
    );

    // =========================
    // UPDATE PARENT PLAN
    // =========================
    await connection.execute(
      `UPDATE users
       SET plan_permissions = ?
       WHERE id = ?`,
      [JSON.stringify(updatedPlanPermissions), parentUser.id]
    );

    // =========================
    // EMAIL
    // =========================
    const loginLink = `${process.env.FRONTEND_URL}/login`;
    const supportEmail = process.env.SUPPORT_MAIL || "support@slmusic.org";

    const subject = "Your Simply Liturgical login credentials";

    const html = `
      <div style="font-family: Arial; font-size:14px;">
        <p>Hi ${fullName},</p>

        <p>You have been added as <strong>${roleLabel}</strong>.</p>

        <p>Your login credentials:</p>

        <ul>
          <li>Email: ${email}</li>
          <li>Password: ${plainPassword}</li>
          <li><a href="${loginLink}">Login</a></li>
        </ul>

        <p>Contact support: ${supportEmail}</p>

        <p>Simply Liturgical Team</p>
      </div>
    `;

    await sendEmail({ to: email, subject, html });

    return successResponse(
      res,
      "Minister created and login credentials sent",
      {
        minister_id: ministerId,
        user_id: newUserId,
        email,
        password: plainPassword,
        user_type: mappedUserType
      },
      201
    );

  } catch (error) {

    console.error("Create minister error:", error);

    return errorResponse(res, error.message, 500);

  }

});



/**
 * =====================================================
 * GET /api/planners/ministers
 * Get all community ministers
 * =====================================================
 * Access : Private (Admin / Manager)
 * =====================================================
 */
router.get('/', auth, async (req, res) => {
  const connection = getMySQLConnection();

  try {
    // =========================
    // 🔐 ACCESS CONTROL
    // =========================
    if (!['admin', 'manager'].includes(req.user.user_type)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // =========================
    // 🔹 RESOLVE COMMUNITY
    // =========================
    const parentUserId = await resolveCommunityId(
      connection,
      req.user.id
    );

    // =========================
    // 🔹 FETCH MINISTERS
    // =========================
    const [rows] = await connection.execute(
      `SELECT   pm.id,   pm.person_name,   pm.email,   pm.phone,   pm.gender,  
       pm.marital_status,   pm.user_type,   pm.status,   pm.has_login_credentials, 
       pm.created_at,   pm.instruments,   pm.vocal_parts,   u.id AS linked_user_id,   u.first_name AS login_first_name, 
        u.last_name AS login_last_name,   u.email AS login_email,   u.user_type AS login_user_type FROM planner_ministers pm LEFT JOIN users u   
        ON pm.linked_user_id = u.id WHERE pm.parent_user_id = ?   AND pm.deleted_at IS NULL ORDER BY pm.created_at DESC`, [parentUserId]
    );

    // =========================
    // 🔹 NORMALIZE JSON FIELDS
    // =========================
    const formatted = rows.map(row => ({ ...row, instruments: row.instruments ? JSON.parse(row.instruments) : [], vocal_parts: row.vocal_parts ? JSON.parse(row.vocal_parts) : [] }));

    // =========================
    // 🎉 SUCCESS RESPONSE
    // =========================
    return res.status(200).json({
      success: true,
      message: 'Community ministers fetched successfully',
      data: formatted
    });

  } catch (error) {
    console.error('Fetch ministers error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

/**
 * =====================================================
 * GET /api/planners/ministers/:id
 * Get single community minister detail
 * =====================================================
 * Access : Private (Admin / Manager)
 * =====================================================
 */
router.get('/:id', auth, async (req, res) => {
  const connection = getMySQLConnection();

  try {
    const { id } = req.params;

    // =========================
    // 🔐 ACCESS CONTROL
    // =========================
    if (!['admin', 'manager'].includes(req.user.user_type)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // =========================
    // 🔹 RESOLVE COMMUNITY
    // =========================
    const parentUserId = await resolveCommunityId(
      connection,
      req.user.id
    );

    // =========================
    // 🔹 FETCH MINISTER
    // =========================
    const [[minister]] = await connection.execute(
      `SELECT
        pm.id,
        pm.person_name,
        pm.email,
        pm.phone,
        pm.gender,
        pm.marital_status,
        pm.user_type,
        pm.status,
        pm.has_login_credentials,
        pm.created_at,
        pm.updated_at,

        pm.instruments,
        pm.vocal_parts,

        u.id AS linked_user_id,
        u.first_name AS login_first_name,
        u.last_name AS login_last_name,
        u.email AS login_email,
        u.phone AS login_phone,
        u.user_type AS login_user_type

      FROM planner_ministers pm
      LEFT JOIN users u
        ON pm.linked_user_id = u.id

      WHERE pm.id = ?
        AND pm.parent_user_id = ?
        AND pm.deleted_at IS NULL
      LIMIT 1`,
      [id, parentUserId]
    );

    if (!minister) {
      return res.status(404).json({
        success: false,
        message: 'Minister not found'
      });
    }

    // =========================
    // 🔹 PARSE JSON FIELDS
    // =========================
    const formattedMinister = {
      ...minister,
      instruments: minister.instruments
        ? JSON.parse(minister.instruments)
        : [],
      vocal_parts: minister.vocal_parts
        ? JSON.parse(minister.vocal_parts)
        : []
    };

    // =========================
    // 🎉 SUCCESS RESPONSE
    // =========================
    return res.status(200).json({
      success: true,
      message: 'Minister fetched successfully',
      data: formattedMinister
    });

  } catch (error) {
    console.error('Get minister error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

/**
 * =====================================================
 * PUT /api/planners/ministers/:id
 * Update minister information
 * =====================================================
 * Access : Private (Superadmin / Admin / Manager)
 * =====================================================
 */
router.put('/:id', auth, async (req, res) => {
  const connection = getMySQLConnection();

  try {
    const { id } = req.params;

    const {
      person_name,
      phone,
      instruments,
      vocal_parts,
      gender,
      marital_status,
      user_type,
      status
    } = req.body;

    // ================================
    // 🔐 ROLE CHECK
    // ================================
    const allowedRoles = ['superadmin', 'admin', 'manager'];

    if (!allowedRoles.includes(req.user.user_type)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // ================================
    // 🔍 GET MINISTER (WITH USER LINK)
    // ================================
    const [[minister]] = await connection.execute(
      `SELECT id, linked_user_id, parent_user_id
       FROM planner_ministers
       WHERE id = ? AND deleted_at IS NULL`,
      [id]
    );

    if (!minister) {
      return res.status(404).json({
        success: false,
        message: 'Minister not found'
      });
    }

    // ================================
    // 🔹 NORMALIZE DATA
    // ================================
    const finalInstruments =
      Array.isArray(instruments) ? JSON.stringify(instruments) : null;

    const finalVocalParts =
      Array.isArray(vocal_parts) ? JSON.stringify(vocal_parts) : null;

    const finalPersonName =
      person_name?.trim() || null;

    const finalPhone =
      phone?.trim() || null;

    // ================================
    // 🔹 BUILD MINISTER UPDATE
    // ================================
    const fields = [];
    const values = [];

    if (finalPersonName !== null) {
      fields.push('person_name = ?');
      values.push(finalPersonName);
    }

    if (finalPhone !== null) {
      fields.push('phone = ?');
      values.push(finalPhone);
    }

    if (finalInstruments !== null) {
      fields.push('instruments = ?');
      values.push(finalInstruments);
    }

    if (finalVocalParts !== null) {
      fields.push('vocal_parts = ?');
      values.push(finalVocalParts);
    }

    if (gender !== undefined) {
      fields.push('gender = ?');
      values.push(gender || null);
    }

    if (marital_status !== undefined) {
      fields.push('marital_status = ?');
      values.push(marital_status || null);
    }

    if (user_type !== undefined) {
      fields.push('user_type = ?');
      values.push(user_type);
    }

    if (status !== undefined) {
      fields.push('status = ?');
      values.push(status);
    }

    if (fields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields provided'
      });
    }

    // ================================
    // 🔵 ADMIN / MANAGER CHECK
    // ================================
    if (req.user.user_type !== 'superadmin') {
      const parentUserId = await resolveCommunityId(
        connection,
        req.user.id
      );

      if (parentUserId !== minister.parent_user_id) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }
    }

    // ================================
    // 🟢 UPDATE MINISTER
    // ================================
    await connection.execute(
      `UPDATE planner_ministers
       SET ${fields.join(', ')}
       WHERE id = ?`,
      [...values, id]
    );

    // ================================
    // 🔄 UPDATE LINKED USER ALSO
    // ================================
    if (minister.linked_user_id) {

      const userFields = [];
      const userValues = [];

      // NAME SPLIT
      if (finalPersonName) {
        const [firstName, ...rest] = finalPersonName.split(' ');
        const lastName = rest.join(' ') || '';

        userFields.push('first_name = ?');
        userValues.push(firstName);

        userFields.push('last_name = ?');
        userValues.push(lastName);
      }

      if (finalPhone !== null) {
        userFields.push('phone = ?');
        userValues.push(finalPhone);
      }

      // USER TYPE MAPPING
      if (user_type !== undefined) {
        const mappedUserType =
          user_type === 'Manager' ? 'manager' : 'sub_user';

        userFields.push('user_type = ?');
        userValues.push(mappedUserType);
      }

      // STATUS SYNC
      if (status !== undefined) {
        const isActive = status === 'active' ? 1 : 0;

        userFields.push('is_active = ?');
        userValues.push(isActive);
      }

      if (userFields.length > 0) {
        await connection.execute(
          `UPDATE users
           SET ${userFields.join(', ')}
           WHERE id = ?`,
          [...userValues, minister.linked_user_id]
        );
      }
    }

    // ================================
    // ✅ SUCCESS
    // ================================
    return res.status(200).json({
      success: true,
      message: 'Minister & user updated successfully'
    });

  } catch (error) {
    console.error('Update error:', error);

    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

/**
 * =====================================================
 * DELETE /api/planners/ministers/:id
 * Soft delete minister from community
 * =====================================================
 * Access : Private (Superadmin / Admin / Manager)
 * =====================================================
 */
router.delete('/:id', auth, async (req, res) => {
  const connection = getMySQLConnection();

  try {
    const { id } = req.params;

    // ================================
    // 🔐 ROLE CHECK
    // ================================
    const allowedRoles = ['superadmin', 'admin', 'manager'];

    if (!allowedRoles.includes(req.user.user_type)) {
      return res.status(403).json({
        success: false,
        message:
          'Access denied. Only superadmin, admin or manager can delete minister.'
      });
    }

    // ================================
    // 🔍 FETCH MINISTER FIRST
    // ================================
    let ministerQuery = `
      SELECT id, parent_user_id, linked_user_id
      FROM planner_ministers
      WHERE id = ?
        AND deleted_at IS NULL
    `;

    const params = [id];

    if (req.user.user_type !== 'superadmin') {
      const parentUserId = await resolveCommunityId(
        connection,
        req.user.id
      );
      ministerQuery += ` AND parent_user_id = ?`;
      params.push(parentUserId);
    }

    const [[minister]] = await connection.execute(
      ministerQuery,
      params
    );

    if (!minister) {
      return res.status(404).json({
        success: false,
        message: 'Minister not found or access denied'
      });
    }

    // ================================
    // 🔗 UNLINK LOGIN (IF EXISTS)
    // ================================
    if (minister.linked_user_id) {
      await connection.execute(
        `
        UPDATE users
        SET is_active = 0
        WHERE id = ?
        `,
        [minister.linked_user_id]
      );
    }

    // ================================
    // 🗑️ SOFT DELETE MINISTER
    // ================================
    await connection.execute(
      `
      UPDATE planner_ministers
      SET deleted_at = NOW(),
          has_login_credentials = 0,
          linked_user_id = NULL
      WHERE id = ?
      `,
      [id]
    );

    // ================================
    // 🎉 SUCCESS RESPONSE
    // ================================
    return res.status(200).json({
      success: true,
      message: 'Minister removed successfully',
      data: { id }
    });

  } catch (error) {
    console.error('❌ Delete minister error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

/**
 * =====================================================
 * POST /api/planners/ministers/:id/enable-login
 * Create login credentials for minister
 * =====================================================
 * Access : Private (Superadmin / Admin / Manager)
 * =====================================================
 */
router.post('/:id/enable-login', auth, async (req, res) => {
  const mysqlConnection = getMySQLConnection();

  try {
    const { id } = req.params;
    const { password } = req.body;
    const parentUser = req.user;

    // =========================
    // 🔐 ROLE CHECK
    // =========================
    const allowedRoles = ['superadmin', 'admin', 'manager'];

    if (!allowedRoles.includes(parentUser.user_type)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied.'
      });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password is required (min 6 characters).'
      });
    }

    // =========================
    // 🔹 FETCH MINISTER
    // =========================
    let ministerQuery = `
      SELECT *
      FROM planner_ministers
      WHERE id = ?
        AND deleted_at IS NULL
    `;
    const params = [id];

    if (parentUser.user_type !== 'superadmin') {
      const resolvedParentId = await resolveCommunityId(
        mysqlConnection,
        parentUser.id
      );
      ministerQuery += ` AND parent_user_id = ?`;
      params.push(resolvedParentId);
    }

    const [[minister]] = await mysqlConnection.execute(
      ministerQuery,
      params
    );

    if (!minister) {
      return res.status(404).json({
        success: false,
        message: 'Minister not found or access denied.'
      });
    }

    if (minister.has_login_credentials) {
      return res.status(400).json({
        success: false,
        message: 'Login credentials already enabled.'
      });
    }

    if (!minister.email) {
      return res.status(400).json({
        success: false,
        message: 'Minister email is required.'
      });
    }

    // =========================
    // 🔹 CHECK DUPLICATE USER
    // =========================
    const [[existingUser]] = await mysqlConnection.execute(
      `SELECT id FROM users WHERE email = ?`,
      [minister.email]
    );

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User already exists with this email.'
      });
    }

    // =========================
    // 🔹 HASH PASSWORD
    // =========================
    const bcrypt = require('bcryptjs');
    const hashedPassword = await bcrypt.hash(password, 10);

    // =========================
    // 🔹 SPLIT NAME
    // =========================
    const [firstName, ...rest] = minister.person_name.trim().split(' ');
    const lastName = rest.join(' ') || '';

    // =========================
    // 🔹 INHERIT PLAN PERMISSIONS
    // =========================
    let planPermissions = parentUser.plan_permissions;

    if (typeof planPermissions === 'string') {
      planPermissions = JSON.parse(planPermissions);
    }

    const inheritedPermissions = planPermissions || null;

    // =========================
    // 🔹 USER TYPE MAP
    // =========================
    const userType =
      minister.user_type === 'Manager' ? 'manager' : 'sub_user';

    // =========================
    // 🔹 CREATE USER
    // =========================
    const [userResult] = await mysqlConnection.execute(
      `
      INSERT INTO users (
        first_name,
        last_name,
        email,
        password,
        phone,
        role,
        user_type,
        parent_user_id,
        plan_permissions,
        is_active,
        is_verified
      ) VALUES (?, ?, ?, ?, ?, 'user', ?, ?, ?, 1, 1)
      `,
      [
        firstName,
        lastName,
        minister.email,
        hashedPassword,
        minister.phone || null,
        userType,
        minister.parent_user_id,
        inheritedPermissions
          ? JSON.stringify(inheritedPermissions)
          : null
      ]
    );

    const newUserId = userResult.insertId;

    // =========================
    // 🔹 UPDATE MINISTER
    // =========================
    await mysqlConnection.execute(
      `
      UPDATE planner_ministers
      SET
        has_login_credentials = 1,
        linked_user_id = ?,
        credentials_created_at = NOW(),
        status = 'active'
      WHERE id = ?
      `,
      [newUserId, minister.id]
    );

    // =========================
    // 🎉 SUCCESS RESPONSE
    // =========================
    return res.status(201).json({
      success: true,
      message: 'Login credentials created successfully.',
      data: {
        minister_id: minister.id,
        user_id: newUserId,
        user_type: userType,
        permissionsAssigned: true
      }
    });

  } catch (error) {
    console.error('Enable minister login error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});


module.exports = router;
