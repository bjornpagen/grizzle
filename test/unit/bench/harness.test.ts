/**
 * The bench harness's pure parts, each against an oracle:
 *
 * - EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SETTINGS, FORMAT JSON) output, with WAL and SERIALIZE as captured, is read
 *   back exactly as generated (captures.ts prints a generated capture as PostgreSQL prints one, keys no reader reads
 *   among them): every node's figures, conditions, buffers and WAL, the triggers by call count, serialization, the
 *   changed settings and the plan tree alone. Rows read count each stored scan's rows over its loops, a Bitmap Index
 *   Scan's and a re-reading scan's never; rows generated count the generating scans'; a statement's totals are its
 *   root's counters, never a sum over the tree. The roles a plan's nodes were generated in decide the oracle's counts,
 *   never the fields the readers branch on.
 * - Output PostgreSQL never prints, a fault planted in a generated capture, is refused as MalformedPlan, by the tree's
 *   reader too where the fault is in what it reads.
 * - The harness's caller-side retry retries exactly what grizzle classifies as a TransientFailure, up to its policy:
 *   a model of the documented classification judges generated scripts of attempts.
 * - Rows are read once as text cells; two row lists agree, and digest alike, exactly as a model of multisets says.
 * - A verdict fails exactly on its failing checks; a record names exactly the gaps planted in it; a run's record keeps
 *   its cases when only the release fails.
 * - Every gate of the catalog has exactly one bench file, in its owner's directory: an audit of the real tree.
 * - The command line of `pnpm bench` reads exactly what a model of its grammar reads, and refuses the rest.
 *
 * Each property states its oracle and requires the situations its oracle tells apart.
 *
 * Plants (~/.cache/grizzle-release/BR07/plants), one a property in this order: harness-rows-read-one-loop.patch (a
 * scan's rows read over one loop), harness-figure-not-finite-read.patch (a figure that is not finite read),
 * harness-retry-once-more.patch (one retry past the policy), harness-rows-repeat-agrees.patch (a repeated row
 * agreeing), harness-text-number-read.patch (a number cell read as text), harness-verdict-first-check.patch (a verdict
 * blind to its first check), harness-record-two-verdicts.patch (two verdicts of a gate unnamed),
 * harness-record-leak-keeps-verdicts.patch (a leaked release keeping its verdicts), harness-gate-owner-swapped.patch (a
 * gate owned by the other directory), harness-full-takes-arguments.patch (`full` taking arguments).
 */
import { NodeServices } from "@effect/platform-node"
import { describe, it, layer } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	subarray,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Data,
	Effect,
	Exit,
	Formatter,
	Option,
	Order,
	Path,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import {
	type BenchIdentity,
	benchIdentity,
	identityProblems,
	readPin,
	repoRoot,
	runIdentity,
	type ServerIdentity,
	serverSettings,
	sourceIdentity
} from "#bench/cold/identity.ts"
import type { Summary } from "#bench/cold/stats.ts"
import { parseBenchArgs } from "#bench/harness/cli.ts"
import {
	indexAccesses,
	MalformedPlan,
	nodeTypeCounts,
	parsePlan,
	parsePlanTree,
	relationsRead,
	rowsGenerated,
	rowsRead,
	statementTotals
} from "#bench/harness/explain.ts"
import {
	type CaseRecord,
	defineGate,
	equivalence,
	gateFindings,
	type GateCheck,
	type GateRun,
	mechanism,
	type RanRecord,
	type RecordProblem,
	recordProblems,
	type VerdictInput,
	verdictOf
} from "#bench/harness/gate.ts"
import {
	type DiscardedAttempt,
	type OperationResult,
	type RetryOptions,
	sqlAttempted,
	withRetries
} from "#bench/harness/load.ts"
import {
	failedAt,
	failedAtStatement,
	type FailedOutcome,
	type Outcome,
	type OutcomeCause
} from "#bench/harness/outcome.ts"
import { gateCatalog, type GateId, gateOwner, ownerDirectories } from "#bench/harness/rules.ts"
import { discoverGates, recordOf } from "#bench/harness/runner.ts"
import {
	MalformedRows,
	resultSet,
	rowsAgree,
	type TextRow,
	textRows
} from "#bench/harness/variant.ts"
import { StoredRelationName } from "#compiler/core/ids.ts"
import type { UniqueAbort } from "#compiler/runtime/write/steps.ts"
import { assert, assertVariant, nonEmpty } from "#test/support/assert.ts"
import { wild } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	captureGen,
	estimatedOf,
	explainedOf,
	planFaults,
	plantedFault,
	printedCapture,
	type Role,
	sketchNodes,
	treeFaults
} from "#test/unit/bench/captures.ts"

const spec = {
	literal: Formatter.format,
	kept: [],
	shrink: completeShrink,
	concurrency: 1,
	steerEvery: 16,
	caseHang
} as const

/** What a generated plan's nodes reached: each role, a WAL capture or none, and serialization or none. */
type CaptureFeature = `a ${Role}` | "WAL captured" | "WAL not captured" | "serialized" | "a trigger"

