import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, int, map, oneOf } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	ALLEN,
	AllenMask,
	allenConverseRelation,
	allenMaskOf,
	checkedMask,
	complementMask,
	converseMask,
	fullAllenMask,
	parseAllenMask
} from "#compiler/allen/mask.ts"
import { type AllenRelation, allenRelations } from "#compiler/core/allen.ts"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { query, v } from "#compiler/public/query.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { classify, type HalfOpen, spanText, windowSpans } from "#test/support/oracle/allen.ts"
import { Booking, Schedule } from "#test/unit/query/fixtures.ts"

/** The relations a mask holds, in bit order: the relation of each set bit, by the declared order. */
const relationsOf = (mask: number): ReadonlyArray<AllenRelation> =>
	Arr.filter(allenRelations, (r) => (mask & (1 << allenRelations.indexOf(r))) !== 0)

/** The named masks beyond the thirteen basic relations, and the complement of one. */
type Named = "intersects" | "covers" | "within" | "precedes" | "disjoint"

/**
 * What each named mask means of two half-open spans A = [a0, a1) and B = [b0, b1), stated over their points: A and B
 * share a point; every point of B is A's; every point of A is B's; every point of A is before every point of B; and no
 * point is both's, the complement of intersects.
 */
const meanings: { readonly [N in Named]: (a: HalfOpen, b: HalfOpen) => boolean } = {
	intersects: (a, b) => a.lo < b.hi && b.lo < a.hi,
	covers: (a, b) => a.lo <= b.lo && b.hi <= a.hi,
	within: (a, b) => b.lo <= a.lo && a.hi <= b.hi,
	precedes: (a, b) => a.hi <= b.lo,
	disjoint: (a, b) => a.hi <= b.lo || b.hi <= a.lo
}

/** Each named mask: ALLEN's own, and the complement of intersects. */
const named: { readonly [N in Named]: AllenMask } = {
	intersects: ALLEN.intersects,
	covers: ALLEN.covers,
	within: ALLEN.within,
	precedes: ALLEN.precedes,
	disjoint: ALLEN.complement(ALLEN.intersects)
}

const namedMasks: Arr.NonEmptyReadonlyArray<Named> = [
	"intersects",
	"covers",
	"within",
	"precedes",
	"disjoint"
]

type NamedFeature = `${Named} ${"held" | "failed"}`

describe("the named Allen masks", () => {
	it.effect("hold of two spans exactly when what each names holds of their points", (ctx) => {
		const spans = nonEmpty(windowSpans(), "the window's spans")
		return searched(
			ctx,
			exhaust(
				{
					suite: "unit/allen/named-masks",
					generator: (source) =>
						[source.draw(element(spans)), source.draw(element(spans))] as const,
					literal: Formatter.format,
					/** The window's 66 spans, paired: 4,356 pairs; the limit guards only against their growth. */
					limit: 5_000,
					box: "every ordered pair of spans [a, b) with -3 <= a < b <= 8",
					oracle: {
						kind: "specification",
						name: "each named mask's meaning over the spans' points, against the pair's one basic relation by its endpoint conditions"
					},
					coverage: requiredInSpace<NamedFeature>(
						Arr.flatMap(namedMasks, (n): Arr.NonEmptyReadonlyArray<NamedFeature> => [
							`${n} held`,
							`${n} failed`
						])
					),
					caseHang
				},
				([a, b], c) =>
					Effect.sync(() => {
						const relation = classify(a, b)
						for (const n of namedMasks) {
							const holds = meanings[n](a, b)
							assert.equal(
								Arr.contains(relationsOf(named[n]), relation),
								holds,
								`${n} of ${spanText(a)} and ${spanText(b)}, which are ${relation}`
							)
							c.note(`${n} ${holds ? "held" : "failed"}`)
						}
					})
			)
		)
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
						caseHang
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
