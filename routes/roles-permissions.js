const express = require('express');
const { getMySQLConnection } = require('../config/mysql');
const { auth, requireSLTeamWithTypes } = require('../middleware/auth');
// const { requireAnyRole } = require('../middleware/roleAuth');
const { successResponse, errorResponse } = require('../utils/response');
// const { updateUserTypeEnum, addNewRoleToEnum, removeRoleFromEnum } = require('../utils/updateUserTypeEnum');
const bcrypt = require('bcryptjs');



const slugify = (text) => {
  return text.toLowerCase().trim()
    .replace(/\s+/g, '_')
    .replace(/[()]/g, '')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .trim();
}
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



// ================================ SL TEAM / ADMIN Roles ROUTES ================================

// =============================================================
// 🟢 CREATE ROLE PERMISSION
// =============================================================
// @route   POST /api/roles-permissions/roles
// @desc    Create a new role with defined permissions
// @access  Private (SL Team/Admin only)
router.post('/roles', async (req, res) => {
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
router.get('/roles', async (req, res) => {
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
router.get('/roles/:role_name', async (req, res) => {
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
router.put('/roles/:role_name', async (req, res) => {
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
// @desc    Partially update multiple nested permission fields for a role
// @access  Private (SL Team/Admin only)
// =============================================================
// 🟤 PARTIAL UPDATE — MULTIPLE NESTED FIELDS
// =============================================================
// @route   PATCH /api/roles-permissions/roles/update-multiple
// @desc    Partially update role permissions & reflect to all users having that badge
// @access  Private (SL Team/Admin only)

router.patch('/roles/update-multiple', [auth, 
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
// @desc    Delete a role and its permissions
// @access  Private (SL Team/Admin only)
router.delete('/roles/:role_name', [auth, requireSLTeamWithTypes(['superadmin', 'admin'])], async (req, res) => {
  const mysqlConnection = getMySQLConnection();
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
      `SELECT id, email, badges
         FROM users
         WHERE JSON_CONTAINS(badges, JSON_QUOTE(?))`,
      [role_name]
    );

    console.log(`👥 Users with badge "${role_name}": ${users.length}`);

    /* --------------------------------------------------
       3️⃣ MERGE PERMISSION FUNCTION (SAME AS PATCH)
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
       4️⃣ UPDATE EACH USER
    -------------------------------------------------- */
    for (const user of users) {
      console.log(`🔧 Fixing user: ${user.email}`);

      let userBadges = [];
      try {
        userBadges = JSON.parse(user.badges || '[]');
      } catch {
        userBadges = [];
      }

      // Remove deleted badge
      const remainingBadges = userBadges.filter(b => b !== role_name);

      let finalPermissions = {};
      let finalUserType = 'free_user';
      let finalRole = 'free_user';

      if (remainingBadges.length > 0) {
        const placeholders = remainingBadges.map(() => '?').join(',');

        const [remainingRoles] = await mysqlConnection.execute(
          `SELECT role_name, permissions
             FROM role_permissions
             WHERE role_name IN (${placeholders})`,
          remainingBadges
        );

        // Merge permissions
        remainingRoles.forEach(r => {
          const perms = JSON.parse(r.permissions || '{}');
          mergePermissions(perms, finalPermissions);
        });

        finalRole = 'sl_team';

        // user_type logic
        if (remainingBadges.some(b => b.toLowerCase() === 'admin')) {
          finalUserType = 'admin';
        } else {
          finalUserType = 'sub_user';
        }
      }

      await mysqlConnection.execute(
        `UPDATE users
           SET badges = ?, permissions = ?, role = ?, user_type = ?, updated_at = NOW()
           WHERE id = ?`,
        [
          JSON.stringify(remainingBadges),
          JSON.stringify(finalPermissions),
          finalRole,
          finalUserType,
          user.id
        ]
      );

      console.log(`✅ User fixed: ${user.email}`);
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
      'Role deleted, badges & permissions updated successfully',
      200
    );

  } catch (error) {
    console.error('❌ DELETE ROLE ERROR:', error);
    return errorResponse(res, 'Failed to delete role', 500);
  }
}
);

// =============================================================
// 🔧 MANUAL ENUM UPDATE
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
// 👥 BULK REASSIGN USERS
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


// ==================== USER ADMIN MANAGEMENT ====================


// =============================================================
// CREATE SUB-USER (Child Account under Parent User)
// =============================================================
// @route   POST /api/roles-permissions/create-subuser
// @desc    Create a sub-user under the authenticated parent user (based on plan limits)
// @access  Private (Parent User)
router.post('/create-subuser', auth, async (req, res) => {
  try {
    const parentUser = req.user;
    const { first_name, last_name, email, password, phone } = req.body;

    // Validate required fields
    if (!first_name || !last_name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'First name, last name, email, and password are required.'
      });
    }

    // Check if parent user has an active plan
    if (parentUser.plan_status !== 'active') {
      return res.status(403).json({
        success: false,
        message: 'You need an active plan to create sub-users.'
      });
    }

    // Parse plan permissions if it's a string
    let planPermissions = parentUser.plan_permissions;

    if (typeof planPermissions === 'string') {
      try {
        planPermissions = JSON.parse(planPermissions);
      } catch (e) {
        console.error('Failed to parse plan_permissions:', e);
      }
    }

    console.log('📦 Parsed planPermissions:', planPermissions);
    console.log('📦 Type:', typeof planPermissions);
    console.log('📦 Has Member Limit:', planPermissions?.['Member Limit']);
    console.log('📦 Has Users:', planPermissions?.['Member Limit']?.['Members']);

    if (!planPermissions || !planPermissions['Member Limit'] || !planPermissions['Member Limit']['Members']) {
      return res.status(403).json({
        success: false,
        message: 'Your plan does not support sub-user creation.'
      });
    }

    const userLimit = planPermissions['Member Limit']['Members'].limit || 0;
    const usedUsers = planPermissions['Member Limit']['Members'].used || 0;

    // Calculate available slots (parent user counts as 1)
    const availableSlots = userLimit - 1;
    const currentSubUsers = parentUser.active_sub_users_count || 0;

    console.log('🔍 Sub-user creation check:', {
      totalLimit: userLimit,
      availableSlots,
      currentSubUsers,
      canCreate: currentSubUsers < availableSlots
    });

    if (currentSubUsers >= availableSlots) {
      return res.status(403).json({
        success: false,
        message: `Sub-user limit reached. You can create maximum ${availableSlots} sub-users. Currently you have ${currentSubUsers} sub-users.`
      });
    }

    const mysqlConnection = getMySQLConnection();

    // Check if email already exists
    const [existingUsers] = await mysqlConnection.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUsers.length > 0) {
      return res.status(400).json({
        success: false, message: 'Email already exists.'
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Calculate plan end date same as parent
    const planEndDate = parentUser.plan_end_date;

    // Create sub-user
    const [result] = await mysqlConnection.execute(
      `INSERT INTO users (
        first_name, 
        last_name, 
        email, 
        password, 
        phone,
        role,
        user_type,
        parent_user_id,
        current_plan_id,
        plan_start_date,
        plan_end_date,
        plan_status,
        plan_permissions,
        custom_permissions,
        max_sub_users,
        is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, NULL, NULL, 0, TRUE)`,
      [
        first_name,
        last_name,
        email,
        hashedPassword,
        phone || null,
        'user',
        'sub_user',
        parentUser.id,
        parentUser.current_plan_id,
        planEndDate,
        'active'
      ]
    );

    // Update parent user's active_sub_users_count
    await mysqlConnection.execute('UPDATE users SET active_sub_users_count = active_sub_users_count + 1 WHERE id = ?', [parentUser.id]);

    // Update used count in plan_permissions
    const updatedPlanPermissions = { ...planPermissions };
    updatedPlanPermissions['Member Limit']['Members'].used = usedUsers + 1;

    await mysqlConnection.execute('UPDATE users SET plan_permissions = ? WHERE id = ?', [JSON.stringify(updatedPlanPermissions), parentUser.id]);

    // Fetch created sub-user (without password)
    const [createdSubUsers] = await mysqlConnection.execute(
      'SELECT id, first_name, last_name, email, phone, role, user_type, parent_user_id, current_plan_id, plan_status, created_at FROM users WHERE id = ?',
      [result.insertId]
    );

    res.status(201).json({
      success: true, message: 'Sub-user created successfully.', data: {
        subUser: createdSubUsers[0], remainingSlots: availableSlots - currentSubUsers - 1
      }
    });

  } catch (error) {
    console.error('Create sub-user error:', error);
    res.status(500).json({
      success: false, message: 'Internal server error.', error: error.message
    });
  }
});


// =============================================================
// GET ALL SUB-USERS
// =============================================================
// @route   GET /api/roles-permissions/sub-users
// @desc    Fetch all sub-users created under the authenticated admin (parent) user
// @access  Private (Admin User)
router.get('/sub-users', auth, async (req, res) => {
  try {
    const parentUser = req.user;

    // Only admin users can have sub-users
    if (parentUser.user_type !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin users can view sub-users.'
      });
    }

    const mysqlConnection = getMySQLConnection();

    // Fetch all sub-users of this parent
    const [subUsers] = await mysqlConnection.execute(
      `SELECT 
        id, 
        first_name, 
        last_name, 
        email, 
        phone,
        role,
        user_type,
        parent_user_id,
        current_plan_id,
        plan_start_date,
        plan_end_date,
        plan_status,
        is_active,
        is_verified,
        last_login,
        created_at,
        updated_at
      FROM users 
      WHERE parent_user_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC`,
      [parentUser.id]
    );

    res.status(200).json({
      success: true,
      message: 'Sub-users fetched successfully.',
      data: {
        total: subUsers.length,
        availableSlots: parentUser.plan_permissions ?
          (JSON.parse(typeof parentUser.plan_permissions === 'string' ? parentUser.plan_permissions : JSON.stringify(parentUser.plan_permissions))['Member Limit']?.['Members']?.limit - 1 || 0) : 0,
        usedSlots: parentUser.active_sub_users_count || 0,
        subUsers
      }
    });

  } catch (error) {
    console.error('Fetch sub-users error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error.',
      error: error.message
    });
  }
});


// =============================================================
// GET SINGLE SUB-USER BY ID
// =============================================================
// @route   GET /api/roles-permissions/sub-users/:id
// @desc    Fetch a specific sub-user by ID (must belong to authenticated admin)
// @access  Private (Admin User)
router.get('/sub-users/:id', auth, async (req, res) => {
  try {
    const parentUser = req.user;
    const subUserId = req.params.id;

    if (parentUser.user_type !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin users can view sub-users.'
      });
    }

    const mysqlConnection = getMySQLConnection();

    // Fetch sub-user and verify it belongs to this parent
    const [subUsers] = await mysqlConnection.execute(
      `SELECT 
        id, 
        first_name, 
        last_name, 
        email, 
        phone,
        role,
        user_type,
        parent_user_id,
        current_plan_id,
        plan_start_date,
        plan_end_date,
        plan_status,
        is_active,
        is_verified,
        last_login,
        created_at,
        updated_at
      FROM users 
      WHERE id = ? AND parent_user_id = ? AND deleted_at IS NULL`,
      [subUserId, parentUser.id]
    );

    if (subUsers.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Sub-user not found or does not belong to you.'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Sub-user fetched successfully.',
      data: {
        subUser: subUsers[0]
      }
    });

  } catch (error) {
    console.error('Fetch sub-user error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error.',
      error: error.message
    });
  }
});


// =============================================================
// UPDATE SUB-USER DETAILS
// =============================================================
// @route   PUT /api/roles-permissions/sub-users/:id
// @desc    Update sub-user details like name, email, phone, or password
// @access  Private (Admin User)
router.put('/sub-users/:id', auth, async (req, res) => {
  try {
    const parentUser = req.user;
    const subUserId = req.params.id;
    const { first_name, last_name, email, phone, password } = req.body;

    if (parentUser.user_type !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin users can edit sub-users.'
      });
    }

    const mysqlConnection = getMySQLConnection();

    // Verify sub-user belongs to this parent
    const [subUsers] = await mysqlConnection.execute(
      'SELECT id, email FROM users WHERE id = ? AND parent_user_id = ? AND deleted_at IS NULL',
      [subUserId, parentUser.id]
    );

    if (subUsers.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Sub-user not found or does not belong to you.'
      });
    }

    // If email is being changed, check if new email exists
    if (email && email !== subUsers[0].email) {
      const [existingUsers] = await mysqlConnection.execute(
        'SELECT id FROM users WHERE email = ? AND id != ?',
        [email, subUserId]
      );

      if (existingUsers.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Email already exists.'
        });
      }
    }

    // Build update query dynamically
    const updateFields = [];
    const updateValues = [];

    if (first_name) {
      updateFields.push('first_name = ?');
      updateValues.push(first_name);
    }
    if (last_name) {
      updateFields.push('last_name = ?');
      updateValues.push(last_name);
    }
    if (email) {
      updateFields.push('email = ?');
      updateValues.push(email);
    }
    if (phone !== undefined) {
      updateFields.push('phone = ?');
      updateValues.push(phone || null);
    }
    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      updateFields.push('password = ?');
      updateValues.push(hashedPassword);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update.'
      });
    }

    updateValues.push(subUserId);

    await mysqlConnection.execute(
      `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`,
      updateValues
    );

    // Fetch updated sub-user
    const [updatedSubUsers] = await mysqlConnection.execute(
      `SELECT 
        id, first_name, last_name, email, phone, role, user_type, 
        parent_user_id, current_plan_id, plan_status, is_active, updated_at
      FROM users WHERE id = ?`,
      [subUserId]
    );

    res.status(200).json({
      success: true,
      message: 'Sub-user updated successfully.',
      data: {
        subUser: updatedSubUsers[0]
      }
    });

  } catch (error) {
    console.error('Update sub-user error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error.',
      error: error.message
    });
  }
});

