const express = require('express');
const router = express.Router();
const { getMySQLConnection } = require('../../config/mysql');
const { auth } = require('../../middleware/auth');
const { successResponse, errorResponse } = require('../../utils/response');

/* ============================================================
   Utility Function: Validate Admin + Active Plan
   ============================================================ */
async function validateAdminPlan(connection, user) {
    let targetUser = user;

    // If the user is a manager, load the parent admin's plan info
    if (user.user_type === 'manager' && user.parent_user_id) {
        const [rows] = await connection.execute(
            `SELECT id, user_type, plan_status, plan_end_date FROM users WHERE id = ?`,
            [user.parent_user_id]
        );
        if (rows.length > 0) {
            targetUser = rows[0];
        } else {
            return 'Parent admin user not found';
        }
    }

    // Only admin allowed
    if (targetUser.user_type !== 'admin') {
        return 'Only admin can manage mass schedules';
    }

    // Plan must be active
    if (targetUser.plan_status !== 'active') {
        return 'Your plan is not active';
    }

    // Plan must not be expired
    const today = new Date();
    const planEnd = new Date(targetUser.plan_end_date);
    if (planEnd < today) {
        return 'Your plan has expired';
    }

    return null; // valid
}

/* ============================================================
   Utility Function: Load Mass By ID (Scoped to parent_user_id)
   ============================================================ */
async function loadMassById(connection, userId, massId) {
    const [rows] = await connection.execute(
        `SELECT * FROM mass_schedule 
         WHERE id = ? AND parent_user_id = ?`,
        [massId, userId]
    );

    if (!rows.length) return null;

    const mass = rows[0];

    // Safely parse JSON
    try {
        mass.mass_entities = mass.mass_entities
            ? JSON.parse(mass.mass_entities)
            : [];
    } catch (err) {
        mass.mass_entities = [];
    }

    return mass;
}

/* ============================================================
   CREATE MASS SCHEDULE
   POST /api/planners/mass-schedule
   ============================================================ */
router.post('/', auth, async (req, res) => {
    try {
        const { MassName, MassDay, MassEntity } = req.body;
        if (req.user.user_type === "manager") {
            req.user.id = req.user.parent_user_id;
        }

        const connection = getMySQLConnection();

        // 🔐 Validate Admin + Plan
        const validationError = await validateAdminPlan(connection, req.user);
        if (validationError) {
            return errorResponse(res, validationError, 403);
        }

        // 📦 Basic payload validation
        if (!MassName || !MassDay?.date || !MassDay?.day) {
            return errorResponse(res, 'MassName and MassDay are required', 400);
        }

        const allowedDays = [
            'Sunday', 'Monday', 'Tuesday', 'Wednesday',
            'Thursday', 'Friday', 'Saturday'
        ];

        if (!allowedDays.includes(MassDay.day)) {
            return errorResponse(res, 'Invalid mass day', 400);
        }


        const [result] = await connection.execute(
            `INSERT INTO mass_schedule 
             (parent_user_id, mass_name, mass_date, mass_day, mass_entities)
             VALUES (?, ?, ?, ?, ?)`,
            [
                req.user.id, // 👈 Parent user id
                MassName.toString().trim(),
                MassDay.date,
                MassDay.day,
                JSON.stringify(MassEntity || [])
            ]
        );

        return successResponse(
            res,
            {
                id: result.insertId,
                parent_user_id: req.user.id,
                mass_name: MassName,
                mass_date: MassDay.date,
                mass_day: MassDay.day,
                mass_entities: MassEntity || []
            },
            'Mass schedule created successfully',
            201
        );

    } catch (err) {
        console.error('Error creating mass schedule:', err);
        return errorResponse(res, 'Error creating mass schedule', 500);
    }
});

/* ============================================================
   GET ALL MASS SCHEDULES (User Scoped)
   ============================================================ */
