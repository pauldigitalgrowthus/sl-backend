const express = require('express');
const { getMySQLConnection } = require('../config/mysql');
const { auth } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');

const router = express.Router();


/**
 * Create notification and deliver to recipients.
 *
 * @param {Object} payload - { title, body, metadata, channel, target: { type, badge, role, user_type, user_ids } }
 * @param {number|null} reqUserId - creator user id (optional)
 * @param {Object} [db] - optional DB handle (pool or connection). If omitted, function will call getMySQLConnection().
 * @returns {Object} { notificationId, deliveredTo }
 */
async function createAndDeliverNotification(payload, reqUserId = null, db = null) {
  let conn = null;
  let shouldReleaseConn = false;

  try {
    // Use provided db connection or get a new one from pool
    if (db) {
      conn = db;
    } else {
      const pool = getMySQLConnection(); // Get pool
      conn = await pool.getConnection(); // Get connection from pool
      shouldReleaseConn = true;
    }

    // Start transaction
    await conn.beginTransaction();

    // Insert notification master
    const insertNotifSql = `
      INSERT INTO notifications
        (title, body, metadata, channel, created_by, target_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NOW())
    `;
    const [insertRes] = await conn.execute(insertNotifSql, [
      payload.title,
      payload.body || null,
      payload.metadata ? JSON.stringify(payload.metadata) : null,
      payload.channel || 'inbox',
      reqUserId || null,
      payload.target?.type || 'all'
    ]);
    const notificationId = insertRes.insertId;

    // Build recipients list
    let recipients = [];

    const targetType = payload.target?.type || 'all';
    
    if (targetType === 'all') {
      const [rows] = await conn.execute(`SELECT id FROM users WHERE is_active = 1`);
      recipients = rows.map(r => r.id);
      
    } else if (targetType === 'by_badge') {
      const badge = payload.target.badge;
      if (!badge) {
        throw new Error('Badge value required for target.type "by_badge"');
      }
      // Use JSON_CONTAINS with JSON_QUOTE to match simple array values like ["badge1","badge2"]
      const [rows] = await conn.execute(
        `SELECT id FROM users WHERE JSON_CONTAINS(COALESCE(badges, '[]'), JSON_QUOTE(?))`,
        [badge]
      );
      recipients = rows.map(r => r.id);
      
    } else if (targetType === 'by_role') {
      const role = payload.target.role;
      if (!role) {
        throw new Error('Role value required for target.type "by_role"');
      }
      const [rows] = await conn.execute(`SELECT id FROM users WHERE role = ?`, [role]);
      recipients = rows.map(r => r.id);
      
    } else if (targetType === 'by_user_type') {
      const userType = payload.target.user_type;
      if (!userType) {
        throw new Error('User type value required for target.type "by_user_type"');
      }
      const [rows] = await conn.execute(`SELECT id FROM users WHERE user_type = ?`, [userType]);
      recipients = rows.map(r => r.id);
      
    } else if (targetType === 'custom') {
      if (!Array.isArray(payload.target.user_ids)) {
        throw new Error('user_ids array required for target.type "custom"');
      }
      recipients = payload.target.user_ids.slice();
      
    } else {
      throw new Error(`Invalid target type: ${targetType}`);
    }

    // If no recipients, still commit the notification master and return
    if (!recipients.length) {
      await conn.commit();
      if (shouldReleaseConn) conn.release();
      return { notificationId, deliveredTo: 0 };
    }

    // Bulk insert into user_notifications in chunks using parameterized values
    const chunkSize = payload.chunkSize || 500;
    for (let i = 0; i < recipients.length; i += chunkSize) {
      const chunk = recipients.slice(i, i + chunkSize);
      // Build placeholders like (?,?),(?,?),... for (notification_id, user_id)
      const placeholders = chunk.map(() => '(?, ?)').join(', ');
      const params = [];
      chunk.forEach(uid => {
        params.push(notificationId, uid);
      });

      const insertUserNotifSql = `
        INSERT IGNORE INTO user_notifications (notification_id, user_id)
        VALUES ${placeholders}
      `;
      await conn.execute(insertUserNotifSql, params);
    }

    await conn.commit();
    if (shouldReleaseConn) conn.release();
    
    return { notificationId, deliveredTo: recipients.length };

  } catch (err) {
    console.error('Error in createAndDeliverNotification:', err);
    
    // Rollback transaction on error
    if (conn) {
      try {
        await conn.rollback();
      } catch (rollbackErr) {
        console.error('Rollback error:', rollbackErr);
      }
    }
    
    // Release connection on error
    if (shouldReleaseConn && conn) {
      try {
        conn.release();
      } catch (releaseErr) {
        console.error('Connection release error:', releaseErr);
      }
    }
    
    throw err;
  }
}

