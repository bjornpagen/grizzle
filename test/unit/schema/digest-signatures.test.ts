/**
 * A SHA-256 digest in a declared function's signature (schema/function-own.ts signatureType): an argument, a result,
 * and a field of a heading the function takes or returns rows or a row of, as edullm's grading machine carries one.
 *
 * - **Property:** a case declares one to four functions, each holding a digest at a place of its own (an argument, a
 *   result, rows of a heading of a digest and a text, a row of that heading taken and returned). The schema owns and
 *   installs: each digest of a signature and of a row type's attribute is bytea, the digest's base type, as a closed id
 *   stands in a signature at its code's smallint, since PostgreSQL holds a function's arguments and result to their
 *   declared types exactly; and where the digest result is read, a served read of its value casts it to the
 *   installation's digest domain `__sha256`, whose CHECK holds its 32 octets, as a closed id's value is cast to its
 *   roster's domain.
 * - **Oracle:** the representation stated: a digest's base type is bytea, its stored type the digest domain.
 * - **Features:** each place.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import {
	type DigestCase,
	isBytea,
	madeOf,
	type Place,
	places,
	rowTypesOf,
	signaturesOf,
	space
} from "#test/unit/schema/digest-signatures.fixtures.ts"

/**
 * A declared function takes and returns a digest, alone or in rows or a row, its signature at bytea, and a read of its
 * digest value casts it to the digest domain.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aDeclaredFunctionTakesAndReturnsADigestAloneOrInRowsAndAReadCastsItsValueToTheDigestDomain =
	property.explore(space, {
		needs: {},
		situations: places satisfies ReadonlyArray<Reached<Place>>,
		check: (_, c: Case<Place>) => (d: DigestCase) =>
			Effect.gen(function* () {
				for (const p of d) {
					c.note(p)
				}
				const made = yield* madeOf(d)
				if (made.kind === "refused") {
					return assert.fail(`a schema of digest signatures is refused: ${made.why}`)
				}
				for (const sig of signaturesOf(made.statements)) {
					for (const [name, type] of sig.params) {
						if (name === "seed") {
							assert.ok(
								isBytea(type),
								`${sig.name}'s digest parameter is ${Formatter.format(type)}`
							)
						}
					}
					if (sig.name === "keyedDigest") {
						assert.ok(
							!("setOf" in sig.returns) && isBytea(sig.returns),
							`keyedDigest returns bytea, not ${Formatter.format(sig.returns)}`
						)
					}
				}
				const headings = rowTypesOf(made.statements)
				assert.equal(
					headings.length > 0,
					Arr.some(d, (p) => Str.startsWith("rows")(p) || Str.startsWith("a row")(p)),
					"a row type is installed exactly where a heading is taken or returned"
				)
				for (const attributes of headings) {
					const digest = Arr.findFirst(attributes, ([name]) => name === "digest")
					assert.ok(
						digest._tag === "Some" && isBytea(digest.value[1]),
						`a row type's digest attribute is bytea: ${Formatter.format(attributes)}`
					)
				}
				if (Arr.contains(d, "a digest result")) {
					if (made.served === undefined) {
						return assert.fail("a read of the digest result is served")
					}
					assert.ok(
						Str.includes("__sha256")(made.served),
						"a read of the digest result casts its value to the digest domain"
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "a digest's base type is bytea in a signature and a row type, its stored type the digest domain where its value is read"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/schema/function-own.ts",
				original:
					'\t\tcase "closedId":\n\t\tcase "sha256":\n\t\tcase "variant":\n\t\t\treturn true',
				replacement: '\t\tcase "closedId":\n\t\tcase "variant":\n\t\t\treturn true',
				why: "A digest is no signature's type again: every schema declaring a function over one is refused at the signature, the grading machine's sText among them."
			},
			{
				file: "packages/engine/src/ir/physical.ts",
				original: '\t\tcase "sha256":\n\t\t\treturn qualifiedType(names.digestDomain)',
				replacement: '\t\tcase "sha256":\n\t\t\treturn types.bytea',
				why: "A read of a function's digest value casts it to bytea, never the digest domain, so no CHECK holds the 32 octets a function returned."
			}
		]
	})
