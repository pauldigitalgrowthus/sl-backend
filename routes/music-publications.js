const express = require("express");
const { randomUUID } = require("crypto");
const { getMySQLConnection } = require("../config/mysql");
const { auth, requireSLTeamWithTypes } = require("../middleware/auth");
const { requireAnyRole, requireComposerOrRole } = require("../middleware/roleAuth");
const { successResponse, errorResponse } = require("../utils/response");
const { musicUpload, artworkUpload, libraryImageUpload, getFileSizeFromS3, deleteFileFromS3 } = require("../config/s3");
const { pdfToPng } = require("pdf-to-png-converter");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { s3: s3Client, BUCKET_NAME } = require("../config/s3");
const {
  sendMusicSubmissionEmail,
  sendMusicReviewStatusStage1,
  getStage1ReviewTemplate,
  directorOfSLCReviewEmail,
  getDirectorOfSLCEditorialTemplate,
  publicationEmail,
  textualReviewEmail,
  sendEmail,
} = require("../utils/SendMailer");
const XLSX = require("xlsx");
const { createAndDeliverNotification } = require("../utils/notificationUtils");

const router = express.Router();

const REVIEW_BOARD_COMMENT_STATUSES = ["started", "in_progress", "completed"];

// Helper JSON parser to safely parse stored JSON/text fields
const parseJsonField = (value, fallback = null) => {
  if (!value && value !== 0) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (error) {
      console.warn("⚠️ Failed to parse JSON field, returning fallback", {
        value,
        error: error.message,
      });
      return fallback;
    }
  }
  return value ?? fallback;
};

const getSampleWatermarkSVG = (width, height) => {
  return Buffer.from(`
    <svg width="${width}" height="${height}">
      <style>
      .text {
        fill: #000000;
        font-size: 145px;
        font-weight: 800;
        font-family: Arial, Helvetica, sans-serif;
      }
      </style>
      <text
        x="50%"
        y="50%"
        text-anchor="middle"
        dominant-baseline="middle"
        transform="rotate(-45, ${width / 2}, ${height / 2})"
        class="text"
      >
        SAMPLE
      </text>
    </svg>
  `);
};

const requireSLTeamReviewAccess = (req, res, next) => {
  if (req.user?.role !== "sl_team") {
    return errorResponse(res, "SL Team access only", 403);
  }

  const allowed =
    req.user?.user_type === "superadmin" ||
    req.user?.user_type === "admin" ||
    hasBadge(req.user, "Review Board") ||
    hasBadge(req.user, "Director of SLC");

  if (!allowed) {
    return errorResponse(
      res,
      "Forbidden: Only Review Board badge can access review board lock",
      403,
    );
  }

  next();
};

// Helper function to check if user has a specific badge
const hasBadge = (user, badgeName) => {
  if (!user) return false;

  // Parse badges from user object
  let badges = [];
  if (user.badges) {
    try {
      badges =
        typeof user.badges === "string" ? JSON.parse(user.badges) : user.badges;
      if (!Array.isArray(badges)) badges = [];
    } catch (e) {
      badges = [];
    }
  }

  // Normalize badge names (handle both string and object formats)
  const normalizedBadges = badges.map((b) => {
    if (typeof b === "string") return b;
    if (b && typeof b === "object") return b.role_name || b.name || String(b);
    return String(b);
  });

  // Check if badge exists (case-insensitive comparison)
  return normalizedBadges.some(
    (b) => b && b.toString().toLowerCase() === badgeName.toLowerCase(),
  );
};

const parseEmails = (envVar) => {
  if (!envVar) return [];
  return envVar.split(",").map(e => e.trim()).filter(Boolean);
};

// Helper function to format music publication response
const formatMusicPublication = (pub) => {
  const parse = (field, def = null) => {
    if (!field) return def;
    if (typeof field !== "string") return field;
    try {
      return JSON.parse(field);
    } catch {
      return field;
    }
  };

  const bool = (val) => val === 1 || val === true;

  return {
    // =========================
    // BASIC
    // =========================
    id: pub.id,
    uniqueId: pub.unique_id,
    composerId: pub.composer_id,

    status: pub.status,
    toggle: pub.toggle,
    reviewStage: pub.review_stage,
    publishType: pub.publish_type,

    // =========================
    // COMPOSITION
    // =========================
    compositionTitle: pub.composition_title,
    compositionTitle1: pub.composition_title_1,
    compositionDescription: pub.composition_description,

    composerFirstName: pub.composer_firstname,
    composerLastName: pub.composer_lastname,

    // =========================
    // COLLECTION
    // =========================
    isPartOfCollection: bool(pub.is_part_of_collection),
    collectionId: pub.collection_id,
    collectionName: pub.collection_name,

    // =========================
    // MUSIC DETAILS
    // =========================
    vocalParts: parse(pub.vocal_parts, []),
    instrumentation: parse(pub.instrumentation, []),
    typesOfMusic: pub.types_of_music,

    // =========================
    // ONELICENSE
    // =========================
    firstLineOfComposition: pub.first_line_of_composition,
    compositionCopyrights: parse(pub.composition_copyrights, []),
    massSettingParts: parse(pub.mass_setting_parts, []),
    songType: pub.song_type,

    meter: pub.meter,
    season: pub.season,
    language: parse(pub.language, []),
    psalmNumber: pub.psalm_number,

    liturgicalText: pub.liturgicalText,
    verseStyle: pub.verseStyle,
    feast: parse(pub.feast),

    includeInOneLicense: bool(pub.includeInOneLicense),

    // =========================
    // COPYRIGHT
    // =========================
    textCopyrightNotice: pub.text_copyright_notice,
    tuneCopyrightNotice: pub.tune_copyright_notice,

    // =========================
    // ARTISTS
    // =========================
    artists: parse(pub.artists, []),

    // =========================
    // FILES
    // =========================
    musicFiles: parse(pub.music_files, []),
    musicVideoLink: pub.music_video_link,
    artworkFileUrl: pub.artwork_file_url,
    artworkFileSize: pub.artwork_file_size,

    // =========================
    // PRICING
    // =========================
    price: pub.price != null ? Number(pub.price) : null,
    isFree: bool(pub.is_free),

    // =========================
    // GENERAL
    // =========================
    tune: parse(pub.tune),
    generalDetails: pub.general_details,
    countryRestrictions: pub.country_restrictions,

    // =========================
    // USAGE PERMISSIONS
    // =========================
    isPublicDomain: bool(pub.is_public_domain),
    canBeReprinted: bool(pub.can_be_reprinted),
    canBePodcastStreamed: bool(pub.can_be_podcast_streamed),
    canMakeCommercialRecording: bool(pub.can_make_commercial_recording),
    canMakeNonCommercialRecording: bool(pub.can_make_non_commercial_recording),

    // =========================
    // TERMS
    // =========================
    termsAccepted: bool(pub.terms_accepted),
    termsAcceptedAt: pub.terms_accepted_at,

    // =========================
    // CONTRACT
    // =========================
    signedContractUrl: pub.signedContractUrl,
    signedContractUrlTime: pub.signedContractUrlTime,
    finalContract: pub.finalContract,
    finalContractTime: pub.finalContractTime,

    // =========================
    // STAGE 1
    // =========================
    stage1Decision: pub.stage1_decision,
    stage1ReviewedBy: pub.stage1_reviewed_by,
    stage1ReviewedAt: pub.stage1_reviewed_at,
    stage1Notes: pub.stage1_notes,
    stage1Reviews: parse(pub.stage1_reviews, []),
    stage1ReplacedFiles: parse(pub.stage1_replaced_files, []),
    stage1Comments: parse(pub.stage1_review_comments, []),

    // LOCK
    stage1ReviewLockStatus: pub.stage1_review_lock_status,
    stage1ReviewLockReviewerId: pub.stage1_review_lock_reviewer_id,
    stage1ReviewLockReviewerName: pub.stage1_review_lock_reviewer_name,
    stage1ReviewLockStartedAt: pub.stage1_review_lock_started_at,
    stage1ReviewLockCompletedAt: pub.stage1_review_lock_completed_at,

    // SLOT 1
    stage1Slot1Status: pub.stage1_slot1_status,
    stage1Slot1ReviewerId: pub.stage1_slot1_reviewer_id,
    stage1Slot1ReviewerName: pub.stage1_slot1_reviewer_name,
    stage1Slot1ReviewerRole: pub.stage1_slot1_reviewer_role,
    stage1Slot1StartedAt: pub.stage1_slot1_started_at,
    stage1Slot1CompletedAt: pub.stage1_slot1_completed_at,

    // SLOT 2
    stage1Slot2Status: pub.stage1_slot2_status,
    stage1Slot2ReviewerId: pub.stage1_slot2_reviewer_id,
    stage1Slot2ReviewerName: pub.stage1_slot2_reviewer_name,
    stage1Slot2ReviewerRole: pub.stage1_slot2_reviewer_role,
    stage1Slot2StartedAt: pub.stage1_slot2_started_at,
    stage1Slot2CompletedAt: pub.stage1_slot2_completed_at,

    // =========================
    // STAGE 2
    // =========================
    stage2Decision: pub.stage2_decision,
    stage2ReviewedBy: pub.stage2_reviewed_by,
    stage2ReviewedAt: pub.stage2_reviewed_at,
    stage2Notes: pub.stage2_notes,
    stage2ReplacedFiles: parse(pub.stage2_replaced_files, []),
    stage2Comments: parse(pub.stage2_comments, []),

    // =========================
    // STAGE 3
    // =========================
    stage3Decision: pub.stage3_decision,
    stage3ReviewedBy: pub.stage3_reviewed_by,
    stage3ReviewedAt: pub.stage3_reviewed_at,
    stage3Notes: pub.stage3_notes,
    stage3ReplacedFiles: parse(pub.stage3_replaced_files, []),
    stage3Comments: parse(pub.stage3_comments, []),
    stage3ComposerResubmissions: parse(pub.stage3_composer_resubmissions, []),

    // =========================
    // STAGE 4
    // =========================
    stage4Decision: pub.stage4_decision,
    stage4ReviewedBy: pub.stage4_reviewed_by,
    stage4ReviewedAt: pub.stage4_reviewed_at,
    stage4Notes: pub.stage4_notes,

    // =========================
    // LEGACY REVIEWS
    // =========================
    onelicenseVerifiedBy: pub.onelicense_verified_by,
    onelicenseVerifiedAt: pub.onelicense_verified_at,
    onelicenseVerificationNotes: pub.onelicense_verification_notes,

    adminReviewedBy: pub.admin_reviewed_by,
    adminReviewedAt: pub.admin_reviewed_at,
    adminReviewNotes: pub.admin_review_notes,

    slTeamReviewedBy: pub.sl_team_reviewed_by,
    slTeamReviewedAt: pub.sl_team_reviewed_at,
    slTeamReviewNotes: pub.sl_team_review_notes,

    rejectionReason: pub.rejection_reason,

    // =========================
    // PUBLISH
    // =========================
    publishedAt: pub.published_at,
    publishedBy: pub.published_by,

    scheduledDeletionAt: pub.scheduled_deletion_at,

    // =========================
    // EXTRA NEW FIELDS
    // =========================
    theme: parse(pub.theme),
    partOfMass: parse(pub.partOfMass),
    liturgicalSacrament: pub.liturgicalSacrament,

    // =========================
    // TIMESTAMPS
    // =========================
    createdAt: pub.created_at,
    updatedAt: pub.updated_at,
  };
};

const buildReviewHistory = (pub) => {
  const stage1Reviews = parseJsonField(pub.stage1_reviews, []);
  return {
    stage1: {
      decision: pub.stage1_decision,
      notes: pub.stage1_notes,
      reviewedBy: pub.stage1_reviewed_by,
      reviewedAt: pub.stage1_reviewed_at,
      reviews: Array.isArray(stage1Reviews) ? stage1Reviews : [],
      replacedFiles: parseJsonField(pub.stage1_replaced_files, []),
      comments: parseJsonField(pub.stage1_review_comments, []),
    },
    stage2: {
      decision: pub.stage2_decision,
      notes: pub.stage2_notes,
      reviewedBy: pub.stage2_reviewed_by,
      reviewedAt: pub.stage2_reviewed_at,
      replacedFiles: parseJsonField(pub.stage2_replaced_files, []),
      comments: parseJsonField(pub.stage2_comments, []),
    },
    stage3: {
      decision: pub.stage3_decision,
      notes: pub.stage3_notes,
      reviewedBy: pub.stage3_reviewed_by,
      reviewedAt: pub.stage3_reviewed_at,
      replacedFiles: parseJsonField(pub.stage3_replaced_files, []),
      composerResubmissions: parseJsonField(
        pub.stage3_composer_resubmissions,
        [],
      ),
    },
    stage4: {
      decision: pub.stage4_decision,
      notes: pub.stage4_notes,
      reviewedBy: pub.stage4_reviewed_by,
      reviewedAt: pub.stage4_reviewed_at,
    },
  };
};

const buildStage1ReviewSummary = (pub) => {
  const parsed = parseJsonField(pub.stage1_reviews, []);
  const reviews = Array.isArray(parsed) ? parsed : [];
  const approvals = reviews.filter(
    (entry) =>
      entry && ["approved", "accept_with_changes"].includes(entry.decision),
  ).length;
  const rejections = reviews.filter(
    (entry) => entry && entry.decision === "rejected",
  ).length;
  const awaitingDirector =
    reviews.length >= 2 &&
    !pub.stage2_decision &&
    (pub.review_stage === "review_board" ||
      pub.review_stage === "director_review");

  return {
    totalReviews: reviews.length,
    approvals,
    rejections,
    requiredApprovals: 2,
    awaitingDirector,
    reviews,
  };
};

// Helper: ensure a column exists on a table; if missing, add it as the provided type
async function ensureColumnExists(
  mysqlConnection,
  tableName,
  columnName,
  columnType,
) {
  try {
    const [cols] = await mysqlConnection.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [tableName, columnName],
    );
    if (cols.length === 0) {
      console.log(
        `🔧 Column ${columnName} missing on ${tableName}, attempting to add it (${columnType})`,
      );
      await mysqlConnection.execute(
        `ALTER TABLE \`${tableName}\` ADD COLUMN ${columnName} ${columnType} NULL`,
      );
      console.log(`✅ Added column ${columnName} to ${tableName}`);
    }
  } catch (err) {
    console.warn(
      `⚠️ Failed to ensure column ${columnName} on ${tableName}:`,
      err.message,
    );
    // don't throw: we want handlers to continue and return a useful error instead of crashing
  }
}

const multer = require("multer");
// const XLSX = require("xlsx");

const upload = multer({ storage: multer.memoryStorage() });

// =====================================================
// BULK UPLOAD MUSIC PUBLICATIONS
// =====================================================
router.post(
  "/bulk-upload",
  [auth, upload.single("file")],
  async (req, res) => {
    try {

      const mysqlConnection = getMySQLConnection();

      if (!req.file) {
        return errorResponse(res, "Excel file required", 400);
      }

      const workbook = XLSX.read(req.file.buffer, { type: "buffer" });

      const sheet = workbook.Sheets[workbook.SheetNames[0]];

      const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

      if (!rows.length) {
        return errorResponse(res, "Excel file empty", 400);
      }

      // =========================
      // HELPERS
      // =========================

      const boolConvert = (val) => {

        if (val === "Yes" || val === "yes") return 1;
        if (val === "No" || val === "no") return 0;

        if (val === true) return 1;
        if (val === false) return 0;

        if (val === 1 || val === 0) return val;

        return null;
      };

      const formatDate = (val) => {

        if (!val) return null;

        if (typeof val === "string" && val.includes("-")) {

          const [datePart, timePart] = val.split(" ");

          const [day, month, year] = datePart.split("-");

          return `${year}-${month}-${day} ${timePart || "00:00:00"}`;
        }

        return null;
      };

      // =========================
      // INSERT PROCESS
      // =========================

      let inserted = 0;
      let failed = [];

      for (let i = 0; i < rows.length; i++) {

        const row = rows[i];

        try {

          const columns = [];
          const placeholders = [];
          const values = [];

          Object.keys(row).forEach((key) => {

            if (key === "id") return;
            if (key.startsWith("__EMPTY")) return;

            let value = row[key];

            if (
              value === "" ||
              value === undefined ||
              value === "NULL" ||
              value === "null"
            ) {
              value = null;
            }

            // =========================
            // LANGUAGE FIX
            // =========================
            if (key === "language") {

              if (value && !value.startsWith("[")) {
                value = JSON.stringify([value]);
              }
            }

            // =========================
            // COPYRIGHT FIX
            // =========================
            if (key === "composition_copyrights") {

              const name = row.composer_firstname || "";

              if (value) {

                // already JSON
                if (typeof value === "string" && value.startsWith("[")) {
                  // keep as it is
                }

                // multiple year (2025,2026)
                else if (typeof value === "string" && value.includes(",")) {

                  const years = value.split(",").map(v => v.trim());

                  value = JSON.stringify(
                    years.map(y => ({
                      year: Number(y),
                      name
                    }))
                  );
                }

                // single year
                else {

                  const year = Number(value);

                  value = JSON.stringify([
                    {
                      year,
                      name
                    }
                  ]);
                }

              }
            }

            // =========================
            // SONG TYPE FIX
            // =========================
            if (key === "song_type") {

              if (value === "Words and Music")
                value = "words_and_music";

              if (value === "Music")
                value = "music";
            }

            // =========================
            // BOOLEAN
            // =========================
            if (
              [
                "is_part_of_collection",
                "is_free",
                "is_public_domain",
                "can_be_reprinted",
                "can_be_podcast_streamed",
                "can_make_commercial_recording",
                "can_make_non_commercial_recording",
                "terms_accepted",
                "includeInOneLicense"
              ].includes(key)
            ) {
              value = boolConvert(value);
            }

            // =========================
            // DATE
            // =========================
            if (
              [
                "terms_accepted_at",
                "published_at",
                "created_at",
                "updated_at"
              ].includes(key)
            ) {
              value = formatDate(value);
            }

            columns.push(key);
            placeholders.push("?");
            values.push(value);

          });

          const sql = `
            INSERT INTO music_publications
            (${columns.join(",")})
            VALUES
            (${placeholders.join(",")})
          `;

          await mysqlConnection.execute(sql, values);

          inserted++;

        } catch (err) {

          console.log("❌ INSERT FAILED ROW:", i);
          console.log("Error:", err.message);

          failed.push({
            rowIndex: i,
            error: err.message,
            row
          });

        }
      }

      return successResponse(
        res,
        {
          totalRows: rows.length,
          inserted,
          failedRows: failed.length,
          errors: failed
        },
        "Bulk upload completed"
      );

    } catch (error) {

      console.error("Bulk upload error:", error);

      return errorResponse(res, error.message, 500);
    }
  }
);

// @route   POST /api/music-publications
// @desc    Create new music publication (Composer or SL Team only)
// @access  Private (Composer or SL Team only)
router.post(
  "/",
  [
    auth,
    // requireComposerOrRole('sl_team')
    // requireAnyRole(['composer', 'sl_team'])
  ],
  async (req, res) => {
    try {
      const composerId = req.user.id;
      const mysqlConnection = getMySQLConnection();
      // Check if user already has a pending music publication
      // const [pendingPublications] = await mysqlConnection.execute(
      //   `
      //   SELECT
      //     id,
      //     composition_title,
      //     status,
      //     review_stage
      //   FROM music_publications
      //   WHERE composer_id = ?
      //     AND status NOT IN ('published', 'rejected')
      //   ORDER BY created_at DESC
      //   LIMIT 1
      //   `,
      //   [composerId]
      // );

      // if (pendingPublications.length > 0) {
      //   return errorResponse(
      //     res,
      //     `You already have a composition (${pendingPublications[0].composition_title})
      //     under review. Please wait until it is published or rejected before submitting another composition.`,
      //     400
      //   );
      // }
      // Always create new publication
      const compositionTitle = req.body.compositionTitle || "";

      const [result] = await mysqlConnection.execute(
        "INSERT INTO music_publications (composer_id, status, composition_title) VALUES (?, ?, ?)",
        [composerId, "draft", compositionTitle],
      );

      const publicationId = result.insertId;
      const isNewPublication = true;

      // Update publication with all provided data
      let updateFields = [];
      let updateValues = [];

      // Composition Information
      if (req.body.compositionTitle) {
        updateFields.push("composition_title = ?");
        updateValues.push(req.body.compositionTitle);
      }
      if (req.body.compositionDescription) {
        updateFields.push("composition_description = ?");
        updateValues.push(req.body.compositionDescription);
      }
      if (req.body.composerFirstName) {
        updateFields.push("composer_firstname = ?");
        updateValues.push(req.body.composerFirstName);
      }
      if (req.body.composerLastName) {
        updateFields.push("composer_lastname = ?");
        updateValues.push(req.body.composerLastName);
      }
      if (req.body.language) {
        updateFields.push("language = ?");
        updateValues.push(JSON.stringify(req.body.language));
      }
      if (req.body.signedContractUrl) {
        updateFields.push("signedContractUrl = ?");
        updateFields.push("signedContractUrlTime = NOW()");
        updateValues.push(req.body.signedContractUrl);
      }
      // Collection Information
      if (req.body.isPartOfCollection !== undefined) {
        updateFields.push("is_part_of_collection = ?");
        updateValues.push(req.body.isPartOfCollection);
      }
      if (req.body.theme !== undefined) {
        updateFields.push("theme = ?");
        const themeValue =
          Array.isArray(req.body.theme) || typeof req.body.theme === "object"
            ? JSON.stringify(req.body.theme)
            : req.body.theme;

        updateValues.push(themeValue);
      }

      if (req.body.partOfMass !== undefined) {
        updateFields.push("partOfMass = ?");
        const partOfMassValue =
          Array.isArray(req.body.partOfMass) || typeof req.body.partOfMass === "object"
            ? JSON.stringify(req.body.partOfMass)
            : req.body.partOfMass;

        updateValues.push(partOfMassValue);
      }
      if (req.body.liturgicalSacrament) {
        updateFields.push("liturgicalSacrament = ?");
        updateValues.push(req.body.liturgicalSacrament);
      }
      if (req.body.collectionId) {
        updateFields.push("collection_id = ?");
        updateValues.push(req.body.collectionId);
      }
      if (req.body.collectionName) {
        updateFields.push("collection_name = ?");
        updateValues.push(req.body.collectionName);
      }
      if (req.body.musicVideoLink) {
        updateFields.push("music_video_link = ?");
        updateValues.push(req.body.musicVideoLink);
      }

      if (req.body.type_of_music) {
        updateFields.push("type_of_music = ?");
        updateValues.push(req.body.type_of_music);
      }
      if (req.body.includeInOneLicense !== undefined) {
        updateFields.push("includeInOneLicense = ?");
        updateValues.push(req.body.includeInOneLicense ? 1 : 0);

        // 🔥 Generate unique_id ONLY when true
        if (req.body.includeInOneLicense) {

          let uniqueId;
          let isUnique = false;

          while (!isUnique) {
            // Generate 5 digit random number
            uniqueId = Math.floor(10000 + Math.random() * 90000).toString();

            const [existing] = await mysqlConnection.execute(
              "SELECT id FROM music_publications WHERE unique_id = ? LIMIT 1",
              [uniqueId]
            );

            if (existing.length === 0) {
              isUnique = true;
            }
          }

          updateFields.push("unique_id = ?");
          updateValues.push(uniqueId);
        }
      }
      if (req.body.feast) {
        updateFields.push("feast = ?");
        const feastValue =
          Array.isArray(req.body.feast) || typeof req.body.feast === "object"
            ? JSON.stringify(req.body.feast)
            : req.body.feast;
        updateValues.push(feastValue);
      }

      if (req.body.verseStyle) {
        updateFields.push("verseStyle = ?");
        const verseStyleValue =
          Array.isArray(req.body.verseStyle) ||
            typeof req.body.verseStyle === "object"
            ? JSON.stringify(req.body.verseStyle)
            : req.body.verseStyle;
        updateValues.push(verseStyleValue);
      }

      if (req.body.liturgicalText) {
        updateFields.push("liturgicalText = ?");
        const liturgicalTextValue =
          Array.isArray(req.body.liturgicalText) ||
            typeof req.body.liturgicalText === "object"
            ? JSON.stringify(req.body.liturgicalText)
            : req.body.liturgicalText;
        updateValues.push(liturgicalTextValue);
      }

      // Music Details - Handle as arrays for multi-select
      if (req.body.vocalParts) {
        updateFields.push("vocal_parts = ?");
        // Convert array to JSON string if it's an array, otherwise store as is
        const vocalPartsValue = Array.isArray(req.body.vocalParts)
          ? JSON.stringify(req.body.vocalParts)
          : req.body.vocalParts;
        updateValues.push(vocalPartsValue);
      }
      if (req.body.instrumentation) {
        updateFields.push("instrumentation = ?");
        // Convert array to JSON string if it's an array, otherwise store as is
        const instrumentationValue = Array.isArray(req.body.instrumentation)
          ? JSON.stringify(req.body.instrumentation)
          : req.body.instrumentation;
        updateValues.push(instrumentationValue);
      }
      if (req.body.typesOfMusic) {
        updateFields.push("types_of_music = ?");
        updateValues.push(req.body.typesOfMusic);
      }

      // OneLicense Information
      if (req.body.firstLineOfComposition) {
        updateFields.push("first_line_of_composition = ?");
        updateValues.push(req.body.firstLineOfComposition);
      }
      // Composition Copyrights - JSON array of copyright objects
      if (req.body.compositionCopyrights) {
        updateFields.push("composition_copyrights = ?");
        const copyrightsValue = Array.isArray(req.body.compositionCopyrights)
          ? JSON.stringify(req.body.compositionCopyrights)
          : req.body.compositionCopyrights;
        updateValues.push(copyrightsValue);
      }
      if (req.body.massSettingParts !== undefined) {
        updateFields.push("mass_setting_parts = ?");
        const msp = req.body.massSettingParts;
        const massSettingValue = Array.isArray(msp)
          ? JSON.stringify(msp)
          : typeof msp === "string" && msp.trim() !== ""
            ? msp
            : null;
        updateValues.push(massSettingValue);
      }
      if (req.body.songType) {
        updateFields.push("song_type = ?");
        updateValues.push(req.body.songType);
      }
      if (req.body.meter) {
        updateFields.push("meter = ?");
        updateValues.push(req.body.meter);
      }
      if (req.body.season) {
        updateFields.push("season = ?");
        updateValues.push(req.body.season);
      }
      if (req.body.psalmNumber) {
        updateFields.push("psalm_number = ?");
        updateValues.push(req.body.psalmNumber);
      }

      // Copyright Details
      if (req.body.textCopyrightNotice) {
        updateFields.push("text_copyright_notice = ?");
        updateValues.push(req.body.textCopyrightNotice);
      }
      if (req.body.tuneCopyrightNotice) {
        updateFields.push("tune_copyright_notice = ?");
        updateValues.push(req.body.tuneCopyrightNotice);
      }

      if (req.body.compositionTitle1) {
        updateFields.push("composition_title_1 = ?");
        updateValues.push(req.body.compositionTitle1);
      }

      // Artists - JSON array of artist objects
      if (req.body.artists) {
        updateFields.push("artists = ?");
        const artistsValue = Array.isArray(req.body.artists)
          ? JSON.stringify(req.body.artists)
          : req.body.artists;
        updateValues.push(artistsValue);
      }

      // File Uploads - Music Files (JSON array)
      if (req.body.musicFiles) {
        updateFields.push("music_files = ?");
        updateValues.push(JSON.stringify(req.body.musicFiles));
      }
      if (req.body.artworkFileUrl) {
        updateFields.push("artwork_file_url = ?");
        updateValues.push(req.body.artworkFileUrl);
      }
      if (req.body.artworkFileSize) {
        updateFields.push("artwork_file_size = ?");
        updateValues.push(req.body.artworkFileSize);
      }

      // General Details (All Optional)
      if (req.body.tune !== undefined) {
        updateFields.push("tune = ?");
        const tuneValue = req.body.tune;
        updateValues.push(
          tuneValue && typeof tuneValue === "string" && tuneValue.trim() !== ""
            ? tuneValue.trim()
            : null,
        );
      }
      if (req.body.generalDetails !== undefined) {
        updateFields.push("general_details = ?");
        const generalDetailsValue = req.body.generalDetails;
        updateValues.push(
          generalDetailsValue &&
            typeof generalDetailsValue === "string" &&
            generalDetailsValue.trim() !== ""
            ? generalDetailsValue.trim()
            : null,
        );
      }
      if (req.body.countryRestrictions !== undefined) {
        updateFields.push("country_restrictions = ?");
        const countryRestrictionsValue = req.body.countryRestrictions;
        updateValues.push(
          countryRestrictionsValue &&
            typeof countryRestrictionsValue === "string" &&
            countryRestrictionsValue.trim() !== ""
            ? countryRestrictionsValue.trim()
            : null,
        );
      }

      // Usage Permissions (All Optional - Boolean fields with default false)
      if (req.body.isPublicDomain !== undefined) {
        updateFields.push("is_public_domain = ?");
        updateValues.push(
          req.body.isPublicDomain === true ||
            req.body.isPublicDomain === "true" ||
            req.body.isPublicDomain === 1
            ? 1
            : 0,
        );
      }
      if (req.body.canBeReprinted !== undefined) {
        updateFields.push("can_be_reprinted = ?");
        updateValues.push(
          req.body.canBeReprinted === true ||
            req.body.canBeReprinted === "true" ||
            req.body.canBeReprinted === 1
            ? 1
            : 0,
        );
      }
      if (req.body.canBePodcastStreamed !== undefined) {
        updateFields.push("can_be_podcast_streamed = ?");
        updateValues.push(
          req.body.canBePodcastStreamed === true ||
            req.body.canBePodcastStreamed === "true" ||
            req.body.canBePodcastStreamed === 1
            ? 1
            : 0,
        );
      }
      if (req.body.canMakeCommercialRecording !== undefined) {
        updateFields.push("can_make_commercial_recording = ?");
        updateValues.push(
          req.body.canMakeCommercialRecording === true ||
            req.body.canMakeCommercialRecording === "true" ||
            req.body.canMakeCommercialRecording === 1
            ? 1
            : 0,
        );
      }
      if (req.body.canMakeNonCommercialRecording !== undefined) {
        updateFields.push("can_make_non_commercial_recording = ?");
        updateValues.push(
          req.body.canMakeNonCommercialRecording === true ||
            req.body.canMakeNonCommercialRecording === "true" ||
            req.body.canMakeNonCommercialRecording === 1
            ? 1
            : 0,
        );
      }

      // Terms & Conditions
      if (req.body.termsAccepted !== undefined) {
        if (req.body.termsAccepted) {
          updateFields.push("terms_accepted = ?, terms_accepted_at = NOW()");
          updateValues.push(req.body.termsAccepted);
        } else {
          updateFields.push("terms_accepted = ?");
          updateValues.push(req.body.termsAccepted);
        }
      }

      if (updateFields.length > 0) {
        updateFields.push("updated_at = NOW()");
        updateValues.push(publicationId);

        await mysqlConnection.execute(
          `UPDATE music_publications SET ${updateFields.join(", ")} WHERE id = ?`,
          updateValues,
        );
      }

      // Get updated publication
      const [publications] = await mysqlConnection.execute(
        "SELECT * FROM music_publications WHERE id = ?",
        [publicationId],
      );

      // Handle collection logic
      let collectionAdded = false;
      let collectionId = null;
      let collectionName = null;

      if (req.body.isPartOfCollection === true) {
        // Only add to SYSTEM collections when isPartOfCollection is true
        if (req.body.collectionId) {
          try {
            // Check if collection exists and is a SYSTEM collection
            const [collections] = await mysqlConnection.execute(
              "SELECT id, name FROM collections WHERE id = ? AND is_system_collection = TRUE",
              [req.body.collectionId],
            );

            if (collections.length > 0) {
              // Add music to system collection
              await mysqlConnection.execute(
                "INSERT INTO collection_music (collection_id, music_id) VALUES (?, ?)",
                [req.body.collectionId, publicationId],
              );
              collectionAdded = true;
              collectionId = req.body.collectionId;
              collectionName = collections[0].name;
              console.log(
                `Music ${publicationId} added to SYSTEM collection ${req.body.collectionId}`,
              );
            } else {
              console.log(
                `System collection ${req.body.collectionId} not found`,
              );
            }
          } catch (collectionError) {
            console.error(
              "Error adding music to system collection:",
              collectionError,
            );
            // Continue with publication creation even if collection addition fails
          }
        } else {
          console.log(
            "collectionId is required when isPartOfCollection is true",
          );
        }
      } else if (req.body.isPartOfCollection === false) {
        // Only add to USER collections when isPartOfCollection is false
        if (req.body.collectionId) {
          try {
            // Check if collection exists and is a USER collection
            const [collections] = await mysqlConnection.execute(
              "SELECT id, name FROM collections WHERE id = ? AND user_id = ? AND is_system_collection = FALSE",
              [req.body.collectionId, composerId],
            );

            if (collections.length > 0) {
              // Add music to user collection
              await mysqlConnection.execute(
                "INSERT INTO collection_music (collection_id, music_id) VALUES (?, ?)",
                [req.body.collectionId, publicationId],
              );
              collectionAdded = true;
              collectionId = req.body.collectionId;
              collectionName = collections[0].name;
              console.log(
                `Music ${publicationId} added to USER collection ${req.body.collectionId}`,
              );
            } else {
              console.log(
                `User collection ${req.body.collectionId} not found or access denied for user ${composerId}`,
              );
            }
          } catch (collectionError) {
            console.error(
              "Error adding music to user collection:",
              collectionError,
            );
            // Continue with publication creation even if collection addition fails
          }
        } else if (req.body.collectionName) {
          // Create new user collection and add music to it
          try {
            // Check if collection with same name already exists for this user
            const [existingCollections] = await mysqlConnection.execute(
              "SELECT id FROM collections WHERE user_id = ? AND name = ? AND is_system_collection = FALSE",
              [composerId, req.body.collectionName],
            );

            if (existingCollections.length > 0) {
              // Use existing user collection
              collectionId = existingCollections[0].id;
              collectionName = req.body.collectionName;
            } else {
              // Create new user collection
              const [collectionResult] = await mysqlConnection.execute(
                "INSERT INTO collections (name, description, user_id, is_system_collection, created_by) VALUES (?, ?, ?, ?, ?)",
                [
                  req.body.collectionName,
                  req.body.collectionDescription || null,
                  composerId,
                  false,
                  "user",
                ],
              );
              collectionId = collectionResult.insertId;
              collectionName = req.body.collectionName;
              console.log(
                `New USER collection created with ID: ${collectionId}`,
              );
            }

            // Add music to user collection
            await mysqlConnection.execute(
              "INSERT INTO collection_music (collection_id, music_id) VALUES (?, ?)",
              [collectionId, publicationId],
            );
            collectionAdded = true;
            console.log(
              `Music ${publicationId} added to USER collection ${collectionId}`,
            );
          } catch (collectionError) {
            console.error(
              "Error creating user collection or adding music:",
              collectionError,
            );
            // Continue with publication creation even if collection addition fails
          }
        }
      }

      // Send email notifications to Review Board and Composer when publication is created
      try {
        const publication = publications[0];

        // Get composer details
        const [composerUser] = await mysqlConnection.execute(
          "SELECT first_name, last_name, email FROM users WHERE id = ?",
          [composerId],
        );

        const composer = composerUser[0];
        const composerFirstName =
          composer?.first_name || publication.composer_firstname || "Composer";
        const composerEmail = composer?.email;

        if (composerEmail) {
          // Format all publication details as "allAnswers"
          const allAnswers = `
Composition Title: ${publication.composition_title || "N/A"}
Composer: ${publication.composer_firstname || ""} ${publication.composer_lastname || ""}
Description: ${publication.composition_description || "N/A"}
Tune: ${publication.tune || "N/A"}
General Details: ${publication.general_details || "N/A"}
Country Restrictions: ${publication.country_restrictions || "N/A"}
Is Public Domain: ${publication.is_public_domain ? "Yes" : "No"}
Can Be Reprinted: ${publication.can_be_reprinted ? "Yes" : "No"}
Can Be Podcast/Streamed: ${publication.can_be_podcast_streamed ? "Yes" : "No"}
Can Make Commercial Recording: ${publication.can_make_commercial_recording ? "Yes" : "No"}
Can Make Non-commercial Recording: ${publication.can_make_non_commercial_recording ? "Yes" : "No"}
First Line of Composition: ${publication.first_line_of_composition || "N/A"}
Song Type: ${publication.song_type || "N/A"}
Meter: ${publication.meter || "N/A"}
Season: ${publication.season || "N/A"}
Psalm Number: ${publication.psalm_number || "N/A"}
Created At: ${new Date().toLocaleString()}
        `.trim();

          // Prepare attachments from music_files if available
          let attachments = [];
          if (publication.music_files) {
            try {
              const musicFiles =
                typeof publication.music_files === "string"
                  ? JSON.parse(publication.music_files)
                  : publication.music_files;

              if (Array.isArray(musicFiles)) {
                // Note: Attachments would need to be downloaded from S3 first
                // For now, we'll just include the file URLs in the email body
                attachments = []; // Can be enhanced later to download and attach files
              }
            } catch (e) {
              console.error("Error parsing music_files:", e);
            }
          }

          // Send emails
          const emailResult = await sendMusicSubmissionEmail({
            submitterEmail: composerEmail,
            firstName: composerFirstName,
            submissionTitle: publication.composition_title || "Untitled",
            submissionId: publication.id,
            status: publication.status === "draft" ? "Under Review" : "Submitted",
            portalLink: `${process.env.FRONTEND_URL}/music-compositions`,
            allAnswers,
            attachments,
          });

          if (emailResult.success) {
            console.log("✅ Music publication emails sent successfully");
          } else {
            console.error(
              "⚠️ Music publication emails failed:",
              emailResult.error,
            );
          }
        }
      } catch (emailError) {
        console.error("⚠️ Error sending music publication emails:", emailError);
        // Don't fail the publication creation if email fails
      }

      successResponse(
        res,
        {
          publication: publications[0],
          isNewPublication,
          collectionAdded,
          collectionId: collectionId,
          collectionName: collectionName,
        },
        "Publication created successfully",
      );
    } catch (error) {
      console.error("Music publication error:", error);
      errorResponse(res, "Failed to save publication", 500);
    }
  },
);