describe("EXPLAIN capture", () => {
	it.effect(
		"reads every generated capture back exactly, counts rows by the roles its nodes play, and keeps a statement's totals at its root",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						...spec,
						suite: "unit/bench/explain-round-trip",
						draw: drawn(captureGen),
						oracle: {
							kind: "universal",
							name: "read ∘ print = id over generated captures, and rows counted by the role each node was generated in"
						},
						coverage: required<CaptureFeature>(
							[
								"a stored scan",
								"a bitmap index scan",
								"a re-read",
								"a generating",
								"a modify",
								"a inner",
								"WAL captured",
								"WAL not captured",
								"serialized",
								"a trigger"
							],
							{ cases: 400, sense: notesOnly }
						),
						runs: 300
					},
					(capture, c) =>
						Effect.sync(() => {
							const printed = printedCapture(capture)
							const expected = explainedOf(capture)
							const read = Result.getOrThrow(parsePlan(printed))
							assert.deepEqual(read, expected)
							assert.deepEqual(Result.getOrThrow(parsePlanTree(printed)), estimatedOf(capture.plan))
							const nodes = sketchNodes(capture.plan)
							const scanned = (role: Role): number =>
								Arr.reduce(
									Arr.filter(nodes, (n) => n.role === role),
									0,
									(sum, n) =>
										sum +
										(n.fields.actualRows +
											n.fields.rowsRemovedByFilter +
											n.fields.rowsRemovedByIndexRecheck) *
											n.fields.actualLoops
								)
							assert.equal(rowsRead(read.plan), scanned("stored scan"))
							assert.equal(rowsGenerated(read.plan), scanned("generating"))
							assert.deepEqual(
								relationsRead(read.plan),
								Arr.dedupe(
									Arr.flatMap(nodes, (n) =>
										n.role === "modify" ? [] : Option.toArray(n.fields.relation)
									)
								)
							)
							assert.deepEqual(
								indexAccesses(read.plan),
								Arr.flatMap(nodes, (n) =>
									Option.match(n.fields.index, {
										onNone: () => [],
										onSome: (index) => [
											{
												nodeType: n.fields.nodeType,
												relation: n.fields.relation,
												index,
												indexCond: n.fields.indexCond,
												orderBy: n.fields.orderBy,
												filter: n.fields.filter
											}
										]
									})
								)
							)
							assert.deepEqual(
								nodeTypeCounts(read.plan),
								Rec.map(
									Arr.groupBy(nodes, (n) => n.fields.nodeType),
									(group) => group.length
								)
							)
							assert.deepEqual(statementTotals(read), {
								buffers: capture.plan.fields.buffers,
								wal: capture.plan.fields.wal,
								planningBuffers: capture.planningBuffers,
								serialization: capture.serialization,
								triggerCalls: Arr.reduce(capture.triggers, 0, (sum, t) => sum + t.calls)
							})
							for (const n of nodes) {
								c.note(`a ${n.role}`)
							}
							c.note(
								capture.plan.fields.wal.kind === "captured" ? "WAL captured" : "WAL not captured"
							)
							if (capture.serialization.kind === "captured") {
								c.note("serialized")
							}
							if (Arr.isReadonlyArrayNonEmpty(capture.triggers)) {
								c.note("a trigger")
							}
						})
				)
			)
	)

	it.effect(
		"refuses output PostgreSQL never prints, a fault planted in a generated capture, as MalformedPlan",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						...spec,
						suite: "unit/bench/explain-faults",
						draw: drawn((source) => ({
							capture: source.draw(captureGen),
							fault: source.draw(element(planFaults))
						})),
						oracle: {
							kind: "specification",
							name: "each planted fault is output PostgreSQL never prints, which the reader refuses"
						},
						coverage: required(planFaults, { cases: 2000, sense: notesOnly }),
						runs: 300
					},
					({ capture, fault }, c) =>
						Effect.gen(function* () {
							const planted = c.draw(plantedFault(capture, fault))
							yield* c.assume(Option.isSome(planted))
							for (const value of Option.toArray(planted)) {
								const read = parsePlan(value)
								assertVariant(read, "_tag", "Failure", fault)
								assert.ok(read.failure instanceof MalformedPlan, fault)
								if (treeFaults.has(fault)) {
									const tree = parsePlanTree(value)
									assertVariant(tree, "_tag", "Failure", fault)
									assert.ok(tree.failure instanceof MalformedPlan, fault)
								}
								c.note(fault)
							}
						})
				)
			)
	)
})

/** The SQLSTATEs a script draws: the two grizzle always retries, the two a listed constraint makes transient, others. */
const codes = ["40001", "40P01", "23505", "23P01", "23000", "23503", "XX000"] as const
type Code = (typeof codes)[number]

/** The cause each SQLSTATE drawn is tallied by, as outcome.ts states it. */
const causes: Readonly<Record<Code, OutcomeCause>> = {
	"40001": "serialization",
	"40P01": "deadlock",
	"23505": "uniqueViolation",
	"23P01": "exclusionViolation",
	"23000": "lawViolation",
	"23503": "foreignKeyViolation",
	XX000: "other"
}

/** The constraints a script names: three an operation may list among its unique aborts, and one no operation lists. */
const constraintNames = ["item_pkey", "seat_key", "slot_key", "item_name_key"] as const
type Named = (typeof constraintNames)[number]

const listable: ReadonlyArray<readonly [Named, UniqueAbort["reason"]]> = [
	["item_pkey", "GeneratedSerialUnique"],
	["seat_key", "PutTargetConflict"],
	["slot_key", "UnseenOccupant"]
]

/**
 * One scripted attempt: it commits, or PostgreSQL refuses it with `code`, naming a constraint or none, with a DETAIL or
 * none, at `at`.
 */
type Step =
	| { readonly kind: "commits" }
	| {
			readonly kind: "refused"
			readonly code: Code
			readonly constraint: Option.Option<Named>
			readonly detail: Option.Option<string>
			readonly at: FailedOutcome["at"]
	  }

type Refused = Extract<Step, { readonly kind: "refused" }>

/** A retried operation: its policy's retries, the unique aborts it lists, whether the gate labels a retry, its attempts. */
interface Retried {
	readonly times: number
	readonly listed: ReadonlyArray<readonly [Named, UniqueAbort["reason"]]>
	readonly labelled: boolean
	readonly steps: ReadonlyArray<Step>
}

