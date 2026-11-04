/**
 * The history checker against a naive enumerator, over every history of two operations on one keyed relation.
 *
 * The checker is itself an oracle, so its failure modes are silent: accepting a history no serial order explains (a
 * vacuous oracle), refusing one some order does (a false alarm in every suite that uses it), or letting an abort pass
 * that nothing in the history explains. The enumerator here states the same contract with no pruning and no
 * memoization. Every writer runs SERIALIZABLE, and the contract is:
 *
 * - the committed state holds the key;
 * - every abort, and every discarded attempt of a grizzle operation, has an operation overlapping it in real time, and
 *   a cause a concurrent transaction gives: a direct writer's 40001 or 40P01, a grizzle operation's TransientFailure of
 *   a concurrent reason (never StaleStatement);
 * - some order of the committed operations that respects real time replays each through its writer's model, each
 *   committing there (a grizzle no-change exactly no-change), and ends at the committed state;
 * - each refusal has such an order of the committed operations and itself, in which the model refuses it at its place
 *   with its law, and its witness names the violating fact's key: grizzle's always, a direct writer's never, since
 *   PostgreSQL states a native key's violation in prose. A direct writer's key refusal is also explained where an
 *   operation after it in the order, overlapping it in real time, inserted at the key a fact its place does not hold:
 *   an occupant committed after its snapshot, which PostgreSQL's key check meets whatever the snapshot.
 *
 * The space is exhaustive: Worker holds nothing or (1, a); each of two operations inserts (1, a), (1, b) or (2, a), or
 * deletes (1, a), as a grizzle writer or a direct one, and was accepted (a grizzle one also after a discarded attempt
 * of each cause), no-change (grizzle only), refused by the key with a witness naming the written fact's key, another
 * key or none, or aborted with each cause; the second ran before, overlapping or after the first; and the committed
 * state is any, one breaking the key among them. The checker and the enumerator must agree on every history.
 */

import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Order } from "effect"
import {
	type HostFact,
	type HostRelation,
	type HostSchema,
	type HostState,
	type HostOp,
	valueText
} from "#test/pg/laws/families/model.ts"
import { assert } from "#test/support/assert.ts"
import { checkHistory, type History, type Recorded } from "#test/support/history/check.ts"
import { expectFor, type WriterKind } from "#test/support/history/model.ts"
import { wild } from "#test/support/kernel/naming.ts"

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
	laws: [{ kind: "key", law, relation: "Worker", fields: ["id"] }]
}

const a: HostFact = { id: 1, name: "a" }
const b: HostFact = { id: 1, name: "b" }
const c: HostFact = { id: 2, name: "a" }

const workers = (...facts: ReadonlyArray<HostFact>): HostState => new Map([["Worker", facts]])
const factText = (f: HostFact): string => `${valueText(f["id"] ?? "")}${valueText(f["name"] ?? "")}`
const stateKey = (s: HostState): string =>
	Arr.join(Arr.sort(Arr.map(s.get("Worker") ?? [], factText), Order.String), ",")

const ops: Arr.NonEmptyReadonlyArray<HostOp> = [
	{ relation: "Worker", kind: "insert", facts: [a] },
	{ relation: "Worker", kind: "insert", facts: [b] },
	{ relation: "Worker", kind: "insert", facts: [c] },
	{ relation: "Worker", kind: "delete", facts: [a] }
]

/**
 * What an operation answered, by writer kind: each outcome its writer can report, each abort cause and each discarded
 * attempt's, the non-concurrent StaleStatement among them, and each refusal's witness: the written fact's key, which
 * grizzle names and a direct writer's native violation does not, another key, or none.
 */
type GrizzleShape =
	| "accepted"
	| "accepted after SerializationFailure"
	| "accepted after StaleStatement"
	| "no-change"
	| "rejected"
	| "rejected, another key"
	| "rejected, no key"
	| "aborted: SerializationFailure"
	| "aborted: StaleStatement"
type DirectShape = "accepted" | "rejected" | "rejected, a key" | "aborted: 40001" | "aborted: 40P01"
type Shaped =
	| { readonly kind: "grizzle"; readonly shape: GrizzleShape }
	| { readonly kind: "direct"; readonly shape: DirectShape }

const grizzleShapes: Arr.NonEmptyReadonlyArray<GrizzleShape> = [
	"accepted",
	"accepted after SerializationFailure",
	"accepted after StaleStatement",
	"no-change",
	"rejected",
	"rejected, another key",
	"rejected, no key",
	"aborted: SerializationFailure",
	"aborted: StaleStatement"
]

const directShapes: Arr.NonEmptyReadonlyArray<DirectShape> = [
	"accepted",
	"rejected",
	"rejected, a key",
	"aborted: 40001",
	"aborted: 40P01"
]

const shapedGen: Gen<Shaped> = element(
	Arr.appendAll(
		Arr.map(grizzleShapes, (shape): Shaped => ({ kind: "grizzle", shape })),
		Arr.map(directShapes, (shape): Shaped => ({ kind: "direct", shape }))
	)
)

/**
 * A refusal's witness: grizzle names the inserted fact by its key; a direct writer's native violation names nothing.
 */
const witnessOf = (kind: WriterKind, written: ReadonlyArray<HostOp>) =>
	kind === "grizzle"
		? Arr.map(
				Arr.flatMap(written, (o) => o.facts),
				(f) => ({ relation: "Worker", values: { id: f["id"] } })
			)
		: []

/** A key no fact of the space holds. */
const anotherKey = [{ relation: "Worker", values: { id: 3 } }]