// @route GET /api/music-publications/can-submit
router.get("/can-submit", [auth], async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const [pending] = await mysqlConnection.execute(
      `
        SELECT
          id,
          composition_title,
          status,
          review_stage,
          created_at
        FROM music_publications
        WHERE composer_id = ?
          AND status NOT IN ('published', 'rejected')
        ORDER BY created_at DESC
        LIMIT 1
        `,
      [req.user.id]
    );

    if (pending.length > 0) {
      return successResponse(
        res,
        {
          canSubmit: false,
          pendingPublication: pending[0]
        },
        "User already has a submission in progress"
      );
    }

    return successResponse(
      res,
      {
        canSubmit: true
      },
      "User can submit a new composition"
    );

  } catch (error) {
    console.error(error);
    return errorResponse(
      res,
      "Failed to check submission status",
      500
    );
  }
}
);
// ======================================================
// REVIEW BOARD LOCK STATUS (FIXED VERSION)
// ======================================================
router.get(
  "/:id/review-board/lock",
  [auth, requireSLTeamReviewAccess],
  async (req, res) => {
    try {
      const { id } = req.params;
      const mysqlConnection = getMySQLConnection();

      // Ensure Slot 1 columns
      await ensureColumnExists(
        mysqlConnection,
        "music_publications",
        "stage1_slot1_status",
        "VARCHAR(20)",
      );
      await ensureColumnExists(
        mysqlConnection,
        "music_publications",
        "stage1_slot1_reviewer_id",
        "INT",
      );
      await ensureColumnExists(
        mysqlConnection,
        "music_publications",
        "stage1_slot1_reviewer_name",
        "VARCHAR(255)",
      );
      await ensureColumnExists(
        mysqlConnection,
        "music_publications",
        "stage1_slot1_reviewer_role",
        "VARCHAR(50)",
      );
      await ensureColumnExists(
        mysqlConnection,
        "music_publications",
        "stage1_slot1_started_at",
        "DATETIME",
      );
      await ensureColumnExists(
        mysqlConnection,
        "music_publications",
        "stage1_slot1_completed_at",
        "DATETIME",
      );

      // Ensure Slot 2 columns
      await ensureColumnExists(
        mysqlConnection,
        "music_publications",
        "stage1_slot2_status",
        "VARCHAR(20)",
      );
      await ensureColumnExists(
        mysqlConnection,
        "music_publications",
        "stage1_slot2_reviewer_id",
        "INT",
      );
      await ensureColumnExists(
        mysqlConnection,
        "music_publications",
        "stage1_slot2_reviewer_name",
        "VARCHAR(255)",
      );
      await ensureColumnExists(
        mysqlConnection,
        "music_publications",
        "stage1_slot2_reviewer_role",
        "VARCHAR(50)",
      );
      await ensureColumnExists(
        mysqlConnection,
        "music_publications",
        "stage1_slot2_started_at",
        "DATETIME",
      );
      await ensureColumnExists(
        mysqlConnection,
        "music_publications",
        "stage1_slot2_completed_at",
        "DATETIME",
      );

      const [rows] = await mysqlConnection.execute(
        `SELECT review_stage,
              stage1_slot1_status,
              stage1_slot1_reviewer_id,
              stage1_slot1_reviewer_name,
              stage1_slot1_reviewer_role,
              stage1_slot2_status,
              stage1_slot2_reviewer_id,
              stage1_slot2_reviewer_name,
              stage1_slot2_reviewer_role,
              stage1_reviews
       FROM music_publications
       WHERE id = ?`,
        [id],
      );

      if (!rows.length)
        return errorResponse(res, "Music publication not found", 404);

      if (rows[0].review_stage !== "review_board")
        return errorResponse(res, "Not at Review Board stage", 400);

      const reviews = parseJsonField(rows[0].stage1_reviews, []);

      successResponse(res, {
        slot1: {
          status: rows[0].stage1_slot1_status || "not_started",
          reviewerId: rows[0].stage1_slot1_reviewer_id || null,
          reviewerName: rows[0].stage1_slot1_reviewer_name || null,
          reviewerRole: rows[0].stage1_slot1_reviewer_role || null,
        },
        slot2: {
          status: rows[0].stage1_slot2_status || "not_started",
          reviewerId: rows[0].stage1_slot2_reviewer_id || null,
          reviewerName: rows[0].stage1_slot2_reviewer_name || null,
          reviewerRole: rows[0].stage1_slot2_reviewer_role || null,
        },
        totalReviewsSubmitted: Array.isArray(reviews) ? reviews.length : 0,
      });
    } catch (err) {
      console.error(err);
      errorResponse(res, "Failed to get lock status", 500);
    }
  },
);

// ======================================================
// REVIEW BOARD START REVIEW (FIXED VERSION)
// ======================================================
router.post(
  "/:id/review-board/start",
  [auth, requireSLTeamReviewAccess],
  async (req, res) => {
    try {
      const { id } = req.params;
      const mysqlConnection = getMySQLConnection();

      const [rows] = await mysqlConnection.execute(
        `SELECT * FROM music_publications WHERE id = ?`,
        [id],
      );

      if (!rows.length) return errorResponse(res, "Publication not found", 404);

      const pub = rows[0];

      if (pub.review_stage !== "review_board")
        return errorResponse(res, "Not at Review Board stage", 400);

      const reviews = parseJsonField(pub.stage1_reviews, []);

      const isSuperAdmin = req.user.user_type === "superadmin";
      const isAdmin = req.user.user_type === "admin";
      const isDirector = hasBadge(req.user, "Director of SLC");
      const isReviewBoardMember =
        req.user.is_review_board_member === true ||
        hasBadge(req.user, "Review Board");

      // ❗ Review board member sirf ek hi review kar sakta hai
      if (isReviewBoardMember) {
        if (reviews.some((r) => r.reviewerId === req.user.id)) {
          return errorResponse(
            res,
            "You have already reviewed this publication.",
            400,
          );
        }

        if (
          pub.stage1_slot1_reviewer_id === req.user.id ||
          pub.stage1_slot2_reviewer_id === req.user.id
        ) {
          return errorResponse(
            res,
            "You already have a review slot assigned.",
            400,
          );
        }
      }

      const isOverride = isSuperAdmin || isAdmin || isDirector;

      let slot = null;

      if (!pub.stage1_slot1_status || pub.stage1_slot1_status === "complete") {
        slot = 1;
      } else if (
        !pub.stage1_slot2_status ||
        pub.stage1_slot2_status === "complete"
      ) {
        slot = 2;
      } else if (isOverride) {
        slot = 1; // override allowed
      } else {
        return errorResponse(res, "Both review slots are locked.", 409);
      }

      const reviewerName =
        `${req.user.first_name || ""} ${req.user.last_name || ""}`.trim() ||
        "Anonymous";

      const reviewerRole =
        isSuperAdmin || isAdmin || isDirector ? "Admin" : "Reviewer";

      await mysqlConnection.execute(
        `UPDATE music_publications SET
           stage1_slot${slot}_status = 'start',
           stage1_slot${slot}_reviewer_id = ?,
           stage1_slot${slot}_reviewer_name = ?,
           stage1_slot${slot}_reviewer_role = ?,
           stage1_slot${slot}_started_at = NOW(),
           stage1_slot${slot}_completed_at = NULL,
           updated_at = NOW()
       WHERE id = ?`,
        [req.user.id, reviewerName, reviewerRole, id],
      );

      successResponse(
        res,
        {
          slot,
          reviewerRole,
        },
        `Review started in Slot ${slot}`,
      );
    } catch (err) {
      console.error(err);
      errorResponse(res, "Failed to start review", 500);
    }
  },
);

// @route   POST /api/music-publications/manager/add
// @desc    Create new music publication (Manager only)
// @access  Private (Manager user_type only)
router.post("/manager/add", [auth], async (req, res) => {
  try {
    // Check if user is manager
    const userType = req.user?.user_type || req.user?.userType;
    if (userType !== "manager") {
      return errorResponse(res, "Access denied. Manager access required.", 403);
    }

    const managerId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Prepare initial insert values
    let insertFields = ["composer_id", "status"];
    let insertPlaceholders = ["?", "?"];
    let insertValues = [managerId, "draft"];

    // Add composition_title to initial insert if provided (to avoid NOT NULL constraint)
    if (req.body.compositionTitle) {
      insertFields.push("composition_title");
      insertPlaceholders.push("?");
      insertValues.push(req.body.compositionTitle);
    }

    // Always create new publication
    const [result] = await mysqlConnection.execute(
      `INSERT INTO music_publications (${insertFields.join(", ")}) VALUES (${insertPlaceholders.join(", ")})`,
      insertValues,
    );
    const publicationId = result.insertId;
    const isNewPublication = true;

    // Update publication with all provided data
    let updateFields = [];
    let updateValues = [];

    // Composition Information
    if (req.body.compositionTitle) {
      // Already inserted, skip
    }
    if (req.body.compositionDescription) {
      updateFields.push("composition_description = ?");
      updateValues.push(req.body.compositionDescription);
    }
    if (req.body.composerFirstName) {
      updateFields.push("composer_firstname = ?");
      updateValues.push(req.body.composerFirstName);
    }
    if (req.body.composerLastName) {
      updateFields.push("composer_lastname = ?");
      updateValues.push(req.body.composerLastName);
    }

    // Collection Information
    if (req.body.isPartOfCollection !== undefined) {
      updateFields.push("is_part_of_collection = ?");
      updateValues.push(req.body.isPartOfCollection);
    }
    if (req.body.collectionId) {
      updateFields.push("collection_id = ?");
      updateValues.push(req.body.collectionId);
    }
    if (req.body.collectionName) {
      updateFields.push("collection_name = ?");
      updateValues.push(req.body.collectionName);
    }
    if (req.body.musicVideoLink) {
      updateFields.push("music_video_link = ?");
      updateValues.push(req.body.musicVideoLink);
    }

    if (req.body.type_of_music) {
      updateFields.push("type_of_music = ?");
      updateValues.push(req.body.type_of_music);
    }
    if (req.body.feast) {
      updateFields.push("feast = ?");
      const feastValue =
        Array.isArray(req.body.feast) || typeof req.body.feast === "object"
          ? JSON.stringify(req.body.feast)
          : req.body.feast;
      updateValues.push(feastValue);
    }

    if (req.body.verseStyle) {
      updateFields.push("verseStyle = ?");
      const verseStyleValue =
        Array.isArray(req.body.verseStyle) ||
          typeof req.body.verseStyle === "object"
          ? JSON.stringify(req.body.verseStyle)
          : req.body.verseStyle;
      updateValues.push(verseStyleValue);
    }

    if (req.body.liturgicalText) {
      updateFields.push("liturgicalText = ?");
      const liturgicalTextValue =
        Array.isArray(req.body.liturgicalText) ||
          typeof req.body.liturgicalText === "object"
          ? JSON.stringify(req.body.liturgicalText)
          : req.body.liturgicalText;
      updateValues.push(liturgicalTextValue);
    }

    // Music Details - Handle as arrays for multi-select
    if (req.body.vocalParts) {
      updateFields.push("vocal_parts = ?");
      const vocalPartsValue = Array.isArray(req.body.vocalParts)
        ? JSON.stringify(req.body.vocalParts)
        : req.body.vocalParts;
      updateValues.push(vocalPartsValue);
    }
    if (req.body.instrumentation) {
      updateFields.push("instrumentation = ?");
      const instrumentationValue = Array.isArray(req.body.instrumentation)
        ? JSON.stringify(req.body.instrumentation)
        : req.body.instrumentation;
      updateValues.push(instrumentationValue);
    }
    if (req.body.typesOfMusic) {
      updateFields.push("types_of_music = ?");
      updateValues.push(req.body.typesOfMusic);
    }

    // OneLicense Information
    if (req.body.firstLineOfComposition) {
      updateFields.push("first_line_of_composition = ?");
      updateValues.push(req.body.firstLineOfComposition);
    }
    // Composition Copyrights - JSON array of copyright objects
    if (req.body.compositionCopyrights) {
      updateFields.push("composition_copyrights = ?");
      const copyrightsValue = Array.isArray(req.body.compositionCopyrights)
        ? JSON.stringify(req.body.compositionCopyrights)
        : req.body.compositionCopyrights;
      updateValues.push(copyrightsValue);
    }
    if (req.body.songType) {
      updateFields.push("song_type = ?");
      updateValues.push(req.body.songType);
    }
    if (req.body.meter) {
      updateFields.push("meter = ?");
      updateValues.push(req.body.meter);
    }
    if (req.body.season) {
      updateFields.push("season = ?");
      updateValues.push(req.body.season);
    }
    if (req.body.psalmNumber) {
      updateFields.push("psalm_number = ?");
      updateValues.push(req.body.psalmNumber);
    }

    // Copyright Details
    if (req.body.textCopyrightNotice) {
      updateFields.push("text_copyright_notice = ?");
      updateValues.push(req.body.textCopyrightNotice);
    }
    if (req.body.tuneCopyrightNotice) {
      updateFields.push("tune_copyright_notice = ?");
      updateValues.push(req.body.tuneCopyrightNotice);
    }

    if (req.body.compositionTitle1) {
      updateFields.push("composition_title_1 = ?");
      updateValues.push(req.body.compositionTitle1);
    }

    // Artists - JSON array of artist objects
    if (req.body.artists) {
      updateFields.push("artists = ?");
      const artistsValue = Array.isArray(req.body.artists)
        ? JSON.stringify(req.body.artists)
        : req.body.artists;
      updateValues.push(artistsValue);
    }

    // File Uploads - Music Files (JSON array)
    if (req.body.musicFiles) {
      updateFields.push("music_files = ?");
      updateValues.push(JSON.stringify(req.body.musicFiles));
    }
    if (req.body.artworkFileUrl) {
      updateFields.push("artwork_file_url = ?");
      updateValues.push(req.body.artworkFileUrl);
    }
    if (req.body.artworkFileSize) {
      updateFields.push("artwork_file_size = ?");
      updateValues.push(req.body.artworkFileSize);
    }

    // General Details (All Optional)
    if (req.body.tune !== undefined) {
      updateFields.push("tune = ?");
      const tuneValue = req.body.tune;
      updateValues.push(
        tuneValue && typeof tuneValue === "string" && tuneValue.trim() !== ""
          ? tuneValue.trim()
          : null,
      );
    }
    if (req.body.generalDetails !== undefined) {
      updateFields.push("general_details = ?");
      const generalDetailsValue = req.body.generalDetails;
      updateValues.push(
        generalDetailsValue &&
          typeof generalDetailsValue === "string" &&
          generalDetailsValue.trim() !== ""
          ? generalDetailsValue.trim()
          : null,
      );
    }
    if (req.body.countryRestrictions !== undefined) {
      updateFields.push("country_restrictions = ?");
      const countryRestrictionsValue = req.body.countryRestrictions;
      updateValues.push(
        countryRestrictionsValue &&
          typeof countryRestrictionsValue === "string" &&
          countryRestrictionsValue.trim() !== ""
          ? countryRestrictionsValue.trim()
          : null,
      );
    }

    // Usage Permissions (All Optional - Boolean fields with default false)
    if (req.body.isPublicDomain !== undefined) {
      updateFields.push("is_public_domain = ?");
      updateValues.push(
        req.body.isPublicDomain === true ||
          req.body.isPublicDomain === "true" ||
          req.body.isPublicDomain === 1
          ? 1
          : 0,
      );
    }
    if (req.body.canBeReprinted !== undefined) {
      updateFields.push("can_be_reprinted = ?");
      updateValues.push(
        req.body.canBeReprinted === true ||
          req.body.canBeReprinted === "true" ||
          req.body.canBeReprinted === 1
          ? 1
          : 0,
      );
    }
    if (req.body.canBePodcastStreamed !== undefined) {
      updateFields.push("can_be_podcast_streamed = ?");
      updateValues.push(
        req.body.canBePodcastStreamed === true ||
          req.body.canBePodcastStreamed === "true" ||
          req.body.canBePodcastStreamed === 1
          ? 1
          : 0,
      );
    }
    if (req.body.canMakeCommercialRecording !== undefined) {
      updateFields.push("can_make_commercial_recording = ?");
      updateValues.push(
        req.body.canMakeCommercialRecording === true ||
          req.body.canMakeCommercialRecording === "true" ||
          req.body.canMakeCommercialRecording === 1
          ? 1
          : 0,
      );
    }
    if (req.body.canMakeNonCommercialRecording !== undefined) {
      updateFields.push("can_make_non_commercial_recording = ?");
      updateValues.push(
        req.body.canMakeNonCommercialRecording === true ||
          req.body.canMakeNonCommercialRecording === "true" ||
          req.body.canMakeNonCommercialRecording === 1
          ? 1
          : 0,
      );
    }

    // Terms & Conditions
    if (req.body.termsAccepted !== undefined) {
      if (req.body.termsAccepted) {
        updateFields.push("terms_accepted = ?, terms_accepted_at = NOW()");
        updateValues.push(req.body.termsAccepted);
      } else {
        updateFields.push("terms_accepted = ?");
        updateValues.push(req.body.termsAccepted);
      }
    }

    if (updateFields.length > 0) {
      updateFields.push("updated_at = NOW()");
      updateValues.push(publicationId);

      await mysqlConnection.execute(
        `UPDATE music_publications SET ${updateFields.join(", ")} WHERE id = ?`,
        updateValues,
      );
    }

    // Get updated publication
    const [publications] = await mysqlConnection.execute(
      "SELECT * FROM music_publications WHERE id = ?",
      [publicationId],
    );

    // Handle collection logic
    let collectionAdded = false;
    let collectionId = null;
    let collectionName = null;

    if (req.body.isPartOfCollection === true) {
      // Only add to SYSTEM collections when isPartOfCollection is true
      if (req.body.collectionId) {
        try {
          // Check if collection exists and is a SYSTEM collection
          const [collections] = await mysqlConnection.execute(
            "SELECT id, name FROM collections WHERE id = ? AND is_system_collection = TRUE",
            [req.body.collectionId],
          );

          if (collections.length > 0) {
            // Add music to system collection
            await mysqlConnection.execute(
              "INSERT INTO collection_music (collection_id, music_id) VALUES (?, ?)",
              [req.body.collectionId, publicationId],
            );
            collectionAdded = true;
            collectionId = req.body.collectionId;
            collectionName = collections[0].name;
            console.log(
              `Music ${publicationId} added to SYSTEM collection ${req.body.collectionId}`,
            );
          } else {
            console.log(`System collection ${req.body.collectionId} not found`);
          }
        } catch (collectionError) {
          console.error(
            "Error adding music to system collection:",
            collectionError,
          );
          // Continue with publication creation even if collection addition fails
        }
      } else {
        console.log("collectionId is required when isPartOfCollection is true");
      }
    } else if (req.body.isPartOfCollection === false) {
      // Only add to USER collections when isPartOfCollection is false
      if (req.body.collectionId) {
        try {
          // Check if collection exists and is a USER collection
          const [collections] = await mysqlConnection.execute(
            "SELECT id, name FROM collections WHERE id = ? AND user_id = ? AND is_system_collection = FALSE",
            [req.body.collectionId, managerId],
          );

          if (collections.length > 0) {
            // Add music to user collection
            await mysqlConnection.execute(
              "INSERT INTO collection_music (collection_id, music_id) VALUES (?, ?)",
              [req.body.collectionId, publicationId],
            );
            collectionAdded = true;
            collectionId = req.body.collectionId;
            collectionName = collections[0].name;
            console.log(
              `Music ${publicationId} added to USER collection ${req.body.collectionId}`,
            );
          } else {
            console.log(
              `User collection ${req.body.collectionId} not found or access denied for user ${managerId}`,
            );
          }
        } catch (collectionError) {
          console.error(
            "Error adding music to user collection:",
            collectionError,
          );
          // Continue with publication creation even if collection addition fails
        }
      } else if (req.body.collectionName) {
        // Create new user collection and add music to it
        try {
          // Check if collection with same name already exists for this user
          const [existingCollections] = await mysqlConnection.execute(
            "SELECT id FROM collections WHERE user_id = ? AND name = ? AND is_system_collection = FALSE",
            [managerId, req.body.collectionName],
          );

          if (existingCollections.length > 0) {
            // Use existing user collection
            collectionId = existingCollections[0].id;
            collectionName = req.body.collectionName;
          } else {
            // Create new user collection
            const [collectionResult] = await mysqlConnection.execute(
              "INSERT INTO collections (name, description, user_id, is_system_collection, created_by) VALUES (?, ?, ?, ?, ?)",
              [
                req.body.collectionName,
                req.body.collectionDescription || null,
                managerId,
                false,
                "user",
              ],
            );
            collectionId = collectionResult.insertId;
            collectionName = req.body.collectionName;
            console.log(`New USER collection created with ID: ${collectionId}`);
          }

          // Add music to user collection
          await mysqlConnection.execute(
            "INSERT INTO collection_music (collection_id, music_id) VALUES (?, ?)",
            [collectionId, publicationId],
          );
          collectionAdded = true;
          console.log(
            `Music ${publicationId} added to USER collection ${collectionId}`,
          );
        } catch (collectionError) {
          console.error(
            "Error creating user collection or adding music:",
            collectionError,
          );
          // Continue with publication creation even if collection addition fails
        }
      }
    }

    // Send email notifications to Review Board and Manager when publication is created
    try {
      const publication = publications[0];

      // Get manager details
      const [managerUser] = await mysqlConnection.execute(
        "SELECT first_name, last_name, email FROM users WHERE id = ?",
        [managerId],
      );

      const manager = managerUser[0];
      const managerFirstName =
        manager?.first_name || publication.composer_firstname || "Manager";
      const managerEmail = manager?.email;

      if (managerEmail) {
        // Format all publication details as "allAnswers"
        const allAnswers = `
Composition Title: ${publication.composition_title || "N/A"}
Composer: ${publication.composer_firstname || ""} ${publication.composer_lastname || ""}
Description: ${publication.composition_description || "N/A"}
Tune: ${publication.tune || "N/A"}
General Details: ${publication.general_details || "N/A"}
Country Restrictions: ${publication.country_restrictions || "N/A"}
Is Public Domain: ${publication.is_public_domain ? "Yes" : "No"}
Can Be Reprinted: ${publication.can_be_reprinted ? "Yes" : "No"}
Can Be Podcast/Streamed: ${publication.can_be_podcast_streamed ? "Yes" : "No"}
Can Make Commercial Recording: ${publication.can_make_commercial_recording ? "Yes" : "No"}
Can Make Non-commercial Recording: ${publication.can_make_non_commercial_recording ? "Yes" : "No"}
First Line of Composition: ${publication.first_line_of_composition || "N/A"}
Song Type: ${publication.song_type || "N/A"}
Meter: ${publication.meter || "N/A"}
Season: ${publication.season || "N/A"}
Psalm Number: ${publication.psalm_number || "N/A"}
Created At: ${new Date().toLocaleString()}
        `.trim();

        // Prepare attachments from music_files if available
        let attachments = [];
        if (publication.music_files) {
          try {
            const musicFiles =
              typeof publication.music_files === "string"
                ? JSON.parse(publication.music_files)
                : publication.music_files;

            if (Array.isArray(musicFiles)) {
              // Note: Attachments would need to be downloaded from S3 first
              // For now, we'll just include the file URLs in the email body
              attachments = []; // Can be enhanced later to download and attach files
            }
          } catch (e) {
            console.error("Error parsing music_files:", e);
          }
        }

        // Send emails
        const emailResult = await sendMusicSubmissionEmail({
          submitterEmail: composerEmail,
          firstName: composerFirstName,
          submissionTitle: publication.composition_title || "Untitled",
          submissionId: publication.id,
          status: publication.status === "draft" ? "Under Review" : "Submitted",
          portalLink: `${process.env.FRONTEND_URL}/music-compositions`,
          allAnswers,
          attachments,
        });

        if (emailResult.success) {
          console.log("✅ Music publication emails sent successfully");
        } else {
          console.error(
            "⚠️ Music publication emails failed:",
            emailResult.error,
          );
        }
      }
    } catch (emailError) {
      console.error("⚠️ Error sending music publication emails:", emailError);
      // Don't fail the publication creation if email fails
    }

    successResponse(
      res,
      {
        publication: publications[0],
        isNewPublication,
        collectionAdded,
        collectionId: collectionId,
        collectionName: collectionName,
      },
      "Music publication created successfully by manager",
    );
  } catch (error) {
    console.error("Manager music publication error:", error);
    errorResponse(res, "Failed to save publication", 500);
  }
});

// ========================= Email Testing Routes =========================
router.post("/email", async (req, res) => {
  try {
    const { submitterEmail, firstName, allAnswers, attachments } = req.body;

    // Validate required fields
    if (!submitterEmail || !firstName || !allAnswers || !attachments) {
      return errorResponse(
        res,
        "Missing required fields: submitterEmail, firstName, allAnswers, and attachments are required",
        400,
      );
    }

    // Prepare the payload for the email function
    const emailData = {
      submitterEmail,
      firstName,
      allAnswers,
      attachments,
    };

    // Pass the data to your email function
    const result = await sendMusicSubmissionEmail({
      submitterEmail: composerEmail,
      firstName: composerFirstName,
      submissionTitle: publication.composition_title || "Untitled",
      submissionId: publication.id,
      status: publication.status === "draft" ? "Under Review" : "Submitted",
      portalLink: `${process.env.FRONTEND_URL}/music-compositions`,
      allAnswers,
      attachments,
    });;

    if (result.success) {
      return successResponse(
        res,
        { messageId: result.messageId },
        "Email sent successfully",
      );
    } else {
      return errorResponse(res, result.error, 500);
    }
  } catch (error) {
    console.error("Email sending error:", error);
    return errorResponse(res, "Failed to send email", 500);
  }
});

router.post("/review-status-stage1", async (req, res) => {
  try {
    const { compositionName, allAnswers, action } = req.body;

    // Validate required fields
    if (!compositionName || !allAnswers || !action) {
      return errorResponse(
        res,
        "Missing required fields: compositionName, allAnswers, and action are required",
        400,
      );
    }

    // Allowed actions
    const validActions = ["accept", "accept_with_changes", "not_approved"];
    if (!validActions.includes(action)) {
      return errorResponse(
        res,
        "Invalid action. Must be one of: accept, accept_with_changes, not_approved",
        400,
      );
    }

    const payload = {
      compositionName,
      allAnswers,
      action,
    };

    // Call the Stage 1 Review function
    const result = await sendMusicReviewStatusStage1(payload);

    if (result.success) {
      return successResponse(
        res,
        { messageId: result.messageId },
        "Review status email sent successfully",
      );
    } else {
      return errorResponse(res, result.error, 500);
    }
  } catch (error) {
    console.error("Review Status Email Error:", error);
    return errorResponse(res, "Failed to send review status email", 500);
  }
});

router.post("/director-review-email", async (req, res) => {
  try {
    const { compositionName, composerFirstName, allAnswers, action } = req.body;

    // Validate required fields
    if (!compositionName || !composerFirstName || !allAnswers || !action) {
      return errorResponse(
        res,
        "Missing required fields: compositionName, composerFirstName, allAnswers, and action are required",
        400,
      );
    }

    // Allowed actions
    const validActions = ["approved", "approved_with_changes", "declined"];
    if (!validActions.includes(action)) {
      return errorResponse(
        res,
        "Invalid action. Must be one of: approved, approved_with_changes, declined",
        400,
      );
    }

    const payload = {
      compositionName,
      composerFirstName,
      allAnswers,
      action,
    };

    // Call the Director of SLC Review function
    const result = await directorOfSLCReviewEmail(payload);

    if (result.success) {
      return successResponse(
        res,
        { messageId: result.messageId },
        "Director review email sent successfully",
      );
    } else {
      return errorResponse(res, result.error, 500);
    }
  } catch (error) {
    console.error("Director Review Email Error:", error);
    return errorResponse(res, "Failed to send director review email", 500);
  }
});

// ========================= Email Testing Routes =========================

// @route   POST /api/music-publications/submit
// @desc    Submit music publication for OneLicense verification (Composer only)
// @access  Private (Composer only)
router.post(
  "/submit",
  [auth, requireAnyRole(["composer"])],
  async (req, res) => {
    try {
      const composerId = req.user.id;
      const mysqlConnection = getMySQLConnection();

      // Get composer's publication
      const [publications] = await mysqlConnection.execute(
        'SELECT * FROM music_publications WHERE composer_id = ? AND status = "draft"',
        [composerId],
      );

      if (publications.length === 0) {
        return errorResponse(
          res,
          "No draft publication found. Please complete the publication first.",
          404,
        );
      }

      const publication = publications[0];

      // Validate required fields
      const requiredFields = [
        "composition_title",
        "composer_firstname",
        "composer_lastname",
        "terms_accepted",
      ];

      const missingFields = requiredFields.filter(
        (field) => !publication[field],
      );

      if (missingFields.length > 0) {
        return errorResponse(
          res,
          `Missing required fields: ${missingFields.join(", ")}`,
          400,
        );
      }

      // Check if terms are accepted
      if (!publication.terms_accepted) {
        return errorResponse(res, "Terms and conditions must be accepted", 400);
      }

      // Submit publication for OneLicense verification
      await mysqlConnection.execute(
        "UPDATE music_publications SET status = ?, updated_at = NOW() WHERE id = ?",
        ["submitted", publication.id],
      );

      successResponse(
        res,
        {
          publicationId: publication.id,
          status: "submitted",
          nextStep: "OneLicense verification",
        },
        "Publication submitted successfully for OneLicense verification",
      );
    } catch (error) {
      console.error("Submit publication error:", error);
      errorResponse(res, "Failed to submit publication", 500);
    }
  },
);

