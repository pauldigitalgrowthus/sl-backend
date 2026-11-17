const express = require("express");
const { auth } = require("../../middleware/auth");
const { getMySQLConnection } = require("../../config/mysql");
const { successResponse, errorResponse } = require("../../utils/response");

const router = express.Router();

/* ============================================================
   HELPER: is the logged-in user admin/superadmin?
============================================================ */
const isAdminUser = (userType) => ["admin", "superadmin"].includes(userType);

/* ============================================================
   HELPER: Build the shared WHERE clause + params for the
   enrollment/payment history query, based on query filters
   and the caller's role (admin sees everything, educator is
   force-scoped to only their own courses).
   ------------------------------------------------------------
   Supported query params:
     search        -> matches student name/email, course title,
                       or educator name (LIKE, case-insensitive)
     educator_id   -> filter to one educator (admin only; educators
                       are always forced to their own id)
     course_id     -> filter to one course
     student_id    -> filter to one student
     source_type   -> 'free' | 'a_la_carte' | 'subscription'
     payment_status-> 'paid' | 'free'  (derived: free courses /
                       source_type='free' => 'free', else 'paid')
     start_date    -> enrolled_at >= start_date (YYYY-MM-DD)
     end_date      -> enrolled_at <= end_date (YYYY-MM-DD, inclusive)
============================================================ */
const buildHistoryFilters = (req) => {
    const {
        search,
        educator_id,
        course_id,
        student_id,
        source_type,
        payment_status,
        start_date,
        end_date
    } = req.query;

    const conditions = ["1 = 1"];
    const params = [];

    const admin = isAdminUser(req.user.user_type);

    /* -------- Role based scoping -------- */
    if (!admin) {
        // Non-admin caller = educator -> force scope to their own courses
        conditions.push("c.educator_id = ?");
        params.push(req.user.id);
    } else if (educator_id) {
        conditions.push("c.educator_id = ?");
        params.push(educator_id);
    }

    /* -------- Common filters -------- */
    if (course_id) {
        conditions.push("e.course_id = ?");
        params.push(course_id);
    }

    if (student_id) {
        conditions.push("e.student_id = ?");
        params.push(student_id);
    }

    if (source_type) {
        conditions.push("e.source_type = ?");
        params.push(source_type);
    }

    if (payment_status === "free") {
        conditions.push("(e.source_type = 'free' OR e.price_at_enrollment = 0)");
    } else if (payment_status === "paid") {
        conditions.push("(e.source_type != 'free' AND e.price_at_enrollment > 0)");
    }

    if (start_date) {
        conditions.push("e.enrolled_at >= ?");
        params.push(`${start_date} 00:00:00`);
    }

    if (end_date) {
        conditions.push("e.enrolled_at <= ?");
        params.push(`${end_date} 23:59:59`);
    }

    if (search) {
        conditions.push(`(
            stu.first_name   LIKE ? OR
            stu.last_name    LIKE ? OR
            stu.email        LIKE ? OR
            edu.first_name   LIKE ? OR
            edu.last_name    LIKE ? OR
            edu.email        LIKE ? OR
            c.course_title   LIKE ?
        )`);
        const like = `%${search}%`;
        params.push(like, like, like, like, like, like, like);
    }

    return { whereClause: `WHERE ${conditions.join(" AND ")}`, params };
};

