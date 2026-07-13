import crypto from 'crypto';
import { supabase } from './supabase.js';
import { V2_FLAGS, isV2FlagEnabled } from './v2-flags.js';

function cleanText(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  return cleanText(value).toLowerCase();
}

export function isV2OutboxShadowMode() {
  return isV2FlagEnabled(V2_FLAGS.OUTBOX_SHADOW_MODE);
}

export function buildOutboxIdempotencyKey(parts) {
  const source = Array.isArray(parts) ? parts.join(':') : String(parts || '');
  return crypto.createHash('sha256').update(source).digest('hex');
}

export async function enqueueSyncOutboxEvent(params) {
  const sourceSystem = cleanText(params.sourceSystem || 'shop');
  const aggregateType = cleanText(params.aggregateType);
  const aggregateId = cleanText(params.aggregateId);
  const eventType = cleanText(params.eventType);
  const idempotencyKey = cleanText(params.idempotencyKey);

  if (!sourceSystem || !aggregateType || !eventType || !idempotencyKey) {
    throw new Error('Missing required outbox event fields');
  }

  const payload = params.payload && typeof params.payload === 'object'
    ? params.payload
    : {};

  const { data, error } = await supabase
    .from('sync_outbox')
    .upsert({
      source_system: sourceSystem,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId || null,
      event_type: eventType,
      idempotency_key: idempotencyKey,
      payload,
      status: 'pending',
      available_at: params.availableAt || new Date().toISOString(),
      priority: Number.isFinite(params.priority) ? params.priority : 100,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'idempotency_key',
    })
    .select('id,status,idempotency_key')
    .single();

  if (error) throw error;
  return data;
}

export async function enqueueCourseSyncEvent(course) {
  const slug = cleanText(course?.slug || course?.course_slug);
  if (!slug) throw new Error('Missing course slug for outbox event');

  return enqueueSyncOutboxEvent({
    sourceSystem: 'shop',
    aggregateType: 'course',
    aggregateId: slug,
    eventType: 'course.upserted',
    idempotencyKey: buildOutboxIdempotencyKey(['course.upserted', slug, course?.updated_at || Date.now()]),
    payload: {
      slug,
      title: cleanText(course?.title || course?.courseName),
      image_url: cleanText(course?.image_url || course?.imageUrl),
      expected_start_date: course?.expected_start_date || null,
      active: course?.active !== false,
    },
  });
}

export async function enqueueEnrollmentSyncEvent(enrollment, action = 'upserted') {
  const email = normalizeEmail(enrollment?.email || enrollment?.customer_email || enrollment?.gmail);
  const courseSlug = cleanText(enrollment?.course_slug || enrollment?.course);
  if (!email || !courseSlug) throw new Error('Missing enrollment email or course slug for outbox event');

  return enqueueSyncOutboxEvent({
    sourceSystem: 'shop',
    aggregateType: 'enrollment',
    aggregateId: `${email}:${courseSlug}`,
    eventType: `enrollment.${action}`,
    idempotencyKey: buildOutboxIdempotencyKey([
      `enrollment.${action}`,
      email,
      courseSlug,
      enrollment?.updated_at || Date.now(),
    ]),
    payload: {
      email,
      course_slug: courseSlug,
      action,
      order_id: enrollment?.id || enrollment?.order_id || null,
    },
  });
}