// ==================================================
// ADMIN DIRECT PUBLISH MUSIC (NO REVIEW FLOW)
// @route   POST /api/music-publications/admin/direct-publish
// @desc    Create & publish music directly (composer = logged-in user)
// @access  Private (Admin/Superadmin/Music Publication Team/Director of SLC)
// ==================================================
router.post("/admin/direct-publish", [auth], async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    const userId = req.user.id;
    const userType = req.user.user_type;
    const badges = req.user.badges || [];

    const allowedRoles = ["admin", "superadmin", "music-publication-team"];
    const isDirector =
      badges.includes("Director of SLC") ||
      ["director-of-slc", "director_of_slc"].includes(userType);

    if (!allowedRoles.includes(userType) && !isDirector) {
      return errorResponse(res, "Access denied", 403);
    }

    if (!req.body.compositionTitle) {
      return errorResponse(res, "compositionTitle is required", 400);
    }

    // ✅ Ensure required columns exist
    await ensureColumnExists(mysqlConnection, "music_publications", "language", "JSON");
    await ensureColumnExists(mysqlConnection, "music_publications", "includeInOneLicense", "TINYINT(1) DEFAULT 0");

    // ---------- CREATE ----------
    const [result] = await mysqlConnection.execute(
      `
      INSERT INTO music_publications
      (composer_id, status, review_stage, published_at, published_by, publish_type, composition_title, toggle)
      VALUES (?, 'published', 'published', NOW(), ?, 'direct', ?, 'active')
      `,
      [req.body.composer_id || userId, userId, req.body.compositionTitle]
    );

    const publicationId = result.insertId;

    const updateFields = [];
    const updateValues = [];

    const push = (field, value, isJSON = false) => {
      if (value === undefined) return;

      if (value === "" || value === null) {
        updateFields.push(`${field} = NULL`);
        return;
      }

      if (isJSON) {
        try {
          value = JSON.stringify(value);
        } catch {
          value = null;
        }
      }

      updateFields.push(`${field} = ?`);
      updateValues.push(value);
    };

    // =========================
    // COMPOSITION
    // =========================
    push("composition_title_1", req.body.compositionTitle1);
    push("composition_description", req.body.compositionDescription);
    push("composer_firstname", req.body.composerFirstName);
    push("composer_lastname", req.body.composerLastName);

    // =========================
    // COLLECTION
    // =========================
    if (req.body.isPartOfCollection !== undefined) {
      push("is_part_of_collection", req.body.isPartOfCollection ? 1 : 0);
    }

    if (req.body.collectionId) {
      push("collection_id", Number(req.body.collectionId));
    }

    push("collection_name", req.body.collectionName);
    push("music_video_link", req.body.musicVideoLink);

    // =========================
    // LITURGICAL
    // =========================
    push("feast", req.body.feast, true);
    push("verseStyle", req.body.verseStyle, true);
    push("liturgicalText", req.body.liturgicalText, true);
    push("theme", req.body.theme, true);
    push("partOfMass", req.body.partOfMass, true);
    push("liturgicalSacrament", req.body.liturgicalSacrament);

    // =========================
    // MUSIC
    // =========================
    push("vocal_parts", req.body.vocalParts, true);
    push("instrumentation", req.body.instrumentation, true);
    push("types_of_music", req.body.typesOfMusic);

    // ✅ FIX includeInOneLicense (correct column name)
    if (req.body.includeInOneLicense !== undefined) {
      push("includeInOneLicense", req.body.includeInOneLicense ? 1 : 0);
    }

    // =========================
    // ONELICENSE
    // =========================
    push("first_line_of_composition", req.body.firstLineOfComposition);
    push("composition_copyrights", req.body.compositionCopyrights, true);
    push("mass_setting_parts", req.body.massSettingParts, true);
    push("song_type", req.body.songType);
    push("meter", req.body.meter);
    push("season", req.body.season);

    // ✅ FIX LANGUAGE (MAIN ISSUE)
    if (req.body.language !== undefined) {
      push(
        "language",
        Array.isArray(req.body.language)
          ? req.body.language
          : [req.body.language],
        true
      );
    }

    push("psalm_number", req.body.psalmNumber);

    // =========================
    // COPYRIGHT
    // =========================
    push("text_copyright_notice", req.body.textCopyrightNotice);
    push("tune_copyright_notice", req.body.tuneCopyrightNotice);

    // =========================
    // ARTISTS
    // =========================
    push("artists", req.body.artists, true);

    // =========================
    // FILES
    // =========================
    push("music_files", req.body.musicFiles, true);
    push("artwork_file_url", req.body.artworkFileUrl);
    push("artwork_file_size", req.body.artworkFileSize);

    // =========================
    // PRICING
    // =========================
    if (req.body.price !== undefined) {
      const price = Number(req.body.price || 0);
      push("price", price);
      push("is_free", price > 0 ? 0 : 1);
    }

    // =========================
    // PERMISSIONS
    // =========================
    if (req.body.isPublicDomain !== undefined)
      push("is_public_domain", req.body.isPublicDomain ? 1 : 0);

    if (req.body.canBeReprinted !== undefined)
      push("can_be_reprinted", req.body.canBeReprinted ? 1 : 0);

    if (req.body.canBePodcastStreamed !== undefined)
      push("can_be_podcast_streamed", req.body.canBePodcastStreamed ? 1 : 0);

    if (req.body.canMakeCommercialRecording !== undefined)
      push("can_make_commercial_recording", req.body.canMakeCommercialRecording ? 1 : 0);

    if (req.body.canMakeNonCommercialRecording !== undefined)
      push("can_make_non_commercial_recording", req.body.canMakeNonCommercialRecording ? 1 : 0);

    // =========================
    // FINAL UPDATE
    // =========================
    if (updateFields.length > 0) {
      updateFields.push("updated_at = NOW()");
      updateValues.push(publicationId);

      const sql = `
        UPDATE music_publications
        SET ${updateFields.join(", ")}
        WHERE id = ?
      `;

      await mysqlConnection.execute(sql, updateValues);
    }

    // =========================
    // COLLECTION LINK
    // =========================
    if (req.body.collectionId) {
      await mysqlConnection.execute(
        `INSERT IGNORE INTO collection_music (collection_id, music_id) VALUES (?, ?)`,
        [Number(req.body.collectionId), publicationId]
      );
    }

    // =========================
    // FINAL FETCH
    // =========================
    const [rows] = await mysqlConnection.execute(
      `SELECT * FROM music_publications WHERE id = ?`,
      [publicationId]
    );

    return successResponse(
      res,
      {
        publication: rows[0],
        composerId: req.body.composer_id || userId,
        publishedBy: userId,
        publishedAt: new Date().toISOString()
      },
      "Music published successfully"
    );

  } catch (err) {
    console.error("❌ Direct publish error:", err);

    return errorResponse(
      res,
      err.sqlMessage || err.message || "Failed to publish music",
      500
    );
  }
});

// ==================================================
// ADMIN TOGGLE ACTIVE / INACTIVE (publish_type)
// @route   PUT /api/music-publications/:id/toggle-active
// @desc    Toggle publish_type between active & inactive
// @access  Private (Admin/Superadmin)
// ==================================================

router.put("/:id/toggle-active", [auth], async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    const userType = req.user.user_type;

    // ✅ Role check
    const allowedRoles = ["admin", "superadmin"];

    if (!allowedRoles.includes(userType)) {
      return errorResponse(res, "Access denied", 403);
    }

    const musicId = req.params.id;

    // ✅ Get current toggle status
    const [rows] = await mysqlConnection.execute(
      `SELECT toggle FROM music_publications WHERE id = ?`,
      [musicId]
    );

    if (rows.length === 0) {
      return errorResponse(res, "Music not found", 404);
    }

    const currentStatus = rows[0].toggle;
    console.log(rows);

    // ✅ Toggle logic
    const newStatus = currentStatus === "active" ? "inactive" : "active";
    console.log(currentStatus, newStatus)

    // ✅ Update
    await mysqlConnection.execute(
      `
      UPDATE music_publications
      SET toggle = ?, updated_at = NOW()
      WHERE id = ?
      `,
      [newStatus, musicId]
    );

    return successResponse(
      res,
      {
        id: musicId,
        oldStatus: currentStatus,
        newStatus
      },
      `Music is now ${newStatus}`
    );

  } catch (error) {
    console.error("Toggle active error:", error);
    return errorResponse(res, "Failed to toggle active status", 500);
  }
});

// @route   PUT /api/music-publications/:id/onelicense-verify
// @desc    OneLicense verification (OneLicense role only)
// @access  Private (OneLicense role only)
router.put(
  "/:id/onelicense-verify",
  [auth, requireAnyRole(["onelicense"])],
  async (req, res) => {
    try {
      const { id } = req.params;
      const { verificationNotes } = req.body;
      const verifierId = req.user.id;
      const mysqlConnection = getMySQLConnection();

      // Get publication
      const [publications] = await mysqlConnection.execute(
        "SELECT * FROM music_publications WHERE id = ?",
        [id],
      );

      if (publications.length === 0) {
        return errorResponse(res, "Publication not found", 404);
      }

      const publication = publications[0];

      // Check if publication is in correct status
      if (publication.status !== "submitted") {
        return errorResponse(
          res,
          "Publication is not in submitted status for OneLicense verification",
          400,
        );
      }

      // Update publication status to OneLicense verification
      await mysqlConnection.execute(
        "UPDATE music_publications SET status = ?, onelicense_verified_by = ?, onelicense_verified_at = NOW(), onelicense_verification_notes = ?, updated_at = NOW() WHERE id = ?",
        ["onelicense_verification", verifierId, verificationNotes || null, id],
      );

      successResponse(
        res,
        {
          publicationId: id,
          status: "onelicense_verification",
          verifiedBy: verifierId,
          nextStep: "SL Team review",
        },
        "Publication verified by OneLicense successfully",
      );
    } catch (error) {
      console.error("OneLicense verification error:", error);
      errorResponse(res, "Failed to verify publication", 500);
    }
  },
);

// @route   PUT /api/music-publications/:id/sl-team-review
// @desc    SL Team review and approval (SL Team role only)
// @access  Private (SL Team role only)
router.put(
  "/:id/sl-team-review",
  [auth, requireAnyRole(["sl_team"])],
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status, reviewNotes, rejectionReason } = req.body;
      const reviewerId = req.user.id;
      const mysqlConnection = getMySQLConnection();

      // Get publication
      const [publications] = await mysqlConnection.execute(
        "SELECT * FROM music_publications WHERE id = ?",
        [id],
      );

      if (publications.length === 0) {
        return errorResponse(res, "Publication not found", 404);
      }

      const publication = publications[0];

      // Check if publication is in correct status
      if (publication.status !== "onelicense_verification") {
        return errorResponse(
          res,
          "Publication is not ready for SL Team review",
          400,
        );
      }

      // Update publication status
      const updateFields = [
        "status = ?",
        "sl_team_reviewed_by = ?",
        "sl_team_reviewed_at = NOW()",
      ];
      const updateValues = [status, reviewerId];

      if (reviewNotes) {
        updateFields.push("sl_team_review_notes = ?");
        updateValues.push(reviewNotes);
      }

      if (status === "rejected" && rejectionReason) {
        updateFields.push("rejection_reason = ?");
        updateValues.push(rejectionReason);
      }

      if (status === "published") {
        updateFields.push("published_at = NOW()", "published_by = ?");
        updateValues.push(reviewerId);
      }

      updateValues.push(id);

      await mysqlConnection.execute(
        `UPDATE music_publications SET ${updateFields.join(", ")}, updated_at = NOW() WHERE id = ?`,
        updateValues,
      );

      successResponse(
        res,
        {
          publicationId: id,
          status,
          reviewedBy: reviewerId,
        },
        `Publication ${status} successfully`,
      );
    } catch (error) {
      console.error("SL Team review error:", error);
      errorResponse(res, "Failed to review publication", 500);
    }
  },
);

// @route   GET /api/music-publications/my-publications
// @desc    Get current user's publications
// @access  Private (Composer or SL Team only)
router.get("/my-publications", [auth], async (req, res) => {
  try {
    const composerId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    const [publications] = await mysqlConnection.execute(
      "SELECT * FROM music_publications WHERE composer_id = ? ORDER BY created_at DESC",
      [composerId],
    );

    successResponse(
      res,
      {
        publications,
        count: publications.length,
      },
      "Publications retrieved successfully",
    );
  } catch (error) {
    console.error("Get publications error:", error);
    errorResponse(res, "Failed to get publications", 500);
  }
});

// @route   GET /api/music-publications/all-music
// @desc    Get all music publications (with sorting + pagination + filters)
// @access  Private
router.get("/all-music", auth, async (req, res) => {
  try {
    const {
      status,
      page = 1,
      limit = 20,
      search,
      typeOfMusic,
      sortBy = "created_at",
      sortOrder = "desc",
      toggle
    } = req.query;

    const mysqlConnection = getMySQLConnection();

    // =============================
    // SORT MAP
    // =============================
    const sortColumnMap = {
      composition_title: "mp.composition_title",
      id: "mp.id",
      composer: "CONCAT(u.first_name, ' ', u.last_name)",
      typesOfMusic: "mp.types_of_music",
      price: "mp.price",
      created_at: "mp.created_at",
      status: "mp.status"
    };

    const orderDirection = sortOrder === "asc" ? "ASC" : "DESC";
    const orderByColumn = sortColumnMap[sortBy] || "mp.created_at";

    // =============================
    // WHERE CLAUSE
    // =============================
    let whereClause = `
      WHERE (mp.scheduled_deletion_at IS NULL OR mp.scheduled_deletion_at > NOW())
      AND u.is_active = TRUE
    `;

    const whereValues = [];

    // ✅ Status filter
    if (status) {
      whereClause += " AND mp.status = ?";
      whereValues.push(status);
    }

    // ✅ IMPORTANT: toggle filter ONLY when NOT sorting by toggle
    if (toggle && sortBy !== "toggle") {
      whereClause += " AND mp.toggle = ?";
      whereValues.push(toggle);
    }

    // ✅ Type filter
    if (typeOfMusic) {
      whereClause += " AND mp.types_of_music = ?";
      whereValues.push(typeOfMusic);
    }

    // ✅ Search
    if (search) {
      // Ignore multiple spaces and punctuation, then split into individual words
      const cleanSearch = search.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'’]/g, ' ');
      const keywords = cleanSearch.split(/\s+/).filter(Boolean);

      // Get unique keywords to avoid redundant SQL conditions
      const uniqueKeywords = [...new Set(keywords)];

      if (uniqueKeywords.length > 0) {
        uniqueKeywords.forEach((keyword) => {
          whereClause += `
            AND (
              mp.composition_title LIKE ?
              OR mp.composer_firstname LIKE ?
              OR mp.composer_lastname LIKE ?
              OR CONCAT(mp.composer_firstname, ' ', mp.composer_lastname) LIKE ?
              OR u.first_name LIKE ?
              OR u.last_name LIKE ?
              OR CONCAT(u.first_name, ' ', u.last_name) LIKE ?
            )
          `;
          const like = `%${keyword}%`;
          whereValues.push(like, like, like, like, like, like, like);
        });
      }
    }

    // =============================
    // PAGINATION
    // =============================
    const safePage = Math.max(parseInt(page), 1);
    const safeLimit = Math.min(parseInt(limit), 100);
    const offset = (safePage - 1) * safeLimit;

    // =============================
    // 🔥 SORTING LOGIC (MAIN FIX)
    // =============================

    let finalOrderQuery = `${orderByColumn} ${orderDirection}`;

    // ✅ SPECIAL: toggle sorting (NO FILTER)
    if (sortBy === "toggle") {
      finalOrderQuery = `
        CASE 
          WHEN mp.toggle = 'active' THEN 1
          WHEN mp.toggle = 'inactive' THEN 2
          ELSE 3
        END ${orderDirection},
        mp.created_at DESC
      `;
    }

    // =============================
    // MAIN QUERY
    // =============================
    const [publications] = await mysqlConnection.execute(
      `
      SELECT 
        mp.*,
        u.id AS composer_id,
        u.first_name,
        u.last_name,
        u.email AS composer_email,
        u.avatar AS composer_avatar

      FROM music_publications mp
      JOIN users u ON mp.composer_id = u.id

      ${whereClause}

      ORDER BY ${finalOrderQuery}

      LIMIT ? OFFSET ?
      `,
      [...whereValues, safeLimit, offset]
    );

    // =============================
    // COUNT QUERY
    // =============================
    const [countResult] = await mysqlConnection.execute(
      `
      SELECT COUNT(*) AS total
      FROM music_publications mp
      JOIN users u ON mp.composer_id = u.id
      ${whereClause}
      `,
      whereValues
    );

    const total = countResult[0]?.total || 0;
    const totalPages = Math.ceil(total / safeLimit);

    // =============================
    // FORMAT RESPONSE
    // =============================
    const formattedPublications = publications.map((pub) => ({
      id: pub.id,
      compositionTitle: pub.composition_title,
      compositionDescription: pub.composition_description,
      composerFirstName: pub.composer_firstname,
      composerLastName: pub.composer_lastname,

      vocalParts: pub.vocal_parts
        ? typeof pub.vocal_parts === "string"
          ? JSON.parse(pub.vocal_parts)
          : pub.vocal_parts
        : null,

      instrumentation: pub.instrumentation
        ? typeof pub.instrumentation === "string"
          ? JSON.parse(pub.instrumentation)
          : pub.instrumentation
        : null,

      artists: pub.artists
        ? typeof pub.artists === "string"
          ? JSON.parse(pub.artists)
          : pub.artists
        : [],

      typesOfMusic: pub.types_of_music,
      firstLineOfComposition: pub.first_line_of_composition,

      compositionCopyrights: pub.composition_copyrights
        ? typeof pub.composition_copyrights === "string"
          ? JSON.parse(pub.composition_copyrights)
          : pub.composition_copyrights
        : [],

      massSettingParts: pub.mass_setting_parts
        ? (() => {
          try {
            return JSON.parse(pub.mass_setting_parts);
          } catch {
            return pub.mass_setting_parts;
          }
        })()
        : [],

      songType: pub.song_type,
      meter: pub.meter,
      season: pub.season,
      psalmNumber: pub.psalm_number,

      textCopyrightNotice: pub.text_copyright_notice,
      tuneCopyrightNotice: pub.tune_copyright_notice,

      musicFiles: pub.music_files ? JSON.parse(pub.music_files) : [],

      artworkFileUrl: pub.artwork_file_url,
      artworkFileSize: pub.artwork_file_size,

      price: parseFloat(pub.price) || 0,
      isFree: Boolean(pub.is_free),

      status: pub.status,
      toggle: pub.toggle,
      publishedAt: pub.published_at,
      createdAt: pub.created_at,
      updatedAt: pub.updated_at,

      composer: {
        id: pub.composer_id,
        firstName: pub.first_name,
        lastName: pub.last_name,
        fullName: `${pub.first_name} ${pub.last_name}`,
        email: pub.composer_email,
        avatar: pub.composer_avatar,
      },
    }));

    // =============================
    // FINAL RESPONSE
    // =============================
    return successResponse(
      res,
      {
        publications,
        pagination: {
          page: safePage,
          limit: safeLimit,
          total,
          totalPages,
        },
        sorting: {
          sortBy,
          sortOrder: orderDirection
        }
      },
      "All music publications retrieved successfully"
    );

  } catch (error) {
    console.error("Get all music error:", error);
    return errorResponse(res, "Failed to get music publications", 500);
  }
});


// =============================
// SAFE JSON PARSER (helper)
// =============================
function safeJSON(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback ?? value;
  }
}

// @route   GET /api/music-publications
// @desc    Get all publications with sorting + pagination + filters
// @access  Private

router.get("/", [auth], async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    // =============================
    // Pagination (SAFE)
    // =============================
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 10, 100);
    const offset = (page - 1) * limit;

    // =============================
    // Sorting (SAFE)
    // =============================
    const sortBy = req.query.sortBy || "created_at";
    const sortOrder = req.query.sortOrder === "asc" ? "ASC" : "DESC";

    const sortColumnMap = {
      composition_title: "mp.composition_title",
      id: "mp.id",
      composer: "CONCAT(u.first_name, ' ', u.last_name)",
      typesOfMusic: "mp.types_of_music",
      price: "mp.price",
      created_at: "mp.created_at",
      status: "mp.status",
      review_stage: "mp.review_stage"
    };

    const orderByColumn = sortColumnMap[sortBy] || "mp.created_at";

    // =============================
    // Filters
    // =============================
    const { status, stage, title, publishType } = req.query;

    let whereClause = "WHERE 1=1";
    let whereValues = [];

    if (status) {
      whereClause += " AND mp.status = ?";
      whereValues.push(status);
    }

    if (stage) {
      whereClause += " AND mp.review_stage = ?";
      whereValues.push(stage);
    }

    if (publishType) {
      whereClause += " AND mp.publish_type = ?";
      whereValues.push(publishType);
    }

    if (title) {
      whereClause += " AND mp.composition_title LIKE ?";
      whereValues.push(`%${title}%`);
    }

    // =============================
    // Total Count
    // =============================
    const [countRows] = await mysqlConnection.execute(
      `
      SELECT COUNT(*) AS total
      FROM music_publications mp
      JOIN users u ON mp.composer_id = u.id
      ${whereClause}
      `,
      whereValues
    );

    const totalPublications = countRows[0]?.total || 0;
    const totalPages = Math.ceil(totalPublications / limit);

    // =============================
    // Main Query
    // =============================
    const [publications] = await mysqlConnection.execute(
      `
      SELECT 
        mp.*,
        u.id AS composer_id,
        u.first_name,
        u.last_name,
        u.email AS composer_email,
        u.publisherName AS publisher_name

      FROM music_publications mp
      JOIN users u ON mp.composer_id = u.id
      ${whereClause}

      ORDER BY ${orderByColumn} ${sortOrder}

      LIMIT ? OFFSET ?
      `,
      [...whereValues, limit, offset]
    );

    // =============================
    // Response Format
    // =============================
    const formatted = publications.map((pub) => ({
      ...pub,
      composer: {
        id: pub.composer_id,
        firstName: pub.first_name,
        lastName: pub.last_name,
        fullName: `${pub.first_name} ${pub.last_name}`.trim(),
        email: pub.composer_email,
        publisherName: pub.publisher_name,
      },
    }));

    // =============================
    // Final Response
    // =============================
    return res.json({
      success: true,
      message: "Publications fetched successfully",
      data: {
        publications: formatted,
        pagination: {
          page,
          limit,
          total: totalPublications,
          totalPages,
        },
        sorting: {
          sortBy,
          sortOrder,
        },
      },
    });

  } catch (error) {
    console.error("Get publications error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch publications",
      error: error.message,
    });
  }
});

// Stage 1: Review Board decisions (requires 2 approvals before Director stage)
// Stage 1: Review Board decisions (2 parallel slots supported)
router.post(
  "/:id/review-board/decision",
  [auth, requireSLTeamReviewAccess],
  async (req, res) => {
    try {
      const { id } = req.params;
      const { decision, notes, musicFiles } = req.body;

      if (!["approved", "rejected", "accept_with_changes"].includes(decision)) {
        return errorResponse(
          res,
          "Invalid decision. Must be: approved, rejected, or accept_with_changes",
          400
        );
      }

      const mysqlConnection = getMySQLConnection();

      const [rows] = await mysqlConnection.execute(
        `SELECT * FROM music_publications WHERE id = ?`,
        [id]
      );

      if (!rows.length) {
        return errorResponse(res, "Music publication not found", 404);
      }

      const currentState = rows[0];

      if (currentState.review_stage !== "review_board") {
        return errorResponse(res, "Invalid stage for this action.", 400);
      }

      /* =====================================
         DETERMINE SLOT
      ===================================== */

      let slot = null;

      if (
        currentState.stage1_slot1_reviewer_id === req.user.id &&
        currentState.stage1_slot1_status === "start"
      ) {
        slot = 1;
      }

      if (
        currentState.stage1_slot2_reviewer_id === req.user.id &&
        currentState.stage1_slot2_status === "start"
      ) {
        slot = 2;
      }

      const isOverride =
        req.user.user_type === "superadmin" ||
        hasBadge(req.user, "Director of SLC");

      if (!slot && isOverride) {
        if (currentState.stage1_slot1_status !== "complete") {
          slot = 1;
        } else {
          slot = 2;
        }
      }

      if (!slot) {
        return errorResponse(
          res,
          "You must start review before submitting decision.",
          403
        );
      }

      /* =====================================
         PREVENT DOUBLE REVIEW
      ===================================== */

      let stage1Reviews = parseJsonField(currentState.stage1_reviews, []);
      if (!Array.isArray(stage1Reviews)) stage1Reviews = [];

      const isPrivilegedUser =
        ["admin", "superadmin"].includes(req.user.user_type) ||
        hasBadge(req.user, "Director of SLC");

      if (
        !isPrivilegedUser &&
        stage1Reviews.some((r) => r.reviewerId === req.user.id)
      ) {
        return errorResponse(res, "You already reviewed this publication.", 400);
      }

      if (stage1Reviews.length >= 2) {
        return errorResponse(res, "Two reviews already recorded.", 400);
      }

      const reviewerName =
        `${req.user.first_name || ""} ${req.user.last_name || ""}`.trim() ||
        "Anonymous";

      const reviewEntry = {
        reviewerId: req.user.id,
        reviewerName,
        reviewerEmail: req.user.email || null,
        reviewerRole: req.user.role || null,
        decision,
        notes: notes || null,
        replacedFiles:
          Array.isArray(musicFiles) && musicFiles.length ? musicFiles : null,
        reviewedAt: new Date().toISOString(),
      };

      stage1Reviews.push(reviewEntry);

      /* =====================================
         AGGREGATE DECISION
      ===================================== */

      const rejectionExists = stage1Reviews.some(
        (r) => r.decision === "rejected"
      );

      const approvals = stage1Reviews.filter((r) =>
        ["approved", "accept_with_changes"].includes(r.decision)
      ).length;

      const hasAcceptWithChanges = stage1Reviews.some(
        (r) => r.decision === "accept_with_changes"
      );

      let stage1Decision = null;

      if (rejectionExists) stage1Decision = "rejected";
      else if (hasAcceptWithChanges) stage1Decision = "accept_with_changes";
      else if (approvals > 0) stage1Decision = "approved";

      const aggregatedNotes = stage1Reviews
        .filter((r) => r.notes)
        .map((r, i) => `Reviewer ${i + 1} (${r.reviewerName}): ${r.notes}`)
        .join("\n\n---\n\n");

      const replacedHistory = stage1Reviews
        .filter((r) => Array.isArray(r.replacedFiles))
        .map((r) => ({
          reviewerId: r.reviewerId,
          reviewerName: r.reviewerName,
          files: r.replacedFiles,
          reviewedAt: r.reviewedAt,
        }));

      /* =====================================
         STAGE TRANSITION
      ===================================== */

      let reviewStageUpdate = null;
      let statusUpdate = null;
      let moveToDirectorReview = false;

      if (stage1Reviews.length === 2) {
        moveToDirectorReview = true;
        reviewStageUpdate = "director_review";
        statusUpdate = "admin_review";
      }

      /* =====================================
         UPDATE DB
      ===================================== */

      const updateFields = [
        "stage1_decision = ?",
        "stage1_notes = ?",
        "stage1_reviews = ?",
        "stage1_reviewed_by = ?",
        "stage1_reviewed_at = NOW()",
        "stage1_replaced_files = ?",
      ];

      const updateValues = [
        stage1Decision,
        aggregatedNotes || null,
        JSON.stringify(stage1Reviews),
        req.user.id,
        replacedHistory.length ? JSON.stringify(replacedHistory) : null,
      ];

      if (Array.isArray(musicFiles) && musicFiles.length) {
        updateFields.push("music_files = ?");
        updateValues.push(JSON.stringify(musicFiles));
      }

      if (reviewStageUpdate) {
        updateFields.push("review_stage = ?");
        updateValues.push(reviewStageUpdate);
      }

      if (statusUpdate) {
        updateFields.push("status = ?");
        updateValues.push(statusUpdate);
      }

      updateFields.push(`stage1_slot${slot}_status = 'complete'`);
      updateFields.push(`stage1_slot${slot}_completed_at = NOW()`);
      updateFields.push("updated_at = NOW()");

      updateValues.push(id);

      await mysqlConnection.execute(
        `UPDATE music_publications SET ${updateFields.join(", ")} WHERE id = ?`,
        updateValues
      );

      /* =====================================
         EMAIL ONLY AFTER 2 REVIEWS
      ===================================== */

      if (stage1Reviews.length === 2) {
        console.log("📧 Sending email to Director...");

        const compositionName =
          currentState.composition_title || "Music Publication";

        const emailStatus =
          stage1Decision === "rejected"
            ? "not_approved"
            : hasAcceptWithChanges
              ? "accept_with_changes"
              : "accept";

        const template = getStage1ReviewTemplate(
          compositionName,
          aggregatedNotes || "No additional notes provided.",
          emailStatus
        );

        const TO_EMAIL = process.env.MUSIC_STEP_2_TO_EMAILS
          ? process.env.MUSIC_STEP_2_TO_EMAILS.split(",").map((e) => e.trim())
          : [];

        const CC_EMAILS = process.env.MUSIC_STEP_2_CC_EMAILS
          ? process.env.MUSIC_STEP_2_CC_EMAILS.split(",").map((e) => e.trim())
          : [];

        if (template && TO_EMAIL.length) {
          await sendEmail({
            to: TO_EMAIL,
            cc: CC_EMAILS,
            subject: template.subject,
            html: template.body,
          });

          console.log("✅ Email sent to Director of SLC");
        }
      }

      /* =====================================
         FETCH UPDATED RECORD
      ===================================== */

      const [publicationRows] = await mysqlConnection.execute(
        `SELECT * FROM music_publications WHERE id = ?`,
        [id]
      );

      const publication = publicationRows[0];

      successResponse(
        res,
        {
          id,
          reviewStage: publication.review_stage,
          decision,
          bothApproved: moveToDirectorReview,
        },
        moveToDirectorReview
          ? "Two reviews completed. Awaiting Director review."
          : "Review saved successfully."
      );
    } catch (error) {
      console.error("Stage 1 decision error:", error);
      errorResponse(res, "Failed to save decision", 500);
    }
  }
);

// Review Board: add comment with status
router.post(
  "/:id/review-board/comments",
  [auth, requireSLTeamReviewAccess],
  async (req, res) => {
    try {
      const { id } = req.params;
      const {
        comment,
        status,
        whatIssues,
        musicalIssues,
        textualIssues,
        engravingIssues,
      } = req.body;

      if (!comment || typeof comment !== "string") {
        return errorResponse(res, "Comment text is required", 400);
      }

      if (!status || !REVIEW_BOARD_COMMENT_STATUSES.includes(status)) {
        return errorResponse(
          res,
          `Invalid status. Allowed: ${REVIEW_BOARD_COMMENT_STATUSES.join(", ")}`,
          400,
        );
      }

      const mysqlConnection = getMySQLConnection();

      // Ensure comment column
      await ensureColumnExists(
        mysqlConnection,
        "music_publications",
        "stage1_review_comments",
        "LONGTEXT",
      );

      const [rows] = await mysqlConnection.execute(
        `SELECT review_stage,
              stage1_review_comments,
              stage1_slot1_status,
              stage1_slot1_reviewer_id,
              stage1_slot1_reviewer_name,
              stage1_slot2_status,
              stage1_slot2_reviewer_id,
              stage1_slot2_reviewer_name
       FROM music_publications
       WHERE id = ?`,
        [id],
      );

      if (!rows.length)
        return errorResponse(res, "Music publication not found", 404);

      const pub = rows[0];

      if (pub.review_stage !== "review_board")
        return errorResponse(
          res,
          "Cannot add review board comments at this stage",
          400,
        );

      // 🔐 SLOT VALIDATION
      let slot = null;

      if (
        pub.stage1_slot1_reviewer_id === req.user.id &&
        pub.stage1_slot1_status === "start"
      ) {
        slot = 1;
      } else if (
        pub.stage1_slot2_reviewer_id === req.user.id &&
        pub.stage1_slot2_status === "start"
      ) {
        slot = 2;
      } else {
        return errorResponse(
          res,
          "You are not assigned to an active review slot.",
          403,
        );
      }

      let comments = parseJsonField(pub.stage1_review_comments, []);
      if (!Array.isArray(comments)) comments = [];

      const nowIso = new Date().toISOString();
      const reviewerName =
        `${req.user.first_name || ""} ${req.user.last_name || ""}`.trim() ||
        null;

      const commentEntry = {
        id: randomUUID(),
        reviewerId: req.user.id,
        reviewerName,
        slot,
        status,
        comment: comment.trim(),
        createdAt: nowIso,
        updatedAt: nowIso,
        whatIssues,
        musicalIssues,
        textualIssues,
        engravingIssues,
      };

      comments.push(commentEntry);

      await mysqlConnection.execute(
        `UPDATE music_publications
       SET stage1_review_comments = ?,
           updated_at = NOW()
       WHERE id = ?`,
        [JSON.stringify(comments), id],
      );

      successResponse(
        res,
        {
          id,
          slot,
          comments,
        },
        "Review board comment added",
      );
    } catch (error) {
      console.error("Review board comment add error:", error);
      errorResponse(res, "Failed to add comment", 500);
    }
  },
);

