import assert from 'node:assert/strict';
import fs from 'node:fs';
const html = fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
assert.match(html, /action=v4-sources' \+ query/);
assert.match(html, /courseSlug \? \('&courseSlug=' \+ encodeURIComponent\(courseSlug\)\) : ''/);
assert.doesNotMatch(html, /courseSlug \? \('\?courseSlug='/);
console.log('V4 source query parameter separator checks passed');
