import fs from 'node:fs';
import { normalizePublicUrl } from '../utils/public-urls.js';

const manifestPath = process.argv[2] || 'clone.manifest.example.json';
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const required = ['commerce', 'lms', 'reader'];
const errors = [];
if (manifest.version !== 'CLONE_FACTORY_V1') errors.push('version must be CLONE_FACTORY_V1');
if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(String(manifest.systemId || ''))) errors.push('systemId is invalid');
if (!['empty', 'template', 'snapshot'].includes(manifest.seedMode)) errors.push('seedMode is invalid');
for (const key of required) {
  try { normalizePublicUrl(manifest.domains?.[key], `domains.${key}`); }
  catch (error) { errors.push(error.message); }
}
const origins = required.map(key => manifest.domains?.[key]).filter(Boolean);
if (new Set(origins).size !== origins.length) errors.push('commerce, lms and reader origins must be different');
if (errors.length) {
  console.error('STOP — CLONE CONFIG INVALID');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log('CLONE_CONFIG = PASS');
