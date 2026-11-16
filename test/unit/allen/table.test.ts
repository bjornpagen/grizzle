/**
 * The Allen table: every mask's formula over the eleven range-operator atoms (allen/table.generated.ts), and the
 * verification universes it is checked against (test/support/oracle/allen.ts):
 *
 * - Committed: the committed table is the offline minimization's (scripts/gen/allen/generate.ts), regenerated, entry
 *   for entry. Oracle: the specification, the generator.
 * - Entries: every mask's formula denotes it exactly, in canonical form (each disjunct's literals ascending and naming
 *   each atom once, the disjuncts ascending and distinct), no disjunct droppable, each with an unnegated indexable
 *   atom. Oracle: the specification, the formula's meaning over the atoms' relation sets.
 * - Exact cost: every nonempty mask's formula has the minimal atom count, against an exhaustive search over every
 *   assignment of the atoms to a disjunct. Oracle: a second implementation.
 * - Universe: every spelling of each universe stores one of its spans, reaching every window span, both type limits,
 *   the whole range and every spelling; every pair classifies into exactly one relation. Oracle: the specification,
 *   PostgreSQL's range canonicalization restated and the relations' endpoint conditions.
 * - Converse: the swapped pair is the converse relation. Oracle: the specification.
 * - Atom sets: each atom's relation set is PostgreSQL's operator, its truth on every pair evaluated by the operators
 *   transcribed from rangetypes.c. Oracle: a second implementation.
 * - Formulas over the universe: every mask's formula holds of exactly the pairs whose relation it holds. Oracle: the
 *   specification, the pair's relation.
 *
 * Every box is exhausted: every mask, every ordered pair, every spelling. Features, required in each space, name the
 * situations each check could silently stop reaching.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { element, finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { allenAtoms, conjunctionHolds, literalNegated } from "#compiler/allen/atoms.ts"
import { allenFormula } from "#compiler/allen/lower.ts"
import { AllenMask, allenMaskOf, converseMask, fullAllenMask } from "#compiler/allen/mask.ts"
import { allenTable } from "#compiler/allen/table.generated.ts"
import { type AllenRelation, allenRelations } from "#compiler/core/allen.ts"
import { assert } from "#test/support/assert.ts"
import {
	canonicalize,
	everyDisjunctIndexable,
	formulaAtomCount,
	formulaHolds,
	rangeLimits,
	type RangeType,
	rangeTypes,
	relationsHolding,
	spanText,
	universe,
	verifyFormulas
} from "#test/support/oracle/allen.ts"
import {
	at,
	type AtomFeature,
	codeOrder,
	type CostFeature,
	type EntryFeature,
	exact,
	generated,
	items,
	pairs,
	situations,
	typedPairs,
	type UniverseFeature
} from "#test/unit/allen/table.fixtures.ts"

/** The committed Allen table is the offline minimization's table, entry for entry, when regenerated. */
export const theCommittedAllenTableIsTheOfflineMinimizationsTableEntryForEntryWhenRegenerated =
	property.exhaust(finite(int(0, fullAllenMask)), {
		needs: {},
		situations: ["the empty mask", "a mask", "the full mask"] satisfies ReadonlyArray<
			Reached<"the empty mask" | "a mask" | "the full mask">
		>,
		check: (_, c: Case<"the empty mask" | "a mask" | "the full mask">) => (mask) =>
			Effect.sync(() => {
				c.note(mask === 0 ? "the empty mask" : mask === fullAllenMask ? "the full mask" : "a mask")
				assert.deepEqual(at(allenTable, mask), at(generated, mask))
			}),
		oracle: {
			kind: "specification",
			name: "the offline minimization the table is written from (scripts/gen/allen/generate.ts), regenerated"
		},
		box: "every mask over the thirteen basic relations, the empty and the full one included",
		kept: [],
		kills: []
	})

