const express = require('express');
const bcrypt = require('bcryptjs');
const Stripe = require('stripe');

const { auth } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');
const { getMySQLConnection } = require('../config/mysql');

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const TEMP_PASSWORD = '12345678';


/* ======================================================
   HELPER FUNCTIONS
====================================================== */

// Check diocesan admin
async function isDiocesanAdmin(userId) {
  const db = getMySQLConnection();
  const [[row]] = await db.execute(`
    SELECT p.slug
    FROM users u
    JOIN plans p ON p.id = u.current_plan_id
    WHERE u.id = ? AND u.plan_status = 'active'
  `, [userId]);

  return row?.slug === 'diocesan-admin';
}

/* ======================================================
   DIOCESE APIS
====================================================== */

/**
 * @route   GET /api/diocese
 * @desc    Get diocesan account details
 * @access  Private (Diocesan Admin)
 */
router.get('/', auth, async (req, res) => {
  try {
    if (!(await isDiocesanAdmin(req.user.id))) {
      return errorResponse(res, 'Unauthorized', 403);
    }

    const db = getMySQLConnection();
    const [[diocese]] = await db.execute(
      'SELECT * FROM dioceses WHERE diocesan_admin_id = ?',
      [req.user.id]
    );

    successResponse(res, diocese);
  } catch (err) {
    console.error(err);
    errorResponse(res, 'Failed to fetch diocese');
  }
});

/* ======================================================
   PARISH (SL SUBSCRIPTION) CRUD
====================================================== */

/**
 * @route   POST /api/diocese/parish
 * @desc    Create parish under diocese (user + sl record)
 * @access  Private (Diocesan Admin)
 *
 * Payload:
 * {
 *   "name": "John",
 *   "email": "john@parish.com",
 *   "phone": "9999999999",
 *   "parish_name": "St Peter Church",
 *   "parish_address": "NY, USA",
 *   "payment_mode": "diocese_pays" | "parish_pays"
 * }
 */
router.post('/parish', auth, async (req, res) => {
  try {
    /* =====================================================
       0️⃣ AUTH CHECK
    ===================================================== */
    if (!(await isDiocesanAdmin(req.user.id))) {
      return errorResponse(res, 'Unauthorized', 403);
    }

    const {
      name,
      email,
      phone,
      parish_name,
      parish_address,
      payment_mode // 'diocese_pays' | 'parish_pays'
    } = req.body;

    if (!name || !email || !parish_name || !payment_mode) {
      return errorResponse(res, 'Missing required fields', 400);
    }

    const db = getMySQLConnection();

    /* =====================================================
       1️⃣ FETCH DIOCESE (BY DIOCESAN ADMIN USER ID)
       ✔ THIS IS CORRECT
    ===================================================== */
    const [[diocese]] = await db.execute(
      'SELECT id FROM dioceses WHERE diocesan_admin_id = ?',
      [req.user.id]
    );

    if (!diocese) {
      return errorResponse(
        res,
        'Diocese record not found. Diocesan plan may not be initialized.',
        404
      );
    }

    /* =====================================================
       2️⃣ CREATE PARISH USER (SUBSCRIBER ADMIN)
    ===================================================== */
    const hashedPassword = await bcrypt.hash(TEMP_PASSWORD, 10);

    const [userRes] = await db.execute(
      `
      INSERT INTO users
      (
        first_name,
        last_name,
        email,
        phone,
        password,
        parent_user_id,
        role,
        user_type,
        plan_status
      )
      VALUES (?, ?, ?, ?, ?, ?, 'user', 'admin', 'free')
      `,
      [
        name,
        parish_name,
        email,
        phone || null,
        hashedPassword,
        req.user.id
      ]
    );

    const parishUserId = userRes.insertId;

    /* =====================================================
       3️⃣ CREATE DIOCESAN SL SUBSCRIPTION (PARISH)
    ===================================================== */
    await db.execute(
      `
      INSERT INTO diocesan_sl_subscriptions
      (
        diocese_id,
        subscriber_admin_id,
        parish_name,
        parish_address,
        price,
        payment_mode,
        renewal_enabled,
        status,
        start_date,
        end_date
      )
      VALUES (?, ?, ?, ?, TRUE, 'expired', CURDATE(), CURDATE())
      `,
      [
        diocese.id,
        parishUserId,
        parish_name,
        parish_address,
        payment_mode === 'diocese_pays'
          ? 540.00
          : 554.58,
        payment_mode
      ]
    );

    /* =====================================================
       4️⃣ RESPONSE
    ===================================================== */
    return successResponse(
      res,
      {
        parish_user_id: parishUserId,
        diocese_id: diocese.id,
        temp_password: TEMP_PASSWORD,
        payment_mode,
        next_step: 'activate_parish_and_collect_payment'
      },
      'Parish created successfully (payment pending)'
    );

  } catch (err) {
    console.error('❌ Create parish error:', err);
    return errorResponse(res, 'Failed to create parish');
  }
});




