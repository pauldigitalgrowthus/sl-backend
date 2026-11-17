const express = require('express');
const router = express.Router();
const { getMySQLConnection } = require('../../config/mysql');
const { auth } = require('../../middleware/auth');
const { uploadAnyFile, communityMusicLibraryUpload } = require('../../config/s3');
const { successResponse, errorResponse } = require('../../utils/response');
const { parseJsonSafe, stringifyJsonSafe, resolveCommunityId } = require('./helpers');

// ============================================
// PLANNER TEMPLATES ROUTES
// ============================================

/**
 *  * =====================================================
 * GET /api/planners/templates
 * Fetch all templates of community
 * =====================================================
 * Access: Private
 * Community based
 * =====================================================
*/
router.get('/', auth, async (req, res) => {
  try {
    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    const [rows] = await connection.execute(
      `SELECT id, template_name, template_description, template_data, created_by, created_at, updated_at
       FROM planner_templates
       WHERE created_by = ?
       ORDER BY updated_at DESC, created_at DESC`,
      [communityId]
    );

    const templates = rows.map((t) => ({
      ...t,
      template_data: parseJsonSafe(t.template_data, {
        sections: [],
        notes: [],
        files: [],
        music: []
      })
    }));

    return successResponse(res, { templates, total: templates.length }, 'Templates fetched successfully', 200);
  } catch (err) {
    console.error('Error fetching templates:', err);
    return errorResponse(res, 'Error fetching templates', 500);
  }
});

/**
 * =====================================================
 * POST /api/planners/templates
 * Create planner template with notes & files
 * (NO minister_ids stored in template_data)
 * =====================================================
 * Access : Private
 * Type   : multipart/form-data
 * =====================================================
 */
router.post('/', auth, uploadAnyFile.any(), async (req, res) => {
  try {
    const {
      template_name,
      template_description,
      notes,
      sections,
      file_descriptions
    } = req.body;

    // 1️⃣ Validation
    if (!template_name) {
      return errorResponse(res, 'template_name is required', 400);
    }

    const connection = getMySQLConnection();

    // 2️⃣ Resolve community / parent user
    const communityId = await resolveCommunityId(connection, req.user.id);

    // ===========================
    // 3️⃣ Parse NOTES
    // ===========================
    let parsedNotes = [];
    if (notes) {
      try {
        parsedNotes = typeof notes === 'string' ? JSON.parse(notes) : notes;
      } catch {
        return errorResponse(res, 'Invalid notes JSON format', 400);
      }
    }

    const normalizedNotes = Array.isArray(parsedNotes)
      ? parsedNotes.map(note => ({
        id: Date.now() + Math.floor(Math.random() * 1000),
        title: note.title || '',
        content: note.content || '',
        createdAt: new Date().toISOString()
      }))
      : [];

    // ===========================
    // 4️⃣ Parse SECTIONS
    // ===========================
    let parsedSections = [];
    if (sections) {
      try {
        parsedSections =
          typeof sections === 'string'
            ? JSON.parse(sections)
            : sections;
      } catch {
        return errorResponse(res, 'Invalid sections JSON format', 400);
      }
    }

    /**
     * IMPORTANT:
     *  - Remove minister_ids from headers
     *  - Remove any runtime-only fields (id, headerId)
     */
    const normalizedSections = Array.isArray(parsedSections)
      ? parsedSections.map(section => {
        const cleanSection = { ...section };

        delete cleanSection.id;
        delete cleanSection.headerId;
        delete cleanSection.minister_ids; // ❌ NOT stored in templates

        return cleanSection;
      })
      : [];

    // ===========================
    // 5️⃣ Parse FILE DESCRIPTIONS
    // ===========================
    let parsedFileDescriptions = [];
    if (file_descriptions) {
      try {
        parsedFileDescriptions =
          typeof file_descriptions === 'string'
            ? JSON.parse(file_descriptions)
            : file_descriptions;
      } catch {
        return errorResponse(res, 'Invalid file_descriptions JSON format', 400);
      }
    }

    // ===========================
    // 6️⃣ Handle uploaded FILES
    // ===========================
    const uploadedFiles = Array.isArray(req.files)
      ? req.files.map((file, index) => ({
        id: Date.now() + index,
        filename: file.originalname,
        original_name: file.originalname,
        description: parsedFileDescriptions[index] || null,
        url: file.location,
        size: file.size,
        type: file.mimetype,
        uploaded_by: req.user.id,
        createdAt: new Date().toISOString()
      }))
      : [];

    // ===========================
    // 7️⃣ Build TEMPLATE DATA
    // ===========================
    const templateData = {
      sections: normalizedSections, // 👈 ministers removed
      notes: normalizedNotes,
      files: uploadedFiles,
      music: []
    };

    // ===========================
    // 8️⃣ Insert into DB
    // ===========================
    const [result] = await connection.execute(
      `INSERT INTO planner_templates
         (template_name, template_description, template_data, created_by)
         VALUES (?, ?, ?, ?)`,
      [
        template_name,
        template_description || null,
        JSON.stringify(templateData),
        communityId
      ]
    );

    // ===========================
    // 9️⃣ Fetch created TEMPLATE
    // ===========================
    const [[template]] = await connection.execute(
      `SELECT *
         FROM planner_templates
         WHERE id = ?`,
      [result.insertId]
    );

    template.template_data = parseJsonSafe(
      template.template_data,
      templateData
    );

    return successResponse(
      res,
      template,
      'Template created (no ministers stored)',
      201
    );

  } catch (err) {
    console.error('Error creating template:', err);
    return errorResponse(res, 'Error creating template', 500);
  }
});


