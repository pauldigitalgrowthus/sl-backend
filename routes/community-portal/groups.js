const express = require('express');
const jwt = require('jsonwebtoken');

// Optional auth middleware
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.header('Authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (token) {
      const jwtSecret = process.env.JWT_SECRET || 'your-super-secret-jwt-key-for-sl-music-backend-2024';
      const decoded = jwt.verify(token, jwtSecret);
      const userId = decoded?.userId || decoded?.id || decoded?.user?.id;
      if (userId) {
        const mysqlConnection = getMySQLConnection();
        const [users] = await mysqlConnection.execute('SELECT * FROM users WHERE id = ?', [userId]);
        if (users.length > 0 && users[0].is_active) {
          req.user = users[0];
        }
      }
    }
  } catch (err) {}
  next();
};
const { auth } = require('../../middleware/auth');
const { communityPortalUpload, deleteFileFromS3 } = require('../../config/s3');
const { successResponse, errorResponse } = require('../../utils/response');
const {
  getMySQLConnection,
  isCommunityModerator,
  getPagination,
  isActiveGroupMember,
  sendCommunityNotification,
  requireCommunityPermission
} = require('./helpers');
const { emitToRoom, emitToUser } = require('./socket');

const router = express.Router();

const VALID_GROUP_TYPES = ['diocesan', 'parish', 'composer', 'interest', 'general'];

