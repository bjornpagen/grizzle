import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	codePoint,
	element,
	type Gen,
	int,
	oneOf,
	option,
	shuffled,
	string,
	subarray
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { uuid } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, String as Str } from "effect"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import {
	compareFactIdentities,
	type FactIdentity,
	factIdentity
} from "#compiler/scalar/values/identity.ts"
import {
	type ChangeRow,
	netStrata,
	outcomeCounts,
	outcomeKind,
	relationIdentity,
	type StratumChange,
	stratumChange
} from "#compiler/write/delta/net.ts"
import { assert, defined } from "#test/support/assert.ts"
import { Work } from "#test/support/fixtures/api/work.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	type AttributedChange,
	attributeStratum,
	type Fact,
	factSetOf,
	type FactSet,
	identityOrder,
	identitySetOf,
	netCounts as oracleNetCounts,
	netStrata as oracleNetStrata,
	outcomeKind as oracleOutcomeKind,
	stateDelta
} from "#test/support/oracle/delta.ts"
import { codesOf, compiled, cs, Ledger } from "#test/unit/write/changeset/fixtures.ts"

/** Deltas and counts netted across strata, checked against the test oracle's definitions over every sequence of
 * per-stratum changes of up to three relations, each fact's change returned by every member that requested it, in any
 * order; over the outcome's counts, one entry per written relation in code point order; and over the rows a bigserial
 * relation's statements return when its identity sequence lags the stored values. */
const fact = (id: string): Fact => ({ id })

/** The facts each relation's states are drawn over. */
const universe = ["a", "b", "c", "d"] as const

/**
 * The relation names a ChangeSet writes, among them two whose UTF-16 order is not their code point order: U+FF61 is
 * below U+10000 by code point, above it by code unit.
 */
const relationNames = ["a", "b", "\uFF61", "\u{10000}"] as const

/** The members of one stratum that returned a fact it made present, or absent, in the order their rows came back. */
const addedBy = element([["insert"], ["put"], ["insert", "put"], ["put", "insert"]] as const)
const removedBy = element([
	["delete"],
	["displaced"],
	["delete", "displaced"],
	["displaced", "delete"]
] as const)

/** One step of a relation's sequence: the state after it, and which members returned each fact of the universe. */
interface Step {
	readonly after: ReadonlyArray<string>
	readonly added: ReadonlyArray<ReadonlyArray<"insert" | "put">>
	readonly removed: ReadonlyArray<ReadonlyArray<"delete" | "displaced">>
}

const step: Gen<Step> = (source) => ({
	after: source.draw(subarray(universe)),
	added: source.draw(array(addedBy, { min: universe.length, max: universe.length })),
	removed: source.draw(array(removedBy, { min: universe.length, max: universe.length }))
})

/** A relation's sequence: its start, and per stratum a step, or nothing when the stratum does not change it. */
interface Sequence {
	readonly start: ReadonlyArray<string>
	readonly steps: ReadonlyArray<Option.Option<Step>>
}

/** Up to three written relations, a name repeated among them, over one to five strata. */
const sequences: Gen<{
	readonly written: ReadonlyArray<string>
	readonly strata: number
	readonly relations: ReadonlyArray<Sequence>
}> = (source) => {
	const written = source.draw(array(element(relationNames), { min: 1, max: 3 }))
	const strata = source.draw(int(1, 5))
	const distinct = [...new Set(written)]
	return {
		written,
		strata,
		relations: Arr.map(distinct, () => ({
			start: source.draw(subarray(universe)),
			steps: Arr.makeBy(strata, () => source.draw(option(step)))
		}))
	}
}

/** The model's facts of `ids`, each identified by its one text `[id]`. */
const setOf = (ids: ReadonlyArray<string>): FactSet =>
	factSetOf(Arr.map(ids, (id) => [[id], fact(id)] as const))

/** The model's id of an identity, which the model writes as the one text `[id]`. */
const modelId = (identity: FactIdentity): string => defined(identity[0], "a model fact's one text")

/** A fact set's or a change's identities, in canonical order. */
const identitiesOf = (keys: Iterable<FactIdentity>): ReadonlyArray<FactIdentity> =>
	Arr.sort(keys, identityOrder)

