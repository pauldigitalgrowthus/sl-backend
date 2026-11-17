const express = require('express');
const router = express.Router();

// Planner template related routes
const plannerTemplateRoutes = require('./planner-template');

// Planner CRUD & music suggestion related routes
const plannerRoutes = require('./planner');

// Planner Ministers CRUD & music suggestion related routes
const plannerMisisterRoutes = require('./planner-misister');

// Planner Groups CRUD & Members related routes
const plannerGroupRoutes = require('./planner-group');

const superadminPlannerRoutes = require('./superadmin-planner');

// Planner Headers CRUD routes
const plannerHeadersRoutes = require('./planner-headers');

// Planner Headers CRUD routes
const plannerLiturgicalEvents = require('./liturgicalEvents');

const massScheduleRoutes = require('./mass-schedule');
const massFilterRoutes = require('./planner-massfilters');
const massTemplates = require('./planner-masstemplates');

// ============================================
// ROUTE MAPPINGS
// ============================================

// /api/planners/templates → Planner Templates APIs
router.use('/templates', plannerTemplateRoutes);

// /api/planners/mass-schedule → Planner Mass Shedules APIs
router.use('/mass-schedule', massScheduleRoutes);

router.use('/mass-filters', massFilterRoutes);

router.use("/mass-templates", massTemplates);

// /api/planners/ministers → Planner Ministers APIs
router.use('/ministers', plannerMisisterRoutes);

// /api/planners/groups → Planner Groups APIs
router.use('/groups', plannerGroupRoutes);

router.use('/subscriber-admin', superadminPlannerRoutes);

// /api/planners/liturgical-events → Planner Liturgical Events APIs
router.use('/liturgical-events', plannerLiturgicalEvents);

// /api/planners → Planner main APIs (CRUD, music suggestions, apply template)
router.use('/', plannerRoutes);

// /api/planners/:id/headers → Planner Headers APIs
router.use('/', plannerHeadersRoutes);

module.exports = router;
