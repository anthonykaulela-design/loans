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
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

const pool = require('./database');
require('dotenv').config();

const app = express();

// Enable CORS across all routes for unrestricted API consumption
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static directory for uploaded KYC documents and rendered HTML files
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

// Multer Storage Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, '_')}`)
});
const upload = multer({ storage });

// Multi-Tenant WhatsApp Sessions Storage
const waSessions = new Map();
const waQrCodes = new Map();

// ==========================================
// AUTHENTICATION & AUTHORIZATION MIDDLEWARE
// ==========================================
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
};

// ==========================================
// THIRD-PARTY INTEGRATION HELPERS
// ==========================================

// MTN SMS Sending Service
async function sendMTNSMS(phoneNumber, messageText, companyId, smsType) {
  try {
    const authString = Buffer.from(`${process.env.MTN_CONSUMER_KEY}:${process.env.MTN_CONSUMER_SECRET}`).toString('base64');
    
    // Request Token from MTN OAuth API
    const tokenResponse = await axios.post('https://api.mtn.com/v1/oauth/client_credential/accesstoken?grant_type=client_credentials', {}, {
      headers: {
        'Authorization': `Basic ${authString}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const accessToken = tokenResponse.data.access_token;

    // Send SMS via MTN Gateway
    const response = await axios.post(process.env.MTN_SMS_URL, {
      outboundSMSMessageRequest: {
        address: [`tel:${phoneNumber}`],
        senderAddress: "L3LOANS",
        outboundSMSTextMessage: { message: messageText }
      }
    }, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    await pool.query(
      `INSERT INTO sms_logs (company_id, recipient_phone, message_text, sms_type, status) VALUES (?, ?, ?, ?, 'SENT')`,
      [companyId, phoneNumber, messageText, smsType]
    );

    return response.data;
  } catch (error) {
    console.error('MTN SMS Gateway Error:', error?.response?.data || error.message);
    await pool.query(
      `INSERT INTO sms_logs (company_id, recipient_phone, message_text, sms_type, status) VALUES (?, ?, ?, ?, 'FAILED')`,
      [companyId, phoneNumber, messageText, smsType]
    );
    return null;
  }
}

// Stitch Authorization & Payment Initialization
async function initializeStitchDebitOrder(companyId, registrationFee = 350, monthlyFee = 200) {
  try {
    const totalAmount = registrationFee + monthlyFee;
    const graphqlQuery = {
      query: `
        mutation CreateDebitOrderMandate($amount: String!, $reference: String!) {
          clientPaymentInitiation(input: {
            amount: { quantity: $amount, currency: ZAR },
            payerReference: $reference,
            beneficiaryReference: "L3-SAAS-REG"
          }) {
            paymentUrl
            id
          }
        }
      `,
      variables: {
        amount: totalAmount.toFixed(2),
        reference: `COMP-REG-${companyId}`
      }
    };

    // OAuth call for Stitch Token
    const authRes = await axios.post('https://connect.stitch.money/oauth/token', 
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.STITCH_CLIENT_ID,
        client_secret: process.env.STITCH_CLIENT_SECRET,
        scope: 'payment'
      }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const stitchToken = authRes.data.access_token;

    const stitchRes = await axios.post(process.env.STITCH_API_URL, graphqlQuery, {
      headers: {
        'Authorization': `Bearer ${stitchToken}`,
        'Content-Type': 'application/json'
      }
    });

    return stitchRes.data?.data?.clientPaymentInitiation;
  } catch (err) {
    console.error('Stitch Debit Order Error:', err?.response?.data || err.message);
    return null;
  }
}

// WhatsApp Baileys Instance Generator per Company
async function initWhatsAppForCompany(companyId) {
  const sessionPath = path.join(__dirname, `wa_sessions/company_${companyId}`);
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      const qrDataUrl = await QRCode.toDataURL(qr);
      waQrCodes.set(companyId, qrDataUrl);
    }
    if (connection === 'open') {
      waQrCodes.delete(companyId);
      waSessions.set(companyId, sock);
      console.log(`WhatsApp Session Active for Company ID: ${companyId}`);
    }
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) initWhatsAppForCompany(companyId);
    }
  });
}

// Automatic Cron Job for SMS Reminders and Birthdays (Runs Daily at 08:00 AM)
cron.schedule('0 8 * * *', async () => {
  console.log('Running Daily Automated SMS & Payment Reminder Cron Service...');
  try {
    const today = new Date();
    const targetDate = new Date();
    targetDate.setDate(today.getDate() + 3);
    const formattedDueDate = targetDate.toISOString().split('T')[0];

    // 1. Send Payment Reminders (3 Days Prior)
    const [dueLoans] = await pool.query(
      `SELECT l.*, b.phone, b.first_name, c.company_name 
       FROM loans l 
       JOIN borrowers b ON l.borrower_id = b.id 
       JOIN companies c ON l.company_id = c.id 
       WHERE l.next_due_date = ? AND l.outstanding_balance > 0`,
      [formattedDueDate]
    );

    for (const loan of dueLoans) {
      const msg = `Dear ${loan.first_name}, reminder from ${loan.company_name}: Your loan payment of R${loan.monthly_repayment_amount} is due on ${formattedDueDate}. Balance: R${loan.outstanding_balance}.`;
      await sendMTNSMS(loan.phone, msg, loan.company_id, 'REMINDER');
    }

    // 2. Birthday Wishes
    const monthDayStr = `-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const [birthdayBorrowers] = await pool.query(
      `SELECT b.*, c.company_name FROM borrowers b JOIN companies c ON b.company_id = c.id WHERE DATE_FORMAT(b.dob, '%m-%d') = DATE_FORMAT(NOW(), '%m-%d')`
    );

    for (const b of birthdayBorrowers) {
      const msg = `Happy Birthday ${b.first_name}! Wishing you joy and success today. - Warm regards, ${b.company_name}`;
      await sendMTNSMS(b.phone, msg, b.company_id, 'BIRTHDAY');
    }
  } catch (err) {
    console.error('Error executing automated cron jobs:', err);
  }
});

// ==========================================
// ROUTE 1: COMPANY REGISTRATION & STITCH PAYMENT
// ==========================================
app.post('/api/companies/register', async (req, res) => {
  try {
    const { company_name, email, phone, address, registration_number, ncri_number, password } = req.body;

    const companySlug = slugify(company_name, { lower: true, strict: true });
    const passwordHash = await bcrypt.hash(password, 10);

    const [result] = await pool.query(
      `INSERT INTO companies (company_name, company_slug, email, phone, address, registration_number, ncri_number, password_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [company_name, companySlug, email, phone, address, registration_number, ncri_number, passwordHash]
    );

    const companyId = result.insertId;

    // Create default Admin Employee record
    await pool.query(
      `INSERT INTO employees (company_id, id_number, first_name, last_name, email, phone, password_hash, role)
       VALUES (?, '0000000000000', 'Admin', ?, ?, ?, ?, 'ADMIN')`,
      [companyId, company_name, email, phone, passwordHash]
    );

    // Initialize Stitch payment redirect for R350 registration + R200 month fee (R550 total)
    const stitchPayment = await initializeStitchDebitOrder(companyId, 350, 200);

    res.status(201).json({
      message: 'Company registered successfully. Complete payment to activate account.',
      company_id: companyId,
      company_url: `${process.env.BASE_URL}/apply/${companySlug}`,
      stitch_payment_url: stitchPayment?.paymentUrl || `${process.env.BASE_URL}/login?status=paid`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stitch Payment Completion Webhook / Redirect
app.get('/api/payments/stitch-callback', async (req, res) => {
  const { company_id } = req.query;
  await pool.query(`UPDATE companies SET is_registered_paid = TRUE, stitch_subscription_status = 'ACTIVE' WHERE id = ?`, [company_id]);
  res.redirect(`${process.env.BASE_URL}/login?payment=success`);
});

// Admin & Staff Authentication Login
app.post('/api/auth/company-login', async (req, res) => {
  try {
    const { email_or_id, password, company_slug } = req.body;

    const [companies] = await pool.query(`SELECT * FROM companies WHERE company_slug = ?`, [company_slug]);
    if (companies.length === 0) return res.status(404).json({ error: 'Company not found' });
    const company = companies[0];

    // Check Employee / Admin credentials
    const [employees] = await pool.query(
      `SELECT * FROM employees WHERE company_id = ? AND (email = ? OR id_number = ?)`,
      [company.id, email_or_id, email_or_id]
    );

    if (employees.length === 0) return res.status(401).json({ error: 'Invalid login credentials' });
    const emp = employees[0];

    const isMatch = await bcrypt.compare(password, emp.password_hash);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { userId: emp.id, role: emp.role, companyId: company.id, userType: 'EMPLOYEE' },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ token, role: emp.role, company: { id: company.id, name: company.company_name, slug: company.company_slug } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ROUTE 2: EMPLOYEE MANAGEMENT
// ==========================================
app.post('/api/employees/add', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin access required' });
    const { id_number, first_name, last_name, email, phone, password, role } = req.body;

    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO employees (company_id, id_number, first_name, last_name, email, phone, password_hash, role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.companyId, id_number, first_name, last_name, email, phone, passwordHash, role || 'STAFF']
    );

    res.json({ message: 'Employee added successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ROUTE 3: AGENTS MANAGEMENT & ONBOARDING
// ==========================================
app.post('/api/agents/apply/:company_slug', upload.fields([
  { name: 'cv_document', maxCount: 1 },
  { name: 'id_copy', maxCount: 1 },
  { name: 'proof_of_residence', maxCount: 1 }
]), async (req, res) => {
  try {
    const { company_slug } = req.params;
    const { id_number, first_name, last_name, email, phone, password } = req.body;

    const [companies] = await pool.query(`SELECT id, agents_module_active FROM companies WHERE company_slug = ?`, [company_slug]);
    if (companies.length === 0) return res.status(404).json({ error: 'Company not found' });
    if (!companies[0].agents_module_active) return res.status(403).json({ error: 'Agent applications are disabled for this company.' });

    const passwordHash = await bcrypt.hash(password, 10);
    const cvPath = req.files['cv_document'] ? req.files['cv_document'][0].path : null;
    const idPath = req.files['id_copy'] ? req.files['id_copy'][0].path : null;
    const resPath = req.files['proof_of_residence'] ? req.files['proof_of_residence'][0].path : null;

    await pool.query(
      `INSERT INTO sales_agents (company_id, id_number, first_name, last_name, email, phone, password_hash, cv_document_path, id_copy_path, proof_of_residence_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [companies[0].id, id_number, first_name, last_name, email, phone, passwordHash, cvPath, idPath, resPath]
    );

    res.status(201).json({ message: 'Agent application submitted successfully. Awaiting approval.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Agent Single-Tenant Verified Login
app.post('/api/auth/agent-login', async (req, res) => {
  try {
    const { id_number, password, company_slug } = req.body;

    const [companies] = await pool.query(`SELECT id FROM companies WHERE company_slug = ?`, [company_slug]);
    if (companies.length === 0) return res.status(404).json({ error: 'Company not found' });

    const [agents] = await pool.query(
      `SELECT * FROM sales_agents WHERE company_id = ? AND id_number = ?`,
      [companies[0].id, id_number]
    );

    if (agents.length === 0) return res.status(401).json({ error: 'Invalid credentials or non-existent application.' });
    const agent = agents[0];

    if (agent.approval_status !== 'APPROVED') {
      return res.status(403).json({ error: `Login blocked. Application status: ${agent.approval_status}` });
    }

    const isMatch = await bcrypt.compare(password, agent.password_hash);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { userId: agent.id, companyId: companies[0].id, userType: 'AGENT' },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ token, agent_id: agent.id, first_name: agent.first_name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Approve/Reject Agent & Toggle Agent Module
app.patch('/api/company/agent-settings', authenticateToken, async (req, res) => {
  try {
    const { agents_module_active, agent_commission_rate, agent_payout_per_lead } = req.body;
    await pool.query(
      `UPDATE companies SET agents_module_active = ?, agent_commission_rate = ?, agent_payout_per_lead = ? WHERE id = ?`,
      [agents_module_active, agent_commission_rate, agent_payout_per_lead, req.user.companyId]
    );
    res.json({ message: 'Agent module configuration updated.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/agents/:id/status', authenticateToken, async (req, res) => {
  try {
    const { status } = req.body; // APPROVED or REJECTED
    await pool.query(
      `UPDATE sales_agents SET approval_status = ?, approved_at = NOW() WHERE id = ? AND company_id = ?`,
      [status, req.params.id, req.user.companyId]
    );
    res.json({ message: `Agent status updated to ${status}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ROUTE 4: BORROWER LOAN APPLICATION
// ==========================================
app.post('/api/borrowers/apply/:company_slug', upload.fields([
  { name: 'id_copy_doc', maxCount: 1 },
  { name: 'proof_residence_doc', maxCount: 1 },
  { name: 'income_proof_doc', maxCount: 1 },
  { name: 'bank_statement_doc', maxCount: 1 }
]), async (req, res) => {
  try {
    const { company_slug } = req.params;
    const {
      id_number, first_name, last_name, email, phone, dob, residential_address,
      proof_of_address_type, employment_status, employer_name, monthly_gross_income,
      monthly_net_income, monthly_total_expenses, existing_debt_obligations,
      bank_name, account_number, branch_code, account_type, credit_check_consent,
      nca_affordability_consent, custom_form_data, password, agent_id
    } = req.body;

    if (credit_check_consent !== 'true' && credit_check_consent !== true) {
      return res.status(400).json({ error: 'Explicit consent for credit record check is mandatory under NCA.' });
    }

    const [companies] = await pool.query(`SELECT id FROM companies WHERE company_slug = ?`, [company_slug]);
    if (companies.length === 0) return res.status(404).json({ error: 'Company not found' });

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
        nca_affordability_consent, custom_form_data, id_copy_doc, proof_residence_doc,
        income_proof_doc, bank_statement_doc, password_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        companies[0].id, agent_id || null, id_number, first_name, last_name, email, phone, dob,
        residential_address, proof_of_address_type, employment_status, employer_name,
        monthly_gross_income, monthly_net_income, monthly_total_expenses, existing_debt_obligations || 0,
        bank_name, account_number, branch_code, account_type, true,
        true, custom_form_data ? JSON.stringify(custom_form_data) : null,
        idCopy, proofRes, incomeProof, bankStmt, passwordHash
      ]
    );

    res.status(201).json({ message: 'Loan application & documents submitted successfully.', borrower_id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Borrower Portal Login
app.post('/api/auth/borrower-login', async (req, res) => {
  try {
    const { id_number, password, company_slug } = req.body;

    const [companies] = await pool.query(`SELECT id FROM companies WHERE company_slug = ?`, [company_slug]);
    if (companies.length === 0) return res.status(404).json({ error: 'Company not found' });

    const [borrowers] = await pool.query(
      `SELECT * FROM borrowers WHERE company_id = ? AND id_number = ?`,
      [companies[0].id, id_number]
    );

    if (borrowers.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const b = borrowers[0];

    const isMatch = await bcrypt.compare(password, b.password_hash);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { userId: b.id, companyId: companies[0].id, userType: 'BORROWER' },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ token, borrower: { id: b.id, first_name: b.first_name, last_name: b.last_name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ROUTE 5: VIEW ALL SUBMITTED DOCUMENTS
// ==========================================
app.get('/api/company/documents', authenticateToken, async (req, res) => {
  try {
    const [borrowerDocs] = await pool.query(
      `SELECT id, id_number, first_name, last_name, id_copy_doc, proof_residence_doc, income_proof_doc, bank_statement_doc, created_at FROM borrowers WHERE company_id = ?`,
      [req.user.companyId]
    );

    const [agentDocs] = await pool.query(
      `SELECT id, id_number, first_name, last_name, cv_document_path, id_copy_path, proof_of_residence_path, created_at FROM sales_agents WHERE company_id = ?`,
      [req.user.companyId]
    );

    res.json({ borrower_documents: borrowerDocs, agent_documents: agentDocs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ROUTE 6: REAL-TIME PAYMENTS & LEDGERS (CPJ / CRJ)
// ==========================================
app.get('/api/reports/ledger', authenticateToken, async (req, res) => {
  try {
    const { date_from, date_to } = req.query;

    let query = `SELECT t.*, b.first_name, b.last_name, b.id_number 
                 FROM transactions t 
                 JOIN borrowers b ON t.borrower_id = b.id 
                 WHERE t.company_id = ?`;
    const params = [req.user.companyId];

    if (date_from && date_to) {
      query += ` AND DATE(t.transaction_date) BETWEEN ? AND ?`;
      params.push(date_from, date_to);
    }

    query += ` ORDER BY t.transaction_date DESC`;

    const [transactions] = await pool.query(query, params);

    const crj = transactions.filter(t => t.ledger_type === 'CRJ'); // Receipts
    const cpj = transactions.filter(t => t.ledger_type === 'CPJ'); // Disbursements

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

// Record Loan Payment Transaction & Instantly Send SMS with Remaining Balance
app.post('/api/transactions/payment', authenticateToken, async (req, res) => {
  try {
    const { loan_id, amount, reference } = req.body;

    const [loans] = await pool.query(`SELECT l.*, b.phone, b.first_name FROM loans l JOIN borrowers b ON l.borrower_id = b.id WHERE l.id = ? AND l.company_id = ?`, [loan_id, req.user.companyId]);
    if (loans.length === 0) return res.status(404).json({ error: 'Loan account not found.' });

    const loan = loans[0];
    const newBalance = Math.max(0, parseFloat(loan.outstanding_balance) - parseFloat(amount));
    const newStatus = newBalance === 0 ? 'SETTLED' : loan.status;

    await pool.query(`UPDATE loans SET outstanding_balance = ?, status = ? WHERE id = ?`, [newBalance, newStatus, loan_id]);

    await pool.query(
      `INSERT INTO transactions (company_id, loan_id, borrower_id, amount, transaction_type, reference, balance_after, ledger_type)
       VALUES (?, ?, ?, ?, 'REPAYMENT', ?, ?, 'CRJ')`,
      [req.user.companyId, loan_id, loan.borrower_id, amount, reference || `PAY-${Date.now()}`, newBalance]
    );

    // Instant SMS Notification of Outstanding Balance
    const smsMessage = `Payment Received! Dear ${loan.first_name}, thank you for your payment of R${amount}. Your remaining loan balance is R${newBalance.toFixed(2)}.`;
    await sendMTNSMS(loan.phone, smsMessage, req.user.companyId, 'PAYMENT_RECEIPT');

    res.json({ message: 'Payment recorded and instant SMS balance notification dispatched.', remaining_balance: newBalance });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ROUTE 7: CUSTOM FORM SCHEMA & HTML EXPORT FOR INDEXING
// ==========================================
app.post('/api/company/custom-form', authenticateToken, async (req, res) => {
  try {
    const { form_json_schema } = req.body;
    await pool.query(`UPDATE companies SET custom_form_json = ? WHERE id = ?`, [JSON.stringify(form_json_schema), req.user.companyId]);
    res.json({ message: 'Custom dynamic form saved successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate & Download HTML File for Google SEO Indexing
app.get('/api/company/export-seo-html', authenticateToken, async (req, res) => {
  try {
    const [companies] = await pool.query(`SELECT company_name, company_slug, email, phone, address FROM companies WHERE id = ?`, [req.user.companyId]);
    const comp = companies[0];

    const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${comp.company_name} - Fast Online Loans Application</title>
    <meta name="description" content="Apply online for loans with ${comp.company_name}. Fast approval, flexible terms, transparent rates.">
</head>
<body>
    <h1>${comp.company_name} Online Credit Application</h1>
    <p>Apply for personal and business credit quickly and safely online.</p>
    <div>
        <h3>Contact Us</h3>
        <p>Email: ${comp.email}</p>
        <p>Phone: ${comp.phone}</p>
        <p>Address: ${comp.address}</p>
    </div>
    <a href="${process.env.BASE_URL}/apply/${comp.company_slug}" style="padding:10px 20px; background:#10B981; color:#fff; text-decoration:none;">Apply Now</a>
</body>
</html>`;

    const fileName = `loan_application_${comp.company_slug}.html`;
    const filePath = path.join(uploadDir, fileName);
    fs.writeFileSync(filePath, htmlContent);

    res.download(filePath, fileName);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ROUTE 8: PDF FORM GENERATION & SIGNING
// ==========================================
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

    // PDF Content Construction
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
    doc.text('Client Initials: [ _______ ]');

    doc.end();

    stream.on('finish', () => {
      res.download(pdfPath);
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ROUTE 9: WHATSAPP QR & MANUAL MESSAGING
// ==========================================
app.get('/api/whatsapp/qr', authenticateToken, async (req, res) => {
  const qr = waQrCodes.get(req.user.companyId);
  if (!qr) return res.status(404).json({ message: 'WhatsApp session active or initializing QR...' });
  res.json({ qr_code: qr });
});

app.post('/api/whatsapp/connect', authenticateToken, async (req, res) => {
  initWhatsAppForCompany(req.user.companyId);
  res.json({ message: 'WhatsApp instance initialization started. Fetch QR code.' });
});

// Start Node.js Express Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`L3 Technologies Loan SaaS Backend Server active on port ${PORT}`);
});