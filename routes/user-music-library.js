const express = require('express');
const { getMySQLConnection } = require('../config/mysql');
const { auth } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');
const { stripe, createStripeCustomer } = require('../config/stripe');
const { validateAndApplyCoupon, markCouponAsUsed, getSafeFileType } = require('../utils/couponUtils')
const { sendEmail } = require("../utils/SendMailer");

const router = express.Router();

// Safe JSON parse helper for DB fields that may contain non-JSON strings
function parseJsonSafe(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

router.get("/check", async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    const [rows] = await mysqlConnection.execute(
      "SELECT id, composition_title, music_files FROM music_publications WHERE status = 'published'"
    );

    let totalPdfFiles = 0;
    let missingSampleThumbnail = 0;
    let generatedSampleThumbnail = 0;
    let invalidData = 0;

    const publications = [];

    for (const row of rows) {
      if (!row.music_files) continue;

      let musicFiles;

      try {
        musicFiles =
          typeof row.music_files === "string"
            ? JSON.parse(row.music_files)
            : row.music_files;
      } catch (err) {
        invalidData++;
        continue;
      }

      if (!Array.isArray(musicFiles)) continue;

      const report = {
        id: row.id,
        compositionTitle: row.composition_title,
        totalPdfFiles: 0,
        generatedSampleThumbnails: 0,
        missingSampleThumbnails: 0,
        generatedFiles: [],
        missingFiles: [],
      };

      for (const file of musicFiles) {
        // Sirf PDF files check karo
        if (file.fileType !== "application/pdf") continue;

        totalPdfFiles++;
        report.totalPdfFiles++;

        const fileInfo = {
          fileName: file.fileName,
          pdfDesignation: file.pdfDesignation || "",
        };

        if (
          file.sampleThumbnailUrl == null &&
          file.sampleThumbnailGenerated === false
        ) {
          missingSampleThumbnail++;
          report.missingSampleThumbnails++;
          report.missingFiles.push(fileInfo);
        } else if (
          file.sampleThumbnailUrl &&
          file.sampleThumbnailGenerated === true
        ) {
          generatedSampleThumbnail++;
          report.generatedSampleThumbnails++;
          report.generatedFiles.push(fileInfo);
        }
      }

      // Sirf publications jisme PDF files hain
      if (report.totalPdfFiles > 0) {
        publications.push(report);
      }
    }

    // Optional: Missing thumbnails wale publications pehle dikhao
    publications.sort(
      (a, b) => b.missingSampleThumbnails - a.missingSampleThumbnails
    );

    return successResponse(
      res,
      {
        summary: {
          totalPublications: rows.length,
          totalPdfFiles,
          generatedSampleThumbnail,
          missingSampleThumbnail,
          invalidData,
        },
        publications,
      },
      "Music files analysis completed."
    );
  } catch (error) {
    console.error(error);
    return errorResponse(res, "Something went wrong", 500);
  }
});

router.get('/my-music', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    const userId = req.user.id;
    const userType = req.user.user_type;
    const parentUserId = req.user.parent_user_id;

    /* ==========================================
       🔥 STEP 1: ALLOWED USER IDS
    ========================================== */

    let allowedUserIds = [userId];

    if ((userType === 'sub_user' || userType === 'manager') && parentUserId) {
      allowedUserIds.push(parentUserId);
    }

    console.log('✅ Allowed User IDs:', allowedUserIds);

    if (!allowedUserIds.length) {
      return successResponse(res, {
        music: [],
        totalCount: 0
      });
    }

    /* ==========================================
       🔥 STEP 2: FIX MYSQL IN CLAUSE
    ========================================== */

    const placeholders = allowedUserIds.map(() => '?').join(',');

    /* ==========================================
       🔥 STEP 3: QUERY
    ========================================== */

    const [musicLibrary] = await mysqlConnection.execute(`
      SELECT
        uml.*,

        mp.published_at,
        mp.language AS mp_language,
        mp.created_at AS music_created_at,

        mp.composition_title AS mp_composition_title,
        mp.composition_title_1 AS mp_composition_title_1,
        mp.composition_description AS mp_composition_description,
        mp.composer_firstname AS mp_composer_firstname,
        mp.composer_lastname AS mp_composer_lastname,
        mp.is_part_of_collection AS mp_is_part_of_collection,
        mp.collection_id AS mp_collection_id,
        mp.collection_name AS mp_collection_name,
        mp.vocal_parts AS mp_vocal_parts,
        mp.instrumentation AS mp_instrumentation,
        mp.types_of_music AS mp_types_of_music,
        mp.first_line_of_composition AS mp_first_line_of_composition,
        mp.composition_copyrights AS mp_composition_copyrights,
        mp.song_type AS mp_song_type,
        mp.meter AS mp_meter,
        mp.season AS mp_season,
        mp.psalm_number AS mp_psalm_number,
        mp.liturgicalText AS mp_liturgicalText,
        mp.verseStyle AS mp_verseStyle,
        mp.feast AS mp_feast,
        mp.text_copyright_notice AS mp_text_copyright_notice,
        mp.tune_copyright_notice AS mp_tune_copyright_notice,
        mp.artists AS mp_artists,
        mp.music_files AS mp_music_files,
        mp.music_video_link AS mp_music_video_link,
        mp.artwork_file_url AS mp_artwork_file_url,
        mp.artwork_file_size AS mp_artwork_file_size,
        mp.tune AS mp_tune,
        mp.general_details AS mp_general_details,
        mp.country_restrictions AS mp_country_restrictions,
        mp.is_public_domain AS mp_is_public_domain,
        mp.can_be_reprinted AS mp_can_be_reprinted,
        mp.can_be_podcast_streamed AS mp_can_be_podcast_streamed,
        mp.can_make_commercial_recording AS mp_can_make_commercial_recording,
        mp.can_make_non_commercial_recording AS mp_can_make_non_commercial_recording,

        u.publisherName AS composer_publisher_name,
        u.website_url AS composer_website,
        u.twitter_url AS composer_twitter,
        u.country AS composer_country

      FROM user_music_library uml

      LEFT JOIN music_publications mp
        ON uml.music_publication_id = mp.id

      LEFT JOIN users u
        ON uml.composer_id = u.id

      WHERE uml.user_id IN (${placeholders})
      ORDER BY uml.purchase_date DESC
    `, allowedUserIds);

    /* ==========================================
       🔥 STEP 4: HELPERS
    ========================================== */

    const parseJSON = (data, fallback = null) => {
      if (!data) return fallback;
      if (typeof data === 'object') return data;
      try { return JSON.parse(data); } catch { return fallback; }
    };

    const fallback = (umlVal, mpVal) => {
      if (!umlVal || umlVal === '') return mpVal ?? null;
      if (Array.isArray(umlVal) && umlVal.length === 0) return mpVal ?? umlVal;
      return umlVal;
    };

    const jsonFallback = (umlRaw, mpRaw, def = null) => {
      const parsed = parseJSON(umlRaw, null);
      if (!parsed || (Array.isArray(parsed) && parsed.length === 0)) {
        return parseJSON(mpRaw, def);
      }
      return parsed;
    };

    /* ==========================================
       🔥 STEP 5: FORMAT RESPONSE
    ========================================== */

    const formattedMusic = musicLibrary.map(music => ({

      // ── Basic Info ─────────────────────────────────────────
      id: music.id,
      musicId: `#${music.music_publication_id.toString().padStart(8, '0')}`,
      musicPublicationId: music.music_publication_id,

      // ── Purchase Info ──────────────────────────────────────
      fileType: music.file_type,
      fileName: music.file_name,
      fileUrl: music.file_url,
      fileSize: music.file_size,
      price: parseFloat(music.price),
      purchaseDate: music.purchase_date,
      downloadCount: music.download_count,
      lastDownloaded: music.last_downloaded,

      // ── Composition Information ─────────────────────────────
      composerId: music.composer_id,

      compositionTitle: fallback(music.composition_title, music.mp_composition_title),

      compositionTitle1: fallback(music.composition_title_1, music.mp_composition_title_1),

      compositionDescription: fallback(
        music.composition_description,
        music.mp_composition_description
      ),

      composerFirstname: fallback(music.composer_firstname, music.mp_composer_firstname),

      composerLastname: fallback(music.composer_lastname, music.mp_composer_lastname),

      publisherName: music.composer_publisher_name,  // live from users table


      composerFullName: (() => {
        const fn = fallback(music.composer_firstname, music.mp_composer_firstname);
        const ln = fallback(music.composer_lastname, music.mp_composer_lastname);
        return (fn || ln) ? `${fn || ''} ${ln || ''}`.trim() : null;
      })(),

      // ── Collection Information ──────────────────────────────
      isPartOfCollection: fallback(music.is_part_of_collection, music.mp_is_part_of_collection),
      collectionId: fallback(music.collection_id, music.mp_collection_id),
      collectionName: fallback(music.collection_name, music.mp_collection_name),

      // ── Music Details ───────────────────────────────────────
      vocalParts: jsonFallback(music.vocal_parts, music.mp_vocal_parts, []),
      instrumentation: jsonFallback(music.instrumentation, music.mp_instrumentation, []),
      typesOfMusic: fallback(music.types_of_music, music.mp_types_of_music),

      // ── OneLicense Information ──────────────────────────────
      firstLineOfComposition: fallback(
        music.first_line_of_composition,
        music.mp_first_line_of_composition
      ),
      compositionCopyrights: jsonFallback(
        music.composition_copyrights,
        music.mp_composition_copyrights,
        []
      ),
      songType: fallback(music.song_type, music.mp_song_type),
      meter: fallback(music.meter, music.mp_meter),
      season: fallback(music.season, music.mp_season),
      psalmNumber: fallback(music.psalm_number, music.mp_psalm_number),
      liturgicalText: fallback(music.liturgicalText, music.mp_liturgicalText),
      verseStyle: fallback(music.verseStyle, music.mp_verseStyle),
      feast: fallback(music.feast, music.mp_feast),

      // ── Copyright Details ───────────────────────────────────
      textCopyrightNotice: fallback(
        music.text_copyright_notice,
        music.mp_text_copyright_notice
      ),
      tuneCopyrightNotice: fallback(
        music.tune_copyright_notice,
        music.mp_tune_copyright_notice
      ),

      // ── Artist Details ──────────────────────────────────────
      artists: jsonFallback(music.artists, music.mp_artists, []),

      // ── All Files ───────────────────────────────────────────
      musicFiles: jsonFallback(music.music_files, music.mp_music_files, []),
      musicVideoLink: fallback(music.music_video_link, music.mp_music_video_link),
      artworkFileUrl: fallback(music.artwork_file_url, music.mp_artwork_file_url),
      artworkFileSize: fallback(music.artwork_file_size, music.mp_artwork_file_size),

      // ── General Details ─────────────────────────────────────
      tune: fallback(music.tune, music.mp_tune),
      generalDetails: fallback(music.general_details, music.mp_general_details),
      countryRestrictions: fallback(music.country_restrictions, music.mp_country_restrictions),

      // Language:
      language: jsonFallback(music.publication_language, music.mp_language, []),

      // ── Usage Permissions ───────────────────────────────────
      isPublicDomain: fallback(music.is_public_domain, music.mp_is_public_domain),
      canBeReprinted: fallback(music.can_be_reprinted, music.mp_can_be_reprinted),
      canBePodcastStreamed: fallback(
        music.can_be_podcast_streamed,
        music.mp_can_be_podcast_streamed
      ),
      canMakeCommercialRecording: fallback(
        music.can_make_commercial_recording,
        music.mp_can_make_commercial_recording
      ),
      canMakeNonCommercialRecording: fallback(
        music.can_make_non_commercial_recording,
        music.mp_can_make_non_commercial_recording
      ),

      // ── Composer Social / Location (live from users table) ──
      composerWebsite: music.composer_website,
      composerTwitter: music.composer_twitter,
      composerCountry: music.composer_country,

      // ── Timestamps ──────────────────────────────────────────
      publishedAt: music.published_at,
      musicCreatedAt: music.music_created_at,
      createdAt: music.created_at,
      updatedAt: music.updated_at,

      source: 'My Music'
    }));

    /* ==========================================
       ✅ FINAL RESPONSE
    ========================================== */

    return successResponse(res, {
      music: formattedMusic,
      totalCount: formattedMusic.length
    });

  } catch (error) {
    console.error('Get user music library error:', error);

    return errorResponse(res, 'Failed to get user music library', 500);
  }
});

