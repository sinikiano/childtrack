import nodemailer from 'nodemailer';

const cfg = {
  ntfy:    (process.env.NOTIFY_NTFY_URL || '').trim(),
  tgToken: (process.env.NOTIFY_TELEGRAM_BOT_TOKEN || '').trim(),
  tgChat:  (process.env.NOTIFY_TELEGRAM_CHAT_ID || '').trim(),
  smtp:    (process.env.NOTIFY_EMAIL_SMTP || '').trim(),
  from:    (process.env.NOTIFY_EMAIL_FROM || '').trim(),
  to:      (process.env.NOTIFY_EMAIL_TO || '').trim(),
};

let mailer = null;
if (cfg.smtp && cfg.from && cfg.to) {
  try { mailer = nodemailer.createTransport(cfg.smtp); }
  catch (e) { console.warn('[notify] SMTP init failed:', e.message); }
}

async function safe(fn, label) {
  try { await fn(); }
  catch (e) { console.warn(`[notify:${label}]`, e.message); }
}

export async function notify({ title, message, priority = 'default', tag = 'bell', url = null }) {
  const text = url ? `${message}\n${url}` : message;

  if (cfg.ntfy) {
    await safe(() => fetch(cfg.ntfy, {
      method: 'POST',
      headers: {
        'Title': title,
        'Priority': priority === 'high' ? '4' : priority === 'urgent' ? '5' : '3',
        'Tags': tag,
        ...(url ? { 'Click': url } : {}),
      },
      body: text,
    }), 'ntfy');
  }

  if (cfg.tgToken && cfg.tgChat) {
    const body = new URLSearchParams({
      chat_id: cfg.tgChat,
      text: `*${title}*\n${text}`,
      parse_mode: 'Markdown',
      disable_web_page_preview: 'true',
    });
    await safe(() => fetch(`https://api.telegram.org/bot${cfg.tgToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }), 'telegram');
  }

  if (mailer) {
    await safe(() => mailer.sendMail({
      from: cfg.from, to: cfg.to,
      subject: `[ChildTrack] ${title}`,
      text,
    }), 'email');
  }
}

export function notifyConfigured() {
  return !!(cfg.ntfy || (cfg.tgToken && cfg.tgChat) || mailer);
}
