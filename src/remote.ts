/**
 * What the collector needs from a remote machine.
 *
 * A narrow port, not a general SSH surface: resolving rules needs to list a directory, collecting needs
 * to read a file, and nothing else is required. Keeping it this small is what lets the collection logic
 * be exercised without a machine, which matters because the real remote cannot be reached from a local
 * test — local development refuses outbound connections to private addresses.
 *
 * This is **not** a production interface with a second implementation. Production has exactly one
 * implementation, the SSH one. A fake exists only in tests, injected through the environment, so no
 * fake can reach production code paths (see the ticket-01 note in STATE.md: promoting it to a
 * production interface would be a departure from that decision).
 */

export interface RemoteEntry {
	name: string;
	size: number;
	/** Wall-clock seconds, as the machine reports it. */
	mtime?: number;
	isDirectory: boolean;
}

export interface RemoteHost {
	/** Lists one directory. Throws when the directory cannot be read. */
	list(dir: string): Promise<RemoteEntry[]>;
	/** Stats one path. Throws when it does not exist or cannot be read. */
	stat(path: string): Promise<{ size?: number; mtime?: number; isDirectory: boolean }>;
	/**
	 * Reads a file's bytes as a stream.
	 *
	 * A stream rather than a whole-file read: the whole-file path holds the file in memory, and the
	 * per-file limit is large enough that this is the difference between working and failing on a
	 * 128 MB isolate. Anything implementing this must not buffer.
	 */
	read(path: string): Promise<ReadableStream<Uint8Array>>;
	/**
	 * Runs a read-only identifying command and returns its output.
	 *
	 * Optional, because it is needed only to say what a machine *is* — `uname`, `whoami`, `hostname` —
	 * and not to collect anything. A substitute that offers only file access is still useful, so the
	 * absence of this must degrade the identification rather than break the resolution.
	 *
	 * Implementations must never run a command assembled from user text. The only commands belong to a
	 * fixed set chosen in this codebase.
	 */
	exec?(command: string): Promise<string>;
}

export type RuleStatus = 'ok' | 'needs_collection_step' | 'error';

export interface RuleEvaluation {
	pattern: string;
	scope: 'global' | 'host';
	isExclude: boolean;
	status: RuleStatus;
	matchCount?: number;
	matches?: string[];
	detail?: string;
}

/**
 * Turns rule evaluations into the set of files to collect.
 *
 * This is where "an exclusion beats an inclusion" actually becomes true. Ordering the rules is
 * necessary but not sufficient: unless something subtracts, an exclusion is a note rather than a
 * decision. The precedence is deliberate and total — an exclusion wins regardless of whether it is
 * global or per-machine, and regardless of order — because the alternative (a per-machine exclusion
 * losing to a global inclusion) would quietly collect a file the operator explicitly excluded, which is
 * the single worst outcome this configuration can produce.
 *
 * Rules that could not be resolved contribute nothing, and are **not** treated as matches or as
 * absences: a file only counts as matched when a rule actually reported matching it. That keeps an
 * unreadable directory from silently emptying the collection.
 *
 * Paths are returned as directory plus name, because a bare filename is ambiguous the moment two
 * directories are configured.
 */
export function filesToCollect(evaluations: RuleEvaluation[]): { path: string; pattern: string }[] {
	const dirOf = (pattern: string): string => {
		const slash = pattern.lastIndexOf('/');
		return slash > 0 ? pattern.slice(0, slash) : '/';
	};

	const excluded = new Set<string>();
	for (const evaluation of evaluations) {
		if (!evaluation.isExclude || evaluation.status !== 'ok') continue;
		for (const name of evaluation.matches ?? []) excluded.add(`${dirOf(evaluation.pattern)}/${name}`);
	}

	const wanted = new Map<string, string>();
	for (const evaluation of evaluations) {
		if (evaluation.isExclude || evaluation.status !== 'ok') continue;
		for (const name of evaluation.matches ?? []) {
			const path = `${dirOf(evaluation.pattern)}/${name}`;
			if (excluded.has(path)) continue;
			if (!wanted.has(path)) wanted.set(path, evaluation.pattern);
		}
	}

	return [...wanted.entries()].map(([path, pattern]) => ({ path, pattern })).sort((a, b) => a.path.localeCompare(b.path));
}