// ============================================
// TEMPLATE NOTES ROUTES
// ============================================

/**
 * =====================================================
 * POST /api/planners/templates/:templateId/notes
 * Add Note to template
 * =====================================================
*/
router.post('/:templateId/notes', auth, async (req, res) => {
  try {
    const { templateId } = req.params;
    const { title, content } = req.body;

    if (!title) return errorResponse(res, 'title is required', 400);

    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    const [rows] = await connection.execute(
      'SELECT * FROM planner_templates WHERE id = ? AND created_by = ?',
      [templateId, communityId]
    );

    if (!rows.length) return errorResponse(res, 'Template not found', 404);

    const template = rows[0];
    const data = parseJsonSafe(template.template_data, {});
    const notes = Array.isArray(data.notes) ? data.notes : [];

    const note = {
      id: Date.now(),
      title,
      content: content || '',
      createdAt: new Date().toISOString()
    };

    data.notes = [...notes, note];

    await connection.execute(
      'UPDATE planner_templates SET template_data = ?, updated_at = NOW() WHERE id = ? AND created_by = ?',
      [JSON.stringify(data), templateId, communityId]
    );

    return successResponse(res, note, 'Note added successfully');
  } catch (err) {
    console.error('Error adding note:', err);
    return errorResponse(res, 'Error adding note', 500);
  }
});

/**
 * =====================================================
 * PUT /api/planners/templates/:templateId/notes/:noteId
 * Update Note in template
 * =====================================================
*/
router.put('/:templateId/notes/:noteId', auth, async (req, res) => {
  try {
    const { templateId, noteId } = req.params;
    const { title, content } = req.body;

    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    const [rows] = await connection.execute(
      'SELECT * FROM planner_templates WHERE id = ? AND created_by = ?',
      [templateId, communityId]
    );

    if (!rows.length) return errorResponse(res, 'Template not found', 404);

    const template = rows[0];
    const data = parseJsonSafe(template.template_data, {});
    const notes = Array.isArray(data.notes) ? data.notes : [];

    const nidNum = Number(noteId);
    const idx = notes.findIndex((n) => Number(n.id) === nidNum);

    if (idx === -1) return errorResponse(res, 'Note not found', 404);

    const current = notes[idx];
    const updated = {
      ...current,
      title: title !== undefined ? title : current.title,
      content: content !== undefined ? content : current.content,
      updatedAt: new Date().toISOString()
    };

    notes[idx] = updated;
    data.notes = notes;

    await connection.execute(
      'UPDATE planner_templates SET template_data = ?, updated_at = NOW() WHERE id = ? AND created_by = ?',
      [JSON.stringify(data), templateId, communityId]
    );

    return successResponse(res, updated, 'Note updated successfully');
  } catch (err) {
    console.error('Error updating note:', err);
    return errorResponse(res, 'Error updating note', 500);
  }
});

