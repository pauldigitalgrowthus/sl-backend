const express = require('express');
const { auth } = require('../../middleware/auth');
const { communityPortalUpload } = require('../../config/s3');
const { successResponse, errorResponse } = require('../../utils/response');
const { getMySQLConnection, getPagination, safeJsonParse } = require('./helpers');
const { emitToRoom, emitToUser } = require('./socket');

const router = express.Router();

/**
 * Ensure the requesting user is an active participant of the conversation.
 */
const requireParticipant = async (mysqlConnection, conversationId, userId) => {
  const [rows] = await mysqlConnection.execute(
    `SELECT * FROM cp_conversation_participants WHERE conversation_id = ? AND user_id = ? AND is_active = TRUE`,
    [conversationId, userId]
  );
  if (rows.length > 0) return rows[0];

  const [convs] = await mysqlConnection.execute(
    `SELECT * FROM cp_conversations WHERE id = ? AND (type = 'channel' OR channel_id IS NOT NULL)`,
    [conversationId]
  );
  if (convs.length > 0) {
    await mysqlConnection.execute(
      `INSERT INTO cp_conversation_participants (conversation_id, user_id, role) VALUES (?, ?, 'member')
       ON DUPLICATE KEY UPDATE is_active = TRUE`,
      [conversationId, userId]
    );
    return { conversation_id: conversationId, user_id: userId, role: 'member', is_active: 1 };
  }

  return null;
};

// ================= LIST MY CONVERSATIONS =================
// @route   GET /api/community-portal/messages/conversations
// @access  Private
router.get('/conversations', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const { page, limit, offset } = getPagination(req);

    const [conversations] = await mysqlConnection.execute(
      `SELECT c.*, cp.last_read_at
       FROM cp_conversations c
       JOIN cp_conversation_participants cp ON cp.conversation_id = c.id
       WHERE cp.user_id = ? AND cp.is_active = TRUE
       ORDER BY c.last_message_at DESC, c.created_at DESC
       LIMIT ? OFFSET ?`,
      [req.user.id, limit, offset]
    );

    const results = [];
    for (const conv of conversations) {
      const [participants] = await mysqlConnection.execute(
        `SELECT u.id, u.first_name, u.last_name, u.avatar
         FROM cp_conversation_participants cp
         JOIN users u ON cp.user_id = u.id
         WHERE cp.conversation_id = ? AND cp.is_active = TRUE`,
        [conv.id]
      );

      const [lastMessages] = await mysqlConnection.execute(
        `SELECT * FROM cp_messages WHERE conversation_id = ? AND status != 'deleted' ORDER BY created_at DESC LIMIT 1`,
        [conv.id]
      );

      const [[{ unread }]] = await mysqlConnection.execute(
        `SELECT COUNT(*) AS unread FROM cp_messages
         WHERE conversation_id = ? AND status != 'deleted' AND sender_id != ?
         AND (? IS NULL OR created_at > ?)`,
        [conv.id, req.user.id, conv.last_read_at, conv.last_read_at]
      );

      // For direct conversations, surface the "other" participant as the display identity
      const otherParticipant = conv.type === 'direct'
        ? participants.find((p) => p.id !== req.user.id) || null
        : null;

      results.push({
        ...conv,
        participants,
        other_participant: otherParticipant,
        last_message: lastMessages[0]
          ? { ...lastMessages[0], attachments: safeJsonParse(lastMessages[0].attachments, []) }
          : null,
        unread_count: unread
      });
    }

    return successResponse(res, { conversations: results, page, limit }, 'Conversations retrieved successfully');
  } catch (error) {
    console.error('List conversations error:', error);
    return errorResponse(res, 'Failed to retrieve conversations', 500);
  }
});