// =============================================================
// TOGGLE SUB-USER STATUS (ACTIVATE / DEACTIVATE)
// =============================================================
// @route   PATCH /api/roles-permissions/sub-users/:id/toggle-status
// @desc    Activate or deactivate a sub-user account
// @access  Private (Admin User)
router.patch('/sub-users/:id/toggle-status', auth, async (req, res) => {
  try {
    const parentUser = req.user;
    const subUserId = req.params.id;

    if (parentUser.user_type !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin users can change sub-user status.'
      });
    }

    const mysqlConnection = getMySQLConnection();

    // Verify sub-user belongs to this parent
    const [subUsers] = await mysqlConnection.execute(
      'SELECT id, is_active FROM users WHERE id = ? AND parent_user_id = ? AND deleted_at IS NULL',
      [subUserId, parentUser.id]
    );

    if (subUsers.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Sub-user not found or does not belong to you.'
      });
    }

    const currentStatus = subUsers[0].is_active;
    const newStatus = !currentStatus;

    // Toggle is_active status
    await mysqlConnection.execute(
      'UPDATE users SET is_active = ? WHERE id = ?',
      [newStatus, subUserId]
    );

    res.status(200).json({
      success: true,
      message: `Sub-user ${newStatus ? 'activated' : 'deactivated'} successfully.`,
      data: {
        subUserId: subUserId,
        is_active: newStatus
      }
    });

  } catch (error) {
    console.error('Toggle sub-user status error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error.',
      error: error.message
    });
  }
});

