const express = require("express");
const { auth, requireSLTeamWithTypes } = require("../../middleware/auth");
const { getMySQLConnection } = require("../../config/mysql");
const { successResponse, errorResponse } = require("../../utils/response");
const { sendDioceseRegistrationEmail, sendEmail } = require("../../utils/SendMailer");
const bcrypt = require('bcryptjs');
const Stripe = require("stripe");
const router = express.Router();
const { createAndDeliverNotification } = require("../../utils/notificationUtils");
const { subscriptionCreatedTemplate } = require("../../utils/subscriptionsEmailtemplate");

/* ============================================================
   1️⃣ HEALTH CHECK
============================================================ */
router.get("/", async (req, res) => {
  return successResponse(res, {
    message: "Diocesan management endpoint is working",
  });
});

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
    console.error('❌ Error regenerating permissions:', error);
    throw error;
  }
}

/* ============================================================
   @route   POST /api/diocese/create-admin
   @desc    Create Diocese + FREE PLAN auto attach
   @access  Private (Superadmin)
============================================================ */
router.post("/create-admin", auth, async (req, res) => {
  const mysql = getMySQLConnection();
  const connection = await mysql.getConnection();

  const generateSlug = (name) =>
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-");

  try {
    /* =====================================================
  1️⃣ SUPERADMIN CHECK
===================================================== */
    if (req.user.user_type !== "superadmin") {
      return errorResponse(res, "Only Superadmin can create Diocese", 403);
    }

    const {
      existing_user_id,
      first_name,
      last_name,
      email,
      password,
      official_name,
      primary_contact_name,
      primary_contact_email,
      primary_contact_phone,
      total_parishes,
    } = req.body;

    if (
      !official_name ||
      !primary_contact_name ||
      !primary_contact_email ||
      !total_parishes
    ) {
      return errorResponse(res, "Missing required fields", 400);
    }

    /* =====================================================
      2️⃣ AUTO SLUG
    ===================================================== */
    let baseSlug = generateSlug(official_name);
    let slug = baseSlug;
    let i = 1;

    while (true) {
      const [[exists]] = await connection.execute(
        `SELECT id FROM dioceses WHERE slug = ?`,
        [slug]
      );
      if (!exists) break;
      slug = `${baseSlug}-${i++}`;
    }

    /* =====================================================
      3️⃣ USER HANDLING
    ===================================================== */
    let userId;
    let plainPassword = null;
    let isNewUser = false;

    /* ---------- EXISTING USER ---------- */
    if (existing_user_id) {
      const [[user]] = await connection.execute(
        `SELECT id, is_diocesan FROM users WHERE id = ?`,
        [existing_user_id]
      );

      if (!user) return errorResponse(res, "User not found", 404);
      if (user.is_diocesan)
        return errorResponse(res, "User already Diocese", 400);

      userId = existing_user_id;
    }

    /* ---------- NEW USER (🔥 FREE PLAN LOGIC ADDED) ---------- */
    else {
      if (!first_name || !email || !password)
        return errorResponse(res, "User details required", 400);

      const normalizedEmail = email.trim().toLowerCase();

      const [[exists]] = await connection.execute(
        `SELECT id FROM users WHERE email = ?`,
        [normalizedEmail]
      );

      if (exists)
        return errorResponse(res, "Email already exists", 400);

      plainPassword = password;
      const hashed = await bcrypt.hash(password, 12);

      /* 🔥 FETCH FREE PLAN */
      const [[freePlan]] = await connection.execute(
        `SELECT id FROM plans 
         WHERE slug='free-account' AND billing_cycle='free' LIMIT 1`
      );

      if (!freePlan)
        return errorResponse(res, "Free plan not configured", 500);

      const trialEnd = new Date();
      trialEnd.setDate(trialEnd.getDate() + 14);

      /* 🔥 INSERT USER WITH PLAN */
      const [newUser] = await connection.execute(
        `INSERT INTO users (
          first_name,last_name,email,password,
          role,user_type,is_diocesan,is_active,is_verified,
          current_plan_id,plan_status,plan_permissions,
          free_trial_expires_at,created_at,updated_at
        )
        VALUES (?,?,?,?, 'user','admin',TRUE,1,1, ?, 'active', '{}', ?, NOW(), NOW())`,
        [
          first_name.trim(),
          last_name.trim(),
          normalizedEmail,
          hashed,
          freePlan.id,
          trialEnd
        ]
      );

      userId = newUser.insertId;
      isNewUser = true;

      /* 🔥 GENERATE PLAN PERMISSIONS */
      await regeneratePermissionsForPlanUsers(freePlan.id, connection);
    }

    /* =====================================================
      4️⃣ INSERT DIOCESE
    ===================================================== */
    await connection.execute(
      `INSERT INTO dioceses
      (user_id,official_name,slug,primary_contact_name,
       primary_contact_email,primary_contact_phone,total_parishes,
       status,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'pending_activation',?,NOW(),NOW())`,
      [
        userId,
        official_name.trim(),
        slug,
        primary_contact_name.trim(),
        primary_contact_email.trim(),
        primary_contact_phone || null,
        total_parishes,
        req.user.id
      ]
    );

    await connection.execute(
      `UPDATE users SET is_diocesan = TRUE WHERE id=?`,
      [userId]
    );

    /* =====================================================
      5️⃣ EMAIL
    ===================================================== */
    try {
      await sendDioceseRegistrationEmail({
        firstName: first_name,
        lastName: last_name,
        email,
        password: plainPassword,
        isNewUser
      });
    } catch (e) {
      console.warn("Email failed:", e.message);
    }

    return successResponse(
      res,
      {
        diocese_user_id: userId,
        slug,
        status: "pending_activation"
      },
      "Diocese created successfully",
      201
    );

  } catch (err) {
    await connection.rollback();
    console.error(err);
    return errorResponse(res, "Failed to create Diocese", 500);
  } finally {
    connection.release();
  }
});

