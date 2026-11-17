/* ============================================================
   EDUCATOR NOTIFICATION EVENTS
   ------------------------------------------------------------
   Single source of truth for every educator-module notification
   "event key". Controllers reference these constants instead of
   hardcoding strings, and both the in-app message map
   (educatorNotificationMessages.js) and the email template map
   (templates/educatorEmailTemplates.js) key off the same values,
   so adding a new event only ever means adding one entry to each
   of those three files.
============================================================ */

const EDUCATOR_NOTIFICATION_EVENTS = Object.freeze({
    /* ---------------- Educator application ---------------- */
    APPLICATION_SUBMITTED: "educator_application_submitted",
    APPLICATION_APPROVED: "educator_application_approved",
    APPLICATION_REJECTED: "educator_application_rejected",

    /* ---------------- Gate 1: course proposal ---------------- */
    PROPOSAL_SUBMITTED: "course_proposal_submitted",
    PROPOSAL_APPROVED: "course_proposal_approved",
    PROPOSAL_REJECTED: "course_proposal_rejected",

    /* ---------------- Gate 2: full course review ---------------- */
    COURSE_SUBMITTED_FOR_REVIEW: "course_submitted_for_review",
    COURSE_APPROVED: "course_approved",
    COURSE_REJECTED: "course_rejected",
    COURSE_REVISION_REQUESTED: "course_revision_requested",
    COURSE_PUBLISHED: "course_published",
    COURSE_REVIEW_COMMENT_ADDED: "course_review_comment_added",

    /* ---------------- Enrollments (educator receives) ---------------- */
    NEW_STUDENT_ENROLLED: "new_student_enrolled",
    NEW_PAID_ENROLLMENT: "new_paid_enrollment",

    /* ---------------- Enrollments (student receives) ---------------- */
    STUDENT_ENROLLMENT_CONFIRMED: "student_enrollment_confirmed",
    STUDENT_PAID_ENROLLMENT_CONFIRMED: "student_paid_enrollment_confirmed"
});

module.exports = { EDUCATOR_NOTIFICATION_EVENTS };