const express = require('express');
const { getMySQLConnection } = require('../config/mysql');
const { auth } = require('../middleware/auth');
const { requireAnyRole } = require('../middleware/roleAuth');
const { successResponse, errorResponse } = require('../utils/response');

const router = express.Router();

// @route   GET /api/composer-profile/public/composers
// @desc    Get all public composers (only where is_composer = TRUE)
// @access  Public
router.get('/public/composers', async (req, res) => {
  try {
    const pool = getMySQLConnection();
    const connection = await pool.getConnection();

    // ✅ Step 1: Get all composers
    const [composerRows] = await connection.execute(
      `SELECT 
        u.id,
        u.first_name,
        u.last_name,
        u.publisherName,
        u.email,
        u.phone,
        u.role,
        u.bio,
        u.avatar,
        u.website_url,
        u.twitter_url,
        u.address,
        u.country,
        u.state_province,
        u.city,
        u.postal_code,
        u.language,
        u.badges,
        u.custom_permissions AS permissions,
        u.is_active,
        u.last_login,
        u.created_at,
        u.updated_at,
        u.is_composer,
        COUNT(mp.id) AS total_publications,
        SUM(CASE WHEN mp.status = 'published' THEN 1 ELSE 0 END) AS published_count
       FROM users u
       LEFT JOIN music_publications mp ON u.id = mp.composer_id
       WHERE u.is_composer = TRUE
       GROUP BY u.id
       ORDER BY u.created_at DESC`
    );

    // ✅ Step 2: Get all publications WITH publisherName
    const [allPublications] = await connection.execute(
      `SELECT 
        mp.id,
        mp.composer_id,
        u.publisherName, -- ✅ IMPORTANT
        mp.composition_title,
        mp.composition_description,
        mp.composer_firstname,
        mp.composer_lastname,
        mp.vocal_parts,
        mp.instrumentation,
        mp.artists,
        mp.types_of_music,
        mp.first_line_of_composition,
        mp.composition_copyrights,
        mp.song_type,
        mp.meter,
        mp.season,
        mp.price,
        mp.psalm_number,
        mp.text_copyright_notice,
        mp.tune_copyright_notice,
        mp.music_files,
        mp.artwork_file_url,
        mp.artwork_file_size,
        mp.status,
        mp.published_at,
        mp.created_at
       FROM music_publications mp
       LEFT JOIN users u ON u.id = mp.composer_id
       ORDER BY mp.created_at DESC`
    );

    // ✅ Step 3: Composer applications
    const [composerApplications] = await connection.execute(
      `SELECT 
        *
       FROM composer_applications
       ORDER BY created_at DESC`
    );

    // ✅ Step 4: Group publications by composer
    const publicationsByComposer = {};
    allPublications.forEach(pub => {
      if (!publicationsByComposer[pub.composer_id]) {
        publicationsByComposer[pub.composer_id] = [];
      }

      publicationsByComposer[pub.composer_id].push({
        id: pub.id,
        status: pub.status,
        publisherName: pub.publisherName,
        compositionTitle: pub.composition_title,
        compositionDescription: pub.composition_description,
        composerFirstName: pub.composer_firstname,
        composerLastName: pub.composer_lastname,
        vocalParts: parseJSON(pub.vocal_parts),
        instrumentation: parseJSON(pub.instrumentation),
        artists: parseJSON(pub.artists, []),
        typesOfMusic: pub.types_of_music,
        firstLineOfComposition: pub.first_line_of_composition,
        compositionCopyrights: parseJSON(pub.composition_copyrights, []),
        songType: pub.song_type,
        meter: pub.meter,
        season: pub.season,
        psalmNumber: pub.psalm_number,
        textCopyrightNotice: pub.text_copyright_notice,
        tuneCopyrightNotice: pub.tune_copyright_notice,
        musicFiles: parseJSON(pub.music_files, []),
        artworkFileUrl: pub.artwork_file_url,
        artworkFileSize: pub.artwork_file_size,
        price: pub.price,
        publishedAt: pub.published_at,
        createdAt: pub.created_at
      });
    });

    // ✅ Step 5: Group applications
    const applicationsByComposer = {};
    composerApplications.forEach(app => {
      if (!applicationsByComposer[app.user_id]) {
        applicationsByComposer[app.user_id] = [];
      }
      applicationsByComposer[app.user_id].push({
        id: app.id,
        status: app.status,
        fullName: app.full_name,
        email: app.email,
        phoneNumber: app.phone_number,
        createdAt: app.created_at,
        updatedAt: app.updated_at
      });
    });

    // ✅ Step 6: Final response
    const composers = composerRows.map(c => ({
      id: c.id,
      firstName: c.first_name,
      lastName: c.last_name,
      publisherName: c.publisherName,
      fullName: `${c.first_name} ${c.last_name}`,
      email: c.email,
      phone: c.phone,
      role: c.role,
      isComposer: !!c.is_composer,
      bio: c.bio,
      avatar: c.avatar,
      websiteUrl: c.website_url,
      twitterUrl: c.twitter_url,
      address: c.address,
      location: {
        country: c.country,
        stateProvince: c.state_province,
        city: c.city,
        postalCode: c.postal_code
      },
      language: c.language,
      badges: parseJSON(c.badges),
      permissions: parseJSON(c.permissions),
      isActive: c.is_active,
      lastLogin: c.last_login,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      statistics: {
        totalPublications: c.total_publications || 0,
        publishedCount: c.published_count || 0
      },
      publications: publicationsByComposer[c.id] || [],
      applications: applicationsByComposer[c.id] || []
    }));

    connection.release();

    return successResponse(res, {
      composers,
      totalComposers: composers.length
    }, 'Public composer list retrieved successfully.');

  } catch (error) {
    console.error('Error fetching public composers list:', error);
    return errorResponse(res, 'Failed to fetch public composers list', 500);
  }
});