// =============================================================
// DELETE SUB-USER (SOFT DELETE)
// =============================================================
// @route   DELETE /api/roles-permissions/sub-users/:id
// @desc    Soft delete a sub-user account (mark as deleted, decrease active count)
// @access  Private (Admin User)
router.delete('/sub-users/:id', auth, async (req, res) => {
  try {
    const parentUser = req.user;
    const subUserId = req.params.id;

    if (parentUser.user_type !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin users can delete sub-users.'
      });
    }

    const mysqlConnection = getMySQLConnection();

    // Verify sub-user belongs to this parent
    const [subUsers] = await mysqlConnection.execute(
      'SELECT id FROM users WHERE id = ? AND parent_user_id = ? AND deleted_at IS NULL',
      [subUserId, parentUser.id]
    );

    if (subUsers.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Sub-user not found or does not belong to you.'
      });
    }

    // Soft delete - set deleted_at timestamp
    await mysqlConnection.execute(
      'UPDATE users SET deleted_at = NOW(), is_active = FALSE WHERE id = ?',
      [subUserId]
    );

    // Decrease parent's active_sub_users_count
    await mysqlConnection.execute(
      'UPDATE users SET active_sub_users_count = GREATEST(active_sub_users_count - 1, 0) WHERE id = ?',
      [parentUser.id]
    );

    // Update used count in plan_permissions
    let planPermissions = parentUser.plan_permissions;

    if (typeof planPermissions === 'string') {
      planPermissions = JSON.parse(planPermissions);
    }

    if (planPermissions && planPermissions['Member Limit'] && planPermissions['Member Limit']['Members']) {
      const currentUsed = planPermissions['Member Limit']['Members'].used || 0;
      planPermissions['Member Limit']['Members'].used = Math.max(currentUsed - 1, 0);

      await mysqlConnection.execute(
        'UPDATE users SET plan_permissions = ? WHERE id = ?',
        [JSON.stringify(planPermissions), parentUser.id]
      );
    }

    res.status(200).json({
      success: true,
      message: 'Sub-user deleted successfully.',
      data: {
        deletedSubUserId: subUserId
      }
    });

  } catch (error) {
    console.error('Delete sub-user error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error.',
      error: error.message
    });
  }
});