// ================= START / GET DIRECT CONVERSATION, OR CREATE GROUP CONVERSATION =================
// @route   POST /api/community-portal/messages/conversations
// body (direct): { recipient_id }
// body (group):  { title, participant_ids: [] }
// @access  Private
router.post('/conversations', auth, async (req, res) => {
  try {
    const { recipient_id, title, participant_ids } = req.body;
    const mysqlConnection = getMySQLConnection();

    if (recipient_id) {
      if (String(recipient_id) === String(req.user.id)) {
        return errorResponse(res, 'You cannot start a conversation with yourself', 400);
      }

      const [recipients] = await mysqlConnection.execute(`SELECT id FROM users WHERE id = ? AND is_active = TRUE`, [recipient_id]);
      if (recipients.length === 0) return errorResponse(res, 'Recipient not found', 404);

      // Check for an existing direct conversation between these two users
      const [existing] = await mysqlConnection.execute(
        `SELECT c.id FROM cp_conversations c
         JOIN cp_conversation_participants p1 ON p1.conversation_id = c.id AND p1.user_id = ?
         JOIN cp_conversation_participants p2 ON p2.conversation_id = c.id AND p2.user_id = ?
         WHERE c.type = 'direct'
         LIMIT 1`,
        [req.user.id, recipient_id]
      );

      let conversationId;
      if (existing.length > 0) {
        conversationId = existing[0].id;
        await mysqlConnection.execute(
          `UPDATE cp_conversation_participants SET is_active = TRUE WHERE conversation_id = ? AND user_id IN (?, ?)`,
          [conversationId, req.user.id, recipient_id]
        );
      } else {
        const [result] = await mysqlConnection.execute(
          `INSERT INTO cp_conversations (type, created_by) VALUES ('direct', ?)`,
          [req.user.id]
        );
        conversationId = result.insertId;
        await mysqlConnection.execute(
          `INSERT INTO cp_conversation_participants (conversation_id, user_id, role) VALUES (?, ?, 'member'), (?, ?, 'member')`,
          [conversationId, req.user.id, conversationId, recipient_id]
        );
      }

      const [conv] = await mysqlConnection.execute(`SELECT * FROM cp_conversations WHERE id = ?`, [conversationId]);
      if (existing.length === 0) {
        emitToUser(recipient_id, 'conversation_created', { conversation: conv[0] });
      }
      return successResponse(res, { conversation: conv[0] }, 'Conversation ready', 200);
    }

    if (Array.isArray(participant_ids) && participant_ids.length > 0) {
      const [result] = await mysqlConnection.execute(
        `INSERT INTO cp_conversations (type, title, created_by) VALUES ('group', ?, ?)`,
        [title || null, req.user.id]
      );
      const conversationId = result.insertId;

      const allParticipants = [...new Set([req.user.id, ...participant_ids.map(Number)])];
      for (const uid of allParticipants) {
        await mysqlConnection.execute(
          `INSERT INTO cp_conversation_participants (conversation_id, user_id, role)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE is_active = TRUE`,
          [conversationId, uid, uid === req.user.id ? 'admin' : 'member']
        );
      }

      const [conv] = await mysqlConnection.execute(`SELECT * FROM cp_conversations WHERE id = ?`, [conversationId]);
      allParticipants
        .filter((uid) => uid !== req.user.id)
        .forEach((uid) => emitToUser(uid, 'conversation_created', { conversation: conv[0] }));

      return successResponse(res, { conversation: conv[0] }, 'Group conversation created successfully', 201);
    }

    return errorResponse(res, 'Provide either recipient_id (direct chat) or title + participant_ids (group chat)', 400);
  } catch (error) {
    console.error('Create conversation error:', error);
    return errorResponse(res, 'Failed to create conversation', 500);
  }
});

// ================= GET MESSAGE HISTORY =================
// @route   GET /api/community-portal/messages/conversations/:id/messages
// @access  Private (participants only)
router.get('/conversations/:id/messages', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { page, limit, offset } = getPagination(req, 30, 100);
    const mysqlConnection = getMySQLConnection();

    const participant = await requireParticipant(mysqlConnection, id, req.user.id);
    if (!participant) return errorResponse(res, 'You are not part of this conversation', 403);

    const [messages] = await mysqlConnection.execute(
      `SELECT m.*, u.first_name, u.last_name, u.avatar
       FROM cp_messages m
       JOIN users u ON m.sender_id = u.id
       WHERE m.conversation_id = ? AND m.status != 'deleted'
       ORDER BY m.created_at DESC
       LIMIT ? OFFSET ?`,
      [id, limit, offset]
    );

    const formatted = messages
      .map((m) => ({
        ...m,
        attachments: safeJsonParse(m.attachments, []),
        sender: { id: m.sender_id, full_name: `${m.first_name} ${m.last_name}`.trim(), avatar: m.avatar }
      }))
      .reverse(); // oldest -> newest for display

    return successResponse(res, { messages: formatted, page, limit }, 'Message history retrieved successfully');
  } catch (error) {
    console.error('Get messages error:', error);
    return errorResponse(res, 'Failed to retrieve message history', 500);
  }
});