const stepGen: Gen<Step> = (source) =>
	source.draw(boolean)
		? { kind: "commits" }
		: {
				kind: "refused",
				code: source.draw(element(codes)),
				constraint: source.draw(boolean)
					? Option.some(source.draw(element(constraintNames)))
					: Option.none(),
				detail: source.draw(boolean) ? Option.some("Reason code: drawn.") : Option.none(),
				at: source.draw(element(["statement", "begin", "deferredChecks", "commit"] as const))
			}

/** An operation with as many scripted attempts as its policy allows. */
const retriedGen: Gen<Retried> = (source) => {
	const times = source.draw(int(0, 3))
	return {
		times,
		listed: source.draw(subarray(listable)),
		labelled: source.draw(boolean),
		steps: source.draw(array(stepGen, { min: times + 1, max: times + 1 }))
	}
}

/** The failed outcome a refused step must be recorded as. */
const failedOf = (step: Refused): FailedOutcome => {
	const constraint = Option.match(step.constraint, {
		onNone: () => ({ kind: "none" }) as const,
		onSome: (name) => ({ kind: "named", name: wild.constraint(name) }) as const
	})
	const reported = {
		sqlstate: step.code,
		cause: causes[step.code],
		constraint,
		message: "refused",
		detail: step.detail
	}
	return step.at === "statement"
		? { kind: "failed", at: "statement", statement: "write", ...reported }
		: { kind: "failed", at: step.at, ...reported }
}

/**
 * A step's transient reason by grizzle's classification of a TransientFailure: 40001 and 40P01 wherever PostgreSQL
 * raises them, and a unique or exclusion violation at its statement on a constraint the operation lists.
 */
const reasonOf = (r: Retried, step: Step): DiscardedAttempt["reason"] | undefined => {
	if (step.kind === "commits") {
		return undefined
	}
	switch (step.code) {
		case "40001":
			return "SerializationFailure"
		case "40P01":
			return "Deadlock"
		case "23505":
		case "23P01":
			return step.at === "statement"
				? Option.getOrUndefined(
						Option.flatMap(step.constraint, (name) =>
							Option.map(
								Arr.findFirst(r.listed, ([listed]) => listed === name),
								([, reason]) => reason
							)
						)
					)
				: undefined
		case "23000":
		case "23503":
		case "XX000":
			return undefined
	}
}

/** What the model says the operation reports: attempts while transient, up to the policy, the last one standing. */
const modelOf = (r: Retried): OperationResult => {
	const retries: Array<DiscardedAttempt> = []
	for (const [i, step] of r.steps.entries()) {
		const reason = reasonOf(r, step)
		if (step.kind === "commits") {
			return { outcome: { kind: "committed" }, attempts: i + 1, retries }
		}
		const failed = failedOf(step)
		if (reason === undefined || i === r.times) {
			return { outcome: failed, attempts: i + 1, retries }
		}
		retries.push({ reason, failed, label: r.labelled ? failed.sqlstate : undefined })
	}
	return assert.fail("a script of as many attempts as the policy allows ends")
}

/** The server error a refused step stands for, as the driver reports one. */
const errorOf = (step: Refused) => ({
	code: step.code,
	message: "refused",
	...Option.match(step.constraint, {
		onNone: () => ({}),
		onSome: (name) => ({ constraint: wild.constraint(name) })
	}),
	...Option.match(step.detail, {
		onNone: () => ({}),
		onSome: (detail) => ({ detail })
	})
})

/** The operation the harness runs: each attempt the step its number names, read as a hand-written attempt. */
const ranOf = (r: Retried): Effect.Effect<OperationResult> => {
	const options: RetryOptions = {
		uniqueAborts: Arr.map(r.listed, ([name, reason]) => ({
			constraint: wild.constraint(name),
			relation: StoredRelationName("Item"),
			reason
		})),
		label: (failed) => (r.labelled ? failed.sqlstate : undefined)
	}
	return withRetries(
		(n) =>
			Effect.sync(() => {
				const step = Arr.getUnsafe(r.steps, n - 1)
				const outcome: Outcome =
					step.kind === "commits"
						? { kind: "committed" }
						: Option.getOrThrow(
								step.at === "statement"
									? failedAtStatement(errorOf(step), "write")
									: failedAt(errorOf(step), step.at)
							)
				return sqlAttempted(outcome, options)
			}),
		{ times: r.times, baseMs: 0 }
	)
}

type RetryFeature =
	| "committed at once"
	| "committed after a retry"
	| "the policy ran out"
	| "a refusal ended it"
	| "a unique abort retried"
	| "a unique violation not retried"
	| "labelled"

describe("outcomes, retries and loads", () => {
	it.effect(
		"retry exactly what grizzle classifies as a TransientFailure, up to the caller's policy, the last attempt standing",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						...spec,
						suite: "unit/bench/retries",
						draw: drawn(retriedGen),
						oracle: {
							kind: "second-implementation",
							name: "a model of grizzle's documented TransientFailure classification over scripted attempts"
						},
						coverage: required<RetryFeature>(
							[
								"committed at once",
								"committed after a retry",
								"the policy ran out",
								"a refusal ended it",
								"a unique abort retried",
								"a unique violation not retried",
								"labelled"
							],
							{ cases: 400, sense: notesOnly }
						),
						runs: 400
					},
					(r, c) =>
						Effect.map(ranOf(r), (ran) => {
							const model = modelOf(r)
							assert.deepEqual(ran, model)
							if (ran.outcome.kind === "committed") {
								c.note(ran.attempts === 1 ? "committed at once" : "committed after a retry")
							} else if (reasonOf(r, Arr.getUnsafe(r.steps, ran.attempts - 1)) === undefined) {
								c.note("a refusal ended it")
							} else {
								c.note("the policy ran out")
							}
							for (const step of Arr.take(r.steps, ran.attempts)) {
								if (step.kind === "refused" && (step.code === "23505" || step.code === "23P01")) {
									c.note(
										reasonOf(r, step) === undefined
											? "a unique violation not retried"
											: "a unique abort retried"
									)
								}
							}
							if (Arr.some(ran.retries, (d) => d.label !== undefined)) {
								c.note("labelled")
							}
						})
				)
			)
	)
})

