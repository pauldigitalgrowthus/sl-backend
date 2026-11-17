const axios = require('axios');
const jwt = require('jsonwebtoken');
const { getMySQLConnection } = require('../../config/mysql');

const getQbAuthConfig = () => {
  return {
    clientId: process.env.QB_CLIENT_ID,
    clientSecret: process.env.QB_CLIENT_SECRET,
    redirectUri: process.env.QB_REDIRECT_URI,
    env: (process.env.QB_ENV || 'sandbox').toLowerCase()
  };
};

/**
 * Generate QuickBooks Authorization URL
 * @param {string|object} stateData - Optional state data payload
 */
const getAuthUrl = (stateData = {}) => {
  const config = getQbAuthConfig();
  if (!config.clientId || !config.clientSecret || !config.redirectUri) {
    throw new Error('QuickBooks environment variables (QB_CLIENT_ID, QB_CLIENT_SECRET, QB_REDIRECT_URI) are not configured.');
  }

  const crypto = require('crypto');
  const stateToken = typeof stateData === 'string' ? stateData : (stateData.nonce || crypto.randomBytes(16).toString('hex'));

  const scope = 'com.intuit.quickbooks.accounting openid profile email phone address';

  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    scope: scope,
    redirect_uri: config.redirectUri,
    state: stateToken
  });

  return `https://appcenter.intuit.com/connect/oauth2?${params.toString()}`;
};

/**
 * Validate state token returned from OAuth callback
 */
const validateState = (stateToken) => {
  try {
    const secret = process.env.JWT_SECRET || 'sl_qb_secret';
    const decoded = jwt.verify(stateToken, secret);
    return { valid: true, data: decoded.data };
  } catch (err) {
    return { valid: false, error: err.message };
  }
};

/**
 * Exchange Authorization Code for Tokens
 */
const exchangeCodeForToken = async ({ code, realmId }) => {
  const config = getQbAuthConfig();
  const tokenUrl = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

  const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: config.redirectUri
  });

  try {
    const response = await axios.post(tokenUrl, params.toString(), {
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      }
    });

    const tokenData = response.data;
    const now = new Date();
    
    // access_token expires_in is in seconds (typically 3600 = 1 hr)
    const accessTokenExpiresAt = new Date(now.getTime() + (tokenData.expires_in || 3600) * 1000);
    // x_refresh_token_expires_in is in seconds (typically 8640000 = 100 days)
    const refreshTokenExpiresAt = new Date(now.getTime() + (tokenData.x_refresh_token_expires_in || 8640000) * 1000);

    const mysql = getMySQLConnection();

    await mysql.execute(
      `INSERT INTO quickbooks_connections 
        (realm_id, access_token, refresh_token, access_token_expires_at, refresh_token_expires_at, status, environment)
       VALUES (?, ?, ?, ?, ?, 'active', ?)
       ON DUPLICATE KEY UPDATE
        access_token = VALUES(access_token),
        refresh_token = VALUES(refresh_token),
        access_token_expires_at = VALUES(access_token_expires_at),
        refresh_token_expires_at = VALUES(refresh_token_expires_at),
        status = 'active',
        environment = VALUES(environment),
        updated_at = NOW()`,
      [
        realmId,
        tokenData.access_token,
        tokenData.refresh_token,
        accessTokenExpiresAt,
        refreshTokenExpiresAt,
        config.env
      ]
    );

    return {
      realmId,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
      status: 'active'
    };
  } catch (error) {
    const errorMsg = error.response?.data?.error_description || error.response?.data?.error || error.message;
    console.error('❌ QuickBooks OAuth Code Exchange Failed:', errorMsg);
    throw new Error(`QuickBooks Authorization Exchange Failed: ${errorMsg}`);
  }
};

/**
 * Refresh Access Token using stored Refresh Token
 */
const refreshAccessToken = async (realmId) => {
  const config = getQbAuthConfig();
  const mysql = getMySQLConnection();

  let connRow;
  if (realmId) {
    const [rows] = await mysql.execute(
      `SELECT * FROM quickbooks_connections WHERE realm_id = ? LIMIT 1`,
      [realmId]
    );
    connRow = rows[0];
  } else {
    // Get latest active connection
    const [rows] = await mysql.execute(
      `SELECT * FROM quickbooks_connections WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1`
    );
    connRow = rows[0];
  }

  if (!connRow) {
    throw new Error('QuickBooks is not connected. Please connect QuickBooks first.');
  }

  const tokenUrl = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
  const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: connRow.refresh_token
  });

  try {
    const response = await axios.post(tokenUrl, params.toString(), {
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      }
    });

    const tokenData = response.data;
    const now = new Date();

    const accessTokenExpiresAt = new Date(now.getTime() + (tokenData.expires_in || 3600) * 1000);
    const refreshTokenExpiresAt = new Date(now.getTime() + (tokenData.x_refresh_token_expires_in || 8640000) * 1000);

    const newAccessToken = tokenData.access_token;
    const newRefreshToken = tokenData.refresh_token || connRow.refresh_token;

    await mysql.execute(
      `UPDATE quickbooks_connections
       SET access_token = ?,
           refresh_token = ?,
           access_token_expires_at = ?,
           refresh_token_expires_at = ?,
           status = 'active',
           updated_at = NOW()
       WHERE realm_id = ?`,
      [newAccessToken, newRefreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, connRow.realm_id]
    );

    return {
      realmId: connRow.realm_id,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
      status: 'active'
    };
  } catch (error) {
    const errorMsg = error.response?.data?.error_description || error.response?.data?.error || error.message;
    console.error('❌ QuickBooks Token Refresh Failed:', errorMsg);

    // Mark status as requires_reauthorization
    await mysql.execute(
      `UPDATE quickbooks_connections SET status = 'requires_reauthorization', updated_at = NOW() WHERE realm_id = ?`,
      [connRow.realm_id]
    );

    const customErr = new Error('QuickBooks authorization expired. Please reconnect your QuickBooks account.');
    customErr.code = 'QB_REAUTH_REQUIRED';
    throw customErr;
  }
};

