/**
 * Shared physical-byte accounting and admission for collection, derived writes and the usage API.
 * Every stored version has its own key; legacy repeated keys are counted once, using their newest row.
 * Input protection follows object_sources of live derived outputs, so it disappears when that output retires.
 * Reclamation deletes bytes before recording object_reclaims; no multi-statement atomicity is assumed.
 */
import { planAdmission, type BudgetObject } from './budget';
import { makeRoomFor, type EvictionOutcome } from './evict';
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const STORAGE_BUDGET_BYTES = 10 * 1024 * 1024 * 1024;

export interface StorageUsage {
	/** Bytes in live objects — rows that are neither superseded nor soft-deleted. */
	liveBytes: number;
	/** Bytes retained by superseded or soft-deleted rows that have not been collected yet. */
	retainedBytes: number;
	/** Live + retained: what R2 is actually holding, which is what the 10 GB ceiling applies to. */
	totalBytes: number;
	objectCount: number;
	budgetBytes: number;
	remainingBytes: number;
	usedFraction: number;
	/**
	 * True when the store is full and every remaining file is protected, so new files are being refused and
	 * nothing may be reclaimed. The interface needs this distinctly from simply being full: only this case is
	 * resolved by unmarking a file.
	 */
	saturatedByImportant: boolean;
	/** Bytes that are protected from eviction. */
	importantBytes: number;
}

/**
 * Every object the bucket holds, in any state, with its protection flag.
 *
 * Superseded and soft-deleted objects are included because they still occupy storage and are still
 * charged — a figure counting only live objects could pass the ceiling while the real total was over it.
 * `object_flags` is joined rather than a column on `objects`, because adding a column is the one migration
 * change that cannot be applied twice (see migration 0003).
 *
 * Metadata is read in 500-row keyset pages, preserving the total beyond 5,000 historical rows.
 * When a bucket is supplied, every inventory page is checked for bytes with no metadata owner.
 */
