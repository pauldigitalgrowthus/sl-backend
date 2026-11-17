const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const { auth } = require("../../middleware/auth");
const { getMySQLConnection } = require("../../config/mysql");
const { successResponse, errorResponse } = require("../../utils/response");
const { sendParishRegistrationEmail } = require("../../utils/SendMailer")

const router = express.Router();


/* ============================================================
UTIL → get diocese id of logged user
============================================================ */
async function getDioceseId(mysql, userId) {
    const [[row]] = await mysql.execute(
        `SELECT id FROM dioceses WHERE user_id=?`,
        [userId]
    );
    return row?.id;
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

/* ============================================================
1️⃣ LIST PARISHES
============================================================ */
router.get("/parishes", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();

        let dioceseId;

        if (req.user.user_type === "superadmin") {
            dioceseId = req.query.diocese_id;
        } else {
            dioceseId = await getDioceseId(mysql, req.user.id);
        }

        if (!dioceseId)
            return errorResponse(res, "Diocese not found", 404);

        const [rows] = await mysql.execute(
            `SELECT dp.*, u.email
       FROM diocesan_parishes dp
       JOIN users u ON dp.user_id = u.id
       WHERE dp.diocese_id=?`,
            [dioceseId]
        );

        return successResponse(res, rows);

    } catch (e) {
        return errorResponse(res, e.message, 500);
    }
});


/* ============================================================
   @route   POST /api/diocese/parishes
   @desc    Create parish (Superadmin or Diocesan Admin)
   @access  Private
============================================================ */
router.post("/parishes", auth, async (req, res) => {

    const mysql = getMySQLConnection();
    const connection = await mysql.getConnection();

    try {

        await connection.beginTransaction();

        const isSuperadmin = req.user.user_type === "superadmin";

        const {
            diocese_id,
            user_id,
            first_name,
            last_name,
            email,
            parish_name,
            phone,
            address
        } = req.body;

        let dioceseId;

        /* =====================================================
           1️⃣ DETERMINE DIOCESE
        ===================================================== */

        if (isSuperadmin) {

            if (!diocese_id) {
                return errorResponse(res, "diocese_id is required", 400);
            }

            const [[exists]] = await connection.execute(
                `SELECT id FROM dioceses WHERE id=?`,
                [diocese_id]
            );

            if (!exists) {
                return errorResponse(res, "Diocese not found", 404);
            }

            dioceseId = diocese_id;

        } else {

            // Must be diocesan admin
            if (!req.user.is_diocesan) {
                return errorResponse(res, "Unauthorized access", 403);
            }

            const [[row]] = await connection.execute(
                `SELECT id FROM dioceses WHERE user_id=? LIMIT 1`,
                [req.user.id]
            );

            if (!row) {
                return errorResponse(res, "Diocese not found for this admin", 404);
            }

            dioceseId = row.id;
        }

        /* =====================================================
           1.5️⃣ PARISH LIMIT CHECK 🔥
        ===================================================== */

        const [[dioceseData]] = await connection.execute(
            `SELECT total_parishes FROM dioceses WHERE id=?`,
            [dioceseId]
        );

        if (!dioceseData) {
            return errorResponse(res, "Diocese not found", 404);
        }

        const [[countData]] = await connection.execute(
            `SELECT COUNT(*) as total FROM diocesan_parishes WHERE diocese_id=?`,
            [dioceseId]
        );

        if (countData.total >= dioceseData.total_parishes) {
            return errorResponse(
                res,
                `Parish limit reached (${dioceseData.total_parishes}). Cannot create more parishes.`,
                400
            );
        }

        /* =====================================================
           2️⃣ USER CREATION (IF NOT EXISTING)
        ===================================================== */

        let finalUserId = user_id;
        let generatedPassword = "TempPass123";
        let isNewUser = false;

        if (!finalUserId) {

            if (!first_name || !last_name || !email) {
                return errorResponse(res, "User details required", 400);
            }

            const normalizedEmail = email.trim().toLowerCase();

            const [[exists]] = await connection.execute(
                `SELECT id FROM users WHERE email=?`,
                [normalizedEmail]
            );

            if (exists) {
                return errorResponse(res, "Email already exists", 400);
            }

            const [[freePlan]] = await connection.execute(
                `SELECT id FROM plans 
                 WHERE slug='free-account' 
                 AND billing_cycle='free'
                 LIMIT 1`
            );

            if (!freePlan) {
                return errorResponse(res, "Free plan not configured", 500);
            }

            const hashed = await bcrypt.hash(generatedPassword, 10);

            const trialEnd = new Date();
            trialEnd.setDate(trialEnd.getDate() + 14);

            const [newUser] = await connection.execute(
                `INSERT INTO users (
                    first_name,
                    last_name,
                    email,
                    password,
                    role,
                    user_type,
                    parent_user_id,
                    is_active,
                    is_verified,
                    current_plan_id,
                    plan_status,
                    plan_permissions,
                    free_trial_expires_at,
                    created_at,
                    updated_at
                )
                VALUES (?,?,?,?, 'free_user', 'sub_user', ?, 1, 1, ?, 'active', '{}', ?, NOW(), NOW())`,
                [
                    first_name,
                    last_name,
                    normalizedEmail,
                    hashed,
                    req.user.id,
                    freePlan.id,
                    trialEnd
                ]
            );

            finalUserId = newUser.insertId;
            isNewUser = true;

            await regeneratePermissionsForPlanUsers(freePlan.id, connection);
        }

        /* =====================================================
           3️⃣ CREATE PARISH
        ===================================================== */

        await connection.execute(
            `INSERT INTO diocesan_parishes
            (diocese_id,
             user_id,
             admin_name,
             admin_email,
             admin_phone,
             parish_name,
             parish_address,
             joined_at,
             renewal_date,
             status)
            VALUES (?,?,?,?,?,?,?,CURDATE(),CURDATE(),'free')`,
            [
                dioceseId,
                finalUserId,
                `${first_name || ""} ${last_name || ""}`,
                email,
                phone || null,
                parish_name,
                address || null
            ]
        );

        await connection.commit();

        /* =====================================================
           4️⃣ SEND EMAIL
        ===================================================== */

        try {
            await sendParishRegistrationEmail({
                firstName: first_name,
                lastName: last_name,
                email,
                password: generatedPassword,
                isNewUser,
                parishName: parish_name
            });
        } catch (err) {
            console.warn("Parish email failed:", err.message);
        }

        return successResponse(res, {
            message: "Parish created successfully",
            generatedPassword: isNewUser ? generatedPassword : null
        });

    } catch (error) {

        await connection.rollback();
        console.error("Create Parish Error:", error);

        return errorResponse(res, error.message, 500);

    } finally {
        connection.release();
    }
});


