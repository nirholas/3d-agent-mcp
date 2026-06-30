// Shared agent-to-agent commerce primitives for the hire/delegate tools.
//
// This is the load-bearing core of the legible agent economy: the spend
// guardrails (per-call + per-session caps, confirmation threshold), the
// in-process session spend ledger, USD price parsing, and the provenance-block
// builder that turns a completed delegation into a screenshot-worthy receipt.
//
// Nothing here touches the network or any secret — it is pure, deterministic,
// and unit-testable. The tools (agent-hire-discover.js, agent-hire.js) compose
// these primitives with the live registry + reputation + x402 settlement paths.
//
// $THREE is the only coin three.ws promotes. USDC is the settlement asset for
// x402 — never a promoted token — so it appears here only as the unit money
// moves in, exactly as every other paid tool settles.

// ---------------------------------------------------------------------------
// USD price parsing
// ---------------------------------------------------------------------------

/**
 * Parse a USD price string/number into a Number of dollars.
 *
 * Accepts "$0.05", "0.05", 0.05. Returns NaN for anything unparseable so the
 * caller can fail closed rather than silently treating junk as $0.
 *
 * @param {string|number|null|undefined} price
 * @returns {number} dollars (may be NaN)
 */
export function parseUsd(price) {
	if (price == null) return NaN;
	if (typeof price === 'number') return Number.isFinite(price) ? price : NaN;
	const cleaned = String(price).trim().replace(/^\$/, '');
	if (cleaned === '') return NaN;
	const n = Number(cleaned);
	return Number.isFinite(n) ? n : NaN;
}

/**
 * Format a dollars Number as a canonical x402 price string ("$0.05").
 *
 * @param {number} usd
 * @returns {string}
 */
export function formatUsd(usd) {
	const n = Number(usd);
	if (!Number.isFinite(n)) return '$0.00';
	// Up to 6 decimals (USDC precision) but trim trailing zeros past 2 places so
	// common prices read cleanly ("$0.05" not "$0.050000", "$0.001" not
	// "$0.001000", "$1" not "$1.00").
	let fixed = n.toFixed(6);
	if (fixed.includes('.')) {
		// Drop trailing zeros, then re-pad to a minimum of 2 decimals; a whole
		// number collapses to no decimals at all.
		fixed = fixed.replace(/0+$/, '');
		const [whole, frac = ''] = fixed.split('.');
		fixed = frac.length === 0
			? whole
			: `${whole}.${frac.padEnd(2, '0')}`;
	}
	return `$${fixed}`;
}

// ---------------------------------------------------------------------------
// Guardrail configuration
// ---------------------------------------------------------------------------

