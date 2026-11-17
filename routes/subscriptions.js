const express = require('express');
const { getMySQLConnection } = require('../config/mysql');
const { auth, requireAnyRole } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');
const { sendEmail } = require("../utils/SendMailer");
const { createAndDeliverNotification } = require("../utils/notificationUtils");
const { subscriptionCreatedTemplate, subscriptionCancelledTemplate, subscriptionExpiredTemplate } = require('../utils/subscriptionsEmailtemplate');


const router = express.Router();
function subscriptionCancelledTemplateUSer({
  firstName = 'User',
  planName = 'Paid Plan',
  cancellationEffectiveDate = new Date(),
  manageSubscriptionLink = `${process.env.FRONTEND_URL}/subscription`,
  supportEmail = process.env.SUPPORT_MAIL
}) {

  const formatDate = (d) =>
    new Date(d).toLocaleDateString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
      timeZone: 'UTC'
    });

  const subject = 'Subscription Cancellation Confirmation';

  const html = `
  <div style="font-family: Arial, Helvetica, sans-serif; font-size:14px; line-height:1.6; color:#222;">
    
    <p>Hi ${firstName},</p>

    <p>
      We’ve processed your request to cancel your Simply Liturgical subscription
      (<strong>${planName}</strong>).
    </p>

    <ul>
      <li>
        <strong>Cancellation effective date:</strong>
        ${formatDate(cancellationEffectiveDate)}
      </li>

      <li>
        <strong>Manage or restart your plan anytime:</strong>
        <a href="${manageSubscriptionLink}">
          ${manageSubscriptionLink}
        </a>
      </li>
    </ul>

    <p>
      If you canceled by mistake or need help selecting a better plan,
      contact <a href="mailto:${supportEmail}">${supportEmail}</a>.
    </p>

    <p>
      God bless,<br/>
      — Simply Liturgical Team
    </p>

  </div>
  `;

  const text = `
Hi ${firstName},

We’ve processed your request to cancel your Simply Liturgical subscription (${planName}).

- Cancellation effective date: ${formatDate(cancellationEffectiveDate)}
- Manage or restart your plan anytime: ${manageSubscriptionLink}

If you canceled by mistake or need help selecting a better plan, contact ${supportEmail}.

God bless,
— Simply Liturgical Team
  `.trim();

  return { subject, html, text };
}
async function applyFreePlanPermissionsToUser(mysqlConnection, userId) {
  console.log(`🔄 Applying FREE plan permissions to user ${userId}`);

  /* ----------------------------------
     1. Get FREE plan
  ---------------------------------- */
  const [[freePlan]] = await mysqlConnection.execute(
    `SELECT id FROM plans WHERE slug = 'free-account' LIMIT 1`
  );
  if (!freePlan) throw new Error('Free plan not found');

  /* ----------------------------------
     2. Get FREE plan features
  ---------------------------------- */
  const [features] = await mysqlConnection.execute(
    `SELECT
        f.name,
        f.category,
        pt.name AS permission_type,
        pf.custom_value
     FROM plan_features pf
     JOIN features f ON pf.feature_id = f.id
     JOIN permission_types pt ON pf.permission_type_id = pt.id
     WHERE pf.plan_id = ? AND f.is_active = TRUE`,
    [freePlan.id]
  );

  /* ----------------------------------
     3. Build permissions JSON
  ---------------------------------- */
  const permissions = {};

  for (const f of features) {
    if (!permissions[f.category]) {
      permissions[f.category] = {};
    }

    if (f.permission_type === 'custom' && f.custom_value !== null) {
      permissions[f.category][f.name] = {
        type: 'custom',
        limit: Number(f.custom_value),
        used: 0
      };
    } else {
      permissions[f.category][f.name] = f.permission_type;
    }
  }

  /* ----------------------------------
     4. Update user
  ---------------------------------- */
  await mysqlConnection.execute(
    `UPDATE users
     SET
       plan_status = 'expired',
       role = 'free_user',
       plan_permissions = ?,
       updated_at = NOW()
     WHERE id = ?`,
    [JSON.stringify(permissions), userId]
  );

  console.log('✅ Free plan permissions applied');
  return permissions;
}

// @route   GET /api/subscriptions/plans
// @desc    Get all active plans with their features and permissions
// @access  Public
router.get('/plans', async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    // Get all active plans
    const [plans] = await mysqlConnection.execute(
      `SELECT id, name, slug, description, price, billing_cycle, is_active, 
       created_at, updated_at FROM plans WHERE is_active = TRUE ORDER BY price ASC`
    );

    // For each plan, get its features and permissions
    const plansWithDetails = await Promise.all(
      plans.map(async (plan) => {
        // Get plan features with permission details
        const [planFeatures] = await mysqlConnection.execute(
          `SELECT 
            f.id as feature_id,
            f.name as feature_name,
            f.slug as feature_slug,
            f.category,
            f.display_order,
            pt.name as permission_type,
            pt.label as permission_label,
            pf.custom_value
          FROM plan_features pf
          JOIN features f ON pf.feature_id = f.id
          JOIN permission_types pt ON pf.permission_type_id = pt.id
          WHERE pf.plan_id = ? AND f.is_active = TRUE
          ORDER BY f.category, f.display_order`,
          [plan.id]
        );

        // Group features by category
        const featuresByCategory = {};
        planFeatures.forEach(feature => {
          if (!featuresByCategory[feature.category]) {
            featuresByCategory[feature.category] = [];
          }
          featuresByCategory[feature.category].push({
            id: feature.feature_id,
            name: feature.feature_name,
            slug: feature.feature_slug,
            permission: feature.permission_type,
            permissionLabel: feature.permission_label,
            customValue: feature.custom_value
          });
        });

        return {
          ...plan,
          features: featuresByCategory,
          totalFeatures: planFeatures.length
        };
      })
    );

    successResponse(res, {
      plans: plansWithDetails,
      total: plansWithDetails.length
    }, 'Plans retrieved successfully');

  } catch (error) {
    console.error('Get plans error:', error);
    errorResponse(res, 'Failed to get plans', 500);
  }
});

// @route   GET /api/subscriptions/plans/:planId
// @desc    Get single plan details with features
// @access  Public
router.get('/plans/:planId', async (req, res) => {
  try {
    const { planId } = req.params;
    const mysqlConnection = getMySQLConnection();

    // Get plan details
    const [plans] = await mysqlConnection.execute(
      `SELECT id, name, slug, description, price, billing_cycle, is_active, 
       created_at, updated_at FROM plans WHERE id = ? AND is_active = TRUE`,
      [planId]
    );

    if (plans.length === 0) {
      return errorResponse(res, 'Plan not found', 404);
    }

    const plan = plans[0];

    // Get plan features
    const [planFeatures] = await mysqlConnection.execute(
      `SELECT 
        f.id as feature_id,
        f.name as feature_name,
        f.slug as feature_slug,
        f.category,
        f.description,
        f.display_order,
        pt.name as permission_type,
        pt.label as permission_label,
        pt.description as permission_description,
        pf.custom_value
      FROM plan_features pf
      JOIN features f ON pf.feature_id = f.id
      JOIN permission_types pt ON pf.permission_type_id = pt.id
      WHERE pf.plan_id = ? AND f.is_active = TRUE
      ORDER BY f.category, f.display_order`,
      [planId]
    );

    // Group features by category
    const featuresByCategory = {};
    planFeatures.forEach(feature => {
      if (!featuresByCategory[feature.category]) {
        featuresByCategory[feature.category] = [];
      }
      featuresByCategory[feature.category].push({
        id: feature.feature_id,
        name: feature.feature_name,
        slug: feature.feature_slug,
        description: feature.description,
        permission: feature.permission_type,
        permissionLabel: feature.permission_label,
        permissionDescription: feature.permission_description,
        customValue: feature.custom_value
      });
    });

    successResponse(res, {
      plan: {
        ...plan,
        features: featuresByCategory,
        totalFeatures: planFeatures.length
      }
    }, 'Plan details retrieved successfully');

  } catch (error) {
    console.error('Get plan details error:', error);
    errorResponse(res, 'Failed to get plan details', 500);
  }
});

