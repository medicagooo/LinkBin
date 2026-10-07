/**
 * Test-time types.
 *
 * `ProvidedEnv` describes what `env` looks like inside a test. It deliberately does not replace the
 * Worker's own `Env`; the tests drive the Worker through its request/response edge, so they should
 * not be reaching into its bindings directly except to seed or inspect storage.
 */
declare module 'cloudflare:test' {
	interface ProvidedEnv {
		DB: D1Database;
		BUCKET: R2Bucket;
		/** Present in tests only. Production never sets this. */
		SSH_MASTER_KEY?: string;
	}
}
