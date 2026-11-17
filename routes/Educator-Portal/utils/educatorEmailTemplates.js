// utils/notifications/templates/educatorEmailTemplates.js
/**
 * Educator module email templates.
 * Same "simple & clean, inbox friendly" style as
 * utils/subscriptionsEmailtemplate.js - no heavy CSS, plain HTML.
 *
 * Every template is built on top of one shared base layout
 * (baseEducatorEmail) so wording changes / rebranding only ever
 * happen in one place. Each exported builder takes plain
 * parameters and returns { subject, html, text }.
 */

const { EDUCATOR_NOTIFICATION_EVENTS } = require("./educatorNotificationEvents");

const FRONTEND_URL = process.env.FRONTEND_URL || "";
const SUPPORT_MAIL = process.env.SUPPORT_MAIL || "";

/* ============================================================
   SHARED BASE LAYOUT
============================================================ */
const baseEducatorEmail = ({ userName = "User", heading, message, ctaText, ctaLink }) => {
    const html = `
  <div style="font-family: Arial, Helvetica, sans-serif; font-size:14px; line-height:1.6; color:#222;">
    <p>Hi ${userName},</p>

    <p><strong>${heading}</strong></p>

    <p>${message}</p>

    ${ctaLink
            ? `<p><a href="${ctaLink}">${ctaText || "View details"}</a></p>`
            : ""
        }

    <p>
      If you have any questions, contact <a href="mailto:${SUPPORT_MAIL}">${SUPPORT_MAIL}</a>.
    </p>

    <p>God bless,<br/>— Simply Liturgical Team</p>
  </div>
  `;

    const text = `
Hi ${userName},

${heading}

${message}
${ctaLink ? `\n${ctaText || "View details"}: ${ctaLink}\n` : ""}
If you have any questions, contact ${SUPPORT_MAIL}.

God bless,
— Simply Liturgical Team
  `.trim();

    return { html, text };
};

