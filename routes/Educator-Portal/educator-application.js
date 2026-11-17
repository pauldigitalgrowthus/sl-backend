const express = require("express");
const { auth } = require("../../middleware/auth");
const { getMySQLConnection } = require("../../config/mysql");
const { successResponse, errorResponse } = require("../../utils/response");
const { EducatorApplicationsFilesUpload } = require("../../config/s3");
const {
    sendEducatorNotification,
    EDUCATOR_NOTIFICATION_EVENTS
} = require("./utils/educatorNotificationServices");

const router = express.Router();

/* ============================================================
   6️⃣ GET MY APPLICATION
   ------------------------------------------------------------
   @route   GET /api/educator/application/my
   @desc    Get logged-in user's educator application
   @access  Private (User)
============================================================ */
router.get("/my", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const [[application]] =
            await mysql.execute(
                `
                SELECT
                    e.*,
                    u.first_name,
                    u.last_name,
                    u.email AS user_email,
                    u.phone AS user_phone,
                    u.avatar,
                    u.country,
                    u.state_province,
                    u.city,
                    u.is_verified AS user_verified,
                    u.created_at AS user_created_at

                FROM educator_applications e LEFT JOIN users u
                    ON e.user_id = u.id WHERE e.user_id = ? LIMIT 1
                `, [req.user.id]
            );

        /* ============================================================
           NOT FOUND
        ============================================================ */
        if (!application) {
            return errorResponse(res, "No educator application found", 404);
        }

        /* ============================================================
           SAFE JSON PARSER
        ============================================================ */
        const parseJSON = (value, defaultValue = []) => {
            try {
                if (!value) {
                    return defaultValue;
                }
                return typeof value === "string" ? JSON.parse(value) : value;
            } catch (err) {
                return defaultValue;
            }
        };

        /* ============================================================
           FORMAT RESPONSE
        ============================================================ */
        const formattedApplication = {
            ...application,
            expertise: parseJSON(application.expertise),
            learning_outcomes: parseJSON(application.learning_outcomes),
            course_structure: parseJSON(application.course_structure),
            teaching_flow: parseJSON(application.teaching_flow),
            sample_video_url: parseJSON(application.sample_video_url),
            documents: parseJSON(application.documents)
        };

        return successResponse(res, formattedApplication, "Your educator application fetched successfully");

    } catch (error) {
        console.error("Get My Application Error:", error);

        return errorResponse(res, error.message || "Internal server error", 500);
    }
});

