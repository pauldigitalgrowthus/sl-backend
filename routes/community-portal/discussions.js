const express = require('express');
const { auth } = require('../../middleware/auth');
const { communityPortalUpload } = require('../../config/s3');
const { successResponse, errorResponse } = require('../../utils/response');
const {
  getMySQLConnection,
  isCommunityModerator,
  getPagination,
  safeJsonParse,
  isActiveGroupMember,
  canAccessChannel,
  sendCommunityNotification,
  notifyMentionedUsers,
  requireCommunityPermission
} = require('./helpers');
const { emitToRoom, contentScopeRoom } = require('./socket');

const router = express.Router();

// ================= LIST DISCUSSION THREADS =================
// @route   GET /api/community-portal/discussions
// @query   page, limit, channel_id, group_id, category, sort=latest|popular|unanswered
router.get('/', async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const { page, limit, offset } = getPagination(req);
    const { channel_id: rawChannelId, group_id: rawGroupId, category, sort = 'latest' } = req.query;
    const channel_id = rawChannelId && rawChannelId !== '[object Object]' && rawChannelId !== 'undefined' && rawChannelId !== 'null' ? rawChannelId : null;
    const group_id = rawGroupId && rawGroupId !== '[object Object]' && rawGroupId !== 'undefined' && rawGroupId !== 'null' ? rawGroupId : null;

    const conditions = [`t.status = 'active'`, `t.is_hidden = FALSE`];
    const params = [];

    if (channel_id) {
      conditions.push('t.channel_id = ?');
      params.push(channel_id);
    } else {
      conditions.push('t.channel_id IS NULL');
    }

    if (group_id) {
      const [groups] = await mysqlConnection.execute(`SELECT visibility FROM cp_groups WHERE id = ?`, [group_id]);
      if (groups.length === 0) return errorResponse(res, 'Group not found', 404);
      if (groups[0].visibility === 'private') {
        const membership = req.user ? await isActiveGroupMember(group_id, req.user.id) : null;
        if (!membership && !isCommunityModerator(req.user)) {
          return errorResponse(res, 'This is a private group. Join to view its discussions.', 403);
        }
      }
      conditions.push('t.group_id = ?');
      params.push(group_id);
    } else if (!channel_id) {
      conditions.push(`(t.group_id IS NULL OR EXISTS (SELECT 1 FROM cp_groups gg WHERE gg.id = t.group_id AND gg.visibility = 'public'))`);
    }

    if (category) {
      conditions.push('t.category = ?');
      params.push(category);
    }

    if (sort === 'unanswered') {
      conditions.push('t.reply_count = 0');
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const orderClause = sort === 'popular'
      ? 'ORDER BY t.is_pinned DESC, t.reply_count DESC, t.view_count DESC'
      : 'ORDER BY t.is_pinned DESC, t.last_activity_at DESC';

    const [threads] = await mysqlConnection.execute(
      `SELECT t.*, u.first_name, u.last_name, u.avatar, u.role AS author_role
       FROM cp_discussion_threads t
       JOIN users u ON t.author_id = u.id
       ${whereClause}
       ${orderClause}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await mysqlConnection.execute(
      `SELECT COUNT(*) AS total FROM cp_discussion_threads t ${whereClause}`,
      params
    );

    const formatted = threads.map((t) => ({
      ...t,
      images: safeJsonParse(t.images, []),
      author: { id: t.author_id, full_name: `${t.first_name} ${t.last_name}`.trim(), avatar: t.avatar, role: t.author_role }
    }));

    return successResponse(res, {
      threads: formatted,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    }, 'Discussion threads retrieved successfully');
  } catch (error) {
    console.error('List discussions error:', error);
    return errorResponse(res, 'Failed to retrieve discussion threads', 500);
  }
});

// ================= GET SINGLE THREAD (+ unique view count) =================
// @route   GET /api/community-portal/discussions/:id
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();

    const [threads] = await mysqlConnection.execute(
      `SELECT t.*, u.first_name, u.last_name, u.avatar, u.role AS author_role
       FROM cp_discussion_threads t
       JOIN users u ON t.author_id = u.id
       WHERE t.id = ? AND t.status = 'active'`,
      [id]
    );

    if (threads.length === 0) return errorResponse(res, 'Discussion thread not found', 404);
    const thread = threads[0];

    if (thread.group_id) {
      const [groups] = await mysqlConnection.execute(`SELECT visibility FROM cp_groups WHERE id = ?`, [thread.group_id]);
      if (groups.length > 0 && groups[0].visibility === 'private') {
        const membership = req.user ? await isActiveGroupMember(thread.group_id, req.user.id) : null;
        if (!membership && !isCommunityModerator(req.user)) {
          return errorResponse(res, 'This discussion belongs to a private group', 403);
        }
      }
    }

    return successResponse(res, {
      thread: {
        ...thread,
        images: safeJsonParse(thread.images, []),
        author: { id: thread.author_id, full_name: `${thread.first_name} ${thread.last_name}`.trim(), avatar: thread.avatar, role: thread.author_role }
      }
    }, 'Discussion thread retrieved successfully');
  } catch (error) {
    console.error('Get discussion thread error:', error);
    return errorResponse(res, 'Failed to retrieve discussion thread', 500);
  }
});

// ================= INCREMENT UNIQUE VIEW COUNT =================
// @route   POST /api/community-portal/discussions/:id/view
// @access  Private
router.post('/:id/view', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Ensure table exists
    await mysqlConnection.execute(`
      CREATE TABLE IF NOT EXISTS cp_thread_views (
        id INT AUTO_INCREMENT PRIMARY KEY,
        thread_id INT NOT NULL,
        user_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_thread_user (thread_id, user_id),
        FOREIGN KEY (thread_id) REFERENCES cp_discussion_threads(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Insert view if not already recorded for this user
    const [insertResult] = await mysqlConnection.execute(
      `INSERT IGNORE INTO cp_thread_views (thread_id, user_id) VALUES (?, ?)`,
      [id, userId]
    );

    // If a new view record was added, increment total view count
    if (insertResult.affectedRows > 0) {
      await mysqlConnection.execute(
        `UPDATE cp_discussion_threads SET view_count = view_count + 1 WHERE id = ?`,
        [id]
      );
    }

    const [rows] = await mysqlConnection.execute(
      `SELECT view_count FROM cp_discussion_threads WHERE id = ?`,
      [id]
    );

    const view_count = rows.length > 0 ? rows[0].view_count : 0;
    return successResponse(res, { view_count, is_new_view: insertResult.affectedRows > 0 }, 'View count processed successfully');
  } catch (error) {
    console.error('Increment view error:', error);
    return errorResponse(res, 'Failed to process view count', 500);
  }
});

// ================= CREATE THREAD =================
// @route   POST /api/community-portal/discussions
// @access  Private
router.post('/', auth, requireCommunityPermission('Discussions', 'x'), communityPortalUpload.array('images', 6), async (req, res) => {
  try {
    const { title, body, category, channel_id, group_id } = req.body;

    if (!title || !title.trim()) return errorResponse(res, 'Thread title is required', 400);
    if (!body || !body.trim()) return errorResponse(res, 'Thread body is required', 400);

    const mysqlConnection = getMySQLConnection();

    if (channel_id) {
      const [channels] = await mysqlConnection.execute(`SELECT * FROM cp_channels WHERE id = ? AND is_active = TRUE`, [channel_id]);
      if (channels.length === 0) return errorResponse(res, 'Channel not found', 404);
      const ch = channels[0];
      const canAccess = await canAccessChannel(ch, req.user);
      if (!canAccess) return errorResponse(res, 'You do not have access to post in this channel', 403);

      if (ch.is_read_only) {
        const isCreator = String(ch.created_by) === String(req.user.id);
        const isAdmin = isCommunityModerator(req.user);
        if (!isCreator && !isAdmin) {
          return errorResponse(res, 'This channel is read-only. Only admins can post messages here.', 403);
        }
      }
    }

    if (group_id) {
      const membership = await isActiveGroupMember(group_id, req.user.id);
      if (!membership && !isCommunityModerator(req.user)) {
        return errorResponse(res, 'You must be a member of this group to start a discussion in it', 403);
      }
    }

    const images = (req.files || []).map((f) => f.location);

    const [result] = await mysqlConnection.execute(
      `INSERT INTO cp_discussion_threads (author_id, channel_id, group_id, title, body, images, category)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, channel_id || null, group_id || null, title.trim(), body.trim(), images.length ? JSON.stringify(images) : null, category || null]
    );

    if (channel_id) {
      try {
        await mysqlConnection.execute(
          `INSERT INTO cp_channel_members (channel_id, user_id, role) VALUES (?, ?, 'member')
           ON DUPLICATE KEY UPDATE channel_id = channel_id`,
          [channel_id, req.user.id]
        );
      } catch (e) {}
    }

    const [created] = await mysqlConnection.execute(`SELECT * FROM cp_discussion_threads WHERE id = ?`, [result.insertId]);
    const formattedThread = { ...created[0], images: safeJsonParse(created[0].images, []) };
    const room = contentScopeRoom(formattedThread, 'feed:global');
    emitToRoom(room, 'new_thread', { thread: formattedThread });
    emitToRoom(room, 'new_discussion', { thread: formattedThread, channel_id: formattedThread.channel_id });
    if (formattedThread.channel_id) {
      emitToRoom('feed:global', 'new_channel_message', { channel_id: formattedThread.channel_id, thread: formattedThread });
    }

    return successResponse(res, {
      thread: formattedThread
    }, 'Discussion thread created successfully', 201);
  } catch (error) {
    console.error('Create discussion thread error:', error);
    return errorResponse(res, 'Failed to create discussion thread', 500);
  }
});

// ================= EDIT THREAD =================
// @route   PUT /api/community-portal/discussions/:id
// @access  Private (author or moderator)
router.put('/:id', auth, requireCommunityPermission('Discussions', 'x'), async (req, res) => {
  try {
    const { id } = req.params;
    const { title, body, category, channel_id, group_id } = req.body;
    const mysqlConnection = getMySQLConnection();

    const [threads] = await mysqlConnection.execute(`SELECT * FROM cp_discussion_threads WHERE id = ? AND status = 'active'`, [id]);
    if (threads.length === 0) return errorResponse(res, 'Discussion thread not found', 404);
    
    const canEdit = threads[0].author_id === req.user.id || isCommunityModerator(req.user);
    if (!canEdit) return errorResponse(res, 'You do not have permission to edit this discussion thread', 403);
    if (threads[0].is_locked) return errorResponse(res, 'This thread is locked and cannot be edited', 403);

    await mysqlConnection.execute(
      `UPDATE cp_discussion_threads SET 
        title = COALESCE(?, title), 
        body = COALESCE(?, body), 
        category = COALESCE(?, category),
        channel_id = COALESCE(?, channel_id),
        group_id = COALESCE(?, group_id)
       WHERE id = ?`,
      [
        title && title.trim() ? title.trim() : null, 
        body && body.trim() ? body.trim() : null, 
        category || null,
        channel_id !== undefined ? (channel_id ? Number(channel_id) : null) : null,
        group_id !== undefined ? (group_id ? Number(group_id) : null) : null,
        id
      ]
    );

    const [updated] = await mysqlConnection.execute(`SELECT * FROM cp_discussion_threads WHERE id = ?`, [id]);
    return successResponse(res, { thread: { ...updated[0], images: safeJsonParse(updated[0].images, []) } }, 'Discussion thread updated successfully');
  } catch (error) {
    console.error('Edit discussion thread error:', error);
    return errorResponse(res, 'Failed to edit discussion thread', 500);
  }
});

// ================= DELETE THREAD =================
// @route   DELETE /api/community-portal/discussions/:id
// @access  Private (author, group moderator, or Admin)
router.delete('/:id', auth, requireCommunityPermission('Discussions', 'x'), async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();
    const [threads] = await mysqlConnection.execute(`SELECT * FROM cp_discussion_threads WHERE id = ?`, [id]);
    if (threads.length === 0) return errorResponse(res, 'Discussion thread not found', 404);
    const thread = threads[0];

    let canDelete = thread.author_id === req.user.id || isCommunityModerator(req.user);
    if (!canDelete && thread.group_id) {
      const membership = await isActiveGroupMember(thread.group_id, req.user.id);
      canDelete = !!(membership && ['owner', 'moderator'].includes(membership.role));
    }
    if (!canDelete) return errorResponse(res, 'You do not have permission to delete this discussion thread', 403);

    await mysqlConnection.execute(`UPDATE cp_discussion_threads SET status = 'removed', deleted_at = NOW() WHERE id = ?`, [id]);
    return successResponse(res, null, 'Discussion thread deleted successfully');
  } catch (error) {
    console.error('Delete discussion thread error:', error);
    return errorResponse(res, 'Failed to delete discussion thread', 500);
  }
});

// ================= PIN / UNPIN THREAD =================
// @route   POST /api/community-portal/discussions/:id/pin
// @access  Private (Admin / SL Team / group moderator)
router.post('/:id/pin', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();
    const [threads] = await mysqlConnection.execute(`SELECT * FROM cp_discussion_threads WHERE id = ?`, [id]);
    if (threads.length === 0) return errorResponse(res, 'Discussion thread not found', 404);
    const thread = threads[0];

    let canPin = isCommunityModerator(req.user);
    if (!canPin && thread.group_id) {
      const membership = await isActiveGroupMember(thread.group_id, req.user.id);
      canPin = !!(membership && ['owner', 'moderator'].includes(membership.role));
    }
    if (!canPin) return errorResponse(res, 'You do not have permission to pin this discussion thread', 403);

    await mysqlConnection.execute(`UPDATE cp_discussion_threads SET is_pinned = NOT is_pinned WHERE id = ?`, [id]);
    const [updated] = await mysqlConnection.execute(`SELECT is_pinned, channel_id, group_id FROM cp_discussion_threads WHERE id = ?`, [id]);
    emitToRoom(contentScopeRoom(updated[0], 'feed:global'), 'thread_pinned', { thread_id: id, is_pinned: !!updated[0].is_pinned });
    return successResponse(res, { is_pinned: !!updated[0].is_pinned }, 'Thread pin status updated');
  } catch (error) {
    console.error('Pin discussion thread error:', error);
    return errorResponse(res, 'Failed to update pin status', 500);
  }
});

// ================= LOCK / UNLOCK THREAD =================
// @route   POST /api/community-portal/discussions/:id/lock
// @access  Private (Admin / SL Team / group moderator)
router.post('/:id/lock', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();
    const [threads] = await mysqlConnection.execute(`SELECT * FROM cp_discussion_threads WHERE id = ?`, [id]);
    if (threads.length === 0) return errorResponse(res, 'Discussion thread not found', 404);
    const thread = threads[0];

    let canLock = isCommunityModerator(req.user);
    if (!canLock && thread.group_id) {
      const membership = await isActiveGroupMember(thread.group_id, req.user.id);
      canLock = !!(membership && ['owner', 'moderator'].includes(membership.role));
    }
    if (!canLock) return errorResponse(res, 'You do not have permission to lock this discussion thread', 403);

    await mysqlConnection.execute(`UPDATE cp_discussion_threads SET is_locked = NOT is_locked WHERE id = ?`, [id]);
    const [updated] = await mysqlConnection.execute(`SELECT is_locked, channel_id, group_id FROM cp_discussion_threads WHERE id = ?`, [id]);
    emitToRoom(contentScopeRoom(updated[0], 'feed:global'), 'thread_locked', { thread_id: id, is_locked: !!updated[0].is_locked });
    return successResponse(res, { is_locked: !!updated[0].is_locked }, 'Thread lock status updated');
  } catch (error) {
    console.error('Lock discussion thread error:', error);
    return errorResponse(res, 'Failed to update lock status', 500);
  }
});

// ================= LIST REPLIES =================
// @route   GET /api/community-portal/discussions/:id/replies
router.get('/:id/replies', async (req, res) => {
  try {
    const { id } = req.params;
    const { page, limit, offset } = getPagination(req, 20, 100);
    const mysqlConnection = getMySQLConnection();

    const [replies] = await mysqlConnection.execute(
      `SELECT c.*, u.first_name, u.last_name, u.avatar
       FROM cp_comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.parent_type = 'thread' AND c.parent_id = ? AND c.status = 'active' AND c.is_hidden = FALSE
       ORDER BY c.created_at ASC
       LIMIT ? OFFSET ?`,
      [id, limit, offset]
    );

    const formatted = replies.map((r) => ({
      ...r,
      images: safeJsonParse(r.images, []),
      author: { id: r.user_id, full_name: `${r.first_name} ${r.last_name}`.trim(), avatar: r.avatar }
    }));

    return successResponse(res, { replies: formatted, page, limit }, 'Replies retrieved successfully');
  } catch (error) {
    console.error('List replies error:', error);
    return errorResponse(res, 'Failed to retrieve replies', 500);
  }
});

// ================= ADD REPLY =================
// @route   POST /api/community-portal/discussions/:id/replies
// @access  Private
router.post('/:id/replies', auth, requireCommunityPermission('Discussions', 'x'), communityPortalUpload.array('images', 4), async (req, res) => {
  try {
    const { id } = req.params;
    const { content, parent_reply_id } = req.body;

    if (!content || !content.trim()) return errorResponse(res, 'Reply content is required', 400);

    const mysqlConnection = getMySQLConnection();
    const [threads] = await mysqlConnection.execute(`SELECT * FROM cp_discussion_threads WHERE id = ? AND status = 'active'`, [id]);
    if (threads.length === 0) return errorResponse(res, 'Discussion thread not found', 404);
    if (threads[0].is_locked) return errorResponse(res, 'This thread is locked and no longer accepting replies', 403);

    const images = (req.files || []).map((f) => f.location);

    const [result] = await mysqlConnection.execute(
      `INSERT INTO cp_comments (parent_type, parent_id, parent_comment_id, user_id, content, images)
       VALUES ('thread', ?, ?, ?, ?, ?)`,
      [id, parent_reply_id || null, req.user.id, content.trim(), images.length ? JSON.stringify(images) : null]
    );

    await mysqlConnection.execute(
      `UPDATE cp_discussion_threads SET reply_count = reply_count + 1, last_activity_at = NOW() WHERE id = ?`,
      [id]
    );

    const [created] = await mysqlConnection.execute(
      `SELECT c.*, u.first_name, u.last_name, u.avatar, u.role
       FROM cp_comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.id = ?`,
      [result.insertId]
    );
    const createdRow = created[0] || {};
    const formattedReply = {
      ...createdRow,
      images: safeJsonParse(createdRow.images, []),
      author: {
        id: createdRow.user_id,
        full_name: `${createdRow.first_name || ''} ${createdRow.last_name || ''}`.trim() || 'User',
        avatar: createdRow.avatar,
        role: createdRow.role
      }
    };
    const [[parentThread]] = await mysqlConnection.query(`SELECT id, channel_id, group_id FROM cp_discussion_threads WHERE id = ?`, [id]);
    emitToRoom(contentScopeRoom(parentThread, 'feed:global'), 'new_reply', { thread_id: id, reply: formattedReply });

    // 🔔 IN-APP NOTIFICATIONS: Discussion Reply triggers
    const actorName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || 'Someone';
    const trimmedContent = content.trim();
    const snippet = trimmedContent.length > 60 ? trimmedContent.substring(0, 57) + '...' : trimmedContent;
    const thread = threads[0];

    if (parent_reply_id) {
      const [parentReplies] = await mysqlConnection.execute(
        `SELECT id, user_id, content FROM cp_comments WHERE id = ? AND status = 'active'`,
        [parent_reply_id]
      );
      if (parentReplies.length > 0) {
        const parentReply = parentReplies[0];
        if (parentReply.user_id && Number(parentReply.user_id) !== Number(req.user.id)) {
          sendCommunityNotification({
            recipientId: parentReply.user_id,
            actorUser: req.user,
            title: 'New Reply',
            body: `${actorName} replied to your comment: "${snippet}"`,
            metadata: {
              type: 'community_comment_reply',
              thread_id: id,
              reply_id: result.insertId,
              parent_reply_id: parentReply.id,
              actor_id: req.user.id,
              actor_name: actorName,
              actor_avatar: req.user.avatar || null,
              link: `/discussions?threadId=${id}`
            }
          });
        }

        if (thread.author_id && Number(thread.author_id) !== Number(req.user.id) && Number(thread.author_id) !== Number(parentReply.user_id)) {
          sendCommunityNotification({
            recipientId: thread.author_id,
            actorUser: req.user,
            title: 'New Reply',
            body: `${actorName} replied to your discussion: "${snippet}"`,
            metadata: {
              type: 'community_discussion_reply',
              thread_id: id,
              reply_id: result.insertId,
              parent_reply_id: parentReply.id,
              actor_id: req.user.id,
              actor_name: actorName,
              actor_avatar: req.user.avatar || null,
              link: `/discussions?threadId=${id}`
            }
          });
        }
      }
    } else {
      if (thread.author_id && Number(thread.author_id) !== Number(req.user.id)) {
        sendCommunityNotification({
          recipientId: thread.author_id,
          actorUser: req.user,
          title: 'New Reply',
          body: `${actorName} replied to your discussion: "${snippet}"`,
          metadata: {
            type: 'community_discussion_reply',
            thread_id: id,
            reply_id: result.insertId,
            actor_id: req.user.id,
            actor_name: actorName,
            actor_avatar: req.user.avatar || null,
            link: `/discussions?threadId=${id}`
          }
        });
      }
    }

    
    // Notify mentioned users in discussion reply
    let replyMentioned = req.body.mentioned_user_ids;
    if (typeof replyMentioned === 'string') {
      try { replyMentioned = JSON.parse(replyMentioned); } catch (_) { replyMentioned = []; }
    }
    if (Array.isArray(replyMentioned) && replyMentioned.length > 0) {
      const alreadyNotified = new Set([Number(req.user.id)]);
      if (parent_reply_id && parentReplies?.length > 0 && parentReplies[0].user_id) {
        alreadyNotified.add(Number(parentReplies[0].user_id));
      }
      if (thread.author_id) {
        alreadyNotified.add(Number(thread.author_id));
      }
      const filtered = replyMentioned.filter((id) => !alreadyNotified.has(Number(id)));
      await notifyMentionedUsers({
        mentionedUserIds: filtered,
        actorUser: req.user,
        contextType: 'discussion reply',
        snippet,
        link: `/discussions?threadId=${id}`,
        extraMeta: {
          thread_id: id,
          reply_id: result.insertId,
          parent_reply_id: parent_reply_id || null
        }
      });
    }

    return successResponse(res, { reply: formattedReply }, 'Reply added successfully', 201);
  } catch (error) {
    console.error('Add reply error:', error);
    return errorResponse(res, 'Failed to add reply', 500);
  }
});

// ================= EDIT REPLY =================
// @route   PUT /api/community-portal/discussions/replies/:replyId
// @access  Private (author only)
router.put('/replies/:replyId', auth, requireCommunityPermission('Discussions', 'x'), async (req, res) => {
  try {
    const { replyId } = req.params;
    const { content } = req.body;
    if (!content || !content.trim()) return errorResponse(res, 'Reply content is required', 400);

    const mysqlConnection = getMySQLConnection();
    const [replies] = await mysqlConnection.execute(`SELECT * FROM cp_comments WHERE id = ? AND parent_type = 'thread' AND status = 'active'`, [replyId]);
    if (replies.length === 0) return errorResponse(res, 'Reply not found', 404);
    if (replies[0].user_id !== req.user.id) return errorResponse(res, 'You can only edit your own replies', 403);

    await mysqlConnection.execute(`UPDATE cp_comments SET content = ? WHERE id = ?`, [content.trim(), replyId]);
    return successResponse(res, null, 'Reply updated successfully');
  } catch (error) {
    console.error('Edit reply error:', error);
    return errorResponse(res, 'Failed to edit reply', 500);
  }
});

// ================= DELETE REPLY =================
// @route   DELETE /api/community-portal/discussions/replies/:replyId
// @access  Private (author or Admin)
router.delete('/replies/:replyId', auth, requireCommunityPermission('Discussions', 'x'), async (req, res) => {
  try {
    const { replyId } = req.params;
    const mysqlConnection = getMySQLConnection();
    const [replies] = await mysqlConnection.execute(`SELECT * FROM cp_comments WHERE id = ? AND parent_type = 'thread'`, [replyId]);
    if (replies.length === 0) return errorResponse(res, 'Reply not found', 404);
    const reply = replies[0];

    if (reply.user_id !== req.user.id && !isCommunityModerator(req.user)) {
      return errorResponse(res, 'You do not have permission to delete this reply', 403);
    }

    await mysqlConnection.execute(`UPDATE cp_comments SET status = 'removed', deleted_at = NOW() WHERE id = ?`, [replyId]);
    await mysqlConnection.execute(`UPDATE cp_discussion_threads SET reply_count = GREATEST(reply_count - 1, 0) WHERE id = ?`, [reply.parent_id]);

    try {
      await mysqlConnection.execute(
        `UPDATE notifications SET is_active = FALSE WHERE (metadata LIKE ? OR metadata LIKE ?)`,
        [`%"comment_id":${replyId},%`, `%"comment_id":${replyId}}%`]
      );
    } catch (e) {
      console.warn('Deactivate reply notification error:', e.message);
    }

    return successResponse(res, null, 'Reply deleted successfully');
  } catch (error) {
    console.error('Delete reply error:', error);
    return errorResponse(res, 'Failed to delete reply', 500);
  }
});

module.exports = router;
