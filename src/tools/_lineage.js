// Conversational-refinement lineage — the pure core of iterative 3D.
//
// This module is the single source of truth for two things shared by BOTH the
// free OpenAI Apps studio (api/_mcp-studio) and the paid stdio MCP server
// (mcp-server/src/tools/refine-model.js):
//
//   1. composeRefinement(parentPrompt, instruction) — how a natural-language
//      change ("make it metallic", "bigger helmet") is folded into the prior
//      prompt to drive a REAL anchored re-generation. No faked diffing: the
//      refined prompt is what the generator actually runs.
//   2. version lineage — every refinement records parent → child so a client
//      can show a version strip and the user can revert or branch. The lineage
//      array IS the durable record returned in structuredContent.
//
// It is intentionally dependency-free (no fetch, no DB, no payment/schema) so it
// loads unchanged in the published npm package, in the Vercel api/ bundle, and
// in the unit tests. It carries ZERO payment, royalty, coin, or wallet surface —
// conversational iteration is free on every track.

// Leading filler an imperative instruction tends to open with. Stripped so the
// remainder reads as a descriptive modifier the text-to-3D model can condition
// on ("make it metallic" → "metallic", "now add wings" → "add wings"). Order
// matters: longer phrases first so "make the" is tried before "make".
const INSTRUCTION_PREFIXES = [
	'could you please',
	'can you please',
	'i would like it to be',
	'i want it to be',
	'i want it to',
	'i want it',
	'i want',
	'please can you',
	'could you',
	'can you',
	'please make it',
	'please make the',
	'please make',
	'please',
	'now make it',
	'now make the',
	'now make',
	'now',
	'make it more',
	'make it',
	'make the',
	'make',
	'turn it into a',
	'turn it into an',
	'turn it into',
	'change it to a',
	'change it to an',
	'change it to',
	'change it so it is',
	'change it so its',
	'change the',
	'change it',
	'give it',
	'lets',
	"let's",
];

const MAX_PROMPT_LEN = 1000;

/**
 * Normalize a free-text instruction into a compact descriptive modifier:
 * trim, collapse whitespace, drop a leading polite/imperative prefix, and strip
 * a trailing period. Pure and deterministic — the value tested in isolation.
 *
 * @param {string} instruction
 * @returns {string} the cleaned modifier (may equal the input when no prefix matched)
 */
