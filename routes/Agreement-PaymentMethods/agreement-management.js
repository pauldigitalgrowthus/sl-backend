const express = require('express');
const { getMySQLConnection } = require('../../config/mysql');
const { auth } = require('../../middleware/auth');
const { successResponse, errorResponse } = require('../../utils/response');
const { createAndDeliverNotification } = require('../../utils/notificationUtils')
const { sendEmail } = require("../../utils/SendMailer")
const router = express.Router();

// @route   GET /api/agreements
// @desc    Get all agreements with pagination
// @access  Private (SL Team/Admin only)
router.get("/", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;

        // =================================================
        // FETCH AGREEMENTS
        // =================================================
        const [rows] = await mysqlConnection.execute(
            `SELECT * FROM agreements
             ORDER BY uploaded_on DESC
             LIMIT ? OFFSET ?`,
            [limit, offset]
        );

        if (!rows.length)
            return successResponse(res, [], "No agreements found", 200);

        // =================================================
        // COLLECT ALL USER IDS (single query optimization)
        // =================================================
        const allUserIds = new Set();

        rows.forEach(r => {
            try {
                const ids = r.user_ids ? JSON.parse(r.user_ids) : [];
                ids.forEach(id => allUserIds.add(id));
            } catch { }
        });

        // =================================================
        // FETCH USERS ONCE
        // =================================================
        let usersMap = {};

        if (allUserIds.size) {
            const placeholders = [...allUserIds].map(() => "?").join(",");

            const [users] = await mysqlConnection.execute(
                `SELECT id, first_name, last_name, email
                 FROM users
                 WHERE id IN (${placeholders})`,
                [...allUserIds]
            );

            users.forEach(u => {
                usersMap[u.id] = u;
            });
        }

        // =================================================
        // POPULATE DATA
        // =================================================
        const parsedRows = rows.map(row => {
            try {
                row.badges = row.badges ? JSON.parse(row.badges) : [];
                const ids = row.user_ids ? JSON.parse(row.user_ids) : [];

                row.users = ids
                    .map(id => usersMap[id])
                    .filter(Boolean); // remove missing
            } catch {
                row.badges = [];
                row.users = [];
            }

            delete row.user_ids; // optional clean
            return row;
        });

        successResponse(
            res,
            parsedRows,
            "Agreements fetched successfully",
            200
        );

    } catch (error) {
        console.error(error);
        errorResponse(res, `Failed to Fetch Agreements: ${error.message}`, 500);
    }
});

