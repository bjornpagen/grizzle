/**
 * Crypto.sha256 over a text on PostgreSQL 19, against SHA-256 itself: the digest of the text's UTF-8, its 32 bytes, a
 * sha256 value, `<textDigest>(x)`, the installation's library function (physical/ddl/library.ts textDigest,
 * `sha256(convert_to(x, 'UTF8'))`), in a STORED generated column under the digest domain, a row check and a key of an
 * installed schema (text-digest.fixtures.ts), and the host evaluator's value of the generated field.
 *
 * Oracle: SHA-256 (FIPS 180-4) of the text's UTF-8 (RFC 3629) by Web Crypto, a specification. Each case inserts a few
 * distinct texts drawn of ASCII, multibyte and astral characters, quotes and backslashes, the empty text, texts past a
 * SHA-256 block and texts past a B-tree entry: every insert is accepted, the row check holding and the digest's key
 * indexing each body's digest, a body no index entry could hold among them; each row's stored digest is the oracle's,
 * of the oracle's length, and the host's bytes are the oracle's.
 *
 * Features: the empty text, a multibyte character, a character past the BMP, a quote or a backslash, a text past a
 * SHA-256 block, and a text past a B-tree entry.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type DigestFeature,
	digestTemplate,
	runDigests,
	writtenGen
} from "#test/pg/compute/text-digest.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A text's digest, as PostgreSQL stores it in a generated column a key holds and as the host evaluates it, is SHA-256
 * of the text's UTF-8, its 32 bytes, for a text of any length.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aTextsDigestIsTheSHA256BytesOfItsUTF8OnPostgreSQLAndOnTheHostAndAKeyHoldsIt =
	property.explore(writtenGen, {
		needs: { substrate: Substrate.rolledBack(digestTemplate) },
		situations: [
			"the empty text",
			"a multibyte character",
			"a character past the BMP",
			"a quote or a backslash",
			"a text past a SHA-256 block",
			"a text past a B-tree entry"
		] satisfies ReadonlyArray<DigestFeature>,
		check:
			({ substrate }, c) =>
			(written) =>
				Effect.gen(function* () {
					const { connection, value } = yield* substrate
					yield* runDigests(value, connection, written, c)
				}),
		oracle: {
			kind: "specification",
			name: "SHA-256 of the text's UTF-8, by Web Crypto: PostgreSQL's stored digest, its length, and the host's bytes, of every text"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/library.ts",
				original:
					'\tbody: call("sha256", [call("convert_to", [param(1, types.text), text("UTF8")])])',
				replacement:
					'\tbody: call("sha256", [call("convert_to", [param(1, types.text), text("LATIN1")])])',
				why: "The library function digests the text's Latin-1 bytes, so a text of a character past Latin-1 is refused and one of é is digested as one byte where UTF-8 writes two: PostgreSQL's digest is no longer SHA-256 of its UTF-8."
			},
			{
				file: "packages/engine/src/physical/ddl/library.ts",
				original:
					'\treturns: types.bytea,\n\tbody: call("sha256", [call("convert_to", [param(1, types.text), text("UTF8")])])',
				replacement:
					'\treturns: types.text,\n\tbody: call("encode", [call("sha256", [call("convert_to", [param(1, types.text), text("UTF8")])]), text("hex")])',
				why: "The hex rendering restored: the library function writes the digest as 64 hex digits, which the digest domain, bytea of 32 bytes, no longer takes as the digest, so the generated column's install or every insert is refused, and no stored digest is the oracle's bytes."
			},
			{
				file: "packages/engine/src/scalar/compute/evaluate.ts",
				original:
					'\t\t\t\t: (args) => Result.ok(sha256Digest(wellFormed(hostOf("text", a(args)))))',
				replacement:
					'\t\t\t\t: (args) => Result.ok(sha256Digest(wellFormed(hostOf("text", a(args)).toLowerCase())))',
				why: "The host digests the text folded to lower case, so its digest of a text holding a capital is not PostgreSQL's."
			},
			{
				file: "packages/engine/src/scalar/compute/evaluate.ts",
				original:
					'\t\t\t\t: (args) => Result.ok(sha256Digest(wellFormed(hostOf("text", a(args)))))',
				replacement:
					'\t\t\t\t: (args) => Result.ok(new TextEncoder().encode(sha256Digest(wellFormed(hostOf("text", a(args)))).toHex()))',
				why: "The host's digest is its hex spelling's 64 bytes, the old hex rendering, where PostgreSQL's is the digest's 32."
			}
		]
	})