// Review Board: update comment/status before director stage
router.put(
  "/:id/review-board/comments/:commentId",
  [auth, requireSLTeamReviewAccess],
  async (req, res) => {
    try {
      const { id, commentId } = req.params;
      const {
        comment,
        status,
        whatIssues,
        musicalIssues,
        textualIssues,
        engravingIssues,
      } = req.body;

      if (
        (comment && typeof comment !== "string") ||
        (status && !REVIEW_BOARD_COMMENT_STATUSES.includes(status))
      ) {
        return errorResponse(res, "Invalid comment or status payload", 400);
      }

      const mysqlConnection = getMySQLConnection();
      // Ensure comments column exists (create if missing)
      await ensureColumnExists(
        mysqlConnection,
        "music_publications",
        "stage1_review_comments",
        "LONGTEXT",
      );
      await ensureColumnExists(
        mysqlConnection,
        "music_publications",
        "stage1_reviews",
        "LONGTEXT",
      );
      const [rows] = await mysqlConnection.execute(
        "SELECT review_stage, stage1_review_comments, stage1_reviews, stage1_decision FROM music_publications WHERE id = ?",
        [id],
      );

      if (rows.length === 0) {
        return errorResponse(res, "Music publication not found", 404);
      }

      if (rows[0].review_stage !== "review_board") {
        return errorResponse(
          res,
          "Cannot edit review board comments at this stage",
          400,
        );
      }

      let comments = parseJsonField(rows[0].stage1_review_comments, []);
      if (!Array.isArray(comments)) comments = [];

      const commentIndex = comments.findIndex(
        (entry) => entry && entry.id === commentId,
      );
      if (commentIndex === -1) {
        return errorResponse(res, "Comment not found", 404);
      }

      const commentEntry = comments[commentIndex];
      if (commentEntry.reviewerId !== req.user.id) {
        return errorResponse(res, "You can only edit your own comments", 403);
      }

      if (comment) {
        commentEntry.comment = comment.trim();
      }
      if (status) {
        commentEntry.status = status;
      }
      if (whatIssues) {
        commentEntry.whatIssues = whatIssues;
      }
      if (musicalIssues) {
        commentEntry.musicalIssues = musicalIssues;
      }
      if (textualIssues) {
        commentEntry.textualIssues = textualIssues;
      }
      if (engravingIssues) {
        commentEntry.engravingIssues = engravingIssues;
      }
      commentEntry.updatedAt = new Date().toISOString();

      comments[commentIndex] = commentEntry;

      await mysqlConnection.execute(
        "UPDATE music_publications SET stage1_review_comments = ?, updated_at = NOW() WHERE id = ?",
        [JSON.stringify(comments), id],
      );

      const [publicationRows] = await mysqlConnection.execute(
        `SELECT 
         mp.*,
         u.first_name as composer_first_name,
         u.email as composer_email
       FROM music_publications mp
       LEFT JOIN users u ON mp.composer_id = u.id
       WHERE mp.id = ?`,
        [id],
      );

      const publication = publicationRows[0];

      successResponse(
        res,
        {
          id,
          reviewStage: publication.review_stage,
          stage: "stage1",
          comments,
          reviewHistory: buildReviewHistory(publication),
        },
        "Review board comment updated",
      );
    } catch (error) {
      console.error("Review board comment update error:", error);
      errorResponse(res, "Failed to update comment", 500);
    }
  },
);

// Review Board: delete comment before director stage
router.delete(
  "/:id/review-board/comments/:commentId",
  [auth, requireSLTeamReviewAccess],
  async (req, res) => {
    try {
      const { id, commentId } = req.params;
      const mysqlConnection = getMySQLConnection();
      // Ensure comments column exists (create if missing)
      await ensureColumnExists(
        mysqlConnection,
        "music_publications",
        "stage1_review_comments",
        "LONGTEXT",
      );
      const [rows] = await mysqlConnection.execute(
        "SELECT review_stage, stage1_review_comments FROM music_publications WHERE id = ?",
        [id],
      );

      if (rows.length === 0) {
        return errorResponse(res, "Music publication not found", 404);
      }

      if (rows[0].review_stage !== "review_board") {
        return errorResponse(
          res,
          "Cannot delete review board comments at this stage",
          400,
        );
      }

      let comments = parseJsonField(rows[0].stage1_review_comments, []);
      if (!Array.isArray(comments)) comments = [];

      const commentIndex = comments.findIndex(
        (entry) => entry && entry.id === commentId,
      );
      if (commentIndex === -1) {
        return errorResponse(res, "Comment not found", 404);
      }

      const commentEntry = comments[commentIndex];
      if (commentEntry.reviewerId !== req.user.id) {
        return errorResponse(res, "You can only delete your own comments", 403);
      }

      // Remove the comment
      comments.splice(commentIndex, 1);

      await mysqlConnection.execute(
        "UPDATE music_publications SET stage1_review_comments = ?, updated_at = NOW() WHERE id = ?",
        [JSON.stringify(comments), id],
      );

      const [publicationRows] = await mysqlConnection.execute(
        `SELECT 
         mp.*,
         u.first_name as composer_first_name,
         u.email as composer_email
       FROM music_publications mp
       LEFT JOIN users u ON mp.composer_id = u.id
       WHERE mp.id = ?`,
        [id],
      );

      const publication = publicationRows[0];

      successResponse(
        res,
        {
          id,
          reviewStage: publication.review_stage,
          stage: "stage1",
          comments,
          reviewHistory: buildReviewHistory(publication),
        },
        "Review board comment deleted",
      );
    } catch (error) {
      console.error("Review board comment delete error:", error);
      errorResponse(res, "Failed to delete comment", 500);
    }
  },
);

// Stage 2: Director of SLC decision (after two review board approvals)
router.post("/:id/director/decision", [auth], async (req, res) => {
  try {
    // Authorization check - only Director of SLC badge can access
    if (
      !hasBadge(req.user, "Director of SLC") &&
      req.user.user_type !== "superadmin"
    ) {
      return errorResponse(
        res,
        "Forbidden: Only Director of SLC badge or Super Admin can perform this action",
        403,
      );
    }

    const { id } = req.params;
    const { decision, notes, musicFiles } = req.body;

    if (!["approved", "rejected", "accept_with_changes"].includes(decision)) {
      return errorResponse(
        res,
        "Invalid decision. Must be: approved, rejected, or accept_with_changes",
        400,
      );
    }

    const mysqlConnection = getMySQLConnection();

    const STEP3_CC = process.env.MUSIC_STEP_3_CC
      ? process.env.MUSIC_STEP_3_CC.split(",").map(e => e.trim())
      : [];

    const STEP3_BCC = process.env.MUSIC_STEP_3_BCC
      ? process.env.MUSIC_STEP_3_BCC.split(",").map(e => e.trim())
      : [];

    const [rows] = await mysqlConnection.execute(
      `SELECT 
        mp.*,
        u.first_name AS composer_first_name,
        u.email AS composer_email
       FROM music_publications mp
       LEFT JOIN users u ON mp.composer_id = u.id
       WHERE mp.id = ?`,
      [id]
    );

    if (!rows.length) {
      return errorResponse(res, "Music publication not found", 404);
    }

    const currentState = rows[0];

    if (currentState.review_stage !== "director_review") {
      return errorResponse(res, "Invalid stage for this action", 400);
    }

    if (
      currentState.stage2_decision &&
      currentState.stage2_decision !== "accept_with_changes"
    ) {
      return errorResponse(
        res,
        "Director already made a decision.",
        400
      );
    }

    const stage1Reviews = parseJsonField(currentState.stage1_reviews, []);

    if (!Array.isArray(stage1Reviews) || stage1Reviews.length < 2) {
      return errorResponse(
        res,
        "Two review board decisions required before director review.",
        400
      );
    }

    const reviewerName =
      `${req.user.first_name || ""} ${req.user.last_name || ""}`.trim() ||
      "Director";

    const updateFields = [
      "stage2_decision = ?",
      "stage2_notes = ?",
      "stage2_reviewed_by = ?",
      "stage2_reviewed_at = NOW()"
    ];

    const updateValues = [
      decision,
      notes || null,
      req.user.id
    ];

    let replacedHistory = parseJsonField(
      currentState.stage2_replaced_files,
      []
    );

    if (!Array.isArray(replacedHistory)) replacedHistory = [];

    if (Array.isArray(musicFiles) && musicFiles.length) {

      replacedHistory.push({
        reviewerId: req.user.id,
        reviewerName,
        files: musicFiles,
        reviewedAt: new Date().toISOString()
      });

      updateFields.push("music_files = ?");
      updateValues.push(JSON.stringify(musicFiles));
    }

    updateFields.push("stage2_replaced_files = ?");
    updateValues.push(
      replacedHistory.length ? JSON.stringify(replacedHistory) : null
    );

    // Append this decision into stage2_history (full history of every Director decision)
    let stage2History = parseJsonField(currentState.stage2_history, []);
    if (!Array.isArray(stage2History)) stage2History = [];
    stage2History.push({
      decision,
      notes: notes || null,
      reviewed_by: req.user.id,
      reviewer_name: reviewerName,
      reviewed_at: new Date().toISOString(),
      replaced_files: replacedHistory.length ? replacedHistory : null,
    });
    updateFields.push("stage2_history = ?");
    updateValues.push(JSON.stringify(stage2History));

    let moveToEditorial = false;

    if (decision === "rejected") {
      updateFields.push("review_stage = ?", "status = ?");
      updateValues.push("rejected", "rejected");
    }

    if (decision === "approved") {
      moveToEditorial = true;
      updateFields.push("review_stage = ?", "status = ?");
      updateValues.push("music_editorial", "sl_team_review");
    }

    updateFields.push("updated_at = NOW()");
    updateValues.push(id);

    await mysqlConnection.execute(
      `UPDATE music_publications SET ${updateFields.join(", ")} WHERE id = ?`,
      updateValues
    );

    const [publicationRows] = await mysqlConnection.execute(
      `SELECT 
        mp.*,
        u.first_name AS composer_first_name,
        u.email AS composer_email
       FROM music_publications mp
       LEFT JOIN users u ON mp.composer_id = u.id
       WHERE mp.id = ?`,
      [id]
    );

    const publication = publicationRows[0];

    /* ==================================================
       EMAIL SECTION
    ================================================== */

    try {

      const composerEmail = publication.composer_email;

      console.log("Composer Email:", composerEmail);

      const compositionName =
        publication.composition_title || "Music Publication";

      const composerFirstName =
        publication.composer_first_name || "Composer";

      const emailBody = `
        Hello ${composerFirstName},

        Your composition "${compositionName}" has been reviewed by the Director of SLC.

        Decision: ${decision}

        Notes:
        ${notes || "No notes provided."}

        Regards
        Simply Liturgical Music
      `;

      /* ===== SEND EMAIL TO COMPOSER ===== */

      if (composerEmail) {

        await sendEmail({
          to: [composerEmail],
          cc: STEP3_CC,
          bcc: STEP3_BCC,
          subject: `Director Review Update - ${compositionName}`,
          html: `<pre>${emailBody}</pre>`
        });

        console.log("✅ Composer email sent");

      } else {

        console.log("❌ Composer email missing");

      }

      /* ===== SEND EMAIL TO EDITORIAL ===== */

      if (moveToEditorial) {

        const [editorialUsers] = await mysqlConnection.execute(
          `SELECT email FROM users
           WHERE JSON_SEARCH(badges,'one','Music Editorial') IS NOT NULL
           AND is_active = 1
           AND deleted_at IS NULL`
        );

        const editorialEmails = editorialUsers
          .map(u => u.email)
          .filter(Boolean);

        console.log("Editorial Emails:", editorialEmails);

        if (editorialEmails.length) {
          const template = getDirectorOfSLCEditorialTemplate(
            compositionName,
            allAnswers,
            decision === "accept_with_changes"
              ? "approved_with_changes"
              : "approved",
          );
          if (template) {
            await sendEmail({
              to: editorialEmails,
              cc: STEP3_CC,
              bcc: STEP3_BCC,
              subject: template.subject,
              html: template.body,
            });
            console.log("✅ Editorial notification email sent");
          }
        }
      }
    } catch (emailError) {
      console.error("⚠️ Director stage email error:", emailError);
    }

    let message;
    if (decision === "rejected") {
      message = "Director of SLC decision saved. Publication rejected.";
    } else if (moveToEditorial) {
      message =
        "Director of SLC decision saved. Moving to music editorial review.";
    } else {
      message =
        "Director of SLC decision saved. Awaiting composer resubmission.";
    }

    /* ==================================================
   🔔 SYSTEM NOTIFICATION TO COMPOSER (ALWAYS)
================================================== */
    try {
      const compositionName =
        currentState.composition_title || "your music composition";

      let body = "";
      if (decision === "rejected") {
        body = `Your composition "${compositionName}" was rejected by the Director of SLC.`;
      } else if (decision === "accept_with_changes") {
        body = `Your composition "${compositionName}" was reviewed by the Director of SLC and requires changes.`;
      } else {
        body = `Your composition "${compositionName}" was approved by the Director of SLC.`;
      }

      await createAndDeliverNotification(
        {
          title: "Director of SLC Review Update",
          body,
          metadata: {
            publication_id: id,
            decision,
            stage: "director_review",
          },
          channel: "inbox",
          target: {
            type: "custom",
            user_ids: [currentState.composer_id],
          },
        },
        null, // system-generated
        mysqlConnection,
      );

      console.log(
        `✅ Composer notification sent (Stage-2, Decision: ${decision})`,
      );
    } catch (notifErr) {
      console.error("⚠️ Composer notification error (Stage-2):", notifErr);
    }

    successResponse(
      res,
      {
        id,
        reviewStage: publication.review_stage,
        decision,
        stage: "stage2",
        moveToEditorial,
        directorReview: {
          reviewerName,
          decision,
          notes: notes || null,
          replacedFiles: Array.isArray(musicFiles) ? musicFiles : null,
        },
        reviewHistory: buildReviewHistory(publication),
      },
      message,
    );
  } catch (error) {
    console.error("Director (Stage 2) decision error:", error);
    errorResponse(res, "Failed to save director decision", 500);
  }
});

// Director of SLC: approve/disapprove review board comments
router.post(
  "/:id/review-board/comments/:commentId/director-review",
  [auth],
  async (req, res) => {
    try {
      // Authorization check - only Director of SLC badge can access
      if (
        !hasBadge(req.user, "Director of SLC") &&
        req.user.user_type !== "superadmin"
      ) {
        return errorResponse(
          res,
          "Forbidden: Only Director of SLC badge can perform this action",
          403,
        );
      }

      const { id, commentId } = req.params;
      const { decision, notes } = req.body;

      if (!["approved", "disapproved"].includes(decision)) {
        return errorResponse(
          res,
          "Invalid decision. Must be: approved or disapproved",
          400,
        );
      }

      const mysqlConnection = getMySQLConnection();
      // Ensure comment columns exist (create if missing)
      await ensureColumnExists(
        mysqlConnection,
        "music_publications",
        "stage1_review_comments",
        "LONGTEXT",
      );
      await ensureColumnExists(
        mysqlConnection,
        "music_publications",
        "stage2_comments",
        "LONGTEXT",
      );
      await ensureColumnExists(
        mysqlConnection,
        "music_publications",
        "stage3_comments",
        "LONGTEXT",
      );
      await ensureColumnExists(
        mysqlConnection,
        "music_publications",
        "stage1_reviews",
        "LONGTEXT",
      );
      const [rows] = await mysqlConnection.execute(
        "SELECT review_stage, stage1_review_comments, stage2_comments, stage3_comments, stage1_reviews, stage1_decision FROM music_publications WHERE id = ?",
        [id],
      );

      if (rows.length === 0) {
        return errorResponse(res, "Music publication not found", 404);
      }

      // Allow director review if stage is director_review, music_editorial or if stage1 is complete
      const currentStage = rows[0].review_stage;
      const allowedStages = ["director_review", "music_editorial", "composer_revision", "published"];

      if (!allowedStages.includes(currentStage)) {
        const stage1Decision = rows[0].stage1_decision;
        const stage1ReviewsRaw = parseJsonField(rows[0].stage1_reviews, []);
        const stage1Reviews = Array.isArray(stage1ReviewsRaw)
          ? stage1ReviewsRaw
          : [];
        const approvals = stage1Reviews.filter(
          (entry) =>
            entry &&
            ["approved", "accept_with_changes"].includes(entry.decision),
        ).length;
        const rejectionExists = stage1Reviews.some(
          (entry) => entry && entry.decision === "rejected",
        );

        const readyForDirector =
          stage1Decision === "approved" && approvals >= 2 && !rejectionExists;
        if (!readyForDirector) {
          return errorResponse(
            res,
            "Director comment review is only allowed during director review stage or later",
            400,
          );
        }

        await mysqlConnection.execute(
          "UPDATE music_publications SET review_stage = ?, updated_at = NOW() WHERE id = ?",
          ["director_review", id],
        );
      }

      let commentsStage1 = parseJsonField(rows[0].stage1_review_comments, []);
      let commentsStage2 = parseJsonField(rows[0].stage2_comments, []);
      let commentsStage3 = parseJsonField(rows[0].stage3_comments, []);

      if (!Array.isArray(commentsStage1)) commentsStage1 = [];
      if (!Array.isArray(commentsStage2)) commentsStage2 = [];
      if (!Array.isArray(commentsStage3)) commentsStage3 = [];

      let commentFound = false;
      let targetColumn = null;
      let targetComments = null;
      let commentIndex = -1;

      // 1. Search in Stage 1 comments
      commentIndex = commentsStage1.findIndex(
        (entry) => entry && entry.id === commentId,
      );
      if (commentIndex !== -1) {
        commentFound = true;
        targetColumn = "stage1_review_comments";
        targetComments = commentsStage1;
      }

      // 2. Search in Stage 2 comments (director comments)
      if (!commentFound) {
        commentIndex = commentsStage2.findIndex(
          (entry) => entry && entry.id === commentId,
        );
        if (commentIndex !== -1) {
          commentFound = true;
          targetColumn = "stage2_comments";
          targetComments = commentsStage2;
        }
      }

      // 3. Search in Stage 3 comments (editorial comments)
      if (!commentFound) {
        commentIndex = commentsStage3.findIndex(
          (entry) => entry && entry.id === commentId,
        );
        if (commentIndex !== -1) {
          commentFound = true;
          targetColumn = "stage3_comments";
          targetComments = commentsStage3;
        }
      }

      if (!commentFound) {
        return errorResponse(res, "Comment not found", 404);
      }

      const commentEntry = targetComments[commentIndex];
      commentEntry.directorDecision = decision;
      commentEntry.directorNotes = notes || null;
      commentEntry.directorDecidedBy = req.user.id;
      commentEntry.directorDecidedAt = new Date().toISOString();

      targetComments[commentIndex] = commentEntry;

      let updateQuery = "";
      if (targetColumn === "stage1_review_comments") {
        updateQuery = "UPDATE music_publications SET stage1_review_comments = ?, updated_at = NOW() WHERE id = ?";
      } else if (targetColumn === "stage2_comments") {
        updateQuery = "UPDATE music_publications SET stage2_comments = ?, updated_at = NOW() WHERE id = ?";
      } else if (targetColumn === "stage3_comments") {
        updateQuery = "UPDATE music_publications SET stage3_comments = ?, updated_at = NOW() WHERE id = ?";
      }

      await mysqlConnection.execute(updateQuery, [
        JSON.stringify(targetComments),
        id,
      ]);

      const [publicationRows] = await mysqlConnection.execute(
        `SELECT 
         mp.*,
         u.first_name as composer_first_name,
         u.email as composer_email
       FROM music_publications mp
       LEFT JOIN users u ON mp.composer_id = u.id
       WHERE mp.id = ?`,
        [id],
      );

      const publication = publicationRows[0];

      successResponse(
        res,
        {
          id,
          reviewStage: publication.review_stage,
          stage: "stage2",
          comments: targetComments,
          reviewHistory: buildReviewHistory(publication),
        },
        "Director review recorded for comment",
      );
    } catch (error) {
      console.error("Director review board comment decision error:", error);
      errorResponse(res, "Failed to record director review", 500);
    }
  },
);

// Director of SLC: add comment for editorial team visibility
router.post("/:id/director/comments", [auth], async (req, res) => {
  try {
    // Authorization check - only Director of SLC badge can access
    if (
      !hasBadge(req.user, "Director of SLC") &&
      req.user.user_type !== "superadmin"
    ) {
      return errorResponse(
        res,
        "Forbidden: Only Director of SLC badge can perform this action",
        403,
      );
    }

    const { id } = req.params;
    const {
      comment,
      status,
      whatIssues,
      musicalIssues,
      textualIssues,
      engravingIssues,
    } = req.body;

    if (!comment || typeof comment !== "string") {
      return errorResponse(res, "Comment text is required", 400);
    }

    if (!status || !REVIEW_BOARD_COMMENT_STATUSES.includes(status)) {
      return errorResponse(
        res,
        `Invalid status. Allowed: ${REVIEW_BOARD_COMMENT_STATUSES.join(", ")}`,
        400,
      );
    }

    const mysqlConnection = getMySQLConnection();
    // Ensure stage2_comments exists (director comments storage)
    await ensureColumnExists(
      mysqlConnection,
      "music_publications",
      "stage2_comments",
      "LONGTEXT",
    );
    const [rows] = await mysqlConnection.execute(
      "SELECT review_stage, stage2_comments FROM music_publications WHERE id = ?",
      [id],
    );

    if (rows.length === 0) {
      return errorResponse(res, "Music publication not found", 404);
    }

    if (rows[0].review_stage !== "director_review") {
      return errorResponse(
        res,
        "Director comments can only be added during director review stage",
        400,
      );
    }

    let comments = parseJsonField(rows[0].stage2_comments, []);
    if (!Array.isArray(comments)) comments = [];

    const nowIso = new Date().toISOString();
    const directorName =
      `${req.user.first_name || ""} ${req.user.last_name || ""}`.trim() || null;

    const commentEntry = {
      id: randomUUID(),
      directorId: req.user.id,
      directorName,
      status,
      comment: comment.trim(),
      createdAt: nowIso,
      updatedAt: nowIso,
      whatIssues,
      musicalIssues,
      textualIssues,
      engravingIssues,
    };

    comments.push(commentEntry);

    await mysqlConnection.execute(
      "UPDATE music_publications SET stage2_comments = ?, updated_at = NOW() WHERE id = ?",
      [JSON.stringify(comments), id],
    );

    const [publicationRows] = await mysqlConnection.execute(
      `SELECT 
         mp.*,
         u.first_name as composer_first_name,
         u.email as composer_email
       FROM music_publications mp
       LEFT JOIN users u ON mp.composer_id = u.id
       WHERE mp.id = ?`,
      [id],
    );

    const publication = publicationRows[0];

    successResponse(
      res,
      {
        id,
        reviewStage: publication.review_stage,
        stage: "stage2",
        comments,
        reviewHistory: buildReviewHistory(publication),
      },
      "Director comment added",
    );
  } catch (error) {
    console.error("Director comment add error:", error);
    errorResponse(res, "Failed to add director comment", 500);
  }
});

// Director of SLC: edit comment for editorial team
router.put("/:id/director/comments/:commentId", [auth], async (req, res) => {
  try {
    // Authorization check - only Director of SLC badge can access
    if (
      !hasBadge(req.user, "Director of SLC") &&
      req.user.user_type !== "superadmin"
    ) {
      return errorResponse(
        res,
        "Forbidden: Only Director of SLC badge can perform this action",
        403,
      );
    }

    const { id, commentId } = req.params;
    const { comment } = req.body;

    if (!comment || typeof comment !== "string") {
      return errorResponse(res, "Comment text is required", 400);
    }

    const mysqlConnection = getMySQLConnection();
    // Ensure stage2_comments exists (director comments storage)
    await ensureColumnExists(
      mysqlConnection,
      "music_publications",
      "stage2_comments",
      "LONGTEXT",
    );
    const [rows] = await mysqlConnection.execute(
      "SELECT review_stage, stage2_comments FROM music_publications WHERE id = ?",
      [id],
    );

    if (rows.length === 0) {
      return errorResponse(res, "Music publication not found", 404);
    }

    if (rows[0].review_stage !== "director_review") {
      return errorResponse(
        res,
        "Director comments can only be edited during director review stage",
        400,
      );
    }

    let comments = parseJsonField(rows[0].stage2_comments, []);
    if (!Array.isArray(comments)) comments = [];

    const commentIndex = comments.findIndex(
      (entry) => entry && entry.id === commentId,
    );
    if (commentIndex === -1) {
      return errorResponse(res, "Comment not found", 404);
    }

    const commentEntry = comments[commentIndex];
    if (commentEntry.directorId !== req.user.id) {
      return errorResponse(res, "You can only edit your own comments", 403);
    }

    commentEntry.comment = comment.trim();
    commentEntry.updatedAt = new Date().toISOString();
    comments[commentIndex] = commentEntry;

    await mysqlConnection.execute(
      "UPDATE music_publications SET stage2_comments = ?, updated_at = NOW() WHERE id = ?",
      [JSON.stringify(comments), id],
    );

    const [publicationRows] = await mysqlConnection.execute(
      `SELECT 
         mp.*,
         u.first_name as composer_first_name,
         u.email as composer_email
       FROM music_publications mp
       LEFT JOIN users u ON mp.composer_id = u.id
       WHERE mp.id = ?`,
      [id],
    );

    const publication = publicationRows[0];

    successResponse(
      res,
      {
        id,
        reviewStage: publication.review_stage,
        stage: "stage2",
        comments,
        reviewHistory: buildReviewHistory(publication),
      },
      "Director comment updated",
    );
  } catch (error) {
    console.error("Director comment update error:", error);
    errorResponse(res, "Failed to update director comment", 500);
  }
});

// Director of SLC: delete comment for editorial team
router.delete("/:id/director/comments/:commentId", [auth], async (req, res) => {
  try {
    // Authorization check - only Director of SLC badge OR superadmin
    if (
      !hasBadge(req.user, "Director of SLC") &&
      req.user.user_type !== "superadmin"
    ) {
      return errorResponse(
        res,
        "Forbidden: Only Director of SLC badge can perform this action",
        403,
      );
    }

    const { id, commentId } = req.params;
    const mysqlConnection = getMySQLConnection();

    // Ensure stage2_comments exists
    await ensureColumnExists(
      mysqlConnection,
      "music_publications",
      "stage2_comments",
      "LONGTEXT",
    );

    const [rows] = await mysqlConnection.execute(
      "SELECT review_stage, stage2_comments FROM music_publications WHERE id = ?",
      [id],
    );

    if (rows.length === 0) {
      return errorResponse(res, "Music publication not found", 404);
    }

    if (rows[0].review_stage !== "director_review") {
      return errorResponse(
        res,
        "Director comments can only be deleted during director review stage",
        400,
      );
    }

    let comments = parseJsonField(rows[0].stage2_comments, []);
    if (!Array.isArray(comments)) comments = [];

    const commentIndex = comments.findIndex(
      (entry) => entry && entry.id === commentId,
    );

    if (commentIndex === -1) {
      return errorResponse(res, "Comment not found", 404);
    }

    const commentEntry = comments[commentIndex];

    // Only original director OR superadmin can delete
    if (
      commentEntry.directorId !== req.user.id &&
      req.user.user_type !== "superadmin"
    ) {
      return errorResponse(res, "You can only delete your own comments", 403);
    }

    // Remove comment
    comments.splice(commentIndex, 1);

    await mysqlConnection.execute(
      "UPDATE music_publications SET stage2_comments = ?, updated_at = NOW() WHERE id = ?",
      [JSON.stringify(comments), id],
    );

    const [publicationRows] = await mysqlConnection.execute(
      `SELECT 
         mp.*,
         u.first_name as composer_first_name,
         u.email as composer_email
       FROM music_publications mp
       LEFT JOIN users u ON mp.composer_id = u.id
       WHERE mp.id = ?`,
      [id],
    );

    const publication = publicationRows[0];

    successResponse(
      res,
      {
        id,
        reviewStage: publication.review_stage,
        stage: "stage2",
        comments,
        reviewHistory: buildReviewHistory(publication),
      },
      "Director comment deleted",
    );
  } catch (error) {
    console.error("Director comment delete error:", error);
    errorResponse(res, "Failed to delete director comment", 500);
  }
});

// Stage 3: Editorial add comment
router.post("/:id/editorial/comments", [auth], async (req, res) => {
  try {
    // ✅ Authorization: Only Music Editorial badge OR superadmin
    if (
      !hasBadge(req.user, "Music Editorial") &&
      req.user.user_type !== "superadmin"
    ) {
      return errorResponse(
        res,
        "Forbidden: Only Music Editorial badge can perform this action",
        403,
      );
    }

    const { id } = req.params;
    const {
      comment,
      status,
      whatIssues,
      musicalIssues,
      textualIssues,
      engravingIssues,
    } = req.body;

    if (!comment || typeof comment !== "string") {
      return errorResponse(res, "Comment text is required", 400);
    }

    if (!status || !REVIEW_BOARD_COMMENT_STATUSES.includes(status)) {
      return errorResponse(
        res,
        `Invalid status. Allowed: ${REVIEW_BOARD_COMMENT_STATUSES.join(", ")}`,
        400,
      );
    }

    const mysqlConnection = getMySQLConnection();

    // ✅ Ensure column exists
    await ensureColumnExists(
      mysqlConnection,
      "music_publications",
      "stage3_comments",
      "LONGTEXT",
    );

    const [rows] = await mysqlConnection.execute(
      "SELECT review_stage, stage3_comments FROM music_publications WHERE id = ?",
      [id],
    );

    if (!rows.length) {
      return errorResponse(res, "Music publication not found", 404);
    }

    if (rows[0].review_stage !== "music_editorial") {
      return errorResponse(
        res,
        "Editorial comments can only be added during music_editorial stage",
        400,
      );
    }

    let comments = parseJsonField(rows[0].stage3_comments, []);
    if (!Array.isArray(comments)) comments = [];

    const nowIso = new Date().toISOString();
    const reviewerName =
      `${req.user.first_name || ""} ${req.user.last_name || ""}`.trim() || null;

    const commentEntry = {
      id: randomUUID(),
      editorialId: req.user.id,
      reviewerName,
      status,
      comment: comment.trim(),
      createdAt: nowIso,
      updatedAt: nowIso,
      whatIssues,
      musicalIssues,
      textualIssues,
      engravingIssues,
    };

    comments.push(commentEntry);

    await mysqlConnection.execute(
      `UPDATE music_publications 
       SET stage3_comments = ?, updated_at = NOW() 
       WHERE id = ?`,
      [JSON.stringify(comments), id],
    );

    // 🔄 Fetch updated publication for history
    const [publicationRows] = await mysqlConnection.execute(
      `SELECT mp.* 
       FROM music_publications mp
       WHERE mp.id = ?`,
      [id],
    );

    const publication = publicationRows[0];

    successResponse(
      res,
      {
        id,
        reviewStage: publication.review_stage,
        stage: "stage3",
        comments,
        reviewHistory: buildReviewHistory(publication),
      },
      "Editorial comment added",
    );
  } catch (error) {
    console.error("Stage3 (Editorial) comment add error:", error);
    errorResponse(res, "Failed to add editorial comment", 500);
  }
});

// Stage 3: Editorial edit comment
router.put("/:id/editorial/comments/:commentId", [auth], async (req, res) => {
  try {
    if (
      !hasBadge(req.user, "Music Editorial") &&
      req.user.user_type !== "superadmin"
    ) {
      return errorResponse(
        res,
        "Forbidden: Only Music Editorial badge can edit this comment",
        403,
      );
    }

    const { id, commentId } = req.params;
    const { comment } = req.body;

    if (!comment || typeof comment !== "string") {
      return errorResponse(res, "Updated comment text is required", 400);
    }

    const mysqlConnection = getMySQLConnection();

    const [rows] = await mysqlConnection.execute(
      "SELECT review_stage, stage3_comments FROM music_publications WHERE id = ?",
      [id],
    );

    if (!rows.length) {
      return errorResponse(res, "Music publication not found", 404);
    }

    if (rows[0].review_stage !== "music_editorial") {
      return errorResponse(
        res,
        "Comments can only be edited during music_editorial stage",
        400,
      );
    }

    let comments = parseJsonField(rows[0].stage3_comments, []);
    if (!Array.isArray(comments)) comments = [];

    const commentIndex = comments.findIndex((c) => c.id === commentId);

    if (commentIndex === -1) {
      return errorResponse(res, "Comment not found", 404);
    }

    // Allow only original author OR superadmin
    if (
      comments[commentIndex].editorialId !== req.user.id &&
      req.user.user_type !== "superadmin"
    ) {
      return errorResponse(res, "You can only edit your own comment", 403);
    }

    comments[commentIndex].comment = comment.trim();
    comments[commentIndex].updatedAt = new Date().toISOString();

    await mysqlConnection.execute(
      `UPDATE music_publications 
       SET stage3_comments = ?, updated_at = NOW()
       WHERE id = ?`,
      [JSON.stringify(comments), id],
    );

    successResponse(res, { comments }, "Editorial comment updated");
  } catch (error) {
    console.error("Stage3 comment edit error:", error);
    errorResponse(res, "Failed to edit comment", 500);
  }
});

