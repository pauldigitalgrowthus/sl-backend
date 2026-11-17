// services/planPermission.service.js
/**
 * Simple & clean subscription created email template
 * No heavy CSS – inbox friendly
 */

function subscriptionCreatedTemplate({
  userName = 'User',
  planName = '-',
  startDate,
  endDate,
  paymentType = '',
  subscriptionId,
  amount,
  currency = 'USD'
}) {

  const formatDate = (d) => {
    if (!d) return '-';
    return new Date(d).toLocaleDateString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
      timeZone: 'UTC'
    });
  };

  const formatAmount = (amt) => {
    if (amt === undefined || amt === null) return 'N/A';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency
    }).format(amt);
  };

  const capitalize = (s = '') =>
    s.charAt(0).toUpperCase() + s.slice(1);

  const html = `
  <div style="font-family: Arial, Helvetica, sans-serif; font-size:14px; line-height:1.6; color:#222;">
    <p>Hi ${userName},</p>

    <p>Thank you! Your subscription purchase is confirmed.</p>

    <p><strong>Order details:</strong></p>
    <ul>
      <li><strong>Plan:</strong> ${planName}</li>
      <li><strong>Amount:</strong> ${formatAmount(amount)}</li>
      <li><strong>Purchase date:</strong> ${formatDate(startDate)}</li>
      <li><strong>Next renewal:</strong> ${formatDate(endDate)}</li>
    </ul>

    <p>
      Manage your subscription anytime here:<br/>
      <a href="${process.env.FRONTEND_URL}/subscription">Manage Subscription</a>
    </p>

    <p>
      If you need help, contact <a href="mailto:${process.env.SUPPORT_MAIL}">${process.env.SUPPORT_MAIL }</a>. We are so happy that you have joined us in the service of the Church.
    </p>

    <p>God bless,<br/>— Simply Liturgical Team</p>
  </div>
  `;

  const text = `
Hi ${userName},

Thank you! Your subscription purchase is confirmed.

Order details:
- Plan: ${planName}
- Amount: ${formatAmount(amount)} (${capitalize(paymentType)})
- Purchase date: ${formatDate(startDate)}
- Next renewal: ${formatDate(endDate)}

Manage your subscription anytime here:
${process.env.FRONTEND_URL || 'https://yourapp.com'}/manage-subscription

If you need help, contact ${process.env.SUPPORT_MAIL}. We are so happy that you have joined us in the service of the Church.

God bless,
— Simply Liturgical Team
  `.trim();

  return {
    subject: `Subscription Confirmation - ${planName}`,
    html,
    text
  };
}

function subscriptionCancelledTemplate({
  firstName = 'User',
  planName = 'Paid Plan',
  cancellationEffectiveDate = new Date(),
  decisionNotes = 'No reason provided',
  manageSubscriptionLink = `${process.env.FRONTEND_URL}/subscription`,
  supportEmail = process.env.SUPPORT_MAIL
}) {
  const formatDate = (d) =>
    new Date(d).toLocaleDateString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
      timeZone: 'UTC'
    });

  const subject = 'Important: Your subscription has been canceled';

  const html = `
  <div style="font-family: Arial, Helvetica, sans-serif; font-size:14px; line-height:1.6; color:#222;">
    <p>Hi ${firstName},</p>

    <p>This is a notification that an administrator has canceled your Simply Liturgical subscription (<strong>${planName}</strong>).</p>

    <ul>
      <li><strong>Cancellation effective date:</strong> ${formatDate(cancellationEffectiveDate)}</li>
      <li><strong>Reason (if provided):</strong> ${decisionNotes}</li>
      <li><strong>Manage plans:</strong> <a href="${manageSubscriptionLink}">${manageSubscriptionLink}</a></li>
    </ul>

    <p>
      If you believe this was done in error or you need assistance, please contact <a href="mailto:${supportEmail}">${supportEmail}</a>.
    </p>

    <p>God bless,<br/>— Simply Liturgical Team</p>
  </div>
  `;

  const text = `
Hi ${firstName},

This is a notification that an administrator has canceled your Simply Liturgical subscription (${planName}).

- Cancellation effective date: ${formatDate(cancellationEffectiveDate)}
- Reason: ${decisionNotes}
- Manage plans: ${manageSubscriptionLink}

If you believe this was done in error or you need assistance, please contact ${supportEmail}.

God bless,
— Simply Liturgical Team
  `.trim();

  return { subject, html, text };
}

