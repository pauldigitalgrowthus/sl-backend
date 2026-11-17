const express = require('express');
const { getMySQLConnection } = require('../config/mysql');
const { successResponse, errorResponse } = require('../utils/response');
const router = express.Router();


router.get('/', async (req, res) => {
    try {
        const mysqlConnection = getMySQLConnection();
        const [publications] = await mysqlConnection.execute(
            `SELECT 
                mp.*,
                u.first_name,
                u.last_name,
                u.email,
                u.phone,
                u.role,
                u.bio,
                u.avatar,
                u.website_url,
                u.twitter_url
            FROM music_publications mp
            LEFT JOIN users u ON mp.composer_id = u.id
            WHERE mp.music_files IS NOT NULL`
        );

        // Transform data to include composer object
        const transformedPublications = publications.map(pub => {
            const { first_name, last_name, email, phone, role, bio, avatar, website_url, twitter_url, ...musicPublication } = pub;
            
            return {
                ...musicPublication,
                composer: first_name ? {
                    id: pub.composer_id,
                    full_name: `${first_name} ${last_name}`.trim(),
                    email,
                    phone,
                    role,
                    bio,
                    avatar,
                    website_url,
                    twitter_url
                } : null
            };
        });

        return successResponse(res, {
            publications: transformedPublications,
            total: transformedPublications.length
        }, 'Music publications retrieved successfully');
    } catch (error) {
        console.error('Get music error:', error);
        errorResponse(res, 'Failed to get music', 500);
    }
})

router.get('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const mysqlConnection = getMySQLConnection();
        const [publications] = await mysqlConnection.execute(
            `SELECT 
                mp.*,
                u.first_name,
                u.last_name,
                u.email,
                u.phone,
                u.role,
                u.bio,
                u.avatar,
                u.website_url,
                u.twitter_url
            FROM music_publications mp
            LEFT JOIN users u ON mp.composer_id = u.id
            WHERE mp.id = ? AND mp.music_files IS NOT NULL`,
            [id])
        
        if (publications.length === 0) {
            return successResponse(res, {
                publication: null
            }, 'Music publication not found');
        }

        const pub = publications[0];
        const { first_name, last_name, email, phone, role, bio, avatar, website_url, twitter_url, ...musicPublication } = pub;
        
        const musicFiles = pub?.music_files ? JSON.parse(pub.music_files) : [];
        
        const transformedPublication = {
            ...musicPublication,
            music_files: musicFiles,
            composer: first_name ? {
                id: pub.composer_id,
                full_name: `${first_name} ${last_name}`.trim(),
                email,
                phone,
                role,
                bio,
                avatar,
                website_url,
                twitter_url
            } : null
        };

        return successResponse(res, {
            publication: transformedPublication
        }, 'Music publication retrieved successfully');
    } catch (error) {
        console.error('Get music by ID error:', error);
        errorResponse(res, 'Failed to get music by ID', 500);
    }
})


router.delete('/:id/:index', async (req, res) => {
    try {
        const { id, index } = req.params;
        const mysqlConnection = getMySQLConnection();
        const [publications] = await mysqlConnection.execute(
            `SELECT 
                mp.*,
                u.first_name,
                u.last_name,
                u.email,
                u.phone,
                u.role,
                u.bio,
                u.avatar,
                u.website_url,
                u.twitter_url
            FROM music_publications mp
            LEFT JOIN users u ON mp.composer_id = u.id
            WHERE mp.id = ? AND mp.music_files IS NOT NULL`,
            [id])
        if (publications.length === 0) {
            return errorResponse(res, 'Music publication not found', 404);
        }
        
        const pub = publications[0];
        const { first_name, last_name, email, phone, role, bio, avatar, website_url, twitter_url, ...musicPublication } = pub;
        
        const musicFiles = pub?.music_files ? JSON.parse(pub.music_files) : [];
        if (index < 0 || index >= musicFiles.length) {
            return errorResponse(res, 'Invalid music file index', 400);
        }
        musicFiles.splice(index, 1);
        await mysqlConnection.execute(
            `UPDATE music_publications SET music_files = ? WHERE id = ?`,
            [JSON.stringify(musicFiles), id]
        );
        
        const transformedPublication = {
            ...musicPublication,
            music_files: musicFiles,
            composer: first_name ? {
                id: pub.composer_id,
                full_name: `${first_name} ${last_name}`.trim(),
                email,
                phone,
                role,
                bio,
                avatar,
                website_url,
                twitter_url
            } : null
        };
        
        return successResponse(res, {
            publication: transformedPublication
        }, 'Music file deleted successfully');
    } catch (error) {
        console.error('Delete music file error:', error);
        errorResponse(res, 'Failed to delete music file', 500);
    }

})

module.exports = router;