// Stage 3: Editorial delete comment
router.delete(
  "/:id/editorial/comments/:commentId",
  [auth],
  async (req, res) => {
    try {
      if (
        !hasBadge(req.user, "Music Editorial") &&
        req.user.user_type !== "superadmin"
      ) {
        return errorResponse(
          res,
          "Forbidden: Only Music Editorial badge can delete this comment",
          403,
        );
      }

      const { id, commentId } = req.params;
      const mysqlConnection = getMySQLConnection();

      const [rows] = await mysqlConnection.execute(
        "SELECT review_stage, stage3_comments FROM music_publications WHERE id = ?",
        [id],
      );

      if (!rows.length) {
        return errorResponse(res, "Music publication not found", 404);
      }

      if (rows[0].review_stage !== "music_editorial") {
        return errorResponse(
          res,
          "Comments can only be deleted during music_editorial stage",
          400,
        );
      }

      let comments = parseJsonField(rows[0].stage3_comments, []);
      if (!Array.isArray(comments)) comments = [];

      const commentIndex = comments.findIndex((c) => c.id === commentId);

      if (commentIndex === -1) {
        return errorResponse(res, "Comment not found", 404);
      }

      // Allow only original author OR superadmin
      if (
        comments[commentIndex].editorialId !== req.user.id &&
        req.user.user_type !== "superadmin"
      ) {
        return errorResponse(res, "You can only delete your own comment", 403);
      }

      comments.splice(commentIndex, 1);

      await mysqlConnection.execute(
        `UPDATE music_publications 
       SET stage3_comments = ?, updated_at = NOW()
       WHERE id = ?`,
        [JSON.stringify(comments), id],
      );

      successResponse(res, { comments }, "Editorial comment deleted");
    } catch (error) {
      console.error("Stage3 comment delete error:", error);
      errorResponse(res, "Failed to delete comment", 500);
    }
  },
);

// Stage 3: Editorial review decision (can replace files)
router.post(
  "/:id/editorial/decision",
  [
    auth,
    // requireAnyRole(['music_editorial'])
  ],
  async (req, res) => {
    try {
      // Authorization check - only Music Editorial badge can access
      if (
        !hasBadge(req.user, "Music Editorial") &&
        req.user.user_type !== "superadmin"
      ) {
        return errorResponse(
          res,
          "Forbidden: Only Music Editorial badge can perform this action",
          403,
        );
      }
      const { id } = req.params;
      const { decision, notes, musicFiles } = req.body;
      if (!["approved", "rejected", "accept_with_changes"].includes(decision)) {
        return errorResponse(
          res,
          "Invalid decision. Must be: approved, rejected, or accept_with_changes",
          400,
        );
      }
      const mysqlConnection = getMySQLConnection();
      const [rows] = await mysqlConnection.execute(
        "SELECT review_stage, music_files FROM music_publications WHERE id = ?",
        [id],
      );

      const STEP4_CC = parseEmails(process.env.MUSIC_STEP_4_CC_EMAILS);
      const STEP4_BCC = parseEmails(process.env.MUSIC_STEP_4_BCC_EMAILS);
      if (rows.length === 0)
        return errorResponse(res, "Music publication not found", 404);
      if (rows[0].review_stage !== "music_editorial")
        return errorResponse(res, "Invalid stage for this action", 400);

      const isApproved = decision === "approved";
      const isRejected = decision === "rejected";
      const isRevisionRequested = decision === "accept_with_changes";

      const nextStage = isApproved
        ? "final_review"
        : isRejected
          ? "rejected"
          : "music_editorial";
      const nextStatus = isApproved
        ? "published"
        : isRejected
          ? "rejected"
          : null;

      const fields = [
        "stage3_decision = ?",
        "stage3_notes = ?",
        "stage3_reviewed_by = ?",
        "stage3_reviewed_at = NOW()",
        "review_stage = ?",
      ];
      const values = [decision, notes || null, req.user.id, nextStage];

      if (nextStatus) {
        fields.push("status = ?");
        values.push(nextStatus);
      }
      if (Array.isArray(musicFiles)) {
        fields.push("music_files = ?");
        values.push(JSON.stringify(musicFiles));
        fields.push("stage3_replaced_files = ?");
        values.push(JSON.stringify(musicFiles));
      }

      // Append this decision into stage3_history (full history of every Editorial decision)
      const [stage3HistoryRows] = await mysqlConnection.execute(
        "SELECT stage3_history FROM music_publications WHERE id = ?", [id]
      );
      let stage3History = parseJsonField(stage3HistoryRows[0]?.stage3_history, []);
      if (!Array.isArray(stage3History)) stage3History = [];
      const editorialReviewerName = `${req.user.first_name || ""} ${req.user.last_name || ""}`.trim() || "Editorial";
      stage3History.push({
        decision,
        notes: notes || null,
        reviewed_by: req.user.id,
        reviewer_name: editorialReviewerName,
        reviewed_at: new Date().toISOString(),
        replaced_files: Array.isArray(musicFiles) && musicFiles.length ? musicFiles : null,
      });
      fields.push("stage3_history = ?");
      values.push(JSON.stringify(stage3History));
      // If rejected at editorial stage, schedule deletion after 30 days
      if (decision === "rejected") {
        const deletionDate = new Date();
        deletionDate.setDate(deletionDate.getDate() + 30);
        fields.push("scheduled_deletion_at = ?");
        values.push(deletionDate.toISOString().slice(0, 19).replace("T", " "));
      }
      fields.push("updated_at = NOW()");
      values.push(id);

      await mysqlConnection.execute(
        `UPDATE music_publications SET ${fields.join(", ")} WHERE id = ?`,
        values,
      );

      // Send email notification to composer using textualReviewEmail function format
      // IMPORTANT: Email errors are completely isolated - they will NOT affect the review decision
      if (isApproved) {
        try {
          // Get publication and composer details for email
          const [pubRows] = await mysqlConnection.execute(
            `SELECT 
            mp.composition_title,
            mp.stage3_notes,
            u.email AS composer_email,
            u.first_name AS composer_first_name
          FROM music_publications mp
          LEFT JOIN users u ON mp.composer_id = u.id
          WHERE mp.id = ?`,
            [id],
          );

          if (pubRows.length > 0) {
            const publication = pubRows[0];
            const compositionName =
              publication.composition_title || "Music Publication";
            const composerFirstName =
              publication.composer_first_name || "Composer";
            const composerEmail = publication.composer_email;
            const allAnswers =
              publication.stage3_notes || "No additional notes provided.";

            // Map decision to email action for textualReviewEmail
            let emailAction;
            if (decision === "approved") {
              emailAction = "approved";
            } else if (decision === "accept_with_changes") {
              emailAction = "changes_needed";
            }

            // Send email to composer using textualReviewEmail function format
            if (composerEmail && emailAction) {
              try {
                const { sendEmail } = require("../utils/SendMailer");

                // Get template from textualReviewEmail function
                // The function sends TO kevin.digitalgrowthus@gmail.com, but we need to send to composer
                // So we'll use the template format and send directly
                const templates = {
                  approved: {
                    subject: `Editorial Review - ${compositionName}`,
                    body: `
                    <html>
                      <body>
                        <p>Hi ${composerFirstName},</p>

                        <p>
                          Congratulations! We are delighted to inform you that your composition, 
                          "<strong>${compositionName}</strong>," has been approved by our Editorial Team 
                          and will now move on to Publication, step three of the three step-process:
                        </p>

                        <p>✅ Music Review<br/>
                        ✅ Editorial Review<br/>
                        🟩 Publication</p>

                        <p>We will contact you once your composition product has been made. Below is your Official Review Summary.</p>
                        <pre>${allAnswers}</pre>

                        <p>God bless,<br/>
                        --<br/>
                        Editorial Team<br/>
                        Simply Liturgical Composer</p>
                      </body>
                    </html>
                  `,
                  },
                  changes_needed: {
                    subject: `Editorial Review - ${compositionName}`,
                    body: `
                    <html>
                      <body>
                        <p>Hi ${composerFirstName},</p>

                        <p>
                          After reviewing your composition, "<strong>${compositionName}</strong>," we found that 
                          it is in need of some corrections before we can move it on to Step 3 - Publication.
                        </p>

                        <p>This Official Review Summary outlines the corrections needed:</p>
                        <pre>${allAnswers}</pre>

                        <p>
                          Once the corrections are made, please reply to this email with your corrected file(s) 
                          for final approval. Once approved, you'll receive a notification letting you know what 
                          will happen next. If you have any questions, please reply to this email notification.
                        </p>

                        <p>God bless,<br/>
                        --<br/>
                        Editorial Team<br/>
                        Simply Liturgical Composer</p>
                      </body>
                    </html>
                  `,
                  },
                  ready_for_publication: {
                    subject: `Editorial Review Complete - ${compositionName}`,
                    body: `
                    <html>
                      <body>
                        <p>Hi ${composerFirstName},</p>

                        <p>
                          The composition, "<strong>${compositionName}</strong>," has been reviewed by our 
                          Editorial Team and is ready for publication. If you have any questions about this 
                          submission, you can reach me by "replying" to this email notification.
                        </p>

                        <p>Below is the Official Review Summary:</p>
                        <pre>${allAnswers}</pre>

                        <p>God bless,<br/>
                        --<br/>
                        Editorial Team<br/>
                        Simply Liturgical Composer</p>
                      </body>
                    </html>
                  `,
                  },
                };

                const selectedTemplate = templates[emailAction];

                if (selectedTemplate) {
                  // Send email to composer
                  const emailResult = await sendEmail({
                    to: composerEmail,
                    cc: STEP4_CC,
                    bcc: STEP4_BCC,
                    subject: selectedTemplate.subject,
                    html: selectedTemplate.body,
                  });

                  if (emailResult.success) {
                    console.log(
                      `✅ Stage 2 (Editorial) ${emailAction} email sent successfully to composer`,
                    );
                  } else {
                    console.error(
                      `⚠️ Stage 2 (Editorial) ${emailAction} email failed (but review decision continues):`,
                      emailResult.error,
                    );
                  }
                }

                // Also send "ready_for_publication" email when approved (not rejected)
                if (decision === "approved") {
                  try {
                    const readyForPubTemplate =
                      templates["ready_for_publication"];
                    if (readyForPubTemplate) {
                      const readyEmailResult = await sendEmail({
                        to: composerEmail,
                        cc: STEP4_CC,
                        bcc: STEP4_BCC,
                        subject: readyForPubTemplate.subject,
                        html: readyForPubTemplate.body,
                      });

                      if (readyEmailResult.success) {
                        console.log(
                          "✅ Stage 2 (Editorial) ready_for_publication email sent successfully to composer",
                        );
                      } else {
                        console.error(
                          "⚠️ Stage 2 (Editorial) ready_for_publication email failed (but review decision continues):",
                          readyEmailResult.error,
                        );
                      }
                    }
                  } catch (readyEmailError) {
                    // Log error but continue - review decision must not fail due to email issues
                    console.error(
                      "⚠️ Error sending ready_for_publication email (review decision continues):",
                      readyEmailError,
                    );
                  }
                }
              } catch (emailError) {
                // Log error but continue - review decision must not fail due to email issues
                console.error(
                  "⚠️ Error sending Stage 2 (Editorial) review email to composer (review decision continues):",
                  emailError,
                );
              }
            }
          }
        } catch (notifyErr) {
          // Catch any unexpected errors in email notification process
          // This ensures review decision process continues even if email operations fail completely
          console.error(
            "⚠️ Stage 2 (Editorial) notification error (review decision continues):",
            notifyErr,
          );
          // Don't fail the review decision if email fails - decision is already saved in database
        }
      }

      // =====================================================
      // ❌ If Rejected at Editorial Stage → Simple Email
      // =====================================================
      if (isRejected) {
        try {
          const [pubRows] = await mysqlConnection.execute(
            `SELECT 
          mp.composition_title,
          mp.stage3_notes,
          u.email AS composer_email,
          u.first_name AS composer_first_name
       FROM music_publications mp
       LEFT JOIN users u ON mp.composer_id = u.id
       WHERE mp.id = ?`,
            [id],
          );

          if (pubRows.length > 0) {
            const publication = pubRows[0];

            const composerEmail = publication.composer_email;
            const composerFirstName =
              publication.composer_first_name || "Composer";
            const compositionName =
              publication.composition_title || "Your Submission";
            const decisionNotes = publication.stage3_notes;
            const supportEmail =
              process.env.SUPPORT_EMAIL || "support@simplyliturgical.com";

            if (composerEmail) {
              const { sendEmail } = require("../utils/SendMailer");

              await sendEmail({
                to: composerEmail,
                bcc: STEP4_BCC,
                subject: `Editorial Review Decision – ${compositionName}`,
                html: `
            <html>
              <body>
                <p>Hi ${composerFirstName},</p>

                <p>
                  Thank you for your submission “${compositionName}.” 
                  After review, we’re unable to approve it at the Editorial stage.
                </p>

                ${decisionNotes && decisionNotes.trim() !== ""
                    ? `
                <p>
                  <strong>Decision notes:</strong><br/>
                  ${decisionNotes}
                </p>
                  `
                    : ""
                  }

                <p>
                  If you’d like clarification on the feedback or next steps, 
                  reply to this email or contact ${supportEmail}.
                </p>

                <p>
                  God bless,<br/>
                  — Simply Liturgical Composer Team
                </p>
              </body>
            </html>
          `,
              });

              console.log("✅ Stage 3 rejection email sent");
            }
          }
        } catch (err) {
          console.error("⚠️ Rejection email error (decision continues):", err);
        }
      }

      await mysqlConnection.execute(
        `UPDATE music_publications SET ${fields.join(", ")} WHERE id = ?`,
        values,
      );

      const [historyRows] = await mysqlConnection.execute(
        `SELECT 
         mp.*,
         u.first_name as composer_first_name,
         u.last_name as composer_last_name,
         u.email as composer_email,
         u1.first_name as stage1_reviewer_first_name,
         u1.last_name as stage1_reviewer_last_name,
         u2.first_name as stage2_reviewer_first_name,
         u2.last_name as stage2_reviewer_last_name,
         u3.first_name as stage3_reviewer_first_name,
         u3.last_name as stage3_reviewer_last_name,
         u4.first_name as stage4_reviewer_first_name,
         u4.last_name as stage4_reviewer_last_name
       FROM music_publications mp
       LEFT JOIN users u ON mp.composer_id = u.id
       LEFT JOIN users u1 ON mp.stage1_reviewed_by = u1.id
       LEFT JOIN users u2 ON mp.stage2_reviewed_by = u2.id
       LEFT JOIN users u3 ON mp.stage3_reviewed_by = u3.id
       LEFT JOIN users u4 ON mp.stage4_reviewed_by = u4.id
       WHERE mp.id = ?`,
        [id],
      );

      const publication = historyRows[0];
      const reviewSummary = buildStage1ReviewSummary(publication);
      const reviewHistory = buildReviewHistory(publication);

      /* ==================================================
   🔔 SYSTEM NOTIFICATION TO COMPOSER (STAGE 3 – EDITORIAL)
================================================== */
      try {
        // Get composer + composition info
        const [composerRows] = await mysqlConnection.execute(
          `SELECT 
       mp.composer_id,
       mp.composition_title
     FROM music_publications mp
     WHERE mp.id = ?`,
          [id],
        );

        if (composerRows.length > 0) {
          const composerId = composerRows[0].composer_id;
          const compositionName =
            composerRows[0].composition_title || "your music composition";

          let body = "";

          if (decision === "approved") {
            body = `Great news! Your composition "${compositionName}" has been approved by the Editorial Team and is moving forward.`;
          } else if (decision === "accept_with_changes") {
            body = `Your composition "${compositionName}" was reviewed by the Editorial Team and requires some changes before proceeding.`;
          } else if (decision === "rejected") {
            body = `Your composition "${compositionName}" was rejected during the Editorial review.`;
          }

          await createAndDeliverNotification(
            {
              title: "Editorial Review Update",
              body,
              metadata: {
                publication_id: id,
                stage: "music_editorial",
                decision,
              },
              channel: "inbox",
              target: {
                type: "custom",
                user_ids: [composerId],
              },
            },
            null, // system generated
            mysqlConnection,
          );

          console.log(
            `✅ Composer notification sent (Stage-3 Editorial, Decision: ${decision})`,
          );
        }
      } catch (notifErr) {
        console.error(
          "⚠️ Composer notification error (Stage-3 Editorial):",
          notifErr,
        );
      }

      successResponse(
        res,
        {
          id,
          reviewStage: publication.review_stage,
          decision,
          awaitingComposerRevision: isRevisionRequested,
          reviewSummary,
          reviewHistory,
        },
        "Stage 2 (Editorial) decision saved",
      );
    } catch (error) {
      console.error("Stage2 (Editorial) decision error:", error);
      errorResponse(res, "Failed to save decision", 500);
    }
  },
);

// Composer resubmission after editorial changes requested
router.post(
  "/:id/editorial/resubmissions",
  [auth, requireComposerOrRole("sl_team")],
  async (req, res) => {
    try {
      const { id } = req.params;
      const { notes, musicFiles, metadataUpdates } = req.body;

      const mysqlConnection = getMySQLConnection();

      const [rows] = await mysqlConnection.execute(
        `SELECT 
         mp.*,
         u.first_name AS composer_first_name,
         u.last_name AS composer_last_name,
         u.email AS composer_email
       FROM music_publications mp
       LEFT JOIN users u ON mp.composer_id = u.id
       WHERE mp.id = ?`,
        [id],
      );

      if (rows.length === 0) {
        return errorResponse(res, "Music publication not found", 404);
      }

      const publication = rows[0];
      const requesterId = req.user.id;
      const requesterRole = req.user.role;

      if (
        publication.composer_id !== requesterId &&
        requesterRole !== "sl_team"
      ) {
        return errorResponse(
          res,
          "Forbidden: Only the composer can resubmit for editorial review",
          403,
        );
      }

      if (publication.review_stage !== "music_editorial") {
        return errorResponse(
          res,
          "Resubmission is only allowed while publication is in music editorial stage",
          400,
        );
      }

      if (publication.stage3_decision !== "accept_with_changes") {
        return errorResponse(
          res,
          "No editorial change request pending for this publication",
          400,
        );
      }

      const updateFields = [];
      const updateValues = [];

      // Allow limited metadata updates (optional)
      if (metadataUpdates && typeof metadataUpdates === "object") {
        if (metadataUpdates.compositionTitle) {
          updateFields.push("composition_title = ?");
          updateValues.push(metadataUpdates.compositionTitle);
        }
        if (metadataUpdates.compositionDescription !== undefined) {
          updateFields.push("composition_description = ?");
          updateValues.push(metadataUpdates.compositionDescription || null);
        }
        if (metadataUpdates.artists !== undefined) {
          updateFields.push("artists = ?");
          if (
            Array.isArray(metadataUpdates.artists) ||
            typeof metadataUpdates.artists === "object"
          ) {
            updateValues.push(JSON.stringify(metadataUpdates.artists));
          } else {
            updateValues.push(metadataUpdates.artists || null);
          }
        }
        if (metadataUpdates.instrumentation !== undefined) {
          updateFields.push("instrumentation = ?");
          if (
            Array.isArray(metadataUpdates.instrumentation) ||
            typeof metadataUpdates.instrumentation === "object"
          ) {
            updateValues.push(JSON.stringify(metadataUpdates.instrumentation));
          } else {
            updateValues.push(metadataUpdates.instrumentation || null);
          }
        }
        if (metadataUpdates.vocalParts !== undefined) {
          updateFields.push("vocal_parts = ?");
          if (
            Array.isArray(metadataUpdates.vocalParts) ||
            typeof metadataUpdates.vocalParts === "object"
          ) {
            updateValues.push(JSON.stringify(metadataUpdates.vocalParts));
          } else {
            updateValues.push(metadataUpdates.vocalParts || null);
          }
        }
      }

      if (Array.isArray(musicFiles)) {
        updateFields.push("music_files = ?");
        updateValues.push(JSON.stringify(musicFiles));
      }

      const existingResubmissions = parseJsonField(
        publication.stage3_composer_resubmissions,
        [],
      );
      const resubmissionEntry = {
        submittedBy: requesterId,
        submittedByName:
          `${req.user.first_name || ""} ${req.user.last_name || ""}`.trim() ||
          null,
        notes: notes || null,
        files: Array.isArray(musicFiles) ? musicFiles : null,
        submittedAt: new Date().toISOString(),
      };

      existingResubmissions.push(resubmissionEntry);
      updateFields.push("stage3_composer_resubmissions = ?");
      updateValues.push(JSON.stringify(existingResubmissions));

      // Ensure we remain in editorial stage and bump updated_at
      updateFields.push("review_stage = ?");
      updateValues.push("music_editorial");
      updateFields.push("updated_at = NOW()");

      updateValues.push(id);

      await mysqlConnection.execute(
        `UPDATE music_publications SET ${updateFields.join(", ")} WHERE id = ?`,
        updateValues,
      );

      // Notify editorial team via email about new resubmission
      try {
        const [editorialUsers] = await mysqlConnection.execute(
          `SELECT email, first_name, last_name 
         FROM users 
         WHERE JSON_CONTAINS(badges, '"Music Editorial"') 
           AND is_active = 1 
           AND deleted_at IS NULL`,
        );

        const editorialEmails = editorialUsers
          .map((user) => user.email)
          .filter(Boolean);
        if (editorialEmails.length > 0) {
          const compositionName =
            publication.composition_title || "Music Publication";
          const composerName =
            `${publication.composer_first_name || ""} ${publication.composer_last_name || ""}`.trim() ||
            "Composer";
          const composerEmail = publication.composer_email || "N/A";

          const formattedFiles =
            Array.isArray(musicFiles) && musicFiles.length
              ? musicFiles
                .map(
                  (file) =>
                    `• ${file.fileName || file.name || file.key || "Updated file"}`,
                )
                .join("<br/>")
              : "No files were attached in this resubmission.";

          const body = `
          <html>
            <body>
              <p>Hello Editorial Team,</p>
              <p>The composer <strong>${composerName}</strong> (${composerEmail}) has submitted updated materials for <strong>${compositionName}</strong> following the requested changes.</p>
              <p><strong>Composer Notes:</strong></p>
              <p>${notes ? notes.replace(/\n/g, "<br/>") : "No additional notes provided."}</p>
              <p><strong>Updated Files:</strong><br/>${formattedFiles}</p>
              <p>Please log in to the review portal to evaluate the new submission.</p>
              <p>God bless,<br/>Simply Liturgical Composer</p>
            </body>
          </html>
        `;

          try {
            await sendEmail({
              to: editorialEmails,
              cc: ["berlin.digitalgrowthus@gmail.com", "ammypoland@gmail.com"],
              subject: `Composer Resubmission - ${compositionName}`,
              html: body,
            });
            console.log(
              "✅ Composer resubmission email sent to music_editorial team",
            );
          } catch (emailError) {
            console.error(
              "⚠️ Failed to send composer resubmission email (continuing anyway):",
              emailError,
            );
          }
        }
      } catch (emailLookupError) {
        console.error(
          "⚠️ Failed to lookup editorial users for resubmission email:",
          emailLookupError,
        );
      }

      const [updatedRows] = await mysqlConnection.execute(
        `SELECT 
         mp.*,
         u.first_name as composer_first_name,
         u.last_name as composer_last_name,
         u.email as composer_email,
         u1.first_name as stage1_reviewer_first_name,
         u1.last_name as stage1_reviewer_last_name,
         u2.first_name as stage2_reviewer_first_name,
         u2.last_name as stage2_reviewer_last_name,
         u3.first_name as stage3_reviewer_first_name,
         u3.last_name as stage3_reviewer_last_name,
         u4.first_name as stage4_reviewer_first_name,
         u4.last_name as stage4_reviewer_last_name
       FROM music_publications mp
       LEFT JOIN users u ON mp.composer_id = u.id
       LEFT JOIN users u1 ON mp.stage1_reviewed_by = u1.id
       LEFT JOIN users u2 ON mp.stage2_reviewed_by = u2.id
       LEFT JOIN users u3 ON mp.stage3_reviewed_by = u3.id
       LEFT JOIN users u4 ON mp.stage4_reviewed_by = u4.id
       WHERE mp.id = ?`,
        [id],
      );

      const updatedPublication = updatedRows[0];
      const reviewHistory = buildReviewHistory(updatedPublication);
      const reviewSummary = buildStage1ReviewSummary(updatedPublication);

      successResponse(
        res,
        {
          id,
          reviewStage: updatedPublication.review_stage,
          composerResubmission: resubmissionEntry,
          reviewSummary,
          reviewHistory,
        },
        "Composer resubmission submitted successfully",
      );
    } catch (error) {
      console.error("Composer resubmission error:", error);
      errorResponse(res, "Failed to submit resubmission", 500);
    }
  },
);

// GET endpoint to fetch publication with all metadata for final review interface
router.get("/:id/final-review-data", [auth], async (req, res) => {
  try {
    const role = req.user?.role;
    // Allow role sl_team OR Admin badge OR Director of SLC badge
    if (
      !(
        role === "sl_team" ||
        hasBadge(req.user, "Admin") ||
        hasBadge(req.user, "Director of SLC")
      )
    ) {
      return errorResponse(
        res,
        "Forbidden: invalid user type for this action",
        403,
      );
    }
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();

    const [rows] = await mysqlConnection.execute(
      `SELECT 
        mp.*,
        u.first_name as composer_first_name,
        u.last_name as composer_last_name,
        u.email as composer_email,
        -- Review history
        u1.first_name as stage1_reviewer_first_name,
        u1.last_name as stage1_reviewer_last_name,
        u2.first_name as stage2_reviewer_first_name,
        u2.last_name as stage2_reviewer_last_name,
        u3.first_name as stage3_reviewer_first_name,
        u3.last_name as stage3_reviewer_last_name
      FROM music_publications mp
      LEFT JOIN users u ON mp.composer_id = u.id
      LEFT JOIN users u1 ON mp.stage1_reviewed_by = u1.id
      LEFT JOIN users u2 ON mp.stage2_reviewed_by = u2.id
      LEFT JOIN users u3 ON mp.stage3_reviewed_by = u3.id
      WHERE mp.id = ? AND mp.review_stage = 'final_review'`,
      [id],
    );

    if (rows.length === 0) {
      return errorResponse(
        res,
        "Publication not found or not in final review stage",
        404,
      );
    }

    const publication = rows[0];

    const responseData = {
      publication: formatMusicPublication(publication),
      reviewSummary: buildStage1ReviewSummary(publication),
      reviewHistory: buildReviewHistory(publication),
    };

    successResponse(
      res,
      responseData,
      "Final review data retrieved successfully",
    );
  } catch (error) {
    console.error("Get final review data error:", error);
    errorResponse(res, "Failed to retrieve final review data", 500);
  }
});