// @route   POST /api/subscriptions/subscribe
// @desc    Subscribe user to a plan
// @access  Private
router.post('/subscribe', auth, async (req, res) => {
  try {
    const { planId } = req.body;
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    if (!planId) {
      return errorResponse(res, 'Plan ID is required', 400);
    }

    // Get plan details
    const [plans] = await mysqlConnection.execute(
      `SELECT id, name, slug, description, price, billing_cycle, is_active 
       FROM plans WHERE id = ? AND is_active = TRUE`,
      [planId]
    );

    if (plans.length === 0) {
      return errorResponse(res, 'Plan not found or inactive', 404);
    }

    const plan = plans[0];

    // Check if user already has an active subscription
    const [currentUser] = await mysqlConnection.execute(
      `SELECT id, email, role, current_plan_id, plan_status, plan_end_date 
       FROM users WHERE id = ?`,
      [userId]
    );

    if (currentUser.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    const user = currentUser[0];

    // If user has an active plan, handle it
    if (user.current_plan_id && user.plan_status === 'active') {
      return errorResponse(res, 'You already have an active subscription. Please cancel it first or wait for it to expire.', 400);
    }

    // Calculate plan start and end dates
    const planStartDate = new Date();
    let planEndDate = new Date();

    // Set plan duration based on billing cycle
    switch (plan.billing_cycle) {
      case 'monthly':
        planEndDate.setMonth(planEndDate.getMonth() + 1);
        break;
      case 'yearly':
        planEndDate.setFullYear(planEndDate.getFullYear() + 1);
        break;
      case 'one-time':
        planEndDate.setFullYear(planEndDate.getFullYear() + 100); // Lifetime access
        break;
      case 'free':
        planEndDate.setFullYear(planEndDate.getFullYear() + 100); // Permanent free access
        break;
      default:
        planEndDate.setMonth(planEndDate.getMonth() + 1); // Default to 1 month
    }

    // Get all plan features and permissions
    const [planFeatures] = await mysqlConnection.execute(
      `SELECT 
        f.id as feature_id,
        f.slug as feature_slug,
        pt.name as permission_type,
        pf.custom_value
      FROM plan_features pf
      JOIN features f ON pf.feature_id = f.id
      JOIN permission_types pt ON pf.permission_type_id = pt.id
      WHERE pf.plan_id = ? AND f.is_active = TRUE`,
      [planId]
    );

    // Build permissions object
    const planPermissions = {};
    planFeatures.forEach(feature => {
      planPermissions[feature.feature_slug] = {
        type: feature.permission_type,
        customValue: feature.custom_value || null
      };
    });

    // Update user with new plan
    await mysqlConnection.execute(
      `UPDATE users SET 
        current_plan_id = ?,
        plan_start_date = ?,
        plan_end_date = ?,
        plan_status = 'active',
        role = 'user',
        plan_permissions = ?,
        has_upgraded = TRUE,
        updated_at = NOW()
       WHERE id = ?`,
      [
        planId,
        planStartDate.toISOString().slice(0, 19).replace('T', ' '),
        planEndDate.toISOString().slice(0, 19).replace('T', ' '),
        JSON.stringify(planPermissions),
        userId
      ]
    );

    // Initialize feature usage tracking for limited features
    for (const feature of planFeatures) {
      if (feature.permission_type === '1-plan' || feature.custom_value) {
        await mysqlConnection.execute(
          `INSERT INTO feature_usage (user_id, feature_id, usage_count, reset_at)
           VALUES (?, ?, 0, ?)
           ON DUPLICATE KEY UPDATE reset_at = ?`,
          [
            userId,
            feature.feature_id,
            planEndDate.toISOString().slice(0, 19).replace('T', ' '),
            planEndDate.toISOString().slice(0, 19).replace('T', ' ')
          ]
        );
      }
    }

    // Get updated user data
    const [updatedUser] = await mysqlConnection.execute(
      `SELECT id, first_name, last_name, email, phone, role, user_type,
       current_plan_id, plan_start_date, plan_end_date, plan_status,
       plan_permissions, custom_permissions, max_sub_users, active_sub_users_count,
       bio, avatar, website_url, twitter_url, address, country, state_province,
       city, postal_code, language, timezone, badges, is_active, is_verified,
       free_trial_expires_at, has_upgraded, created_at, updated_at 
       FROM users WHERE id = ?`,
      [userId]
    );

    // Parse JSON fields
    const userResponse = {
      ...updatedUser[0],
      plan_permissions: updatedUser[0].plan_permissions ? JSON.parse(updatedUser[0].plan_permissions) : null,
      custom_permissions: updatedUser[0].custom_permissions ? JSON.parse(updatedUser[0].custom_permissions) : null,
      badges: updatedUser[0].badges ? JSON.parse(updatedUser[0].badges) : null
    };

    successResponse(res, {
      user: userResponse,
      plan: {
        id: plan.id,
        name: plan.name,
        slug: plan.slug,
        description: plan.description,
        price: plan.price,
        billing_cycle: plan.billing_cycle,
        startDate: planStartDate,
        endDate: planEndDate
      },
      permissions: planPermissions,
      message: `Successfully subscribed to ${plan.name} plan!`
    }, 'Subscription successful', 201);

  } catch (error) {
    console.error('Subscribe error:', error);
    errorResponse(res, 'Failed to subscribe to plan', 500);
  }
});

// @route   POST /api/subscriptions/cancel
// @desc    Cancel subscription & apply FREE plan permissions
// @access  Private
router.post('/cancel', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // ✅ Apply free plan + permissions immediately
    const permissions =
      await applyFreePlanPermissionsToUser(mysqlConnection, userId);

    const [[user]] = await mysqlConnection.execute(
      `SELECT first_name, email, current_plan_id 
         FROM users WHERE id = ?`,
      [userId]
    );
    const [[plan]] = await mysqlConnection.execute(`SELECT name FROM plans WHERE id = ?`, [user.current_plan_id]);

    /* ========= EMAIL ========= */

    const emailData = subscriptionCancelledTemplateUSer({
      userName: user.first_name,
      planName: plan ? plan.name : 'Paid Plan',
      cancelledAt: new Date()
    });

    await sendEmail({
      to: user.email,
      subject: emailData.subject,
      html: emailData.html,
      text: emailData.text
    });

    /* =========================
       2️⃣ SYSTEM NOTIFICATION (YOUR SYSTEM)
    ========================= */
    try {

      console.log(`🔔 Creating cancel notification for user ${userId}`);
      await createAndDeliverNotification(
        {
          title: 'Subscription Cancelled',
          body: 'Your subscription has been cancelled. Free plan is now active.',
          channel: 'inbox',
          metadata: {
            action: 'subscription_cancelled',
            plan: 'free-account'
          },
          target: {
            type: 'custom',
            user_ids: [userId]
          }
        },
        userId,
        mysqlConnection
      );

      console.log('🔔 Cancel notification created');
    } catch (notifErr) {
      console.warn('⚠️ Notification failed (non-blocking):', notifErr.message);
    }


    return successResponse(
      res,
      {
        userId,
        plan: 'free-account',
        plan_permissions: permissions
      },
      'Subscription cancelled. Free plan permissions applied.'
    );

  } catch (error) {
    console.error('❌ Cancel subscription error:', error);
    return errorResponse(res, 'Failed to cancel subscription', 500);
  }
});

// @route   POST /api/subscriptions/admin/cancel/:userId
// @desc    Cancel a specific user's active subscription (Admin Only)
// @access  Private (SL Team)
router.post(
  '/admin/cancel/:userId',
  auth,
  requireAnyRole(['sl_team']),
  async (req, res) => {
    try {
      const { userId } = req.params;
      const mysqlConnection = getMySQLConnection();

      /* -----------------------------------------
         1️⃣ Get active subscription
      ----------------------------------------- */
      const [[activeSub]] = await mysqlConnection.execute(
        `SELECT id, plan_id 
         FROM subscriptions 
         WHERE user_id = ? 
         AND status = 'active'
         ORDER BY id DESC
         LIMIT 1`,
        [userId]
      );

      if (!activeSub) {
        return errorResponse(res, 'No active subscription found', 400);
      }

      /* -----------------------------------------
         2️⃣ Update subscription table
      ----------------------------------------- */
      await mysqlConnection.execute(
        `UPDATE subscriptions
         SET 
           status = 'canceled',
           cancel_at_period_end = 0,
           canceled_at = NOW(),
           updated_at = NOW()
         WHERE id = ?`,
        [activeSub.id]
      );

      /* -----------------------------------------
         3️⃣ Apply free plan permissions
      ----------------------------------------- */
      const permissions =
        await applyFreePlanPermissionsToUser(mysqlConnection, userId);

      /* -----------------------------------------
         4️⃣ Notify user
      ----------------------------------------- */
      const [[user]] = await mysqlConnection.execute(
        `SELECT first_name, email FROM users WHERE id = ?`,
        [userId]
      );

      const [[plan]] = await mysqlConnection.execute(
        `SELECT name FROM plans WHERE id = ?`,
        [activeSub.plan_id]
      );

      const emailData = subscriptionCancelledTemplate({
        userName: user.first_name,
        planName: plan ? plan.name : 'Paid Plan',
        cancelledAt: new Date()
      });

      await sendEmail({
        to: user.email,
        subject: emailData.subject,
        html: emailData.html,
        text: emailData.text
      });

      await createAndDeliverNotification(
        {
          title: 'Subscription Cancelled by Admin',
          body: 'Your subscription has been cancelled by admin.',
          channel: 'inbox',
          metadata: {
            action: 'subscription_cancelled_admin',
            subscription_id: activeSub.id
          },
          target: {
            type: 'custom',
            user_ids: [userId]
          }
        },
        req.user.id,
        mysqlConnection
      );

      return successResponse(
        res,
        { subscription_id: activeSub.id },
        'Subscription cancelled successfully (admin)'
      );

    } catch (error) {
      console.error('Admin cancel error:', error);
      return errorResponse(res, 'Failed to cancel subscription', 500);
    }
  }
);

