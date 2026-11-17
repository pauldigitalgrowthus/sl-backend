const express = require("express");
const { auth } = require("../../middleware/auth");
const { getMySQLConnection } = require("../../config/mysql");
const { successResponse, errorResponse } = require("../../utils/response");
const { documentUpload, deleteFileFromS3 } = require("../../config/s3");
const { extractTOCFromPDF } = require("../../utils/extractTOC");
const { logDocumentAccess } = require("../../utils/royaltyEngine");

const router = express.Router();

// ─────────────────────────────────────────────
// HELPER: build file meta from S3 URL
// ─────────────────────────────────────────────
const getFileMeta = (url) => {
    if (!url) return null;

    const extension = url.split(".").pop().toLowerCase();
    let contentType = "application/octet-stream";

    if (extension === "pdf") contentType = "application/pdf";
    else if (["jpg", "jpeg"].includes(extension)) contentType = "image/jpeg";
    else if (extension === "png") contentType = "image/png";
    else if (extension === "doc") contentType = "application/msword";
    else if (extension === "docx")
        contentType =
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    return { url, contentDisposition: "inline", contentType };
};

// =============================================================
// CATEGORY 1. GET /api/documents/categories
//    Get all categories (filterable by type)
// =============================================================
router.get("/documents/categories", async (req, res) => {
    console.log("Fetching categories with query:", req.query);
    try {
        const db = getMySQLConnection();
        const { type } = req.query; // optional: ?type=year | publisher | category

        let query = `SELECT * FROM document_categories`;
        let params = [];

        if (type) {
            query += ` WHERE type = ?`;
            params.push(type);
        }

        query += ` ORDER BY created_at DESC`;

        const [rows] = await db.execute(query, params);

        return successResponse(res, rows, "Categories fetched successfully ✅");
    } catch (err) {
        return errorResponse(res, "Error fetching categories ❌", 500, err.message);
    }
});


// ─────────────────────────────────────────────
// HELPER: parse JSON field safely
// ─────────────────────────────────────────────
const safeParseJSON = (value, fallback = []) => {
    if (!value) return fallback;
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
};


// =============================================================
// 1. GET /api/documents/user
//    Get all documents with the calling user's active flag
// =============================================================
router.get("/documents/user", auth, async (req, res) => {
    try {
        const db = getMySQLConnection();
        const userId = req.user.id;

        const [rows] = await db.execute(
            `SELECT d.*, uad.active
             FROM user_active_document uad
             INNER JOIN documents d
               ON d.id = uad.document_id
             WHERE uad.user_id = ?
             ORDER BY d.created_at DESC`,
            [userId]
        );

        const documents = rows.map((doc) => {
            doc.toc = safeParseJSON(doc.toc);
            doc.view_logs = safeParseJSON(doc.view_logs);
            doc.file = getFileMeta(doc.file_url);
            doc.thumbnail = getFileMeta(doc.thumbnail_url);
            delete doc.file_url;
            delete doc.thumbnail_url;
            return doc;
        });

        return successResponse(res, documents, "User documents fetched successfully ✅");
    } catch (err) {
        return errorResponse(res, "Error fetching user documents ❌", 500, err.message);
    }
});


// =============================================================
// 2. POST /api/documents/active
//    Set a document as active for the user (body: document_id)
// =============================================================
router.post("/documents/active", auth, async (req, res) => {
    try {
        const db = getMySQLConnection();
        const userId = req.user.id;
        const { document_id } = req.body;

        if (!document_id) {
            return errorResponse(res, "document_id is required ❌", 400);
        }

        // Verify document exists
        const [doc] = await db.execute(
            `SELECT id FROM documents WHERE id = ?`,
            [document_id]
        );
        if (!doc.length) {
            return errorResponse(res, "Document not found ❌", 404);
        }

        // Step 1 – deactivate all
        await db.execute(
            `UPDATE user_active_document SET active = FALSE WHERE user_id = ?`,
            [userId]
        );

        // Step 2 – upsert the chosen document as active
        await db.execute(
            `INSERT INTO user_active_document (user_id, document_id, active)
             VALUES (?, ?, TRUE)
             ON DUPLICATE KEY UPDATE active = TRUE`,
            [userId, document_id]
        );

        // 🔥 ROYALTY ENGINE: log usage for subscription pro-rata Document pool
        await logDocumentAccess({ mysql: db, userId, documentId: document_id });

        return successResponse(res, { document_id }, "Active document set successfully ✅");
    } catch (err) {
        return errorResponse(res, "Error setting active document ❌", 500, err.message);
    }
});


