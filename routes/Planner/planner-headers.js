const express = require('express');
const router = express.Router();
const { getMySQLConnection } = require('../../config/mysql');
const { auth } = require('../../middleware/auth');
const { successResponse, errorResponse } = require('../../utils/response');
const { parseJsonSafe, resolveCommunityId } = require('./helpers');

// Utility: load planner ensuring community scope
async function loadPlannerById(connection, authUserId, plannerId) {
  const communityId = await resolveCommunityId(connection, authUserId);
  const [rows] = await connection.execute(
    `SELECT id, community_id, template_data FROM planners WHERE id = ? AND community_id = ?`,
    [plannerId, communityId]
  );
  if (!rows || rows.length === 0) return null;
  const planner = rows[0];
  const td = parseJsonSafe(planner.template_data, {});
  planner.template_data = {
    sections: Array.isArray(td.sections) ? td.sections : [],
    notes: Array.isArray(td.notes) ? td.notes : [],
    files: Array.isArray(td.files) ? td.files : [],
  };
  return planner;
}

// POST /api/planners/:id/headers  -> create header
router.post('/:id/headers', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description } = req.body;
    if (!title || !title.toString().trim()) {
      return errorResponse(res, 'title is required', 400);
    }

    const connection = getMySQLConnection();
    const planner = await loadPlannerById(connection, req.user.id, id);
    if (!planner) return errorResponse(res, 'Planner not found', 404);

    const header = {
      id: Date.now(),
      type: 'header',
      title: title.toString().trim(),
      description: (description || '').toString(),
      isTemplateHeader: true,
    };

    const updatedSections = [...planner.template_data.sections, header];
const newTemplateData = { ...planner.template_data, sections: updatedSections, };
   await connection.execute( 'UPDATE planners SET template_data = ? WHERE id = ?', [JSON.stringify(newTemplateData), id] );

    return successResponse(res, { header, sections: updatedSections }, 'Header created', 201);
  } catch (err) {
    console.error('Error creating header:', err);
    return errorResponse(res, 'Error creating header', 500);
  }
});

// PUT /api/planners/:id/headers/:headerId  -> update header
router.put('/:id/headers/:headerId', auth, async (req, res) => {
  try {
    const { id, headerId } = req.params;
    const { title, description } = req.body;
    const connection = getMySQLConnection();
    const planner = await loadPlannerById(connection, req.user.id, id);
    if (!planner) return errorResponse(res, 'Planner not found', 404);

    const hid = Number(headerId);
    const sections = planner.template_data.sections.map((s) => {
      if (s && s.type === 'header' && Number(s.id) === hid) {
        return {
          ...s,
          title: title !== undefined ? title.toString().trim() : s.title,
          description: description !== undefined ? description.toString() : s.description,
        };
      }
      return s;
    });

    const newTemplateData = { ...planner.template_data, sections, };

   await connection.execute( 'UPDATE planners SET template_data = ? WHERE id = ?', [JSON.stringify(newTemplateData), id] );

    return successResponse(res, { sections }, 'Header updated');
  } catch (err) {
    console.error('Error updating header:', err);
    return errorResponse(res, 'Error updating header', 500);
  }
});

// DELETE /api/planners/:id/headers/:headerId  -> delete header
router.delete('/:id/headers/:headerId', auth, async (req, res) => {
  try {
    const { id, headerId } = req.params;
    const connection = getMySQLConnection();
    const planner = await loadPlannerById(connection, req.user.id, id);
    if (!planner) return errorResponse(res, 'Planner not found', 404);

    const hid = Number(headerId);
    const sections = planner.template_data.sections.filter((s) => !(s && s.type === 'header' && Number(s.id) === hid));
    
    const newTemplateData = { ...planner.template_data, sections, };
    await connection.execute( 'UPDATE planners SET template_data = ? WHERE id = ?', [JSON.stringify(newTemplateData), id] );

    return successResponse(res, { sections }, 'Header deleted');
  } catch (err) {
    console.error('Error deleting header:', err);
    return errorResponse(res, 'Error deleting header', 500);
  }
});

module.exports = router;
