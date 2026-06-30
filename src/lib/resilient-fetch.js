// Resilient HTTP layer shared by every MCP tool.
//
// The tools previously each called bare `fetch()` — most with no timeout and
// none with a retry. A single transient blip (a 429 burst, a 502 from a CDN, a
// dropped socket) failed the whole tool call. This module gives every outbound
// request three guarantees:
//
//   1. It ALWAYS times out. No request can hang forever and block a paid tool
//      (which, on a hang, could settle a payment with no result).
//   2. Transient failures are retried with exponential backoff + full jitter,
//      honoring the server's `Retry-After` on 429/503.
//   3. Retries are SAFE: only idempotent methods (GET/HEAD) are retried by
//      default, so a non-idempotent POST (start a job, send an agent message)
//      is never silently duplicated. A caller that knows its POST is safe to
//      replay can opt in with `retryNonIdempotent: true`.
//
// `resilientFetch` returns a `Response` (drop-in for `fetch`); `fetchJson`
// layers JSON parsing + non-2xx → throw on top of it.

const DEFAULT_RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Sleep that rejects promptly if an AbortSignal fires, so a caller-supplied
 * deadline can cut a backoff wait short instead of waiting it out.
 */
function abortableDelay(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener?.('abort', onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
		}
		signal?.addEventListener?.('abort', onAbort, { once: true });
	});
}

/**
 * Parse a `Retry-After` header into milliseconds. Supports both the
 * delta-seconds form (`120`) and the HTTP-date form. Returns null when absent
 * or unparseable so the caller falls back to computed backoff.
 */
function parseRetryAfterMs(res) {
	const raw = res?.headers?.get?.('retry-after');
	if (!raw) return null;
	const secs = Number(raw);
	if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
	const when = Date.parse(raw);
	if (Number.isFinite(when)) return Math.max(0, when - Date.now());
	return null;
}

/**
 * Full-jitter exponential backoff: a random wait in [0, cap] where the cap
 * doubles each attempt. Full jitter (vs. fixed backoff) spreads a thundering
 * herd of simultaneous retries so they don't re-collide on the next attempt.
 */
function backoffMs(attempt, baseDelayMs, maxDelayMs) {
	const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
	return Math.floor(Math.random() * cap);
}

/**
 * fetch() with a hard timeout and safe, jittered retries.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=10000]   per-attempt timeout
 * @param {number} [opts.retries=2]          retry count (total attempts = retries + 1)
 * @param {number} [opts.baseDelayMs=250]    backoff base
 * @param {number} [opts.maxDelayMs=4000]    backoff cap
 * @param {Set<number>|number[]} [opts.retryStatuses]  HTTP statuses worth retrying
 * @param {boolean} [opts.retryNonIdempotent=false]    allow retrying non-GET/HEAD
 * @param {AbortSignal} [opts.signal]        external deadline/cancel
 * @param {string} [opts.label]              short name used in thrown error messages
 * @returns {Promise<Response>}
 */
export async function resilientFetch(url, init = {}, opts = {}) {
	const {
		timeoutMs = 10_000,
		retries = 2,
		baseDelayMs = 250,
		maxDelayMs = 4_000,
		retryStatuses,
		retryNonIdempotent = false,
		signal: externalSignal,
		label,
	} = opts;

	const statuses = retryStatuses
		? retryStatuses instanceof Set
			? retryStatuses
			: new Set(retryStatuses)
		: DEFAULT_RETRY_STATUSES;
	const method = (init.method || 'GET').toUpperCase();
	const mayRetry = retryNonIdempotent || IDEMPOTENT_METHODS.has(method);
	const name = label || `${method} ${url}`;

	let lastErr = null;
	for (let attempt = 0; attempt <= retries; attempt += 1) {
		if (externalSignal?.aborted) {
			throw externalSignal.reason instanceof Error
				? externalSignal.reason
				: new Error(`${name}: aborted`);
		}

		// Fresh controller per attempt (abort is one-shot). Abort on either the
		// per-attempt timeout OR the caller's external signal.
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
		const onExternalAbort = () => controller.abort();
		externalSignal?.addEventListener?.('abort', onExternalAbort, { once: true });

		try {
			const res = await fetch(url, { ...init, signal: controller.signal });

			// Retry on transient status codes if attempts remain and the method
			// is replay-safe. Drain the body so the socket can be reused.
			if (statuses.has(res.status) && attempt < retries && mayRetry) {
				const retryAfter = parseRetryAfterMs(res);
				try {
					await res.arrayBuffer();
				} catch {
					/* ignore drain failure */
				}
				lastErr = new Error(`${name} → HTTP ${res.status}`);
				const wait = retryAfter ?? backoffMs(attempt, baseDelayMs, maxDelayMs);
				await abortableDelay(wait, externalSignal);
				continue;
			}
			return res;
		} catch (err) {
			// Distinguish a timeout from an external cancel: an external abort is
			// the caller's deadline and must not be retried.
			if (externalSignal?.aborted && !timedOut) {
				throw externalSignal.reason instanceof Error
					? externalSignal.reason
					: new Error(`${name}: aborted`);
			}
			const normalized = timedOut
				? Object.assign(new Error(`${name}: timed out after ${timeoutMs}ms`), {
						name: 'TimeoutError',
					})
				: err;
			lastErr = normalized;

			// A thrown fetch() error is always a network drop or timeout (HTTP
			// error statuses resolve, they don't throw), so it is retryable for
			// any replay-safe method while attempts remain.
			if (attempt < retries && mayRetry) {
				await abortableDelay(backoffMs(attempt, baseDelayMs, maxDelayMs), externalSignal);
				continue;
			}
			throw normalized;
		} finally {
			clearTimeout(timer);
			externalSignal?.removeEventListener?.('abort', onExternalAbort);
		}
	}
	throw lastErr || new Error(`${name}: exhausted retries`);
}

/**
 * resilientFetch + JSON. Throws on a non-2xx final response (after retries) and
 * on a body that isn't valid JSON, matching the `fetchJson` contract the tools
 * already expect. Use for read endpoints that return JSON.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {object} [opts]  same options as resilientFetch
 * @returns {Promise<any>}
 */
export async function fetchJson(url, init = {}, opts = {}) {
	const label = opts.label || `${(init.method || 'GET').toUpperCase()} ${url}`;
	const res = await resilientFetch(url, init, opts);
	if (!res.ok) {
		throw new Error(`${label} → HTTP ${res.status}`);
	}
	return res.json();
}

export { DEFAULT_RETRY_STATUSES, parseRetryAfterMs, backoffMs };
