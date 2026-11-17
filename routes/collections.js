const express = require('express');
const jwt = require('jsonwebtoken');
const { getMySQLConnection } = require('../config/mysql');
const { auth } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');
const { collectionImageUpload } = require('../config/s3');

const router = express.Router();

// @route   POST /api/collections
// @desc    Create a new collection (any authenticated user)
// @access  Private (Any authenticated user)
router.post('/', [auth, collectionImageUpload.single('image')], async (req, res) => {
  try {
    const { name, description } = req.body;
    const userId = req.body.userId ? req.body.userId : req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Validate required fields
    if (!name) {
      return errorResponse(res, 'Collection name is required', 400);
    }

    // Check if collection with same name already exists for this user
    const [existingCollections] = await mysqlConnection.execute(
      'SELECT id FROM collections WHERE user_id = ? AND name = ?',
      [userId, name]
    );

    if (existingCollections.length > 0) {
      return errorResponse(res, 'Collection with this name already exists', 400);
    }

    // Get image URL if uploaded
    const imageUrl = req.file ? req.file.location : null;

    // Create collection
    const [result] = await mysqlConnection.execute(
      'INSERT INTO collections (name, description, image_url, user_id) VALUES (?, ?, ?, ?)',
      [name, description || null, imageUrl, userId]
    );

    const collectionId = result.insertId;

    // Get created collection
    const [collections] = await mysqlConnection.execute(
      'SELECT * FROM collections WHERE id = ?',
      [collectionId]
    );

    successResponse(res, {
      collection: {
        id: collections[0].id,
        name: collections[0].name,
        description: collections[0].description,
        imageUrl: collections[0].image_url,
        userId: collections[0].user_id,
        createdAt: collections[0].created_at,
        updatedAt: collections[0].updated_at
      }
    }, 'Collection created successfully');

  } catch (error) {
    console.error('Create collection error:', error);
    errorResponse(res, 'Failed to create collection', 500);
  }
});

// @route   POST /api/collections/:id/add-music
// @desc    Add music to a collection (any authenticated user)
// @access  Private (Any authenticated user)
router.post('/:id/add-music', auth, async (req, res) => {
  try {
    const { id: collectionId } = req.params;
    const { musicIds } = req.body;
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    if (!musicIds || !Array.isArray(musicIds) || musicIds.length === 0) {
      return errorResponse(res, 'Music IDs array is required', 400);
    }

    // Check if collection exists (system collections or user's own collections)
    const [collections] = await mysqlConnection.execute(
      'SELECT * FROM collections WHERE id = ? AND (user_id = ? OR is_system_collection = TRUE)',
      [collectionId, userId]
    );

    if (collections.length === 0) {
      return errorResponse(res, 'Collection not found or access denied', 404);
    }

    // Check which music publications exist
    const placeholders = musicIds.map(() => '?').join(',');
    const [musicPublications] = await mysqlConnection.execute(
      `SELECT id, composition_title FROM music_publications WHERE id IN (${placeholders})`,
      musicIds
    );

    // Get existing music IDs
    const existingMusicIds = musicPublications.map(mp => mp.id);
    const nonExistingMusicIds = musicIds.filter(id => !existingMusicIds.includes(id));

    if (existingMusicIds.length === 0) {
      return errorResponse(res, 'None of the provided music IDs exist', 400);
    }

    // Add existing music to collection
    const addedMusic = [];
    const skippedMusic = [];

    for (const musicId of existingMusicIds) {
      try {
        await mysqlConnection.execute(
          'INSERT INTO collection_music (collection_id, music_id, user_id) VALUES (?, ?, ?)',
          [collectionId, musicId, userId]
        );
        addedMusic.push(musicId);
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
          // Music already exists in collection
          console.log(`Music ${musicId} already exists in collection ${collectionId}`);
          skippedMusic.push(musicId);
        } else {
          throw error;
        }
      }
    }

    // Prepare response message
    let message = `Successfully added ${addedMusic.length} music to collection`;
    if (nonExistingMusicIds.length > 0) {
      message += `. Skipped ${nonExistingMusicIds.length} non-existing music IDs: [${nonExistingMusicIds.join(', ')}]`;
    }
    if (skippedMusic.length > 0) {
      message += `. ${skippedMusic.length} music already existed in collection`;
    }

    successResponse(res, {
      collectionId,
      addedMusic,
      totalAdded: addedMusic.length,
      skippedMusic: skippedMusic,
      nonExistingMusicIds: nonExistingMusicIds,
      summary: {
        requested: musicIds.length,
        added: addedMusic.length,
        skipped: skippedMusic.length,
        nonExisting: nonExistingMusicIds.length
      }
    }, message);

  } catch (error) {
    console.error('Add music to collection error:', error);
    errorResponse(res, 'Failed to add music to collection', 500);
  }
});

