const express = require('express');
const { body } = require('express-validator');
const Stripe = require('stripe');
const { auth } = require('../middleware/auth');
const { validate } = require('../middleware/validation');
const { successResponse, errorResponse } = require('../utils/response');
const { getMySQLConnection } = require('../config/mysql');
const { sendEmail } = require("../utils/SendMailer");
const { createAndDeliverNotification } = require("../utils/notificationUtils")
const { subscriptionCreatedTemplate } = require("../utils/subscriptionsEmailtemplate")
const { recordMusicALaCarteEarning, recordEducatorALaCarteEarning, distributeSubscriptionRevenueRealtime } = require('../utils/royaltyEngine');

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Middleware to check if user is admin/sl_team
const isAdmin = async (req, res, next) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const [users] = await mysqlConnection.execute(
      'SELECT role FROM users WHERE id = ?',
      [req.user.id]
    );

    if (users.length === 0 || users[0].role !== 'sl_team') {
      return errorResponse(res, 'Admin access required', 403);
    }
    next();
  } catch (error) {
    console.error('Admin check error:', error);
    errorResponse(res, 'Authorization failed', 500);
  }
};

// ============================================
// PAYMENT INITIALIZATION
// ============================================


// @route   POST /api/payments/create-ach-checkout-session
// @desc    Create Stripe checkout session for plan purchase (ACH-only)
// @access  Private
router.post('/create-checkout-ach-session', [
  auth,
  body('planId').isInt().withMessage('Valid plan ID is required'),
  body('successUrl')
    .isURL({ require_tld: false, require_protocol: true })
    .withMessage('Valid success URL is required'),
  body('cancelUrl')
    .isURL({ require_tld: false, require_protocol: true })
    .withMessage('Valid cancel URL is required')
],
  validate,
  async (req, res) => {
    try {
      const { planId, successUrl, cancelUrl, couponCode } = req.body;
      const userId = req.user.id;
      const mysqlConnection = getMySQLConnection();

      /* --------------------------------------------------
         1️⃣ USER
      -------------------------------------------------- */
      const [[user]] = await mysqlConnection.execute(
        'SELECT id, email, first_name, last_name FROM users WHERE id = ?',
        [userId]
      );
      if (!user) return errorResponse(res, 'User not found', 404);

      /* --------------------------------------------------
         2️⃣ PLAN
      -------------------------------------------------- */
      const [[plan]] = await mysqlConnection.execute(
        'SELECT * FROM plans WHERE id = ? AND is_active = TRUE',
        [planId]
      );
      if (!plan) return errorResponse(res, 'Plan not found or inactive', 404);

      if (parseFloat(plan.price) === 0 || plan.billing_cycle === 'free') {
        return errorResponse(res, 'Cannot create payment for free plans', 400);
      }

      /* --------------------------------------------------
         3️⃣ COMMON METADATA
      -------------------------------------------------- */
      const commonMetadata = {
        user_id: userId.toString(),
        plan_id: planId.toString(),
        plan_name: plan.name,
        billing_cycle: plan.billing_cycle
      };

      /* --------------------------------------------------
         4️⃣ COUPON (DB VALIDATION + STRIPE COUPON)
      -------------------------------------------------- */
      let stripeCouponId = null;

      if (couponCode) {
        const [[coupon]] = await mysqlConnection.execute(
          `
          SELECT *
          FROM coupons
          WHERE code = ?
            AND status = 'active'
            AND coupon_for = 'subscription'
            AND (applicable_plan_id IS NULL OR applicable_plan_id = ?)
            AND (valid_from IS NULL OR valid_from <= NOW())
            AND (valid_till IS NULL OR valid_till >= NOW())
          `,
          [couponCode.trim(), planId]
        );

        if (!coupon) {
          return errorResponse(res, 'Invalid or expired coupon', 400);
        }

        // Per-user usage check
        const [used] = await mysqlConnection.execute(
          'SELECT id FROM coupons WHERE code = ? AND user_id = ?',
          [couponCode.trim(), userId]
        );

        if (used.length >= (coupon.max_uses_per_user || 1)) {
          return errorResponse(res, 'Coupon already used by this user', 400);
        }

        /* -------- CREATE STRIPE COUPON -------- */
        const stripeCoupon = await stripe.coupons.create({
          name: coupon.code,
          duration: 'once',
          ...(coupon.discount_type === 'percentage'
            ? { percent_off: coupon.discount_value }
            : {
              amount_off: Math.round(coupon.discount_value * 100),
              currency: 'usd'
            })
        });

        stripeCouponId = stripeCoupon.id;
      }

      /* --------------------------------------------------
         5️⃣ STRIPE CUSTOMER
      -------------------------------------------------- */
      const customerId = await getOrCreateStripeCustomer(
        userId,
        user,
        mysqlConnection
      );

      /* --------------------------------------------------
         6️⃣ LINE ITEMS (FULL PRICE ONLY)
      -------------------------------------------------- */
      let mode = 'payment';
      const lineItems = [];

      if (plan.billing_cycle === 'monthly' || plan.billing_cycle === 'yearly') {
        mode = 'subscription';

        lineItems.push({
          price_data: {
            currency: 'usd',
            product_data: {
              name: plan.name,
              description: plan.description || plan.name
            },
            unit_amount: Math.round(plan.price * 100),
            recurring: {
              interval:
                plan.billing_cycle === 'monthly' ? 'month' : 'year'
            }
          },
          quantity: 1
        });
      } else {
        lineItems.push({
          price_data: {
            currency: 'usd',
            product_data: {
              name: plan.name,
              description: plan.description || plan.name
            },
            unit_amount: Math.round(plan.price * 100)
          },
          quantity: 1
        });
      }

      /* --------------------------------------------------
         7️⃣ STRIPE SESSION
      -------------------------------------------------- */
      const session = await stripe.checkout.sessions.create({
        customer: customerId,

        // ✅ ACH ONLY
        payment_method_types: ['us_bank_account'],

        mode,
        line_items: lineItems,

        // ✅ Stripe will calculate discount & paid price
        discounts: stripeCouponId ? [{ coupon: stripeCouponId }] : [],

        success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: cancelUrl,

        billing_address_collection: 'auto',
        payment_method_collection: 'always',

        metadata: {
          ...commonMetadata,
          coupon_code: couponCode || '',
          type: "subscription",
          source: "subscription_checkout"   // 👈 ADD THIS
        },

        payment_method_options: {
          us_bank_account: {
            financial_connections: {
              permissions: ['payment_method', 'balances']
            },
            verification_method: 'instant'
          }
        },

        ...(mode === 'subscription'
          ? {
            subscription_data: {
              metadata: {
                ...commonMetadata,
                coupon_code: couponCode || '',
                type: "subscription",
                source: "subscription_checkout"
              }
            }
          }
          : {
            payment_intent_data: {
              setup_future_usage: 'off_session',
              metadata: {
                ...commonMetadata,
                coupon_code: couponCode || '',
                type: "subscription",
                source: "subscription_checkout"
              }
            }
          })
      });

      return successResponse(
        res,
        {
          sessionId: session.id,
          url: session.url
        },
        'Checkout session created successfully'
      );

    } catch (error) {
      console.error('❌ Checkout session error:', error);
      return errorResponse(
        res,
        error.message || 'Failed to create checkout session',
        500
      );
    }
  }
);


// @route   POST /api/payments/create-cards-checkout-session
// @desc    Create Stripe checkout session (Cards + Coupon + 2.7% tax)
// @access  Private
router.post('/create-cards-checkout-session', [
  auth,
  body('planId').isInt().withMessage('Valid plan ID is required'),
  body('successUrl').isURL({ require_tld: false, require_protocol: true }).withMessage('Valid success URL is required'),
  body('cancelUrl').isURL({ require_tld: false, require_protocol: true }).withMessage('Valid cancel URL is required')
],
  validate,
  async (req, res) => {
    try {
      const { planId, successUrl, cancelUrl, couponCode } = req.body;
      const userId = req.user.id;
      const mysqlConnection = getMySQLConnection();

      /* ---------------- USER ---------------- */
      const [[user]] = await mysqlConnection.execute(
        'SELECT id, email, first_name, last_name FROM users WHERE id = ?',
        [userId]
      );
      if (!user) return errorResponse(res, 'User not found', 404);

      /* ---------------- PLAN ---------------- */
      const [[plan]] = await mysqlConnection.execute(
        'SELECT * FROM plans WHERE id = ? AND is_active = TRUE',
        [planId]
      );
      if (!plan) return errorResponse(res, 'Plan not found', 404);

      if (parseFloat(plan.price) === 0 || plan.billing_cycle === 'free') {
        return errorResponse(res, 'Cannot create payment for free plans', 400);
      }

      /* ---------------- COMMON METADATA (🔥 FIX) ---------------- */
      const commonMetadata = {
        user_id: userId.toString(),
        plan_id: planId.toString(),
        plan_name: plan.name,
        billing_cycle: plan.billing_cycle
      };

      /* ---------------- COUPON (DB VALIDATION) ---------------- */
      let stripeCouponId = null;

      if (couponCode) {
        const [[coupon]] = await mysqlConnection.execute(
          `
          SELECT * FROM coupons
          WHERE code = ?
            AND status = 'active'
            AND coupon_for = 'subscription'
            AND (applicable_plan_id IS NULL OR applicable_plan_id = ?)
            AND (valid_from IS NULL OR valid_from <= NOW())
            AND (valid_till IS NULL OR valid_till >= NOW())
          `,
          [couponCode.trim(), planId]
        );

        if (!coupon) {
          return errorResponse(res, 'Invalid or expired coupon', 400);
        }

        /* ---------- 1️⃣ PER-USER LIMIT CHECK ---------- */
        const [userUses] = await mysqlConnection.execute(
          `
          SELECT COUNT(*) AS total
          FROM coupons
          WHERE code = ? AND user_id = ?
          `,
          [couponCode.trim(), userId]
        );

        if (
          coupon.max_uses_per_user !== null &&
          userUses[0].total >= coupon.max_uses_per_user
        ) {
          return errorResponse(
            res,
            'You have already used this coupon',
            400
          );
        }

        /* ---------- 2️⃣ TOTAL USAGE LIMIT CHECK ---------- */
        if (coupon.max_total_uses !== null) {
          const [totalUses] = await mysqlConnection.execute(
            `
            SELECT COUNT(*) AS total
            FROM coupons
            WHERE code = ? AND user_id IS NOT NULL
            `,
            [couponCode.trim()]
          );

          if (totalUses[0].total >= coupon.max_total_uses) {
            return errorResponse(
              res,
              'This coupon has reached its usage limit',
              400
            );
          }
        }

        /* -------- CREATE STRIPE COUPON -------- */
        const stripeCoupon = await stripe.coupons.create({
          name: coupon.code,
          duration: 'once',
          ...(coupon.discount_type === 'percentage'
            ? { percent_off: coupon.discount_value }
            : {
              amount_off: Math.round(coupon.discount_value * 100),
              currency: 'usd'
            })
        });

        stripeCouponId = stripeCoupon.id;
      }

      /* ---------------- STRIPE CUSTOMER ---------------- */
      const customerId = await getOrCreateStripeCustomer(
        userId,
        user,
        mysqlConnection
      );

      /* ---------------- TAX RATE (2.7%) ---------------- */
      let taxRate = null;
      try {
        taxRate = await stripe.taxRates.create({
          display_name: 'Service Tax',
          percentage: 2.7,
          inclusive: false
        });
      } catch (err) {
        console.warn('⚠️ Tax rate creation failed:', err.message);
      }

      /* ---------------- LINE ITEMS ---------------- */
      const lineItems = [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: plan.name,
              description: plan.description || plan.name
            },
            unit_amount: Math.round(plan.price * 100),
            recurring: {
              interval:
                plan.billing_cycle === 'monthly' ? 'month' : 'year'
            }
          },
          quantity: 1,
          ...(taxRate ? { tax_rates: [taxRate.id] } : {})
        }
      ];

      /* ---------------- CHECKOUT SESSION ---------------- */
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: lineItems,

        // ✅ FIXED: metadata defined properly
        metadata: {
          ...commonMetadata,
          coupon_code: couponCode || '',
          type: "subscription",
          source: "subscription_checkout"   // 👈 ADD THIS
        },

        discounts: stripeCouponId ? [{ coupon: stripeCouponId }] : [],

        success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: cancelUrl,

        billing_address_collection: 'auto',
        payment_method_collection: 'always',

        subscription_data: {
          metadata: {
            ...commonMetadata,
            coupon_code: couponCode || '',
            type: "subscription",
            source: "subscription_checkout"
          }
        }
      });

      return successResponse(
        res,
        {
          sessionId: session.id,
          url: session.url
        },
        'Checkout session created successfully'
      );

    } catch (error) {
      console.error('❌ Checkout session error:', error);
      return errorResponse(res, error.message || 'Stripe error', 500);
    }
  }
);



