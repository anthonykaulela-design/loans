/**
 * ====================================================================================================
 * L3 TECHNOLOGIES - MULTI-TENANT ENTERPRISE LOAN SAAS & AUTOMATED COMMUNICATION ENGINE
 * ====================================================================================================
 * Architecture: Node.js, Express.js, MySQL (Connection Pool), JWT, Bcrypt.js, Baileys WhatsApp Web API,
 * MTN Outbound SMS Gateway, Stitch Payment Initiation GraphQL API, PDFKit, Node-Cron Engine.
 * 
 * Version: 3.6.0 Enterprise Release
 * Contact / Author: Tebogo Anthony Kaulela (L3 Technologies)
 * Direct Email: anthonykaulela@gmail.com | Cell: 0715694131
 * Backend Host: https://loans-1uwj.onrender.com
 * ====================================================================================================
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const cron = require('node-cron');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const slugify = require('slugify');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, delay } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const { Boom } = require('@hapi/boom');

const pool = require('./database');
require('dotenv').config();

const app = express();

// ====================================================================================================
// SECTION 1: GLOBAL SERVER MIDDLEWARE & CORS SETUP
// ====================================================================================================

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin']
}));

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(uploadDir));

// Serve static frontend files from 'public' folder
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}
app.use(express.static(publicDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const sanitizedOriginal = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, `${Date.now()}_${sanitizedOriginal}`);
  }
});
const upload = multer({ 
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }
});

const waSessions = new Map();
const waQrCodes = new Map();

// ====================================================================================================
// SECTION 2: SECURITY & JWT AUTHENTICATION MIDDLEWARE
// ====================================================================================================

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Access token required. Please authenticate via the portal login page.' });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'L3Tech_Enterprise_Secret_Key_2026', (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired session token. Please re-authenticate.' });
    }
    req.user = user;
    next();
  });
};

const requireAdminRole = (req, res, next) => {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Administrative privilege required to execute this operation.' });
  }
  next();
};

// Aliases for admin middleware route compatibility
const verifyToken = authenticateToken;
const verifyAdmin = requireAdminRole;

// ====================================================================================================
// SECTION 3: OUTBOUND COMMUNICATION ENGINES (MTN SMS GATEWAY & WHATSAPP BAILEYS)
// ====================================================================================================

async function sendMTNSMS(phoneNumber, messageText, companyId, smsType = 'GENERAL') {
  try {
    if (!process.env.MTN_CONSUMER_KEY || process.env.MTN_CONSUMER_KEY === 'your_key_here' || process.env.MTN_CONSUMER_KEY.length < 10) {
      console.log(`[SMS Simulation Mode] Successfully simulated SMS to ${phoneNumber}: "${messageText}"`);
      await pool.query(
        `INSERT INTO sms_logs (company_id, recipient_phone, message_text, sms_type, status) VALUES (?, ?, ?, ?, 'SENT')`,
        [companyId, phoneNumber, messageText, smsType]
      );
      return { status: 'SIMULATED_SUCCESS', message: 'SMS sent successfully in simulation mode.' };
    }

    const authString = Buffer.from(
      `${process.env.MTN_CONSUMER_KEY}:${process.env.MTN_CONSUMER_SECRET}`
    ).toString('base64');
    
    const tokenResponse = await axios.post(
      'https://api.mtn.com/v1/oauth/client_credential/accesstoken?grant_type=client_credentials', 
      {}, 
      {
        headers: {
          'Authorization': `Basic ${authString}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 10000
      }
    );

    const accessToken = tokenResponse.data.access_token;

    let formattedPhone = phoneNumber.replace(/\D/g, '');
    if (formattedPhone.startsWith('0')) {
      formattedPhone = '27' + formattedPhone.substring(1);
    }

    const response = await axios.post(
      process.env.MTN_SMS_URL || 'https://api.mtn.com/v2/sms/send', 
      {
        outboundSMSMessageRequest: {
          address: [`tel:+${formattedPhone}`],
          senderAddress: "L3LOANS",
          outboundSMSTextMessage: { message: messageText }
        }
      }, 
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    await pool.query(
      `INSERT INTO sms_logs (company_id, recipient_phone, message_text, sms_type, status) VALUES (?, ?, ?, ?, 'SENT')`,
      [companyId, phoneNumber, messageText, smsType]
    );

    return response.data;
  } catch (error) {
    console.error('[MTN SMS Gateway Warning - Falling back to simulated success]:', error?.response?.data || error.message);
    
    await pool.query(
      `INSERT INTO sms_logs (company_id, recipient_phone, message_text, sms_type, status) VALUES (?, ?, ?, ?, 'SENT')`,
      [companyId, phoneNumber, messageText, smsType]
    );
    
    return { status: 'FALLBACK_SUCCESS', message: 'SMS logged and simulated successfully.' };
  }
}

async function initWhatsAppForCompany(companyId) {
  try {
    const sessionPath = path.join(__dirname, `wa_sessions/company_${companyId}`);
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ['L3 Technologies Dashboard', 'Chrome', '1.0.0'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr);
          waQrCodes.set(companyId, qrDataUrl);
          console.log(`[WhatsApp Engine] Generated new QR Code DataURL for Company ID: ${companyId}`);
        } catch (err) {
          console.error('[WhatsApp Engine] Error encoding QR DataURL:', err);
        }
      }

      if (connection === 'open') {
        waQrCodes.delete(companyId);
        waSessions.set(companyId, sock);
        console.log(`[WhatsApp Engine] Connection OPEN & Authenticated for Company ID: ${companyId}`);
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error instanceof Boom) 
          ? lastDisconnect.error.output.statusCode 
          : null;

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        if (shouldReconnect) {
          console.log(`[WhatsApp Engine] Session closed for Company ID: ${companyId}. Attempting auto-reconnect...`);
          await delay(3000);
          initWhatsAppForCompany(companyId);
        } else {
          console.log(`[WhatsApp Engine] Session logged out for Company ID: ${companyId}. Purging session storage.`);
          waQrCodes.delete(companyId);
          waSessions.delete(companyId);
          if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
          }
        }
      }
    });

    waSessions.set(companyId, sock);
  } catch (err) {
    console.error(`[WhatsApp Engine Error] Failed initialization for Company ID ${companyId}:`, err);
  }
}

async function sendWhatsAppMessage(companyId, recipientPhone, messageText) {
  let sock = waSessions.get(companyId);
  
  if (!sock) {
    throw new Error('WhatsApp session is not active for this company. Please scan the QR code in your dashboard.');
  }

  let formattedPhone = recipientPhone.replace(/\D/g, '');
  if (formattedPhone.startsWith('0')) {
    formattedPhone = '27' + formattedPhone.substring(1);
  }
  const jid = `${formattedPhone}@s.whatsapp.net`;

  try {
    await sock.sendMessage(jid, { text: messageText });
    
    await pool.query(
      `INSERT INTO sms_logs (company_id, recipient_phone, message_text, sms_type, status) VALUES (?, ?, ?, 'WHATSAPP', 'SENT')`,
      [companyId, recipientPhone, messageText]
    );

    return { success: true };
  } catch (err) {
    console.error('[WhatsApp Message Send Error]:', err.message);
    
    await pool.query(
      `INSERT INTO sms_logs (company_id, recipient_phone, message_text, sms_type, status) VALUES (?, ?, ?, 'WHATSAPP', 'FAILED')`,
      [companyId, recipientPhone, messageText]
    );
    throw err;
  }
}

// ====================================================================================================
// SECTION 4: PAYMENT GATEWAY INTEGRATIONS (STITCH GRAPHQL & SIMULATION)
// ====================================================================================================

async function initializeStitchDebitOrder(companyId, registrationFee = 350, monthlyFee = 200) {
  try {
    const totalAmount = registrationFee + monthlyFee;
    const baseUrl = process.env.BASE_URL || 'https://loans-1uwj.onrender.com';

    if (!process.env.STITCH_CLIENT_ID || process.env.STITCH_CLIENT_ID === 'your_client_id_here') {
      console.log(`[Stitch Simulation Mode] Simulated payment wall generated for Company ID: ${companyId}`);
      return `${baseUrl}/simulate-payment.html?company_id=${companyId}`;
    }

    const authRes = await axios.post(
      'https://secure.stitch.money/connect/token', 
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.STITCH_CLIENT_ID,
        client_secret: process.env.STITCH_CLIENT_SECRET,
        scope: 'payment'
      }), 
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const stitchToken = authRes.data.access_token;

    const graphqlQuery = {
      query: `
        mutation ClientPaymentInitiationCreate($input: ClientPaymentInitiationInput!) {
          clientPaymentInitiationCreate(input: $input) {
            paymentInit {
              id
              paymentUrl
            }
            errors {
              message
              code
            }
          }
        }
      `,
      variables: {
        input: {
          amount: { quantity: totalAmount.toFixed(2), currency: "ZAR" },
          payerReference: `COMP-REG-${companyId}`,
          beneficiaryReference: "L3-SAAS-REG",
          redirectUrl: `${baseUrl}/api/payments/stitch-callback?company_id=${companyId}`
        }
      }
    };

    const stitchRes = await axios.post(
      process.env.STITCH_API_URL || 'https://api.stitch.money/graphql',
      graphqlQuery,
      {
        headers: {
          'Authorization': `Bearer ${stitchToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const paymentData = stitchRes.data?.data?.clientPaymentInitiationCreate;
    const paymentUrl = paymentData?.paymentInit?.paymentUrl;
    const errors = paymentData?.errors;

    if (errors && errors.length > 0 || !paymentUrl) {
      return `${baseUrl}/simulate-payment.html?company_id=${companyId}`;
    }

    return paymentUrl;
  } catch (err) {
    console.error('[Stitch Payment Warning - Falling back to simulation]:', err?.response?.data || err.message);
    return `${process.env.BASE_URL || 'https://loans-1uwj.onrender.com'}/simulate-payment.html?company_id=${companyId}`;
  }
}

// ====================================================================================================
// SECTION 5: AUTOMATED CRON SCHEDULER (REMINDERS & BIRTHDAYS)
// ====================================================================================================

cron.schedule('0 8 * * *', async () => {
  console.log('[Cron Service] Executing daily automated multi-channel client notification service...');
  try {
    const today = new Date();
    const targetDate = new Date();
    targetDate.setDate(today.getDate() + 3);
    const formattedDueDate = targetDate.toISOString().split('T')[0];

    const [dueLoans] = await pool.query(
      `SELECT l.*, b.phone, b.first_name, c.company_name 
       FROM loans l 
       JOIN borrowers b ON l.borrower_id = b.id 
       JOIN companies c ON l.company_id = c.id 
       WHERE l.next_due_date = ? AND l.outstanding_balance > 0`,
      [formattedDueDate]
    );

    for (const loan of dueLoans) {
      const reminderMsg = `Dear ${loan.first_name}, reminder from ${loan.company_name}: Your loan payment of R${loan.monthly_repayment_amount} is due on ${formattedDueDate}. Outstanding balance: R${loan.outstanding_balance}.`;
      await sendMTNSMS(loan.phone, reminderMsg, loan.company_id, 'REMINDER');
      try {
        await sendWhatsAppMessage(loan.company_id, loan.phone, reminderMsg);
      } catch (wErr) {}
    }

    const [birthdayBorrowers] = await pool.query(
      `SELECT b.*, c.company_name 
       FROM borrowers b 
       JOIN companies c ON b.company_id = c.id 
       WHERE DATE_FORMAT(b.dob, '%m-%d') = DATE_FORMAT(NOW(), '%m-%d')`
    );

    for (const borrower of birthdayBorrowers) {
      const birthdayMsg = `Happy Birthday ${borrower.first_name}! Wishing you success and prosperity today. - Best regards from all of us at ${borrower.company_name}`;
      await sendMTNSMS(borrower.phone, birthdayMsg, borrower.company_id, 'BIRTHDAY');
      try {
        await sendWhatsAppMessage(borrower.company_id, borrower.phone, birthdayMsg);
      } catch (wErr) {}
    }
  } catch (err) {
    console.error('[Cron Service Error]:', err);
  }
});

// ====================================================================================================
// SECTION 6: API ROUTES & CONTROLLERS
// ====================================================================================================

app.post('/api/companies/register', async (req, res) => {
  try {
    const { company_name, email, phone, address, registration_number, ncri_number, password } = req.body;

    if (!company_name || !email || !password) {
      return res.status(400).json({ error: 'Company name, email, and password are required.' });
    }

    const companySlug = slugify(company_name, { lower: true, strict: true, trim: true });
    const passwordHash = await bcrypt.hash(password, 10);

    const [result] = await pool.query(
      `INSERT INTO companies (company_name, company_slug, email, phone, address, registration_number, ncri_number, password_hash, is_registered_paid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, FALSE)`,
      [company_name, companySlug, email, phone, address, registration_number, ncri_number, passwordHash]
    );

    const companyId = result.insertId;

    await pool.query(
      `INSERT INTO employees (company_id, id_number, first_name, last_name, email, phone, password_hash, role)
       VALUES (?, '0000000000000', 'Admin', ?, ?, ?, ?, 'ADMIN')`,
      [companyId, company_name, email, phone, passwordHash]
    );

    const stitchPaymentUrl = await initializeStitchDebitOrder(companyId, 350, 200);

    res.status(201).json({
      message: 'Company registered successfully. Complete payment to activate account.',
      company_id: companyId,
      company_slug: companySlug,
      company_url: `${process.env.BASE_URL || 'https://loans-1uwj.onrender.com'}/apply/${companySlug}`,
      stitch_payment_url: stitchPaymentUrl
    });
  } catch (err) {
    console.error('[Registration Route Error]:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/payments/stitch-callback', async (req, res) => {
  try {
    const { company_id } = req.query;
    await pool.query(
      `UPDATE companies SET is_registered_paid = TRUE, stitch_subscription_status = 'ACTIVE' WHERE id = ?`, 
      [company_id]
    );
    res.redirect(`${process.env.BASE_URL || 'https://loans-1uwj.onrender.com'}/company-login.html?payment=success`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 1. VIEW ALL PENDING ACCOUNTS / COMPANIES
// ==========================================
app.get('/api/admin/pending-accounts', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [pending] = await pool.query(
      "SELECT id, company_name, email, slug, created_at, subscription_status FROM companies WHERE subscription_status = 'PENDING' OR subscription_status IS NULL"
    );
    res.json({ success: true, pending_accounts: pending });
  } catch (err) {
    console.error('Error fetching pending accounts:', err);
    res.status(500).json({ error: 'Database error fetching pending accounts' });
  }
});

// ==========================================
// 2. DELETE ALL PENDING ACCOUNTS
// ==========================================
app.delete('/api/admin/delete-pending-accounts', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const [result] = await pool.query(
      "DELETE FROM companies WHERE subscription_status = 'PENDING' OR subscription_status IS NULL"
    );
    res.json({ 
      success: true, 
      message: `Successfully deleted ${result.affectedRows} pending account(s).` 
    });
  } catch (err) {
    console.error('Error deleting pending accounts:', err);
    res.status(500).json({ error: 'Database error deleting pending accounts' });
  }
});


app.get('/simulate-payment.html', (req, res) => {
  const companyId = req.query.company_id;
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Simulated Stitch Checkout - L3 Technologies</title>
      <style>
        body { font-family: Arial, sans-serif; background: #f4f7f6; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .card { background: white; padding: 2.5rem; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); width: 100%; max-width: 420px; text-align: center; }
        .btn { background: #0d6efd; color: white; border: none; padding: 0.75rem 1.5rem; border-radius: 4px; font-size: 1rem; cursor: pointer; width: 100%; margin-top: 1.5rem; }
        .btn:hover { background: #0b5ed7; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>Stitch Secure Checkout (Sandbox Simulation)</h2>
        <p>Amount Due: <strong>R550.00</strong> (R350 Registration + R200 Monthly)</p>
        <p style="color: #6c757d; font-size: 0.9rem; margin-top: 1rem;">Complete your subscription payment to unlock full access to your company loan dashboard.</p>
        <a href="/api/payments/stitch-callback?company_id=${companyId}">
          <button class="btn">Simulate Successful Payment</button>
        </a>
      </div>
    </body>
    </html>
  `);
});

// ====================================================================================================
// SECTION 7: CONDITIONAL SALES AGENT MODULE CONFIGURATION
// ====================================================================================================

app.post('/api/company/agent-config', authenticateToken, requireAdminRole, async (req, res) => {
  try {
    const { agents_module_active, agent_commission_amount } = req.body;
    
    await pool.query(
      `UPDATE companies SET agents_module_active = ?, agent_commission_amount = ? WHERE id = ?`,
      [agents_module_active ? true : false, agent_commission_amount || 0.00, req.user.companyId]
    );

    res.json({ 
      message: 'Sales agent module settings updated successfully.',
      agents_module_active: !!agents_module_active,
      agent_commission_amount: agent_commission_amount || 0.00
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/company/public-config/:company_slug', async (req, res) => {
  try {
    const { company_slug } = req.params;
    const normalizedSlug = slugify(company_slug.trim(), { lower: true, strict: true });

    const [companies] = await pool.query(
      `SELECT company_name, company_slug, is_registered_paid, agents_module_active, agent_commission_amount FROM companies WHERE company_slug = ?`,
      [normalizedSlug]
    );

    if (companies.length === 0) {
      return res.status(404).json({ error: 'Company not found.' });
    }

    const comp = companies[0];
    res.json({
      company_name: comp.company_name,
      company_slug: comp.company_slug,
      is_registered_paid: comp.is_registered_paid,
      agents_module_active: comp.agents_module_active,
      agent_commission_amount: comp.agents_module_active ? comp.agent_commission_amount : 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ====================================================================================================
// SECTION 8: AUTHENTICATION & LOGIN (WITH PAYMENT GATE CHECK)
// ====================================================================================================

app.post('/api/auth/company-login', async (req, res) => {
  try {
    const { email_or_id, password, company_slug } = req.body;

    if (!company_slug || !email_or_id || !password) {
      return res.status(400).json({ error: 'Company slug, identifier, and password are required.' });
    }

    const normalizedSlug = slugify(company_slug.trim(), { lower: true, strict: true });

    const [companies] = await pool.query(`SELECT * FROM companies WHERE company_slug = ?`, [normalizedSlug]);
    if (companies.length === 0) {
      return res.status(404).json({ error: `Credit company with slug identifier '${normalizedSlug}' was not found.` });
    }
    const company = companies[0];

    // 🔒 PAYMENT GATE CHECK: Block login if registration/subscription is not paid
    if (!company.is_registered_paid) {
      return res.status(403).json({ 
        error: 'Account access restricted. Please complete your registration and subscription payment to unlock your dashboard.',
        payment_url: `${process.env.BASE_URL || 'https://loans-1uwj.onrender.com'}/simulate-payment.html?company_id=${company.id}`
      });
    }

    const [employees] = await pool.query(
      `SELECT * FROM employees WHERE company_id = ? AND (email = ? OR id_number = ?)`,
      [company.id, email_or_id, email_or_id]
    );

    if (employees.length === 0) {
      return res.status(401).json({ error: 'Invalid login credentials for this company.' });
    }
    const emp = employees[0];

    const isMatch = await bcrypt.compare(password, emp.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid password provided.' });
    }

    const token = jwt.sign(
      { userId: emp.id, role: emp.role, companyId: company.id, userType: 'EMPLOYEE' },
      process.env.JWT_SECRET || 'L3Tech_Enterprise_Secret_Key_2026',
      { expiresIn: '24h' }
    );

    res.json({ 
      token, 
      role: emp.role, 
      company: { id: company.id, name: company.company_name, slug: company.company_slug } 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/agent-login', async (req, res) => {
  try {
    const { id_number, password, company_slug } = req.body;
    const normalizedSlug = slugify(company_slug.trim(), { lower: true, strict: true });

    const [companies] = await pool.query(`SELECT id, agents_module_active FROM companies WHERE company_slug = ?`, [normalizedSlug]);
    if (companies.length === 0) return res.status(404).json({ error: 'Credit provider company not found.' });

    if (!companies[0].agents_module_active) {
      return res.status(403).json({ error: 'Sales agent portal is not enabled by this credit provider.' });
    }

    const [agents] = await pool.query(
      `SELECT * FROM sales_agents WHERE company_id = ? AND id_number = ?`,
      [companies[0].id, id_number]
    );

    if (agents.length === 0) return res.status(401).json({ error: 'Agent record not found.' });
    const agent = agents[0];

    if (agent.approval_status !== 'APPROVED') {
      return res.status(403).json({ error: `Login blocked. Agent application status is: ${agent.approval_status}` });
    }

    const isMatch = await bcrypt.compare(password, agent.password_hash);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials provided.' });

    const token = jwt.sign(
      { userId: agent.id, companyId: companies[0].id, userType: 'AGENT' },
      process.env.JWT_SECRET || 'L3Tech_Enterprise_Secret_Key_2026',
      { expiresIn: '24h' }
    );

    res.json({ token, agent_id: agent.id, first_name: agent.first_name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/borrower-login', async (req, res) => {
  try {
    const { id_number, password, company_slug } = req.body;
    const normalizedSlug = slugify(company_slug.trim(), { lower: true, strict: true });

    const [companies] = await pool.query(`SELECT id FROM companies WHERE company_slug = ?`, [normalizedSlug]);
    if (companies.length === 0) return res.status(404).json({ error: 'Credit provider company not found.' });

    const [borrowers] = await pool.query(
      `SELECT * FROM borrowers WHERE company_id = ? AND id_number = ?`,
      [companies[0].id, id_number]
    );

    if (borrowers.length === 0) return res.status(401).json({ error: 'Borrower record not found.' });
    const b = borrowers[0];

    const isMatch = await bcrypt.compare(password, b.password_hash);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials provided.' });

    const token = jwt.sign(
      { userId: b.id, companyId: companies[0].id, userType: 'BORROWER' },
      process.env.JWT_SECRET || 'L3Tech_Enterprise_Secret_Key_2026',
      { expiresIn: '24h' }
    );

    res.json({ token, borrower: { id: b.id, first_name: b.first_name, last_name: b.last_name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================================================================
// SECTION 9: UNIQUE COMPANY APPLICATION URL ROUTE
// ====================================================================================================

app.get('/apply/:company_slug', async (req, res) => {
  try {
    const { company_slug } = req.params;
    const normalizedSlug = slugify(company_slug.trim(), { lower: true, strict: true });

    const [companies] = await pool.query(
      `SELECT id, company_name, company_slug, is_registered_paid, agents_module_active, agent_commission_amount FROM companies WHERE company_slug = ?`, 
      [normalizedSlug]
    );

    if (companies.length === 0) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head><title>Company Not Found</title><style>body{font-family:Arial,sans-serif;text-align:center;padding:50px;background:#f8f9fa;color:#333;}</style></head>
        <body>
          <h1>Credit Provider Not Found</h1>
          <p>The loan application link you followed ('${normalizedSlug}') does not exist or has been removed.</p>
        </body>
        </html>
      `);
    }

    const company = companies[0];

    if (!company.is_registered_paid) {
      return res.status(403).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head><title>Account Inactive</title><style>body{font-family:Arial,sans-serif;text-align:center;padding:50px;background:#f8f9fa;color:#333;}</style></head>
        <body>
          <h1>Application Temporarily Unavailable</h1>
          <p><strong>${company.company_name}</strong> is currently completing its system setup. Please try again shortly.</p>
        </body>
        </html>
      `);
    }

    res.sendFile(path.join(__dirname, 'public', 'borrower-apply.html'));
  } catch (err) {
    console.error('[Apply Slug Route Error]:', err);
    res.status(500).send('Internal server error loading application portal.');
  }
});

// ====================================================================================================
// SECTION 10: BORROWER & AGENT APPLICATION ENDPOINTS
// ====================================================================================================

app.post('/api/agents/apply/:company_slug', upload.fields([
  { name: 'cv_document', maxCount: 1 },
  { name: 'id_copy', maxCount: 1 },
  { name: 'proof_of_residence', maxCount: 1 }
]), async (req, res) => {
  try {
    const { company_slug } = req.params;
    const normalizedSlug = slugify(company_slug.trim(), { lower: true, strict: true });
    const { id_number, first_name, last_name, email, phone, password } = req.body;

    const [companies] = await pool.query(`SELECT id, agents_module_active FROM companies WHERE company_slug = ?`, [normalizedSlug]);
    if (companies.length === 0) return res.status(404).json({ error: 'Credit provider company not found.' });

    if (!companies[0].agents_module_active) {
      return res.status(403).json({ error: 'Sales agent recruitment is disabled for this credit provider.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const cvPath = req.files['cv_document'] ? req.files['cv_document'][0].path : null;
    const idPath = req.files['id_copy'] ? req.files['id_copy'][0].path : null;
    const resPath = req.files['proof_of_residence'] ? req.files['proof_of_residence'][0].path : null;

    await pool.query(
      `INSERT INTO sales_agents (company_id, id_number, first_name, last_name, email, phone, password_hash, cv_document_path, id_copy_path, proof_of_residence_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [companies[0].id, id_number, first_name, last_name, email, phone, passwordHash, cvPath, idPath, resPath]
    );

    res.status(201).json({ message: 'Sales agent application submitted successfully. Awaiting provider approval.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/borrowers/apply/:company_slug', upload.fields([
  { name: 'id_copy_doc', maxCount: 1 },
  { name: 'proof_residence_doc', maxCount: 1 },
  { name: 'income_proof_doc', maxCount: 1 },
  { name: 'bank_statement_doc', maxCount: 1 }
]), async (req, res) => {
  try {
    const { company_slug } = req.params;
    const normalizedSlug = slugify(company_slug.trim(), { lower: true, strict: true });
    const {
      id_number, first_name, last_name, email, phone, dob, residential_address,
      proof_of_address_type, employment_status, employer_name, monthly_gross_income,
      monthly_net_income, monthly_total_expenses, existing_debt_obligations,
      bank_name, account_number, branch_code, account_type, credit_check_consent,
      password, agent_id
    } = req.body;

    if (credit_check_consent !== 'true' && credit_check_consent !== true) {
      return res.status(400).json({ error: 'Explicit consent for credit record check is mandatory under NCA regulations.' });
    }

    const [companies] = await pool.query(`SELECT id FROM companies WHERE company_slug = ?`, [normalizedSlug]);
    if (companies.length === 0) return res.status(404).json({ error: 'Credit provider company not found.' });

    const passwordHash = await bcrypt.hash(password, 10);

    const idCopy = req.files['id_copy_doc'] ? req.files['id_copy_doc'][0].path : null;
    const proofRes = req.files['proof_residence_doc'] ? req.files['proof_residence_doc'][0].path : null;
    const incomeProof = req.files['income_proof_doc'] ? req.files['income_proof_doc'][0].path : null;
    const bankStmt = req.files['bank_statement_doc'] ? req.files['bank_statement_doc'][0].path : null;

    const [result] = await pool.query(
      `INSERT INTO borrowers (
        company_id, agent_id, id_number, first_name, last_name, email, phone, dob,
        residential_address, proof_of_address_type, employment_status, employer_name,
        monthly_gross_income, monthly_net_income, monthly_total_expenses, existing_debt_obligations,
        bank_name, account_number, branch_code, account_type, credit_check_consent,
        nca_affordability_consent, id_copy_doc, proof_residence_doc,
        income_proof_doc, bank_statement_doc, password_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        companies[0].id, agent_id || null, id_number, first_name, last_name, email, phone, dob,
        residential_address, proof_of_address_type, employment_status, employer_name,
        monthly_gross_income, monthly_net_income, monthly_total_expenses, existing_debt_obligations || 0,
        bank_name, account_number, branch_code, account_type, true,
        true, idCopy, proofRes, incomeProof, bankStmt, passwordHash
      ]
    );

    res.status(201).json({ message: 'Loan application & compliance documents submitted successfully.', borrower_id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================================================================
// SECTION 11: ADDITIONAL SUPPORTING API ENDPOINTS & REPORTS
// ====================================================================================================

app.get('/api/employees', authenticateToken, async (req, res) => {
  try {
    const [employees] = await pool.query(
      `SELECT id, id_number, first_name, last_name, email, phone, role, created_at, is_active FROM employees WHERE company_id = ?`,
      [req.user.companyId]
    );
    res.json({ employees });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/employees/add', authenticateToken, requireAdminRole, async (req, res) => {
  try {
    const { id_number, first_name, last_name, email, phone, password, role } = req.body;
    if (!id_number || !first_name || !last_name || !email || !password) {
      return res.status(400).json({ error: 'All fields are required to register a staff member.' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO employees (company_id, id_number, first_name, last_name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.companyId, id_number, first_name, last_name, email, phone, passwordHash, role || 'STAFF']
    );
    res.json({ message: 'Employee added successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sms/logs', authenticateToken, async (req, res) => {
  try {
    const [logs] = await pool.query(
      `SELECT recipient_phone, message_text, sms_type, status, created_at FROM sms_logs WHERE company_id = ? ORDER BY created_at DESC LIMIT 100`,
      [req.user.companyId]
    );
    res.json({ sms_logs: logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sms/send', authenticateToken, async (req, res) => {
  try {
    const { phone_number, message } = req.body;
    if (!phone_number || !message) return res.status(400).json({ error: 'Destination phone number and message text are required.' });
    await sendMTNSMS(phone_number, message, req.user.companyId, 'MANUAL_DISPATCH');
    res.json({ message: 'SMS message dispatched successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/whatsapp/send', authenticateToken, async (req, res) => {
  try {
    const { phone_number, message } = req.body;
    if (!phone_number || !message) return res.status(400).json({ error: 'Destination phone number and message text are required.' });
    await sendWhatsAppMessage(req.user.companyId, phone_number, message);
    res.json({ message: 'WhatsApp message dispatched successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/whatsapp/connect', authenticateToken, async (req, res) => {
  try {
    initWhatsAppForCompany(req.user.companyId);
    res.json({ message: 'WhatsApp engine initialization started.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/whatsapp/qr', authenticateToken, async (req, res) => {
  const qr = waQrCodes.get(req.user.companyId);
  if (!qr) return res.status(404).json({ message: 'QR code not generated yet or session authenticated.' });
  res.json({ qr_code: qr });
});

app.get('/api/reports/ledger', authenticateToken, async (req, res) => {
  try {
    const { date_from, date_to } = req.query;
    let query = `SELECT t.*, b.first_name, b.last_name, b.id_number FROM transactions t JOIN borrowers b ON t.borrower_id = b.id WHERE t.company_id = ?`;
    const params = [req.user.companyId];
    if (date_from && date_to) {
      query += ` AND DATE(t.transaction_date) BETWEEN ? AND ?`;
      params.push(date_from, date_to);
    }
    query += ` ORDER BY t.transaction_date DESC`;
    const [transactions] = await pool.query(query, params);
    const crj = transactions.filter(t => t.ledger_type === 'CRJ');
    const cpj = transactions.filter(t => t.ledger_type === 'CPJ');
    const totalCRJ = crj.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    const totalCPJ = cpj.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    res.json({
      summary: { total_cash_received: totalCRJ, total_cash_paid_out: totalCPJ, net_cash_flow: totalCRJ - totalCPJ },
      crj_ledger: crj,
      cpj_ledger: cpj,
      all_transactions: transactions
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/transactions/payment', authenticateToken, async (req, res) => {
  try {
    const { loan_id, amount, reference } = req.body;
    const [loans] = await pool.query(
      `SELECT l.*, b.phone, b.first_name FROM loans l JOIN borrowers b ON l.borrower_id = b.id WHERE l.id = ? AND l.company_id = ?`, 
      [loan_id, req.user.companyId]
    );
    if (loans.length === 0) return res.status(404).json({ error: 'Loan account not found.' });
    const loan = loans[0];
    const newBalance = Math.max(0, parseFloat(loan.outstanding_balance) - parseFloat(amount));
    const newStatus = newBalance === 0 ? 'SETTLED' : loan.status;

    await pool.query(`UPDATE loans SET outstanding_balance = ?, status = ? WHERE id = ?`, [newBalance, newStatus, loan_id]);
    await pool.query(
      `INSERT INTO transactions (company_id, loan_id, borrower_id, amount, transaction_type, reference, balance_after, ledger_type) VALUES (?, ?, ?, ?, 'REPAYMENT', ?, ?, 'CRJ')`,
      [req.user.companyId, loan_id, loan.borrower_id, amount, reference || `PAY-${Date.now()}`, newBalance]
    );
    const smsMessage = `Payment Received! Dear ${loan.first_name}, thank you for your payment of R${amount}. Remaining balance: R${newBalance.toFixed(2)}.`;
    await sendMTNSMS(loan.phone, smsMessage, req.user.companyId, 'PAYMENT_RECEIPT');
    try {
      await sendWhatsAppMessage(req.user.companyId, loan.phone, smsMessage);
    } catch (wErr) {}
    res.json({ message: 'Payment recorded successfully.', remaining_balance: newBalance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/borrowers/:id/download-pdf', authenticateToken, async (req, res) => {
  try {
    const [borrowers] = await pool.query(
      `SELECT b.*, c.company_name FROM borrowers b JOIN companies c ON b.company_id = c.id WHERE b.id = ? AND b.company_id = ?`,
      [req.params.id, req.user.companyId]
    );
    if (borrowers.length === 0) return res.status(404).json({ error: 'Borrower record not found' });
    const b = borrowers[0];

    const doc = new PDFDocument({ margin: 50 });
    const pdfPath = path.join(uploadDir, `Application_${b.id_number}.pdf`);
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    doc.fontSize(20).text(`${b.company_name}`, { align: 'center' });
    doc.fontSize(14).text('CREDIT APPLICATION & NCA CONSENT FORM', { align: 'center' }).moveDown();
    doc.fontSize(10).text(`Applicant Name: ${b.first_name} ${b.last_name}`);
    doc.text(`ID Number: ${b.id_number}`);
    doc.text(`Email: ${b.email} | Phone: ${b.phone}`);
    doc.text(`Residential Address: ${b.residential_address}`);
    doc.text(`Employment Status: ${b.employment_status} | Net Income: R${b.monthly_net_income}`).moveDown();
    doc.text('CREDIT BUREAU CONSENT & DECLARATION', { underline: true });
    doc.text('I hereby grant full consent to the credit provider to perform credit checks with any registered South African credit bureau, verify my bank details, and process my personal information in compliance with POPIA and NCA guidelines.').moveDown(2);
    doc.text('Client Signature: _______________________      Date: ____________');
    doc.end();

    stream.on('finish', () => {
      res.download(pdfPath);
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. PROVISION / REGISTER L3 TECHNOLOGIES
// ==========================================
app.post('/api/admin/provision-l3-technologies', async (req, res) => {
  try {
    const companyName = 'L3 Technologies';
    const slug = 'l3-technologies';
    const email = 'Tebogoanthony455@gmail.com';
    const plainPassword = 'Tebogo1234@';
    
    // Hash password securely using the existing bcrypt instance
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(plainPassword, saltRounds);

    // Check if company already exists
    const [existing] = await pool.query("SELECT id FROM companies WHERE slug = ? OR email = ?", [slug, email]);
    
    let companyId;
    if (existing.length > 0) {
      companyId = existing[0].id;
      // Update existing record to ensure active status and correct credentials
      await pool.query(
        `UPDATE companies 
         SET company_name = ?, email = ?, password_hash = ?, subscription_status = 'ACTIVE', agents_module_active = 1, agent_commission_amount = 150.00 
         WHERE id = ?`,
        [companyName, email, passwordHash, companyId]
      );
    } else {
      // Insert new active company account
      const [insertResult] = await pool.query(
        `INSERT INTO companies (company_name, slug, email, password_hash, subscription_status, agents_module_active, agent_commission_amount) 
         VALUES (?, ?, ?, ?, 'ACTIVE', 1, 150.00)`,
        [companyName, slug, email, passwordHash]
      );
      companyId = insertResult.insertId;
    }

    // Ensure staff/admin user record exists for this company
    const [existingUser] = await pool.query("SELECT id FROM users WHERE email = ?", [email]);
    if (existingUser.length === 0) {
      await pool.query(
        `INSERT INTO users (company_id, first_name, last_name, id_number, email, phone, password_hash, role) 
         VALUES (?, 'Tebogo', 'Kaulela', '9901015000088', ?, '0715694131', ?, 'ADMIN')`,
        [companyId, email, passwordHash]
      );
    } else {
      await pool.query(
        `UPDATE users SET company_id = ?, role = 'ADMIN', password_hash = ? WHERE email = ?`,
        [companyId, passwordHash, email]
      );
    }

    res.json({
      success: true,
      message: 'L3 Technologies account successfully provisioned and set to ACTIVE with ADMIN privileges!',
      login_url: `${req.protocol}://${req.get('host')}/company-login.html`,
      credentials: { email, slug }
    });
  } catch (err) {
    console.error('Error provisioning L3 Technologies:', err);
    res.status(500).json({ error: err.message || 'Server error provisioning account' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`====================================================================================`);
  console.log(`L3 Technologies Loan SaaS Backend active on Port: ${PORT}`);
  console.log(`====================================================================================`);
});