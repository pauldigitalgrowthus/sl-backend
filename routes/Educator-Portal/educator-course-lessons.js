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
   HELPER: Verify chapter & course ownership
============================================================ */
const verifyChapterAccess = async (mysql, courseId, chapterId, userId, userType, { requireEditable = false } = {}) => {
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

    const [[chapter]] = await mysql.execute(
        `SELECT id FROM course_chapters WHERE id = ? AND course_id = ? AND is_active = 1 LIMIT 1`,
        [chapterId, courseId]
    );

    if (!chapter) return { error: "Chapter not found", status: 404 };

    return { course, chapter };
};

/* ============================================================
   HELPER: Safe JSON parser
============================================================ */
const parseJSON = (value, defaultValue = []) => {
    try {
        if (!value) return defaultValue;
        return typeof value === "string" ? JSON.parse(value) : value;
    } catch {
        return defaultValue;
    }
};

/* ============================================================
   1️⃣ CREATE LESSON
   ------------------------------------------------------------
   @route   POST /api/educator/courses/:courseId/chapters/:chapterId/lessons
   @desc    Add a new lesson to a chapter
   @access  Private (Educator)
============================================================ */
router.post("/:courseId/chapters/:chapterId/lessons", auth, CourseResourcesUpload.fields([
    { name: "video_url", maxCount: 1 },
    { name: "downloadable_files", maxCount: 1 },
    { name: "resources", maxCount: 20 }
]),
    async (req, res) => {
        try {
            const mysql = getMySQLConnection();
            const { courseId, chapterId } = req.params;

            const {
                title,
                lesson_type,
                content,
                video_duration_minutes,
                is_preview,
                is_mandatory
            } = req.body;

            if (!title) {
                return errorResponse(res, "Lesson title is required", 400);
            }

            const VALID_TYPES = ["video", "text", "pdf", "audio", "quiz", "assignment", "external_link"];

            if (lesson_type && !VALID_TYPES.includes(lesson_type)) {
                return errorResponse(res, `Invalid lesson type. Must be one of: ${VALID_TYPES.join(", ")}`, 400);
            }

            const { error, status } = await verifyChapterAccess(
                mysql, courseId, chapterId, req.user.id, req.user.user_type, { requireEditable: true }
            );

            if (error) {
                return errorResponse(res, error, status);
            }

            const [[{ maxOrder }]] = await mysql.execute(
                `SELECT COALESCE(MAX(lesson_order),0) AS maxOrder
                 FROM course_lessons
                 WHERE chapter_id=?`,
                [chapterId]
            );

            // uploaded files

            const videoFile =
                req.files?.video_url &&
                    req.files.video_url.length
                    ? req.files.video_url[0]
                    : null;

            const downloadFile =
                req.files?.downloadable_files &&
                    req.files.downloadable_files.length
                    ? req.files.downloadable_files[0]
                    : null;

            const resourceFiles = req.files?.resources || [];

            // external link support

            let videoUrl = null;

            if (videoFile) {
                videoUrl = videoFile.location;
            } else if (req.body.video_url) {
                videoUrl = req.body.video_url;
            }

            let downloadableFiles = null;

            if (downloadFile) {
                downloadableFiles = JSON.stringify([
                    {
                        file_name: downloadFile.originalname,
                        file_url: downloadFile.location,
                        file_type: downloadFile.mimetype,
                        file_size: downloadFile.size
                    }
                ]);
            } else if (req.body.downloadable_files) {
                downloadableFiles = req.body.downloadable_files;
            }

            const [lessonResult] = await mysql.execute(
                `INSERT INTO course_lessons
                (
                    course_id,
                    chapter_id,
                    title,
                    lesson_type,
                    content,
                    video_url,
                    video_duration_minutes,
                    downloadable_files,
                    lesson_order,
                    is_preview,
                    is_mandatory
                )
                VALUES
                (?,?,?,?,?,?,?,?,?,?,?)`,
                [
                    courseId,
                    chapterId,
                    title,
                    lesson_type || "video",
                    content || null,
                    videoUrl,
                    video_duration_minutes || 0,
                    downloadableFiles,
                    maxOrder + 1,
                    is_preview === "true" || is_preview == 1 ? 1 : 0,
                    is_mandatory === "true" || is_mandatory == 1 ? 1 : 0
                ]
            );

            const lessonId = lessonResult.insertId;

            // save lesson resources

            const insertedResources = [];

            if (resourceFiles.length) {

                for (const file of resourceFiles) {

                    const [resource] = await mysql.execute(
                        `INSERT INTO course_resources
                        (
                            course_id,
                            lesson_id,
                            file_name,
                            file_url,
                            file_type,
                            file_size,
                            uploaded_by
                        )
                        VALUES
                        (?,?,?,?,?,?,?)`,
                        [
                            courseId,
                            lessonId,
                            file.originalname,
                            file.location,
                            file.mimetype,
                            file.size,
                            req.user.id
                        ]
                    );

                    insertedResources.push({
                        id: resource.insertId,
                        file_name: file.originalname,
                        file_url: file.location,
                        file_type: file.mimetype,
                        file_size: file.size
                    });
                }
            }

            await mysql.execute(
                `UPDATE courses
                 SET total_lessons = total_lessons + 1
                 WHERE id=?`,
                [courseId]
            );

            return successResponse(
                res,
                {
                    id: lessonId,
                    lesson_order: maxOrder + 1,
                    resources: insertedResources
                },
                "Lesson created successfully",
                201
            );

        } catch (error) {
            console.error("Create Lesson Error:", error);
            return errorResponse(res, error.message, 500);
        }
    });

