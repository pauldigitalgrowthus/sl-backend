const express = require("express");
const { auth } = require("../../middleware/auth");
const { getMySQLConnection } = require("../../config/mysql");
const { successResponse, errorResponse } = require("../../utils/response");
const { courseThumbnailUpload } = require("../../config/s3")
const {
    sendEducatorNotification,
    EDUCATOR_NOTIFICATION_EVENTS
} = require("./utils/educatorNotificationService");

const router = express.Router();
const slugify = require("slugify");

/* ============================================================
   HELPER: Generate unique course slug
============================================================ */
const generateUniqueSlug = async (mysql, baseSlug) => {
    let slug = baseSlug;
    let counter = 1;

    while (true) {
        const [[existing]] = await mysql.execute(
            `SELECT id FROM courses WHERE slug = ? LIMIT 1`,
            [slug]
        );
        if (!existing) break;
        slug = `${baseSlug}-${counter}`;
        counter++;
    }

    return slug;
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
   HELPER: Format course row
============================================================ */
const formatCourse = (course) => ({
    ...course,
    learning_outcomes: parseJSON(course.learning_outcomes),
    technology_tools: parseJSON(course.technology_tools),
    downloadable_resources: parseJSON(course.downloadable_resources),
    proposal_data: parseJSON(course.proposal_data, {}),
});

/* ============================================================
   1️⃣ CREATE COURSE
   ------------------------------------------------------------
   @route   POST /api/educator/courses
   @desc    Educator creates a new course
   @access  Private (Educator)
============================================================ */

router.post("/", auth, courseThumbnailUpload.single("thumbnail"), async (req, res) => {
    try {
        const badges = JSON.parse(req.user.badges || "[]");

        const hasEducatorBadge = badges.some((badge) => badge.toLowerCase() === "educator");
        if (!hasEducatorBadge) {
            return errorResponse(res, "Only educators can create courses", 403);
        }

        const {
            course_title,
            short_description,
            full_description,
            category,
            subcategory,
            target_audience,
            learning_outcomes,
            technology_tools,
            downloadable_resources,
            language,
            level,
            estimated_duration_hours,
            course_type,
            price,
            currency,
            promo_video_url,
            visibility,
            completion_required_percentage,
            educator_application_id
        } = req.body;

        if (!course_title) {
            return errorResponse(res, "Course title is required", 400);
        }
        console.log(req.body)

        const mysql = getMySQLConnection();

        const baseSlug = slugify(course_title, { lower: true, strict: true });

        const slug = await generateUniqueSlug(mysql, baseSlug);

        // Thumbnail URL from S3
        const thumbnailUrl = req.file?.location || null;

        const parseJsonField = (field) => {
            if (!field) return null;
            if (typeof field === "string") {
                try {
                    return JSON.stringify(
                        JSON.parse(field)
                    );
                } catch {
                    return JSON.stringify([field]);
                }
            }
            return JSON.stringify(field);
        };

        const [result] = await mysql.execute(
            `INSERT INTO courses (
          educator_id,
          educator_application_id,
          course_title,
          slug,
          short_description,
          full_description,
          category,
          subcategory,
          target_audience,
          learning_outcomes,
          technology_tools,
          downloadable_resources,
          language,
          level,
          estimated_duration_hours,
          course_type,
          price,
          currency,
          thumbnail,
          promo_video_url,
          visibility,
          completion_required_percentage,
          status
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft'
        )`,
            [
                req.user.id,
                educator_application_id || null,
                course_title,
                slug,
                short_description || null,
                full_description || null,
                category || null,
                subcategory || null,
                target_audience || null,
                parseJsonField(learning_outcomes),
                parseJsonField(technology_tools),
                parseJsonField(downloadable_resources),
                language || "English",
                level || "beginner",
                estimated_duration_hours || 0,
                course_type || "free",
                price || 0,
                currency || "USD",
                thumbnailUrl,
                promo_video_url || null,
                visibility || "private",
                completion_required_percentage ||
                100
            ]
        );

        const [[createdCourse]] = await mysql.execute(
            `SELECT * FROM courses WHERE id = ? LIMIT 1`,
            [result.insertId]
        );

        try {
            createdCourse.learning_outcomes =
                createdCourse.learning_outcomes
                    ? JSON.parse(
                        createdCourse.learning_outcomes
                    )
                    : [];

            createdCourse.technology_tools =
                createdCourse.technology_tools
                    ? JSON.parse(
                        createdCourse.technology_tools
                    )
                    : [];

            createdCourse.downloadable_resources =
                createdCourse.downloadable_resources
                    ? JSON.parse(
                        createdCourse.downloadable_resources
                    )
                    : [];
        } catch (err) {
            console.error("JSON Parse Error:", err);
        }

        return successResponse(
            res, createdCourse, "Course created successfully", 201);
    } catch (error) {
        console.error("Create Course Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   2️⃣ GET MY COURSES
   ------------------------------------------------------------
   @route   GET /api/educator/courses/my
   @desc    Get all courses belonging to the logged-in educator
   @access  Private (Educator)
============================================================ */
router.get("/my", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();

        const page = Number(req.query.page) || 1;
        const limit = Number(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        const where = ["c.educator_id = ?", "c.deleted_at IS NULL"];
        const params = [req.user.id];

        if (req.query.status) {
            where.push("c.status = ?");
            params.push(req.query.status);
        }

        const whereClause = `WHERE ${where.join(" AND ")}`;

        const [courses] = await mysql.execute(
            `
            SELECT
                c.id,
                c.course_title,
                c.slug,
                c.short_description,
                c.full_description,
                c.category,
                c.subcategory,
                c.thumbnail,
                c.course_type,
                c.price,
                c.currency,
                c.language,
                c.level,
                c.visibility,
                c.status,
                c.total_chapters,
                c.total_lessons,
                c.total_students,
                c.is_featured,
                c.is_active,
                c.created_at,
                c.updated_at,

                u.first_name,
                u.last_name,
                u.email,
                u.avatar

            FROM courses c
            LEFT JOIN users u
                ON u.id = c.educator_id

            ${whereClause}

            ORDER BY c.created_at DESC
            LIMIT ? OFFSET ?
            `,
            [...params, limit, offset]
        );

        const [[count]] = await mysql.execute(
            `
            SELECT COUNT(*) AS total
            FROM courses c
            ${whereClause}
            `,
            params
        );

        return successResponse(
            res,
            {
                courses,
                pagination: {
                    page,
                    limit,
                    total: count.total,
                    totalPages: Math.ceil(count.total / limit)
                }
            },
            "Your courses fetched successfully"
        );

    } catch (error) {
        console.error(error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   3️⃣ GET ALL PUBLISHED COURSES (PUBLIC)
   ------------------------------------------------------------
   @route   GET /api/educator/courses/published
   @desc    Get all published & active courses
   @access  Public
============================================================ */
router.get("/published", async (req, res) => {
    try {
        const mysql = getMySQLConnection();

        let {
            page = 1,
            limit = 20,
            category,
            course_type,
            educator_id,
            search,
        } = req.query;

        page = parseInt(page, 10) || 1;
        limit = parseInt(limit, 10) || 20;

        if (page < 1) page = 1;
        if (limit < 1) limit = 20;

        const offset = (page - 1) * limit;

        let whereClause = `
            WHERE c.status = 'published'
            AND c.is_active = 1
            AND c.deleted_at IS NULL
        `;

        const params = [];

        if (category) {
            whereClause += ` AND c.category = ?`;
            params.push(category);
        }
        if (course_type) {
            whereClause += ` AND c.course_type = ?`;
            params.push(course_type);
        }
        if (educator_id) {
            whereClause += ` AND c.educator_id = ?`;
            params.push(educator_id);
        }
        if (search) {
            whereClause += ` AND (c.course_title LIKE ? OR c.short_description LIKE ?)`;
            params.push(`%${search}%`, `%${search}%`);
        }

        const coursesQuery = `
            SELECT
                c.id,
                c.course_title,
                c.slug,
                c.short_description,
                c.category,
                c.subcategory,
                c.course_type,
                c.price,
                c.currency,
                c.thumbnail,
                c.promo_video_url,
                c.level,
                c.language,
                c.estimated_duration_hours,
                c.total_chapters,
                c.total_lessons,
                c.total_students,
                c.is_featured,
                c.published_at,

                u.first_name AS educator_first_name,
                u.last_name AS educator_last_name,
                u.avatar AS educator_avatar

            FROM courses c
            LEFT JOIN users u
                ON u.id = c.educator_id

            ${whereClause}

            ORDER BY
                c.is_featured DESC,
                c.published_at DESC,
                c.created_at DESC

            LIMIT ? OFFSET ?
        `;

        const [courses] = await mysql.execute(coursesQuery, [
            ...params,
            limit,
            offset,
        ]);

        const countQuery = `
            SELECT COUNT(*) AS total
            FROM courses c
            ${whereClause}
        `;

        const [[count]] = await mysql.execute(countQuery, params);

        return successResponse(
            res,
            {
                courses,
                pagination: {
                    page,
                    limit,
                    total: count.total,
                    totalPages: Math.ceil(count.total / limit),
                },
            },
            "Published courses fetched successfully"
        );
    } catch (error) {
        console.error("Get Published Courses Error:", error);

        return errorResponse(
            res,
            error.message || "Internal Server Error",
            500
        );
    }
});
/* ============================================================
   4️⃣ GET SINGLE COURSE
   ------------------------------------------------------------
   @route   GET /api/educator/courses/:id
   @desc    Get single course by ID
   @access  Private
============================================================ */
router.get("/:id", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;

        const [[course]] = await mysql.execute(
            `SELECT
                c.*,
                u.first_name AS educator_first_name,
                u.last_name  AS educator_last_name,
                u.email      AS educator_email,
                u.avatar     AS educator_avatar
             FROM courses c
             LEFT JOIN users u ON c.educator_id = u.id
             WHERE c.id = ? AND c.deleted_at IS NULL
             LIMIT 1`,
            [id]
        );

        if (!course) {
            return errorResponse(res, "Course not found", 404);
        }

        /* Ownership check – educators can only see their own unless admin */
        const isAdmin = ["admin", "superadmin"].includes(req.user.user_type);
        if (!isAdmin && course.educator_id !== req.user.id && course.status !== "published") {
            return errorResponse(res, "Access denied", 403);
        }

        /* Fetch chapters with lesson count */
        const [chapters] = await mysql.execute(
            `SELECT ch.*, COUNT(cl.id) AS lesson_count
             FROM course_chapters ch
             LEFT JOIN course_lessons cl ON cl.chapter_id = ch.id AND cl.is_active = 1
             WHERE ch.course_id = ? AND ch.is_active = 1
             GROUP BY ch.id
             ORDER BY ch.chapter_order ASC`,
            [id]
        );

        return successResponse(
            res,
            { ...formatCourse(course), chapters },
            "Course fetched successfully"
        );
    } catch (error) {
        console.error("Get Course Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   5️⃣ UPDATE COURSE
   ------------------------------------------------------------
   @route   PUT /api/educator/courses/:id
   @desc    Update course details
   @access  Private (Educator – own course)
============================================================ */
router.put("/:id", auth, courseThumbnailUpload.single("thumbnail"), async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;

        const [[course]] = await mysql.execute(
            `SELECT * FROM courses WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
            [id]
        );

        if (!course) return errorResponse(res, "Course not found", 404);

        const isAdmin = ["admin", "superadmin"].includes(req.user.user_type);
        if (!isAdmin && course.educator_id !== req.user.id) {
            return errorResponse(res, "You can only update your own courses", 403);
        }

        /* Educators cannot update if pending review, rejected-pending-decision, or already published */
        const lockedStatuses = ["proposal_submitted", "proposal_rejected", "submitted_for_review", "approved", "published"];
        if (!isAdmin && lockedStatuses.includes(course.status)) {
            return errorResponse(res, `Cannot update course with status: ${course.status}`, 400);
        }

        const {
            course_title,
            short_description,
            full_description,
            category,
            subcategory,
            target_audience,
            learning_outcomes,
            technology_tools,
            downloadable_resources,
            language,
            level,
            estimated_duration_hours,
            course_type,
            price,
            currency,
            promo_video_url,
            visibility,
            completion_required_percentage
        } = req.body;

        let slug = course.slug;

        if (course_title && course_title !== course.course_title) {
            const baseSlug = slugify(course_title, { lower: true, strict: true });

            slug = await generateUniqueSlug(mysql, baseSlug);
        }

        // Thumbnail Handling
        let thumbnailUrl = course.thumbnail;

        if (req.file) {
            // Delete old thumbnail if exists
            if (course.thumbnail) {
                try {
                    await deleteFileFromS3(course.thumbnail);
                } catch (err) {
                    console.error("Thumbnail delete error:", err);
                }
            }
            thumbnailUrl = req.file.location;
        }

        const parseJsonField = (field) => {
            if (!field) return null;
            if (typeof field === "string") {
                try {
                    return JSON.stringify(JSON.parse(field));
                } catch {
                    return JSON.stringify([field]);
                }
            }
            return JSON.stringify(field);
        };

        await mysql.execute(
            `UPDATE courses SET
            course_title = ?,
            slug = ?,
            short_description = ?,
            full_description = ?,
            category = ?,
            subcategory = ?,
            target_audience = ?,
            learning_outcomes = ?,
            technology_tools = ?,
            downloadable_resources = ?,
            language = ?,
            level = ?,
            estimated_duration_hours = ?,
            course_type = ?,
            price = ?,
            currency = ?,
            thumbnail = ?,
            promo_video_url = ?,
            visibility = ?,
            completion_required_percentage = ?
         WHERE id = ?`,
            [
                course_title || course.course_title,
                slug,
                short_description ?? course.short_description,
                full_description ?? course.full_description,
                category ?? course.category,
                subcategory ?? course.subcategory,
                target_audience ?? course.target_audience,
                learning_outcomes ? parseJsonField(learning_outcomes) : course.learning_outcomes,

                technology_tools ? parseJsonField(technology_tools) : course.technology_tools,

                downloadable_resources ? parseJsonField(downloadable_resources) : course.downloadable_resources,
                language || course.language,
                level || course.level,
                estimated_duration_hours ?? course.estimated_duration_hours,
                course_type || course.course_type,
                price ?? course.price,
                currency || course.currency,
                thumbnailUrl,
                promo_video_url ?? course.promo_video_url,
                visibility || course.visibility,
                completion_required_percentage ?? course.completion_required_percentage,
                id
            ]
        );

        const [[updatedCourse]] = await mysql.execute(
            `SELECT * FROM courses WHERE id = ? LIMIT 1`,
            [id]
        );

        // Parse JSON columns
        try {
            updatedCourse.learning_outcomes =
                updatedCourse.learning_outcomes
                    ? JSON.parse(
                        updatedCourse.learning_outcomes
                    )
                    : [];

            updatedCourse.technology_tools =
                updatedCourse.technology_tools
                    ? JSON.parse(
                        updatedCourse.technology_tools
                    )
                    : [];

            updatedCourse.downloadable_resources =
                updatedCourse.downloadable_resources
                    ? JSON.parse(
                        updatedCourse.downloadable_resources
                    )
                    : [];
        } catch (err) {
            console.error("JSON Parse Error:", err);
        }

        return successResponse(res, updatedCourse, "Course updated successfully");
    } catch (error) {
        console.error("Update Course Error:", error);

        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   6️⃣ DELETE COURSE (SOFT DELETE)
   ------------------------------------------------------------
   @route   DELETE /api/educator/courses/:id
   @desc    Soft-delete a course
   @access  Private (Educator – own course / Admin)
============================================================ */
router.delete("/:id", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;

        const [[course]] = await mysql.execute(
            `SELECT * FROM courses WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
            [id]
        );

        if (!course) return errorResponse(res, "Course not found", 404);

        const isAdmin = ["admin", "superadmin"].includes(req.user.user_type);
        if (!isAdmin && course.educator_id !== req.user.id) {
            return errorResponse(res, "You can only delete your own courses", 403);
        }

        await mysql.execute(
            `UPDATE courses SET deleted_at = NOW(), is_active = 0 WHERE id = ?`,
            [id]
        );

        return successResponse(res, null, "Course deleted successfully");
    } catch (error) {
        console.error("Delete Course Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   7️⃣ SUBMIT COURSE FOR REVIEW
   ------------------------------------------------------------
   @route   POST /api/educator/courses/:id/submit
   @desc    Educator submits course for admin review
   @access  Private (Educator – own course)
============================================================ */
router.post("/:id/submit", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;

        const [[course]] = await mysql.execute(
            `SELECT * FROM courses WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
            [id]
        );

        if (!course) return errorResponse(res, "Course not found", 404);

        if (course.educator_id !== req.user.id) {
            return errorResponse(res, "You can only submit your own courses", 403);
        }

        const submittableStatuses = ["draft", "in_development", "revision_requested"];
        if (!submittableStatuses.includes(course.status)) {
            return errorResponse(
                res,
                `Course cannot be submitted from status: ${course.status}`,
                400
            );
        }

        /* Check course has at least one chapter and lesson */
        const [[{ chapterCount }]] = await mysql.execute(
            `SELECT COUNT(*) AS chapterCount FROM course_chapters WHERE course_id = ? AND is_active = 1`,
            [id]
        );
        if (chapterCount === 0) {
            return errorResponse(res, "Course must have at least one chapter before submitting", 400);
        }

        const [[{ lessonCount }]] = await mysql.execute(
            `SELECT COUNT(*) AS lessonCount FROM course_lessons WHERE course_id = ? AND is_active = 1`,
            [id]
        );
        if (lessonCount === 0) {
            return errorResponse(res, "Course must have at least one lesson before submitting", 400);
        }

        const oldStatus = course.status;

        /* Update course status */
        await mysql.execute(
            `UPDATE courses SET status = 'submitted_for_review' WHERE id = ?`,
            [id]
        );

        /* Log review action */
        await mysql.execute(
            `INSERT INTO course_review_logs (course_id, reviewer_id, action, notes)
             VALUES (?, ?, 'submitted', ?)`,
            [id, req.user.id, "Educator submitted course for review"]
        );

        /* Log status history */
        await mysql.execute(
            `INSERT INTO course_status_history (course_id, old_status, new_status, changed_by, remarks)
             VALUES (?, ?, 'submitted_for_review', ?, 'Submitted by educator')`,
            [id, oldStatus, req.user.id]
        );

        /* ============================================================
           NOTIFICATIONS (non-blocking - never breaks the response)
        ============================================================ */
        sendEducatorNotification({
            mysql,
            event: EDUCATOR_NOTIFICATION_EVENTS.COURSE_SUBMITTED_FOR_REVIEW,
            userId: course.educator_id,
            actorId: req.user.id,
            data: { courseTitle: course.course_title },
            metadata: { course_id: parseInt(id) }
        });

        return successResponse(res, null, "Course submitted for review successfully");
    } catch (error) {
        console.error("Submit Course Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   8️⃣ ARCHIVE / UNARCHIVE COURSE
   ------------------------------------------------------------
   @route   PUT /api/educator/courses/:id/archive
   @desc    Archive or unarchive a course by updating the
            is_archive flag (true/false)
   @access  Private (Admin / Super Admin)
   @body    { is_archive: true | false }
============================================================ */
router.put("/:id/archive", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;
        const { is_archive } = req.body;

        if (typeof is_archive !== "boolean") {
            return errorResponse(
                res,
                "is_archive must be true or false",
                400
            );
        }

        const [[course]] = await mysql.execute(
            `SELECT id FROM courses
             WHERE id = ? AND deleted_at IS NULL
             LIMIT 1`,
            [id]
        );

        if (!course) {
            return errorResponse(res, "Course not found", 404);
        }

        // const isAdmin = ["admin", "superadmin"].includes(req.user.user_type);

        // if (!isAdmin) {
        //     return errorResponse(
        //         res,
        //         "Only admins can archive/unarchive courses",
        //         403
        //     );
        // }

        await mysql.execute(
            `UPDATE courses
             SET is_archive = ?
             WHERE id = ?`,
            [is_archive, id]
        );

        return successResponse(
            res,
            {
                course_id: Number(id),
                is_archive
            },
            is_archive
                ? "Course archived successfully"
                : "Course unarchived successfully"
        );

    } catch (error) {
        console.error("Archive Course Error:", error);
        return errorResponse(res, error.message, 500);
    }
});


module.exports = router;