const express = require("express");
const { auth } = require("../../middleware/auth");
const { getMySQLConnection } = require("../../config/mysql");
const { successResponse, errorResponse } = require("../../utils/response");

const router = express.Router();

/* ============================================================
   HELPER: Statuses in which an educator may NOT modify course
   structure (chapters/lessons/resources/quizzes). SL Team/admin
   bypass this — same lock used everywhere else in the module.
============================================================ */
const NON_EDITABLE_STATUSES = [
    "proposal_submitted",
    "proposal_rejected",
    "submitted_for_review",
    "approved",
    "published"
];

const QUESTION_TYPES = [
    "mcq_single",
    "mcq_multiple",
    "true_false",
    "fill_blank",
    "matching",
    "ordering"
];

/* ============================================================
   HELPER: Safe JSON parse / stringify
============================================================ */
const parseJSON = (value, defaultValue = null) => {
    try {
        if (value === null || value === undefined || value === "") return defaultValue;
        return typeof value === "string" ? JSON.parse(value) : value;
    } catch {
        return defaultValue;
    }
};

const toJsonField = (value) => {
    if (value === undefined || value === null) return null;
    return typeof value === "string" ? value : JSON.stringify(value);
};

/* ============================================================
   HELPER: Verify course ownership (same contract as
   educator-course-chapters.js / educator-course-resources.js)
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
   HELPER: Load a quiz scoped to a course, with ownership check.
   Returns { error,status } | { course, quiz }
============================================================ */
const verifyQuizOwnership = async (mysql, courseId, quizId, userId, userType, opts = {}) => {
    const { course, error, status } = await verifyCourseOwnership(mysql, courseId, userId, userType, opts);
    if (error) return { error, status };

    const [[quiz]] = await mysql.execute(
        `SELECT * FROM quizzes WHERE id = ? AND course_id = ? AND deleted_at IS NULL LIMIT 1`,
        [quizId, courseId]
    );

    if (!quiz) return { error: "Quiz not found", status: 404 };

    return { course, quiz };
};

/* ============================================================
   HELPER: Validate a single question payload shape against its
   declared question_type before it ever reaches the DB.
============================================================ */
const validateQuestionPayload = ({ question_type, question_text, options, correct_answers }) => {
    if (!question_type || !QUESTION_TYPES.includes(question_type)) {
        return `question_type must be one of: ${QUESTION_TYPES.join(", ")}`;
    }
    if (!question_text || !String(question_text).trim()) {
        return "question_text is required";
    }
    if (correct_answers === undefined || correct_answers === null) {
        return "correct_answers is required";
    }

    switch (question_type) {
        case "mcq_single":
            if (!Array.isArray(options) || options.length < 2) {
                return "mcq_single requires at least 2 options";
            }
            if (!Array.isArray(correct_answers) || correct_answers.length !== 1) {
                return "mcq_single requires exactly 1 correct answer index";
            }
            break;

        case "mcq_multiple":
            if (!Array.isArray(options) || options.length < 2) {
                return "mcq_multiple requires at least 2 options";
            }
            if (!Array.isArray(correct_answers) || correct_answers.length < 1) {
                return "mcq_multiple requires at least 1 correct answer index";
            }
            break;

        case "true_false":
            if (!Array.isArray(correct_answers) || correct_answers.length !== 1 ||
                ![0, 1].includes(correct_answers[0])) {
                return "true_false requires correct_answers = [0] (True) or [1] (False)";
            }
            break;

        case "fill_blank":
            if (!Array.isArray(correct_answers) || correct_answers.length < 1) {
                return "fill_blank requires at least 1 accepted answer string";
            }
            break;

        case "matching":
            if (!options || !Array.isArray(options.left) || !Array.isArray(options.right)) {
                return "matching requires options = { left: [...], right: [...] }";
            }
            if (!Array.isArray(correct_answers) || correct_answers.length !== options.left.length) {
                return "matching correct_answers must have one [leftIndex,rightIndex] pair per left item";
            }
            break;

        case "ordering":
            if (!Array.isArray(options) || options.length < 2) {
                return "ordering requires at least 2 items to order";
            }
            if (!Array.isArray(correct_answers) || correct_answers.length !== options.length) {
                return "ordering correct_answers must list the correct index order for every item";
            }
            break;
    }

    return null;
};

