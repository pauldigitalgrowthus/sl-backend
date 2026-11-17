/* ============================================================
   EDUCATOR NOTIFICATION SERVICE
   ------------------------------------------------------------
   The single entry point every educator-module controller uses
   to fire notifications. Usage from any controller:

       const {
           sendEducatorNotification,
           EDUCATOR_NOTIFICATION_EVENTS
       } = require("../../utils/notifications/educatorNotificationService");

       sendEducatorNotification({
           mysql,
           event: EDUCATOR_NOTIFICATION_EVENTS.COURSE_APPROVED,
           userId: course.educator_id,
           actorId: req.user.id,
           data: { courseTitle: course.course_title, notes },
           metadata: { course_id: courseId }
       });

   Design notes:
   - Never throws. Any failure (missing user, bad template, mailer
     down, etc.) is logged and swallowed so a notification problem
     can never break the API response of the action that triggered it.
   - Always call this AFTER the main DB write(s) for the action have
     already succeeded - never await it before responding to the client.
   - Looks up the recipient's email/name itself, so callers only ever
     need to pass a userId.
============================================================ */

const { dispatchNotification } = require("./notificationDispatcher");
const { EDUCATOR_NOTIFICATION_EVENTS } = require("./educatorNotificationEvents");
const { educatorNotificationMessages } = require("./educatorNotificationMessages");
const { educatorEmailTemplates } = require("./educatorEmailTemplates");

/* ============================================================
   HELPER: Fetch minimal recipient contact info
============================================================ */
const getRecipient = async (mysql, userId) => {
    const [[user]] = await mysql.execute(
        `SELECT id, email, first_name, last_name FROM users WHERE id = ? LIMIT 1`,
        [userId]
    );
    return user || null;
};

/* ============================================================
   sendEducatorNotification
   ------------------------------------------------------------
   @param {Object}  options
   @param {Object}  options.mysql      Active MySQL connection (required)
   @param {String}  options.event      One of EDUCATOR_NOTIFICATION_EVENTS (required)
   @param {Number}  options.userId     Recipient user id (required)
   @param {Number}  [options.actorId]  User who triggered the action
   @param {Object}  [options.data]     Dynamic values for message/template
                                        (courseTitle, reason, notes, feedback,
                                        studentName, canResubmit, etc.)
   @param {Object}  [options.metadata] Extra metadata stored on the system
                                        notification (course_id, etc.)
   @param {Boolean} [options.skipEmail] When true, only the system
                                        notification is sent
============================================================ */
const sendEducatorNotification = async ({
    mysql,
    event,
    userId,
    actorId,
    data = {},
    metadata = {},
    skipEmail = false
}) => {
    try {
        if (!mysql || !userId || !event) {
            console.warn("Educator Notification: missing mysql, userId or event - skipping");
            return;
        }

        const buildMessage = educatorNotificationMessages[event];
        if (!buildMessage) {
            console.warn(`Educator Notification: no message registered for event "${event}"`);
            return;
        }

        const { title, body } = buildMessage(data);

        /* -------------------- Build email (optional) -------------------- */
        let email = null;

        if (!skipEmail) {
            const buildTemplate = educatorEmailTemplates[event];

            if (buildTemplate) {
                const recipient = await getRecipient(mysql, userId);

                if (recipient && recipient.email) {
                    const userName =
                        `${recipient.first_name || ""} ${recipient.last_name || ""}`.trim() || "User";

                    const tpl = buildTemplate({ userName, ...data });

                    email = {
                        to: recipient.email,
                        subject: tpl.subject,
                        html: tpl.html,
                        text: tpl.text
                    };
                }
            }
        }

        /* -------------------- Dispatch (email + system) -------------------- */
        await dispatchNotification({
            mysql,
            userId,
            actorId,
            title,
            body,
            metadata: { event, ...metadata },
            email
        });
    } catch (error) {
        console.warn(`Educator Notification: unexpected failure for event "${event}" - ${error.message}`);
    }
};

module.exports = {
    sendEducatorNotification,
    EDUCATOR_NOTIFICATION_EVENTS
};