// ================= LIST GROUPS =================
// @route   GET /api/community-portal/groups
// @query   page, limit, type, visibility, search, mine
router.get('/', optionalAuth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const { page, limit, offset } = getPagination(req);
    const { type, search, mine } = req.query;

    const conditions = ['g.is_active = TRUE'];
    const params = [];

    if (type) {
      conditions.push('g.group_type = ?');
      params.push(type);
    }

    if (search) {
      conditions.push('(g.name LIKE ? OR g.description LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    // Public groups are visible to everyone; private groups only to members / creator / moderators
    if (mine === 'true' && req.user) {
      conditions.push('gm.user_id = ? AND gm.status = "active"');
      params.push(req.user.id);
    } else if (!isCommunityModerator(req.user)) {
      if (req.user) {
        conditions.push('(g.visibility = "public" OR (gm.user_id = ? AND gm.status = "active") OR g.created_by = ?)');
        params.push(req.user.id, req.user.id);
      } else {
        conditions.push('g.visibility = "public"');
      }
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [groups] = await mysqlConnection.execute(
      `SELECT DISTINCT g.*, u.first_name, u.last_name
       FROM cp_groups g
       LEFT JOIN users u ON g.created_by = u.id
       LEFT JOIN cp_group_members gm ON gm.group_id = g.id
       ${whereClause}
       ORDER BY g.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await mysqlConnection.execute(
      `SELECT COUNT(DISTINCT g.id) AS total
       FROM cp_groups g
       LEFT JOIN cp_group_members gm ON gm.group_id = g.id
       ${whereClause}`,
      params
    );

    // Batch fetch active members array for all returned groups
    let membersByGroupId = {};
    if (groups.length > 0) {
      const groupIds = groups.map((g) => g.id);
      const placeholders = groupIds.map(() => '?').join(',');
      const [allMembers] = await mysqlConnection.execute(
        `SELECT gm.group_id, gm.user_id, gm.role, gm.status, gm.joined_at,
                u.first_name, u.last_name, u.email, u.avatar
         FROM cp_group_members gm
         JOIN users u ON gm.user_id = u.id
         WHERE gm.group_id IN (${placeholders}) AND gm.status = 'active'
         ORDER BY FIELD(gm.role, 'owner', 'moderator', 'member'), gm.joined_at ASC`,
        groupIds
      );

      for (const m of allMembers) {
        if (!membersByGroupId[m.group_id]) {
          membersByGroupId[m.group_id] = [];
        }
        membersByGroupId[m.group_id].push({
          id: m.user_id,
          user_id: m.user_id,
          name: `${m.first_name || ''} ${m.last_name || ''}`.trim() || m.email || 'Member',
          role: m.role,
          status: m.status,
          avatar: m.avatar,
          joined_at: m.joined_at,
        });
      }
    }

    const formatted = groups.map((g) => {
      const groupMembers = membersByGroupId[g.id] || [];
      const memberIds = groupMembers.map((m) => m.user_id);
      const isUserMember = Boolean(
        (req.user && memberIds.includes(req.user.id)) ||
        (req.user && String(g.created_by) === String(req.user.id))
      );
      const userMemberObj = req.user ? groupMembers.find((m) => m.user_id === req.user.id) : null;
      const userRole = userMemberObj ? userMemberObj.role : (req.user && String(g.created_by) === String(req.user.id) ? 'owner' : null);

      return {
        ...g,
        created_by_name: g.first_name ? `${g.first_name} ${g.last_name}`.trim() : null,
        members: groupMembers,
        member_ids: memberIds,
        member_count: groupMembers.length > 0 ? groupMembers.length : (g.member_count || 1),
        is_member: isUserMember,
        user_role: userRole,
      };
    });

    return successResponse(res, {
      groups: formatted,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    }, 'Groups retrieved successfully');
  } catch (error) {
    console.error('List groups error:', error);
    return errorResponse(res, 'Failed to retrieve groups', 500);
  }
});

// ================= GET SINGLE GROUP =================
// @route   GET /api/community-portal/groups/:id
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();
    const [groups] = await mysqlConnection.execute(
      `SELECT g.*, u.first_name, u.last_name
       FROM cp_groups g
       LEFT JOIN users u ON g.created_by = u.id
       WHERE g.id = ? AND g.is_active = TRUE`,
      [id]
    );

    if (groups.length === 0) return errorResponse(res, 'Group not found', 404);
    const group = groups[0];

    // Fetch members array for this single group
    const [members] = await mysqlConnection.execute(
      `SELECT gm.user_id, gm.role, gm.status, gm.joined_at,
              u.first_name, u.last_name, u.email, u.avatar
       FROM cp_group_members gm
       JOIN users u ON gm.user_id = u.id
       WHERE gm.group_id = ? AND gm.status = 'active'
       ORDER BY FIELD(gm.role, 'owner', 'moderator', 'member'), gm.joined_at ASC`,
      [id]
    );

    const formattedMembers = members.map((m) => ({
      id: m.user_id,
      user_id: m.user_id,
      name: `${m.first_name || ''} ${m.last_name || ''}`.trim() || m.email || 'Member',
      role: m.role,
      status: m.status,
      avatar: m.avatar,
      joined_at: m.joined_at,
    }));

    const memberIds = formattedMembers.map((m) => m.user_id);
    const isUserMember = Boolean(
      (req.user && memberIds.includes(req.user.id)) ||
      (req.user && String(group.created_by) === String(req.user.id))
    );

    const userMemberObj = req.user ? formattedMembers.find((m) => m.user_id === req.user.id) : null;
    const userRole = userMemberObj ? userMemberObj.role : (req.user && String(group.created_by) === String(req.user.id) ? 'owner' : null);

    if (group.visibility === 'private' && !isUserMember && !isCommunityModerator(req.user)) {
      return errorResponse(res, 'This is a private group. You must be a member to view it.', 403);
    }

    return successResponse(res, {
      group: {
        ...group,
        created_by_name: group.first_name ? `${group.first_name} ${group.last_name}`.trim() : null,
        members: formattedMembers,
        member_ids: memberIds,
        member_count: formattedMembers.length > 0 ? formattedMembers.length : (group.member_count || 1),
        is_member: isUserMember,
        user_role: userRole,
      },
      membership: userMemberObj || (isUserMember ? { role: userRole, status: 'active' } : null)
    }, 'Group retrieved successfully');
  } catch (error) {
    console.error('Get group error:', error);
    return errorResponse(res, 'Failed to retrieve group', 500);
  }
});

// ================= CREATE GROUP =================
// @route   POST /api/community-portal/groups
// @access  Private
router.post('/', auth, requireCommunityPermission('My Groups', 'x'), communityPortalUpload.single('cover_image'), async (req, res) => {
  try {
    const userRole = (req.user?.role || req.user?.user_type || '').toLowerCase();
    if (userRole === 'free_user') {
      return errorResponse(res, 'Free users are not allowed to create groups. Please upgrade your account.', 403);
    }

    const { name, description, visibility = 'public', group_type = 'general', diocese_id, parish_id } = req.body;

    if (!name || !name.trim()) return errorResponse(res, 'Group name is required', 400);
    if (!VALID_GROUP_TYPES.includes(group_type)) {
      return errorResponse(res, `Invalid group_type. Must be one of: ${VALID_GROUP_TYPES.join(', ')}`, 400);
    }
    if (!['public', 'private'].includes(visibility)) {
      return errorResponse(res, 'visibility must be "public" or "private"', 400);
    }

    const mysqlConnection = getMySQLConnection();
    const coverImage = req.file ? req.file.location : null;

    const [result] = await mysqlConnection.execute(
      `INSERT INTO cp_groups (name, description, visibility, group_type, cover_image, diocese_id, parish_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [name.trim(), description || null, visibility, group_type, coverImage, diocese_id || null, parish_id || null, req.user.id]
    );

    await mysqlConnection.execute(
      `INSERT INTO cp_group_members (group_id, user_id, role, status) VALUES (?, ?, 'owner', 'active')`,
      [result.insertId, req.user.id]
    );

    const [created] = await mysqlConnection.execute(`SELECT * FROM cp_groups WHERE id = ?`, [result.insertId]);

    return successResponse(res, { group: created[0] }, 'Group created successfully', 201);
  } catch (error) {
    console.error('Create group error:', error);
    return errorResponse(res, 'Failed to create group', 500);
  }
});

// ================= UPDATE GROUP =================
// @route   PUT /api/community-portal/groups/:id
// @access  Private (owner / moderator / admin)
router.put('/:id', auth, requireCommunityPermission('My Groups', 'x'), communityPortalUpload.single('cover_image'), async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();

    const [groups] = await mysqlConnection.execute(`SELECT * FROM cp_groups WHERE id = ?`, [id]);
    if (groups.length === 0) return errorResponse(res, 'Group not found', 404);

    const membership = await isActiveGroupMember(id, req.user.id);
    const canEdit = isCommunityModerator(req.user) || (membership && ['owner', 'moderator'].includes(membership.role));
    if (!canEdit) return errorResponse(res, 'Only the group owner, a moderator, or an Admin can update this group', 403);

    const { name, description, visibility } = req.body;
    const newCoverImage = req.file ? req.file.location : null;

    if (newCoverImage && groups[0].cover_image) {
      deleteFileFromS3(groups[0].cover_image).catch((e) => console.warn('Old group cover cleanup failed:', e.message));
    }

    await mysqlConnection.execute(
      `UPDATE cp_groups SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        visibility = COALESCE(?, visibility),
        cover_image = COALESCE(?, cover_image)
       WHERE id = ?`,
      [name || null, description !== undefined ? description : null, visibility || null, newCoverImage, id]
    );

    const [updated] = await mysqlConnection.execute(`SELECT * FROM cp_groups WHERE id = ?`, [id]);
    return successResponse(res, { group: updated[0] }, 'Group updated successfully');
  } catch (error) {
    console.error('Update group error:', error);
    return errorResponse(res, 'Failed to update group', 500);
  }
});

