#!/usr/bin/env node
'use strict';
/*
 * Is every language file complete, and safe to show?
 *
 *   node scripts/i18n-check.js          all languages
 *   node scripts/i18n-check.js bn       one
 *
 * For each file in src/locales it checks that:
 *   - every sentence the app can show has a translation (none missing)
 *   - nothing is left over from sentences the app no longer has
 *   - every {placeholder} in the English is in the translation, and no new ones
 *   - the HTML tags match, so a translation cannot break the page around it
 *   - nothing is empty
 *
 * The suite runs the same checks, so a new message cannot ship half-done.
 */
const fs = require('node:fs');
const path = require('node:path');
const { extract } = require('./i18n-extract.js');

const DIR = path.join(__dirname, '..', 'src', 'locales');

const holes = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const tags = (s) => [...String(s).matchAll(/<\/?([a-z][a-z0-9]*)\b/gi)].map((m) => m[0].toLowerCase()).sort().join(',');

function checkLanguage(code, strings = extract().strings) {
  const file = path.join(DIR, code + '.json');
  const problems = [];
  let dict;
  try { dict = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { code, problems: [`cannot read ${code}.json: ${e.message}`], missing: strings.length, extra: 0 }; }
  const want = new Set(strings);
  const missing = strings.filter((s) => !Object.prototype.hasOwnProperty.call(dict, s));
  const extra = Object.keys(dict).filter((k) => !want.has(k));
  for (const s of strings) {
    if (!(s in dict)) continue;
    const v = dict[s];
    if (typeof v !== 'string' || !v.trim()) { problems.push(`empty: ${JSON.stringify(s)}`); continue; }
    if (holes(v) !== holes(s)) problems.push(`placeholders differ: ${JSON.stringify(s)} → ${JSON.stringify(v)}`);
    if (tags(v) !== tags(s)) problems.push(`HTML tags differ: ${JSON.stringify(s)} → ${JSON.stringify(v)}`);
  }
  return { code, total: strings.length, missing, extra, problems };
}

module.exports = { checkLanguage, holes, tags };

if (require.main === module) {
  const strings = extract().strings;
  const codes = process.argv[2] ? [process.argv[2]]
    : fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  let bad = 0;
  for (const code of codes) {
    const r = checkLanguage(code, strings);
    const miss = Array.isArray(r.missing) ? r.missing.length : r.missing;
    const extra = Array.isArray(r.extra) ? r.extra.length : r.extra;
    console.log(`${code}: ${strings.length - miss}/${strings.length} translated, ${extra} left over, ${r.problems.length} problem(s)`);
    if (Array.isArray(r.missing)) for (const m of r.missing.slice(0, 20)) console.log('   missing: ' + JSON.stringify(m));
    if (Array.isArray(r.extra)) for (const m of r.extra.slice(0, 20)) console.log('   left over: ' + JSON.stringify(m));
    for (const p of r.problems.slice(0, 30)) console.log('   ' + p);
    if (miss || extra || r.problems.length) bad++;
  }
  process.exit(bad ? 1 : 0);
}
