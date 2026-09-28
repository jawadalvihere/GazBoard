#!/usr/bin/env node
'use strict';
/*
 * Every sentence the app can show, found by reading the source.
 *
 *   node scripts/i18n-extract.js          list them, one per line
 *   node scripts/i18n-extract.js --json   as a JSON array
 *
 * It looks for t('...') in the app's scripts, T('...') in the menu bar, and
 * the title / aria-label / placeholder / data-i18n text written into
 * index.html. The suite uses the same list to check that every language file
 * covers every sentence, so a new message cannot ship untranslated without
 * the tests saying so.
 *
 * The rule this depends on: what goes into t() is ONE plain string literal.
 * Names in a sentence are placeholders - t('Page {n} of {total}', { n, total })
 * - never glued on with + or ${}, because a translator has to see the whole
 * sentence to move the pieces round.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor') walk(full, out); }
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Turn a JS string literal's source into its value. Our own source only. */
function unquote(lit) {
  // eslint-disable-next-line no-new-func
  return Function('"use strict"; return (' + lit + ');')();
}

const CALL = /(?<![\w$.])(t|T)\(\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\$])*`)\s*[,)]/g;
const LOOSE = /(?<![\w$.])t\(\s*(?!['"`])/g;

function fromScript(file, found, problems) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  let m;
  while ((m = CALL.exec(src))) {
    if (m[1] === 'T' && !rel.endsWith('main.js')) continue;
    const text = unquote(m[2]);
    if (!found.has(text)) found.set(text, rel);
  }
  // t(someVariable) cannot be found by reading, so it cannot be translated
  // either unless the value came from a t() somewhere else. Flagged so each
  // one is a decision, not an accident.
  while ((m = LOOSE.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length;
    const after = src.slice(m.index, m.index + 60).split('\n')[0];
    if (!/\/\/ i18n-ok/.test(src.split('\n')[line - 1])) problems.push(`${rel}:${line}  ${after}`);
  }
}

function decodeHtml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&mdash;/g, '—');
}

function fromHtml(file, found) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  for (const m of src.matchAll(/\s(title|aria-label|placeholder)="([^"]+)"/g)) {
    const text = decodeHtml(m[2]);
    if (!found.has(text)) found.set(text, rel);
  }
  for (const m of src.matchAll(/data-i18n[^>]*>([^<]+)</g)) {
    const text = decodeHtml(m[1].trim());
    if (!found.has(text)) found.set(text, rel);
  }
}

function extract() {
  const found = new Map();
  const problems = [];
  for (const f of walk(path.join(ROOT, 'src', 'js'))) {
    if (f.endsWith(path.join('js', 'i18n.js'))) continue;   // the machinery, not the words
    fromScript(f, found, problems);
  }
  fromScript(path.join(ROOT, 'main.js'), found, problems);
  fromHtml(path.join(ROOT, 'src', 'index.html'), found);
  // the page's own <title> is a name, not a sentence
  found.delete('GazBoard');
  return { strings: [...found.keys()], where: found, problems };
}

module.exports = { extract };

if (require.main === module) {
  const { strings, problems } = extract();
  if (process.argv.includes('--json')) console.log(JSON.stringify(strings, null, 2));
  else for (const s of strings) console.log(s);
  if (problems.length) {
    console.error(`\n${problems.length} t() call(s) with no literal to translate:`);
    for (const p of problems) console.error('  ' + p);
  }
}
