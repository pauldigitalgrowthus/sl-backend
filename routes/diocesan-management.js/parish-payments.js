const express = require("express");
const Stripe = require("stripe");

const { auth } = require("../../middleware/auth");
const { getMySQLConnection } = require("../../config/mysql");
const { successResponse, errorResponse } = require("../../utils/response");

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const { sendEmail } = require("../../utils/SendMailer");
const {subscriptionCreatedTemplate} = require("../../utils/subscriptionsEmailtemplate")
const { createAndDeliverNotification } = require("../../utils/notificationUtils")




/* ============================================================
   🔹 DEBUG LOGGER
============================================================ */
function logStep(step, data = "") {
    console.log(`\n========== ${step} ==========`);

    if (data) console.log(data);
}



/* ============================================================
   🔹 ACTIVATE USER SUBSCRIPTION (DEBUG VERSION)
============================================================ */
async function activateUserSubscription(userId, planId, session, connection) {

    logStep("ACTIVATE START", { userId, planId });

    /* ===========================
     LOAD PLAN
  ============================ */
    const [[plan]] = await connection.execute(
        `SELECT * FROM plans WHERE id=? LIMIT 1`,
        [planId]
    );

    if (!plan) throw new Error("Plan not found");

    /* ===========================
       CALCULATE DATES
    ============================ */
    const startDate = new Date();
    const endDate = new Date(startDate);

    switch ((plan.billing_cycle || "").toLowerCase()) {
        case "monthly":
        case "month":
            endDate.setMonth(endDate.getMonth() + 1);
            break;
        case "yearly":
        case "year":
            endDate.setFullYear(endDate.getFullYear() + 1);
            break;
        case "one-time":
            endDate.setFullYear(endDate.getFullYear() + 100);
            break;
        default:
            endDate.setMonth(endDate.getMonth() + 1);
    }

    const formattedStart =
        startDate.toISOString().slice(0, 19).replace("T", " ");
    const formattedEnd =
        endDate.toISOString().slice(0, 19).replace("T", " ");

    /* ===========================
    BUILD PLAN PERMISSIONS
 ============================ */
    let planPermissions = {};

    try {
        const [features] = await connection.execute(
            `SELECT 
         f.name AS feature_name,
         f.category,
         pt.name AS permission_type,
         pf.custom_value
       FROM plan_features pf
       JOIN features f ON pf.feature_id = f.id
       JOIN permission_types pt ON pf.permission_type_id = pt.id
       WHERE pf.plan_id = ? AND f.is_active = TRUE`,
            [planId]
        );

        (features || []).forEach((feature) => {
            const category = feature.category || "general";
            const name = feature.feature_name;
            const type = feature.permission_type || "x";

            if (!planPermissions[category])
                planPermissions[category] = {};

            if (
                (type === "custom" || type === "access-level") &&
                feature.custom_value !== null
            ) {
                const limit = Number(feature.custom_value);
                planPermissions[category][name] = {
                    type,
                    limit: isNaN(limit) ? null : limit,
                    used: 0
                };
            } else {
                planPermissions[category][name] = type;
            }
        });
    } catch (err) {
        console.warn("⚠ Could not build plan permissions:", err.message);
        planPermissions = null;
    }

    /* ===========================
     UPDATE USERS
  ============================ */
    await connection.execute(
        `UPDATE users SET
      current_plan_id=?,
      plan_start_date=?,
      plan_end_date=?,
      plan_status='active',
      role='user',
      user_type='admin',
      plan_permissions=?,
      has_upgraded=TRUE,
      updated_at=NOW()
     WHERE id=?`,
        [
            planId,
            formattedStart,
            formattedEnd,
            planPermissions ? JSON.stringify(planPermissions) : null,
            userId
        ]
    );


    logStep("DATES CALCULATED", { startDate, endDate });




    logStep("USER UPDATED");

    /* ---------------------------
       PAYMENT TRANSACTION COMPLETE
    ----------------------------*/
    await connection.execute(
        `UPDATE payment_transactions
         SET status='completed',
             stripe_payment_intent_id=?,
             stripe_subscription_id=?,
             completed_at=NOW()
         WHERE stripe_session_id=?`,
        [
            session.payment_intent?.id || null,
            session.subscription?.id || null,
            session.id
        ]
    );

    logStep("TRANSACTION COMPLETED");

    await connection.execute(
        `INSERT INTO subscriptions
        (user_id, plan_id, subscription_name, payment_id, payment_type,
         status, payment_status, start_date, end_date, metadata)
        VALUES (?, ?, ?, ?, 'stripe', 'active', 'completed', ?, ?, ?)`,
        [
            userId,
            planId,
            plan.name,
            session.subscription?.id || session.payment_intent?.id,
            formattedStart,
            formattedEnd,
            JSON.stringify({ stripe_session: session.id })
        ]
    );


    logStep("SUBSCRIPTION INSERTED");
    logStep("ACTIVATE END");
}



