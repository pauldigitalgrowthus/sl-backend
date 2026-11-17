/* ============================================================
   EDUCATOR NOTIFICATION MESSAGES
   ------------------------------------------------------------
   In-app / system notification content for every educator event.
   Each entry is a small function so the title/body can be built
   dynamically from the data passed by the controller (course
   title, reason, feedback, etc.) instead of hardcoding strings
   inline in route files.
============================================================ */

const { EDUCATOR_NOTIFICATION_EVENTS } = require("./educatorNotificationEvents");

const educatorNotificationMessages = {

    /* ---------------- Educator application ---------------- */
    [EDUCATOR_NOTIFICATION_EVENTS.APPLICATION_SUBMITTED]: () => ({
        title: "Educator Application Submitted",
        body: "Your educator application has been submitted successfully. Our team will review it and get back to you soon."
    }),

    [EDUCATOR_NOTIFICATION_EVENTS.APPLICATION_APPROVED]: () => ({
        title: "Educator Application Approved",
        body: "Congratulations! Your educator application has been approved. You can now start creating courses."
    }),

    [EDUCATOR_NOTIFICATION_EVENTS.APPLICATION_REJECTED]: ({ reason } = {}) => ({
        title: "Educator Application Update",
        body: `Your educator application was not approved at this time.${reason ? ` Reason: ${reason}` : ""}`
    }),

    /* ---------------- Gate 1: course proposal ---------------- */
    [EDUCATOR_NOTIFICATION_EVENTS.PROPOSAL_SUBMITTED]: ({ courseTitle } = {}) => ({
        title: "Course Proposal Submitted",
        body: `Your course proposal "${courseTitle}" has been submitted and sent to the SL Team for review.`
    }),

    [EDUCATOR_NOTIFICATION_EVENTS.PROPOSAL_APPROVED]: ({ courseTitle, notes } = {}) => ({
        title: "Course Proposal Approved",
        body: `Your course proposal "${courseTitle}" has been approved. You can now start building the full course.${notes ? ` Note from SL Team: ${notes}` : ""}`
    }),

    [EDUCATOR_NOTIFICATION_EVENTS.PROPOSAL_REJECTED]: ({ courseTitle, reason, canResubmit } = {}) => ({
        title: "Course Proposal Not Approved",
        body: `Your course proposal "${courseTitle}" was not approved. Reason: ${reason}.${canResubmit ? " You are welcome to revise and resubmit." : ""}`
    }),

    /* ---------------- Gate 2: full course review ---------------- */
    [EDUCATOR_NOTIFICATION_EVENTS.COURSE_SUBMITTED_FOR_REVIEW]: ({ courseTitle } = {}) => ({
        title: "Course Submitted for Review",
        body: `Your course "${courseTitle}" has been submitted for review. The SL Team will get back to you soon.`
    }),

    [EDUCATOR_NOTIFICATION_EVENTS.COURSE_APPROVED]: ({ courseTitle, notes } = {}) => ({
        title: "Course Approved",
        body: `Your course "${courseTitle}" passed final review and is ready to be published.${notes ? ` Note from SL Team: ${notes}` : ""}`
    }),

    [EDUCATOR_NOTIFICATION_EVENTS.COURSE_REJECTED]: ({ courseTitle, reason } = {}) => ({
        title: "Course Not Approved",
        body: `Your course "${courseTitle}" was rejected during final review. Reason: ${reason}`
    }),

    [EDUCATOR_NOTIFICATION_EVENTS.COURSE_REVISION_REQUESTED]: ({ courseTitle, feedback } = {}) => ({
        title: "Revisions Requested",
        body: `The SL Team has requested changes on "${courseTitle}": ${feedback}`
    }),

    [EDUCATOR_NOTIFICATION_EVENTS.COURSE_PUBLISHED]: ({ courseTitle } = {}) => ({
        title: "Course Published",
        body: `Your course "${courseTitle}" has been published and is now visible to students.`
    }),

    [EDUCATOR_NOTIFICATION_EVENTS.COURSE_REVIEW_COMMENT_ADDED]: ({ courseTitle, commenterName } = {}) => ({
        title: "New Review Comment",
        body: `${commenterName || "A reviewer"} left a new comment on your course "${courseTitle}".`
    }),

    /* ---------------- Enrollments (educator receives) ---------------- */
    [EDUCATOR_NOTIFICATION_EVENTS.NEW_STUDENT_ENROLLED]: ({ courseTitle, studentName } = {}) => ({
        title: "New Student Enrollment",
        body: `${studentName || "A student"} just enrolled in your course "${courseTitle}".`
    }),

    [EDUCATOR_NOTIFICATION_EVENTS.NEW_PAID_ENROLLMENT]: ({ courseTitle, studentName } = {}) => ({
        title: "New Paid Enrollment",
        body: `${studentName || "A student"} just purchased your course "${courseTitle}".`
    }),

    /* ---------------- Enrollments (student receives) ---------------- */
    [EDUCATOR_NOTIFICATION_EVENTS.STUDENT_ENROLLMENT_CONFIRMED]: ({ courseTitle } = {}) => ({
        title: "Enrollment Confirmed",
        body: `You have successfully enrolled in "${courseTitle}". Happy learning!`
    }),

    [EDUCATOR_NOTIFICATION_EVENTS.STUDENT_PAID_ENROLLMENT_CONFIRMED]: ({ courseTitle } = {}) => ({
        title: "Purchase Successful",
        body: `Your payment was successful and you are now enrolled in "${courseTitle}". Happy learning!`
    })
};

module.exports = { educatorNotificationMessages };