const { S3Client } = require('@aws-sdk/client-s3');
const multer = require('multer');
const multerS3 = require('multer-s3');
const path = require("path");

// AWS S3 Configuration
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'ap-south-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
  }
});

// S3 Bucket Configuration
const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'sl-music-publications';
const BUCKET_REGION = process.env.AWS_REGION || 'ap-south-1';

// Helper function to create safe user folder structure
const makeSafeUserFolder = (user) => {
  const name = `${user.first_name}-${user.last_name}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');

  const email = user.email
    .toLowerCase()
    .replace(/[@.]/g, '_')
    .replace(/[^a-z0-9_]/g, '');

  return `${user.id}_${name}_${email}`;
};

// Helper function to generate file name with proper folder structure
const generateFileName = (req, folder, originalname) => {
  const user = req.user;
  const userFolder = makeSafeUserFolder(user);

  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);
  const ext = originalname.split('.').pop();

  return `sl-music-backend/users/${userFolder}/${folder}/${timestamp}-${random}.${ext}`;
};

// File type validation
const fileFilter = (req, file, cb) => {
  // Allow only specific file types
  const allowedTypes = {
    'audio/mpeg': true,
    'audio/wav': true,
    'audio/mp3': true,
    'audio/mp4': true,
    'application/pdf': true,
    'image/jpeg': true,
    'image/png': true,
    'image/gif': true,
    'text/plain': true,
    'application/msword': true,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': true
  };

  if (allowedTypes[file.mimetype]) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only audio, PDF, images, and text files are allowed.'), false);
  }
};

// Multer S3 configuration for file uploads
const upload = multer({
  fileFilter: fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
    files: 5 // Maximum 5 files per request
  },
  storage: multerS3({
    s3: s3Client,
    bucket: BUCKET_NAME,
    metadata: function (req, file, cb) {
      cb(null, {
        fieldName: file.fieldname,
        uploadedBy: req.user ? req.user.id : 'anonymous',
        uploadedAt: new Date().toISOString()
      });
    },
    key: function (req, file, cb) {
      if (req.user) {
        const fileName = generateFileName(req, 'general', file.originalname);
        cb(null, fileName);
      } else {
        const timestamp = Date.now();
        const fileExtension = file.originalname.split('.').pop();
        const fileName = `sl-music-backend/anonymous/${timestamp}-${Math.random().toString(36).substring(7)}.${fileExtension}`;
        cb(null, fileName);
      }
    }
  })
});

// Music Upload Configuration
const musicUpload = multer({
  fileFilter: (req, file, cb) => {
    const allowedMusicTypes = {
      'audio/mpeg': true,
      'audio/wav': true,
      'audio/mp3': true,
      'audio/mp4': true,
      'audio/ogg': true,
      'audio/aac': true,
      'application/pdf': true,
      'text/plain': true,
      'application/msword': true,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': true,
      'image/jpeg': true,
      'image/png': true,
      'image/webp': true,
      'image/jpg': true,
      'image/svg+xml': true
    };

    if (allowedMusicTypes[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new Error('Invalid music file type. Only audio files, PDFs, and text documents are allowed.'), false);
    }
  },
  limits: {
    // fileSize: 50 * 1024 * 1024, // 50MB limit per file
    files: 10 // Maximum 10 files per request
  },
  storage: multerS3({
    s3: s3Client,
    bucket: BUCKET_NAME,
    key: function (req, file, cb) {
      if (req.user) {
        const fileName = generateFileName(req, 'music', file.originalname);
        cb(null, fileName);
      } else {
        const timestamp = Date.now();
        const fileExtension = file.originalname.split('.').pop();
        const fileName = `sl-music-backend/anonymous/music/${timestamp}-${Math.random().toString(36).substring(7)}.${fileExtension}`;
        cb(null, fileName);
      }
    }
  })
});


const artworkUpload = multer({
  fileFilter: (req, file, cb) => {
    const allowedArtworkTypes = {
      'image/jpeg': true,
      'image/png': true,
      'image/gif': true
    };

    if (allowedArtworkTypes[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new Error('Invalid artwork file type. Only JPEG, PNG, and GIF images are allowed.'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  storage: multerS3({
    s3: s3Client,
    bucket: BUCKET_NAME,
    key: function (req, file, cb) {
      if (req.user) {
        const fileName = generateFileName(req, 'artwork', file.originalname);
        cb(null, fileName);
      } else {
        const timestamp = Date.now();
        const fileExtension = file.originalname.split('.').pop();
        const fileName = `sl-music-backend/anonymous/artwork/${timestamp}-${Math.random().toString(36).substring(7)}.${fileExtension}`;
        cb(null, fileName);
      }
    }
  })
});

const agreementUpload = multer({
  fileFilter: (req, file, cb) => {
    const allowedAgreementTypes = {
      'application/pdf': true,
      'image/jpeg': true,
      'image/png': true,
      'image/gif': true
    };

    if (allowedAgreementTypes[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new Error('Invalid agreement file type. Only JPEG, PNG, and PDF images are allowed.'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  storage: multerS3({
    s3: s3Client,
    bucket: BUCKET_NAME,
    key: function (req, file, cb) {
      if (req.user) {
        const fileName = generateFileName(req, 'agreements', file.originalname);
        cb(null, fileName);
      } else {
        const timestamp = Date.now();
        const fileExtension = file.originalname.split('.').pop();
        const fileName = `sl-music-backend/anonymous/agreements/${timestamp}-${Math.random().toString(36).substring(7)}.${fileExtension}`;
        cb(null, fileName);
      }
    }
  })
});

const EducatorApplicationsFilesUpload = multer({
  fileFilter: (req, file, cb) => {

    const allowedMimeTypes = {

      "image/jpeg": true,
      "image/jpg": true,
      "image/png": true,
      "image/gif": true,
      "image/webp": true,
      "application/pdf": true,
      "application/msword": true,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": true,
      "application/vnd.ms-excel": true,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": true,
      "application/vnd.ms-powerpoint": true,
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": true,
      "text/plain": true,
      "audio/mpeg": true,
      "audio/mp3": true,
      "audio/wav": true,
      "video/mp4": true,
      "video/mpeg": true,
      "video/quicktime": true,
      "video/x-msvideo": true,
      "video/webm": true,
      "video/x-matroska": true
    };

    if (allowedMimeTypes[file.mimetype]) {
      cb(null, true);
    } else {

      return cb(
        new Error(
          `Unsupported file type: ${file.mimetype}. Allowed files are images, videos, audio, PDFs, Word, Excel, PPT, and text files.`
        ),
        false
      );
    }
  },

  /* =========================================================
     STORAGE
  ========================================================= */
  storage: multerS3({
    s3: s3Client,
    bucket: BUCKET_NAME,

    contentType: multerS3.AUTO_CONTENT_TYPE,

    metadata: function (req, file, cb) {
      cb(null, {
        fieldName: file.fieldname,
        uploadedBy: req.user?.id?.toString() || "anonymous"
      });
    },

    key: function (req, file, cb) {

      try {

        const timestamp = Date.now();

        const extension =
          path.extname(file.originalname) || "";

        const cleanFileName = file.originalname
          .replace(/\s+/g, "-")
          .replace(/[^a-zA-Z0-9.-]/g, "");

        let filePath = "";

        if (req.user) {

          filePath = `sl-music-backend/educator-applications/${req.user.id}/${timestamp}-${cleanFileName}`;

        } else {

          filePath = `sl-music-backend/educator-applications/anonymous/${timestamp}-${cleanFileName}`;
        }

        cb(null, filePath);

      } catch (error) {

        cb(error);
      }
    }
  })
});

/* =========================================================
   COURSE RESOURCES FILE UPLOAD
========================================================= */
const CourseResourcesUpload = multer({

  /* =========================================================
     FILE FILTER
  ========================================================= */
  fileFilter: (req, file, cb) => {

    const allowedMimeTypes = {

      /* Images */
      "image/jpeg": true,
      "image/jpg": true,
      "image/png": true,
      "image/gif": true,
      "image/webp": true,

      /* PDF */
      "application/pdf": true,

      /* Word */
      "application/msword": true,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": true,

      /* Excel */
      "application/vnd.ms-excel": true,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": true,

      /* PowerPoint */
      "application/vnd.ms-powerpoint": true,
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": true,

      /* Text */
      "text/plain": true,

      /* Audio */
      "audio/mpeg": true,
      "audio/mp3": true,
      "audio/wav": true,

      /* Video */
      "video/mp4": true,
      "video/mpeg": true,
      "video/quicktime": true,
      "video/x-msvideo": true,
      "video/webm": true,
      "video/x-matroska": true
    };

    if (allowedMimeTypes[file.mimetype]) {

      cb(null, true);

    } else {

      return cb(
        new Error(
          `Unsupported file type: ${file.mimetype}. Allowed files are images, videos, audio, PDFs, Word, Excel, PPT, and text files.`
        ),
        false
      );
    }
  },

  /* =========================================================
     STORAGE
  ========================================================= */
  storage: multerS3({

    s3: s3Client,

    bucket: BUCKET_NAME,

    contentType: multerS3.AUTO_CONTENT_TYPE,

    /* =========================================================
       FILE METADATA
    ========================================================= */
    metadata: function (req, file, cb) {

      cb(null, {
        fieldName: file.fieldname,
        uploadedBy: req.user?.id?.toString() || "anonymous",
        courseId: req.params?.courseId?.toString() || "unknown"
      });
    },

    /* =========================================================
       FILE PATH / KEY
    ========================================================= */
    key: function (req, file, cb) {

      try {

        const timestamp = Date.now();

        const extension =
          path.extname(file.originalname) || "";

        const cleanFileName = file.originalname
          .replace(/\s+/g, "-")
          .replace(/[^a-zA-Z0-9.-]/g, "");

        let filePath = "";

        if (req.user) {

          filePath =
            `sl-music-backend/course-resources/${req.params.courseId}/${req.user.id}/${timestamp}-${cleanFileName}`;

        } else {

          filePath =
            `sl-music-backend/course-resources/anonymous/${timestamp}-${cleanFileName}`;
        }

        cb(null, filePath);

      } catch (error) {

        cb(error);
      }
    }
  }),

  /* =========================================================
     LIMITS
  ========================================================= */
  limits: {
    fileSize: 1024 * 1024 * 500 // 500MB
  }
});

const avatarUpload = multer({
  fileFilter: (req, file, cb) => {
    const allowedAvatarTypes = {
      'image/jpeg': true,
      'image/png': true,
      'image/gif': true
    };

    if (allowedAvatarTypes[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new Error('Invalid avatar file type. Only JPEG, PNG, and GIF images are allowed.'), false);
    }
  },
  limits: {
    fileSize: 2 * 1024 * 1024 // 2MB limit for avatars
  },
  storage: multerS3({
    s3: s3Client,
    bucket: BUCKET_NAME,
    key: function (req, file, cb) {
      if (req.user) {
        const fileName = generateFileName(req, 'avatars', file.originalname);
        cb(null, fileName);
      } else {
        const timestamp = Date.now();
        const fileExtension = file.originalname.split('.').pop();
        const fileName = `sl-music-backend/anonymous/avatars/${timestamp}-${Math.random().toString(36).substring(7)}.${fileExtension}`;
        cb(null, fileName);
      }
    }
  })
});

const libraryImageUpload = multer({
  fileFilter: (req, file, cb) => {
    const allowedImageTypes = {
      'image/jpeg': true,
      'image/png': true,
      'image/gif': true,
      'image/webp': true
    };

    if (allowedImageTypes[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new Error('Invalid library image file type. Only JPEG, PNG, GIF, and WebP images are allowed.'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit for library images
  },
  storage: multerS3({
    s3: s3Client,
    bucket: BUCKET_NAME,
    key: function (req, file, cb) {
      if (req.user) {
        const fileName = generateFileName(req, 'library-images', file.originalname);
        cb(null, fileName);
      } else {
        const timestamp = Date.now();
        const fileExtension = file.originalname.split('.').pop();
        const fileName = `sl-music-backend/anonymous/library-images/${timestamp}-${Math.random().toString(36).substring(7)}.${fileExtension}`;
        cb(null, fileName);
      }
    }
  })
});

const collectionImageUpload = multer({
  fileFilter: (req, file, cb) => {
    const allowedImageTypes = {
      'image/jpeg': true,
      'image/png': true,
      'image/gif': true,
      'image/webp': true
    };

    if (allowedImageTypes[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new Error('Invalid collection image file type. Only JPEG, PNG, GIF, and WebP images are allowed.'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit for collection images
  },
  storage: multerS3({
    s3: s3Client,
    bucket: BUCKET_NAME,
    key: function (req, file, cb) {
      if (req.user) {
        const fileName = generateFileName(req, 'collection-images', file.originalname);
        cb(null, fileName);
      } else {
        const timestamp = Date.now();
        const fileExtension = file.originalname.split('.').pop();
        const fileName = `sl-music-backend/anonymous/collection-images/${timestamp}-${Math.random().toString(36).substring(7)}.${fileExtension}`;
        cb(null, fileName);
      }
    }
  })
});

// Review Board Document Upload Configuration
const reviewBoardDocumentUpload = multer({
  fileFilter: function (req, file, cb) {
    const allowedTypes = {
      'application/pdf': true,
      'application/msword': true,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': true,
      'text/plain': true,
      'image/jpeg': true,
      'image/png': true,
      'image/gif': true
    };

    if (allowedTypes[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new Error('Invalid document type. Only PDF, Word docs, text files, and images are allowed.'), false);
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 7
  },
  storage: multerS3({
    s3: s3Client,
    bucket: BUCKET_NAME,
    key: function (req, file, cb) {
      if (req.user) {
        const fileName = generateFileName(req, 'review-board-documents', file.originalname);
        cb(null, fileName);
      } else {
        const timestamp = Date.now();
        const fileExtension = file.originalname.split('.').pop();
        const fileName = `sl-music-backend/anonymous/review-board-documents/${timestamp}-${Math.random().toString(36).substring(7)}.${fileExtension}`;
        cb(null, fileName);
      }
    }
  })
});

// Composer Application Upload Configuration
const composerApplicationUpload = multer({
  fileFilter: function (req, file, cb) {
    const allowedTypes = {
      'application/pdf': true,
      'audio/mpeg': true,
      'audio/wav': true,
      'audio/mp3': true,
      'audio/mp4': true,
      'audio/ogg': true,
      'audio/aac': true,
      'text/plain': true,
      'application/msword': true,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': true
    };

    if (allowedTypes[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new Error('Invalid composition file type. Only PDFs, audio files, and text documents are allowed.'), false);
    }
  },
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 10
  },
  storage: multerS3({
    s3: s3Client,
    bucket: BUCKET_NAME,
    key: function (req, file, cb) {
      if (req.user) {
        const compositionNumber = req.params.compositionNumber || 'unknown';
        const fileName = generateFileName(req, `composer-applications/composition-${compositionNumber}`, file.originalname);
        cb(null, fileName);
      } else {
        const timestamp = Date.now();
        const fileExtension = file.originalname.split('.').pop();
        const fileName = `sl-music-backend/anonymous/composer-applications/${timestamp}-${Math.random().toString(36).substring(7)}.${fileExtension}`;
        cb(null, fileName);
      }
    }
  })
});

// Review Board Photo Upload Configuration
const reviewBoardPhotoUpload = multer({
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed for review board photos'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1
  },
  storage: multerS3({
    s3: s3Client,
    bucket: BUCKET_NAME,
    key: (req, file, cb) => {
      if (req.user) {
        const fileName = generateFileName(req, 'review-board-photos', file.originalname);
        cb(null, fileName);
      } else {
        const timestamp = Date.now();
        const fileExtension = file.originalname.split('.').pop();
        const fileName = `sl-music-backend/anonymous/review-board-photos/${timestamp}-${Math.random().toString(36).substring(7)}.${fileExtension}`;
        cb(null, fileName);
      }
    }
  })
});

// Upload Any File Configuration
const uploadAnyFile = multer({
  fileFilter: (req, file, cb) => {
    cb(null, true);
  },
  limits: {
    fileSize: 20 * 1024 * 1024
  },
  storage: multerS3({
    s3: s3Client,
    bucket: BUCKET_NAME,
    key: function (req, file, cb) {
      if (req.user) {
        const fileName = generateFileName(req, 'random-files', file.originalname);
        cb(null, fileName);
      } else {
        const timestamp = Date.now();
        const fileExtension = file.originalname.split('.').pop();
        const fileName = `sl-music-backend/anonymous/random-files/${timestamp}-${Math.random().toString(36).substring(7)}.${fileExtension}`;
        cb(null, fileName);
      }
    }
  })
});

// Community Music Library Upload Configuration
const communityMusicLibraryUpload = multer({
  fileFilter: (req, file, cb) => {
    const allowedTypes = {
      'application/pdf': true,
      'audio/mpeg': true,
      'audio/mp3': true,
      'audio/wav': true,
      'audio/mp4': true,
      'audio/ogg': true,
      'audio/aac': true,
      'image/jpeg': true,
      'image/png': true,
      'image/gif': true,
      'image/webp': true,
      'image/jpg': true
    };

    if (allowedTypes[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}. Only PDF, MP3, and image files are allowed.`), false);
    }
  },
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 30
  },
  storage: multerS3({
    s3: s3Client,
    bucket: BUCKET_NAME,
    metadata: function (req, file, cb) {
      cb(null, {
        fieldName: String(file.fieldname || ""),
        uploadedBy: String(req.user?.id || "anonymous"),
        uploadedAt: String(new Date().toISOString()),
        communityMusicLibrary: "true"
      });
    },
    key: function (req, file, cb) {
      if (req.user) {
        let subfolder = 'general';
        if (file.mimetype === 'application/pdf') {
          subfolder = 'pdfs';
        } else if (file.mimetype.startsWith('audio/')) {
          subfolder = 'audio';
        } else if (file.mimetype.startsWith('image/')) {
          subfolder = 'images';
        }

        const fileName = generateFileName(req, `community-music-library/${subfolder}`, file.originalname);
        cb(null, fileName);
      } else {
        const timestamp = Date.now();
        const fileExtension = file.originalname.split('.').pop();
        const randomString = Math.random().toString(36).substring(7);

        let folder = 'community-music-library';
        if (file.mimetype === 'application/pdf') {
          folder = 'community-music-library/pdfs';
        } else if (file.mimetype.startsWith('audio/')) {
          folder = 'community-music-library/audio';
        } else if (file.mimetype.startsWith('image/')) {
          folder = 'community-music-library/images';
        }

        const fileName = `sl-music-backend/anonymous/${folder}/${timestamp}-${randomString}.${fileExtension}`;
        cb(null, fileName);
      }
    }
  })
});