// ================= DELETE GROUP =================
// @route   DELETE /api/community-portal/groups/:id
// @access  Private (owner / admin)
router.delete('/:id', auth, requireCommunityPermission('My Groups', 'x'), async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();
    const [groups] = await mysqlConnection.execute(`SELECT * FROM cp_groups WHERE id = ?`, [id]);
    if (groups.length === 0) return errorResponse(res, 'Group not found', 404);

    const membership = await isActiveGroupMember(id, req.user.id);
    const canDelete = isCommunityModerator(req.user) || (membership && membership.role === 'owner');
    if (!canDelete) return errorResponse(res, 'Only the group owner or an Admin can delete this group', 403);

    await mysqlConnection.execute(`UPDATE cp_groups SET is_active = FALSE WHERE id = ?`, [id]);
    return successResponse(res, null, 'Group deleted successfully');
  } catch (error) {
    console.error('Delete group error:', error);
    return errorResponse(res, 'Failed to delete group', 500);
  }
});

// ================= JOIN GROUP =================
// @route   POST /api/community-portal/groups/:id/join
// @access  Private
router.post('/:id/join', auth, requireCommunityPermission('My Groups', 'x'), async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();
    const [groups] = await mysqlConnection.execute(`SELECT * FROM cp_groups WHERE id = ? AND is_active = TRUE`, [id]);
    if (groups.length === 0) return errorResponse(res, 'Group not found', 404);
    const group = groups[0];

    const [existing] = await mysqlConnection.execute(
      `SELECT * FROM cp_group_members WHERE group_id = ? AND user_id = ?`,
      [id, req.user.id]
    );

    if (existing.length > 0) {
      if (existing[0].status === 'active') return errorResponse(res, 'You are already a member of this group', 400);
      if (existing[0].status === 'banned') return errorResponse(res, 'You are banned from this group', 403);
      if (existing[0].status === 'pending') return errorResponse(res, 'Your join request is already pending approval', 400);
    }

    const status = group.visibility === 'public' ? 'active' : 'pending';

    if (existing.length > 0) {
      await mysqlConnection.execute(`UPDATE cp_group_members SET status = ? WHERE group_id = ? AND user_id = ?`, [status, id, req.user.id]);
    } else {
      await mysqlConnection.execute(
        `INSERT INTO cp_group_members (group_id, user_id, role, status) VALUES (?, ?, 'member', ?)`,
        [id, req.user.id, status]
      );
    }

    if (status === 'active') {
      await mysqlConnection.execute(`UPDATE cp_groups SET member_count = member_count + 1 WHERE id = ?`, [id]);
      emitToRoom(`group:${id}`, 'group_member_joined', { group_id: id, user_id: req.user.id });
    } else {
      // 🔔 IN-APP NOTIFICATION: Notify group owner on pending join request
      if (group.created_by && Number(group.created_by) !== Number(req.user.id)) {
        const actorName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || 'Someone';
        sendCommunityNotification({
          recipientId: group.created_by,
          actorUser: req.user,
          title: 'New Group Join Request',
          body: `${actorName} requested to join your group "${group.name}".`,
          metadata: {
            type: 'community_group_join_request',
            group_id: Number(id),
            group_name: group.name,
            actor_id: req.user.id,
            actor_name: actorName,
            actor_avatar: req.user.avatar || null,
            link: `/my-groups/${id}`
          }
        });
      }
    }

    return successResponse(res, { status }, status === 'active' ? 'Joined group successfully' : 'Join request submitted for approval');
  } catch (error) {
    console.error('Join group error:', error);
    return errorResponse(res, 'Failed to join group', 500);
  }
});

