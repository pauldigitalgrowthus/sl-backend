const express = require('express');
const { getMySQLConnection } = require('../../config/mysql');
const { auth, requireSLTeamWithTypes } = require('../../middleware/auth');
const { successResponse, errorResponse } = require('../../utils/response');
const router = express.Router();

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

module.exports = router; 