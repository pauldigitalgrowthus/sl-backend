// ============================================
// COMMUNITY PORTAL - SHARED HELPERS
// ============================================
const { getMySQLConnection } = require('../../config/mysql');

/**
 * Roles that are treated as community-wide Admin / moderators.
 * `role` = 'sl_team' covers Admin / SL Team (all badges) from the SOW.
 * `user_type` = 'superadmin' covers top-level diocesan/subscription admins.
 */
const isCommunityModerator = (user) => {
  if (!user) return false;
  if (user.role === 'sl_team') return true;
  if (user.user_type === 'superadmin') return true;
  return false;
};

/**
 * Parse pagination query params consistently across all community-portal routes.
 */
const getPagination = (req, defaultLimit = 20, maxLimit = 100) => {
  let page = parseInt(req.query.page, 10);
  let limit = parseInt(req.query.limit, 10);

  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!Number.isFinite(limit) || limit < 1) limit = defaultLimit;
  if (limit > maxLimit) limit = maxLimit;

  const offset = (page - 1) * limit;
  return { page, limit, offset };
};

/**
 * Safely JSON.parse a column that may already be an object (mysql2 sometimes
 * auto-parses JSON columns) or may be a JSON string, or null.
 */
const safeJsonParse = (value, fallback = null) => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (e) {
    return fallback;
  }
};

/**
 * Build a public-facing "author" object from a users row (or joined columns).
 */
const buildAuthor = (row, prefix = '') => {
  const get = (key) => row[`${prefix}${key}`];
  const firstName = get('first_name');
  const lastName = get('last_name');
  if (!firstName && !lastName) return null;

  return {
    id: get('id'),
    full_name: `${firstName || ''} ${lastName || ''}`.trim(),
    avatar: get('avatar'),
    role: get('role'),
    is_composer: !!get('is_composer'),
    is_diocesan: !!get('is_diocesan')
  };
};

/**
 * Check whether a user can view content scoped to a private group.
 * Returns true for active members, group owners/mods, and community moderators.
 */
const isActiveGroupMember = async (groupId, userId) => {
  if (!groupId || !userId) return false;
  const mysqlConnection = getMySQLConnection();
  const [rows] = await mysqlConnection.execute(
    `SELECT id, role FROM cp_group_members WHERE group_id = ? AND user_id = ? AND status = 'active'`,
    [groupId, userId]
  );
  return rows.length > 0 ? rows[0] : null;
};

/**
 * Check membership on a private/restricted channel.
 */
const isChannelMember = async (channelId, userId) => {
  if (!channelId || !userId) return false;
  const mysqlConnection = getMySQLConnection();
  const [rows] = await mysqlConnection.execute(
    `SELECT id, role FROM cp_channel_members WHERE channel_id = ? AND user_id = ?`,
    [channelId, userId]
  );
  return rows.length > 0 ? rows[0] : null;
};

/**
 * Resolve whether the current user is allowed to view/post in a given channel,
 * based on channel_type + allowed_roles + explicit membership.
 */
const canAccessChannel = async (channel, user) => {
  if (!channel) return false;
  if (isCommunityModerator(user)) return true;

  switch (channel.channel_type) {
    case 'global':
      return true;
    case 'private':
    case 'composer':
    case 'parish':
    case 'diocesan':
    case 'group': {
      if (!user) return false;

      // Explicit allowed_roles list on the channel (JSON array of role/user_type strings)
      const allowedRoles = safeJsonParse(channel.allowed_roles, []);
      if (Array.isArray(allowedRoles) && allowedRoles.length > 0) {
        if (
          allowedRoles.includes(user.role) ||
          allowedRoles.includes(user.user_type) ||
          ((user.user_type === 'sub_user' || user.role === 'member') && allowedRoles.includes('member')) ||
          ((user.user_type === 'manager' || user.role === 'manager') && allowedRoles.includes('manager'))
        ) {
          return true;
        }
      }

      // Composer-only channels: any verified composer gets in automatically
      if (channel.channel_type === 'composer' && user.is_composer) return true;

      // Diocesan channels: any diocesan-flagged user gets in automatically
      if (channel.channel_type === 'diocesan' && user.is_diocesan) return true;

      // Group-linked channel: must be an active member of the linked group
      if (channel.channel_type === 'group' && channel.group_id) {
        const membership = await isActiveGroupMember(channel.group_id, user.id);
        if (membership) return true;
      }

      // Fall back to explicit per-user channel membership
      const membership = await isChannelMember(channel.id, user.id);
      return !!membership;
    }
    default:
      return false;
  }
};

/**
 * Deliver in-app notification (DB entry + real-time socket emit) to recipient
 */
const { createAndDeliverNotification } = require('../../utils/notificationUtils');
const { emitToUser } = require('./socket');

const sendCommunityNotification = async ({ recipientId, actorUser, title, body, metadata }) => {
  if (!recipientId || (actorUser && Number(recipientId) === Number(actorUser.id))) {
    return; // Do not notify self
  }

  try {
    const actorId = actorUser ? actorUser.id : null;
    await createAndDeliverNotification(
      {
        title,
        body,
        metadata,
        channel: 'inbox',
        target: { type: 'custom', user_ids: [recipientId] }
      },
      actorId
    );

    // Real-time socket emit to recipient user room
    emitToUser(recipientId, 'new_notification', {
      title,
      body,
      metadata,
      created_at: new Date()
    });
  } catch (err) {
    console.error('⚠️ sendCommunityNotification failed:', err.message);
  }
};

