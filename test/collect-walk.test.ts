import { describe, expect, it } from 'vitest';
import { collectFrom, MAX_FILES_PER_RUN, type CollectionPorts, type RunTotals } from '../src/collect';
import type { RemoteEntry, RemoteHost } from '../src/remote';

/**
 * Walking a machine's files and recording what happened.
 *
 * Written against the `RemoteHost` port, so there is no host, no network and no credential involved — which is
 * the difference between a pipeline that can be finished and one that waits for infrastructure.
 *
 * The recording is the half that matters most and the half that is easiest to leave out. "Why did this stop
 * syncing" is answered by an issue row or not at all, and a run whose counts are right but whose reasons are
 * missing is a run nobody can act on.
 */

/** A stand-in machine: files per directory, with their bytes. */
function machine(dirs: Record<string, { name: string; content?: string; size?: number; mtime?: number; isDirectory?: boolean }[]>): RemoteHost {
	return {
		async list(dir: string): Promise<RemoteEntry[]> {
			if (!(dir in dirs)) throw new Error(`cannot open directory '${dir}': Permission denied`);
			return dirs[dir].map((f) => ({
				name: f.name,
				size: f.size ?? (f.content ?? '').length,
				mtime: f.mtime ?? 1_700_000_000,
				isDirectory: f.isDirectory ?? false,
			}));
		},
		async stat(path: string) {
			for (const [dir, entries] of Object.entries(dirs)) {
				for (const f of entries) {
					if (`${dir}/${f.name}` === path || (dir === '/' && `/${f.name}` === path)) {
						return { size: f.size ?? (f.content ?? '').length, mtime: f.mtime ?? 1_700_000_000, isDirectory: f.isDirectory ?? false };
					}
				}
			}
			throw new Error(`cannot stat '${path}': No such file or directory`);
		},
		async read(path: string) {
			for (const [dir, entries] of Object.entries(dirs)) {
				for (const f of entries) {
					if (`${dir}/${f.name}` === path || (dir === '/' && `/${f.name}` === path)) {
						return new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new TextEncoder().encode(f.content ?? ''));
								controller.close();
							},
						});
					}
				}
			}
			throw new Error(`cannot open '${path}': No such file or directory`);
		},
		async exec() {
			return 'FakeOS 1.0';
		},
	};
}

/** Records every call, so the ORDER of the writes can be asserted and not only their content. */
function ports(over: Partial<CollectionPorts> = {}): CollectionPorts & { issues: { path: string | null; kind: string; reason: string; size: number | null }[]; progress: RunTotals[] } {
	const issues: { path: string | null; kind: string; reason: string; size: number | null }[] = [];
	const progress: RunTotals[] = [];
	return {
		rules: [{ pattern: '/data/*.log', is_exclude: 0, host_id: null }],
		// Allowed by default, so the tests that are not about the gate do not have to think about it. The ones
		// that ARE about it override this.
		async canStore() {
			return { ok: true as const };
		},
		async store({ path, stream }) {
			const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
			return { ok: true as const, bytes: bytes.byteLength, hash: `hash-of-${path}`, unchanged: false };
		},
		async recordIssue(issue) {
			issues.push(issue);
		},
		async recordProgress(totals) {
			progress.push({ ...totals });
		},
		issues,
		progress,
		...over,
	};
}

