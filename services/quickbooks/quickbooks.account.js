const { getMySQLConnection } = require('../../config/mysql');
const { queryQb, makeApiRequest } = require('./quickbooks.client');

/**
 * Get stored account configuration overrides from local database
 */
const getAccountConfigFromDb = async (realmId) => {
  const mysql = getMySQLConnection();
  const [rows] = await mysql.execute(
    `SELECT * FROM quickbooks_account_config WHERE realm_id = ? LIMIT 1`,
    [realmId]
  );
  return rows[0] || null;
};

/**
 * Save custom account configuration overrides
 */
const saveAccountConfig = async (realmId, { apAccountId, expenseAccountId, bankAccountId }) => {
  const mysql = getMySQLConnection();
  await mysql.execute(
    `INSERT INTO quickbooks_account_config (realm_id, ap_account_id, expense_account_id, bank_account_id)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      ap_account_id = COALESCE(VALUES(ap_account_id), ap_account_id),
      expense_account_id = COALESCE(VALUES(expense_account_id), expense_account_id),
      bank_account_id = COALESCE(VALUES(bank_account_id), bank_account_id),
      updated_at = NOW()`,
    [realmId, apAccountId || null, expenseAccountId || null, bankAccountId || null]
  );
  return getAccountConfigFromDb(realmId);
};

/**
 * Query Chart of Accounts from QuickBooks Online
 */
const queryChartOfAccounts = async (realmId) => {
  const result = await queryQb(realmId, "SELECT * FROM Account WHERE Active = true MAXRESULTS 1000");
  return result?.Account || [];
};

/**
 * Identify Accounts Payable Account
 */
const getAccountsPayableAccount = async (realmId) => {
  // Check stored override
  const dbConfig = await getAccountConfigFromDb(realmId);
  if (dbConfig?.ap_account_id) {
    return { id: dbConfig.ap_account_id, name: 'Configured Accounts Payable' };
  }

  // Query QB Chart of Accounts
  const result = await queryQb(realmId, "SELECT * FROM Account WHERE AccountType = 'Accounts Payable' AND Active = true");
  const apAccounts = result?.Account || [];

  if (apAccounts.length > 0) {
    return { id: String(apAccounts[0].Id), name: apAccounts[0].Name, account: apAccounts[0] };
  }

  // Fallback: Query all Accounts Payable types
  const allAccounts = await queryChartOfAccounts(realmId);
  const matched = allAccounts.find(a => a.AccountType === 'Accounts Payable' || a.AccountSubType === 'AccountsPayable');

  if (matched) {
    return { id: String(matched.Id), name: matched.Name, account: matched };
  }

  const err = new Error('QuickBooks Accounts Payable account could not be found automatically. Please configure an Accounts Payable account in QuickBooks account settings.');
  err.code = 'QB_AP_ACCOUNT_MISSING';
  throw err;
};

/**
 * Identify Royalty / Expense Account
 */
const getRoyaltyExpenseAccount = async (realmId) => {
  // Check stored override
  const dbConfig = await getAccountConfigFromDb(realmId);
  if (dbConfig?.expense_account_id) {
    return { id: dbConfig.expense_account_id, name: 'Configured Expense Account' };
  }

  // Query Expense & Cost of Goods Sold accounts from QB
  const result = await queryQb(realmId, "SELECT * FROM Account WHERE AccountType IN ('Expense', 'Cost of Goods Sold', 'Other Expense') AND Active = true");
  const expenseAccounts = result?.Account || [];

  if (expenseAccounts.length === 0) {
    const err = new Error('No active Expense account found in QuickBooks Chart of Accounts. Please configure a Royalty Expense account in QuickBooks settings.');
    err.code = 'QB_EXPENSE_ACCOUNT_MISSING';
    throw err;
  }

  // Search for keywords: "Royalty", "Royalties", "Music", "Artist", "Payout"
  const keywords = ['royalty', 'royalties', 'music', 'artist', 'payout', 'commission'];
  const matched = expenseAccounts.find(acc => {
    const nameLower = (acc.Name || '').toLowerCase();
    return keywords.some(k => nameLower.includes(k));
  });

  if (matched) {
    return { id: String(matched.Id), name: matched.Name, account: matched };
  }

  // If no keyword match, select first Expense account
  const firstExpense = expenseAccounts[0];
  return { id: String(firstExpense.Id), name: firstExpense.Name, account: firstExpense };
};

/**
 * Identify Bank / Payment Account for BillPayment
 */
const getBankPaymentAccount = async (realmId) => {
  // Check stored override
  const dbConfig = await getAccountConfigFromDb(realmId);
  if (dbConfig?.bank_account_id) {
    return { id: dbConfig.bank_account_id, name: 'Configured Bank Account' };
  }

  // Query Bank accounts from QB
  const result = await queryQb(realmId, "SELECT * FROM Account WHERE AccountType IN ('Bank', 'Credit Card') AND Active = true");
  const bankAccounts = result?.Account || [];

  if (bankAccounts.length === 0) {
    const err = new Error('No active Bank or Credit Card account found in QuickBooks for recording BillPayments. Please configure a payment bank account in QuickBooks settings.');
    err.code = 'QB_BANK_ACCOUNT_MISSING';
    throw err;
  }

  // Search for Checking, Operating, Main bank account
  const keywords = ['checking', 'operating', 'main', 'bank', 'cash'];
  const matched = bankAccounts.find(acc => {
    const nameLower = (acc.Name || '').toLowerCase();
    return keywords.some(k => nameLower.includes(k));
  });

  if (matched) {
    return { id: String(matched.Id), name: matched.Name, account: matched };
  }

  const firstBank = bankAccounts[0];
  return { id: String(firstBank.Id), name: firstBank.Name, account: firstBank };
};

module.exports = {
  getAccountConfigFromDb,
  saveAccountConfig,
  queryChartOfAccounts,
  getAccountsPayableAccount,
  getRoyaltyExpenseAccount,
  getBankPaymentAccount
};
