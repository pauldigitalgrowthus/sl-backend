const express = require("express");
const Stripe = require("stripe");
const { auth } = require("../../middleware/auth");
const { getMySQLConnection } = require("../../config/mysql");
const { successResponse, errorResponse } = require("../../utils/response");
const {
    sendEducatorNotification,
    EDUCATOR_NOTIFICATION_EVENTS
} = require("./utils/educatorNotificationServices");

/* Reuse the Stripe-customer / id helpers already built for single-course
   checkout, instead of duplicating them here. */
const enrollmentsRouter = require("./educator-course-enrollments");
const { normId, getOrCreateStripeCustomer } = enrollmentsRouter;
const { recordEducatorALaCarteEarning } = require("../../utils/royaltyEngine");

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/* ============================================================
   TABLES: `course_cart` and `cart_checkout_sessions` are created
   automatically on server startup by config/mysql.js
   (createCourseCartTable / createCartCheckoutSessionsTable),
   the same way every other table in this codebase is bootstrapped.
   That same file also runs a one-time migration
   (migrateCourseTransactionsForCart) so `course_transactions` can
   hold multiple rows per Stripe session - needed here because one
   cart checkout session can cover several courses at once.
============================================================ */

/* ============================================================
   HELPER: Upsert a per-course transaction row for a cart checkout.
   Unlike the single-course flow (keyed only by stripe_session_id,
   since one session = one course there), a cart session can contain
   several courses, so this is keyed by (session_id, course_id).
============================================================ */
const upsertCartCourseTransaction = async (mysql, sessionId, payload) => {
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
        `SELECT id FROM course_transactions WHERE stripe_session_id = ? AND course_id = ? LIMIT 1`,
        [sessionId, courseId]
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
};