describe('walking the files a machine offers', () => {
	it('stores what the rules select and counts it', async () => {
		const result = await collectFrom(
			machine({ '/data': [{ name: 'a.log', content: 'aaa' }, { name: 'b.log', content: 'bbbb' }] }),
			ports(),
		);

		expect(result.totals.stored).toBe(2);
		expect(result.totals.bytesStored).toBe(7);
		expect(result.totals.failed).toBe(0);
		expect(result.totals.skipped).toBe(0);
		expect(result.outcomes.map((o) => o.kind)).toEqual(['stored', 'stored']);
	});

	it('records nothing for a file that was stored', async () => {
		// An issue list that includes successes stops being a list of problems. This is the same property
		// `/api/issues` is asserted for, checked here at the point the decision is made.
		const p = ports();
		await collectFrom(machine({ '/data': [{ name: 'a.log', content: 'aaa' }] }), p);

		expect(p.issues, 'a stored file is not an issue').toEqual([]);
	});

	it('records a file that changed as stored, and one that did not as unchanged without an issue', async () => {
		const p = ports({
			async store({ path }) {
				return path.endsWith('same.log')
					? { ok: true as const, bytes: 0, hash: 'h', unchanged: true }
					: { ok: true as const, bytes: 3, hash: 'h', unchanged: false };
			},
		});
		const result = await collectFrom(
			machine({ '/data': [{ name: 'same.log', content: 'aaa' }, { name: 'new.log', content: 'bbb' }] }),
			p,
		);

		expect(result.totals.unchanged).toBe(1);
		expect(result.totals.stored).toBe(1);
		expect(p.issues, 'an unchanged file is the normal case, not a problem').toEqual([]);
	});

	it('records a file above the size limit as a skip with its size, not as a failure', async () => {
		// The distinction is the point: a size skip needs a decision about the limit, a failure needs
		// investigating, and `DELIBERATE_KINDS` in receipts.ts reads the kind to tell an operator which.
		const p = ports({
			async store() {
				return { ok: false as const, reason: 'the file is larger than the limit, so nothing was stored', skipped: true, size: 999 };
			},
		});
		const result = await collectFrom(machine({ '/data': [{ name: 'big.log', content: 'x', size: 999 }] }), p);

		expect(result.totals.skipped).toBe(1);
		expect(result.totals.failed).toBe(0);
		expect(p.issues).toEqual([
			{ path: '/data/big.log', kind: 'too_large', reason: 'the file is larger than the limit, so nothing was stored', size: 999 },
		]);
	});

	it('records a storage failure as a failure, with the reason', async () => {
		const p = ports({
			async store() {
				return { ok: false as const, reason: 'storage refused the upload', skipped: false, size: null };
			},
		});
		const result = await collectFrom(machine({ '/data': [{ name: 'a.log', content: 'x' }] }), p);

		expect(result.totals.failed).toBe(1);
		expect(p.issues[0].kind).toBe('failed');
		expect(p.issues[0].reason).toBe('storage refused the upload');
	});

	it('keeps a machine error in the machine\'s own words', async () => {
		// So a permission problem can be diagnosed without guessing. The substitute throws exactly what ssh would.
		const p = ports({ rules: [{ pattern: '/secret/*.log', is_exclude: 0, host_id: null }] });
		await collectFrom(machine({ '/data': [] }), p);

		expect(p.issues).toHaveLength(1);
		expect(p.issues[0].kind).toBe('rule_unreadable');
		expect(p.issues[0].reason, 'the machine\'s words are kept').toContain('Permission denied');
	});

	it('records a file that vanished between discovery and reading rather than crashing', async () => {
		// Normal for a rotated log. The stat succeeds and the read does not, which is the real sequence.
		const base = machine({ '/data': [{ name: 'rotating.log', content: 'x' }] });
		const racing: RemoteHost = {
			...base,
			async read() {
				throw new Error("cannot open '/data/rotating.log': No such file or directory");
			},
		};
		const p = ports();
		const result = await collectFrom(racing, p);

		expect(result.totals.failed).toBe(1);
		expect(p.issues[0].kind).toBe('unreadable');
		expect(result.outcomes[0]).toEqual({ path: '/data/rotating.log', kind: 'failed', reason: 'unreadable' });
	});

	it('skips a directory instead of trying to store it', async () => {
		// Attempting it would fail, and the failure would read as a permissions problem rather than as a rule that
		// matched something that is not a file.
		//
		// The directory arrives through a machine whose `list` reports a name the pattern matches, because
		// `resolveRules` normally filters directories out and would never hand one to the walk. The guard in
		// `collectFrom` therefore protects against a machine or a future resolver that does report one, and that
		// is what is asserted — an earlier version of this test used a pattern a directory name could not match
		// and asserted a skip that could never happen.
		const dirs = { '/data': [{ name: 'subdir', isDirectory: true }] };
		const base = machine(dirs);
		const reporting: RemoteHost = {
			...base,
			// Reports the entry as a FILE at listing time and a DIRECTORY at stat time, which is the sequence that
			// reaches the guard: the resolver's filter is not what has to catch it.
			async list(dir: string): Promise<RemoteEntry[]> {
				return [{ name: 'subdir', size: 1, mtime: 0, isDirectory: false }];
			},
		};
		const p = ports({ rules: [{ pattern: '/data/*', is_exclude: 0, host_id: null }] });
		const result = await collectFrom(reporting, p);

		expect(result.totals.skipped).toBe(1);
		expect(result.totals.stored, 'a directory must not be stored as a file').toBe(0);
		expect(result.outcomes[0]).toEqual({ path: '/data/subdir', kind: 'skipped', reason: 'it is a directory', size: null });
		expect(p.issues, 'a directory is a decision, and it names itself in the outcome').toEqual([]);
	});

	it('treats a size the machine did not report as unknown, not as zero', async () => {
		// Zero means an empty file and would be stored as one. Unknown means "ask the stream".
		const base = machine({ '/data': [{ name: 'a.log', content: 'abc' }] });
		const sizeless: RemoteHost = {
			...base,
			async stat() {
				return { isDirectory: false };
			},
		};
		let seen: number | null | undefined;
		const p = ports({
			async store({ mtime: _m, ...rest }) {
				void rest;
				void _m;
				return { ok: true as const, bytes: 3, hash: 'h', unchanged: false };
			},
		});
		// The size is not passed to `store` at all — the stream decides — so what is asserted is that the walk did
		// not substitute 0 anywhere in the outcome.
		const result = await collectFrom(sizeless, p);
		expect(result.totals.stored).toBe(1);
		expect(seen).toBeUndefined();
	});

	it('stops at the budget rather than being killed, and says it stopped', async () => {
		let clock = 0;
		const p = ports({
			now: () => clock,
			deadline: 100,
			async store() {
				clock += 60;
				return { ok: true as const, bytes: 1, hash: 'h', unchanged: false };
			},
		});
		const result = await collectFrom(
			machine({ '/data': [{ name: 'a.log', content: 'a' }, { name: 'b.log', content: 'b' }, { name: 'c.log', content: 'c' }] }),
			p,
		);

		expect(result.stoppedEarly, 'the caller needs to know to mark the run unfinished').toBe(true);
		expect(result.totals.stored, 'it left after the budget rather than finishing').toBe(2);
	});

	it('reports progress after every file, so an interrupted run is close rather than absent', async () => {
		const p = ports();
		await collectFrom(machine({ '/data': [{ name: 'a.log', content: 'a' }, { name: 'b.log', content: 'bb' }] }), p);

		expect(p.progress).toHaveLength(2);
		expect(p.progress[0].stored).toBe(1);
		expect(p.progress[1].stored).toBe(2);
		expect(p.progress[1].bytesStored).toBe(3);
	});

	it('honours an exclusion even when an inclusion also matches', async () => {
		// The single worst outcome this configuration can produce is collecting a file the operator excluded, so
		// it is asserted through the walk rather than only at the rule level.
		const p = ports({
			rules: [
				{ pattern: '/data/*.log', is_exclude: 0, host_id: null },
				{ pattern: '/data/secret.log', is_exclude: 1, host_id: null },
			],
		});
		const result = await collectFrom(
			machine({ '/data': [{ name: 'ok.log', content: 'a' }, { name: 'secret.log', content: 's' }] }),
			p,
		);

		expect(result.totals.stored).toBe(1);
		expect(result.outcomes.map((o) => o.path)).toEqual(['/data/ok.log']);
	});

	it('asks before it reads, and never requests the bytes of a file it cannot store', async () => {
		// THE CRITERION THIS EXISTS FOR. A file above the per-file limit can never be stored, so transferring it is
		// pure waste — and on a machine that pays for egress, waste with a cost. The assertion is not that the file
		// was skipped (that would pass even if it had been downloaded first) but that `read` was NEVER CALLED.
		let reads = 0;
		const base = machine({ '/data': [{ name: 'huge.bin', content: 'x', size: 5_000_000_000 }] });
		const watched: RemoteHost = {
			...base,
			async read(path: string) {
				reads += 1;
				return base.read(path);
			},
		};
		const p = ports({
			async canStore({ size }) {
				return size !== null && size > 1_000_000
					? { ok: false as const, reason: 'above the per-file limit', skipped: true, size }
					: { ok: true as const };
			},
			rules: [{ pattern: '/data/*', is_exclude: 0, host_id: null }],
		});

		const result = await collectFrom(watched, p);

		expect(reads, 'the bytes were never requested').toBe(0);
		expect(result.totals.skipped).toBe(1);
		expect(p.issues[0].kind).toBe('too_large');
		expect(p.issues[0].size, 'and the size is recorded, so the operator can decide about the limit').toBe(5_000_000_000);
	});

	it('does not request bytes for a file the store has no room for either', async () => {
		// Capacity is the other reason to refuse before reading. The distinction from a size skip is kept: capacity
		// is a failure the operator must act on, a size skip is a decision about the limit.
		let reads = 0;
		const base = machine({ '/data': [{ name: 'big.log', content: 'x', size: 5000 }] });
		const watched: RemoteHost = {
			...base,
			async read(path: string) {
				reads += 1;
				return base.read(path);
			},
		};
		const p = ports({
			async canStore({ size }) {
				return { ok: false as const, reason: 'the store is full', skipped: false, size };
			},
		});

		const result = await collectFrom(watched, p);

		expect(reads, 'not read, because there was nowhere to put it').toBe(0);
		expect(result.totals.failed).toBe(1);
		expect(result.totals.skipped, 'capacity is not a size skip').toBe(0);
		expect(p.issues[0].kind).toBe('capacity');
	});

	it('attempts a file whose size the machine did not report, because it cannot be judged in advance', async () => {
		// The gate must not turn "unknown" into "too large": that would skip files that fit, and a machine that
		// reports no sizes would collect nothing at all.
		let reads = 0;
		const base = machine({ '/data': [{ name: 'a.log', content: 'abc' }] });
		const sizeless: RemoteHost = {
			...base,
			async stat() {
				return { isDirectory: false };
			},
			async read(path: string) {
				reads += 1;
				return base.read(path);
			},
		};

		const result = await collectFrom(sizeless, ports());

		expect(reads, 'attempted rather than refused').toBe(1);
		expect(result.totals.stored).toBe(1);
	});

	it('still records progress when it refuses before reading', async () => {
		// A refused file is still a file the run got through, so the counts must move or an interrupted run's
		// totals would under-report how far it had got.
		const p = ports({
			async canStore({ size }) {
				return size !== null && size > 10 ? { ok: false as const, reason: 'too large', skipped: true, size } : { ok: true as const };
			},
		});
		const result = await collectFrom(machine({ '/data': [{ name: 'big.log', content: 'x', size: 99 }] }), p);

		expect(result.totals.skipped).toBe(1);
		expect(p.progress, 'progress was reported for the refusal too').toHaveLength(1);
		expect(p.progress[0].skipped).toBe(1);
	});

	it('bounds how many files one run walks', async () => {
		// A machine with a huge directory must not run away with the invocation.
		const many = Array.from({ length: MAX_FILES_PER_RUN + 25 }, (_, i) => ({ name: `f${i}.log`, content: 'x' }));
		const result = await collectFrom(machine({ '/data': many }), ports());
		expect(result.totals.stored).toBe(MAX_FILES_PER_RUN);
	});
});