const express = require("express");
const { auth } = require("../../middleware/auth");
const { getMySQLConnection } = require("../../config/mysql");
const { successResponse, errorResponse } = require("../../utils/response");

const router = express.Router();

/* ============================================================================================
   STUDENT "LEARN" MODULE
   ------------------------------------------------------------------------------------------
   Everything a logged-in, enrolled student needs to actually GO THROUGH a course lives here,
   all scoped under /:courseId so the frontend only ever talks to ONE router for the player:

     GET  /api/educator/learn/:courseId                                   -> full course view
     POST /api/educator/learn/:courseId/lessons/:lessonId/complete        -> mark lesson done
     POST /api/educator/learn/:courseId/lessons/:lessonId/incomplete      -> undo
     GET  /api/educator/learn/:courseId/quizzes/:quizId/status            -> locked/unlocked/attempt state
     POST /api/educator/learn/:courseId/quizzes/:quizId/start             -> start / resume attempt
     PUT  /api/educator/learn/:courseId/quizzes/:quizId/save              -> save answers (no grading)
     POST /api/educator/learn/:courseId/quizzes/:quizId/submit            -> submit + auto-grade
     GET  /api/educator/learn/:courseId/quizzes/:quizId/result            -> last graded result + breakdown
     GET  /api/educator/learn/:courseId/report                            -> full progress + all quiz scores

   Course completion is NEVER a manual action — it's derived automatically inside
   recalculateProgress() every time a lesson is completed/uncompleted, exactly like
   educator-course-progress.js already did. Once every mandatory lesson is done,
   course_enrollments.completed flips to 1 by itself.
============================================================================================ */

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
   HELPER: Round to exactly 2 decimal places
============================================================ */
const round2 = (num) => Math.round((Number(num) + Number.EPSILON) * 100) / 100;

/* ============================================================
   HELPER: Fisher–Yates shuffle — used to randomly serve N of
   the total question pool on each fresh quiz attempt.
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
   HELPER: Strip correct_answers out of a quiz/question before
   it's ever sent to a student (except inside /result, which is
   the one place answers are meant to be revealed).
============================================================ */
const toStudentSafeQuiz = (quiz) => ({
    id: quiz.id,
    course_id: quiz.course_id,
    lesson_id: quiz.lesson_id,
    level: quiz.level,
    title: quiz.title,
    description: quiz.description,
    questions_to_serve: quiz.questions_to_serve,
    unlock_mode: quiz.unlock_mode,
    status: quiz.status
});

const toStudentSafeQuestion = (q) => ({
    id: q.id,
    question_type: q.question_type,
    question_text: q.question_text,
    options: parseJSON(q.options),
    points: q.points
});

/* ============================================================
   HELPER: Auto-grade one answer against its question's
   correct_answers, per question_type contract.
============================================================ */
const gradeAnswer = (question, submittedAnswer) => {
    const correct = parseJSON(question.correct_answers, []);
    if (submittedAnswer === undefined || submittedAnswer === null) return false;

    switch (question.question_type) {
        case "mcq_single":
        case "true_false": {
            return Array.isArray(correct) && correct.length === 1 && Number(submittedAnswer) === Number(correct[0]);
        }
        case "mcq_multiple": {
            if (!Array.isArray(submittedAnswer) || !Array.isArray(correct)) return false;
            const a = [...submittedAnswer].map(Number).sort();
            const b = [...correct].map(Number).sort();
            return a.length === b.length && a.every((v, i) => v === b[i]);
        }
        case "fill_blank": {
            if (typeof submittedAnswer !== "string" || !Array.isArray(correct)) return false;
            const normalized = submittedAnswer.trim().toLowerCase();
            return correct.some((c) => String(c).trim().toLowerCase() === normalized);
        }
        case "matching": {
            if (!Array.isArray(submittedAnswer) || !Array.isArray(correct)) return false;
            const sortedSubmitted = [...submittedAnswer].map((p) => p.join(":")).sort();
            const sortedCorrect = [...correct].map((p) => p.join(":")).sort();
            return sortedSubmitted.length === sortedCorrect.length &&
                sortedSubmitted.every((v, i) => v === sortedCorrect[i]);
        }
        case "ordering": {
            if (!Array.isArray(submittedAnswer) || !Array.isArray(correct)) return false;
            return submittedAnswer.length === correct.length &&
                submittedAnswer.every((v, i) => Number(v) === Number(correct[i]));
        }
        default:
            return false;
    }
};