// ================= LEAVE GROUP =================
// @route   POST /api/community-portal/groups/:id/leave
// @access  Private
router.post('/:id/leave', auth, requireCommunityPermission('My Groups', 'x'), async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();

    const membership = await isActiveGroupMember(id, req.user.id);
    if (!membership) return errorResponse(res, 'You are not a member of this group', 400);
    if (membership.role === 'owner') {
      return errorResponse(res, 'Group owner cannot leave the group. Transfer ownership or delete the group instead.', 400);
    }

    await mysqlConnection.execute(`DELETE FROM cp_group_members WHERE group_id = ? AND user_id = ?`, [id, req.user.id]);
    await mysqlConnection.execute(`UPDATE cp_groups SET member_count = GREATEST(member_count - 1, 0) WHERE id = ?`, [id]);

    return successResponse(res, null, 'You have left the group');
  } catch (error) {
    console.error('Leave group error:', error);
    return errorResponse(res, 'Failed to leave group', 500);
  }
});

// ================= ADD / INVITE MEMBER TO GROUP =================
// @route   POST /api/community-portal/groups/:id/members
// @access  Private
router.post('/:id/members', auth, requireCommunityPermission('My Groups', 'x'), async (req, res) => {
  try {
    const { id } = req.params;
    const targetUserId = req.body.user_id || req.body.userId;
    const role = req.body.role || 'member';

    if (!targetUserId) {
      return errorResponse(res, 'user_id is required', 400);
    }

    const mysqlConnection = getMySQLConnection();
    const [groups] = await mysqlConnection.execute('SELECT * FROM cp_groups WHERE id = ? AND is_active = TRUE', [id]);
    if (groups.length === 0) return errorResponse(res, 'Group not found', 404);

    const [targetUser] = await mysqlConnection.execute('SELECT id, first_name, last_name, email FROM users WHERE id = ?', [targetUserId]);
    if (targetUser.length === 0) return errorResponse(res, 'User not found', 404);

    const [existing] = await mysqlConnection.execute(
      'SELECT * FROM cp_group_members WHERE group_id = ? AND user_id = ?',
      [id, targetUserId]
    );

    if (existing.length > 0) {
      if (existing[0].status === 'active') {
        return errorResponse(res, 'User is already a member of this group', 409);
      }
      if (existing[0].status === 'banned') {
        return errorResponse(res, 'This user is banned from this group', 403);
      }

      await mysqlConnection.execute(
        'UPDATE cp_group_members SET status = "active", role = ? WHERE group_id = ? AND user_id = ?',
        [role, id, targetUserId]
      );
    } else {
      await mysqlConnection.execute(
        'INSERT INTO cp_group_members (group_id, user_id, role, status) VALUES (?, ?, ?, "active")',
        [id, targetUserId, role]
      );
    }

    await mysqlConnection.execute(
      'UPDATE cp_groups SET member_count = (SELECT COUNT(*) FROM cp_group_members WHERE group_id = ? AND status = "active") WHERE id = ?',
      [id, id]
    );

    emitToUser(targetUserId, 'group_member_joined', { group_id: id, user_id: targetUserId });
    emitToRoom('group:' + id, 'group_member_joined', { group_id: id, user_id: targetUserId });

    // 🔔 IN-APP NOTIFICATION: Notify invited/added member
    if (Number(targetUserId) !== Number(req.user.id)) {
      const actorName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || 'Someone';
      const groupName = groups[0]?.name || 'a group';
      sendCommunityNotification({
        recipientId: targetUserId,
        actorUser: req.user,
        title: 'Group Invitation',
        body: `${actorName} added you to the group "${groupName}".`,
        metadata: {
          type: 'community_group_invite',
          group_id: Number(id),
          group_name: groupName,
          role,
          actor_id: req.user.id,
          actor_name: actorName,
          actor_avatar: req.user.avatar || null,
          link: `/my-groups/${id}`
        }
      });
    }

    return successResponse(res, { group_id: id, user_id: targetUserId, role }, 'Member added to group successfully', 201);
  } catch (error) {
    console.error('Add group member error:', error);
    return errorResponse(res, 'Failed to add member to group', 500);
  }
});