/* ============================================================
   1️⃣ APPLY AS EDUCATOR
   ------------------------------------------------------------
   @route   POST /api/educator/application
   @desc    Submit educator application form
   @access  Private (Logged-in users)
============================================================ */
router.post("/", auth, EducatorApplicationsFilesUpload.fields([
    {
        name: "sample_video_url",
        maxCount: 20
    },
    {
        name: "documents",
        maxCount: 20
    }
]), async (req, res) => {
    try {
        const mysql = getMySQLConnection();

        let {
            full_name, email, phone, address, expertise, other_expertise, experience_years, education, role_title,
            course_title, target_audience, course_description, learning_outcomes, course_structure,
            sample_lesson_title, sample_lesson_objective, teaching_flow, assessment_method, video_duration_minutes } = req.body;

        /* ============================================================
           VALIDATION
        ============================================================ */
        if (!full_name || !email || !phone || !course_title) {
            return errorResponse(res, "Full name, email, phone and course title are required", 400);
        }

        /* ============================================================
           PREVENT DUPLICATE APPLICATION
        ============================================================ */
        const [[existing]] = await mysql.execute(`SELECT id FROM educator_applications WHERE user_id = ?`, [req.user.id]);
        if (existing) { return errorResponse(res, "Application already submitted", 400); }

        /* ============================================================
           PARSE JSON FIELDS
        ============================================================ */
        try {
            expertise = typeof expertise === "string" ? JSON.parse(expertise) : expertise;
            learning_outcomes = typeof learning_outcomes === "string" ? JSON.parse(learning_outcomes) : learning_outcomes;
            course_structure = typeof course_structure === "string" ? JSON.parse(course_structure) : course_structure;
            teaching_flow = typeof teaching_flow === "string" ? JSON.parse(teaching_flow) : teaching_flow;
        } catch (jsonError) {
            return errorResponse(res, "Invalid JSON format in request body", 400);
        }

        /* ============================================================
           HANDLE SAMPLE VIDEO FILES
        ============================================================ */
        let uploadedVideos = [];
        if (req.files && req.files.sample_video_url && req.files.sample_video_url.length > 0) {
            uploadedVideos = req.files.sample_video_url.map((file) => ({
                original_name: file.originalname,
                mime_type: file.mimetype,
                size: file.size,
                url: file.location,
                key: file.key
            }));
        }

        /* ============================================================
           HANDLE DOCUMENT FILES
        ============================================================ */
        let uploadedDocuments = [];
        if (req.files && req.files.documents && req.files.documents.length > 0) {
            uploadedDocuments = req.files.documents.map((file) => ({
                original_name: file.originalname,
                mime_type: file.mimetype,
                size: file.size,
                url: file.location,
                key: file.key
            }));
        }

        /* ============================================================
           INSERT APPLICATION
        ============================================================ */
        const [result] = await mysql.execute(
            `
            INSERT INTO educator_applications (        
                user_id, full_name, email, phone, address,
                expertise, other_expertise, experience_years, education,
                 role_title, course_title, target_audience, course_description, learning_outcomes, course_structure,
                  sample_lesson_title, sample_lesson_objective, teaching_flow, assessment_method, sample_video_url, video_duration_minutes, documents        
            )
            VALUES ( ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,?, ?, ?,?, ?, ?, ?, ?, ?,?, ?,? )  `,
            [
                req.user.id, full_name,
                email, phone, address || null, expertise
                    ? JSON.stringify(expertise) : null, other_expertise || null, experience_years || 0, education || null, role_title || null, course_title, target_audience || null, course_description || null, learning_outcomes ? JSON.stringify(learning_outcomes)
                    : null, course_structure ? JSON.stringify(course_structure) : null, sample_lesson_title || null, sample_lesson_objective || null, teaching_flow
                    ? JSON.stringify(teaching_flow)
                    : null,
                assessment_method || null,
                uploadedVideos.length > 0 ? JSON.stringify(uploadedVideos) : null,
                video_duration_minutes || null,
                uploadedDocuments.length > 0 ? JSON.stringify(uploadedDocuments) : null
            ]
        );

        /* ============================================================
           NOTIFICATIONS (non-blocking - never breaks the response)
        ============================================================ */
        sendEducatorNotification({
            mysql,
            event: EDUCATOR_NOTIFICATION_EVENTS.APPLICATION_SUBMITTED,
            userId: req.user.id,
            actorId: req.user.id,
            data: {},
            metadata: { application_id: result.insertId }
        });

        /* ============================================================
           SUCCESS RESPONSE
        ============================================================ */
        return successResponse(res, { id: result.insertId, uploadedVideos, uploadedDocuments }, "Educator application submitted successfully", 201);

    } catch (error) {
        console.error("Educator Application Error:", error);
        return errorResponse(res, error.message || "Internal server error", 500);
    }
}
);


