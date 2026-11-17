const express = require("express");
const router = express.Router();

// ================= IMPORT ROUTES =================
const educatorToolsRoutes = require("./educator-tools");
const educatorApplicationRoutes = require("./educator-application");
const educatorCoursesRoutes = require("./educator-courses");
const educatorChaptersRoutes = require("./educator-course-chapters");
const educatorLessonsRoutes = require("./educator-course-lessons");
const educatorReviewRoutes = require("./educator-course-review");
const educatorResourcesRoutes = require("./educator-course-resources");
const educatorEnrollmentsRoutes = require("./educator-course-enrollments");
const educatorProgressRoutes = require("./educator-course-progress");
const educatorCourseProposalRoutes = require("./educator-course-proposal");
const educatorQuizzesRoutes = require("./educator-course-quizzes");
const educatorQuizAttemptsRoutes = require("./educator-quiz-attempts");
const educatorCourseLearnRoutes = require("./educator-course-learn");
const educatorCartRoutes = require("./educator-cart");
const educatorCourseDraftsRoutes = require("./educator-course-drafts");
const educatorCourseMasterRoutes = require("./educator-course-master");
const educatorPaymentEnrollmentHistoryRoutes = require("./educator-payment-enrollment-history");

// ================= EDUCATOR TOOLS =================
// @route   /api/educator/tools
// @desc    Educator tools management
// @access  Private
router.use("/tools", educatorToolsRoutes);


// ================= EDUCATOR APPLICATION =================
// @route   /api/educator/application
// @desc    Educator application (submit, approve, reject)
// @access  Private
router.use("/application", educatorApplicationRoutes);


// ================= COURSE MANAGEMENT =================
// @route   /api/educator/courses
// @desc    Course CRUD + submit for review
// @access  Private (Educator / Admin)
router.use("/courses", educatorCoursesRoutes);


// ================= COURSE CHAPTERS =================
// @route   /api/educator/courses/:courseId/chapters
// @desc    Chapter management (create, update, delete, reorder)
// @access  Private (Educator / Admin)
router.use("/courses", educatorChaptersRoutes);


// ================= COURSE LESSONS =================
// @route   /api/educator/courses/:courseId/chapters/:chapterId/lessons
// @desc    Lesson management (create, update, delete)
// @access  Private (Educator / Admin)
router.use("/courses", educatorLessonsRoutes);
router.use("/courses", educatorCourseProposalRoutes);


// ================= COURSE RESOURCES =================
// @route   /api/educator/courses/:courseId/resources
// @desc    Upload & manage course resources (PDFs, ZIPs, slides)
// @access  Private (Educator / Admin)
router.use("/courses", educatorResourcesRoutes);


// ================= COURSE QUIZZES (EDUCATOR) =================
// @route   /api/educator/courses/:courseId/quizzes
// @desc    Create/manage lesson-level & course-level quizzes +
//          their questions, publish/unpublish
// @access  Private (Educator / Admin)
router.use("/courses", educatorQuizzesRoutes);


// ================= QUIZ ATTEMPTS (STUDENT) =================
// @route   /api/educator/quiz-attempts/:quizId/...
// @desc    Student quiz flow: unlock status, start/resume,
//          save progress, submit + auto-evaluate, view last result
// @access  Private (Student)
router.use("/quiz-attempts", educatorQuizAttemptsRoutes);


// ================= COURSE REVIEW (ADMIN / SL TEAM) =================
// @route   /api/educator/review
// @desc    Admin review flow (approve, reject, publish, request revision)
// @access  Private (Admin / SL Team)
router.use("/review", educatorReviewRoutes);


// ================= COURSE ENROLLMENTS =================
// @route   /api/educator/enrollments
// @desc    Student enrollment (free & paid) + my learning
// @access  Private
router.use("/enrollments", educatorEnrollmentsRoutes);


// ================= CART =================
// @route   /api/educator/cart
// @desc    Add/remove paid courses to a cart, then checkout the
//          whole cart in a single Stripe payment (multi-course).
//          This is now the primary path for buying paid courses;
//          see educator-cart.js for the full flow.
// @access  Private (Student)
router.use("/cart", educatorCartRoutes);


// ================= COURSE PROGRESS =================
// @route   /api/educator/progress
// @desc    Lesson progress tracking & course completion
// @access  Private
router.use("/progress", educatorProgressRoutes);


// ================= STUDENT "LEARN" VIEW (CONSOLIDATED) =================
// @route   /api/educator/learn/:courseId
// @desc    One-shot read view for the course player: course info +
//          enrollment progress + chapters -> lessons (completion,
//          resources) + quizzes (unlock status, last attempt) all
//          in a single response. Actions (complete lesson, start/
//          submit quiz) still go through /progress and /quiz-attempts.
// @access  Private (Enrolled Student)
router.use("/learn", educatorCourseLearnRoutes);


// ================= COURSE DRAFTS =================
// @route   /api/educator/course-drafts
// @desc    Save, update, fetch and delete course draft
// @access  Private
router.use("/course-drafts", educatorCourseDraftsRoutes);


// ================= COURSE MASTER DATA =================
// @route   /api/educator/areas-of-expertise, /api/educator/target-audience, /api/educator/tools
// @desc    Master data management (areas-of-expertise, target-audience, tools)
// @access  Public / Private (Admin)
router.use("/course-master", educatorCourseMasterRoutes);

// ...
router.use("/payment-enrollment-history", educatorPaymentEnrollmentHistoryRoutes);

// ================= EXPORT ROUTER =================
module.exports = router;