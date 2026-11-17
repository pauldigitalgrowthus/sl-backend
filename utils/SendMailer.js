const nodemailer = require("nodemailer");

// Email configuration with environment variables and defaults
const emailConfig = {
  host: "smtp.gmail.com",
  port: parseInt(process.env.SMTP_PORT) || 465,
  secure: process.env.SMTP_SECURE === 'true' || true,
  auth: {
    user: process.env.MAIL_USERNAME,
    pass: process.env.MAIL_PASSWORD
  },
  from: process.env.MAIL_FROM,
  fromName: process.env.MAIL_FROM_NAME || "Simply Liturgical Team",
  tls: {
    rejectUnauthorized: false,
  },
  pool: true,
  maxConnections: parseInt(process.env.SMTP_MAX_CONNECTIONS) || 5,
  maxMessages: parseInt(process.env.SMTP_MAX_MESSAGES) || 100,
  connectionTimeout: 10000, // 10 sec
  greetingTimeout: 10000,
  socketTimeout: 10000
};

// Create reusable email transporter
let transporter = null;

const createTransporter = () => {
  if (!transporter) {
    transporter = nodemailer.createTransport(emailConfig);
  }
  return transporter;
};

/**
 * Helper function to format email addresses
 * Converts array or comma-separated string to proper format
 */
const formatEmailList = (emails) => {
  if (!emails) return undefined;

  if (Array.isArray(emails)) {
    return emails.filter(e => e && e.trim()).join(', ');
  }

  if (typeof emails === 'string') {
    return emails.trim();
  }

  return undefined;
};

/**
 * Send email with flexible options
 * @param {Object} options - Email options
 * @param {string|Array} options.to - Recipient email(s) - Required
 * @param {string} options.subject - Email subject - Required
 * @param {string} options.html - HTML content - Required
 * @param {string} [options.text] - Plain text content
 * @param {string} [options.from] - Custom sender email
 * @param {string} [options.fromName] - Custom sender name
 * @param {string|Array} [options.cc] - CC recipients (carbon copy)
 * @param {string|Array} [options.bcc] - BCC recipients (blind carbon copy)
 * @param {Array} [options.attachments] - Email attachments
 * @param {string|Array} [options.replyTo] - Reply-to address(es)
 * @returns {Promise<Object>} - Result object with success status
 * 
 * @example
 * // Single recipient
 * sendEmail({
 *   to: 'user@example.com',
 *   subject: 'Test Email',
 *   html: '<h1>Hello</h1>'
 * });
 * 
 * @example
 * // Multiple recipients with CC and BCC
 * sendEmail({
 *   to: ['user1@example.com', 'user2@example.com'],
 *   cc: ['manager@example.com'],
 *   bcc: ['admin@example.com', 'backup@example.com'],
 *   subject: 'Team Update',
 *   html: '<p>Important update</p>'
 * });
 */
const sendEmail = async (options) => {
  // Validate required fields
  if (!options || !options.to || !options.subject || !options.html) {
    return {
      success: false,
      error: 'Missing required fields: to, subject, and html are required',
      code: 'MISSING_REQUIRED_FIELDS'
    };
  }

  try {
    const emailTransporter = createTransporter();

    // Format sender
    const fromAddress = options.from || emailConfig.from;
    const fromName = options.fromName || emailConfig.fromName;
    const formattedFrom = `"${fromName}" <${fromAddress}>`;

    const mailOptions = {
      from: formattedFrom,
      to: formatEmailList(options.to),
      subject: options.subject,
      html: options.html,
      text: options.text,
      cc: formatEmailList(options.cc),
      bcc: formatEmailList(options.bcc),
      replyTo: formatEmailList(options.replyTo),
      attachments: options.attachments
    };

    // Remove undefined fields
    Object.keys(mailOptions).forEach(key =>
      mailOptions[key] === undefined && delete mailOptions[key]
    );

    const result = await emailTransporter.sendMail(mailOptions);

    console.log(`✅ Email Sent Successfully:`);
    console.log(`   To: ${mailOptions.to}`);
    if (mailOptions.cc) console.log(`   CC: ${mailOptions.cc}`);
    if (mailOptions.bcc) console.log(`   BCC: [Hidden]`);
    console.log(`   Subject: "${mailOptions.subject}"`);
    console.log(`   Message ID: ${result.messageId}`);

    return {
      success: true,
      messageId: result.messageId,
      response: result.response,
      accepted: result.accepted,
      rejected: result.rejected
    };
  } catch (error) {
    console.error(`❌ Email Send Failed:`);
    console.error(`   To: ${options?.to || 'Unknown'}`);
    console.error(`   Subject: "${options?.subject || 'Unknown'}"`);
    console.error(`   Error: ${error.message}`);

    return {
      success: false,
      error: error.message,
      code: error.code
    };
  }
};

/**
 * Send bulk emails to multiple recipients
 * Each recipient gets a separate email (more personal)
 * @param {Array<Object>} recipients - Array of recipient objects
 * @param {string} recipients[].email - Recipient email
 * @param {Object} recipients[].data - Custom data for template
 * @param {string} subject - Email subject (can use {{variable}} for personalization)
 * @param {string} html - HTML template (can use {{variable}} for personalization)
 * @returns {Promise<Object>} - Results object
 * 
 * @example
 * sendBulkEmail([
 *   { email: 'user1@example.com', data: { name: 'John', amount: '100' } },
 *   { email: 'user2@example.com', data: { name: 'Jane', amount: '200' } }
 * ], 'Hello {{name}}', '<p>Your amount: {{amount}}</p>');
 */
