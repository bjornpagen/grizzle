/**
 * The add-wins calculator against independent references: it satisfies S' = (S minus D) union A per stratum with keys
 * checked after each stratum, build-order independence and put sugar, and counts each relation's changes netted over
 * the per-stratum changes.
 *
 * Same transition, so the same deltas; the counts attribute it to put.
 *
 * Given: each generated addition takes the given fact's values, past every stored value.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	element,
	type Gen,
	int,
	map,
	oneOf,
	subarray,
	uniqueArray
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record } from "effect"
import { assert, defined } from "#test/support/assert.ts"
import { wild } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	type AddWinsOutcome,
	type AppliedOutcome,
	applyAddWins,
	type Fact,
	factsOf,
	loadedSequences,
	OracleChangeSet,
	type OracleSchema,
	type OracleState,
	oracleState
} from "#test/support/oracle/addwins.ts"
import { kinds, schema, sequenceOf, task } from "#test/unit/oracle/fixtures.ts"

type Op = "insert" | "delete" | "put"
type TaskFact = ReturnType<typeof task>
/** A member of a layer: an operation and the facts it requests. */
interface Member {
	readonly op: Op
	readonly facts: ReadonlyArray<TaskFact>
}

const applied = (outcome: AddWinsOutcome): AppliedOutcome => {
	if (outcome.kind === "invariant-rejected") {
		throw new Error(`rejected with ${outcome.law}`)
	}
	return outcome
}

const countsOf = (outcome: AddWinsOutcome, relation: string) => {
	const c = Arr.findFirst(applied(outcome).counts, (entry) => entry.relation === relation)
	if (Option.isNone(c)) {
		throw new Error(`no counts for ${relation}`)
	}
	return { added: c.value.added, deleted: c.value.deleted, put: c.value.put }
}

/** One fact as another: the same fields, each holding the same scalar, whatever either record's prototype. */
const sameFact = (x: Fact, y: Fact): boolean => {
	const fields = Record.keys(x)
	return (
		fields.length === Record.keys(y).length &&
		Arr.every(fields, (f) => Record.has(y, f) && Object.is(x[f], y[f]))
	)
}

const within = (xs: ReadonlyArray<Fact>, ys: ReadonlyArray<Fact>) =>
	Arr.every(xs, (x) => Arr.some(ys, (y) => sameFact(x, y)))

/** Two states hold the same facts: every fact of each is a fact of the other. */
const sameFacts = (a: ReadonlyArray<Fact>, b: ReadonlyArray<Fact>): void => {
	assert.ok(
		within(a, b) && within(b, a),
		`${Formatter.format(a)} and ${Formatter.format(b)} hold other facts`
	)
}

/** Small-domain Task facts: id in 0..3, account in 0..1, kind a or b. */
const taskFact: Gen<TaskFact> = map(
	(source) => ({
		id: source.draw(int(0, 3)),
		account: source.draw(int(0, 1)),
		kind: source.draw(element(kinds))
	}),
	({ id, account: a, kind }) => task(id, a, kind)
)

/** A pk-consistent state: at most one fact per id. */
const taskState: Gen<ReadonlyArray<TaskFact>> = map(
	array(taskFact, { min: 0, max: 4 }),
	(facts) => {
		const byId = new Map<number, TaskFact>()
		for (const f of facts) {
			byId.set(f.id, f)
		}
		return [...byId.values()]
	}
)

const member: Gen<Member> = (source) => ({
	op: source.draw(element<Op>(["insert", "delete", "put"])),
	facts: source.draw(array(taskFact, { min: 0, max: 3 }))
})

const strata = array(array(member, { min: 0, max: 4 }), { min: 1, max: 3 })

const build = (layers: ReadonlyArray<ReadonlyArray<Member>>) =>
	sequenceOf(layers, (c, m) => c[m.op]("Task", m.facts))

const key = (f: TaskFact) => `${f.id}|${f.account}|${f.kind}`
/** The same key of a fact the calculator returns, whose fields it does not type. */
const factKey = (f: Fact) => `${String(f["id"])}|${String(f["account"])}|${String(f["kind"])}`

/** The definition's outcome: the final state, or the stratum whose S' first has two facts at one id. */
type ReferenceOutcome =
	| { readonly kind: "applied"; readonly state: ReadonlyArray<TaskFact> }
	| { readonly kind: "rejected"; readonly stratum: number }