// ✅ Small helper for safe JSON parsing
function parseJSON(value, fallback = null) {
  if (!value) return fallback;
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return fallback;
  }
}


// @route   GET /api/composer-profile/my-profile
// @desc    Get current composer's own profile details
// @access  Private (Authenticated composer users only)
router.get('/my-profile', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const pool = getMySQLConnection();
    const connection = await pool.getConnection();

    // Get composer's user details
    const [userRows] = await connection.execute(
      `SELECT 
        id,
        first_name,
        last_name,
        email,
        phone,
        role,
        bio,
        avatar,
        website_url,
        twitter_url,
        address,
        country,
        state_province,
        city,
        postal_code,
        language,
        badges,
        permissions,
        is_active,
        last_login,
        created_at,
        updated_at
       FROM users 
       WHERE id = ? AND role = 'composer'`,
      [userId]
    );

    if (userRows.length === 0) {
      connection.release();
      return errorResponse(res, 'Composer profile not found or user is not a composer', 404);
    }

    const user = userRows[0];

    // Get composer's music publications
    const [publications] = await connection.execute(
      `SELECT 
        id,
        composition_title,
        composition_description,
        composer_firstname,
        composer_lastname,
        vocal_parts,
        instrumentation,
        artists,
        types_of_music,
        first_line_of_composition,
        composition_copyrights,
        song_type,
        meter,
        season,
        psalm_number,
        text_copyright_notice,
        tune_copyright_notice,
        music_files,
        artwork_file_url,
        artwork_file_size,
        status,
        published_at,
        created_at
       FROM music_publications 
       WHERE composer_id = ?
       ORDER BY created_at DESC`,
      [userId]
    );

    // Get composer's application details
    const [applications] = await connection.execute(
      `SELECT 
        id,
        status,
        full_name,
        email,
        phone_number,
        street_address,
        address_line_2,
        city,
        state_province,
        zip_code,
        country,
        music_background,
        composition_background,
        accompaniment_types,
        other_instrumentation,
        church_affiliation,
        liturgical_draw,
        liturgical_purpose,
        notation_software_proficiency,
        digitization_method,
        notation_software_used,
        composition_1_title,
        composition_1_liturgical_use,
        composition_1_other_info,
        composition_1_files,
        composition_2_title,
        composition_2_liturgical_use,
        composition_2_other_info,
        composition_2_files,
        composition_3_title,
        composition_3_liturgical_use,
        composition_3_other_info,
        composition_3_files,
        terms_accepted,
        terms_accepted_at,
        reviewed_by,
        reviewed_at,
        review_notes,
        rejection_reason,
        created_at,
        updated_at
       FROM composer_applications 
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [userId]
    );

    // Get subscription details
    const [subscriptions] = await connection.execute(
      `SELECT 
        us.id,
        us.start_date,
        us.end_date,
        us.status,
        us.payment_status,
        us.payment_method,
        us.amount_paid,
        us.created_at,
        s.name as subscription_name,
        s.description as subscription_description,
        s.price,
        s.duration_days,
        s.role,
        s.features
       FROM user_subscriptions us
       JOIN subscriptions_new s ON us.subscription_id = s.id
       WHERE us.user_id = ? AND us.status = 'active'
       ORDER BY us.created_at DESC
       LIMIT 1`,
      [userId]
    );

    // Calculate statistics
    const totalPublications = publications.length;
    const publishedCount = publications.filter(pub => pub.status === 'published').length;
    const draftCount = publications.filter(pub => pub.status === 'draft').length;
    const submittedCount = publications.filter(pub => pub.status === 'submitted').length;
    const approvalRate = totalPublications > 0 ? Math.round((publishedCount / totalPublications) * 100) : 0;

    // Format publications
    const formattedPublications = publications.map(pub => ({
      id: pub.id,
      status: pub.status,
      compositionTitle: pub.composition_title,
      compositionDescription: pub.composition_description,
      composerFirstName: pub.composer_firstname,
      composerLastName: pub.composer_lastname,
      vocalParts: pub.vocal_parts ? (typeof pub.vocal_parts === 'string' ? JSON.parse(pub.vocal_parts) : pub.vocal_parts) : null,
      instrumentation: pub.instrumentation ? (typeof pub.instrumentation === 'string' ? JSON.parse(pub.instrumentation) : pub.instrumentation) : null,
      artists: pub.artists ? (typeof pub.artists === 'string' ? JSON.parse(pub.artists) : pub.artists) : [],
      typesOfMusic: pub.types_of_music,
      firstLineOfComposition: pub.first_line_of_composition,
      compositionCopyrights: pub.composition_copyrights ? (typeof pub.composition_copyrights === 'string' ? JSON.parse(pub.composition_copyrights) : pub.composition_copyrights) : [],
      songType: pub.song_type,
      meter: pub.meter,
      season: pub.season,
      psalmNumber: pub.psalm_number,
      textCopyrightNotice: pub.text_copyright_notice,
      tuneCopyrightNotice: pub.tune_copyright_notice,
      musicFiles: pub.music_files ? JSON.parse(pub.music_files) : [],
      artworkFileUrl: pub.artwork_file_url,
      artworkFileSize: pub.artwork_file_size,
      publishedAt: pub.published_at,
      createdAt: pub.created_at
    }));

    // Format applications
    const formattedApplications = applications.map(app => ({
      id: app.id,
      status: app.status,
      fullName: app.full_name,
      email: app.email,
      phoneNumber: app.phone_number,
      address: {
        streetAddress: app.street_address,
        addressLine2: app.address_line_2,
        city: app.city,
        stateProvince: app.state_province,
        zipCode: app.zip_code,
        country: app.country
      },
      musicBackground: app.music_background,
      compositionBackground: app.composition_background,
      churchAffiliation: app.church_affiliation,
      liturgicalDraw: app.liturgical_draw,
      liturgicalPurpose: app.liturgical_purpose,
      notationSoftwareProficiency: app.notation_software_proficiency,
      digitizationMethod: app.digitization_method,
      notationSoftwareUsed: app.notation_software_used,
      compositions: {
        composition1: {
          title: app.composition_1_title,
          liturgicalUse: app.composition_1_liturgical_use,
          otherInfo: app.composition_1_other_info,
          files: app.composition_1_files ? JSON.parse(app.composition_1_files) : []
        },
        composition2: {
          title: app.composition_2_title,
          liturgicalUse: app.composition_2_liturgical_use,
          otherInfo: app.composition_2_other_info,
          files: app.composition_2_files ? JSON.parse(app.composition_2_files) : []
        },
        composition3: {
          title: app.composition_3_title,
          liturgicalUse: app.composition_3_liturgical_use,
          otherInfo: app.composition_3_other_info,
          files: app.composition_3_files ? JSON.parse(app.composition_3_files) : []
        }
      },
      termsAccepted: app.terms_accepted,
      termsAcceptedAt: app.terms_accepted_at,
      reviewedBy: app.reviewed_by,
      reviewedAt: app.reviewed_at,
      reviewNotes: app.review_notes,
      rejectionReason: app.rejection_reason,
      createdAt: app.created_at,
      updatedAt: app.updated_at
    }));

    // Format subscription
    const subscription = subscriptions.length > 0 ? {
      id: subscriptions[0].id,
      subscriptionName: subscriptions[0].subscription_name,
      subscriptionDescription: subscriptions[0].subscription_description,
      price: subscriptions[0].price,
      durationDays: subscriptions[0].duration_days,
      role: subscriptions[0].role,
      features: subscriptions[0].features ? JSON.parse(subscriptions[0].features) : null,
      startDate: subscriptions[0].start_date,
      endDate: subscriptions[0].end_date,
      status: subscriptions[0].status,
      paymentStatus: subscriptions[0].payment_status,
      paymentMethod: subscriptions[0].payment_method,
      amountPaid: subscriptions[0].amount_paid,
      createdAt: subscriptions[0].created_at
    } : null;

    // Format composer profile
    const composerProfile = {
      composer: {
        id: user.id,
        firstName: user.first_name,
        lastName: user.last_name,
        fullName: `${user.first_name} ${user.last_name}`,
        email: user.email,
        phone: user.phone,
        role: user.role,
        bio: user.bio,
        avatar: user.avatar,
        websiteUrl: user.website_url,
        twitterUrl: user.twitter_url,
        address: user.address,
        location: {
          country: user.country,
          stateProvince: user.state_province,
          city: user.city,
          postalCode: user.postal_code
        },
        language: user.language,
        badges: user.badges ? JSON.parse(user.badges) : null,
        permissions: user.permissions ? JSON.parse(user.permissions) : null,
        isActive: user.is_active,
        lastLogin: user.last_login,
        createdAt: user.created_at,
        updatedAt: user.updated_at
      },
      statistics: {
        totalPublications,
        publishedCount,
        draftCount,
        submittedCount,
        approvalRate
      },
      publications: formattedPublications,
      applications: formattedApplications,
      subscription
    };

    connection.release();

    return successResponse(res, composerProfile, 'Composer profile retrieved successfully');

  } catch (error) {
    console.error('Error fetching composer profile:', error);
    return errorResponse(res, 'Failed to fetch composer profile', 500);
  }
});

module.exports = router;
