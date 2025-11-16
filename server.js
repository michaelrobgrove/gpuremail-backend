import express from "express";
import cors from "cors";
import imaps from "imap-simple";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "GPureMail API running", timestamp: new Date().toISOString() });
});

async function imapConnect(email, password) {
  console.log(`Connecting to IMAP for ${email}...`);
  return await imaps.connect({
    imap: {
      user: email,
      password,
      host: "imap.purelymail.com",
      port: 993,
      tls: true,
      authTimeout: 10000,
      tlsOptions: { rejectUnauthorized: false }
    },
  });
}

// LOGIN
app.post("/api/login", async (req, res) => {
  console.log("Login attempt:", req.body.email);
  const { email, password } = req.body;
  
  try {
    const conn = await imapConnect(email, password);
    await conn.openBox("INBOX");
    await conn.end();
    console.log("Login success:", email);
    res.json({ success: true });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(401).json({ success: false, error: err.message });
  }
});

// GET FOLDERS
app.get("/api/folders", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];
  
  console.log("Fetching folders for:", email);

  try {
    const conn = await imapConnect(email, password);
    const boxes = await conn.getBoxes();
    await conn.end();
    
    const folders = Object.keys(boxes).map(name => ({
      name,
      delimiter: boxes[name].delimiter || '/'
    }));
    
    console.log("Folders fetched:", folders.length);
    res.json({ folders });
  } catch (err) {
    console.error("Folders error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET EMAILS - WITH PAGINATION
app.post("/api/emails", async (req, res) => {
  const { email, password, folder, page = 1, unreadOnly = false } = req.body;
  const boxName = folder || "INBOX";
  const pageSize = 25;
  
  console.log(`Fetching emails for ${email} from ${boxName} (page ${page}, unreadOnly: ${unreadOnly})...`);

  try {
    const conn = await imapConnect(email, password);
    await conn.openBox(boxName);

    // Search criteria
    const searchCriteria = unreadOnly ? ['UNSEEN'] : ['ALL'];
    
    const messages = await conn.search(searchCriteria, {
      bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)'],
      struct: true,
    });

    const totalMessages = messages.length;
    console.log(`Found ${totalMessages} messages`);
    
    // Calculate pagination
    const totalPages = Math.ceil(totalMessages / pageSize);
    const startIdx = Math.max(0, totalMessages - (page * pageSize));
    const endIdx = totalMessages - ((page - 1) * pageSize);
    
    // Get messages for this page (newest first)
    const pageMessages = messages.slice(startIdx, endIdx).reverse();
    console.log(`Fetching ${pageMessages.length} messages for page ${page}`);
    
    const parsedEmails = [];

    for (let msg of pageMessages) {
      try {
        const uid = msg.attributes.uid;
        const unread = !msg.attributes.flags.includes("\\Seen");
        const starred = msg.attributes.flags.includes("\\Flagged");
        
        const headerPart = msg.parts.find((p) => p.which && p.which.includes("HEADER"));
        if (!headerPart) continue;

        const parsed = await simpleParser(headerPart.body);

        parsedEmails.push({
          id: uid,
          subject: parsed.subject || "(No subject)",
          from: parsed.from?.value?.[0]?.name || parsed.from?.text || "Unknown",
          fromAddress: parsed.from?.value?.[0]?.address || "",
          to: parsed.to?.text || "",
          date: parsed.date || null,
          timestamp: parsed.date ? parsed.date.getTime() : Date.now(),
          unread,
          starred,
          preview: "(Click to load)",
          bodyText: null,
          bodyHTML: null,
        });
      } catch (err) {
        console.error("Error parsing message:", err.message);
      }
    }

    await conn.end();
    console.log(`Returning ${parsedEmails.length} emails`);
    
    res.json({
      emails: parsedEmails,
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

  try {
    const conn = await imapConnect(email, password);
    await conn.openBox(folder);

    const messages = await conn.search([['UID', uid]], {
      bodies: ["TEXT", ""],
      struct: true,
    });

    if (messages.length === 0) {
      await conn.end();
      return res.status(404).json({ error: "Email not found" });
    }

    const msg = messages[0];
    
    // Try to get full message body
    let bodyText = "";
    let bodyHTML = "";
    let preview = "";
    
    try {
      const fullPart = msg.parts.find((p) => p.which === "");
      if (fullPart) {
        const parsed = await simpleParser(fullPart.body);
        bodyText = parsed.text || "";
        bodyHTML = parsed.html || "";
        preview = bodyText.substring(0, 150).replace(/\n/g, " ");
      }
    } catch (e) {
      // Fallback to TEXT part only
      const textPart = msg.parts.find((p) => p.which === "TEXT");
      if (textPart) {
        bodyText = textPart.body.toString();
        preview = bodyText.substring(0, 150).replace(/\n/g, " ");
      }
    }

    await conn.end();

    res.json({
      bodyText,
      bodyHTML,
      preview
    });
  } catch (err) {
    console.error("Fetch email body error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// MARK AS READ
app.post("/api/emails/mark-read", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];
  const { uid, folder } = req.body;

  try {
    const conn = await imapConnect(email, password);
    await conn.openBox(folder || "INBOX");
    await conn.addFlags(uid, ["\\Seen"]);
    await conn.end();
    res.json({ success: true });
  } catch (err) {
    console.error("Mark-read error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// MARK AS STARRED
app.post("/api/emails/star", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];
  const { uid, starred, folder } = req.body;

  try {
    const conn = await imapConnect(email, password);
    await conn.openBox(folder || "INBOX");
    
    if (starred) {
      await conn.addFlags(uid, ["\\Flagged"]);
    } else {
      await conn.delFlags(uid, ["\\Flagged"]);
    }
    
    await conn.end();
    res.json({ success: true });
  } catch (err) {
    console.error("Star error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// MARK AS SPAM
app.post("/api/emails/spam", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];
  const { uid } = req.body;

  try {
    const conn = await imapConnect(email, password);
    await conn.openBox("INBOX");
    
    try {
      await conn.moveMessage(uid, "Spam");
    } catch {
      try {
        await conn.moveMessage(uid, "Junk");
      } catch {
        await conn.addFlags(uid, ["\\Deleted"]);
        await conn.imap.expunge();
      }
    }
    
    await conn.end();
    res.json({ success: true });
  } catch (err) {
    console.error("Spam error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE EMAIL
app.delete("/api/emails/delete/:uid", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];
  const uid = req.params.uid;
  const folder = req.query.folder || "INBOX";

  try {
    const conn = await imapConnect(email, password);
    await conn.openBox(folder);
    await conn.addFlags(uid, ["\\Deleted"]);
    await conn.imap.expunge();
    await conn.end();
    res.json({ success: true });
  } catch (err) {
    console.error("Delete error:", err.message);
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

app.listen(PORT, () => {
  console.log(`GPureMail backend running on port ${PORT}`);
});