/** The generated Allen table gives every mask a formula that denotes it exactly, in canonical form, each disjunct with an indexable atom. */
export const theGeneratedAllenTableGivesEveryMaskAFormulaThatDenotesItExactlyInCanonicalFormEachDisjunctWithAnIndexableAtom =
	property.exhaust(finite(int(0, fullAllenMask)), {
		needs: {},
		situations: [
			"the empty mask",
			"one disjunct",
			"several disjuncts",
			"a negated literal",
			"the full mask"
		] satisfies ReadonlyArray<Reached<EntryFeature>>,
		check: (_, c: Case<EntryFeature>) => (mask) =>
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
				assert.ok(everyDisjunctIndexable(formula), "every disjunct has an unnegated indexable atom")
				for (const conjunction of formula) {
					const atoms = Arr.map(conjunction, (literal) => literal >> 1)
					assert.equal(new Set(atoms).size, atoms.length, "a disjunct names each atom once")
					assert.ok(
						Arr.every(conjunction, (literal, i) => i === 0 || at(conjunction, i - 1) < literal),
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
			}),
		oracle: {
			kind: "specification",
			name: "the formula's meaning over the atoms' relation sets, and the table's canonical form"
		},
		box: "every mask over the thirteen basic relations",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/allen/table.generated.ts",
				original: "\t[[6, 15]],",
				replacement: "\t[[6, 15, 1]],",
				why: "Mask 1's formula carries a redundant literal after its others: not canonical, one atom more; the entries and the exact cost properties fail."
			}
		]
	})

/** The generated Allen table has the exact minimal atom count for every nonempty mask. */
export const theGeneratedAllenTableHasTheExactMinimalAtomCountForEveryNonemptyMask =
	property.exhaust(finite(int(1, fullAllenMask)), {
		needs: {},
		situations: ["cost at most three", "cost four", "cost above four"] satisfies ReadonlyArray<
			Reached<CostFeature>
		>,
		check: (_, c: Case<CostFeature>) => (mask) =>
			Effect.sync(() => {
				const cost = at(exact, mask)
				c.note(cost <= 3 ? "cost at most three" : cost === 4 ? "cost four" : "cost above four")
				assert.equal(formulaAtomCount(allenFormula(AllenMask(mask))), cost)
			}),
		oracle: {
			kind: "second-implementation",
			name: "an exhaustive search over every assignment of the eleven atoms to a disjunct"
		},
		box: "every nonempty mask over the thirteen basic relations",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/allen/table.generated.ts",
				original: "\t[[6, 15]],",
				replacement: "\t[[6, 15, 1]],",
				why: "Mask 1's formula carries a redundant literal after its others: not canonical, one atom more; the entries and the exact cost properties fail."
			}
		]
	})

/** The verification universe stores every spelling as one of its spans and classifies every pair into exactly one relation, reaching every window span, both type limits, the full range, every spelling and every relation. */
export const theVerificationUniverseStoresEverySpellingAsOneOfItsSpansAndClassifiesEveryPairIntoExactlyOneRelationReachingEveryWindowSpanBothTypeLimitsTheFullRangeEverySpellingAndEveryRelation =
	property.exhaust(finite(items), {
		needs: {},
		situations: situations satisfies ReadonlyArray<Reached<UniverseFeature>>,
		check: (_, c: Case<UniverseFeature>) => (item) =>
			Effect.gen(function* () {
				const texts = new Map(
					Arr.map(rangeTypes, (type) => [type, new Set(Arr.map(universe(type), spanText))] as const)
				)
				return yield* Effect.sync(() => {
					if (item.kind === "pair") {
						assert.deepEqual(relationsHolding(item.pair.a, item.pair.b), [item.pair.relation])
						c.note(`${item.type} ${item.pair.relation}`)
						return
					}
					const { type, spelling } = item
					c.note(`${type} spelled ${spelling.lowerInc ? "[" : "("}${spelling.upperInc ? "]" : ")"}`)
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
			}),
		oracle: {
			kind: "specification",
			name: "PostgreSQL's range canonicalization restated, and the relations' endpoint conditions"
		},
		box: "every spelling and every ordered pair of both verification universes",
		kept: [],
		kills: []
	})

/** The verification universe maps the converse relation to the swapped pair. */
export const theVerificationUniverseMapsTheConverseRelationToTheSwappedPair = property.exhaust(
	finite(typedPairs),
	{
		needs: {},
		situations: Arr.flatMap(rangeTypes, (type) =>
			Arr.map(allenRelations, (r): `${RangeType} ${AllenRelation}` => `${type} ${r}`)
		) satisfies ReadonlyArray<Reached<`${RangeType} ${AllenRelation}`>>,
		check:
			(_, c: Case<`${RangeType} ${AllenRelation}`>) =>
			({ type, pair }) =>
				Effect.sync(() => {
					c.note(`${type} ${pair.relation}`)
					assert.deepEqual(
						Arr.map(relationsHolding(pair.b, pair.a), (r) => allenMaskOf([r])),
						[converseMask(allenMaskOf([pair.relation]))]
					)
				}),
		oracle: { kind: "specification", name: "the converse of the pair's relation" },
		box: "every ordered pair of both verification universes",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/allen/mask.ts",
				original: '\tstarts: "startedBy",',
				replacement: '\tstarts: "finishedBy",',
				why: "starts' converse read as finishedBy (allen/mask.ts allenConverseRelation); the converse property fails."
			}
		]
	}
)

