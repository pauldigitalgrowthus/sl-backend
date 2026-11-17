const mysql = require('mysql2/promise');

let mysqlConnection = null;

// ============================================
// DATABASE CONNECTION
// ============================================
const connectMySQL = async () => {
  try {
    const dbConfig = {
      host: process.env.MYSQL_HOST,
      port: process.env.MYSQL_PORT,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    };

    // For localhost development, allow empty password
    if (!dbConfig.password && dbConfig.host !== 'localhost') {
      throw new Error('MySQL password is not defined in environment variables');
    }

    // Create database if it doesn't exist
    const tempConnection = mysql.createPool(dbConfig);
    const databaseName = process.env.MYSQL_DATABASE;

    try {
      await tempConnection.execute(`CREATE DATABASE IF NOT EXISTS ${databaseName}`);
    } catch (dbError) {
      console.error('Failed to create database:', dbError);
      throw dbError;
    }

    // Connect with the database
    dbConfig.database = databaseName;
    mysqlConnection = mysql.createPool(dbConfig);

    // Test the connection
    const connection = await mysqlConnection.getConnection();
    await connection.ping();
    connection.release();

    // Initialize all tables
    await initializeTables();

    console.log('✅ MySQL connected successfully');

  } catch (error) {
    console.error('MySQL connection failed:', error);
    throw error;
  }
};

/**
 * Universal table migration helper
 * Check missing columns & run ALTER queries only for missing columns
 * Support: ADD, MODIFY, DROP operations
 *
 * @param {object} mysqlConnection - MySQL connection
 * @param {string} tableName - e.g. 'user_signatures_documents'
 * @param {Array} columnsConfig - [
 *    { name: 'history2', alter: 'ADD COLUMN history2 JSON NULL' },
 *    { name: 'history2', alter: 'MODIFY COLUMN history2 VARCHAR(500) NULL', action: 'modify' },
 *    { name: 'old_column', alter: 'DROP COLUMN old_column', action: 'drop' }
 * ]
 */
async function ensureTableColumns(mysqlConnection, tableName, columnsConfig) {
  console.log(`\n🔍 Checking schema for table: ${tableName}`);

  for (const col of columnsConfig) {
    try {
      const action = col.action || 'add'; // default: add

      // Check column existence
      const [existingColumns] = await mysqlConnection.query(
        `SHOW COLUMNS FROM \`${tableName}\` WHERE Field = '${col.name}'`
      );

      const columnExists = existingColumns && existingColumns.length > 0;

      // Handle DROP operation
      if (action === 'drop') {
        if (!columnExists) {
          console.log(`✔️ Column '${col.name}' already dropped/doesn't exist → skipping`);
          continue;
        }

        console.log(`⚠️ Column '${col.name}' EXISTS → dropping...`);
        const finalSQL = `ALTER TABLE \`${tableName}\` ${col.alter}`;
        console.log("📌 Executing SQL:", finalSQL);
        await mysqlConnection.query(finalSQL);
        console.log(`✅ Column '${col.name}' dropped successfully`);
        continue;
      }

      // Handle MODIFY operation
      if (action === 'modify') {
        if (!columnExists) {
          console.log(`❌ Column '${col.name}' doesn't exist → cannot modify`);
          continue;
        }

        console.log(`⚠️ Column '${col.name}' EXISTS → modifying...`);
        const finalSQL = `ALTER TABLE \`${tableName}\` ${col.alter}`;
        console.log("📌 Executing SQL:", finalSQL);
        await mysqlConnection.query(finalSQL);
        console.log(`✅ Column '${col.name}' modified successfully`);
        continue;
      }

      // Handle ADD operation (default)
      if (columnExists) {
        console.log(`✔️ Column '${col.name}' already exists → skipping`);
        continue;
      }

      console.log(`⚠️ Column '${col.name}' NOT FOUND → preparing ALTER...`);

      let alterSQL = col.alter;

      // 🔍 Auto-detect invalid AFTER <column>
      const afterMatch = alterSQL.match(/AFTER\s+(\w+)/i);
      if (afterMatch) {
        const afterCol = afterMatch[1];

        const [afterExists] = await mysqlConnection.query(
          `SHOW COLUMNS FROM \`${tableName}\` WHERE Field = '${afterCol}'`
        );

        if (!afterExists || afterExists.length === 0) {
          console.log(
            `⚠️ AFTER column '${afterCol}' does NOT exist → removing 'AFTER ${afterCol}'`
          );
          alterSQL = alterSQL.replace(/AFTER\s+\w+/i, "").trim();
        }
      }

      const finalSQL = `ALTER TABLE \`${tableName}\` ${alterSQL}`;

      console.log("📌 Executing SQL:", finalSQL);

      await mysqlConnection.query(finalSQL);

      console.log(`✅ Column '${col.name}' added successfully`);
    } catch (err) {
      console.error(
        `❌ Error altering '${tableName}' column '${col.name}':`,
        err.sqlMessage || err.message
      );
    }
  }

  console.log(`✨ Completed schema update for ${tableName}\n`);
}


// ============================================
// TABLE INITIALIZATION
// ============================================
const initializeTables = async () => {
  try {
    // Initialize tables in order
    await createUsersTable();
    await createCommunityMembersTable();
    await createPasswordResetOtpsTable();
    await createSubscriptionsTable();
    await createUserSubscriptionsTable();
    await createFiltersTable();
    await createSmallFiltersTable();
    await createTypeOfMusicTable();
    await createComposerApplicationsTable();
    await createReviewBoardApplicationsTable();
    await createCollectionsTable();
    await createUserMusicFoldersTable();
    await createMusicPublicationsTable();
    await createLibrariesTable();
    await createLibraryMusicTable();
    await createCollectionMusicTable();
    await createUserMusicLibraryTable();
    await createCommunityMusicLibraryTable();  // MOVED HERE (must be before createCommunityCollectionMusicTable)
    await createCommunityCollectionMusicTable();  // Now references existing table
    await createUserMusicCartTable();
    await createUserOrdersTable();
    await createPermissionTables();
    await createPaymentTables();
    await createMusicTransactionsTable();
    await createComposerToolsTable();
    await createAgreementManagementTable();
    await createNotficationManagementTable();
    await createPlannerTables();
    await createUserActivityLogsTable()
    await createCouponsTable()
    await createLiturgicalEventsTable()
    await createHymnalMusicLibraryTable()
    await createDiocesesTable();
    await createDiocesanCommunitiesTable();
    await createDiocesanInvitationsTable();
    await createDiocesanPaymentsTable();
    await createDiocesanActivityLogsTable();
    await createDiocesanPaymentsTable();
    await createDiocesanParishesTable();
    await createDocumentTable();
    await createComposerEarningTable();
    await createEducatorTables();
    coursetTable();

    // Seed default data
    await insertDefaultSubscriptions();
    // await createSystemCollections();
    await seedRolePermissions();
    await seedPermissionData();

    console.log('✅ All tables initialized successfully');

  } catch (error) {
    console.error('Failed to initialize MySQL tables:', error);
    throw error;
  }
};

// ============================================
// TABLE 1: USERS
// ============================================
const createUsersTable = async () => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      
      -- Basic Information
      first_name VARCHAR(50) NOT NULL,
      last_name VARCHAR(50) NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      phone VARCHAR(20),
      
      -- Role & Hierarchy
      role ENUM('sl_team', 'user', 'free_user') DEFAULT 'free_user',
      user_type ENUM('admin', 'sub_user', 'superadmin', 'manager') DEFAULT 'admin',
      parent_user_id INT NULL,
      
      -- Plan & Subscription
      current_plan_id INT NULL,
      plan_start_date TIMESTAMP NULL,
      plan_end_date TIMESTAMP NULL,
      plan_status ENUM('free', 'active', 'expired', 'cancelled') DEFAULT 'free',
      
      -- Permissions
      plan_permissions JSON NULL,
      custom_permissions JSON NULL,
      permissions JSON NULL,
      
      -- Sub-user Management
      max_sub_users INT DEFAULT 0,
      active_sub_users_count INT DEFAULT 0,
      
      -- Profile Information
      bio TEXT,
      avatar VARCHAR(255),
      website_url VARCHAR(255),
      twitter_url VARCHAR(255),
      address TEXT,
      country VARCHAR(100),
      state_province VARCHAR(100),
      city VARCHAR(100),
      postal_code VARCHAR(20),
      
      -- Preferences
      language VARCHAR(50) DEFAULT 'en',
      timezone VARCHAR(100) DEFAULT 'UTC',
      
      -- Badges & Achievements
      badges JSON,
      
      -- Status & Activity
      is_composer BOOLEAN DEFAULT FALSE,
      is_review_board_member BOOLEAN DEFAULT FALSE,
      is_active BOOLEAN DEFAULT TRUE,
      is_verified BOOLEAN DEFAULT FALSE,
      email_verified_at TIMESTAMP NULL,
      last_login TIMESTAMP NULL,
      login_count INT DEFAULT 0,
      
      -- Free User Restrictions
      free_trial_started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      free_trial_expires_at TIMESTAMP NULL,
      has_upgraded BOOLEAN DEFAULT FALSE,
      
      -- Timestamps
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      deleted_at TIMESTAMP NULL,
      
      -- Indexes
      INDEX idx_email (email),
      INDEX idx_role (role),
      INDEX idx_parent_user (parent_user_id),
      INDEX idx_plan_status (plan_status),
      INDEX idx_current_plan (current_plan_id),
      
      -- Foreign Keys
      FOREIGN KEY (parent_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM users LIMIT 1');
    console.log('✅ Users table already exists');
    await ensureTableColumns(mysqlConnection, 'users', [
      { name: 'user_type', alter: "MODIFY COLUMN user_type ENUM('admin', 'sub_user', 'superadmin', 'manager') DEFAULT 'admin'", action: 'modify' },
      { name: 'publisherName', alter: "ADD COLUMN publisherName VARCHAR(200) NULL AFTER full_name", action: 'add' },
      { name: 'useFullNameAsPublisher', alter: "ADD COLUMN useFullNameAsPublisher BOOLEAN DEFAULT FALSE", action: 'add' },
      { name: 'is_diocesan', alter: "ADD COLUMN is_diocesan BOOLEAN DEFAULT FALSE", action: 'add' }

    ]);

    // Update permissions field if needed
    const [columns] = await mysqlConnection.execute('SHOW COLUMNS FROM users LIKE "permissions"');
    if (columns.length > 0) {
      const permissionsColumn = columns[0];
      if (!permissionsColumn.Type.includes('json')) {
        await mysqlConnection.execute('ALTER TABLE users MODIFY COLUMN permissions JSON NULL');
        console.log('✅ Permissions field updated to JSON type');
      }
    }

    // Add address field if missing
    const [addressColumns] = await mysqlConnection.execute('SHOW COLUMNS FROM users LIKE "address"');
    if (addressColumns.length === 0) {
      await mysqlConnection.execute('ALTER TABLE users ADD COLUMN address TEXT AFTER twitter_url');
      console.log('✅ Address field added to users table');
    }

  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ Users table created');
  }
};

// ============================================
// TABLE 2: COMMUNITY MEMBERS
// ============================================
const createCommunityMembersTable = async () => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS community_members (
      id INT AUTO_INCREMENT PRIMARY KEY,
      
      -- Member Details
      name VARCHAR(150) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      phone VARCHAR(30) DEFAULT NULL,
      city VARCHAR(100) DEFAULT NULL,
      gender ENUM('Male', 'Female', 'Other') DEFAULT NULL,
      
      -- Parent/Admin relationship
      parent_user_id INT NOT NULL,
      
      -- Conversion tracking
      user_id INT DEFAULT NULL,
      status ENUM('invited', 'active', 'inactive') DEFAULT 'invited',
      
      -- Invitation details
      is_invited TINYINT(1) DEFAULT 1,
      invited_at TIMESTAMP NULL DEFAULT NULL,
      invitation_token VARCHAR(255) DEFAULT NULL,
      invitation_expires_at TIMESTAMP NULL,
      
      -- Login credentials
      has_login_credentials TINYINT(1) DEFAULT 0,
      credentials_created_at TIMESTAMP NULL,
      
      -- Timestamps
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      deleted_at TIMESTAMP NULL,
      
      -- Indexes
      INDEX idx_parent_user (parent_user_id),
      INDEX idx_email (email),
      INDEX idx_status (status),
      INDEX idx_user_id (user_id),
      
      -- Foreign Keys
      FOREIGN KEY (parent_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM community_members LIMIT 1');
    await ensureTableColumns(mysqlConnection, 'community_members', [{ name: "role", alter: "ADD COLUMN role ENUM('member', 'manager') DEFAULT 'member' AFTER email", action: 'add' }]);
    console.log('✅ Community members table already exists');
  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ Community members table created');
  }
};


// ============================================
// TABLE 3: PASSWORD RESET OTPS
// ============================================
const createPasswordResetOtpsTable = async () => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS password_reset_otps (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      otp_code VARCHAR(6) NOT NULL,
      expires_at DATETIME NOT NULL,
      is_used BOOLEAN DEFAULT FALSE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_user_id (user_id),
      INDEX idx_otp_code (otp_code),
      INDEX idx_expires_at (expires_at),
      INDEX idx_user_otp (user_id, otp_code),
      
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM password_reset_otps LIMIT 1');
    console.log('✅ Password reset OTPs table already exists');
  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ Password reset OTPs table created');
  }
};

// ============================================
// TABLE 4: SUBSCRIPTIONS
// ============================================
const createSubscriptionsTable = async () => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS subscriptions_new (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      price DECIMAL(10,2) NOT NULL,
      duration_days INT NOT NULL,
      role ENUM('sl_team', 'composer', 'music', 'educator', 'planner', 'documents') NOT NULL,
      features JSON,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_role (role),
      INDEX idx_is_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM subscriptions_new LIMIT 1');
    console.log('✅ Subscriptions table already exists');
  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ Subscriptions table created');
  }
};

// ============================================
// TABLE 5: USER SUBSCRIPTIONS
// ============================================
const createUserSubscriptionsTable = async () => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS user_subscriptions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      subscription_id INT NOT NULL,
      start_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      end_date TIMESTAMP NULL,
      status ENUM('active', 'expired', 'cancelled') DEFAULT 'active',
      payment_status ENUM('pending', 'completed', 'failed', 'refunded') DEFAULT 'pending',
      payment_method VARCHAR(100),
      amount_paid DECIMAL(10,2),
      stripe_subscription_id VARCHAR(255),
      stripe_customer_id VARCHAR(255),
      stripe_payment_intent_id VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_user_id (user_id),
      INDEX idx_subscription_id (subscription_id),
      INDEX idx_status (status),
      INDEX idx_end_date (end_date),
      INDEX idx_stripe_subscription_id (stripe_subscription_id),
      INDEX idx_stripe_customer_id (stripe_customer_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM user_subscriptions LIMIT 1');
    console.log('✅ User subscriptions table already exists');
  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ User subscriptions table created');
  }
};

// ============================================
// TABLE 6: FILTERS
// ============================================
const createFiltersTable = async () => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS filters (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      full_path JSON NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;  
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM filters LIMIT 1');
    console.log('✅ Filters table already exists');
  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ Filters table created');
  }
};

// ============================================
// TABLE 7: SMALL FILTERS
// ============================================
const createSmallFiltersTable = async () => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS small_filters (
      id INT AUTO_INCREMENT PRIMARY KEY,
      label VARCHAR(255) NOT NULL,
      items JSON NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      
      INDEX idx_label (label)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM small_filters LIMIT 1');
    console.log('✅ Small filters table already exists');
  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ Small filters table created');
  }
};

// ============================================
// TABLE 8: TYPE OF MUSIC
// ============================================
const createTypeOfMusicTable = async () => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS type_of_music (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      
      INDEX idx_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM type_of_music LIMIT 1');
    console.log('✅ Type of music table already exists');
  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ Type of music table created');
  }
};

// ============================================
// TABLE 9: COMPOSER APPLICATIONS
// ============================================
const createComposerApplicationsTable = async () => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS composer_applications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      status ENUM('under_review', 'approved', 'rejected') DEFAULT 'under_review',
      application_source ENUM('user_submitted', 'sl_team_created') NOT NULL DEFAULT 'user_submitted',
      
      -- Step 1: Basic Information
      full_name VARCHAR(100),
      email VARCHAR(100),
      phone_number VARCHAR(20),
      street_address TEXT,
      address_line_2 TEXT,
      city VARCHAR(100),
      state_province VARCHAR(100),
      zip_code VARCHAR(20),
      country VARCHAR(100),
      
      -- Step 2: Music/Composition Background
      music_background TEXT,
      composition_background TEXT,
      
      -- Step 3: Liturgical Experience and Philosophy
      church_affiliation TEXT,
      liturgical_draw TEXT,
      liturgical_purpose TEXT,
      
      -- Step 4: Digital Engraving Abilities
      notation_software_proficiency ENUM('Beginner', 'Intermediate', 'Advanced', 'Expert') DEFAULT 'Beginner',
      digitization_method TEXT,
      notation_software_used VARCHAR(100),
      
      -- Step 5: Music Submissions (Composition 1)
      composition_1_title VARCHAR(200),
      composition_1_liturgical_use TEXT,
      composition_1_other_info TEXT,
      composition_1_files JSON,
      
      -- Step 5: Music Submissions (Composition 2)
      composition_2_title VARCHAR(200),
      composition_2_liturgical_use TEXT,
      composition_2_other_info TEXT,
      composition_2_files JSON,
      
      -- Step 5: Music Submissions (Composition 3)
      composition_3_title VARCHAR(200),
      composition_3_liturgical_use TEXT,
      composition_3_other_info TEXT,
      composition_3_files JSON,
      
      -- Step 6: Terms & Conditions
      terms_accepted BOOLEAN DEFAULT FALSE,
      terms_accepted_at TIMESTAMP NULL,
      
      -- Review Information
      reviewed_by INT NULL,
      reviewed_at TIMESTAMP NULL,
      review_notes TEXT,
      rejection_reason TEXT,
      
      -- Timestamps
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      -- Indexes
      INDEX idx_user_id (user_id),
      INDEX idx_status (status),
      INDEX idx_created_at (created_at),
      INDEX idx_reviewed_by (reviewed_by),
      INDEX idx_application_source (application_source),
      
      -- Foreign Keys
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM composer_applications LIMIT 1');
    await ensureTableColumns(mysqlConnection, 'composer_applications', [
      { name: 'accompaniment_types', alter: 'ADD COLUMN accompaniment_types JSON AFTER composition_background' },
      { name: 'other_instrumentation', alter: 'ADD COLUMN other_instrumentation TEXT AFTER accompaniment_types' },
      { name: 'publisherName', alter: "ADD COLUMN publisherName VARCHAR(200) NULL AFTER full_name", action: 'add' },
      { name: 'useFullNameAsPublisher', alter: "ADD COLUMN useFullNameAsPublisher BOOLEAN DEFAULT FALSE", action: 'add' }
    ]);
    console.log('✅ Composer applications table already exists');
  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ Composer applications table created');
  }
};

// ============================================
// TABLE 10: REVIEW BOARD APPLICATIONS
// ============================================
const createReviewBoardApplicationsTable = async () => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS review_board_applications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      status ENUM('pending', 'approved', 'rejected', 'inactive') DEFAULT 'pending',
      application_source ENUM('user_submitted', 'sl_team_created') NOT NULL DEFAULT 'user_submitted',

      -- Personal Information
      first_name VARCHAR(255) NOT NULL,
      last_name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      phone VARCHAR(20),
      address TEXT,
      gender VARCHAR(50),
      photo VARCHAR(500),
      bio TEXT,

      -- Terms and Conditions
      terms_accepted BOOLEAN DEFAULT FALSE,
      terms_accepted_at TIMESTAMP NULL,

      -- Review Information
      reviewed_by INT NULL,
      reviewed_at TIMESTAMP NULL,
      review_notes TEXT,
      rejection_reason TEXT,

      -- Timestamps
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

      -- Indexes
      INDEX idx_user_id (user_id),
      INDEX idx_status (status),
      INDEX idx_application_source (application_source),
      INDEX idx_created_at (created_at),
      INDEX idx_reviewed_by (reviewed_by),

      -- Foreign Keys
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;


  try {
    await mysqlConnection.execute('SELECT 1 FROM review_board_applications LIMIT 1');
    await ensureTableColumns(mysqlConnection, 'review_board_applications', [{ name: 'bio', alter: 'ADD COLUMN bio TEXT AFTER photo' }]);
    await ensureTableColumns(mysqlConnection, 'review_board_applications', [{ name: 'city', alter: 'ADD COLUMN city TEXT AFTER address' }]);
    await ensureTableColumns(mysqlConnection, 'review_board_applications', [{ name: 'state', alter: 'ADD COLUMN state TEXT' }]);
    await ensureTableColumns(mysqlConnection, 'review_board_applications', [{ name: 'Zipcode', alter: 'ADD COLUMN Zipcode TEXT' }]);
    await ensureTableColumns(mysqlConnection, 'review_board_applications', [{ name: 'country', alter: 'ADD COLUMN country TEXT' }]);
    await ensureTableColumns(mysqlConnection, 'review_board_applications', [{ name: 'address2', alter: 'ADD COLUMN address2 TEXT ' }]);

    console.log('✅ Review board applications table already exists');
  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ Review board applications table created');
  }
};

// ============================================
// TABLE 11: COLLECTIONS
// ============================================
const createCollectionsTable = async () => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS collections (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      image_url VARCHAR(500),
      is_system_collection BOOLEAN DEFAULT FALSE,
      created_by ENUM('system', 'user') DEFAULT 'user',
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_user_id (user_id),
      INDEX idx_is_system_collection (is_system_collection),
      INDEX idx_created_by (created_by),
      INDEX idx_is_active (is_active),
      
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM collections LIMIT 1');
    console.log('✅ Collections table already exists');
  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ Collections table created');
  }
};

