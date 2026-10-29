import {
	Array as Arr,
	Effect,
	type FileSystem,
	Option,
	Record as Rec,
	Result,
	Schema,
	type Scope,
	String as Str
} from "effect"

import {
	type BenchIdentity,
	type IdentityProblem,
	identityProblems,
	type RunIdentity,
	type ServerIdentity
} from "#bench/cold/identity.ts"
import type { Summary } from "#bench/cold/stats.ts"
import type { LoadMeasure } from "#bench/harness/load.ts"
import type { GateId } from "#bench/harness/rules.ts"
import type { ReachedSummary, TransactionSeries } from "#bench/harness/transaction.ts"
import type { VariantComparison, VariantMeasure } from "#bench/harness/variant.ts"
import type { Substrate, SubstrateShape } from "#test/support/substrate/substrate.ts"

import { regex } from "arkregex"
/**
 * A gate's bench file, its verdicts and its record. `pnpm bench` writes JSON records with the git sha, the PostgreSQL
 * pin and phase timings; every gate of the catalog (rules.ts) has a bench file and a recorded verdict.
 *
 * A bench file under bench/query, bench/write or bench/queue is named `<name>.bench.ts` and default-exports
 * `defineGate({...})`: the gates it covers, what it measures, the phases its records time, its sizes at full and quick
 * scale, and its run, an Effect in a database of its own (Substrate.isolatedLayer), which returns its cases and one
 * verdict per gate it covers, a missing or a foreign one being a compile error. The runner (runner.ts) supplies the database, the server identity and the scale,
 * and writes the record.
 *
 * A verdict judges a gate by checks, each tagged by what it judges:
 * - mechanism checks: what the plan or the catalog must show (an Index Cond on the seek, one aggregate node, no Unique
 *   node, a law function removed);
 * - equivalence checks: semantic agreement (the generated and handwritten answers are equal multisets, the two
 *   lowerings agree, no repeated row).
 * Measurements are what the cases record: information on this machine, never a verdict (the local machine's timings
 * are treated as noisy). A verdict holds at least one check. It is `fail` when any check fails and `pass` otherwise; the
 * runner records `error` for every gate of a run whose release leaked or whose record is incomplete.
 */
export type CheckKind = "mechanism" | "equivalence"

export interface GateCheck {
	readonly kind: CheckKind
	readonly name: string
	readonly holds: boolean
	/** What was observed: the reader's evidence whether the check holds or not. */
	readonly detail: string
}

export const mechanism = (name: string, holds: boolean, detail: string): GateCheck => ({
	kind: "mechanism",
	name,
	holds,
	detail
})

export const equivalence = (name: string, holds: boolean, detail: string): GateCheck => ({
	kind: "equivalence",
	name,
	holds,
	detail
})

export interface VerdictInput {
	readonly checks: Arr.NonEmptyReadonlyArray<GateCheck>
}

/** A gate's recorded verdict. `error`: the run's release leaked or its record is incomplete, so no verdict stands. */
export type VerdictRecord =
	| { readonly gate: GateId; readonly outcome: "pass"; readonly checks: ReadonlyArray<GateCheck> }
	| {
			readonly gate: GateId
			readonly outcome: "fail"
			readonly failing: Arr.NonEmptyReadonlyArray<string>
			readonly checks: ReadonlyArray<GateCheck>
	  }
	| {
			readonly gate: GateId
			readonly outcome: "error"
			readonly cause: string
			readonly checks: ReadonlyArray<GateCheck>
	  }

/** `missing`: no record covers the gate. */
export type GateOutcome = VerdictRecord["outcome"] | "missing"

export const gateOutcomes = [
	"pass",
	"fail",
	"error",
	"missing"
] as const satisfies ReadonlyArray<GateOutcome>

/** A failing check fails the verdict; one whose every check holds passes. */
export const verdictOf = (gate: GateId, input: VerdictInput): VerdictRecord => {
	const failing = Arr.map(
		Arr.filter(input.checks, (c) => !c.holds),
		(c) => c.name
	)
	if (Arr.isReadonlyArrayNonEmpty(failing)) {
		return { gate, outcome: "fail", failing, checks: input.checks }
	}
	return { gate, outcome: "pass", checks: input.checks }
}

const encodeJsonText = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown))