// Stage 4: Final review by SL Team/Admin/Dir of SLC
router.post(
  "/:id/final/decision",
  [
    auth,
    // requireAnyRole(['sl_team', 'admin'])
  ],
  async (req, res) => {
    try {
      const role = req.user?.role;
      // Allow role sl_team OR Admin badge OR Director of SLC badge OR Music Publication badge
      if (
        !(
          role === "sl_team" ||
          hasBadge(req.user, "Admin") ||
          hasBadge(req.user, "Director of SLC") ||
          hasBadge(req.user, "Music Publication")
        )
      ) {
        return errorResponse(
          res,
          "Forbidden: invalid user type for this action",
          403,
        );
      }
      const { id } = req.params;
      const {
        decision,
        notes,
        price,
        musicFiles,
        // Metadata fields that can be updated
        composition_title,
        composition_description,
        composition_title_1,
        composer_firstname,
        composer_lastname,
        vocal_parts,
        instrumentation,
        types_of_music,
        first_line_of_composition,
        composition_copyrights,
        mass_setting_parts,
        song_type,
        meter,
        season,
        psalm_number,
        liturgicalText,
        verseStyle,
        feast,
        text_copyright_notice,
        tune_copyright_notice,
        artists,
        artwork_file_url,
        tune,
        general_details,
        country_restrictions,
        is_public_domain,
        can_be_reprinted,
        can_be_podcast_streamed,
        can_make_commercial_recording,
        can_make_non_commercial_recording,
        is_part_of_collection,
        collection_id,
        collection_name,
      } = req.body;
      const STEP5_BCC = parseEmails(process.env.MUSIC_STEP_5_BCC_EMAILS);

      if (!["approved", "rejected", "accept_with_changes"].includes(decision)) {
        return errorResponse(
          res,
          "Invalid decision. Must be: approved, rejected, or accept_with_changes",
          400,
        );
      }
      const mysqlConnection = getMySQLConnection();

      // Get current publication with all metadata and review history
      const [rows] = await mysqlConnection.execute(
        `SELECT 
        mp.*,
        u.first_name as composer_first_name,
        u.last_name as composer_last_name,
        u.email as composer_email
      FROM music_publications mp
      LEFT JOIN users u ON mp.composer_id = u.id
      WHERE mp.id = ?`,
        [id],
      );
      if (rows.length === 0)
        return errorResponse(res, "Music publication not found", 404);
      if (rows[0].review_stage !== "final_review")
        return errorResponse(res, "Invalid stage for this action", 400);

      const currentPublication = rows[0];

      // Both 'approved' and 'accept_with_changes' lead to published, only 'rejected' stops
      const isApproved =
        decision === "approved" || decision === "accept_with_changes";
      const isAdminUser =
        req.user?.user_type === "admin" || hasBadge(req.user, "Admin");
      let nextStage;
      let nextStatus;
      if (isApproved) {
        nextStage = "published";
        nextStatus = isAdminUser ? "draft" : "published";
      } else {
        nextStage = "rejected";
        nextStatus = "rejected";
      }

      const fields = [
        "stage4_decision = ?",
        "stage4_notes = ?",
        "stage4_reviewed_by = ?",
        "stage4_reviewed_at = NOW()",
        "review_stage = ?",
        "status = ?",
        "published_at = CASE WHEN ? = 'published' THEN NOW() ELSE published_at END",
      ];

      const values = [
        decision,
        notes || null,
        req.user.id,
        nextStage,
        nextStatus,
        nextStage,
      ];

      // Update metadata fields if provided
      if (composition_title !== undefined) {
        fields.push("composition_title = ?");
        values.push(composition_title);
      }
      if (composition_description !== undefined) {
        fields.push("composition_description = ?");
        values.push(composition_description);
      }
      if (composition_title_1 !== undefined) {
        fields.push("composition_title_1 = ?");
        values.push(composition_title_1);
      }
      if (composer_firstname !== undefined) {
        fields.push("composer_firstname = ?");
        values.push(composer_firstname);
      }
      if (composer_lastname !== undefined) {
        fields.push("composer_lastname = ?");
        values.push(composer_lastname);
      }
      if (vocal_parts !== undefined) {
        fields.push("vocal_parts = ?");
        values.push(JSON.stringify(vocal_parts));
      }
      if (instrumentation !== undefined) {
        fields.push("instrumentation = ?");
        values.push(JSON.stringify(instrumentation));
      }
      if (types_of_music !== undefined) {
        fields.push("types_of_music = ?");
        values.push(types_of_music);
      }
      if (first_line_of_composition !== undefined) {
        fields.push("first_line_of_composition = ?");
        values.push(first_line_of_composition);
      }
      if (composition_copyrights !== undefined) {
        fields.push("composition_copyrights = ?");
        values.push(JSON.stringify(composition_copyrights));
      }
      if (mass_setting_parts !== undefined) {
        fields.push("mass_setting_parts = ?");
        values.push(mass_setting_parts);
      }
      if (song_type !== undefined) {
        fields.push("song_type = ?");
        values.push(song_type);
      }
      if (meter !== undefined) {
        fields.push("meter = ?");
        values.push(meter);
      }
      if (season !== undefined) {
        fields.push("season = ?");
        values.push(season);
      }
      if (psalm_number !== undefined) {
        fields.push("psalm_number = ?");
        values.push(psalm_number);
      }
      if (liturgicalText !== undefined) {
        fields.push("liturgicalText = ?");
        values.push(liturgicalText);
      }
      if (verseStyle !== undefined) {
        fields.push("verseStyle = ?");
        values.push(verseStyle);
      }
      if (feast !== undefined) {
        fields.push("feast = ?");
        values.push(feast);
      }
      if (text_copyright_notice !== undefined) {
        fields.push("text_copyright_notice = ?");
        values.push(text_copyright_notice);
      }
      if (tune_copyright_notice !== undefined) {
        fields.push("tune_copyright_notice = ?");
        values.push(tune_copyright_notice);
      }
      if (artists !== undefined) {
        fields.push("artists = ?");
        values.push(JSON.stringify(artists));
      }
      if (artwork_file_url !== undefined) {
        fields.push("artwork_file_url = ?");
        values.push(artwork_file_url);
      }
      if (tune !== undefined) {
        fields.push("tune = ?");
        values.push(tune);
      }
      if (general_details !== undefined) {
        fields.push("general_details = ?");
        values.push(general_details);
      }
      if (country_restrictions !== undefined) {
        fields.push("country_restrictions = ?");
        values.push(country_restrictions);
      }
      if (is_public_domain !== undefined) {
        fields.push("is_public_domain = ?");
        values.push(is_public_domain ? 1 : 0);
      }
      if (can_be_reprinted !== undefined) {
        fields.push("can_be_reprinted = ?");
        values.push(can_be_reprinted ? 1 : 0);
      }
      if (can_be_podcast_streamed !== undefined) {
        fields.push("can_be_podcast_streamed = ?");
        values.push(can_be_podcast_streamed ? 1 : 0);
      }
      if (can_make_commercial_recording !== undefined) {
        fields.push("can_make_commercial_recording = ?");
        values.push(can_make_commercial_recording ? 1 : 0);
      }
      if (can_make_non_commercial_recording !== undefined) {
        fields.push("can_make_non_commercial_recording = ?");
        values.push(can_make_non_commercial_recording ? 1 : 0);
      }
      if (is_part_of_collection !== undefined) {
        fields.push("is_part_of_collection = ?");
        values.push(is_part_of_collection ? 1 : 0);
      }
      if (collection_id !== undefined) {
        fields.push("collection_id = ?");
        values.push(collection_id);
      }
      if (collection_name !== undefined) {
        fields.push("collection_name = ?");
        values.push(collection_name);
      }

      // Optional file replacement at final step
      if (Array.isArray(musicFiles)) {
        fields.push("music_files = ?");
        values.push(JSON.stringify(musicFiles));
      }

      // Allow optional price only when approving
      if (isApproved && price !== undefined) {
        const parsed = Number(price);
        if (!Number.isFinite(parsed) || parsed < 0) {
          return errorResponse(res, "Invalid price", 400);
        }
        fields.push("price = ?");
        values.push(parsed);
        // Toggle is_free based on price
        fields.push("is_free = ?");
        values.push(parsed > 0 ? 0 : 1);
        fields.push("toggle = ?");
        values.push("active");
      }

      fields.push("updated_at = NOW()");
      values.push(id);

      await mysqlConnection.execute(
        `UPDATE music_publications SET ${fields.join(", ")} WHERE id = ?`,
        values,
      );

      // On publish, notify composer and director of SL team using publicationEmail function
      // IMPORTANT: Email errors are completely isolated - they will NOT affect the approval process
      if (isApproved) {
        // Wrap entire email notification block in try-catch to ensure it never breaks the approval
        try {
          const [pubRows] = await mysqlConnection.execute(
            `SELECT mp.id, mp.composition_title, u.email AS composer_email, u.first_name AS composer_first_name
           FROM music_publications mp
           JOIN users u ON u.id = mp.composer_id
           WHERE mp.id = ?`,
            [id],
          );

          if (pubRows.length > 0) {
            const publication = pubRows[0];
            const compositionName =
              publication.composition_title || "Music Publication";
            const composerFirstName =
              publication.composer_first_name || "Composer";
            const composerEmail = publication.composer_email;

            // Construct product page link (assuming frontend URL pattern)
            // You may need to adjust this based on your actual frontend URL structure
            const frontendUrl =
              process.env.FRONTEND_URL ||
              process.env.PUBLIC_URL ||
              "https://simplyliturgical.com";
            const productPageLink = `${frontendUrl}/music/${id}`;

            // Send email to composer using required template
            if (composerEmail) {
              try {
                const { sendEmail } = require("../utils/SendMailer");
                const contractBaseUrl = req.body.contractUrl;

                const subject = `Action required: E-sign needed for  – ${compositionName}`;

                const body = `
      <html>
        <body>
          <p>Hi ${composerFirstName},</p>

          <p>
            Your submission "<strong>${compositionName}</strong>" is ready for final approval,
            but we need one last step from you:
          </p>

          <p><strong>Please e-sign the required agreement here:</strong></p>

          <p>
            <a href="${contractBaseUrl}" target="_blank">
              ${contractBaseUrl}
            </a>
          </p>

          <p><strong>Details:</strong></p>
          <ul>
            <li>Submission ID: ${id}</li>
            <li>Deadline (if applicable): N/A</li>
          </ul>

          <p>
            Once completed, we’ll proceed with the final publishing steps. <br/>
            If you have any issues with the e-sign link, reply to this email.
          </p>

          <p>
            God bless,<br/>
            — Simply Liturgical Composer Team
          </p>
        </body>
      </html>
    `;

                const emailResult = await sendEmail({
                  to: composerEmail,
                  cc: STEP5_BCC,
                  subject,
                  html: body,
                });

                if (emailResult.success) {
                  console.log("✅ Final Approval Email Sent to Composer");
                } else {
                  console.error(
                    "⚠️ Email Failed (continuing):",
                    emailResult.error,
                  );
                }
              } catch (emailError) {
                console.error(
                  "⚠️ Error sending final approval email (ignored):",
                  emailError,
                );
              }
            }

            // Send email to director of SL team (director_of_slc users) using publicationEmail function format
            // Separate try-catch ensures director email failure doesn't affect composer email
            try {
              const [dirUsers] = await mysqlConnection.execute(
                `SELECT email, first_name FROM users WHERE JSON_CONTAINS(badges, '"Director of SLC"') AND is_active = 1 AND deleted_at IS NULL`,
              );

              if (dirUsers.length > 0) {
                const { sendEmail } = require("../utils/SendMailer");
                const dirEmails = dirUsers.map((u) => u.email).filter(Boolean);

                if (dirEmails.length > 0) {
                  // Use same publicationEmail template format for director
                  const subject = `Product Published! - ${compositionName}`;
                  const body = `
                  <html>
                    <body>
                      <p>Hi ${dirUsers[0]?.first_name || "Director"},</p>

                      <p>
                        The composition, "<strong>${compositionName}</strong>," 
                        composed by <strong>${composerFirstName}</strong> has been published and is now live on our website:
                      </p>

                      <p><a href="${productPageLink}" target="_blank">${productPageLink}</a></p>

                      <p>
                        If anything on the product page needs to be adjusted, please contact the composer.
                      </p>

                      <p>God bless,<br/>
                      --<br/>
                      Publication Team<br/>
                      Simply Liturgical Composer</p>
                    </body>
                  </html>
                `;

                  const dirEmailResult = await sendEmail({
                    to: dirEmails,
                    cc: STEP5_BCC,
                    subject: subject,
                    html: body,
                  });

                  if (dirEmailResult.success) {
                    console.log(
                      "✅ Publication email sent successfully to director of SL team",
                    );
                  } else {
                    console.error(
                      "⚠️ Publication email to director failed (but approval continues):",
                      dirEmailResult.error,
                    );
                  }
                }
              }
            } catch (dirEmailError) {
              // Log error but continue - approval must not fail due to email issues
              console.error(
                "⚠️ Error sending email to director of SL team (approval continues):",
                dirEmailError,
              );
            }
          }
        } catch (notifyErr) {
          // Catch any unexpected errors in email notification process
          // This ensures approval process continues even if email operations fail completely
          console.error(
            "⚠️ Publish notification error (approval continues):",
            notifyErr,
          );
          // Don't fail the publication if email fails - approval is already saved in database
        }
      }
      if (decision === "rejected") {
        try {
          const { sendEmail } = require("../utils/SendMailer");

          const compositionName =
            currentPublication.composition_title || "Music Publication";

          const composerEmail = currentPublication.composer_email;
          const composerFirstName =
            currentPublication.composer_first_name || "Composer";

          if (composerEmail) {
            const subject = `Final Review Decision: "${compositionName}"`;

            const body = `
            <html>
              <body>
                <p>Hi ${composerFirstName},</p>
    
                <p>
                  Thank you for submitting your composition,
                  "<strong>${compositionName}</strong>," for review.
                </p>
    
                <p>
                  After careful consideration during the final review stage,
                  we regret to inform you that your composition has not been approved for publication at this time.
                </p>
    
                ${notes
                ? `<p><strong>Reviewer Notes:</strong><br/>${notes}</p>`
                : ""
              }
    
                <p>
                  We truly appreciate the time and effort you invested in your submission.
                  You are welcome to revise and resubmit in the future.
                </p>
    
                <p>
                  If you have any questions, please feel free to reply to this email.
                </p>
    
                <p>
                  God bless,<br/>
                  --<br/>
                  Publication Team<br/>
                  Simply Liturgical Composer
                </p>
              </body>
            </html>
          `;

            await sendEmail({
              to: composerEmail,
              cc: ["berlin.digitalgrowthus@gmail.com", "ammypoland@gmail.com"],
              subject,
              html: body,
            });

            console.log("✅ Rejection email sent to composer");
          }
        } catch (err) {
          console.error("⚠️ Error sending rejection email (ignored):", err);
        }
      }
      // Get updated publication with all metadata and review history for response
      const [updatedPub] = await mysqlConnection.execute(
        `SELECT 
        mp.*,
        u.first_name as composer_first_name,
        u.last_name as composer_last_name,
        u.email as composer_email,
        -- Review history
        u1.first_name as stage1_reviewer_first_name,
        u1.last_name as stage1_reviewer_last_name,
        u2.first_name as stage2_reviewer_first_name,
        u2.last_name as stage2_reviewer_last_name,
        u3.first_name as stage3_reviewer_first_name,
        u3.last_name as stage3_reviewer_last_name,
        u4.first_name as stage4_reviewer_first_name,
        u4.last_name as stage4_reviewer_last_name
      FROM music_publications mp
      LEFT JOIN users u ON mp.composer_id = u.id
      LEFT JOIN users u1 ON mp.stage1_reviewed_by = u1.id
      LEFT JOIN users u2 ON mp.stage2_reviewed_by = u2.id
      LEFT JOIN users u3 ON mp.stage3_reviewed_by = u3.id
      LEFT JOIN users u4 ON mp.stage4_reviewed_by = u4.id
      WHERE mp.id = ?`,
        [id],
      );

      const publication = updatedPub[0];
      const reviewSummary = buildStage1ReviewSummary(publication);
      const reviewHistory = buildReviewHistory(publication);

      // Format response with all metadata and review history
      const responseData = {
        id: publication.id,
        reviewStage: nextStage,
        status: nextStatus,
        decision,
        price: isApproved
          ? price !== undefined
            ? Number(price)
            : publication.price
          : undefined,
        publication: formatMusicPublication(publication),
        reviewSummary,
        reviewHistory,
      };
      /* ==================================================
    🔔 SYSTEM NOTIFICATION TO COMPOSER (STAGE 4 – FINAL)
    ================================================== */
      try {
        const composerId = currentPublication.composer_id;
        const compositionName =
          currentPublication.composition_title || "your music composition";

        const frontendUrl =
          process.env.FRONTEND_URL || "https://simplyliturgical.com";

        // 🔥 Contract URL (recommended approach)
        const contractBaseUrl = req.body.contractUrl;

        let body = "";
        let actionUrl = null;

        if (decision === "rejected") {
          body = `Unfortunately, your composition "${compositionName}" was rejected during the final review stage.`;
        }

        if (decision === "accept_with_changes") {
          body = `Your composition "${compositionName}" has successfully completed final review with minor changes. 
            Please review and sign the publication contract to proceed.`;
          actionUrl = contractBaseUrl;
        }

        if (decision === "approved") {
          body = `Congratulations! Your composition "${compositionName}" has successfully completed final review. 
        To proceed with publication, please review and sign the publication contract.`;
          actionUrl = contractBaseUrl;
        }

        await createAndDeliverNotification(
          {
            title: "Final Review Update",
            body,
            metadata: {
              publication_id: id,
              stage: "final_review",
              decision,
              published: decision !== "rejected",
              action_url: actionUrl, // 🔥 frontend redirect link
            },
            channel: "inbox",
            target: {
              type: "custom",
              user_ids: [composerId],
            },
          },
          null,
          mysqlConnection,
        );

        console.log(
          `✅ Composer notification sent (Stage-4 Final, Decision: ${decision})`,
        );
      } catch (notifErr) {
        console.error(
          "⚠️ Composer notification error (Stage-4 Final):",
          notifErr,
        );
      }

      successResponse(res, responseData, "Final decision saved successfully");
    } catch (error) {
      console.error("Stage3 decision error:", error);
      errorResponse(res, "Failed to save decision", 500);
    }
  },
);

// Composer signs final contract & publishes song
router.post("/:id/sign-final-contract", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { finalContract } = req.body;

    if (!finalContract) {
      return errorResponse(res, "Final contract URL is required", 400);
    }

    const mysqlConnection = getMySQLConnection();

    // Fetch publication
    const [rows] = await mysqlConnection.execute(
      `SELECT * FROM music_publications WHERE id = ?`,
      [id],
    );

    if (!rows.length) {
      return errorResponse(res, "Music publication not found", 404);
    }

    const publication = rows[0];

    // 🔐 Ownership check
    if (publication.composer_id !== req.user.id) {
      return errorResponse(res, "Forbidden: not your publication", 403);
    }

    // 🚦 Stage validation
    if (publication.review_stage !== "published") {
      return errorResponse(
        res,
        "Publication is not ready for contract signing",
        400,
      );
    }

    // 🧾 Update publication
    await mysqlConnection.execute(
      `UPDATE music_publications
       SET
         finalContract = ?,
         finalContractTime = NOW(),
         status = 'published',
         published_at = COALESCE(published_at, NOW()),
         updated_at = NOW()
       WHERE id = ?`,
      [finalContract, id],
    );

    // =============================
    // 📧 EMAIL TO COMPOSER
    // =============================
    try {
      const { sendEmail } = require("../utils/SendMailer");

      const frontendUrl =
        process.env.FRONTEND_URL || "https://simplyliturgical.com";

      const productLink = `${frontendUrl}/music/${id}`;

      await sendEmail({
        to: req.user.email,
        subject: "Your Composition Is Now Published",
        html: `
          <html>
            <body>
              <p>Hi ${req.user.first_name || "Composer"},</p>

              <p>
                Thank you for signing the final publication contract.
              </p>

              <p>
                Your composition "<strong>${publication.composition_title}</strong>"
                is now officially published on our platform.
              </p>

              <p>
                <a href="${productLink}" target="_blank">
                  View Your Published Composition
                </a>
              </p>

              <p>
                God bless,<br/>
                --<br/>
                Publication Team<br/>
                Simply Liturgical Composer
              </p>
            </body>
          </html>
        `,
      });
    } catch (emailErr) {
      console.error("⚠️ Composer publish email failed (ignored):", emailErr);
    }

    // =============================
    // 🔔 SYSTEM NOTIFICATION
    // =============================
    try {
      const frontendUrl =
        process.env.FRONTEND_URL || "https://simplyliturgical.com";

      const productLink = `${frontendUrl}/music/${id}`;

      await createAndDeliverNotification(
        {
          title: "Composition Published 🎉",
          body: `Your composition "${publication.composition_title}" has been successfully published.`,
          metadata: {
            publication_id: id,
            action_url: productLink,
            stage: "published",
          },
          channel: "inbox",
          target: {
            type: "custom",
            user_ids: [req.user.id],
          },
        },
        null,
        mysqlConnection,
      );
    } catch (notifErr) {
      console.error(
        "⚠️ Composer publish notification failed (ignored):",
        notifErr,
      );
    }

    return successResponse(
      res,
      {
        id,
        status: "published",
        finalContract,
        finalContractTime: new Date(),
      },
      "Contract signed and composition published successfully",
    );
  } catch (error) {
    console.error("Final contract sign error:", error);
    return errorResponse(res, "Failed to publish composition", 500);
  }
});

// @route   GET /api/music-publications/:id/review-summary
// @desc    Get review summary for a specific music publication
// @access  Private (Any authenticated user)
router.get("/:id/review-summary", async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const { id } = req.params;

    const [rows] = await mysqlConnection.execute(
      `SELECT 
                stage1_decision, stage1_reviewed_by, stage1_reviewed_at, stage1_notes, stage1_review_comments, stage1_reviews,
                stage2_decision, stage2_reviewed_by, stage2_reviewed_at, stage2_notes, stage2_comments, stage2_replaced_files, stage2_history,
                stage3_decision, stage3_reviewed_by, stage3_reviewed_at, stage3_notes, stage3_replaced_files, stage3_comments, stage3_history,
                stage4_decision, stage4_reviewed_by, stage4_reviewed_at, stage4_notes
            FROM music_publications
            WHERE id = ?`,
      [id],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Publication not found" });
    }

    const pub = rows[0];

    // ─── Helpers ─────────────────────────────────────────────────────────────

    const safeParse = (val) => {
      if (val === null || val === undefined) return null;
      if (typeof val === "object") return val;
      try {
        return JSON.parse(val);
      } catch (e) {
        return val;
      }
    };

    /**
     * Split a replaced_files JSON array into three buckets:
     *   composerResubmissions – { type:"composer_resubmission", resubmitted_by, resubmitted_at, changes }
     *   fileGroups            – reviewer-uploaded file replacements { files:[...] }
     *   fieldChanges          – legacy flat field-diff items        { field, before, after }
     */
    const splitReplacedFiles = (raw) => {
      const parsed = safeParse(raw) || [];
      if (!Array.isArray(parsed)) {
        return { fileGroups: [], fieldChanges: [], composerResubmissions: [] };
      }

      const fileGroups = [];
      const fieldChanges = [];
      const composerResubmissions = [];

      parsed.forEach((item) => {
        if (!item || typeof item !== "object") return;
        if (item.type === "composer_resubmission") {
          composerResubmissions.push(item);
          return;
        }
        if (Array.isArray(item.files)) { fileGroups.push(item); return; }
        if (Object.prototype.hasOwnProperty.call(item, "field")) { fieldChanges.push(item); return; }
        if (item.files) fileGroups.push(item);
        else fieldChanges.push(item);
      });

      return { fileGroups, fieldChanges, composerResubmissions };
    };

    /**
     * Timestamp-based composerResubmitted check:
     *
     * Har history entry ke baad aur next entry se pehle koi composer_resubmission
     * aayi hai kya — agar haan toh true, nahi toh false.
     *
     * @param {Array}       allComposerResubs    - poore stage ke saare composer_resubmission entries
     * @param {string}      entryReviewedAt      - is history entry ka reviewed_at timestamp
     * @param {string|null} nextEntryReviewedAt  - agla history entry ka reviewed_at (null if last)
     * @returns {boolean}
     */
    const wasComposerResubmittedAfter = (
      allComposerResubs,
      entryReviewedAt,
      nextEntryReviewedAt,
    ) => {
      if (!Array.isArray(allComposerResubs) || !entryReviewedAt) return false;

      const entryTime = new Date(entryReviewedAt).getTime();
      const nextTime = nextEntryReviewedAt
        ? new Date(nextEntryReviewedAt).getTime()
        : Infinity;

      return allComposerResubs.some((r) => {
        if (!r.resubmitted_at) return false;
        const t = new Date(r.resubmitted_at).getTime();
        // strictly after this decision AND before the next decision
        return t > entryTime && t < nextTime;
      });
    };

    /**
     * Get composer resubmissions that fall in the window between
     * entryReviewedAt and nextEntryReviewedAt.
     */
    const getWindowResubs = (allComposerResubs, entryReviewedAt, nextEntryReviewedAt) => {
      if (!Array.isArray(allComposerResubs) || !entryReviewedAt) return [];

      const entryTime = new Date(entryReviewedAt).getTime();
      const nextTime = nextEntryReviewedAt
        ? new Date(nextEntryReviewedAt).getTime()
        : Infinity;

      return allComposerResubs.filter((r) => {
        if (!r.resubmitted_at) return false;
        const t = new Date(r.resubmitted_at).getTime();
        return t > entryTime && t < nextTime;
      });
    };

    // ─── Build summary ────────────────────────────────────────────────────────

    const summary = [];

    // ── Stage 1 - Review Board ────────────────────────────────────────────────
    (() => {
      const decision = pub.stage1_decision;
      const notes = pub.stage1_notes;
      const commentRaw = pub.stage1_review_comments || pub.stage1_reviews;
      if (!decision && !notes && !commentRaw) return;

      const stageObj = {
        stage: 1,
        decision_by: "Review Boards",
        decision: decision || null,
        reviewed_at: pub.stage1_reviewed_at || null,
        notes: notes || null,
      };

      const comment = safeParse(commentRaw);
      if (comment !== null) stageObj.comment = comment;

      summary.push(stageObj);
    })();

    // ── Stage 2 - Director of SLC ─────────────────────────────────────────────
    // Saare composer resubmissions stage2_replaced_files se extract karo
    const { composerResubmissions: stage2AllComposerResubs } =
      splitReplacedFiles(pub.stage2_replaced_files);

    const stage2History = safeParse(pub.stage2_history);

    if (Array.isArray(stage2History) && stage2History.length > 0) {
      stage2History.forEach((entry, idx) => {
        const nextEntry = stage2History[idx + 1] || null;

        // Reviewer files sirf is entry ke replaced_files se lo
        const { fileGroups, fieldChanges } = splitReplacedFiles(
          entry.replaced_files ? JSON.stringify(entry.replaced_files) : null,
        );

        // Timestamp check: is entry ke baad aur next entry se pehle koi resubmission?
        const composerResubmitted = wasComposerResubmittedAfter(
          stage2AllComposerResubs,
          entry.reviewed_at,
          nextEntry ? nextEntry.reviewed_at : null,
        );

        // Is window ki resubmissions
        const windowResubs = getWindowResubs(
          stage2AllComposerResubs,
          entry.reviewed_at,
          nextEntry ? nextEntry.reviewed_at : null,
        );

        const stageObj = {
          stage: 2,
          decision_by: "Director of SLC",
          decision: entry.decision || null,
          reviewed_at: entry.reviewed_at || null,
          notes: entry.notes || null,
          // ✅ accept_with_changes → true | approved/rejected → false
          needToBeResubmitted: entry.decision === "accept_with_changes",
          // ✅ is history entry ke baad composer ne resubmit kiya → true | nahi → false
          composerResubmitted,
        };

        if (fieldChanges.length > 0) stageObj.replacedFields = fieldChanges;
        if (fileGroups.length > 0) stageObj.replacedFiles = fileGroups;
        if (windowResubs.length > 0) {
          stageObj.composerResubmissions = windowResubs.map((r) => ({
            resubmitted_by: r.resubmitted_by,
            resubmitted_at: r.resubmitted_at,
            changes: r.changes || [],
          }));
        }

        const comment = safeParse(pub.stage2_comments);
        if (comment !== null) stageObj.comment = comment;

        summary.push(stageObj);
      });
    } else {
      // Fallback: purana data jisme history nahi hai
      const { fileGroups, fieldChanges, composerResubmissions } =
        splitReplacedFiles(pub.stage2_replaced_files);

      const stageObj = {
        stage: 2,
        decision_by: "Director of SLC",
        decision: pub.stage2_decision || null,
        reviewed_at: pub.stage2_reviewed_at || null,
        notes: pub.stage2_notes || null,
        needToBeResubmitted: pub.stage2_decision === "accept_with_changes",
        composerResubmitted: composerResubmissions.length > 0,
      };

      if (fieldChanges.length > 0) stageObj.replacedFields = fieldChanges;
      if (fileGroups.length > 0) stageObj.replacedFiles = fileGroups;
      if (composerResubmissions.length > 0) {
        stageObj.composerResubmissions = composerResubmissions.map((r) => ({
          resubmitted_by: r.resubmitted_by,
          resubmitted_at: r.resubmitted_at,
          changes: r.changes || [],
        }));
      }

      const comment = safeParse(pub.stage2_comments);
      if (comment !== null) stageObj.comment = comment;

      if (stageObj.decision || stageObj.notes || pub.stage2_comments || pub.stage2_replaced_files) {
        summary.push(stageObj);
      }
    }

    // ── Stage 3 - Music Editorial ─────────────────────────────────────────────
    // Saare composer resubmissions stage3_replaced_files se extract karo
    const { composerResubmissions: stage3AllComposerResubs } =
      splitReplacedFiles(pub.stage3_replaced_files);

    const stage3History = safeParse(pub.stage3_history);

    if (Array.isArray(stage3History) && stage3History.length > 0) {
      stage3History.forEach((entry, idx) => {
        const nextEntry = stage3History[idx + 1] || null;

        const { fileGroups, fieldChanges } = splitReplacedFiles(
          entry.replaced_files ? JSON.stringify(entry.replaced_files) : null,
        );

        const composerResubmitted = wasComposerResubmittedAfter(
          stage3AllComposerResubs,
          entry.reviewed_at,
          nextEntry ? nextEntry.reviewed_at : null,
        );

        const windowResubs = getWindowResubs(
          stage3AllComposerResubs,
          entry.reviewed_at,
          nextEntry ? nextEntry.reviewed_at : null,
        );

        const stageObj = {
          stage: 3,
          decision_by: "Music Editorial",
          decision: entry.decision || null,
          reviewed_at: entry.reviewed_at || null,
          notes: entry.notes || null,
          // ✅ accept_with_changes → true | approved/rejected → false
          needToBeResubmitted: entry.decision === "accept_with_changes",
          // ✅ is history entry ke baad composer ne resubmit kiya → true | nahi → false
          composerResubmitted,
        };

        if (fieldChanges.length > 0) stageObj.replacedFields = fieldChanges;
        if (fileGroups.length > 0) stageObj.replacedFiles = fileGroups;
        if (windowResubs.length > 0) {
          stageObj.composerResubmissions = windowResubs.map((r) => ({
            resubmitted_by: r.resubmitted_by,
            resubmitted_at: r.resubmitted_at,
            changes: r.changes || [],
          }));
        }

        const comment = safeParse(pub.stage3_comments);
        if (comment !== null) stageObj.comment = comment;

        summary.push(stageObj);
      });
    } else {
      // Fallback: purana data jisme history nahi hai
      const { fileGroups, fieldChanges, composerResubmissions } =
        splitReplacedFiles(pub.stage3_replaced_files);

      const stageObj = {
        stage: 3,
        decision_by: "Music Editorial",
        decision: pub.stage3_decision || null,
        reviewed_at: pub.stage3_reviewed_at || null,
        notes: pub.stage3_notes || null,
        needToBeResubmitted: pub.stage3_decision === "accept_with_changes",
        composerResubmitted: composerResubmissions.length > 0,
      };

      if (fieldChanges.length > 0) stageObj.replacedFields = fieldChanges;
      if (fileGroups.length > 0) stageObj.replacedFiles = fileGroups;
      if (composerResubmissions.length > 0) {
        stageObj.composerResubmissions = composerResubmissions.map((r) => ({
          resubmitted_by: r.resubmitted_by,
          resubmitted_at: r.resubmitted_at,
          changes: r.changes || [],
        }));
      }

      const comment = safeParse(pub.stage3_comments);
      if (comment !== null) stageObj.comment = comment;

      if (stageObj.decision || stageObj.notes || pub.stage3_comments || pub.stage3_replaced_files) {
        summary.push(stageObj);
      }
    }

    // ── Stage 4 - Final Review ────────────────────────────────────────────────
    (() => {
      const decision = pub.stage4_decision;
      const notes = pub.stage4_notes;
      if (!decision && !notes) return;

      summary.push({
        stage: 4,
        decision_by: "Final Review",
        decision: decision || null,
        reviewed_at: pub.stage4_reviewed_at || null,
        notes: notes || null,
      });
    })();

    return res.json({ publication_id: id, summary });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server error" });
  }
});