router.post('/purchase-file', auth, async (req, res) => {
  try {
    const { musicPublicationId } = req.body;
    const currentUserId = req.user.id;
    const userType = req.user.user_type;
    const parentUserId = req.user.parent_user_id;

    /* ==========================================
       🔥 STEP 1: FINAL USER ID (MAIN FIX)
    ========================================== */

    let finalUserId = currentUserId;

    if ((userType === 'sub_user' || userType === 'manager') && parentUserId) {
      finalUserId = parentUserId;
    }

    console.log("✅ Purchase will be saved for user:", finalUserId);

    const mysqlConnection = getMySQLConnection();

    // Validate required fields
    if (!musicPublicationId) {
      return errorResponse(res, 'Missing required field: musicPublicationId', 400);
    }

    // Get complete music publication details
    const [musicPublications] = await mysqlConnection.execute(
      `SELECT * FROM music_publications WHERE id = ? AND status = 'published'`,
      [musicPublicationId]
    );

    if (musicPublications.length === 0) {
      return errorResponse(res, 'Music publication not found or not published', 404);
    }

    const musicPublication = musicPublications[0];

    // Check if user already has this music publication
    const [existingFiles] = await mysqlConnection.execute(
      'SELECT id FROM user_music_library WHERE user_id = ? AND music_publication_id = ?',
      [finalUserId, musicPublicationId]
    );

    if (existingFiles.length > 0) {
      return errorResponse(res, 'You already own this music publication', 400);
    }

    // Parse music_files JSON to get file details
    let musicFiles = [];
    try {
      musicFiles = musicPublication.music_files ? JSON.parse(musicPublication.music_files) : [];
    } catch (e) {
      musicFiles = musicPublication.music_files || [];
    }

    // Get primary file details (first file or default values)
    const primaryFile = musicFiles.length > 0 ? musicFiles[0] : {};
    const fileName = primaryFile.fileName || musicPublication.composition_title || 'music-file';
    const fileUrl = primaryFile.fileUrl || primaryFile.url || '';
    const fileSize = primaryFile.fileSize || primaryFile.size || null;

    // Validate and set file type (must be one of the ENUM values)
    const validFileTypes = ['assembly', 'octavo', 'chords', 'music_lyrics', 'mp3', 'pdf', 'music'];
    let fileType = primaryFile.fileType || primaryFile.type || 'music';

    // Ensure fileType is valid, default to 'music' if not
    if (!validFileTypes.includes(fileType)) {
      fileType = 'music';
    }

    // Purchase the music publication with complete data
    const price = parseFloat(musicPublication.price) || 7.50;

    // Helper to safely stringify JSON
    const safeStringify = (data) => {
      if (!data) return null;
      if (typeof data === 'string') return data;
      return JSON.stringify(data);
    };

    const [result] = await mysqlConnection.execute(
      `INSERT INTO user_music_library (
        user_id, music_publication_id, file_type, file_name, file_url, file_size, price,
        composer_id, composition_title, composition_title_1, composition_description,
        composer_firstname, composer_lastname,
        is_part_of_collection, collection_id, collection_name,
        vocal_parts, instrumentation, types_of_music,
        first_line_of_composition, composition_copyrights, song_type,
        meter, season, psalm_number, liturgicalText, verseStyle, feast,
        text_copyright_notice, tune_copyright_notice,
        artists, music_files, music_video_link, artwork_file_url, artwork_file_size,
        tune, general_details, country_restrictions,
        is_public_domain, can_be_reprinted, can_be_podcast_streamed,
        can_make_commercial_recording, can_make_non_commercial_recording
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        finalUserId,
        musicPublicationId,
        fileType,
        fileName,
        fileUrl,
        fileSize,
        price,
        musicPublication.composer_id,
        musicPublication.composition_title,
        musicPublication.composition_title_1,
        musicPublication.composition_description,
        musicPublication.composer_firstname,
        musicPublication.composer_lastname,
        musicPublication.is_part_of_collection || false,
        musicPublication.collection_id,
        musicPublication.collection_name,
        safeStringify(musicPublication.vocal_parts),
        safeStringify(musicPublication.instrumentation),
        musicPublication.types_of_music,
        musicPublication.first_line_of_composition,
        safeStringify(musicPublication.composition_copyrights),
        musicPublication.song_type,
        musicPublication.meter,
        musicPublication.season,
        musicPublication.psalm_number,
        musicPublication.liturgicalText,
        musicPublication.verseStyle,
        musicPublication.feast,
        musicPublication.text_copyright_notice,
        musicPublication.tune_copyright_notice,
        safeStringify(musicPublication.artists),
        safeStringify(musicPublication.music_files),
        musicPublication.music_video_link,
        musicPublication.artwork_file_url,
        musicPublication.artwork_file_size,
        musicPublication.tune,
        musicPublication.general_details,
        musicPublication.country_restrictions,
        musicPublication.is_public_domain || false,
        musicPublication.can_be_reprinted || false,
        musicPublication.can_be_podcast_streamed || false,
        musicPublication.can_make_commercial_recording || false,
        musicPublication.can_make_non_commercial_recording || false
      ]
    );

    // Get the purchased file details
    const [purchasedFile] = await mysqlConnection.execute(`
      SELECT 
        uml.*,
        mp.published_at
      FROM user_music_library uml
      LEFT JOIN music_publications mp ON uml.music_publication_id = mp.id
      WHERE uml.id = ?
    `, [result.insertId]);

    const purchase = purchasedFile[0];

    // Helper function to parse JSON safely
    const parseJSON = (data) => {
      if (!data) return null;
      if (typeof data === 'string') {
        try {
          return JSON.parse(data);
        } catch (e) {
          return null;
        }
      }
      return data;
    };

    successResponse(res, {
      purchase: {
        id: purchase.id,
        musicId: `#${musicPublicationId.toString().padStart(8, '0')}`,
        musicPublicationId: purchase.music_publication_id,

        // File Details
        fileType: purchase.file_type,
        fileName: purchase.file_name,
        fileUrl: purchase.file_url,
        fileSize: purchase.file_size,
        price: parseFloat(purchase.price),
        purchaseDate: purchase.purchase_date,

        // Composer Info
        composerId: purchase.composer_id,

        // Composition Details
        compositionTitle: purchase.composition_title,
        compositionTitle1: purchase.composition_title_1,
        compositionDescription: purchase.composition_description,
        composer: purchase.composer_firstname && purchase.composer_lastname
          ? `${purchase.composer_firstname} ${purchase.composer_lastname}`.trim()
          : null,
        composerFirstname: purchase.composer_firstname,
        composerLastname: purchase.composer_lastname,

        // Collection Information
        isPartOfCollection: purchase.is_part_of_collection,
        collectionId: purchase.collection_id,
        collectionName: purchase.collection_name,

        // Music Details
        vocalParts: parseJSON(purchase.vocal_parts),
        instrumentation: parseJSON(purchase.instrumentation),
        typesOfMusic: purchase.types_of_music,

        // OneLicense Information
        firstLineOfComposition: purchase.first_line_of_composition,
        compositionCopyrights: parseJSON(purchase.composition_copyrights),
        songType: purchase.song_type,
        meter: purchase.meter,
        season: purchase.season,
        psalmNumber: purchase.psalm_number,
        liturgicalText: purchase.liturgicalText,
        verseStyle: purchase.verseStyle,
        feast: purchase.feast,

        // Copyright Details
        textCopyrightNotice: purchase.text_copyright_notice,
        tuneCopyrightNotice: purchase.tune_copyright_notice,

        // Artist Details
        artists: parseJSON(purchase.artists),

        // All Files
        musicFiles: parseJSON(purchase.music_files),
        musicVideoLink: purchase.music_video_link,
        artworkFileUrl: purchase.artwork_file_url,
        artworkFileSize: purchase.artwork_file_size,

        // General Details
        tune: purchase.tune,
        generalDetails: purchase.general_details,
        countryRestrictions: purchase.country_restrictions,

        // Usage Permissions
        isPublicDomain: purchase.is_public_domain,
        canBeReprinted: purchase.can_be_reprinted,
        canBePodcastStreamed: purchase.can_be_podcast_streamed,
        canMakeCommercialRecording: purchase.can_make_commercial_recording,
        canMakeNonCommercialRecording: purchase.can_make_non_commercial_recording,

        // Publication Info
        publishedAt: purchase.published_at
      }
    }, 'Music publication purchased successfully', 201);

  } catch (error) {
    console.error('Purchase music publication error:', error);
    errorResponse(res, 'Failed to purchase music publication', 500);
  }
});


router.get('/download/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Step 1: Check if user has an active plan and get plan details
    const [user] = await mysqlConnection.execute(
      `SELECT 
        u.current_plan_id, 
        u.plan_status, 
        u.plan_end_date,
        p.name as plan_name,
        p.slug as plan_slug
      FROM users u
      LEFT JOIN plans p ON u.current_plan_id = p.id
      WHERE u.id = ?`,
      [userId]
    );

    if (user.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    const userData = user[0];

    // Check if user has active plan
    const hasActivePlan = userData.current_plan_id &&
      userData.plan_status === 'active' &&
      (!userData.plan_end_date || new Date(userData.plan_end_date) > new Date());

    if (!hasActivePlan) {
      return errorResponse(res, 'You need an active plan to download music files. Please subscribe to a plan first.', 403);
    }

    // Step 2: Get plan-based download limit
    const planDownloadLimits = {
      // Free plans
      'free-account': 0,
      'free': 0,

      // Music subscription plans
      'music-subscription': 10,
      'Music Subscription': 10,

      // Planner subscription
      'planner-subscription': 0,
      'Planner Subscription': 0,

      // Documents subscription
      'documents-subscription': 0,
      'Documents Subscription': 0,

      // Academy subscription
      'academy-subscription': 0,
      'Academy Subscription': 0,

      // Diocesan Admin
      'diocesan-admin': 20,
      'Diocesan Admin': 20,

      // Full access / Subscriber Admin
      'full-access-subscription': 50,
      'Subscriber Admin': 50,

      // Default limits based on plan names (case-insensitive matching)
      'basic': 5,
      'premium': 20,
      'enterprise': 50
    };

    // Determine download limit based on plan
    let maxDownloads = 0;
    let planName = userData.plan_name || 'No Plan';

    if (userData.plan_slug) {
      // Try to get limit from slug first
      maxDownloads = planDownloadLimits[userData.plan_slug.toLowerCase()] ||
        planDownloadLimits[userData.plan_slug] || 0;
    } else if (userData.plan_name) {
      // Try to get limit from plan name
      maxDownloads = planDownloadLimits[userData.plan_name] ||
        planDownloadLimits[userData.plan_name.toLowerCase()] || 0;
    }

    // If no plan limit found, default to 0 (no downloads allowed)
    if (maxDownloads === 0) {
      return errorResponse(res, `Your current plan (${planName}) does not include music download access. Please upgrade to a plan that supports music downloads.`, 403);
    }

    // Step 3: Check total download count for this user
    const [downloadStats] = await mysqlConnection.execute(
      'SELECT COUNT(*) as total_downloads FROM user_music_library WHERE user_id = ? AND download_count > 0',
      [userId]
    );

    const totalDownloadedFiles = downloadStats[0].total_downloads;

    if (totalDownloadedFiles >= maxDownloads) {
      return errorResponse(res, `Download limit reached. You have already downloaded ${maxDownloads} files with your ${planName} plan. Please upgrade your plan for more downloads.`, 403);
    }

    // Step 3: Get the file details with composition information
    const [files] = await mysqlConnection.execute(`
      SELECT 
        uml.*,
        mp.composition_title,
        mp.composer_firstname,
        mp.composer_lastname,
        mp.artists,
        mp.composition_copyrights,
        mp.artwork_file_url,
        mp.status as publication_status
      FROM user_music_library uml
      JOIN music_publications mp ON uml.music_publication_id = mp.id
      WHERE uml.id = ? AND uml.user_id = ?
    `, [id, userId]);

    if (files.length === 0) {
      return errorResponse(res, 'File not found or you do not have permission to download it', 404);
    }

    const file = files[0];

    // Step 4: Update download count and last downloaded timestamp
    await mysqlConnection.execute(
      'UPDATE user_music_library SET download_count = download_count + 1, last_downloaded = NOW() WHERE id = ?',
      [id]
    );

    // Calculate remaining downloads
    const remainingDownloads = Math.max(0, maxDownloads - (totalDownloadedFiles + 1));

    // Return file download information with composition details
    successResponse(res, {
      download: {
        id: file.id,
        fileName: file.file_name,
        fileUrl: file.file_url,
        fileSize: file.file_size,
        fileType: file.file_type,
        downloadCount: file.download_count + 1,
        totalDownloadedFiles: totalDownloadedFiles + 1,
        remainingDownloads: remainingDownloads,
        maxDownloads: maxDownloads,
        planName: planName,
        composition: {
          id: file.music_publication_id,
          title: file.composition_title,
          composer: file.composer_firstname && file.composer_lastname
            ? `${file.composer_firstname} ${file.composer_lastname}`.trim()
            : null,
          composerFirstName: file.composer_firstname,
          composerLastName: file.composer_lastname,
          artists: file.artists,
          copyrights: file.composition_copyrights,
          artworkFileUrl: file.artwork_file_url,
          status: file.publication_status
        }
      }
    }, 'File download information retrieved successfully');

  } catch (error) {
    console.error('Download file error:', error);
    errorResponse(res, 'Failed to get download information', 500);
  }
});

// GET /api/user-music-library/download-stats - Get user's download statistics
router.get('/download-stats', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Check user's plan status
    const [user] = await mysqlConnection.execute(
      'SELECT current_plan_id, plan_status, plan_end_date FROM users WHERE id = ?',
      [userId]
    );

    if (user.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    const userData = user[0];
    const hasActivePlan = userData.current_plan_id &&
      userData.plan_status === 'active' &&
      (!userData.plan_end_date || new Date(userData.plan_end_date) > new Date());

    // Get total downloaded files count
    const [downloadStats] = await mysqlConnection.execute(
      'SELECT COUNT(*) as total_downloads FROM user_music_library WHERE user_id = ? AND download_count > 0',
      [userId]
    );

    const totalDownloadedFiles = downloadStats[0].total_downloads;
    const maxDownloads = 10;
    const remainingDownloads = Math.max(0, maxDownloads - totalDownloadedFiles);

    // Get list of downloaded files with details
    const [downloadedFiles] = await mysqlConnection.execute(`
      SELECT 
        uml.id,
        uml.music_publication_id,
        uml.file_name,
        uml.file_type,
        uml.download_count,
        uml.last_downloaded,
        mp.composition_title
      FROM user_music_library uml
      JOIN music_publications mp ON uml.music_publication_id = mp.id
      WHERE uml.user_id = ? AND uml.download_count > 0
      ORDER BY uml.last_downloaded DESC
    `, [userId]);

    successResponse(res, {
      stats: {
        hasActivePlan,
        planStatus: userData.plan_status,
        planEndDate: userData.plan_end_date,
        totalDownloadedFiles,
        remainingDownloads,
        maxDownloads,
        canDownloadMore: hasActivePlan && totalDownloadedFiles < maxDownloads,
        downloadedFiles: downloadedFiles.map(file => ({
          id: file.id,
          musicId: file.music_publication_id,
          compositionTitle: file.composition_title,
          fileName: file.file_name,
          fileType: file.file_type,
          downloadCount: file.download_count,
          lastDownloaded: file.last_downloaded
        }))
      }
    }, 'Download statistics retrieved successfully');

  } catch (error) {
    console.error('Get download stats error:', error);
    errorResponse(res, 'Failed to get download statistics', 500);
  }
});

// GET /api/user-music-library/download-limit - Get download limit based on user's plan
router.get('/download-limit', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Get user's plan information
    const [user] = await mysqlConnection.execute(
      `SELECT 
        u.current_plan_id, 
        u.plan_status, 
        u.plan_end_date,
        p.name as plan_name,
        p.slug as plan_slug
      FROM users u
      LEFT JOIN plans p ON u.current_plan_id = p.id
      WHERE u.id = ?`,
      [userId]
    );

    if (user.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    const userData = user[0];

    // Check if user has active plan
    const hasActivePlan = userData.current_plan_id &&
      userData.plan_status === 'active' &&
      (!userData.plan_end_date || new Date(userData.plan_end_date) > new Date());

    // Plan to download limit mapping
    const planDownloadLimits = {
      // Free plans
      'free-account': 0,
      'free': 0,

      // Music subscription plans
      'music-subscription': 10,
      'Music Subscription': 10,

      // Planner subscription
      'planner-subscription': 0,
      'Planner Subscription': 0,

      // Documents subscription
      'documents-subscription': 0,
      'Documents Subscription': 0,

      // Academy subscription
      'academy-subscription': 0,
      'Academy Subscription': 0,

      // Diocesan Admin
      'diocesan-admin': 20,
      'Diocesan Admin': 20,

      // Full access / Subscriber Admin
      'full-access-subscription': 50,
      'Subscriber Admin': 50,

      // Default limits based on plan names (case-insensitive matching)
      'basic': 5,
      'premium': 20,
      'enterprise': 50
    };

    // Determine download limit based on plan
    let downloadLimit = 0;
    let planName = 'No Plan';

    if (hasActivePlan && userData.plan_slug) {
      // Try to get limit from slug first
      downloadLimit = planDownloadLimits[userData.plan_slug.toLowerCase()] ||
        planDownloadLimits[userData.plan_slug] || 0;
      planName = userData.plan_name || userData.plan_slug;
    } else if (hasActivePlan && userData.plan_name) {
      // Try to get limit from plan name
      downloadLimit = planDownloadLimits[userData.plan_name] ||
        planDownloadLimits[userData.plan_name.toLowerCase()] || 0;
      planName = userData.plan_name;
    }

    // Get current download count
    const [downloadStats] = await mysqlConnection.execute(
      'SELECT COUNT(*) as total_downloads FROM user_music_library WHERE user_id = ? AND download_count > 0',
      [userId]
    );

    const totalDownloadedFiles = downloadStats[0].total_downloads;
    const remainingDownloads = Math.max(0, downloadLimit - totalDownloadedFiles);

    successResponse(res, {
      downloadLimit: {
        hasActivePlan,
        planName,
        planStatus: userData.plan_status,
        planEndDate: userData.plan_end_date,
        maxDownloads: downloadLimit,
        totalDownloadedFiles,
        remainingDownloads,
        canDownloadMore: hasActivePlan && downloadLimit > 0 && totalDownloadedFiles < downloadLimit,
        message: hasActivePlan
          ? `You can download up to ${downloadLimit} files with your ${planName} plan.`
          : 'You need an active plan to download music files.'
      }
    }, 'Download limit retrieved successfully');

  } catch (error) {
    console.error('Get download limit error:', error);
    errorResponse(res, 'Failed to get download limit', 500);
  }
});

// DELETE /api/user-music-library/cart/:id - Remove item from cart
router.delete('/cart/:id', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const userId = req.user.userId || req.user.id;
    const cartItemId = req.params.id;

    // Check if cart item exists and belongs to user
    const [cartItem] = await mysqlConnection.execute(`
      SELECT id FROM user_music_cart 
      WHERE id = ? AND user_id = ?
    `, [cartItemId, userId]);

    if (cartItem.length === 0) {
      return errorResponse(res, 'Cart item not found', 404);
    }

    // Remove item from cart
    await mysqlConnection.execute(`
      DELETE FROM user_music_cart WHERE id = ? AND user_id = ?
    `, [cartItemId, userId]);

    successResponse(res, {}, 'Item removed from cart successfully');

  } catch (error) {
    console.error('Remove from cart error:', error);
    errorResponse(res, 'Failed to remove item from cart', 500);
  }
});

