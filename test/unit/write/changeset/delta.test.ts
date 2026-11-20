/**
 * A write's change as a Z-set (core/zset.ts): each stratum's change its rows' set difference, the strata summed into
 * deltas and counts, checked against the test oracle's definitions (oracle/delta.ts, a second implementation, the
 * netting walk the outcome ran before the Z-set) over every sequence of per-stratum changes of up to three relations,
 * each fact's change returned by every member that requested it, in any order, a fact a stratum holds before and after
 * it returned removed and added back where the step says so; over the outcome's counts, one entry per written relation
 * in code point order. A converted fact's identity is the boundary's fact identity of the same values.
 *
 * Features: a fact two members of a stratum made present, or absent; a fact a stratum removed and added back
 * identical, and one so restored while an earlier stratum's change of it stands; a fact a later stratum's change
 * cancels; a written relation no stratum changed; a repeated written relation; names out of code unit order.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { codePoint, oneOf, string } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { uuid } from "@bjornpagen/testing/values"
import { Array as Arr, Effect, Option, Order } from "effect"
import { StoredRelationName } from "#compiler/core/ids.ts"
import { compareTextsIds, type TextsId, textsId } from "#compiler/core/text.ts"
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
import { factIdentity } from "#compiler/scalar/values/identity.ts"
import {
	type AttributedChange,
	attributeStratum,
	type FactTexts,
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
	fields,
	id,
	identitiesOf,
	type NettingFeature,
	restoredOf,
	sequences,
	setOf,
	shuffledAll,
	tagsOf
} from "#test/unit/write/changeset/delta.fixtures.ts"

/**
 * A Z-set's entries on `side`, each fact's identity's texts (core/text.ts TextsId texts) with the tag
 * it stands by, in the identities' canonical order (compareTextsIds): the order the oracle's texts are in
 * (`keyedEntries`), exactly where the write's order is the canonical one.
 */
const sideEntries = (
	change: RelationChange,
	side: "added" | "removed"
): ReadonlyArray<readonly [ReadonlyArray<string>, Tag]> =>
	Arr.map(
		Arr.sort(
			Arr.flatMap([...change], ([id, w]) =>
				sideOf(w.weight) === side ? [[id, w.value] as const] : []
			),
			Order.mapInput(compareTextsIds, ([id]: readonly [TextsId, Tag]): TextsId => id)
		),
		([id, tag]) => [id.texts, tag] as const
	)

/** A Z-set's facts on `side`, their identities' texts in code point order, in canonical order. */
const sideKeys = (
	change: RelationChange,
	side: "added" | "removed"
): ReadonlyArray<ReadonlyArray<string>> => Arr.map(sideEntries(change, side), ([id]) => id)

/** The oracle's entries in canonical order (`entriesOf`), each identity's texts as the write holds them in order. */
const keyedEntries = <V>(
	entries: Iterable<readonly [FactTexts, V]>
): ReadonlyArray<readonly [ReadonlyArray<string>, V]> =>
	Arr.map(entriesOf(entries), ([texts, v]) => [texts, v] as const)

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
										Arr.map(tagsOf(st.added, id), (tag): ChangeRow => ({
											identity: textsId(id),
											tag
										}))
									),
									...Arr.flatMap(removed, (id) =>
										Arr.map(tagsOf(st.removed, id), (tag): ChangeRow => ({
											identity: textsId(id),
											tag
										}))
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
								{
									added: keyedEntries(attributed.added),
									removed: keyedEntries(attributed.removed)
								},
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
							const ordered = (texts: FactTexts) => texts
							assert.deepEqual(keys, Arr.map(identitiesOf(oracle[side].keys()), ordered))
							assert.deepEqual(
								keys,
								Arr.map(identitiesOf(whole[side].keys()), ordered),
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
				original: '\t\t\tcase "insert":\n\t\t\t\tadded += 1n',
				replacement: '\t\t\tcase "insert":\n\t\t\t\tput += 1n',
				why: "An insert's fact counts under put, not added (runtime/write/net.ts countOf), the case lane CATCH's operator mutant of the old count's tag test caught (grizzle 0baff5d6)."
			},
			{
				file: "packages/engine/src/runtime/write/net.ts",
				original: "\t\tif (seen === undefined || tags[seen.value].rank < rank) {",
				replacement: "\t\tif (seen === undefined || tags[seen.value].rank > rank) {",
				why: "A fact several members of one stratum changed on one side stands under its lowest-ranked tag (runtime/write/net.ts stratumChange), so a fact an insert and a put both returned counts under added, and a removal a delete member requested and a put displaced goes uncounted."
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
