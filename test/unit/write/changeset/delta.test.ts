/**
 * A write's change as a Z-set (core/zset.ts): each stratum's change its rows' set difference, the strata summed into
 * deltas and counts, checked against the test oracle's definitions (oracle/delta.ts, a second implementation, the
 * netting walk the outcome ran before the Z-set) over every sequence of per-stratum changes of up to three relations,
 * each fact's change returned by every member that requested it, in any order, a fact a stratum holds before and after
 * it returned removed and added back where the step says so; over the outcome's counts, one entry per written relation
 * in code point order; and over the rows a bigserial relation's statements return when its identity sequence lags the
 * stored values, against S' = (S \ D) ∪ A. A converted fact's identity is the boundary's fact identity of the same
 * values.
 *
 * Features: a fact two members of a stratum made present, or absent; a fact a stratum removed and added back
 * identical, and one so restored while an earlier stratum's change of it stands; a fact a later stratum's change
 * cancels; a written relation no stratum changed; a repeated written relation; names out of code unit order; a fact
 * removed and added back identical by a lagging sequence; a generated fact differing in its key, or in its note.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { codePoint, oneOf, string } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { uuid } from "@bjornpagen/testing/values"
import { Array as Arr, Effect, Option, Order } from "effect"
import { StoredRelationName } from "#compiler/core/ids.ts"
import { sideOf } from "#compiler/core/zset.ts"
import {
	type ChangeRow,
	outcomeCounts,
	outcomeKind,
	type RelationChange,
	relationChange,
	stratumChange,
	type Tag
} from "#compiler/runtime/write/net.ts"
import {
	compareFactIdentities,
	type FactIdentity,
	factIdentity
} from "#compiler/scalar/values/identity.ts"
import { assert, defined } from "#test/support/assert.ts"
import {
	type AttributedChange,
	attributeStratum,
	type Fact,
	type FactSet,
	factSetOf,
	identitySetOf,
	netCounts as oracleNetCounts,
	netStrata as oracleNetStrata,
	outcomeKind as oracleOutcomeKind,
	stateDelta
} from "#test/support/oracle/delta.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	byCodePoints,
	entriesOf,
	factSet,
	fields,
	id,
	identitiesOf,
	identity,
	type LaggingFeature,
	laggingGen,
	type NettingFeature,
	restoredOf,
	sequences,
	setOf,
	shuffledAll,
	tagsOf,
	ticket,
	type TicketFact
} from "#test/unit/write/changeset/delta.fixtures.ts"

/** A Z-set's entries on `side`, each fact with the tag it stands by. */
const sideEntries = (
	change: RelationChange,
	side: "added" | "removed"
): ReadonlyArray<readonly [FactIdentity, Tag]> =>
	entriesOf(
		Arr.flatMap([...change], ([id, w]) =>
			sideOf(w.weight) === side ? [[id, w.value] as const] : []
		)
	)

/** A Z-set's facts on `side`, in canonical order. */
const sideKeys = (change: RelationChange, side: "added" | "removed"): ReadonlyArray<FactIdentity> =>
	Arr.map(sideEntries(change, side), ([id]) => id)

/** The weight a sign mutant gives a removal, and the zero a dropped-zero mutant keeps: the two ways the one netting
 * rule (core/zset.ts) can break. */
const zsetKills = [
	{
		file: "packages/engine/src/core/zset.ts",
		original: "export const weightOf = { added: 1, removed: -1 } as const",
		replacement: "export const weightOf = { added: 1, removed: 1 } as const",
		why: "A removal weighs as an addition (core/zset.ts weightOf), so a fact one change adds and another removes sums to 2 and stands added where the two net to nothing."
	},
	{
		file: "packages/engine/src/core/zset.ts",
		original: "\t\t\tnet.delete(key)",
		replacement: "\t\t\tnet.set(key, { weight, value: next.value })",
		why: "A fact whose weights sum to 0 stays in the Z-set (core/zset.ts addInto), so a change that cancels another is counted under its tag."
	}
] as const

/**
 * A write's change summed as a Z-set equals the oracle's netting of deltas and counts for every sequence of per-stratum
 * changes.
 *
 * Budget: 1000 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/write/changeset/delta.test.ts:182 at 8cad5bce, its runs and its coverage's cases).
 */
