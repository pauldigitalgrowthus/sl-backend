const express = require('express');
const { body } = require('express-validator');
const { auth } = require('../middleware/auth');
const { validate } = require('../middleware/validation');
const { successResponse, errorResponse } = require('../utils/response');
const { getMySQLConnection } = require('../config/mysql');
// const PermissionService = require('../services/PermissionService');


const router = express.Router();

// =============================================================
// 🗂️ In-memory job store for the "sync all plans' subscribers" bulk route.
// Mirrors the pattern used in auth.js's sync-active-campaign-all —
// runs in the background and is polled via a status route so it
// never hits the server's global 120s request timeout.
// Lives only in process memory (no DB change) and resets on restart.
// =============================================================
const acPlanSyncJobs = new Map();

// =============================================================
// 🏷️ ActiveCampaign Tag Helpers
// =============================================================
// Keep plans.ac_tag_id in sync with ActiveCampaign so future
// updates/deletes don't rely on matching by name (names change, IDs don't).

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

async function updateActiveCampaignTag(tagId, tagName, description) {
    if (!tagId) return null;
    try {
        const updateResponse = await fetch(`${process.env.ACTIVE_CAMPAIGN_URL}/api/3/tags/${tagId}`, {
            method: "PUT",
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

        const updateData = await updateResponse.json();

        if (updateResponse.ok) {
            return updateData.tag;
        }

        console.error(`Failed to update AC tag ${tagId}`, updateData);
        return null;
    } catch (err) {
        console.error(`Error updating AC tag ${tagId}:`, err.message);
        return null;
    }
}

async function deleteActiveCampaignTag(tagId) {
    if (!tagId) return false;
    try {
        const deleteResponse = await fetch(`${process.env.ACTIVE_CAMPAIGN_URL}/api/3/tags/${tagId}`, {
            method: "DELETE",
            headers: {
                "Api-Token": process.env.ACTIVE_CAMPAIGN_API_KEY,
                "Content-Type": "application/json",
            },
        });

        // AC returns 200/204 on success; treat 404 as "already gone" (not an error)
        if (!deleteResponse.ok && deleteResponse.status !== 404) {
            console.error(`Failed to delete AC tag ${tagId}, status: ${deleteResponse.status}`);
            return false;
        }
        return true;
    } catch (err) {
        console.error(`Error deleting AC tag ${tagId}:`, err.message);
        return false;
    }
}

// =============================================================
// 👤 ActiveCampaign Contact Sync (for users subscribed to this plan)
// =============================================================
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

        // AC returns 422 if the tag is already applied to the contact — that's fine
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

// Resolve (or create + persist) a role/badge's AC tag ID — role_permissions table
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

// Resolve (or create + persist) a plan's AC tag ID
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

// Full resync of ONE user (contact + all their current badge tags + plan tag).
// Same logic used across the codebase (auth.js / roles.js) — duplicated here
// so this route file doesn't need a cross-file import.
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

    // Never sync "Manager"/"Minister" badges to ActiveCampaign (internal-only)
    const excludedBadgePattern = /manager|minister/i;
    const syncableBadges = badges.filter((b) => b && !excludedBadgePattern.test(b));

    let planName = null;
    if (user.current_plan_id && user.plan_status === 'active') {
        const [plans] = await mysqlConnection.execute(
            'SELECT name FROM plans WHERE id = ? AND is_active = TRUE',
            [user.current_plan_id]
        );
        if (plans.length) planName = plans[0].name;
    }

    const contact = await syncActiveCampaignContact({
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        phone: user.phone,
    });

    if (!contact) {
        return { success: false, userId, email: user.email, error: 'Failed to sync contact to ActiveCampaign' };
    }

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

    return { success: true, userId: user.id, contactId: contact.id, email: user.email, appliedTags, failedTags };
}

// Re-sync every active user currently subscribed to this plan.
// Runs sequentially in the background (fire-and-forget from the caller)
// so a plan create/update/delete never blocks the actual API response.
async function syncUsersForPlan(mysqlConnection, planId) {
    try {
        const [users] = await mysqlConnection.execute(
            `SELECT id FROM users
             WHERE is_active = 1 AND deleted_at IS NULL
               AND current_plan_id = ? AND plan_status = 'active'`,
            [planId]
        );

        if (!users.length) {
            console.log(`ℹ️ [AC PLAN SYNC] No active subscribers on plan ${planId} — nothing to sync`);
            return { total: 0, succeeded: 0, failed: 0 };
        }

        console.log(`🚀 [AC PLAN SYNC] Re-syncing ${users.length} user(s) on plan ${planId}...`);

        let succeeded = 0;
        let failed = 0;

        for (const { id: userId } of users) {
            try {
                const result = await syncUserToActiveCampaign(mysqlConnection, userId);
                result.success ? succeeded++ : failed++;
            } catch (err) {
                console.error(`❌ [AC PLAN SYNC] Error syncing user ${userId}:`, err.message);
                failed++;
            }
        }

        console.log(`✅ [AC PLAN SYNC] Done for plan ${planId}. Synced ${succeeded}/${users.length}, failed ${failed}.`);
        return { total: users.length, succeeded, failed };
    } catch (err) {
        console.error(`❌ [AC PLAN SYNC] Failed to sync users for plan ${planId}:`, err.message);
        return { total: 0, succeeded: 0, failed: 0, error: err.message };
    }
}

// Fire-and-forget wrapper — call right before responding so a plan
// create/update/delete never waits on ActiveCampaign.
function triggerPlanUsersSync(mysqlConnection, planId, context = '') {
    syncUsersForPlan(mysqlConnection, planId)
        .catch((err) => console.error(`⚠️ [AC PLAN SYNC${context ? ':' + context : ''}] threw:`, err.message));
}

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
async function regenerateFreePlanPermissions(mysqlConnection) {
  try {
    const [freePlans] = await mysqlConnection.execute(
      `SELECT id FROM plans WHERE slug = 'free-account' AND is_active = TRUE LIMIT 1`
    );
    if (freePlans.length === 0) return { updated: 0 };

    const freePlanId = freePlans[0].id;

    const permissions = await generatePermissionsForPlan(freePlanId, mysqlConnection);

    const [users] = await mysqlConnection.execute(`
      SELECT id FROM users
      WHERE current_plan_id IS NULL
        OR plan_status != 'active'
        OR current_plan_id = ?
    `, [freePlanId]);

    let updated = 0;

    for (const user of users) {
      await mysqlConnection.execute(`
        UPDATE users
        SET 
          current_plan_id = ?,
          plan_status = 'free',
          plan_start_date = NOW(),
          plan_end_date = NULL,
          plan_permissions = ?
        WHERE id = ?
      `, [freePlanId, JSON.stringify(permissions), user.id]);
      updated++;
    }

    console.log(`✅ Free plan permissions updated for ${updated} users`);
    return { updated };

  } catch (err) {
    console.error("❌ Free plan regeneration error:", err.message);
    return { updated: 0 };
  }
}

async function addFreePlanPermissionsToAllPlans(mysqlConnection) {

  console.log("🔄 Syncing free plan permissions to all plans...");

  /* --------------------------------------------------
     1️⃣ GET FREE PLAN
  -------------------------------------------------- */

  const [[freePlan]] = await mysqlConnection.execute(`
    SELECT id
    FROM plans
    WHERE billing_cycle = 'free'
    LIMIT 1
  `);

  if (!freePlan) {
    console.log("❌ Free plan not found");
    return;
  }

  const freePlanId = freePlan.id;

  /* --------------------------------------------------
     2️⃣ GET FREE PLAN FEATURES
  -------------------------------------------------- */

  const [freeFeatures] = await mysqlConnection.execute(`
    SELECT feature_id, permission_type_id, custom_value
    FROM plan_features
    WHERE plan_id = ?
  `, [freePlanId]);

  if (freeFeatures.length === 0) {
    console.log("❌ Free plan has no features");
    return;
  }

  /* --------------------------------------------------
     3️⃣ GET ALL OTHER PLANS
  -------------------------------------------------- */

  const [plans] = await mysqlConnection.execute(`
    SELECT id
    FROM plans
    WHERE id != ?
  `, [freePlanId]);

  let inserted = 0;

  for (const plan of plans) {

    for (const feature of freeFeatures) {

      const [exists] = await mysqlConnection.execute(`
        SELECT id
        FROM plan_features
        WHERE plan_id = ?
        AND feature_id = ?
      `, [plan.id, feature.feature_id]);

      if (exists.length > 0) continue;

      await mysqlConnection.execute(`
        INSERT INTO plan_features (
          plan_id,
          feature_id,
          permission_type_id,
          custom_value
        )
        VALUES (?, ?, ?, ?)
      `, [
        plan.id,
        feature.feature_id,
        feature.permission_type_id,
        feature.custom_value
      ]);

      inserted++;

    }

  }

  console.log(`✅ ${inserted} free permissions added to plans`);

}

async function generatePermissionsForPlan(planId, mysqlConnection) {

  const [planFeatures] = await mysqlConnection.execute(`
    SELECT 
      f.name AS feature_name,
      f.category,
      pt.name AS permission_type,
      pf.custom_value
    FROM plan_features pf
    JOIN features f ON pf.feature_id = f.id
    JOIN permission_types pt ON pf.permission_type_id = pt.id
    WHERE pf.plan_id = ?
      AND f.is_active = TRUE
  `, [planId]);

  const permissions = {};

  planFeatures.forEach(feature => {

    if (!permissions[feature.category]) {
      permissions[feature.category] = {};
    }

    if (
      feature.permission_type === 'custom'
      || feature.permission_type === 'access-level'
    ) {

      permissions[feature.category][feature.feature_name] = {
        type: feature.permission_type,
        limit: Number(feature.custom_value) || 0,
        used: 0
      };

    } else {

      permissions[feature.category][feature.feature_name] = feature.permission_type;

    }

  });

  return permissions;
}
async function regenerateAllUserPermissions(mysqlConnection) {

  console.log("🔄 Regenerating permissions for all users...");

  const [users] = await mysqlConnection.execute(`
    SELECT id, current_plan_id
    FROM users
  `);

  let updated = 0;

  for (const user of users) {

    if (!user.current_plan_id) continue;

    const permissions = await generatePermissionsForPlan(
      user.current_plan_id,
      mysqlConnection
    );

    await mysqlConnection.execute(`
      UPDATE users
      SET plan_permissions = ?
      WHERE id = ?
    `, [
      JSON.stringify(permissions),
      user.id
    ]);

    updated++;

  }

  console.log(`✅ Updated permissions for ${updated} users`);

}

async function syncFreePlanPermissions(mysqlConnection) {

  await addFreePlanPermissionsToAllPlans(mysqlConnection)

  await regenerateAllUserPermissions(mysqlConnection)

  console.log("🎉 All plans synced with free plan permissions")

}

router.post("/admin/sync-free-plan-permissions", auth, async (req, res) => {
  try {

    const mysqlConnection = getMySQLConnection()
    await syncFreePlanPermissions(mysqlConnection)
    return successResponse(res, {}, "Free plan permissions synced to all plans")
  } catch (error) {
    console.error(error)
    return errorResponse(res, "Sync failed", 500)
  }
}
)

// ============================================
// USER ENDPOINTS (Public/Authenticated) - PLANS
// Base mount expected: /api/plans
// ============================================

// @route   GET /api/plans
// @desc    Get all active plans (for pricing page)
// @access  Public
router.get('/', async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    const [plans] = await mysqlConnection.execute(`
      SELECT 
        id,
        name,
        slug,
        description,
        price,
        billing_cycle,
        ac_tag_id,
        created_at
      FROM plans 
      WHERE is_active = TRUE 
      ORDER BY 
        FIELD(billing_cycle, 'free', 'monthly', 'yearly', 'one-time'),
        price ASC
    `);

    const plansWithTags = await Promise.all(
      plans.map(async (plan) => {
        try {
          let tag = null;

          // ----------------------------------------
          // If we already have the AC tag ID saved, fetch it directly
          // ----------------------------------------
          if (plan.ac_tag_id) {
            const getResponse = await fetch(
              `${process.env.ACTIVE_CAMPAIGN_URL}/api/3/tags/${plan.ac_tag_id}`,
              {
                headers: {
                  "Api-Token": process.env.ACTIVE_CAMPAIGN_API_KEY,
                  "Content-Type": "application/json",
                },
              }
            );

            if (getResponse.ok) {
              const getData = await getResponse.json();
              tag = getData.tag || null;
            }
          }

          // ----------------------------------------
          // Fallback: search by name (legacy plans without ac_tag_id)
          // ----------------------------------------
          if (!tag) {
            const searchResponse = await fetch(
              `${process.env.ACTIVE_CAMPAIGN_URL}/api/3/tags?search=${encodeURIComponent(
                plan.name
              )}`,
              {
                headers: {
                  "Api-Token": process.env.ACTIVE_CAMPAIGN_API_KEY,
                  "Content-Type": "application/json",
                },
              }
            );

            const searchData = await searchResponse.json();

            if (
              searchResponse.ok &&
              Array.isArray(searchData.tags) &&
              searchData.tags.length
            ) {
              tag = searchData.tags.find(
                (t) => t.tag.toLowerCase() === plan.name.toLowerCase()
              );
            }
          }

          // ----------------------------------------
          // Create tag if still not found
          // ----------------------------------------
          if (!tag) {
            tag = await createActiveCampaignTag(plan.name, `Plan: ${plan.name}`);
          }

          // ----------------------------------------
          // Persist the tag ID so future requests skip the search
          // ----------------------------------------
          if (tag && tag.id != plan.ac_tag_id) {
            await mysqlConnection.execute(
              "UPDATE plans SET ac_tag_id = ? WHERE id = ?",
              [tag.id, plan.id]
            );
            plan.ac_tag_id = tag.id;
          }

          return {
            ...plan,
            activeCampaignTag: tag || null,
          };
        } catch (err) {
          console.error(`Error processing plan ${plan.name}:`, err);

          return {
            ...plan,
            activeCampaignTag: null,
          };
        }
      })
    );

    return successResponse(
      res,
      { plans: plansWithTags },
      "Plans retrieved successfully"
    );
  } catch (error) {
    console.error("Get plans error:", error);
    return errorResponse(res, "Failed to retrieve plans", 500);
  }
});

