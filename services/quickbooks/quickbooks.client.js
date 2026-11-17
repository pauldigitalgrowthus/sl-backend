const axios = require('axios');
const { getValidAccessToken } = require('./quickbooks.oauth');

/**
 * Get base URL for QuickBooks API according to QB_ENV
 */
const getQbBaseUrl = () => {
  const env = (process.env.QB_ENV || 'sandbox').toLowerCase();
  return env === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
};

/**
 * Make an authenticated request to QuickBooks Online API.
 * Handles auto-token refresh & automatic single retry on 401.
 */
const makeApiRequest = async (realmIdParam = null, options = {}) => {
  const { accessToken, realmId } = await getValidAccessToken(realmIdParam);

  const baseUrl = getQbBaseUrl();
  const method = options.method || 'GET';
  let url = options.url;

  if (!url.startsWith('http')) {
    // If full endpoint not provided, prefix with base company URL
    url = `${baseUrl}/v3/company/${realmId}${url.startsWith('/') ? '' : '/'}${url}`;
  }

  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  try {
    const response = await axios({
      method,
      url,
      headers,
      data: options.data || null,
      params: options.params || null
    });

    return response.data;
  } catch (error) {
    // Handle 401 Unauthorized by trying forced token refresh once
    if (error.response && error.response.status === 401 && !options._retried) {
      console.warn('⚠️ QuickBooks API 401 Unauthorized. Retrying with fresh access token...');
      const { accessToken: newAccessToken } = await getValidAccessToken(realmId, true);
      headers['Authorization'] = `Bearer ${newAccessToken}`;

      const retryResponse = await axios({
        method,
        url,
        headers,
        data: options.data || null,
        params: options.params || null
      });

      return retryResponse.data;
    }

    const qbErrorMsg = error.response?.data?.Fault?.Error?.[0]?.Message ||
                       error.response?.data?.Fault?.Error?.[0]?.Detail ||
                       error.response?.data?.message ||
                       error.message;

    console.error(`❌ QuickBooks API Error (${method} ${url}):`, qbErrorMsg, error.response?.data || '');
    const customError = new Error(`QuickBooks API Error: ${qbErrorMsg}`);
    customError.statusCode = error.response?.status || 500;
    customError.qbData = error.response?.data;
    throw customError;
  }
};

/**
 * Helper to run QuickBooks SQL-like query SELECT statement
 */
const queryQb = async (realmId, queryStr) => {
  const encodedQuery = encodeURIComponent(queryStr);
  const data = await makeApiRequest(realmId, {
    method: 'GET',
    url: `/query?query=${encodedQuery}`
  });
  return data?.QueryResponse || {};
};

module.exports = {
  getQbBaseUrl,
  makeApiRequest,
  queryQb
};