/* ============================================================
   SHARED SELECT — enrollment joined with course, educator,
   student, and (if it exists) the matching purchase / stripe
   transaction row, so payment info rides along automatically.
============================================================ */
const HISTORY_SELECT = `
    SELECT
        e.id                        AS enrollment_id,
        e.enrolled_at,
        e.source_type,
        e.price_at_enrollment,
        e.progress_percentage,
        e.completed,
        e.completed_at,

        c.id                        AS course_id,
        c.course_title,
        c.slug                      AS course_slug,
        c.course_type,
        c.price                     AS course_price,
        c.currency                  AS course_currency,

        edu.id                      AS educator_id,
        edu.first_name              AS educator_first_name,
        edu.last_name               AS educator_last_name,
        edu.email                   AS educator_email,

        stu.id                      AS student_id,
        stu.first_name              AS student_first_name,
        stu.last_name               AS student_last_name,
        stu.email                   AS student_email,

        p.id                        AS purchase_id,
        p.payment_provider,
        p.payment_id,
        p.amount                    AS purchase_amount,
        p.currency                  AS purchase_currency,
        p.payment_status,
        p.purchased_at,

        t.id                        AS transaction_id,
        t.stripe_session_id,
        t.stripe_payment_intent_id,
        t.amount                    AS transaction_amount,
        t.currency                  AS transaction_currency,
        t.status                    AS transaction_status,
        t.completed_at              AS transaction_completed_at

    FROM course_enrollments e
    LEFT JOIN courses c  ON e.course_id  = c.id
    LEFT JOIN users   edu ON c.educator_id = edu.id
    LEFT JOIN users   stu ON e.student_id  = stu.id
    LEFT JOIN course_purchases p
           ON p.course_id = e.course_id AND p.student_id = e.student_id
    LEFT JOIN course_transactions t
           ON t.course_id = e.course_id AND t.student_id = e.student_id
          AND t.status = 'completed'
`;

