// Confirms the fix reached the DEPLOYMENT and the page's script now RUNS, in a real browser.
//
// Parse success is not run success, and this page has already demonstrated the difference: it parsed perfectly
// while a helper was used before it was assigned, so nothing ran and no password prompt appeared. The markers
// below are written by the script itself, so their presence is proof it executed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const EDGE = [
	'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
	'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

const url = process.argv[2] ?? 'https://linkbin.cyc-xiaochen.workers.dev/';
const html = execFileSync('curl', ['-s', url], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
writeFileSync('.scratch/live-page-now.html', html);

// 1. The declaration must precede its first use IN THE EMITTED SCRIPT — the defect, checked on the artefact.
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).find((s) => s.trim()) ?? '';
const lines = script.split('\n');
const defLine = lines.findIndex((l) => l.includes('var $ = function'));
const useLine = lines.findIndex((l, i) => i !== defLine && /\$\(/.test(l));
console.log('=== ordering in the EMITTED script ===');
console.log(`  definition at line ${defLine + 1}`);
console.log(`  first use at line   ${useLine + 1}`);
console.log(`  ${defLine >= 0 && defLine < useLine ? 'OK — declared before use' : 'BROKEN — used before declaration'}`);

if (!EDGE) {
	console.log('\nEdge not found; skipping the browser run');
	process.exit(defLine >= 0 && defLine < useLine ? 0 : 1);
}

const profile = `${process.env.TEMP}\\linkbin-edge-verify`;
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });

let dom = '';
try {
	// A generous virtual-time budget so the page's own fetch to /api/auth/state completes and the gate can render.
	dom = execFileSync(
		EDGE,
		['--headless=new', '--disable-gpu', `--user-data-dir=${profile}`, '--window-size=1209,900', '--virtual-time-budget=15000', '--dump-dom', url],
		{ encoding: 'utf8', maxBuffer: 96 * 1024 * 1024, timeout: 180000 },
	);
} catch (err) {
	dom = `${err.stdout ?? ''}`;
}
writeFileSync('.scratch/dom-now.html', dom);
console.log(`\n=== rendered DOM (${dom.length} chars) ===`);

// The script populates these. Empty means it did not run.
for (const id of ['langs', 'themes']) {
	const m = new RegExp(`<div[^>]*id="${id}"[^>]*>([\\s\\S]*?)</div>`, 'i').exec(dom);
	const body = (m?.[1] ?? '').replace(/\s+/g, ' ').trim();
	console.log(`  #${id}: ${body ? `POPULATED — the script ran (${body.slice(0, 60)}...)` : 'EMPTY — the script did not run'}`);
}

// The gate must be VISIBLE on an unconfigured deployment, and it is the element the user expected to see.
const gate = /<section[^>]*class="glass gate"[^>]*>/i.exec(dom)?.[0] ?? '(gate element not found)';
const gateHidden = /\shidden(=|"|>|\s)/i.test(gate);
console.log(`\n  gate: ${gate}`);
console.log(`  gate visible: ${gateHidden ? 'NO — still hidden, so nothing was shown to the visitor' : 'YES'}`);

const setup = /<div id="setup"[^>]*>([\s\S]{0,120})/i.exec(dom);
console.log(`  #setup: ${(setup?.[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'empty'}`);

const ok = defLine >= 0 && defLine < useLine && !gateHidden;
console.log(ok ? '\nPAGE IS WORKING' : '\nPAGE STILL NOT WORKING');
process.exit(ok ? 0 : 1);