const sendBulkEmail = async (recipients, subject, html) => {
  const results = {
    total: recipients.length,
    success: 0,
    failed: 0,
    errors: []
  };

  for (const recipient of recipients) {
    try {
      let personalizedSubject = subject;
      let personalizedHtml = html;

      // Replace variables if data is provided
      if (recipient.data) {
        Object.keys(recipient.data).forEach(key => {
          const regex = new RegExp(`{{${key}}}`, 'g');
          personalizedSubject = personalizedSubject.replace(regex, recipient.data[key]);
          personalizedHtml = personalizedHtml.replace(regex, recipient.data[key]);
        });
      }

      const result = await sendEmail({
        to: recipient.email,
        subject: personalizedSubject,
        html: personalizedHtml
      });

      if (result.success) {
        results.success++;
      } else {
        results.failed++;
        results.errors.push({
          email: recipient.email,
          error: result.error
        });
      }
    } catch (error) {
      results.failed++;
      results.errors.push({
        email: recipient.email,
        error: error.message
      });
    }
  }

  return results;
};

/**
 * Send simple email (backward compatibility)
 * @param {string} to - Recipient email
 * @param {string} subject - Email subject
 * @param {string} html - HTML content
 * @returns {Promise<boolean>} - Success status
 */
const sendSimpleEmail = async (to, subject, html) => {
  const result = await sendEmail({ to, subject, html });
  return result.success;
};

/**
 * Send OTP email with predefined template
 * @param {string} to - Recipient email
 * @param {string} otp - OTP code
 * @param {string} [userName] - User's name
 * @returns {Promise<Object>} - Result object
 */
const sendOTPEmail = async (to, otp, firstName = '', userEmail = '', resetLinkExpiry = '10 minutes') => {
  const subject = 'Password Reset Request - Simply Liturgical';
  const html = `
    <!DOCTYPE html>
    <html>
    <body>
      <p>Hi ${firstName},</p>

      <p>
        We received a request to reset the password for your Simply Liturgical account (${userEmail}).
      </p>

      <p>
        Use this OTP to reset your password: ${otp}<br/>
      </p>

      <p>
        This OTP will expire in ${resetLinkExpiry}. If you didn’t request a reset, you can safely ignore this email.
      </p>

      <p>God bless,<br/>— Simply Liturgical Team</p>
    </body>
    </html>
  `;

  return await sendEmail({ to, subject, html });
};

/**
 * Send welcome email template
 * @param {string} to - Recipient email
 * @param {string} userName - User's name
 * @returns {Promise<Object>} - Result object
 */
const sendWelcomeEmail = async (to, userName) => {
  const subject = 'Welcome to Simply Liturgical!';
  const html = `
    <!DOCTYPE html>
    <html>
    <body>
      <h2>Welcome to Our Platform!</h2>

      <p>Hello <strong>${userName}</strong>,</p>

      <p><strong>Welcome Aboard!</strong><br />
      Your account has been successfully created.</p>

      <p>We're excited to have you join our community. You can now access all features of your account.</p>

      <p>If you have any questions or need assistance, feel free to contact our support team.</p>

      <hr />

      <p>
        © ${new Date().getFullYear()} Simply Liturgical Team. All rights reserved.<br />
        This is an automated message, please do not reply to this email.
      </p>
    </body>
    </html>
  `;

  return await sendEmail({ to, subject, html });
};

/**
 * Send notification email to team with CC/BCC
 * @param {Object} options - Notification options
 * @param {string|Array} options.to - Primary recipients
 * @param {string|Array} [options.cc] - CC recipients
 * @param {string|Array} [options.bcc] - BCC recipients
 * @param {string} options.title - Notification title
 * @param {string} options.message - Notification message
 * @param {string} [options.priority] - Priority level (low, normal, high)
 * @returns {Promise<Object>} - Result object
 */
