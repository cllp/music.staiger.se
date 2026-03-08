/**
 * Sessions — Firebase Cloud Functions
 *
 * Sends email notifications when documents are added to the 'mail' collection.
 * Uses Gmail SMTP with an App Password for sending.
 *
 * SETUP:
 * 1. Enable 2FA on your Gmail account
 * 2. Create an App Password: https://myaccount.google.com/apppasswords
 * 3. Set Firebase config:
 *    firebase functions:config:set mail.user="your-email@gmail.com" mail.pass="your-app-password"
 * 4. Deploy: firebase deploy --only functions
 */

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const nodemailer = require("nodemailer");

initializeApp();
const db = getFirestore();

// Gmail SMTP transport — configured via Firebase environment config
// Set with: firebase functions:config:set mail.user="x" mail.pass="y"
let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const mailUser = process.env.MAIL_USER || "";
  const mailPass = process.env.MAIL_PASS || "";
  if (!mailUser || !mailPass) {
    console.error("Missing MAIL_USER or MAIL_PASS environment variables");
    return null;
  }
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: mailUser, pass: mailPass },
  });
  return transporter;
}

/**
 * Triggered when a new document is added to the 'mail' collection.
 * Document structure:
 * {
 *   to: "recipient@email.com",
 *   message: { subject: "...", html: "..." },
 *   createdAt: Timestamp
 * }
 */
exports.sendEmailNotification = onDocumentCreated(
  {
    document: "mail/{mailId}",
    region: "europe-west1",
    // Set secrets in Google Cloud Secret Manager
    secrets: ["MAIL_USER", "MAIL_PASS"],
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;

    const data = snap.data();
    const { to, message } = data;

    if (!to || !message?.subject) {
      console.warn("Invalid mail document:", snap.id);
      await snap.ref.update({ status: "error", error: "Missing to or subject" });
      return;
    }

    const transport = getTransporter();
    if (!transport) {
      await snap.ref.update({ status: "error", error: "Mail not configured" });
      return;
    }

    try {
      await transport.sendMail({
        from: `"Sessions" <${process.env.MAIL_USER}>`,
        to,
        subject: message.subject,
        html: message.html || "",
      });
      console.log(`Email sent to ${to}: ${message.subject}`);
      await snap.ref.update({ status: "sent", sentAt: new Date() });
    } catch (err) {
      console.error(`Failed to send email to ${to}:`, err);
      await snap.ref.update({ status: "error", error: err.message });
    }
  }
);

/**
 * Alternative: Send email digest — collects unread notifications
 * and sends a summary email (can be triggered on schedule).
 */
exports.sendNotificationDigest = onDocumentCreated(
  {
    document: "digestTrigger/{triggerId}",
    region: "europe-west1",
    secrets: ["MAIL_USER", "MAIL_PASS"],
  },
  async (event) => {
    const transport = getTransporter();
    if (!transport) return;

    // Get all users
    const usersSnap = await db.collection("users").get();
    const users = {};
    usersSnap.forEach(d => { users[d.id] = { id: d.id, ...d.data() }; });

    // Get unread notifications per user
    const notifsSnap = await db.collection("notifications").where("read", "==", false).get();
    const byUser = {};
    notifsSnap.forEach(d => {
      const n = d.data();
      if (!byUser[n.userId]) byUser[n.userId] = [];
      byUser[n.userId].push(n);
    });

    // Send digest email per user
    for (const [userId, notifs] of Object.entries(byUser)) {
      const user = users[userId];
      if (!user?.email || notifs.length === 0) continue;

      const items = notifs.map(n => `<li style="padding:4px 0">${n.message}</li>`).join("");
      try {
        await transport.sendMail({
          from: `"Sessions" <${process.env.MAIL_USER}>`,
          to: user.email,
          subject: `🎵 Sessions — ${notifs.length} nya notiser`,
          html: `<div style="font-family:system-ui;max-width:500px">
            <h2 style="color:#c9a84c">Sessions</h2>
            <p>Hej ${user.name}! Du har ${notifs.length} olästa notiser:</p>
            <ul style="list-style:none;padding:0">${items}</ul>
            <p><a href="https://music.staiger.se/calendar/" style="display:inline-block;padding:10px 20px;background:#c9a84c;color:#0a0a0f;text-decoration:none;border-radius:8px;font-weight:bold">Öppna Sessions</a></p>
          </div>`,
        });
        console.log(`Digest sent to ${user.email} (${notifs.length} notifications)`);
      } catch (err) {
        console.error(`Digest failed for ${user.email}:`, err);
      }
    }
  }
);