/**
 * The definition, written out independently of the calculator: per stratum A = inserts ∪ puts, D = deletes ∪ the
 * occupants at the puts' keys, S' = (S \ D) ∪ A, rejected when two facts of S' share an id.
 */
const reference = (
	initial: ReadonlyArray<TaskFact>,
	layers: ReadonlyArray<ReadonlyArray<Member>>
): ReferenceOutcome => {
	let s = new Map(Arr.map(initial, (f) => [key(f), f]))
	for (const [i, members] of layers.entries()) {
		const of = (op: Op) => {
			const requested = Arr.filter(members, (m) => m.op === op)
			return Arr.flatMap(requested, (m) => m.facts)
		}
		const puts = of("put")
		const a = [...of("insert"), ...puts]
		const putIds = new Set(Arr.map(puts, (f) => f.id))
		const replaced = Arr.filter([...s.values()], (f) => putIds.has(f.id))
		const d = new Set([...Arr.map(of("delete"), key), ...Arr.map(replaced, key)])
		const next = new Map(Arr.filter([...s], ([k]) => !d.has(k)))
		for (const f of a) {
			next.set(key(f), f)
		}
		const ids = Arr.map([...next.values()], (f) => f.id)
		if (new Set(ids).size !== ids.length) {
			return { kind: "rejected", stratum: i }
		}
		s = next
	}
	return { kind: "applied", state: [...s.values()] }
}

const comparable = (outcome: AddWinsOutcome) =>
	outcome.kind === "invariant-rejected"
		? { kind: outcome.kind, law: outcome.law, stratum: outcome.stratum }
		: { kind: outcome.kind, counts: outcome.counts }

/** Two outcomes agree: one refusal, or one kind and counts and the same Task facts in any order. */
const sameOutcome = (actual: AddWinsOutcome, expected: AddWinsOutcome): void => {
	assert.deepEqual(comparable(actual), comparable(expected))
	if (actual.kind !== "invariant-rejected" && expected.kind !== "invariant-rejected") {
		sameFacts(factsOf(actual.state, "Task"), factsOf(expected.state, "Task"))
	}
}

describe("the add-wins transition", () => {
	it.effect("is S' = (S \\ D) ∪ A per stratum, with keys checked after each stratum", (ctx) =>
		Effect.gen(function* () {
			/** The law the fixture names Task's primary key by. */
			const taskKey = Option.getOrThrowWith(
				Arr.findFirst(schema.relations, (r) => r.name === "Task"),
				() => new Error("the fixture's Task")
			).primaryKey.law
			yield* searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/oracle/addwins-24932",
						draw: drawn((source) => [source.draw(taskState), source.draw(strata)] as const),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 2000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([initial, layers]) =>
						Effect.sync(() => {
							const outcome = applyAddWins(
								schema,
								oracleState(schema, { Task: initial }, loadedSequences),
								build(layers),
								{ kind: "sequences" }
							)
							const expected = reference(initial, layers)
							if (expected.kind === "rejected") {
								assert.ok(outcome.kind === "invariant-rejected", "the reference rejects")
								assert.equal(outcome.law, taskKey)
								assert.equal(outcome.stratum, expected.stratum)
							} else {
								sameFacts(factsOf(applied(outcome).state, "Task"), expected.state)
							}
						})
				)
			)
		})
	)
})

/** The items ranked by the drawn order, which holds at least one rank, cycled; ties keep their place. */
const shuffled = <A>(items: ReadonlyArray<A>, order: ReadonlyArray<number>): ReadonlyArray<A> =>
	Arr.map(
		Arr.sort(
			Arr.map(
				items,
				(item, i) => [defined(order[i % order.length], "a drawn rank"), i, item] as const
			),
			Order.combine(
				Order.mapInput(Order.Number, ([rank]: readonly [number, number, A]) => rank),
				Order.mapInput(Order.Number, ([, i]: readonly [number, number, A]) => i)
			)
		),
		([, , item]) => item
	)

