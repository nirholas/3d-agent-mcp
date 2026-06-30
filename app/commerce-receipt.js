// MCP App (iframe) for the agent_hire provenance receipt.
//
// Renders a transaction/provenance card inline in the host: which agent was
// hired, its live ERC-8004 reputation, the USDC amount settled, the real
// on-chain settlement reference (read from the tool result's
// _meta["x402/payment-response"]), the latency, and the delegated result. The
// whole point is trust through visibility — the user sees exactly what the host
// model did, who it paid, and what it cost.
//
// Bundled (esbuild) and inlined into src/ui/commerce-receipt.html by
// app/build.mjs. No external network calls, no analytics, no token surface —
// USDC appears only as the settlement unit, never as a promoted coin.

import { App } from '@modelcontextprotocol/ext-apps';

const PAYMENT_RESPONSE_META_KEY = 'x402/payment-response';

const els = {
	card: document.getElementById('card'),
	status: document.getElementById('status'),
	agentName: document.getElementById('agent-name'),
	agentId: document.getElementById('agent-id'),
	repBadge: document.getElementById('rep-badge'),
	repDetail: document.getElementById('rep-detail'),
	matchBar: document.getElementById('match-bar'),
	matchPct: document.getElementById('match-pct'),
	amount: document.getElementById('amount'),
	asset: document.getElementById('asset'),
	network: document.getElementById('network'),
	latency: document.getElementById('latency'),
	settleRow: document.getElementById('settle-row'),
	settleRef: document.getElementById('settle-ref'),
	settleLink: document.getElementById('settle-link'),
	task: document.getElementById('task'),
	response: document.getElementById('response'),
	responseWrap: document.getElementById('response-wrap'),
};

function short(s, head = 6, tail = 6) {
	if (typeof s !== 'string' || s.length <= head + tail + 1) return s || '';
	return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

// Solana explorer link for a settled tx signature. Only ever a Solana mainnet
// explorer — never an arbitrary URL.
function explorerUrl(sig) {
	if (typeof sig !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{43,90}$/.test(sig)) return null;
	return `https://solscan.io/tx/${sig}`;
}

function reputationClass(avg) {
	if (avg == null) return 'rep-unknown';
	if (avg >= 0.66) return 'rep-high';
	if (avg >= 0.2) return 'rep-mid';
	return 'rep-low';
}

function showError(message) {
	els.status.hidden = false;
	els.status.textContent = message;
	els.card.hidden = true;
}

function applyResult(result) {
	const sc = (result && result.structuredContent) || {};
	// agent_hire returns { ok, provenance, result, ... }. Tolerate the provenance
	// block being the top-level object too.
	const prov = sc.provenance || (sc.payment ? sc : null);

	if (sc.ok === false) {
		showError(sc.message || sc.error || 'The hire was blocked.');
		return;
	}
	if (!prov) {
		showError('Waiting for a hire receipt…');
		return;
	}

	els.status.hidden = true;
	els.card.hidden = false;

	els.agentName.textContent = prov.agentName || 'Agent';
	els.agentId.textContent = prov.agentId ? short(prov.agentId, 8, 6) : '';

	// Reputation badge
	const rep = prov.reputation;
	const avg = rep && typeof rep.average === 'number' ? rep.average : null;
	els.repBadge.className = `badge ${reputationClass(avg)}`;
	if (rep && avg != null) {
		els.repBadge.textContent = `rep ${avg.toFixed(2)}`;
		els.repDetail.textContent = `${rep.count || 0} vouch${rep.count === 1 ? '' : 'es'} · ${rep.source || 'erc8004'}${rep.chain ? ` · ${rep.chain}` : ''}`;
	} else if (rep) {
		els.repBadge.textContent = 'on-chain id';
		els.repDetail.textContent = `ERC-8004 #${rep.erc8004AgentId || '?'} · no vouches yet`;
	} else {
		els.repBadge.textContent = 'unrated';
		els.repDetail.textContent = 'no on-chain reputation record';
	}

	// Capability match
	const match = typeof prov.capabilityMatch === 'number' ? Math.max(0, Math.min(1, prov.capabilityMatch)) : null;
	if (match != null) {
		els.matchBar.style.width = `${(match * 100).toFixed(0)}%`;
		els.matchPct.textContent = `${(match * 100).toFixed(0)}% task fit`;
	} else {
		els.matchBar.style.width = '0%';
		els.matchPct.textContent = 'task fit n/a';
	}

	// Payment
	const pay = prov.payment || {};
	els.amount.textContent = pay.amountDisplay || (pay.amountUsd != null ? `$${pay.amountUsd}` : '—');
	els.asset.textContent = pay.asset || 'USDC';
	els.network.textContent = pay.networkLabel || 'Solana';
	els.latency.textContent = prov.latencyMs != null ? `${(prov.latencyMs / 1000).toFixed(1)}s` : '—';

	// Real settlement reference from _meta (attached by the x402 wrapper).
	const settle = (result && result._meta && result._meta[PAYMENT_RESPONSE_META_KEY]) || null;
	const sig = settle && (settle.transaction || settle.txHash || settle.signature);
	if (sig) {
		els.settleRow.hidden = false;
		els.settleRef.textContent = short(sig, 8, 8);
		const url = explorerUrl(sig);
		if (url) {
			els.settleLink.href = url;
			els.settleLink.hidden = false;
		} else {
			els.settleLink.hidden = true;
		}
	} else {
		// Settlement reference not yet present (e.g. preview, or host strips _meta).
		els.settleRow.hidden = false;
		els.settleRef.textContent = settle && settle.success === false ? 'settlement failed' : 'settled via x402';
		els.settleLink.hidden = true;
	}

	// Task + delegated result
	els.task.textContent = prov.task || sc.task || '';
	const responseText = sc.result && (sc.result.response || sc.result.text);
	if (responseText) {
		els.response.textContent = responseText;
		els.responseWrap.hidden = false;
	} else {
		els.responseWrap.hidden = true;
	}
}

const app = new App({ name: 'three.ws Agent Hire Receipt', version: '1.0.0' });

app.ontoolresult = (params) => applyResult(params);
app.onerror = (err) => console.error('[commerce-receipt]', err);
app.onhostcontextchanged = (ctx) => {
	if (ctx && ctx.theme) document.documentElement.dataset.theme = ctx.theme;
};

app.connect().catch((err) => {
	showError('Waiting for an MCP host…');
	console.warn('[commerce-receipt] not connected to a host:', err?.message || err);
});