/**
 * @route   GET /api/diocese/parishes
 * @desc    Get all parishes under logged-in diocese
 * @access  Private (Diocesan Admin)
 */
router.get('/parishes', auth, async (req, res) => {
  try {
    /* --------------------------------------------------
       1️⃣ AUTH CHECK
    -------------------------------------------------- */
    if (!(await isDiocesanAdmin(req.user.id))) {
      return errorResponse(res, 'Unauthorized', 403);
    }

    const db = getMySQLConnection();

    /* --------------------------------------------------
       2️⃣ FETCH DIOCESE ID (FROM USER ID)
    -------------------------------------------------- */
    const [[diocese]] = await db.execute(
      'SELECT id FROM dioceses WHERE diocesan_admin_id = ?',
      [req.user.id]
    );

    if (!diocese) {
      return errorResponse(res, 'Diocese not found', 404);
    }

    /* --------------------------------------------------
       3️⃣ FETCH PARISHES USING diocese_id
    -------------------------------------------------- */
    const [rows] = await db.execute(
      `
      SELECT
        d.id AS diocesan_subscription_id,
        d.subscriber_admin_id,
        d.price,
        d.payment_mode,
        d.renewal_enabled,
        d.status,
        d.start_date,
        d.end_date,
        d.created_at,

        u.first_name,
        u.last_name,
        u.email,
        u.phone
      FROM diocesan_sl_subscriptions d
      JOIN users u ON u.id = d.subscriber_admin_id
      WHERE d.diocese_id = ?
      ORDER BY d.created_at DESC
      `,
      [diocese.id]
    );

    /* --------------------------------------------------
       4️⃣ RESPONSE
    -------------------------------------------------- */
    return successResponse(
      res,
      {
        diocese_id: diocese.id,
        total_parishes: rows.length,
        parishes: rows
      },
      'Parishes fetched successfully'
    );

  } catch (err) {
    console.error('❌ Fetch parishes error:', err);
    return errorResponse(res, 'Failed to fetch parishes');
  }
});


/**
 * @route   GET /api/diocese/parish/:subscriptionId
 * @desc    Get single parish by diocesan subscription id
 * @access  Private (Diocesan Admin)
 */
router.get('/parish/:subscriptionId', auth, async (req, res) => {
  try {
    if (!(await isDiocesanAdmin(req.user.id))) {
      return errorResponse(res, 'Unauthorized', 403);
    }

    const db = getMySQLConnection();

    // 1️⃣ Fetch diocese
    const [[diocese]] = await db.execute(
      'SELECT id FROM dioceses WHERE diocesan_admin_id = ?',
      [req.user.id]
    );

    if (!diocese) {
      return errorResponse(res, 'Diocese not found', 404);
    }

    // 2️⃣ Fetch parish by subscription id
    const [[parish]] = await db.execute(
      `
      SELECT
        d.id AS diocesan_subscription_id,
        d.subscriber_admin_id,
        d.price,
        d.payment_mode,
        d.renewal_enabled,
        d.status,
        d.start_date,
        d.end_date,
        d.created_at,

        u.first_name,
        u.last_name,
        u.email,
        u.phone
      FROM diocesan_sl_subscriptions d
      JOIN users u ON u.id = d.subscriber_admin_id
      WHERE d.id = ?
        AND d.diocese_id = ?
      LIMIT 1
      `,
      [req.params.subscriptionId, diocese.id]
    );

    if (!parish) {
      return errorResponse(res, 'Parish not found under your diocese', 404);
    }

    return successResponse(res, parish, 'Parish fetched successfully');

  } catch (err) {
    console.error('❌ Fetch parish error:', err);
    return errorResponse(res, 'Failed to fetch parish');
  }
});