describe("build-order independence", () => {
	it.effect("does not depend on member order, member splitting, or how strata are unioned", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: { kind: "unstated" },
					suite: "unit/oracle/addwins-28530",
					draw: drawn(
						(source) =>
							[
								source.draw(taskState),
								source.draw(strata),
								source.draw(array(int(0, 2 ** 31 - 1), { min: 1, max: 8 }))
							] as const
					),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 1000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				([initial, layers, order]) =>
					Effect.sync(() => {
						const s = oracleState(schema, { Task: initial }, loadedSequences)
						const base = applyAddWins(schema, s, build(layers), { kind: "sequences" })
						/** Members permuted within each stratum. */
						const permuted = Arr.map(layers, (members) => shuffled(members, order))
						sameOutcome(applyAddWins(schema, s, build(permuted), { kind: "sequences" }), base)
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
						sameOutcome(applyAddWins(schema, s, build(split), { kind: "sequences" }), base)
						/** The same strata built as the union of two sequences, position by position, in either order. */
						const halves = [
							Arr.map(layers, (members) =>
								Arr.flatMap(members, (m, i) => (i % 2 === 0 ? [m] : []))
							),
							Arr.map(layers, (members) => Arr.flatMap(members, (m, i) => (i % 2 === 1 ? [m] : [])))
						] as const
						const [left, right] = [build(halves[0]), build(halves[1])]
						sameOutcome(
							applyAddWins(schema, s, OracleChangeSet.union(left, right), { kind: "sequences" }),
							base
						)
						sameOutcome(
							applyAddWins(schema, s, OracleChangeSet.union(right, left), { kind: "sequences" }),
							base
						)
					})
			)
		)
	)
})

describe("put", () => {
	it.effect(
		"is sugar for a described deletion of the occupants at its keys plus an insertion",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/oracle/addwins-28789",
						draw: drawn(
							(source) =>
								[source.draw(taskState), source.draw(array(taskFact, { min: 0, max: 4 }))] as const
						),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 1000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([initial, raw]) =>
						Effect.sync(() => {
							const byId = new Map<number, TaskFact>()
							for (const f of raw) {
								byId.set(f.id, f)
							}
							const facts = [...byId.values()]
							const s = oracleState(schema, { Task: initial }, loadedSequences)
							const viaPut = applied(
								applyAddWins(schema, s, OracleChangeSet.empty().put("Task", facts), {
									kind: "sequences"
								})
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
									OracleChangeSet.empty().delete("Task", occupants).insert("Task", facts),
									{
										kind: "sequences"
									}
								)
							)
							sameFacts(factsOf(viaPut.state, "Task"), factsOf(viaSugar.state, "Task"))
							assert.deepEqual(viaPut.delta, viaSugar.delta)
							const sugar = countsOf(viaSugar, "Task")
							const put = countsOf(viaPut, "Task")
							assert.equal(put.put, sugar.added)
							assert.equal(put.added, 0n)
							assert.equal(put.deleted, 0n)
						})
				)
			)
	)
})

const tally = (xs: Iterable<unknown>, x: unknown) =>
	BigInt(Arr.filter([...xs], (y) => y === x).length)

