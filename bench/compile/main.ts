#!/usr/bin/env -S node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import {
	Array as Arr,
	Console,
	Data,
	DateTime,
	Effect,
	Option,
	Order,
	pipe,
	Result,
	String as Str
} from "effect"
import {
	type RunIdentity,
	runIdentity,
	sourceIdentity,
	writeRunRecord
} from "#bench/cold/identity.ts"
import { type Measured, type MeasuredCalls, type Phase, phases } from "#bench/compile/measure.ts"
import type { Scale } from "#bench/compile/schema.ts"
import { countedInChild } from "#test/support/kernel/child-counts.ts"

/**
 * The compile benchmark, `pnpm bench compile`: what a large schema costs to build and to compile, with no database, and
 * whether each cost grows linearly in the schema's size.
 *
 * The schema is generated at a scale and at twice it, shaped as a downstream grammar is (qti-pie's Qti): a fixed set of
 * rosters whose handles grow with the scale, closed relations over pairs of them whose rows grow with it, regex domains,
 * and ordinary relations over the domains and rosters, each with a key, two row checks, a containment of a selection of
 * it in a closed relation, and, but for the first, a containment in the one before it; one full role, holding every
 * relation and roster whole and writing every ordinary relation; and one login over the role, owning a workload over the
 * role whose programs are keyed lookups of the first relations. Every count of the schema doubles from the scale to
 * twice it, so a phase whose work is linear in the schema spends about twice the CPU, and one that redoes per statement
 * work that a roster's size measures spends about four times.
 *
 * Each phase runs once per scale, in one counting child (test/support/kernel/child-counts.ts, bench/compile/measure.ts
 * measuredCalls), a process that runs nothing else, in order, each timed by performance.now and process.cpuUsage around
 * it, after one unmeasured run of every phase at the scale, so neither scale's times hold the code's first compilation:
 *
 * - the builders: the rosters, the closed relations, the domains, the ordinary relations, the statements, schema(...),
 *   role(...), the workloads and login(...);
 * - `grizzle generate`, in process, into a scratch directory, and `grizzle check` over what it wrote;
 * - migrate's work before it connects: the configuration resolved, the committed files checked and the migration
 *   targets read, which compiles nothing;
 * - DbLayer.make over the login's served file generate wrote, built in a scope and closed, which loads the file,
 *   compiles nothing and opens no connection.
 *
 * The record, with its full identity, goes to bench/results/compile/compile-<time>.json, one file a run, and a table is
 * printed with each phase's ratio from the scale to twice it, information on this machine. The verdict counts work,
 * never time (test/support/kernel/child-counts.ts): every grizzle function's calls are counted over each scale's phases,
 * and the run fails when a phase failed, its child's failure, and exits 1 when a function's calls at twice the scale are
 * past superlinear over its calls at the scale, the growth work redone per statement over a roster's handles shows.
 */

/** The scale a full run measures, about half a downstream grammar's at twice it, and the quick one. */
const fullScale: Scale = { handles: 80, relations: 60, rows: 3_000, patterns: 60 }
const quickScale: Scale = { handles: 40, relations: 30, rows: 1_500, patterns: 30 }

const doubled = (scale: Scale): Scale => ({
	handles: 2 * scale.handles,
	relations: 2 * scale.relations,
	rows: 2 * scale.rows,
	patterns: 2 * scale.patterns
})

/**
 * A doubling's ratio of calls past which a function's work grows faster than linearly: a function called a linear
 * number of times doubles its calls, one called a quadratic number quadruples them, and the bound is their geometric
 * mean, so the parts of a count that do not grow cannot carry a linear function past it.
 */
const superlinear = 2 * Math.SQRT2

/** A grizzle function whose calls grew past superlinear from the scale to twice it: its calls at each. */
interface Grown {
	readonly fn: string
	readonly calls: number
	readonly twice: number
}

/** The grizzle functions whose calls grew past superlinear from the scale to twice it. */
class SuperlinearGrowth extends Data.TaggedError("SuperlinearGrowth")<{
	readonly grown: Arr.NonEmptyReadonlyArray<Grown>
}> {}

/** A command line the benchmark cannot read. */
class CompileUsage extends Data.TaggedError("CompileUsage")<{ readonly reason: string }> {}

interface CompileRecord {
	readonly identity: RunIdentity
	readonly scales: ReadonlyArray<Measured>
}

