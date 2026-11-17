const express = require("express");
const { auth } = require("../../middleware/auth");
const { getMySQLConnection } = require("../../config/mysql");
const { successResponse, errorResponse } = require("../../utils/response");

const router = express.Router();

/* ============================================================
   HELPER: Statuses in which an educator may NOT modify course
   structure (chapters/lessons/resources). SL Team/admin bypass
   this. Matches the lock used on the top-level course PUT route.
============================================================ */
const NON_EDITABLE_STATUSES = [
    "proposal_submitted",
    "proposal_rejected",
    "submitted_for_review",
    "approved",
    "published"
];

/* ============================================================
   HELPER: Verify course ownership
============================================================ */
const verifyCourseOwnership = async (mysql, courseId, userId, userType, { requireEditable = false } = {}) => {
    const [[course]] = await mysql.execute(
        `SELECT id, educator_id, status FROM courses WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [courseId]
    );

    if (!course) return { error: "Course not found", status: 404 };

    const isAdmin = ["admin", "superadmin"].includes(userType);
    if (!isAdmin && course.educator_id !== userId) {
        return { error: "Access denied — not your course", status: 403 };
    }

    if (requireEditable && !isAdmin && NON_EDITABLE_STATUSES.includes(course.status)) {
        return {
            error: `Course structure cannot be changed while status is '${course.status}'`,
            status: 400
        };
    }

    return { course };
};

/* ============================================================
   1️⃣ CREATE CHAPTER
   ------------------------------------------------------------
   @route   POST /api/educator/courses/:courseId/chapters
   @desc    Add a new chapter to a course
   @access  Private (Educator)
============================================================ */
router.post("/:courseId/chapters", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId } = req.params;
        const { title, description, is_preview } = req.body;

        if (!title) return errorResponse(res, "Chapter title is required", 400);

        const { course, error, status } = await verifyCourseOwnership(
            mysql, courseId, req.user.id, req.user.user_type, { requireEditable: true }
        );
        if (error) return errorResponse(res, error, status);

        /* Get next order index */
        const [[{ maxOrder }]] = await mysql.execute(
            `SELECT COALESCE(MAX(chapter_order), 0) AS maxOrder
             FROM course_chapters WHERE course_id = ?`,
            [courseId]
        );

        const [result] = await mysql.execute(
            `INSERT INTO course_chapters (course_id, title, description, chapter_order, is_preview)
             VALUES (?, ?, ?, ?, ?)`,
            [courseId, title, description || null, maxOrder + 1, is_preview ? 1 : 0]
        );

        /* Update course chapter count */
        await mysql.execute(
            `UPDATE courses SET total_chapters = total_chapters + 1 WHERE id = ?`,
            [courseId]
        );

        return successResponse(
            res,
            { id: result.insertId, chapter_order: maxOrder + 1 },
            "Chapter created successfully",
            201
        );
    } catch (error) {
        console.error("Create Chapter Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   2️⃣ GET CHAPTERS BY COURSE
   ------------------------------------------------------------
   @route   GET /api/educator/courses/:courseId/chapters
   @desc    Fetch all chapters of a course
   @access  Private
============================================================ */
router.get("/:courseId/chapters", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId } = req.params;

        const { error, status } = await verifyCourseOwnership(
            mysql, courseId, req.user.id, req.user.user_type
        );
        if (error) return errorResponse(res, error, status);

        const [chapters] = await mysql.execute(
            `SELECT
                ch.*,
                COUNT(cl.id)                   AS lesson_count,
                SUM(cl.video_duration_minutes) AS total_duration_minutes
             FROM course_chapters ch
             LEFT JOIN course_lessons cl
                ON cl.chapter_id = ch.id AND cl.is_active = 1
             WHERE ch.course_id = ? AND ch.is_active = 1
             GROUP BY ch.id
             ORDER BY ch.chapter_order ASC`,
            [courseId]
        );

        return successResponse(res, chapters, "Chapters fetched successfully");
    } catch (error) {
        console.error("Get Chapters Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   3️⃣ REORDER CHAPTERS (MUST BE BEFORE :chapterId ROUTE!)
   ------------------------------------------------------------
   @route   PUT /api/educator/courses/:courseId/chapters/reorder
   @desc    Reorder chapters by passing ordered array of chapter IDs
   @access  Private (Educator)
   @body    { order: [{ id: 1, chapter_order: 1 }, ...] }
============================================================ */
router.put("/:courseId/chapters/reorder", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId } = req.params;
        const { order } = req.body;

        if (!Array.isArray(order) || order.length === 0) {
            return errorResponse(res, "Order array is required", 400);
        }

        const { error, status } = await verifyCourseOwnership(
            mysql, courseId, req.user.id, req.user.user_type, { requireEditable: true }
        );
        if (error) return errorResponse(res, error, status);

        /* Update each chapter's order */
        for (const item of order) {
            if (!item.id || item.chapter_order === undefined) continue;

            await mysql.execute(
                `UPDATE course_chapters
                 SET chapter_order = ?
                 WHERE id = ? AND course_id = ?`,
                [item.chapter_order, item.id, courseId]
            );
        }

        return successResponse(res, null, "Chapters reordered successfully");
    } catch (error) {
        console.error("Reorder Chapters Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   4️⃣ UPDATE CHAPTER
   ------------------------------------------------------------
   @route   PUT /api/educator/courses/:courseId/chapters/:chapterId
   @desc    Update chapter title, description, or preview flag
   @access  Private (Educator)
============================================================ */
router.put("/:courseId/chapters/:chapterId", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId, chapterId } = req.params;
        const { title, description, is_preview } = req.body;

        const { error, status } = await verifyCourseOwnership(
            mysql, courseId, req.user.id, req.user.user_type, { requireEditable: true }
        );
        if (error) return errorResponse(res, error, status);

        const [[chapter]] = await mysql.execute(
            `SELECT * FROM course_chapters WHERE id = ? AND course_id = ? LIMIT 1`,
            [chapterId, courseId]
        );

        if (!chapter) return errorResponse(res, "Chapter not found", 404);

        await mysql.execute(
            `UPDATE course_chapters
             SET title       = ?,
                 description = ?,
                 is_preview  = ?
             WHERE id = ?`,
            [
                title       ?? chapter.title,
                description ?? chapter.description,
                is_preview  !== undefined ? (is_preview ? 1 : 0) : chapter.is_preview,
                chapterId
            ]
        );

        return successResponse(res, null, "Chapter updated successfully");
    } catch (error) {
        console.error("Update Chapter Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   5️⃣ DELETE CHAPTER
   ------------------------------------------------------------
   @route   DELETE /api/educator/courses/:courseId/chapters/:chapterId
   @desc    Soft-delete a chapter (deactivate)
   @access  Private (Educator)
============================================================ */
router.delete("/:courseId/chapters/:chapterId", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId, chapterId } = req.params;

        const { error, status } = await verifyCourseOwnership(
            mysql, courseId, req.user.id, req.user.user_type, { requireEditable: true }
        );
        if (error) return errorResponse(res, error, status);

        const [[chapter]] = await mysql.execute(
            `SELECT id FROM course_chapters WHERE id = ? AND course_id = ? AND is_active = 1 LIMIT 1`,
            [chapterId, courseId]
        );

        if (!chapter) return errorResponse(res, "Chapter not found", 404);

        /* Deactivate chapter and its lessons */
        await mysql.execute(
            `UPDATE course_chapters SET is_active = 0 WHERE id = ?`,
            [chapterId]
        );

        await mysql.execute(
            `UPDATE course_lessons SET is_active = 0 WHERE chapter_id = ?`,
            [chapterId]
        );

        /* Recalculate counts */
        const [[{ total_chapters }]] = await mysql.execute(
            `SELECT COUNT(*) AS total_chapters FROM course_chapters WHERE course_id = ? AND is_active = 1`,
            [courseId]
        );
        const [[{ total_lessons }]] = await mysql.execute(
            `SELECT COUNT(*) AS total_lessons FROM course_lessons WHERE course_id = ? AND is_active = 1`,
            [courseId]
        );

        await mysql.execute(
            `UPDATE courses SET total_chapters = ?, total_lessons = ? WHERE id = ?`,
            [total_chapters, total_lessons, courseId]
        );

        return successResponse(res, null, "Chapter deleted successfully");
    } catch (error) {
        console.error("Delete Chapter Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

module.exports = router;