// @route   GET /api/plans/slug/:slug
// @desc    Get plan by slug
// @access  Public
router.get('/slug/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const mysqlConnection = getMySQLConnection();

    const [plans] = await mysqlConnection.execute(`
      SELECT 
        id,
        name,
        slug,
        description,
        price,
        billing_cycle,
        created_at
      FROM plans 
      WHERE slug = ? AND is_active = TRUE
    `, [slug]);

    if (plans.length === 0) {
      return errorResponse(res, 'Plan not found', 404);
    }

    successResponse(res, { plan: plans[0] }, 'Plan retrieved successfully');
  } catch (error) {
    console.error('Get plan by slug error:', error);
    errorResponse(res, 'Failed to retrieve plan', 500);
  }
});

// @route   GET /api/plans/:id
// @desc    Get single plan details
// @access  Public
router.get('/:id(\\d+)', async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();

    const [plans] = await mysqlConnection.execute(`
      SELECT 
        id,
        name,
        slug,
        description,
        price,
        billing_cycle,
        created_at
      FROM plans 
      WHERE id = ? AND is_active = TRUE
    `, [id]);

    if (plans.length === 0) {
      return errorResponse(res, 'Plan not found', 404);
    }

    successResponse(res, { plan: plans[0] }, 'Plan retrieved successfully');
  } catch (error) {
    console.error('Get plan error:', error);
    errorResponse(res, 'Failed to retrieve plan', 500);
  }
});

// @route   GET /api/plans/:planId/features
// @desc    Get all features for a specific plan
// @access  Public
router.get('/:planId(\\d+)/features', async (req, res) => {
  try {
    const { planId } = req.params;
    const mysqlConnection = getMySQLConnection();

    // Check if plan exists
    const [plans] = await mysqlConnection.execute(
      'SELECT id, name FROM plans WHERE id = ? AND is_active = TRUE',
      [planId]
    );

    if (plans.length === 0) {
      return errorResponse(res, 'Plan not found', 404);
    }

    // Get plan features with permissions
    const [features] = await mysqlConnection.execute(`
      SELECT 
        f.id,
        f.name,
        f.slug,
        f.category,
        f.description,
        f.display_order,
        pt.name as permission,
        pt.label as permission_label,
        pf.custom_value
      FROM plan_features pf
      INNER JOIN features f ON pf.feature_id = f.id
      INNER JOIN permission_types pt ON pf.permission_type_id = pt.id
      WHERE pf.plan_id = ? 
        AND f.is_active = TRUE 
        AND pt.name != '-'
      ORDER BY f.category, f.display_order, f.name
    `, [planId]);

    // Build feature tree by category
    const featureTree = {};
    features.forEach(feature => {
      if (!featureTree[feature.category]) {
        featureTree[feature.category] = [];
      }
      featureTree[feature.category].push({
        id: feature.id,
        name: feature.name,
        slug: feature.slug,
        description: feature.description,
        permission: feature.permission,
        permissionLabel: feature.permission_label,
        customValue: feature.custom_value
      });
    });

    successResponse(res, {
      plan: plans[0],
      features: featureTree,
      totalFeatures: features.length
    }, 'Plan features retrieved successfully');
  } catch (error) {
    console.error('Get plan features error:', error);
    errorResponse(res, 'Failed to retrieve plan features', 500);
  }
});

