const express = require('express');
const { auth } = require('../../middleware/auth');
const { successResponse, errorResponse } = require('../../utils/response');
const { getMySQLConnection, isCommunityModerator, getPagination } = require('./helpers');
const { emitToRoom } = require('./socket');

const router = express.Router();

const CONTENT_TABLE_MAP = {
  post: { table: 'cp_posts', hasStatus: true },
  thread: { table: 'cp_discussion_threads', hasStatus: true },
  comment: { table: 'cp_comments', hasStatus: true },
  reply: { table: 'cp_comments', hasStatus: true },
  prayer: { table: 'cp_prayer_intentions', hasStatus: false },
  group: { table: 'cp_groups', hasStatus: false }
};

// All routes below require the requester to be signed in.
router.use(auth);

// ================= REPORT / FLAG CONTENT =================
// @route   POST /api/community-portal/moderation/report
// @access  Private (any member)
router.post('/report', async (req, res) => {
  try {
    const { content_type, content_id, reason, details } = req.body;
    const validTypes = ['post', 'comment', 'thread', 'reply', 'prayer', 'group', 'message'];

    if (!validTypes.includes(content_type)) {
      return errorResponse(res, `content_type must be one of: ${validTypes.join(', ')}`, 400);
    }
    if (!content_id) return errorResponse(res, 'content_id is required', 400);
    if (!reason || !reason.trim()) return errorResponse(res, 'A reason for the report is required', 400);

    const mysqlConnection = getMySQLConnection();
    const [result] = await mysqlConnection.execute(
      `INSERT INTO cp_reports (content_type, content_id, reported_by, reason, details) VALUES (?, ?, ?, ?, ?)`,
      [content_type, content_id, req.user.id, reason.trim(), details || null]
    );

    const [created] = await mysqlConnection.execute(`SELECT * FROM cp_reports WHERE id = ?`, [result.insertId]);

    // Live ping for connected Admin / SL Team clients watching the moderation queue
    emitToRoom('moderation:global', 'new_report', { report: created[0] });

    return successResponse(res, { report: created[0] }, 'Content reported. Our moderation team will review it shortly.', 201);
  } catch (error) {
    console.error('Report content error:', error);
    return errorResponse(res, 'Failed to submit report', 500);
  }
});

// ---- Everything below is Admin / SL Team only ----
router.use((req, res, next) => {
  if (!isCommunityModerator(req.user)) {
    return errorResponse(res, 'Only Admin / SL Team can access community moderation tools', 403);
  }
  next();
});

// ================= LIST REPORTS =================
// @route   GET /api/community-portal/moderation/reports
// @query   page, limit, status
router.get('/reports', async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const { page, limit, offset } = getPagination(req);
    const { status = 'pending' } = req.query;

    const [reports] = await mysqlConnection.execute(
      `SELECT r.*, u.first_name AS reporter_first_name, u.last_name AS reporter_last_name
       FROM cp_reports r
       JOIN users u ON r.reported_by = u.id
       WHERE r.status = ?
       ORDER BY r.created_at DESC
       LIMIT ? OFFSET ?`,
      [status, limit, offset]
    );

    return successResponse(res, { reports, page, limit }, 'Reports retrieved successfully');
  } catch (error) {
    console.error('List reports error:', error);
    return errorResponse(res, 'Failed to retrieve reports', 500);
  }
});

// ================= RESOLVE A REPORT =================
// @route   PUT /api/community-portal/moderation/reports/:id
// body: { status: 'dismissed' | 'action_taken', resolution_note? }
router.put('/reports/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, resolution_note } = req.body;

    if (!['reviewed', 'dismissed', 'action_taken'].includes(status)) {
      return errorResponse(res, 'status must be one of: reviewed, dismissed, action_taken', 400);
    }

    const mysqlConnection = getMySQLConnection();
    const [reports] = await mysqlConnection.execute(`SELECT * FROM cp_reports WHERE id = ?`, [id]);
    if (reports.length === 0) return errorResponse(res, 'Report not found', 404);

    await mysqlConnection.execute(
      `UPDATE cp_reports SET status = ?, resolution_note = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?`,
      [status, resolution_note || null, req.user.id, id]
    );

    return successResponse(res, null, 'Report updated successfully');
  } catch (error) {
    console.error('Resolve report error:', error);
    return errorResponse(res, 'Failed to update report', 500);
  }
});

