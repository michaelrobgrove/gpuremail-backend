import express from "express";
import cors from "cors";
import Imap from "imap";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { promisify } from "util";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "GPureMail API running", timestamp: new Date().toISOString() });
});

// Helper to create IMAP connection
function createImapConnection(email, password) {
  return new Imap({
    user: email,
    password,
    host: "imap.purelymail.com",
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    authTimeout: 15000,
    connTimeout: 15000
  });
}

// Helper to wrap IMAP operations in promises
function connectImap(imap) {
  return new Promise((resolve, reject) => {
    imap.once('ready', () => resolve());
    imap.once('error', reject);
    imap.connect();
  });
}

// LOGIN
app.post("/api/login", async (req, res) => {
  console.log("Login attempt:", req.body.email);
  const { email, password } = req.body;
  
  const imap = createImapConnection(email, password);
  
  try {
    await connectImap(imap);
    imap.end();
    console.log("Login success:", email);
    res.json({ success: true });
  } catch (err) {
    console.error("Login error:", err.message);
    imap.end();
    res.status(401).json({ success: false, error: err.message });
  }
});

// GET FOLDERS
app.get("/api/folders", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];
  
  console.log("Fetching folders for:", email);
  
  const imap = createImapConnection(email, password);

  try {
    await connectImap(imap);
    
    const getBoxes = promisify(imap.getBoxes.bind(imap));
    const boxes = await getBoxes();
    
    const folders = Object.keys(boxes).map(name => ({
      name,
      delimiter: boxes[name].delimiter || '/'
    }));
    
    imap.end();
    console.log("Folders fetched:", folders.length);
    res.json({ folders });
  } catch (err) {
    console.error("Folders error:", err.message);
    imap.end();
    res.status(500).json({ error: err.message });
  }
});

// GET EMAILS - WITH PAGINATION
app.post("/api/emails", async (req, res) => {
  const { email, password, folder, page = 1, unreadOnly = false } = req.body;
  const boxName = folder || "INBOX";
  const pageSize = 25;
  
  console.log(`Fetching emails for ${email} from ${boxName} (page ${page}, unreadOnly: ${unreadOnly})...`);

  const imap = createImapConnection(email, password);

  try {
    await connectImap(imap);
    
    const openBox = promisify(imap.openBox.bind(imap));
    const box = await openBox(boxName, true); // true = read-only
    
    const searchCriteria = unreadOnly ? ['UNSEEN'] : ['ALL'];
    
    const search = promisify(imap.search.bind(imap));
    const uids = await search(searchCriteria);
    
    const totalMessages = uids.length;
    console.log(`Found ${totalMessages} messages`);
    
    if (totalMessages === 0) {
      imap.end();
      return res.json({
        emails: [],
        pagination: { page: 1, pageSize, totalMessages: 0, totalPages: 0, hasMore: false }
      });
    }
    
    // Calculate pagination
    const totalPages = Math.ceil(totalMessages / pageSize);
    const startIdx = Math.max(0, totalMessages - (page * pageSize));
    const endIdx = totalMessages - ((page - 1) * pageSize);
    
    // Get UIDs for this page (newest first)
    const pageUids = uids.slice(startIdx, endIdx).reverse();
    console.log(`Fetching ${pageUids.length} messages for page ${page}`);
    
    const emails = await new Promise((resolve, reject) => {
      const results = [];
      const fetch = imap.fetch(pageUids, {
        bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)'],
        struct: true
      });
      
      fetch.on('message', (msg, seqno) => {
        let uid, flags, headers = '';
        
        msg.on('body', (stream) => {
          stream.on('data', (chunk) => {
            headers += chunk.toString('utf8');
          });
        });
        
        msg.once('attributes', (attrs) => {
          uid = attrs.uid;
          flags = attrs.flags || [];
        });
        
        msg.once('end', async () => {
          try {
            const parsed = await simpleParser(headers);
            results.push({
              id: uid,
              subject: parsed.subject || "(No subject)",
              from: parsed.from?.value?.[0]?.name || parsed.from?.text || "Unknown",
              fromAddress: parsed.from?.value?.[0]?.address || "",
              to: parsed.to?.text || "",
              date: parsed.date || null,
              timestamp: parsed.date ? parsed.date.getTime() : Date.now(),
              unread: !flags.includes('\\Seen'),
              starred: flags.includes('\\Flagged'),
              preview: "(Click to load)",
              bodyText: null,
              bodyHTML: null,
            });
          } catch (err) {
            console.error('Parse error:', err.message);
          }
        });
      });
      
      fetch.once('error', reject);
      fetch.once('end', () => resolve(results));
    });
    
    imap.end();
    console.log(`Returning ${emails.length} emails`);
    
    res.json({
      emails,
      pagination: {
        page,
        pageSize,
        totalMessages,
        totalPages,
        hasMore: page < totalPages
      }
    });
  } catch (err) {
    console.error("Fetch error:", err.message);
    try { imap.end(); } catch (e) {}
    res.status(500).json({ error: err.message });
  }
});

