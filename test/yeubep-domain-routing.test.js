import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const config = fs.readFileSync(new URL('../api/config.js', import.meta.url), 'utf8');
const workflow = fs.readFileSync(new URL('../utils/v4-workflow.js', import.meta.url), 'utf8');

assert.match(page, /host==='yeubep\.shop'\|\|host==='www\.yeubep\.shop'/);
assert.match(page, /!params\.has\('course'\)/);
assert.match(page, /location\.replace\('https:\/\/hoc\.yeubep\.shop\/my-courses\.html'\)/);
assert.match(page, /window\.LMS_PUBLIC_URL=data\.lmsPublicUrl\|\|'https:\/\/hoc\.yeubep\.shop'/);
assert.match(config, /lmsPublicUrl: String\(process\.env\.LMS_PUBLIC_URL \|\| 'https:\/\/hoc\.yeubep\.shop'\)/);
assert.match(workflow, /https:\/\/reader\.yeubep\.shop/);

console.log('YeuBep Commerce domain routing checks passed');
