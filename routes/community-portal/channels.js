const express = require('express');
const slugify = require('slugify');
const { auth } = require('../../middleware/auth');
const { successResponse, errorResponse } = require('../../utils/response');
const {
  getMySQLConnection,
  isCommunityModerator,
  safeJsonParse,
  canAccessChannel,
  sendCommunityNotification
} = require('./helpers');

const router = express.Router();

// ================= LIST CHANNELS (visible to current user) =================
// @route   GET /api/community-portal/channels
// @access  Private
router.get('/', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const [channels] = await mysqlConnection.execute(
      `SELECT c.*, u.first_name, u.last_name, g.name AS group_name,
              (SELECT COUNT(*) FROM cp_discussion_threads t WHERE t.channel_id = c.id) AS message_count
       FROM cp_channels c
       LEFT JOIN users u ON c.created_by = u.id
       LEFT JOIN cp_groups g ON c.group_id = g.id
       WHERE c.is_active = TRUE
       ORDER BY c.created_at ASC, c.id ASC`
    );

    const visible = [];
    for (const channel of channels) {
      const isReadOnly = Boolean(channel.is_read_only);

      // Check if user is explicit member or creator or admin
      const [memberRows] = await mysqlConnection.execute(
        `SELECT * FROM cp_channel_members WHERE channel_id = ? AND user_id = ?`,
        [channel.id, req.user.id]
      );
      const hasMemberRow = memberRows.length > 0;
      const isCreator = String(channel.created_by) === String(req.user.id);
      const isAdmin = isCommunityModerator(req.user);
      const memberStatus = hasMemberRow ? (memberRows[0].status || 'active') : null;

      // Active member if creator, admin, or has active row
      const isMember = isCreator || isAdmin || (hasMemberRow && memberStatus === 'active');
      const isInvited = hasMemberRow && memberStatus === 'invited';

      const isPublic = channel.channel_type === 'global' || !channel.channel_type || channel.channel_type !== 'private';

      if (isPublic || isMember || isInvited) {
        visible.push({
          ...channel,
          is_member: isMember,
          is_invited: isInvited,
          is_read_only: isReadOnly,
          allowed_roles: safeJsonParse(channel.allowed_roles, []),
          created_by_name: channel.first_name ? `${channel.first_name} ${channel.last_name}`.trim() : null
        });
      }
    }

    return successResponse(res, { channels: visible, total: visible.length }, 'Channels retrieved successfully');
  } catch (error) {
    console.error('List channels error:', error);
    return errorResponse(res, 'Failed to retrieve channels', 500);
  }
});

// ================= GET SINGLE CHANNEL =================
// @route   GET /api/community-portal/channels/:id
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();
    const [channels] = await mysqlConnection.execute(`SELECT * FROM cp_channels WHERE id = ?`, [id]);

    if (channels.length === 0) return errorResponse(res, 'Channel not found', 404);

    const channel = channels[0];
    const canAccess = await canAccessChannel(channel, req.user);
    if (!canAccess) return errorResponse(res, 'You do not have access to this channel', 403);

    return successResponse(res, {
      channel: { ...channel, allowed_roles: safeJsonParse(channel.allowed_roles, []) }
    }, 'Channel retrieved successfully');
  } catch (error) {
    console.error('Get channel error:', error);
    return errorResponse(res, 'Failed to retrieve channel', 500);
  }
});

