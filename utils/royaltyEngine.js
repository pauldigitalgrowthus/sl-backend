// utils/royaltyEngine.js
// ============================================================
// CORE ROYALTY CALCULATION ENGINE
// ------------------------------------------------------------
// Covers: Music (composer) a-la-carte + subscription pro-rata,
//         ONE LICENSE import processing, Documents (owner)
//         subscription pro-rata, Review Board stipends.
// Excludes: Educator/Academy (out of scope per current request).
//
// Design rule from the SOW: ICEL / USCCB / CCD deducted first,
// then 30% royalty split on the remainder, SL retains the rest.
// Deduction entities and their per-product % come from
// product_royalty_config (dynamic — not hardcoded).
// ============================================================

const { getMySQLConnection } = require('../config/mysql');

const DEFAULT_ROYALTY_PERCENT = 30.00;

/* ============================================================
   HELPER: current pay period key
   Defaults to monthly ('2026-07'). Swap this single function if
   the client confirms quarterly ("Current Pay Period" — SOW open
   question) — nothing else in the engine needs to change.
============================================================ */
const getCurrentPayPeriod = (date = new Date()) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
};

/* ============================================================
   HELPER: compute deductions for a product against a gross amount
   Reads product_royalty_config for (product_type, product_id).
   Returns { totalDeductionAmount, netAfterDeductions, breakdown[] }
============================================================ */
const computeDeductions = async (mysql, productType, productId, grossAmount) => {
  const [configs] = await mysql.execute(
    `SELECT prc.*, rde.name AS entity_name
     FROM product_royalty_config prc
     JOIN royalty_deduction_entities rde ON rde.id = prc.deduction_entity_id
     WHERE prc.product_type = ? AND prc.product_id = ? AND prc.applies = TRUE AND rde.is_active = TRUE`,
    [productType, productId]
  );

  const breakdown = configs.map((c) => {
    const amount = Number((grossAmount * (Number(c.percent) / 100)).toFixed(2));
    return {
      deduction_entity_id: c.deduction_entity_id,
      entity_name: c.entity_name,
      percent: Number(c.percent),
      amount
    };
  });

  const totalDeductionAmount = Number(breakdown.reduce((sum, b) => sum + b.amount, 0).toFixed(2));
  // netAfterDeductions is intentionally NOT rounded here - full precision
  // is preserved through to the final composer/educator/owner earning
  // calculation (client spec, Aug 2026: "retain full decimal precision
  // during the Pro-Rata calculations... round the final amount to cents").
  const netAfterDeductions = grossAmount - totalDeductionAmount;

  return { totalDeductionAmount, netAfterDeductions, breakdown };
};

/* ============================================================
   MUSIC — A-LA-CARTE SALE (immediate, deterministic)
   ------------------------------------------------------------
   Call this once per purchased item, right after the item is
   inserted into user_music_library (webhook / purchase-file).
============================================================ */
const recordMusicALaCarteEarning = async ({
  mysql,
  musicPublicationId,
  buyerUserId,
  salePrice,
  transactionId = null,
  stripeSessionId = null,
  paymentMethod = 'stripe'
}) => {
  try {
    const [[music]] = await mysql.execute(
      `SELECT id, composer_id, composition_title FROM music_publications WHERE id = ? LIMIT 1`,
      [musicPublicationId]
    );

    if (!music || !music.composer_id) {
      console.warn(`Royalty Engine: no composer found for music_publication ${musicPublicationId} - skipping`);
      return null;
    }

    const gross = Number(salePrice);
    const { totalDeductionAmount, netAfterDeductions, breakdown } =
      await computeDeductions(mysql, 'music', musicPublicationId, gross);

    const royaltyPercent = DEFAULT_ROYALTY_PERCENT;
    const composerEarning = Number((netAfterDeductions * (royaltyPercent / 100)).toFixed(2));
    const platformFeeAmount = Number((gross - composerEarning).toFixed(2));
    const platformFeePct = gross > 0 ? Number(((platformFeeAmount / gross) * 100).toFixed(2)) : 0;

    const [result] = await mysql.execute(
      `INSERT INTO composer_earnings (
        composer_id, music_publication_id, composition_title, buyer_user_id,
        sale_price, platform_fee_pct, platform_fee_amount, composer_earning,
        transaction_id, stripe_session_id, payment_method, status, paid_at,
        source_type, total_deductions, net_after_deductions, royalty_percent, pay_period
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 'a_la_carte', ?, ?, ?, ?)`,
      [
        music.composer_id, musicPublicationId, music.composition_title, buyerUserId,
        gross, platformFeePct, platformFeeAmount, composerEarning,
        transactionId, stripeSessionId, paymentMethod,
        totalDeductionAmount, netAfterDeductions, royaltyPercent, getCurrentPayPeriod()
      ]
    );

    const earningId = result.insertId;

    for (const d of breakdown) {
      await mysql.execute(
        `INSERT INTO composer_earning_deductions (composer_earning_id, deduction_entity_id, percent, amount)
         VALUES (?, ?, ?, ?)`,
        [earningId, d.deduction_entity_id, d.percent, d.amount]
      );
    }

    return { earningId, gross, totalDeductionAmount, netAfterDeductions, composerEarning, breakdown };
  } catch (error) {
    console.error('Royalty Engine (a-la-carte) error:', error);
    // Never throw into the caller's payment flow — a royalty calc failure
    // must not block the purchase itself. Log for manual reconciliation.
    return null;
  }
};