describe("counts across strata, netted over the per-stratum changes", () => {
	/**
	 * An independent reference: per stratum, the facts it made present are counted under put when one of its put
	 * members requested them and under insert otherwise, and the facts it made absent under delete when one of its
	 * delete members requested them; walking the strata, a change that undoes a pending one of the same fact cancels it,
	 * and the counts are the pending changes left at the end.
	 */
	const referenceCounts = (
		initial: ReadonlyArray<TaskFact>,
		layers: ReadonlyArray<ReadonlyArray<Member>>
	) => {
		let s = new Map(Arr.map(initial, (f) => [key(f), f]))
		const pendingAdd = new Map<string, "added" | "put">()
		const pendingRemove = new Map<string, boolean>()
		for (const members of layers) {
			const of = (op: Op) => {
				const requested = Arr.filter(members, (m) => m.op === op)
				return new Set(Arr.flatMap(requested, (m) => Arr.map(m.facts, key)))
			}
			const [puts, deletes] = [of("put"), of("delete")]
			const putMembers = Arr.filter(members, (m) => m.op === "put")
			const putIds = new Set(Arr.flatMap(putMembers, (m) => Arr.map(m.facts, (f) => f.id)))
			const next = new Map(Arr.filter([...s], ([k, f]) => !deletes.has(k) && !putIds.has(f.id)))
			const adding = Arr.filter(members, (m) => m.op !== "delete")
			for (const f of Arr.flatMap(adding, (m) => m.facts)) {
				next.set(key(f), f)
			}
			for (const k of Arr.filter([...s.keys()], (removed) => !next.has(removed))) {
				if (pendingAdd.has(k)) {
					pendingAdd.delete(k)
				} else {
					pendingRemove.set(k, deletes.has(k))
				}
			}
			for (const k of Arr.filter([...next.keys()], (made) => !s.has(made))) {
				if (pendingRemove.has(k)) {
					pendingRemove.delete(k)
				} else {
					pendingAdd.set(k, puts.has(k) ? "put" : "added")
				}
			}
			s = next
		}
		return {
			added: tally(pendingAdd.values(), "added"),
			deleted: tally(pendingRemove.values(), true),
			put: tally(pendingAdd.values(), "put")
		}
	}

	/**
	 * The count rules read once over the whole sequence, with the requests of every stratum pooled: what the
	 * calculator computed before it attributed changes per stratum. Used only to show the property reaches the cases
	 * where the two readings differ.
	 */
	const pooledCounts = (
		initial: ReadonlyArray<TaskFact>,
		final: ReadonlyArray<Fact>,
		layers: ReadonlyArray<ReadonlyArray<Member>>
	) => {
		const before = new Set(Arr.map(initial, key))
		const after = new Set(Arr.map(final, factKey))
		const of = (op: Op) =>
			new Set(Arr.flatMap(layers.flat(), (m) => (m.op === op ? Arr.map(m.facts, key) : [])))
		const [inserts, puts, deletes] = [of("insert"), of("put"), of("delete")]
		const made = Arr.filter([...after], (k) => !before.has(k))
		const gone = Arr.filter([...before], (k) => !after.has(k))
		return {
			added: BigInt(Arr.filter(made, (k) => !puts.has(k) && inserts.has(k)).length),
			deleted: BigInt(Arr.filter(gone, (k) => deletes.has(k)).length),
			put: BigInt(Arr.filter(made, (k) => puts.has(k)).length)
		}
	}

	/**
	 * Besides the general strata, a dense family over two ids and two payloads with one fact per member and up to four
	 * strata, where facts are often put, deleted and added back across strata.
	 */
	const denseFact: Gen<TaskFact> = map(
		(source) => ({ id: source.draw(int(0, 1)), account: source.draw(int(0, 1)) }),
		({ id, account: a }) => task(id, a, "a")
	)
	const denseState = subarray([task(0, 0, "a"), task(1, 1, "a")])
	const denseStrata = array(
		array(
			(source): Member => ({
				op: source.draw(element<Op>(["insert", "delete", "put"])),
				facts: source.draw(array(denseFact, { min: 0, max: 1 }))
			}),
			{ min: 1, max: 2 }
		),
		{ min: 2, max: 4 }
	)

	it.effect(
		"agrees with the per-stratum netting reference on every accepted or no-change sequence",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/oracle/addwins-6516340",
						draw: drawn(
							oneOf<readonly [ReadonlyArray<TaskFact>, ReadonlyArray<ReadonlyArray<Member>>]>([
								(source) => [source.draw(taskState), source.draw(strata)] as const,
								(source) => [source.draw(denseState), source.draw(denseStrata)] as const
							])
						),
						literal: Formatter.format,
						coverage: required<"multi-stratum" | "differs from pooled">(
							["multi-stratum", "differs from pooled"],
							{ cases: 4000, sense: notesOnly }
						),
						kept: [],
						runs: 4000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([initial, layers], c) =>
						Effect.sync(() => {
							const outcome = applyAddWins(
								schema,
								oracleState(schema, { Task: initial }, loadedSequences),
								build(layers),
								{ kind: "sequences" }
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
						})
				)
			)
	)
})

const entry = (code: number, n: number) => ({ code, n })

