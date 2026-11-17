// app.js - COMPLETE WORKING CODE
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const timeout = require('express-timeout-handler');
const path = require('path');
const fs = require('fs'); 
const { auth } = require('./middleware/auth');
const globalActivityLogger = require('./middleware/globalActivityLogger');
require('dotenv').config();
const { uploadAnyFile } = require('./config/s3');
const { getMySQLConnection } = require("./config/mysql")
const XLSX = require("xlsx");

// Import database connections
const { connectMySQL } = require('./config/mysql');

// Import routes
const authRoutes = require('./routes/auth');
const subscriptionRoutes = require('./routes/subscriptions');
const stripeRoutes = require('./routes/stripe');
const composerApplicationRoutes = require('./routes/composer-applications');
const composerToolsRoutes = require('./routes/composer-tools');
const musicPublicationRoutes = require('./routes/music-publications');
const composerProfileRoutes = require('./routes/composer-profile');
const collectionsRoutes = require('./routes/collections');
const musicFolderRoutes = require('./routes/music-folder');
const reviewBoardRoutes = require('./routes/review-board');
const filtersRoutes = require('./routes/filters');
const filter2Routes = require('./routes/filters2');
const songsRoutes = require('./routes/songs');
const userMusicLibraryRoutes = require('./routes/user-music-library');
const ministryPlansRoutes = require('./routes/ministry-plans');
const paymentRoutes = require('./routes/payment');
const adminPayerRoutes = require('./routes/adminPayment');
const supportContactRoutes = require('./routes/support-contact');
// const userManagementRoutes = require('./routes/user-management');
// const rolesPermissionsRoutes = require('./routes/roles-permissions');
const rolesPermissionsRoutes = require('./routes/Roles-Permissions/main');

// const dioceseRoutes = require('./routes/diocese');
const dioceseRoutes = require('./routes/diocesan-management.js/main');
const agreementManagementRoutes = require('./routes/Agreement-PaymentMethods/main');
const communityMusicLibraryRoutes = require('./routes/community-music-library');
const notificationRoutes = require('./routes/notifcation')
const bulkmusic = require('./routes/bulk-music')
const plannerRoutes = require('./routes/Planner/main');
const activityHistoryRoutes = require('./routes/activity-history');
const bulkUser = require("./routes/bulk-user");
const couponRoutes = require("./routes/coupon.routes");
const hymnalMusicLibraryRoutes = require('./routes/hymnal-music-library');
const documentRoutes = require("./routes/Document-Portal/document")
const educatorRoutes = require("./routes/Educator-Portal/main")

const { successResponse, errorResponse } = require('./utils/response');

const app = express();
const PORT = process.env.PORT || 5000;

// Security middleware
app.use(helmet());
app.use(cors());

// Logging middleware
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
// app.use('/api/user-music-library/webhook',express.raw({ type: 'application/json' }))
app.use(express.json());
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static("public"));

// Timeout configuration
const timeoutOptions = {
  timeout: 120 * 1000, // 2 minutes (120 seconds)
  onTimeout: function (req, res) {
    console.error(`⏰ Request timeout on ${req.method} ${req.path}`);
    res.status(408).json({
      success: false,
      message: 'Request timeout - Server took too long to respond',
      timestamp: new Date().toISOString(),
      timeout: '120 seconds'
    });
  },
  onDelayedResponse: function (req, method, args, requestTime) {
    console.warn(`⚠️ Delayed response detected: ${req.method} ${req.path} took ${requestTime}ms`);
  }
};

// Use timeout middleware BEFORE routes (very important!)
app.use(timeout.handler(timeoutOptions));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    timeout: '120 seconds'
  });
});

// 🎯 CONDITIONAL AUTH MIDDLEWARE - Yeh auth check karega but fail nahi karega
const conditionalAuth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
      // No token, continue without user
      return next();
    }

    const jwt = require('jsonwebtoken');
    const jwtSecret = process.env.JWT_SECRET || 'your-super-secret-jwt-key-for-sl-music-backend-2024';

    try {
      const decoded = jwt.verify(token, jwtSecret);
      const mysqlConnection = getMySQLConnection();

      const [users] = await mysqlConnection.execute(
        'SELECT * FROM users WHERE id = ?',
        [decoded.userId]
      );

      if (users.length > 0 && users[0].is_active) {
        req.user = users[0];
      }
    } catch (jwtError) {
      // Invalid/expired token - continue without user
      console.log('Invalid token, continuing without user');
    }

    next();
  } catch (error) {
    console.error('Conditional auth error:', error);
    next();
  }
};