// @route   POST /api/subscriptions/expire
// @desc    User expires their own plan → downgraded to FREE
// @access  Private
router.post('/expire', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    const [[user]] = await mysqlConnection.execute(
      `SELECT id, current_plan_id, plan_status
       FROM users WHERE id = ?`,
      [userId]
    );

    if (!user || !user.current_plan_id || user.plan_status !== 'active') {
      return errorResponse(res, 'No active plan to expire', 400);
    }

    // Mark expired (history purpose)
    await mysqlConnection.execute(
      `UPDATE users SET
        plan_status = 'expired',
        updated_at = NOW()
       WHERE id = ?`,
      [userId]
    );

    // 🔥 Apply free plan + permissions
    const permissions =
      await applyFreePlanPermissionsToUser(mysqlConnection, userId);
    /* ========= EMAIL + NOTIFICATION (EXPIRE) ========= */
    try {
      const [[userRow]] = await mysqlConnection.execute(
        `SELECT first_name, email FROM users WHERE id = ?`,
        [userId]
      );

      const [[plan]] = await mysqlConnection.execute(
        `SELECT name FROM plans WHERE id = ?`,
        [user.current_plan_id]
      );

      const emailData = subscriptionExpiredTemplate({
        userName: userRow.first_name,
        planName: plan?.name || 'Subscription',
        expiredAt: new Date()
      });

      await sendEmail({
        to: userRow.email,
        subject: emailData.subject,
        html: emailData.html,
        text: emailData.text
      });

      await createAndDeliverNotification(
        {
          title: 'Subscription Expired',
          body: 'Your subscription has expired and your account is now on the Free plan.',
          channel: 'inbox',
          metadata: {
            action: 'subscription_expired',
            plan: 'free-account'
          },
          target: {
            type: 'custom',
            user_ids: [userId]
          }
        },
        userId,
        mysqlConnection
      );

      console.log('🔔 Expire email & notification sent');
    } catch (err) {
      console.warn('⚠️ Expire email/notification failed:', err.message);
    }

    return successResponse(
      res,
      {
        userId,
        planStatus: 'expired',
        downgradedTo: 'free-account',
        plan_permissions: permissions
      },
      'Plan expired successfully. Free plan applied.'
    );

  } catch (error) {
    console.error('❌ Self plan expire error:', error);
    return errorResponse(res, 'Failed to expire plan', 500);
  }
});

// @route   POST /api/subscriptions/admin/expire/:userId
// @desc    Admin expires a user's plan → downgraded to FREE
// @access  Private (SL Team)
router.post('/admin/expire/:userId', auth, requireAnyRole(['sl_team']),
  async (req, res) => {
    try {
      const { userId } = req.params;
      const mysqlConnection = getMySQLConnection();

      const [[user]] = await mysqlConnection.execute(
        `SELECT id, current_plan_id, plan_status
         FROM users WHERE id = ?`,
        [userId]
      );

      if (!user || !user.current_plan_id || user.plan_status !== 'active') {
        return errorResponse(res, 'No active plan to expire for this user', 400);
      }

      // Mark expired
      await mysqlConnection.execute(
        `UPDATE users SET
          plan_status = 'expired',
          updated_at = NOW()
         WHERE id = ?`,
        [userId]
      );

      // 🔥 Apply free plan + permissions
      const permissions =
        await applyFreePlanPermissionsToUser(mysqlConnection, userId);

      /* ========= EMAIL + NOTIFICATION (ADMIN EXPIRE) ========= */
      try {
        const [[userRow]] = await mysqlConnection.execute(
          `SELECT first_name, email FROM users WHERE id = ?`,
          [userId]
        );

        const [[plan]] = await mysqlConnection.execute(
          `SELECT name FROM plans WHERE id = ?`,
          [user.current_plan_id]
        );

        const emailData = subscriptionExpiredTemplate({
          userName: userRow.first_name,
          planName: plan?.name || 'Subscription',
          expiredAt: new Date()
        });

        await sendEmail({
          to: userRow.email,
          subject: emailData.subject,
          html: emailData.html,
          text: emailData.text
        });

        await createAndDeliverNotification(
          {
            title: 'Subscription Expired by Admin',
            body: 'Your subscription was expired by the admin. Free plan is now active.',
            channel: 'inbox',
            metadata: {
              action: 'subscription_expired_admin',
              plan: 'free-account'
            },
            target: {
              type: 'custom',
              user_ids: [userId]
            }
          },
          userId,
          mysqlConnection
        );

        console.log('🔔 Admin expire email & notification sent');
      } catch (err) {
        console.warn('⚠️ Admin expire email/notification failed:', err.message);
      }


      return successResponse(
        res,
        {
          userId,
          planStatus: 'expired',
          downgradedTo: 'free-account',
          plan_permissions: permissions
        },
        'User plan expired by admin and downgraded to free plan'
      );

    } catch (error) {
      console.error('❌ Admin expire plan error:', error);
      return errorResponse(res, 'Failed to expire user plan', 500);
    }
  }
);

// @route   GET /api/subscriptions/my-subscription
// @desc    Get current user's subscription details
// @access  Private
router.get('/my-subscription', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    // Get user with plan details
    const [users] = await mysqlConnection.execute(
      `SELECT u.id, u.email, u.role, u.current_plan_id, u.plan_start_date, 
       u.plan_end_date, u.plan_status, u.plan_permissions, u.has_upgraded,
       p.name as plan_name, p.slug as plan_slug, p.description as plan_description,
       p.price as plan_price, p.billing_cycle
       FROM users u
       LEFT JOIN plans p ON u.current_plan_id = p.id
       WHERE u.id = ?`,
      [userId]
    );

    if (users.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    const user = users[0];

    // Parse permissions
    const planPermissions = user.plan_permissions ? JSON.parse(user.plan_permissions) : null;

    // Check if subscription is expired
    let isExpired = false;
    if (user.plan_end_date && new Date(user.plan_end_date) < new Date()) {
      isExpired = true;
    }

    // Get feature usage if user has a plan
    let featureUsage = [];
    if (user.current_plan_id) {
      const [usage] = await mysqlConnection.execute(
        `SELECT fu.feature_id, f.name as feature_name, f.slug as feature_slug,
         fu.usage_count, fu.last_used_at, fu.reset_at
         FROM feature_usage fu
         JOIN features f ON fu.feature_id = f.id
         WHERE fu.user_id = ?`,
        [userId]
      );
      featureUsage = usage;
    }

    const response = {
      subscription: user.current_plan_id ? {
        planId: user.current_plan_id,
        planName: user.plan_name,
        planSlug: user.plan_slug,
        planDescription: user.plan_description,
        planPrice: user.plan_price,
        billingCycle: user.billing_cycle,
        startDate: user.plan_start_date,
        endDate: user.plan_end_date,
        status: user.plan_status,
        isExpired,
        hasUpgraded: user.has_upgraded
      } : null,
      permissions: planPermissions,
      featureUsage,
      role: user.role
    };

    successResponse(res, response, 'Subscription details retrieved successfully');

  } catch (error) {
    console.error('Get my subscription error:', error);
    errorResponse(res, 'Failed to get subscription details', 500);
  }
});

