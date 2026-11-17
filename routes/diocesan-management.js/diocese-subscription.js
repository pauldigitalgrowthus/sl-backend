const express = require("express");
const { auth } = require("../../middleware/auth");
const { getMySQLConnection } = require("../../config/mysql");
const { successResponse, errorResponse } = require("../../utils/response");

const router = express.Router();


router.get("/renewal/check", auth, async (req, res) => {
    try {
        if (!req.user.is_diocesan) {
            return errorResponse(res, "Only Diocese allowed", 403);
        }

        const mysql = getMySQLConnection();

        const [[diocese]] = await mysql.execute(
            `SELECT id, total_parishes FROM dioceses WHERE user_id = ?`,
            [req.user.id]
        );

        if (!diocese) return errorResponse(res, "Diocese not found", 404);

        const [activeCommunities] = await mysql.execute(
            `SELECT COUNT(*) as count
         FROM diocesan_communities
         WHERE diocese_id = ?
         AND participation_status = 'active'`,
            [diocese.id]
        );

        const minimumRequired = Math.ceil(diocese.total_parishes * 0.20);

        return successResponse(res, {
            total_parishes: diocese.total_parishes,
            minimum_required: minimumRequired,
            current_active: activeCommunities[0].count,
            eligible_for_renewal:
                activeCommunities[0].count >= minimumRequired,
        });

    } catch (err) {
        return errorResponse(res, err.message, 500);
    }
});


router.put("/community/:id/toggle", auth, async (req, res) => {
    try {
        if (!req.user.is_diocesan)
            return errorResponse(res, "Unauthorized", 403);

        const { action } = req.body;
        const communityId = req.params.id;

        const mysql = getMySQLConnection();

        const [[diocese]] = await mysql.execute(
            `SELECT id, subscription_end_date FROM dioceses WHERE user_id = ?`,
            [req.user.id]
        );

        if (!diocese) return errorResponse(res, "Diocese not found", 404);

        if (action === "remove") {
            await mysql.execute(
                `UPDATE diocesan_communities
           SET participation_status = 'pending_removal',
               effective_removal_at = ?
           WHERE id = ? AND diocese_id = ?`,
                [diocese.subscription_end_date, communityId, diocese.id]
            );
        }

        if (action === "activate") {
            await mysql.execute(
                `UPDATE diocesan_communities
           SET participation_status = 'active',
               effective_removal_at = NULL
           WHERE id = ? AND diocese_id = ?`,
                [communityId, diocese.id]
            );
        }

        return successResponse(res, null, "Community status updated");

    } catch (err) {
        return errorResponse(res, err.message, 500);
    }
});



router.post("/renew", auth, async (req, res) => {
    try {
        if (!req.user.is_diocesan)
            return errorResponse(res, "Unauthorized", 403);

        const mysql = getMySQLConnection();

        const [[diocese]] = await mysql.execute(
            `SELECT id, total_parishes, subscription_end_date
         FROM dioceses WHERE user_id = ?`,
            [req.user.id]
        );

        if (!diocese) return errorResponse(res, "Diocese not found", 404);

        const [activeCommunities] = await mysql.execute(
            `SELECT COUNT(*) as count
         FROM diocesan_communities
         WHERE diocese_id = ?
         AND participation_status = 'active'`,
            [diocese.id]
        );

        const minimumRequired = Math.ceil(diocese.total_parishes * 0.20);

        if (activeCommunities[0].count < minimumRequired) {
            return errorResponse(
                res,
                "20% participation rule not satisfied",
                400
            );
        }

        const newStart = new Date(diocese.subscription_end_date);
        newStart.setDate(newStart.getDate() + 1);

        const newEnd = new Date(newStart);
        newEnd.setFullYear(newEnd.getFullYear() + 1);

        await mysql.execute(
            `UPDATE dioceses
         SET subscription_start_date = ?,
             subscription_end_date = ?,
             subscription_status = 'active',
             grace_until = NULL
         WHERE id = ?`,
            [newStart, newEnd, diocese.id]
        );

        return successResponse(res, null, "Renewed successfully");

    } catch (err) {
        return errorResponse(res, err.message, 500);
    }
});


router.post("/system/process-expired", async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const today = new Date();

        const [expired] = await mysql.execute(
            `SELECT id, subscription_end_date
         FROM dioceses
         WHERE subscription_status = 'active'
         AND subscription_end_date < NOW()`
        );

        for (let d of expired) {
            const graceUntil = new Date(d.subscription_end_date);
            graceUntil.setDate(graceUntil.getDate() + 30);

            await mysql.execute(
                `UPDATE dioceses
           SET subscription_status = 'grace',
               grace_until = ?
           WHERE id = ?`,
                [graceUntil, d.id]
            );
        }

        return successResponse(res, null, "Grace processing done");

    } catch (err) {
        return errorResponse(res, err.message, 500);
    }
});


router.post("/request-cancellation", auth, async (req, res) => {
    try {
        if (!req.user.is_diocesan)
            return errorResponse(res, "Unauthorized", 403);

        const { reason } = req.body;

        if (!reason)
            return errorResponse(res, "Reason required", 400);

        const mysql = getMySQLConnection();

        await mysql.execute(
            `UPDATE dioceses
         SET cancellation_requested = TRUE,
             cancellation_reason = ?,
             cancellation_requested_at = NOW()
         WHERE user_id = ?`,
            [reason, req.user.id]
        );

        return successResponse(res, null, "Cancellation requested");

    } catch (err) {
        return errorResponse(res, err.message, 500);
    }
});



router.post("/community/add", auth, async (req, res) => {
    try {
        if (!req.user.is_diocesan)
            return errorResponse(res, "Unauthorized", 403);

        const { community_user_id } = req.body;

        const mysql = getMySQLConnection();

        const [[diocese]] = await mysql.execute(
            `SELECT id, subscription_end_date
         FROM dioceses WHERE user_id = ?`,
            [req.user.id]
        );

        const today = new Date();
        const endDate = new Date(diocese.subscription_end_date);

        const remainingDays = Math.ceil(
            (endDate - today) / (1000 * 60 * 60 * 24)
        );

        const dailyRate = 720 / 365;
        const proratedAmount = (remainingDays * dailyRate).toFixed(2);

        await mysql.execute(
            `INSERT INTO diocesan_communities
         (diocese_id, community_user_id, participation_status, aligned_end_date)
         VALUES (?, ?, 'active', ?)`,
            [diocese.id, community_user_id, diocese.subscription_end_date]
        );

        return successResponse(res, {
            prorated_amount: proratedAmount,
            remaining_days: remainingDays,
        });

    } catch (err) {
        return errorResponse(res, err.message, 500);
    }
});

module.exports = router;