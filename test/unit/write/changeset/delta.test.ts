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
	string,
	subarray
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { uuid } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import { factIdentity } from "#compiler/scalar/values/identity.ts"
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
	type FactSet,
	netCounts as oracleNetCounts,
	netStrata as oracleNetStrata,
	stateDelta
} from "#test/support/oracle/delta.ts"
import { compiled, cs, Ledger } from "#test/unit/write/changeset/fixtures.ts"

/** Deltas and counts netted across strata, checked against the
 * test oracle's definitions over every sequence of per-stratum changes, and over the
 * rows a bigserial relation's statements return when its identity sequence lags the stored values. */
const fact = (id: string): Fact => ({ id })

/** A random sequence of states over a small universe, each step attributed as the realization would report it. */
const universe = ["a", "b", "c", "d"]

/** One step of a sequence: the state after it, and how the realization attributes each fact's addition and removal. */
interface Step {
	readonly after: ReadonlyArray<string>
	readonly added: ReadonlyArray<"insert" | "put">
	readonly removed: ReadonlyArray<"delete" | "displaced">
}

const step: Gen<Step> = (source) => ({
	after: source.draw(subarray(universe)),
	added: source.draw(array(element(["insert", "put"] as const), { min: 4, max: 4 })),
	removed: source.draw(array(element(["delete", "displaced"] as const), { min: 4, max: 4 }))
})

const sequences: Gen<{
	readonly start: ReadonlyArray<string>
	readonly steps: ReadonlyArray<Step>
}> = (source) => ({
	start: source.draw(subarray(universe)),
	steps: source.draw(array(step, { min: 0, max: 6 }))
})

const setOf = (ids: ReadonlyArray<string>): FactSet => new Map(Arr.map(ids, (id) => [id, fact(id)]))
/** The attribution a step gives a fact of the universe: one tag per fact, by position. */
const tagOf = <T>(tags: ReadonlyArray<T>, id: string): T => {
	const tag = tags[universe.indexOf(id)]
	if (tag === undefined) {
		throw new Error(`no tag for ${id}`)
	}
	return tag
}

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
						coverage: noCoverage,
						kept: [],
						runs: 1000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ start, steps }) =>
						Effect.sync(() => {
							let before = setOf(start)
							const mine: Array<StratumChange> = []
							const theirs: Array<AttributedChange> = []
							const deltas = []
							for (const s of steps) {
								const after = setOf(s.after)
								const d = stateDelta(before, after)
								deltas.push(d)
								const rows: Array<ChangeRow> = [
									...Arr.map([...d.added.keys()], (id): ChangeRow => ({
										side: "added",
										identity: id,
										fact: fact(id),
										tag: tagOf(s.added, id)
									})),
									...Arr.map([...d.removed.keys()], (id): ChangeRow => ({
										side: "removed",
										identity: id,
										fact: fact(id),
										tag: tagOf(s.removed, id)
									}))
								]
								const change = stratumChange(rows)
								mine.push(change)
								theirs.push({
									added: new Map(Arr.map([...change.added], ([id, row]) => [id, row.tag])),
									removed: new Map(Arr.map([...change.removed], ([id, row]) => [id, row.tag]))
								})
								before = after
							}
							const netted = netStrata(mine)
							const oracle = oracleNetStrata(deltas)
							assert.deepEqual(
								Arr.sort([...netted.added.keys()], Order.String),
								Arr.sort([...oracle.added.keys()], Order.String)
							)
							assert.deepEqual(
								Arr.sort([...netted.removed.keys()], Order.String),
								Arr.sort([...oracle.removed.keys()], Order.String)
							)
							/** And the netted delta is the state difference. */
							const whole = stateDelta(setOf(start), before)
							assert.deepEqual(
								Arr.sort([...netted.added.keys()], Order.String),
								Arr.sort([...whole.added.keys()], Order.String)
							)
							assert.deepEqual(netted.counts, oracleNetCounts(theirs))
						})
				)
			)
	)

	it("counts a fact an insert and a put both made present once, under put, within a stratum", () => {
		const change = stratumChange([
			{ side: "added", identity: "a", fact: fact("a"), tag: "insert" },
			{ side: "added", identity: "a", fact: fact("a"), tag: "put" },
			{ side: "removed", identity: "b", fact: fact("b"), tag: "displaced" },
			{ side: "removed", identity: "b", fact: fact("b"), tag: "delete" }
		])
		assert.deepEqual(netStrata([change]).counts, { added: 0n, deleted: 1n, put: 1n })
	})
})

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
				const identity = relationIdentity(ticket.heading)
				const factSet = (facts: Iterable<Fact>): FactSet =>
					new Map(Arr.map([...facts], (f) => [identity(f), f]))
				yield* searched(
					ctx,
					explore(
						{
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
									const after = new Map(
										Arr.filter([...state], ([id]) => !deleted.has(id)).concat([...added])
									)
									const delta = stateDelta(state, after)
									assert.deepEqual(
										Arr.sort([...change.added.keys()], Order.String),
										Arr.sort([...delta.added.keys()], Order.String),
										`stratum ${s} added`
									)
									assert.deepEqual(
										Arr.sort([...change.removed.keys()], Order.String),
										Arr.sort([...delta.removed.keys()], Order.String),
										`stratum ${s} removed`
									)
									if (s === 0) {
										const old = identity(planted)
										const drawnBack = identity({ id: lagging ? k : k + 1n, note: generatedNote })
										const identical = old === drawnBack
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
											insert: new Set(added.keys()),
											put: new Set(),
											delete: new Set(deleted.keys())
										})
									)
									deltas.push(delta)
									state = after
								}
								const netted = netStrata(mine)
								const whole = stateDelta(factSet(start), state)
								assert.deepEqual(
									Arr.sort([...netted.added.keys()], Order.String),
									Arr.sort([...whole.added.keys()], Order.String)
								)
								assert.deepEqual(
									Arr.sort([...netted.removed.keys()], Order.String),
									Arr.sort([...whole.removed.keys()], Order.String)
								)
								assert.deepEqual(
									Arr.sort([...netted.added.keys()], Order.String),
									Arr.sort([...oracleNetStrata(deltas).added.keys()], Order.String)
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

describe("outcome counts", () => {
	it("has one entry per written relation, in code point order, zero where nothing changed", () => {
		const s = new Map([
			["b", stratumChange([{ side: "added", identity: "1", fact: fact("1"), tag: "insert" }])]
		])
		assert.deepEqual(outcomeCounts(["b", "a", "b"], [s]), [
			{ relation: "a", added: 0n, deleted: 0n, put: 0n },
			{ relation: "b", added: 1n, deleted: 0n, put: 0n }
		])
		assert.equal(outcomeKind(outcomeCounts(["b"], [s])), "accepted")
	})
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
				const id = relationIdentity(note.heading)
				const fields = Arr.map(note.heading, (c) => ({
					name: c.name,
					spec: scalarCodec(c.type).spec
				}))
				yield* searched(
					ctx,
					explore(
						{
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
								assert.equal(admitted.ok && admitted.value.identity, id(written))
							})
					)
				)
			})
	)
})