/** A cell of a delivered row: text with the spellings a row's encoding must keep apart, or NULL. */
const cellGen: Gen<string | null> = element([
	"",
	"a",
	"b",
	"ab",
	"N",
	"S",
	"aS",
	"S1:a",
	"1:",
	null
] as const)

const rowGen: Gen<TextRow> = array(cellGen, { min: 0, max: 3 })

/**
 * A pair of row lists: the second an edit of the first (permuted, a row dropped, added or repeated, its rows' cells
 * re-split) or drawn apart.
 */
const rowPairGen: Gen<readonly [ReadonlyArray<TextRow>, ReadonlyArray<TextRow>]> = (source) => {
	const left = source.draw(array(rowGen, { min: 0, max: 5 }))
	const edit = source.draw(
		element(["permuted", "dropped", "added", "repeated", "re-split", "apart"] as const)
	)
	switch (edit) {
		case "re-split":
			return [left, Arr.map(left, resplit)]
		case "permuted":
			return [left, Arr.reverse(left)]
		case "dropped":
			return [left, Arr.drop(left, 1)]
		case "added":
			return [left, [...left, source.draw(rowGen)]]
		case "repeated":
			return [left, [...left, ...Arr.take(left, 1)]]
		case "apart":
			return [left, source.draw(array(rowGen, { min: 0, max: 5 }))]
	}
}

/**
 * A row with the boundary of its first two cells moved one character, where the first holds one: the same text in
 * other cells, which an encoding that does not delimit its cells would not tell apart.
 */
const resplit = (row: TextRow): TextRow => {
	const [first, second, ...rest] = row
	return typeof first === "string" && first.length > 0 && typeof second === "string"
		? [Str.slice(0, -1)(first), `${Str.slice(-1)(first)}${second}`, ...rest]
		: row
}

const sameRow = (x: TextRow, y: TextRow): boolean =>
	x.length === y.length && Arr.every(x, (cell, i) => cell === y[i])

const countOf = (rows: ReadonlyArray<TextRow>, row: TextRow): number =>
	Arr.filter(rows, (r) => sameRow(r, row)).length

const distinctOf = (rows: ReadonlyArray<TextRow>): number =>
	Arr.filter(rows, (row, i) => !Arr.some(Arr.take(rows, i), (r) => sameRow(r, row))).length

const sameMultiset = (a: ReadonlyArray<TextRow>, b: ReadonlyArray<TextRow>): boolean =>
	Arr.every([...a, ...b], (row) => countOf(a, row) === countOf(b, row))

type RowsFeature =
	| "one set"
	| "a repeat told apart"
	| "a row told apart"
	| "one digest"
	| "two digests"

/** A cell a session may deliver: text, NULL, or a value the casts to text rule out. */
const deliveredGen: Gen<unknown> = element(["t", "", null, 1, true, {}, 0n] as const)

describe("result rows", () => {
	it.effect(
		"agree, and digest alike, exactly as one multiset of rows that neither list repeats, a cell's NULL apart from its text",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						...spec,
						suite: "unit/bench/rows-agree",
						draw: drawn(rowPairGen),
						oracle: {
							kind: "second-implementation",
							name: "rows counted cell by cell, a list agreeing with another when neither repeats a row and the counts match"
						},
						coverage: required<RowsFeature>(
							["one set", "a repeat told apart", "a row told apart", "one digest", "two digests"],
							{ cases: 300, sense: notesOnly }
						),
						runs: 400
					},
					([left, right], c) =>
						Effect.sync(() => {
							const sets = distinctOf(left) === left.length && distinctOf(right) === right.length
							const same = sameMultiset(left, right)
							assert.equal(Option.isNone(rowsAgree(left, right)), sets && same)
							const [a, b] = [resultSet(left), resultSet(right)]
							assert.deepEqual(
								[a.rows, a.distinct, a.repeated],
								[left.length, distinctOf(left), left.length - distinctOf(left)]
							)
							assert.equal(a.digest === b.digest, same)
							c.note(sets && same ? "one set" : sets ? "a row told apart" : "a repeat told apart")
							c.note(same ? "one digest" : "two digests")
						})
				)
			)
	)

	it.effect(
		"read a statement's rows as text cells, refusing the first cell, in row order, that is neither text nor NULL",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						...spec,
						suite: "unit/bench/text-rows",
						draw: drawn((source) => ({
							statement: source.draw(int(0, 3)),
							rows: source.draw(array(array(deliveredGen, { min: 0, max: 3 }), { min: 0, max: 4 }))
						})),
						oracle: {
							kind: "specification",
							name: "a cell is text or NULL, and the first that is neither is named by its statement, row and column"
						},
						coverage: required<"read" | "refused">(["read", "refused"], {
							cases: 100,
							sense: notesOnly
						}),
						runs: 200
					},
					({ statement, rows }, c) =>
						Effect.sync(() => {
							const bad = Arr.findFirst(
								Arr.flatMap(rows, (cells, row) =>
									Arr.map(cells, (cell, column) => ({ cell, row, column }))
								),
								({ cell }) => typeof cell !== "string" && cell !== null
							)
							const read = textRows(rows, statement)
							if (Option.isNone(bad)) {
								c.note("read")
								const cells: ReadonlyArray<TextRow> = Arr.map(rows, (row) =>
									Arr.map(row, (cell) => (typeof cell === "string" ? cell : null))
								)
								assert.deepEqual(Result.getOrThrow(read), cells)
								return
							}
							c.note("refused")
							assertVariant(read, "_tag", "Failure")
							assert.ok(read.failure instanceof MalformedRows)
							assert.deepEqual(
								[read.failure.statement, read.failure.row, read.failure.column],
								[statement, bad.value.row, bad.value.column]
							)
						})
				)
			)
	)
})