/** A change's entries, by identity in canonical order. */
const entriesOf = <V>(
	entries: Iterable<readonly [FactIdentity, V]>
): ReadonlyArray<readonly [FactIdentity, V]> =>
	Arr.sort(
		entries,
		Order.mapInput(identityOrder, ([identity]: readonly [FactIdentity, V]) => identity)
	)

/** What a step says of a fact of the universe: one entry per fact, by position. */
const tagsOf = <T>(tags: ReadonlyArray<T>, identity: FactIdentity): T => {
	const id = modelId(identity)
	return defined(
		Option.getOrUndefined(
			Option.flatMap(
				Arr.findFirstIndex(universe, (u) => u === id),
				(at) => Option.fromUndefinedOr(tags[at])
			)
		),
		`the tags of ${id}`
	)
}

/** Code point order, by the code points themselves. */
const byCodePoints: Order.Order<string> = Order.mapInput(
	Order.Array(Order.Number),
	(text: string) =>
		Arr.map(Arr.fromIterable(text), (c) =>
			defined(Option.getOrUndefined(Str.codePointAt(0)(c)), "a code point")
		)
)

type NettingFeature =
	| "a fact two members of a stratum made present"
	| "a fact two members of a stratum made absent"
	| "a written relation no stratum changed"
	| "a repeated written relation"
	| "names out of code unit order"

describe("netting", () => {
	it.effect(
		"equals the oracle's netting of deltas and counts for every sequence of per-stratum changes",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/write/changeset/delta-5003",
						draw: drawn(sequences),
						literal: Formatter.format,
						coverage: required<NettingFeature>(
							[
								"a fact two members of a stratum made present",
								"a fact two members of a stratum made absent",
								"a written relation no stratum changed",
								"a repeated written relation",
								"names out of code unit order"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 1000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: { kind: "second-implementation", name: "the delta and count calculator" }
					},
					({ written, strata, relations }, c) =>
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
							const mine: Array<Map<string, StratumChange>> = Arr.makeBy(strata, () => new Map())
							const expected = Arr.map(sorted, (relation) => {
								const sequence = defined(
									relations[distinct.indexOf(relation)],
									"a relation's sequence"
								)
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
											Arr.filter([...d.added.keys()], (id) =>
												tagsOf(st.added, id).includes("insert")
											)
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
									assert.deepEqual(
										identitiesOf(netted[side].keys()),
										identitiesOf(oracle[side].keys())
									)
									assert.deepEqual(
										identitiesOf(netted[side].keys()),
										identitiesOf(whole[side].keys()),
										"the netted delta is the state difference"
									)
								}
								return { relation, ...oracleNetCounts(theirs) }
							})
							const counts = outcomeCounts(written, mine)
							assert.deepEqual(
								counts,
								expected,
								"one entry per written relation, in code point order"
							)
							assert.equal(outcomeKind(counts), oracleOutcomeKind(expected))
						})
				)
			)
	)
})

/** Every item, in a drawn order. */
const shuffledAll = <A>(items: ReadonlyArray<A>): Gen<ReadonlyArray<A>> =>
	shuffled(items, { min: items.length, max: items.length })

/** A bigserial relation's statements over stored facts whose identity sequence lags them. Ticket { id: bigserial key,
 * note }: the stored facts hold ids 1 to k, the last stored by a direct writer with an explicit value, so the sequence
 * sits at k, not yet called, unless it was advanced past them. The first stratum holds `delete Ticket [{id: k}]` beside
 * `insert Ticket [{note}]`, a generated addition: from a lagging sequence it draws the key the delete freed, and the
 * fact is then removed and added back, identical when its note is the stored one. Later strata delete present facts
 * and add generated ones, whose keys the sequence draws past every stored one. Each stratum's rows are those its
 * statements return: a DELETE's for the requested facts present, a generated INSERT's for every fact it made present. */
type TicketFact = { readonly id: bigint; readonly note: string }
const notes = ["x", "y"] as const
const laterStratum: Gen<{
	readonly deletes: ReadonlyArray<number>
	readonly generated: ReadonlyArray<string>
}> = (source) => ({
	deletes: source.draw(array(int(0, 5), { min: 0, max: 2 })),
	generated: source.draw(array(element(notes), { min: 0, max: 2 }))
})

/** Up to four stored facts and two later strata: enough for the planted pair beside other stored facts and for a later
 * stratum that deletes the fact the planted one added, or adds another. */