export function normalizeInstruction(instruction) {
	let s = String(instruction || '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!s) return '';
	const lower = s.toLowerCase();
	for (const prefix of INSTRUCTION_PREFIXES) {
		if (lower === prefix) {
			// The instruction was pure filler with no payload — keep it as-is so the
			// caller still has something to fold in rather than an empty modifier.
			return s;
		}
		if (lower.startsWith(prefix + ' ')) {
			s = s.slice(prefix.length + 1).trim();
			break;
		}
	}
	return s.replace(/[.\s]+$/, '').trim();
}

/**
 * Fold a natural-language change into the prior prompt, anchoring the new
 * generation to the previous result. The parent prompt is the base (so form,
 * subject, and materials carry forward) and the cleaned instruction is appended
 * as an explicit modifier clause. Deterministic; capped to the generator limit.
 *
 * When the parent prompt is unknown (e.g. an image-only origin) the instruction
 * stands alone — still a real prompt, just without carry-forward text.
 *
 * @param {string} parentPrompt  the prompt that produced the parent model
 * @param {string} instruction   the requested change
 * @returns {string} the prompt the generator will actually run
 */
export function composeRefinement(parentPrompt, instruction) {
	const base = String(parentPrompt || '')
		.replace(/\s+/g, ' ')
		.trim();
	const modifier = normalizeInstruction(instruction);
	let composed;
	if (base && modifier) composed = `${base}, ${modifier}`;
	else composed = base || modifier;
	if (composed.length > MAX_PROMPT_LEN) composed = composed.slice(0, MAX_PROMPT_LEN).trim();
	return composed;
}

// ── Version lineage ──────────────────────────────────────────────────────────
//
// A lineage is an ordered array of immutable version records. Index 0 is the
// origin; each later version points at its parent by index. Reverting does not
// mutate history — it moves the "active" pointer; branching appends a child off
// an earlier (non-leaf) version, producing a tree.

/**
 * Start a lineage from an origin model (the first generation in a thread).
 * @param {{ glbUrl:string, viewerUrl?:string, prompt?:string }} origin
 * @returns {Array<object>} a one-element lineage
 */
export function seedLineage({ glbUrl, viewerUrl, prompt }) {
	return [
		{
			index: 0,
			parentIndex: null,
			glbUrl,
			viewerUrl: viewerUrl || null,
			prompt: prompt || null,
			instruction: null,
			refKind: 'origin',
		},
	];
}

/**
 * Append a refined version. Defaults the parent to the lineage's last entry;
 * pass `parentIndex` to branch off an earlier version. Returns a NEW array
 * (immutable history) — never mutates the input.
 *
 * @param {Array<object>} lineage
 * @param {{ glbUrl:string, viewerUrl?:string, prompt?:string, instruction?:string,
 *           refKind?:string, parentIndex?:number }} version
 * @returns {Array<object>} the extended lineage
 */
export function appendVersion(lineage, version) {
	const prior = Array.isArray(lineage) ? lineage : [];
	const index = prior.length;
	const parentIndex =
		Number.isInteger(version.parentIndex) && version.parentIndex >= 0 && version.parentIndex < index
			? version.parentIndex
			: index > 0
				? index - 1
				: null;
	const next = {
		index,
		parentIndex,
		glbUrl: version.glbUrl,
		viewerUrl: version.viewerUrl || null,
		prompt: version.prompt || null,
		instruction: version.instruction || null,
		refKind: version.refKind || 'text',
	};
	return [...prior, next];
}

/**
 * The parent index a branch off `index` should use for its next append. Thin,
 * but names the intent at call sites (branchFrom(lineage, 1) reads clearly).
 */
export function branchFrom(lineage, index) {
	const n = Array.isArray(lineage) ? lineage.length : 0;
	if (!Number.isInteger(index) || index < 0 || index >= n) {
		throw new Error(`branchFrom: no version at index ${index}`);
	}
	return index;
}

/**
 * Resolve the active version when reverting to `index`. History is immutable, so
 * a revert is just a validated pointer move; the returned object is the version
 * the client should display.
 *
 * @returns {{ activeIndex:number, active:object }}
 */
export function revertTo(lineage, index) {
	const arr = Array.isArray(lineage) ? lineage : [];
	const found = arr.find((v) => v.index === index);
	if (!found) throw new Error(`revertTo: no version at index ${index}`);
	return { activeIndex: index, active: found };
}

/**
 * Validate lineage integrity and return the root→leaf chain for `activeIndex`
 * (defaults to the highest index). Pure — the invariant checks are unit-tested.
 *
 * Checks: indices are unique and contiguous from 0; exactly one root
 * (parentIndex === null); every non-root parent points at a strictly-earlier
 * existing index (which forbids cycles); the active index exists.
 *
 * @returns {{ ok:boolean, errors:string[], roots:number[], leaves:number[],
 *             chain:object[], activeIndex:number }}
 */
export function buildLineageChain(lineage, activeIndex) {
	const arr = Array.isArray(lineage) ? lineage : [];
	const errors = [];
	const byIndex = new Map();
	for (const v of arr) {
		if (byIndex.has(v.index)) errors.push(`duplicate index ${v.index}`);
		byIndex.set(v.index, v);
	}
	// Contiguous-from-0 keeps the array position == index, the contract the
	// client's version strip relies on.
	for (let i = 0; i < arr.length; i++) {
		if (!byIndex.has(i)) errors.push(`missing index ${i}`);
	}
	const roots = arr.filter((v) => v.parentIndex === null || v.parentIndex === undefined).map((v) => v.index);
	if (roots.length !== 1) errors.push(`expected exactly one root, found ${roots.length}`);
	const childCount = new Map();
	for (const v of arr) {
		if (v.parentIndex === null || v.parentIndex === undefined) continue;
		if (!byIndex.has(v.parentIndex)) {
			errors.push(`version ${v.index} references missing parent ${v.parentIndex}`);
		} else if (v.parentIndex >= v.index) {
			// A parent at or after the child would allow a cycle; the contiguous
			// append model guarantees parents are strictly earlier.
			errors.push(`version ${v.index} parent ${v.parentIndex} is not earlier`);
		}
		childCount.set(v.parentIndex, (childCount.get(v.parentIndex) || 0) + 1);
	}
	const leaves = arr.filter((v) => !childCount.has(v.index)).map((v) => v.index);

	const active = Number.isInteger(activeIndex) ? activeIndex : arr.length ? arr.length - 1 : -1;
	if (arr.length && !byIndex.has(active)) errors.push(`active index ${active} does not exist`);

	// Walk parent links from the active version up to the root.
	const chain = [];
	if (errors.length === 0 && byIndex.has(active)) {
		let cursor = active;
		const guard = new Set();
		while (cursor !== null && cursor !== undefined) {
			if (guard.has(cursor)) {
				errors.push(`cycle detected at index ${cursor}`);
				break;
			}
			guard.add(cursor);
			const node = byIndex.get(cursor);
			chain.unshift(node);
			cursor = node.parentIndex;
		}
	}

	return {
		ok: errors.length === 0,
		errors,
		roots,
		leaves,
		chain,
		activeIndex: active,
	};
}

/**
 * Compact, client-facing view of a lineage for a version strip: just what the
 * widget needs to render thumbnails and wire revert/branch. No identifiers.
 */
export function summarizeLineage(lineage, activeIndex) {
	const arr = Array.isArray(lineage) ? lineage : [];
	const active = Number.isInteger(activeIndex) ? activeIndex : arr.length ? arr.length - 1 : 0;
	return arr.map((v) => ({
		index: v.index,
		parentIndex: v.parentIndex,
		glbUrl: v.glbUrl,
		viewerUrl: v.viewerUrl || null,
		label: v.refKind === 'origin' ? 'Original' : v.instruction || `Version ${v.index}`,
		instruction: v.instruction || null,
		active: v.index === active,
	}));
}
