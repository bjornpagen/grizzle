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
	pipe,
	Record as Rec,
	Redacted,
	String as Str
} from "effect"
import pgDriver from "pg"
import { defineConfig } from "#adapter/config/define.ts"
import { DbLayer } from "#adapter/public/layer.ts"
import type { MigrationConnectionConfig } from "#adapter/types/config.ts"
import type { DbConnection, PoolBounds } from "#adapter/types/layer.ts"
import { repoRoot, type RunIdentity, runIdentity, sourceIdentity } from "#bench/cold/identity.ts"
import { elapsed } from "#bench/cold/stats.ts"
import { benchConnectTimeout, benchIdleTimeout } from "#bench/harness/limits.ts"
import { checkFiles } from "#cli/check.ts"
import { resolveConfig } from "#cli/config.ts"
import { readTargets } from "#cli/migrate.ts"
import { type ConfigLoader, runCli } from "#cli/run.ts"
import type { Json } from "#compiler/core/canonical.ts"
import { jsonDocument, trusted } from "#compiler/core/trusted.ts"
import { login } from "#compiler/program/workload/login.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import {
	type AnySchema,
	closed,
	contained,
	key,
	on,
	relation,
	schema,
	type Statement
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { role } from "#compiler/schema/world.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type {
	AnyClosed,
	AnyRelation,
	AnyRoster,
	Relation
} from "#compiler/types/schema/relation.ts"
import type { EntryValue } from "#compiler/types/schema/world.ts"
import { snapshotJson } from "#test/support/snapshot-json.ts"

/**
 * The compile benchmark, `pnpm bench compile`: what a large schema costs to build and to compile, with no database.
 *
 * The schema is generated at a scale and at twice it: `relations` ordinary relations, each keyed by one text pattern
 * (every id, parent and code is `^[a-z0-9_]{1,64}$`) in three keys, a primary one and two candidate ones, and each but
 * the first contained in the one before it; a relation whose rows a containment holds to the smaller of two closed
 * relations of `small` and `large` rows, each packed as hex; one full role, holding every relation and roster whole and
 * writing every relation; and one login over the role, owning a workload over the role whose programs are keyed lookups
 * of the first relations.
 *
 * Each phase runs once per scale, in this one process, in order, each timed by performance.now around it:
 *
 * - the builders: the relations and closed relations, schema(...), role(...), the workloads and login(...);
 * - `grizzle generate`, in process, into a scratch directory, and `grizzle check` over what it wrote;
 * - migrate's work before it connects: the configuration resolved, the committed files checked and the migration
 *   targets read, which compiles nothing;
 * - DbLayer.make over the drafted snapshot, built in a scope and closed, which compiles the login's programs and opens
 *   no connection.
 *
 * The record, with its full identity, goes to bench/results/compile/compile-<time>.json, one file a run, and a table is
 * printed with each phase's ratio from the scale to twice it, which is about 2 where a phase grows linearly. The machine
 * is a virtual one, its timings noisy: the record is information, and the exit status reports only whether every phase
 * completed, generate drafting and check passing.
 */

/** The size of a generated schema: its ordinary relations, and the rows of its two closed relations. */
interface Scale {
	readonly relations: number
	readonly small: number
	readonly large: number
}

/** The scale a full run measures, about a downstream application's schema, and the quick one. */
const fullScale: Scale = { relations: 150, small: 20_000, large: 200_000 }
const quickScale: Scale = { relations: 20, small: 1_000, large: 10_000 }

const doubled = (scale: Scale): Scale => ({
	relations: 2 * scale.relations,
	small: 2 * scale.small,
	large: 2 * scale.large
})

