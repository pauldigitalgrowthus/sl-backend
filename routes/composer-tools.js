const express = require('express');
const { getMySQLConnection } = require('../config/mysql');
const { auth } = require('../middleware/auth');
const { requireAnyRole } = require('../middleware/roleAuth');
const { successResponse, errorResponse } = require('../utils/response');
const XLSX = require('xlsx');
const multer = require('multer');

const router = express.Router();

// Configure multer for Excel file upload
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        file.mimetype === 'application/vnd.ms-excel' ||
        file.originalname.endsWith('.xlsx') ||
        file.originalname.endsWith('.xls')) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel files (.xlsx, .xls) are allowed'), false);
    }
  }
});

// @route   GET /api/composer-tools
// @desc    Get all composer tools (public access for composer module)
// @access  Public
router.get('/', async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    
    const [tools] = await mysqlConnection.execute(`
      SELECT 
        id,
        tool_name,
        tool_content,
        tool_type,
        is_active,
        display_order,
        created_at,
        updated_at
      FROM composer_tools 
      WHERE is_active = TRUE 
      ORDER BY display_order ASC, created_at ASC
    `);

    successResponse(res, {
      tools: tools,
      total: tools.length
    }, 'Composer tools retrieved successfully');

  } catch (error) {
    console.error('Get composer tools error:', error);
    errorResponse(res, 'Failed to get composer tools', 500);
  }
});

// @route   GET /api/composer-tools/admin
// @desc    Get all composer tools for admin management (includes inactive)
// @access  Private (SL Team only)
router.get('/admin', [
  auth
  ], async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    
    const [tools] = await mysqlConnection.execute(`
      SELECT 
        id,
        tool_name,
        tool_content,
        tool_type,
        is_active,
        display_order,
        created_at,
        updated_at,
        created_by,
        updated_by
      FROM composer_tools 
      ORDER BY display_order ASC, created_at ASC
    `);

    // Get creator and updater names
    const toolIds = tools.map(tool => tool.id);
    if (toolIds.length > 0) {
      const [creators] = await mysqlConnection.execute(`
        SELECT DISTINCT u.id, u.first_name, u.last_name
        FROM users u
        WHERE u.id IN (${toolIds.map(() => '?').join(',')})
      `, toolIds);

      const creatorMap = {};
      creators.forEach(creator => {
        creatorMap[creator.id] = `${creator.first_name} ${creator.last_name}`;
      });

      tools.forEach(tool => {
        tool.created_by_name = creatorMap[tool.created_by] || 'Unknown';
        tool.updated_by_name = creatorMap[tool.updated_by] || 'Unknown';
      });
    }

    successResponse(res, {
      tools: tools,
      total: tools.length
    }, 'Composer tools retrieved successfully for admin');

  } catch (error) {
    console.error('Get composer tools admin error:', error);
    errorResponse(res, 'Failed to get composer tools', 500);
  }
});

// @route   GET /api/composer-tools/:id
// @desc    Get specific composer tool
// @access  Public
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();
    
    const [tools] = await mysqlConnection.execute(`
      SELECT 
        id,
        tool_name,
        tool_content,
        tool_type,
        is_active,
        display_order,
        created_at,
        updated_at
      FROM composer_tools 
      WHERE id = ? AND is_active = TRUE
    `, [id]);

    if (tools.length === 0) {
      return errorResponse(res, 'Composer tool not found', 404);
    }

    successResponse(res, {
      tool: tools[0]
    }, 'Composer tool retrieved successfully');

  } catch (error) {
    console.error('Get composer tool error:', error);
    errorResponse(res, 'Failed to get composer tool', 500);
  }
});

