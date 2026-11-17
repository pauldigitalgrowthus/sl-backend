const express = require('express');
const { getMySQLConnection } = require('../config/mysql');
const { auth } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');
const { communityMusicLibraryUpload, deleteFileFromS3 } = require('../config/s3');
const { pdfToPng } = require("pdf-to-png-converter");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { s3: s3Client, BUCKET_NAME } = require("../config/s3");

const downloadFile = (url, destination) => {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https:") ? https : http;

    const file = fs.createWriteStream(destination);

    protocol
      .get(url, (response) => {
        // Follow redirects (S3 can 301/302 redirect between region endpoints)
        if (
          [301, 302, 303, 307, 308].includes(response.statusCode) &&
          response.headers.location
        ) {
          response.resume(); // discard this response body
          return downloadFile(response.headers.location, destination)
            .then(resolve)
            .catch(reject);
        }

        if (response.statusCode !== 200) {
          // Drain the body so we can log what S3 actually said (e.g. AccessDenied XML)
          let body = "";
          response.on("data", (chunk) => (body += chunk));
          response.on("end", () => {
            fs.unlink(destination, () => {});
            reject(
              new Error(
                `Failed to download file. Status: ${response.statusCode}. Body: ${body.slice(0, 300)}`
              )
            );
          });
          return;
        }

        response.pipe(file);

        file.on("finish", () => {
          file.close(resolve);
        });
      })
      .on("error", (err) => {
        fs.unlink(destination, () => {});
        reject(err);
      });
  });
};

async function generatePdfThumbnail(pdfUrl, originalName) {
  const thumbnailsDir = path.join(
    process.cwd(),
    "temp",
    `thumb-${Date.now()}`
  );

  fs.mkdirSync(thumbnailsDir, { recursive: true });

  const safeOriginalName = path.basename(originalName);
  const baseName = path.parse(safeOriginalName).name;

  const tempPdfPath = path.join(
    thumbnailsDir,
    `temp_${Date.now()}_${safeOriginalName}`
  );

  try {
    await downloadFile(pdfUrl, tempPdfPath);

    const pngPages = await pdfToPng(tempPdfPath, {
      viewportScale: 3,
      outputFolder: path.relative(process.cwd(), thumbnailsDir),
      pagesToProcess: [1],
      outputFileMask: `${baseName}_${Date.now()}`
    });

    if (!pngPages.length) return null;

    const firstPage = pngPages[0].path;

    const thumbName = `${baseName}_${Date.now()}_thumb.png`;
    const thumbPath = path.join(thumbnailsDir, thumbName);

    await sharp(firstPage)
      .resize(800, 800, {
        fit: "inside",
        withoutEnlargement: true
      })
      .png()
      .toFile(thumbPath);

    const thumbnailUrl = await uploadThumbnailToS3(
      thumbPath,
      thumbName
    );

    fs.rmSync(thumbnailsDir, {
      recursive: true,
      force: true
    });

    return thumbnailUrl;
  } catch (err) {
    console.error(`PDF thumbnail generation failed for "${originalName}":`, err);
    fs.rmSync(thumbnailsDir, {
      recursive: true,
      force: true
    });
    // Re-throw (instead of swallowing to null) so the calling route can
    // capture the real reason in a thumbnailError field on the response,
    // the same way music-publications.js does.
    throw err;
  }
}