// Hymnal Music Library Upload Configuration
const hymnalMusicUpload = multer({
  fileFilter: (req, file, cb) => {
    const allowedTypes = {
      'application/pdf': true,
      'audio/mpeg': true,
      'audio/mp3': true,
      'audio/wav': true,
      'audio/mp4': true,
      'audio/ogg': true,
      'audio/aac': true,
      'image/jpeg': true,
      'image/png': true,
      'image/gif': true,
      'image/webp': true,
      'image/jpg': true
    };

    if (allowedTypes[file.mimetype]) {
      cb(null, true);
    } else {
      cb(
        new Error(
          `Invalid file type: ${file.mimetype}. Only PDF, audio, and image files are allowed.`
        ),
        false
      );
    }
  },

  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB per file
    files: 30
  },

  storage: multerS3({
    s3: s3Client,
    bucket: BUCKET_NAME,

    metadata: function (req, file, cb) {
      cb(null, {
        fieldName: String(file.fieldname || ''),
        uploadedBy: String(req.user?.id || 'anonymous'),
        uploadedAt: new Date().toISOString(),
        hymnalMusicLibrary: 'true'
      });
    },

    key: function (req, file, cb) {
      let subfolder = 'general';

      if (file.mimetype === 'application/pdf') {
        subfolder = 'pdfs';
      } else if (file.mimetype.startsWith('audio/')) {
        subfolder = 'audio';
      } else if (file.mimetype.startsWith('image/')) {
        subfolder = 'images';
      }

      if (req.user) {
        const fileName = generateFileName(
          req,
          `hymnal-music-library/${subfolder}`,
          file.originalname
        );
        cb(null, fileName);
      } else {
        const timestamp = Date.now();
        const fileExtension = file.originalname.split('.').pop();
        const randomString = Math.random().toString(36).substring(7);

        const fileName = `sl-music-backend/anonymous/hymnal-music-library/${subfolder}/${timestamp}-${randomString}.${fileExtension}`;
        cb(null, fileName);
      }
    }
  })
});