/* ============================================================
   MUSIC — ONE LICENSE RECORD PROCESSING
   ------------------------------------------------------------
   Same deduction -> 30% split rule (SOW 3.3 Key Rule), applied
   to the "Value" field of a matched ONE LICENSE record.
============================================================ */
const recordOneLicenseEarning = async ({ mysql, oneLicenseRecordId, processedByUserId }) => {
  try {
    const [[record]] = await mysql.execute(
      `SELECT * FROM one_license_records WHERE id = ? LIMIT 1`,
      [oneLicenseRecordId]
    );

    if (!record || !record.music_publication_id) {
      console.warn(`Royalty Engine: ONE LICENSE record ${oneLicenseRecordId} not matched to a composition - skipping`);
      return null;
    }

    const [[music]] = await mysql.execute(
      `SELECT id, composer_id, composition_title FROM music_publications WHERE id = ? LIMIT 1`,
      [record.music_publication_id]
    );

    if (!music || !music.composer_id) return null;

    const gross = Number(record.value);
    const { totalDeductionAmount, netAfterDeductions, breakdown } =
      await computeDeductions(mysql, 'music', record.music_publication_id, gross);

    const composerEarning = Number((netAfterDeductions * (DEFAULT_ROYALTY_PERCENT / 100)).toFixed(2));
    const platformFeeAmount = Number((gross - composerEarning).toFixed(2));
    const platformFeePct = gross > 0 ? Number(((platformFeeAmount / gross) * 100).toFixed(2)) : 0;

    const [result] = await mysql.execute(
      `INSERT INTO composer_earnings (
        composer_id, music_publication_id, composition_title, buyer_user_id,
        sale_price, platform_fee_pct, platform_fee_amount, composer_earning,
        status, paid_at, source_type, total_deductions, net_after_deductions,
        royalty_percent, pay_period, one_license_record_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 'one_license', ?, ?, ?, ?, ?)`,
      [
        music.composer_id, record.music_publication_id, music.composition_title, processedByUserId,
        gross, platformFeePct, platformFeeAmount, composerEarning,
        totalDeductionAmount, netAfterDeductions, DEFAULT_ROYALTY_PERCENT,
        getCurrentPayPeriod(), oneLicenseRecordId
      ]
    );

    const earningId = result.insertId;
    for (const d of breakdown) {
      await mysql.execute(
        `INSERT INTO composer_earning_deductions (composer_earning_id, deduction_entity_id, percent, amount)
         VALUES (?, ?, ?, ?)`,
        [earningId, d.deduction_entity_id, d.percent, d.amount]
      );
    }

    await mysql.execute(
      `UPDATE one_license_records SET status = 'processed', composer_earning_id = ? WHERE id = ?`,
      [earningId, oneLicenseRecordId]
    );

    return { earningId, gross, composerEarning };
  } catch (error) {
    console.error('Royalty Engine (ONE LICENSE) error:', error);
    return null;
  }
};

/* ============================================================
   REVIEW BOARD STIPEND (per-review, not per-sale)
   ------------------------------------------------------------
   Call this right after a review board member's decision is
   recorded (music-publications.js -> review-board/decision).
============================================================ */
const logReviewBoardStipend = async ({ mysql, reviewerId, musicPublicationId, typeOfMusic, compositionTitle = null }) => {
  try {
    if (!typeOfMusic) {
      console.warn(`Royalty Engine: no type_of_music for publication ${musicPublicationId} - stipend skipped`);
      return null;
    }

    const [[rateRow]] = await mysql.execute(
      `SELECT rate FROM review_board_stipend_rates WHERE type_of_music = ? AND is_active = TRUE LIMIT 1`,
      [typeOfMusic]
    );

    if (!rateRow) {
      console.warn(`Royalty Engine: no stipend rate configured for type_of_music "${typeOfMusic}" - stipend skipped`);
      return null;
    }

    const [result] = await mysql.execute(
      `INSERT INTO review_board_stipends
        (reviewer_id, music_publication_id, composition_title, type_of_music, rate_applied, status, pay_period)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      [reviewerId, musicPublicationId, compositionTitle, typeOfMusic, rateRow.rate, getCurrentPayPeriod()]
    );

    return { stipendId: result.insertId, rate: rateRow.rate };
  } catch (error) {
    console.error('Royalty Engine (review board stipend) error:', error);
    return null;
  }
};

/* ============================================================
   DOCUMENT ACCESS LOGGING (usage tracking, feeds pro-rata pool)
============================================================ */
const logDocumentAccess = async ({ mysql, userId, documentId }) => {
  try {
    await mysql.execute(
      `INSERT INTO document_access_log (user_id, document_id) VALUES (?, ?)`,
      [userId, documentId]
    );
  } catch (error) {
    console.error('Royalty Engine (document access log) error:', error);
  }
};

/* ============================================================
   MUSIC — SUBSCRIPTION USAGE-BASED POOL DISTRIBUTION
   ------------------------------------------------------------
   Run at pay-period close (admin-triggered — see SOW open
   question on "Current Pay Period" definition). Distributes the
   Music portion of ALL active subscriptions for the period across
   compositions, weighted by "Add to My Music" usage
   (user_music_library rows added in the period).
============================================================ */
const distributeMusicSubscriptionPool = async ({ mysql, periodStart, periodEnd, payPeriod, processedByUserId }) => {
  // 1. Total Music-eligible subscription revenue for the period
  //    = sum(plan price * Music allocation %) for active subscriptions renewed/active in period
  const [subscriptionRevenue] = await mysql.execute(
    `SELECT
        us.id AS user_subscription_id,
        p.price AS plan_price,
        pra.allocation_percent
     FROM user_subscriptions us
     JOIN plans p ON us.plan_id = p.id
     JOIN plan_revenue_allocations pra ON pra.plan_id = p.id AND pra.component_name = 'Music' AND pra.royalty_eligible = TRUE
     WHERE us.status = 'active'
       AND us.created_at BETWEEN ? AND ?`,
    [periodStart, periodEnd]
  );

  const totalMusicPool = subscriptionRevenue.reduce(
    (sum, row) => sum + (Number(row.plan_price) * (Number(row.allocation_percent) / 100)),
    0
  );

  if (totalMusicPool <= 0) {
    return { totalMusicPool: 0, distributed: 0, compositions: 0 };
  }

  // 2. Usage per composition in the period ("Add to My Music")
  const [usageRows] = await mysql.execute(
    `SELECT music_publication_id, COUNT(*) AS usage_count
     FROM user_music_library
     WHERE created_at BETWEEN ? AND ?
     GROUP BY music_publication_id`,
    [periodStart, periodEnd]
  );

  const totalUsage = usageRows.reduce((sum, r) => sum + Number(r.usage_count), 0);
  if (totalUsage === 0) {
    return { totalMusicPool, distributed: 0, compositions: 0 };
  }

  let distributed = 0;

  // 3. Per composition: pool share -> deductions -> 30% composer split
  for (const row of usageRows) {
    const musicPublicationId = row.music_publication_id;
    const usageShare = Number(row.usage_count) / totalUsage;
    const compositionGross = Number((usageShare * totalMusicPool).toFixed(2));

    if (compositionGross <= 0) continue;

    const [[music]] = await mysql.execute(
      `SELECT id, composer_id, composition_title FROM music_publications WHERE id = ? LIMIT 1`,
      [musicPublicationId]
    );
    if (!music || !music.composer_id) continue;

    const { totalDeductionAmount, netAfterDeductions, breakdown } =
      await computeDeductions(mysql, 'music', musicPublicationId, compositionGross);

    const composerEarning = Number((netAfterDeductions * (DEFAULT_ROYALTY_PERCENT / 100)).toFixed(2));
    const platformFeeAmount = Number((compositionGross - composerEarning).toFixed(2));
    const platformFeePct = compositionGross > 0
      ? Number(((platformFeeAmount / compositionGross) * 100).toFixed(2))
      : 0;

    const [result] = await mysql.execute(
      `INSERT INTO composer_earnings (
        composer_id, music_publication_id, composition_title, buyer_user_id,
        sale_price, platform_fee_pct, platform_fee_amount, composer_earning,
        status, paid_at, source_type, total_deductions, net_after_deductions,
        royalty_percent, usage_share_percent, pay_period
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 'subscription', ?, ?, ?, ?, ?)`,
      [
        music.composer_id, musicPublicationId, music.composition_title, processedByUserId,
        compositionGross, platformFeePct, platformFeeAmount, composerEarning,
        totalDeductionAmount, netAfterDeductions, DEFAULT_ROYALTY_PERCENT,
        Number((usageShare * 100).toFixed(4)), payPeriod
      ]
    );

    const earningId = result.insertId;
    for (const d of breakdown) {
      await mysql.execute(
        `INSERT INTO composer_earning_deductions (composer_earning_id, deduction_entity_id, percent, amount)
         VALUES (?, ?, ?, ?)`,
        [earningId, d.deduction_entity_id, d.percent, d.amount]
      );
    }

    distributed += composerEarning;
  }

  return { totalMusicPool, distributed, compositions: usageRows.length };
};

/* ============================================================
   DOCUMENTS — SUBSCRIPTION USAGE-BASED POOL DISTRIBUTION
   ------------------------------------------------------------
   Mirrors the music version. SOW 7.1: no a-la-carte for
   documents, subscription access only.
============================================================ */
const distributeDocumentSubscriptionPool = async ({ mysql, periodStart, periodEnd, payPeriod }) => {
  const [subscriptionRevenue] = await mysql.execute(
    `SELECT us.id AS user_subscription_id, p.price AS plan_price, pra.allocation_percent
     FROM user_subscriptions us
     JOIN plans p ON us.plan_id = p.id
     JOIN plan_revenue_allocations pra ON pra.plan_id = p.id AND pra.component_name = 'Documents' AND pra.royalty_eligible = TRUE
     WHERE us.status = 'active' AND us.created_at BETWEEN ? AND ?`,
    [periodStart, periodEnd]
  );

  const totalDocPool = subscriptionRevenue.reduce(
    (sum, row) => sum + (Number(row.plan_price) * (Number(row.allocation_percent) / 100)),
    0
  );

  if (totalDocPool <= 0) return { totalDocPool: 0, distributed: 0, documents: 0 };

  const [usageRows] = await mysql.execute(
    `SELECT document_id, COUNT(*) AS usage_count
     FROM document_access_log
     WHERE accessed_at BETWEEN ? AND ?
     GROUP BY document_id`,
    [periodStart, periodEnd]
  );

  const totalUsage = usageRows.reduce((sum, r) => sum + Number(r.usage_count), 0);
  if (totalUsage === 0) return { totalDocPool, distributed: 0, documents: 0 };

  let distributed = 0;

  for (const row of usageRows) {
    const documentId = row.document_id;
    const usageShare = Number(row.usage_count) / totalUsage;
    const docGross = Number((usageShare * totalDocPool).toFixed(2));
    if (docGross <= 0) continue;

    const [[doc]] = await mysql.execute(
      `SELECT id, document_title, COALESCE(created_by, upload_by) AS owner_id FROM documents WHERE id = ? LIMIT 1`,
      [documentId]
    );
    if (!doc || !doc.owner_id) continue;

    const { totalDeductionAmount, netAfterDeductions, breakdown } =
      await computeDeductions(mysql, 'document', documentId, docGross);

    const ownerEarning = Number((netAfterDeductions * (DEFAULT_ROYALTY_PERCENT / 100)).toFixed(2));

    const [result] = await mysql.execute(
      `INSERT INTO document_royalty_earnings (
        owner_id, document_id, document_title, gross_amount, total_deductions,
        net_after_deductions, royalty_percent, owner_earning, usage_share_percent, pay_period, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        doc.owner_id, documentId, doc.document_title, docGross, totalDeductionAmount,
        netAfterDeductions, DEFAULT_ROYALTY_PERCENT, ownerEarning,
        Number((usageShare * 100).toFixed(4)), payPeriod
      ]
    );

    const earningId = result.insertId;
    for (const d of breakdown) {
      await mysql.execute(
        `INSERT INTO document_royalty_deductions (document_royalty_earning_id, deduction_entity_id, percent, amount)
         VALUES (?, ?, ?, ?)`,
        [earningId, d.deduction_entity_id, d.percent, d.amount]
      );
    }

    distributed += ownerEarning;
  }

  return { totalDocPool, distributed, documents: usageRows.length };
};

