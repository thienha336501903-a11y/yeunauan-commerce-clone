import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const config = fs.readFileSync(new URL('../api/config.js', import.meta.url), 'utf8');
const workflow = fs.readFileSync(new URL('../utils/v4-workflow.js', import.meta.url), 'utf8');

assert.match(page, /fetch\('\/api\/config\?runtime=1'/);
assert.match(page, /location\.origin===config\.commercePublicUrl/);
assert.match(page, /config\.lmsPublicUrl\+'\/my-courses\.html'/);
assert.match(page, /window\.LMS_PUBLIC_URL=data\.lmsPublicUrl/);
assert.match(config, /publicUrl\('LMS_PUBLIC_URL'\)/);
assert.match(workflow, /publicUrl\('TELEGRAM_CLONER_URL'\)/);
assert.match(config, /commerceRuntimeConfig/);
for (const forbidden of ['yeubep.shop', 'hoc.yeubep.shop', 'reader.yeubep.shop', 'yeunauan.live']) {
  assert.equal(page.includes(forbidden), false, `index.html must not hardcode ${forbidden}`);
  assert.equal(config.includes(forbidden), false, `api/config.js must not hardcode ${forbidden}`);
  assert.equal(workflow.includes(forbidden), false, `utils/v4-workflow.js must not hardcode ${forbidden}`);
}

console.log('YeuBep Commerce domain routing checks passed');