// @route   POST /api/subscriptions/check-feature-access
// @desc    Check if user has access to a specific feature
// @access  Private
router.post('/check-feature-access', auth, async (req, res) => {
  try {
    const { featureSlug } = req.body;
    const userId = req.user.id;
    const mysqlConnection = getMySQLConnection();

    if (!featureSlug) {
      return errorResponse(res, 'Feature slug is required', 400);
    }

    // Get user's plan permissions
    const [users] = await mysqlConnection.execute(
      `SELECT plan_permissions, custom_permissions FROM users WHERE id = ?`,
      [userId]
    );

    if (users.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    const user = users[0];
    const planPermissions = user.plan_permissions ? JSON.parse(user.plan_permissions) : {};
    const customPermissions = user.custom_permissions ? JSON.parse(user.custom_permissions) : {};

    // Check custom permissions first (they override plan permissions)
    if (customPermissions[featureSlug]) {
      return successResponse(res, {
        hasAccess: customPermissions[featureSlug].type !== '-',
        permissionType: customPermissions[featureSlug].type,
        source: 'custom'
      }, 'Feature access checked');
    }

    // Check plan permissions
    if (planPermissions[featureSlug]) {
      const permission = planPermissions[featureSlug];
      const hasAccess = permission.type !== '-';

      // If limited usage, check usage count
      if (permission.type === '1-plan') {
        const [usage] = await mysqlConnection.execute(
          `SELECT fu.usage_count, f.id as feature_id
           FROM feature_usage fu
           JOIN features f ON fu.feature_id = f.id
           WHERE fu.user_id = ? AND f.slug = ?`,
          [userId, featureSlug]
        );

        const usageCount = usage.length > 0 ? usage[0].usage_count : 0;
        const usageLimit = 1; // For '1-plan' type

        return successResponse(res, {
          hasAccess: usageCount < usageLimit,
          permissionType: permission.type,
          usageCount,
          usageLimit,
          source: 'plan'
        }, 'Feature access checked');
      }

      return successResponse(res, {
        hasAccess,
        permissionType: permission.type,
        source: 'plan'
      }, 'Feature access checked');
    }

    // No permission found
    return successResponse(res, {
      hasAccess: false,
      permissionType: '-',
      source: 'none'
    }, 'No access to this feature');

  } catch (error) {
    console.error('Check feature access error:', error);
    errorResponse(res, 'Failed to check feature access', 500);
  }
});

// @route   GET /api/subscriptions/get
// @desc    Get all subscriptions with populated user & plan (Admin Only)
// @access  Private (Admin)
router.get('/get', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    /* ======================================================
       🔥 1️⃣ AUTO-EXPIRE ALL USERS WHOSE PLAN HAS ENDED
    ====================================================== */

    console.log('🔍 Checking expired subscriptions before fetch...');

    // Step 1: Find all SUBSCRIPTIONS (not users) whose own end_date has passed
    // but are still marked active. Checking against the user's plan_end_date
    // was the bug — a user's plan_end_date only reflects their CURRENT plan,
    // so older subscription rows never got expired once their own end_date
    // passed if the user had since renewed/changed plans.
    const [expiredSubs] = await mysqlConnection.execute(`
      SELECT id, user_id
      FROM subscriptions
      WHERE status = 'active'
      AND end_date IS NOT NULL
      AND end_date < NOW()
    `);

    if (expiredSubs.length > 0) {
      const expiredSubIds = expiredSubs.map(s => s.id);
      const affectedUserIds = [...new Set(expiredSubs.map(s => s.user_id))];

      console.log(`⏳ Expiring ${expiredSubIds.length} subscriptions for ${affectedUserIds.length} users`);

      // Step 2: Expire those specific subscription rows
      await mysqlConnection.execute(
        `
        UPDATE subscriptions
        SET status = 'expired',
            updated_at = NOW()
        WHERE id IN (${expiredSubIds.map(() => '?').join(',')})
        `,
        expiredSubIds
      );

      // Step 3: Only downgrade a user to free if they have NO other
      // still-active subscription remaining (avoids wrongly downgrading
      // a user who has a second, still-valid active plan).
      const [stillActiveRows] = await mysqlConnection.execute(
        `
        SELECT DISTINCT user_id
        FROM subscriptions
        WHERE user_id IN (${affectedUserIds.map(() => '?').join(',')})
        AND status = 'active'
        `,
        affectedUserIds
      );
      const stillActiveUserIds = new Set(stillActiveRows.map(r => r.user_id));
      const usersToDowngrade = affectedUserIds.filter(id => !stillActiveUserIds.has(id));

      if (usersToDowngrade.length > 0) {
        await mysqlConnection.execute(
          `
          UPDATE users
          SET plan_status = 'expired',
              role = 'free_user',
              updated_at = NOW()
          WHERE id IN (${usersToDowngrade.map(() => '?').join(',')})
          `,
          usersToDowngrade
        );
      }

      console.log('✅ Expired subscriptions synced');
    }

    /* ======================================================
       2️⃣ FETCH ALL SUBSCRIPTIONS
    ====================================================== */

    const [rows] = await mysqlConnection.execute(`
      SELECT 
        s.*,

        -- USER POPULATE
        u.id AS user_id,
        u.first_name AS user_first_name,
        u.last_name AS user_last_name,
        u.email AS user_email,
        u.phone AS user_phone,
        u.role AS user_role,
        u.user_type AS user_user_type,
        u.current_plan_id AS user_current_plan_id,
        u.plan_start_date AS user_plan_start_date,
        u.plan_end_date AS user_plan_end_date,
        u.plan_status AS user_plan_status,
        u.avatar AS user_avatar,
        u.country AS user_country,
        u.state_province AS user_state,
        u.city AS user_city,
        u.postal_code AS user_postal_code,
        u.language AS user_language,
        u.timezone AS user_timezone,

        -- PLAN POPULATE
        p.id AS plan_id,
        p.name AS plan_name,
        p.slug AS plan_slug,
        p.price AS plan_price,
        p.billing_cycle AS plan_billing_cycle,
        p.is_active AS plan_is_active

      FROM subscriptions s
      LEFT JOIN users u ON s.user_id = u.id
      LEFT JOIN plans p ON s.plan_id = p.id
      WHERE p.slug IS NULL OR p.slug != 'free-account'
      ORDER BY s.created_at DESC
    `);

    /* ======================================================
       3️⃣ FORMAT RESPONSE
    ====================================================== */

    const subscriptions = rows.map(r => {
      let metadata = null;
      try {
        metadata = r.metadata ? JSON.parse(r.metadata) : null;
      } catch {
        metadata = r.metadata;
      }

      return {
        id: r.id,
        subscription_name: r.subscription_name,
        plan_id: r.plan_id,
        payment_transaction_id: r.payment_transaction_id,
        payment_id: r.payment_id,
        payment_type: r.payment_type,
        payment_status: r.payment_status,
        status: r.status,
        start_date: r.start_date,
        end_date: r.end_date,
        cancel_at_period_end: !!r.cancel_at_period_end,
        canceled_at: r.canceled_at,
        metadata,
        check_no: r.check_no,
        card_no: r.card_no,
        created_at: r.created_at,
        updated_at: r.updated_at,

        user: {
          id: r.user_id,
          first_name: r.user_first_name,
          last_name: r.user_last_name,
          email: r.user_email,
          phone: r.user_phone,
          role: r.user_role,
          user_type: r.user_user_type,
          current_plan_id: r.user_current_plan_id,
          plan_start_date: r.user_plan_start_date,
          plan_end_date: r.user_plan_end_date,
          plan_status: r.user_plan_status,
          avatar: r.user_avatar,
          country: r.user_country,
          state: r.user_state,
          city: r.user_city,
          postal_code: r.user_postal_code,
          language: r.user_language,
          timezone: r.user_timezone
        },

        plan: r.plan_id
          ? {
            id: r.plan_id,
            name: r.plan_name,
            slug: r.plan_slug,
            price: r.plan_price,
            billing_cycle: r.plan_billing_cycle,
            is_active: !!r.plan_is_active
          }
          : null
      };
    });

    return successResponse(
      res,
      { subscriptions },
      "All subscriptions fetched successfully"
    );

  } catch (error) {
    console.error("Get Subscriptions Error:", error);
    return errorResponse(res, "Failed to fetch subscriptions", 500);
  }
});