/* ============================================================
   RETURNS / REFUNDS — reverse an already-recorded royalty
   ------------------------------------------------------------
   SOW 3.1/3.2 require capturing "Date of return" and "Transaction
   amount (lost revenue)". This cancels the composer_earnings (or
   document_royalty_earnings) row so it's excluded from pending/paid
   totals, and logs the reversal in royalty_returns for reporting.
============================================================ */
const processRoyaltyReturn = async ({
  mysql,
  earningType,           // 'composer' | 'document' | 'educator'
  earningId,
  reason = null,
  processedBy
}) => {
  try {
    const tableMap = {
      composer: { table: 'composer_earnings', amountField: 'composer_earning', recipientField: 'composer_id' },
      document: { table: 'document_royalty_earnings', amountField: 'owner_earning', recipientField: 'owner_id' },
      educator: { table: 'educator_earnings', amountField: 'educator_earning', recipientField: 'educator_id' }
    };

    const config = tableMap[earningType];
    if (!config) return { success: false, error: "earningType must be 'composer', 'document', or 'educator'" };

    const { table, amountField, recipientField } = config;

    const [[earning]] = await mysql.execute(
      `SELECT * FROM ${table} WHERE id = ? LIMIT 1`,
      [earningId]
    );

    if (!earning) return { success: false, error: 'Earning record not found' };
    if (earning.status === 'paid') {
      return { success: false, error: 'Cannot reverse an already-paid earning - handle as a clawback manually' };
    }
    if (earning.status === 'cancelled') {
      return { success: false, error: 'Earning already cancelled' };
    }

    await mysql.execute(
      `UPDATE ${table} SET status = 'cancelled' WHERE id = ?`,
      [earningId]
    );

    const [result] = await mysql.execute(
      `INSERT INTO royalty_returns
        (earning_type, earning_id, recipient_id, gross_amount_reversed, recipient_amount_reversed, reason, processed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        earningType, earningId, earning[recipientField],
        earning.sale_price || earning.gross_amount, earning[amountField],
        reason, processedBy
      ]
    );

    return { success: true, returnId: result.insertId, reversedAmount: earning[amountField] };
  } catch (error) {
    console.error('Royalty Engine (return/refund) error:', error);
    return { success: false, error: error.message };
  }
};

/* ============================================================
   DIOCESAN ADOPTION DISCOUNT (SOW 3.1.D)
   ------------------------------------------------------------
   Extra 25% discount when 30%+ of a diocese's registered parishes
   are active. Read-only calculator - the caller (subscription /
   checkout flow) decides what to do with the result.
============================================================ */
const getDiocesanAdoptionDiscount = async ({ mysql, dioceseId, adoptionThreshold = 30, extraDiscountPercent = 25 }) => {
  const [[diocese]] = await mysql.execute(
    `SELECT id, official_name, total_parishes FROM dioceses WHERE id = ? LIMIT 1`,
    [dioceseId]
  );
  if (!diocese) return null;

  const [[activeCount]] = await mysql.execute(
    `SELECT COUNT(*) AS active_parishes FROM diocesan_parishes WHERE diocese_id = ? AND status = 'active'`,
    [dioceseId]
  );

  const totalParishes = Number(diocese.total_parishes) || 0;
  const activeParishes = Number(activeCount.active_parishes) || 0;
  const adoptionPercent = totalParishes > 0
    ? Number(((activeParishes / totalParishes) * 100).toFixed(2))
    : 0;

  const qualifies = adoptionPercent >= adoptionThreshold;

  return {
    dioceseId,
    dioceseName: diocese.official_name,
    totalParishes,
    activeParishes,
    adoptionPercent,
    adoptionThreshold,
    qualifiesForExtraDiscount: qualifies,
    extraDiscountPercent: qualifies ? extraDiscountPercent : 0
  };
};

/* ============================================================
   EDUCATOR — A-LA-CARTE / CART COURSE SALE (immediate, deterministic)
   ------------------------------------------------------------
   Call once per purchased course, right after enrollment is
   inserted into course_enrollments (payment webhook or verify-session).
============================================================ */
const recordEducatorALaCarteEarning = async ({
  mysql,
  courseId,
  buyerUserId,
  salePrice,
  transactionId = null,
  stripeSessionId = null,
  paymentMethod = 'stripe'
}) => {
  try {
    const [[course]] = await mysql.execute(
      `SELECT id, educator_id, course_title FROM courses WHERE id = ? LIMIT 1`,
      [courseId]
    );

    if (!course || !course.educator_id) {
      console.warn(`Royalty Engine: no educator found for course ${courseId} - skipping`);
      return null;
    }

    const gross = Number(salePrice);
    const { totalDeductionAmount, netAfterDeductions, breakdown } =
      await computeDeductions(mysql, 'course', courseId, gross);

    const royaltyPercent = DEFAULT_ROYALTY_PERCENT;
    const educatorEarning = Number((netAfterDeductions * (royaltyPercent / 100)).toFixed(2));
    const platformFeeAmount = Number((gross - educatorEarning).toFixed(2));
    const platformFeePct = gross > 0 ? Number(((platformFeeAmount / gross) * 100).toFixed(2)) : 0;

    const [result] = await mysql.execute(
      `INSERT INTO educator_earnings (
        educator_id, course_id, course_title, buyer_user_id,
        sale_price, platform_fee_pct, platform_fee_amount, educator_earning,
        transaction_id, stripe_session_id, payment_method, status, paid_at,
        source_type, total_deductions, net_after_deductions, royalty_percent, pay_period
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 'a_la_carte', ?, ?, ?, ?)`,
      [
        course.educator_id, courseId, course.course_title, buyerUserId,
        gross, platformFeePct, platformFeeAmount, educatorEarning,
        transactionId, stripeSessionId, paymentMethod,
        totalDeductionAmount, netAfterDeductions, royaltyPercent, getCurrentPayPeriod()
      ]
    );

    const earningId = result.insertId;

    for (const d of breakdown) {
      await mysql.execute(
        `INSERT INTO educator_earning_deductions (educator_earning_id, deduction_entity_id, percent, amount)
         VALUES (?, ?, ?, ?)`,
        [earningId, d.deduction_entity_id, d.percent, d.amount]
      );
    }

    return { earningId, gross, totalDeductionAmount, netAfterDeductions, educatorEarning, breakdown };
  } catch (error) {
    console.error('Royalty Engine (educator a-la-carte) error:', error);
    // Never throw into the checkout/webhook flow - a royalty calc failure
    // must not block enrollment itself.
    return null;
  }
};

/* ============================================================
   EDUCATOR — SUBSCRIPTION USAGE-BASED POOL DISTRIBUTION
   ------------------------------------------------------------
   Mirrors distributeMusicSubscriptionPool. Usage signal here is
   course_enrollments rows created in the period (SOW 6.2 "Add to
   My Courses" = enrolling in a course under an active subscription).
============================================================ */
const distributeEducatorSubscriptionPool = async ({ mysql, periodStart, periodEnd, payPeriod, processedByUserId }) => {
  const [subscriptionRevenue] = await mysql.execute(
    `SELECT us.id AS user_subscription_id, p.price AS plan_price, pra.allocation_percent
     FROM user_subscriptions us
     JOIN plans p ON us.plan_id = p.id
     JOIN plan_revenue_allocations pra ON pra.plan_id = p.id AND pra.component_name = 'Academy' AND pra.royalty_eligible = TRUE
     WHERE us.status = 'active' AND us.created_at BETWEEN ? AND ?`,
    [periodStart, periodEnd]
  );

  const totalAcademyPool = subscriptionRevenue.reduce(
    (sum, row) => sum + (Number(row.plan_price) * (Number(row.allocation_percent) / 100)),
    0
  );

  if (totalAcademyPool <= 0) {
    return { totalAcademyPool: 0, distributed: 0, courses: 0 };
  }

  const [usageRows] = await mysql.execute(
    `SELECT course_id, COUNT(*) AS usage_count
     FROM course_enrollments
     WHERE enrolled_at BETWEEN ? AND ?
     GROUP BY course_id`,
    [periodStart, periodEnd]
  );

  const totalUsage = usageRows.reduce((sum, r) => sum + Number(r.usage_count), 0);
  if (totalUsage === 0) {
    return { totalAcademyPool, distributed: 0, courses: 0 };
  }

  let distributed = 0;

  for (const row of usageRows) {
    const courseId = row.course_id;
    const usageShare = Number(row.usage_count) / totalUsage;
    const courseGross = Number((usageShare * totalAcademyPool).toFixed(2));
    if (courseGross <= 0) continue;

    const [[course]] = await mysql.execute(
      `SELECT id, educator_id, course_title FROM courses WHERE id = ? LIMIT 1`,
      [courseId]
    );
    if (!course || !course.educator_id) continue;

    const { totalDeductionAmount, netAfterDeductions, breakdown } =
      await computeDeductions(mysql, 'course', courseId, courseGross);

    const educatorEarning = Number((netAfterDeductions * (DEFAULT_ROYALTY_PERCENT / 100)).toFixed(2));
    const platformFeeAmount = Number((courseGross - educatorEarning).toFixed(2));
    const platformFeePct = courseGross > 0
      ? Number(((platformFeeAmount / courseGross) * 100).toFixed(2))
      : 0;

    const [result] = await mysql.execute(
      `INSERT INTO educator_earnings (
        educator_id, course_id, course_title, buyer_user_id,
        sale_price, platform_fee_pct, platform_fee_amount, educator_earning,
        status, paid_at, source_type, total_deductions, net_after_deductions,
        royalty_percent, usage_share_percent, pay_period
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 'subscription', ?, ?, ?, ?, ?)`,
      [
        course.educator_id, courseId, course.course_title, processedByUserId,
        courseGross, platformFeePct, platformFeeAmount, educatorEarning,
        totalDeductionAmount, netAfterDeductions, DEFAULT_ROYALTY_PERCENT,
        Number((usageShare * 100).toFixed(4)), payPeriod
      ]
    );

    const earningId = result.insertId;
    for (const d of breakdown) {
      await mysql.execute(
        `INSERT INTO educator_earning_deductions (educator_earning_id, deduction_entity_id, percent, amount)
         VALUES (?, ?, ?, ?)`,
        [earningId, d.deduction_entity_id, d.percent, d.amount]
      );
    }

    distributed += educatorEarning;
  }

  return { totalAcademyPool, distributed, courses: usageRows.length };
};

/* ============================================================
   REAL-TIME SUBSCRIPTION DISTRIBUTION
   ------------------------------------------------------------
   Unlike distribute*SubscriptionPool (admin-triggered, date-range
   batch), these run ONCE PER SUBSCRIPTION PAYMENT, immediately on
   verification. Each call takes a single pool amount (this one
   subscription's Music/Academy/Documents portion) and splits it
   pro-rata across ALL current usage to date (cumulative snapshot,
   not a date window - each payment creates and distributes its
   own fresh pool, so re-snapshotting usage each time is safe and
   doesn't touch earlier distributions).
   ------------------------------------------------------------
   FIX: added `subscriberUserId` — the single user whose payment
   triggered this pool — and it's now sent as buyer_user_id on every
   row created here, instead of NULL.
============================================================ */

const distributeMusicPoolRealtime = async ({ mysql, poolAmount, payPeriod, subscriberUserId, sourceReference = null }) => {
  if (poolAmount <= 0) return { poolAmount: 0, distributed: 0, compositions: 0 };

  const [usageRows] = await mysql.execute(
    `SELECT music_publication_id, COUNT(*) AS usage_count FROM user_music_library GROUP BY music_publication_id`
  );

  const totalUsage = usageRows.reduce((sum, r) => sum + Number(r.usage_count), 0);
  if (totalUsage === 0) return { poolAmount, distributed: 0, compositions: 0 };

  let distributed = 0;

  for (const row of usageRows) {
    const musicPublicationId = row.music_publication_id;
    const usageShare = Number(row.usage_count) / totalUsage;
    const compositionGross = Number((usageShare * poolAmount).toFixed(2));
    if (compositionGross <= 0) continue;

    const [[music]] = await mysql.execute(
      `SELECT id, composer_id, composition_title FROM music_publications WHERE id = ? LIMIT 1`,
      [musicPublicationId]
    );
    if (!music || !music.composer_id) continue;

    const { totalDeductionAmount, netAfterDeductions, breakdown } =
      await computeDeductions(mysql, 'music', musicPublicationId, compositionGross);

    const composerEarning = Number((netAfterDeductions * (DEFAULT_ROYALTY_PERCENT / 100)).toFixed(2));
    const platformFeeAmount = Number((compositionGross - composerEarning).toFixed(2));
    const platformFeePct = compositionGross > 0
      ? Number(((platformFeeAmount / compositionGross) * 100).toFixed(2)) : 0;

    const [result] = await mysql.execute(
      `INSERT INTO composer_earnings (
        composer_id, music_publication_id, composition_title, buyer_user_id,
        sale_price, platform_fee_pct, platform_fee_amount, composer_earning,
        status, paid_at, source_type, total_deductions, net_after_deductions,
        royalty_percent, usage_share_percent, pay_period
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 'subscription', ?, ?, ?, ?, ?)`,
      [
        music.composer_id, musicPublicationId, music.composition_title, subscriberUserId,
        compositionGross, platformFeePct, platformFeeAmount, composerEarning,
        totalDeductionAmount, netAfterDeductions, DEFAULT_ROYALTY_PERCENT,
        Number((usageShare * 100).toFixed(4)), payPeriod
      ]
    );

    const earningId = result.insertId;
    for (const d of breakdown) {
      await mysql.execute(
        `INSERT INTO composer_earning_deductions (composer_earning_id, deduction_entity_id, percent, amount)
         VALUES (?, ?, ?, ?)`,
        [earningId, d.deduction_entity_id, d.percent, d.amount]
      );
    }

    distributed += composerEarning;
  }

  return { poolAmount, distributed, compositions: usageRows.length };
};

/* Not touched by the buyer_user_id fix — document_royalty_earnings has no
   buyer_user_id column, so this was never affected by the NOT NULL error. */
const distributeDocumentPoolRealtime = async ({ mysql, poolAmount, payPeriod }) => {
  if (poolAmount <= 0) return { poolAmount: 0, distributed: 0, documents: 0 };

  const [usageRows] = await mysql.execute(
    `SELECT document_id, COUNT(*) AS usage_count FROM document_access_log GROUP BY document_id`
  );

  const totalUsage = usageRows.reduce((sum, r) => sum + Number(r.usage_count), 0);
  if (totalUsage === 0) return { poolAmount, distributed: 0, documents: 0 };

  let distributed = 0;

  for (const row of usageRows) {
    const documentId = row.document_id;
    const usageShare = Number(row.usage_count) / totalUsage;
    const docGross = Number((usageShare * poolAmount).toFixed(2));
    if (docGross <= 0) continue;

    const [[doc]] = await mysql.execute(
      `SELECT id, document_title, COALESCE(created_by, upload_by) AS owner_id FROM documents WHERE id = ? LIMIT 1`,
      [documentId]
    );
    if (!doc || !doc.owner_id) continue;

    const { totalDeductionAmount, netAfterDeductions, breakdown } =
      await computeDeductions(mysql, 'document', documentId, docGross);

    const ownerEarning = Number((netAfterDeductions * (DEFAULT_ROYALTY_PERCENT / 100)).toFixed(2));

    const [result] = await mysql.execute(
      `INSERT INTO document_royalty_earnings (
        owner_id, document_id, document_title, gross_amount, total_deductions,
        net_after_deductions, royalty_percent, owner_earning, usage_share_percent, pay_period, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        doc.owner_id, documentId, doc.document_title, docGross, totalDeductionAmount,
        netAfterDeductions, DEFAULT_ROYALTY_PERCENT, ownerEarning,
        Number((usageShare * 100).toFixed(4)), payPeriod
      ]
    );

    const earningId = result.insertId;
    for (const d of breakdown) {
      await mysql.execute(
        `INSERT INTO document_royalty_deductions (document_royalty_earning_id, deduction_entity_id, percent, amount)
         VALUES (?, ?, ?, ?)`,
        [earningId, d.deduction_entity_id, d.percent, d.amount]
      );
    }

    distributed += ownerEarning;
  }

  return { poolAmount, distributed, documents: usageRows.length };
};

