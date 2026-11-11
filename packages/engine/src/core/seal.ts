/**
 * AES-256-GCM (NIST SP 800-38D) over node:crypto's native cipher: a sealed text is its nonce, its ciphertext and its
 * tag, and only the holder of its key reads it or makes one that opens. The caller draws each nonce, so the module is
 * a pure function of its inputs; a nonce is never drawn twice under one key.
 */
import { createCipheriv, createDecipheriv } from "node:crypto"
import { catchSignal } from "#compiler/core/canonical.ts"

/**
 * The bytes of a nonce: 96 bits, the IV length GCM is defined for directly (SP 800-38D section 8.2).
 *
 * @formatConstant AES-256-GCM's nonce: 12 bytes
 */
export const sealNonceBytes = 12

/**
 * The bytes of a tag: GCM's full 128-bit tag (SP 800-38D section 5.2.1.2).
 *
 * @formatConstant AES-256-GCM's tag: 16 bytes
 */
export const sealTagBytes = 16

/**
 * The bytes of a key: AES-256's.
 *
 * @formatConstant AES-256's key: 32 bytes
 */
export const sealKeyBytes = 32

const algorithm = "aes-256-gcm"

const joined = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
	let at = 0
	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}
	return out
}

/** `plaintext` sealed under `key` and `nonce`: the nonce, the ciphertext, as long as the plaintext, and the tag. */
export const seal = (key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Uint8Array => {
	const cipher = createCipheriv(algorithm, key, nonce)
	const body = joined([cipher.update(plaintext), cipher.final()])
	return joined([nonce, body, cipher.getAuthTag()])
}

/**
 * The plaintext `sealed` holds under `key`, or undefined where it is shorter than a nonce and a tag or its tag does
 * not authenticate it: a text sealed under another key, or changed after it was sealed. The cipher's final step
 * refuses an unauthenticated text by throwing, its one throw for a key and a nonce of their lengths, which the
 * engine's one door turns into the undefined.
 */
export const open = (key: Uint8Array, sealed: Uint8Array): Uint8Array | undefined => {
	if (sealed.length < sealNonceBytes + sealTagBytes) {
		return undefined
	}
	const decipher = createDecipheriv(algorithm, key, sealed.subarray(0, sealNonceBytes))
	decipher.setAuthTag(sealed.subarray(sealed.length - sealTagBytes))
	const body = decipher.update(sealed.subarray(sealNonceBytes, sealed.length - sealTagBytes))
	const last = catchSignal(Error, () => decipher.final())
	return last.ok ? joined([body, last.value]) : undefined
}