// Function to delete file from S3
const deleteFileFromS3 = async (fileUrl) => {
  try {
    if (!fileUrl) return;

    // Extract key from URL
    const urlParts = fileUrl.split('/');
    const key = urlParts.slice(3).join('/'); // Remove https://bucket-name.s3.region.amazonaws.com/

    const command = new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key
    });

    await s3Client.send(command);
    console.log(`File deleted from S3: ${key}`);
  } catch (error) {
    console.error('Error deleting file from S3:', error);
  }
};

// Function to get file size from S3
const getFileSizeFromS3 = async (fileUrl) => {
  try {
    if (!fileUrl) return 0;

    const urlParts = fileUrl.split('/');
    const key = urlParts.slice(3).join('/');

    const command = new HeadObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key
    });

    const headObject = await s3Client.send(command);
    return headObject.ContentLength;
  } catch (error) {
    console.error('Error getting file size from S3:', error);
    return 0;
  }
};

// Upload to S3 function for review board photos
const uploadToS3 = async (file, folder = 'review-board-photos') => {
  try {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const timestamp = Date.now();
    const fileExtension = file.originalname.split('.').pop();
    const fileName = `sl-music-backend/${folder}/${timestamp}-${Math.random().toString(36).substring(7)}.${fileExtension}`;

    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileName,
      Body: file.buffer,
      ContentType: file.mimetype,
      ACL: 'public-read'
    });

    await s3Client.send(command);

    return `https://${BUCKET_NAME}.s3.${BUCKET_REGION}.amazonaws.com/${fileName}`;
  } catch (error) {
    console.error('S3 upload error:', error);
    throw error;
  }
};