/** A check of a verdict: what it judges, its name, whether it holds. */
const checkGen: Gen<GateCheck> = (source) => {
	const kind = source.draw(element(["mechanism", "equivalence"] as const))
	const name = source.draw(
		element(["Index Cond on the seek", "same page", "no Unique node"] as const)
	)
	const holds = source.draw(boolean)
	return kind === "mechanism"
		? mechanism(name, holds, "observed")
		: equivalence(name, holds, "observed")
}

describe("verdicts judge a gate by its tagged checks", () => {
	it.effect("fail on exactly the checks that fail, and pass when every check holds", (ctx) =>
		searched(
			ctx,
			explore(
				{
					...spec,
					suite: "unit/bench/verdicts",
					draw: drawn((source) =>
						nonEmpty(source.draw(array(checkGen, { min: 1, max: 4 })), "checks")
					),
					oracle: {
						kind: "specification",
						name: "a verdict fails on its failing checks, in their order"
					},
					coverage: required<"pass" | "fail">(["pass", "fail"], { cases: 60, sense: notesOnly }),
					runs: 100
				},
				(checks, c) =>
					Effect.sync(() => {
						const failing = Arr.map(
							Arr.filter(checks, (k) => !k.holds),
							(k) => k.name
						)
						const verdict = verdictOf("R05", { checks })
						c.note(verdict.outcome === "pass" ? "pass" : "fail")
						assert.deepEqual(
							verdict,
							Arr.isReadonlyArrayNonEmpty(failing)
								? { gate: "R05", outcome: "fail", failing, checks }
								: { gate: "R05", outcome: "pass", checks }
						)
					})
			)
		)
	)
})

/** A server identity that matches the pin, as a run against the local cluster reports it. */
const pinnedServer = (pinVersion: string): ServerIdentity => ({
	version: `PostgreSQL ${pinVersion} on test`,
	serverVersion: pinVersion,
	serverVersionNum: 190000,
	jitAvailable: true,
	settings: Rec.fromEntries(Arr.map(serverSettings, (s) => [s, "x"] as const)),
	extensions: {}
})

/** The phases a record may declare and a case may time. */
const phaseNames = ["executeMs", "commitMs", "setupMs"] as const
type PhaseName = (typeof phaseNames)[number]

const conditionFields = [
	"workload",
	"schemaState",
	"dataDistribution",
	"resultSemantics",
	"cacheState"
] as const

const timing: Summary = { n: 1, min: 1, p50: 1, p95: 1, p99: 1, max: 1, mean: 1 }

/** A case of a generated record: the condition fields it leaves empty, the gates it names and the phases it times. */
interface CaseSketch {
	readonly empty: ReadonlyArray<(typeof conditionFields)[number]>
	readonly gates: Arr.NonEmptyReadonlyArray<GateId>
	readonly phases: ReadonlyArray<PhaseName>
}

/**
 * A generated record with gaps planted, each drawn a quarter of the time or so, so a record with none is common: a
 * malformed name, a file that is no bench file, another gate's benchmark, gates with no verdict or two, cases with
 * empty conditions, gates outside the record's, undeclared phases, or no timing at all.
 */
interface RecordSketch {
	readonly name: "row-seek" | "Row_Seek"
	readonly file: "bench/query/row-seek.bench.ts" | "bench/query/row-seek.ts"
	readonly benchmark: string
	readonly gates: Arr.NonEmptyReadonlyArray<readonly [GateId, verdicts: 0 | 1 | 2]>
	readonly declared: Arr.NonEmptyReadonlyArray<PhaseName>
	readonly cases: ReadonlyArray<CaseSketch>
}

const catalogIds = nonEmpty(
	Arr.map(gateCatalog, (e) => e.id),
	"the catalog's gates"
)

/** One of `items`, drawn as `planted` a quarter of the time and as `clean` otherwise. */
const mostly = <A>(clean: Gen<A>, planted: Gen<A>): Gen<A> =>
	weighted<A>([
		[3, clean],
		[1, planted]
	])

/** Some of `items`, at least one. */
const someOf =
	<A>(items: Arr.NonEmptyReadonlyArray<A>): Gen<Arr.NonEmptyReadonlyArray<A>> =>
	(source) =>
		nonEmpty(Arr.dedupe(source.draw(array(element(items), { min: 1, max: 2 }))), "some items")

const recordGen =
	(ids: Arr.NonEmptyReadonlyArray<GateId>): Gen<RecordSketch> =>
	(source) => {
		const name = source.draw(
			mostly<RecordSketch["name"]>(constant("row-seek"), constant("Row_Seek"))
		)
		const gates = Arr.map(
			source.draw(someOf(ids)),
			(id) => [id, source.draw(mostly<0 | 1 | 2>(constant(1), element([0, 2] as const)))] as const
		)
		const declared = source.draw(someOf(phaseNames))
		const recordGates = Arr.map(gates, ([id]) => id)
		return {
			name,
			file: source.draw(
				mostly<RecordSketch["file"]>(
					constant("bench/query/row-seek.bench.ts"),
					constant("bench/query/row-seek.ts")
				)
			),
			benchmark: source.draw(mostly<string>(constant(`gate/${name}`), constant("gate/other"))),
			gates: nonEmpty(gates, "the record's gates"),
			declared,
			cases: source.draw(
				array(
					(s): CaseSketch => ({
						empty: s.draw(mostly<CaseSketch["empty"]>(constant([]), subarray(conditionFields))),
						gates: s.draw(
							mostly<CaseSketch["gates"]>(
								someOf(nonEmpty(recordGates, "the record's gates")),
								someOf(ids)
							)
						),
						phases: s.draw(mostly<CaseSketch["phases"]>(someOf(declared), subarray(phaseNames)))
					}),
					{ min: 0, max: 2 }
				)
			)
		}
	}

