const express = require('express');
const { sendEmail } = require('../utils/SendMailer');
const { successResponse, errorResponse } = require('../utils/response');

const router = express.Router();

const SUPPORT_RECIPIENTS = (process.env.SUPPORT_EMAIL_RECIPIENTS || 'kevin.digitalgrowthus@gmail.com')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

const SUPPORT_FROM_NAME = process.env.SUPPORT_FROM_NAME || 'Simply Liturgical Support';
const SUPPORT_REPLY_SUBJECT = process.env.SUPPORT_REPLY_SUBJECT || 'Thanks for contacting Simply Liturgical';

router.post('/contact', async (req, res) => {
  try {
    const { fullName, email, subject, message, portal } = req.body || {};

    if (!fullName || !email || !message) {
      return errorResponse(res,
        'Full name, email and message are required to submit the contact form.',
        400
      );
    }

    const primaryRecipients = SUPPORT_RECIPIENTS.length ? SUPPORT_RECIPIENTS : ['teamdigitalgrowthus@gmail.com'];
    const portalLabel = portal && typeof portal === 'string' ? portal : 'General';
    const supportSubject = subject && subject.trim()
      ? `${subject.trim()}`
      : `New contact form submission from ${fullName}`;

    const supportHtml = `
      <div>
        <h2>New Contact Form Submission</h2>
        <p>A user reached out to Simply Liturgical via the contact form.</p>
        <ul>
          <li><strong>Name:</strong> ${fullName}</li>
          <li><strong>Email:</strong> ${email}</li>
          ${subject ? `<li><strong>Subject:</strong> ${subject}</li>` : ''}
          ${portal ? `<li><strong>Portal:</strong> ${portal}</li>` : ''}
          <li><strong>Message:</strong><br/> ${message.replace(/\n/g, '<br/>')}
          </li>
        </ul>
      </div>
    `;

    const userHtml = `
      <div>
        <h2>Thank you for reaching out!</h2>
        <p>We received your message and a member of our team will reply as soon as possible.</p>
        <p><strong>Your message:</strong></p>
        <p style="white-space: pre-line;">${message}</p>
        <p>If you need to add anything else, just reply to this email and we will get back to you.</p>
        <p>Warm regards,<br/>Simply Liturgical Support</p>
      </div>
    `;

    const supportResult = await sendEmail({
      to: primaryRecipients,
      subject: supportSubject,
      html: supportHtml,
      replyTo: email,
      fromName: SUPPORT_FROM_NAME
    });

    if (!supportResult.success) {
      return errorResponse(res, 'Could not send message to support team.', 502);
    }

    const userResult = await sendEmail({
      to: email,
      subject: SUPPORT_REPLY_SUBJECT,
      html: userHtml,
      fromName: SUPPORT_FROM_NAME
    });

    if (!userResult.success) {
      console.warn('Contact form: reply email failed', userResult.error);
    }

    return successResponse(res, null, 'Your message has been sent. We will respond shortly.');
  } catch (error) {
    console.error('Contact form submission failed:', error);
    return errorResponse(res, 'Failed to submit contact form, please try again later.', 500);
  }
});

module.exports = router;
