/**
 * Ambient declarations for build-time module types this project relies on.
 *
 * `.sql` is imported as a string because Wrangler's default bundling maps `.sql` to a `Text` module
 * (https://developers.cloudflare.com/workers/wrangler/bundling/). That is what lets the Worker apply
 * its own schema on a deployment that has no CLI attached to it.
 */

declare module '*.sql' {
	const contents: string;
	export default contents;
}
