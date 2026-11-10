/**
 * A served statement's text and the name PostgreSQL prepares it under: every statement a served login's programs send,
 * its prologue's two among them, is a named prepared statement, parsed and planned once per session and bound on every
 * use after, while every other statement grizzle sends is the unnamed one, a text of its own each time
 * (adapter/wire/batch.ts BatchStatement). A text is named where generate serves it (write/program/served.ts,
 * served/read.ts, the prologue's and a refresh's), so the served file carries each name beside its text and a load reads
 * both as they are, hashing nothing.
 *
 * The name is the text's: `grizzle_` and the whole of its SHA-256 in lowercase RFC 4648 base32, so a session holds one
 * name for one text and two texts share a name only where SHA-256 collides, the digest a Db's prologue already guards
 * the database by. It is ASCII and shorter than PostgreSQL's NAMEDATALEN, which a prepared statement's name is keyed
 * by, whole.
 */
import { nominal } from "#compiler/core/brand.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"

declare const statementNameBrand: unique symbol

/** The name a served statement is prepared under on every session (prepared). */
export type StatementName = string & { readonly [statementNameBrand]: true }

/** A served statement's text, of the type `Text`, and its name (see the header). */
export interface Prepared<Text extends string> {
	readonly name: StatementName
	readonly sql: Text
}

const statementName = nominal<string, StatementName>()

const namePrefix = "grizzle_"

const base32 = "abcdefghijklmnopqrstuvwxyz234567"

/**
 * The bits of a SHA-256 digest.
 *
 * @formatConstant SHA-256's digest: 256 bits
 */
const digestBits = 256

/**
 * The bits one base32 character holds.
 *
 * @formatConstant RFC 4648 base32: 5 bits a character
 */
const base32Bits = 5

/**
 * The bits one hex digit holds.
 *
 * @formatConstant a hex digit: 4 bits
 */
const hexBits = 4

/** The bytes of every statement's name: its prefix and its digest's base32 characters, all ASCII. */
export const statementNameBytes = namePrefix.length + Math.ceil(digestBits / base32Bits)

/** `sql` and the name it is prepared under: `grizzle_` and its SHA-256 in base32, its last character's low bits zero. */
export const prepared = <Text extends string>(sql: Text): Prepared<Text> => {
	const hex = sha256Hex(sql)
	let name = namePrefix
	let held = 0
	let bits = 0
	for (let at = 0; at < hex.length; at++) {
		held = (held << hexBits) | Number.parseInt(hex.charAt(at), 16)
		bits += hexBits
		if (bits < base32Bits) {
			continue
		}
		bits -= base32Bits
		name += base32.charAt(held >> bits)
		held &= (1 << bits) - 1
	}
	if (bits > 0) {
		name += base32.charAt(held << (base32Bits - bits))
	}
	return Object.freeze({ name: statementName(name), sql })
}