// @route   PUT /api/music-publications/:id/resubmission
// @desc    Composer resubmission of updated materials after review
// @access  Private (Any authenticated user)
router.put("/:id/resubmission", [auth], async (req, res) => {
  const publicationId = req.params.id;
  try {
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    const [existingRows] = await mysqlConnection.execute(
      "SELECT * FROM music_publications WHERE id = ?",
      [publicationId],
    );

    if (!existingRows || existingRows.length === 0) {
      return errorResponse(res, "Publication not found", 404);
    }

    const existing = existingRows[0];

    const isOwner = existing.composer_id == userId;
    const isSLTeam = req.user?.role === "sl_team" || hasBadge(req.user, "Admin");
    if (!isOwner && !isSLTeam) {
      return errorResponse(res, "Forbidden: only owner composer or SL Team can update", 403);
    }

    const reviewStage = existing.review_stage;

    let updateFields = [];
    let updateValues = [];
    let columnsToUpdate = {};

    const pushUpdate = (column, value) => {
      updateFields.push(`${column} = ?`);
      updateValues.push(value);
      columnsToUpdate[column] = value;
    };

    const boolField = (val) =>
      val === true || val === "true" || val === 1 ? 1 : 0;

    // ─── Field mappings ───────────────────────────────────────────────────────
    if (req.body.compositionTitle !== undefined)
      pushUpdate("composition_title", req.body.compositionTitle || null);
    if (req.body.compositionDescription !== undefined)
      pushUpdate("composition_description", req.body.compositionDescription || null);
    if (req.body.composerFirstName !== undefined)
      pushUpdate("composer_firstname", req.body.composerFirstName || null);
    if (req.body.composerLastName !== undefined)
      pushUpdate("composer_lastname", req.body.composerLastName || null);

    if (req.body.isPartOfCollection !== undefined)
      pushUpdate("is_part_of_collection", req.body.isPartOfCollection ? 1 : 0);
    if (req.body.collectionId !== undefined)
      pushUpdate("collection_id", req.body.collectionId || null);
    if (req.body.collectionName !== undefined)
      pushUpdate("collection_name", req.body.collectionName || null);
    if (req.body.musicVideoLink !== undefined)
      pushUpdate("music_video_link", req.body.musicVideoLink || null);
    if (req.body.type_of_music !== undefined)
      pushUpdate("type_of_music", req.body.type_of_music || null);

    if (req.body.feast !== undefined) {
      const v = Array.isArray(req.body.feast) || typeof req.body.feast === "object"
        ? JSON.stringify(req.body.feast) : req.body.feast;
      pushUpdate("feast", v || null);
    }
    if (req.body.verseStyle !== undefined) {
      const v = Array.isArray(req.body.verseStyle) || typeof req.body.verseStyle === "object"
        ? JSON.stringify(req.body.verseStyle) : req.body.verseStyle;
      pushUpdate("verseStyle", v || null);
    }
    if (req.body.liturgicalText !== undefined) {
      const v = Array.isArray(req.body.liturgicalText) || typeof req.body.liturgicalText === "object"
        ? JSON.stringify(req.body.liturgicalText) : req.body.liturgicalText;
      pushUpdate("liturgicalText", v || null);
    }

    if (req.body.vocalParts !== undefined)
      pushUpdate("vocal_parts", Array.isArray(req.body.vocalParts)
        ? JSON.stringify(req.body.vocalParts) : req.body.vocalParts || null);
    if (req.body.instrumentation !== undefined)
      pushUpdate("instrumentation", Array.isArray(req.body.instrumentation)
        ? JSON.stringify(req.body.instrumentation) : req.body.instrumentation || null);
    if (req.body.typesOfMusic !== undefined)
      pushUpdate("types_of_music", req.body.typesOfMusic || null);

    if (req.body.firstLineOfComposition !== undefined)
      pushUpdate("first_line_of_composition", req.body.firstLineOfComposition || null);
    if (req.body.compositionCopyrights !== undefined)
      pushUpdate("composition_copyrights", Array.isArray(req.body.compositionCopyrights)
        ? JSON.stringify(req.body.compositionCopyrights) : req.body.compositionCopyrights || null);
    if (req.body.massSettingParts !== undefined) {
      const msp = req.body.massSettingParts;
      pushUpdate("mass_setting_parts", Array.isArray(msp) ? JSON.stringify(msp) : msp || null);
    }
    if (req.body.songType !== undefined) pushUpdate("song_type", req.body.songType || null);
    if (req.body.meter !== undefined) pushUpdate("meter", req.body.meter || null);
    if (req.body.season !== undefined) pushUpdate("season", req.body.season || null);
    if (req.body.psalmNumber !== undefined) pushUpdate("psalm_number", req.body.psalmNumber || null);

    if (req.body.textCopyrightNotice !== undefined)
      pushUpdate("text_copyright_notice", req.body.textCopyrightNotice || null);
    if (req.body.tuneCopyrightNotice !== undefined)
      pushUpdate("tune_copyright_notice", req.body.tuneCopyrightNotice || null);
    if (req.body.compositionTitle1 !== undefined)
      pushUpdate("composition_title_1", req.body.compositionTitle1 || null);

    if (req.body.artists !== undefined)
      pushUpdate("artists", Array.isArray(req.body.artists)
        ? JSON.stringify(req.body.artists) : req.body.artists || null);
    if (req.body.musicFiles !== undefined)
      pushUpdate("music_files", req.body.musicFiles ? JSON.stringify(req.body.musicFiles) : null);
    if (req.body.artworkFileUrl !== undefined) pushUpdate("artwork_file_url", req.body.artworkFileUrl || null);
    if (req.body.artworkFileSize !== undefined) pushUpdate("artwork_file_size", req.body.artworkFileSize || null);
    if (req.body.language !== undefined) {
      const v = Array.isArray(req.body.language)
        ? JSON.stringify(req.body.language)
        : JSON.stringify([req.body.language]);
      pushUpdate("language", v);
    }

    if (req.body.tune !== undefined) {
      const v = req.body.tune;
      pushUpdate("tune", v && typeof v === "string" && v.trim() ? v.trim() : null);
    }
    if (req.body.generalDetails !== undefined) {
      const v = req.body.generalDetails;
      pushUpdate("general_details", v && typeof v === "string" && v.trim() ? v.trim() : null);
    }
    if (req.body.countryRestrictions !== undefined) {
      const v = req.body.countryRestrictions;
      pushUpdate("country_restrictions", v && typeof v === "string" && v.trim() ? v.trim() : null);
    }

    if (req.body.isPublicDomain !== undefined) pushUpdate("is_public_domain", boolField(req.body.isPublicDomain));
    if (req.body.canBeReprinted !== undefined) pushUpdate("can_be_reprinted", boolField(req.body.canBeReprinted));
    if (req.body.canBePodcastStreamed !== undefined) pushUpdate("can_be_podcast_streamed", boolField(req.body.canBePodcastStreamed));
    if (req.body.canMakeCommercialRecording !== undefined) pushUpdate("can_make_commercial_recording", boolField(req.body.canMakeCommercialRecording));
    if (req.body.canMakeNonCommercialRecording !== undefined) pushUpdate("can_make_non_commercial_recording", boolField(req.body.canMakeNonCommercialRecording));

    if (req.body.termsAccepted !== undefined) {
      if (req.body.termsAccepted) {
        updateFields.push("terms_accepted = ?, terms_accepted_at = NOW()");
        updateValues.push(req.body.termsAccepted ? 1 : 0);
        columnsToUpdate["terms_accepted"] = req.body.termsAccepted ? 1 : 0;
      } else {
        pushUpdate("terms_accepted", req.body.termsAccepted ? 1 : 0);
      }
    }

    // ─── Build change diff ────────────────────────────────────────────────────
    let changes = [];

    for (const [col, newVal] of Object.entries(columnsToUpdate)) {
      try {
        let oldVal = existing[col];

        const isPossiblyJSON =
          typeof oldVal === "string" &&
          (oldVal.trim().startsWith("[") || oldVal.trim().startsWith("{"));

        let oldParsed = oldVal;
        let newParsed = newVal;

        if (isPossiblyJSON) {
          try { oldParsed = JSON.parse(oldVal); } catch (e) { oldParsed = oldVal; }
        }
        if (typeof newVal === "string" &&
          (newVal.trim().startsWith("[") || newVal.trim().startsWith("{"))) {
          try { newParsed = JSON.parse(newVal); } catch (e) { newParsed = newVal; }
        }

        if (oldParsed === 0) oldParsed = false;
        if (oldParsed === 1) oldParsed = true;
        if (newParsed === 0) newParsed = false;
        if (newParsed === 1) newParsed = true;

        const beforeStr = typeof oldParsed === "object"
          ? JSON.stringify(oldParsed)
          : String(oldParsed === undefined || oldParsed === null ? "" : oldParsed);
        const afterStr = typeof newParsed === "object"
          ? JSON.stringify(newParsed)
          : String(newParsed === undefined || newParsed === null ? "" : newParsed);

        if (beforeStr !== afterStr) {
          changes.push({
            field: col,
            before: oldParsed === undefined ? null : oldParsed,
            after: newParsed === undefined ? null : newParsed,
            changed_at: new Date().toISOString(),
            changed_by: userId,
          });
        }
      } catch (cmpErr) {
        changes.push({
          field: col,
          before: existing[col] ?? null,
          after: newVal ?? null,
          changed_at: new Date().toISOString(),
          changed_by: userId,
        });
      }
    }


    const resubmissionEntry = {
      type: "composer_resubmission",
      resubmitted_by: userId,
      resubmitted_at: new Date().toISOString(),
      changes, // chahe empty ho ya filled — entry hamesha store hogi
    };

    if (reviewStage === "director_review") {
      // ── stage2_replaced_files mein push ────────────────────────────────────
      let existingStage2 = [];
      try {
        if (existing.stage2_replaced_files) {
          existingStage2 = typeof existing.stage2_replaced_files === "string"
            ? JSON.parse(existing.stage2_replaced_files)
            : existing.stage2_replaced_files;
          if (!Array.isArray(existingStage2)) existingStage2 = [];
        }
      } catch (e) { existingStage2 = []; }
      existingStage2.push(resubmissionEntry);
      pushUpdate("stage2_replaced_files", JSON.stringify(existingStage2));

      pushUpdate("stage2_decision", null);
      pushUpdate("stage2_reviewed_at", null);
      pushUpdate("stage2_reviewed_by", null);
      pushUpdate("stage2_notes", null);

      console.log("✅ [stage2 resubmission] stage2_decision reset to NULL for fresh director review");

    } else if (reviewStage === "music_editorial") {
      // ── stage3_replaced_files mein push ────────────────────────────────────
      let existingStage3 = [];
      try {
        if (existing.stage3_replaced_files) {
          existingStage3 = typeof existing.stage3_replaced_files === "string"
            ? JSON.parse(existing.stage3_replaced_files)
            : existing.stage3_replaced_files;
          if (!Array.isArray(existingStage3)) existingStage3 = [];
        }
      } catch (e) { existingStage3 = []; }
      existingStage3.push(resubmissionEntry);
      pushUpdate("stage3_replaced_files", JSON.stringify(existingStage3));
    }

    // ─── Execute UPDATE ───────────────────────────────────────────────────────
    if (updateFields.length > 0) {
      updateFields.push("updated_at = NOW()");
      const sql = `UPDATE music_publications SET ${updateFields.join(", ")} WHERE id = ?`;
      updateValues.push(publicationId);
      await mysqlConnection.execute(sql, updateValues);
    }

    const [publicationsAfter] = await mysqlConnection.execute(
      "SELECT * FROM music_publications WHERE id = ?",
      [publicationId],
    );
    const publication = publicationsAfter[0];

    // ─── Collection handling ──────────────────────────────────────────────────
    let collectionAdded = false;
    let collectionIdResult = null;
    let collectionNameResult = null;

    try {
      if (req.body.isPartOfCollection === true) {
        if (req.body.collectionId) {
          const [collections] = await mysqlConnection.execute(
            "SELECT id, name FROM collections WHERE id = ? AND is_system_collection = TRUE",
            [req.body.collectionId],
          );
          if (collections.length > 0) {
            await mysqlConnection.execute(
              "INSERT IGNORE INTO collection_music (collection_id, music_id) VALUES (?, ?)",
              [req.body.collectionId, publicationId],
            );
            collectionAdded = true;
            collectionIdResult = req.body.collectionId;
            collectionNameResult = collections[0].name;
          }
        }
      } else if (req.body.isPartOfCollection === false) {
        if (req.body.collectionId) {
          const [collections] = await mysqlConnection.execute(
            "SELECT id, name FROM collections WHERE id = ? AND user_id = ? AND is_system_collection = FALSE",
            [req.body.collectionId, existing.composer_id],
          );
          if (collections.length > 0) {
            await mysqlConnection.execute(
              "INSERT IGNORE INTO collection_music (collection_id, music_id) VALUES (?, ?)",
              [req.body.collectionId, publicationId],
            );
            collectionAdded = true;
            collectionIdResult = req.body.collectionId;
            collectionNameResult = collections[0].name;
          }
        } else if (req.body.collectionName) {
          const [existingCollections] = await mysqlConnection.execute(
            "SELECT id FROM collections WHERE user_id = ? AND name = ? AND is_system_collection = FALSE",
            [existing.composer_id, req.body.collectionName],
          );
          if (existingCollections.length > 0) {
            collectionIdResult = existingCollections[0].id;
            collectionNameResult = req.body.collectionName;
          } else {
            const [collectionResult] = await mysqlConnection.execute(
              "INSERT INTO collections (name, description, user_id, is_system_collection, created_by) VALUES (?, ?, ?, ?, ?)",
              [req.body.collectionName, req.body.collectionDescription || null,
              existing.composer_id, false, "user"],
            );
            collectionIdResult = collectionResult.insertId;
            collectionNameResult = req.body.collectionName;
          }
          if (collectionIdResult) {
            await mysqlConnection.execute(
              "INSERT IGNORE INTO collection_music (collection_id, music_id) VALUES (?, ?)",
              [collectionIdResult, publicationId],
            );
            collectionAdded = true;
          }
        }
      }
    } catch (collectionError) {
      console.error("Error handling collection logic:", collectionError);
    }

    // ─── Notification email ───────────────────────────────────────────────────
    try {
      const [composerUser] = await mysqlConnection.execute(
        "SELECT first_name, last_name, email FROM users WHERE id = ?",
        [existing.composer_id],
      );
      const composer = composerUser[0];
      const composerFirstName = composer?.first_name || publication.composer_firstname || "Composer";
      const composerEmail = composer?.email;

      if (composerEmail) {
        const allAnswers = `
Composition Title: ${publication.composition_title || "N/A"}
Composer: ${publication.composer_firstname || ""} ${publication.composer_lastname || ""}
Description: ${publication.composition_description || "N/A"}
Tune: ${publication.tune || "N/A"}
General Details: ${publication.general_details || "N/A"}
Country Restrictions: ${publication.country_restrictions || "N/A"}
Is Public Domain: ${publication.is_public_domain ? "Yes" : "No"}
Can Be Reprinted: ${publication.can_be_reprinted ? "Yes" : "No"}
Can Be Podcast/Streamed: ${publication.can_be_podcast_streamed ? "Yes" : "No"}
Can Make Commercial Recording: ${publication.can_make_commercial_recording ? "Yes" : "No"}
Can Make Non-commercial Recording: ${publication.can_make_non_commercial_recording ? "Yes" : "No"}
First Line of Composition: ${publication.first_line_of_composition || "N/A"}
Song Type: ${publication.song_type || "N/A"}
Meter: ${publication.meter || "N/A"}
Season: ${publication.season || "N/A"}
Psalm Number: ${publication.psalm_number || "N/A"}
Updated At: ${new Date().toLocaleString()}
        `.trim();

        const emailResult = await sendMusicSubmissionEmail({
          submitterEmail: composerEmail,
          firstName: composerFirstName,
          submissionTitle: publication.composition_title || "Untitled",
          submissionId: publication.id,
          status: publication.status === "draft" ? "Under Review" : "Submitted",
          portalLink: `${process.env.FRONTEND_URL}/music-compositions`,
          allAnswers,
          attachments,
        });

        if (emailResult.success) {
          console.log("Music update emails sent successfully");
        } else {
          console.error("Music update emails failed:", emailResult.error);
        }
      }
    } catch (emailError) {
      console.error("⚠️ Error sending music update emails:", emailError);
    }

    successResponse(
      res,
      {
        publication,
        collectionAdded,
        collectionId: collectionIdResult,
        collectionName: collectionNameResult,
        changes,
      },
      "Publication updated successfully",
    );
  } catch (error) {
    console.error("Music publication update error:", error);
    errorResponse(res, "Failed to update publication", 500);
  }
});

// @route   GET /api/music-publications/available-music
// @desc    Get all available music for adding to library (any authenticated user)
// @access  Private (Any authenticated user)
router.get("/available-music", auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    // Get all available music publications with complete details
    const [publications] = await mysqlConnection.execute(
      `SELECT 
        mp.id,
        mp.composition_title,
        mp.composition_description,
        mp.composer_firstname,
        mp.composer_lastname,
        mp.vocal_parts,
        mp.instrumentation,
        mp.types_of_music,
        mp.first_line_of_composition,
        mp.composition_copyrights,
        mp.mass_setting_parts,
        mp.song_type,
        mp.meter,
        mp.season,
        mp.psalm_number,
        mp.text_copyright_notice,
        mp.tune_copyright_notice,
        mp.artists,
        mp.music_files,
        mp.artwork_file_url,
        mp.artwork_file_size,
        mp.price,
        mp.is_free,
        mp.tune,
        mp.general_details,
        mp.country_restrictions,
        mp.is_public_domain,
        mp.can_be_reprinted,
        mp.can_be_podcast_streamed,
        mp.can_make_commercial_recording,
        mp.can_make_non_commercial_recording,
        mp.status,
        mp.published_at,
        mp.created_at,
        u.id as composer_id,
        u.first_name,
        u.last_name,
        u.email as composer_email,
        u.avatar as composer_avatar
       FROM music_publications mp 
       JOIN users u ON mp.composer_id = u.id 
       WHERE (mp.scheduled_deletion_at IS NULL OR mp.scheduled_deletion_at > NOW())
       ORDER BY mp.created_at DESC`,
    );

    // Format publications for response with complete details
    const formattedPublications = publications.map((pub) => ({
      id: pub.id,
      compositionTitle: pub.composition_title,
      compositionDescription: pub.composition_description,
      composerFirstName: pub.composer_firstname,
      composerLastName: pub.composer_lastname,
      vocalParts: pub.vocal_parts
        ? typeof pub.vocal_parts === "string"
          ? JSON.parse(pub.vocal_parts)
          : pub.vocal_parts
        : null,
      instrumentation: pub.instrumentation
        ? typeof pub.instrumentation === "string"
          ? JSON.parse(pub.instrumentation)
          : pub.instrumentation
        : null,
      artists: pub.artists
        ? typeof pub.artists === "string"
          ? JSON.parse(pub.artists)
          : pub.artists
        : [],
      typesOfMusic: pub.types_of_music,
      firstLineOfComposition: pub.first_line_of_composition,
      compositionCopyrights: pub.composition_copyrights
        ? typeof pub.composition_copyrights === "string"
          ? JSON.parse(pub.composition_copyrights)
          : pub.composition_copyrights
        : [],
      massSettingParts: pub.mass_setting_parts || "",
      songType: pub.song_type,
      meter: pub.meter,
      season: pub.season,
      psalmNumber: pub.psalm_number,
      textCopyrightNotice: pub.text_copyright_notice,
      tuneCopyrightNotice: pub.tune_copyright_notice,
      musicFiles: pub.music_files ? JSON.parse(pub.music_files) : [],
      artworkFileUrl: pub.artwork_file_url,
      artworkFileSize: pub.artwork_file_size,
      price: parseFloat(pub.price) || 0,
      isFree: Boolean(pub.is_free),
      tune: pub.tune,
      generalDetails: pub.general_details,
      countryRestrictions: pub.country_restrictions,
      isPublicDomain:
        pub.is_public_domain === 1 || pub.is_public_domain === true,
      canBeReprinted:
        pub.can_be_reprinted === 1 || pub.can_be_reprinted === true,
      canBePodcastStreamed:
        pub.can_be_podcast_streamed === 1 ||
        pub.can_be_podcast_streamed === true,
      canMakeCommercialRecording:
        pub.can_make_commercial_recording === 1 ||
        pub.can_make_commercial_recording === true,
      canMakeNonCommercialRecording:
        pub.can_make_non_commercial_recording === 1 ||
        pub.can_make_non_commercial_recording === true,
      status: pub.status,
      publishedAt: pub.published_at,
      createdAt: pub.created_at,
      composer: {
        id: pub.composer_id,
        firstName: pub.first_name,
        lastName: pub.last_name,
        fullName: `${pub.first_name} ${pub.last_name}`,
        email: pub.composer_email,
        avatar: pub.composer_avatar,
      },
    }));

    successResponse(
      res,
      {
        publications: formattedPublications,
        total: formattedPublications.length,
      },
      "Available music publications retrieved successfully",
    );
  } catch (error) {
    console.error("Get available music error:", error);
    errorResponse(res, "Failed to get available music publications", 500);
  }
});

// @route   GET /api/music-publications/:id
// @desc    Get specific publication
// @access  Private (Composer/Owner or Admin/OneLicense/SL Team)
router.get(
  "/:id",
  [auth],
  async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;
      const userRole = req.user.role;
      const mysqlConnection = getMySQLConnection();

      let query = `
      SELECT mp.*, u.first_name, u.last_name, u.email as composer_email,
      u.publisherName AS publisherName
      FROM music_publications mp 
      JOIN users u ON mp.composer_id = u.id 
      WHERE mp.id = ?
    `;
      let queryValues = [id];

      // Show all publications to any authenticated user
      // No role restrictions

      const [publications] = await mysqlConnection.execute(query, queryValues);
      console.log(publications);

      if (publications.length === 0) {
        return errorResponse(res, "Publication not found", 404);
      }

      successResponse(
        res,
        {
          publication: formatMusicPublication(publications[0]),
          reviewSummary: buildStage1ReviewSummary(publications[0]),
          reviewHistory: buildReviewHistory(publications[0]),
        },
        "Publication retrieved successfully",
      );
    } catch (error) {
      console.error("Get publication error:", error);
      errorResponse(res, "Failed to get publication", 500);
    }
  },
);

function sanitizeFileName(originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const base = path.basename(originalName, ext);

  const cleanBase = base
    .normalize("NFKD") // remove unicode junk
    .replace(/[\u0300-\u036f]/g, "") // accents
    .replace(/\+/g, "plus") // + → plus
    .replace(/\s+/g, "-") // spaces → -
    .replace(/[^a-zA-Z0-9-_]/g, "") // remove special chars
    .toLowerCase();

  return `${cleanBase}${ext}`;
}

// @route   POST /api/music-publications/upload/music
// @desc    Upload multiple music files to S3 (max 10 files including audio, PDF, lyrics)
// @access  Private (Composer or SL Team only)
router.post(
  "/upload/music",
  [
    auth,
    // requireComposerOrRole('sl_team'),
    // requireAnyRole(['composer', 'sl_team']),    // Not needed as auth middleware already restricts to authenticated users
    musicUpload.array("musicFiles", 10), // Allow up to 10 files
  ],
  async (req, res) => {
    try {
      if (!req.files || req.files.length === 0) {
        return errorResponse(res, "No music files uploaded", 400);
      }

      if (req.files.length > 10) {
        return errorResponse(res, "Maximum 10 files allowed per upload", 400);
      }

      const uploadedFiles = [];
      const uploadId = Date.now(); // unique per request
      const thumbnailsDir = path.resolve(
        __dirname,
        "..",
        "thumbnails",
        String(uploadId),
      );

      // Ensure thumbnails directory exists
      if (!fs.existsSync(thumbnailsDir)) {
        fs.mkdirSync(thumbnailsDir, { recursive: true });
      }

      for (const file of req.files) {
        const safeOriginalName = sanitizeFileName(file.originalname);
        const baseName = path.parse(safeOriginalName).name;

        const fileData = {
          fileUrl: file.location,
          fileSize: file.size,
          fileName: safeOriginalName,
          fileType: file.mimetype,
          uploadedAt: new Date().toISOString(),
          thumbnailUrl: null,
          sampleThumbnailUrl: null,
        };

        // ==============================
        // PDF THUMBNAIL GENERATION
        // ==============================
        if (file.mimetype === "application/pdf") {
          try {
            const tempPdfPath = path.join(
              thumbnailsDir,
              `temp_${Date.now()}_${safeOriginalName}`,
            );

            await downloadFileFromUrl(file.location, tempPdfPath);

            const pngPages = await pdfToPng(tempPdfPath, {
              viewportScale: 3.0,
              outputFolder: path.relative(process.cwd(), thumbnailsDir),
              pagesToProcess: [1],
              outputFileMask: `${baseName}_${Date.now()}`,
            });

            if (pngPages && pngPages.length > 0) {
              const firstPagePath = pngPages[0].path;

              // ==============================
              // NORMAL THUMBNAIL
              // ==============================
              const thumbFileName = `${baseName}_${Date.now()}_thumb.png`;
              const thumbPath = path.join(thumbnailsDir, thumbFileName);

              await sharp(firstPagePath)
                .resize(800, 800, {
                  fit: "inside",
                  withoutEnlargement: true,
                  kernel: sharp.kernel.lanczos3,
                })
                .png({ quality: 100 })
                .toFile(thumbPath);

              // Upload thumbnail to S3
              const thumbnailS3Url = await uploadThumbnailToS3(
                thumbPath,
                thumbFileName,
              );

              // Set S3 URL instead of local path
              fileData.thumbnailUrl = thumbnailS3Url;
              fileData.thumbnailGenerated = true;

              // ==============================
              // SAMPLE WATERMARK THUMBNAIL
              // ==============================
              const sampleThumbFileName = `${baseName}_${Date.now()}_sample.png`;
              const sampleThumbPath = path.join(
                thumbnailsDir,
                sampleThumbFileName,
              );

              const image = sharp(thumbPath);
              const metadata = await image.metadata();

              await image
                .composite([
                  {
                    input: getSampleWatermarkSVG(
                      metadata.width,
                      metadata.height,
                    ),
                    gravity: "center",
                  },
                ])
                .png({ quality: 100 })
                .toFile(sampleThumbPath);

              const sampleThumbnailS3Url = await uploadThumbnailToS3(
                sampleThumbPath,
                sampleThumbFileName,
              );

              fileData.sampleThumbnailUrl = sampleThumbnailS3Url;
              fileData.sampleThumbnailGenerated = true;

              // ==============================
              // CLEANUP
              // ==============================
              fs.unlinkSync(tempPdfPath);
              fs.unlinkSync(firstPagePath);
              fs.unlinkSync(thumbPath);
              fs.unlinkSync(sampleThumbPath);
            }
          } catch (thumbnailError) {
            console.error(
              `Failed to generate thumbnail for ${file.originalname}:`,
              thumbnailError,
            );
            fileData.thumbnailGenerated = false;
            fileData.thumbnailError = thumbnailError.message;
          }
        }

        uploadedFiles.push(fileData);
      }

      // ==============================
      // FINAL CLEANUP
      // ==============================
      fs.rmSync(thumbnailsDir, { recursive: true, force: true });

      return successResponse(
        res,
        {
          files: uploadedFiles,
          totalFiles: uploadedFiles.length,
        },
        "Music uploaded successfully with normal & SAMPLE thumbnails",
      );
    } catch (error) {
      console.error("Upload error:", error);
      return errorResponse(res, "Failed to upload music files", 500);
    }
  },
);

// Helper function to download file from URL
async function downloadFileFromUrl(url, filePath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https:") ? https : http;
    const file = fs.createWriteStream(filePath);

    protocol
      .get(url, (response) => {
        response.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
      })
      .on("error", (err) => {
        fs.unlink(filePath, () => { }); // Delete the file on error
        reject(err);
      });
  });
}

