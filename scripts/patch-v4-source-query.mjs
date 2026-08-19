import fs from 'node:fs';

const file = 'admin.html';
let text = fs.readFileSync(file, 'utf8');
const from = "const query = courseSlug ? ('?courseSlug=' + encodeURIComponent(courseSlug)) : '';\n        const response = await fetch('/api/courses?action=v4-sources' + query, {";
const to = "const query = courseSlug ? ('&courseSlug=' + encodeURIComponent(courseSlug)) : '';\n        const response = await fetch('/api/courses?action=v4-sources' + query, {";
const count = text.split(from).length - 1;
if (count !== 1) throw new Error(`Expected exactly one V4 query builder, found ${count}`);
text = text.replace(from, to);
fs.writeFileSync(file, text);
console.log('Fixed V4 source query separator');