// @route   GET /api/collections/x/mycollection
// @desc    Get all collections (system + user) along with their music for the logged-in user
// @access  Private (Any authenticated user)
router.get('/my-collection', auth, async (req, res) => {
  try {
    const userId = req.query.userId ? req.query.userId : req.user.id;
    const mysqlConnection = getMySQLConnection();

    // optional pagination
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || null;
    const offset = limit ? (page - 1) * limit : 0;

    // Count total user's collections (include system collections)
    const [countRows] = await mysqlConnection.execute(
      'SELECT COUNT(*) as total FROM collections WHERE user_id = ? OR user_id IS NULL',
      [userId]
    );
    const total = countRows?.[0]?.total || 0;

    // Fetch collections (user + system)
    let query = `
      SELECT * 
      FROM collections 
      WHERE user_id = ? OR user_id IS NULL
      ORDER BY created_at DESC
    `;
    const params = [userId];

    if (limit) {
      query += ' LIMIT ? OFFSET ?';
      params.push(limit, offset);
    }

    const [collections] = await mysqlConnection.execute(query, params);

    if (!collections || collections.length === 0) {
      return successResponse(res, { collections: [], total: 0 }, 'No collections found for this user');
    }

    // Prepare collection IDs (ensure numeric to avoid injection)
    const collectionIds = collections
      .map((c) => Number(c.id))
      .filter((n) => Number.isInteger(n) && n > 0);

    // If no collectionIds (shouldn't happen because collections exist), attach empty musics
    let musicMap = {};
    if (collectionIds.length > 0) {
      // safe comma-separated list (all numbers)
      const idsList = collectionIds.join(',');

      // Fetch collection_music joined with music_publications using music_id
      // Select music_publications.* and collection_music.added_at / id if you want metadata
      const [rows] = await mysqlConnection.execute(
        `SELECT cm.id AS cm_id,
                cm.user_id AS cm_user_id,
                cm.collection_id AS cm_collection_id,
                cm.music_id AS cm_music_id,
                cm.added_at AS cm_added_at,
                mp.*
         FROM collection_music cm
         LEFT JOIN music_publications mp ON mp.id = cm.music_id
         WHERE cm.collection_id IN (${idsList})`
      );

      // Group by collection_id
      musicMap = {};
      rows.forEach((r) => {
        const colId = r.cm_collection_id;
        if (!musicMap[colId]) musicMap[colId] = [];
        const musicObj = {
          collectionMusicId: r.cm_id,
          collectionMusicUserId: r.cm_user_id,
          collectionId: r.cm_collection_id,
          musicId: r.cm_music_id,
          addedAt: r.cm_added_at,
          id: r.id,
          composerId: r.composer_id,
          status: r.status,
          compositionTitle: r.composition_title,
          compositionDescription: r.composition_description,
          compositionTitle1: r.composition_title_1,
          isPartOfCollection: !!r.is_part_of_collection,
          collectionIdOnMusic: r.collection_id,
          collectionNameOnMusic: r.collection_name,
          musicFiles: r.music_files ? JSON.parse(r.music_files) : null,
          artists: r.artists ? JSON.parse(r.artists) : null,
          price: r.price,
          isFree: !!r.is_free,
          publishedAt: r.published_at,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        };

        musicMap[colId].push(musicObj);
      });
    }

    // Final formatted response - attach musics array (empty if none)
    const formatted = collections.map((col) => ({
      id: col.id,
      userId: col.user_id,
      name: col.name,
      description: col.description,
      isSystemCollection: !!col.is_system_collection,
      createdBy: col.created_by,
      isActive: !!col.is_active,
      createdAt: col.created_at,
      updatedAt: col.updated_at,
      musics: musicMap[col.id] || []
    }));

    return successResponse(res, { collections: formatted, total }, 'User collections retrieved successfully');

  } catch (err) {
    console.error('Get user collections error:', err);
    return errorResponse(res, 'Failed to fetch user collections', 500);
  }
});