// =============================================================
// GET AVAILABLE PERMISSIONS FOR SUB-USER
// =============================================================
// @route   GET /api/roles-permissions/sub-users/:id/available-permissions
// @desc    Fetch all permissions available under parent’s plan to assign to sub-user
// @access  Private (Admin User)
router.get('/sub-users/:id/available-permissions', auth, async (req, res) => {
  try {
    const parentUser = req.user;
    const subUserId = req.params.id;

    if (parentUser.user_type !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin users can manage sub-user permissions.'
      });
    }

    const mysqlConnection = getMySQLConnection();

    // Verify sub-user belongs to parent
    const [subUsers] = await mysqlConnection.execute(
      'SELECT id, first_name, last_name, email, custom_permissions FROM users WHERE id = ? AND parent_user_id = ? AND deleted_at IS NULL',
      [subUserId, parentUser.id]
    );

    if (subUsers.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Sub-user not found.'
      });
    }

    // Parse parent's plan permissions
    let planPermissions = parentUser.plan_permissions;
    if (typeof planPermissions === 'string') {
      planPermissions = JSON.parse(planPermissions);
    }

    // Parse sub-user's current custom permissions
    let currentPermissions = subUsers[0].custom_permissions;
    if (currentPermissions && typeof currentPermissions === 'string') {
      currentPermissions = JSON.parse(currentPermissions);
    }

    // Remove Member Limit from available permissions (not assignable to sub-users)
    const availablePermissions = { ...planPermissions };
    delete availablePermissions['Member Limit'];

    res.status(200).json({
      success: true,
      message: 'Available permissions fetched successfully.',
      data: {
        subUser: {
          id: subUsers[0].id,
          name: `${subUsers[0].first_name} ${subUsers[0].last_name}`,
          email: subUsers[0].email
        },
        availablePermissions: availablePermissions,
        currentPermissions: currentPermissions || {},
        note: 'Parent can assign any combination of these permissions to sub-user'
      }
    });

  } catch (error) {
    console.error('Fetch available permissions error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error.',
      error: error.message
    });
  }
});

// =============================================================
// UPDATE SUB-USER PERMISSIONS (BULK ASSIGN OR REMOVE)
// =============================================================
// @route   PUT /api/roles-permissions/sub-users/:id/permissions
// @desc    Replace or update sub-user’s permissions in bulk
// @access  Private (Admin User)
router.put('/sub-users/:id/permissions', auth, async (req, res) => {
  try {
    const parentUser = req.user;
    const subUserId = req.params.id;
    const { permissions } = req.body;

    if (parentUser.user_type !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin users can manage sub-user permissions.'
      });
    }

    if (!permissions || typeof permissions !== 'object') {
      return res.status(400).json({
        success: false,
        message: 'Permissions object is required.'
      });
    }

    const mysqlConnection = getMySQLConnection();

    // Verify sub-user belongs to parent
    const [subUsers] = await mysqlConnection.execute(
      'SELECT id, first_name, last_name FROM users WHERE id = ? AND parent_user_id = ? AND deleted_at IS NULL',
      [subUserId, parentUser.id]
    );

    if (subUsers.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Sub-user not found.'
      });
    }

    // Parse parent's plan permissions
    let planPermissions = parentUser.plan_permissions;
    if (typeof planPermissions === 'string') {
      planPermissions = JSON.parse(planPermissions);
    }

    // Validate: Check if requested permissions exist in parent's plan
    const validatedPermissions = {};

    for (const [category, categoryPerms] of Object.entries(permissions)) {
      // Skip Member Limit - not assignable to sub-users
      if (category === 'Member Limit') {
        continue;
      }

      // Check if category exists in parent's plan
      if (!planPermissions[category]) {
        return res.status(400).json({
          success: false,
          message: `Category "${category}" not found in parent's plan.`
        });
      }

      validatedPermissions[category] = {};

      for (const [permKey, permValue] of Object.entries(categoryPerms)) {
        // Check if permission exists in parent's plan
        if (!planPermissions[category][permKey]) {
          return res.status(400).json({
            success: false,
            message: `Permission "${permKey}" in category "${category}" not found in parent's plan.`
          });
        }

        // Assign the same permission value as parent has
        validatedPermissions[category][permKey] = planPermissions[category][permKey];
      }
    }

    // Update sub-user's custom_permissions
    await mysqlConnection.execute(
      'UPDATE users SET custom_permissions = ? WHERE id = ?',
      [JSON.stringify(validatedPermissions), subUserId]
    );

    res.status(200).json({
      success: true,
      message: 'Sub-user permissions updated successfully.',
      data: {
        subUser: {
          id: subUserId,
          name: `${subUsers[0].first_name} ${subUsers[0].last_name}`
        },
        assignedPermissions: validatedPermissions
      }
    });

  } catch (error) {
    console.error('Update sub-user permissions error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error.',
      error: error.message
    });
  }
});

