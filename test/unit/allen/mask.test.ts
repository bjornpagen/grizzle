import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, int, map, oneOf } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter } from "effect"
import {
	ALLEN,
	AllenMask,
	type AllenRelation,
	allenBit,
	allenConverseRelation,
	allenMaskOf,
	allenRelations,
	checkedMask,
	complementMask,
	converseMask,
	fullAllenMask,
	parseAllenMask
} from "#compiler/allen/mask.ts"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { query, v } from "#compiler/public/query.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import { assert } from "#test/support/assert.ts"
import { Booking, Schedule } from "#test/unit/query/fixtures.ts"

/** The relations a mask holds, in bit order: the relation of each set bit, by the declared order. */
const relationsOf = (mask: number): ReadonlyArray<AllenRelation> =>
	Arr.filter(allenRelations, (r) => (mask & (1 << allenRelations.indexOf(r))) !== 0)

describe("the Allen bit order", () => {
	it("is the declared order, from before = bit 0 to finishedBy = bit 12", () => {
		assert.deepEqual(allenRelations, [
			"before",
			"meets",
			"overlaps",
			"starts",
			"during",
			"finishes",
			"equals",
			"after",
			"metBy",
			"overlappedBy",
			"startedBy",
			"contains",
			"finishedBy"
		])
		assert.equal(ALLEN.before, AllenMask(1))
		assert.equal(ALLEN.meets, AllenMask(2))
		assert.equal(ALLEN.overlaps, AllenMask(4))
		assert.equal(ALLEN.equals, AllenMask(1 << 6))
		assert.equal(ALLEN.after, AllenMask(1 << 7))
		assert.equal(ALLEN.finishedBy, AllenMask(1 << 12))
		assert.equal(fullAllenMask, AllenMask(8191))
		for (const [bit, relation] of allenRelations.entries()) {
			assert.equal(ALLEN[relation], AllenMask(1 << bit))
			assert.equal(allenBit(relation), AllenMask(1 << bit))
		}
	})

	it("defines the named masks as unions of basic relations", () => {
		assert.deepEqual(relationsOf(ALLEN.intersects), [
			"overlaps",
			"starts",
			"during",
			"finishes",
			"equals",
			"overlappedBy",
			"startedBy",
			"contains",
			"finishedBy"
		])
		assert.deepEqual(relationsOf(ALLEN.covers), ["equals", "startedBy", "contains", "finishedBy"])
		assert.deepEqual(relationsOf(ALLEN.within), ["starts", "during", "finishes", "equals"])
		assert.deepEqual(relationsOf(ALLEN.precedes), ["before", "meets"])
		assert.notEqual(ALLEN.overlaps, ALLEN.intersects)
		assert.deepEqual(relationsOf(ALLEN.complement(ALLEN.intersects)), [
			"before",
			"meets",
			"after",
			"metBy"
		])
	})
})

/**
 * A value a mask entry point is given: any number a caller may write, or a value of another kind a JavaScript caller
 * may pass where the admission core takes anything.
 */
type Given =
	| { readonly kind: "number"; readonly value: number }
	| { readonly kind: "other"; readonly value: unknown }

/**
 * Every integer from one below the thirteen bits to one past them, every mask among them, and the numbers and values
 * that are no integer.
 */
const given: Gen<Given> = oneOf([
	map(int(-1, fullAllenMask + 2), (value): Given => ({ kind: "number", value })),
	map(
		element([
			1.5,
			-0,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			2 ** 40,
			-(2 ** 13)
		]),
		(value): Given => ({ kind: "number", value })
	),
	map(element<unknown>(["4", 4n, null, undefined, {}, [4]]), (value): Given => ({
		kind: "other",
		value
	}))
])

/** What the entry points' cases reach: each kind of mask, and each way a value is no mask. */
type EntryFeature =
	| "a mask"
	| "the empty mask"
	| "the full mask"
	| "below the thirteen bits"
	| "past the thirteen bits"
	| "no integer"
	| "no number"