/* ============================================================
UTIL → get diocese id of logged user
============================================================ */
async function getDioceseId(mysql, userId) {
  const [[row]] = await mysql.execute(
    `SELECT id FROM dioceses WHERE user_id=?`,
    [userId]
  );
  return row?.id;
}


/* ============================================================
1️⃣ LIST PARISHES
============================================================ */
app.get("/parishes", auth, async (req, res) => {
  try {
    const mysql = getMySQLConnection();

    let dioceseId;

    if (req.user.user_type === "superadmin") {
      dioceseId = req.query.diocese_id;
    } else {
      dioceseId = await getDioceseId(mysql, req.user.id);
    }

    if (!dioceseId)
      return errorResponse(res, "Diocese not found", 404);

    const [rows] = await mysql.execute(
      `SELECT dp.*, u.email
     FROM diocesan_parishes dp
     JOIN users u ON dp.user_id = u.id
     WHERE dp.diocese_id=?`,
      [dioceseId]
    );

    return successResponse(res, rows);

  } catch (e) {
    return errorResponse(res, e.message, 500);
  }
});


// 🔥 Order is IMPORTANT
app.use(conditionalAuth);
app.use(globalActivityLogger);
app.use("/api/activity-history", require("./routes/activity-history"));

// API routes

app.use('/api',documentRoutes);