// @route   POST /api/subscriptions/create
// @desc    Create or update subscription (manual / gateway)
// @access  Private
router.post('/create', auth, async (req, res) => {
  try {
    const callerId = req.user?.id;
    const mysqlConnection = getMySQLConnection();

    const {
      user_id: payloadUserId,
      plan_id,
      payment_transaction_id,
      payment_id,
      payment_type = 'stripe',
      payment_status = 'pending',
      status = 'active',
      start_date,
      end_date,
      cancel_at_period_end = false,
      canceled_at,
      check_no,
      card_no,
      metadata,
      session
    } = req.body;

    const userId = payloadUserId ? Number(payloadUserId) : callerId;
    if (!userId) {
      return errorResponse(res, 'user_id required', 400);
    }

    /* =====================================================
       MASK CARD NUMBER
    ===================================================== */
    let storedCardNo = null;
    if (card_no) {
      const digits = String(card_no).replace(/\D/g, '');
      if (digits.length >= 12) {
        storedCardNo = `**** **** **** ${digits.slice(-4)}`;
      } else {
        storedCardNo = digits;
      }
    }

    /* =====================================================
       LOAD PLAN & CALCULATE DATES
    ===================================================== */
    let plan = null;
    let planStartDate = start_date ? new Date(start_date) : new Date();
    let planEndDate = end_date ? new Date(end_date) : new Date(planStartDate);

    if (plan_id) {
      const [[planRow]] = await mysqlConnection.execute(
        `SELECT * FROM plans WHERE id = ? AND is_active = TRUE LIMIT 1`,
        [plan_id]
      );
      if (!planRow) {
        return errorResponse(res, 'Invalid plan', 404);
      }
      plan = planRow;

      if (!end_date) {
        switch ((plan.billing_cycle || '').toLowerCase()) {
          case 'monthly':
            planEndDate.setMonth(planEndDate.getMonth() + 1);
            break;
          case 'yearly':
            planEndDate.setFullYear(planEndDate.getFullYear() + 1);
            break;
          case 'one-time':
            planEndDate.setFullYear(planEndDate.getFullYear() + 100);
            break;
          default:
            planEndDate.setMonth(planEndDate.getMonth() + 1);
        }
      }

      /* =====================================================
         BUILD PLAN PERMISSIONS
      ===================================================== */
      const [features] = await mysqlConnection.execute(
        `SELECT f.name, f.category, pt.name AS type, pf.custom_value
         FROM plan_features pf
         JOIN features f ON pf.feature_id = f.id
         JOIN permission_types pt ON pf.permission_type_id = pt.id
         WHERE pf.plan_id = ?`,
        [plan_id]
      );

      const permissions = {};
      features.forEach(f => {
        if (!permissions[f.category]) permissions[f.category] = {};
        permissions[f.category][f.name] =
          f.type === 'custom'
            ? { limit: Number(f.custom_value) || 0, used: 0 }
            : f.type;
      });


      const [[currentUser]] = await mysqlConnection.execute(
        `SELECT role FROM users WHERE id = ? LIMIT 1`,
        [userId]
      );
      const currentRole = currentUser?.role || 'free_user';
      let finalRole = currentRole;
      if (currentRole !== 'sl_team') {
        finalRole = 'user';
      }

      await mysqlConnection.execute(
        `UPDATE users SET
          current_plan_id = ?,
          plan_start_date = ?,
          plan_end_date = ?,
          plan_status = 'active',
          plan_permissions = ?,
          role = ?,
          user_type = 'admin',
          has_upgraded = TRUE,
          updated_at = NOW()
         WHERE id = ?`,
        [
          plan_id,
          planStartDate.toISOString().slice(0, 19).replace('T', ' '),
          planEndDate.toISOString().slice(0, 19).replace('T', ' '),
          JSON.stringify(permissions),
          finalRole,
          userId
        ]
      );
    }

    /* =====================================================
       HELPER: EMAIL + NOTIFICATION
    ===================================================== */
    async function sendHooks({ title, body, subscriptionId }) {
      const [[user]] = await mysqlConnection.execute(
        `SELECT email, first_name, last_name FROM users WHERE id = ? LIMIT 1`,
        [userId]
      );
      if (!user) return;

      const userName =
        `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'User';

      try {
        if (user.email) {
          const tpl = subscriptionCreatedTemplate({
            userName,
            planName: plan?.name || 'Subscription',
            startDate: planStartDate,
            endDate: planEndDate,
            paymentType: payment_type,
            amount: plan?.price || 0
          });

          await sendEmail({
            to: user.email,
            subject: tpl.subject,
            html: tpl.html,
            text: tpl.text
          });
        }
      } catch (e) {
        console.warn('Email failed:', e.message);
      }

      try {
        await createAndDeliverNotification(
          {
            title,
            body,
            channel: 'inbox',
            metadata: {
              subscription_id: subscriptionId,
              plan_id
            },
            target: {
              type: 'custom',
              user_ids: [userId]
            }
          },
          callerId,
          mysqlConnection
        );
      } catch (e) {
        console.warn('Notification failed:', e.message);
      }
    }

    /* =====================================================
       UPDATE IF PAYMENT_ID EXISTS
    ===================================================== */
    if (payment_id) {
      const [[existing]] = await mysqlConnection.execute(
        `SELECT * FROM subscriptions WHERE payment_id = ? LIMIT 1`,
        [payment_id]
      );

      if (existing) {
        await mysqlConnection.execute(
          `UPDATE subscriptions SET
            plan_id = ?,
            payment_type = ?,
            payment_status = ?,
            status = ?,
            start_date = ?,
            end_date = ?,
            cancel_at_period_end = ?,
            canceled_at = ?,
            metadata = ?,
            check_no = ?,
            card_no = ?,
            updated_at = NOW()
           WHERE id = ?`,
          [
            plan_id,
            payment_type,
            payment_status,
            status,
            planStartDate,
            planEndDate,
            cancel_at_period_end ? 1 : 0,
            canceled_at || null,
            JSON.stringify(metadata || {}),
            check_no || null,
            storedCardNo,
            existing.id
          ]
        );

        await sendHooks({
          title: 'Subscription Updated',
          body: `Your ${plan?.name || 'subscription'} has been updated.`,
          subscriptionId: existing.id
        });

        return successResponse(res, { subscription: existing }, 'Subscription updated');
      }
    }

    /* =====================================================
       CREATE NEW SUBSCRIPTION
    ===================================================== */
    const [result] = await mysqlConnection.execute(
      `INSERT INTO subscriptions
       (user_id, subscription_name, plan_id, payment_transaction_id, payment_id,
        payment_type, payment_status, status, start_date, end_date,
        cancel_at_period_end, canceled_at, metadata, check_no, card_no,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        userId,
        plan?.name || null,
        plan_id || null,
        payment_transaction_id || null,
        payment_id || null,
        payment_type,
        payment_status,
        status,
        planStartDate,
        planEndDate,
        cancel_at_period_end ? 1 : 0,
        canceled_at || null,
        JSON.stringify(metadata || {}),
        check_no || null,
        storedCardNo
      ]
    );

    const subscriptionId = result.insertId;

    /* ======================================================
       🔔 AUTO-CREATE DIOCESE (SAME AS STRIPE VERIFY API)
    ====================================================== */
    if (plan?.slug === 'diocesan-admin') {
      const [[existingDiocese]] = await mysqlConnection.execute(
        `SELECT id FROM dioceses WHERE diocesan_admin_id = ? LIMIT 1`,
        [userId]
      );

      if (!existingDiocese) {
        const [[userRow]] = await mysqlConnection.execute(
          `SELECT first_name, last_name, email, phone FROM users WHERE id = ?`,
          [userId]
        );

        await mysqlConnection.execute(
          `INSERT INTO dioceses
           (diocesan_admin_id, name, email, phone, created_at, updated_at)
           VALUES (?, ?, ?, ?, NOW(), NOW())`,
          [
            userId,
            `${userRow.first_name || ''} ${userRow.last_name || ''}`.trim(),
            userRow.email,
            userRow.phone
          ]
        );

        console.log('✅ Diocese auto-created for diocesan admin:', userId);
      }
    }

    await sendHooks({
      title: 'Subscription Activated',
      body: `Your ${plan?.name || 'subscription'} is now active.`,
      subscriptionId
    });

    return successResponse(
      res,
      { subscription_id: subscriptionId },
      'Subscription created successfully'
    );
  } catch (err) {
    console.error(err);
    return errorResponse(res, err.message, 500);
  }
});

// @route   GET /api/subscriptions/get/:id
// @desc    Get a single subscription by ID with full populated 
//          user details and plan details
// @access  Private (Authenticated User)
router.get('/get/:id', auth, requireAnyRole(['sl_team']), async (req, res) => {
  try {
    const id = req.params.id;
    const mysqlConnection = getMySQLConnection();

    const [rows] = await mysqlConnection.execute(
      `
      SELECT
        s.*,

        -- user fields (prefixed)
        u.id AS user_id,
        u.first_name AS user_first_name,
        u.last_name AS user_last_name,
        u.email AS user_email,
        u.phone AS user_phone,
        u.role AS user_role,
        u.user_type AS user_type,
        u.current_plan_id AS user_current_plan_id,
        u.plan_status AS user_plan_status,
        u.plan_start_date AS user_plan_start_date,
        u.plan_end_date AS user_plan_end_date,

        -- plan fields (prefixed)
        p.id AS plan_id,
        p.name AS plan_name,
        p.slug AS plan_slug,
        p.price AS plan_price,
        p.billing_cycle AS plan_billing_cycle,
        p.is_active AS plan_is_active

      FROM subscriptions s
      LEFT JOIN users u ON s.user_id = u.id
      LEFT JOIN plans p ON s.plan_id = p.id
      WHERE s.id = ?
      LIMIT 1
      `,
      [id]
    );

    if (!rows || rows.length === 0) {
      return errorResponse(res, 'Subscription not found', 404);
    }

    const row = rows[0];

    // Build subscription object
    const subscription = {
      id: row.id,
      user_id: row.user_id,
      subscription_name: row.subscription_name,
      plan_id: row.plan_id,
      payment_transaction_id: row.payment_transaction_id,
      payment_id: row.payment_id,
      payment_type: row.payment_type,
      status: row.status,
      start_date: row.start_date,
      end_date: row.end_date,
      cancel_at_period_end: !!row.cancel_at_period_end,
      canceled_at: row.canceled_at,
      metadata: null,
      check_no: row.check_no,
      card_no: row.card_no,
      created_at: row.created_at,
      updated_at: row.updated_at
    };

    // try parse metadata
    try {
      subscription.metadata = row.metadata ? JSON.parse(row.metadata) : null;
    } catch (e) {
      subscription.metadata = row.metadata || null;
    }

    // Build user object (if present)
    const user = row.user_id ? {
      id: row.user_id,
      first_name: row.user_first_name,
      last_name: row.user_last_name,
      email: row.user_email,
      phone: row.user_phone,
      role: row.user_role,
      user_type: row.user_type,
      current_plan_id: row.user_current_plan_id,
      plan_status: row.user_plan_status,
      plan_start_date: row.user_plan_start_date,
      plan_end_date: row.user_plan_end_date
    } : null;

    // Build plan object (if present)
    const plan = row.plan_id ? {
      id: row.plan_id,
      name: row.plan_name,
      slug: row.plan_slug,
      price: row.plan_price,
      billing_cycle: row.plan_billing_cycle,
      is_active: !!row.plan_is_active
    } : null;

    return successResponse(res, { subscription, user, plan }, 'Subscription fetched');

  } catch (error) {
    console.error('Get single subscription error:', error);
    return errorResponse(res, 'Failed to fetch subscription', 500);
  }
});

