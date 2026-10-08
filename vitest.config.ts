import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

/**
 * Tests run inside the Workers runtime against simulated D1 and R2 bindings, fully offline: no
 * network, no Cloudflare account, no credentials. That is the whole point of this harness — the
 * collection channel cannot be exercised locally (outbound connections to private addresses are
 * refused in local development), so everything that *can* be tested here must be.
 *
 * Configuration comes from `wrangler.jsonc` so that the tests exercise the same bindings the
 * deployment uses, rather than a parallel set that can drift.
 */
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
		}),
	],
	test: {
		include: ['test/**/*.test.ts'],
    // Many isolated Workers run PBKDF2 and 100-MiB streaming cases. Unbounded file parallelism
    // starves their five-second deadlines on this Windows host; two workers keep normal test runs stable.
    maxWorkers: 2,
	},
});