/* FIX: added `subscriberUserId` (the subscriber whose payment triggered
   this pool), sent as buyer_user_id instead of NULL. */
const distributeEducatorPoolRealtime = async ({ mysql, poolAmount, payPeriod, subscriberUserId }) => {
  if (poolAmount <= 0) return { poolAmount: 0, distributed: 0, courses: 0 };

  const [usageRows] = await mysql.execute(
    `SELECT course_id, COUNT(*) AS usage_count FROM course_enrollments GROUP BY course_id`
  );

  const totalUsage = usageRows.reduce((sum, r) => sum + Number(r.usage_count), 0);
  if (totalUsage === 0) return { poolAmount, distributed: 0, courses: 0 };

  let distributed = 0;

  for (const row of usageRows) {
    const courseId = row.course_id;
    const usageShare = Number(row.usage_count) / totalUsage;
    const courseGross = Number((usageShare * poolAmount).toFixed(2));
    if (courseGross <= 0) continue;

    const [[course]] = await mysql.execute(
      `SELECT id, educator_id, course_title FROM courses WHERE id = ? LIMIT 1`,
      [courseId]
    );
    if (!course || !course.educator_id) continue;

    const { totalDeductionAmount, netAfterDeductions, breakdown } =
      await computeDeductions(mysql, 'course', courseId, courseGross);

    const educatorEarning = Number((netAfterDeductions * (DEFAULT_ROYALTY_PERCENT / 100)).toFixed(2));
    const platformFeeAmount = Number((courseGross - educatorEarning).toFixed(2));
    const platformFeePct = courseGross > 0
      ? Number(((platformFeeAmount / courseGross) * 100).toFixed(2)) : 0;

    const [result] = await mysql.execute(
      `INSERT INTO educator_earnings (
        educator_id, course_id, course_title, buyer_user_id,
        sale_price, platform_fee_pct, platform_fee_amount, educator_earning,
        status, paid_at, source_type, total_deductions, net_after_deductions,
        royalty_percent, usage_share_percent, pay_period
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 'subscription', ?, ?, ?, ?, ?)`,
      [
        course.educator_id, courseId, course.course_title, subscriberUserId,
        courseGross, platformFeePct, platformFeeAmount, educatorEarning,
        totalDeductionAmount, netAfterDeductions, DEFAULT_ROYALTY_PERCENT,
        Number((usageShare * 100).toFixed(4)), payPeriod
      ]
    );

    const earningId = result.insertId;
    for (const d of breakdown) {
      await mysql.execute(
        `INSERT INTO educator_earning_deductions (educator_earning_id, deduction_entity_id, percent, amount)
         VALUES (?, ?, ?, ?)`,
        [earningId, d.deduction_entity_id, d.percent, d.amount]
      );
    }

    distributed += educatorEarning;
  }

  return { poolAmount, distributed, courses: usageRows.length };
};

