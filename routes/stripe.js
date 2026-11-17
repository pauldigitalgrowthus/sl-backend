const express = require('express');
const { body } = require('express-validator');
const { auth } = require('../middleware/auth');
const { validate } = require('../middleware/validation');
const { successResponse, errorResponse } = require('../utils/response');
const { 
  createStripeCustomer, 
  createCheckoutSession, 
  handleWebhookEvent,
  STRIPE_PUBLISHABLE_KEY
} = require('../config/stripe');
const { getMySQLConnection } = require('../config/mysql');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const router = express.Router();

// Helper function to get or create Stripe price (copied from payment.js)
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
        console.log('⚠️ Existing price is invalid, creating new one');
        await mysqlConnection.execute(
          'DELETE FROM stripe_prices WHERE plan_id = ?',
          [plan.id]
        );
      }
    }

    // Create or fetch product
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
        const product = await stripe.products.create({
          name: plan.name,
          description: plan.description || `${plan.name} Subscription Plan`,
          metadata: { plan_id: plan.id.toString() }
        });
        productId = product.id;
        await mysqlConnection.execute(
          'UPDATE stripe_products SET stripe_product_id = ?, updated_at = NOW() WHERE plan_id = ?',
          [productId, plan.id]
        );
      }
    } else {
      const product = await stripe.products.create({
        name: plan.name,
        description: plan.description || `${plan.name} Subscription Plan`,
        metadata: { plan_id: plan.id.toString() }
      });
      productId = product.id;
      await mysqlConnection.execute(
        'INSERT INTO stripe_products (plan_id, stripe_product_id, name) VALUES (?, ?, ?)',
        [plan.id, productId, plan.name]
      );
    }

    // Create new price
    // Handle billing cycle - only create recurring price for monthly/yearly
    const billingCycle = plan.billing_cycle || 'one-time';
    const recurring = billingCycle === 'yearly' ? 'year' : billingCycle === 'monthly' ? 'month' : null;
    
    const priceData = {
      product: productId,
      unit_amount: Math.round(parseFloat(plan.price) * 100),
      currency: 'usd',
      metadata: {
        plan_id: plan.id.toString()
      }
    };
    
    // Only add recurring if it's a subscription plan
    if (recurring) {
      priceData.recurring = {
        interval: recurring
      };
    }
    
    const price = await stripe.prices.create(priceData);

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
    throw new Error(`Failed to create Stripe price: ${error.message}`);
  }
}

// @route   GET /api/stripe/publishable-key
// @desc    Get Stripe publishable key for frontend
// @access  Public
router.get('/publishable-key', async (req, res) => {
  try {
    successResponse(res, {
      key: STRIPE_PUBLISHABLE_KEY
    }, 'Publishable key retrieved successfully');
  } catch (error) {
    console.error('Get publishable key error:', error);
    errorResponse(res, 'Failed to get publishable key', 500);
  }
});

