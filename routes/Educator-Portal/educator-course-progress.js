const express = require("express");
const { auth } = require("../../middleware/auth");
const { getMySQLConnection } = require("../../config/mysql");
const { successResponse, errorResponse } = require("../../utils/response");

const router = express.Router();

/* ============================================================
   HELPER: Recalculate and update course progress percentage
============================================================ */
const recalculateProgress = async (mysql, courseId, studentId) => {
    /* Total mandatory lessons in course */
    const [[{ totalLessons }]] = await mysql.execute(
        `SELECT COUNT(*) AS totalLessons
         FROM course_lessons
         WHERE course_id = ? AND is_active = 1 AND is_mandatory = 1`,
        [courseId]
    );

    if (totalLessons === 0) return 0;

    /* Total completed mandatory lessons */
    const [[{ completedLessons }]] = await mysql.execute(
        `SELECT COUNT(*) AS completedLessons
         FROM lesson_progress
         WHERE course_id = ? AND student_id = ? AND is_completed = 1`,
        [courseId, studentId]
    );

    const percentage = Math.min(
        100,
        Math.floor((completedLessons / totalLessons) * 100)
    );

    const isCompleted = percentage >= 100;

    await mysql.execute(
        `UPDATE course_enrollments
         SET progress_percentage = ?,
             completed           = ?,
             completed_at        = ?
         WHERE course_id = ? AND student_id = ?`,
        [
            percentage,
            isCompleted ? 1 : 0,
            isCompleted ? new Date() : null,
            courseId,
            studentId
        ]
    );

    return percentage;
};

