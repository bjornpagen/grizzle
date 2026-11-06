/**
 * The history checker against a naive enumerator, over generated histories of two or three operations on one keyed
 * relation.
 *
 * The checker is itself an oracle, so its failure modes are silent: accepting a history no serial order explains (a
 * vacuous oracle), refusing one some order does (a false alarm in every suite that uses it), or letting an abort pass
 * that nothing in the history explains. The enumerator here states the same contract with no pruning and no
 * memoization. Every writer runs SERIALIZABLE, and the contract is:
 *
 * - the committed state holds the key;
 * - every abort, and every discarded attempt of a grizzle operation, has an operation overlapping it in real time, and
 *   a cause a concurrent transaction gives: a direct writer's 40001 or 40P01, a discarded attempt's TransientFailure of
 *   a concurrent reason (never StaleStatement nor GeneratedSerialUnique). Only a direct writer aborts: a grizzle writer
 *   calls again after each TransientFailure until a call answers;
 * - some order of the committed operations that respects real time replays each through its writer's model, each
 *   committing there (a grizzle no-change exactly no-change), and ends at the committed state;
 * - each refusal has such an order of the committed operations and itself, in which the model refuses it at its place
 *   with its law, and its witness names the violating fact's key: grizzle's always, a direct writer's never, since
 *   PostgreSQL states a native key's violation in prose. A direct writer's key refusal is also explained where an
 *   operation after it in the order, overlapping it in real time, inserted at the key a fact its place does not hold:
 *   an occupant committed after its snapshot, which PostgreSQL's key check meets whatever the snapshot.
 *
 * The box is defined by its bounds: facts of Worker(id, name) with an id of 1 or 2 and a name of a or b; a lawful
 * initial state; each operation an insertion or a deletion of one fact, by a grizzle writer or a direct one, over an
 * interval of a clock of seven ticks; each outcome its writer can report, with each discarded attempt's reason of
 * either kind, and each refusal's witness the written fact's key, a key outside the box, or none; and the committed
 * state any set of the box's facts, one breaking the key among them, or the state some order of the operations reaches.
 */

import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, map, oneOf, shuffled, subarray } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import type { TransientTag } from "#compiler/core/errors.ts"
import { assert } from "#test/support/assert.ts"
import {
	checkHistory,
	type History,
	type Outcome,
	type Recorded,
	type Settled
} from "#test/support/history/check.ts"
import { expectFor, type WriterKind } from "#test/support/history/model.ts"
import { wild } from "#test/support/kernel/naming.ts"
import {
	everyFact,
	type HostFact,
	type HostOp,
	type HostRelation,
	type HostSchema,
	type HostState,
	valueText
} from "#test/support/laws/model.ts"
import { caseHang } from "#test/support/limits.ts"

/** The host model's own label for its one law, never compared with a production name. */
const law = wild.lawId("the Worker key")

const worker: HostRelation = {
	name: "Worker",
	table: "worker",
	fields: [
		{ name: "id", column: "id" },
		{ name: "name", column: "name" }
	],
	key: ["id"],
	mutable: false
}

const host: HostSchema = {
	relations: [worker],
	laws: [{ kind: "key", law, relation: "Worker", fields: ["id"], selection: everyFact }]
}

/** The box's ids and names. */
const ids = [1, 2] as const
const names = ["a", "b"] as const

const factGen: Gen<HostFact> = (source) => ({
	id: source.draw(element(ids)),
	name: source.draw(element(names))
})

/** Every fact of the box. */
const boxFacts: ReadonlyArray<HostFact> = Arr.flatMap(ids, (id) =>
	Arr.map(names, (name): HostFact => ({ id, name }))
)

const workers = (facts: ReadonlyArray<HostFact>): HostState => new Map([["Worker", facts]])
const factText = (f: HostFact): string => `${valueText(f["id"] ?? "")}${valueText(f["name"] ?? "")}`
const stateKey = (s: HostState): string =>
	Arr.join(Arr.sort(Arr.map(s.get("Worker") ?? [], factText), Order.String), ",")

/** A lawful state of the box: each id with no fact or one of its names. */
const lawfulGen: Gen<HostState> = (source) =>
	workers(
		Arr.flatMap(ids, (id) => {
			const name = source.draw(element([undefined, ...names] as const))
			return name === undefined ? [] : [{ id, name }]
		})
	)

