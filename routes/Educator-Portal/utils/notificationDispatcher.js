/* ============================================================
   NOTIFICATION DISPATCHER
   ------------------------------------------------------------
   Single low-level entry point for firing BOTH:
     1) An email  (via the existing ../SendMailer -> sendEmail)
     2) A system / in-app notification
        (via the existing ../notificationUtils -> createAndDeliverNotification)

   This file intentionally does NOT re-implement mailing or
   in-app notification delivery - both already exist and work
   (see routes/subscriptions.js for the original usage pattern).
   It only centralizes the "call both, never let either failure
   break the caller's main flow" behavior so every controller in
   the codebase does it the same, safe way.
============================================================ */

const { sendEmail } = require("../../../utils/SendMailer");
const { createAndDeliverNotification } = require("../../../utils/notificationUtils");

/* ============================================================
   dispatchNotification
   ------------------------------------------------------------
   @param {Object}  options
   @param {Object}  options.mysql        Active MySQL connection
   @param {Number}  options.userId       Recipient user id
   @param {Number}  [options.actorId]    User who triggered the
                                          action (defaults to userId,
                                          matching existing pattern)
   @param {String}  options.title        System notification title
   @param {String}  options.body         System notification body
   @param {Object}  [options.metadata]   Extra metadata stored with
                                          the system notification
   @param {String}  [options.channel]    Notification channel
                                          (defaults to "inbox")
   @param {Object}  [options.email]      { to, subject, html, text }
                                          Omit to skip sending an email.
   ------------------------------------------------------------
   Never throws - a failure in either the email or the system
   notification is logged and swallowed so it can never break
   the API response of the action that triggered it.
============================================================ */
const dispatchNotification = async ({
    mysql,
    userId,
    actorId,
    title,
    body,
    metadata = {},
    channel = "inbox",
    email = null
}) => {
    if (!mysql || !userId || !title || !body) {
        console.warn("Notification Dispatcher: missing required fields, skipping dispatch");
        return;
    }

    /* -------------------- SYSTEM / IN-APP NOTIFICATION -------------------- */
    try {
        await createAndDeliverNotification(
            {
                title,
                body,
                channel,
                metadata,
                target: {
                    type: "custom",
                    user_ids: [userId]
                }
            },
            actorId || userId,
            mysql
        );
    } catch (notificationError) {
        console.warn(
            `Notification Dispatcher: system notification failed for user ${userId} - ${notificationError.message}`
        );
    }

    /* -------------------------------- EMAIL -------------------------------- */
    if (email && email.to) {
        try {
            await sendEmail({
                to: email.to,
                subject: email.subject,
                html: email.html,
                text: email.text
            });
        } catch (emailError) {
            console.warn(
                `Notification Dispatcher: email failed for ${email.to} - ${emailError.message}`
            );
        }
    }
};

module.exports = { dispatchNotification };