// =============================================================
// 3. DELETE /api/documents/active
//    Remove ALL active document entries for the user
// =============================================================
router.delete("/documents/active", auth, async (req, res) => {
    try {
        const db = getMySQLConnection();
        const userId = req.user.id;

        await db.execute(
            `DELETE FROM user_active_document WHERE user_id = ?`,
            [userId]
        );

        return successResponse(res, null, "Active document removed successfully 🗑");
    } catch (err) {
        return errorResponse(res, "Error removing active document ❌", 500, err.message);
    }
});


// =============================================================
// 4. DELETE /api/documents/active/:documentId
//    Remove one specific document from the user's active list
// =============================================================
router.delete("/documents/active/:documentId", auth, async (req, res) => {
    try {
        const db = getMySQLConnection();
        const userId = req.user.id;
        const { documentId } = req.params;

        // Step 1: Check karo ki jo delete ho raha hai wo active tha ya nahi
        const [existing] = await db.execute(
            `SELECT active FROM user_active_document 
             WHERE user_id = ? AND document_id = ?`,
            [userId, documentId]
        );

        if (!existing.length) {
            return errorResponse(res, "Document not found in your list ❌", 404);
        }

        const wasActive = existing[0].active;

        // Step 2: Delete karo entry
        await db.execute(
            `DELETE FROM user_active_document 
             WHERE user_id = ? AND document_id = ?`,
            [userId, documentId]
        );

        // Step 3: Agar deleted entry active thi, toh next available ko active karo
        if (wasActive) {
            const [nextDoc] = await db.execute(
                `SELECT id FROM user_active_document 
                 WHERE user_id = ? 
                 ORDER BY id ASC 
                 LIMIT 1`,
                [userId]
            );

            if (nextDoc.length) {
                await db.execute(
                    `UPDATE user_active_document 
                     SET active = TRUE 
                     WHERE id = ?`,
                    [nextDoc[0].id]
                );
            }
        }

        return successResponse(res, null, "Document removed successfully ✅");
    } catch (err) {
        return errorResponse(res, "Error removing document ❌", 500, err.message);
    }
});


// =============================================================
// 5. GET /api/documents
//    Get all documents (paginated + filterable)
// =============================================================
router.get("/documents", async (req, res) => {
    try {
        const db = getMySQLConnection();

        let {
            page = 1,
            limit = 10,
            search,
            category,
            publisher,
            year,
            type,

            // Sorting
            sortColumn = "created_at",
            sortDirection = "desc",
        } = req.query;

        page = Math.max(1, Number(page));
        limit = Math.max(1, Number(limit));

        const offset = (page - 1) * limit;

        // =========================================================
        // Filters
        // =========================================================
        let conditions = "WHERE 1=1";
        let filterParams = [];

        // Show all docs if type=all
        // Otherwise only published docs
        if (type !== "all") {
            conditions += " AND is_published = ?";
            filterParams.push(true);
        }

        // Search
        if (search) {
            conditions += " AND document_title LIKE ?";
            filterParams.push(`%${search}%`);
        }

        // Category
        if (category) {
            conditions += " AND category = ?";
            filterParams.push(category);
        }

        // Publisher
        if (publisher) {
            conditions += " AND publisher = ?";
            filterParams.push(publisher);
        }

        // Year
        if (year) {
            conditions += " AND year = ?";
            filterParams.push(year);
        }

        // =========================================================
        // Sorting
        // =========================================================

        const allowedSortColumns = {
            document_title: "document_title",
            category: "category",
            publisher: "publisher",
            year: "CAST(year AS UNSIGNED)",
            language: "language",
            status: "is_published",
            access_type: "access_type",
            created_at: "created_at",
        };

        const sortField =
            allowedSortColumns[sortColumn] || "created_at";

        const sortOrder =
            sortDirection?.toLowerCase() === "asc"
                ? "ASC"
                : "DESC";

        // =========================================================
        // Total Count
        // =========================================================
        const [[{ total }]] = await db.execute(
            `SELECT COUNT(*) AS total
             FROM documents
             ${conditions}`,
            filterParams
        );

        // =========================================================
        // Fetch Documents
        // =========================================================
        const [rows] = await db.execute(
            `SELECT *
             FROM documents
             ${conditions}
             ORDER BY ${sortField} ${sortOrder}
             LIMIT ? OFFSET ?`,
            [...filterParams, limit, offset]
        );

        // =========================================================
        // Format Documents
        // =========================================================
        const documents = rows.map((doc) => {
            const logs = safeParseJSON(doc.view_logs);

            const uniqueUsers = new Set(
                logs.map((l) => l.user_id)
            );

            return {
                ...doc,
                copyright_notice: safeParseJSON(
                    doc.copyright_info
                ),
                toc: safeParseJSON(doc.toc),
                view_count: uniqueUsers.size,
            };
        });

        // =========================================================
        // Response
        // =========================================================
        return successResponse(
            res,
            {
                documents,
                pagination: {
                    total,
                    page,
                    limit,
                    totalPages: Math.ceil(total / limit),
                },
                sorting: {
                    sortColumn,
                    sortDirection: sortOrder,
                },
            },
            "Documents fetched successfully ✅"
        );

    } catch (err) {
        console.log(err);

        return errorResponse(
            res,
            "Error fetching documents ❌",
            500,
            err.message
        );
    }
});


