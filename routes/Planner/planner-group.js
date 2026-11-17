const express = require('express');
const router = express.Router();

const { getMySQLConnection } = require('../../config/mysql');
const { auth } = require('../../middleware/auth');
const { successResponse, errorResponse } = require('../../utils/response');
const { resolveCommunityId } = require('./helpers');

/**
 * =====================================================
 * POST /api/planners/groups
 * Create planner group
 * =====================================================
 * Access : Private
 * Scope  : Community / Parent User
 * =====================================================
 */
router.post('/', auth, async (req, res) => {
  try {
    const { group_name } = req.body;

    if (!group_name || !group_name.toString().trim()) {
      return errorResponse(res, 'group_name is required', 400);
    }

    const connection = getMySQLConnection();
    const parentUserId = await resolveCommunityId(connection, req.user.id);

    const cleanName = group_name.toString().trim();

    const [[exists]] = await connection.execute(
      `SELECT id FROM planner_groups WHERE parent_user_id = ? AND group_name = ?`,
      [parentUserId, cleanName]
    );

    if (exists) {
      return errorResponse(res, 'Group already exists', 409);
    }

    const [result] = await connection.execute(
      `INSERT INTO planner_groups (parent_user_id, group_name)
       VALUES (?, ?)`,
      [parentUserId, cleanName]
    );

    return successResponse(res, { id: result.insertId }, 'Group created successfully', 201);
  } catch (err) {
    console.error('Error creating group:', err);
    return errorResponse(res, 'Error creating group', 500);
  }
});

/**
 * =====================================================
 * GET /api/planners/groups
 * Fetch all planner groups
 * =====================================================
 * Access : Private
 * Scope  : Community / Parent User
 * =====================================================
 */
router.get('/', auth, async (req, res) => {
  try {
    const connection = getMySQLConnection();
    const parentUserId = await resolveCommunityId(connection, req.user.id);

    const [rows] = await connection.execute(
      `SELECT
        pg.id,
        pg.group_name,
        pg.created_at,
        (
          SELECT COUNT(*)
          FROM planner_group_members pgm
          WHERE pgm.group_id = pg.id
        ) AS members_count
       FROM planner_groups pg
       WHERE pg.parent_user_id = ?
       ORDER BY pg.created_at DESC`,
      [parentUserId]
    );

    return successResponse(res, rows, 'Groups fetched successfully');
  } catch (err) {
    console.error('Error fetching groups:', err);
    return errorResponse(res, 'Error fetching groups', 500);
  }
});

/**
 * =====================================================
 * GET /api/planners/groups/:id
 * Fetch single group with ministers
 * =====================================================
 */
router.get('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const connection = getMySQLConnection();
    const parentUserId = await resolveCommunityId(connection, req.user.id);

    /* --------------------------------------------------
       1️⃣ VALIDATE GROUP
    -------------------------------------------------- */
    const [[group]] = await connection.execute(
      `SELECT id, group_name, created_at
       FROM planner_groups
       WHERE id = ? AND parent_user_id = ?`,
      [id, parentUserId]
    );

    if (!group) {
      return errorResponse(res, 'Group not found', 404);
    }

    /* --------------------------------------------------
       2️⃣ FETCH GROUP MEMBERS (SAFE JOIN)
    -------------------------------------------------- */
    const [members] = await connection.execute(
      `SELECT
        pgm.id,
        pgm.minister_id,
        pgm.person_name,
        pgm.email,
        pgm.phone,
        pgm.instrument,
        pgm.created_at,

        pm.gender,
        pm.marital_status,
        pm.user_type AS minister_role,
        pm.status AS minister_status,

        u.id AS linked_user_id,
        u.avatar,
        u.user_type AS login_user_type

       FROM planner_group_members pgm
       JOIN planner_ministers pm
         ON pm.id = pgm.minister_id
       LEFT JOIN users u
         ON u.id = pm.linked_user_id
       WHERE pgm.group_id = ?
         AND pgm.parent_user_id = ?
       ORDER BY pgm.created_at DESC`,
      [id, parentUserId]
    );

    return successResponse(
      res,
      {
        ...group,
        members
      },
      'Group fetched successfully'
    );
  } catch (err) {
    console.error('Error fetching group:', err);
    return errorResponse(res, 'Error fetching group', 500);
  }
});


