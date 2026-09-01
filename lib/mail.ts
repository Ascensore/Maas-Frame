import nodemailer from 'nodemailer';
import { Resend } from 'resend';
import { logError } from '@/lib/logger';

function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD);
}

function resendApiKey(): string | null {
  const key = process.env.RESEND_API_KEY?.trim();
  return key ? key : null;
}

/** True when Resend or SMTP can actually deliver a message. */
export function isTransactionalEmailConfigured(): boolean {
  return Boolean(resendApiKey()) || smtpConfigured();
}

function fromAddress(): string {
  return (
    process.env.RESEND_FROM?.trim() ||
    process.env.SMTP_FROM?.trim() ||
    process.env.EMAIL_FROM?.trim() ||
    'OpenFrame <info@open-frame.net>'
  );
}

function createSmtpTransport() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  if (!host || !user || !pass) return null;

  const port = Number(process.env.SMTP_PORT || '587');
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

/**
 * Sends one transactional message. Prefers Resend when `RESEND_API_KEY` is set,
 * otherwise SMTP. Returns false when nothing is configured or the provider
 * rejects the send — callers decide whether that is fatal.
 */
export async function sendTransactionalEmail(input: {
  to: string;
  subject: string;
  html: string;
}): Promise<boolean> {
  const from = fromAddress();
  const key = resendApiKey();

  if (key) {
    try {
      const resend = new Resend(key);
      const { error } = await resend.emails.send({
        from,
        to: input.to,
        subject: input.subject,
        html: input.html,
      });
      if (error) {
        logError('Resend email send failed:', error);
        return false;
      }
      return true;
    } catch (error) {
      logError('Resend email send failed:', error);
      return false;
    }
  }

  const transporter = createSmtpTransport();
  if (!transporter) return false;

  try {
    await transporter.sendMail({
      from,
      to: input.to,
      subject: input.subject,
      html: input.html,
    });
    return true;
  } catch (error) {
    logError('SMTP email send failed:', error);
    return false;
  }
}