export const aWritesChangeSummedAsAZSetEqualsTheOraclesNettingOfDeltasAndCountsForEverySequenceOfPerStratumChanges =
	property.explore(sequences, {
		needs: {},
		budget: { runs: 1000, steered: 200 },
		situations: [
			"a fact two members of a stratum made present",
			"a fact two members of a stratum made absent",
			"a fact a stratum removed and added back identical",
			"a fact restored identical while an earlier stratum's change of it stands",
			"a fact a later stratum's change cancels",
			"a written relation no stratum changed",
			"a repeated written relation",
			"names out of code unit order"
		] satisfies ReadonlyArray<Reached<NettingFeature>>,
		check:
			(_, c: Case<NettingFeature>) =>
			({ written, strata, relations }) =>
				Effect.sync(() => {
					const distinct = [...new Set(written)]
					if (distinct.length < written.length) {
						c.note("a repeated written relation")
					}
					const sorted = Arr.sort(distinct, byCodePoints)
					const byUnits = Arr.sort(distinct, Order.String)
					if (!Arr.every(sorted, (r, i) => r === byUnits[i])) {
						c.note("names out of code unit order")
					}
					const mine = upTo(strata, () => new Map<StoredRelationName, ReadonlyArray<ChangeRow>>())
					const expected = Arr.map(sorted, (relation) => {
						const sequence = defined(relations[distinct.indexOf(relation)], "a relation's sequence")
						let before = setOf(sequence.start)
						const start = before
						const theirs: Array<AttributedChange> = []
						const deltas = []
						const changes: Array<ReadonlyArray<ChangeRow>> = []
						for (const [s, drawnStep] of sequence.steps.entries()) {
							if (Option.isNone(drawnStep)) {
								continue
							}
							const st = drawnStep.value
							const after = setOf(st.after)
							const d = stateDelta(before, after)
							const restored = restoredOf(st, before, after)
							const pending = oracleNetStrata(deltas)
							if (restored.length > 0) {
								c.note("a fact a stratum removed and added back identical")
							}
							if (Arr.some(restored, (id) => pending.added.has(id))) {
								c.note("a fact restored identical while an earlier stratum's change of it stands")
							}
							if (
								Arr.some([...d.added.keys()], (id) => pending.removed.has(id)) ||
								Arr.some([...d.removed.keys()], (id) => pending.added.has(id))
							) {
								c.note("a fact a later stratum's change cancels")
							}
							const added = [...d.added.keys(), ...restored]
							const removed = [...d.removed.keys(), ...restored]
							const rows: ReadonlyArray<ChangeRow> = c.draw(
								shuffledAll([
									...Arr.flatMap(added, (id) =>
										Arr.map(tagsOf(st.added, id), (tag): ChangeRow => ({ identity: id, tag }))
									),
									...Arr.flatMap(removed, (id) =>
										Arr.map(tagsOf(st.removed, id), (tag): ChangeRow => ({ identity: id, tag }))
									)
								])
							)
							if (Arr.some(added, (id) => tagsOf(st.added, id).length > 1)) {
								c.note("a fact two members of a stratum made present")
							}
							if (Arr.some(removed, (id) => tagsOf(st.removed, id).length > 1)) {
								c.note("a fact two members of a stratum made absent")
							}
							deltas.push(d)
							const change = stratumChange(rows)
							const attributed = attributeStratum(before, after, {
								insert: identitySetOf(
									Arr.filter([...d.added.keys()], (id) => tagsOf(st.added, id).includes("insert"))
								),
								put: identitySetOf(
									Arr.filter([...d.added.keys()], (id) => tagsOf(st.added, id).includes("put"))
								),
								delete: identitySetOf(
									Arr.filter([...d.removed.keys()], (id) =>
										tagsOf(st.removed, id).includes("delete")
									)
								)
							})
							assert.deepEqual(
								{ added: sideEntries(change, "added"), removed: sideEntries(change, "removed") },
								{ added: entriesOf(attributed.added), removed: entriesOf(attributed.removed) },
								"a stratum's change is its set difference, each fact once under the count rules' tag"
							)
							theirs.push(attributed)
							changes.push(rows)
							defined(mine[s], "a stratum's rows").set(relation, rows)
							before = after
						}
						if (changes.length === 0) {
							c.note("a written relation no stratum changed")
						}
						const netted = relationChange(changes)
						const oracle = oracleNetStrata(deltas)
						const whole = stateDelta(start, before)
						for (const side of ["added", "removed"] as const) {
							const keys = sideKeys(netted, side)
							assert.deepEqual(keys, identitiesOf(oracle[side].keys()))
							assert.deepEqual(
								keys,
								identitiesOf(whole[side].keys()),
								"the netted delta is the state difference"
							)
						}
						return { relation, ...oracleNetCounts(theirs) }
					})
					const counts = outcomeCounts(written, mine)
					assert.deepEqual(counts, expected, "one entry per written relation, in code point order")
					assert.equal(outcomeKind(counts), oracleOutcomeKind(expected))
				}),
		oracle: { kind: "second-implementation", name: "the delta and count calculator" },
		kept: [],
		kills: [
			...zsetKills,
			{
				file: "packages/engine/src/runtime/write/net.ts",
				original: "\t\tif (seen === undefined || tags[seen.value].rank < rank) {",
				replacement: "\t\tif (seen === undefined || tags[seen.value].rank > rank) {",
				why: "A fact several members of one stratum changed on one side stands under its lowest-ranked tag (runtime/write/net.ts stratumChange), so a fact an insert and a put both returned counts under added, and a removal a delete member requested and a put displaced goes uncounted."
			}
		]
	})