// @route   PUT /api/subscriptions/update/:id
// @desc    Update subscription details. 
//          Supports plan change (auto-updates expiry and permissions), 
//          payment type update, card/check details update, 
//          metadata update, and more.
// @access  Private (Authenticated User/Admin)
router.put('/update/:id', auth, requireAnyRole(['sl_team']), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const mysqlConnection = getMySQLConnection();
    const body = req.body || {};

    // Allowed fields (columns in subscriptions table)
    const allowed = new Set([
      'user_id',
      'subscription_name',
      'plan_id',
      'payment_transaction_id',
      'payment_id',
      'payment_type',            // 'stripe'|'cash'|'online'|'cheque'
      'status',
      'payment_status',
      'start_date',
      'end_date',
      'cancel_at_period_end',    // boolean
      'canceled_at',
      'metadata',
      'check_no',
      'card_no'
    ]);

    // Helpers
    const toSqlDateTime = (v) => {
      if (!v) return null;
      const d = new Date(v);
      if (isNaN(d.getTime())) return null;
      return d.toISOString().slice(0, 19).replace('T', ' ');
    };

    const maskCard = (raw) => {
      if (!raw) return null;
      const s = String(raw).replace(/\s+/g, '');
      const digits = s.replace(/\D/g, '');
      if (digits.length >= 12) {
        return `**** **** **** ${digits.slice(-4)}`;
      }
      // if it's already masked or short, keep last 4 or return as-is
      return s.length > 8 ? s.slice(-8) : s;
    };

    // Read current subscription
    const [existingRows] = await mysqlConnection.execute(
      'SELECT * FROM subscriptions WHERE id = ? LIMIT 1',
      [id]
    );
    if (!existingRows || existingRows.length === 0) {
      return errorResponse(res, 'Subscription not found', 404);
    }
    const existing = existingRows[0];

    // We'll collect SQL update pieces here
    const fields = [];
    const values = [];

    // Normalize incoming payment_type first if provided (decides clearing behavior)
    let incomingPaymentType = null;
    if (Object.prototype.hasOwnProperty.call(body, 'payment_type')) {
      incomingPaymentType = String(body.payment_type || '').toLowerCase();
      if (!['stripe', 'cash', 'online', 'cheque'].includes(incomingPaymentType)) {
        return errorResponse(res, 'Invalid payment_type', 400);
      }
      fields.push('payment_type = ?');
      values.push(incomingPaymentType);
    }

    // Handle payment_status properly (validate and collect)
    let incomingPaymentStatus = null;
    if (Object.prototype.hasOwnProperty.call(body, 'payment_status')) {
      incomingPaymentStatus = String(body.payment_status || '').toLowerCase();
      const allowedStatuses = ['pending', 'completed', 'refunded', 'cancelled', 'canceled', 'failed'];
      if (!allowedStatuses.includes(incomingPaymentStatus)) {
        return errorResponse(res, 'Invalid payment_status', 400);
      }
      fields.push('payment_status = ?');
      values.push(incomingPaymentStatus);
    }

    // === If plan_id present we need to load plan, compute start/end and update the user ===
    let plan = null;
    let computedStartDate = null;
    let computedEndDate = null;
    if (Object.prototype.hasOwnProperty.call(body, 'plan_id')) {
      const pid = Number(body.plan_id);
      if (!pid || isNaN(pid)) return errorResponse(res, 'Invalid plan_id', 400);

      const [plans] = await mysqlConnection.execute(
        `SELECT * FROM plans WHERE id = ? AND is_active = TRUE LIMIT 1`,
        [pid]
      );
      if (!plans || plans.length === 0) return errorResponse(res, 'Plan not found or inactive', 404);
      plan = plans[0];

      // determine start / end (prefer explicit payload values)
      const payloadStart = body.start_date ? toSqlDateTime(body.start_date) : null;
      const payloadEnd = body.end_date ? toSqlDateTime(body.end_date) : null;

      if (payloadStart) {
        computedStartDate = new Date(payloadStart);
      } else {
        computedStartDate = new Date(); // now
      }

      if (payloadEnd) {
        computedEndDate = new Date(payloadEnd);
      } else {
        computedEndDate = new Date(computedStartDate);
        // compute based on billing_cycle
        switch ((plan.billing_cycle || '').toLowerCase()) {
          case 'monthly':
          case 'month':
            computedEndDate.setMonth(computedEndDate.getMonth() + 1);
            break;
          case 'yearly':
          case 'year':
            computedEndDate.setFullYear(computedEndDate.getFullYear() + 1);
            break;
          case 'one-time':
            computedEndDate.setFullYear(computedEndDate.getFullYear() + 100);
            break;
          default:
            computedEndDate.setMonth(computedEndDate.getMonth() + 1);
        }
      }

      // Build planPermissions from plan_features (best-effort)
      let planPermissions = null;
      try {
        const [planFeatures] = await mysqlConnection.execute(
          `SELECT f.name AS feature_name, f.slug AS feature_slug, f.category, pt.name AS permission_type, pf.custom_value
           FROM plan_features pf
           JOIN features f ON pf.feature_id = f.id
           JOIN permission_types pt ON pf.permission_type_id = pt.id
           WHERE pf.plan_id = ? AND f.is_active = TRUE
           ORDER BY f.category, f.display_order, f.name`,
          [pid]
        );

        planPermissions = {};
        (planFeatures || []).forEach(feature => {
          const category = feature.category || 'general';
          const fname = feature.feature_name;
          const ptype = feature.permission_type || 'x';
          if (!planPermissions[category]) planPermissions[category] = {};

          if (ptype === 'custom' || (ptype === 'access-level' && feature.custom_value !== null)) {
            const v = Number(feature.custom_value);
            if (!isNaN(v)) planPermissions[category][fname] = { type: ptype, limit: v, used: 0 };
            else planPermissions[category][fname] = ptype;
          } else {
            planPermissions[category][fname] = ptype;
          }
        });
      } catch (err) {
        console.warn('Could not build plan permissions during update:', err.message);
      }

      // Update the related user (activate new plan)
      try {
        const userIdToUpdate = existing.user_id;
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
            pid,
            computedStartDate.toISOString().slice(0, 19).replace('T', ' '),
            computedEndDate.toISOString().slice(0, 19).replace('T', ' '),
            planPermissions ? JSON.stringify(planPermissions) : null,
            userIdToUpdate
          ]
        );
      } catch (err) {
        console.warn('Failed to update user with new plan during subscription update:', err.message);
        // continue to still update subscription row
      }

      // Ensure subscription_name defaults to plan.name if not explicitly provided
      if (!Object.prototype.hasOwnProperty.call(body, 'subscription_name')) {
        fields.push('subscription_name = ?');
        values.push(plan.name || null);
      }

      // Also add these subscription fields (start_date, end_date, plan_id)
      fields.push('plan_id = ?'); values.push(pid);
      fields.push('start_date = ?'); values.push(computedStartDate.toISOString().slice(0, 19).replace('T', ' '));
      fields.push('end_date = ?'); values.push(computedEndDate.toISOString().slice(0, 19).replace('T', ' '));
    } // end plan_id handling

    // Now process other allowed fields (but skip ones we already pushed)
    for (const [key, rawVal] of Object.entries(body)) {
      if (!allowed.has(key)) continue; // skip unknown fields

      // if plan_id processed above, skip plan_id here
      if (key === 'plan_id') continue;
      if (key === 'payment_type') continue; // already handled
      if (key === 'payment_status') continue; // already handled

      if (key === 'metadata') {
        fields.push('metadata = ?');
        values.push(rawVal ? JSON.stringify(rawVal) : null);
        continue;
      }

      if (key === 'cancel_at_period_end') {
        const boolVal = !!rawVal;
        fields.push('cancel_at_period_end = ?');
        values.push(boolVal ? 1 : 0);
        continue;
      }

      if (key === 'start_date' || key === 'end_date' || key === 'canceled_at') {
        // If plan_id was provided we already set start_date/end_date above unless user explicitly passed them
        const dt = toSqlDateTime(rawVal);
        fields.push(`${key} = ?`);
        values.push(dt);
        continue;
      }

      if (key === 'card_no') {
        const masked = maskCard(rawVal);
        fields.push('card_no = ?');
        values.push(masked);
        continue;
      }

      if (key === 'check_no') {
        fields.push('check_no = ?');
        values.push(rawVal || null);
        continue;
      }

      // numeric fields - coerce
      if (key === 'user_id' || key === 'payment_transaction_id') {
        fields.push(`${key} = ?`);
        values.push(rawVal === null ? null : Number(rawVal));
        continue;
      }

      // default: direct set
      if (key === 'subscription_name' || key === 'status' || key === 'payment_id') {
        fields.push(`${key} = ?`);
        values.push(rawVal);
        continue;
      }

      // any other allowed keys handled above
    }

    // If payment_type changed, clear irrelevant fields automatically
    if (incomingPaymentType) {
      if (incomingPaymentType === 'cash') {
        if (!Object.prototype.hasOwnProperty.call(body, 'card_no')) { fields.push('card_no = ?'); values.push(null); }
        if (!Object.prototype.hasOwnProperty.call(body, 'check_no')) { fields.push('check_no = ?'); values.push(null); }
      } else if (incomingPaymentType === 'online') {
        if (!Object.prototype.hasOwnProperty.call(body, 'check_no')) { fields.push('check_no = ?'); values.push(null); }
      } else if (incomingPaymentType === 'cheque') {
        if (!Object.prototype.hasOwnProperty.call(body, 'card_no')) { fields.push('card_no = ?'); values.push(null); }
      }
    }

    if (fields.length === 0) {
      return errorResponse(res, 'No valid fields provided to update', 400);
    }

    // Finalize query
    values.push(id); // WHERE id = ?
    const sql = `UPDATE subscriptions SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`;
    await mysqlConnection.execute(sql, values);

    // --- NEW: if payment_status provided, reflect it on subscription.status and apply side-effects via helper ---
    if (incomingPaymentStatus) {
      // set subscription.status according to incomingPaymentStatus
      if (incomingPaymentStatus === 'completed') {
        await mysqlConnection.execute(
          `UPDATE subscriptions SET status = 'active', updated_at = NOW() WHERE id = ?`,
          [id]
        );
      } else {
        // for refunded/failed/cancelled/pending etc -> expire subscription
        await mysqlConnection.execute(
          `UPDATE subscriptions SET status = 'expired', updated_at = NOW() WHERE id = ?`,
          [id]
        );
      }

      // re-fetch subscription and call helper to apply user-level effects
      const [freshSubs] = await mysqlConnection.execute(`SELECT * FROM subscriptions WHERE id = ? LIMIT 1`, [id]);
      const freshSub = (freshSubs && freshSubs.length) ? freshSubs[0] : existing;

      // call the centralized helper which will activate/downgrade the user accordingly
      await applyPaymentStatusEffects(mysqlConnection, freshSub, incomingPaymentStatus);
    }

    // Return the updated subscription row (fresh)
    const [afterRows] = await mysqlConnection.execute(`SELECT * FROM subscriptions WHERE id = ? LIMIT 1`, [id]);
    const updated = afterRows && afterRows.length ? afterRows[0] : null;

    successResponse(res, { subscription: updated }, 'Subscription updated successfully');
  } catch (error) {
    console.error('Update Subscription Error:', error);
    errorResponse(res, 'Failed to update subscription', 500);
  }
});