// @route   GET /api/plans/compare/:planIds
// @desc    Compare multiple plans
// @access  Public
router.get('/compare/:planIds([0-9,]+)', async (req, res) => {
  try {
    const { planIds } = req.params;
    const ids = planIds.split(',').map(id => parseInt(id)).filter(id => !isNaN(id));

    if (ids.length === 0) {
      return errorResponse(res, 'Valid plan IDs are required', 400);
    }

    const mysqlConnection = getMySQLConnection();

    // ✅ Dynamic placeholders for IN()
    const placeholders = ids.map(() => '?').join(',');

    // ✅ Get plans
    const [plans] = await mysqlConnection.execute(`
      SELECT id, name, slug, description, price, billing_cycle
      FROM plans 
      WHERE id IN (${placeholders}) AND is_active = TRUE
    `, ids);

    if (plans.length === 0) {
      return errorResponse(res, 'No plans found', 404);
    }

    // ✅ Get features for those plans
    const [features] = await mysqlConnection.execute(`
      SELECT 
        pf.plan_id,
        f.name AS feature_name,
        f.slug AS feature_slug,
        f.category,
        pt.name AS permission,
        pt.label AS permission_label
      FROM plan_features pf
      INNER JOIN features f ON pf.feature_id = f.id
      INNER JOIN permission_types pt ON pf.permission_type_id = pt.id
      WHERE pf.plan_id IN (${placeholders}) AND f.is_active = TRUE
      ORDER BY f.category, f.display_order
    `, ids);

    // ✅ Organize comparison data
    const comparison = plans.map(plan => {
      const planFeatures = features.filter(f => f.plan_id === plan.id);
      const featuresByCategory = {};

      planFeatures.forEach(feature => {
        if (!featuresByCategory[feature.category]) {
          featuresByCategory[feature.category] = [];
        }
        featuresByCategory[feature.category].push({
          name: feature.feature_name,
          slug: feature.feature_slug,
          permission: feature.permission,
          permissionLabel: feature.permission_label
        });
      });

      return {
        ...plan,
        features: featuresByCategory,
        totalFeatures: planFeatures.length
      };
    });

    successResponse(res, { comparison }, 'Plans comparison retrieved successfully');
  } catch (error) {
    console.error('Compare plans error:', error);
    errorResponse(res, 'Failed to compare plans', 500);
  }
});
// ============================================
// ADMIN ENDPOINTS - PLANS CRUD
// Base mount expected: /api/plans
// ============================================

// @route   GET /api/plans/admin/all
// @desc    Get all plans (including inactive) for admin
// @access  Private (Admin only)
router.get('/admin/all', [auth, isAdmin], async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    const [plans] = await mysqlConnection.execute(`
      SELECT 
        p.*,
        COUNT(DISTINCT  us.id) as active_users,
        COUNT(DISTINCT pf.feature_id) as total_features
      FROM plans p
      LEFT JOIN users us ON p.id = us.current_plan_id AND us.plan_status = 'active'
      LEFT JOIN plan_features pf ON p.id = pf.plan_id
      GROUP BY p.id
      ORDER BY 
        FIELD(p.billing_cycle, 'free', 'monthly', 'yearly', 'one-time'),
        p.price ASC
    `);

    successResponse(res, {
      plans,
      total: plans.length
    }, 'All plans retrieved successfully');
  } catch (error) {
    console.error('Get all plans error:', error);
    errorResponse(res, 'Failed to retrieve plans', 500);
  }
});

// @route   POST /api/plans/admin/create
// @desc    Create new plan
// @access  Private (Admin only)
const slugify = require('slugify');
router.post('/admin/create', [
  auth,
  // isAdmin,
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Plan name is required')
    .isLength({ min: 3, max: 100 })
    .withMessage('Plan name must be between 3 and 100 characters'),
  body('description')
    .optional()
    .trim(),
  body('price')
    .isFloat({ min: 0 })
    .withMessage('Price must be a positive number'),
  body('billing_cycle')
    .isIn(['free', 'monthly', 'yearly', 'one-time'])
    .withMessage('Invalid billing cycle')
], validate, async (req, res) => {
  try {
    const { name, description, price, billing_cycle } = req.body;
    const mysqlConnection = getMySQLConnection();

    // ✅ Auto-generate slug from plan name
    let slug = slugify(name, {
      lower: true,
      strict: true // removes special characters
    });

    // ✅ Ensure uniqueness by appending a number if slug already exists
    const [existing] = await mysqlConnection.execute(
      'SELECT COUNT(*) as count FROM plans WHERE slug = ?',
      [slug]
    );

    if (existing[0].count > 0) {
      slug = `${slug}-${Date.now()}`; // e.g. premium-yearly-plan-1738938171289
    }

    // ✅ Insert new plan
    const [result] = await mysqlConnection.execute(`
      INSERT INTO plans (name, slug, description, price, billing_cycle, is_active)
      VALUES (?, ?, ?, ?, ?, TRUE)
    `, [name, slug, description || null, price, billing_cycle]);

    // 🏷️ Create matching ActiveCampaign tag & store its ID against this plan
    try {
      const activeCampaignTag = await createActiveCampaignTag(name, `Plan: ${name}`);

      if (activeCampaignTag) {
        await mysqlConnection.execute(
          'UPDATE plans SET ac_tag_id = ? WHERE id = ?',
          [activeCampaignTag.id, result.insertId]
        );
      }
    } catch (acError) {
      console.error('❌ Failed to create ActiveCampaign tag for plan:', acError.message);
      // Don't fail the request, just log the error
    }

    // ✅ Fetch the created plan
    const [newPlan] = await mysqlConnection.execute(
      'SELECT * FROM plans WHERE id = ?',
      [result.insertId]
    );

    // 🔗 Re-sync (non-blocking) — a brand-new plan has no subscribers yet,
    // but this keeps create/update/delete consistent and covers any edge
    // case where users were pre-assigned this plan id in the same request batch.
    triggerPlanUsersSync(mysqlConnection, result.insertId, 'plan-create');

    successResponse(res, {
      plan: newPlan[0]
    }, 'Plan created successfully', 201);

  } catch (error) {
    console.error('Create plan error:', error);
    errorResponse(res, 'Failed to create plan', 500);
  }
});