// ================= LIST GROUP MEMBERS =================
// @route   GET /api/community-portal/groups/:id/members
router.get('/:id/members', async (req, res) => {
  try {
    const { id } = req.params;
    const { status = 'active' } = req.query;
    const mysqlConnection = getMySQLConnection();

    const [groups] = await mysqlConnection.execute(`SELECT * FROM cp_groups WHERE id = ?`, [id]);
    if (groups.length === 0) return errorResponse(res, 'Group not found', 404);

    if (groups[0].visibility === 'private') {
      const membership = req.user ? await isActiveGroupMember(id, req.user.id) : null;
      if (!membership && !isCommunityModerator(req.user)) {
        return errorResponse(res, 'This is a private group. You must be a member to view its members.', 403);
      }
    }

    const [members] = await mysqlConnection.execute(
      `SELECT gm.id AS membership_id, gm.role, gm.status, gm.joined_at,
              u.id AS user_id, u.first_name, u.last_name, u.avatar, u.role AS platform_role
       FROM cp_group_members gm
       JOIN users u ON gm.user_id = u.id
       WHERE gm.group_id = ? AND gm.status = ?
       ORDER BY FIELD(gm.role, 'owner', 'moderator', 'member'), gm.joined_at ASC`,
      [id, status]
    );

    return successResponse(res, { members, total: members.length }, 'Group members retrieved successfully');
  } catch (error) {
    console.error('List group members error:', error);
    return errorResponse(res, 'Failed to retrieve group members', 500);
  }
});

// ================= UPDATE MEMBER ROLE (promote/demote) =================
// @route   PUT /api/community-portal/groups/:id/members/:userId
// @access  Private (owner / admin)
router.put('/:id/members/:userId', auth, async (req, res) => {
  try {
    const { id, userId } = req.params;
    const { role } = req.body;

    if (!['moderator', 'member'].includes(role)) {
      return errorResponse(res, 'role must be "moderator" or "member"', 400);
    }

    const mysqlConnection = getMySQLConnection();
    const membership = await isActiveGroupMember(id, req.user.id);
    const canManage = isCommunityModerator(req.user) || (membership && membership.role === 'owner');
    if (!canManage) return errorResponse(res, 'Only the group owner or an Admin can change member roles', 403);

    const [target] = await mysqlConnection.execute(
      `SELECT * FROM cp_group_members WHERE group_id = ? AND user_id = ? AND status = 'active'`,
      [id, userId]
    );
    if (target.length === 0) return errorResponse(res, 'Member not found in this group', 404);
    if (target[0].role === 'owner') return errorResponse(res, 'Cannot change the role of the group owner', 400);

    await mysqlConnection.execute(`UPDATE cp_group_members SET role = ? WHERE group_id = ? AND user_id = ?`, [role, id, userId]);
    return successResponse(res, null, `Member role updated to ${role}`);
  } catch (error) {
    console.error('Update member role error:', error);
    return errorResponse(res, 'Failed to update member role', 500);
  }
});