const caseName = (i: number): string => `case ${i}`

/** A case's condition field: empty where the case plants the gap, stated otherwise. */
const conditionOf = (c: CaseSketch, field: (typeof conditionFields)[number]): string =>
	Arr.contains(c.empty, field) ? "" : "x"

/** The record a sketch describes, over a complete identity. */
const recordOfSketch = (r: RecordSketch, identity: BenchIdentity): RanRecord => ({
	kind: "ran",
	identity: { ...identity, benchmark: r.benchmark, phases: r.declared },
	name: r.name,
	file: r.file,
	title: "Row seeks",
	gates: Arr.map(r.gates, ([id]) => id),
	quick: true,
	runPhases: { setupMs: 1, runMs: 2 },
	release: { kind: "clean" },
	verdicts: Arr.flatMap(r.gates, ([id, count]) => {
		const verdict = verdictOf(id, { checks: [mechanism("Index Cond", true, "on the seek")] })
		return Arr.take([verdict, verdict], count)
	}),
	cases: Arr.map(r.cases, (c, i): CaseRecord<GateId> => ({
		name: caseName(i),
		gates: c.gates,
		conditions: {
			workload: conditionOf(c, "workload"),
			schemaState: conditionOf(c, "schemaState"),
			dataDistribution: conditionOf(c, "dataDistribution"),
			parameters: {},
			resultSemantics: conditionOf(c, "resultSemantics"),
			cacheState: conditionOf(c, "cacheState")
		},
		phases: Rec.fromEntries(Arr.map(c.phases, (p) => [p, timing] as const)),
		variants: [],
		comparisons: [],
		transactions: {},
		loads: {},
		measures: {}
	})),
	problems: []
})

/** The gaps a record must be found to have, in the order it is read: the gaps the sketch planted. */
const plantedGaps = (r: RecordSketch, identity: BenchIdentity): ReadonlyArray<RecordProblem> => {
	const ids = Arr.map(r.gates, ([id]) => id)
	return [
		...Arr.map(identityProblems(identity), (problem): RecordProblem => ({
			kind: "identity",
			problem
		})),
		...(r.name === "row-seek" ? [] : [{ kind: "name" } as const]),
		...(r.file === "bench/query/row-seek.bench.ts" ? [] : [{ kind: "file" } as const]),
		...(r.benchmark === `gate/${r.name}` ? [] : [{ kind: "benchmark" } as const]),
		...Arr.flatMap(r.gates, ([gate, count]): ReadonlyArray<RecordProblem> =>
			count === 0
				? [{ kind: "no verdict", gate }]
				: count === 2
					? [{ kind: "two verdicts", gate }]
					: []
		),
		...Arr.flatMap(r.cases, (c, i): ReadonlyArray<RecordProblem> => [
			...Arr.map(
				Arr.filter(conditionFields, (field) => Arr.contains(c.empty, field)),
				(field): RecordProblem => ({ kind: "condition", case: caseName(i), field })
			),
			...Arr.map(
				Arr.filter(c.gates, (gate) => !Arr.contains(ids, gate)),
				(gate): RecordProblem => ({ kind: "case gate", case: caseName(i), gate })
			),
			...Arr.map(
				Arr.filter(c.phases, (phase) => !Arr.contains(r.declared, phase)),
				(phase): RecordProblem => ({ kind: "phase undeclared", case: caseName(i), phase })
			)
		]),
		...(Arr.some(r.cases, (c) => Arr.isReadonlyArrayNonEmpty(c.phases))
			? []
			: [{ kind: "no phase timings" } as const])
	]
}

/** A seek's case, for the run records. */
const seekCase: CaseRecord<GateId> = {
	name: "seek",
	gates: ["R05"],
	conditions: {
		workload: "w",
		schemaState: "s",
		dataDistribution: "d",
		parameters: {},
		resultSemantics: "r",
		cacheState: "c"
	},
	phases: { executeMs: timing },
	variants: [],
	comparisons: [],
	transactions: {},
	loads: {},
	measures: {}
}