// Helper function to upload a generated PDF thumbnail to S3 using AWS SDK v3
async function uploadThumbnailToS3(localFilePath, fileName) {
  try {
    const fileBuffer = fs.readFileSync(localFilePath);

    const uploadParams = {
      Bucket: BUCKET_NAME,
      Key: `community-music-library/thumbnails/${fileName}`,
      Body: fileBuffer,
      ContentType: "image/png",
    };

    const command = new PutObjectCommand(uploadParams);
    await s3Client.send(command);

    const s3Url = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION || "ap-south-1"}.amazonaws.com/community-music-library/thumbnails/${fileName}`;

    console.log("Thumbnail uploaded to S3:", s3Url);
    return s3Url;
  } catch (error) {
    console.error("S3 thumbnail upload error:", error);
    throw error;
  }
}

const router = express.Router();

// Helper function to get parent user ID (community identifier)
const getParentUserId = (user) => {
  // If user has a parent, use parent's ID (they're part of a community)
  // Otherwise, use their own ID (they're the community admin)
  return user.parent_user_id || user.id;
};

// Helper function to check if user is manager level with diocese plan validation
const isManagerLevel = async (user, mysqlConnection) => {
  try {
    // Manager level users are:
    // 1. Users with user_type = 'admin' (diocese plan admins or their admin sub-users)
    // 2. Users created by diocese plan admin (they have parent_user_id pointing to diocese admin)

    // First check basic user type
    const isAdmin = user.user_type === 'admin';
    const isSubUserWithParent = user.parent_user_id && user.user_type === 'sub_user';
    console.log(isAdmin, !isSubUserWithParent)

    if (!isAdmin && !isSubUserWithParent) {
      return false;
    }

    // Get the actual user to check (if sub_user, check parent's plan; if admin, check own plan)
    let userToCheck = user;
    if (isSubUserWithParent && user.parent_user_id) {
      // Get parent user details
      const [parentUsers] = await mysqlConnection.execute(
        `SELECT id, current_plan_id, plan_status, user_type FROM users WHERE id = ?`,
        [user.parent_user_id]
      );

      if (parentUsers.length === 0) {
        return false;
      }

      userToCheck = parentUsers[0];
    }

    // 🎫 Step 1: Check if User has Active Plan
    if (!userToCheck.current_plan_id || userToCheck.plan_status !== 'active') {
      return false;
    }

    // 🎫 Step 2: Check if the plan is a diocese plan
    const [plans] = await mysqlConnection.execute(
      `SELECT id, name, slug FROM plans WHERE id = ? AND is_active = TRUE`,
      [userToCheck.current_plan_id]
    );

    if (plans.length === 0) {
      return false;
    }

    const userPlan = plans[0];
    const planNameLower = userPlan.name.toLowerCase();
    const planSlugLower = userPlan.slug.toLowerCase();

    // Check if plan name or slug contains "diocese"
    const hasDiocesePlan = planNameLower.includes('diocese') || planSlugLower.includes('diocese');

    return hasDiocesePlan;

  } catch (error) {
    console.error('Error checking manager level:', error);
    return false;
  }
};

// Helper function to safely parse JSON
const parseJsonSafe = (value, fallback = null) => {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (e) {
    return fallback;
  }
};

// Helper function to safely stringify JSON
const stringifyJsonSafe = (data) => {
  if (!data) return null;
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data);
  } catch (e) {
    return null;
  }
};

// ============================================
// GET ALL MUSIC IN COMMUNITY LIBRARY
// ============================================
// @route   GET /api/community-music-library
// @desc    Get all music in the community library (SL + Non-SL) with search and filters
// @access  Private (Any community member)
router.get('/', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Get parent user ID (community identifier)
    const parentUserId = getParentUserId(req.user);

    // Query parameters
    const {
      page,
      limit,
      search = '',
      category = '',
      composer = '',
      isSlMusic = '', // 'true', 'false', or '' for all
      season = '',
      typesOfMusic = '',
      year = ''
    } = req.query;

    // Handle pagination - optional, no validation
    const pageNum = page ? parseInt(page) : null;
    const limitNum = limit ? parseInt(limit) : null;
    const offset = (pageNum && limitNum) ? (pageNum - 1) * limitNum : null;

    // Build WHERE clause
    let whereClause = 'WHERE cml.parent_user_id = ? AND cml.deleted_at IS NULL';
    let whereValues = [parentUserId];

    // Search filter
    if (search) {
      whereClause += ' AND (cml.music_title LIKE ? OR cml.composer_name LIKE ? OR cml.notes LIKE ?)';
      const searchTerm = `%${search}%`;
      whereValues.push(searchTerm, searchTerm, searchTerm);
    }

    // Category filter
    if (category) {
      whereClause += ' AND cml.category = ?';
      whereValues.push(category);
    }

    // Composer filter
    if (composer) {
      whereClause += ' AND cml.composer_name LIKE ?';
      whereValues.push(`%${composer}%`);
    }

    // SL Music filter
    if (isSlMusic === 'true') {
      whereClause += ' AND cml.is_sl_music = TRUE';
    } else if (isSlMusic === 'false') {
      whereClause += ' AND cml.is_sl_music = FALSE';
    }

    // Season filter
    if (season) {
      whereClause += ' AND cml.season = ?';
      whereValues.push(season);
    }

    // Types of music filter
    if (typesOfMusic) {
      whereClause += ' AND cml.types_of_music = ?';
      whereValues.push(typesOfMusic);
    }

    // Year filter
    if (year) {
      whereClause += ' AND cml.year = ?';
      whereValues.push(year);
    }

    // Get total count
    const [countResult] = await mysqlConnection.execute(
      `SELECT COUNT(*) as total FROM community_music_library cml ${whereClause}`,
      whereValues
    );
    const total = countResult[0].total;

    // Get music with optional pagination
    let query = `SELECT 
        cml.*,
        u.first_name as added_by_first_name,
        u.last_name as added_by_last_name
      FROM community_music_library cml
      LEFT JOIN users u ON cml.added_by_user_id = u.id
      ${whereClause}
      ORDER BY cml.created_at DESC`;

    let queryValues = [...whereValues];

    // Add pagination only if both page and limit are provided
    if (pageNum && limitNum && pageNum > 0 && limitNum > 0) {
      query += ' LIMIT ? OFFSET ?';
      queryValues.push(limitNum, offset);
    }

    const [musicList] = await mysqlConnection.execute(query, queryValues);

    // Format the response
    const formattedMusic = musicList.map(music => ({
      id: music.id,
      isSlMusic: !!music.is_sl_music,
      musicPublicationId: music.music_publication_id,

      // Basic Info
      musicTitle: music.music_title,
      composerName: music.composer_name,
      category: music.category,
      year: music.year,
      tags: parseJsonSafe(music.tags, []),
      notes: music.notes,

      // Non-SL Music Files
      pdfFiles: parseJsonSafe(music.pdf_files, []),
      mp3Files: parseJsonSafe(music.mp3_files, []),
      imageFiles: parseJsonSafe(music.image_files, []),

      // SL Music Details (if applicable)
      compositionTitle: music.composition_title,
      compositionTitle1: music.composition_title_1,
      compositionDescription: music.composition_description,
      composerFirstname: music.composer_firstname,
      composerLastname: music.composer_lastname,
      composerId: music.composer_id,
      vocalParts: parseJsonSafe(music.vocal_parts, []),
      instrumentation: parseJsonSafe(music.instrumentation, []),
      typesOfMusic: music.types_of_music,
      firstLineOfComposition: music.first_line_of_composition,
      compositionCopyrights: parseJsonSafe(music.composition_copyrights, []),
      songType: music.song_type,
      meter: music.meter,
      season: music.season,
      psalmNumber: music.psalm_number,
      musicFiles: parseJsonSafe(music.music_files, []),
      musicVideoLink: music.music_video_link,
      artworkFileUrl: music.artwork_file_url,
      artworkFileSize: music.artwork_file_size,
      price: music.price ? parseFloat(music.price) : null,
      isFree: !!music.is_free,
      tune: music.tune,
      generalDetails: music.general_details,

      // Metadata
      addedBy: {
        id: music.added_by_user_id,
        firstName: music.added_by_first_name,
        lastName: music.added_by_last_name,
        fullName: music.added_by_first_name && music.added_by_last_name
          ? `${music.added_by_first_name} ${music.added_by_last_name}`
          : null
      },
      createdAt: music.created_at,
      updatedAt: music.updated_at,
      source: "Other Music"
    }));

    // Build response with optional pagination info
    const response = {
      music: formattedMusic,
      total
    };

    // Add pagination info only if pagination was used
    if (pageNum && limitNum && pageNum > 0 && limitNum > 0) {
      response.pagination = {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum)
      };
    }

    successResponse(res, response, 'Community music library retrieved successfully');

  } catch (error) {
    console.error('Get community music library error:', error);
    errorResponse(res, 'Failed to get community music library', 500);
  }
});

// ============================================
// ADD SL MUSIC TO COMMUNITY LIBRARY
// ============================================
// @route   POST /api/community-music-library/add-sl-music
// @desc    Add music from SL database to community library (Manager level only)
// @access  Private (Manager level users only)
router.post('/add-sl-music', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    // // Check if user is manager level with diocese plan
    // const isManager = await isManagerLevel(req.user, mysqlConnection);
    // if (!isManager) {
    //   return errorResponse(res, 'Only manager level users with active diocese plan can add music to the library', 403);
    // }

    const { musicPublicationId } = req.body;
    const userId = req.user.id;
    const parentUserId = getParentUserId(req.user);

    if (!musicPublicationId) {
      return errorResponse(res, 'Music publication ID is required', 400);
    }

    // Get the music publication
    const [publications] = await mysqlConnection.execute(
      `SELECT * FROM music_publications WHERE id = ? AND status = 'published'`,
      [musicPublicationId]
    );

    if (publications.length === 0) {
      return errorResponse(res, 'Music publication not found or not published', 404);
    }

    const publication = publications[0];

    // Check if already in library
    const [existing] = await mysqlConnection.execute(
      `SELECT id FROM community_music_library 
       WHERE parent_user_id = ? AND music_publication_id = ? AND deleted_at IS NULL`,
      [parentUserId, musicPublicationId]
    );

    if (existing.length > 0) {
      return errorResponse(res, 'This music is already in your community library', 400);
    }

    // Parse JSON fields
    const musicFiles = parseJsonSafe(publication.music_files, []);
    const vocalParts = parseJsonSafe(publication.vocal_parts, []);
    const instrumentation = parseJsonSafe(publication.instrumentation, []);
    const compositionCopyrights = parseJsonSafe(publication.composition_copyrights, []);

    // Insert into community music library
    const [result] = await mysqlConnection.execute(
      `INSERT INTO community_music_library (
        parent_user_id, is_sl_music, music_publication_id,
        music_title, composer_name,
        composition_title, composition_title_1, composition_description,
        composer_firstname, composer_lastname, composer_id,
        vocal_parts, instrumentation, types_of_music,
        first_line_of_composition, composition_copyrights, song_type,
        meter, season, psalm_number,
        music_files, music_video_link, artwork_file_url, artwork_file_size,
        price, is_free, tune, general_details,
        added_by_user_id
      ) VALUES (?, TRUE, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        parentUserId,
        musicPublicationId,
        publication.composition_title || 'Untitled',
        publication.composer_firstname && publication.composer_lastname
          ? `${publication.composer_firstname} ${publication.composer_lastname}`
          : publication.composer_firstname || publication.composer_lastname || 'Unknown',
        publication.composition_title,
        publication.composition_title_1,
        publication.composition_description,
        publication.composer_firstname,
        publication.composer_lastname,
        publication.composer_id,
        stringifyJsonSafe(vocalParts),
        stringifyJsonSafe(instrumentation),
        publication.types_of_music,
        publication.first_line_of_composition,
        stringifyJsonSafe(compositionCopyrights),
        publication.song_type,
        publication.meter,
        publication.season,
        publication.psalm_number,
        stringifyJsonSafe(musicFiles),
        publication.music_video_link,
        publication.artwork_file_url,
        publication.artwork_file_size,
        publication.price,
        publication.is_free,
        publication.tune,
        publication.general_details,
        userId
      ]
    );

    // Track sale for composer (add 1x sale)
    if (publication.composer_id) {
      // Check if there's a composer sales table or similar
      // For now, we'll just log it - you may need to create a sales tracking table
      console.log(`📊 Sale tracked for composer ${publication.composer_id} - Music: ${publication.composition_title}`);

      // TODO: Add to composer sales/statistics table if it exists
      // Example:
      // await mysqlConnection.execute(
      //   'INSERT INTO composer_sales (composer_id, music_publication_id, sale_type, created_at) VALUES (?, ?, "library_add", NOW())',
      //   [publication.composer_id, musicPublicationId]
      // );
    }

    // Get the inserted record
    const [inserted] = await mysqlConnection.execute(
      `SELECT * FROM community_music_library WHERE id = ?`,
      [result.insertId]
    );

    const music = inserted[0];

    successResponse(res, {
      id: music.id,
      isSlMusic: true,
      musicTitle: music.music_title,
      composerName: music.composer_name,
      message: 'SL music added to community library successfully. Sale tracked for composer.'
    }, 'SL music added to community library successfully');

  } catch (error) {
    console.error('Add SL music to library error:', error);
    errorResponse(res, 'Failed to add SL music to library', 500);
  }
});

