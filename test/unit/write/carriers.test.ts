import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { array, element, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { canonicalTextOf, catchRefusal } from "#compiler/core/canonical.ts"
import { maxIdentifierBytes } from "#compiler/core/identity.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { carrierDigestHex, carrierName, isCarrierName } from "#compiler/sql/naming.ts"
import { CarrierSupply, typesDigest } from "#compiler/write/carriers/carriers.ts"
import { assert, refused, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { heading, scalarTypes } from "#test/unit/ir/fixture.ts"

/**
 * A write program's carriers (write/carriers CarrierSupply): each named by its column types' digest and its ordinal
 * among the program's carriers of those types, so no count of carriers runs out of names, and a digest two column-type
 * classes of one program share is refused rather than naming both.
 */

/**
 * The headings a case draws from: column-type classes of one column, two and none (the unit relation's), and one that
 * renames another's field, which is the same class, since only the types count.
 */
const oneColumn = heading(["id", scalarTypes.uuid])
const noColumn = heading()
const headings: Arr.NonEmptyReadonlyArray<Heading> = [
	oneColumn,
	heading(["n", scalarTypes.int8]),
	heading(["id", scalarTypes.uuid], ["kind", scalarTypes.kind]),
	noColumn,
	heading(["key", scalarTypes.uuid])
]

/** The canonical text of a heading's column types: what a carrier's digest stands for. */
const typesOf = (h: Heading): string => canonicalTextOf(Arr.map(h, (c) => c.type))

/** A digest of carrierDigestHex hex digits standing for the drawn number `n`. */
const standIn = (n: number): string => Str.padStart(carrierDigestHex.value, "0")(String(n))

type CarrierFeature = "named" | "refused" | "a renamed heading in its class"

describe("a program's carriers", () => {
	it.effect(
		"are named by the digest of their column types and their ordinal among those types, and a digest two classes share is refused",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/write/carrier-names",
						literal: Formatter.format,
						/**
						 * A stand-in digest for each heading's class, one of two, so distinct classes often share one, and the
						 * headings a program asks carriers of, in order.
						 */
						draw: drawn((source) => ({
							digests: Arr.map(headings, () => source.draw(int(0, 1))),
							picks: source.draw(array(int(0, headings.length - 1), { min: 1, max: 8 }))
						})),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						coverage: required<CarrierFeature>(
							["named", "refused", "a renamed heading in its class"],
							{ cases: 300, sense: notesOnly }
						),
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ digests, picks }, c) =>
						Effect.sync(() => {
							/** The stand-in digest of each class, by its types' text: the first heading of a class decides it. */
							const digestOf = new Map<string, string>()
							for (const [i, h] of headings.entries()) {
								if (!digestOf.has(typesOf(h))) {
									digestOf.set(typesOf(h), standIn(digests[i] ?? 0))
								}
							}
							const supply = new CarrierSupply((types) => digestOf.get(types) ?? standIn(0))
							/** The model: per digest, the types it stands for and how many carriers of them the program holds. */
							const held = new Map<string, { readonly types: string; readonly count: number }>()
							for (const pick of picks) {
								const h = headings[pick] ?? headings[0]
								const types = typesOf(h)
								const digest = digestOf.get(types) ?? standIn(0)
								const known = held.get(digest)
								const carrier = catchRefusal(() => supply.next(h))
								if (known !== undefined && known.types !== types) {
									c.note("refused")
									refused(carrier, "UnsupportedOperation")
									return
								}
								const ordinal = (known?.count ?? 0) + 1
								held.set(digest, { types, count: ordinal })
								const named = succeeded(carrier)
								assert.equal(named.name, carrierName(digest, ordinal))
								assert.deepEqual(
									Arr.map(named.heading, (col) => [col.name, col.column]),
									Arr.map(h, (col, i) => [col.name, `c${i + 1}`])
								)
								c.note(
									pick === headings.length - 1 && ordinal > 1
										? "a renamed heading in its class"
										: "named"
								)
							}
							const names = Arr.map(supply.all(), (carrier) => carrier.name)
							assert.equal(new Set(names).size, names.length)
						})
				)
			)
	)

	it.effect(
		"name 70,000 carriers of one column-type class apart, each a carrier's name within PostgreSQL's identifier",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/write/carrier-count",
						literal: Formatter.format,
						/** More carriers of one class than a 16-bit ordinal counts, of a class of one column and of none. */
						generator: (source) => source.draw(element([oneColumn, noColumn])),
						limit: 2,
						coverage: noCoverage,
						caseHang
					},
					(h) =>
						Effect.sync(() => {
							const supply = new CarrierSupply(typesDigest)
							const names = new Set(Arr.map(Arr.range(1, 70_000), () => supply.next(h).name))
							assert.equal(names.size, 70_000)
							for (const name of names) {
								assert.ok(isCarrierName(name), name)
								assert.ok(utf8Length(name) <= maxIdentifierBytes.value, name)
							}
						})
				)
			)
	)
})
