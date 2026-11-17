
require('dotenv').config();
const mysql = require('mysql2/promise');

// Expected Schema - All 39 Tables with their columns
const EXPECTED_SCHEMA = {
  users: [
    'id', 'first_name', 'last_name', 'email', 'password', 'phone',
    'role', 'user_type', 'parent_user_id',
    'current_plan_id', 'plan_start_date', 'plan_end_date', 'plan_status',
    'plan_permissions', 'custom_permissions', 'permissions',
    'max_sub_users', 'active_sub_users_count',
    'bio', 'avatar', 'website_url', 'twitter_url', 'address',
    'country', 'state_province', 'city', 'postal_code',
    'language', 'timezone', 'badges',
    'is_composer', 'is_review_board_member', 'is_active', 'is_verified',
    'email_verified_at', 'last_login', 'login_count',
    'free_trial_started_at', 'free_trial_expires_at', 'has_upgraded',
    'created_at', 'updated_at', 'deleted_at'
  ],
  
  community_members: [
    'id', 'name', 'email', 'phone', 'city', 'gender',
    'parent_user_id', 'user_id', 'status',
    'is_invited', 'invited_at', 'invitation_token', 'invitation_expires_at',
    'has_login_credentials', 'credentials_created_at',
    'created_at', 'updated_at', 'deleted_at'
  ],
  
  password_reset_otps: [
    'id', 'user_id', 'otp_code', 'expires_at', 'is_used',
    'created_at', 'updated_at'
  ],
  
  subscriptions_new: [
    'id', 'name', 'description', 'price', 'duration_days', 'role',
    'features', 'is_active', 'created_at', 'updated_at'
  ],
  
  user_subscriptions: [
    'id', 'user_id', 'subscription_id', 'start_date', 'end_date',
    'status', 'payment_status', 'payment_method', 'amount_paid',
    'stripe_subscription_id', 'stripe_customer_id', 'stripe_payment_intent_id',
    'created_at', 'updated_at'
  ],
  
  filters: [
    'id', 'top_level', 'second_level', 'third_level', 'item_text',
    'full_path', 'created_at'
  ],
  
  small_filters: [
    'id', 'label', 'items', 'created_at'
  ],
  
  type_of_music: [
    'id', 'name', 'created_at'
  ],
  
  composer_applications: [
    'id', 'user_id', 'status', 'application_source',
    'full_name', 'email', 'phone_number', 'street_address', 'address_line_2',
    'city', 'state_province', 'zip_code', 'country',
    'music_background', 'composition_background',
    'church_affiliation', 'liturgical_draw', 'liturgical_purpose',
    'notation_software_proficiency', 'digitization_method', 'notation_software_used',
    'composition_1_title', 'composition_1_liturgical_use', 'composition_1_other_info', 'composition_1_files',
    'composition_2_title', 'composition_2_liturgical_use', 'composition_2_other_info', 'composition_2_files',
    'composition_3_title', 'composition_3_liturgical_use', 'composition_3_other_info', 'composition_3_files',
    'terms_accepted', 'terms_accepted_at',
    'reviewed_by', 'reviewed_at', 'review_notes', 'rejection_reason',
    'created_at', 'updated_at'
  ],
  
  review_board_applications: [
    'id', 'user_id', 'status', 'application_source',
    'first_name', 'last_name', 'email', 'phone', 'address', 'gender', 'photo',
    'terms_accepted', 'terms_accepted_at',
    'reviewed_by', 'reviewed_at', 'review_notes', 'rejection_reason',
    'created_at', 'updated_at'
  ],
  
  collections: [
    'id', 'user_id', 'name', 'description', 'image_url',
    'is_system_collection', 'created_by', 'is_active',
    'created_at', 'updated_at'
  ],
  
  music_publications: [
    'id', 'composer_id', 'status', 'review_stage',
    'composition_title', 'composition_title_1', 'composition_description',
    'composer_firstname', 'composer_lastname',
    'is_part_of_collection', 'collection_id', 'collection_name',
    'vocal_parts', 'instrumentation', 'types_of_music',
    'first_line_of_composition', 'composition_copyrights', 'song_type',
    'meter', 'season', 'psalm_number', 'liturgicalText', 'verseStyle', 'feast',
    'text_copyright_notice', 'tune_copyright_notice', 'artists',
    'music_files', 'music_video_link', 'artwork_file_url', 'artwork_file_size',
    'price', 'is_free', 'tune', 'general_details', 'country_restrictions',
    'is_public_domain', 'can_be_reprinted', 'can_be_podcast_streamed',
    'can_make_commercial_recording', 'can_make_non_commercial_recording',
    'terms_accepted', 'terms_accepted_at',
    'stage1_decision', 'stage1_reviewed_by', 'stage1_reviewed_at', 'stage1_notes',
    'stage1_reviews', 'stage1_replaced_files', 'stage1_review_comments',
    'stage2_decision', 'stage2_reviewed_by', 'stage2_reviewed_at', 'stage2_notes',
    'stage2_replaced_files', 'stage2_comments',
    'stage3_decision', 'stage3_reviewed_by', 'stage3_reviewed_at', 'stage3_notes',
    'stage3_replaced_files', 'stage3_composer_resubmissions',
    'stage4_decision', 'stage4_reviewed_by', 'stage4_reviewed_at', 'stage4_notes',
    'onelicense_verified_by', 'onelicense_verified_at', 'onelicense_verification_notes',
    'admin_reviewed_by', 'admin_reviewed_at', 'admin_review_notes',
    'sl_team_reviewed_by', 'sl_team_reviewed_at', 'sl_team_review_notes',
    'rejection_reason', 'published_at', 'published_by',
    'scheduled_deletion_at', 'created_at', 'updated_at'
  ],
  
  libraries: [
    'id', 'user_id', 'name', 'description', 'image_url', 'is_active',
    'created_at', 'updated_at'
  ],
  
  library_music: [
    'id', 'library_id', 'music_id', 'added_at'
  ],
  
  collection_music: [
    'id', 'collection_id', 'music_id', 'added_at'
  ],
  
  user_music_library: [
    'id', 'user_id', 'music_publication_id', 'file_type', 'file_name',
    'file_url', 'file_size', 'price', 'purchase_date',
    'download_count', 'last_downloaded', 'created_at', 'updated_at'
  ],
  
  user_music_cart: [
    'id', 'user_id', 'music_publication_id', 'file_data', 'price',
    'added_at', 'created_at', 'updated_at'
  ],
  
  user_orders: [
    'id', 'user_id', 'total_amount', 'payment_status', 'payment_method',
    'order_status', 'stripe_session_id', 'stripe_payment_intent_id',
    'notes', 'created_at', 'updated_at'
  ],
  
  plans: [
    'id', 'name', 'slug', 'description', 'price', 'billing_cycle',
    'is_active', 'created_at', 'updated_at'
  ],
  
  features: [
    'id', 'name', 'slug', 'category', 'parent_id', 'description',
    'display_order', 'is_active', 'created_at', 'updated_at'
  ],
  
  permission_types: [
    'id', 'name', 'label', 'description', 'created_at'
  ],
  
  plan_features: [
    'id', 'plan_id', 'feature_id', 'permission_type_id', 'custom_value',
    'created_at', 'updated_at'
  ],
  
  feature_usage: [
    'id', 'user_id', 'feature_id', 'usage_count', 'last_used_at',
    'reset_at', 'created_at', 'updated_at'
  ],
  
  roles: [
    'id', 'name', 'display_name', 'description', 'is_active',
    'created_by', 'created_at', 'updated_at'
  ],
  
  permissions: [
    'id', 'name', 'display_name', 'description', 'category',
    'is_active', 'created_by', 'created_at', 'updated_at'
  ],
  
  role_permissions: [
    'id', 'role_name', 'slug', 'permissions', 'created_at'
  ],
  
  user_permissions: [
    'id', 'user_id', 'permission_id', 'granted_by', 'created_at'
  ],
  
  payment_customers: [
    'id', 'user_id', 'stripe_customer_id', 'email', 'name', 'phone',
    'address', 'metadata', 'created_at', 'updated_at'
  ],
  
  payment_transactions: [
    'id', 'user_id', 'plan_id', 'stripe_session_id', 'stripe_payment_intent_id',
    'stripe_customer_id', 'stripe_invoice_id', 'stripe_subscription_id',
    'amount', 'currency', 'status', 'payment_method', 'payment_method_types',
    'card_brand', 'card_last4', 'bank_name', 'billing_name', 'billing_email',
    'billing_phone', 'billing_address', 'description', 'receipt_url',
    'invoice_pdf', 'failure_message', 'refund_reason',
    'completed_at', 'refunded_at', 'created_at', 'updated_at'
  ],
  
  stripe_subscriptions: [
    'id', 'user_id', 'stripe_subscription_id', 'stripe_customer_id',
    'stripe_price_id', 'status', 'current_period_start', 'current_period_end',
    'cancel_at_period_end', 'canceled_at', 'ended_at', 'trial_start',
    'trial_end', 'metadata', 'created_at', 'updated_at'
  ],
  
  stripe_products: [
    'id', 'plan_id', 'stripe_product_id', 'name', 'description',
    'active', 'metadata', 'created_at', 'updated_at'
  ],
  
  stripe_prices: [
    'id', 'plan_id', 'stripe_price_id', 'stripe_product_id',
    'amount', 'currency', 'recurring_interval', 'active',
    'metadata', 'created_at', 'updated_at'
  ],
  
  payment_methods: [
    'id', 'user_id', 'stripe_payment_method_id', 'stripe_customer_id',
    'type', 'card_brand', 'card_last4', 'card_exp_month', 'card_exp_year',
    'bank_name', 'bank_last4', 'bank_account_type',
    'billing_name', 'billing_email', 'billing_phone', 'billing_address',
    'is_default', 'is_verified', 'metadata', 'created_at', 'updated_at'
  ],
  
  invoices: [
    'id', 'user_id', 'transaction_id', 'stripe_invoice_id',
    'stripe_subscription_id', 'stripe_customer_id', 'invoice_number',
    'amount_due', 'amount_paid', 'amount_remaining', 'currency', 'status',
    'period_start', 'period_end', 'due_date', 'paid_at',
    'invoice_pdf', 'hosted_invoice_url', 'description', 'metadata',
    'created_at', 'updated_at'
  ],
  
  refunds: [
    'id', 'transaction_id', 'user_id', 'stripe_refund_id',
    'stripe_payment_intent_id', 'amount', 'currency', 'reason',
    'status', 'description', 'metadata', 'refunded_at',
    'created_at', 'updated_at'
  ],
  
  webhook_logs: [
    'id', 'event_id', 'event_type', 'processed', 'error_message',
    'payload', 'created_at'
  ],
  
  payment_analytics: [
    'id', 'date', 'total_transactions', 'successful_payments',
    'failed_payments', 'refunded_payments', 'total_revenue',
    'card_revenue', 'bank_revenue', 'revenue_by_plan',
    'new_subscriptions', 'cancelled_subscriptions', 'active_subscriptions',
    'metadata', 'created_at', 'updated_at'
  ],
  
  music_transactions: [
    'id', 'user_id', 'music_publication_id', 'cart_item_id',
    'stripe_session_id', 'stripe_payment_intent_id', 'stripe_customer_id',
    'amount', 'currency', 'status', 'payment_method',
    'composition_title', 'composer_name', 'file_count', 'file_data',
    'composer_id', 'publication_status', 'composition_description',
    'composer_firstname', 'composer_lastname', 'composition_title_1',
    'is_part_of_collection', 'collection_id', 'collection_name',
    'vocal_parts', 'instrumentation', 'types_of_music',
    'first_line_of_composition', 'composition_copyrights', 'song_type',
    'meter', 'season', 'psalm_number', 'liturgicalText', 'verseStyle', 'feast',
    'text_copyright_notice', 'tune_copyright_notice', 'artists',
    'music_files', 'artwork_file_url', 'artwork_file_size', 'price', 'is_free',
    'terms_accepted', 'terms_accepted_at',
    'onelicense_verified_by', 'onelicense_verified_at', 'onelicense_verification_notes',
    'admin_reviewed_by', 'admin_reviewed_at', 'admin_review_notes',
    'sl_team_reviewed_by', 'sl_team_reviewed_at', 'sl_team_review_notes',
    'rejection_reason', 'published_at', 'published_by',
    'publication_created_at', 'publication_updated_at',
    'completed_at', 'created_at', 'updated_at'
  ],
  
  composer_tools: [
    'id', 'tool_name', 'tool_content', 'tool_type', 'is_active',
    'display_order', 'created_by', 'updated_by', 'created_at', 'updated_at'
  ]
};

