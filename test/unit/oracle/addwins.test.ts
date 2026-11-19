import { assert } from "@bjornpagen/testing/assert"
/**
 * The add-wins calculator (test/support/oracle/addwins.ts applyAddWins), the write oracle's model of a ChangeSet,
 * against independent references, over small-domain Task facts (an id of 0 to 3, an account of 0 or 1, a kind of the
 * roster's two), every stored state holding one fact per id by construction:
 *
 * - Transition: per stratum S' = (S minus D) union A, A the inserts and puts and D the deletes and the occupants at
 *   the puts' keys, keys checked after each stratum: the outcome is the definition's, written out apart, its final
 *   state or the stratum whose S' first holds two facts at one id. Oracle: a second implementation.
 * - Build-order independence: members permuted within each stratum, each member split into one per fact with one fact
 *   repeated, and the strata built as the union of two sequences in either order, all give the outcome of the strata
 *   as drawn. Oracle: universal, a metamorphic relation.
 * - Put sugar: a put of facts at distinct ids is a described deletion of the occupants at their keys plus an
 *   insertion: one state, one delta, its counts all put. Oracle: the specification.
 * - Counts: each relation's changes netted across strata are the per-stratum netting reference's, on every sequence
 *   the calculator applies, over the general strata and a dense family of two ids. Oracle: a second implementation.
 *
 * Features: applied and rejected outcomes, a rejection before the last stratum; a stratum of several members and a
 * member of several facts; a put displacing an occupant and one into an empty key; multi-stratum counts and counts
 * that differ from the pooled reading.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import {
	applyAddWins,
	factsOf,
	OracleChangeSet,
	type OracleState,
	oracleState
} from "#test/support/oracle/addwins.ts"
import {
	applied,
	build,
	buildOrderGen,
	countsGen,
	countsOf,
	type OrderFeature,
	pooledCounts,
	type PutFeature,
	putGen,
	reference,
	referenceCounts,
	sameFacts,
	sameOutcome,
	taskKey,
	type TransitionFeature,
	transitionGen
} from "#test/unit/oracle/addwins.fixtures.ts"
import { schema } from "#test/unit/oracle/fixtures.ts"

/**
 * The add-wins transition is S' = (S \ D) ∪ A per stratum, with keys checked after each stratum.
 *
 * Budget: its suite's count before the conversion (unit/oracle/addwins-transition: 2000 independent cases and 0
 * steered, Vitest at grizzle 4ca3036a).
 */
