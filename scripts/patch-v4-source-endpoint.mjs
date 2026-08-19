import fs from 'node:fs';

const file = 'admin.html';
let text = fs.readFileSync(file, 'utf8');
const from = '/api/v4-sources';
const to = '/api/courses?action=v4-sources';
const count = text.split(from).length - 1;
if (count < 3) throw new Error(`Expected V4 source endpoint references, found ${count}`);
text = text.split(from).join(to);
fs.writeFileSync(file, text);
console.log(`Updated ${count} V4 source endpoint reference(s)`);
