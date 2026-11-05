import { NodeServices } from "@effect/platform-node"
import { describe, it, layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, int, map, oneOf } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, FileSystem, Formatter, Order, Path } from "effect"
import {
	allenAtomCount,
	allenAtoms,
	atomIndexable,
	conjunctionHolds,
	literalNegated
} from "#compiler/allen/atoms.ts"
import { allenFormula } from "#compiler/allen/lower.ts"
import { AllenMask, allenMaskOf, converseMask, fullAllenMask } from "#compiler/allen/mask.ts"
import { allenTable } from "#compiler/allen/table.generated.ts"
import { type AllenRelation, allenRelations } from "#compiler/core/allen.ts"
import { allenTableSource, generateAllenTable } from "#scripts/gen/allen/generate.ts"
import { assert, defined, nonEmpty } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	canonicalize,
	everyDisjunctIndexable,
	formulaAtomCount,
	formulaHolds,
	type PairFacts,
	type RangeType,
	rangeLimits,
	relationsHolding,
	type Spelling,
	spanText,
	textFormulaMismatches,
	universe,
	universePairs,
	universeSpellings,
	verifyFormulas,
	windowSpans
} from "#test/support/oracle/allen.ts"

const types = ["int4range", "int8range"] as const satisfies ReadonlyArray<RangeType>
const pairsOf = new Map(Arr.map(types, (type) => [type, universePairs(universe(type))] as const))
/** The element at an index the test knows is in range, failing the test where it is not. */
const at = <A>(values: ArrayLike<A>, index: number): A =>
	defined(values[index], `an element at ${index}`)

const pairs = (type: RangeType): ReadonlyArray<PairFacts> =>
	defined(pairsOf.get(type), `the pairs of ${type}`)

/**
 * The defining formulas: the seven basic relations, and the six converses with the operands
 * swapped.
 */
const definingFormulas: Arr.NonEmptyReadonlyArray<readonly [AllenRelation, string]> = [
	["before", "A << B AND NOT A -|- B"],
	["meets", "A << B AND A -|- B"],
	["overlaps", "A && B AND A &< B AND NOT A &> B AND NOT A @> B"],
	["starts", "A <@ B AND B &> A AND A <> B"],
	["during", "A <@ B AND NOT B &> A AND NOT B &< A"],
	["finishes", "A <@ B AND B &< A AND A <> B"],
	["equals", "A = B"],
	["after", "B << A AND NOT B -|- A"],
	["metBy", "B << A AND B -|- A"],
	["overlappedBy", "B && A AND B &< A AND NOT B &> A AND NOT B @> A"],
	["startedBy", "B <@ A AND A &> B AND B <> A"],
	["contains", "B <@ A AND NOT A &> B AND NOT A &< B"],
	["finishedBy", "B <@ A AND A &< B AND B <> A"]
]

layer(NodeServices.layer, { excludeTestServices: true })("the committed Allen table", (live) => {
	live.effect("equals table.generated.ts byte for byte when regenerated", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const committed = yield* fs.readFileString(
				path.join(import.meta.dirname, "../../../packages/engine/src/allen/table.generated.ts")
			)
			assert.equal(allenTableSource(), committed)
			assert.equal(allenTable.length, 8192)
			assert.deepEqual(allenTable, generateAllenTable())
		})
	)
})