/* ============================================================
   @route   POST /api/diocese/parish/create-ach-session
   @desc    Create Stripe Checkout Session for Parish ACH Payment
   @access  Private (Parish User)
============================================================ */
router.post("/parish/create-ach-session", auth, async (req, res) => {

    const mysql = getMySQLConnection();
    const connection = await mysql.getConnection();
    const { successUrl, cancelUrl } = req.body;

    try {

        await connection.beginTransaction();

        const userId = req.user.id;

        /* =====================================================
           1️⃣ GET PARISH
        ===================================================== */

        const [[parish]] = await connection.execute(
            `SELECT id, diocese_id 
             FROM diocesan_parishes 
             WHERE user_id=?`,
            [userId]
        );

        if (!parish)
            return errorResponse(res, "Parish not found", 404);


        /* =====================================================
           2️⃣ GET DIOCESE SUBSCRIPTION
        ===================================================== */

        const [[diocese]] = await connection.execute(
            `SELECT subscription_start_date,
                    subscription_end_date,
                    grace_period_end_date,
                    status
             FROM dioceses
             WHERE id=?`,
            [parish.diocese_id]
        );

        if (!diocese)
            return errorResponse(res, "Diocese not found", 404);

        const now = new Date();
        const endDate = new Date(diocese.subscription_end_date);
        const graceDate = new Date(diocese.grace_period_end_date);

        /* =====================================================
           3️⃣ CHECK SUBSCRIPTION STATUS
        ===================================================== */

        if (now > graceDate) {
            return errorResponse(res, "Diocese subscription expired", 400);
        }

        /* =====================================================
           4️⃣ CALCULATE REMAINING MONTHS
        ===================================================== */

        let monthsRemaining =
            (endDate.getFullYear() - now.getFullYear()) * 12 +
            (endDate.getMonth() - now.getMonth());

        if (monthsRemaining < 1) monthsRemaining = 1;

        /* =====================================================
           5️⃣ CALCULATE PRORATED AMOUNT
        ===================================================== */

        const yearlyAmount = 540;

        const amount = Math.round((yearlyAmount / 12) * monthsRemaining);


        /* =====================================================
           6️⃣ CREATE STRIPE SESSION
        ===================================================== */

        const session = await stripe.checkout.sessions.create({

            payment_method_types: ["us_bank_account"],
            mode: "payment",

            line_items: [{
                price_data: {
                    currency: "usd",
                    product_data: {
                        name: "Parish Subscription",
                        description: `${monthsRemaining} months access`
                    },
                    unit_amount: amount * 100
                },
                quantity: 1
            }],

            success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: cancelUrl,

            metadata: {
                userId: userId.toString(),
                parish_id: parish.id.toString(),
                diocese_id: parish.diocese_id.toString(),
                monthsRemaining: monthsRemaining.toString(),
                payment_type: "ach"
            },

            payment_method_options: {
                us_bank_account: {
                    financial_connections: {
                        permissions: ["payment_method", "balances"]
                    },
                    verification_method: "instant"
                }
            }
        });

        /* =====================================================
           7️⃣ STORE PAYMENT RECORD
        ===================================================== */

        await connection.execute(
            `INSERT INTO diocesan_parish_payments
            (parish_id, diocese_id, amount, billing_year, stripe_session_id, payment_method, status)
            VALUES (?, ?, ?, YEAR(CURDATE()), ?, ?, 'pending')`,
            [
                parish.id,
                parish.diocese_id,
                amount,
                session.id,
                "us_bank_account"
            ]
        );

        await connection.commit();

        return successResponse(res, {
            sessionId: session.id,
            url: session.url,
            monthsRemaining,
            amount
        });

    } catch (err) {

        await connection.rollback();
        console.error("❌ Parish ACH Session Error:", err);

        return errorResponse(res, err.message, 500);

    } finally {

        connection.release();

    }
});