// POST /api/notifications/send-notification
router.post('/send-notification', async (req, res) => {
  try {
    const result = await createAndDeliverNotification({
      title: "New Badge Released",
      body: "Congrats, you have the Composer badge benefits!",
      metadata: { link: "/badges/Course Editorial" },
      channel: "inbox",
      target: { type: "by_badge", badge: "Course Editorial" }
    });
    
    res.json({ success: true, result });
  } catch (error) {
    console.error('Send notification error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


/**
 * Safely parse metadata JSON string or object
 */
function parseMetadataSafe(meta) {
  if (!meta) return {};
  if (typeof meta === 'object') return meta;
  try {
    return JSON.parse(meta);
  } catch (e) {
    return {};
  }
}

/**
 * Production-level Notification Aggregation Engine
 * Automatically groups common actions (likes, reactions, comments, replies, join requests)
 * targeting the same resource (e.g. post, discussion thread, group) into a single summary notification.
 *
 * Example:
 * 26 people liking post #12 -> "26 Reactions: Alice, Bob and 24 others reacted to your post."
 * 22 people commenting on post #12 -> "22 Comments: David, Emily and 20 others commented on your post."
 */
function aggregateNotifications(list, entityCountsMap = {}) {
  if (!Array.isArray(list) || list.length === 0) return [];

  const groupsMap = new Map();
  const groupOrder = [];

  for (const item of list) {
    const meta = parseMetadataSafe(item.metadata);
    const type = String(meta.type || '').toLowerCase();

    let groupKey = null;

    if (type === 'community_post_like' && meta.post_id) {
      groupKey = `community_post_like:${meta.post_id}`;
    } else if ((type === 'community_post_comment' || type === 'community_comment_reply') && meta.post_id) {
      groupKey = `community_post_comment:${meta.post_id}`;
    } else if (type === 'community_discussion_reply' && meta.thread_id) {
      groupKey = `community_discussion_reply:${meta.thread_id}`;
    } else if (type === 'community_group_join_request' && meta.group_id) {
      groupKey = `community_group_join_request:${meta.group_id}`;
    } else {
      // Non-groupable or unique notification
      groupKey = `single:${item.notification_id || Math.random()}`;
    }

    if (!groupsMap.has(groupKey)) {
      groupsMap.set(groupKey, []);
      groupOrder.push(groupKey);
    }
    groupsMap.get(groupKey).push({ ...item, parsedMeta: meta });
  }

  const aggregated = [];

  for (const key of groupOrder) {
    const items = groupsMap.get(key);
    if (!items || items.length === 0) continue;

    const latest = items[0];
    const metaType = String(latest.parsedMeta?.type || '').toLowerCase();

    // Check if parent entity is deleted / inactive
    if ((metaType === 'community_post_comment' || metaType === 'community_comment_reply' || metaType === 'community_post_like') && latest.parsedMeta?.post_id) {
      if (entityCountsMap?.postActive?.[latest.parsedMeta.post_id] === false) {
        continue;
      }
    }
    if (metaType === 'community_discussion_reply' && latest.parsedMeta?.thread_id) {
      if (entityCountsMap?.threadActive?.[latest.parsedMeta.thread_id] === false) {
        continue;
      }
    }

    // Single item handling
    if (items.length === 1) {
      let singleCount = 1;
      let singleTitle = latest.title;

      if (metaType === 'community_post_comment' || metaType === 'community_comment_reply') {
        const realCommentCount = entityCountsMap?.postComments?.[latest.parsedMeta?.post_id];
        if (realCommentCount !== undefined && realCommentCount !== null) {
          if (realCommentCount <= 0) continue; // All comments removed
          singleCount = realCommentCount;
          singleTitle = `${realCommentCount} ${realCommentCount === 1 ? 'Comment' : 'Comments'}`;
        }
      } else if (metaType === 'community_post_like') {
        const realLikeCount = entityCountsMap?.postLikes?.[latest.parsedMeta?.post_id];
        if (realLikeCount !== undefined && realLikeCount !== null) {
          if (realLikeCount <= 0) continue; // All likes removed
          singleCount = realLikeCount;
          singleTitle = `${realLikeCount} ${realLikeCount === 1 ? 'Reaction' : 'Reactions'}`;
        }
      } else if (metaType === 'community_discussion_reply') {
        const realReplyCount = entityCountsMap?.threadReplies?.[latest.parsedMeta?.thread_id];
        if (realReplyCount !== undefined && realReplyCount !== null) {
          if (realReplyCount <= 0) continue; // All replies removed
          singleCount = realReplyCount;
          singleTitle = `${realReplyCount} ${realReplyCount === 1 ? 'Reply' : 'Replies'}`;
        }
      }

      aggregated.push({
        user_notification_id: latest.user_notification_id,
        notification_id: latest.notification_id,
        notification_ids: [latest.notification_id],
        is_grouped: singleCount > 1,
        group_count: singleCount,
        actor_count: 1,
        title: singleTitle,
        body: latest.body,
        metadata: latest.metadata,
        channel: latest.channel,
        target_type: latest.target_type,
        is_read: !!latest.is_read,
        read_at: latest.read_at,
        delivered_at: latest.delivered_at,
        created_at: latest.created_at
      });
      continue;
    }

    // Multiple notifications grouped
    const allNotificationIds = items.map(it => it.notification_id).filter(Boolean);
    const hasUnread = items.some(it => !it.is_read || it.read_at === null);

    // Extract unique actors in order of arrival (latest first)
    const actorsMap = new Map();
    for (const it of items) {
      const m = it.parsedMeta;
      const actorKey = m.actor_id ? String(m.actor_id) : (m.actor_name || '');
      if (actorKey && !actorsMap.has(actorKey)) {
        actorsMap.set(actorKey, {
          id: m.actor_id || null,
          name: m.actor_name || 'Someone',
          avatar: m.actor_avatar || null
        });
      }
    }
    const actorsList = Array.from(actorsMap.values());
    const actorCount = actorsList.length || items.length;

    let actorNamesText = '';
    if (actorsList.length === 1) {
      actorNamesText = actorsList[0].name;
    } else if (actorsList.length === 2) {
      actorNamesText = `${actorsList[0].name} and ${actorsList[1].name}`;
    } else if (actorsList.length > 2) {
      const othersCount = actorCount - 2;
      actorNamesText = `${actorsList[0].name}, ${actorsList[1].name} and ${othersCount} ${othersCount === 1 ? 'other' : 'others'}`;
    } else {
      actorNamesText = `${items.length} people`;
    }

    let aggregatedTitle = latest.title;
    let aggregatedBody = latest.body;
    let displayGroupCount = items.length;

    if (metaType === 'community_post_like') {
      const realLikeCount = entityCountsMap?.postLikes?.[latest.parsedMeta?.post_id];
      const count = (realLikeCount !== undefined && realLikeCount !== null) ? realLikeCount : actorCount;
      if (count <= 0) continue; // Suppress notification if all likes removed
      aggregatedTitle = `${count} ${count === 1 ? 'Reaction' : 'Reactions'}`;
      aggregatedBody = `${actorNamesText} reacted to your post.`;
      displayGroupCount = count;
    } else if (metaType === 'community_post_comment' || metaType === 'community_comment_reply') {
      const realCommentCount = entityCountsMap?.postComments?.[latest.parsedMeta?.post_id];
      const count = (realCommentCount !== undefined && realCommentCount !== null) ? realCommentCount : items.length;
      if (count <= 0) continue; // Suppress notification if all comments deleted
      aggregatedTitle = `${count} ${count === 1 ? 'Comment' : 'Comments'}`;
      aggregatedBody = `${actorNamesText} commented on your post.`;
      displayGroupCount = count;
    } else if (metaType === 'community_discussion_reply') {
      const realReplyCount = entityCountsMap?.threadReplies?.[latest.parsedMeta?.thread_id];
      const count = (realReplyCount !== undefined && realReplyCount !== null) ? realReplyCount : items.length;
      if (count <= 0) continue; // Suppress notification if all replies deleted
      aggregatedTitle = `${count} ${count === 1 ? 'Reply' : 'Replies'}`;
      aggregatedBody = `${actorNamesText} replied to your discussion.`;
      displayGroupCount = count;
    } else if (metaType === 'community_group_join_request') {
      const groupName = latest.parsedMeta?.group_name ? ` "${latest.parsedMeta.group_name}"` : '';
      aggregatedTitle = `${actorCount} Join Requests`;
      aggregatedBody = `${actorNamesText} requested to join your group${groupName}.`;
      displayGroupCount = actorCount;
    } else {
      aggregatedTitle = `${items.length} Notifications`;
      aggregatedBody = `${actorNamesText} interacted with your content.`;
      displayGroupCount = items.length;
    }

    const combinedMetadata = {
      ...latest.parsedMeta,
      is_grouped: true,
      group_count: displayGroupCount,
      actor_count: actorCount,
      actors: actorsList.slice(0, 5),
      notification_ids: allNotificationIds
    };

    aggregated.push({
      user_notification_id: latest.user_notification_id,
      notification_id: latest.notification_id,
      notification_ids: allNotificationIds,
      is_grouped: true,
      group_count: displayGroupCount,
      actor_count: actorCount,
      actors: actorsList.slice(0, 5),
      title: aggregatedTitle,
      body: aggregatedBody,
      metadata: combinedMetadata,
      channel: latest.channel,
      target_type: latest.target_type,
      is_read: !hasUnread,
      read_at: hasUnread ? null : latest.read_at,
      delivered_at: latest.delivered_at,
      created_at: latest.created_at
    });
  }

  return aggregated;
}

// GET /api/notifications/history
// returns notifications relevant to the logged-in user
router.get('/history', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const userId = req.user.id;

    // query params
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.max(1, parseInt(req.query.limit || '20', 10));
    const offset = (page - 1) * limit;
    const unreadOnly = req.query.unreadOnly === '1' || req.query.unreadOnly === 'true';

    // action handling (mark read/unread or mark all)
    const action = req.query.action || null;
    if (action === 'mark_read' || action === 'mark_unread') {
      let ids = [];
      if (req.query.notificationIds) {
        ids = String(req.query.notificationIds).split(',').map(Number).filter(id => id > 0);
      } else if (req.query.notificationId) {
        const nid = parseInt(req.query.notificationId, 10);
        if (nid) ids.push(nid);
      }
      if (!ids.length) return errorResponse(res, 'notificationId or notificationIds is required', 400);
      const isRead = action === 'mark_read' ? 1 : 0;

      const placeholders = ids.map(() => '(?, ?, ?, CASE WHEN ?=1 THEN NOW() ELSE NULL END, NOW(), NOW())').join(', ');
      const params = [];
      ids.forEach(nid => {
        params.push(nid, userId, isRead, isRead);
      });

      await mysqlConnection.execute(
        `INSERT INTO user_notifications (notification_id, user_id, is_read, read_at, delivered_at, created_at)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE is_read = VALUES(is_read), read_at = VALUES(read_at)`,
        params
      );

      return successResponse(res, { notificationIds: ids, isRead }, isRead ? 'Marked read' : 'Marked unread');
    }

    if (action === 'mark_all_read') {
      await mysqlConnection.execute(
        `UPDATE user_notifications SET is_read = 1, read_at = NOW() WHERE user_id = ? AND is_read = 0`,
        [userId]
      );
      return successResponse(res, {}, 'All notifications marked read');
    }

    // 1) user-specific entries (already delivered)
    const [userNotifs] = await mysqlConnection.execute(
      `SELECT un.id AS user_notification_id, n.id AS notification_id, n.title, n.body, n.metadata, n.channel,
              n.target_type, un.is_read, un.read_at, un.delivered_at, n.created_at
       FROM user_notifications un
       JOIN notifications n ON n.id = un.notification_id
       WHERE un.user_id = ?
         AND n.is_active = TRUE
       ${unreadOnly ? ' AND un.is_read = 0' : ''}
       ORDER BY n.created_at DESC`,
      [userId]
    );

    // 2) Fetch candidate targeted notifications which are active and not yet in user_notifications
    const candidateLimit = 1000;
    const [candidateRows] = await mysqlConnection.execute(
      `SELECT n.id AS notification_id, n.title, n.body, n.metadata, n.channel, n.target_type, n.created_at
       FROM notifications n
       LEFT JOIN user_notifications un ON un.notification_id = n.id AND un.user_id = ?
       WHERE n.is_active = TRUE
         AND un.id IS NULL
       ORDER BY n.created_at DESC
       LIMIT ?`,
      [userId, candidateLimit]
    );

    // 3) Get user attributes for JS-side filtering
    const [userRows] = await mysqlConnection.execute(
      `SELECT role, user_type, COALESCE(badges, '[]') AS badges FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );
    if (userRows.length === 0) return errorResponse(res, 'User not found', 404);

    const user = userRows[0];
    let userBadges = [];
    try { userBadges = JSON.parse(user.badges || '[]'); } catch (_) { userBadges = []; }

    // Helper: get string metadata safely
    function metaValue(metadata, key) {
      if (!metadata) return null;
      try {
        const obj = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
        return obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : null;
      } catch (e) {
        return null;
      }
    }

    // 4) Filter candidate notifications by target rules in JS
    const targetedNotifs = candidateRows.filter(n => {
      const t = n.target_type;
      if (t === 'all') return true;

      const roleInMeta = metaValue(n.metadata, 'role');
      const userTypeInMeta = metaValue(n.metadata, 'user_type');
      const badgeInMeta = metaValue(n.metadata, 'badge');

      if (t === 'by_role') {
        return roleInMeta && String(roleInMeta) === String(user.role);
      }
      if (t === 'by_user_type') {
        return userTypeInMeta && String(userTypeInMeta) === String(user.user_type);
      }
      if (t === 'by_badge') {
        if (!badgeInMeta) return false;
        if (Array.isArray(badgeInMeta)) {
          return badgeInMeta.some(b => userBadges.includes(b));
        } else {
          return userBadges.includes(String(badgeInMeta));
        }
      }
      if (t === 'custom') {
        return false;
      }
      return false;
    });

    // 5) Combine user-specific notifications and targeted ones (user-specific first)
    const combined = [...userNotifs.map(r => ({
      user_notification_id: r.user_notification_id,
      notification_id: r.notification_id,
      title: r.title,
      body: r.body,
      metadata: r.metadata,
      channel: r.channel,
      target_type: r.target_type,
      is_read: !!r.is_read,
      read_at: r.read_at,
      delivered_at: r.delivered_at,
      created_at: r.created_at
    })), ...targetedNotifs.map(r => ({
      user_notification_id: null,
      notification_id: r.notification_id,
      title: r.title,
      body: r.body,
      metadata: r.metadata,
      channel: r.channel,
      target_type: r.target_type,
      is_read: false,
      read_at: null,
      delivered_at: null,
      created_at: r.created_at
    }))];

    // 5.1) Filter out notifications whose underlying comment has been removed or deleted
    const commentIdsToCheck = [];
    const postIdsToCheck = [];
    const threadIdsToCheck = [];

    for (const item of combined) {
      const m = parseMetadataSafe(item.metadata);
      if (m.comment_id) commentIdsToCheck.push(Number(m.comment_id));
      if (m.post_id) postIdsToCheck.push(Number(m.post_id));
      if (m.thread_id) threadIdsToCheck.push(Number(m.thread_id));
    }

    let removedCommentIdSet = new Set();
    if (commentIdsToCheck.length > 0) {
      const uniqueCommentIds = [...new Set(commentIdsToCheck.filter(Boolean))];
      if (uniqueCommentIds.length > 0) {
        const [removedComments] = await mysqlConnection.query(
          `SELECT id FROM cp_comments WHERE id IN (?) AND (status != 'active' OR deleted_at IS NOT NULL)`,
          [uniqueCommentIds]
        );
        removedCommentIdSet = new Set(removedComments.map(c => Number(c.id)));
      }
    }

    // Exclude any notifications pointing to removed comments
    const validCombined = combined.filter(item => {
      const m = parseMetadataSafe(item.metadata);
      if (m.comment_id && removedCommentIdSet.has(Number(m.comment_id))) {
        return false;
      }
      return true;
    });

    // Also deactivate those orphaned notifications in database asynchronously
    if (removedCommentIdSet.size > 0) {
      const removedArr = Array.from(removedCommentIdSet);
      mysqlConnection.query(
        `UPDATE notifications SET is_active = FALSE 
         WHERE JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.comment_id')) IN (?)`,
        [removedArr]
      ).catch(e => console.warn('Background cleanup of deleted comment notifications failed:', e.message));
    }

    // Fetch actual current entity counts so titles & badges match real content
    const entityCountsMap = { postComments: {}, postLikes: {}, threadReplies: {}, postActive: {}, threadActive: {} };

    if (postIdsToCheck.length > 0) {
      const uniquePostIds = [...new Set(postIdsToCheck.filter(Boolean))];
      if (uniquePostIds.length > 0) {
        const [postsData] = await mysqlConnection.query(
          `SELECT id, comment_count, like_count, status, deleted_at FROM cp_posts WHERE id IN (?)`,
          [uniquePostIds]
        );
        for (const p of postsData) {
          const isActive = p.status === 'active' && !p.deleted_at;
          entityCountsMap.postActive[p.id] = isActive;
          entityCountsMap.postComments[p.id] = isActive ? p.comment_count : 0;
          entityCountsMap.postLikes[p.id] = isActive ? p.like_count : 0;
        }
      }
    }

    if (threadIdsToCheck.length > 0) {
      const uniqueThreadIds = [...new Set(threadIdsToCheck.filter(Boolean))];
      if (uniqueThreadIds.length > 0) {
        const [threadsData] = await mysqlConnection.query(
          `SELECT id, reply_count, status, deleted_at FROM cp_discussion_threads WHERE id IN (?)`,
          [uniqueThreadIds]
        );
        for (const t of threadsData) {
          const isActive = t.status === 'active' && !t.deleted_at;
          entityCountsMap.threadActive[t.id] = isActive;
          entityCountsMap.threadReplies[t.id] = isActive ? t.reply_count : 0;
        }
      }
    }

    // 6) Aggregate / Group notifications targeting the same resource
    const aggregated = aggregateNotifications(validCombined, entityCountsMap);

    // 7) Apply unreadOnly filter and pagination on aggregated list
    const filtered = unreadOnly ? aggregated.filter(n => !n.is_read) : aggregated;
    const paginated = filtered.slice(offset, offset + limit);

    // 8) Count total (aggregated count)
    const total = filtered.length;

    return successResponse(res, {
      notifications: paginated,
      total,
      page,
      limit
    }, 'User notifications retrieved');

  } catch (error) {
    console.error('Notifications history error:', error);
    return errorResponse(res, 'Failed to retrieve notifications', 500);
  }
});

/**
 * POST /api/notifications/mark-read
 * Body: { notificationId?: number, notificationIds?: number[], isRead?: boolean }
 * Marks single or multiple (grouped) notifications read/unread for the logged-in user.
 */
router.post('/mark-read', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const userId = req.user.id;
    const isRead = req.body && req.body.hasOwnProperty('isRead') ? !!req.body.isRead : true;

    let ids = [];
    if (Array.isArray(req.body?.notificationIds)) {
      ids = req.body.notificationIds.map(Number).filter(id => id > 0);
    } else if (req.body?.notificationId) {
      const nid = Number(req.body.notificationId);
      if (nid) ids.push(nid);
    }

    if (!ids.length) {
      return errorResponse(res, 'notificationId or notificationIds array is required', 400);
    }

    const placeholders = ids.map(() => '(?, ?, ?, CASE WHEN ?=1 THEN NOW() ELSE NULL END, NOW(), NOW())').join(', ');
    const params = [];
    ids.forEach(nid => {
      params.push(nid, userId, isRead ? 1 : 0, isRead ? 1 : 0);
    });

    const sql = `
      INSERT INTO user_notifications (notification_id, user_id, is_read, read_at, delivered_at, created_at)
      VALUES ${placeholders}
      ON DUPLICATE KEY UPDATE
        is_read = VALUES(is_read),
        read_at = VALUES(read_at),
        delivered_at = COALESCE(delivered_at, NOW())
    `;

    await mysqlConnection.execute(sql, params);

    return successResponse(res, { notificationIds: ids, isRead }, isRead ? 'Marked read' : 'Marked unread');
  } catch (err) {
    console.error('Mark-read error:', err);
    return errorResponse(res, 'Failed to update notification', 500);
  }
});

