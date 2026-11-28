/**
 * The violation queries of a family's and an accumulated copy's laws mean what the laws say (fin.md §4, §5.2, w4-w7
 * §2.3): evaluated by the reference evaluator over every state of a small box, each is empty exactly on the states a
 * second implementation, written from the law's statement, calls lawful. The boxes are exhausted and named in each
 * search; every invalid kind the doctrine names that a box can hold is one of its cases.
 *
 * - Ordered: two owners of count 0 to 2 and up to three members, each of owner a, b or none at slot 0 to 2.
 * - Counted: two owners of count 0 to 2 and up to three members, each of owner a, b or none.
 * - Copy: one owner's family of 0 to 3 members, each state and was 0 or 1, an accumulated copy riding its axis.
 *
 * Features: each box's verdicts and broken laws.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array, finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	type HostFacts,
	lawOfShape,
	uuidOf,
	violates
} from "#test/support/unit/analysis/theory/support.ts"
import {
	type Copied,
	copy,
	counted,
	countedFault,
	countedState,
	type FamilyFault,
	ordered,
	orderedFault,
	orderedState,
	owners,
	t
} from "#test/unit/analysis/theory/violations.fixtures.ts"

/** A family's law is violated exactly when an ordered family's slots are not 0 … n − 1 or a member has no owner. */
export const aFamilysLawIsViolatedExactlyWhenAnOrderedFamilysSlotsAreNot0N1OrAMemberHasNoOwner =
	property.exhaust(finite(orderedState), {
		needs: {},
		situations: [
			"lawful",
			"an orphan",
			"a duplicate slot",
			"a gap in at",
			"a count off by one"
		] satisfies ReadonlyArray<Reached<FamilyFault>>,
		check: (_, k: Case<FamilyFault>) => (s) =>
			Effect.sync(() => {
				const fault = orderedFault(s)
				k.note(fault)
				const facts: HostFacts = {
					O: owners(s.counts),
					F: Arr.map(s.members, (m, i) => ({
						fid: uuidOf(100 + i),
						o: uuidOf(m.owner + 1),
						at: BigInt(m.at)
					}))
				}
				assert.equal(
					violates(ordered, lawOfShape(ordered, "family"), facts),
					fault !== "lawful",
					`${Formatter.format(s)} is ${fault}`
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "fin.md §4.1's theorem, checked directly"
		},
		box: "two owners of count 0 to 2 and up to three members, each of owner a, b or none at slot 0 to 2",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/laws.ts",
				original:
					"\t\tw(lemma(b, env, [s.slots.before, s.slots.at], loc)),\n\t\tw(lemma(b, env, [s.slots.last, s.slots.at], loc))",
				replacement: "\t\tw(lemma(b, env, [s.slots.before, s.slots.at], loc))",
				why: "An ordered family's violation omits its last-member lemma (analysis/theory/laws.ts familyArms); the ordered box fails."
			}
		]
	})

/** A family's law is violated exactly when a counted family's counts are not its owners' member counts. */
export const aFamilysLawIsViolatedExactlyWhenACountedFamilysCountsAreNotItsOwnersMemberCounts =
	property.exhaust(finite(countedState), {
		needs: {},
		situations: ["lawful", "an orphan", "a count off by one"] satisfies ReadonlyArray<
			Reached<Extract<FamilyFault, "lawful" | "an orphan" | "a count off by one">>
		>,
		check:
			(_, k: Case<Extract<FamilyFault, "lawful" | "an orphan" | "a count off by one">>) => (s) =>
				Effect.sync(() => {
					const fault = countedFault(s)
					if (fault === "lawful" || fault === "an orphan" || fault === "a count off by one") {
						k.note(fault)
					}
					const facts: HostFacts = {
						O: owners(s.counts),
						F: Arr.map(s.members, (o, i) => ({ fid: uuidOf(100 + i), o: uuidOf(o + 1) }))
					}
					assert.equal(
						violates(counted, lawOfShape(counted, "family"), facts),
						fault !== "lawful",
						`${Formatter.format(s)} is ${fault}`
					)
				}),
		oracle: {
			kind: "second-implementation",
			name: "fin.md §4.2's bijection, counted directly"
		},
		box: "two owners of count 0 to 2 and up to three members, each of owner a, b or none",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/laws.ts",
				original: "\t\treturn [orphan, w(unequal), w(off)]",
				replacement: "\t\treturn [orphan, w(unequal)]",
				why: "A counted family's violation omits its count's mismatch (analysis/theory/laws.ts familyArms); the counted box fails."
			}
		]
	})

/** An accumulated copy's law is violated exactly when a copy is not its predecessor's state, or not its start at slot 0. */
export const anAccumulatedCopysLawIsViolatedExactlyWhenACopyIsNotItsPredecessorsStateOrNotItsStartAtSlot0 =
	property.exhaust(
		finite(
			array((s): Copied => ({ state: int(0, 1)(s), was: int(0, 1)(s) }), {
				min: 0,
				max: 3
			})
		),
		{
			needs: {},
			situations: [
				"lawful",
				"off its start at slot 0",
				"a stale predecessor"
			] satisfies ReadonlyArray<
				Reached<"lawful" | "off its start at slot 0" | "a stale predecessor">
			>,
			check:
				(_, k: Case<"lawful" | "off its start at slot 0" | "a stale predecessor">) => (members) =>
					Effect.sync(() => {
						const [first] = members
						const fault =
							first !== undefined && first.was !== 0
								? "off its start at slot 0"
								: Arr.some(members, (m, i) => i > 0 && m.was !== defined(members[i - 1]).state)
									? "a stale predecessor"
									: "lawful"
						k.note(fault)
						const facts: HostFacts = {
							O: [{ id: uuidOf(1), n: BigInt(members.length) }],
							F: Arr.map(members, (m, i) => ({
								fid: uuidOf(100 + i),
								o: uuidOf(1),
								at: BigInt(i),
								state: BigInt(m.state),
								was: BigInt(m.was)
							}))
						}
						assert.equal(
							violates(t, copy, facts),
							fault !== "lawful",
							`${Formatter.format(members)} is ${fault}`
						)
					}),
			oracle: {
				kind: "second-implementation",
				name: "the copy read directly: was is the predecessor's state, 0 at slot 0"
			},
			box: "one owner's family of 0 to 3 members, each state and was 0 or 1",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/analysis/theory/laws.ts",
					original: "\tconst pins = ridingPins(familyOf(families, ride.family), ride)",
					replacement:
						"\tconst pins = ridingPins(familyOf(families, ride.family), ride).slice(0, 0)",
					why: "A riding copy's violation omits its pin at the axis's base (analysis/theory/laws.ts); the copy box fails."
				}
			]
		}
	)
