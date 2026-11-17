const express = require('express');
const router = express.Router();

const { getMySQLConnection } = require('../../config/mysql');
const { auth } = require('../../middleware/auth');
const { successResponse, errorResponse } = require('../../utils/response');
const { resolveCommunityId } = require('./helpers');


router.get('/', auth, async (req, res) => {
    try {
        const connection = getMySQLConnection();
        // ✅ Superadmin check
        if (req.user.role !== 'sl_team' || req.user.user_type !== 'superadmin') {
            return errorResponse(res, 'Access denied. Superadmin only.', 403);
        }

        // ✅ Fetch users with "Subscriber Admin" plan
        const [users] = await connection.execute(
            `      SELECT 
        u.id,
        u.first_name,
        u.last_name,
        u.email,
        u.role,
        u.user_type,
        u.plan_status,
        u.created_at,

        -- Plan info
        p.id AS plan_id,
        p.name AS plan_name,
        p.slug AS plan_slug,
        p.price,
        p.billing_cycle

      FROM users u
      INNER JOIN plans p ON u.current_plan_id = p.id
      WHERE p.name = ?
      `,
            ['Subscriber Admin']
        );

        return successResponse(
            res,
            { users },
            'Subscriber Admin users fetched successfully',
            200
        );

    } catch (err) {
        console.error('Error fetching Subscriber Admin users:', err);
        return errorResponse(res, 'Failed to fetch Subscriber Admin users', 500);
    }
});

router.get('/:id/members', auth, async (req, res) => {
    try {
        const connection = getMySQLConnection();

        // ✅ Only superadmin allowed
        if (req.user.role !== 'sl_team' || req.user.user_type !== 'superadmin') {
            return errorResponse(res, 'Access denied. Superadmin only.', 403);
        }

        const subscriberAdminId = req.params.id;

        // ==========================
        // 1️⃣ Fetch Sub Users
        // ==========================
        const [subUsers] = await connection.execute(
            `
        SELECT 
          id,
          first_name,
          last_name,
          email,
          role,
          user_type,
          plan_status,
          created_at
        FROM users
        WHERE parent_user_id = ?
        AND deleted_at IS NULL
        `,
            [subscriberAdminId]
        );

        // ==========================
        // 2️⃣ Fetch Community Members
        // ==========================
        const [communityMembers] = await connection.execute(
            `
        SELECT
          id,
          name,
          email,
          phone,
          city,
          gender,
          status,
          role,
          is_invited,
          invited_at,
          has_login_credentials,
          created_at
        FROM community_members
        WHERE parent_user_id = ?
        AND deleted_at IS NULL
        `,
            [subscriberAdminId]
        );

        return successResponse(
            res,
            {
                subscriber_admin_id: subscriberAdminId,
                sub_users: subUsers,
                community_members: communityMembers
            },
            'Subscriber Admin members fetched successfully',
            200
        );

    } catch (error) {
        console.error('Error fetching subscriber admin members:', error);
        return errorResponse(res, 'Failed to fetch members', 500);
    }
}
);