// @route   PUT /api/plans/admin/update/:id
// @desc    Update plan
// @access  Private (Admin only)
router.put('/admin/update/:id(\\d+)', [
  auth,
  // isAdmin,
  body('name')
    .optional()
    .trim()
    .notEmpty()
    .isLength({ min: 3, max: 100 })
    .withMessage('Plan name must be between 3 and 100 characters'),
  body('description').optional().trim(),
  body('price')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Price must be a positive number'),
  body('billing_cycle')
    .optional()
    .isIn(['free', 'monthly', 'yearly', 'one-time'])
    .withMessage('Invalid billing cycle'),
  body('is_active')
    .optional()
    .isBoolean()
], validate, async (req, res) => {
  try {
    const { id } = req.params;
    let { name, description, price, billing_cycle, is_active } = req.body;
    const mysqlConnection = getMySQLConnection();

    // Convert boolean string to integer (0/1)
    if (typeof is_active !== "undefined") {
      is_active = (is_active === true || is_active === "true") ? 1 : 0;
    }

    // Check if plan exists
    const [plans] = await mysqlConnection.execute(
      'SELECT * FROM plans WHERE id = ?',
      [id]
    );

    if (plans.length === 0) {
      return errorResponse(res, 'Plan not found', 404);
    }

    const currentPlan = plans[0];
    let slug = currentPlan.slug;

    // Auto-generate slug only if name changed
    if (name && name !== currentPlan.name) {
      slug = slugify(name, { lower: true, strict: true });

      const [existing] = await mysqlConnection.execute(
        'SELECT id FROM plans WHERE slug = ? AND id != ?',
        [slug, id]
      );

      if (existing.length > 0) {
        slug = `${slug}-${Date.now()}`;
      }
    }

    // Dynamic update builder
    const updates = [];
    const values = [];

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }

    if (slug !== undefined) {
      updates.push('slug = ?');
      values.push(slug);
    }

    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description);
    }

    if (price !== undefined) {
      updates.push('price = ?');
      values.push(price);
    }

    if (billing_cycle !== undefined) {
      updates.push('billing_cycle = ?');
      values.push(billing_cycle);
    }

    if (is_active !== undefined) {
      updates.push('is_active = ?');
      values.push(is_active);
    }

    if (updates.length === 0) {
      return errorResponse(res, 'No fields to update', 400);
    }

    updates.push('updated_at = NOW()');
    values.push(id);

    // Execute update
    await mysqlConnection.execute(
      `UPDATE plans SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    // 🏷️ Keep the ActiveCampaign tag in sync if the plan was renamed
    if (name !== undefined && name !== currentPlan.name) {
      try {
        if (currentPlan.ac_tag_id) {
          await updateActiveCampaignTag(currentPlan.ac_tag_id, name, `Plan: ${name}`);
        } else {
          // No tag was ever linked — create one now and save its ID
          const newTag = await createActiveCampaignTag(name, `Plan: ${name}`);
          if (newTag) {
            await mysqlConnection.execute(
              'UPDATE plans SET ac_tag_id = ? WHERE id = ?',
              [newTag.id, id]
            );
          }
        }
      } catch (acError) {
        console.error('❌ Failed to sync ActiveCampaign tag on plan rename:', acError.message);
        // Don't fail the request, just log the error
      }
    }

    // Return updated plan
    const [updatedPlan] = await mysqlConnection.execute(
      'SELECT * FROM plans WHERE id = ?',
      [id]
    );

    // 🔗 Re-sync every active subscriber on this plan to ActiveCampaign (non-blocking)
    triggerPlanUsersSync(mysqlConnection, id, 'plan-update');

    return successResponse(res, {
      plan: updatedPlan[0]
    }, 'Plan updated successfully');

  } catch (error) {
    console.error('Update plan error:', error);
    return errorResponse(res, 'Failed to update plan', 500);
  }
});


// @route   DELETE /api/plans/admin/delete/:id
// @desc    Delete plan (soft delete by setting is_active = false)
// @access  Private (Admin only)
router.delete('/admin/delete/:id(\\d+)', [auth, isAdmin], async (req, res) => {
  const pool = getMySQLConnection();
  const { id } = req.params;
  const { force } = req.query; // ?force=true for hard delete

  try {
    // ✅ Check if plan exists
    const [plans] = await pool.execute(
      'SELECT id, name, is_active, ac_tag_id FROM plans WHERE id = ?',
      [id]
    );

    if (plans.length === 0) {
      return errorResponse(res, 'Plan not found', 404);
    }

    const plan = plans[0];

    // ✅ Check if any user is using this plan
    const [users] = await pool.execute(
      'SELECT COUNT(*) as count FROM users WHERE current_plan_id = ? AND plan_status = "active"',
      [id]
    );

    const activeUsers = users[0].count;
    if (activeUsers > 0) {
      console.log(`Cannot delete plan "${plan.name}". ${activeUsers} active user(s) are currently subscribed.`);
    }


    // ✅ Hard delete (force=true) using a transaction connection
    if (force === 'true') {

      if (activeUsers > 0) {
        return errorResponse(
          res,
          `Cannot delete plan "${plan.name}". ${activeUsers} active user(s) are currently subscribed.`,
          400
        );
      }
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        await conn.execute('DELETE FROM plan_features WHERE plan_id = ?', [id]);
        await conn.execute('DELETE FROM plans WHERE id = ?', [id]);

        await conn.commit();

        // 🏷️ Plan is permanently gone — remove its ActiveCampaign tag too
        // (soft delete/deactivate on the other hand keeps the tag, since the
        // plan could still be reactivated)
        if (plan.ac_tag_id) {
          const deleted = await deleteActiveCampaignTag(plan.ac_tag_id);
          if (!deleted) {
            console.error(`⚠️ Could not delete AC tag ${plan.ac_tag_id} for plan "${plan.name}" — continuing anyway`);
          }
        }

        return successResponse(
          res,
          { deletedId: id },
          `Plan "${plan.name}" permanently deleted`
        );
      } catch (err) {
        try { await conn.rollback(); } catch { }
        throw err;
      } finally {
        conn.release();
      }
    }

    // ✅ Soft delete (default)
    if (!plan.is_active) {
      return successResponse(res, { id }, 'Plan is already inactive');
    }

    await pool.execute(
      'UPDATE plans SET is_active = FALSE, updated_at = NOW() WHERE id = ?',
      [id]
    );

    // 🔗 Re-sync any users still pointing at this plan (non-blocking) —
    // refreshes their contact/badge tags; the plan tag itself won't be
    // re-applied since the plan is now inactive.
    triggerPlanUsersSync(pool, id, 'plan-deactivate');

    successResponse(
      res,
      { deactivatedId: id },
      `Plan "${plan.name}" deactivated successfully`
    );

  } catch (error) {
    console.error('Delete plan error:', error);
    errorResponse(res, 'Failed to delete plan', 500);
  }
});

// @route   GET /api/plans/admin/inactive
// @desc    Get all inactive plans (admin only)
// @access  Private (Admin only)
router.get('/admin/inactive', [auth, isAdmin], async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const [plans] = await mysqlConnection.execute(`
      SELECT id, name, slug, description, price, billing_cycle, is_active, created_at, updated_at FROM plans WHERE is_active = 
      FALSE ORDER BY FIELD(billing_cycle, 'free', 'monthly', 'yearly', 'one-time'), price ASC    `);

    successResponse(res, { plans }, 'Inactive plans retrieved successfully');
  } catch (error) {
    console.error('Get inactive plans error:', error);
    errorResponse(res, 'Failed to retrieve inactive plans', 500);
  }
});


// @route   PATCH /api/plans/admin/activate/:id
// @desc    Activate a plan (set is_active = true)
// @access  Private (Admin only)
router.put('/admin/activate/:id(\\d+)', [auth, isAdmin], async (req, res) => {
  const pool = getMySQLConnection();
  const { id } = req.params;
  try {
    const [plans] = await pool.execute(
      'SELECT id, name, is_active FROM plans WHERE id = ?',
      [id]
    );
    if (plans.length === 0) {
      return errorResponse(res, 'Plan not found', 404);
    }
    const plan = plans[0];
    // ✅ Already active
    if (plan.is_active) {
      return successResponse(res, { id }, `Plan "${plan.name}" is already active`);
    }

    // ✅ Activate plan
    await pool.execute('UPDATE plans SET is_active = TRUE, updated_at = NOW() WHERE id = ?', [id]);

    // 🔗 Re-sync subscribers so the plan tag is applied again (non-blocking)
    triggerPlanUsersSync(pool, id, 'plan-activate');

    successResponse(res, { activatedId: id }, `Plan "${plan.name}" activated successfully`);

  } catch (error) {
    console.error('Activate plan error:', error);
    errorResponse(res, 'Failed to activate plan', 500);
  }
});


// @route   POST /api/plans/admin/duplicate/:id
// @desc    Duplicate existing plan with all features
// @access  Private (Admin only)
router.post('/admin/duplicate/:id(\\d+)', [auth, isAdmin], async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();

    // ✅ Fetch original plan
    const [originalPlan] = await mysqlConnection.execute(
      'SELECT * FROM plans WHERE id = ?',
      [id]
    );

    if (originalPlan.length === 0) {
      return errorResponse(res, 'Plan not found', 404);
    }

    const plan = originalPlan[0];

    // ✅ Generate new name and slug
    const newName = `${plan.name} (Copy)`;
    let newSlug = slugify(newName, { lower: true, strict: true });

    // ✅ Ensure slug uniqueness
    const [existing] = await mysqlConnection.execute(
      'SELECT COUNT(*) as count FROM plans WHERE slug = ?',
      [newSlug]
    );

    if (existing[0].count > 0) {
      newSlug = `${newSlug}-${Date.now()}`;
    }

    // ✅ Insert duplicated plan (inactive by default)
    const [result] = await mysqlConnection.execute(`
      INSERT INTO plans (name, slug, description, price, billing_cycle, is_active)
      VALUES (?, ?, ?, ?, ?, FALSE)
    `, [newName, newSlug, plan.description || null, plan.price, plan.billing_cycle]);

    const newPlanId = result.insertId;

    // ✅ Copy all features
    await mysqlConnection.execute(`
      INSERT INTO plan_features (plan_id, feature_id, permission_type_id, custom_value)
      SELECT ?, feature_id, permission_type_id, custom_value
      FROM plan_features
      WHERE plan_id = ?
    `, [newPlanId, id]);

    // ✅ Fetch duplicated plan with feature count
    const [newPlan] = await mysqlConnection.execute(`
      SELECT 
        p.*,
        COUNT(pf.feature_id) as total_features
      FROM plans p
      LEFT JOIN plan_features pf ON p.id = pf.plan_id
      WHERE p.id = ?
      GROUP BY p.id
    `, [newPlanId]);

    successResponse(res, {
      plan: newPlan[0]
    }, 'Plan duplicated successfully', 201);

  } catch (error) {
    console.error('Duplicate plan error:', error);
    errorResponse(res, 'Failed to duplicate plan', 500);
  }
});


// @route   GET /api/plans/admin/statistics
// @desc    Get plan statistics
// @access  Private (Admin only)
router.get('/admin/statistics', [auth, isAdmin], async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    // Get various statistics
    const [totalPlans] = await mysqlConnection.execute(
      'SELECT COUNT(*) as count FROM plans WHERE is_active = TRUE'
    );

    const [activePlansWithUsers] = await mysqlConnection.execute(`
      SELECT 
        p.id,
        p.name,
        p.slug,
        p.price,
        p.billing_cycle,
        COUNT(DISTINCT u.id) as total_users,
        SUM(CASE WHEN u.plan_status = 'active' THEN 1 ELSE 0 END) as active_users
      FROM plans p
      LEFT JOIN users u ON p.id = u.current_plan_id
      WHERE p.is_active = TRUE
      GROUP BY p.id
      ORDER BY active_users DESC
    `);

    const [revenueByPlan] = await mysqlConnection.execute(`
      SELECT 
        p.name as plan_name,
        p.price,
        p.billing_cycle,
        COUNT(u.id) as subscriber_count,
        (p.price * COUNT(u.id)) as estimated_revenue
      FROM plans p
      LEFT JOIN users u ON p.id = u.current_plan_id AND u.plan_status = 'active'
      WHERE p.is_active = TRUE AND p.price > 0
      GROUP BY p.id
      ORDER BY estimated_revenue DESC
    `);

    successResponse(res, {
      totalPlans: totalPlans[0].count,
      planDistribution: activePlansWithUsers,
      revenueAnalysis: revenueByPlan
    }, 'Plan statistics retrieved successfully');
  } catch (error) {
    console.error('Get plan statistics error:', error);
    errorResponse(res, 'Failed to retrieve statistics', 500);
  }
});

// ============================================
// PUBLIC/USER ENDPOINTS - FEATURES
// These are namespaced under /api/plans/features
// ============================================

// @route   GET /api/plans/features
// @desc    Get all active features (grouped by category)
// @access  Public
router.get('/features', async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    const [features] = await mysqlConnection.execute(`
      SELECT 
        id,
        name,
        slug,
        category,
        parent_id,
        description,
        display_order
      FROM features 
      WHERE is_active = TRUE 
      ORDER BY category, display_order, name
    `);

    // Group by category
    const groupedFeatures = {};
    features.forEach(feature => {
      if (!groupedFeatures[feature.category]) {
        groupedFeatures[feature.category] = [];
      }
      groupedFeatures[feature.category].push(feature);
    });

    successResponse(res, {
      features: groupedFeatures,
      totalFeatures: features.length,
      categories: Object.keys(groupedFeatures)
    }, 'Features retrieved successfully');
  } catch (error) {
    console.error('Get features error:', error);
    errorResponse(res, 'Failed to retrieve features', 500);
  }
});

// @route   GET /api/plans/features/category/:category
// @desc    Get features by category
// @access  Public
router.get('/features/category/:category', async (req, res) => {
  try {
    const { category } = req.params;
    const mysqlConnection = getMySQLConnection();

    const [features] = await mysqlConnection.execute(`
      SELECT 
        id,
        name,
        slug,
        category,
        parent_id,
        description,
        display_order
      FROM features 
      WHERE category = ? AND is_active = TRUE 
      ORDER BY display_order, name
    `, [category]);

    if (features.length === 0) {
      return errorResponse(res, 'No features found in this category', 404);
    }

    successResponse(res, {
      category,
      features,
      total: features.length
    }, 'Category features retrieved successfully');
  } catch (error) {
    console.error('Get features by category error:', error);
    errorResponse(res, 'Failed to retrieve features', 500);
  }
});

// @route   GET /api/plans/features/:id
// @desc    Get single feature details
// @access  Public
router.get('/features/:id(\\d+)', async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();

    const [features] = await mysqlConnection.execute(`
      SELECT 
        f.*,
        CASE 
          WHEN f.parent_id IS NOT NULL THEN 
            (SELECT name FROM features WHERE id = f.parent_id)
          ELSE NULL
        END as parent_name
      FROM features f
      WHERE f.id = ? AND f.is_active = TRUE
    `, [id]);

    if (features.length === 0) {
      return errorResponse(res, 'Feature not found', 404);
    }

    // Get child features if any
    const [children] = await mysqlConnection.execute(`
      SELECT id, name, slug, description
      FROM features
      WHERE parent_id = ? AND is_active = TRUE
      ORDER BY display_order
    `, [id]);

    successResponse(res, {
      feature: {
        ...features[0],
        children: children
      }
    }, 'Feature retrieved successfully');
  } catch (error) {
    console.error('Get feature error:', error);
    errorResponse(res, 'Failed to retrieve feature', 500);
  }
});

// @route   GET /api/plans/features/slug/:slug
// @desc    Get feature by slug
// @access  Public
router.get('/features/slug/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const mysqlConnection = getMySQLConnection();

    const [features] = await mysqlConnection.execute(`
      SELECT * FROM features 
      WHERE slug = ? AND is_active = TRUE
    `, [slug]);

    if (features.length === 0) {
      return errorResponse(res, 'Feature not found', 404);
    }

    successResponse(res, {
      feature: features[0]
    }, 'Feature retrieved successfully');
  } catch (error) {
    console.error('Get feature by slug error:', error);
    errorResponse(res, 'Failed to retrieve feature', 500);
  }
});

// ============================================
// ADMIN ENDPOINTS - FEATURES
// Base mount expected: /api/plans/features/admin
// ============================================

// @route   GET /api/plans/features/admin/all
// @desc    Get all features (including inactive) for admin
// @access  Private (Admin only)
router.get('/features/admin/all', [auth], async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    const [features] = await mysqlConnection.execute(`
      SELECT 
        f.*,
        COUNT(DISTINCT pf.plan_id) as used_in_plans,
        CASE 
          WHEN f.parent_id IS NOT NULL THEN 
            (SELECT name FROM features WHERE id = f.parent_id)
          ELSE NULL
        END as parent_name
      FROM features f
      LEFT JOIN plan_features pf ON f.id = pf.feature_id
      GROUP BY f.id
      ORDER BY f.category, f.display_order, f.name
    `);

    // Group by category
    const groupedFeatures = {};
    features.forEach(feature => {
      if (!groupedFeatures[feature.category]) {
        groupedFeatures[feature.category] = [];
      }
      groupedFeatures[feature.category].push(feature);
    });

    successResponse(res, {
      features: groupedFeatures,
      totalFeatures: features.length,
      categories: Object.keys(groupedFeatures)
    }, 'All features retrieved successfully');
  } catch (error) {
    console.error('Get all features error:', error);
    errorResponse(res, 'Failed to retrieve features', 500);
  }
});


// ============================================
// ADMIN ENDPOINTS - PLAN FEATURES CRUD
// Base mount expected: /api/plans
// ============================================

// @route   POST /api/plans/admin/:planId/features/add
// @desc    Add feature to plan with permission
// @access  Private (Admin only)
router.post('/admin/:planId(\\d+)/features/add', [
  auth,
  // isAdmin,
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
  try {
    const { planId } = req.params;
    const { feature_id, permission_type_id, custom_value } = req.body;
    const mysqlConnection = getMySQLConnection();

    // Check if plan exists
    const [plans] = await mysqlConnection.execute(
      'SELECT * FROM plans WHERE id = ?',
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

    console.log('Not Regenerating permissions for added feature to plan users');
    // ⭐ REGENERATE PERMISSIONS for existing users with this plan
    // console.log(`🔄 Regenerating permissions for plan ${planId} users after feature addition...`);
    // const regenerationResult = await regeneratePermissionsForPlanUsers(planId, mysqlConnection);

    let regenerationResult = "Not Reflect Changes on user which have use plan"
    if (plans[0].slug === "free-account") {
      regenerationResult = await regenerateFreePlanPermissions(mysqlConnection);
    }

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
    console.error('Add feature to plan error:', error);
    errorResponse(res, 'Failed to add feature to plan', 500);
  }
});

// @route   PUT /api/plans/admin/:planId/features/:featureId/update
// @desc    Update feature permission in plan
// @access  Private (Admin only)
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

    // Check if plan exists
    const [plans] = await mysqlConnection.execute(
      'SELECT * FROM plans WHERE id = ?',
      [planId]
    );

    if (plans.length === 0) {
      return errorResponse(res, 'Plan not found', 404);
    }

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
    let regenerationResult = "Not Reflect Changes on user which have use plan"
    console.log(plans);
    if (plans[0].slug === "free-account") {
      regenerationResult = await regenerateFreePlanPermissions(mysqlConnection);
    }

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
    console.error('Update plan feature error:', error);
    errorResponse(res, 'Failed to update plan feature', 500);
  }
});

// @route   DELETE /api/plans/admin/:planId/features/:featureId/remove
// @desc    Remove feature from plan
// @access  Private (Admin only)
router.delete('/admin/:planId(\\d+)/features/:featureId(\\d+)/remove', [auth, isAdmin], async (req, res) => {
  try {
    const { planId, featureId } = req.params;
    const mysqlConnection = getMySQLConnection();

    // Check if plan exists
    const [plans] = await mysqlConnection.execute(
      'SELECT * FROM plans WHERE id = ?',
      [planId]
    );

    if (plans.length === 0) {
      return errorResponse(res, 'Plan not found', 404);
    }

    // Check if plan feature exists
    const [planFeatures] = await mysqlConnection.execute(`
      SELECT 
        pf.id,
        p.name as plan_name,
        f.name as feature_name
      FROM plan_features pf
      INNER JOIN plans p ON pf.plan_id = p.id
      INNER JOIN features f ON pf.feature_id = f.id
      WHERE pf.plan_id = ? AND pf.feature_id = ?
    `, [planId, featureId]);

    if (planFeatures.length === 0) {
      return errorResponse(res, 'Feature not found in this plan', 404);
    }

    const planFeature = planFeatures[0];

    // Delete the plan feature
    await mysqlConnection.execute(
      'DELETE FROM plan_features WHERE plan_id = ? AND feature_id = ?',
      [planId, featureId]
    );

    // ⭐ REGENERATE PERMISSIONS for existing users with this plan
    let regenerationResult = "Not Reflect Changes on user which have use plan"
    if (plans[0].slug === "free-account") {
      regenerationResult = await regeneratePermissionsForPlanUsers(planId, mysqlConnection);
    }

    successResponse(res, {
      removedFeature: {
        planId: parseInt(planId),
        featureId: parseInt(featureId),
        planName: planFeature.plan_name,
        featureName: planFeature.feature_name
      },
      usersUpdated: regenerationResult.updated,
      message: `Feature removed from plan successfully. ${regenerationResult.updated} users' permissions updated.`
    }, `Feature "${planFeature.feature_name}" removed from plan "${planFeature.plan_name}"`);

  } catch (error) {
    console.error('Remove feature from plan error:', error);
    errorResponse(res, 'Failed to remove feature from plan', 500);
  }
});

