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
import vm from 'node:vm';
import { WORKFLOW_SCRIPT, WORKFLOW_STYLES, WORKFLOW_COPY } from '../src/ui-workflows.ts';

const file = new URL('../src/ui.ts', import.meta.url);
const source = readFileSync(file, 'utf8');
const lines = source.split('\n');

/** Regions that are the inside of a template literal: everything between a line ending in a
 *  backtick and the next line that is exactly a backtick followed by an optional statement end. */
const offenders = [];

/**
 * Replaces every `${...}` with a placeholder, keeping the newlines each one contained.
 *
 * The newlines matter: a reported line number is only useful if it still points at the same source line after
 * substitution, and an interpolation can span several lines. Brace depth is tracked rather than matching to the
 * first `}`, because an interpolation may contain an object literal or a nested template.
 */
function replaceInterpolations(text, placeholder) {
	let out = '';
	let i = 0;
	while (i < text.length) {
		if (text[i] === '$' && text[i + 1] === '{') {
			let depth = 1;
			let j = i + 2;
			let newlines = 0;
			while (j < text.length && depth > 0) {
				if (text[j] === '{') depth += 1;
				else if (text[j] === '}') depth -= 1;
				else if (text[j] === '\n') newlines += 1;
				j += 1;
			}
			out += placeholder + '\n'.repeat(newlines);
			i = j;
			continue;
		}
		out += text[i];
		i += 1;
	}
	return out;
}

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
	const clientSource = source + WORKFLOW_SCRIPT + WORKFLOW_STYLES;
	for (const match of clientSource.matchAll(/\bt\(\s*'([a-zA-Z][\w.]*)'\s*[,)]/g)) used.add(match[1]);
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
			for (const key of Object.keys(WORKFLOW_COPY[localeStarts[i].code] || {})) defined.add(key);
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

