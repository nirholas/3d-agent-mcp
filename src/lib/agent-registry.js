// three.ws agent-registry read client used by the commerce discovery tool.
//
// Reads the live public agent directory (GET /api/agents/public) — real agents,
// real skills, real engagement counts — and exposes a ranking helper that folds
// task/skill fit, engagement, and (when present) on-chain ERC-8004 reputation
// into a single fitness score. No mock data: every candidate comes from the
// live directory; reputation is read straight from the canonical registries.

import { resilientFetch } from './resilient-fetch.js';
import { makeEvmProvider } from './evm-rpc.js';
import { readReputationAggregate, resolveChain } from './erc8004.js';

function baseUrl() {
	const v = process.env.THREEWS_BASE_URL;
	return v && v.trim() ? v.trim().replace(/\/+$/, '') : 'https://three.ws';
}

/**
 * Fetch candidate agents from the live three.ws public directory.
 *
 * @param {object} opts
 * @param {string} [opts.q]      — full-text query (task keywords)
 * @param {string} [opts.skill]  — skill-slug filter
 * @param {number} [opts.limit]  — max rows (clamped 1..48)
 * @returns {Promise<object[]>} raw agent rows from /api/agents/public
 */
export async function fetchCandidates({ q, skill, limit = 24 } = {}) {
	const url = new URL(`${baseUrl()}/api/agents/public`);
	if (q) url.searchParams.set('q', String(q).slice(0, 100));
	if (skill) url.searchParams.set('skill', String(skill).toLowerCase());
	url.searchParams.set('limit', String(Math.min(48, Math.max(1, limit))));
	url.searchParams.set('sort', 'popular');

	const res = await resilientFetch(
		url.toString(),
		{ headers: { accept: 'application/json' } },
		{ timeoutMs: 12_000, retries: 2, label: 'agent-registry' },
	);
	if (!res.ok) {
		throw new Error(`agent directory returned ${res.status}`);
	}
	const data = await res.json().catch(() => null);
	const agents = Array.isArray(data?.agents) ? data.agents : [];
	return agents;
}

/**
 * Fetch one agent's public record by id, returning the fields the commerce
 * tools need (name, on-chain identity for reputation, skills for task-fit).
 * Returns null when the agent does not exist or the directory is unreachable —
 * the caller decides whether a missing record is fatal.
 *
 * @param {string} agentId — three.ws agent UUID
 * @returns {Promise<{id:string,name:string,description:string|null,skills:string[],erc8004_agent_id:string|null,chain_id:number|null,is_registered:boolean}|null>}
 */
export async function fetchAgentById(agentId) {
	const url = `${baseUrl()}/api/agents/${encodeURIComponent(agentId)}`;
	let res;
	try {
		res = await resilientFetch(
			url,
			{ headers: { accept: 'application/json' } },
			{ timeoutMs: 10_000, retries: 2, label: 'agent-by-id' },
		);
	} catch {
		return null;
	}
	if (!res.ok) return null;
	const data = await res.json().catch(() => null);
	const a = data?.agent;
	if (!a || !a.id) return null;
	return {
		id: a.id,
		name: a.name || null,
		description: a.description || null,
		skills: Array.isArray(a.skills) ? a.skills : [],
		erc8004_agent_id:
			a.erc8004_agent_id != null && String(a.erc8004_agent_id).trim() !== ''
				? String(a.erc8004_agent_id)
				: null,
		chain_id: a.chain_id ?? null,
		is_registered: !!a.is_registered,
	};
}

// Token-overlap relevance between the task text and an agent's name + skills +
// description. Cheap, deterministic, and good enough to order a shortlist; the
// registry's full-text search already did the heavy filtering.
export function relevanceScore(task, agent) {
	const taskTokens = tokenize(task);
	if (taskTokens.size === 0) return 0;
	const hay = tokenize(
		[agent.name, agent.description, ...(Array.isArray(agent.skills) ? agent.skills : [])]
			.filter(Boolean)
			.join(' '),
	);
	if (hay.size === 0) return 0;
	let hits = 0;
	for (const t of taskTokens) if (hay.has(t)) hits += 1;
	return hits / taskTokens.size;
}

function tokenize(s) {
	return new Set(
		String(s || '')
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((w) => w.length > 2),
	);
}

// Squash an unbounded engagement count into 0..1 so it can't dominate the
// composite score. log10 keeps a 10× busier agent meaningfully — but not
// linearly — ahead.
function engagementScore(chatCount) {
	const n = Number(chatCount) || 0;
	if (n <= 0) return 0;
	return Math.min(1, Math.log10(n + 1) / 4); // ~10k chats → 1.0
}

/**
 * Read live ERC-8004 reputation for one agent that exposes an on-chain identity.
 * Returns null when the agent has no erc8004 id or the read fails (reputation is
 * enrichment — a single RPC blip must never sink the whole discovery call).
 *
 * @param {object} agent — directory row (may carry erc8004_agent_id + chain_id)
 * @returns {Promise<{average:number|null, count:number, source:string, chain:string, erc8004AgentId:string}|null>}
 */