// ============================================
// DATABASE CONNECTION
// ============================================
async function connectToDatabase() {
  const dbConfig = {
    host: process.env.MYSQL_HOST || 'localhost',
    port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'admin_slback',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  };

  console.log('🔌 Connecting to MySQL database...');
  console.log(`   Host: ${dbConfig.host}`);
  console.log(`   Port: ${dbConfig.port}`);
  console.log(`   Database: ${dbConfig.database}`);
  console.log('');

  try {
    const connection = mysql.createPool(dbConfig);
    
    // Test connection
    const testConn = await connection.getConnection();
    await testConn.ping();
    testConn.release();
    
    console.log('✅ Database connection successful!\n');
    return connection;
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    throw error;
  }
}

// ============================================
// FETCH ACTUAL SCHEMA FROM DATABASE
// ============================================
async function fetchActualSchema(connection) {
  const actualSchema = {};
  
  try {
    // Get all tables
    const [tables] = await connection.execute('SHOW TABLES');
    const tableNames = tables.map(row => Object.values(row)[0]);
    
    console.log(`📋 Found ${tableNames.length} tables in database\n`);
    
    // Get columns for each table
    for (const tableName of tableNames) {
      const [columns] = await connection.execute(`SHOW COLUMNS FROM ${tableName}`);
      actualSchema[tableName] = columns.map(col => col.Field);
    }
    
    return actualSchema;
  } catch (error) {
    console.error('❌ Error fetching schema:', error.message);
    throw error;
  }
}