/* ============================================================
   @route   PUT /api/diocese/profile
   @desc    Update Diocese Profile (Self)
   @access  Private (Diocese / Superadmin)
============================================================ */
router.put("/profile", auth, async (req, res) => {
  const mysql = getMySQLConnection();

  try {
    /* =====================================================
       1️⃣ CHECK ACCESS
    ===================================================== */
    if (!req.user.is_diocesan && req.user.user_type !== "superadmin") {
      return errorResponse(res, "Access denied", 403);
    }

    const {
      official_name,
      primary_contact_name,
      primary_contact_email,
      primary_contact_phone,
      total_parishes,
    } = req.body;

    /* =====================================================
       2️⃣ GET DIOCESE RECORD
    ===================================================== */
    const [[diocese]] = await mysql.execute(
      `SELECT * FROM dioceses WHERE user_id = ?`,
      [req.user.id]
    );

    if (!diocese) {
      return errorResponse(res, "Diocese not found", 404);
    }

    /* =====================================================
       3️⃣ UPDATE FIELDS (Only if provided)
    ===================================================== */
    await mysql.execute(
      `
        UPDATE dioceses
        SET
          official_name = COALESCE(?, official_name),
          primary_contact_name = COALESCE(?, primary_contact_name),
          primary_contact_email = COALESCE(?, primary_contact_email),
          primary_contact_phone = COALESCE(?, primary_contact_phone),
          total_parishes = COALESCE(?, total_parishes),
          updated_at = NOW()
        WHERE user_id = ?
        `,
      [
        official_name || null,
        primary_contact_name || null,
        primary_contact_email || null,
        primary_contact_phone || null,
        total_parishes || null,
        req.user.id,
      ]
    );

    /* =====================================================
       4️⃣ FETCH UPDATED DATA
    ===================================================== */
    const [[updated]] = await mysql.execute(
      `SELECT * FROM dioceses WHERE user_id = ?`,
      [req.user.id]
    );

    return successResponse(
      res,
      updated,
      "Diocese profile updated successfully"
    );
  } catch (error) {
    console.error("❌ Diocese update error:", error);
    return errorResponse(res, "Failed to update Diocese", 500);
  }
});

