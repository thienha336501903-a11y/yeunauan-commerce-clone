import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const config = fs.readFileSync(new URL('../api/config.js', import.meta.url), 'utf8');
const workflow = fs.readFileSync(new URL('../utils/v4-workflow.js', import.meta.url), 'utf8');
const cloneConfig = fs.readFileSync(new URL('../utils/clone-config.js', import.meta.url), 'utf8');
const admin = fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8');

assert.match(page, /cloneRuntimeConfigPromise=fetch\('\/api\/config\?runtime=1'/);
assert.match(page, /host===commerceHost\|\|host===`www\.\$\{commerceHost\}`/);
assert.match(page, /!params\.has\('course'\)/);
assert.match(page, /new URL\('\/my-courses\.html',config\.lmsPublicUrl\)/);
assert.match(page, /window\.LMS_PUBLIC_URL=data\.lmsPublicUrl\|\|window\.CLONE_RUNTIME_CONFIG/);
assert.match(config, /String\(req\.query\?\.runtime \|\| ''\) === '1'/);
assert.match(config, /lmsPublicUrl: runtime\.lmsPublicUrl/);
assert.match(workflow, /const runtime = cloneConfig\(\)/);
assert.match(admin, /id="v4ClonerAdminLink"/);
assert.match(admin, /config\.telegramClonerUrl/);
assert.match(cloneConfig, /commercePublicUrl: 'https:\/\/yeubep\.shop'/);

console.log('YeuBep Commerce domain routing checks passed');