// ================= CREATE CHANNEL =================
// @route   POST /api/community-portal/channels
// @access  Private (Admin / SL Team)
router.post('/', auth, async (req, res) => {
  try {
    if (!isCommunityModerator(req.user)) {
      return errorResponse(res, 'Only Admin / SL Team can create channels', 403);
    }

    const { name, description, channel_type = 'global', allowed_roles = [], group_id, diocese_id, is_read_only = false } = req.body;

    if (!name || !name.trim()) return errorResponse(res, 'Channel name is required', 400);

    const validTypes = ['global', 'private', 'composer', 'parish', 'diocesan', 'group'];
    if (!validTypes.includes(channel_type)) {
      return errorResponse(res, `Invalid channel_type. Must be one of: ${validTypes.join(', ')}`, 400);
    }

    const mysqlConnection = getMySQLConnection();
    const baseSlug = slugify(name, { lower: true, strict: true });
    let slug = baseSlug;
    let attempt = 1;
    while (true) {
      const [existing] = await mysqlConnection.execute(`SELECT id FROM cp_channels WHERE slug = ?`, [slug]);
      if (existing.length === 0) break;
      attempt += 1;
      slug = `${baseSlug}-${attempt}`;
    }

    const [result] = await mysqlConnection.execute(
      `INSERT INTO cp_channels (name, slug, description, channel_type, allowed_roles, group_id, diocese_id, is_read_only, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name.trim(),
        slug,
        description || null,
        channel_type,
        JSON.stringify(allowed_roles || []),
        group_id || null,
        diocese_id || null,
        is_read_only ? 1 : 0,
        req.user.id
      ]
    );

    const [created] = await mysqlConnection.execute(`SELECT * FROM cp_channels WHERE id = ?`, [result.insertId]);

    try {
      await mysqlConnection.execute(
        `INSERT INTO cp_channel_members (channel_id, user_id, role) VALUES (?, ?, 'admin')
         ON DUPLICATE KEY UPDATE role = 'admin'`,
        [result.insertId, req.user.id]
      );
    } catch (e) {}

    return successResponse(res, {
      channel: { ...created[0], allowed_roles: safeJsonParse(created[0].allowed_roles, []) }
    }, 'Channel created successfully', 201);
  } catch (error) {
    console.error('Create channel error:', error);
    return errorResponse(res, 'Failed to create channel', 500);
  }
});

// ================= UPDATE CHANNEL =================
// @route   PUT /api/community-portal/channels/:id
// @access  Private (Admin / Creator)
router.put('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, channel_type, allowed_roles, is_read_only, is_active } = req.body;
    const mysqlConnection = getMySQLConnection();

    const [channels] = await mysqlConnection.execute(`SELECT * FROM cp_channels WHERE id = ?`, [id]);
    if (channels.length === 0) return errorResponse(res, 'Channel not found', 404);

    const channel = channels[0];
    const isCreator = String(channel.created_by) === String(req.user.id);
    const isAdmin = isCommunityModerator(req.user);

    if (!isCreator && !isAdmin) {
      return errorResponse(res, 'Only Admin or Channel Creator can update this channel', 403);
    }

    await mysqlConnection.execute(
      `UPDATE cp_channels SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        channel_type = COALESCE(?, channel_type),
        allowed_roles = COALESCE(?, allowed_roles),
        is_read_only = COALESCE(?, is_read_only),
        is_active = COALESCE(?, is_active)
       WHERE id = ?`,
      [
        name ? name.trim() : null,
        description !== undefined ? description : null,
        channel_type || null,
        allowed_roles ? JSON.stringify(allowed_roles) : null,
        is_read_only !== undefined ? (is_read_only ? 1 : 0) : null,
        is_active !== undefined ? (is_active ? 1 : 0) : null,
        id
      ]
    );

    const [updated] = await mysqlConnection.execute(`SELECT * FROM cp_channels WHERE id = ?`, [id]);
    return successResponse(res, {
      channel: { ...updated[0], allowed_roles: safeJsonParse(updated[0].allowed_roles, []) }
    }, 'Channel updated successfully');
  } catch (error) {
    console.error('Update channel error:', error);
    return errorResponse(res, 'Failed to update channel', 500);
  }
});

// ================= DELETE CHANNEL =================
// @route   DELETE /api/community-portal/channels/:id
// @access  Private (Admin / Creator)
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();
    const [channels] = await mysqlConnection.execute(`SELECT * FROM cp_channels WHERE id = ?`, [id]);
    if (channels.length === 0) return errorResponse(res, 'Channel not found', 404);

    const channel = channels[0];
    const isCreator = String(channel.created_by) === String(req.user.id);
    const isAdmin = isCommunityModerator(req.user);

    if (!isCreator && !isAdmin) {
      return errorResponse(res, 'Only Admin or Channel Creator can delete this channel', 403);
    }

    await mysqlConnection.execute(`UPDATE cp_channels SET is_active = FALSE WHERE id = ?`, [id]);
    await mysqlConnection.execute(`DELETE FROM cp_channel_members WHERE channel_id = ?`, [id]);

    return successResponse(res, null, 'Channel deleted successfully');
  } catch (error) {
    console.error('Delete channel error:', error);
    return errorResponse(res, 'Failed to delete channel', 500);
  }
});

// ================= FETCH USERS TO INVITE TO CHANNEL =================
// @route   GET /api/community-portal/channels/:id/users-to-invite
// @access  Private
router.get('/:id/users-to-invite', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { search = '' } = req.query;
    const mysqlConnection = getMySQLConnection();

    const [channels] = await mysqlConnection.execute(`SELECT id FROM cp_channels WHERE id = ?`, [id]);
    if (channels.length === 0) return errorResponse(res, 'Channel not found', 404);

    let query = `
      SELECT u.id, u.first_name, u.last_name, u.email, u.avatar, u.role
      FROM users u
      WHERE u.is_active = TRUE AND u.id != ?
    `;
    const params = [req.user.id];

    if (search && search.trim()) {
      query += ` AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ?)`;
      const term = `%${search.trim()}%`;
      params.push(term, term, term);
    }

    query += ` ORDER BY u.first_name ASC LIMIT 50`;

    const [usersList] = await mysqlConnection.execute(query, params);

    // Get existing member user_ids for this channel
    const [members] = await mysqlConnection.execute(
      `SELECT user_id FROM cp_channel_members WHERE channel_id = ?`,
      [id]
    );
    const memberIds = new Set(members.map((m) => String(m.user_id)));

    const formatted = usersList.map((u) => ({
      ...u,
      full_name: `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email,
      is_member: memberIds.has(String(u.id))
    }));

    return successResponse(res, { users: formatted }, 'Users fetched successfully');
  } catch (err) {
    console.error('Fetch users to invite error:', err);
    return errorResponse(res, 'Failed to fetch users', 500);
  }
});