/* ============================================================
   @route   POST /api/diocese/parish/create-card-session
   @desc    Create Stripe Checkout Session for Parish Card Payment
   @access  Private (Parish User)
============================================================ */
router.post("/parish/create-card-session", auth, async (req, res) => {

    try {

        const mysql = getMySQLConnection();
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
        const userId = req.user.id;

        const [[parish]] = await mysql.execute(
            `SELECT id, diocese_id 
             FROM diocesan_parishes 
             WHERE user_id=?`,
            [userId]
        );

        if (!parish)
            return errorResponse(res, "Parish not found", 404);


        /* ==============================
           GET DIOCESE SUBSCRIPTION
        ============================== */

        const [[diocese]] = await mysql.execute(
            `SELECT subscription_end_date, grace_period_end_date
             FROM dioceses
             WHERE id=?`,
            [parish.diocese_id]
        );

        const now = new Date();
        const endDate = new Date(diocese.subscription_end_date);
        const graceDate = new Date(diocese.grace_period_end_date);

        if (now > graceDate)
            return errorResponse(res, "Diocese subscription expired", 400);


        /* ==============================
           CALCULATE REMAINING MONTHS
        ============================== */

        let monthsRemaining =
            (endDate.getFullYear() - now.getFullYear()) * 12 +
            (endDate.getMonth() - now.getMonth());

        if (monthsRemaining < 1) monthsRemaining = 1;

        const yearlyAmount = 540;
        const baseAmount = Math.round((yearlyAmount / 12) * monthsRemaining);

        const taxRate = 0.027;
        const tax = baseAmount * taxRate;

        const total = Math.round(baseAmount + tax);


        /* ==============================
           CREATE STRIPE SESSION
        ============================== */

        const session = await stripe.checkout.sessions.create({

            payment_method_types: ["card"],
            mode: "payment",

            line_items: [
                {
                    price_data: {
                        currency: "usd",
                        product_data: {
                            name: "Parish Subscription",
                            description: `${monthsRemaining} months access`
                        },
                        unit_amount: total * 100
                    },
                    quantity: 1
                }
            ],

            success_url: `${req.body.successUrl}?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: req.body.cancelUrl,

            metadata: {
                parish_id: parish.id.toString(),
                diocese_id: parish.diocese_id.toString(),
                user_id: userId.toString(),
                monthsRemaining: monthsRemaining.toString(),
                payment_type: "card"
            }
        });

        await mysql.execute(
            `INSERT INTO diocesan_parish_payments
            (parish_id, diocese_id, amount, billing_year, stripe_session_id, payment_method, status)
            VALUES (?, ?, ?, YEAR(CURDATE()), ?, ?, 'pending')`,
            [
                parish.id,
                parish.diocese_id,
                total,
                session.id,
                "card"
            ]
        );

        return successResponse(res, {
            sessionId: session.id,
            url: session.url,
            monthsRemaining,
            total
        });

    } catch (error) {

        console.error(error);
        return errorResponse(res, "Card session failed", 500);

    }

});

/* ============================================================
   @route   GET /api/diocese/parish/verify-payment/:sessionId
   @desc    Verify Parish Stripe Payment and Activate Parish
   @access  Private (Parish User)
============================================================ */
router.get("/parish/verify-payment/:sessionId", auth, async (req, res) => {

    const mysql = getMySQLConnection();
    const connection = await mysql.getConnection();

    const { sessionId } = req.params;
    const userId = req.user.id;

    try {

        console.log("🔍 Verifying parish session:", sessionId, "User:", userId);

        /* =====================================================
           1️⃣ RETRIEVE STRIPE SESSION
        ===================================================== */

        const session = await stripe.checkout.sessions.retrieve(sessionId, {
            expand: [
                "payment_intent",
                "customer",
                "subscription",
                "subscription.latest_invoice",
                "subscription.latest_invoice.payment_intent"
            ]
        });

        if (!session)
            return errorResponse(res, "Invalid session", 404);


        /* =====================================================
           2️⃣ METADATA SECURITY CHECK
        ===================================================== */

        const metadata =
            session.metadata ||
            session.subscription?.metadata ||
            session.payment_intent?.metadata ||
            {};

        const sessionUserId =
            metadata.userId ||
            metadata.user_id ||
            metadata.userid;

        if (!sessionUserId || sessionUserId !== String(userId)) {
            return errorResponse(res, "Unauthorized session access", 403);
        }

        const parishId = metadata.parish_id;
        const dioceseId = metadata.diocese_id;
        const paymentIntent = session.payment_intent;


        /* =====================================================
           3️⃣ PAYMENT STATUS CHECK
        ===================================================== */

        const isPaid =
            session.payment_status === "paid" ||
            session.status === "complete" ||
            paymentIntent?.status === "succeeded";

        const isProcessing =
            paymentIntent?.status === "processing";

        if (isProcessing) {
            return successResponse(
                res,
                { status: "processing" },
                "ACH payment is processing. It may take 3–5 banking days."
            );
        }

        if (!isPaid) {
            return errorResponse(res, "Payment not completed yet", 400);
        }


        /* =====================================================
           4️⃣ START TRANSACTION
        ===================================================== */

        await connection.beginTransaction();


        /* =====================================================
           5️⃣ UPDATE PARISH PAYMENT
        ===================================================== */

        await connection.execute(
            `UPDATE diocesan_parish_payments
             SET status='paid',
                 paid_at=NOW()
             WHERE stripe_session_id=?`,
            [session.id]
        );


        /* =====================================================
           6️⃣ ACTIVATE PARISH
        ===================================================== */

        const [[diocese]] = await connection.execute(
            `SELECT subscription_end_date
             FROM dioceses
             WHERE id=?`,
            [dioceseId]
        );

        if (!diocese || !diocese.subscription_end_date) {
            throw new Error("Diocese subscription end date not found");
        }

        const renewalDate = new Date(diocese.subscription_end_date);

        await connection.execute(
            `UPDATE diocesan_parishes
             SET status='active',
                 renewal_date=?,
                 updated_at=NOW()
             WHERE id=?`,
            [
                renewalDate,
                parishId
            ]
        );


        /* =====================================================
           7️⃣ LOAD PLAN
        ===================================================== */

        const [[plan]] = await connection.execute(
            `SELECT * FROM plans
             WHERE slug='full-access-subscription'
             AND is_active=1
             LIMIT 1`
        );

        if (!plan) {
            throw new Error("Full access subscription plan not found");
        }


        /* =====================================================
           8️⃣ ACTIVATE USER PLAN
        ===================================================== */

        await activateUserSubscription(
            userId,
            plan.id,
            session,
            connection
        );


        /* =====================================================
           9️⃣ FETCH UPDATED USER
        ===================================================== */

        const [users] = await connection.execute(
            `SELECT id,
                    first_name,
                    last_name,
                    email,
                    current_plan_id,
                    plan_start_date,
                    plan_end_date,
                    plan_status,
                    plan_permissions
             FROM users
             WHERE id=?`,
            [userId]
        );

        const user = users[0];

        if (user?.plan_permissions) {
            user.plan_permissions = JSON.parse(user.plan_permissions);
        }


        /* =====================================================
           🔟 SEND EMAIL
        ===================================================== */

        const amount = session.amount_total
            ? session.amount_total / 100
            : null;

        const currency = session.currency || "usd";

        const emailData = subscriptionCreatedTemplate({
            userName: user.first_name,
            planName: plan.name,
            startDate: user.plan_start_date,
            endDate: user.plan_end_date,
            paymentType: "stripe",
            amount,
            currency: currency.toUpperCase()
        });

        await sendEmail({
            to: user.email,
            subject: emailData.subject,
            html: emailData.html,
            text: emailData.text
        });


        /* =====================================================
           1️⃣1️⃣ SYSTEM NOTIFICATION
        ===================================================== */

        await createAndDeliverNotification(
            {
                title: "Subscription Activated",
                body: "Your parish subscription has been successfully activated.",
                channel: "inbox",
                metadata: {
                    action: "subscription_activated",
                    stripe_session_id: session.id
                },
                target: {
                    type: "custom",
                    user_ids: [userId]
                }
            },
            userId,
            connection
        );


        await connection.commit();


        return successResponse(
            res,
            {
                user,
                parish_status: "active",
                renewal_date: renewalDate
            },
            "Parish payment verified & subscription activated 🎉"
        );

    } catch (error) {

        await connection.rollback();

        console.error("❌ Parish verify error:", error);

        return errorResponse(
            res,
            error.message || "Verification failed",
            500
        );

    } finally {

        connection.release();

    }

});


module.exports = router;