const express = require('express');
const { auth } = require('../../middleware/auth');
const { communityPortalUpload, deleteFileFromS3 } = require('../../config/s3');
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

// ================= LIST FEED POSTS =================
// @route   GET /api/community-portal/feed
// @query   page, limit, channel_id, group_id
router.get('/', async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const { page, limit, offset } = getPagination(req);
    const { channel_id: rawChannelId, group_id: rawGroupId } = req.query;
    const channel_id = rawChannelId && rawChannelId !== '[object Object]' && rawChannelId !== 'undefined' && rawChannelId !== 'null' ? rawChannelId : null;
    const group_id = rawGroupId && rawGroupId !== '[object Object]' && rawGroupId !== 'undefined' && rawGroupId !== 'null' ? rawGroupId : null;

    const conditions = [`p.status = 'active'`, `p.is_hidden = FALSE`];
    const params = [];

    if (channel_id) {
      conditions.push('p.channel_id = ?');
      params.push(channel_id);
    }

    if (group_id) {
      // Private group posts require membership
      const [groups] = await mysqlConnection.execute(`SELECT visibility FROM cp_groups WHERE id = ?`, [group_id]);
      if (groups.length === 0) return errorResponse(res, 'Group not found', 404);
      if (groups[0].visibility === 'private') {
        const membership = req.user ? await isActiveGroupMember(group_id, req.user.id) : null;
        if (!membership && !isCommunityModerator(req.user)) {
          return errorResponse(res, 'This is a private group. Join to view its posts.', 403);
        }
      }
      conditions.push('p.group_id = ?');
      params.push(group_id);
    } else if (!channel_id) {
      // Default global feed: only show posts that aren't scoped to a private group
      conditions.push(`(p.group_id IS NULL OR EXISTS (SELECT 1 FROM cp_groups gg WHERE gg.id = p.group_id AND gg.visibility = 'public'))`);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const [posts] = await mysqlConnection.execute(
      `SELECT p.*, u.first_name, u.last_name, u.avatar, u.role AS author_role, u.is_composer,
              g.name AS group_name
       FROM cp_posts p
       JOIN users u ON p.author_id = u.id
       LEFT JOIN cp_groups g ON p.group_id = g.id
       ${whereClause}
       ORDER BY p.is_pinned DESC, p.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await mysqlConnection.execute(
      `SELECT COUNT(*) AS total FROM cp_posts p ${whereClause}`,
      params
    );

    let likedPostIds = new Set();
    if (req.user && posts.length > 0) {
      const ids = posts.map((p) => p.id);
      const [likes] = await mysqlConnection.query(
        `SELECT target_id FROM cp_reactions WHERE target_type = 'post' AND reaction_type = 'like' AND user_id = ? AND target_id IN (?)`,
        [req.user.id, ids]
      );
      likedPostIds = new Set(likes.map((l) => l.target_id));
    }

    const formatted = posts.map((p) => ({
      ...p,
      images: safeJsonParse(p.images, []),
      author: {
        id: p.author_id,
        full_name: `${p.first_name} ${p.last_name}`.trim(),
        avatar: p.avatar,
        role: p.author_role,
        is_composer: !!p.is_composer
      },
      liked_by_me: likedPostIds.has(p.id)
    }));

    return successResponse(res, {
      posts: formatted,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    }, 'Feed retrieved successfully');
  } catch (error) {
    console.error('List feed error:', error);
    return errorResponse(res, 'Failed to retrieve feed', 500);
  }
});

// ================= GET SINGLE POST =================
// @route   GET /api/community-portal/feed/:id
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();
    const [posts] = await mysqlConnection.execute(
      `SELECT p.*, u.first_name, u.last_name, u.avatar, u.role AS author_role, u.is_composer
       FROM cp_posts p
       JOIN users u ON p.author_id = u.id
       WHERE p.id = ? AND p.status = 'active'`,
      [id]
    );

    if (posts.length === 0) return errorResponse(res, 'Post not found', 404);
    const post = posts[0];

    if (post.group_id) {
      const [groups] = await mysqlConnection.execute(`SELECT visibility FROM cp_groups WHERE id = ?`, [post.group_id]);
      if (groups.length > 0 && groups[0].visibility === 'private') {
        const membership = req.user ? await isActiveGroupMember(post.group_id, req.user.id) : null;
        if (!membership && !isCommunityModerator(req.user)) {
          return errorResponse(res, 'This post belongs to a private group', 403);
        }
      }
    }

    let likedByMe = false;
    if (req.user) {
      const [likes] = await mysqlConnection.execute(
        `SELECT id FROM cp_reactions WHERE target_type = 'post' AND target_id = ? AND user_id = ? AND reaction_type = 'like'`,
        [id, req.user.id]
      );
      likedByMe = likes.length > 0;
    }

    return successResponse(res, {
      post: {
        ...post,
        images: safeJsonParse(post.images, []),
        author: {
          id: post.author_id,
          full_name: `${post.first_name} ${post.last_name}`.trim(),
          avatar: post.avatar,
          role: post.author_role,
          is_composer: !!post.is_composer
        },
        liked_by_me: likedByMe
      }
    }, 'Post retrieved successfully');
  } catch (error) {
    console.error('Get post error:', error);
    return errorResponse(res, 'Failed to retrieve post', 500);
  }
});

// ================= CREATE POST =================
// @route   POST /api/community-portal/feed
// @access  Private
// body: content, channel_id?, group_id?, linked_product_type?, linked_product_id?, linked_product_title?, linked_product_url?
// files: images[] (up to 6)
router.post('/', auth, requireCommunityPermission('Feeds', 'x'), communityPortalUpload.array('images', 6), async (req, res) => {
  try {
    const {
      content,
      channel_id,
      group_id,
      linked_product_type,
      linked_product_id,
      linked_product_title,
      linked_product_url
    } = req.body;

    if (!content || !content.trim()) return errorResponse(res, 'Post content is required', 400);

    const mysqlConnection = getMySQLConnection();

    if (channel_id) {
      const [channels] = await mysqlConnection.execute(`SELECT * FROM cp_channels WHERE id = ? AND is_active = TRUE`, [channel_id]);
      if (channels.length === 0) return errorResponse(res, 'Channel not found', 404);
      const canAccess = await canAccessChannel(channels[0], req.user);
      if (!canAccess) return errorResponse(res, 'You do not have access to post in this channel', 403);
    }

    if (group_id) {
      const membership = await isActiveGroupMember(group_id, req.user.id);
      if (!membership && !isCommunityModerator(req.user)) {
        return errorResponse(res, 'You must be a member of this group to post in it', 403);
      }
    }

    if (linked_product_type && !['music_publication', 'course'].includes(linked_product_type)) {
      return errorResponse(res, 'linked_product_type must be "music_publication" or "course"', 400);
    }

    const images = (req.files || []).map((f) => f.location);

    const [result] = await mysqlConnection.execute(
      `INSERT INTO cp_posts
        (author_id, channel_id, group_id, content, images, linked_product_type, linked_product_id, linked_product_title, linked_product_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        channel_id || null,
        group_id || null,
        content.trim(),
        images.length ? JSON.stringify(images) : null,
        linked_product_type || null,
        linked_product_id || null,
        linked_product_title || null,
        linked_product_url || null
      ]
    );

    const [created] = await mysqlConnection.execute(`SELECT * FROM cp_posts WHERE id = ?`, [result.insertId]);

    const formattedPost = { ...created[0], images: safeJsonParse(created[0].images, []) };
    emitToRoom(contentScopeRoom(formattedPost, 'feed:global'), 'new_post', { post: formattedPost });

    // Notify mentioned users in post
    let postMentioned = req.body.mentioned_user_ids;
    if (typeof postMentioned === 'string') {
      try { postMentioned = JSON.parse(postMentioned); } catch (_) { postMentioned = []; }
    }
    if (Array.isArray(postMentioned) && postMentioned.length > 0) {
      const actorName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || 'Someone';
      const trimmed = content.trim();
      const snippet = trimmed.length > 60 ? trimmed.substring(0, 57) + '...' : trimmed;
      await notifyMentionedUsers({
        mentionedUserIds: postMentioned,
        actorUser: req.user,
        contextType: 'post',
        snippet,
        link: `/feeds?postId=${result.insertId}`,
        extraMeta: { post_id: result.insertId }
      });
    }


    return successResponse(res, {
      post: formattedPost
    }, 'Post created successfully', 201);
  } catch (error) {
    console.error('Create post error:', error);
    return errorResponse(res, 'Failed to create post', 500);
  }
});

