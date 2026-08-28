import { supabase } from './supabase.js';

export function evaluateV5Readiness(config, release, courseId) {
  const id = String(courseId || '').trim();
  if (!id) return { ready: false, reason: 'v5_course_id_missing' };
  if (!config) return { ready: false, reason: 'v5_config_missing' };
  if (String(config.status || '').toLowerCase() !== 'published') return { ready: false, reason: 'v5_config_not_published' };
  const releaseId = String(config.published_release_id || '').trim();
  if (!releaseId) return { ready: false, reason: 'v5_release_pointer_missing' };
  if (!release) return { ready: false, reason: 'v5_release_missing' };
  if (String(release.id || '') !== releaseId) return { ready: false, reason: 'v5_release_pointer_mismatch' };
  if (String(release.course_id || '') !== id) return { ready: false, reason: 'v5_release_course_mismatch' };
  if (String(release.status || '').toLowerCase() !== 'published') return { ready: false, reason: 'v5_release_not_published' };
  return { ready: true, reason: null, releaseId };
}

export async function getV5Readiness(courseId) {
  const id = String(courseId || '').trim();
  if (!id) return { ready: false, reason: 'v5_course_id_missing' };

  const { data: config, error: configError } = await supabase
    .from('v5_course_configs')
    .select('course_id,status,published_release_id')
    .eq('course_id', id)
    .maybeSingle();
  if (configError) throw configError;

  const releaseId = String(config?.published_release_id || '').trim();
  let release = null;
  if (releaseId) {
    const { data, error } = await supabase
      .from('v5_releases')
      .select('id,course_id,status,version,created_at')
      .eq('id', releaseId)
      .eq('course_id', id)
      .maybeSingle();
    if (error) throw error;
    release = data || null;
  }

  return { ...evaluateV5Readiness(config, release, id), config: config || null, release };
}
