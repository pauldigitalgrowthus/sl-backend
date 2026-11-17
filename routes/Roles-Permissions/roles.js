const express = require('express');
const { getMySQLConnection } = require('../../config/mysql');
const { auth, requireSLTeamWithTypes } = require('../../middleware/auth');
const { successResponse, errorResponse } = require('../../utils/response');

const slugify = (text) => {
    return text.toLowerCase().trim()
        .replace(/\s+/g, '_')
        .replace(/[()]/g, '')
        .replace(/[^a-z0-9_]/g, '')
        .replace(/_+/g, '_')
        .trim();
}
const router = express.Router();

// =============================================================
// 🗂️ In-memory job store for the "sync all roles' users" bulk route.
// Mirrors the pattern used in auth.js's sync-active-campaign-all —
// runs in the background and is polled via a status route so it
// never hits the server's global 120s request timeout.
// Lives only in process memory (no DB change) and resets on restart.
// =============================================================
const acRoleSyncJobs = new Map();
// =============================================================
// 🏷️ ActiveCampaign Tag Helpers
// =============================================================
// These keep the role_permissions.ac_tag_id column in sync with
// ActiveCampaign so future updates/deletes don't rely on matching
// by name (names can change, IDs don't).

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
// 👤 ActiveCampaign Contact Sync (for users carrying this role's badge)
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

// Resolve (or create + persist) a role's AC tag ID
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

// Resolve (or create + persist) a plan's AC tag ID — plans live in the `plans` table
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
// Same logic used across the codebase (auth.js) — duplicated here so this
// route file doesn't need a cross-file import.
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

// Re-sync every active user who currently carries this role's badge.
// Runs sequentially in the background (fire-and-forget from the caller)
// so a role rename/update/delete never blocks the actual API response.
async function syncUsersForRole(mysqlConnection, roleName) {
    try {
        const [users] = await mysqlConnection.execute(
            `SELECT id FROM users
             WHERE is_active = 1 AND deleted_at IS NULL
               AND JSON_CONTAINS(badges, JSON_QUOTE(?))`,
            [roleName]
        );

        if (!users.length) {
            console.log(`ℹ️ [AC ROLE SYNC] No users currently have badge "${roleName}" — nothing to sync`);
            return { total: 0, succeeded: 0, failed: 0 };
        }

        console.log(`🚀 [AC ROLE SYNC] Re-syncing ${users.length} user(s) with badge "${roleName}"...`);

        let succeeded = 0;
        let failed = 0;

        for (const { id: userId } of users) {
            try {
                const result = await syncUserToActiveCampaign(mysqlConnection, userId);
                result.success ? succeeded++ : failed++;
            } catch (err) {
                console.error(`❌ [AC ROLE SYNC] Error syncing user ${userId}:`, err.message);
                failed++;
            }
        }

        console.log(`✅ [AC ROLE SYNC] Done for "${roleName}". Synced ${succeeded}/${users.length}, failed ${failed}.`);
        return { total: users.length, succeeded, failed };
    } catch (err) {
        console.error(`❌ [AC ROLE SYNC] Failed to sync users for role "${roleName}":`, err.message);
        return { total: 0, succeeded: 0, failed: 0, error: err.message };
    }
}

// Fire-and-forget wrapper — call right before responding so a role
// create/update/delete never waits on ActiveCampaign.
function triggerRoleUsersSync(mysqlConnection, roleName, context = '') {
    syncUsersForRole(mysqlConnection, roleName)
        .catch((err) => console.error(`⚠️ [AC ROLE SYNC${context ? ':' + context : ''}] threw:`, err.message));
}

// ================================ SL TEAM / ADMIN Roles ROUTES ================================

