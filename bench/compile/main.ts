#!/usr/bin/env -S node
import net from "node:net"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import {
	Array as Arr,
	Console,
	Data,
	DateTime,
	Effect,
	FileSystem,
	Layer,
	Option,
	Order,
	pipe,
	Record as Rec,
	Redacted,
	Result,
	String as Str
} from "effect"
import pgDriver from "pg"
import { defineConfig } from "#adapter/config/define.ts"
import { DbLayer } from "#adapter/public/layer.ts"
import type { MigrationConnectionConfig } from "#adapter/types/config.ts"
import type { DbConnection, PoolBounds } from "#adapter/types/layer.ts"
import {
	type RunIdentity,
	runIdentity,
	sourceIdentity,
	writeRunRecord
} from "#bench/cold/identity.ts"
import { elapsed } from "#bench/cold/stats.ts"
import { benchConnectTimeout, benchIdleTimeout } from "#bench/harness/limits.ts"
import { checkFiles } from "#cli/check.ts"
import { resolveConfig } from "#cli/config.ts"
import { readTargets } from "#cli/migrate.ts"
import { type ConfigLoader, runCli } from "#cli/run.ts"
import { defined } from "#compiler/core/invariant.ts"
import { login } from "#compiler/program/workload/login.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import {
	type AnySchema,
	check,
	closed,
	contained,
	key,
	on,
	relation,
	schema,
	select,
	type Statement
} from "#compiler/public/schema.ts"
import { role } from "#compiler/schema/world.ts"
import { regexField } from "#compiler/text/field.ts"
import type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
import type { EntryValue } from "#compiler/types/schema/world.ts"
import { everyCallCount } from "#test/support/kernel/calls.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"

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
 * Each phase runs once per scale, in this one process, in order, each timed by performance.now and process.cpuUsage
 * around it, after one unmeasured run of every phase at the scale, so neither scale's times hold the code's first
 * compilation:
 *
 * - the builders: the rosters, the closed relations, the domains, the ordinary relations, the statements, schema(...),
 *   role(...), the workloads and login(...);
 * - `grizzle generate`, in process, into a scratch directory, and `grizzle check` over what it wrote;
 * - migrate's work before it connects: the configuration resolved, the committed files checked and the migration
 *   targets read, which compiles nothing;
 * - DbLayer.make over the drafted snapshot, built in a scope and closed, which compiles the login's programs and opens
 *   no connection.
 *
 * The record, with its full identity, goes to bench/results/compile/compile-<time>.json, one file a run, and a table is
 * printed with each phase's ratio from the scale to twice it, information on this machine. The verdict counts work,
 * never time (test/support/kernel/calls.ts): every grizzle function's calls are counted over each scale's phases, and
 * the exit status is 1 when a phase failed, and when a function's calls at twice the scale are past superlinear over
 * its calls at the scale, the growth work redone per statement over a roster's handles shows.
 */

/**
 * The size of a generated schema: the handles of each roster, the ordinary relations, the rows of each closed relation,
 * and the regex domains. The rosters and the closed relations over them are a fixed set, so their sizes are what grows.
 */
interface Scale {
	readonly handles: number
	readonly relations: number
	readonly rows: number
	readonly patterns: number
}

/** The scale a full run measures, about half a downstream grammar's at twice it, and the quick one. */
const fullScale: Scale = { handles: 80, relations: 60, rows: 3_000, patterns: 60 }
const quickScale: Scale = { handles: 40, relations: 30, rows: 1_500, patterns: 30 }

const doubled = (scale: Scale): Scale => ({
	handles: 2 * scale.handles,
	relations: 2 * scale.relations,
	rows: 2 * scale.rows,
	patterns: 2 * scale.patterns
})

/** The rosters a generated schema holds; each closed relation is over two neighbouring ones. */
const rosterCount = 8

/**
 * A doubling's ratio of calls past which a function's work grows faster than linearly: a function called a linear
 * number of times doubles its calls, one called a quadratic number quadruples them, and the bound is their geometric
 * mean, so the parts of a count that do not grow cannot carry a linear function past it.
 */
const superlinear = 2 * Math.SQRT2

