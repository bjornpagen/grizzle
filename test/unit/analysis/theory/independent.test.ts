/**
 * Families stay independent (rows-first §1, §5): a relation is a member of any number of counted families, and each
 * family the theory resolves is its own Family, with its own axes and its own law columns, named by its own identity
 * (owner and count, and fold and plane). Two counted families on one member, under one owner or two, by one group
 * field or two, with or without a fold each and a sequence of another relation beside them, resolve to disjoint
 * families; and each family's law is violated exactly when its own family is, whatever the other's state. A counted
 * family's member is no sequence's member (analysis/theory/fill.ts), so the sequence beside them orders L, not G. The
 * oracle is the statements read as the specification of the families they state, and for the laws each family's
 * theorem checked on its own.
 *
 * - Shape: every arrangement of the two counted families (one owner or two, one group field or two, a fold each or
 *   none, a sequence beside them or none), exhausted.
 * - Laws: every state of the two counted families beside a lawful sequence, counts 0 to 2, up to two members each
 *   naming each owner or none, exhausted, each family's law violated exactly when its own theorem fails.
 *
 * Features: each arrangement for the shape; each family's verdict, and the other's state beside it, for the laws.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	type HostFacts,
	theoryOf,
	uuidOf,
	violates
} from "#test/support/unit/analysis/theory/support.ts"
import {
	axisColumnsOf,
	familyAt,
	familyLawAt,
	groupsOf,
	lawColumnsOf,
	type Member,
	ownersOf,
	schemaFor,
	shape,
	type ShapeFeature,
	state,
	theories
} from "#test/unit/analysis/theory/independent.fixtures.ts"

/** Independent families (rows-first §5) two counted families on one member resolve to two families of disjoint axes and law columns. */
export const independentFamiliesRowsFirst5TwoCountedFamiliesOnOneMemberResolveToTwoFamiliesOfDisjointAxesAndLawColumns =
	property.exhaust(finite(shape), {
		needs: {},
		situations: [
			"one owner",
			"two owners",
			"one group field",
			"two group fields",
			"two folds",
			"a sequence beside them"
		] satisfies ReadonlyArray<Reached<ShapeFeature>>,
		check: (_, k: Case<ShapeFeature>) => (s) =>
			Effect.sync(() => {
				k.note(s.owners)
				k.note(s.groups)
				if (s.folds) {
					k.note("two folds")
				}
				if (s.sequence) {
					k.note("a sequence beside them")
				}
				const t = theoryOf(schemaFor(s))
				const [a, b] = ownersOf(s)
				const [g1, g2] = groupsOf(s)
				assert.equal(t.families.length, s.sequence ? 3 : 2, "one family per statement")
				const first = familyAt(t, a, "n")
				const second = familyAt(t, b, "m")
				assert.deepEqual(
					[first.group[0].member.name, second.group[0].member.name],
					[g1, g2],
					"each counted family groups G by its own field"
				)
				assert.deepEqual(
					[first.shape.kind, second.shape.kind],
					["counted", "counted"],
					"each counted family's index is its own hidden column"
				)
				const columns = Arr.flatMap(t.families, lawColumnsOf)
				assert.equal(new Set(columns).size, columns.length, "no two families share a law column")
				assert.deepEqual(
					Arr.map([first, second], (x) => x.folds.length),
					s.folds ? [1, 1] : [0, 0],
					"each fold is its own family's"
				)
				if (s.folds) {
					assert.deepEqual(
						[
							defined(first.folds[0]?.planes[0]).end.name,
							defined(second.folds[0]?.planes[0]).end.name
						],
						["t1", "t2"],
						"each fold ends on its own owner's field"
					)
				}
				const carried = Arr.map(t.families, axisColumnsOf)
				const shared = Arr.filter(defined(carried[0]), (c) =>
					Arr.some(Arr.drop(carried, 1), (cs) => Arr.contains(cs, c))
				)
				assert.deepEqual(shared, [], "no column rides two families' axes")
				if (s.sequence) {
					const sequence = familyAt(t, "S", "k")
					assert.equal(
						sequence.shape.kind,
						"ordered",
						"the sequence beside them is ordered by its own index"
					)
					assert.equal(sequence.folds.length, 0, "and folds nothing of theirs")
				}
			}),
		oracle: {
			kind: "specification",
			name: "rows-first §1 and §5: each family its own, by its identity"
		},
		box: "two counted families on G under one owner or two, by one group field or two, with a sum fold each or none, and an ordered family of L beside them or none",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/identity.ts",
				original:
					"\t\t\t\t\t[column.kind, column.family],\n\t\t\t\t\t[column.kind, ...nameSegments(column.count)],",
				replacement: "\t\t\t\t\t[column.kind],\n\t\t\t\t\t[column.kind],",
				why: "Every family's drawn columns named as one family's, by their kind alone (core/identity.ts lawColumn), so two families share a law column; the shape fails."
			}
		]
	})