// @route   POST /api/stripe/create-checkout-session
// @desc    Create Stripe checkout session for subscription
// @access  Private
router.post('/create-checkout-session', [
  auth,
  body('subscriptionId')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Valid subscription ID is required'),
  body('planId')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Valid plan ID is required'),
  body('successUrl')
    .isURL({ require_tld: false, require_protocol: true })
    .withMessage('Valid success URL is required'),
  body('cancelUrl')
    .isURL({ require_tld: false, require_protocol: true })
    .withMessage('Valid cancel URL is required')
], validate, async (req, res) => {
  try {
    const { subscriptionId, planId, successUrl, cancelUrl } = req.body;
    
    // Support both subscriptionId and planId (planId takes precedence if both provided)
    const finalSubscriptionId = planId || subscriptionId;
    
    if (!finalSubscriptionId) {
      return errorResponse(res, 'Either subscriptionId or planId is required', 400);
    }
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Check if user already has an active subscription
    const [existingSubscriptions] = await mysqlConnection.execute(
      'SELECT * FROM user_subscriptions WHERE user_id = ? AND status = "active" AND end_date > NOW()',
      [userId]
    );

    if (existingSubscriptions.length > 0) {
      return errorResponse(res, 'User already has an active subscription', 400);
    }

    // Get subscription details (try subscriptions_new first, then plans table)
    let subscriptions = [];
    if (planId) {
      // If planId is provided, use plans table
      const [planRows] = await mysqlConnection.execute(
        'SELECT * FROM plans WHERE id = ? AND is_active = TRUE',
        [planId]
      );
      if (planRows.length > 0) {
        // Convert plan to subscription format for compatibility
        subscriptions = [{
          id: planRows[0].id,
          name: planRows[0].name,
          price: planRows[0].price,
          billing_cycle: planRows[0].billing_cycle,
          description: planRows[0].description,
          duration_days: planRows[0].billing_cycle === 'yearly' ? 365 : planRows[0].billing_cycle === 'monthly' ? 30 : null
        }];
      }
    } else {
      // Use subscriptions_new table
      const [subRows] = await mysqlConnection.execute(
        'SELECT * FROM subscriptions_new WHERE id = ? AND is_active = TRUE',
        [finalSubscriptionId]
      );
      subscriptions = subRows;
    }

    if (subscriptions.length === 0) {
      return errorResponse(res, 'Invalid subscription selected', 400);
    }

    const subscription = subscriptions[0];

    // Create or get Stripe customer
    let stripeCustomerId = null;
    
    // Try payment_customers table first (used by payments endpoint)
    const [paymentCustomers] = await mysqlConnection.execute(
      'SELECT stripe_customer_id FROM payment_customers WHERE user_id = ?',
      [userId]
    );
    
    if (paymentCustomers.length > 0 && paymentCustomers[0].stripe_customer_id) {
      stripeCustomerId = paymentCustomers[0].stripe_customer_id;
      try {
        await stripe.customers.retrieve(stripeCustomerId);
        console.log('✅ Existing customer is valid:', stripeCustomerId);
      } catch (error) {
        // Customer invalid, create new one
        stripeCustomerId = null;
      }
    }
    
    // Fallback to user_subscriptions table
    if (!stripeCustomerId) {
      const [userSubscriptions] = await mysqlConnection.execute(
        'SELECT stripe_customer_id FROM user_subscriptions WHERE user_id = ? AND stripe_customer_id IS NOT NULL LIMIT 1',
        [userId]
      );
      if (userSubscriptions.length > 0) {
        stripeCustomerId = userSubscriptions[0].stripe_customer_id;
      }
    }
    
    // Create new customer if none exists
    if (!stripeCustomerId) {
      const customer = await createStripeCustomer({
        id: userId,
        email: req.user.email,
        firstName: req.user.first_name,
        lastName: req.user.last_name,
        phone: req.user.phone,
        role: req.user.role
      });
      stripeCustomerId = customer.id;
      
      // Save to payment_customers table
      await mysqlConnection.execute(
        `INSERT INTO payment_customers (user_id, stripe_customer_id, email, name)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE 
          stripe_customer_id = ?,
          email = ?,
          name = ?,
          updated_at = NOW()`,
        [
          userId, customer.id, req.user.email, `${req.user.first_name} ${req.user.last_name}`.trim(),
          customer.id, req.user.email, `${req.user.first_name} ${req.user.last_name}`.trim()
        ]
      );
    }

    // Create checkout session
    let session;
    
    if (planId) {
      // If planId is provided, use dynamic Stripe price creation (like payments endpoint)
      const plan = subscription;
      
      // Determine mode based on billing cycle
      const billingCycle = plan.billing_cycle || 'one-time';
      let mode = 'payment';
      let lineItems;
      
      if (billingCycle === 'monthly' || billingCycle === 'yearly') {
        mode = 'subscription';
        // Get or create Stripe price for this plan
        const priceId = await getOrCreateStripePrice(plan, mysqlConnection);
        lineItems = [{
          price: priceId,
          quantity: 1
        }];
      } else {
        // One-time payment - use price_data directly
        lineItems = [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: plan.name,
              description: plan.description || `${plan.name} Plan`
            },
            unit_amount: Math.round(parseFloat(plan.price) * 100)
          },
          quantity: 1
        }];
      }
      
      // Create checkout session directly
      session = await stripe.checkout.sessions.create({
        customer: stripeCustomerId,
        payment_method_types: ['card', 'us_bank_account'],
        mode: mode,
        line_items: lineItems,
        success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: cancelUrl,
        metadata: {
          user_id: userId.toString(),
          plan_id: planId.toString(),
          plan_name: plan.name,
          billing_cycle: plan.billing_cycle || 'one-time'
        },
        allow_promotion_codes: true,
        billing_address_collection: 'auto',
        payment_method_collection: 'always'
      });
    } else {
      // Use old method for subscriptionId (hardcoded plans)
      session = await createCheckoutSession(
        userId,
        finalSubscriptionId,
        successUrl,
        cancelUrl
      );
    }

    successResponse(res, {
      sessionId: session.id,
      sessionUrl: session.url,
      url: session.url, // Also include 'url' for compatibility
      customerId: stripeCustomerId
    }, 'Checkout session created successfully');

  } catch (error) {
    console.error('Create checkout session error:', error);
    console.error('Error stack:', error.stack);
    const errorMessage = error.message || 'Failed to create checkout session';
    errorResponse(res, errorMessage, 500);
  }
});