/**
 * @route   PUT /api/diocese/parish/:subscriptionId/toggle-renewal
 * @desc    Toggle parish auto-renewal and return updated record
 * @access  Private (Diocesan Admin)
 */
router.put('/parish/:subscriptionId/toggle-renewal', auth, async (req, res) => {
  try {
    /* --------------------------------------------------
       1️⃣ AUTH CHECK
    -------------------------------------------------- */
    if (!(await isDiocesanAdmin(req.user.id))) {
      return errorResponse(res, 'Unauthorized', 403);
    }

    const subscriptionId = req.params.subscriptionId;
    const db = getMySQLConnection();

    /* --------------------------------------------------
       2️⃣ FETCH DIOCESE
    -------------------------------------------------- */
    const [[diocese]] = await db.execute(
      'SELECT id FROM dioceses WHERE diocesan_admin_id = ?',
      [req.user.id]
    );

    if (!diocese) {
      return errorResponse(res, 'Diocese not found', 404);
    }

    /* --------------------------------------------------
       3️⃣ TOGGLE RENEWAL (SCOPED TO DIOCESE)
    -------------------------------------------------- */
    const [result] = await db.execute(
      `
      UPDATE diocesan_sl_subscriptions
      SET renewal_enabled = NOT renewal_enabled
      WHERE id = ?
        AND diocese_id = ?
      `,
      [subscriptionId, diocese.id]
    );

    if (result.affectedRows === 0) {
      return errorResponse(res, 'Parish not found under your diocese', 404);
    }

    /* --------------------------------------------------
       4️⃣ FETCH UPDATED RECORD
    -------------------------------------------------- */
    const [[updatedParish]] = await db.execute(
      `
      SELECT
        d.id AS diocesan_subscription_id,
        d.subscriber_admin_id,
        d.payment_mode,
        d.price,
        d.renewal_enabled,
        d.status,
        d.start_date,
        d.end_date,

        u.first_name,
        u.last_name,
        u.email,
        u.phone
      FROM diocesan_sl_subscriptions d
      JOIN users u ON u.id = d.subscriber_admin_id
      WHERE d.id = ?
      LIMIT 1
      `,
      [subscriptionId]
    );

    /* --------------------------------------------------
       5️⃣ RESPONSE (NO NULL 🔥)
    -------------------------------------------------- */
    return successResponse(
      res,
      updatedParish,
      `Auto-renewal ${updatedParish.renewal_enabled ? 'enabled' : 'disabled'}`
    );

  } catch (err) {
    console.error('❌ Toggle renewal error:', err);
    return errorResponse(res, 'Failed to toggle renewal');
  }
});


/* ======================================================
   ACTIVATE PARISH (PAYMENT TRIGGER)
====================================================== */

/**
 * @route   POST /api/diocese/parish/:subscriptionId/activate
 * @desc    Activate parish and prepare checkout
 * @access  Private (Diocesan Admin)
 */