app.use('/api/auth', authRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/composer-applications', composerApplicationRoutes);
app.use('/api/composer-tools', composerToolsRoutes);
app.use('/api/music-publications', musicPublicationRoutes);
app.use('/api/composer-profile', composerProfileRoutes);
app.use('/api/collections', collectionsRoutes);
app.use('/api/music-folders', musicFolderRoutes);
app.use('/api/review-board', reviewBoardRoutes);
app.use('/api/filters', filtersRoutes);
app.use('/api/filters', filter2Routes);
app.use('/api/songs', songsRoutes);
app.use('/api/user-music-library', userMusicLibraryRoutes);
app.use('/api/plans', ministryPlansRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin/payments', adminPayerRoutes);
app.use('/api/support-contact', supportContactRoutes);
app.use('/api/roles-permissions', rolesPermissionsRoutes);
app.use('/api/diocese', dioceseRoutes);
app.use('/api/agreements', agreementManagementRoutes);
app.use('/api/community-music-library', communityMusicLibraryRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/bulk-music', bulkmusic);
app.use('/api/planners', plannerRoutes);
app.use('/api/activity-history', activityHistoryRoutes);
app.use('/api/bulk-users', bulkUser)
app.use('/api/coupons', couponRoutes);
app.use('/api/hymnal-music', hymnalMusicLibraryRoutes);
app.use('/api/educator', educatorRoutes);

/** ========================  Global Routes Start   ======================== */
// @route GET /one-license-excel
// @desc    Get all published music excel sheet for one licence
// @access Private
app.get('/one-license-excel', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    // Build WHERE parts dynamically: always include status = 'published'
    const whereParts = ["status = 'published'", "includeInOneLicense = 1"];

    // If table has deleted_at column, exclude soft-deleted rows
    try {
      const [colCheck] = await mysqlConnection.execute(
        "SHOW COLUMNS FROM music_publications LIKE 'deleted_at'"
      );
      if (Array.isArray(colCheck) && colCheck.length > 0) {
        whereParts.push("deleted_at IS NULL");
      }
    } catch (chkErr) {
      console.warn("Could not check deleted_at column; proceeding without deleted filter:", chkErr);
    }

    const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

    // Fetch only published publications (and not-deleted if column exists)
    const [rows] = await mysqlConnection.execute(
      `SELECT * FROM music_publications ${whereClause}`
    );

    const MASS_SETTING_PARTS = [
      { id: "penitential_act_i",          name: "Penitential Act I",          textCopyright: "Text excerpts from the English translation of the Roman Missal 2010, ICEL." },
      { id: "penitential_act_ii",         name: "Penitential Act II",         textCopyright: "Text excerpts from the English translation of the Roman Missal 2010, ICEL." },
      { id: "kyrie",                      name: "Kyrie",                      textCopyright: "English translation of Kyrie 1988, ELLC." },
      { id: "lord_have_mercy",            name: "Lord, Have Mercy",           textCopyright: "English translation of Lord, Have Mercy 1988, ELLC." },
      { id: "gloria",                     name: "Gloria",                     textCopyright: "Text excerpts from the English translation of the Roman Missal 2010, ICEL." },
      { id: "gospel_acclamation",         name: "Gospel Acclamation",         textCopyright: "The English translation of the Alleluia Verse from Lectionary for Mass 1969, 1981, 1997, ICEL." },
      { id: "lenten_gospel_acclamation",  name: "Lenten Gospel Acclamation",  textCopyright: "The English translation of the Lenten Gospel Acclamation from Lectionary for Mass 1969, 1981, 1997, ICEL." },
      { id: "prayers_of_the_faithful",    name: "Prayers of the Faithful",    textCopyright: "Text excerpts from the English translation of the Roman Missal 2010, ICEL." },
      { id: "holy",                       name: "Holy",                       textCopyright: "Text excerpts from the English translation of the Roman Missal 2010, ICEL." },
      { id: "memorial_acclamation_a",     name: "Memorial Acclamation A",     textCopyright: "Text excerpts from the English translation of the Roman Missal 2010, ICEL." },
      { id: "memorial_acclamation_b",     name: "Memorial Acclamation B",     textCopyright: "Text excerpts from the English translation of the Roman Missal 2010, ICEL." },
      { id: "memorial_acclamation_c",     name: "Memorial Acclamation C",     textCopyright: "Text excerpts from the English translation of the Roman Missal 2010, ICEL." },
      { id: "doxology_and_great_amen",    name: "Doxology and Great Amen",    textCopyright: "Text excerpts from the English translation of the Roman Missal 2010, ICEL." },
      { id: "lords_prayer",               name: "The Lord's Prayer",          textCopyright: "Text excerpts from the English translation of the Roman Missal 2010, ICEL." },
      { id: "lamb_of_god",                name: "Lamb of God",                textCopyright: "English translation of Lamb of God 1988, ELLC." }
    ];

    const buildRows = (pub) => {

      // ── Parse artists safely ──────────────────────────────────────────────
      let artists = [];
      try {
        if (pub.artists) {
          artists = typeof pub.artists === "string" ? JSON.parse(pub.artists) : pub.artists;
        }
      } catch (e) {
        artists = [];
      }

      // ── FIX: Parse copyright year — supports both array and object format ─
      // Array format:  [{"year":2017,"name":"Ephrem"}]
      // Object format: {"year":2017}
      let copyrightYear = "";
      try {
        if (pub.composition_copyrights) {
          const cp = typeof pub.composition_copyrights === "string"
            ? JSON.parse(pub.composition_copyrights)
            : pub.composition_copyrights;

          if (Array.isArray(cp)) {
            // Extract year from each entry and join (e.g. "2017, 2020")
            copyrightYear = cp
              .map(c => c.year)
              .filter(Boolean)
              .join(", ");
          } else if (cp && typeof cp === "object") {
            copyrightYear = cp.year || "";
          }
        }
      } catch (e) {
        copyrightYear = "";
      }

      // ── FIX: Parse language — supports both array and JSON-string formats ─
      let parsedLanguage = "";
      try {
        let lang = pub.language;
        if (typeof lang === "string") {
          lang = JSON.parse(lang);
        }
        parsedLanguage = Array.isArray(lang) ? lang.join(", ") : lang || "";
      } catch (e) {
        // If JSON.parse fails just use the raw string value
        parsedLanguage = pub.language || "";
      }

      // ── Base row builder (one row per publication / per mass-part) ────────
      const baseRow = () => {
        const row = {};

        row["Unique ID"]      = pub.unique_id || "";
        // Title & Text Details are overwritten below for mass-setting entries
        row["Title"]          = pub.composition_title || "";
        row["Text Details"]   = pub.text_copyright_notice || "";

        // FIX: first_line_of_composition correctly mapped
        row["First line"]     = pub.first_line_of_composition || "";

        // FIX: year extracted from JSON array/object
        row["Copyright Year"] = copyrightYear;

        row["Song Type"]      = pub.song_type || "";

        // FIX: language array joined to comma-separated string
        row["Language"]       = parsedLanguage;

        row["Meter"]          = pub.meter || "";
        row["Season"]         = pub.season || "";
        row["Tune"]           = pub.tune || "";
        row["Psalm Number"]   = pub.psalm_number || "";
        row["General Details"]= pub.general_details || "";

        row["Tune Details"]         = pub.tune_copyright_notice || "";
        row["Country Restrictions"] = pub.country_restrictions || "";
        row["Is Public Domain"]     = pub.is_public_domain           ? "Yes" : "No";
        row["Can Be Reprinted"]     = pub.can_be_reprinted           ? "Yes" : "No";
        row["Can Be Podcast/Streamed"]         = pub.can_be_podcast_streamed        ? "Yes" : "No";
        row["Can Make Commercial Recording"]   = pub.can_make_commercial_recording  ? "Yes" : "No";
        row["Can Make Non-commercial Recording"] = pub.can_make_non_commercial_recording ? "Yes" : "No";

        for (let i = 0; i < 4; i++) {
          const a = artists[i] || {};

          row[`Artist${i + 1} Title`]      = a.title      || "";
          row[`Artist${i + 1} First name`] = a.first_name || "";

          let lastSuffix = a.last_name || "";
          if (a.suffix) lastSuffix += ` | ${a.suffix}`;
          row[`Artist${i + 1} Last | Artist${i + 1} Suffix`] = lastSuffix;

          row[`Artist${i + 1} Role`]       = a.role || "";
          row[`Artist${i + 1} Royalty Per`]= a.royalty_percentage ?? a.royalty_per ?? "";
        }

        return row;
      };

      // ── Handle mass-setting parts (one row per part) ──────────────────────
      let massParts = [];
      try {
        if (pub.mass_setting_parts) {
          const src = typeof pub.mass_setting_parts === "string"
            ? JSON.parse(pub.mass_setting_parts)
            : pub.mass_setting_parts;
          if (Array.isArray(src)) massParts = src;
        }
      } catch (e) {
        massParts = [];
      }

      if (Array.isArray(massParts) && massParts.length > 0) {
        return massParts.map((id) => {
          const def    = MASS_SETTING_PARTS.find((p) => p.id === id);
          const row    = baseRow();
          const titleBase = pub.composition_title || "";
          const partName  = def ? def.name : id;
          row["Title"]        = titleBase && partName ? `${titleBase} - ${partName}` : titleBase || partName || "";
          row["Text Details"] = (def && def.textCopyright) || pub.text_copyright_notice || "";
          return row;
        });
      }

      // ── Single-row publication ────────────────────────────────────────────
      const singleRow        = baseRow();
      singleRow["Title"]       = pub.composition_title || "";
      singleRow["Text Details"]= pub.text_copyright_notice || "";
      return [singleRow];
    };

    const formattedRows = Array.isArray(rows) ? rows.flatMap(buildRows) : [];

    // Column order fallback if no rows
    const columnOrder = formattedRows.length > 0
      ? Object.keys(formattedRows[0])
      : [
          'Unique ID', 'Title', 'First line', 'Copyright Year', 'Song Type',
          'Language', 'Meter', 'Season', 'Tune', 'Psalm Number', 'General Details',
          'Text Details', 'Tune Details', 'Country Restrictions',
          'Is Public Domain', 'Can Be Reprinted', 'Can Be Podcast/Streamed',
          'Can Make Commercial Recording', 'Can Make Non-commercial Recording',
          ...Array.from({ length: 4 }).flatMap((_, i) => {
            const n = i + 1;
            return [
              `Artist${n} Title`,
              `Artist${n} First name`,
              `Artist${n} Last | Artist${n} Suffix`,
              `Artist${n} Role`,
              `Artist${n} Royalty Per`
            ];
          })
        ];

    // Ensure every row has all columns (no missing keys)
    const orderedData = formattedRows.map(r => {
      const ord = {};
      columnOrder.forEach(k => { ord[k] = r[k] !== undefined ? r[k] : ""; });
      return ord;
    });

    // ── Create worksheet & workbook ───────────────────────────────────────
    const worksheet = XLSX.utils.json_to_sheet(orderedData, { header: columnOrder });
    worksheet['!cols'] = columnOrder.map((col) => {
      if (col.includes("Title") || col.includes("Details") || col.includes("General")) return { wch: 30 };
      if (col.includes("First line")) return { wch: 40 };
      if (col.includes("First name") || col.includes("Last"))                          return { wch: 20 };
      return { wch: 15 };
    });

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "OneLicense Info");

    // Buffer-only export — immediate download
    const buffer   = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    const filename = `one_license_published_${Date.now()}.xlsx`;

    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    return res.send(buffer);
  } catch (err) {
    console.error("Export PUBLISHED OneLicense error:", err);
    return res.status(500).json({ status: false, message: "Failed to export Excel" });
  }
});

