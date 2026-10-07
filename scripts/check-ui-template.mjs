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