/**
 * A value as one line of JSON, for the text of a measure or a check's detail. A value JSON cannot hold (a bigint) is a
 * defect of the gate that renders it.
 */
export const jsonText = (value: unknown): string => Result.getOrThrow(encodeJsonText(value))

/** Why a verdict is what it is, in a line. The first line of a text: all of it when it has no line break. */
export const firstLine = (text: string): string =>
	Option.match(Str.indexOf("\n")(text), {
		onNone: () => text,
		onSome: (end) => Str.slice(0, end)(text)
	})

export const verdictReason = (v: VerdictRecord): string => {
	switch (v.outcome) {
		case "pass":
			return "pass"
		case "fail":
			return Arr.join(v.failing, "; ")
		case "error":
			return v.cause
	}
}

/**
 * What a case ran under: schema and index state, data distribution, parameters, result semantics and cache state (every
 * transaction is SERIALIZABLE, so no case states its isolation); the samples sit on each measurement.
 */
export interface Conditions {
	readonly workload: string
	readonly schemaState: string
	readonly dataDistribution: string
	readonly parameters: Readonly<Record<string, unknown>>
	readonly resultSemantics: string
	readonly cacheState: string
}

export type Measure = number | string | boolean | Summary | ReadonlyArray<number>

export interface CaseRecord<K extends GateId> {
	readonly name: string
	readonly gates: Arr.NonEmptyReadonlyArray<K>
	readonly conditions: Conditions
	/** Phases the case timed itself, outside any variant, transaction or load. */
	readonly phases: Readonly<Record<string, Summary>>
	readonly variants: ReadonlyArray<VariantMeasure>
	readonly comparisons: ReadonlyArray<VariantComparison>
	readonly transactions: Readonly<Record<string, TransactionSeries>>
	readonly loads: Readonly<Record<string, LoadMeasure>>
	readonly measures: Readonly<Record<string, Measure>>
}

export interface GateResult<K extends GateId> {
	readonly cases: ReadonlyArray<CaseRecord<K>>
	readonly verdicts: { readonly [P in K]: VerdictInput }
}

export interface GateContext<O> {
	readonly quick: boolean
	readonly options: O
	readonly server: ServerIdentity
	readonly substrate: SubstrateShape
}

/** @internal */
export interface GateSpec<
	G extends readonly [GateId, ...ReadonlyArray<GateId>],
	O extends Readonly<Record<string, unknown>>,
	E extends Error
> {
	/**
	 * Unique across bench files: the record's file name, bench/results/gates/<name>.<scale>.json. Lowercase, digits and
	 * dashes.
	 */
	readonly name: string
	readonly gates: G
	readonly title: string
	/** What the gate measures and what it leaves out. */
	readonly scope: string
	/** Every phase name its records time. */
	readonly phases: readonly [string, ...ReadonlyArray<string>]
	/** Its sizes and sample counts at full scale and at the quick scale tests and `--quick` use. */
	readonly options: { readonly full: O; readonly quick: O }
	readonly run: (
		context: GateContext<O>
	) => Effect.Effect<GateResult<G[number]>, E, Substrate | Scope.Scope | FileSystem.FileSystem>
}

const gateBrand: unique symbol = Symbol.for("grizzle/bench/gate")

/**
 * A defined gate's run with its gate ids erased: its cases, and the verdict input of each gate it covers, in the order
 * its file lists them.
 */
export interface GateRun {
	readonly cases: ReadonlyArray<CaseRecord<GateId>>
	readonly verdicts: ReadonlyArray<{ readonly gate: GateId; readonly input: VerdictInput }>
}

/**
 * A defined gate, with its options type erased: what a bench file exports and the runner runs.
 *
 * @internal
 */
export interface Gate {
	readonly [gateBrand]: true
	readonly name: string
	readonly gates: Arr.NonEmptyReadonlyArray<GateId>
	readonly title: string
	readonly scope: string
	readonly phases: ReadonlyArray<string>
	readonly options: (quick: boolean) => Readonly<Record<string, unknown>>
	readonly run: (
		context: GateContext<Readonly<Record<string, unknown>>>
	) => Effect.Effect<GateRun, Error, Substrate | Scope.Scope | FileSystem.FileSystem>
}