// ================= EDIT POST =================
// @route   PUT /api/community-portal/feed/:id
// @access  Private (author only)
router.put('/:id', auth, requireCommunityPermission('Feeds', 'x'), communityPortalUpload.array('images', 6), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      content,
      channel_id,
      group_id,
      linked_product_type,
      linked_product_title,
      linked_product_url,
      remove_images,
    } = req.body;
    const mysqlConnection = getMySQLConnection();

    const [posts] = await mysqlConnection.execute(`SELECT * FROM cp_posts WHERE id = ? AND status = 'active'`, [id]);
    if (posts.length === 0) return errorResponse(res, 'Post not found', 404);
    const post = posts[0];

    if (post.author_id !== req.user.id) {
      return errorResponse(res, 'You can only edit your own posts', 403);
    }

    let images = safeJsonParse(post.images, []);
    const removeList = safeJsonParse(remove_images, []) || [];
    if (Array.isArray(removeList) && removeList.length > 0) {
      const toRemove = images.filter((img) => removeList.includes(img));
      images = images.filter((img) => !removeList.includes(img));
      toRemove.forEach((img) => deleteFileFromS3(img).catch((e) => console.warn('Post image cleanup failed:', e.message)));
    }

    const newImages = (req.files || []).map((f) => f.location);
    images = [...images, ...newImages].slice(0, 6);

    // ✅ Update all fields in Database
    await mysqlConnection.execute(
      `UPDATE cp_posts SET 
        content = COALESCE(?, content), 
        images = ?,
        channel_id = ?,
        group_id = ?,
        linked_product_type = ?,
        linked_product_title = ?,
        linked_product_url = ?
      WHERE id = ?`,
      [
        content && content.trim() ? content.trim() : post.content,
        images.length ? JSON.stringify(images) : null,
        channel_id !== undefined ? (channel_id ? Number(channel_id) || null : null) : post.channel_id,
        group_id !== undefined ? (group_id ? Number(group_id) || null : null) : post.group_id,
        linked_product_type !== undefined ? (linked_product_type || null) : post.linked_product_type,
        linked_product_title !== undefined ? (linked_product_title || null) : post.linked_product_title,
        linked_product_url !== undefined ? (linked_product_url || null) : post.linked_product_url,
        id,
      ]
    );

    const [updated] = await mysqlConnection.execute(`SELECT * FROM cp_posts WHERE id = ?`, [id]);
    return successResponse(
      res,
      { post: { ...updated[0], images: safeJsonParse(updated[0].images, []) } },
      'Post updated successfully'
    );
  } catch (error) {
    console.error('Edit post error:', error);
    return errorResponse(res, 'Failed to edit post', 500);
  }
});


