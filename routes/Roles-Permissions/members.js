const express = require('express');
const { getMySQLConnection } = require('../../config/mysql');
const { auth, requireSLTeamWithTypes } = require('../../middleware/auth');
const { successResponse, errorResponse } = require('../../utils/response');
const router = express.Router();
const bcrypt = require('bcryptjs');
// ==================== MEMBER TO SUB-USER MANAGEMENT ====================

// =============================================================
// ADD COMMUNITY MEMBER (Step 1: Invitation)     => working
// =============================================================
// @route   POST /api/roles-permissions/members/add
// @desc    Add a community member (invitation stage)
// @access  Private (Admin User)
router.post('/add', auth, async (req, res) => {
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
        const requestedRole = role === 'manager' || user_type === 'manager' ? 'manager' : 'member';
        // =========================
        // 🔹 PARSE PLAN PERMISSIONS
        // =========================
        let planPermissions = parentUser.plan_permissions;
        if (typeof planPermissions === 'string') {
            planPermissions = JSON.parse(planPermissions);
        }
        const memberPermission = planPermissions?.['Member Limit']?.['Members'];
        const managerPermission = planPermissions?.['Member Limit']?.['Managers'];
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
router.get('/', auth, async (req, res) => {
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
router.get('/:id', auth, async (req, res) => {
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
router.post('/:id/create-credentials', auth, async (req, res) => {
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

        // 👉 Sub-user ke liye permissions copy hoti hain + Full access to Community
        const userPlanPermissions = planPermissions ? JSON.parse(JSON.stringify(planPermissions)) : {};
        if (!userPlanPermissions["Community"]) {
            userPlanPermissions["Community"] = {};
        }
        userPlanPermissions["Community"]["Feed"] = "x";
        userPlanPermissions["Community"]["Feeds"] = "x";
        userPlanPermissions["Community"]["Discussions"] = "x";
        userPlanPermissions["Community"]["My Groups"] = "x";
        userPlanPermissions["Community"]["Groups"] = "x";
        userPlanPermissions["Community"]["Prayer"] = "x";

        if (!userPlanPermissions["SL Portals"]) userPlanPermissions["SL Portals"] = {};
        userPlanPermissions["SL Portals"]["Community"] = {
          Feed: "x",
          Feeds: "x",
          Discussions: "x",
          "My Groups": "x",
          Groups: "x",
          Prayer: "x"
        };

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
router.put('/:id', auth, async (req, res) => {
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
router.delete('/:id', auth, async (req, res) => {
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
router.patch('/:id/toggle-status', auth, async (req, res) => {
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