// --- Check 5: the EMITTED script must actually parse ------------------------------------------
//
// This is the decisive check, and it replaced a heuristic that had already failed once. The earlier
// check tracked string quotes and comments by hand to find a literal newline inside a string; it is a
// re-implementation of a JavaScript parser, and it missed one — `split('\n')` at line 1563, whose
// single backslash the outer template literal evaluated into a real line break. Everything the
// heuristic was approximating is answered exactly by parsing.
//
// The failure mode is worth stating because it does not look like a syntax error from outside: the
// page still RENDERS — HTML and CSS are delivered — but the whole client script dies, so no dialog
// appears, no data loads, and none of the styling the script applies is applied. It presents as "the
// layout is broken and the password prompt never showed up", which is what it was reported as.
//
// The transform below is the one the Worker performs: inside the template literal, an escape is
// evaluated. So a doubled backslash becomes one, and a single `\n` becomes a real newline. Only the
// <script> region is taken, because the surrounding TypeScript is not valid browser JavaScript.
{
	const start = source.indexOf('<script>');
	const end = source.indexOf('</script>', start + 1);
	if (start < 0 || end < 0) {
		console.error('\nUI template guard: could not locate the <script> region in src/ui.ts\n');
		process.exit(1);
	}

	const body = source.slice(start + '<script>'.length, end);

	// Two layers have to be modelled, and getting either wrong makes the check useless or noisy.
	//
	// LAYER 1 — the interpolations. `${...}` is TypeScript evaluated when the page is BUILT, and its VALUE lands
	// in the script. Leaving it as a literal `${` makes the emitted text unparseable for a reason that has
	// nothing to do with the script, so the check would fail on every run. Each is replaced, but its NEWLINES
	// are kept so a reported line number still points at the right source line.
	//
	// The replacement is `null` rather than a string, because a string would break any interpolation used in a
	// numeric or boolean position. `null` is syntactically valid wherever an interpolation is: as an operand, an
	// argument, an object value, or an array element. This check is about SYNTAX — whether the text is a
	// well-formed program — so substituting a value of the wrong type is harmless, and substituting one of the
	// wrong SHAPE would not be.
	const withPlaceholders = replaceInterpolations(body, 'null');

	// LAYER 2 — the escaping. The Worker's template literal evaluates one level of it, exactly as the language
	// specifies, and the mapping has to be the real one rather than "drop the backslash". The earlier version
	// replaced `\` + any character with that character, which turns `\n` into the LETTER n — so `split('\n')`
	// became `split('n')`, which parses perfectly. The check could not fail on the very defect it was written for,
	// and it reported success on a source that broke the live page. `\n` must become a NEWLINE.
	let emitted = withPlaceholders.replace(/\\\$\{/g, '${').replace(/\\([\s\S])/g, (_m, ch) => {
		switch (ch) {
			case 'n':
				return '\n';
			case 't':
				return '\t';
			case 'r':
				return '\r';
			case 'b':
				return '\b';
			case 'f':
				return '\f';
			case 'v':
				return '\v';
			case '0':
				return '\0';
			case '\n': // a line continuation: the backslash and the newline both vanish
				return '';
			default:
				// `\\`, `\'`, `\"`, `` \` ``, `\$` and anything else: the backslash is consumed and the character
				// stands for itself.
				return ch;
		}
	});
	// The imported workflow is already emitted text; applying template escapes a second time would corrupt it.
	const workflowLine = body.slice(0, body.indexOf('${WORKFLOW_SCRIPT}')).split('\n').length - 1;
	const emittedLines = emitted.split('\n');
	if (body.includes('${WORKFLOW_SCRIPT}')) emittedLines[workflowLine] = WORKFLOW_SCRIPT;
	emitted = emittedLines.join('\n');

	try {
		new vm.Script(emitted, { filename: 'emitted-ui-script.js' });
	} catch (err) {
		console.error('\nUI template guard: the script EMITTED to the browser does not parse\n');
		console.error('  The page would still render, but no dialog would appear and no script-applied styling');
		console.error('  would be applied — it looks like a layout bug, not a syntax error.\n');
		console.error(`  ${err.message}\n`);
		// The offset is into the transformed text, so the reported line is the emitted line. Show it.
		const lineNo = Number(/emitted-ui-script\.js:(\d+)/.exec(err.stack ?? '')?.[1] ?? 0);
		if (lineNo) {
			const emittedLines = emitted.split('\n');
			for (let k = Math.max(0, lineNo - 3); k < Math.min(emittedLines.length, lineNo + 2); k++) {
				console.error(`  ${k + 1}: ${emittedLines[k].slice(0, 150)}`);
			}
		}
		process.exit(1);
	}

	// --- Check 5b: the emitted script must actually RUN ------------------------------------------
	//
	// A separate defect from the one above, and it was hidden BEHIND it for as long as that one lasted: a script
	// that never runs hides every fault behind its first. With the syntax error fixed, the page still showed no
	// password prompt, because `$` was declared with `var` near the bottom of the file while the gate's own
	// top-level code called it at the top. `var` hoists as `undefined`, so the FIRST such call threw
	// `$ is not a function` and the whole script stopped — after parsing perfectly.
	//
	// Parsing cannot see this, so the check executes the script instead. The globals are deliberately thin: the
	// aim is to reach the first genuine fault, not to emulate a browser. Anything the page legitimately needs that
	// is missing here shows up as a ReferenceError attributed to a global, which is a false positive and is
	// reported as such rather than as a failure — while a missing helper the page defines ITSELF has no global to
	// blame and is exactly the class of defect being hunted.
	{
		const missingGlobals = new Set();
		const makeEl = () => {
			const el = {
				style: {},
				dataset: {},
				children: [],
				attributes: {},
				textContent: '',
				innerHTML: '',
				value: '',
				checked: false,
				hidden: false,
				className: '',
				classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
				setAttribute() {},
				getAttribute: () => null,
				removeAttribute() {},
				appendChild: (c) => c,
				append() {},
				removeChild() {},
				remove() {},
				insertBefore: (c) => c,
				replaceChildren() {},
				addEventListener() {},
				removeEventListener() {},
				querySelector: () => null,
				querySelectorAll: () => [],
				closest: () => null,
				focus() {},
				blur() {},
				click() {},
				getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }),
			};
			return el;
		};

		const documentStub = {
			documentElement: makeEl(),
			body: makeEl(),
			head: makeEl(),
			title: '',
			cookie: '',
			readyState: 'complete',
			visibilityState: 'visible',
			activeElement: null,
			createElement: makeEl,
			createTextNode: (t) => ({ textContent: t }),
			getElementById: () => makeEl(),
			querySelector: () => null,
			querySelectorAll: () => [],
			addEventListener() {},
			removeEventListener() {},
		};

		// `Proxy` with a `has` trap returning true for everything makes a bare global read of `foo` yield a stub
		// rather than a ReferenceError, so the run is not stopped by an environment gap. The stub is CALLABLE AND
		// INDEXABLE — a plain function would fail at `String(stub).toLowerCase()` and stop the run for a reason
		// that has nothing to do with the page. Names that are not real globals are recorded, which is how a
		// genuinely missing helper is told apart from a browser API this stub merely does not model.
		const realGlobals = new Set(Object.getOwnPropertyNames(globalThis));
		const stubTarget = function () {};
		const stub = new Proxy(stubTarget, {
			get: (_t, prop) => {
				if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') return () => '';
				if (prop === Symbol.iterator) return function* () {};
				if (prop === 'then') return undefined; // not a thenable, or every await would hang on it
				if (prop === 'length') return 0;
				if (prop === 'name') return 'stub';
				return stub;
			},
			apply: () => stub,
			construct: () => stub,
			has: () => true,
		});
		const sandbox = {
			document: documentStub,
			window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), location: { href: '' }, localStorage: { getItem: () => null, setItem() {} } },
			navigator: { language: 'en', languages: ['en'], clipboard: { writeText: async () => {} } },
			location: { href: '', search: '', hash: '' },
			localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
			matchMedia: () => ({ matches: false, addEventListener() {} }),
			fetch: () => new Promise(() => {}),
			setTimeout: () => 0,
			clearTimeout() {},
			setInterval: () => 0,
			clearInterval() {},
			requestAnimationFrame: () => 0,
			console: { log() {}, warn() {}, error() {} },
		};

		let runtimeError = null;
		try {
			const ctx = vm.createContext(
				new Proxy(sandbox, {
					has: () => true,
					get(target, key) {
						if (key === Symbol.unscopables) return undefined;
						if (typeof key === 'string' && !(key in target) && !realGlobals.has(key)) missingGlobals.add(key);
						return key in target ? target[key] : stub;
					},
				}),
			);
			new vm.Script(emitted, { filename: 'emitted-ui-script.js' }).runInContext(ctx, { timeout: 10000 });
		} catch (err) {
			runtimeError = err;
		}

		if (runtimeError) {
			// A ReferenceError naming something that is not a known global is the page's own missing binding.
			const missing = /(\w+) is not defined/.exec(runtimeError.message);
			// `X is not a function` where X is something the page ITSELF assigns is the defect this check exists
			// for: the binding exists, so its value is undefined — "used before it was assigned". Blaming the stub
			// for that is how a check reports success on a broken page, which has already happened once in this
			// file, where the escape transform turned the defect into valid code.
			//
			// Matched with plain string work rather than a constructed RegExp: the name can be `$`, which is a
			// regex anchor, and interpolating it into a pattern silently changed what was being looked for. The
			// mutation this check exists to catch passed for exactly that reason.
			const notAFunction = /([A-Za-z_$][\w$]*) is not a function/.exec(runtimeError.message);
			const named = notAFunction?.[1];
			const assignKeywords = ['var ', 'let ', 'const '];
			const ownBinding =
				named !== undefined &&
				assignKeywords.some((kw) => emitted.includes(`${kw}${named} `) || emitted.includes(`${kw}${named}=`) || emitted.includes(`${kw}${named}\t`));
			// `instanceof` CANNOT be used here, and that is not a style preference: the error is constructed inside the
			// `vm` context, which has its OWN `TypeError` and `ReferenceError` constructors, so `err instanceof
			// TypeError` is false in this realm no matter what the error is. The check therefore declined to fire
			// while its own diagnostic printed `ownBinding=true` — it was right about the fault and wrong about the
			// test. Identity across realms is compared by NAME.
			const kind = runtimeError?.constructor?.name ?? '';
			const ownFault =
				(kind === 'ReferenceError' && missing !== null && !realGlobals.has(missing[1])) ||
				(kind === 'TypeError' && (ownBinding || (missing !== null && !realGlobals.has(missing[1]))));

			// The detection is reported when it declines to fire. A check that silently decides "not my fault" is
			// indistinguishable from one that works, and this one declined for a reason worth seeing.
			if (!ownFault) {
				console.log(
					`UI template guard: not treated as a page fault — kind=${kind} name=${JSON.stringify(named)} ownBinding=${ownBinding}`,
				);
			}

			if (ownFault) {				console.error('\nUI template guard: the emitted script throws at load, so nothing on the page works\n');
				console.error('  It parses, which is why this is separate from the check above: a parse check cannot see');
				console.error('  a binding that is used before it is assigned.\n');
				console.error(`  ${runtimeError.message}\n`);
				const lineNo = Number(/emitted-ui-script\.js:(\d+)/.exec(runtimeError.stack ?? '')?.[1] ?? 0);
				if (lineNo) {
					const emittedLines = emitted.split('\n');
					for (let k = Math.max(0, lineNo - 4); k < Math.min(emittedLines.length, lineNo + 3); k++) {
						console.error(`  ${k + 1}: ${emittedLines[k].slice(0, 150)}`);
					}
				}
				process.exit(1);
			}
			// Anything else is this stub's limit rather than the page's fault, and is said so rather than swallowed.
			console.log(`UI template guard: script execution stopped at a non-binding error, treated as a stub limit: ${runtimeError.message.slice(0, 120)}`);
		}

		if (missingGlobals.size) {
			console.log(`UI template guard: note — the stub did not model ${missingGlobals.size} global(s) the page reads: ${[...missingGlobals].slice(0, 8).join(', ')}`);
		}
	}
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