// GET SINGLE EMAIL BODY
app.get("/api/emails/:uid", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];
  const { uid } = req.params;
  const folder = req.query.folder || "INBOX";

  console.log(`Fetching body for email ${uid}`);

  const imap = createImapConnection(email, password);

  try {
    await connectImap(imap);
    
    const openBox = promisify(imap.openBox.bind(imap));
    await openBox(folder, true);
    
    const emailData = await new Promise((resolve, reject) => {
      const fetch = imap.fetch([uid], {
        bodies: [''],
        struct: true
      });
      
      let buffer = Buffer.alloc(0);
      
      fetch.on('message', (msg) => {
        msg.on('body', (stream) => {
          stream.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
          });
        });
        
        msg.once('end', async () => {
          try {
            const parsed = await simpleParser(buffer);
            resolve({
              bodyText: parsed.text || "",
              bodyHTML: parsed.html || "",
              preview: (parsed.text || "").substring(0, 150).replace(/\n/g, " ")
            });
          } catch (err) {
            reject(err);
          }
        });
      });
      
      fetch.once('error', reject);
      fetch.once('end', () => {
        if (!buffer.length) {
          reject(new Error('No email data received'));
        }
      });
    });
    
    imap.end();
    res.json(emailData);
  } catch (err) {
    console.error("Fetch email body error:", err.message);
    try { imap.end(); } catch (e) {}
    res.status(500).json({ error: err.message });
  }
});

// MARK AS READ
app.post("/api/emails/mark-read", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];
  const { uid, folder } = req.body;

  const imap = createImapConnection(email, password);

  try {
    await connectImap(imap);
    const openBox = promisify(imap.openBox.bind(imap));
    await openBox(folder || "INBOX", false);
    
    const addFlags = promisify(imap.addFlags.bind(imap));
    await addFlags(uid, '\\Seen');
    
    imap.end();
    res.json({ success: true });
  } catch (err) {
    console.error("Mark-read error:", err.message);
    try { imap.end(); } catch (e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});

// MARK AS STARRED
app.post("/api/emails/star", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];
  const { uid, starred, folder } = req.body;

  const imap = createImapConnection(email, password);

  try {
    await connectImap(imap);
    const openBox = promisify(imap.openBox.bind(imap));
    await openBox(folder || "INBOX", false);
    
    if (starred) {
      const addFlags = promisify(imap.addFlags.bind(imap));
      await addFlags(uid, '\\Flagged');
    } else {
      const delFlags = promisify(imap.delFlags.bind(imap));
      await delFlags(uid, '\\Flagged');
    }
    
    imap.end();
    res.json({ success: true });
  } catch (err) {
    console.error("Star error:", err.message);
    try { imap.end(); } catch (e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE EMAIL
app.delete("/api/emails/delete/:uid", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];
  const uid = req.params.uid;
  const folder = req.query.folder || "INBOX";

  const imap = createImapConnection(email, password);

  try {
    await connectImap(imap);
    const openBox = promisify(imap.openBox.bind(imap));
    await openBox(folder, false);
    
    const addFlags = promisify(imap.addFlags.bind(imap));
    await addFlags(uid, '\\Deleted');
    
    const expunge = promisify(imap.expunge.bind(imap));
    await expunge();
    
    imap.end();
    res.json({ success: true });
  } catch (err) {
    console.error("Delete error:", err.message);
    try { imap.end(); } catch (e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});

// SEND EMAIL
app.post("/api/emails/send", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];
  const { to, subject, body, priority, requestReceipt } = req.body;
  
  console.log(`Sending email from ${email} to ${to}`);

  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.purelymail.com",
      port: 587,
      secure: false,
      auth: { user: email, pass: password },
    });

    const mailOptions = {
      from: email,
      to,
      subject,
      text: body,
      html: body.replace(/\n/g, "<br>"),
    };
    
    if (priority === 'high') {
      mailOptions.priority = 'high';
      mailOptions.headers = { 'X-Priority': '1', 'Importance': 'high' };
    }
    
    if (requestReceipt) {
      mailOptions.headers = mailOptions.headers || {};
      mailOptions.headers['Disposition-Notification-To'] = email;
    }

    await transporter.sendMail(mailOptions);
    console.log("Email sent successfully");
    res.json({ success: true });
  } catch (err) {
    console.error("Send error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Global error handler
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

app.listen(PORT, () => {
  console.log(`GPureMail backend running on port ${PORT}`);
});