// ============================================
// VALIDATION LOGIC
// ============================================
function validateSchema(actualSchema, expectedSchema) {
  const results = {
    total: 0,
    passed: 0,
    failed: 0,
    missing: [],
    extra: [],
    details: {}
  };
  
  // Check each expected table
  for (const [tableName, expectedColumns] of Object.entries(expectedSchema)) {
    results.total++;
    
    if (!actualSchema[tableName]) {
      results.failed++;
      results.missing.push(tableName);
      results.details[tableName] = {
        status: 'MISSING',
        message: 'Table not found in database',
        expectedColumns: expectedColumns.length
      };
      continue;
    }
    
    const actualColumns = actualSchema[tableName];
    const missingColumns = expectedColumns.filter(col => !actualColumns.includes(col));
    const extraColumns = actualColumns.filter(col => !expectedColumns.includes(col));
    
    if (missingColumns.length === 0) {
      results.passed++;
      results.details[tableName] = {
        status: 'PASSED',
        message: `All ${expectedColumns.length} columns present`,
        actualColumns: actualColumns.length,
        expectedColumns: expectedColumns.length,
        extraColumns: extraColumns.length > 0 ? extraColumns : null
      };
    } else {
      results.failed++;
      results.details[tableName] = {
        status: 'FAILED',
        message: `Missing ${missingColumns.length} column(s)`,
        actualColumns: actualColumns.length,
        expectedColumns: expectedColumns.length,
        missingColumns,
        extraColumns: extraColumns.length > 0 ? extraColumns : null
      };
    }
  }
  
  // Check for extra tables
  for (const tableName of Object.keys(actualSchema)) {
    if (!expectedSchema[tableName]) {
      results.extra.push(tableName);
    }
  }
  
  return results;
}