router.post('/planner-ministers/superadmin', auth, async (req, res) => {
    try {
        const {
            subscriber_admin_id,
            user_id,
            email,
            person_name,
            phone,
            instrument,
            gender,
            marital_status
        } = req.body;

        // =========================
        // 🔐 SUPER ADMIN ONLY
        // =========================
        // ✅ Only superadmin allowed
        if (req.user.role !== 'sl_team' || req.user.user_type !== 'superadmin') {
            return errorResponse(res, 'Access denied. Superadmin only.', 403);
        }

        // =========================
        // ❗ BASIC VALIDATIONS
        // =========================
        if (!subscriber_admin_id) {
            return errorResponse(res, 'subscriber_admin_id is required', 400);
        }

        if (!user_id && !email) {
            return errorResponse(
                res,
                'Either user_id or email is required',
                400
            );
        }

        const connection = getMySQLConnection();

        // =========================
        // 🔍 VALIDATE SUBSCRIBER ADMIN
        // =========================
        const [[subscriberAdmin]] = await connection.execute(
            `
        SELECT id
        FROM users
        WHERE id = ?
          AND deleted_at IS NULL
        `,
            [subscriber_admin_id]
        );

        if (!subscriberAdmin) {
            return errorResponse(
                res,
                'Subscriber admin not found',
                404
            );
        }

        // =========================
        // 🔍 FIND USER (MEMBER)
        // =========================
        const userQuery = user_id
            ? `
          SELECT id, first_name, last_name, email, phone
          FROM users
          WHERE id = ?
            AND parent_user_id = ?
            AND user_type IN ('sub_user', 'manager')
            AND deleted_at IS NULL
        `
            : `
          SELECT id, first_name, last_name, email, phone
          FROM users
          WHERE email = ?
            AND parent_user_id = ?
            AND user_type IN ('sub_user', 'manager')
            AND deleted_at IS NULL
        `;

        const userParams = user_id
            ? [user_id, subscriber_admin_id]
            : [email.trim(), subscriber_admin_id];

        const [[user]] = await connection.execute(
            userQuery,
            userParams
        );

        if (!user) {
            return errorResponse(
                res,
                'User must be sub_user or manager of this subscriber admin',
                403
            );
        }

        // =========================
        // 🚫 DUPLICATE CHECK
        // =========================
        const [[exists]] = await connection.execute(
            `
        SELECT id
        FROM planner_ministers
        WHERE parent_user_id = ?
          AND user_id = ?
        `,
            [subscriber_admin_id, user.id]
        );

        if (exists) {
            return errorResponse(
                res,
                'Minister already exists for this community',
                409
            );
        }

        // =========================
        // 🧠 FINAL DATA (FALLBACKS)
        // =========================
        const finalPersonName =
            typeof person_name === 'string' && person_name.trim()
                ? person_name.trim()
                : `${user.first_name} ${user.last_name}`;

        const finalPhone =
            typeof phone === 'string' && phone.trim()
                ? phone.trim()
                : user.phone || null;

        let finalInstrument = null;
        if (Array.isArray(instrument)) {
            finalInstrument = instrument.join(', ');
        } else if (typeof instrument === 'string') {
            finalInstrument = instrument.trim();
        }

        // =========================
        // ✅ INSERT MINISTER
        // =========================
        const [result] = await connection.execute(
            `
        INSERT INTO planner_ministers
        (
          parent_user_id,
          user_id,
          created_by,
          person_name,
          email,
          phone,
          instrument,
          gender,
          marital_status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
            [
                subscriber_admin_id,
                user.id,
                req.user.id, // superadmin
                finalPersonName,
                user.email,
                finalPhone,
                finalInstrument,
                gender || null,
                marital_status || null
            ]
        );

        return successResponse(
            res,
            {
                id: result.insertId,
                subscriber_admin_id,
                user_id: user.id,
                person_name: finalPersonName,
                email: user.email,
                phone: finalPhone,
                instrument: finalInstrument
            },
            'Minister created successfully',
            201
        );

    } catch (err) {
        console.error('Error creating minister (superadmin):', err);
        return errorResponse(
            res,
            'Failed to create minister',
            500
        );
    }
}
);

router.post('/planner-groups/superadmin', auth, async (req, res) => {
    try {
        const { subscriber_admin_id, group_name } = req.body;

        // =========================
        // 🔐 SUPER ADMIN ONLY
        // =========================
        if (req.user.role !== 'sl_team' || req.user.user_type !== 'superadmin') {
            return errorResponse(
                res,
                'Access denied. Superadmin only.',
                403
            );
        }

        // =========================
        // ❗ BASIC VALIDATIONS
        // =========================
        if (!subscriber_admin_id) {
            return errorResponse(
                res,
                'subscriber_admin_id is required',
                400
            );
        }

        if (!group_name || !group_name.toString().trim()) {
            return errorResponse(
                res,
                'group_name is required',
                400
            );
        }

        const connection = getMySQLConnection();
        const cleanName = group_name.toString().trim();

        // =========================
        // 🔍 VALIDATE SUBSCRIBER ADMIN
        // =========================
        const [[subscriberAdmin]] = await connection.execute(
            `
        SELECT id
        FROM users
        WHERE id = ?
          AND deleted_at IS NULL
        `,
            [subscriber_admin_id]
        );

        if (!subscriberAdmin) {
            return errorResponse(
                res,
                'Subscriber admin not found',
                404
            );
        }

        // =========================
        // 🚫 DUPLICATE GROUP CHECK
        // =========================
        const [[exists]] = await connection.execute(
            `
        SELECT id
        FROM planner_groups
        WHERE parent_user_id = ?
          AND group_name = ?
        `,
            [subscriber_admin_id, cleanName]
        );

        if (exists) {
            return errorResponse(
                res,
                'Group already exists for this subscriber admin',
                409
            );
        }

        // =========================
        // ✅ CREATE GROUP
        // =========================
        const [result] = await connection.execute(
            `
        INSERT INTO planner_groups
        (parent_user_id, group_name)
        VALUES (?, ?)
        `,
            [subscriber_admin_id, cleanName]
        );

        return successResponse(
            res,
            {
                id: result.insertId,
                subscriber_admin_id,
                group_name: cleanName
            },
            'Planner group created successfully',
            201
        );

    } catch (err) {
        console.error('Error creating planner group (superadmin):', err);
        return errorResponse(
            res,
            'Failed to create planner group',
            500
        );
    }
}
);

router.get('/planner-groups/superadmin/:subscriber_admin_id', auth,
    async (req, res) => {
        try {
            const { subscriber_admin_id } = req.params;

            // =========================
            // 🔐 SUPER ADMIN ONLY
            // =========================
            if (req.user.role !== 'sl_team' || req.user.user_type !== 'superadmin') {
                return errorResponse(
                    res,
                    'Access denied. Superadmin only.',
                    403
                );
            }

            // =========================
            // ❗ BASIC VALIDATION
            // =========================
            if (!subscriber_admin_id) {
                return errorResponse(
                    res,
                    'subscriber_admin_id is required',
                    400
                );
            }

            const connection = getMySQLConnection();

            // =========================
            // 🔍 VALIDATE SUBSCRIBER ADMIN
            // =========================
            const [[subscriberAdmin]] = await connection.execute(
                `
        SELECT id
        FROM users
        WHERE id = ?
          AND deleted_at IS NULL
        `,
                [subscriber_admin_id]
            );

            if (!subscriberAdmin) {
                return errorResponse(
                    res,
                    'Subscriber admin not found',
                    404
                );
            }

            // =========================
            // 📦 FETCH GROUPS
            // =========================
            const [rows] = await connection.execute(
                `
        SELECT
          pg.id,
          pg.group_name,
          pg.created_at,
          (
            SELECT COUNT(*)
            FROM planner_group_members pgm
            WHERE pgm.group_id = pg.id
          ) AS members_count
        FROM planner_groups pg
        WHERE pg.parent_user_id = ?
        ORDER BY pg.created_at DESC
        `,
                [subscriber_admin_id]
            );

            return successResponse(
                res,
                rows,
                'Planner groups fetched successfully'
            );

        } catch (err) {
            console.error('Error fetching planner groups (superadmin):', err);
            return errorResponse(
                res,
                'Failed to fetch planner groups',
                500
            );
        }
    }
);


module.exports = router;
