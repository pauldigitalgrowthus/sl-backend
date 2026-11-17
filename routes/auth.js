const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getMySQLConnection } = require('../config/mysql');
const { auth, requireSLTeamWithTypes } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');
const { avatarUpload, deleteFileFromS3 } = require('../config/s3');
const { sendOTPEmail, sendRegistrationEmail } = require('../utils/SendMailer');
const { sendEmail } = require('../utils/SendMailer');
const { createAndDeliverNotification } = require('../utils/notificationUtils')
const router = express.Router();

// =============================================================
// 🗂️ In-memory job store for the ActiveCampaign bulk-sync route.
// Bulk syncing can take longer than the server's global 120s request
// timeout, so that route runs the sync in the background and returns
// immediately — progress is tracked here and polled via a status route.
// Lives only in process memory (no DB change) and resets on restart.
// =============================================================
const acSyncJobs = new Map();

const createDefaultUserCollections = async (mysqlConnection, userId) => {
  try {
    const defaultCollections = [
      {
        name: 'My Gospel Collection',
        description: 'Gospel songs for worship and inspiration'
      },
      {
        name: 'My Classical Collection',
        description: 'Classical compositions and orchestral pieces'
      },
      {
        name: 'My Worship Collection',
        description: 'Modern worship songs'
      },
      {
        name: 'My Instrumental Collection',
        description: 'Instrumental music for meditation'
      },
      {
        name: 'My Christmas Collection',
        description: 'Christmas songs and carols'
      },
      {
        name: 'My Wedding Collection',
        description: 'Wedding and ceremonial music'
      }
    ];

    for (const collection of defaultCollections) {
      await mysqlConnection.execute(
        `
        INSERT INTO collections 
        (name, description, image_url, user_id, is_system_collection, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
        `,
        [
          collection.name,
          collection.description,
          null,
          userId,
          false,
          'user'
        ]
      );
    }

    console.log(`✅ Default collections created for user ${userId}`);
  } catch (error) {
    console.error('❌ Error creating user collections:', error);
  }
};

// Generate JWT token
const generateToken = (userId) => {
  const jwtSecret = process.env.JWT_SECRET || 'your-super-secret-jwt-key-for-sl-music-backend-2024';
  return jwt.sign(
    { userId },
    jwtSecret,
    { expiresIn: '1d' }
  );
};

/**
 * Ensure Ministers, Members, and Managers have full Community permissions in their permission payload
 */
const ensureMemberAndMinisterCommunityPermissions = async (user, mysqlConnection) => {
  if (!user || !user.id) return user;

  let isMinisterOrMember = (
    user.user_type === 'sub_user' ||
    user.user_type === 'manager' ||
    user.role === 'member' ||
    user.role === 'manager'
  );

  if (!isMinisterOrMember && mysqlConnection) {
    try {
      const [ministers] = await mysqlConnection.execute(
        'SELECT id FROM planner_ministers WHERE (linked_user_id = ? OR email = ?) AND deleted_at IS NULL LIMIT 1',
        [user.id, user.email || '']
      );
      if (ministers && ministers.length > 0) isMinisterOrMember = true;
    } catch (e) {}

    if (!isMinisterOrMember) {
      try {
        const [members] = await mysqlConnection.execute(
          'SELECT id FROM community_members WHERE (user_id = ? OR email = ?) AND deleted_at IS NULL LIMIT 1',
          [user.id, user.email || '']
        );
        if (members && members.length > 0) isMinisterOrMember = true;
      } catch (e) {}
    }
  }

  if (isMinisterOrMember) {
    if (!user.plan_permissions || typeof user.plan_permissions !== 'object') {
      user.plan_permissions = {};
    }
    if (!user.plan_permissions.Community || typeof user.plan_permissions.Community !== 'object') {
      user.plan_permissions.Community = {};
    }

    user.plan_permissions.Community.Feed = 'x';
    user.plan_permissions.Community.Feeds = 'x';
    user.plan_permissions.Community.Discussions = 'x';
    user.plan_permissions.Community['My Groups'] = 'x';
    user.plan_permissions.Community.Groups = 'x';
    user.plan_permissions.Community.Prayer = 'x';

    if (!user.plan_permissions['SL Portals'] || typeof user.plan_permissions['SL Portals'] !== 'object') {
      user.plan_permissions['SL Portals'] = {};
    }
    user.plan_permissions['SL Portals'].Community = {
      Feed: 'x',
      Feeds: 'x',
      Discussions: 'x',
      'My Groups': 'x',
      Groups: 'x',
      Prayer: 'x'
    };

    if (user.permissions && typeof user.permissions === 'object') {
      if (!user.permissions.Community) user.permissions.Community = {};
      user.permissions.Community.Feed = 'x';
      user.permissions.Community.Feeds = 'x';
      user.permissions.Community.Discussions = 'x';
      user.permissions.Community['My Groups'] = 'x';
      user.permissions.Community.Groups = 'x';
      user.permissions.Community.Prayer = 'x';

      if (!user.permissions['SL Portals']) user.permissions['SL Portals'] = {};
      user.permissions['SL Portals'].Community = {
        Feed: 'x',
        Feeds: 'x',
        Discussions: 'x',
        'My Groups': 'x',
        Groups: 'x',
        Prayer: 'x'
      };
    }
  }

  return user;
};

// =============================================================
// 🏷️ ActiveCampaign Sync Helpers
// =============================================================
// Contact: create/update via /contact/sync (upsert by email — no duplicates)
async function syncActiveCampaignContact({ email, firstName, lastName, phone }) {
  try {
    const syncResponse = await fetch(`${process.env.ACTIVE_CAMPAIGN_URL}/api/3/contact/sync`, {
      method: "POST",
      headers: {
        "Api-Token": process.env.ACTIVE_CAMPAIGN_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contact: {
          email,
          firstName: firstName || "",
          lastName: lastName || "",
          ...(phone ? { phone } : {}),
        },
      }),
    });

    const syncData = await syncResponse.json();

    if (syncResponse.ok) {
      return syncData.contact;
    }

    console.error(`Failed to sync AC contact "${email}"`, syncData);
    return null;
  } catch (err) {
    console.error(`Error syncing AC contact "${email}":`, err.message);
    return null;
  }
}

// Attach an existing tag to a contact (idempotent — 422 "already tagged" counts as success)
async function addTagToActiveCampaignContact(contactId, tagId) {
  if (!contactId || !tagId) return false;
  try {
    const response = await fetch(`${process.env.ACTIVE_CAMPAIGN_URL}/api/3/contactTags`, {
      method: "POST",
      headers: {
        "Api-Token": process.env.ACTIVE_CAMPAIGN_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contactTag: {
          contact: contactId,
          tag: tagId,
        },
      }),
    });

    if (response.ok || response.status === 422) {
      return true;
    }

    const data = await response.json().catch(() => ({}));
    console.error(`Failed to add tag ${tagId} to contact ${contactId}`, data);
    return false;
  } catch (err) {
    console.error(`Error adding tag ${tagId} to contact ${contactId}:`, err.message);
    return false;
  }
}

// Create a brand-new tag in ActiveCampaign
async function createActiveCampaignTag(tagName, description) {
  try {
    const createResponse = await fetch(`${process.env.ACTIVE_CAMPAIGN_URL}/api/3/tags`, {
      method: "POST",
      headers: {
        "Api-Token": process.env.ACTIVE_CAMPAIGN_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tag: {
          tag: tagName,
          tagType: "contact",
          description,
        },
      }),
    });

    const createData = await createResponse.json();

    if (createResponse.ok) {
      return createData.tag;
    }

    console.error(`Failed to create AC tag "${tagName}"`, createData);
    return null;
  } catch (err) {
    console.error(`Error creating AC tag "${tagName}":`, err.message);
    return null;
  }
}

// Get this role's saved AC tag ID (role_permissions.ac_tag_id) or create one & save it
async function getOrCreateRoleTag(mysqlConnection, roleName) {
  try {
    const [rows] = await mysqlConnection.execute(
      'SELECT id, ac_tag_id FROM role_permissions WHERE role_name = ?',
      [roleName]
    );

    const roleRow = rows[0] || null;

    if (roleRow?.ac_tag_id) {
      return { id: roleRow.ac_tag_id };
    }

    // No role_permissions row (or no tag saved yet) — create the tag directly
    const tag = await createActiveCampaignTag(roleName, `${roleName} role`);

    if (tag && roleRow) {
      await mysqlConnection.execute(
        'UPDATE role_permissions SET ac_tag_id = ? WHERE id = ?',
        [tag.id, roleRow.id]
      );
    }

    return tag;
  } catch (err) {
    console.error(`Error resolving AC tag for role "${roleName}":`, err.message);
    return null;
  }
}

// Get this plan's saved AC tag ID (plans.ac_tag_id) or create one & save it
async function getOrCreatePlanTag(mysqlConnection, planName, planId) {
  try {
    const [rows] = await mysqlConnection.execute(
      'SELECT ac_tag_id FROM plans WHERE id = ?',
      [planId]
    );

    const existingTagId = rows[0]?.ac_tag_id;

    if (existingTagId) {
      return { id: existingTagId };
    }

    const tag = await createActiveCampaignTag(planName, `Plan: ${planName}`);

    if (tag) {
      await mysqlConnection.execute(
        'UPDATE plans SET ac_tag_id = ? WHERE id = ?',
        [tag.id, planId]
      );
    }

    return tag;
  } catch (err) {
    console.error(`Error resolving AC tag for plan "${planName}":`, err.message);
    return null;
  }
}