// @route   DELETE /api/collections/:id/remove-music
// @desc    Remove music from a collection (any authenticated user)
// @access  Private (Any authenticated user)
router.delete('/:id/remove-music', auth, async (req, res) => {
  try {
    const { id: collectionId } = req.params;
    const { musicIds } = req.body;
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    if (!musicIds || !Array.isArray(musicIds) || musicIds.length === 0) {
      return errorResponse(res, 'Music IDs array is required', 400);
    }

    // Check if collection exists (system collections or user's own collections)
    const [collections] = await mysqlConnection.execute(
      'SELECT * FROM collections WHERE id = ? AND (user_id = ? OR is_system_collection = TRUE)',
      [collectionId, userId]
    );

    if (collections.length === 0) {
      return errorResponse(res, 'Collection not found or access denied', 404);
    }

    // Check which music publications exist in this collection
    const placeholders = musicIds.map(() => '?').join(',');
    const [existingMusic] = await mysqlConnection.execute(
      `SELECT cm.music_id, mp.composition_title 
       FROM collection_music cm 
       JOIN music_publications mp ON cm.music_id = mp.id 
       WHERE cm.collection_id = ? AND cm.music_id IN (${placeholders})`,
      [collectionId, ...musicIds]
    );

    // Get existing music IDs in this collection
    const existingMusicIds = existingMusic.map(mp => mp.music_id);
    const nonExistingMusicIds = musicIds.filter(id => !existingMusicIds.includes(id));

    if (existingMusicIds.length === 0) {
      return errorResponse(res, 'None of the provided music IDs exist in this collection', 400);
    }

    // Remove music from collection
    const removedMusic = [];
    const skippedMusic = [];

    for (const musicId of existingMusicIds) {
      try {
        const [result] = await mysqlConnection.execute(
          'DELETE FROM collection_music WHERE collection_id = ? AND music_id = ?',
          [collectionId, musicId]
        );

        if (result.affectedRows > 0) {
          removedMusic.push(musicId);
        } else {
          skippedMusic.push(musicId);
        }
      } catch (error) {
        console.error(`Error removing music ${musicId} from collection ${collectionId}:`, error);
        skippedMusic.push(musicId);
      }
    }

    // Prepare response message
    let message = `Successfully removed ${removedMusic.length} music from collection`;
    if (nonExistingMusicIds.length > 0) {
      message += `. Skipped ${nonExistingMusicIds.length} music IDs that were not in this collection: [${nonExistingMusicIds.join(', ')}]`;
    }
    if (skippedMusic.length > 0) {
      message += `. ${skippedMusic.length} music could not be removed`;
    }

    successResponse(res, {
      collectionId,
      removedMusic,
      totalRemoved: removedMusic.length,
      skippedMusic: skippedMusic,
      nonExistingMusicIds: nonExistingMusicIds,
      summary: {
        requested: musicIds.length,
        removed: removedMusic.length,
        skipped: skippedMusic.length,
        notInCollection: nonExistingMusicIds.length
      }
    }, message);

  } catch (error) {
    console.error('Remove music from collection error:', error);
    errorResponse(res, 'Failed to remove music from collection', 500);
  }
});

