const express = require("express");
const { auth } = require("../../middleware/auth");
const { getMySQLConnection } = require("../../config/mysql");
const { successResponse, errorResponse } = require("../../utils/response");
const { CourseResourcesUpload } = require("../../config/s3");
const slugify = require("slugify");
const {
    sendEducatorNotification,
    EDUCATOR_NOTIFICATION_EVENTS
} = require("./utils/educatorNotificationService");

const router = express.Router();

/* ============================================================
   HELPER: Generate unique course slug (same logic as educator-courses.js)
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
   HELPER: Safe JSON stringify
============================================================ */
const toJsonField = (field) => {
    if (field === undefined || field === null || field === "") return null;
    if (typeof field === "string") {
        try {
            return JSON.stringify(JSON.parse(field));
        } catch {
            return JSON.stringify([field]);
        }
    }
    return JSON.stringify(field);
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

/* ============================================================
   SUBMIT COURSE PROPOSAL  ->  GATE 1 (idea review)
   ------------------------------------------------------------
   @route   POST /api/educator/courses/proposal
   @desc    Step 1 of the SL Educator publishing process.
            The educator is ONLY proposing an idea here — per the
            workflow doc: "the educator is not yet creating the
            full course". So this endpoint:

              -> creates a `courses` row with status = 'proposal_submitted'
                 using the real course columns for the parts that
                 are genuine course metadata (title, description,
                 category, target audience, learning outcomes, tools)

              -> stores everything that is proposal-only (module
                 outline, sample lesson plan, motivation) inside
                 `proposal_data` (JSON) — NOT into course_chapters /
                 course_lessons yet, because the course isn't being
                 built yet, it's being proposed.

              -> if a sample video file is uploaded, it is stored in
                 `course_resources` with lesson_id = NULL for now
                 (so reviewers can preview it during Gate-1 review).
                 It gets linked to the real sample lesson automatically
                 when/if the SL Team approves the proposal
                 (see educator-course-review.js -> approve-proposal).

            Nothing here ever sets status to 'submitted_for_review' —
            that only happens later, after the educator actually
            builds the full course and explicitly submits it
            (POST /courses/:id/submit), which is Gate 2.

   @access  Private — user MUST already have the "Educator" badge
            (i.e. their educator_application was already approved)
   @body    multipart/form-data
            {
              // Real course fields (saved directly on `courses`)
              course_title, course_description,
              target_audience, category, subcategory,
              learning_outcomes, technology_tools,

              // Proposal-only fields (saved into `proposal_data` JSON,
              // consumed only if/when the proposal is approved)
              modules,                  // JSON array: [{ title, description }]
              sample_lesson_title,
              sample_lesson_objective,
              teaching_flow,
              assessment_method,
              sample_video,             // file upload
              video_duration_minutes,
              motivation
            }
============================================================ */
router.post(
    "/proposal",
    auth,
    CourseResourcesUpload.single("sample_video"),
    async (req, res) => {
        const mysql = getMySQLConnection();
        let createdCourseId = null;

        try {
            /* ---------------- 0. Educator badge check ---------------- */
            const badges = parseJSON(req.user.badges, []);
            const hasEducatorBadge = badges.some(
                (badge) => String(badge).toLowerCase() === "educator"
            );

            if (!hasEducatorBadge) {
                return errorResponse(
                    res,
                    "Only approved educators can submit a course proposal. Please apply and get approved as an educator first.",
                    403
                );
            }

            const {
                course_title,
                course_description,
                target_audience,
                category,
                subcategory,
                learning_outcomes,
                technology_tools,

                modules,
                sample_lesson_title,
                sample_lesson_objective,
                teaching_flow,
                assessment_method,
                video_duration_minutes,
                motivation
            } = req.body;

            /* ---------------- Validation ---------------- */
            if (!course_title) return errorResponse(res, "Course title is required", 400);
            if (!course_description) return errorResponse(res, "Course description is required", 400);
            if (!target_audience) return errorResponse(res, "Target audience is required", 400);
            if (!category) return errorResponse(res, "Course category is required", 400);
            if (!modules) return errorResponse(res, "Course structure / modules are required", 400);
            if (!learning_outcomes) return errorResponse(res, "Learning outcomes are required", 400);
            if (!sample_lesson_title || !sample_lesson_objective) {
                return errorResponse(res, "Sample lesson title and objective are required", 400);
            }

            const parsedModules = parseJSON(modules, []);
            if (!Array.isArray(parsedModules) || parsedModules.length === 0) {
                return errorResponse(res, "At least one module is required", 400);
            }

            /* ============================================================
               courses table — real fields only, status = 'proposal_submitted'
               (NOT 'draft' — draft is for courses that already cleared
               Gate 1 and are actively being built)
            ============================================================ */
            const baseSlug = slugify(course_title, { lower: true, strict: true });
            const slug = await generateUniqueSlug(mysql, baseSlug);

            /* Proposal-only data, kept aside until Gate-1 approval */
            const proposalData = {
                modules: parsedModules,
                sample_lesson_title,
                sample_lesson_objective,
                teaching_flow: teaching_flow || null,
                assessment_method: assessment_method || null,
                video_duration_minutes: video_duration_minutes || 0,
                motivation: motivation || null
            };

            const [courseResult] = await mysql.execute(
                `INSERT INTO courses (
                    educator_id, course_title, slug, short_description, full_description,
                    category, subcategory, target_audience, learning_outcomes,
                    technology_tools, language, level, course_type, price, currency,
                    visibility, status, proposal_data
                 ) VALUES (
                    ?, ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?,
                    ?, 'proposal_submitted', ?
                 )`,
                [
                    req.user.id,
                    course_title,
                    slug,
                    course_description.slice(0, 500),
                    course_description,
                    category,
                    subcategory || null,
                    toJsonField(target_audience),
                    toJsonField(learning_outcomes),
                    toJsonField(technology_tools),
                    "English",
                    "beginner",
                    "free",
                    0,
                    "USD",
                    "private",
                    JSON.stringify(proposalData)
                ]
            );

            createdCourseId = courseResult.insertId;

            /* ============================================================
               Sample video (if any) — store now as a resource, not yet
               linked to a lesson (lesson doesn't exist until approval).
               Reviewers can still see/preview it during Gate-1 review.
            ============================================================ */
            if (req.file) {
                await mysql.execute(
                    `INSERT INTO course_resources
                        (course_id, lesson_id, file_name, file_url, file_type, file_size, uploaded_by)
                     VALUES (?, NULL, ?, ?, ?, ?, ?)`,
                    [
                        createdCourseId,
                        req.file.originalname,
                        req.file.location,
                        req.file.mimetype,
                        req.file.size,
                        req.user.id
                    ]
                );
            }

            /* ============================================================
               Log the submission (Gate 1 entry point)
            ============================================================ */
            await mysql.execute(
                `INSERT INTO course_review_logs (course_id, reviewer_id, action, notes)
                 VALUES (?, ?, 'submitted', ?)`,
                [createdCourseId, req.user.id, motivation || "Course proposal submitted for SL Team review"]
            );

            await mysql.execute(
                `INSERT INTO course_status_history (course_id, old_status, new_status, changed_by, remarks)
                 VALUES (?, NULL, 'proposal_submitted', ?, 'Proposal submitted by educator')`,
                [createdCourseId, req.user.id]
            );

            /* ---------------- Return created proposal ---------------- */
            const [[finalCourse]] = await mysql.execute(
                `SELECT * FROM courses WHERE id = ? LIMIT 1`,
                [createdCourseId]
            );

            finalCourse.learning_outcomes = parseJSON(finalCourse.learning_outcomes);
            finalCourse.technology_tools = parseJSON(finalCourse.technology_tools);
            finalCourse.target_audience = parseJSON(finalCourse.target_audience);
            finalCourse.proposal_data = parseJSON(finalCourse.proposal_data, {});

            /* ============================================================
               NOTIFICATIONS (non-blocking - never breaks the response)
            ============================================================ */
            sendEducatorNotification({
                mysql,
                event: EDUCATOR_NOTIFICATION_EVENTS.PROPOSAL_SUBMITTED,
                userId: req.user.id,
                actorId: req.user.id,
                data: { courseTitle: course_title },
                metadata: { course_id: createdCourseId }
            });

            return successResponse(
                res,
                finalCourse,
                "Your course proposal has been submitted successfully and sent to the SL Team for review",
                201
            );
        } catch (error) {
            console.error("Submit Course Proposal Error:", error);

            if (createdCourseId) {
                try {
                    await mysql.execute(`UPDATE courses SET deleted_at = NOW() WHERE id = ?`, [createdCourseId]);
                } catch (cleanupErr) {
                    console.error("Proposal cleanup failed:", cleanupErr);
                }
            }

            return errorResponse(res, error.message, 500);
        }
    }
);

module.exports = router;