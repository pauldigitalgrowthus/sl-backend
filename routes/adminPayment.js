const express = require('express');
const Stripe = require('stripe');
const { auth } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/response');
const { getMySQLConnection } = require('../config/mysql');

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Middleware to check if user is admin/sl_team
const isAdmin = async (req, res, next) => {
  try {
    const mysqlConnection = getMySQLConnection();
    const [users] = await mysqlConnection.execute(
      'SELECT role FROM users WHERE id = ?',
      [req.user.id]
    );

    if (users.length === 0 || users[0].role !== 'sl_team') {
      return errorResponse(res, 'Admin access required', 403);
    }
    next();
  } catch (error) {
    console.error('Admin check error:', error);
    errorResponse(res, 'Authorization failed', 500);
  }
};

// ============================================
// ADMIN - PAYMENT TRANSACTIONS
// ============================================

// @route   GET /api/admin/payments/transactions
// @desc    Get all payment transactions with filters
// @access  Private (Admin only)
router.get('/transactions', [auth], async (req, res) => {
  try {
    const { 
      status, 
      userId, 
      planId, 
      startDate, 
      endDate,
      page = 1, 
      limit = 50 
    } = req.query;

    const mysqlConnection = getMySQLConnection();
    const offset = (page - 1) * limit;

    // ========================
    // 1️⃣ Build WHERE clause
    // ========================
    const conditions = [];
    const params = [];

    if (status) {
      conditions.push('pt.status = ?');
      params.push(status);
    }
    if (userId) {
      conditions.push('pt.user_id = ?');
      params.push(userId);
    }
    if (planId) {
      conditions.push('pt.plan_id = ?');
      params.push(planId);
    }
    if (startDate) {
      conditions.push('pt.created_at >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('pt.created_at <= ?');
      params.push(endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // ========================
    // 2️⃣ Get total count
    // ========================
    const [countResult] = await mysqlConnection.execute(
      `SELECT COUNT(*) as total FROM payment_transactions pt ${whereClause}`,
      params
    );
    const total = countResult[0].total;

    // ========================
    // 3️⃣ Get transactions
    // ========================
    const [transactions] = await mysqlConnection.execute(
      `SELECT 
        pt.*,
        u.email AS user_email,
        u.first_name,
        u.last_name,
        u.plan_start_date,
        u.plan_end_date,              -- 👈 include expiry info
        p.name AS plan_name,
        p.billing_cycle
      FROM payment_transactions pt
      LEFT JOIN users u ON pt.user_id = u.id
      LEFT JOIN plans p ON pt.plan_id = p.id
      ${whereClause}
      ORDER BY pt.created_at DESC
      LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    // ========================
    // 4️⃣ Format response
    // ========================
    const formatted = transactions.map(tx => ({
      ...tx,
      plan_expiry: tx.plan_end_date,  // 👈 explicit field for clarity
    }));

    successResponse(res, {
      transactions: formatted,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit),
      },
    }, 'Transactions retrieved successfully');

  } catch (error) {
    console.error('Get transactions error:', error);
    errorResponse(res, 'Failed to retrieve transactions', 500);
  }
});

// @route   GET /api/admin/payments/transactions/:id
// @desc    Get single transaction details
// @access  Private (Admin only)
router.get('/transactions/:id', [auth, isAdmin], async (req, res) => {
  try {
    const { id } = req.params;
    const mysqlConnection = getMySQLConnection();

    const [transactions] = await mysqlConnection.execute(
      `SELECT 
        pt.*,
        u.email as user_email,
        u.first_name,
        u.last_name,
        u.phone as user_phone,
        p.name as plan_name,
        p.billing_cycle,
        p.price as plan_price
      FROM payment_transactions pt
      LEFT JOIN users u ON pt.user_id = u.id
      LEFT JOIN plans p ON pt.plan_id = p.id
      WHERE pt.id = ?`,
      [id]
    );

    if (transactions.length === 0) {
      return errorResponse(res, 'Transaction not found', 404);
    }

    const transaction = transactions[0];

    // Get refunds if any
    const [refunds] = await mysqlConnection.execute(
      `SELECT * FROM refunds WHERE transaction_id = ?`,
      [id]
    );

    successResponse(res, {
      transaction,
      refunds
    }, 'Transaction details retrieved successfully');

  } catch (error) {
    console.error('Get transaction error:', error);
    errorResponse(res, 'Failed to retrieve transaction', 500);
  }
});

// @route   POST /api/admin/payments/refund/:transactionId
// @desc    Process refund for a transaction
// @access  Private (Admin only)
router.post('/refund/:transactionId', [auth, isAdmin], async (req, res) => {
  try {
    const { transactionId } = req.params;
    const { amount, reason, description } = req.body;
    const mysqlConnection = getMySQLConnection();

    // Get transaction
    const [transactions] = await mysqlConnection.execute(
      'SELECT * FROM payment_transactions WHERE id = ? AND status = "completed"',
      [transactionId]
    );

    if (transactions.length === 0) {
      return errorResponse(res, 'Transaction not found or not eligible for refund', 404);
    }

    const transaction = transactions[0];

    if (!transaction.stripe_payment_intent_id) {
      return errorResponse(res, 'No payment intent found for this transaction', 400);
    }

    // Process refund in Stripe
    const refund = await stripe.refunds.create({
      payment_intent: transaction.stripe_payment_intent_id,
      amount: amount ? Math.round(amount * 100) : undefined, // Partial or full refund
      reason: reason || 'requested_by_customer',
      metadata: {
        transaction_id: transactionId.toString(),
        admin_id: req.user.id.toString()
      }
    });

    // Save refund record
    await mysqlConnection.execute(
      `INSERT INTO refunds (
        transaction_id, user_id, stripe_refund_id, stripe_payment_intent_id,
        amount, currency, reason, status, description, refunded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        transactionId,
        transaction.user_id,
        refund.id,
        transaction.stripe_payment_intent_id,
        refund.amount / 100,
        refund.currency,
        reason || 'requested_by_customer',
        refund.status,
        description || null
      ]
    );

    // Update transaction status
    await mysqlConnection.execute(
      `UPDATE payment_transactions 
       SET status = 'refunded', refund_reason = ?, updated_at = NOW()
       WHERE id = ?`,
      [description || reason, transactionId]
    );

    successResponse(res, {
      refund: {
        id: refund.id,
        amount: refund.amount / 100,
        status: refund.status
      }
    }, 'Refund processed successfully');

  } catch (error) {
    console.error('Process refund error:', error);
    errorResponse(res, error.message || 'Failed to process refund', 500);
  }
});

// ============================================
// ADMIN - SUBSCRIPTIONS MANAGEMENT
// ============================================

// @route   GET /api/admin/payments/subscriptions
// @desc    Get all subscriptions
// @access  Private (Admin only)
router.get('/subscriptions', [auth, isAdmin], async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const mysqlConnection = getMySQLConnection();
    const offset = (page - 1) * limit;

    const whereClause = status ? 'WHERE ss.status = ?' : '';
    const params = status ? [status] : [];

    const [subscriptions] = await mysqlConnection.execute(
      `SELECT 
        ss.*,
        u.email as user_email,
        u.first_name,
        u.last_name,
        p.name as plan_name,
        p.price,
        p.billing_cycle
      FROM stripe_subscriptions ss
      LEFT JOIN users u ON ss.user_id = u.id
      LEFT JOIN plans p ON u.current_plan_id = p.id
      ${whereClause}
      ORDER BY ss.created_at DESC
      LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    const [countResult] = await mysqlConnection.execute(
      `SELECT COUNT(*) as total FROM stripe_subscriptions ss ${whereClause}`,
      params
    );

    successResponse(res, {
      subscriptions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    }, 'Subscriptions retrieved successfully');

  } catch (error) {
    console.error('Get subscriptions error:', error);
    errorResponse(res, 'Failed to retrieve subscriptions', 500);
  }
});

// @route   POST /api/admin/payments/subscriptions/:subscriptionId/cancel
// @desc    Cancel a subscription immediately
// @access  Private (Admin only)
router.post('/subscriptions/:subscriptionId/cancel', [auth, isAdmin], async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    const mysqlConnection = getMySQLConnection();

    const [subscriptions] = await mysqlConnection.execute(
      'SELECT * FROM stripe_subscriptions WHERE id = ?',
      [subscriptionId]
    );

    if (subscriptions.length === 0) {
      return errorResponse(res, 'Subscription not found', 404);
    }

    const subscription = subscriptions[0];

    // Cancel in Stripe
    const canceledSubscription = await stripe.subscriptions.cancel(
      subscription.stripe_subscription_id
    );

    // Update local record
    await mysqlConnection.execute(
      `UPDATE stripe_subscriptions 
       SET status = 'canceled', canceled_at = NOW(), ended_at = NOW(), updated_at = NOW()
       WHERE id = ?`,
      [subscriptionId]
    );

    // Update user status
    await mysqlConnection.execute(
      `UPDATE users SET plan_status = 'cancelled' WHERE id = ?`,
      [subscription.user_id]
    );

    successResponse(res, {
      subscription: canceledSubscription
    }, 'Subscription cancelled successfully');

  } catch (error) {
    console.error('Cancel subscription error:', error);
    errorResponse(res, 'Failed to cancel subscription', 500);
  }
});

// ============================================
// ADMIN - ANALYTICS & REPORTS
// ============================================

// @route   GET /api/admin/payments/analytics/overview
// @desc    Get payment analytics overview
// @access  Private (Admin only)
router.get('/analytics/overview', [auth, isAdmin], async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const mysqlConnection = getMySQLConnection();

    const dateFilter = startDate && endDate 
      ? 'WHERE created_at BETWEEN ? AND ?' 
      : '';
    const params = startDate && endDate ? [startDate, endDate] : [];

    // Total revenue
    const [revenueResult] = await mysqlConnection.execute(
      `SELECT 
        SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END) as total_revenue,
        SUM(CASE WHEN status = 'refunded' THEN amount ELSE 0 END) as total_refunded,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as successful_transactions,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_transactions,
        COUNT(*) as total_transactions
      FROM payment_transactions ${dateFilter}`,
      params
    );

    // Revenue by plan
    const [revenueByPlan] = await mysqlConnection.execute(
      `SELECT 
        p.name as plan_name,
        p.billing_cycle,
        COUNT(pt.id) as transaction_count,
        SUM(pt.amount) as total_revenue
      FROM payment_transactions pt
      INNER JOIN plans p ON pt.plan_id = p.id
      WHERE pt.status = 'completed' ${startDate ? 'AND pt.created_at BETWEEN ? AND ?' : ''}
      GROUP BY pt.plan_id
      ORDER BY total_revenue DESC`,
      startDate && endDate ? [startDate, endDate] : []
    );

    // Payment methods breakdown
    const [paymentMethods] = await mysqlConnection.execute(
      `SELECT 
        payment_method,
        COUNT(*) as count,
        SUM(amount) as revenue
      FROM payment_transactions
      WHERE status = 'completed' AND payment_method IS NOT NULL ${startDate ? 'AND created_at BETWEEN ? AND ?' : ''}
      GROUP BY payment_method`,
      startDate && endDate ? [startDate, endDate] : []
    );

    // Active subscriptions
    const [subscriptionStats] = await mysqlConnection.execute(
      `SELECT 
        COUNT(CASE WHEN status = 'active' THEN 1 END) as active_subscriptions,
        COUNT(CASE WHEN status = 'canceled' THEN 1 END) as canceled_subscriptions,
        COUNT(CASE WHEN status = 'past_due' THEN 1 END) as past_due_subscriptions
      FROM stripe_subscriptions`
    );

    // Monthly recurring revenue (MRR)
    const [mrrResult] = await mysqlConnection.execute(
      `SELECT 
        SUM(p.price) as mrr
      FROM stripe_subscriptions ss
      INNER JOIN users u ON ss.user_id = u.id
      INNER JOIN plans p ON u.current_plan_id = p.id
      WHERE ss.status = 'active' AND p.billing_cycle = 'monthly'`
    );

    // Annual recurring revenue (ARR)
    const [arrResult] = await mysqlConnection.execute(
      `SELECT 
        SUM(p.price) as arr
      FROM stripe_subscriptions ss
      INNER JOIN users u ON ss.user_id = u.id
      INNER JOIN plans p ON u.current_plan_id = p.id
      WHERE ss.status = 'active' AND p.billing_cycle = 'yearly'`
    );

    successResponse(res, {
      overview: revenueResult[0],
      revenueByPlan,
      paymentMethods,
      subscriptions: subscriptionStats[0],
      mrr: mrrResult[0]?.mrr || 0,
      arr: arrResult[0]?.arr || 0
    }, 'Analytics retrieved successfully');

  } catch (error) {
    console.error('Get analytics error:', error);
    errorResponse(res, 'Failed to retrieve analytics', 500);
  }
});

// @route   GET /api/admin/payments/analytics/revenue-chart
// @desc    Get revenue data for charts (daily/monthly)
// @access  Private (Admin only)
router.get('/analytics/revenue-chart', [auth, isAdmin], async (req, res) => {
  try {
    const { period = 'daily', startDate, endDate } = req.query;
    const mysqlConnection = getMySQLConnection();

    const groupBy = period === 'monthly' 
      ? "DATE_FORMAT(created_at, '%Y-%m')" 
      : "DATE(created_at)";

    const [chartData] = await mysqlConnection.execute(
      `SELECT 
        ${groupBy} as period,
        SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END) as revenue,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as successful_count,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_count
      FROM payment_transactions
      WHERE created_at BETWEEN ? AND ?
      GROUP BY period
      ORDER BY period ASC`,
      [startDate || '2020-01-01', endDate || new Date().toISOString().split('T')[0]]
    );

    successResponse(res, {
      chartData,
      period
    }, 'Revenue chart data retrieved successfully');

  } catch (error) {
    console.error('Get revenue chart error:', error);
    errorResponse(res, 'Failed to retrieve revenue chart data', 500);
  }
});

// @route   GET /api/admin/payments/customers
// @desc    Get all payment customers
// @access  Private (Admin only)
router.get('/customers', [auth, isAdmin], async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const mysqlConnection = getMySQLConnection();
    const offset = (page - 1) * limit;

    const [customers] = await mysqlConnection.execute(
      `SELECT 
        pc.*,
        u.first_name,
        u.last_name,
        u.phone as user_phone,
        u.plan_status,
        p.name as current_plan,
        COUNT(DISTINCT pt.id) as total_transactions,
        SUM(CASE WHEN pt.status = 'completed' THEN pt.amount ELSE 0 END) as lifetime_value
      FROM payment_customers pc
      LEFT JOIN users u ON pc.user_id = u.id
      LEFT JOIN plans p ON u.current_plan_id = p.id
      LEFT JOIN payment_transactions pt ON pc.user_id = pt.user_id
      GROUP BY pc.id
      ORDER BY lifetime_value DESC
      LIMIT ? OFFSET ?`,
      [parseInt(limit), offset]
    );

    const [countResult] = await mysqlConnection.execute(
      'SELECT COUNT(*) as total FROM payment_customers'
    );

    successResponse(res, {
      customers,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    }, 'Customers retrieved successfully');

  } catch (error) {
    console.error('Get customers error:', error);
    errorResponse(res, 'Failed to retrieve customers', 500);
  }
});

// @route   GET /api/admin/payments/webhooks/logs
// @desc    Get webhook logs
// @access  Private (Admin only)
router.get('/webhooks/logs', [auth, isAdmin], async (req, res) => {
  try {
    const { eventType, processed, page = 1, limit = 100 } = req.query;
    const mysqlConnection = getMySQLConnection();
    const offset = (page - 1) * limit;

    const conditions = [];
    const params = [];

    if (eventType) {
      conditions.push('event_type = ?');
      params.push(eventType);
    }
    if (processed !== undefined) {
      conditions.push('processed = ?');
      params.push(processed === 'true');
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [logs] = await mysqlConnection.execute(
      `SELECT * FROM webhook_logs ${whereClause}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    const [countResult] = await mysqlConnection.execute(
      `SELECT COUNT(*) as total FROM webhook_logs ${whereClause}`,
      params
    );

    successResponse(res, {
      logs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: countResult[0].total,
        totalPages: Math.ceil(countResult[0].total / limit)
      }
    }, 'Webhook logs retrieved successfully');

  } catch (error) {
    console.error('Get webhook logs error:', error);
    errorResponse(res, 'Failed to retrieve webhook logs', 500);
  }
});

