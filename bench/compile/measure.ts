/**
 * The compile benchmark's measurement (bench/compile/main.ts): every phase of a generated schema at a scale, each timed,
 * and the work a counting child runs (test/support/kernel/child-counts.ts), a process of its own that runs nothing else,
 * so the calls each scale's phases make are counted across the commands' waits on files with nothing beside them.
 */
import net from "node:net"
import { nonEmpty } from "@bjornpagen/testing/assert"
import {
	Array as Arr,
	Data,
	Effect,
	FileSystem,
	Layer,
	Option,
	Record as Rec,
	Redacted,
	String as Str
} from "effect"
import pgDriver from "pg"
import { defineConfig } from "#adapter/config/define.ts"
import { served } from "#adapter/public/layer.ts"
import type { MigrationConnectionConfig } from "#adapter/types/config.ts"
import type { DbConnection, PoolBounds } from "#adapter/types/layer.ts"
import { elapsed } from "#bench/cold/stats.ts"
import {
	assembledSchema,
	domainOf,
	type Generated,
	ordinaryOf,
	pairsAt,
	rostersAt,
	type Scale,
	statementsOf
} from "#bench/compile/schema.ts"
import { checkFiles } from "#cli/check.ts"
import { resolveConfig } from "#cli/config.ts"
import { processMeter } from "#cli/main.ts"
import { readTargets } from "#cli/migrate.ts"
import { type ConfigLoader, runCli } from "#cli/run.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import { login } from "#compiler/program/workload/login.ts"
import { workload } from "#compiler/program/workload/value.ts"
import type { AnySchema } from "#compiler/public/schema.ts"
import { roleBuilder as role, wholeWritesOf } from "#compiler/schema/world.ts"
import { servedPath } from "#compiler/served/forms.ts"
import type { EntryValue } from "#compiler/types/schema/world.ts"
import type { ChildWork } from "#test/support/kernel/child-counts.ts"
import { offlineDecoders, servedSourcedLayer } from "#test/support/live-layer.ts"
import { upTo } from "#test/support/up-to.ts"

/** The phases each scale times, in the order they run. */
export const phases = [
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

export type Phase = (typeof phases)[number]

/** A phase that refused or failed, and why. */
class PhaseFailed extends Data.TaggedError("PhaseFailed")<{
	readonly phase: Phase
	readonly reason: string
}> {}

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
	const [rosters, rostersSpent] = yield* timed("rosters", () => rostersAt(scale))
	const [pairs, closedSpent] = yield* timed("closed", () => pairsAt(rosters, scale))
	const [domains, domainsSpent] = yield* timed("domains", () =>
		nonEmpty(upTo(scale.patterns, domainOf), "a scale holds one pattern at least")
	)
	const [ordinary, relationsSpent] = yield* timed("relations", () =>
		upTo(scale.relations, (i) => ordinaryOf(i, domains, rosters))
	)
	const [statements, statementsSpent] = yield* timed("statements", () =>
		Arr.flatMap(ordinary, (r, i) =>
			statementsOf(r, i, i === 0 ? undefined : ordinary[i - 1], rosters, pairs)
		)
	)
	const [base, schemaSpent] = yield* timed("schema", (): AnySchema =>
		assembledSchema(rosters, pairs, ordinary, statements)
	)
	const [app, roleSpent] = yield* timed("role", () => {
		const entries: Record<string, EntryValue> = {}
		for (const r of [...ordinary, ...Arr.map(rosters, ({ roster }) => roster)]) {
			entries[r.name] = r
		}
		return role(base, "app", entries, wholeWritesOf(base))
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
	password: Redacted.make("offline")
}

const owner: MigrationConnectionConfig = { ...offline, role: "bench_owner" }

const pool: PoolBounds = { max: 1 }

/** A command line's run in process over the configuration, refused unless it ended with status 0. */
const command = (phase: Phase, argv: ReadonlyArray<string>, cwd: string, load: ConfigLoader) =>
	Effect.flatMap(
		timedEffect(runCli(argv, cwd, process.version, load, processMeter)),
		([report, spent]) =>
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
		rolePrefixBytes: 0,
		connection: () => owner
	})
	const load: ConfigLoader = (at) => Effect.succeed({ file: at, value: config, closure: [] })
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
	const text = yield* fs.readFileString(`${directory}/${servedPath(made.web.name)}`)
	const [, layer] = yield* timedEffect(
		Effect.scoped(
			Layer.build(
				servedSourcedLayer(offlineDecoders, {
					...offline,
					login: served<typeof made.web>(trustedJson<unknown>(text), made.web.name),
					pool
				})
			)
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

export type Measured = Effect.Success<ReturnType<typeof measure>>

/** Whether a module, by its path from the packages' directory, is grizzle's own, the engine's or the shell's. */
const isGrizzle = (file: string): boolean =>
	Str.startsWith("packages/engine/src/")(file) || Str.startsWith("packages/grizzle/src/")(file)

/**
 * What a run counts: each scale's measurement, and every grizzle function's calls over its phases (isGrizzle), by
 * function, as JSON carries them.
 */
export interface MeasuredCalls {
	readonly at: Measured
	readonly calls: ReadonlyArray<readonly [string, number]>
	readonly twice: Measured
	readonly twiceCalls: ReadonlyArray<readonly [string, number]>
}

/**
 * Every phase at `scale` once, unmeasured, so neither scale's times hold the code's first compilation, then at `scale`
 * and at `twice`, each measured and its calls counted in a window of the counting child that runs it.
 */
export const measuredCalls: ChildWork<{ readonly scale: Scale; readonly twice: Scale }> = (
	{ scale, twice },
	counts
) =>
	Effect.gen(function* () {
		yield* measure(scale)
		const [at, calls] = yield* counts.every(measure(scale), isGrizzle)
		const [atTwice, twiceCalls] = yield* counts.every(measure(twice), isGrizzle)
		const measured: MeasuredCalls = {
			at,
			calls: [...calls],
			twice: atTwice,
			twiceCalls: [...twiceCalls]
		}
		return measured
	}).pipe(Effect.orDie)