/** The phases each scale times, in the order they run. */
const phases = [
	"rosters",
	"closed",
	"domains",
	"relations",
	"statements",
	"schema",
	"role",
	"workload",
	"login",
	"generate",
	"check",
	"migrate",
	"layer"
] as const

type Phase = (typeof phases)[number]

/** A phase that refused or failed, and why. */
class PhaseFailed extends Data.TaggedError("PhaseFailed")<{
	readonly phase: Phase
	readonly reason: string
}> {}

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

/** The handles of a roster of `count` handles, each `prefix` and its position. */
const handles = (prefix: string, count: number): readonly [string, ...Array<string>] => [
	`${prefix}0`,
	...Arr.makeBy(count - 1, (i) => `${prefix}${i + 1}`)
]

/** A roster of the generated schema: its handles, and the first, which the statements compare with. */
const rosterOf = (k: number, scale: Scale) => {
	const members = handles(`h${k}_`, scale.handles)
	return { roster: closed(`Ros${k}`, members), first: members[0] }
}

type GeneratedRoster = ReturnType<typeof rosterOf>

/** The member of `items` at position `i`, counting around: how the generated schema assigns its parts. */
const around = <A>(items: Arr.NonEmptyReadonlyArray<A>, i: number): A =>
	defined(items[i % items.length], "a position counted around a nonempty list is in it")

/**
 * The closed relation over the rosters at `k` and the next one: its first `rows` pairs of their handles, in row-major
 * order, each with a weight.
 */
const closedOf = (rosters: Arr.NonEmptyReadonlyArray<GeneratedRoster>, k: number, scale: Scale) => {
	const a = around(rosters, k).roster
	const b = around(rosters, k + 1).roster
	const facts = Arr.makeBy(scale.rows, (i) => ({
		a: `h${k % rosters.length}_${Math.floor(i / scale.handles)}`,
		b: `h${(k + 1) % rosters.length}_${i % scale.handles}`,
		w: i % 1_000
	}))
	return closed.relation(
		`Pairs${k}`,
		{ a: closedId(a), b: closedId(b), w: pg.integer },
		["a", "b"],
		facts
	)
}

/** A regex domain of the generated schema: a pattern of its own, so each is a text analyzed once. */
const domainOf = (i: number) => regexField<string>(`^d${i}_[a-z0-9_]{1,48}$`, ["u"])

/** One ordinary relation of the generated schema: two texts of its domains, two closed ids and a weight. */
const ordinaryOf = (
	i: number,
	domains: Arr.NonEmptyReadonlyArray<ReturnType<typeof domainOf>>,
	rosters: Arr.NonEmptyReadonlyArray<GeneratedRoster>
) =>
	relation(
		`R${i}`,
		{
			id: around(domains, i),
			parent: around(domains, i + 1),
			kind: closedId(around(rosters, i).roster),
			mode: closedId(around(rosters, i + 1).roster),
			weight: pg.integer
		},
		["id"]
	)

/** One ordinary relation of the generated schema. */
type Generated = ReturnType<typeof ordinaryOf>

/**
 * The statements over the ordinary relation at `i`: a key, a row check over its weight and one over its kind, its
 * facts of one mode contained in the closed relation over its rosters, and, but for the first, its parents contained
 * in the ids of the one before it.
 */
const statementsOf = (
	r: Generated,
	i: number,
	below: Generated | undefined,
	rosters: Arr.NonEmptyReadonlyArray<GeneratedRoster>,
	pairs: Arr.NonEmptyReadonlyArray<ReturnType<typeof closedOf>>
): ReadonlyArray<Statement> => [
	key(on(r, "parent", "kind")),
	check(`Weighed${i}`, r, (row) => row.ge(row.weight, 0)),
	check(`Kinded${i}`, r, (row) => row.ne(row.kind, around(rosters, i).first)),
	contained(
		on(
			select(r, (row) => row.eq(row.mode, around(rosters, i + 1).first)),
			"kind",
			"mode"
		),
		on(around(pairs, i), "a", "b")
	),
	...(below === undefined ? [] : [contained(on(r, "parent"), on(below, "id"))])
]

/** How many relations the workload looks up by key. */
const lookedUp = 12