/* ============================================================
   MASTER FUNCTION — call this once per subscription payment
   ------------------------------------------------------------
   Reads this plan's revenue allocations (Music/Academy/Documents %,
   set at plan-creation time), computes each component's dollar pool
   from the plan price, and distributes each pool immediately.
   Planner is skipped automatically (royalty_eligible = FALSE).
   ------------------------------------------------------------
   FIX: added `subscriberUserId` param (the user whose payment this
   is) and forwards it to distributeMusicPoolRealtime /
   distributeEducatorPoolRealtime so buyer_user_id is never NULL.
   Caller (activateUserSubscription in payment.js) must pass the
   subscribing user's ID here.
============================================================ */
const distributeSubscriptionRevenueRealtime = async ({ mysql, planId, planPrice, subscriberUserId }) => {
  try {
    const [allocations] = await mysql.execute(
      `SELECT component_name, allocation_percent
       FROM plan_revenue_allocations
       WHERE plan_id = ? AND royalty_eligible = TRUE`,
      [planId]
    );

    if (allocations.length === 0) {
      console.warn(`Royalty Engine: no royalty-eligible revenue allocations for plan ${planId} - skipping real-time distribution`);
      return null;
    }

    const payPeriod = getCurrentPayPeriod();
    const results = {};

    for (const alloc of allocations) {
      const poolAmount = Number((Number(planPrice) * (Number(alloc.allocation_percent) / 100)).toFixed(2));

      if (alloc.component_name === 'Documents') {
        results.documents = await distributeDocumentPoolRealtime({ mysql, poolAmount, payPeriod });
      }
      // 'Music' and 'Academy' are intentionally NOT distributed here anymore.
      // Per the client's Pro-Rata spec (Aug 2026), those two pools require
      // the FULL Pay Period's total subscription revenue (TSS) and total
      // acquisition value (TAP) before a Pro-Rata Factor can be computed -
      // that can't be done correctly per-payment. See
      // calculateMusicProRataDistribution / calculateEducatorProRataDistribution,
      // run once per Pay Period via POST /api/royalty/pay-periods/close.
      // 'Planner' has no branch - it's 100% SL retained (SOW 4.3).
    }

    return { payPeriod, ...results };
  } catch (error) {
    console.error('Royalty Engine (real-time subscription distribution) error:', error);
    // Never throw into the subscription activation flow - a royalty calc
    // failure must not block the user getting their subscription access.
    return null;
  }
};

