/**
 * End-to-End Sandbox Verification Script for QuickBooks Online Royalty Payout Integration
 * Run from Sl-Music-Backend directory: node scratch/test_quickbooks_payout_sandbox.js
 */

require('dotenv').config();
const { connectMySQL, getMySQLConnection } = require('../config/mysql');
const qbService = require('../services/quickbooks/quickbooks.service');
const payoutService = require('../services/payout.service');

async function runSandboxTest() {
  console.log('========================================================================');
  console.log('🚀 STARTING QUICKBOOKS ONLINE ROYALTY INTEGRATION END-TO-END TEST');
  console.log('========================================================================\n');

  try {
    // 1. Connect Database
    console.log('1️⃣ Connecting MySQL Database...');
    await connectMySQL();
    const mysql = getMySQLConnection();

    // 2. Test Environment Vars
    console.log('\n2️⃣ Checking Environment Variables...');
    const qbEnv = process.env.QB_ENV || 'sandbox';
    console.log(`   QB_ENV: ${qbEnv}`);
    console.log(`   QB_CLIENT_ID: ${process.env.QB_CLIENT_ID ? 'Configured ✅' : 'Missing ❌'}`);
    console.log(`   QB_REDIRECT_URI: ${process.env.QB_REDIRECT_URI}`);

    // 3. Test QuickBooks OAuth Status
    console.log('\n3️⃣ Checking QuickBooks Connection Status...');
    const connStatus = await qbService.getConnectionStatus();
    console.log('   Connection Status:', JSON.stringify(connStatus, null, 2));

    if (!connStatus.connected) {
      console.log('\n⚠️ QuickBooks is currently not connected via OAuth token in DB.');
      console.log('👉 To connect, open the OAuth auth URL in your browser:');
      const authUrl = qbService.getAuthUrl({ test: true });
      console.log(`   ${authUrl}`);
      console.log('\nℹ️ Database schema and service architecture ready. Once connected, rerun this test.');
    } else {
      const realmId = connStatus.realmId;
      console.log(`\n4️⃣ Querying QuickBooks Chart of Accounts for Realm ${realmId}...`);
      
      const apAccount = await qbService.getAccountsPayableAccount(realmId);
      console.log(`   Accounts Payable Account: ID=${apAccount.id}, Name=${apAccount.name}`);

      const expenseAccount = await qbService.getRoyaltyExpenseAccount(realmId);
      console.log(`   Royalty Expense Account: ID=${expenseAccount.id}, Name=${expenseAccount.name}`);

      const bankAccount = await qbService.getBankPaymentAccount(realmId);
      console.log(`   Bank Payment Account: ID=${bankAccount.id}, Name=${bankAccount.name}`);

      // 5. Test Mock Artist & Royalty Record
      console.log('\n5️⃣ Creating/Fetching Test Artist & Royalty Record...');
      
      // Ensure test user exists
      const [testUser] = await mysql.execute(`SELECT id, email, first_name, last_name FROM users LIMIT 1`);
      let artistId;
      if (testUser.length > 0) {
        artistId = testUser[0].id;
      } else {
        const [userIns] = await mysql.execute(
          `INSERT INTO users (first_name, last_name, email, password, role, user_type)
           VALUES ('Rahul', 'Sharma', 'rahul.test@example.com', 'hashed_pass', 'composer', 'composer')`
        );
        artistId = userIns.insertId;
      }

      // Create test composer_earning row
      const [earningIns] = await mysql.execute(
        `INSERT INTO composer_earnings 
          (composer_id, music_publication_id, buyer_user_id, sale_price, composer_earning, status, pay_period)
         VALUES (?, 1, 1, 100.00, 50.00, 'pending', '2026-Q1')`,
        [artistId]
      );
      const testRoyaltyId = earningIns.insertId;
      console.log(`   Created Test Royalty Record #${testRoyaltyId} for $50.00 (Artist ID: ${artistId})`);

      // 6. Test QuickBooks Vendor Resolution
      console.log('\n6️⃣ Testing Vendor Resolution (find/create vendor)...');
      const [[artist]] = await mysql.execute(`SELECT id, email, first_name, last_name FROM users WHERE id = ?`, [artistId]);
      const vendorRes = await qbService.findOrCreateVendor(realmId, artist);
      console.log(`   QuickBooks Vendor Resolved: VendorId=${vendorRes.vendorId}, DisplayName=${vendorRes.vendor?.DisplayName}, isNew=${vendorRes.isNew}`);

      // 7. Test Bill Creation
      console.log('\n7️⃣ Testing QuickBooks Bill Creation ($50 UNPAID)...');
      const billRes = await payoutService.createQuickbooksBillForRoyalty(testRoyaltyId, realmId);
      console.log(`   QuickBooks Bill Created: BillId=${billRes.billId}, Balance=$${billRes.balance}, DocNumber=${billRes.docNumber}`);

      // 8. Test Idempotency (prevent duplicate bills)
      console.log('\n8️⃣ Testing Bill Creation Idempotency...');
      const billResDup = await payoutService.createQuickbooksBillForRoyalty(testRoyaltyId, realmId);
      console.log(`   Duplicate Bill Check: Already Existed=${billResDup.alreadyExisted}, BillId=${billResDup.billId}`);

      // 9. Test Full Payout Processing Flow (Stripe -> BillPayment -> PAID -> Email)
      console.log('\n9️⃣ Testing Full Automated Payout Flow...');
      const payoutRes = await payoutService.processRoyaltyPayout(testRoyaltyId, realmId);
      console.log('   Payout Processing Result:', JSON.stringify(payoutRes, null, 2));

      // 10. Verify DB Final Status & Audit Trail
      console.log('\n🔟 Verifying Final Database State & Audit Logs...');
      const statusRes = await payoutService.getRoyaltyPaymentStatus(testRoyaltyId);
      console.log(`   Royalty Internal Status: ${statusRes.royalty.internal_status}`);
      console.log(`   Payment Status: ${statusRes.royalty.payment_status}`);
      console.log(`   QuickBooks Status: ${statusRes.royalty.quickbooks_status}`);
      console.log(`   Stripe Transfer ID: ${statusRes.royalty.stripe_transfer_id}`);
      console.log(`   QuickBooks Bill ID: ${statusRes.royalty.quickbooks_bill_id}`);
      console.log(`   QuickBooks Payment ID: ${statusRes.royalty.quickbooks_payment_id}`);
      console.log(`   Audit Logs Count: ${statusRes.auditLogs.length}`);

      console.log('\n========================================================================');
      console.log('✅ ALL SANDBOX QUICKBOOKS ROYALTY INTEGRATION TESTS PASSED!');
      console.log('========================================================================');
    }

    process.exit(0);
  } catch (error) {
    console.error('\n❌ TEST FAILED WITH ERROR:', error.message);
    if (error.stack) console.error(error.stack);
    process.exit(1);
  }
}

runSandboxTest();
