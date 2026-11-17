const { errorResponse } = require('../utils/response');
const { hasRoleAccess, hasFeatureAccess, getSubscriptionStatus } = require('../utils/subscription');

/**
 * Middleware to check if user has required role
 * @param {string} requiredRole - Minimum required role
 * @returns {Function} - Express middleware function
 */
const requireRole = (requiredRole) => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return errorResponse(res, 'Authentication required', 401);
      }

      const userRole = req.user.role;

      if (!hasRoleAccess(userRole, requiredRole)) {
        return errorResponse(res, `Access denied. Required role: ${requiredRole}`, 403);
      }

      next();
    } catch (error) {
      console.error('Role check error:', error);
      errorResponse(res, 'Access check failed', 500);
    }
  };
};

/**
 * Middleware to check if user is a composer
 * @returns {Function} - Express middleware function
 */
const requireComposer = () => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return errorResponse(res, 'Authentication required', 401);
      }

      if (!req.user.is_composer) {
        return errorResponse(res, 'Access denied. Composer access required', 403);
      }

      next();
    } catch (error) {
      console.error('Composer check error:', error);
      errorResponse(res, 'Composer access check failed', 500);
    }
  };
};

/**
 * Middleware to check if user is composer OR has specific role
 * @param {string} alternativeRole - Alternative role if not composer
 * @returns {Function} - Express middleware function
 */
const requireComposerOrRole = (alternativeRole) => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return errorResponse(res, 'Authentication required', 401);
      }

      const isComposer = !!req.user.is_composer;
      const hasMatchingRole = alternativeRole
        ? req.user.role === alternativeRole
        : false;

      // ✅ Allow if composer OR role matches
      if (isComposer || hasMatchingRole) {
        return next();
      }

      // ❌ Otherwise deny
      return errorResponse(
        res,
        `Access denied. Required: Composer access OR ${alternativeRole || 'authorized'} role`,
        403
      );
    } catch (error) {
      console.error('Composer or role check error:', error);
      return errorResponse(res, 'Access check failed', 500);
    }
  };
};



/**
 * Middleware to check if user has required feature access
 * @param {string} requiredFeature - Required feature name
 * @returns {Function} - Express middleware function
 */
const requireFeature = (requiredFeature) => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return errorResponse(res, 'Authentication required', 401);
      }

      const hasAccess = await hasFeatureAccess(req.user.id, requiredFeature);

      if (!hasAccess) {
        return errorResponse(res, `Feature access denied. Required feature: ${requiredFeature}`, 403);
      }

      next();
    } catch (error) {
      console.error('Feature check error:', error);
      errorResponse(res, 'Feature access check failed', 500);
    }
  };
};

/**
 * Middleware to check if user has active subscription
 * @returns {Function} - Express middleware function
 */
const requireActiveSubscription = () => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return errorResponse(res, 'Authentication required', 401);
      }

      const subscriptionStatus = await getSubscriptionStatus(req.user.id);

      if (!subscriptionStatus.hasActiveSubscription || subscriptionStatus.isExpired) {
        return errorResponse(res, 'Active subscription required', 403);
      }

      // Add subscription info to request
      req.subscription = subscriptionStatus.subscription;
      req.subscriptionStatus = subscriptionStatus;

      next();
    } catch (error) {
      console.error('Subscription check error:', error);
      errorResponse(res, 'Subscription check failed', 500);
    }
  };
};

/**
 * Middleware to check if user has specific role (exact match)
 * @param {string} exactRole - Exact required role
 * @returns {Function} - Express middleware function
 */
const requireExactRole = (exactRole) => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return errorResponse(res, 'Authentication required', 401);
      }

      if (req.user.role !== exactRole) {
        return errorResponse(res, `Access denied. Required role: ${exactRole}`, 403);
      }

      next();
    } catch (error) {
      console.error('Exact role check error:', error);
      errorResponse(res, 'Role check failed', 500);
    }
  };
};

/**
 * Middleware to check if user has one of the specified roles
 * @param {Array} allowedRoles - Array of allowed roles
 * @returns {Function} - Express middleware function
 */
const requireAnyRole = (allowedRoles) => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return errorResponse(res, 'Authentication required', 401);
      }

      if (!allowedRoles.includes(req.user.role)) {
        return errorResponse(res, `Access denied. Allowed roles: ${allowedRoles.join(', ')}`, 403);
      }

      next();
    } catch (error) {
      console.error('Any role check error:', error);
      errorResponse(res, 'Role check failed', 500);
    }
  };
};

module.exports = {
  requireRole,
  requireComposer,
  requireComposerOrRole,
  requireFeature,
  requireActiveSubscription,
  requireExactRole,
  requireAnyRole
};
