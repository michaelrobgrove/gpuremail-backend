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

function createImapConnection(email, password) {
  return new Imap({
    user: email,
    password,
    host: "imap.purelymail.com",
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    authTimeout: 10000,
    connTimeout: 10000,
    keepalive: false
  });
}

function connectImap(imap, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      imap.destroy();
      reject(new Error('Connection timeout'));
    }, timeoutMs);

    imap.once('ready', () => {
      clearTimeout(timeout);
      resolve();
    });
    
    imap.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    
    imap.connect();
  });
}

// LOGIN
app.post("/api/login", async (req, res) => {
  console.log("Login attempt:", req.body.email);
  const { email, password } = req.body;
  const imap = createImapConnection(email, password);
  
  try {
    await connectImap(imap, 10000);
    imap.end();
    console.log("Login success:", email);
    res.json({ success: true });
  } catch (err) {
    console.error("Login error:", err.message);
    try { imap.destroy(); } catch (e) {}
    res.status(401).json({ success: false, error: err.message });
  }
});

// GET FOLDERS
app.get("/api/folders", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];
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
    res.json({ folders });
  } catch (err) {
    console.error("Folders error:", err.message);
    try { imap.destroy(); } catch (e) {}
    res.status(500).json({ error: err.message });
  }
});

// GET EMAILS
app.post("/api/emails", async (req, res) => {
  const { email, password, folder, page = 1, pageSize = 50, unreadOnly = false } = req.body;
  const boxName = folder || "INBOX";
  
  console.log(`Fetching emails: ${email}, folder: ${boxName}, page: ${page}, unreadOnly: ${unreadOnly}`);
  const imap = createImapConnection(email, password);

  try {
    await connectImap(imap);
    
    const openBox = promisify(imap.openBox.bind(imap));
    const box = await openBox(boxName, true);
    console.log(`Box opened. Total: ${box.messages.total}`);
    
    if (box.messages.total === 0) {
      imap.end();
      return res.json({
        emails: [],
        pagination: { page: 1, pageSize, totalMessages: 0, totalPages: 0, hasMore: false }
      });
    }
    
    const search = promisify(imap.search.bind(imap));
    const searchCriteria = unreadOnly ? ['UNSEEN'] : ['ALL'];
    const uids = await search(searchCriteria);
    console.log(`Found ${uids.length} UIDs`);
    
    const totalMessages = uids.length;
    const totalPages = Math.ceil(totalMessages / pageSize);
    
    // Get newest emails first - take last N emails and reverse
    const startIdx = Math.max(0, totalMessages - (page * pageSize));
    const endIdx = totalMessages - ((page - 1) * pageSize);
    const pageUids = uids.slice(startIdx, endIdx).reverse();
    
    console.log(`Fetching ${pageUids.length} messages (newest first)`);
    
    const emails = await new Promise((resolve, reject) => {
      const results = [];
      const fetchTimeout = setTimeout(() => {
        reject(new Error('Fetch timeout'));
      }, 25000);
      
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
              preview: "(Click to load)"
            });
          } catch (err) {
            console.error('Parse error:', err.message);
          }
        });
      });
      
      fetch.once('error', (err) => {
        clearTimeout(fetchTimeout);
        reject(err);
      });
      
      fetch.once('end', () => {
        clearTimeout(fetchTimeout);
        // Sort by timestamp descending (newest first)
        results.sort((a, b) => b.timestamp - a.timestamp);
        console.log(`Fetch done: ${results.length} emails`);
        resolve(results);
      });
    });
    
    imap.end();
    
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
    try { imap.destroy(); } catch (e) {}
    res.status(500).json({ error: err.message });
  }
});

// GET EMAIL BODY
app.get("/api/emails/:uid", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];
  const { uid } = req.params;
  const folder = req.query.folder || "INBOX";
  const imap = createImapConnection(email, password);

  try {
    await connectImap(imap);
    const openBox = promisify(imap.openBox.bind(imap));
    await openBox(folder, true);
    
    const emailData = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Body fetch timeout')), 20000);
      
      const fetch = imap.fetch([uid], { bodies: [''], struct: true });
      let buffer = Buffer.alloc(0);
      
      fetch.on('message', (msg) => {
        msg.on('body', (stream) => {
          stream.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
          });
        });
        
        msg.once('end', async () => {
          clearTimeout(timeout);
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
      
      fetch.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    
    imap.end();
    res.json(emailData);
  } catch (err) {
    console.error("Body fetch error:", err.message);
    try { imap.destroy(); } catch (e) {}
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
    try { imap.destroy(); } catch (e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});

// STAR
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
    try { imap.destroy(); } catch (e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE
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
    try { imap.destroy(); } catch (e) {}
    res.status(500).json({ success: false, error: err.message });
  }
});

// SEND
app.post("/api/emails/send", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];
  const { to, subject, body, priority, requestReceipt } = req.body;

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
    res.json({ success: true });
  } catch (err) {
    console.error("Send error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

app.listen(PORT, () => {
  console.log(`GPureMail backend running on port ${PORT}`);
});