/**
 * A stratum's change is a set difference nets a fact a delete freed and a lagging sequence's generated addition drew
 * back identical, and reports one differing as a removal and an addition.
 *
 * Budget: 500 runs and 500 steered cases, what its suite stated before it became a property
 * (test/unit/write/changeset/delta.test.ts:376 at 8cad5bce, its runs and its coverage's cases).
 */
export const aStratumsChangeIsASetDifferenceNetsAFactADeleteFreedAndALaggingSequencesGeneratedAdditionDrewBackIdenticalAndReportsOneDifferingAsARemovalAndAnAddition =
	property.explore(laggingGen, {
		needs: {},
		budget: { runs: 500, steered: 500 },
		situations: [
			"a fact removed and added back identical",
			"a generated fact differing in its key",
			"a generated fact differing in its note"
		] satisfies ReadonlyArray<Reached<LaggingFeature>>,
		check:
			(_, c: Case<LaggingFeature>) =>
			({ stored, lagging, generatedNote, alsoDeleted, later }) =>
				Effect.sync(() => {
					const k = BigInt(stored.length)
					const start = Arr.map(stored, (note, i): TicketFact => ({
						id: BigInt(i + 1),
						note
					}))
					/** The value the sequence's next call returns. */
					let next = lagging ? k : k + 1n
					const planted = defined(start.at(-1), "a stored fact")
					/** Each stratum's delete member, over the state before it, and its generated additions' notes. A later
					 * stratum's delete takes present facts, by drawn index. */
					const strata: ReadonlyArray<{
						readonly deletes: (before: FactSet) => ReadonlyArray<Fact>
						readonly generated: ReadonlyArray<string>
					}> = [
						{
							deletes: () => [planted, ...Arr.flatMap(alsoDeleted, (i) => start.slice(i, i + 1))],
							generated: [generatedNote]
						},
						...Arr.map(later, (l) => ({
							deletes: (before: FactSet) => {
								const present = [...before.values()]
								return present.length === 0
									? []
									: Arr.map(l.deletes, (i) =>
											defined(present[i % present.length], "a present fact")
										)
							},
							generated: l.generated
						}))
					]
					let state = factSet(start)
					const mine: Array<ReadonlyArray<ChangeRow>> = []
					const theirs: Array<AttributedChange> = []
					const deltas = []
					for (const [s, stratum] of strata.entries()) {
						const deleted = factSet(
							Arr.filter(stratum.deletes(state), (f) => state.has(identity(f)))
						)
						const added = factSet(
							Arr.map(stratum.generated, (note): TicketFact => {
								const id = next
								next += 1n
								return { id, note }
							})
						)
						const rows: ReadonlyArray<ChangeRow> = [
							...Arr.map([...deleted.keys()], (id): ChangeRow => ({ identity: id, tag: "delete" })),
							...Arr.map([...added.keys()], (id): ChangeRow => ({ identity: id, tag: "insert" }))
						]
						const change = stratumChange(rows)
						/** The oracle: S' = (S \ D) ∪ A, and the stratum's change is its set difference with S. */
						const after = factSetOf(
							Arr.filter([...state], ([id]) => !deleted.has(id)).concat([...added])
						)
						const delta = stateDelta(state, after)
						for (const side of ["added", "removed"] as const) {
							assert.deepEqual(
								sideKeys(change, side),
								identitiesOf(delta[side].keys()),
								`stratum ${s} ${side}`
							)
						}
						if (s === 0) {
							const old = identity(planted)
							const drawnBack = identity({ id: lagging ? k : k + 1n, note: generatedNote })
							const identical = compareFactIdentities(old, drawnBack) === 0
							assert.deepEqual(
								[sideOf(change.get(old)?.weight ?? 0), sideOf(change.get(drawnBack)?.weight ?? 0)],
								identical ? [undefined, undefined] : ["removed", "added"],
								identical ? "the identical fact is no change" : "a removal and an addition"
							)
							c.note(
								identical
									? "a fact removed and added back identical"
									: lagging
										? "a generated fact differing in its note"
										: "a generated fact differing in its key"
							)
						}
						mine.push(rows)
						theirs.push(
							attributeStratum(state, after, {
								insert: identitySetOf(added.keys()),
								put: identitySetOf([]),
								delete: identitySetOf(deleted.keys())
							})
						)
						deltas.push(delta)
						state = after
					}
					const netted = relationChange(mine)
					const whole = stateDelta(factSet(start), state)
					for (const side of ["added", "removed"] as const) {
						assert.deepEqual(sideKeys(netted, side), identitiesOf(whole[side].keys()))
					}
					assert.deepEqual(
						sideKeys(netted, "added"),
						identitiesOf(oracleNetStrata(deltas).added.keys())
					)
					assert.deepEqual(
						outcomeCounts(
							[ticket.name],
							Arr.map(mine, (rows) => new Map([[ticket.name, rows]]))
						),
						[{ relation: ticket.name, ...oracleNetCounts(theirs) }]
					)
				}),
		oracle: {
			kind: "specification",
			name: "S' = (S \\ D) ∪ A, each stratum's change its set difference with S, netted and counted as the delta oracle does (oracle/delta.ts)"
		},
		kept: [],
		kills: [
			...zsetKills,
			{
				file: "packages/engine/src/runtime/write/net.ts",
				original: '\t\t\tcase "insert":\n\t\t\t\tadded += 1n',
				replacement: '\t\t\tcase "insert":\n\t\t\t\tput += 1n',
				why: "A generated addition counts under put, not added (runtime/write/net.ts countOf), the case lane CATCH's operator mutant of the old count's tag test caught (grizzle 0baff5d6)."
			}
		]
	})

