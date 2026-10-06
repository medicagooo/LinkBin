/**
 * Guards the UI template against a mistake that has now cost two build failures.
 *
 * `src/ui.ts` embeds a whole HTML document — including `<style>` and `<script>` — inside TypeScript
 * template literals. A backtick anywhere inside those regions terminates the literal early, and the
 * error esbuild then reports points at the end of the file rather than at the offending character,
 * which makes it slow to find. Two separate CSS/JS comments each containing a backtick caused this.
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

	// Inside a template literal. The region ends on a line whose first backtick closes it.
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