// ============================================
// FIXED: STRIPE CUSTOMER HANDLER
// ============================================
async function getOrCreateStripeCustomer(userId, user, mysqlConnection) {
  try {
    // Fetch existing customer ID from database
    const [existingCustomer] = await mysqlConnection.execute(
      'SELECT stripe_customer_id FROM payment_customers WHERE user_id = ?',
      [userId]
    );

    // If customer ID exists, verify it exists in Stripe
    if (existingCustomer.length > 0 && existingCustomer[0].stripe_customer_id) {
      const oldCustomerId = existingCustomer[0].stripe_customer_id;

      try {
        // Verify customer by fetching from Stripe
        await stripe.customers.retrieve(oldCustomerId);
        console.log('✅ Existing customer is valid:', oldCustomerId);
        return oldCustomerId;
      } catch (stripeError) {
        console.log('⚠️ Existing customer is invalid, creating new one:', oldCustomerId);
        // Customer is invalid, delete from database
        await mysqlConnection.execute(
          'DELETE FROM payment_customers WHERE user_id = ?',
          [userId]
        );
      }
    }

    // Create new Stripe customer
    console.log('🆕 Creating new Stripe customer...');
    const customer = await stripe.customers.create({
      email: user.email,
      name: `${user.first_name} ${user.last_name}`.trim(),
      metadata: {
        user_id: userId.toString(),
        database_id: userId.toString()
      }
    });

    console.log('✅ New customer created:', customer.id);

    // Save to database
    await mysqlConnection.execute(
      `INSERT INTO payment_customers (user_id, stripe_customer_id, email, name)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE 
        stripe_customer_id = ?,
        email = ?,
        name = ?,
        updated_at = NOW()`,
      [
        userId,
        customer.id,
        user.email,
        `${user.first_name} ${user.last_name}`.trim(),
        customer.id,
        user.email,
        `${user.first_name} ${user.last_name}`.trim()
      ]
    );

    return customer.id;

  } catch (error) {
    console.error('❌ Customer create/fetch error:', error.message);
    throw new Error(`Failed to create Stripe customer: ${error.message}`);
  }
}

// ============================================
// FIXED: STRIPE PRICE HANDLER
// ============================================
async function getOrCreateStripePrice(plan, mysqlConnection) {
  try {
    // Check for existing price in database
    const [existing] = await mysqlConnection.execute(
      'SELECT stripe_price_id, stripe_product_id FROM stripe_prices WHERE plan_id = ?',
      [plan.id]
    );

    // If price ID exists, verify it
    if (existing.length > 0 && existing[0].stripe_price_id) {
      const oldPriceId = existing[0].stripe_price_id;

      try {
        await stripe.prices.retrieve(oldPriceId);
        console.log('✅ Existing price is valid:', oldPriceId);
        return oldPriceId;
      } catch (stripeError) {
        console.log('⚠️ Existing price is invalid, creating new one:', oldPriceId);
        // Price is invalid, delete it
        await mysqlConnection.execute(
          'DELETE FROM stripe_prices WHERE plan_id = ?',
          [plan.id]
        );
      }
    }

    // ============================================
    // Create or fetch product
    // ============================================
    let productId;
    const [existingProduct] = await mysqlConnection.execute(
      'SELECT stripe_product_id FROM stripe_products WHERE plan_id = ?',
      [plan.id]
    );

    if (existingProduct.length > 0 && existingProduct[0].stripe_product_id) {
      productId = existingProduct[0].stripe_product_id;

      try {
        await stripe.products.retrieve(productId);
        console.log('✅ Existing product is valid:', productId);
      } catch (stripeError) {
        console.log('⚠️ Existing product is invalid, creating new one');

        // Create new product
        const product = await stripe.products.create({
          name: plan.name,
          description: plan.description || `${plan.name} Subscription Plan`,
          metadata: {
            plan_id: plan.id.toString()
          }
        });
        productId = product.id;

        // Attempt to update existing stripe_products row for this plan.
        // If update affects no rows (row missing), try to insert; if insert fails due to duplicate product id,
        // fall back to using the existing DB row for that product id and continue.
        try {
          const [updateResult] = await mysqlConnection.execute(
            'UPDATE stripe_products SET stripe_product_id = ?, updated_at = NOW() WHERE plan_id = ?',
            [productId, plan.id]
          );

          // If no row was updated, insert a new mapping. This can fail if another mapping with same product exists.
          if (updateResult.affectedRows === 0) {
            try {
              await mysqlConnection.execute(
                'INSERT INTO stripe_products (plan_id, stripe_product_id, name) VALUES (?, ?, ?)',
                [plan.id, productId, plan.name]
              );
              console.log('✅ New product created and mapped to plan:', productId);
            } catch (dbErr) {
              // Handle duplicate entry for stripe_product_id gracefully
              if (dbErr && dbErr.code === 'ER_DUP_ENTRY') {
                console.log('⚠️ Product already exists in DB (duplicate stripe_product_id). Using existing DB product entry.');
                const [rows] = await mysqlConnection.execute(
                  'SELECT stripe_product_id FROM stripe_products WHERE stripe_product_id = ?',
                  [productId]
                );
                if (rows.length > 0) {
                  productId = rows[0].stripe_product_id;
                  console.log('✅ Using existing productId from DB:', productId);
                } else {
                  // As a last resort, continue with the Stripe product id even if DB mapping couldn't be created
                  console.warn('⚠️ Duplicate product id exists but could not be loaded from DB. Proceeding with Stripe product id.');
                }
              } else {
                throw dbErr;
              }
            }
          } else {
            console.log('✅ Updated stripe_products mapping for plan:', plan.id);
          }
        } catch (dbErr) {
          // If duplicate product id error, try to recover by reading existing product mapping and continue.
          if (dbErr && dbErr.code === 'ER_DUP_ENTRY') {
            console.log('⚠️ DB duplicate detected while saving product mapping. Attempting to use existing product row.');
            try {
              const [rows] = await mysqlConnection.execute(
                'SELECT stripe_product_id FROM stripe_products WHERE stripe_product_id = ?',
                [productId]
              );
              if (rows.length > 0) {
                productId = rows[0].stripe_product_id;
                console.log('✅ Resolved productId from existing DB row:', productId);
              } else {
                console.warn('⚠️ Duplicate product id reported but no row found. Proceeding with Stripe product id.');
              }
            } catch (selectErr) {
              console.error('❌ Failed to recover existing product row after duplicate error:', selectErr.message);
              // proceed without throwing to avoid blocking checkout; let later steps handle any issues
            }
          } else {
            // If any unexpected DB error occurs, log and rethrow so calling code can handle it
            console.error('❌ DB error while saving product mapping:', dbErr.message);
            throw dbErr;
          }
        }
      }
    } else {
      // Create completely new product
      const product = await stripe.products.create({
        name: plan.name,
        description: plan.description || `${plan.name} Subscription Plan`,
        metadata: {
          plan_id: plan.id.toString()
        }
      });
      productId = product.id;

      // Try to insert mapping; if a duplicate exists for stripe_product_id, fetch the existing product row and continue.
      try {
        await mysqlConnection.execute(
          'INSERT INTO stripe_products (plan_id, stripe_product_id, name) VALUES (?, ?, ?)',
          [plan.id, productId, plan.name]
        );
        console.log('✅ New product created and mapped to plan:', productId);
      } catch (dbErr) {
        if (dbErr && dbErr.code === 'ER_DUP_ENTRY') {
          console.log('⚠️ Product already exists in DB (duplicate stripe_product_id). Using existing DB product entry.');
          const [rows] = await mysqlConnection.execute(
            'SELECT stripe_product_id FROM stripe_products WHERE stripe_product_id = ?',
            [productId]
          );
          if (rows.length > 0) {
            productId = rows[0].stripe_product_id;
            console.log('✅ Using existing productId from DB:', productId);
          } else {
            console.warn('⚠️ Duplicate product id exists but could not be loaded from DB. Proceeding with Stripe product id.');
          }
        } else {
          throw dbErr;
        }
      }
    }

    // ============================================
    // Create new price
    // ============================================
    const recurring = plan.billing_cycle === 'yearly' ? 'year' : 'month';
    const price = await stripe.prices.create({
      product: productId,
      unit_amount: Math.round(parseFloat(plan.price) * 100),
      currency: 'usd',
      recurring: {
        interval: recurring
      },
      metadata: {
        plan_id: plan.id.toString()
      }
    });

    console.log('✅ New price created:', price.id);

    // Save to database
    await mysqlConnection.execute(
      `INSERT INTO stripe_prices 
        (plan_id, stripe_price_id, stripe_product_id, amount, currency, recurring_interval) 
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE 
        stripe_price_id = ?,
        stripe_product_id = ?,
        amount = ?,
        updated_at = NOW()`,
      [
        plan.id, price.id, productId, parseFloat(plan.price), 'usd', recurring,
        price.id, productId, parseFloat(plan.price)
      ]
    );

    return price.id;

  } catch (error) {
    console.error('❌ Price create/fetch error:', error.message);

    // If the error is a DB duplicate entry for stripe_product_id, try to recover by returning an existing price
    try {
      if ((error && error.code === 'ER_DUP_ENTRY') || (error && typeof error.message === 'string' && error.message.includes('Duplicate entry'))) {
        console.log('⚠️ Detected duplicate DB entry while creating price — attempting to find an existing price record');

        // Prefer finding a price by plan_id first
        let existingPriceRow = null;
        try {
          const [byPlan] = await mysqlConnection.execute(
            'SELECT stripe_price_id FROM stripe_prices WHERE plan_id = ? ORDER BY created_at DESC LIMIT 1',
            [plan.id]
          );
          if (byPlan.length > 0) existingPriceRow = byPlan[0];
        } catch (qErr) {
          console.warn('⚠️ Failed to query stripe_prices by plan_id:', qErr.message);
        }

        // If not found by plan, try by product id (if available)
        if (!existingPriceRow && productId) {
          try {
            const [byProduct] = await mysqlConnection.execute(
              'SELECT stripe_price_id FROM stripe_prices WHERE stripe_product_id = ? ORDER BY created_at DESC LIMIT 1',
              [productId]
            );
            if (byProduct.length > 0) existingPriceRow = byProduct[0];
          } catch (qErr) {
            console.warn('⚠️ Failed to query stripe_prices by product_id:', qErr.message);
          }
        }

        if (existingPriceRow && existingPriceRow.stripe_price_id) {
          console.log('✅ Found existing price from DB, returning:', existingPriceRow.stripe_price_id);
          return existingPriceRow.stripe_price_id;
        }
      }
    } catch (recoverErr) {
      console.warn('⚠️ Recovery attempt after duplicate error failed:', recoverErr.message);
    }

    throw new Error(`Failed to create Stripe price: ${error.message}`);
  }
}

// ============================================
// PAYMENT VERIFICATION
// ============================================


