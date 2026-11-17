const express = require('express');
const { auth, requireSLTeamWithTypes } = require('../../middleware/auth');
const agreementRouter = require('./agreement-management')
const savedAggreementsRouter = require('./saved-agreements');
const userSignatureRouter = require('./users-signature');
const paymentMethodsRouter = require('./payment-methods');
const { successResponse, errorResponse } = require('../../utils/response');
const { agreementUpload } = require('../../config/s3');
const router = express.Router();


// @route   POST /api/agreements/upload-file
// @desc    Upload a new agreement file on S3
// @access  Private (User)
router.post('/upload-file', [
    auth,
    agreementUpload.single('agreementFile')
], async (req, res) => {
    try {
        if (!req.file) {
            return errorResponse(res, 'No agreement file uploaded', 400);
        }

        const fileUrl = req.file.location;
        const fileSize = req.file.size;

        successResponse(res, {
            fileUrl,
            fileSize,
            fileName: req.file.originalname,
            fileType: req.file.mimetype
        }, 'Agreement file uploaded successfully');

    } catch (error) {
        console.error('Agreement upload error:', error);
        errorResponse(res, 'Failed to upload agreement file', 500);
    }
});

// /api/agreements/saved-agreements
router.use('/saved-agreements', savedAggreementsRouter);

// /api/agreements/user/signature
router.use('/user', userSignatureRouter);

// /api/agreements/payment-methods
router.use('/payment-methods', paymentMethodsRouter);

// /api/agreements
router.use('/', agreementRouter);

module.exports = router;