/* ============================================================
   1️⃣ MARK LESSON AS COMPLETED
   ------------------------------------------------------------
   @route   POST /api/educator/progress/:courseId/lessons/:lessonId/complete
   @desc    Student marks a lesson as completed
   @access  Private (Enrolled Student)
============================================================ */
router.post("/:courseId/lessons/:lessonId/complete", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId, lessonId } = req.params;
        const { time_spent_minutes } = req.body;

        /* Verify enrollment */
        const [[enrollment]] = await mysql.execute(
            `SELECT id FROM course_enrollments
             WHERE course_id = ? AND student_id = ? LIMIT 1`,
            [courseId, req.user.id]
        );

        if (!enrollment) {
            return errorResponse(res, "You are not enrolled in this course", 403);
        }

        /* Verify lesson belongs to course */
        const [[lesson]] = await mysql.execute(
            `SELECT id, is_mandatory FROM course_lessons
             WHERE id = ? AND course_id = ? AND is_active = 1 LIMIT 1`,
            [lessonId, courseId]
        );

        if (!lesson) return errorResponse(res, "Lesson not found in this course", 404);

        /* Upsert lesson progress */
        await mysql.execute(
            `INSERT INTO lesson_progress
                (course_id, lesson_id, student_id, is_completed, completed_at, time_spent_minutes)
             VALUES (?, ?, ?, 1, NOW(), ?)
             ON DUPLICATE KEY UPDATE
                is_completed        = 1,
                completed_at        = NOW(),
                time_spent_minutes  = time_spent_minutes + VALUES(time_spent_minutes)`,
            [courseId, lessonId, req.user.id, time_spent_minutes || 0]
        );

        /* Recalculate overall progress */
        const progress_percentage = await recalculateProgress(mysql, courseId, req.user.id);

        return successResponse(
            res,
            { progress_percentage, lesson_id: parseInt(lessonId) },
            "Lesson marked as completed"
        );
    } catch (error) {
        console.error("Mark Lesson Complete Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   2️⃣ MARK LESSON AS INCOMPLETE (UNDO)
   ------------------------------------------------------------
   @route   POST /api/educator/progress/:courseId/lessons/:lessonId/incomplete
   @desc    Student un-marks a lesson (resets completion)
   @access  Private (Enrolled Student)
============================================================ */
router.post("/:courseId/lessons/:lessonId/incomplete", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId, lessonId } = req.params;

        const [[enrollment]] = await mysql.execute(
            `SELECT id FROM course_enrollments
             WHERE course_id = ? AND student_id = ? LIMIT 1`,
            [courseId, req.user.id]
        );

        if (!enrollment) {
            return errorResponse(res, "You are not enrolled in this course", 403);
        }

        await mysql.execute(
            `UPDATE lesson_progress
             SET is_completed = 0, completed_at = NULL
             WHERE course_id = ? AND lesson_id = ? AND student_id = ?`,
            [courseId, lessonId, req.user.id]
        );

        const progress_percentage = await recalculateProgress(mysql, courseId, req.user.id);

        return successResponse(
            res,
            { progress_percentage },
            "Lesson marked as incomplete"
        );
    } catch (error) {
        console.error("Mark Lesson Incomplete Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   3️⃣ GET COURSE PROGRESS
   ------------------------------------------------------------
   @route   GET /api/educator/progress/:courseId
   @desc    Get full progress breakdown for a student in a course
   @access  Private (Enrolled Student)
============================================================ */
router.get("/:courseId", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId } = req.params;

        const [[enrollment]] = await mysql.execute(
            `SELECT * FROM course_enrollments
             WHERE course_id = ? AND student_id = ? LIMIT 1`,
            [courseId, req.user.id]
        );

        if (!enrollment) {
            return errorResponse(res, "You are not enrolled in this course", 403);
        }

        /* Get chapters with lessons and completion status */
        const [chapters] = await mysql.execute(
            `SELECT * FROM course_chapters
             WHERE course_id = ? AND is_active = 1
             ORDER BY chapter_order ASC`,
            [courseId]
        );

        const [lessons] = await mysql.execute(
            `SELECT
                cl.*,
                COALESCE(lp.is_completed, 0)        AS is_completed,
                lp.completed_at,
                COALESCE(lp.time_spent_minutes, 0)  AS time_spent_minutes
             FROM course_lessons cl
             LEFT JOIN lesson_progress lp
                ON lp.lesson_id = cl.id AND lp.student_id = ?
             WHERE cl.course_id = ? AND cl.is_active = 1
             ORDER BY cl.lesson_order ASC`,
            [req.user.id, courseId]
        );

        /* Attach lessons to chapters */
        const chaptersWithLessons = chapters.map((chapter) => ({
            ...chapter,
            lessons: lessons.filter((l) => l.chapter_id === chapter.id),
            completed_lessons: lessons.filter(
                (l) => l.chapter_id === chapter.id && l.is_completed
            ).length,
            total_lessons: lessons.filter((l) => l.chapter_id === chapter.id).length
        }));

        return successResponse(
            res,
            {
                progress_percentage: enrollment.progress_percentage,
                completed:           enrollment.completed,
                completed_at:        enrollment.completed_at,
                enrolled_at:         enrollment.enrolled_at,
                chapters:            chaptersWithLessons
            },
            "Course progress fetched successfully"
        );
    } catch (error) {
        console.error("Get Progress Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   4️⃣ GET COMPLETION STATUS
   ------------------------------------------------------------
   @route   GET /api/educator/progress/:courseId/completion
   @desc    Quick check – is the course completed by student?
   @access  Private (Enrolled Student)
============================================================ */
router.get("/:courseId/completion", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId } = req.params;

        const [[enrollment]] = await mysql.execute(
            `SELECT progress_percentage, completed, completed_at
             FROM course_enrollments
             WHERE course_id = ? AND student_id = ? LIMIT 1`,
            [courseId, req.user.id]
        );

        if (!enrollment) {
            return errorResponse(res, "You are not enrolled in this course", 403);
        }

        return successResponse(
            res,
            {
                progress_percentage: enrollment.progress_percentage,
                completed:           !!enrollment.completed,
                completed_at:        enrollment.completed_at
            },
            "Completion status fetched"
        );
    } catch (error) {
        console.error("Get Completion Status Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

module.exports = router;