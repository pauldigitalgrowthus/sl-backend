const express = require('express');
const { auth } = require('../../middleware/auth');
const { getMySQLConnection } = require('../../config/mysql');
const { successResponse, errorResponse } = require('../../utils/response');
const { deductionEntityLogoUpload } = require('../../config/s3');

const router = express.Router();

// Middleware to handle single 'logo' image upload safely
const handleLogoUpload = (req, res, next) => {
  deductionEntityLogoUpload.single('logo')(req, res, (err) => {
    if (err) {
      return errorResponse(res, err.message || 'Logo upload error', 400);
    }
    next();
  });
};

/* ============================================================
   HELPER: aggregate one entity's totals across all 3 modules
   (Music/composer_earning_deductions, Documents/document_royalty_deductions,
   Academy/educator_earning_deductions).

   Definitions used:
   - totalRoyalties  = sum of all deduction amounts owed to this entity
                        (this IS what the entity earns - it's their cut)
   - paidAmount      = portion of totalRoyalties already remitted to the
                        entity (deduction row status = 'paid')
   - pendingAmount   = portion not yet remitted (status = 'pending')
   - unpaidAmount    = same figure as pendingAmount (kept as a separate
                        field to match the dashboard columns 1:1 - there
                        is currently only one non-paid state, so these
                        two always match; flag this if a distinct
                        "unpaid but overdue" state is wanted later)
   - noOfContents    = distinct compositions/documents/courses that have
                        ever triggered a deduction for this entity
============================================================ */
const getEntityTotals = async (mysql, entityId) => {
  const [[musicTotals]] = await mysql.execute(
    `SELECT
      COUNT(DISTINCT ce.music_publication_id) AS contentCount,
      COALESCE(SUM(ced.amount), 0) AS total,
      COALESCE(SUM(CASE WHEN ced.status = 'paid' THEN ced.amount ELSE 0 END), 0) AS paid,
      COALESCE(SUM(CASE WHEN ced.status = 'pending' THEN ced.amount ELSE 0 END), 0) AS pending
     FROM composer_earning_deductions ced
     JOIN composer_earnings ce ON ce.id = ced.composer_earning_id
     WHERE ced.deduction_entity_id = ? AND ce.status != 'cancelled'`,
    [entityId]
  );

  const [[documentTotals]] = await mysql.execute(
    `SELECT
      COUNT(DISTINCT dre.document_id) AS contentCount,
      COALESCE(SUM(drd.amount), 0) AS total,
      COALESCE(SUM(CASE WHEN drd.status = 'paid' THEN drd.amount ELSE 0 END), 0) AS paid,
      COALESCE(SUM(CASE WHEN drd.status = 'pending' THEN drd.amount ELSE 0 END), 0) AS pending
     FROM document_royalty_deductions drd
     JOIN document_royalty_earnings dre ON dre.id = drd.document_royalty_earning_id
     WHERE drd.deduction_entity_id = ? AND dre.status != 'cancelled'`,
    [entityId]
  );

  const [[educatorTotals]] = await mysql.execute(
    `SELECT
      COUNT(DISTINCT ee.course_id) AS contentCount,
      COALESCE(SUM(eed.amount), 0) AS total,
      COALESCE(SUM(CASE WHEN eed.status = 'paid' THEN eed.amount ELSE 0 END), 0) AS paid,
      COALESCE(SUM(CASE WHEN eed.status = 'pending' THEN eed.amount ELSE 0 END), 0) AS pending
     FROM educator_earning_deductions eed
     JOIN educator_earnings ee ON ee.id = eed.educator_earning_id
     WHERE eed.deduction_entity_id = ? AND ee.status != 'cancelled'`,
    [entityId]
  );

  const totalRoyalties = Number(musicTotals.total) + Number(documentTotals.total) + Number(educatorTotals.total);
  const paidAmount = Number(musicTotals.paid) + Number(documentTotals.paid) + Number(educatorTotals.paid);
  const pendingAmount = Number(musicTotals.pending) + Number(documentTotals.pending) + Number(educatorTotals.pending);
  const noOfContents = Number(musicTotals.contentCount) + Number(documentTotals.contentCount) + Number(educatorTotals.contentCount);

  return {
    totalRoyalties: Number(totalRoyalties.toFixed(2)),
    totalDeductions: Number(totalRoyalties.toFixed(2)), // same figure - it IS the deducted amount
    netAmount: Number(totalRoyalties.toFixed(2)),
    paidAmount: Number(paidAmount.toFixed(2)),
    pendingAmount: Number(pendingAmount.toFixed(2)),
    unpaidAmount: Number(pendingAmount.toFixed(2)),
    noOfContents,
    breakdown: { music: musicTotals, documents: documentTotals, academy: educatorTotals }
  };
};

