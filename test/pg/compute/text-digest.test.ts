/**
 * Compute.sha256 over a text on PostgreSQL 19rc2, against SHA-256 itself: the digest of the text's UTF-8 as 64
 * lowercase hex digits, `encode(<textDigest>(x), 'hex')`, the installation's library function
 * (physical/ddl/library.ts textDigest, `sha256(convert_to(x, 'UTF8'))`), in a STORED generated column and a row check
 * of an installed schema (text-digest.fixtures.ts), and the host evaluator's value of the generated field.
 *
 * Oracle: SHA-256 (FIPS 180-4) of the text's UTF-8 (RFC 3629) by Web Crypto, a specification. Each case inserts a few
 * texts drawn of ASCII, multibyte and astral characters, quotes and backslashes, the empty text and texts past a
 * SHA-256 block: every insert is accepted, the row check holding, and each row's stored digest and the host's are the
 * oracle's.
 *
 * Features: the empty text, a multibyte character, a character past the BMP, a quote or a backslash, and a text past a
 * SHA-256 block.
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
 * A text's digest, as PostgreSQL stores it in a generated column and as the host evaluates it, is SHA-256 of the text's
 * UTF-8 as lowercase hex.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aTextsDigestIsSHA256OfItsUTF8AsLowercaseHexOnPostgreSQLAndOnTheHost = property.explore(
	writtenGen,
	{
		needs: { substrate: Substrate.rolledBack(digestTemplate) },
		situations: [
			"the empty text",
			"a multibyte character",
			"a character past the BMP",
			"a quote or a backslash",
			"a text past a SHA-256 block"
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
			name: "SHA-256 of the text's UTF-8 as lowercase hex, by Web Crypto: PostgreSQL's stored digest and the host's of every text"
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
				file: "packages/engine/src/lower/conservative/expr/ops.ts",
				original:
					'\t\t\t\t? call("encode", [qualifiedCall(fn.schema, fn.name, [x]), lit.text("hex", types.text)])',
				replacement:
					'\t\t\t\t? call("encode", [qualifiedCall(fn.schema, fn.name, [x]), lit.text("base64", types.text)])',
				why: "The digest is written in base64, so the stored column is no 64 hex digits: the text domain refuses every insert."
			},
			{
				file: "packages/engine/src/scalar/compute/evaluate.ts",
				original: '\t\t\t\t: (args) => Result.ok(sha256Hex(wellFormed(hostOf("text", a(args)))))',
				replacement:
					'\t\t\t\t: (args) => Result.ok(sha256Hex(new TextEncoder().encode(hostOf("text", a(args)).toLowerCase())))',
				why: "The host digests the text folded to lower case, so its digest of a text holding a capital is not PostgreSQL's."
			}
		]
	}
)
