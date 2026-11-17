// routes/activity-history.js
const express = require('express');
const router = express.Router();
const { auth, requireSLTeamWithTypes } = require('../middleware/auth');
const { getMySQLConnection } = require('../config/mysql');
const { successResponse, errorResponse } = require('../utils/response');

const parseActivities = (rawActivities) => {
  let list = [];

  try {
    // Step 1: outer JSON parse
    list = typeof rawActivities === "string"
      ? JSON.parse(rawActivities)
      : rawActivities;

    if (!Array.isArray(list)) return [];

    // Step 2: inner string → object parse
    list = list
      .map((item) => {
        if (typeof item === "string") {
          try {
            return JSON.parse(item);
          } catch {
            return null;
          }
        }
        return item;
      })
      .filter(Boolean);

  } catch {
    list = [];
  }

  return list;
};

/**
 * =====================================================
 * HELPER – FORMAT ONE DAILY ROW
 * =====================================================
 */
function formatDailyRow(row) {
  // Parse activities (string | object safe)
  const activities = parseActivities(row.activities);

  // Device info
  let device = {};
  try {
    const d = typeof row.device_info === "string"
      ? JSON.parse(row.device_info)
      : row.device_info;

    device = {
      browser: d?.browser?.name || "Unknown",
      os: d?.os?.name || "Unknown"
    };
  } catch {
    device = {};
  }

  // Format activities
  const formattedActivities = activities.map((a, index) => ({
    index,
    time: a.time
      ? new Date(a.time).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true
      })
      : null,
    datetime: a.time || null,
    action: (a.action || a.method || "action").toUpperCase(),
    module: a.module || "system",
    api: a.api || null,
    page: a.frontend_page || null,
    entity: a.entity || null,
    payload: a.payload || null,
    status: a.status || "unknown"
  }));

  return {
    user: {
      id: row.user_id,
      name: `${row.first_name} ${row.last_name}`,
      email: row.email,
      role: row.user_type
    },
    log_date: row.log_date,
    device,
    ip_address: row.ip_address,
    activity_count: formattedActivities.length,
    activities: formattedActivities
  };
}

/**
 * =====================================================
 * GET /api/activity-history/daily
 * Admin – All users daily activities
 * =====================================================
 */
router.get("/daily", auth, async (req, res) => {
  try {
    if (!["admin", "superadmin"].includes(req.user.user_type)) {
      return errorResponse(res, "Access denied", 403);
    }

    const mysql = getMySQLConnection();

    const [rows] = await mysql.execute(`
      SELECT
        u.id AS user_id,
        u.first_name,
        u.last_name,
        u.email,
        u.user_type,
        l.log_date,
        l.device_info,
        l.ip_address,
        l.activities
      FROM user_activity_daily_logs l
      JOIN users u ON u.id = l.user_id
      ORDER BY l.log_date DESC, u.id DESC
    `);

    const data = rows.map((row) => formatDailyRow(row));

    return successResponse(res, {
      count: data.length,
      data
    });

  } catch (err) {
    console.error("❌ Activity daily error:", err);
    return errorResponse(res, "Failed to fetch activity logs");
  }
});

/**
 * =====================================================
 * GET /api/activity-history/user/:userId
 * Admin – Specific user daily activities
 * =====================================================
 */
router.get("/user/:userId", auth, async (req, res) => {
  try {
    if (!["admin", "superadmin"].includes(req.user.user_type)) {
      return errorResponse(res, "Access denied", 403);
    }
    const { userId } = req.params;
    const mysql = getMySQLConnection();

    const [rows] = await mysql.execute(`
      SELECT
        u.id AS user_id,
        u.first_name,
        u.last_name,
        u.email,
        u.user_type,
        l.log_date,
        l.device_info,
        l.ip_address,
        l.activities
      FROM user_activity_daily_logs l
      JOIN users u ON u.id = l.user_id
      WHERE u.id = ?
      ORDER BY l.log_date DESC
    `, [userId]);

    const data = rows.map((row) => formatDailyRow(row));

    return successResponse(res, {
      user_id: Number(userId),
      count: data.length,
      data
    });

  } catch (err) {
    console.error("❌ User activity error:", err);
    return errorResponse(res, "Failed to fetch user activity");
  }
});


/**
 * =====================================================
 * GET /api/activity-history/user/:userId/date/:date
 * Admin – Specific user, specific day activities
 * =====================================================
 */
router.get("/user/:userId/date/:date", auth, async (req, res) => {
  try {
    if (!["admin", "superadmin"].includes(req.user.user_type)) {
      return errorResponse(res, "Access denied", 403);
    }

    const { userId, date } = req.params;
    const mysql = getMySQLConnection();

    const [rows] = await mysql.execute(`
      SELECT
        u.id AS user_id,
        u.first_name,
        u.last_name,
        u.email,
        u.user_type,
        l.log_date,
        l.device_info,
        l.ip_address,
        l.activities
      FROM user_activity_daily_logs l
      JOIN users u ON u.id = l.user_id
      WHERE u.id = ? AND l.log_date = ?
      LIMIT 1
    `, [userId, date]);

    if (!rows.length) {
      return errorResponse(res, "No activity found for this date", 404);
    }

    const data = formatDailyRow(rows[0]);

    return successResponse(res, data);

  } catch (err) {
    console.error("❌ User day activity error:", err);
    return errorResponse(res, "Failed to fetch activity");
  }
});

module.exports = router;