// Helper: Upsert payment transaction by stripe_session_id (safe without UNIQUE constraint)
async function upsertPaymentTransaction(mysqlConnection, sessionId, payload) {
  // payload: {
  //   userId, planId, stripeCustomerId, amount, currency,
  //   status, stripePaymentIntentId, stripeSubscriptionId, payment_method_types
  // }
  try {
    const [rows] = await mysqlConnection.execute(
      `SELECT id FROM payment_transactions WHERE stripe_session_id = ? LIMIT 1`,
      [sessionId]
    );

    if (rows.length > 0) {
      const id = rows[0].id;
      await mysqlConnection.execute(
        `UPDATE payment_transactions SET
           user_id = ?,
           plan_id = ?,
           stripe_customer_id = ?,
           amount = ?,
           currency = ?,
           status = ?,
           stripe_payment_intent_id = ?,
           stripe_subscription_id = ?,
           payment_method_types = ?,
           completed_at = CASE WHEN ? = 'completed' THEN NOW() ELSE completed_at END,
           updated_at = NOW()
         WHERE id = ?`,
        [
          payload.userId,
          payload.planId,
          payload.stripeCustomerId,
          payload.amount,
          payload.currency,
          payload.status,
          payload.stripePaymentIntentId,
          payload.stripeSubscriptionId,
          JSON.stringify(payload.payment_method_types || []),
          payload.status, // used for completed_at CASE
          id
        ]
      );
      return id;
    } else {
      const [insertRes] = await mysqlConnection.execute(
        `INSERT INTO payment_transactions
           (user_id, plan_id, stripe_session_id, stripe_customer_id, amount, currency,
            status, stripe_payment_intent_id, stripe_subscription_id, payment_method_types, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          payload.userId,
          payload.planId,
          sessionId,
          payload.stripeCustomerId,
          payload.amount,
          payload.currency,
          payload.status,
          payload.stripePaymentIntentId,
          payload.stripeSubscriptionId,
          JSON.stringify(payload.payment_method_types || [])
        ]
      );
      return insertRes.insertId;
    }
  } catch (err) {
    console.error('❌ upsertPaymentTransaction error:', err.message);
    throw err;
  }
}

// ============================================
// PAYMENT VERIFICATION (FINAL - with pre-check to avoid re-activating)
// ============================================
router.get('/verify-session/:sessionId', auth, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();
    console.log('Verifying session:', sessionId, 'for user:', userId);
    // Expand necessary Stripe objects to safely read IDs / statuses
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: [
        'payment_intent',
        'payment_intent.payment_method',
        'customer',
        'subscription',
        'subscription.latest_invoice',
        'subscription.latest_invoice.payment_intent',
        'subscription.latest_invoice.payment_intent.payment_method',
        'total_details'
      ]
    });

    if (!session) {
      return errorResponse(res, 'Invalid session', 404);
    }

    // ------------------------------------
    // Resolve metadata from all sources
    // ------------------------------------
    const resolvedMetadata =
      session.metadata ||
      session.subscription?.metadata ||
      session.payment_intent?.metadata ||
      session.subscription?.latest_invoice?.payment_intent?.metadata ||
      {};

    console.log('📋 Resolved metadata:', resolvedMetadata);

    // Security check: ensure session belongs to this user
    if (resolvedMetadata.user_id !== String(userId)) {
      console.log('❌ Unauthorized: metadata user_id:', resolvedMetadata.user_id, 'vs current user:', userId);
      return errorResponse(res, 'Unauthorized access to session', 403);
    }

    const couponCode = resolvedMetadata.coupon_code || null;
    console.log(couponCode)
    const paymentIntent = session.payment_intent;

    // Normalizer: extract ID string or null
    const normId = (v) => {
      if (!v) return null;
      if (typeof v === 'string') return v;
      if (typeof v === 'object' && v.id) return v.id;
      try { return String(v); } catch (e) { return null; }
    };

    const stripeCustomerId = normId(session.customer);
    const stripeSubscriptionId = normId(session.subscription);
    const stripePaymentIntentId = normId(paymentIntent);
    const currency = session.currency || 'usd';
    const planId = resolvedMetadata.plan_id ? Number(resolvedMetadata.plan_id) : null;

    // ------------------------------------
    // Calculate amounts and discount
    // ------------------------------------
    let amount = null;
    let amountBeforeDiscount = null;
    let discountAmount = 0;

    // Get final amount
    if (typeof session.amount_total === 'number') {
      amount = session.amount_total / 100;
    } else if (typeof session.amount_total === 'string' && !isNaN(Number(session.amount_total))) {
      amount = Number(session.amount_total) / 100;
    }

    // Get subtotal (amount before discount)
    if (session.amount_subtotal) {
      amountBeforeDiscount = session.amount_subtotal / 100;
    }

    // Calculate discount
    if (session.total_details && session.total_details.amount_discount) {
      discountAmount = session.total_details.amount_discount / 100;
    } else if (amountBeforeDiscount && amount) {
      discountAmount = Math.max(0, amountBeforeDiscount - amount);
    }

    // Fallback: get plan price if amounts not available
    if (!amount && planId) {
      const [planRows] = await mysqlConnection.execute(
        'SELECT price FROM plans WHERE id = ? LIMIT 1',
        [planId]
      );
      if (planRows.length > 0) {
        amountBeforeDiscount = parseFloat(planRows[0].price);
        amount = amountBeforeDiscount;
      }
    }

    console.log('💰 Amounts:', {
      amountBeforeDiscount,
      discountAmount,
      finalAmount: amount
    });

    // ------------------------------------
    // Payment status checks
    // ------------------------------------
    const isPaid =
      session.payment_status === 'paid' ||
      session.status === 'complete' ||
      (paymentIntent && paymentIntent.status === 'succeeded');

    const isProcessing = paymentIntent && paymentIntent.status === 'processing';

    const needsAction =
      paymentIntent &&
      ['requires_action', 'requires_confirmation', 'requires_payment_method'].includes(paymentIntent.status);

    // Handle ACH/processing payments
    if (isProcessing) {
      return successResponse(
        res,
        { status: 'processing' },
        'ACH payment is processing. It takes 3–5 banking days.'
      );
    }

    if (needsAction) {
      return successResponse(
        res,
        { status: 'bank_verification_required' },
        'Bank account verification required (micro-deposits).'
      );
    }

    // Handle failed/pending payments
    if (!isPaid) {
      const intentStatus = paymentIntent ?
        (typeof paymentIntent === 'object' ? paymentIntent.status : null) : null;
      const failedStatuses = ['canceled', 'requires_payment_method', 'failed'];

      if (intentStatus && failedStatuses.includes(intentStatus)) {
        try {
          const failedTxnId = await upsertPaymentTransaction(mysqlConnection, session.id, {
            userId,
            planId,
            stripeCustomerId,
            amount,
            currency,
            status: 'failed',
            stripePaymentIntentId,
            stripeSubscriptionId,
            payment_method_types: session.payment_method_types || []
          });
          console.log('📝 Recorded failed txn id:', failedTxnId);
        } catch (err) {
          console.warn('⚠️ Could not record failed txn:', err.message);
        }

        return errorResponse(res, 'Payment failed or was cancelled', 400);
      }

      return errorResponse(res, 'Payment not completed yet', 400);
    }

    // ------------------------------------
    // Check if already processed (prevent duplicate activation)
    // ------------------------------------
    const [existingRows] = await mysqlConnection.execute(
      `SELECT id, status FROM payment_transactions WHERE stripe_session_id = ? LIMIT 1`,
      [session.id]
    );

    const alreadyProcessed = existingRows.length > 0 && existingRows[0].status === 'completed';
    let paymentTransactionId = existingRows.length > 0 ? existingRows[0].id : null;

    if (alreadyProcessed) {
      console.log('ℹ️ Payment already processed, returning existing user data');

      try {
        await savePaymentMethodFromStripe(userId, session, mysqlConnection);
      } catch (err) {
        console.warn('⚠️ savePaymentMethodFromStripe error (alreadyProcessed):', err.message);
      }

      // Fetch current user state
      const [users] = await mysqlConnection.execute(
        `SELECT id, first_name, last_name, email, phone, role, user_type,
          is_composer, parent_user_id, current_plan_id, plan_start_date, plan_end_date, plan_status,
          plan_permissions, custom_permissions, max_sub_users, active_sub_users_count,
          bio, avatar, website_url, twitter_url, address, country, state_province,
          city, postal_code, language, timezone, badges, is_active, is_verified,
          email_verified_at, last_login, login_count, free_trial_expires_at,
          has_upgraded, created_at, updated_at
        FROM users WHERE id = ?`,
        [userId]
      );

      if (users.length === 0) {
        return errorResponse(res, 'User not found', 404);
      }

      const user = users[0];
      user.plan_permissions = user.plan_permissions ? JSON.parse(user.plan_permissions) : null;
      user.custom_permissions = user.custom_permissions ? JSON.parse(user.custom_permissions) : null;
      user.badges = user.badges ? JSON.parse(user.badges) : null;

      return successResponse(
        res,
        {
          user,
          paymentTransactionId,
          isNew: false,
          message: 'Payment already processed earlier. No re-activation performed.'
        },
        'Payment was already processed earlier.'
      );
    }

    // ------------------------------------
    // Process new payment
    // ------------------------------------
    console.log('✅ Processing new payment...');

    // 1. Record completed transaction
    try {
      paymentTransactionId = await upsertPaymentTransaction(mysqlConnection, session.id, {
        userId,
        planId,
        stripeCustomerId,
        amount,
        currency,
        status: 'completed',
        stripePaymentIntentId,
        stripeSubscriptionId,
        payment_method_types: session.payment_method_types || []
      });
      console.log('✅ Recorded completed txn id:', paymentTransactionId);
    } catch (err) {
      console.error('❌ Could not record completed txn:', err.message);
    }

    // 2. Get internal subscription ID from subscriptions table
    let internalSubscriptionId = null;
    if (stripeSubscriptionId) {
      try {
        // First, upsert stripe_subscriptions mapping
        await mysqlConnection.execute(
          `INSERT INTO stripe_subscriptions 
            (user_id, stripe_subscription_id, stripe_customer_id, status, created_at, updated_at)
           VALUES (?, ?, ?, 'active', NOW(), NOW())
           ON DUPLICATE KEY UPDATE 
            status = 'active', 
            stripe_customer_id = VALUES(stripe_customer_id), 
            updated_at = NOW()`,
          [userId, stripeSubscriptionId, stripeCustomerId]
        );
        console.log('✅ Updated stripe_subscriptions mapping');
      } catch (err) {
        console.warn('⚠️ Could not upsert stripe_subscriptions:', err.message);
      }
    }

    // 3. Activate subscription (this also creates subscription record)
    try {
      await activateUserSubscription(userId, planId, session, mysqlConnection);

      // ==================================================
      // 🔔 EMAIL + SYSTEM NOTIFICATION (FIRST TIME ONLY)
      // ==================================================
      try {
        const [[user]] = await mysqlConnection.execute(
          `SELECT first_name, email FROM users WHERE id = ?`,
          [userId]
        );

        const [[plan]] = await mysqlConnection.execute(
          `SELECT name FROM plans WHERE id = ?`,
          [planId]
        );
        console.log(plan, "  at line 1147")

        /* ---------- EMAIL ---------- */
        let renewalDate = null;

        if (stripeSubscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(
            stripeSubscriptionId
          );

          renewalDate = subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000)
            : null;
        }

        const emailData = subscriptionCreatedTemplate({
          userName: user.first_name,
          planName: plan?.name || 'Subscription',
          startDate: new Date(),
          endDate: renewalDate,
          paymentType: 'stripe',
          amount,
          currency: currency.toUpperCase()
        });

        await sendEmail({
          to: user.email,
          subject: emailData.subject,
          html: emailData.html,
          text: emailData.text
        });

        /* ---------- SYSTEM NOTIFICATION ---------- */
        await createAndDeliverNotification(
          {
            title: 'Subscription Activated',
            body: 'Your subscription has been successfully activated.',
            channel: 'inbox',
            metadata: {
              action: 'subscription_activated',
              payment_transaction_id: paymentTransactionId,
              stripe_session_id: session.id
            },
            target: {
              type: 'custom',
              user_ids: [userId]
            }
          },
          userId,
          mysqlConnection
        );

        console.log('🔔 Email & notification sent (first-time)');
      } catch (err) {
        console.warn('⚠️ Email/Notification failed (non-blocking):', err.message);
      }

      /* ======================================================
   🔔     AUTO-CREATE DIOCESE FOR DIOCESAN PLAN
      ====================================================== */

      if (planId) {
        const [[plan]] = await mysqlConnection.execute(
          'SELECT slug FROM plans WHERE id = ?',
          [planId]
        );

        if (plan?.slug === 'diocesan-admin') {
          // Check if diocese already exists
          const [[existing]] = await mysqlConnection.execute(
            'SELECT id FROM dioceses WHERE diocesan_admin_id = ?',
            [userId]
          );

          if (!existing) {
            const [[userRow]] = await mysqlConnection.execute(
              'SELECT first_name, last_name, email, phone FROM users WHERE id = ?',
              [userId]
            );

            await mysqlConnection.execute(
              `
        INSERT INTO dioceses
        (diocesan_admin_id, name, email, phone)
        VALUES (?, ?, ?, ?)
        `,
              [
                userId,
                `${userRow.first_name} ${userRow.last_name}`.trim(),
                userRow.email,
                userRow.phone
              ]
            );

            console.log('✅ Diocese created for diocesan admin:', userId);
          }
        }
      }

      console.log('✅ Subscription activated for user:', userId);
    } catch (err) {
      console.error('❌ Error activating subscription:', err.message);
    }

    // 4. Get the internal subscription ID that was created
    if (stripeSubscriptionId) {
      try {
        const [[subRecord]] = await mysqlConnection.execute(
          `SELECT id FROM subscriptions 
           WHERE user_id = ? 
           AND payment_id = ? 
           ORDER BY created_at DESC LIMIT 1`,
          [userId, stripeSubscriptionId]
        );

        if (subRecord) {
          internalSubscriptionId = subRecord.id;
          console.log('✅ Found internal subscription ID:', internalSubscriptionId);
        }
      } catch (err) {
        console.warn('⚠️ Could not fetch internal subscription ID:', err.message);
      }
    }

    // 5. Save payment method
    try {
      await savePaymentMethodFromStripe(userId, session, mysqlConnection);
      console.log('✅ Payment method saved');
    } catch (err) {
      console.warn('⚠️ savePaymentMethodFromStripe error:', err.message);
    }

    // ------------------------------------
    // 6. PROCESS COUPON USAGE
    // ------------------------------------
    let couponUsageSuccess = false;
    let couponUsageMessage = '';

    if (couponCode && couponCode.trim()) {
      try {
        console.log('🎟️ Processing coupon usage:', couponCode);

        // Check if this user already used this coupon
        const [alreadyUsed] = await mysqlConnection.execute(
          `SELECT id FROM coupons 
           WHERE code = ? 
           AND user_id = ? 
           AND status = 'used'`,
          [couponCode.trim(), userId]
        );

        if (alreadyUsed.length > 0) {
          console.log('ℹ️ Coupon already recorded for this user');
          couponUsageMessage = 'Coupon already used';
        } else {
          // Fetch master coupon details
          const [[masterCoupon]] = await mysqlConnection.execute(
            `SELECT * FROM coupons 
             WHERE code = ? 
             AND user_id IS NULL 
             AND status = 'active'
             LIMIT 1`,
            [couponCode.trim()]
          );

          if (!masterCoupon) {
            console.warn('⚠️ Master coupon not found or inactive:', couponCode);
            couponUsageMessage = 'Coupon not found';
          } else {
            // Check total usage limit
            const [[totalUsage]] = await mysqlConnection.execute(
              `SELECT COUNT(*) as count 
               FROM coupons 
               WHERE code = ? 
               AND user_id IS NOT NULL 
               AND status = 'used'`,
              [couponCode.trim()]
            );

            const currentTotalUses = totalUsage?.count || 0;
            const maxTotalUses = masterCoupon.max_total_uses;

            if (maxTotalUses && currentTotalUses >= maxTotalUses) {
              console.warn('⚠️ Coupon max total uses exceeded');
              couponUsageMessage = 'Coupon usage limit exceeded';
            } else {
              // Check per-user usage limit
              const [[userUsage]] = await mysqlConnection.execute(
                `SELECT COUNT(*) as count 
                 FROM coupons 
                 WHERE code = ? 
                 AND user_id = ?`,
                [couponCode.trim(), userId]
              );

              const currentUserUses = userUsage?.count || 0;
              const maxUsesPerUser = masterCoupon.max_uses_per_user || 1;

              if (currentUserUses >= maxUsesPerUser) {
                console.warn('⚠️ Coupon max uses per user exceeded');
                couponUsageMessage = 'You have already used this coupon';
              } else {
                // ✅ CREATE COUPON USAGE RECORD
                const [insertResult] = await mysqlConnection.execute(
                  `INSERT INTO coupons (
                    code,
                    title,
                    description,
                    discount_type,
                    discount_value,
                    max_discount_amount,
                    coupon_for,
                    applicable_plan_id,
                    user_id,
                    plan_id,
                    subscription_id,
                    transaction_id,
                    discount_amount,
                    status,
                    used_at,
                    metadata
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'used', NOW(), ?)`,
                  [
                    masterCoupon.code,
                    masterCoupon.title,
                    masterCoupon.description,
                    masterCoupon.discount_type,
                    masterCoupon.discount_value,
                    masterCoupon.max_discount_amount,
                    masterCoupon.coupon_for,
                    masterCoupon.applicable_plan_id,
                    userId,
                    planId,
                    stripeSubscriptionId || internalSubscriptionId || null, // ✅ Use Stripe ID or internal ID
                    paymentTransactionId,
                    discountAmount,
                    JSON.stringify({
                      source: 'stripe',
                      session_id: session.id,
                      stripe_subscription_id: stripeSubscriptionId,
                      internal_subscription_id: internalSubscriptionId,
                      amount_before_discount: amountBeforeDiscount,
                      final_amount: amount,
                      discount_applied: discountAmount
                    })
                  ]
                );

                console.log('✅ Coupon usage recorded successfully, ID:', insertResult.insertId);
                couponUsageSuccess = true;
                couponUsageMessage = `Coupon applied successfully! You saved $${discountAmount.toFixed(2)}`;

                // Check if master coupon should be expired
                if (maxTotalUses && (currentTotalUses + 1) >= maxTotalUses) {
                  await mysqlConnection.execute(
                    `UPDATE coupons 
                     SET status = 'expired', updated_at = NOW() 
                     WHERE code = ? AND user_id IS NULL`,
                    [couponCode.trim()]
                  );
                  console.log('✅ Master coupon marked as expired (max uses reached)');
                }
              }
            }
          }
        }
      } catch (couponError) {
        console.error('❌ Error processing coupon usage:', couponError);
        couponUsageMessage = 'Failed to apply coupon';
        // Don't fail the entire transaction for coupon errors
      }
    }

    // ------------------------------------
    // 7. Fetch updated user
    // ------------------------------------
    const [usersAfter] = await mysqlConnection.execute(
      `SELECT id, first_name, last_name, email, phone, role, user_type,
        is_composer, parent_user_id, current_plan_id, plan_start_date, plan_end_date, plan_status,
        plan_permissions, custom_permissions, max_sub_users, active_sub_users_count,
        bio, avatar, website_url, twitter_url, address, country, state_province,
        city, postal_code, language, timezone, badges, is_active, is_verified,
        email_verified_at, last_login, login_count, free_trial_expires_at,
        has_upgraded, created_at, updated_at
      FROM users WHERE id = ?`,
      [userId]
    );

    if (usersAfter.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    const userAfter = usersAfter[0];
    userAfter.plan_permissions = userAfter.plan_permissions ?
      JSON.parse(userAfter.plan_permissions) : null;
    userAfter.custom_permissions = userAfter.custom_permissions ?
      JSON.parse(userAfter.custom_permissions) : null;
    userAfter.badges = userAfter.badges ? JSON.parse(userAfter.badges) : null;

    // ------------------------------------
    // 8. Return success response
    // ------------------------------------
    return successResponse(
      res,
      {
        user: userAfter,
        paymentTransactionId,
        subscriptionId: internalSubscriptionId,
        stripeSubscriptionId,
        isNew: true,
        coupon: couponCode ? {
          code: couponCode,
          applied: couponUsageSuccess,
          message: couponUsageMessage,
          discountAmount: discountAmount
        } : null,
        payment: {
          amountBeforeDiscount,
          discountAmount,
          finalAmount: amount,
          currency
        },
        message: 'Payment completed and subscription activated.'
      },
      couponUsageSuccess ?
        `Payment successful! Subscription activated with $${discountAmount.toFixed(2)} discount 🎉` :
        'Payment successful! Subscription activated 🎉'
    );

  } catch (error) {
    console.error('❌ Verify session error:', error);
    return errorResponse(res, 'Failed to verify payment', 500);
  }
});

// ============================================
// HELPER: ACTIVATE USER SUBSCRIPTION
// ============================================

// ============================================
// HELPER: SAVE PAYMENT METHOD FROM STRIPE
// ============================================
async function savePaymentMethodFromStripe(userId, session, mysqlConnection) {
  try {
    console.log(`🔍 Attempting to save payment method for user ${userId}, session ${session.id}`);

    // Retrieve full session with all possible expansions
    const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ['payment_intent', 'payment_intent.payment_method', 'customer', 'subscription', 'subscription.latest_invoice', 'subscription.latest_invoice.payment_intent', 'subscription.latest_invoice.payment_intent.payment_method']
    });

    // Get payment method ID from multiple sources
    let paymentMethodId = null;

    // Method 1: Try from payment intent (most common for one-time payments)
    if (fullSession.payment_intent) {
      // Payment intent can be a string ID or an object
      if (typeof fullSession.payment_intent === 'string') {
        // If it's just an ID, retrieve the payment intent with payment method expanded
        const paymentIntent = await stripe.paymentIntents.retrieve(fullSession.payment_intent, {
          expand: ['payment_method']
        });
        paymentMethodId = paymentIntent.payment_method;
        console.log(`📋 Found payment method from payment intent (string): ${paymentMethodId?.id || 'null'}`);
      } else {
        // If it's already expanded
        paymentMethodId = fullSession.payment_intent.payment_method;
        console.log(`📋 Found payment method from payment intent (object): ${paymentMethodId?.id || 'null'}`);
      }
    }

    // Method 2: Try from subscription's latest invoice (for subscription payments)
    if (!paymentMethodId && fullSession.subscription) {
      let subscription = fullSession.subscription;
      if (typeof subscription === 'string') {
        subscription = await stripe.subscriptions.retrieve(subscription, {
          expand: ['latest_invoice.payment_intent.payment_method']
        });
      }

      if (subscription.latest_invoice) {
        let invoice = subscription.latest_invoice;
        if (typeof invoice === 'string') {
          invoice = await stripe.invoices.retrieve(invoice, {
            expand: ['payment_intent.payment_method']
          });
        }

        if (invoice.payment_intent) {
          let paymentIntent = invoice.payment_intent;
          if (typeof paymentIntent === 'string') {
            paymentIntent = await stripe.paymentIntents.retrieve(paymentIntent, {
              expand: ['payment_method']
            });
          }
          paymentMethodId = paymentIntent.payment_method;
          console.log(`📋 Found payment method from subscription invoice: ${paymentMethodId?.id || 'null'}`);
        }
      }
    }

    // Method 3: Try from customer's default payment method (if customer exists)
    if (!paymentMethodId && fullSession.customer) {
      let customer = fullSession.customer;
      if (typeof customer === 'string') {
        customer = await stripe.customers.retrieve(customer, {
          expand: ['invoice_settings.default_payment_method']
        });
      }

      // Try default payment method
      if (customer.invoice_settings?.default_payment_method) {
        paymentMethodId = customer.invoice_settings.default_payment_method;
        console.log(`📋 Found payment method from customer default: ${paymentMethodId?.id || 'null'}`);
      }

      // If still not found, get the most recent payment method from customer
      if (!paymentMethodId) {
        const paymentMethods = await stripe.paymentMethods.list({
          customer: typeof customer === 'string' ? customer : customer.id,
          type: 'card',
          limit: 1
        });

        if (paymentMethods.data.length > 0) {
          paymentMethodId = paymentMethods.data[0];
          console.log(`📋 Found payment method from customer's payment methods list: ${paymentMethodId?.id || 'null'}`);
        }
      }
    }

    // Method 4: Try from session directly (rare but possible)
    if (!paymentMethodId && fullSession.payment_method) {
      paymentMethodId = fullSession.payment_method;
      console.log(`📋 Found payment method from session directly: ${paymentMethodId?.id || 'null'}`);
    }

    if (!paymentMethodId) {
      console.log('⚠️ No payment method found in session after all attempts');
      console.log('Session details:', {
        session_id: session.id,
        payment_intent: fullSession.payment_intent?.id || fullSession.payment_intent,
        customer: fullSession.customer?.id || fullSession.customer,
        subscription: fullSession.subscription?.id || fullSession.subscription,
        payment_status: fullSession.payment_status
      });
      return;
    }

    // If payment method is a string ID, retrieve it
    if (typeof paymentMethodId === 'string') {
      paymentMethodId = await stripe.paymentMethods.retrieve(paymentMethodId);
    }

    // Now paymentMethodId should be an object
    const paymentMethod = paymentMethodId;

    // Only save card payment methods
    if (paymentMethod.type !== 'card') {
      console.log(`⚠️ Payment method type ${paymentMethod.type} is not a card, skipping save`);
      return;
    }

    const card = paymentMethod.card;
    if (!card) {
      console.log('⚠️ No card details found in payment method');
      return;
    }

    // Extract billing details
    const billingDetails = paymentMethod.billing_details;
    const cardHolderName = billingDetails?.name || 'Card Holder';

    // Build billing address string
    let billingAddress = null;
    if (billingDetails?.address) {
      const addr = billingDetails.address;
      const addressParts = [];
      if (addr.line1) addressParts.push(addr.line1);
      if (addr.line2) addressParts.push(addr.line2);
      if (addr.city) addressParts.push(addr.city);
      if (addr.state) addressParts.push(addr.state);
      if (addr.postal_code) addressParts.push(addr.postal_code);
      if (addr.country) addressParts.push(addr.country);
      billingAddress = addressParts.join(', ').trim() || null;
    }

    // Check if this card already exists for the user
    const [existingCards] = await mysqlConnection.execute(
      `SELECT id FROM user_payment_methods 
       WHERE user_id = ? 
       AND card_last4 = ? 
       AND expiry_month = ? 
       AND expiry_year = ? 
       AND deleted_at IS NULL`,
      [userId, card.last4, card.exp_month, card.exp_year]
    );

    if (existingCards.length > 0) {
      console.log('✅ Card already exists, skipping duplicate save');
      return;
    }

    // Check if user has any default card, if not, set this as default
    const [defaultCards] = await mysqlConnection.execute(
      `SELECT id FROM user_payment_methods 
       WHERE user_id = ? 
       AND is_default = 1 
       AND deleted_at IS NULL`,
      [userId]
    );

    const isDefault = defaultCards.length === 0 ? 1 : 0;

    // Save card details to database
    await mysqlConnection.execute(
      `INSERT INTO user_payment_methods (
        user_id, card_holder_name, card_last4, card_brand,
        expiry_month, expiry_year, billing_address, is_default
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        cardHolderName,
        card.last4,
        card.brand || null,
        card.exp_month,
        card.exp_year,
        billingAddress,
        isDefault
      ]
    );

    console.log(`✅ Payment method saved for user ${userId}: ${card.brand} ****${card.last4}`);

  } catch (error) {
    console.error('❌ Error saving payment method:', error.message);
    // Don't throw error, just log it so subscription activation continues
  }
}

// helper: normalize value -> return id string or null
function normId(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v.id) return v.id;
  try { return String(v); } catch (e) { return null; }
}

async function activateUserSubscription(userId, planId, session, mysqlConnection) {
  // normalize session ids early
  const stripeCustomerId = normId(session.customer);
  const stripeSubscriptionId = normId(session.subscription);
  const stripePaymentIntentId = normId(session.payment_intent);
  const sessionId = normId(session.id) || null;

  // load plan
  const [plans] = await mysqlConnection.execute(
    'SELECT * FROM plans WHERE id = ? LIMIT 1',
    [planId]
  );
  if (!plans || plans.length === 0) throw new Error('Plan not found');
  const plan = plans[0];

  // Calculate subscription dates
  const planStartDate = new Date();
  let planEndDate = new Date(planStartDate);

  switch ((plan.billing_cycle || '').toLowerCase()) {
    case 'monthly':
    case 'month':
      planEndDate.setMonth(planEndDate.getMonth() + 1);
      break;
    case 'yearly':
    case 'year':
      planEndDate.setFullYear(planEndDate.getFullYear() + 1);
      break;
    case 'one-time':
      planEndDate.setFullYear(planEndDate.getFullYear() + 100);
      break;
    default:
      // fallback to 1 month
      planEndDate.setMonth(planEndDate.getMonth() + 1);
  }

  // Fetch plan features and build permissions (best-effort)
  let planPermissions = {};
  try {
    const [planFeatures] = await mysqlConnection.execute(
      `SELECT 
          f.name AS feature_name,
          f.slug AS feature_slug,
          f.category,
          pt.name AS permission_type,
          pf.custom_value
       FROM plan_features pf
       JOIN features f ON pf.feature_id = f.id
       JOIN permission_types pt ON pf.permission_type_id = pt.id
       WHERE pf.plan_id = ? AND f.is_active = TRUE
       ORDER BY f.category, f.display_order, f.name`,
      [planId]
    );

    (planFeatures || []).forEach(feature => {
      const category = feature.category || 'general';
      const featureName = feature.feature_name;
      const permissionType = feature.permission_type || 'x';
      if (!planPermissions[category]) planPermissions[category] = {};

      if (permissionType === 'custom' || (permissionType === 'access-level' && feature.custom_value !== null)) {
        const value = Number(feature.custom_value);
        if (!isNaN(value)) {
          planPermissions[category][featureName] = { type: permissionType, limit: value, used: 0 };
        } else {
          planPermissions[category][featureName] = permissionType;
        }
      } else {
        planPermissions[category][featureName] = permissionType;
      }
    });
  } catch (err) {
    console.warn('Could not build planPermissions:', err.message);
    planPermissions = null;
  }

  // ----------------------------
  // Update users table (activate plan for user)
  // ----------------------------
  try {
    await mysqlConnection.execute(
      `UPDATE users SET 
        current_plan_id = ?,
        plan_start_date = ?,
        plan_end_date = ?,
        plan_status = 'active',
        role = 'user',
        user_type = 'admin',
        plan_permissions = ?,
        has_upgraded = TRUE,
        updated_at = NOW()
      WHERE id = ?`,
      [
        planId,
        planStartDate.toISOString().slice(0, 19).replace('T', ' '),
        planEndDate.toISOString().slice(0, 19).replace('T', ' '),
        planPermissions ? JSON.stringify(planPermissions) : null,
        userId
      ]
    );
  } catch (err) {
    console.warn('Failed to update user with new plan during activation:', err.message);
    // continue
  }

  // ----------------------------
  // Update payment_transactions if session exists (mark completed)
  // ----------------------------
  try {
    if (sessionId) {
      await mysqlConnection.execute(
        `UPDATE payment_transactions 
         SET status = 'completed', 
             stripe_payment_intent_id = ?,
             completed_at = NOW(),
             updated_at = NOW()
         WHERE stripe_session_id = ?`,
        [stripePaymentIntentId, sessionId]
      );
    }
  } catch (err) {
    console.warn('Failed to update payment_transactions for session:', err.message);
  }

  // Try to find the payment_transaction id we just updated (best-effort)
  let paymentTransactionId = null;
  try {
    if (sessionId) {
      const [txnRows] = await mysqlConnection.execute(
        `SELECT id FROM payment_transactions WHERE stripe_session_id = ? ORDER BY created_at DESC LIMIT 1`,
        [sessionId]
      );
      if (txnRows && txnRows.length > 0) paymentTransactionId = txnRows[0].id;
    }
  } catch (err) {
    console.warn('Could not lookup payment_transaction id for subscription linking:', err.message);
  }

  // ----------------------------
  // Determine payment_type and paymentId
  // ----------------------------
  let payment_type = 'stripe';
  let paymentId = null;

  if (stripeSubscriptionId) {
    paymentId = stripeSubscriptionId;
    payment_type = 'stripe';
  } else if (stripePaymentIntentId) {
    paymentId = stripePaymentIntentId;
    payment_type = 'stripe';
  } else {
    payment_type = 'manual';
    paymentId = null;
  }

  // ----------------------------
  // Insert or update subscription row
  // ----------------------------
  try {
    // ensure metadata object
    const metadataObj = {
      created_from_session: sessionId,
      stripe_session: sessionId
    };

    // columns: user_id, subscription_name, plan_id, payment_transaction_id, payment_id,
    // payment_type, status, payment_status, start_date, end_date, metadata, created_at, updated_at
    // placeholders: 11 ? then NOW(), NOW()
    await mysqlConnection.execute(
      `INSERT INTO subscriptions 
         (user_id, subscription_name, plan_id, payment_transaction_id, payment_id, payment_type, status, payment_status, start_date, end_date, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         subscription_name = VALUES(subscription_name),
         plan_id = VALUES(plan_id),
         payment_transaction_id = VALUES(payment_transaction_id),
         payment_id = VALUES(payment_id),
         payment_type = VALUES(payment_type),
         status = VALUES(status),
         payment_status = VALUES(payment_status),
         start_date = VALUES(start_date),
         end_date = VALUES(end_date),
         metadata = VALUES(metadata),
         updated_at = NOW()`,
      [
        userId,
        plan.name || null,
        planId,
        paymentTransactionId,
        paymentId,
        payment_type,
        'active',
        'completed',
        planStartDate.toISOString().slice(0, 19).replace('T', ' '),
        planEndDate.toISOString().slice(0, 19).replace('T', ' '),
        JSON.stringify(metadataObj)
      ]
    );
  } catch (err) {
    console.error('❌ Failed to insert/update subscription row:', err.message);
    // Not fatal — continue
  }

  // ----------------------------
  // 🔥 ROYALTY ENGINE: distribute Music/Academy/Documents pools
  // immediately, based on this plan's revenue allocation % and
  // current cumulative usage. Never blocks subscription activation.
  // ----------------------------
  try {
    await distributeSubscriptionRevenueRealtime({
      mysql: mysqlConnection,
      planId,
      planPrice: plan.price,
      subscriberUserId: userId
    });
  } catch (err) {
    console.error('❌ Real-time royalty distribution failed for subscription:', err.message);
  }

  // ----------------------------
  // Upsert stripe_subscriptions mapping (if stripe subscription id exists)
  // ----------------------------
  if (stripeSubscriptionId) {
    try {
      await mysqlConnection.execute(
        `INSERT INTO stripe_subscriptions 
          (user_id, stripe_subscription_id, stripe_customer_id, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', NOW(), NOW())
         ON DUPLICATE KEY UPDATE
           status = VALUES(status),
           stripe_customer_id = VALUES(stripe_customer_id),
           updated_at = NOW()`,
        [userId, stripeSubscriptionId, stripeCustomerId]
      );
    } catch (err) {
      console.warn('⚠️ Could not upsert stripe_subscriptions mapping:', err.message);
    }
  }

  // ----------------------------
  // Save payment method (card details) from Stripe (best-effort)
  // ----------------------------
  try {
    await savePaymentMethodFromStripe(userId, session, mysqlConnection);
  } catch (err) {
    console.warn('⚠️ savePaymentMethodFromStripe error:', err.message);
  }

  console.log(`✅ User ${userId} subscription activated (Plan ${planId})`);
}

// ============================================
// HELPER: REGENERATE PERMISSIONS FOR PLAN USERS
// ============================================

async function regeneratePermissionsForPlanUsers(planId, mysqlConnection) {
  try {
    console.log(`🔄 Regenerating permissions for plan ${planId} users...`);

    // Fetch all active users with this plan
    const [usersWithPlan] = await mysqlConnection.execute(
      `SELECT id, plan_permissions 
       FROM users 
       WHERE current_plan_id = ? AND plan_status = 'active'`,
      [planId]
    );

    if (usersWithPlan.length === 0) {
      console.log(`ℹ️ No active users found for plan ${planId}`);
      return { updated: 0, users: [] };
    }

    console.log(`📊 Found ${usersWithPlan.length} users with plan ${planId}`);

    // Fetch current plan features
    const [planFeatures] = await mysqlConnection.execute(
      `SELECT 
          f.name AS feature_name,
          f.slug AS feature_slug,
          f.category,
          pt.name AS permission_type,
          pf.custom_value
       FROM plan_features pf
       JOIN features f ON pf.feature_id = f.id
       JOIN permission_types pt ON pf.permission_type_id = pt.id
       WHERE pf.plan_id = ? AND f.is_active = TRUE
       ORDER BY f.category, f.display_order, f.name`,
      [planId]
    );

    // Generate new permissions structure
    const newPlanPermissions = {};
    planFeatures.forEach(feature => {
      const category = feature.category;
      const featureName = feature.feature_name;
      const permissionType = feature.permission_type || 'x';

      if (!newPlanPermissions[category]) {
        newPlanPermissions[category] = {};
      }

      if (permissionType === 'custom' || (permissionType === 'access-level' && feature.custom_value !== null)) {
        const value = Number(feature.custom_value);
        if (!isNaN(value)) {
          newPlanPermissions[category][featureName] = {
            type: permissionType,
            limit: value,
            used: 0
          };
        } else {
          newPlanPermissions[category][featureName] = permissionType;
        }
      } else {
        newPlanPermissions[category][featureName] = permissionType;
      }
    });

    console.log('🆕 New permissions structure:', JSON.stringify(newPlanPermissions, null, 2));

    // Update each user's permissions while preserving usage data
    const updatedUsers = [];
    for (const user of usersWithPlan) {
      try {
        let currentPermissions = {};
        if (user.plan_permissions) {
          try {
            currentPermissions = JSON.parse(user.plan_permissions);
          } catch (parseError) {
            console.warn(`⚠️ Invalid JSON in user ${user.id} permissions, using empty object`);
          }
        }

        // Merge new permissions with existing usage data
        const mergedPermissions = { ...newPlanPermissions };

        // Preserve existing usage data for custom/access-level features
        Object.keys(mergedPermissions).forEach(category => {
          Object.keys(mergedPermissions[category]).forEach(featureName => {
            const newPermission = mergedPermissions[category][featureName];

            // If it's a custom permission with usage tracking
            if (typeof newPermission === 'object' && newPermission.type && newPermission.limit !== undefined) {
              // Check if user had existing usage data for this feature
              if (currentPermissions[category] &&
                currentPermissions[category][featureName] &&
                typeof currentPermissions[category][featureName] === 'object' &&
                currentPermissions[category][featureName].used !== undefined) {

                // Preserve the existing usage, but update limit
                mergedPermissions[category][featureName] = {
                  type: newPermission.type,
                  limit: newPermission.limit,
                  used: Math.min(currentPermissions[category][featureName].used, newPermission.limit) // Ensure used doesn't exceed new limit
                };
              }
            }
          });
        });

        // Update user permissions
        await mysqlConnection.execute(
          `UPDATE users SET 
            plan_permissions = ?,
            updated_at = NOW()
           WHERE id = ?`,
          [JSON.stringify(mergedPermissions), user.id]
        );

        updatedUsers.push({
          userId: user.id,
          oldPermissions: currentPermissions,
          newPermissions: mergedPermissions
        });

        console.log(`✅ Updated permissions for user ${user.id}`);
      } catch (userError) {
        console.error(`❌ Error updating user ${user.id}:`, userError.message);
      }
    }

    console.log(`✅ Regenerated permissions for ${updatedUsers.length}/${usersWithPlan.length} users`);
    return { updated: updatedUsers.length, users: updatedUsers };

  } catch (error) {
    console.error('❌ Error regenerating permissions:', error.message);
    throw error;
  }
}

// ============================================
// WEBHOOKS
// ============================================ 

// @route   POST /api/webhook
// @desc    Handle Stripe webhook (Music + Subscription)
// @access  Public

router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {

  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log("🎯 Webhook Event:", event.type);

  const mysql = getMySQLConnection();
  const insertedLibraryItems = [];

  try {

    // ============================================
    // 🛑 IDEMPOTENCY CHECK
    // ============================================
    const [existing] = await mysql.execute(
      `SELECT id FROM webhook_logs WHERE event_id=? LIMIT 1`,
      [event.id]
    );

    if (existing.length) {
      console.log("⚠️ Duplicate webhook ignored:", event.id);
      return res.json({ received: true });
    }

    // ============================================
    // 🎯 SWITCH EVENTS
    // ============================================
    switch (event.type) {

      // ============================================
      // ✅ CHECKOUT COMPLETED (MAIN ENTRY)
      // ============================================
      case "checkout.session.completed": {

        const session = event.data.object;

        if (session.payment_status !== "paid") {
          console.log("❌ Payment not completed");
          break;
        }

        const metadata = session.metadata || {};
        const type = metadata.type;

        // ============================================
        // 🎵 MUSIC PURCHASE
        // ============================================
        if (type === "music") {

          const userId = Number(metadata.user_id);
          const finalAmount = session.amount_total / 100;

          console.log("🎵 Music Purchase:", userId);

          let products = [];
          try {
            products = JSON.parse(metadata.products || "[]");
          } catch {
            products = [];
          }

          if (!products.length) {
            console.log("❌ No products found");
            break;
          }

          // ================= TRANSACTION =================
          const [[existingTx]] = await mysql.execute(
            `SELECT id FROM music_transactions WHERE stripe_session_id=? LIMIT 1`,
            [session.id]
          );

          let transactionId;

          if (existingTx) {
            transactionId = existingTx.id;

            await mysql.execute(
              `UPDATE music_transactions 
               SET status='completed', updated_at=NOW() 
               WHERE id=?`,
              [transactionId]
            );

          } else {
            const [tx] = await mysql.execute(
              `INSERT INTO music_transactions(
                user_id,
                stripe_session_id,
                stripe_payment_intent_id,
                stripe_customer_id,
                total_amount,
                currency,
                status,
                payment_method,
                products_json,
                created_at,
                completed_at
              )
              VALUES(?,?,?,?,?,'usd','completed','stripe',?,NOW(),NOW())`,
              [
                userId,
                session.id,
                session.payment_intent || null,
                session.customer,
                finalAmount,
                JSON.stringify(products)
              ]
            );

            transactionId = tx.insertId;
          }

          // ================= ADD MUSIC =================
          for (const item of products) {

            const musicId = item.musicPublicationId;

            const [[music]] = await mysql.execute(
              `SELECT * FROM music_publications 
               WHERE id=? AND status='published'`,
              [musicId]
            );

            if (!music) continue;

            const [exists] = await mysql.execute(
              `SELECT id FROM user_music_library 
               WHERE user_id=? AND music_publication_id=?`,
              [userId, musicId]
            );

            if (exists.length) continue;

            // music_files se primary file nikalo
            let musicFiles = [];
            try {
              musicFiles = music.music_files ? JSON.parse(music.music_files) : [];
            } catch { musicFiles = []; }

            const primaryFile = musicFiles[0] || {};
            const fileName = primaryFile.fileName || music.composition_title || 'music-file';
            const fileUrl = primaryFile.fileUrl || primaryFile.url || '';
            const fileSize = primaryFile.fileSize || primaryFile.size || null;

            // file_type validate karo
            const validFileTypes = ['assembly', 'octavo', 'chords', 'music_lyrics', 'mp3', 'pdf', 'music'];
            let fileType = primaryFile.fileType || primaryFile.type || 'music';
            if (!validFileTypes.includes(fileType)) fileType = 'music';

            // price fallback
            const price = parseFloat(item.price) || parseFloat(music.price) || 7.50;

            // safe JSON stringify
            const safeStringify = (data) => {
              if (!data) return null;
              if (typeof data === 'string') return data;
              return JSON.stringify(data);
            };

            // Full insert
            await mysql.execute(
              `INSERT IGNORE INTO user_music_library (
                user_id, music_publication_id, file_type, file_name, file_url, file_size, price,
                composer_id, composition_title, composition_title_1, composition_description,
                composer_firstname, composer_lastname,
                is_part_of_collection, collection_id, collection_name,
                vocal_parts, instrumentation, types_of_music,
                first_line_of_composition, composition_copyrights, song_type,
                meter, season, psalm_number, liturgicalText, verseStyle, feast,
                text_copyright_notice, tune_copyright_notice,
                artists, music_files, music_video_link, artwork_file_url, artwork_file_size,
                tune, general_details, country_restrictions,
                is_public_domain, can_be_reprinted, can_be_podcast_streamed,
                can_make_commercial_recording, can_make_non_commercial_recording,
                purchase_date
              ) VALUES (
                ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?,
                ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?,
                ?, ?,
                NOW()
              )`,
              [
                userId, musicId, fileType, fileName, fileUrl, fileSize, price,
                // Composer
                music.composer_id,
                music.composition_title,
                music.composition_title_1,
                music.composition_description,
                music.composer_firstname,
                music.composer_lastname,
                // Collection
                music.is_part_of_collection || false,
                music.collection_id || null,
                music.collection_name || null,
                // Music details
                safeStringify(music.vocal_parts),
                safeStringify(music.instrumentation),
                music.types_of_music,
                // OneLicense
                music.first_line_of_composition,
                safeStringify(music.composition_copyrights),
                music.song_type || 'music',
                music.meter,
                music.season,
                music.psalm_number,
                music.liturgicalText,
                music.verseStyle,
                music.feast,
                // Copyright
                music.text_copyright_notice,
                music.tune_copyright_notice,
                // Files
                safeStringify(music.artists),
                safeStringify(music.music_files),
                music.music_video_link,
                music.artwork_file_url,
                music.artwork_file_size,
                // General
                music.tune,
                music.general_details,
                music.country_restrictions,
                // Permissions
                music.is_public_domain || false,
                music.can_be_reprinted || false,
                music.can_be_podcast_streamed || false,
                music.can_make_commercial_recording || false,
                music.can_make_non_commercial_recording || false
              ]
            );

            insertedLibraryItems.push({
              musicId,
              composition_title: music.composition_title,
              price,
              user_id: userId
            });

            // 🔥 ROYALTY ENGINE: deduct ICEL/USCCB/CCD, split 30% to composer
            // Never blocks the purchase flow - errors are logged internally.
            await recordMusicALaCarteEarning({
              mysql,
              musicPublicationId: musicId,
              buyerUserId: userId,
              salePrice: price,
              transactionId: transactionId,
              stripeSessionId: session.id,
              paymentMethod: 'stripe'
            });

          }
          console.log("📚 User Music Library inserted items:", JSON.stringify(insertedLibraryItems, null, 2));

          // ================= CLEAR CART =================
          await mysql.execute(
            `DELETE FROM user_music_cart WHERE user_id=?`,
            [userId]
          );

          console.log("🎉 Music added to library");

          // ================= EMAIL =================
          try {
            await sendEmail({
              to: "kevin.digitalgrowthus@gmail.com",
              subject: "🎉 New Music Purchase",
              html: `
                <h2>🎶 Payment Received</h2>
                <p>User ID: ${userId}</p>
                <p>Amount: $${finalAmount}</p>
                <pre>${JSON.stringify(products, null, 2)}</pre>
              `
            });
          } catch (e) {
            console.log("❌ Email error:", e.message);
          }

        }

        // ============================================
        // 🎓 COURSE CART PURCHASE (Academy - educator royalty)
        // ------------------------------------------------------------
        // Reliable server-side fallback for the same flow that
        // routes/Educator-Portal/educator-cart.js's GET /verify-session
        // does client-side. Both are idempotent (UNIQUE KEY on
        // course_enrollments(course_id, student_id) + a payment_id
        // UNIQUE KEY on course_purchases), so whichever fires first
        // does the real work and the other just no-ops.
        // ============================================
        else if (type === "cart_purchase") {

          const userId = Number(metadata.user_id);
          console.log("🎓 Course Cart Purchase:", userId);

          let courseIds = [];
          try {
            courseIds = JSON.parse(metadata.course_ids || "[]");
          } catch {
            courseIds = [];
          }

          if (!courseIds.length) {
            console.log("❌ No course_ids found in cart_purchase metadata");
            break;
          }

          const [[existingCheckout]] = await mysql.execute(
            `SELECT id, status FROM cart_checkout_sessions WHERE stripe_session_id = ? LIMIT 1`,
            [session.id]
          );

          if (existingCheckout && existingCheckout.status === "completed") {
            console.log("⚠️ Cart checkout session already processed:", session.id);
            break;
          }

          await mysql.execute(
            `UPDATE cart_checkout_sessions SET status = 'completed', updated_at = NOW() WHERE stripe_session_id = ?`,
            [session.id]
          );

          const perCoursePaid = typeof session.amount_total === "number"
            ? session.amount_total / 100 / courseIds.length
            : null;

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

            if (existingEnrollment) continue; // already enrolled via verify-session (or a prior webhook retry)

            const coursePrice = perCoursePaid ?? course.price;

            try {
              await mysql.execute(
                `INSERT INTO course_purchases
                    (course_id, student_id, payment_provider, payment_id, amount, currency, payment_status)
                 VALUES (?, ?, 'stripe', ?, ?, ?, 'paid')`,
                [
                  courseId, userId,
                  `${session.payment_intent || session.id}:${courseId}`,
                  coursePrice, session.currency || course.currency
                ]
              );
            } catch (err) {
              // payment_id UNIQUE constraint - verify-session already recorded this purchase
              console.warn("⚠️ course_purchases insert skipped (likely already recorded):", err.message);
            }

            const [enrollResult] = await mysql.execute(
              `INSERT INTO course_enrollments (course_id, student_id, source_type, price_at_enrollment) VALUES (?, ?, 'a_la_carte', ?)`,
              [courseId, userId, coursePrice]
            );

            await mysql.execute(
              `UPDATE courses SET total_students = total_students + 1 WHERE id = ?`,
              [courseId]
            );

            await mysql.execute(
              `DELETE FROM course_cart WHERE course_id = ? AND student_id = ?`,
              [courseId, userId]
            );

            // 🔥 ROYALTY ENGINE: deduct ICEL/USCCB/CCD, split 30% to educator
            await recordEducatorALaCarteEarning({
              mysql,
              courseId,
              buyerUserId: userId,
              salePrice: coursePrice,
              transactionId: session.payment_intent || null,
              stripeSessionId: session.id,
              paymentMethod: 'stripe'
            });

            console.log(`🎉 Enrolled user ${userId} in course ${courseId} via webhook`);
          }

        }

        // ============================================
        // 📦 SUBSCRIPTION
        // ============================================
        else if (type === "subscription") {

          await handleCheckoutCompleted(session, mysql);

        } else {
          console.log("⚠️ Unknown checkout type");
        }

        break;
      }

      // ============================================
      // 💳 PAYMENT SUCCESS
      // ============================================
      case "payment_intent.succeeded":
        await handlePaymentSucceeded(event.data.object, mysql);
        break;

      // ============================================
      // 🔁 SUBSCRIPTION UPDATE
      // ============================================
      case "customer.subscription.updated":
        await handleSubscriptionUpdated(event.data.object, mysql);
        break;

      // ============================================
      // ❌ SUBSCRIPTION DELETE
      // ============================================
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event.data.object, mysql);
        break;

      default:
        console.log("⚠️ Unhandled event:", event.type);
    }

    // ============================================
    // 📝 SAVE LOG
    // ============================================
    await mysql.execute(
      `INSERT INTO webhook_logs (event_id, event_type, processed, payload)
       VALUES (?, ?, TRUE, ?)`,
      [event.id, event.type, JSON.stringify(event.data.object)]
    );

    return res.json({ received: true, userMusicLibrary: insertedLibraryItems });

  } catch (error) {
    console.error("❌ WEBHOOK ERROR:", error);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
});

async function handleCheckoutCompleted(session, mysqlConnection) {
  if (session.payment_status === 'paid') {
    const userId = parseInt(session.metadata.user_id);
    const planId = parseInt(session.metadata.plan_id);
    await activateUserSubscription(userId, planId, session, mysqlConnection);
  }
}

async function handlePaymentSucceeded(paymentIntent, mysqlConnection) {
  await mysqlConnection.execute(
    `UPDATE payment_transactions 
     SET status = 'completed', stripe_payment_intent_id = ?, updated_at = NOW()
     WHERE stripe_customer_id = ? AND status = 'pending'
     ORDER BY created_at DESC LIMIT 1`,
    [paymentIntent.id, paymentIntent.customer]
  );
}

async function handleSubscriptionUpdated(subscription, mysqlConnection) {
  if (subscription.status === 'canceled' || subscription.status === 'unpaid') {
    const [sub] = await mysqlConnection.execute(
      'SELECT user_id FROM stripe_subscriptions WHERE stripe_subscription_id = ?',
      [subscription.id]
    );
    if (sub.length > 0) {
      await mysqlConnection.execute(
        `UPDATE users SET plan_status = 'expired' WHERE id = ?`,
        [sub[0].user_id]
      );
    }
  }
}

async function handleSubscriptionDeleted(subscription, mysqlConnection) {
  const [sub] = await mysqlConnection.execute(
    'SELECT user_id FROM stripe_subscriptions WHERE stripe_subscription_id = ?',
    [subscription.id]
  );
  if (sub.length > 0) {
    await mysqlConnection.execute(
      `UPDATE users SET plan_status = 'expired', current_plan_id = NULL WHERE id = ?`,
      [sub[0].user_id]
    );
  }
}

// ============================================
// PAYMENT HISTORY & MANAGEMENT
// ============================================

router.get('/history', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const [transactions] = await mysqlConnection.execute(
      `SELECT pt.*, p.name as plan_name, p.billing_cycle
      FROM payment_transactions pt
      LEFT JOIN plans p ON pt.plan_id = p.id
      WHERE pt.user_id = ?
      ORDER BY pt.created_at DESC`,
      [req.user.id]
    );

    successResponse(res, { transactions, total: transactions.length }, 'Payment history retrieved successfully');
  } catch (error) {
    console.error('❌ Payment history error:', error.message);
    errorResponse(res, 'Failed to retrieve payment history', 500);
  }
});

// ======================================================
// @route   GET /api/subscriptions/status
// @desc    Get current user subscription + plan + features
// @access  Private
// ======================================================
router.get('/subscription/status', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    /* ======================================================
       1️⃣ GET USER + PLAN + STRIPE INFO (single query)
    ====================================================== */
    const [rows] = await mysqlConnection.execute(
      `
      SELECT
        u.id,
        u.plan_permissions,
        u.plan_start_date,
        u.plan_end_date,
        u.plan_status,

        p.id AS plan_id,
        p.name AS plan_name,
        p.slug,
        p.description,
        p.price,
        p.billing_cycle,

        ss.id AS stripe_id,
        ss.stripe_subscription_id,
        ss.stripe_customer_id,
        ss.status AS stripe_status,
        ss.cancel_at_period_end,
        ss.created_at AS stripe_created_at,
        ss.updated_at AS stripe_updated_at

      FROM users u
      LEFT JOIN plans p ON u.current_plan_id = p.id
      LEFT JOIN stripe_subscriptions ss
        ON ss.user_id = u.id
        AND ss.status IN ('active','trialing')

      WHERE u.id = ?
      LIMIT 1
      `,
      [userId]
    );

    if (!rows.length) {
      return errorResponse(res, 'User not found', 404);
    }

    const sub = rows[0];


    /* ======================================================
       2️⃣ HELPERS (US FORMAT)
    ====================================================== */
    const formatDate = (d) =>
      d ? new Date(d).toLocaleDateString('en-US') : null;

    const formatUSD = (amount) =>
      amount !== null && amount !== undefined
        ? new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: 'USD'
        }).format(amount)
        : '$0.00';


    /* ======================================================
       3️⃣ ✅ FIXED SUBSCRIPTION LOGIC
    ====================================================== */

    // Stripe billing active
    const hasActiveStripe =
      sub.stripe_status === 'active' ||
      sub.stripe_status === 'trialing';

    // Plan access active (SOURCE OF TRUTH)
    const hasActivePlan =
      sub.plan_status === 'active';

    // FINAL RESULT (FIX)
    const hasSubscription =
      hasActiveStripe || hasActivePlan;


    /* ======================================================
       4️⃣ PARSE PERMISSIONS
    ====================================================== */
    let planPermissions = null;

    if (sub.plan_permissions) {
      try {
        planPermissions = JSON.parse(sub.plan_permissions);
      } catch {
        planPermissions = null;
      }
    }


    /* ======================================================
       5️⃣ FETCH FEATURES (if plan exists)
    ====================================================== */
    let featuresByCategory = {};

    if (sub.plan_id) {
      const [features] = await mysqlConnection.execute(
        `
        SELECT
          f.id,
          f.name,
          f.slug,
          f.category,
          f.description,
          pt.name AS permission_type,
          pt.label AS permission_label,
          pf.custom_value
        FROM plan_features pf
        JOIN features f ON pf.feature_id = f.id
        JOIN permission_types pt ON pf.permission_type_id = pt.id
        WHERE pf.plan_id = ? AND f.is_active = TRUE
        ORDER BY f.category, f.display_order
        `,
        [sub.plan_id]
      );

      for (const f of features) {
        if (!featuresByCategory[f.category]) {
          featuresByCategory[f.category] = [];
        }

        featuresByCategory[f.category].push({
          id: f.id,
          name: f.name,
          slug: f.slug,
          description: f.description,
          permissionType: f.permission_type,
          permissionLabel: f.permission_label,
          customValue: f.custom_value
        });
      }
    }


    /* ======================================================
       6️⃣ BUILD RESPONSE
    ====================================================== */
    const response = {
      hasSubscription, // ✅ now correct

      status: sub.plan_status || 'free',

      subscription: hasActiveStripe
        ? {
          id: sub.stripe_id,
          stripeSubscriptionId: sub.stripe_subscription_id,
          stripeCustomerId: sub.stripe_customer_id,
          status: sub.stripe_status,
          cancelAtPeriodEnd: !!sub.cancel_at_period_end,
          createdAt: formatDate(sub.stripe_created_at),
          updatedAt: formatDate(sub.stripe_updated_at)
        }
        : null,

      plan: sub.plan_id
        ? {
          id: sub.plan_id,
          name: sub.plan_name,
          slug: sub.slug,
          description: sub.description,
          price: formatUSD(sub.price),
          billingCycle: sub.billing_cycle,
          startDate: formatDate(sub.plan_start_date),
          endDate: formatDate(sub.plan_end_date),
          status: sub.plan_status
        }
        : {
          name: 'Free Plan',
          status: 'free'
        },

      features:
        Object.keys(featuresByCategory).length > 0
          ? featuresByCategory
          : null,

      permissions: planPermissions
    };


    return successResponse(
      res,
      response,
      'Subscription status retrieved successfully'
    );

  } catch (error) {
    console.error('❌ Subscription status error:', error);
    return errorResponse(res, 'Failed to retrieve subscription status', 500);
  }
});

router.post('/subscription/cancel', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();
    // Get subscription details
    const [subscription] = await mysqlConnection.execute(
      `SELECT stripe_subscription_id, user_id FROM stripe_subscriptions 
       WHERE user_id = ? AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );

    if (subscription.length === 0) {
      return errorResponse(res, 'No active subscription found', 404);
    }

    // Cancel subscription in Stripe
    const canceled = await stripe.subscriptions.update(
      subscription[0].stripe_subscription_id,
      { cancel_at_period_end: true }
    );

    // Update subscription status in database
    await mysqlConnection.execute(
      `UPDATE stripe_subscriptions 
       SET cancel_at_period_end = TRUE, updated_at = NOW()
       WHERE stripe_subscription_id = ?`,
      [subscription[0].stripe_subscription_id]
    );

    // Get user's current plan to check for sub-user limits
    const [userPlans] = await mysqlConnection.execute(
      `SELECT u.id, u.current_plan_id, p.id as plan_id
       FROM users u
       LEFT JOIN plans p ON u.current_plan_id = p.id
       WHERE u.id = ?`,
      [userId]
    );

    let deactivatedSubUsers = 0;

    // If user has a plan with sub-user feature, deactivate all sub-users
    if (userPlans.length > 0 && userPlans[0].plan_id) {
      const planId = userPlans[0].plan_id;

      // Check if plan has sub-user feature
      const [subUserFeature] = await mysqlConnection.execute(
        `SELECT pf.id, pf.custom_value
         FROM plan_features pf
         JOIN features f ON pf.feature_id = f.id
         WHERE pf.plan_id = ? AND f.slug = 'sub-users'`,
        [planId]
      );

      // If plan has sub-user limit, deactivate all sub-users
      if (subUserFeature.length > 0) {
        const [deactivateResult] = await mysqlConnection.execute(
          `UPDATE users 
           SET is_active = FALSE, updated_at = NOW()
           WHERE parent_user_id = ? AND user_type = 'sub_user'`,
          [userId]
        );

        deactivatedSubUsers = deactivateResult.affectedRows;
        console.log(`✅ Deactivated ${deactivatedSubUsers} sub-users for parent user ${userId}`);
      }
    }

    // Update user plan status and permissions after cancellation
    await mysqlConnection.execute(
      `UPDATE users 
       SET plan_status = 'cancelled',
           plan_permissions = NULL,
           custom_permissions = NULL,
           active_sub_users_count = 0,
           updated_at = NOW()
       WHERE id = ?`,
      [userId]
    );

    // Get updated user data
    const [users] = await mysqlConnection.execute(
      `SELECT id, first_name, last_name, email, plan_status, current_plan_id, 
              plan_start_date, plan_end_date, plan_permissions, max_sub_users, active_sub_users_count
       FROM users WHERE id = ?`,
      [userId]
    );

    const user = users.length > 0 ? users[0] : null;

    // Parse permissions if available
    if (user && user.plan_permissions) {
      try {
        user.plan_permissions = JSON.parse(user.plan_permissions);
      } catch (e) {
        user.plan_permissions = null;
      }
    }

    successResponse(res, {
      subscription: {
        stripeSubscriptionId: canceled.id,
        status: canceled.status,
        cancelAtPeriodEnd: canceled.cancel_at_period_end,
        canceledAt: new Date().toISOString()
      },
      user: user ? {
        id: user.id,
        name: `${user.first_name} ${user.last_name}`,
        email: user.email,
        planStatus: user.plan_status,
        currentPlanId: user.current_plan_id,
        planStartDate: user.plan_start_date,
        planEndDate: user.plan_end_date,
        maxSubUsers: user.max_sub_users,
        activeSubUsersCount: user.active_sub_users_count,
        permissions: user.plan_permissions
      } : null,
      subUsersDeactivated: deactivatedSubUsers,
      message: `Subscription will be canceled at the end of the billing period. Your plan permissions have been revoked.${deactivatedSubUsers > 0 ? ` ${deactivatedSubUsers} sub-user(s) have been deactivated.` : ''}`
    }, 'Subscription canceled successfully');
  } catch (error) {
    console.error('❌ Subscription cancellation error:', error.message);
    errorResponse(res, 'Failed to cancel subscription', 500);
  }
});