export const theAddWinsTransitionIsSSDAPerStratumWithKeysCheckedAfterEachStratum = property.explore(
	transitionGen,
	{
		needs: {},
		situations: ["applied", "rejected", "rejected before the last stratum"] satisfies ReadonlyArray<
			Reached<TransitionFeature>
		>,
		check:
			(_, c: Case<TransitionFeature>) =>
			([initial, layers]) =>
				Effect.sync(() => {
					const outcome = applyAddWins(
						schema,
						oracleState(schema, { Task: initial }),
						build(layers)
					)
					const expected = reference(initial, layers)
					if (expected.kind === "rejected") {
						assert.ok(outcome.kind === "invariant-rejected", "the reference rejects")
						assert.equal(outcome.law, taskKey)
						assert.equal(outcome.stratum, expected.stratum)
						c.note("rejected")
						if (expected.stratum < layers.length - 1) {
							c.note("rejected before the last stratum")
						}
					} else {
						sameFacts(factsOf(applied(outcome).state, "Task"), expected.state)
						c.note("applied")
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "the definition S' = (S \\ D) ∪ A per stratum, written out apart, keys checked after each"
		},
		budget: { runs: 2000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/codes.ts",
				original: "\t\trank.set(slot.handle, code)",
				replacement: "\t\t{}",
				why: "Operator mutant (statement) at packages/engine/src/ir/codes.ts:106 in rosterCodec: `rank.set(slot.handle, code)` becomes `{}`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	}
)

/**
 * Build-order independence does not depend on member order, member splitting, or how strata are unioned.
 *
 * Budget: its suite's count before the conversion (unit/oracle/addwins-build-order: 1000 independent cases and 0
 * steered, Vitest at grizzle 4ca3036a).
 */
export const buildOrderIndependenceDoesNotDependOnMemberOrderMemberSplittingOrHowStrataAreUnioned =
	property.explore(buildOrderGen, {
		needs: {},
		situations: [
			"applied",
			"rejected",
			"a stratum of several members",
			"a member of several facts"
		] satisfies ReadonlyArray<Reached<OrderFeature>>,
		check:
			(_, c: Case<OrderFeature>) =>
			([initial, layers, permuted]) =>
				Effect.sync(() => {
					const s = oracleState(schema, { Task: initial })
					const base = applyAddWins(schema, s, build(layers))
					c.note(base.kind === "invariant-rejected" ? "rejected" : "applied")
					if (Arr.some(layers, (members) => members.length > 1)) {
						c.note("a stratum of several members")
					}
					if (Arr.some(layers, (members) => Arr.some(members, (m) => m.facts.length > 1))) {
						c.note("a member of several facts")
					}
					sameOutcome(applyAddWins(schema, s, build(permuted)), base)
					/**
					 * Every member split into one member per fact, and equal facts repeated. A member with no facts still
					 * names its relation, so it stays.
					 */
					const split = Arr.map(layers, (members) =>
						Arr.flatMap(members, (m) =>
							m.facts.length === 0
								? [m]
								: Arr.map([...m.facts, ...m.facts.slice(0, 1)], (f) => ({ op: m.op, facts: [f] }))
						)
					)
					sameOutcome(applyAddWins(schema, s, build(split)), base)
					/** The same strata built as the union of two sequences, position by position, in either order. */
					const halves = [
						Arr.map(layers, (members) => Arr.flatMap(members, (m, i) => (i % 2 === 0 ? [m] : []))),
						Arr.map(layers, (members) => Arr.flatMap(members, (m, i) => (i % 2 === 1 ? [m] : [])))
					] as const
					const [left, right] = [build(halves[0]), build(halves[1])]
					sameOutcome(applyAddWins(schema, s, OracleChangeSet.union(left, right)), base)
					sameOutcome(applyAddWins(schema, s, OracleChangeSet.union(right, left)), base)
				}),
		oracle: {
			kind: "universal",
			name: "the outcome is unchanged by member order, member splitting and how strata are unioned"
		},
		budget: { runs: 1000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/codes.ts",
				original: "\t\trank.set(slot.handle, code)",
				replacement: "\t\t{}",
				why: "Operator mutant (statement) at packages/engine/src/ir/codes.ts:106 in rosterCodec: `rank.set(slot.handle, code)` becomes `{}`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * Put is sugar for a described deletion of the occupants at its keys plus an insertion.
 *
 * Budget: its suite's count before the conversion (unit/oracle/addwins-put: 1000 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const putIsSugarForADescribedDeletionOfTheOccupantsAtItsKeysPlusAnInsertion =
	property.explore(putGen, {
		needs: {},
		situations: ["a put displacing an occupant", "a put into an empty key"] satisfies ReadonlyArray<
			Reached<PutFeature>
		>,
		check:
			(_, c: Case<PutFeature>) =>
			([initial, facts]) =>
				Effect.sync(() => {
					const held = new Set(Arr.map(initial, (f) => f.id))
					for (const f of facts) {
						c.note(held.has(f.id) ? "a put displacing an occupant" : "a put into an empty key")
					}
					const s = oracleState(schema, { Task: initial })
					const viaPut = applied(
						applyAddWins(schema, s, OracleChangeSet.empty().put("Task", facts))
					)
					const keys = new Set(Arr.map(facts, (f) => f.id))
					const occupants = (state: OracleState) =>
						Arr.filter(
							factsOf(state, "Task"),
							(f) => typeof f["id"] === "number" && keys.has(f["id"])
						)
					const viaSugar = applied(
						applyAddWins(
							schema,
							s,
							OracleChangeSet.empty().delete("Task", occupants).insert("Task", facts)
						)
					)
					sameFacts(factsOf(viaPut.state, "Task"), factsOf(viaSugar.state, "Task"))
					assert.deepEqual(viaPut.delta, viaSugar.delta)
					const sugar = countsOf(viaSugar, "Task")
					const put = countsOf(viaPut, "Task")
					assert.equal(put.put, sugar.added)
					assert.equal(put.added, 0n)
					assert.equal(put.deleted, 0n)
				}),
		oracle: {
			kind: "specification",
			name: "put is a described deletion of the occupants at its keys plus an insertion, counted as put"
		},
		budget: { runs: 1000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/codes.ts",
				original: "\t\trank.set(slot.handle, code)",
				replacement: "\t\t{}",
				why: "Operator mutant (statement) at packages/engine/src/ir/codes.ts:106 in rosterCodec: `rank.set(slot.handle, code)` becomes `{}`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})

/**
 * Counts across strata, netted over the per-stratum changes, agree with the per-stratum netting reference on every
 * accepted or no-change sequence.
 *
 * Budget: its suite's count before the conversion (unit/oracle/addwins-counts: 4000 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const countsAcrossStrataNettedOverThePerStratumChangesAgreesWithThePerStratumNettingReferenceOnEveryAcceptedOrNoChangeSequence =
	property.explore(countsGen, {
		needs: {},
		situations: ["multi-stratum", "differs from pooled"] satisfies ReadonlyArray<
			Reached<"multi-stratum" | "differs from pooled">
		>,
		check:
			(_, c: Case<"multi-stratum" | "differs from pooled">) =>
			([initial, layers]) =>
				Effect.sync(() => {
					const outcome = applyAddWins(
						schema,
						oracleState(schema, { Task: initial }),
						build(layers)
					)
					if (outcome.kind === "invariant-rejected") {
						return
					}
					const expected = referenceCounts(initial, layers)
					const reported = Arr.findFirst(outcome.counts, (r) => r.relation === "Task")
					if (Option.isNone(reported)) {
						assert.deepEqual(expected, { added: 0n, deleted: 0n, put: 0n })
						return
					}
					if (layers.length > 1) {
						c.note("multi-stratum")
					}
					const pooled = pooledCounts(initial, factsOf(outcome.state, "Task"), layers)
					if (
						pooled.added !== expected.added ||
						pooled.deleted !== expected.deleted ||
						pooled.put !== expected.put
					) {
						c.note("differs from pooled")
					}
					assert.deepEqual(countsOf(outcome, "Task"), expected)
				}),
		oracle: {
			kind: "second-implementation",
			name: "the per-stratum netting reference, written out apart"
		},
		budget: { runs: 4000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/text/src/base/array.ts",
				original: "\treturn i < 0 ? undefined : i",
				replacement: "\treturn i >= 0 ? undefined : i",
				why: "Operator mutant (comparison) at packages/engine/src/core/array.ts:11 in firstIndex: `<` becomes `>=`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})
