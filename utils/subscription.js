const { getMySQLConnection } = require('../config/mysql');

/**
 * Check if user has an active subscription
 * @param {number} userId - User ID
 * @returns {Promise<Object|null>} - Active subscription object or null
 */
const getActiveSubscription = async (userId) => {
  try {
    const mysqlConnection = getMySQLConnection();
    
    const [userSubscriptions] = await mysqlConnection.execute(
      `SELECT us.*, s.name as subscription_name, s.role as subscription_role, s.features 
       FROM user_subscriptions us 
       JOIN subscriptions_new s ON us.subscription_id = s.id 
       WHERE us.user_id = ? AND us.status = "active" AND us.end_date IS NOT NULL AND us.end_date > NOW()
       ORDER BY us.created_at DESC 
       LIMIT 1`,
      [userId]
    );

    if (userSubscriptions.length === 0) {
      return null;
    }

    const subscription = userSubscriptions[0];
    return {
      ...subscription,
      features: JSON.parse(subscription.features || '[]')
    };
  } catch (error) {
    console.error('Error getting active subscription:', error);
    return null;
  }
};

/**
 * Check if user has required role for a specific feature
 * @param {string} userRole - User's current role
 * @param {string} requiredRole - Required role for the feature
 * @returns {boolean} - Whether user has access
 */
const hasRoleAccess = (userRole, requiredRole) => {
  const roleHierarchy = {
    'sl_team': 7,
    'onelicense': 6,
    'music': 5,
    'educator': 4,
    'planner': 3,
    'documents': 2,
    'composer': 1
  };

  return roleHierarchy[userRole] >= roleHierarchy[requiredRole];
};

/**
 * Check if user has access to a specific feature
 * @param {number} userId - User ID
 * @param {string} feature - Feature name to check
 * @returns {Promise<boolean>} - Whether user has access to the feature
 */
const hasFeatureAccess = async (userId, feature) => {
  try {
    const activeSubscription = await getActiveSubscription(userId);
    
    if (!activeSubscription) {
      return false;
    }

    return activeSubscription.features.includes(feature);
  } catch (error) {
    console.error('Error checking feature access:', error);
    return false;
  }
};

/**
 * Update user role based on subscription status
 * @param {number} userId - User ID
 * @returns {Promise<string>} - Updated role
 */
const updateUserRole = async (userId) => {
  try {
    const mysqlConnection = getMySQLConnection();
    
    const activeSubscription = await getActiveSubscription(userId);
    
    if (activeSubscription) {
      // Update user role to match subscription role
      await mysqlConnection.execute(
        'UPDATE users SET role = ? WHERE id = ?',
        [activeSubscription.subscription_role, userId]
      );
      return activeSubscription.subscription_role;
    } else {
      // Set to default role if no active subscription
      await mysqlConnection.execute(
        'UPDATE users SET role = ? WHERE id = ?',
        ['composer', userId]
      );
      return 'composer';
    }
  } catch (error) {
    console.error('Error updating user role:', error);
    return 'composer';
  }
};

/**
 * Get subscription status for a user
 * @param {number} userId - User ID
 * @returns {Promise<Object>} - Subscription status object
 */
const getSubscriptionStatus = async (userId) => {
  try {
    const activeSubscription = await getActiveSubscription(userId);
    
    if (!activeSubscription) {
      return {
        hasActiveSubscription: false,
        subscription: null,
        daysRemaining: 0,
        isExpired: true
      };
    }

    const now = new Date();
    const endDate = new Date(activeSubscription.end_date);
    const daysRemaining = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));

    return {
      hasActiveSubscription: true,
      subscription: activeSubscription,
      daysRemaining: Math.max(0, daysRemaining),
      isExpired: daysRemaining <= 0
    };
  } catch (error) {
    console.error('Error getting subscription status:', error);
    return {
      hasActiveSubscription: false,
      subscription: null,
      daysRemaining: 0,
      isExpired: true
    };
  }
};

module.exports = {
  getActiveSubscription,
  hasRoleAccess,
  hasFeatureAccess,
  updateUserRole,
  getSubscriptionStatus
};