/* ============================================================
   @route   PUT /api/diocese/admin/:dioceseId
   @desc    Superadmin Update Diocese
   @access  Private (Superadmin)
============================================================ */
router.put("/admin/:dioceseId", auth, async (req, res) => {
  const mysql = getMySQLConnection();

  try {
    /* =====================================================
       1️⃣ SUPERADMIN CHECK
    ===================================================== */
    if (req.user.user_type !== "superadmin") {
      return errorResponse(res, "Only Superadmin allowed", 403);
    }

    const { dioceseId } = req.params;

    const {
      official_name,
      primary_contact_name,
      primary_contact_email,
      primary_contact_phone,
      total_parishes,
      status,
    } = req.body;

    /* =====================================================
       2️⃣ CHECK DIOCESE EXISTS
    ===================================================== */
    const [[diocese]] = await mysql.execute(
      `SELECT * FROM dioceses WHERE id = ?`,
      [dioceseId]
    );

    if (!diocese) {
      return errorResponse(res, "Diocese not found", 404);
    }

    /* =====================================================
       3️⃣ UPDATE
    ===================================================== */
    await mysql.execute(
      `
        UPDATE dioceses
        SET
          official_name = COALESCE(?, official_name),
          primary_contact_name = COALESCE(?, primary_contact_name),
          primary_contact_email = COALESCE(?, primary_contact_email),
          primary_contact_phone = COALESCE(?, primary_contact_phone),
          total_parishes = COALESCE(?, total_parishes),
          status = COALESCE(?, status),
          updated_at = NOW()
        WHERE id = ?
        `,
      [
        official_name || null,
        primary_contact_name || null,
        primary_contact_email || null,
        primary_contact_phone || null,
        total_parishes || null,
        status || null,
        dioceseId,
      ]
    );

    /* =====================================================
       4️⃣ RETURN UPDATED DATA
    ===================================================== */
    const [[updated]] = await mysql.execute(
      `SELECT * FROM dioceses WHERE id = ?`,
      [dioceseId]
    );

    return successResponse(res, updated, "Diocese updated successfully");
  } catch (error) {
    console.error("❌ Diocese update error:", error);
    return errorResponse(res, "Update failed", 500);
  }
});

/* ============================================================
   @route   GET /api/admin/dioceses
   @desc    Get All Dioceses (Superadmin)
   @access  Private (Superadmin)
============================================================ */
router.get("/admin/dioceses", auth, async (req, res) => {
  try {
    const mysql = getMySQLConnection();

    if (req.user.user_type !== "superadmin") {
      return errorResponse(res, "Unauthorized", 403);
    }

    const [rows] = await mysql.execute(`
      SELECT d.*, u.email, u.first_name, u.last_name
      FROM dioceses d
      JOIN users u ON d.user_id = u.id
      ORDER BY d.created_at DESC
    `);

    const now = new Date();

    const dioceses = rows.map((d) => {
      let isGracePeriod = false;

      if (
        d.subscription_end_date &&
        d.grace_period_end_date &&
        new Date(d.subscription_end_date) < now &&
        new Date(d.grace_period_end_date) >= now
      ) {
        isGracePeriod = true;
      }

      return {
        ...d,
        isGracePeriod
      };
    });

    return successResponse(res, dioceses);

  } catch (error) {
    console.error(error);
    return errorResponse(res, "Failed to fetch dioceses", 500);
  }
});

/* ============================================================
   @route   POST /api/diocese/payments/create-ach-session
   @desc    Create Stripe Checkout Session for ACH Payment
   @access  Private (Diocese User)
============================================================ */
router.post("/payments/create-ach-session", auth, async (req, res) => {
  try {
    const { successUrl, cancelUrl } = req.body;

    if (!successUrl || !cancelUrl) {
      return errorResponse(res, "successUrl and cancelUrl are required", 400);
    }

    const mysqlConnection = getMySQLConnection();
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const userId = req.user.id;

    /* 1️⃣ CHECK DIOCESE */
    const [[diocese]] = await mysqlConnection.execute(
      `SELECT d.id, d.status, d.official_name,
          u.email, u.first_name, u.last_name
       FROM dioceses d
       JOIN users u ON d.user_id = u.id
       WHERE d.user_id = ?`,
      [userId]
    );

    if (!diocese) {
      return errorResponse(res, "Diocese account not found", 404);
    }

    if (diocese.status === "active") {
      return errorResponse(res, "Diocese already active", 400);
    }

    /* 2️⃣ CREATE CUSTOMER */
    const customer = await stripe.customers.create({
      email: diocese.email,
      name: `${diocese.first_name} ${diocese.last_name}`,
      metadata: {
        user_id: userId.toString(),
        diocese_id: diocese.id.toString(),
      },
    });

    /* 3️⃣ CREATE SESSION */
    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ["us_bank_account"],
      mode: "payment",
      submit_type: "pay",
      billing_address_collection: "auto",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "Diocesan Subscription (Annual)",
              description: `Annual access for ${diocese.official_name}`,
            },
            unit_amount: 720 * 100,
          },
          quantity: 1,
        },
      ],
      success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      metadata: {
        user_id: userId.toString(),
        diocese_id: diocese.id.toString(),
        payment_type: "ach",
      },
    });

    /* 4️⃣ INSERT PENDING PAYMENT */
    await mysqlConnection.execute(
      `INSERT INTO diocesan_payments (
        diocese_id, user_id, stripe_session_id,
        amount, currency, status, payment_method
      ) VALUES (?, ?, ?, ?, ?, 'pending', 'ach')`,
      [
        diocese.id,
        userId,
        session.id,
        720,
        "usd"
      ]
    );

    return successResponse(
      res,
      {
        sessionId: session.id,
        url: session.url,
      },
      "Diocesan ACH session created"
    );

  } catch (error) {
    console.error("❌ Diocese ACH error:", error);
    return errorResponse(res, "Failed to create diocesan payment session", 500);
  }
});