// Update only payment_status for a subscription and apply side-effects
router.put('/:id/status', auth, requireAnyRole(['sl_team']), async (req, res) => {
  try {
    const subId = Number(req.params.id);
    const bodyStatus = (req.body && req.body.status) ? String(req.body.status).toLowerCase() : null;
    const allowedStatuses = ['pending', 'completed', 'refunded', 'cancelled', 'canceled', 'failed'];
    console.log(bodyStatus, subId)
    if (!bodyStatus || !allowedStatuses.includes(bodyStatus)) {
      return errorResponse(res, `${req.body.status} is not applicable`, 400);
    }

    const mysqlConnection = getMySQLConnection();

    // Fetch existing subscription
    const [subs] = await mysqlConnection.execute(`SELECT * FROM subscriptions WHERE id = ? LIMIT 1`, [subId]);
    if (!subs || subs.length === 0) {
      return errorResponse(res, 'Subscription not found', 404);
    }
    const subscription = subs[0];

    // Update subscription.payment_status
    await mysqlConnection.execute(
      `UPDATE subscriptions SET payment_status = ?, updated_at = NOW() WHERE id = ?`,
      [bodyStatus, subId]
    );

    // If payment_status not completed -> mark subscription status expired (and clear user plan)
    if (bodyStatus !== 'completed') {
      // set subscription.status = 'expired' (only if not already)
      await mysqlConnection.execute(
        `UPDATE subscriptions SET status = 'expired', updated_at = NOW() WHERE id = ?`,
        [subId]
      );
    } else {
      // For completed, you might want to set subscription.status = 'active'
      await mysqlConnection.execute(
        `UPDATE subscriptions SET status = 'active', updated_at = NOW() WHERE id = ?`,
        [subId]
      );
    }

    // Re-fetch subscription (fresh) to pass to helper
    const [freshSubs] = await mysqlConnection.execute(`SELECT * FROM subscriptions WHERE id = ? LIMIT 1`, [subId]);
    const freshSub = (freshSubs && freshSubs.length) ? freshSubs[0] : subscription;

    // Apply side-effects on the user (downgrade/upgrade plan_permissions etc.)
    await applyPaymentStatusEffects(mysqlConnection, freshSub, bodyStatus);

    // Return updated subscription
    const [afterRows] = await mysqlConnection.execute(`SELECT * FROM subscriptions WHERE id = ? LIMIT 1`, [subId]);
    const updated = afterRows && afterRows.length ? afterRows[0] : null;

    return successResponse(res, { subscription: updated }, `Subscription payment_status updated to ${bodyStatus}`);
  } catch (error) {
    console.error('Update subscription status error:', error);
    return errorResponse(res, 'Failed to update subscription status', 500);
  }
});

/**
 * Apply side-effects to user when subscription payment_status changes.
 *
 * @param {object} mysqlConnection - connection/pool object with .execute
 * @param {object} subscription - subscription row (must include id, user_id, plan_id, start_date, end_date)
 * @param {string} paymentStatus - normalized lowercase status
 */
async function applyPaymentStatusEffects(mysqlConnection, subscription, paymentStatus) {
  if (!subscription || !subscription.user_id) return;

  const userId = subscription.user_id;
  const badStatuses = ['cancelled', 'refunded', 'failed', 'canceled'];

  try {
    if (paymentStatus === 'completed') {
      // Try to activate user's plan from subscription.plan_id (if present)
      if (subscription.plan_id) {
        // load plan
        const [plans] = await mysqlConnection.execute(
          `SELECT * FROM plans WHERE id = ? AND is_active = TRUE LIMIT 1`,
          [subscription.plan_id]
        );

        const plan = (plans && plans.length) ? plans[0] : null;

        // compute start/end (prefer subscription values)
        let startDate = subscription.start_date ? new Date(subscription.start_date) : new Date();
        let endDate = subscription.end_date ? new Date(subscription.end_date) : null;

        if (!endDate && plan) {
          endDate = new Date(startDate);
          switch ((plan.billing_cycle || '').toLowerCase()) {
            case 'monthly':
            case 'month':
              endDate.setMonth(endDate.getMonth() + 1);
              break;
            case 'yearly':
            case 'year':
              endDate.setFullYear(endDate.getFullYear() + 1);
              break;
            case 'one-time':
              endDate.setFullYear(endDate.getFullYear() + 100);
              break;
            default:
              endDate.setMonth(endDate.getMonth() + 1);
          }
        }

        // build plan_permissions if possible (best-effort)
        let planPermissions = null;
        if (plan) {
          try {
            const [planFeatures] = await mysqlConnection.execute(
              `SELECT f.name AS feature_name, f.slug AS feature_slug, f.category, pt.name AS permission_type, pf.custom_value
               FROM plan_features pf
               JOIN features f ON pf.feature_id = f.id
               JOIN permission_types pt ON pf.permission_type_id = pt.id
               WHERE pf.plan_id = ? AND f.is_active = TRUE
               ORDER BY f.category, f.display_order, f.name`,
              [plan.id]
            );

            planPermissions = {};
            (planFeatures || []).forEach(feature => {
              const category = feature.category || 'general';
              const fname = feature.feature_name;
              const ptype = feature.permission_type || 'x';
              if (!planPermissions[category]) planPermissions[category] = {};

              if (ptype === 'custom' || (ptype === 'access-level' && feature.custom_value !== null)) {
                const v = Number(feature.custom_value);
                if (!isNaN(v)) planPermissions[category][fname] = { type: ptype, limit: v, used: 0 };
                else planPermissions[category][fname] = ptype;
              } else {
                planPermissions[category][fname] = ptype;
              }
            });
          } catch (err) {
            console.warn('applyPaymentStatusEffects: could not build planPermissions', err.message);
            planPermissions = null;
          }
        }

        // Update user: set active plan
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
            plan ? plan.id : subscription.plan_id,
            startDate ? startDate.toISOString().slice(0, 19).replace('T', ' ') : null,
            endDate ? endDate.toISOString().slice(0, 19).replace('T', ' ') : null,
            planPermissions ? JSON.stringify(planPermissions) : null,
            userId
          ]
        );
      } else {
        // No plan_id on subscription: just clear plan_permissions and mark user as free? — we'll mark active but no plan
        await mysqlConnection.execute(
          `UPDATE users SET
             plan_permissions = NULL,
             current_plan_id = NULL,
             plan_status = 'active',
             has_upgraded = FALSE,
             updated_at = NOW()
           WHERE id = ?`,
          [userId]
        );
      }
    } else if (badStatuses.includes(paymentStatus)) {
      // Payment failure/refund/cancel: expire subscription and downgrade user to free
      // Expire subscription row handled by caller — but here ensure user's plan is cleared
      await mysqlConnection.execute(
        `UPDATE users SET
           plan_permissions = NULL,
           current_plan_id = NULL,
           plan_start_date = NULL,
           plan_end_date = NULL,
           plan_status = 'free',
           role = 'free_user',
           has_upgraded = FALSE,
           updated_at = NOW()
         WHERE id = ?`,
        [userId]
      );
    } else {
      // other statuses (pending etc.) -> treat as not-complete: downgrade to free
      await mysqlConnection.execute(
        `UPDATE users SET
           plan_permissions = NULL,
           current_plan_id = NULL,
           plan_start_date = NULL,
           plan_end_date = NULL,
           plan_status = 'free',
           role = 'free_user',
           has_upgraded = FALSE,
           updated_at = NOW()
         WHERE id = ?`,
        [userId]
      );
    }
  } catch (err) {
    console.warn('applyPaymentStatusEffects error:', err.message);
    // non-fatal
  }
}

