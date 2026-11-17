const jwt = require('jsonwebtoken');
const { getMySQLConnection } = require('../config/mysql');

const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.'
      });
    }

    const jwtSecret = process.env.JWT_SECRET || 'your-super-secret-jwt-key-for-sl-music-backend-2024';
    const decoded = jwt.verify(token, jwtSecret);
    console.log('🔍 Auth Debug - Decoded token:', decoded);
    const mysqlConnection = getMySQLConnection();

    // Get user from MySQL
    const [users] = await mysqlConnection.execute(
      'SELECT * FROM users WHERE id = ?',
      [decoded.userId]
    );

    if (users.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid token. User not found.'
      });
    }

    const user = users[0];

    if (!user.is_active) {
      return res.status(401).json({
        success: false,
        message: 'Account is deactivated.'
      });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token.'
      });
    }

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired.'
      });
    }

    console.error('Auth middleware error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error.'
    });
  }
};

const requireAnyRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required.'
      });
    }

    const userRole = req.user.role;

    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Insufficient permissions.'
      });
    }

    next();
  };
};

// const requireAnyRole = (allowedRoles) => {
//   return (req, res, next) => {
//     if (!req.user) {
//       return res.status(401).json({
//         success: false,
//         message: "Authentication required.",
//       });
//     }

//     const userRole = req.user.role;
//     const userType = req.user.user_type || req.user.userType;

//     // Condition: BOTH must match
//     const isRoleAllowed = userRole && allowedRoles.includes(userRole);
//     const isUserTypeAllowed = userType && allowedRoles.includes(userType);

//     if (!isRoleAllowed || !isUserTypeAllowed) {
//       return res.status(403).json({
//         success: false,
//         message: "Access denied. Insufficient permissions.",
//       });
//     }

//     next();
//   };
// };

const requireSLTeamWithTypes = (allowedUserTypes = []) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    const role = req.user.role;
    const userType = req.user.user_type || req.user.userType;

    // Must be sl_team role
    if (role !== "sl_team") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Only sl team role can perform this action.",
      });
    }

    // user_type must be inside allowed list
    if (!allowedUserTypes.includes(userType)) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You don't have the required permissions.",
      });
    }

    next();
  };
};


module.exports = { auth, requireAnyRole, requireSLTeamWithTypes };