/**
 * POST /api/notifications/mark-all-read
 * Marks all notifications for the logged-in user as read.
 * Optional body: { markOnlyDelivered: boolean } - if true, only mark user_notifications rows (already delivered ones).
 */
router.post('/mark-all-read', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const userId = req.user.id;
    const markOnlyDelivered = !!req.body?.markOnlyDelivered;

    if (markOnlyDelivered) {
      // Only mark rows present in user_notifications
      await mysqlConnection.execute(
        `UPDATE user_notifications SET is_read = 1, read_at = NOW() WHERE user_id = ? AND is_read = 0`,
        [userId]
      );
    } else {
      // Two-step: insert missing user_notifications for targeted notifications, then mark all read.
      // 1) Insert missing for notifications targeted to this user (targeted 'all' / role / user_type / badge).
      //    Here we insert only notifications not present in user_notifications (best-effort simple logic).
      //    NOTE: For performance/accuracy, prefer pre-delivery background job. This is a convenient fallback.
      const [userRows] = await mysqlConnection.execute(
        `SELECT role, user_type, COALESCE(badges,'[]') AS badges FROM users WHERE id = ? LIMIT 1`,
        [userId]
      );
      if (userRows.length === 0) return errorResponse(res, 'User not found', 404);
      const user = userRows[0];

      // Fetch candidate notifications (same approach as history: limited set)
      const candidateLimit = 1000;
      const [candidateRows] = await mysqlConnection.execute(
        `SELECT n.id AS notification_id, n.target_type, n.metadata
         FROM notifications n
         LEFT JOIN user_notifications un ON un.notification_id = n.id AND un.user_id = ?
         WHERE n.is_active = TRUE
           AND un.id IS NULL
         ORDER BY n.created_at DESC
         LIMIT ?`,
        [userId, candidateLimit]
      );

      // JS-side filter to determine which notifications apply to this user
      let userBadges = [];
      try { userBadges = JSON.parse(user.badges || '[]'); } catch (_) { userBadges = []; }

      const applyFilter = (n) => {
        const t = n.target_type;
        let meta = n.metadata;
        if (typeof meta === 'string') {
          try { meta = JSON.parse(meta); } catch (_) { meta = {}; }
        }
        if (t === 'all') return true;
        if (t === 'by_role') return meta && String(meta.role) === String(user.role);
        if (t === 'by_user_type') return meta && String(meta.user_type) === String(user.user_type);
        if (t === 'by_badge') {
          if (!meta) return false;
          const badgeVal = meta.badge;
          if (!badgeVal) return false;
          if (Array.isArray(badgeVal)) return badgeVal.some(b => userBadges.includes(b));
          return userBadges.includes(String(badgeVal));
        }
        return false;
      };

      const matching = candidateRows.filter(applyFilter).map(r => r.notification_id);
      // Bulk insert matching IDs into user_notifications (if any)
      if (matching.length) {
        const chunkSize = 500;
        for (let i = 0; i < matching.length; i += chunkSize) {
          const chunk = matching.slice(i, i + chunkSize);
          const placeholders = chunk.map(() => '(?, ?)').join(', ');
          const params = [];
          chunk.forEach(nid => { params.push(nid, userId); });
          const insertSql = `INSERT IGNORE INTO user_notifications (notification_id, user_id) VALUES ${placeholders}`;
          await mysqlConnection.execute(insertSql, params);
        }
      }

      // 2) mark all user_notifications rows for this user as read
      await mysqlConnection.execute(
        `UPDATE user_notifications SET is_read = 1, read_at = NOW() WHERE user_id = ? AND is_read = 0`,
        [userId]
      );
    }

    return successResponse(res, {}, 'All notifications marked read');

  } catch (err) {
    console.error('Mark-all-read error:', err);
    return errorResponse(res, 'Failed to mark all read', 500);
  }
});