/**
 * Get Valid Access Token (Refreshes automatically if expired or near expiry)
 */
const getValidAccessToken = async (targetRealmId = null, forceRefresh = false) => {
  const mysql = getMySQLConnection();

  let connRow;
  if (targetRealmId) {
    const [rows] = await mysql.execute(
      `SELECT * FROM quickbooks_connections WHERE realm_id = ? LIMIT 1`,
      [targetRealmId]
    );
    connRow = rows[0];
  } else {
    const [rows] = await mysql.execute(
      `SELECT * FROM quickbooks_connections WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1`
    );
    connRow = rows[0];
  }

  if (!connRow) {
    const err = new Error('QuickBooks is not connected. Please connect QuickBooks before proceeding.');
    err.code = 'QB_NOT_CONNECTED';
    throw err;
  }

  if (connRow.status === 'requires_reauthorization') {
    const err = new Error('QuickBooks authorization expired. Please reconnect QuickBooks account.');
    err.code = 'QB_REAUTH_REQUIRED';
    throw err;
  }

  const now = new Date();
  const expiresAt = new Date(connRow.access_token_expires_at);

  // Buffer: If token expires within 5 minutes or forceRefresh is true, refresh it
  const bufferMs = 5 * 60 * 1000;
  if (forceRefresh || (expiresAt.getTime() - now.getTime()) <= bufferMs) {
    console.log(`🔄 QuickBooks access token expired or expiring soon. Refreshing token for realm ${connRow.realm_id}...`);
    const refreshed = await refreshAccessToken(connRow.realm_id);
    return {
      accessToken: refreshed.accessToken,
      realmId: refreshed.realmId
    };
  }

  return {
    accessToken: connRow.access_token,
    realmId: connRow.realm_id
  };
};

/**
 * Get Connection Status
 */
const getConnectionStatus = async (realmIdParam = null) => {
  try {
    const mysql = getMySQLConnection();
    let query = `SELECT realm_id, status, environment, access_token_expires_at, refresh_token_expires_at, connected_at, updated_at FROM quickbooks_connections`;
    const params = [];

    if (realmIdParam) {
      query += ` WHERE realm_id = ? LIMIT 1`;
      params.push(realmIdParam);
    } else {
      query += ` ORDER BY updated_at DESC LIMIT 1`;
    }

    const [rows] = await mysql.execute(query, params);
    if (rows.length === 0) {
      return { connected: false, status: 'disconnected', details: null };
    }

    const row = rows[0];
    const now = new Date();
    const accessExpires = new Date(row.access_token_expires_at);
    const isAccessValid = accessExpires > now;

    return {
      connected: row.status === 'active',
      realmId: row.realm_id,
      status: row.status,
      environment: row.environment,
      isAccessValid,
      accessTokenExpiresAt: row.access_token_expires_at,
      connectedAt: row.connected_at,
      updatedAt: row.updated_at
    };
  } catch (error) {
    return { connected: false, status: 'error', error: error.message };
  }
};

/**
 * Disconnect QuickBooks account
 */
const disconnect = async (realmIdParam = null) => {
  const mysql = getMySQLConnection();
  let connRow;

  if (realmIdParam) {
    const [rows] = await mysql.execute(
      `SELECT * FROM quickbooks_connections WHERE realm_id = ? LIMIT 1`,
      [realmIdParam]
    );
    connRow = rows[0];
  } else {
    const [rows] = await mysql.execute(
      `SELECT * FROM quickbooks_connections WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1`
    );
    connRow = rows[0];
  }

  if (!connRow) {
    return { success: true, message: 'No active QuickBooks connection found' };
  }

  // Revoke token via Intuit Revoke API
  const config = getQbAuthConfig();
  const revokeUrl = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
  const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

  try {
    await axios.post(
      revokeUrl,
      new URLSearchParams({ token: connRow.refresh_token }).toString(),
      {
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
  } catch (err) {
    console.warn('⚠️ Token revocation API warning:', err.message);
  }

  await mysql.execute(
    `UPDATE quickbooks_connections SET status = 'disconnected', updated_at = NOW() WHERE realm_id = ?`,
    [connRow.realm_id]
  );

  return { success: true, realmId: connRow.realm_id, message: 'QuickBooks disconnected successfully' };
};

module.exports = {
  getQbAuthConfig,
  getAuthUrl,
  validateState,
  exchangeCodeForToken,
  refreshAccessToken,
  getValidAccessToken,
  getConnectionStatus,
  disconnect
};