const opGen: Gen<HostOp> = (source) => ({
	relation: "Worker",
	kind: source.draw(element(["insert", "delete"] as const)),
	facts: [source.draw(factGen)]
})

/**
 * The TransientFailure reasons a discarded attempt is drawn with: the concurrent ones a write of a law family meets,
 * and the ones no concurrent transaction causes, which nothing explains.
 */
const discardReasons: ReadonlyArray<TransientTag> & Readonly<{ 0: TransientTag }> = [
	"SerializationFailure",
	"Deadlock",
	"UnseenOccupant",
	"StaleStatement",
	"GeneratedSerialUnique"
]

/** A refusal's witness: the key of the fact the operation writes, a key outside the box, or none. */
type WitnessShape = "written" | "outside" | "none"

/** A key no fact of the box holds. */
const outsideKey = [{ relation: "Worker", values: { id: 3 } }]

/** The witness its writer gives a refusal: grizzle names the written fact by its key, a direct writer nothing. */
const witnessOf = (kind: WriterKind, written: ReadonlyArray<HostOp>) =>
	kind === "grizzle"
		? Arr.map(
				Arr.flatMap(written, (o) => o.facts),
				(f) => ({ relation: "Worker", values: { id: f["id"] } })
			)
		: []

const witnessGen =
	(ops: ReadonlyArray<HostOp>): Gen<ReturnType<typeof witnessOf>> =>
	(source) => {
		const shape = source.draw(element<WitnessShape>(["written", "outside", "none"]))
		switch (shape) {
			case "written":
				return witnessOf("grizzle", ops)
			case "outside":
				return outsideKey
			case "none":
				return []
		}
	}

/** One operation before its outcome: its writer, its ops, and its interval on the clock. */
interface Planned {
	readonly id: number
	readonly kind: WriterKind
	readonly ops: ReadonlyArray<HostOp>
	readonly start: number
	readonly end: number
}

const plannedGen =
	(id: number): Gen<Planned> =>
	(source) => {
		const start = source.draw(int(0, 5))
		return {
			id,
			kind: source.draw(element<WriterKind>(["grizzle", "direct"])),
			ops: [source.draw(opGen)],
			start,
			end: source.draw(int(start + 1, 6))
		}
	}

/** A grizzle writer's outcome, drawn freely. */
const settledGen =
	(p: Planned): Gen<Settled> =>
	(source) => {
		const kind = source.draw(element(["accepted", "no-change", "invariant-rejected"] as const))
		return kind === "invariant-rejected"
			? { kind, laws: [law], keys: source.draw(witnessGen(p.ops)) }
			: { kind }
	}

/** A direct writer's outcome, drawn freely. */
const directGen =
	(p: Planned): Gen<Outcome> =>
	(source) => {
		const kind = source.draw(element(["accepted", "invariant-rejected", "aborted"] as const))
		switch (kind) {
			case "accepted":
				return { kind }
			case "invariant-rejected":
				return { kind, laws: [law], keys: source.draw(witnessGen(p.ops)) }
			case "aborted":
				return {
					kind,
					cause: { kind: source.draw(element(["serialization failure", "deadlock"] as const)) }
				}
		}
	}

/**
 * An operation's record at `state`, its place: most often the outcome its writer's model gives it there, otherwise one
 * drawn freely; with the state after it, the model's when the outcome is the model's and commits, `state` otherwise.
 */
const recordGen =
	(p: Planned, state: HostState): Gen<readonly [Recorded, HostState]> =>
	(source) => {
		const head = { id: p.id, writer: `w${p.id}`, ops: p.ops, start: p.start, end: p.end }
		const e = expectFor(p.kind, host, state, p.ops)
		const faithful = source.draw(element([true, true, false] as const))
		const after = faithful && e.kind !== "invariant-rejected" ? e.state : state
		if (p.kind === "grizzle") {
			const modelled: Settled =
				e.kind === "invariant-rejected"
					? { kind: e.kind, laws: [law], keys: witnessOf(p.kind, p.ops) }
					: { kind: e.kind }
			return [
				{
					...head,
					kind: "grizzle",
					outcome: faithful ? modelled : source.draw(settledGen(p)),
					transients: source.draw(array(element(discardReasons), { min: 0, max: 1 }))
				},
				after
			]
		}
		const modelled: Outcome =
			e.kind === "invariant-rejected"
				? { kind: e.kind, laws: [law], keys: witnessOf(p.kind, p.ops) }
				: { kind: "accepted" }
		return [
			{ ...head, kind: "direct", outcome: faithful ? modelled : source.draw(directGen(p)) },
			after
		]
	}

