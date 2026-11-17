const cron = require("node-cron");
const { getMySQLConnection } = require("../config/mysql");
const { sendEmail } = require("./SendMailer");
const { createAndDeliverNotification } = require("./notificationUtils");
const {
    subscriptionExpiringSoonTemplate,
    subscriptionExpiredTemplate
} = require("./subscriptionsEmailtemplate");

/* ============================================================
   CONFIG
   ------------------------------------------------------------
   - Runs once a day at 11:30 AM (server local time by default).
   - Override via env if needed:
       SUBSCRIPTION_CRON_TIME  -> cron expression, default "30 11 * * *"
       SUBSCRIPTION_CRON_TZ    -> IANA timezone, default "Asia/Kolkata"
============================================================ */
const CRON_TIME = process.env.SUBSCRIPTION_CRON_TIME || "30 11 * * *";
const CRON_TZ = process.env.SUBSCRIPTION_CRON_TZ || "Asia/Kolkata";

/* ============================================================
   NOTE: The de-dupe / history log table (subscription_expiry_reminders)
   is created at app startup by config/mysql.js
   (createSubscriptionExpiryRemindersTable, called from
   initializeTables). It tracks WHO was emailed, WHICH reminder
   (30_day / 7_day / expired), WHEN, and whether it succeeded —
   see GET /api/subscriptions/admin/expiry-reminder-logs.
============================================================ */

/* ============================================================
   HELPER: Send the "expiring soon" reminder for one milestone
   ------------------------------------------------------------
   windowStartDays / windowEndDays -> a small tolerance window
   (e.g. 29–31 days out) so a missed cron run on the exact day
   still catches the reminder the next day, without ever
   double-sending thanks to the UNIQUE key above.
============================================================ */
const sendExpiryReminders = async (mysql, { reminderType, daysRemaining, windowStartDays, windowEndDays }) => {
    const [subs] = await mysql.execute(
        `SELECT
            s.id            AS subscription_id,
            s.user_id,
            s.end_date,
            p.name          AS plan_name,
            u.first_name,
            u.email
         FROM subscriptions s
         LEFT JOIN users u ON s.user_id = u.id
         LEFT JOIN plans p ON s.plan_id = p.id
         WHERE s.status = 'active'
           AND s.end_date IS NOT NULL
           AND s.end_date BETWEEN DATE_ADD(NOW(), INTERVAL ? DAY) AND DATE_ADD(NOW(), INTERVAL ? DAY)`,
        [windowStartDays, windowEndDays]
    );

    let sentCount = 0;

    for (const sub of subs) {
        if (!sub.email) continue;

        try {
            // Atomic de-dupe: if this (subscription_id, reminder_type) row
            // already exists, this INSERT is a no-op and we skip sending.
            const [result] = await mysql.execute(
                `INSERT IGNORE INTO subscription_expiry_reminders
                    (subscription_id, user_id, email, plan_name, reminder_type, status)
                 VALUES (?, ?, ?, ?, ?, 'sent')`,
                [sub.subscription_id, sub.user_id, sub.email, sub.plan_name || null, reminderType]
            );

            if (result.affectedRows === 0) continue; // already sent before (logged in this table)

            const emailData = subscriptionExpiringSoonTemplate({
                firstName: sub.first_name || "User",
                planName: sub.plan_name || "Subscription",
                expiryDate: sub.end_date,
                daysRemaining
            });

            const mailResult = await sendEmail({
                to: sub.email,
                subject: emailData.subject,
                html: emailData.html,
                text: emailData.text
            });

            if (!mailResult.success) {
                // Keep the log row (so we don't retry forever on a bad
                // address) but mark it failed with the reason, visible
                // via GET /api/subscriptions/admin/expiry-reminder-logs
                await mysql.execute(
                    `UPDATE subscription_expiry_reminders
                     SET status = 'failed', error_message = ?
                     WHERE subscription_id = ? AND reminder_type = ?`,
                    [mailResult.error || "Unknown email error", sub.subscription_id, reminderType]
                );
                console.warn(`⚠️ ${reminderType} reminder email failed for user ${sub.user_id}:`, mailResult.error);
                continue;
            }

            await createAndDeliverNotification(
                {
                    title: "Subscription Expiring Soon",
                    body: `Your subscription (${sub.plan_name || "Subscription"}) will expire in ${daysRemaining >= 28 ? "1 month" : "1 week"}.`,
                    channel: "inbox",
                    metadata: {
                        action: "subscription_expiring_soon",
                        reminder_type: reminderType,
                        subscription_id: sub.subscription_id
                    },
                    target: { type: "custom", user_ids: [sub.user_id] }
                },
                sub.user_id,
                mysql
            );

            sentCount++;
        } catch (err) {
            console.warn(`⚠️ Failed to send ${reminderType} reminder to user ${sub.user_id}:`, err.message);
        }
    }

    console.log(`📧 [Subscription Cron] ${reminderType} reminders sent: ${sentCount}/${subs.length}`);
    return sentCount;
};