// =============================================================
// ASSIGN SPECIFIC PERMISSION TO SUB-USER
// =============================================================
// @route   POST /api/roles-permissions/sub-users/:id/permissions/assign
// @desc    Assign a single permission (category & permission) to a sub-user
// @access  Private (Admin User)
router.post('/sub-users/:id/permissions/assign', auth, async (req, res) => {
  try {
    const parentUser = req.user;
    const subUserId = req.params.id;
    const { category, permission } = req.body;

    if (parentUser.user_type !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin users can assign permissions.'
      });
    }

    if (!category || !permission) {
      return res.status(400).json({
        success: false,
        message: 'Category and permission are required.'
      });
    }

    if (category === 'Member Limit') {
      return res.status(400).json({
        success: false,
        message: 'Member Limit cannot be assigned to sub-users.'
      });
    }

    const mysqlConnection = getMySQLConnection();

    // Verify sub-user
    const [subUsers] = await mysqlConnection.execute(
      'SELECT id, custom_permissions FROM users WHERE id = ? AND parent_user_id = ? AND deleted_at IS NULL',
      [subUserId, parentUser.id]
    );

    if (subUsers.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Sub-user not found.'
      });
    }

    // Parse parent's plan permissions
    let planPermissions = parentUser.plan_permissions;
    if (typeof planPermissions === 'string') {
      planPermissions = JSON.parse(planPermissions);
    }

    // Validate permission exists in parent's plan
    if (!planPermissions[category] || !planPermissions[category][permission]) {
      return res.status(400).json({
        success: false,
        message: `Permission "${permission}" in category "${category}" not found in parent's plan.`
      });
    }

    // Parse current custom permissions
    let customPermissions = subUsers[0].custom_permissions;
    if (customPermissions && typeof customPermissions === 'string') {
      customPermissions = JSON.parse(customPermissions);
    } else if (!customPermissions) {
      customPermissions = {};
    }

    // Add the permission
    if (!customPermissions[category]) {
      customPermissions[category] = {};
    }
    customPermissions[category][permission] = planPermissions[category][permission];

    // Update in database
    await mysqlConnection.execute(
      'UPDATE users SET custom_permissions = ? WHERE id = ?',
      [JSON.stringify(customPermissions), subUserId]
    );

    res.status(200).json({
      success: true,
      message: 'Permission assigned successfully.',
      data: {
        subUserId: subUserId,
        assignedPermission: {
          category: category,
          permission: permission,
          value: planPermissions[category][permission]
        },
        allPermissions: customPermissions
      }
    });

  } catch (error) {
    console.error('Assign permission error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error.',
      error: error.message
    });
  }
});

// =============================================================
// REMOVE SPECIFIC PERMISSION FROM SUB-USER
// =============================================================
// @route   DELETE /api/roles-permissions/sub-users/:id/permissions/remove
// @desc    Remove a single permission (category & permission) from sub-user
// @access  Private (Admin User)
router.delete('/sub-users/:id/permissions/remove', auth, async (req, res) => {
  try {
    const parentUser = req.user;
    const subUserId = req.params.id;
    const { category, permission } = req.body;

    if (parentUser.user_type !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin users can remove permissions.'
      });
    }

    if (!category || !permission) {
      return res.status(400).json({
        success: false,
        message: 'Category and permission are required.'
      });
    }

    const mysqlConnection = getMySQLConnection();

    // Verify sub-user
    const [subUsers] = await mysqlConnection.execute(
      'SELECT id, custom_permissions FROM users WHERE id = ? AND parent_user_id = ? AND deleted_at IS NULL',
      [subUserId, parentUser.id]
    );

    if (subUsers.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Sub-user not found.'
      });
    }

    // Parse current custom permissions
    let customPermissions = subUsers[0].custom_permissions;
    if (customPermissions && typeof customPermissions === 'string') {
      customPermissions = JSON.parse(customPermissions);
    }

    if (!customPermissions || !customPermissions[category] || !customPermissions[category][permission]) {
      return res.status(404).json({
        success: false,
        message: 'Permission not found in sub-user\'s permissions.'
      });
    }

    // Remove the permission
    delete customPermissions[category][permission];

    // If category is empty, remove it
    if (Object.keys(customPermissions[category]).length === 0) {
      delete customPermissions[category];
    }

    // Update in database
    const finalPermissions = Object.keys(customPermissions).length > 0 ? customPermissions : null;

    await mysqlConnection.execute(
      'UPDATE users SET custom_permissions = ? WHERE id = ?',
      [finalPermissions ? JSON.stringify(finalPermissions) : null, subUserId]
    );

    res.status(200).json({
      success: true,
      message: 'Permission removed successfully.',
      data: {
        subUserId: subUserId,
        removedPermission: {
          category: category,
          permission: permission
        },
        remainingPermissions: finalPermissions || {}
      }
    });

  } catch (error) {
    console.error('Remove permission error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error.',
      error: error.message
    });
  }
});

// =============================================================
// CLEAR ALL PERMISSIONS FROM SUB-USER
// =============================================================
// @route   DELETE /api/roles-permissions/sub-users/:id/permissions/clear
// @desc    Remove all permissions assigned to a sub-user
// @access  Private (Admin User)
router.delete('/sub-users/:id/permissions/clear', auth, async (req, res) => {
  try {
    const parentUser = req.user;
    const subUserId = req.params.id;

    if (parentUser.user_type !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin users can clear permissions.'
      });
    }

    const mysqlConnection = getMySQLConnection();

    // Verify sub-user
    const [subUsers] = await mysqlConnection.execute(
      'SELECT id, first_name, last_name FROM users WHERE id = ? AND parent_user_id = ? AND deleted_at IS NULL',
      [subUserId, parentUser.id]
    );

    if (subUsers.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Sub-user not found.'
      });
    }

    // Clear all custom permissions
    await mysqlConnection.execute(
      'UPDATE users SET custom_permissions = NULL WHERE id = ?',
      [subUserId]
    );

    res.status(200).json({
      success: true,
      message: 'All permissions cleared successfully.',
      data: {
        subUser: {
          id: subUserId,
          name: `${subUsers[0].first_name} ${subUsers[0].last_name}`
        },
        customPermissions: null
      }
    });

  } catch (error) {
    console.error('Clear permissions error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error.',
      error: error.message
    });
  }
});



// ==================== MEMBER TO SUB-USER MANAGEMENT ====================

// =============================================================
// ADD COMMUNITY MEMBER (Step 1: Invitation)
// =============================================================
// @route   POST /api/roles-permissions/members/add
// @desc    Add a community member (invitation stage)
// @access  Private (Admin User)