/* ============================================================
3️⃣ UPDATE PARISH
============================================================ */
router.put("/parishes/:id", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();

        const { parish_name, address, phone, status, notes } = req.body;

        await mysql.execute(
            `UPDATE diocesan_parishes
       SET parish_name=?,
           parish_address=?,
           admin_phone=?,
           status=?,
           notes=?,
           updated_at=NOW()
       WHERE id=?`,
            [parish_name, address, phone, status, notes, req.params.id]
        );

        return successResponse(res, null, "Updated");

    } catch (e) {
        return errorResponse(res, e.message, 500);
    }
});


/* ============================================================
4️⃣ DELETE PARISH (soft delete)
============================================================ */
router.delete("/parishes/:id", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();

        await mysql.execute(
            `UPDATE diocesan_parishes
       SET status='removed', updated_at=NOW()
       WHERE id=?`,
            [req.params.id]
        );

        return successResponse(res, null, "Removed");

    } catch (e) {
        return errorResponse(res, e.message, 500);
    }
});


/* ============================================================
5️⃣ TRANSFER PARISH (superadmin only)
============================================================ */
router.put("/parishes/:id/transfer", auth, async (req, res) => {

    if (req.user.user_type !== "superadmin")
        return errorResponse(res, "Superadmin only", 403);

    try {
        const mysql = getMySQLConnection();

        const { new_diocese_id } = req.body;

        await mysql.execute(
            `UPDATE diocesan_parishes
       SET diocese_id=?, updated_at=NOW()
       WHERE id=?`,
            [new_diocese_id, req.params.id]
        );

        return successResponse(res, null, "Transferred successfully");

    } catch (e) {
        return errorResponse(res, e.message, 500);
    }
});


/* ============================================================
   4️⃣ GET MY PARISH PAYMENTS
============================================================ */
router.get("/parish/payments", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();

        // 1️⃣ Get Parish ID of logged-in user
        const [[parish]] = await mysql.execute(
            `SELECT id FROM diocesan_parishes WHERE user_id=?`,
            [req.user.id]
        );

        if (!parish)
            return errorResponse(res, "Parish not found", 404);

        // 2️⃣ Fetch Payments
        const [payments] = await mysql.execute(
            `SELECT 
          dpp.id,
          dpp.plan_id,
          p.name AS plan_name,
          dpp.amount,
          dpp.payment_method,
          dpp.status,
          dpp.stripe_subscription_id,
          dpp.created_at
        FROM diocesan_parish_payments dpp
        LEFT JOIN plans p ON dpp.plan_id = p.id
        WHERE dpp.parish_id = ?
        ORDER BY dpp.created_at DESC`,
            [parish.id]
        );

        return successResponse(res, payments);

    } catch (err) {
        console.error("Get Parish Payments Error:", err);
        return errorResponse(res, "Failed to fetch payments", 500);
    }
});



/* ============================================================
   5️⃣ GET SINGLE PAYMENT DETAIL
============================================================ */
router.get("/parish/payments/:id", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const paymentId = req.params.id;

        const [[payment]] = await mysql.execute(
            `SELECT 
          dpp.*,
          p.name AS plan_name
        FROM diocesan_parish_payments dpp
        LEFT JOIN plans p ON dpp.plan_id = p.id
        WHERE dpp.id = ?`,
            [paymentId]
        );

        if (!payment)
            return errorResponse(res, "Payment not found", 404);

        return successResponse(res, payment);

    } catch (err) {
        console.error("Get Payment Detail Error:", err);
        return errorResponse(res, "Failed to fetch payment detail", 500);
    }
});



