const express = require("express");
const Stripe = require("stripe");
const { auth } = require("../../middleware/auth");
const { getMySQLConnection } = require("../../config/mysql");
const { successResponse, errorResponse } = require("../../utils/response");
const {
    sendEducatorNotification,
    EDUCATOR_NOTIFICATION_EVENTS
} = require("./utils/educatorNotificationService");

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/* ============================================================
   HELPERS
============================================================ */

/* Extract a Stripe object's ID, whether it's a string or expanded object */
const normId = (v) => {
    if (!v) return null;
    if (typeof v === "string") return v;
    if (typeof v === "object" && v.id) return v.id;
    try { return String(v); } catch (e) { return null; }
};

/* Get (or create) a Stripe customer for the logged-in user, same pattern as payment.js */
async function getOrCreateStripeCustomer(userId, user, mysql) {
    const [[existingCustomer]] = await mysql.execute(
        "SELECT stripe_customer_id FROM payment_customers WHERE user_id = ?",
        [userId]
    );

    if (existingCustomer && existingCustomer.stripe_customer_id) {
        try {
            await stripe.customers.retrieve(existingCustomer.stripe_customer_id);
            return existingCustomer.stripe_customer_id;
        } catch (err) {
            await mysql.execute("DELETE FROM payment_customers WHERE user_id = ?", [userId]);
        }
    }

    const customer = await stripe.customers.create({
        email: user.email,
        name: `${user.first_name} ${user.last_name}`.trim(),
        metadata: { user_id: userId.toString() }
    });

    await mysql.execute(
        `INSERT INTO payment_customers (user_id, stripe_customer_id, email, name)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            stripe_customer_id = VALUES(stripe_customer_id),
            email = VALUES(email),
            name = VALUES(name),
            updated_at = NOW()`,
        [userId, customer.id, user.email, `${user.first_name} ${user.last_name}`.trim()]
    );

    return customer.id;
}