describe("the generated Allen table", () => {
	it.effect(
		"gives every mask a formula that denotes it exactly, in canonical form, each disjunct with an indexable atom",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/allen/table-entries",
						generator: int(0, fullAllenMask),
						literal: Formatter.format,
						limit: fullAllenMask + 1,
						coverage: requiredInSpace<EntryFeature>([
							"the empty mask",
							"one disjunct",
							"several disjuncts",
							"a negated literal",
							"the full mask"
						]),
						caseHang
					},
					(mask, c) =>
						Effect.sync(() => {
							const formula = allenFormula(AllenMask(mask))
							assert.equal(formulaHolds(formula), AllenMask(mask), "the formula denotes its mask")
							if (mask === 0) {
								c.note("the empty mask")
							}
							if (mask === fullAllenMask) {
								c.note("the full mask")
							}
							if (formula.length === 1) {
								c.note("one disjunct")
							}
							if (formula.length > 1) {
								c.note("several disjuncts")
							}
							if (Arr.some(formula, (conjunction) => Arr.some(conjunction, literalNegated))) {
								c.note("a negated literal")
							}
							assert.ok(
								everyDisjunctIndexable(formula),
								"every disjunct has an unnegated indexable atom"
							)
							for (const conjunction of formula) {
								const atoms = Arr.map(conjunction, (literal) => literal >> 1)
								assert.equal(new Set(atoms).size, atoms.length, "a disjunct names each atom once")
								assert.ok(
									Arr.every(
										conjunction,
										(literal, i) => i === 0 || at(conjunction, i - 1) < literal
									),
									"a disjunct's literals ascend"
								)
							}
							assert.ok(
								Arr.every(
									formula,
									(conjunction, i) => i === 0 || codeOrder(at(formula, i - 1), conjunction) < 0
								),
								"the disjuncts ascend, each distinct"
							)
							for (const [i, conjunction] of formula.entries()) {
								const others = Arr.remove(formula, i)
								assert.notEqual(
									conjunctionHolds(conjunction) & ~formulaHolds(others),
									0,
									"no disjunct can be dropped"
								)
							}
						})
				)
			)
	)

	it.effect("has the exact minimal atom count for every nonempty mask", (ctx) => {
		const exact = exactCosts()
		return searched(
			ctx,
			exhaust(
				{
					suite: "unit/allen/table-exact-cost",
					generator: int(1, fullAllenMask),
					literal: Formatter.format,
					limit: fullAllenMask,
					coverage: requiredInSpace<CostFeature>([
						"cost at most three",
						"cost four",
						"cost above four"
					]),
					caseHang
				},
				(mask, c) =>
					Effect.sync(() => {
						const cost = at(exact, mask)
						c.note(cost <= 3 ? "cost at most three" : cost === 4 ? "cost four" : "cost above four")
						assert.equal(formulaAtomCount(allenFormula(AllenMask(mask))), cost)
					})
			)
		)
	})
})

/** What the table's cases reach. */
type EntryFeature =
	| "the empty mask"
	| "one disjunct"
	| "several disjuncts"
	| "a negated literal"
	| "the full mask"
type CostFeature = "cost at most three" | "cost four" | "cost above four"

/** Literal codes compared lexicographically, a shorter prefix first. */
const codeOrder: Order.Order<ReadonlyArray<number>> = Order.Array(Order.Number)

/** The exact minimal atom count of every mask (see the property above), by mask. */
const exactCosts = (): Int32Array => {
	const unreachable = 1 << 20
	const term = new Int32Array(fullAllenMask + 1).fill(unreachable)
	const assignments = 3 ** allenAtomCount
	for (let assignment = 0; assignment < assignments; assignment++) {
		let holds: number = fullAllenMask
		let size = 0
		let indexable = false
		let rest = assignment
		for (let atom = 0; atom < allenAtomCount; atom++) {
			const state = rest % 3
			rest = (rest - state) / 3
			if (state === 0) {
				continue
			}
			const info = at(allenAtoms, atom)
			size++
			if (state === 1) {
				holds &= info.holds
				if (atomIndexable(info)) {
					indexable = true
				}
			} else {
				holds &= fullAllenMask ^ info.holds
			}
		}
		if (indexable && holds !== 0 && size < at(term, holds)) {
			term[holds] = size
		}
	}
	const f = new Int32Array(fullAllenMask + 1).fill(unreachable)
	for (let m = 1; m <= fullAllenMask; m++) {
		let best = at(term, m)
		for (let m1 = (m - 1) & m; m1 > 0; m1 = (m1 - 1) & m) {
			const c1 = at(f, m1)
			if (c1 >= best) {
				continue
			}
			const rest = m ^ m1
			for (let t = m1; ; t = (t - 1) & m1) {
				const m2 = rest | t
				if (m2 !== m) {
					const c = c1 + at(f, m2)
					if (c < best) {
						best = c
					}
				}
				if (t === 0) {
					break
				}
			}
		}
		f[m] = best
	}
	return f
}