router.post('/members/add', auth, async (req, res) => {
  const mysqlConnection = getMySQLConnection();

  try {
    const parentUser = req.user;

    const { name, email, phone, city, gender, role, user_type } = req.body;

    // =========================
    // 🔹 BASIC VALIDATION
    // =========================
    if (!name || !email) {
      return res.status(400).json({
        success: false,
        message: 'Name and email are required.'
      });
    }

    if (parentUser.user_type !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin users can add members.'
      });
    }

    if (parentUser.plan_status !== 'active') {
      return res.status(403).json({
        success: false,
        message: 'Active plan required.'
      });
    }

    // =========================
    // 🔹 ROLE NORMALIZATION
    // =========================
    const requestedRole =
      role === 'manager' || user_type === 'manager'
        ? 'manager'
        : 'member';

    // =========================
    // 🔹 PARSE PLAN PERMISSIONS
    // =========================
    let planPermissions = parentUser.plan_permissions;

    if (typeof planPermissions === 'string') {
      planPermissions = JSON.parse(planPermissions);
    }

    const memberPermission =
      planPermissions?.['Member Limit']?.['Members'];

    const managerPermission =
      planPermissions?.['Member Limit']?.['Managers'];

    if (!memberPermission || !managerPermission) {
      return res.status(403).json({
        success: false,
        message: 'Member limits not defined in plan.'
      });
    }

    // =========================
    // 🔹 COUNT MEMBERS FROM DB
    // =========================
    const [[counts]] = await mysqlConnection.execute(
      `SELECT 
         SUM(role = 'member') AS members,
         SUM(role = 'manager') AS managers
       FROM community_members
       WHERE parent_user_id = ?
         AND deleted_at IS NULL`,
      [parentUser.id]
    );

    const usedMembers = counts.members || 0;
    const usedManagers = counts.managers || 0;

    // =========================
    // 🔹 LIMIT CHECK
    // =========================
    if (requestedRole === 'manager') {
      if (managerPermission !== 'unlimited') {
        if (usedManagers >= managerPermission.limit) {
          return res.status(403).json({
            success: false,
            message: `Manager limit reached (${managerPermission.limit}).`
          });
        }
      }
    } else {
      if (memberPermission !== 'unlimited') {
        if (usedMembers >= memberPermission.limit) {
          return res.status(403).json({
            success: false,
            message: `Member limit reached (${memberPermission.limit}).`
          });
        }
      }
    }

    // =========================
    // 🔹 EMAIL CHECKS
    // =========================
    const [[existingMember]] = await mysqlConnection.execute(
      `SELECT id FROM community_members
       WHERE email = ? AND parent_user_id = ?
       AND deleted_at IS NULL`,
      [email, parentUser.id]
    );

    if (existingMember) {
      return res.status(400).json({
        success: false,
        message: 'Member with this email already exists.'
      });
    }

    const [[existingUser]] = await mysqlConnection.execute(
      `SELECT id FROM users WHERE email = ?`,
      [email]
    );

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'Email already exists in users table.'
      });
    }

    // =========================
    // 🔹 CREATE USER
    // =========================
    const [firstName, ...rest] = name.trim().split(' ');
    const lastName = rest.join(' ') || '';

    const subUserType =
      requestedRole === 'manager' ? 'manager' : 'sub_user';

    const [userResult] = await mysqlConnection.execute(
      `INSERT INTO users (
        first_name, last_name, email, password,
        phone, city,
        role, user_type,
        parent_user_id,
        current_plan_id,
        plan_start_date,
        plan_end_date,
        plan_status,
        is_active,
        is_verified
      ) VALUES (?, ?, ?, '', ?, ?, 'user', ?, ?, ?, NOW(), ?, 'active', 1, 0)`,
      [
        firstName,
        lastName,
        email,
        phone || null,
        city || null,
        subUserType,
        parentUser.id,
        parentUser.current_plan_id,
        parentUser.plan_end_date
      ]
    );

    const subUserId = userResult.insertId;

    // =========================
    // 🔹 CREATE COMMUNITY MEMBER
    // =========================
    const token = require('crypto').randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const [memberResult] = await mysqlConnection.execute(
      `INSERT INTO community_members (
        name, email, phone, city, gender, role,
        parent_user_id, user_id,
        status, is_invited,
        invited_at, invitation_token,
        invitation_expires_at,
        has_login_credentials
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'invited', 1, NOW(), ?, ?, 0)`,
      [
        name,
        email,
        phone || null,
        city || null,
        gender || null,
        requestedRole,
        parentUser.id,
        subUserId,
        token,
        expiresAt
      ]
    );

    // =========================
    // 🔹 SUCCESS RESPONSE
    // =========================
    res.status(201).json({
      success: true,
      message: 'Member added successfully.',
      data: {
        memberId: memberResult.insertId,
        userId: subUserId,
        role: requestedRole,
        used: {
          members: usedMembers + (requestedRole === 'member' ? 1 : 0),
          managers: usedManagers + (requestedRole === 'manager' ? 1 : 0)
        }
      }
    });

  } catch (err) {
    console.error('Add member error:', err);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});


// =============================================================
// GET ALL MEMBERS
// =============================================================
// @route   GET /api/roles-permissions/members
// @desc    Fetch all community members with their status
// @access  Private (Admin User)
router.get('/members', auth, async (req, res) => {
  try {
    const parentUser = req.user;

    if (parentUser.user_type !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin users can view members.'
      });
    }

    const mysqlConnection = getMySQLConnection();

    // Fetch all members with their linked user information
    const [members] = await mysqlConnection.execute(
      `SELECT 
        cm.*,
        u.id as sub_user_id,
        u.first_name,
        u.last_name,
        u.is_active as user_is_active,
        u.last_login,
        u.created_at as user_created_at
      FROM community_members cm
      LEFT JOIN users u ON cm.user_id = u.id
      WHERE cm.parent_user_id = ? AND cm.deleted_at IS NULL
      ORDER BY cm.created_at DESC`,
      [parentUser.id]
    );

    // Calculate statistics
    const stats = {
      total: members.length,
      invited: members.filter(m => m.status === 'invited' && !m.has_login_credentials).length,
      active: members.filter(m => m.status === 'active' && m.has_login_credentials).length,
      inactive: members.filter(m => m.status === 'inactive').length,
      withLoginCredentials: members.filter(m => m.has_login_credentials).length
    };

    res.status(200).json({
      success: true,
      message: 'Members fetched successfully.',
      data: {
        stats,
        members
      }
    });

  } catch (error) {
    console.error('Fetch members error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error.',
      error: error.message
    });
  }
});

