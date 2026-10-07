/**
 * Shared test fixtures.
 *
 * The master key in particular is defined once. It has to be the exact value the Worker under test
 * uses: a session token and the scheduler credential are both signed with it, so a test that mints a
 * token with a different key gets a 401 that looks like a bug in the code rather than in the test.
 * Reading it from the developer's own `.dev.vars` would make results depend on local state, so tests
 * state it explicitly instead.
 *
 * Deliberately not secret: a fixed, published value that only ever protects a simulated database.
 */

export const TEST_MASTER_KEY = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=';

export const TEST_BASE_URL = 'https://linkbin.test';