/* ============================================================
   @route   POST /api/diocese/payments/create-card-session
   @desc    Create Stripe Checkout Session for Card Payment
   @access  Private (Diocese User)
============================================================ */
router.post("/payments/create-card-session", auth, async (req, res) => {
  try {

    const mysqlConnection = getMySQLConnection();
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const { successUrl, cancelUrl } = req.body;
    const userId = req.user.id;

    const [[diocese]] = await mysqlConnection.execute(
      `SELECT d.id, d.status, u.email, u.first_name, u.last_name
       FROM dioceses d
       JOIN users u ON d.user_id = u.id
       WHERE d.user_id = ?`,
      [userId]
    );

    if (!diocese) {
      return errorResponse(res, "Diocese account not found", 404);
    }

    if (diocese.status === "active") {
      return errorResponse(res, "Diocese already active", 400);
    }

    const customer = await stripe.customers.create({
      email: diocese.email,
      name: `${diocese.first_name} ${diocese.last_name}`,
      metadata: {
        user_id: userId.toString(),
        diocese_id: diocese.id.toString(),
      },
    });

    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ["card"],
      mode: "payment",
      billing_address_collection: "auto",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "Diocesan Subscription (Annual)",
            },
            unit_amount: 720 * 100,
          },
          quantity: 1,
        },
      ],
      success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      metadata: {
        user_id: userId.toString(),
        diocese_id: diocese.id.toString(),
        payment_type: "card",
      },
    });

    /* INSERT PENDING PAYMENT */
    await mysqlConnection.execute(
      `INSERT INTO diocesan_payments (
        diocese_id, user_id, stripe_session_id,
        amount, currency, status, payment_method
      ) VALUES (?, ?, ?, ?, ?, 'pending', 'card')`,
      [
        diocese.id,
        userId,
        session.id,
        720,
        "usd"
      ]
    );

    return successResponse(
      res,
      {
        sessionId: session.id,
        url: session.url,
      },
      "Diocesan Card session created"
    );

  } catch (error) {
    console.error("❌ Diocese Card error:", error);
    return errorResponse(res, "Failed to create diocesan card session", 500);
  }
});