// ================= JOIN CHANNEL (Self-join public or accept invite on private) =================
// @route   POST /api/community-portal/channels/:id/join
// @access  Private
router.post('/:id/join', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();
    const [channels] = await mysqlConnection.execute(`SELECT * FROM cp_channels WHERE id = ? AND is_active = TRUE`, [id]);
    if (channels.length === 0) return errorResponse(res, 'Channel not found', 404);

    const channel = channels[0];
    const isPublic = channel.channel_type === 'global' || !channel.channel_type || channel.channel_type !== 'private';

    const [memberRows] = await mysqlConnection.execute(
      `SELECT * FROM cp_channel_members WHERE channel_id = ? AND user_id = ?`,
      [id, req.user.id]
    );
    const hasMemberRow = memberRows.length > 0;
    const isInvited = hasMemberRow && memberRows[0].status === 'invited';
    const isCreatorOrAdmin = String(channel.created_by) === String(req.user.id) || isCommunityModerator(req.user);

    // Private channels can ONLY be joined if user was invited by owner/admin!
    if (!isPublic && !isInvited && !isCreatorOrAdmin) {
      return errorResponse(res, 'This is a private channel. You must be invited by an owner to join.', 403);
    }

    await mysqlConnection.execute(
      `INSERT INTO cp_channel_members (channel_id, user_id, role, status) VALUES (?, ?, 'member', 'active')
       ON DUPLICATE KEY UPDATE status = 'active'`,
      [id, req.user.id]
    );

    return successResponse(res, { channel_id: Number(id), user_id: req.user.id, status: 'active' }, 'Joined channel successfully');
  } catch (error) {
    console.error('Join channel error:', error);
    return errorResponse(res, 'Failed to join channel', 500);
  }
});

// ================= ADD MEMBER TO CHANNEL (Send Invite) =================
// @route   POST /api/community-portal/channels/:id/members
// @access  Private
router.post('/:id/members', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id, role = 'member' } = req.body;
    const targetUserId = user_id || req.user.id;

    const mysqlConnection = getMySQLConnection();
    const [channels] = await mysqlConnection.execute(`SELECT * FROM cp_channels WHERE id = ?`, [id]);
    if (channels.length === 0) return errorResponse(res, 'Channel not found', 404);

    const isSelf = String(req.user.id) === String(targetUserId);
    const channel = channels[0];
    const isPublic = channel.channel_type === 'global' || !channel.channel_type || channel.channel_type !== 'private';

    const canAccess = await canAccessChannel(channel, req.user);
    if (!canAccess && !isCommunityModerator(req.user)) {
      return errorResponse(res, 'You do not have access to invite users to this channel', 403);
    }

    // Status: if owner/admin invites someone to a private channel, status = 'invited' so they must accept & join!
    const memberStatus = (!isPublic && !isSelf) ? 'invited' : 'active';

    await mysqlConnection.execute(
      `INSERT INTO cp_channel_members (channel_id, user_id, role, status) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE role = VALUES(role), status = VALUES(status)`,
      [id, targetUserId, role, memberStatus]
    );

    // 🔔 IN-APP NOTIFICATION: Notify invited user
    if (!isSelf) {
      const actorName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || 'Someone';
      sendCommunityNotification({
        recipientId: targetUserId,
        actorUser: req.user,
        title: 'Channel Invitation',
        body: `${actorName} invited you to the channel "${channel.name}".`,
        metadata: {
          type: 'community_channel_invite',
          channel_id: Number(id),
          channel_name: channel.name,
          role,
          actor_id: req.user.id,
          actor_name: actorName,
          actor_avatar: req.user.avatar || null,
          link: `/channels?channelId=${id}`
        }
      });
    }

    return successResponse(res, { status: memberStatus }, !isSelf ? 'Invite sent to user successfully' : 'Joined channel successfully');
  } catch (error) {
    console.error('Add channel member error:', error);
    return errorResponse(res, 'Failed to add channel member', 500);
  }
});