/* Insert/update a row in course_transactions, keyed by stripe_session_id */
async function upsertCourseTransaction(mysql, sessionId, payload) {
    const {
        courseId,
        studentId,
        stripeCustomerId,
        stripePaymentIntentId,
        amount,
        currency,
        status,
        payment_method_types,
        failureMessage
    } = payload;

    const [[existing]] = await mysql.execute(
        "SELECT id FROM course_transactions WHERE stripe_session_id = ? LIMIT 1",
        [sessionId]
    );

    if (existing) {
        await mysql.execute(
            `UPDATE course_transactions
             SET stripe_payment_intent_id = ?, stripe_customer_id = ?, amount = ?, currency = ?,
                 status = ?, payment_method_types = ?, failure_message = ?,
                 completed_at = ?, updated_at = NOW()
             WHERE id = ?`,
            [
                stripePaymentIntentId || null,
                stripeCustomerId || null,
                amount,
                currency,
                status,
                JSON.stringify(payment_method_types || []),
                failureMessage || null,
                status === "completed" ? new Date() : null,
                existing.id
            ]
        );
        return existing.id;
    }

    const [result] = await mysql.execute(
        `INSERT INTO course_transactions
            (course_id, student_id, stripe_session_id, stripe_payment_intent_id, stripe_customer_id,
             amount, currency, status, payment_method_types, failure_message, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            courseId,
            studentId,
            sessionId,
            stripePaymentIntentId || null,
            stripeCustomerId || null,
            amount,
            currency,
            status,
            JSON.stringify(payment_method_types || []),
            failureMessage || null,
            status === "completed" ? new Date() : null
        ]
    );
    return result.insertId;
}

/* ============================================================
   1️⃣ ENROLL IN FREE COURSE
   ------------------------------------------------------------
   @route   POST /api/educator/enrollments/:courseId/enroll
   @desc    Student enrolls in a free course
   @access  Private (Student)
============================================================ */
router.post("/:courseId/enroll", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId } = req.params;

        /* Fetch course */
        const [[course]] = await mysql.execute(
            `SELECT id, educator_id, course_title, course_type, status, is_active
             FROM courses WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
            [courseId]
        );

        if (!course) return errorResponse(res, "Course not found", 404);

        // if (course.status !== "published" || !course.is_active) {
        //     return errorResponse(res, "Course is not available for enrollment", 400);
        // }

        if (course.course_type !== "free") {
            return errorResponse(
                res,
                "This is a paid course. Please purchase it first.",
                400
            );
        }

        /* Check if already enrolled */
        const [[existing]] = await mysql.execute(
            `SELECT id FROM course_enrollments
             WHERE course_id = ? AND student_id = ? LIMIT 1`,
            [courseId, req.user.id]
        );

        if (existing) {
            return errorResponse(res, "You are already enrolled in this course", 400);
        }

        /* Insert enrollment */
        const [result] = await mysql.execute(
            `INSERT INTO course_enrollments (course_id, student_id)
             VALUES (?, ?)`,
            [courseId, req.user.id]
        );

        /* Increment student count */
        await mysql.execute(
            `UPDATE courses SET total_students = total_students + 1 WHERE id = ?`,
            [courseId]
        );

        /* ============================================================
           NOTIFICATIONS (non-blocking - never breaks the response)
        ============================================================ */

        /* Notify the educator about the new student */
        if (course.educator_id) {
            sendEducatorNotification({
                mysql,
                event: EDUCATOR_NOTIFICATION_EVENTS.NEW_STUDENT_ENROLLED,
                userId: course.educator_id,
                actorId: req.user.id,
                data: {
                    courseTitle: course.course_title,
                    studentName: `${req.user.first_name || ""} ${req.user.last_name || ""}`.trim() || "A student"
                },
                metadata: { course_id: parseInt(courseId), enrollment_id: result.insertId }
            });
        }

        /* Notify the student that their enrollment is confirmed */
        sendEducatorNotification({
            mysql,
            event: EDUCATOR_NOTIFICATION_EVENTS.STUDENT_ENROLLMENT_CONFIRMED,
            userId: req.user.id,
            actorId: req.user.id,
            data: { courseTitle: course.course_title },
            metadata: { course_id: parseInt(courseId), enrollment_id: result.insertId }
        });

        return successResponse(
            res,
            { enrollment_id: result.insertId, course_id: parseInt(courseId) },
            `Successfully enrolled in "${course.course_title}"`,
            201
        );
    } catch (error) {
        console.error("Enroll Course Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   2️⃣ PURCHASE PAID COURSE + ENROLL
   ------------------------------------------------------------
   @route   POST /api/educator/enrollments/:courseId/purchase
   @desc    Student purchases a paid course and gets enrolled
   @access  Private (Student)
   @body    { payment_provider, payment_id, amount, currency }
============================================================ */
router.post("/:courseId/purchase", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId } = req.params;
        const { payment_provider, payment_id, amount, currency } = req.body;

        if (!payment_provider || !payment_id) {
            return errorResponse(res, "Payment provider and payment ID are required", 400);
        }

        /* Fetch course */
        const [[course]] = await mysql.execute(
            `SELECT id, course_title, course_type, price, currency, status, is_active
             FROM courses WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
            [courseId]
        );

        if (!course) return errorResponse(res, "Course not found", 404);

        if (course.status !== "published" || !course.is_active) {
            return errorResponse(res, "Course is not available for purchase", 400);
        }

        /* Check for duplicate payment ID */
        const [[existingPayment]] = await mysql.execute(
            `SELECT id FROM course_purchases WHERE payment_id = ? LIMIT 1`,
            [payment_id]
        );

        if (existingPayment) {
            return errorResponse(res, "This payment has already been processed", 400);
        }

        /* Check if already enrolled */
        const [[existingEnrollment]] = await mysql.execute(
            `SELECT id FROM course_enrollments
             WHERE course_id = ? AND student_id = ? LIMIT 1`,
            [courseId, req.user.id]
        );

        if (existingEnrollment) {
            return errorResponse(res, "You already have access to this course", 400);
        }

        /* Insert purchase record */
        const [purchaseResult] = await mysql.execute(
            `INSERT INTO course_purchases
                (course_id, student_id, payment_provider, payment_id, amount, currency, payment_status)
             VALUES (?, ?, ?, ?, ?, ?, 'paid')`,
            [
                courseId,
                req.user.id,
                payment_provider,
                payment_id,
                amount || course.price,
                currency || course.currency
            ]
        );

        /* Insert enrollment */
        const [enrollResult] = await mysql.execute(
            `INSERT INTO course_enrollments (course_id, student_id)
             VALUES (?, ?)`,
            [courseId, req.user.id]
        );

        /* Increment student count */
        await mysql.execute(
            `UPDATE courses SET total_students = total_students + 1 WHERE id = ?`,
            [courseId]
        );

        return successResponse(
            res,
            {
                purchase_id: purchaseResult.insertId,
                enrollment_id: enrollResult.insertId,
                course_id: parseInt(courseId)
            },
            `Course purchased and enrolled successfully`,
            201
        );
    } catch (error) {
        console.error("Purchase Course Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   2️⃣a CREATE CARD CHECKOUT SESSION FOR PAID COURSE
   ------------------------------------------------------------
   @route   POST /api/educator/enrollments/:courseId/create-cards-checkout-session
   @desc    Creates a Stripe checkout session (Cards) for a paid course
   @access  Private (Student)
   @body    { successUrl, cancelUrl }
============================================================ */
router.post("/:courseId/create-cards-checkout-session", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId } = req.params;
        const { successUrl, cancelUrl } = req.body;
        const userId = req.user.id;

        if (!successUrl || !cancelUrl) {
            return errorResponse(res, "successUrl and cancelUrl are required", 400);
        }

        const [[course]] = await mysql.execute(
            `SELECT id, course_title, course_type, price, currency, status, is_active
             FROM courses WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
            [courseId]
        );
        if (!course) return errorResponse(res, "Course not found", 404);

        if (course.status !== "published" || !course.is_active) {
            return errorResponse(res, "Course is not available for purchase", 400);
        }

        if (course.course_type !== "paid" || !course.price || parseFloat(course.price) <= 0) {
            return errorResponse(res, "This course does not require payment", 400);
        }

        const [[existingEnrollment]] = await mysql.execute(
            `SELECT id FROM course_enrollments WHERE course_id = ? AND student_id = ? LIMIT 1`,
            [courseId, userId]
        );
        if (existingEnrollment) {
            return errorResponse(res, "You already have access to this course", 400);
        }

        const [[user]] = await mysql.execute(
            `SELECT id, email, first_name, last_name FROM users WHERE id = ?`,
            [userId]
        );
        if (!user) return errorResponse(res, "User not found", 404);

        const customerId = await getOrCreateStripeCustomer(userId, user, mysql);
        const currency = (course.currency || "USD").toLowerCase();

        const commonMetadata = {
            user_id: userId.toString(),
            course_id: courseId.toString(),
            course_title: course.course_title,
            type: "course_purchase",
            source: "course_checkout"
        };

        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            mode: "payment",
            payment_method_types: ["card"],
            line_items: [
                {
                    price_data: {
                        currency,
                        product_data: {
                            name: course.course_title,
                            description: `Enrollment for "${course.course_title}"`
                        },
                        unit_amount: Math.round(course.price * 100)
                    },
                    quantity: 1
                }
            ],
            success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: cancelUrl,
            billing_address_collection: "auto",
            metadata: commonMetadata,
            payment_intent_data: { metadata: commonMetadata }
        });

        try {
            await upsertCourseTransaction(mysql, session.id, {
                courseId,
                studentId: userId,
                stripeCustomerId: customerId,
                stripePaymentIntentId: normId(session.payment_intent),
                amount: course.price,
                currency,
                status: "pending",
                payment_method_types: ["card"]
            });
        } catch (err) {
            console.warn("⚠️ Could not log pending course transaction:", err.message);
        }

        return successResponse(
            res,
            { sessionId: session.id, url: session.url },
            "Checkout session created successfully"
        );
    } catch (error) {
        console.error("Create Cards Checkout Session Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   2️⃣b CREATE ACH CHECKOUT SESSION FOR PAID COURSE
   ------------------------------------------------------------
   @route   POST /api/educator/enrollments/:courseId/create-ach-checkout-session
   @desc    Creates a Stripe checkout session (US bank account / ACH) for a paid course
   @access  Private (Student)
   @body    { successUrl, cancelUrl }
============================================================ */
router.post("/:courseId/create-ach-checkout-session", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId } = req.params;
        const { successUrl, cancelUrl } = req.body;
        const userId = req.user.id;

        if (!successUrl || !cancelUrl) {
            return errorResponse(res, "successUrl and cancelUrl are required", 400);
        }

        const [[course]] = await mysql.execute(
            `SELECT id, course_title, course_type, price, currency, status, is_active
             FROM courses WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
            [courseId]
        );
        if (!course) return errorResponse(res, "Course not found", 404);

        if (course.status !== "published" || !course.is_active) {
            return errorResponse(res, "Course is not available for purchase", 400);
        }

        if (course.course_type !== "paid" || !course.price || parseFloat(course.price) <= 0) {
            return errorResponse(res, "This course does not require payment", 400);
        }

        const [[existingEnrollment]] = await mysql.execute(
            `SELECT id FROM course_enrollments WHERE course_id = ? AND student_id = ? LIMIT 1`,
            [courseId, userId]
        );
        if (existingEnrollment) {
            return errorResponse(res, "You already have access to this course", 400);
        }

        const [[user]] = await mysql.execute(
            `SELECT id, email, first_name, last_name FROM users WHERE id = ?`,
            [userId]
        );
        if (!user) return errorResponse(res, "User not found", 404);

        const customerId = await getOrCreateStripeCustomer(userId, user, mysql);
        const currency = (course.currency || "USD").toLowerCase();

        const commonMetadata = {
            user_id: userId.toString(),
            course_id: courseId.toString(),
            course_title: course.course_title,
            type: "course_purchase",
            source: "course_checkout"
        };

        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            mode: "payment",
            payment_method_types: ["us_bank_account"],
            line_items: [
                {
                    price_data: {
                        currency,
                        product_data: {
                            name: course.course_title,
                            description: `Enrollment for "${course.course_title}"`
                        },
                        unit_amount: Math.round(course.price * 100)
                    },
                    quantity: 1
                }
            ],
            success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: cancelUrl,
            billing_address_collection: "auto",
            metadata: commonMetadata,
            payment_method_options: {
                us_bank_account: {
                    financial_connections: { permissions: ["payment_method", "balances"] },
                    verification_method: "instant"
                }
            },
            payment_intent_data: { metadata: commonMetadata }
        });

        try {
            await upsertCourseTransaction(mysql, session.id, {
                courseId,
                studentId: userId,
                stripeCustomerId: customerId,
                stripePaymentIntentId: normId(session.payment_intent),
                amount: course.price,
                currency,
                status: "pending",
                payment_method_types: ["us_bank_account"]
            });
        } catch (err) {
            console.warn("⚠️ Could not log pending course transaction:", err.message);
        }

        return successResponse(
            res,
            { sessionId: session.id, url: session.url },
            "Checkout session created successfully"
        );
    } catch (error) {
        console.error("Create ACH Checkout Session Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   2️⃣c VERIFY PAYMENT SESSION + ENROLL
   ------------------------------------------------------------
   @route   GET /api/educator/enrollments/verify-session/:sessionId
   @desc    Verifies a Stripe checkout session; only on confirmed payment
            is the purchase recorded and the student enrolled.
   @access  Private (Student)
============================================================ */
router.get("/verify-session/:sessionId", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { sessionId } = req.params;
        const userId = req.user.id;

        const session = await stripe.checkout.sessions.retrieve(sessionId, {
            expand: ["payment_intent", "payment_intent.payment_method", "customer"]
        });

        if (!session) return errorResponse(res, "Invalid session", 404);

        const metadata =
            session.metadata ||
            session.payment_intent?.metadata ||
            {};

        if (metadata.type !== "course_purchase") {
            return errorResponse(res, "Invalid session type", 400);
        }

        if (String(metadata.user_id) !== String(userId)) {
            return errorResponse(res, "Unauthorized access to session", 403);
        }

        const courseId = metadata.course_id ? Number(metadata.course_id) : null;
        if (!courseId) return errorResponse(res, "Course reference missing in session", 400);

        const paymentIntent = session.payment_intent;
        const stripeCustomerId = normId(session.customer);
        const stripePaymentIntentId = normId(paymentIntent);
        const currency = session.currency || "usd";

        let amount = null;
        if (typeof session.amount_total === "number") {
            amount = session.amount_total / 100;
        }

        const isPaid =
            session.payment_status === "paid" ||
            session.status === "complete" ||
            (paymentIntent && paymentIntent.status === "succeeded");

        const isProcessing = paymentIntent && paymentIntent.status === "processing";

        const needsAction =
            paymentIntent &&
            ["requires_action", "requires_confirmation", "requires_payment_method"].includes(paymentIntent.status);

        /* ACH payments can take a few days to settle */
        if (isProcessing) {
            return successResponse(
                res,
                { status: "processing" },
                "ACH payment is processing. It takes 3–5 banking days."
            );
        }

        if (needsAction) {
            return successResponse(
                res,
                { status: "bank_verification_required" },
                "Bank account verification required (micro-deposits)."
            );
        }

        if (!isPaid) {
            const intentStatus = paymentIntent?.status || null;
            const failedStatuses = ["canceled", "requires_payment_method", "failed"];

            if (intentStatus && failedStatuses.includes(intentStatus)) {
                try {
                    await upsertCourseTransaction(mysql, session.id, {
                        courseId,
                        studentId: userId,
                        stripeCustomerId,
                        stripePaymentIntentId,
                        amount,
                        currency,
                        status: "failed",
                        payment_method_types: session.payment_method_types || [],
                        failureMessage: "Payment failed or was cancelled"
                    });
                } catch (err) {
                    console.warn("⚠️ Could not record failed course txn:", err.message);
                }
                return errorResponse(res, "Payment failed or was cancelled", 400);
            }

            return errorResponse(res, "Payment not completed yet", 400);
        }

        /* ---------- Prevent double-processing on refresh ---------- */
        const [[existingTxn]] = await mysql.execute(
            `SELECT id, status FROM course_transactions WHERE stripe_session_id = ? LIMIT 1`,
            [session.id]
        );
        const alreadyProcessed = existingTxn && existingTxn.status === "completed";

        if (alreadyProcessed) {
            const [[enrollment]] = await mysql.execute(
                `SELECT id, course_id, enrolled_at FROM course_enrollments
                 WHERE course_id = ? AND student_id = ? LIMIT 1`,
                [courseId, userId]
            );

            return successResponse(
                res,
                { status: "already_processed", enrollment: enrollment || null },
                "Payment was already processed earlier. No re-enrollment performed."
            );
        }

        /* ---------- Record completed transaction ---------- */
        let transactionId;
        try {
            transactionId = await upsertCourseTransaction(mysql, session.id, {
                courseId,
                studentId: userId,
                stripeCustomerId,
                stripePaymentIntentId,
                amount,
                currency,
                status: "completed",
                payment_method_types: session.payment_method_types || []
            });
        } catch (err) {
            console.error("❌ Could not record completed course txn:", err.message);
        }

        const [[course]] = await mysql.execute(
            `SELECT id, educator_id, course_title, price, currency FROM courses WHERE id = ? LIMIT 1`,
            [courseId]
        );
        if (!course) return errorResponse(res, "Course not found", 404);

        /* Race-safety: re-check enrollment right before writing */
        const [[existingEnrollment]] = await mysql.execute(
            `SELECT id FROM course_enrollments WHERE course_id = ? AND student_id = ? LIMIT 1`,
            [courseId, userId]
        );

        let enrollmentId = existingEnrollment ? existingEnrollment.id : null;

        if (!existingEnrollment) {
            try {
                await mysql.execute(
                    `INSERT INTO course_purchases
                        (course_id, student_id, payment_provider, payment_id, amount, currency, payment_status)
                     VALUES (?, ?, 'stripe', ?, ?, ?, 'paid')`,
                    [
                        courseId,
                        userId,
                        stripePaymentIntentId || session.id,
                        amount || course.price,
                        currency || course.currency
                    ]
                );
            } catch (err) {
                console.warn("⚠️ Could not record course purchase:", err.message);
            }

            const [enrollResult] = await mysql.execute(
                `INSERT INTO course_enrollments (course_id, student_id) VALUES (?, ?)`,
                [courseId, userId]
            );
            enrollmentId = enrollResult.insertId;

            await mysql.execute(
                `UPDATE courses SET total_students = total_students + 1 WHERE id = ?`,
                [courseId]
            );

            /* ============================================================
               NOTIFICATIONS (non-blocking - never breaks the response)
               Only fire on the actual first-time enrollment, not on a
               refreshed/already-processed session.
            ============================================================ */

            /* Notify the educator about the new paid student */
            if (course.educator_id) {
                sendEducatorNotification({
                    mysql,
                    event: EDUCATOR_NOTIFICATION_EVENTS.NEW_PAID_ENROLLMENT,
                    userId: course.educator_id,
                    actorId: userId,
                    data: {
                        courseTitle: course.course_title,
                        studentName: `${req.user.first_name || ""} ${req.user.last_name || ""}`.trim() || "A student"
                    },
                    metadata: { course_id: courseId, enrollment_id: enrollmentId }
                });
            }

            /* Notify the student that their purchase/enrollment is confirmed */
            sendEducatorNotification({
                mysql,
                event: EDUCATOR_NOTIFICATION_EVENTS.STUDENT_PAID_ENROLLMENT_CONFIRMED,
                userId,
                actorId: userId,
                data: { courseTitle: course.course_title },
                metadata: { course_id: courseId, enrollment_id: enrollmentId }
            });
        }

        return successResponse(
            res,
            {
                status: "completed",
                isNew: !existingEnrollment,
                enrollment_id: enrollmentId,
                course_id: courseId,
                transaction_id: transactionId
            },
            `Payment verified. You are now enrolled in "${course.course_title}"`
        );
    } catch (error) {
        console.error("Verify Session Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   3️⃣ GET MY ENROLLED COURSES (MY LEARNING)
   ------------------------------------------------------------
   @route   GET /api/educator/enrollments/my
   @desc    Get all courses a student is enrolled in
   @access  Private (Student)
============================================================ */
router.get("/my", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { completed, page = 1, limit = 20 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let whereClause = `WHERE e.student_id = ?`;
        const params = [req.user.id];

        if (completed !== undefined) {
            whereClause += ` AND e.completed = ?`;
            params.push(completed === "true" ? 1 : 0);
        }

        const [enrollments] = await mysql.execute(
            `SELECT
                e.id           AS enrollment_id,
                e.enrolled_at,
                e.progress_percentage,
                e.completed,
                e.completed_at,
                c.id           AS course_id,
                c.course_title,
                c.slug,
                c.thumbnail,
                c.level,
                c.language,
                c.total_chapters,
                c.total_lessons,
                c.estimated_duration_hours,
                u.first_name   AS educator_first_name,
                u.last_name    AS educator_last_name,
                u.avatar       AS educator_avatar
             FROM course_enrollments e
             LEFT JOIN courses c ON e.course_id = c.id
             LEFT JOIN users u ON c.educator_id = u.id
             ${whereClause}
             ORDER BY e.enrolled_at DESC
             LIMIT ${parseInt(limit)} OFFSET ${offset}`,
            params
        );

        const [[{ total }]] = await mysql.execute(
            `SELECT COUNT(*) AS total FROM course_enrollments e ${whereClause}`,
            params
        );

        return successResponse(
            res,
            {
                enrollments,
                pagination: { page: parseInt(page), limit: parseInt(limit), total }
            },
            "My learning courses fetched successfully"
        );
    } catch (error) {
        console.error("Get My Enrollments Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   4️⃣ GET ENROLLED STUDENTS FOR A COURSE
   ------------------------------------------------------------
   @route   GET /api/educator/enrollments/:courseId/students
   @desc    Educator sees all enrolled students for their course
   @access  Private (Educator / Admin)
============================================================ */
router.get("/:courseId/students", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId } = req.params;
        const { page = 1, limit = 20 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        const [[course]] = await mysql.execute(
            `SELECT id, educator_id FROM courses WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
            [courseId]
        );

        if (!course) return errorResponse(res, "Course not found", 404);

        const isAdmin = ["admin", "superadmin"].includes(req.user.user_type);
        if (!isAdmin && course.educator_id !== req.user.id) {
            return errorResponse(res, "Access denied", 403);
        }

        const [students] = await mysql.execute(
            `SELECT
                e.id AS enrollment_id,
                e.enrolled_at,
                e.progress_percentage,
                e.completed,
                e.completed_at,
                u.id          AS student_id,
                u.first_name,
                u.last_name,
                u.email,
                u.avatar
             FROM course_enrollments e
             LEFT JOIN users u ON e.student_id = u.id
             WHERE e.course_id = ?
             ORDER BY e.enrolled_at DESC
             LIMIT ${parseInt(limit)} OFFSET ${offset}`,
            [courseId]
        );

        const [[{ total }]] = await mysql.execute(
            `SELECT COUNT(*) AS total FROM course_enrollments WHERE course_id = ?`,
            [courseId]
        );

        return successResponse(
            res,
            {
                students,
                pagination: { page: parseInt(page), limit: parseInt(limit), total }
            },
            "Enrolled students fetched successfully"
        );
    } catch (error) {
        console.error("Get Students Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   5️⃣ CHECK ENROLLMENT STATUS
   ------------------------------------------------------------
   @route   GET /api/educator/enrollments/:courseId/status
   @desc    Check if the logged-in user is enrolled in a course
   @access  Private
============================================================ */
router.get("/:courseId/status", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId } = req.params;

        const [[enrollment]] = await mysql.execute(
            `SELECT id, enrolled_at, progress_percentage, completed, completed_at
             FROM course_enrollments
             WHERE course_id = ? AND student_id = ? LIMIT 1`,
            [courseId, req.user.id]
        );

        const [[purchase]] = await mysql.execute(
            `SELECT id, payment_status, purchased_at
             FROM course_purchases
             WHERE course_id = ? AND student_id = ? LIMIT 1`,
            [courseId, req.user.id]
        );

        return successResponse(
            res,
            {
                is_enrolled: !!enrollment,
                enrollment: enrollment || null,
                purchase: purchase || null
            },
            "Enrollment status fetched"
        );
    } catch (error) {
        console.error("Enrollment Status Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

module.exports = router;