/** A mask by definition: an integer in [0, 8191], negative zero being zero. */
const isMask = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= fullAllenMask

/** Whether `f` throws a MalformedDescription; anything but a CompileError thrown fails the test. */
const refusedMalformed = (f: () => unknown): boolean => {
	const caught = catchCompileError(f)
	return !caught.ok && caught.error.reason._tag === "MalformedDescription"
}

/** r.allen between two spans of one booking's room, recorded by the builder. */
const allenTerm = (mask: number) =>
	queryValueDesc(
		query(Schedule).rule((r) => {
			const a = v(Booking, "first")
			const b = v(Booking, "second")
			return r
				.match(Booking, { room: a.room, during: a.during })
				.match(Booking, { room: a.room, during: b.during })
				.where(r.allen(a.during, mask, b.during))
				.find({ room: a.room })
		})
	)

describe("every entry point a mask reaches", () => {
	it.effect(
		"accepts exactly the masks, as complement and converse define them, and refuses every other value as malformed",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/allen/entry-points",
						generator: given,
						literal: Formatter.format,
						/** The space holds 8,208 values; the limit guards only against its growth. */
						limit: 10_000,
						coverage: requiredInSpace<EntryFeature>([
							"a mask",
							"the empty mask",
							"the full mask",
							"below the thirteen bits",
							"past the thirteen bits",
							"no integer",
							"no number"
						]),
						caseHang: Duration.minutes(2)
					},
					(g, c) =>
						Effect.sync(() => {
							/** -0 is the empty mask. */
							const mask = isMask(g.value) ? AllenMask(g.value === 0 ? 0 : g.value) : undefined
							c.note(
								g.kind === "other"
									? "no number"
									: mask === 0
										? "the empty mask"
										: mask === fullAllenMask
											? "the full mask"
											: mask !== undefined
												? "a mask"
												: !Number.isInteger(g.value)
													? "no integer"
													: g.value < 0
														? "below the thirteen bits"
														: "past the thirteen bits"
							)
							assert.equal(parseAllenMask(g.value), mask)
							if (mask === undefined) {
								assert.ok(refusedMalformed(() => checkedMask(g.value, "converse")))
							} else {
								assert.equal(checkedMask(g.value, "converse"), mask)
							}
							if (g.kind === "other") {
								return
							}
							if (mask === undefined) {
								assert.ok(
									refusedMalformed(() => ALLEN.complement(g.value)),
									"complement"
								)
								assert.ok(
									refusedMalformed(() => ALLEN.converse(g.value)),
									"converse"
								)
								assert.ok(
									refusedMalformed(() => allenTerm(g.value)),
									"r.allen"
								)
								return
							}
							assert.equal(ALLEN.complement(mask), AllenMask(fullAllenMask ^ mask))
							assert.equal(ALLEN.complement(ALLEN.complement(mask)), mask)
							assert.equal(
								ALLEN.converse(mask),
								allenMaskOf(
									Arr.map(relationsOf(mask), (relation) => allenConverseRelation[relation])
								)
							)
							assert.equal(ALLEN.converse(ALLEN.converse(mask)), mask)
							assert.equal(
								ALLEN.converse(ALLEN.complement(mask)),
								ALLEN.complement(ALLEN.converse(mask))
							)
							assert.equal(converseMask(mask), ALLEN.converse(mask))
							assert.equal(complementMask(mask), ALLEN.complement(mask))
							if (mask === 0) {
								assert.ok(
									refusedMalformed(() => allenTerm(mask)),
									"r.allen"
								)
								return
							}
							const desc = allenTerm(mask)
							const [arm] = desc?.stage.kind === "rules" ? desc.stage.arms : []
							const [term] = arm?.where ?? []
							assert.equal(
								term?.kind === "allen" && term.mask,
								mask,
								"r.allen records the mask unchanged"
							)
						})
				)
			)
	)
})