// ================= FETCH CHANNEL MEMBERS =================
// @route   GET /api/community-portal/channels/:id/members
// @access  Private
router.get('/:id/members', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();

    const [channels] = await mysqlConnection.execute(`SELECT * FROM cp_channels WHERE id = ?`, [id]);
    if (channels.length === 0) return errorResponse(res, 'Channel not found', 404);

    const channel = channels[0];
    const canAccess = await canAccessChannel(channel, req.user);
    if (!canAccess && !isCommunityModerator(req.user)) {
      return errorResponse(res, 'You do not have access to this channel', 403);
    }

    const memberMap = new Map();

    // 1. Direct channel members
    try {
      const [members] = await mysqlConnection.execute(
        `SELECT cm.id as member_table_id, cm.role as member_role, cm.created_at as joined_at,
                u.id, u.first_name, u.last_name, u.email, u.avatar, u.role
         FROM cp_channel_members cm
         JOIN users u ON cm.user_id = u.id
         WHERE cm.channel_id = ?
         ORDER BY u.first_name ASC`,
        [id]
      );
      members.forEach((m) => {
        memberMap.set(String(m.id), {
          ...m,
          full_name: `${m.first_name || ''} ${m.last_name || ''}`.trim() || m.email,
          is_creator: String(m.id) === String(channel.created_by)
        });
      });
    } catch (e) {
      console.error('Error fetching direct channel members:', e);
    }

    // 2. Creator
    if (channel.created_by && !memberMap.has(String(channel.created_by))) {
      try {
        const [creatorRows] = await mysqlConnection.execute(
          `SELECT id, first_name, last_name, email, avatar, role FROM users WHERE id = ?`,
          [channel.created_by]
        );
        if (creatorRows.length > 0) {
          const creator = creatorRows[0];
          memberMap.set(String(creator.id), {
            ...creator,
            member_role: 'admin',
            is_creator: true,
            full_name: `${creator.first_name || ''} ${creator.last_name || ''}`.trim() || creator.email
          });
        }
      } catch (e) {
        console.error('Error fetching creator user:', e);
      }
    }

    // 3. Group Members if linked
    if (channel.group_id) {
      try {
        const [groupMemberRows] = await mysqlConnection.execute(
          `SELECT gm.role as member_role, u.id, u.first_name, u.last_name, u.email, u.avatar, u.role
           FROM cp_group_members gm
           JOIN users u ON gm.user_id = u.id
           WHERE gm.group_id = ? AND gm.status = 'active'`,
          [channel.group_id]
        );
        groupMemberRows.forEach((m) => {
          if (!memberMap.has(String(m.id))) {
            memberMap.set(String(m.id), {
              ...m,
              full_name: `${m.first_name || ''} ${m.last_name || ''}`.trim() || m.email,
              is_creator: String(m.id) === String(channel.created_by)
            });
          }
        });
      } catch (e) {
        console.error('Error fetching group members:', e);
      }
    }

    // 4. Authors who posted messages in this channel
    try {
      const [threadAuthors] = await mysqlConnection.execute(
        `SELECT DISTINCT u.id, u.first_name, u.last_name, u.email, u.avatar, u.role
         FROM cp_discussion_threads t
         JOIN users u ON t.author_id = u.id
         WHERE t.channel_id = ?`,
        [id]
      );
      threadAuthors.forEach((m) => {
        if (!memberMap.has(String(m.id))) {
          memberMap.set(String(m.id), {
            ...m,
            member_role: 'member',
            full_name: `${m.first_name || ''} ${m.last_name || ''}`.trim() || m.email,
            is_creator: String(m.id) === String(channel.created_by)
          });
        }
      });
    } catch (e) {
      console.error('Error fetching thread authors:', e);
    }

    // 5. Requesting user if not present
    if (req.user && req.user.id && !memberMap.has(String(req.user.id))) {
      memberMap.set(String(req.user.id), {
        id: req.user.id,
        first_name: req.user.first_name,
        last_name: req.user.last_name,
        email: req.user.email,
        avatar: req.user.avatar,
        role: req.user.role,
        member_role: isCommunityModerator(req.user) ? 'admin' : 'member',
        is_creator: String(req.user.id) === String(channel.created_by),
        full_name: `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || req.user.email
      });
    }

    const resultList = Array.from(memberMap.values());

    return successResponse(res, { members: resultList, channel }, 'Channel members fetched successfully');
  } catch (err) {
    console.error('Fetch channel members error:', err);
    return errorResponse(res, 'Failed to fetch channel members', 500);
  }
});

// ================= REMOVE MEMBER FROM CHANNEL (or LEAVE) =================
// @route   DELETE /api/community-portal/channels/:id/members/:userId
// @access  Private
router.delete('/:id/members/:userId', auth, async (req, res) => {
  try {
    const { id, userId } = req.params;
    const mysqlConnection = getMySQLConnection();

    const [channels] = await mysqlConnection.execute(`SELECT * FROM cp_channels WHERE id = ?`, [id]);
    if (channels.length === 0) return errorResponse(res, 'Channel not found', 404);

    const channel = channels[0];
    const isSelf = String(req.user.id) === String(userId);
    const isCreator = String(channel.created_by) === String(req.user.id);
    const isAdmin = isCommunityModerator(req.user);

    if (!isSelf && !isCreator && !isAdmin) {
      return errorResponse(res, 'Only Admin, Channel Creator, or the member themselves can perform this action', 403);
    }

    await mysqlConnection.execute(`DELETE FROM cp_channel_members WHERE channel_id = ? AND user_id = ?`, [id, userId]);

    return successResponse(res, null, isSelf ? 'Left channel successfully' : 'Member removed from channel successfully');
  } catch (error) {
    console.error('Remove channel member error:', error);
    return errorResponse(res, 'Failed to remove channel member', 500);
  }
});

// ================= LEAVE CHANNEL =================
// @route   POST /api/community-portal/channels/:id/leave
// @access  Private
router.post('/:id/leave', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();

    await mysqlConnection.execute(`DELETE FROM cp_channel_members WHERE channel_id = ? AND user_id = ?`, [id, req.user.id]);

    return successResponse(res, null, 'Left channel successfully');
  } catch (error) {
    console.error('Leave channel error:', error);
    return errorResponse(res, 'Failed to leave channel', 500);
  }
});

// ================= GET OR CREATE CONVERSATION FOR CHANNEL =================
// @route   GET /api/community-portal/channels/:id/conversation
// @access  Private
router.get('/:id/conversation', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();

    const [channels] = await mysqlConnection.execute(`SELECT * FROM cp_channels WHERE id = ? AND is_active = TRUE`, [id]);
    if (channels.length === 0) return errorResponse(res, 'Channel not found', 404);

    const channel = channels[0];
    const canAccess = await canAccessChannel(channel, req.user);
    if (!canAccess) return errorResponse(res, 'You do not have access to this channel', 403);

    // Look for existing conversation for this channel
    let [convs] = await mysqlConnection.execute(
      `SELECT * FROM cp_conversations WHERE channel_id = ? LIMIT 1`,
      [id]
    );

    let conversationId;
    if (convs.length > 0) {
      conversationId = convs[0].id;
    } else {
      const [result] = await mysqlConnection.execute(
        `INSERT INTO cp_conversations (type, channel_id, title, created_by) VALUES ('channel', ?, ?, ?)`,
        [id, `# ${channel.name}`, req.user.id]
      );
      conversationId = result.insertId;
      const [newConv] = await mysqlConnection.execute(`SELECT * FROM cp_conversations WHERE id = ?`, [conversationId]);
      convs = newConv;
    }

    // Check if current user is an active member or invited user
    const [memberRows] = await mysqlConnection.execute(
      `SELECT * FROM cp_channel_members WHERE channel_id = ? AND user_id = ?`,
      [id, req.user.id]
    );
    const hasMemberRow = memberRows.length > 0;
    const memberStatus = hasMemberRow ? (memberRows[0].status || 'active') : null;
    const isCreatorOrAdmin = String(channel.created_by) === String(req.user.id) || isCommunityModerator(req.user);

    const isMember = isCreatorOrAdmin || (hasMemberRow && memberStatus === 'active');
    const isInvited = hasMemberRow && memberStatus === 'invited';

    return successResponse(res, { conversation: convs[0], channel, is_member: isMember, is_invited: isInvited }, 'Channel conversation retrieved successfully');
  } catch (err) {
    console.error('Get channel conversation error:', err);
    return errorResponse(res, 'Failed to get channel conversation', 500);
  }
});

module.exports = router;