/* ============================================================
   HELPER: Verify the student is enrolled (or previewing as
   owner/admin) in courseId. Returns { error,status } | { course, enrollment }
============================================================ */
const verifyEnrollment = async (mysql, courseId, userId, userType) => {
    const [[course]] = await mysql.execute(
        `SELECT id, educator_id FROM courses WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [courseId]
    );
    if (!course) return { error: "Course not found", status: 404 };

    const [[enrollment]] = await mysql.execute(
        `SELECT id, progress_percentage, completed FROM course_enrollments
         WHERE course_id = ? AND student_id = ? LIMIT 1`,
        [courseId, userId]
    );

    const isAdmin = ["admin", "superadmin"].includes(userType);
    const isOwner = course.educator_id === userId;

    if (!enrollment && !isAdmin && !isOwner) {
        return { error: "You are not enrolled in this course", status: 403 };
    }

    return { course, enrollment };
};

/* ============================================================
   HELPER: Recalculate and persist a student's overall course
   progress percentage + completion flag. This is the ONLY place
   course_enrollments.completed ever flips — course completion is
   always derived, never a manual student action.
============================================================ */
const recalculateProgress = async (mysql, courseId, studentId) => {
    const [[{ totalLessons }]] = await mysql.execute(
        `SELECT COUNT(*) AS totalLessons
         FROM course_lessons
         WHERE course_id = ? AND is_active = 1 AND is_mandatory = 1`,
        [courseId]
    );

    if (totalLessons === 0) return { percentage: 0, isCompleted: false };

    const [[{ completedLessons }]] = await mysql.execute(
        `SELECT COUNT(*) AS completedLessons
         FROM lesson_progress
         WHERE course_id = ? AND student_id = ? AND is_completed = 1`,
        [courseId, studentId]
    );

    const percentage = Math.min(100, Math.floor((completedLessons / totalLessons) * 100));
    const isCompleted = percentage >= 100;

    await mysql.execute(
        `UPDATE course_enrollments
         SET progress_percentage = ?, completed = ?, completed_at = ?
         WHERE course_id = ? AND student_id = ?`,
        [percentage, isCompleted ? 1 : 0, isCompleted ? new Date() : null, courseId, studentId]
    );

    return { percentage, isCompleted };
};

/* ============================================================
   HELPER: Is this quiz unlocked for this student right now?
   - Lesson quiz  -> unlocked once that lesson is completed.
   - Course quiz  -> unlocked at 100% course progress, OR always
     if the educator set unlock_mode = 'manual'.
============================================================ */
const checkUnlocked = async (mysql, quiz, studentId) => {
    if (quiz.level === "lesson") {
        const [[lessonProgress]] = await mysql.execute(
            `SELECT is_completed FROM lesson_progress WHERE lesson_id = ? AND student_id = ? LIMIT 1`,
            [quiz.lesson_id, studentId]
        );
        return !!lessonProgress?.is_completed;
    }
    if (quiz.unlock_mode === "manual") return true;
    const [[enrollment]] = await mysql.execute(
        `SELECT progress_percentage FROM course_enrollments WHERE course_id = ? AND student_id = ? LIMIT 1`,
        [quiz.course_id, studentId]
    );
    return (enrollment?.progress_percentage || 0) >= 100;
};

/* ============================================================
   HELPER: Load a published quiz that belongs to :courseId, and
   confirm the student is enrolled in that course.
============================================================ */
const loadCourseQuiz = async (mysql, courseId, quizId, studentId) => {
    const [[quiz]] = await mysql.execute(
        `SELECT * FROM quizzes WHERE id = ? AND course_id = ? AND deleted_at IS NULL LIMIT 1`,
        [quizId, courseId]
    );
    if (!quiz) return { error: "Quiz not found in this course", status: 404 };
    if (quiz.status !== "published") return { error: "This quiz is not yet available", status: 400 };

    const [[enrollment]] = await mysql.execute(
        `SELECT id FROM course_enrollments WHERE course_id = ? AND student_id = ? LIMIT 1`,
        [courseId, studentId]
    );
    if (!enrollment) return { error: "You are not enrolled in this course", status: 403 };

    return { quiz };
};

/* ============================================================================================
   1️⃣ GET FULL "LEARN" VIEW OF AN ENROLLED COURSE
   ------------------------------------------------------------
   @route   GET /api/educator/learn/:courseId
   @access  Private (Enrolled Student / course owner & admin can preview)
============================================================================================ */
router.get("/:courseId", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId } = req.params;
        const studentId = req.user.id;

        const [[course]] = await mysql.execute(
            `SELECT
                c.id, c.course_title, c.slug, c.short_description, c.full_description,
                c.category, c.subcategory, c.target_audience, c.learning_outcomes,
                c.thumbnail, c.promo_video_url, c.technology_tools, c.downloadable_resources,
                c.language, c.level, c.estimated_duration_hours, c.completion_required_percentage,
                c.course_type, c.price, c.currency, c.status, c.total_chapters, c.total_lessons,
                c.total_students,
                u.id         AS educator_id,
                u.first_name AS educator_first_name,
                u.last_name  AS educator_last_name,
                u.avatar     AS educator_avatar
             FROM courses c
             LEFT JOIN users u ON c.educator_id = u.id
             WHERE c.id = ? AND c.deleted_at IS NULL LIMIT 1`,
            [courseId]
        );
        if (!course) return errorResponse(res, "Course not found", 404);

        const [[enrollment]] = await mysql.execute(
            `SELECT id, enrolled_at, progress_percentage, completed, completed_at
             FROM course_enrollments WHERE course_id = ? AND student_id = ? LIMIT 1`,
            [courseId, studentId]
        );

        const isAdmin = ["admin", "superadmin"].includes(req.user.user_type);
        const isOwner = course.educator_id === studentId;
        if (!enrollment && !isAdmin && !isOwner) {
            return errorResponse(res, "You are not enrolled in this course", 403);
        }

        const [chapters] = await mysql.execute(
            `SELECT id, title, description, chapter_order, is_preview
             FROM course_chapters WHERE course_id = ? AND is_active = 1
             ORDER BY chapter_order ASC`,
            [courseId]
        );

        const [lessons] = await mysql.execute(
            `SELECT
                cl.id, cl.chapter_id, cl.title, cl.lesson_type, cl.content, cl.video_url,
                cl.link_url, cl.link_title,
                cl.video_duration_minutes, cl.downloadable_files, cl.lesson_order,
                cl.is_preview, cl.is_mandatory,
                COALESCE(lp.is_completed, 0)       AS is_completed,
                lp.completed_at,
                COALESCE(lp.time_spent_minutes, 0) AS time_spent_minutes
             FROM course_lessons cl
             LEFT JOIN lesson_progress lp ON lp.lesson_id = cl.id AND lp.student_id = ?
             WHERE cl.course_id = ? AND cl.is_active = 1
             ORDER BY cl.lesson_order ASC`,
            [studentId, courseId]
        );

        const lessonIds = lessons.map((l) => l.id);

        let resourcesByLesson = {};
        if (lessonIds.length) {
            const placeholders = lessonIds.map(() => "?").join(",");
            const [resources] = await mysql.execute(
                `SELECT id, lesson_id, file_name, file_url, file_type, file_size, created_at
                 FROM course_resources
                 WHERE course_id = ? AND lesson_id IN (${placeholders})
                 ORDER BY created_at DESC`,
                [courseId, ...lessonIds]
            );
            resourcesByLesson = resources.reduce((acc, r) => {
                (acc[r.lesson_id] ||= []).push(r);
                return acc;
            }, {});
        }

        const [quizzes] = await mysql.execute(
            `SELECT
                q.id, q.course_id, q.lesson_id, q.level, q.title, q.description,
                q.questions_to_serve, q.unlock_mode, q.status,
                a.id                AS attempt_id,
                a.status            AS attempt_status,
                a.total_questions   AS attempt_total_questions,
                a.correct_count     AS attempt_correct_count,
                a.score_percentage  AS attempt_score_percentage,
                a.started_at        AS attempt_started_at,
                a.submitted_at      AS attempt_submitted_at
             FROM quizzes q
             LEFT JOIN quiz_attempts a ON a.quiz_id = q.id AND a.student_id = ?
             WHERE q.course_id = ? AND q.status = 'published' AND q.deleted_at IS NULL`,
            [studentId, courseId]
        );

        const lessonCompletionMap = lessons.reduce((acc, l) => {
            acc[l.id] = !!l.is_completed;
            return acc;
        }, {});
        const courseProgressPct = enrollment?.progress_percentage || 0;

        const formatQuiz = (q) => {
            const unlocked = q.level === "lesson"
                ? !!lessonCompletionMap[q.lesson_id]
                : (q.unlock_mode === "manual" ? true : courseProgressPct >= 100);

            return {
                ...toStudentSafeQuiz(q),
                unlocked,
                attempt: q.attempt_id
                    ? {
                        id: q.attempt_id,
                        status: q.attempt_status,
                        total_questions: q.attempt_total_questions,
                        correct_count: q.attempt_correct_count,
                        score_percentage: q.attempt_score_percentage,
                        started_at: q.attempt_started_at,
                        submitted_at: q.attempt_submitted_at
                    }
                    : null
            };
        };

        const lessonQuizByLessonId = {};
        let finalQuiz = null;
        quizzes.forEach((q) => {
            const formatted = formatQuiz(q);
            if (q.level === "lesson") lessonQuizByLessonId[q.lesson_id] = formatted;
            else finalQuiz = formatted;
        });

        const formattedLessons = lessons.map((l) => {
            const rawType = (l.lesson_type || "").toLowerCase();
            return {
                id: l.id,
                chapter_id: l.chapter_id,
                title: l.title,
                lesson_type: l.lesson_type,
                content: l.content,
                video_url: l.video_url,
                link_url: l.link_url || (rawType === "external_link" ? l.video_url : null),
                link_title: l.link_title || null,
                video_duration_minutes: l.video_duration_minutes,
                downloadable_files: parseJSON(l.downloadable_files, []),
                lesson_order: l.lesson_order,
                is_preview: !!l.is_preview,
                is_mandatory: !!l.is_mandatory,
                is_completed: !!l.is_completed,
                completed_at: l.completed_at,
                time_spent_minutes: l.time_spent_minutes,
                resources: resourcesByLesson[l.id] || [],
                quiz: lessonQuizByLessonId[l.id] || null
            };
        });

        const chaptersWithLessons = chapters.map((chapter) => {
            const chapterLessons = formattedLessons
                .filter((l) => l.chapter_id === chapter.id)
                .sort((a, b) => a.lesson_order - b.lesson_order);
            return {
                id: chapter.id,
                title: chapter.title,
                description: chapter.description,
                chapter_order: chapter.chapter_order,
                is_preview: !!chapter.is_preview,
                total_lessons: chapterLessons.length,
                completed_lessons: chapterLessons.filter((l) => l.is_completed).length,
                lessons: chapterLessons
            };
        });

        const nextLesson = formattedLessons.find((l) => l.is_mandatory && !l.is_completed) || null;

        return successResponse(
            res,
            {
                course: {
                    ...course,
                    target_audience: parseJSON(course.target_audience, []),
                    learning_outcomes: parseJSON(course.learning_outcomes, []),
                    technology_tools: parseJSON(course.technology_tools, []),
                    downloadable_resources: parseJSON(course.downloadable_resources, [])
                },
                enrollment: enrollment
                    ? {
                        id: enrollment.id,
                        enrolled_at: enrollment.enrolled_at,
                        progress_percentage: enrollment.progress_percentage,
                        completed: !!enrollment.completed,
                        completed_at: enrollment.completed_at
                    }
                    : null,
                is_preview_mode: !enrollment && (isAdmin || isOwner),
                next_lesson_id: nextLesson ? nextLesson.id : null,
                final_quiz: finalQuiz,
                chapters: chaptersWithLessons
            },
            "Course learning data fetched successfully"
        );
    } catch (error) {
        console.error("Get Learn Course Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================================================
   2️⃣ MARK LESSON AS COMPLETED
   ------------------------------------------------------------
   @route   POST /api/educator/learn/:courseId/lessons/:lessonId/complete
   @desc    Marks the lesson done, recalculates course progress, and
            (automatically, no separate call needed) flips the course
            to "completed" once every mandatory lesson is done.
   @access  Private (Enrolled Student)
   @body    { time_spent_minutes? }
============================================================================================ */
router.post("/:courseId/lessons/:lessonId/complete", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId, lessonId } = req.params;
        const { time_spent_minutes } = req.body;
        const studentId = req.user.id;

        const [[enrollment]] = await mysql.execute(
            `SELECT id FROM course_enrollments WHERE course_id = ? AND student_id = ? LIMIT 1`,
            [courseId, studentId]
        );
        if (!enrollment) return errorResponse(res, "You are not enrolled in this course", 403);

        const [[lesson]] = await mysql.execute(
            `SELECT id FROM course_lessons WHERE id = ? AND course_id = ? AND is_active = 1 LIMIT 1`,
            [lessonId, courseId]
        );
        if (!lesson) return errorResponse(res, "Lesson not found in this course", 404);

        await mysql.execute(
            `INSERT INTO lesson_progress
                (course_id, lesson_id, student_id, is_completed, completed_at, time_spent_minutes)
             VALUES (?, ?, ?, 1, NOW(), ?)
             ON DUPLICATE KEY UPDATE
                is_completed       = 1,
                completed_at       = NOW(),
                time_spent_minutes = time_spent_minutes + VALUES(time_spent_minutes)`,
            [courseId, lessonId, studentId, time_spent_minutes || 0]
        );

        const { percentage, isCompleted } = await recalculateProgress(mysql, courseId, studentId);

        return successResponse(
            res,
            {
                lesson_id: parseInt(lessonId),
                progress_percentage: percentage,
                course_completed: isCompleted
            },
            isCompleted
                ? "Lesson completed — 🎉 you've finished the whole course!"
                : "Lesson marked as completed"
        );
    } catch (error) {
        console.error("Complete Lesson Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================================================
   3️⃣ MARK LESSON AS INCOMPLETE (UNDO)
   ------------------------------------------------------------
   @route   POST /api/educator/learn/:courseId/lessons/:lessonId/incomplete
   @access  Private (Enrolled Student)
============================================================================================ */
router.post("/:courseId/lessons/:lessonId/incomplete", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId, lessonId } = req.params;
        const studentId = req.user.id;

        const [[enrollment]] = await mysql.execute(
            `SELECT id FROM course_enrollments WHERE course_id = ? AND student_id = ? LIMIT 1`,
            [courseId, studentId]
        );
        if (!enrollment) return errorResponse(res, "You are not enrolled in this course", 403);

        await mysql.execute(
            `UPDATE lesson_progress SET is_completed = 0, completed_at = NULL
             WHERE course_id = ? AND lesson_id = ? AND student_id = ?`,
            [courseId, lessonId, studentId]
        );

        const { percentage, isCompleted } = await recalculateProgress(mysql, courseId, studentId);

        return successResponse(
            res,
            { lesson_id: parseInt(lessonId), progress_percentage: percentage, course_completed: isCompleted },
            "Lesson marked as incomplete"
        );
    } catch (error) {
        console.error("Incomplete Lesson Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================================================
   4️⃣ QUIZ STATUS (locked / unlocked / in-progress / done)
   ------------------------------------------------------------
   @route   GET /api/educator/learn/:courseId/quizzes/:quizId/status
   @access  Private (Enrolled Student)
============================================================================================ */
router.get("/:courseId/quizzes/:quizId/status", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId, quizId } = req.params;
        const studentId = req.user.id;

        const { error, status, quiz } = await loadCourseQuiz(mysql, courseId, quizId, studentId);
        if (error) return errorResponse(res, error, status);

        const unlocked = await checkUnlocked(mysql, quiz, studentId);

        const [[attempt]] = await mysql.execute(
            `SELECT id, status, total_questions, correct_count, score_percentage, started_at, submitted_at
             FROM quiz_attempts WHERE quiz_id = ? AND student_id = ? LIMIT 1`,
            [quizId, studentId]
        );

        return successResponse(
            res,
            { quiz_id: quiz.id, title: quiz.title, level: quiz.level, unlocked, attempt: attempt || null },
            "Quiz status fetched"
        );
    } catch (error) {
        console.error("Quiz Status Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================================================
   5️⃣ START / RESUME QUIZ
   ------------------------------------------------------------
   @route   POST /api/educator/learn/:courseId/quizzes/:quizId/start
   @desc    Resumes an in_progress attempt as-is, otherwise randomly
            selects questions_to_serve questions and opens a fresh
            attempt (overwriting any previous completed attempt —
            unlimited attempts, only the latest is kept).
   @access  Private (Enrolled Student)
============================================================================================ */
router.post("/:courseId/quizzes/:quizId/start", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId, quizId } = req.params;
        const studentId = req.user.id;

        const { error, status, quiz } = await loadCourseQuiz(mysql, courseId, quizId, studentId);
        if (error) return errorResponse(res, error, status);

        const unlocked = await checkUnlocked(mysql, quiz, studentId);
        if (!unlocked) {
            const reason = quiz.level === "lesson"
                ? "Complete the lesson to unlock this quiz"
                : "Complete the course to unlock the final quiz";
            return errorResponse(res, reason, 403);
        }

        const [[existingAttempt]] = await mysql.execute(
            `SELECT * FROM quiz_attempts WHERE quiz_id = ? AND student_id = ? LIMIT 1`,
            [quizId, studentId]
        );

        if (existingAttempt && existingAttempt.status === "in_progress") {
            const selectedIds = parseJSON(existingAttempt.selected_question_ids, []);
            const placeholders = selectedIds.map(() => "?").join(",");
            const [questions] = selectedIds.length
                ? await mysql.execute(`SELECT * FROM quiz_questions WHERE id IN (${placeholders})`, selectedIds)
                : [[]];

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
                answers                = VALUES(answers),
                total_questions        = VALUES(total_questions),
                correct_count          = 0,
                score_percentage       = 0,
                status                 = 'in_progress',
                started_at             = NOW(),
                submitted_at           = NULL`,
            [quizId, courseId, studentId, JSON.stringify(selectedIds), JSON.stringify({}), quiz.questions_to_serve]
        );

        return successResponse(
            res,
            { resumed: false, answers_so_far: {}, questions: selected.map(toStudentSafeQuestion) },
            "Quiz started"
        );
    } catch (error) {
        console.error("Start Quiz Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================================================
   6️⃣ SAVE QUIZ PROGRESS (answer questions, no grading yet)
   ------------------------------------------------------------
   @route   PUT /api/educator/learn/:courseId/quizzes/:quizId/save
   @body    { answers: { [question_id]: answerValue, ... } }
   @access  Private (Enrolled Student)
============================================================================================ */
router.put("/:courseId/quizzes/:quizId/save", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId, quizId } = req.params;
        const { answers } = req.body;
        const studentId = req.user.id;

        if (!answers || typeof answers !== "object") {
            return errorResponse(res, "answers object is required", 400);
        }

        const [[quizExists]] = await mysql.execute(
            `SELECT id FROM quizzes WHERE id = ? AND course_id = ? AND deleted_at IS NULL LIMIT 1`,
            [quizId, courseId]
        );
        if (!quizExists) return errorResponse(res, "Quiz not found in this course", 404);

        const [[attempt]] = await mysql.execute(
            `SELECT * FROM quiz_attempts WHERE quiz_id = ? AND student_id = ? LIMIT 1`,
            [quizId, studentId]
        );
        if (!attempt) return errorResponse(res, "No active attempt found. Start the quiz first.", 404);
        if (attempt.status !== "in_progress") {
            return errorResponse(res, "This attempt has already been submitted", 400);
        }

        const merged = { ...parseJSON(attempt.answers, {}), ...answers };

        await mysql.execute(`UPDATE quiz_attempts SET answers = ? WHERE id = ?`, [JSON.stringify(merged), attempt.id]);

        return successResponse(res, null, "Progress saved");
    } catch (error) {
        console.error("Save Quiz Progress Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================================================
   7️⃣ SUBMIT QUIZ (auto-evaluate)
   ------------------------------------------------------------
   @route   POST /api/educator/learn/:courseId/quizzes/:quizId/submit
   @body    { answers? } — optional, merges with anything already saved via /save
   @access  Private (Enrolled Student)
============================================================================================ */
router.post("/:courseId/quizzes/:quizId/submit", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId, quizId } = req.params;
        const { answers } = req.body;
        const studentId = req.user.id;

        const [[quizExists]] = await mysql.execute(
            `SELECT id FROM quizzes WHERE id = ? AND course_id = ? AND deleted_at IS NULL LIMIT 1`,
            [quizId, courseId]
        );
        if (!quizExists) return errorResponse(res, "Quiz not found in this course", 404);

        const [[attempt]] = await mysql.execute(
            `SELECT * FROM quiz_attempts WHERE quiz_id = ? AND student_id = ? LIMIT 1`,
            [quizId, studentId]
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
            [JSON.stringify(gradedAnswers), round2(totalQuestions), round2(correctCount), scorePercentage, attempt.id]
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

/* ============================================================================================
   8️⃣ GET LAST QUIZ RESULT (with full answer breakdown)
   ------------------------------------------------------------
   @route   GET /api/educator/learn/:courseId/quizzes/:quizId/result
   @access  Private (Enrolled Student)
============================================================================================ */
router.get("/:courseId/quizzes/:quizId/result", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId, quizId } = req.params;
        const studentId = req.user.id;

        const [[quizExists]] = await mysql.execute(
            `SELECT id FROM quizzes WHERE id = ? AND course_id = ? AND deleted_at IS NULL LIMIT 1`,
            [quizId, courseId]
        );
        if (!quizExists) return errorResponse(res, "Quiz not found in this course", 404);

        const [[attempt]] = await mysql.execute(
            `SELECT * FROM quiz_attempts WHERE quiz_id = ? AND student_id = ? AND status = 'completed' LIMIT 1`,
            [quizId, studentId]
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

/* ============================================================================================
   9️⃣ FULL COURSE REPORT (own progress + every quiz score, one call)
   ------------------------------------------------------------
   @route   GET /api/educator/learn/:courseId/report
   @desc    A single "my report card" view — overall course progress
            + completion, plus every published quiz's last attempt
            (lesson quizzes and the final quiz), so the student can
            see all their scores in one place without re-fetching
            each quiz's /result individually.
   @access  Private (Enrolled Student)
============================================================================================ */
router.get("/:courseId/report", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId } = req.params;
        const studentId = req.user.id;

        const { error, status, enrollment } = await verifyEnrollment(mysql, courseId, studentId, req.user.user_type);
        if (error) return errorResponse(res, error, status);
        if (!enrollment) return errorResponse(res, "You are not enrolled in this course", 403);

        const [[lessonStats]] = await mysql.execute(
            `SELECT
                COUNT(*) AS total_mandatory_lessons,
                SUM(CASE WHEN lp.is_completed = 1 THEN 1 ELSE 0 END) AS completed_mandatory_lessons
             FROM course_lessons cl
             LEFT JOIN lesson_progress lp ON lp.lesson_id = cl.id AND lp.student_id = ?
             WHERE cl.course_id = ? AND cl.is_active = 1 AND cl.is_mandatory = 1`,
            [studentId, courseId]
        );

        const [quizRows] = await mysql.execute(
            `SELECT
                q.id, q.level, q.title, q.lesson_id, cl.title AS lesson_title,
                a.status AS attempt_status, a.total_questions, a.correct_count,
                a.score_percentage, a.submitted_at
             FROM quizzes q
             LEFT JOIN course_lessons cl ON cl.id = q.lesson_id
             LEFT JOIN quiz_attempts a ON a.quiz_id = q.id AND a.student_id = ?
             WHERE q.course_id = ? AND q.status = 'published' AND q.deleted_at IS NULL
             ORDER BY q.level ASC, cl.lesson_order ASC`,
            [studentId, courseId]
        );

        const quizReports = quizRows.map((q) => ({
            quiz_id: q.id,
            level: q.level,
            title: q.title,
            lesson_id: q.lesson_id,
            lesson_title: q.lesson_title,
            attempted: !!q.attempt_status,
            completed: q.attempt_status === "completed",
            total_questions: q.total_questions,
            correct_count: q.correct_count,
            score_percentage: q.score_percentage,
            submitted_at: q.submitted_at
        }));

        const completedQuizzes = quizReports.filter((q) => q.completed);
        const averageQuizScore = completedQuizzes.length
            ? round2(completedQuizzes.reduce((sum, q) => sum + Number(q.score_percentage), 0) / completedQuizzes.length)
            : null;

        return successResponse(
            res,
            {
                course_id: parseInt(courseId),
                progress_percentage: enrollment.progress_percentage,
                completed: !!enrollment.completed,
                total_mandatory_lessons: lessonStats.total_mandatory_lessons,
                completed_mandatory_lessons: lessonStats.completed_mandatory_lessons || 0,
                total_quizzes: quizReports.length,
                quizzes_attempted: quizReports.filter((q) => q.attempted).length,
                average_quiz_score: averageQuizScore,
                quizzes: quizReports
            },
            "Course report fetched successfully"
        );
    } catch (error) {
        console.error("Get Course Report Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

module.exports = router;