// Fire-and-forget wrapper: call this from a route right before you respond
// (register, profile update, admin user update, etc.) so the ActiveCampaign
// sync runs in the background and never delays or breaks the actual request.
// `syncUserToActiveCampaign` itself is defined further down but is hoisted
// since it's a function declaration, so it's safe to reference here.
function triggerActiveCampaignSync(mysqlConnection, userId, context = '') {
  syncUserToActiveCampaign(mysqlConnection, userId)
    .then((result) => {
      if (result.success) {
        console.log(
          `✅ [AC AUTO-SYNC${context ? ':' + context : ''}] User ${userId} synced — tags: ${result.appliedTags.join(', ') || 'none'
          }${result.failedTags.length ? `, failed: ${result.failedTags.join(', ')}` : ''}`
        );
      } else {
        console.error(`⚠️ [AC AUTO-SYNC${context ? ':' + context : ''}] User ${userId} sync failed:`, result.error);
      }
    })
    .catch((err) => {
      console.error(`⚠️ [AC AUTO-SYNC${context ? ':' + context : ''}] User ${userId} sync threw:`, err.message);
    });
}

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
// @route   POST /api/auth/register
// @desc    Register a new user (FREE PLAN AUTO ASSIGN)
// @access  Public
router.post('/register', async (req, res) => {
  const mysqlConnection = getMySQLConnection();

  try {
    const {
      firstName,
      lastName,
      email,
      password,
      role,
      badges,
      is_composer,
      phone,
      createdBy
    } = req.body;

    /* --------------------------------------------------
       1️⃣ VALIDATION
    -------------------------------------------------- */
    if (!firstName || !lastName || !email || !password) {
      return errorResponse(res, 'Required fields are missing', 400);
    }

    const normalizedEmail = email.trim().toLowerCase();

    /* --------------------------------------------------
       2️⃣ CHECK USER EXISTS
    -------------------------------------------------- */
    const [existingUsers] = await mysqlConnection.execute(
      'SELECT id FROM users WHERE email = ?',
      [normalizedEmail]
    );

    if (existingUsers.length > 0) {
      return errorResponse(res, 'User already exists with this email', 400);
    }

    /* --------------------------------------------------
       3️⃣ DEFAULT USER VALUES
    -------------------------------------------------- */
    let finalRole = role || 'free_user';
    let finalUserType = null;
    let validatedBadges = [];
    let finalPermissions = {};

    /* --------------------------------------------------
       4️⃣ BADGE BASED LOGIC
    -------------------------------------------------- */
    if (Array.isArray(badges) && badges.length > 0) {
      const badgeNames = badges.map(b => b.trim()).filter(Boolean);
      const placeholders = badgeNames.map(() => '?').join(',');

      const [roles] = await mysqlConnection.execute(
        `SELECT role_name, permissions
         FROM role_permissions
         WHERE role_name IN (${placeholders})`,
        badgeNames
      );

      if (roles.length !== badgeNames.length) {
        const found = roles.map(r => r.role_name);
        const missing = badgeNames.filter(b => !found.includes(b));
        return errorResponse(res, `Invalid badge names: ${missing.join(', ')}`, 400);
      }

      validatedBadges = badgeNames;
      finalRole = 'sl_team';
      finalUserType = badgeNames.some(b => b.toLowerCase() === 'admin')
        ? 'admin'
        : 'sub_user';

      const mergePermissions = (source, target) => {
        Object.entries(source).forEach(([key, value]) => {
          if (value === 'x') {
            target[key] = 'x';
            return;
          }
          if (value === '-') return;

          if (typeof value === 'object' && value !== null) {
            if (!target[key]) target[key] = {};
            mergePermissions(value, target[key]);
            if (Object.keys(target[key]).length === 0) {
              delete target[key];
            }
          }
        });
      };

      roles.forEach(r => {
        const perms = JSON.parse(r.permissions || '{}');
        mergePermissions(perms, finalPermissions);
      });
    }

    /* --------------------------------------------------
       5️⃣ is_composer FIX
    -------------------------------------------------- */
    const finalIsComposer =
      is_composer === true || is_composer === 1 ? true : false;

    /* --------------------------------------------------
       6️⃣ HASH PASSWORD
    -------------------------------------------------- */
    const hashedPassword = await bcrypt.hash(password, 12);
    const normalizedPhone = phone ? phone.trim() : null;

    /* --------------------------------------------------
       7️⃣ FREE PLAN FETCH
    -------------------------------------------------- */
    const [[freePlan]] = await mysqlConnection.execute(
      `SELECT id 
       FROM plans 
       WHERE slug = 'free-account' AND billing_cycle = 'free'
       LIMIT 1`
    );

    if (!freePlan) {
      return errorResponse(res, 'Free plan not configured', 500);
    }

    const freePlanId = freePlan.id;

    const planEndDate = new Date();
    planEndDate.setDate(planEndDate.getDate() + 14);



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
      JOIN plans p ON pf.plan_id = p.id
      WHERE p.slug = 'free-account'
     AND p.billing_cycle = 'free'
     AND f.is_active = TRUE`
    );

    const freePlanPermissions = {};

    planFeatures.forEach(feature => {
      const category = feature.category;
      const featureName = feature.feature_name;
      const permissionType = feature.permission_type || 'x';

      if (!freePlanPermissions[category]) {
        freePlanPermissions[category] = {};
      }

      if (
        permissionType === 'custom' ||
        (permissionType === 'access-level' && feature.custom_value !== null)
      ) {
        const value = Number(feature.custom_value);
        if (!isNaN(value)) {
          freePlanPermissions[category][featureName] = {
            type: permissionType,
            limit: value,
            used: 0
          };
        } else {
          freePlanPermissions[category][featureName] = permissionType;
        }
      } else {
        freePlanPermissions[category][featureName] = permissionType;
      }
    });
    /* --------------------------------------------------
       8️⃣ INSERT USER (FREE PLAN ATTACHED)
    -------------------------------------------------- */
    const [result] = await mysqlConnection.execute(
      `INSERT INTO users (
        first_name,
        last_name,
        email,
        password,
        role,
        user_type,
        permissions,
        phone,
        badges,
        is_active,
        is_verified,
        is_composer,
        plan_status,
        plan_permissions,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, 'free', ?, NOW(), NOW())`,
      [
        firstName,
        lastName,
        normalizedEmail,
        hashedPassword,
        finalRole,
        finalUserType,
        JSON.stringify(finalPermissions),
        normalizedPhone,
        JSON.stringify(validatedBadges),
        finalIsComposer,
        JSON.stringify(freePlanPermissions) // 👈 yeh new variable hoga
      ]
    );

    const userId = result.insertId;

    /* --------------------------------------------------
       FETCH FREE PLAN PERMISSIONS ONLY (NO ASSIGN PLAN)
    -------------------------------------------------- */

    /* --------------------------------------------------
       🔟 FETCH USER
    -------------------------------------------------- */
    const [newUser] = await mysqlConnection.execute(
      'SELECT * FROM users WHERE id = ?',
      [userId]
    );

    const user = newUser[0];
    user.badges = user.badges ? JSON.parse(user.badges) : [];
    user.permissions = user.permissions ? JSON.parse(user.permissions) : {};
    user.plan_permissions = user.plan_permissions
      ? JSON.parse(user.plan_permissions)
      : {};

    // createDefaultUserCollections(mysqlConnection, userId);

    /* --------------------------------------------------
       🔟 TOKEN
    -------------------------------------------------- */
    const token = generateToken(userId);
    /* --------------------------------------------------
       🔟 SEND REGISTRATION EMAIL (AUTO DECISION)
    -------------------------------------------------- */
    try {
      await sendRegistrationEmail({
        firstName: user.first_name,
        lastName: user.last_name,
        email: user.email,
        password,
        role: user.role,
        badges: user.badges,
        is_composer: user.is_composer,
        createdBy
      });

      console.log('📧 Registration email sent successfully');
    } catch (err) {
      console.warn('⚠️ Registration email failed (non-blocking):', err.message);
    }


    // 🔗 Auto-sync new user to ActiveCampaign (non-blocking — doesn't delay the response)
    triggerActiveCampaignSync(mysqlConnection, userId, 'register');

    return successResponse(
      res,
      { user, token },
      'User registered with free plan successfully',
      201
    );

  } catch (error) {
    console.error('❌ Registration error:', error);
    return errorResponse(res, 'Registration failed', 500);
  }
});

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const mysqlConnection = getMySQLConnection();

    // Find user by email
    const [users] = await mysqlConnection.execute(
      `SELECT id, first_name, last_name, email, password, phone, role, user_type,
      is_composer,
       parent_user_id, current_plan_id, plan_start_date, plan_end_date, plan_status,
       plan_permissions, custom_permissions, max_sub_users, active_sub_users_count,
       bio, avatar, website_url, twitter_url, address, country, state_province,
       city, postal_code, language, timezone, badges, is_active, is_verified,permissions,is_diocesan,
       email_verified_at, last_login, login_count, free_trial_expires_at,
       has_upgraded, created_at, updated_at 
       FROM users WHERE email = ?`,
      [email]
    );

    if (users.length === 0) {
      return errorResponse(res, 'Invalid credentials', 401);
    }

    const user = users[0];

    // Check if user is active
    if (!user.is_active) {
      return errorResponse(res, 'Account is deactivated', 401);
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return errorResponse(res, 'Invalid credentials', 401);
    }

    // Check if plan has expired and update status
    let planUpdated = false;
    if (user.plan_end_date && new Date(user.plan_end_date) < new Date() && user.plan_status === 'active') {
      await mysqlConnection.execute(
        'UPDATE users SET plan_status = ?, role = ? WHERE id = ?',
        ['expired', 'free_user', user.id]
      );
      user.plan_status = 'expired';
      user.role = 'free_user';
      planUpdated = true;
    }

    // Check if free trial has expired
    if (user.role === 'free_user' && user.free_trial_expires_at &&
      new Date(user.free_trial_expires_at) < new Date()) {
      // Free trial expired - user can still login but with limited access
      user.freeTrialExpired = true;
    }

    // Get plan details if user has an active plan
    let currentPlan = null;
    if (user.current_plan_id && user.plan_status === 'active') {
      // Fetch plan summary based on your schema
      const [plans] = await mysqlConnection.execute(
        `SELECT id, name, slug, price, billing_cycle
         FROM plans
         WHERE id = ? AND is_active = TRUE`,
        [user.current_plan_id]
      );

      if (plans.length > 0) {
        // Load plan features via join
        const [planFeatures] = await mysqlConnection.execute(
          `SELECT 
            f.id, f.name, f.slug, f.category, f.description,
            pt.name AS permission, pt.label AS permission_label,
            pf.custom_value
           FROM plan_features pf
           INNER JOIN features f ON pf.feature_id = f.id
           INNER JOIN permission_types pt ON pf.permission_type_id = pt.id
           WHERE pf.plan_id = ?
           ORDER BY f.category, f.display_order, f.name`,
          [user.current_plan_id]
        );

        const featuresByCategory = {};
        for (const f of planFeatures) {
          if (!featuresByCategory[f.category]) featuresByCategory[f.category] = [];
          featuresByCategory[f.category].push({
            id: f.id,
            name: f.name,
            slug: f.slug,
            description: f.description,
            permission: f.permission,
            permissionLabel: f.permission_label,
            customValue: f.custom_value
          });
        }

        currentPlan = {
          ...plans[0],
          features: featuresByCategory,
          totalFeatures: planFeatures.length
        };
      }
    }

    // Generate token
    const token = generateToken(user.id);

    // Update last login and increment login count
    await mysqlConnection.execute(
      'UPDATE users SET last_login = NOW(), login_count = login_count + 1 WHERE id = ?',
      [user.id]
    );

    // Remove password from response
    delete user.password;

    // ------------------------------------
    // Check Parish Info
    // ------------------------------------
    let parishInfo = null;
    let isParish = false;

    const [parishRows] = await mysqlConnection.execute(
      `SELECT * FROM diocesan_parishes WHERE user_id = ?`,
      [user.id]
    );

    if (parishRows.length > 0) {
      parishInfo = parishRows[0];
      isParish = true;
    }

    // Attach to user object
    user.isParish = isParish;
    user.parishInfo = parishInfo;


    // Parse JSON fields
    user.plan_permissions = user.plan_permissions ? JSON.parse(user.plan_permissions) : null;
    user.custom_permissions = user.custom_permissions ? JSON.parse(user.custom_permissions) : null;
    user.badges = user.badges ? JSON.parse(user.badges) : null;
    user.permissions = user.permissions ? JSON.parse(user.permissions) : null;

    await ensureMemberAndMinisterCommunityPermissions(user, mysqlConnection);



    // Cookie options
    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 1 * 24 * 60 * 60 * 1000 // 1 days
    };

    // Set cookie
    // res.cookie('auth_token', token, cookieOptions);

    // Send response (without token in body)
    successResponse(res, {
      user,
      token,
      plan: currentPlan,
      planUpdated
    }, 'Login successful');

  } catch (error) {
    console.error('Login error:', error);
    errorResponse(res, 'Login failed', 500);
  }
});

// @route   GET /api/auth/profile
// @desc    Get current user profile
// @access  Private
router.get('/profile', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    // Get fresh user data with plan details
    const [users] = await mysqlConnection.execute(
      `SELECT id, first_name, last_name, email, phone, role, user_type,
       parent_user_id, current_plan_id, plan_start_date, plan_end_date, plan_status,
       plan_permissions, custom_permissions, max_sub_users, active_sub_users_count,
       bio, avatar, website_url, twitter_url, address, country, state_province,
       city, postal_code, language, timezone, badges, is_active, is_verified,publisherName,
       email_verified_at, last_login, login_count, free_trial_expires_at,
       has_upgraded, created_at, updated_at 
       FROM users WHERE id = ?`,
      [req.user.id]
    );

    if (users.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    const user = users[0];

    // Parse JSON fields
    user.plan_permissions = user.plan_permissions ? JSON.parse(user.plan_permissions) : null;
    user.custom_permissions = user.custom_permissions ? JSON.parse(user.custom_permissions) : null;
    user.badges = user.badges ? JSON.parse(user.badges) : null;

    // Get plan details if applicable
    let currentPlan = null;
    if (user.current_plan_id) {
      const [plans] = await mysqlConnection.execute(
        `SELECT id, name, slug, price, billing_cycle
         FROM plans
         WHERE id = ? AND is_active = TRUE`,
        [user.current_plan_id]
      );

      if (plans.length > 0) {
        const [planFeatures] = await mysqlConnection.execute(
          `SELECT 
            f.id, f.name, f.slug, f.category, f.description,
            pt.name AS permission, pt.label AS permission_label,
            pf.custom_value
           FROM plan_features pf
           INNER JOIN features f ON pf.feature_id = f.id
           INNER JOIN permission_types pt ON pf.permission_type_id = pt.id
           WHERE pf.plan_id = ?
           ORDER BY f.category, f.display_order, f.name`,
          [user.current_plan_id]
        );

        const featuresByCategory = {};
        for (const f of planFeatures) {
          if (!featuresByCategory[f.category]) featuresByCategory[f.category] = [];
          featuresByCategory[f.category].push({
            id: f.id,
            name: f.name,
            slug: f.slug,
            description: f.description,
            permission: f.permission,
            permissionLabel: f.permission_label,
            customValue: f.custom_value
          });
        }

        currentPlan = {
          ...plans[0],
          features: featuresByCategory,
          totalFeatures: planFeatures.length
        };
      }
    }

    successResponse(res, { user, plan: currentPlan }, 'Profile retrieved successfully');
  } catch (error) {
    console.error('Get profile error:', error);
    errorResponse(res, 'Failed to get profile', 500);
  }
});

// @route   PUT /api/auth/profile
// @desc    Update user profile
// @access  Private
router.put('/profile', auth, async (req, res) => {
  try {
    const {
      firstName, lastName, bio, phone, websiteUrl, twitterUrl, address,
      country, stateProvince, city, postalCode, language, timezone, publisherName
    } = req.body;
    const mysqlConnection = getMySQLConnection();
    // 🔹 Step 1: Fetch user & composer status
    const [userRows] = await mysqlConnection.execute(
      `SELECT id, is_composer FROM users WHERE id = ?`,
      [req.user.id]
    );

    if (userRows.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    const isComposer = Boolean(userRows[0].is_composer);

    // Note: email, role, plan fields, and other system fields are not allowed to be updated by users
    const updateFields = [];
    const updateValues = [];

    if (firstName !== undefined) {
      updateFields.push('first_name = ?');
      updateValues.push(firstName);
    }
    if (publisherName !== undefined) {
      updateFields.push('publisherName = ?');
      updateValues.push(publisherName);
    }
    if (lastName !== undefined) {
      updateFields.push('last_name = ?');
      updateValues.push(lastName);
    }
    if (bio !== undefined) {
      updateFields.push('bio = ?');
      updateValues.push(bio);
    }
    if (phone !== undefined) {
      updateFields.push('phone = ?');
      updateValues.push(phone);
    }
    if (websiteUrl !== undefined) {
      updateFields.push('website_url = ?');
      updateValues.push(websiteUrl);
    }
    if (twitterUrl !== undefined) {
      updateFields.push('twitter_url = ?');
      updateValues.push(twitterUrl);
    }
    if (address !== undefined) {
      updateFields.push('address = ?');
      updateValues.push(address);
    }
    if (country !== undefined) {
      updateFields.push('country = ?');
      updateValues.push(country);
    }
    if (stateProvince !== undefined) {
      updateFields.push('state_province = ?');
      updateValues.push(stateProvince);
    }
    if (city !== undefined) {
      updateFields.push('city = ?');
      updateValues.push(city);
    }
    if (postalCode !== undefined) {
      updateFields.push('postal_code = ?');
      updateValues.push(postalCode);
    }
    if (language !== undefined) {
      updateFields.push('language = ?');
      updateValues.push(language);
    }
    if (timezone !== undefined) {
      updateFields.push('timezone = ?');
      updateValues.push(timezone);
    }

    if (updateFields.length > 0) {
      updateFields.push('updated_at = NOW()');
      updateValues.push(req.user.id);

      await mysqlConnection.execute(
        `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`,
        updateValues
      );
    }

    // 🔹 Step 4: Sync composer_applications (ONLY if composer)
    if (isComposer && publisherName !== undefined) {
      await mysqlConnection.execute(
        `UPDATE composer_applications
         SET publisherName = ?, updated_at = NOW()
         WHERE user_id = ?`,
        [publisherName, req.user.id]
      );
    }

    // Get updated user
    const [users] = await mysqlConnection.execute(
      `SELECT id, first_name, last_name, email, phone, role, user_type,
       parent_user_id, current_plan_id, plan_start_date, plan_end_date, plan_status,
       plan_permissions, custom_permissions, max_sub_users, active_sub_users_count,
       bio, avatar, website_url, twitter_url, address, country, state_province,publisherName,
       city, postal_code, language, timezone, badges, is_active, is_verified, is_composer,
       free_trial_expires_at, has_upgraded, created_at, updated_at 
       FROM users WHERE id = ?`,
      [req.user.id]
    );

    if (users.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    const user = users[0];
    user.plan_permissions = user.plan_permissions ? JSON.parse(user.plan_permissions) : null;
    user.custom_permissions = user.custom_permissions ? JSON.parse(user.custom_permissions) : null;
    user.badges = user.badges ? JSON.parse(user.badges) : null;

    // 🔗 Re-sync to ActiveCampaign (non-blocking) — name/phone may have changed
    triggerActiveCampaignSync(mysqlConnection, req.user.id, 'profile-update');

    successResponse(res, {
      user
    }, 'Profile updated successfully');

  } catch (error) {
    console.error('Update profile error:', error);
    errorResponse(res, 'Failed to update profile', 500);
  }
});

// @route   POST /api/auth/upload-avatar
// @desc    Upload user avatar
// @access  Private
router.post('/upload-avatar', auth, avatarUpload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) {
      return errorResponse(res, 'No avatar file uploaded', 400);
    }

    const mysqlConnection = getMySQLConnection();
    const avatarUrl = req.file.location;

    // Update user's avatar in database
    await mysqlConnection.execute(
      'UPDATE users SET avatar = ?, updated_at = NOW() WHERE id = ?',
      [avatarUrl, req.user.id]
    );

    // Get updated user
    const [users] = await mysqlConnection.execute(
      `SELECT id, first_name, last_name, email, phone, role, user_type,
       bio, avatar, website_url, twitter_url, address, country, state_province,
       city, postal_code, language, timezone, badges, is_active, last_login,
       created_at, updated_at FROM users WHERE id = ?`,
      [req.user.id]
    );

    if (users.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    const user = users[0];
    user.badges = user.badges ? JSON.parse(user.badges) : null;

    successResponse(res, {
      user,
      avatarUrl
    }, 'Avatar uploaded successfully');

  } catch (error) {
    console.error('Avatar upload error:', error);
    errorResponse(res, 'Failed to upload avatar', 500);
  }
});

// @route   DELETE /api/auth/avatar
// @desc    Delete user avatar
// @access  Private
router.delete('/avatar', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    // Get current user's avatar URL
    const [users] = await mysqlConnection.execute(
      'SELECT avatar FROM users WHERE id = ?',
      [req.user.id]
    );

    if (users.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    const currentAvatar = users[0].avatar;

    if (!currentAvatar) {
      return errorResponse(res, 'No avatar to delete', 400);
    }

    // Delete avatar file from S3
    try {
      await deleteFileFromS3(currentAvatar);
      console.log(`Avatar deleted from S3: ${currentAvatar}`);
    } catch (s3Error) {
      console.error('S3 deletion error (continuing with database update):', s3Error);
    }

    // Remove avatar URL from database
    await mysqlConnection.execute(
      'UPDATE users SET avatar = NULL, updated_at = NOW() WHERE id = ?',
      [req.user.id]
    );

    // Get updated user
    const [updatedUsers] = await mysqlConnection.execute(
      `SELECT id, first_name, last_name, email, phone, role, user_type,
       bio, avatar, website_url, twitter_url, address, country, state_province,
       city, postal_code, language, timezone, badges, is_active, last_login,
       created_at, updated_at FROM users WHERE id = ?`,
      [req.user.id]
    );

    const user = updatedUsers[0];
    user.badges = user.badges ? JSON.parse(user.badges) : null;

    successResponse(res, {
      user,
      message: 'Avatar deleted successfully'
    }, 'Avatar deleted successfully');

  } catch (error) {
    console.error('Avatar deletion error:', error);
    errorResponse(res, 'Failed to delete avatar', 500);
  }
});

// @route   PUT /api/auth/reset-password
// @desc    Reset user password
// @access  Private
router.put('/reset-password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const mysqlConnection = getMySQLConnection();

    // Validate required fields
    if (!currentPassword || !newPassword || !confirmPassword) {
      return errorResponse(res, 'All fields are required: currentPassword, newPassword, confirmPassword', 400);
    }

    // Check if new password matches confirmation
    if (newPassword !== confirmPassword) {
      return errorResponse(res, 'New password and confirm password do not match', 400);
    }

    // Validate password requirements
    // const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,16}$/;
    // if (!passwordRegex.test(newPassword)) {
    //   return errorResponse(res, 'Password must be 8-16 characters with lowercase, uppercase, numeric, and special characters', 400);
    // }

    // Get current user with password
    const [users] = await mysqlConnection.execute(
      'SELECT id, password FROM users WHERE id = ?',
      [req.user.id]
    );

    if (users.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    const user = users[0];

    // Verify current password
    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password);
    if (!isCurrentPasswordValid) {
      return errorResponse(res, 'Current password is incorrect', 401);
    }

    // Hash new password
    const hashedNewPassword = await bcrypt.hash(newPassword, 12);

    // Update password in database
    await mysqlConnection.execute(
      'UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?',
      [hashedNewPassword, req.user.id]
    );

    // Get updated user (without password)
    const [updatedUsers] = await mysqlConnection.execute(
      `SELECT id, first_name, last_name, email, phone, role, user_type,
       bio, avatar, website_url, twitter_url, address, country, state_province,
       city, postal_code, language, timezone, badges, is_active, last_login,
       created_at, updated_at FROM users WHERE id = ?`,
      [req.user.id]
    );

    const updatedUser = updatedUsers[0];
    updatedUser.badges = updatedUser.badges ? JSON.parse(updatedUser.badges) : null;

    successResponse(res, {
      user: updatedUser,
      message: 'Password reset successfully'
    }, 'Password reset successfully');

  } catch (error) {
    console.error('Password reset error:', error);
    errorResponse(res, 'Failed to reset password', 500);
  }
});

// @route   POST /api/auth/forgot-password
// @desc    Generate OTP for password reset
// @access  Public
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return errorResponse(res, 'Email is required', 400);
    }

    const mysqlConnection = getMySQLConnection();

    // Find user by email
    const [users] = await mysqlConnection.execute(
      'SELECT id, first_name, last_name, email FROM users WHERE email = ? AND is_active = TRUE',
      [email]
    );

    if (users.length === 0) {
      // User not found
      return errorResponse(res, 'User does not exist with this email address', 404);
    }

    const user = users[0];

    // Generate 6-digit OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Set expiry time to 10 minutes from now
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    // Delete any existing unused OTPs for this user
    await mysqlConnection.execute(
      'DELETE FROM password_reset_otps WHERE user_id = ? AND (is_used = TRUE OR expires_at < NOW())',
      [user.id]
    );

    // Insert new OTP
    await mysqlConnection.execute(
      'INSERT INTO password_reset_otps (user_id, otp_code, expires_at) VALUES (?, ?, ?)',
      [user.id, otpCode, expiresAt]
    );

    // Clean up expired OTPs from database
    await mysqlConnection.execute(
      'DELETE FROM password_reset_otps WHERE expires_at < NOW()'
    );

    // Send OTP via email
    const emailResult = await sendOTPEmail(user.email, otpCode, user.first_name, user.email,);

    if (emailResult.success) {
      return successResponse(res, {
        message: 'OTP sent to your email address',
        expiresIn: '10 minutes'
      }, 'OTP sent successfully', 200);
    } else {
      console.error('Failed to send OTP email:', emailResult.error);
      return successResponse(res, {
        message: 'OTP generated successfully for password reset',
        otp: otpCode,
        expiresIn: '10 minutes'
      }, 'OTP generated successfully', 200);
    }

  } catch (error) {
    console.error('Forgot password error:', error);
    errorResponse(res, 'Failed to process forgot password request', 500);
  }
});

// @route   POST /api/auth/verify-otp
// @desc    Verify OTP for password reset
// @access  Public
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return errorResponse(res, 'Email and OTP are required', 400);
    }

    const mysqlConnection = getMySQLConnection();

    // Find user by email
    const [users] = await mysqlConnection.execute(
      'SELECT id, email FROM users WHERE email = ? AND is_active = TRUE',
      [email]
    );

    if (users.length === 0) {
      return errorResponse(res, 'Invalid email or OTP', 400);
    }

    const user = users[0];

    // Check if OTP exists and is valid
    const [otpRecords] = await mysqlConnection.execute(
      'SELECT id, otp_code, expires_at, is_used FROM password_reset_otps WHERE user_id = ? AND otp_code = ? AND is_used = FALSE AND expires_at > NOW()',
      [user.id, otp]
    );

    if (otpRecords.length === 0) {
      return errorResponse(res, 'Invalid or expired OTP. Please request a new OTP.', 400);
    }

    // Generate a temporary token for password reset
    const otpRecord = otpRecords[0];
    const remainingTime = Math.floor((new Date(otpRecord.expires_at) - new Date()) / 1000);
    const tokenExpiry = Math.min(remainingTime, 600);

    const resetToken = jwt.sign(
      {
        userId: user.id,
        otpId: otpRecord.id,
        purpose: 'password-reset'
      },
      process.env.JWT_SECRET || 'your-super-secret-jwt-key-for-sl-music-backend-2024',
      { expiresIn: `${tokenExpiry}s` }
    );

    successResponse(res, {
      message: 'OTP verified successfully',
      resetToken,
      expiresIn: `${Math.floor(tokenExpiry / 60)} minutes ${tokenExpiry % 60} seconds`
    }, 'OTP verified successfully', 200);

  } catch (error) {
    console.error('OTP verification error:', error);
    errorResponse(res, 'Failed to verify OTP', 500);
  }
});

// @route   POST /api/auth/update-password
// @desc    Update password using verified token
// @access  Public
router.post('/update-password', async (req, res) => {
  try {
    const { resetToken, newPassword } = req.body;

    if (!resetToken || !newPassword) {
      return errorResponse(res, 'Reset token and new password are required', 400);
    }

    if (newPassword.length < 6) {
      return errorResponse(res, 'Password must be at least 6 characters long', 400);
    }

    const mysqlConnection = getMySQLConnection();

    // Verify reset token
    let decoded;
    try {
      decoded = jwt.verify(
        resetToken,
        process.env.JWT_SECRET || 'your-super-secret-jwt-key-for-sl-music-backend-2024'
      );
    } catch (jwtError) {
      return errorResponse(res, 'Invalid or expired reset token. Please request a new OTP.', 400);
    }

    if (decoded.purpose !== 'password-reset') {
      return errorResponse(res, 'Invalid reset token', 400);
    }

    // Check if OTP is still valid and unused
    const [otpRecords] = await mysqlConnection.execute(
      'SELECT id, is_used, expires_at FROM password_reset_otps WHERE id = ? AND user_id = ? AND is_used = FALSE AND expires_at > NOW()',
      [decoded.otpId, decoded.userId]
    );

    if (otpRecords.length === 0) {
      return errorResponse(res, 'Reset session expired. Please request a new OTP.', 400);
    }

    // Mark OTP as used
    await mysqlConnection.execute(
      'UPDATE password_reset_otps SET is_used = TRUE, updated_at = NOW() WHERE id = ?',
      [decoded.otpId]
    );

    // Hash new password
    const hashedNewPassword = await bcrypt.hash(newPassword, 12);

    // Update user password
    await mysqlConnection.execute(
      'UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?',
      [hashedNewPassword, decoded.userId]
    );

    // Clean up: delete used and expired OTPs
    await mysqlConnection.execute(
      'DELETE FROM password_reset_otps WHERE is_used = TRUE OR expires_at < NOW()'
    );

    successResponse(res, {
      message: 'Password reset successfully'
    }, 'Password reset successfully', 200);

  } catch (error) {
    console.error('Password reset error:', error);
    errorResponse(res, 'Failed to reset password', 500);
  }
});

// @route   GET /api/auth/otp-stats
// @desc    Get OTP statistics (for debugging/monitoring)
// @access  Public (in production, add admin auth)
router.get('/otp-stats', async (req, res) => {
  try {
    const { getOTPStats } = require('../utils/otpCleanup');
    const stats = await getOTPStats();

    successResponse(res, {
      stats: stats,
      message: 'OTP statistics retrieved successfully'
    }, 'OTP statistics', 200);

  } catch (error) {
    console.error('OTP stats error:', error);
    errorResponse(res, 'Failed to get OTP statistics', 500);
  }
});

// @route   GET /api/auth/getDetails
// @desc    Get User Own  Details to User
// @access  Public (in production, add admin auth)
router.get('/getDetails', auth, async (req, res) => {
  try {
    const { id } = req.user; // comes from auth middleware
    const mysqlConnection = getMySQLConnection();

    // Fetch full user details
    const [users] = await mysqlConnection.execute(
      `SELECT id, first_name, last_name, email, phone, role, user_type,
       is_composer, parent_user_id, current_plan_id, plan_start_date, plan_end_date,
       plan_status, plan_permissions, custom_permissions, max_sub_users, active_sub_users_count,
       bio, avatar, website_url, twitter_url, address, country, state_province, city, postal_code,
       language, timezone, badges, is_active, is_verified, email_verified_at, last_login,publisherName,is_diocesan,
       login_count, free_trial_expires_at, permissions, has_upgraded, created_at, updated_at
       FROM users WHERE id = ?`,
      [id]
    );

    if (users.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    const user = users[0];

    // Check if user is active
    if (!user.is_active) {
      return errorResponse(res, 'Account is deactivated', 403);
    }

    // --------------------------------------------
    // PLAN EXPIRY SYNC (USERS + SUBSCRIPTIONS)
    // --------------------------------------------
    let planUpdated = false;

    if (
      user.plan_end_date &&
      new Date(user.plan_end_date) < new Date() &&
      user.plan_status === 'active'
    ) {
      console.log(`⏳ Plan expired for user ${user.id}`);

      /* -----------------------------------------
         1️⃣ Get active subscription record
      ----------------------------------------- */
      const [[activeSub]] = await mysqlConnection.execute(
        `SELECT id 
     FROM subscriptions
     WHERE user_id = ?
     AND status = 'active'
     ORDER BY id DESC
     LIMIT 1`,
        [user.id]
      );

      /* -----------------------------------------
         2️⃣ Expire subscription history
      ----------------------------------------- */
      if (activeSub) {
        await mysqlConnection.execute(
          `UPDATE subscriptions
       SET 
         status = 'expired',
         updated_at = NOW()
       WHERE id = ?`,
          [activeSub.id]
        );

        console.log(`✅ Subscription ${activeSub.id} marked as expired`);
      }

      /* -----------------------------------------
         3️⃣ Update users table
      ----------------------------------------- */
      await mysqlConnection.execute(
        `UPDATE users
     SET 
       plan_status = 'expired',
       role = 'free_user',
       updated_at = NOW()
     WHERE id = ?`,
        [user.id]
      );

      user.plan_status = 'expired';
      user.role = 'free_user';

      /* -----------------------------------------
         4️⃣ Apply FREE plan permissions
      ----------------------------------------- */
      // await applyFreePlanPermissionsToUser(mysqlConnection, user.id);

      planUpdated = true;

      console.log(`✅ User ${user.id} downgraded to free plan`);
    }

    // Free trial expiry check
    // if (
    //   user.role === 'free_user' &&
    //   user.free_trial_expires_at &&
    //   new Date(user.free_trial_expires_at) < new Date()
    // ) {
    //   user.freeTrialExpired = true;
    // }

    // Fetch plan details if user has an active plan
    let currentPlan = null;
    if (user.current_plan_id && user.plan_status === 'active') {
      const [plans] = await mysqlConnection.execute(
        `SELECT id, name, slug, price, billing_cycle
         FROM plans
         WHERE id = ? AND is_active = TRUE`,
        [user.current_plan_id]
      );

      if (plans.length > 0) {
        const [planFeatures] = await mysqlConnection.execute(
          `SELECT 
            f.id, f.name, f.slug, f.category, f.description,
            pt.name AS permission, pt.label AS permission_label,
            pf.custom_value
           FROM plan_features pf
           INNER JOIN features f ON pf.feature_id = f.id
           INNER JOIN permission_types pt ON pf.permission_type_id = pt.id
           WHERE pf.plan_id = ?
           ORDER BY f.category, f.display_order, f.name`,
          [user.current_plan_id]
        );

        const featuresByCategory = {};
        for (const f of planFeatures) {
          if (!featuresByCategory[f.category]) featuresByCategory[f.category] = [];
          featuresByCategory[f.category].push({
            id: f.id,
            name: f.name,
            slug: f.slug,
            description: f.description,
            permission: f.permission,
            permissionLabel: f.permission_label,
            customValue: f.custom_value
          });
        }

        currentPlan = {
          ...plans[0],
          features: featuresByCategory,
          totalFeatures: planFeatures.length
        };
      }
    }

    // Update last active timestamp
    await mysqlConnection.execute(
      'UPDATE users SET last_login = NOW() WHERE id = ?',
      [user.id]
    );

    // Parse JSON fields safely
    const parseJSON = (val) => {
      try {
        return val ? JSON.parse(val) : null;
      } catch {
        return null;
      }
    };

    user.plan_permissions = parseJSON(user.plan_permissions);
    user.custom_permissions = parseJSON(user.custom_permissions);
    user.badges = parseJSON(user.badges);
    user.permissions = parseJSON(user.permissions);

    await ensureMemberAndMinisterCommunityPermissions(user, mysqlConnection);

    // ------------------------------------
    // Check Parish Info
    // ------------------------------------
    let parishInfo = null;
    let isParish = false;

    const [parishRows] = await mysqlConnection.execute(
      `SELECT * FROM diocesan_parishes WHERE user_id = ?`,
      [user.id]
    );

    if (parishRows.length > 0) {
      parishInfo = parishRows[0];
      isParish = true;
    }

    user.isParish = isParish;
    user.parishInfo = parishInfo;


    // Generate token
    // const token = generateToken(user.id);

    // ✅ Send success response (no password, no re-login)
    successResponse(res, {
      user,
      // token,
      plan: currentPlan,
      planUpdated
    }, 'User details refreshed');

  } catch (error) {
    console.error('Error fetching user details:', error);
    errorResponse(res, 'Failed to fetch user details', 500);
  }
});

// @route   GET /api/auth/allusers
// @desc    Get all Users Details to Admin (with sorting + pagination)
// @access  Private (Admin)
router.get('/allusers', auth, async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    /* ======================================================
       PAGINATION
    ====================================================== */
    const page = parseInt(req.query.page) || 1;
    const limit = req.query.limit ? parseInt(req.query.limit) : null;
    const offset = limit ? (page - 1) * limit : 0;

    /* ======================================================
       SORTING (FRONTEND COMPATIBLE)
    ====================================================== */
    const sortColumn = req.query.sortColumn || "created_at";
    const sortDirection = req.query.sortDirection === "asc" ? "ASC" : "DESC";

    // 🔐 SAFE COLUMN MAPPING
    const allowedColumns = {
      first_name: "u.first_name",
      last_name: "u.last_name",
      email: "u.email",
      phone: "u.phone",
      role: "u.role",
      is_active: "u.is_active",
      created_at: "u.created_at"
    };

    const column = allowedColumns[sortColumn] || "u.created_at";

    /* ======================================================
       FILTERS (SEARCH + STATUS + ROLE/BADGE)
    ====================================================== */
    const search = req.query.search?.trim() || "";
    const statusFilter = req.query.status?.trim() || "";  // "Active" | "Inactive"
    const roleFilter = req.query.role?.trim() || "";      // "Free User" | "Composer" | "Subscription User" | "SL Team" | any badge name

    const whereClauses = [];
    const whereParams = [];

    // ── Search by name or email ──────────────────────────
    if (search) {
      whereClauses.push(
        `(u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ? OR CONCAT(u.first_name, ' ', u.last_name) LIKE ?)`
      );
      whereParams.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    // ── Status filter ────────────────────────────────────
    if (statusFilter === "Active") {
      whereClauses.push(`u.is_active = 1`);
    } else if (statusFilter === "Inactive") {
      whereClauses.push(`u.is_active = 0`);
    }

    // ── Role / Badge filter ──────────────────────────────
    if (roleFilter) {
      if (roleFilter === "Composer" || roleFilter === "composer") {
        // Composers are identified by is_composer = 1
        whereClauses.push(`u.is_composer = 1`);

      } else if (roleFilter === "Free User" || roleFilter === "free_user") {
        // Free users: role = free_user AND not a composer
        whereClauses.push(`u.role = ? AND u.is_composer = 0`);
        whereParams.push("free_user");

      } else if (roleFilter === "SL Team" || roleFilter === "sl_team") {
        whereClauses.push(`u.role = ?`);
        whereParams.push("sl_team");

        whereClauses.push(`
          NOT (
            (
              u.is_composer = 1
              OR JSON_CONTAINS(COALESCE(u.badges, '[]'), '"Review Board"', '$')
              OR JSON_CONTAINS(COALESCE(u.badges, '[]'), '"Composer"', '$')
            )
            AND NOT JSON_CONTAINS(COALESCE(u.badges, '[]'), '"Educator"', '$')
          )
        `);

      } else if (
        roleFilter === "Subscription User" ||
        roleFilter === "subscriber" ||
        roleFilter === "user"
      ) {
        // Subscription / paid users
        whereClauses.push(`u.role = ?`);
        whereParams.push("user");

      } else {
        // ── Any other value → search inside the badges JSON array ──
        // badges column stores a JSON array like: ["Editor", "Reviewer"]
        // JSON_CONTAINS checks if the array contains the value.
        // LIKE fallback handles any edge-case plain-text storage.
        whereClauses.push(
          `(JSON_CONTAINS(u.badges, ?, '$') OR u.badges LIKE ?)`
        );
        // JSON_CONTAINS needs the needle as a valid JSON string value
        whereParams.push(JSON.stringify(roleFilter), `%${roleFilter}%`);
      }
    }

    const whereSQL = whereClauses.length > 0
      ? `WHERE ${whereClauses.join(" AND ")}`
      : "";

    /* ======================================================
       AUTO EXPIRE USERS
    ====================================================== */
    const [expiredUsers] = await mysqlConnection.execute(`
      SELECT id
      FROM users
      WHERE plan_status = 'active'
        AND plan_end_date IS NOT NULL
        AND plan_end_date < NOW()
    `);

    if (expiredUsers.length > 0) {
      const expiredIds = expiredUsers.map(u => u.id);

      await mysqlConnection.execute(
        `UPDATE subscriptions
         SET status = 'expired', updated_at = NOW()
         WHERE user_id IN (${expiredIds.map(() => '?').join(',')})
           AND status = 'active'`,
        expiredIds
      );

      await mysqlConnection.execute(
        `UPDATE users
         SET plan_status = 'expired',
             role        = 'free_user',
             updated_at  = NOW()
         WHERE id IN (${expiredIds.map(() => '?').join(',')})`,
        expiredIds
      );
    }

    /* ======================================================
       TOTAL COUNT — with filters applied
    ====================================================== */
    const [countRows] = await mysqlConnection.execute(
      `SELECT COUNT(*) AS total FROM users u ${whereSQL}`,
      whereParams
    );
    const total = countRows[0].total;

    let userQuery = `
    SELECT
    u.id, u.first_name, u.last_name, u.email, u.phone, u.role, u.user_type,
    u.is_composer, u.parent_user_id, u.current_plan_id,
    u.plan_start_date, u.plan_end_date, u.plan_status,
    u.plan_permissions, u.custom_permissions,
    u.max_sub_users, u.active_sub_users_count,
    u.bio, u.avatar, u.website_url, u.twitter_url,
    u.address, u.country, u.state_province, u.city, u.postal_code,
    u.language, u.timezone, u.badges,
    u.is_active, u.is_verified, u.email_verified_at,
    u.last_login, u.login_count, u.free_trial_expires_at,
    u.permissions, u.has_upgraded, u.is_diocesan,
    u.created_at, u.updated_at,

    CASE
      WHEN dp.user_id IS NOT NULL THEN TRUE
      ELSE FALSE
    END AS is_parish

  FROM users u
  LEFT JOIN diocesan_parishes dp ON dp.user_id = u.id

  ${whereSQL}
  ORDER BY ${column} ${sortDirection}
  `;

    let queryParams = [...whereParams];

    if (limit) {
      userQuery += ` LIMIT ? OFFSET ?`;
      queryParams.push(limit, offset);
    }

    const [users] = await mysqlConnection.execute(userQuery, queryParams);
    /* ======================================================
       JSON PARSE + FORMAT
    ====================================================== */
    const parseJSON = (val) => {
      try {
        return val ? JSON.parse(val) : null;
      } catch {
        return null;
      }
    };

    const formatBadges = (badges = [], role) => {
      let parsed = typeof badges === "string" ? JSON.parse(badges) : badges;

      if (!Array.isArray(parsed)) return [];

      // ❗ Only apply logic for SL Team
      if (role !== "sl_team") {
        return parsed;
      }

      const hasEducator = parsed.includes("Educator");

      // Remove system-controlled badges
      let result = parsed.filter(
        (b) => b !== "Educator" && b !== "Composer" && b !== "Review Board"
      );

      // If has Educator badge → auto-assign Review Board + Composer
      if (hasEducator) {
        result.push("Review Board", "Composer");
      }

      return result;
    };

    const formattedUsers = users.map(user => ({
      ...user,
      plan_permissions: parseJSON(user.plan_permissions),
      custom_permissions: parseJSON(user.custom_permissions),
      badges: parseJSON(user.badges),
      newBadeges: formatBadges(user.badges, user.role),
      permissions: parseJSON(user.permissions),
    }));

    return successResponse(
      res,
      {
        users: formattedUsers,
        pagination: {
          page,
          limit,
          total,
          totalPages: limit ? Math.ceil(total / limit) : 1,
        }
      },
      'All users retrieved successfully'
    );

  } catch (error) {
    console.error('Error fetching all users:', error);
    return errorResponse(res, 'Failed to fetch all users', 500);
  }
});

// @route   GET /api/auth/user/:id
// @desc    Get single user details
// @access  Private (Admin only recommended)
router.get('/user/:id', [
  auth,
  // requireSLTeamWithTypes(['superadmin', 'admin'])
], async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const { id } = req.params;

    /* ======================================================
       🔥 1️⃣ AUTO-EXPIRE IF USER PLAN ENDED
    ====================================================== */

    const [[userRow]] = await mysqlConnection.execute(
      `SELECT * FROM users WHERE id = ?`,
      [id]
    );

    if (!userRow) {
      return errorResponse(res, 'User not found', 404);
    }

    // If plan expired -> sync user + subscription
    if (
      userRow.plan_status === 'active' &&
      userRow.plan_end_date &&
      new Date(userRow.plan_end_date) < new Date()
    ) {
      console.log(`⏳ Expiring user ${userRow.id}`);

      const [[activeSub]] = await mysqlConnection.execute(
        `SELECT id FROM subscriptions
         WHERE user_id = ? AND status = 'active'
         ORDER BY id DESC LIMIT 1`,
        [userRow.id]
      );

      if (activeSub) {
        await mysqlConnection.execute(
          `UPDATE subscriptions SET status = 'expired', updated_at = NOW() WHERE id = ?`,
          [activeSub.id]
        );
        console.log(`✅ Subscription ${activeSub.id} marked expired`);
      }

      await mysqlConnection.execute(
        `UPDATE users SET plan_status = 'expired', role = 'free_user', updated_at = NOW() WHERE id = ?`,
        [userRow.id]
      );
      console.log(`✅ User ${userRow.id} downgraded to free_user`);
    }

    /* ======================================================
       2️⃣ FETCH UPDATED USER AGAIN
    ====================================================== */

    const [[updatedUser]] = await mysqlConnection.execute(
      `SELECT * FROM users WHERE id = ?`,
      [id]
    );

    /* ======================================================
       3️⃣ FETCH SUB USERS & MANAGERS (parent_user_id = id)
    ====================================================== */

    const [subUsersAndManagers] = await mysqlConnection.execute(
      `SELECT * FROM users 
       WHERE parent_user_id = ? 
       AND user_type IN ('sub_user', 'manager')
       ORDER BY created_at DESC`,
      [id]
    );

    /* ======================================================
       4️⃣ SAFE JSON PARSE
    ====================================================== */

    const parseJSON = (val) => {
      try {
        return val ? JSON.parse(val) : null;
      } catch {
        return null;
      }
    };

    const formatUser = (user) => ({
      ...user,
      plan_permissions: parseJSON(user.plan_permissions),
      custom_permissions: parseJSON(user.custom_permissions),
      badges: parseJSON(user.badges),
      permissions: parseJSON(user.permissions)
    });

    const formattedUser = formatUser(updatedUser);

    const formattedSubUsers = subUsersAndManagers.filter(u => u.user_type === 'sub_user').map(formatUser);
    const formattedManagers = subUsersAndManagers.filter(u => u.user_type === 'manager').map(formatUser);

    return successResponse(
      res,
      {
        ...formattedUser,
        sub_users: formattedSubUsers,
        managers: formattedManagers
      },
      'User fetched successfully'
    );

  } catch (error) {
    console.error('Get user error:', error);
    return errorResponse(res, 'Failed to fetch user', 500);
  }
});

// @route   PUT /api/auth/user/:id
// @desc    Admin updates another user's profile
// @access  Private (Admin only)
router.put('/user/:id', [auth], async (req, res) => {
  try {
    const userId = req.params.id;

    const {
      firstName, lastName, bio, phone, websiteUrl, twitterUrl, address,
      country, stateProvince, city, postalCode, language, timezone,
      is_active, is_verified, is_composer, is_educator, badges, password
    } = req.body;

    const mysqlConnection = getMySQLConnection();

    /* ==============================
       1️⃣ GET USER
    ============================== */
    const [userRows] = await mysqlConnection.execute(
      `SELECT id, role FROM users WHERE id = ?`,
      [userId]
    );

    if (!userRows.length) {
      return errorResponse(res, 'User not found', 404);
    }

    const existingUser = userRows[0];

    /* ==============================
       2️⃣ UPDATE HELPER
    ============================== */
    const updateFields = [];
    const updateValues = [];

    const update = (value, column) => {
      if (value !== undefined) {
        updateFields.push(`${column} = ?`);
        updateValues.push(value);
      }
    };

    let plainPasswordToSend = null;

    if (password !== undefined) {
      if (password.length < 6) {
        return errorResponse(res, 'Password must be at least 6 characters long', 400);
      }
      plainPasswordToSend = password;
      const hashedPassword = await bcrypt.hash(password, 12);
      update(hashedPassword, 'password');
    }

    update(firstName, 'first_name');
    update(lastName, 'last_name');
    update(bio, 'bio');
    update(phone, 'phone');
    update(websiteUrl, 'website_url');
    update(twitterUrl, 'twitter_url');
    update(address, 'address');
    update(country, 'country');
    update(stateProvince, 'state_province');
    update(city, 'city');
    update(postalCode, 'postal_code');
    update(language, 'language');
    update(timezone, 'timezone');

    if (is_active !== undefined) update(is_active ? 1 : 0, 'is_active');
    if (is_verified !== undefined) update(is_verified ? 1 : 0, 'is_verified');
    if (is_composer !== undefined) update(is_composer ? 1 : 0, 'is_composer');
    if (is_educator !== undefined) update(is_educator ? 1 : 0, 'is_educator');

    /* ==============================
       3️⃣ BADGES LOGIC
    ============================== */

    if (badges !== undefined) {

      let finalRole = existingUser.role;
      let finalUserType = null;
      let finalBadges = [];
      let finalPermissions = {};

      if (Array.isArray(badges) && badges.length > 0) {

        const badgeNames = badges.map(b => b.trim()).filter(Boolean);
        const placeholders = badgeNames.map(() => '?').join(',');

        const [roles] = await mysqlConnection.execute(
          `SELECT role_name, permissions
           FROM role_permissions
           WHERE role_name IN (${placeholders})`,
          badgeNames
        );

        if (roles.length !== badgeNames.length) {
          const found = roles.map(r => r.role_name);
          const missing = badgeNames.filter(b => !found.includes(b));
          return errorResponse(res, `Invalid badge names: ${missing.join(', ')}`, 400);
        }

        finalBadges = badgeNames;

        /* -------- MERGE PERMISSIONS -------- */
        const mergePermissions = (source, target) => {
          Object.entries(source).forEach(([key, value]) => {

            if (value === 'x' || value === '-') {
              target[key] = value;
              return;
            }

            if (typeof value === 'object' && value !== null) {
              if (!target[key]) target[key] = {};
              mergePermissions(value, target[key]);
            }
          });
        };

        roles.forEach(r => {
          const perms = JSON.parse(r.permissions || '{}');
          mergePermissions(perms, finalPermissions);
        });

        /* ==========================================
           🔥 USER ROLE LOGIC (unchanged)
        ========================================== */

        if (existingUser.role === 'free_user') {
          finalRole = 'sl_team';
        }

        if (existingUser.role === 'user') {

          // Only SL Team permissions for user role
          finalRole = 'user';

          const slTeamPerms = finalPermissions['SL Team']
            ? { 'SL Team': finalPermissions['SL Team'] }
            : {};

          finalPermissions = slTeamPerms;
        }

        finalUserType = badgeNames.some(b => b.toLowerCase() === 'admin')
          ? 'admin'
          : 'sub_user';

        /* ==========================================
           🔥 IMPORTANT PART:
           If Composer badge + is_composer true
           → ADD SL Portal Composer permissions
        ========================================== */

        const hasComposerBadge = badgeNames.some(
          b => b.toLowerCase() === 'composer'
        );

        if (hasComposerBadge && is_composer === true) {

          const [composerRole] = await mysqlConnection.execute(
            `SELECT permissions FROM role_permissions WHERE role_name = 'Composer' LIMIT 1`
          );

          if (composerRole.length > 0) {
            const composerPerms = JSON.parse(composerRole[0].permissions || '{}');

            if (
              composerPerms['SL Portals'] &&
              composerPerms['SL Portals']['Composer']
            ) {

              if (!finalPermissions['SL Portals']) {
                finalPermissions['SL Portals'] = {};
              }

              finalPermissions['SL Portals']['Composer'] =
                composerPerms['SL Portals']['Composer'];
            }
          }
        }

        /* ==========================================
           ðŸ”¥ IMPORTANT PART:
           If Educator badge + is_educator true
           â†’ ADD SL Portal Educator permissions
        ========================================== */

        const hasEducatorBadge = badgeNames.some(
          b => b.toLowerCase() === 'educator'
        );

        if (hasEducatorBadge && is_educator === true) {

          const [educatorRole] = await mysqlConnection.execute(
            `SELECT permissions FROM role_permissions WHERE role_name = 'Educator' LIMIT 1`
          );

          if (educatorRole.length > 0) {
            const educatorPerms = JSON.parse(educatorRole[0].permissions || '{}');

            if (
              educatorPerms['SL Portals'] &&
              educatorPerms['SL Portals']['Educator']
            ) {

              if (!finalPermissions['SL Portals']) {
                finalPermissions['SL Portals'] = {};
              }

              finalPermissions['SL Portals']['Educator'] =
                educatorPerms['SL Portals']['Educator'];
            }
          }
        }
      }

      update(JSON.stringify(finalBadges), 'badges');
      update(JSON.stringify(finalPermissions), 'permissions');
      update(finalRole, 'role');
      update(finalUserType, 'user_type');
    }

    if (!updateFields.length) {
      return errorResponse(res, 'No fields to update', 400);
    }

    updateFields.push('updated_at = NOW()');
    updateValues.push(userId);

    /* ==============================
       4️⃣ UPDATE USER
    ============================== */
    await mysqlConnection.execute(
      `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`,
      updateValues
    );

    const [updatedUserRows] = await mysqlConnection.execute(
      'SELECT * FROM users WHERE id = ?',
      [userId]
    );

    const user = updatedUserRows[0];
    user.badges = user.badges ? JSON.parse(user.badges) : [];
    user.permissions = user.permissions ? JSON.parse(user.permissions) : {};

    if (plainPasswordToSend) {
      await sendEmail({
        to: user.email,
        subject: 'Your Simply Liturgical password has been updated',
        html: `
          <div>
            <p>Hello ${user.first_name || 'User'},</p>
    
            <p>
              Your password has been updated by an administrator at Simply Liturgical.
            </p>
    
            <p>
              Your new password is:
            </p>
    
            <p><strong>${plainPasswordToSend}</strong></p>
    
            <p>
              You can login here:
              <br/>
              ${process.env.FRONTEND_URL}
            </p>
    
            <p>
              For security reasons, please change your password after logging in.
            </p>
    
            <br/>
    
            <p>
              Thank you,<br/>
              Simply Liturgical Team
            </p>
    
            <br/>
    
            <p>
              If you did not request this change, please contact support immediately.
            </p>
          </div>
        `
      });
    }
    // ================================
    // 📩 SEND EMAIL WHEN BADGES UPDATE
    // ================================
    if (badges !== undefined && Array.isArray(badges) && badges.length > 0) {
      try {
        const { sendEmail } = require("../utils/SendMailer");

        const roleName = badges.join(", ");
        const firstName = user.first_name || "User";
        const dashboardLink = process.env.FRONTEND_URL || "https://simplyliturgical.com";
        const supportEmail = "info@slmusic.org"; // Change if required
        const effectiveDate = new Date().toLocaleDateString();

        const subject = `Your account role has been updated: ${roleName}`;

        const body = `
      <html>
        <body>
          <p>Hi ${firstName},</p>

          <p>Your Simply Liturgical account role has been updated.</p>

          <p><strong>Details:</strong></p>
          <ul>
            <li><strong>New role:</strong> ${roleName}</li>
            <li><strong>Effective date:</strong> ${effectiveDate}</li>
            <li>
              <strong>Access your dashboard:</strong><br/>
              <a href="${dashboardLink}" target="_blank">${dashboardLink}</a>
            </li>
          </ul>

          <p>
            If you believe you received this in error or need help finding
            the right tools, contact <a href="mailto:${supportEmail}">${supportEmail}</a>.
          </p>

          <p>
            God bless,<br/>
            — Simply Liturgical Team
          </p>
        </body>
      </html>
    `;

        await sendEmail({
          to: user.email,
          subject,
          html: body
        });

        console.log("✅ Role update email sent successfully");

      } catch (err) {
        console.error("⚠️ Failed to send role update email:", err);
      }
    }

    // 🔗 Re-sync to ActiveCampaign (non-blocking) — badges/role/name/phone may have changed
    triggerActiveCampaignSync(mysqlConnection, userId, 'admin-user-update');

    return successResponse(res, { user }, 'User updated successfully');

  } catch (error) {
    console.error('❌ ADMIN UPDATE USER ERROR:', error);
    return errorResponse(res, 'Failed to update user', 500);
  }
});

// @route   DELETE /api/auth/user/:id?type=soft|hard
// @desc    Delete user (Soft or Hard based on query param)
// @access  Admin Only
router.delete('/user/:id', [
  auth,
  requireSLTeamWithTypes(['superadmin', 'admin'])
], async (req, res) => {
  try {
    const userId = req.params.id;
    const deleteType = req.query.type || 'soft';
    const mysqlConnection = getMySQLConnection();

    // Step 1: Check if user exists
    const [existingUser] = await mysqlConnection.execute(
      `SELECT id, first_name, last_name, email, is_active, deleted_at FROM users WHERE id = ?`,
      [userId]
    );

    if (existingUser.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    // Step 2: Prevent user deleting themselves
    if (req.user.id == userId) {
      return errorResponse(res, 'You cannot delete your own account', 403);
    }

    // Step 3: Apply delete logic
    if (deleteType === 'hard') {
      // Hard Delete (Permanent)
      await mysqlConnection.execute(`DELETE FROM users WHERE id = ?`, [userId]);
      console.log(`User with ID ${userId} permanently deleted by admin ID ${req.user.id}`);

      return successResponse(res, null, 'User permanently deleted');
    } else {
      // Soft Delete
      await mysqlConnection.execute(
        `UPDATE users 
         SET is_active = 0, deleted_at = NOW(), updated_at = NOW() 
         WHERE id = ?`,
        [userId]
      );

      return successResponse(res, null, 'User soft deleted (disabled)');
    }

  } catch (error) {
    console.error('User delete error:', error);
    return errorResponse(res, 'Failed to delete user', 500);
  }
});

// @route   PATCH /api/auth/user/:id/restore
// @desc    Restore a soft-deleted user
// @access  Admin Only
router.put('/user/:id/restore', [
  auth,
  requireSLTeamWithTypes(['superadmin', 'admin'])
], async (req, res) => {
  try {
    const userId = req.params.id;
    const mysqlConnection = getMySQLConnection();

    // Check if user exists and deleted
    const [existingUser] = await mysqlConnection.execute(
      `SELECT id, deleted_at FROM users WHERE id = ?`,
      [userId]
    );

    if (existingUser.length === 0) {
      return errorResponse(res, 'User not found', 404);
    }

    // Check if already active
    if (!existingUser[0].deleted_at) {
      return errorResponse(res, 'User is already active', 400);
    }

    // Restore user
    await mysqlConnection.execute(
      `UPDATE users 
       SET is_active = 1, deleted_at = NULL, updated_at = NOW() 
       WHERE id = ?`,
      [userId]
    );

    // 🔗 Re-sync to ActiveCampaign (non-blocking) — their badge tags are relevant again
    triggerActiveCampaignSync(mysqlConnection, userId, 'restore');

    return successResponse(res, null, 'User restored successfully');

  } catch (error) {
    console.error('Restore user error:', error);
    return errorResponse(res, 'Failed to restore user', 500);
  }
});

// @route   POST /api/auth/invite
// @desc    Invite existing or new user to Review Board / Plan / Role
// @access  Private (SL Team/Admin)
router.post('/invite', auth, async (req, res) => {
  let user = null;

  try {
    const {
      email,          // required
      inviteLink,     // required
      plan,           // optional
      role,           // optional
      type            // "existing_user" | "new_user"
    } = req.body;

    const senderUser = req.user;
    const mysqlConnection = getMySQLConnection();

    // ✅ BASIC VALIDATION
    if (!email || !inviteLink || !type) {
      return errorResponse(
        res,
        'email, inviteLink and type are required',
        400
      );
    }

    // 🔍 FETCH EXISTING USER (ONLY IF REQUIRED)
    if (type === 'existing_user') {
      const [userResult] = await mysqlConnection.execute(
        `SELECT * FROM users WHERE email = ? LIMIT 1`,
        [email]
      );

      if (!userResult.length) {
        return errorResponse(
          res,
          'Existing user not found with this email',
          404
        );
      }

      user = userResult[0];
    }

    // 🧠 PREPARE EMAIL CONTENT
    let emailSubject = '';
    let emailBody = '';

    if (type === 'existing_user') {
      if (role) {
        emailSubject = `You're Invited for ${role.replace('_', ' ')} Role - Simply Liturgical`;
        emailBody = `
          <div style="font-family: Arial; padding:20px;">
            <h2 style="color:#0476D0;">Role Invitation 🎉</h2>
            <p>Hi <strong>${user.first_name || ''} ${user.last_name || ''}</strong>,</p>
            <p>You have been invited as <strong>${role.replace('_', ' ')}</strong>.</p>
            <a href="${inviteLink}"
              style="display:inline-block;padding:10px 20px;background:#0476D0;color:#fff;text-decoration:none;border-radius:5px;">
              Accept Invite
            </a>
            <p style="margin-top:20px;">— ${senderUser.firstName || 'Simply Liturgical Team'}</p>
          </div>
        `;
      }

      if (plan) {
        console.log(plan, "Here is the plan")
        emailSubject = `Subscription Plan Invitation – Simply Liturgical`;
        emailBody = `
          <div style="font-family: Arial, sans-serif; line-height:1.7; color:#222; max-width:600px;">      
            <p>Hi <strong>${user.first_name || 'Member'}</strong>,</p>      
            <p>
              You have been invited to join the 
              <strong>Simply Liturgical Subscription Plan</strong>.
            </p>      
            <p>
              This plan gives you access to the features and benefits included in your invitation. 
              To review the details and accept the invitation, please click the button below.
            </p>      
            <div style="margin:30px 0;">
              <a href="${inviteLink}">
                 View Plan & Accept
              </a>
            </div>      
            <p>
              We look forward to having you on board.
            </p>      
            <br/>      
            <p>
              Best regards,<br/>
              <strong>Simply Liturgical</strong><br/>
              <a href=${process.env.FRONTEND_URL}>${process.env.FRONTEND_URL}</a>
            </p>      
          </div>
        `;
      }
    }

    if (type === 'new_user') {
      emailSubject = `You're Invited to Join Simply Liturgical 🎉`;
      emailBody = `
        <div style="font-family: Arial; padding:20px;">
          <h2 style="color:#0476D0;">Welcome to Simply Liturgical 🎉</h2>
          <p>You’ve been invited to join Simply Liturgical.</p>
          <a href="${inviteLink}"
            style="display:inline-block;padding:10px 20px;background:#0476D0;color:#fff;text-decoration:none;border-radius:5px;">
            Create Account & Join
          </a>
          <p style="margin-top:20px;">— ${senderUser.firstName || 'Simply Liturgical Team'}</p>
        </div>
      `;
    }



    // 🔥 BACKGROUND JOB (NO BLOCKING)
    // setImmediate(async () => {
    try {
      await sendEmail({
        to: email,
        subject: emailSubject,
        html: emailBody
      });

      if (type === 'existing_user' && user?.id) {
        await createAndDeliverNotification({
          title: 'You have a new invitation',
          body: 'Please check your email to accept your invitation.',
          metadata: { link: inviteLink },
          channel: 'inbox',
          target: { type: 'custom', user_ids: [user.id] }
        });
      }
    } catch (err) {
      console.error('Invite async error:', err);
    }
    // });
    // ✅ IMPORTANT: SEND RESPONSE FIRST (NO WAITING)
    res.status(200).json({
      success: true,
      message: 'Invitation sent successfully',
      data: { invitedEmail: email, type, role, plan }
    });

  } catch (error) {
    console.error('Invite API error:', error);
    return errorResponse(res, 'Failed to send invitation', 500);
  }
});