/** Independent families (rows-first §5) each counted family's law is violated exactly when its own family is, whatever the other's. */
export const independentFamiliesRowsFirst5EachCountedFamilysLawIsViolatedExactlyWhenItsOwnFamilyIsWhateverTheOthers =
	property.exhaust(finite(state), {
		needs: {},
		situations: [
			"both lawful",
			"the first alone broken",
			"the second alone broken",
			"both broken"
		] satisfies ReadonlyArray<
			Reached<"both lawful" | "the first alone broken" | "the second alone broken" | "both broken">
		>,
		check:
			(
				_2,
				k: Case<
					"both lawful" | "the first alone broken" | "the second alone broken" | "both broken"
				>
			) =>
			(s) =>
				Effect.sync(() => {
					const t = defined(theories.get(s.owners))
					const [a, b] = s.owners === "one owner" ? ["O", "O"] : ["O1", "O2"]
					const lawful = (named: (m: Member) => boolean, count: number): boolean =>
						Arr.every(s.members, named) && count === s.members.length
					const firstLawful = lawful((m) => m.first, s.counts[0])
					const secondLawful = lawful((m) => m.second, s.counts[1])
					k.note(
						firstLawful && secondLawful
							? "both lawful"
							: firstLawful
								? "the second alone broken"
								: secondLawful
									? "the first alone broken"
									: "both broken"
					)
					const owner = uuidOf(1)
					const orphan = uuidOf(9)
					const owners: HostFacts =
						a === b
							? { [a]: [{ id: owner, n: BigInt(s.counts[0]), m: BigInt(s.counts[1]) }] }
							: {
									[a]: [{ id: owner, n: BigInt(s.counts[0]) }],
									[b]: [{ id: owner, m: BigInt(s.counts[1]) }]
								}
					const facts: HostFacts = {
						...owners,
						S: [{ id: uuidOf(2), k: BigInt(s.members.length) }],
						G: Arr.map(s.members, (m, i) => ({
							gid: uuidOf(100 + i),
							o1: m.first ? owner : orphan,
							o2: m.second ? owner : orphan,
							x: 0n
						})),
						L: Arr.map(s.members, (_, i) => ({
							id: uuidOf(200 + i),
							s: uuidOf(2),
							at: BigInt(i)
						}))
					}
					assert.equal(
						violates(t, familyLawAt(t, a, "n"), facts),
						!firstLawful,
						`the first family of ${Formatter.format(s)}`
					)
					assert.equal(
						violates(t, familyLawAt(t, b, "m"), facts),
						!secondLawful,
						`the second family of ${Formatter.format(s)}`
					)
					assert.equal(
						violates(t, familyLawAt(t, "S", "k"), facts),
						false,
						"the sequence beside them stays lawful"
					)
				}),
		oracle: {
			kind: "second-implementation",
			name: "each family's bijection, counted on its own"
		},
		box: "two counted families of G (under one owner or two) beside a lawful sequence, counts 0 to 2, up to two members each naming each owner or none",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/laws.ts",
				original: "\t\treturn [orphan, w(unequal), w(off)]",
				replacement: "\t\treturn [orphan, w(unequal)]",
				why: "A counted family's violation omits its count's mismatch (analysis/theory/laws.ts familyArms); the laws fail."
			}
		]
	})