/**
 * POST POST /api/notifications/:id/read
 * Marks single notification for the logged-in user as read.
 * Optional body: { markOnlyDelivered: boolean } - if true, only mark user_notifications rows (already delivered ones).
 */
router.post('/:id/read', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const userId = req.user.id;
    const notificationId = Number(req.params.id);

    if (!notificationId) {
      return errorResponse(res, 'Invalid notification id', 400);
    }

    // 1) Try update existing user_notifications row
    const [updateRes] = await mysqlConnection.execute(
      `UPDATE user_notifications
       SET is_read = 1, read_at = NOW()
       WHERE notification_id = ? AND user_id = ?`,
      [notificationId, userId]
    );

    // If no rows updated, insert a new user_notifications row
    if (!updateRes.affectedRows) {
      await mysqlConnection.execute(
        `INSERT IGNORE INTO user_notifications
          (notification_id, user_id, is_read, read_at, delivered_at, created_at)
         VALUES (?, ?, 1, NOW(), NOW(), NOW())`,
        [notificationId, userId]
      );
    }

    // Return the user_notifications row joined with notifications info
    const [rows] = await mysqlConnection.execute(
      `SELECT un.notification_id, un.is_read, un.read_at, un.delivered_at,
              n.title, n.body, n.metadata, n.channel, n.created_at
       FROM user_notifications un
       LEFT JOIN notifications n ON n.id = un.notification_id
       WHERE un.user_id = ? AND un.notification_id = ? LIMIT 1`,
      [userId, notificationId]
    );

    const result = rows.length ? rows[0] : {
      notification_id: notificationId,
      is_read: 1,
      read_at: new Date(),
    };

    return successResponse(res, { notification: result }, 'Notification marked read');
  } catch (err) {
    console.error('Mark single notification read error:', err);
    return errorResponse(res, 'Failed to mark notification read', 500);
  }
});



module.exports = router;