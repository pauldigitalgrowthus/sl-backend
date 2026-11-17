const express = require('express');
const { getMySQLConnection } = require('../config/mysql');
const { auth } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');

const router = express.Router();

// @route   POST /api/music-folders
// @desc    Create a new music folder for the authenticated user
// @access  Private
router.post('/', auth, async (req, res) => {
    try {
        const { folder_name, description, songs } = req.body;
        const userId = req.user.id;
        const mysqlConnection = getMySQLConnection();

        if (!folder_name) {
            return errorResponse(res, 'Folder name is required', 400);
        }

        const [result] = await mysqlConnection.execute(
            'INSERT INTO user_music_folders (folder_name, description, user_id, songs) VALUES (?, ?, ?, ?)',
            [folder_name, description || null, userId, JSON.stringify(songs || [])]
        );

        const folderId = result.insertId;

        const [folders] = await mysqlConnection.execute(
            'SELECT * FROM user_music_folders WHERE id = ?',
            [folderId]
        );

        const folder = folders[0];
        folder.songs = folder.songs ? JSON.parse(folder.songs) : [];

        successResponse(res, { folder }, 'Folder created successfully');
    } catch (error) {
        console.error('Create folder error:', error);
        errorResponse(res, 'Failed to create folder', 500);
    }
});

// @route   GET /api/music-folders
// @desc    Get all music folders of the authenticated user
// @access  Private
router.get('/', auth, async (req, res) => {
    try {
        const userId = req.user.id;
        const mysqlConnection = getMySQLConnection();

        const [folders] = await mysqlConnection.execute(
            'SELECT * FROM user_music_folders WHERE user_id = ? ORDER BY created_at DESC',
            [userId]
        );

        const parsedFolders = folders.map(folder => {
            folder.songs = folder.songs ? JSON.parse(folder.songs) : [];
            return folder;
        });

        successResponse(res, { folders: parsedFolders }, 'Folders fetched successfully');
    } catch (error) {
        console.error('Get folders error:', error);
        errorResponse(res, 'Failed to get folders', 500);
    }
});

// @route   GET /api/music-folders/:id
// @desc    Get details of a specific music folder
// @access  Private
router.get('/:id', auth, async (req, res) => {
    try {
        const folderId = req.params.id;
        const userId = req.user.id;
        const mysqlConnection = getMySQLConnection();

        const [folders] = await mysqlConnection.execute(
            'SELECT * FROM user_music_folders WHERE id = ? AND user_id = ?',
            [folderId, userId]
        );

        if (folders.length === 0) {
            return errorResponse(res, 'Folder not found or access denied', 404);
        }

        const folder = folders[0];
        folder.songs = folder.songs ? JSON.parse(folder.songs) : [];

        successResponse(res, { folder }, 'Folder fetched successfully');
    } catch (error) {
        console.error('Get folder by id error:', error);
        errorResponse(res, 'Failed to get folder', 500);
    }
});

// @route   PUT /api/music-folders/:id
// @desc    Update folder details (name, description, songs list)
// @access  Private
router.put('/:id', auth, async (req, res) => {
    try {
        const folderId = req.params.id;
        const userId = req.user.id;
        const mysqlConnection = getMySQLConnection();

        const [folders] = await mysqlConnection.execute(
            'SELECT * FROM user_music_folders WHERE id = ? AND user_id = ?',
            [folderId, userId]
        );

        if (folders.length === 0) {
            return errorResponse(res, 'Folder not found or access denied', 404);
        }

        const existing = folders[0];
        const { folder_name, description, songs } = req.body;

        const updatedFolderName = folder_name !== undefined ? folder_name : existing.folder_name;
        if (!updatedFolderName || String(updatedFolderName).trim() === '') {
            return errorResponse(res, 'Folder name cannot be empty', 400);
        }

        const updatedDescription = description !== undefined ? description : existing.description;
        const updatedSongs = songs !== undefined ? (songs ? JSON.stringify(songs) : null) : existing.songs;

        await mysqlConnection.execute(
            `UPDATE user_music_folders SET
                folder_name = ?,
                description = ?,
                songs = ?,
                updated_at = UTC_TIMESTAMP()
             WHERE id = ? AND user_id = ?`,
            [updatedFolderName, updatedDescription, updatedSongs, folderId, userId]
        );

        const [updatedFolders] = await mysqlConnection.execute(
            'SELECT * FROM user_music_folders WHERE id = ?',
            [folderId]
        );

        const folder = updatedFolders[0];
        folder.songs = folder.songs ? JSON.parse(folder.songs) : [];

        successResponse(res, { folder }, 'Folder updated successfully');
    } catch (error) {
        console.error('Update folder error:', error);
        errorResponse(res, 'Failed to update folder', 500);
    }
});

