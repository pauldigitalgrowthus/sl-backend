const oauthService = require('./quickbooks.oauth');
const vendorService = require('./quickbooks.vendor');
const accountService = require('./quickbooks.account');
const billService = require('./quickbooks.bill');
const billPaymentService = require('./quickbooks.billPayment');
const clientService = require('./quickbooks.client');

module.exports = {
  oauth: oauthService,
  vendor: vendorService,
  account: accountService,
  bill: billService,
  billPayment: billPaymentService,
  client: clientService,

  // Direct helper exports for convenience
  getAuthUrl: oauthService.getAuthUrl,
  validateState: oauthService.validateState,
  exchangeCodeForToken: oauthService.exchangeCodeForToken,
  refreshAccessToken: oauthService.refreshAccessToken,
  getValidAccessToken: oauthService.getValidAccessToken,
  getConnectionStatus: oauthService.getConnectionStatus,
  disconnect: oauthService.disconnect,

  findOrCreateVendor: vendorService.findOrCreateVendor,
  queryChartOfAccounts: accountService.queryChartOfAccounts,
  getAccountsPayableAccount: accountService.getAccountsPayableAccount,
  getRoyaltyExpenseAccount: accountService.getRoyaltyExpenseAccount,
  getBankPaymentAccount: accountService.getBankPaymentAccount,

  createBill: billService.createBill,
  getBill: billService.getBill,
  createBillPayment: billPaymentService.createBillPayment,
  getBillPayment: billPaymentService.getBillPayment
};