// @route   GET /api/collections/predefined
// @desc    Get only predefined (system) collections
// @access  Private (Any authenticated user)
router.get('/predefined', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    // Get only system collections with music count
    const [systemCollections] = await mysqlConnection.execute(`
      SELECT 
        c.*,
        COUNT(cm.music_id) as music_count
      FROM collections c
      LEFT JOIN collection_music cm ON c.id = cm.collection_id
      WHERE c.is_system_collection = TRUE
      GROUP BY c.id
      ORDER BY c.name ASC
    `);

    successResponse(res, {
      collections: systemCollections.map(collection => ({
        id: collection.id,
        name: collection.name,
        description: collection.description,
        imageUrl: collection.image_url,
        isSystemCollection: collection.is_system_collection,
        createdBy: collection.created_by,
        musicCount: collection.music_count,
        createdAt: collection.created_at,
        updatedAt: collection.updated_at
      })),
      total: systemCollections.length
    }, 'Predefined collections retrieved successfully');

  } catch (error) {
    console.error('Get predefined collections error:', error);
    errorResponse(res, 'Failed to get predefined collections', 500);
  }
});

// @route   GET /api/collections/all
// @desc    Get all collections (system + user collections) in a single array
// @access  Private (Any authenticated user)
router.get('/all', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Get all collections (system + user) with music count in a single query
    const [allCollections] = await mysqlConnection.execute(`
      SELECT 
        c.*,
        COUNT(cm.music_id) as music_count
      FROM collections c
      LEFT JOIN collection_music cm ON c.id = cm.collection_id
      WHERE c.is_system_collection = TRUE OR (c.user_id = ? AND c.is_system_collection = FALSE)
      GROUP BY c.id
      ORDER BY 
        CASE WHEN c.is_system_collection = TRUE THEN 0 ELSE 1 END,
        c.name ASC
    `, [userId]);

    // Separate system and user collections for summary
    const systemCollections = allCollections.filter(c => c.is_system_collection === 1);
    const userCollections = allCollections.filter(c => c.is_system_collection === 0);

    successResponse(res, {
      collections: allCollections.map(collection => ({
        id: collection.id,
        name: collection.name,
        description: collection.description,
        imageUrl: collection.image_url,
        userId: collection.user_id,
        isSystemCollection: collection.is_system_collection === 1,
        createdBy: collection.created_by,
        musicCount: collection.music_count,
        createdAt: collection.created_at,
        updatedAt: collection.updated_at
      })),
      summary: {
        total: allCollections.length,
        systemCollections: systemCollections.length,
        userCollections: userCollections.length,
        collectionsWithMusic: allCollections.filter(c => c.music_count > 0).length,
        emptyCollections: allCollections.filter(c => c.music_count === 0).length
      }
    }, 'All collections retrieved successfully');

  } catch (error) {
    console.error('Get all collections error:', error);
    errorResponse(res, 'Failed to get all collections', 500);
  }
});