// @route   DELETE /api/music-folders/:id
// @desc    Delete a music folder
// @access  Private
router.delete('/:id', auth, async (req, res) => {
    try {
        const folderId = req.params.id;
        const userId = req.user.id;
        const mysqlConnection = getMySQLConnection();

        const [folders] = await mysqlConnection.execute(
            'SELECT * FROM user_music_folders WHERE id = ? AND user_id = ?',
            [folderId, userId]
        );

        if (folders.length === 0) {
            return errorResponse(res, 'Folder not found or access denied', 404);
        }

        await mysqlConnection.execute(
            'DELETE FROM user_music_folders WHERE id = ? AND user_id = ?',
            [folderId, userId]
        );

        successResponse(res, null, 'Folder deleted successfully');
    } catch (error) {
        console.error('Delete folder error:', error);
        errorResponse(res, 'Failed to delete folder', 500);
    }
});

// @route   POST /api/music-folders/:id/add-songs
// @desc    Add song objects to folder songs array (push/append)
// @access  Private
router.post('/:id/add-songs', auth, async (req, res) => {
    try {
        const folderId = req.params.id;
        const userId = req.user.id;
        const mysqlConnection = getMySQLConnection();

        const [folders] = await mysqlConnection.execute(
            'SELECT * FROM user_music_folders WHERE id = ? AND user_id = ?',
            [folderId, userId]
        );

        if (folders.length === 0) {
            return errorResponse(res, 'Folder not found or access denied', 404);
        }

        const folder = folders[0];
        let songs = [];
        if (folder.songs) {
            try {
                songs =
                    typeof folder.songs === 'string' ? JSON.parse(folder.songs) : folder.songs;
            } catch (err) {
                songs = [];
            }
        }

        if (!Array.isArray(songs)) {
            songs = [];
        }

        // Fix old nested arrays
        songs = songs.flat(Infinity);
        let newSongs = [];
        // Multiple songs
        if (Array.isArray(req.body.songs)) {
            newSongs = req.body.songs;
        }

        // Single song
        else if (req.body.song !== undefined) {
            newSongs = Array.isArray(req.body.song) ? req.body.song : [req.body.song];
        }

        // Single ID
        else if (req.body.song_id !== undefined) {
            newSongs = [
                {
                    id: req.body.song_id
                }
            ];
        }

        // Multiple IDs
        else if (
            req.body.songIds &&
            Array.isArray(req.body.songIds)
        ) {
            newSongs = req.body.songIds.map(id => ({
                id
            }));
        }

        if (newSongs.length === 0) {
            return errorResponse(res, 'No songs/song IDs provided to add', 400);
        }

        const existingIds = new Set(songs.map(song => String(song?.id || song?.song_id)).filter(Boolean));

        let addedCount = 0;
        const addedSongs = [];

        for (const song of newSongs) {
            const songObj =
                typeof song === 'object' && song !== null
                    ? { ...song }
                    : { id: song };

            const songId = String(
                songObj.id || songObj.song_id
            );

            if (!songId) {
                continue;
            }

            // Prevent duplicates
            if (existingIds.has(songId)) {
                continue;
            }

            // Add folder name
            songObj.folder_name = folder.folder_name;

            // Add source
            songObj.source =
                songObj.source ||
                req.body.source ||
                'music';

            songs.push(songObj);

            existingIds.add(songId);

            addedSongs.push(songObj);
            addedCount++;
        }

        await mysqlConnection.execute(
            `
            UPDATE user_music_folders
            SET songs = ?
            WHERE id = ?
            AND user_id = ?
            `,
            [
                JSON.stringify(songs),
                folderId,
                userId
            ]
        );

        const [updatedFolders] =
            await mysqlConnection.execute(
                `
                SELECT *
                FROM user_music_folders
                WHERE id = ?
                `,
                [folderId]
            );

        const updatedFolder = updatedFolders[0];

        updatedFolder.songs = updatedFolder.songs
            ? JSON.parse(updatedFolder.songs)
            : [];

        return successResponse(
            res,
            {
                folder: updatedFolder,
                addedCount,
                addedSongs
            },
            addedCount > 0
                ? 'Songs added successfully'
                : 'All songs already exist in folder'
        );

    } catch (error) {
        console.error('Add songs to folder error:', error);
        return errorResponse(res, 'Failed to add songs to folder', 500);
    }
});