/**
 * Relation identity identifies a converted fact exactly as the boundary's fact identity identifies the same values.
 *
 * Budget: 200 runs and 0 steered cases, what its suite stated before it became a property
 * (test/unit/write/changeset/delta.test.ts:551 at 8cad5bce, its runs and its coverage's cases).
 */
export const relationIdentityIdentifiesAConvertedFactExactlyAsTheBoundarysFactIdentityIdentifiesTheSameValues =
	property.explore(
		(source) =>
			[
				source.draw(uuid(4)),
				source.draw(
					string(
						oneOf([codePoint(0x20, 0x7e), codePoint(0xa0, 0xd7_ff), codePoint(0xe0_00, 0x10_ffff)]),
						{ min: 0, max: 8 }
					)
				)
			] as const,
		{
			needs: {},
			budget: { runs: 200, steered: 0 },
			situations: [],
			check:
				() =>
				([task, text]) =>
					Effect.sync(() => {
						const written = { note: text, task }
						const admitted = factIdentity(fields, written)
						assert.deepEqual(admitted.ok ? admitted.value.identity : undefined, id(written))
					}),
			oracle: {
				kind: "second-implementation",
				name: "the boundary's fact identity of the same values (scalar/values/identity.ts factIdentity)"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/runtime/write/net.ts",
					original: "\t\t\t\t\t: admittedText(field.spec, fact[field.name])",
					replacement: "\t\t\t\t\t: admittedText(field.spec, fact[field.name]).toLowerCase()",
					why: "A fact's identity case-folds its texts (runtime/write/net.ts relationIdentity), so facts that differ in case are one."
				}
			]
		}
	)