// DELETE /api/user-music-library/cart - Clear entire cart
router.delete('/cart', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const userId = req.user.userId || req.user.id;

    // Clear user's entire cart
    const [result] = await mysqlConnection.execute(`
      DELETE FROM user_music_cart WHERE user_id = ?
    `, [userId]);

    successResponse(res, {
      removedItems: result.affectedRows
    }, 'Cart cleared successfully');

  } catch (error) {
    console.error('Clear cart error:', error);
    errorResponse(res, 'Failed to clear cart', 500);
  }
});

router.delete('/:id(\\d+)', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Check if file exists and belongs to user
    const [files] = await mysqlConnection.execute(
      'SELECT * FROM user_music_library WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    if (files.length === 0) {
      return errorResponse(res, 'File not found or you do not have permission to remove it', 404);
    }

    const file = files[0];

    // Remove the file from user's library
    await mysqlConnection.execute(
      'DELETE FROM user_music_library WHERE id = ? AND user_id = ?',
      [id, userId]
    );

    successResponse(res, {
      removed: {
        id: file.id,
        fileName: file.file_name,
        fileType: file.file_type
      }
    }, 'File removed from library successfully');

  } catch (error) {
    console.error('Remove file error:', error);
    errorResponse(res, 'Failed to remove file from library', 500);
  }
});

router.get('/stats', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Get library statistics
    const [stats] = await mysqlConnection.execute(`
      SELECT 
        COUNT(*) as totalFiles,
        SUM(price) as totalSpent,
        COUNT(DISTINCT music_publication_id) as uniqueMusic,
        SUM(download_count) as totalDownloads,
        AVG(price) as averagePrice
      FROM user_music_library 
      WHERE user_id = ?
    `, [userId]);

    // Get file type breakdown
    const [fileTypeStats] = await mysqlConnection.execute(`
      SELECT 
        file_type,
        COUNT(*) as count,
        SUM(price) as totalSpent
      FROM user_music_library 
      WHERE user_id = ?
      GROUP BY file_type
      ORDER BY count DESC
    `, [userId]);

    // Get recent purchases
    const [recentPurchases] = await mysqlConnection.execute(`
      SELECT 
        uml.*,
        mp.composition_title,
        mp.composer_firstname,
        mp.composer_lastname
      FROM user_music_library uml
      JOIN music_publications mp ON uml.music_publication_id = mp.id
      WHERE uml.user_id = ?
      ORDER BY uml.purchase_date DESC
      LIMIT 5
    `, [userId]);

    successResponse(res, {
      stats: {
        totalFiles: stats[0].totalFiles || 0,
        totalSpent: parseFloat(stats[0].totalSpent || 0),
        uniqueMusic: stats[0].uniqueMusic || 0,
        totalDownloads: stats[0].totalDownloads || 0,
        averagePrice: parseFloat(stats[0].averagePrice || 0)
      },
      fileTypeBreakdown: fileTypeStats.map(stat => ({
        fileType: stat.file_type,
        count: stat.count,
        totalSpent: parseFloat(stat.totalSpent)
      })),
      recentPurchases: recentPurchases.map(purchase => ({
        id: purchase.id,
        musicId: `#${purchase.music_publication_id.toString().padStart(8, '0')}`,
        musicTitle: purchase.composition_title,
        composer: purchase.composer_firstname && purchase.composer_lastname ? `${purchase.composer_firstname} ${purchase.composer_lastname}`.trim() : null,
        fileType: purchase.file_type,
        fileName: purchase.file_name,
        price: parseFloat(purchase.price),
        purchaseDate: purchase.purchase_date
      }))
    }, 'Library statistics retrieved successfully');

  } catch (error) {
    console.error('Get library stats error:', error);
    errorResponse(res, 'Failed to get library statistics', 500);
  }
});

/**
 * @route   GET /api/user-music-library
 * @desc    Get music publications (filters + A-Z / Z-A sorting)
 * @access  Private
 */
router.get('/', async (req, res) => {
  try {
    const mysql = getMySQLConnection();

    // =============================
    // Pagination
    // =============================
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 10, 100);
    const offset = (page - 1) * limit;

    // =============================
    // Query params
    // =============================
    const {
      id,
      search,
      sort_by,
      sort_order,
      type_of_music,
      composer,
      vocal_parts,
      instrumentation,
      feast,
      collection_id, 
      collection_name
    } = req.query;

    // =============================
    // SINGLE FETCH
    // =============================
    if (id) {
      const [rows] = await mysql.execute(
        `
        SELECT mp.*
        FROM music_publications mp
        JOIN users u ON u.id = mp.composer_id
        WHERE mp.id = ?
        AND mp.status = 'published'
        AND u.is_active = TRUE
        LIMIT 1
        `,
        [id]
      );

      if (!rows.length) {
        return errorResponse(res, 'Music publication not found', 404);
      }

      return successResponse(res, {
        publication: rows[0]
      });
    }

    // =============================
    // Sorting
    // =============================
    const sortOrder = sort_order === 'DESC' ? 'DESC' : 'ASC';

    let orderBy = 'mp.created_at DESC';

    if (sort_by === 'title') {
      orderBy = `
        TRIM(mp.composition_title)
        COLLATE utf8mb4_unicode_ci ${sortOrder}
      `;
    }

    // =============================
    // BASE WHERE
    // =============================
    let where = `
      WHERE mp.status = 'published'
      AND mp.toggle = 'active'
      AND u.is_active = TRUE
    `;

    const params = [];

    // =============================
    // SEARCH
    // =============================
    if (search) {
      // Ignore multiple spaces and punctuation, then split into individual words
      const cleanSearch = search.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'’]/g, ' ');
      const keywords = cleanSearch.split(/\s+/).filter(Boolean);

      // Get unique keywords to avoid redundant SQL conditions
      const uniqueKeywords = [...new Set(keywords)];

      if (uniqueKeywords.length > 0) {
        uniqueKeywords.forEach((keyword) => {
          where += `
            AND (
              mp.composition_title LIKE ?
              OR mp.composer_firstname LIKE ?
              OR mp.composer_lastname LIKE ?
              OR CONCAT(mp.composer_firstname, ' ', mp.composer_lastname) LIKE ?
            )
          `;
          const like = `%${keyword}%`;
          params.push(like, like, like, like);
        });
      }
    }

    // =============================
    // COMPOSER FILTER
    // =============================
    if (composer) {
      where += `
        AND (
          mp.composer_firstname LIKE ?
          OR mp.composer_lastname LIKE ?
          OR CONCAT(mp.composer_firstname,' ',mp.composer_lastname) LIKE ?
        )
      `;
      const like = `%${composer}%`;
      params.push(like, like, like);
    }

    // =============================
    // COLLECTION FILTER (via collection_music junction table + collections table)
    // collection_id OR collection_name — matched against the ACTUAL
    // collections a composer has added the song to, not the stale
    // snapshot fields on music_publications.
    // =============================
    if (collection_id || collection_name) {
      const subConditions = [];

      if (collection_id) {
        subConditions.push(`cm.collection_id = ?`);
        params.push(collection_id);
      }

      if (collection_name) {
        subConditions.push(`c.name LIKE ?`);
        params.push(`%${collection_name}%`);
      }

      where += `
        AND mp.id IN (
          SELECT cm.music_id
          FROM collection_music cm
          JOIN collections c ON c.id = cm.collection_id
          WHERE ${subConditions.join(' OR ')}
        )
      `;
    }

    // =============================
    // TYPE FILTER
    // =============================
    if (type_of_music) {
      const types = type_of_music.split(',');
      const conditions = types.map(() => `mp.types_of_music LIKE ?`);
      where += ` AND (${conditions.join(' OR ')})`;
      types.forEach(t => params.push(`%${t}%`));
    }

    // =============================
    // VOCAL PARTS
    // =============================
    if (vocal_parts) {
      const parts = vocal_parts.split(',');
      const conditions = parts.map(() => `mp.vocal_parts LIKE ?`);
      where += ` AND (${conditions.join(' OR ')})`;
      parts.forEach(p => params.push(`%"${p}"%`));
    }

    // =============================
    // INSTRUMENTATION
    // =============================
    if (instrumentation) {
      const instruments = instrumentation.split(',');
      const conditions = instruments.map(() => `mp.instrumentation LIKE ?`);
      where += ` AND (${conditions.join(' OR ')})`;
      instruments.forEach(i => params.push(`%"${i}"%`));
    }

    // =============================
    // ✅ FEAST FILTER (HIERARCHY SUPPORT)
    // =============================
    if (feast) {
      const normalize = (val) =>
        decodeURIComponent(val).replace(/\+/g, ' ').trim();

      const feastList = feast.split(',');

      let feastConditions = [];

      feastList.forEach((f) => {
        const clean = normalize(f);

        // split hierarchy: Parent > Child > Sub-child
        const parts = clean.split('>').map(p => p.trim());

        // each part must exist in JSON
        const subConditions = parts.map(() => `mp.feast LIKE ?`);

        feastConditions.push(`(${subConditions.join(' AND ')})`);

        parts.forEach(part => {
          params.push(`%${part}%`);
        });
      });

      where += ` AND (${feastConditions.join(' OR ')})`;
    }

    // =============================
    // MAIN QUERY
    // =============================
    const [rows] = await mysql.execute(
      `
      SELECT mp.*
      FROM music_publications mp
      JOIN users u ON u.id = mp.composer_id
      ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    // =============================
    // COUNT QUERY
    // =============================
    const [countRows] = await mysql.execute(
      `
      SELECT COUNT(*) AS total
      FROM music_publications mp
      JOIN users u ON u.id = mp.composer_id
      ${where}
      `,
      params
    );

    // =============================
    // RESPONSE
    // =============================
    return successResponse(res, {
      publications: rows,
      pagination: {
        page,
        limit,
        total: countRows[0].total,
        totalPages: Math.ceil(countRows[0].total / limit)
      }
    });

  } catch (err) {
    console.error('User music library error:', err);
    return errorResponse(res, 'Failed to fetch music library', 500);
  }
});

// GET /api/user-music-library/cart - Get user's cart items
router.get('/cart', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const userId = req.user.userId || req.user.id;


    // Get cart data directly from database
    const [cartData] = await mysqlConnection.execute(`
      SELECT 
        umc.id,
        umc.user_id,
        umc.music_publication_id,
        umc.file_data,
        umc.price,
        umc.added_at
      FROM user_music_cart umc
      WHERE umc.user_id = ?
      ORDER BY umc.added_at DESC
    `, [userId]);


    if (cartData.length === 0) {
      return successResponse(res, {
        cartItems: [],
        totalItems: 0,
        totalPrice: 0
      }, 'Cart is empty');
    }

    // Get publication details separately
    const publicationIds = cartData.map(item => item.music_publication_id);
    const [publicationData] = await mysqlConnection.execute(`
      SELECT 
        mp.id,
        mp.composition_title,
        mp.composer_firstname,
        mp.composer_lastname,
        mp.status,
        mp.artwork_file_url
      FROM music_publications mp
      WHERE mp.id IN (${publicationIds.join(',')})
    `);


    // Format the response
    const formattedCartItems = cartData.map(item => {
      const publication = publicationData.find(pub => pub.id === item.music_publication_id);
      const fileData = JSON.parse(item.file_data);

      return {
        id: item.id,
        musicId: `#${item.music_publication_id.toString().padStart(8, '0')}`,
        musicTitle: publication ? publication.composition_title : 'Unknown Title',
        composer: publication ? `${publication.composer_firstname} ${publication.composer_lastname}` : 'Unknown Composer',
        fileData: fileData,
        price: parseFloat(item.price),
        addedAt: item.added_at,
        publicationStatus: publication ? publication.status : 'Not Found',
        artworkFileUrl: publication ? publication.artwork_file_url : null
      };
    });

    // Calculate total
    const totalPrice = cartData.reduce((sum, item) => sum + parseFloat(item.price), 0);

    return successResponse(res, {
      cartItems: formattedCartItems,
      totalItems: cartData.length,
      totalPrice: parseFloat(totalPrice.toFixed(2)),
    }, 'Cart data retrieved successfully');

  } catch (error) {
    console.error('Get cart error:', error);
    errorResponse(res, 'Failed to retrieve cart', 500);
  }
});

// @route   GET /api/user-music-library/orders
// @desc    Get user's order history
// @access  Private
router.get('/orders', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const userId = req.user.userId || req.user.id;

    const [orders] = await mysqlConnection.execute(`
      SELECT 
        id,
        total_amount,
        payment_status,
        payment_method,
        order_status,
        stripe_session_id,
        created_at,
        updated_at
      FROM user_orders 
      WHERE user_id = ?
      ORDER BY created_at DESC
    `, [userId]);

    const ordersWithDetails = [];
    const publicationsByOrder = {}; // { [orderId]: [pub, ...] }
    const allPublicationsMap = new Map(); // to ensure global uniqueness by publication id

    for (const order of orders) {
      let musicTransactions = [];
      let publicationsList = [];

      if (order.stripe_session_id) {
        const [tx] = await mysqlConnection.execute(`
          SELECT 
            mt.id,
            mt.music_publication_id,
            mt.amount,
            mt.currency,
            mt.status,
            mt.completed_at,
            mt.created_at,
            mp.id as publication_id,
            mp.composer_id,
            mp.status as publication_status,
            mp.composition_title as full_composition_title,
            mp.composition_description,
            mp.composer_firstname,
            mp.composer_lastname,
            mp.composition_title_1,
            mp.is_part_of_collection,
            mp.collection_id,
            mp.collection_name,
            mp.vocal_parts,
            mp.instrumentation,
            mp.types_of_music,
            mp.first_line_of_composition,
            mp.composition_copyrights,
            mp.song_type,
            mp.meter,
            mp.season,
            mp.psalm_number,
            mp.liturgicalText,
            mp.verseStyle,
            mp.feast,
            mp.text_copyright_notice,
            mp.tune_copyright_notice,
            mp.artists,
            mp.music_files,
            mp.artwork_file_url,
            mp.artwork_file_size,
            mp.price,
            mp.is_free,
            mp.terms_accepted,
            mp.terms_accepted_at,
            mp.onelicense_verified_by,
            mp.onelicense_verified_at,
            mp.onelicense_verification_notes,
            mp.sl_team_reviewed_by,
            mp.sl_team_reviewed_at,
            mp.sl_team_review_notes,
            mp.rejection_reason,
            mp.published_at,
            mp.published_by,
            mp.created_at as publication_created_at,
            mp.updated_at as publication_updated_at
          FROM music_transactions mt
          LEFT JOIN music_publications mp ON mt.music_publication_id = mp.id
          WHERE mt.stripe_session_id = ?
        `, [order.stripe_session_id]);


        musicTransactions = tx.map(t => {
          let publication = null;

          if (t.publication_id) {
            publication = {
              id: t.publication_id,
              composerId: t.composer_id,
              status: t.publication_status,
              compositionTitle: t.full_composition_title,
              compositionDescription: t.composition_description,
              composerFirstName: t.composer_firstname,
              composerLastName: t.composer_lastname,
              compositionTitle1: t.composition_title_1,
              isPartOfCollection: t.is_part_of_collection,
              collectionId: t.collection_id,
              collectionName: t.collection_name,
              vocalParts: parseJsonSafe(t.vocal_parts, []),
              instrumentation: parseJsonSafe(t.instrumentation, []),
              typesOfMusic: t.types_of_music,
              firstLineOfComposition: t.first_line_of_composition,
              compositionCopyrights: parseJsonSafe(t.composition_copyrights, []),
              songType: t.song_type,
              meter: t.meter,
              season: t.season,
              psalmNumber: t.psalm_number,
              liturgicalText: t.liturgicalText,
              verseStyle: t.verseStyle,
              feast: t.feast,
              textCopyrightNotice: t.text_copyright_notice,
              tuneCopyrightNotice: t.tune_copyright_notice,
              artists: parseJsonSafe(t.artists, []),
              musicFiles: parseJsonSafe(t.music_files, []),
              artworkFileUrl: t.artwork_file_url,
              artworkFileSize: t.artwork_file_size,
              price: t.price,
              isFree: t.is_free,
              termsAccepted: t.terms_accepted,
              termsAcceptedAt: t.terms_accepted_at,
              onelicenseVerifiedBy: t.onelicense_verified_by,
              onelicenseVerifiedAt: t.onelicense_verified_at,
              onelicenseVerificationNotes: t.onelicense_verification_notes,
              slTeamReviewedBy: t.sl_team_reviewed_by,
              slTeamReviewedAt: t.onelicense_verified_at,
              slTeamReviewNotes: t.sl_team_review_notes,
              rejectionReason: t.rejection_reason,
              publishedAt: t.published_at,
              publishedBy: t.published_by,
              createdAt: t.publication_created_at,
              updatedAt: t.publication_updated_at
            };

            // add to per-order publicationsList if not duplicate
            if (!publicationsList.find(p => p.id === publication.id)) {
              publicationsList.push(publication);
            }

            // add to global map for allPublications
            if (!allPublicationsMap.has(publication.id)) {
              allPublicationsMap.set(publication.id, publication);
            }
          }

          return {
            transactionId: t.id,
            musicPublicationId: t.music_publication_id,
            amount: t.amount != null ? parseFloat(t.amount) : null,
            currency: t.currency,
            status: t.status,
            completedAt: t.completed_at,
            createdAt: t.created_at,
            publication
          };
        });
      }

      // set publicationsByOrder for frontend convenience
      publicationsByOrder[order.id] = publicationsList;

      ordersWithDetails.push({
        id: order.id,
        totalAmount: order.total_amount != null ? parseFloat(order.total_amount) : null,
        paymentStatus: order.payment_status,
        paymentMethod: order.payment_method,
        orderStatus: order.order_status,
        stripeSessionId: order.stripe_session_id,
        createdAt: order.created_at,
        updatedAt: order.updated_at,
        publications: publicationsList, // per-order publications (separate)
        musicTransactions
      });
    }

    // build array of all unique publications
    const allPublications = Array.from(allPublicationsMap.values());

    successResponse(res, {
      orders: ordersWithDetails,
      publicationsByOrder, // { orderId: [publication, ...] }
      allPublications      // flat unique publication list across all orders
    }, 'Order history retrieved successfully');

  } catch (error) {
    console.error('Get orders error:', error);
    errorResponse(res, 'Failed to get order history', 500);
  }
});

