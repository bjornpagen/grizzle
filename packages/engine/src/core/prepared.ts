/**
 * A served statement's text and the name PostgreSQL prepares it under: every statement a served login's programs send,
 * its prologue's two among them, and every statement of a write, a family's read among them, is a named prepared
 * statement, parsed and planned once per session and bound on every use after, while every other statement grizzle
 * sends is the unnamed one, a text of its own each time (adapter/wire/batch.ts BatchStatement). A text is named where
 * generate serves it (write/program/served.ts, served/read.ts, the prologue's and a refresh's), so the served file
 * carries each name beside its text and a load reads both as they are, hashing nothing; a family's read, which only a
 * write no served file holds sends, is named where its write compiles (write/family/statements.ts ReadSql, ChainSql).
 *
 * The name is the text's: `grizzle_` and the whole of its SHA-256 in lowercase RFC 4648 base32, so a session holds one
 * name for one text and two texts share a name only where SHA-256 collides, the digest a Db's prologue already guards
 * the database by. It is ASCII and shorter than PostgreSQL's NAMEDATALEN, which a prepared statement's name is keyed
 * by, whole.
 */
import { nominal } from "#compiler/core/brand.ts"
import { sha256Base32, sha256Base32Chars } from "#compiler/core/sha256.ts"

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

/** The bytes of every statement's name: its prefix and its digest's base32 characters, all ASCII. */
export const statementNameBytes = namePrefix.length + sha256Base32Chars

/** `sql` and the name it is prepared under: `grizzle_` and its SHA-256 in base32 (core/sha256.ts sha256Base32). */
export const prepared = <Text extends string>(sql: Text): Prepared<Text> =>
	Object.freeze({ name: statementName(`${namePrefix}${sha256Base32(sql)}`), sql })
