const express = require('express');
const { getMySQLConnection } = require('../config/mysql');
const { auth } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');

const router = express.Router();


// ================= GET MY EARNINGS =================
// @route   GET /api/composer-earnings/my
// @desc    Get logged-in composer earnings summary (with optional date filter) 
// @access  Private (Composer)
router.get('/my', auth, async (req, res) => {
    try {
        const db = getMySQLConnection();
        const composerId = req.user.id;
        const { from, to } = req.query;

        let dateFilter = '';
        let params = [composerId];

        // ✅ Apply filter if provided
        if (from && to) {
            dateFilter = `AND DATE(paid_at) BETWEEN ? AND ?`;
            params.push(from, to);
        }

        // ================= TOTAL EARNING =================
        const [[total]] = await db.execute(`
            SELECT 
                SUM(composer_earning) as totalEarning,
                COUNT(*) as totalSales
            FROM composer_earnings
            WHERE composer_id = ? 
              AND status = 'paid'
              ${dateFilter}
        `, params);

        // ================= MONTHLY =================
        const [monthly] = await db.execute(`
            SELECT 
                DATE_FORMAT(paid_at, '%Y-%m') as month,
                SUM(composer_earning) as total
            FROM composer_earnings
            WHERE composer_id = ? 
              AND status = 'paid'
              ${dateFilter}
            GROUP BY month
            ORDER BY month DESC
        `, params);

        // ================= SONG WISE =================
        const [songs] = await db.execute(`
            SELECT 
                music_publication_id,
                composition_title,
                COUNT(*) as totalPurchases,
                SUM(composer_earning) as totalEarning
            FROM composer_earnings
            WHERE composer_id = ? 
              AND status = 'paid'
              ${dateFilter}
            GROUP BY music_publication_id
            ORDER BY totalPurchases DESC
        `, params);

        return successResponse(res, {
            totalEarning: total.totalEarning || 0,
            totalSales: total.totalSales || 0,
            monthly,
            songs,
            filterApplied: !!(from && to),
            from: from || null,
            to: to || null
        }, 'Composer earnings fetched successfully');

    } catch (err) {
        console.error(err);
        return errorResponse(res, 'Error fetching earnings');
    }
});


// ================= GET SONG EARNING HISTORY =================
// @route   GET /api/composer-earnings/song/:id
// @desc    Get earning history of a specific song 
// @access  Private (Composer)
router.get('/song/:id', auth, async (req, res) => {
    try {
        const db = getMySQLConnection();
        const composerId = req.user.id;
        const songId = req.params.id;

        const [history] = await db.execute(`
            SELECT 
                ce.*,
                u.email as buyer_email
            FROM composer_earnings ce
            LEFT JOIN users u ON ce.buyer_user_id = u.id
            WHERE ce.composer_id = ? 
              AND ce.music_publication_id = ?
              AND ce.status = 'paid'
            ORDER BY ce.paid_at DESC
        `, [composerId, songId]);

        return successResponse(res, history, 'Song earning history fetched');

    } catch (err) {
        console.error(err);
        return errorResponse(res, 'Error fetching song history');
    }
});


// ================= ADMIN ANALYTICS =================
// @route   GET /api/composer-earnings/admin/earnings
// @desc    Get platform earnings analytics (with filters) 
// @access  Private (Admin)
router.get('/admin/earnings', auth, async (req, res) => {
    try {
        const db = getMySQLConnection();

        const { from, to, composer_id, music_publication_id, status } = req.query;

        let conditions = [];
        let params = [];

        // Default status
        if (status) {
            conditions.push(`status = ?`);
            params.push(status);
        } else {
            conditions.push(`status = 'paid'`);
        }

        // Date filter
        if (from && to) {
            conditions.push(`DATE(paid_at) BETWEEN ? AND ?`);
            params.push(from, to);
        }

        // Composer filter
        if (composer_id) {
            conditions.push(`composer_id = ?`);
            params.push(composer_id);
        }

        // Song filter
        if (music_publication_id) {
            conditions.push(`music_publication_id = ?`);
            params.push(music_publication_id);
        }

        const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        // ================= TOTAL =================
        const [[total]] = await db.execute(`
            SELECT 
                SUM(composer_earning) as totalEarning,
                COUNT(*) as totalSales
            FROM composer_earnings
            ${whereClause}
        `, params);

        // ================= MONTHLY =================
        const [monthly] = await db.execute(`
            SELECT 
                DATE_FORMAT(paid_at, '%Y-%m') as month,
                SUM(composer_earning) as total
            FROM composer_earnings
            ${whereClause}
            GROUP BY month
            ORDER BY month DESC
        `, params);

        // ================= TRENDING SONGS =================
        const [trending] = await db.execute(`
            SELECT 
                music_publication_id,
                composition_title,
                COUNT(*) as purchases,
                SUM(composer_earning) as earning
            FROM composer_earnings
            ${whereClause}
            GROUP BY music_publication_id
            ORDER BY purchases DESC
            LIMIT 10
        `, params);

        // ================= RECENT =================
        const [recent] = await db.execute(`
            SELECT *
            FROM composer_earnings
            ${whereClause}
            ORDER BY paid_at DESC
            LIMIT 20
        `, params);

        return successResponse(res, {
            total: {
                totalEarning: total.totalEarning || 0,
                totalSales: total.totalSales || 0
            },
            monthly,
            trending,
            recent,
            filters: {
                from: from || null,
                to: to || null,
                composer_id: composer_id || null,
                music_publication_id: music_publication_id || null,
                status: status || 'paid'
            }
        }, 'Admin analytics fetched');

    } catch (err) {
        console.error(err);
        return errorResponse(res, 'Admin analytics error');
    }
});


// ================= FILTER EARNINGS =================
// @route   GET /api/composer-earnings/filter
// @desc    Filter earnings by date range
// @access  Private (Composer)
router.get('/filter', auth, async (req, res) => {
    try {
        const db = getMySQLConnection();
        const composerId = req.user.id;
        const { from, to } = req.query;

        const [data] = await db.execute(`
            SELECT 
                DATE(paid_at) as date,
                SUM(composer_earning) as total
            FROM composer_earnings
            WHERE composer_id = ?
              AND status = 'paid'
              AND DATE(paid_at) BETWEEN ? AND ?
            GROUP BY date
            ORDER BY date ASC
        `, [composerId, from, to]);

        return successResponse(res, data, 'Filtered earnings fetched');

    } catch (err) {
        console.error(err);
        return errorResponse(res, 'Filter error');
    }
});

module.exports = router;