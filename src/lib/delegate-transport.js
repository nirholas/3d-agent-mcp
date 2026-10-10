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

// The talk endpoint requires an authenticated principal — each delegation burns
// platform LLM credit, so it will not run for an anonymous caller (401). The MCP
// tool has already collected the x402 payment; it presents a platform service
// credential (a bearer API key) so the delegation the caller paid for can
// actually execute. Without a token configured the delegation returns a clean
// 401 error (which cancels the x402 payment — the caller is never charged for a
// hire that could not run).
function talkAuthToken() {
	for (const k of ['MCP_AGENT_TALK_TOKEN', 'THREE_WS_MCP_TOKEN', 'MCP_SERVICE_TOKEN']) {
		const v = process.env[k];
		if (v && v.trim()) return v.trim();
	}
	return null;
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
	const headers = { 'content-type': 'application/json' };
	const token = talkAuthToken();
	if (token) headers.authorization = `Bearer ${token}`;

	let res;
	try {
		res = await resilientFetch(
			talkEndpoint(),
			{
				method: 'POST',
				headers,
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
