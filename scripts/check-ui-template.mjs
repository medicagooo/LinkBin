/**
 * Guards the UI template against a mistake that has now cost three failures.
 *
 * `src/ui.ts` embeds a whole HTML document — including `<style>` and `<script>` — inside TypeScript
 * template literals. A backtick anywhere inside those regions terminates the literal early.
 *
 * The first two incidents produced an esbuild error that pointed at the end of the file rather than at
 * the offending character. The third produced **no build error at all**: the truncated literal was
 * still syntactically valid, so the build passed and the page died at runtime with a TypeError naming
 * an identifier assembled from the fragments.
 *
 * Note the backtick does not have to be in code. Inside these regions a line-comment marker is literal
 * text, not a comment, so a backtick in prose breaks the page just as thoroughly — and stripping line
 * comments before counting backticks is precisely the mistake that hid the third incident. See the
 * dedicated check in the scanner below.
 *
 * This script fails loudly and names the exact line. It is wired into `pnpm run check` so it runs
 * before a build rather than after a confusing failure.
 */

import { readFileSync } from 'node:fs';

const file = new URL('../src/ui.ts', import.meta.url);
const source = readFileSync(file, 'utf8');
const lines = source.split('\n');

/** Regions that are the inside of a template literal: everything between a line ending in a
 *  backtick and the next line that is exactly a backtick followed by an optional statement end. */
const offenders = [];
let inTemplate = false;
let templateStartLine = 0;

// --- Check 1: the <script> body must contain no backtick at all ------------------------------
//
// This one is absolute, not heuristic. Everything between `<script>` and `</script>` is emitted
// verbatim into the page, but in this file that text also sits inside an outer TypeScript template
// literal. A backtick there is therefore never code - it closes the outer literal, and the remainder
// of the document is then parsed as JavaScript. The failure is silent at build time: the truncated
// result happened to be syntactically valid, so `wrangler deploy` reported success and the page died
// only when a browser loaded it, with a TypeError naming an identifier assembled from fragments.
// That is how a backtick written inside a script comment shipped to production.
//
// The inner script uses no template literals of its own, so "no backticks here" is a requirement
// rather than a preference. If that ever stops being true, this check must be replaced by a real
// parser rather than relaxed.
{
  let inScript = false;
  for (let i = 0; i < lines.length; i++) {
    if (!inScript) {
      if (lines[i].includes('<script>')) inScript = true;
      continue;
    }
    if (lines[i].includes('</script>')) break;
    if (lines[i].includes('`')) {
      offenders.push({
        line: i + 1,
        text: lines[i].trim(),
        reason: 'backtick inside the <script> body, which is emitted verbatim inside an outer template literal, so this backtick ends that literal early',
      });
    }
  }
}

// --- Check 1b: no backtick inside a STYLE comment ---------------------------------------------
//
// Added after the CSS half of exactly this hazard got through and broke the build. Check 1 looked only
// at the `<script>` body, so three backticks written inside a CSS comment were never examined — the
// balance check below counted them as pairing with each other, which they did, while the build failed
// with `Expected ";" but found "warn"` from a rule that had been cut in half.
//
// Deliberately narrower than "the whole <style> element": the stylesheet is a template literal that
// contains `${...}` interpolations and is concatenated with others, so a rule forbidding every backtick
// between the tags would reject the file's actual structure. What is never legitimate is a backtick in
// a CSS COMMENT — there it is prose, and prose is where this keeps happening.
{
  let inComment = false;
  let inStyles = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Only inside the stylesheet, which starts at the STYLES assignment and is not the whole document.
    if (!inStyles) {
      if (/const STYLES = `/.test(line)) inStyles = true;
      continue;
    }
    if (/^`;/.test(line.trim())) break;

    if (inComment) {
      if (line.includes('`')) {
        offenders.push({
          line: i + 1,
          text: line.trim(),
          reason: 'backtick inside a CSS comment: the stylesheet is one template literal, so this ends it early. This exact mistake shipped once and broke the build.',
        });
      }
      if (line.includes('*/')) inComment = false;
      continue;
    }

    const open = line.indexOf('/*');
    if (open === -1) continue;
    const close = line.indexOf('*/', open + 2);
    const comment = close === -1 ? line.slice(open) : line.slice(open, close + 2);
    if (comment.includes('`')) {
      offenders.push({
        line: i + 1,
        text: line.trim(),
        reason: 'backtick inside a CSS comment: the stylesheet is one template literal, so this ends it early. This exact mistake shipped once and broke the build.',
      });
    }
    if (close === -1) inComment = true;
  }
}

