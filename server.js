import express from "express";
import cors from "cors";
import imaps from "imap-simple";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// -------------------------------------------------------
// Create IMAP connection
// -------------------------------------------------------
async function imapConnect(email, password) {
  return await imaps.connect({
    imap: {
      user: email,
      password,
      host: "imap.purelymail.com",
      port: 993,
      tls: true,
      authTimeout: 8000,
    },
  });
}

// -------------------------------------------------------
// LOGIN
// -------------------------------------------------------
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const conn = await imapConnect(email, password);
    await conn.end();
    return res.json({ success: true });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(401).json({ success: false, error: "Invalid login" });
  }
});

// -------------------------------------------------------
// GET EMAILS (FULL PARSE)
// -------------------------------------------------------
app.get("/api/emails", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];

  if (!email || !password)
    return res.status(400).json({ error: "Missing credentials" });

  try {
    const conn = await imapConnect(email, password);
    await conn.openBox("INBOX");

    const searchCriteria = ["ALL"];
    const fetchOptions = {
      bodies: ["HEADER", "TEXT", ""],
      markSeen: false,
      struct: true,
    };

    const messages = await conn.search(searchCriteria, fetchOptions);

    const parsedEmails = [];

    for (let msg of messages) {
      const uid = msg.attributes.uid;

      // Detect unread
      const unread = msg.attributes.flags.includes("\\Seen") ? false : true;

      const allBodies = msg.parts.filter((p) => p.which !== undefined);
      const bodyPart = msg.parts.find((p) => p.which === "");

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
        preview: parsed.text?.substring(0, 120) || "",
        bodyText: parsed.text || "",
        bodyHTML: parsed.html || "",
        starred: false, // Optional future enhancement
      });
    }

    await conn.end();

    // Sort newest → oldest
    parsedEmails.sort((a, b) => b.timestamp - a.timestamp);

    return res.json(parsedEmails);
  } catch (err) {
    console.error("Fetch error:", err);
    return res.status(500).json({ error: "Failed to fetch inbox" });
  }
});

// -------------------------------------------------------
// MARK EMAIL AS READ
// -------------------------------------------------------
app.post("/api/emails/mark-read", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];
  const { uid } = req.body;

  try {
    const conn = await imapConnect(email, password);
    await conn.openBox("INBOX");
    await conn.addFlags(uid, ["\\Seen"]);
    await conn.end();
    return res.json({ success: true });
  } catch (err) {
    console.error("Mark-read error:", err);
    return res.status(500).json({ success: false });
  }
});

// -------------------------------------------------------
// DELETE EMAIL (MOVE TO TRASH or HARD DELETE)
// -------------------------------------------------------
app.delete("/api/emails/delete/:uid", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];
  const uid = req.params.uid;

  try {
    const conn = await imapConnect(email, password);
    await conn.openBox("INBOX");

    // Mark as deleted
    await conn.addFlags(uid, ["\\Deleted"]);

    // Expunge
    await conn.imap.expunge();

    await conn.end();

    return res.json({ success: true });
  } catch (err) {
    console.error("Delete error:", err);
    return res.status(500).json({ success: false });
  }
});

// -------------------------------------------------------
// SEND EMAIL (SMTP)
// -------------------------------------------------------
app.post("/api/emails/send", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];
  const { to, subject, body } = req.body;

  if (!email || !password)
    return res.status(400).json({ error: "Missing credentials" });

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

    return res.json({ success: true });
  } catch (err) {
    console.error("Send error:", err);
    return res.status(500).json({ error: "Failed to send email" });
  }
});

// -------------------------------------------------------
app.listen(PORT, () => {
  console.log(`GPureMail backend running on port ${PORT}`);
});