/* ============================================================
   1️⃣ GET CART
   ------------------------------------------------------------
   @route   GET /api/educator/cart
   @desc    List everything currently in the student's cart
   @access  Private (Student)
============================================================ */
router.get("/", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();

        const [items] = await mysql.execute(
            `SELECT
                cc.id            AS cart_item_id,
                cc.added_at,
                c.id             AS course_id,
                c.course_title,
                c.slug,
                c.thumbnail,
                c.price,
                c.currency,
                c.course_type,
                c.status,
                c.is_active
             FROM course_cart cc
             JOIN courses c ON c.id = cc.course_id
             WHERE cc.student_id = ? AND c.deleted_at IS NULL
             ORDER BY cc.added_at DESC`,
            [req.user.id]
        );

        const currencies = [...new Set(items.map((i) => (i.currency || "USD").toUpperCase()))];
        const total = items.reduce((sum, i) => sum + parseFloat(i.price || 0), 0);

        return successResponse(
            res,
            {
                items,
                item_count: items.length,
                total,
                mixed_currency: currencies.length > 1,
                currencies
            },
            "Cart fetched successfully"
        );
    } catch (error) {
        console.error("Get Cart Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   2️⃣ CREATE CHECKOUT SESSION FOR ENTIRE CART (STATIC ROUTE MUST BE BEFORE /:courseId)
   ------------------------------------------------------------
   @route   POST /api/educator/cart/checkout-session
   @desc    Creates ONE Stripe checkout session covering every
            paid course currently in the student's cart.
   @access  Private (Student)
   @body    { successUrl, cancelUrl, payment_method } // payment_method: "card" | "us_bank_account", default "card"
============================================================ */
router.post("/checkout-session", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const studentId = req.user.id;
        const { successUrl, cancelUrl, payment_method } = req.body;

        if (!successUrl || !cancelUrl) {
            return errorResponse(res, "successUrl and cancelUrl are required", 400);
        }

        const methodType = payment_method === "us_bank_account" ? "us_bank_account" : "card";

        const [items] = await mysql.execute(
            `SELECT
                cc.id  AS cart_item_id,
                c.id   AS course_id,
                c.course_title,
                c.price,
                c.currency,
                c.status,
                c.is_active,
                c.course_type
             FROM course_cart cc
             JOIN courses c ON c.id = cc.course_id
             WHERE cc.student_id = ? AND c.deleted_at IS NULL`,
            [studentId]
        );

        if (items.length === 0) {
            return errorResponse(res, "Your cart is empty", 400);
        }

        /* Drop anything that's no longer purchasable and tell the student */
        const unavailable = items.filter(
            (i) => i.status !== "published" || !i.is_active || i.course_type !== "paid" || !i.price || parseFloat(i.price) <= 0
        );
        if (unavailable.length > 0) {
            return errorResponse(
                res,
                `Some courses in your cart are no longer available for purchase: ${unavailable
                    .map((i) => i.course_title)
                    .join(", ")}. Please remove them from your cart and try again.`,
                400
            );
        }

        /* Skip anything already enrolled (e.g. bought elsewhere) */
        const [existingEnrollments] = await mysql.execute(
            `SELECT course_id FROM course_enrollments WHERE student_id = ? AND course_id IN (${items
                .map(() => "?")
                .join(",")})`,
            [studentId, ...items.map((i) => i.course_id)]
        );
        const enrolledIds = new Set(existingEnrollments.map((e) => e.course_id));
        const purchasableItems = items.filter((i) => !enrolledIds.has(i.course_id));

        if (purchasableItems.length === 0) {
            return errorResponse(res, "You already have access to every course in your cart", 400);
        }

        /* All line items in a single Stripe checkout session must share one currency */
        const currencies = [...new Set(purchasableItems.map((i) => (i.currency || "USD").toUpperCase()))];
        if (currencies.length > 1) {
            return errorResponse(
                res,
                `Courses in your cart use different currencies (${currencies.join(
                    ", "
                )}). Please checkout courses of one currency at a time.`,
                400
            );
        }
        const currency = currencies[0].toLowerCase();

        const [[user]] = await mysql.execute(
            `SELECT id, email, first_name, last_name FROM users WHERE id = ?`,
            [studentId]
        );
        if (!user) return errorResponse(res, "User not found", 404);

        const customerId = await getOrCreateStripeCustomer(studentId, user, mysql);

        const courseIds = purchasableItems.map((i) => i.course_id);
        const totalAmount = purchasableItems.reduce((sum, i) => sum + parseFloat(i.price), 0);

        const commonMetadata = {
            user_id: studentId.toString(),
            course_ids: JSON.stringify(courseIds),
            type: "cart_purchase",
            source: "cart_checkout"
        };

        const sessionConfig = {
            customer: customerId,
            mode: "payment",
            payment_method_types: [methodType],
            line_items: purchasableItems.map((i) => ({
                price_data: {
                    currency,
                    product_data: {
                        name: i.course_title,
                        description: `Enrollment for "${i.course_title}"`
                    },
                    unit_amount: Math.round(i.price * 100)
                },
                quantity: 1
            })),
            success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: cancelUrl,
            billing_address_collection: "auto",
            metadata: commonMetadata,
            payment_intent_data: { metadata: commonMetadata }
        };

        if (methodType === "us_bank_account") {
            sessionConfig.payment_method_options = {
                us_bank_account: {
                    financial_connections: { permissions: ["payment_method", "balances"] },
                    verification_method: "instant"
                }
            };
        }

        const session = await stripe.checkout.sessions.create(sessionConfig);

        try {
            await mysql.execute(
                `INSERT INTO cart_checkout_sessions
                    (stripe_session_id, student_id, course_ids, amount, currency, status)
                 VALUES (?, ?, ?, ?, ?, 'pending')`,
                [session.id, studentId, JSON.stringify(courseIds), totalAmount, currency]
            );
        } catch (err) {
            console.warn("⚠️ Could not log pending cart checkout session:", err.message);
        }

        return successResponse(
            res,
            { sessionId: session.id, url: session.url, course_ids: courseIds, amount: totalAmount, currency },
            "Cart checkout session created successfully"
        );
    } catch (error) {
        console.error("Create Cart Checkout Session Error:", error);
        return errorResponse(res, error.message, 500);
    }
});