// Sync ONE user's contact + role/plan tags to ActiveCampaign.
// Returns { success, contactId, email, appliedTags, failedTags } or { success:false, error }
// Shared by both the single-user and bulk-sync routes below.
async function syncUserToActiveCampaign(mysqlConnection, userId) {
  const [users] = await mysqlConnection.execute(
    `SELECT id, first_name, last_name, email, phone, badges,
            current_plan_id, plan_status
     FROM users WHERE id = ?`,
    [userId]
  );

  if (!users.length) {
    return { success: false, userId, error: 'User not found' };
  }

  const user = users[0];

  let badges = [];
  try {
    badges = user.badges ? JSON.parse(user.badges) : [];
  } catch {
    badges = [];
  }

  // Kelly's Note 1: never sync "Manager"/"Minister" badges to ActiveCampaign —
  // those are for the Subscription Admin's internal use only.
  const excludedBadgePattern = /manager|minister/i;
  const syncableBadges = badges.filter(
    (b) => b && !excludedBadgePattern.test(b)
  );

  // Resolve the user's current plan name (only if the plan is active)
  let planName = null;
  if (user.current_plan_id && user.plan_status === 'active') {
    const [plans] = await mysqlConnection.execute(
      'SELECT name FROM plans WHERE id = ? AND is_active = TRUE',
      [user.current_plan_id]
    );
    if (plans.length) planName = plans[0].name;
  }

  // Create/update the ActiveCampaign contact (upsert by email — no duplicates)
  const contact = await syncActiveCampaignContact({
    email: user.email,
    firstName: user.first_name,
    lastName: user.last_name,
    phone: user.phone,
  });

  if (!contact) {
    return { success: false, userId, email: user.email, error: 'Failed to sync contact to ActiveCampaign' };
  }

  // Resolve (or create) a tag for every badge + the plan, then attach to the contact
  const appliedTags = [];
  const failedTags = [];

  for (const badgeName of syncableBadges) {
    const tag = await getOrCreateRoleTag(mysqlConnection, badgeName);
    if (tag) {
      const ok = await addTagToActiveCampaignContact(contact.id, tag.id);
      (ok ? appliedTags : failedTags).push(badgeName);
    } else {
      failedTags.push(badgeName);
    }
  }

  if (planName) {
    const tag = await getOrCreatePlanTag(mysqlConnection, planName, user.current_plan_id);
    if (tag) {
      const ok = await addTagToActiveCampaignContact(contact.id, tag.id);
      (ok ? appliedTags : failedTags).push(planName);
    } else {
      failedTags.push(planName);
    }
  }

  return {
    success: true,
    userId: user.id,
    contactId: contact.id,
    email: user.email,
    appliedTags,
    failedTags,
  };
}