/**
 * =====================================================
 * DELETE /api/planners/templates/:templateId/notes/:noteId
 * Delete Note in template
 * =====================================================
*/
router.delete('/:templateId/notes/:noteId', auth, async (req, res) => {
  try {
    const { templateId, noteId } = req.params;
    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    const [rows] = await connection.execute(
      'SELECT * FROM planner_templates WHERE id = ? AND created_by = ?',
      [templateId, communityId]
    );

    if (!rows.length) return errorResponse(res, 'Template not found', 404);

    const template = rows[0];
    const data = parseJsonSafe(template.template_data, {});
    const notes = Array.isArray(data.notes) ? data.notes : [];

    const nidNum = Number(noteId);
    const filtered = notes.filter((n) => Number(n.id) !== nidNum);

    if (filtered.length === notes.length) {
      return errorResponse(res, 'Note not found', 404);
    }

    data.notes = filtered;

    await connection.execute(
      'UPDATE planner_templates SET template_data = ?, updated_at = NOW() WHERE id = ? AND created_by = ?',
      [JSON.stringify(data), templateId, communityId]
    );

    return successResponse(res, { id: nidNum }, 'Note deleted successfully');
  } catch (err) {
    console.error('Error deleting note:', err);
    return errorResponse(res, 'Error deleting note', 500);
  }
});

// ============================================
// TEMPLATE FILES ROUTES
// ============================================

/**
 * =====================================================
 * POST /api/planners/templates/:templateId/files
 * Upload file + save filename & description
 * =====================================================
 */
router.post('/:templateId/files', auth, uploadAnyFile.single('file'), async (req, res) => {
  try {
    const { templateId } = req.params;
    const { filename, description } = req.body;

    // 1️⃣ Validate file
    if (!req.file) {
      return errorResponse(res, 'No file uploaded', 400);
    }

    const connection = getMySQLConnection();

    // 2️⃣ Resolve community
    const communityId = await resolveCommunityId(connection, req.user.id);

    // 3️⃣ Fetch template (ownership check)
    const [rows] = await connection.execute(
      `SELECT template_data
         FROM planner_templates
         WHERE id = ? AND created_by = ?`,
      [templateId, communityId]
    );

    if (!rows.length) {
      return errorResponse(res, 'Template not found', 404);
    }

    // 4️⃣ Parse existing template_data
    const template = rows[0];
    const data = parseJsonSafe(template.template_data, {});
    const files = Array.isArray(data.files) ? data.files : [];

    // 5️⃣ Build file object
    const fileItem = {
      id: Date.now(),
      filename: filename?.trim() || req.file.originalname, // ✅ payload override
      original_name: req.file.originalname,
      description: description?.trim() || null,
      url: req.file.location,
      size: req.file.size,
      type: req.file.mimetype,
      uploaded_by: req.user.id,
      createdAt: new Date().toISOString()
    };

    // 6️⃣ Push new file
    data.files = [...files, fileItem];

    // 7️⃣ Update template_data JSON
    await connection.execute(
      `UPDATE planner_templates
         SET template_data = ?, updated_at = NOW()
         WHERE id = ? AND created_by = ?`,
      [JSON.stringify(data), templateId, communityId]
    );

    return successResponse(
      res,
      fileItem,
      'File uploaded successfully'
    );

  } catch (err) {
    console.error('Error uploading template file:', err);
    return errorResponse(res, 'Error uploading file', 500);
  }
}
);