router.post('/parish/:subscriptionId/activate', auth, async (req, res) => {
  try {
    /* --------------------------------------------------
       1️⃣ AUTH CHECK
    -------------------------------------------------- */
    if (!(await isDiocesanAdmin(req.user.id))) {
      return errorResponse(res, 'Unauthorized', 403);
    }

    const subscriptionId = req.params.subscriptionId;
    const db = getMySQLConnection();

    /* --------------------------------------------------
       2️⃣ FETCH DIOCESE
    -------------------------------------------------- */
    const [[diocese]] = await db.execute(
      'SELECT id FROM dioceses WHERE diocesan_admin_id = ?',
      [req.user.id]
    );

    if (!diocese) {
      return errorResponse(res, 'Diocese not found', 404);
    }

    /* --------------------------------------------------
       3️⃣ FETCH PARISH (BY SUBSCRIPTION ID)
    -------------------------------------------------- */
    const [[parish]] = await db.execute(
      `
      SELECT *
      FROM diocesan_sl_subscriptions
      WHERE id = ?
        AND diocese_id = ?
      `,
      [subscriptionId, diocese.id]
    );

    if (!parish) {
      return errorResponse(res, 'Parish not found under your diocese', 404);
    }

    /* --------------------------------------------------
       4️⃣ FETCH CORRECT PLAN (SINGLE SOURCE OF TRUTH)
    -------------------------------------------------- */
    const [[plan]] = await db.execute(
      `SELECT id, slug FROM plans WHERE slug = 'full-access-subscription'`
    );

    if (!plan) {
      return errorResponse(res, 'Subscriber plan not found', 500);
    }

    /* --------------------------------------------------
       5️⃣ RESPONSE (PRICE DECIDED LATER)
    -------------------------------------------------- */
    return successResponse(
      res,
      {
        subscription_id: parish.id,
        parish_user_id: parish.subscriber_admin_id,
        planId: plan.id,
        payment_mode: parish.payment_mode,
        price:
          parish.payment_mode === 'diocese_pays'
            ? 540.00
            : 554.58,
        next_step:
          parish.payment_mode === 'diocese_pays'
            ? 'create_ach_checkout'
            : 'create_card_checkout'
      },
      'Parish ready for payment'
    );

  } catch (err) {
    console.error('❌ Activate parish error:', err);
    return errorResponse(res, 'Activation failed');
  }
});


/* ======================================================
   STRIPE WEBHOOK (RECURRING ENGINE)
====================================================== */

router.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('❌ Webhook signature verification failed:', err.message);
      return res.status(400).send('Invalid signature');
    }

    const db = getMySQLConnection();

    /* --------------------------------------------------
       Helper: Resolve metadata safely
    -------------------------------------------------- */
    const resolveMetadata = (obj) =>
      obj?.metadata ||
      obj?.subscription?.metadata ||
      obj?.payment_intent?.metadata ||
      obj?.invoice?.metadata ||
      {};

    try {
      /* ======================================================
         1️⃣ FIRST PAYMENT SUCCESS
      ====================================================== */
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const meta = resolveMetadata(session);

        const subscriptionId = meta.subscription_id;
        const parishUserId = meta.parish_user_id;

        if (!subscriptionId || !parishUserId) {
          console.warn('⚠️ Missing metadata in checkout.session.completed');
          return res.json({ received: true });
        }

        // Activate parish user
        await db.execute(
          `
          UPDATE users
          SET
            current_plan_id = (
              SELECT id FROM plans WHERE slug = 'full-access-subscription'
            ),
            plan_status = 'active',
            plan_start_date = NOW(),
            plan_end_date = DATE_ADD(NOW(), INTERVAL 1 YEAR)
          WHERE id = ?
          `,
          [parishUserId]
        );

        // Activate diocesan subscription
        await db.execute(
          `
          UPDATE diocesan_sl_subscriptions
          SET
            status = 'active',
            stripe_subscription_id = ?
          WHERE id = ?
          `,
          [session.subscription, subscriptionId]
        );

        console.log('✅ Parish activated:', parishUserId);
      }

      /* ======================================================
         2️⃣ RECURRING RENEWAL (ACH / CARD)
      ====================================================== */
      if (event.type === 'invoice.paid') {
        const invoice = event.data.object;
        const stripeSubId = invoice.subscription;

        if (!stripeSubId) return res.json({ received: true });

        await db.execute(
          `
          UPDATE users u
          JOIN diocesan_sl_subscriptions d
            ON d.subscriber_admin_id = u.id
          SET
            u.plan_end_date = DATE_ADD(u.plan_end_date, INTERVAL 1 YEAR)
          WHERE d.stripe_subscription_id = ?
            AND d.renewal_enabled = TRUE
          `,
          [stripeSubId]
        );

        console.log('🔁 Renewal processed for subscription:', stripeSubId);
      }

      /* ======================================================
         3️⃣ SUBSCRIPTION CANCELLED
      ====================================================== */
      if (event.type === 'customer.subscription.deleted') {
        const sub = event.data.object;

        await db.execute(
          `
          UPDATE diocesan_sl_subscriptions
          SET status = 'cancelled'
          WHERE stripe_subscription_id = ?
          `,
          [sub.id]
        );

        console.log('❌ Subscription cancelled:', sub.id);
      }

      return res.json({ received: true });

    } catch (err) {
      console.error('❌ Webhook processing error:', err);
      return res.status(500).send('Webhook handler failed');
    }
  }
);