/** ========================  Global Routes Start   ======================== */
// @route GET /export-music
// @desc    Get all published music excel sheet
// @access Private
app.get('/export-music', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    // Build WHERE parts dynamically: always include status = 'published'
    const whereParts = ["status = 'published'"];

    // If table has deleted_at column, exclude soft-deleted rows
    try {
      const [colCheck] = await mysqlConnection.execute(
        "SHOW COLUMNS FROM music_publications LIKE 'deleted_at'"
      );
      if (Array.isArray(colCheck) && colCheck.length > 0) {
        whereParts.push("deleted_at IS NULL");
      }
    } catch (chkErr) {
      console.warn("Could not check deleted_at column; proceeding without deleted filter:", chkErr);
    }

    const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

    // Fetch only published publications (and not-deleted if column exists)
    const [rows] = await mysqlConnection.execute(
      `SELECT * FROM music_publications ${whereClause}`
    );

    const MASS_SETTING_PARTS = [
      { id: "penitential_act_i",         name: "Penitential Act I",         textCopyright: "Text excerpts from the English translation of the Roman Missal 2010, ICEL." },
      { id: "penitential_act_ii",        name: "Penitential Act II",        textCopyright: "Text excerpts from the English translation of the Roman Missal 2010, ICEL." },
      { id: "kyrie",                     name: "Kyrie",                     textCopyright: "English translation of Kyrie 1988, ELLC." },
      { id: "lord_have_mercy",           name: "Lord, Have Mercy",          textCopyright: "English translation of Lord, Have Mercy 1988, ELLC." },
      { id: "gloria",                    name: "Gloria",                    textCopyright: "Text excerpts from the English translation of the Roman Missal 2010, ICEL." },
      { id: "gospel_acclamation",        name: "Gospel Acclamation",        textCopyright: "The English translation of the Alleluia Verse from Lectionary for Mass 1969, 1981, 1997, ICEL." },
      { id: "lenten_gospel_acclamation", name: "Lenten Gospel Acclamation", textCopyright: "The English translation of the Lenten Gospel Acclamation from Lectionary for Mass 1969, 1981, 1997, ICEL." },
      { id: "prayers_of_the_faithful",   name: "Prayers of the Faithful",   textCopyright: "Text excerpts from the English translation of the Roman Missal 2010, ICEL." },
      { id: "holy",                      name: "Holy",                      textCopyright: "Text excerpts from the English translation of the Roman Missal 2010, ICEL." },
      { id: "memorial_acclamation_a",    name: "Memorial Acclamation A",    textCopyright: "Text excerpts from the English translation of the Roman Missal 2010, ICEL." },
      { id: "memorial_acclamation_b",    name: "Memorial Acclamation B",    textCopyright: "Text excerpts from the English translation of the Roman Missal 2010, ICEL." },
      { id: "memorial_acclamation_c",    name: "Memorial Acclamation C",    textCopyright: "Text excerpts from the English translation of the Roman Missal 2010, ICEL." },
      { id: "doxology_and_great_amen",   name: "Doxology and Great Amen",   textCopyright: "Text excerpts from the English translation of the Roman Missal 2010, ICEL." },
      { id: "lords_prayer",              name: "The Lord's Prayer",         textCopyright: "Text excerpts from the English translation of the Roman Missal 2010, ICEL." },
      { id: "lamb_of_god",               name: "Lamb of God",               textCopyright: "English translation of Lamb of God 1988, ELLC." }
    ];

    const buildRows = (pub) => {

      // ── Parse artists safely ──────────────────────────────────────────────
      let artists = [];
      try {
        if (pub.artists) {
          artists = typeof pub.artists === "string" ? JSON.parse(pub.artists) : pub.artists;
        }
      } catch (e) {
        artists = [];
      }

      // ── FIX: Parse copyright year — supports both array and object format ─
      // Array format:  [{"year":2017,"name":"Ephrem"}]
      // Object format: {"year":2017}
      let copyrightYear = "";
      try {
        if (pub.composition_copyrights) {
          const cp = typeof pub.composition_copyrights === "string"
            ? JSON.parse(pub.composition_copyrights)
            : pub.composition_copyrights;

          if (Array.isArray(cp)) {
            // Extract year from each entry and join (e.g. "2017, 2020")
            copyrightYear = cp
              .map(c => c.year)
              .filter(Boolean)
              .join(", ");
          } else if (cp && typeof cp === "object") {
            copyrightYear = cp.year || "";
          }
        }
      } catch (e) {
        copyrightYear = "";
      }

      // ── FIX: Parse language — supports both array and JSON-string formats ─
      let parsedLanguage = "";
      try {
        let lang = pub.language;
        if (typeof lang === "string") {
          lang = JSON.parse(lang);
        }
        parsedLanguage = Array.isArray(lang) ? lang.join(", ") : lang || "";
      } catch (e) {
        // If JSON.parse fails just use the raw string value
        parsedLanguage = pub.language || "";
      }

      // ── Base row builder (one row per publication / per mass-part) ────────
      const baseRow = () => {
        const row = {};

        row["Music ID"]       = pub.id || "";
        // ONE LICENSE ID: only populate if includeInOneLicense is true
        row["ONE LICENSE ID"] = pub.includeInOneLicense ? (pub.unique_id || "") : "";

        // Title & Text Details are overwritten below for mass-setting entries
        row["Title"]          = pub.composition_title || "";
        row["Text Details"]   = pub.text_copyright_notice || "";

        // FIX: first_line_of_composition correctly mapped
        row["First line"]     = pub.first_line_of_composition || "";

        // FIX: year extracted from JSON array/object
        row["Copyright Year"] = copyrightYear;

        row["Song Type"]      = pub.song_type || "";

        // FIX: language array joined to comma-separated string
        row["Language"]       = parsedLanguage;

        row["Meter"]          = pub.meter || "";
        row["Season"]         = pub.season || "";
        row["Tune"]           = pub.tune || "";
        row["Psalm Number"]   = pub.psalm_number || "";
        row["General Details"]= pub.general_details || "";

        row["Tune Details"]            = pub.tune_copyright_notice || "";
        row["Country Restrictions"]    = pub.country_restrictions || "";
        row["Is Public Domain"]        = pub.is_public_domain                ? "Yes" : "No";
        row["Can Be Reprinted"]        = pub.can_be_reprinted                ? "Yes" : "No";
        row["Can Be Podcast/Streamed"] = pub.can_be_podcast_streamed         ? "Yes" : "No";
        row["Can Make Commercial Recording"]     = pub.can_make_commercial_recording     ? "Yes" : "No";
        row["Can Make Non-commercial Recording"] = pub.can_make_non_commercial_recording ? "Yes" : "No";

        for (let i = 0; i < 4; i++) {
          const a = artists[i] || {};

          row[`Artist${i + 1} Title`]      = a.title      || "";
          row[`Artist${i + 1} First name`] = a.first_name || "";

          let lastSuffix = a.last_name || "";
          if (a.suffix) lastSuffix += ` | ${a.suffix}`;
          row[`Artist${i + 1} Last | Artist${i + 1} Suffix`] = lastSuffix;

          row[`Artist${i + 1} Role`]        = a.role || "";
          row[`Artist${i + 1} Royalty Per`] = a.royalty_percentage ?? a.royalty_per ?? "";
        }

        return row;
      };

      // ── Handle mass-setting parts (one row per part) ──────────────────────
      let massParts = [];
      try {
        if (pub.mass_setting_parts) {
          const src = typeof pub.mass_setting_parts === "string"
            ? JSON.parse(pub.mass_setting_parts)
            : pub.mass_setting_parts;
          if (Array.isArray(src)) massParts = src;
        }
      } catch (e) {
        massParts = [];
      }

      if (Array.isArray(massParts) && massParts.length > 0) {
        return massParts.map((id) => {
          const def       = MASS_SETTING_PARTS.find((p) => p.id === id);
          const row       = baseRow();
          const titleBase = pub.composition_title || "";
          const partName  = def ? def.name : id;
          row["Title"]        = titleBase && partName ? `${titleBase} - ${partName}` : titleBase || partName || "";
          row["Text Details"] = (def && def.textCopyright) || pub.text_copyright_notice || "";
          return row;
        });
      }

      // ── Single-row publication ────────────────────────────────────────────
      const singleRow         = baseRow();
      singleRow["Title"]        = pub.composition_title || "";
      singleRow["Text Details"] = pub.text_copyright_notice || "";
      return [singleRow];
    };

    const formattedRows = Array.isArray(rows) ? rows.flatMap(buildRows) : [];

    // Column order fallback if no rows
    const columnOrder = formattedRows.length > 0
      ? Object.keys(formattedRows[0])
      : [
          'Music ID', 'ONE LICENSE ID', 'Title', 'First line', 'Copyright Year',
          'Song Type', 'Language', 'Meter', 'Season', 'Tune', 'Psalm Number',
          'General Details', 'Text Details', 'Tune Details', 'Country Restrictions',
          'Is Public Domain', 'Can Be Reprinted', 'Can Be Podcast/Streamed',
          'Can Make Commercial Recording', 'Can Make Non-commercial Recording',
          ...Array.from({ length: 4 }).flatMap((_, i) => {
            const n = i + 1;
            return [
              `Artist${n} Title`,
              `Artist${n} First name`,
              `Artist${n} Last | Artist${n} Suffix`,
              `Artist${n} Role`,
              `Artist${n} Royalty Per`
            ];
          })
        ];

    // Ensure every row has all columns (no missing keys)
    const orderedData = formattedRows.map(r => {
      const ord = {};
      columnOrder.forEach(k => { ord[k] = r[k] !== undefined ? r[k] : ""; });
      return ord;
    });

    // ── Create worksheet & workbook ───────────────────────────────────────
    const worksheet = XLSX.utils.json_to_sheet(orderedData, { header: columnOrder });
    worksheet['!cols'] = columnOrder.map((col) => {
      if (col.includes("Title") || col.includes("Details") || col.includes("General")) return { wch: 30 };
      if (col.includes("First line")) return { wch: 40 };
      if (col.includes("First name") || col.includes("Last"))                          return { wch: 20 };
      return { wch: 15 };
    });

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Music Export");

    // Buffer-only export — immediate download
    const buffer   = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    const filename = `Musics_${Date.now()}.xlsx`;

    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    return res.send(buffer);
  } catch (err) {
    console.error("Export Music error:", err);
    return res.status(500).json({ status: false, message: "Failed to export Excel" });
  }
});