/**
 * =====================================================
 * DELETE /api/planners/templates/:templateId/files/:fileId
 * Delete file
 * =====================================================
*/
router.delete('/:templateId/files/:fileId', auth, async (req, res) => {
  try {
    const { templateId, fileId } = req.params;
    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    const [rows] = await connection.execute(
      'SELECT * FROM planner_templates WHERE id = ? AND created_by = ?',
      [templateId, communityId]
    );

    if (!rows.length) return errorResponse(res, 'Template not found', 404);

    const template = rows[0];
    const data = parseJsonSafe(template.template_data, {});
    const files = Array.isArray(data.files) ? data.files : [];

    const fidNum = Number(fileId);
    const filtered = files.filter((f) => Number(f.id) !== fidNum);

    if (filtered.length === files.length) {
      return errorResponse(res, 'File not found', 404);
    }

    data.files = filtered;

    await connection.execute(
      'UPDATE planner_templates SET template_data = ?, updated_at = NOW() WHERE id = ? AND created_by = ?',
      [JSON.stringify(data), templateId, communityId]
    );

    return successResponse(res, { id: fidNum }, 'File deleted successfully');
  } catch (err) {
    console.error('Error deleting file:', err);
    return errorResponse(res, 'Error deleting file', 500);
  }
});

// ============================================
// TEMPLATE MUSIC ROUTES
// ============================================

/**
 * =====================================================
 * POST /api/planners/templates/:templateId/music
 * Attach music reference to template
 * =====================================================
*/
router.post('/:templateId/music', auth, async (req, res) => {
  try {
    const { templateId } = req.params;
    const { source, source_id, title, meta } = req.body;

    if (!source || !source_id) {
      return errorResponse(res, 'source and source_id are required', 400);
    }

    const allowedSources = ['sl_published', 'user_library', 'community_non_sl'];
    if (!allowedSources.includes(source)) {
      return errorResponse(res, 'Invalid source', 400);
    }

    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    const [rows] = await connection.execute(
      'SELECT * FROM planner_templates WHERE id = ? AND created_by = ?',
      [templateId, communityId]
    );

    if (!rows.length) return errorResponse(res, 'Template not found', 404);

    const template = rows[0];
    const data = parseJsonSafe(template.template_data, {});
    const music = Array.isArray(data.music) ? data.music : [];

    const musicItem = {
      id: Date.now(),
      source,
      source_id,
      title: title || null,
      meta: meta && typeof meta === 'object' ? meta : null,
      createdAt: new Date().toISOString()
    };

    data.music = [...music, musicItem];

    await connection.execute(
      'UPDATE planner_templates SET template_data = ?, updated_at = NOW() WHERE id = ? AND created_by = ?',
      [JSON.stringify(data), templateId, communityId]
    );

    return successResponse(res, musicItem, 'Music attached successfully');
  } catch (err) {
    console.error('Error attaching music:', err);
    return errorResponse(res, 'Error attaching music', 500);
  }
});