async function createPaymentTransaction(db, data) {
  const {
    userId,            // Diocese admin (payer)
    relatedUserId,     // Parish admin (beneficiary)
    planId,
    stripeSessionId,
    amount,
    currency,
    status,
    paymentMethod
  } = data;

  // 🔐 Defensive check
  if (!userId || !stripeSessionId) {
    throw new Error('Invalid payment transaction payload');
  }

  await db.execute(
    `
    INSERT INTO payment_transactions
    (
      user_id,
      related_user_id,
      plan_id,
      stripe_session_id,
      amount,
      currency,
      status,
      payment_method,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `,
    [
      userId,
      relatedUserId || null,
      planId || null,
      stripeSessionId,
      amount,
      currency || 'usd',
      status || 'pending',
      paymentMethod || 'stripe'
    ]
  );
}



/**
 * @route   POST /api/diocese/parish/:subscriptionId/create-checkout-session
 * @desc    Create ACH checkout for parish (paid by diocese)
 * @access  Private (Diocesan Admin)
 *
 * Payload:
 * {
 *   "successUrl": "http://localhost:3000/payment-success",
 *   "cancelUrl": "http://localhost:3000/payment-cancel"
 * }
 */
router.post(
  '/parish/:subscriptionId/create-checkout-session',
  auth,
  async (req, res) => {
    try {
      if (!(await isDiocesanAdmin(req.user.id))) {
        return errorResponse(res, 'Unauthorized', 403);
      }

      const { successUrl, cancelUrl } = req.body;
      if (!successUrl || !cancelUrl) {
        return errorResponse(res, 'successUrl and cancelUrl required', 400);
      }

      const subscriptionId = req.params.subscriptionId;
      const db = getMySQLConnection();

      /* --------------------------------------------------
         Fetch parish under this diocese
      -------------------------------------------------- */
      const [[parish]] = await db.execute(`
        SELECT d.*, u.email
        FROM diocesan_sl_subscriptions d
        JOIN users u ON u.id = d.subscriber_admin_id
        JOIN dioceses dc ON dc.id = d.diocese_id
        WHERE d.id = ?
          AND dc.diocesan_admin_id = ?
      `, [subscriptionId, req.user.id]);

      if (!parish) {
        return errorResponse(res, 'Parish not found', 404);
      }

      /* --------------------------------------------------
         Fetch plan (SINGLE SOURCE)
      -------------------------------------------------- */
      const [[plan]] = await db.execute(
        `SELECT id, name FROM plans WHERE slug = 'full-access-subscription'`
      );

      const amount = parish.price;

      /* --------------------------------------------------
         Stripe Checkout
      -------------------------------------------------- */
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['us_bank_account'],
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: { name: plan.name },
            unit_amount: Math.round(amount * 100),
            recurring: { interval: 'year' }
          },
          quantity: 1
        }],
        success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${cancelUrl}?session_id={CHECKOUT_SESSION_ID}`,
        metadata: {
          subscription_id: subscriptionId,
          parish_user_id: parish.subscriber_admin_id,
          diocese_admin_id: req.user.id,
          plan_id: plan.id
        }
      });

      /* --------------------------------------------------
         Create pending transaction
      -------------------------------------------------- */
      await createPaymentTransaction(db, {
        userId: req.user.id,                  // Diocese admin
        relatedUserId: parish.subscriber_admin_id, // Parish admin
        planId: plan.id,
        stripeSessionId: session.id,
        amount:
          parish.payment_mode === 'diocese_pays'
            ? 540.00
            : 554.58,
        currency: 'usd',
        status: 'pending',
        paymentMethod:
          parish.payment_mode === 'diocese_pays'
            ? 'ach'
            : 'card'
      });


      return successResponse(
        res,
        {
          sessionId: session.id,
          checkoutUrl: session.url
        },
        'Checkout session created'
      );

    } catch (err) {
      console.error('❌ Checkout error:', err);
      return errorResponse(res, 'Failed to create checkout');
    }
  }
);



/**
 * @route   GET /api/diocese/payment/verify/:sessionId
 * @desc    Verify checkout session (success / cancel / processing)
 * @access  Private
 */
router.get('/payment/verify/:sessionId', auth, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const db = getMySQLConnection();

    /* --------------------------------------------------
       1️⃣ STRIPE SESSION FETCH
    -------------------------------------------------- */
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription', 'payment_intent']
    });

    if (!session) {
      return errorResponse(res, 'Invalid session', 404);
    }

    const paymentStatus = session.payment_status; // paid | unpaid | processing
    const checkoutStatus = session.status;        // complete | expired
    const stripeSubId = session.subscription?.id || null;

    /* --------------------------------------------------
       2️⃣ FETCH LOCAL TRANSACTION
    -------------------------------------------------- */
    const [[tx]] = await db.execute(
      `
      SELECT *
      FROM payment_transactions
      WHERE stripe_session_id = ?
      LIMIT 1
      `,
      [sessionId]
    );

    if (!tx) {
      return errorResponse(res, 'Payment record not found', 404);
    }

    // 🔁 Idempotent guard
    if (tx.status === 'completed') {
      return successResponse(
        res,
        { status: 'paid' },
        'Payment already verified'
      );
    }

    /* --------------------------------------------------
       CASE 1️⃣ : CANCELLED / EXPIRED
    -------------------------------------------------- */
    if (checkoutStatus === 'expired' || paymentStatus === 'unpaid') {
      await db.execute(
        `
        UPDATE payment_transactions
        SET status = 'cancelled',
            updated_at = NOW()
        WHERE stripe_session_id = ?
          AND status = 'pending'
        `,
        [sessionId]
      );

      return successResponse(
        res,
        { status: 'cancelled' },
        'Payment was cancelled'
      );
    }

    /* --------------------------------------------------
       CASE 2️⃣ : PROCESSING (ACH)
    -------------------------------------------------- */
    if (paymentStatus === 'processing') {
      return successResponse(
        res,
        { status: 'processing' },
        'ACH payment is processing (2–5 business days)'
      );
    }

    /* --------------------------------------------------
       CASE 3️⃣ : PAID (🔥 MAIN LOGIC)
    -------------------------------------------------- */
    if (paymentStatus === 'paid') {

      /* ----------------------------------------------
         3.1 UPDATE PAYMENT TRANSACTION
      ---------------------------------------------- */
      await db.execute(
        `
        UPDATE payment_transactions
        SET status = 'completed',
            stripe_subscription_id = ?,
            completed_at = NOW(),
            updated_at = NOW()
        WHERE stripe_session_id = ?
        `,
        [stripeSubId, sessionId]
      );

      /* ----------------------------------------------
         3.2 ACTIVATE PARISH SUBSCRIPTION
         related_user_id = parish admin
      ---------------------------------------------- */
      if (tx.related_user_id) {
        await db.execute(
          `
          UPDATE diocesan_sl_subscriptions
          SET status = 'active',
              start_date = CURDATE(),
              end_date = DATE_ADD(CURDATE(), INTERVAL 1 YEAR)
          WHERE subscriber_admin_id = ?
          `,
          [tx.related_user_id]
        );

        /* ------------------------------------------
           3.3 ACTIVATE PARISH USER PLAN
        ------------------------------------------ */
        await db.execute(
          `
          UPDATE users
          SET plan_status = 'active',
              has_upgraded = TRUE
          WHERE id = ?
          `,
          [tx.related_user_id]
        );
      }

      return successResponse(
        res,
        {
          status: 'paid',
          stripe_subscription_id: stripeSubId
        },
        'Payment successful & parish activated'
      );
    }

    /* --------------------------------------------------
       FALLBACK
    -------------------------------------------------- */
    return successResponse(
      res,
      { status: paymentStatus },
      'Payment state synced'
    );

  } catch (err) {
    console.error('❌ Verify payment error:', err);
    return errorResponse(res, 'Failed to verify payment');
  }
});


module.exports = router;