/** What the universe's cases reach: each relation and spelling per type, its limits, and each span it stores. */
type UniverseFeature =
	| `${RangeType} ${AllenRelation}`
	| `${RangeType} spelled ${"[]" | "[)" | "(]" | "()"}`
	| `${RangeType} its ${"least value" | "greatest value" | "whole range"}`
	| `${RangeType} span ${string}`

describe("the verification universe", () => {
	it.effect(
		"stores every spelling as one of its spans and classifies every pair into exactly one relation, reaching every window span, both type limits, the full range, every spelling and every relation",
		(ctx) => {
			/**
			 * The exhaustive checks below are only as complete as this universe: each feature is a span or a relation they
			 * would silently stop checking if the universe lost it.
			 */
			const bounds = ["[]", "[)", "(]", "()"] as const
			const situations = Arr.flatMap(types, (type): Arr.NonEmptyReadonlyArray<UniverseFeature> => [
				`${type} its least value`,
				...Arr.map(windowSpans(), (span): UniverseFeature => `${type} span ${spanText(span)}`),
				`${type} its greatest value`,
				`${type} its whole range`,
				...Arr.map(bounds, (b): UniverseFeature => `${type} spelled ${b}`),
				...Arr.map(allenRelations, (relation): UniverseFeature => `${type} ${relation}`)
			])
			type Item =
				| { readonly kind: "spelling"; readonly type: RangeType; readonly spelling: Spelling }
				| { readonly kind: "pair"; readonly type: RangeType; readonly pair: PairFacts }
			const items: Gen<Item> = oneOf([
				...Arr.map(types, (type) =>
					map(
						element(nonEmpty(universeSpellings(type), `the ${type} spellings`)),
						(spelling): Item => ({
							kind: "spelling",
							type,
							spelling
						})
					)
				),
				...Arr.map(types, (type) =>
					map(element(nonEmpty(pairs(type), `the ${type} pairs`)), (pair): Item => ({
						kind: "pair",
						type,
						pair
					}))
				)
			])
			const texts = new Map(
				Arr.map(types, (type) => [type, new Set(Arr.map(universe(type), spanText))] as const)
			)
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/allen/universe",
						generator: items,
						literal: Formatter.format,
						/**
						 * The space holds 17,028 values, each type's spellings and ordered pairs; the limit guards only against
						 * its growth.
						 */
						limit: 100_000,
						coverage: requiredInSpace<UniverseFeature>(situations),
						caseHang
					},
					(item, c) =>
						Effect.sync(() => {
							if (item.kind === "pair") {
								assert.deepEqual(relationsHolding(item.pair.a, item.pair.b), [item.pair.relation])
								c.note(`${item.type} ${item.pair.relation}`)
								return
							}
							const { type, spelling } = item
							c.note(
								`${type} spelled ${spelling.lowerInc ? "[" : "("}${spelling.upperInc ? "]" : ")"}`
							)
							const stored = canonicalize(type, spelling)
							assert.ok(stored.kind === "span", "every spelling of the universe stores a span")
							const text = spanText(stored.span)
							assert.ok(
								texts.get(type)?.has(text) === true,
								`the spelling stores ${text}, a span of the universe`
							)
							c.note(`${type} span ${text}`)
							const { min, max } = rangeLimits[type]
							if (stored.span.lo === min) {
								c.note(`${type} its least value`)
							}
							if (stored.span.hi === max) {
								c.note(`${type} its greatest value`)
							}
							if (stored.span.lo === min && stored.span.hi === max) {
								c.note(`${type} its whole range`)
							}
						})
				)
			)
		}
	)

	it.effect("maps the converse relation to the swapped pair", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/allen/universe-converse",
					generator: typedPairs,
					literal: Formatter.format,
					limit: pairLimit,
					coverage: requiredInSpace<`${RangeType} ${AllenRelation}`>(
						Arr.flatMap(types, (type) =>
							Arr.map(allenRelations, (r): `${RangeType} ${AllenRelation}` => `${type} ${r}`)
						)
					),
					caseHang
				},
				({ type, pair }, c) =>
					Effect.sync(() => {
						c.note(`${type} ${pair.relation}`)
						assert.deepEqual(
							Arr.map(relationsHolding(pair.b, pair.a), (r) => allenMaskOf([r])),
							[converseMask(allenMaskOf([pair.relation]))]
						)
					})
			)
		)
	)
})