/**
 * =====================================================
 * PUT /api/planners/groups/:id
 * Update planner group
 * =====================================================
 */
router.put('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { group_name } = req.body;

    // ================================
    // 🔐 Role / Permission Check
    // ================================
    const allowedUserTypes = ['superadmin', 'admin', 'manager'];

    if (!allowedUserTypes.includes(req.user.user_type)) {
      return errorResponse(
        res,
        'Access denied. Only superadmin, admin or manager can update group.',
        403
      );
    }

    // ================================
    // 🧹 Validation
    // ================================
    if (group_name !== undefined && !group_name.toString().trim()) {
      return errorResponse(res, 'group_name cannot be empty', 400);
    }

    const connection = getMySQLConnection();
    let parentUserId = null;
    let exists;

    // ================================
    // 🟣 SUPERADMIN (NO COMMUNITY CHECK)
    // ================================
    if (req.user.user_type === 'superadmin') {
      [[exists]] = await connection.execute(
        `
        SELECT id
        FROM planner_groups
        WHERE id = ?
        `,
        [id]
      );
    }

    // ================================
    // 🔵 ADMIN / MANAGER (COMMUNITY CHECK)
    // ================================
    else {
      parentUserId = await resolveCommunityId(connection, req.user.id);

      [[exists]] = await connection.execute(
        `
        SELECT id
        FROM planner_groups
        WHERE id = ? AND parent_user_id = ?
        `,
        [id, parentUserId]
      );
    }

    if (!exists) {
      return errorResponse(res, 'Group not found or access denied', 404);
    }

    // ================================
    // ✏️ Update group_name (if provided)
    // ================================
    if (group_name !== undefined) {
      const cleanName = group_name.toString().trim();

      // 🚫 Duplicate name check
      if (req.user.user_type === 'superadmin') {
        const [[dup]] = await connection.execute(
          `
          SELECT id
          FROM planner_groups
          WHERE group_name = ?
            AND id <> ?
          `,
          [cleanName, id]
        );

        if (dup) {
          return errorResponse(res, 'Group name already exists', 409);
        }

        await connection.execute(
          `
          UPDATE planner_groups
          SET group_name = ?
          WHERE id = ?
          `,
          [cleanName, id]
        );
      } else {
        const [[dup]] = await connection.execute(
          `
          SELECT id
          FROM planner_groups
          WHERE parent_user_id = ?
            AND group_name = ?
            AND id <> ?
          `,
          [parentUserId, cleanName, id]
        );

        if (dup) {
          return errorResponse(res, 'Group name already exists', 409);
        }

        await connection.execute(
          `
          UPDATE planner_groups
          SET group_name = ?
          WHERE id = ? AND parent_user_id = ?
          `,
          [cleanName, id, parentUserId]
        );
      }
    }

    return successResponse(
      res,
      { id: Number(id) },
      'Group updated successfully'
    );

  } catch (err) {
    console.error('❌ Error updating group:', err);
    return errorResponse(res, 'Error updating group', 500);
  }
});

/**
 * =====================================================
 * DELETE /api/planners/groups/:id
 * Delete planner group
 * =====================================================
 */
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;

    // ================================
    // 🔐 Role / Permission Check
    // ================================
    const allowedUserTypes = ['superadmin', 'admin', 'manager'];

    if (!allowedUserTypes.includes(req.user.user_type)) {
      return errorResponse(
        res,
        'Access denied. Only superadmin, admin or manager can delete group.',
        403
      );
    }

    const connection = getMySQLConnection();
    let parentUserId = null;
    let exists;
    let result;

    // ================================
    // 🟣 SUPERADMIN (NO COMMUNITY CHECK)
    // ================================
    if (req.user.user_type === 'superadmin') {
      [[exists]] = await connection.execute(
        `
        SELECT id
        FROM planner_groups
        WHERE id = ?
        `,
        [id]
      );

      if (!exists) {
        return errorResponse(res, 'Group not found', 404);
      }

      // 🧹 Members auto-deleted via FK CASCADE
      [result] = await connection.execute(
        `
        DELETE FROM planner_groups
        WHERE id = ?
        `,
        [id]
      );
    }

    // ================================
    // 🔵 ADMIN / MANAGER (COMMUNITY CHECK)
    // ================================
    else {
      parentUserId = await resolveCommunityId(connection, req.user.id);

      [[exists]] = await connection.execute(
        `
        SELECT id
        FROM planner_groups
        WHERE id = ? AND parent_user_id = ?
        `,
        [id, parentUserId]
      );

      if (!exists) {
        return errorResponse(res, 'Group not found or access denied', 404);
      }

      // 🧹 Members auto-deleted via FK CASCADE
      [result] = await connection.execute(
        `
        DELETE FROM planner_groups
        WHERE id = ? AND parent_user_id = ?
        `,
        [id, parentUserId]
      );
    }

    return successResponse(
      res,
      { id: Number(id) },
      'Group deleted successfully'
    );

  } catch (err) {
    console.error('❌ Error deleting group:', err);
    return errorResponse(res, 'Error deleting group', 500);
  }
});