// ============================================
// TABLE 11.5: USER MUSIC FOLDERS
// ============================================
const createUserMusicFoldersTable = async () => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS user_music_folders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      folder_name VARCHAR(255) NOT NULL,
      description TEXT NULL,
      user_id INT NOT NULL,
      songs JSON NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_music_folder_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM user_music_folders LIMIT 1');
    console.log('✅ User music folders table already exists');
  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ User music folders table created');
  }
};

// ============================================
// TABLE 12: MUSIC PUBLICATIONS
// ============================================
const createMusicPublicationsTable = async () => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS music_publications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      composer_id INT NOT NULL,
      status ENUM('draft', 'submitted', 'onelicense_verification', 'admin_review', 'sl_team_review', 'published', 'rejected') DEFAULT 'draft',
      review_stage ENUM('review_board', 'director_review', 'music_editorial', 'final_review', 'published', 'rejected') DEFAULT 'review_board',
      
      -- Composition Information
      composition_title VARCHAR(255) NOT NULL,
      composition_title_1 VARCHAR(255),
      composition_description TEXT,
      composer_firstname VARCHAR(100),
      composer_lastname VARCHAR(100),
      
      -- Collection Information
      is_part_of_collection BOOLEAN DEFAULT FALSE,
      collection_id INT NULL,
      collection_name VARCHAR(255),
      
      -- Music Details
      vocal_parts JSON,
      instrumentation JSON,
      types_of_music VARCHAR(100),
      
      -- OneLicense Information
      first_line_of_composition TEXT,
      composition_copyrights JSON,
      mass_setting_parts JSON,
      song_type ENUM('music', 'words_and_music') DEFAULT 'music',
      meter VARCHAR(50),
      season VARCHAR(100),
      psalm_number VARCHAR(50),
      liturgicalText LONGTEXT,
      verseStyle LONGTEXT,
      feast LONGTEXT,
      
      -- Copyright Details
      text_copyright_notice TEXT,
      tune_copyright_notice TEXT,
      
      -- Artist Details
      artists JSON,
      
      -- File Uploads
      music_files JSON,
      music_video_link VARCHAR(500),
      artwork_file_url VARCHAR(500),
      artwork_file_size BIGINT,
      
      -- Pricing
      price DECIMAL(10,2) DEFAULT 0.00,
      is_free BOOLEAN DEFAULT TRUE,
      
      -- General Details
      tune VARCHAR(255),
      general_details TEXT,
      country_restrictions TEXT,
      
      -- Usage Permissions
      is_public_domain BOOLEAN DEFAULT FALSE,
      can_be_reprinted BOOLEAN DEFAULT FALSE,
      can_be_podcast_streamed BOOLEAN DEFAULT FALSE,
      can_make_commercial_recording BOOLEAN DEFAULT FALSE,
      can_make_non_commercial_recording BOOLEAN DEFAULT FALSE,
      
      -- Terms & Conditions
      terms_accepted BOOLEAN DEFAULT FALSE,
      terms_accepted_at TIMESTAMP NULL,
      
      -- Stage 1: Review Board
      stage1_decision ENUM('approved', 'rejected', 'accept_with_changes') NULL,
      stage1_reviewed_by INT NULL,
      stage1_reviewed_at DATETIME NULL,
      stage1_notes TEXT NULL,
      stage1_reviews JSON NULL,
      stage1_replaced_files JSON NULL,
      stage1_review_comments JSON NULL,
      
      -- Stage 2: Director Review
      stage2_decision ENUM('approved', 'rejected', 'accept_with_changes') NULL,
      stage2_reviewed_by INT NULL,
      stage2_reviewed_at DATETIME NULL,
      stage2_notes TEXT NULL,
      stage2_replaced_files JSON NULL,
      stage2_comments JSON NULL,
      
      -- Stage 3: Music Editorial
      stage3_decision ENUM('approved', 'rejected', 'accept_with_changes') NULL,
      stage3_reviewed_by INT NULL,
      stage3_reviewed_at DATETIME NULL,
      stage3_notes TEXT NULL,
      stage3_replaced_files JSON NULL,
      stage3_composer_resubmissions JSON NULL,
      
      -- Stage 4: Final Review
      stage4_decision ENUM('approved', 'rejected', 'accept_with_changes') NULL,
      stage4_reviewed_by INT NULL,
      stage4_reviewed_at DATETIME NULL,
      stage4_notes TEXT NULL,
      
      -- OneLicense Verification (Legacy)
      onelicense_verified_by INT NULL,
      onelicense_verified_at TIMESTAMP NULL,
      onelicense_verification_notes TEXT,
      
      -- Admin Review (Legacy)
      admin_reviewed_by INT NULL,
      admin_reviewed_at TIMESTAMP NULL,
      admin_review_notes TEXT,
      
      -- SL Team Review (Legacy)
      sl_team_reviewed_by INT NULL,
      sl_team_reviewed_at TIMESTAMP NULL,
      sl_team_review_notes TEXT,
      rejection_reason TEXT,
      
      -- Publication Information
      published_at TIMESTAMP NULL,
      published_by INT NULL,
      
      -- Deletion Scheduling
      scheduled_deletion_at DATETIME NULL,
      
      -- Timestamps
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      -- Indexes
      INDEX idx_composer_id (composer_id),
      INDEX idx_status (status),
      INDEX idx_review_stage (review_stage),
      INDEX idx_collection_id (collection_id),
      INDEX idx_published_at (published_at),
      INDEX idx_onelicense_verified_by (onelicense_verified_by),
      INDEX idx_admin_reviewed_by (admin_reviewed_by),
      INDEX idx_sl_team_reviewed_by (sl_team_reviewed_by),
      INDEX idx_published_by (published_by),
      INDEX idx_stage1_reviewed_by (stage1_reviewed_by),
      INDEX idx_stage2_reviewed_by (stage2_reviewed_by),
      INDEX idx_stage3_reviewed_by (stage3_reviewed_by),
      INDEX idx_stage4_reviewed_by (stage4_reviewed_by),
      
      -- Foreign Keys
      FOREIGN KEY (composer_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (onelicense_verified_by) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (admin_reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (sl_team_reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (published_by) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (stage1_reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (stage2_reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (stage3_reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (stage4_reviewed_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM music_publications LIMIT 1');
    await ensureTableColumns(mysqlConnection, 'music_publications', [
      { name: 'mass_setting_parts', alter: 'ADD COLUMN mass_setting_parts JSON NULL AFTER composition_copyrights' },
      { name: 'publish_type', alter: "ADD COLUMN publish_type ENUM('review','direct') NOT NULL DEFAULT 'review' AFTER published_by" },
      { name: 'language', alter: 'ADD COLUMN language JSON NULL AFTER season' },
      { name: 'composition_title', alter: 'MODIFY composition_title VARCHAR(255) NULL', action: 'modify' },
      { name: 'includeInOneLicense', alter: 'ADD COLUMN includeInOneLicense BOOLEAN DEFAULT FALSE AFTER terms_accepted_at' },
      { name: 'signedContractUrl', alter: 'ADD COLUMN signedContractUrl TEXT NULL AFTER includeInOneLicense' },
      { name: 'signedContractUrlTime', alter: 'ADD COLUMN signedContractUrlTime DATETIME NULL AFTER signedContractUrl' },
      { name: 'finalContract', alter: 'ADD COLUMN finalContract TEXT NULL AFTER signedContractUrl' },
      { name: 'finalContractTime', alter: 'ADD COLUMN finalContractTime DATETIME NULL AFTER signedContractUrlTime' },
      { name: 'stage3_comments', alter: 'ADD COLUMN stage3_comments JSON NULL AFTER stage3_replaced_files' },
      // ===== Stage 1 Review Lock =====
      { name: 'stage1_review_lock_status', alter: 'ADD COLUMN stage1_review_lock_status VARCHAR(20) NULL AFTER includeInOneLicense' },
      { name: 'stage1_review_lock_reviewer_id', alter: 'ADD COLUMN stage1_review_lock_reviewer_id INT(11) NULL AFTER stage1_review_lock_status' },
      { name: 'stage1_review_lock_reviewer_name', alter: 'ADD COLUMN stage1_review_lock_reviewer_name VARCHAR(255) NULL AFTER stage1_review_lock_reviewer_id' },
      { name: 'stage1_review_lock_started_at', alter: 'ADD COLUMN stage1_review_lock_started_at DATETIME NULL AFTER stage1_review_lock_reviewer_name' },
      { name: 'stage1_review_lock_completed_at', alter: 'ADD COLUMN stage1_review_lock_completed_at DATETIME NULL AFTER stage1_review_lock_started_at' },
      // ===== Stage 1 Slot 1 =====
      { name: 'stage1_slot1_status', alter: 'ADD COLUMN stage1_slot1_status VARCHAR(20) NULL AFTER stage1_review_lock_completed_at' },
      { name: 'stage1_slot1_reviewer_id', alter: 'ADD COLUMN stage1_slot1_reviewer_id INT(11) NULL AFTER stage1_slot1_status' },
      { name: 'stage1_slot1_reviewer_name', alter: 'ADD COLUMN stage1_slot1_reviewer_name VARCHAR(255) NULL AFTER stage1_slot1_reviewer_id' },
      { name: 'stage1_slot1_started_at', alter: 'ADD COLUMN stage1_slot1_started_at DATETIME NULL AFTER stage1_slot1_reviewer_name' },
      { name: 'stage1_slot1_completed_at', alter: 'ADD COLUMN stage1_slot1_completed_at DATETIME NULL AFTER stage1_slot1_started_at' },
      // ===== Stage 1 Slot 2 =====
      { name: 'stage1_slot2_status', alter: 'ADD COLUMN stage1_slot2_status VARCHAR(20) NULL AFTER stage1_slot1_completed_at' },
      { name: 'stage1_slot2_reviewer_id', alter: 'ADD COLUMN stage1_slot2_reviewer_id INT(11) NULL AFTER stage1_slot2_status' },
      { name: 'stage1_slot2_reviewer_name', alter: 'ADD COLUMN stage1_slot2_reviewer_name VARCHAR(255) NULL AFTER stage1_slot2_reviewer_id' },
      { name: 'stage1_slot2_started_at', alter: 'ADD COLUMN stage1_slot2_started_at DATETIME NULL AFTER stage1_slot2_reviewer_name' },
      { name: 'stage1_slot2_completed_at', alter: 'ADD COLUMN stage1_slot2_completed_at DATETIME NULL AFTER stage1_slot2_started_at' },
      { name: 'stage1_slot1_reviewer_role', alter: 'ADD COLUMN stage1_slot1_reviewer_role VARCHAR(100) NULL AFTER stage1_slot1_reviewer_name' },
      { name: 'stage1_slot2_reviewer_role', alter: 'ADD COLUMN stage1_slot2_reviewer_role VARCHAR(100) NULL AFTER stage1_slot2_reviewer_name' },
      { name: 'unique_id', alter: 'ADD COLUMN unique_id VARCHAR(100) NULL AFTER stage1_slot2_reviewer_name' },
      { name: 'theme', alter: 'ADD COLUMN theme JSON NULL AFTER unique_id' },
      { name: 'partOfMass', alter: 'ADD COLUMN partOfMass JSON NULL AFTER themes' },
      { name: 'liturgicalSacrament', alter: 'ADD COLUMN liturgicalSacrament VARCHAR(100) NULL AFTER partsofmass' },
      { name: 'toggle', alter: "ADD COLUMN toggle ENUM('active','inactive') NOT NULL DEFAULT 'inactive'" },
      { name: 'stage2_history', alter: 'ADD COLUMN stage2_history JSON NULL AFTER stage2_replaced_files' },
      { name: 'stage3_history', alter: 'ADD COLUMN stage3_history JSON NULL AFTER stage3_replaced_files' }

    ]);
    console.log('✅ Music publications table already exists');
  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ Music publications table created');
  }
};

// ============================================
// TABLE 13: LIBRARIES
// ============================================
const createLibrariesTable = async () => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS libraries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      image_url VARCHAR(500),
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_user_id (user_id),
      INDEX idx_is_active (is_active),
      
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM libraries LIMIT 1');
    console.log('✅ Libraries table already exists');
  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ Libraries table created');
  }
};

// ============================================
// TABLE 14: LIBRARY MUSIC (JUNCTION)
// ============================================
const createLibraryMusicTable = async () => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS library_music (
      id INT AUTO_INCREMENT PRIMARY KEY,
      library_id INT NOT NULL,
      music_id INT NOT NULL,
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      
      UNIQUE KEY unique_library_music (library_id, music_id),
      INDEX idx_library_id (library_id),
      INDEX idx_music_id (music_id),
      
      FOREIGN KEY (library_id) REFERENCES libraries(id) ON DELETE RESTRICT,
      FOREIGN KEY (music_id) REFERENCES music_publications(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM library_music LIMIT 1');
    console.log('✅ Library music table already exists');
  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ Library music table created');
  }
};

// ============================================
// TABLE 15: COLLECTION MUSIC (JUNCTION)
// ============================================
const createCollectionMusicTable = async () => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS collection_music (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      collection_id INT NOT NULL,
      music_id INT NOT NULL,
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      
      UNIQUE KEY unique_collection_music (collection_id, music_id),
      INDEX idx_collection_id (collection_id),
      INDEX idx_music_id (music_id),
      
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
      FOREIGN KEY (music_id) REFERENCES music_publications(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM collection_music LIMIT 1');
    await ensureTableColumns(mysqlConnection, 'collection_music', [{ name: "user_id", alter: "ADD COLUMN user_id INT NOT NULL AFTER id" }]);
    console.log('✅ Collection music table already exists');
  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ Collection music table created');
  }
};

// ============================================
// TABLE: COMMUNITY COLLECTION MUSIC (JUNCTION)
// Supports both music_publications and community_music_library
// ============================================
const createCommunityCollectionMusicTable = async () => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS community_collection_music (
      id INT AUTO_INCREMENT PRIMARY KEY,
      collection_id INT NOT NULL,
      user_id INT NOT NULL,
      music_publication_id INT NULL,
      community_music_library_id INT NULL,
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      
      UNIQUE KEY unique_collection_music_pub (collection_id, music_publication_id),
      UNIQUE KEY unique_collection_music_lib (collection_id, community_music_library_id),
      INDEX idx_collection_id (collection_id),
      INDEX idx_music_publication_id (music_publication_id),
      INDEX idx_community_music_library_id (community_music_library_id),
      INDEX idx_user_id (user_id),
      
      FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (music_publication_id) REFERENCES music_publications(id) ON DELETE CASCADE,
      FOREIGN KEY (community_music_library_id) REFERENCES community_music_library(id) ON DELETE CASCADE,
      
      -- Ensure exactly one music ID is provided
      CONSTRAINT chk_music_source CHECK (
        (music_publication_id IS NOT NULL AND community_music_library_id IS NULL) OR
        (music_publication_id IS NULL AND community_music_library_id IS NOT NULL)
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM community_collection_music LIMIT 1');
    await ensureTableColumns(mysqlConnection, 'community_collection_music', [{ name: "types_of_music", alter: "ADD COLUMN types_of_music VARCHAR(100)" }]);
    console.log('✅ Community collection music table already exists');
  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ Community collection music table created');
  }
};

// ============================================
// TABLE 16: USER MUSIC LIBRARY
// ============================================
const createUserMusicLibraryTable = async () => {
  const createTableSQL = `CREATE TABLE IF NOT EXISTS user_music_library (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    music_publication_id INT NOT NULL,
    
    -- File Information
    file_type ENUM('assembly', 'octavo', 'chords', 'music_lyrics', 'mp3', 'pdf', 'music') NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_url TEXT NOT NULL,
    file_size BIGINT,
    price DECIMAL(10,2) DEFAULT 7.50,
    
    -- Composer ID
    composer_id INT,
    
    -- Complete Music Publication Snapshot
    composition_title VARCHAR(255),
    composition_title_1 VARCHAR(255),
    composition_description TEXT,
    composer_firstname VARCHAR(100),
    composer_lastname VARCHAR(100),
    
    -- Collection Information
    is_part_of_collection BOOLEAN DEFAULT FALSE,
    collection_id INT NULL,
    collection_name VARCHAR(255),
    
    -- Music Details
    vocal_parts JSON,
    instrumentation JSON,
    types_of_music VARCHAR(100),
    
    -- OneLicense Information
    first_line_of_composition TEXT,
    composition_copyrights JSON,
    song_type ENUM('music', 'words_and_music') DEFAULT 'music',
    meter VARCHAR(50),
    season VARCHAR(100),
    psalm_number VARCHAR(50),
    liturgicalText LONGTEXT,
    verseStyle LONGTEXT,
    feast LONGTEXT,
    
    -- Copyright Details
    text_copyright_notice TEXT,
    tune_copyright_notice TEXT,
    
    -- Artist Details
    artists JSON,
    
    -- All Music Files (from original publication)
    music_files JSON,
    music_video_link VARCHAR(500),
    artwork_file_url VARCHAR(500),
    artwork_file_size BIGINT,
    
    -- General Details
    tune VARCHAR(255),
    general_details TEXT,
    country_restrictions TEXT,
    
    -- Usage Permissions
    is_public_domain BOOLEAN DEFAULT FALSE,
    can_be_reprinted BOOLEAN DEFAULT FALSE,
    can_be_podcast_streamed BOOLEAN DEFAULT FALSE,
    can_make_commercial_recording BOOLEAN DEFAULT FALSE,
    can_make_non_commercial_recording BOOLEAN DEFAULT FALSE,
    
    -- Purchase Details
    purchase_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    download_count INT DEFAULT 0,
    last_downloaded TIMESTAMP NULL,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Indexes
    INDEX idx_user_id (user_id),
    INDEX idx_music_publication_id (music_publication_id),
    INDEX idx_file_type (file_type),
    INDEX idx_purchase_date (purchase_date),
    INDEX idx_composer_name (composer_firstname, composer_lastname),
    UNIQUE KEY unique_user_music_file (user_id, music_publication_id, file_type),
    
    -- Foreign Keys
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (music_publication_id) REFERENCES music_publications(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`;

  try {
    await mysqlConnection.execute('SELECT 1 FROM user_music_library LIMIT 1');
    await ensureTableColumns(mysqlConnection, 'user_music_library', [{ name: 'file_type', alter: "MODIFY COLUMN file_type VARCHAR(50) NOT NULL DEFAULT 'unknown'", action: 'modify' }]);
    await mysqlConnection.execute(`ALTER TABLE user_music_library
    ADD UNIQUE KEY uniq_user_music (user_id, music_publication_id);    
    `)
    console.log('✅ User music library table already exists');
  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ User music library table created');
  }
};

// ============================================
// TABLE 17: USER MUSIC CART
// ============================================
const createUserMusicCartTable = async () => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS user_music_cart (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      music_publication_id INT NOT NULL,
      file_data JSON NOT NULL,
      price DECIMAL(10,2) NOT NULL,
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_user_id (user_id),
      INDEX idx_music_publication_id (music_publication_id),
      INDEX idx_added_at (added_at),
      UNIQUE KEY unique_user_cart_item (user_id, music_publication_id),
      
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (music_publication_id) REFERENCES music_publications(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM user_music_cart LIMIT 1');
    console.log('✅ User music cart table already exists');
  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ User music cart table created');
  }
};

// ============================================
// TABLE 18: USER ORDERS
// ============================================
const createUserOrdersTable = async () => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS user_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      total_amount DECIMAL(10,2) NOT NULL,
      payment_status ENUM('pending', 'completed', 'failed', 'refunded') DEFAULT 'pending',
      payment_method ENUM('stripe', 'free', 'bank_transfer', 'cash') DEFAULT 'stripe',
      order_status ENUM('pending', 'completed', 'cancelled', 'refunded') DEFAULT 'pending',
      stripe_session_id VARCHAR(255) NULL,
      stripe_payment_intent_id VARCHAR(255) NULL,
      notes TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_user_id (user_id),
      INDEX idx_payment_status (payment_status),
      INDEX idx_order_status (order_status),
      INDEX idx_stripe_session_id (stripe_session_id),
      INDEX idx_created_at (created_at),
      
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM user_orders LIMIT 1');
    console.log('✅ User orders table already exists');
  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ User orders table created');
  }
};

// ============================================
// TABLE 19: COMMUNITY MUSIC LIBRARY
// ============================================
const createCommunityMusicLibraryTable = async () => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS community_music_library (
      id INT AUTO_INCREMENT PRIMARY KEY,
      
      -- Community/Organization Identification
      parent_user_id INT NOT NULL COMMENT 'The diocese plan admin who owns this community',
      
      -- Music Source Type
      is_sl_music BOOLEAN DEFAULT TRUE COMMENT 'TRUE = from SL database, FALSE = Non-SL music',
      music_publication_id INT NULL COMMENT 'Reference to music_publications if is_sl_music = TRUE',
      
      -- Basic Information (for both SL and Non-SL)
      music_title VARCHAR(255) NOT NULL,
      composer_name VARCHAR(255) NOT NULL,
      category VARCHAR(100) NULL,
      year VARCHAR(10) NULL,
      tags JSON NULL,
      notes TEXT NULL,
      
      -- Non-SL Music Specific Fields
      pdf_files JSON NULL COMMENT 'Array of PDF file objects {url, size, name}',
      mp3_files JSON NULL COMMENT 'Array of MP3 file objects {url, size, name}',
      image_files JSON NULL COMMENT 'Array of image file objects {url, size, name}',
      
      -- SL Music Snapshot (copied from music_publications)
      composition_title VARCHAR(255) NULL,
      composition_title_1 VARCHAR(255) NULL,
      composition_description TEXT NULL,
      composer_firstname VARCHAR(100) NULL,
      composer_lastname VARCHAR(100) NULL,
      composer_id INT NULL,
      vocal_parts JSON NULL,
      instrumentation JSON NULL,
      types_of_music VARCHAR(100) NULL,
      first_line_of_composition TEXT NULL,
      composition_copyrights JSON NULL,
      song_type ENUM('music', 'words_and_music') DEFAULT 'music',
      meter VARCHAR(50) NULL,
      season VARCHAR(100) NULL,
      psalm_number VARCHAR(50) NULL,
      music_files JSON NULL,
      music_video_link VARCHAR(500) NULL,
      artwork_file_url VARCHAR(500) NULL,
      artwork_file_size BIGINT NULL,
      price DECIMAL(10,2) NULL,
      is_free BOOLEAN DEFAULT FALSE,
      tune VARCHAR(255) NULL,
      general_details TEXT NULL,
      
      -- Added By Information
      added_by_user_id INT NOT NULL COMMENT 'User who added this music to the library',
      
      -- Timestamps
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      deleted_at TIMESTAMP NULL,
      
      -- Indexes
      INDEX idx_parent_user_id (parent_user_id),
      INDEX idx_music_publication_id (music_publication_id),
      INDEX idx_is_sl_music (is_sl_music),
      INDEX idx_music_title (music_title),
      INDEX idx_composer_name (composer_name),
      INDEX idx_category (category),
      INDEX idx_added_by (added_by_user_id),
      INDEX idx_created_at (created_at),
      
      -- Foreign Keys
      FOREIGN KEY (parent_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (music_publication_id) REFERENCES music_publications(id) ON DELETE SET NULL,
      FOREIGN KEY (added_by_user_id) REFERENCES users(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM community_music_library LIMIT 1');
    console.log('✅ Community music library table already exists');
  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ Community music library table created');
  }
};

// ============================================
// PERMISSION MANAGEMENT TABLES
// ============================================
const createPermissionTables = async () => {
  console.log('🔧 Initializing permission management tables...');

  // TABLE 19: PLANS
  const createPlansTable = `
    CREATE TABLE IF NOT EXISTS plans (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      slug VARCHAR(100) UNIQUE NOT NULL,
      description TEXT,
      price DECIMAL(10,2),
      billing_cycle ENUM('monthly', 'yearly', 'one-time', 'free') DEFAULT 'free',
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_slug (slug),
      INDEX idx_is_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  // TABLE 20: FEATURES
  const createFeaturesTable = `
    CREATE TABLE IF NOT EXISTS features (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      slug VARCHAR(100) UNIQUE NOT NULL,
      category VARCHAR(50) NOT NULL COMMENT 'SL Portals, SL Account, Team Dashboard',
      parent_id INT NULL,
      description TEXT,
      display_order INT DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_slug (slug),
      INDEX idx_category (category),
      INDEX idx_parent_id (parent_id),
      INDEX idx_is_active (is_active),
      
      FOREIGN KEY (parent_id) REFERENCES features(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  // TABLE 21: PERMISSION TYPES
  const createPermissionTypesTable = `
    CREATE TABLE IF NOT EXISTS permission_types (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(50) UNIQUE NOT NULL COMMENT 'x, -, 1-plan, view-only, unlimited, free-music-alacarte',
      label VARCHAR(100) NOT NULL,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      
      INDEX idx_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  // TABLE 22: PLAN FEATURES (MAIN MAPPING)
  const createPlanFeaturesTable = `
    CREATE TABLE IF NOT EXISTS plan_features (
      id INT AUTO_INCREMENT PRIMARY KEY,
      plan_id INT NOT NULL,
      feature_id INT NOT NULL,
      permission_type_id INT NOT NULL,
      custom_value VARCHAR(255) NULL COMMENT 'For special cases',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      UNIQUE KEY unique_plan_feature (plan_id, feature_id),
      INDEX idx_plan_id (plan_id),
      INDEX idx_feature_id (feature_id),
      INDEX idx_permission_type_id (permission_type_id),
      
      FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE,
      FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE CASCADE,
      FOREIGN KEY (permission_type_id) REFERENCES permission_types(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  // TABLE 23: FEATURE USAGE
  const createFeatureUsageTable = `
    CREATE TABLE IF NOT EXISTS feature_usage (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      feature_id INT NOT NULL,
      usage_count INT DEFAULT 0,
      last_used_at TIMESTAMP NULL,
      reset_at TIMESTAMP NULL COMMENT 'For monthly/yearly resets',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      UNIQUE KEY unique_user_feature (user_id, feature_id),
      INDEX idx_user_id (user_id),
      INDEX idx_feature_id (feature_id),
      
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  // TABLE 24: ROLES
  const createRolesTable = `
    CREATE TABLE IF NOT EXISTS roles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(50) UNIQUE NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      description TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_name (name),
      INDEX idx_is_active (is_active),
      
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  // TABLE 25: PERMISSIONS
  const createPermissionsTable = `
    CREATE TABLE IF NOT EXISTS permissions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(50) UNIQUE NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      description TEXT,
      category VARCHAR(50) DEFAULT 'general',
      is_active BOOLEAN DEFAULT TRUE,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_name (name),
      INDEX idx_category (category),
      INDEX idx_is_active (is_active),
      
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  // TABLE 26: ROLE PERMISSIONS
  const createRolePermissionsTable = `
    CREATE TABLE IF NOT EXISTS role_permissions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      role_name VARCHAR(100) NOT NULL,
      slug VARCHAR(100) NOT NULL UNIQUE,
      permissions JSON NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      
      INDEX idx_role_name (role_name),
      INDEX idx_slug (slug)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  // TABLE 27: USER PERMISSIONS
  const createUserPermissionsTable = `
    CREATE TABLE IF NOT EXISTS user_permissions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      permission_id INT NOT NULL,
      granted_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      
      UNIQUE KEY unique_user_permission (user_id, permission_id),
      INDEX idx_user_id (user_id),
      INDEX idx_permission_id (permission_id),
      INDEX idx_granted_by (granted_by),
      
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE,
      FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  try {
    await mysqlConnection.execute(createPlansTable);
    await mysqlConnection.execute(createFeaturesTable);
    await mysqlConnection.execute(createPermissionTypesTable);
    await mysqlConnection.execute(createPlanFeaturesTable);
    await mysqlConnection.execute(createFeatureUsageTable);
    await mysqlConnection.execute(createRolesTable);
    await mysqlConnection.execute(createPermissionsTable);
    await mysqlConnection.execute(createRolePermissionsTable);
    await mysqlConnection.execute(createUserPermissionsTable);
    console.log('✅ Permission management tables created');
  } catch (error) {
    console.error('❌ Failed to create permission tables:', error);
    throw error;
  }
};

// ============================================
// PAYMENT MANAGEMENT TABLES
// ============================================
const createPaymentTables = async () => {
  console.log('🔧 Initializing payment management tables...');

  // TABLE 28: PAYMENT CUSTOMERS
  const createPaymentCustomersTable = `
    CREATE TABLE IF NOT EXISTS payment_customers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL UNIQUE,
      stripe_customer_id VARCHAR(255) UNIQUE NOT NULL,
      email VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      phone VARCHAR(50),
      address JSON,
      metadata JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_user_id (user_id),
      INDEX idx_stripe_customer_id (stripe_customer_id),
      
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  // TABLE 29: PAYMENT TRANSACTIONS
  const createPaymentTransactionsTable = `
    CREATE TABLE IF NOT EXISTS payment_transactions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      plan_id INT NULL,
      stripe_session_id VARCHAR(255) NULL,
      stripe_payment_intent_id VARCHAR(255) NULL,
      stripe_customer_id VARCHAR(255) NULL,
      stripe_invoice_id VARCHAR(255) NULL,
      stripe_subscription_id VARCHAR(255) NULL,
      amount DECIMAL(10,2) NOT NULL,
      currency VARCHAR(10) DEFAULT 'usd',
      status ENUM('pending', 'completed', 'failed', 'refunded', 'cancelled') DEFAULT 'pending',
      payment_method VARCHAR(50) NULL,
      payment_method_types JSON NULL,
      card_brand VARCHAR(50) NULL,
      card_last4 VARCHAR(4) NULL,
      bank_name VARCHAR(100) NULL,
      billing_name VARCHAR(255) NULL,
      billing_email VARCHAR(255) NULL,
      billing_phone VARCHAR(50) NULL,
      billing_address JSON NULL,
      description TEXT NULL,
      receipt_url VARCHAR(500) NULL,
      invoice_pdf VARCHAR(500) NULL,
      failure_message TEXT NULL,
      refund_reason TEXT NULL,
      completed_at TIMESTAMP NULL,
      refunded_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_user_id (user_id),
      INDEX idx_plan_id (plan_id),
      INDEX idx_stripe_session_id (stripe_session_id),
      INDEX idx_stripe_payment_intent_id (stripe_payment_intent_id),
      INDEX idx_stripe_customer_id (stripe_customer_id),
      INDEX idx_status (status),
      INDEX idx_created_at (created_at),
      
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  // TABLE 30: STRIPE SUBSCRIPTIONS
  const createStripeSubscriptionsTable = `
    CREATE TABLE IF NOT EXISTS stripe_subscriptions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      stripe_subscription_id VARCHAR(255) UNIQUE NOT NULL,
      stripe_customer_id VARCHAR(255) NOT NULL,
      stripe_price_id VARCHAR(255) NULL,
      status ENUM('active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete') DEFAULT 'active',
      current_period_start TIMESTAMP NULL,
      current_period_end TIMESTAMP NULL,
      cancel_at_period_end BOOLEAN DEFAULT FALSE,
      canceled_at TIMESTAMP NULL,
      ended_at TIMESTAMP NULL,
      trial_start TIMESTAMP NULL,
      trial_end TIMESTAMP NULL,
      metadata JSON NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_user_id (user_id),
      INDEX idx_stripe_subscription_id (stripe_subscription_id),
      INDEX idx_stripe_customer_id (stripe_customer_id),
      INDEX idx_status (status),
      
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  // TABLE 31: STRIPE PRODUCTS
  const createStripeProductsTable = `
    CREATE TABLE IF NOT EXISTS stripe_products (
      id INT AUTO_INCREMENT PRIMARY KEY,
      plan_id INT NOT NULL,
      stripe_product_id VARCHAR(255) UNIQUE NOT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT NULL,
      active BOOLEAN DEFAULT TRUE,
      metadata JSON NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_plan_id (plan_id),
      INDEX idx_stripe_product_id (stripe_product_id),
      
      FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  // TABLE 32: STRIPE PRICES
  const createStripePricesTable = `
    CREATE TABLE IF NOT EXISTS stripe_prices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      plan_id INT NOT NULL,
      stripe_price_id VARCHAR(255) UNIQUE NOT NULL,
      stripe_product_id VARCHAR(255) NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      currency VARCHAR(10) DEFAULT 'usd',
      recurring_interval ENUM('month', 'year') NULL,
      active BOOLEAN DEFAULT TRUE,
      metadata JSON NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_plan_id (plan_id),
      INDEX idx_stripe_price_id (stripe_price_id),
      INDEX idx_stripe_product_id (stripe_product_id),
      
      FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  // TABLE 33: PAYMENT METHODS
  const createPaymentMethodsTable = `
    CREATE TABLE IF NOT EXISTS payment_methods (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      stripe_payment_method_id VARCHAR(255) UNIQUE NOT NULL,
      stripe_customer_id VARCHAR(255) NOT NULL,
      type ENUM('card', 'us_bank_account', 'link', 'other') NOT NULL,
      card_brand VARCHAR(50) NULL,
      card_last4 VARCHAR(4) NULL,
      card_exp_month INT NULL,
      card_exp_year INT NULL,
      bank_name VARCHAR(100) NULL,
      bank_last4 VARCHAR(4) NULL,
      bank_account_type VARCHAR(50) NULL,
      billing_name VARCHAR(255) NULL,
      billing_email VARCHAR(255) NULL,
      billing_phone VARCHAR(50) NULL,
      billing_address JSON NULL,
      is_default BOOLEAN DEFAULT FALSE,
      is_verified BOOLEAN DEFAULT FALSE,
      metadata JSON NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_user_id (user_id),
      INDEX idx_stripe_payment_method_id (stripe_payment_method_id),
      INDEX idx_stripe_customer_id (stripe_customer_id),
      INDEX idx_is_default (is_default),
      
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  // TABLE 34: INVOICES
  const createInvoicesTable = `
    CREATE TABLE IF NOT EXISTS invoices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      transaction_id INT NULL,
      stripe_invoice_id VARCHAR(255) UNIQUE NOT NULL,
      stripe_subscription_id VARCHAR(255) NULL,
      stripe_customer_id VARCHAR(255) NOT NULL,
      invoice_number VARCHAR(100) NULL,
      amount_due DECIMAL(10,2) NOT NULL,
      amount_paid DECIMAL(10,2) DEFAULT 0,
      amount_remaining DECIMAL(10,2) DEFAULT 0,
      currency VARCHAR(10) DEFAULT 'usd',
      status ENUM('draft', 'open', 'paid', 'void', 'uncollectible') DEFAULT 'open',
      period_start TIMESTAMP NULL,
      period_end TIMESTAMP NULL,
      due_date TIMESTAMP NULL,
      paid_at TIMESTAMP NULL,
      invoice_pdf VARCHAR(500) NULL,
      hosted_invoice_url VARCHAR(500) NULL,
      description TEXT NULL,
      metadata JSON NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_user_id (user_id),
      INDEX idx_transaction_id (transaction_id),
      INDEX idx_stripe_invoice_id (stripe_invoice_id),
      INDEX idx_status (status),
      INDEX idx_paid_at (paid_at),
      
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (transaction_id) REFERENCES payment_transactions(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  // TABLE 35: REFUNDS
  const createRefundsTable = `
    CREATE TABLE IF NOT EXISTS refunds (
      id INT AUTO_INCREMENT PRIMARY KEY,
      transaction_id INT NOT NULL,
      user_id INT NOT NULL,
      stripe_refund_id VARCHAR(255) UNIQUE NOT NULL,
      stripe_payment_intent_id VARCHAR(255) NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      currency VARCHAR(10) DEFAULT 'usd',
      reason ENUM('duplicate', 'fraudulent', 'requested_by_customer', 'other') NULL,
      status ENUM('pending', 'succeeded', 'failed', 'cancelled') DEFAULT 'pending',
      description TEXT NULL,
      metadata JSON NULL,
      refunded_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_transaction_id (transaction_id),
      INDEX idx_user_id (user_id),
      INDEX idx_stripe_refund_id (stripe_refund_id),
      INDEX idx_status (status),
      
      FOREIGN KEY (transaction_id) REFERENCES payment_transactions(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  // TABLE 36: WEBHOOK LOGS
  const createWebhookLogsTable = `
    CREATE TABLE IF NOT EXISTS webhook_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      event_id VARCHAR(255) UNIQUE NOT NULL,
      event_type VARCHAR(100) NOT NULL,
      processed BOOLEAN DEFAULT FALSE,
      error_message TEXT NULL,
      payload JSON NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      
      INDEX idx_event_id (event_id),
      INDEX idx_event_type (event_type),
      INDEX idx_processed (processed),
      INDEX idx_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  // TABLE 37: PAYMENT ANALYTICS
  const createPaymentAnalyticsTable = `
    CREATE TABLE IF NOT EXISTS payment_analytics (
      id INT AUTO_INCREMENT PRIMARY KEY,
      date DATE NOT NULL,
      total_transactions INT DEFAULT 0,
      successful_payments INT DEFAULT 0,
      failed_payments INT DEFAULT 0,
      refunded_payments INT DEFAULT 0,
      total_revenue DECIMAL(12,2) DEFAULT 0,
      card_revenue DECIMAL(12,2) DEFAULT 0,
      bank_revenue DECIMAL(12,2) DEFAULT 0,
      revenue_by_plan JSON NULL,
      new_subscriptions INT DEFAULT 0,
      cancelled_subscriptions INT DEFAULT 0,
      active_subscriptions INT DEFAULT 0,
      metadata JSON NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      UNIQUE KEY unique_date (date),
      INDEX idx_date (date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  // TABLE 38: USER PAYMENT METHODS (Card Details)
  const createUserPaymentMethodsTable = `
    CREATE TABLE IF NOT EXISTS user_payment_methods (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      card_holder_name VARCHAR(150) NOT NULL,
      card_last4 VARCHAR(4) NOT NULL,
      card_brand VARCHAR(50) NULL,
      expiry_month INT NOT NULL,
      expiry_year INT NOT NULL,
      billing_address VARCHAR(255) NULL,
      is_default TINYINT(1) DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      deleted_at DATETIME NULL,
      INDEX idx_user_id (user_id),
      INDEX idx_is_default (is_default),
      INDEX idx_deleted_at (deleted_at),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;
  const createUserSubscriptionsTable = `
  -- TABLE: SUBSCRIPTIONS
  CREATE TABLE IF NOT EXISTS subscriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    subscription_name VARCHAR(255) NULL,
    plan_id INT NULL,
    payment_transaction_id INT NULL,
    payment_id VARCHAR(255) NULL,
    payment_type ENUM('stripe','cash','online','cheque') DEFAULT 'stripe',
    status ENUM('pending','active','trialing','past_due','canceled','expired') DEFAULT 'pending',
    start_date TIMESTAMP NULL,
    end_date TIMESTAMP NULL,
    cancel_at_period_end BOOLEAN DEFAULT FALSE,
    canceled_at TIMESTAMP NULL,
    metadata JSON NULL,
    check_no VARCHAR(100) NULL,
    card_no VARCHAR(50) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_user_id (user_id),
    INDEX idx_plan_id (plan_id),
    INDEX idx_payment_transaction_id (payment_transaction_id),
    INDEX idx_payment_id (payment_id),
    INDEX idx_status (status),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE SET NULL,
    FOREIGN KEY (payment_transaction_id) REFERENCES payment_transactions(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;


  try {
    await mysqlConnection.execute(createPaymentCustomersTable);
    await mysqlConnection.execute(createPaymentTransactionsTable);
    await mysqlConnection.execute(createStripeSubscriptionsTable);
    await mysqlConnection.execute(createStripeProductsTable);
    await mysqlConnection.execute(createStripePricesTable);
    await mysqlConnection.execute(createPaymentMethodsTable);
    await mysqlConnection.execute(createInvoicesTable);
    await mysqlConnection.execute(createRefundsTable);
    await mysqlConnection.execute(createWebhookLogsTable);
    await mysqlConnection.execute(createPaymentAnalyticsTable);
    await mysqlConnection.execute(createUserPaymentMethodsTable);
    await mysqlConnection.execute(createUserSubscriptionsTable);
    // To Update Table
    await ensureTableColumns(mysqlConnection, 'subscriptions', [{ name: 'payment_status', alter: `ADD COLUMN payment_status ENUM('pending','completed','failed','refunded','cancelled') AFTER status` }]);
    // 🔥 ENSURE MISSING COLUMNS
    await ensureTableColumns(mysqlConnection, 'payment_transactions', [
      {
        name: 'related_user_id',
        alter: 'ADD COLUMN related_user_id INT NULL AFTER user_id'
      },
      {
        name: 'payment_method',
        alter: 'ADD COLUMN payment_method VARCHAR(50) NULL AFTER status'
      }
    ]);

    console.log('✅ Payment management tables created');
  } catch (error) {
    console.error('❌ Failed to create payment tables:', error);
    throw error;
  }
};

// ============================================
// TABLE 38: MUSIC TRANSACTIONS
// ============================================
const createMusicTransactionsTable = async () => {
  const createTableSQL = `CREATE TABLE music_transactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    stripe_session_id VARCHAR(255) UNIQUE,
    stripe_customer_id VARCHAR(255),
    stripe_payment_intent_id VARCHAR(255),
    total_amount DECIMAL(10,2),
    currency VARCHAR(10) DEFAULT 'usd',
    status ENUM('pending','completed','failed','refunded') DEFAULT 'pending',
    payment_method VARCHAR(50),
    products_json JSON,
    coupon_code VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,
    updated_at TIMESTAMP NULL,
    INDEX idx_user(user_id),
    INDEX idx_session(stripe_session_id)
    );`;

  try {
    await mysqlConnection.execute('SELECT 1 FROM music_transactions LIMIT 1');
    console.log('✅ Music transactions table already exists');
  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ Music transactions table created');
  }
};

// ============================================
// TABLE 39: COMPOSER TOOLS
// ============================================
const createComposerToolsTable = async () => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS composer_tools (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tool_name VARCHAR(255) NOT NULL,
      tool_content TEXT NOT NULL,
      tool_type VARCHAR(100) DEFAULT 'general',
      is_active BOOLEAN DEFAULT TRUE,
      display_order INT DEFAULT 0,
      created_by INT DEFAULT 1,
      updated_by INT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      
      INDEX idx_tool_type (tool_type),
      INDEX idx_is_active (is_active),
      INDEX idx_display_order (display_order),
      INDEX idx_created_by (created_by),
      INDEX idx_updated_by (updated_by)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM composer_tools LIMIT 1');
    console.log('✅ Composer tools table already exists');
  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ Composer tools table created');
  }
};

// ============================================
// TABLE 40: Agrement MANAGEMENT
// ============================================
const createAgreementManagementTable = async () => {

  /* ======================================================
     SAVED AGREEMENTS TABLE
  ====================================================== */
  const createTableSavedAgreementsSQL = `
    CREATE TABLE IF NOT EXISTS saved_agreements (
      id INT AUTO_INCREMENT PRIMARY KEY,
      agreement_title VARCHAR(255) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      file_path VARCHAR(500) DEFAULT NULL,
      agreement_type ENUM('Signature', 'T&C') NOT NULL,
      agreement_format VARCHAR(10) DEFAULT NULL
        COMMENT 'html or pdf',
      status TINYINT(1) DEFAULT 1,
      signature_position JSON DEFAULT NULL
        COMMENT 'Stores signature box position: {x, y, page, width, height}',
      uploaded_on DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  try {
    // ✅ CORRECT TABLE CHECK
    await mysqlConnection.execute('SELECT 1 FROM saved_agreements LIMIT 1');
    await ensureTableColumns(mysqlConnection, 'saved_agreements', [
      {
        name: 'agreement_format',
        alter: `ADD COLUMN agreement_format VARCHAR(10) DEFAULT NULL COMMENT 'html or pdf'`,
        action: 'add'
      },
      {
        name: 'description',
        alter: `ADD COLUMN description TEXT DEFAULT NULL COMMENT 'Agreement description / content'`,
        action: 'add'
      }
    ]);
    console.log('✅ saved_agreements management table already exists');
  } catch (error) {
    await mysqlConnection.execute(createTableSavedAgreementsSQL);
    console.log('✅ saved_agreements management table created');
  }

  /* ======================================================
     AGREEMENTS TABLE (FINAL – MULTI USER SUPPORTED)
  ====================================================== */

  const createTableAgreementsSQL = `
  CREATE TABLE IF NOT EXISTS agreements (
    id INT AUTO_INCREMENT PRIMARY KEY,
    agreement_title VARCHAR(255) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_path VARCHAR(500) DEFAULT NULL,
    agreement_type ENUM('Signature', 'T&C') NOT NULL,
    badges JSON DEFAULT NULL COMMENT '["Composer","Educator"]',
    -- 👥 MULTIPLE USERS SUPPORT
    user_ids JSON DEFAULT NULL COMMENT '[1,2,3]',
    -- ✍️ SIGNATURE DATA
    signature_position JSON DEFAULT NULL
      COMMENT '{x,y,page,width,height}',
    description JSON DEFAULT NULL
      COMMENT 'Agreement description / content',
    agreement_format VARCHAR(10) DEFAULT NULL
      COMMENT 'html or pdf',
    savedAgreementID INT DEFAULT NULL
      COMMENT 'Reference to saved_agreements.id',
    status TINYINT(1) DEFAULT 1
      COMMENT '1 = active, 0 = inactive',
    uploaded_on DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`;


  try {
    await mysqlConnection.execute('SELECT 1 FROM agreements LIMIT 1');
    await ensureTableColumns(mysqlConnection, 'agreements', [
      {
        name: 'applies_to_diocesan',
        alter: `ADD COLUMN applies_to_diocesan BOOLEAN DEFAULT FALSE COMMENT 'If true → applies to ALL diocesan users'`,
        action: 'add'
      },
      {
        name: 'agreement_format',
        alter: `ADD COLUMN agreement_format VARCHAR(10) DEFAULT NULL COMMENT 'html or pdf'`,
        action: 'add'
      }
    ]);
    console.log('✅ Agreement management table already exists');

  } catch (error) {
    await mysqlConnection.execute(createTableAgreementsSQL);
    console.log('✅ Agreement management table created');
  }

  /* ======================================================
     USER SIGNATURES TABLE
  ====================================================== */
  const createUserSignaturesTableSQL = `
    CREATE TABLE IF NOT EXISTS user_signatures (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      signature_file_name VARCHAR(255) NOT NULL,
      signature_file_url VARCHAR(500) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      deleted_at DATETIME NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM user_signatures LIMIT 1');
    console.log('✅ user_signatures table already exists');
  } catch (error) {
    await mysqlConnection.execute(createUserSignaturesTableSQL);
    console.log('✅ user_signatures table created');
  }

  /* ======================================================
     USER SIGNATURE DOCUMENTS TABLE
  ====================================================== */
  const createUserSignaturesDocumentsTableSQL = `
    CREATE TABLE IF NOT EXISTS user_signatures_documents (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      document_id INT NOT NULL,
      status ENUM('signed', 'pending', 'reject') DEFAULT 'pending',
      signature_file_name VARCHAR(255) NOT NULL,
      signature_file_url VARCHAR(500) NOT NULL,
      badge VARCHAR(255) NULL,
      history JSON NULL,
      admin_comment TEXT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      deleted_at DATETIME NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (document_id) REFERENCES agreements(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM user_signatures_documents LIMIT 1');
    console.log('✅ user_signatures_documents table already exists');
  } catch (error) {
    await mysqlConnection.execute(createUserSignaturesDocumentsTableSQL);
    console.log('✅ user_signatures_documents table created');
  }
};

// ============================================
// TABLE 41: Notification MANAGEMENT
// ============================================
const createNotficationManagementTable = async () => {
  const createNotification = `
    CREATE TABLE IF NOT EXISTS notifications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      body TEXT NULL,
      metadata JSON NULL,           -- arbitrary payload (link, type, extra)
      channel ENUM('inbox','email','push') DEFAULT 'inbox',
      created_by INT NULL,          -- admin / system user who created it
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expire_at TIMESTAMP NULL,
      is_active BOOLEAN DEFAULT TRUE,
      target_type ENUM('all','by_badge','by_role','by_user_type','custom') DEFAULT 'all'
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;

  const createUserNotification = `
    CREATE TABLE IF NOT EXISTS user_notifications (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      notification_id INT NOT NULL,
      user_id INT NOT NULL,
      is_read BOOLEAN DEFAULT FALSE,
      read_at TIMESTAMP NULL,
      delivered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user_id (user_id),
      INDEX idx_notification_id (notification_id),
      UNIQUE KEY uq_notification_user (notification_id, user_id),
      FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM notifications LIMIT 1');
    await mysqlConnection.execute('SELECT 1 FROM user_notifications LIMIT 1');
    console.log('✅ Notification management table already exists');
    console.log('✅ User Notification management table already exists');
  } catch (error) {
    await mysqlConnection.execute(createNotification);
    await mysqlConnection.execute(createUserNotification);

    console.log('✅ Notification management table created');
    console.log('✅ User Notification management table created');

  }
};

// ============================================
// TABLE 42: PLANNER (FIXED)
// ============================================
const createPlannerTables = async () => {

  const createPlannersTableSQL = `
   CREATE TABLE IF NOT EXISTS planners (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    community_id INT NOT NULL,
    service_date DATE NOT NULL,
    service_type VARCHAR(100) NOT NULL,
    service_title VARCHAR(255) NOT NULL,
    service_subtitle VARCHAR(255) NULL,
    template_id BIGINT UNSIGNED NULL,
    template_data JSON NULL,
    status ENUM('draft','upcoming','completed','cancelled') DEFAULT 'upcoming',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id),
    INDEX idx_community_id (community_id),
    INDEX idx_service_date (service_date),
    INDEX idx_status (status),
    CONSTRAINT fk_planner_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_planner_community_user FOREIGN KEY (community_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  const createPlannerServiceTimesSQL = `
    CREATE TABLE IF NOT EXISTS planner_service_times (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      planner_id BIGINT UNSIGNED NOT NULL,
      service_time TIME NOT NULL,
      meridiem ENUM('AM','PM') NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_planner_id (planner_id),
      CONSTRAINT fk_service_time_planner FOREIGN KEY (planner_id) REFERENCES planners(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  const createPlannerTemplatesTableSQL = `
    CREATE TABLE IF NOT EXISTS planner_templates (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      template_name VARCHAR(255) NOT NULL,
      template_description TEXT NULL,
      template_data JSON NOT NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_created_by (created_by),
      CONSTRAINT fk_template_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  const createPlannersMinistryTableSQL = `
    CREATE TABLE IF NOT EXISTS planner_ministers (
      id INT AUTO_INCREMENT PRIMARY KEY,

      -- Personal Info
      person_name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NULL,
      phone VARCHAR(20) NULL,
      gender ENUM('male', 'female', 'other') NULL,
      marital_status ENUM('single', 'married', 'divorced', 'widowed') NULL,

      -- Ministry Info
      instruments JSON NULL,
      vocal_parts JSON NULL,
      user_type ENUM('Member', 'Manager') DEFAULT 'Member',
      status ENUM('invited', 'active', 'inactive') DEFAULT 'invited',

      -- Parent User (Church / Organization Owner)
      parent_user_id INT NOT NULL,

      -- Login Mapping
      has_login_credentials BOOLEAN DEFAULT FALSE,
      linked_user_id INT NULL,
      credentials_created_at TIMESTAMP NULL,

      -- Timestamps
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      deleted_at TIMESTAMP NULL,

      -- Indexes
      INDEX idx_parent_user (parent_user_id),
      INDEX idx_linked_user (linked_user_id),

      -- Foreign Keys
      FOREIGN KEY (parent_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (linked_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;

  const createPlannerGroupsTableSQL = `
    CREATE TABLE IF NOT EXISTS planner_groups (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      parent_user_id INT NOT NULL,
      group_name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_parent_user_id (parent_user_id),
      UNIQUE KEY uniq_parent_group_name (parent_user_id, group_name),
      CONSTRAINT fk_planner_groups_parent_user FOREIGN KEY (parent_user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  const createPlannerGroupMembersTableSQL = `
   CREATE TABLE IF NOT EXISTS planner_group_members (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    group_id BIGINT UNSIGNED NOT NULL,
    parent_user_id INT NOT NULL,
    -- 🔑 ONLY MINISTERS CAN BE ADDED
    minister_id INT NOT NULL,
    -- Cached minister data
    person_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NULL,
    phone VARCHAR(20) NULL,
    instrument VARCHAR(150) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_group_id (group_id),
    INDEX idx_parent_user_id (parent_user_id),
    INDEX idx_minister_id (minister_id),
    -- Prevent same minister twice in same group
    UNIQUE KEY uniq_group_minister (group_id, minister_id),
    CONSTRAINT fk_group_members_group FOREIGN KEY (group_id) REFERENCES planner_groups(id) ON DELETE CASCADE,
    CONSTRAINT fk_group_members_parent_user FOREIGN KEY (parent_user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_group_members_minister FOREIGN KEY (minister_id) REFERENCES planner_ministers(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  const createMassSheduleTableSQL = `
  CREATE TABLE IF NOT EXISTS mass_schedule (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    parent_user_id INT NOT NULL,
    mass_name VARCHAR(255) NOT NULL,
    mass_date DATE NOT NULL,
    mass_day ENUM('Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday') NOT NULL,
    mass_entities JSON NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  );
`;

  try {
    await mysqlConnection.execute(createPlannersTableSQL);
    await ensureTableColumns(mysqlConnection, 'planners', [
      { name: 'service_times', alter: 'ADD COLUMN service_times JSON' },
      { name: 'custom_settings', alter: 'ADD COLUMN custom_settings JSON' },
      { name: 'vigil', alter: 'ADD COLUMN vigil BOOLEAN DEFAULT FALSE' },
      { name: 'service_date', alter: 'MODIFY COLUMN service_date VARCHAR(100) NOT NULL', action: 'modify' }
    ]);
    // await ensureTableColumns(mysqlConnection, 'mass_schedule', [
    //   { name: "mass_type", alter: 'ADD COLUMN mass_type ENUM(\'Weekday\', \'Sunday\') DEFAULT \'Weekday\' AFTER mass_day' }
    // ])
    await mysqlConnection.execute(createPlannerServiceTimesSQL);
    await mysqlConnection.execute(createPlannerTemplatesTableSQL);
    await mysqlConnection.execute(createPlannersMinistryTableSQL);

    await mysqlConnection.execute(createPlannerGroupsTableSQL);
    await mysqlConnection.execute(createPlannerGroupMembersTableSQL);
    await mysqlConnection.execute(createMassSheduleTableSQL);
    // Seed default planner massparts if empty
    await seedPlannerMassparts();

    // Seed default planner mass templates and categories if empty
    await seedPlannerMassTemplates();


    console.log('✅ Planner tables created/ensured');

  } catch (error) {
    console.error('❌ Planner table creation failed:', error);
    throw error;
  }
};

// ============================================
// TABLE 43: USER ACTIVITY LOGS
// ============================================
const createUserActivityLogsTable = async () => {
  const createTableSQL = `CREATE TABLE IF NOT EXISTS user_activity_daily_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
  
    user_id INT NOT NULL,
    log_date DATE NOT NULL,
  
    device_info JSON NULL,
    ip_address VARCHAR(64) NULL,
  
    activities JSON NOT NULL,
  
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ON UPDATE CURRENT_TIMESTAMP,
  
    UNIQUE KEY uniq_user_day (user_id, log_date),
    INDEX idx_user_date (user_id, log_date),
  
    CONSTRAINT fk_activity_user
      FOREIGN KEY (user_id)
      REFERENCES users(id)
      ON DELETE CASCADE
  ) ENGINE=InnoDB;
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM user_activity_daily_logs LIMIT 1');
    await mysqlConnection.execute(`ALTER TABLE user_activity_daily_logs
    MODIFY user_id INT NULL;
    `).then(console.log("Alter is Done"))
    console.log('✅ User activity logs table already exists');
  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ User activity logs table created');
  }
};

// ============================================
// TABLE 44: COUPONS (UPDATED - VARCHAR subscription_id)
// ============================================
const createCouponsTable = async () => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS coupons (
      id INT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(50) NOT NULL,
      title VARCHAR(150) DEFAULT NULL,
      description TEXT DEFAULT NULL,
      -- Discount Logic
      discount_type ENUM('percentage','flat') NOT NULL,
      discount_value DECIMAL(10,2) NOT NULL,
      max_discount_amount DECIMAL(10,2) DEFAULT NULL,
      -- Coupon Purpose
      coupon_for ENUM('subscription','music') NOT NULL,
      -- Plan Mapping
      applicable_plan_id INT DEFAULT NULL,
      -- Usage Tracking
      user_id INT DEFAULT NULL,
      plan_id INT DEFAULT NULL,
      subscription_id VARCHAR(255) DEFAULT NULL
      COMMENT 'Stripe subscription ID or internal subscription ID',
      transaction_id INT DEFAULT NULL,
      discount_amount DECIMAL(10,2) DEFAULT NULL,
      -- Limits
      max_total_uses INT DEFAULT NULL,
      max_uses_per_user INT DEFAULT 1,
      -- Validity
      valid_from TIMESTAMP NULL DEFAULT NULL,
      valid_till TIMESTAMP NULL DEFAULT NULL,
      -- Status
      status ENUM('active','used','expired','inactive') DEFAULT 'active',
      used_at TIMESTAMP NULL DEFAULT NULL,
      -- Metadata
      metadata JSON DEFAULT NULL,
      -- Timestamps
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL
      DEFAULT CURRENT_TIMESTAMP
      ON UPDATE CURRENT_TIMESTAMP,
      -- Unique Constraint
      UNIQUE KEY unique_coupon_user (code, user_id),

      -- Indexes
      KEY idx_code (code),
      KEY idx_user_id (user_id),
      KEY idx_plan_id (plan_id),
      KEY idx_subscription_id (subscription_id),
      KEY idx_transaction_id (transaction_id),
      KEY idx_coupon_for (coupon_for),
      KEY idx_status (status),
      KEY idx_applicable_plan_id (applicable_plan_id),
      -- Foreign Keys
      CONSTRAINT coupons_ibfk_1
      FOREIGN KEY (user_id) REFERENCES users(id)
      ON DELETE CASCADE,
      CONSTRAINT coupons_ibfk_2
      FOREIGN KEY (plan_id) REFERENCES plans(id)
      ON DELETE SET NULL,
      CONSTRAINT coupons_ibfk_3
      FOREIGN KEY (transaction_id)
      REFERENCES payment_transactions(id)
      ON DELETE SET NULL,
      CONSTRAINT coupons_ibfk_4
      FOREIGN KEY (applicable_plan_id)
      REFERENCES plans(id)
      ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM coupons LIMIT 1');
    console.log('✅ Coupons table already exists');

  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ Coupons table created');
  }
};


// ============================================
// TABLE 45: LITURGICAL_EVENTS
// ============================================
const createLiturgicalEventsTable = async () => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS liturgical_events (
      id INT AUTO_INCREMENT PRIMARY KEY,

      -- Core Fields
      event_title VARCHAR(255) NOT NULL,
      calendar_date DATE NOT NULL,
      liturgical_year VARCHAR(50) NULL,
      season VARCHAR(100) NULL,
      rank VARCHAR(100) NULL,
      liturgical_color VARCHAR(50) NULL,
      lectionary_number VARCHAR(50) NULL,

      -- Readings
      first_reading TEXT NULL,
      first_reading_description TEXT NULL,
      responsorial_psalm TEXT NULL,
      responsorial_psalm_refrain TEXT NULL,
      second_reading TEXT NULL,
      second_reading_description TEXT NULL,
      gospel_acclamation TEXT NULL,
      gospel TEXT NULL,
      gospel_description TEXT NULL,

      -- External Link & Notes
      usccb_url VARCHAR(500) NULL,
      notes TEXT NULL,

      -- Metadata
      metadata JSON NULL,

      -- Timestamps
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

      -- Indexes
      INDEX idx_calendar_date (calendar_date),
      INDEX idx_liturgical_year (liturgical_year),
      INDEX idx_season (season),
      INDEX idx_liturgical_color (liturgical_color)
    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_unicode_ci;
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM liturgical_events LIMIT 1');
    await ensureTableColumns(mysqlConnection, 'liturgical_events', [{
      name: 'liturgical_songs',
      alter: 'ADD COLUMN liturgical_songs JSON NULL'
    }]);
    console.log('✅ Liturgical Events table already exists');

    // Optionally ensure some columns exist/alter if needed in future
  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ Liturgical Events table created');
  }
};

// ============================================
// TABLE 46: HYMNAL MUSIC LIBRARY (UPDATED)
// ============================================
const createHymnalMusicLibraryTable = async () => {

  const createHymnalCategoriesTable = `
    CREATE TABLE IF NOT EXISTS hymnal_categories (
      id INT NOT NULL AUTO_INCREMENT,
      user_id INT NOT NULL,
      category_name VARCHAR(150) NOT NULL,
      publisher VARCHAR(255) NOT NULL,
      edition_year INT NOT NULL,
      visibility ENUM('public','private') DEFAULT 'public',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_user_id (user_id),
      INDEX idx_category_name (category_name),
      CONSTRAINT fk_hymnal_category_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE  
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  const createHymnalMusicLibraryTableSQL = `
    CREATE TABLE hymnal_music_library (
      id INT NOT NULL AUTO_INCREMENT,
      user_id INT NOT NULL,    
      -- multi category support
      hymnal_category_id JSON NOT NULL,    
      hymn_title VARCHAR(255) NOT NULL,
      hymn_author VARCHAR(255) NOT NULL,    
      -- multiple hymn numbers object
      hymn_numbers JSON NOT NULL,    
      audio_preview_url TEXT NULL,
      hymnal_files JSON NULL,    
      hymnal_music_type VARCHAR(100),
      is_converted_to_my_music_library BOOLEAN DEFAULT FALSE,    
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,    
      PRIMARY KEY (id),
      INDEX idx_user_id (user_id),
      INDEX idx_hymn_title (hymn_title),    
      CONSTRAINT fk_hymnal_music_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;


  const createUserHymnalStoredFilesTableSQL = `
    CREATE TABLE IF NOT EXISTS user_hymnal_stored_files (
      id INT NOT NULL AUTO_INCREMENT,
      user_id INT NOT NULL,
      hymnal_category_folders JSON NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,    
      PRIMARY KEY (id),
      INDEX idx_user_id (user_id),    
      CONSTRAINT fk_user_hymnal_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE
    
    ) ENGINE=InnoDB;
  `;
  try {
    /* =====================================================
       CHECK TABLES EXIST
    ===================================================== */
    await mysqlConnection.execute('SELECT 1 FROM hymnal_categories LIMIT 1');
    await mysqlConnection.execute('SELECT 1 FROM hymnal_music_library LIMIT 1');
    await mysqlConnection.execute('SELECT 1 FROM user_hymnal_stored_files LIMIT 1');

    /* =====================================================
       ENSURE CATEGORY EXTRA COLUMN
    ===================================================== */
    await ensureTableColumns(mysqlConnection, 'hymnal_categories', [
      {
        name: 'hymanl_abbrevation',
        alter: 'ADD COLUMN hymanl_abbrevation VARCHAR(255)'
      },
    ]);
    await ensureTableColumns(mysqlConnection, 'hymnal_music_library', [
      // ✅ Core columns that may be missing in older DB instances
      { name: "hymnal_category_id", alter: 'ADD COLUMN hymnal_category_id JSON NOT NULL DEFAULT (JSON_ARRAY())' },
      { name: "hymn_author", alter: 'ADD COLUMN hymn_author VARCHAR(255) NULL' },
      { name: "hymn_numbers", alter: 'ADD COLUMN hymn_numbers JSON NOT NULL DEFAULT (JSON_OBJECT())' },
      { name: "audio_preview_url", alter: 'ADD COLUMN audio_preview_url TEXT NULL' },
      { name: "hymnal_files", alter: 'ADD COLUMN hymnal_files JSON NULL' },
      { name: "hymnal_music_type", alter: "ADD COLUMN hymnal_music_type VARCHAR(100) DEFAULT 'original'" },
      { name: "is_converted_to_my_music_library", alter: 'DROP COLUMN is_converted_to_my_music_library', action: 'drop' },
      // ✅ Extended columns
      { name: "hymnal_mi", alter: 'ADD COLUMN hymnal_mi VARCHAR(100) NULL' },
      { name: "hymnal_solo_instruments", alter: 'ADD COLUMN hymnal_solo_instruments JSON NULL' },
      { name: "hymnal_choral_settings", alter: 'ADD COLUMN hymnal_choral_settings JSON NULL' },
      { name: "hymnal_source_page", alter: 'ADD COLUMN hymnal_source_page VARCHAR(100) NULL' },
      { name: "added_to_users", alter: 'ADD COLUMN added_to_users JSON NULL' }
    ])


    console.log('✅ Hymnal Categories table already exists');
    console.log('✅ Hymnal Music Library table migrated to JSON safely');

  } catch (error) {
    /* =====================================================
       FIRST TIME CREATION
    ===================================================== */
    await mysqlConnection.execute(createHymnalCategoriesTable);
    await mysqlConnection.execute(createHymnalMusicLibraryTableSQL);
    await mysqlConnection.execute(createUserHymnalStoredFilesTableSQL);

    console.log('✅ Hymnal Categories table created');
    console.log('✅ Hymnal Music Library table created');
    console.log('✅ User Hymnal Stored Files table created');
  }
};


// ============================================
// TABLE 47: DIOCESES
// ============================================
const createDiocesesTable = async () => {
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS dioceses (
      id INT AUTO_INCREMENT PRIMARY KEY,

      -- Link to Users Table
      user_id INT NOT NULL UNIQUE,
      -- Diocese Core Info
      official_name VARCHAR(255) NOT NULL,
      slug VARCHAR(255) NOT NULL UNIQUE,
      primary_contact_name VARCHAR(150) NOT NULL,
      primary_contact_email VARCHAR(255) NOT NULL,
      primary_contact_phone VARCHAR(50) DEFAULT NULL,
      -- Organizational Scope
      total_parishes INT NOT NULL,
      total_schools INT DEFAULT 0,
      total_other_institutions INT DEFAULT 0,
      minimum_required_percentage DECIMAL(5,2) DEFAULT 20.00,
      -- Subscription Lifecycle (Diocese Service Level)
      subscription_start_date DATE NULL,
      subscription_end_date DATE NULL,
      renewal_date DATE NULL,
      grace_period_end_date DATE NULL,
      -- Contract Info
      contract_signed BOOLEAN DEFAULT FALSE,
      contract_signed_at TIMESTAMP NULL,
      -- Status Control
      status ENUM('pending_activation','active','pending_cancellation','expired', 'cancelled') DEFAULT 'pending_activation',
      cancellation_requested_at TIMESTAMP NULL,
      cancellation_reason TEXT NULL,
      created_by INT NOT NULL COMMENT 'Superadmin who created',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      -- Indexes
      INDEX idx_status (status),
      INDEX idx_slug (slug),
      INDEX idx_renewal_date (renewal_date),
      -- Foreign Keys
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM dioceses LIMIT 1');
    console.log('✅ Dioceses table already exists');
  } catch (error) {
    await mysqlConnection.execute(createTableSQL);
    console.log('✅ Dioceses table created');
  }
};

// ============================================
// TABLE 48: DIOCESAN COMMUNITES
// ============================================
const createDiocesanCommunitiesTable = async () => {
  const sql = `
    CREATE TABLE IF NOT EXISTS diocesan_communities (
      id INT AUTO_INCREMENT PRIMARY KEY,
      diocese_id INT NOT NULL,
      user_id INT NULL COMMENT 'Existing SL account if already present',
      name VARCHAR(255) NOT NULL,
      contact_name VARCHAR(150),
      contact_email VARCHAR(255),
      contact_phone VARCHAR(50),
      joined_at TIMESTAMP NULL,
      participation_status ENUM('invited', 'accepted','active','inactive','removed') DEFAULT 'invited',
      renewal_toggle BOOLEAN DEFAULT TRUE COMMENT 'If false, removed at renewal',
      billing_owner ENUM('diocese', 'community') DEFAULT 'diocese',
      subscription_start_date DATE NULL,
      subscription_end_date DATE NULL,
      prorated_amount DECIMAL(10,2) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

      INDEX idx_diocese (diocese_id),
      INDEX idx_status (participation_status),
      FOREIGN KEY (diocese_id) REFERENCES dioceses(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;
  try {
    await mysqlConnection.execute('SELECT 1 FROM diocesan_communities LIMIT 1');
    console.log('✅ Diocesan Communities table already exists');
  } catch (error) {
    await mysqlConnection.execute(sql);
    console.log('✅ Diocesan Communities table created');
  }
};

// ============================================
// TABLE 49: DIOCESAN INVITATIONS
// ============================================
const createDiocesanInvitationsTable = async () => {
  const sql = `
    CREATE TABLE IF NOT EXISTS diocesan_invitations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      diocese_id INT NOT NULL,
      community_email VARCHAR(255) NOT NULL,
      community_name VARCHAR(255) NOT NULL,
      invitation_token VARCHAR(255) UNIQUE NOT NULL,
      status ENUM('sent','accepted','expired') DEFAULT 'sent',
      expires_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_email (community_email),
      INDEX idx_status (status),
      FOREIGN KEY (diocese_id) REFERENCES dioceses(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;
  try {
    await mysqlConnection.execute('SELECT 1 FROM diocesan_invitations LIMIT 1');
    console.log('✅ Diocesan Invitation table already exists');
  } catch (error) {
    await mysqlConnection.execute(sql);
    console.log('✅ Diocesan Invitation table created');
  }
};

const createDiocesanPaymentsTable = async () => {
  const table = `
  CREATE TABLE IF NOT EXISTS diocesan_payments (
    id INT AUTO_INCREMENT PRIMARY KEY,  
    -- Relationship
    diocese_id INT NOT NULL,
    user_id INT NOT NULL,
    -- Stripe Identifiers
    stripe_session_id VARCHAR(255) UNIQUE,
    stripe_payment_intent_id VARCHAR(255),
    stripe_customer_id VARCHAR(255),  
    -- Financial
    amount DECIMAL(10,2) NOT NULL,
    currency VARCHAR(10) DEFAULT 'usd',  
    -- Payment Method
    payment_method ENUM('ach','card') NOT NULL,
    bank_name VARCHAR(150) NULL,
    card_brand VARCHAR(50) NULL,
    card_last4 VARCHAR(4) NULL,  
    -- Status Tracking
    status ENUM(
      'pending',
      'completed',
      'failed',
      'refunded',
      'cancelled'
    ) DEFAULT 'pending',  
    failure_reason TEXT NULL,
    refund_reason TEXT NULL,  
    -- Subscription Period
    subscription_start_date DATE NULL,
    subscription_end_date DATE NULL,  
    -- Audit
    paid_at TIMESTAMP NULL,
    refunded_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,  
    -- Indexes
    INDEX idx_diocese_id (diocese_id),
    INDEX idx_user_id (user_id),
    INDEX idx_status (status),
    INDEX idx_session (stripe_session_id),  
    -- Foreign Keys
    FOREIGN KEY (diocese_id) REFERENCES dioceses(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE  
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;
  try {
    await mysqlConnection.execute('SELECT 1 FROM diocesan_payments LIMIT 1');
    console.log('✅ Diocesan Payments table already exists');
  }
  catch (error) {
    await mysqlConnection.execute(table);
    console.log('✅ Diocesan Payments table created');
  }

}

// ============================================
// TABLE 51: DIOCESAN ACTIVITY LOGS (Optional but Recommended)
// ============================================
const createDiocesanActivityLogsTable = async () => {
  const sql = `
    CREATE TABLE IF NOT EXISTS diocesan_activity_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      diocese_id INT NOT NULL,
      action_type VARCHAR(100) NOT NULL,
      description TEXT NULL,
      performed_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (diocese_id) REFERENCES dioceses(id) ON DELETE CASCADE,
      FOREIGN KEY (performed_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;
  try {
    await mysqlConnection.execute('SELECT 1 FROM diocesan_activity_logs LIMIT 1');
    console.log('Diocesan Activity table already exists');
  } catch (error) {
    await mysqlConnection.execute(sql);
    console.log("✅ Diocesan Activity Logs table created");
  }
};

// ============================================
//  TABLE 52: DIOCESAN PARISHES (FINAL FINAL)
// ============================================

const createDiocesanParishesTable = async () => {
  try {

    // =========================================
    // 1️⃣ PARISHES
    // =========================================
    await mysqlConnection.execute(`
      CREATE TABLE IF NOT EXISTS diocesan_parishes (
        id INT PRIMARY KEY AUTO_INCREMENT,

        diocese_id INT NOT NULL,
        user_id INT NOT NULL,

        admin_name VARCHAR(150) NOT NULL,
        admin_email VARCHAR(150) NOT NULL,
        admin_phone VARCHAR(20),

        parish_name VARCHAR(200) NOT NULL,
        parish_address TEXT,

        joined_at DATE NOT NULL,
        renewal_date DATE NOT NULL,

        status ENUM('free','active','inactive','removed') DEFAULT 'free',
        notes TEXT,

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        UNIQUE KEY unique_parish_user (diocese_id, user_id),

        INDEX idx_diocese(diocese_id),
        INDEX idx_user(user_id),

        FOREIGN KEY (diocese_id) REFERENCES dioceses(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE

      ) ENGINE=InnoDB;
    `);


    // =========================================
    // 2️⃣ INVITES  (FIXED → INT)
    // =========================================
    await mysqlConnection.execute(`
      CREATE TABLE IF NOT EXISTS diocesan_parish_invites (
        id INT PRIMARY KEY AUTO_INCREMENT,

        diocese_id INT NOT NULL,
        email VARCHAR(150) NOT NULL,

        invitation_code VARCHAR(120) UNIQUE NOT NULL,

        status ENUM('pending','accepted','expired') DEFAULT 'pending',
        expires_at DATETIME,

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        INDEX idx_diocese(diocese_id),

        FOREIGN KEY (diocese_id)
          REFERENCES dioceses(id)
          ON DELETE CASCADE

      ) ENGINE=InnoDB;
    `);


    // =========================================
    // 3️⃣ PAYMENTS  (FIXED → INT)
    // =========================================
    await mysqlConnection.execute(`
    CREATE TABLE IF NOT EXISTS diocesan_parish_payments (
      id INT PRIMARY KEY AUTO_INCREMENT,
    
      parish_id INT NOT NULL,
      diocese_id INT NOT NULL,
    
      amount DECIMAL(10,2),
      currency VARCHAR(10) DEFAULT 'usd',
      billing_year YEAR,
    
      stripe_session_id VARCHAR(255),
      stripe_payment_intent_id VARCHAR(255),
      payment_method VARCHAR(50),
    
      status ENUM('pending','paid','failed') DEFAULT 'pending',
      paid_at DATETIME,
    
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
      INDEX idx_parish(parish_id),
      INDEX idx_diocese(diocese_id),
    
      FOREIGN KEY (parish_id)
        REFERENCES diocesan_parishes(id)
        ON DELETE CASCADE,
    
      FOREIGN KEY (diocese_id)
        REFERENCES dioceses(id)
        ON DELETE CASCADE
    
    ) ENGINE=InnoDB;
    `);


    console.log('✅ Diocesan Parish tables ready (FK safe)');
    await ensureTableColumns(mysqlConnection, 'diocesan_parish_payments', [
      { name: 'plan_id', alter: 'ADD COLUMN plan_id INT NULL AFTER parish_id' },
      { name: 'stripe_subscription_id', alter: 'ADD COLUMN stripe_subscription_id VARCHAR(255) NULL' },
      { name: 'stripe_session_id', alter: 'ADD COLUMN stripe_session_id VARCHAR(255) NULL' },
      { name: 'payment_method', alter: 'ADD COLUMN payment_method VARCHAR(50) NULL' },
      { name: 'status', alter: "ADD COLUMN status ENUM('active','cancelled','expired') DEFAULT 'active'" }, {
        name: 'status',
        alter: "MODIFY COLUMN status ENUM('active','cancelled','expired','pending') DEFAULT 'active'",
        action: 'modify'
      }
    ]);


  } catch (err) {
    console.error('❌ Failed creating Diocesan Parish tables:', err);
  }
};


const createDocumentTable = async () => {
  const createDocumentsTable = `
      CREATE TABLE IF NOT EXISTS documents (
          id              INT AUTO_INCREMENT PRIMARY KEY,
          document_title  VARCHAR(255) NOT NULL,
          category        VARCHAR(100),
          publisher       VARCHAR(100),
          year            YEAR,
          description     TEXT,
          file_url        TEXT,
          toc             JSON NULL,
          thumbnail_url   TEXT,
          created_by      INT,
          upload_by       INT,
          view_logs       JSON NULL,
          created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

          FOREIGN KEY (upload_by)  REFERENCES users(id) ON DELETE SET NULL,
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      );
  `;

  const createUserActiveDocumentTable = `
      CREATE TABLE IF NOT EXISTS user_active_document (
          id          INT AUTO_INCREMENT PRIMARY KEY,
          user_id     INT NOT NULL,
          document_id INT NOT NULL,
          active      BOOLEAN DEFAULT TRUE,

          FOREIGN KEY (user_id)     REFERENCES users(id)      ON DELETE CASCADE,
          FOREIGN KEY (document_id) REFERENCES documents(id)  ON DELETE CASCADE,

          UNIQUE KEY unique_user_document (user_id, document_id)
      );
  `;

  const createDocumentCategoryTable = `
  CREATE TABLE IF NOT EXISTS document_categories (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    description TEXT NULL,
    type        ENUM('year','publisher','category') DEFAULT 'category',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY unique_name_type (name, type)
)
  `;
  try {
    const db = getMySQLConnection();
    await db.execute("SELECT 1 FROM documents LIMIT 1");
    await db.execute("SELECT 1 FROM user_active_document LIMIT 1");
    await db.execute("SELECT 1 FROM document_categories LIMIT 1");
    await ensureTableColumns(db, 'documents', [
      {
        name: 'access_type',
        alter: 'ADD COLUMN access_type ENUM("free","subscription") DEFAULT "free"'
      },
      {
        name: 'copyright_info',
        alter: 'ADD COLUMN copyright_info JSON NULL'
      },
      {
        name: 'language',
        alter: 'ADD COLUMN language TEXT NULL'
      },
      {
        name: 'is_published',
        alter: 'ADD COLUMN is_published BOOLEAN DEFAULT TRUE'
      }
    ]);
    console.log("✅ Documents table already exists");
    console.log("✅ User Active Document table already exists");
    console.log("✅ Document Categories table already exists");
  } catch {
    const db = getMySQLConnection();
    await db.execute(createDocumentsTable);
    await db.execute(createUserActiveDocumentTable);
    await db.execute(createDocumentCategoryTable);
    console.log("✅ Documents table created");
    console.log("✅ User Active Document table created");
    console.log("✅ Document Categories table created");
  }
};

const createComposerEarningTable = async () => {
  const createTable = `
  CREATE TABLE IF NOT EXISTS composer_earnings (
    id                    BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,   
    -- Composer
    composer_id           BIGINT UNSIGNED     NOT NULL,   
    -- Song / Publication
    music_publication_id  BIGINT UNSIGNED     NOT NULL,
    composition_title     VARCHAR(500)        NULL,   
    -- Buyer
    buyer_user_id         BIGINT UNSIGNED     NOT NULL,   
    -- Financials
    sale_price            DECIMAL(10, 2)      NOT NULL DEFAULT 0.00,
    platform_fee_pct      DECIMAL(5, 2)       NOT NULL DEFAULT 0.00,   -- e.g. 20.00 means 20%
    platform_fee_amount   DECIMAL(10, 2)      NOT NULL DEFAULT 0.00,
    composer_earning      DECIMAL(10, 2)      NOT NULL DEFAULT 0.00,   -- sale_price - platform_fee_amount   
    -- Payment reference
    transaction_id        BIGINT UNSIGNED     NULL,
    stripe_session_id     VARCHAR(255)        NULL,
    payment_method        VARCHAR(50)         NULL DEFAULT 'stripe',   
    -- Status: pending | paid | cancelled
    status                ENUM('pending','paid','cancelled') NOT NULL DEFAULT 'pending',
    paid_at               DATETIME            NULL,
   
    created_at            DATETIME            NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            DATETIME            NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
   
    -- Indexes
    INDEX idx_composer    (composer_id),
    INDEX idx_publication (music_publication_id),
    INDEX idx_buyer       (buyer_user_id),
    INDEX idx_transaction (transaction_id),
    INDEX idx_session     (stripe_session_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`

  try {
    await mysqlConnection.execute('SELECT 1 FROM composer_earnings LIMIT 1');
    console.log('Composer Earning table already exists');
  } catch (error) {
    await mysqlConnection.execute(createTable);
    console.log("✅ Composer Earning table created");
  }
}

// ============================================
// Educator Tables
// ============================================
const createEducatorTables = async () => {
  const createEducatorTools = `
  CREATE TABLE IF NOT EXISTS educator_tools (
    id INT AUTO_INCREMENT PRIMARY KEY,  
    -- Basic Info
    tool_name VARCHAR(255) NOT NULL,
    tool_slug VARCHAR(255) UNIQUE NULL,
    tool_content LONGTEXT NOT NULL,
    tool_type VARCHAR(100) DEFAULT 'general',  
    -- Status & Display
    is_active BOOLEAN DEFAULT TRUE,
    display_order INT DEFAULT 0,  
    -- Ownership
    created_by INT NULL,
    updated_by INT NULL,  
    -- Metadata
    metadata JSON NULL,  
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL,    
    -- Indexes
    INDEX idx_tool_type (tool_type),
    INDEX idx_is_active (is_active),
    INDEX idx_display_order (display_order),
    INDEX idx_created_by (created_by),
    INDEX idx_updated_by (updated_by),
  
    -- Foreign Keys
    CONSTRAINT fk_educator_tools_created_by 
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  
    CONSTRAINT fk_educator_tools_updated_by 
      FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
  
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  const createEducatorTables = `
  CREATE TABLE IF NOT EXISTS educator_applications (
      id INT AUTO_INCREMENT PRIMARY KEY,  
      user_id INT NOT NULL,  
      full_name VARCHAR(150) NOT NULL,
      email VARCHAR(150) NOT NULL,
      phone VARCHAR(20) NOT NULL,
      address TEXT,  
      expertise LONGTEXT,
      other_expertise VARCHAR(255),  
      experience_years INT DEFAULT 0,  
      education TEXT,  
      role_title VARCHAR(255),  
      course_title VARCHAR(255) NOT NULL,  
      target_audience TEXT,  
      course_description TEXT,  
      learning_outcomes LONGTEXT,  
      course_structure LONGTEXT,  
      sample_lesson_title VARCHAR(255),  
      sample_lesson_objective TEXT,  
      teaching_flow LONGTEXT,  
      assessment_method TEXT,  
      sample_video_url VARCHAR(500),  
      video_duration_minutes INT,  
      video_status ENUM('pending','reviewed','approved','rejected') DEFAULT 'pending',  
      status ENUM('pending', 'under_review', 'approved', 'rejected') DEFAULT 'pending',  
      rejection_reason TEXT,  
      reviewed_by INT NULL,  
      reviewed_at TIMESTAMP NULL,  
      documents LONGTEXT,  
      is_verified TINYINT(1) DEFAULT 0,  
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,  
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,  
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
  `;

  try {
    await mysqlConnection.execute('SELECT 1 FROM educator_tools LIMIT 1');
    await mysqlConnection.execute('SELECT 1 FROM educators_applications LIMIT 1');
    console.log('Educator Tools table already exists');
    console.log('Educator Application table already exists');

  } catch (error) {
    await mysqlConnection.execute(createEducatorTools);
    await mysqlConnection.execute(createEducatorTables);
    console.log("✅ Educator Tools table created");
    console.log("✅ Educator Application table created");

  }
}

// ============================================
// COURSES TABLE
// ============================================

const coursetTable = async = () => {
  const createCoursesTables = async () => {
    const sql = `
    CREATE TABLE IF NOT EXISTS courses (
      id INT AUTO_INCREMENT PRIMARY KEY, 
      -- Educator
      educator_id             INT NOT NULL,
      educator_application_id INT NULL, 
      -- Basic Info
      course_title  VARCHAR(255) NOT NULL,
      slug          VARCHAR(255) UNIQUE,
      short_description TEXT,
      full_description  LONGTEXT, 
      -- Categorization
      category    VARCHAR(150),
      subcategory VARCHAR(150), 
      -- Audience & Outcomes
      target_audience   TEXT,
      learning_outcomes LONGTEXT, 
      -- Media
      thumbnail       VARCHAR(500),
      promo_video_url VARCHAR(500), 
      -- Technology & Resources
      technology_tools       LONGTEXT,
      downloadable_resources LONGTEXT, 
      -- Settings
      language                       VARCHAR(50)  DEFAULT 'English',
      level                          ENUM('beginner','intermediate','advanced') DEFAULT 'beginner',
      estimated_duration_hours       INT          DEFAULT 0,
      completion_required_percentage INT          DEFAULT 100, 
      -- Pricing
      course_type ENUM('free','paid') DEFAULT 'free',
      price       DECIMAL(10,2)       DEFAULT 0,
      currency    VARCHAR(10)         DEFAULT 'USD', 
      -- Visibility & Status
      visibility ENUM('private','public','unlisted') DEFAULT 'private',
      status     ENUM(
        'proposal_submitted','proposal_rejected',
        'draft','in_development','submitted_for_review',
        'revision_requested','approved','published',
        'rejected','archived'
      ) DEFAULT 'draft', 
      -- Proposal (Gate 1) data — raw wizard fields captured before the
      -- course is actually built. Consumed by /review/:id/approve-proposal
      -- to auto-create chapters/lessons, then no longer needed.
      proposal_data LONGTEXT NULL,
      -- Review
      reviewed_by        INT  NULL,
      reviewed_at        TIMESTAMP NULL,
      rejection_reason   TEXT,
      rejection_category ENUM('content','teaching_quality','video_quality','technology','platform_fit','other') NULL,
      can_resubmit       BOOLEAN DEFAULT TRUE,
      admin_feedback     LONGTEXT, 
      -- Publish
      published_at TIMESTAMP NULL, 
      -- Stats
      total_chapters INT     DEFAULT 0,
      total_lessons  INT     DEFAULT 0,
      total_students INT     DEFAULT 0, 
      -- Flags
      is_featured BOOLEAN DEFAULT FALSE,
      is_active   BOOLEAN DEFAULT TRUE, 
      -- Timestamps
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      deleted_at TIMESTAMP NULL, 
      -- Indexes
      INDEX idx_educator  (educator_id),
      INDEX idx_status    (status),
      INDEX idx_category  (category),
      INDEX idx_is_active (is_active),
      INDEX idx_slug      (slug), 
      -- Foreign Keys
      FOREIGN KEY (educator_id)             REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (educator_application_id) REFERENCES educator_applications(id) ON DELETE SET NULL,
      FOREIGN KEY (reviewed_by)             REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

    try {
      await mysqlConnection.execute('SELECT 1 FROM courses LIMIT 1');
      console.log('✅ courses table already exists');
      await ensureTableColumns(mysqlConnection, 'courses', [
        { name: 'admin_feedback', alter: 'ADD COLUMN admin_feedback LONGTEXT NULL' },
        { name: 'completion_required_percentage', alter: 'ADD COLUMN completion_required_percentage INT DEFAULT 100' },
        { name: 'short_description', alter: 'ADD COLUMN short_description TEXT NULL' },
        { name: 'proposal_data', alter: 'ADD COLUMN proposal_data LONGTEXT NULL' },
        { name: 'rejection_category', alter: "ADD COLUMN rejection_category ENUM('content','teaching_quality','video_quality','technology','platform_fit','other') NULL" },
        { name: 'can_resubmit', alter: 'ADD COLUMN can_resubmit BOOLEAN DEFAULT TRUE' },
        {
          name: 'status',
          action: 'modify',
          alter: "MODIFY COLUMN status ENUM('proposal_submitted','proposal_rejected','draft','in_development','submitted_for_review','revision_requested','approved','published','rejected','archived') DEFAULT 'draft'"
        },
      ]);
    } catch {
      await mysqlConnection.execute(sql);
      console.log('✅ courses table created');
    }
  };


  // ============================================
  // COURSE CHAPTERS TABLE
  // ============================================
  const createCourseChaptersTable = async () => {
    const sql = `
    CREATE TABLE IF NOT EXISTS course_chapters (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      course_id     INT          NOT NULL,
      title         VARCHAR(255) NOT NULL,
      description   TEXT,
      chapter_order INT          DEFAULT 0,
      is_preview    BOOLEAN      DEFAULT FALSE,
      is_active     BOOLEAN      DEFAULT TRUE, 
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, 
      INDEX idx_course (course_id),
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

    try {
      await mysqlConnection.execute('SELECT 1 FROM course_chapters LIMIT 1');
      console.log('✅ course_chapters table already exists');
    } catch {
      await mysqlConnection.execute(sql);
      console.log('✅ course_chapters table created');
    }
  };


  // ============================================
  // COURSE LESSONS TABLE
  // ============================================
  const createCourseLessonsTable = async () => {
    const sql = `
    CREATE TABLE IF NOT EXISTS course_lessons (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      course_id  INT NOT NULL,
      chapter_id INT NOT NULL, 
      title         VARCHAR(255) NOT NULL,
      lesson_type   ENUM('video','text','pdf','audio','quiz','assignment') DEFAULT 'video',
      content       LONGTEXT,
      video_url     VARCHAR(500),
      video_duration_minutes INT DEFAULT 0,
      downloadable_files     LONGTEXT, 
      lesson_order INT     DEFAULT 0,
      is_preview   BOOLEAN DEFAULT FALSE,
      is_mandatory BOOLEAN DEFAULT TRUE,
      is_active    BOOLEAN DEFAULT TRUE, 
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, 
      INDEX idx_course  (course_id),
      INDEX idx_chapter (chapter_id), 
      FOREIGN KEY (course_id)  REFERENCES courses(id)         ON DELETE CASCADE,
      FOREIGN KEY (chapter_id) REFERENCES course_chapters(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

    try {
      await mysqlConnection.execute('SELECT 1 FROM course_lessons LIMIT 1');
      console.log('✅ course_lessons table already exists');
    } catch {
      await mysqlConnection.execute(sql);
      console.log('✅ course_lessons table created');
    }
  };


  // ============================================
  // COURSE REVIEW LOGS TABLE
  // ============================================
  const createCourseReviewLogsTable = async () => {
    const sql = `
    CREATE TABLE IF NOT EXISTS course_review_logs (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      course_id   INT NOT NULL,
      reviewer_id INT NOT NULL,
      action      ENUM('submitted','approved','rejected','revision_requested','edited_by_admin','published') NOT NULL,
      notes       LONGTEXT, 
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, 
      INDEX idx_course    (course_id),
      INDEX idx_reviewer  (reviewer_id),
      INDEX idx_action    (action), 
      FOREIGN KEY (course_id)   REFERENCES courses(id) ON DELETE CASCADE,
      FOREIGN KEY (reviewer_id) REFERENCES users(id)   ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

    try {
      await mysqlConnection.execute('SELECT 1 FROM course_review_logs LIMIT 1');
      console.log('✅ course_review_logs table already exists');
    } catch {
      await mysqlConnection.execute(sql);
      console.log('✅ course_review_logs table created');
    }
  };


  // ============================================
  // COURSE STATUS HISTORY TABLE
  // ============================================
  const createCourseStatusHistoryTable = async () => {
    const sql = `
    CREATE TABLE IF NOT EXISTS course_status_history (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      course_id  INT NOT NULL,
      old_status VARCHAR(100),
      new_status VARCHAR(100),
      changed_by INT NULL,
      remarks    TEXT, 
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, 
      INDEX idx_course (course_id), 
      FOREIGN KEY (course_id)  REFERENCES courses(id) ON DELETE CASCADE,
      FOREIGN KEY (changed_by) REFERENCES users(id)   ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

    try {
      await mysqlConnection.execute('SELECT 1 FROM course_status_history LIMIT 1');
      console.log('✅ course_status_history table already exists');
    } catch {
      await mysqlConnection.execute(sql);
      console.log('✅ course_status_history table created');
    }
  };


  // ============================================
  // COURSE RESOURCES TABLE
  // ============================================
  const createCourseResourcesTable = async () => {
    const sql = `
    CREATE TABLE IF NOT EXISTS course_resources (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      course_id   INT  NOT NULL,
      lesson_id   INT  NULL,
      file_name   VARCHAR(255),
      file_url    VARCHAR(500),
      file_type   VARCHAR(100),
      file_size   BIGINT,
      uploaded_by INT NULL, 
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, 
      INDEX idx_course (course_id),
      INDEX idx_lesson (lesson_id), 
      FOREIGN KEY (course_id)   REFERENCES courses(id)       ON DELETE CASCADE,
      FOREIGN KEY (lesson_id)   REFERENCES course_lessons(id) ON DELETE SET NULL,
      FOREIGN KEY (uploaded_by) REFERENCES users(id)          ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

    try {
      await mysqlConnection.execute('SELECT 1 FROM course_resources LIMIT 1');
      console.log('✅ course_resources table already exists');
    } catch {
      await mysqlConnection.execute(sql);
      console.log('✅ course_resources table created');
    }
  };


  // ============================================
  // COURSE ENROLLMENTS TABLE
  // ============================================
  const createCourseEnrollmentsTable = async () => {
    const sql = `
    CREATE TABLE IF NOT EXISTS course_enrollments (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      course_id  INT NOT NULL,
      student_id INT NOT NULL, 
      enrolled_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      progress_percentage INT       DEFAULT 0,
      completed           BOOLEAN   DEFAULT FALSE,
      completed_at        TIMESTAMP NULL, 
      INDEX idx_course   (course_id),
      INDEX idx_student  (student_id),
      UNIQUE KEY uq_enrollment (course_id, student_id), 
      FOREIGN KEY (course_id)  REFERENCES courses(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES users(id)   ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

    try {
      await mysqlConnection.execute('SELECT 1 FROM course_enrollments LIMIT 1');
      console.log('✅ course_enrollments table already exists');
    } catch {
      await mysqlConnection.execute(sql);
      console.log('✅ course_enrollments table created');
    }
  };


  // ============================================
  // COURSE PURCHASES TABLE
  // ============================================
  const createCoursePurchasesTable = async () => {
    const sql = `
    CREATE TABLE IF NOT EXISTS course_purchases (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      course_id        INT NOT NULL,
      student_id       INT NOT NULL,
      payment_provider VARCHAR(100),
      payment_id       VARCHAR(255) UNIQUE,
      amount           DECIMAL(10,2),
      currency         VARCHAR(10)  DEFAULT 'USD',
      payment_status   ENUM('pending','paid','failed','refunded') DEFAULT 'pending',
      purchased_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP, 
      INDEX idx_course   (course_id),
      INDEX idx_student  (student_id),
      INDEX idx_payment  (payment_id), 
      FOREIGN KEY (course_id)  REFERENCES courses(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES users(id)   ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

    try {
      await mysqlConnection.execute('SELECT 1 FROM course_purchases LIMIT 1');
      console.log('✅ course_purchases table already exists');
    } catch {
      await mysqlConnection.execute(sql);
      console.log('✅ course_purchases table created');
    }
  };


  // ============================================
  // LESSON PROGRESS TABLE
  // ============================================
  const createLessonProgressTable = async () => {
    const sql = `
    CREATE TABLE IF NOT EXISTS lesson_progress (
      id                 INT AUTO_INCREMENT PRIMARY KEY,
      course_id          INT NOT NULL,
      lesson_id          INT NOT NULL,
      student_id         INT NOT NULL,
      is_completed       BOOLEAN   DEFAULT FALSE,
      completed_at       TIMESTAMP NULL,
      time_spent_minutes INT       DEFAULT 0, 
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, 
      UNIQUE KEY uq_lesson_progress (lesson_id, student_id),
      INDEX idx_course   (course_id),
      INDEX idx_student  (student_id), 
      FOREIGN KEY (course_id)  REFERENCES courses(id)        ON DELETE CASCADE,
      FOREIGN KEY (lesson_id)  REFERENCES course_lessons(id)  ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES users(id)           ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `;

    try {
      await mysqlConnection.execute('SELECT 1 FROM lesson_progress LIMIT 1');
      console.log('✅ lesson_progress table already exists');
    } catch {
      await mysqlConnection.execute(sql);
      console.log('✅ lesson_progress table created');
    }
  };



  const createQuizzesTable = async () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS quizzes (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        course_id     INT NOT NULL,
        lesson_id     INT NULL,
        level         ENUM('lesson','course') NOT NULL,
  
        title         VARCHAR(255) NOT NULL,
        description   TEXT,
  
        -- Doc Step 5a: "Choose how many questions will be asked per Quiz (x/total)"
        -- e.g. educator adds 25 questions, sets questions_to_serve = 15
        questions_to_serve INT NOT NULL DEFAULT 0,
  
        -- Doc 6B: unlimited attempts always allowed -> no time_limit / attempt_limit columns
        -- Doc 1B: course-level quiz can unlock automatically (100% lesson completion)
        -- or be educator-controlled (manual unlock regardless of progress)
        unlock_mode   ENUM('auto','manual') NOT NULL DEFAULT 'auto',
  
        status        ENUM('draft','published') NOT NULL DEFAULT 'draft',
  
        created_by    INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP NULL,
  
        INDEX idx_course (course_id),
        INDEX idx_lesson (lesson_id),
        INDEX idx_level  (level),
        INDEX idx_status (status),
  
        -- A given lesson can have at most ONE quiz; a given course can
        -- have at most ONE course-level quiz (lesson_id IS NULL case).
        UNIQUE KEY uq_lesson_quiz (lesson_id),
  
        FOREIGN KEY (course_id)  REFERENCES courses(id)        ON DELETE CASCADE,
        FOREIGN KEY (lesson_id)  REFERENCES course_lessons(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id)          ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `;
  
    try {
      await mysqlConnection.execute('SELECT 1 FROM quizzes LIMIT 1');
      console.log('✅ quizzes table already exists');
    } catch {
      await mysqlConnection.execute(sql);
      console.log('✅ quizzes table created');
    }
  };
  
  const createQuizQuestionsTable = async () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS quiz_questions (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        quiz_id         INT NOT NULL,
  
        question_type   ENUM(
          'mcq_single',
          'mcq_multiple',
          'true_false',
          'fill_blank',
          'matching',
          'ordering'
        ) NOT NULL,
  
        question_text   TEXT NOT NULL,
        options         LONGTEXT NULL,
        correct_answers LONGTEXT NOT NULL,
  
        points          INT DEFAULT 1,
        question_order  INT DEFAULT 0,
        is_active       BOOLEAN DEFAULT TRUE,
  
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
        INDEX idx_quiz (quiz_id),
  
        FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `;
  
    try {
      await mysqlConnection.execute('SELECT 1 FROM quiz_questions LIMIT 1');
      console.log('✅ quiz_questions table already exists');
    } catch {
      await mysqlConnection.execute(sql);
      console.log('✅ quiz_questions table created');
    }
  };
  
  const createQuizAttemptsTable = async () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS quiz_attempts (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        quiz_id     INT NOT NULL,
        course_id   INT NOT NULL,
        student_id  INT NOT NULL,
  
        selected_question_ids LONGTEXT NULL,
        answers                LONGTEXT NULL,
  
        total_questions DECIMAL(10,2) DEFAULT 0,
        correct_count    DECIMAL(10,2) DEFAULT 0,
        score_percentage DECIMAL(5,2) DEFAULT 0,
  
        status       ENUM('in_progress','completed') NOT NULL DEFAULT 'in_progress',
  
        started_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        submitted_at TIMESTAMP NULL,
        updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
        UNIQUE KEY uq_quiz_attempt (quiz_id, student_id),
        INDEX idx_quiz    (quiz_id),
        INDEX idx_student (student_id),
        INDEX idx_course  (course_id),
  
        FOREIGN KEY (quiz_id)    REFERENCES quizzes(id) ON DELETE CASCADE,
        FOREIGN KEY (course_id)  REFERENCES courses(id) ON DELETE CASCADE,
        FOREIGN KEY (student_id) REFERENCES users(id)   ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `;
  
    try {
      await mysqlConnection.execute('SELECT 1 FROM quiz_attempts LIMIT 1');
      console.log('✅ quiz_attempts table already exists');
    } catch {
      await mysqlConnection.execute(sql);
      console.log('✅ quiz_attempts table created');
    }
  };

  createCoursesTables();
  createCourseChaptersTable();
  createCourseLessonsTable();
  createCourseReviewLogsTable();
  createCourseStatusHistoryTable();
  createCourseResourcesTable();
  createCourseEnrollmentsTable();
  createCoursePurchasesTable();
  createLessonProgressTable();
  createQuizzesTable();
  createQuizQuestionsTable();
  createQuizAttemptsTable(); 

}

// ============================================
// DATA SEEDING FUNCTIONS
// ============================================

const insertDefaultSubscriptions = async () => {
  try {
    const [existingSubscriptions] = await mysqlConnection.execute(
      'SELECT COUNT(*) as count FROM subscriptions_new'
    );

    if (existingSubscriptions[0].count === 0) {
      const defaultSubscriptions = [
        {
          name: 'Basic Composer',
          description: 'Basic access for composers with limited features',
          price: 9.99,
          duration_days: 30,
          role: 'composer',
          features: JSON.stringify(['basic_composition', 'limited_downloads', 'community_access'])
        },
        {
          name: 'Premium Composer',
          description: 'Full access for composers with all features',
          price: 19.99,
          duration_days: 30,
          role: 'composer',
          features: JSON.stringify(['unlimited_composition', 'unlimited_downloads', 'priority_support', 'advanced_tools'])
        },
        {
          name: 'Music Educator',
          description: 'Access for music educators and teachers',
          price: 14.99,
          duration_days: 30,
          role: 'educator',
          features: JSON.stringify(['teaching_materials', 'student_management', 'lesson_plans', 'assessment_tools'])
        },
        {
          name: 'Music Professional',
          description: 'Professional access for music industry professionals',
          price: 29.99,
          duration_days: 30,
          role: 'music',
          features: JSON.stringify(['professional_tools', 'industry_insights', 'networking', 'advanced_analytics'])
        },
        {
          name: 'Event Planner',
          description: 'Access for event planners and organizers',
          price: 24.99,
          duration_days: 30,
          role: 'planner',
          features: JSON.stringify(['event_planning', 'vendor_management', 'timeline_tools', 'budget_tracking'])
        },
        {
          name: 'Document Manager',
          description: 'Access for document management and organization',
          price: 12.99,
          duration_days: 30,
          role: 'documents',
          features: JSON.stringify(['document_storage', 'version_control', 'collaboration', 'search_tools'])
        }
      ];

      for (const subscription of defaultSubscriptions) {
        await mysqlConnection.execute(
          'INSERT INTO subscriptions_new (name, description, price, duration_days, role, features) VALUES (?, ?, ?, ?, ?, ?)',
          [subscription.name, subscription.description, subscription.price, subscription.duration_days, subscription.role, subscription.features]
        );
      }

      console.log('✅ Default subscriptions inserted');
    }
  } catch (error) {
    console.error('Failed to insert default subscriptions:', error);
  }
};

const createSystemCollections = async () => {
  try {
    const [existing] = await mysqlConnection.execute(
      'SELECT COUNT(*) as count FROM collections WHERE is_system_collection = TRUE'
    );

    if (existing[0].count === 0) {
      const systemCollections = [
        {
          name: 'Gospel Music Collection',
          description: 'Traditional and modern gospel songs for worship and inspiration',
          is_system_collection: true,
          created_by: 'system'
        },
        {
          name: 'Classical Music Collection',
          description: 'Timeless classical compositions and orchestral pieces',
          is_system_collection: true,
          created_by: 'system'
        },
        {
          name: 'Modern Worship Collection',
          description: 'Contemporary worship songs for modern church services',
          is_system_collection: true,
          created_by: 'system'
        },
        {
          name: 'Instrumental Collection',
          description: 'Beautiful instrumental music for meditation and relaxation',
          is_system_collection: true,
          created_by: 'system'
        },
        {
          name: 'Christmas Music Collection',
          description: 'Festive Christmas songs and carols for the holiday season',
          is_system_collection: true,
          created_by: 'system'
        },
        {
          name: 'Wedding Music Collection',
          description: 'Romantic and ceremonial music perfect for weddings',
          is_system_collection: true,
          created_by: 'system'
        }
      ];

      for (const collection of systemCollections) {
        await mysqlConnection.execute(
          'INSERT INTO collections (name, description, is_system_collection, created_by) VALUES (?, ?, ?, ?)',
          [collection.name, collection.description, collection.is_system_collection, collection.created_by]
        );
      }

      console.log('✅ System collections created');
    }
  } catch (error) {
    console.error('❌ Error creating system collections:', error);
  }
};

const seedPermissionData = async () => {
  try {
    console.log('🌱 Seeding initial permission data...');

    // 1. Seed Permission Types
    const permissionTypes = [
      { name: 'x', label: 'Full Access', description: 'Complete access to the feature' },
      { name: '-', label: 'No Access', description: 'Feature not available in this plan' },
      { name: '1-plan', label: 'One Time Usage', description: 'Can only use this feature once' },
      { name: 'access-level', label: 'Access Level', description: 'Can only access certain levels of the feature' },
      { name: 'view-only', label: 'Read Only', description: 'Can only view, cannot edit' },
      { name: 'unlimited', label: 'Unlimited Access', description: 'No restrictions on usage' },
      { name: 'free-music-alacarte', label: 'Free Music / A-La-Carte', description: 'Can add to cart and purchase' },
      { name: 'free-course-alacarte', label: 'Free Courses / A-La-Carte', description: 'Can add to cart and purchase' },
      { name: 'free-docs-alacarte', label: 'Free Docs', description: 'Can add to cart and purchase' },
      { name: 'limited', label: 'Limited Access', description: 'Restricted access based on plan limits' }

    ];

    for (const pt of permissionTypes) {
      await mysqlConnection.execute(`
        INSERT IGNORE INTO permission_types (name, label, description)
        VALUES (?, ?, ?)
      `, [pt.name, pt.label, pt.description]);
    }

    // 2. Seed Features
    const features = [
      // Community Category
      // { name: 'Feed', slug: 'feed', category: 'Community', parent_id: null, display_order: 1 },
      // { name: 'Discussions', slug: 'discussions', category: 'Community', parent_id: null, display_order: 2 },
      // { name: 'My Groups', slug: 'my-groups', category: 'Community', parent_id: null, display_order: 3 },

      // Planner Category
      // { name: 'Plan a Service', slug: 'plan-a-service', category: 'Planner', parent_id: null, display_order: 1 },
      { name: 'My Planner', slug: 'my-planner', category: 'Planner', parent_id: null, display_order: 2 },
      // { name: 'Homily Planner', slug: 'homily-planner', category: 'Planner', parent_id: null, display_order: 3 },

      // Documents Category
      { name: 'Browse Documents', slug: 'browse-documents', category: 'Documents', parent_id: null, display_order: 1 },
      // { name: 'My Documents', slug: 'my-documents', category: 'Documents', parent_id: null, display_order: 2 },

      // Music Category
      { name: 'Browse SL Music', slug: 'browse-music', category: 'Music', parent_id: null, display_order: 1 },
      { name: 'My Music', slug: 'my-music', category: 'Music', parent_id: null, display_order: 2 },

      // Academy Category
      // { name: 'Browse Courses', slug: 'browse-courses', category: 'Academy', parent_id: null, display_order: 1 },
      // { name: 'My Courses', slug: 'my-courses', category: 'Academy', parent_id: null, display_order: 2 },

      // Composer Category
      { name: 'Browse SL Composers', slug: 'browse-composers', category: 'Composer', parent_id: null, display_order: 1 },
      { name: 'Composer Tools', slug: 'composer-tools', category: 'Composer', parent_id: null, display_order: 2 },
      { name: 'Composer Application', slug: 'composer-application', category: 'Composer', parent_id: null, display_order: 3 },
      { name: 'Publish a Composition', slug: 'publish-composition', category: 'Composer', parent_id: null, display_order: 4 },
      { name: 'My Compositions', slug: 'my-compositions', category: 'Composer', parent_id: null, display_order: 5 },
      // { name: 'Review Board', slug: 'review-board', category: 'Composer', parent_id: null, display_order: 6 },
      // { name: 'Earnings', slug: 'composer-earnings', category: 'Composer', parent_id: null, display_order: 7 },

      // Educator Category
      // { name: 'Browse Educators', slug: 'browse-educators', category: 'Educator', parent_id: null, display_order: 1 },
      // { name: 'Educator Tools', slug: 'educator-tools', category: 'Educator', parent_id: null, display_order: 2 },
      // { name: 'Educator Application', slug: 'educator-application', category: 'Educator', parent_id: null, display_order: 3 },
      // { name: 'Publish a Course', slug: 'publish-course', category: 'Educator', parent_id: null, display_order: 4 },
      // { name: 'Course Library', slug: 'course-library', category: 'Educator', parent_id: null, display_order: 5 },
      // { name: 'Earnings', slug: 'course-earnings', category: 'Educator', parent_id: null, display_order: 6 },

      // SL Account
      { name: 'My Profile', slug: 'my-profile', category: 'SL Account', parent_id: null, display_order: 1 },
      { name: 'My Ministers', slug: 'my-ministers', category: 'SL Account', parent_id: null, display_order: 2 },
      // { name: 'My Diocese', slug: 'my-diocese', category: 'SL Account', parent_id: null, display_order: 3 },
      { name: 'Manage Plan (Upgrade)', slug: 'manage-plan', category: 'SL Account', parent_id: null, display_order: 4 },
      // { name: 'Payment Methods', slug: 'payment-methods', category: 'SL Account', parent_id: null, display_order: 5 },
      { name: 'Agreements', slug: 'agreements', category: 'SL Account', parent_id: null, display_order: 6 },

      // Team Dashboard
      // { name: 'Team Dashboard', slug: 'team-dashboard', category: 'Team Dashboard', parent_id: null, display_order: 1 },
      // { name: 'Admin', slug: 'admin', category: 'Team Dashboard', parent_id: null, display_order: 2 },
      // { name: 'Music Publication', slug: 'music-publication-team', category: 'Team Dashboard', parent_id: null, display_order: 3 },
      // { name: 'Course Publication', slug: 'course-publication-team', category: 'Team Dashboard', parent_id: null, display_order: 4 },

      // Customer Service
      // { name: 'Users', slug: 'customer-service-users', category: 'Customer Service', parent_id: null, display_order: 1 },
      // { name: 'Subscriptions', slug: 'customer-service-subscriptions', category: 'Customer Service', parent_id: null, display_order: 2 },
      // { name: 'Orders', slug: 'customer-service-orders', category: 'Customer Service', parent_id: null, display_order: 3 },

      // Finances
      // { name: 'Coupons', slug: 'finances-coupons', category: 'Finances', parent_id: null, display_order: 1 },
      // { name: 'Royalties', slug: 'finances-royalties', category: 'Finances', parent_id: null, display_order: 2 },
      // { name: 'Reports', slug: 'finances-reports', category: 'Finances', parent_id: null, display_order: 3 },
      // { name: 'Analytics', slug: 'finances-analytics', category: 'Finances', parent_id: null, display_order: 4 },

      // Users count
      { name: 'Members', slug: 'member_limit', category: 'Member Limit', parent_id: null, display_order: 1 },
      { name: 'Managers', slug: 'manager_limit', category: 'Member Limit', parent_id: null, display_order: 2 }

    ];

    for (const feature of features) {
      await mysqlConnection.execute(`
        INSERT IGNORE INTO features (name, slug, category, parent_id, display_order)
        VALUES (?, ?, ?, ?, ?)
      `, [feature.name, feature.slug, feature.category, feature.parent_id, feature.display_order]);
    }

    // 3. Seed Basic Plans
    const basicPlans = [
      { name: 'Free Account', slug: 'free-account', description: 'Basic free account', price: 0.00, billing_cycle: 'free' },
      { name: 'Planner Subscription', slug: 'planner-subscription', description: 'Access to planner features', price: 300, billing_cycle: 'yearly' },
      { name: 'Documents Subscription', slug: 'documents-subscription', description: 'Access to documents', price: 450, billing_cycle: 'yearly' },
      { name: 'Music Subscription', slug: 'music-subscription', description: 'Access to music library', price: 200, billing_cycle: 'yearly' },
      { name: 'Academy Subscription', slug: 'academy-subscription', description: 'Access to courses', price: 500, billing_cycle: 'yearly' },
      { name: 'Diocesan Admin', slug: 'diocesan-admin', description: 'Access to diocesan features', price: 750.00, billing_cycle: 'yearly' },
      { name: 'Subscriber Admin', slug: 'full-access-subscription', description: 'Access to all features', price: 1000.00, billing_cycle: 'yearly' }
    ];

    for (const plan of basicPlans) {
      await mysqlConnection.execute(`
        INSERT IGNORE INTO plans (name, slug, description, price, billing_cycle)
        VALUES (?, ?, ?, ?, ?)
      `, [plan.name, plan.slug, plan.description, plan.price, plan.billing_cycle]);
    }

    // 4. Setup default permissions for Free Account
    // await setupFreeAccountPermissions();

    console.log('✅ Permission data seeded successfully');

  } catch (error) {
    console.error('❌ Failed to seed permission data:', error);
    throw error;
  }
};

// const setupFreeAccountPermissions = async () => {
//   try {
//     const [freePlan] = await mysqlConnection.execute(
//       'SELECT id FROM plans WHERE slug = ?',
//       ['free-account']
//     );

//     if (freePlan.length === 0) return;

//     const freePlanId = freePlan[0].id;

//     const [xPermission] = await mysqlConnection.execute('SELECT id FROM permission_types WHERE name = ?', ['x']);
//     const [noPermission] = await mysqlConnection.execute('SELECT id FROM permission_types WHERE name = ?', ['-']);
//     const [viewOnlyPermission] = await mysqlConnection.execute('SELECT id FROM permission_types WHERE name = ?', ['view-only']);

//     const xId = xPermission[0].id;
//     const noId = noPermission[0].id;
//     const viewId = viewOnlyPermission[0].id;

//     const freePermissions = [
//       { slug: 'feed', permission: xId },
//       { slug: 'discussions', permission: xId },
//       { slug: 'my-groups', permission: xId },
//       { slug: 'my-profile', permission: xId },
//       { slug: 'my-community', permission: xId },
//       { slug: 'browse-music', permission: viewId },
//       { slug: 'browse-documents', permission: viewId },
//       { slug: 'browse-courses', permission: viewId }
//     ];

//     for (const perm of freePermissions) {
//       const [feature] = await mysqlConnection.execute('SELECT id FROM features WHERE slug = ?', [perm.slug]);
//       if (feature.length > 0) {
//         await mysqlConnection.execute(`
//           INSERT IGNORE INTO plan_features (plan_id, feature_id, permission_type_id)
//           VALUES (?, ?, ?)
//         `, [freePlanId, feature[0].id, perm.permission]);
//       }
//     }

//     console.log('✅ Free account permissions setup complete');
//   } catch (error) {
//     console.error('❌ Failed to setup free account permissions:', error);
//   }
// };

const defaultPermissions = {
  "SL Portals": {
    "Dashboard": "-",


    "Planner": {
      "My Planner": "-",
      // "My Ministers": "-",
      // "Homily Planner": "-"
    },
    "Documents": {
      "Browse Documents": "-",
      //   "My Documents": "-"
    },
    "Music": {
      "Browse SL Music": "-",
      "My Music": "-"
    },
    // "Academy": {
    //   "Browse Courses": "-",
    //   "My Courses": "-"
    // },
    "Composer": {
      "Browse SL Composers": "-",
      "Composer Tools": "-",
      "Publish a Composition": "-",
      "My Compositions": "-",
      "Composer Application": "-",
      // "Review Board": "-",
      // "Earnings": "-"
    },
    // "Educator": {
    //   "Browse Educators": "-",
    //   "Educator Tools": "-",
    //   "Educator Application": "-",
    //   "Teach a Course": "-",
    //   "Course Library": "-",
    //   "Earnings": "-"
    // },
  },
  "SL Accounts": {
    "My Profile": "-",
    "My Ministers": "-",
    // "My Diocese": "-",
    "Manage Plan (Upgrade)": "-",
    // "Payment Methods": "-",
    "Agreements": "-",
  },
  "SL Team": {
    "Music Management": {
      "Music Catalog": "-",
      "Music Review": "-",
      "Music Categories": "-",
    },
    "Composer Management": {
      // "Composers": "-",
      "Composer Tools": "-",
      "Composer Applications": "-",
      // "Review Board": "-"
    },
    "User Management": {
      "Users": "-",
      "Badge and Permissions": "-",
    },
    "Subscription Management": {
      "Subscription History": "-",
      "Payment History": "-",
      "Subscription Settings": "-",
    },
    "Planner Management": {
      "Planner Management": "-",
    },
    "Coupon Management": {
      "Coupon Management": "-",
    },
    "Agreement Management": {
      "Agreement Management": "-",
    }
  }

};

const predefinedBadges = [
  "Composer",
  "Review Board",
  "Director of SLC",
  "Director of SLA",
  "Music Editorial",
  "Admin",
  "Music Publication",
  "CFO",
  "Customer Service",
];

const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]+/g, '');

const seedRolePermissions = async () => {
  try {
    console.log("🌱 Seeding role permissions...");

    for (const badge of predefinedBadges) {
      const cleanName = badge.trim();
      const slug = slugify(cleanName);

      const [existing] = await mysqlConnection.execute(
        `SELECT id FROM role_permissions 
             WHERE slug = ? OR role_name = ?`,
        [slug, cleanName]
      );

      if (existing.length > 0) {
        console.log(`⏭ Role already exists: ${cleanName}`);
        continue;
      }

      await mysqlConnection.execute(
        `INSERT INTO role_permissions (role_name, slug, permissions)
             VALUES (?, ?, ?)`,
        [cleanName, slug, JSON.stringify(defaultPermissions)]
      );

      console.log(`✅ Created role: ${cleanName}`);
    }

    console.log("🎉 Role permission seeding completed.");
  } catch (error) {
    console.error("❌ Error seeding role permissions:", error);
  }
};

// ============================================
// PLANNER MASSPARTS SEEDING
// ============================================
const seedPlannerMassparts = async () => {
  try {
    const [existing] = await mysqlConnection.execute(
      'SELECT COUNT(*) as count FROM planner_massparts'
    );

    if (existing[0].count === 0) {
      console.log('🌱 Seeding initial planner mass parts...');

      const payload = [
        {
          Music: {
            HymnsSongs: [
              "Prelude",
              "Entrance",
              "Offertory",
              "Communion",
              "Post-Communion",
              "Recessional",
              "Postlude",
            ],
            Proper: [
              "Entrance Antiphon",
              "Responsorial Psalm",
              "Gospel Acclamation",
              "Communion Antiphon",
            ],
            Ordinary: [
              "Gloria",
              "Profession of Faith (Creed)",
              "Holy",
              "Mystery of Faith",
              "Lamb of God",
              "The Lord's Prayer",
              "Great Amen",
              "Penitential Act (w/ Kyrie)",
            ],
            Instrumental: [
              "Prelude (Instrumental)",
              "Offertory (Instrumental)",
              "Post-Communion (Instrumental)",
              "Postlude (Instrumental)",
            ],
          }
        },
        {
          Reading: [
            "First Reading",
            "Second Reading",
            "Responsorial Psalm",
            "Gospel Acclamation",
            "Sequence",
            "Gospel Reading",
          ]
        },
        {
          Prayer: [
            "Prayers of the Faithful",
            "Collect",
            "Prayer over the Offerings",
            "Prayer after Communion",
          ]
        },
        {
          Other: [
            "Homily",
            "Dismissal of the Catechumens/Elect",
            "Mass Setting (General)",
            "Other (Namable)",
          ]
        }
      ];

      function normalizeWithDepth(data, depth = 0) {
        if (typeof data === "string") {
          return data;
        }

        if (Array.isArray(data)) {
          const isAllStrings = data.every(
            (item) => typeof item === "string"
          );

          if (isAllStrings && depth <= 3) {
            return data.map((str) => ({
              [str]: [],
            }));
          }

          return data.map((item) =>
            normalizeWithDepth(item, depth + 1)
          );
        }

        if (typeof data === "object" && data !== null) {
          const result = {};

          for (const key in data) {
            result[key] = normalizeWithDepth(
              data[key],
              depth + 1
            );
          }

          return result;
        }

        return data;
      }

      for (const item of payload) {
        if (!item || typeof item !== "object") continue;
        const name = Object.keys(item)[0];
        const normalized = normalizeWithDepth(item);
        await mysqlConnection.execute(
          "INSERT INTO planner_massparts (name, full_path) VALUES (?, ?)",
          [name, JSON.stringify(normalized)]
        );
      }

      console.log('✅ Planner massparts table seeded successfully');
    }
  } catch (error) {
    console.error('❌ Error seeding planner_massparts:', error);
  }
};

// ============================================
// PLANNER MASSTEMPLATES SEEDING
// ============================================
const seedPlannerMassTemplates = async () => {
  try {
    const [existingCategories] = await mysqlConnection.execute(
      'SELECT COUNT(*) as count FROM planner_mass_template_categories'
    );
    const [existingTemplates] = await mysqlConnection.execute(
      'SELECT COUNT(*) as count FROM planner_mass_templates'
    );

    if (existingCategories[0].count === 0 && existingTemplates[0].count === 0) {
      console.log('🌱 Seeding initial planner mass templates and categories...');

      const defaultCategories = [
        { key: 'direct', label: 'Direct', order: 0 },
        { key: 'wedding', label: 'Wedding', order: 1 },
        { key: 'funeral', label: 'Funeral', order: 2 },
        { key: 'other', label: 'Other', order: 3 }
      ];

      for (const cat of defaultCategories) {
        await mysqlConnection.execute(
          'INSERT INTO planner_mass_template_categories (category_key, label, display_order) VALUES (?, ?, ?)',
          [cat.key, cat.label, cat.order]
        );
      }

      const templates = [
        {
          category: 'direct',
          key: 'sunday',
          name: 'Sunday Mass',
          order: 0,
          data: {
            "mass_template_data": {
              "sections": [
                { "id": "header-1", "type": "header", "title": "INTRODUCTORY RITES", "description": "", "isTemplateHeader": true },
                { "id": 101, "type": "customtext", "title": "Entrance Antiphon", "description": "", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "", "minister": null },
                { "id": 102, "type": "customtext", "title": "Entrance", "description": "", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "", "minister": null },
                { "id": 103, "type": "customtext", "title": "Penitential Act (w/ Kyrie)", "description": "", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "", "minister": null },
                { "id": 104, "type": "customtext", "title": "Gloria", "description": "", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "", "minister": null },
                { "id": "header-2", "type": "header", "title": "LITURGY OF THE WORD", "description": "", "isTemplateHeader": true },
                { "id": 201, "type": "customtext", "title": "First Reading", "description": "", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 202, "type": "customtext", "title": "Responsorial Psalm", "description": "", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 203, "type": "customtext", "title": "Second Reading", "description": "", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 204, "type": "customtext", "title": "Gospel Acclamation", "description": "", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 205, "type": "customtext", "title": "Gospel Reading", "description": "", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 206, "type": "customtext", "title": "Homily", "description": "", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": 207, "type": "customtext", "title": "Profession of Faith", "description": "", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": 208, "type": "customtext", "title": "Prayers of the Faithful", "description": "", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": "header-3", "type": "header", "title": "LITURGY OF THE EUCHARIST", "description": "", "isTemplateHeader": true },
                { "id": 301, "type": "customtext", "title": "Offertory", "description": "", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 302, "type": "customtext", "title": "Holy", "description": "", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 303, "type": "customtext", "title": "Mystery of Faith", "description": "", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 304, "type": "customtext", "title": "Great Amen", "description": "", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 305, "type": "customtext", "title": "Lamb of God", "description": "", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 306, "type": "customtext", "title": "Communion Antiphon", "description": "", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 307, "type": "customtext", "title": "Communion", "description": "", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 308, "type": "customtext", "title": "Post-Communion", "description": "", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": "header-4", "type": "header", "title": "CONCLUDING RITES", "description": "", "isTemplateHeader": true },
                { "id": 401, "type": "customtext", "title": "Recessional", "description": "", "header": "CONCLUDING RITES", "headerId": "header-4", "content": "" }
              ]
            }
          }
        },
        {
          category: 'direct',
          key: 'weekday',
          name: 'Weekday Mass',
          order: 1,
          data: {
            "mass_template_data": {
              "sections": [
                { "id": "header-1", "type": "header", "title": "INTRODUCTORY RITES", "description": "", "isTemplateHeader": true },
                { "id": 101, "type": "customtext", "title": "Entrance Antiphon", "description": "", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "", "minister": null },
                { "id": 102, "type": "customtext", "title": "Entrance", "description": "", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "", "minister": null },
                { "id": 103, "type": "customtext", "title": "Penitential Act (w/ Kyrie)", "description": "", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "", "minister": null },
                { "id": "header-2", "type": "header", "title": "LITURGY OF THE WORD", "description": "", "isTemplateHeader": true },
                { "id": 201, "type": "customtext", "title": "First Reading", "description": "", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 202, "type": "customtext", "title": "Responsorial Psalm", "description": "", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 203, "type": "customtext", "title": "Gospel Acclamation", "description": "", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 204, "type": "customtext", "title": "Gospel Reading", "description": "", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 205, "type": "customtext", "title": "Homily", "description": "", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": 206, "type": "customtext", "title": "Prayers of the Faithful", "description": "", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": "header-3", "type": "header", "title": "LITURGY OF THE EUCHARIST", "description": "", "isTemplateHeader": true },
                { "id": 301, "type": "customtext", "title": "Offertory", "description": "", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 302, "type": "customtext", "title": "Holy", "description": "", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 303, "type": "customtext", "title": "Mystery of Faith", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 304, "type": "customtext", "title": "Great Amen", "description": "", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 305, "type": "customtext", "title": "Lamb of God", "description": "", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 306, "type": "customtext", "title": "Communion Antiphon", "description": "", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 307, "type": "customtext", "title": "Communion", "description": "", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": "header-4", "type": "header", "title": "CONCLUDING RITES", "description": "", "isTemplateHeader": true },
                { "id": 401, "type": "customtext", "title": "Recessional", "description": "", "header": "CONCLUDING RITES", "headerId": "header-4", "content": "" }
              ]
            }
          }
        },
        {
          category: 'wedding',
          key: 'matrimony-during',
          name: 'Wedding Mass (During Mass)',
          order: 0,
          data: {
            "mass_template_data": {
              "sections": [
                { "id": "header-1", "type": "header", "title": "INTRODUCTORY RITES", "isTemplateHeader": true },
                { "id": 101, "type": "customtext", "title": "Prelude (Instrumental)", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": 102, "type": "customtext", "title": "Entrance Antiphon", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": 103, "type": "customtext", "title": "Entrance", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": 104, "type": "customtext", "title": "Gloria", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": "header-2", "type": "header", "title": "LITURGY OF THE WORD", "isTemplateHeader": true },
                { "id": 201, "type": "customtext", "title": "First Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": 202, "type": "customtext", "title": "Responsorial Psalm", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": 203, "type": "customtext", "title": "Second Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": 204, "type": "customtext", "title": "Gospel Acclamation", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": 205, "type": "customtext", "title": "Gospel Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": 206, "type": "customtext", "title": "Homily", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": 207, "type": "customtext", "title": "Prayers of the Faithful", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": "header-3", "type": "header", "title": "RITE OF MATRIMONY", "isTemplateHeader": true },
                { "id": 301, "type": "customtext", "title": "Acclamation after the Reception of the Consent", "header": "RITE OF MATRIMONY", "headerId": "header-3", "content": "" },
                { "id": 302, "type": "customtext", "title": "Hymn of Praise", "header": "RITE OF MATRIMONY", "headerId": "header-3", "content": "" },
                { "id": "header-4", "type": "header", "title": "LITURGY OF THE EUCHARIST", "isTemplateHeader": true },
                { "id": 401, "type": "customtext", "title": "Offertory", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-4", "content": "" },
                { "id": 402, "type": "customtext", "title": "Holy", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-4", "content": "" },
                { "id": 403, "type": "customtext", "title": "Mystery of Faith", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-4", "content": "" },
                { "id": 404, "type": "customtext", "title": "Great Amen", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-4", "content": "" },
                { "id": 405, "type": "customtext", "title": "Lord’s Prayer", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-4", "content": "" },
                { "id": 406, "type": "customtext", "title": "Lamb of God", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-4", "content": "" },
                { "id": 407, "type": "customtext", "title": "Communion Antiphon", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-4", "content": "" },
                { "id": 408, "type": "customtext", "title": "Communion", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-4", "content": "" },
                { "id": 409, "type": "customtext", "title": "Flowers to the Blessed Virgin", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-4", "content": "" },
                { "id": 410, "type": "customtext", "title": "Post-Communion (Meditation)", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-4", "content": "" },
                { "id": "header-5", "type": "header", "title": "CONCLUDING RITES", "isTemplateHeader": true },
                { "id": 501, "type": "customtext", "title": "Song during the Signing", "header": "CONCLUDING RITES", "headerId": "header-5", "content": "" },
                { "id": 502, "type": "customtext", "title": "Recessional", "header": "CONCLUDING RITES", "headerId": "header-5", "content": "" },
                { "id": 503, "type": "customtext", "title": "Postlude", "header": "CONCLUDING RITES", "headerId": "header-5", "content": "" }
              ]
            }
          }
        },
        {
          category: 'wedding',
          key: 'matrimony-outside',
          name: 'Wedding Mass (Outside Mass)',
          order: 1,
          data: {
            "mass_template_data": {
              "sections": [
                { "id": "header-1", "type": "header", "title": "INTRODUCTORY RITES", "isTemplateHeader": true },
                { "id": 101, "type": "customtext", "title": "Prelude", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": 102, "type": "customtext", "title": "Entrance Antiphon", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": 103, "type": "customtext", "title": "Entrance", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": "header-2", "type": "header", "title": "LITURGY OF THE WORD", "isTemplateHeader": true },
                { "id": 201, "type": "customtext", "title": "First Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": 202, "type": "customtext", "title": "Responsorial Psalm", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": 203, "type": "customtext", "title": "Second Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": 204, "type": "customtext", "title": "Gospel Acclamation", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": 205, "type": "customtext", "title": "Gospel Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": 206, "type": "customtext", "title": "Homily", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": "header-3", "type": "header", "title": "RITE OF MATRIMONY", "isTemplateHeader": true },
                { "id": 301, "type": "customtext", "title": "Acclamation after the Reception of the Consent", "header": "RITE OF MATRIMONY", "headerId": "header-3", "content": "" },
                { "id": 302, "type": "customtext", "title": "Hymn of Praise", "header": "RITE OF MATRIMONY", "headerId": "header-3", "content": "" },
                { "id": "header-4", "type": "header", "title": "COMMUNION RITE (optional)", "isTemplateHeader": true },
                { "id": 401, "type": "customtext", "title": "Communion Antiphon", "header": "COMMUNION RITE (optional)", "headerId": "header-4", "content": "" },
                { "id": 402, "type": "customtext", "title": "Communion", "header": "COMMUNION RITE (optional)", "headerId": "header-4", "content": "" },
                { "id": 403, "type": "customtext", "title": "Flowers to the Blessed Virgin", "header": "COMMUNION RITE (optional)", "headerId": "header-4", "content": "" },
                { "id": 404, "type": "customtext", "title": "Post-Communion (Meditation)", "header": "COMMUNION RITE (optional)", "headerId": "header-4", "content": "" },
                { "id": "header-5", "type": "header", "title": "CONCLUDING RITES", "isTemplateHeader": true },
                { "id": 501, "type": "customtext", "title": "Song during the Signing", "header": "CONCLUDING RITES", "headerId": "header-5", "content": "" }
              ]
            }
          }
        },
        {
          category: 'wedding',
          key: 'wedding-sunday',
          name: 'Wedding Sunday Mass',
          order: 2,
          data: {
            "mass_template_data": {
              "sections": [
                { "id": "header-1", "type": "header", "title": "INTRODUCTORY RITES", "description": "", "isTemplateHeader": true },
                { "id": 101, "type": "customtext", "title": "Prelude", "description": "", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": "header-2", "type": "header", "title": "LITURGY OF THE WORD", "description": "", "isTemplateHeader": true },
                { "id": 201, "type": "customtext", "title": "First Reading", "description": "", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 202, "type": "customtext", "title": "Responsorial Psalm", "description": "", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 203, "type": "customtext", "title": "Second Reading", "description": "", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 204, "type": "customtext", "title": "Gospel Acclamation", "description": "", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 205, "type": "customtext", "title": "Gospel Reading", "description": "", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 206, "type": "customtext", "title": "Homily", "description": "", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": "header-3", "type": "header", "title": "RITE OF MATRIMONY", "description": "", "isTemplateHeader": true },
                { "id": 301, "type": "customtext", "title": "Offertory", "description": "", "header": "RITE OF MATRIMONY", "headerId": "header-3", "content": "" },
                { "id": 302, "type": "customtext", "title": "Hymn of Praise", "description": "", "header": "RITE OF MATRIMONY", "headerId": "header-3", "content": "" },
                { "id": "header-4", "type": "header", "title": "CONCLUDING RITES", "description": "", "isTemplateHeader": true },
                { "id": 401, "type": "customtext", "title": "Song during the Signing", "description": "", "header": "CONCLUDING RITES", "headerId": "header-4", "content": "" },
                { "id": 402, "type": "customtext", "title": "Final Song or Hymn", "description": "", "header": "CONCLUDING RITES", "headerId": "header-4", "content": "" },
                { "id": 403, "type": "customtext", "title": "Postlude", "description": "", "header": "CONCLUDING RITES", "headerId": "header-4", "content": "" }
              ]
            }
          }
        },
        {
          category: 'funeral',
          key: 'funeral-outside',
          name: 'Funeral Service (Outside Mass)',
          order: 0,
          data: {
            "mass_template_data": {
              "sections": [
                { "id": "header-1", "type": "header", "title": "INTRODUCTORY RITES", "isTemplateHeader": true },
                { "id": 101, "type": "customtext", "title": "Prelude", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": 102, "type": "customtext", "title": "Entrance Antiphon", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": 103, "type": "customtext", "title": "Entrance", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": "header-2", "type": "header", "title": "LITURGY OF THE WORD", "isTemplateHeader": true },
                { "id": 201, "type": "customtext", "title": "First Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 202, "type": "customtext", "title": "Responsorial Psalm", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 203, "type": "customtext", "title": "Second Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 204, "type": "customtext", "title": "Gospel Acclamation", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 205, "type": "customtext", "title": "Gospel Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 206, "type": "customtext", "title": "Homily", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": 207, "type": "customtext", "title": "Lord’s Prayer", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": "header-3", "type": "header", "title": "FINAL COMMENDATION", "isTemplateHeader": true },
                { "id": 301, "type": "customtext", "title": "Song of Farewell", "header": "FINAL COMMENDATION", "headerId": "header-3", "content": "" },
                { "id": 302, "type": "customtext", "title": "Final Song or Hymn", "header": "FINAL COMMENDATION", "headerId": "header-3", "content": "" },
                { "id": 303, "type": "customtext", "title": "Chant at the Procession", "header": "FINAL COMMENDATION", "headerId": "header-3", "content": "" }
              ]
            }
          }
        },
        {
          category: 'funeral',
          key: 'funeral-mass',
          name: 'Funeral Mass',
          order: 1,
          data: {
            "mass_template_data": {
              "sections": [
                { "id": "header-1", "type": "header", "title": "INTRODUCTORY RITES", "isTemplateHeader": true },
                { "id": 101, "type": "customtext", "title": "Prelude", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": 102, "type": "customtext", "title": "Entrance Antiphon", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": 103, "type": "customtext", "title": "Entrance", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": "header-2", "type": "header", "title": "LITURGY OF THE WORD", "isTemplateHeader": true },
                { "id": 201, "type": "customtext", "title": "First Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 202, "type": "customtext", "title": "Responsorial Psalm", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 203, "type": "customtext", "title": "Second Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 204, "type": "customtext", "title": "Gospel Acclamation", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 205, "type": "customtext", "title": "Gospel Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 206, "type": "customtext", "title": "Homily", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": "header-3", "type": "header", "title": "LITURGY OF THE EUCHARIST", "isTemplateHeader": true },
                { "id": 301, "type": "customtext", "title": "Offertory", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 302, "type": "customtext", "title": "Holy", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 303, "type": "customtext", "title": "Mystery of Faith", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 304, "type": "customtext", "title": "Great Amen", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 305, "type": "customtext", "title": "Lord’s Prayer", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 306, "type": "customtext", "title": "Lamb of God Antiphon", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 307, "type": "customtext", "title": "Communion", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 308, "type": "customtext", "title": "Post-Communion (Meditation)", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": "header-4", "type": "header", "title": "CONCLUDING RITES", "isTemplateHeader": true },
                { "id": 401, "type": "customtext", "title": "Song of Farewell", "header": "CONCLUDING RITES", "headerId": "header-4", "content": "" },
                { "id": 402, "type": "customtext", "title": "Final Song or Hymn", "header": "CONCLUDING RITES", "headerId": "header-4", "content": "" },
                { "id": 403, "type": "customtext", "title": "Chant at the Procession", "header": "CONCLUDING RITES", "headerId": "header-4", "content": "" }
              ]
            }
          }
        },
        {
          category: 'funeral',
          key: 'vigil-deceased',
          name: 'Vigil for the Deceased',
          order: 2,
          data: {
            "mass_template_data": {
              "sections": [
                { "id": "header-1", "type": "header", "title": "INTRODUCTORY RITES", "isTemplateHeader": true },
                { "id": 101, "type": "customtext", "title": "Prelude", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": 102, "type": "customtext", "title": "Entrance", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": "header-2", "type": "header", "title": "LITURGY OF THE WORD", "isTemplateHeader": true },
                { "id": 201, "type": "customtext", "title": "First Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 202, "type": "customtext", "title": "Responsorial Psalm", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 203, "type": "customtext", "title": "Second Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 204, "type": "customtext", "title": "Gospel Acclamation", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 205, "type": "customtext", "title": "Gospel Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 206, "type": "customtext", "title": "Homily", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": 207, "type": "customtext", "title": "Litany", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": 208, "type": "customtext", "title": "Lord’s Prayer", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": "header-3", "type": "header", "title": "CONCLUDING RITES", "isTemplateHeader": true },
                { "id": 301, "type": "customtext", "title": "Recessional", "header": "CONCLUDING RITES", "headerId": "header-3", "content": "" },
                { "id": 302, "type": "customtext", "title": "Postlude", "header": "CONCLUDING RITES", "headerId": "header-3", "content": "" }
              ]
            }
          }
        },
        {
          category: 'funeral',
          key: 'funeral-children',
          name: 'Funeral Mass for Baptized Children',
          order: 3,
          data: {
            "mass_template_data": {
              "sections": [
                { "id": "header-1", "type": "header", "title": "INTRODUCTORY RITES", "isTemplateHeader": true },
                { "id": 101, "type": "customtext", "title": "Prelude", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": 102, "type": "customtext", "title": "Entrance Antiphon", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": 103, "type": "customtext", "title": "Entrance", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": "header-2", "type": "header", "title": "LITURGY OF THE WORD", "isTemplateHeader": true },
                { "id": 201, "type": "customtext", "title": "First Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 202, "type": "customtext", "title": "Responsorial Psalm", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 203, "type": "customtext", "title": "Second Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 204, "type": "customtext", "title": "Gospel Acclamation", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 205, "type": "customtext", "title": "Gospel Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "", "reading": "" },
                { "id": 206, "type": "customtext", "title": "Homily", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": 207, "type": "customtext", "title": "Credo", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": 208, "type": "customtext", "title": "Prayers of the Faithful", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": "header-3", "type": "header", "title": "LITURGY OF THE EUCHARIST", "isTemplateHeader": true },
                { "id": 301, "type": "customtext", "title": "Offertory", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 302, "type": "customtext", "title": "Holy", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 303, "type": "customtext", "title": "Mystery of Faith", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 304, "type": "customtext", "title": "Great Amen", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 305, "type": "customtext", "title": "Lord’s Prayer", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 306, "type": "customtext", "title": "Lamb of God", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 307, "type": "customtext", "title": "Communion", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 308, "type": "customtext", "title": "Post-Communion (Meditation)", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": "header-4", "type": "header", "title": "CONCLUDING RITES", "isTemplateHeader": true },
                { "id": 401, "type": "customtext", "title": "Song of Farewell", "header": "CONCLUDING RITES", "headerId": "header-4", "content": "" },
                { "id": 402, "type": "customtext", "title": "Final Hymn", "header": "CONCLUDING RITES", "headerId": "header-4", "content": "" },
                { "id": 403, "type": "customtext", "title": "Chant at the Procession", "header": "CONCLUDING RITES", "headerId": "header-4", "content": "" }
              ]
            }
          }
        },
        {
          category: 'other',
          key: 'ash-wednesday',
          name: 'Ash Wednesday',
          order: 0,
          data: {
            "mass_template_data": {
              "sections": [
                { "id": "header-1", "type": "header", "title": "INTRODUCTORY RITES", "isTemplateHeader": true },
                { "id": 101, "type": "customtext", "title": "Prelude", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": 102, "type": "customtext", "title": "Entrance Antiphon", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": 103, "type": "customtext", "title": "Entrance", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": "header-2", "type": "header", "title": "LITURGY OF THE WORD", "isTemplateHeader": true },
                { "id": 201, "type": "customtext", "title": "First Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "reading": "", "content": "" },
                { "id": 202, "type": "customtext", "title": "Responsorial Psalm", "header": "LITURGY OF THE WORD", "headerId": "header-2", "reading": "", "content": "" },
                { "id": 203, "type": "customtext", "title": "Second Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "reading": "", "content": "" },
                { "id": 204, "type": "customtext", "title": "Gospel Acclamation", "header": "LITURGY OF THE WORD", "headerId": "header-2", "reading": "", "content": "" },
                { "id": 205, "type": "customtext", "title": "Gospel Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "reading": "", "content": "" },
                { "id": 206, "type": "customtext", "title": "Chant for the Distribution of Ashes", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": "header-3", "type": "header", "title": "LITURGY OF THE EUCHARIST", "isTemplateHeader": true },
                { "id": 301, "type": "customtext", "title": "Offertory", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 302, "type": "customtext", "title": "Holy", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 303, "type": "customtext", "title": "Mystery of Faith", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 304, "type": "customtext", "title": "Great Amen", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 305, "type": "customtext", "title": "Lord’s Prayer", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 306, "type": "customtext", "title": "Lamb of God", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 307, "type": "customtext", "title": "Communion", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 308, "type": "customtext", "title": "Post-Communion (Meditation)", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": "header-4", "type": "header", "title": "CONCLUDING RITES", "isTemplateHeader": true },
                { "id": 401, "type": "customtext", "title": "Recessional", "header": "CONCLUDING RITES", "headerId": "header-4", "content": "" },
                { "id": 402, "type": "customtext", "title": "Postlude", "header": "CONCLUDING RITES", "headerId": "header-4", "content": "" }
              ]
            }
          }
        },
        {
          category: 'other',
          key: 'palm-sunday',
          name: 'Palm Sunday',
          order: 1,
          data: {
            "mass_template_data": {
              "sections": [
                { "id": "header-1", "type": "header", "title": "SOLEMN PROCESSION", "isTemplateHeader": true },
                { "id": 101, "type": "customtext", "title": "Prelude", "header": "SOLEMN PROCESSION", "headerId": "header-1", "content": "" },
                { "id": 102, "type": "customtext", "title": "Antiphon/Gathering", "header": "SOLEMN PROCESSION", "headerId": "header-1", "content": "" },
                { "id": 103, "type": "customtext", "title": "Gospel at the Blessing of the Palms", "header": "SOLEMN PROCESSION", "headerId": "header-1", "content": "" },
                { "id": 104, "type": "customtext", "title": "Chant at the Procession", "header": "SOLEMN PROCESSION", "headerId": "header-1", "content": "" },
                { "id": 105, "type": "customtext", "title": "Entrance Antiphon", "header": "SOLEMN PROCESSION", "headerId": "header-1", "content": "" },
                { "id": 106, "type": "customtext", "title": "Entrance", "header": "SOLEMN PROCESSION", "headerId": "header-1", "content": "" },
                { "id": "header-2", "type": "header", "title": "LITURGY OF THE WORD", "isTemplateHeader": true },
                { "id": 201, "type": "customtext", "title": "First Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "reading": "", "content": "" },
                { "id": 202, "type": "customtext", "title": "Responsorial Psalm", "header": "LITURGY OF THE WORD", "headerId": "header-2", "reading": "", "content": "" },
                { "id": 203, "type": "customtext", "title": "Second Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "reading": "", "content": "" },
                { "id": 204, "type": "customtext", "title": "Gospel Acclamation", "header": "LITURGY OF THE WORD", "headerId": "header-2", "reading": "", "content": "" },
                { "id": 205, "type": "customtext", "title": "Gospel Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "reading": "", "content": "" },
                { "id": 206, "type": "customtext", "title": "Dismissal of Catechumens/Elect", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": "header-3", "type": "header", "title": "LITURGY OF THE EUCHARIST", "isTemplateHeader": true },
                { "id": 301, "type": "customtext", "title": "Offertory", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 302, "type": "customtext", "title": "Holy", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 303, "type": "customtext", "title": "Mystery of Faith", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 304, "type": "customtext", "title": "Great Amen", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 305, "type": "customtext", "title": "Lord’s Prayer", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 306, "type": "customtext", "title": "Lamb of God", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 307, "type": "customtext", "title": "Communion", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 308, "type": "customtext", "title": "Post-Communion (Meditation)", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": "header-4", "type": "header", "title": "CONCLUDING RITES", "isTemplateHeader": true },
                { "id": 401, "type": "customtext", "title": "Recessional", "header": "CONCLUDING RITES", "headerId": "header-4", "content": "" },
                { "id": 402, "type": "customtext", "title": "Postlude", "header": "CONCLUDING RITES", "headerId": "header-4", "content": "" }
              ]
            }
          }
        },
        {
          category: 'other',
          key: 'chrism-mass',
          name: 'Chrism Mass',
          order: 2,
          data: {
            "mass_template_data": {
              "sections": [
                { "id": "header-1", "type": "header", "title": "INTRODUCTORY RITES", "isTemplateHeader": true },
                { "id": 101, "type": "customtext", "title": "Prelude", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": 102, "type": "customtext", "title": "Entrance Antiphon", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": 103, "type": "customtext", "title": "Entrance", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": 104, "type": "customtext", "title": "Penitential Act (w/ Kyrie)", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": 105, "type": "customtext", "title": "Gloria", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": "header-2", "type": "header", "title": "LITURGY OF THE WORD", "isTemplateHeader": true },
                { "id": 201, "type": "customtext", "title": "First Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "reading": "", "content": "" },
                { "id": 202, "type": "customtext", "title": "Responsorial Psalm", "header": "LITURGY OF THE WORD", "headerId": "header-2", "reading": "", "content": "" },
                { "id": 203, "type": "customtext", "title": "Second Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "reading": "", "content": "" },
                { "id": 204, "type": "customtext", "title": "Gospel Acclamation", "header": "LITURGY OF THE WORD", "headerId": "header-2", "reading": "", "content": "" },
                { "id": 205, "type": "customtext", "title": "Gospel Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "reading": "", "content": "" },
                { "id": 206, "type": "customtext", "title": "Homily", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": 207, "type": "customtext", "title": "Credo", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": 208, "type": "customtext", "title": "Prayers of the Faithful", "header": "LITURGY OF THE WORD", "headerId": "header-2", "content": "" },
                { "id": "header-3", "type": "header", "title": "LITURGY OF THE EUCHARIST", "isTemplateHeader": true },
                { "id": 301, "type": "customtext", "title": "Procession with the Holy Oils", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 302, "type": "customtext", "title": "Offertory", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 303, "type": "customtext", "title": "Holy", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 304, "type": "customtext", "title": "Mystery of Faith", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 305, "type": "customtext", "title": "Great Amen", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 306, "type": "customtext", "title": "Lord’s Prayer", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 307, "type": "customtext", "title": "Lamb of God", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 308, "type": "customtext", "title": "Communion", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": 309, "type": "customtext", "title": "Post-Communion (Meditation)", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-3", "content": "" },
                { "id": "header-4", "type": "header", "title": "CONCLUDING RITES", "isTemplateHeader": true },
                { "id": 401, "type": "customtext", "title": "Recessional", "header": "CONCLUDING RITES", "headerId": "header-4", "content": "" }
              ]
            }
          }
        },
        {
          category: 'other',
          key: 'holy-thursday',
          name: 'Holy Thursday',
          order: 3,
          data: {
            "mass_template_data": {
              "sections": [
                { "id": "header-1", "type": "header", "title": "INTRODUCTORY RITES", "isTemplateHeader": true },
                { "id": 101, "type": "customtext", "title": "Prelude", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": 102, "type": "customtext", "title": "Entrance Antiphon", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": 103, "type": "customtext", "title": "Entrance", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": 104, "type": "customtext", "title": "Gloria", "header": "INTRODUCTORY RITES", "headerId": "header-1", "content": "" },
                { "id": "header-2", "type": "header", "title": "LITURGY OF THE WORD", "isTemplateHeader": true },
                { "id": 201, "type": "customtext", "title": "First Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "reading": "", "content": "" },
                { "id": 202, "type": "customtext", "title": "Responsorial Psalm", "header": "LITURGY OF THE WORD", "headerId": "header-2", "reading": "", "content": "" },
                { "id": 203, "type": "customtext", "title": "Second Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "reading": "", "content": "" },
                { "id": 204, "type": "customtext", "title": "Gospel Acclamation", "header": "LITURGY OF THE WORD", "headerId": "header-2", "reading": "", "content": "" },
                { "id": 205, "type": "customtext", "title": "Gospel Reading", "header": "LITURGY OF THE WORD", "headerId": "header-2", "reading": "", "content": "" },
                { "id": "header-3", "type": "header", "title": "THE WASHING OF THE FEET", "isTemplateHeader": true },
                { "id": 301, "type": "customtext", "title": "Chant at the Washing of the Feet", "header": "THE WASHING OF THE FEET", "headerId": "header-3", "content": "" },
                { "id": 302, "type": "customtext", "title": "Acclamation at the Presentation of the Oils", "header": "THE WASHING OF THE FEET", "headerId": "header-3", "content": "" },
                { "id": "header-4", "type": "header", "title": "LITURGY OF THE EUCHARIST", "isTemplateHeader": true },
                { "id": 401, "type": "customtext", "title": "Offertory", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-4", "content": "" },
                { "id": 402, "type": "customtext", "title": "Holy", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-4", "content": "" },
                { "id": 403, "type": "customtext", "title": "Mystery of Faith", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-4", "content": "" },
                { "id": 404, "type": "customtext", "title": "Great Amen", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-4", "content": "" },
                { "id": 405, "type": "customtext", "title": "Lord’s Prayer", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-4", "content": "" },
                { "id": 406, "type": "customtext", "title": "Lamb of God", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-4", "content": "" },
                { "id": 407, "type": "customtext", "title": "Communion Antiphon", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-4", "content": "" },
                { "id": 408, "type": "customtext", "title": "Communion", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-4", "content": "" },
                { "id": 409, "type": "customtext", "title": "Post-Communion (Meditation)", "header": "LITURGY OF THE EUCHARIST", "headerId": "header-4", "content": "" },
                { "id": "header-5", "type": "header", "title": "CONCLUDING RITES", "isTemplateHeader": true },
                { "id": 501, "type": "customtext", "title": "Transfer of the Most Blessed Sacrament", "header": "CONCLUDING RITES", "headerId": "header-5", "content": "" }
              ]
            }
          }
        }
      ];

      for (const t of templates) {
        await mysqlConnection.execute(
          'INSERT INTO planner_mass_templates (category, template_key, name, template_data, display_order) VALUES (?, ?, ?, ?, ?)',
          [t.category, t.key, t.name, JSON.stringify(t.data), t.order]
        );
      }

      console.log('✅ Planner mass templates and categories seeded successfully');
    }
  } catch (error) {
    console.error('❌ Error seeding planner mass templates:', error);
  }
};

// ============================================
// HELPER FUNCTION
// ============================================
const getMySQLConnection = () => {
  if (!mysqlConnection) {
    throw new Error('MySQL connection not established');
  }
  return mysqlConnection;
};

// ============================================
// EXPORTS
// ============================================
module.exports = {
  connectMySQL,
  getMySQLConnection
};