// ============================================
// ADMIN: PLAN FEATURE MANAGEMENT
// ============================================

// @route   POST /api/payments/admin/:planId/features/add
// @desc    Add feature to plan (Admin only)
// @access  Private (Admin)
router.post('/admin/:planId(\\d+)/features/add', [
  auth,
  isAdmin,
  body('feature_id')
    .isInt()
    .withMessage('Valid feature ID is required'),
  body('permission_type_id')
    .isInt()
    .withMessage('Valid permission type ID is required'),
  body('custom_value')
    .optional()
    .trim()
], validate, async (req, res) => {
  console.log("This is a test log before adding feature to plan");
  try {
    const { planId } = req.params;
    const { feature_id, permission_type_id, custom_value } = req.body;
    const mysqlConnection = getMySQLConnection();

    // Check if plan exists
    const [plans] = await mysqlConnection.execute(
      'SELECT id, name FROM plans WHERE id = ?',
      [planId]
    );

    if (plans.length === 0) {
      return errorResponse(res, 'Plan not found', 404);
    }

    // Check if feature exists
    const [features] = await mysqlConnection.execute(
      'SELECT id, name FROM features WHERE id = ? AND is_active = TRUE',
      [feature_id]
    );

    if (features.length === 0) {
      return errorResponse(res, 'Feature not found', 404);
    }

    // Check if permission type exists
    const [permissionTypes] = await mysqlConnection.execute(
      'SELECT id, name FROM permission_types WHERE id = ?',
      [permission_type_id]
    );

    if (permissionTypes.length === 0) {
      return errorResponse(res, 'Permission type not found', 404);
    }

    // Check if feature already added to plan
    const [existing] = await mysqlConnection.execute(
      'SELECT id FROM plan_features WHERE plan_id = ? AND feature_id = ?',
      [planId, feature_id]
    );

    if (existing.length > 0) {
      return errorResponse(res, 'Feature already added to this plan', 400);
    }

    // Add feature to plan
    const [result] = await mysqlConnection.execute(`
      INSERT INTO plan_features (plan_id, feature_id, permission_type_id, custom_value)
      VALUES (?, ?, ?, ?)
    `, [planId, feature_id, permission_type_id, custom_value || null]);

    // ⭐ REGENERATE PERMISSIONS for existing users with this plan
    console.log(`🔄 Regenerating permissions for plan ${planId} users after feature addition...`);
    const regenerationResult = await regeneratePermissionsForPlanUsers(planId, mysqlConnection);

    // Fetch the created plan feature with details
    const [newPlanFeature] = await mysqlConnection.execute(`
      SELECT 
        pf.id,
        pf.plan_id,
        pf.feature_id,
        pf.permission_type_id,
        pf.custom_value,
        p.name as plan_name,
        f.name as feature_name,
        f.slug as feature_slug,
        f.category,
        pt.name as permission_name,
        pt.label as permission_label
      FROM plan_features pf
      INNER JOIN plans p ON pf.plan_id = p.id
      INNER JOIN features f ON pf.feature_id = f.id
      INNER JOIN permission_types pt ON pf.permission_type_id = pt.id
      WHERE pf.id = ?
    `, [result.insertId]);

    successResponse(res, {
      planFeature: newPlanFeature[0],
      usersUpdated: regenerationResult.updated,
      message: `Feature added to plan successfully. ${regenerationResult.updated} users' permissions updated.`
    }, 'Feature added to plan successfully', 201);

  } catch (error) {
    console.error('❌ Add feature to plan error:', error);
    errorResponse(res, 'Failed to add feature to plan', 500);
  }
});

