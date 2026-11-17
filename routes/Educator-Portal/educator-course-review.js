const express = require("express");
const { auth } = require("../../middleware/auth");
const { getMySQLConnection } = require("../../config/mysql");
const { successResponse, errorResponse } = require("../../utils/response");
const {
    sendEducatorNotification,
    EDUCATOR_NOTIFICATION_EVENTS
} = require("./utils/educatorNotificationService");

const router = express.Router();

/* ============================================================
   MIDDLEWARE: Admin / SL Team only
============================================================ */
const adminOnly = (req, res, next) => {
    const allowedTypes = ["admin", "superadmin"];
    const allowedRoles = ["sl_team"];

    if (
        allowedTypes.includes(req.user.user_type) ||
        allowedRoles.includes(req.user.role)
    ) {
        return next();
    }

    return errorResponse(res, "Unauthorized – Admin or SL Team access only", 403);
};

/* ============================================================
   HELPER: Insert review log + status history
============================================================ */
const logReviewAction = async (mysql, courseId, reviewerId, action, notes, oldStatus, newStatus) => {
    await mysql.execute(
        `INSERT INTO course_review_logs (course_id, reviewer_id, action, notes)
         VALUES (?, ?, ?, ?)`,
        [courseId, reviewerId, action, notes || null]
    );

    await mysql.execute(
        `INSERT INTO course_status_history (course_id, old_status, new_status, changed_by, remarks)
         VALUES (?, ?, ?, ?, ?)`,
        [courseId, oldStatus, newStatus, reviewerId, notes || null]
    );
};

/* ============================================================
   HELPER: Safe JSON parse
============================================================ */
const parseJSON = (value, defaultValue = []) => {
    try {
        if (!value) return defaultValue;
        return typeof value === "string" ? JSON.parse(value) : value;
    } catch {
        return defaultValue;
    }
};

/* ============================================================================================
   GATE 1 — PROPOSAL REVIEW (idea approval, BEFORE the course is built)
   ============================================================================================ */

/* ============================================================
   1️⃣ GET PENDING PROPOSALS
   ------------------------------------------------------------
   @route   GET /api/educator/review/proposals/pending
   @desc    Get all course proposals awaiting Gate-1 decision
   @access  Private (Admin / SL Team)
============================================================ */
router.get("/proposals/pending", auth, adminOnly, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { page = 1, limit = 20, category } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let whereClause = `WHERE c.status = 'proposal_submitted' AND c.deleted_at IS NULL`;
        const params = [];

        if (category) {
            whereClause += ` AND c.category = ?`;
            params.push(category);
        }

        const [proposals] = await mysql.execute(
            `SELECT
                c.id, c.course_title, c.slug, c.category, c.subcategory,
                c.short_description, c.target_audience, c.learning_outcomes,
                c.technology_tools, c.proposal_data, c.created_at, c.updated_at,
                u.id            AS educator_id,
                u.first_name    AS educator_first_name,
                u.last_name     AS educator_last_name,
                u.email         AS educator_email,
                u.avatar        AS educator_avatar
             FROM courses c
             LEFT JOIN users u ON c.educator_id = u.id
             ${whereClause}
             ORDER BY c.created_at ASC
             LIMIT ${parseInt(limit)} OFFSET ${offset}`,
            params
        );

        const [[{ total }]] = await mysql.execute(
            `SELECT COUNT(*) AS total FROM courses c ${whereClause}`,
            params
        );

        const formatted = proposals.map((p) => ({
            ...p,
            target_audience: parseJSON(p.target_audience),
            learning_outcomes: parseJSON(p.learning_outcomes),
            technology_tools: parseJSON(p.technology_tools),
            proposal_data: parseJSON(p.proposal_data, {})
        }));

        return successResponse(
            res,
            {
                proposals: formatted,
                pagination: { page: parseInt(page), limit: parseInt(limit), total }
            },
            "Pending proposals fetched successfully"
        );
    } catch (error) {
        console.error("Get Pending Proposals Error:", error);
        return errorResponse(res, error.message, 500);
    }
});


