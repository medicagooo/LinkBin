/**
 * Row shapes and small helpers for the D1 store.
 *
 * Everything here is deliberately boring, because D1 gives no transactions: the discipline lives in
 * making each statement independently safe to repeat rather than in wrapping several of them.
 */

export interface HostRow {
	id: string;
	label: string;
	address: string;
	port: number;
	username: string;
	password_enc: string | null;
	private_key_enc: string | null;
	private_key_pass_enc: string | null;
	host_key_fingerprint: string | null;
	enabled: number;
	created_at: string;
	updated_at: string;
}

export interface SourceRuleRow {
	id: number;
	host_id: string | null;
	pattern: string;
	is_exclude: number;
	note: string | null;
	enabled: number;
	created_at: string;
}

/** A slug that is safe to use as a primary key and as AES-GCM additional data. */
export function slugify(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64);
}

/** RFC 3339 UTC. The Worker's clock is already UTC (workerd runs with TZ=UTC). */
export function nowIso(): string {
	return new Date().toISOString();
}

export async function listHosts(db: D1Database): Promise<HostRow[]> {
	const { results } = await db.prepare('SELECT * FROM hosts ORDER BY label').all<HostRow>();
	return results ?? [];
}

export async function getHost(db: D1Database, id: string): Promise<HostRow | null> {
	return await db.prepare('SELECT * FROM hosts WHERE id = ?').bind(id).first<HostRow>();
}

/**
 * Rules that apply to one host: its own rules plus every global rule (`host_id IS NULL`).
 *
 * The two sets are unioned rather than ranked. A per-host rule never has to override a global one
 * because exclusions are evaluated first, so "collect /var/log/*.log" globally and "exclude
 * /var/log/noisy.log" for one host behave the way a reader expects.
 *
 * **`is_exclude DESC`, not ascending.** The flag is 1 for an exclusion, so ordering ascending put
 * inclusions first — the precise opposite of what this comment used to claim, and the one ordering that
 * makes an exclusion useless. A test caught it. The secondary sort by `pattern` is there so the order is
 * deterministic rather than incidental: rules created in the same millisecond otherwise come back in
 * whatever order the database chooses.
 */
export async function rulesForHost(db: D1Database, hostId: string): Promise<SourceRuleRow[]> {
	const { results } = await db
		.prepare('SELECT * FROM source_rules WHERE enabled = 1 AND (host_id IS NULL OR host_id = ?) ORDER BY is_exclude DESC, pattern')
		.bind(hostId)
		.all<SourceRuleRow>();
	return results ?? [];
}
