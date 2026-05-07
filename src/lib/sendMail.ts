// src/lib/sendMail.ts
import nodemailer from "nodemailer";

type MailOptions = {
  subject: string;
  text: string;
  html?: string;
};

function mustEnv(name: string) {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export async function sendMail({ subject, text, html }: MailOptions) {
  const to   = mustEnv("SUPPORT_TO_EMAIL");
  const host = mustEnv("SMTP_HOST");
  const port = Number(mustEnv("SMTP_PORT"));
  const user = mustEnv("SMTP_USER");
  const pass = mustEnv("SMTP_PASS");
  const from = (process.env.SMTP_FROM || "").trim() || user;

  const secure = process.env.SMTP_SECURE != null
    ? ["1", "true", "yes"].includes((process.env.SMTP_SECURE || "").toLowerCase())
    : port === 465;

  const transporter = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
  await transporter.sendMail({ from, to, subject, text, html });
}
