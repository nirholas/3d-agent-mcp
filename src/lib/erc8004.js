// Shared ERC-8004 on-chain read layer.
//
// Single source of truth for the canonical ERC-8004 reference deployments
// (Identity + Reputation registries), the supported chain table, and the read
// helpers (resolve agentId from a wallet, read the aggregate reputation). Both
// the `agent_reputation` tool and the agent-commerce tools (discovery +
// reputation-gated hiring) read through here, so the contract addresses, ABIs,
// and the "average is already ×100, signed" decode rule live in exactly one
// place and can never drift between the two surfaces.
//
// All reads are made directly against the canonical deployments via an ethers
// JsonRpcProvider — no third-party indexers, no cached snapshots, no fallback
// values.

import { Contract, isAddress } from 'ethers';

export const IDENTITY_REGISTRY_MAINNET = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
export const REPUTATION_REGISTRY_MAINNET = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';

export const IDENTITY_REGISTRY_ABI = [
	'function balanceOf(address owner) external view returns (uint256)',
	'function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)',
	'function ownerOf(uint256 tokenId) external view returns (address)',
	'function tokenURI(uint256 tokenId) external view returns (string)',
	'function getAgentWallet(uint256 agentId) external view returns (address)',
	'function totalSupply() external view returns (uint256)',
];

// Mirrors the deployed ReputationRegistry exactly (contracts/src/
// ReputationRegistry.sol, canonical in src/erc8004/abi.js):
//   getReputation → (int256 avgX100, uint256 count)  — average ×100, signed
//   FeedbackSubmitted(agentId, from, int8 score, string uri)
export const REPUTATION_REGISTRY_ABI = [
	'function getReputation(uint256 agentId) external view returns (int256 avgX100, uint256 count)',
	'function getTotalStake(uint256 agentId) external view returns (uint256)',
	'event FeedbackSubmitted(uint256 indexed agentId, address indexed from, int8 score, string uri)',
	'event ReputationStaked(uint256 indexed agentId, address indexed staker, uint8 score, uint256 value)',
];

// Canonical mainnet RPCs. Operators may pin custom endpoints via
// MCP_AGENT_REP_RPC_<chainId> to avoid rate-limiting the public defaults.
export const CHAINS = {
	base: { id: 8453, rpc: 'https://mainnet.base.org', name: 'Base' },
	ethereum: { id: 1, rpc: 'https://eth.llamarpc.com', name: 'Ethereum' },
	arbitrum: { id: 42161, rpc: 'https://arb1.arbitrum.io/rpc', name: 'Arbitrum One' },
	optimism: { id: 10, rpc: 'https://mainnet.optimism.io', name: 'Optimism' },
	polygon: { id: 137, rpc: 'https://polygon-rpc.com', name: 'Polygon' },
	bsc: { id: 56, rpc: 'https://bsc-dataseed1.binance.org', name: 'BNB Chain' },
	avalanche: { id: 43114, rpc: 'https://api.avax.network/ext/bc/C/rpc', name: 'Avalanche' },
	celo: { id: 42220, rpc: 'https://forno.celo.org', name: 'Celo' },
	linea: { id: 59144, rpc: 'https://rpc.linea.build', name: 'Linea' },
	scroll: { id: 534352, rpc: 'https://rpc.scroll.io', name: 'Scroll' },
};

const CHAIN_BY_ID = Object.fromEntries(Object.values(CHAINS).map((c) => [c.id, c]));

/**
 * Resolve a chain selector (name, numeric id, or numeric string) to a chain
 * record. Defaults to Base. Throws on an unknown selector.
 * @param {string|number|null|undefined} input
 * @returns {{id:number, rpc:string, name:string}}
 */
export function resolveChain(input) {
	if (!input) return CHAINS.base;
	if (typeof input === 'string') {
		const lower = input.toLowerCase();
		if (CHAINS[lower]) return CHAINS[lower];
		const id = Number(input);
		if (!Number.isNaN(id) && CHAIN_BY_ID[id]) return CHAIN_BY_ID[id];
	}
	if (typeof input === 'number' && CHAIN_BY_ID[input]) return CHAIN_BY_ID[input];
	throw new Error(`unsupported chain "${input}" — known: ${Object.keys(CHAINS).join(', ')}`);
}

/**
 * Resolve the ERC-8004 agentId owned by a wallet via the Identity Registry, or
 * null when the wallet holds no agent token.
 * @param {import('ethers').Provider} provider
 * @param {string} wallet
 * @returns {Promise<bigint|null>}
 */
export async function resolveAgentId(provider, wallet) {
	if (!isAddress(wallet)) throw new Error(`invalid wallet address "${wallet}"`);
	const id = new Contract(IDENTITY_REGISTRY_MAINNET, IDENTITY_REGISTRY_ABI, provider);
	const bal = await id.balanceOf(wallet);
	if (bal === 0n) return null;
	const tokenId = await id.tokenOfOwnerByIndex(wallet, 0n);
	return BigInt(tokenId);
}

/**
 * Read the aggregate reputation for an agentId. getReputation returns the
 * average ALREADY ×100 (signed), plus a vouch count; we divide by 100 (never by
 * count) and preserve the sign. Also returns total ETH staked on vouches.
 *
 * @param {import('ethers').Provider} provider
 * @param {bigint} agentId
 * @returns {Promise<{averageX100:string, average:number|null, count:string, totalStakeWei:string}>}
 */
export async function readReputationAggregate(provider, agentId) {
	const rep = new Contract(REPUTATION_REGISTRY_MAINNET, REPUTATION_REGISTRY_ABI, provider);
	const [agg, totalStake] = await Promise.all([
		rep.getReputation(agentId),
		rep.getTotalStake(agentId),
	]);
	const [avgX100, count] = agg;
	const countNum = Number(count);
	return {
		averageX100: avgX100.toString(),
		average: countNum > 0 ? Number(avgX100) / 100 : null,
		count: count.toString(),
		totalStakeWei: totalStake.toString(),
	};
}