// @route   GET /api/royalty/deduction-entities
// @desc    List all deduction entities WITH aggregated royalty totals
//          (dashboard-ready: Total Royalties, Paid, Pending, Unpaid,
//          No. of Contents, Status - matches the Copyright Holders UI)
// @access  Private
router.get('/', auth, async (req, res) => {
  try {
    const mysql = getMySQLConnection();
    const [entities] = await mysql.execute(
      `SELECT * FROM royalty_deduction_entities ORDER BY name ASC`
    );

    const enriched = [];
    for (const entity of entities) {
      const totals = await getEntityTotals(mysql, entity.id);
      enriched.push({
        id: entity.id,
        name: entity.name,
        description: entity.description,
        logo: entity.logo || null,
        status: entity.is_active ? 'Active' : 'Inactive',
        is_active: !!entity.is_active,
        created_at: entity.created_at,
        updated_at: entity.updated_at,
        ...totals
      });
    }

    const summary = enriched.reduce((acc, e) => ({
      totalRoyalties: acc.totalRoyalties + e.totalRoyalties,
      totalDeductions: acc.totalDeductions + e.totalDeductions,
      netAmount: acc.netAmount + e.netAmount,
      paidAmount: acc.paidAmount + e.paidAmount,
      pendingAmount: acc.pendingAmount + e.pendingAmount,
      unpaidAmount: acc.unpaidAmount + e.unpaidAmount,
      noOfContents: acc.noOfContents + e.noOfContents
    }), { totalRoyalties: 0, totalDeductions: 0, netAmount: 0, paidAmount: 0, pendingAmount: 0, unpaidAmount: 0, noOfContents: 0 });

    successResponse(res, {
      entities: enriched,
      total: enriched.length,
      summary
    }, 'Deduction entities fetched');
  } catch (error) {
    console.error('Get deduction entities error:', error);
    errorResponse(res, 'Failed to fetch deduction entities', 500);
  }
});

// @route   GET /api/royalty/deduction-entities/:id
// @desc    Single entity detail (for the "View" button in the dashboard)
router.get('/:id(\\d+)', auth, async (req, res) => {
  try {
    const mysql = getMySQLConnection();
    const { id } = req.params;

    const [[entity]] = await mysql.execute(
      `SELECT * FROM royalty_deduction_entities WHERE id = ?`,
      [id]
    );
    if (!entity) return errorResponse(res, 'Entity not found', 404);

    const totals = await getEntityTotals(mysql, id);

    successResponse(res, {
      id: entity.id,
      name: entity.name,
      description: entity.description,
      logo: entity.logo || null,
      status: entity.is_active ? 'Active' : 'Inactive',
      is_active: !!entity.is_active,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
      ...totals
    }, 'Entity detail fetched');
  } catch (error) {
    console.error('Get entity detail error:', error);
    errorResponse(res, 'Failed to fetch entity detail', 500);
  }
});

// @route   POST /api/royalty/deduction-entities
// @desc    Add a new deduction entity (e.g. a future copyright holder beyond ICEL/USCCB/CCD)
// @access  Private (Admin)
router.post('/', auth, handleLogoUpload, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const { name, description } = req.body;
    if (!name) return errorResponse(res, 'Entity name is required', 400);

    let logoUrl = null;
    if (req.file && req.file.location) {
      logoUrl = req.file.location;
    } else if (req.body.logo) {
      logoUrl = req.body.logo;
    } else if (req.body.logo_url) {
      logoUrl = req.body.logo_url;
    }

    const mysql = getMySQLConnection();

    const [existing] = await mysql.execute(
      `SELECT id FROM royalty_deduction_entities WHERE name = ?`,
      [name.trim()]
    );
    if (existing.length > 0) {
      return errorResponse(res, `Entity "${name}" already exists`, 400);
    }

    const [result] = await mysql.execute(
      `INSERT INTO royalty_deduction_entities (name, description, logo) VALUES (?, ?, ?)`,
      [name.trim(), description || null, logoUrl]
    );

    const [[newEntity]] = await mysql.execute(
      `SELECT * FROM royalty_deduction_entities WHERE id = ?`,
      [result.insertId]
    );

    successResponse(res, {
      id: newEntity.id,
      name: newEntity.name,
      description: newEntity.description,
      logo: newEntity.logo,
      is_active: !!newEntity.is_active,
      created_at: newEntity.created_at,
      updated_at: newEntity.updated_at
    }, 'Deduction entity created', 201);
  } catch (error) {
    console.error('Create deduction entity error:', error);
    errorResponse(res, 'Failed to create deduction entity', 500);
  }
});

