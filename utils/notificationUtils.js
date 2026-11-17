const { getMySQLConnection } = require('../config/mysql');

async function createAndDeliverNotification(payload, reqUserId = null, db = null) {
    let conn = null;
    let shouldRelease = false;

    if (!payload || !payload.title) {
        throw new Error('Notification payload with title is required');
    }

    const chunkSize = Number(payload.chunkSize) || 500;

    try {
        /* ===========================
           RESOLVE CONNECTION CORRECTLY
        =========================== */

        if (db) {
            // 👉 If db is a POOL, get a connection
            if (typeof db.getConnection === 'function') {
                conn = await db.getConnection();
                shouldRelease = true;
            }
            // 👉 If db is already a CONNECTION
            else {
                conn = db;
            }
        } else {
            const pool = getMySQLConnection();
            conn = await pool.getConnection();
            shouldRelease = true;
        }

        /* ===========================
           START TRANSACTION
        =========================== */
        if (typeof conn.beginTransaction === 'function') {
            await conn.beginTransaction();
        }

        /* ===========================
           INSERT NOTIFICATION MASTER
        =========================== */
        const [notifRes] = await conn.execute(
            `INSERT INTO notifications
       (title, body, metadata, channel, created_by, target_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
            [
                payload.title,
                payload.body || null,
                payload.metadata ? JSON.stringify(payload.metadata) : null,
                payload.channel || 'inbox',
                reqUserId || null,
                payload.target?.type || 'all'
            ]
        );

        const notificationId = notifRes.insertId;
        const targetType = payload.target?.type || 'all';
        let deliveredCount = 0;

        /* ===========================
           INSERT RECIPIENTS
        =========================== */

        if (targetType === 'custom') {
            const userIds = Array.isArray(payload.target?.user_ids)
                ? [...new Set(payload.target.user_ids.map(Number).filter(Boolean))]
                : [];

            for (let i = 0; i < userIds.length; i += chunkSize) {
                const chunk = userIds.slice(i, i + chunkSize);
                const placeholders = chunk.map(() => '(?, ?)').join(', ');
                const params = [];

                chunk.forEach(uid => {
                    params.push(notificationId, uid);
                });

                const [res] = await conn.execute(
                    `INSERT IGNORE INTO user_notifications (notification_id, user_id)
           VALUES ${placeholders}`,
                    params
                );

                deliveredCount += res.affectedRows || 0;
            }
        } else if (targetType === 'all') {
            const [res] = await conn.execute(
                `INSERT IGNORE INTO user_notifications (notification_id, user_id)
         SELECT ?, id FROM users WHERE is_active = 1`,
                [notificationId]
            );
            deliveredCount = res.affectedRows || 0;
        } else {
            throw new Error(`Unsupported target type: ${targetType}`);
        }

        /* ===========================
           COMMIT
        =========================== */
        if (typeof conn.commit === 'function') {
            await conn.commit();
        }

        if (shouldRelease) conn.release();

        return { notificationId, deliveredTo: deliveredCount };

    } catch (err) {
        /* ===========================
           SAFE ROLLBACK
        =========================== */
        try {
            if (conn && typeof conn.rollback === 'function') {
                await conn.rollback();
            }
        } catch (rbErr) {
            console.error('Rollback failed in createAndDeliverNotification:', rbErr);
        }

        if (shouldRelease && conn) {
            try {
                conn.release();
            } catch { }
        }

        console.error('❌ createAndDeliverNotification failed:', err);
        throw err;
    }
}

module.exports = { createAndDeliverNotification };