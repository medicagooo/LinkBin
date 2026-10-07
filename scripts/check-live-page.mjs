// Fetches the LIVE page and reports whether its inline script parses — the check that was missing, applied to the
// deployment rather than to the source. Kept as a script because "the page looks wrong" and "the script does not
// parse" are very different diagnoses that look identical in a browser.
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

const url = process.argv[2] ?? 'https://linkbin.cyc-xiaochen.workers.dev/';
const html = execFileSync('curl', ['-s', url], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

console.log(`fetched ${html.length} characters from ${url}`);

const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).filter((s) => s.trim());
console.log(`inline script blocks: ${scripts.length}`);

let bad = 0;
scripts.forEach((s, i) => {
	try {
		new vm.Script(s, { filename: `live-${i}.js` });
		console.log(`  script[${i}]: PARSES (${s.length} chars)`);
	} catch (err) {
		bad += 1;
		console.log(`  script[${i}]: DOES NOT PARSE -> ${err.message}`);
		const line = Number(new RegExp(`live-${i}\\.js:(\\d+)`).exec(err.stack ?? '')?.[1] ?? 0);
		if (line) {
			const L = s.split('\n');
			for (let k = Math.max(0, line - 2); k < Math.min(L.length, line + 1); k++) {
				console.log(`      ${k + 1}: ${L[k].slice(0, 130)}`);
			}
		}
	}
});

// The markers that prove which build this is, so a stale deployment cannot be mistaken for a fixed one.
console.log('\nmarkers:');
for (const m of ['browse.seenAgo', 'fresh.worst', 'agoMachineSeconds', 'mergePatterns']) {
	console.log(`  ${m}: ${html.includes(m) ? 'present' : 'absent'}`);
}

console.log(bad ? '\nLIVE PAGE IS BROKEN' : '\nLIVE PAGE SCRIPT PARSES');
process.exit(bad ? 1 : 0);