/* ============================================================
   @route   GET /api/diocese/payments/verify/:sessionId
   @desc    Verify Stripe Payment & Activate Diocese
   @access  Private
============================================================ */
router.get("/payments/verify/:sessionId", auth, async (req, res) => {
  try {

    const { sessionId } = req.params;
    const mysqlConnection = getMySQLConnection();
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent", "payment_intent.latest_charge"],
    });

    if (!session) {
      return errorResponse(res, "Invalid session", 404);
    }

    const paymentIntentObj = session.payment_intent;

    const isProcessing = paymentIntentObj?.status === "processing";
    const isPaid =
      session.payment_status === "paid" ||
      paymentIntentObj?.status === "succeeded";

    if (!isPaid && !isProcessing) {
      return errorResponse(res, "Payment not completed yet", 400);
    }

    const userId = session.metadata.user_id;
    const dioceseId = session.metadata.diocese_id;

    const rawMethod = session.payment_method_types?.[0] || "card";
    const detectedPaymentMethod =
      rawMethod === "us_bank_account" ? "ach" : "card";

    /* =====================================================
       1️⃣ UPDATE PAYMENT RECORD
    ===================================================== */

    await mysqlConnection.execute(
      `UPDATE diocesan_payments
       SET stripe_payment_intent_id = ?,
           status = 'completed',
           paid_at = NOW()
       WHERE stripe_session_id = ?`,
      [paymentIntentObj.id, session.id]
    );

    /* =====================================================
       2️⃣ ACTIVATE DIOCESE
    ===================================================== */

    const startDate = new Date();
    const endDate = new Date();
    endDate.setFullYear(endDate.getFullYear() + 1);

    await mysqlConnection.execute(
      `UPDATE dioceses
       SET status='active',
           subscription_start_date=?,
           subscription_end_date=?,
           renewal_date=?,
           grace_period_end_date = DATE_ADD(?, INTERVAL 30 DAY)
       WHERE id=?`,
      [startDate, endDate, endDate, endDate, dioceseId]
    );

    /* =====================================================
       3️⃣ GET USER INFO
    ===================================================== */

    const [[user]] = await mysqlConnection.execute(
      `SELECT first_name,email
       FROM users
       WHERE id=?`,
      [userId]
    );

    const amount = session.amount_total
      ? session.amount_total / 100
      : 720;

    const currency = session.currency || "usd";

    /* =====================================================
       4️⃣ SEND EMAIL
    ===================================================== */

    const emailData = subscriptionCreatedTemplate({
      userName: user.first_name,
      planName: "Diocesan Annual Subscription",
      startDate,
      endDate,
      paymentType: detectedPaymentMethod,
      amount,
      currency: currency.toUpperCase(),
    });

    await sendEmail({
      to: user.email,
      subject: emailData.subject,
      html: emailData.html,
      text: emailData.text,
    });

    /* =====================================================
       5️⃣ SYSTEM NOTIFICATION
    ===================================================== */

    await createAndDeliverNotification(
      {
        title: "Diocese Subscription Activated",
        body: "Your diocesan subscription has been successfully activated.",
        channel: "inbox",
        metadata: {
          action: "diocese_subscription_activated",
          stripe_session_id: session.id,
        },
        target: {
          type: "custom",
          user_ids: [userId],
        },
      },
      userId,
      mysqlConnection
    );

    return successResponse(
      res,
      { status: "active" },
      "Diocese activated successfully"
    );

  } catch (error) {
    console.error(error);
    return errorResponse(res, "Verification failed", 500);
  }
});