// @route   POST /api/auth/sync-active-campaign/:id
// @desc    Create/update this user's ActiveCampaign contact and apply
//          their current Role (badge) + Plan tags. Pulls the same
//          plan + badges data the login API returns.
// @access  Private (SL Team/Admin)
router.post('/sync-active-campaign/:id', [
  auth,
  requireSLTeamWithTypes(['superadmin', 'admin'])
], async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();

    const result = await syncUserToActiveCampaign(mysqlConnection, id);

    if (!result.success) {
      return errorResponse(res, result.error || 'Failed to sync user to ActiveCampaign', result.error === 'User not found' ? 404 : 502);
    }

    return successResponse(
      res,
      {
        contactId: result.contactId,
        email: result.email,
        appliedTags: result.appliedTags,
        failedTags: result.failedTags,
      },
      'User synced to ActiveCampaign'
    );
  } catch (err) {
    console.error('❌ Sync ActiveCampaign error:', err);
    return errorResponse(res, 'Failed to sync user to ActiveCampaign');
  }
});

// @route   POST /api/auth/sync-active-campaign-all
// @desc    Bulk-sync ALL users' ActiveCampaign contacts + Role/Plan tags.
//          Runs as a BACKGROUND JOB — this responds immediately with a
//          jobId (bulk syncing can easily exceed the server's 120s
//          global request timeout). Poll progress with:
//          GET /api/auth/sync-active-campaign-all/status/:jobId
//          Optional body: { onlyActive: true } → only is_active=1,
//          deleted_at IS NULL users (default: true)
// @access  Private (SL Team/Admin)
router.post('/sync-active-campaign-all', [
  auth,
  requireSLTeamWithTypes(['superadmin', 'admin'])
], async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const onlyActive = req.body?.onlyActive !== false; // default true

    const [users] = await mysqlConnection.execute(
      onlyActive
        ? `SELECT id FROM users WHERE is_active = 1 AND deleted_at IS NULL`
        : `SELECT id FROM users`
    );

    const jobId = `ac-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const job = {
      jobId,
      status: 'running', // 'running' | 'completed' | 'failed'
      total: users.length,
      processed: 0,
      succeeded: 0,
      failed: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      startedBy: req.user?.id || null,
      results: { synced: [], failed: [] },
    };
    acSyncJobs.set(jobId, job);

    // 🚀 Respond immediately — the sync itself runs after this
    successResponse(
      res,
      {
        jobId,
        total: job.total,
        statusUrl: `/api/auth/sync-active-campaign-all/status/${jobId}`,
      },
      `Bulk sync started for ${job.total} user(s). Poll the statusUrl for progress.`,
      202
    );

    // 🔄 Run the actual sync in the background (not awaited by the response above)
    setImmediate(async () => {
      console.log(`🚀 [BULK AC SYNC:${jobId}] Starting sync for ${users.length} user(s)...`);

      for (const { id: userId } of users) {
        try {
          const result = await syncUserToActiveCampaign(mysqlConnection, userId);
          job.processed += 1;

          if (result.success) {
            job.succeeded += 1;
            job.results.synced.push({
              userId: result.userId,
              email: result.email,
              appliedTags: result.appliedTags,
              failedTags: result.failedTags,
            });
          } else {
            job.failed += 1;
            job.results.failed.push({ userId, error: result.error });
          }
        } catch (userErr) {
          console.error(`❌ [BULK AC SYNC:${jobId}] Error syncing user ${userId}:`, userErr.message);
          job.processed += 1;
          job.failed += 1;
          job.results.failed.push({ userId, error: userErr.message });
        }
      }

      job.status = 'completed';
      job.finishedAt = new Date().toISOString();
      console.log(`✅ [BULK AC SYNC:${jobId}] Done. Synced ${job.succeeded}/${job.total}, failed ${job.failed}.`);
    });
  } catch (err) {
    console.error('❌ Bulk sync ActiveCampaign error:', err);
    return errorResponse(res, 'Failed to start bulk sync to ActiveCampaign');
  }
});

// @route   GET /api/auth/sync-active-campaign-all/status/:jobId
// @desc    Check progress/result of a bulk-sync job started above
// @access  Private (SL Team/Admin)
router.get('/sync-active-campaign-all/status/:jobId', [
  auth,
  requireSLTeamWithTypes(['superadmin', 'admin'])
], async (req, res) => {
  const job = acSyncJobs.get(req.params.jobId);

  if (!job) {
    return errorResponse(res, 'Job not found (it may have finished and the server since restarted)', 404);
  }

  return successResponse(res, job, 'Bulk sync job status');
});

module.exports = router;