// =============================================================
// GET SINGLE MEMBER BY ID
// =============================================================
// @route   GET /api/roles-permissions/members/:id
// @desc    Fetch a specific member with full details
// @access  Private (Admin User)
router.get('/members/:id', auth, async (req, res) => {
  try {
    const parentUser = req.user;
    const memberId = req.params.id;

    if (parentUser.user_type !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin users can view members.'
      });
    }

    const mysqlConnection = getMySQLConnection();

    // Fetch member with linked user information
    const [members] = await mysqlConnection.execute(
      `SELECT 
        cm.*,
        u.id as sub_user_id,
        u.first_name,
        u.last_name,
        u.email as user_email,
        u.phone as user_phone,
        u.role,
        u.user_type,
        u.is_active as user_is_active,
        u.last_login,
        u.custom_permissions,
        u.created_at as user_created_at
      FROM community_members cm
      LEFT JOIN users u ON cm.user_id = u.id
      WHERE cm.id = ? AND cm.parent_user_id = ? AND cm.deleted_at IS NULL`,
      [memberId, parentUser.id]
    );

    if (members.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Member not found or does not belong to you.'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Member fetched successfully.',
      data: {
        member: members[0]
      }
    });

  } catch (error) {
    console.error('Fetch member error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error.',
      error: error.message
    });
  }
});

// =============================================================
// CREATE LOGIN CREDENTIALS FOR MEMBER (Convert to Sub-User)
// =============================================================
// @route   POST /api/roles-permissions/members/:id/create-credentials
// @desc    Create login credentials for a member and convert them to sub-user
// @access  Private (Admin User)
router.post('/members/:id/create-credentials', auth, async (req, res) => {
  try {
    const parentUser = req.user;
    const memberId = req.params.id;
    const { password } = req.body;

    if (parentUser.user_type !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin can create credentials.'
      });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password is required (min 6 characters).'
      });
    }

    const mysqlConnection = getMySQLConnection();

    // =========================
    // 🔹 Get member
    // =========================
    const [members] = await mysqlConnection.execute(
      `SELECT * FROM community_members
       WHERE id = ? AND parent_user_id = ? AND deleted_at IS NULL`,
      [memberId, parentUser.id]
    );

    if (!members.length) {
      return res.status(404).json({
        success: false,
        message: 'Member not found.'
      });
    }

    const member = members[0];

    if (member.has_login_credentials) {
      return res.status(400).json({
        success: false,
        message: 'Credentials already created.'
      });
    }

    if (!member.user_id) {
      return res.status(400).json({
        success: false,
        message: 'User account not linked with this member.'
      });
    }

    // =========================
    // 🔹 Get user
    // =========================
    const [users] = await mysqlConnection.execute(
      `SELECT id, plan_permissions FROM users WHERE id = ?`,
      [member.user_id]
    );

    if (!users.length) {
      return res.status(404).json({
        success: false,
        message: 'User not found.'
      });
    }

    // =========================
    // 🔹 HASH PASSWORD
    // =========================
    const hashedPassword = await bcrypt.hash(password, 10);

    // =========================
    // 🔹 GENERATE PLAN PERMISSIONS (INHERIT FROM PARENT)
    // =========================
    let planPermissions = parentUser.plan_permissions;

    if (typeof planPermissions === 'string') {
      planPermissions = JSON.parse(planPermissions);
    }

    // 👉 Sub-user ke liye usually permissions copy hoti hain
    // (future me custom bhi kar sakte ho)
    const userPlanPermissions = planPermissions || null;

    // =========================
    // 🔹 UPDATE USER (PASSWORD + PERMISSIONS)
    // =========================
    await mysqlConnection.execute(
      `UPDATE users
       SET password = ?,
           plan_permissions = ?,
           is_verified = TRUE,
           updated_at = NOW()
       WHERE id = ?`,
      [
        hashedPassword,
        userPlanPermissions ? JSON.stringify(userPlanPermissions) : null,
        member.user_id
      ]
    );

    // =========================
    // 🔹 UPDATE COMMUNITY MEMBER
    // =========================
    await mysqlConnection.execute(
      `UPDATE community_members
       SET has_login_credentials = 1,
           credentials_created_at = NOW(),
           status = 'active'
       WHERE id = ?`,
      [memberId]
    );

    res.status(200).json({
      success: true,
      message: 'Credentials created successfully.',
      data: {
        userId: member.user_id,
        permissionsAssigned: true
      }
    });

  } catch (err) {
    console.error('Create credentials error:', err);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// =============================================================
// UPDATE MEMBER DETAILS (Before credential creation)
// =============================================================
// @route   PUT /api/roles-permissions/members/:id
// @desc    Update member details like name, email, phone, city
// @access  Private (Admin User)
router.put('/members/:id', auth, async (req, res) => {
  try {
    const parentUser = req.user;
    const memberId = req.params.id;
    const { name, email, phone, city, gender } = req.body;

    if (parentUser.user_type !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin users can edit members.'
      });
    }

    const mysqlConnection = getMySQLConnection();

    // Verify member belongs to this parent
    const [members] = await mysqlConnection.execute(
      'SELECT * FROM community_members WHERE id = ? AND parent_user_id = ? AND deleted_at IS NULL',
      [memberId, parentUser.id]
    );

    if (members.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Member not found or does not belong to you.'
      });
    }

    const member = members[0];

    // If email is being changed, check if new email exists
    if (email && email !== member.email) {
      const [existingMembers] = await mysqlConnection.execute(
        'SELECT id FROM community_members WHERE email = ? AND id != ? AND parent_user_id = ?',
        [email, memberId, parentUser.id]
      );

      if (existingMembers.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'A member with this email already exists.'
        });
      }

      // Check in users table too
      const [existingUsers] = await mysqlConnection.execute(
        'SELECT id FROM users WHERE email = ?',
        [email]
      );

      if (existingUsers.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'This email is already registered as a user.'
        });
      }
    }

    // Build update query dynamically
    const updateFields = [];
    const updateValues = [];

    if (name) {
      updateFields.push('name = ?');
      updateValues.push(name);
    }
    if (email) {
      updateFields.push('email = ?');
      updateValues.push(email);
    }
    if (phone !== undefined) {
      updateFields.push('phone = ?');
      updateValues.push(phone || null);
    }
    if (city !== undefined) {
      updateFields.push('city = ?');
      updateValues.push(city || null);
    }
    if (gender !== undefined) {
      updateFields.push('gender = ?');
      updateValues.push(gender || null);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update.'
      });
    }

    updateValues.push(memberId);

    await mysqlConnection.execute(
      `UPDATE community_members SET ${updateFields.join(', ')} WHERE id = ?`,
      updateValues
    );

    // If member has login credentials, update user table too
    if (member.has_login_credentials && member.user_id) {
      const userUpdateFields = [];
      const userUpdateValues = [];

      if (name) {
        const nameParts = name.trim().split(' ');
        const firstName = nameParts[0];
        const lastName = nameParts.slice(1).join(' ') || '';
        userUpdateFields.push('first_name = ?', 'last_name = ?');
        userUpdateValues.push(firstName, lastName);
      }
      if (email) {
        userUpdateFields.push('email = ?');
        userUpdateValues.push(email);
      }
      if (phone !== undefined) {
        userUpdateFields.push('phone = ?');
        userUpdateValues.push(phone || null);
      }
      if (city !== undefined) {
        userUpdateFields.push('city = ?');
        userUpdateValues.push(city || null);
      }

      if (userUpdateFields.length > 0) {
        userUpdateValues.push(member.user_id);
        await mysqlConnection.execute(
          `UPDATE users SET ${userUpdateFields.join(', ')} WHERE id = ?`,
          userUpdateValues
        );
      }
    }

    // Fetch updated member
    const [updatedMembers] = await mysqlConnection.execute(
      'SELECT * FROM community_members WHERE id = ?',
      [memberId]
    );

    res.status(200).json({
      success: true,
      message: 'Member updated successfully.',
      data: {
        member: updatedMembers[0]
      }
    });

  } catch (error) {
    console.error('Update member error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error.',
      error: error.message
    });
  }
});