/** The phases each scale times, in the order they run. */
const phases = [
	"relations",
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

/** A command line the benchmark cannot read. */
class CompileUsage extends Data.TaggedError("CompileUsage")<{ readonly reason: string }> {}

/** One ordinary relation of the generated schema. */
type Generated = Relation<string, Record<string, FieldBase>, readonly [string, ...Array<string>]>

/** The handles of a roster of `count` handles, each `prefix` and its position. */
const handles = (prefix: string, count: number): readonly [string, ...Array<string>] => [
	`${prefix}0`,
	...Arr.makeBy(count - 1, (i) => `${prefix}${i + 1}`)
]

/**
 * A closed relation of about `rows` rows packed as hex, keyed by two rosters whose sizes multiply to at least `rows`,
 * its rows the first `rows` keys in row-major order, each with a weight.
 */
const closedOf = (name: string, rows: number) => {
	const width = Math.max(1, Math.round(Math.sqrt(rows)))
	const height = Math.ceil(rows / width)
	const A = closed(`${name}A`, handles("a", width))
	const B = closed(`${name}B`, handles("b", height))
	const facts = Arr.makeBy(rows, (i) => ({
		a: `a${Math.floor(i / height)}`,
		b: `b${i % height}`,
		w: i % 1_000
	}))
	const R = closed.relation(
		name,
		{ a: closedId(A), b: closedId(B), w: pg.integer },
		["a", "b"],
		facts,
		{ pack: "hex" }
	)
	return { A, B, R }
}

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
	const [made, relationsSpent] = yield* timed("relations", () => {
		const Ident = str.regex("^[a-z0-9_]{1,64}$")
		const Title = str.regex("^.{1,200}$", "su")
		const Kind = closed("Kind", handles("k", 12))
		const small = closedOf("Small", scale.small)
		const large = closedOf("Large", scale.large)
		const fields: Record<string, FieldBase> = {
			id: Ident,
			parent: Ident,
			code: Ident,
			title: Title,
			kind: closedId(Kind),
			amount: pg.bigint
		}
		const primary: readonly [string, ...Array<string>] = ["id"]
		const ordinary: ReadonlyArray<Generated> = Arr.makeBy(scale.relations, (i) =>
			relation(`R${i}`, fields, primary)
		)
		const Pick = relation("Pick", { id: Ident, a: closedId(small.A), b: closedId(small.B) }, ["id"])
		const declared: Record<string, AnyRelation | AnyClosed> = {
			Kind,
			SmallA: small.A,
			SmallB: small.B,
			Small: small.R,
			LargeA: large.A,
			LargeB: large.B,
			Large: large.R,
			Pick
		}
		for (const r of ordinary) {
			declared[r.name] = r
		}
		const statements: ReadonlyArray<Statement> = [
			contained(on(Pick, "a", "b"), on(small.R, "a", "b")),
			...Arr.flatMap(ordinary, (r, i): ReadonlyArray<Statement> => {
				const below = i === 0 ? undefined : ordinary[i - 1]
				return [
					key(on(r, "code", "kind")),
					key(on(r, "parent", "code")),
					...(below === undefined ? [] : [contained(on(r, "parent"), on(below, "id"))])
				]
			})
		]
		const rosters: ReadonlyArray<AnyRoster> = [Kind, small.A, small.B, large.A, large.B]
		const written: ReadonlyArray<AnyRelation> = [...ordinary, Pick]
		return { declared, statements, ordinary, written, rosters }
	})
	const [base, schemaSpent] = yield* timed("schema", (): AnySchema =>
		schema("Bench", made.declared, made.statements)
	)
	const [app, roleSpent] = yield* timed("role", () => {
		const entries: Record<string, EntryValue> = {}
		for (const r of [...made.written, ...made.rosters]) {
			entries[r.name] = r
		}
		return role(base, "app", entries, {
			write: Arr.map(made.written, (r) => r.name),
			refresh: []
		})
	})
	const [programs, workloadSpent] = yield* timed("workload", () =>
		workload(app, lookups(made.ordinary))
	)
	const [web, loginSpent] = yield* timed("login", () =>
		login(base, "web", [app], { workload: [programs] })
	)
	return {
		base,
		web,
		times: {
			relations: relationsSpent,
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
			`x${(b.cpuMs / Math.max(a.cpuMs, 1)).toFixed(2)}`
		],
		"  "
	)
}

const recordFile = (outDir: string, at: DateTime.Utc): string =>
	`${outDir}/compile-${Str.replaceAll(":", "")(Str.slice(0, 19)(DateTime.formatIso(at)))}.json`

const main = Effect.gen(function* () {
	const args = yield* Effect.sync((): ReadonlyArray<string> => process.argv.slice(2))
	const unknown = Arr.findFirst(args, (a) => a !== "--quick")
	if (Option.isSome(unknown)) {
		return yield* new CompileUsage({ reason: `unknown argument ${unknown.value}` })
	}
	const scale = Arr.contains(args, "--quick") ? quickScale : fullScale
	const fs = yield* FileSystem.FileSystem
	const source = yield* sourceIdentity
	const startedAt = yield* DateTime.now
	const at = yield* measure(scale)
	const twice = yield* measure(doubled(scale))
	yield* Console.info(
		`  phase       ${pipe(`${scale.relations} relations: wall, cpu`, Str.padStart(28))}  ${pipe(`${2 * scale.relations} relations: wall, cpu`, Str.padStart(28))}  cpu ratio`
	)
	yield* Effect.forEach(phases, (phase) => Console.info(row(phase, at, twice)), { discard: true })
	const identity = yield* runIdentity({
		benchmark: "compile",
		phases,
		scope,
		options: { scale, startedAt: DateTime.formatIso(startedAt) },
		source
	})
	const record: CompileRecord = { identity, scales: [at, twice] }
	const outDir = `${repoRoot}/bench/results/compile`
	const out = recordFile(outDir, startedAt)
	yield* fs.makeDirectory(outDir, { recursive: true })
	yield* fs.writeFileString(out, `${jsonDocument(trusted<Json>(record))}\n`)
	yield* Console.info(`record: ${out}`)
})

const setStatus = (status: number): Effect.Effect<void> =>
	Effect.sync(() => {
		process.exitCode = status
	})

NodeRuntime.runMain(
	main.pipe(
		Effect.catchTags({
			CompileUsage: (e) => Effect.andThen(Console.error(e.reason), setStatus(2)),
			PhaseFailed: (e) => Effect.andThen(Console.error(`${e.phase}: ${e.reason}`), setStatus(1))
		}),
		Effect.provide(NodeServices.layer)
	)
)