router.get('/song/:id(\\d+)', auth, async (req, res) => {
  const { id } = req.params;
  try {
    const mysqlConnection = getMySQLConnection();
    const [publications] = await mysqlConnection.execute(
      `SELECT 
                mp.*,
                u.first_name,
                u.last_name,
                u.email,
                u.phone,
                u.role,
                u.bio,
                u.avatar,
                u.website_url,
                u.twitter_url
            FROM music_publications mp
            LEFT JOIN users u ON mp.composer_id = u.id
            WHERE mp.id = ? AND mp.music_files IS NOT NULL`,
      [id])

    if (publications.length === 0) {
      return errorResponse(res, 'Music publication not found', 404);
    }

    const pub = publications[0];
    const { first_name, last_name, email, phone, role, bio, avatar, website_url, twitter_url, ...musicPublication } = pub;

    const musicFiles = pub?.music_files ? JSON.parse(pub.music_files) : [];

    const transformedPublication = {
      ...musicPublication,
      music_files: musicFiles,
      composer: first_name ? {
        id: pub.composer_id,
        full_name: `${first_name} ${last_name}`.trim(),
        email,
        phone,
        role,
        bio,
        avatar,
        website_url,
        twitter_url
      } : null
    };

    return successResponse(res, {
      publication: transformedPublication
    }, 'Music publication retrieved successfully');
  } catch (error) {
    console.error('Get music by ID error:', error);
    errorResponse(res, 'Failed to get music by ID', 500);
  }
})


/**
 * @route   GET /api/user-music-library/most-recent
 * @desc    Get most repeated music publications with full details (corrected)
 * @access  Private
 */
router.get('/most-popular', async (req, res) => {
  try {
    console.log('Running most-recent (fixed logic)');
    const mysqlConnection = getMySQLConnection();

    // =============================
    // CORRECT QUERY
    // =============================
    const [rows] = await mysqlConnection.execute(`
      SELECT
        mp.*,

        rc.repeat_count,

        -- composer details
        u.first_name,
        u.last_name,
        u.email,
        u.phone,
        u.role,
        u.bio,
        u.avatar,
        u.website_url,
        u.twitter_url

      FROM (
        SELECT
          music_publication_id,
          COUNT(*) AS repeat_count
        FROM user_music_library
        GROUP BY music_publication_id
      ) rc

      INNER JOIN music_publications mp
        ON mp.id = rc.music_publication_id

      LEFT JOIN users u
        ON mp.composer_id = u.id

      ORDER BY rc.repeat_count DESC, mp.created_at DESC
    `);

    // =============================
    // TRANSFORM RESPONSE
    // =============================
    const publications = rows.map(pub => {
      const {
        first_name,
        last_name,
        email,
        phone,
        role,
        bio,
        avatar,
        website_url,
        twitter_url,
        music_files,
        ...musicPublication
      } = pub;

      return {
        ...musicPublication,

        // ✅ now correct
        repeat_count: Number(pub.repeat_count),

        music_files: music_files ? JSON.parse(music_files) : [],

        composer: first_name
          ? {
            id: pub.composer_id,
            full_name: `${first_name} ${last_name}`.trim(),
            email,
            phone,
            role,
            bio,
            avatar,
            website_url,
            twitter_url
          }
          : null
      };
    });

    // =============================
    // FINAL RESPONSE
    // =============================
    return successResponse(
      res,
      { publications },
      'Most repeated music publications retrieved successfully'
    );

  } catch (error) {
    console.error('Get most recent music error:', error);
    return errorResponse(res, 'Failed to get most recent music', 500);
  }
});

router.delete('/:id(\\d+)/:index(\\d+)', auth, async (req, res) => {
  try {
    const { id, index } = req.params;
    const mysqlConnection = getMySQLConnection();
    const [publications] = await mysqlConnection.execute(
      `SELECT 
                mp.*,
                u.first_name,
                u.last_name,
                u.email,
                u.phone,
                u.role,
                u.bio,
                u.avatar,
                u.website_url,
                u.twitter_url
            FROM music_publications mp
            LEFT JOIN users u ON mp.composer_id = u.id
            WHERE mp.id = ? AND mp.music_files IS NOT NULL`,
      [id])
    if (publications.length === 0) {
      return errorResponse(res, 'Music publication not found', 404);
    }

    const pub = publications[0];
    const { first_name, last_name, email, phone, role, bio, avatar, website_url, twitter_url, ...musicPublication } = pub;

    const musicFiles = pub?.music_files ? JSON.parse(pub.music_files) : [];
    if (index < 0 || index >= musicFiles.length) {
      return errorResponse(res, 'Invalid music file index', 400);
    }
    musicFiles.splice(index, 1);
    await mysqlConnection.execute(
      `UPDATE music_publications SET music_files = ? WHERE id = ?`,
      [JSON.stringify(musicFiles), id]
    );

    const transformedPublication = {
      ...musicPublication,
      music_files: musicFiles,
      composer: first_name ? {
        id: pub.composer_id,
        full_name: `${first_name} ${last_name}`.trim(),
        email,
        phone,
        role,
        bio,
        avatar,
        website_url,
        twitter_url
      } : null
    };

    return successResponse(res, {
      publication: transformedPublication
    }, 'Music file deleted successfully');
  } catch (error) {
    console.error('Delete music file error:', error);
    errorResponse(res, 'Failed to delete music file', 500);
  }

});

// GET /api/user-music-library/published - Get all published music (public endpoint)
router.get('/published', async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    // Get all published music with complete details
    const [publishedMusic] = await mysqlConnection.execute(`
      SELECT 
        mp.id,
        mp.composer_id,
        mp.status,
        mp.composition_title,
        mp.composition_description,
        mp.composer_name,
        mp.is_part_of_collection,
        mp.collection_id,
        mp.collection_name,
        mp.vocal_parts,
        mp.instrumentation,
        mp.types_of_music,
        mp.artists,
        mp.first_line_of_composition,
        mp.composition_copyrights,
        mp.song_type,
        mp.meter,
        mp.season,
        mp.psalm_number,
        mp.liturgicalText,
        mp.verseStyle,
        mp.feast,
        mp.text_copyright_notice,
        mp.tune_copyright_notice,
        mp.music_files,
        mp.artwork_file_url,
        mp.artwork_file_size,
        mp.price,
        mp.is_free,
        mp.terms_accepted,
        mp.terms_accepted_at,
        mp.onelicense_verified_by,
        mp.onelicense_verified_at,
        mp.onelicense_verification_notes,
        mp.sl_team_reviewed_by,
        mp.sl_team_reviewed_at,
        mp.sl_team_review_notes,
        mp.published_at,
        mp.published_by,
        mp.created_at,
        mp.updated_at,
        u.first_name,
        u.last_name,
        u.email,
        u.profile_picture_url,
        u.bio,
        u.website,
        u.social_media_links,
        u.address
      FROM music_publications mp
      LEFT JOIN users u ON mp.composer_id = u.id
      WHERE mp.status = 'published'
      ORDER BY mp.published_at DESC
    `);

    // Format the response with all fields and proper JSON parsing
    const formattedMusic = publishedMusic.map(music => ({
      id: music.id,
      composerId: music.composer_id,
      status: music.status,
      compositionTitle: music.composition_title,
      compositionDescription: music.composition_description,
      composerName: music.composer_name,
      isPartOfCollection: music.is_part_of_collection,
      collectionId: music.collection_id,
      collectionName: music.collection_name,
      vocalParts: music.vocal_parts ? (typeof music.vocal_parts === 'string' ? JSON.parse(music.vocal_parts) : music.vocal_parts) : null,
      instrumentation: music.instrumentation ? (typeof music.instrumentation === 'string' ? JSON.parse(music.instrumentation) : music.instrumentation) : null,
      typesOfMusic: music.types_of_music,
      artists: music.artists ? (typeof music.artists === 'string' ? JSON.parse(music.artists) : music.artists) : [],
      firstLineOfComposition: music.first_line_of_composition,
      compositionCopyrights: music.composition_copyrights ? (typeof music.composition_copyrights === 'string' ? JSON.parse(music.composition_copyrights) : music.composition_copyrights) : [],
      songType: music.song_type,
      meter: music.meter,
      season: music.season,
      psalmNumber: music.psalm_number,
      liturgicalText: music.liturgicalText,
      verseStyle: music.verseStyle,
      feast: music.feast,
      textCopyrightNotice: music.text_copyright_notice,
      tuneCopyrightNotice: music.tune_copyright_notice,
      musicFiles: music.music_files ? (typeof music.music_files === 'string' ? JSON.parse(music.music_files) : music.music_files) : [],
      artworkFileUrl: music.artwork_file_url,
      artworkFileSize: music.artwork_file_size,
      price: parseFloat(music.price) || 0,
      isFree: music.is_free === 1 || music.is_free === true,
      termsAccepted: music.terms_accepted,
      termsAcceptedAt: music.terms_accepted_at,
      onelicenseVerifiedBy: music.onelicense_verified_by,
      onelicenseVerifiedAt: music.onelicense_verified_at,
      onelicenseVerificationNotes: music.onelicense_verification_notes,
      slTeamReviewedBy: music.sl_team_reviewed_by,
      slTeamReviewedAt: music.sl_team_reviewed_at,
      slTeamReviewNotes: music.sl_team_review_notes,
      publishedAt: music.published_at,
      publishedBy: music.published_by,
      createdAt: music.created_at,
      updatedAt: music.updated_at,
      composer: {
        id: music.composer_id,
        firstName: music.first_name,
        lastName: music.last_name,
        email: music.email,
        profilePictureUrl: music.profile_picture_url,
        bio: music.bio,
        website: music.website,
        socialMediaLinks: music.social_media_links ? (typeof music.social_media_links === 'string' ? JSON.parse(music.social_media_links) : music.social_media_links) : null,
        address: music.address
      }
    }));

    successResponse(res, {
      music: formattedMusic,
      totalCount: formattedMusic.length,
      message: `Found ${formattedMusic.length} published music compositions`
    }, 'Published music retrieved successfully');

  } catch (error) {
    console.error('Get published music error:', error);
    errorResponse(res, 'Failed to retrieve published music', 500);
  }
});

// @route   POST /api/user-music-library/add-to-cart
// @desc    Add music publication to cart (with ownership & payment checks)
// @access  Private
router.post('/add-to-cart', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const userId = req.user.userId || req.user.id;
    const { musicPublicationId } = req.body;

    /* -----------------------------------
       1️⃣ Validate input
    ----------------------------------- */
    if (!musicPublicationId) {
      return errorResponse(res, 'musicPublicationId is required', 400);
    }

    /* -----------------------------------
       2️⃣ Check publication exists & published
    ----------------------------------- */
    const [publication] = await mysqlConnection.execute(
      `SELECT id, price, is_free, music_files
       FROM music_publications
       WHERE id = ? AND status = 'published'`,
      [musicPublicationId]
    );

    if (publication.length === 0) {
      return errorResponse(res, 'Music publication not found or not published', 404);
    }

    /* -----------------------------------
       3️⃣ ❌ Check: Payment already completed
       (prevents re-adding purchased music)
    ----------------------------------- */
    /* -----------------------------------
       3️⃣ Check: Payment already completed
    ----------------------------------- */

    const [completedPayment] = await mysqlConnection.execute(
      `SELECT id
   FROM music_transactions
   WHERE user_id = ?
     AND status = 'completed'
     AND JSON_CONTAINS(
       products_json,
       JSON_OBJECT('musicPublicationId', ?),
       '$'
     )
   LIMIT 1`,
      [userId, musicPublicationId]
    );

    if (completedPayment.length > 0) {
      return errorResponse(
        res,
        'Payment already completed for this music. Check your library.',
        409
      );
    }

    /* -----------------------------------
       4️⃣ ❌ Check: Already in cart
    ----------------------------------- */
    const [alreadyInCart] = await mysqlConnection.execute(
      `SELECT id
       FROM user_music_cart
       WHERE user_id = ? AND music_publication_id = ?
       LIMIT 1`,
      [userId, musicPublicationId]
    );

    if (alreadyInCart.length > 0) {
      return errorResponse(
        res,
        'This music is already in your cart',
        409
      );
    }

    /* -----------------------------------
       5️⃣ Prepare file data safely
    ----------------------------------- */
    let fileData = [];
    try {
      fileData = publication[0].music_files
        ? JSON.parse(publication[0].music_files)
        : [];
    } catch {
      fileData = [];
    }

    const price = publication[0].is_free
      ? 0
      : parseFloat(publication[0].price || 0);

    /* -----------------------------------
       6️⃣ Insert into cart
    ----------------------------------- */
    const [result] = await mysqlConnection.execute(
      `INSERT INTO user_music_cart (
        user_id,
        music_publication_id,
        file_data,
        price,
        added_at
      ) VALUES (?, ?, ?, ?, NOW())`,
      [
        userId,
        musicPublicationId,
        JSON.stringify(fileData),
        price
      ]
    );

    /* -----------------------------------
       7️⃣ Success response
    ----------------------------------- */
    return successResponse(
      res,
      {
        cartItem: {
          id: result.insertId,
          musicPublicationId,
          price
        }
      },
      'Music added to cart successfully',
      201
    );

  } catch (error) {
    console.error('Add to cart error:', error);
    return errorResponse(res, 'Failed to add music to cart', 500);
  }
});


