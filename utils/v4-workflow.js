import { supabase } from './supabase.js';

const clean = value => String(value || '').trim();
const normalizeBase = value => clean(value).replace(/\/$/, '');
const validSlug = value => /^[a-z0-9_-]+$/.test(clean(value));

function internalConfig() {
  const secret = clean(process.env.INTERNAL_SYNC_SECRET);
  const lmsUrl = normalizeBase(process.env.SYSTEM3_URL || process.env.LMS_PUBLIC_URL);
  const clonerUrl = normalizeBase(process.env.TELEGRAM_CLONER_URL || 'https://telegram-channel-cloner.vercel.app');
  if (!secret) {
    const error = new Error('Thiếu INTERNAL_SYNC_SECRET cho quy trình V4');
    error.statusCode = 503;
    throw error;
  }
  if (!lmsUrl) {
    const error = new Error('Thiếu LMS URL cho quy trình V4');
    error.statusCode = 503;
    throw error;
  }
  return { secret, lmsUrl, clonerUrl };
}

async function internalPost(url, secret, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sync-Secret': secret },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `Dịch vụ nội bộ trả HTTP ${response.status}`);
      error.statusCode = response.status;
      error.payload = data;
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('Dịch vụ nội bộ không phản hồi trong 15 giây');
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function internalGet(url, secret) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'X-Sync-Secret': secret },
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `Dịch vụ nội bộ trả HTTP ${response.status}`);
      error.statusCode = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function requireDraftV4Course(courseSlug) {
  const slug = clean(courseSlug);
  if (!validSlug(slug)) {
    const error = new Error('Slug khóa học không hợp lệ');
    error.statusCode = 400;
    throw error;
  }
  const { data, error } = await supabase
    .from('courses')
    .select('id,slug,title,delivery_mode,is_published,active')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  if (!data || clean(data.delivery_mode).toLowerCase() !== 'v4') {
    const notFound = new Error('Khóa học không tồn tại hoặc không phải V4');
    notFound.statusCode = 400;
    throw notFound;
  }
  if (data.is_published === true) {
    const published = new Error('Hãy chuyển khóa V4 về Draft trước khi đổi nguồn');
    published.statusCode = 409;
    throw published;
  }
  return data;
}

async function registerSource({ courseSlug, sourceRef, readerProfileId }) {
  const course = await requireDraftV4Course(courseSlug);
  const ref = clean(sourceRef);
  if (!/^https:\/\/t\.me\//i.test(ref)) {
    const error = new Error('Hãy dán đúng link một bài Telegram');
    error.statusCode = 400;
    throw error;
  }
  const { secret, clonerUrl } = internalConfig();
  const registered = await internalPost(`${clonerUrl}/api/admin?action=v4-source`, secret, {
    source_ref: ref,
    ...(clean(readerProfileId) ? { reader_profile_id: clean(readerProfileId) } : {})
  });
  const sourceId = clean(registered?.source?.id);
  if (!sourceId) {
    const error = new Error('Cloner chưa trả về nguồn Telegram hợp lệ');
    error.statusCode = 502;
    throw error;
  }
  const { data: mapping, error: mappingError } = await supabase
    .from('lms_v4_telegram_course_sources')
    .upsert({
      course_slug: course.slug,
      source_id: sourceId,
      enabled: true,
      media_mode: 'telegram_bot_poc',
      updated_at: new Date().toISOString()
    }, { onConflict: 'course_slug' })
    .select('course_slug,source_id,enabled,media_mode,updated_at')
    .single();
  if (mappingError) throw mappingError;
  return { course, mapping, ...registered };
}

