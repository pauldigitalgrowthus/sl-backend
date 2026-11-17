const express = require('express');
const { auth } = require('../../middleware/auth');
const { getMySQLConnection } = require('../../config/mysql');
const { successResponse, errorResponse } = require('../../utils/response');

const router = express.Router();

const ALLOWED_PRODUCT_TYPES = ['music', 'document', 'course', 'academy'];

// @route   GET /api/royalty/product-config/:productType/:productId
// @desc    Get royalty deduction flags for a specific composition, document, or course
// @access  Private
router.get('/:productType/:productId(\\d+)', auth, async (req, res) => {
  try {
    const { productType, productId } = req.params;
    if (!ALLOWED_PRODUCT_TYPES.includes(productType)) {
      return errorResponse(res, `productType must be one of: ${ALLOWED_PRODUCT_TYPES.join(', ')}`, 400);
    }

    const normalizedType = productType === 'academy' ? 'course' : productType;
    const mysql = getMySQLConnection();

    // All active entities, LEFT JOINed with this product's config
    // so the response always shows every entity (applies=false if unset)
    const [rows] = await mysql.execute(
      `SELECT
        rde.id AS deduction_entity_id,
        rde.name AS entity_name,
        COALESCE(prc.applies, FALSE) AS applies,
        COALESCE(prc.percent, 0) AS percent,
        prc.id AS config_id
       FROM royalty_deduction_entities rde
       LEFT JOIN product_royalty_config prc
         ON prc.deduction_entity_id = rde.id
         AND prc.product_type = ? AND prc.product_id = ?
       WHERE rde.is_active = TRUE
       ORDER BY rde.name ASC`,
      [normalizedType, productId]
    );

    successResponse(res, { productType, productId: Number(productId), config: rows }, 'Product royalty config fetched');
  } catch (error) {
    console.error('Get product royalty config error:', error);
    errorResponse(res, 'Failed to fetch product royalty config', 500);
  }
});

// @route   PUT /api/royalty/product-config/:productType/:productId
// @desc    Set royalty deduction flags for a product (bulk upsert, one call per product)
// @body    { config: [{ deduction_entity_id, applies, percent }, ...] }
// @access  Private (Admin / SL Team)
router.put('/:productType/:productId(\\d+)', auth, async (req, res) => {
  const mysql = getMySQLConnection();
  try {
    const { productType, productId } = req.params;
    const { config } = req.body;

    if (!ALLOWED_PRODUCT_TYPES.includes(productType)) {
      return errorResponse(res, `productType must be one of: ${ALLOWED_PRODUCT_TYPES.join(', ')}`, 400);
    }

    if (!Array.isArray(config) || config.length === 0) {
      return errorResponse(res, 'config array is required', 400);
    }

    const normalizedType = productType === 'academy' ? 'course' : productType;

    // Verify the underlying product exists
    const tableMap = {
      music: 'music_publications',
      document: 'documents',
      course: 'courses',
      academy: 'courses'
    };
    const table = tableMap[normalizedType] || 'courses';
    const [[product]] = await mysql.execute(
      `SELECT id FROM ${table} WHERE id = ? LIMIT 1`,
      [productId]
    );
    if (!product) return errorResponse(res, `${productType} product not found`, 404);

    // await mysql.beginTransaction();

    for (const entry of config) {
      const { deduction_entity_id, applies, percent } = entry;
      if (!deduction_entity_id) continue;

      await mysql.execute(
        `INSERT INTO product_royalty_config (product_type, product_id, deduction_entity_id, applies, percent)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE applies = VALUES(applies), percent = VALUES(percent), updated_at = NOW()`,
        [normalizedType, productId, deduction_entity_id, applies ? 1 : 0, percent || 0]
      );
    }

    // await mysql.commit();

    const [updated] = await mysql.execute(
      `SELECT prc.*, rde.name AS entity_name
       FROM product_royalty_config prc
       JOIN royalty_deduction_entities rde ON rde.id = prc.deduction_entity_id
       WHERE prc.product_type = ? AND prc.product_id = ?
       ORDER BY rde.name ASC`,
      [normalizedType, productId]
    );

    successResponse(res, { config: updated }, 'Product royalty config updated');
  } catch (error) {
    // await mysql.rollback();
    console.error('Update product royalty config error:', error);
    errorResponse(res, 'Failed to update product royalty config', 500);
  }
});

module.exports = router;