// =============================================================
// 🟢 CREATE ROLE PERMISSION
// =============================================================
// @route   POST /api/roles-permissions/roles
// @desc    Create a new role with defined permissions
// @access  Private (SL Team/Admin only)
router.post('/', async (req, res) => {
    try {
        const { role_name, permissions } = req.body;
        if (!role_name || !permissions)
            return errorResponse(res, 'role_name and permissions are required');

        const mysqlConnection = getMySQLConnection();
        const slug = slugify(role_name, { lower: true, strict: true });

        // Check if slug already exists
        const [existingRole] = await mysqlConnection.execute(
            'SELECT id FROM role_permissions WHERE slug = ?',
            [slug]
        );

        if (existingRole.length > 0) {
            return errorResponse(res, 'A role with this name already exists', 400);
        }

        // Insert new role
        const [insertResult] = await mysqlConnection.execute(
            'INSERT INTO role_permissions (role_name, permissions, slug) VALUES (?, ?, ?)',
            [role_name, JSON.stringify(permissions), slug]
        );

        // 🏷️ Create matching ActiveCampaign tag & store its ID against this role
        let activeCampaignTag = null;
        try {
            activeCampaignTag = await createActiveCampaignTag(role_name, `${role_name} role`);

            if (activeCampaignTag) {
                await mysqlConnection.execute(
                    'UPDATE role_permissions SET ac_tag_id = ? WHERE id = ?',
                    [activeCampaignTag.id, insertResult.insertId]
                );
            }
        } catch (acError) {
            console.error('❌ Failed to create ActiveCampaign tag for role:', acError.message);
            // Don't fail the request, just log the error
        }

        // 🔄 Automatically update user_type ENUM to include new slug
        try {
            console.log(`🚀 Auto-updating user_type ENUM after creating role: ${slug}`);
            // await updateUserTypeEnum();
            console.log(`✅ ENUM updated successfully after creating role: ${slug}`);[]
        } catch (enumError) {
            console.error('❌ Failed to update ENUM after role creation:', enumError.message);
            // Don't fail the request, just log the error
        }

        // 🔗 Re-sync any users who already carry this badge name to ActiveCampaign
        // (e.g. the role was deleted and re-created with the same name) — non-blocking
        triggerRoleUsersSync(mysqlConnection, role_name, 'role-create');

        return successResponse(res, { role_name, permissions, slug, activeCampaignTag }, 'Role created successfully');
    } catch (err) {
        console.error('Error creating role permission:', err);
        return errorResponse(res, 'Error creating role permission');
    }
});

