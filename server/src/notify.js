const cfg = {
  ntfy:    (process.env.NOTIFY_NTFY_URL || '').trim(),
  tgToken: (process.env.NOTIFY_TELEGRAM_BOT_TOKEN || '').trim(),
  tgChat:  (process.env.NOTIFY_TELEGRAM_CHAT_ID || '').trim(),
};

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

}

export function notifyConfigured() {
  return !!(cfg.ntfy || (cfg.tgToken && cfg.tgChat));
}
