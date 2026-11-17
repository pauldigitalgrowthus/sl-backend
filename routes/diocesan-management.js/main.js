const express = require('express');
const diocesanRouter = require('./diocesan');
const diocesanAgreementsRouter = require('./diocesan-contracts');
const diocesanParishRouter = require('./diocese-parishes')
const diocesanParishPaymentRouter = require('./parish-payments');
const { auth } = require("../../middleware/auth");
const { errorResponse, successResponse } = require("../../utils/response");
const { getMySQLConnection } = require("../../config/mysql")

const router = express.Router();

// /api/agreements
router.use('/', diocesanRouter);

// /api/diocese/agreements
router.use('/', diocesanAgreementsRouter);

// /api/diocese/parishes
router.use('/', diocesanParishRouter);

// /api/diocese/parish/create-card-session
router.use('/', diocesanParishPaymentRouter);

/* ============================================================
   7️⃣ GET ALL PAYMENTS OF MY DIOCESE
============================================================ */
router.get("/payments", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();

        /* =========================================================
           1️⃣ Get Diocese ID from Logged-in User
        ========================================================= */
        const [[diocese]] = await mysql.execute(
            `SELECT id FROM dioceses WHERE user_id=?`,
            [req.user.id]
        );

        if (!diocese)
            return errorResponse(res, "Diocese not found", 404);

        /* =========================================================
           2️⃣ Fetch All Parish Payments Under This Diocese
        ========================================================= */
        const [payments] = await mysql.execute(
            `SELECT 
                dpp.id AS payment_id,
                dp.id AS parish_id,
                CONCAT(u.first_name, ' ', u.last_name) AS parish_name,
                p.name AS plan_name,
                dpp.amount,
                dpp.payment_method,
                dpp.status,
                dpp.stripe_subscription_id,
                dpp.created_at
             FROM diocesan_parish_payments dpp
             INNER JOIN diocesan_parishes dp 
                 ON dpp.parish_id = dp.id
             INNER JOIN users u
                 ON dp.user_id = u.id
             LEFT JOIN plans p 
                 ON dpp.plan_id = p.id
             WHERE dpp.diocese_id = ?
             ORDER BY dpp.created_at DESC`,
            [diocese.id]
        );


        return successResponse(res, payments);

    } catch (err) {
        console.error("Get Diocese Payments Error:", err);
        return errorResponse(res, "Failed to fetch diocese payments", 500);
    }
});


module.exports = router;