// ================= DELETE POST =================
// @route   DELETE /api/community-portal/feed/:id
// @access  Private (author, group moderator, or Admin)
router.delete('/:id', auth, requireCommunityPermission('Feeds', 'x'), async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();
    const [posts] = await mysqlConnection.execute(`SELECT * FROM cp_posts WHERE id = ?`, [id]);
    if (posts.length === 0) return errorResponse(res, 'Post not found', 404);
    const post = posts[0];

    let canDelete = post.author_id === req.user.id || isCommunityModerator(req.user);
    if (!canDelete && post.group_id) {
      const membership = await isActiveGroupMember(post.group_id, req.user.id);
      canDelete = !!(membership && ['owner', 'moderator'].includes(membership.role));
    }

    if (!canDelete) return errorResponse(res, 'You do not have permission to delete this post', 403);

    await mysqlConnection.execute(`UPDATE cp_posts SET status = 'removed', deleted_at = NOW() WHERE id = ?`, [id]);
    return successResponse(res, null, 'Post deleted successfully');
  } catch (error) {
    console.error('Delete post error:', error);
    return errorResponse(res, 'Failed to delete post', 500);
  }
});

// ================= LIKE / UNLIKE POST =================
// @route   POST /api/community-portal/feed/:id/like
// @access  Private
router.post('/:id/like', auth, requireCommunityPermission('Feeds', 'x'), async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();

    const [posts] = await mysqlConnection.execute(`SELECT id, author_id FROM cp_posts WHERE id = ? AND status = 'active'`, [id]);
    if (posts.length === 0) return errorResponse(res, 'Post not found', 404);
    const post = posts[0];

    const [existing] = await mysqlConnection.execute(
      `SELECT id FROM cp_reactions WHERE target_type = 'post' AND target_id = ? AND user_id = ? AND reaction_type = 'like'`,
      [id, req.user.id]
    );

    if (existing.length > 0) {
      await mysqlConnection.execute(`DELETE FROM cp_reactions WHERE id = ?`, [existing[0].id]);
      await mysqlConnection.execute(`UPDATE cp_posts SET like_count = GREATEST(like_count - 1, 0) WHERE id = ?`, [id]);
      const [[updatedPost]] = await mysqlConnection.query(`SELECT id, channel_id, group_id, like_count FROM cp_posts WHERE id = ?`, [id]);
      emitToRoom(contentScopeRoom(updatedPost, 'feed:global'), 'post_like_updated', { post_id: id, like_count: updatedPost.like_count, liked: false, user_id: req.user.id });

      try {
        await mysqlConnection.execute(
          `UPDATE notifications SET is_active = FALSE WHERE metadata LIKE ? AND metadata LIKE ? AND metadata LIKE ?`,
          [`%"type":"community_post_like"%`, `%"post_id":${id}%`, `%"actor_id":${req.user.id}%`]
        );
      } catch (e) {
        console.warn('Deactivate like notification error:', e.message);
      }

      return successResponse(res, { liked: false }, 'Post unliked');
    }

    await mysqlConnection.execute(
      `INSERT INTO cp_reactions (target_type, target_id, user_id, reaction_type) VALUES ('post', ?, ?, 'like')`,
      [id, req.user.id]
    );
    await mysqlConnection.execute(`UPDATE cp_posts SET like_count = like_count + 1 WHERE id = ?`, [id]);
    const [[likedPost]] = await mysqlConnection.query(`SELECT id, channel_id, group_id, like_count FROM cp_posts WHERE id = ?`, [id]);
    emitToRoom(contentScopeRoom(likedPost, 'feed:global'), 'post_like_updated', { post_id: id, like_count: likedPost.like_count, liked: true, user_id: req.user.id });

    // 🔔 IN-APP NOTIFICATION: Notify post owner on like (if not self)
    if (post.author_id && Number(post.author_id) !== Number(req.user.id)) {
      const actorName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || 'Someone';
      sendCommunityNotification({
        recipientId: post.author_id,
        actorUser: req.user,
        title: 'New Like',
        body: `${actorName} liked your post.`,
        metadata: {
          type: 'community_post_like',
          post_id: post.id,
          actor_id: req.user.id,
          actor_name: actorName,
          actor_avatar: req.user.avatar || null,
          link: `/feeds?postId=${post.id}`
        }
      });
    }

    return successResponse(res, { liked: true }, 'Post liked');
  } catch (error) {
    console.error('Like post error:', error);
    return errorResponse(res, 'Failed to like/unlike post', 500);
  }
});