interface StorageObject extends BudgetObject { orphanKey?: string }
export async function storageObjects(db: D1Database, bucket?: R2Bucket): Promise<StorageObject[]> {
    const results: { id: number; size: number; important: number; superseded: number; deleted: number; reclaimed: number; created_at: string }[] = [];
    let afterId = 0;
    for (;;) {
    const page = await db
		.prepare(
			`SELECT o.id                AS id,
			        o.size_bytes        AS size,
			        CASE WHEN o.deleted_at IS NOT NULL AND EXISTS (
                    SELECT 1 FROM multipart_sessions pending WHERE pending.state = 'publishing' AND pending.object_key = o.object_key
                ) THEN 0 WHEN f.object_id IS NOT NULL OR EXISTS (
                    SELECT 1 FROM object_sources os JOIN objects output ON output.id = os.object_id
                    JOIN objects input ON input.id = os.source_object_id
                    WHERE input.host_id = o.host_id AND input.path = o.path AND output.deleted_at IS NULL AND output.superseded_by IS NULL
                ) THEN 1 ELSE 0 END AS important,
			        CASE WHEN o.superseded_by IS NULL THEN 0 ELSE 1 END AS superseded,
			        CASE WHEN o.deleted_at IS NULL THEN 0 ELSE 1 END AS deleted,
			        CASE WHEN r.object_id IS NULL THEN 0 ELSE 1 END AS reclaimed,
			        o.created_at        AS created_at
			 FROM objects o
			 LEFT JOIN object_flags f ON f.object_id = o.id
			 LEFT JOIN object_reclaims r ON r.object_id = o.id
			 WHERE o.id > ? AND o.id = (SELECT MAX(version.id) FROM objects version WHERE version.object_key = o.object_key)
             ORDER BY o.id LIMIT 500`,
		)
		.bind(afterId)
		.all<{ id: number; size: number; important: number; superseded: number; deleted: number; reclaimed: number; created_at: string }>();
    const rows = page.results ?? [];
    results.push(...rows);
    if (rows.length < 500) break;
    afterId = Number(rows[rows.length - 1].id);
    }

	const objects: StorageObject[] = (results ?? []).map((row) => ({
		id: Number(row.id),
		size: Number(row.size ?? 0),
		important: Number(row.important) === 1,
		superseded: Number(row.superseded) === 1,
		deleted: Number(row.deleted) === 1,
		reclaimed: Number(row.reclaimed) === 1,
		createdAt: String(row.created_at),
	}));
    if (bucket) {
        // Inventory catches a terminated invocation between durable bytes and their D1 record.
        // Read every page; metadata-only fixtures still exercise the conservative database accounting.
        const keys = new Set((await db.prepare('SELECT object_key FROM objects').all<{object_key: string}>()).results?.map(row => row.object_key));
        let cursor: string | undefined;
        let orphanId = -1;
        do {
            const page = await bucket.list({ cursor, limit: 500 });
            for (const object of page.objects) if (!keys.has(object.key)) objects.push({
                id: orphanId--, size: object.size, important: false, superseded: false, deleted: true,
                reclaimed: false, createdAt: object.uploaded.toISOString(), orphanKey: object.key,
            });
            cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
    }
    return objects;
}

/**
 * Measures what the store is holding, and reports the budget state.
 *
 * The totals and the used fraction come from `planAdmission` rather than being computed here as well. They
 * were computed here originally; having the same arithmetic in two places means the number the operator
 * sees and the number the policy acts on can disagree, and the one that is wrong is invisible until the
 * ceiling is crossed.
 */
export async function measureStorage(db: D1Database, bucket?: R2Bucket): Promise<StorageUsage> {
	const objects = await storageObjects(db, bucket);
	const plan = planAdmission({ ceilingBytes: STORAGE_BUDGET_BYTES, newSize: 0, objects });

	// Reclaimed rows are excluded from every total, and not only from `plan.heldBytes`. A row whose bytes were
	// removed is not occupying anything, so counting it here would have `liveBytes` plus `retainedBytes` disagree
	// with `totalBytes` — and the figure the operator reads would exceed the one the policy acts on, which is the
	// drift `measureStorage` delegates to `planAdmission` in order to avoid.
	//
	// Excluded by `reclaimed` and NOT by `deleted`, which is the distinction that matters: a soft-deleted row has
	// been asked to go but its bytes are still in the bucket and still charged. Excluding those would report room
	// that does not exist.
	const held = objects.filter((o) => !o.reclaimed);
	const liveBytes = held.filter((o) => !o.superseded && !o.deleted).reduce((total, o) => total + o.size, 0);
	const importantBytes = held.filter((o) => o.important).reduce((total, o) => total + o.size, 0);

	return {
		liveBytes,
		retainedBytes: plan.heldBytes - liveBytes,
		totalBytes: plan.heldBytes,
		objectCount: objects.length,
		budgetBytes: STORAGE_BUDGET_BYTES,
		remainingBytes: Math.max(0, STORAGE_BUDGET_BYTES - plan.heldBytes),
		usedFraction: plan.usedFraction,
		// Saturation is a property of what is held, not of a particular incoming file, so it is asked as
		// "would the smallest possible file fit, and if not, is it because everything left is protected".
		saturatedByImportant: planAdmission({ ceilingBytes: STORAGE_BUDGET_BYTES, newSize: 1, objects }).saturatedByImportant,
		importantBytes,
	};
}

/**
 * Decides whether one more file of `size` bytes fits, before anything is transferred.
 *
 * Called before an upload rather than after, so a file that cannot fit is refused instead of being
 * read from the host and then discarded. Collection and derived writes share these limits, including the running byte total of a stream.
 */
export async function checkFileBudget(db: D1Database, size: number, bucket?: R2Bucket): Promise<{ ok: true } | { ok: false; reason: string }> {
	if (!Number.isFinite(size) || size < 0) return { ok: false, reason: 'file size is not a valid non-negative number' };
	if (size > MAX_FILE_BYTES) {
		return { ok: false, reason: `file is ${size} bytes, above the ${MAX_FILE_BYTES} byte per-file limit` };
	}
	const usage = await measureStorage(db, bucket);
	if (usage.totalBytes + size > STORAGE_BUDGET_BYTES) {
		return {
			ok: false,
			reason: `storing ${size} bytes would take the bucket to ${usage.totalBytes + size} of a ${STORAGE_BUDGET_BYTES} byte budget; ${usage.remainingBytes} bytes remain`,
		};
	}
	return { ok: true };
}

/**
 * Reclaims room for an incoming file, against the real database and bucket.
 *
 * The two steps are ordered bytes-then-record, and the reasoning is in `evict.ts` where the order is decided:
 * an interruption between them must leave a file that looks present but is not, rather than one that looks
 * reclaimed while still occupying the budget.
 *
 * Returns what actually happened rather than what was intended, so a caller cannot report space as free that
 * nothing freed.
 */
export async function reclaimFor(db: D1Database, bucket: R2Bucket, size: number, at: string, preserveId?: number): Promise<EvictionOutcome> {
	const objects = await storageObjects(db, bucket);
    if (preserveId !== undefined) {
        const previous = objects.find(object => object.id === preserveId);
        if (previous) previous.important = true;
    }
	return await makeRoomFor({
		ceilingBytes: STORAGE_BUDGET_BYTES,
		newSize: size,
		objects,
		at,
		ports: {
			async objectKey(id) {
                const orphan = objects.find(object => object.id === id)?.orphanKey;
                if (orphan) return orphan;
				const row = await db.prepare('SELECT object_key FROM objects WHERE id = ?').bind(id).first<{ object_key: string }>();
				if (!row) return null;
                // Legacy versions may share a key. Never delete bytes another live row still owns.
                const owner = await db.prepare('SELECT id FROM objects WHERE object_key = ? AND id != ? AND deleted_at IS NULL AND superseded_by IS NULL')
                    .bind(row.object_key, id).first();
                return owner ? null : row.object_key;
			},
			async deleteBytes(key) {
				await bucket.delete(key);
			},
			async markDeleted(id, when) {
                if (id < 0) return; // Orphan bytes have no metadata row to mark.
				// TWO writes, and both are needed rather than one standing in for the other:
				//
				//   - `deleted_at` takes the row out of the live listing, so the browse view stops offering a
				//     download. The row itself is kept, because it is what makes "this file existed and was removed
				//     to make room" answerable afterwards.
				//   - `object_reclaims` is the fact that the BYTES are gone. Without it the budget keeps charging
				//     for space it has already freed, and the store reports itself full forever.
				//
				// The reclaimed row is written first, and it is the one that must not be lost: an interruption
				// after it leaves a row still listed as live whose bytes are gone, which the browse view reports
				// honestly. The other order would leave space charged for bytes that no longer exist.
				const row = await db.prepare('SELECT size_bytes FROM objects WHERE id = ?').bind(id).first<{ size_bytes: number }>();
				await db
					.prepare('INSERT OR REPLACE INTO object_reclaims (object_id, bytes_freed, reclaimed_at) VALUES (?, ?, ?)')
					.bind(id, Number(row?.size_bytes ?? 0), when)
					.run();
				await db.prepare('UPDATE objects SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').bind(when, id).run();
			},
		},
	});
}


/** Retire one version's bytes only after its successor is durable and recorded. Safe with legacy shared keys. */
export async function reclaimVersion(db: D1Database, bucket: R2Bucket, id: number, at: string): Promise<void> {
    const row = await db.prepare('SELECT object_key, size_bytes FROM objects WHERE id = ?').bind(id).first<{object_key: string; size_bytes: number}>();
    if (!row) return;
    const owner = await db.prepare('SELECT id FROM objects WHERE object_key = ? AND id != ? AND deleted_at IS NULL AND superseded_by IS NULL')
        .bind(row.object_key, id).first();
    if (!owner) await bucket.delete(row.object_key);
    await db.prepare('INSERT OR REPLACE INTO object_reclaims (object_id, bytes_freed, reclaimed_at) VALUES (?, ?, ?)')
        .bind(id, owner ? 0 : row.size_bytes, at).run();
}

/**
 * A conditional D1 write serializes storage mutations across Worker invocations.
 * The existing multipart_sessions table also holds this distinctly typed, expiring writer lease;
 * its state is `writer-lease`, never `open`, so abandoned-upload cleanup cannot abort it.
 * Active operations renew every thirty seconds; the ten-minute expiry permits recovery after a killed invocation.
 * No process-local mutex, new secret, migration or multi-statement transaction is required.
 */
export async function withStorageWriter<T>(database: D1Database | { DB: D1Database; BUCKET: R2Bucket }, action: () => Promise<T>): Promise<T> {
    const db = 'DB' in database ? database.DB : database;
    const bucket = 'DB' in database ? database.BUCKET : undefined;
    const token = crypto.randomUUID();
    const at = new Date().toISOString();
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const result = await db.prepare(`INSERT INTO multipart_sessions
        (id, host_id, path, object_key, upload_id, total_bytes, part_size, state, created_at, updated_at)
        SELECT '@storage-writer', id, '', '', ?, 0, 0, 'writer-lease', ?, ? FROM hosts ORDER BY id LIMIT 1
        ON CONFLICT(id) DO UPDATE SET upload_id = excluded.upload_id, updated_at = excluded.updated_at
        WHERE multipart_sessions.updated_at < ?`).bind(token, at, at, stale).run();
    if (Number(result.meta.changes) !== 1) throw new Error('another storage operation is running; retry shortly');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    let renewal: Promise<unknown> | null = null;
    const renew = () => {
        timer = setTimeout(() => {
            renewal = db.prepare("UPDATE multipart_sessions SET updated_at = ? WHERE id = '@storage-writer' AND upload_id = ?")
                .bind(new Date().toISOString(), token).run().finally(() => { if (active) renew(); });
            void renewal.catch(() => {});
        }, 30_000);
    };
    renew();
    try { await recoverPublications(db, bucket); return await action(); }
    finally {
        active = false;
        if (timer !== undefined) clearTimeout(timer);
        if (renewal) await renewal.catch(() => {});
        await db.prepare("DELETE FROM multipart_sessions WHERE id = '@storage-writer' AND upload_id = ?").bind(token).run();
    }
}

/**
 * Publish durable bytes as a staged row, attach protection/provenance, then switch the live version.
 * A failed metadata write leaves the predecessor live; cleanup removes bytes before their accounting row.
 * Callers hold withStorageWriter. A killed invocation can leave a tombstoned staged row, which stays charged
 * and reclaimable rather than being offered as a completed file. Older content is not an archive.
 */
export async function publishVersion(
    env: { DB: D1Database; BUCKET: R2Bucket },
    input: { hostId: string; path: string; key: string; bytes: number; hash: string; mtime: number | null },
    decorate: (id: number) => Promise<void> = async () => {},
): Promise<number> {
    const at = new Date().toISOString();
    const previous = await env.DB.prepare('SELECT id FROM objects WHERE host_id = ? AND path = ? AND deleted_at IS NULL AND superseded_by IS NULL')
        .bind(input.hostId, input.path).first<{id: number}>();
    const pendingId = `@publish-${crypto.randomUUID()}`;
    await env.DB.prepare(`INSERT INTO multipart_sessions (id, host_id, path, object_key, upload_id, total_bytes, part_size, parts_json, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'publication', ?, 0, ?, 'publishing', ?, ?)`)
        .bind(pendingId, input.hostId, input.path, input.key, input.bytes, JSON.stringify({ previousId: previous?.id ?? null }), at, at).run();
    let id: number | null = null;
    let retired = false;
    let published = false;
    try {
        const row = await env.DB.prepare(`INSERT INTO objects (host_id, path, object_key, size_bytes, content_hash, mtime, created_at, deleted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(input.hostId, input.path, input.key, input.bytes, input.hash, input.mtime, at, at).run();
        id = Number(row.meta.last_row_id);
        if (previous) await env.DB.prepare('INSERT OR IGNORE INTO object_flags (object_id, important, created_at) SELECT ?, important, ? FROM object_flags WHERE object_id = ?')
            .bind(id, at, previous.id).run();
        await decorate(id);
        if (previous) {
            await env.DB.prepare('UPDATE objects SET deleted_at = ? WHERE id = ?').bind(at, previous.id).run();
            retired = true;
        }
        await env.DB.prepare('UPDATE objects SET deleted_at = NULL WHERE id = ?').bind(id).run();
        published = true;
    } catch (error) {
        if (retired && previous) await env.DB.prepare('UPDATE objects SET deleted_at = NULL WHERE id = ?').bind(previous.id).run();
        // Keep the staging row if byte deletion fails, so failed cleanup cannot hide held capacity.
        await env.BUCKET.delete(input.key);
        if (id !== null) await env.DB.prepare('DELETE FROM objects WHERE id = ?').bind(id).run();
        await env.DB.prepare('DELETE FROM multipart_sessions WHERE id = ?').bind(pendingId).run();
        throw error;
    }
    if (published && previous) {
        await env.DB.prepare('UPDATE objects SET superseded_by = ? WHERE id = ?').bind(id, previous.id).run();
        await reclaimVersion(env.DB, env.BUCKET, previous.id, at);
    }
    await env.DB.prepare('DELETE FROM multipart_sessions WHERE id = ?').bind(pendingId).run();
    return id!;
}

/**
 * Restore interrupted metadata publication while holding the writer lease. Production callers supply
 * the bucket for immediate cleanup; database-only callers retain charged, reclaimable staging bytes.
 * A live successor commits the switch; an unpublished successor restores the protected predecessor.
 */
async function recoverPublications(db: D1Database, bucket?: R2Bucket): Promise<void> {
    const rows = await db.prepare("SELECT id, object_key, parts_json FROM multipart_sessions WHERE state = 'publishing'")
        .all<{id: string; object_key: string; parts_json: string}>();
    for (const pending of rows.results ?? []) {
        const { previousId } = JSON.parse(pending.parts_json) as {previousId: number | null};
        const staged = await db.prepare('SELECT id, deleted_at FROM objects WHERE object_key = ? ORDER BY id DESC LIMIT 1')
            .bind(pending.object_key).first<{id: number; deleted_at: string | null}>();
        if (staged && staged.deleted_at === null) {
            if (previousId !== null) {
                await db.prepare('UPDATE objects SET superseded_by = ? WHERE id = ?').bind(staged.id, previousId).run();
                if (bucket) await reclaimVersion(db, bucket, previousId, new Date().toISOString());
            }
        } else {
            if (previousId !== null) await db.prepare('UPDATE objects SET deleted_at = NULL WHERE id = ? AND superseded_by IS NULL').bind(previousId).run();
            if (staged) {
                // A provisional output's copied flags are not a permanent retention decision.
                await db.prepare('DELETE FROM object_flags WHERE object_id = ?').bind(staged.id).run();
                await db.prepare('DELETE FROM object_sources WHERE object_id = ?').bind(staged.id).run();
                await db.prepare('DELETE FROM derived_objects WHERE object_id = ?').bind(staged.id).run();
            }
            if (bucket) {
                await bucket.delete(pending.object_key);
                if (staged) await db.prepare('DELETE FROM objects WHERE id = ?').bind(staged.id).run();
            }
        }
        await db.prepare('DELETE FROM multipart_sessions WHERE id = ?').bind(pending.id).run();
    }
}