function subscriptionExpiredTemplate({
  firstName = 'User',
  planName = 'Paid Plan',
  expiryDate = new Date(),
  manageSubscriptionLink = `${process.env.FRONTEND_URL}/manage-subscription`,
  supportEmail = process.env.SUPPORT_MAIL
}) {
  const formatDate = (d) =>
    new Date(d).toLocaleDateString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
      timeZone: 'UTC'
    });

  const subject = 'Your subscription has expired';

  const html = `
  <div style="font-family: Arial, Helvetica, sans-serif; font-size:14px; line-height:1.6; color:#222;">
    <p>Hi ${firstName},</p>

    <p>Your Simply Liturgical subscription (<strong>${planName}</strong>) expired on <strong>${formatDate(expiryDate)}</strong>.</p>

    <p>To restore access, renew your subscription here:<br/>
      <a href="${manageSubscriptionLink}">${manageSubscriptionLink}</a>
    </p>

    <p>
      If you believe this is an error, reply to this email or contact <a href="mailto:${supportEmail}">${supportEmail}</a>.
    </p>

    <p>God bless,<br/>— Simply Liturgical Team</p>
  </div>
  `;

  const text = `
Hi ${firstName},

Your Simply Liturgical subscription (${planName}) expired on ${formatDate(expiryDate)}.

To restore access, renew your subscription here:
${manageSubscriptionLink}

If you believe this is an error, reply to this email or contact ${supportEmail}.

God bless,
— Simply Liturgical Team
  `.trim();

  return { subject, html, text };
}

function subscriptionConfirmationTemplate({
  firstName = 'User',
  planName = '-',
  amount,
  billingCycle = '-',
  purchaseDate,
  renewalDate,
  manageSubscriptionLink,
  supportEmail = process.env.SUPPORT_MAIL
}) {
  const formatDate = (d) => {
    if (!d) return '-';
    return new Date(d).toLocaleDateString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
      timeZone: 'UTC'
    });
  };

  const html = `
  <div style="font-family: Arial, Helvetica, sans-serif; font-size:14px; line-height:1.6; color:#222;">
    <p>Hi ${firstName},</p>

    <p>Thank you! Your subscription purchase is confirmed.</p>

    <p><strong>Order details:</strong></p>
    <ul>
      <li><strong>Plan:</strong> ${planName}</li>
      <li><strong>Amount:</strong> ${amount} (${billingCycle})</li>
      <li><strong>Purchase date:</strong> ${formatDate(purchaseDate)}</li>
      <li><strong>Next renewal:</strong> ${formatDate(renewalDate)}</li>
    </ul>

    <p>
      Manage your subscription anytime here:<br/>
      <a href="${manageSubscriptionLink}">${manageSubscriptionLink}</a>
    </p>

    <p>
      If you need help, contact <a href="mailto:${supportEmail}">${supportEmail}</a>. We are so happy that you have joined us in the service of the Church.
    </p>

    <p>God bless,<br/>— Simply Liturgical Team</p>
  </div>
  `;

  const text = `
Hi ${firstName},

Thank you! Your subscription purchase is confirmed.

Order details:
- Plan: ${planName}
- Amount: ${amount} (${billingCycle})
- Purchase date: ${formatDate(purchaseDate)}
- Next renewal: ${formatDate(renewalDate)}

Manage your subscription anytime here:
${manageSubscriptionLink}

If you need help, contact ${supportEmail}. We are so happy that you have joined us in the service of the Church.

God bless,
— Simply Liturgical Team
  `.trim();

  return {
    subject: `Subscription Confirmation - ${planName}`,
    html,
    text
  };
}

module.exports = {
  subscriptionCreatedTemplate,
  subscriptionCancelledTemplate,
  subscriptionExpiredTemplate,
  subscriptionConfirmationTemplate
};