/** A gate file that does not define a gate: its name, ids, phases or options are not what a gate's must be. */
class InvalidGate extends Schema.TaggedError<InvalidGate, { readonly brand: unique symbol }>()(
	"InvalidGate",
	{
		what: Schema.String
	}
) {
	override get message(): string {
		return `invalid gate: ${this.what}`
	}
}

const namePattern = regex("^[a-z0-9]+(?:-[a-z0-9]+)*$")

/**
 * The admission core of defineGate: what the spec's types do not say, its name's form, no gate or phase listed twice,
 * and a title and scope.
 */
const admitGateSpec = (spec: {
	readonly name: string
	readonly gates: ReadonlyArray<GateId>
	readonly phases: ReadonlyArray<string>
	readonly title: string
	readonly scope: string
}): void => {
	if (!namePattern.test(spec.name)) {
		throw InvalidGate.make({ what: `name ${jsonText(spec.name)}` })
	}
	if (new Set(spec.gates).size !== spec.gates.length) {
		throw InvalidGate.make({ what: `${spec.name}: a gate listed twice` })
	}
	if (new Set(spec.phases).size !== spec.phases.length) {
		throw InvalidGate.make({ what: `${spec.name}: a phase listed twice` })
	}
	if (spec.title === "" || spec.scope === "") {
		throw InvalidGate.make({ what: `${spec.name}: no title or scope` })
	}
}

/** Each covered gate's verdict input, in the order the gates are listed. */
const coveredVerdicts = <K extends GateId>(
	gates: ReadonlyArray<K>,
	verdicts: { readonly [P in K]: VerdictInput }
): GateRun["verdicts"] => Arr.map(gates, (gate) => ({ gate, input: verdicts[gate] }))

export const defineGate = <
	const G extends readonly [GateId, ...ReadonlyArray<GateId>],
	O extends Readonly<Record<string, unknown>>,
	E extends Error
>(
	spec: GateSpec<G, O, E>
): Gate => {
	admitGateSpec(spec)
	const optionsOf = (quick: boolean): O => (quick ? spec.options.quick : spec.options.full)
	return {
		[gateBrand]: true,
		name: spec.name,
		gates: spec.gates,
		title: spec.title,
		scope: spec.scope,
		phases: spec.phases,
		options: optionsOf,
		run: (context) =>
			Effect.map(spec.run({ ...context, options: optionsOf(context.quick) }), (result) => ({
				cases: result.cases,
				verdicts: coveredVerdicts<G[number]>(spec.gates, result.verdicts)
			}))
	}
}

export const isGate = (value: unknown): value is Gate =>
	typeof value === "object" && value !== null && gateBrand in value && value[gateBrand] === true

/** How the run's database was released: cleanly, or with what it left behind (the substrate's leak report). */
export type Release =
	| { readonly kind: "clean" }
	| { readonly kind: "leaked"; readonly report: string }

/** The record of a run that returned: bench/results/gates/<name>.<scale>.json. */
export interface RanRecord {
	readonly kind: "ran"
	readonly identity: BenchIdentity
	readonly name: string
	/** Repository-relative. */
	readonly file: string
	readonly title: string
	readonly gates: ReadonlyArray<GateId>
	readonly quick: boolean
	/** The run's own phases: setupMs (the database and the server identity) and runMs (the gate's run). */
	readonly runPhases: { readonly setupMs: number; readonly runMs: number }
	readonly release: Release
	readonly verdicts: ReadonlyArray<VerdictRecord>
	readonly cases: ReadonlyArray<CaseRecord<GateId>>
	/** Why the record is incomplete (recordProblems), none for a complete one. */
	readonly problems: ReadonlyArray<RecordProblem>
}

/**
 * The record of a run that failed: bench/results/gates/<name>.<scale>.failed.json. It never reached a server identity,
 * so it has none; its database was released all the same, cleanly or not.
 */
export interface FailedRecord {
	readonly kind: "failed"
	readonly identity: RunIdentity
	readonly name: string
	readonly file: string
	readonly title: string
	readonly gates: ReadonlyArray<GateId>
	readonly quick: boolean
	readonly runPhases: { readonly setupMs: number; readonly runMs: number }
	readonly release: Release
	readonly cause: string
}

export type GateRecord = RanRecord | FailedRecord

