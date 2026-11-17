const { getMySQLConnection } = require('./mysql');

/**
 * Safely ensure columns exist on a MySQL table.
 */
async function ensureTableColumns(mysqlConnection, tableName, columnsConfig) {
  try {
    const [existingCols] = await mysqlConnection.execute(`SHOW COLUMNS FROM \`${tableName}\``);
    const existingColNames = existingCols.map(c => c.Field);

    for (const col of columnsConfig) {
      if (col.action === 'modify') {
        if (existingColNames.includes(col.name)) {
          await mysqlConnection.execute(`ALTER TABLE \`${tableName}\` ${col.alter}`).catch(err => {
            console.log(`ℹ️ Column modify on ${tableName}.${col.name} skipped:`, err.message);
          });
        }
      } else {
        if (!existingColNames.includes(col.name)) {
          await mysqlConnection.execute(`ALTER TABLE \`${tableName}\` ${col.alter}`).catch(err => {
            console.log(`ℹ️ Column add on ${tableName}.${col.name} skipped:`, err.message);
          });
        }
      }
    }
  } catch (error) {
    console.warn(`⚠️ ensureTableColumns warning on table ${tableName}:`, error.message);
  }
}

/**
 * Initialize QuickBooks & Payout Database Tables and Columns
 */
const initQuickbooksTables = async (connection) => {
  const mysql = connection || getMySQLConnection();

  try {
    console.log('🔄 Initializing QuickBooks & Payout database schema...');

    // 1. QuickBooks Connections (OAuth storage per realmId)
    await mysql.execute(`
      CREATE TABLE IF NOT EXISTS quickbooks_connections (
        id INT AUTO_INCREMENT PRIMARY KEY,
        realm_id VARCHAR(100) NOT NULL UNIQUE,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        access_token_expires_at DATETIME NOT NULL,
        refresh_token_expires_at DATETIME NOT NULL,
        status ENUM('active', 'expired', 'disconnected', 'requires_reauthorization') DEFAULT 'active',
        environment VARCHAR(20) DEFAULT 'sandbox',
        connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 2. QuickBooks Vendor Mappings (Artist ID -> QB Vendor ID)
    await mysql.execute(`
      CREATE TABLE IF NOT EXISTS quickbooks_vendor_mappings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT UNSIGNED NOT NULL UNIQUE,
        quickbooks_vendor_id VARCHAR(100) NOT NULL,
        display_name VARCHAR(255) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_qb_vendor (quickbooks_vendor_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 3. QuickBooks Account Configurations (Chart of accounts mappings)
    await mysql.execute(`
      CREATE TABLE IF NOT EXISTS quickbooks_account_config (
        id INT AUTO_INCREMENT PRIMARY KEY,
        realm_id VARCHAR(100) NOT NULL UNIQUE,
        ap_account_id VARCHAR(100) NULL,
        expense_account_id VARCHAR(100) NULL,
        bank_account_id VARCHAR(100) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 4. Payout Audit Trail Logs
    await mysql.execute(`
      CREATE TABLE IF NOT EXISTS payout_audit_logs (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        royalty_id BIGINT UNSIGNED NOT NULL,
        artist_id BIGINT UNSIGNED NOT NULL,
        action VARCHAR(100) NOT NULL,
        status VARCHAR(50) NOT NULL,
        details JSON NULL,
        error_message TEXT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_royalty (royalty_id),
        INDEX idx_artist (artist_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 5. Extend composer_earnings table with QuickBooks & Stripe columns
    const qbEarningsColumns = [
      { name: 'quickbooks_vendor_id', alter: 'ADD COLUMN quickbooks_vendor_id VARCHAR(100) NULL' },
      { name: 'quickbooks_bill_id', alter: 'ADD COLUMN quickbooks_bill_id VARCHAR(100) NULL' },
      { name: 'quickbooks_bill_sync_token', alter: 'ADD COLUMN quickbooks_bill_sync_token VARCHAR(50) NULL' },
      { name: 'quickbooks_bill_balance', alter: 'ADD COLUMN quickbooks_bill_balance DECIMAL(10,2) NULL' },
      { name: 'quickbooks_payment_id', alter: 'ADD COLUMN quickbooks_payment_id VARCHAR(100) NULL' },
      { name: 'quickbooks_payment_sync_token', alter: 'ADD COLUMN quickbooks_payment_sync_token VARCHAR(50) NULL' },
      { name: 'stripe_account_id', alter: 'ADD COLUMN stripe_account_id VARCHAR(255) NULL' },
      { name: 'stripe_transfer_id', alter: 'ADD COLUMN stripe_transfer_id VARCHAR(255) NULL' },
      { name: 'stripe_payout_id', alter: 'ADD COLUMN stripe_payout_id VARCHAR(255) NULL' },
      { name: 'stripe_payment_intent_id', alter: 'ADD COLUMN stripe_payment_intent_id VARCHAR(255) NULL' },
      { name: 'stripe_status', alter: 'ADD COLUMN stripe_status VARCHAR(50) NULL' },
      { name: 'payment_status', alter: "ADD COLUMN payment_status VARCHAR(50) DEFAULT 'PENDING'" },
      { name: 'quickbooks_status', alter: "ADD COLUMN quickbooks_status VARCHAR(50) DEFAULT 'UNSYNCED'" },
      { name: 'quickbooks_last_synced_at', alter: 'ADD COLUMN quickbooks_last_synced_at DATETIME NULL' },
      { name: 'payout_error', alter: 'ADD COLUMN payout_error TEXT NULL' },
      { name: 'quickbooks_error', alter: 'ADD COLUMN quickbooks_error TEXT NULL' }
    ];

    await ensureTableColumns(mysql, 'composer_earnings', qbEarningsColumns);

    // Also extend educator_earnings and document_royalty_earnings if they exist
    await ensureTableColumns(mysql, 'educator_earnings', qbEarningsColumns).catch(() => {});
    await ensureTableColumns(mysql, 'document_royalty_earnings', qbEarningsColumns).catch(() => {});

    console.log('✅ QuickBooks & Payout database schema initialized successfully');
  } catch (error) {
    console.error('❌ QuickBooks database initialization failed:', error.message);
  }
};

module.exports = {
  initQuickbooksTables,
  ensureTableColumns
};