/**
 * A history: two or three operations from a lawful initial state, placed in a drawn order, each recorded at its place
 * (recordGen), and the committed state the order reaches, or any set of the box's facts; so explained histories and
 * their near misses are both common.
 */
const historyGen: Gen<History> = (source) => {
	const initial = source.draw(lawfulGen)
	const planned = Arr.makeBy(source.draw(int(2, 3)), (id) => source.draw(plannedGen(id)))
	const order = source.draw(shuffled(planned, { min: planned.length, max: planned.length }))
	const recorded: Array<Recorded> = []
	let reached = initial
	for (const p of order) {
		const [record, after] = source.draw(recordGen(p, reached))
		recorded.push(record)
		reached = after
	}
	const committed = source.draw(
		oneOf<HostState>([() => reached, () => reached, map(subarray(boxFacts), workers)])
	)
	return {
		host,
		initial,
		recorded: Arr.sort(
			recorded,
			Order.mapInput(Order.Number, (r: Recorded) => r.id)
		),
		committed
	}
}

const overlaps = (r: Recorded, q: Recorded): boolean =>
	q.id !== r.id && q.start < r.end && r.start < q.end

const permutations = <T>(xs: ReadonlyArray<T>): ReadonlyArray<ReadonlyArray<T>> =>
	xs.length === 0
		? [[]]
		: Arr.flatMap(xs, (x, i) =>
				Arr.map(permutations([...xs.slice(0, i), ...xs.slice(i + 1)]), (rest) => [x, ...rest])
			)

const sameKeys = (
	left: ReadonlyArray<{ readonly values: Readonly<Record<string, unknown>> }>,
	right: typeof left
) =>
	left.length === right.length &&
	Arr.every(left, (k, i) => k.values["id"] === right[i]?.values["id"])

/** The reasons a concurrent transaction causes (a law family's write meets no other). */
const concurrent = (reason: TransientTag): boolean =>
	reason === "SerializationFailure" ||
	reason === "Deadlock" ||
	reason === "UnseenOccupant" ||
	reason === "PutTargetConflict" ||
	reason === "SpanKeyChange"

/** The state after `r` at `state` if its outcome is one `r.ops` from there admits, the state unchanged by a refusal. */
const replay = (r: Recorded, state: HostState): HostState | undefined => {
	const e = expectFor(r.kind, host, state, r.ops)
	const o = r.outcome
	switch (o.kind) {
		case "invariant-rejected":
			return e.kind === "invariant-rejected" &&
				Arr.some(e.violations, (v) => o.laws.includes(v.law)) &&
				sameKeys(o.keys, witnessOf(r.kind, r.ops))
				? state
				: undefined
		case "accepted":
		case "no-change":
			if (e.kind === "invariant-rejected") {
				return undefined
			}
			if (r.kind === "grizzle" && o.kind !== e.kind) {
				return undefined
			}
			return e.state
		case "aborted":
			return undefined
	}
}

/**
 * Whether direct writer `r`'s refusal by the key at `state`, its place, meets an occupant its snapshot did not hold: an
 * operation of `later`, after it in the order and overlapping it in real time, inserted a fact at the key of one `r`
 * inserts, which `state` does not hold. PostgreSQL checks the key against every committed row whatever the snapshot,
 * so the writer is refused although its place commits it. Its witness is still a direct writer's: none.
 */
const unseenOccupant = (r: Recorded, state: HostState, later: ReadonlyArray<Recorded>): boolean => {
	const o = r.outcome
	if (
		r.kind !== "direct" ||
		o.kind !== "invariant-rejected" ||
		!o.laws.includes(law) ||
		!sameKeys(o.keys, witnessOf(r.kind, r.ops))
	) {
		return false
	}
	const held = state.get("Worker") ?? []
	return Arr.some(
		r.ops,
		(op) =>
			op.kind === "insert" &&
			Arr.some(op.facts, (f) =>
				Arr.some(
					later,
					(q) =>
						overlaps(r, q) &&
						Arr.some(
							q.ops,
							(qo) =>
								qo.kind === "insert" &&
								Arr.some(
									qo.facts,
									(g) =>
										g["id"] === f["id"] &&
										!Arr.some(held, (k) => k["id"] === g["id"] && k["name"] === g["name"])
								)
						)
				)
			)
	)
}