// @route   PUT /api/payments/admin/:planId/features/:featureId/update
// @desc    Update plan feature permissions (Admin only)
// @access  Private (Admin)
router.put('/admin/:planId(\\d+)/features/:featureId(\\d+)/update', [
  auth,
  isAdmin,
  body('permission_type_id')
    .optional()
    .isInt()
    .withMessage('Valid permission type ID is required'),
  body('custom_value')
    .optional()
    .trim()
], validate, async (req, res) => {
  try {
    const { planId, featureId } = req.params;
    const { permission_type_id, custom_value } = req.body;
    const mysqlConnection = getMySQLConnection();

    // Check if plan feature exists
    const [planFeatures] = await mysqlConnection.execute(
      'SELECT id FROM plan_features WHERE plan_id = ? AND feature_id = ?',
      [planId, featureId]
    );

    if (planFeatures.length === 0) {
      return errorResponse(res, 'Feature not found in this plan', 404);
    }

    // Build dynamic update
    const updates = [];
    const values = [];

    if (permission_type_id !== undefined) {
      // Verify permission type exists
      const [permTypes] = await mysqlConnection.execute(
        'SELECT id FROM permission_types WHERE id = ?',
        [permission_type_id]
      );

      if (permTypes.length === 0) {
        return errorResponse(res, 'Permission type not found', 404);
      }

      updates.push('permission_type_id = ?');
      values.push(permission_type_id);
    }

    if (custom_value !== undefined) {
      updates.push('custom_value = ?');
      values.push(custom_value || null);
    }

    if (updates.length === 0) {
      return errorResponse(res, 'No fields to update', 400);
    }

    updates.push('updated_at = NOW()');
    values.push(planId, featureId);

    // Update
    await mysqlConnection.execute(
      `UPDATE plan_features SET ${updates.join(', ')} WHERE plan_id = ? AND feature_id = ?`,
      values
    );

    // ⭐ REGENERATE PERMISSIONS for existing users with this plan
    console.log(`🔄 Regenerating permissions for plan ${planId} users after feature update...`);
    const regenerationResult = await regeneratePermissionsForPlanUsers(planId, mysqlConnection);

    // Fetch updated plan feature
    const [updatedPlanFeature] = await mysqlConnection.execute(`
      SELECT 
        pf.id,
        pf.plan_id,
        pf.feature_id,
        pf.permission_type_id,
        pf.custom_value,
        p.name as plan_name,
        f.name as feature_name,
        pt.name as permission_name,
        pt.label as permission_label
      FROM plan_features pf
      INNER JOIN plans p ON pf.plan_id = p.id
      INNER JOIN features f ON pf.feature_id = f.id
      INNER JOIN permission_types pt ON pf.permission_type_id = pt.id
      WHERE pf.plan_id = ? AND pf.feature_id = ?
    `, [planId, featureId]);

    successResponse(res, {
      planFeature: updatedPlanFeature[0],
      usersUpdated: regenerationResult.updated,
      message: `Plan feature updated successfully. ${regenerationResult.updated} users' permissions updated.`
    }, 'Plan feature updated successfully');

  } catch (error) {
    console.error('❌ Update plan feature error:', error);
    errorResponse(res, 'Failed to update plan feature', 500);
  }
});

