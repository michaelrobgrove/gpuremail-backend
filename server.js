import express from "express";
import cors from "cors";
import imaps from "imap-simple";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({ status: "GPureMail API running" });
});

async function imapConnect(email, password) {
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
  const { email, password } = req.body;
  try {
    const conn = await imapConnect(email, password);
    await conn.openBox("INBOX");
    await conn.end();
    res.json({ success: true });
  } catch (err) {
    console.error("Login error:", err);
    res.status(401).json({ success: false, error: "Invalid credentials" });
  }
});

// GET FOLDERS
app.get("/api/folders", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];

  try {
    const conn = await imapConnect(email, password);
    const boxes = await conn.getBoxes();
    await conn.end();
    
    const folders = Object.keys(boxes).map(name => ({
      name,
      delimiter: boxes[name].delimiter || '/'
    }));
    
    res.json({ folders });
  } catch (err) {
    console.error("Folders error:", err);
    res.status(500).json({ error: "Failed to fetch folders" });
  }
});

// GET EMAILS
app.post("/api/emails", async (req, res) => {
  const { email, password, folder } = req.body;
  const boxName = folder || "INBOX";

  try {
    const conn = await imapConnect(email, password);
    await conn.openBox(boxName);

    const messages = await conn.search(["ALL"], {
      bodies: ["HEADER", "TEXT", ""],
      markSeen: false,
      struct: true,
    });

    const parsedEmails = [];

    for (let msg of messages) {
      const uid = msg.attributes.uid;
      const unread = !msg.attributes.flags.includes("\\Seen");
      const starred = msg.attributes.flags.includes("\\Flagged");
      
      const bodyPart = msg.parts.find((p) => p.which === "");
      if (!bodyPart) continue;

      let parsed;
      try {
        parsed = await simpleParser(bodyPart.body);
      } catch (err) {
        console.error("Parser error:", err);
        continue;
      }

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
        preview: parsed.text?.substring(0, 120) || "",
        bodyText: parsed.text || "",
        bodyHTML: parsed.html || "",
      });
    }

    await conn.end();
    parsedEmails.sort((a, b) => b.timestamp - a.timestamp);
    res.json(parsedEmails);
  } catch (err) {
    console.error("Fetch error:", err);
    res.status(500).json({ error: "Failed to fetch emails" });
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
    console.error("Mark-read error:", err);
    res.status(500).json({ success: false });
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
    console.error("Star error:", err);
    res.status(500).json({ success: false });
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
    
    // Move to Spam/Junk folder if it exists
    try {
      await conn.moveMessage(uid, "Spam");
    } catch {
      try {
        await conn.moveMessage(uid, "Junk");
      } catch {
        // If no spam folder, just delete
        await conn.addFlags(uid, ["\\Deleted"]);
        await conn.imap.expunge();
      }
    }
    
    await conn.end();
    res.json({ success: true });
  } catch (err) {
    console.error("Spam error:", err);
    res.status(500).json({ success: false });
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
    console.error("Delete error:", err);
    res.status(500).json({ success: false });
  }
});

// SEND EMAIL
app.post("/api/emails/send", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];
  const { to, subject, body } = req.body;

  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.purelymail.com",
      port: 587,
      secure: false,
      auth: { user: email, pass: password },
    });

    await transporter.sendMail({
      from: email,
      to,
      subject,
      text: body,
      html: body.replace(/\n/g, "<br>"),
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Send error:", err);
    res.status(500).json({ error: "Failed to send email" });
  }
});

app.listen(PORT, () => {
  console.log(`GPureMail backend running on port ${PORT}`);
});