// @route   DELETE /api/music-folders/:id/remove-songs
// @desc    Remove songs from folder
// @access  Private
router.delete('/:id/remove-songs', auth, async (req, res) => {
    try {
        const folderId = req.params.id;
        const userId = req.user.id;
        const mysqlConnection = getMySQLConnection();

        const [folders] = await mysqlConnection.execute(
            'SELECT * FROM user_music_folders WHERE id = ? AND user_id = ?',
            [folderId, userId]
        );

        if (folders.length === 0) {
            return errorResponse(
                res,
                'Folder not found or access denied',
                404
            );
        }

        const folder = folders[0];

        let songs = [];

        if (folder.songs) {
            try {
                songs =
                    typeof folder.songs === 'string'
                        ? JSON.parse(folder.songs)
                        : folder.songs;
            } catch (err) {
                songs = [];
            }
        }

        if (!Array.isArray(songs)) {
            songs = [];
        }

        // Handle nested arrays
        songs = songs.flat(Infinity);

        let idsToRemove = [];

        if (Array.isArray(req.body.songIds)) {
            idsToRemove = req.body.songIds.map(id => String(id));
        }
        else if (req.body.song_id !== undefined) {
            idsToRemove = [String(req.body.song_id)];
        }
        else if (Array.isArray(req.body.songs)) {
            idsToRemove = req.body.songs
                .map(song => {
                    if (typeof song === 'object' && song !== null) {
                        return String(song.id || song.song_id);
                    }
                    return String(song);
                })
                .filter(Boolean);
        }
        else if (req.body.song !== undefined) {
            if (
                typeof req.body.song === 'object' &&
                req.body.song !== null
            ) {
                idsToRemove = [
                    String(
                        req.body.song.id ||
                        req.body.song.song_id
                    )
                ];
            } else {
                idsToRemove = [String(req.body.song)];
            }
        }

        if (idsToRemove.length === 0) {
            return errorResponse(
                res,
                'No song IDs provided to remove',
                400
            );
        }

        const originalCount = songs.length;

        const updatedSongs = songs.filter(song => {
            const songId =
                typeof song === 'object' && song !== null
                    ? String(song.id || song.song_id)
                    : String(song);

            return !idsToRemove.includes(songId);
        });

        const removedCount = originalCount - updatedSongs.length;

        await mysqlConnection.execute(
            'UPDATE user_music_folders SET songs = ? WHERE id = ? AND user_id = ?',
            [
                JSON.stringify(updatedSongs),
                folderId,
                userId
            ]
        );

        const [updatedFolders] = await mysqlConnection.execute(
            'SELECT * FROM user_music_folders WHERE id = ?',
            [folderId]
        );

        const updatedFolder = updatedFolders[0];

        updatedFolder.songs = updatedFolder.songs
            ? JSON.parse(updatedFolder.songs)
            : [];

        return successResponse(
            res,
            {
                folder: updatedFolder,
                removedSongIds: idsToRemove,
                removedCount
            },
            'Songs removed from folder successfully'
        );

    } catch (error) {
        console.error('Remove songs from folder error:', error);

        return errorResponse(
            res,
            'Failed to remove songs from folder',
            500
        );
    }
});

module.exports = router;