/** The phase names a case times, wherever it records them. */
const casePhaseNames = (c: CaseRecord<GateId>): ReadonlyArray<string> => [
	...new Set([
		...Rec.keys(c.phases),
		...Arr.flatMap(c.variants, (v) => Rec.keys(v.phases)),
		...Arr.flatMap(Rec.values(c.transactions), (t) => Rec.keys<string, ReachedSummary>(t.phases))
	])
]

const conditionFields = [
	"workload",
	"schemaState",
	"dataDistribution",
	"resultSemantics",
	"cacheState"
] as const

/** One gap in a record: what a reader needs to know what the record holds, by what, where, and with which verdict. */
export type RecordProblem =
	| { readonly kind: "identity"; readonly problem: IdentityProblem }
	| { readonly kind: "name" }
	| { readonly kind: "file" }
	| { readonly kind: "benchmark" }
	| { readonly kind: "no verdict"; readonly gate: GateId }
	| { readonly kind: "two verdicts"; readonly gate: GateId }
	| {
			readonly kind: "condition"
			readonly case: string
			readonly field: (typeof conditionFields)[number]
	  }
	| { readonly kind: "case gate"; readonly case: string; readonly gate: GateId }
	| { readonly kind: "phase undeclared"; readonly case: string; readonly phase: string }
	| { readonly kind: "no phase timings" }

/** Why a record is incomplete: every gap, in the order the record is read. */
export const recordProblems = (record: RanRecord): ReadonlyArray<RecordProblem> => {
	const problems: Array<RecordProblem> = Arr.map(identityProblems(record.identity), (problem) => ({
		kind: "identity",
		problem
	}))
	const need = (ok: boolean, problem: RecordProblem) => {
		if (!ok) {
			problems.push(problem)
		}
	}
	need(namePattern.test(record.name), { kind: "name" })
	need(Str.endsWith(".bench.ts")(record.file), { kind: "file" })
	need(record.identity.benchmark === `gate/${record.name}`, { kind: "benchmark" })
	for (const gate of record.gates) {
		const verdicts = Arr.filter(record.verdicts, (v) => v.gate === gate).length
		need(verdicts > 0, { kind: "no verdict", gate })
		need(verdicts < 2, { kind: "two verdicts", gate })
	}
	const declared = new Set(record.identity.phases)
	let timed = false
	for (const c of record.cases) {
		for (const field of conditionFields) {
			need(c.conditions[field] !== "", { kind: "condition", case: c.name, field })
		}
		for (const gate of c.gates) {
			need(record.gates.includes(gate), { kind: "case gate", case: c.name, gate })
		}
		for (const phase of casePhaseNames(c)) {
			timed = true
			need(declared.has(phase), { kind: "phase undeclared", case: c.name, phase })
		}
	}
	need(timed, { kind: "no phase timings" })
	return problems
}

/**
 * What a run of gates found: a run that failed, a release that leaked, an incomplete record, or a check that does not
 * hold.
 */
export type GateFinding =
	| { readonly kind: "failed"; readonly file: string; readonly cause: string }
	| { readonly kind: "leaked"; readonly file: string; readonly report: string }
	| {
			readonly kind: "check"
			readonly gate: GateId
			readonly check: string
			readonly detail: string
	  }
	| {
			readonly kind: "incomplete-record"
			readonly file: string
			readonly problems: ReadonlyArray<RecordProblem>
	  }

export const gateFindings = (records: ReadonlyArray<GateRecord>): ReadonlyArray<GateFinding> =>
	Arr.flatMap(records, (record): ReadonlyArray<GateFinding> => {
		const leaked: ReadonlyArray<GateFinding> =
			record.release.kind === "leaked"
				? [{ kind: "leaked", file: record.file, report: record.release.report }]
				: []
		if (record.kind === "failed") {
			return [{ kind: "failed", file: record.file, cause: record.cause }, ...leaked]
		}
		const incomplete: ReadonlyArray<GateFinding> =
			record.problems.length === 0
				? []
				: [{ kind: "incomplete-record", file: record.file, problems: record.problems }]
		const checks = Arr.flatMap(record.verdicts, (v): ReadonlyArray<GateFinding> =>
			v.outcome === "fail"
				? Arr.map(
						Arr.filter(v.checks, (c) => !c.holds),
						(c) => ({ kind: "check", gate: v.gate, check: c.name, detail: c.detail })
					)
				: []
		)
		return [...leaked, ...incomplete, ...checks]
	})
