const { getMySQLConnection } = require('../config/mysql');

/**
 * Clean up expired and used OTPs from the database
 * This function removes:
 * 1. OTPs that have expired (expires_at < NOW())
 * 2. OTPs that have been used (is_used = TRUE)
 */
const cleanupExpiredOTPs = async () => {
  try {
    const mysqlConnection = getMySQLConnection();
    
    // Delete expired and used OTPs
    const [result] = await mysqlConnection.execute(
      'DELETE FROM password_reset_otps WHERE is_used = TRUE OR expires_at < NOW()'
    );
    
    if (result.affectedRows > 0) {
      console.log(`🧹 Cleaned up ${result.affectedRows} expired/used OTP records`);
    }
    
    return result.affectedRows;
  } catch (error) {
    console.error('❌ Error cleaning up OTPs:', error);
    throw error;
  }
};

/**
 * Start periodic cleanup of expired OTPs
 * Runs cleanup every 5 minutes
 */
const startOTPCleanupScheduler = () => {
  // Run cleanup immediately
  cleanupExpiredOTPs().catch(console.error);
  
  // Schedule cleanup every 5 minutes (300,000 milliseconds)
  setInterval(() => {
    cleanupExpiredOTPs().catch(console.error);
  }, 5 * 60 * 1000);
  
  console.log('🕒 OTP cleanup scheduler started (runs every 5 minutes)');
};

/**
 * Clean up all OTPs for a specific user
 * @param {number} userId - The user ID
 */
const cleanupUserOTPs = async (userId) => {
  try {
    const mysqlConnection = getMySQLConnection();
    
    const [result] = await mysqlConnection.execute(
      'DELETE FROM password_reset_otps WHERE user_id = ?',
      [userId]
    );
    
    return result.affectedRows;
  } catch (error) {
    console.error('❌ Error cleaning up user OTPs:', error);
    throw error;
  }
};

/**
 * Get OTP statistics
 */
const getOTPStats = async () => {
  try {
    const mysqlConnection = getMySQLConnection();
    
    const [totalCount] = await mysqlConnection.execute(
      'SELECT COUNT(*) as total FROM password_reset_otps'
    );
    
    const [activeCount] = await mysqlConnection.execute(
      'SELECT COUNT(*) as active FROM password_reset_otps WHERE is_used = FALSE AND expires_at > NOW()'
    );
    
    const [expiredCount] = await mysqlConnection.execute(
      'SELECT COUNT(*) as expired FROM password_reset_otps WHERE expires_at <= NOW()'
    );
    
    const [usedCount] = await mysqlConnection.execute(
      'SELECT COUNT(*) as used FROM password_reset_otps WHERE is_used = TRUE'
    );
    
    return {
      total: totalCount[0].total,
      active: activeCount[0].active,
      expired: expiredCount[0].expired,
      used: usedCount[0].used
    };
  } catch (error) {
    console.error('❌ Error getting OTP stats:', error);
    throw error;
  }
};

module.exports = {
  cleanupExpiredOTPs,
  startOTPCleanupScheduler,
  cleanupUserOTPs,
  getOTPStats
};