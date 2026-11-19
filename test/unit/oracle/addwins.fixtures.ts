/** What the properties of addwins.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert, defined } from "@bjornpagen/testing/assert"
import {
	array,
	element,
	type Gen,
	int,
	map,
	oneOf,
	shuffled,
	subarray,
	subset
} from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter, Option, Record } from "effect"
import {
	type AddWinsOutcome,
	type AppliedOutcome,
	type Fact,
	factsOf
} from "#test/support/oracle/addwins.ts"
import { kinds, schema, sequenceOf, task } from "#test/unit/oracle/fixtures.ts"

type Op = "insert" | "delete" | "put"
export type TaskFact = ReturnType<typeof task>
/** A member of a layer: an operation and the facts it requests. */
export interface Member {
	readonly op: Op
	readonly facts: ReadonlyArray<TaskFact>
}

export const applied = (outcome: AddWinsOutcome): AppliedOutcome => {
	if (outcome.kind === "invariant-rejected") {
		throw new Error(`rejected with ${outcome.law}`)
	}
	return outcome
}

export const countsOf = (outcome: AddWinsOutcome, relation: string) => {
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
export const sameFacts = (a: ReadonlyArray<Fact>, b: ReadonlyArray<Fact>): void => {
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

export const build = (layers: ReadonlyArray<ReadonlyArray<Member>>) =>
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
export const reference = (
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
export const sameOutcome = (actual: AddWinsOutcome, expected: AddWinsOutcome): void => {
	assert.deepEqual(comparable(actual), comparable(expected))
	if (actual.kind !== "invariant-rejected" && expected.kind !== "invariant-rejected") {
		sameFacts(factsOf(actual.state, "Task"), factsOf(expected.state, "Task"))
	}
}

export type TransitionFeature = "applied" | "rejected" | "rejected before the last stratum"

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

export type OrderFeature =
	| "applied"
	| "rejected"
	| "a stratum of several members"
	| "a member of several facts"

export type PutFeature = "a put displacing an occupant" | "a put into an empty key"

const tally = (xs: Iterable<unknown>, x: unknown) =>
	BigInt(Arr.filter([...xs], (y) => y === x).length)

/**
 * An independent reference: per stratum, the facts it made present are counted under put when one of its put
 * members requested them and under insert otherwise, and the facts it made absent under delete when one of its
 * delete members requested them; walking the strata, a change that undoes a pending one of the same fact cancels it,
 * and the counts are the pending changes left at the end.
 */
export const referenceCounts = (
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
export const pooledCounts = (
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

/** The law the fixture names Task's primary key by. */
export const taskKey = Option.getOrThrowWith(
	Arr.findFirst(schema.relations, (r) => r.name === "Task"),
	() => new Error("the fixture's Task")
).primaryKey.law

/** A state and strata drawn over it. */
export const transitionGen: Gen<
	readonly [ReadonlyArray<TaskFact>, ReadonlyArray<ReadonlyArray<Member>>]
> = (source) => [source.draw(taskState), source.draw(strata)] as const

/** A state, strata, and the strata with each stratum's members permuted. */
export const buildOrderGen: Gen<
	readonly [
		ReadonlyArray<TaskFact>,
		ReadonlyArray<ReadonlyArray<Member>>,
		ReadonlyArray<ReadonlyArray<Member>>
	]
> = (source) => {
	const layers = source.draw(strata)
	return [source.draw(taskState), layers, source.draw(permutedGen(layers))] as const
}

/** A state and the facts of a put at distinct ids. */
export const putGen: Gen<readonly [ReadonlyArray<TaskFact>, ReadonlyArray<TaskFact>]> = (source) =>
	[source.draw(taskState), source.draw(atDistinctIds)] as const

/** The general strata over a state, or the dense family over its state. */
export const countsGen = oneOf<
	readonly [ReadonlyArray<TaskFact>, ReadonlyArray<ReadonlyArray<Member>>]
>([
	(source) => [source.draw(taskState), source.draw(strata)] as const,
	(source) => [source.draw(denseState), source.draw(denseStrata)] as const
])