export async function readAgentReputation(agent) {
	const erc8004Id = agent?.erc8004_agent_id;
	if (erc8004Id == null || String(erc8004Id).trim() === '') return null;
	let chain;
	try {
		chain = resolveChain(agent.chain_id ?? agent.chainId ?? undefined);
	} catch {
		chain = resolveChain(undefined);
	}
	try {
		const overrides = [process.env[`MCP_AGENT_REP_RPC_${chain.id}`]].filter(Boolean);
		const provider = makeEvmProvider(chain.id, { overrides, timeoutMs: 8_000 });
		const agg = await readReputationAggregate(provider, BigInt(String(erc8004Id)));
		return {
			average: agg.average,
			count: Number(agg.count) || 0,
			averageX100: agg.averageX100,
			totalStakeWei: agg.totalStakeWei,
			source: 'erc8004',
			chain: chain.name,
			chainId: chain.id,
			erc8004AgentId: String(erc8004Id),
		};
	} catch {
		return null;
	}
}

// Map an ERC-8004 average (the registry scores feedback −100..+100, stored ÷100
// so the average lands in roughly −1..+1 for normalized feedback, but can range
// wider) into a 0..1 reputation factor for the composite. Unrated agents get a
// neutral baseline so they're not auto-buried — discovery still surfaces them,
// just below comparably-fit rated peers.
function reputationFactor(reputation) {
	if (!reputation || reputation.average == null || reputation.count <= 0) return 0.5;
	// Clamp the average into [-1, 1] then shift to [0, 1].
	const clamped = Math.max(-1, Math.min(1, reputation.average));
	return (clamped + 1) / 2;
}

/**
 * Rank candidate agents for a task, enriching each with live reputation, and
 * return a sorted shortlist with the evidence behind each score.
 *
 * Composite weighting (sums to 1): relevance .45, reputation .35, engagement .20.
 * Reputation is read in parallel and bounded; failures degrade to a neutral
 * factor rather than dropping the candidate.
 *
 * @param {object} opts
 * @param {string} opts.task
 * @param {object[]} opts.candidates  — rows from fetchCandidates()
 * @param {number} [opts.limit=5]
 * @param {number} [opts.minReputation]  — drop rated agents below this average
 * @returns {Promise<object[]>}
 */
export async function rankCandidates({ task, candidates, limit = 5, minReputation } = {}) {
	const rows = Array.isArray(candidates) ? candidates : [];

	// Read reputation for every candidate concurrently (bounded inside
	// readAgentReputation). Promise.all is safe — each resolves to a value or
	// null, never rejects.
	const reputations = await Promise.all(rows.map((a) => readAgentReputation(a)));

	const scored = rows.map((agent, i) => {
		const reputation = reputations[i];
		const relevance = relevanceScore(task, agent);
		const engagement = engagementScore(agent.chat_count);
		const repFactor = reputationFactor(reputation);
		const score = 0.45 * relevance + 0.35 * repFactor + 0.2 * engagement;
		return {
			agentId: agent.id,
			name: agent.name,
			description: agent.description || null,
			skills: Array.isArray(agent.skills) ? agent.skills : [],
			homeUrl: agent.home_url || null,
			avatarThumbnail: agent.avatar_thumbnail || null,
			isRegistered: !!agent.is_registered,
			reputation: reputation
				? {
						average: reputation.average,
						count: reputation.count,
						source: reputation.source,
						chain: reputation.chain,
						erc8004AgentId: reputation.erc8004AgentId,
				  }
				: null,
			capabilityMatch: Math.round(relevance * 100) / 100,
			engagement: { chatCount: Number(agent.chat_count) || 0, score: Math.round(engagement * 100) / 100 },
			score: Math.round(score * 1000) / 1000,
			evidence: buildEvidence({ relevance, reputation, engagement, agent }),
		};
	});

	const gated =
		Number.isFinite(minReputation) && minReputation != null
			? scored.filter(
					(c) =>
						// Keep unrated agents (no on-chain rep to gate on) and rated
						// agents that clear the floor.
						c.reputation == null ||
						c.reputation.average == null ||
						c.reputation.average >= minReputation,
			  )
			: scored;

	gated.sort((a, b) => b.score - a.score);
	return gated.slice(0, Math.max(1, Math.min(10, limit)));
}

function buildEvidence({ relevance, reputation, engagement, agent }) {
	const parts = [];
	if (reputation && reputation.average != null && reputation.count > 0) {
		parts.push(
			`ERC-8004 reputation ${reputation.average.toFixed(2)} across ${reputation.count} vouch(es) on ${reputation.chain}`,
		);
	} else if (reputation) {
		parts.push(`on-chain ERC-8004 identity #${reputation.erc8004AgentId} (no vouches yet)`);
	} else {
		parts.push('no on-chain reputation record');
	}
	parts.push(`task fit ${(relevance * 100).toFixed(0)}%`);
	const chats = Number(agent.chat_count) || 0;
	if (chats > 0) parts.push(`${chats.toLocaleString('en-US')} chats served`);
	return parts.join(' · ');
}