layer(NodeServices.layer, { excludeTestServices: true })(
	"gate records carry their identity and phases",
	(suite) => {
		suite.effect("name exactly the gaps planted in a record, in the order it is read", (ctx) =>
			Effect.gen(function* () {
				const pin = yield* readPin
				const identity = yield* benchIdentity({
					benchmark: "gate/row-seek",
					server: pinnedServer(pin.version),
					phases: ["executeMs"],
					scope: "a seek",
					options: {},
					source: yield* sourceIdentity
				})
				return yield* searched(
					ctx,
					explore(
						{
							...spec,
							suite: "unit/bench/record-problems",
							draw: drawn(recordGen(catalogIds)),
							oracle: {
								kind: "specification",
								name: "each planted gap, named in the order a record is read"
							},
							coverage: required<RecordProblem["kind"] | "complete">(
								[
									"name",
									"file",
									"benchmark",
									"no verdict",
									"two verdicts",
									"condition",
									"case gate",
									"phase undeclared",
									"no phase timings",
									"complete"
								],
								{ cases: 800, sense: notesOnly }
							),
							runs: 300
						},
						(r, c) =>
							Effect.sync(() => {
								const expected = plantedGaps(r, identity)
								assert.deepEqual(recordProblems(recordOfSketch(r, identity)), expected)
								if (!Arr.isReadonlyArrayNonEmpty(expected)) {
									c.note("complete")
								}
								for (const gap of expected) {
									if (gap.kind !== "identity") {
										c.note(gap.kind)
									}
								}
							})
					)
				)
			})
		)

		type RecordFeature = "run failed" | "release clean" | "release leaked" | "failed run leaked"

		/** What a run or a release failed with. */
		class Failure extends Data.TaggedError("Failure")<{ readonly what: string }> {}

		suite.effect("a run's record keeps its cases when only the release fails", (ctx) =>
			Effect.gen(function* () {
				const pin = yield* readPin
				const gate = defineGate({
					name: "row-seek",
					gates: ["R05"],
					title: "Row seeks",
					scope: "a seek",
					phases: ["executeMs"],
					options: { full: {}, quick: {} },
					run: () => Effect.die(new Error("recordOf never runs a gate"))
				})
				const base = {
					identity: yield* runIdentity({
						benchmark: "gate/row-seek",
						phases: ["executeMs"],
						scope: "a seek",
						options: {},
						source: yield* sourceIdentity
					}),
					file: "bench/query/row-seek.bench.ts",
					quick: true,
					runPhases: { setupMs: 1, runMs: 2 }
				}
				const input: VerdictInput = { checks: [mechanism("Index Cond", true, "on the seek")] }
				const result: GateRun = { cases: [seekCase], verdicts: [{ gate: "R05", input }] }
				yield* searched(
					ctx,
					exhaust(
						{
							oracle: {
								kind: "specification",
								name: "a run's record keeps its cases and verdicts when only its release fails, and names the leak"
							},
							suite: "unit/bench/record-of",
							generator: (source) =>
								[
									source.draw(element(["passed", "failed"] as const)),
									source.draw(element(["clean", "leaked"] as const))
								] as const,
							literal: Formatter.format,
							limit: 4,
							coverage: requiredInSpace<RecordFeature>([
								"run failed",
								"release clean",
								"release leaked",
								"failed run leaked"
							]),
							box: "every run outcome beside every release outcome",
							caseHang
						},
						([ran, released], c) =>
							Effect.sync(() => {
								const run =
									ran === "passed"
										? Exit.succeed({ server: pinnedServer(pin.version), result })
										: Exit.fail(new Failure({ what: "the run failed" }))
								const release =
									released === "clean"
										? Exit.void
										: Exit.fail(new Failure({ what: "a role still had sessions" }))
								const record = recordOf(gate, base, run, release)
								if (ran === "failed") {
									c.note("run failed")
									assertVariant(record, "kind", "failed")
									assert.equal(record.release.kind, released)
									assert.equal(
										Arr.some(gateFindings([record]), (f) => f.kind === "leaked"),
										released === "leaked"
									)
									if (released === "leaked") {
										c.note("failed run leaked")
									}
									return
								}
								assertVariant(record, "kind", "ran")
								assert.deepEqual(record.cases, result.cases)
								switch (released) {
									case "clean":
										c.note("release clean")
										assert.deepEqual(record.release, { kind: "clean" })
										assert.deepEqual(record.verdicts, [verdictOf("R05", input)])
										return
									case "leaked":
										c.note("release leaked")
										assert.equal(record.release.kind, "leaked")
										assert.deepEqual(
											Arr.map(record.verdicts, (v) => v.outcome),
											["error"]
										)
										return
								}
							})
					)
				)
			})
		)
	}
)

layer(NodeServices.layer, { excludeTestServices: true })("the gate catalog", (suite) => {
	suite.effect("gives every catalog gate exactly one bench file, in its owner's directory", (ctx) =>
		Effect.gen(function* () {
			const path = yield* Path.Path
			const discovered = yield* discoverGates(
				Arr.map(
					[...ownerDirectories.query, ...ownerDirectories.write],
					(dir) => `${repoRoot}/${dir}`
				)
			)
			const listed = new Set(catalogIds)
			return yield* searched(
				ctx,
				exhaust(
					{
						suite: "unit/bench/catalog",
						generator: element(catalogIds),
						literal: Formatter.format,
						limit: catalogIds.length,
						coverage: requiredInSpace<"query" | "write">(["query", "write"]),
						box: "every gate of the catalog, against the bench files under the owners' directories",
						oracle: {
							kind: "specification",
							name: "one bench file a gate, in its owner's directory, its sizes alike at both scales"
						},
						caseHang
					},
					(id, c) =>
						Effect.sync(() => {
							c.note(gateOwner(id))
							const covering = Arr.filter(discovered, (d) => Arr.contains(d.gate.gates, id))
							assert.equal(covering.length, 1, id)
							for (const d of covering) {
								assert.ok(
									Arr.contains(ownerDirectories[gateOwner(id)], path.dirname(d.file)),
									`${d.file} covers ${id}`
								)
								assert.deepEqual(
									Arr.sort(Rec.keys(d.gate.options(true)), Order.String),
									Arr.sort(Rec.keys(d.gate.options(false)), Order.String),
									d.file
								)
							}
							assert.deepEqual(
								Arr.filter(
									Arr.flatMap(discovered, (d) => d.gate.gates),
									(gate) => !listed.has(gate)
								),
								[]
							)
						})
				)
			)
		})
	)
})