// Updated helper function to upload thumbnail to S3 using AWS SDK v3
async function uploadThumbnailToS3(localFilePath, fileName) {
  try {
    const fileBuffer = fs.readFileSync(localFilePath);

    const uploadParams = {
      Bucket: BUCKET_NAME,
      Key: `sl-music-backend/thumbnails/${fileName}`, // Store in thumbnails folder in S3
      Body: fileBuffer,
      ContentType: "image/png",
      // Removed ACL parameter since bucket doesn't allow ACLs
    };

    const command = new PutObjectCommand(uploadParams);
    const result = await s3Client.send(command);

    // Construct the S3 URL
    const s3Url = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION || "ap-south-1"}.amazonaws.com/sl-music-backend/thumbnails/${fileName}`;

    console.log("Thumbnail uploaded to S3:", s3Url);
    return s3Url;
  } catch (error) {
    console.error("S3 thumbnail upload error:", error);
    throw error;
  }
}

router.post(
  "/upload/artwork",
  [
    auth,
    // requireComposerOrRole('sl_team'),
    // requireAnyRole(['composer', 'sl_team']),  // Not needed as auth middleware already restricts to authenticated users
    artworkUpload.single("artworkFile"),
  ],
  async (req, res) => {
    try {
      if (!req.file) {
        return errorResponse(res, "No artwork file uploaded", 400);
      }

      const fileUrl = req.file.location;
      const fileSize = req.file.size;

      successResponse(
        res,
        {
          fileUrl,
          fileSize,
          fileName: req.file.originalname,
          fileType: req.file.mimetype,
        },
        "Artwork file uploaded successfully",
      );
    } catch (error) {
      console.error("Artwork upload error:", error);
      errorResponse(res, "Failed to upload artwork file", 500);
    }
  },
);

// @route   DELETE /api/music-publications/delete-file
// @desc    Delete file from S3
// @access  Private (Composer or SL Team only)
router.delete(
  "/delete-file",
  [auth, requireAnyRole(["composer", "sl_team"])],
  async (req, res) => {
    try {
      const { fileUrl } = req.body;

      if (!fileUrl) {
        return errorResponse(res, "File URL is required", 400);
      }

      await deleteFileFromS3(fileUrl);

      successResponse(
        res,
        {
          deletedFile: fileUrl,
        },
        "File deleted successfully",
      );
    } catch (error) {
      console.error("File deletion error:", error);
      errorResponse(res, "Failed to delete file", 500);
    }
  },
);

// @route   PUT /api/music-publications/:id/publish
// @desc    Publish music publication (SL Team only)
// @access  Private (SL Team only)
router.put(
  "/:id/publish",
  [auth, requireAnyRole(["sl_team"])],
  async (req, res) => {
    try {
      const { id } = req.params;
      const { publishNotes, price, isFree } = req.body;
      const publisherId = req.user.id;
      const mysqlConnection = getMySQLConnection();

      // Validate price if provided
      if (price !== undefined && price !== null) {
        const priceNum = parseFloat(price);
        if (isNaN(priceNum) || priceNum < 0) {
          return errorResponse(
            res,
            "Invalid price. Price must be a positive number or zero",
            400,
          );
        }
      }

      // Get publication
      const [publications] = await mysqlConnection.execute(
        "SELECT * FROM music_publications WHERE id = ?",
        [id],
      );

      if (publications.length === 0) {
        return errorResponse(res, "Publication not found", 404);
      }

      const publication = publications[0];

      // Allow SL Team to publish from any status except already published/rejected
      if (publication.status === "published") {
        return errorResponse(res, "Publication is already published", 400);
      }

      if (publication.status === "rejected") {
        return errorResponse(res, "Cannot publish a rejected publication", 400);
      }

      // Update publication status to published
      const updateFields = [
        "status = ?",
        "published_at = NOW()",
        "published_by = ?",
        "updated_at = NOW()",
      ];
      const updateValues = ["published", publisherId];

      // Add price if provided
      if (price !== undefined && price !== null) {
        updateFields.push("price = ?");
        updateValues.push(parseFloat(price));
      }

      // Add is_free flag if provided
      if (isFree !== undefined) {
        updateFields.push("is_free = ?");
        updateValues.push(isFree ? 1 : 0);
      } else if (price !== undefined) {
        // If price is set but is_free not provided, auto-set is_free based on price
        updateFields.push("is_free = ?");
        updateValues.push(parseFloat(price) === 0 ? 1 : 0);
      }

      if (publishNotes) {
        updateFields.push("sl_team_review_notes = ?");
        updateValues.push(publishNotes);
      }

      updateValues.push(id);

      await mysqlConnection.execute(
        `UPDATE music_publications SET ${updateFields.join(", ")} WHERE id = ?`,
        updateValues,
      );

      // Get updated publication
      const [updatedPublications] = await mysqlConnection.execute(
        "SELECT * FROM music_publications WHERE id = ?",
        [id],
      );

      successResponse(
        res,
        {
          publication: updatedPublications[0],
          publishedBy: publisherId,
          publishedAt: new Date(),
          price:
            price !== undefined
              ? parseFloat(price)
              : updatedPublications[0].price,
          isFree:
            isFree !== undefined ? isFree : updatedPublications[0].is_free,
        },
        "Music publication published successfully",
      );
    } catch (error) {
      console.error("Publish music error:", error);
      errorResponse(res, "Failed to publish music publication", 500);
    }
  },
);

// @route   PUT /api/music-publications/:id/reject
// @desc    Reject music publication (SL Team only)
// @access  Private (SL Team only)
router.put(
  "/:id/reject",
  [auth, requireAnyRole(["sl_team"])],
  async (req, res) => {
    try {
      const { id } = req.params;
      const { rejectionReason, reviewNotes } = req.body;
      const reviewerId = req.user.id;
      const mysqlConnection = getMySQLConnection();

      // Validate rejection reason
      if (!rejectionReason) {
        return errorResponse(res, "Rejection reason is required", 400);
      }

      // Get publication
      const [publications] = await mysqlConnection.execute(
        "SELECT * FROM music_publications WHERE id = ?",
        [id],
      );

      if (publications.length === 0) {
        return errorResponse(res, "Publication not found", 404);
      }

      const publication = publications[0];

      // Check if publication is already published
      if (publication.status === "published") {
        return errorResponse(res, "Cannot reject a published publication", 400);
      }

      // Check if already rejected
      if (publication.status === "rejected") {
        return errorResponse(res, "Publication is already rejected", 400);
      }

      // Update publication status to rejected
      const updateFields = [
        "status = ?",
        "rejection_reason = ?",
        "updated_at = NOW()",
      ];
      const updateValues = ["rejected", rejectionReason];

      if (reviewNotes) {
        updateFields.push("sl_team_review_notes = ?");
        updateValues.push(reviewNotes);
      }

      // Add reviewer info
      updateFields.push("sl_team_reviewed_by = ?");
      updateFields.push("sl_team_reviewed_at = NOW()");
      updateValues.push(reviewerId);

      updateValues.push(id);

      await mysqlConnection.execute(
        `UPDATE music_publications SET ${updateFields.join(", ")} WHERE id = ?`,
        updateValues,
      );

      // Get updated publication
      const [updatedPublications] = await mysqlConnection.execute(
        `SELECT mp.*, 
              u.first_name as composer_first_name, 
              u.last_name as composer_last_name,
              r.first_name as reviewer_first_name,
              r.last_name as reviewer_last_name
       FROM music_publications mp
       LEFT JOIN users u ON mp.composer_id = u.id
       LEFT JOIN users r ON mp.sl_team_reviewed_by = r.id
       WHERE mp.id = ?`,
        [id],
      );

      successResponse(
        res,
        {
          publication: updatedPublications[0],
          rejectedBy: reviewerId,
          rejectedAt: new Date(),
          rejectionReason: rejectionReason,
        },
        "Music publication rejected successfully",
      );
    } catch (error) {
      console.error("Reject music error:", error);
      errorResponse(res, "Failed to reject music publication", 500);
    }
  },
);

// @route   PUT /api/music-publications/:id/admin-approve
// @desc    Admin approve music publication (Admin only)
// @access  Private (Admin/SL Team only)
router.put(
  "/:id/admin-approve",
  [auth, requireSLTeamWithTypes(["superadmin", "admin"])],
  async (req, res) => {
    try {
      const { id } = req.params;
      const { reviewNotes, price, decision } = req.body;
      const reviewerId = req.user.id;
      const mysqlConnection = getMySQLConnection();

      // Validate decision
      if (!decision || !["approved", "rejected"].includes(decision)) {
        return errorResponse(
          res,
          'Invalid decision. Use "approved" or "rejected".',
          400,
        );
      }

      // Get publication
      const [publications] = await mysqlConnection.execute(
        "SELECT * FROM music_publications WHERE id = ?",
        [id],
      );

      if (publications.length === 0) {
        return errorResponse(res, "Publication not found", 404);
      }

      const publication = publications[0];

      // Get reviewer details
      const [reviewerData] = await mysqlConnection.execute(
        "SELECT first_name, last_name, user_type FROM users WHERE id = ?",
        [reviewerId],
      );

      const reviewer = reviewerData[0];
      const reviewerRole =
        reviewer.user_type === "superadmin" ? "Superadmin" : "Admin";
      const reviewerName = `${reviewer.first_name} ${reviewer.last_name}`;

      // Notes text
      const baseNotePrefix = decision === "approved" ? "Approved" : "Rejected";
      const commonNote = `${baseNotePrefix} by ${reviewerRole} (${reviewerName})${reviewNotes ? ": " + reviewNotes : ""}`;

      // -------------------------
      // APPROVE FLOW
      // -------------------------
      if (decision === "approved") {
        // Determine price and is_free
        let finalPrice = 0.0;
        let isFree = true;

        if (price !== undefined && price !== null && parseFloat(price) > 0) {
          finalPrice = parseFloat(price);
          isFree = false;
        }

        const updateQuery = `
        UPDATE music_publications 
        SET 
          status = 'published',
          review_stage = 'published',
          
          -- Price settings
          price = ?,
          is_free = ?,
          
          -- Stage 1: Review Board
          stage1_decision = 'approved',
          stage1_reviewed_by = ?,
          stage1_reviewed_at = NOW(),
          stage1_notes = ?,
          
          -- Stage 2: Director Review
          stage2_decision = 'approved',
          stage2_reviewed_by = ?,
          stage2_reviewed_at = NOW(),
          stage2_notes = ?,
          
          -- Stage 3: Music Editorial
          stage3_decision = 'approved',
          stage3_reviewed_by = ?,
          stage3_reviewed_at = NOW(),
          stage3_notes = ?,
          
          -- Stage 4: Final Review
          stage4_decision = 'approved',
          stage4_reviewed_by = ?,
          stage4_reviewed_at = NOW(),
          stage4_notes = ?,
          
          -- Legacy fields
          admin_reviewed_by = ?,
          admin_reviewed_at = NOW(),
          admin_review_notes = ?,
          
          -- Clear rejection reason if any
          rejection_reason = NULL,
          
          -- Publication info
          published_at = NOW(),
          published_by = ?,
          
          updated_at = NOW()
        WHERE id = ?
      `;

        await mysqlConnection.execute(updateQuery, [
          finalPrice,
          isFree,
          // Stage 1
          reviewerId,
          commonNote,
          // Stage 2
          reviewerId,
          commonNote,
          // Stage 3
          reviewerId,
          commonNote,
          // Stage 4
          reviewerId,
          commonNote,
          // Legacy
          reviewerId,
          commonNote,
          // Published
          reviewerId,
          // Where
          id,
        ]);

        // Get updated publication with all details
        const [updatedPublications] = await mysqlConnection.execute(
          `SELECT mp.*, 
                u.first_name as composer_first_name, 
                u.last_name as composer_last_name,
                u.email as composer_email,
                r.first_name as reviewer_first_name,
                r.last_name as reviewer_last_name,
                r.user_type as reviewer_type
         FROM music_publications mp
         LEFT JOIN users u ON mp.composer_id = u.id
         LEFT JOIN users r ON mp.published_by = r.id
         WHERE mp.id = ?`,
          [id],
        );

        const updatedPublication = updatedPublications[0];

        return successResponse(
          res,
          {
            publication: updatedPublication,
            reviewedBy: {
              id: reviewerId,
              name: reviewerName,
              role: reviewerRole,
            },
            reviewedAt: new Date(),
            allStagesApproved: true,
            priceInfo: {
              price: finalPrice,
              isFree: isFree,
            },
            decision: "approved",
            message:
              "Publication fully approved and published by admin. All stages completed.",
          },
          "Publication approved and published successfully",
        );
      }

      // -------------------------
      // REJECT FLOW
      // -------------------------
      const rejectionReason = reviewNotes || "Rejected by admin";

      const rejectUpdateQuery = `
      UPDATE music_publications
      SET
        status = 'rejected',
        review_stage = 'rejected',
        
        -- Stage 1: Review Board
        stage1_decision = 'rejected',
        stage1_reviewed_by = ?,
        stage1_reviewed_at = NOW(),
        stage1_notes = ?,
        
        -- Stage 2: Director Review
        stage2_decision = 'rejected',
        stage2_reviewed_by = ?,
        stage2_reviewed_at = NOW(),
        stage2_notes = ?,
        
        -- Stage 3: Music Editorial
        stage3_decision = 'rejected',
        stage3_reviewed_by = ?,
        stage3_reviewed_at = NOW(),
        stage3_notes = ?,
        
        -- Stage 4: Final Review
        stage4_decision = 'rejected',
        stage4_reviewed_by = ?,
        stage4_reviewed_at = NOW(),
        stage4_notes = ?,
        
        -- Legacy fields
        admin_reviewed_by = ?,
        admin_reviewed_at = NOW(),
        admin_review_notes = ?,
        
        -- Rejection info
        rejection_reason = ?,
        
        -- Ensure it's not marked as published
        published_at = NULL,
        published_by = NULL,
        
        updated_at = NOW()
      WHERE id = ?
    `;

      await mysqlConnection.execute(rejectUpdateQuery, [
        // Stage 1
        reviewerId,
        commonNote,
        // Stage 2
        reviewerId,
        commonNote,
        // Stage 3
        reviewerId,
        commonNote,
        // Stage 4
        reviewerId,
        commonNote,
        // Legacy
        reviewerId,
        commonNote,
        // Rejection info
        rejectionReason,
        // Where
        id,
      ]);

      const [updatedPublications] = await mysqlConnection.execute(
        `SELECT mp.*, 
              u.first_name as composer_first_name, 
              u.last_name as composer_last_name,
              u.email as composer_email,
              r.first_name as reviewer_first_name,
              r.last_name as reviewer_last_name,
              r.user_type as reviewer_type
       FROM music_publications mp
       LEFT JOIN users u ON mp.composer_id = u.id
       LEFT JOIN users r ON mp.admin_reviewed_by = r.id
       WHERE mp.id = ?`,
        [id],
      );

      const updatedPublication = updatedPublications[0];

      return successResponse(
        res,
        {
          publication: updatedPublication,
          reviewedBy: {
            id: reviewerId,
            name: reviewerName,
            role: reviewerRole,
          },
          reviewedAt: new Date(),
          allStagesApproved: false,
          decision: "rejected",
          rejectionReason,
          message:
            "Publication rejected by admin. All stages marked as rejected.",
        },
        "Publication rejected successfully",
      );
    } catch (error) {
      console.error("Admin approve/reject error:", error);
      errorResponse(res, "Failed to review publication", 500);
    }
  },
);

// @route   PUT /api/music-publications/:id/admin-reject
// @desc    Admin reject music publication (Admin only)
// @access  Private (Admin/SL Team only)
router.put(
  "/:id/admin-reject",
  [auth, requireAnyRole(["sl_team", "admin"])],
  async (req, res) => {
    try {
      const { id } = req.params;
      const { rejectionReason, reviewNotes } = req.body;
      const reviewerId = req.user.id;
      const mysqlConnection = getMySQLConnection();

      if (!rejectionReason) {
        return errorResponse(res, "Rejection reason is required", 400);
      }

      // Get publication
      const [publications] = await mysqlConnection.execute(
        "SELECT * FROM music_publications WHERE id = ?",
        [id],
      );

      if (publications.length === 0) {
        return errorResponse(res, "Publication not found", 404);
      }

      const publication = publications[0];

      // Check if publication is in onelicense_verification status
      if (publication.status !== "onelicense_verification") {
        return errorResponse(
          res,
          "Publication must be in onelicense_verification status for admin review",
          400,
        );
      }

      // Update publication status to rejected
      const updateFields = [
        "status = ?",
        "rejection_reason = ?",
        "admin_reviewed_by = ?",
        "admin_reviewed_at = NOW()",
        "updated_at = NOW()",
      ];
      const updateValues = ["rejected", rejectionReason, reviewerId];

      if (reviewNotes) {
        updateFields.push("admin_review_notes = ?");
        updateValues.push(reviewNotes);
      }

      updateValues.push(id);

      await mysqlConnection.execute(
        `UPDATE music_publications SET ${updateFields.join(", ")} WHERE id = ?`,
        updateValues,
      );

      // Get updated publication
      const [updatedPublications] = await mysqlConnection.execute(
        `SELECT mp.*, 
              u.first_name as composer_first_name, 
              u.last_name as composer_last_name,
              r.first_name as reviewer_first_name,
              r.last_name as reviewer_last_name
       FROM music_publications mp
       LEFT JOIN users u ON mp.composer_id = u.id
       LEFT JOIN users r ON mp.admin_reviewed_by = r.id
       WHERE mp.id = ?`,
        [id],
      );

      successResponse(
        res,
        {
          publication: updatedPublications[0],
          rejectedBy: reviewerId,
          rejectedAt: new Date(),
          rejectionReason: rejectionReason,
        },
        "Admin rejected publication successfully",
      );
    } catch (error) {
      console.error("Admin reject error:", error);
      errorResponse(res, "Failed to admin reject publication", 500);
    }
  },
);

// @route   POST /api/music-publications/library
// @desc    Create a new library (any authenticated user)
// @access  Private (Any authenticated user)
router.post("/library", auth, async (req, res) => {
  try {
    const { name, description } = req.body;
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Validate required fields
    if (!name) {
      return errorResponse(res, "Library name is required", 400);
    }

    // Check if library with same name already exists for this user
    const [existingLibraries] = await mysqlConnection.execute(
      "SELECT id FROM libraries WHERE user_id = ? AND name = ?",
      [userId, name],
    );

    if (existingLibraries.length > 0) {
      return errorResponse(res, "Library with this name already exists", 400);
    }

    // Create new library
    const [result] = await mysqlConnection.execute(
      "INSERT INTO libraries (user_id, name, description, image_url, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())",
      [userId, name, description || null, null],
    );

    const libraryId = result.insertId;

    // Get created library
    const [libraries] = await mysqlConnection.execute(
      "SELECT * FROM libraries WHERE id = ?",
      [libraryId],
    );

    successResponse(
      res,
      {
        library: libraries[0],
      },
      "Library created successfully",
    );
  } catch (error) {
    console.error("Create library error:", error);
    errorResponse(res, "Failed to create library", 500);
  }
});

// @route   POST /api/music-publications/library/:id/upload-image
// @desc    Upload image for library (any authenticated user)
// @access  Private (Any authenticated user)
router.post(
  "/library/:id/upload-image",
  [auth, libraryImageUpload.single("image")],
  async (req, res) => {
    try {
      const { id: libraryId } = req.params;
      const userId = req.user.id;
      const mysqlConnection = getMySQLConnection();

      // Check if library exists and belongs to user
      const [libraries] = await mysqlConnection.execute(
        "SELECT * FROM libraries WHERE id = ? AND user_id = ?",
        [libraryId, userId],
      );

      if (libraries.length === 0) {
        return errorResponse(res, "Library not found or access denied", 404);
      }

      const library = libraries[0];

      // Check if image was uploaded
      if (!req.file) {
        return errorResponse(res, "No image file provided", 400);
      }

      // Get file size
      const fileSize = await getFileSizeFromS3(req.file.location);

      // Update library with new image URL
      await mysqlConnection.execute(
        "UPDATE libraries SET image_url = ?, updated_at = NOW() WHERE id = ?",
        [req.file.location, libraryId],
      );

      // Get updated library
      const [updatedLibraries] = await mysqlConnection.execute(
        "SELECT * FROM libraries WHERE id = ?",
        [libraryId],
      );

      successResponse(
        res,
        {
          library: updatedLibraries[0],
          image: {
            url: req.file.location,
            size: fileSize,
            originalName: req.file.originalname,
            mimetype: req.file.mimetype,
          },
        },
        "Library image uploaded successfully",
      );
    } catch (error) {
      console.error("Upload library image error:", error);
      errorResponse(res, "Failed to upload library image", 500);
    }
  },
);

// @route   POST /api/music-publications/library/:id/add-music
// @desc    Add own music to library (library owner only)
// @access  Private (Library owner only)
router.post("/library/:id/add-music", auth, async (req, res) => {
  try {
    const { id: libraryId } = req.params;
    const { musicIds } = req.body;
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Validate required fields
    if (!musicIds || !Array.isArray(musicIds) || musicIds.length === 0) {
      return errorResponse(res, "Music IDs array is required", 400);
    }

    // Check if library exists and belongs to user
    const [libraries] = await mysqlConnection.execute(
      "SELECT * FROM libraries WHERE id = ? AND user_id = ?",
      [libraryId, userId],
    );

    if (libraries.length === 0) {
      return errorResponse(res, "Library not found or access denied", 404);
    }

    const library = libraries[0];

    // Check which music publications exist and belong to the user (any status)
    const placeholders = musicIds.map(() => "?").join(",");
    const [musicPublications] = await mysqlConnection.execute(
      `SELECT 
        mp.*,
        u.first_name as composer_first_name,
        u.last_name as composer_last_name,
        u.email as composer_email,
        u.avatar as composer_avatar
      FROM music_publications mp
      LEFT JOIN users u ON mp.composer_id = u.id
      WHERE mp.id IN (${placeholders}) AND mp.composer_id = ?`,
      [...musicIds, userId],
    );

    console.log("Requested music IDs:", musicIds);
    console.log("Found music publications:", musicPublications);

    // Get existing music IDs that belong to the user
    const existingMusicIds = musicPublications.map((mp) => mp.id);
    const nonExistingMusicIds = musicIds.filter(
      (id) => !existingMusicIds.includes(id),
    );

    if (existingMusicIds.length === 0) {
      return errorResponse(
        res,
        "None of the provided music IDs exist or belong to you",
        400,
      );
    }

    // Add existing music to library using junction table
    const addedMusic = [];
    const failedMusic = [];

    for (const musicId of existingMusicIds) {
      try {
        // Check if music is already in this library
        const [existingMusic] = await mysqlConnection.execute(
          "SELECT id FROM library_music WHERE library_id = ? AND music_id = ?",
          [libraryId, musicId],
        );

        if (existingMusic.length > 0) {
          failedMusic.push({ id: musicId, reason: "Already in library" });
          continue;
        }

        // Add music to library using junction table
        await mysqlConnection.execute(
          "INSERT INTO library_music (library_id, music_id) VALUES (?, ?)",
          [libraryId, musicId],
        );

        const music = musicPublications.find((m) => m.id === musicId);
        addedMusic.push({
          id: music.id,
          composition_title: music.composition_title,
          composition_description: music.composition_description,
          composer_first_name: music.composer_firstname,
          composer_last_name: music.composer_lastname,
          vocal_parts: music.vocal_parts
            ? typeof music.vocal_parts === "string"
              ? JSON.parse(music.vocal_parts)
              : music.vocal_parts
            : null,
          instrumentation: music.instrumentation
            ? typeof music.instrumentation === "string"
              ? JSON.parse(music.instrumentation)
              : music.instrumentation
            : null,
          artists: music.artists
            ? typeof music.artists === "string"
              ? JSON.parse(music.artists)
              : music.artists
            : [],
          types_of_music: music.types_of_music,
          first_line_of_composition: music.first_line_of_composition,
          composition_copyrights: music.composition_copyrights
            ? typeof music.composition_copyrights === "string"
              ? JSON.parse(music.composition_copyrights)
              : music.composition_copyrights
            : [],
          song_type: music.song_type,
          meter: music.meter,
          season: music.season,
          psalm_number: music.psalm_number,
          text_copyright_notice: music.text_copyright_notice,
          tune_copyright_notice: music.tune_copyright_notice,
          musicFiles: music.music_files ? JSON.parse(music.music_files) : [],
          artwork_file_url: music.artwork_file_url,
          artwork_file_size: music.artwork_file_size,
          status: music.status,
          composer_id: music.composer_id,
          composer_first_name: music.composer_first_name,
          composer_last_name: music.composer_last_name,
          composer_email: music.composer_email,
          composer_avatar: music.composer_avatar,
          created_at: music.created_at,
          updated_at: music.updated_at,
        });
      } catch (error) {
        console.error(`Failed to add music ${musicId}:`, error.message);
        failedMusic.push({
          id: musicId,
          reason: `Failed to add: ${error.message}`,
        });
      }
    }

    // Prepare response message
    let message = `Added ${addedMusic.length} music to library successfully`;
    if (nonExistingMusicIds.length > 0) {
      message += `. Skipped ${nonExistingMusicIds.length} non-existing music IDs: [${nonExistingMusicIds.join(", ")}]`;
    }
    if (failedMusic.length > 0) {
      message += `. ${failedMusic.length} music failed to add`;
    }

    successResponse(
      res,
      {
        library: {
          id: library.id,
          name: library.name,
          description: library.description,
        },
        addedMusic,
        failedMusic,
        nonExistingMusicIds: nonExistingMusicIds,
        summary: {
          requested: musicIds.length,
          added: addedMusic.length,
          failed: failedMusic.length,
          nonExisting: nonExistingMusicIds.length,
        },
      },
      message,
    );
  } catch (error) {
    console.error("Add music to library error:", error);
    errorResponse(res, "Failed to add music to library", 500);
  }
});

// @route   GET /api/music-publications/library/:id
// @desc    Get library with its music (any authenticated user)
// @access  Private (Any authenticated user)
router.get("/library/:id", auth, async (req, res) => {
  try {
    const { id: libraryId } = req.params;
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Get library details
    const [libraries] = await mysqlConnection.execute(
      "SELECT * FROM libraries WHERE id = ? AND user_id = ?",
      [libraryId, userId],
    );

    if (libraries.length === 0) {
      return errorResponse(res, "Library not found or access denied", 404);
    }

    const library = libraries[0];

    // Get music in this library using junction table with complete details
    const [musicPublications] = await mysqlConnection.execute(
      `SELECT 
        mp.id,
        mp.composition_title,
        mp.composition_description,
        mp.composer_firstname,
        mp.composer_lastname,
        mp.vocal_parts,
        mp.instrumentation,
        mp.types_of_music,
        mp.first_line_of_composition,
        mp.composition_copyrights,
        mp.mass_setting_parts,
        mp.song_type,
        mp.meter,
        mp.season,
        mp.psalm_number,
        mp.text_copyright_notice,
        mp.tune_copyright_notice,
        mp.artists,
        mp.music_files,
        mp.artwork_file_url,
        mp.artwork_file_size,
        mp.status,
        mp.published_at,
        mp.created_at,
        u.id as composer_id,
        u.first_name,
        u.last_name,
        u.email as composer_email,
        u.avatar as composer_avatar,
        lm.added_at
       FROM music_publications mp 
       JOIN users u ON mp.composer_id = u.id 
       JOIN library_music lm ON mp.id = lm.music_id
       WHERE lm.library_id = ?
       ORDER BY lm.added_at DESC`,
      [libraryId],
    );

    // Format music publications with complete details
    const formattedMusic = musicPublications.map((music) => ({
      id: music.id,
      compositionTitle: music.composition_title,
      compositionDescription: music.composition_description,
      composerFirstName: music.composer_firstname,
      composerLastName: music.composer_lastname,
      vocalParts: music.vocal_parts
        ? typeof music.vocal_parts === "string"
          ? JSON.parse(music.vocal_parts)
          : music.vocal_parts
        : null,
      instrumentation: music.instrumentation
        ? typeof music.instrumentation === "string"
          ? JSON.parse(music.instrumentation)
          : music.instrumentation
        : null,
      artists: music.artists
        ? typeof music.artists === "string"
          ? JSON.parse(music.artists)
          : music.artists
        : [],
      typesOfMusic: music.types_of_music,
      firstLineOfComposition: music.first_line_of_composition,
      compositionCopyrightYear: music.composition_copyright_year,
      compositionCopyrightName: music.composition_copyright_name,
      songType: music.song_type,
      meter: music.meter,
      season: music.season,
      psalmNumber: music.psalm_number,
      textCopyrightNotice: music.text_copyright_notice,
      tuneCopyrightNotice: music.tune_copyright_notice,
      musicFiles: music.music_files ? JSON.parse(music.music_files) : [],
      artworkFileUrl: music.artwork_file_url,
      artworkFileSize: music.artwork_file_size,
      status: music.status,
      publishedAt: music.published_at,
      createdAt: music.created_at,
      addedToLibraryAt: music.added_at,
      composer: {
        id: music.composer_id,
        firstName: music.first_name,
        lastName: music.last_name,
        fullName: `${music.first_name} ${music.last_name}`,
        email: music.composer_email,
        avatar: music.composer_avatar,
      },
    }));

    successResponse(
      res,
      {
        library: {
          id: library.id,
          name: library.name,
          description: library.description,
          imageUrl: library.image_url,
          createdAt: library.created_at,
          updatedAt: library.updated_at,
        },
        music: formattedMusic,
        musicCount: formattedMusic.length,
      },
      "Library retrieved successfully",
    );
  } catch (error) {
    console.error("Get library error:", error);
    errorResponse(res, "Failed to get library", 500);
  }
});

// @route   GET /api/music-publications/libraries
// @desc    Get user's libraries (any authenticated user)
// @access  Private (Any authenticated user)
router.get("/libraries", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Get user's libraries with music count using junction table
    const [libraries] = await mysqlConnection.execute(
      `SELECT 
        l.id,
        l.name,
        l.description,
        l.image_url,
        l.created_at,
        l.updated_at,
        COUNT(lm.music_id) as music_count
       FROM libraries l 
       LEFT JOIN library_music lm ON l.id = lm.library_id
       WHERE l.user_id = ?
       GROUP BY l.id
       ORDER BY l.created_at DESC`,
      [userId],
    );

    successResponse(
      res,
      {
        libraries: libraries.map((lib) => ({
          id: lib.id,
          name: lib.name,
          description: lib.description,
          imageUrl: lib.image_url,
          musicCount: lib.music_count,
          createdAt: lib.created_at,
          updatedAt: lib.updated_at,
        })),
        totalLibraries: libraries.length,
      },
      "Libraries retrieved successfully",
    );
  } catch (error) {
    console.error("Get libraries error:", error);
    errorResponse(res, "Failed to get libraries", 500);
  }
});

// @route   PUT /api/music-publications/library/:id
// @desc    Update library details (any authenticated user)
// @access  Private (Any authenticated user)
router.put("/library/:id", auth, async (req, res) => {
  try {
    const { id: libraryId } = req.params;

    // Debug: Log the request body to see what's being received
    console.log("PUT /library/:id - Request body:", req.body);
    console.log("PUT /library/:id - Content-Type:", req.get("Content-Type"));

    // Handle both JSON and form-data
    let name, description;

    if (req.body.name) {
      // JSON format
      name = req.body.name;
      description = req.body.description;
    } else if (req.body["name"]) {
      // Form-data format
      name = req.body["name"];
      description = req.body["description"];
    } else {
      // Try to get from different possible formats
      const bodyKeys = Object.keys(req.body);
      console.log("Available body keys:", bodyKeys);

      if (bodyKeys.length > 0) {
        name = req.body[bodyKeys[0]];
        description = req.body[bodyKeys[1]] || null;
      } else {
        return errorResponse(res, "Library name is required", 400);
      }
    }

    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Check if library exists and belongs to user
    const [libraries] = await mysqlConnection.execute(
      "SELECT * FROM libraries WHERE id = ? AND user_id = ?",
      [libraryId, userId],
    );

    if (libraries.length === 0) {
      return errorResponse(res, "Library not found or access denied", 404);
    }

    const library = libraries[0];

    // Validate required fields
    if (!name) {
      return errorResponse(res, "Library name is required", 400);
    }

    // Check if library with same name already exists for this user (excluding current library)
    const [existingLibraries] = await mysqlConnection.execute(
      "SELECT id FROM libraries WHERE user_id = ? AND name = ? AND id != ?",
      [userId, name, libraryId],
    );

    if (existingLibraries.length > 0) {
      return errorResponse(res, "Library with this name already exists", 400);
    }

    // Update library
    await mysqlConnection.execute(
      "UPDATE libraries SET name = ?, description = ?, updated_at = NOW() WHERE id = ?",
      [name, description || null, libraryId],
    );

    // Get updated library
    const [updatedLibraries] = await mysqlConnection.execute(
      "SELECT * FROM libraries WHERE id = ?",
      [libraryId],
    );

    successResponse(
      res,
      {
        library: {
          id: updatedLibraries[0].id,
          name: updatedLibraries[0].name,
          description: updatedLibraries[0].description,
          imageUrl: updatedLibraries[0].image_url,
          createdAt: updatedLibraries[0].created_at,
          updatedAt: updatedLibraries[0].updated_at,
        },
      },
      "Library updated successfully",
    );
  } catch (error) {
    console.error("Update library error:", error);
    errorResponse(res, "Failed to update library", 500);
  }
});

// @route   DELETE /api/music-publications/library/:id
// @desc    Delete library and all its music associations (any authenticated user)
// @access  Private (Any authenticated user)
router.delete("/library/:id", auth, async (req, res) => {
  try {
    const { id: libraryId } = req.params;
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Check if library exists and belongs to user
    const [libraries] = await mysqlConnection.execute(
      "SELECT * FROM libraries WHERE id = ? AND user_id = ?",
      [libraryId, userId],
    );

    if (libraries.length === 0) {
      return errorResponse(res, "Library not found or access denied", 404);
    }

    const library = libraries[0];

    // Get music count in this library
    const [musicCount] = await mysqlConnection.execute(
      "SELECT COUNT(*) as count FROM library_music WHERE library_id = ?",
      [libraryId],
    );

    // Delete all music associations from this library (cascade will handle this)
    await mysqlConnection.execute(
      "DELETE FROM library_music WHERE library_id = ?",
      [libraryId],
    );

    // Delete the library
    await mysqlConnection.execute("DELETE FROM libraries WHERE id = ?", [
      libraryId,
    ]);

    successResponse(
      res,
      {
        deletedLibrary: {
          id: library.id,
          name: library.name,
          description: library.description,
          imageUrl: library.image_url,
        },
        removedMusicCount: musicCount[0].count,
      },
      `Library "${library.name}" deleted successfully. ${musicCount[0].count} music items removed from library.`,
    );
  } catch (error) {
    console.error("Delete library error:", error);
    errorResponse(res, "Failed to delete library", 500);
  }
});

// @route   GET /api/music-publications/one-license-excel/info
// @desc    Get OneLicense Excel file info (SL Team only)
// @access  Private (SL Team only)
router.get(
  "/one-license-excel/info",
  [auth, requireAnyRole(["sl_team"])],
  async (req, res) => {
    try {
      const exportsDir = path.join(__dirname, "../exports");
      const fileName = "one_license_info.xlsx";
      const filePath = path.join(exportsDir, fileName);

      // Check if file exists
      if (!fs.existsSync(filePath)) {
        return successResponse(
          res,
          {
            exists: false,
            fileName: fileName,
            totalRecords: 0,
            fileSize: 0,
            lastModified: null,
          },
          "Excel file not found. No publications have been approved yet.",
        );
      }

      // Get file stats
      const fileStats = fs.statSync(filePath);

      // Read file to get record count
      let totalRecords = 0;
      try {
        const workbook = XLSX.readFile(filePath);
        const worksheet = workbook.Sheets["OneLicense Info"];
        if (worksheet) {
          const data = XLSX.utils.sheet_to_json(worksheet);
          totalRecords = data.length;
        }
      } catch (readError) {
        console.error("Error reading Excel file for info:", readError);
      }

      return successResponse(
        res,
        {
          exists: true,
          fileName: fileName,
          totalRecords: totalRecords,
          fileSize: fileStats.size,
          lastModified: fileStats.mtime,
          downloadUrl: "/api/music-publications/one-license-excel",
        },
        "Excel file info retrieved successfully",
      );
    } catch (error) {
      console.error("Get Excel info error:", error);
      errorResponse(res, "Failed to get Excel file info", 500);
    }
  },
);

// @route   GET /api/music-publications/one-license-excel
// @desc    Download OneLicense Info Excel file (SL Team only)
// @access  Private (SL Team only)
router.get("/one-license-excel", async (req, res) => {
  try {
    const exportsDir = path.join(__dirname, "../exports");
    const fileName = "one_license_info.xlsx";
    const filePath = path.join(exportsDir, fileName);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return errorResponse(
        res,
        "Excel file not found. No publications have been approved yet.",
        404,
      );
    }

    // Read file
    const fileBuffer = fs.readFileSync(filePath);

    // Set headers for file download (OneLicense compatible format)
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Length", fileBuffer.length);

    // Send file
    res.send(fileBuffer);
  } catch (error) {
    console.error("Download Excel error:", error);
    errorResponse(res, "Failed to download Excel file", 500);
  }
});

/**
 * @route   GET /api/music-publications/one-license-info/info
 * @desc    Get information about the Excel file (without downloading)
 * @access  Private (Admin, SL Team, Director of SLC)
 */
router.get("/one-license-info/info", [auth], async (req, res) => {
  try {
    const userType = req.user?.user_type || req.user?.userType;
    const role = req.user?.role;

    // // Check authorization
    // if (!(role === 'sl_team')) {
    //   return res.status(403).json({
    //     success: false,
    //     message: 'Forbidden: You do not have permission to access this information'
    //   });
    // }

    // Define file path
    const exportsDir = path.join(__dirname, "../exports");
    const fileName = "one_license_info.xlsx";
    const filePath = path.join(exportsDir, fileName);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: "Excel file not found",
        fileExists: false,
      });
    }

    // Get file stats
    const stats = fs.statSync(filePath);

    // Read Excel file to get row count
    const XLSX = require("xlsx");
    let rowCount = 0;
    try {
      const workbook = XLSX.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(worksheet);
      rowCount = data.length;
    } catch (readError) {
      console.error("Error reading Excel file for info:", readError);
    }

    res.json({
      success: true,
      data: {
        fileName: fileName,
        fileExists: true,
        fileSize: stats.size,
        fileSizeFormatted: formatFileSize(stats.size),
        lastModified: stats.mtime,
        recordCount: rowCount,
        downloadUrl: "/api/exports/one-license-info",
      },
    });
  } catch (error) {
    console.error("Get Excel file info error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get file information",
      error: error.message,
    });
  }
});

// Helper function to format file size
function formatFileSize(bytes) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

// @route   GET /api/music-publications/admin/published
// @desc    Get all published music compositions (Admin/Superadmin only)
// @access  Private (Admin/Superadmin only)
router.get("/admin/published", [auth], async (req, res) => {
  try {
    const userId = req.user.id;
    const userType = req.user.user_type;
    const mysqlConnection = getMySQLConnection();

    // Check if user is admin or superadmin
    if (userType !== "admin" && userType !== "superadmin") {
      return errorResponse(
        res,
        "Access denied. Only admin or superadmin can access published compositions.",
        403,
      );
    }

    // Get all published music compositions
    const [publications] = await mysqlConnection.execute(
      `SELECT 
        mp.*,
        u.id as composer_user_id,
        u.first_name,
        u.last_name,
        u.email as composer_email,
        u.avatar as composer_avatar
       FROM music_publications mp 
       JOIN users u ON mp.composer_id = u.id 
       WHERE mp.status = 'published' 
       AND (mp.scheduled_deletion_at IS NULL OR mp.scheduled_deletion_at > NOW())
       ORDER BY mp.published_at DESC, mp.created_at DESC`,
    );

    // Format publications using the existing formatMusicPublication helper
    const formattedPublications = publications.map((pub) =>
      formatMusicPublication(pub),
    );

    successResponse(
      res,
      {
        publications: formattedPublications,
      },
      "Published music compositions retrieved successfully",
    );
  } catch (error) {
    console.error("Admin get published music error:", error);
    errorResponse(res, "Failed to get published music compositions", 500);
  }
});

// @route   PUT /api/music-publications/:id/admin-edit
// @desc    Edit published music composition (Admin/Superadmin/Music Publication Team/Director of SLC only)
// @access  Private (Admin/Superadmin/Music Publication Team/Director of SLC only)
// dir of slc
router.put("/:id/admin-edit", [auth], async (req, res) => {
  try {
    const publicationId = req.params.id;
    const mysqlConnection = getMySQLConnection();

    const [rows] = await mysqlConnection.execute(
      "SELECT id,status FROM music_publications WHERE id=?",
      [publicationId]
    );

    if (!rows.length) {
      return errorResponse(res, "Publication not found", 404);
    }

    if (rows[0].status !== "published") {
      return errorResponse(res, "Only published music can be edited", 400);
    }

    const body = req.body;

    /* ------------------------------------------------ */
    /* FIELD MAPPING                                    */
    /* ------------------------------------------------ */

    const fieldMap = {
      composer_id: "composer_id",
      composerFirstName: "composer_firstname",
      composerLastName: "composer_lastname",
      compositionTitle: "composition_title",
      compositionDescription: "composition_description",

      isPartOfCollection: "is_part_of_collection",
      collectionId: "collection_id",
      collectionName: "collection_name",

      vocalParts: "vocal_parts",
      instrumentation: "instrumentation",
      typesOfMusic: "types_of_music",

      liturgicalText: "liturgicalText",
      verseStyle: "verseStyle",
      feast: "feast",

      massSettingParts: "mass_setting_parts",

      compositionTitle1: "composition_title_1",
      firstLineOfComposition: "first_line_of_composition",

      compositionCopyrights: "composition_copyrights",

      songType: "song_type",
      musicVideoLink: "music_video_link",

      language: "language",

      meter: "meter",
      season: "season",
      psalmNumber: "psalm_number",

      tune: "tune",
      generalDetails: "general_details",
      countryRestrictions: "country_restrictions",

      isPublicDomain: "is_public_domain",
      canBeReprinted: "can_be_reprinted",
      canBePodcastStreamed: "can_be_podcast_streamed",
      canMakeCommercialRecording: "can_make_commercial_recording",
      canMakeNonCommercialRecording: "can_make_non_commercial_recording",

      artists: "artists",
      musicFiles: "music_files",

      artworkFileUrl: "artwork_file_url",
      artworkFileSize: "artwork_file_size",
      theme: "theme",
      partOfMass: "partOfMass",
      liturgicalSacrament: "liturgicalSacrament"
    };

    const jsonColumns = [
      "vocal_parts",
      "instrumentation",
      "artists",
      "music_files",
      "composition_copyrights",
      "language",
      "feast",
      "verseStyle",
      "liturgicalText",
      "mass_setting_parts",
      "partOfMass",
      "theme"
    ];

    const updateFields = [];
    const updateValues = [];

    /* ------------------------------------------------ */
    /* BUILD UPDATE                                     */
    /* ------------------------------------------------ */

    for (const key in fieldMap) {
      const column = fieldMap[key];
      let value = body[key];

      if (value === undefined) continue;

      /* convert empty string → null */
      if (value === "") value = null;

      /* boolean → 0/1 */
      if (typeof value === "boolean") {
        value = value ? 1 : 0;
      }

      /* JSON fields */
      if (jsonColumns.includes(column)) {
        if (value !== null) {
          value = JSON.stringify(value);
        }
      }

      updateFields.push(`${column}=?`);
      updateValues.push(value);
    }

    /* ------------------------------------------------ */
    /* PRICE FIX                                        */
    /* ------------------------------------------------ */

    if (body.price !== undefined) {
      let price = body.price;

      if (typeof price === "string") {
        price = price.replace(/[^0-9.]/g, "");
      }

      price = parseFloat(price);

      if (isNaN(price)) price = 0;

      updateFields.push("price=?");
      updateValues.push(price);
    }

    if (body.composer_id !== undefined) {
      const [[composer]] = await mysqlConnection.execute(
        "SELECT id FROM users WHERE id=?",
        [body.composer_id]
      );
      if (!composer) {
        return errorResponse(res, "Composer not found", 404);
      }
    }
    /* ------------------------------------------------ */
    /* FINAL SQL                                        */
    /* ------------------------------------------------ */

    if (!updateFields.length) {
      return errorResponse(res, "No fields provided", 400);
    }

    updateFields.push("updated_at=NOW()");

    const sql = `
      UPDATE music_publications
      SET ${updateFields.join(",")}
      WHERE id=?
    `;

    updateValues.push(publicationId);

    console.log("FIELDS:", updateFields.length);
    console.log("VALUES:", updateValues.length);
    console.log(updateValues);

    await mysqlConnection.execute(sql, updateValues);

    /* ------------------------------------------------ */
    /* FETCH UPDATED RECORD                             */
    /* ------------------------------------------------ */

    const [updated] = await mysqlConnection.execute(
      "SELECT * FROM music_publications WHERE id=?",
      [publicationId]
    );

    return successResponse(
      res,
      {
        publication: updated[0],
        editedBy: req.user.id,
        editedAt: new Date().toISOString()
      },
      "Music updated successfully"
    );

  } catch (err) {
    console.error("Admin edit error:", err);
    return errorResponse(res, err.message, 500);
  }
});

// @route   GET /api/music-publications/admin/published/:id
// @desc    Get single published music composition by ID (Admin/Superadmin only)
// @access  Private (Admin/Superadmin only)
router.get("/admin/published/:id", [auth], async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const userType = req.user.user_type;
    const mysqlConnection = getMySQLConnection();

    // Check if user is admin or superadmin
    if (userType !== "admin" && userType !== "superadmin") {
      return errorResponse(
        res,
        "Access denied. Only admin or superadmin can access published compositions.",
        403,
      );
    }

    // Get publication
    const [publications] = await mysqlConnection.execute(
      `SELECT 
        mp.*,
        u.id as composer_user_id,
        u.first_name,
        u.last_name,
        u.email as composer_email,
        u.avatar as composer_avatar
       FROM music_publications mp 
       JOIN users u ON mp.composer_id = u.id 
       WHERE mp.id = ? AND mp.status = 'published' 
       AND (mp.scheduled_deletion_at IS NULL OR mp.scheduled_deletion_at > NOW())`,
      [id],
    );

    if (publications.length === 0) {
      return errorResponse(res, "Published music composition not found", 404);
    }

    const publication = formatMusicPublication(publications[0]);

    successResponse(
      res,
      {
        publication,
      },
      "Published music composition retrieved successfully",
    );
  } catch (error) {
    console.error("Admin get published music by ID error:", error);
    errorResponse(res, "Failed to get published music composition", 500);
  }
});

module.exports = router;