for (let i = 0; i < lines.length; i++) {
	const line = lines[i];

	if (!inTemplate) {
		// A line that opens a template literal: contains a backtick not inside a comment or a string.
		const withoutLineComment = line.replace(/\/\/.*$/, '');
		const opens = (withoutLineComment.match(/`/g) || []).length;
		if (opens % 2 === 1) {
			inTemplate = true;
			templateStartLine = i + 1;
		}
		continue;
	}

	// (The per-region backtick check that replaces the naive one lives above, before this loop.)
	// The region ends on a line whose first backtick closes it.
	const closeIndex = line.indexOf('`');
	if (closeIndex >= 0) {
		// Anything after the closing backtick on this line is code again; check for a further
		// backtick, which would open a new literal and is fine.
		inTemplate = false;
		continue;
	}

	// No backtick on this line: any stray one cannot exist, so look for the other hazard —
	// an unescaped `${` in a place that is not meant to interpolate. Those are legitimate for the
	// few real interpolations, so only report them when they look like prose rather than code.
	const strayInterp = /\$\{(?![A-Za-z_$])/.exec(line);
	if (strayInterp) {
		offenders.push({ line: i + 1, text: line.trim(), reason: 'looks like a literal "${" that is not an interpolation' });
	}
}

// The real check: a balanced count of backticks is what the parser needs, but the failure mode is a
// backtick *inside* a region. Re-run with an explicit scan for nested backticks.
inTemplate = false;
for (let i = 0; i < lines.length; i++) {
	const line = lines[i];
	if (!inTemplate) {
		const withoutLineComment = line.replace(/\/\/.*$/, '');
		if ((withoutLineComment.match(/`/g) || []).length % 2 === 1) {
			inTemplate = true;
			templateStartLine = i + 1;
		}
		continue;
	}
	const closeIndex = line.indexOf('`');
	if (closeIndex === -1) continue;

	// This line closes the template. If there is another backtick later on the same line, that is a
	// second literal opening; only flag text that cannot be code.
	const rest = line.slice(closeIndex + 1);
	inTemplate = false;
	if (/^\s*[A-Za-z]/.test(rest) && rest.trim() !== ';') {
		offenders.push({
			line: i + 1,
			text: line.trim(),
			reason: `template opened at line ${templateStartLine} closes here but is followed by "${rest.trim()}"`,
		});
	}
}

// Second hazard: a JS string literal inside the embedded <script> that contains a real newline.
// Writing '\n' in a TypeScript template literal produces an ACTUAL newline in the emitted HTML, so
// the browser sees an unterminated string spanning two lines and the whole inline script fails with
// "Invalid or unexpected token" — while the page still renders, which makes it look like a layout
// bug rather than a syntax error. Inside the template the escape must be doubled: '\\n'.
const newlineInString = [];
let inScript = false;
let inBlockComment = false;
let quote = null;

for (let i = 0; i < lines.length; i++) {
	const line = lines[i];
	if (/<script>/.test(line)) { inScript = true; continue; }
	if (/<\/script>/.test(line)) { inScript = false; quote = null; inBlockComment = false; continue; }
	if (!inScript) continue;

	// Comments are skipped entirely: prose contains apostrophes ("the machine's filesystem") that
	// would otherwise be read as string delimiters and produce a false positive.
	if (inBlockComment) {
		if (line.includes('*/')) inBlockComment = false;
		continue;
	}

	let j = 0;
	if (quote === null && /^\s*\/\*/.test(line)) { inBlockComment = !line.includes('*/', line.indexOf('/*') + 2); continue; }
	while (j < line.length) {
		const ch = line[j];
		if (quote === null) {
			if (ch === '/' && line[j + 1] === '/') break;          // line comment
			if (ch === '/' && line[j + 1] === '*') break;          // block comment opens
			if (ch === "'" || ch === '"') quote = ch;
			j++;
			continue;
		}
		if (ch === '\\') { j += 2; continue; }                     // escaped char
		if (ch === quote) { quote = null; }
		j++;
	}

	// An unterminated literal at end of line is legal ONLY if the line ends with a backslash
	// continuation, which this codebase does not use.
	if (quote !== null && !line.trimEnd().endsWith('\\')) {
		newlineInString.push({ line: i + 1, text: line.trim() });
		quote = null;
	}
}

// Third hazard: a CSS custom property that is used but never defined.
//
// This fails silently, which is why it needs a check rather than care. An undefined custom property is
// not an error in CSS: it resolves to nothing, so `border: 1px solid var(--missing)` simply renders no
// border and `background: var(--missing)` renders no background. The page still loads and still passes
// every test, and the only symptom is a panel that looks slightly wrong — which is easy to attribute to
// taste rather than to a typo.
//
// It happened while adding the shared-links panel: four variable names were invented that did not exist
// in this stylesheet, and every one of them would have quietly done nothing.
const undefinedVars = [];
{
	const defined = new Set();
	for (const match of source.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(match[1]);

	for (let i = 0; i < lines.length; i++) {
		// Only the stylesheet uses these; a `var(--x)` elsewhere would be prose about CSS.
		for (const match of lines[i].matchAll(/var\((--[a-z0-9-]+)/g)) {
			const name = match[1];
			if (!defined.has(name)) {
				undefinedVars.push({ line: i + 1, text: lines[i].trim(), reason: `${name} is used but never defined in this stylesheet` });
			}
		}
	}
}

if (undefinedVars.length) {
	console.error('\nUI template guard: undefined CSS custom properties in src/ui.ts\n');
	console.error('  These resolve to nothing and fail silently, so the page renders without them.\n');
	for (const o of undefinedVars) {
		console.error(`  line ${o.line}: ${o.reason}`);
		console.error(`    ${o.text}\n`);
	}
	process.exit(1);
}

// --- Check: every translation key used must exist in EVERY locale ------------------------------
//
// The same silent-failure shape as the CSS variables above, and found the same way — by doing the check
// by hand while adding a panel, and then asking why nothing did it automatically. A `t()` call naming a
// key that does not exist renders the KEY ITSELF: the panel shows `merges.needName` where a sentence
// belongs. Nothing errors, no test fails, and it is invisible to anyone who does not read that locale.
//
// It is worse for the non-English locales, because the author of a new panel is usually working in one
// language and adding the other three afterwards: a missing translation is exactly the case likely to be
// missed, and exactly the case nobody reviewing in English will notice.
const translationProblems = [];
{
	// Keys the script asks for, from `t('key')` and `data-i18n="key"`.
	const used = new Set();
	for (const match of source.matchAll(/\bt\(\s*'([a-zA-Z][\w.]*)'/g)) used.add(match[1]);
	for (const match of source.matchAll(/data-i18n="([^"]+)"/g)) used.add(match[1]);

	// Each locale block. Three details were all wrong on the first three attempts at this line, each found by
	// printing rather than by re-reading: the blocks are indented with TWO tabs, the keys are bare identifiers for
	// `en` and `ja` but quoted for `zh-CN` and `zh-TW`, and there is no carriage return to allow for. A check
	// that silently finds nothing is worse than no check, so it asserts the count below instead of trusting this.
	const localeStarts = [];
	for (const match of source.matchAll(/^\t{2}(?:'([a-z]{2}(?:-[A-Z]{2})?)'|([a-z]{2})):\s*\{$/gm)) {
		localeStarts.push({ code: match[1] ?? match[2], index: match.index });
	}

	if (localeStarts.length < 4) {
		translationProblems.push({ reason: `expected four locale blocks, found ${localeStarts.length}: ${localeStarts.map((l) => l.code).join(', ')}` });
	} else {
		const union = new Set();
		for (let i = 0; i < localeStarts.length; i++) {
			const start = localeStarts[i].index;
			const end = i + 1 < localeStarts.length ? localeStarts[i + 1].index : source.length;
			const block = source.slice(start, end);
			const defined = new Set();
			for (const match of block.matchAll(/^\t{3}'([^']+)':/gm)) defined.add(match[1]);
			for (const key of defined) union.add(key);

			// Reported per locale, because "missing from Japanese" is the case nobody reviewing in English sees.
			const missing = [...used].filter((key) => !defined.has(key));
			if (missing.length) {
				translationProblems.push({
					reason: `${localeStarts[i].code} is missing ${missing.length} used key(s): ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? `, and ${missing.length - 8} more` : ''}`,
				});
			}
		}

		// The other direction, and it is the one that catches a typo at the CALL site: a `t('merges.neddName')`
		// names a key no locale defines, so it renders as the raw key. Checking only that locales are complete
		// would miss it, because both the call and the four dictionaries would be consistently wrong in the same
		// way — consistently absent looks exactly like consistently present.
		const orphans = [...used].filter((key) => !union.has(key));
		if (orphans.length) {
			translationProblems.push({
				reason: `used but defined in NO locale, so the raw key will be shown: ${orphans.join(', ')}`,
			});
		}
	}
}

if (translationProblems.length) {
	console.error('\nUI template guard: translation keys missing from a locale in src/ui.ts\n');
	console.error('  A t() call naming a key that does not exist renders the KEY, not a sentence.\n');
	for (const p of translationProblems) console.error(`  ${p.reason}`);
	process.exit(1);
}

if (newlineInString.length) {
	console.error('\nUI template guard: a JS string literal spans a line break in src/ui.ts\n');
	console.error('  Inside the template, write \\\\n instead of \\n so the escape reaches the browser.\n');
	for (const o of newlineInString) console.error(`  line ${o.line}: ${o.text}`);
	process.exit(1);
}

if (offenders.length) {
	console.error('\nUI template guard: problems found in src/ui.ts\n');
	for (const o of offenders) {
		console.error(`  line ${o.line}: ${o.reason}`);
		console.error(`    ${o.text}\n`);
	}
	process.exit(1);
}

console.log(`UI template guard: src/ui.ts parses as balanced template literals (${lines.length} lines)`);
