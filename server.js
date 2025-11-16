// Express server for GPureMail backend
// Deploy to Render.com

import express from 'express';
import cors from 'cors';
import imaps from 'imap-simple';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';

const app = express();
const PORT = process.env.PORT || 3000;

const IMAP_HOST = 'imap.purelymail.com';
const IMAP_PORT = 993;
const SMTP_HOST = 'smtp.purelymail.com';
const SMTP_PORT = 587;

app.use(cors({
  origin: 'https://gpuremail.pages.dev'
}));
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'GPureMail API running' });
});

// Verify login
app.post('/api/auth/verify', async (req, res) => {
  const { email, password } = req.body;
  
  try {
    const connection = await imaps.connect({
      imap: {
        user: email,
        password: password,
        host: IMAP_HOST,
        port: IMAP_PORT,
        tls: true,
        tlsOptions: { rejectUnauthorized: false }
      }
    });

    await connection.openBox('INBOX');
    await connection.end();

    res.json({ success: true });
  } catch (error) {
    res.status(401).json({ 
      success: false, 
      error: 'Authentication failed'
    });
  }
});

// Fetch emails
app.post('/api/emails', async (req, res) => {
  const { email, password } = req.body;

  try {
    const connection = await imaps.connect({
      imap: {
        user: email,
        password: password,
        host: IMAP_HOST,
        port: IMAP_PORT,
        tls: true,
        tlsOptions: { rejectUnauthorized: false }
      }
    });

    await connection.openBox('INBOX');

    const searchCriteria = ['ALL'];
    const fetchOptions = {
      bodies: ['HEADER', 'TEXT'],
      struct: true
    };

    const messages = await connection.search(searchCriteria, fetchOptions);
    
    const emails = await Promise.all(messages.slice(-50).reverse().map(async (item) => {
      const header = item.parts.find(part => part.which === 'HEADER');
      const body = item.parts.find(part => part.which === 'TEXT');
      
      const parsed = await simpleParser(header.body);
      const bodyParsed = await simpleParser(body?.body || '');

      return {
        id: item.attributes.uid,
        from: parsed.from?.text || 'Unknown',
        email: parsed.from?.value?.[0]?.address || '',
        subject: parsed.subject || '(no subject)',
        preview: bodyParsed.text?.substring(0, 100) || '',
        body: bodyParsed.text || bodyParsed.html || '',
        time: formatDate(parsed.date),
        unread: !item.attributes.flags.includes('\\Seen'),
        starred: item.attributes.flags.includes('\\Flagged')
      };
    }));

    await connection.end();

    res.json({ emails });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send email
app.post('/api/emails/send', async (req, res) => {
  const { email, password, to, subject, body } = req.body;

  try {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: false,
      auth: {
        user: email,
        pass: password
      }
    });

    await transporter.sendMail({
      from: email,
      to,
      subject,
      text: body
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function formatDate(date) {
  if (!date) return '';
  const now = new Date();
  const emailDate = new Date(date);
  const diffMs = now - emailDate;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return emailDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  } else if (diffDays === 1) {
    return 'Yesterday';
  } else if (diffDays < 7) {
    return emailDate.toLocaleDateString('en-US', { weekday: 'short' });
  } else {
    return emailDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
}

app.listen(PORT, () => {
  console.log(`GPureMail API running on port ${PORT}`);
});