// @route   POST /api/composer-tools
// @desc    Create new composer tool
// @access  Private (SL Team only)
router.post('/', [
  auth,
  // requireAnyRole(['sl_team', 'admin'])
], async (req, res) => {
  try {
    const {
      toolName,
      toolContent,
      toolType = 'general',
      displayOrder = 0,
      isActive = true
    } = req.body;

    const creatorId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Validate required fields
    if (!toolName) {
      return errorResponse(res, 'Tool name is required', 400);
    }

    // Create new composer tool
    const [result] = await mysqlConnection.execute(`
      INSERT INTO composer_tools (
        tool_name,
        tool_content,
        tool_type,
        is_active,
        display_order,
        created_by,
        updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      toolName,
      toolContent || null,
      toolType || 'general',
      isActive !== undefined ? isActive : true,
      displayOrder !== undefined ? displayOrder : 0,
      creatorId,
      creatorId
    ]);

    // Get created tool
    const [createdTools] = await mysqlConnection.execute(`
      SELECT 
        id,
        tool_name,
        tool_content,
        tool_type,
        is_active,
        display_order,
        created_at,
        updated_at
      FROM composer_tools 
      WHERE id = ?
    `, [result.insertId]);

    successResponse(res, {
      tool: createdTools[0]
    }, 'Composer tool created successfully', 201);

  } catch (error) {
    console.error('Create composer tool error:', error);
    errorResponse(res, 'Failed to create composer tool', 500);
  }
});

// @route   PUT /api/composer-tools/:id
// @desc    Update composer tool
// @access  Private (SL Team only)
router.put('/:id', [
  auth,
  // requireAnyRole(['sl_team', 'admin'])
], async (req, res) => {
  try {
    const { id } = req.params;
    const {
      toolName,
      toolContent,
      toolType,
      displayOrder,
      isActive
    } = req.body;

    const updaterId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Check if tool exists
    const [existingTools] = await mysqlConnection.execute(
      'SELECT id FROM composer_tools WHERE id = ?',
      [id]
    );

    if (existingTools.length === 0) {
      return errorResponse(res, 'Composer tool not found', 404);
    }

    // Build update query dynamically
    const updateFields = [];
    const updateValues = [];

    if (toolName !== undefined) {
      updateFields.push('tool_name = ?');
      updateValues.push(toolName);
    }
    if (toolContent !== undefined) {
      updateFields.push('tool_content = ?');
      updateValues.push(toolContent);
    }
    if (toolType !== undefined) {
      updateFields.push('tool_type = ?');
      updateValues.push(toolType);
    }
    if (displayOrder !== undefined) {
      updateFields.push('display_order = ?');
      updateValues.push(displayOrder);
    }
    if (isActive !== undefined) {
      updateFields.push('is_active = ?');
      updateValues.push(isActive);
    }

    if (updateFields.length === 0) {
      return errorResponse(res, 'No fields to update', 400);
    }

    updateFields.push('updated_by = ?', 'updated_at = NOW()');
    updateValues.push(updaterId, id);

    await mysqlConnection.execute(
      `UPDATE composer_tools SET ${updateFields.join(', ')} WHERE id = ?`,
      updateValues
    );

    // Get updated tool
    const [updatedTools] = await mysqlConnection.execute(`
      SELECT 
        id,
        tool_name,
        tool_content,
        tool_type,
        is_active,
        display_order,
        created_at,
        updated_at
      FROM composer_tools 
      WHERE id = ?
    `, [id]);

    successResponse(res, {
      tool: updatedTools[0]
    }, 'Composer tool updated successfully');

  } catch (error) {
    console.error('Update composer tool error:', error);
    errorResponse(res, 'Failed to update composer tool', 500);
  }
});

// @route   DELETE /api/composer-tools/:id
// @desc    Delete composer tool
// @access  Private (SL Team only)
router.delete('/:id', [
  auth,
  requireAnyRole(['sl_team', 'admin'])
], async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();

    // Check if tool exists
    const [existingTools] = await mysqlConnection.execute(
      'SELECT id FROM composer_tools WHERE id = ?',
      [id]
    );

    if (existingTools.length === 0) {
      return errorResponse(res, 'Composer tool not found', 404);
    }

    // Delete the tool
    await mysqlConnection.execute(
      'DELETE FROM composer_tools WHERE id = ?',
      [id]
    );

    successResponse(res, {
      deletedToolId: id
    }, 'Composer tool deleted successfully');

  } catch (error) {
    console.error('Delete composer tool error:', error);
    errorResponse(res, 'Failed to delete composer tool', 500);
  }
});

// @route   PUT /api/composer-tools/:id/toggle-status
// @desc    Toggle composer tool active/inactive status
// @access  Private (SL Team only)
router.put('/:id/toggle-status', [
  auth,
  requireAnyRole(['sl_team', 'admin'])
], async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();

    // Get current status
    const [tools] = await mysqlConnection.execute(
      'SELECT is_active FROM composer_tools WHERE id = ?',
      [id]
    );

    if (tools.length === 0) {
      return errorResponse(res, 'Composer tool not found', 404);
    }

    const newStatus = !tools[0].is_active;

    // Update status
    await mysqlConnection.execute(
      'UPDATE composer_tools SET is_active = ?, updated_by = ?, updated_at = NOW() WHERE id = ?',
      [newStatus, req.user.id, id]
    );

    successResponse(res, {
      toolId: id,
      newStatus: newStatus ? 'active' : 'inactive'
    }, `Composer tool ${newStatus ? 'activated' : 'deactivated'} successfully`);

  } catch (error) {
    console.error('Toggle composer tool status error:', error);
    errorResponse(res, 'Failed to toggle composer tool status', 500);
  }
});

// @route   PUT /api/composer-tools/reorder
// @desc    Reorder composer tools
// @access  Private (SL Team only)
router.put('/reorder', [
  auth,
  requireAnyRole(['sl_team', 'admin'])
], async (req, res) => {
  try {
    const { toolOrders } = req.body; // Array of {id, displayOrder}
    const mysqlConnection = getMySQLConnection();

    if (!Array.isArray(toolOrders)) {
      return errorResponse(res, 'toolOrders must be an array', 400);
    }

    // Update each tool's display order
    for (const toolOrder of toolOrders) {
      await mysqlConnection.execute(
        'UPDATE composer_tools SET display_order = ?, updated_by = ?, updated_at = NOW() WHERE id = ?',
        [toolOrder.displayOrder, req.user.id, toolOrder.id]
      );
    }

    successResponse(res, {
      updatedTools: toolOrders.length
    }, 'Composer tools reordered successfully');

  } catch (error) {
    console.error('Reorder composer tools error:', error);
    errorResponse(res, 'Failed to reorder composer tools', 500);
  }
});

// @route   POST /api/composer-tools/import
// @desc    Import composer tools from Excel file
// @access  Private (SL Team only)
router.post('/import', [
  auth,
  requireAnyRole(['sl_team', 'admin']),
  upload.single('file')
], async (req, res) => {
  try {
    if (!req.file) {
      return errorResponse(res, 'Excel file is required', 400);
    }

    const mysqlConnection = getMySQLConnection();
    const workbook = XLSX.read(req.file.buffer);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);

    const results = {
      success: 0,
      failed: 0,
      errors: []
    };

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rowNumber = i + 2; // Excel row number (accounting for header)

      try {
        // Skip empty rows
        if (!row.toolName && !row.toolContent && !row.toolType) {
          continue; // Skip completely empty rows
        }

        // Create composer tool
        const [result] = await mysqlConnection.execute(`
          INSERT INTO composer_tools (
            tool_name,
            tool_content,
            tool_type,
            is_active,
            display_order,
            created_by,
            updated_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
          row.toolName || 'Untitled Tool',
          row.toolContent || null,
          row.toolType || 'general',
          row.isActive !== undefined ? (row.isActive === 'true' || row.isActive === true) : true,
          row.displayOrder || 0,
          req.user.id,
          req.user.id
        ]);

        results.success++;

      } catch (rowError) {
        results.failed++;
        results.errors.push(`Row ${rowNumber}: ${rowError.message}`);
      }
    }

    successResponse(res, {
      importResults: results,
      message: `Import completed. ${results.success} tools imported successfully, ${results.failed} failed.`
    }, 'Composer tools import completed');

  } catch (error) {
    console.error('Import composer tools error:', error);
    errorResponse(res, 'Failed to import composer tools', 500);
  }
});

// @route   GET /api/composer-tools/import-template
// @desc    Download Excel template for composer tools import
// @access  Private (SL Team only)
router.get('/import-template', [
  auth,
  requireAnyRole(['sl_team', 'admin'])
], async (req, res) => {
  try {
    // Create template data
    const templateData = [
      {
        toolName: 'Chord Progression Generator',
        toolContent: 'Generate chord progressions for any key signature',
        toolType: 'composition',
        isActive: 'true',
        displayOrder: 1
      },
      {
        toolName: 'Scale Finder',
        toolContent: 'Find scales for any key signature',
        toolType: 'theory',
        isActive: 'true',
        displayOrder: 2
      }
    ];

    // Create workbook
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(templateData);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Composer Tools');

    // Generate buffer
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    // Set headers for file download
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=composer_tools_template.xlsx');
    res.setHeader('Content-Length', buffer.length);

    res.send(buffer);

  } catch (error) {
    console.error('Generate template error:', error);
    errorResponse(res, 'Failed to generate template', 500);
  }
});

module.exports = router;
