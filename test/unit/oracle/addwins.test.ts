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
 * - Generated additions: one at a kept fact's key stands for it and draws nothing; any other draws past every fact of
 *   the state before or after; given draws take the values given. Oracle: the specification.
 *
 * Features: applied and rejected outcomes, a rejection before the last stratum; a stratum of several members and a
 * member of several facts; a put displacing an occupant and one into an empty key; multi-stratum counts and counts
 * that differ from the pooled reading; and each generated addition's case.
 *
 * Plants (~/.cache/grizzle-release/BR07/plants): addwins-keys-at-end.patch (keys checked only after the last stratum)
 * turns the transition red; addwins-delete-cancels-insert.patch (a later delete member cancelling an earlier insert of
 * the stratum) build-order independence; addwins-put-keeps-occupant.patch (a put displacing nothing) put sugar;
 * addwins-put-counted-added.patch (puts counted as additions) the counts; addwins-draw-recreates.patch (a draw allowed
 * to re-create a deleted stored fact) the generated additions.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import {
	array,
	boolean,
	element,
	type Gen,
	int,
	map,
	oneOf,
	shuffled,
	subarray,
	subset
} from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Record } from "effect"
import { indices } from "#compiler/core/array.ts"
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

/** The Task ids a fact holds. */
const taskIds: ReadonlyArray<number> = indices(4)

/** The Task fact at `id`: account 0 or 1, kind a or b. */
const taskAt =
	(id: number): Gen<TaskFact> =>
	(source) =>
		task(id, source.draw(int(0, 1)), source.draw(element(kinds)))

/** Small-domain Task facts: id in 0..3, account in 0..1, kind a or b. */
const taskFact: Gen<TaskFact> = (source) => source.draw(taskAt(source.draw(int(0, 3))))

/** Facts at distinct ids, a state's or a put's: a subset of the ids, each with its fact. */
const atDistinctIds: Gen<ReadonlyArray<TaskFact>> = (source) =>
	Arr.map(source.draw(subset(taskIds, { min: 0, max: taskIds.length })), (id) =>
		source.draw(taskAt(id))
	)

/** A pk-consistent state: at most one fact per id, by construction. */
const taskState: Gen<ReadonlyArray<TaskFact>> = atDistinctIds

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

type TransitionFeature = "applied" | "rejected" | "rejected before the last stratum"

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
						oracle: {
							kind: "second-implementation",
							name: "the definition S' = (S \\ D) ∪ A per stratum, written out apart, keys checked after each"
						},
						suite: "unit/oracle/addwins-transition",
						draw: drawn((source) => [source.draw(taskState), source.draw(strata)] as const),
						literal: Formatter.format,
						coverage: required<TransitionFeature>(
							["applied", "rejected", "rejected before the last stratum"],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 2000,
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
						})
				)
			)
		})
	)
})

/** Each stratum's members in a drawn order: a permutation of its members, drawn whole. */
const permutedGen =
	(layers: ReadonlyArray<ReadonlyArray<Member>>): Gen<ReadonlyArray<ReadonlyArray<Member>>> =>
	(source) =>
		Arr.map(layers, (members) =>
			Arr.map(
				source.draw(
					shuffled(indices(members.length), { min: members.length, max: members.length })
				),
				(i) => defined(members[i], "a member of the stratum")
			)
		)

type OrderFeature =
	| "applied"
	| "rejected"
	| "a stratum of several members"
	| "a member of several facts"

describe("build-order independence", () => {
	it.effect("does not depend on member order, member splitting, or how strata are unioned", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "universal",
						name: "the outcome is unchanged by member order, member splitting and how strata are unioned"
					},
					suite: "unit/oracle/addwins-build-order",
					draw: drawn((source) => {
						const layers = source.draw(strata)
						return [source.draw(taskState), layers, source.draw(permutedGen(layers))] as const
					}),
					literal: Formatter.format,
					coverage: required<OrderFeature>(
						["applied", "rejected", "a stratum of several members", "a member of several facts"],
						{ cases: 200, sense: notesOnly }
					),
					kept: [],
					runs: 1000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				([initial, layers, permuted], c) =>
					Effect.sync(() => {
						const s = oracleState(schema, { Task: initial }, loadedSequences)
						const base = applyAddWins(schema, s, build(layers), { kind: "sequences" })
						c.note(base.kind === "invariant-rejected" ? "rejected" : "applied")
						if (Arr.some(layers, (members) => members.length > 1)) {
							c.note("a stratum of several members")
						}
						if (Arr.some(layers, (members) => Arr.some(members, (m) => m.facts.length > 1))) {
							c.note("a member of several facts")
						}
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

type PutFeature = "a put displacing an occupant" | "a put into an empty key"

describe("put", () => {
	it.effect(
		"is sugar for a described deletion of the occupants at its keys plus an insertion",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "put is a described deletion of the occupants at its keys plus an insertion, counted as put"
						},
						suite: "unit/oracle/addwins-put",
						draw: drawn((source) => [source.draw(taskState), source.draw(atDistinctIds)] as const),
						literal: Formatter.format,
						coverage: required<PutFeature>(
							["a put displacing an occupant", "a put into an empty key"],
							{ cases: 100, sense: notesOnly }
						),
						kept: [],
						runs: 1000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([initial, facts], c) =>
						Effect.sync(() => {
							const held = new Set(Arr.map(initial, (f) => f.id))
							for (const f of facts) {
								c.note(held.has(f.id) ? "a put displacing an occupant" : "a put into an empty key")
							}
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
						oracle: {
							kind: "second-implementation",
							name: "the per-stratum netting reference, written out apart"
						},
						suite: "unit/oracle/addwins-counts",
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
		stored: Arr.map(source.draw(subset(indices(3), { min: 0, max: 3 })), (code): Stored => ({
			code,
			n: source.draw(int(1, 3))
		})),
		at: source.draw(int(1, 3)),
		called: source.draw(boolean),
		deleted: source.draw(array(int(0, 2 ** 31 - 1), { min: 0, max: 2 })),
		codes: source.draw(shuffled(indices(4), { min: 1, max: 2 }))
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
						oracle: {
							kind: "specification",
							name: "a generated addition stands for a kept fact at its key, draws past every fact, or takes the given values"
						},
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
