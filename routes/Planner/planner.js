const express = require('express');
const router = express.Router();
const { getMySQLConnection } = require('../../config/mysql');
const { auth } = require('../../middleware/auth');
const { successResponse, errorResponse } = require('../../utils/response');
const { parseJsonSafe, stringifyJsonSafe, resolveCommunityId } = require('./helpers');
const { uploadAnyFile, communityMusicLibraryUpload } = require('../../config/s3');


// ============================================
// MUSIC SUGGESTIONS ROUTES
// ============================================

/**
 * =====================================================
 * GET /api/planners/music-suggestions/community-non-sl
 * Fetch community non-SL music suggestions
 * =====================================================
 * Access : Private
 * Query  : q (search), limit
 * Source : community_music_library
 * =====================================================
 */
router.get('/music-suggestions/community-non-sl', auth, async (req, res) => {
  try {
    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);
    const q = (req.query.q || '').toString().trim();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

    const like = `%${q}%`;
    const [rows] = await connection.execute(
      `SELECT
        id, music_title, composer_name, category, year, tags, notes,
        pdf_files, mp3_files, image_files, created_at
       FROM community_music_library
       WHERE parent_user_id = ? AND is_sl_music = 0 AND deleted_at IS NULL
         AND (? = '' OR music_title LIKE ? OR composer_name LIKE ? OR category LIKE ?)
       ORDER BY created_at DESC
       LIMIT ?`,
      [communityId, q, like, like, like, limit]
    );

    const items = rows.map((r) => ({
      source: 'community_non_sl',
      source_id: r.id,
      title: r.music_title,
      composer_name: r.composer_name,
      category: r.category,
      year: r.year,
      meta: {
        tags: parseJsonSafe(r.tags, []),
        notes: r.notes || null,
        pdf_files: parseJsonSafe(r.pdf_files, []),
        mp3_files: parseJsonSafe(r.mp3_files, []),
        image_files: parseJsonSafe(r.image_files, [])
      }
    }));

    return successResponse(res, items, 'Community non-SL music fetched', { total: items.length });
  } catch (err) {
    console.error('Error fetching community non-SL music:', err);
    return errorResponse(res, 'Error fetching community non-SL music', 500);
  }
});

/**
 * =====================================================
 * GET /api/planners/music-suggestions/user-library
 * Fetch user purchased music suggestions
 * =====================================================
 * Access : Private
 * Query  : q (search), limit
 * Source : user_music_library
 * =====================================================
 */
router.get('/music-suggestions/user-library', auth, async (req, res) => {
  try {
    const connection = getMySQLConnection();
    const userId = req.user.id;
    const q = (req.query.q || '').toString().trim();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

    const like = `%${q}%`;
    const [rows] = await connection.execute(
      `SELECT
        id, music_publication_id, composition_title, composition_title_1,
        composer_firstname, composer_lastname, file_type, file_name,
        file_url, file_size, purchase_date
       FROM user_music_library
       WHERE user_id = ?
         AND (? = '' OR composition_title LIKE ? OR composition_title_1 LIKE ? 
              OR composer_firstname LIKE ? OR composer_lastname LIKE ? OR file_name LIKE ?)
       ORDER BY purchase_date DESC
       LIMIT ?`,
      [userId, q, like, like, like, like, like, limit]
    );

    const items = rows.map((r) => ({
      source: 'user_library',
      source_id: r.id,
      title: r.composition_title || r.composition_title_1 || r.file_name,
      meta: {
        music_publication_id: r.music_publication_id,
        file_type: r.file_type,
        file_name: r.file_name,
        file_url: r.file_url,
        file_size: r.file_size,
        composer_firstname: r.composer_firstname,
        composer_lastname: r.composer_lastname,
        purchase_date: r.purchase_date
      }
    }));

    return successResponse(res, items, 'User library music fetched', { total: items.length });
  } catch (err) {
    console.error('Error fetching user library music:', err);
    return errorResponse(res, 'Error fetching user library music', 500);
  }
});

/**
 * =====================================================
 * GET /api/planners/music-suggestions/sl-published
 * Fetch SL published music suggestions
 * =====================================================
 * Access : Private
 * Query  : q (search), limit
 * Source : music_publications
 * =====================================================
 */
router.get('/music-suggestions/sl-published', auth, async (req, res) => {
  try {
    const connection = getMySQLConnection();
    const q = (req.query.q || '').toString().trim();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

    const like = `%${q}%`;
    const [rows] = await connection.execute(
      `SELECT
        id, composition_title, composition_title_1, composer_firstname,
        composer_lastname, category, year_of_composition, created_at
       FROM music_publications
       WHERE status = 'published' AND deleted_at IS NULL
         AND (? = '' OR composition_title LIKE ? OR composition_title_1 LIKE ?
              OR composer_firstname LIKE ? OR composer_lastname LIKE ?)
       ORDER BY created_at DESC
       LIMIT ?`,
      [q, like, like, like, like, limit]
    );

    const items = rows.map((r) => ({
      source: 'sl_published',
      source_id: r.id,
      title: r.composition_title || r.composition_title_1,
      meta: {
        composer_firstname: r.composer_firstname,
        composer_lastname: r.composer_lastname,
        category: r.category,
        year: r.year_of_composition
      }
    }));

    return successResponse(res, items, 'SL published music fetched', { total: items.length });
  } catch (err) {
    console.error('Error fetching SL published music:', err);
    return errorResponse(res, 'Error fetching SL published music', 500);
  }
});

// ============================================
// PLANNER CRUD ROUTES
// ============================================

/**
 * =====================================================
 * GET /api/planners
 * Fetch planners with filters + pagination
 * =====================================================
 */
