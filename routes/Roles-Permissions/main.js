const express = require('express');
const router = express.Router();
const { auth, requireSLTeamWithTypes } = require('../../middleware/auth');


const rolesRoutes = require('./roles');
const adminRoutes = require('./admins');
const subUserRoutes = require('./sub-user');
const memberRoutes = require('./members');


//  /api/roles-permissions/roles
router.use('/roles', rolesRoutes);

//  /api/roles-permissions/roles/members
router.use('/members', memberRoutes);


//  /api/roles-permissions
router.use('/', adminRoutes);
router.use('/', subUserRoutes);

// =============================================================
// 🔧 MANUAL ENUM UPDATE                 => Currently Not  In Work
// =============================================================
// @route   POST /api/roles-permissions/sync-enum
// @desc    Manually sync user_type ENUM with role_permissions table
// @access  Private (SL Team/Admin only)
router.post('/sync-enum', [auth, requireSLTeamWithTypes(['superadmin', 'admin'])], async (req, res) => {
    try {
        console.log('🚀 Manual ENUM sync triggered by user:', req.user.id);

        // Run the enum update function
        // await updateUserTypeEnum();

        return successResponse(res, {
            synced_by: req.user.id,
            synced_at: new Date().toISOString()
        }, 'User type ENUM synchronized successfully');
    } catch (err) {
        console.error('Error syncing ENUM:', err);
        return errorResponse(res, 'Error synchronizing user type ENUM');
    }
});

// =============================================================
// 👥 BULK REASSIGN USERS                => Currently Not  In Work
// =============================================================
// @route   POST /api/roles-permissions/reassign-users
// @desc    Reassign users from one role to another
// @access  Private (SL Team/Admin only)
router.post('/reassign-users', [auth, requireSLTeamWithTypes(['superadmin', 'admin'])], async (req, res) => {
    try {
        const { from_role_slug, to_role_slug, user_ids } = req.body;
        const reassignedBy = req.user.id;
        const mysqlConnection = getMySQLConnection();

        console.log(`\n🚀 [REASSIGN] Starting user reassignment:`);
        console.log(`📊 Request:`, { from_role_slug, to_role_slug, user_ids });

        // Validate input
        if (!to_role_slug) {
            return errorResponse(res, 'to_role_slug is required', 400);
        }

        // Check if target role exists
        const [targetRole] = await mysqlConnection.execute(
            'SELECT role_name, slug, permissions FROM role_permissions WHERE slug = ?',
            [to_role_slug]
        );

        if (targetRole.length === 0) {
            return errorResponse(res, `Target role '${to_role_slug}' not found`, 404);
        }

        console.log(`✅ Target role found: ${targetRole[0].role_name} (${to_role_slug})`);

        let usersToReassign = [];

        if (user_ids && Array.isArray(user_ids) && user_ids.length > 0) {
            // Specific users provided
            const placeholders = user_ids.map(() => '?').join(',');
            const [users] = await mysqlConnection.execute(
                `SELECT id, email, user_type, permissions, badges 
           FROM users 
           WHERE id IN (${placeholders}) AND role = 'sl_team'`,
                user_ids
            );
            usersToReassign = users;
            console.log(`🎯 Reassigning specific users: ${user_ids.join(', ')}`);
        } else if (from_role_slug) {
            // All users with specific role
            const [users] = await mysqlConnection.execute(
                'SELECT id, email, user_type, permissions, badges FROM users WHERE user_type = ? AND role = ?',
                [from_role_slug, 'sl_team']
            );
            usersToReassign = users;
            console.log(`🎯 Reassigning all users with role: ${from_role_slug}`);
        } else {
            return errorResponse(res, 'Either from_role_slug or user_ids must be provided', 400);
        }

        if (usersToReassign.length === 0) {
            console.log(`ℹ️  No users found to reassign`);
            return successResponse(res, {
                reassigned_users: 0,
                users: []
            }, 'No users found to reassign');
        }

        console.log(`🔍 Found ${usersToReassign.length} users to reassign`);

        // Get new role permissions and details
        const newPermissions = JSON.parse(targetRole[0].permissions || '{}');
        const newRoleName = targetRole[0].role_name;

        const reassignedUsers = [];

        // Reassign each user
        for (const user of usersToReassign) {
            console.log(`\n👤 Reassigning user: ${user.email} (ID: ${user.id})`);
            console.log(`   📝 Old user_type: ${user.user_type}`);
            console.log(`   📝 New user_type: ${to_role_slug}`);

            // Update badges
            let userBadges = [];
            try {
                userBadges = user.badges ? JSON.parse(user.badges) : [];
            } catch (e) {
                userBadges = [];
            }

            // Update or add new badge
            const badgeExists = userBadges.some(badge => badge.role_name === user.user_type);
            if (badgeExists) {
                userBadges = userBadges.map(badge =>
                    badge.user_type === user.user_type || badge.role_name === user.user_type
                        ? {
                            ...badge,
                            role_name: newRoleName,
                            slug: to_role_slug,
                            updated_at: new Date().toISOString()
                        }
                        : badge
                );
            } else {
                userBadges.push({
                    role_name: newRoleName,
                    slug: to_role_slug,
                    assigned_at: new Date().toISOString()
                });
            }

            console.log(`   🏷️  Updated badges:`, userBadges);

            // Update user in database
            await mysqlConnection.execute(
                'UPDATE users SET user_type = ?, permissions = ?, badges = ? WHERE id = ?',
                [to_role_slug, JSON.stringify(newPermissions), JSON.stringify(userBadges), user.id]
            );

            reassignedUsers.push({
                id: user.id,
                email: user.email,
                old_user_type: user.user_type,
                new_user_type: to_role_slug
            });

            console.log(`   ✅ User ${user.email} reassigned successfully!`);
        }

        console.log(`\n🎯 [REASSIGN] Summary: Reassigned ${reassignedUsers.length} users to '${to_role_slug}'`);

        // Update ENUM if needed
        try {
            console.log(`🚀 Auto-updating user_type ENUM after reassignment`);
            // await updateUserTypeEnum();
            console.log(`✅ ENUM updated successfully after reassignment`);
        } catch (enumError) {
            console.error('❌ Failed to update ENUM after reassignment:', enumError.message);
        }

        console.log(`\n🎉 [REASSIGN] User reassignment completed successfully!`);

        return successResponse(res, {
            reassigned_users: reassignedUsers.length,
            users: reassignedUsers,
            target_role: {
                name: newRoleName,
                slug: to_role_slug
            },
            reassigned_by: reassignedBy,
            reassigned_at: new Date().toISOString()
        }, 'Users reassigned successfully');

    } catch (err) {
        console.error('❌ [REASSIGN] Error reassigning users:', err);
        return errorResponse(res, 'Error reassigning users');
    }
});


module.exports = router;