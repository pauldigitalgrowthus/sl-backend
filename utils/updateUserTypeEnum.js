const mysql = require('mysql2/promise');

const dbConfig = {
  host: process.env.MYSQL_HOST,
  port: process.env.MYSQL_PORT,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE || 'admin_slback',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

/**
 * Updates the user_type ENUM to include all current role slugs from role_permissions table
 */
async function updateUserTypeEnum() {
  const connection = await mysql.createConnection(dbConfig);

  try {
    console.log('🚀 Starting ENUM update...\n');

    // Step 1: Get all role slugs from role_permissions
    console.log('📋 Fetching role slugs...');
    const [roles] = await connection.query(
      'SELECT slug FROM role_permissions ORDER BY slug'
    );

    const roleSlugs = roles.map(r => r.slug);
    console.log(`Found ${roleSlugs.length} role slugs:`, roleSlugs);

    if (roleSlugs.length === 0) {
      console.warn('⚠️  No roles found! Add roles to role_permissions first.');
      console.log('\nExample:');
      console.log("INSERT INTO role_permissions (role_name, slug, permissions) VALUES");
      console.log("('Super Admin', 'super_admin', '[]'),");
      console.log("('Manager', 'manager', '[]');");
      return;
    }

    // Step 2: Check for orphaned users before updating ENUM
    console.log('\n🔍 Checking for orphaned users...');
    const [orphanedUsers] = await connection.query(`
      SELECT id, email, user_type 
      FROM users 
      WHERE role = 'sl_team' 
      AND user_type IS NOT NULL 
      AND user_type NOT IN (${roleSlugs.map(() => '?').join(', ')})
      AND user_type NOT IN ('admin', 'sub_user', 'review_board', 'superadmin')
    `, roleSlugs);

    if (orphanedUsers.length > 0) {
      console.log(`⚠️  Found ${orphanedUsers.length} orphaned users with invalid user_type:`);
      
      const fallbackSlug = roleSlugs[0] || 'admin'; // Use first available slug or 'admin'
      console.log(`🔄 Reassigning orphaned users to '${fallbackSlug}'...`);

      for (const user of orphanedUsers) {
        console.log(`   - ${user.email}: '${user.user_type}' → '${fallbackSlug}'`);
        await connection.query('UPDATE users SET user_type = ? WHERE id = ?', [fallbackSlug, user.id]);
      }
      
      console.log(`✅ Fixed ${orphanedUsers.length} orphaned users`);
    } else {
      console.log(`✅ No orphaned users found`);
    }

    // Step 3: Build new ENUM
    const baseTypes = ['admin', 'sub_user', 'review_board', 'superadmin'];
    const allTypes = [...baseTypes, ...roleSlugs];
    const enumString = allTypes.map(t => `'${t}'`).join(', ');

    console.log('\n✨ New ENUM values:', allTypes);

    // Step 4: Update ENUM
    console.log('\n🔧 Updating user_type ENUM...');
    await connection.query(`
      ALTER TABLE users 
      MODIFY COLUMN user_type ENUM(${enumString}) DEFAULT 'admin'
    `);
    console.log('✅ ENUM updated successfully!');

    // Step 5: Fix existing users
    console.log('\n🔄 Fixing existing users...\n');

    const [users] = await connection.query(
      'SELECT id, email, role, user_type FROM users'
    );

    for (const user of users) {
      let newType = user.user_type;

      if (user.role === 'free_user') {
        // Free users: set to NULL
        if (user.user_type !== null) {
          await connection.query('UPDATE users SET user_type = NULL WHERE id = ?', [user.id]);
          console.log(`✓ ${user.email} (free_user) → NULL`);
        } else {
          console.log(`✓ ${user.email} (free_user) → NULL (already correct)`);
        }

      } else if (user.role === 'user') {
        // Regular users: admin or sub_user
        if (!['admin', 'sub_user'].includes(user.user_type)) {
          newType = 'admin';
          await connection.query('UPDATE users SET user_type = ? WHERE id = ?', [newType, user.id]);
          console.log(`✓ ${user.email} (user) → admin`);
        } else {
          console.log(`✓ ${user.email} (user) → ${user.user_type} (kept)`);
        }

      } else if (user.role === 'sl_team') {
        // SL Team: keep 'admin' if already admin
        if (user.user_type === 'admin') {
          console.log(`✓ ${user.email} (sl_team) → admin (kept)`);
          continue;
        }

        // SL Team: must have a valid role slug
        if (!roleSlugs.includes(user.user_type)) {
          const newType = roleSlugs[0]; // Default to first slug
          await connection.query('UPDATE users SET user_type = ? WHERE id = ?', [newType, user.id]);
          console.log(`✓ ${user.email} (sl_team) → ${newType}`);
        } else {
          console.log(`✓ ${user.email} (sl_team) → ${user.user_type} (kept)`);
        }
      }
    }

    console.log('\n✅ All done!\n');

    // Summary
    const [summary] = await connection.query(`
      SELECT 
        role,
        user_type,
        COUNT(*) as count
      FROM users
      GROUP BY role, user_type
    `);

    console.log('📊 Final Distribution:');
    console.table(summary);

  } catch (error) {
    console.error('❌ Error updating user_type ENUM:', error.message);
    throw error;
  } finally {
    await connection.end();
  }
}

/**
 * Adds a new role slug to the user_type ENUM (for future use)
 * @param {string} newSlug - The new slug to add
 */
async function addNewRoleToEnum(newSlug) {
  const connection = await mysql.createConnection(dbConfig);

  try {
    console.log(`\n🔄 Adding '${newSlug}' to ENUM...`);

    // Get current ENUM values
    const [result] = await connection.query(`
      SELECT COLUMN_TYPE 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'users' 
        AND COLUMN_NAME = 'user_type'
        AND TABLE_SCHEMA = DATABASE()
    `);

    const enumType = result[0].COLUMN_TYPE;
    const currentValues = enumType
      .match(/'([^']+)'/g)
      .map(v => v.replace(/'/g, ''));

    if (currentValues.includes(newSlug)) {
      console.log(`ℹ️  '${newSlug}' already exists!`);
      return;
    }

    // Add new value
    currentValues.push(newSlug);
    const newEnum = currentValues.map(v => `'${v}'`).join(', ');

    await connection.query(`
      ALTER TABLE users 
      MODIFY COLUMN user_type ENUM(${newEnum}) DEFAULT 'admin'
    `);

    console.log(`✅ Added '${newSlug}' to user_type ENUM`);

  } catch (error) {
    console.error('❌ Error adding role to ENUM:', error.message);
    throw error;
  } finally {
    await connection.end();
  }
}

/**
 * Removes a role slug from the user_type ENUM and updates affected users
 * @param {string} slugToRemove - The slug to remove
 */
async function removeRoleFromEnum(slugToRemove) {
  const connection = await mysql.createConnection(dbConfig);

  try {
    console.log(`\n🗑️  Removing '${slugToRemove}' from ENUM...`);

    // First, check if any users have this user_type
    const [usersWithType] = await connection.query(
      'SELECT id, email FROM users WHERE user_type = ?',
      [slugToRemove]
    );

    if (usersWithType.length > 0) {
      console.log(`⚠️  Found ${usersWithType.length} users with user_type '${slugToRemove}'`);
      
      // Get default slug to reassign users to
      const [availableRoles] = await connection.query(
        'SELECT slug FROM role_permissions WHERE slug != ? ORDER BY slug LIMIT 1',
        [slugToRemove]
      );

      const fallbackSlug = availableRoles.length > 0 ? availableRoles[0].slug : 'admin';
      
      // Update affected users
      await connection.query(
        'UPDATE users SET user_type = ? WHERE user_type = ?',
        [fallbackSlug, slugToRemove]
      );
      
      console.log(`✅ Updated ${usersWithType.length} users from '${slugToRemove}' to '${fallbackSlug}'`);
    }

    // Get current ENUM values
    const [result] = await connection.query(`
      SELECT COLUMN_TYPE 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'users' 
        AND COLUMN_NAME = 'user_type'
        AND TABLE_SCHEMA = DATABASE()
    `);

    const enumType = result[0].COLUMN_TYPE;
    const currentValues = enumType
      .match(/'([^']+)'/g)
      .map(v => v.replace(/'/g, ''));

    // Remove the slug
    const updatedValues = currentValues.filter(v => v !== slugToRemove);
    
    if (updatedValues.length === currentValues.length) {
      console.log(`ℹ️  '${slugToRemove}' was not in ENUM`);
      return;
    }

    const newEnum = updatedValues.map(v => `'${v}'`).join(', ');

    await connection.query(`
      ALTER TABLE users 
      MODIFY COLUMN user_type ENUM(${newEnum}) DEFAULT 'admin'
    `);

    console.log(`✅ Removed '${slugToRemove}' from user_type ENUM`);

  } catch (error) {
    console.error('❌ Error removing role from ENUM:', error.message);
    throw error;
  } finally {
    await connection.end();
  }
}

module.exports = {
  updateUserTypeEnum,
  addNewRoleToEnum,
  removeRoleFromEnum
};