const sendNotificationEmail = async (options) => {
  const priorityColors = {
    low: '#6c757d',
    normal: '#007bff',
    high: '#dc3545'
  };

  const priority = options.priority || 'normal';
  const color = priorityColors[priority] || priorityColors.normal;

  const subject = `[${priority.toUpperCase()}] ${options.title}`;
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Notification</title>
  </head>
  <body>
    <h2>🔔 ${options.title}</h2>
    <p><strong>Priority:</strong> ${priority.toUpperCase()}</p>
    <p>${options.message}</p>
    <hr />
    <p>
      © ${new Date().getFullYear()} Simply Liturgical Team. All rights reserved.<br />
      Sent at ${new Date().toLocaleString()}
    </p>
  </body>
  </html>
`;

  return await sendEmail({
    to: options.to,
    cc: options.cc,
    bcc: options.bcc,
    subject,
    html
  });
};

/**
 * Send music submission emails
 * Sends email to submitter and review board members
 * @param {Object} options - Submission options
 * @param {string} options.submitterEmail - Music submitter's email
 * @param {string} options.firstName - Submitter's first name
 * @param {string} options.allAnswers - All submission answers/details
 * @param {Array} [options.attachments] - Music files attachments
 * @returns {Promise<Object>} - Result object with both email statuses
 */
const sendMusicSubmissionEmail = async (options) => {

  const { submitterEmail, firstName, submissionTitle = "Untitled Submission", submissionId = "", status = "Submitted", portalLink = "https://yourdomain.com/portal", allAnswers = "Submission details", attachments } = options;

  let reviewBoardEmails = process.env.REVIEW_BOARD_EMAILS
    ? process.env.REVIEW_BOARD_EMAILS.split(",").map((e) => e.trim())
    : [];

  const commonCC = process.env.REVIEW_BOARD_CC_EMAIL
    ? process.env.REVIEW_BOARD_CC_EMAIL.split(",").map((e) => e.trim())
    : [];

  try {

    const { getMySQLConnection } = require("../config/mysql");
    const mysqlConnection = getMySQLConnection();

    const [reviewBoardMembers] = await mysqlConnection.execute(`
      SELECT email 
      FROM users 
      WHERE JSON_CONTAINS(badges, '"Review Board"')
      AND is_active = 1
      AND deleted_at IS NULL
    `);

    const dbEmails = reviewBoardMembers.map((m) => m.email).filter(Boolean);

    if (dbEmails.length > 0) {
      reviewBoardEmails = dbEmails;
    }

  } catch (error) {
    console.warn("⚠️ Could not fetch review board members from DB, using ENV emails");
  }

  /**
   * REVIEW BOARD EMAIL
   */
  const reviewBoardHtml = `
    <div style="font-family: Arial, sans-serif; color: #222; line-height: 1.7; font-size: 15px;">
      
      <p>Dear SL Music Review Board,</p>

      <p>
        A new music composition has been submitted for review.
      </p>

      <div style="margin-top:20px; margin-bottom:20px;">
        <strong>Submission Details:</strong>

        <ul style="padding-left:20px; margin-top:10px;">
          <li><strong>Title:</strong> ${submissionTitle}</li>
          <li><strong>Submission ID:</strong> ${submissionId}</li>
          <li><strong>Status:</strong> ${status}</li>
        </ul>
      </div>

      <div style="margin:20px 0;">
        <a 
          href="${portalLink}" 
          style="
            background:#000;
            color:#fff;
            padding:12px 20px;
            text-decoration:none;
            border-radius:6px;
            display:inline-block;
            font-weight:bold;
          "
        >
          View Submission
        </a>
      </div>

      <p>
        Please review the composition and proceed with the evaluation process.
      </p>

      <br/>

      <p>
        God bless,<br/>
        <strong>Simply Liturgical Composer Team</strong>
      </p>

    </div>
  `;

  /**
   * SUBMITTER EMAIL
   */
  const submitterHtml = `
    <div style="font-family: Arial, sans-serif; color: #222; line-height: 1.8; font-size: 15px;">

      <p>Hi ${firstName},</p>

      <p>
        Thank you for submitting 
        <strong>"${submissionTitle}"</strong> 
        to Simply Liturgical.
        Your files and details have been received successfully.
      </p>

      <div style="margin-top:25px; margin-bottom:25px;">

        <strong>Submission details:</strong>

        <ul style="padding-left:20px; margin-top:12px;">
          <li>
            <strong>Title:</strong> ${submissionTitle}
          </li>

          <li>
            <strong>Submission ID:</strong> ${submissionId}
          </li>

          <li>
            <strong>Current status:</strong> ${status}
          </li>

          <li>
            View Composition Status in SL Portals - Composer- My Composition - Music
          </li>
        </ul>

      </div>

      <p>
        Our team will review your submission and notify you as it moves
        through the process.
      </p>

      <p>
        If you need to update your submission or contact our team,
        please use the composer portal.
      </p>

      <br/>

      <p>
        God bless,<br/>
        — Simply Liturgical Composer Team
      </p>

    </div>
  `;

  const results = {
    reviewBoard: null,
    submitter: null,
    success: false,
  };

  try {

    /**
     * Send Review Board Email
     */
    results.reviewBoard = await sendEmail({
      to: reviewBoardEmails,
      cc: commonCC,
      subject: `New Music Submission - ${submissionTitle}`,
      html: reviewBoardHtml,
      attachments,
    });

    /**
     * Send Submitter Email
     */
    results.submitter = await sendEmail({
      to: submitterEmail,
      cc: commonCC,
      subject: `Submission Received - ${submissionTitle}`,
      html: submitterHtml,
    });

    results.success =
      results.reviewBoard?.success &&
      results.submitter?.success;

    return results;

  } catch (error) {

    console.error(
      "❌ Music submission email failed:",
      error.message
    );

    return {
      success: false,
      error: error.message,
    };
  }
};


/**
 * Send Stage 1 Music Review Status Email
 * Sends an email to the Director of SLC with the reviewer’s recommendation
 * based on the review action (Accept, Accept with Changes, Not Approved).
 *
 * @param {Object} options - Review status details
 * @param {string} options.compositionName - Name of the composition being reviewed
 * @param {string} options.allAnswers - Official review summary text
 * @param {("accept"|"accept_with_changes"|"not_approved")} options.action - Review decision/action type
 *
 * @returns {Promise<Object>} - Result object containing:
 *    - {boolean} success - Whether the email was sent successfully
 *    - {string} [messageId] - Message ID from email service (if available)
 *    - {string} [error] - Error message if sending failed
 *
 * Email Routing:
 *    TO: kevin.digitalgrowthus@gmail.com
 *    CC: berlin.digitalgrowthus@gmail.com, ammypoland@gmail.com
 *
 * Behavior:
 *    - Selects subject + body template based on review action.
 *    - Sends clean HTML email without inline CSS.
 *    - Includes composition name and reviewer summary.
 */
/**
 * Get email template for Stage 1 review status
 * @param {string} compositionName - Name of the composition
 * @param {string} allAnswers - Review summary text
 * @param {string} action - "accept" | "accept_with_changes" | "not_approved"
 * @returns {Object} Template object with subject and body
 */
const getStage1ReviewTemplate = (compositionName, allAnswers, action) => {
  const templates = {
    accept: {
      subject: `${compositionName} - Accept! (minimal "tweaks" may be needed)`,
      body: `
        <html>
          <body>
            <p>Dear Director of SLC,</p>

            <p>
              My recommendation for "<strong>${compositionName}</strong>" 
              is to accept the work as is (with possible tweaks needed).
              If you have any questions about this recommendation, you can reach me 
              by replying to this email notification.
            </p>

            <p>Below is my Official Review Summary:</p>
            <pre>${allAnswers}</pre>

            <p>God bless,<br/>
            --<br/>
            SLC Review Board<br/>
            Simply Liturgical Composer</p>
          </body>
        </html>
      `
    },

    accept_with_changes: {
      subject: `${compositionName} - Accept with Changes`,
      body: `
        <html>
          <body>
            <p>Dear Director of SLC,</p>

            <p>
              My recommendation for "<strong>${compositionName}</strong>" 
              is to accept the work with changes.
              If you have any questions about this recommendation, you can reach me 
              by replying to this email notification.
            </p>

            <p>Below is my Official Review Summary:</p>
            <pre>${allAnswers}</pre>

            <p>God bless,<br/>
            --<br/>
            SLC Review Board<br/>
            Simply Liturgical Composer</p>
          </body>
        </html>
      `
    },

    not_approved: {
      subject: `${compositionName} - Not Approved`,
      body: `
        <html>
          <body>
            <p>Dear Director of SLC,</p>

            <p>
              My recommendation for "<strong>${compositionName}</strong>" 
              is to not approve the work.
              If you have any questions about this recommendation, you can reach me 
              by replying to this email notification.
            </p>

            <p>Below is my Official Review Summary:</p>
            <pre>${allAnswers}</pre>

            <p>God bless,<br/>
            --<br/>
            SLC Review Board<br/>
            Simply Liturgical Composer</p>
          </body>
        </html>
      `
    }
  };

  // Validate action
  if (!templates[action]) {
    return null;
  }

  return templates[action];
};

const sendMusicReviewStatusStage1 = async (options) => {
  const {
    compositionName,   // {{What is the name of the composition being reviewed?}}
    allAnswers,        // {{All Answers}}
    action             // "accept" | "accept_with_changes" | "not_approved"
  } = options;

  // ================================
  // Email Routing
  // ================================
  const TO_EMAIL = process.env.MUSIC_STEP_2_TO_EMAILS
    ? process.env.MUSIC_STEP_2_TO_EMAILS.split(",").map(e => e.trim())
    : [];

  const CC_EMAILS = process.env.MUSIC_STEP_2_CC_EMAILS
    ? process.env.MUSIC_STEP_2_CC_EMAILS.split(",").map(e => e.trim())
    : [];

  // ================================
  // Get Template
  // ================================
  const selectedTemplate = getStage1ReviewTemplate(compositionName, allAnswers, action);

  if (!selectedTemplate) {
    return {
      success: false,
      error: `Invalid action: ${action}. Must be "accept", "accept_with_changes", or "not_approved".`
    };
  }

  // ================================
  // Send Email
  // ================================
  try {
    const result = await sendEmail({
      to: TO_EMAIL,
      cc: CC_EMAILS,
      subject: selectedTemplate.subject,
      html: selectedTemplate.body
    });

    return {
      success: result.success,
      messageId: result.messageId
    };

  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
};


/**
 * Send Director of SLC Music Review Email
 * Sends an email to the composer notifying them of the Music Review Board's decision.
 * Supports three actions: "approved", "approved_with_changes", and "declined".
 *
 * @param {Object} options - Review details
 * @param {string} options.compositionName - Name of the composition being reviewed
 * @param {string} options.composerFirstName - Composer's first name
 * @param {string} options.allAnswers - Official review summary text
 * @param {("approved"|"approved_with_changes"|"declined")} options.action - Review decision/action type
 *
 * @returns {Promise<Object>} - Result object containing:
 *    - {boolean} success - Whether the email was sent successfully
 *    - {string} [messageId] - Message ID from email service (if available)
 *    - {string} [error] - Error message if sending failed
 *
 * Email Routing:
 *    TO: kevin.digitalgrowthus@gmail.com
 *    BCC: berlin.digitalgrowthus@gmail.com, ammypoland@gmail.com
 *
 * Behavior:
 *    - Selects subject + body template based on review action.
 *    - Sends clean HTML email without inline CSS.
 *    - Includes composition name, composer first name, and official review summary.
 */
/**
 * Get editorial email body template (shared by approved and approved_with_changes)
 * @param {string} compositionName - Name of the composition
 * @param {string} allAnswers - Review summary text
 * @returns {string} HTML email body
 */
const getDirectorOfSLCEditorialEmailBody = (compositionName, allAnswers) => {
  return `
    <html>
      <body>
        <p>Dear Editorial,</p>

        <p>
          The composition, "<strong>${compositionName}</strong>,"
          has been accepted (with possible minimal tweaks needed)
          and is ready for your team to review.
        </p>

        <p>
          If you have any questions about this submission, you can reach me by
          "replying" to this email notification.
        </p>

        <p>Below is my Official Review Summary:</p>

        <pre>${allAnswers}</pre>

        <p>
          God bless,<br/>
          --<br/>
          Director of SLC<br/>
          Simply Liturgical Composer
        </p>
      </body>
    </html>
  `;
};

const directorOfSLCReviewEmail = async (options) => {
  const {
    compositionName, // {{What is the name of the composition being reviewed?}}
    composerFirstName, // {{What is the composer's FIRST NAME?}}
    allAnswers, // {{All Answers}}
    action // "approved" | "approved_with_changes" | "declined"
  } = options;

  // ===============================
  // Email Routing
  // ===============================
  const TO_EMAIL = "kevin.digitalgrowthus@gmail.com";
  const TO_EDITORIAL_EMAIL = "kevin.digitalgrowthus@gmail.com";
  const BCC_EMAILS = [
    "berlin.digitalgrowthus@gmail.com",
    "ammypoland@gmail.com"
  ];

  // ===============================
  // Template Builder
  // ===============================
  const templates = {
    approved: {
      subject: `Music Review - ${compositionName}`,
      body: `
        <html>
          <body>
            <p>Hi ${composerFirstName},</p>

            <p>
              Congratulations! We are delighted to inform you that your composition, 
              "<strong>${compositionName}</strong>," has been approved by the Music Review Board
              and will now move on to Editorial for textual review, step two of the three step-process:
            </p>

            <p>✅ Music Review<br/>
            🟩 Editorial Review<br/>
            🟩 Publication</p>

            <p>We will contact you after your text has been reviewed. Below is your Official Review Summary:</p>
            <pre>${allAnswers}</pre>

            <p>God bless,<br/>
            --<br/>
            Director of SLC<br/>
            Simply Liturgical Composer</p>
          </body>
        </html>
      `,
      editorialEmailBody: getDirectorOfSLCEditorialEmailBody(compositionName, allAnswers)
    },

    approved_with_changes: {
      subject: `Music Review - ${compositionName}`,
      body: `
        <html>
          <body>
            <p>Hi ${composerFirstName},</p>

            <p>
              We are delighted to inform you that your composition, "<strong>${compositionName}</strong>," 
              has been approved by the Music Review Board. However, before your music can move on to 
              Editorial for textual review, you will need to make corrections based on feedback given 
              in the Official Review Summary below.
            </p>

            <p>
              Once the corrections are made, please reply to this email with your corrected file(s) 
              for final approval. Once approved, you'll receive a notification letting you know what 
              will happen next. If you have any questions, please reply to this email notification.
            </p>

            <p>Here is your Official Review Summary:</p>
            <pre>${allAnswers}</pre>

            <p>God bless,<br/>
            --<br/>
            Director of SLC<br/>
            Simply Liturgical Composer</p>
          </body>
        </html>
      `,
      editorialEmailBody: getDirectorOfSLCEditorialEmailBody(compositionName, allAnswers)
    },

    declined: {
      subject: `Music Review - ${compositionName}`,
      body: `
        <html>
          <body>
            <p>Hi ${composerFirstName},</p>

            <p>
              We regret to inform you that your composition, "<strong>${compositionName}</strong>," 
              has not been approved by the Music Review Board. Since we ask that all submitted compositions 
              be "print ready" (that is, fine-tuned enough to be published), this piece cannot be resubmitted 
              even with substantial updates. Should you have any questions, please don't hesitate to reach us 
              by replying to this email notification.
            </p>

            <p>Below is your Official Review Summary:</p>
            <pre>${allAnswers}</pre>

            <p>God bless,<br/>
            --<br/>
            SLC Review Board<br/>
            Simply Liturgical Composer</p>
          </body>
        </html>
      `
    }
  };

  // Validate action
  if (!templates[action]) {
    return {
      success: false,
      error: `Invalid action: ${action}. Must be "approved", "approved_with_changes", or "declined".`
    };
  }

  const selectedTemplate = templates[action];

  // ===============================
  // Send Email
  // ===============================
  try {
    const result = await sendEmail({
      to: TO_EMAIL,
      bcc: BCC_EMAILS,
      subject: selectedTemplate.subject,
      html: selectedTemplate.body
    });

    if (action === "approved_with_changes" && selectedTemplate.editorialEmailBody) {
      await sendEmail({
        to: TO_EDITORIAL_EMAIL,
        cc: BCC_EMAILS,
        subject: selectedTemplate.subject,
        html: selectedTemplate.editorialEmailBody
      });
    }

    return {
      success: result.success,
      messageId: result.messageId
    };

  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
};

/**
 * Get editorial email template for Director of SLC review
 * @param {string} compositionName - Name of the composition
 * @param {string} allAnswers - Review summary text
 * @param {string} action - "approved" | "approved_with_changes"
 * @returns {Object|null} Template object with subject and body, or null if invalid
 */
const getDirectorOfSLCEditorialTemplate = (compositionName, allAnswers, action) => {
  if (action !== 'approved' && action !== 'approved_with_changes') {
    return null;
  }

  return {
    subject: `Music Review - ${compositionName}`,
    body: getDirectorOfSLCEditorialEmailBody(compositionName, allAnswers)
  };
};

/**
 * Send Editorial Review Email (Textual Review Stage)
 * Sends an email to the composer notifying them of the Editorial Team's review decision.
 * Supports three actions: "approved", "changes_needed", and "ready_for_publication".
 *
 * @param {Object} options - Review details
 * @param {string} options.compositionName - Name of the composition being reviewed
 * @param {string} options.composerFirstName - Composer's first name
 * @param {string} options.allAnswers - Official review summary text
 * @param {("approved"|"changes_needed"|"ready_for_publication")} options.action - Review decision/action type
 *
 * @returns {Promise<Object>} - Result object containing:
 *    - {boolean} success
 *    - {string} [messageId]
 *    - {string} [error]
 *
 * Email Routing:
 *    TO: kevin.digitalgrowthus@gmail.com
 *    BCC: berlin.digitalgrowthus@gmail.com, ammypoland@gmail.com
 */
const textualReviewEmail = async (options) => {
  const {
    compositionName,
    composerFirstName,
    allAnswers,
    action
  } = options;

  // ===============================
  // Email Routing
  // ===============================
  const TO_EMAIL = "kevin.digitalgrowthus@gmail.com";
  const BCC_EMAILS = [
    "berlin.digitalgrowthus@gmail.com",
    "ammypoland@gmail.com"
  ];

  // ===============================
  // Templates
  // ===============================
  const templates = {
    approved: {
      subject: `Editorial Review - ${compositionName}`,
      body: `
        <html>
          <body>
            <p>Hi ${composerFirstName},</p>

            <p>
              Congratulations! We are delighted to inform you that your composition, 
              "<strong>${compositionName}</strong>," has been approved by our Editorial Team 
              and will now move on to Publication, step three of the three step-process:
            </p>

            <p>✅ Music Review<br/>
            ✅ Editorial Review<br/>
            🟩 Publication</p>

            <p>We will contact you once your composition product has been made. Below is your Official Review Summary.</p>
            <pre>${allAnswers}</pre>

            <p>God bless,<br/>
            --<br/>
            Editorial Team<br/>
            Simply Liturgical Composer</p>
          </body>
        </html>
      `
    },

    changes_needed: {
      subject: `Editorial Review - ${compositionName}`,
      body: `
        <html>
          <body>
            <p>Hi ${composerFirstName},</p>

            <p>
              After reviewing your composition, "<strong>${compositionName}</strong>," we found that 
              it is in need of some corrections before we can move it on to Step 3 - Publication.
            </p>

            <p>This Official Review Summary outlines the corrections needed:</p>
            <pre>${allAnswers}</pre>

            <p>
              Once the corrections are made, please reply to this email with your corrected file(s) 
              for final approval. Once approved, you'll receive a notification letting you know what 
              will happen next. If you have any questions, please reply to this email notification.
            </p>

            <p>God bless,<br/>
            --<br/>
            Editorial Team<br/>
            Simply Liturgical Composer</p>
          </body>
        </html>
      `
    },

    ready_for_publication: {
      subject: `Editorial Review Complete - ${compositionName}`,
      body: `
        <html>
          <body>
            <p>Dear Publication,</p>

            <p>
              The composition, "<strong>${compositionName}</strong>," has been reviewed by our 
              Editorial Team and is ready for publication. If you have any questions about this 
              submission, you can reach me by "replying" to this email notification.
            </p>

            <p>Below is the Official Review Summary:</p>
            <pre>${allAnswers}</pre>

            <p>God bless,<br/>
            --<br/>
            Editorial Team<br/>
            Simply Liturgical Composer</p>
          </body>
        </html>
      `
    }
  };

  // ===============================
  // Validate action
  // ===============================
  if (!templates[action]) {
    return {
      success: false,
      error: `Invalid action: ${action}. Must be "approved", "changes_needed", or "ready_for_publication".`
    };
  }

  const selectedTemplate = templates[action];

  // ===============================
  // Send Email
  // ===============================
  try {
    const result = await sendEmail({
      to: TO_EMAIL,
      bcc: BCC_EMAILS,
      subject: selectedTemplate.subject,
      html: selectedTemplate.body
    });

    return {
      success: result.success,
      messageId: result.messageId
    };
  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
};

/** 
 * Send Publication Notification Email
 * Sends an email to the composer notifying them that their composition has been published.
 *
 * @param {Object} options - Publication details
 * @param {string} options.compositionName - Name of the composition being published
 * @param {string} options.composerFirstName - Composer's first name
 * @param {string} options.productPageLink - URL of the product page (hyperlink)
 *
 * @returns {Promise<Object>} - Result object containing:
 *    - {boolean} success
 *    - {string} [messageId]
 *    - {string} [error]
 *
 * Email Routing:
 *    TO: kevin.digitalgrowthus@gmail.com
 *    BCC: berlin.digitalgrowthus@gmail.com, ammypoland@gmail.com
 *
 * Behavior:
 *    - Sends clean HTML email without inline CSS.
 *    - Includes composition name, composer first name, and product link.
 */
const publicationEmail = async (options) => {
  const {
    compositionName,
    composerFirstName,
    productPageLink
  } = options;

  // ===============================
  // Email Routing
  // ===============================
  const TO_EMAIL = "kevin.digitalgrowthus@gmail.com";
  const BCC_EMAILS = [
    "berlin.digitalgrowthus@gmail.com",
    "ammypoland@gmail.com"
  ];

  // ===============================
  // Template
  // ===============================
  const subject = `Product Published! - ${compositionName}`;
  const body = `
    <html>
      <body>
        <p>Hi ${composerFirstName},</p>

        <p>
          Congratulations! We are delighted to inform you that your composition,
          "<strong>${compositionName}</strong>," has been published and is now live on our website:
        </p>

        <p><a href="${productPageLink}" target="_blank">${productPageLink}</a></p>

        <p>
          If anything on your product page needs to be adjusted, just respond to this email.
        </p>

        <p>God bless,<br/>
        --<br/>
        Publication Team<br/>
        Simply Liturgical Composer</p>
      </body>
    </html>
  `;

  // ===============================
  // Send Email
  // ===============================
  try {
    const result = await sendEmail({
      to: TO_EMAIL,
      bcc: BCC_EMAILS,
      subject,
      html: body
    });

    return {
      success: result.success,
      messageId: result.messageId
    };
  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
};


/**
 * Test email configuration
 * @returns {Promise<boolean>} - Test result
 */
const testEmailConfig = async () => {
  try {
    const emailTransporter = createTransporter();
    await emailTransporter.verify();
    console.log('✅ Email configuration is valid');
    return true;
  } catch (error) {
    console.error('❌ Email configuration test failed:', error.message);
    return false;
  }
};


function userRegisteredTemplate({
  firstName = '',
  lastName = '',
  email = '',
  password = '',
  role = null,
  badges = null,
  is_composer = null
}) {
  const fullName =
    `${firstName} ${lastName}`.trim() || 'User';

  const dashboardUrl =
    `${process.env.FRONTEND_URL || 'https://yourapp.com'}`;

  const showExtraDetails =
    (Array.isArray(badges) && badges.length > 0) ||
    is_composer === true ||
    (role && role !== 'free_user');

  const badgeList =
    Array.isArray(badges) && badges.length
      ? badges.join(', ')
      : null;

  const roleLabel =
    role ? role.replace(/_/g, ' ').toUpperCase() : null;

  const subject = 'Welcome to Simply Liturgical Team 🎉';

  /* ======================
     HTML VERSION
  ====================== */

  const html = `
<div style="font-family: Arial, Helvetica, sans-serif; font-size:14px; line-height:1.6; color:#222;">

  <p>Hi ${fullName},</p>

  <p>
    Welcome to <strong>Simply Liturgical Team</strong>!  
    Your account has been successfully created.
  </p>

  ${showExtraDetails
      ? `
  <p><strong>Account Details:</strong></p>

  <p>
    ${roleLabel ? `<strong>Role:</strong> ${roleLabel}<br/>` : ''}
    ${is_composer === true ? `<strong>Composer Account:</strong> Yes<br/>` : ''}
    ${badgeList ? `<strong>Badges:</strong> ${badgeList}<br/>` : ''}
  </p>
  `
      : ''
    }

  <p><strong>Login Credentials:</strong></p>

  <p>
    <strong>Email:</strong> ${email}<br/>
    <strong>Password:</strong> ${password}
  </p>

  <p>
    You can log in to your dashboard here:<br/>
    <a href="${dashboardUrl}">${dashboardUrl}</a>
  </p>

  <p style="color:#b00020;">
    <strong>Important:</strong> Please change your password after your first login.
  </p>

  <p>
    If you have any questions, just reply to this email.
  </p>

  <p>
    Thanks,<br/>
    Simply Liturgical Team
  </p>

</div>
`;

  /* ======================
     TEXT VERSION
  ====================== */

  const text = `
Hi ${fullName},

Welcome to Simply Liturgical Team!
Your account has been successfully created.

${showExtraDetails
      ? `
Account Details:
----------------
${roleLabel ? `Role: ${roleLabel}\n` : ''}${is_composer === true ? `Composer Account: Yes\n` : ''}${badgeList ? `Badges: ${badgeList}\n` : ''}
`
      : ''
    }

Login Credentials:
------------------
Email: ${email}
Password: ${password}

Dashboard:
${dashboardUrl}

IMPORTANT:
Please change your password after your first login.

If you have any questions, just reply to this email.

Thanks,
Simply Liturgical Team
`.trim();

  return {
    subject,
    html,
    text
  };
}

/**
 * Send registration email based on user type
 */
async function sendRegistrationEmail({
  firstName,
  email,
  password,
  createdBy,
  verifyEmailLink,
  loginLink,
  setPasswordLink,
  // supportEmail
}) {
  const fullName = `${firstName}`.trim() || 'User';
  const isAdminCreated = createdBy === 'admin';
  const supportEmail = "info@slmusic.org";

  if (isAdminCreated) {
    console.log('📧 Sending ADMIN-created registration email');

    const subject = 'Your Simply Liturgical login credentials';
    const html = `
      <div style="font-family: Arial, sans-serif; font-size:14px; line-height:1.6;">
        <p>Hi ${fullName},</p>

        <p>An administrator has created your Simply Liturgical account.</p>

        <p>Here are your login details:</p>
        <ul>
          <li><strong>Email:</strong> ${email}</li>
          <li><strong>Temporary password:</strong> ${password}</li>
          <li><strong>Login:</strong> <a href="${process.env.FRONTEND_URL}/login">${process.env.FRONTEND_URL}/login</a></li>
        </ul>

        <p>For security, please set your password right away: <a href="${process.env.FRONTEND_URL}/login">${process.env.FRONTEND_URL}/login</a></p>

        <p>If you weren’t expecting this account, or you need help logging in, reply to this email or contact us at ${supportEmail}.</p>

        <p>God bless,<br/>— Simply Liturgical Team</p>
      </div>
    `;

    const text = `
Hi ${fullName},

An administrator has created your Simply Liturgical account.

Here are your login details:
- Email: ${email}
- Temporary password: ${password}
- Login: ${loginLink}

For security, please set your password right away: ${setPasswordLink}

If you weren’t expecting this account, or you need help logging in, reply to this email or contact us at ${supportEmail}.

God bless,
— Simply Liturgical Team
    `.trim();

    return sendEmail({
      to: email,
      subject,
      html,
      text
    });
  } else {
    console.log('📧 Sending SELF-registered user email');

    const subject = 'Welcome to Simply Liturgical — please confirm your email';
    const html = `
      <div style="font-family: Arial, sans-serif; font-size:14px; line-height:1.6;">
        <p>Hi ${fullName},</p>

      <p>Thanks for registering for Simply Liturgical! We’re glad you’re here.</p>
      <p>You can log in anytime using this link:<a href="${process.env.FRONTEND_URL}/login">
          ${process.env.FRONTEND_URL}/login
        </a>
      </p>
    
      <p>
        If you didn’t create this account, please ignore this email.
      </p>    
      <p>
        If you need any assistance, please feel free to reach out to us at 
        <a href="mailto:info@slmusic.org">info@slmusic.org</a>.
      </p>    
      <p>
        God bless,<br/>
        — Simply Liturgical Team
      </p>
      </div>
    `;


    return sendEmail({
      to: email,
      subject,
      html,
    });
  }
}

/**
 * Send diocese registration email
 * @param {Object} data
 * @returns {Promise<Object>}
 */
const sendDioceseRegistrationEmail = async ({
  firstName,
  lastName,
  email,
  password,
  isNewUser
}) => {

  const fullName =
    `${firstName || ""} ${lastName || ""}`.trim() || "Diocese Admin";

  const dashboardUrl =
    process.env.FRONTEND_URL;

  const subject =
    "Your Diocese Account Has Been Created – Simply Liturgical";

  const credentialsBlock = isNewUser
    ? `
      <h3>Login Credentials</h3>
      <p>
        <strong>Email:</strong> ${email}<br/>
        <strong>Password:</strong> ${password}
      </p>

      <p style="color:#b00020;">
        Please change your password after your first login.
      </p>
    `
    : `
      <p>
        You may log in using your existing account credentials.
      </p>
    `;

  const html = `
  <!DOCTYPE html>
  <html>
  <body style="font-family: Arial, sans-serif; font-size:14px; line-height:1.6; color:#333;">

    <h2>Diocese Administrator Account Created</h2>

    <p>Hello <strong>${fullName}</strong>,</p>

    <p>
      A <strong>Diocesan Administrator account</strong> has been successfully created for you on
      <strong>Simply Liturgical</strong>.
    </p>

    <p>
      Your account is currently <strong>Pending Activation</strong>.
      You will be able to activate your account after completing your subscription payment.
    </p>

    ${credentialsBlock}

    <p>
      You can access your dashboard here:
    </p>

    <p>
      <a href="${dashboardUrl}" target="_blank">
        ${dashboardUrl}
      </a>
    </p>

    <p>
      If you have any questions or require assistance,
      please contact our support team.
    </p>

    <hr />

    <p style="font-size:12px;color:#666;">
      © ${new Date().getFullYear()} Simply Liturgical Team. All rights reserved.<br/>
      This is an automated message, please do not reply to this email.
    </p>

  </body>
  </html>
  `;

  const text = `
Hello ${fullName},

A Diocesan Administrator account has been created for you on Simply Liturgical.

Your account status: Pending Activation.
You will be able to activate your account after completing your subscription payment.

${isNewUser
      ? `Login Credentials:
Email: ${email}
Password: ${password}

Please change your password after first login.`
      : `You may login using your existing credentials.`
    }

Dashboard:
${dashboardUrl}

If you have any questions, please contact support.

© ${new Date().getFullYear()} Simply Liturgical Team
`;

  return sendEmail({
    to: email,
    subject,
    html,
    text
  });
};

/**
 * Send parish registration email
 * @param {Object} data
 * @returns {Promise<Object>}
 */
const sendParishRegistrationEmail = async ({
  firstName,
  lastName,
  email,
  password,
  isNewUser,
  parishName
}) => {

  const fullName =
    `${firstName || ""} ${lastName || ""}`.trim() || "Parish Admin";

  const dashboardUrl =
    process.env.FRONTEND_URL;

  const subject = "Your Parish Account Has Been Created – Simply Liturgical";

  const credentialsBlock = isNewUser
    ? `
      <h3>Login Credentials</h3>
      <p>
        <strong>Email:</strong> ${email}<br/>
        <strong>Password:</strong> ${password}
      </p>

      <p style="color:#b00020;">
        Please change your password after your first login.
      </p>
    `
    : `
      <p>
        You may log in using your existing account credentials.
      </p>
    `;

  const html = `
  <!DOCTYPE html>
  <html>
  <body style="font-family: Arial, sans-serif; font-size:14px; line-height:1.6; color:#333;">

    <h2>Parish Account Created</h2>

    <p>Hello <strong>${fullName}</strong>,</p>

    <p>
      A <strong>Parish account</strong> has been successfully created for you on
      <strong>Simply Liturgical</strong>.
    </p>

    <p>
      <strong>Parish Name:</strong> ${parishName}
    </p>

    // <p>
    //   Your account is currently activated on a
    //   <strong>Free 14-day Trial Plan</strong>.
    // </p>

    ${credentialsBlock}

    <p>
      You can access your dashboard here:
    </p>

    <p>
      <a href="${dashboardUrl}" target="_blank">
        ${dashboardUrl}
      </a>
    </p>

    <hr />

    <p style="font-size:12px;color:#666;">
      © ${new Date().getFullYear()} Simply Liturgical Team. All rights reserved.<br/>
      This is an automated message, please do not reply to this email.
    </p>

  </body>
  </html>
  `;

  const text = `
Hello ${fullName},

A Parish account has been created for you on Simply Liturgical.

Parish Name: ${parishName}

// Your account is currently on a Free 14-day trial.

${isNewUser
      ? `Login Credentials:
Email: ${email}
Password: ${password}

Please change your password after first login.`
      : `You may login using your existing credentials.`
    }

Dashboard:
${dashboardUrl}

© ${new Date().getFullYear()} Simply Liturgical Team
`;

  return sendEmail({
    to: email,
    subject,
    html,
    text
  });
};

module.exports = {
  sendEmail,
  sendSimpleEmail,
  sendOTPEmail,
  sendWelcomeEmail,
  sendNotificationEmail,
  sendBulkEmail,
  sendMusicSubmissionEmail,
  sendMusicReviewStatusStage1,
  getStage1ReviewTemplate,
  directorOfSLCReviewEmail,
  getDirectorOfSLCEditorialTemplate,
  textualReviewEmail,
  publicationEmail,
  testEmailConfig,
  emailConfig,
  userRegisteredTemplate,
  sendRegistrationEmail,
  sendDioceseRegistrationEmail,
  sendParishRegistrationEmail
};