router.get("/", auth, async (req, res) => {
  try {

    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    const {
      start_date,
      end_date,
      service_type,
      status,
      page = 1,
      limit = 20
    } = req.query;

    const pageNumber = parseInt(page);
    const pageLimit = parseInt(limit);
    const offset = (pageNumber - 1) * pageLimit;

    /* ================= WHERE CLAUSE ================= */

    let whereClause = `WHERE community_id = ?`;
    const queryParams = [communityId];

    if (start_date) {
      whereClause += ` AND DATE(service_date) >= ?`;
      queryParams.push(start_date);
    }

    if (end_date) {
      whereClause += ` AND DATE(service_date) <= ?`;
      queryParams.push(end_date);
    }

    if (service_type) {
      whereClause += ` AND service_type = ?`;
      queryParams.push(service_type);
    }

    if (status) {
      whereClause += ` AND status = ?`;
      queryParams.push(status);
    }

    /* ================= FETCH PLANNERS ================= */

    const [planners] = await connection.execute(
      `
      SELECT *
      FROM planners
      ${whereClause}
      ORDER BY service_date DESC, created_at DESC
      LIMIT ? OFFSET ?
      `,
      [...queryParams, pageLimit, offset]
    );

    if (!planners.length) {
      return successResponse(res, [], "No planners found", 200);
    }

    /* ================= PROCESS ================= */

    const filteredPlanners = [];

    for (const planner of planners) {

      let templateData = planner.template_data
        ? parseJsonSafe(planner.template_data, { sections: [] })
        : { sections: [] };

      let serviceTimes = planner.service_times
        ? parseJsonSafe(planner.service_times, {})
        : {};

      /* ==========================================
         🔥 FIXED USER FILTER
      ========================================== */

      if (
        req.user.user_type === "sub_user" ||
        req.user.user_type === "manager"
      ) {

        const email = (req.user.email || "").toLowerCase();
        const entities = serviceTimes?.mass_entities || [];

        const matchedEntities = entities.filter(entity => {

          const ministers = entity.selectedItems || [];

          return ministers.some(
            m =>
              m.type === "minister" &&
              (m.email || "").toLowerCase() === email
          );

        });

        // ❌ OLD: skip completely
        // if (!matchedEntities.length) continue;

        // ✅ NEW: fallback allow
        if (matchedEntities.length) {
          serviceTimes.mass_entities = matchedEntities;
        }

        /* ================= TIME FILTER ================= */

        const allowedTimes = new Set();

        (matchedEntities.length ? matchedEntities : entities).forEach(e => {
          if (!e.hour || !e.minute || !e.ampm) return;

          const hour = e.hour.padStart(2, "0");
          const minute = e.minute.padStart(2, "0");
          const ampm = e.ampm;

          allowedTimes.add(`${hour}:${minute} ${ampm}`);
        });

        const sections = templateData.sections || [];

        const allowedHeaderIds = new Set();

        sections.forEach(section => {

          if (
            section.type === "header" &&
            allowedTimes.has(section.time)
          ) {
            allowedHeaderIds.add(section.id);
          }

        });

        templateData.sections = sections.filter(section => {

          if (
            section.type === "header" &&
            allowedHeaderIds.has(section.id)
          ) return true;

          if (
            section.headerId &&
            allowedHeaderIds.has(section.headerId)
          ) return true;

          return false;
        });

      }

      filteredPlanners.push({
        ...planner,
        template_data: templateData,
        service_times: serviceTimes
      });

    }

    /* ================= RESPONSE ================= */

    return successResponse(
      res,
      filteredPlanners,
      "Planners fetched successfully",
      200
    );

  } catch (err) {

    console.error("❌ Error fetching planners:", err);
    return errorResponse(res, "Error fetching planners", 500);

  }
});

/**
 * =====================================================
 * GET /api/planners/:id
 * Fetch single planner with service times, template & ministers
 * =====================================================
 * Access : Private
 * Params : plannerId
 * =====================================================
 */
router.get("/:id", auth, async (req, res) => {
  try {

    const { id } = req.params;
    const connection = getMySQLConnection();

    console.log("============== DEBUG START ==============");
    console.log("User Type:", req.user.user_type);
    console.log("User Email:", req.user.email);

    const communityId = await resolveCommunityId(connection, req.user.id);

    const [rows] = await connection.execute(
      `SELECT * FROM planners WHERE id=? AND community_id=?`,
      [id, communityId]
    );

    if (!rows.length) {
      return errorResponse(res, "Planner not found", 404);
    }

    let planner = rows[0];

    planner.template_data = planner.template_data
      ? parseJsonSafe(planner.template_data, { sections: [], notes: [], files: [] })
      : { sections: [], notes: [], files: [] };

    planner.service_times = planner.service_times
      ? parseJsonSafe(planner.service_times, {})
      : {};

    /* ==========================================
       🔥 FIXED USER FILTER (SUB_USER + MANAGER)
    ========================================== */

    if (
      req.user.user_type === "sub_user" ||
      req.user.user_type === "manager"
    ) {

      console.log("🔒 FILTER ENABLED");

      const email = (req.user.email || "").toLowerCase();
      const entities = planner.service_times?.mass_entities || [];

      console.log("Total entities:", entities.length);

      /* ================= STEP 1: MATCH ================= */

      const matchedEntities = entities.filter(entity => {

        const items = entity.selectedItems || [];

        return items.some(
          m =>
            m.type === "minister" &&
            (m.email || "").toLowerCase() === email
        );

      });

      console.log("Matched entities:", matchedEntities.length);

      // ✅ fallback (IMPORTANT FIX)
      if (matchedEntities.length) {
        planner.service_times.mass_entities = matchedEntities;
      }

      /* ================= STEP 2: TIMES ================= */

      const allowedTimes = new Set();

      (matchedEntities.length ? matchedEntities : entities).forEach(e => {

        if (!e.hour || !e.minute || !e.ampm) return;

        const hour = e.hour.padStart(2, "0");
        const minute = e.minute.padStart(2, "0");
        const ampm = e.ampm;

        allowedTimes.add(`${hour}:${minute} ${ampm}`);

      });

      console.log("Allowed Times:", Array.from(allowedTimes));

      /* ================= STEP 3: HEADERS ================= */

      const sections = planner.template_data.sections;
      const allowedHeaderIds = new Set();

      sections.forEach(section => {
        if (
          section.type === "header" &&
          allowedTimes.has(section.time)
        ) {
          allowedHeaderIds.add(section.id);
        }
      });

      console.log("Allowed Header IDs:", Array.from(allowedHeaderIds));

      /* ================= STEP 4: FILTER ================= */

      planner.template_data.sections = sections.filter(section => {

        if (
          section.type === "header" &&
          allowedHeaderIds.has(section.id)
        ) return true;

        if (
          section.headerId &&
          allowedHeaderIds.has(section.headerId)
        ) return true;

        return false;

      });

      console.log("Final Sections:", planner.template_data.sections.length);

    }

    console.log("============== DEBUG END ==============");

    return successResponse(res, planner, "Planner fetched successfully");

  } catch (err) {

    console.error("Planner error:", err);
    return errorResponse(res, "Server error", 500);

  }
});

/**
 * =====================================================
 * POST /api/planners
 * Create new planner (Mass + Liturgical Supported)
 * Supports both payload formats
 * =====================================================
 */