// @route   POST /api/agreements
// @desc    Create or update agreement (optimized + fast)
// @access  Private
router.post("/", auth, async (req, res) => {
    const mysql = getMySQLConnection();
    const connection = await mysql.getConnection();

    try {
        await connection.beginTransaction();

        let {
            agreement_title,
            agreement_type,
            badges,
            file_name,
            file_path,
            signature_position,
            description,
            agreement_format,
            userId,
            savedAgreementID,
            applies_to_diocesan = false
        } = req.body;

        const pagelink = process.env.FRONTEND_URL;

        // =================================================
        // LOAD FROM saved_agreements
        // =================================================
        if (savedAgreementID) {
            const [saved] = await connection.execute(
                `SELECT agreement_title,file_name,file_path,agreement_type,signature_position,agreement_format
                 FROM saved_agreements
                 WHERE id=? AND status=1`,
                [savedAgreementID]
            );

            if (!saved.length)
                return errorResponse(res, "Saved agreement not found", 404);

            ({
                agreement_title,
                file_name,
                file_path,
                agreement_type
            } = saved[0]);

            // Use saved format as fallback if not explicitly provided in request
            if (!agreement_format && saved[0].agreement_format)
                agreement_format = saved[0].agreement_format;

            if (!signature_position && saved[0].signature_position)
                signature_position = JSON.parse(saved[0].signature_position);
        }

        if (!agreement_title || !agreement_type)
            return errorResponse(res, "Missing required fields", 400);

        // PDF agreements require a file; HTML agreements require a description
        if (agreement_format === 'pdf' && (!file_name || !file_path))
            return errorResponse(res, "PDF agreements require file_name and file_path", 400);

        if (agreement_format === 'html' && !description)
            return errorResponse(res, "HTML agreements require a description", 400);

        // =================================================
        // BUILD TARGET USER QUERY (SQL level filtering 🔥)
        // =================================================
        let usersQuery = `SELECT id, first_name, last_name, email FROM users WHERE 1=1`;
        const params = [];

        if (Array.isArray(userId) && userId.length) {
            usersQuery += ` AND id IN (${userId.map(() => "?").join(",")})`;
            params.push(...userId);
        }
        else if (badges?.length) {
            usersQuery += ` AND JSON_OVERLAPS(badges, ?)`;
            params.push(JSON.stringify(badges));
        }
        else if (applies_to_diocesan) {
            usersQuery += ` AND is_diocesan=1`;
        }

        const [targetUsers] = await connection.execute(usersQuery, params);

        const newUserIds = targetUsers.map(u => u.id);

        // =================================================
        // CHECK EXISTING AGREEMENT
        // =================================================
        let agreementId;
        let existingUserIds = [];

        if (savedAgreementID) {
            const [existing] = await connection.execute(
                `SELECT id,user_ids FROM agreements WHERE savedAgreementID=?`,
                [savedAgreementID]
            );

            if (existing.length) {
                agreementId = existing[0].id;
                existingUserIds = existing[0].user_ids
                    ? JSON.parse(existing[0].user_ids)
                    : [];
            }
        }

        // =================================================
        // MERGE USERS
        // =================================================
        const mergedUserIds = [...new Set([...existingUserIds, ...newUserIds])];

        const onlyNewUsers = targetUsers.filter(
            u => !existingUserIds.includes(u.id)
        );

        // =================================================
        // INSERT OR UPDATE
        // =================================================
        if (agreementId) {
            await connection.execute(
                `UPDATE agreements
                 SET user_ids=?,badges=?,applies_to_diocesan=?,signature_position=?,description=?,agreement_format=?
                 WHERE id=?`,
                [
                    JSON.stringify(mergedUserIds),
                    badges ? JSON.stringify(badges) : null,
                    applies_to_diocesan ? 1 : 0,
                    signature_position ? JSON.stringify(signature_position) : null,
                    description ? JSON.stringify(description) : null,
                    agreement_format || null,
                    agreementId
                ]
            );
        } else {
            const [result] = await connection.execute(
                `INSERT INTO agreements
                (agreement_title,file_name,file_path,agreement_type,badges,user_ids,
                 applies_to_diocesan,signature_position,description,agreement_format,savedAgreementID)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                [
                    agreement_title,
                    file_name || null,
                    file_path || null,
                    agreement_type,
                    badges ? JSON.stringify(badges) : null,
                    JSON.stringify(mergedUserIds),
                    applies_to_diocesan ? 1 : 0,
                    signature_position ? JSON.stringify(signature_position) : null,
                    description ? JSON.stringify(description) : null,
                    agreement_format || null,
                    savedAgreementID || null
                ]
            );

            agreementId = result.insertId;
        }

        await connection.commit();

        // =================================================
        // NOTIFY + EMAIL (PARALLEL 🔥 FAST)
        // =================================================
        await Promise.all(
            onlyNewUsers.map(user => {
                const emailHtml = `
                  <p>Hello ${user.first_name},</p>
                  <p>You have a new agreement assigned.</p>
                  <a href="${pagelink}/agreements">View Agreement</a>
                `;

                return Promise.all([
                    createAndDeliverNotification({
                        title: `New Agreement Available: ${agreement_title}`,
                        body: `A new agreement has been assigned to you.`,
                        metadata: { agreement_id: agreementId },
                        channel: "inbox",
                        target: { type: "custom", user_ids: [user.id] }
                    }),
                    sendEmail({
                        to: user.email,
                        subject: `New Agreement Assigned: ${agreement_title}`,
                        html: emailHtml
                    })
                ]);
            })
        );

        return successResponse(
            res,
            {
                id: agreementId,
                assigned_users: mergedUserIds,
                new_users_notified: onlyNewUsers.map(u => u.id)
            },
            "Agreement processed successfully",
            201
        );

    } catch (err) {
        await connection.rollback();
        console.error(err);
        return errorResponse(res, err.message, 500);
    } finally {
        connection.release();
    }
});

// @route   PUT /api/agreements/:id
// @desc    Update an existing agreement
// @access  Private (SL Team/Admin only)
router.put("/:id", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const agreementId = req.params.id;

        if (!agreementId) {
            return errorResponse(res, "Agreement ID is required", 400);
        }

        const {
            agreement_title,
            agreement_type,

            badges,
            file_name,
            file_path,
            signature_position,
            description,
            agreement_format
        } = req.body;

        // Fetch existing agreement to validate existence
        const [existing] = await mysqlConnection.execute(
            `SELECT * FROM agreements WHERE id = ?`,
            [agreementId]
        );

        if (existing.length === 0) {
            return errorResponse(res, "Agreement not found", 404);
        }

        // Prepare update fields dynamically
        const updateFields = [];
        const updateValues = [];

        if (agreement_title !== undefined) {
            updateFields.push("agreement_title = ?");
            updateValues.push(agreement_title);
        }

        if (agreement_type !== undefined) {
            updateFields.push("agreement_type = ?");
            updateValues.push(agreement_type);
        }

        if (badges !== undefined) {
            updateFields.push("badges = ?");
            updateValues.push(JSON.stringify(badges));
        }

        if (file_name !== undefined) {
            updateFields.push("file_name = ?");
            updateValues.push(file_name);
        }

        if (file_path !== undefined) {
            updateFields.push("file_path = ?");
            updateValues.push(file_path);
        }

        if (signature_position !== undefined) {
            updateFields.push("signature_position = ?");
            updateValues.push(signature_position ? JSON.stringify(signature_position) : null);
        }

        if (description !== undefined) {
            updateFields.push("description = ?");
            updateValues.push(description ? JSON.stringify(description) : null);
        }

        if (agreement_format !== undefined) {
            updateFields.push("agreement_format = ?");
            updateValues.push(agreement_format || null);
        }

        if (updateFields.length === 0) {
            return errorResponse(res, "No fields provided to update", 400);
        }

        // Execute Update
        updateValues.push(agreementId);

        await mysqlConnection.execute(
            `UPDATE agreements SET ${updateFields.join(", ")} WHERE id = ?`,
            updateValues
        );

        return successResponse(res, { id: agreementId }, "Agreement updated successfully", 200);

    } catch (error) {
        console.error("Error updating agreement:", error);
        return errorResponse(res, `Failed to update agreement: ${error.message}`, 500);
    }
});

// @route   PUT /api/agreements/status/:id
// @desc    Update the status of an agreement
// @access  Private   (SL Team/Admin only)
router.put("/status/:id", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const { id } = req.params;
        const { status } = req.body; // 0 or 1

        await mysqlConnection.execute(
            `UPDATE agreements SET status = ? WHERE id = ?`,
            [status, id]
        );
        successResponse(res, null, "Status updated successfully", 200);

    } catch (error) {
        console.error(error);
        errorResponse(res, `Failed to update status: ${error.message}`, 500);
    }
});

// @route   GET /api/agreements/my-assignments
// @desc    Get user agreements based on badges
// @access  Private (User)
router.get("/my-assignments", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const userId = Number(req.user.id);

        // 1️⃣ Fetch user badges
        const [[user]] = await mysqlConnection.execute(
            `SELECT badges FROM users WHERE id = ? LIMIT 1`,
            [userId]
        );
        if (!user) return errorResponse(res, "User not found", 404);

        let userBadges = [];
        try {
            userBadges = user.badges ? JSON.parse(user.badges) : [];
        } catch (err) {
            userBadges = [];
        }
        if (!Array.isArray(userBadges)) userBadges = [];

        // Fetch user's published music publications to map admin signature details
        const [publications] = await mysqlConnection.execute(
            `SELECT id, composition_title, ContractHTMLJSON, published_at, created_at, finalContractTime, signedContractUrl, composition_description FROM music_publications WHERE composer_id = ? AND status = 'published'`,
            [userId]
        );

        const pubMap = new Map();
        const matchedTitles = new Set();

        for (const pub of publications) {
            let contractData = null;
            if (pub.ContractHTMLJSON) {
                try {
                    contractData = typeof pub.ContractHTMLJSON === "string"
                        ? JSON.parse(pub.ContractHTMLJSON)
                        : pub.ContractHTMLJSON;
                } catch (e) {
                    // Ignore
                }
            }
            if (contractData && pub.composition_title) {
                const titleKey = pub.composition_title.trim().toLowerCase();
                pubMap.set(titleKey, {
                    pubId: pub.id,
                    publishedAt: pub.published_at,
                    createdAt: pub.created_at,
                    finalContractTime: pub.finalContractTime,
                    signedContractUrl: pub.signedContractUrl,
                    description: pub.composition_description,
                    composerSignedPdfUrl: contractData.composerSignedPdfUrl || null,
                    adminSignatureUrl: contractData.adminSignatureUrl || null,
                    adminSignedPdfUrl: contractData.adminSignedPdfUrl || null,
                    adminSignedDate: contractData.adminSignedDate || null
                });
            }
        }

        // 2️⃣ Fetch all active agreements
        const [agreements] = await mysqlConnection.execute(
            `SELECT * FROM agreements WHERE status = 1`
        );

        const results = [];
        const included = new Map();

        // Helper: safe parse JSON array fields
        const safeParseArray = (raw) => {
            if (!raw) return [];
            try {
                const parsed = JSON.parse(raw);
                return Array.isArray(parsed) ? parsed : [];
            } catch (e) {
                if (typeof raw === "string") {
                    return raw.split(",").map((s) => s.trim()).filter(Boolean);
                }
                return [];
            }
        };

        for (const ag of agreements) {
            if (included.has(ag.id)) continue;

            const agBadges = safeParseArray(ag.badges);
            const agUserIds = safeParseArray(ag.user_ids);

            const isDirect = agUserIds.includes(userId);
            const badgeMatch = agBadges.length && userBadges.length && agBadges.some(b => userBadges.includes(b));

            if (!isDirect && !badgeMatch) continue;

            // 3️⃣ Fetch signature details
            const [signatureRows] = await mysqlConnection.execute(
                `SELECT * FROM user_signatures_documents WHERE user_id = ? AND document_id = ? AND deleted_at IS NULL LIMIT 1`,
                [userId, ag.id]
            );

            // Get admin signature details if title matches a published publication
            const matchedPub = ag.agreement_title ? pubMap.get(ag.agreement_title.trim().toLowerCase()) : null;
            if (matchedPub) {
                matchedTitles.add(ag.agreement_title.trim().toLowerCase());
            }

            let status = "pending";
            let signature_details = null;
            if (signatureRows && signatureRows.length > 0) {
                status = signatureRows[0].status || "pending";
                signature_details = {
                    ...signatureRows[0],
                    adminSignatureUrl: matchedPub ? matchedPub.adminSignatureUrl : null,
                    adminSignedPdfUrl: matchedPub ? matchedPub.adminSignedPdfUrl : null,
                    adminSignedDate: matchedPub ? matchedPub.adminSignedDate : null
                };
            }

            results.push({
                agreement_id: ag.id,
                agreement_title: ag.agreement_title,
                agreements_file_name: ag.file_name,
                agreements_file_path: ag.file_path,
                document_description: ag.description || null,
                agreement_type: ag.agreement_type,
                badges: agBadges,
                assigned_via: isDirect ? "user" : "badge",
                status,
                signature_details,
                signature_position: ag.signature_position ? safeParseArray(ag.signature_position) : null,
                uploaded_on: ag.uploaded_on,
                adminSignatureUrl: matchedPub ? matchedPub.adminSignatureUrl : null,
                adminSignedPdfUrl: matchedPub ? matchedPub.adminSignedPdfUrl : null,
                adminSignedDate: matchedPub ? matchedPub.adminSignedDate : null
            });

            included.set(ag.id, true);
        }

        // Dynamically append any published publications that weren't matched as agreements
        for (const pub of publications) {
            if (!pub.composition_title) continue;
            const titleKey = pub.composition_title.trim().toLowerCase();
            if (matchedTitles.has(titleKey)) continue;

            let contractData = null;
            if (pub.ContractHTMLJSON) {
                try {
                    contractData = typeof pub.ContractHTMLJSON === "string"
                        ? JSON.parse(pub.ContractHTMLJSON)
                        : pub.ContractHTMLJSON;
                } catch (e) {
                    // Ignore
                }
            }
            if (!contractData) continue;

            const composerSignedPdfUrl = contractData.composerSignedPdfUrl || pub.signedContractUrl || null;
            const fileName = composerSignedPdfUrl ? composerSignedPdfUrl.split('/').pop() : `${pub.composition_title}_signed.pdf`;

            results.push({
                agreement_id: pub.id + 100000, // Offset to avoid conflict with standard agreement IDs
                agreement_title: pub.composition_title,
                agreements_file_name: fileName,
                agreements_file_path: composerSignedPdfUrl,
                document_description: pub.composition_description || null,
                agreement_type: "Signature",
                badges: [],
                assigned_via: "user",
                status: "signed",
                signature_details: {
                    id: pub.id + 100000,
                    user_id: userId,
                    document_id: pub.id + 100000,
                    status: "signed",
                    signature_file_name: fileName,
                    signature_file_url: composerSignedPdfUrl,
                    badge: "[]",
                    history: JSON.stringify([
                        {
                            action: "accepted",
                            timestamp: pub.finalContractTime || pub.published_at || new Date().toISOString(),
                            user_id: userId
                        }
                    ]),
                    admin_comment: "",
                    created_at: pub.finalContractTime || pub.published_at || new Date(),
                    updated_at: pub.finalContractTime || pub.published_at || new Date(),
                    deleted_at: null,
                    adminSignatureUrl: contractData.adminSignatureUrl || null,
                    adminSignedPdfUrl: contractData.adminSignedPdfUrl || null,
                    adminSignedDate: contractData.adminSignedDate || null
                },
                signature_position: null,
                uploaded_on: pub.published_at || pub.created_at || new Date(),
                adminSignatureUrl: contractData.adminSignatureUrl || null,
                adminSignedPdfUrl: contractData.adminSignedPdfUrl || null,
                adminSignedDate: contractData.adminSignedDate || null
            });
        }

        // Sort by uploaded_on descending
        results.sort((a, b) => new Date(b.uploaded_on) - new Date(a.uploaded_on));

        return successResponse(res, results, "My assignments fetched successfully");
    } catch (error) {
        console.error("my-assignments error:", error);
        return errorResponse(res, error.message || "Internal server error", 500);
    }
});

// @route POST /api/agreements/:id/admin-review
// @desc    review  user signatures by admin status update
// @access Private (Admin)
router.post("/:id/admin-review", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const { id } = req.params;
        const { status, admin_comment } = req.body;

        // Fetch existing record
        const [rows] = await mysqlConnection.execute(
            `SELECT * FROM user_signatures_documents 
       WHERE id = ? AND deleted_at IS NULL`,
            [id]
        );

        if (rows.length === 0) return errorResponse(res, "Record not found", 404);

        const record = rows[0];

        // Update history
        let history = [];
        try {
            history = record.history ? JSON.parse(record.history) : [];
        } catch (err) {
            history = [];
        }

        history.push({
            action: "admin_review",
            status,
            admin_comment,
            timestamp: new Date().toISOString(),
            admin_user_id: req.user.id,
        });

        // Update record
        const [result] = await mysqlConnection.execute(
            `UPDATE user_signatures_documents 
       SET status = ?, 
           admin_comment = ?, 
           history = ?
       WHERE id = ? AND deleted_at IS NULL`,
            [
                status,
                JSON.stringify({
                    previous: record.admin_comment ? JSON.parse(record.admin_comment) : null,
                    new: admin_comment
                }),
                JSON.stringify(history),
                id
            ]
        );

        successResponse(res, null, "Signature reviewed successfully");
    } catch (error) {
        errorResponse(res, error.message, 500);
    }
})

// @route   GET /api/agreements/:id
// @desc    Get a single agreement by ID
// @access  Private
router.get("/:id", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const { id } = req.params;

        const [rows] = await mysqlConnection.execute(
            `SELECT * FROM agreements WHERE id = ? LIMIT 1`,
            [id]
        );

        if (!rows.length) {
            return errorResponse(res, "Agreement not found", 404);
        }

        const agreement = rows[0];
        // Parse badges and signature_position
        try {
            agreement.badges = agreement.badges ? JSON.parse(agreement.badges) : [];
            agreement.signature_position = agreement.signature_position
                ? (typeof agreement.signature_position === 'string'
                    ? JSON.parse(agreement.signature_position)
                    : agreement.signature_position)
                : null;
        } catch (e) {
            agreement.badges = [];
            agreement.signature_position = null;
        }

        successResponse(res, agreement, "Agreement fetched successfully", 200);

    } catch (error) {
        console.error(error);
        errorResponse(res, `Failed to fetch agreement: ${error.message}`, 500);
    }
});

// @route   DELETE /api/agreements/:id
// @desc    Delete an agreement
// @access  Private (SL Team/Admin only)
router.delete("/:id", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const { id } = req.params;

        await mysqlConnection.execute(`DELETE FROM agreements WHERE id = ?`, [id]);
        successResponse(res, null, "Agreement deleted successfully", 200);

    } catch (error) {
        console.error(error);
        errorResponse(res, `Failed to delete agreement: ${error.message}`, 500);
    }
});


// @route GET /api/agreements/admin/signatures
// @access Private (Admin)
router.get("/admin/signatures", auth, async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();

        const [rows] = await mysqlConnection.execute(
            `SELECT usd.*, u.first_name, u.last_name, a.file_name AS document_title, a.agreement_type, a.agreement_title
             FROM user_signatures_documents usd
             JOIN users u ON usd.user_id = u.id
             JOIN agreements a ON usd.document_id = a.id
             WHERE usd.deleted_at IS NULL
             ORDER BY usd.created_at DESC`
        );

        // Badges ko expand karo - har badge ke liye alag entry
        const expandedRows = [];

        for (const row of rows) {
            let badges = [];

            try {
                // Badge ko parse karo (JSON string se array mein)
                badges = typeof row.badge === 'string'
                    ? JSON.parse(row.badge)
                    : (row.badge || []);

                // History ko bhi parse karo
                const history = typeof row.history === 'string'
                    ? JSON.parse(row.history)
                    : (row.history || []);

                // Agar badges array hai aur empty nahi hai
                if (Array.isArray(badges) && badges.length > 0) {
                    // Har badge ke liye separate entry banao
                    for (const badge of badges) {
                        expandedRows.push({
                            ...row,
                            badge: badge,           // Single badge (string)
                            all_badges: badges,     // All badges (array) - reference ke liye
                            history: history        // Parsed history
                        });
                    }
                } else {
                    // Agar koi badge nahi hai, toh bhi entry add karo
                    expandedRows.push({
                        ...row,
                        badge: null,
                        all_badges: [],
                        history: history
                    });
                }
            } catch (parseError) {
                console.error("Error parsing badges/history for row:", row.id, parseError);
                // Parse error ho toh bhi entry add karo
                expandedRows.push({
                    ...row,
                    badge: null,
                    all_badges: [],
                    history: []
                });
            }
        }

        successResponse(res, expandedRows, "All signatures fetched");
    } catch (error) {
        console.error("Error fetching signatures:", error);
        errorResponse(res, error.message, 500);
    }
});

module.exports = router;