// GET /api/user-music-library/cart - Get user's cart items
router.get('/cart', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const userId = req.user.userId || req.user.id;

    // 1) Get cart rows
    const [cartData] = await mysqlConnection.execute(
      `SELECT id, user_id, music_publication_id, file_data, price, added_at
       FROM user_music_cart
       WHERE user_id = ?
       ORDER BY added_at DESC`,
      [userId]
    );

    if (!cartData || cartData.length === 0) {
      return successResponse(res, {
        cartItems: [],
        totalItems: 0,
        totalPrice: 0
      }, 'Cart is empty');
    }

    // 2) Build publication IDs and placeholders safely
    const publicationIds = Array.from(new Set(cartData.map(item => item.music_publication_id).filter(Boolean)));
    if (publicationIds.length === 0) {
      // no valid publication ids found
      const formattedEmpty = cartData.map(item => {
        let fileData = null;
        try { fileData = typeof item.file_data === 'string' ? JSON.parse(item.file_data) : item.file_data; } catch (e) { fileData = item.file_data; }
        return {
          id: item.id,
          musicId: item.music_publication_id ? `#${item.music_publication_id.toString().padStart(8, '0')}` : null,
          musicTitle: 'Unknown Title',
          composer: 'Unknown Composer',
          fileData,
          price: parseFloat(item.price),
          addedAt: item.added_at,
          publicationStatus: 'Not Found',
          artworkFileUrl: null
        };
      });

      const totalPrice = cartData.reduce((s, it) => s + parseFloat(it.price || 0), 0);

      return successResponse(res, {
        cartItems: formattedEmpty,
        totalItems: cartData.length,
        totalPrice: parseFloat(totalPrice.toFixed(2))
      }, 'Cart data retrieved successfully');
    }

    const placeholders = publicationIds.map(() => '?').join(',');
    // 3) Select needed columns FROM music_publications — excluding all review-stage and stageX_* fields
    //    (explicit column list to avoid accidentally returning review-stage columns)
    const selectCols = [
      'id',
      'composer_id',
      'status',
      // intentionally NOT including review_stage or stage1..stage4_* fields
      'composition_title',
      'composition_title_1',
      'composition_description',
      'composer_firstname',
      'composer_lastname',
      'is_part_of_collection',
      'collection_id',
      'collection_name',
      'vocal_parts',
      'instrumentation',
      'types_of_music',
      'first_line_of_composition',
      'composition_copyrights',
      'song_type',
      'meter',
      'season',
      'psalm_number',
      'liturgicalText',
      'verseStyle',
      'feast',
      'text_copyright_notice',
      'tune_copyright_notice',
      'artists',
      'music_files',
      'music_video_link',
      'artwork_file_url',
      'artwork_file_size',
      'price',
      'is_free',
      'tune',
      'general_details',
      'country_restrictions',
      'is_public_domain',
      'can_be_reprinted',
      'can_be_podcast_streamed',
      'can_make_commercial_recording',
      'can_make_non_commercial_recording',
      'terms_accepted',
      'terms_accepted_at',
      // legacy/other review meta you may keep or remove as needed:
      'onelicense_verified_by',
      'onelicense_verified_at',
      'onelicense_verification_notes',
      'admin_reviewed_by',
      'admin_reviewed_at',
      'admin_review_notes',
      'sl_team_reviewed_by',
      'sl_team_reviewed_at',
      'sl_team_review_notes',
      'rejection_reason',
      'published_at',
      'published_by',
      'scheduled_deletion_at',
      'created_at',
      'updated_at'
    ].join(',');

    const [publicationData] = await mysqlConnection.execute(
      `SELECT ${selectCols} FROM music_publications WHERE id IN (${placeholders})`,
      publicationIds
    );

    // 4) Build a map for quick lookup
    const pubMap = new Map();
    for (const pub of publicationData) {
      pubMap.set(pub.id, pub);
    }

    // 5) Format cart items combining cart row + publication info
    const formattedCartItems = cartData.map(item => {
      const publication = pubMap.get(item.music_publication_id) || null;

      // safe JSON parse for file_data and publication JSON fields
      let fileData = null;
      try { fileData = typeof item.file_data === 'string' ? JSON.parse(item.file_data) : item.file_data; } catch (e) { fileData = item.file_data; }

      // also parse some publication JSON columns if present
      const parsedPublication = publication ? { ...publication } : null;
      if (parsedPublication) {
        try {
          if (typeof parsedPublication.vocal_parts === 'string') parsedPublication.vocal_parts = JSON.parse(parsedPublication.vocal_parts);
        } catch (e) { }
        try {
          if (typeof parsedPublication.instrumentation === 'string') parsedPublication.instrumentation = JSON.parse(parsedPublication.instrumentation);
        } catch (e) { }
        try {
          if (typeof parsedPublication.composition_copyrights === 'string') parsedPublication.composition_copyrights = JSON.parse(parsedPublication.composition_copyrights);
        } catch (e) { }
        try {
          if (typeof parsedPublication.artists === 'string') parsedPublication.artists = JSON.parse(parsedPublication.artists);
        } catch (e) { }
        try {
          if (typeof parsedPublication.music_files === 'string') parsedPublication.music_files = JSON.parse(parsedPublication.music_files);
        } catch (e) { }
      }

      return {
        id: item.id,
        musicId: item.music_publication_id ? `#${item.music_publication_id.toString().padStart(8, '0')}` : null,
        musicPublicationId: item.music_publication_id,
        musicTitle: publication ? publication.composition_title : 'Unknown Title',
        composer: publication ? `${publication.composer_firstname || ''} ${publication.composer_lastname || ''}`.trim() : 'Unknown Composer',
        fileData,
        price: parseFloat(item.price || 0),
        addedAt: item.added_at,
        publicationStatus: publication ? publication.status : 'Not Found',
        artworkFileUrl: publication ? publication.artwork_file_url : null,
        publication: parsedPublication // full publication object (without stage1..stage4 fields)
      };
    });

    // 6) Calculate total price
    const totalPrice = cartData.reduce((sum, item) => sum + parseFloat(item.price || 0), 0);

    return successResponse(res, {
      cartItems: formattedCartItems,
      totalItems: cartData.length,
      totalPrice: parseFloat(totalPrice.toFixed(2)),
    }, 'Cart data retrieved successfully');

  } catch (error) {
    console.error('Get cart error:', error);
    errorResponse(res, 'Failed to retrieve cart', 500);
  }
});

/* ==========================================
   CREATE ACH CHECKOUT SESSION
   ========================================== */
router.post("/create-ach-checkout-session", auth, async (req, res) => {
  try {
    const mysql = getMySQLConnection();
    const userId = req.user.userId || req.user.id;

    const { successUrl, cancelUrl, couponCode } = req.body;

    if (!successUrl || !cancelUrl) {
      return errorResponse(res, "Success URL and Cancel URL are required", 400);
    }

    /* ===============================
       FETCH CART ITEMS
    =============================== */
    const [cartItems] = await mysql.execute(
      `SELECT 
          umc.*,
          mp.composition_title,
          mp.composer_firstname,
          mp.composer_lastname,
          mp.price,
          mp.is_free,
          mp.composer_id
        FROM user_music_cart umc
        JOIN music_publications mp
          ON umc.music_publication_id = mp.id
        WHERE umc.user_id = ?
        ORDER BY umc.added_at DESC`,
      [userId]
    );

    if (!cartItems.length) {
      return errorResponse(res, "Cart is empty", 400);
    }

    const paidItems = cartItems.filter(i => !i.is_free);

    if (!paidItems.length) {
      return errorResponse(res, "Cart contains only free items", 400);
    }

    const totalAmount = paidItems.reduce(
      (sum, item) => sum + parseFloat(item.price),
      0
    );

    /* ===============================
       VALIDATE COUPON
    =============================== */
    const couponResult = await validateAndApplyCoupon(
      mysql,
      couponCode,
      userId,
      "music"
    );

    if (couponCode && !couponResult.valid) {
      return errorResponse(res, couponResult.error || "Invalid coupon", 400);
    }

    /* ===============================
       STRIPE CUSTOMER
    =============================== */
    let stripeCustomerId = null;

    const [existingCustomer] = await mysql.execute(
      `SELECT stripe_customer_id 
         FROM payment_customers 
         WHERE user_id=? LIMIT 1`,
      [userId]
    );

    if (existingCustomer.length) {
      stripeCustomerId = existingCustomer[0].stripe_customer_id;
    }

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        metadata: {
          user_id: userId.toString(),
          purchase_type: "music",
          payment_mode: "ach",
          type: "music",
          source: "music_checkout"
        }
      });

      stripeCustomerId = customer.id;

      await mysql.execute(
        `INSERT INTO payment_customers
          (user_id, stripe_customer_id, email)
          VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE stripe_customer_id=VALUES(stripe_customer_id)`,
        [userId, stripeCustomerId, req.user.email]
      );
    }

    /* ===============================
       PRODUCTS JSON
    =============================== */
    const products = paidItems.map(item => ({
      musicPublicationId: item.music_publication_id,
      title: item.composition_title,
      composer: `${item.composer_firstname} ${item.composer_lastname}`,
      price: parseFloat(item.price)
    }));

    /* ===============================
       STRIPE LINE ITEMS
    =============================== */
    const lineItems = paidItems.map(item => ({
      price_data: {
        currency: "usd",
        product_data: {
          name: item.composition_title,
          description: `Composer: ${item.composer_firstname} ${item.composer_lastname}`
        },
        unit_amount: Math.round(parseFloat(item.price) * 100)
      },
      quantity: 1
    }));

    /* ===============================
       CREATE STRIPE SESSION
    =============================== */
    const sessionPayload = {
      payment_method_types: ["us_bank_account"],
      mode: "payment",
      customer: stripeCustomerId,
      line_items: lineItems,
      billing_address_collection: "auto",
      payment_method_options: {
        us_bank_account: {
          verification_method: "instant"
        }
      },
      success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      metadata: {
        user_id: userId.toString(),
        products: JSON.stringify(products),
        coupon_code: couponCode || "",
        payment_type: "ach",
        type: "music",
        source: "music_checkout"
      }
    };

    if (couponResult.valid && couponResult.stripeCouponId) {
      sessionPayload.discounts = [{ coupon: couponResult.stripeCouponId }];
    } else {
      sessionPayload.allow_promotion_codes = true;
    }

    const session = await stripe.checkout.sessions.create(sessionPayload);

    /* ===============================
       PENDING ORDER INSERT (user_orders)
    =============================== */
    const [orderResult] = await mysql.execute(
      `INSERT INTO user_orders 
          (user_id, total_amount, payment_status, payment_method, order_status, stripe_session_id)
         VALUES (?, ?, 'pending', 'ach', 'pending', ?)`,
      [userId, totalAmount, session.id]
    );

    const orderId = orderResult.insertId;

    /* ===============================
       PENDING TRANSACTIONS INSERT (music_transactions)
       Har paid item ke liye ek row — status = 'pending'
       Jab payment verify hogi tab 'completed' hoga
    =============================== */
    for (const item of paidItems) {
      await mysql.execute(
        `INSERT INTO music_transactions (
            user_id,
            music_publication_id,
            stripe_session_id,
            stripe_customer_id,
            amount,
            currency,
            status,
            payment_method,
            composition_title,
            composer_name,
            created_at
          ) VALUES (?, ?, ?, ?, ?, 'usd', 'pending', 'ach', ?, ?, NOW())`,
        [
          userId,
          item.music_publication_id,
          session.id,
          stripeCustomerId,
          parseFloat(item.price),
          item.composition_title,
          `${item.composer_firstname} ${item.composer_lastname}`
        ]
      );
    }

    /* ===============================
       RESPONSE
    =============================== */
    return successResponse(res, {
      sessionId: session.id,
      sessionUrl: session.url,
      orderId,
      products,
      totalAmount
    }, "ACH checkout session created successfully");

  } catch (err) {
    console.error("ACH checkout error:", err);
    return errorResponse(res, "Failed to create ACH checkout session", 500);
  }
});


/* ==========================================
   CREATE CARD CHECKOUT SESSION
========================================== */
router.post("/create-card-checkout-session", auth, async (req, res) => {
  try {
    const mysql = getMySQLConnection();
    const userId = req.user.userId || req.user.id;

    const { successUrl, cancelUrl, couponCode } = req.body;

    if (!successUrl || !cancelUrl) {
      return errorResponse(res, "Success URL and Cancel URL required", 400);
    }

    /* ===============================
       FETCH CART
    =============================== */

    const [cartItems] = await mysql.execute(`
      SELECT 
        umc.*,
        mp.composition_title,
        mp.composer_firstname,
        mp.composer_lastname,
        mp.price,
        mp.is_free
      FROM user_music_cart umc
      JOIN music_publications mp
      ON umc.music_publication_id = mp.id
      WHERE umc.user_id = ?
    `, [userId]);

    if (!cartItems.length) {
      return errorResponse(res, "Cart empty", 400);
    }

    const paidItems = cartItems.filter(i => !i.is_free);

    if (!paidItems.length) {
      return errorResponse(res, "Cart contains only free items", 400);
    }

    /* ===============================
       TOTAL AMOUNT
    =============================== */

    const totalAmount = paidItems.reduce(
      (sum, item) => sum + parseFloat(item.price),
      0
    );

    /* ===============================
       🎯 COUPON (FIXED LIKE PAYMENT API)
    =============================== */

    let stripeCouponId = null;

    if (couponCode) {

      const [[coupon]] = await mysql.execute(`
        SELECT * FROM coupons
        WHERE code = ?
          AND status = 'active'
          AND coupon_for = 'music'
          AND (valid_from IS NULL OR valid_from <= NOW())
          AND (valid_till IS NULL OR valid_till >= NOW())
      `, [couponCode.trim()]);
      console.log(coupon)
      if (!coupon) {
        return errorResponse(res, "Invalid or expired coupon", 400);
      }

      /* ---------- PER USER LIMIT ---------- */
      const [userUses] = await mysql.execute(`
        SELECT COUNT(*) as total
        FROM coupons
        WHERE code = ? AND user_id = ?
      `, [couponCode.trim(), userId]);

      if (
        coupon.max_uses_per_user !== null &&
        userUses[0].total >= coupon.max_uses_per_user
      ) {
        return errorResponse(res, "You already used this coupon", 400);
      }

      /* ---------- TOTAL LIMIT ---------- */
      if (coupon.max_total_uses !== null) {
        const [totalUses] = await mysql.execute(`
          SELECT COUNT(*) as total
          FROM coupons
          WHERE code = ? AND user_id IS NOT NULL
        `, [couponCode.trim()]);

        if (totalUses[0].total >= coupon.max_total_uses) {
          return errorResponse(res, "Coupon usage limit reached", 400);
        }
      }

      /* ---------- CREATE STRIPE COUPON ---------- */
      const stripeCoupon = await stripe.coupons.create({
        name: coupon.code,
        duration: "once",
        ...(coupon.discount_type === "percentage"
          ? { percent_off: coupon.discount_value }
          : {
            amount_off: Math.round(coupon.discount_value * 100),
            currency: "usd"
          })
      });

      stripeCouponId = stripeCoupon.id;
    }

    /* ===============================
       STRIPE CUSTOMER
    =============================== */

    let stripeCustomerId = null;

    const [customer] = await mysql.execute(
      `SELECT stripe_customer_id FROM payment_customers WHERE user_id=? LIMIT 1`,
      [userId]
    );

    if (customer.length) {
      stripeCustomerId = customer[0].stripe_customer_id;
    }

    if (!stripeCustomerId) {
      const c = await stripe.customers.create({
        email: req.user.email,
        metadata: { user_id: userId.toString() }
      });

      stripeCustomerId = c.id;

      await mysql.execute(
        `INSERT INTO payment_customers(user_id,stripe_customer_id,email)
         VALUES(?,?,?)
         ON DUPLICATE KEY UPDATE stripe_customer_id=VALUES(stripe_customer_id)`,
        [userId, stripeCustomerId, req.user.email]
      );
    }

    /* ===============================
       PRODUCTS
    =============================== */

    const products = paidItems.map(i => ({
      musicPublicationId: i.music_publication_id,
      title: i.composition_title,
      price: parseFloat(i.price)
    }));

    /* ===============================
       TAX
    =============================== */

    const taxRate = await stripe.taxRates.create({
      display_name: "Service Tax",
      percentage: 2.7,
      inclusive: false
    });

    /* ===============================
       LINE ITEMS
    =============================== */

    const lineItems = paidItems.map(item => ({
      price_data: {
        currency: "usd",
        product_data: {
          name: item.composition_title,
          description: `${item.composer_firstname} ${item.composer_lastname}`
        },
        unit_amount: Math.round(parseFloat(item.price) * 100)
      },
      quantity: 1,
      tax_rates: [taxRate.id]
    }));

    /* ===============================
       CREATE SESSION
    =============================== */

    const session = await stripe.checkout.sessions.create({

      payment_method_types: ["card"],
      mode: "payment",
      customer: stripeCustomerId,
      line_items: lineItems,

      // ✅ COUPON APPLY HERE
      discounts: stripeCouponId ? [{ coupon: stripeCouponId }] : [],

      success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,

      metadata: {
        user_id: userId.toString(),
        products: JSON.stringify(products),
        coupon_code: couponCode || "",
        type: "music",
        source: "music_checkout"
      }
    });

    /* ===============================
       SAVE TRANSACTION
    =============================== */

    await mysql.execute(
      `INSERT INTO music_transactions(
        user_id,
        stripe_session_id,
        stripe_customer_id,
        total_amount,
        currency,
        status,
        payment_method,
        products_json,
        coupon_code,
        created_at
      )
      VALUES(?,?,?,?,?,'pending','stripe',?,?,NOW())`,
      [
        userId,
        session.id,
        stripeCustomerId,
        totalAmount,
        "usd",
        JSON.stringify(products),
        couponCode || null
      ]
    );

    return successResponse(res, {
      sessionId: session.id,
      sessionUrl: session.url,
      totalAmount
    });

  } catch (err) {
    console.error(err);
    return errorResponse(res, "Checkout session create failed", 500);
  }
});