/* ============================================================
   6️⃣ GET PAYMENTS BY PARISH (Diocese Admin Use)
============================================================ */
router.get("/parish/:parishId/payments", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { parishId } = req.params;

        const [payments] = await mysql.execute(
            `SELECT 
          dpp.id,
          dpp.plan_id,
          p.name AS plan_name,
          dpp.amount,
          dpp.payment_method,
          dpp.status,
          dpp.created_at
        FROM diocesan_parish_payments dpp
        LEFT JOIN plans p ON dpp.plan_id = p.id
        WHERE dpp.parish_id = ?
        ORDER BY dpp.created_at DESC`,
            [parishId]
        );

        return successResponse(res, payments);

    } catch (err) {
        console.error("Get Parish Payments (Admin) Error:", err);
        return errorResponse(res, "Failed to fetch parish payments", 500);
    }
});

/* ============================================================
   7️⃣ GET ALL PAYMENTS OF MY DIOCESE
============================================================ */
router.get("/parish/diocese/payments", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        console.log("Fetching diocese payments for user:", req.user.id);
        /* =========================================================
           1️⃣ Get Diocese ID from Logged-in User
        ========================================================= */
        const [[diocese]] = await mysql.execute(
            `SELECT id FROM dioceses WHERE user_id=?`,
            [req.user.id]
        );

        if (!diocese)
            return errorResponse(res, "Diocese not found", 404);

        /* =========================================================
           2️⃣ Fetch All Parish Payments Under This Diocese
        ========================================================= */
        const [payments] = await mysql.execute(
            `SELECT 
            dpp.id AS payment_id,
            dp.id AS parish_id,
            dp.name AS parish_name,
            p.name AS plan_name,
            dpp.amount,
            dpp.payment_method,
            dpp.status,
            dpp.stripe_subscription_id,
            dpp.created_at
         FROM diocesan_parish_payments dpp
         INNER JOIN diocesan_parishes dp 
             ON dpp.parish_id = dp.id
         LEFT JOIN plans p 
             ON dpp.plan_id = p.id
         WHERE dpp.diocese_id = ?
         ORDER BY dpp.created_at DESC`,
            [diocese.id]
        );

        return successResponse(res, payments);

    } catch (err) {
        console.error("Get Diocese Payments Error:", err);
        return errorResponse(res, "Failed to fetch diocese payments", 500);
    }
});

/* ============================================================
   8️⃣ GET SINGLE PARISH FULL DETAIL (A to Z)
   @route   GET /api/parishes/:id
   @access  Private (Diocese Admin / Superadmin)
============================================================ */
router.get("/parishes/:id", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;

        /* ======================================================
           1️⃣ GET PARISH BASIC + ADMIN USER + DIOCESE
        ====================================================== */
        const [[parish]] = await mysql.execute(
            `SELECT 
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
                u.plan_start_date,
                u.plan_end_date,
                u.plan_permissions,                
                d.*                 
             FROM diocesan_parishes dp
             LEFT JOIN users u ON dp.user_id = u.id
             LEFT JOIN dioceses d ON dp.diocese_id = d.id
             WHERE dp.id = ?`,
            [id]
        );

        if (!parish) {
            return errorResponse(res, "Parish not found", 404);
        }

        /* ======================================================
           2️⃣ GET PLAN DETAILS
        ====================================================== */
        let plan = null;

        if (parish.current_plan_id) {
            const [[planRow]] = await mysql.execute(
                `SELECT * FROM plans WHERE id=?`,
                [parish.current_plan_id]
            );
            plan = planRow || null;
        }

        /* ======================================================
           3️⃣ GET ALL PAYMENTS
        ====================================================== */
        const [payments] = await mysql.execute(
            `SELECT 
            dpp.*,
            p.name AS plan_name
         FROM diocesan_parish_payments dpp
         LEFT JOIN plans p ON dpp.plan_id = p.id
         WHERE dpp.parish_id = ?
         ORDER BY dpp.created_at DESC`,
            [id]
        );

        /* ======================================================
           4️⃣ PAYMENT SUMMARY
        ====================================================== */
        const [[paymentSummary]] = await mysql.execute(
            `SELECT 
            COUNT(*) AS total_payments,
            SUM(CASE WHEN status='completed' THEN amount ELSE 0 END) AS total_paid,
            SUM(CASE WHEN status='pending' THEN amount ELSE 0 END) AS total_pending
         FROM diocesan_parish_payments
         WHERE parish_id=?`,
            [id]
        );

        /* ======================================================
           5️⃣ FINAL RESPONSE STRUCTURE
        ====================================================== */
        const response = {
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
        };

        return successResponse(res, response);

    } catch (err) {
        console.error("Get Single Parish Error:", err);
        return errorResponse(res, "Failed to fetch parish details", 500);
    }
});


module.exports = router;