/** The keyed lookups of the first relations, each under its relation's name, as a workload's programs. */
const lookups = (relations: ReadonlyArray<Generated>): Readonly<Record<string, Generated>> =>
	Rec.fromEntries(Arr.map(Arr.take(relations, lookedUp), (r) => [`by${r.name}`, r] as const))

/**
 * What a phase spent: its wall time, and the process's CPU time, user and system over every thread, which load from
 * other processes on a shared machine inflates far less than it inflates wall time.
 */
interface Spent {
	readonly wallMs: number
	readonly cpuMs: number
}

/** The microseconds process.cpuUsage counts in a millisecond. */
const microsPerMilli = 1_000

/** The process's CPU time so far, in milliseconds. */
const cpuNow = (): number => {
	const usage = process.cpuUsage()
	return (usage.user + usage.system) / microsPerMilli
}

/** A phase's start: its wall clock and its CPU time. */
const startOf = () => ({ wall: performance.now(), cpu: cpuNow() })

const spentSince = (start: ReturnType<typeof startOf>): Spent => ({
	wallMs: elapsed(start.wall),
	cpuMs: Math.round((cpuNow() - start.cpu) * microsPerMilli) / microsPerMilli
})

/** What a synchronous step spends, with what it made; a step that throws is the phase's failure. */
const timed = <A>(phase: Phase, step: () => A): Effect.Effect<readonly [A, Spent], PhaseFailed> =>
	Effect.try({
		try: () => {
			const start = startOf()
			const value = step()
			return [value, spentSince(start)] as const
		},
		catch: (cause) => new PhaseFailed({ phase, reason: String(cause) })
	})

/** What an Effect spends, with what it made. */
const timedEffect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const start = yield* Effect.sync(startOf)
		const value = yield* effect
		const spent = yield* Effect.sync(() => spentSince(start))
		return [value, spent] as const
	})

/** Every builder at `scale`, each timed. */
const build = Effect.fn("build")(function* (scale: Scale) {
	const [rosters, rostersSpent] = yield* timed("rosters", () =>
		Arr.makeBy(rosterCount, (k) => rosterOf(k, scale))
	)
	const [pairs, closedSpent] = yield* timed("closed", () =>
		Arr.makeBy(rosterCount, (k) => closedOf(rosters, k, scale))
	)
	const [domains, domainsSpent] = yield* timed("domains", () =>
		Arr.makeBy(scale.patterns, domainOf)
	)
	const [ordinary, relationsSpent] = yield* timed("relations", () =>
		Arr.makeBy(scale.relations, (i) => ordinaryOf(i, domains, rosters))
	)
	const [statements, statementsSpent] = yield* timed("statements", () =>
		Arr.flatMap(ordinary, (r, i) =>
			statementsOf(r, i, i === 0 ? undefined : ordinary[i - 1], rosters, pairs)
		)
	)
	const declared: Record<string, AnyRelation | AnyClosed> = {}
	for (const { roster } of rosters) {
		declared[roster.name] = roster
	}
	for (const r of [...pairs, ...ordinary]) {
		declared[r.name] = r
	}
	const [base, schemaSpent] = yield* timed("schema", (): AnySchema =>
		schema("Bench", declared, statements)
	)
	const [app, roleSpent] = yield* timed("role", () => {
		const entries: Record<string, EntryValue> = {}
		for (const r of [...ordinary, ...Arr.map(rosters, ({ roster }) => roster)]) {
			entries[r.name] = r
		}
		return role(base, "app", entries, {
			write: Arr.map(ordinary, (r) => r.name),
			refresh: []
		})
	})
	const [programs, workloadSpent] = yield* timed("workload", () => workload(app, lookups(ordinary)))
	const [web, loginSpent] = yield* timed("login", () =>
		login(base, "web", [app], { workload: [programs] })
	)
	return {
		base,
		web,
		times: {
			rosters: rostersSpent,
			closed: closedSpent,
			domains: domainsSpent,
			relations: relationsSpent,
			statements: statementsSpent,
			schema: schemaSpent,
			role: roleSpent,
			workload: workloadSpent,
			login: loginSpent
		}
	}
})

