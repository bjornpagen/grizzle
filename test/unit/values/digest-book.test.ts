/**
 * The digest book of one write (scalar/values/bytes.ts DigestBook) against SHA-256 collisions, which no search can
 * find: values are forged with digests the case chooses, so two values of different bytes share one digest as often as
 * the case asks. The book holds a value exactly when no value of its digest came before it or the one that did holds
 * the same bytes, so within one write a digest is one value, and a collision is refused before any fact is taken as
 * another.
 *
 * Oracle: a model of the book, a map from each digest to the first bytes admitted under it.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { AdmittedBytes, DigestBook, sameBytes } from "#compiler/scalar/values/bytes.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/** An admitted value whose digest the case chooses, so two values of different bytes may share one. */
class Forged extends AdmittedBytes {
	override readonly digest: string
	constructor(bytes: Uint8Array<ArrayBuffer>, digest: string) {
		super(bytes)
		this.digest = digest
	}
}

/** One admission: its bytes, from a two-letter alphabet, the digest forged for it, and whether it reuses an array. */
interface Admission {
	readonly bytes: ReadonlyArray<number>
	readonly digest: "a" | "b" | "c"
	readonly reuse: boolean
}

const admission: Gen<Admission> = (s) => ({
	bytes: s.draw(array(int(0, 1), { min: 0, max: 3 })),
	digest: s.draw(element(["a", "b", "c"] as const)),
	reuse: s.draw(element([false, true] as const))
})

type Feature =
	| "a first value of its digest"
	| "the same bytes again"
	| "the same array again"
	| "different bytes of one digest"

describe("a write's digest book", () => {
	it.effect("holds a value exactly when its digest names no other bytes before it", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/values/digest-book",
					oracle: {
						kind: "second-implementation",
						name: "a map from each digest to its first bytes"
					},
					draw: drawn(array(admission, { min: 1, max: 12 })),
					literal: Formatter.format,
					coverage: required<Feature>(
						[
							"a first value of its digest",
							"the same bytes again",
							"the same array again",
							"different bytes of one digest"
						],
						{ cases: 24, sense: notesOnly }
					),
					kept: [],
					runs: 200,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(admissions, c) =>
					Effect.sync(() => {
						const book = new DigestBook()
						const model = new Map<string, Uint8Array<ArrayBuffer>>()
						const arrays: Array<Uint8Array<ArrayBuffer>> = []
						for (const a of admissions) {
							const fresh = Uint8Array.from(a.bytes)
							const reused = a.reuse
								? Option.getOrUndefined(Arr.findFirst(arrays, (x) => sameBytes(x, fresh)))
								: undefined
							const bytes = reused ?? fresh
							arrays.push(bytes)
							const first = model.get(a.digest)
							if (first === undefined) {
								c.note("a first value of its digest")
								model.set(a.digest, bytes)
							} else if (first === bytes) {
								c.note("the same array again")
							} else {
								c.note(
									sameBytes(first, bytes) ? "the same bytes again" : "different bytes of one digest"
								)
							}
							assert.equal(
								book.holds(new Forged(bytes, a.digest)),
								first === undefined || sameBytes(first, bytes),
								`the book holds ${Formatter.format(a)} as the model does`
							)
						}
					})
			)
		)
	)
})