// @route   POST /api/plans/admin/:planId/regenerate-permissions
// @desc    Manually regenerate permissions for all users with a specific plan (Admin only)
// @access  Private (Admin only)
router.post('/admin/:planId(\\d+)/regenerate-permissions', [auth, isAdmin], async (req, res) => {
  try {
    const { planId } = req.params;
    const mysqlConnection = getMySQLConnection();

    // Check if plan exists
    const [plans] = await mysqlConnection.execute(
      'SELECT * FROM plans WHERE id = ?',
      [planId]
    );

    if (plans.length === 0) {
      return errorResponse(res, 'Plan not found', 404);
    }

    // Regenerate permissions for all users with this plan
    let regenerationResult = "Not Reflect Changes on user which have use plan"
    if (plans[0].slug === "free-account") {
      regenerationResult = await regeneratePermissionsForPlanUsers(planId, mysqlConnection);
    }

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

// @route   POST /api/plans/admin/:planId/features/bulk-add
// @desc    Add multiple features to plan at once
// @access  Private (Admin only)
router.post('/admin/:planId(\\d+)/features/bulk-add', [
  auth,
  isAdmin,
  body('features')
    .isArray({ min: 1 })
    .withMessage('Features array is required with at least one feature'),
  body('features.*.feature_id')
    .isInt()
    .withMessage('Valid feature ID is required'),
  body('features.*.permission_type_id')
    .isInt()
    .withMessage('Valid permission type ID is required')
], validate, async (req, res) => {
  const pool = getMySQLConnection();

  try {
    const { planId } = req.params;
    const { features } = req.body;

    // Check if plan exists
    const [plans] = await pool.execute(
      'SELECT id, name FROM plans WHERE id = ?',
      [planId]
    );

    if (plans.length === 0) {
      return errorResponse(res, 'Plan not found', 404);
    }

    const conn = await pool.getConnection();
    const added = [];
    const skipped = [];

    try {
      await conn.beginTransaction();

      for (const feature of features) {
        // Check if feature already exists
        const [existing] = await conn.execute(
          'SELECT id FROM plan_features WHERE plan_id = ? AND feature_id = ?',
          [planId, feature.feature_id]
        );

        if (existing.length > 0) {
          skipped.push(feature.feature_id);
          continue;
        }

        await conn.execute(`
          INSERT INTO plan_features (plan_id, feature_id, permission_type_id, custom_value)
          VALUES (?, ?, ?, ?)
        `, [planId, feature.feature_id, feature.permission_type_id, feature.custom_value || null]);

        added.push(feature.feature_id);
      }

      await conn.commit();
    } catch (err) {
      try { await conn.rollback(); } catch { }
      throw err;
    } finally {
      conn.release();
    }

    successResponse(res, {
      planId: parseInt(planId),
      addedCount: added.length,
      skippedCount: skipped.length,
      added,
      skipped
    }, `Bulk add completed: ${added.length} added, ${skipped.length} skipped`);

  } catch (error) {
    console.error('Bulk add features error:', error);
    errorResponse(res, 'Failed to bulk add features', 500);
  }
});

// ============================================
// ADMIN ENDPOINTS - FEATURES CRUD
// ============================================

// @route   POST /api/plans/features/admin/create
// @desc    Create new feature
// @access  Private (Admin only)
router.post('/features/admin/create', [
  auth,
  isAdmin,
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Feature name is required')
    .isLength({ min: 3, max: 100 })
    .withMessage('Feature name must be between 3 and 100 characters'),
  body('category')
    .trim()
    .notEmpty()
    .withMessage('Category is required'),
  body('description')
    .optional()
    .trim(),
  body('parent_id')
    .optional()
    .isInt()
    .withMessage('Parent ID must be a valid integer'),
  body('display_order')
    .optional()
    .isInt({ min: 0 })
    .withMessage('Display order must be a positive integer')
], validate, async (req, res) => {
  try {
    const { name, category, description, parent_id, display_order } = req.body;
    const mysqlConnection = getMySQLConnection();

    // Auto-generate slug
    let slug = slugify(name, { lower: true, strict: true });

    // Check slug uniqueness
    const [existing] = await mysqlConnection.execute(
      'SELECT COUNT(*) as count FROM features WHERE slug = ?',
      [slug]
    );

    if (existing[0].count > 0) {
      slug = `${slug}-${Date.now()}`;
    }

    // Verify parent exists if provided
    if (parent_id) {
      const [parent] = await mysqlConnection.execute(
        'SELECT id FROM features WHERE id = ?',
        [parent_id]
      );

      if (parent.length === 0) {
        return errorResponse(res, 'Parent feature not found', 404);
      }
    }

    // Insert feature
    const [result] = await mysqlConnection.execute(`
      INSERT INTO features (name, slug, category, parent_id, description, display_order, is_active)
      VALUES (?, ?, ?, ?, ?, ?, TRUE)
    `, [name, slug, category, parent_id || null, description || null, display_order || 0]);

    // Fetch created feature
    const [newFeature] = await mysqlConnection.execute(
      'SELECT * FROM features WHERE id = ?',
      [result.insertId]
    );

    successResponse(res, {
      feature: newFeature[0]
    }, 'Feature created successfully', 201);

  } catch (error) {
    console.error('Create feature error:', error);
    errorResponse(res, 'Failed to create feature', 500);
  }
});

// @route   PUT /api/plans/features/admin/update/:id
// @desc    Update feature
// @access  Private (Admin only)
router.put('/features/admin/update/:id(\\d+)', [
  auth,
  isAdmin,
  body('name')
    .optional()
    .trim()
    .isLength({ min: 3, max: 100 }),
  body('category')
    .optional()
    .trim(),
  body('description')
    .optional()
    .trim(),
  body('parent_id')
    .optional()
    .isInt(),
  body('display_order')
    .optional()
    .isInt({ min: 0 }),
  body('is_active')
    .optional()
    .isBoolean()
], validate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, category, description, parent_id, display_order, is_active } = req.body;
    const mysqlConnection = getMySQLConnection();

    // Check if feature exists
    const [features] = await mysqlConnection.execute(
      'SELECT * FROM features WHERE id = ?',
      [id]
    );

    if (features.length === 0) {
      return errorResponse(res, 'Feature not found', 404);
    }

    const currentFeature = features[0];

    // Prevent circular reference
    if (parent_id && parent_id == id) {
      return errorResponse(res, 'Feature cannot be its own parent', 400);
    }

    // Auto-generate slug if name changed
    let slug = currentFeature.slug;
    if (name && name !== currentFeature.name) {
      slug = slugify(name, { lower: true, strict: true });

      const [existing] = await mysqlConnection.execute(
        'SELECT id FROM features WHERE slug = ? AND id != ?',
        [slug, id]
      );

      if (existing.length > 0) {
        slug = `${slug}-${Date.now()}`;
      }
    }

    // Build update query
    const updates = [];
    const values = [];

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (slug !== undefined) {
      updates.push('slug = ?');
      values.push(slug);
    }
    if (category !== undefined) {
      updates.push('category = ?');
      values.push(category);
    }
    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description);
    }
    if (parent_id !== undefined) {
      updates.push('parent_id = ?');
      values.push(parent_id || null);
    }
    if (display_order !== undefined) {
      updates.push('display_order = ?');
      values.push(display_order);
    }
    if (is_active !== undefined) {
      updates.push('is_active = ?');
      values.push(is_active);
    }

    if (updates.length === 0) {
      return errorResponse(res, 'No fields to update', 400);
    }

    updates.push('updated_at = NOW()');
    values.push(id);

    await mysqlConnection.execute(
      `UPDATE features SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    // Fetch updated feature
    const [updatedFeature] = await mysqlConnection.execute(
      'SELECT * FROM features WHERE id = ?',
      [id]
    );

    successResponse(res, {
      feature: updatedFeature[0]
    }, 'Feature updated successfully');

  } catch (error) {
    console.error('Update feature error:', error);
    errorResponse(res, 'Failed to update feature', 500);
  }
});


// @route   DELETE /api/plans/features/admin/delete/:id
// @desc    Delete feature (soft delete by default)
// @access  Private (Admin only)
router.delete('/features/admin/delete/:id(\\d+)', [auth, isAdmin], async (req, res) => {
  try {
    const { id } = req.params;
    const { force } = req.query;
    const pool = getMySQLConnection();

    // Check if feature exists
    const [features] = await pool.execute(
      'SELECT id, name, is_active FROM features WHERE id = ?',
      [id]
    );

    if (features.length === 0) {
      return errorResponse(res, 'Feature not found', 404);
    }

    const feature = features[0];

    // Check usage
    const [planFeatures] = await pool.execute(
      'SELECT COUNT(*) as count FROM plan_features WHERE feature_id = ?',
      [id]
    );

    const usageCount = planFeatures[0].count;

    if (usageCount > 0 && force !== 'true') {
      return errorResponse(
        res,
        `Cannot delete feature "${feature.name}". It is used in ${usageCount} plan(s). Use ?force=true to delete anyway.`,
        400
      );
    }

    if (force === 'true') {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        await conn.execute('DELETE FROM plan_features WHERE feature_id = ?', [id]);
        await conn.execute('DELETE FROM features WHERE parent_id = ?', [id]);
        await conn.execute('DELETE FROM features WHERE id = ?', [id]);

        await conn.commit();

        return successResponse(
          res,
          { deletedId: id },
          `Feature "${feature.name}" permanently deleted`
        );
      } catch (err) {
        try { await conn.rollback(); } catch { }
        throw err;
      } finally {
        conn.release();
      }
    }

    // Soft delete
    if (!feature.is_active) {
      return successResponse(res, { id }, 'Feature is already inactive');
    }

    await pool.execute(
      'UPDATE features SET is_active = FALSE, updated_at = NOW() WHERE id = ?',
      [id]
    );

    successResponse(
      res,
      { deactivatedId: id },
      `Feature "${feature.name}" deactivated successfully`
    );

  } catch (error) {
    console.error('Delete feature error:', error);
    errorResponse(res, 'Failed to delete feature', 500);
  }
});


// ============================================
// ADMIN ENDPOINTS - PERMISSION TYPES CRUD
// ============================================

// @route   GET /api/plans/permissions/admin/all
// @desc    Get all permission types
// @access  Private (Admin only)
router.get('/permissions/admin/all', [auth], async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    const [permissions] = await mysqlConnection.execute(`
      SELECT 
        pt.*,
        COUNT(DISTINCT pf.id) as usage_count
      FROM permission_types pt
      LEFT JOIN plan_features pf ON pt.id = pf.permission_type_id
      GROUP BY pt.id
      ORDER BY pt.name
    `);

    successResponse(res, {
      permissions,
      total: permissions.length
    }, 'Permission types retrieved successfully');

  } catch (error) {
    console.error('Get permission types error:', error);
    errorResponse(res, 'Failed to retrieve permission types', 500);
  }
});

// @route   POST /api/plans/permissions/admin/create
// @desc    Create new permission type
// @access  Private (Admin only)
router.post('/permissions/admin/create', [
  auth,
  isAdmin,
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Permission name is required')
    .matches(/^[a-z0-9\-]+$/)
    .withMessage('Permission name must be lowercase alphanumeric with hyphens only'),
  body('label')
    .trim()
    .notEmpty()
    .withMessage('Permission label is required'),
  body('description')
    .optional()
    .trim()
], validate, async (req, res) => {
  try {
    const { name, label, description } = req.body;
    const mysqlConnection = getMySQLConnection();

    // Check if permission name already exists
    const [existing] = await mysqlConnection.execute(
      'SELECT id FROM permission_types WHERE name = ?',
      [name]
    );

    if (existing.length > 0) {
      return errorResponse(res, 'Permission type with this name already exists', 400);
    }

    // Insert permission type
    const [result] = await mysqlConnection.execute(`
      INSERT INTO permission_types (name, label, description)
      VALUES (?, ?, ?)
    `, [name, label, description || null]);

    // Fetch created permission
    const [newPermission] = await mysqlConnection.execute(
      'SELECT * FROM permission_types WHERE id = ?',
      [result.insertId]
    );

    successResponse(res, {
      permission: newPermission[0]
    }, 'Permission type created successfully', 201);

  } catch (error) {
    console.error('Create permission type error:', error);
    errorResponse(res, 'Failed to create permission type', 500);
  }
});

// @route   PUT /api/plans/permissions/admin/update/:id
// @desc    Update permission type
// @access  Private (Admin only)
router.put('/permissions/admin/update/:id(\\d+)', [
  auth,
  isAdmin,
  body('name')
    .optional()
    .trim()
    .matches(/^[a-z0-9\-]+$/)
    .withMessage('Permission name must be lowercase alphanumeric with hyphens only'),
  body('label')
    .optional()
    .trim(),
  body('description')
    .optional()
    .trim()
], validate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, label, description } = req.body;
    const mysqlConnection = getMySQLConnection();

    // Check if permission exists
    const [permissions] = await mysqlConnection.execute(
      'SELECT * FROM permission_types WHERE id = ?',
      [id]
    );

    if (permissions.length === 0) {
      return errorResponse(res, 'Permission type not found', 404);
    }

    // Check name uniqueness if changing
    if (name && name !== permissions[0].name) {
      const [existing] = await mysqlConnection.execute(
        'SELECT id FROM permission_types WHERE name = ? AND id != ?',
        [name, id]
      );

      if (existing.length > 0) {
        return errorResponse(res, 'Permission type with this name already exists', 400);
      }
    }

    // Build update query
    const updates = [];
    const values = [];

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (label !== undefined) {
      updates.push('label = ?');
      values.push(label);
    }
    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description);
    }

    if (updates.length === 0) {
      return errorResponse(res, 'No fields to update', 400);
    }

    values.push(id);

    await mysqlConnection.execute(
      `UPDATE permission_types SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    // Fetch updated permission
    const [updatedPermission] = await mysqlConnection.execute(
      'SELECT * FROM permission_types WHERE id = ?',
      [id]
    );

    successResponse(res, {
      permission: updatedPermission[0]
    }, 'Permission type updated successfully');

  } catch (error) {
    console.error('Update permission type error:', error);
    errorResponse(res, 'Failed to update permission type', 500);
  }
});