// ============================================
// GENERATE REPORT
// ============================================
function generateReport(results) {
  console.log('='.repeat(80));
  console.log('📊 LIVE DATABASE VALIDATION REPORT');
  console.log('='.repeat(80));
  
  console.log(`\n📈 SUMMARY:`);
  console.log(`   Total Expected Tables: ${results.total}`);
  console.log(`   ✅ Passed: ${results.passed} (${((results.passed / results.total) * 100).toFixed(1)}%)`);
  console.log(`   ❌ Failed: ${results.failed}`);
  
  if (results.missing.length > 0) {
    console.log(`   ⚠️  Missing Tables: ${results.missing.length}`);
  }
  
  if (results.extra.length > 0) {
    console.log(`   ℹ️  Extra Tables (not expected): ${results.extra.length}`);
  }
  
  console.log('\n' + '-'.repeat(80));
  console.log('📋 DETAILED TABLE ANALYSIS:');
  console.log('-'.repeat(80));
  
  // Show failed tables first
  const failedTables = Object.entries(results.details)
    .filter(([_, details]) => details.status === 'FAILED' || details.status === 'MISSING');
  
  if (failedTables.length > 0) {
    console.log('\n❌ FAILED/MISSING TABLES:\n');
    for (const [tableName, details] of failedTables) {
      const statusIcon = details.status === 'MISSING' ? '⚠️' : '❌';
      
      console.log(`${statusIcon} ${tableName.toUpperCase()}`);
      console.log(`   Status: ${details.status}`);
      console.log(`   ${details.message}`);
      
      if (details.missingColumns && details.missingColumns.length > 0) {
        console.log(`   Missing Columns (${details.missingColumns.length}):`);
        details.missingColumns.forEach(col => {
          console.log(`      • ${col}`);
        });
      }
      
      if (details.extraColumns && details.extraColumns.length > 0) {
        console.log(`   Extra Columns (${details.extraColumns.length}):`);
        details.extraColumns.forEach(col => {
          console.log(`      + ${col}`);
        });
      }
      console.log('');
    }
  }
  
  // Show passed tables summary
  const passedTables = Object.entries(results.details)
    .filter(([_, details]) => details.status === 'PASSED');
  
  if (passedTables.length > 0) {
    console.log('\n✅ PASSED TABLES:\n');
    for (const [tableName, details] of passedTables) {
      console.log(`✅ ${tableName.padEnd(30)} | ${details.expectedColumns} columns | ${details.message}`);
    }
  }
  
  if (results.missing.length > 0) {
    console.log('\n' + '-'.repeat(80));
    console.log('⚠️  MISSING TABLES (not created yet):');
    console.log('-'.repeat(80));
    results.missing.forEach((table, index) => {
      console.log(`   ${index + 1}. ${table}`);
    });
  }
  
  if (results.extra.length > 0) {
    console.log('\n' + '-'.repeat(80));
    console.log('ℹ️  EXTRA TABLES (not in expected schema):');
    console.log('-'.repeat(80));
    results.extra.forEach((table, index) => {
      console.log(`   ${index + 1}. ${table}`);
    });
  }
  
  console.log('\n' + '='.repeat(80));
  
  if (results.failed === 0 && results.missing.length === 0) {
    console.log('🎉 VALIDATION PASSED! All expected tables and columns exist in database.');
  } else {
    console.log('⚠️  VALIDATION INCOMPLETE! Please review the issues above.');
    console.log(`   ${results.failed} table(s) have missing columns`);
    console.log(`   ${results.missing.length} table(s) are completely missing`);
  }
  
  console.log('='.repeat(80) + '\n');
  
  return results.failed === 0 && results.missing.length === 0;
}

// ============================================
// MAIN EXECUTION
// ============================================
async function main() {
  let connection;
  
  try {
    console.log('\n🚀 Starting Live Database Schema Validation...\n');
    
    // Connect to database
    connection = await connectToDatabase();
    
    // Fetch actual schema from database
    const actualSchema = await fetchActualSchema(connection);
    
    // Validate schema
    const results = validateSchema(actualSchema, EXPECTED_SCHEMA);
    
    // Generate and display report
    const isValid = generateReport(results);
    
    // Close connection
    await connection.end();
    
    // Exit with appropriate code
    process.exit(isValid ? 0 : 1);
    
  } catch (error) {
    console.error('\n❌ Validation Error:', error.message);
    
    if (connection) {
      await connection.end();
    }
    
    process.exit(1);
  }
}

// Run validation
main();