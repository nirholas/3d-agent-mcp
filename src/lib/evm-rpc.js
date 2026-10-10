// Multi-endpoint EVM RPC with automatic failover + bounded timeouts.
//
// `agent_reputation` and `ens_sns_resolve` previously talked to a SINGLE,
// hard-coded public RPC per chain with NO timeout and NO backup — a public
// endpoint rate-limiting or stalling took the whole tool down (and, with no
// timeout, could hang a paid call indefinitely).
//
// This module returns an ethers provider backed by a prioritized list of
// endpoints. With more than one endpoint it builds a `FallbackProvider` with
// `quorum: 1`, so the highest-priority healthy endpoint answers and a failure
// transparently falls over to the next. Every endpoint carries a request
// timeout, so no RPC call can hang without bound.
//
// Endpoint precedence (highest first):
//   1. caller-supplied override URLs (e.g. MCP_AGENT_REP_RPC_<id> / MCP_ENS_RPC_URL)
//   2. MCP_EVM_RPC_<chainId>  — comma-separated env list
//   3. built-in public endpoints for that chain

import { FallbackProvider, FetchRequest, JsonRpcProvider, Network } from 'ethers';

// Built-in redundancy: at least two public endpoints per supported chain so a
// single provider outage is survivable out of the box. Operators who need
// guaranteed throughput should pin dedicated endpoints via MCP_EVM_RPC_<id>.
const BUILTIN_RPCS = {
	1: [
		'https://eth.llamarpc.com',
		'https://ethereum-rpc.publicnode.com',
		'https://cloudflare-eth.com',
	],
	8453: [
		'https://mainnet.base.org',
		'https://base-rpc.publicnode.com',
		'https://base.llamarpc.com',
	],
	42161: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
	10: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com'],
	137: ['https://polygon-rpc.com', 'https://polygon-bor-rpc.publicnode.com'],
	56: ['https://bsc-dataseed1.binance.org', 'https://bsc-rpc.publicnode.com'],
	43114: [
		'https://api.avax.network/ext/bc/C/rpc',
		'https://avalanche-c-chain-rpc.publicnode.com',
	],
	42220: ['https://forno.celo.org'],
	59144: ['https://rpc.linea.build'],
	534352: ['https://rpc.scroll.io'],
};

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
 * Resolve the ordered RPC endpoint list for a chain. Caller overrides come
 * first, then the MCP_EVM_RPC_<chainId> env list, then the built-in set.
 *
 * @param {number} chainId
 * @param {string[]} [overrides]  caller-supplied URLs to try first
 * @returns {string[]}
 */
export function getEvmRpcUrls(chainId, overrides = []) {
	const fromEnv = (process.env[`MCP_EVM_RPC_${chainId}`] || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const builtin = BUILTIN_RPCS[chainId] || [];
	const ordered = dedupe([...(overrides || []), ...fromEnv, ...builtin]);
	if (!ordered.length) {
		throw new Error(`evm-rpc: no endpoints known for chainId ${chainId}`);
	}
	return ordered;
}

function timedRequest(url, timeoutMs) {
	const req = new FetchRequest(url);
	req.timeout = timeoutMs;
	return req;
}

/**
 * Build an ethers provider for a chain with endpoint failover.
 *
 * With a single endpoint, returns a plain timed `JsonRpcProvider`. With more
 * than one, returns a `FallbackProvider` (quorum 1) that answers from the
 * first healthy endpoint and fails over on error — so the multi-read callers
 * (resolveAgentId + identity + reputation + events) keep using one provider
 * object while every underlying call is redundant and bounded.
 *
 * @param {number} chainId
 * @param {object} [opts]
 * @param {string[]} [opts.overrides]   caller-supplied URLs to try first
 * @param {number} [opts.timeoutMs=12000]
 * @returns {import('ethers').AbstractProvider}
 */
export function makeEvmProvider(chainId, opts = {}) {
	const { overrides = [], timeoutMs = 12_000 } = opts;
	const urls = getEvmRpcUrls(chainId, overrides);
	const network = Network.from(chainId);

	if (urls.length === 1) {
		return new JsonRpcProvider(timedRequest(urls[0], timeoutMs), network, {
			staticNetwork: network,
		});
	}

	const configs = urls.map((url, i) => ({
		provider: new JsonRpcProvider(timedRequest(url, timeoutMs), network, {
			staticNetwork: network,
		}),
		priority: i + 1, // lower number = tried first
		// Move on to the next endpoint if this one stalls, well before the hard
		// per-request timeout, so failover is responsive.
		stallTimeout: Math.min(timeoutMs, 3_000),
		weight: 1,
	}));

	// quorum 1: a single endpoint's answer is authoritative; the rest are pure
	// failover, not a consensus requirement.
	return new FallbackProvider(configs, network, { quorum: 1 });
}

export { BUILTIN_RPCS };
