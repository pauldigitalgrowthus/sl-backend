const { stripe, createStripeCustomer } = require('../config/stripe');

// Safe file type helper
const getSafeFileType = (raw) => {
    if (!raw) return 'unknown';
    const t = String(raw).toLowerCase();
    if (t.includes('pdf')) return 'pdf';
    if (t.includes('mp3')) return 'mp3';
    if (t.includes('wav')) return 'wav';
    if (t.includes('audio')) return 'audio';
    if (t.includes('score')) return 'score';
    return 'unknown';
};

/* ==========================================
   COUPON VALIDATION HELPER
   ========================================== */
async function validateAndApplyCoupon(mysqlConnection, couponCode, userId, couponFor = 'music') {
    if (!couponCode) return { valid: false, coupon: null, stripeCouponId: null };

    try {
        // Fetch coupon from database
        const [[coupon]] = await mysqlConnection.execute(
            `SELECT *
         FROM coupons
         WHERE code = ?
           AND status = 'active'
           AND coupon_for = ?
           AND user_id IS NULL
           AND (valid_from IS NULL OR valid_from <= NOW())
           AND (valid_till IS NULL OR valid_till >= NOW())`,
            [couponCode.trim(), couponFor]
        );

        if (!coupon) {
            return { valid: false, error: 'Invalid or expired coupon', coupon: null, stripeCouponId: null };
        }

        // Check user usage limit
        const [[userUse]] = await mysqlConnection.execute(
            `SELECT COUNT(*) AS total FROM coupons WHERE code = ? AND user_id = ?`,
            [couponCode.trim(), userId]
        );

        if (coupon.max_uses_per_user !== null && userUse.total >= coupon.max_uses_per_user) {
            return { valid: false, error: 'You have already used this coupon', coupon: null, stripeCouponId: null };
        }

        // Check total usage limit
        if (coupon.max_total_uses !== null) {
            const [[totalUse]] = await mysqlConnection.execute(
                `SELECT COUNT(*) AS total FROM coupons WHERE code = ? AND user_id IS NOT NULL`,
                [couponCode.trim()]
            );

            if (totalUse.total >= coupon.max_total_uses) {
                return { valid: false, error: 'Coupon usage limit reached', coupon: null, stripeCouponId: null };
            }
        }

        // Create Stripe coupon
        const stripeCoupon = await stripe.coupons.create({
            name: coupon.code,
            duration: 'once',
            ...(coupon.discount_type === 'percentage'
                ? { percent_off: coupon.discount_value }
                : { amount_off: Math.round(coupon.discount_value * 100), currency: 'usd' })
        });

        return {
            valid: true,
            coupon: coupon,
            stripeCouponId: stripeCoupon.id,
            error: null
        };
    } catch (error) {
        console.error('Coupon validation error:', error);
        return { valid: false, error: 'Failed to validate coupon', coupon: null, stripeCouponId: null };
    }
}

/* ==========================================
   MARK COUPON AS USED
   ========================================== */
async function markCouponAsUsed(mysqlConnection, couponCode, userId, transactionId, sessionId) {
    try {
        // Check if already used by this user
        const [[used]] = await mysqlConnection.execute(
            'SELECT id FROM coupons WHERE code = ? AND user_id = ?',
            [couponCode, userId]
        );

        if (!used) {
            await mysqlConnection.execute(
                `INSERT INTO coupons (
            code, coupon_for, user_id, transaction_id,
            status, used_at, metadata
          )
          SELECT
            code, coupon_for, ?, ?, 'used', NOW(),
            JSON_OBJECT('source', 'stripe', 'session_id', ?)
          FROM coupons
          WHERE code = ? AND user_id IS NULL
          LIMIT 1`,
                [userId, transactionId, sessionId, couponCode]
            );
        }
    } catch (error) {
        console.error('Mark coupon as used error:', error);
        // Don't throw - this is not critical
    }
}

module.exports = {
    validateAndApplyCoupon, markCouponAsUsed, getSafeFileType
}