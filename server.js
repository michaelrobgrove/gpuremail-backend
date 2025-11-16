import express from "express";
import cors from "cors";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "Voyage API running", timestamp: new Date().toISOString() });
});

const createImapClient = (email, password) => {
  return new ImapFlow({
    host: "imap.purelymail.com",
    port: 993,
    secure: true,
    auth: { user: email, pass: password },
    logger: false
  });
};

app.post("/api/login", async (req, res) => {
  console.log("Login attempt:", req.body.email);
  const { email, password } = req.body;
  const client = createImapClient(email, password);
  
  try {
    await client.connect();
    await client.logout();
    console.log("Login success:", email);
    res.json({ success: true });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(401).json({ success: false, error: err.message });
  }
});

app.get("/api/folders", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];
  const client = createImapClient(email, password);
  
  try {
    await client.connect();
    const list = await client.list();
    const folders = list.map(box => ({ name: box.path, delimiter: box.delimiter }));
    await client.logout();
    res.json({ folders });
  } catch (err) {
    console.error("Folders error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/emails", async (req, res) => {
  const { email, password, folder, page = 1, pageSize = 25, unreadOnly = false } = req.body;
  const boxName = folder || "INBOX";
  
  console.log(`Fetching emails: ${email}, folder: ${boxName}, page: ${page}, unreadOnly: ${unreadOnly}`);
  const client = createImapClient(email, password);
  
  try {
    await client.connect();
    const lock = await client.getMailboxLock(boxName);
    
    try {
      const status = await client.status(boxName, { messages: true });
      console.log(`Box opened. Total: ${status.messages}`);
      
      if (status.messages === 0) {
        lock.release();
        await client.logout();
        return res.json({
          emails: [],
          pagination: { page: 1, pageSize, totalMessages: 0, totalPages: 0, hasMore: false }
        });
      }
      
      const searchCriteria = unreadOnly ? { seen: false } : { all: true };
      const uids = await client.search(searchCriteria);
      console.log(`Found ${uids.length} UIDs`);
      
      const totalMessages = uids.length;
      const totalPages = Math.ceil(totalMessages / pageSize);
      
      const startIdx = Math.max(0, totalMessages - (page * pageSize));
      const endIdx = totalMessages - ((page - 1) * pageSize);
      const pageUids = uids.slice(startIdx, endIdx).reverse();
      
      console.log(`Fetching ${pageUids.length} messages`);
      
      const emails = [];
      
      for (const uid of pageUids) {
        try {
          const message = await client.fetchOne(uid, { 
            envelope: true, 
            flags: true,
            bodyStructure: true,
            source: true
          });
          
          const parsed = await simpleParser(message.source);
          
          const preview = (parsed.text || '')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 150);
          
          emails.push({
            id: uid,
            subject: message.envelope.subject || "(No subject)",
            from: message.envelope.from?.[0]?.name || message.envelope.from?.[0]?.address || "Unknown",
            fromAddress: message.envelope.from?.[0]?.address || "",
            to: message.envelope.to?.map(t => t.address).join(', ') || "",
            date: message.envelope.date || new Date(),
            timestamp: message.envelope.date ? message.envelope.date.getTime() : Date.now(),
            unread: !message.flags.has('\\Seen'),
            starred: message.flags.has('\\Flagged'),
            preview: preview || "(No preview)"
          });
        } catch (err) {
          console.error(`Error fetching UID ${uid}:`, err.message);
        }
      }
      
      console.log(`Successfully fetched ${emails.length} emails`);
      
      lock.release();
      await client.logout();
      
      res.json({
        emails,
        pagination: { page, pageSize, totalMessages, totalPages, hasMore: page < totalPages }
      });
    } catch (err) {
      lock.release();
      throw err;
    }
  } catch (err) {
    console.error("Fetch error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/emails/:uid", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];
  const { uid } = req.params;
  const folder = req.query.folder || "INBOX";
  const client = createImapClient(email, password);
  
  try {
    await client.connect();
    const lock = await client.getMailboxLock(folder);
    
    try {
      const message = await client.fetchOne(uid, { source: true });
      const parsed = await simpleParser(message.source);
      
      lock.release();
      await client.logout();
      
      res.json({
        bodyText: parsed.text || "",
        bodyHTML: parsed.html || "",
        preview: (parsed.text || "").substring(0, 150).replace(/\n/g, " ")
      });
    } catch (err) {
      lock.release();
      throw err;
    }
  } catch (err) {
    console.error("Body fetch error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/emails/mark-read", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];
  const { uid, folder } = req.body;
  const client = createImapClient(email, password);
  
  try {
    await client.connect();
    const lock = await client.getMailboxLock(folder || "INBOX");
    
    try {
      await client.messageFlagsAdd(uid, ['\\Seen']);
      lock.release();
      await client.logout();
      res.json({ success: true });
    } catch (err) {
      lock.release();
      throw err;
    }
  } catch (err) {
    console.error("Mark-read error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/emails/star", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];
  const { uid, starred, folder } = req.body;
  const client = createImapClient(email, password);
  
  try {
    await client.connect();
    const lock = await client.getMailboxLock(folder || "INBOX");
    
    try {
      if (starred) {
        await client.messageFlagsAdd(uid, ['\\Flagged']);
      } else {
        await client.messageFlagsRemove(uid, ['\\Flagged']);
      }
      lock.release();
      await client.logout();
      res.json({ success: true });
    } catch (err) {
      lock.release();
      throw err;
    }
  } catch (err) {
    console.error("Star error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/emails/delete/:uid", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];
  const uid = req.params.uid;
  const folder = req.query.folder || "INBOX";
  const client = createImapClient(email, password);
  
  try {
    await client.connect();
    const lock = await client.getMailboxLock(folder);
    
    try {
      await client.messageFlagsAdd(uid, ['\\Deleted']);
      await client.expunge();
      lock.release();
      await client.logout();
      res.json({ success: true });
    } catch (err) {
      lock.release();
      throw err;
    }
  } catch (err) {
    console.error("Delete error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/emails/send", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];
  const { to, subject, body } = req.body;
  
  console.log(`Sending email from ${email} to ${to}`);
  
  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.purelymail.com",
      port: 587,
      secure: false,
      auth: { user: email, pass: password },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
    
    await transporter.sendMail({
      from: email,
      to,
      subject,
      text: body,
      html: body.replace(/\n/g, "<br>"),
    });
    
    console.log(`Email sent successfully to ${to}`);
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
  console.log(`Voyage backend running on port ${PORT}`);
});