// ================= HIDE CONTENT =================
// @route   POST /api/community-portal/moderation/content/hide
// body: { content_type, content_id }
router.post('/content/hide', async (req, res) => {
  try {
    const { content_type, content_id } = req.body;
    const mapping = CONTENT_TABLE_MAP[content_type];
    if (!mapping) return errorResponse(res, 'Unsupported content_type for hiding', 400);

    const mysqlConnection = getMySQLConnection();
    const column = content_type === 'group' ? 'is_active' : 'is_hidden';
    const value = content_type === 'group' ? false : true;

    const [result] = await mysqlConnection.execute(
      `UPDATE ${mapping.table} SET ${column} = ? WHERE id = ?`,
      [value, content_id]
    );

    if (result.affectedRows === 0) return errorResponse(res, 'Content not found', 404);
    emitToRoom('moderation:global', 'content_moderated', { content_type, content_id, action: 'hidden' });
    return successResponse(res, null, 'Content hidden successfully');
  } catch (error) {
    console.error('Hide content error:', error);
    return errorResponse(res, 'Failed to hide content', 500);
  }
});

// ================= RESTORE (UNHIDE) CONTENT =================
// @route   POST /api/community-portal/moderation/content/restore
// body: { content_type, content_id }
router.post('/content/restore', async (req, res) => {
  try {
    const { content_type, content_id } = req.body;
    const mapping = CONTENT_TABLE_MAP[content_type];
    if (!mapping) return errorResponse(res, 'Unsupported content_type for restoring', 400);

    const mysqlConnection = getMySQLConnection();
    const column = content_type === 'group' ? 'is_active' : 'is_hidden';
    const value = content_type === 'group' ? true : false;

    const [result] = await mysqlConnection.execute(
      `UPDATE ${mapping.table} SET ${column} = ? WHERE id = ?`,
      [value, content_id]
    );

    if (result.affectedRows === 0) return errorResponse(res, 'Content not found', 404);
    emitToRoom('moderation:global', 'content_moderated', { content_type, content_id, action: 'restored' });
    return successResponse(res, null, 'Content restored successfully');
  } catch (error) {
    console.error('Restore content error:', error);
    return errorResponse(res, 'Failed to restore content', 500);
  }
});

// ================= PERMANENTLY REMOVE CONTENT =================
// @route   DELETE /api/community-portal/moderation/content
// body: { content_type, content_id }
router.delete('/content', async (req, res) => {
  try {
    const { content_type, content_id } = req.body;
    const mapping = CONTENT_TABLE_MAP[content_type];
    if (!mapping) return errorResponse(res, 'Unsupported content_type for removal', 400);

    const mysqlConnection = getMySQLConnection();

    if (mapping.hasStatus) {
      await mysqlConnection.execute(`UPDATE ${mapping.table} SET status = 'removed', deleted_at = NOW() WHERE id = ?`, [content_id]);
    } else if (content_type === 'group') {
      await mysqlConnection.execute(`UPDATE ${mapping.table} SET is_active = FALSE WHERE id = ?`, [content_id]);
    } else {
      await mysqlConnection.execute(`UPDATE ${mapping.table} SET deleted_at = NOW() WHERE id = ?`, [content_id]);
    }

    emitToRoom('moderation:global', 'content_moderated', { content_type, content_id, action: 'removed' });
    return successResponse(res, null, 'Content removed successfully');
  } catch (error) {
    console.error('Remove content error:', error);
    return errorResponse(res, 'Failed to remove content', 500);
  }
});

// ================= COMMUNITY MODERATION DASHBOARD SUMMARY =================
// @route   GET /api/community-portal/moderation/summary
router.get('/summary', async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    const [[posts]] = await mysqlConnection.execute(`SELECT COUNT(*) AS total FROM cp_posts WHERE status = 'active'`);
    const [[threads]] = await mysqlConnection.execute(`SELECT COUNT(*) AS total FROM cp_discussion_threads WHERE status = 'active'`);
    const [[groups]] = await mysqlConnection.execute(`SELECT COUNT(*) AS total FROM cp_groups WHERE is_active = TRUE`);
    const [[prayers]] = await mysqlConnection.execute(`SELECT COUNT(*) AS total FROM cp_prayer_intentions WHERE deleted_at IS NULL`);
    const [[pendingReports]] = await mysqlConnection.execute(`SELECT COUNT(*) AS total FROM cp_reports WHERE status = 'pending'`);

    return successResponse(res, {
      total_posts: posts.total,
      total_discussion_threads: threads.total,
      total_groups: groups.total,
      total_prayer_intentions: prayers.total,
      pending_reports: pendingReports.total
    }, 'Moderation summary retrieved successfully');
  } catch (error) {
    console.error('Moderation summary error:', error);
    return errorResponse(res, 'Failed to retrieve moderation summary', 500);
  }
});

module.exports = router;
