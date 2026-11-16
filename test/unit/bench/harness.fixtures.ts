/** What the properties of harness.test.ts read: its spaces, models and helpers. */

import {
	aimed,
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	subarray,
	weighted
} from "@bjornpagen/testing/gen"
import { generate, recorder, simplestChooser } from "@bjornpagen/testing/source"
import { Array as Arr, Data, Effect, Option, Record as Rec, String as Str } from "effect"
import {
	type BenchIdentity,
	identityProblems,
	type ServerIdentity,
	serverSettings
} from "#bench/cold/identity.ts"
import type { Summary } from "#bench/cold/stats.ts"
import {
	type CaseRecord,
	defineGate,
	equivalence,
	type GateCheck,
	type GateRun,
	mechanism,
	type RanRecord,
	type RecordProblem,
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
import { type GateId } from "#bench/harness/rules.ts"
import { type TextRow } from "#bench/harness/variant.ts"
import { StoredRelationName } from "#compiler/core/ids.ts"
import type { UniqueAbort } from "#compiler/runtime/write/steps.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { wild } from "#test/support/kernel/naming.ts"
import {
	type CaptureSketch,
	captureGen,
	capturedAt,
	type PlanFault,
	planFaults,
	plantedFault,
	type Role
} from "#test/unit/bench/captures.ts"

/** What a generated plan's nodes reached: each role, a WAL capture or none, and serialization or none. */
export type CaptureFeature =
	| `a ${Role}`
	| "WAL captured"
	| "WAL not captured"
	| "serialized"
	| "a trigger"

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

const listable: Arr.NonEmptyReadonlyArray<readonly [Named, UniqueAbort["reason"]]> = [
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

/**
 * An operation whose first attempt is a unique or exclusion violation at its statement on a constraint it lists, with a
 * retry left: a unique abort retried, which a drawn script seldom holds.
 */
const uniqueAbortGen: Gen<Retried> = (source) => {
	const times = source.draw(int(1, 3))
	const abort = source.draw(element(listable))
	const [name] = abort
	return {
		times,
		listed: [abort, ...Arr.filter(source.draw(subarray(listable)), ([other]) => other !== name)],
		labelled: source.draw(boolean),
		steps: [
			{
				kind: "refused",
				code: source.draw(element(["23505", "23P01"] as const)),
				constraint: Option.some(name),
				detail: source.draw(boolean) ? Option.some("Reason code: drawn.") : Option.none(),
				at: "statement"
			},
			...source.draw(array(stepGen, { min: times, max: times }))
		]
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
export const reasonOf = (r: Retried, step: Step): DiscardedAttempt["reason"] | undefined => {
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
export const modelOf = (r: Retried): OperationResult => {
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
export const ranOf = (r: Retried): Effect.Effect<OperationResult> => {
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

export type RetryFeature =
	| "committed at once"
	| "committed after a retry"
	| "the policy ran out"
	| "a refusal ended it"
	| "a unique abort retried"
	| "a unique violation not retried"
	| "labelled"

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
export const rowPairGen: Gen<readonly [ReadonlyArray<TextRow>, ReadonlyArray<TextRow>]> = (
	source
) => {
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

export const distinctOf = (rows: ReadonlyArray<TextRow>): number =>
	Arr.filter(rows, (row, i) => !Arr.some(Arr.take(rows, i), (r) => sameRow(r, row))).length

export const sameMultiset = (a: ReadonlyArray<TextRow>, b: ReadonlyArray<TextRow>): boolean =>
	Arr.every([...a, ...b], (row) => countOf(a, row) === countOf(b, row))

export type RowsFeature =
	| "one set"
	| "a repeat told apart"
	| "a row told apart"
	| "one digest"
	| "two digests"

/** A cell a session may deliver: text, NULL, or a value the casts to text rule out. */
export const deliveredGen: Gen<unknown> = element(["t", "", null, 1, true, {}, 0n] as const)

/** A check of a verdict: what it judges, its name, whether it holds. */
export const checkGen: Gen<GateCheck> = (source) => {
	const kind = source.draw(element(["mechanism", "equivalence"] as const))
	const name = source.draw(
		element(["Index Cond on the seek", "same page", "no Unique node"] as const)
	)
	const holds = source.draw(boolean)
	return kind === "mechanism"
		? mechanism(name, holds, "observed")
		: equivalence(name, holds, "observed")
}

/** A server identity that matches the pin, as a run against the local cluster reports it. */
export const pinnedServer = (pinVersion: string): ServerIdentity => ({
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

export const recordGen =
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
export const recordOfSketch = (r: RecordSketch, identity: BenchIdentity): RanRecord => ({
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
export const plantedGaps = (
	r: RecordSketch,
	identity: BenchIdentity
): ReadonlyArray<RecordProblem> => {
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

export type RecordFeature = "run failed" | "release clean" | "release leaked" | "failed run leaked"

/** What a run or a release failed with. */
export class Failure extends Data.TaggedError("Failure")<{ readonly what: string }> {}

export const gate = defineGate({
	name: "row-seek",
	gates: ["R05"],
	title: "Row seeks",
	scope: "a seek",
	phases: ["executeMs"],
	options: { full: {}, quick: {} },
	run: () => Effect.die(new Error("recordOf never runs a gate"))
})

export const input: VerdictInput = { checks: [mechanism("Index Cond", true, "on the seek")] }

export const result: GateRun = { cases: [seekCase], verdicts: [{ gate: "R05", input }] }

/** The words a `pnpm bench` command line is drawn from: its commands, its flags, values, and words it never reads. */
export const argWords = [
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
export type Read =
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
export const readArgs = (argv: ReadonlyArray<string>): Read => {
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

/** A generated capture and a fault planted in it. */
interface FaultCase {
	readonly capture: CaptureSketch
	readonly fault: PlanFault
}

/** A capture `captures` draws, and one of the faults it has a place for. */
const faultIn =
	(captures: Gen<CaptureSketch>): Gen<FaultCase> =>
	(source) => {
		const capture = source.draw(captures)
		const admitted = Arr.filter(planFaults, (fault) =>
			Option.isSome(generate(recorder(), plantedFault(capture, fault), simplestChooser).value)
		)
		return {
			capture,
			fault: source.draw(element(nonEmpty(admitted, "a fault the capture has a place for")))
		}
	}

/** `fault` planted in a capture whose plan is a node of `kind`, which has a place for it. */
const plantedAt =
	(kind: Parameters<typeof capturedAt>[0], fault: PlanFault): Gen<FaultCase> =>
	(source) => ({ capture: source.draw(capturedAt(kind)), fault })

/**
 * A capture and a fault it has a place for; aimed at a fault only one type of node has a place for, a capture whose plan
 * is a node of that type, which few captures hold.
 */
export const faultCases = aimed<FaultCase, PlanFault>(faultIn(captureGen), [
	["a sort's space missing", plantedAt("Sort", "a sort's space missing")],
	["a cache's misses missing", plantedAt("Memoize", "a cache's misses missing")],
	["a hash's batches missing", plantedAt("Hash", "a hash's batches missing")],
	["a sort key not text", plantedAt("Sort", "a sort key not text")]
])

/** An operation with as many scripted attempts as its policy allows, aimed at a unique abort retried. */
export const retriedCases = aimed<Retried, RetryFeature>(retriedGen, [
	["a unique abort retried", uniqueAbortGen]
])
