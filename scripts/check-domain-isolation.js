import fs from 'node:fs';
import path from 'node:path';

const roots = ['api', 'utils'];
const systemBDomains = /(?:yeubep\.shop|daubepnho\.store|yeunauan\.live)/i;
const allowed = new Set(['utils/clone-config.js']);
const violations = [];

function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) scan(absolute);
    else if (entry.name.endsWith('.js')) {
      const relative = absolute.replaceAll(path.sep, '/');
      if (!allowed.has(relative) && systemBDomains.test(fs.readFileSync(absolute, 'utf8'))) violations.push(relative);
    }
  }
}

for (const root of roots) scan(root);
for (const page of ['index.html', 'admin.html', 'orders.html']) {
  if (systemBDomains.test(fs.readFileSync(page, 'utf8'))) violations.push(page);
}

if (violations.length) {
  console.error(`System B domain hardcode found outside Clone Factory config:\n${violations.join('\n')}`);
  process.exit(1);
}
console.log('Runtime domain isolation passed.');