/* ============================================================
   2️⃣ GET ALL APPLICATIONS
   ------------------------------------------------------------
   @route   GET /api/educator/application
   @desc    Get all educator applications
   @access  Private (Admin / Superadmin)
============================================================ */
router.get("/", auth, async (req, res) => {
    try {
        // if (!["admin", "superadmin"].includes(req.user.user_type)
        // ) {
        //     return errorResponse(res, "Unauthorized access", 403);
        // }
        const mysql = getMySQLConnection();

        /* ============================================================
           QUERY PARAMS
        ============================================================ */
        let { status, page = 1, limit = 10, search } = req.query;
        page = Number(page) || 1;
        limit = Number(limit) || 10;
        const offset = (page - 1) * limit;

        /* ============================================================
           BASE QUERY
        ============================================================ */
        let query = `
            SELECT
                e.*,
                u.first_name,
                u.last_name,
                u.email AS user_email,
                u.avatar,
                u.is_verified AS user_verified
            FROM educator_applications e
            LEFT JOIN users u
                ON e.user_id = u.id
            WHERE 1 = 1
        `;

        let countQuery = `
            SELECT COUNT(*) AS total
            FROM educator_applications e
            WHERE 1 = 1
        `;

        let params = [];
        let countParams = [];

        /* ============================================================
           FILTER: STATUS
        ============================================================ */
        if (status) {
            query += ` AND e.status = ?`;
            countQuery += ` AND e.status = ?`;
            params.push(status);
            countParams.push(status);
        }

        /* ============================================================
           SEARCH FILTER
        ============================================================ */
        if (search) {
            query += `
                AND (
                    e.full_name LIKE ?
                    OR e.email LIKE ?
                    OR e.phone LIKE ?
                    OR e.course_title LIKE ?
                )
            `;

            countQuery += `
                AND (
                    e.full_name LIKE ?
                    OR e.email LIKE ?
                    OR e.phone LIKE ?
                    OR e.course_title LIKE ?
                )
            `;

            const searchValue = `%${search}%`;
            params.push(searchValue, searchValue, searchValue, searchValue);
            countParams.push(searchValue, searchValue, searchValue, searchValue);
        }

        /* ============================================================
           ORDER + PAGINATION
        ============================================================ */
        query += ` ORDER BY e.created_at DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        /* ============================================================
           EXECUTE QUERIES
        ============================================================ */
        const [rows] = await mysql.execute(query, params);
        const [[totalResult]] = await mysql.execute(countQuery, countParams);

        /* ============================================================
           PARSE JSON FIELDS
        ============================================================ */
        const parsedRows = rows.map((item) => {
            const parseJSON = (value, defaultValue = []) => {
                try {
                    if (!value) return defaultValue;
                    return typeof value === "string" ? JSON.parse(value) : value;
                } catch (err) {
                    return defaultValue;
                }
            };

            return {
                ...item,
                expertise: parseJSON(item.expertise),
                learning_outcomes: parseJSON(item.learning_outcomes),
                course_structure: parseJSON(item.course_structure),
                teaching_flow: parseJSON(item.teaching_flow),
                documents: parseJSON(item.documents),
                sample_video_url: parseJSON(item.sample_video_url)
            };
        });

        /* ============================================================
           RESPONSE
        ============================================================ */
        return successResponse(res,
            {
                applications: parsedRows,
                pagination: {
                    total: totalResult.total,
                    current_page: page,
                    per_page: limit,
                    total_pages: Math.ceil(totalResult.total / limit)
                }
            },
            "Educator applications fetched successfully"
        );

    } catch (error) {
        console.error("Get Applications Error:", error);
        return errorResponse(res, error.message || "Internal server error", 500);
    }
});


/* ============================================================
   3️⃣ GET SINGLE APPLICATION
   ------------------------------------------------------------
   @route   GET /api/educator/application/:id
   @desc    Get single educator application
   @access  Private (Owner or Admin)
============================================================ */
router.get("/:id", auth, async (req, res) => {
    try {
        const mysql = getMySQLConnection();
        const { id } = req.params;
        /* ============================================================
           VALIDATION
        ============================================================ */
        if (!id || isNaN(id)) {
            return errorResponse(res, "Valid application ID is required", 400);
        }

        /* ============================================================
           FETCH APPLICATION
        ============================================================ */
        const [[app]] = await mysql.execute(
            `
            SELECT
                e.*,
                u.first_name,
                u.last_name,
                u.email AS user_email,
                u.phone AS user_phone,
                u.avatar,
                u.country,
                u.state_province,
                u.city,
                u.is_verified AS user_verified,
                u.created_at AS user_created_at
            FROM educator_applications e
            LEFT JOIN users u
                ON e.user_id = u.id
            WHERE e.id = ?
            LIMIT 1
            `,
            [id]
        );

        /* ============================================================
           NOT FOUND
        ============================================================ */
        if (!app) {
            return errorResponse(res, "Application not found", 404);
        }

        /* ============================================================
           AUTHORIZATION
        ============================================================ */
        // const isAdmin = ["admin", "superadmin"].includes(req.user.user_type);
        // const isOwner = Number(app.user_id) === Number(req.user.id);
        // if (!isOwner && !isAdmin) {
        //     return errorResponse(res, "Unauthorized access", 403);
        // }

        /* ============================================================
           SAFE JSON PARSER
        ============================================================ */
        const parseJSON = (value, defaultValue = []) => {
            try {
                if (!value) return defaultValue;
                return typeof value === "string" ? JSON.parse(value) : value;
            } catch (err) {
                return defaultValue;
            }
        };

        /* ============================================================
           FORMAT RESPONSE
        ============================================================ */
        const formattedApplication = {
            ...app,
            expertise: parseJSON(app.expertise),
            learning_outcomes: parseJSON(app.learning_outcomes),
            course_structure: parseJSON(app.course_structure),
            teaching_flow: parseJSON(app.teaching_flow),
            documents: parseJSON(app.documents),
            sample_video_url: parseJSON(app.sample_video_url)
        };

        /* ============================================================
           RESPONSE
        ============================================================ */
        return successResponse(res, formattedApplication, "Educator application fetched successfully");
    } catch (error) {
        console.error("Get Single Application Error:", error);
        return errorResponse(res, error.message || "Internal server error", 500);
    }
});


/* ============================================================
   4️⃣ UPDATE APPLICATION
   ------------------------------------------------------------
   @route   PUT /api/educator/application/:id
   @desc    Update educator application
   @access  Private (Owner Only)
============================================================ */
router.put("/:id", auth, EducatorApplicationsFilesUpload.fields([
    {
        name: "sample_video_url",
        maxCount: 20
    },
    {
        name: "documents",
        maxCount: 20
    }
]),
    async (req, res) => {
        try {
            const mysql = getMySQLConnection();
            const { id } = req.params;
            /* ============================================================
               VALIDATION
            ============================================================ */
            if (!id || isNaN(id)) {
                return errorResponse(res, "Valid application ID is required", 400);
            }

            /* ============================================================
               FETCH EXISTING APPLICATION
            ============================================================ */
            const [[existing]] = await mysql.execute(
                `
                SELECT *
                FROM educator_applications
                WHERE id = ?
                LIMIT 1
                `,
                [id]
            );

            if (!existing) {
                return errorResponse(res, "Application not found", 404);
            }

            /* ============================================================
               OWNER CHECK
            ============================================================ */
            if (Number(existing.user_id) !== Number(req.user.id)) {
                return errorResponse(res, "Unauthorized access", 403);
            }

            /* ============================================================
               STATUS CHECK
            ============================================================ */
            if (existing.status !== "pending") {
                return errorResponse(res, "Application cannot be updated after review", 400);
            }
            req.files = req.files || {};

            /* ============================================================
               BODY DATA
            ============================================================ */
            let {
                full_name,
                email,
                phone,
                address,
                expertise,
                other_expertise,
                experience_years,
                education,
                role_title,
                course_title,
                target_audience,
                course_description,
                learning_outcomes,
                course_structure,
                sample_lesson_title,
                sample_lesson_objective,
                teaching_flow,
                assessment_method,
                video_duration_minutes
            } = req.body;

            /* ============================================================
               SAFE JSON PARSER
            ============================================================ */
            const parseJSON = (value, defaultValue = []) => {
                try {
                    if (!value) {
                        return defaultValue;
                    }
                    return typeof value === "string" ? JSON.parse(value) : value;
                } catch (err) {
                    return defaultValue;
                }
            };

            expertise = parseJSON(expertise);
            learning_outcomes = parseJSON(learning_outcomes);
            course_structure = parseJSON(course_structure);
            teaching_flow = parseJSON(teaching_flow);
            /* ============================================================
               NUMBER CONVERSION
            ============================================================ */
            experience_years = Number(experience_years) || existing.experience_years;
            video_duration_minutes = Number(video_duration_minutes) || existing.video_duration_minutes;
            /* ============================================================
               EXISTING FILES
            ============================================================ */
            let existingVideos = parseJSON(existing.sample_video_url);
            let existingDocuments = parseJSON(existing.documents);

            /* ============================================================
               NEW VIDEO FILES
            ============================================================ */
            let uploadedVideos = [];
            if (req.files.sample_video_url && req.files.sample_video_url.length > 0) {
                uploadedVideos =
                    req.files.sample_video_url.map(
                        (file) => ({
                            original_name: file.originalname,
                            mime_type: file.mimetype,
                            size: file.size,
                            url: file.location,
                            key: file.key
                        })
                    );
            }
            /* ============================================================
               NEW DOCUMENT FILES
            ============================================================ */
            let uploadedDocuments = [];
            if (req.files.documents && req.files.documents.length > 0) {
                uploadedDocuments =
                    req.files.documents.map(
                        (file) => ({
                            original_name: file.originalname,
                            mime_type: file.mimetype,
                            size: file.size,
                            url: file.location,
                            key: file.key
                        })
                    );
            }

            /* ============================================================
               MERGE OLD + NEW FILES
            ============================================================ */
            const finalVideos = [...existingVideos, ...uploadedVideos];
            const finalDocuments = [...existingDocuments, ...uploadedDocuments];

            /* ============================================================
               UPDATE APPLICATION
            ============================================================ */
            await mysql.execute(
                `
                UPDATE educator_applications
                SET
                    full_name = ?,
                    email = ?,
                    phone = ?,
                    address = ?,
                    expertise = ?,
                    other_expertise = ?,
                    experience_years = ?,
                    education = ?,
                    role_title = ?,
                    course_title = ?,
                    target_audience = ?,
                    course_description = ?,
                    learning_outcomes = ?,
                    course_structure = ?,
                    sample_lesson_title = ?,
                    sample_lesson_objective = ?,
                    teaching_flow = ?,
                    assessment_method = ?,
                    sample_video_url = ?,
                    video_duration_minutes = ?,
                    documents = ?
                WHERE id = ?
                `,
                [
                    full_name || existing.full_name,
                    email || existing.email,
                    phone || existing.phone,
                    address || existing.address,
                    JSON.stringify(expertise),
                    other_expertise || existing.other_expertise,
                    experience_years,
                    education || existing.education,
                    role_title || existing.role_title,
                    course_title || existing.course_title,
                    target_audience || existing.target_audience,
                    course_description || existing.course_description,
                    JSON.stringify(learning_outcomes),
                    JSON.stringify(course_structure),
                    sample_lesson_title || existing.sample_lesson_title,
                    sample_lesson_objective || existing.sample_lesson_objective,
                    JSON.stringify(teaching_flow),
                    assessment_method || existing.assessment_method,
                    JSON.stringify(finalVideos),
                    video_duration_minutes,
                    JSON.stringify(finalDocuments),
                    id
                ]
            );

            /* ============================================================
               FETCH UPDATED APPLICATION
            ============================================================ */
            const [[updatedApplication]] =
                await mysql.execute(` SELECT * FROM educator_applications WHERE id = ? LIMIT 1 `, [id]);

            /* ============================================================
               FORMAT RESPONSE
            ============================================================ */
            const formattedResponse = {
                ...updatedApplication,
                expertise: parseJSON(updatedApplication.expertise),
                learning_outcomes: parseJSON(updatedApplication.learning_outcomes),
                course_structure: parseJSON(updatedApplication.course_structure),
                teaching_flow: parseJSON(updatedApplication.teaching_flow),
                sample_video_url: parseJSON(updatedApplication.sample_video_url),
                documents: parseJSON(updatedApplication.documents)
            };

            /* ============================================================
               SUCCESS RESPONSE
            ============================================================ */
            return successResponse(res, formattedResponse, "Educator application updated successfully");

        } catch (error) {
            console.error("Update Application Error:", error);
            return errorResponse(res, error.message || "Internal server error", 500);
        }
    }
);


/* ============================================================
   5️⃣ MODERATE APPLICATION (APPROVE / REJECT)
   ------------------------------------------------------------
   @route   PUT /api/educator/application/:id/status
   @desc    Approve or reject educator application
   @access  Private (Admin / Superadmin)

   BODY:
   {
     status: "approved" | "rejected",
     reason?: string
   }
============================================================ */
router.put("/:id/status", auth, async (req, res) => {
    const mysql = getMySQLConnection();
    try {
        /* ============================================================
           AUTHORIZATION CHECK
        ============================================================ */
        if (!["admin", "superadmin"].includes(req.user.user_type)) {
            return errorResponse(res, "Unauthorized access", 403);
        }
        const { id } = req.params;
        let { status, reason } = req.body;
        /* ============================================================
           VALIDATION
        ============================================================ */
        if (!id || isNaN(id)) {
            return errorResponse(res, "Valid application ID is required", 400);
        } if (!["approved", "rejected"].includes(status)) {
            return errorResponse(res, "Status must be approved or rejected", 400);
        }
        if (status === "rejected" && !reason) {
            return errorResponse(res, "Rejection reason is required", 400);
        }
        /* ============================================================
           FETCH APPLICATION
        ============================================================ */
        const [[application]] = await mysql.execute(` SELECT *  FROM educator_applications  WHERE id = ?  LIMIT 1`, [id]);
        if (!application) {
            return errorResponse(res, "Educator application not found", 404);
        }

        /* ============================================================
           PREVENT DOUBLE PROCESS
        ============================================================ */
        // if (
        //     ["approved", "rejected"]
        //         .includes(application.status)
        // ) {

        //     return errorResponse(
        //         res,
        //         `Application already ${application.status}`,
        //         400
        //     );
        // }

        /* ============================================================
           UPDATE APPLICATION STATUS
        ============================================================ */
        await mysql.execute(
            `UPDATE educator_applications SET status = ?, is_verified = ?, reviewed_by = ?, reviewed_at = ?, rejection_reason = ? WHERE id = ?`,
            [
                status,
                status === "approved" ? 1 : 0,
                req.user.id,
                new Date(),
                status === "rejected" ? reason : null,
                id
            ]
        );

        /* ============================================================
           IF APPROVED
        ============================================================ */
        if (status === "approved") {

            /* --------------------------------------------------
               FETCH USER
            -------------------------------------------------- */
            const [[user]] =
                await mysql.execute(`SELECT badges, permissions FROM users WHERE id = ? LIMIT 1`,
                    [application.user_id]
                );

            if (!user) {
                return errorResponse(res, "User not found", 404);
            }

            /* --------------------------------------------------
               PARSE EXISTING DATA
            -------------------------------------------------- */
            let existingBadges = [];
            let existingPermissions = {};

            try {

                existingBadges = user.badges ? JSON.parse(user.badges) : [];
                existingPermissions = user.permissions ? JSON.parse(user.permissions) : {};
            } catch (err) {
                return errorResponse(res, "Invalid user permissions JSON", 500);
            }

            /* --------------------------------------------------
               ADD EDUCATOR BADGE
            -------------------------------------------------- */
            const EDUCATOR_BADGE = "Educator";
            if (!existingBadges.includes(EDUCATOR_BADGE)) {
                existingBadges.push(EDUCATOR_BADGE);
            }

            /* --------------------------------------------------
               FETCH ROLE PERMISSIONS
            -------------------------------------------------- */
            const [[roleData]] = await mysql.execute(` SELECT permissions FROM role_permissions WHERE role_name = ? LIMIT 1 `, [EDUCATOR_BADGE]);
            let educatorPermissions = {};
            if (roleData && roleData.permissions) {
                try {
                    educatorPermissions = JSON.parse(roleData.permissions);
                } catch (err) {
                    return errorResponse(res, "Invalid role permissions JSON", 500);
                }
            }

            /* --------------------------------------------------
               MERGE PERMISSIONS
            -------------------------------------------------- */
            const mergePermissions = (source, target) => {
                Object.entries(source).forEach(([key, value]) => {
                    if (value === "x") {
                        target[key] = "x";
                        return;
                    }
                    if (value === "-") {
                        return;
                    }
                    if (typeof value === "object" && value !== null) {
                        if (!target[key]) {
                            target[key] = {};
                        }
                        mergePermissions(value, target[key]);
                        if (Object.keys(target[key]).length === 0) {
                            delete target[key];
                        }
                    }
                });
            };

            mergePermissions(educatorPermissions, existingPermissions);
            /* --------------------------------------------------
               UPDATE USER
            -------------------------------------------------- */
            await mysql.execute(` UPDATE users  SET badges = ?, permissions = ?, is_verified = 1, is_educator = 1 WHERE id = ? `,
                [
                    JSON.stringify(existingBadges),
                    JSON.stringify(existingPermissions),
                    application.user_id
                ]
            );
        }

        /* ============================================================
           NOTIFICATIONS (non-blocking - never breaks the response)
        ============================================================ */
        sendEducatorNotification({
            mysql,
            event: status === "approved"
                ? EDUCATOR_NOTIFICATION_EVENTS.APPLICATION_APPROVED
                : EDUCATOR_NOTIFICATION_EVENTS.APPLICATION_REJECTED,
            userId: application.user_id,
            actorId: req.user.id,
            data: status === "rejected" ? { reason } : {},
            metadata: { application_id: parseInt(id) }
        });

        /* ============================================================
           FETCH UPDATED APPLICATION
        ============================================================ */
        const [[updatedApplication]] = await mysql.execute(`SELECT *  FROM educator_applications  WHERE id = ?  LIMIT 1`, [id]);

        /* ============================================================
           SAFE JSON PARSER
        ============================================================ */
        const parseJSON = (value, defaultValue = []) => {
            try {
                if (!value) {
                    return defaultValue;
                }
                return typeof value === "string" ? JSON.parse(value) : value;
            } catch (err) {
                return defaultValue;
            }
        };

        /* ============================================================
           FORMAT RESPONSE
        ============================================================ */
        const formattedResponse = {
            ...updatedApplication,
            expertise: parseJSON(updatedApplication.expertise),
            learning_outcomes: parseJSON(updatedApplication.learning_outcomes),
            course_structure: parseJSON(updatedApplication.course_structure),
            teaching_flow: parseJSON(updatedApplication.teaching_flow),
            sample_video_url: parseJSON(updatedApplication.sample_video_url),
            documents: parseJSON(updatedApplication.documents)
        };

        /* ============================================================
           SUCCESS RESPONSE
        ============================================================ */
        return successResponse(res, formattedResponse, `Educator application ${status} successfully`);
    } catch (error) {
        console.error("Moderation Error:", error);
        return errorResponse(res, error.message || "Internal server error", 500
        );
    }
});



module.exports = router;