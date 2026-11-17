const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { getMySQLConnection } = require('../../config/mysql');

let io = null;

/**
 * Initializes Socket.IO on top of the existing HTTP server.
 * This is purely additive - the REST API in this folder does not depend on
 * sockets being connected. All emit helpers below are no-ops (with a warning
 * log) if this hasn't been called yet, so Postman / REST testing is never
 * affected by the socket layer.
 */
const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.CLIENT_URL || '*',
      methods: ['GET', 'POST'],
      credentials: true
    },
    path: '/socket.io'
  });

  // ---- Authenticate every socket connection with the same JWT used by REST ----
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) return next(new Error('Authentication token missing'));

      const jwtSecret = process.env.JWT_SECRET || 'your-super-secret-jwt-key-for-sl-music-backend-2024';
      const decoded = jwt.verify(token, jwtSecret);

      const mysqlConnection = getMySQLConnection();
      const [users] = await mysqlConnection.execute(
        'SELECT id, first_name, last_name, avatar, role, user_type, is_active FROM users WHERE id = ?',
        [decoded.userId]
      );

      if (users.length === 0 || !users[0].is_active) {
        return next(new Error('Invalid token. User not found or inactive.'));
      }

      socket.user = users[0];
      next();
    } catch (err) {
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.user.id;
    console.log(`🔌 Community Portal socket connected: user ${userId} (${socket.id})`);

    // Personal room - used for DM pings, join-approval notices, moderation notices, etc.
    socket.join(`user:${userId}`);

    socket.on('join_feed', () => socket.join('feed:global'));
    socket.on('leave_feed', () => socket.leave('feed:global'));

    socket.on('join_channel', (channelId) => channelId && socket.join(`channel:${channelId}`));
    socket.on('leave_channel', (channelId) => channelId && socket.leave(`channel:${channelId}`));

    socket.on('join_group', (groupId) => groupId && socket.join(`group:${groupId}`));
    socket.on('leave_group', (groupId) => groupId && socket.leave(`group:${groupId}`));

    socket.on('join_conversation', (conversationId) => conversationId && socket.join(`conversation:${conversationId}`));
    socket.on('leave_conversation', (conversationId) => conversationId && socket.leave(`conversation:${conversationId}`));

    socket.on('join_prayer_wall', () => socket.join('prayer:global'));
    socket.on('leave_prayer_wall', () => socket.leave('prayer:global'));

    // Admin / SL Team clients can join this to receive moderation pings
    socket.on('join_moderation', () => {
      if (socket.user.role === 'sl_team' || socket.user.user_type === 'superadmin') {
        socket.join('moderation:global');
      }
    });

    socket.on('disconnect', () => {
      console.log(`🔌 Community Portal socket disconnected: user ${userId} (${socket.id})`);
    });
  });

  console.log('✅ Community Portal Socket.IO initialized');
  return io;
};

const getIO = () => io;

/**
 * Resolve which room a piece of feed/discussion content belongs to,
 * based on channel_id / group_id, falling back to the global room.
 */
const contentScopeRoom = ({ channel_id, group_id }, globalRoom) => {
  if (channel_id) return `channel:${channel_id}`;
  if (group_id) return `group:${group_id}`;
  return globalRoom;
};

/**
 * Safe emit - never throws. If the socket server isn't initialized
 * (e.g. running a script, or sockets disabled), this just logs and
 * REST responses are completely unaffected.
 */
const emitToRoom = (room, event, payload) => {
  try {
    if (io) io.to(room).emit(event, payload);
  } catch (err) {
    console.warn(`⚠️ Socket emit failed (room: ${room}, event: ${event}):`, err.message);
  }
};

const emitToUser = (userId, event, payload) => emitToRoom(`user:${userId}`, event, payload);

module.exports = { initSocket, getIO, emitToRoom, emitToUser, contentScopeRoom };