// =============================================================
// 6. POST /api/documents
//    Create a new document (admin only)
// =============================================================
router.post("/documents", auth, documentUpload.fields([
    { name: "file", maxCount: 1 },
    { name: "thumbnail", maxCount: 1 },
]),
    async (req, res) => {
        try {
            const db = getMySQLConnection();
            const { document_title, category, publisher, year, description, access_type, copyright_notice, language } = req.body;
            console.log("Creating document with data:", copyright_notice);

            if (!document_title) {
                return errorResponse(res, "Document title is required ❌", 400);
            }

            const userId = req.user.id;
            const fileUrl = req.files?.file?.[0]?.location || null;
            const thumbnailUrl = req.files?.thumbnail?.[0]?.location || null;

            // Extract TOC for PDFs
            let toc = [];
            if (fileUrl && fileUrl.toLowerCase().endsWith(".pdf")) {
                try {
                    toc = await extractTOCFromPDF(fileUrl);
                } catch (err) {
                    console.error("TOC extraction failed:", err.message || err);
                    toc = [];
                }
            }

            const [result] = await db.execute(
                `INSERT INTO documents
                (document_title, category, publisher, year, description,
                 file_url, thumbnail_url, toc, access_type, copyright_info, language, created_by, upload_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  document_title,
                  category || null,
                  publisher || null,
                  year || null,
                  description || null,
                  fileUrl,
                  thumbnailUrl,
                  JSON.stringify(toc),
                  access_type,
                  copyright_notice ? JSON.stringify(copyright_notice) : null,
                  language,
                  userId,
                  userId,
                ]
              );

            return successResponse(
                res,
                { id: result.insertId, file_url: fileUrl, thumbnail_url: thumbnailUrl },
                "Document created successfully ✅",
                201
            );
        } catch (err) {
            console.log(err)
            return errorResponse(res, "Error creating document ❌", 500, err.message);
        }
    }
);


// =============================================================
// 7. GET /api/documents/:id
//    Get a single document + log the view
// =============================================================
router.get("/documents/:id", auth, async (req, res) => {
    try {
        const db = getMySQLConnection();
        const docId = req.params.id;
        const userId = req.user.id;

        const [rows] = await db.execute(
            `SELECT * FROM documents WHERE id = ?`,
            [docId]
        );

        if (!rows.length) {
            return errorResponse(res, "Document not found ❌", 404);
        }

        let doc = rows[0];
        let logs = safeParseJSON(doc.view_logs);

        // Append view log
        logs.push({ user_id: userId, viewed_at: new Date().toISOString() });

        // Persist updated view_logs
        await db.execute(
            `UPDATE documents SET view_logs = ? WHERE id = ?`,
            [JSON.stringify(logs), docId]
        );

        // Re-fetch to return latest data
        const [updatedRows] = await db.execute(
            `SELECT * FROM documents WHERE id = ?`,
            [docId]
        );
        const updatedDoc = updatedRows[0];

        updatedDoc.toc = safeParseJSON(updatedDoc.toc);
        updatedDoc.view_logs = safeParseJSON(updatedDoc.view_logs);
        updatedDoc.file = getFileMeta(updatedDoc.file_url);
        updatedDoc.thumbnail = getFileMeta(updatedDoc.thumbnail_url);
        updatedDoc.copyright_notice = safeParseJSON(updatedDoc.copyright_info);

        delete updatedDoc.file_url;
        delete updatedDoc.thumbnail_url;

        return successResponse(res, updatedDoc, "Document fetched successfully ✅");
    } catch (err) {
        return errorResponse(res, "Error fetching document ❌", 500, err.message);
    }
});


// =============================================================
// 8. PUT /api/documents/:id
//    Update document metadata and/or replace files
// =============================================================
router.put("/documents/:id", auth, documentUpload.fields([
    { name: "file", maxCount: 1 },
    { name: "thumbnail", maxCount: 1 },
]),
    async (req, res) => {
        try {
            const db = getMySQLConnection();
            const docId = req.params.id;
            console.log(req.body)

            const [existing] = await db.execute(
                `SELECT file_url, thumbnail_url FROM documents WHERE id = ?`,
                [docId]
            );
            if (!existing.length) {
                return errorResponse(res, "Document not found ❌", 404);
            }

            const { document_title, category, publisher, year, description, language, access_type } = req.body;

            let updateFields = `
                document_title = ?,
                category       = ?,
                publisher      = ?,
                year           = ?,
                description    = ?,
                language       = ?,
                access_type       = ?

            `;
            let params = [document_title, category, publisher, year, description, language, access_type];

            // Replace main file if provided
            if (req.files?.file?.[0]) {
                if (existing[0].file_url) await deleteFileFromS3(existing[0].file_url);
                const newFileUrl = req.files.file[0].location;

                // Re-extract TOC if new file is a PDF
                let toc = [];
                if (newFileUrl.toLowerCase().endsWith(".pdf")) {
                    try {
                        toc = await extractTOCFromPDF(newFileUrl);
                    } catch (err) {
                        console.error("TOC extraction failed:", err.message || err);
                    }
                }
                updateFields += `, file_url = ?, toc = ?`;
                params.push(newFileUrl, JSON.stringify(toc));
            }

            // Replace thumbnail if provided
            if (req.files?.thumbnail?.[0]) {
                if (existing[0].thumbnail_url) await deleteFileFromS3(existing[0].thumbnail_url);
                updateFields += `, thumbnail_url = ?`;
                params.push(req.files.thumbnail[0].location);
            }

            params.push(docId);
            await db.execute(
                `UPDATE documents SET ${updateFields} WHERE id = ?`,
                params
            );

            return successResponse(res, { id: docId }, "Document updated successfully ✅");
        } catch (err) {
            console.log(err)
            return errorResponse(res, "Error updating document ❌", 500, err.message);
        }
    }
);


// =============================================================
// 9. PUT /api/documents/:id/active
//    Make a specific document active (others go inactive)
// =============================================================
router.put("/documents/:id/active", auth, async (req, res) => {
    try {
        const db = getMySQLConnection();
        const userId = req.user.id;
        const documentId = req.params.id;

        const [doc] = await db.execute(
            `SELECT id FROM documents WHERE id = ?`,
            [documentId]
        );
        if (!doc.length) {
            return errorResponse(res, "Document not found ❌", 404);
        }

        // Step 1 – deactivate all
        await db.execute(
            `UPDATE user_active_document SET active = FALSE WHERE user_id = ?`,
            [userId]
        );

        // Step 2 – upsert chosen document as active
        await db.execute(
            `INSERT INTO user_active_document (user_id, document_id, active)
             VALUES (?, ?, TRUE)
             ON DUPLICATE KEY UPDATE active = TRUE`,
            [userId, documentId]
        );

        return successResponse(
            res,
            { document_id: documentId, active: true },
            "Document set as active successfully ✅"
        );
    } catch (err) {
        return errorResponse(res, "Error setting active document ❌", 500, err.message);
    }
});


// =============================================================
// 10. DELETE /api/documents/:id
//     Delete a document and its S3 assets
// =============================================================
router.delete("/documents/:id", auth, async (req, res) => {
    try {
        const db = getMySQLConnection();
        const docId = req.params.id;

        const [rows] = await db.execute(
            `SELECT file_url, thumbnail_url FROM documents WHERE id = ?`,
            [docId]
        );
        if (!rows.length) {
            return errorResponse(res, "Document not found ❌", 404);
        }

        const { file_url, thumbnail_url } = rows[0];
        if (file_url) await deleteFileFromS3(file_url);
        if (thumbnail_url) await deleteFileFromS3(thumbnail_url);

        await db.execute(`DELETE FROM documents WHERE id = ?`, [docId]);

        return successResponse(res, null, "Document deleted successfully 🗑");
    } catch (err) {
        return errorResponse(res, "Error deleting document ❌", 500, err.message);
    }
});




// =============================================================
// CATEGORY 2. GET /api/documents/categories/:id
//    Get a single category by ID
// =============================================================
router.get("/documents/categories/:id", auth, async (req, res) => {
    try {
        const db = getMySQLConnection();
        const { id } = req.params;

        const [rows] = await db.execute(
            `SELECT * FROM document_categories WHERE id = ?`,
            [id]
        );

        if (!rows.length) {
            return errorResponse(res, "Category not found ❌", 404);
        }

        return successResponse(res, rows[0], "Category fetched successfully ✅");
    } catch (err) {
        return errorResponse(res, "Error fetching category ❌", 500, err.message);
    }
});


// =============================================================
// CATEGORY 3. POST /api/documents/categories
//    Create a new category
// =============================================================
router.post("/documents/categories", auth, async (req, res) => {
    try {
        const db = getMySQLConnection();
        const { name, description, type } = req.body;

        if (!name) {
            return errorResponse(res, "name is required ❌", 400);
        }

        const validTypes = ["year", "publisher", "category"];
        if (type && !validTypes.includes(type)) {
            return errorResponse(res, `type must be one of: ${validTypes.join(", ")} ❌`, 400);
        }

        const [result] = await db.execute(
            `INSERT INTO document_categories (name, description, type)
             VALUES (?, ?, ?)`,
            [name, description || null, type || "category"]
        );

        return successResponse(
            res,
            { id: result.insertId, name, description, type: type || "category" },
            "Category created successfully ✅",
            201
        );
    } catch (err) {
        console.log(err)
        if (err.code === "ER_DUP_ENTRY") {
            return errorResponse(res, "Category name already exists", 409);
        }
        return errorResponse(res, "Error creating category ❌", 500, err.message);
    }
});


// =============================================================
// CATEGORY 4. PUT /api/documents/categories/:id
//    Update a category
// =============================================================
router.put("/documents/categories/:id", auth, async (req, res) => {
    try {
        const db = getMySQLConnection();
        const { id } = req.params;
        const { name, description, type } = req.body;

        // Check exists
        const [existing] = await db.execute(
            `SELECT id FROM document_categories WHERE id = ?`,
            [id]
        );
        if (!existing.length) {
            return errorResponse(res, "Category not found ❌", 404);
        }

        const validTypes = ["year", "publisher", "category"];
        if (type && !validTypes.includes(type)) {
            return errorResponse(res, `type must be one of: ${validTypes.join(", ")} ❌`, 400);
        }

        await db.execute(
            `UPDATE document_categories
             SET name        = COALESCE(?, name),
                 description = COALESCE(?, description),
                 type        = COALESCE(?, type)
             WHERE id = ?`,
            [name || null, description || null, type || null, id]
        );

        return successResponse(res, { id }, "Category updated successfully ✅");
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
            return errorResponse(res, "Category name already exists ❌", 409);
        }
        return errorResponse(res, "Error updating category ❌", 500, err.message);
    }
});

// =============================================================
// CATEGORY 5. DELETE /api/documents/:id/publish
//   publish or unpublish a document (soft delete from public view)
// =============================================================
router.patch("/documents/:id/publish", auth, async (req, res) => {
try {
    const db = getMySQLConnection();
    const { id } = req.params;
    const { is_published } = req.body;

    const [existing] = await db.execute(
        `SELECT id FROM documents WHERE id = ?`,
        [id]
    );
    if (!existing.length) {
        return errorResponse(res, "Document not found ❌", 404);
    }

    await db.execute(
        `UPDATE documents SET is_published = ${is_published} WHERE id = ?`,
        [id]
    );

    return successResponse(res, { id }, "Document published successfully ✅");
} catch (err) { 

    return errorResponse(res, "Error publishing document ❌", 500, err.message);
}
})


// =============================================================
// CATEGORY 6. DELETE /api/documents/categories/:id
//    Delete a category
// =============================================================
router.delete("/documents/categories/:id", auth, async (req, res) => {
    try {
        const db = getMySQLConnection();
        const { id } = req.params;

        const [existing] = await db.execute(
            `SELECT id FROM document_categories WHERE id = ?`,
            [id]
        );
        if (!existing.length) {
            return errorResponse(res, "Category not found ❌", 404);
        }

        await db.execute(
            `DELETE FROM document_categories WHERE id = ?`,
            [id]
        );

        return successResponse(res, null, "Category deleted successfully 🗑");
    } catch (err) {
        return errorResponse(res, "Error deleting category ❌", 500, err.message);
    }
});

module.exports = router;