/* ============================================================
   GET ALL COURSES
   ------------------------------------------------------------
   @route   GET /api/educator/review/courses
   @desc    Get all courses (optionally filter by status)
   @access  Private (Admin / SL Team)
   @query
      status=approved
      page=1
      limit=20
============================================================ */
router.get("/courses", auth, adminOnly, async (req, res) => {
    try {
        const mysql = getMySQLConnection();

        const {
            status,
            category,
            page = 1,
            limit = 20
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);

        let whereClause = `WHERE c.deleted_at IS NULL`;
        const params = [];

        if (status && status.toLowerCase() !== "all") {
            whereClause += ` AND c.status = ?`;
            params.push(status);
        }

        if (category) {
            whereClause += ` AND c.category = ?`;
            params.push(category);
        }

        const [courses] = await mysql.execute(
            `SELECT
                c.id,
                c.course_title,
                c.slug,
                c.category,
                c.subcategory,
                c.course_type,
                c.price,
                c.level,
                c.language,
                c.status,
                c.visibility,
                c.thumbnail,
                c.short_description,
                c.total_chapters,
                c.total_lessons,
                c.created_at,
                c.updated_at,
                u.id AS educator_id,
                u.first_name AS educator_first_name,
                u.last_name AS educator_last_name,
                u.email AS educator_email,
                u.avatar AS educator_avatar
            FROM courses c
            LEFT JOIN users u
                ON c.educator_id = u.id
            ${whereClause}
            ORDER BY c.created_at DESC
            LIMIT ${parseInt(limit)}
            OFFSET ${offset}`,
            params
        );

        const [[{ total }]] = await mysql.execute(
            `SELECT COUNT(*) AS total
             FROM courses c
             ${whereClause}`,
            params
        );

        return successResponse(
            res,
            {
                courses,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    totalPages: Math.ceil(total / parseInt(limit))
                }
            },
            "Courses fetched successfully"
        );
    } catch (error) {
        console.error("Get Courses Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   2️⃣ APPROVE PROPOSAL  (Gate 1 -> unlock course building)
   ------------------------------------------------------------
   @route   POST /api/educator/review/:courseId/approve-proposal
   @desc    Moves a proposal from 'proposal_submitted' to
            'in_development'. Auto-creates the chapter skeleton
            (one per module) and the sample lesson from the data
            captured at proposal time — matching the doc's
            "course draft is auto-populated" requirement.
   @access  Private (Admin / SL Team)
============================================================ */
router.post("/:courseId/approve-proposal", auth, adminOnly, async (req, res) => {
    const mysql = getMySQLConnection();
    try {
        const { courseId } = req.params;
        const { notes } = req.body;

        const [[course]] = await mysql.execute(
            `SELECT * FROM courses WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
            [courseId]
        );

        if (!course) return errorResponse(res, "Course proposal not found", 404);

        if (course.status !== "proposal_submitted") {
            return errorResponse(
                res,
                `Proposal must be in 'proposal_submitted' status to approve. Current: ${course.status}`,
                400
            );
        }

        const proposalData = parseJSON(course.proposal_data, {});
        const modules = Array.isArray(proposalData.modules) ? proposalData.modules : [];

        if (modules.length === 0) {
            return errorResponse(res, "Proposal has no module outline to build from", 400);
        }

        /* ---- Create chapters from the module outline ---- */
        let chapterOrder = 1;
        const createdChapterIds = [];

        for (const mod of modules) {
            const [chapterResult] = await mysql.execute(
                `INSERT INTO course_chapters (course_id, title, description, chapter_order, is_preview)
                 VALUES (?, ?, ?, ?, 0)`,
                [courseId, mod.title || `Module ${chapterOrder}`, mod.description || null, chapterOrder]
            );
            createdChapterIds.push(chapterResult.insertId);
            chapterOrder++;
        }

        /* ---- Create the sample lesson under the first chapter ---- */
        const firstChapterId = createdChapterIds[0];

        const lessonContent = [
            proposalData.sample_lesson_objective ? `Objective: ${proposalData.sample_lesson_objective}` : null,
            proposalData.teaching_flow ? `Teaching Flow:\n${proposalData.teaching_flow}` : null,
            proposalData.assessment_method ? `Assessment: ${proposalData.assessment_method}` : null
        ].filter(Boolean).join("\n\n");

        const [lessonResult] = await mysql.execute(
            `INSERT INTO course_lessons (
                course_id, chapter_id, title, lesson_type, content,
                video_duration_minutes, lesson_order, is_preview, is_mandatory
             ) VALUES (?, ?, ?, 'video', ?, ?, 1, 1, 1)`,
            [
                courseId,
                firstChapterId,
                proposalData.sample_lesson_title || "Sample Lesson",
                lessonContent || null,
                proposalData.video_duration_minutes || 0
            ]
        );

        /* ---- Link the sample video (uploaded at proposal time) to this lesson ---- */
        await mysql.execute(
            `UPDATE course_resources SET lesson_id = ? WHERE course_id = ? AND lesson_id IS NULL`,
            [lessonResult.insertId, courseId]
        );

        /* ---- Update course: unlock building ---- */
        await mysql.execute(
            `UPDATE courses
             SET status = 'in_development', total_chapters = ?, total_lessons = 1,
                 reviewed_by = ?, reviewed_at = NOW(), admin_feedback = ?
             WHERE id = ?`,
            [createdChapterIds.length, req.user.id, notes || null, courseId]
        );

        await logReviewAction(
            mysql, courseId, req.user.id,
            "approved", notes || "Proposal approved — course building unlocked",
            "proposal_submitted", "in_development"
        );

        /* ============================================================
           NOTIFICATIONS (non-blocking - never breaks the response)
        ============================================================ */
        sendEducatorNotification({
            mysql,
            event: EDUCATOR_NOTIFICATION_EVENTS.PROPOSAL_APPROVED,
            userId: course.educator_id,
            actorId: req.user.id,
            data: { courseTitle: course.course_title, notes },
            metadata: { course_id: parseInt(courseId) }
        });

        return successResponse(
            res,
            { course_id: parseInt(courseId), chapter_ids: createdChapterIds, lesson_id: lessonResult.insertId },
            "Proposal approved — course draft created and ready for building"
        );
    } catch (error) {
        console.error("Approve Proposal Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   3️⃣ REJECT PROPOSAL  (Gate 1 -> closed)
   ------------------------------------------------------------
   @route   POST /api/educator/review/:courseId/reject-proposal
   @desc    Rejects a proposal with structured feedback, matching
            the doc's requirement for why/what/can-resubmit.
   @access  Private (Admin / SL Team)
   @body    {
              reason,              // required — short rejection reason
              category,            // 'content'|'teaching_quality'|'video_quality'|'technology'|'platform_fit'|'other'
              notes,               // optional longer feedback
              allow_resubmission   // boolean, default true
            }
============================================================ */
router.post("/:courseId/reject-proposal", auth, adminOnly, async (req, res) => {
    const mysql = getMySQLConnection();
    try {
        const { courseId } = req.params;
        const { reason, category, notes, allow_resubmission } = req.body;

        if (!reason) return errorResponse(res, "Rejection reason is required", 400);

        const VALID_CATEGORIES = ["content", "teaching_quality", "video_quality", "technology", "platform_fit", "other"];
        if (category && !VALID_CATEGORIES.includes(category)) {
            return errorResponse(res, `Invalid category. Must be one of: ${VALID_CATEGORIES.join(", ")}`, 400);
        }

        const [[course]] = await mysql.execute(
            `SELECT id, educator_id, course_title, status FROM courses WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
            [courseId]
        );

        if (!course) return errorResponse(res, "Course proposal not found", 404);

        if (course.status !== "proposal_submitted") {
            return errorResponse(
                res,
                `Proposal must be in 'proposal_submitted' status to reject. Current: ${course.status}`,
                400
            );
        }

        const canResubmit = allow_resubmission === undefined ? true : !!allow_resubmission;

        await mysql.execute(
            `UPDATE courses
             SET status = 'proposal_rejected', reviewed_by = ?, reviewed_at = NOW(),
                 rejection_reason = ?, rejection_category = ?, can_resubmit = ?, admin_feedback = ?
             WHERE id = ?`,
            [req.user.id, reason, category || "other", canResubmit, notes || null, courseId]
        );

        await logReviewAction(
            mysql, courseId, req.user.id,
            "rejected", `Reason: ${reason}. ${notes || ""}`.trim(),
            "proposal_submitted", "proposal_rejected"
        );

        /* ============================================================
           NOTIFICATIONS (non-blocking - never breaks the response)
        ============================================================ */
        sendEducatorNotification({
            mysql,
            event: EDUCATOR_NOTIFICATION_EVENTS.PROPOSAL_REJECTED,
            userId: course.educator_id,
            actorId: req.user.id,
            data: { courseTitle: course.course_title, reason, canResubmit },
            metadata: { course_id: parseInt(courseId), can_resubmit: canResubmit }
        });

        return successResponse(res, null, "Proposal rejected");
    } catch (error) {
        console.error("Reject Proposal Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================================================
   GATE 2 — FULL COURSE REVIEW (after the educator has built the course)
   ============================================================================================ */

/* ============================================================
   4️⃣ GET PENDING REVIEW COURSES
   ------------------------------------------------------------
   @route   GET /api/educator/review/pending
   @desc    Get all fully-built courses submitted for final review
   @access  Private (Admin / SL Team)
============================================================ */
router.get("/pending", auth, adminOnly, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { page = 1, limit = 20, category } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let whereClause = `WHERE c.status = 'submitted_for_review' AND c.deleted_at IS NULL`;
        const params = [];

        if (category) {
            whereClause += ` AND c.category = ?`;
            params.push(category);
        }

        const [courses] = await mysql.execute(
            `SELECT
                c.id, c.course_title, c.slug, c.category, c.subcategory,
                c.course_type, c.price, c.level, c.language, c.status,
                c.short_description, c.thumbnail, c.total_chapters, c.total_lessons,
                c.created_at, c.updated_at,
                u.id            AS educator_id,
                u.first_name    AS educator_first_name,
                u.last_name     AS educator_last_name,
                u.email         AS educator_email,
                u.avatar        AS educator_avatar
             FROM courses c
             LEFT JOIN users u ON c.educator_id = u.id
             ${whereClause}
             ORDER BY c.updated_at ASC
             LIMIT ${parseInt(limit)} OFFSET ${offset}`,
            params
        );

        const [[{ total }]] = await mysql.execute(
            `SELECT COUNT(*) AS total FROM courses c ${whereClause}`,
            params
        );

        return successResponse(
            res,
            {
                courses,
                pagination: { page: parseInt(page), limit: parseInt(limit), total }
            },
            "Pending review courses fetched successfully"
        );
    } catch (error) {
        console.error("Get Pending Courses Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   5️⃣ GET SINGLE COURSE FOR REVIEW
   ------------------------------------------------------------
   @route   GET /api/educator/review/:courseId
   @desc    Get full course details for review (chapters, lessons,
            resources — so the SL Team can preview the course the
            same way a user/student would experience it)
   @access  Private (Admin / SL Team)
============================================================ */
router.get("/:courseId", auth, adminOnly, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId } = req.params;

        const [[course]] = await mysql.execute(
            `SELECT
                c.*,
                u.first_name AS educator_first_name,
                u.last_name  AS educator_last_name,
                u.email      AS educator_email,
                u.avatar     AS educator_avatar
             FROM courses c
             LEFT JOIN users u ON c.educator_id = u.id
             WHERE c.id = ? AND c.deleted_at IS NULL LIMIT 1`,
            [courseId]
        );

        if (!course) return errorResponse(res, "Course not found", 404);

        const [chapters] = await mysql.execute(
            `SELECT * FROM course_chapters
             WHERE course_id = ? AND is_active = 1
             ORDER BY chapter_order ASC`,
            [courseId]
        );

        const [lessons] = await mysql.execute(
            `SELECT * FROM course_lessons
             WHERE course_id = ? AND is_active = 1
             ORDER BY lesson_order ASC`,
            [courseId]
        );

        /* Resources — needed so the reviewer can preview sample
           video / downloadable files exactly like a student would */
        const [resources] = await mysql.execute(
            `SELECT
                r.*,
                u.first_name AS uploaded_by_first_name,
                u.last_name  AS uploaded_by_last_name
             FROM course_resources r
             LEFT JOIN users u ON r.uploaded_by = u.id
             WHERE r.course_id = ?
             ORDER BY r.created_at DESC`,
            [courseId]
        );

        const [reviewLogs] = await mysql.execute(
            `SELECT
                rl.*,
                u.first_name AS reviewer_first_name,
                u.last_name  AS reviewer_last_name
             FROM course_review_logs rl
             LEFT JOIN users u ON rl.reviewer_id = u.id
             WHERE rl.course_id = ?
             ORDER BY rl.created_at DESC
             LIMIT 20`,
            [courseId]
        );

        course.proposal_data = parseJSON(course.proposal_data, {});

        return successResponse(
            res,
            { ...course, chapters, lessons, resources, review_logs: reviewLogs },
            "Course details fetched for review"
        );
    } catch (error) {
        console.error("Get Course Review Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   6️⃣ APPROVE COURSE (final approval)
   ------------------------------------------------------------
   @route   POST /api/educator/review/:courseId/approve
   @desc    Admin approves a submitted course (moves to approved)
   @access  Private (Admin / SL Team)
============================================================ */
router.post("/:courseId/approve", auth, adminOnly, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId } = req.params;
        const { notes } = req.body;

        const [[course]] = await mysql.execute(
            `SELECT id, educator_id, course_title, status FROM courses WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
            [courseId]
        );

        if (!course) return errorResponse(res, "Course not found", 404);

        if (course.status !== "submitted_for_review") {
            return errorResponse(
                res,
                `Course must be in 'submitted_for_review' status to approve. Current: ${course.status}`,
                400
            );
        }

        await mysql.execute(
            `UPDATE courses
             SET status = 'approved', reviewed_by = ?, reviewed_at = NOW(), admin_feedback = ?
             WHERE id = ?`,
            [req.user.id, notes || null, courseId]
        );

        await logReviewAction(
            mysql, courseId, req.user.id,
            "approved", notes,
            course.status, "approved"
        );

        /* ============================================================
           NOTIFICATIONS (non-blocking - never breaks the response)
        ============================================================ */
        // sendEducatorNotification({
        //     mysql,
        //     event: EDUCATOR_NOTIFICATION_EVENTS.COURSE_APPROVED,
        //     userId: course.educator_id,
        //     actorId: req.user.id,
        //     data: { courseTitle: course.course_title, notes },
        //     metadata: { course_id: parseInt(courseId) }
        // });

        return successResponse(res, null, "Course approved successfully");
    } catch (error) {
        console.error("Approve Course Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   7️⃣ REJECT COURSE
   ------------------------------------------------------------
   @route   POST /api/educator/review/:courseId/reject
   @desc    Admin rejects a submitted course
   @access  Private (Admin / SL Team)
============================================================ */
router.post("/:courseId/reject", auth, adminOnly, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId } = req.params;
        const { reason, notes } = req.body;

        if (!reason) return errorResponse(res, "Rejection reason is required", 400);

        const [[course]] = await mysql.execute(
            `SELECT id, educator_id, course_title, status FROM courses WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
            [courseId]
        );

        if (!course) return errorResponse(res, "Course not found", 404);

        const reviewableStatuses = ["submitted_for_review", "approved"];
        if (!reviewableStatuses.includes(course.status)) {
            return errorResponse(
                res,
                `Course cannot be rejected from status: ${course.status}`,
                400
            );
        }

        await mysql.execute(
            `UPDATE courses
             SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(),
                 rejection_reason = ?, admin_feedback = ?
             WHERE id = ?`,
            [req.user.id, reason, notes || null, courseId]
        );

        await logReviewAction(
            mysql, courseId, req.user.id,
            "rejected", `Reason: ${reason}. ${notes || ""}`.trim(),
            course.status, "rejected"
        );

        /* ============================================================
           NOTIFICATIONS (non-blocking - never breaks the response)
        ============================================================ */
        sendEducatorNotification({
            mysql,
            event: EDUCATOR_NOTIFICATION_EVENTS.COURSE_REJECTED,
            userId: course.educator_id,
            actorId: req.user.id,
            data: { courseTitle: course.course_title, reason },
            metadata: { course_id: parseInt(courseId) }
        });

        return successResponse(res, null, "Course rejected successfully");
    } catch (error) {
        console.error("Reject Course Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   8️⃣ REQUEST REVISION
   ------------------------------------------------------------
   @route   POST /api/educator/review/:courseId/request-revision
   @desc    Admin sends course back to educator for revision
   @access  Private (Admin / SL Team)
============================================================ */
router.post("/:courseId/request-revision", auth, adminOnly, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId } = req.params;
        const { feedback } = req.body;

        if (!feedback) return errorResponse(res, "Revision feedback is required", 400);

        const [[course]] = await mysql.execute(
            `SELECT id, educator_id, course_title, status FROM courses WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
            [courseId]
        );

        if (!course) return errorResponse(res, "Course not found", 404);

        // if (course.status !== "submitted_for_review") {
        //     return errorResponse(
        //         res,
        //         `Course must be in 'submitted_for_review' status to request revision. Current: ${course.status}`,
        //         400
        //     );
        // }

        await mysql.execute(
            `UPDATE courses
             SET status = 'revision_requested', reviewed_by = ?, reviewed_at = NOW(),
                 admin_feedback = ?
             WHERE id = ?`,
            [req.user.id, feedback, courseId]
        );

        await logReviewAction(
            mysql, courseId, req.user.id,
            "revision_requested", feedback,
            course.status, "revision_requested"
        );

        /* ============================================================
           NOTIFICATIONS (non-blocking - never breaks the response)
        ============================================================ */
        sendEducatorNotification({
            mysql,
            event: EDUCATOR_NOTIFICATION_EVENTS.COURSE_REVISION_REQUESTED,
            userId: course.educator_id,
            actorId: req.user.id,
            data: { courseTitle: course.course_title, feedback },
            metadata: { course_id: parseInt(courseId) }
        });

        return successResponse(res, null, "Revision requested successfully");
    } catch (error) {
        console.error("Request Revision Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   9️⃣ PUBLISH COURSE
   ------------------------------------------------------------
   @route   POST /api/educator/review/:courseId/publish
   @desc    Admin publishes an approved course to marketplace
   @access  Private (Admin / SL Team)
============================================================ */
router.post("/:courseId/publish", auth, adminOnly, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId } = req.params;
        const { notes, price } = req.body;

        const [[course]] = await mysql.execute(
            `SELECT id, educator_id, course_title, status FROM courses WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
            [courseId]
        );

        if (!course) return errorResponse(res, "Course not found", 404);

        if (course.status !== "approved") {
            return errorResponse(
                res,
                `Course must be 'approved' before publishing. Current: ${course.status}`,
                400
            );
        }

        await mysql.execute(
            `UPDATE courses
             SET status = 'published', published_at = NOW(), visibility = 'public',
                 reviewed_by = ?, reviewed_at = NOW(), admin_feedback = ?, price = ?
             WHERE id = ?`,
            [req.user.id, notes || null, price|| 0.00, courseId]
        );

        await logReviewAction(
            mysql, courseId, req.user.id,
            "published", notes,
            course.status, "published"
        );

        /* ============================================================
           NOTIFICATIONS (non-blocking - never breaks the response)
        ============================================================ */
        sendEducatorNotification({
            mysql,
            event: EDUCATOR_NOTIFICATION_EVENTS.COURSE_PUBLISHED,
            userId: course.educator_id,
            actorId: req.user.id,
            data: { courseTitle: course.course_title },
            metadata: { course_id: parseInt(courseId) }
        });

        return successResponse(res, null, "Course published successfully");
    } catch (error) {
        console.error("Publish Course Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   🔟 GET REVIEW LOGS FOR A COURSE
   ------------------------------------------------------------
   @route   GET /api/educator/review/:courseId/logs
   @desc    Get complete review history for a course
   @access  Private (Admin / SL Team)
============================================================ */
router.get("/:courseId/logs", auth, adminOnly, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId } = req.params;

        const [logs] = await mysql.execute(
            `SELECT
                rl.*,
                u.first_name AS reviewer_first_name,
                u.last_name  AS reviewer_last_name,
                u.avatar     AS reviewer_avatar
             FROM course_review_logs rl
             LEFT JOIN users u ON rl.reviewer_id = u.id
             WHERE rl.course_id = ?
             ORDER BY rl.created_at DESC`,
            [courseId]
        );

        const [statusHistory] = await mysql.execute(
            `SELECT
                sh.*,
                u.first_name AS changed_by_first_name,
                u.last_name  AS changed_by_last_name
             FROM course_status_history sh
             LEFT JOIN users u ON sh.changed_by = u.id
             WHERE sh.course_id = ?
             ORDER BY sh.created_at DESC`,
            [courseId]
        );

        return successResponse(
            res,
            { review_logs: logs, status_history: statusHistory },
            "Review logs fetched successfully"
        );
    } catch (error) {
        console.error("Get Review Logs Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   ADD COMMENT
   ------------------------------------------------------------
   @route   POST /api/educator/review/:courseId/comments
   @desc    Add review comment to course
   @access  Private (Admin / SL Team)
============================================================ */
router.post("/:courseId/comments", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();

        const { courseId } = req.params;
        const { comment } = req.body;

        if (!comment) {
            return errorResponse(res, "Comment is required", 400);
        }

        const [[course]] = await mysql.execute(
            `SELECT id, educator_id, course_title, course_review_comments
             FROM courses
             WHERE id=? AND deleted_at IS NULL`,
            [courseId]
        );

        if (!course) {
            return errorResponse(res, "Course not found", 404);
        }

        let comments = [];

        if (course.course_review_comments) {
            comments =
                typeof course.course_review_comments === "string"
                    ? JSON.parse(course.course_review_comments)
                    : course.course_review_comments;
        }

        comments.push({
            id: `cmt_${Date.now()}`,
            comment,
            user: {
                id: req.user.id,
                name: `${req.user.first_name} ${req.user.last_name}`,
                email: req.user.email,
                role: req.user.role,
                avatar: req.user.avatar || null
            },
            created_at: new Date().toISOString(),
            updated_at: null,
            deleted: false,
            metadata: {
                edited: false,
                history: []
            }
        });

        await mysql.execute(
            `UPDATE courses
             SET course_review_comments = ?
             WHERE id = ?`,
            [JSON.stringify(comments), courseId]
        );
        
        /* ============================================================
           NOTIFICATIONS (non-blocking - never breaks the response)
           Only notify the course owner if the comment was left by
           someone else (e.g. an SL Team reviewer, not the educator
           commenting on their own course).
        ============================================================ */
        // if (course.educator_id && course.educator_id !== req.user.id) {
        //     sendEducatorNotification({
        //         mysql,
        //         event: EDUCATOR_NOTIFICATION_EVENTS.COURSE_REVIEW_COMMENT_ADDED,
        //         userId: course.educator_id,
        //         actorId: req.user.id,
        //         data: {
        //             courseTitle: course.course_title,
        //             commenterName: `${req.user.first_name || ""} ${req.user.last_name || ""}`.trim() || "A reviewer"
        //         },
        //         metadata: { course_id: parseInt(courseId) }
        //     });
        // }

        // Don't return deleted comments
        const activeComments = comments.filter(comment => !comment.deleted);
        
        return successResponse(
            res,
            activeComments,
            "Comment added successfully"
        );
    } catch (err) {
        console.log(err);
        return errorResponse(res, err.message, 500);
    }
});

/* ============================================================
   UPDATE COMMENT
   ------------------------------------------------------------
   @route   PUT /api/educator/review/:courseId/comments/:commentId
   @desc    Update existing review comment
   @access  Private (Admin / SL Team)
============================================================ */
router.put("/:courseId/comments/:commentId", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();

        const { courseId, commentId } = req.params;
        const { comment } = req.body;

        if (!comment) {
            return errorResponse(res, "Comment is required", 400);
        }

        const [[course]] = await mysql.execute(
            `SELECT course_review_comments
             FROM courses
             WHERE id=?`,
            [courseId]
        );

        if (!course) {
            return errorResponse(res, "Course not found", 404);
        }

        let comments = course.course_review_comments
            ? JSON.parse(course.course_review_comments)
            : [];

        const index = comments.findIndex(
            c => c.id === commentId && !c.deleted
        );

        if (index === -1) {
            return errorResponse(res, "Comment not found", 404);
        }

        comments[index].metadata.history.push({
            comment: comments[index].comment,
            updated_at: comments[index].updated_at,
            updated_by: comments[index].user.id
        });

        comments[index].comment = comment;
        comments[index].updated_at = new Date().toISOString();
        comments[index].metadata.edited = true;

        await mysql.execute(
            `UPDATE courses
             SET course_review_comments=?
             WHERE id=?`,
            [JSON.stringify(comments), courseId]
        );

        return successResponse(res, comments[index], "Comment updated");
    } catch (err) {
        return errorResponse(res, err.message, 500);
    }
});

/* ============================================================
   DELETE COMMENT
   ------------------------------------------------------------
   @route   DELETE /api/educator/review/:courseId/comments/:commentId
   @desc    Delete review comment
   @access  Private (Admin / SL Team)
============================================================ */
router.delete("/:courseId/comments/:commentId", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();

        const { courseId, commentId } = req.params;

        const [[course]] = await mysql.execute(
            `SELECT course_review_comments
             FROM courses
             WHERE id=?`,
            [courseId]
        );

        if (!course) {
            return errorResponse(res, "Course not found", 404);
        }

        let comments = course.course_review_comments
            ? JSON.parse(course.course_review_comments)
            : [];

        const index = comments.findIndex(c => c.id === commentId);
        console.log(index)

        if (index === -1) {
            return errorResponse(res, "Comment not found", 404);
        }

        comments[index].deleted = true;
        comments[index].deleted_at = new Date().toISOString();
        comments[index].deleted_by = req.user.id;

        await mysql.execute(
            `UPDATE courses
             SET course_review_comments=?
             WHERE id=?`,
            [JSON.stringify(comments), courseId]
        );

        return successResponse(res, null, "Comment deleted");
    } catch (err) {
        return errorResponse(res, err.message, 500);
    }
});

/* ============================================================
   GET COURSE COMMENTS
   ------------------------------------------------------------
   @route   GET /api/educator/review/:courseId/comments
   @desc    Get all review comments
   @access  Private (Admin / SL Team)
============================================================ */
router.get("/:courseId/comments", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();

        const { courseId } = req.params;

        const [[course]] = await mysql.execute(
            `SELECT course_review_comments
             FROM courses
             WHERE id=?`,
            [courseId]
        );

        if (!course) {
            return errorResponse(res, "Course not found", 404);
        }

        const comments = course.course_review_comments
            ? JSON.parse(course.course_review_comments)
            : [];

        return successResponse(
            res,
            comments.filter(c => !c.deleted),
            "Comments fetched successfully"
        );
    } catch (err) {
        return errorResponse(res, err.message, 500);
    }
});

module.exports = router;