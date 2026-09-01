import { beforeEach, describe, expect, it, vi } from 'vitest';

const mailMocks = vi.hoisted(() => ({
  resendSend: vi.fn(),
  smtpSend: vi.fn(),
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mailMocks.resendSend };
  },
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({ sendMail: mailMocks.smtpSend }),
  },
}));

import { isTransactionalEmailConfigured, sendTransactionalEmail } from '@/lib/mail';

const MESSAGE = {
  to: 'ada@example.com',
  subject: 'Hello',
  html: '<p>Hi</p>',
};

describe('isTransactionalEmailConfigured', () => {
  it('is true when a Resend key is set, even without SMTP', () => {
    vi.stubEnv('RESEND_API_KEY', 're_test_key');
    vi.stubEnv('SMTP_HOST', '');
    vi.stubEnv('SMTP_USER', '');
    vi.stubEnv('SMTP_PASSWORD', '');
    expect(isTransactionalEmailConfigured()).toBe(true);
  });

  it('is true when SMTP is fully set, even without Resend', () => {
    vi.stubEnv('RESEND_API_KEY', '');
    vi.stubEnv('SMTP_HOST', 'localhost');
    vi.stubEnv('SMTP_USER', 'test');
    vi.stubEnv('SMTP_PASSWORD', 'test');
    expect(isTransactionalEmailConfigured()).toBe(true);
  });

  it('is false when neither provider is configured', () => {
    vi.stubEnv('RESEND_API_KEY', '');
    vi.stubEnv('SMTP_HOST', '');
    vi.stubEnv('SMTP_USER', '');
    vi.stubEnv('SMTP_PASSWORD', '');
    expect(isTransactionalEmailConfigured()).toBe(false);
  });
});

describe('sendTransactionalEmail', () => {
  beforeEach(() => {
    mailMocks.resendSend.mockReset();
    mailMocks.smtpSend.mockReset();
    mailMocks.resendSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
    mailMocks.smtpSend.mockResolvedValue({ messageId: 'smtp-1' });
  });

  it('prefers Resend when a key is set, and does not open SMTP', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test_key');
    vi.stubEnv('SMTP_HOST', 'localhost');
    vi.stubEnv('SMTP_USER', 'test');
    vi.stubEnv('SMTP_PASSWORD', 'test');
    vi.stubEnv('RESEND_FROM', 'OpenFrame <mail@example.com>');

    await expect(sendTransactionalEmail(MESSAGE)).resolves.toBe(true);

    expect(mailMocks.resendSend).toHaveBeenCalledTimes(1);
    expect(mailMocks.resendSend).toHaveBeenCalledWith({
      from: 'OpenFrame <mail@example.com>',
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      html: MESSAGE.html,
    });
    expect(mailMocks.smtpSend).not.toHaveBeenCalled();
  });

  it('falls back to SMTP when Resend is unset', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    vi.stubEnv('SMTP_HOST', 'localhost');
    vi.stubEnv('SMTP_USER', 'test');
    vi.stubEnv('SMTP_PASSWORD', 'test');
    vi.stubEnv('SMTP_FROM', 'OpenFrame <smtp@example.com>');

    await expect(sendTransactionalEmail(MESSAGE)).resolves.toBe(true);

    expect(mailMocks.resendSend).not.toHaveBeenCalled();
    expect(mailMocks.smtpSend).toHaveBeenCalledTimes(1);
    expect(mailMocks.smtpSend).toHaveBeenCalledWith({
      from: 'OpenFrame <smtp@example.com>',
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      html: MESSAGE.html,
    });
  });

  it('returns false when nothing is configured, rather than throwing', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    vi.stubEnv('SMTP_HOST', '');
    vi.stubEnv('SMTP_USER', '');
    vi.stubEnv('SMTP_PASSWORD', '');

    await expect(sendTransactionalEmail(MESSAGE)).resolves.toBe(false);
    expect(mailMocks.resendSend).not.toHaveBeenCalled();
    expect(mailMocks.smtpSend).not.toHaveBeenCalled();
  });

  it('returns false when Resend reports an error, and does not fall through to SMTP', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test_key');
    vi.stubEnv('SMTP_HOST', 'localhost');
    vi.stubEnv('SMTP_USER', 'test');
    vi.stubEnv('SMTP_PASSWORD', 'test');
    mailMocks.resendSend.mockResolvedValue({
      data: null,
      error: { message: 'domain not verified' },
    });

    await expect(sendTransactionalEmail(MESSAGE)).resolves.toBe(false);
    expect(mailMocks.smtpSend).not.toHaveBeenCalled();
  });
});