/** The exhaustive check against the brute-force classifier transcribes each atom's relation set as PostgreSQL's operator evaluates it. */
export const theExhaustiveCheckAgainstTheBruteForceClassifierTranscribesEachAtomsRelationSetAsPostgreSQLsOperatorEvaluatesIt =
	property.exhaust(finite(typedPairs), {
		needs: {},
		situations: Arr.flatMap(allenAtoms, (atom): Arr.NonEmptyReadonlyArray<AtomFeature> => [
			`${atom.text} held`,
			`${atom.text} failed`
		]) satisfies ReadonlyArray<Reached<AtomFeature>>,
		check:
			(_, c: Case<AtomFeature>) =>
			({ pair }) =>
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
				}),
		oracle: {
			kind: "second-implementation",
			name: "PostgreSQL's range operators transcribed from rangetypes.c, evaluated on every pair"
		},
		box: "every ordered pair of both verification universes",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/allen/atoms.ts",
				original: '\taFirst("=", operatorHolds["="]),',
				replacement: '\taFirst("=", operatorHolds["@>"]),',
				why: "= given @>'s relations (allen/atoms.ts); the atom sets property fails."
			}
		]
	})

/** The exhaustive check against the brute-force classifier gives every mask's formula the pairs whose relation it holds, over every ordered pair of both universes. */
export const theExhaustiveCheckAgainstTheBruteForceClassifierGivesEveryMasksFormulaThePairsWhoseRelationItHoldsOverEveryOrderedPairOfBothUniverses =
	property.exhaust(
		finite(
			(source) => [source.draw(element(rangeTypes)), source.draw(int(0, fullAllenMask))] as const
		),
		{
			needs: {},
			situations: Arr.flatMap(rangeTypes, (type) => [
				`${type} the empty mask` as const,
				`${type} the full mask` as const,
				`${type} a mask` as const
			]) satisfies ReadonlyArray<
				Reached<`${RangeType} ${"the empty mask" | "the full mask" | "a mask"}`>
			>,
			check:
				(_, c: Case<`${RangeType} ${"the empty mask" | "the full mask" | "a mask"}`>) =>
				([type, mask]) =>
					Effect.sync(() => {
						c.note(
							`${type} ${mask === 0 ? "the empty mask" : mask === fullAllenMask ? "the full mask" : "a mask"}`
						)
						const result = verifyFormulas((m) => allenFormula(AllenMask(m)), [mask], pairs(type))
						assert.deepEqual(result.mismatches, [])
					}),
			oracle: { kind: "specification", name: "the relation of each pair of the universe" },
			box: "every mask of each range type, over every ordered pair of its universe",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/allen/table.generated.ts",
					original: "\t[[6]],",
					replacement: "\t[[6, 15]],",
					why: "Mask 3 read as mask 1 in the table; the formulas over the universe property fails."
				}
			]
		}
	)