async function status(courseSlug) {
  const slug = clean(courseSlug);
  if (!validSlug(slug)) {
    const error = new Error('Slug khóa học không hợp lệ');
    error.statusCode = 400;
    throw error;
  }
  const { data: course, error: courseError } = await supabase
    .from('courses')
    .select('id,slug,title,delivery_mode,is_published,active,sync_lms_status,sync_error,raw_data')
    .eq('slug', slug)
    .maybeSingle();
  if (courseError) throw courseError;
  if (!course || clean(course.delivery_mode).toLowerCase() !== 'v4') {
    const error = new Error('Khóa học không tồn tại hoặc không phải V4');
    error.statusCode = 400;
    throw error;
  }
  const { data: mapping, error: mappingError } = await supabase
    .from('lms_v4_telegram_course_sources')
    .select('course_slug,source_id,enabled,media_mode,updated_at')
    .eq('course_slug', slug)
    .maybeSingle();
  if (mappingError) throw mappingError;

  let source = null;
  let readerJob = null;
  let actualMessageCount = 0;
  if (mapping?.source_id) {
    const [sourceResult, countResult, jobResult] = await Promise.all([
      supabase.from('tgcloner_sources')
        .select('id,title,username,active,indexed_at,indexed_message_count,last_ingested_at,updated_at')
        .eq('id', mapping.source_id).maybeSingle(),
      supabase.from('tgcloner_source_messages')
        .select('id', { count: 'exact', head: true }).eq('source_id', mapping.source_id),
      supabase.from('tgcloner_reader_jobs')
        .select('*')
        .eq('source_id', mapping.source_id).order('created_at', { ascending: false }).limit(1).maybeSingle()
    ]);
    if (sourceResult.error) throw sourceResult.error;
    if (countResult.error) throw countResult.error;
    if (jobResult.error) throw jobResult.error;
    source = sourceResult.data || null;
    readerJob = jobResult.data || null;
    actualMessageCount = Number(countResult.count || 0);
  }
  return {
    course,
    mapping,
    source: source ? { ...source, actualMessageCount } : null,
    readerJob,
    readyForPreflight: Boolean(mapping?.enabled && source && actualMessageCount > 0)
  };
}

async function readerManagerState() {
  const { secret, clonerUrl } = internalConfig();
  return internalGet(`${clonerUrl}/api/admin?action=reader-manager`, secret);
}

async function readerManagerAction(body) {
  const { secret, clonerUrl } = internalConfig();
  return internalPost(`${clonerUrl}/api/admin?action=reader-manager`, secret, body);
}

async function lmsAction(action, courseSlug, options = {}) {
  const slug = clean(courseSlug);
  if (!validSlug(slug)) {
    const error = new Error('Slug khóa học không hợp lệ');
    error.statusCode = 400;
    throw error;
  }
  const { secret, lmsUrl } = internalConfig();
  return internalPost(`${lmsUrl}/api/sync`, secret, {
    action,
    courseSlug: slug,
    ...(options.published === undefined ? {} : { published: options.published === true }),
    ...(clean(options.testEmail) ? { testEmail: clean(options.testEmail) } : {})
  });
}

export async function handleV4Workflow(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  try {
    const action = clean(req.body?.workflowAction);
    if (action === 'registerSource') {
      return res.status(200).json({ success: true, ...(await registerSource(req.body || {})) });
    }
    if (action === 'status') {
      return res.status(200).json({ success: true, ...(await status(req.body?.courseSlug)) });
    }
    if (action === 'readerState') {
      return res.status(200).json({ success: true, ...(await readerManagerState()) });
    }
    if (action === 'createReaderPairing') {
      return res.status(200).json({ success: true, ...(await readerManagerAction({
        operation: 'create_pairing',
        display_name: clean(req.body?.displayName) || 'Máy Reader'
      })) });
    }
    if (action === 'readerAdmin') {
      const operation = clean(req.body?.operation);
      if (!['pause_profile', 'resume_profile', 'revoke_profile', 'revoke_agent'].includes(operation)) {
        return res.status(400).json({ success: false, error: 'Thao tác Reader không hợp lệ' });
      }
      return res.status(200).json({ success: true, ...(await readerManagerAction({
        operation,
        profileId: clean(req.body?.profileId),
        agentId: clean(req.body?.agentId)
      })) });
    }
    if (action === 'preflight') {
      return res.status(200).json(await lmsAction('v4PrepareRelease', req.body?.courseSlug, {
        testEmail: req.body?.testEmail
      }));
    }
    if (action === 'publish') {
      return res.status(200).json(await lmsAction('setV4Published', req.body?.courseSlug, { published: true }));
    }
    if (action === 'unpublish') {
      return res.status(200).json(await lmsAction('setV4Published', req.body?.courseSlug, { published: false }));
    }
    return res.status(400).json({ success: false, error: 'Thao tác V4 không hợp lệ' });
  } catch (error) {
    console.error('[v4-workflow]', error?.message || error);
    return res.status(Number(error.statusCode || 500)).json({
      success: false,
      error: error.message || 'Quy trình V4 thất bại',
      ...(error.payload?.preflight ? { preflight: error.payload.preflight } : {})
    });
  }
}