// =============================================================
// GET ALL ROLES
// =============================================================
// @route   GET /api/roles-permissions/roles
// @desc    Get all roles with their permissions + ActiveCampaign Tags
// @access  Private
router.get("/", async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();

        const [rows] = await mysqlConnection.execute(
            "SELECT * FROM role_permissions"
        );

        const data = rows.map((r) => ({
            id: r.id,
            role_name: r.role_name,
            slug: r.slug,
            ac_tag_id: r.ac_tag_id || null,
            permissions: JSON.parse(r.permissions || "{}"),
            created_at: r.created_at,
        }));

        const rolesWithTags = await Promise.all(
            data.map(async (role) => {
                try {
                    let tag = null;

                    // ----------------------------------------
                    // If we already have the AC tag ID saved, use it directly
                    // (no need to search by name every time)
                    // ----------------------------------------
                    if (role.ac_tag_id) {
                        const getResponse = await fetch(
                            `${process.env.ACTIVE_CAMPAIGN_URL}/api/3/tags/${role.ac_tag_id}`,
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
                    // Fallback: search by slug (legacy roles without ac_tag_id)
                    // ----------------------------------------
                    if (!tag) {
                        const searchResponse = await fetch(
                            `${process.env.ACTIVE_CAMPAIGN_URL}/api/3/tags?search=${encodeURIComponent(
                                role.slug
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
                                (t) =>
                                    t.tag.toLowerCase() === role.slug.toLowerCase()
                            );
                        }
                    }

                    // ----------------------------------------
                    // Create tag if still not found
                    // ----------------------------------------
                    if (!tag) {
                        tag = await createActiveCampaignTag(
                            role.role_name,
                            `${role.role_name} role`
                        );
                    }

                    // ----------------------------------------
                    // Persist the tag ID so future requests skip the search
                    // ----------------------------------------
                    if (tag && tag.id != role.ac_tag_id) {
                        await mysqlConnection.execute(
                            "UPDATE role_permissions SET ac_tag_id = ? WHERE id = ?",
                            [tag.id, role.id]
                        );
                        role.ac_tag_id = tag.id;
                    }

                    return {
                        ...role,
                        activeCampaignTag: tag || null,
                    };
                } catch (err) {
                    console.error(
                        `Error processing role ${role.slug}:`,
                        err.message
                    );

                    return {
                        ...role,
                        activeCampaignTag: null,
                    };
                }
            })
        );

        return successResponse(
            res,
            rolesWithTags,
            "All roles fetched successfully"
        );
    } catch (err) {
        console.error(err);
        return errorResponse(res, "Error fetching roles");
    }
});

// =============================================================
// 🟣 GET ONE ROLE BY NAME
// =============================================================
// @route   GET /api/roles-permissions/roles/:role_name
// @desc    Get a specific role by its name
// @access  Private (SL Team/Admin only)
router.get('/:role_name', async (req, res) => {
    try {
        const { role_name } = req.params;
        const mysqlConnection = getMySQLConnection();
        const [rows] = await mysqlConnection.execute('SELECT * FROM role_permissions WHERE role_name = ?', [role_name]);

        if (rows.length === 0) return errorResponse(res, 'Role not found', 404);

        const role = rows[0];

        role.permissions = JSON.parse(role.permissions || '{}');

        return successResponse(res, role, 'Role fetched successfully');
    } catch (err) {
        console.error(err);
        return errorResponse(res, 'Error fetching role');
    }
});

// =============================================================
// 🔵 UPDATE ROLE PERMISSIONS (FULL REPLACE)
// =============================================================
// @route   PUT /api/roles-permissions/roles/:role_name
// @desc    Replace entire permission object for a role
// @access  Private (SL Team/Admin only)
router.put('/:role_name', async (req, res) => {
    try {
        const { role_name } = req.params;
        const { permissions, new_role_name } = req.body; // Added new_role_name for renaming

        console.log(`\n🚀 [PUT] Starting role update for: ${role_name}`);
        console.log(`📊 Request body:`, { permissions, new_role_name });

        if (!permissions || typeof permissions !== 'object') {
            return errorResponse(res, 'Valid permissions object is required');
        }

        const mysqlConnection = getMySQLConnection();

        // Generate slug for current role_name
        const oldSlug = slugify(role_name, { lower: true, strict: true });
        console.log(`🔧 Generated old slug: ${oldSlug}`);

        // Check if role exists
        const [rows] = await mysqlConnection.execute(
            'SELECT * FROM role_permissions WHERE role_name = ?',
            [role_name]
        );
        if (rows.length === 0) {
            console.log(`❌ Role '${role_name}' not found`);
            return errorResponse(res, 'Role not found', 404);
        }

        console.log(`✅ Found existing role:`, rows[0]);

        // Determine the final role name and slug
        const finalRoleName = new_role_name || role_name;
        const newSlug = slugify(finalRoleName, { lower: true, strict: true });

        console.log(`🎯 Final role name: ${finalRoleName}`);
        console.log(`🎯 New slug: ${newSlug}`);
        console.log(`📝 Slug change: ${oldSlug} → ${newSlug}`);

        // Check if new slug conflicts with existing roles (if renaming)
        if (newSlug !== oldSlug) {
            console.log(`🔍 Checking for slug conflicts...`);
            const [existingRole] = await mysqlConnection.execute(
                'SELECT id FROM role_permissions WHERE slug = ? AND role_name != ?',
                [newSlug, role_name]
            );

            if (existingRole.length > 0) {
                console.log(`❌ Slug conflict detected for: ${newSlug}`);
                return errorResponse(res, 'A role with this name already exists', 400);
            }
            console.log(`✅ No slug conflicts found`);
        } else {
            console.log(`ℹ️  No slug change needed`);
        }

        // ✅ Update permissions, slug, and optionally role_name
        console.log(`💾 Updating role_permissions table...`);
        await mysqlConnection.execute(
            'UPDATE role_permissions SET role_name = ?, permissions = ?, slug = ? WHERE role_name = ?',
            [finalRoleName, JSON.stringify(permissions), newSlug, role_name]
        );
        console.log(`✅ Role_permissions table updated successfully`);

        // 🏷️ Keep the ActiveCampaign tag in sync if the role was renamed
        let activeCampaignTag = null;
        if (finalRoleName !== role_name) {
            try {
                const existingAcTagId = rows[0].ac_tag_id;

                if (existingAcTagId) {
                    activeCampaignTag = await updateActiveCampaignTag(
                        existingAcTagId,
                        finalRoleName,
                        `${finalRoleName} role`
                    );
                } else {
                    // No tag was ever linked — create one now and save its ID
                    activeCampaignTag = await createActiveCampaignTag(
                        finalRoleName,
                        `${finalRoleName} role`
                    );

                    if (activeCampaignTag) {
                        await mysqlConnection.execute(
                            'UPDATE role_permissions SET ac_tag_id = ? WHERE slug = ?',
                            [activeCampaignTag.id, newSlug]
                        );
                    }
                }
            } catch (acError) {
                console.error('❌ Failed to sync ActiveCampaign tag on role rename:', acError.message);
                // Don't fail the request, just log the error
            }
        }

        // ✅ Update all users with role='sl_team' and user_type matching old slug
        const [affectedUsers] = await mysqlConnection.execute(
            'SELECT id, email, user_type, permissions, badges FROM users WHERE role = ? AND user_type = ?',
            ['sl_team', oldSlug]
        );

        console.log(`🔍 Found ${affectedUsers.length} users with role 'sl_team' and user_type '${oldSlug}'`);

        if (affectedUsers.length > 0) {
            for (const user of affectedUsers) {
                console.log(`\n👤 Updating user: ${user.email} (ID: ${user.id})`);
                console.log(`   📝 Old user_type: ${user.user_type}`);
                console.log(`   📝 New user_type: ${newSlug}`);

                // Get old permissions
                let oldPermissions = {};
                try {
                    oldPermissions = user.permissions ? JSON.parse(user.permissions) : {};
                    console.log(`   🔒 Old permissions:`, JSON.stringify(oldPermissions, null, 2));
                } catch (e) {
                    console.log(`   ⚠️  Failed to parse old permissions for user ${user.email}:`, e.message);
                    oldPermissions = {};
                }

                console.log(`   🔒 New permissions:`, JSON.stringify(permissions, null, 2));

                // Update badges
                let userBadges = [];
                try {
                    userBadges = user.badges ? JSON.parse(user.badges) : [];
                    console.log(`   🏷️  Old badges:`, userBadges);
                } catch (e) {
                    console.log(`   ⚠️  Failed to parse badges for user ${user.email}:`, e.message);
                    userBadges = [];
                }

                // Update badge with old role_name to new role_name
                const updatedBadges = userBadges.map(badge =>
                    badge.role_name === role_name
                        ? {
                            ...badge,
                            role_name: finalRoleName,
                            slug: newSlug,
                            updated_at: new Date().toISOString()
                        }
                        : badge
                );

                console.log(`   🏷️  New badges:`, updatedBadges);

                // Update user in database
                await mysqlConnection.execute(
                    'UPDATE users SET user_type = ?, permissions = ?, badges = ? WHERE id = ?',
                    [newSlug, JSON.stringify(permissions), JSON.stringify(updatedBadges), user.id]
                );

                console.log(`   ✅ User ${user.email} updated successfully!`);
            }

            console.log(`\n🎯 Summary: Updated ${affectedUsers.length} users from '${oldSlug}' to '${newSlug}'`);
        } else {
            console.log(`ℹ️  No users found with role='sl_team' and user_type='${oldSlug}'`);
        }

        // 🔄 Automatically update user_type ENUM after role update
        try {
            console.log(`🚀 Auto-updating user_type ENUM after updating role: ${oldSlug} → ${newSlug}`);
            // await updateUserTypeEnum();
            console.log(`✅ ENUM updated successfully after updating role: ${oldSlug} → ${newSlug}`);
        } catch (enumError) {
            console.error('❌ Failed to update ENUM after role update:', enumError.message);
            // Don't fail the request, just log the error
        }

        const responseData = {
            role_name: finalRoleName,
            slug: newSlug,
            permissions,
            updated_users: affectedUsers.length,
            activeCampaignTag
        };

        // 🔗 Re-sync every user who carries this badge to ActiveCampaign (non-blocking)
        triggerRoleUsersSync(mysqlConnection, finalRoleName, 'role-update');
        if (finalRoleName !== role_name) {
            triggerRoleUsersSync(mysqlConnection, role_name, 'role-update-old-name');
        }

        console.log(`\n🎉 [PUT] Role update completed successfully!`);
        console.log(`📋 Response data:`, responseData);

        return successResponse(
            res,
            responseData,
            'Permissions updated successfully'
        );
    } catch (err) {
        console.error('❌ [PUT] Error updating permissions:', err);
        return errorResponse(res, 'Error updating permissions');
    }
});

// =============================================================
// 🟤 PARTIAL UPDATE — MULTIPLE NESTED FIELDS
// =============================================================
// @route   PATCH /api/roles-permissions/roles/update-multiple
// @desc    Partially update role permissions & reflect to all users having that badge
// @access  Private (SL Team/Admin only)
router.patch('/update-multiple', [auth,
    // requireSLTeamWithTypes(['superadmin', 'admin'])
], async (req, res) => {
    let mysqlConnection;

    try {
        const { role_name, updates, new_role_name } = req.body;

        if (!role_name || !Array.isArray(updates) || !updates.length) {
            return errorResponse(res, 'Invalid request body', 400);
        }

        mysqlConnection = getMySQLConnection();

        /* --------------------------------------------------
           1️⃣ FETCH EXISTING ROLE
        -------------------------------------------------- */
        const [rows] = await mysqlConnection.execute(
            'SELECT permissions, ac_tag_id FROM role_permissions WHERE role_name = ?',
            [role_name]
        );

        if (!rows.length) {
            return errorResponse(res, 'Role not found', 404);
        }

        let rolePermissions = {};
        try {
            rolePermissions = JSON.parse(rows[0].permissions || '{}');
        } catch {
            rolePermissions = {};
        }

        /* --------------------------------------------------
           2️⃣ APPLY PARTIAL NESTED UPDATES
           updates = [
             { path: ["SL Portals","Community","Feed"], value: "x" }
           ]
        -------------------------------------------------- */
        for (const { path, value } of updates) {
            if (!Array.isArray(path) || !path.length) continue;

            let ref = rolePermissions;
            for (let i = 0; i < path.length - 1; i++) {
                if (typeof ref[path[i]] !== 'object') {
                    ref[path[i]] = {};
                }
                ref = ref[path[i]];
            }
            ref[path[path.length - 1]] = value;
        }

        /* --------------------------------------------------
           3️⃣ UPDATE ROLE (NAME + SLUG OPTIONAL)
        -------------------------------------------------- */
        const finalRoleName = new_role_name || role_name;
        const newSlug = slugify(finalRoleName, { lower: true, strict: true });

        await mysqlConnection.execute(
            `UPDATE role_permissions
           SET role_name = ?, permissions = ?, slug = ?
           WHERE role_name = ?`,
            [
                finalRoleName,
                JSON.stringify(rolePermissions),
                newSlug,
                role_name
            ]
        );

        // 🏷️ Keep the ActiveCampaign tag in sync if the role was renamed
        if (finalRoleName !== role_name) {
            try {
                const existingAcTagId = rows[0].ac_tag_id;

                if (existingAcTagId) {
                    await updateActiveCampaignTag(
                        existingAcTagId,
                        finalRoleName,
                        `${finalRoleName} role`
                    );
                } else {
                    const newTag = await createActiveCampaignTag(
                        finalRoleName,
                        `${finalRoleName} role`
                    );

                    if (newTag) {
                        await mysqlConnection.execute(
                            'UPDATE role_permissions SET ac_tag_id = ? WHERE slug = ?',
                            [newTag.id, newSlug]
                        );
                    }
                }
            } catch (acError) {
                console.error('❌ Failed to sync ActiveCampaign tag on role rename:', acError.message);
                // Don't fail the request, just log the error
            }
        }

        /* --------------------------------------------------
           4️⃣ FIND ALL USERS HAVING THIS BADGE
        -------------------------------------------------- */
        const [users] = await mysqlConnection.execute(
            `SELECT id, email, badges
           FROM users
           WHERE JSON_CONTAINS(badges, JSON_QUOTE(?))`,
            [finalRoleName]
        );

        console.log(`🔍 ${users.length} users found with badge "${finalRoleName}"`);

        /* --------------------------------------------------
           5️⃣ RECURSIVE MERGE FUNCTION (x / - LOGIC)
        -------------------------------------------------- */
        const mergePermissions = (source, target) => {
            Object.entries(source).forEach(([key, value]) => {
                if (value === 'x') {
                    target[key] = 'x';
                    return;
                }

                if (value === '-') {
                    return;
                }

                if (typeof value === 'object' && value !== null) {
                    if (!target[key]) target[key] = {};
                    mergePermissions(value, target[key]);

                    if (Object.keys(target[key]).length === 0) {
                        delete target[key];
                    }
                }
            });
        };

        /* --------------------------------------------------
           6️⃣ RECALCULATE PERMISSIONS FOR EACH USER
        -------------------------------------------------- */
        for (const user of users) {
            console.log(`👤 Recalculating permissions for ${user.email}`);

            let userBadges = [];
            try {
                userBadges = JSON.parse(user.badges || '[]');
            } catch {
                userBadges = [];
            }

            if (!userBadges.length) continue;

            const placeholders = userBadges.map(() => '?').join(',');

            const [badgeRoles] = await mysqlConnection.execute(
                `SELECT permissions
             FROM role_permissions
             WHERE role_name IN (${placeholders})`,
                userBadges
            );

            const finalPermissions = {};

            badgeRoles.forEach(role => {
                const perms = JSON.parse(role.permissions || '{}');
                mergePermissions(perms, finalPermissions);
            });

            await mysqlConnection.execute(
                `UPDATE users
             SET permissions = ?, updated_at = NOW()
             WHERE id = ?`,
                [JSON.stringify(finalPermissions), user.id]
            );

            console.log(`✅ Permissions updated for ${user.email}`);
        }

        /* --------------------------------------------------
           7️⃣ RESPONSE
        -------------------------------------------------- */
        // 🔗 Re-sync every user with this badge to ActiveCampaign (non-blocking)
        triggerRoleUsersSync(mysqlConnection, finalRoleName, 'role-patch');
        if (finalRoleName !== role_name) {
            triggerRoleUsersSync(mysqlConnection, role_name, 'role-patch-old-name');
        }

        return successResponse(
            res,
            {
                role_name: finalRoleName,
                slug: newSlug,
                updated_users: users.length
            },
            'Role permissions updated & reflected to all users',
            200
        );

    } catch (err) {
        console.error('❌ PATCH ROLE PERMISSION ERROR:', err);
        return errorResponse(res, 'Failed to update role permissions', 500);
    }
}
);

// =============================================================
// 🔴 DELETE ROLE
// =============================================================
// @route   DELETE /api/roles-permissions/roles/:role_name
// @desc    Delete a role and update users badges & permissions
// @access  Private (SL Team/Admin only)
// =============================================================
router.delete('/:role_name', [auth], async (req, res) => {
    const mysqlConnection = await getMySQLConnection();
    const { role_name } = req.params;

    try {
        console.log(`\n🚀 [DELETE ROLE] ${role_name}`);

        /* --------------------------------------------------
           1️⃣ CHECK ROLE EXISTS
        -------------------------------------------------- */
        const [roles] = await mysqlConnection.execute(
            'SELECT role_name, ac_tag_id FROM role_permissions WHERE role_name = ?',
            [role_name]
        );

        if (!roles.length) {
            return errorResponse(res, 'Role not found', 404);
        }

        const roleAcTagId = roles[0].ac_tag_id;

        /* --------------------------------------------------
           2️⃣ FIND USERS HAVING THIS BADGE
        -------------------------------------------------- */
        const [users] = await mysqlConnection.execute(
            `
      SELECT id, email, badges
      FROM users
      WHERE JSON_CONTAINS(badges, JSON_QUOTE(?))
      `,
            [role_name]
        );

        console.log(`👥 Users with badge "${role_name}": ${users.length}`);

        /* --------------------------------------------------
           3️⃣ MERGE PERMISSIONS HELPER
        -------------------------------------------------- */
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

        /* --------------------------------------------------
           4️⃣ UPDATE EACH USER SAFELY
        -------------------------------------------------- */
        for (const user of users) {
            console.log(`🔧 Fixing user: ${user.email}`);

            let userBadges = [];
            try {
                userBadges = JSON.parse(user.badges || '[]');
            } catch {
                userBadges = [];
            }

            // Remove deleted role badge
            const remainingBadges = userBadges.filter(b => b !== role_name);

            let finalPermissions = {};
            let finalRole = 'user';          // ENUM SAFE (role)
            let finalUserType = 'sub_user';  // ENUM SAFE (user_type)

            if (remainingBadges.length > 0) {
                const placeholders = remainingBadges.map(() => '?').join(',');

                const [remainingRoles] = await mysqlConnection.execute(
                    `
          SELECT role_name, permissions
          FROM role_permissions
          WHERE role_name IN (${placeholders})
          `,
                    remainingBadges
                );

                // Merge permissions from remaining roles
                remainingRoles.forEach(r => {
                    const perms = JSON.parse(r.permissions || '{}');
                    mergePermissions(perms, finalPermissions);
                });

                finalRole = 'sl_team';

                // user_type decision (ENUM SAFE)
                if (remainingBadges.some(b => b.toLowerCase() === 'superadmin')) {
                    finalUserType = 'superadmin';
                } else if (remainingBadges.some(b => b.toLowerCase() === 'admin')) {
                    finalUserType = 'admin';
                } else if (remainingBadges.some(b => b.toLowerCase() === 'manager')) {
                    finalUserType = 'manager';
                } else {
                    finalUserType = 'sub_user';
                }
            }

            await mysqlConnection.execute(
                `
        UPDATE users
        SET
          badges = ?,
          permissions = ?,
          role = ?,
          user_type = ?,
          updated_at = NOW()
        WHERE id = ?
        `,
                [
                    JSON.stringify(remainingBadges),
                    JSON.stringify(finalPermissions),
                    finalRole,
                    finalUserType,
                    user.id
                ]
            );

            console.log(`✅ User updated: ${user.email}`);
        }

        /* --------------------------------------------------
           5️⃣ DELETE ROLE'S ActiveCampaign TAG
        -------------------------------------------------- */
        if (roleAcTagId) {
            const deleted = await deleteActiveCampaignTag(roleAcTagId);
            if (!deleted) {
                console.error(`⚠️ Could not delete AC tag ${roleAcTagId} for role "${role_name}" — continuing anyway`);
            }
        }

        /* --------------------------------------------------
           6️⃣ DELETE ROLE FROM role_permissions
        -------------------------------------------------- */
        await mysqlConnection.execute(
            'DELETE FROM role_permissions WHERE role_name = ?',
            [role_name]
        );

        /* --------------------------------------------------
           6️⃣ RESPONSE
        -------------------------------------------------- */
        // 🔗 Re-sync every previously-affected user to ActiveCampaign (non-blocking).
        // The deleted role's tag is already gone from AC (and therefore from
        // every contact automatically) — this just refreshes their remaining
        // badge/plan tags and contact info.
        if (users.length) {
            (async () => {
                for (const u of users) {
                    try {
                        await syncUserToActiveCampaign(mysqlConnection, u.id);
                    } catch (err) {
                        console.error(`⚠️ [AC ROLE DELETE SYNC] Failed to resync user ${u.id}:`, err.message);
                    }
                }
                console.log(`✅ [AC ROLE DELETE SYNC] Re-synced ${users.length} previously-affected user(s) after deleting role "${role_name}"`);
            })().catch((err) => console.error('⚠️ [AC ROLE DELETE SYNC] threw:', err.message));
        }

        return successResponse(
            res,
            {
                deleted_role: role_name,
                affected_users: users.length
            },
            'Role deleted and users updated successfully',
            200
        );

    } catch (error) {
        console.error('❌ DELETE ROLE ERROR:', error);
        return errorResponse(res, 'Failed to delete role', 500);
    }
});

// =============================================================
// 🔗 MANUAL SYNC — Re-sync every user carrying a role's badge to AC
// =============================================================
// @route   POST /api/roles-permissions/roles/:role_name/sync-users
// @desc    Manually re-sync ActiveCampaign contact + tags for every
//          active user who currently carries this role's badge.
//          Useful right after bulk badge assignments, or just to
//          force a refresh without waiting for a rename/update.
// @access  Private (SL Team/Admin)
router.post('/:role_name/sync-users', [auth], async (req, res) => {
    try {
        const { role_name } = req.params;
        const mysqlConnection = getMySQLConnection();

        const [roleRows] = await mysqlConnection.execute(
            'SELECT id FROM role_permissions WHERE role_name = ?',
            [role_name]
        );

        if (!roleRows.length) {
            return errorResponse(res, 'Role not found', 404);
        }

        // Respond immediately, then sync in the background — a badge with
        // a lot of users could otherwise exceed the server's 120s timeout.
        successResponse(
            res,
            { role_name },
            `Sync started for users with badge "${role_name}". Check server logs for progress.`,
            202
        );

        triggerRoleUsersSync(mysqlConnection, role_name, 'manual-sync-users');
    } catch (err) {
        console.error('❌ Sync users for role error:', err);
        return errorResponse(res, 'Failed to sync users for this role');
    }
});

// =============================================================
// 🔗 BULK SYNC — Re-sync EVERY role's users to ActiveCampaign
// =============================================================
// @route   POST /api/roles-permissions/roles/sync-active-campaign-all
// @desc    Goes through every role in role_permissions and re-syncs
//          every active user carrying that badge. Runs as a BACKGROUND
//          JOB (same pattern as auth.js's user-level bulk sync) — this
//          responds immediately with a jobId since a full sweep across
//          all roles can easily exceed the server's 120s timeout.
//          Poll progress with:
//          GET /api/roles-permissions/roles/sync-active-campaign-all/status/:jobId
// @access  Private (SL Team/Admin)
router.post('/sync-active-campaign-all', [auth], async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();

        const [roles] = await mysqlConnection.execute(
            'SELECT role_name FROM role_permissions'
        );

        const jobId = `role-ac-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const job = {
            jobId,
            status: 'running', // 'running' | 'completed'
            totalRoles: roles.length,
            processedRoles: 0,
            totalUsersSynced: 0,
            totalUsersFailed: 0,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            perRole: [],
        };
        acRoleSyncJobs.set(jobId, job);

        // 🚀 Respond immediately — the sync itself runs after this
        successResponse(
            res,
            {
                jobId,
                totalRoles: job.totalRoles,
                statusUrl: `/api/roles-permissions/roles/sync-active-campaign-all/status/${jobId}`,
            },
            `Bulk role sync started for ${job.totalRoles} role(s). Poll the statusUrl for progress.`,
            202
        );

        // 🔄 Run in the background (sequential, one role at a time)
        setImmediate(async () => {
            console.log(`🚀 [BULK ROLE AC SYNC:${jobId}] Starting sync for ${roles.length} role(s)...`);

            for (const { role_name } of roles) {
                try {
                    const result = await syncUsersForRole(mysqlConnection, role_name);
                    job.processedRoles += 1;
                    job.totalUsersSynced += result.succeeded;
                    job.totalUsersFailed += result.failed;
                    job.perRole.push({ role_name, ...result });
                } catch (err) {
                    console.error(`❌ [BULK ROLE AC SYNC:${jobId}] Error syncing role "${role_name}":`, err.message);
                    job.processedRoles += 1;
                    job.perRole.push({ role_name, total: 0, succeeded: 0, failed: 0, error: err.message });
                }
            }

            job.status = 'completed';
            job.finishedAt = new Date().toISOString();
            console.log(`✅ [BULK ROLE AC SYNC:${jobId}] Done. ${job.totalUsersSynced} user(s) synced, ${job.totalUsersFailed} failed, across ${job.totalRoles} role(s).`);
        });
    } catch (err) {
        console.error('❌ Bulk role sync error:', err);
        return errorResponse(res, 'Failed to start bulk role sync to ActiveCampaign');
    }
});

// @route   GET /api/roles-permissions/roles/sync-active-campaign-all/status/:jobId
// @desc    Check progress/result of a bulk role-sync job started above
// @access  Private (SL Team/Admin)
router.get('/sync-active-campaign-all/status/:jobId', [auth], async (req, res) => {
    const job = acRoleSyncJobs.get(req.params.jobId);

    if (!job) {
        return errorResponse(res, 'Job not found (it may have finished and the server since restarted)', 404);
    }

    return successResponse(res, job, 'Bulk role sync job status');
});

module.exports = router;