/* ============================================================
   PRO-RATA FACTOR ENGINE (per client spec, Aug 2026)
   ------------------------------------------------------------
   Replaces the old count-based subscription split. Each subscription
   acquisition is weighted by the product's Single Purchase Price
   (snapshotted at acquisition time), not counted equally.

   Definitions (matching the client's terminology exactly):
     TAP = Total Single Purchase Equivalent Value
           SUM(price_at_acquisition) across all qualifying subscription
           acquisitions in the Pay Period, for this component.
     TSS = Eligible Subscription Revenue
           subscription revenue allocated to this component (via
           plan_revenue_allocations) during the Pay Period.
     Pro-Rata Factor = TSS / TAP
     Product SPEV = SUM(price_at_acquisition) for that product's
           acquisitions in the period.
     Product Pro-Rata Sale Value = Product SPEV × Pro-Rata Factor
     Royalty = Pro-Rata Sale Value × Royalty Percentage (after
           deductions, same as every other flow in this engine)

   Full decimal precision is kept through every step; only the final
   per-row amount is rounded to cents (client's Section 9 requirement).
============================================================ */

/* ============================================================
   PAY PERIOD LENGTH (configurable per component, default 12 months)
============================================================ */
const getPayPeriodMonths = async (mysql, componentName) => {
  const [[row]] = await mysql.execute(
    `SELECT period_months FROM royalty_pay_period_settings WHERE component_name = ? LIMIT 1`,
    [componentName]
  );
  return row ? Number(row.period_months) : 12;
};

