// Multi-endpoint Solana RPC with automatic failover.
//
// Tools previously hit a SINGLE Solana RPC (defaulting to the public, heavily
// rate-limited api.mainnet-beta.solana.com). When that endpoint throttled or
// blipped, the tool failed outright. This module gives every Solana read a
// prioritized list of endpoints and a bounded per-call timeout: the operation
// is tried against each endpoint in turn until one succeeds, so a single
// provider outage no longer takes the tool down.
//
// Endpoint precedence (highest first):
//   1. SOLANA_RPC_URLS  — comma-separated list (the explicit failover chain)
//   2. SOLANA_RPC_URL   — single primary (kept for back-compat)
//   3. built-in public mainnet endpoints (last-resort redundancy)
//
// A Connection is created per (endpoint, commitment) and memoized, and each is
// wired with a fetch that hard-times-out so a stuck socket can't wedge a paid
// call. Failover order rotates after a failure so a flaky endpoint moves to the
// back instead of being retried first on the next call.

import { Connection } from '@solana/web3.js';

import { resilientFetch } from './resilient-fetch.js';

// Last-resort redundancy when the operator configures nothing. These are
// well-known public mainnet endpoints; an operator who needs guaranteed
// throughput should set SOLANA_RPC_URLS to dedicated providers.
const DEFAULT_MAINNET_ENDPOINTS = [
	'https://api.mainnet-beta.solana.com',
	'https://solana-rpc.publicnode.com',
	'https://rpc.ankr.com/solana',
];

function dedupe(list) {
	const seen = new Set();
	const out = [];
	for (const item of list) {
		const v = (item || '').trim();
		if (v && !seen.has(v)) {
			seen.add(v);
			out.push(v);
		}
	}
	return out;
}

/**
 * Resolve the ordered Solana mainnet endpoint list from env, falling back to
 * the built-in public set. Always returns at least one endpoint.
 *
 * @returns {string[]}
 */
export function getSolanaEndpoints() {
	const fromList = (process.env.SOLANA_RPC_URLS || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const primary = (process.env.SOLANA_RPC_URL || '').trim();
	const ordered = dedupe([...fromList, primary, ...DEFAULT_MAINNET_ENDPOINTS]);
	return ordered.length ? ordered : [...DEFAULT_MAINNET_ENDPOINTS];
}

// Cache one Connection per (endpoint|commitment). web3.js Connections are cheap
// but hold an http agent; reusing them keeps sockets warm across tool calls.
const connectionCache = new Map();

function connectionFor(endpoint, commitment, timeoutMs) {
	const key = `${endpoint}|${commitment}`;
	let conn = connectionCache.get(key);
	if (!conn) {
		conn = new Connection(endpoint, {
			commitment,
			// Bound every RPC HTTP call. web3.js otherwise inherits Node's
			// unbounded default, which is the source of indefinite hangs.
			fetch: (url, init) =>
				resilientFetch(url, init, {
					timeoutMs,
					// web3.js POSTs JSON-RPC; its reads are idempotent queries, so
					// allow a single transport-level replay on a blip.
					retries: 1,
					retryNonIdempotent: true,
					label: `solana-rpc ${endpoint}`,
				}),
			disableRetryOnRateLimit: false,
		});
		connectionCache.set(key, conn);
	}
	return conn;
}

// Endpoints that just failed are rotated to the back so the next call starts
// with the one most likely to be healthy.
let rotation = 0;

/**
 * Run a Solana read against the endpoint list with failover.
 *
 * `fn` receives a live `Connection` and should perform exactly one logical
 * read. If it throws, the next endpoint is tried. The error from the last
 * endpoint is surfaced when every endpoint fails.
 *
 * @template T
 * @param {(conn: import('@solana/web3.js').Connection) => Promise<T>} fn
 * @param {object} [opts]
 * @param {string} [opts.commitment='confirmed']
 * @param {number} [opts.timeoutMs=12000]  per-endpoint HTTP timeout
 * @returns {Promise<T>}
 */
export async function withSolanaConnection(fn, opts = {}) {
	const { commitment = 'confirmed', timeoutMs = 12_000 } = opts;
	const endpoints = getSolanaEndpoints();
	const start = rotation % endpoints.length;
	rotation += 1;

	let lastErr = null;
	for (let i = 0; i < endpoints.length; i += 1) {
		const endpoint = endpoints[(start + i) % endpoints.length];
		try {
			return await fn(connectionFor(endpoint, commitment, timeoutMs));
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr || new Error('solana-rpc: all endpoints failed');
}

// Test-only: drop cached Connections so a test can swap env between cases.
export function _resetSolanaCache() {
	connectionCache.clear();
	rotation = 0;
}
