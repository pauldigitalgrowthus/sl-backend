const express = require("express");
const { auth } = require("../../middleware/auth");
const { getMySQLConnection } = require("../../config/mysql");
const { successResponse, errorResponse } = require("../../utils/response");

const router = express.Router();

/* ============================================================
   HELPER: Safe JSON parse
============================================================ */
const parseJSON = (value, defaultValue = null) => {
    try {
        if (value === null || value === undefined || value === "") return defaultValue;
        return typeof value === "string" ? JSON.parse(value) : value;
    } catch {
        return defaultValue;
    }
};

/* ============================================================
   HELPER: Round to exactly 2 decimal places (doc Section 7 note:
   "round to two decimal places. Ex: 8.24/10, 82.40%")
============================================================ */
const round2 = (num) => Math.round((Number(num) + Number.EPSILON) * 100) / 100;

/* ============================================================
   HELPER: Fisher–Yates shuffle (used to randomly select N of the
   educator's total question pool — doc Section 1 / 6A: "Each
   time the user takes the quiz, they will get a different
   selection of 15 out of the 25 total questions")
============================================================ */
const shuffle = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
};

/* ============================================================
   HELPER: Verify the student is enrolled in the course that
   owns this quiz, and load the quiz itself (must be published).
============================================================ */
const loadPublishedQuiz = async (mysql, quizId, studentId) => {
    const [[quiz]] = await mysql.execute(
        `SELECT * FROM quizzes WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [quizId]
    );
    if (!quiz) return { error: "Quiz not found", status: 404 };

    if (quiz.status !== "published") {
        return { error: "This quiz is not yet available", status: 400 };
    }

    const [[enrollment]] = await mysql.execute(
        `SELECT id, progress_percentage, completed FROM course_enrollments
         WHERE course_id = ? AND student_id = ? LIMIT 1`,
        [quiz.course_id, studentId]
    );
    if (!enrollment) return { error: "You are not enrolled in this course", status: 403 };

    return { quiz, enrollment };
};

/* ============================================================
   HELPER: Decide if a quiz is unlocked for this student right now.
   - Lesson-level quiz: unlocked once that specific lesson is
     marked complete (doc Section 1A).
   - Course-level quiz: unlocked once course progress = 100%
     (unlock_mode = 'auto'), OR always unlocked once enrolled if
     the educator chose unlock_mode = 'manual' (doc Section 1B:
     "or based on educator settings").
============================================================ */
const checkUnlocked = async (mysql, quiz, studentId) => {
    if (quiz.level === "lesson") {
        const [[lessonProgress]] = await mysql.execute(
            `SELECT is_completed FROM lesson_progress
             WHERE lesson_id = ? AND student_id = ? LIMIT 1`,
            [quiz.lesson_id, studentId]
        );
        return !!lessonProgress?.is_completed;
    }

    // level === "course"
    if (quiz.unlock_mode === "manual") return true;

    const [[enrollment]] = await mysql.execute(
        `SELECT progress_percentage FROM course_enrollments
         WHERE course_id = ? AND student_id = ? LIMIT 1`,
        [quiz.course_id, studentId]
    );
    return (enrollment?.progress_percentage || 0) >= 100;
};

/* ============================================================
   HELPER: Auto-grade one answer against its question's
   correct_answers, per question_type contract (see mysql schema
   comment in quiz_questions for the exact shape per type).
============================================================ */
const gradeAnswer = (question, submittedAnswer) => {
    const correct = parseJSON(question.correct_answers, []);

    if (submittedAnswer === undefined || submittedAnswer === null) return false;

    switch (question.question_type) {
        case "mcq_single":
        case "true_false": {
            // submittedAnswer: single index (number)
            return Array.isArray(correct) && correct.length === 1 && Number(submittedAnswer) === Number(correct[0]);
        }

        case "mcq_multiple": {
            // submittedAnswer: array of indexes — must match the correct set exactly
            if (!Array.isArray(submittedAnswer) || !Array.isArray(correct)) return false;
            const a = [...submittedAnswer].map(Number).sort();
            const b = [...correct].map(Number).sort();
            return a.length === b.length && a.every((v, i) => v === b[i]);
        }

        case "fill_blank": {
            // submittedAnswer: string — matched case-insensitively against any accepted answer
            if (typeof submittedAnswer !== "string" || !Array.isArray(correct)) return false;
            const normalized = submittedAnswer.trim().toLowerCase();
            return correct.some((c) => String(c).trim().toLowerCase() === normalized);
        }

        case "matching": {
            // submittedAnswer: array of [leftIndex,rightIndex] pairs
            if (!Array.isArray(submittedAnswer) || !Array.isArray(correct)) return false;
            const sortedSubmitted = [...submittedAnswer].map((p) => p.join(":")).sort();
            const sortedCorrect = [...correct].map((p) => p.join(":")).sort();
            return sortedSubmitted.length === sortedCorrect.length &&
                sortedSubmitted.every((v, i) => v === sortedCorrect[i]);
        }

        case "ordering": {
            // submittedAnswer: array of indexes in the order the student placed them
            if (!Array.isArray(submittedAnswer) || !Array.isArray(correct)) return false;
            return submittedAnswer.length === correct.length &&
                submittedAnswer.every((v, i) => Number(v) === Number(correct[i]));
        }

        default:
            return false;
    }
};

/* ============================================================
   HELPER: Strip correct_answers out of a question before it's
   ever sent to a student mid-attempt.
============================================================ */
const toStudentSafeQuestion = (q) => ({
    id: q.id,
    question_type: q.question_type,
    question_text: q.question_text,
    options: parseJSON(q.options),
    points: q.points
});

/* ============================================================
   0️⃣ LIST PUBLISHED QUIZZES FOR A COURSE (student-safe)
   ------------------------------------------------------------
   @route   GET /api/educator/quiz-attempts/course/:courseId/list
   @desc    Lets an enrolled student see which quizzes exist for
            a course — its course-level (final) quiz, if any, and
            every lesson-level quiz — WITHOUT requiring course
            ownership like the educator-only
            /educator/courses/:courseId/quizzes route does.
            Only published quizzes are returned (drafts are never
            shown to students). Frontend uses this to decide which
            lessons show a "Quiz" button and whether to show the
            final-quiz banner.
   @access  Private (Enrolled Student)
============================================================ */
router.get("/course/:courseId/list", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId } = req.params;

        const [[enrollment]] = await mysql.execute(
            `SELECT id FROM course_enrollments WHERE course_id = ? AND student_id = ? LIMIT 1`,
            [courseId, req.user.id]
        );
        if (!enrollment) return errorResponse(res, "You are not enrolled in this course", 403);

        const [quizzes] = await mysql.execute(
            `SELECT id, course_id, lesson_id, level, title, description, questions_to_serve, unlock_mode, status
             FROM quizzes
             WHERE course_id = ? AND status = 'published' AND deleted_at IS NULL`,
            [courseId]
        );

        return successResponse(res, quizzes, "Published quizzes fetched");
    } catch (error) {
        console.error("List Course Quizzes (Student) Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   1️⃣ GET QUIZ STATUS (locked / unlocked / in-progress / done)
   ------------------------------------------------------------
   @route   GET /api/educator/quiz-attempts/:quizId/status
   @desc    Student-facing pre-check: is the quiz unlocked yet,
            and does the student already have an attempt (and in
            what state)? Drives the "Start Quiz" vs "Resume" vs
            "View Result" button on the frontend.
   @access  Private (Student)
============================================================ */
router.get("/:quizId/status", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { quizId } = req.params;

        const { error, status, quiz } = await loadPublishedQuiz(mysql, quizId, req.user.id);
        if (error) return errorResponse(res, error, status);

        const unlocked = await checkUnlocked(mysql, quiz, req.user.id);

        const [[attempt]] = await mysql.execute(
            `SELECT id, status, total_questions, correct_count, score_percentage, started_at, submitted_at
             FROM quiz_attempts WHERE quiz_id = ? AND student_id = ? LIMIT 1`,
            [quizId, req.user.id]
        );

        return successResponse(
            res,
            {
                quiz_id: quiz.id,
                title: quiz.title,
                level: quiz.level,
                unlocked,
                attempt: attempt || null
            },
            "Quiz status fetched"
        );
    } catch (error) {
        console.error("Get Quiz Status Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   2️⃣ START / RESUME QUIZ
   ------------------------------------------------------------
   @route   POST /api/educator/quiz-attempts/:quizId/start
   @desc    Doc Section 5 Step 3 + Section 6D (Pause & Resume):
            - If an 'in_progress' attempt already exists, return
              it as-is (resume — same questions, same answers so far).
            - Otherwise randomly select questions_to_serve questions
              out of the quiz's full active pool (doc Section 1/6A)
              and open a fresh attempt.
            Note: per doc Section 6C ("Unlimited Attempts ... once
            through that lesson/course"), starting again after a
            'completed' attempt creates a brand-new random selection
            and OVERWRITES the previous attempt row (doc Section 8).
   @access  Private (Student)
============================================================ */
router.post("/:quizId/start", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { quizId } = req.params;

        const { error, status, quiz } = await loadPublishedQuiz(mysql, quizId, req.user.id);
        if (error) return errorResponse(res, error, status);

        const unlocked = await checkUnlocked(mysql, quiz, req.user.id);
        if (!unlocked) {
            const reason = quiz.level === "lesson"
                ? "Complete the lesson to unlock this quiz"
                : "Complete the course to unlock the final quiz";
            return errorResponse(res, reason, 403);
        }

        const [[existingAttempt]] = await mysql.execute(
            `SELECT * FROM quiz_attempts WHERE quiz_id = ? AND student_id = ? LIMIT 1`,
            [quizId, req.user.id]
        );

        /* ---- Resume an in-progress attempt as-is ---- */
        if (existingAttempt && existingAttempt.status === "in_progress") {
            const selectedIds = parseJSON(existingAttempt.selected_question_ids, []);
            const placeholders = selectedIds.map(() => "?").join(",");

            const [questions] = selectedIds.length
                ? await mysql.execute(
                    `SELECT * FROM quiz_questions WHERE id IN (${placeholders})`,
                    selectedIds
                )
                : [[]];

            // preserve the original served order
            const orderedQuestions = selectedIds
                .map((id) => questions.find((q) => q.id === id))
                .filter(Boolean)
                .map(toStudentSafeQuestion);

            return successResponse(
                res,
                {
                    attempt_id: existingAttempt.id,
                    resumed: true,
                    answers_so_far: parseJSON(existingAttempt.answers, {}),
                    questions: orderedQuestions
                },
                "Resumed your in-progress attempt"
            );
        }

        /* ---- Fresh attempt: randomly select questions_to_serve questions ---- */
        const [pool] = await mysql.execute(
            `SELECT * FROM quiz_questions WHERE quiz_id = ? AND is_active = 1`,
            [quizId]
        );

        if (pool.length < quiz.questions_to_serve) {
            return errorResponse(res, "Quiz is misconfigured — not enough active questions available", 400);
        }

        const selected = shuffle(pool).slice(0, quiz.questions_to_serve);
        const selectedIds = selected.map((q) => q.id);

        await mysql.execute(
            `INSERT INTO quiz_attempts
                (quiz_id, course_id, student_id, selected_question_ids, answers, total_questions, status, started_at, submitted_at)
             VALUES (?, ?, ?, ?, ?, ?, 'in_progress', NOW(), NULL)
             ON DUPLICATE KEY UPDATE
                selected_question_ids = VALUES(selected_question_ids),
                answers               = VALUES(answers),
                total_questions       = VALUES(total_questions),
                correct_count         = 0,
                score_percentage      = 0,
                status                = 'in_progress',
                started_at            = NOW(),
                submitted_at          = NULL`,
            [
                quizId,
                quiz.course_id,
                req.user.id,
                JSON.stringify(selectedIds),
                JSON.stringify({}),
                quiz.questions_to_serve
            ]
        );

        return successResponse(
            res,
            {
                resumed: false,
                answers_so_far: {},
                questions: selected.map(toStudentSafeQuestion)
            },
            "Quiz started"
        );
    } catch (error) {
        console.error("Start Quiz Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   3️⃣ SAVE PROGRESS (answer one or more questions, no grading yet)
   ------------------------------------------------------------
   @route   PUT /api/educator/quiz-attempts/:quizId/save
   @desc    Doc Section 5 Step 5 (Pause & Resume support): lets the
            frontend persist answers as the student goes, without
            submitting/grading. Merges into whatever's already saved.
   @access  Private (Student)
   @body    { answers: { [question_id]: answerValue, ... } }
============================================================ */
router.put("/:quizId/save", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { quizId } = req.params;
        const { answers } = req.body;

        if (!answers || typeof answers !== "object") {
            return errorResponse(res, "answers object is required", 400);
        }

        const [[attempt]] = await mysql.execute(
            `SELECT * FROM quiz_attempts WHERE quiz_id = ? AND student_id = ? LIMIT 1`,
            [quizId, req.user.id]
        );

        if (!attempt) return errorResponse(res, "No active attempt found. Start the quiz first.", 404);
        if (attempt.status !== "in_progress") {
            return errorResponse(res, "This attempt has already been submitted", 400);
        }

        const merged = { ...parseJSON(attempt.answers, {}), ...answers };

        await mysql.execute(
            `UPDATE quiz_attempts SET answers = ? WHERE id = ?`,
            [JSON.stringify(merged), attempt.id]
        );

        return successResponse(res, null, "Progress saved");
    } catch (error) {
        console.error("Save Quiz Progress Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   4️⃣ SUBMIT QUIZ  (auto-evaluate + store as the latest attempt)
   ------------------------------------------------------------
   @route   POST /api/educator/quiz-attempts/:quizId/submit
   @desc    Doc Section 3 + Section 7 + Section 8:
            - Grades every served question automatically.
            - Computes correct_count / total_questions / score%
              rounded to 2 decimal places.
            - This is an UPDATE of the same row created in /start
              (UNIQUE quiz_id+student_id), so it naturally replaces
              whatever the previous completed attempt held — the
              "only the latest attempt is stored" rule.
   @access  Private (Student)
   @body    { answers: { [question_id]: answerValue, ... } }
            (optional — merges with anything already saved via /save)
============================================================ */
router.post("/:quizId/submit", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { quizId } = req.params;
        const { answers } = req.body;

        const [[attempt]] = await mysql.execute(
            `SELECT * FROM quiz_attempts WHERE quiz_id = ? AND student_id = ? LIMIT 1`,
            [quizId, req.user.id]
        );

        if (!attempt) return errorResponse(res, "No active attempt found. Start the quiz first.", 404);
        if (attempt.status !== "in_progress") {
            return errorResponse(res, "This attempt has already been submitted", 400);
        }

        const finalAnswers = { ...parseJSON(attempt.answers, {}), ...(answers || {}) };
        const selectedIds = parseJSON(attempt.selected_question_ids, []);

        const placeholders = selectedIds.map(() => "?").join(",");
        const [questions] = selectedIds.length
            ? await mysql.execute(`SELECT * FROM quiz_questions WHERE id IN (${placeholders})`, selectedIds)
            : [[]];

        let correctCount = 0;
        const gradedAnswers = {};

        for (const qId of selectedIds) {
            const question = questions.find((q) => q.id === qId);
            if (!question) {
                // question was hard-deleted (not just soft-deleted) — count as unanswered/wrong
                gradedAnswers[qId] = { submitted: finalAnswers[qId] ?? null, is_correct: false, deleted: true };
                continue;
            }

            const submitted = finalAnswers[qId];
            const isCorrect = gradeAnswer(question, submitted);
            if (isCorrect) correctCount++;

            gradedAnswers[qId] = { submitted: submitted ?? null, is_correct: isCorrect };
        }

        const totalQuestions = selectedIds.length;
        const scorePercentage = totalQuestions > 0 ? round2((correctCount / totalQuestions) * 100) : 0;

        await mysql.execute(
            `UPDATE quiz_attempts SET
                answers          = ?,
                total_questions  = ?,
                correct_count    = ?,
                score_percentage = ?,
                status           = 'completed',
                submitted_at     = NOW()
             WHERE id = ?`,
            [
                JSON.stringify(gradedAnswers),
                round2(totalQuestions),
                round2(correctCount),
                scorePercentage,
                attempt.id
            ]
        );

        return successResponse(
            res,
            {
                total_questions: round2(totalQuestions),
                correct_count: round2(correctCount),
                incorrect_count: round2(totalQuestions - correctCount),
                score_percentage: scorePercentage
            },
            "Quiz submitted — result calculated"
        );
    } catch (error) {
        console.error("Submit Quiz Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   5️⃣ GET LAST RESULT
   ------------------------------------------------------------
   @route   GET /api/educator/quiz-attempts/:quizId/result
   @desc    Doc Section 7: instant result display, and doc Step
            5a note: the student can always see their last
            attempt's result even if a question was since deleted
            — the snapshot in `answers` carries `deleted: true`
            for those instead of failing to load.
   @access  Private (Student)
============================================================ */
router.get("/:quizId/result", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { quizId } = req.params;

        const [[attempt]] = await mysql.execute(
            `SELECT * FROM quiz_attempts WHERE quiz_id = ? AND student_id = ? AND status = 'completed' LIMIT 1`,
            [quizId, req.user.id]
        );

        if (!attempt) return errorResponse(res, "No completed attempt found for this quiz", 404);

        const selectedIds = parseJSON(attempt.selected_question_ids, []);
        const placeholders = selectedIds.map(() => "?").join(",");
        const [questions] = selectedIds.length
            ? await mysql.execute(`SELECT * FROM quiz_questions WHERE id IN (${placeholders})`, selectedIds)
            : [[]];

        const gradedAnswers = parseJSON(attempt.answers, {});

        const breakdown = selectedIds.map((qId) => {
            const question = questions.find((q) => q.id === qId);
            const graded = gradedAnswers[qId] || {};

            if (!question) {
                return {
                    question_id: qId,
                    question_text: "[This question has since been removed by the educator]",
                    submitted: graded.submitted ?? null,
                    is_correct: !!graded.is_correct,
                    deleted: true
                };
            }

            return {
                question_id: qId,
                question_type: question.question_type,
                question_text: question.question_text,
                options: parseJSON(question.options),
                correct_answers: parseJSON(question.correct_answers, []),
                submitted: graded.submitted ?? null,
                is_correct: !!graded.is_correct
            };
        });

        return successResponse(
            res,
            {
                total_questions: attempt.total_questions,
                correct_count: attempt.correct_count,
                incorrect_count: round2(attempt.total_questions - attempt.correct_count),
                score_percentage: attempt.score_percentage,
                submitted_at: attempt.submitted_at,
                breakdown
            },
            "Last result fetched"
        );
    } catch (error) {
        console.error("Get Quiz Result Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

module.exports = router;