/* ============================================================
   1️⃣ GET PAYMENT + ENROLLMENT HISTORY (LIST, PAGINATED)
   ------------------------------------------------------------
   @route   GET /api/educator/payment-enrollment-history
   @desc    Full history — who enrolled in which educator's course,
            when, and what (if anything) was paid.
            - Admin/Superadmin -> sees everyone, can filter by
              educator_id / student_id / course_id.
            - Educator          -> auto-scoped to their own courses.
   @access  Private (Educator / Admin / Superadmin)
   @query   search, educator_id, course_id, student_id, source_type,
            payment_status, start_date, end_date,
            page (default 1), limit (default 20),
            all=true -> ignore pagination, return everything
                        (capped at 5000 rows for safety)
============================================================ */
router.get("/", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { page = 1, limit = 20, all } = req.query;

        const { whereClause, params } = buildHistoryFilters(req);
        const fetchAll = String(all).toLowerCase() === "true";

        let rows;
        let pagination = null;

        if (fetchAll) {
            const SAFETY_CAP = 5000;
            [rows] = await mysql.execute(
                `${HISTORY_SELECT}
                 ${whereClause}
                 ORDER BY e.enrolled_at DESC
                 LIMIT ${SAFETY_CAP}`,
                params
            );
        } else {
            const parsedLimit = Math.min(parseInt(limit) || 20, 100);
            const parsedPage = Math.max(parseInt(page) || 1, 1);
            const offset = (parsedPage - 1) * parsedLimit;

            [rows] = await mysql.execute(
                `${HISTORY_SELECT}
                 ${whereClause}
                 ORDER BY e.enrolled_at DESC
                 LIMIT ${parsedLimit} OFFSET ${offset}`,
                params
            );

            const [[{ total }]] = await mysql.execute(
                `SELECT COUNT(*) AS total
                 FROM course_enrollments e
                 LEFT JOIN courses c  ON e.course_id  = c.id
                 LEFT JOIN users   edu ON c.educator_id = edu.id
                 LEFT JOIN users   stu ON e.student_id  = stu.id
                 ${whereClause}`,
                params
            );

            pagination = {
                page: parsedPage,
                limit: parsedLimit,
                total,
                total_pages: Math.max(Math.ceil(total / parsedLimit), 1)
            };
        }

        return successResponse(
            res,
            { history: rows, ...(pagination ? { pagination } : { pagination: null, count: rows.length }) },
            "Payment & enrollment history fetched successfully"
        );
    } catch (error) {
        console.error("Get Payment Enrollment History Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   2️⃣ GET SUMMARY (TOTALS) FOR THE SAME FILTER SET
   ------------------------------------------------------------
   @route   GET /api/educator/payment-enrollment-history/summary
   @desc    Quick totals for the currently applied filters —
            total enrollments, paid vs free, total revenue.
            Accepts the same filters as the list endpoint
            (search, educator_id, course_id, student_id,
            source_type, payment_status, start_date, end_date).
   @access  Private (Educator / Admin / Superadmin)
============================================================ */
router.get("/summary", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { whereClause, params } = buildHistoryFilters(req);

        const [[summary]] = await mysql.execute(
            `SELECT
                COUNT(*)                                                              AS total_enrollments,
                SUM(CASE WHEN e.source_type = 'free' OR e.price_at_enrollment = 0
                         THEN 1 ELSE 0 END)                                           AS total_free_enrollments,
                SUM(CASE WHEN e.source_type != 'free' AND e.price_at_enrollment > 0
                         THEN 1 ELSE 0 END)                                           AS total_paid_enrollments,
                COALESCE(SUM(
                    CASE WHEN e.source_type != 'free' AND e.price_at_enrollment > 0
                         THEN e.price_at_enrollment ELSE 0 END
                ), 0)                                                                 AS total_revenue,
                COUNT(DISTINCT e.course_id)                                           AS distinct_courses,
                COUNT(DISTINCT e.student_id)                                          AS distinct_students,
                COUNT(DISTINCT c.educator_id)                                         AS distinct_educators
             FROM course_enrollments e
             LEFT JOIN courses c  ON e.course_id  = c.id
             LEFT JOIN users   edu ON c.educator_id = edu.id
             LEFT JOIN users   stu ON e.student_id  = stu.id
             ${whereClause}`,
            params
        );

        return successResponse(res, summary, "History summary fetched successfully");
    } catch (error) {
        console.error("Get Payment Enrollment History Summary Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   3️⃣ GET HISTORY FOR ONE SPECIFIC COURSE
   ------------------------------------------------------------
   @route   GET /api/educator/payment-enrollment-history/course/:courseId
   @desc    Same as the list endpoint but pre-scoped to one course
            (handy for an educator's "this course" analytics tab).
   @access  Private (Course owner / Admin / Superadmin)
============================================================ */
router.get("/course/:courseId", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId } = req.params;

        const [[course]] = await mysql.execute(
            `SELECT id, educator_id FROM courses WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
            [courseId]
        );
        if (!course) return errorResponse(res, "Course not found", 404);

        const admin = isAdminUser(req.user.user_type);
        if (!admin && course.educator_id !== req.user.id) {
            return errorResponse(res, "Access denied – not your course", 403);
        }

        // Reuse the same filter builder, forcing course_id from the URL
        req.query.course_id = courseId;
        const { whereClause, params } = buildHistoryFilters(req);

        const { page = 1, limit = 20, all } = req.query;
        const fetchAll = String(all).toLowerCase() === "true";

        let rows;
        let pagination = null;

        if (fetchAll) {
            [rows] = await mysql.execute(
                `${HISTORY_SELECT} ${whereClause} ORDER BY e.enrolled_at DESC LIMIT 5000`,
                params
            );
        } else {
            const parsedLimit = Math.min(parseInt(limit) || 20, 100);
            const parsedPage = Math.max(parseInt(page) || 1, 1);
            const offset = (parsedPage - 1) * parsedLimit;

            [rows] = await mysql.execute(
                `${HISTORY_SELECT} ${whereClause} ORDER BY e.enrolled_at DESC LIMIT ${parsedLimit} OFFSET ${offset}`,
                params
            );

            const [[{ total }]] = await mysql.execute(
                `SELECT COUNT(*) AS total
                 FROM course_enrollments e
                 LEFT JOIN courses c  ON e.course_id  = c.id
                 LEFT JOIN users   edu ON c.educator_id = edu.id
                 LEFT JOIN users   stu ON e.student_id  = stu.id
                 ${whereClause}`,
                params
            );

            pagination = {
                page: parsedPage,
                limit: parsedLimit,
                total,
                total_pages: Math.max(Math.ceil(total / parsedLimit), 1)
            };
        }

        return successResponse(
            res,
            { history: rows, pagination },
            "Course payment & enrollment history fetched successfully"
        );
    } catch (error) {
        console.error("Get Course Payment Enrollment History Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

module.exports = router;