const express = require('express');
const { auth } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');
const qbService = require('../services/quickbooks/quickbooks.service');

const router = express.Router();

/**
 * @route   GET /api/quickbooks/connect
 * @desc    Initiate QuickBooks OAuth 2.0 connection (redirects to Intuit or returns auth URL)
 * @access  Public / Private (Admin)
 */
router.get('/connect', async (req, res) => {
  try {
    const returnUrl = req.query.returnUrl || '/sl-royalty/payouts';
    const stateData = {
      userId: req.user?.id || 1,
      userType: req.user?.user_type || 'superadmin',
      returnUrl
    };

    const authUrl = qbService.getAuthUrl(stateData);

    // If request explicitly requests JSON response, return JSON, else redirect to Intuit
    if (req.query.json === 'true' && req.headers.accept?.includes('application/json')) {
      return successResponse(res, { authUrl }, 'QuickBooks authorization URL generated');
    }

    return res.redirect(authUrl);
  } catch (error) {
    console.error('QuickBooks connect error:', error);
    return errorResponse(res, error.message || 'Failed to initiate QuickBooks authorization', 500);
  }
});

/**
 * @route   GET /api/quickbooks/callback
 * @desc    QuickBooks OAuth 2.0 Callback handler
 * @access  Public (Called by Intuit redirect)
 */
router.get('/callback', async (req, res) => {
  try {
    const { code, realmId, state, error: qbError } = req.query;
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    let targetPath = '/sl-royalty/payouts';
    // Validate state token if provided
    if (state) {
      const stateValidation = qbService.validateState(state);
      if (stateValidation.valid && stateValidation.data?.returnUrl) {
        targetPath = stateValidation.data.returnUrl;
      } else if (!stateValidation.valid) {
        console.warn('⚠️ QuickBooks OAuth state validation warning:', stateValidation.error);
      }
    }

    if (qbError) {
      console.error('QuickBooks OAuth Access Denied by User:', qbError);
      return res.redirect(`${frontendUrl}${targetPath}?qb_error=${encodeURIComponent(qbError)}`);
    }

    if (!code || !realmId) {
      return errorResponse(res, 'Missing code or realmId in QuickBooks callback', 400);
    }

    // Exchange authorization code for tokens and store in DB
    const connResult = await qbService.exchangeCodeForToken({ code, realmId });
    
    // Check if client expects HTML/Redirect or JSON
    if (req.headers.accept?.includes('text/html') || req.query.redirect !== 'false') {
      return res.redirect(`${frontendUrl}${targetPath}?qb_connected=true&realmId=${realmId}`);
    }

    return successResponse(res, connResult, 'QuickBooks connected successfully');
  } catch (error) {
    console.error('QuickBooks callback error:', error);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    return res.redirect(`${frontendUrl}/sl-royalty/payouts?qb_error=${encodeURIComponent(error.message)}`);
  }
});

/**
 * @route   GET /api/quickbooks/status
 * @desc    Get QuickBooks Online connection status
 * @access  Private (Admin / Superadmin)
 */
router.get('/status', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const { realmId } = req.query;
    const status = await qbService.getConnectionStatus(realmId || null);

    return successResponse(res, status, 'QuickBooks connection status fetched');
  } catch (error) {
    console.error('QuickBooks status error:', error);
    return errorResponse(res, 'Failed to fetch QuickBooks status', 500);
  }
});

/**
 * @route   POST /api/quickbooks/disconnect
 * @desc    Disconnect QuickBooks Online connection
 * @access  Private (Admin / Superadmin)
 */
router.post('/disconnect', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const { realmId } = req.body;
    const result = await qbService.disconnect(realmId || null);

    return successResponse(res, result, 'QuickBooks disconnected successfully');
  } catch (error) {
    console.error('QuickBooks disconnect error:', error);
    return errorResponse(res, 'Failed to disconnect QuickBooks', 500);
  }
});

/**
 * @route   GET /api/quickbooks/accounts
 * @desc    Query Chart of Accounts from QuickBooks Online
 * @access  Private (Admin / Superadmin)
 */
router.get('/accounts', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const connStatus = await qbService.getConnectionStatus();
    if (!connStatus.connected) {
      return errorResponse(res, 'QuickBooks is not connected. Please connect QuickBooks first.', 400);
    }

    const realmId = connStatus.realmId;
    const accounts = await qbService.queryChartOfAccounts(realmId);
    const dbConfig = await qbService.account.getAccountConfigFromDb(realmId);

    // Helper categorized lists
    const apAccounts = accounts.filter(a => a.AccountType === 'Accounts Payable');
    const expenseAccounts = accounts.filter(a => ['Expense', 'Cost of Goods Sold', 'Other Expense'].includes(a.AccountType));
    const bankAccounts = accounts.filter(a => ['Bank', 'Credit Card'].includes(a.AccountType));

    return successResponse(res, {
      allAccounts: accounts,
      categorized: {
        apAccounts,
        expenseAccounts,
        bankAccounts
      },
      configuredAccountIds: {
        apAccountId: dbConfig?.ap_account_id || null,
        expenseAccountId: dbConfig?.expense_account_id || null,
        bankAccountId: dbConfig?.bank_account_id || null
      }
    }, 'Chart of accounts retrieved successfully');
  } catch (error) {
    console.error('Get QuickBooks accounts error:', error);
    return errorResponse(res, error.message || 'Failed to fetch QuickBooks accounts', 500);
  }
});

/**
 * @route   POST /api/quickbooks/accounts/config
 * @desc    Save custom account configuration overrides
 * @access  Private (Admin / Superadmin)
 */
router.post('/accounts/config', auth, async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.user_type)) {
      return errorResponse(res, 'Admin access required', 403);
    }

    const { apAccountId, expenseAccountId, bankAccountId } = req.body;
    const connStatus = await qbService.getConnectionStatus();
    if (!connStatus.connected) {
      return errorResponse(res, 'QuickBooks is not connected. Please connect QuickBooks first.', 400);
    }

    const saved = await qbService.account.saveAccountConfig(connStatus.realmId, {
      apAccountId,
      expenseAccountId,
      bankAccountId
    });

    return successResponse(res, saved, 'QuickBooks account configuration saved');
  } catch (error) {
    console.error('Save QuickBooks account config error:', error);
    return errorResponse(res, 'Failed to save account configuration', 500);
  }
});

module.exports = router;