// @route   DELETE /api/plans/permissions/admin/delete/:id
// @desc    Delete permission type
// @access  Private (Admin only)
router.delete('/permissions/admin/delete/:id(\\d+)', [auth, isAdmin], async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();

    // Check if permission exists
    const [permissions] = await mysqlConnection.execute(
      'SELECT id, name FROM permission_types WHERE id = ?',
      [id]
    );

    if (permissions.length === 0) {
      return errorResponse(res, 'Permission type not found', 404);
    }

    const permission = permissions[0];

    // Check if permission is used in any plan features
    const [usage] = await mysqlConnection.execute(
      'SELECT COUNT(*) as count FROM plan_features WHERE permission_type_id = ?',
      [id]
    );

    if (usage[0].count > 0) {
      return errorResponse(
        res,
        `Cannot delete permission type "${permission.name}". It is used in ${usage[0].count} plan feature(s).`,
        400
      );
    }

    // Delete permission type
    await mysqlConnection.execute('DELETE FROM permission_types WHERE id = ?', [id]);

    successResponse(
      res,
      { deletedId: id },
      `Permission type "${permission.name}" deleted successfully`
    );

  } catch (error) {
    console.error('Delete permission type error:', error);
    errorResponse(res, 'Failed to delete permission type', 500);
  }
});