// @route   POST /api/stripe/webhook
// @desc    Handle Stripe webhook events
// @access  Public
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_default_secret';

  let event;

  try {
    event = require('stripe').webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    await handleWebhookEvent(event);
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook handling error:', error);
    res.status(500).json({ error: 'Webhook handling failed' });
  }
});

// @route   POST /api/stripe/cancel-subscription
// @desc    Cancel user's active subscription
// @access  Private
router.post('/cancel-subscription', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Get active subscription
    const [userSubscriptions] = await mysqlConnection.execute(
      `SELECT us.*, s.name as subscription_name 
       FROM user_subscriptions us 
       JOIN subscriptions_new s ON us.subscription_id = s.id 
       WHERE us.user_id = ? AND us.status = "active" AND us.end_date > NOW()`,
      [userId]
    );

    if (userSubscriptions.length === 0) {
      return errorResponse(res, 'No active subscription found', 404);
    }

    const userSubscription = userSubscriptions[0];

    if (userSubscription.stripe_subscription_id) {
      // Cancel Stripe subscription
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      await stripe.subscriptions.update(userSubscription.stripe_subscription_id, {
        cancel_at_period_end: true
      });
    }

    // Update local subscription status
    await mysqlConnection.execute(
      'UPDATE user_subscriptions SET status = "cancelled", updated_at = NOW() WHERE id = ?',
      [userSubscription.id]
    );

    successResponse(res, {
      subscription: userSubscription.subscription_name,
      cancelledAt: new Date()
    }, 'Subscription cancelled successfully');

  } catch (error) {
    console.error('Cancel subscription error:', error);
    errorResponse(res, 'Failed to cancel subscription', 500);
  }
});

// @route   GET /api/stripe/payment-methods
// @desc    Get user's saved payment methods
// @access  Private
router.get('/payment-methods', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Get user's Stripe customer ID
    const [userSubscriptions] = await mysqlConnection.execute(
      'SELECT stripe_customer_id FROM user_subscriptions WHERE user_id = ? AND stripe_customer_id IS NOT NULL LIMIT 1',
      [userId]
    );

    if (userSubscriptions.length === 0) {
      return successResponse(res, { paymentMethods: [] }, 'No payment methods found');
    }

    const stripeCustomerId = userSubscriptions[0].stripe_customer_id;
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

    // Get payment methods from Stripe
    const paymentMethods = await stripe.paymentMethods.list({
      customer: stripeCustomerId,
      type: 'card'
    });

    successResponse(res, {
      paymentMethods: paymentMethods.data.map(pm => ({
        id: pm.id,
        type: pm.type,
        card: {
          brand: pm.card.brand,
          last4: pm.card.last4,
          expMonth: pm.card.exp_month,
          expYear: pm.card.exp_year
        }
      }))
    }, 'Payment methods retrieved successfully');

  } catch (error) {
    console.error('Get payment methods error:', error);
    errorResponse(res, 'Failed to get payment methods', 500);
  }
});

module.exports = router;