/* ============================================================
   @route   GET /api/diocese/my-profile
   @desc    Get Logged-in Diocese Complete Profile (Full A-Z)
   @access  Private (Diocese Only)
============================================================ */
router.get("/my-profile", auth, async (req, res) => {

  try {

    const mysql = getMySQLConnection();

    /* =====================================================
       1️⃣ CHECK USER IS DIOCESAN
    ===================================================== */

    if (!req.user.is_diocesan) {
      return errorResponse(res, "Only diocesan users allowed", 403);
    }

    /* =====================================================
       2️⃣ DIOCESE + OWNER USER
    ===================================================== */

    const [[profile]] = await mysql.execute(
      `
      SELECT 
        d.*,
        u.id AS owner_user_id,
        u.first_name,
        u.last_name,
        u.email,
        u.phone,
        u.role,
        u.user_type,
        u.current_plan_id,
        u.plan_status,
        u.free_trial_expires_at
      FROM dioceses d
      LEFT JOIN users u ON d.user_id = u.id
      WHERE d.user_id = ?
      `,
      [req.user.id]
    );

    if (!profile) {
      return errorResponse(res, "Diocese profile not found", 404);
    }

    const dioceseId = profile.id;

    /* =====================================================
       3️⃣ PLAN DETAILS
    ===================================================== */

    let diocesePlan = null;

    if (profile.current_plan_id) {

      const [[planRow]] = await mysql.execute(
        `SELECT * FROM plans WHERE id=?`,
        [profile.current_plan_id]
      );

      diocesePlan = planRow || null;
    }

    /* =====================================================
       4️⃣ PARISH SUMMARY
    ===================================================== */

    const [[parishCount]] = await mysql.execute(
      `SELECT COUNT(*) AS total 
       FROM diocesan_parishes 
       WHERE diocese_id=?`,
      [dioceseId]
    );

    /* =====================================================
       5️⃣ DIOCESAN PAYMENTS
    ===================================================== */

    const [diocesePayments] = await mysql.execute(
      `
      SELECT *
      FROM diocesan_payments
      WHERE diocese_id=?
      ORDER BY created_at DESC
      `,
      [dioceseId]
    );

    const [[latestDiocesePayment]] = await mysql.execute(
      `
      SELECT *
      FROM diocesan_payments
      WHERE diocese_id=?
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [dioceseId]
    );

    /* =====================================================
       6️⃣ PARISH PAYMENT SUMMARY
    ===================================================== */

    const [[parishPaymentSummary]] = await mysql.execute(
      `
      SELECT 
        COUNT(*) AS total_transactions,
        COALESCE(SUM(amount),0) AS total_amount
      FROM diocesan_parish_payments
      WHERE diocese_id=?
      `,
      [dioceseId]
    );

    /* =====================================================
       7️⃣ GET ALL PARISHES FULL DETAIL
    ===================================================== */

    const [parishRows] = await mysql.execute(
      `
      SELECT 
          dp.*,
          u.id AS user_id,
          u.first_name,
          u.last_name,
          u.email,
          u.phone,
          u.role,
          u.user_type,
          u.current_plan_id,
          u.plan_status,
          u.plan_permissions,
          d.official_name AS diocese_name
      FROM diocesan_parishes dp
      LEFT JOIN users u ON dp.user_id = u.id
      LEFT JOIN dioceses d ON dp.diocese_id = d.id
      WHERE dp.diocese_id = ?
      ORDER BY dp.created_at DESC
      `,
      [dioceseId]
    );

    const parishes = [];

    for (let parish of parishRows) {

      /* ================= PLAN ================= */

      let plan = null;

      if (parish.current_plan_id) {

        const [[planRow]] = await mysql.execute(
          `SELECT * FROM plans WHERE id=?`,
          [parish.current_plan_id]
        );

        plan = planRow || null;
      }

      /* ================= PAYMENTS ================= */

      const [payments] = await mysql.execute(
        `
        SELECT dpp.*, p.name AS plan_name
        FROM diocesan_parish_payments dpp
        LEFT JOIN plans p ON dpp.plan_id = p.id
        WHERE dpp.parish_id = ?
        ORDER BY dpp.created_at DESC
        `,
        [parish.id]
      );

      /* ================= PAYMENT SUMMARY ================= */

      const [[paymentSummary]] = await mysql.execute(
        `
        SELECT 
          COUNT(*) AS total_payments,
          SUM(CASE WHEN status='completed' THEN amount ELSE 0 END) AS total_paid,
          SUM(CASE WHEN status='pending' THEN amount ELSE 0 END) AS total_pending
        FROM diocesan_parish_payments
        WHERE parish_id=?
        `,
        [parish.id]
      );

      /* ================= FINAL PARISH STRUCTURE ================= */

      parishes.push({

        parish: {
          id: parish.id,
          parish_name: parish.parish_name,
          address: parish.parish_address,
          phone: parish.admin_phone,
          status: parish.status,
          joined_at: parish.joined_at,
          renewal_date: parish.renewal_date,
          notes: parish.notes,
          created_at: parish.created_at,
          updated_at: parish.updated_at
        },

        admin_user: {
          id: parish.user_id,
          name: `${parish.first_name} ${parish.last_name}`,
          email: parish.email,
          phone: parish.phone,
          role: parish.role,
          user_type: parish.user_type,
          plan_status: parish.plan_status,
          plan_permissions: parish.plan_permissions
            ? JSON.parse(parish.plan_permissions)
            : {}
        },

        plan: plan,

        diocese: {
          id: parish.diocese_id,
          name: parish.diocese_name
        },

        payments: payments,

        payment_summary: paymentSummary
      });

    }

    /* =====================================================
       8️⃣ FINAL RESPONSE (SAME STRUCTURE)
    ===================================================== */

    return successResponse(res, {

      diocese: {
        id: profile.id,
        official_name: profile.official_name,
        slug: profile.slug,
        status: profile.status,
        primary_contact_name: profile.primary_contact_name,
        primary_contact_email: profile.primary_contact_email,
        primary_contact_phone: profile.primary_contact_phone,
        allowed_parishes: profile.total_parishes,
        created_at: profile.created_at
      },

      owner_user: {
        id: profile.owner_user_id,
        name: `${profile.first_name} ${profile.last_name}`,
        email: profile.email,
        phone: profile.phone,
        role: profile.role,
        user_type: profile.user_type
      },

      plan: diocesePlan,

      parish_summary: {
        allowed_parishes: profile.total_parishes,
        created_parishes: parishCount.total
      },

      diocesan_payments: diocesePayments,
      latest_diocesan_payment: latestDiocesePayment || null,

      parish_payment_summary: parishPaymentSummary,

      parishes
    });

  } catch (error) {

    console.error("❌ Get Diocese Profile Error:", error);
    return errorResponse(res, "Failed to fetch diocese profile", 500);

  }

});


/* ============================================================
   @route   GET /api/diocese/:dioceseId
   @desc    Get Diocese Complete Profile (Full A-Z)
   @access  Private (Diocese / Superadmin)
============================================================ */
router.get("/:dioceseId", auth, async (req, res) => {
  try {
    const mysql = getMySQLConnection();
    const { dioceseId } = req.params;

    /* =====================================================
       1️⃣ AUTHORIZE ACCESS
    ===================================================== */

    const isSuperadmin = req.user.user_type === "superadmin";

    if (!isSuperadmin && req.user.diocese_id !== Number(dioceseId)) {
      return errorResponse(res, "Unauthorized access", 403);
    }

    /* =====================================================
       2️⃣ DIOCESE BASIC + OWNER
    ===================================================== */

    const [[profile]] = await mysql.execute(
      `
      SELECT 
        d.*,
        u.id AS owner_user_id,
        u.first_name,
        u.last_name,
        u.email,
        u.phone,
        u.role,
        u.user_type,
        u.current_plan_id,
        u.plan_status,
        u.free_trial_expires_at
      FROM dioceses d
      LEFT JOIN users u ON d.user_id = u.id
      WHERE d.id = ?
      `,
      [dioceseId]
    );

    if (!profile) {
      return errorResponse(res, "Diocese not found", 404);
    }

    /* =====================================================
       3️⃣ DIOCESE PLAN
    ===================================================== */

    let diocesePlan = null;

    if (profile.current_plan_id) {
      const [[planRow]] = await mysql.execute(
        `SELECT * FROM plans WHERE id=?`,
        [profile.current_plan_id]
      );
      diocesePlan = planRow || null;
    }

    /* =====================================================
       4️⃣ PARISH SUMMARY
    ===================================================== */

    const [[parishCount]] = await mysql.execute(
      `SELECT COUNT(*) AS total FROM diocesan_parishes WHERE diocese_id=?`,
      [dioceseId]
    );

    /* =====================================================
       5️⃣ DIOCESAN PAYMENTS
    ===================================================== */

    const [diocesePayments] = await mysql.execute(
      `
      SELECT *
      FROM diocesan_payments
      WHERE diocese_id=?
      ORDER BY created_at DESC
      `,
      [dioceseId]
    );

    const [[latestDiocesePayment]] = await mysql.execute(
      `
      SELECT *
      FROM diocesan_payments
      WHERE diocese_id=?
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [dioceseId]
    );

    /* =====================================================
       6️⃣ PARISH PAYMENT SUMMARY (ALL)
    ===================================================== */

    const [[parishPaymentSummary]] = await mysql.execute(
      `
      SELECT 
        COUNT(*) AS total_transactions,
        COALESCE(SUM(amount),0) AS total_amount
      FROM diocesan_parish_payments
      WHERE diocese_id=?
      `,
      [dioceseId]
    );

    /* =====================================================
       7️⃣ GET ALL PARISHES FULL DETAIL (A-Z)
    ===================================================== */

    const [parishRows] = await mysql.execute(
      `
      SELECT 
          dp.*,
          u.id AS user_id,
          u.first_name,
          u.last_name,
          u.email,
          u.phone,
          u.role,
          u.user_type,
          u.current_plan_id,
          u.plan_status,
          u.plan_permissions,
          d.official_name AS diocese_name
      FROM diocesan_parishes dp
      LEFT JOIN users u ON dp.user_id = u.id
      LEFT JOIN dioceses d ON dp.diocese_id = d.id
      WHERE dp.diocese_id = ?
      ORDER BY dp.created_at DESC
      `,
      [dioceseId]
    );


    const parishes = [];

    for (let parish of parishRows) {

      /* ================= PLAN ================= */

      let plan = null;

      if (parish.current_plan_id) {
        const [[planRow]] = await mysql.execute(
          `SELECT * FROM plans WHERE id=?`,
          [parish.current_plan_id]
        );
        plan = planRow || null;
      }

      /* ================= PAYMENTS ================= */

      const [payments] = await mysql.execute(
        `
        SELECT dpp.*, p.name AS plan_name
        FROM diocesan_parish_payments dpp
        LEFT JOIN plans p ON dpp.plan_id = p.id
        WHERE dpp.parish_id = ?
        ORDER BY dpp.created_at DESC
        `,
        [parish.id]
      );

      /* ================= PAYMENT SUMMARY ================= */

      const [[paymentSummary]] = await mysql.execute(
        `
        SELECT 
          COUNT(*) AS total_payments,
          SUM(CASE WHEN status='completed' THEN amount ELSE 0 END) AS total_paid,
          SUM(CASE WHEN status='pending' THEN amount ELSE 0 END) AS total_pending
        FROM diocesan_parish_payments
        WHERE parish_id=?
        `,
        [parish.id]
      );

      /* ================= FINAL STRUCTURE ================= */

      parishes.push({
        parish: {
          id: parish.id,
          parish_name: parish.parish_name,
          address: parish.parish_address,
          phone: parish.admin_phone,
          status: parish.status,
          joined_at: parish.joined_at,
          renewal_date: parish.renewal_date,
          notes: parish.notes,
          created_at: parish.created_at,
          updated_at: parish.updated_at
        },

        admin_user: {
          id: parish.user_id,
          name: `${parish.first_name} ${parish.last_name}`,
          email: parish.email,
          phone: parish.phone,
          role: parish.role,
          user_type: parish.user_type,
          plan_status: parish.plan_status,
          plan_permissions: parish.plan_permissions
            ? JSON.parse(parish.plan_permissions)
            : {}
        },

        plan: plan,

        diocese: {
          id: parish.diocese_id,
          name: parish.diocese_name
        },

        payments: payments,

        payment_summary: paymentSummary
      });
    }

    /* =====================================================
       8️⃣ FINAL RESPONSE
    ===================================================== */

    return successResponse(res, {
      diocese: {
        id: profile.id,
        official_name: profile.official_name,
        slug: profile.slug,
        status: profile.status,
        primary_contact_name: profile.primary_contact_name,
        primary_contact_email: profile.primary_contact_email,
        primary_contact_phone: profile.primary_contact_phone,
        allowed_parishes: profile.total_parishes,
        created_at: profile.created_at
      },

      owner_user: {
        id: profile.owner_user_id,
        name: `${profile.first_name} ${profile.last_name}`,
        email: profile.email,
        phone: profile.phone,
        role: profile.role,
        user_type: profile.user_type
      },

      plan: diocesePlan,

      parish_summary: {
        allowed_parishes: profile.total_parishes,
        created_parishes: parishCount.total
      },

      diocesan_payments: diocesePayments,
      latest_diocesan_payment: latestDiocesePayment || null,
      parish_payment_summary: parishPaymentSummary,

      // 🔥 FULL PARISH LIST (SAME STRUCTURE AS SINGLE API)
      parishes
    });

  } catch (error) {
    console.error("❌ Get Diocese Profile Error:", error);
    return errorResponse(res, "Failed to fetch diocese profile", 500);
  }
});

