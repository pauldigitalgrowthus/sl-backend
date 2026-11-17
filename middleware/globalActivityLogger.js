const { getMySQLConnection } = require("../config/mysql");
const UAParser = require("ua-parser-js");

// ===============================
// HELPERS
// ===============================

// MODULE DETECTOR
const detectModule = (path) => {
  if (!path) return "system";
  const base = path.replace("/api/", "").split("/")[0];
  return base ? base.replace(/-/g, "_") : "system";
};

// ACTION DETECTOR
const detectAction = (method, path) => {
  if (path.includes("/login")) return "login";
  if (path.includes("/register")) return "register";

  if (method === "POST") return "create";
  if (method === "PUT" || method === "PATCH") return "update";
  if (method === "DELETE") return "delete";
  if (method === "GET") return "view";

  return "action";
};

// ENTITY ID
const extractEntityId = (path, body, response) => {
  const idMatch = path?.match(/\/(\d+)/);
  if (idMatch) return Number(idMatch[1]);
  if (body?.id) return body.id;
  if (response?.data?.user?.id) return response.data.user.id;
  if (response?.data?.id) return response.data.id;
  return null;
};

// ===============================
// MAIN LOGGER
// ===============================
const globalActivityLogger = async (req, res, next) => {
  const originalJson = res.json.bind(res);
  let responseData = null;

  res.json = (data) => {
    responseData = data;
    return originalJson(data);
  };

  res.on("finish", async () => {
    try {
      const mysql = getMySQLConnection();

      const isLoginAPI =
        req.originalUrl.includes("/api/auth/login") &&
        req.method === "POST";

      const isRegisterAPI =
        req.originalUrl.includes("/api/auth/register") &&
        req.method === "POST";

      // USER ID (can be null)
      let userId = req.user?.id || null;

      // 🔥 AFTER LOGIN / REGISTER → USER ID FROM RESPONSE
      if (!userId && responseData?.success) {
        if (responseData?.data?.user?.id) {
          userId = responseData.data.user.id;
        }
      }

      // DEVICE
      const parser = new UAParser(req.headers["user-agent"]);
      const deviceInfo = parser.getResult();

      // IP
      const ip =
        req.headers["x-forwarded-for"]?.split(",")[0] ||
        req.socket.remoteAddress ||
        null;

      // STATUS
      const status =
        res.statusCode >= 400 || responseData?.success === false
          ? "failed"
          : "success";

      const logDate = new Date().toISOString().slice(0, 10);

      const module = detectModule(req.path);
      const action = detectAction(req.method, req.path);
      const entityId = extractEntityId(req.path, req.body, responseData);

      const activity = {
        time: new Date().toISOString(),
        method: req.method,
        api: req.originalUrl,
        module,
        action,
        frontend_page: req.headers["x-page"] || null,
        entity: {
          type: module,
          id: entityId
        },
        payload:
          req.method !== "GET" &&
          !isLoginAPI &&
          !isRegisterAPI
            ? req.body
            : null,
        status
      };

      // ❌ IF NO USER AND NOT AUTH API → SKIP
      if (!userId && !isLoginAPI && !isRegisterAPI) return;

      // 🔥 INSERT / UPDATE LOG
      await mysql.execute(
        `
        INSERT INTO user_activity_daily_logs
          (user_id, log_date, device_info, ip_address, activities)
        VALUES (?, ?, ?, ?, JSON_ARRAY(?))
        ON DUPLICATE KEY UPDATE
          activities = JSON_ARRAY_APPEND(activities, '$', ?)
        `,
        [
          userId || null, // 0 = anonymous
          logDate,
          JSON.stringify(deviceInfo),
          ip,
          JSON.stringify(activity),
          JSON.stringify(activity)
        ]
      );

    } catch (err) {
      console.error("❌ Activity Logger Error:", err.message);
    }
  });

  next();
};

module.exports = globalActivityLogger;