/**
 * =====================================================
 * POST /api/planners/templates/:templateId/non-sl-music
 * Create and attach non-SL music to template
 * =====================================================
*/
router.post(
  '/:templateId/non-sl-music',
  auth,
  communityMusicLibraryUpload.fields([
    { name: 'pdfFiles', maxCount: 10 },
    { name: 'mp3Files', maxCount: 10 },
    { name: 'imageFiles', maxCount: 10 }
  ]),
  async (req, res) => {
    try {
      const { templateId } = req.params;
      const {
        musicTitle,
        composerName,
        category,
        year,
        tags,
        notes
      } = req.body;

      if (!musicTitle || !composerName) {
        return errorResponse(res, 'musicTitle and composerName are required', 400);
      }

      const connection = getMySQLConnection();
      const communityId = await resolveCommunityId(connection, req.user.id);

      const [templateRows] = await connection.execute(
        'SELECT * FROM planner_templates WHERE id = ? AND created_by = ?',
        [templateId, communityId]
      );

      if (!templateRows.length) return errorResponse(res, 'Template not found', 404);

      const pdfFiles = req.files?.pdfFiles
        ? req.files.pdfFiles.map((f) => ({
          url: f.location,
          size: f.size,
          name: f.originalname,
          type: f.mimetype
        }))
        : [];

      const mp3Files = req.files?.mp3Files
        ? req.files.mp3Files.map((f) => ({
          url: f.location,
          size: f.size,
          name: f.originalname,
          type: f.mimetype
        }))
        : [];

      const imageFiles = req.files?.imageFiles
        ? req.files.imageFiles.map((f) => ({
          url: f.location,
          size: f.size,
          name: f.originalname,
          type: f.mimetype
        }))
        : [];

      let parsedTags = [];
      if (tags) {
        try {
          parsedTags = typeof tags === 'string' ? JSON.parse(tags) : tags;
        } catch (_) {
          parsedTags = Array.isArray(tags) ? tags : [tags];
        }
      }

      const [insertResult] = await connection.execute(
        `INSERT INTO community_music_library (
          parent_user_id, is_sl_music, music_publication_id,
          music_title, composer_name, category, year, tags, notes,
          pdf_files, mp3_files, image_files, added_by_user_id
        ) VALUES (?, FALSE, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          communityId,
          musicTitle,
          composerName,
          category || null,
          year || null,
          stringifyJsonSafe(parsedTags),
          notes || null,
          stringifyJsonSafe(pdfFiles),
          stringifyJsonSafe(mp3Files),
          stringifyJsonSafe(imageFiles),
          req.user.id
        ]
      );

      const source_id = insertResult.insertId;
      const template = templateRows[0];
      const data = parseJsonSafe(template.template_data, {});
      const music = Array.isArray(data.music) ? data.music : [];

      const musicItem = {
        id: Date.now(),
        source: 'community_non_sl',
        source_id,
        title: musicTitle,
        meta: {
          composer_name: composerName,
          category: category || null,
          year: year || null,
          tags: parsedTags,
          notes: notes || null,
          pdf_files: pdfFiles,
          mp3_files: mp3Files,
          image_files: imageFiles
        },
        createdAt: new Date().toISOString()
      };

      data.music = [...music, musicItem];

      await connection.execute(
        'UPDATE planner_templates SET template_data = ?, updated_at = NOW() WHERE id = ? AND created_by = ?',
        [JSON.stringify(data), templateId, communityId]
      );

      return successResponse(
        res,
        { music_library_id: source_id, attached: musicItem },
        'Non-SL music created and attached successfully'
      );
    } catch (err) {
      console.error('Error creating non-SL music for template:', err);
      return errorResponse(res, 'Error creating non-SL music', 500);
    }
  }
);

/**
 * =====================================================
 * DELETE /api/planners/templates/:templateId/music/:musicId
 * Delete music to template
 * =====================================================
*/
router.delete('/:templateId/music/:musicId', auth, async (req, res) => {
  try {
    const { templateId, musicId } = req.params;
    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    const [rows] = await connection.execute(
      'SELECT * FROM planner_templates WHERE id = ? AND created_by = ?',
      [templateId, communityId]
    );

    if (!rows.length) return errorResponse(res, 'Template not found', 404);

    const template = rows[0];
    const data = parseJsonSafe(template.template_data, {});
    const music = Array.isArray(data.music) ? data.music : [];

    const midNum = Number(musicId);
    const filtered = music.filter((m) => Number(m.id) !== midNum);

    if (filtered.length === music.length) {
      return errorResponse(res, 'Music not found', 404);
    }

    data.music = filtered;

    await connection.execute(
      'UPDATE planner_templates SET template_data = ?, updated_at = NOW() WHERE id = ? AND created_by = ?',
      [JSON.stringify(data), templateId, communityId]
    );

    return successResponse(res, { id: midNum }, 'Music deleted successfully');
  } catch (err) {
    console.error('Error deleting music:', err);
    return errorResponse(res, 'Error deleting music', 500);
  }
});


/**
 * =====================================================
 * GET /api/planners/templates/:templateId
 * Get single template
 * =====================================================
*/
router.get('/templates/:templateId', auth, async (req, res) => {
  try {
    const { templateId } = req.params;
    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    const [rows] = await connection.execute(
      `SELECT * FROM planner_templates WHERE id = ? AND created_by = ?`,
      [templateId, communityId]
    );

    if (!rows.length) return errorResponse(res, 'Template not found', 404);

    const template = rows[0];
    template.template_data = parseJsonSafe(template.template_data, {
      sections: [],
      notes: [],
      files: [],
      music: []
    });

    return successResponse(res, template, 'Template fetched successfully');
  } catch (err) {
    console.error('Error fetching template:', err);
    return errorResponse(res, 'Error fetching template', 500);
  }
});


/**
 * =====================================================
 * PUT /api/planners/templates/:templateId
 * Update template
 * =====================================================
*/
router.put('/templates/:templateId', auth, async (req, res) => {
  try {
    const { templateId } = req.params;
    const { template_name, template_description, template_data } = req.body;

    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    const [existing] = await connection.execute(
      'SELECT * FROM planner_templates WHERE id = ? AND created_by = ?',
      [templateId, communityId]
    );

    if (!existing.length) return errorResponse(res, 'Template not found', 404);

    const updates = [];
    const values = [];

    if (template_name !== undefined) {
      updates.push('template_name = ?');
      values.push(template_name);
    }
    if (template_description !== undefined) {
      updates.push('template_description = ?');
      values.push(template_description);
    }
    if (template_data !== undefined) {
      const data = (template_data && typeof template_data === 'object') ? template_data : {};
      updates.push('template_data = ?');
      values.push(JSON.stringify(data));
    }

    if (!updates.length) {
      return errorResponse(res, 'No fields to update', 400);
    }

    values.push(templateId, communityId);
    await connection.execute(
      `UPDATE planner_templates SET ${updates.join(', ')}, updated_at = NOW() 
       WHERE id = ? AND created_by = ?`,
      values
    );

    const [updated] = await connection.execute(
      'SELECT * FROM planner_templates WHERE id = ?',
      [templateId]
    );

    const template = updated[0];
    template.template_data = parseJsonSafe(template.template_data, {});

    return successResponse(res, template, 'Template updated successfully');
  } catch (err) {
    console.error('Error updating template:', err);
    return errorResponse(res, 'Error updating template', 500);
  }
});

/**
 * =====================================================
 * DELETE /api/planners/templates/:templateId
 * Delete template
 * =====================================================
*/
router.delete('/templates/:templateId', auth, async (req, res) => {
  try {
    const { templateId } = req.params;
    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    const [existing] = await connection.execute(
      'SELECT id FROM planner_templates WHERE id = ? AND created_by = ?',
      [templateId, communityId]
    );

    if (!existing.length) return errorResponse(res, 'Template not found', 404);

    await connection.execute(
      'DELETE FROM planner_templates WHERE id = ? AND created_by = ?',
      [templateId, communityId]
    );

    return successResponse(res, { id: Number(templateId) }, 'Template deleted successfully');
  } catch (err) {
    console.error('Error deleting template:', err);
    return errorResponse(res, 'Error deleting template', 500);
  }
});

// ============================================
// TEMPLATE SECTIONS ROUTES
// ============================================

/**
 * =====================================================
 * POST /api/planners/templates/:templateId/sections
 * Add section
 * =====================================================
*/
router.post('/templates/:templateId/sections', auth, async (req, res) => {
  try {
    const { templateId } = req.params;
    const { title, description, items } = req.body;

    if (!title) return errorResponse(res, 'title is required', 400);

    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    const [rows] = await connection.execute(
      'SELECT * FROM planner_templates WHERE id = ? AND created_by = ?',
      [templateId, communityId]
    );

    if (!rows.length) return errorResponse(res, 'Template not found', 404);

    const template = rows[0];
    const data = parseJsonSafe(template.template_data, {});
    const sections = Array.isArray(data.sections) ? data.sections : [];

    const section = {
      id: Date.now(),
      title,
      description: description || '',
      items: Array.isArray(items) ? items : [],
      createdAt: new Date().toISOString()
    };

    data.sections = [...sections, section];

    await connection.execute(
      'UPDATE planner_templates SET template_data = ?, updated_at = NOW() WHERE id = ? AND created_by = ?',
      [JSON.stringify(data), templateId, communityId]
    );

    return successResponse(res, section, 'Section added successfully');
  } catch (err) {
    console.error('Error adding section:', err);
    return errorResponse(res, 'Error adding section', 500);
  }
});

/**
 * =====================================================
 * PUT /api/planners/templates/:templateId/sections/:sectionId
 * Update section
 * =====================================================
*/
router.put('/templates/:templateId/sections/:sectionId', auth, async (req, res) => {
  try {
    const { templateId, sectionId } = req.params;
    const { title, description, items } = req.body;

    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    const [rows] = await connection.execute(
      'SELECT * FROM planner_templates WHERE id = ? AND created_by = ?',
      [templateId, communityId]
    );

    if (!rows.length) return errorResponse(res, 'Template not found', 404);

    const template = rows[0];
    const data = parseJsonSafe(template.template_data, {});
    const sections = Array.isArray(data.sections) ? data.sections : [];

    const sidNum = Number(sectionId);
    const idx = sections.findIndex((s) => Number(s.id) === sidNum);

    if (idx === -1) return errorResponse(res, 'Section not found', 404);

    const current = sections[idx];
    const updated = {
      ...current,
      title: title !== undefined ? title : current.title,
      description: description !== undefined ? (description || '') : current.description,
      items: items !== undefined ? (Array.isArray(items) ? items : []) : current.items,
      updatedAt: new Date().toISOString()
    };

    sections[idx] = updated;
    data.sections = sections;

    await connection.execute(
      'UPDATE planner_templates SET template_data = ?, updated_at = NOW() WHERE id = ? AND created_by = ?',
      [JSON.stringify(data), templateId, communityId]
    );

    return successResponse(res, updated, 'Section updated successfully');
  } catch (err) {
    console.error('Error updating section:', err);
    return errorResponse(res, 'Error updating section', 500);
  }
});

/**
 * =====================================================
 * DELETE /api/planners/templates/:templateId/sections/:sectionId
 * Delete section
 * =====================================================
*/
router.delete('/templates/:templateId/sections/:sectionId', auth, async (req, res) => {
  try {
    const { templateId, sectionId } = req.params;
    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    const [rows] = await connection.execute(
      'SELECT * FROM planner_templates WHERE id = ? AND created_by = ?',
      [templateId, communityId]
    );

    if (!rows.length) return errorResponse(res, 'Template not found', 404);

    const template = rows[0];
    const data = parseJsonSafe(template.template_data, {});
    const sections = Array.isArray(data.sections) ? data.sections : [];

    const sidNum = Number(sectionId);
    const filtered = sections.filter((s) => Number(s.id) !== sidNum);

    if (filtered.length === sections.length) {
      return errorResponse(res, 'Section not found', 404);
    }

    data.sections = filtered;

    await connection.execute(
      'UPDATE planner_templates SET template_data = ?, updated_at = NOW() WHERE id = ? AND created_by = ?',
      [JSON.stringify(data), templateId, communityId]
    );

    return successResponse(res, { id: sidNum }, 'Section deleted successfully');
  } catch (err) {
    console.error('Error deleting section:', err);
    return errorResponse(res, 'Error deleting section', 500);
  }
});

module.exports = router;