/**
 * =====================================================
 * POST /api/planners/groups/:groupId/members
 * Add minister to group
 * =====================================================
 * Access : Private (Admin / Manager)
 * Scope  : Community / Parent User
 * =====================================================
 */
router.post('/:groupId/members', auth, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { minister_id } = req.body;

    if (!minister_id) {
      return errorResponse(res, 'minister_id is required', 400);
    }

    const connection = getMySQLConnection();
    const parentUserId = await resolveCommunityId(connection, req.user.id);

    /* --------------------------------------------------
       1️⃣ VALIDATE GROUP
    -------------------------------------------------- */
    const [[group]] = await connection.execute(
      `SELECT id FROM planner_groups
       WHERE id = ? AND parent_user_id = ?`,
      [groupId, parentUserId]
    );

    if (!group) {
      return errorResponse(res, 'Group not found', 404);
    }

    /* --------------------------------------------------
       2️⃣ VALIDATE MINISTER
    -------------------------------------------------- */
    const [[minister]] = await connection.execute(
      `SELECT id, person_name, email, phone, instruments
       FROM planner_ministers
       WHERE id = ? AND parent_user_id = ?`,
      [minister_id, parentUserId]
    );

    if (!minister) {
      return errorResponse(
        res,
        'Minister does not belong to this community',
        403
      );
    }

    /* --------------------------------------------------
       3️⃣ PREVENT DUPLICATE
    -------------------------------------------------- */
    const [[exists]] = await connection.execute(
      `SELECT id FROM planner_group_members
       WHERE group_id = ? AND minister_id = ?`,
      [groupId, minister_id]
    );

    if (exists) {
      return errorResponse(res, 'Minister already in group', 409);
    }

    /* --------------------------------------------------
       4️⃣ EXTRACT PRIMARY INSTRUMENT
    -------------------------------------------------- */
    let primaryInstrument = null;
    if (minister.instruments) {
      try {
        const parsed = JSON.parse(minister.instruments);
        if (Array.isArray(parsed) && parsed.length > 0) {
          primaryInstrument = parsed[0];
        }
      } catch (_) {}
    }

    /* --------------------------------------------------
       5️⃣ INSERT MEMBER
    -------------------------------------------------- */
    const [result] = await connection.execute(
      `INSERT INTO planner_group_members
        (group_id, parent_user_id, minister_id, person_name, email, phone, instrument)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        groupId,
        parentUserId,
        minister.id,
        minister.person_name,
        minister.email,
        minister.phone,
        primaryInstrument
      ]
    );

    return successResponse(
      res,
      { id: result.insertId },
      'Minister added to group successfully',
      201
    );
  } catch (err) {
    console.error('Error adding minister to group:', err);
    return errorResponse(res, 'Error adding minister', 500);
  }
});

/**
 * =====================================================
 * GET /api/planners/groups/:groupId/members
 * Fetch all ministers of a group
 * =====================================================
 */
router.get('/:groupId/members', auth, async (req, res) => {
  try {
    const { groupId } = req.params;
    const connection = getMySQLConnection();
    const parentUserId = await resolveCommunityId(connection, req.user.id);

    /* --------------------------------------------------
       1️⃣ VALIDATE GROUP
    -------------------------------------------------- */
    const [[group]] = await connection.execute(
      `SELECT id FROM planner_groups
       WHERE id = ? AND parent_user_id = ?`,
      [groupId, parentUserId]
    );

    if (!group) {
      return errorResponse(res, 'Group not found', 404);
    }

    /* --------------------------------------------------
       2️⃣ FETCH MEMBERS (FIXED JOIN)
    -------------------------------------------------- */
    const [rows] = await connection.execute(
      `SELECT
        pgm.id,
        pgm.group_id,
        pgm.minister_id,
        pgm.person_name,
        pgm.email,
        pgm.phone,
        pgm.instrument,
        pgm.created_at,

        pm.gender,
        pm.marital_status,
        pm.user_type AS minister_role,
        pm.status AS minister_status,

        u.id AS linked_user_id,
        u.avatar,
        u.user_type AS login_user_type

       FROM planner_group_members pgm
       JOIN planner_ministers pm
         ON pm.id = pgm.minister_id
       LEFT JOIN users u
         ON u.id = pm.linked_user_id
       WHERE pgm.group_id = ?
         AND pgm.parent_user_id = ?
       ORDER BY pgm.created_at DESC`,
      [groupId, parentUserId]
    );

    return successResponse(
      res,
      rows,
      'Group members fetched successfully'
    );
  } catch (err) {
    console.error('Error fetching group members:', err);
    return errorResponse(res, 'Error fetching group members', 500);
  }
});



/**
 * =====================================================
 * GET /api/planners/groups/:groupId/members/:id
 * Fetch single group member
 * =====================================================
 */
router.get('/:groupId/members/:id', auth, async (req, res) => {
  try {
    const { groupId, id } = req.params;
    const connection = getMySQLConnection();
    const parentUserId = await resolveCommunityId(connection, req.user.id);

    const [[row]] = await connection.execute(
      `SELECT
        pgm.*,
        pm.gender,
        pm.marital_status,
        u.user_type,
        u.avatar
       FROM planner_group_members pgm
       JOIN planner_ministers pm ON pm.id = pgm.minister_id
       JOIN users u ON u.id = pm.user_id
       WHERE pgm.id = ?
         AND pgm.group_id = ?
         AND pgm.parent_user_id = ?`,
      [id, groupId, parentUserId]
    );

    if (!row) {
      return errorResponse(res, 'Member not found', 404);
    }

    return successResponse(res, row, 'Group member fetched');
  } catch (err) {
    console.error('Error fetching group member:', err);
    return errorResponse(res, 'Error fetching member', 500);
  }
});


/**
 * =====================================================
 * PUT /api/planners/groups/:groupId/members/:id
 * Update group member instrument
 * =====================================================
 */
router.put('/:groupId/members/:id', auth, async (req, res) => {
  try {
    const { groupId, id } = req.params;
    const { instrument } = req.body;

    const connection = getMySQLConnection();
    const parentUserId = await resolveCommunityId(connection, req.user.id);

    const [result] = await connection.execute(
      `UPDATE planner_group_members
       SET instrument = ?
       WHERE id = ? AND group_id = ? AND parent_user_id = ?`,
      [instrument || null, id, groupId, parentUserId]
    );

    if (result.affectedRows === 0) {
      return errorResponse(res, 'Member not found', 404);
    }

    return successResponse(res, { id }, 'Member updated successfully');
  } catch (err) {
    console.error('Error updating member:', err);
    return errorResponse(res, 'Error updating member', 500);
  }
});


/**
 * =====================================================
 * DELETE /api/planners/groups/:groupId/members/:id
 * Remove minister from group
 * =====================================================
 */
router.delete('/:groupId/members/:id', auth, async (req, res) => {
  try {
    const { groupId, id } = req.params;
    const connection = getMySQLConnection();
    const parentUserId = await resolveCommunityId(connection, req.user.id);

    const [result] = await connection.execute(
      `DELETE FROM planner_group_members
       WHERE id = ? AND group_id = ? AND parent_user_id = ?`,
      [id, groupId, parentUserId]
    );

    if (result.affectedRows === 0) {
      return errorResponse(res, 'Member not found', 404);
    }

    return successResponse(res, { id }, 'Member removed successfully');
  } catch (err) {
    console.error('Error deleting member:', err);
    return errorResponse(res, 'Error deleting member', 500);
  }
});


module.exports = router;