/* ============================================================
   1️⃣ CREATE QUIZ  (lesson-level OR course-level)
   ------------------------------------------------------------
   @route   POST /api/educator/courses/:courseId/quizzes
   @desc    Educator Quiz Creation Flow Step 1-4 (doc section 4):
            choose level, add title/description.
   @access  Private (Educator)
   @body    {
              level: "lesson" | "course",
              lesson_id,                 // required if level = "lesson"
              title, description,
              questions_to_serve,        // optional here, can be set later
              unlock_mode                // "auto" | "manual", course-level only
            }
============================================================ */
router.post("/:courseId/quizzes", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId } = req.params;
        const { level, lesson_id, title, description, questions_to_serve, unlock_mode } = req.body;

        if (!title) return errorResponse(res, "Quiz title is required", 400);
        if (!level || !["lesson", "course"].includes(level)) {
            return errorResponse(res, "Quiz level must be 'lesson' or 'course'", 400);
        }
        if (level === "lesson" && !lesson_id) {
            return errorResponse(res, "lesson_id is required for a lesson-level quiz", 400);
        }

        const { error, status } = await verifyCourseOwnership(
            mysql, courseId, req.user.id, req.user.user_type, { requireEditable: true }
        );
        if (error) return errorResponse(res, error, status);

        if (level === "lesson") {
            const [[lesson]] = await mysql.execute(
                `SELECT id FROM course_lessons WHERE id = ? AND course_id = ? AND is_active = 1 LIMIT 1`,
                [lesson_id, courseId]
            );
            if (!lesson) return errorResponse(res, "Lesson not found in this course", 404);

            const [[existingQuiz]] = await mysql.execute(
                `SELECT id FROM quizzes WHERE lesson_id = ? AND deleted_at IS NULL LIMIT 1`,
                [lesson_id]
            );
            if (existingQuiz) {
                return errorResponse(res, "This lesson already has a quiz. Edit the existing one instead.", 400);
            }
        } else {
            const [[existingCourseQuiz]] = await mysql.execute(
                `SELECT id FROM quizzes WHERE course_id = ? AND level = 'course' AND deleted_at IS NULL LIMIT 1`,
                [courseId]
            );
            if (existingCourseQuiz) {
                return errorResponse(res, "This course already has a course-level quiz. Edit the existing one instead.", 400);
            }
        }

        const [result] = await mysql.execute(
            `INSERT INTO quizzes
                (course_id, lesson_id, level, title, description, questions_to_serve, unlock_mode, status, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
            [
                courseId,
                level === "lesson" ? lesson_id : null,
                level,
                title,
                description || null,
                questions_to_serve || 0,
                unlock_mode === "manual" ? "manual" : "auto",
                req.user.id
            ]
        );

        return successResponse(
            res,
            { id: result.insertId, level, status: "draft" },
            "Quiz created successfully. Add questions, then publish it.",
            201
        );
    } catch (error) {
        console.error("Create Quiz Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   2️⃣ GET QUIZZES FOR A COURSE
   ------------------------------------------------------------
   @route   GET /api/educator/courses/:courseId/quizzes
   @desc    List every quiz on the course — its course-level quiz
            (if any) plus every lesson-level quiz, with question
            counts. Optional ?lesson_id= filter.
   @access  Private (Educator / Admin)
============================================================ */
router.get("/:courseId/quizzes", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId } = req.params;
        const { lesson_id, level } = req.query;

        const { error, status } = await verifyCourseOwnership(
            mysql, courseId, req.user.id, req.user.user_type
        );
        if (error) return errorResponse(res, error, status);

        let whereClause = `WHERE q.course_id = ? AND q.deleted_at IS NULL`;
        const params = [courseId];

        if (lesson_id) {
            whereClause += ` AND q.lesson_id = ?`;
            params.push(lesson_id);
        }
        if (level && ["lesson", "course"].includes(level)) {
            whereClause += ` AND q.level = ?`;
            params.push(level);
        }

        const [quizzes] = await mysql.execute(
            `SELECT
                q.*,
                cl.title AS lesson_title,
                COUNT(qq.id) AS total_questions_added
             FROM quizzes q
             LEFT JOIN course_lessons cl ON q.lesson_id = cl.id
             LEFT JOIN quiz_questions qq ON qq.quiz_id = q.id AND qq.is_active = 1
             ${whereClause}
             GROUP BY q.id
             ORDER BY q.level ASC, q.created_at ASC`,
            params
        );

        return successResponse(res, quizzes, "Quizzes fetched successfully");
    } catch (error) {
        console.error("Get Quizzes Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   3️⃣ GET SINGLE QUIZ (with all its questions, full detail)
   ------------------------------------------------------------
   @route   GET /api/educator/courses/:courseId/quizzes/:quizId
   @desc    Educator-facing detail view — includes correct
            answers (NOT for student consumption; see the
            separate attempts route for the student-safe view).
   @access  Private (Educator / Admin)
============================================================ */
router.get("/:courseId/quizzes/:quizId", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId, quizId } = req.params;

        const { error, status, quiz } = await verifyQuizOwnership(
            mysql, courseId, quizId, req.user.id, req.user.user_type
        );
        if (error) return errorResponse(res, error, status);

        const [questions] = await mysql.execute(
            `SELECT * FROM quiz_questions
             WHERE quiz_id = ? AND is_active = 1
             ORDER BY question_order ASC, id ASC`,
            [quizId]
        );

        const formattedQuestions = questions.map((q) => ({
            ...q,
            options: parseJSON(q.options),
            correct_answers: parseJSON(q.correct_answers, [])
        }));

        return successResponse(
            res,
            { ...quiz, questions: formattedQuestions },
            "Quiz fetched successfully"
        );
    } catch (error) {
        console.error("Get Quiz Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   4️⃣ UPDATE QUIZ DETAILS
   ------------------------------------------------------------
   @route   PUT /api/educator/courses/:courseId/quizzes/:quizId
   @desc    Update title/description/questions_to_serve/unlock_mode.
            Educator can edit at any time, even after publishing
            (doc Step 5a note: "Educator can edit/add/subtract
            questions at any time within the quiz").
   @access  Private (Educator)
============================================================ */
router.put("/:courseId/quizzes/:quizId", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId, quizId } = req.params;
        const { title, description, questions_to_serve, unlock_mode } = req.body;

        const { error, status, quiz } = await verifyQuizOwnership(
            mysql, courseId, quizId, req.user.id, req.user.user_type, { requireEditable: true }
        );
        if (error) return errorResponse(res, error, status);

        if (questions_to_serve !== undefined) {
            const [[{ activeCount }]] = await mysql.execute(
                `SELECT COUNT(*) AS activeCount FROM quiz_questions WHERE quiz_id = ? AND is_active = 1`,
                [quizId]
            );
            if (Number(questions_to_serve) > activeCount) {
                return errorResponse(
                    res,
                    `questions_to_serve (${questions_to_serve}) cannot exceed the number of questions currently in the quiz (${activeCount})`,
                    400
                );
            }
        }

        await mysql.execute(
            `UPDATE quizzes SET
                title              = ?,
                description        = ?,
                questions_to_serve = ?,
                unlock_mode        = ?
             WHERE id = ?`,
            [
                title ?? quiz.title,
                description ?? quiz.description,
                questions_to_serve ?? quiz.questions_to_serve,
                unlock_mode && ["auto", "manual"].includes(unlock_mode) ? unlock_mode : quiz.unlock_mode,
                quizId
            ]
        );

        return successResponse(res, null, "Quiz updated successfully");
    } catch (error) {
        console.error("Update Quiz Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   5️⃣ PUBLISH / UNPUBLISH QUIZ
   ------------------------------------------------------------
   @route   PUT /api/educator/courses/:courseId/quizzes/:quizId/publish
   @desc    Doc Step 7. A quiz must have >= questions_to_serve
            active questions before it can be published, so
            students never hit a quiz that can't actually serve
            the configured number of questions.
   @access  Private (Educator)
   @body    { publish: true | false }
============================================================ */
router.put("/:courseId/quizzes/:quizId/publish", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId, quizId } = req.params;
        const { publish } = req.body;

        const { error, status, quiz } = await verifyQuizOwnership(
            mysql, courseId, quizId, req.user.id, req.user.user_type, { requireEditable: true }
        );
        if (error) return errorResponse(res, error, status);

        if (publish === false) {
            await mysql.execute(`UPDATE quizzes SET status = 'draft' WHERE id = ?`, [quizId]);
            return successResponse(res, null, "Quiz unpublished");
        }

        const [[{ activeCount }]] = await mysql.execute(
            `SELECT COUNT(*) AS activeCount FROM quiz_questions WHERE quiz_id = ? AND is_active = 1`,
            [quizId]
        );

        if (activeCount === 0) {
            return errorResponse(res, "Cannot publish a quiz with no questions", 400);
        }

        if (quiz.questions_to_serve === 0) {
            return errorResponse(res, "Set how many questions should be served per attempt before publishing", 400);
        }

        if (quiz.questions_to_serve > activeCount) {
            return errorResponse(
                res,
                `questions_to_serve (${quiz.questions_to_serve}) exceeds available questions (${activeCount})`,
                400
            );
        }

        await mysql.execute(`UPDATE quizzes SET status = 'published' WHERE id = ?`, [quizId]);

        return successResponse(res, null, "Quiz published successfully");
    } catch (error) {
        console.error("Publish Quiz Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   6️⃣ DELETE QUIZ (soft delete)
   ------------------------------------------------------------
   @route   DELETE /api/educator/courses/:courseId/quizzes/:quizId
   @access  Private (Educator / Admin)
============================================================ */
router.delete("/:courseId/quizzes/:quizId", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId, quizId } = req.params;

        const { error, status } = await verifyQuizOwnership(
            mysql, courseId, quizId, req.user.id, req.user.user_type, { requireEditable: true }
        );
        if (error) return errorResponse(res, error, status);

        await mysql.execute(`UPDATE quizzes SET deleted_at = NOW(), status = 'draft' WHERE id = ?`, [quizId]);

        return successResponse(res, null, "Quiz deleted successfully");
    } catch (error) {
        console.error("Delete Quiz Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================================================
   QUESTIONS
   ============================================================================================ */

/* ============================================================
   7️⃣ ADD QUESTION TO QUIZ
   ------------------------------------------------------------
   @route   POST /api/educator/courses/:courseId/quizzes/:quizId/questions
   @desc    Doc Step 5a: select type, add options, mark correct
            answer(s). Educator may add unlimited questions
            (doc Section 6A), even after the quiz is published.
   @access  Private (Educator)
   @body    { question_type, question_text, options, correct_answers, points }
============================================================ */
router.post("/:courseId/quizzes/:quizId/questions", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId, quizId } = req.params;
        const { question_type, question_text, options, correct_answers, points } = req.body;

        const { error, status } = await verifyQuizOwnership(
            mysql, courseId, quizId, req.user.id, req.user.user_type, { requireEditable: true }
        );
        if (error) return errorResponse(res, error, status);

        const validationError = validateQuestionPayload({ question_type, question_text, options, correct_answers });
        if (validationError) return errorResponse(res, validationError, 400);

        const [[{ maxOrder }]] = await mysql.execute(
            `SELECT COALESCE(MAX(question_order), 0) AS maxOrder FROM quiz_questions WHERE quiz_id = ?`,
            [quizId]
        );

        const [result] = await mysql.execute(
            `INSERT INTO quiz_questions
                (quiz_id, question_type, question_text, options, correct_answers, points, question_order)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                quizId,
                question_type,
                question_text,
                toJsonField(options),
                toJsonField(correct_answers),
                points || 1,
                maxOrder + 1
            ]
        );

        return successResponse(
            res,
            { id: result.insertId, question_order: maxOrder + 1 },
            "Question added successfully",
            201
        );
    } catch (error) {
        console.error("Add Question Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   8️⃣ UPDATE QUESTION
   ------------------------------------------------------------
   @route   PUT /api/educator/courses/:courseId/quizzes/:quizId/questions/:questionId
   @access  Private (Educator)
============================================================ */
router.put("/:courseId/quizzes/:quizId/questions/:questionId", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId, quizId, questionId } = req.params;
        const { question_type, question_text, options, correct_answers, points } = req.body;

        const { error, status } = await verifyQuizOwnership(
            mysql, courseId, quizId, req.user.id, req.user.user_type, { requireEditable: true }
        );
        if (error) return errorResponse(res, error, status);

        const [[question]] = await mysql.execute(
            `SELECT * FROM quiz_questions WHERE id = ? AND quiz_id = ? LIMIT 1`,
            [questionId, quizId]
        );
        if (!question) return errorResponse(res, "Question not found", 404);

        const mergedType = question_type || question.question_type;
        const mergedOptions = options !== undefined ? options : parseJSON(question.options);
        const mergedAnswers = correct_answers !== undefined ? correct_answers : parseJSON(question.correct_answers, []);
        const mergedText = question_text ?? question.question_text;

        const validationError = validateQuestionPayload({
            question_type: mergedType,
            question_text: mergedText,
            options: mergedOptions,
            correct_answers: mergedAnswers
        });
        if (validationError) return errorResponse(res, validationError, 400);

        await mysql.execute(
            `UPDATE quiz_questions SET
                question_type   = ?,
                question_text   = ?,
                options         = ?,
                correct_answers = ?,
                points          = ?
             WHERE id = ?`,
            [
                mergedType,
                mergedText,
                toJsonField(mergedOptions),
                toJsonField(mergedAnswers),
                points ?? question.points,
                questionId
            ]
        );

        return successResponse(res, null, "Question updated successfully");
    } catch (error) {
        console.error("Update Question Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   9️⃣ DELETE QUESTION (soft delete)
   ------------------------------------------------------------
   @route   DELETE /api/educator/courses/:courseId/quizzes/:quizId/questions/:questionId
   @desc    Soft delete only — past attempts that already served
            this question keep their own frozen snapshot (see
            quiz_attempts.selected_question_ids / answers), so
            deleting it here never breaks a student's past result.
   @access  Private (Educator)
============================================================ */
router.delete("/:courseId/quizzes/:quizId/questions/:questionId", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId, quizId, questionId } = req.params;

        const { error, status, quiz } = await verifyQuizOwnership(
            mysql, courseId, quizId, req.user.id, req.user.user_type, { requireEditable: true }
        );
        if (error) return errorResponse(res, error, status);

        const [[question]] = await mysql.execute(
            `SELECT id FROM quiz_questions WHERE id = ? AND quiz_id = ? AND is_active = 1 LIMIT 1`,
            [questionId, quizId]
        );
        if (!question) return errorResponse(res, "Question not found", 404);

        await mysql.execute(`UPDATE quiz_questions SET is_active = 0 WHERE id = ?`, [questionId]);

        /* If remaining active questions now fall below questions_to_serve
           on a published quiz, auto-revert it to draft so students don't
           hit a broken quiz mid-edit. */
        const [[{ activeCount }]] = await mysql.execute(
            `SELECT COUNT(*) AS activeCount FROM quiz_questions WHERE quiz_id = ? AND is_active = 1`,
            [quizId]
        );

        if (quiz.status === "published" && activeCount < quiz.questions_to_serve) {
            await mysql.execute(`UPDATE quizzes SET status = 'draft' WHERE id = ?`, [quizId]);
        }

        return successResponse(res, null, "Question deleted successfully");
    } catch (error) {
        console.error("Delete Question Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

module.exports = router;