/* ============================================================
   2️⃣ GET LESSONS BY CHAPTER
   ------------------------------------------------------------
   @route   GET /api/educator/courses/:courseId/chapters/:chapterId/lessons
   @desc    Fetch all lessons within a chapter
   @access  Private
============================================================ */
router.get("/:courseId/chapters/:chapterId/lessons", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId, chapterId } = req.params;

        const { error, status } = await verifyChapterAccess(
            mysql,
            courseId,
            chapterId,
            req.user.id,
            req.user.user_type
        );

        if (error) return errorResponse(res, error, status);

        // Get Lessons
        const [lessons] = await mysql.execute(
            `SELECT *
             FROM course_lessons
             WHERE chapter_id = ? 
               AND course_id = ? 
               AND is_active = 1
             ORDER BY lesson_order ASC`,
            [chapterId, courseId]
        );

        if (!lessons.length) {
            return successResponse(res, [], "Lessons fetched successfully");
        }

        // Get all resources for these lessons
        const lessonIds = lessons.map((l) => l.id);
        const placeholders = lessonIds.map(() => "?").join(",");
        const [resources] = await mysql.execute(
            `SELECT
                r.*,
                u.first_name AS uploaded_by_first_name,
                u.last_name  AS uploaded_by_last_name
             FROM course_resources r
             LEFT JOIN users u ON r.uploaded_by = u.id
             WHERE r.course_id = ?
               AND r.lesson_id IN (${placeholders})
             ORDER BY r.created_at DESC`,
            [courseId, ...lessonIds]
        );

        // Group resources by lesson_id
        const resourcesMap = {};

        resources.forEach((resource) => {
            if (!resourcesMap[resource.lesson_id]) {
                resourcesMap[resource.lesson_id] = [];
            }

            resourcesMap[resource.lesson_id].push(resource);
        });

        const formatted = lessons.map((lesson) => ({
            ...lesson,
            downloadable_files: parseJSON(lesson.downloadable_files),
            resources: resourcesMap[lesson.id] || []
        }));

        return successResponse(res, formatted, "Lessons fetched successfully");
    } catch (error) {
        console.error("Get Lessons Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   3️⃣ UPDATE LESSON
   ------------------------------------------------------------
   @route   PUT /api/educator/courses/:courseId/chapters/:chapterId/lessons/:lessonId
   @desc    Update lesson content, type, or metadata
   @access  Private (Educator)
============================================================ */
router.put("/:courseId/chapters/:chapterId/lessons/:lessonId", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId, chapterId, lessonId } = req.params;

        const {
            title,
            lesson_type,
            content,
            video_url,
            video_duration_minutes,
            downloadable_files,
            lesson_order,
            is_preview,
            is_mandatory
        } = req.body;

        const { error, status } = await verifyChapterAccess(
            mysql, courseId, chapterId, req.user.id, req.user.user_type, { requireEditable: true }
        );
        if (error) return errorResponse(res, error, status);

        const [[lesson]] = await mysql.execute(
            `SELECT * FROM course_lessons
             WHERE id = ? AND chapter_id = ? AND course_id = ? AND is_active = 1 LIMIT 1`,
            [lessonId, chapterId, courseId]
        );

        if (!lesson) return errorResponse(res, "Lesson not found", 404);

        const VALID_TYPES = ["video", "text", "pdf", "audio", "quiz", "assignment"];
        if (lesson_type && !VALID_TYPES.includes(lesson_type)) {
            return errorResponse(res, `Invalid lesson type. Must be one of: ${VALID_TYPES.join(", ")}`, 400);
        }

        await mysql.execute(
            `UPDATE course_lessons SET
                title                   = ?,
                lesson_type             = ?,
                content                 = ?,
                video_url               = ?,
                video_duration_minutes  = ?,
                downloadable_files      = ?,
                lesson_order            = ?,
                is_preview              = ?,
                is_mandatory            = ?
             WHERE id = ?`,
            [
                title ?? lesson.title,
                lesson_type || lesson.lesson_type,
                content ?? lesson.content,
                video_url ?? lesson.video_url,
                video_duration_minutes ?? lesson.video_duration_minutes,
                downloadable_files ? JSON.stringify(downloadable_files) : lesson.downloadable_files,
                lesson_order ?? lesson.lesson_order,
                is_preview !== undefined ? (is_preview ? 1 : 0) : lesson.is_preview,
                is_mandatory !== undefined ? (is_mandatory ? 1 : 0) : lesson.is_mandatory,
                lessonId
            ]
        );

        return successResponse(res, null, "Lesson updated successfully");
    } catch (error) {
        console.error("Update Lesson Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   4️⃣ DELETE LESSON
   ------------------------------------------------------------
   @route   DELETE /api/educator/courses/:courseId/chapters/:chapterId/lessons/:lessonId
   @desc    Soft-delete a lesson (deactivate)
   @access  Private (Educator)
============================================================ */
router.delete("/:courseId/chapters/:chapterId/lessons/:lessonId", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId, chapterId, lessonId } = req.params;

        const { error, status } = await verifyChapterAccess(
            mysql, courseId, chapterId, req.user.id, req.user.user_type, { requireEditable: true }
        );
        if (error) return errorResponse(res, error, status);
        const [[lesson]] = await mysql.execute(
            `SELECT id FROM course_lessons
             WHERE id = ? AND chapter_id = ? AND course_id = ? AND is_active = 1 LIMIT 1`,
            [lessonId, chapterId, courseId]
        );

        if (!lesson) return errorResponse(res, "Lesson not found", 404);

        await mysql.execute(
            `UPDATE course_lessons SET is_active = 0 WHERE id = ?`,
            [lessonId]
        );

        /* Recalculate course lesson count */
        const [[{ total_lessons }]] = await mysql.execute(
            `SELECT COUNT(*) AS total_lessons FROM course_lessons WHERE course_id = ? AND is_active = 1`,
            [courseId]
        );

        await mysql.execute(
            `UPDATE courses SET total_lessons = ? WHERE id = ?`,
            [total_lessons, courseId]
        );

        return successResponse(res, null, "Lesson deleted successfully");
    } catch (error) {
        console.error("Delete Lesson Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

module.exports = router;