/* Resolve the [periodStart, periodEnd) window that "now" falls into,
   given a configurable period length in months, anchored to a fixed
   epoch (Jan 1 of the current year minus enough years to cover "now")
   so period boundaries are stable and predictable. */
const resolveCurrentPeriodWindow = (periodMonths, referenceDate = new Date()) => {
  const epoch = new Date(Date.UTC(2024, 0, 1)); // fixed anchor, arbitrary but stable
  const monthsSinceEpoch =
    (referenceDate.getUTCFullYear() - epoch.getUTCFullYear()) * 12 +
    (referenceDate.getUTCMonth() - epoch.getUTCMonth());
  const periodsElapsed = Math.floor(monthsSinceEpoch / periodMonths);

  const periodStart = new Date(Date.UTC(
    epoch.getUTCFullYear(), epoch.getUTCMonth() + periodsElapsed * periodMonths, 1
  ));
  const periodEnd = new Date(Date.UTC(
    epoch.getUTCFullYear(), epoch.getUTCMonth() + (periodsElapsed + 1) * periodMonths, 1
  ));

  const fmt = (d) => d.toISOString().slice(0, 10);
  return {
    periodStart: fmt(periodStart),
    periodEnd: fmt(periodEnd),
    payPeriod: `${fmt(periodStart)}_to_${fmt(periodEnd)}`
  };
};