// ============================================
// ADD NON-SL MUSIC TO COMMUNITY LIBRARY
// ============================================
// @route   POST /api/community-music-library/add-non-sl-music
// @desc    Add non-SL music to community library (Manager level only)
// @access  Private (Manager level users only)
router.post(
  '/add-non-sl-music',
  [
    auth,
    communityMusicLibraryUpload.fields([
      { name: 'pdfFiles', maxCount: 10 },
      { name: 'mp3Files', maxCount: 10 },
      { name: 'imageFiles', maxCount: 10 }
    ])
  ],
  async (req, res) => {
    try {
      const mysqlConnection = getMySQLConnection();

      const {
        musicTitle,
        composerName,
        category,
        year,
        tags,
        notes,
        musicType,
        pdfFilesMeta
      } = req.body;

      const userId = req.user.id;
      const parentUserId = getParentUserId(req.user);

      if (!musicTitle || !composerName) {
        return errorResponse(res, 'Music title and composer name are required', 400);
      }

      /* --------------------------------------------------
         PDF FILES + META (SAME LOGIC AS HYMNAL)
      -------------------------------------------------- */
      let parsedPdfMeta = {};
      if (pdfFilesMeta) {
        parsedPdfMeta = JSON.parse(pdfFilesMeta);
      }

const pdfFiles = req.files?.pdfFiles
  ? await Promise.all(
      req.files.pdfFiles.map(async (file, index) => {
        const meta = parsedPdfMeta[index] || {};

        let thumbnailUrl = null;
        let thumbnailGenerated = false;
        let thumbnailError = null;

        if (file.mimetype === "application/pdf") {
          try {
            thumbnailUrl = await generatePdfThumbnail(
              file.location,
              file.originalname
            );
            thumbnailGenerated = true;
          } catch (err) {
            console.error("Thumbnail generation failed:", err);
            thumbnailGenerated = false;
            thumbnailError = err.message;
          }
        }

        return {
          designation: meta.designation || "",
          instruments: meta.instruments || [],
          customInstrument: meta.customInstrument || "",
          thumbnailUrl,
          thumbnailGenerated,
          thumbnailError,
          file: {
            url: file.location,
            size: file.size,
            name: file.originalname,
            type: file.mimetype,
          },
        };
      })
    )
  : [];

      /* --------------------------------------------------
         MP3 & IMAGE (UNCHANGED)
      -------------------------------------------------- */
      const mp3Files = req.files?.mp3Files
        ? req.files.mp3Files.map(file => ({
          url: file.location,
          size: file.size,
          name: file.originalname,
          type: file.mimetype
        }))
        : [];

      const imageFiles = req.files?.imageFiles
        ? req.files.imageFiles.map(file => ({
          url: file.location,
          size: file.size,
          name: file.originalname,
          type: file.mimetype
        }))
        : [];

      /* --------------------------------------------------
         TAGS
      -------------------------------------------------- */
      let parsedTags = [];
      if (tags) {
        try {
          parsedTags = typeof tags === 'string' ? JSON.parse(tags) : tags;
        } catch {
          parsedTags = Array.isArray(tags) ? tags : [tags];
        }
      }

      /* --------------------------------------------------
         INSERT
      -------------------------------------------------- */
      const [result] = await mysqlConnection.execute(
        `
        INSERT INTO community_music_library (
          parent_user_id, is_sl_music, music_publication_id,
          music_title, composer_name, category, year, tags, notes,
          pdf_files, mp3_files, image_files, types_of_music,
          added_by_user_id
        ) VALUES (?, FALSE, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          parentUserId,
          musicTitle,
          composerName,
          category || null,
          year || null,
          stringifyJsonSafe(parsedTags),
          notes || null,
          stringifyJsonSafe(pdfFiles),
          stringifyJsonSafe(mp3Files),
          stringifyJsonSafe(imageFiles),
          musicType || null,
          userId
        ]
      );

      const [inserted] = await mysqlConnection.execute(
        `SELECT * FROM community_music_library WHERE id = ?`,
        [result.insertId]
      );

      const music = inserted[0];

      successResponse(
        res,
        {
          id: music.id,
          isSlMusic: false,
          musicTitle: music.music_title,
          musicType: music.types_of_music,
          composerName: music.composer_name,
          category: music.category,
          year: music.year,
          tags: parseJsonSafe(music.tags, []),
          notes: music.notes,
          pdfFiles: parseJsonSafe(music.pdf_files, []),
          mp3Files: parseJsonSafe(music.mp3_files, []),
          imageFiles: parseJsonSafe(music.image_files, [])
        },
        'Non-SL music added to community library successfully'
      );
    } catch (error) {
      console.error('Add non-SL music error:', error);
      errorResponse(res, 'Failed to add non-SL music to library', 500);
    }
  }
);

// ============================================
// UPDATE NON-SL MUSIC IN COMMUNITY LIBRARY
// ============================================
// @route   PUT /api/community-music-library/:id
// @desc    Update non-SL music in community library (Manager level only)
// @access  Private (Manager level users only)
router.put('/:id', [
  auth,
  communityMusicLibraryUpload.fields([
    { name: 'pdfFiles', maxCount: 10 },
    { name: 'mp3Files', maxCount: 10 },
    { name: 'imageFiles', maxCount: 10 }
  ])
],
  async (req, res) => {
    try {
      const mysqlConnection = getMySQLConnection();

      // const isManager = await isManagerLevel(req.user, mysqlConnection);
      // if (!isManager) {
      //   return errorResponse(
      //     res,
      //     'Only manager level users with active diocese plan can edit music in the library',
      //     403
      //   );
      // }

      const { id } = req.params;
      const {
        musicTitle,
        composerName,
        category,
        year,
        tags,
        notes,
        musicType,
        pdfFilesMeta,
        existingPdfFiles,
        existingMp3Files,
        existingImageFiles
      } = req.body;

      const parentUserId = getParentUserId(req.user);

      /* --------------------------------------------------
         CHECK MUSIC
      -------------------------------------------------- */
      const [existing] = await mysqlConnection.execute(
        `SELECT * FROM community_music_library
         WHERE id = ? AND parent_user_id = ? AND deleted_at IS NULL`,
        [id, parentUserId]
      );

      if (!existing.length) {
        return errorResponse(res, 'Music not found or access denied', 404);
      }

      const music = existing[0];

      if (music.is_sl_music) {
        return errorResponse(
          res,
          'SL music cannot be edited. Only Non-SL music can be edited.',
          400
        );
      }

      /* --------------------------------------------------
         BUILD UPDATE
      -------------------------------------------------- */
      const updateFields = [];
      const updateValues = [];

      if (musicTitle !== undefined) {
        updateFields.push('music_title = ?');
        updateValues.push(musicTitle);
      }
      if (composerName !== undefined) {
        updateFields.push('composer_name = ?');
        updateValues.push(composerName);
      }
      if (category !== undefined) {
        updateFields.push('category = ?');
        updateValues.push(category || null);
      }
      if (year !== undefined) {
        updateFields.push('year = ?');
        updateValues.push(year || null);
      }
      if (musicType !== undefined) {
        updateFields.push('types_of_music = ?');
        updateValues.push(musicType || null);
      }
      if (tags !== undefined) {
        let parsedTags = [];
        try {
          parsedTags = typeof tags === 'string' ? JSON.parse(tags) : tags;
        } catch {
          parsedTags = Array.isArray(tags) ? tags : [tags];
        }
        updateFields.push('tags = ?');
        updateValues.push(stringifyJsonSafe(parsedTags));
      }
      if (notes !== undefined) {
        updateFields.push('notes = ?');
        updateValues.push(notes || null);
      }

      /* --------------------------------------------------
         PDF FILES
         - Existing PDFs are KEPT by default.
         - They are only removed if the client explicitly sends
           `existingPdfFiles` WITHOUT that file in it (i.e. user
           deleted it from the UI).
         - Newly uploaded PDFs are appended, each with a freshly
           generated thumbnail (same logic as add-non-sl-music).
      -------------------------------------------------- */
      if (req.files?.pdfFiles || existingPdfFiles !== undefined) {
        const oldPdfFiles = parseJsonSafe(music.pdf_files, []);

        // What the client wants to keep from the old list.
        // If the client didn't send this field at all, default to
        // keeping everything (so old files are never silently dropped).
        let keepPdfFiles = oldPdfFiles;
        if (existingPdfFiles !== undefined) {
          try {
            keepPdfFiles =
              typeof existingPdfFiles === 'string'
                ? JSON.parse(existingPdfFiles)
                : existingPdfFiles;
          } catch {
            keepPdfFiles = oldPdfFiles;
          }
        }

        // Only delete from S3 the files that existed before but are
        // NOT in the keep list anymore — i.e. explicitly removed.
        const keepPdfUrls = new Set(
          keepPdfFiles.map((f) => f?.file?.url || f?.url).filter(Boolean)
        );
        for (const old of oldPdfFiles) {
          const oldUrl = old?.file?.url || old?.url;
          if (oldUrl && !keepPdfUrls.has(oldUrl)) {
            await deleteFileFromS3(oldUrl).catch(() => { });
          }
        }

        // Generate thumbnails for newly uploaded PDFs only
        let newPdfFiles = [];
        if (req.files?.pdfFiles) {
          const parsedMeta = pdfFilesMeta ? JSON.parse(pdfFilesMeta) : {};

          newPdfFiles = await Promise.all(
            req.files.pdfFiles.map(async (file, index) => {
              const meta = parsedMeta[index] || {};

              let thumbnailUrl = null;
              let thumbnailGenerated = false;
              let thumbnailError = null;
              if (file.mimetype === 'application/pdf') {
                try {
                  thumbnailUrl = await generatePdfThumbnail(
                    file.location,
                    file.originalname
                  );
                  thumbnailGenerated = true;
                } catch (err) {
                  console.error('Thumbnail generation failed:', err);
                  thumbnailGenerated = false;
                  thumbnailError = err.message;
                }
              }

              return {
                designation: meta.designation || '',
                instruments: meta.instruments || [],
                customInstrument: meta.customInstrument || '',
                thumbnailUrl,
                thumbnailGenerated,
                thumbnailError,
                file: {
                  url: file.location,
                  size: file.size,
                  name: file.originalname,
                  type: file.mimetype
                }
              };
            })
          );
        }

        const finalPdfFiles = [...keepPdfFiles, ...newPdfFiles];

        updateFields.push('pdf_files = ?');
        updateValues.push(stringifyJsonSafe(finalPdfFiles));
      }

      /* --------------------------------------------------
         MP3 FILES
         - Same keep/remove behaviour as PDFs, via `existingMp3Files`.
      -------------------------------------------------- */
      if (req.files?.mp3Files || existingMp3Files !== undefined) {
        const oldMp3Files = parseJsonSafe(music.mp3_files, []);

        let keepMp3Files = oldMp3Files;
        if (existingMp3Files !== undefined) {
          try {
            keepMp3Files =
              typeof existingMp3Files === 'string'
                ? JSON.parse(existingMp3Files)
                : existingMp3Files;
          } catch {
            keepMp3Files = oldMp3Files;
          }
        }

        const keepMp3Urls = new Set(
          keepMp3Files.map((f) => f?.url).filter(Boolean)
        );
        for (const old of oldMp3Files) {
          if (old?.url && !keepMp3Urls.has(old.url)) {
            await deleteFileFromS3(old.url).catch(() => { });
          }
        }

        const newMp3Files = req.files?.mp3Files
          ? req.files.mp3Files.map((file) => ({
              url: file.location,
              size: file.size,
              name: file.originalname,
              type: file.mimetype
            }))
          : [];

        const finalMp3Files = [...keepMp3Files, ...newMp3Files];

        updateFields.push('mp3_files = ?');
        updateValues.push(stringifyJsonSafe(finalMp3Files));
      }

      /* --------------------------------------------------
         IMAGE FILES
         - Same keep/remove behaviour as PDFs, via `existingImageFiles`.
      -------------------------------------------------- */
      if (req.files?.imageFiles || existingImageFiles !== undefined) {
        const oldImages = parseJsonSafe(music.image_files, []);

        let keepImageFiles = oldImages;
        if (existingImageFiles !== undefined) {
          try {
            keepImageFiles =
              typeof existingImageFiles === 'string'
                ? JSON.parse(existingImageFiles)
                : existingImageFiles;
          } catch {
            keepImageFiles = oldImages;
          }
        }

        const keepImageUrls = new Set(
          keepImageFiles.map((f) => f?.url).filter(Boolean)
        );
        for (const old of oldImages) {
          if (old?.url && !keepImageUrls.has(old.url)) {
            await deleteFileFromS3(old.url).catch(() => { });
          }
        }

        const newImageFiles = req.files?.imageFiles
          ? req.files.imageFiles.map((file) => ({
              url: file.location,
              size: file.size,
              name: file.originalname,
              type: file.mimetype
            }))
          : [];

        const finalImageFiles = [...keepImageFiles, ...newImageFiles];

        updateFields.push('image_files = ?');
        updateValues.push(stringifyJsonSafe(finalImageFiles));
      }

      if (!updateFields.length) {
        return errorResponse(res, 'No fields to update', 400);
      }

      updateFields.push('updated_at = NOW()');
      updateValues.push(id);

      await mysqlConnection.execute(
        `UPDATE community_music_library SET ${updateFields.join(', ')} WHERE id = ?`,
        updateValues
      );

      const [updated] = await mysqlConnection.execute(
        `SELECT * FROM community_music_library WHERE id = ?`,
        [id]
      );

      const u = updated[0];

      successResponse(res, {
        id: u.id,
        isSlMusic: false,
        musicTitle: u.music_title,
        composerName: u.composer_name,
        category: u.category,
        year: u.year,
        tags: parseJsonSafe(u.tags, []),
        notes: u.notes,
        pdfFiles: parseJsonSafe(u.pdf_files, []),
        mp3Files: parseJsonSafe(u.mp3_files, []),
        imageFiles: parseJsonSafe(u.image_files, [])
      }, 'Non-SL music updated successfully');

    } catch (error) {
      console.error('Update non-SL music error:', error);
      errorResponse(res, 'Failed to update non-SL music', 500);
    }
  }
);

// ============================================
// DELETE NON-SL MUSIC FROM COMMUNITY LIBRARY
// ============================================
// @route   DELETE /api/community-music-library/:id
// @desc    Delete non-SL music (Manager level only)
// @access  Private (Manager level users only)
// ============================================
router.delete('/:id', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    /* ===============================
       1️⃣ MANAGER CHECK
    =============================== */
    // const isManager = await isManagerLevel(req.user, mysqlConnection);

    // if (!isManager) {
    //   return errorResponse(
    //     res,
    //     'Only manager level users with active diocese plan can delete music',
    //     403
    //   );
    // }

    const { id } = req.params;
    const parentUserId = getParentUserId(req.user);

    /* ===============================
       2️⃣ FIND RECORD
    =============================== */
    const [rows] = await mysqlConnection.execute(
      `
      SELECT *
      FROM community_music_library
      WHERE id = ?
        AND parent_user_id = ?
        AND deleted_at IS NULL
      `,
      [id, parentUserId]
    );

    if (!rows.length) {
      return errorResponse(res, 'Music not found or access denied', 404);
    }

    const music = rows[0];

    /* ===============================
       3️⃣ BLOCK SL MUSIC
    =============================== */
    if (music.is_sl_music) {
      return errorResponse(
        res,
        'SL music cannot be deleted. Only Non-SL music can be deleted.',
        400
      );
    }

    /* ===============================
       4️⃣ DELETE FILES FROM S3
    =============================== */

    const deleteFiles = async (files) => {
      if (!files || !Array.isArray(files)) return;

      for (const file of files) {
        if (file?.url) {
          try {
            await deleteFileFromS3(file.url);
            console.log(`✅ Deleted from S3: ${file.url}`);
          } catch (err) {
            console.error(`❌ Failed deleting from S3: ${file.url}`, err);
            // continue (don't block delete)
          }
        }
      }
    };

    await deleteFiles(parseJsonSafe(music.pdf_files, []));
    await deleteFiles(parseJsonSafe(music.mp3_files, []));
    await deleteFiles(parseJsonSafe(music.image_files, []));

    /* ===============================
       5️⃣ SOFT DELETE DB
    =============================== */

    await mysqlConnection.execute(
      `
      UPDATE community_music_library
      SET deleted_at = NOW()
      WHERE id = ?
      `,
      [id]
    );

    /* ===============================
       6️⃣ RESPONSE
    =============================== */

    return successResponse(
      res,
      { id },
      'Music deleted successfully'
    );

  } catch (error) {
    console.error('Delete music error:', error);
    return errorResponse(res, 'Failed to delete music', 500);
  }
});

// ============================================
// DELETE MUSIC FROM COMMUNITY LIBRARY
// ============================================
// @route   DELETE /api/community-music-library/:id
// @desc    Delete music from community library (Manager level only)
// @access  Private (Manager level users only)
router.delete('/:id', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    // Check if user is manager level with diocese plan
    const isManager = await isManagerLevel(req.user, mysqlConnection);
    if (!isManager) {
      return errorResponse(res, 'Only manager level users with active diocese plan can delete music from the library', 403);
    }

    const { id } = req.params;
    const parentUserId = getParentUserId(req.user);

    // Check if music exists and belongs to this community
    const [existing] = await mysqlConnection.execute(
      `SELECT * FROM community_music_library 
       WHERE id = ? AND parent_user_id = ? AND deleted_at IS NULL`,
      [id, parentUserId]
    );

    if (existing.length === 0) {
      return errorResponse(res, 'Music not found or access denied', 404);
    }

    const music = existing[0];

    // Delete files from S3 if it's Non-SL music
    if (!music.is_sl_music) {
      try {
        // Delete PDF files from S3
        const pdfFiles = parseJsonSafe(music.pdf_files, []);
        if (pdfFiles && Array.isArray(pdfFiles)) {
          for (const file of pdfFiles) {
            if (file.url) {
              try {
                await deleteFileFromS3(file.url);
                console.log(`✅ Deleted PDF file from S3: ${file.url}`);
              } catch (error) {
                console.error(`❌ Error deleting PDF file from S3: ${file.url}`, error);
              }
            }
          }
        }

        // Delete MP3 files from S3
        const mp3Files = parseJsonSafe(music.mp3_files, []);
        if (mp3Files && Array.isArray(mp3Files)) {
          for (const file of mp3Files) {
            if (file.url) {
              try {
                await deleteFileFromS3(file.url);
                console.log(`✅ Deleted MP3 file from S3: ${file.url}`);
              } catch (error) {
                console.error(`❌ Error deleting MP3 file from S3: ${file.url}`, error);
              }
            }
          }
        }

        // Delete image files from S3
        const imageFiles = parseJsonSafe(music.image_files, []);
        if (imageFiles && Array.isArray(imageFiles)) {
          for (const file of imageFiles) {
            if (file.url) {
              try {
                await deleteFileFromS3(file.url);
                console.log(`✅ Deleted image file from S3: ${file.url}`);
              } catch (error) {
                console.error(`❌ Error deleting image file from S3: ${file.url}`, error);
              }
            }
          }
        }
      } catch (error) {
        console.error('Error deleting files from S3:', error);
        // Continue with soft delete even if S3 deletion fails
      }
    }

    // Soft delete
    await mysqlConnection.execute(
      `UPDATE community_music_library SET deleted_at = NOW() WHERE id = ?`,
      [id]
    );

    successResponse(res, {
      id: parseInt(id),
      message: 'Music deleted from community library successfully'
    }, 'Music deleted from community library successfully');

  } catch (error) {
    console.error('Delete music from library error:', error);
    errorResponse(res, 'Failed to delete music from library', 500);
  }
});

// ============================================
// COLLECTION ROUTES (MUST BE BEFORE /:id ROUTE)
// ============================================

// ============================================
// CREATE COLLECTION FOR COMMUNITY
// ============================================
// @route   POST /api/community-music-library/collections
// @desc    Create a new collection for the community (Manager level only)
// @access  Private (Manager level users only)
router.post('/collections', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const userId = req.user.id;
    const parentUserId = getParentUserId(req.user);

    const { name, description } = req.body;

    if (!name || !name.trim()) {
      return errorResponse(res, 'Collection name is required', 400);
    }

    // Check if collection with same name already exists for this community
    const [existing] = await mysqlConnection.execute(
      `SELECT id FROM collections 
       WHERE user_id = ? AND name = ? AND is_system_collection = FALSE`,
      [parentUserId, name.trim()]
    );

    if (existing.length > 0) {
      return errorResponse(res, 'Collection with this name already exists', 400);
    }

    // Create collection for the community (using parent_user_id)
    const [result] = await mysqlConnection.execute(
      `INSERT INTO collections (name, description, user_id, created_by) 
       VALUES (?, ?, ?, 'user')`,
      [name.trim(), description || null, parentUserId]
    );

    // Get created collection
    const [collections] = await mysqlConnection.execute(
      `SELECT * FROM collections WHERE id = ?`,
      [result.insertId]
    );

    const collection = collections[0];

    successResponse(res, {
      id: collection.id,
      name: collection.name,
      description: collection.description,
      imageUrl: collection.image_url,
      userId: collection.user_id,
      musicCount: 0,
      createdAt: collection.created_at,
      updatedAt: collection.updated_at
    }, 'Collection created successfully');

  } catch (error) {
    console.error('Create collection error:', error);
    errorResponse(res, error.message || 'Failed to create collection', 500);
  }
});

// ============================================
// GET ALL COLLECTIONS FOR COMMUNITY
// ============================================
// @route   GET /api/community-music-library/collections
// @desc    Get all collections for the community
// @access  Private (Any community member)
router.get('/collections', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const parentUserId = getParentUserId(req.user);

    // Get all community collections with music count
    const [userCollections] = await mysqlConnection.execute(`
      SELECT 
        c.*,
        COUNT(DISTINCT ccm.id) as music_count
      FROM collections c
      LEFT JOIN community_collection_music ccm ON c.id = ccm.collection_id
      WHERE c.user_id = ? AND c.is_system_collection = FALSE
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `, [parentUserId]);

    successResponse(res, {
      collections: userCollections.map(collection => ({
        id: collection.id,
        name: collection.name,
        description: collection.description,
        imageUrl: collection.image_url,
        userId: collection.user_id,
        isSystemCollection: collection.is_system_collection,
        createdBy: collection.created_by,
        musicCount: parseInt(collection.music_count) || 0,
        createdAt: collection.created_at,
        updatedAt: collection.updated_at
      }))
    }, 'Collections retrieved successfully');

  } catch (error) {
    console.error('Get collections error:', error);
    errorResponse(res, 'Failed to get collections', 500);
  }
});

// ============================================
// GET COLLECTION DETAILS WITH MUSIC
// ============================================
// @route   GET /api/community-music-library/collections/:id
// @desc    Get collection details with music items
// @access  Private (Any community member)
router.get('/collections/:id', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const parentUserId = getParentUserId(req.user);
    const { id } = req.params;

    // Get collection
    const [collections] = await mysqlConnection.execute(
      `SELECT * FROM collections WHERE id = ? AND user_id = ? AND is_system_collection = FALSE`,
      [id, parentUserId]
    );

    if (collections.length === 0) {
      return errorResponse(res, 'Collection not found or access denied', 404);
    }

    const collection = collections[0];

    // Get music items in this collection from community_collection_music table
    // This supports both music_publications and community_music_library
    const [musicItems] = await mysqlConnection.execute(`
      SELECT 
        COALESCE(cml.id, mp.id) as id,
        COALESCE(cml.is_sl_music, TRUE) as is_sl_music,
        COALESCE(cml.music_publication_id, mp.id) as music_publication_id,
        COALESCE(cml.music_title, mp.composition_title) as music_title,
        COALESCE(cml.composer_name, CONCAT(mp.composer_firstname, ' ', mp.composer_lastname)) as composer_name,
        cml.category,
        cml.year,
        cml.tags,
        cml.notes,
        cml.pdf_files,
        cml.mp3_files,
        cml.image_files,
        mp.composition_title,
        mp.composition_title_1,
        mp.composition_description,
        mp.composer_firstname,
        mp.composer_lastname,
        mp.composer_id,
        mp.vocal_parts,
        mp.instrumentation,
        mp.types_of_music,
        mp.season,
        mp.meter,
        mp.psalm_number,
        mp.music_files,
        mp.music_video_link,
        mp.artwork_file_url,
        mp.artwork_file_size,
        mp.price,
        mp.is_free,
        mp.tune,
        mp.general_details,
        COALESCE(cml.added_by_user_id, mp.composer_id) as added_by_user_id,
        u.first_name as added_by_first_name,
        u.last_name as added_by_last_name,
        ccm.added_at
      FROM community_collection_music ccm
      LEFT JOIN community_music_library cml ON ccm.community_music_library_id = cml.id AND cml.deleted_at IS NULL
      LEFT JOIN music_publications mp ON ccm.music_publication_id = mp.id AND mp.status = 'published'
      LEFT JOIN users u ON COALESCE(cml.added_by_user_id, mp.composer_id) = u.id
      WHERE ccm.collection_id = ? 
        AND (
          (cml.id IS NOT NULL AND cml.parent_user_id = ?) OR 
          (mp.id IS NOT NULL)
        )
      ORDER BY ccm.added_at DESC
    `, [id, parentUserId]);

    // Format music items
    const formattedMusic = musicItems.map(music => ({
      id: music.id,
      isSlMusic: !!music.is_sl_music,
      musicPublicationId: music.music_publication_id,
      musicTitle: music.music_title,
      composerName: music.composer_name,
      category: music.category,
      year: music.year,
      tags: parseJsonSafe(music.tags, []),
      notes: music.notes,
      pdfFiles: parseJsonSafe(music.pdf_files, []),
      mp3Files: parseJsonSafe(music.mp3_files, []),
      imageFiles: parseJsonSafe(music.image_files, []),
      compositionTitle: music.composition_title,
      compositionTitle1: music.composition_title_1,
      compositionDescription: music.composition_description,
      composerFirstname: music.composer_firstname,
      composerLastname: music.composer_lastname,
      composerId: music.composer_id,
      vocalParts: parseJsonSafe(music.vocal_parts, []),
      instrumentation: parseJsonSafe(music.instrumentation, []),
      typesOfMusic: music.types_of_music,
      season: music.season,
      meter: music.meter,
      psalmNumber: music.psalm_number,
      musicFiles: parseJsonSafe(music.music_files, []),
      musicVideoLink: music.music_video_link,
      artworkFileUrl: music.artwork_file_url,
      artworkFileSize: music.artwork_file_size,
      price: music.price ? parseFloat(music.price) : null,
      isFree: !!music.is_free,
      tune: music.tune,
      generalDetails: music.general_details,
      addedBy: {
        id: music.added_by_user_id,
        firstName: music.added_by_first_name,
        lastName: music.added_by_last_name,
        fullName: music.added_by_first_name && music.added_by_last_name
          ? `${music.added_by_first_name} ${music.added_by_last_name}`
          : null
      },
      createdAt: music.created_at,
      updatedAt: music.updated_at
    }));

    successResponse(res, {
      collection: {
        id: collection.id,
        name: collection.name,
        description: collection.description,
        imageUrl: collection.image_url,
        userId: collection.user_id,
        musicCount: formattedMusic.length,
        createdAt: collection.created_at,
        updatedAt: collection.updated_at
      },
      music: formattedMusic
    }, 'Collection details retrieved successfully');

  } catch (error) {
    console.error('Get collection details error:', error);
    errorResponse(res, 'Failed to get collection details', 500);
  }
});

// ============================================
// ADD MUSIC TO COLLECTION
// ============================================
// @route   POST /api/community-music-library/collections/:id/music
// @desc    Add music from community library to collection
// @access  Private (Any community member)
router.post('/collections/:id/music', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const userId = req.user.id;
    const parentUserId = getParentUserId(req.user);
    const { id: collectionId } = req.params;
    const { musicIds } = req.body; // Array of community_music_library IDs

    if (!musicIds || !Array.isArray(musicIds) || musicIds.length === 0) {
      return errorResponse(res, 'Music IDs array is required', 400);
    }

    // Verify collection belongs to this community
    const [collections] = await mysqlConnection.execute(
      `SELECT id FROM collections WHERE id = ? AND user_id = ? AND is_system_collection = FALSE`,
      [collectionId, parentUserId]
    );

    if (collections.length === 0) {
      return errorResponse(res, 'Collection not found or access denied', 404);
    }

    // Determine which table each music ID belongs to and prepare data for community_collection_music
    const musicToAdd = [];

    for (const musicId of musicIds) {
      // Check if it's in community_music_library
      const [communityMusic] = await mysqlConnection.execute(
        `SELECT id, music_publication_id, is_sl_music 
         FROM community_music_library 
         WHERE id = ? AND parent_user_id = ? AND deleted_at IS NULL`,
        [musicId, parentUserId]
      );

      if (communityMusic.length > 0) {
        const music = communityMusic[0];
        if (music.is_sl_music && music.music_publication_id) {
          // SL music - use music_publication_id
          musicToAdd.push({
            music_publication_id: music.music_publication_id,
            community_music_library_id: null
          });
        } else {
          // Non-SL music - use community_music_library_id
          musicToAdd.push({
            music_publication_id: null,
            community_music_library_id: music.id
          });
        }
      } else {
        // Check if it's a music_publication_id directly
        const [musicPub] = await mysqlConnection.execute(
          `SELECT id FROM music_publications WHERE id = ? AND status = 'published'`,
          [musicId]
        );

        if (musicPub.length > 0) {
          // It's a music_publication_id
          musicToAdd.push({
            music_publication_id: parseInt(musicId),
            community_music_library_id: null
          });
        } else {
          return errorResponse(res, `Music item with ID ${musicId} not found in community library or music publications`, 400);
        }
      }
    }

    // Add music to collection using community_collection_music table (skip duplicates)
    const added = [];
    const skipped = [];

    for (const music of musicToAdd) {
      try {
        await mysqlConnection.execute(
          `INSERT INTO community_collection_music (collection_id, user_id, music_publication_id, community_music_library_id) 
           VALUES (?, ?, ?, ?)`,
          [collectionId, userId, music.music_publication_id, music.community_music_library_id]
        );
        added.push(music.music_publication_id || music.community_music_library_id);
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
          skipped.push(music.music_publication_id || music.community_music_library_id);
        } else {
          throw error;
        }
      }
    }

    successResponse(res, {
      added: added.length,
      skipped: skipped.length,
      addedIds: added,
      skippedIds: skipped
    }, `Added ${added.length} music item(s) to collection${skipped.length > 0 ? `, ${skipped.length} already in collection` : ''}`);

  } catch (error) {
    console.error('Add music to collection error:', error);
    errorResponse(res, 'Failed to add music to collection', 500);
  }
});

// ============================================
// REMOVE MUSIC FROM COLLECTION
// ============================================
// @route   DELETE /api/community-music-library/collections/:id/music/:musicId
// @desc    Remove music from collection
// @access  Private (Any community member)
router.delete('/collections/:id/music/:musicId', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const parentUserId = getParentUserId(req.user);
    const { id: collectionId, musicId } = req.params;

    // Verify collection belongs to this community
    const [collections] = await mysqlConnection.execute(
      `SELECT id FROM collections WHERE id = ? AND user_id = ? AND is_system_collection = FALSE`,
      [collectionId, parentUserId]
    );

    if (collections.length === 0) {
      return errorResponse(res, 'Collection not found or access denied', 404);
    }

    // Remove music from collection - check both music_publication_id and community_music_library_id
    const [result] = await mysqlConnection.execute(
      `DELETE FROM community_collection_music 
       WHERE collection_id = ? 
         AND (music_publication_id = ? OR community_music_library_id = ?)`,
      [collectionId, musicId, musicId]
    );

    if (result.affectedRows === 0) {
      return errorResponse(res, 'Music not found in collection', 404);
    }

    successResponse(res, {
      collectionId: parseInt(collectionId),
      musicId: parseInt(musicId),
      message: 'Music removed from collection successfully'
    }, 'Music removed from collection successfully');

  } catch (error) {
    console.error('Remove music from collection error:', error);
    errorResponse(res, 'Failed to remove music from collection', 500);
  }
});

// ============================================
// UPDATE COLLECTION
// ============================================
// @route   PUT /api/community-music-library/collections/:id
// @desc    Update collection details
// @access  Private (Manager level users only)
router.put('/collections/:id', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const parentUserId = getParentUserId(req.user);
    const { id } = req.params;
    const { name, description } = req.body;

    // Verify collection belongs to this community
    const [collections] = await mysqlConnection.execute(
      `SELECT * FROM collections WHERE id = ? AND user_id = ? AND is_system_collection = FALSE`,
      [id, parentUserId]
    );

    if (collections.length === 0) {
      return errorResponse(res, 'Collection not found or access denied', 404);
    }

    // Build update query
    const updateFields = [];
    const updateValues = [];

    if (name !== undefined) {
      updateFields.push('name = ?');
      updateValues.push(name.trim());
    }

    if (description !== undefined) {
      updateFields.push('description = ?');
      updateValues.push(description || null);
    }

    if (updateFields.length === 0) {
      return errorResponse(res, 'No fields to update', 400);
    }

    updateFields.push('updated_at = NOW()');
    updateValues.push(id);

    await mysqlConnection.execute(
      `UPDATE collections SET ${updateFields.join(', ')} WHERE id = ?`,
      updateValues
    );

    // Get updated collection
    const [updated] = await mysqlConnection.execute(
      `SELECT * FROM collections WHERE id = ?`,
      [id]
    );

    const collection = updated[0];

    successResponse(res, {
      id: collection.id,
      name: collection.name,
      description: collection.description,
      imageUrl: collection.image_url,
      userId: collection.user_id,
      createdAt: collection.created_at,
      updatedAt: collection.updated_at
    }, 'Collection updated successfully');

  } catch (error) {
    console.error('Update collection error:', error);
    errorResponse(res, 'Failed to update collection', 500);
  }
});

// ============================================
// DELETE COLLECTION
// ============================================
// @route   DELETE /api/community-music-library/collections/:id
// @desc    Delete collection
// @access  Private (Manager level users only)
router.delete('/collections/:id', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const parentUserId = getParentUserId(req.user);
    const { id } = req.params;

    // Verify collection belongs to this community
    const [collections] = await mysqlConnection.execute(
      `SELECT id FROM collections WHERE id = ? AND user_id = ? AND is_system_collection = FALSE`,
      [id, parentUserId]
    );

    if (collections.length === 0) {
      return errorResponse(res, 'Collection not found or access denied', 404);
    }

    // Delete collection (cascade will delete collection_music entries)
    await mysqlConnection.execute(
      `DELETE FROM collections WHERE id = ?`,
      [id]
    );

    successResponse(res, {
      id: parseInt(id),
      message: 'Collection deleted successfully'
    }, 'Collection deleted successfully');

  } catch (error) {
    console.error('Delete collection error:', error);
    errorResponse(res, 'Failed to delete collection', 500);
  }
});

// ============================================
// GET SINGLE MUSIC ITEM (MUST BE AFTER /collections ROUTES)
// ============================================
// @route   GET /api/community-music-library/:id
// @desc    Get single music item from community library
// @access  Private (Any community member)
router.get('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();
    const parentUserId = getParentUserId(req.user);

    const [musicList] = await mysqlConnection.execute(
      `SELECT 
        cml.*,
        u.first_name as added_by_first_name,
        u.last_name as added_by_last_name
      FROM community_music_library cml
      LEFT JOIN users u ON cml.added_by_user_id = u.id
      WHERE cml.id = ? AND cml.parent_user_id = ? AND cml.deleted_at IS NULL`,
      [id, parentUserId]
    );

    if (musicList.length === 0) {
      return errorResponse(res, 'Music not found or access denied', 404);
    }

    const music = musicList[0];

    // Format the response (same as GET /)
    const formattedMusic = {
      id: music.id,
      isSlMusic: !!music.is_sl_music,
      musicPublicationId: music.music_publication_id,

      // Basic Info
      musicTitle: music.music_title,
      composerName: music.composer_name,
      category: music.category,
      year: music.year,
      tags: parseJsonSafe(music.tags, []),
      notes: music.notes,

      // Non-SL Music Files
      pdfFiles: parseJsonSafe(music.pdf_files, []),
      mp3Files: parseJsonSafe(music.mp3_files, []),
      imageFiles: parseJsonSafe(music.image_files, []),

      // SL Music Details (if applicable)
      compositionTitle: music.composition_title,
      compositionTitle1: music.composition_title_1,
      compositionDescription: music.composition_description,
      composerFirstname: music.composer_firstname,
      composerLastname: music.composer_lastname,
      composerId: music.composer_id,
      vocalParts: parseJsonSafe(music.vocal_parts, []),
      instrumentation: parseJsonSafe(music.instrumentation, []),
      typesOfMusic: music.types_of_music,
      firstLineOfComposition: music.first_line_of_composition,
      compositionCopyrights: parseJsonSafe(music.composition_copyrights, []),
      songType: music.song_type,
      meter: music.meter,
      season: music.season,
      psalmNumber: music.psalm_number,
      musicFiles: parseJsonSafe(music.music_files, []),
      musicVideoLink: music.music_video_link,
      artworkFileUrl: music.artwork_file_url,
      artworkFileSize: music.artwork_file_size,
      price: music.price ? parseFloat(music.price) : null,
      isFree: !!music.is_free,
      tune: music.tune,
      generalDetails: music.general_details,

      // Metadata
      addedBy: {
        id: music.added_by_user_id,
        firstName: music.added_by_first_name,
        lastName: music.added_by_last_name,
        fullName: music.added_by_first_name && music.added_by_last_name
          ? `${music.added_by_first_name} ${music.added_by_last_name}`
          : null
      },
      createdAt: music.created_at,
      updatedAt: music.updated_at
    };

    successResponse(res, formattedMusic, 'Music item retrieved successfully');

  } catch (error) {
    console.error('Get music item error:', error);
    errorResponse(res, 'Failed to get music item', 500);
  }
});

module.exports = router;