// @route   PUT /api/royalty/deduction-entities/:id
// @desc    Update entity (name/description/logo/active status)
// @access  Private (Admin)
router.put('/:id(\\d+)', auth, handleLogoUpload, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const { id } = req.params;
    const { name, description, is_active } = req.body;
    const mysql = getMySQLConnection();

    const [existing] = await mysql.execute(
      `SELECT id FROM royalty_deduction_entities WHERE id = ?`,
      [id]
    );
    if (existing.length === 0) return errorResponse(res, 'Entity not found', 404);

    const updates = [];
    const values = [];

    if (name !== undefined) { updates.push('name = ?'); values.push(name.trim()); }
    if (description !== undefined) { updates.push('description = ?'); values.push(description); }
    if (is_active !== undefined) { updates.push('is_active = ?'); values.push(is_active ? 1 : 0); }

    if (req.file && req.file.location) {
      updates.push('logo = ?');
      values.push(req.file.location);
    } else if (req.body.logo !== undefined) {
      updates.push('logo = ?');
      values.push(req.body.logo || null);
    } else if (req.body.logo_url !== undefined) {
      updates.push('logo = ?');
      values.push(req.body.logo_url || null);
    }

    if (updates.length === 0) return errorResponse(res, 'No fields to update', 400);

    updates.push('updated_at = NOW()');
    values.push(id);

    await mysql.execute(
      `UPDATE royalty_deduction_entities SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    const [[updatedEntity]] = await mysql.execute(
      `SELECT * FROM royalty_deduction_entities WHERE id = ?`,
      [id]
    );

    successResponse(res, {
      id: updatedEntity.id,
      name: updatedEntity.name,
      description: updatedEntity.description,
      logo: updatedEntity.logo,
      is_active: !!updatedEntity.is_active,
      created_at: updatedEntity.created_at,
      updated_at: updatedEntity.updated_at
    }, 'Deduction entity updated');
    
  } catch (error) {
    console.error('Update deduction entity error:', error);
    errorResponse(res, 'Failed to update deduction entity', 500);
  }
});

// @route   DELETE /api/royalty/deduction-entities/:id
// @desc    Deactivate an entity (soft delete via is_active, keeps history intact)
// @access  Private (Admin)
router.delete('/:id(\\d+)', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const { id } = req.params;
    const mysql = getMySQLConnection();

    await mysql.execute(
      `UPDATE royalty_deduction_entities SET is_active = FALSE WHERE id = ?`,
      [id]
    );

    successResponse(res, null, 'Deduction entity deactivated');
  } catch (error) {
    console.error('Deactivate deduction entity error:', error);
    errorResponse(res, 'Failed to deactivate deduction entity', 500);
  }
});

// @route   PUT /api/royalty/deduction-entities/:id/mark-paid
// @desc    Mark this entity's pending deductions as paid (SL has remitted
//          ICEL/USCCB/CCD their cut) - moves Pending Amount -> Paid Amount
// @body    { pay_period? }  optional - restrict to one pay period
// @access  Private (Admin)
router.put('/:id(\\d+)/mark-paid', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const { id } = req.params;
    const { pay_period } = req.body;
    const mysql = getMySQLConnection();

    let musicUpdated = 0, documentUpdated = 0, educatorUpdated = 0;

    if (pay_period) {
      const [musicResult] = await mysql.execute(
        `UPDATE composer_earning_deductions ced
         JOIN composer_earnings ce ON ce.id = ced.composer_earning_id
         SET ced.status = 'paid', ced.paid_at = NOW()
         WHERE ced.deduction_entity_id = ? AND ced.status = 'pending' AND ce.pay_period = ?`,
        [id, pay_period]
      );
      const [documentResult] = await mysql.execute(
        `UPDATE document_royalty_deductions drd
         JOIN document_royalty_earnings dre ON dre.id = drd.document_royalty_earning_id
         SET drd.status = 'paid', drd.paid_at = NOW()
         WHERE drd.deduction_entity_id = ? AND drd.status = 'pending' AND dre.pay_period = ?`,
        [id, pay_period]
      );
      const [educatorResult] = await mysql.execute(
        `UPDATE educator_earning_deductions eed
         JOIN educator_earnings ee ON ee.id = eed.educator_earning_id
         SET eed.status = 'paid', eed.paid_at = NOW()
         WHERE eed.deduction_entity_id = ? AND eed.status = 'pending' AND ee.pay_period = ?`,
        [id, pay_period]
      );
      musicUpdated = musicResult.affectedRows;
      documentUpdated = documentResult.affectedRows;
      educatorUpdated = educatorResult.affectedRows;
    } else {
      const [musicResult] = await mysql.execute(
        `UPDATE composer_earning_deductions SET status = 'paid', paid_at = NOW()
         WHERE deduction_entity_id = ? AND status = 'pending'`,
        [id]
      );
      const [documentResult] = await mysql.execute(
        `UPDATE document_royalty_deductions SET status = 'paid', paid_at = NOW()
         WHERE deduction_entity_id = ? AND status = 'pending'`,
        [id]
      );
      const [educatorResult] = await mysql.execute(
        `UPDATE educator_earning_deductions SET status = 'paid', paid_at = NOW()
         WHERE deduction_entity_id = ? AND status = 'pending'`,
        [id]
      );
      musicUpdated = musicResult.affectedRows;
      documentUpdated = documentResult.affectedRows;
      educatorUpdated = educatorResult.affectedRows;
    }

    successResponse(res, {
      updated: { music: musicUpdated, documents: documentUpdated, academy: educatorUpdated }
    }, 'Entity deductions marked as paid');
  } catch (error) {
    console.error('Mark entity paid error:', error);
    errorResponse(res, 'Failed to mark entity deductions as paid', 500);
  }
});

module.exports = router;