router.get('/', auth, async (req, res) => {
    try {
        const connection = getMySQLConnection();
        console.log("Yes it is running")

        console.log(req.user)
        if (req.user.user_type === "manager") {
            req.user.id = req.user.parent_user_id;
        }

        const [rows] = await connection.execute(
            `SELECT * FROM mass_schedule
             WHERE parent_user_id = ?
             ORDER BY mass_date DESC`,
            [req.user.id]
        );

        const formatted = rows.map((row) => {
            try {
                row.mass_entities = row.mass_entities
                    ? JSON.parse(row.mass_entities)
                    : [];
            } catch {
                row.mass_entities = [];
            }
            return row;
        });

        return successResponse(res, formatted, 'Mass schedules fetched');

    } catch (err) {
        console.error('Error fetching mass schedules:', err);
        return errorResponse(res, 'Error fetching mass schedules', 500);
    }
});

/* ============================================================
   GET SINGLE MASS SCHEDULE
   ============================================================ */
router.get('/:id', auth, async (req, res) => {
    try {
        const connection = getMySQLConnection();
        const { id } = req.params;

        if (req.user.user_type === "manager") {
            req.user.id = req.user.parent_user_id;
        }

        const mass = await loadMassById(connection, req.user.id, id);

        if (!mass) {
            return errorResponse(res, 'Mass schedule not found', 404);
        }

        return successResponse(res, mass, 'Mass schedule fetched');

    } catch (err) {
        console.error('Error fetching mass schedule:', err);
        return errorResponse(res, 'Error fetching mass schedule', 500);
    }
});

/* ============================================================
   UPDATE MASS SCHEDULE
   ============================================================ */
router.put('/:id', auth, async (req, res) => {
    try {
        const { id } = req.params;
        const { MassName, MassDay, MassEntity } = req.body;
        if (req.user.user_type === "manager") {
            req.user.id = req.user.parent_user_id;
        }

        const connection = getMySQLConnection();

        const validationError = await validateAdminPlan(connection, req.user);
        if (validationError) {
            return errorResponse(res, validationError, 403);
        }

        // ✅ Convert ISO date → MySQL DATE
        const massDate = MassDay?.date
            ? new Date(MassDay.date).toISOString().split('T')[0]
            : null;

        const [result] = await connection.execute(
            `UPDATE mass_schedule
             SET mass_name = ?,
                 mass_date = ?,
                 mass_day = ?,
                 mass_entities = ?
             WHERE id = ? AND parent_user_id = ?`,
            [
                MassName,
                massDate,
                MassDay?.day,
                JSON.stringify(MassEntity || []),
                id,
                req.user.id
            ]
        );

        if (result.affectedRows === 0) {
            return errorResponse(res, 'Mass schedule not found', 404);
        }

        return successResponse(res, null, 'Mass schedule updated');

    } catch (err) {
        console.error('Error updating mass schedule:', err);
        return errorResponse(res, 'Error updating mass schedule', 500);
    }
});

/* ============================================================
   DELETE MASS SCHEDULE
   ============================================================ */
router.delete('/:id', auth, async (req, res) => {
    try {
        if (req.user.user_type === "manager") {
            req.user.id = req.user.parent_user_id;
        }

        const connection = getMySQLConnection();

        // 🔐 Validate Admin + Plan
        const validationError = await validateAdminPlan(connection, req.user);
        if (validationError) {
            return errorResponse(res, validationError, 403);
        }

        const { id } = req.params;

        const [result] = await connection.execute(
            `DELETE FROM mass_schedule 
             WHERE id = ? AND parent_user_id = ?`,
            [id, req.user.id]
        );

        if (result.affectedRows === 0) {
            return errorResponse(res, 'Mass schedule not found', 404);
        }

        return successResponse(res, null, 'Mass schedule deleted');

    } catch (err) {
        console.error('Error deleting mass schedule:', err);
        return errorResponse(res, 'Error deleting mass schedule', 500);
    }
});

module.exports = router;