router.post("/", auth, async (req, res) => {
  try {

    const {
      service_date,
      service_type,
      service_title,
      service_subtitle,
      template_id,
      status,
      service_times,
      mass_template
    } = req.body;

    if (!service_date || !service_title) {
      return errorResponse(res, "service_date and service_title required", 400);
    }

    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    /* =====================================================
       NORMALIZE SERVICE TIMES (SUPPORT BOTH PAYLOADS)
    ===================================================== */

    let normalizedServiceTimes = service_times || {};

    // Normalize entity key
    const entities =
      service_times?.mass_entities ||
      service_times?.MassEntity ||
      [];

    normalizedServiceTimes = {
      ...service_times,
      mass_name: service_times?.mass_name || service_times?.MassName || null,
      mass_day: service_times?.mass_day || service_times?.MassDay || null,
      mass_entities: entities
    };

    /* =====================================================
       TEMPLATE DATA
    ===================================================== */

    const parsedTemplate = mass_template?.mass_template_data || null;

    /* =====================================================
       COMBINE VIGIL / NORMAL
    ===================================================== */

    const allEntities = entities;

    /* =====================================================
       TEMPLATE BUILDER
    ===================================================== */

    const buildTemplate = (entitiesList, liturgicalEvent) => {

      if (!parsedTemplate || !Array.isArray(parsedTemplate.sections)) {
        return null;
      }

      const sections = [];

      const now = Date.now();
      let counter = 0;

      const generateId = () => now + counter++;

      const readingMap = {
        "First Reading": liturgicalEvent?.first_reading || "",
        "Responsorial Psalm": liturgicalEvent?.responsorial_psalm || "",
        "Second Reading": liturgicalEvent?.second_reading || "",
        "Gospel Acclamation": liturgicalEvent?.gospel_acclamation || "",
        "Gospel Reading": liturgicalEvent?.gospel || ""
      };

      for (const entity of entitiesList) {

        const time = `${entity.time || ""} ${entity.ampm || ""}`.trim();

        const headerMap = {};

        for (const item of parsedTemplate.sections) {

          /* ================= HEADER ================= */

          if (item.type === "header") {

            const newHeaderId = `header-${generateId()}`;

            headerMap[item.id] = newHeaderId;

            sections.push({
              id: newHeaderId,
              type: "header",
              title: item.title,
              description: item.description || "",
              isTemplateHeader: true,
              time
            });

            continue;
          }

          /* ================= CUSTOM TEXT ================= */

          if (item.type === "customtext") {

            const newHeaderId = headerMap[item.headerId];

            const content =
              readingMap[item.title] !== undefined
                ? readingMap[item.title]
                : "";

            sections.push({
              id: generateId(),
              type: "customtext",
              title: item.title,
              description: item.description || "",
              header: item.header || "",
              headerId: newHeaderId,
              content,
              minister: item.minister || null,
              reading: readingMap[item.title] || ""
            });

          }

        }

      }

      return {
        sections,
        notes: [],
        files: [],
        liturgicalMeta: liturgicalEvent || null
      };

    };

    /* =====================================================
       DATE HANDLING
    ===================================================== */

    const baseDate = new Date(service_date);
    const planners = [];

    /* =====================================================
       CREATE PLANNER
    ===================================================== */

    const createPlanner = async (date, entitiesList) => {
      if (!entitiesList || !entitiesList.length) return;

      const formattedDate = date.toISOString().split("T")[0];

      /* ================= FETCH LITURGICAL EVENT ================= */

      const [events] = await connection.execute(
        `SELECT * FROM liturgical_events WHERE calendar_date = ? LIMIT 1`,
        [formattedDate]
      );

      const liturgicalEvent = events.length ? events[0] : null;

      /* ================= BUILD TEMPLATE ================= */

      const templateData = buildTemplate(entitiesList, liturgicalEvent);

      const hasVigilEntities = entitiesList.some(e => e.vigil === true);
      const newServiceTimes = {
        ...normalizedServiceTimes,
        mass_entities: entitiesList
      };

      const [result] = await connection.execute(
        `
        INSERT INTO planners
        (
          user_id,
          community_id,
          service_date,
          service_type,
          service_title,
          service_subtitle,
          template_id,
          status,
          template_data,
          service_times,
          vigil
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          req.user.id,
          communityId,
          formattedDate,
          service_type || "General Service",
          service_title,
          service_subtitle || null,
          template_id || null,
          status || "upcoming",
          templateData ? JSON.stringify(templateData) : null,
          JSON.stringify(newServiceTimes),
          hasVigilEntities ? 1 : 0
        ]
      );

      const plannerId = result.insertId;

      const [[planner]] = await connection.execute(
        `SELECT * FROM planners WHERE id = ?`,
        [plannerId]
      );

      planner.template_data = planner.template_data
        ? JSON.parse(planner.template_data)
        : null;

      planner.service_times = planner.service_times
        ? JSON.parse(planner.service_times)
        : null;

      planners.push(planner);

    };

    /* =====================================================
       CREATE COMBINED SERVICE
    ===================================================== */

    await createPlanner(baseDate, allEntities);

    /* =====================================================
       RESPONSE
    ===================================================== */

    return successResponse(
      res,
      planners,
      "Planner created successfully",
      201
    );

  } catch (err) {

    console.error("Planner create error:", err);

    return errorResponse(res, "Error creating planner", 500);

  }
});

/**
 * =====================================================
 * PUT /api/planners/:id
 * Update Planner (Mass + Liturgical Supported)
 * =====================================================
 */
router.put('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;

    const {
      service_date,
      service_type,
      service_title,
      service_subtitle,
      template_id,
      status,
      service_times,
      template_data
    } = req.body;

    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    /* ================= CHECK EXIST ================= */

    const [[existingPlanner]] = await connection.execute(
      `SELECT * FROM planners WHERE id = ? AND community_id = ?`,
      [id, communityId]
    );

    if (!existingPlanner) {
      return errorResponse(res, 'Planner not found', 404);
    }

    /* ================= SAFE PARSE ================= */

    let parsedTemplateData = template_data;
    if (typeof template_data === 'string') {
      try { parsedTemplateData = JSON.parse(template_data); }
      catch { parsedTemplateData = null; }
    }

    let parsedServiceTimes = service_times;
    if (typeof service_times === 'string') {
      try { parsedServiceTimes = JSON.parse(service_times); }
      catch { parsedServiceTimes = null; }
    }

    /* ================= TEMPLATE GENERATION ================= */

    let templateDataToApply = null;

    const now = Date.now();
    let counter = 0;
    const generateId = () => now + counter++;

    if (
      parsedTemplateData &&
      parsedTemplateData.event_title &&
      parsedServiceTimes &&
      parsedServiceTimes.mass_entities &&
      Array.isArray(parsedServiceTimes.mass_entities)
    ) {

      const sections = [];
      let headerTitle = 'Litrugical Template';

      parsedServiceTimes.mass_entities.forEach((entity) => {

        const headerId = `header-${generateId()}`;
        const formattedTime = `${entity.time || ''} ${entity.ampm || ''}`.trim();

        sections.push({
          id: headerId,
          type: 'header',
          title: headerTitle,
          description: '',
          isTemplateHeader: true,
          time: formattedTime
        });

        const pushReading = (key, title, descKey) => {
          if (parsedTemplateData[key]) {
            sections.push({
              id: generateId(),
              type: 'customtext',
              title,
              description: parsedTemplateData[descKey] || '',
              header: headerTitle,
              headerId: headerId,
              content: '',
              minister: null,
              reading: parsedTemplateData[key]
            });
          }
        };

        pushReading('first_reading', 'First Reading', 'first_reading_description');
        pushReading('responsorial_psalm', 'Responsorial Psalm', 'responsorial_psalm_refrain');
        pushReading('second_reading', 'Second Reading', 'second_reading_description');
        pushReading('gospel', 'Gospel', 'gospel_description');

      });

      templateDataToApply = {
        sections,
        notes: [],
        files: [],
        liturgicalMeta: parsedTemplateData
      };
    }

    /* ================= UPDATE QUERY ================= */

    const updates = [];
    const values = [];

    if (service_date !== undefined) {
      updates.push('service_date = ?');
      values.push(service_date);
    }

    if (service_type !== undefined) {
      const finalServiceType =
        typeof service_type === 'string' && service_type.trim() !== ''
          ? service_type.trim()
          : 'General Service';

      updates.push('service_type = ?');
      values.push(finalServiceType);
    }

    if (service_title !== undefined) {
      updates.push('service_title = ?');
      values.push(service_title);
    }

    if (service_subtitle !== undefined) {
      updates.push('service_subtitle = ?');
      values.push(service_subtitle);
    }

    if (template_id !== undefined) {
      updates.push('template_id = ?');
      values.push(template_id);
    }

    if (status !== undefined) {
      updates.push('status = ?');
      values.push(status);
    }

    if (parsedServiceTimes !== undefined) {
      updates.push('service_times = ?');
      values.push(
        parsedServiceTimes ? JSON.stringify(parsedServiceTimes) : null
      );
    }

    if (templateDataToApply !== null) {
      updates.push('template_data = ?');
      values.push(JSON.stringify(templateDataToApply));
    }

    if (updates.length > 0) {
      values.push(id);

      await connection.execute(
        `UPDATE planners SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`,
        values
      );
    }

    /* ================= FETCH UPDATED ================= */

    const [[updatedPlanner]] = await connection.execute(
      `SELECT * FROM planners WHERE id = ?`,
      [id]
    );

    updatedPlanner.template_data = updatedPlanner.template_data
      ? JSON.parse(updatedPlanner.template_data)
      : null;

    updatedPlanner.service_times = updatedPlanner.service_times
      ? JSON.parse(updatedPlanner.service_times)
      : null;

    return successResponse(res, updatedPlanner, 'Planner updated successfully');

  } catch (err) {
    console.error('❌ Error updating planner:', err);
    return errorResponse(res, 'Error updating planner', 500);
  }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    const [existing] = await connection.execute(
      'SELECT id FROM planners WHERE id = ? AND community_id = ?',
      [id, communityId]
    );

    if (existing.length === 0) {
      return errorResponse(res, 'Planner not found', 404);
    }

    await connection.execute('DELETE FROM planners WHERE id = ?', [id]);

    return successResponse(res, { id: parseInt(id) }, 'Planner deleted successfully');
  } catch (err) {
    console.error('Error deleting planner:', err);
    return errorResponse(res, 'Error deleting planner', 500);
  }
});

/**
 * =====================================================
 * DELETE /api/planners/:id
 * Delete planner
 * =====================================================
 * POST /api/planners/:plannerId/apply-template
 * Apply planner template to planner
 * =====================================================
 * Access : Private
 * =====================================================
 */
router.post('/:plannerId/apply-template', auth, async (req, res) => {
  try {
    const { plannerId } = req.params;
    const { template_id } = req.body;

    if (!template_id) return errorResponse(res, 'template_id is required', 400);

    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    const [planners] = await connection.execute(
      'SELECT * FROM planners WHERE id = ? AND community_id = ?',
      [plannerId, communityId]
    );

    if (!planners.length) return errorResponse(res, 'Planner not found', 404);

    const [templates] = await connection.execute(
      'SELECT id FROM planner_templates WHERE id = ? AND created_by = ?',
      [template_id, communityId]
    );

    if (!templates.length) return errorResponse(res, 'Template not found', 404);

    await connection.execute(
      'UPDATE planners SET template_id = ?, updated_at = NOW() WHERE id = ? AND community_id = ?',
      [template_id, plannerId, communityId]
    );

    return successResponse(
      res,
      { plannerId: Number(plannerId), template_id: Number(template_id) },
      'Template applied successfully'
    );
  } catch (err) {
    console.error('Error applying template:', err);
    return errorResponse(res, 'Error applying template', 500);
  }
});


/**
 * =====================================================
 * GET /api/planners/:serviceId/template-data
 * Replace template data (sections, notes, files, ministers)
 * =====================================================
 * Access : Private
 * Type   : multipart/form-data
 * =====================================================
 */
router.get('/:serviceId/template-data', auth, async (req, res) => {
  try {
    const { serviceId } = req.params;

    if (!serviceId) {
      return errorResponse(res, 'serviceId is required', 400);
    }

    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    const [[planner]] = await connection.execute(
      `SELECT id, template_data
       FROM planners
       WHERE id = ? AND community_id = ?`,
      [serviceId, communityId]
    );

    if (!planner) {
      return errorResponse(res, 'Service not found', 404);
    }

    /* =====================================================
       PARSE TEMPLATE DATA
    ===================================================== */
    const templateData = parseJsonSafe(planner.template_data, {
      sections: [],
      notes: [],
      files: []
    });

    const sections = Array.isArray(templateData.sections)
      ? templateData.sections
      : [];

    /* =====================================================
       COLLECT MINISTER IDS (ONLY OLD FORMAT)
    ===================================================== */
    const ministerIds = new Set();

    sections.forEach(section => {
      if (
        section.type === 'music' &&
        Array.isArray(section.minister_ids) &&
        !section.ministers &&
        !section.minister
      ) {
        section.minister_ids.forEach(id =>
          ministerIds.add(Number(id))
        );
      }
    });

    /* =====================================================
       FETCH MINISTERS (ONLY IF REQUIRED)
    ===================================================== */
    let ministersMap = {};

    if (ministerIds.size > 0) {
      const idsArray = [...ministerIds];

      const [ministers] = await connection.execute(
        `SELECT *
         FROM planner_ministers
         WHERE id IN (${idsArray.map(() => '?').join(',')})
           AND parent_user_id = ?
           AND deleted_at IS NULL`,
        [...idsArray, communityId]
      );

      ministers.forEach(m => {
        ministersMap[m.id] = {
          id: m.id,
          person_name: m.person_name,
          email: m.email,
          phone: m.phone,
          gender: m.gender,
          marital_status: m.marital_status,
          user_type: m.user_type,
          status: m.status,
          instruments: parseJsonSafe(m.instruments, []),
          vocal_parts: parseJsonSafe(m.vocal_parts, [])
        };
      });
    }

    /* =====================================================
       NORMALIZE SECTIONS (DUAL FORMAT SAFE)
    ===================================================== */
    const normalizedSections = sections.map(section => {
      const base = { ...section };

      // 🎵 MUSIC SECTION
      if (section.type === 'music') {
        /* ---------- NEW FORMAT ---------- */
        if (section.minister) {
          delete base.minister_ids;
          return base;
        }

        /* ---------- ALREADY NORMALIZED ---------- */
        if (Array.isArray(section.ministers)) {
          delete base.minister_ids;
          return base;
        }

        /* ---------- OLD FORMAT ---------- */
        if (Array.isArray(section.minister_ids)) {
          base.ministers = section.minister_ids
            .map(id => ministersMap[id])
            .filter(Boolean);

          delete base.minister_ids;
          return base;
        }
      }

      // 🧱 NON-MUSIC SECTIONS
      delete base.minister_ids;
      return base;
    });

    /* =====================================================
       FINAL RESPONSE
    ===================================================== */
    return successResponse(
      res,
      {
        ...templateData,
        sections: normalizedSections
      },
      'Template data fetched successfully'
    );
  } catch (err) {
    console.error('❌ Error fetching template data:', err);
    return errorResponse(
      res,
      'Error fetching service template data',
      500
    );
  }
});


/**
 * =====================================================
 * POST /api/planners/:serviceId/template-data
 * Replace template data (sections, notes, files, ministers)
 * =====================================================
 * Access : Private
 * Type   : multipart/form-data
 * =====================================================
 */
router.post(
  '/:serviceId/template-data',
  auth,
  uploadAnyFile.any(),
  async (req, res) => {
    try {
      const { serviceId } = req.params;
      const { notes, sections, file_descriptions, existing_files } = req.body;

      if (!serviceId) {
        return errorResponse(res, 'serviceId is required', 400);
      }

      const connection = getMySQLConnection();
      const communityId = await resolveCommunityId(connection, req.user.id);

      const [[planner]] = await connection.execute(
        `SELECT id FROM planners WHERE id = ? AND community_id = ?`,
        [serviceId, communityId]
      );

      if (!planner) {
        return errorResponse(res, 'Service not found', 404);
      }

      /* =====================================================
         HELPERS
      ===================================================== */
      const now = Date.now();
      let counter = 0;
      const genId = () => now + counter++;

      /* =====================================================
         PARSE NOTES
      ===================================================== */
      let parsedNotes = [];
      if (notes) {
        try {
          parsedNotes = typeof notes === 'string' ? JSON.parse(notes) : notes;
        } catch {
          return errorResponse(res, 'Invalid notes JSON format', 400);
        }
      }

      const normalizedNotes = Array.isArray(parsedNotes)
        ? parsedNotes.map(n => ({
          id: n.id || genId(),
          title: n.title || '',
          content: n.content || '',
          createdAt: n.createdAt || new Date().toISOString(),
          createdBy: n.createdBy || req.user.id
        }))
        : [];

      /* =====================================================
         PARSE SECTIONS (OLD + NEW)
      ===================================================== */
      let parsedSections = [];
      if (sections) {
        try {
          parsedSections =
            typeof sections === 'string' ? JSON.parse(sections) : sections;
        } catch {
          return errorResponse(res, 'Invalid sections JSON format', 400);
        }
      }

      /* =====================================================
         COLLECT MINISTER IDS (ONLY OLD FORMAT)
      ===================================================== */
      const ministerIds = new Set();

      Array.isArray(parsedSections) &&
        parsedSections.forEach(section => {
          if (
            Array.isArray(section.minister_ids) &&
            !section.minister // old format only
          ) {
            section.minister_ids.forEach(id =>
              ministerIds.add(Number(id))
            );
          }
        });

      /* =====================================================
         FETCH MINISTERS (ONLY IF NEEDED)
      ===================================================== */
      let ministersMap = {};

      if (ministerIds.size > 0) {
        const idsArray = [...ministerIds];

        const [ministers] = await connection.execute(
          `SELECT *
           FROM planner_ministers
           WHERE id IN (${idsArray.map(() => '?').join(',')})
             AND parent_user_id = ?
             AND deleted_at IS NULL`,
          [...idsArray, communityId]
        );

        ministers.forEach(m => {
          ministersMap[m.id] = {
            id: m.id,
            person_name: m.person_name,
            email: m.email,
            phone: m.phone,
            gender: m.gender,
            marital_status: m.marital_status,
            user_type: m.user_type,
            status: m.status,
            instruments: parseJsonSafe(m.instruments, []),
            vocal_parts: parseJsonSafe(m.vocal_parts, [])
          };
        });
      }

      /* =====================================================
         NORMALIZE SECTIONS (DUAL FORMAT)
      ===================================================== */
      const normalizedSections = Array.isArray(parsedSections)
        ? parsedSections.map(section => {

          const base = {
            ...section,
            id: section.id || genId()
          };

          /* ---------- HEADER SECTION ---------- */
          if (section.type === 'header') {
            return {
              ...base,
              time: section.time || null // ✅ NEW FIELD ADDED
            };
          }

          /* ---------- OLD FORMAT (minister_ids) ---------- */
          if (Array.isArray(section.minister_ids)) {
            base.ministers = section.minister_ids
              .map(id => ministersMap[id])
              .filter(Boolean);

            delete base.minister_ids;
            return base;
          }

          /* ---------- NEW FORMAT (minister object present) ---------- */
          if (section.minister) {
            return base;
          }

          /* ---------- NO MINISTER ---------- */
          delete base.minister_ids;
          return base;
        })
        : [];

      /* =====================================================
         PARSE FILE DESCRIPTIONS
      ===================================================== */
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

      /* =====================================================
         PARSE EXISTING FILES
      ===================================================== */
      let parsedExistingFiles = [];
      if (existing_files) {
        try {
          parsedExistingFiles =
            typeof existing_files === 'string'
              ? JSON.parse(existing_files)
              : existing_files;
        } catch {
          return errorResponse(res, 'Invalid existing_files JSON format', 400);
        }
      }

      const normalizedExistingFiles = Array.isArray(parsedExistingFiles)
        ? parsedExistingFiles.map(file => ({
          id: file.id || file._id,
          filename: file.filename,
          original_name: file.original_name || file.filename,
          description: file.description || null,
          url: file.url || file.fileUrl,
          size: file.size,
          type: file.type,
          uploaded_by: file.uploaded_by,
          createdAt: file.createdAt
        }))
        : [];

      /* =====================================================
         UPLOADED FILES
      ===================================================== */
      const uploadedFiles = Array.isArray(req.files)
        ? req.files.map((file, index) => ({
          id: genId(),
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

      /* =====================================================
         FINAL TEMPLATE DATA
      ===================================================== */
      const updatedTemplateData = {
        sections: normalizedSections,
        notes: normalizedNotes,
        files: [...normalizedExistingFiles, ...uploadedFiles]
      };

      await connection.execute(
        `UPDATE planners
         SET template_data = ?
         WHERE id = ? AND community_id = ?`,
        [JSON.stringify(updatedTemplateData), serviceId, communityId]
      );

      const [[updatedPlanner]] = await connection.execute(
        `SELECT * FROM planners WHERE id = ?`,
        [serviceId]
      );

      updatedPlanner.template_data = parseJsonSafe(
        updatedPlanner.template_data,
        updatedTemplateData
      );

      return successResponse(
        res,
        updatedPlanner,
        'Template data updated successfully'
      );
    } catch (err) {
      console.error('❌ Template update error:', err);
      return errorResponse(res, 'Error updating template data', 500);
    }
  }
);

/**
 * =====================================================
 * POST /api/planners/:plannerId/custom-settings
 * Add / Replace custom settings (customMass, customReading)
 * =====================================================
 * Access : Private
 * Type   : application/json
 * =====================================================
 */
router.post('/:plannerId/custom-settings', auth, async (req, res) => {
  try {
    const { plannerId } = req.params;
    const { customMass, customReading } = req.body;

    if (!plannerId) {
      return errorResponse(res, 'plannerId is required', 400);
    }

    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    // ✅ Check planner belongs to community
    const [[planner]] = await connection.execute(
      `SELECT id FROM planners WHERE id = ? AND community_id = ?`,
      [plannerId, communityId]
    );

    if (!planner) {
      return errorResponse(res, 'Planner not found', 404);
    }

    // ✅ Normalize format
    const updatedCustomSettings = {
      customMass: Array.isArray(customMass) ? customMass : [],
      customReading: Array.isArray(customReading) ? customReading : []
    };

    // ✅ Update DB
    await connection.execute(
      `UPDATE planners
       SET custom_settings = ?, updated_at = NOW()
       WHERE id = ? AND community_id = ?`,
      [JSON.stringify(updatedCustomSettings), plannerId, communityId]
    );

    const [[updatedPlanner]] = await connection.execute(
      `SELECT id, custom_settings FROM planners WHERE id = ?`,
      [plannerId]
    );

    updatedPlanner.custom_settings = parseJsonSafe(
      updatedPlanner.custom_settings,
      updatedCustomSettings
    );

    return successResponse(
      res,
      updatedPlanner,
      'Custom settings updated successfully'
    );

  } catch (err) {
    console.error('❌ Custom settings update error:', err);
    return errorResponse(res, 'Error updating custom settings', 500);
  }
});


/**
 * =====================================================
 * GET /api/planners/:plannerId/custom-settings
 * Get custom settings
 * =====================================================
 * Access : Private
 * =====================================================
 */
router.get('/:plannerId/custom-settings', auth, async (req, res) => {
  try {
    const { plannerId } = req.params;

    if (!plannerId) {
      return errorResponse(res, 'plannerId is required', 400);
    }

    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    const [[planner]] = await connection.execute(
      `SELECT id, custom_settings
       FROM planners
       WHERE id = ? AND community_id = ?`,
      [plannerId, communityId]
    );

    if (!planner) {
      return errorResponse(res, 'Planner not found', 404);
    }

    const parsedSettings = parseJsonSafe(planner.custom_settings, {
      customMass: [],
      customReading: []
    });

    return successResponse(
      res,
      {
        plannerId: planner.id,
        customSettings: parsedSettings
      },
      'Custom settings retrieved successfully'
    );

  } catch (err) {
    console.error('❌ Custom settings fetch error:', err);
    return errorResponse(res, 'Error fetching custom settings', 500);
  }
});

router.put('/:serviceId/template-data', auth, async (req, res) => {
  try {
    const { serviceId } = req.params;
    const { type, id, data } = req.body;

    if (!serviceId) return errorResponse(res, 'serviceId is required', 400);
    if (!type) return errorResponse(res, 'type is required', 400);
    if (id === undefined || id === null || id === '') return errorResponse(res, 'id is required', 400);

    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    const [[planner]] = await connection.execute(
      `SELECT id, template_data
       FROM planners
       WHERE id = ? AND community_id = ?`,
      [serviceId, communityId]
    );

    if (!planner) return errorResponse(res, 'Service not found', 404);

    const templateData = parseJsonSafe(planner.template_data, { sections: [], notes: [], files: [], music: [] });
    const typeNormalized = String(type).toLowerCase();
    const targetId = Number(id);

    if (Number.isNaN(targetId)) return errorResponse(res, 'id must be a number', 400);

    if (typeNormalized === 'note' || typeNormalized === 'notes') {
      const notes = Array.isArray(templateData.notes) ? templateData.notes : [];
      const idx = notes.findIndex((n) => Number(n.id) === targetId);
      if (idx === -1) return errorResponse(res, 'Note not found', 404);

      const current = notes[idx];
      const payload = data && typeof data === 'object' ? data : req.body;
      const updated = {
        ...current,
        title: payload.title !== undefined ? payload.title : current.title,
        content: payload.content !== undefined ? payload.content : current.content,
        updatedAt: new Date().toISOString(),
        updatedBy: req.user.id
      };
      notes[idx] = updated;
      templateData.notes = notes;

      await connection.execute(
        'UPDATE planners SET template_data = ? WHERE id = ? AND community_id = ?',
        [JSON.stringify(templateData), serviceId, communityId]
      );

      return successResponse(res, updated, 'Note updated successfully');
    }

    if (typeNormalized === 'section' || typeNormalized === 'sections') {
      const sections = Array.isArray(templateData.sections) ? templateData.sections : [];
      const idx = sections.findIndex((s) => Number(s.id) === targetId);
      if (idx === -1) return errorResponse(res, 'Section not found', 404);

      const current = sections[idx];
      const payload = data && typeof data === 'object' ? data : req.body;
      const updated = {
        ...current,
        title: payload.title !== undefined ? payload.title : current.title,
        description: payload.description !== undefined ? (payload.description || '') : current.description,
        items: payload.items !== undefined ? (Array.isArray(payload.items) ? payload.items : []) : current.items,
        updatedAt: new Date().toISOString(),
        updatedBy: req.user.id
      };
      sections[idx] = updated;
      templateData.sections = sections;

      await connection.execute(
        'UPDATE planners SET template_data = ? WHERE id = ? AND community_id = ?',
        [JSON.stringify(templateData), serviceId, communityId]
      );

      return successResponse(res, updated, 'Section updated successfully');
    }

    if (typeNormalized === 'file' || typeNormalized === 'files') {
      const files = Array.isArray(templateData.files) ? templateData.files : [];
      const idx = files.findIndex((f) => Number(f.id) === targetId);
      if (idx === -1) return errorResponse(res, 'File not found', 404);

      const current = files[idx];
      const payload = data && typeof data === 'object' ? data : req.body;
      const updated = {
        ...current,
        description: payload.description !== undefined ? payload.description : current.description,
        updatedAt: new Date().toISOString(),
        updatedBy: req.user.id
      };
      files[idx] = updated;
      templateData.files = files;

      await connection.execute(
        'UPDATE planners SET template_data = ? WHERE id = ? AND community_id = ?',
        [JSON.stringify(templateData), serviceId, communityId]
      );

      return successResponse(res, updated, 'File updated successfully');
    }

    return errorResponse(res, 'Invalid type. Use note/section/file', 400);
  } catch (err) {
    console.error('Error updating service template-data:', err);
    return errorResponse(res, 'Error updating service template-data', 500);
  }
});

router.delete('/:serviceId/template-data', auth, async (req, res) => {
  try {
    const { serviceId } = req.params;
    const type = req.query.type || req.body.type;
    const id = req.query.id || req.body.id;

    if (!serviceId) return errorResponse(res, 'serviceId is required', 400);
    if (!type) return errorResponse(res, 'type is required', 400);
    if (id === undefined || id === null || id === '') return errorResponse(res, 'id is required', 400);

    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    const [[planner]] = await connection.execute(
      `SELECT id, template_data
       FROM planners
       WHERE id = ? AND community_id = ?`,
      [serviceId, communityId]
    );

    if (!planner) return errorResponse(res, 'Service not found', 404);

    const templateData = parseJsonSafe(planner.template_data, { sections: [], notes: [], files: [], music: [] });
    const typeNormalized = String(type).toLowerCase();
    const targetId = Number(id);

    if (Number.isNaN(targetId)) return errorResponse(res, 'id must be a number', 400);

    if (typeNormalized === 'note' || typeNormalized === 'notes') {
      const notes = Array.isArray(templateData.notes) ? templateData.notes : [];
      const filtered = notes.filter((n) => Number(n.id) !== targetId);
      if (filtered.length === notes.length) return errorResponse(res, 'Note not found', 404);
      templateData.notes = filtered;

      await connection.execute(
        'UPDATE planners SET template_data = ? WHERE id = ? AND community_id = ?',
        [JSON.stringify(templateData), serviceId, communityId]
      );

      return successResponse(res, { id: targetId }, 'Note deleted successfully');
    }

    if (typeNormalized === 'section' || typeNormalized === 'sections') {
      const sections = Array.isArray(templateData.sections) ? templateData.sections : [];
      const filtered = sections.filter((s) => Number(s.id) !== targetId);
      if (filtered.length === sections.length) return errorResponse(res, 'Section not found', 404);
      templateData.sections = filtered;

      await connection.execute(
        'UPDATE planners SET template_data = ? WHERE id = ? AND community_id = ?',
        [JSON.stringify(templateData), serviceId, communityId]
      );

      return successResponse(res, { id: targetId }, 'Section deleted successfully');
    }

    if (typeNormalized === 'file' || typeNormalized === 'files') {
      const files = Array.isArray(templateData.files) ? templateData.files : [];
      const filtered = files.filter((f) => Number(f.id) !== targetId);
      if (filtered.length === files.length) return errorResponse(res, 'File not found', 404);
      templateData.files = filtered;

      await connection.execute(
        'UPDATE planners SET template_data = ? WHERE id = ? AND community_id = ?',
        [JSON.stringify(templateData), serviceId, communityId]
      );

      return successResponse(res, { id: targetId }, 'File deleted successfully');
    }

    return errorResponse(res, 'Invalid type. Use note/section/file', 400);
  } catch (err) {
    console.error('Error deleting service template-data:', err);
    return errorResponse(res, 'Error deleting service template-data', 500);
  }
});

/**
 * =====================================================
 * PUT /api/planners/:serviceId/template-data/notes/:noteId
 * Update note in service template data
 * =====================================================
 * Access : Private
 * =====================================================
 */
router.put('/:serviceId/template-data/notes/:noteId', auth, async (req, res) => {
  try {
    const { serviceId, noteId } = req.params;
    const { title, content } = req.body;

    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    const [[planner]] = await connection.execute(
      `SELECT id, template_data
       FROM planners
       WHERE id = ? AND community_id = ?`,
      [serviceId, communityId]
    );

    if (!planner) return errorResponse(res, 'Service not found', 404);

    const data = parseJsonSafe(planner.template_data, { sections: [], notes: [], files: [], music: [] });
    const notes = Array.isArray(data.notes) ? data.notes : [];

    const nidNum = Number(noteId);
    const idx = notes.findIndex((n) => Number(n.id) === nidNum);
    if (idx === -1) return errorResponse(res, 'Note not found', 404);

    const current = notes[idx];
    const updated = {
      ...current,
      title: title !== undefined ? title : current.title,
      content: content !== undefined ? content : current.content,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user.id
    };

    notes[idx] = updated;
    data.notes = notes;

    await connection.execute(
      'UPDATE planners SET template_data = ? WHERE id = ? AND community_id = ?',
      [JSON.stringify(data), serviceId, communityId]
    );

    return successResponse(res, updated, 'Note updated successfully');
  } catch (err) {
    console.error('Error updating service note:', err);
    return errorResponse(res, 'Error updating service note', 500);
  }
});

/**
 * =====================================================
 * DELETE /api/planners/:serviceId/template-data/notes/:noteId
 * Delete note in service template data
 * =====================================================
 * Access : Private
 * =====================================================
 */
router.delete('/:serviceId/template-data/notes/:noteId', auth, async (req, res) => {
  try {
    const { serviceId, noteId } = req.params;

    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    const [[planner]] = await connection.execute(
      `SELECT id, template_data
       FROM planners
       WHERE id = ? AND community_id = ?`,
      [serviceId, communityId]
    );

    if (!planner) return errorResponse(res, 'Service not found', 404);

    const data = parseJsonSafe(planner.template_data, { sections: [], notes: [], files: [], music: [] });
    const notes = Array.isArray(data.notes) ? data.notes : [];

    const nidNum = Number(noteId);
    const filtered = notes.filter((n) => Number(n.id) !== nidNum);
    if (filtered.length === notes.length) {
      return errorResponse(res, 'Note not found', 404);
    }

    data.notes = filtered;

    await connection.execute(
      'UPDATE planners SET template_data = ? WHERE id = ? AND community_id = ?',
      [JSON.stringify(data), serviceId, communityId]
    );

    return successResponse(res, { id: nidNum }, 'Note deleted successfully');
  } catch (err) {
    console.error('Error deleting service note:', err);
    return errorResponse(res, 'Error deleting service note', 500);
  }
});

/**
 * =====================================================
 * PUT /api/planners/:serviceId/template-data/sections/:sectionId
 * Update section in service template data
 * =====================================================
 * Access : Private
 * =====================================================
 */
router.put('/:serviceId/template-data/sections/:sectionId', auth, async (req, res) => {
  try {
    const { serviceId, sectionId } = req.params;
    const { title, description, items } = req.body;

    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    const [[planner]] = await connection.execute(
      `SELECT id, template_data
       FROM planners
       WHERE id = ? AND community_id = ?`,
      [serviceId, communityId]
    );

    if (!planner) return errorResponse(res, 'Service not found', 404);

    const data = parseJsonSafe(planner.template_data, { sections: [], notes: [], files: [], music: [] });
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
      updatedAt: new Date().toISOString(),
      updatedBy: req.user.id
    };

    sections[idx] = updated;
    data.sections = sections;

    await connection.execute(
      'UPDATE planners SET template_data = ? WHERE id = ? AND community_id = ?',
      [JSON.stringify(data), serviceId, communityId]
    );

    return successResponse(res, updated, 'Section updated successfully');
  } catch (err) {
    console.error('Error updating service section:', err);
    return errorResponse(res, 'Error updating service section', 500);
  }
});

/**
 * =====================================================
 * DELETE /api/planners/:serviceId/template-data/sections/:sectionId
 * Delete section in service template data
 * =====================================================
 * Access : Private
 * =====================================================
 */
router.delete('/:serviceId/template-data/sections/:sectionId', auth, async (req, res) => {
  try {
    const { serviceId, sectionId } = req.params;

    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    const [[planner]] = await connection.execute(
      `SELECT id, template_data
       FROM planners
       WHERE id = ? AND community_id = ?`,
      [serviceId, communityId]
    );

    if (!planner) return errorResponse(res, 'Service not found', 404);

    const data = parseJsonSafe(planner.template_data, { sections: [], notes: [], files: [], music: [] });
    const sections = Array.isArray(data.sections) ? data.sections : [];

    const sidNum = Number(sectionId);
    const filtered = sections.filter((s) => Number(s.id) !== sidNum);
    if (filtered.length === sections.length) {
      return errorResponse(res, 'Section not found', 404);
    }

    data.sections = filtered;

    await connection.execute(
      'UPDATE planners SET template_data = ? WHERE id = ? AND community_id = ?',
      [JSON.stringify(data), serviceId, communityId]
    );

    return successResponse(res, { id: sidNum }, 'Section deleted successfully');
  } catch (err) {
    console.error('Error deleting service section:', err);
    return errorResponse(res, 'Error deleting service section', 500);
  }
});

/**
 * =====================================================
 * PUT /api/planners/:serviceId/template-data/files/:fileId
 * Update file meta (description) in service template data
 * =====================================================
 * Access : Private
 * =====================================================
 */
router.put('/:serviceId/template-data/files/:fileId', auth, async (req, res) => {
  try {
    const { serviceId, fileId } = req.params;
    const { description } = req.body;

    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    const [[planner]] = await connection.execute(
      `SELECT id, template_data
       FROM planners
       WHERE id = ? AND community_id = ?`,
      [serviceId, communityId]
    );

    if (!planner) return errorResponse(res, 'Service not found', 404);

    const data = parseJsonSafe(planner.template_data, { sections: [], notes: [], files: [], music: [] });
    const files = Array.isArray(data.files) ? data.files : [];

    const fidNum = Number(fileId);
    const idx = files.findIndex((f) => Number(f.id) === fidNum);
    if (idx === -1) return errorResponse(res, 'File not found', 404);

    const current = files[idx];
    const updated = {
      ...current,
      description: description !== undefined ? description : current.description,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user.id
    };

    files[idx] = updated;
    data.files = files;

    await connection.execute(
      'UPDATE planners SET template_data = ? WHERE id = ? AND community_id = ?',
      [JSON.stringify(data), serviceId, communityId]
    );

    return successResponse(res, updated, 'File updated successfully');
  } catch (err) {
    console.error('Error updating service file:', err);
    return errorResponse(res, 'Error updating service file', 500);
  }
});

/**
 * =====================================================
 * DELETE /api/planners/:serviceId/template-data/files/:fileId
 * Delete file in service template data
 * =====================================================
 * Access : Private
 * =====================================================
 */
router.delete('/:serviceId/template-data/files/:fileId', auth, async (req, res) => {
  try {
    const { serviceId, fileId } = req.params;

    const connection = getMySQLConnection();
    const communityId = await resolveCommunityId(connection, req.user.id);

    const [[planner]] = await connection.execute(
      `SELECT id, template_data
       FROM planners
       WHERE id = ? AND community_id = ?`,
      [serviceId, communityId]
    );

    if (!planner) return errorResponse(res, 'Service not found', 404);

    const data = parseJsonSafe(planner.template_data, { sections: [], notes: [], files: [], music: [] });
    const files = Array.isArray(data.files) ? data.files : [];

    const fidNum = Number(fileId);
    const filtered = files.filter((f) => Number(f.id) !== fidNum);
    if (filtered.length === files.length) {
      return errorResponse(res, 'File not found', 404);
    }

    data.files = filtered;

    await connection.execute(
      'UPDATE planners SET template_data = ? WHERE id = ? AND community_id = ?',
      [JSON.stringify(data), serviceId, communityId]
    );

    return successResponse(res, { id: fidNum }, 'File deleted successfully');
  } catch (err) {
    console.error('Error deleting service file:', err);
    return errorResponse(res, 'Error deleting service file', 500);
  }
});

module.exports = router;