/**
 * Resolve community permission level for a user on a given module.
 * Possible module names: 'Feeds', 'Discussions', 'My Groups', 'Prayer'
 * Returns: 'x' | 'view-only' | '-'
 */
function getCommunityPermission(user, moduleName) {
  if (!user) return '-';
  // Superadmin or SL Team has full access bypass
  if (user.role === 'sl_team' || user.user_type === 'superadmin') {
    return 'x';
  }

  // Member or Manager accounts get full access to Community
  const isManager =
    user.user_type === 'manager' ||
    user.role === 'manager';
  const isMember =
    user.user_type === 'sub_user' ||
    user.user_type === 'member' ||
    user.role === 'member';

  if (isManager || isMember) {
    return 'x';
  }

  const directPerms = safeJsonParse(user.permissions, user.permissions || {});
  const planPerms = safeJsonParse(user.plan_permissions, user.plan_permissions || {});

  const getVal = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.Community && typeof obj.Community === 'object') {
      if (obj.Community[moduleName] !== undefined) return obj.Community[moduleName];
      if (moduleName === 'Feeds' && obj.Community['Feed'] !== undefined) return obj.Community['Feed'];
      if (moduleName === 'Feed' && obj.Community['Feeds'] !== undefined) return obj.Community['Feeds'];
    }
    if (obj[moduleName] !== undefined) {
      return obj[moduleName];
    }
    if (moduleName === 'Feeds' && obj['Feed'] !== undefined) return obj['Feed'];
    if (moduleName === 'Feed' && obj['Feeds'] !== undefined) return obj['Feeds'];
    if (moduleName === 'My Groups' && obj.Community?.Groups !== undefined) {
      return obj.Community.Groups;
    }
    if (moduleName === 'My Groups' && obj.Groups !== undefined) {
      return obj.Groups;
    }
    return null;
  };

  const permVal = getVal(directPerms);
  const planVal = getVal(planPerms);

  // Explicit deny '-' has highest priority
  if (permVal === '-' || (!permVal && planVal === '-')) return '-';

  // Explicit 'view-only'
  if (permVal === 'view-only' || (!permVal && planVal === 'view-only')) return 'view-only';

  // Explicit 'x' (or granted)
  if (permVal === 'x' || (!permVal && planVal === 'x')) return 'x';

  const resolved = permVal || planVal;
  return resolved || '-';
}

/**
 * Express middleware to enforce Community portal permissions.
 * @param {string} moduleName - 'Feeds' | 'Discussions' | 'My Groups' | 'Prayer'
 * @param {'view-only' | 'x'} requiredLevel - 'view-only' allows GET, 'x' allows mutations
 */
function requireCommunityPermission(moduleName, requiredLevel = 'view-only') {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    const level = getCommunityPermission(req.user, moduleName);

    if (level === '-') {
      return res.status(403).json({
        success: false,
        message: `Access denied. You do not have permission to access Community ${moduleName}.`
      });
    }

    if (requiredLevel === 'x' && level === 'view-only') {
      return res.status(403).json({
        success: false,
        message: `Your subscription plan has view-only access for Community ${moduleName}. Upgrade your plan to create, edit, or interact.`
      });
    }

    req.communityPermission = level;
    next();
  };
}


/**
 * Dispatch mention notifications to a list of tagged user IDs.
 */
const notifyMentionedUsers = async ({ mentionedUserIds, actorUser, contextType, snippet, link, extraMeta = {} }) => {
  if (!Array.isArray(mentionedUserIds) || mentionedUserIds.length === 0) return;
  const actorName = `${actorUser?.first_name || ''} ${actorUser?.last_name || ''}`.trim() || 'Someone';
  const cleanSnippet = snippet ? (snippet.length > 60 ? snippet.substring(0, 57) + '...' : snippet) : '';
  const uniqueIds = [...new Set(mentionedUserIds.map(Number))].filter(
    (id) => id && (!actorUser || id !== Number(actorUser.id))
  );

  for (const userId of uniqueIds) {
    try {
      await sendCommunityNotification({
        recipientId: userId,
        actorUser,
        title: 'Mentioned You',
        body: `${actorName} mentioned you in a ${contextType}: "${cleanSnippet}"`,
        metadata: {
          type: 'community_mention',
          context_type: contextType,
          link,
          actor_id: actorUser?.id,
          actor_name: actorName,
          actor_avatar: actorUser?.avatar || null,
          ...extraMeta
        }
      });
    } catch (err) {
      console.error('Mention notification error for recipient', userId, err.message);
    }
  }
};

module.exports = {
  getMySQLConnection,
  isCommunityModerator,
  getPagination,
  safeJsonParse,
  buildAuthor,
  isActiveGroupMember,
  isChannelMember,
  canAccessChannel,
  sendCommunityNotification,
  getCommunityPermission,
  requireCommunityPermission,
  notifyMentionedUsers
};