// @route   GET /api/admin/payments/export/transactions
// @desc    Export transactions to CSV
// @access  Private (Admin only)
router.get('/export/transactions', [auth, isAdmin], async (req, res) => {
  try {
    const { startDate, endDate, status } = req.query;
    const mysqlConnection = getMySQLConnection();

    const conditions = [];
    const params = [];

    if (startDate) {
      conditions.push('pt.created_at >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('pt.created_at <= ?');
      params.push(endDate);
    }
    if (status) {
      conditions.push('pt.status = ?');
      params.push(status);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [transactions] = await mysqlConnection.execute(
      `SELECT 
        pt.id as transaction_id,
        u.email as user_email,
        u.first_name,
        u.last_name,
        p.name as plan_name,
        pt.amount,
        pt.currency,
        pt.status,
        pt.payment_method,
        pt.stripe_payment_intent_id,
        pt.completed_at,
        pt.created_at
      FROM payment_transactions pt
      LEFT JOIN users u ON pt.user_id = u.id
      LEFT JOIN plans p ON pt.plan_id = p.id
      ${whereClause}
      ORDER BY pt.created_at DESC`,
      params
    );

    // Convert to CSV
    const csv = convertToCSV(transactions);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=transactions_${Date.now()}.csv`);
    res.send(csv);

  } catch (error) {
    console.error('Export transactions error:', error);
    errorResponse(res, 'Failed to export transactions', 500);
  }
});

// Helper function to convert JSON to CSV
function convertToCSV(data) {
  if (data.length === 0) return '';

  const headers = Object.keys(data[0]);
  const csvRows = [];

  // Add headers
  csvRows.push(headers.join(','));

  // Add data rows
  for (const row of data) {
    const values = headers.map(header => {
      const value = row[header];
      if (value === null || value === undefined) return '';
      // Escape commas and quotes
      const escaped = String(value).replace(/"/g, '""');
      return `"${escaped}"`;
    });
    csvRows.push(values.join(','));
  }

  return csvRows.join('\n');
}

module.exports = router;