// @route   GET /api/plans/permissions
// @desc    Get all permission types (public)
// @access  Public
router.get('/permissions', async (req, res) => {
  try {
    const mysqlConnection = getMySQLConnection();

    const [permissions] = await mysqlConnection.execute(`
      SELECT id, name, label, description
      FROM permission_types
      ORDER BY name
    `);

    successResponse(res, {
      permissions,
      total: permissions.length
    }, 'Permission types retrieved successfully');

  } catch (error) {
    console.error('Get permission types error:', error);
    errorResponse(res, 'Failed to retrieve permission types', 500);
  }
});



// =============================================================
// 🔗 MANUAL SYNC — Re-sync every subscriber of a plan to AC
// =============================================================
// @route   POST /api/plans/admin/:id(\d+)/sync-users
// @desc    Manually re-sync ActiveCampaign contact + tags for every
//          active user currently subscribed to this plan. Useful
//          right after bulk plan assignments, or just to force a
//          refresh without waiting for a plan update.
// @access  Private (Admin only)
router.post('/admin/:id(\\d+)/sync-users', [auth, isAdmin], async (req, res) => {
  try {
    const { id } = req.params;
    const pool = getMySQLConnection();

    const [plans] = await pool.execute('SELECT id, name FROM plans WHERE id = ?', [id]);

    if (!plans.length) {
      return errorResponse(res, 'Plan not found', 404);
    }

    // Respond immediately, then sync in the background — a plan with a lot
    // of subscribers could otherwise exceed the server's 120s timeout.
    successResponse(
      res,
      { plan_id: id, plan_name: plans[0].name },
      `Sync started for subscribers of plan "${plans[0].name}". Check server logs for progress.`,
      202
    );

    triggerPlanUsersSync(pool, id, 'manual-sync-users');
  } catch (err) {
    console.error('❌ Sync users for plan error:', err);
    return errorResponse(res, 'Failed to sync users for this plan');
  }
});