function envUsd(key, fallbackUsd) {
	const raw = process.env[key];
	if (raw == null || String(raw).trim() === '') return fallbackUsd;
	const parsed = parseUsd(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackUsd;
}

function envNum(key, fallback) {
	const raw = process.env[key];
	if (raw == null || String(raw).trim() === '') return fallback;
	const n = Number(raw);
	return Number.isFinite(n) ? n : fallback;
}

/**
 * Resolve the guardrail config from env, with safe defaults. Read fresh on each
 * call so tests can flip env vars between cases without re-importing.
 *
 * @returns {{
 *   hirePriceUsd: number,
 *   maxPerCallUsd: number,
 *   maxPerSessionUsd: number,
 *   confirmThresholdUsd: number,
 *   minReputation: number,
 * }}
 */
export function guardrailConfig() {
	return {
		// The platform delegation fee — the real USDC the caller settles via x402
		// for one hire. Quoted up front by agent_hire_discover and charged by
		// agent_hire.
		hirePriceUsd: envUsd('MCP_AGENT_HIRE_PRICE_USD', 0.05),
		// Hard ceiling on a single hire. A call that would cost more is refused
		// before any payment settles.
		maxPerCallUsd: envUsd('MCP_AGENT_HIRE_MAX_PER_CALL_USD', 1),
		// Cumulative ceiling across one session (one MCP connection, or a
		// caller-supplied sessionId). Protects against a runaway loop draining a
		// budget one small hire at a time.
		maxPerSessionUsd: envUsd('MCP_AGENT_HIRE_MAX_PER_SESSION_USD', 5),
		// Spends at or above this require explicit `confirm: true` — the
		// confirmation semantics for anything non-trivial.
		confirmThresholdUsd: envUsd('MCP_AGENT_HIRE_CONFIRM_THRESHOLD_USD', 0.5),
		// Reputation floor (ERC-8004 average) applied as a default gate. 0 means
		// "don't gate by default"; a caller can raise it per call.
		minReputation: envNum('MCP_AGENT_HIRE_MIN_REPUTATION', 0),
	};
}

// ---------------------------------------------------------------------------
// In-process session spend ledger
// ---------------------------------------------------------------------------

// One MCP server process serves one client connection over stdio, so an
// in-process Map keyed by sessionId is exactly per-session state. The default
// session ("default") covers the whole connection; a caller can pass its own
// sessionId to scope a sub-budget (e.g. one task run).
const SESSIONS = new Map();

function sessionKey(sessionId) {
	const s = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : 'default';
	return s.slice(0, 200);
}

/**
 * Current cumulative settled spend for a session, in dollars.
 * @param {string} [sessionId]
 * @returns {number}
 */
export function getSessionSpend(sessionId) {
	const entry = SESSIONS.get(sessionKey(sessionId));
	return entry ? entry.spentUsd : 0;
}

/**
 * Hires recorded against a session (most-recent last). Each entry is the
 * provenance block of a completed hire.
 * @param {string} [sessionId]
 * @returns {object[]}
 */
export function getSessionHires(sessionId) {
	const entry = SESSIONS.get(sessionKey(sessionId));
	return entry ? entry.hires.slice() : [];
}

/**
 * Record a settled spend against a session. Called only after a hire succeeds
 * so the ledger reflects money that actually moved.
 *
 * @param {string} sessionId
 * @param {number} usd       — dollars spent on this hire
 * @param {object} [entry]   — provenance block to retain for the session history
 * @returns {number} the new cumulative spend
 */
export function recordSessionSpend(sessionId, usd, entry) {
	const key = sessionKey(sessionId);
	const amount = Number(usd);
	const safe = Number.isFinite(amount) && amount > 0 ? amount : 0;
	const cur = SESSIONS.get(key) || { spentUsd: 0, hires: [] };
	cur.spentUsd += safe;
	if (entry) cur.hires.push(entry);
	SESSIONS.set(key, cur);
	return cur.spentUsd;
}

/**
 * Reset a session's ledger (or all sessions when no id is given). Used by tests
 * and never on a live path.
 * @param {string} [sessionId]
 */
export function resetSession(sessionId) {
	if (sessionId === undefined) {
		SESSIONS.clear();
		return;
	}
	SESSIONS.delete(sessionKey(sessionId));
}

// ---------------------------------------------------------------------------
// Spend guardrail evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate every spend guardrail for a prospective hire WITHOUT mutating any
 * state. Returns an `allowed` verdict and, when blocked, a stable machine code
 * + human message + the numbers behind the decision so the tool can return a
 * clean error envelope (which cancels the x402 payment instead of settling it).
 *
 * Order matters: per-call ceiling, then confirmation, then per-session ceiling —
 * each independent so the caller learns the most specific blocker first.
 *
 * @param {object} args
 * @param {number} args.priceUsd            — cost of this hire (dollars)
 * @param {number} [args.maxSpendUsd]       — caller's per-call override (≤ hard cap)
 * @param {boolean} [args.confirm]          — caller confirmed an over-threshold spend
 * @param {string} [args.sessionId]
 * @param {object} [args.config]            — defaults to guardrailConfig()
 * @returns {{ allowed: boolean, code?: string, message?: string, limits: object }}
 */
export function evaluateSpendGuards({ priceUsd, maxSpendUsd, confirm, sessionId, config } = {}) {
	const cfg = config || guardrailConfig();
	const price = Number(priceUsd);
	const sessionSpent = getSessionSpend(sessionId);

	// A caller-supplied per-call budget can only ever TIGHTEN the hard ceiling,
	// never loosen it — taking the min closes the "raise my own cap" hole.
	const callerCap = Number.isFinite(maxSpendUsd) ? maxSpendUsd : Infinity;
	const effectivePerCall = Math.min(cfg.maxPerCallUsd, callerCap);

	const limits = {
		priceUsd: price,
		maxPerCallUsd: cfg.maxPerCallUsd,
		callerMaxSpendUsd: Number.isFinite(callerCap) ? callerCap : null,
		effectivePerCallUsd: effectivePerCall,
		confirmThresholdUsd: cfg.confirmThresholdUsd,
		maxPerSessionUsd: cfg.maxPerSessionUsd,
		sessionSpentUsd: sessionSpent,
		sessionRemainingUsd: Math.max(0, cfg.maxPerSessionUsd - sessionSpent),
		projectedSessionUsd: sessionSpent + (Number.isFinite(price) ? price : 0),
	};

	if (!Number.isFinite(price) || price < 0) {
		return {
			allowed: false,
			code: 'invalid_price',
			message: 'hire price could not be resolved to a non-negative USD amount',
			limits,
		};
	}

	if (price > effectivePerCall) {
		const capLabel =
			Number.isFinite(callerCap) && callerCap < cfg.maxPerCallUsd
				? `your maxSpendUsd of ${formatUsd(callerCap)}`
				: `the per-call cap of ${formatUsd(cfg.maxPerCallUsd)}`;
		return {
			allowed: false,
			code: 'spend_cap_exceeded',
			message: `this hire costs ${formatUsd(price)}, above ${capLabel}`,
			limits,
		};
	}

	if (price >= cfg.confirmThresholdUsd && confirm !== true) {
		return {
			allowed: false,
			code: 'confirmation_required',
			message: `this hire costs ${formatUsd(price)}, at or above the ${formatUsd(
				cfg.confirmThresholdUsd,
			)} confirmation threshold — re-call with confirm: true to authorize it`,
			limits,
		};
	}

	if (sessionSpent + price > cfg.maxPerSessionUsd) {
		return {
			allowed: false,
			code: 'session_cap_exceeded',
			message: `this hire (${formatUsd(price)}) would push session spend to ${formatUsd(
				sessionSpent + price,
			)}, above the per-session cap of ${formatUsd(cfg.maxPerSessionUsd)}`,
			limits,
		};
	}

	return { allowed: true, limits };
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

// The Solana mainnet settlement context every paid tool uses (mirrors
// payments.js). Surfaced in provenance so the receipt names the rails.
const SETTLEMENT_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const SETTLEMENT_ASSET = 'USDC';

/**
 * Build the provenance block for a completed hire — the structured payload the
 * receipt card renders and the host model reasons over. Deterministic and
 * pure: the live settlement transaction reference is attached separately by the
 * x402 wrapper under _meta["x402/payment-response"]; here we record everything
 * known at handler time plus a pointer to where the on-chain reference lands.
 *
 * @param {object} args
 * @param {string} args.agentId
 * @param {string} [args.agentName]
 * @param {object|null} [args.reputation]   — { average, count, source, ... } or null
 * @param {number} [args.capabilityMatch]   — 0..1 task/skill fit score
 * @param {number} args.amountUsd           — dollars settled for this hire
 * @param {number} args.latencyMs           — remote-agent execution latency
 * @param {string} [args.model]             — model the remote agent ran
 * @param {string} [args.payTo]             — Solana receiver address (if known)
 * @param {string} [args.task]              — the task/message delegated
 * @returns {object} provenance block
 */
export function buildProvenance({
	agentId,
	agentName,
	reputation = null,
	capabilityMatch,
	amountUsd,
	latencyMs,
	model,
	payTo,
	task,
}) {
	const amount = Number(amountUsd);
	return {
		agentId: agentId || null,
		agentName: agentName || null,
		task: typeof task === 'string' ? task.slice(0, 280) : null,
		reputation: reputation
			? {
					average: reputation.average ?? null,
					count: reputation.count ?? null,
					source: reputation.source || 'erc8004',
					chain: reputation.chain || null,
					erc8004AgentId: reputation.erc8004AgentId || null,
			  }
			: null,
		capabilityMatch:
			typeof capabilityMatch === 'number' && Number.isFinite(capabilityMatch)
				? Math.round(capabilityMatch * 100) / 100
				: null,
		payment: {
			amountUsd: Number.isFinite(amount) ? Math.round(amount * 1e6) / 1e6 : null,
			amountDisplay: Number.isFinite(amount) ? formatUsd(amount) : null,
			asset: SETTLEMENT_ASSET,
			network: SETTLEMENT_NETWORK,
			networkLabel: 'Solana mainnet',
			scheme: 'exact',
			payTo: payTo || null,
			// The real, on-chain settlement reference is attached by the x402
			// payment wrapper to the result _meta — this names where to read it so
			// nothing here is ever a fabricated tx.
			settlementRef: 'see _meta["x402/payment-response"]',
		},
		model: model || null,
		latencyMs: Number.isFinite(Number(latencyMs)) ? Number(latencyMs) : null,
		settledAt: new Date().toISOString(),
	};
}

export { SETTLEMENT_NETWORK, SETTLEMENT_ASSET };
