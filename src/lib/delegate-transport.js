// Shared transport for delegating a message to a three.ws-registered agent.
//
// Both `agent_delegate_action` (raw delegation) and `agent_hire` (delegation
// wrapped in real x402 settlement + provenance) run the remote agent through
// this one path: POST /api/agents/talk, which drives the target agent's
// configured brain (its Claude model + system prompt from its embed policy).
//
// The call is NOT retried: delivering a message to an agent is not idempotent,
// so a replay could double-run / double-bill the target. The timeout is
// generous because a real brain response can take many seconds.

import { resilientFetch } from './resilient-fetch.js';

function talkEndpoint() {
	const v = process.env.MCP_AGENT_TALK_ENDPOINT;
	return v && v.trim() ? v.trim() : 'https://three.ws/api/agents/talk';
}

/**
 * Run a delegated message against a three.ws agent.
 *
 * @param {object} args
 * @param {string} args.agentId
 * @param {string} args.message
 * @param {string} [args.model]
 * @param {number} [args.timeoutMs=60000]
 * @returns {Promise<{ok:boolean, data:object|null, status:number, error?:string}>}
 *   On transport failure, ok=false with an error string (never throws).
 */
export async function runDelegation({ agentId, message, model, timeoutMs = 60_000 }) {
	let res;
	try {
		res = await resilientFetch(
			talkEndpoint(),
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ agentId, message, model }),
			},
			{ timeoutMs, retries: 0, label: 'agent-delegate' },
		);
	} catch (err) {
		return { ok: false, data: null, status: 0, error: err?.message || 'fetch failed' };
	}
	const data = await res.json().catch(() => null);
	if (!res.ok || !data || data.ok === false) {
		return {
			ok: false,
			data,
			status: res.status,
			error: data?.code || data?.error || `endpoint returned ${res.status}`,
			message: data?.message || `endpoint returned ${res.status}`,
		};
	}
	return { ok: true, data, status: res.status };
}