// =============================================================
// 🔗 BULK SYNC — Re-sync EVERY plan's subscribers to ActiveCampaign
// =============================================================
// @route   POST /api/plans/admin/sync-active-campaign-all
// @desc    Goes through every plan and re-syncs every active subscriber
//          on it. Runs as a BACKGROUND JOB (same pattern as auth.js's
//          user-level bulk sync) — this responds immediately with a
//          jobId since a full sweep across all plans can easily exceed
//          the server's 120s timeout. Poll progress with:
//          GET /api/plans/admin/sync-active-campaign-all/status/:jobId
//          Optional body: { onlyActivePlans: true } → only currently
//          active plans (default: true)
// @access  Private (Admin only)
router.post('/admin/sync-active-campaign-all', [auth, isAdmin], async (req, res) => {
  try {
    const pool = getMySQLConnection();
    const onlyActivePlans = req.body?.onlyActivePlans !== false; // default true

    const [plans] = await pool.execute(
      onlyActivePlans
        ? 'SELECT id, name FROM plans WHERE is_active = TRUE'
        : 'SELECT id, name FROM plans'
    );

    const jobId = `plan-ac-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const job = {
      jobId,
      status: 'running', // 'running' | 'completed'
      totalPlans: plans.length,
      processedPlans: 0,
      totalUsersSynced: 0,
      totalUsersFailed: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      perPlan: [],
    };
    acPlanSyncJobs.set(jobId, job);

    // 🚀 Respond immediately — the sync itself runs after this
    successResponse(
      res,
      {
        jobId,
        totalPlans: job.totalPlans,
        statusUrl: `/api/plans/admin/sync-active-campaign-all/status/${jobId}`,
      },
      `Bulk plan sync started for ${job.totalPlans} plan(s). Poll the statusUrl for progress.`,
      202
    );

    // 🔄 Run in the background (sequential, one plan at a time)
    setImmediate(async () => {
      console.log(`🚀 [BULK PLAN AC SYNC:${jobId}] Starting sync for ${plans.length} plan(s)...`);

      for (const { id: planId, name: planName } of plans) {
        try {
          const result = await syncUsersForPlan(pool, planId);
          job.processedPlans += 1;
          job.totalUsersSynced += result.succeeded;
          job.totalUsersFailed += result.failed;
          job.perPlan.push({ plan_id: planId, plan_name: planName, ...result });
        } catch (err) {
          console.error(`❌ [BULK PLAN AC SYNC:${jobId}] Error syncing plan "${planName}":`, err.message);
          job.processedPlans += 1;
          job.perPlan.push({ plan_id: planId, plan_name: planName, total: 0, succeeded: 0, failed: 0, error: err.message });
        }
      }

      job.status = 'completed';
      job.finishedAt = new Date().toISOString();
      console.log(`✅ [BULK PLAN AC SYNC:${jobId}] Done. ${job.totalUsersSynced} user(s) synced, ${job.totalUsersFailed} failed, across ${job.totalPlans} plan(s).`);
    });
  } catch (err) {
    console.error('❌ Bulk plan sync error:', err);
    return errorResponse(res, 'Failed to start bulk plan sync to ActiveCampaign');
  }
});

// @route   GET /api/plans/admin/sync-active-campaign-all/status/:jobId
// @desc    Check progress/result of a bulk plan-sync job started above
// @access  Private (Admin only)
router.get('/admin/sync-active-campaign-all/status/:jobId', [auth, isAdmin], async (req, res) => {
  const job = acPlanSyncJobs.get(req.params.jobId);

  if (!job) {
    return errorResponse(res, 'Job not found (it may have finished and the server since restarted)', 404);
  }

  return successResponse(res, job, 'Bulk plan sync job status');
});

module.exports = router;