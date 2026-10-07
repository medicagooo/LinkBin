import { env } from 'cloudflare:test';
import worker from '../src/index';
import { TEST_BASE_URL, TEST_MASTER_KEY } from './fixtures';
import { beforeEach, describe, expect, it } from 'vitest';
import { ABANDONED_AFTER_MS, abandonStaleSessions, closeSession, openSessions, recordMultipartSession, sessionIdFor } from '../src/multipart';

/**
 * Multipart uploads that outlive the invocation that started them.
 *
 * R2 multipart parts are already uploaded: they are not bytes waiting in memory, they are **storage that counts
 * against the quota** until something completes or aborts them. Nothing in R2 expires them. So an upload
 * abandoned part way is a slow leak, and this is what stops it.
 *
 * ## What is observable here, and what is not
 *
 * `store.test.ts` records a KNOWN VERIFIED GAP: the local simulator keeps incomplete multipart uploads invisible
 * to `list`, so "aborted" and "left behind" look the same from storage. The assertions below are therefore about
 * what IS observable — that the session stops being open, that an abort is attempted against the real API, and
 * that a failure to abort does not leave the row retried forever. Claiming the quota was released would be
 * claiming something this environment cannot show.
 */

async function reset(): Promise<void> {
	await worker.fetch(new Request(`${TEST_BASE_URL}/api/admin/apply-schema`, { method: 'POST' }), { ...(env as object), SSH_MASTER_KEY: TEST_MASTER_KEY } as never, {} as never);
	for (const table of ['multipart_sessions', 'object_reclaims', 'objects', 'hosts']) {
		await env.DB.prepare(`DELETE FROM ${table}`).run();
	}
	await env.DB.prepare(
		`INSERT INTO hosts (id, label, address, port, username, enabled, created_at, updated_at)
		 VALUES ('h1', 'one', 'a.invalid', 22, 'root', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
	).run();
}

/** An upload that has actually been started against storage, so an abort has something real to act on. */
async function liveUpload(key: string): Promise<string> {
	const upload = await env.BUCKET.createMultipartUpload(key);
	return upload.uploadId;
}

describe('recording an upload that could not finish', () => {
	beforeEach(reset);

	it('records one row per upload, so a later run can find it', async () => {
		const uploadId = await liveUpload('objects/h1/data/big.bin');
		await recordMultipartSession(env.DB, { hostId: 'h1', path: '/data/big.bin', objectKey: 'objects/h1/data/big.bin', uploadId, partSize: 5 * 1024 * 1024, totalBytes: 12_000_000 });

		const open = await openSessions(env.DB, 'h1');
		expect(open).toHaveLength(1);
		expect(open[0].uploadId).toBe(uploadId);
		expect(open[0].state).toBe('open');
	});

	it('is idempotent, so a retried file cannot leave two rows for one upload', async () => {
		// The id is derived from the machine and the key rather than generated. An autoincrement id would let a
		// retry leave a second row pointing at the same upload, and cleanup would then abort it twice and count it
		// twice — with the second abort failing on an upload that no longer exists.
		const uploadId = await liveUpload('objects/h1/data/big.bin');
		const input = { hostId: 'h1', path: '/data/big.bin', objectKey: 'objects/h1/data/big.bin', uploadId, partSize: 5 * 1024 * 1024, totalBytes: 1 };
		await recordMultipartSession(env.DB, input);
		await recordMultipartSession(env.DB, input);

		expect(await openSessions(env.DB, 'h1')).toHaveLength(1);
	});

	it('lists only open sessions for the machine asked about', async () => {
		await env.DB.prepare(
			`INSERT INTO hosts (id, label, address, port, username, enabled, created_at, updated_at)
			 VALUES ('h2', 'two', 'b.invalid', 22, 'root', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		).run();
		const one = await liveUpload('objects/h1/a');
		const two = await liveUpload('objects/h2/b');
		await recordMultipartSession(env.DB, { hostId: 'h1', path: '/a', objectKey: 'objects/h1/a', uploadId: one, partSize: 1, totalBytes: 1 });
		await recordMultipartSession(env.DB, { hostId: 'h2', path: '/b', objectKey: 'objects/h2/b', uploadId: two, partSize: 1, totalBytes: 1 });

		// Cleanup acts on the machine about to be scanned, so it must not touch another machine's uploads: those
		// could belong to a run that is still going.
		expect((await openSessions(env.DB, 'h1')).map((s) => s.objectKey)).toEqual(['objects/h1/a']);
	});
});