// @route   GET /api/collections
// @desc    Get all collections of a user
// @access  Public
router.get('/', async (req, res) => {
  try {
    let userId = req.query.userId || req.query.user_id || req.body.userId || req.body.user_id;

    if (!userId) {
      // Try optional auth from header if userId is not explicitly provided
      const token = req.header('Authorization')?.replace('Bearer ', '');
      if (token) {
        try {
          const jwtSecret = process.env.JWT_SECRET || 'your-super-secret-jwt-key-for-sl-music-backend-2024';
          const decoded = jwt.verify(token, jwtSecret);
          userId = decoded.userId;
        } catch (err) {
          console.warn('Optional auth token validation failed:', err.message);
        }
      }
    }

    if (!userId) {
      return errorResponse(res, 'User ID is required', 400);
    }

    const mysqlConnection = getMySQLConnection();

    // Get all user collections with music count
    const [userCollections] = await mysqlConnection.execute(`
      SELECT 
        c.*,
        COUNT(cm.music_id) as music_count
      FROM collections c
      LEFT JOIN collection_music cm ON c.id = cm.collection_id
      WHERE c.user_id = ? AND c.is_system_collection = FALSE
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `, [userId]);

    successResponse(res, {
      collections: userCollections.map(collection => ({
        id: collection.id,
        name: collection.name,
        description: collection.description,
        imageUrl: collection.image_url,
        userId: collection.user_id,
        isSystemCollection: collection.is_system_collection === 1 || collection.is_system_collection === true,
        createdBy: collection.created_by,
        musicCount: collection.music_count,
        createdAt: collection.created_at,
        updatedAt: collection.updated_at
      }))
    }, 'Collections retrieved successfully');

  } catch (error) {
    console.error('Get collections error:', error);
    errorResponse(res, 'Failed to get collections', 500);
  }
});

