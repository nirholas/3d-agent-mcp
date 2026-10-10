// Vendored from the three.ws monorepo: src/solana/vanity/mnemonic.js. Kept in
// sync by hand so this package is self-contained when published to npm. Do not
// edit here — edit the canonical src/solana/vanity/mnemonic.js and re-copy
// (alongside bip39-english.js).

/**
 * BIP-39 mnemonic ↔ Solana keypair derivation — zero runtime dependencies
 * beyond Node's built-in `crypto` and `@solana/web3.js`.
 *
 * Why hand-rolled instead of pulling in `bip39` + `ed25519-hd-key`: this module
 * ships inside Vercel serverless functions and a published MCP package, and we
 * refuse to take a runtime dependency on an undeclared transitive install. Every
 * primitive used here is a standard-library call (`pbkdf2Sync`, `createHmac`,
 * `createHash`, `randomBytes`) plus the vendored BIP-39 wordlist, so the feature
 * is fully self-contained and reproducible.
 *
 * Correctness is pinned by canonical test vectors (the BIP-39 "TREZOR" vectors
 * and the SLIP-0010 ed25519 vectors) in test/vanity-mnemonic.test.js, and the
 * derived address is verified byte-for-byte against `near-hd-key` so a mnemonic
 * we emit imports into Phantom / Solflare / the Solana CLI at the exact same
 * address. The default path is m/44'/501'/0'/0' — Phantom's first account.
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { Keypair } from '@solana/web3.js';

import { ENGLISH_WORDLIST } from './bip39-english.js';

// Phantom / Solflare / Solana-CLI "derived" account path. The trailing two
// levels are the account and change indices; index 0 is the first wallet.
export const SOLANA_PURPOSE = 44;
export const SOLANA_COIN_TYPE = 501;
export const DEFAULT_DERIVATION_PATH = "m/44'/501'/0'/0'";

// Supported BIP-39 entropy strengths → mnemonic word counts. 128 bits → 12
// words (the wallet default), 256 bits → 24 words (maximum security margin).
export const STRENGTH_WORD_COUNTS = Object.freeze({ 128: 12, 160: 15, 192: 18, 224: 21, 256: 24 });
const VALID_STRENGTHS = Object.keys(STRENGTH_WORD_COUNTS).map(Number);
export const DEFAULT_STRENGTH = 128;

const WORD_INDEX = new Map(ENGLISH_WORDLIST.map((w, i) => [w, i]));

function err(message, code = 'mnemonic_error', status = 400) {
	return Object.assign(new Error(message), { code, status });
}

/**
 * Encode raw entropy as a BIP-39 mnemonic. Entropy length must be one of the
 * supported strengths (16/20/24/28/32 bytes). The checksum is the leading
 * ENT/32 bits of SHA-256(entropy), appended before slicing into 11-bit words.
 * @param {Uint8Array|Buffer} entropy
 * @returns {string} space-joined mnemonic
 */
export function entropyToMnemonic(entropy) {
	const bytes = Buffer.from(entropy);
	const ENT = bytes.length * 8;
	if (!VALID_STRENGTHS.includes(ENT)) {
		throw err(`invalid entropy length ${bytes.length} bytes — expected one of ${VALID_STRENGTHS.map((b) => b / 8).join(', ')}`);
	}
	const checksumBits = ENT / 32;
	const hash = createHash('sha256').update(bytes).digest();
	let bits = '';
	for (const b of bytes) bits += b.toString(2).padStart(8, '0');
	for (const b of hash) bits += b.toString(2).padStart(8, '0');
	bits = bits.slice(0, ENT + checksumBits);

	const words = [];
	for (let i = 0; i < bits.length; i += 11) {
		words.push(ENGLISH_WORDLIST[parseInt(bits.slice(i, i + 11), 2)]);
	}
	return words.join(' ');
}

/**
 * Generate a fresh random BIP-39 mnemonic at the requested strength (default
 * 128-bit / 12 words). Uses the CSPRNG via `crypto.randomBytes`.
 * @param {number} [strength=128] bits of entropy
 * @returns {string}
 */
export function generateMnemonic(strength = DEFAULT_STRENGTH) {
	if (!VALID_STRENGTHS.includes(strength)) {
		throw err(`invalid strength ${strength} — expected one of ${VALID_STRENGTHS.join(', ')}`);
	}
	return entropyToMnemonic(randomBytes(strength / 8));
}

/**
 * Validate a mnemonic: every word in the list, valid word count, and a correct
 * BIP-39 checksum. Returns true/false (does not throw) for cheap guard use.
 * @param {string} mnemonic
 * @returns {boolean}
 */
