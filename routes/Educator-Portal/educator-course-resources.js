const express = require("express");
const { auth } = require("../../middleware/auth");
const { getMySQLConnection } = require("../../config/mysql");
const { successResponse, errorResponse } = require("../../utils/response");
const { CourseResourcesUpload } = require("../../config/s3");

const router = express.Router();

/* ============================================================
   HELPER: Statuses in which an educator may NOT modify course
   structure (chapters/lessons/resources). SL Team/admin bypass.
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
        return { error: "Access denied – not your course", status: 403 };
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
   1️⃣ UPLOAD RESOURCE
   ------------------------------------------------------------
   @route   POST /api/educator/courses/:courseId/resources
   @desc    Upload PDFs, ZIPs, worksheets, slides, notes to a course
   @access  Private (Educator)
   @body    multipart/form-data  { files, lesson_id? }
============================================================ */
router.post(
    "/:courseId/resources",
    auth,
    CourseResourcesUpload.array("files", 20),
    async (req, res) => {
        try {
            const mysql = getMySQLConnection();
            const { courseId } = req.params;
            const { lesson_id } = req.body;

            const { error, status } = await verifyCourseOwnership(
                mysql, courseId, req.user.id, req.user.user_type, { requireEditable: true }
            );
            if (error) return errorResponse(res, error, status);

            if (!req.files || req.files.length === 0) {
                return errorResponse(res, "No files uploaded", 400);
            }

            /* Validate lesson_id if provided */
            if (lesson_id) {
                const [[lesson]] = await mysql.execute(
                    `SELECT id FROM course_lessons WHERE id = ? AND course_id = ? AND is_active = 1 LIMIT 1`,
                    [lesson_id, courseId]
                );
                if (!lesson) return errorResponse(res, "Lesson not found in this course", 404);
            }

            const inserted = [];

            for (const file of req.files) {
                const [result] = await mysql.execute(
                    `INSERT INTO course_resources
                        (course_id, lesson_id, file_name, file_url, file_type, file_size, uploaded_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                        courseId,
                        lesson_id || null,
                        file.originalname,
                        file.location,      // S3 URL
                        file.mimetype,
                        file.size,
                        req.user.id
                    ]
                );

                inserted.push({
                    id: result.insertId,
                    file_name: file.originalname,
                    file_url: file.location,
                    file_type: file.mimetype,
                    file_size: file.size
                });
            }

            return successResponse(
                res,
                inserted,
                `${inserted.length} resource(s) uploaded successfully`,
                201
            );
        } catch (error) {
            console.error("Upload Resource Error:", error);
            return errorResponse(res, error.message, 500);
        }
    }
);

/* ============================================================
   2️⃣ GET RESOURCES
   ------------------------------------------------------------
   @route   GET /api/educator/courses/:courseId/resources
   @desc    Get all resources for a course (optionally filtered by lesson)
   @access  Private
============================================================ */
router.get("/:courseId/resources", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId } = req.params;
        const { lesson_id } = req.query;

        const { error, status } = await verifyCourseOwnership(
            mysql, courseId, req.user.id, req.user.user_type
        );
        if (error) return errorResponse(res, error, status);

        let whereClause = `WHERE r.course_id = ?`;
        const params = [courseId];

        if (lesson_id) {
            whereClause += ` AND r.lesson_id = ?`;
            params.push(lesson_id);
        }

        const [resources] = await mysql.execute(
            `SELECT
                r.*,
                u.first_name AS uploaded_by_first_name,
                u.last_name  AS uploaded_by_last_name,
                cl.title     AS lesson_title
             FROM course_resources r
             LEFT JOIN users u ON r.uploaded_by = u.id
             LEFT JOIN course_lessons cl ON r.lesson_id = cl.id
             ${whereClause}
             ORDER BY r.created_at DESC`,
            params
        );

        return successResponse(res, resources, "Resources fetched successfully");
    } catch (error) {
        console.error("Get Resources Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   3️⃣ DELETE RESOURCE
   ------------------------------------------------------------
   @route   DELETE /api/educator/courses/:courseId/resources/:resourceId
   @desc    Delete a specific resource from a course
   @access  Private (Educator / Admin)
============================================================ */
router.delete("/:courseId/resources/:resourceId", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId, resourceId } = req.params;

        const { error, status } = await verifyCourseOwnership(
            mysql, courseId, req.user.id, req.user.user_type, { requireEditable: true }
        );
        if (error) return errorResponse(res, error, status);

        const [[resource]] = await mysql.execute(
            `SELECT * FROM course_resources WHERE id = ? AND course_id = ? LIMIT 1`,
            [resourceId, courseId]
        );

        if (!resource) return errorResponse(res, "Resource not found", 404);

        await mysql.execute(
            `DELETE FROM course_resources WHERE id = ?`,
            [resourceId]
        );

        return successResponse(res, null, "Resource deleted successfully");
    } catch (error) {
        console.error("Delete Resource Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

module.exports = router;