/** The words a `pnpm bench` command line is drawn from: its commands, its flags, values, and words it never reads. */
const argWords = [
	"gates",
	"list",
	"all",
	"full",
	"cold",
	"dfa",
	"compile",
	"bogus",
	"--quick",
	"--only",
	"--dir",
	"--out",
	"--report",
	"--bogus",
	"R05",
	"R05, ,R06",
	"x"
] as const

const suites = ["cold", "dfa", "compile"] as const
const listedCommands = ["gates", "list", "all"] as const
type Listed = (typeof listedCommands)[number]
const flagsOf: Readonly<Record<Listed, ReadonlyArray<string>>> = {
	gates: ["--quick", "--only", "--dir", "--out", "--report"],
	list: ["--dir"],
	all: ["--quick"]
}

/** The flags a listed command has read. */
interface Flags {
	readonly quick: boolean
	readonly report: boolean
	readonly only: ReadonlyArray<string>
	readonly directories: ReadonlyArray<string>
	readonly out: Option.Option<string>
}

/** What the model reads of a command line: the command, with every value it took, or a refusal. */
type Read =
	| { readonly kind: "refused" }
	| {
			readonly kind: "suite"
			readonly suite: (typeof suites)[number]
			readonly args: ReadonlyArray<string>
	  }
	| { readonly kind: "full" }
	| ({ readonly kind: Listed } & Flags)

/** The flags of `args`, each allowed to `command`, or none when one is not. */
const flagsRead = (
	command: Listed,
	args: ReadonlyArray<string>,
	flags: Flags
): Option.Option<Flags> => {
	const [flag, ...rest] = args
	if (flag === undefined) {
		return Option.some(flags)
	}
	if (!Arr.contains(flagsOf[command], flag)) {
		return Option.none()
	}
	if (flag === "--quick" || flag === "--report") {
		return flagsRead(
			command,
			rest,
			flag === "--quick" ? { ...flags, quick: true } : { ...flags, report: true }
		)
	}
	const [value, ...after] = rest
	if (value === undefined || Str.startsWith("--")(value)) {
		return Option.none()
	}
	return flagsRead(
		command,
		after,
		flag === "--only"
			? {
					...flags,
					only: [
						...flags.only,
						...Arr.filter(Arr.map(Str.split(value, ","), Str.trim), (s) => s !== "")
					]
				}
			: flag === "--dir"
				? { ...flags, directories: [...flags.directories, value] }
				: { ...flags, out: Option.some(value) }
	)
}

/**
 * `pnpm bench`'s grammar: a suite takes every argument after it; `full` takes none; `gates`, `list` and `all` (or no
 * command, which is `gates`) take only their own flags, `--only`, `--dir` and `--out` each with a value that is no
 * flag, `--only` a comma list of gates and names.
 */
const readArgs = (argv: ReadonlyArray<string>): Read => {
	const [first, ...rest] = argv
	const suite = Arr.findFirst(suites, (s) => s === first)
	if (Option.isSome(suite)) {
		return { kind: "suite", suite: suite.value, args: rest }
	}
	const named = first !== undefined && !Str.startsWith("--")(first)
	const command = named ? first : "gates"
	const args = named ? rest : argv
	if (command === "full") {
		return Arr.isReadonlyArrayNonEmpty(args) ? { kind: "refused" } : { kind: "full" }
	}
	return Option.match(
		Arr.findFirst(listedCommands, (c) => c === command),
		{
			onNone: (): Read => ({ kind: "refused" }),
			onSome: (listed): Read =>
				Option.match(
					flagsRead(listed, args, {
						quick: false,
						report: false,
						only: [],
						directories: [],
						out: Option.none()
					}),
					{
						onNone: (): Read => ({ kind: "refused" }),
						onSome: (flags): Read => ({ kind: listed, ...flags })
					}
				)
		}
	)
}

layer(NodeServices.layer, { excludeTestServices: true })("pnpm bench's command line", (suite) => {
	suite.effect(
		"reads exactly what its grammar reads, and refuses every other command line",
		(ctx) =>
			Effect.gen(function* () {
				const path = yield* Path.Path
				return yield* searched(
					ctx,
					explore(
						{
							...spec,
							suite: "unit/bench/command-line",
							draw: drawn(array(element(argWords), { min: 0, max: 5 })),
							oracle: { kind: "second-implementation", name: "a model of pnpm bench's grammar" },
							coverage: required<Read["kind"]>(
								["refused", "suite", "full", "gates", "list", "all"],
								{
									cases: 400,
									sense: notesOnly
								}
							),
							runs: 400
						},
						(argv, c) =>
							Effect.gen(function* () {
								const model = readArgs(argv)
								c.note(model.kind)
								const parsed = yield* Effect.result(parseBenchArgs(argv))
								if (model.kind === "refused") {
									assertVariant(parsed, "_tag", "Failure")
									assert.equal(parsed.failure._tag, "UsageError")
									return
								}
								const command = Result.getOrThrow(parsed)
								switch (model.kind) {
									case "suite":
									case "full":
										assert.deepEqual(command, model)
										return
									case "gates":
									case "list":
									case "all": {
										assertVariant(command, "kind", model.kind)
										const directories = Arr.map(model.directories, (d) => path.resolve(d))
										if (command.kind === "all") {
											assert.equal(command.quick, model.quick)
										}
										if (command.kind !== "all" && Arr.isReadonlyArrayNonEmpty(directories)) {
											assert.deepEqual(command.directories, directories)
										}
										if (command.kind === "gates") {
											assert.deepEqual(
												[command.quick, command.report, command.only],
												[model.quick, model.report, model.only]
											)
											if (Option.isSome(model.out)) {
												assert.equal(command.outDir, path.resolve(model.out.value))
											}
										}
									}
								}
							})
					)
				)
			})
	)
})