// @route   DELETE /api/subscriptions/delete/:id
// @desc    Delete a subscription permanently from the system
//          (Does NOT delete user or payment records.)
// @access  Private (Admin or Authorized User)
router.delete('/delete/:id', auth, requireAnyRole(['sl_team']), async (req, res) => {
  try {
    const id = req.params.id;
    const mysqlConnection = getMySQLConnection();

    await mysqlConnection.execute(
      `DELETE FROM subscriptions WHERE id = ?`,
      [id]
    );

    successResponse(res, null, 'Subscription deleted successfully');

  } catch (error) {
    console.error('Delete Subscription Error:', error);
    errorResponse(res, 'Failed to delete subscription', 500);
  }
});


const ExcelJS = require("exceljs");

// @route GET /api/subscriptions/export
// @desc Export subscriptions in Excel
// @access Private (Admin)

router.get("/export", async (req, res) => {
  try {
    const mysql = getMySQLConnection();
    /* ============================================================
       DATE FORMAT
    ============================================================ */

    const convertDate = (date) => {
      if (!date) return null;
      if (date.includes("-")) return date;
      const [month, day, year] = date.split("/");
      return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    };

    const startDate = convertDate(req.query.startDate);
    const endDate = convertDate(req.query.endDate);

    const status = req.query.status;
    const paymentStatus = req.query.paymentStatus;
    const paymentType = req.query.paymentType;

    console.log("========== SUBSCRIPTION EXPORT ==========");
    console.log(req.query);

    /* ============================================================
       WHERE
    ============================================================ */

    let where = [];
    let params = [];

    if (startDate && endDate) {
      where.push("DATE(s.created_at) BETWEEN ? AND ?");
      params.push(startDate, endDate);
    }
    if (status) {
      where.push("s.status=?");
      params.push(status);
    }
    if (paymentStatus) {
      where.push("s.payment_status=?");
      params.push(paymentStatus);
    }
    if (paymentType) {
      where.push("s.payment_type=?");
      params.push(paymentType);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    /* ============================================================
       SQL
    ============================================================ */
    const sql = `SELECT s.*, u.id AS user_id,u.first_name,u.last_name,u.email,u.phone,u.role,u.user_type,
          u.plan_status,u.country,u.state_province,u.city,u.language,u.timezone,
          p.name plan_name,p.slug,p.price,p.billing_cycle,p.is_active FROM subscriptions s
          LEFT JOIN users u ON u.id=s.user_id  LEFT JOIN plans p ON p.id=s.plan_id
          ${whereClause} ORDER BY s.created_at DESC
    `;
    console.log(sql);
    console.log(params);
    const [rows] = await mysql.execute(sql, params);
    console.log("Rows:", rows.length);
    if (rows.length) {
      console.log(rows[0]);
    }
    /* ============================================================
       WORKBOOK
    ============================================================ */

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Simply Liturgical";
    workbook.created = new Date();
    const worksheet = workbook.addWorksheet("Subscriptions");
    /* ============================================================
       HEADERS
    ============================================================ */

    worksheet.columns = [
      {
        header: "Subscription ID",
        key: "subscriptionId",
        width: 18,
      },
      {
        header: "User ID",
        key: "userId",
        width: 12,
      },
      {
        header: "Name",
        key: "name",
        width: 28,
      },
      {
        header: "Email",
        key: "email",
        width: 35,
      },
      {
        header: "Phone",
        key: "phone",
        width: 18,
      },
      {
        header: "Plan",
        key: "plan",
        width: 35,
      },
      {
        header: "Price",
        key: "price",
        width: 12,
      },
      {
        header: "Billing Cycle",
        key: "billing",
        width: 15,
      },
      {
        header: "Payment Type",
        key: "paymentType",
        width: 15,
      },
      {
        header: "Payment ID",
        key: "paymentId",
        width: 45,
      },
      {
        header: "Transaction ID",
        key: "transactionId",
        width: 18,
      },
      {
        header: "Payment Status",
        key: "paymentStatus",
        width: 18,
      },
      {
        header: "Subscription Status",
        key: "status",
        width: 18,
      },
      {
        header: "Plan Status",
        key: "planStatus",
        width: 18,
      },
      {
        header: "Role",
        key: "role",
        width: 15,
      },
      {
        header: "User Type",
        key: "userType",
        width: 15,
      },
      {
        header: "Country",
        key: "country",
        width: 18,
      },
      {
        header: "State",
        key: "state",
        width: 18,
      },
      {
        header: "City",
        key: "city",
        width: 18,
      },
      {
        header: "Language",
        key: "language",
        width: 12,
      },
      {
        header: "Timezone",
        key: "timezone",
        width: 18,
      },
      {
        header: "Metadata Source",
        key: "source",
        width: 20,
      },
      {
        header: "Start Date",
        key: "startDate",
        width: 22,
      },
      {
        header: "End Date",
        key: "endDate",
        width: 22,
      },
      {
        header: "Created At",
        key: "createdAt",
        width: 22,
      },
    ];

    worksheet.getRow(1).font = {
      bold: true,
    };
    worksheet.views = [
      {
        state: "frozen",
        ySplit: 1,
      },
    ];

    worksheet.autoFilter = {
      from: "A1",
      to: "Y1",
    };

    let totalRevenue = 0;
    let activeCount = 0;
    let expiredCount = 0;
    let canceledCount = 0;

    for (const row of rows) {
      let metadata = {};
      try {
        metadata = row.metadata ? JSON.parse(row.metadata) : {};
      } catch (err) {
        metadata = {};
      }
      if (row.status === "active") activeCount++;
      if (row.status === "expired") expiredCount++;
      if (row.status === "canceled") canceledCount++;

      totalRevenue += Number(row.price || 0);
      worksheet.addRow({
        subscriptionId: row.id,
        userId: row.user_id,
        name: `${row.first_name || ""} ${row.last_name || ""}`.trim(),
        email: row.email,
        phone: row.phone,
        plan: row.plan_name,
        price: Number(row.price || 0),
        billing: row.billing_cycle,
        paymentType: row.payment_type,
        paymentId: row.payment_id,
        transactionId: row.payment_transaction_id,
        paymentStatus: row.payment_status,
        status: row.status,
        planStatus: row.plan_status,
        role: row.role,
        userType: row.user_type,
        country: row.country,
        state: row.state_province,
        city: row.city,
        language: row.language,
        timezone: row.timezone,
        source: metadata.source || "",
        startDate: row.start_date,
        endDate: row.end_date,
        createdAt: row.created_at,
      });
    }
    console.log("Worksheet Rows:", worksheet.rowCount);
    /* ============================================================
       HEADER STYLE
    ============================================================ */

    worksheet.getRow(1).eachCell((cell) => {
      cell.font = {
        bold: true,
        color: {
          argb: "FFFFFFFF",
        },
      };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: {
          argb: "1F4E78",
        },
      };
      cell.alignment = {
        vertical: "middle",
        horizontal: "center",
      };
      cell.border = {
        top: {
          style: "thin",
        },
        left: {
          style: "thin",
        },
        bottom: {
          style: "thin",
        },
        right: {
          style: "thin",
        },
      };
    });

    /* ============================================================
       BODY STYLE
    ============================================================ */

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;

      row.eachCell((cell) => {
        cell.border = {
          top: {
            style: "thin",
          },
          left: {
            style: "thin",
          },
          bottom: {
            style: "thin",
          },
          right: {
            style: "thin",
          },
        };
        cell.alignment = {
          vertical: "middle",
        };
      });
    });

    /* ============================================================
       PRICE FORMAT
    ============================================================ */
    worksheet.getColumn("price").numFmt = "$#,##0.00";

    /* ============================================================
       DATE FORMAT
    ============================================================ */

    ["startDate", "endDate", "createdAt"].forEach((col) => {
      worksheet.getColumn(col).numFmt = "yyyy-mm-dd hh:mm:ss";
    });

    /* ============================================================
       SUMMARY SHEET
    ============================================================ */

    const summary = workbook.addWorksheet("Summary");
    summary.columns = [
      {
        header: "Metric",
        key: "metric",
        width: 35,
      },
      {
        header: "Value",
        key: "value",
        width: 25,
      },
    ];
    summary.getRow(1).font = {
      bold: true,
    };
    summary.addRows([
      {
        metric: "Total Records",
        value: rows.length,
      },
      {
        metric: "Active Subscriptions",
        value: activeCount,
      },
      {
        metric: "Expired Subscriptions",
        value: expiredCount,
      },
      {
        metric: "Canceled Subscriptions",
        value: canceledCount,
      },
      {
        metric: "Total Plan Value",
        value: totalRevenue,
      },
    ]);

    summary.getColumn("value").numFmt = "$#,##0.00";
    /* ============================================================
       DOWNLOAD
    ============================================================ */

    const fileName =
      startDate && endDate
        ? `subscriptions-${startDate}-to-${endDate}.xlsx`
        : "subscriptions.xlsx";

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    console.log("Exporting Excel...");
    await workbook.xlsx.write(res);
    res.end();
    console.log("Export Completed");
  } catch (error) {
    console.error("EXPORT ERROR:", error);
    return errorResponse(res, "Failed to export subscriptions", 500);
  }
});

module.exports = router;