describe("generated additions", () => {
	/** Entry(code, n), keyed by code, n an identity column outside the key. */
	const entries: OracleSchema = {
		relations: [
			{
				name: "Entry",
				heading: [
					{ name: "code", spec: { carrier: "int4" } },
					{ name: "n", spec: { carrier: "int4" } }
				],
				primaryKey: { law: wild.lawId("entry_pk"), fields: ["code"] },
				keys: [],
				projectedKeys: [],
				serial: ["n"]
			}
		]
	}
	/**
	 * Stored entries with small values, one per code, the sequence standing at one of them and possibly never called
	 * (behind the stored values, where a direct writer leaves it), a deletion of some of them and generated additions of
	 * small codes.
	 */
	/** One stored entry: its code and the value of its identity column. */
	type Stored = { readonly code: number; readonly n: number }
	const caseGen: Gen<{
		readonly stored: ReadonlyArray<Stored>
		readonly at: number
		readonly called: boolean
		readonly deleted: ReadonlyArray<number>
		readonly codes: ReadonlyArray<number>
	}> = (source) => ({
		stored: source.draw(
			uniqueArray(
				(source): Stored => ({ code: source.draw(int(0, 2)), n: source.draw(int(1, 3)) }),
				(e) => e.code,
				{ min: 0, max: 3 },
				20
			)
		),
		at: source.draw(int(1, 3)),
		called: source.draw(boolean),
		deleted: source.draw(array(int(0, 2 ** 31 - 1), { min: 0, max: 2 })),
		codes: source.draw(uniqueArray(int(0, 3), (item) => item, { min: 1, max: 2 }, 20))
	})
	type Feature =
		| "a kept fact holding the next draw at a generated code"
		| "a generated addition at a kept key"
		| "given draws"

	it.effect(
		"stand for a kept fact at the key they state, draw past every fact of the state they join, or take the values given",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/oracle/addwins-generated",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a kept fact holding the next draw at a generated code",
								"a generated addition at a kept key",
								"given draws"
							],
							{ cases: 1000, sense: notesOnly }
						),
						kept: [],
						runs: 1000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ stored, at, called, deleted, codes }, c) =>
						Effect.sync(() => {
							const initial = oracleState(
								entries,
								{ Entry: Arr.map(stored, (e) => entry(e.code, e.n)) },
								{ "Entry.n": { lastValue: BigInt(at), isCalled: called } }
							)
							const removed = Arr.flatMap(deleted, (i) =>
								stored.length === 0 ? [] : [defined(stored[i % stored.length])]
							)
							const changes = OracleChangeSet.empty()
								.delete("Entry", removed)
								.insert(
									"Entry",
									Arr.map(codes, (code) => ({ code }))
								)
							const kept = Arr.filter(stored, (e) => !removed.includes(e))
							/** The first value the sequence would draw, which a kept fact of that code may hold. */
							const first = called ? at + 1 : at
							if (Arr.some(kept, (e) => codes.includes(e.code) && e.n === first)) {
								c.note("a kept fact holding the next draw at a generated code")
							}
							/**
							 * Drawn from the sequences: a generated addition at a kept fact's code agrees with it at every field it
							 * states, its code, so the kept fact stands for it and it draws nothing (insert/unique.ts
							 * generatedArbiter); any other adds a fact under a value no fact holds, before the stratum or after, and
							 * re-creates no stored fact.
							 */
							const drawnOutcome = applyAddWins(entries, initial, changes, { kind: "sequences" })
							if (drawnOutcome.kind !== "invariant-rejected") {
								for (const id of defined(drawnOutcome.generated.get("Entry"))) {
									assert.ok(
										initial.relations.get("Entry")?.has(id) !== true,
										"a drawn generated fact re-creates a stored one"
									)
								}
							}
							if (Arr.some(kept, (e) => codes.includes(e.code))) {
								c.note("a generated addition at a kept key")
								const state = applied(drawnOutcome).state
								for (const e of kept) {
									assert.ok(
										Arr.some(
											factsOf(state, "Entry"),
											(f) => f["code"] === e.code && f["n"] === e.n
										),
										`the kept entry ${Formatter.format(e)} stands for its code's generated addition, unchanged`
									)
								}
								assert.equal(
									factsOf(state, "Entry").length,
									kept.length +
										Arr.filter(codes, (code) => !Arr.some(kept, (e) => e.code === code)).length,
									"a generated addition adds a fact only at a code no kept entry holds"
								)
								return
							}
							c.note("given draws")
							const given = Arr.map(codes, (code, i) => entry(code, 100 + i))
							const outcome = applied(
								applyAddWins(entries, initial, changes, {
									kind: "given",
									facts: new Map([["Entry", given]])
								})
							)
							const made = Arr.map([...defined(outcome.generated.get("Entry"))], (id) =>
								defined(
									outcome.state.relations.get("Entry")?.get(id),
									"a generated fact of the final state"
								)
							)
							sameFacts(made, given)
						})
				)
			)
	)
})
