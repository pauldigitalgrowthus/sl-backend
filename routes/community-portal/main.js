const express = require('express');
const router = express.Router();

const { auth } = require('../../middleware/auth');
const { getMySQLConnection } = require('../../config/mysql');
const { successResponse, errorResponse } = require('../../utils/response');

// ================= IMPORT SUB-ROUTES =================
const feedRoutes = require('./feed');
const discussionsRoutes = require('./discussions');
const groupsRoutes = require('./groups');
const messagingRoutes = require('./messaging');
const channelsRoutes = require('./channels');
const prayerIntentionsRoutes = require('./prayer-intentions');
const moderationRoutes = require('./moderation');


// ================= COMMUNITY FEED =================
// @route   /api/community-portal/feed
// @desc    Create/list posts, like, comment, edit/delete own posts,
//          link Music Products / Academy Courses into posts
// @access  Public read / Private write
router.use('/feed', feedRoutes);

// ================= DISCUSSIONS =================
// @route   /api/community-portal/discussions
// @desc    Forum-style topic threads: replies, image sharing,
//          sorting (latest/popular/unanswered), pin/lock
// @access  Public read / Private write
router.use('/discussions', discussionsRoutes);

// ================= GROUPS =================
// @route   /api/community-portal/groups
// @desc    Public & private groups (diocesan, parish, composer,
//          interest), join/leave, member management
// @access  Public read (public groups) / Private write
router.use('/groups', groupsRoutes);

// ================= PRIVATE MESSAGING =================
// @route   /api/community-portal/messages
// @desc    1-to-1 chat, group messaging, conversation threads,
//          message history
// @access  Private
router.use('/messages', messagingRoutes);

// ================= CHANNELS & SEGMENTED ACCESS =================
// @route   /api/community-portal/channels
// @desc    Global / private / composer-only / parish / diocesan
//          channels, access gated by role & membership
// @access  Public read (visible channels) / Private write (Admin)
router.use('/channels', channelsRoutes);

// ================= PRAYER INTENTIONS THREAD =================
// @route   /api/community-portal/prayer-intentions
// @desc    Post prayer requests, community responses & support,
//          ongoing/answered status
// @access  Public read / Private write
router.use('/prayer-intentions', prayerIntentionsRoutes);

// ================= MODERATION & ADMINISTRATION =================
// @route   /api/community-portal/moderation
// @desc    Reporting/flagging (any member), content hide/restore/
//          remove, report review dashboard (Admin / SL Team only)
// @access  Private
router.use('/moderation', moderationRoutes);

// ================= USER MENTION SUGGESTIONS =================
// @route   GET /api/community-portal/users/mention-suggestions
// @desc    Autocomplete user suggestions when typing @ in comments/posts/discussions (Instagram-style: friends/interacted first, then all members)
// @access  Private
router.get('/users/mention-suggestions', auth, async (req, res) => {
  try {
    const { search = '' } = req.query;
    const mysqlConnection = getMySQLConnection();
    const currentUserId = req.user.id;

    let query = `
      SELECT 
        u.id, u.first_name, u.last_name, u.email, u.avatar, u.role, u.user_type,
        CASE WHEN conn.interacted_user_id IS NOT NULL THEN 1 ELSE 0 END AS is_connected
      FROM users u
      LEFT JOIN (
        SELECT DISTINCT other_id AS interacted_user_id FROM (
          -- 1. Direct message / conversation participants
          SELECT p2.user_id AS other_id
          FROM cp_conversation_participants p1
          JOIN cp_conversation_participants p2 ON p1.conversation_id = p2.conversation_id
          WHERE p1.user_id = ? AND p2.user_id != ?

          UNION

          -- 2. People who commented on current user's posts
          SELECT c.user_id AS other_id
          FROM cp_comments c
          JOIN cp_posts p ON c.parent_id = p.id
          WHERE p.author_id = ? AND c.user_id != ? AND c.parent_type = 'post'

          UNION

          -- 3. People whose posts current user commented on
          SELECT p.author_id AS other_id
          FROM cp_comments c
          JOIN cp_posts p ON c.parent_id = p.id
          WHERE c.user_id = ? AND p.author_id != ? AND c.parent_type = 'post'

          UNION

          -- 4. People sharing the same community groups
          SELECT gm2.user_id AS other_id
          FROM cp_group_members gm1
          JOIN cp_group_members gm2 ON gm1.group_id = gm2.group_id
          WHERE gm1.user_id = ? AND gm2.user_id != ?
        ) AS interactions
      ) AS conn ON u.id = conn.interacted_user_id
      WHERE (u.is_active = TRUE OR u.is_active IS NULL) AND u.id != ?
    `;

    const params = [
      currentUserId, currentUserId,
      currentUserId, currentUserId,
      currentUserId, currentUserId,
      currentUserId, currentUserId,
      currentUserId
    ];

    if (search && search.trim()) {
      const term = `%${search.trim()}%`;
      query += ` AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ? OR CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')) LIKE ?)`;
      params.push(term, term, term, term);
    }

    // Order by is_connected DESC first (friends/interacted first like Instagram), then alphabetically
    query += ` ORDER BY is_connected DESC, u.first_name ASC, u.last_name ASC LIMIT 10`;

    const [rows] = await mysqlConnection.execute(query, params);

    const formatted = rows.map((u) => {
      const fullName = `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email;
      return {
        id: u.id,
        name: fullName,
        email: u.email,
        avatar: u.avatar || null,
        role: u.role || u.user_type || 'member',
        is_connected: Boolean(u.is_connected)
      };
    });

    return successResponse(res, { users: formatted }, 'Mention suggestions retrieved');
  } catch (error) {
    console.error('Mention suggestions error:', error);
    return errorResponse(res, 'Failed to retrieve mention suggestions', 500);
  }
});

module.exports = router;