// @route   DELETE /api/payments/admin/:planId/features/:featureId/remove
// @desc    Remove feature from plan (Admin only)
// @access  Private (Admin)
router.delete('/admin/:planId(\\d+)/features/:featureId(\\d+)/remove', [auth, isAdmin], async (req, res) => {
  try {
    const { planId, featureId } = req.params;
    const mysqlConnection = getMySQLConnection();

    // Check if plan feature exists
    const [planFeature] = await mysqlConnection.execute(
      `SELECT pf.id, f.name as feature_name, p.name as plan_name
       FROM plan_features pf
       INNER JOIN features f ON pf.feature_id = f.id
       INNER JOIN plans p ON pf.plan_id = p.id
       WHERE pf.plan_id = ? AND pf.feature_id = ?`,
      [planId, featureId]
    );

    if (planFeature.length === 0) {
      return errorResponse(res, 'Feature not found in this plan', 404);
    }

    // Remove feature from plan
    await mysqlConnection.execute(
      'DELETE FROM plan_features WHERE plan_id = ? AND feature_id = ?',
      [planId, featureId]
    );

    // ⭐ REGENERATE PERMISSIONS for existing users with this plan
    console.log(`🔄 Regenerating permissions for plan ${planId} users after feature removal...`);
    const regenerationResult = await regeneratePermissionsForPlanUsers(planId, mysqlConnection);

    successResponse(res, {
      removedFeature: {
        planId: parseInt(planId),
        featureId: parseInt(featureId),
        featureName: planFeature[0].feature_name,
        planName: planFeature[0].plan_name
      },
      usersUpdated: regenerationResult.updated,
      message: `Feature removed from plan successfully. ${regenerationResult.updated} users' permissions updated.`
    }, 'Feature removed from plan successfully');

  } catch (error) {
    console.error('❌ Remove feature from plan error:', error);
    errorResponse(res, 'Failed to remove feature from plan', 500);
  }
});

