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
        await mysqlConnection.execute(
            'INSERT INTO role_permissions (role_name, permissions, slug) VALUES (?, ?, ?)',
            [role_name, JSON.stringify(permissions), slug]
        );

        // 🔄 Automatically update user_type ENUM to include new slug
        try {
            console.log(`🚀 Auto-updating user_type ENUM after creating role: ${slug}`);
            // await updateUserTypeEnum();
            console.log(`✅ ENUM updated successfully after creating role: ${slug}`);[]
        } catch (enumError) {
            console.error('❌ Failed to update ENUM after role creation:', enumError.message);
            // Don't fail the request, just log the error
        }

        return successResponse(res, { role_name, permissions, slug }, 'Role created successfully');
    } catch (err) {
        console.error('Error creating role permission:', err);
        return errorResponse(res, 'Error creating role permission');
    }
});

// =============================================================
// 🟡 GET ALL ROLES
// =============================================================
// @route   GET /api/roles-permissions/roles
// @desc    Get all roles with their permissions
// @access  Private (SL Team/Admin only)
router.get('/', async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const [rows] = await mysqlConnection.execute('SELECT * FROM role_permissions');
        const data = rows.map((r) => ({
            id: r.id,
            role_name: r.role_name,
            slug: r.slug,
            permissions: JSON.parse(r.permissions || '{}'),
            created_at: r.created_at,
        }));

        return successResponse(res, data, 'All roles fetched successfully');
    } catch (err) {
        console.error(err);
        return errorResponse(res, 'Error fetching roles');
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
            updated_users: affectedUsers.length
        };

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
            'SELECT permissions FROM role_permissions WHERE role_name = ?',
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
            'SELECT role_name FROM role_permissions WHERE role_name = ?',
            [role_name]
        );

        if (!roles.length) {
            return errorResponse(res, 'Role not found', 404);
        }

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
           5️⃣ DELETE ROLE FROM role_permissions
        -------------------------------------------------- */
        await mysqlConnection.execute(
            'DELETE FROM role_permissions WHERE role_name = ?',
            [role_name]
        );

        /* --------------------------------------------------
           6️⃣ RESPONSE
        -------------------------------------------------- */
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

module.exports = router;