// @route POST /api/upload-file
// @desc    Get user payment methods
// @access Private
app.post('/api/upload-file', [
  auth,
  uploadAnyFile.array('file', 10)
], async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return errorResponse(res, 'No files uploaded', 400);
    }

    const uploadedFiles = req.files.map(file => ({
      fileUrl: file.location,
      fileSize: file.size,
      fileName: file.originalname,
      fileType: file.mimetype
    }));

    return successResponse(res, {
      totalFiles: uploadedFiles.length,
      files: uploadedFiles
    }, 'Files uploaded successfully');

  } catch (error) {
    console.error('File upload error:', error);
    return errorResponse(res, 'File upload failed', 500);
  }
});

const { chromium } = require("playwright");

app.post("/api/pdf/generate-pdf", async (req, res) => {
  // let browser;

  try {
    const { html, filename = "document.pdf" } = req.body;

    const browser = await chromium.launch({
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
      args: ["--no-sandbox"]
    });

    const page = await browser.newPage();

    await page.setContent(html, {
      waitUntil: "networkidle"
    });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: {
        top: "20mm",
        bottom: "20mm",
        left: "20mm",
        right: "20mm"
      }
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(pdfBuffer);

  } catch (err) {
    console.error("PDF error:", err);
    res.status(500).json({ error: err.message });

  }
});

/** ========================  Global Routes Ends   ======================== */

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
    availableRoutes: [
      'GET /health',
      'POST /api/auth/login',
      'GET /api/songs',
      'GET /api/music-publications/all-music',
      'GET /api/collections'
    ]
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('🚨 Server Error:', err.stack);

  // Handle timeout errors specifically
  if (err.code === 'TIMEOUT') {
    return res.status(408).json({
      success: false,
      message: 'Request timeout',
      timestamp: new Date().toISOString()
    });
  }

  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
    timestamp: new Date().toISOString(),
    ...(process.env.NODE_ENV === 'development' && {
      stack: err.stack,
      details: err
    })
  });
});

// Start server
const startServer = async () => {
  try {
    // Connect to MySQL database
    await connectMySQL();

    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🌍 Environment: ${process.env.NODE_ENV}`);
      console.log(`⏰ Request timeout: 120 seconds`);
      console.log(`📋 Available at: http://localhost:${PORT}`);
      // console.log(`✅ Activity logging enabled for authenticated users`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

module.exports = app;