// =============================================================
// DELETE MEMBER (SOFT DELETE)
// =============================================================
// @route   DELETE /api/roles-permissions/members/:id
// @desc    Soft delete a member (also deletes associated sub-user if exists)
// @access  Private (Admin User)
router.delete('/members/:id', auth, async (req, res) => {
  try {
    const parentUser = req.user;
    const memberId = req.params.id;

    if (parentUser.user_type !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin users can delete members.'
      });
    }

    const mysqlConnection = getMySQLConnection();

    // Verify member belongs to this parent
    const [members] = await mysqlConnection.execute(
      'SELECT * FROM community_members WHERE id = ? AND parent_user_id = ? AND deleted_at IS NULL',
      [memberId, parentUser.id]
    );

    if (members.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Member not found or does not belong to you.'
      });
    }

    const member = members[0];

    // Soft delete member
    await mysqlConnection.execute(
      'UPDATE community_members SET deleted_at = NOW(), status = \'inactive\' WHERE id = ?',
      [memberId]
    );

    // If member has associated sub-user, soft delete that too
    if (member.user_id) {
      await mysqlConnection.execute(
        'UPDATE users SET deleted_at = NOW(), is_active = FALSE WHERE id = ?',
        [member.user_id]
      );
    }

    // Decrease parent's active member count
    await mysqlConnection.execute(
      'UPDATE users SET active_sub_users_count = GREATEST(active_sub_users_count - 1, 0) WHERE id = ?',
      [parentUser.id]
    );

    res.status(200).json({
      success: true,
      message: 'Member deleted successfully.',
      data: {
        deletedMemberId: memberId
      }
    });

  } catch (error) {
    console.error('Delete member error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error.',
      error: error.message
    });
  }
});

// =============================================================
// TOGGLE MEMBER STATUS (For members with login credentials)
// =============================================================
// @route   PATCH /api/roles-permissions/members/:id/toggle-status
// @desc    Activate or deactivate a member (and their sub-user account)
// @access  Private (Admin User)
router.patch('/members/:id/toggle-status', auth, async (req, res) => {
  try {
    const parentUser = req.user;
    const memberId = req.params.id;

    if (parentUser.user_type !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin users can change member status.'
      });
    }

    const mysqlConnection = getMySQLConnection();

    // Verify member belongs to this parent
    const [members] = await mysqlConnection.execute(
      'SELECT * FROM community_members WHERE id = ? AND parent_user_id = ? AND deleted_at IS NULL',
      [memberId, parentUser.id]
    );

    if (members.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Member not found or does not belong to you.'
      });
    }

    const member = members[0];
    const newStatus = member.status === 'active' ? 'inactive' : 'active';

    // Update member status
    await mysqlConnection.execute(
      'UPDATE community_members SET status = ? WHERE id = ?',
      [newStatus, memberId]
    );

    // If member has sub-user account, toggle that too
    if (member.user_id) {
      const newUserStatus = newStatus === 'active';
      await mysqlConnection.execute(
        'UPDATE users SET is_active = ? WHERE id = ?',
        [newUserStatus, member.user_id]
      );
    }

    res.status(200).json({
      success: true,
      message: `Member ${newStatus === 'active' ? 'activated' : 'deactivated'} successfully.`,
      data: {
        memberId: memberId,
        status: newStatus
      }
    });

  } catch (error) {
    console.error('Toggle member status error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error.',
      error: error.message
    });
  }
});


module.exports = router;