// ================= LIST COMMENTS =================
// @route   GET /api/community-portal/feed/:id/comments
router.get('/:id/comments', async (req, res) => {
  try {
    const { id } = req.params;
    const { page, limit, offset } = getPagination(req, 20, 100);
    const mysqlConnection = getMySQLConnection();

    const [comments] = await mysqlConnection.execute(
      `SELECT c.*, u.first_name, u.last_name, u.avatar
       FROM cp_comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.parent_type = 'post' AND c.parent_id = ? AND c.status = 'active' AND c.is_hidden = FALSE
       ORDER BY c.created_at ASC
       LIMIT ? OFFSET ?`,
      [id, limit, offset]
    );

    const formatted = comments.map((c) => ({
      ...c,
      images: safeJsonParse(c.images, []),
      author: { id: c.user_id, full_name: `${c.first_name} ${c.last_name}`.trim(), avatar: c.avatar }
    }));

    return successResponse(res, { comments: formatted, page, limit }, 'Comments retrieved successfully');
  } catch (error) {
    console.error('List comments error:', error);
    return errorResponse(res, 'Failed to retrieve comments', 500);
  }
});

// ================= ADD COMMENT =================
// @route   POST /api/community-portal/feed/:id/comments
// @access  Private
router.post('/:id/comments', auth, requireCommunityPermission('Feeds', 'x'), communityPortalUpload.array('images', 4), async (req, res) => {
  try {
    const { id } = req.params;
    const { content, parent_comment_id } = req.body;

    if (!content || !content.trim()) return errorResponse(res, 'Comment content is required', 400);

    const mysqlConnection = getMySQLConnection();
    const [posts] = await mysqlConnection.execute(`SELECT id, author_id FROM cp_posts WHERE id = ? AND status = 'active'`, [id]);
    if (posts.length === 0) return errorResponse(res, 'Post not found', 404);
    const post = posts[0];

    const images = (req.files || []).map((f) => f.location);

    const [result] = await mysqlConnection.execute(
      `INSERT INTO cp_comments (parent_type, parent_id, parent_comment_id, user_id, content, images)
       VALUES ('post', ?, ?, ?, ?, ?)`,
      [id, parent_comment_id || null, req.user.id, content.trim(), images.length ? JSON.stringify(images) : null]
    );

    await mysqlConnection.execute(`UPDATE cp_posts SET comment_count = comment_count + 1 WHERE id = ?`, [id]);

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
      images: safeJsonParse(createdRow.images, []),
      author: {
        id: createdRow.user_id,
        full_name: `${createdRow.first_name || ''} ${createdRow.last_name || ''}`.trim() || 'User',
        avatar: createdRow.avatar,
        role: createdRow.role
      }
    };
    const [[parentPost]] = await mysqlConnection.query(`SELECT id, channel_id, group_id FROM cp_posts WHERE id = ?`, [id]);
    emitToRoom(contentScopeRoom(parentPost, 'feed:global'), 'new_comment', { post_id: id, comment: formattedComment });

    // 🔔 IN-APP NOTIFICATIONS: Comment / Reply triggers
    const actorName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || 'Someone';
    const trimmedContent = content.trim();
    const snippet = trimmedContent.length > 60 ? trimmedContent.substring(0, 57) + '...' : trimmedContent;

    if (parent_comment_id) {
      // 1. Reply to comment -> notify parent comment owner
      const [parentComments] = await mysqlConnection.execute(
        `SELECT id, user_id, content FROM cp_comments WHERE id = ? AND status = 'active'`,
        [parent_comment_id]
      );
      if (parentComments.length > 0) {
        const parentComment = parentComments[0];
        if (parentComment.user_id && Number(parentComment.user_id) !== Number(req.user.id)) {
          sendCommunityNotification({
            recipientId: parentComment.user_id,
            actorUser: req.user,
            title: 'New Reply',
            body: `${actorName} replied to your comment: "${snippet}"`,
            metadata: {
              type: 'community_comment_reply',
              post_id: post.id,
              comment_id: result.insertId,
              parent_comment_id: parentComment.id,
              actor_id: req.user.id,
              actor_name: actorName,
              actor_avatar: req.user.avatar || null,
              link: `/feeds?postId=${post.id}`
            }
          });
        }

        // Also notify the post owner if different from replier and parent comment owner
        if (post.author_id && Number(post.author_id) !== Number(req.user.id) && Number(post.author_id) !== Number(parentComment.user_id)) {
          sendCommunityNotification({
            recipientId: post.author_id,
            actorUser: req.user,
            title: 'New Comment',
            body: `${actorName} commented on your post: "${snippet}"`,
            metadata: {
              type: 'community_post_comment',
              post_id: post.id,
              comment_id: result.insertId,
              parent_comment_id: parentComment.id,
              actor_id: req.user.id,
              actor_name: actorName,
              actor_avatar: req.user.avatar || null,
              link: `/feeds?postId=${post.id}`
            }
          });
        }
      }
    } else {
      // Top-level comment on post -> notify post owner
      if (post.author_id && Number(post.author_id) !== Number(req.user.id)) {
        sendCommunityNotification({
          recipientId: post.author_id,
          actorUser: req.user,
          title: 'New Comment',
          body: `${actorName} commented on your post: "${snippet}"`,
          metadata: {
            type: 'community_post_comment',
            post_id: post.id,
            comment_id: result.insertId,
            actor_id: req.user.id,
            actor_name: actorName,
            actor_avatar: req.user.avatar || null,
            link: `/feeds?postId=${post.id}`
          }
        });
      }
    }

    
    // Notify mentioned users in comment / reply
    let commentMentioned = req.body.mentioned_user_ids;
    if (typeof commentMentioned === 'string') {
      try { commentMentioned = JSON.parse(commentMentioned); } catch (_) { commentMentioned = []; }
    }
    if (Array.isArray(commentMentioned) && commentMentioned.length > 0) {
      const alreadyNotified = new Set([Number(req.user.id)]);
      if (parent_comment_id && parentComments?.length > 0 && parentComments[0].user_id) {
        alreadyNotified.add(Number(parentComments[0].user_id));
      }
      if (post.author_id) {
        alreadyNotified.add(Number(post.author_id));
      }
      const filtered = commentMentioned.filter((id) => !alreadyNotified.has(Number(id)));
      await notifyMentionedUsers({
        mentionedUserIds: filtered,
        actorUser: req.user,
        contextType: parent_comment_id ? 'reply' : 'comment',
        snippet,
        link: `/feeds?postId=${post.id}`,
        extraMeta: {
          post_id: post.id,
          comment_id: result.insertId,
          parent_comment_id: parent_comment_id || null
        }
      });
    }

    return successResponse(res, { comment: formattedComment }, 'Comment added successfully', 201);
  } catch (error) {
    console.error('Add comment error:', error);
    return errorResponse(res, 'Failed to add comment', 500);
  }
});