/** Where no session of the layer connects: the layer builds without connecting, and nothing here opens a Db. */
const offline: DbConnection = {
	driver: pgDriver,
	transport: {
		kind: "sslRequest",
		host: "localhost",
		port: 5432,
		open: () => new net.Socket(),
		ca: "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n",
		servername: "localhost"
	},
	database: "offline",
	password: Redacted.make("offline"),
	connectTimeoutMs: benchConnectTimeout.value
}

const owner: MigrationConnectionConfig = { ...offline, role: "bench_owner" }

const pool: PoolBounds = { max: 1, min: 0, idleTimeoutMs: benchIdleTimeout.value }

/** A command line's run in process over the configuration, refused unless it ended with status 0. */
const command = (phase: Phase, argv: ReadonlyArray<string>, cwd: string, load: ConfigLoader) =>
	Effect.flatMap(timedEffect(runCli(argv, cwd, load)), ([report, spent]) =>
		report.code === 0
			? Effect.succeed(spent)
			: Effect.fail(
					new PhaseFailed({ phase, reason: Arr.join([...report.stdout, ...report.stderr], "\n") })
				)
	)

/** Every phase at one scale, in a scratch directory removed when it ends. */
const measure = Effect.fn("measure")(function* (scale: Scale) {
	const made = yield* build(scale)
	const fs = yield* FileSystem.FileSystem
	const dir = yield* fs.makeTempDirectoryScoped({ prefix: "grizzle-bench-compile-" })
	const file = `${dir}/grizzle.config.ts`
	const config = defineConfig({
		schemas: [made.base],
		logins: [made.web],
		migrations: "migrations",
		connection: owner
	})
	const load: ConfigLoader = (at) => Effect.succeed({ file: at, value: config })
	const generate = yield* command("generate", ["generate", file, "--name", "init"], dir, load)
	const check = yield* command("check", ["check", file], dir, load)
	const [resolved, migrate] = yield* timedEffect(
		Effect.gen(function* () {
			const resolved = yield* resolveConfig(config, file)
			const checks = yield* checkFiles(resolved, dir)
			yield* readTargets(resolved)
			return { resolved, findings: Arr.flatMap(checks, (c) => c.findings) }
		})
	)
	if (Arr.isReadonlyArrayNonEmpty(resolved.findings)) {
		return yield* new PhaseFailed({
			phase: "migrate",
			reason: `the committed files have ${resolved.findings.length} findings`
		})
	}
	const directory = Option.getOrUndefined(Arr.head(resolved.resolved.schemas))?.directory
	if (directory === undefined) {
		return yield* new PhaseFailed({ phase: "layer", reason: "the configuration lists no schema" })
	}
	const text = yield* fs.readFileString(`${directory}/snapshot.json`)
	const [, layer] = yield* timedEffect(
		Effect.scoped(
			Layer.build(DbLayer.make({ ...offline, login: made.web, snapshot: snapshotJson(text), pool }))
		)
	)
	const times: Readonly<Record<Phase, Spent>> = {
		...made.times,
		generate,
		check,
		migrate,
		layer
	}
	return { scale, times }
}, Effect.scoped)

type Measured = Effect.Success<ReturnType<typeof measure>>

interface CompileRecord {
	readonly identity: RunIdentity
	readonly scales: ReadonlyArray<Measured>
}

const scope =
	"each phase once per scale in one process, its wall time by performance.now and its CPU time by process.cpuUsage around it, every thread's: the builders, grizzle generate and grizzle check in process, migrate's work before it connects (the configuration resolved, the committed files checked, the targets read) and DbLayer.make built and closed in a scope without connecting; the scratch directory's writes are inside generate's time, and memory is not measured"

/** Whether a module, by its path from the packages' directory, is grizzle's own, the engine's or the shell's. */
const isGrizzle = (file: string): boolean =>
	Str.startsWith("packages/engine/src/")(file) || Str.startsWith("packages/grizzle/src/")(file)

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
	yield* measure(scale)
	const [at, calls] = yield* everyCallCount(measure(scale), isGrizzle)
	const [twice, twiceCalls] = yield* everyCallCount(measure(doubled(scale)), isGrizzle)
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
			PhaseFailed: (e) => Effect.andThen(Console.error(`${e.phase}: ${e.reason}`), setStatus(1)),
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