// @route   GET /api/collections/:id
// @desc    Get collection details with music (any authenticated user)
// @access  Private (Any authenticated user)
router.get('/:id', auth, async (req, res) => {
  try {
    const { id: collectionId } = req.params;
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Check if collection exists (system collections or user's own collections)
    const [collections] = await mysqlConnection.execute(
      'SELECT * FROM collections WHERE id = ? AND (user_id = ? OR is_system_collection = TRUE)',
      [collectionId, userId]
    );

    if (collections.length === 0) {
      return errorResponse(res, 'Collection not found or access denied', 404);
    }

    const collection = collections[0];

    // Get music in this collection with full details
    const [musicList] = await mysqlConnection.execute(`
      SELECT 
        mp.*,
        cm.added_at as added_to_collection_at
      FROM collection_music cm
      JOIN music_publications mp ON cm.music_id = mp.id
      WHERE cm.collection_id = ?
      ORDER BY cm.added_at DESC
    `, [collectionId]);

    // Format music data to parse JSON fields
    const formattedMusic = musicList.map(music => ({
      ...music,
      vocal_parts: music.vocal_parts ? (typeof music.vocal_parts === 'string' ? JSON.parse(music.vocal_parts) : music.vocal_parts) : null,
      instrumentation: music.instrumentation ? (typeof music.instrumentation === 'string' ? JSON.parse(music.instrumentation) : music.instrumentation) : null,
      artists: music.artists ? (typeof music.artists === 'string' ? JSON.parse(music.artists) : music.artists) : [],
      composition_copyrights: music.composition_copyrights ? (typeof music.composition_copyrights === 'string' ? JSON.parse(music.composition_copyrights) : music.composition_copyrights) : [],
      music_files: music.music_files ? JSON.parse(music.music_files) : []
    }));

    successResponse(res, {
      collection: {
        id: collection.id,
        name: collection.name,
        description: collection.description,
        imageUrl: collection.image_url,
        userId: collection.user_id,
        isSystemCollection: collection.is_system_collection,
        createdBy: collection.created_by,
        createdAt: collection.created_at,
        updatedAt: collection.updated_at
      },
      music: formattedMusic,
      musicCount: formattedMusic.length
    }, 'Collection retrieved successfully');

  } catch (error) {
    console.error('Get collection error:', error);
    errorResponse(res, 'Failed to get collection', 500);
  }
});

// @route   PUT /api/collections/:id
// @desc    Update collection details (any authenticated user)
// @access  Private (Any authenticated user)
router.put('/:id', auth, async (req, res) => {
  try {
    const { id: collectionId } = req.params;
    const { name, description } = req.body;
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Check if collection exists and belongs to user
    const [collections] = await mysqlConnection.execute(
      'SELECT * FROM collections WHERE id = ? AND user_id = ?',
      [collectionId, userId]
    );

    if (collections.length === 0) {
      return errorResponse(res, 'Collection not found or access denied', 404);
    }

    // Validate required fields
    if (!name) {
      return errorResponse(res, 'Collection name is required', 400);
    }

    // Check if collection with same name already exists for this user (excluding current collection)
    const [existingCollections] = await mysqlConnection.execute(
      'SELECT id FROM collections WHERE user_id = ? AND name = ? AND id != ?',
      [userId, name, collectionId]
    );

    if (existingCollections.length > 0) {
      return errorResponse(res, 'Collection with this name already exists', 400);
    }

    // Update collection
    await mysqlConnection.execute(
      'UPDATE collections SET name = ?, description = ?, updated_at = NOW() WHERE id = ?',
      [name, description || null, collectionId]
    );

    // Get updated collection
    const [updatedCollections] = await mysqlConnection.execute(
      'SELECT * FROM collections WHERE id = ?',
      [collectionId]
    );

    successResponse(res, {
      collection: {
        id: updatedCollections[0].id,
        name: updatedCollections[0].name,
        description: updatedCollections[0].description,
        imageUrl: updatedCollections[0].image_url,
        userId: updatedCollections[0].user_id,
        createdAt: updatedCollections[0].created_at,
        updatedAt: updatedCollections[0].updated_at
      }
    }, 'Collection updated successfully');

  } catch (error) {
    console.error('Update collection error:', error);
    errorResponse(res, 'Failed to update collection', 500);
  }
});

// @route   DELETE /api/collections/:id
// @desc    Delete collection and all its music associations
// @access  Private (Authenticated users)

router.delete('/:id', auth, async (req, res) => {
  try {
    const { id: collectionId } = req.params;
    const userId = req.user.id;

    const mysqlConnection = getMySQLConnection();

    /* ------------------------------------
       1️⃣ Fetch user role
    ------------------------------------ */
    const [users] = await mysqlConnection.execute(
      `SELECT role, user_type, email
       FROM users
       WHERE id = ?`,
      [userId]
    );

    if (!users.length) {
      return errorResponse(res, 'User not found', 404);
    }

    const user = users[0];
    const isSuperAdmin =
      user.role === 'sl_team' && user.user_type === 'superadmin';

    /* ------------------------------------
       2️⃣ Fetch collection (based on access)
    ------------------------------------ */
    let collections;

    if (isSuperAdmin) {
      // Superadmin → any collection
      [collections] = await mysqlConnection.execute(
        'SELECT * FROM collections WHERE id = ?',
        [collectionId]
      );
    } else {
      // Normal user → own collection only
      [collections] = await mysqlConnection.execute(
        'SELECT * FROM collections WHERE id = ? AND user_id = ?',
        [collectionId, userId]
      );
    }

    if (!collections.length) {
      return errorResponse(res, 'Collection not found or access denied', 404);
    }

    /* ------------------------------------
       3️⃣ Count music in collection
    ------------------------------------ */
    const [musicCountRows] = await mysqlConnection.execute(
      `SELECT COUNT(*) AS count
       FROM collection_music
       WHERE collection_id = ?`,
      [collectionId]
    );

    const deletedMusicCount = musicCountRows[0].count || 0;

    /* ------------------------------------
       4️⃣ Delete associations
    ------------------------------------ */
    await mysqlConnection.execute(
      'DELETE FROM collection_music WHERE collection_id = ?',
      [collectionId]
    );

    /* ------------------------------------
       5️⃣ Delete collection
    ------------------------------------ */
    await mysqlConnection.execute(
      'DELETE FROM collections WHERE id = ?',
      [collectionId]
    );

    /* ------------------------------------
       6️⃣ Response
    ------------------------------------ */
    return successResponse(
      res,
      {
        collectionId,
        deletedMusicCount
      },
      `Collection deleted successfully. Removed ${deletedMusicCount} music associations.`,
      200
    );

  } catch (error) {
    console.error('❌ Delete collection error:', error);
    return errorResponse(res, 'Failed to delete collection', 500);
  }
});

module.exports = router;