/* ============================================================
   EVENT -> EMAIL TEMPLATE MAP
============================================================ */
const educatorEmailTemplates = {

    /* ---------------- Educator application ---------------- */
    [EDUCATOR_NOTIFICATION_EVENTS.APPLICATION_SUBMITTED]: ({ userName }) => {
        const { html, text } = baseEducatorEmail({
            userName,
            heading: "Educator Application Received",
            message: "Thank you for applying to become an educator with Simply Liturgical. Our team will review your application and let you know the outcome soon.",
            ctaText: "View Application Status",
            ctaLink: `${FRONTEND_URL}/educator/application`
        });
        return { subject: "Educator Application Submitted", html, text };
    },

    [EDUCATOR_NOTIFICATION_EVENTS.APPLICATION_APPROVED]: ({ userName }) => {
        const { html, text } = baseEducatorEmail({
            userName,
            heading: "Your Educator Application Was Approved",
            message: "Congratulations! You are now an approved Simply Liturgical educator. You can start proposing and building courses right away.",
            // ctaText: "Go to Educator Dashboard",
            // ctaLink: `${FRONTEND_URL}/educator`
        });
        return { subject: "Educator Application Approved", html, text };
    },

    [EDUCATOR_NOTIFICATION_EVENTS.APPLICATION_REJECTED]: ({ userName, reason }) => {
        const { html, text } = baseEducatorEmail({
            userName,
            heading: "Update on Your Educator Application",
            message: `We appreciate your interest in becoming a Simply Liturgical educator. Unfortunately, your application was not approved at this time.${reason ? ` Reason: ${reason}` : ""}`,
            ctaText: "View Application",
            ctaLink: `${FRONTEND_URL}/educator/application`
        });
        return { subject: "Educator Application Update", html, text };
    },

    /* ---------------- Gate 1: course proposal ---------------- */
    [EDUCATOR_NOTIFICATION_EVENTS.PROPOSAL_SUBMITTED]: ({ userName, courseTitle }) => {
        const { html, text } = baseEducatorEmail({
            userName,
            heading: "Course Proposal Submitted",
            message: `Your course proposal "${courseTitle}" has been submitted successfully and sent to the SL Team for review.`,
            ctaText: "View Proposal",
            ctaLink: `${FRONTEND_URL}/course-publication`
        });
        return { subject: `Course Proposal Submitted - ${courseTitle}`, html, text };
    },

    [EDUCATOR_NOTIFICATION_EVENTS.PROPOSAL_APPROVED]: ({ userName, courseTitle, notes }) => {
        const { html, text } = baseEducatorEmail({
            userName,
            heading: "Course Proposal Approved",
            message: `Great news! Your course proposal "${courseTitle}" has been approved. You can now start building the full course.${notes ? ` Note from SL Team: ${notes}` : ""}`,
            ctaText: "Start Building Your Course",
            ctaLink: `${FRONTEND_URL}/course-publication`
        });
        return { subject: `Course Proposal Approved - ${courseTitle}`, html, text };
    },

    [EDUCATOR_NOTIFICATION_EVENTS.PROPOSAL_REJECTED]: ({ userName, courseTitle, reason, canResubmit }) => {
        const { html, text } = baseEducatorEmail({
            userName,
            heading: "Course Proposal Not Approved",
            message: `Your course proposal "${courseTitle}" was not approved. Reason: ${reason}.${canResubmit ? " You are welcome to revise the proposal and resubmit it." : ""}`,
            ctaText: "View Feedback",
            ctaLink: `${FRONTEND_URL}/course-publication`
        });
        return { subject: `Course Proposal Update - ${courseTitle}`, html, text };
    },

    /* ---------------- Gate 2: full course review ---------------- */
    [EDUCATOR_NOTIFICATION_EVENTS.COURSE_SUBMITTED_FOR_REVIEW]: ({ userName, courseTitle }) => {
        const { html, text } = baseEducatorEmail({
            userName,
            heading: "Course Submitted for Review",
            message: `Your course "${courseTitle}" has been submitted for review. The SL Team will get back to you soon.`,
            ctaText: "View Course",
            ctaLink: `${FRONTEND_URL}/course-publication`
        });
        return { subject: `Course Submitted for Review - ${courseTitle}`, html, text };
    },

    [EDUCATOR_NOTIFICATION_EVENTS.COURSE_APPROVED]: ({ userName, courseTitle, notes }) => {
        const { html, text } = baseEducatorEmail({
            userName,
            heading: "Course Approved",
            message: `Your course "${courseTitle}" passed final review and is ready to be published.${notes ? ` Note from SL Team: ${notes}` : ""}`,
            ctaText: "View Course",
            ctaLink: `${FRONTEND_URL}/course-publication`
        });
        return { subject: `Course Approved - ${courseTitle}`, html, text };
    },

    [EDUCATOR_NOTIFICATION_EVENTS.COURSE_REJECTED]: ({ userName, courseTitle, reason }) => {
        const { html, text } = baseEducatorEmail({
            userName,
            heading: "Course Not Approved",
            message: `Your course "${courseTitle}" was rejected during final review. Reason: ${reason}`,
            ctaText: "View Feedback",
            ctaLink: `${FRONTEND_URL}/course-publication`
        });
        return { subject: `Course Not Approved - ${courseTitle}`, html, text };
    },

    [EDUCATOR_NOTIFICATION_EVENTS.COURSE_REVISION_REQUESTED]: ({ userName, courseTitle, feedback }) => {
        const { html, text } = baseEducatorEmail({
            userName,
            heading: "Revisions Requested",
            message: `The SL Team has requested changes on your course "${courseTitle}" before it can move forward. Feedback: ${feedback}`,
            ctaText: "View Feedback",
            ctaLink: `${FRONTEND_URL}/course-publication`
        });
        return { subject: `Revisions Requested - ${courseTitle}`, html, text };
    },

    [EDUCATOR_NOTIFICATION_EVENTS.COURSE_PUBLISHED]: ({ userName, courseTitle }) => {
        const { html, text } = baseEducatorEmail({
            userName,
            heading: "Your Course Is Live",
            message: `Your course "${courseTitle}" has been published and is now visible to students on Simply Liturgical.`,
            ctaText: "View Live Course",
            ctaLink: `${FRONTEND_URL}/course-publication`
        });
        return { subject: `Course Published - ${courseTitle}`, html, text };
    },

    [EDUCATOR_NOTIFICATION_EVENTS.COURSE_REVIEW_COMMENT_ADDED]: ({ userName, courseTitle, commenterName }) => {
        const { html, text } = baseEducatorEmail({
            userName,
            heading: "New Review Comment",
            message: `${commenterName || "A reviewer"} left a new comment on your course "${courseTitle}".`,
            ctaText: "View Comment",
            ctaLink: `${FRONTEND_URL}/course-publication`
        });
        return { subject: `New Review Comment - ${courseTitle}`, html, text };
    },

    /* ---------------- Enrollments (educator receives) ---------------- */
    [EDUCATOR_NOTIFICATION_EVENTS.NEW_STUDENT_ENROLLED]: ({ userName, courseTitle, studentName }) => {
        const { html, text } = baseEducatorEmail({
            userName,
            heading: "New Student Enrollment",
            message: `${studentName || "A student"} just enrolled in your course "${courseTitle}".`,
            ctaText: "View Enrolled Students",
            ctaLink: `${FRONTEND_URL}/course-publication`
        });
        return { subject: `New Student Enrolled - ${courseTitle}`, html, text };
    },

    [EDUCATOR_NOTIFICATION_EVENTS.NEW_PAID_ENROLLMENT]: ({ userName, courseTitle, studentName }) => {
        const { html, text } = baseEducatorEmail({
            userName,
            heading: "New Paid Enrollment",
            message: `${studentName || "A student"} just purchased your course "${courseTitle}".`,
            ctaText: "View Enrolled Students",
            ctaLink: `${FRONTEND_URL}/course-publication`
        });
        return { subject: `New Paid Enrollment - ${courseTitle}`, html, text };
    },

    /* ---------------- Enrollments (student receives) ---------------- */
    [EDUCATOR_NOTIFICATION_EVENTS.STUDENT_ENROLLMENT_CONFIRMED]: ({ userName, courseTitle }) => {
        const { html, text } = baseEducatorEmail({
            userName,
            heading: "Enrollment Confirmed",
            message: `You have successfully enrolled in "${courseTitle}". You can start learning right away.`,
            ctaText: "Start Learning",
            ctaLink: `${FRONTEND_URL}/browse-course`
        });
        return { subject: `Enrollment Confirmed - ${courseTitle}`, html, text };
    },

    [EDUCATOR_NOTIFICATION_EVENTS.STUDENT_PAID_ENROLLMENT_CONFIRMED]: ({ userName, courseTitle }) => {
        const { html, text } = baseEducatorEmail({
            userName,
            heading: "Purchase Successful",
            message: `Your payment was successful and you are now enrolled in "${courseTitle}". You can start learning right away.`,
            ctaText: "Start Learning",
            ctaLink: `${FRONTEND_URL}/browse-course`
        });
        return { subject: `Purchase Successful - ${courseTitle}`, html, text };
    }
};

module.exports = { educatorEmailTemplates };