/** The shape the rule resolution needs; a full database row satisfies it. */
export interface ResolvableRule {
	pattern: string;
	is_exclude: number;
	host_id: string | null;
}

/** Minimal glob for one path segment: `*`, `?` and literals. */
export function globToRegExp(pattern: string): RegExp {
	let out = '^';
	for (const ch of pattern) {
		if (ch === '*') out += '[^/]*';
		else if (ch === '?') out += '[^/]';
		else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	}
	return new RegExp(`${out}$`);
}

/**
 * How many matched names a rule reports, by default.
 *
 * A preview is read by a person, so it wants examples rather than an exhaustive list — a rule matching ten
 * thousand files should not produce a ten-thousand-entry response.
 *
 * **It is a display cap, and it was being used as a work limit.** `filesToCollect` consumes these evaluations, so
 * a caller that used the default silently collected the first 50 files per rule and reported success: the run
 * looked complete and files were simply missing. That is the failure mode this codebase treats as the worst kind,
 * because nothing says anything is wrong. Callers that intend to ACT on the result must pass a limit large
 * enough for the job; see `COLLECTION_MATCH_LIMIT`.
 */
const DEFAULT_MATCH_LIMIT = 50;

/**
 * The match limit a collection run uses.
 *
 * Set to the same bound the walk enforces (`MAX_FILES_PER_RUN` in `collect.ts`), so a run sees every file it is
 * willing to walk. If the two ever disagree the smaller one silently wins, which is exactly the defect the
 * default caused.
 */
export const COLLECTION_MATCH_LIMIT = 2000;

/**
 * Resolves each rule against the machine's real filesystem, as far as one listing can.
 *
 * Three outcomes, and keeping them distinct is the point:
 *
 *   - `ok` with a count, including a count of zero. Zero matches is a legitimate answer.
 *   - `needs_collection_step` when the directory part of the pattern contains a wildcard, because a
 *     single listing cannot answer it. Reporting this as zero matches would be a lie that looks like a
 *     working rule.
 *   - `error` when the directory could not be read, carrying the machine's own words so a permission
 *     problem is not mistaken for an empty directory.
 *
 * Read-only throughout: it lists and stats, and never asks the machine to change anything.
 *
 * `matchLimit` bounds `matches` and defaults to the DISPLAY cap. `matchCount` is always the true number, so a
 * caller that only wants to say "214 files" is unaffected by the limit.
 */
export async function resolveRules(
	remote: RemoteHost,
	rules: ResolvableRule[],
	matchLimit: number = DEFAULT_MATCH_LIMIT,
): Promise<RuleEvaluation[]> {
	const evaluations: RuleEvaluation[] = [];

	for (const rule of rules) {
		const base = {
			pattern: rule.pattern,
			scope: (rule.host_id === null ? 'global' : 'host') as 'global' | 'host',
			isExclude: rule.is_exclude === 1,
		};

		const slash = rule.pattern.lastIndexOf('/');
		const dir = slash > 0 ? rule.pattern.slice(0, slash) : '/';
		const name = slash >= 0 ? rule.pattern.slice(slash + 1) : rule.pattern;

		if (/[*?[]/.test(dir)) {
			evaluations.push({
				...base,
				status: 'needs_collection_step',
				detail: 'the directory part contains a wildcard, so this is resolved during collection rather than now',
			});
			continue;
		}

		try {
			const entries = await remote.list(dir);
			const regex = globToRegExp(name);
			// Directories are excluded: a directory whose name fits the pattern is not a file to collect.
			const matches = entries
				.filter((entry) => !entry.isDirectory && regex.test(entry.name))
				.map((entry) => entry.name)
				.sort();
			evaluations.push({
				...base,
				status: 'ok',
				matchCount: matches.length,
				matches: matches.slice(0, matchLimit),
				detail: `${matches.length} file(s) in ${dir}`,
			});
		} catch (err) {
			evaluations.push({ ...base, status: 'error', detail: (err as Error).message });
		}
	}

	return evaluations;
}
