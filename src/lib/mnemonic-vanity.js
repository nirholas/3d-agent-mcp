// Mnemonic (BIP-39 seed phrase) vanity grinder for the `vanity_grinder` MCP
// tool. The sibling pump-vanity.js grinds raw Ed25519 keypairs that have no
// recovery phrase; this grinds a fresh BIP-39 mnemonic each attempt, derives the
// Solana key at m/44'/501'/0'/0' (Phantom's default), and matches the resulting
// address — so a hit yields an importable seed phrase, not just a private key.
//
// Each attempt runs PBKDF2-HMAC-SHA512 (2048 iterations) and is ~100× costlier
// than a raw keypair, so the combined pattern is capped at 2 base58 chars and
// the iteration budget is small. On exhaustion the grinder throws (status 504)
// so the paid MCP tool reports isError and the caller is NOT charged.

import { generateMnemonic, deriveSolanaKeypair, STRENGTH_WORD_COUNTS, DEFAULT_STRENGTH } from './mnemonic.js';
import { BASE58_ALPHABET, estimateAttempts } from './pump-vanity.js';

const BASE58_CHARS = new Set(BASE58_ALPHABET);

// Combined prefix+suffix ceiling for mnemonic mode. Below the raw-keypair limit
// of 6 because seed-phrase grinding is ~100× slower.
export const MAX_MNEMONIC_PATTERN_LENGTH = 2;

// Default / hard-cap iteration budget. At ~220 derivations/sec single-threaded,
// 10k attempts ≈ 45s and clears a 2-char pattern (~3.4k expected) ~95% of the
// time. The hard cap keeps a single paid call from pinning the event loop for
// minutes.
export const DEFAULT_MNEMONIC_MAX_ITERATIONS = 10_000;
export const MAX_MNEMONIC_ITERATIONS_CAP = 20_000;
const YIELD_EVERY = 200;

function vanityError(code, msg, status = 400) {
	return Object.assign(new Error(msg), { status, code });
}

function validatePattern(pattern, label) {
	if (typeof pattern !== 'string' || pattern.length === 0) {
		throw vanityError('invalid_vanity', `${label} must be a non-empty string`);
	}
	if (pattern !== pattern.trim()) {
		throw vanityError('invalid_vanity', `${label} contains whitespace`);
	}
	for (let i = 0; i < pattern.length; i++) {
		if (!BASE58_CHARS.has(pattern[i])) {
			throw vanityError('invalid_vanity', `${label}: invalid base58 char '${pattern[i]}' at position ${i + 1}`);
		}
	}
}

/**
 * Grind a Solana keypair recoverable from a BIP-39 mnemonic, whose base58
 * address matches a prefix and/or suffix.
 *
 * @param {object} opts
 * @param {string} [opts.prefix]
 * @param {string} [opts.suffix]
 * @param {boolean} [opts.ignoreCase=false]
 * @param {number} [opts.strength=128]        BIP-39 entropy bits (128→12 words, 256→24).
 * @param {number} [opts.maxIterations]
 * @returns {Promise<{ mnemonic:string, wordCount:number, derivationPath:string, keypair:import('@solana/web3.js').Keypair, iterations:number, durationMs:number }>}
 */
export async function grindMnemonicKeypair({
	prefix,
	suffix,
	ignoreCase = false,
	strength = DEFAULT_STRENGTH,
	maxIterations = DEFAULT_MNEMONIC_MAX_ITERATIONS,
} = {}) {
	if (!prefix && !suffix) throw vanityError('invalid_vanity', 'prefix or suffix is required');
	if (!STRENGTH_WORD_COUNTS[strength]) throw vanityError('invalid_vanity', `invalid strength ${strength} (use 128 or 256)`);
	if (prefix) validatePattern(prefix, 'prefix');
	if (suffix) validatePattern(suffix, 'suffix');

	const combinedLength = (prefix?.length || 0) + (suffix?.length || 0);
	if (combinedLength > MAX_MNEMONIC_PATTERN_LENGTH) {
		throw vanityError(
			'invalid_vanity',
			`combined pattern length ${combinedLength} exceeds the mnemonic-mode limit of ${MAX_MNEMONIC_PATTERN_LENGTH} ` +
				`(seed-phrase grinding is ~100× slower) — use a shorter pattern, or drop the mnemonic option for a raw keypair`,
		);
	}

	const cap = Math.min(Math.max(1, Math.floor(maxIterations)), MAX_MNEMONIC_ITERATIONS_CAP);
	const targetPrefix = prefix ? (ignoreCase ? prefix.toLowerCase() : prefix) : null;
	const targetSuffix = suffix ? (ignoreCase ? suffix.toLowerCase() : suffix) : null;
	const pLen = targetPrefix?.length || 0;
	const sLen = targetSuffix?.length || 0;

	const start = Date.now();
	for (let i = 1; i <= cap; i++) {
		const mnemonic = generateMnemonic(strength);
		const { keypair, derivationPath } = deriveSolanaKeypair(mnemonic);
		const addr = keypair.publicKey.toBase58();

		const head = ignoreCase ? addr.slice(0, pLen).toLowerCase() : addr.slice(0, pLen);
		if (targetPrefix && head !== targetPrefix) {
			if (i % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
			continue;
		}
		const tail = ignoreCase ? addr.slice(addr.length - sLen).toLowerCase() : addr.slice(addr.length - sLen);
		if (targetSuffix && tail !== targetSuffix) {
			if (i % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
			continue;
		}

		return {
			mnemonic,
			wordCount: STRENGTH_WORD_COUNTS[strength],
			derivationPath,
			keypair,
			iterations: i,
			durationMs: Date.now() - start,
		};
	}

	throw vanityError(
		'vanity_timeout',
		`vanity ${prefix ? `prefix '${prefix}'` : ''}${prefix && suffix ? ' + ' : ''}${suffix ? `suffix '${suffix}'` : ''} ` +
			`not found in ${cap} mnemonic attempts (estimated ~${Math.round(estimateAttempts({ prefix, suffix, ignoreCase })).toLocaleString()}) ` +
			`— retry, use a shorter pattern, or enable ignoreCase`,
		504,
	);
}