/* ============================================================
   MUSIC PRO-RATA DISTRIBUTION
============================================================ */
const calculateMusicProRataDistribution = async ({ mysql, periodStart, periodEnd, payPeriod, runBy = null }) => {
  // Step 1 - TSS: Eligible Subscription Revenue allocated to Music in this period
  const [subscriptionRevenue] = await mysql.execute(
    `SELECT p.price AS plan_price, pra.allocation_percent
     FROM user_subscriptions us
     JOIN plans p ON p.id = us.plan_id
     JOIN plan_revenue_allocations pra ON pra.plan_id = p.id AND pra.component_name = 'Music' AND pra.royalty_eligible = TRUE
     WHERE us.status = 'active' AND us.created_at >= ? AND us.created_at < ?`,
    [periodStart, periodEnd]
  );

  const tss = subscriptionRevenue.reduce(
    (sum, row) => sum + (Number(row.plan_price) * (Number(row.allocation_percent) / 100)), 0
  );

  if (tss <= 0) {
    return { tss: 0, tap: 0, proRataFactor: 0, distributed: 0, compositions: 0, skipped: 'no eligible subscription revenue in period' };
  }

  // Step 2 - TAP: per-composition SPEV, only 'subscription' source acquisitions count
  // (a-la-carte acquisitions already have their own direct royalty and must not
  // also draw from this pool - see user_music_library.source_type)
  const [acquisitions] = await mysql.execute(
    `SELECT music_publication_id, COUNT(*) AS acquisitionCount, SUM(price) AS spev
     FROM user_music_library
     WHERE source_type = 'subscription' AND created_at >= ? AND created_at < ?
     GROUP BY music_publication_id`,
    [periodStart, periodEnd]
  );

  const tap = acquisitions.reduce((sum, row) => sum + Number(row.spev), 0);

  if (tap <= 0) {
    return { tss, tap: 0, proRataFactor: 0, distributed: 0, compositions: 0, skipped: 'no qualifying subscription acquisitions in period' };
  }

  // Step 3 & 4 - Pro-Rata Factor, then per-composition Pro-Rata Sale Value -> royalty
  const proRataFactor = tss / tap;
  let distributed = 0;

  for (const row of acquisitions) {
    const musicPublicationId = row.music_publication_id;
    const productSPEV = Number(row.spev);
    const proRataSaleValue = productSPEV * proRataFactor; // full precision, not rounded yet

    const [[music]] = await mysql.execute(
      `SELECT id, composer_id, composition_title FROM music_publications WHERE id = ? LIMIT 1`,
      [musicPublicationId]
    );
    if (!music || !music.composer_id) continue;

    const { totalDeductionAmount, netAfterDeductions, breakdown } =
      await computeDeductions(mysql, 'music', musicPublicationId, proRataSaleValue);

    const composerEarning = Number((netAfterDeductions * (DEFAULT_ROYALTY_PERCENT / 100)).toFixed(2));
    const roundedSaleValue = Number(proRataSaleValue.toFixed(2));
    const platformFeeAmount = Number((roundedSaleValue - composerEarning).toFixed(2));
    const platformFeePct = roundedSaleValue > 0
      ? Number(((platformFeeAmount / roundedSaleValue) * 100).toFixed(2)) : 0;

    const [result] = await mysql.execute(
      `INSERT INTO composer_earnings (
        composer_id, music_publication_id, composition_title, buyer_user_id,
        sale_price, platform_fee_pct, platform_fee_amount, composer_earning,
        status, paid_at, source_type, total_deductions, net_after_deductions,
        royalty_percent, usage_share_percent, pay_period
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 'subscription', ?, ?, ?, ?, ?)`,
      [
        music.composer_id, musicPublicationId, music.composition_title, runBy,
        roundedSaleValue, platformFeePct, platformFeeAmount, composerEarning,
        totalDeductionAmount, netAfterDeductions, DEFAULT_ROYALTY_PERCENT,
        Number(((productSPEV / tap) * 100).toFixed(4)), payPeriod
      ]
    );

    const earningId = result.insertId;
    for (const d of breakdown) {
      await mysql.execute(
        `INSERT INTO composer_earning_deductions (composer_earning_id, deduction_entity_id, percent, amount)
         VALUES (?, ?, ?, ?)`,
        [earningId, d.deduction_entity_id, d.percent, d.amount]
      );
    }

    distributed += composerEarning;
  }

  await mysql.execute(
    `INSERT INTO royalty_pro_rata_runs (
      component_name, period_start, period_end, pay_period,
      eligible_subscription_revenue, total_single_purchase_equivalent_value,
      pro_rata_factor, qualifying_acquisitions, distinct_products,
      total_royalty_distributed, run_by
    ) VALUES ('Music', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      periodStart, periodEnd, payPeriod, tss, tap, proRataFactor,
      acquisitions.reduce((s, r) => s + Number(r.acquisitionCount), 0),
      acquisitions.length, distributed.toFixed(2), runBy
    ]
  );

  return { tss, tap, proRataFactor, distributed, compositions: acquisitions.length };
};

/* ============================================================
   ACADEMY (EDUCATOR) PRO-RATA DISTRIBUTION — same method, courses
============================================================ */
const calculateEducatorProRataDistribution = async ({ mysql, periodStart, periodEnd, payPeriod, runBy = null }) => {
  const [subscriptionRevenue] = await mysql.execute(
    `SELECT p.price AS plan_price, pra.allocation_percent
     FROM user_subscriptions us
     JOIN plans p ON p.id = us.plan_id
     JOIN plan_revenue_allocations pra ON pra.plan_id = p.id AND pra.component_name = 'Academy' AND pra.royalty_eligible = TRUE
     WHERE us.status = 'active' AND us.created_at >= ? AND us.created_at < ?`,
    [periodStart, periodEnd]
  );

  const tss = subscriptionRevenue.reduce(
    (sum, row) => sum + (Number(row.plan_price) * (Number(row.allocation_percent) / 100)), 0
  );

  if (tss <= 0) {
    return { tss: 0, tap: 0, proRataFactor: 0, distributed: 0, courses: 0, skipped: 'no eligible subscription revenue in period' };
  }

  const [acquisitions] = await mysql.execute(
    `SELECT course_id, COUNT(*) AS acquisitionCount, SUM(price_at_enrollment) AS spev
     FROM course_enrollments
     WHERE source_type = 'subscription' AND enrolled_at >= ? AND enrolled_at < ?
     GROUP BY course_id`,
    [periodStart, periodEnd]
  );

  const tap = acquisitions.reduce((sum, row) => sum + Number(row.spev), 0);

  if (tap <= 0) {
    return { tss, tap: 0, proRataFactor: 0, distributed: 0, courses: 0, skipped: 'no qualifying subscription acquisitions in period' };
  }

  const proRataFactor = tss / tap;
  let distributed = 0;

  for (const row of acquisitions) {
    const courseId = row.course_id;
    const productSPEV = Number(row.spev);
    const proRataSaleValue = productSPEV * proRataFactor;

    const [[course]] = await mysql.execute(
      `SELECT id, educator_id, course_title FROM courses WHERE id = ? LIMIT 1`,
      [courseId]
    );
    if (!course || !course.educator_id) continue;

    const { totalDeductionAmount, netAfterDeductions, breakdown } =
      await computeDeductions(mysql, 'course', courseId, proRataSaleValue);

    const educatorEarning = Number((netAfterDeductions * (DEFAULT_ROYALTY_PERCENT / 100)).toFixed(2));
    const roundedSaleValue = Number(proRataSaleValue.toFixed(2));
    const platformFeeAmount = Number((roundedSaleValue - educatorEarning).toFixed(2));
    const platformFeePct = roundedSaleValue > 0
      ? Number(((platformFeeAmount / roundedSaleValue) * 100).toFixed(2)) : 0;

    const [result] = await mysql.execute(
      `INSERT INTO educator_earnings (
        educator_id, course_id, course_title, buyer_user_id,
        sale_price, platform_fee_pct, platform_fee_amount, educator_earning,
        status, paid_at, source_type, total_deductions, net_after_deductions,
        royalty_percent, usage_share_percent, pay_period
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 'subscription', ?, ?, ?, ?, ?)`,
      [
        course.educator_id, courseId, course.course_title, runBy,
        roundedSaleValue, platformFeePct, platformFeeAmount, educatorEarning,
        totalDeductionAmount, netAfterDeductions, DEFAULT_ROYALTY_PERCENT,
        Number(((productSPEV / tap) * 100).toFixed(4)), payPeriod
      ]
    );

    const earningId = result.insertId;
    for (const d of breakdown) {
      await mysql.execute(
        `INSERT INTO educator_earning_deductions (educator_earning_id, deduction_entity_id, percent, amount)
         VALUES (?, ?, ?, ?)`,
        [earningId, d.deduction_entity_id, d.percent, d.amount]
      );
    }

    distributed += educatorEarning;
  }

  await mysql.execute(
    `INSERT INTO royalty_pro_rata_runs (
      component_name, period_start, period_end, pay_period,
      eligible_subscription_revenue, total_single_purchase_equivalent_value,
      pro_rata_factor, qualifying_acquisitions, distinct_products,
      total_royalty_distributed, run_by
    ) VALUES ('Academy', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      periodStart, periodEnd, payPeriod, tss, tap, proRataFactor,
      acquisitions.reduce((s, r) => s + Number(r.acquisitionCount), 0),
      acquisitions.length, distributed.toFixed(2), runBy
    ]
  );

  return { tss, tap, proRataFactor, distributed, courses: acquisitions.length };
};

module.exports = {
  getCurrentPayPeriod,
  computeDeductions,
  recordMusicALaCarteEarning,
  recordOneLicenseEarning,
  logReviewBoardStipend,
  logDocumentAccess,
  distributeMusicSubscriptionPool,
  distributeDocumentSubscriptionPool,
  processRoyaltyReturn,
  getDiocesanAdoptionDiscount,
  recordEducatorALaCarteEarning,
  distributeEducatorSubscriptionPool,
  distributeMusicPoolRealtime,
  distributeDocumentPoolRealtime,
  distributeEducatorPoolRealtime,
  distributeSubscriptionRevenueRealtime,
  getPayPeriodMonths,
  resolveCurrentPeriodWindow,
  calculateMusicProRataDistribution,
  calculateEducatorProRataDistribution
};