/* ============================================================
   3️⃣ VERIFY CART CHECKOUT SESSION + ENROLL IN ALL COURSES
   ------------------------------------------------------------
   @route   GET /api/educator/cart/verify-session/:sessionId
   @desc    Verifies the Stripe session created above. Only on
            confirmed payment does it enroll the student in every
            course from that session and clear those cart items.
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

        const metadata = session.metadata || session.payment_intent?.metadata || {};

        if (metadata.type !== "cart_purchase") {
            return errorResponse(res, "Invalid session type", 400);
        }

        if (String(metadata.user_id) !== String(userId)) {
            return errorResponse(res, "Unauthorized access to session", 403);
        }

        let courseIds = [];
        try {
            courseIds = JSON.parse(metadata.course_ids || "[]");
        } catch {
            courseIds = [];
        }

        if (!Array.isArray(courseIds) || courseIds.length === 0) {
            return errorResponse(res, "Course reference missing in session", 400);
        }

        const paymentIntent = session.payment_intent;
        const stripeCustomerId = normId(session.customer);
        const stripePaymentIntentId = normId(paymentIntent);
        const currency = session.currency || "usd";

        const isPaid =
            session.payment_status === "paid" ||
            session.status === "complete" ||
            (paymentIntent && paymentIntent.status === "succeeded");

        const isProcessing = paymentIntent && paymentIntent.status === "processing";

        const needsAction =
            paymentIntent &&
            ["requires_action", "requires_confirmation", "requires_payment_method"].includes(paymentIntent.status);

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
                await mysql.execute(
                    `UPDATE cart_checkout_sessions SET status = 'failed', updated_at = NOW() WHERE stripe_session_id = ?`,
                    [session.id]
                );
                return errorResponse(res, "Payment failed or was cancelled", 400);
            }

            return errorResponse(res, "Payment not completed yet", 400);
        }

        /* ---------- Prevent double-processing on refresh ---------- */
        const [[existingCheckout]] = await mysql.execute(
            `SELECT id, status FROM cart_checkout_sessions WHERE stripe_session_id = ? LIMIT 1`,
            [session.id]
        );
        const alreadyProcessed = existingCheckout && existingCheckout.status === "completed";

        if (alreadyProcessed) {
            const [enrollments] = await mysql.execute(
                `SELECT id, course_id, enrolled_at FROM course_enrollments
                 WHERE student_id = ? AND course_id IN (${courseIds.map(() => "?").join(",")})`,
                [userId, ...courseIds]
            );

            return successResponse(
                res,
                { status: "already_processed", enrollments },
                "Payment was already processed earlier. No re-enrollment performed."
            );
        }

        await mysql.execute(
            `UPDATE cart_checkout_sessions SET status = 'completed', updated_at = NOW() WHERE stripe_session_id = ?`,
            [session.id]
        );

        const perCoursePaid =
            typeof session.amount_total === "number"
                ? session.amount_total / 100 / courseIds.length
                : null;

        const results = [];

        for (const courseId of courseIds) {
            const [[course]] = await mysql.execute(
                `SELECT id, educator_id, course_title, price, currency FROM courses WHERE id = ? LIMIT 1`,
                [courseId]
            );
            if (!course) continue;

            const [[existingEnrollment]] = await mysql.execute(
                `SELECT id FROM course_enrollments WHERE course_id = ? AND student_id = ? LIMIT 1`,
                [courseId, userId]
            );

            let enrollmentId = existingEnrollment ? existingEnrollment.id : null;
            const isNew = !existingEnrollment;

            try {
                await upsertCartCourseTransaction(mysql, session.id, {
                    courseId,
                    studentId: userId,
                    stripeCustomerId,
                    stripePaymentIntentId,
                    amount: perCoursePaid ?? course.price,
                    currency,
                    status: "completed",
                    payment_method_types: session.payment_method_types || []
                });
            } catch (err) {
                console.error("❌ Could not record completed cart course txn:", err.message);
            }

            if (isNew) {
                try {
                    await mysql.execute(
                        `INSERT INTO course_purchases
                            (course_id, student_id, payment_provider, payment_id, amount, currency, payment_status)
                         VALUES (?, ?, 'stripe', ?, ?, ?, 'paid')`,
                        [
                            courseId,
                            userId,
                            `${stripePaymentIntentId || session.id}:${courseId}`,
                            perCoursePaid ?? course.price,
                            currency || course.currency
                        ]
                    );
                } catch (err) {
                    console.warn("⚠️ Could not record course purchase:", err.message);
                }

                const [enrollResult] = await mysql.execute(
                    `INSERT INTO course_enrollments (course_id, student_id, source_type, price_at_enrollment) VALUES (?, ?, 'a_la_carte', ?)`,
                    [courseId, userId, perCoursePaid ?? course.price]
                );
                enrollmentId = enrollResult.insertId;

                await mysql.execute(
                    `UPDATE courses SET total_students = total_students + 1 WHERE id = ?`,
                    [courseId]
                );

                // 🔥 ROYALTY ENGINE: deduct ICEL/USCCB/CCD, split 30% to educator
                // This is the path that actually runs in practice (verify-session
                // wins the race against the webhook, which sees the session already
                // marked completed and skips - so the royalty call MUST live here,
                // not only in the webhook's cart_purchase branch).
                await recordEducatorALaCarteEarning({
                    mysql,
                    courseId,
                    buyerUserId: userId,
                    salePrice: perCoursePaid ?? course.price,
                    transactionId: stripePaymentIntentId || null,
                    stripeSessionId: session.id,
                    paymentMethod: 'stripe'
                });

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

                sendEducatorNotification({
                    mysql,
                    event: EDUCATOR_NOTIFICATION_EVENTS.STUDENT_PAID_ENROLLMENT_CONFIRMED,
                    userId,
                    actorId: userId,
                    data: { courseTitle: course.course_title },
                    metadata: { course_id: courseId, enrollment_id: enrollmentId }
                });
            }

            /* Remove this course from the cart now that it's paid for */
            await mysql.execute(
                `DELETE FROM course_cart WHERE course_id = ? AND student_id = ?`,
                [courseId, userId]
            );

            results.push({ course_id: courseId, enrollment_id: enrollmentId, isNew });
        }

        return successResponse(
            res,
            { status: "completed", enrollments: results },
            "Payment verified. You are now enrolled in your purchased courses"
        );
    } catch (error) {
        console.error("Verify Cart Session Error:", error);
        return errorResponse(res, error.message, 500);
    }
});
/* ============================================================
   4️⃣ CLEAR CART (STATIC DELETE ROUTE)
   ------------------------------------------------------------
   @route   DELETE /api/educator/cart
   @access  Private (Student)
============================================================ */
router.delete("/", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        await mysql.execute(`DELETE FROM course_cart WHERE student_id = ?`, [req.user.id]);
        return successResponse(res, null, "Cart cleared");
    } catch (error) {
        console.error("Clear Cart Error:", error);
        return errorResponse(res, error.message, 500);
    }
});
/* ============================================================
   5️⃣ ADD COURSE TO CART (DYNAMIC ROUTE - MUST BE AFTER STATIC ROUTES)
   ------------------------------------------------------------
   @route   POST /api/educator/cart/:courseId
   @access  Private (Student)
============================================================ */
router.post("/:courseId", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId } = req.params;
        const studentId = req.user.id;
        if (isNaN(courseId)) {
            return errorResponse(res, "Invalid course ID", 400);
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
            return errorResponse(res, "Free courses don't need a cart - enroll directly", 400);
        }
        const [[existingEnrollment]] = await mysql.execute(
            `SELECT id FROM course_enrollments WHERE course_id = ? AND student_id = ? LIMIT 1`,
            [courseId, studentId]
        );
        if (existingEnrollment) {
            return errorResponse(res, "You already have access to this course", 400);
        }
        const [[alreadyInCart]] = await mysql.execute(
            `SELECT id FROM course_cart WHERE course_id = ? AND student_id = ? LIMIT 1`,
            [courseId, studentId]
        );
        if (alreadyInCart) {
            return successResponse(
                res,
                { cart_item_id: alreadyInCart.id, course_id: parseInt(courseId) },
                "Course is already in your cart"
            );
        }
        const [result] = await mysql.execute(
            `INSERT INTO course_cart (student_id, course_id) VALUES (?, ?)`,
            [studentId, courseId]
        );
        return successResponse(
            res,
            { cart_item_id: result.insertId, course_id: parseInt(courseId) },
            `"${course.course_title}" added to cart`,
            201
        );
    } catch (error) {
        console.error("Add To Cart Error:", error);
        return errorResponse(res, error.message, 500);
    }
});
/* ============================================================
   6️⃣ REMOVE COURSE FROM CART (DYNAMIC DELETE ROUTE)
   ------------------------------------------------------------
   @route   DELETE /api/educator/cart/:courseId
   @access  Private (Student)
============================================================ */
router.delete("/:courseId", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { courseId } = req.params;
        const [result] = await mysql.execute(
            `DELETE FROM course_cart WHERE course_id = ? AND student_id = ?`,
            [courseId, req.user.id]
        );
        if (result.affectedRows === 0) {
            return errorResponse(res, "This course is not in your cart", 404);
        }
        return successResponse(res, null, "Course removed from cart");
    } catch (error) {
        console.error("Remove From Cart Error:", error);
        return errorResponse(res, error.message, 500);
    }
});
module.exports = router;