// @route   POST /api/user-music-library/complete-free-order
// @desc    Complete order for free items only
// @access  Private
async function completeFreeOrder(req, res, cartItems) {
  try {
    const mysqlConnection = getMySQLConnection();
    const userId = req.user.userId || req.user.id;

    // Create order record
    const [orderResult] = await mysqlConnection.execute(`
      INSERT INTO user_orders (user_id, total_amount, payment_status, payment_method, order_status)
      VALUES (?, ?, ?, ?, ?)
    `, [userId, 0, 'completed', 'free', 'completed']);

    const orderId = orderResult.insertId;

    // Add items to user's music library
    for (const cartItem of cartItems) {
      const fileData = JSON.parse(cartItem.file_data);

      for (const file of fileData) {
        await mysqlConnection.execute(`
          INSERT INTO user_music_library (user_id, music_publication_id, file_type, file_name, file_url, file_size, price, purchase_date)
          VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
        `, [
          userId,
          cartItem.music_publication_id,
          file.type || file.fileType || file.file_type || 'unknown',
          file.name || file.fileName || file.file_name || 'Unknown File',
          file.url || file.fileUrl || file.file_url || '',
          file.size || file.fileSize || file.file_size || 0,
          cartItem.price
        ]);
      }
    }

    // Clear cart
    await mysqlConnection.execute(
      'DELETE FROM user_music_cart WHERE user_id = ?',
      [userId]
    );

    successResponse(res, {
      orderId: orderId,
      totalAmount: 0,
      itemCount: cartItems.length,
      message: 'Free order completed successfully'
    }, 'Order completed successfully');

  } catch (error) {
    console.error('Complete free order error:', error);
    errorResponse(res, 'Failed to complete free order', 500);
  }
}

// @route   POST /api/user-music-library/webhook
// @desc    Handle Stripe webhook for music purchase
// @access  Public

