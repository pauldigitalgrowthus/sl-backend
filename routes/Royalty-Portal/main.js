const express = require('express');
const router = express.Router();

// ================= IMPORT ROUTES =================
const deductionEntitiesRoutes = require('./deduction-entities');
const productRoyaltyConfigRoutes = require('./product-royalty-config');
const reviewBoardStipendsRoutes = require('./review-board-stipends');
const userPayoutMethodsRoutes = require('./user-payout-methods');
const oneLicenseRoutes = require('./one-license');
const payPeriodsRoutes = require('./pay-periods');
const composerPayoutsRoutes = require('./composer-payouts');
const documentRoyaltyRoutes = require('./document-royalty');
const returnsRoutes = require('./returns');
const diocesanDiscountRoutes = require('./diocesan-discount');
const dashboardsRoutes = require('./dashboards');
const historicalImportRoutes = require('./historical-import');
const educatorPayoutsRoutes = require('./educator-payouts');
const planRevenueAllocationsRoutes = require("./plan-revenue-allocations");
const payPeriodSettingsRoutes = require("./pay-period-settings");


// ================= DEDUCTION ENTITIES (ICEL/USCCB/CCD/Other) =================
// @route   /api/royalty/deduction-entities
router.use('/deduction-entities', deductionEntitiesRoutes);

// ================= PRODUCT-LEVEL ROYALTY CONFIG =================
// @route   /api/royalty/product-config/:productType/:productId
router.use('/product-config', productRoyaltyConfigRoutes);

// ================= REVIEW BOARD STIPENDS =================
// @route   /api/royalty/review-board
router.use('/review-board', reviewBoardStipendsRoutes);

// ================= PAYOUT METHOD (shared: composer/document owner/review board) =================
// @route   /api/royalty/payout-method
router.use('/payout-method', userPayoutMethodsRoutes);

// ================= ONE LICENSE IMPORT =================
// @route   /api/royalty/one-license
router.use('/one-license', oneLicenseRoutes);

// ================= PAY PERIODS (subscription pool distribution) =================
// @route   /api/royalty/pay-periods
router.use('/pay-periods', payPeriodsRoutes);

// ================= COMPOSER PAYOUTS (admin actions on composer_earnings) =================
// @route   /api/royalty/composer-payouts
router.use('/composer-payouts', composerPayoutsRoutes);

// ================= DOCUMENT ROYALTY (document owner dashboard) =================
// @route   /api/royalty/documents
router.use('/documents', documentRoyaltyRoutes);

// ================= RETURNS / REFUNDS (reverses royalty on cancellation) =================
// @route   /api/royalty/returns
router.use('/returns', returnsRoutes);

// ================= DIOCESAN ADOPTION DISCOUNT (SOW 3.1.D) =================
// @route   /api/royalty/diocesan
router.use('/diocesan', diocesanDiscountRoutes);

// ================= DASHBOARDS (Composer/Review Board/SL Team/Entity reports) =================
// @route   /api/royalty/dashboards
router.use('/dashboards', dashboardsRoutes);

// ================= HISTORICAL DATA IMPORT (2017-present) =================
// @route   /api/royalty/historical-import
router.use('/historical-import', historicalImportRoutes);

// ================= EDUCATOR PAYOUTS (Academy - now in scope) =================
// @route   /api/royalty/educator-payouts
router.use('/educator-payouts', educatorPayoutsRoutes);

// ================= PLAN REVENUE ALLOCATIONS (SOW 3.1.C) ================= 
// @route   /api/royalty/plan-revenue-allocations
router.use('/plan-revenue-allocations', planRevenueAllocationsRoutes);

// ================= PAY PERIOD SETTINGS (configurable period length) =================
// @route   /api/royalty/pay-period-settings
router.use('/pay-period-settings', payPeriodSettingsRoutes);

module.exports = router;