// ================= EDIT COMMENT =================
// @route   PUT /api/community-portal/feed/comments/:commentId
// @access  Private (author only)
router.put('/comments/:commentId', auth, requireCommunityPermission('Feeds', 'x'), async (req, res) => {
  try {
    const { commentId } = req.params;
    const { content } = req.body;
    if (!content || !content.trim()) return errorResponse(res, 'Comment content is required', 400);

    const mysqlConnection = getMySQLConnection();
    const [comments] = await mysqlConnection.execute(`SELECT * FROM cp_comments WHERE id = ? AND parent_type = 'post' AND status = 'active'`, [commentId]);
    if (comments.length === 0) return errorResponse(res, 'Comment not found', 404);
    if (comments[0].user_id !== req.user.id) return errorResponse(res, 'You can only edit your own comments', 403);

    await mysqlConnection.execute(`UPDATE cp_comments SET content = ? WHERE id = ?`, [content.trim(), commentId]);
    return successResponse(res, null, 'Comment updated successfully');
  } catch (error) {
    console.error('Edit comment error:', error);
    return errorResponse(res, 'Failed to edit comment', 500);
  }
});

// ================= DELETE COMMENT =================
// @route   DELETE /api/community-portal/feed/comments/:commentId
// @access  Private (author or Admin)
router.delete('/comments/:commentId', auth, requireCommunityPermission('Feeds', 'x'), async (req, res) => {
  try {
    const { commentId } = req.params;
    const mysqlConnection = getMySQLConnection();
    const [comments] = await mysqlConnection.execute(`SELECT * FROM cp_comments WHERE id = ? AND parent_type = 'post'`, [commentId]);
    if (comments.length === 0) return errorResponse(res, 'Comment not found', 404);
    const comment = comments[0];

    if (String(comment.user_id) !== String(req.user.id)) {
      return errorResponse(res, 'You do not have permission to delete this comment', 403);
    }

    await mysqlConnection.execute(`UPDATE cp_comments SET status = 'removed', deleted_at = NOW() WHERE id = ?`, [commentId]);
    await mysqlConnection.execute(`UPDATE cp_posts SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = ?`, [comment.parent_id]);

    try {
      await mysqlConnection.execute(
        `UPDATE notifications SET is_active = FALSE WHERE (metadata LIKE ? OR metadata LIKE ?)`,
        [`%"comment_id":${commentId},%`, `%"comment_id":${commentId}}%`]
      );
    } catch (e) {
      console.warn('Deactivate comment notification error:', e.message);
    }

    return successResponse(res, null, 'Comment deleted successfully');
  } catch (error) {
    console.error('Delete comment error:', error);
    return errorResponse(res, 'Failed to delete comment', 500);
  }
});

module.exports = router;