describe('cleaning up after a run that died', () => {
	beforeEach(reset);

	it('abandons an upload older than the threshold, and stops offering it', async () => {
		const uploadId = await liveUpload('objects/h1/data/big.bin');
		await recordMultipartSession(env.DB, { hostId: 'h1', path: '/data/big.bin', objectKey: 'objects/h1/data/big.bin', uploadId, partSize: 1, totalBytes: 1 });

		// Aged by moving `now` forward rather than by waiting three hours.
		const result = await abandonStaleSessions(env.DB, env.BUCKET, 'h1', { now: Date.now() + ABANDONED_AFTER_MS + 1000 });

		expect(result.abandoned).toEqual([sessionIdFor('h1', 'objects/h1/data/big.bin')]);
		expect(result.failed).toEqual([]);
		expect(await openSessions(env.DB, 'h1'), 'no longer offered for reuse').toHaveLength(0);
	});

	it('leaves a recent upload alone, because a slow upload is not an abandoned one', async () => {
		// The threshold exists for this direction: aborting an upload that is still progressing would discard
		// parts a running invocation is about to complete.
		const uploadId = await liveUpload('objects/h1/data/big.bin');
		await recordMultipartSession(env.DB, { hostId: 'h1', path: '/data/big.bin', objectKey: 'objects/h1/data/big.bin', uploadId, partSize: 1, totalBytes: 1 });

		const result = await abandonStaleSessions(env.DB, env.BUCKET, 'h1', { now: Date.now() });

		expect(result.abandoned).toEqual([]);
		expect(await openSessions(env.DB, 'h1'), 'still open').toHaveLength(1);
	});

	it('treats a row whose age cannot be established as old, so it is not stuck forever', async () => {
		// A malformed timestamp means nothing will ever clean the row up, so the safe reading is the one that acts
		// on it. This row's upload id is not real, so storage refuses the abort — and the id therefore lands in
		// `failed` rather than `abandoned`, which is the honest report: the row is dealt with, but nothing was
		// confirmed released. An earlier version of this test expected `abandoned`, which would have claimed a
		// release that did not happen.
		await env.DB.prepare(
			`INSERT INTO multipart_sessions (id, host_id, path, object_key, upload_id, total_bytes, part_size, parts_json, state, created_at, updated_at)
			 VALUES ('bad', 'h1', '/x', 'objects/h1/x', 'no-such-upload', 1, 1, '[]', 'open', 'not a date', 'not a date')`,
		).run();

		const result = await abandonStaleSessions(env.DB, env.BUCKET, 'h1', { now: Date.now() });

		expect(result.failed, 'dealt with, and honest that nothing was released').toHaveLength(1);
		expect(await openSessions(env.DB, 'h1'), 'and not retried forever').toHaveLength(0);
	});

	it('gives up on an upload storage will not abort rather than retrying it forever', async () => {
		// An upload id storage does not know — expired, or never real — cannot be aborted, and retrying it every
		// run would mean a cleanup that never converges. The row is marked so it stops being attempted, and the id
		// is REPORTED so the failure is visible rather than silent.
		//
		// Note what cannot be tested here: aborting an upload twice does NOT fail in this simulator, so "already
		// aborted at storage" cannot be simulated. An id that was never real is the case that reaches the same
		// path, and it is used instead.
		await recordMultipartSession(env.DB, { hostId: 'h1', path: '/data/big.bin', objectKey: 'objects/h1/data/big.bin', uploadId: 'never-existed', partSize: 1, totalBytes: 1 });

		const result = await abandonStaleSessions(env.DB, env.BUCKET, 'h1', { now: Date.now() + ABANDONED_AFTER_MS + 1000 });

		expect(result.abandoned, 'nothing was released').toEqual([]);
		expect(result.failed, 'and it says so').toEqual([sessionIdFor('h1', 'objects/h1/data/big.bin')]);
		expect(await openSessions(env.DB, 'h1'), 'but it stops being retried').toHaveLength(0);
	});

	it('does nothing when there is nothing to clean', async () => {
		const result = await abandonStaleSessions(env.DB, env.BUCKET, 'h1', { now: Date.now() });
		expect(result).toEqual({ abandoned: [], failed: [] });
	});
});

describe('a completed upload stops being a cleanup candidate', () => {
	beforeEach(reset);

	it('closes the session so the next run does not abort an upload that finished', async () => {
		// The failure this prevents is quiet: a row left 'open' after a successful upload would be aborted by the
		// next cleanup — a no-op at storage for a completed upload, but the table would be lying about it.
		const uploadId = await liveUpload('objects/h1/data/big.bin');
		await recordMultipartSession(env.DB, { hostId: 'h1', path: '/data/big.bin', objectKey: 'objects/h1/data/big.bin', uploadId, partSize: 1, totalBytes: 1 });

		await closeSession(env.DB, 'h1', 'objects/h1/data/big.bin');

		expect(await openSessions(env.DB, 'h1')).toHaveLength(0);
		const result = await abandonStaleSessions(env.DB, env.BUCKET, 'h1', { now: Date.now() + ABANDONED_AFTER_MS + 1000 });
		expect(result.abandoned, 'and it is never a candidate').toEqual([]);
	});
});