const scope =
	"each phase once per scale in one process, its wall time by performance.now and its CPU time by process.cpuUsage around it, every thread's: the builders, grizzle generate and grizzle check in process, migrate's work before it connects (the configuration resolved, the committed files checked, the targets read) and DbLayer.make built and closed in a scope without connecting; the scratch directory's writes are inside generate's time, and memory is not measured"

/**
 * The grizzle functions whose calls at twice the scale are past superlinear over their calls at the scale, most grown
 * first. A function called fewer times at twice the scale than that schema has relations does no work per relation, so
 * it is not judged.
 */
const grownCalls = (
	calls: ReadonlyMap<string, number>,
	twice: ReadonlyMap<string, number>,
	relations: number
): ReadonlyArray<Grown> =>
	Arr.sort(
		Arr.filterMap([...twice], ([fn, n]) => {
			const at = calls.get(fn) ?? 0
			return n >= relations && n > superlinear * at
				? Result.succeed({ fn, calls: at, twice: n })
				: Result.failVoid
		}),
		Order.mapInput(Order.Number, (g: Grown) => g.calls / g.twice)
	)

/** A phase's CPU time at twice the scale over its CPU time at the scale. */
const growth = (phase: Phase, at: Measured, twice: Measured): number =>
	twice.times[phase].cpuMs / Math.max(at.times[phase].cpuMs, 1)

/** A phase's line: its wall and CPU time at the scale and at twice it, and the ratio of its CPU times. */
const row = (phase: Phase, at: Measured, twice: Measured): string => {
	const ms = (x: number) => `${pipe(x.toFixed(1), Str.padStart(10))} ms`
	const a = at.times[phase]
	const b = twice.times[phase]
	return Arr.join(
		[
			`  ${pipe(phase, Str.padEnd(10))}`,
			ms(a.wallMs),
			ms(a.cpuMs),
			ms(b.wallMs),
			ms(b.cpuMs),
			`x${growth(phase, at, twice).toFixed(2)}`
		],
		"  "
	)
}

const main = Effect.gen(function* () {
	const args = yield* Effect.sync((): ReadonlyArray<string> => process.argv.slice(2))
	const unknown = Arr.findFirst(args, (a) => a !== "--quick")
	if (Option.isSome(unknown)) {
		return yield* new CompileUsage({ reason: `unknown argument ${unknown.value}` })
	}
	const scale = Arr.contains(args, "--quick") ? quickScale : fullScale
	const source = yield* sourceIdentity
	const startedAt = yield* DateTime.now
	const measured = yield* countedInChild<MeasuredCalls>(
		{ module: "bench/compile/measure.ts", name: "measuredCalls" },
		{ scale, twice: doubled(scale) }
	)
	const at = measured.at
	const twice = measured.twice
	const calls = new Map(measured.calls)
	const twiceCalls = new Map(measured.twiceCalls)
	yield* Console.info(
		`  phase       ${pipe(`${scale.relations} relations: wall, cpu`, Str.padStart(28))}  ${pipe(`${2 * scale.relations} relations: wall, cpu`, Str.padStart(28))}  cpu ratio`
	)
	yield* Effect.forEach(phases, (phase) => Console.info(row(phase, at, twice)), { discard: true })
	const grown = grownCalls(calls, twiceCalls, doubled(scale).relations)
	const identity = yield* runIdentity({
		benchmark: "compile",
		phases,
		scope,
		options: { scale, startedAt: DateTime.formatIso(startedAt) },
		source
	})
	const record: CompileRecord = { identity, scales: [at, twice] }
	yield* writeRunRecord(startedAt, record)
	if (Arr.isReadonlyArrayNonEmpty(grown)) {
		return yield* new SuperlinearGrowth({ grown })
	}
})

const setStatus = (status: number): Effect.Effect<void> =>
	Effect.sync(() => {
		process.exitCode = status
	})

NodeRuntime.runMain(
	main.pipe(
		Effect.catchTags({
			CompileUsage: (e) => Effect.andThen(Console.error(e.reason), setStatus(2)),
			SuperlinearGrowth: (e) =>
				Effect.andThen(
					Console.error(
						Arr.join(
							[
								`calls grew past x${superlinear.toFixed(2)} from the scale to twice it:`,
								...Arr.map(
									e.grown,
									(g) =>
										`  x${(g.twice / Math.max(g.calls, 1)).toFixed(2)}  ${g.calls} -> ${g.twice}  ${g.fn}`
								)
							],
							"\n"
						)
					),
					setStatus(1)
				)
		}),
		Effect.provide(NodeServices.layer)
	)
)
