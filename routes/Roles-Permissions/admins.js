const express = require('express');
const { getMySQLConnection } = require('../../config/mysql');
const { auth, requireSLTeamWithTypes } = require('../../middleware/auth');
const { successResponse, errorResponse } = require('../../utils/response');
const bcrypt = require('bcryptjs');
const router = express.Router();


// ==================== ADMIN MANAGEMENT ====================

// ============================
// 🚀 Create Admin Route
// ============================
// @route   POST /api/roles-permissions/create-admin
// @desc    Create admin user directly by SL Team
// @access  Private (SL Team only)
router.post('/create-admin', [
    auth,
    requireSLTeamWithTypes(['superadmin', 'admin'])
], async (req, res) => {
    try {
        const {
            firstName,
            lastName,
            email,
            password,
            phone,
            bio,
            country,
            stateProvince,
            city,
            userType,   // slug coming from frontend
            badges      // array of badge names
        } = req.body;

        const creatorId = req.user.id;
        const mysqlConnection = getMySQLConnection();

        // ========================
        // 🧾 Step 1: Validate Input
        // ========================
        if (!firstName || !lastName || !email || !password) {
            return errorResponse(res, 'First name, last name, email, and password are required', 400);
        }

        const normalizedEmail = email.trim().toLowerCase();

        // ===================================
        // 🔍 Step 2: Validate Badges / Roles
        // ===================================
        let validatedBadges = [];
        let finalUserType = "sub_user";    // DEFAULT for everyone
        let rolePermissions = [];

        if (badges && Array.isArray(badges) && badges.length > 0) {
            const badgeNames = badges.map(b => b.trim()).filter(b => b);

            const placeholders = badgeNames.map(() => '?').join(',');
            const [roleData] = await mysqlConnection.execute(
                `SELECT role_name, slug, permissions 
           FROM role_permissions WHERE role_name IN (${placeholders})`,
                badgeNames
            );

            if (roleData.length !== badgeNames.length) {
                const found = roleData.map(r => r.role_name);
                const missing = badgeNames.filter(b => !found.includes(b));
                return errorResponse(res, `Invalid badge names: ${missing.join(', ')}`, 400);
            }

            validatedBadges = badgeNames;

            // 🚨 Final user_type logic:
            // --------------------------------
            // If ANY badge is "Admin" → user_type = "admin"
            // Else → "sub_user"
            // --------------------------------
            if (roleData.some(r => r.role_name.toLowerCase() === "admin")) {
                finalUserType = "admin";
            }

            // Take permissions from first role
            try {
                rolePermissions = JSON.parse(roleData[0].permissions || '[]');
            } catch {
                rolePermissions = [];
            }

        } else if (userType) {
            // Validate slug
            const [roleData] = await mysqlConnection.execute(
                'SELECT role_name, slug, permissions FROM role_permissions WHERE slug = ?',
                [userType]
            );

            if (roleData.length === 0) {
                return errorResponse(res, 'Invalid user type slug provided', 400);
            }

            validatedBadges = [roleData[0].role_name];

            // 🚨 Final user_type logic:
            if (roleData[0].role_name.toLowerCase() === "admin") {
                finalUserType = "admin";
            } else {
                finalUserType = "sub_user";
            }

            try {
                rolePermissions = JSON.parse(roleData[0].permissions || '[]');
            } catch {
                rolePermissions = [];
            }

        } else {
            // No badges, no userType → default sub_user
            validatedBadges = ['Sub User'];
            finalUserType = "sub_user";
        }

        // ========================
        // 🔍 Step 3: Check Existing User
        // ========================
        const [existingUsers] = await mysqlConnection.execute(
            'SELECT id FROM users WHERE email = ?',
            [normalizedEmail]
        );

        if (existingUsers.length > 0) {
            return errorResponse(res, 'A user with this email already exists', 400);
        }

        // ========================
        // 🔐 Step 4: Hash Password
        // ========================
        const hashedPassword = await bcrypt.hash(password, 12);

        // ========================
        // 🧱 Step 5: Prepare JSON
        // ========================
        const permissionsJson = JSON.stringify(rolePermissions);
        const badgesJson = JSON.stringify(validatedBadges);

        // ========================
        // 💾 Step 6: Insert New Admin
        // ========================
        const [result] = await mysqlConnection.execute(
            `INSERT INTO users (
          first_name, last_name, email, password, phone,
          role, user_type, is_active, is_verified,
          bio, country, state_province, city,
          permissions, badges,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [
                firstName,
                lastName,
                normalizedEmail,
                hashedPassword,
                phone || null,
                "sl_team",
                finalUserType,        // 💥 ONLY "admin" or "sub_user"
                true,
                true,
                bio || null,
                country || null,
                stateProvince || null,
                city || null,
                permissionsJson,
                badgesJson
            ]
        );

        const newAdminId = result.insertId;

        // ========================
        // 📌 Step 7: Fetch New User
        // ========================
        const [newAdmin] = await mysqlConnection.execute(
            `SELECT id, first_name, last_name, email, phone, role, user_type,
                is_active, is_verified, bio, country, state_province, city,
                permissions, badges, created_at
         FROM users WHERE id = ?`,
            [newAdminId]
        );

        // ========================
        // 🎉 Step 8: Response
        // ========================
        return successResponse(
            res,
            {
                admin: {
                    ...newAdmin[0],
                    badges: JSON.parse(newAdmin[0].badges || "[]"),
                    permissions: JSON.parse(newAdmin[0].permissions || "[]")
                }
            },
            "Admin created successfully",
            201
        );

    } catch (error) {
        console.error("Create admin error:", error);
        return errorResponse(res, "Failed to create admin user", 500);
    }
});

// @route   GET /api/roles-permissions/admins
// @desc    Get all admin users
// @access  Private (SL Team only)
router.get('/admins', [auth,
    // requireSLTeamWithTypes(['superadmin', 'admin'])
], async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();

        // Get all admin users
        const [admins] = await mysqlConnection.execute(
            `SELECT id, first_name, last_name, email, phone, role,avatar, user_type,
                is_active, is_verified, bio, country, state_province, city, badges,
                last_login, created_at, updated_at
         FROM users 
         WHERE role = 'sl_team' AND deleted_at IS NULL
         ORDER BY created_at DESC`
        );



        admins.forEach(admin => {
            admin.badges = admin.badges ? JSON.parse(admin.badges) : [];
            // Only add 'Admin' badge if user_type is 'admin' and it's not already in badges
            // if(admin.user_type === 'admin' && !admin.badges.includes('Admin')){
            //   admin.badges.push('Admin');
            // }
        });
        if (req.user.user_type === 'admin') {

            const members = admins.filter((e) => !['admin', 'superadmin'].includes(e.user_type))
            console.log('It is running')
            return successResponse(res, {
                admins: members,
                total: admins.length
            }, 'Admins retrieved successfully', 200);
        }

        return successResponse(res, {
            admins: admins.filter((e) => e.user_type !== "superadmin"),
            total: admins.length
        }, 'Admins retrieved successfully', 200);

    } catch (error) {
        console.error('Get admins error:', error);
        errorResponse(res, 'Failed to get admin users', 500);
    }
});

// @route   PUT /api/roles-permissions/admins/:adminId
// @desc    Assign badges & merge permissions (x / - logic)
// @access  Private (SL Team only)

router.put('/admins/:adminId', [auth, requireSLTeamWithTypes(['superadmin', 'admin'])], async (req, res) => {
    let mysqlConnection;

    try {
        const { adminId } = req.params;
        const { badges = [] } = req.body;

        mysqlConnection = getMySQLConnection();

        console.log(`\n🛠️ Assigning badges to adminId=${adminId}`);

        /* -----------------------------------
           1️⃣ Validate Admin
        ----------------------------------- */
        const [admins] = await mysqlConnection.execute(
            `SELECT id FROM users WHERE id = ? AND role = 'sl_team'`,
            [adminId]
        );

        if (!admins.length) {
            return errorResponse(res, 'Admin not found', 404);
        }

        /* -----------------------------------
           2️⃣ Fetch Badge Permissions
        ----------------------------------- */
        const badgeNames = badges.map(b => b.trim()).filter(Boolean);

        if (!badgeNames.length) {
            return errorResponse(res, 'Badges are required', 400);
        }

        const placeholders = badgeNames.map(() => '?').join(',');

        const [roles] = await mysqlConnection.execute(
            `SELECT role_name, permissions
           FROM role_permissions
           WHERE role_name IN (${placeholders})`,
            badgeNames
        );

        if (roles.length !== badgeNames.length) {
            return errorResponse(res, 'Invalid badge(s) provided', 400);
        }

        /* -----------------------------------
           3️⃣ RECURSIVE MERGE FUNCTION
        ----------------------------------- */
        const mergePermissions = (source, target) => {
            Object.entries(source).forEach(([key, value]) => {
                // If value is "x" → allow
                if (value === 'x') {
                    target[key] = 'x';
                    return;
                }

                // If value is "-" → ignore
                if (value === '-') {
                    return;
                }

                // If value is object → recurse
                if (typeof value === 'object' && value !== null) {
                    if (!target[key]) {
                        target[key] = {};
                    }
                    mergePermissions(value, target[key]);

                    // Clean empty objects
                    if (Object.keys(target[key]).length === 0) {
                        delete target[key];
                    }
                }
            });
        };

        /* -----------------------------------
           4️⃣ MERGE ALL BADGE PERMISSIONS
        ----------------------------------- */
        const finalPermissions = {};

        roles.forEach(role => {
            const perms = JSON.parse(role.permissions || '{}');
            console.log(`🏷️ Processing badge: ${role.role_name}`);
            mergePermissions(perms, finalPermissions);
        });

        console.log('🔥 FINAL MERGED PERMISSIONS:', JSON.stringify(finalPermissions, null, 2));

        /* -----------------------------------
           5️⃣ Save to User
        ----------------------------------- */
        await mysqlConnection.execute(
            `UPDATE users
           SET
             badges = ?,
             permissions = ?,
             user_type = 'sub_user',
             updated_at = NOW()
           WHERE id = ?`,
            [
                JSON.stringify(badgeNames),
                JSON.stringify(finalPermissions),
                adminId
            ]
        );

        /* -----------------------------------
           6️⃣ Response
        ----------------------------------- */
        return successResponse(
            res,
            {
                adminId,
                badges: badgeNames,
                permissions: finalPermissions
            },
            'Badges assigned and permissions merged successfully',
            200
        );

    } catch (err) {
        console.error('❌ Permission merge error:', err);
        return errorResponse(res, 'Failed to assign permissions', 500);
    }
}
);

// =============================================================
// 🚀 PROMOTE EXISTING USER TO SL TEAM (ADMIN) WITH BADGES
// =============================================================
// @route   POST /api/roles-permissions/admins/promote/:userId
// @desc    Promote an existing user to SL Team, set user_type='admin', assign badges and merged permissions
// @access  Private (SL Team only)
router.post('/admins/promote/:userId', [auth, requireSLTeamWithTypes(['superadmin', 'admin'])], async (req, res) => {
    let mysqlConnection;
    try {
        const { userId } = req.params;
        const { badges = [] } = req.body;

        mysqlConnection = getMySQLConnection();

        // 1) Validate user exists
        const [users] = await mysqlConnection.execute(
            'SELECT id, email, role, user_type FROM users WHERE id = ? AND deleted_at IS NULL',
            [userId]
        );
        if (!users.length) {
            return errorResponse(res, 'User not found', 404);
        }

        // 2) Validate badges
        const badgeNames = Array.isArray(badges)
            ? badges.map((b) => String(b).trim()).filter(Boolean)
            : [];
        if (!badgeNames.length) {
            return errorResponse(res, 'Badges are required', 400);
        }

        const placeholders = badgeNames.map(() => '?').join(',');
        const [roles] = await mysqlConnection.execute(
            `SELECT role_name, permissions FROM role_permissions WHERE role_name IN (${placeholders})`,
            badgeNames
        );
        if (roles.length !== badgeNames.length) {
            return errorResponse(res, 'Invalid badge(s) provided', 400);
        }

        // 3) Merge permissions using x / - logic
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

        const finalPermissions = {};
        roles.forEach((r) => {
            const perms = JSON.parse(r.permissions || '{}');
            mergePermissions(perms, finalPermissions);
        });

        // 4) Update user: set role to sl_team, user_type to sub_user, badges and permissions
        await mysqlConnection.execute(
            `UPDATE users
           SET role = 'sl_team',
               user_type = 'sub_user',
               badges = ?,
               permissions = ?,
               updated_at = NOW()
           WHERE id = ?`,
            [JSON.stringify(badgeNames), JSON.stringify(finalPermissions), userId]
        );

        return successResponse(
            res,
            { userId: parseInt(userId, 10), badges: badgeNames, permissions: finalPermissions },
            'User promoted to SL Team successfully',
            200
        );
    } catch (err) {
        console.error('❌ Promote user to SL Team error:', err);
        return errorResponse(res, 'Failed to promote user', 500);
    }
}
);


// @route   PUT /api/roles-permissions/admins/:adminId/change-password
// @desc    Change admin password
// @access  Private (SL Team only)
router.put('/admins/:adminId/change-password', [auth, requireSLTeamWithTypes(['superadmin', 'admin'])], async (req, res) => {
    try {
        const { adminId } = req.params;
        const { newPassword } = req.body;

        const changerId = req.user.id;
        const mysqlConnection = getMySQLConnection();
        const bcrypt = require('bcryptjs');

        if (!newPassword) {
            return errorResponse(res, 'New password is required', 400);
        }

        // Check if admin exists
        const [admins] = await mysqlConnection.execute(
            'SELECT id, email FROM users WHERE id = ? AND role = "admin"',
            [adminId]
        );

        if (admins.length === 0) {
            return errorResponse(res, 'Admin user not found', 404);
        }

        const admin = admins[0];

        // Hash new password
        const hashedPassword = await bcrypt.hash(newPassword, 12);

        // Update password
        await mysqlConnection.execute(
            'UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?',
            [hashedPassword, adminId]
        );

        // Log the password change
        console.log(`Admin ${admin.email} password changed by ${changerId}`);

        successResponse(res, {
            adminId: parseInt(adminId),
            changedBy: changerId
        }, 'Admin password changed successfully', 200);

    } catch (error) {
        console.error('Change admin password error:', error);
        errorResponse(res, 'Failed to change admin password', 500);
    }
});

// @route   DELETE /api/roles-permissions/admins/:adminId
// @desc    Delete admin user (soft delete)
// @access  Private (SL Team only)
router.delete('/admins/:adminId', [auth, requireSLTeamWithTypes(['superadmin', 'admin'])], async (req, res) => {
    try {
        const { adminId } = req.params;
        const { reason } = req.body;

        const deleterId = req.user.id;
        const mysqlConnection = getMySQLConnection();

        // Check if admin exists
        const [admins] = await mysqlConnection.execute(
            'SELECT id, first_name, last_name, email, user_type FROM users WHERE id = ? AND user_type = "admin"',
            [adminId]
        );

        if (admins.length === 0) {
            return errorResponse(res, 'Admin user not found', 404);
        }

        const admin = admins[0];

        // Prevent deleting yourself
        if (parseInt(adminId) === deleterId) {
            return errorResponse(res, 'You cannot delete yourself', 400);
        }

        // Soft delete admin (set deleted_at timestamp)
        await mysqlConnection.execute(
            'UPDATE users SET deleted_at = NOW(), is_active = FALSE, updated_at = NOW() WHERE id = ?',
            [adminId]
        );

        // Log the deletion
        console.log(`Admin ${admin.email} deleted by ${deleterId}. Reason: ${reason || 'No reason provided'}`);

        successResponse(res, {
            adminId: parseInt(adminId),
            admin: {
                id: admin.id,
                name: `${admin.first_name} ${admin.last_name}`,
                email: admin.email
            },
            deletedBy: deleterId,
            reason: reason || null
        }, 'Admin deleted successfully', 200);

    } catch (error) {
        console.error('Delete admin error:', error);
        errorResponse(res, 'Failed to delete admin user', 500);
    }
});



module.exports = router;