/* ============================================================
   @route   GET /api/diocese/payments
   @desc    Get Diocese Payment History with User + Diocese details
   @access  Private
============================================================ */
router.get("/payments", auth, async (req, res) => {
  try {

    const mysql = getMySQLConnection();

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    let whereClause = "";
    let params = [];

    /* --------------------------------------------------
       1️⃣ ROLE BASED FILTER
    -------------------------------------------------- */

    if (req.user.user_type === "superadmin" || req.user.role === "sl_team") {
      // all payments
    } else if (req.user.is_diocesan) {
      whereClause = "WHERE d.user_id = ?";
      params.push(req.user.id);
    } else {
      return errorResponse(res, "Unauthorized", 403);
    }

    /* --------------------------------------------------
       2️⃣ FETCH PAYMENTS
    -------------------------------------------------- */

    const [rows] = await mysql.execute(
      `
      SELECT 
        dp.id AS payment_id,
        dp.amount,
        dp.currency,
        dp.payment_method,
        dp.status,
        dp.stripe_session_id,
        dp.stripe_payment_intent_id,
        dp.created_at AS payment_date,

        d.id AS diocese_id,
        d.official_name,
        d.slug,
        d.status AS diocese_status,

        u.id AS user_id,
        u.first_name,
        u.last_name,
        u.email,
        u.phone

      FROM diocesan_payments dp
      JOIN dioceses d ON dp.diocese_id = d.id
      JOIN users u ON d.user_id = u.id

      ${whereClause}

      ORDER BY dp.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
      `,
      params
    );

    /* --------------------------------------------------
       3️⃣ TOTAL COUNT
    -------------------------------------------------- */

    const [[count]] = await mysql.execute(
      `
      SELECT COUNT(*) AS total
      FROM diocesan_payments dp
      JOIN dioceses d ON dp.diocese_id = d.id
      ${whereClause}
      `,
      params
    );

    return successResponse(res, {
      pagination: {
        page,
        limit,
        total: count.total,
        total_pages: Math.ceil(count.total / limit)
      },
      payments: rows
    });

  } catch (error) {
    console.error("❌ Diocese payments fetch error:", error);
    return errorResponse(res, "Failed to fetch diocesan payments", 500);
  }
});

module.exports = router;