// @route   POST /api/payments/admin/:planId/regenerate-permissions
// @desc    Manually regenerate permissions for all users with a specific plan (Admin only)
// @access  Private (Admin)
router.post('/admin/:planId(\\d+)/regenerate-permissions', [auth, isAdmin], async (req, res) => {
  try {
    const { planId } = req.params;
    const mysqlConnection = getMySQLConnection();

    // Check if plan exists
    const [plans] = await mysqlConnection.execute(
      'SELECT id, name FROM plans WHERE id = ?',
      [planId]
    );

    if (plans.length === 0) {
      return errorResponse(res, 'Plan not found', 404);
    }

    // Regenerate permissions for all users with this plan
    const regenerationResult = await regeneratePermissionsForPlanUsers(planId, mysqlConnection);

    successResponse(res, {
      planId: parseInt(planId),
      planName: plans[0].name,
      usersUpdated: regenerationResult.updated,
      totalUsersFound: regenerationResult.users.length
    }, `Permissions regenerated successfully for ${regenerationResult.updated} users`);

  } catch (error) {
    console.error('❌ Manual permission regeneration error:', error);
    errorResponse(res, 'Failed to regenerate permissions', 500);
  }
});

// ============================================
// USER PAYMENT METHODS
// ============================================

// @route   GET /api/payments/payment-methods
// @desc    Get current user's payment methods from user_payment_methods table
// @access  Private
router.get('/payment-methods', auth, async (req, res) => {
  try {
    const mysql = getMySQLConnection();

    const [rows] = await mysql.execute(
      `SELECT * FROM user_payment_methods
     WHERE user_id = ? AND deleted_at IS NULL`,
      [req.user.id]
    );

    successResponse(res, rows, "Payment methods fetched", 200);
  } catch (err) {
    console.log(err)
    errorResponse(res, err.message, 500);
  }
});

module.exports = router;