/** Whether some order of `placed` respecting real time explains each outcome and ends at the committed state. */
const ordered = (h: History, placed: ReadonlyArray<Recorded>): boolean =>
	Arr.some(permutations(placed), (order) => {
		if (Arr.some(order, (r, i) => Arr.some(order.slice(i + 1), (q) => q.end < r.start))) {
			return false
		}
		let state: HostState | undefined = h.initial
		for (const [i, r] of order.entries()) {
			if (state === undefined) {
				break
			}
			state = replay(r, state) ?? (unseenOccupant(r, state, order.slice(i + 1)) ? state : undefined)
		}
		return state !== undefined && stateKey(state) === stateKey(h.committed)
	})

/** The naive enumerator's verdict (see the header). */
const explained = (h: History): boolean => {
	const keys = Arr.map([...(h.committed.get("Worker") ?? [])], (f) => f["id"])
	if (new Set(keys).size !== keys.length) {
		return false
	}
	for (const r of h.recorded) {
		const discarded = r.kind === "grizzle" ? r.transients : []
		if (
			Arr.some(
				discarded,
				(reason) => !concurrent(reason) || !Arr.some(h.recorded, (q) => overlaps(r, q))
			)
		) {
			return false
		}
		if (r.outcome.kind !== "aborted") {
			continue
		}
		if (!Arr.some(h.recorded, (q) => overlaps(r, q))) {
			return false
		}
	}
	const committed = Arr.filter(
		h.recorded,
		(r) => r.outcome.kind === "accepted" || r.outcome.kind === "no-change"
	)
	if (!ordered(h, committed)) {
		return false
	}
	return Arr.every(
		h.recorded,
		(r) => r.outcome.kind !== "invariant-rejected" || ordered(h, [...committed, r])
	)
}

/**
 * Whether the enumerator explains a history, one with an abort, one with a refusal, one with a refusal whose witness
 * is not the one its writer gives, one with a discarded attempt, one of three operations, and one where an operation's
 * interval ends where another's starts, neither before it nor overlapping it.
 */
type CheckerFeature =
	| "explained"
	| "unexplained"
	| "explained abort"
	| "unexplained abort"
	| "explained refusal"
	| "unexplained refusal"
	| "a wrong witness"
	| "explained discarded attempt"
	| "unexplained discarded attempt"
	| "three operations explained"
	| "intervals that touch"

describe("the history checker", () => {
	it.effect(
		"agrees with a naive enumerator on generated histories of two or three operations on one keyed relation",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/history-checker",
						draw: drawn(historyGen),
						literal: Formatter.format,
						coverage: required<CheckerFeature>(
							[
								"explained",
								"unexplained",
								"explained abort",
								"unexplained abort",
								"explained refusal",
								"unexplained refusal",
								"a wrong witness",
								"explained discarded attempt",
								"unexplained discarded attempt",
								"three operations explained",
								"intervals that touch"
							],
							{ cases: 2000, sense: notesOnly }
						),
						kept: [],
						runs: 3000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: {
							kind: "second-implementation",
							name: "a naive enumerator of every real-time-respecting serial order"
						}
					},
					(h, noted) =>
						Effect.sync(() => {
							const want = explained(h)
							const got = checkHistory(h).ok
							noted.note(want ? "explained" : "unexplained")
							if (want && h.recorded.length === 3) {
								noted.note("three operations explained")
							}
							if (Arr.some(h.recorded, (r) => Arr.some(h.recorded, (q) => q.end === r.start))) {
								noted.note("intervals that touch")
							}
							if (Arr.some(h.recorded, (r) => r.outcome.kind === "aborted")) {
								noted.note(want ? "explained abort" : "unexplained abort")
							}
							if (Arr.some(h.recorded, (r) => r.outcome.kind === "invariant-rejected")) {
								noted.note(want ? "explained refusal" : "unexplained refusal")
							}
							if (
								Arr.some(
									h.recorded,
									(r) =>
										r.outcome.kind === "invariant-rejected" &&
										!sameKeys(r.outcome.keys, witnessOf(r.kind, r.ops))
								)
							) {
								noted.note("a wrong witness")
							}
							if (Arr.some(h.recorded, (r) => r.kind === "grizzle" && r.transients.length > 0)) {
								noted.note(want ? "explained discarded attempt" : "unexplained discarded attempt")
							}
							assert.equal(
								got,
								want,
								`the checker says ${got ? "explained" : "unexplained"}, the enumerator not`
							)
						})
				)
			)
	)
})
