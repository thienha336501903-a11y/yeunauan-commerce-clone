// After Admin approves a Facebook order, tell the buyer how to start learning (H4). Best effort: a Send API
// failure (outside Meta's 24-hour window, token revoked, timeout) never changes the approval result.
import { approvedMessage } from './bot.js';
import { sendMessage } from './meta.js';
import { cloneConfig } from '../clone-config.js';

export async function notifyApprovedOrder(order, { env = process.env, fetchImpl = fetch } = {}) {
  const raw = order?.raw_data || {};
  if (raw.channel !== 'facebook' || !/^\d{5,32}$/.test(String(raw.psid || ''))) return null;
  if (String(env.MESSENGER_BOT_ENABLED || '').trim() !== '1') return 'SKIPPED_BOT_OFF';
  const message = {
    text: approvedMessage({
      courseTitle: order.course_title || order.course_slug,
      gmail: order.customer_email,
      lmsUrl: cloneConfig(env).lmsPublicUrl // learner-facing host (V5_LMS_PUBLIC_URL is the sync target)
    })
  };
  const sent = await sendMessage(String(raw.psid), message, { token: env.META_PAGE_ACCESS_TOKEN, fetchImpl, timeoutMs: 5000 });
  return sent.ok ? 'SENT' : 'FAILED';
}
