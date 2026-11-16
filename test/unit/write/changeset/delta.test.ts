/**
 * Deltas and counts netted across strata, checked against the test oracle's definitions (oracle/delta.ts, a second
 * implementation) over every sequence of per-stratum changes of up to three relations, each fact's change returned by
 * every member that requested it, in any order; over the outcome's counts, one entry per written relation in code point
 * order; and over the rows a bigserial relation's statements return when its identity sequence lags the stored values,
 * against S' = (S \ D) ∪ A. A converted fact's identity is the boundary's fact identity of the same values.
 *
 * Features: a fact two members of a stratum made present, or absent; a written relation no stratum changed; a repeated
 * written relation; names out of code unit order; a fact removed and added back identical; a generated fact differing
 * in its key, or in its note.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { codePoint, oneOf, string } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { uuid } from "@bjornpagen/testing/values"
import { Array as Arr, Effect, Option, Order } from "effect"
import { StoredRelationName } from "#compiler/core/ids.ts"
import {
	type ChangeRow,
	netStrata,
	outcomeCounts,
	outcomeKind,
	type StratumChange,
	stratumChange
} from "#compiler/runtime/write/net.ts"
import { compareFactIdentities, factIdentity } from "#compiler/scalar/values/identity.ts"
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
	fact,
	factSet,
	fields,
	id,
	identitiesOf,
	identity,
	type LaggingFeature,
	laggingGen,
	modelId,
	type NettingFeature,
	sequences,
	setOf,
	shuffledAll,
	tagsOf,
	ticket,
	type TicketFact
} from "#test/unit/write/changeset/delta.fixtures.ts"

/** Netting equals the oracle's netting of deltas and counts for every sequence of per-stratum changes. */
export const nettingEqualsTheOraclesNettingOfDeltasAndCountsForEverySequenceOfPerStratumChanges =
	property.explore(sequences, {
		needs: {},
		situations: [
			"a fact two members of a stratum made present",
			"a fact two members of a stratum made absent",
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
					const mine = upTo(strata, () => new Map<StoredRelationName, StratumChange>())
					const expected = Arr.map(sorted, (relation) => {
						const sequence = defined(relations[distinct.indexOf(relation)], "a relation's sequence")
						let before = setOf(sequence.start)
						const start = before
						const theirs: Array<AttributedChange> = []
						const deltas = []
						const changes: Array<StratumChange> = []
						for (const [s, drawnStep] of sequence.steps.entries()) {
							if (Option.isNone(drawnStep)) {
								continue
							}
							const st = drawnStep.value
							const after = setOf(st.after)
							const d = stateDelta(before, after)
							deltas.push(d)
							const rows: ReadonlyArray<ChangeRow> = c.draw(
								shuffledAll([
									...Arr.flatMap([...d.added.keys()], (id) =>
										Arr.map(tagsOf(st.added, id), (tag): ChangeRow => ({
											side: "added",
											identity: id,
											fact: fact(modelId(id)),
											tag
										}))
									),
									...Arr.flatMap([...d.removed.keys()], (id) =>
										Arr.map(tagsOf(st.removed, id), (tag): ChangeRow => ({
											side: "removed",
											identity: id,
											fact: fact(modelId(id)),
											tag
										}))
									)
								])
							)
							if (Arr.some([...d.added.keys()], (id) => tagsOf(st.added, id).length > 1)) {
								c.note("a fact two members of a stratum made present")
							}
							if (Arr.some([...d.removed.keys()], (id) => tagsOf(st.removed, id).length > 1)) {
								c.note("a fact two members of a stratum made absent")
							}
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
								{
									added: entriesOf(
										Arr.map([...change.added], ([id, row]) => [id, row.tag] as const)
									),
									removed: entriesOf(
										Arr.map([...change.removed], ([id, row]) => [id, row.tag] as const)
									)
								},
								{ added: entriesOf(attributed.added), removed: entriesOf(attributed.removed) },
								"a stratum's change is its set difference, each fact once under the count rules' tag"
							)
							theirs.push(attributed)
							changes.push(change)
							defined(mine[s], "a stratum's changes").set(relation, change)
							before = after
						}
						if (changes.length === 0) {
							c.note("a written relation no stratum changed")
						}
						const netted = netStrata(changes)
						const oracle = oracleNetStrata(deltas)
						const whole = stateDelta(start, before)
						for (const side of ["added", "removed"] as const) {
							assert.deepEqual(identitiesOf(netted[side].keys()), identitiesOf(oracle[side].keys()))
							assert.deepEqual(
								identitiesOf(netted[side].keys()),
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
			{
				file: "packages/engine/src/runtime/write/net.ts",
				original: "\t\t\t} else {\n\t\t\t\tadded.set(identity, change)\n\t\t\t}",
				replacement: "\t\t\t}\n\t\t\tadded.set(identity, change)",
				why: "A fact a later stratum adds back identical after an earlier one removed it is kept as added, where the two net to nothing (runtime/write/net.ts netStrata)."
			},
			{
				file: "packages/engine/src/runtime/write/net.ts",
				original:
					"\t\t\tif (removed.has(identity)) {\n\t\t\t\tremoved.delete(identity)\n\t\t\t} else {",
				replacement: "\t\t\tif (!removed.has(identity)) {",
				why: "A fact a later stratum adds back after an earlier one removed it stays removed (runtime/write/net.ts netStrata)."
			}
		]
	})

/** A stratum's change is a set difference nets a fact a delete freed and a lagging sequence's generated addition drew back identical, and reports one differing as a removal and an addition. */
export const aStratumsChangeIsASetDifferenceNetsAFactADeleteFreedAndALaggingSequencesGeneratedAdditionDrewBackIdenticalAndReportsOneDifferingAsARemovalAndAnAddition =
	property.explore(laggingGen, {
		needs: {},
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
					const mine: Array<StratumChange> = []
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
							...Arr.map([...deleted], ([id, held]): ChangeRow => ({
								side: "removed",
								identity: id,
								fact: held,
								tag: "delete"
							})),
							...Arr.map([...added], ([id, held]): ChangeRow => ({
								side: "added",
								identity: id,
								fact: held,
								tag: "insert"
							}))
						]
						const change = stratumChange(rows)
						/** The oracle: S' = (S \ D) ∪ A, and the stratum's change is its set difference with S. */
						const after = factSetOf(
							Arr.filter([...state], ([id]) => !deleted.has(id)).concat([...added])
						)
						const delta = stateDelta(state, after)
						assert.deepEqual(
							identitiesOf(change.added.keys()),
							identitiesOf(delta.added.keys()),
							`stratum ${s} added`
						)
						assert.deepEqual(
							identitiesOf(change.removed.keys()),
							identitiesOf(delta.removed.keys()),
							`stratum ${s} removed`
						)
						if (s === 0) {
							const old = identity(planted)
							const drawnBack = identity({ id: lagging ? k : k + 1n, note: generatedNote })
							const identical = compareFactIdentities(old, drawnBack) === 0
							assert.equal(
								identical
									? change.added.has(old) || change.removed.has(old)
									: change.removed.has(old) && change.added.has(drawnBack),
								!identical,
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
						mine.push(change)
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
					const netted = netStrata(mine)
					const whole = stateDelta(factSet(start), state)
					assert.deepEqual(identitiesOf(netted.added.keys()), identitiesOf(whole.added.keys()))
					assert.deepEqual(identitiesOf(netted.removed.keys()), identitiesOf(whole.removed.keys()))
					assert.deepEqual(
						identitiesOf(netted.added.keys()),
						identitiesOf(oracleNetStrata(deltas).added.keys())
					)
					assert.deepEqual(
						outcomeCounts(
							[ticket.name],
							Arr.map(mine, (change) => new Map([[ticket.name, change]]))
						),
						[{ relation: ticket.name, ...oracleNetCounts(theirs) }]
					)
				}),
		oracle: {
			kind: "specification",
			name: "S' = (S \\ D) ∪ A, each stratum's change its set difference with S, netted and counted as the delta oracle does (oracle/delta.ts)"
		},
		kept: [],
		kills: []
	})

/** Relation identity identifies a converted fact exactly as the boundary's fact identity identifies the same values. */
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
