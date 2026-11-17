const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');

// Stripe publishable key for frontend
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';

// Stripe configuration
const stripeConfig = {
  // Subscription plans mapping to Stripe product IDs
  subscriptionPlans: {
    1: { // Basic Composer
      stripeProductId: 'prod_basic_composer',
      stripePriceId: 'price_basic_composer_monthly'
    },
    2: { // Document Manager
      stripeProductId: 'prod_document_manager', 
      stripePriceId: 'price_document_manager_monthly'
    },
    3: { // Music Educator
      stripeProductId: 'prod_music_educator',
      stripePriceId: 'price_music_educator_monthly'
    },
    4: { // Premium Composer
      stripeProductId: 'prod_premium_composer',
      stripePriceId: 'price_premium_composer_monthly'
    },
    5: { // Event Planner
      stripeProductId: 'prod_event_planner',
      stripePriceId: 'price_event_planner_monthly'
    },
    6: { // Music Professional
      stripeProductId: 'prod_music_professional',
      stripePriceId: 'price_music_professional_monthly'
    }
  }
};

// Create Stripe customer
const createStripeCustomer = async (userData) => {
  try {
    const customer = await stripe.customers.create({
      email: userData.email,
      name: `${userData.firstName} ${userData.lastName}`,
      phone: userData.phone,
      metadata: {
        userId: userData.id,
        role: userData.role
      }
    });
    return customer;
  } catch (error) {
    console.error('Error creating Stripe customer:', error);
    throw error;
  }
};

// Create subscription checkout session
const createCheckoutSession = async (userId, subscriptionId, successUrl, cancelUrl) => {
  try {
    const plan = stripeConfig.subscriptionPlans[subscriptionId];
    if (!plan) {
      throw new Error('Invalid subscription plan');
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: plan.stripePriceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        userId: userId,
        subscriptionId: subscriptionId
      }
    });

    return session;
  } catch (error) {
    console.error('Error creating checkout session:', error);
    throw error;
  }
};

// Handle webhook events
const handleWebhookEvent = async (event) => {
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;
      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object);
        break;
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionCancelled(event.data.object);
        break;
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }
  } catch (error) {
    console.error('Error handling webhook event:', error);
    throw error;
  }
};

// Handle checkout completion
const handleCheckoutCompleted = async (session) => {
  const { getMySQLConnection } = require('./mysql');
  const mysqlConnection = getMySQLConnection();
  
  try {
    const { userId, subscriptionId } = session.metadata;
    
    // Get subscription details
    const [subscriptions] = await mysqlConnection.execute(
      'SELECT * FROM subscriptions_new WHERE id = ?',
      [subscriptionId]
    );
    
    if (subscriptions.length === 0) {
      throw new Error('Subscription not found');
    }
    
    const subscription = subscriptions[0];
    
    // Calculate end date
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + subscription.duration_days);
    
    // Create user subscription
    await mysqlConnection.execute(
      `INSERT INTO user_subscriptions 
       (user_id, subscription_id, end_date, payment_status, payment_method, amount_paid, stripe_subscription_id) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        userId, 
        subscriptionId, 
        endDate.toISOString().slice(0, 19).replace('T', ' '), 
        'completed',
        'stripe',
        subscription.price,
        session.subscription
      ]
    );
    
    // Update user role
    await mysqlConnection.execute(
      'UPDATE users SET role = ? WHERE id = ?',
      [subscription.role, userId]
    );
    
    console.log(`Subscription activated for user ${userId}`);
  } catch (error) {
    console.error('Error handling checkout completion:', error);
    throw error;
  }
};

// Handle payment success
const handlePaymentSucceeded = async (invoice) => {
  // Update subscription status
  console.log(`Payment succeeded for subscription: ${invoice.subscription}`);
};

// Handle payment failure
const handlePaymentFailed = async (invoice) => {
  // Handle failed payment
  console.log(`Payment failed for subscription: ${invoice.subscription}`);
};

// Handle subscription cancellation
const handleSubscriptionCancelled = async (subscription) => {
  const { getMySQLConnection } = require('./mysql');
  const mysqlConnection = getMySQLConnection();
  
  try {
    // Update subscription status to cancelled
    await mysqlConnection.execute(
      'UPDATE user_subscriptions SET status = "cancelled" WHERE stripe_subscription_id = ?',
      [subscription.id]
    );
    
    console.log(`Subscription cancelled: ${subscription.id}`);
  } catch (error) {
    console.error('Error handling subscription cancellation:', error);
    throw error;
  }
};

module.exports = {
  stripe,
  stripeConfig,
  STRIPE_PUBLISHABLE_KEY,
  createStripeCustomer,
  createCheckoutSession,
  handleWebhookEvent
};
