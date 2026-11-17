// ============================================
// HELPER FUNCTIONS
// ============================================

exports.parseJsonSafe = (value, fallback) => {
    if (value === null || value === undefined) return fallback;
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch (_) {
        return fallback;
    }
};

exports.stringifyJsonSafe = (value) => {
    try {
        return JSON.stringify(value);
    } catch (_) {
        return JSON.stringify([]);
    }
};

exports.resolveCommunityId = async (connection, userId) => {
    const [[user]] = await connection.execute(
        `SELECT id, user_type, parent_user_id FROM users WHERE id = ?`,
        [userId]
    );

    if (!user) throw new Error('User not found');

    return (user.user_type === 'sub_user' || user.user_type === 'manager') && user.parent_user_id
        ? user.parent_user_id
        : user.id;
};