/* ============================================================
   HELPER: Expire subscriptions whose end_date has passed and
   downgrade the affected users to the FREE plan (permissions
   included), same behaviour as the existing self-expire /
   admin-expire routes in routes/subscriptions.js.
============================================================ */
const processExpiredSubscriptions = async (mysql) => {
    // Lazily require here (not at top) to avoid a require cycle,
    // since routes/subscriptions.js also requires config/mysql.
    const subscriptionsRouter = require("../routes/subscriptions");
    const applyFreePlanPermissionsToUser = subscriptionsRouter.applyFreePlanPermissionsToUser;

    const [expiredSubs] = await mysql.execute(
        `SELECT
            s.id            AS subscription_id,
            s.user_id,
            s.end_date,
            p.name          AS plan_name,
            u.first_name,
            u.email
         FROM subscriptions s
         LEFT JOIN users u ON s.user_id = u.id
         LEFT JOIN plans p ON s.plan_id = p.id
         WHERE s.status = 'active'
           AND s.end_date IS NOT NULL
           AND s.end_date < NOW()`
    );

    if (expiredSubs.length === 0) {
        console.log("📭 [Subscription Cron] No expired subscriptions found");
        return 0;
    }

    let expiredCount = 0;

    for (const sub of expiredSubs) {
        try {
            // Mark this specific subscription row expired
            await mysql.execute(
                `UPDATE subscriptions SET status = 'expired', updated_at = NOW() WHERE id = ?`,
                [sub.subscription_id]
            );

            // Only downgrade the user if they have no OTHER still-active
            // subscription (mirrors the safeguard already used in the
            // GET /api/subscriptions/get auto-expire block).
            const [[stillActive]] = await mysql.execute(
                `SELECT id FROM subscriptions WHERE user_id = ? AND status = 'active' LIMIT 1`,
                [sub.user_id]
            );

            if (!stillActive) {
                await applyFreePlanPermissionsToUser(mysql, sub.user_id);
            }

            if (sub.email) {
                // Same de-dupe pattern as the reminder emails above, so this
                // also shows up in the shared history log with type 'expired'.
                const [logResult] = await mysql.execute(
                    `INSERT IGNORE INTO subscription_expiry_reminders
                        (subscription_id, user_id, email, plan_name, reminder_type, status)
                     VALUES (?, ?, ?, ?, 'expired', 'sent')`,
                    [sub.subscription_id, sub.user_id, sub.email, sub.plan_name || null]
                );

                if (logResult.affectedRows > 0) {
                    const emailData = subscriptionExpiredTemplate({
                        firstName: sub.first_name || "User",
                        planName: sub.plan_name || "Subscription",
                        expiryDate: sub.end_date
                    });

                    const mailResult = await sendEmail({
                        to: sub.email,
                        subject: emailData.subject,
                        html: emailData.html,
                        text: emailData.text
                    });

                    if (!mailResult.success) {
                        await mysql.execute(
                            `UPDATE subscription_expiry_reminders
                             SET status = 'failed', error_message = ?
                             WHERE subscription_id = ? AND reminder_type = 'expired'`,
                            [mailResult.error || "Unknown email error", sub.subscription_id]
                        );
                        console.warn(`⚠️ Expired-plan email failed for user ${sub.user_id}:`, mailResult.error);
                    }
                }
            }

            await createAndDeliverNotification(
                {
                    title: "Subscription Expired",
                    body: "Your subscription has expired and your account is now on the Free plan.",
                    channel: "inbox",
                    metadata: {
                        action: "subscription_expired",
                        plan: "free-account",
                        subscription_id: sub.subscription_id
                    },
                    target: { type: "custom", user_ids: [sub.user_id] }
                },
                sub.user_id,
                mysql
            );

            expiredCount++;
        } catch (err) {
            console.warn(`⚠️ Failed to process expiry for user ${sub.user_id}:`, err.message);
        }
    }

    console.log(`⏳ [Subscription Cron] Expired & downgraded: ${expiredCount}/${expiredSubs.length}`);
    return expiredCount;
};

/* ============================================================
   MAIN JOB — runs all three checks in sequence, once a day.
   Exported separately so it can also be triggered manually
   (e.g. an admin "run now" endpoint, or for testing).
============================================================ */
const runSubscriptionExpiryJob = async () => {
    const startedAt = new Date();
    console.log(`\n🕧 [Subscription Cron] Starting daily check @ ${startedAt.toISOString()}`);

    try {
        const mysql = getMySQLConnection();

        const results = {
            reminders_30_day: await sendExpiryReminders(mysql, {
                reminderType: "30_day",
                daysRemaining: 30,
                windowStartDays: 29,
                windowEndDays: 31
            }),
            reminders_7_day: await sendExpiryReminders(mysql, {
                reminderType: "7_day",
                daysRemaining: 7,
                windowStartDays: 6,
                windowEndDays: 8
            }),
            expired_and_downgraded: await processExpiredSubscriptions(mysql)
        };

        console.log(`✅ [Subscription Cron] Done in ${Date.now() - startedAt.getTime()}ms`, results);
        return results;
    } catch (error) {
        console.error("❌ [Subscription Cron] Job failed:", error);
        throw error;
    }
};

/* ============================================================
   INIT — call this once from server.js after connectMySQL()
============================================================ */
let scheduledTask = null;

const initSubscriptionCronJobs = () => {
    if (scheduledTask) {
        console.log("⚠️ Subscription cron job already scheduled, skipping re-init");
        return scheduledTask;
    }

    scheduledTask = cron.schedule(
        CRON_TIME,
        () => {
            runSubscriptionExpiryJob().catch((err) =>
                console.error("❌ [Subscription Cron] Unhandled job error:", err)
            );
        },
        { timezone: CRON_TZ }
    );

    console.log(`⏰ Subscription expiry cron scheduled: "${CRON_TIME}" (${CRON_TZ})`);
    return scheduledTask;
};

module.exports = {
    initSubscriptionCronJobs,
    runSubscriptionExpiryJob
};