// ================= APPROVE PENDING JOIN REQUEST =================
// @route   POST /api/community-portal/groups/:id/members/:userId/approve
// @access  Private (owner / moderator / admin)
router.post('/:id/members/:userId/approve', auth, async (req, res) => {
  try {
    const { id, userId } = req.params;
    const mysqlConnection = getMySQLConnection();

    const membership = await isActiveGroupMember(id, req.user.id);
    const canManage = isCommunityModerator(req.user) || (membership && ['owner', 'moderator'].includes(membership.role));
    if (!canManage) return errorResponse(res, 'Only group owners/moderators or an Admin can approve join requests', 403);

    const [target] = await mysqlConnection.execute(
      `SELECT * FROM cp_group_members WHERE group_id = ? AND user_id = ? AND status = 'pending'`,
      [id, userId]
    );
    if (target.length === 0) return errorResponse(res, 'No pending join request found for this user', 404);

    await mysqlConnection.execute(`UPDATE cp_group_members SET status = 'active' WHERE group_id = ? AND user_id = ?`, [id, userId]);
    await mysqlConnection.execute(`UPDATE cp_groups SET member_count = member_count + 1 WHERE id = ?`, [id]);
    emitToUser(userId, 'group_join_approved', { group_id: id });
    emitToRoom(`group:${id}`, 'group_member_joined', { group_id: id, user_id: userId });

    // 🔔 IN-APP NOTIFICATION: Notify member that join request was approved
    if (Number(userId) !== Number(req.user.id)) {
      const [groupRows] = await mysqlConnection.execute('SELECT name FROM cp_groups WHERE id = ?', [id]);
      const groupName = groupRows.length ? groupRows[0].name : 'the group';
      const actorName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || 'Someone';

      sendCommunityNotification({
        recipientId: userId,
        actorUser: req.user,
        title: 'Group Join Request Approved',
        body: `Your request to join "${groupName}" was approved.`,
        metadata: {
          type: 'community_group_approved',
          group_id: Number(id),
          group_name: groupName,
          actor_id: req.user.id,
          actor_name: actorName,
          actor_avatar: req.user.avatar || null,
          link: `/my-groups/${id}`
        }
      });
    }

    return successResponse(res, null, 'Join request approved');
  } catch (error) {
    console.error('Approve join request error:', error);
    return errorResponse(res, 'Failed to approve join request', 500);
  }
});

// ================= REMOVE / REJECT / BAN MEMBER =================
// @route   DELETE /api/community-portal/groups/:id/members/:userId
// @query   ban=true to ban instead of just removing
// @access  Private (owner / moderator / admin)
router.delete('/:id/members/:userId', auth, async (req, res) => {
  try {
    const { id, userId } = req.params;
    const { ban } = req.query;
    const mysqlConnection = getMySQLConnection();

    const membership = await isActiveGroupMember(id, req.user.id);
    const isSelfLeaving = String(req.user.id) === String(userId);
    const canManage = isCommunityModerator(req.user) || (membership && ['owner', 'moderator'].includes(membership.role));
    if (!canManage && !isSelfLeaving) {
      return errorResponse(res, 'Only group owners/moderators or an Admin can remove members', 403);
    }

    const [target] = await mysqlConnection.execute(`SELECT * FROM cp_group_members WHERE group_id = ? AND user_id = ?`, [id, userId]);
    if (target.length === 0) return errorResponse(res, 'Member not found in this group', 404);
    if (target[0].role === 'owner') return errorResponse(res, 'Cannot remove the group owner', 400);

    if (ban === 'true' && canManage) {
      await mysqlConnection.execute(`UPDATE cp_group_members SET status = 'banned' WHERE group_id = ? AND user_id = ?`, [id, userId]);
    } else {
      await mysqlConnection.execute(`DELETE FROM cp_group_members WHERE group_id = ? AND user_id = ?`, [id, userId]);
    }

    if (target[0].status === 'active') {
      await mysqlConnection.execute(`UPDATE cp_groups SET member_count = GREATEST(member_count - 1, 0) WHERE id = ?`, [id]);
    }

    return successResponse(res, null, ban === 'true' ? 'Member banned from group' : 'Member removed from group');
  } catch (error) {
    console.error('Remove group member error:', error);
    return errorResponse(res, 'Failed to remove group member', 500);
  }
});

module.exports = router;