const laggingGen: Gen<{
	readonly stored: ReadonlyArray<string>
	readonly lagging: boolean
	readonly generatedNote: string
	readonly alsoDeleted: ReadonlyArray<number>
	readonly later: ReadonlyArray<{
		readonly deletes: ReadonlyArray<number>
		readonly generated: ReadonlyArray<string>
	}>
}> = (source) => ({
	stored: source.draw(array(element(notes), { min: 1, max: 4 })),
	lagging: source.draw(boolean),
	generatedNote: source.draw(element(notes)),
	alsoDeleted: source.draw(array(int(0, 3), { min: 0, max: 2 })),
	later: source.draw(array(laterStratum, { min: 0, max: 2 }))
})

type LaggingFeature =
	| "a fact removed and added back identical"
	| "a generated fact differing in its key"
	| "a generated fact differing in its note"

describe("a stratum's change is a set difference", () => {
	it.effect(
		"nets a fact a delete freed and a lagging sequence's generated addition drew back identical, and reports one differing as a removal and an addition",
		(ctx) =>
			Effect.gen(function* () {
				const ticket = compiled(Ledger, cs(Ledger)).schema.relations.get("Ticket")
				if (ticket === undefined) {
					throw new Error("Ticket")
				}
				const identity = relationIdentity(ticket.heading, codesOf(Ledger))
				const factSet = (facts: Iterable<Fact>): FactSet =>
					factSetOf(Arr.map([...facts], (f) => [identity(f), f] as const))
				yield* searched(
					ctx,
					explore(
						{
							oracle: { kind: "unstated" },
							suite: "unit/write/changeset/lagging-sequence",
							draw: drawn(laggingGen),
							literal: Formatter.format,
							coverage: required<LaggingFeature>(
								[
									"a fact removed and added back identical",
									"a generated fact differing in its key",
									"a generated fact differing in its note"
								],
								{ cases: 500, sense: notesOnly }
							),
							kept: [],
							runs: 500,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						({ stored, lagging, generatedNote, alsoDeleted, later }, c) =>
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
										deletes: () => [
											planted,
											...Arr.flatMap(alsoDeleted, (i) => start.slice(i, i + 1))
										],
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
								assert.deepEqual(
									identitiesOf(netted.added.keys()),
									identitiesOf(whole.added.keys())
								)
								assert.deepEqual(
									identitiesOf(netted.removed.keys()),
									identitiesOf(whole.removed.keys())
								)
								assert.deepEqual(
									identitiesOf(netted.added.keys()),
									identitiesOf(oracleNetStrata(deltas).added.keys())
								)
								assert.deepEqual(
									outcomeCounts(
										["Ticket"],
										Arr.map(mine, (change) => new Map([["Ticket", change]]))
									),
									[{ relation: "Ticket", ...oracleNetCounts(theirs) }]
								)
							})
					)
				)
			})
	)
})

describe("relation identity", () => {
	it.effect(
		"identifies a converted fact exactly as the boundary's fact identity identifies the same values",
		(ctx) =>
			Effect.gen(function* () {
				const frontend = compiled(Work, cs(Work))
				const note = frontend.schema.relations.get("TaskNote")
				if (note === undefined) {
					throw new Error("TaskNote")
				}
				const codes = codesOf(Work)
				const id = relationIdentity(note.heading, codes)
				const fields = Arr.map(note.heading, (c) => ({
					name: c.name,
					spec: scalarCodec(c.type, codes).spec
				}))
				yield* searched(
					ctx,
					explore(
						{
							oracle: { kind: "unstated" },
							suite: "unit/write/relation-identity",
							draw: drawn(
								(source) =>
									[
										source.draw(uuid(4)),
										source.draw(
											string(
												oneOf([
													codePoint(0x20, 0x7e),
													codePoint(0xa0, 0xd7_ff),
													codePoint(0xe0_00, 0x10_ffff)
												]),
												{ min: 0, max: 8 }
											)
										)
									] as const
							),
							literal: Formatter.format,
							coverage: noCoverage,
							kept: [],
							runs: 200,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						([task, text]) =>
							Effect.sync(() => {
								const written = { note: text, task }
								const admitted = factIdentity(fields, written)
								assert.deepEqual(admitted.ok ? admitted.value.identity : undefined, id(written))
							})
					)
				)
			})
	)
})