// ================= SEND MESSAGE =================
// @route   POST /api/community-portal/messages/conversations/:id/messages
// @access  Private (participants only)
router.post('/conversations/:id/messages', auth, communityPortalUpload.array('attachments', 4), async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;
    const mysqlConnection = getMySQLConnection();

    const participant = await requireParticipant(mysqlConnection, id, req.user.id);
    if (!participant) return errorResponse(res, 'You are not part of this conversation', 403);

    const attachments = (req.files || []).map((f) => f.location);
    if ((!content || !content.trim()) && attachments.length === 0) {
      return errorResponse(res, 'Message must include text content or at least one attachment', 400);
    }

    const [result] = await mysqlConnection.execute(
      `INSERT INTO cp_messages (conversation_id, sender_id, content, attachments)
       VALUES (?, ?, ?, ?)`,
      [id, req.user.id, content && content.trim() ? content.trim() : null, attachments.length ? JSON.stringify(attachments) : null]
    );

    await mysqlConnection.execute(`UPDATE cp_conversations SET last_message_at = NOW() WHERE id = ?`, [id]);
    await mysqlConnection.execute(
      `UPDATE cp_conversation_participants SET last_read_at = NOW() WHERE conversation_id = ? AND user_id = ?`,
      [id, req.user.id]
    );

    const [created] = await mysqlConnection.execute(`SELECT * FROM cp_messages WHERE id = ?`, [result.insertId]);
    const formattedMessage = { ...created[0], attachments: safeJsonParse(created[0].attachments, []) };

    // Real-time delivery: anyone with this conversation open right now
    emitToRoom(`conversation:${id}`, 'new_message', { conversation_id: id, message: formattedMessage });

    // Personal ping for every other participant (so their conversation list /
    // unread badge can update even if they don't have the chat open)
    const [participants] = await mysqlConnection.execute(
      `SELECT user_id FROM cp_conversation_participants WHERE conversation_id = ? AND is_active = TRUE AND user_id != ?`,
      [id, req.user.id]
    );
    participants.forEach((p) => {
      emitToUser(p.user_id, 'conversation_updated', { conversation_id: id, last_message: formattedMessage });
    });

    return successResponse(res, {
      message: formattedMessage
    }, 'Message sent successfully', 201);
  } catch (error) {
    console.error('Send message error:', error);
    return errorResponse(res, 'Failed to send message', 500);
  }
});

// ================= MARK CONVERSATION AS READ =================
// @route   PUT /api/community-portal/messages/conversations/:id/read
// @access  Private (participants only)
router.put('/conversations/:id/read', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();

    const participant = await requireParticipant(mysqlConnection, id, req.user.id);
    if (!participant) return errorResponse(res, 'You are not part of this conversation', 403);

    await mysqlConnection.execute(
      `UPDATE cp_conversation_participants SET last_read_at = NOW() WHERE conversation_id = ? AND user_id = ?`,
      [id, req.user.id]
    );

    return successResponse(res, null, 'Conversation marked as read');
  } catch (error) {
    console.error('Mark read error:', error);
    return errorResponse(res, 'Failed to mark conversation as read', 500);
  }
});

// ================= DELETE MESSAGE (soft delete, own messages only) =================
// @route   DELETE /api/community-portal/messages/messages/:messageId
// @access  Private
router.delete('/messages/:messageId', auth, async (req, res) => {
  try {
    const { messageId } = req.params;
    const mysqlConnection = getMySQLConnection();

    const [messages] = await mysqlConnection.execute(`SELECT * FROM cp_messages WHERE id = ?`, [messageId]);
    if (messages.length === 0) return errorResponse(res, 'Message not found', 404);
    if (messages[0].sender_id !== req.user.id) return errorResponse(res, 'You can only delete your own messages', 403);

    await mysqlConnection.execute(`UPDATE cp_messages SET status = 'deleted', content = NULL, attachments = NULL WHERE id = ?`, [messageId]);
    return successResponse(res, null, 'Message deleted successfully');
  } catch (error) {
    console.error('Delete message error:', error);
    return errorResponse(res, 'Failed to delete message', 500);
  }
});

// ================= LEAVE GROUP CONVERSATION =================
// @route   POST /api/community-portal/messages/conversations/:id/leave
// @access  Private
router.post('/conversations/:id/leave', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();

    const [conversations] = await mysqlConnection.execute(`SELECT * FROM cp_conversations WHERE id = ?`, [id]);
    if (conversations.length === 0) return errorResponse(res, 'Conversation not found', 404);
    if (conversations[0].type !== 'group') return errorResponse(res, 'You cannot leave a direct conversation, only group conversations', 400);

    const participant = await requireParticipant(mysqlConnection, id, req.user.id);
    if (!participant) return errorResponse(res, 'You are not part of this conversation', 403);

    await mysqlConnection.execute(
      `UPDATE cp_conversation_participants SET is_active = FALSE WHERE conversation_id = ? AND user_id = ?`,
      [id, req.user.id]
    );

    return successResponse(res, null, 'You have left the group conversation');
  } catch (error) {
    console.error('Leave conversation error:', error);
    return errorResponse(res, 'Failed to leave conversation', 500);
  }
});

module.exports = router;
