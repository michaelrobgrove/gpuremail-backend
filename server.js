// GPureMail Backend – PurelyMail IMAP/SMTP Proxy
// Fully stateless, supports unlimited simultaneous logins

import express from "express";
import cors from "cors";
import imaps from "imap-simple";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json()); // IMPORTANT – required for /send route

// ------------------------------------------------------------
// Check Login – verifies IMAP credentials
// ------------------------------------------------------------
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const config = {
      imap: {
        user: email,
        password: password,
        host: "imap.purelymail.com",
        port: 993,
        tls: true,
        authTimeout: 5000,
      },
    };

    const connection = await imaps.connect(config);
    await connection.end();

    return res.json({ success: true });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(401).json({ success: false, error: "Invalid credentials" });
  }
});

// ------------------------------------------------------------
// Fetch Emails – lists inbox
// ------------------------------------------------------------
app.get("/api/emails", async (req, res) => {
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];

  if (!email || !password) {
    return res.status(400).json({ error: "Missing credentials" });
  }

  try {
    const config = {
      imap: {
        user: email,
        password: password,
        host: "imap.purelymail.com",
        port: 993,
        tls: true,
        authTimeout: 5000,
      },
    };

    const connection = await imaps.connect(config);
    await connection.openBox("INBOX");

    const searchCriteria = ["ALL"];
    const fetchOptions = {
      bodies: ["HEADER", "TEXT"],
      struct: true,
    };

    const results = await connection.search(searchCriteria, fetchOptions);

    const emails = await Promise.all(
      results.map(async (item) => {
        const all = item.parts.find((p) => p.which === "HEADER");
        const parsed = imaps.getParts(item);

        return {
          id: item.attributes.uid,
          subject: all.subject ? all.subject[0] : "(No Subject)",
          from: all.from ? all.from[0] : "(Unknown Sender)",
          date: all.date ? all.date[0] : null,
        };
      })
    );

    await connection.end();

    return res.json(emails.reverse()); // newest first
  } catch (err) {
    console.error("Email fetch error:", err);
    return res.status(500).json({ error: "Failed to fetch emails" });
  }
});

// ------------------------------------------------------------
// Send Email – SMTP
// ------------------------------------------------------------
app.post("/api/emails/send", async (req, res) => {
  const { to, subject, body } = req.body;
  const email = req.headers["x-email"];
  const password = req.headers["x-password"];

  if (!email || !password) {
    return res.status(400).json({ error: "Missing credentials" });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.purelymail.com",
      port: 587,
      secure: false,
      auth: {
        user: email,
        pass: password,
      },
    });

    await transporter.sendMail({
      from: email,
      to,
      subject,
      text: body,
      html: `<pre style="font-family: sans-serif">${body}</pre>`,
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Send error:", err);
    return res.status(500).json({ error: "Failed to send email" });
  }
});

// ------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`GPureMail API running on port ${PORT}`);
});