// Delete from S3 function for review board photos
const deleteFromS3 = async (fileUrl) => {
  try {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');

    // Extract key from URL
    const urlParts = fileUrl.split('/');
    const key = urlParts.slice(3).join('/'); // Remove https://bucket.s3.region.amazonaws.com/

    const command = new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key
    });

    await s3Client.send(command);
    return true;
  } catch (error) {
    console.error('S3 delete error:', error);
    throw error;
  }
};

const documentUpload = multer({
  fileFilter: (req, file, cb) => {
    const allowedTypes = {
      'application/pdf': true,
      'application/msword': true,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': true,
      'text/plain': true,
      'image/jpeg': true,
      'image/png': true
    };

    if (allowedTypes[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, DOC, images allowed'), false);
    }
  },

  storage: multerS3({
    s3: s3Client,
    bucket: BUCKET_NAME,

    metadata: function (req, file, cb) {
      cb(null, {
        uploadedBy: String(req.user?.id || "anonymous"),
        uploadedAt: new Date().toISOString(),
        type: "document"
      });
    },

    key: function (req, file, cb) {
      if (req.user) {
        const fileName = generateFileName(req, 'documents', file.originalname);
        cb(null, fileName);
      } else {
        const timestamp = Date.now();
        const ext = file.originalname.split('.').pop();

        const fileName = `sl-music-backend/anonymous/documents/${timestamp}-${Math.random().toString(36).substring(7)}.${ext}`;
        cb(null, fileName);
      }
    }
  })
});

const courseThumbnailUpload = multer({
  fileFilter: (req, file, cb) => {
    const allowedTypes = {
      "image/jpeg": true,
      "image/jpg": true,
      "image/png": true,
      "image/webp": true,
      "image/gif": true
    };

    if (allowedTypes[file.mimetype]) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Only JPG, JPEG, PNG, WEBP and GIF files are allowed."
        ),
        false
      );
    }
  },

  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB
  },

  storage: multerS3({
    s3: s3Client,
    bucket: BUCKET_NAME,

    contentType: multerS3.AUTO_CONTENT_TYPE,

    metadata: (req, file, cb) => {
      cb(null, {
        uploadedBy: String(req.user?.id || "anonymous"),
        uploadedAt: new Date().toISOString(),
        type: "course-thumbnail"
      });
    },

    key: (req, file, cb) => {
      try {
        const timestamp = Date.now();

        const cleanFileName = file.originalname
          .replace(/\s+/g, "-")
          .replace(/[^a-zA-Z0-9.-]/g, "");

        const filePath = req.user
          ? `sl-music-backend/course-thumbnails/${req.user.id}/${timestamp}-${cleanFileName}`
          : `sl-music-backend/course-thumbnails/anonymous/${timestamp}-${cleanFileName}`;

        cb(null, filePath);
      } catch (err) {
        cb(err);
      }
    }
  })
});

module.exports = {
  s3: s3Client,
  upload,
  musicUpload,
  artworkUpload,
  agreementUpload,
  EducatorApplicationsFilesUpload,
  CourseResourcesUpload,
  avatarUpload,
  libraryImageUpload,
  collectionImageUpload,
  reviewBoardDocumentUpload,
  composerApplicationUpload,
  reviewBoardPhotoUpload,
  uploadAnyFile,
  communityMusicLibraryUpload,
  hymnalMusicUpload,
  documentUpload,
  uploadToS3,
  deleteFromS3,
  deleteFileFromS3,
  getFileSizeFromS3,
  makeSafeUserFolder,
  generateFileName,
  BUCKET_NAME,
  BUCKET_REGION,
  courseThumbnailUpload
};