/** Every ordered pair of both universes, with its type. */
const typedPairs: Gen<{ readonly type: RangeType; readonly pair: PairFacts }> = oneOf(
	Arr.map(types, (type) =>
		map(element(nonEmpty(pairs(type), `the ${type} pairs`)), (pair) => ({ type, pair }))
	)
)
/** The pairs of both universes number some 17,000; the limit guards only against their growth. */
const pairLimit = 100_000

/** What an atom's truth on a pair reaches: each atom true and false. */
type AtomFeature = `${string} held` | `${string} failed`

describe("the exhaustive check against the brute-force classifier", () => {
	it.effect("transcribes each atom's relation set as PostgreSQL's operator evaluates it", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/allen/atom-sets",
					generator: typedPairs,
					literal: Formatter.format,
					limit: pairLimit,
					coverage: requiredInSpace<AtomFeature>(
						Arr.flatMap(allenAtoms, (atom): Arr.NonEmptyReadonlyArray<AtomFeature> => [
							`${atom.text} held`,
							`${atom.text} failed`
						])
					),
					caseHang
				},
				({ pair }, c) =>
					Effect.sync(() => {
						for (const [i, atom] of allenAtoms.entries()) {
							const truth = (pair.atoms & (1 << i)) !== 0
							c.note(truth ? `${atom.text} held` : `${atom.text} failed`)
							assert.equal(
								(atom.holds & allenMaskOf([pair.relation])) !== 0,
								truth,
								`atom ${atom.text} on ${spanText(pair.a)} and ${spanText(pair.b)}: PostgreSQL says ${truth}`
							)
						}
					})
			)
		)
	)

	it.effect(
		"gives every mask's formula the pairs whose relation it holds, over every ordered pair of both universes",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/allen/table-universe",
						generator: (source) =>
							[source.draw(element(types)), source.draw(int(0, fullAllenMask))] as const,
						literal: Formatter.format,
						limit: types.length * (fullAllenMask + 1),
						coverage:
							requiredInSpace<`${RangeType} ${"the empty mask" | "the full mask" | "a mask"}`>(
								Arr.flatMap(types, (type) => [
									`${type} the empty mask` as const,
									`${type} the full mask` as const,
									`${type} a mask` as const
								])
							),
						caseHang
					},
					([type, mask], c) =>
						Effect.sync(() => {
							c.note(
								`${type} ${mask === 0 ? "the empty mask" : mask === fullAllenMask ? "the full mask" : "a mask"}`
							)
							const result = verifyFormulas((m) => allenFormula(AllenMask(m)), [mask], pairs(type))
							assert.deepEqual(result.mismatches, [])
						})
				)
			)
	)

	it.effect("confirms the defining formulas over every ordered pair of both universes", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/allen/defining-formulas",
					generator: (source) =>
						[source.draw(element(types)), source.draw(element(definingFormulas))] as const,
					literal: Formatter.format,
					limit: types.length * definingFormulas.length,
					coverage: requiredInSpace<AllenRelation>(allenRelations),
					caseHang
				},
				([type, [relation, text]], c) =>
					Effect.sync(() => {
						c.note(relation)
						assert.deepEqual(
							Arr.map(textFormulaMismatches(text, [relation], pairs(type)), (p) => [
								spanText(p.a),
								spanText(p.b)
							]),
							[]
						)
					})
			)
		)
	)
})
