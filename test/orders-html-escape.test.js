// C2-2: order fields that could come from a direct DB insert never reach innerHTML or an inline handler unescaped.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../orders.html", import.meta.url), "utf8");
const grab = (name) => html.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n    \\}`))[0];
const { escapeHtml, jsArg, safeBillUrl } = new Function(`${grab("escapeHtml")}; ${grab("jsArg")}; ${grab("safeBillUrl")}; return { escapeHtml, jsArg, safeBillUrl };`)();
// What the browser does with onclick="f(<value>)": decode the HTML entities, then run the script.
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

test("ESC-1 jsArg: a hostile value stays one string argument after the browser decodes the attribute", () => {
  for (const evil of [`x');alert(1);//`, `"><img src=x onerror=alert(1)>`, `a\\'b`, `</script>`, `&#039;);alert(1)//`, "line\nbreak"]) {
    const attr = jsArg(evil);
    assert.doesNotMatch(attr, /["'<>]/, "nothing that can end the attribute or open a tag");
    const seen = [];
    new Function("f", `f(${decode(attr)})`)((...args) => seen.push(args));
    assert.deepEqual(seen, [[evil]]);
  }
  assert.equal(new Function(`return ${decode(jsArg(null))}`)(), "");
});

test("ESC-2 plain escapeHtml is not enough inside a handler (why jsArg exists)", () => {
  let ran = false;
  new Function("f", "hit", `f('${decode(escapeHtml(`');hit();//`))}')`)(() => {}, () => { ran = true; });
  assert.equal(ran, true);
});

test("ESC-3 safeBillUrl keeps https links only", () => {
  assert.equal(safeBillUrl("https://res.cloudinary.com/x/a.jpg"), "https://res.cloudinary.com/x/a.jpg");
  for (const bad of ["javascript:alert(1)", " javascript:alert(1)", "data:text/html,x", "http://x/a.jpg", "//x/a.jpg", "", null, undefined]) assert.equal(safeBillUrl(bad), "");
});

test("ESC-4 orders.html: bill, course slug and sync status are escaped everywhere they are rendered", () => {
  assert.equal(html.match(/const bill = safeBillUrl\(order\.billLink\);/g).length, 2);
  assert.doesNotMatch(html, /order\.billLink \|\| ""/);
  // The single-approval dialog links to the bill too: every use of billLink goes through safeBillUrl.
  assert.equal(html.match(/billLink/g).length, 3);
  assert.equal(html.match(/safeBillUrl\(order\.billLink\)/g).length, 3);
  assert.match(html, /<option value="\$\{escapeHtml\(c\.slug\)\}">\$\{escapeHtml\(c\.courseName \|\| c\.slug\)\}<\/option>/);
  assert.doesNotMatch(html, /\$\{bill\}/, "bill is never interpolated raw");
  assert.doesNotMatch(html, /\$\{courseSlug\}[^`]*<\/p>|\('\$\{(bill|courseSlug)\}'\)/);
  assert.equal(html.match(/\$\{jsArg\(bill\)\}/g).length, 4);
  assert.equal(html.match(/src="\$\{escapeHtml\(bill\)\}"/g).length, 2);
  assert.equal(html.match(/\$\{jsArg\(courseSlug\)\}/g).length, 2);
  assert.match(html, /slug: \$\{escapeHtml\(courseSlug\)\}/);
  assert.doesNotMatch(html, /\$\{order\.sync_(lms|portal)_status \|\| 'PENDING'\}/);
  assert.equal(html.match(/\$\{escapeHtml\(order\.sync_(lms|portal)_status \|\| 'PENDING'\)\}/g).length, 2);
});