const recordedOf = (
	s: Shaped,
	op: HostOp,
	id: number,
	span: { readonly start: number; readonly end: number }
): Recorded => {
	const head = { id, writer: id === 0 ? "first" : "second", ops: [op], ...span }
	if (s.kind === "grizzle") {
		switch (s.shape) {
			case "accepted":
			case "no-change":
				return { ...head, kind: "grizzle", outcome: { kind: s.shape }, transients: [] }
			case "accepted after SerializationFailure":
				return {
					...head,
					kind: "grizzle",
					outcome: { kind: "accepted" },
					transients: ["SerializationFailure"]
				}
			case "accepted after StaleStatement":
				return {
					...head,
					kind: "grizzle",
					outcome: { kind: "accepted" },
					transients: ["StaleStatement"]
				}
			case "rejected":
				return {
					...head,
					kind: "grizzle",
					outcome: { kind: "invariant-rejected", law, keys: witnessOf("grizzle", [op]) },
					transients: []
				}
			case "rejected, another key":
				return {
					...head,
					kind: "grizzle",
					outcome: { kind: "invariant-rejected", law, keys: anotherKey },
					transients: []
				}
			case "rejected, no key":
				return {
					...head,
					kind: "grizzle",
					outcome: { kind: "invariant-rejected", law, keys: [] },
					transients: []
				}
			case "aborted: SerializationFailure":
				return {
					...head,
					kind: "grizzle",
					outcome: {
						kind: "aborted",
						cause: { kind: "transient", reason: "SerializationFailure" }
					},
					transients: []
				}
			case "aborted: StaleStatement":
				return {
					...head,
					kind: "grizzle",
					outcome: { kind: "aborted", cause: { kind: "transient", reason: "StaleStatement" } },
					transients: []
				}
		}
	}
	switch (s.shape) {
		case "accepted":
			return { ...head, kind: "direct", outcome: { kind: "accepted" } }
		case "rejected":
			return { ...head, kind: "direct", outcome: { kind: "invariant-rejected", law, keys: [] } }
		case "rejected, a key":
			return {
				...head,
				kind: "direct",
				outcome: { kind: "invariant-rejected", law, keys: witnessOf("grizzle", [op]) }
			}
		case "aborted: 40001":
			return {
				...head,
				kind: "direct",
				outcome: { kind: "aborted", cause: { kind: "serialization failure" } }
			}
		case "aborted: 40P01":
			return { ...head, kind: "direct", outcome: { kind: "aborted", cause: { kind: "deadlock" } } }
	}
}

/** The second operation's interval beside the first's [0, 10]. */
const timings = [
	{ name: "before", start: -10, end: -1 },
	{ name: "overlapping", start: 5, end: 15 },
	{ name: "after", start: 11, end: 20 }
] as const

interface Case {
	readonly initial: HostState
	readonly operations: readonly [readonly [Shaped, HostOp], readonly [Shaped, HostOp]]
	readonly timing: (typeof timings)[number]
	readonly committed: HostState
}

const operationGen: Gen<readonly [Shaped, HostOp]> = (source) =>
	[source.draw(shapedGen), source.draw(element(ops))] as const

/** Every committed state a case may claim, one breaking the key among them. */
const committedStates = element([
	workers(),
	workers(a),
	workers(b),
	workers(c),
	workers(a, c),
	workers(b, c),
	workers(a, b)
])

const caseGen: Gen<Case> = (source) => ({
	initial: source.draw(element([workers(), workers(a)])),
	operations: [source.draw(operationGen), source.draw(operationGen)],
	timing: source.draw(element<(typeof timings)[number]>(timings)),
	committed: source.draw(committedStates)
})

const historyOf = (x: Case): History => ({
	host,
	initial: x.initial,
	recorded: Arr.map(x.operations, ([shaped, op], id) =>
		recordedOf(
			shaped,
			op,
			id,
			id === 0 ? { start: 0, end: 10 } : { start: x.timing.start, end: x.timing.end }
		)
	),
	committed: x.committed
})

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

/** The state after `r` at `state` if its outcome is one `r.ops` from there admits, the state unchanged by a refusal. */
const replay = (r: Recorded, state: HostState): HostState | undefined => {
	const e = expectFor(r.kind, host, state, r.ops)
	const o = r.outcome
	switch (o.kind) {
		case "invariant-rejected":
			return e.kind === "invariant-rejected" &&
				Arr.some(e.violations, (v) => v.law === o.law) &&
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
		o.law !== law ||
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
				(reason) => reason === "StaleStatement" || !Arr.some(h.recorded, (q) => overlaps(r, q))
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
		if (r.outcome.cause.kind === "transient" && r.outcome.cause.reason === "StaleStatement") {
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
 * is not the one its writer gives, and one with a discarded attempt.
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

describe("the history checker", () => {
	it.effect(
		"agrees with a naive enumerator on every history of two operations on one keyed relation",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/history-checker",
						generator: caseGen,
						literal: Formatter.format,
						/**
						 * The space holds 131 712 histories (2 initial states, 56 × 56 operations, 3 timings, 7 committed
						 * states); the limit is the cap against a space grown by mistake.
						 */
						limit: 140_000,
						coverage: requiredInSpace<CheckerFeature>([
							"explained",
							"unexplained",
							"explained abort",
							"unexplained abort",
							"explained refusal",
							"unexplained refusal",
							"a wrong witness",
							"explained discarded attempt",
							"unexplained discarded attempt"
						]),
						caseHang: Duration.minutes(2)
					},
					(x, noted) =>
						Effect.sync(() => {
							const h = historyOf(x)
							const want = explained(h)
							const got = checkHistory(h).ok
							noted.note(want ? "explained" : "unexplained")
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
