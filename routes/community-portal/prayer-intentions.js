const express = require('express');
const { auth } = require('../../middleware/auth');
const { successResponse, errorResponse } = require('../../utils/response');
const {
  getMySQLConnection,
  isCommunityModerator,
  getPagination,
  isActiveGroupMember,
  requireCommunityPermission,
  sendCommunityNotification,
  notifyMentionedUsers
} = require('./helpers');
const { emitToRoom } = require('./socket');

const router = express.Router();

// ================= LIST PRAYER INTENTIONS =================
// @route   GET /api/community-portal/prayer-intentions
// @query   page, limit, status (ongoing|answered|closed)
router.get('/', async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const { page, limit, offset } = getPagination(req);
    const { status } = req.query;

    const conditions = ['pi.is_hidden = FALSE'];
    const params = [];

    if (status) {
      conditions.push('pi.status = ?');
      params.push(status);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const [intentions] = await mysqlConnection.execute(
      `SELECT pi.*, u.first_name, u.last_name, u.avatar
       FROM cp_prayer_intentions pi
       JOIN users u ON pi.author_id = u.id
       ${whereClause}
       ORDER BY pi.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await mysqlConnection.execute(
      `SELECT COUNT(*) AS total FROM cp_prayer_intentions pi ${whereClause}`,
      params
    );

    let prayedIds = new Set();
    if (req.user && intentions.length > 0) {
      const ids = intentions.map((i) => i.id);
      const [prays] = await mysqlConnection.query(
        `SELECT target_id FROM cp_reactions WHERE target_type = 'prayer' AND reaction_type = 'pray' AND user_id = ? AND target_id IN (?)`,
        [req.user.id, ids]
      );
      prayedIds = new Set(prays.map((p) => p.target_id));
    }

    const formatted = intentions.map((i) => ({
      ...i,
      author: i.is_anonymous ? null : { id: i.author_id, full_name: `${i.first_name} ${i.last_name}`.trim(), avatar: i.avatar },
      prayed_by_me: prayedIds.has(i.id)
    }));

    return successResponse(res, {
      prayer_intentions: formatted,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    }, 'Prayer intentions retrieved successfully');
  } catch (error) {
    console.error('List prayer intentions error:', error);
    return errorResponse(res, 'Failed to retrieve prayer intentions', 500);
  }
});

// ================= GET SINGLE PRAYER INTENTION =================
// @route   GET /api/community-portal/prayer-intentions/:id
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();
    const [intentions] = await mysqlConnection.execute(
      `SELECT pi.*, u.first_name, u.last_name, u.avatar
       FROM cp_prayer_intentions pi
       JOIN users u ON pi.author_id = u.id
       WHERE pi.id = ?`,
      [id]
    );

    if (intentions.length === 0) return errorResponse(res, 'Prayer intention not found', 404);
    const intention = intentions[0];

    let prayedByMe = false;
    if (req.user) {
      const [prays] = await mysqlConnection.execute(
        `SELECT id FROM cp_reactions WHERE target_type = 'prayer' AND target_id = ? AND user_id = ? AND reaction_type = 'pray'`,
        [id, req.user.id]
      );
      prayedByMe = prays.length > 0;
    }

    return successResponse(res, {
      prayer_intention: {
        ...intention,
        author: intention.is_anonymous ? null : { id: intention.author_id, full_name: `${intention.first_name} ${intention.last_name}`.trim(), avatar: intention.avatar },
        prayed_by_me: prayedByMe
      }
    }, 'Prayer intention retrieved successfully');
  } catch (error) {
    console.error('Get prayer intention error:', error);
    return errorResponse(res, 'Failed to retrieve prayer intention', 500);
  }
});

// ================= POST A PRAYER REQUEST =================
// @route   POST /api/community-portal/prayer-intentions
// @access  Private
router.post('/', auth, requireCommunityPermission('Prayer', 'x'), async (req, res) => {
  try {
    const { title, content, is_anonymous, group_id } = req.body;
    if (!content || !content.trim()) return errorResponse(res, 'Prayer request content is required', 400);

    const mysqlConnection = getMySQLConnection();

    if (group_id) {
      const membership = await isActiveGroupMember(group_id, req.user.id);
      if (!membership && !isCommunityModerator(req.user)) {
        return errorResponse(res, 'You must be a member of this group to post a prayer request in it', 403);
      }
    }

    const [result] = await mysqlConnection.execute(
      `INSERT INTO cp_prayer_intentions (author_id, group_id, title, content, is_anonymous)
       VALUES (?, ?, ?, ?, ?)`,
      [req.user.id, group_id || null, title || null, content.trim(), !!is_anonymous]
    );

    const [created] = await mysqlConnection.execute(`SELECT * FROM cp_prayer_intentions WHERE id = ?`, [result.insertId]);
    const responsePayload = {
      ...created[0],
      author: created[0].is_anonymous ? null : { id: req.user.id, full_name: `${req.user.first_name} ${req.user.last_name}`.trim() }
    };
    emitToRoom('prayer:global', 'new_prayer_request', { prayer_intention: responsePayload });

    return successResponse(res, { prayer_intention: created[0] }, 'Prayer request posted successfully', 201);
  } catch (error) {
    console.error('Create prayer intention error:', error);
    return errorResponse(res, 'Failed to post prayer request', 500);
  }
});

// ================= UPDATE STATUS (ongoing / answered / closed) =================
// @route   PUT /api/community-portal/prayer-intentions/:id
// @access  Private (author or Admin)
router.put('/:id', auth, requireCommunityPermission('Prayer', 'x'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status, title, content } = req.body;
    const mysqlConnection = getMySQLConnection();

    const [intentions] = await mysqlConnection.execute(`SELECT * FROM cp_prayer_intentions WHERE id = ?`, [id]);
    if (intentions.length === 0) return errorResponse(res, 'Prayer intention not found', 404);

    if (intentions[0].author_id !== req.user.id && !isCommunityModerator(req.user)) {
      return errorResponse(res, 'You can only update your own prayer requests', 403);
    }

    if (status && !['ongoing', 'answered', 'closed'].includes(status)) {
      return errorResponse(res, 'status must be one of: ongoing, answered, closed', 400);
    }

    await mysqlConnection.execute(
      `UPDATE cp_prayer_intentions SET
        status = COALESCE(?, status),
        title = COALESCE(?, title),
        content = COALESCE(?, content)
       WHERE id = ?`,
      [status || null, title || null, content && content.trim() ? content.trim() : null, id]
    );

    const [updated] = await mysqlConnection.execute(`SELECT * FROM cp_prayer_intentions WHERE id = ?`, [id]);
    return successResponse(res, { prayer_intention: updated[0] }, 'Prayer intention updated successfully');
  } catch (error) {
    console.error('Update prayer intention error:', error);
    return errorResponse(res, 'Failed to update prayer intention', 500);
  }
});

// ================= DELETE PRAYER INTENTION =================
// @route   DELETE /api/community-portal/prayer-intentions/:id
// @access  Private (author or Admin)
router.delete('/:id', auth, requireCommunityPermission('Prayer', 'x'), async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();
    const [intentions] = await mysqlConnection.execute(`SELECT * FROM cp_prayer_intentions WHERE id = ?`, [id]);
    if (intentions.length === 0) return errorResponse(res, 'Prayer intention not found', 404);

    if (intentions[0].author_id !== req.user.id && !isCommunityModerator(req.user)) {
      return errorResponse(res, 'You do not have permission to delete this prayer request', 403);
    }

    await mysqlConnection.execute(`UPDATE cp_prayer_intentions SET status = 'closed', deleted_at = NOW() WHERE id = ?`, [id]);
    return successResponse(res, null, 'Prayer request deleted successfully');
  } catch (error) {
    console.error('Delete prayer intention error:', error);
    return errorResponse(res, 'Failed to delete prayer request', 500);
  }
});

// ================= "PRAYING FOR THIS" TOGGLE =================
// @route   POST /api/community-portal/prayer-intentions/:id/pray
// @access  Private
router.post('/:id/pray', auth, requireCommunityPermission('Prayer', 'x'), async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();

    const [intentions] = await mysqlConnection.execute(`SELECT id FROM cp_prayer_intentions WHERE id = ?`, [id]);
    if (intentions.length === 0) return errorResponse(res, 'Prayer intention not found', 404);

    const [existing] = await mysqlConnection.execute(
      `SELECT id FROM cp_reactions WHERE target_type = 'prayer' AND target_id = ? AND user_id = ? AND reaction_type = 'pray'`,
      [id, req.user.id]
    );

    if (existing.length > 0) {
      await mysqlConnection.execute(`DELETE FROM cp_reactions WHERE id = ?`, [existing[0].id]);
      await mysqlConnection.execute(`UPDATE cp_prayer_intentions SET pray_count = GREATEST(pray_count - 1, 0) WHERE id = ?`, [id]);
      const [[updated]] = await mysqlConnection.query(`SELECT pray_count FROM cp_prayer_intentions WHERE id = ?`, [id]);
      emitToRoom('prayer:global', 'prayer_count_updated', { prayer_id: id, pray_count: updated.pray_count });
      return successResponse(res, { praying: false }, 'Removed from your prayers');
    }

    await mysqlConnection.execute(
      `INSERT INTO cp_reactions (target_type, target_id, user_id, reaction_type) VALUES ('prayer', ?, ?, 'pray')`,
      [id, req.user.id]
    );
    await mysqlConnection.execute(`UPDATE cp_prayer_intentions SET pray_count = pray_count + 1 WHERE id = ?`, [id]);
    const [[updatedPrayer]] = await mysqlConnection.query(`SELECT pray_count FROM cp_prayer_intentions WHERE id = ?`, [id]);
    emitToRoom('prayer:global', 'prayer_count_updated', { prayer_id: id, pray_count: updatedPrayer.pray_count });

    return successResponse(res, { praying: true }, 'You are now praying for this intention');
  } catch (error) {
    console.error('Pray toggle error:', error);
    return errorResponse(res, 'Failed to update prayer status', 500);
  }
});

// ================= LIST RESPONSES (community support messages) =================
// @route   GET /api/community-portal/prayer-intentions/:id/responses
router.get('/:id/responses', async (req, res) => {
  try {
    const { id } = req.params;
    const { page, limit, offset } = getPagination(req, 20, 100);
    const mysqlConnection = getMySQLConnection();

    const [responses] = await mysqlConnection.execute(
      `SELECT c.*, u.first_name, u.last_name, u.avatar
       FROM cp_comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.parent_type = 'prayer' AND c.parent_id = ? AND c.status = 'active' AND c.is_hidden = FALSE
       ORDER BY c.created_at ASC
       LIMIT ? OFFSET ?`,
      [id, limit, offset]
    );

    const formatted = responses.map((r) => ({
      ...r,
      author: { id: r.user_id, full_name: `${r.first_name} ${r.last_name}`.trim(), avatar: r.avatar }
    }));

    return successResponse(res, { responses: formatted, page, limit }, 'Responses retrieved successfully');
  } catch (error) {
    console.error('List prayer responses error:', error);
    return errorResponse(res, 'Failed to retrieve responses', 500);
  }
});

// ================= ADD A RESPONSE / SUPPORT MESSAGE =================
// @route   POST /api/community-portal/prayer-intentions/:id/responses
// @access  Private
router.post('/:id/responses', auth, requireCommunityPermission('Prayer', 'x'), async (req, res) => {
  try {
    const { id } = req.params;
    const { content, parent_comment_id } = req.body;
    if (!content || !content.trim()) return errorResponse(res, 'Response content is required', 400);

    const mysqlConnection = getMySQLConnection();
    const [intentions] = await mysqlConnection.execute(
      `SELECT id, author_id, title, content FROM cp_prayer_intentions WHERE id = ?`,
      [id]
    );
    if (intentions.length === 0) return errorResponse(res, 'Prayer intention not found', 404);
    const prayer = intentions[0];

    const [result] = await mysqlConnection.execute(
        `INSERT INTO cp_comments (parent_type, parent_id, parent_comment_id, user_id, content) VALUES ('prayer', ?, ?, ?, ?)`,
      [id, parent_comment_id || null, req.user.id, content.trim()]
    );

    await mysqlConnection.execute(`UPDATE cp_prayer_intentions SET response_count = response_count + 1 WHERE id = ?`, [id]);

    const [created] = await mysqlConnection.execute(
      `SELECT c.*, u.first_name, u.last_name, u.avatar, u.role
       FROM cp_comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.id = ?`,
      [result.insertId]
    );
    const createdRow = created[0] || {};
    const formattedComment = {
      ...createdRow,
      author: {
        id: createdRow.user_id,
        full_name: `${createdRow.first_name || ''} ${createdRow.last_name || ''}`.trim() || 'User',
        avatar: createdRow.avatar,
        role: createdRow.role
      }
    };
    emitToRoom('prayer:global', 'new_prayer_response', { prayer_id: id, response: formattedComment });

    // 🔔 IN-APP NOTIFICATIONS: Encouragement / Reply triggers
    const actorName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || 'Someone';
    const trimmedContent = content.trim();
    const snippet = trimmedContent.length > 60 ? trimmedContent.substring(0, 57) + '...' : trimmedContent;

    let parentComment = null;
    if (parent_comment_id) {
      // 1. Reply to encouragement -> notify parent response owner
      const [parentComments] = await mysqlConnection.execute(
        `SELECT id, user_id, content FROM cp_comments WHERE id = ? AND status = 'active'`,
        [parent_comment_id]
      );
      if (parentComments.length > 0) {
        parentComment = parentComments[0];
        if (parentComment.user_id && Number(parentComment.user_id) !== Number(req.user.id)) {
          sendCommunityNotification({
            recipientId: parentComment.user_id,
            actorUser: req.user,
            title: 'New Reply',
            body: `${actorName} replied to your message on a prayer request: "${snippet}"`,
            metadata: {
              type: 'community_prayer_reply',
              prayer_id: prayer.id,
              comment_id: result.insertId,
              parent_comment_id: parentComment.id,
              actor_id: req.user.id,
              actor_name: actorName,
              actor_avatar: req.user.avatar || null,
              link: '/prayer-intentions'
            }
          });
        }

        // Also notify prayer author if different from replier and parent comment owner
        if (prayer.author_id && Number(prayer.author_id) !== Number(req.user.id) && Number(prayer.author_id) !== Number(parentComment.user_id)) {
          sendCommunityNotification({
            recipientId: prayer.author_id,
            actorUser: req.user,
            title: 'New Encouragement',
            body: `${actorName} replied to an encouragement on your prayer request: "${snippet}"`,
            metadata: {
              type: 'community_prayer_response',
              prayer_id: prayer.id,
              comment_id: result.insertId,
              parent_comment_id: parentComment.id,
              actor_id: req.user.id,
              actor_name: actorName,
              actor_avatar: req.user.avatar || null,
              link: '/prayer-intentions'
            }
          });
        }
      }
    } else {
      // Top-level encouragement -> notify prayer author
      if (prayer.author_id && Number(prayer.author_id) !== Number(req.user.id)) {
        sendCommunityNotification({
          recipientId: prayer.author_id,
          actorUser: req.user,
          title: 'New Encouragement',
          body: `${actorName} offered encouragement on your prayer request: "${snippet}"`,
          metadata: {
            type: 'community_prayer_response',
            prayer_id: prayer.id,
            comment_id: result.insertId,
            actor_id: req.user.id,
            actor_name: actorName,
            actor_avatar: req.user.avatar || null,
            link: '/prayer-intentions'
          }
        });
      }
    }

    // 🔔 Notify mentioned users in prayer encouragement / reply
    let responseMentioned = req.body.mentioned_user_ids;
    if (typeof responseMentioned === 'string') {
      try { responseMentioned = JSON.parse(responseMentioned); } catch (_) { responseMentioned = []; }
    }
    if (Array.isArray(responseMentioned) && responseMentioned.length > 0) {
      const alreadyNotified = new Set([Number(req.user.id)]);
      if (parentComment && parentComment.user_id) {
        alreadyNotified.add(Number(parentComment.user_id));
      }
      if (prayer.author_id) {
        alreadyNotified.add(Number(prayer.author_id));
      }
      const filtered = responseMentioned.filter((id) => !alreadyNotified.has(Number(id)));
      await notifyMentionedUsers({
        mentionedUserIds: filtered,
        actorUser: req.user,
        contextType: parent_comment_id ? 'reply' : 'prayer encouragement',
        snippet,
        link: '/prayer-intentions',
        extraMeta: {
          prayer_id: prayer.id,
          comment_id: result.insertId,
          parent_comment_id: parent_comment_id || null
        }
      });
    }

    return successResponse(res, { response: formattedComment }, 'Response added successfully', 201);
  } catch (error) {
    console.error('Add prayer response error:', error);
    return errorResponse(res, 'Failed to add response', 500);
  }
});

// ================= DELETE A RESPONSE =================
// @route   DELETE /api/community-portal/prayer-intentions/responses/:responseId
// @access  Private (author or Moderator)
router.delete('/responses/:responseId', auth, requireCommunityPermission('Prayer', 'x'), async (req, res) => {
  try {
    const { responseId } = req.params;
    const mysqlConnection = getMySQLConnection();
    const [comments] = await mysqlConnection.execute(
      `SELECT * FROM cp_comments WHERE id = ? AND parent_type = 'prayer'`,
      [responseId]
    );
    if (comments.length === 0) return errorResponse(res, 'Response not found', 404);
    const comment = comments[0];

    let canDelete = String(comment.user_id) === String(req.user.id) || isCommunityModerator(req.user);
    if (!canDelete) {
      return errorResponse(res, 'You do not have permission to delete this response', 403);
    }

    await mysqlConnection.execute(`UPDATE cp_comments SET status = 'removed', deleted_at = NOW() WHERE id = ?`, [responseId]);
    await mysqlConnection.execute(`UPDATE cp_prayer_intentions SET response_count = GREATEST(response_count - 1, 0) WHERE id = ?`, [comment.parent_id]);

    try {
      await mysqlConnection.execute(
        `UPDATE notifications SET is_active = FALSE WHERE (metadata LIKE ? OR metadata LIKE ?)`,
        [`%"comment_id":${responseId},%`, `%"comment_id":${responseId}}%`]
      );
    } catch (e) {
      console.warn('Deactivate prayer response notification error:', e.message);
    }

    return successResponse(res, null, 'Response deleted successfully');
  } catch (error) {
    console.error('Delete prayer response error:', error);
    return errorResponse(res, 'Failed to delete response', 500);
  }
});

module.exports = router;