router.post("/webhook", express.raw({ type: "application/json" }),
  async (req, res) => {

    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.log("❌ Webhook signature error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log("🎯 Music webhook event:", event.type);

    const mysql = getMySQLConnection();

    try {

      switch (event.type) {

        /* =====================================================
           ✅ CHECKOUT COMPLETED (MAIN LOGIC)
        ===================================================== */
        case "checkout.session.completed": {

          const session = event.data.object;

          if (session.payment_status !== "paid") {
            console.log("❌ Payment not completed yet");
            break;
          }

          const userId = Number(session.metadata.user_id);

          console.log("💰 PAYMENT RECEIVED:", {
            sessionId: session.id,
            userId,
            amount: session.amount_total / 100
          });

          let products = [];

          try {
            products = JSON.parse(session.metadata.products || "[]");
          } catch {
            products = [];
          }

          if (!products.length) {
            console.log("❌ No products found");
            break;
          }

          const finalAmount = session.amount_total / 100;

          /* ================================
             TRANSACTION (same as before)
          ================================ */

          const [[existingTx]] = await mysql.execute(
            `SELECT id FROM music_transactions
             WHERE stripe_session_id = ?
             LIMIT 1`,
            [session.id]
          );

          let transactionId;

          if (existingTx) {
            transactionId = existingTx.id;

            await mysql.execute(
              `UPDATE music_transactions
               SET status='completed', updated_at=NOW()
               WHERE id=?`,
              [transactionId]
            );

          } else {
            const [tx] = await mysql.execute(
              `INSERT INTO music_transactions(
                user_id,
                stripe_session_id,
                stripe_payment_intent_id,
                stripe_customer_id,
                total_amount,
                currency,
                status,
                payment_method,
                products_json,
                created_at,
                completed_at
              )
              VALUES(?,?,?,?,?,'usd','completed','stripe',?,NOW(),NOW())`,
              [
                userId,
                session.id,
                session.payment_intent || null,
                session.customer,
                finalAmount,
                JSON.stringify(products)
              ]
            );

            transactionId = tx.insertId;
          }

          /* ================================
             INSERT MUSIC (same as before)
          ================================ */

          for (const item of products) {

            const musicId = item.musicPublicationId;

            const [[music]] = await mysql.execute(
              `SELECT * FROM music_publications
               WHERE id=? AND status='published'`,
              [musicId]
            );

            if (!music) continue;

            const [exists] = await mysql.execute(
              `SELECT id FROM user_music_library
               WHERE user_id=? AND music_publication_id=?`,
              [userId, musicId]
            );

            if (exists.length) continue;

            await mysql.execute(
              `INSERT INTO user_music_library
              (user_id, music_publication_id, file_name, file_url, price, purchase_date)
              VALUES (?,?,?,?,?,NOW())`,
              [
                userId,
                musicId,
                music.composition_title,
                "",
                item.price
              ]
            );
          }

          /* ================================
             CLEAR CART
          ================================ */

          await mysql.execute(
            `DELETE FROM user_music_cart WHERE user_id=?`,
            [userId]
          );

          console.log("🎉 Music added to library successfully");

          /* ================================
             📧 SEND EMAIL
          ================================ */

          try {

            await sendEmail({
              to: "kevin.digitalgrowthus@gmail.com",
              subject: "🎉 New Music Purchase (Webhook)",
              html: `
                <div>
                  <h2>🎶 New Payment Received</h2>
        
                  <p><strong>User ID:</strong> ${userId}</p>
                  <p><strong>Amount:</strong> $${finalAmount}</p>
                  <p><strong>Session ID:</strong> ${session.id}</p>
        
                  <p><strong>Products:</strong></p>
                  <pre>${JSON.stringify(products, null, 2)}</pre>
        
                  <br/>
        
                  <p>✅ Payment processed via webhook</p>
        
                  <br/>
        
                  <p>Regards,<br/>Webhook System</p>
                </div>
              `
            });

            console.log("📧 Email sent successfully");

          } catch (emailErr) {
            console.log("❌ Email error:", emailErr.message);
          }

          break;
        }

        default:
          console.log(`Unhandled event: ${event.type}`);
      }

      return res.status(200).json({ received: true });

    } catch (error) {
      console.log("❌ WEBHOOK PROCESS ERROR:", error);
      return res.status(500).send("Webhook handler failed");
    }
  }
);

// Handle checkout completion
async function handleCheckoutCompleted(session) {
  const mysqlConnection = getMySQLConnection();

  try {
    console.log('🎯 USER-MUSIC-LIBRARY: Processing checkout completion for session:', session.id);
    console.log('🎯 Session metadata:', session.metadata);

    const { userId, cartItems } = session.metadata;
    const parsedCartItems = JSON.parse(cartItems);

    console.log('🎯 Creating order for user:', userId, 'with amount:', session.amount_total / 100);
    console.log('🎯 Cart items:', parsedCartItems);

    // Create order record
    const [orderResult] = await mysqlConnection.execute(`
      INSERT INTO user_orders (user_id, total_amount, payment_status, payment_method, order_status, stripe_session_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      userId,
      session.amount_total / 100, // Convert from cents
      'completed',
      'stripe',
      'completed',
      session.id
    ]);

    const orderId = orderResult.insertId;
    console.log('Order created with ID:', orderId);

    // Add items to user's music library
    for (const cartItem of parsedCartItems) {
      const [cartItemData] = await mysqlConnection.execute(`
        SELECT file_data FROM user_music_cart WHERE id = ?
      `, [cartItem.id]);

      if (cartItemData.length > 0) {
        const fileData = JSON.parse(cartItemData[0].file_data);

        for (const file of fileData) {
          await mysqlConnection.execute(`
            INSERT INTO user_music_library (user_id, music_publication_id, file_type, file_name, file_url, file_size, price, purchase_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
          `, [
            userId,
            cartItem.music_publication_id,
            file.type || file.fileType || file.file_type || 'unknown',
            file.name || file.fileName || file.file_name || 'Unknown File',
            file.url || file.fileUrl || file.file_url || '',
            file.size || file.fileSize || file.file_size || 0,
            cartItem.price
          ]);
        }
      }
    }

    // Update music_transactions status to completed
    await mysqlConnection.execute(`
      UPDATE music_transactions 
      SET status = 'completed', updated_at = NOW()
      WHERE stripe_session_id = ? AND status = 'pending'
    `, [session.id]);

    // Clear cart
    await mysqlConnection.execute(
      'DELETE FROM user_music_cart WHERE user_id = ?',
      [userId]
    );

    console.log(`Order ${orderId} completed for user ${userId}`);
  } catch (error) {
    console.error('Error handling checkout completion:', error);
    throw error;
  }
}

// @route   GET /api/user-music-library/orders/:orderId
// @desc    Get specific order details
// @access  Private
router.get('/orders/:orderId', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const userId = req.user.userId || req.user.id;
    const { orderId } = req.params;

    const [orders] = await mysqlConnection.execute(`
      SELECT 
        id,
        total_amount,
        payment_status,
        payment_method,
        order_status,
        stripe_session_id,
        created_at,
        updated_at
      FROM user_orders 
      WHERE id = ? AND user_id = ?
    `, [orderId, userId]);

    if (orders.length === 0) {
      return errorResponse(res, 'Order not found', 404);
    }

    const order = orders[0];

    // Prefer pulling items from music_transactions with full publication details
    let musicTransactions = [];
    if (order.stripe_session_id) {
      const [tx] = await mysqlConnection.execute(`
        SELECT 
          mt.id,
          mt.music_publication_id,
          mt.amount,
          mt.currency,
          mt.status,
          mt.completed_at,
          mt.created_at,
          mp.id as publication_id,
          mp.composer_id,
          mp.status as publication_status,
          mp.composition_title as full_composition_title,
          mp.composition_description,
          mp.composer_firstname,
          mp.composer_lastname,
          mp.composition_title_1,
          mp.is_part_of_collection,
          mp.collection_id,
          mp.collection_name,
          mp.vocal_parts,
          mp.instrumentation,
          mp.types_of_music,
          mp.first_line_of_composition,
          mp.composition_copyrights,
          mp.song_type,
          mp.meter,
          mp.season,
          mp.psalm_number,
          mp.liturgicalText,
          mp.verseStyle,
          mp.feast,
          mp.text_copyright_notice,
          mp.tune_copyright_notice,
          mp.artists,
          mp.music_files,
          mp.artwork_file_url,
          mp.artwork_file_size,
          mp.price,
          mp.is_free,
          mp.terms_accepted,
          mp.terms_accepted_at,
          mp.onelicense_verified_by,
          mp.onelicense_verified_at,
          mp.onelicense_verification_notes,
          mp.sl_team_reviewed_by,
          mp.sl_team_reviewed_at,
          mp.sl_team_review_notes,
          mp.rejection_reason,
          mp.published_at,
          mp.published_by,
          mp.created_at as publication_created_at,
          mp.updated_at as publication_updated_at
        FROM music_transactions mt
        LEFT JOIN music_publications mp ON mt.music_publication_id = mp.id
        WHERE mt.stripe_session_id = ?
      `, [order.stripe_session_id]);

      musicTransactions = tx.map(t => ({
        transactionId: t.id,
        musicPublicationId: t.music_publication_id,
        amount: parseFloat(t.amount),
        currency: t.currency,
        status: t.status,
        completedAt: t.completed_at,
        createdAt: t.created_at,
        publication: t.publication_id ? {
          id: t.publication_id,
          composerId: t.composer_id,
          status: t.publication_status,
          compositionTitle: t.full_composition_title,
          compositionDescription: t.composition_description,
          composerFirstName: t.composer_firstname,
          composerLastName: t.composer_lastname,
          compositionTitle1: t.composition_title_1,
          isPartOfCollection: t.is_part_of_collection,
          collectionId: t.collection_id,
          collectionName: t.collection_name,
          vocalParts: parseJsonSafe(t.vocal_parts, []),
          instrumentation: parseJsonSafe(t.instrumentation, []),
          typesOfMusic: t.types_of_music,
          firstLineOfComposition: t.first_line_of_composition,
          compositionCopyrights: parseJsonSafe(t.composition_copyrights, []),
          songType: t.song_type,
          meter: t.meter,
          season: t.season,
          psalmNumber: t.psalm_number,
          liturgicalText: t.liturgicalText,
          verseStyle: t.verseStyle,
          feast: t.feast,
          textCopyrightNotice: t.text_copyright_notice,
          tuneCopyrightNotice: t.tune_copyright_notice,
          artists: parseJsonSafe(t.artists, []),
          musicFiles: parseJsonSafe(t.music_files, []),
          artworkFileUrl: t.artwork_file_url,
          artworkFileSize: t.artwork_file_size,
          price: t.price,
          isFree: t.is_free,
          termsAccepted: t.terms_accepted,
          termsAcceptedAt: t.terms_accepted_at,
          onelicenseVerifiedBy: t.onelicense_verified_by,
          onelicenseVerifiedAt: t.onelicense_verified_at,
          onelicenseVerificationNotes: t.onelicense_verification_notes,
          slTeamReviewedBy: t.sl_team_reviewed_by,
          slTeamReviewedAt: t.sl_team_reviewed_at,
          slTeamReviewNotes: t.sl_team_review_notes,
          rejectionReason: t.rejection_reason,
          publishedAt: t.published_at,
          publishedBy: t.published_by,
          createdAt: t.publication_created_at,
          updatedAt: t.publication_updated_at
        } : null
      }));
    }

    successResponse(res, {
      order: {
        id: order.id,
        totalAmount: parseFloat(order.total_amount),
        paymentStatus: order.payment_status,
        paymentMethod: order.payment_method,
        orderStatus: order.order_status,
        stripeSessionId: order.stripe_session_id,
        createdAt: order.created_at,
        updatedAt: order.updated_at
      },
      musicTransactions
    }, 'Order details retrieved successfully');

  } catch (error) {
    console.error('Get order details error:', error);
    errorResponse(res, 'Failed to get order details', 500);
  }
});

// @route   GET /api/user-music-library/payment-status/:sessionId
// @desc    Finalize music order + files + coupon (IDEMPOTENT)
// @access  Private
// @route   GET /api/user-music-library/payment-status/:sessionId
// @desc    Verify payment + add music to library
// @access  Private

router.get("/payment-status/:sessionId", auth, async (req, res) => {

  try {

    const mysql = getMySQLConnection();
    const { sessionId } = req.params;

    console.log("🔍 PAYMENT STATUS CHECK", { sessionId });

    /* =====================================
       1️⃣ FETCH STRIPE SESSION
    ===================================== */

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const insertedLibraryItems = [];


    if (!session) {
      return errorResponse(res, "Stripe session not found", 404);
    }

    if (session.payment_status !== "paid") {
      return errorResponse(res, "Payment not completed yet", 400);
    }

    const userId = Number(session.metadata.user_id);

    /* =====================================
       2️⃣ PRODUCTS FROM METADATA
    ===================================== */

    let products = [];

    try {
      products = JSON.parse(session.metadata.products || "[]");
    } catch {
      products = [];
    }

    if (!products.length) {
      return errorResponse(res, "No purchased songs found", 400);
    }

    /* =====================================
       3️⃣ FINAL STRIPE AMOUNT
    ===================================== */

    const finalAmount = session.amount_total / 100;

    /* =====================================
       4️⃣ CHECK TRANSACTION
    ===================================== */

    const [[existingTx]] = await mysql.execute(

      `SELECT id FROM music_transactions
       WHERE stripe_session_id = ?
       LIMIT 1`,

      [sessionId]

    );

    let transactionId;

    if (existingTx) {

      transactionId = existingTx.id;

      await mysql.execute(

        `UPDATE music_transactions
         SET
           stripe_payment_intent_id = ?,
           total_amount = ?,
           currency = ?,
           status = 'completed',
           completed_at = NOW(),
           updated_at = NOW()
         WHERE id = ?`,

        [
          session.payment_intent || null,
          finalAmount,
          session.currency || "usd",
          transactionId
        ]

      );

    } else {

      const [tx] = await mysql.execute(

        `INSERT INTO music_transactions(
          user_id,
          stripe_session_id,
          stripe_payment_intent_id,
          stripe_customer_id,
          total_amount,
          currency,
          status,
          payment_method,
          products_json,
          coupon_code,
          created_at,
          completed_at
        )
        VALUES(?,?,?,?,?,'usd','completed','stripe',?,?,NOW(),NOW())`,

        [
          userId,
          session.id,
          session.payment_intent || null,
          session.customer,
          finalAmount,
          JSON.stringify(products),
          session.metadata.coupon_code || null
        ]

      );

      transactionId = tx.insertId;

    }

    /* =====================================
       5️⃣ INSERT MUSIC INTO LIBRARY
    ===================================== */

    for (const item of products) {

      const musicId = item.musicPublicationId;

      const [[music]] = await mysql.execute(

        `SELECT * FROM music_publications
         WHERE id=? AND status='published'`,

        [musicId]

      );

      if (!music) continue;

      /* Duplicate check */

      const [exists] = await mysql.execute(

        `SELECT id FROM user_music_library
         WHERE user_id=? AND music_publication_id=?`,

        [userId, musicId]

      );

      if (exists.length) {
        // Already exists - phir bhi response mein include karo
        insertedLibraryItems.push({
          musicId,
          composition_title: music.composition_title,
          price: item.price,
          user_id: userId,
          alreadyOwned: true   // flag lagao taaki pata chale
        });
        continue;
      }

      /* Parse music files */

      let musicFiles = [];

      try {

        musicFiles = music.music_files
          ? JSON.parse(music.music_files)
          : [];

      } catch {

        musicFiles = [];

      }

      const primaryFile = musicFiles[0] || {};

      const fileName =
        primaryFile.fileName ||
        music.composition_title ||
        "music-file";

      const fileUrl =
        primaryFile.fileUrl ||
        primaryFile.url ||
        "";


      const fileSize =
        primaryFile.fileSize ||
        primaryFile.size ||
        null;

      const validFileTypes = ['assembly', 'octavo', 'chords', 'music_lyrics', 'mp3', 'pdf', 'music'];
      let fileType = primaryFile.fileType || primaryFile.type || 'music';
      if (!validFileTypes.includes(fileType)) {
        fileType = 'music';
      }
      const price = parseFloat(item.price) || parseFloat(music.price);
      const safeStringify = (data) => {
        if (!data) return null;
        if (typeof data === 'string') return data;
        return JSON.stringify(data);
      };
      await mysql.execute(
        `INSERT INTO user_music_library (
          user_id, music_publication_id, file_type, file_name, file_url, file_size, price,
          composer_id, composition_title, composition_title_1, composition_description,
          composer_firstname, composer_lastname,
          is_part_of_collection, collection_id, collection_name,
          vocal_parts, instrumentation, types_of_music,
          first_line_of_composition, composition_copyrights, song_type,
          meter, season, psalm_number, liturgicalText, verseStyle, feast,
          text_copyright_notice, tune_copyright_notice,
          artists, music_files, music_video_link, artwork_file_url, artwork_file_size,
          tune, general_details, country_restrictions,
          is_public_domain, can_be_reprinted, can_be_podcast_streamed,
          can_make_commercial_recording, can_make_non_commercial_recording,
          purchase_date
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?,
          NOW()
        )`,
        [
          userId,
          musicId,
          fileType,
          fileName,
          fileUrl,
          fileSize,
          price,
          // Composer info
          music.composer_id,
          music.composition_title,
          music.composition_title_1,
          music.composition_description,
          music.composer_firstname,
          music.composer_lastname,
          // Collection info
          music.is_part_of_collection || false,
          music.collection_id || null,
          music.collection_name || null,
          // Music details
          safeStringify(music.vocal_parts),
          safeStringify(music.instrumentation),
          music.types_of_music,
          // OneLicense info
          music.first_line_of_composition,
          safeStringify(music.composition_copyrights),
          music.song_type || 'music',
          music.meter,
          music.season,
          music.psalm_number,
          music.liturgicalText,
          music.verseStyle,
          music.feast,
          // Copyright
          music.text_copyright_notice,
          music.tune_copyright_notice,
          // Artists & Files
          safeStringify(music.artists),
          safeStringify(music.music_files),
          music.music_video_link,
          music.artwork_file_url,
          music.artwork_file_size,
          // General
          music.tune,
          music.general_details,
          music.country_restrictions,
          // Permissions
          music.is_public_domain || false,
          music.can_be_reprinted || false,
          music.can_be_podcast_streamed || false,
          music.can_make_commercial_recording || false,
          music.can_make_non_commercial_recording || false
        ]
      );
      insertedLibraryItems.push({
        musicId,
        composition_title: music.composition_title,
        price: item.price,
        user_id: userId,
        alreadyOwned: false
      });
    }

    /* =====================================
       6️⃣ CLEAR CART
    ===================================== */

    await mysql.execute(

      `DELETE FROM user_music_cart WHERE user_id=?`,

      [userId]

    );

    /* =====================================
       RESPONSE
    ===================================== */

    return successResponse(

      res,

      {
        transactionId,
        stripeSessionId: sessionId,
        paidAmount: finalAmount,
        insertedLibraryItems
      },

      "🎉 Payment verified & music added to library"

    );

  }

  catch (err) {

    console.error("❌ PAYMENT STATUS ERROR:", err);

    return errorResponse(res, "Payment verification failed", 500);

  }

});

// @route   GET /api/user-music-library/cart-simple
// @desc    Get cart data directly from database (simple version)
// @access  Private
router.get('/cart-simple', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const userId = req.user.userId || req.user.id;


    // Get cart data directly
    const [cartData] = await mysqlConnection.execute(`
      SELECT 
        umc.id,
        umc.user_id,
        umc.music_publication_id,
        umc.file_data,
        umc.price,
        umc.added_at
      FROM user_music_cart umc
      WHERE umc.user_id = ?
      ORDER BY umc.added_at DESC
    `, [userId]);


    // Get publication details separately
    const [publicationData] = await mysqlConnection.execute(`
      SELECT 
        mp.id,
        mp.composition_title,
        mp.composer_firstname,
        mp.composer_lastname,
        mp.status
      FROM music_publications mp
      WHERE mp.id IN (${cartData.map(item => item.music_publication_id).join(',')})
    `);


    // Format response
    const formattedItems = cartData.map(cartItem => {
      const publication = publicationData.find(pub => pub.id === cartItem.music_publication_id);
      const fileData = JSON.parse(cartItem.file_data);

      return {
        cartId: cartItem.id,
        musicPublicationId: cartItem.music_publication_id,
        musicTitle: publication ? publication.composition_title : 'Unknown Title',
        composer: publication ? `${publication.composer_firstname} ${publication.composer_lastname}` : 'Unknown Composer',
        publicationStatus: publication ? publication.status : 'Not Found',
        fileData: fileData,
        price: parseFloat(cartItem.price),
        addedAt: cartItem.added_at
      };
    });

    const total = cartData.reduce((sum, item) => sum + parseFloat(item.price), 0);

    return successResponse(res, {
      cartItems: formattedItems,
      totalItems: cartData.length,
      totalPrice: parseFloat(total.toFixed(2)),
    }, 'Simple cart data retrieved successfully');

  } catch (error) {
    console.error('Simple cart error:', error);
    errorResponse(res, 'Failed to get simple cart data', 500);
  }
});

// @route   GET /api/user-music-library/test-cart
// @desc    Test cart API - simple version
// @access  Private
router.get('/test-cart', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const userId = req.user.userId || req.user.id;


    // Simple query to get cart data
    const [cartData] = await mysqlConnection.execute(`
      SELECT * FROM user_music_cart WHERE user_id = ?
    `, [userId]);


    // Simple response
    return res.json({
      success: true,
      message: 'Test cart API working',
      data: {
        userId: userId,
        cartCount: cartData.length,
        cartItems: cartData
      }
    });

  } catch (error) {
    console.error('Test cart error:', error);
    return res.json({
      success: false,
      message: 'Test cart API failed',
      error: error.message
    });
  }
});

// GET /api/user-music-library/cart-complete
// @desc    Get cart data with complete music publication details
// @access  Private
router.get('/cart-complete', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const userId = req.user.userId || req.user.id;

    // Get cart data directly
    const [cartData] = await mysqlConnection.execute(`
      SELECT 
        umc.id,
        umc.user_id,
        umc.music_publication_id,
        umc.file_data,
        umc.price,
        umc.added_at
      FROM user_music_cart umc
      WHERE umc.user_id = ?
      ORDER BY umc.added_at DESC
    `, [userId]);

    if (cartData.length === 0) {
      return successResponse(res, {
        cartItems: [],
        totalItems: 0,
        totalPrice: 0
      }, 'Cart is empty');
    }

    // Get complete publication details
    const publicationIds = cartData.map(item => item.music_publication_id);
    const [publicationData] = await mysqlConnection.execute(`
      SELECT 
        mp.id,
        mp.composer_id,
        mp.status,
        mp.composition_title,
        mp.composition_description,
        mp.composer_firstname,
        mp.composer_lastname,
        mp.composition_title_1,
        mp.is_part_of_collection,
        mp.collection_id,
        mp.collection_name,
        mp.vocal_parts,
        mp.instrumentation,
        mp.types_of_music,
        mp.first_line_of_composition,
        mp.composition_copyrights,
        mp.song_type,
        mp.meter,
        mp.season,
        mp.psalm_number,
        mp.liturgicalText,
        mp.verseStyle,
        mp.feast,
        mp.text_copyright_notice,
        mp.tune_copyright_notice,
        mp.artists,
        mp.music_files,
        mp.artwork_file_url,
        mp.artwork_file_size,
        mp.price,
        mp.is_free,
        mp.terms_accepted,
        mp.terms_accepted_at,
        mp.onelicense_verified_by,
        mp.onelicense_verified_at,
        mp.onelicense_verification_notes,
        mp.sl_team_reviewed_by,
        mp.sl_team_reviewed_at,
        mp.sl_team_review_notes,
        mp.rejection_reason,
        mp.published_at,
        mp.published_by,
        mp.created_at,
        mp.updated_at
      FROM music_publications mp
      WHERE mp.id IN (${publicationIds.join(',')})
    `);

    // Format response with complete details
    const formattedItems = cartData.map(cartItem => {
      const publication = publicationData.find(pub => pub.id === cartItem.music_publication_id);
      const fileData = JSON.parse(cartItem.file_data);

      return {
        cartId: cartItem.id,
        musicPublicationId: cartItem.music_publication_id,
        musicTitle: publication ? publication.composition_title : 'Unknown Title',
        composer: publication ? `${publication.composer_firstname} ${publication.composer_lastname}` : 'Unknown Composer',
        publicationStatus: publication ? publication.status : 'Not Found',
        fileData: fileData,
        price: parseFloat(cartItem.price),
        addedAt: cartItem.added_at,
        // Complete music publication details
        publication: publication ? {
          id: publication.id,
          composerId: publication.composer_id,
          status: publication.status,
          compositionTitle: publication.composition_title,
          compositionDescription: publication.composition_description,
          composerFirstName: publication.composer_firstname,
          composerLastName: publication.composer_lastname,
          compositionTitle1: publication.composition_title_1,
          isPartOfCollection: publication.is_part_of_collection,
          collectionId: publication.collection_id,
          collectionName: publication.collection_name,
          vocalParts: publication.vocal_parts ? JSON.parse(publication.vocal_parts) : [],
          instrumentation: publication.instrumentation ? JSON.parse(publication.instrumentation) : [],
          typesOfMusic: publication.types_of_music,
          firstLineOfComposition: publication.first_line_of_composition,
          compositionCopyrights: publication.composition_copyrights ? JSON.parse(publication.composition_copyrights) : [],
          songType: publication.song_type,
          meter: publication.meter,
          season: publication.season,
          psalmNumber: publication.psalm_number,
          liturgicalText: publication.liturgicalText,
          verseStyle: publication.verseStyle,
          feast: publication.feast,
          textCopyrightNotice: publication.text_copyright_notice,
          tuneCopyrightNotice: publication.tune_copyright_notice,
          artists: publication.artists ? JSON.parse(publication.artists) : [],
          musicFiles: publication.music_files ? JSON.parse(publication.music_files) : [],
          artworkFileUrl: publication.artwork_file_url,
          artworkFileSize: publication.artwork_file_size,
          price: publication.price,
          isFree: publication.is_free,
          termsAccepted: publication.terms_accepted,
          termsAcceptedAt: publication.terms_accepted_at,
          onelicenseVerifiedBy: publication.onelicense_verified_by,
          onelicenseVerifiedAt: publication.onelicense_verified_at,
          onelicenseVerificationNotes: publication.onelicense_verification_notes,
          slTeamReviewedBy: publication.sl_team_reviewed_by,
          slTeamReviewedAt: publication.sl_team_reviewed_at,
          slTeamReviewNotes: publication.sl_team_review_notes,
          rejectionReason: publication.rejection_reason,
          publishedAt: publication.published_at,
          publishedBy: publication.published_by,
          createdAt: publication.created_at,
          updatedAt: publication.updated_at
        } : null
      };
    });

    const total = cartData.reduce((sum, item) => sum + parseFloat(item.price), 0);

    return successResponse(res, {
      cartItems: formattedItems,
      totalItems: cartData.length,
      totalPrice: total
    }, 'Cart retrieved successfully');

  } catch (error) {
    console.error('Get complete cart error:', error);
    errorResponse(res, 'Failed to get cart', 500);
  }
});

// GET /api/user-music-library/cart-detailed
// @desc    Get cart data with complete music publication details
// @access  Private
router.get('/cart-detailed', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const userId = req.user.userId || req.user.id;

    // Get cart data directly
    const [cartData] = await mysqlConnection.execute(`
      SELECT 
        umc.id,
        umc.user_id,
        umc.music_publication_id,
        umc.file_data,
        umc.price,
        umc.added_at
      FROM user_music_cart umc
      WHERE umc.user_id = ?
      ORDER BY umc.added_at DESC
    `, [userId]);

    if (cartData.length === 0) {
      return successResponse(res, {
        cartItems: [],
        totalItems: 0,
        totalPrice: 0
      }, 'Cart is empty');
    }

    // Get complete publication details
    const publicationIds = cartData.map(item => item.music_publication_id);
    const [publicationData] = await mysqlConnection.execute(`
      SELECT 
        mp.id,
        mp.composer_id,
        mp.status,
        mp.composition_title,
        mp.composition_description,
        mp.composer_firstname,
        mp.composer_lastname,
        mp.composition_title_1,
        mp.is_part_of_collection,
        mp.collection_id,
        mp.collection_name,
        mp.vocal_parts,
        mp.instrumentation,
        mp.types_of_music,
        mp.first_line_of_composition,
        mp.composition_copyrights,
        mp.song_type,
        mp.meter,
        mp.season,
        mp.psalm_number,
        mp.liturgicalText,
        mp.verseStyle,
        mp.feast,
        mp.text_copyright_notice,
        mp.tune_copyright_notice,
        mp.artists,
        mp.music_files,
        mp.artwork_file_url,
        mp.artwork_file_size,
        mp.price,
        mp.is_free,
        mp.terms_accepted,
        mp.terms_accepted_at,
        mp.onelicense_verified_by,
        mp.onelicense_verified_at,
        mp.onelicense_verification_notes,
        mp.sl_team_reviewed_by,
        mp.sl_team_reviewed_at,
        mp.sl_team_review_notes,
        mp.rejection_reason,
        mp.published_at,
        mp.published_by,
        mp.created_at,
        mp.updated_at
      FROM music_publications mp
      WHERE mp.id IN (${publicationIds.join(',')})
    `);

    // Format response with complete details
    const formattedItems = cartData.map(cartItem => {
      const publication = publicationData.find(pub => pub.id === cartItem.music_publication_id);
      const fileData = JSON.parse(cartItem.file_data);

      return {
        cartId: cartItem.id,
        musicPublicationId: cartItem.music_publication_id,
        musicTitle: publication ? publication.composition_title : 'Unknown Title',
        composer: publication ? `${publication.composer_firstname} ${publication.composer_lastname}` : 'Unknown Composer',
        publicationStatus: publication ? publication.status : 'Not Found',
        fileData: fileData,
        price: parseFloat(cartItem.price),
        addedAt: cartItem.added_at,
        // Complete music publication details
        publication: publication ? {
          id: publication.id,
          composerId: publication.composer_id,
          status: publication.status,
          compositionTitle: publication.composition_title,
          compositionDescription: publication.composition_description,
          composerFirstName: publication.composer_firstname,
          composerLastName: publication.composer_lastname,
          compositionTitle1: publication.composition_title_1,
          isPartOfCollection: publication.is_part_of_collection,
          collectionId: publication.collection_id,
          collectionName: publication.collection_name,
          vocalParts: publication.vocal_parts ? JSON.parse(publication.vocal_parts) : [],
          instrumentation: publication.instrumentation ? JSON.parse(publication.instrumentation) : [],
          typesOfMusic: publication.types_of_music,
          firstLineOfComposition: publication.first_line_of_composition,
          compositionCopyrights: publication.composition_copyrights ? JSON.parse(publication.composition_copyrights) : [],
          songType: publication.song_type,
          meter: publication.meter,
          season: publication.season,
          psalmNumber: publication.psalm_number,
          liturgicalText: publication.liturgicalText,
          verseStyle: publication.verseStyle,
          feast: publication.feast,
          textCopyrightNotice: publication.text_copyright_notice,
          tuneCopyrightNotice: publication.tune_copyright_notice,
          artists: publication.artists ? JSON.parse(publication.artists) : [],
          musicFiles: publication.music_files ? JSON.parse(publication.music_files) : [],
          artworkFileUrl: publication.artwork_file_url,
          artworkFileSize: publication.artwork_file_size,
          price: publication.price,
          isFree: publication.is_free,
          termsAccepted: publication.terms_accepted,
          termsAcceptedAt: publication.terms_accepted_at,
          onelicenseVerifiedBy: publication.onelicense_verified_by,
          onelicenseVerifiedAt: publication.onelicense_verified_at,
          onelicenseVerificationNotes: publication.onelicense_verification_notes,
          slTeamReviewedBy: publication.sl_team_reviewed_by,
          slTeamReviewedAt: publication.sl_team_reviewed_at,
          slTeamReviewNotes: publication.sl_team_review_notes,
          rejectionReason: publication.rejection_reason,
          publishedAt: publication.published_at,
          publishedBy: publication.published_by,
          createdAt: publication.created_at,
          updatedAt: publication.updated_at
        } : null
      };
    });

    const total = cartData.reduce((sum, item) => sum + parseFloat(item.price), 0);

    return successResponse(res, {
      cartItems: formattedItems,
      totalItems: cartData.length,
      totalPrice: total
    }, 'Cart retrieved successfully');

  } catch (error) {
    console.error('Get detailed cart error:', error);
    errorResponse(res, 'Failed to get cart', 500);
  }
});

// @route   GET /api/user-music-library/my-payments
// @desc    Get logged-in user's music payment history with Stripe session and coupon details
// @access  Private
router.get("/my-payments", auth, async (req, res) => {
  try {

    const mysql = getMySQLConnection();
    const userId = req.user.userId || req.user.id;

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const offset = (page - 1) * limit;

    /* =============================
       FETCH PAYMENTS
    ============================= */

    const [rows] = await mysql.execute(

      `
      SELECT
        id,
        stripe_session_id,
        stripe_payment_intent_id,
        total_amount,
        currency,
        status,
        payment_method,
        products_json,
        coupon_code,
        created_at,
        completed_at
      FROM music_transactions
      WHERE user_id = ?
      AND status = 'completed'
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
      `,
      [userId, limit, offset]

    );

    let totalSpent = 0;

    const payments = [];

    for (const tx of rows) {

      totalSpent += Number(tx.total_amount || 0);

      /* =============================
         PARSE SONGS
      ============================= */

      let songs = [];

      try {

        songs = tx.products_json
          ? JSON.parse(tx.products_json)
          : [];

      } catch {

        songs = [];

      }

      /* =============================
         BUILD SONG LIST
      ============================= */

      const musicList = songs.map(song => ({

        id: song.musicPublicationId,
        title: song.title || null,
        composer: song.composer || null,
        price: song.price

      }));

      /* =============================
         RESPONSE OBJECT
      ============================= */

      payments.push({

        transactionId: tx.id,

        songs: musicList,

        payment: {
          amount: parseFloat(tx.total_amount),
          currency: tx.currency,
          method: tx.payment_method,
          status: tx.status
        },

        stripe: {
          sessionId: tx.stripe_session_id,
          paymentIntent: tx.stripe_payment_intent_id
        },

        coupon: tx.coupon_code || null,

        dates: {
          created: tx.created_at,
          completed: tx.completed_at
        }

      });

    }

    /* =============================
       FINAL RESPONSE
    ============================= */

    return successResponse(

      res,

      {
        payments,
        totalPayments: payments.length,
        totalSpent
      },

      "User payment history fetched successfully"

    );

  }

  catch (error) {

    console.error("USER PAYMENT ERROR:", error);

    return errorResponse(res, "Failed to fetch user payments", 500);

  }

});

// @route   GET /api/user-music-library/music-payments
// @desc    Get all music payment transactions with pagination
// @access  Private (Admin)
router.get("/music-payments", auth, async (req, res) => {
  try {
    const mysql = getMySQLConnection();

    /* =============================
       PAGINATION
    ============================= */
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    /* =============================
       SORTING PARAMS
    ============================= */
    const sortBy = req.query.sortBy || "date";
    const order = req.query.order === "asc" ? "ASC" : "DESC";

    /* =============================
       COLUMN MAPPING (SAFE)
    ============================= */
    const sortColumns = {
      name: "u.first_name",
      email: "u.email",
      amount: "mt.total_amount",
      paymentType: "mt.payment_method",
      status: "mt.status",
      date: "mt.created_at"
    };

    // JS-level sort fields (JSON fields — can't sort in SQL)
    const jsSortFields = ["composer", "composition", "songId", "musicId"];

    const sortColumn = sortColumns[sortBy] || "mt.created_at";

    /* =============================
       TOTAL COUNT
    ============================= */
    const [countRows] = await mysql.execute(
      `SELECT COUNT(*) AS total FROM music_transactions`
    );

    const total = countRows[0].total;

    /* =============================
       FETCH PAYMENTS
    ============================= */
    const [rows] = await mysql.execute(
      `SELECT
        mt.id,
        mt.user_id,
        mt.total_amount,
        mt.currency,
        mt.status,
        mt.payment_method,
        mt.products_json,
        mt.stripe_session_id,
        mt.stripe_payment_intent_id,
        mt.coupon_code,
        mt.created_at,
        mt.completed_at,

        u.first_name,
        u.last_name,
        u.email,
        u.phone

      FROM music_transactions mt
      LEFT JOIN users u 
        ON u.id = mt.user_id

      ORDER BY ${jsSortFields.includes(sortBy) ? "mt.created_at" : sortColumn} ${order}
      LIMIT ? OFFSET ?`,
      [limit, offset]
    );

    const payments = [];

    for (const tx of rows) {
      /* =============================
         PARSE PRODUCTS JSON
      ============================= */
      let songs = [];

      try {
        songs = tx.products_json
          ? JSON.parse(tx.products_json)
          : [];
      } catch (e) {
        songs = [];
      }

      /* =============================
         BUILD SONG LIST
      ============================= */
      const musicList = songs.map(song => ({
        id: song.musicPublicationId,
        title: song.title || null,
        composer: song.composer || null,
        price: song.price
      }));

      /* =============================
         RESPONSE OBJECT
      ============================= */
      payments.push({
        transactionId: tx.id,

        user: {
          id: tx.user_id,
          name: `${tx.first_name || ""} ${tx.last_name || ""}`.trim(),
          email: tx.email,
          phone: tx.phone
        },

        songs: musicList,

        payment: {
          amount: parseFloat(tx.total_amount),
          currency: tx.currency,
          status: tx.status,
          method: tx.payment_method
        },

        stripe: {
          sessionId: tx.stripe_session_id,
          paymentIntent: tx.stripe_payment_intent_id
        },

        coupon: {
          code: tx.coupon_code || null
        },

        createdAt: tx.created_at,
        completedAt: tx.completed_at
      });
    }

    /* =============================
       JS SORTING (FOR JSON FIELDS)
       composer / composition / songId
    ============================= */

    // Sort by composer name (first song)
    if (sortBy === "composer") {
      payments.sort((a, b) => {
        const compA = a.songs[0]?.composer || "";
        const compB = b.songs[0]?.composer || "";
        return order === "ASC"
          ? compA.localeCompare(compB)
          : compB.localeCompare(compA);
      });
    }

    // Sort by composition title (first song)
    if (sortBy === "composition") {
      payments.sort((a, b) => {
        const titleA = a.songs[0]?.title || "";
        const titleB = b.songs[0]?.title || "";
        return order === "ASC"
          ? titleA.localeCompare(titleB)
          : titleB.localeCompare(titleA);
      });
    }

    // Sort by song/music ID (first song) — numeric sort
    if (sortBy === "songId" || sortBy === "musicId") {
      payments.sort((a, b) => {
        const idA = parseInt(a.songs[0]?.id) || 0;
        const idB = parseInt(b.songs[0]?.id) || 0;
        return order === "ASC" ? idA - idB : idB - idA;
      });
    }

    /* =============================
       FINAL RESPONSE
    ============================= */
    return successResponse(
      res,
      {
        payments,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      },
      "Admin music payments fetched successfully"
    );

  } catch (error) {
    console.error("ADMIN PAYMENT ERROR:", error);
    return errorResponse(res, "Failed to fetch payments", 500);
  }
});

const ExcelJS = require("exceljs");

router.get("/music-payments/export", async (req, res) => {
  try {
    const mysql = getMySQLConnection();
    const convertDate = (date) => {
      if (!date) return null;
      // YYYY-MM-DD
      if (date.includes("-")) return date;
      // MM/DD/YYYY
      const [month, day, year] = date.split("/");
      return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    };

    const start = convertDate(req.query.startDate);
    const end = convertDate(req.query.endDate);

    console.log("========== EXPORT START ==========");
    console.log("Raw Query:", req.query);
    console.log("Converted Start:", start);
    console.log("Converted End:", end);

    let whereClause = "";
    const params = [];

    if (start && end) {
      whereClause = `WHERE DATE(mt.created_at) BETWEEN ? AND ?`;
      params.push(start, end);
    }

    const sql = `SELECT mt.id, mt.user_id, mt.total_amount, mt.currency, mt.status,
        mt.payment_method, mt.products_json, mt.stripe_session_id, mt.stripe_payment_intent_id, mt.coupon_code, mt.created_at, mt.completed_at,
        u.first_name, u.last_name, u.email, u.phone
        FROM music_transactions mt LEFT JOIN users u ON u.id = mt.user_id
        ${whereClause} ORDER BY mt.created_at DESC
    `;

    console.log("SQL:");
    console.log(sql);
    console.log("Params:", params);

    const [rows] = await mysql.execute(sql, params);
    console.log("Rows Found:", rows.length);
    if (rows.length) {
      console.log("First Row:");
      console.log(rows[0]);
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Music Payments");
    worksheet.columns = [
      { header: "Transaction ID", key: "transactionId", width: 18 },
      { header: "User ID", key: "userId", width: 12 },
      { header: "Customer Name", key: "name", width: 25 },
      { header: "Email", key: "email", width: 30 },
      { header: "Phone", key: "phone", width: 18 },
      { header: "Song IDs", key: "songIds", width: 25 },
      { header: "Song Titles", key: "titles", width: 60 },
      { header: "Composers", key: "composers", width: 40 },
      { header: "Amount", key: "amount", width: 12 },
      { header: "Currency", key: "currency", width: 10 },
      { header: "Status", key: "status", width: 15 },
      { header: "Payment Method", key: "method", width: 15 },
      { header: "Coupon", key: "coupon", width: 20 },
      { header: "Stripe Session", key: "session", width: 40 },
      { header: "Payment Intent", key: "intent", width: 40 },
      { header: "Created At", key: "createdAt", width: 25 },
      { header: "Completed At", key: "completedAt", width: 25 },
    ];

    worksheet.getRow(1).font = {
      bold: true,
    };
    let totalAdded = 0;
    for (const tx of rows) {
      console.log("Adding Transaction:", tx.id);
      let songs = [];
      try {
        songs = tx.products_json ? JSON.parse(tx.products_json) : [];
      } catch (err) {
        console.log("JSON Parse Error:", err);
        songs = [];
      }
      const row = worksheet.addRow({
        transactionId: tx.id,
        userId: tx.user_id,
        name: `${tx.first_name || ""} ${tx.last_name || ""}`.trim(),
        email: tx.email,
        phone: tx.phone,
        songIds: songs.map(x => x.musicPublicationId).join(", "),
        titles: songs.map(x => x.title).join(", "),
        composers: songs.map(x => x.composer).join(", "),
        amount: tx.total_amount,
        currency: tx.currency,
        status: tx.status,
        method: tx.payment_method,
        coupon: tx.coupon_code,
        session: tx.stripe_session_id,
        intent: tx.stripe_payment_intent_id,
        createdAt: tx.created_at,
        completedAt: tx.completed_at,
      });

      console.log("Excel Row:", row.values);
      totalAdded++;
    }

    console.log("Rows Added:", totalAdded);
    console.log("Worksheet Row Count:", worksheet.rowCount);

    // TEST ROW
    worksheet.addRow({
      transactionId: 999999,
      userId: 1,
      name: "TEST USER",
      email: "test@test.com",
      phone: "9999999999",
      songIds: "1,2",
      titles: "Testing Song",
      composers: "Composer",
      amount: 10,
      currency: "USD",
      status: "Completed",
      method: "Stripe",
      coupon: "",
      session: "session",
      intent: "intent",
      createdAt: new Date(),
      completedAt: new Date(),
    });

    console.log("Worksheet Row Count After Test:", worksheet.rowCount);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=music-payments.xlsx"
    );
    await workbook.xlsx.write(res);
    console.log("Excel Sent Successfully");
    res.end();

  } catch (err) {
    console.log("EXPORT ERROR");
    console.log(err);
    return res.status(500).json({ success: false, error: err.message, });
  }
});
module.exports = router;