export function validateMnemonic(mnemonic) {
	if (typeof mnemonic !== 'string') return false;
	const words = mnemonic.normalize('NFKD').trim().split(/\s+/);
	if (!Object.values(STRENGTH_WORD_COUNTS).includes(words.length)) return false;

	let bits = '';
	for (const w of words) {
		const idx = WORD_INDEX.get(w);
		if (idx === undefined) return false;
		bits += idx.toString(2).padStart(11, '0');
	}
	const dividerIndex = Math.floor(bits.length / 33) * 32;
	const entropyBits = bits.slice(0, dividerIndex);
	const checksumBits = bits.slice(dividerIndex);

	const entropyBytes = Buffer.alloc(entropyBits.length / 8);
	for (let i = 0; i < entropyBytes.length; i++) {
		entropyBytes[i] = parseInt(entropyBits.slice(i * 8, i * 8 + 8), 2);
	}
	const hash = createHash('sha256').update(entropyBytes).digest();
	let expected = '';
	for (const b of hash) expected += b.toString(2).padStart(8, '0');
	return checksumBits === expected.slice(0, checksumBits.length);
}

/**
 * BIP-39 mnemonic → 64-byte seed via PBKDF2-HMAC-SHA512 (2048 iterations), per
 * the standard. The optional passphrase (BIP-39 "25th word") salts the KDF.
 * @param {string} mnemonic
 * @param {string} [passphrase='']
 * @returns {Buffer} 64-byte seed
 */
export function mnemonicToSeed(mnemonic, passphrase = '') {
	const m = mnemonic.normalize('NFKD');
	const salt = ('mnemonic' + passphrase).normalize('NFKD');
	return pbkdf2Sync(Buffer.from(m, 'utf8'), Buffer.from(salt, 'utf8'), 2048, 64, 'sha512');
}

/**
 * Parse a BIP-32 path string ("m/44'/501'/0'/0'") into an array of hardened
 * indices. ed25519 (SLIP-0010) supports hardened derivation only, so every
 * segment must be hardened (trailing `'` or `h`); a non-hardened segment throws.
 * @param {string} path
 * @returns {number[]} indices in [0, 2^31)
 */
export function parseDerivationPath(path) {
	const segments = path.split('/');
	if (segments[0] !== 'm') throw err(`invalid derivation path '${path}' — must start with 'm'`);
	return segments.slice(1).map((seg) => {
		const hardened = seg.endsWith("'") || seg.endsWith('h');
		if (!hardened) {
			throw err(`invalid derivation path '${path}' — ed25519 requires every segment hardened (e.g. 0')`);
		}
		const n = Number(seg.slice(0, -1));
		if (!Number.isInteger(n) || n < 0 || n >= 0x80000000) {
			throw err(`invalid derivation path segment '${seg}'`);
		}
		return n;
	});
}

/**
 * SLIP-0010 ed25519 key derivation. Returns the 32-byte private key (IL) at the
 * given hardened path. Master: HMAC-SHA512("ed25519 seed", seed). Child:
 * HMAC-SHA512(chainCode, 0x00 || key || ser32(index | 2^31)).
 * @param {Buffer} seed 64-byte BIP-39 seed
 * @param {number[]} indices hardened indices (without the hardening bit)
 * @returns {Buffer} 32-byte ed25519 private key
 */
export function deriveEd25519PrivateKey(seed, indices) {
	let I = createHmac('sha512', Buffer.from('ed25519 seed', 'utf8')).update(seed).digest();
	let key = I.subarray(0, 32);
	let chainCode = I.subarray(32);
	for (const index of indices) {
		const hardened = (index | 0x80000000) >>> 0;
		const data = Buffer.concat([
			Buffer.from([0]),
			key,
			Buffer.from([(hardened >>> 24) & 0xff, (hardened >>> 16) & 0xff, (hardened >>> 8) & 0xff, hardened & 0xff]),
		]);
		I = createHmac('sha512', chainCode).update(data).digest();
		key = I.subarray(0, 32);
		chainCode = I.subarray(32);
	}
	return Buffer.from(key);
}

/**
 * Full pipeline: mnemonic → Solana Keypair at the given BIP-44 path. The
 * returned Keypair's `secretKey` is the standard 64-byte Ed25519 form that
 * Phantom / Solflare / `solana-keygen` import directly.
 * @param {string} mnemonic
 * @param {object} [opts]
 * @param {number} [opts.account=0]   account index (the 3rd path level)
 * @param {number} [opts.change=0]    change index (the 4th path level)
 * @param {string} [opts.passphrase=''] BIP-39 passphrase
 * @returns {{ keypair: Keypair, derivationPath: string }}
 */
export function deriveSolanaKeypair(mnemonic, opts = {}) {
	const account = opts.account ?? 0;
	const change = opts.change ?? 0;
	const derivationPath = `m/${SOLANA_PURPOSE}'/${SOLANA_COIN_TYPE}'/${account}'/${change}'`;
	const seed = mnemonicToSeed(mnemonic, opts.passphrase || '');
	const priv = deriveEd25519PrivateKey(seed, parseDerivationPath(derivationPath));
	return { keypair: Keypair.fromSeed(priv), derivationPath };
}
