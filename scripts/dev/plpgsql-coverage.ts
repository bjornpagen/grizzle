#!/usr/bin/env -S node
import { NodeRuntime } from "@effect/platform-node"
import {
	Array as Arr,
	Config,
	Console,
	Data,
	Effect,
	Inspectable,
	Number as Num,
	Option,
	Order,
	Record,
	Redacted,
	type Scope,
	String as Str
} from "effect"
import { Client } from "pg"
import { trusted } from "#compiler/core/trusted.ts"
import { isolationGuardName } from "#compiler/physical/ddl/isolation.ts"
import { refusalFunctionName } from "#compiler/write/refusal.ts"

/** The kinds of PL/pgSQL function grizzle installs, and `other` for any other PL/pgSQL function in its schemas. */
export const kinds = [
	"law function",
	"advance function",
	"below-SERIALIZABLE guard",
	"refusal function",
	"other"
] as const
export type Kind = (typeof kinds)[number]

/**
 * The kind of a function, by the name the compiler gives it: `__law_<law>` for a residual law's function,
 * `__advance_<table>__<column>` for a serial field's advance function, the isolation guard's and the refusal
 * function's fixed names.
 */
const kindOf = (name: string): Kind => {
	if (Str.startsWith("__law_")(name)) {
		return "law function"
	}
	if (Str.startsWith("__advance_")(name)) {
		return "advance function"
	}
	if (name === isolationGuardName) {
		return "below-SERIALIZABLE guard"
	}
	return name === refusalFunctionName ? "refusal function" : "other"
}

/** The database or server the reader refuses. It reports the reason and exits with status 2. */
export class CoverageRefused extends Data.TaggedError("CoverageRefused")<{
	readonly reason: string
}> {}

/** A statement the server failed. */
export class QueryFailed extends Data.TaggedError("QueryFailed")<{
	readonly sql: string
	readonly cause: unknown
}> {}

/** One query: its text and its parameters. */
interface Query {
	readonly client: Client
	readonly sql: string
	readonly params: ReadonlyArray<string | number>
}

/** The rows of a query, as the driver returns them: of the row type its SQL selects. */
const query = (q: Query): Effect.Effect<ReadonlyArray<unknown>, QueryFailed> =>
	Effect.map(
		Effect.tryPromise({
			try: () => q.client.query({ text: q.sql, values: [...q.params] }),
			catch: (cause) => new QueryFailed({ sql: q.sql, cause })
		}),
		(result): ReadonlyArray<unknown> => result.rows
	)

/** The one row a scalar query returns; any other count is a defect of the query. */
const oneRow = <A>(rows: ReadonlyArray<A>): Effect.Effect<A> => {
	const [row, ...more] = rows
	return row !== undefined && more.length === 0
		? Effect.succeed(row)
		: Effect.die(`a scalar query returned ${rows.length} rows`)
}

const run = (client: Client, sql: string): Effect.Effect<void, QueryFailed> =>
	Effect.asVoid(query({ client, sql, params: [] }))

interface FunctionRow {
	readonly oid: number
	readonly schema: string
	readonly name: string
	readonly args: string
}

interface StatementRow {
	readonly lineno: number
	readonly stmtname: string
	readonly exec_stmts: number
}

interface LineRow {
	readonly lineno: number
	readonly source: string
}

interface RatioRow {
	readonly ratio: number
}

/**
 * The PL/pgSQL functions of grizzle's schemas: every schema that holds the isolation guard, which every schema grizzle
 * installs holds.
 */
const functionsSql = `
SELECT p.oid::int4 AS oid, n.nspname::text AS schema, p.proname::text AS name,
	pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
FROM pg_catalog.pg_proc AS p
JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang
WHERE l.lanname = 'plpgsql'
	AND EXISTS (SELECT FROM pg_catalog.pg_proc AS g WHERE g.pronamespace = n.oid AND g.proname = $1::name)
ORDER BY 2, 3, 4`

/**
 * One function's coverage: its kind, its signature, its statements executed of all, its branch ratio, and each
 * statement no run executed with its source line.
 */
interface PlpgsqlFunctionCoverage {
	readonly kind: Kind
	readonly signature: string
	readonly statements: number
	readonly executed: number
	readonly branches: number
	readonly uncovered: ReadonlyArray<string>
}

/** The coverage of one function, read through the extension's functions in `ext`. */
const coverageOf = Effect.fn("coverageOf")(function* (input: {
	readonly client: Client
	readonly ext: string
	readonly fn: FunctionRow
}) {
	const { client, ext, fn } = input
	const statementRows = yield* query({
		client,
		sql: `SELECT lineno, stmtname, coalesce(exec_stmts, 0)::int4 AS exec_stmts FROM ${ext}.plpgsql_profiler_function_statements_tb($1::oid::regprocedure) WHERE lineno > 0 ORDER BY stmtid`,
		params: [fn.oid]
	})
	const lineRows = yield* query({
		client,
		sql: `SELECT lineno, coalesce(source, '') AS source FROM ${ext}.plpgsql_profiler_function_tb($1::oid::regprocedure)`,
		params: [fn.oid]
	})
	const ratioRows = yield* query({
		client,
		sql: `SELECT ${ext}.plpgsql_coverage_branches($1::oid::regprocedure) AS ratio`,
		params: [fn.oid]
	})
	const statements = trusted<ReadonlyArray<StatementRow>>(statementRows)
	const lines = trusted<ReadonlyArray<LineRow>>(lineRows)
	const branches = yield* oneRow(trusted<ReadonlyArray<RatioRow>>(ratioRows))
	const sourceOf = Record.fromEntries(
		Arr.map(lines, (l) => [String(l.lineno), Str.trim(l.source)] as const)
	)
	const unexecuted = Arr.filter(statements, (s) => s.exec_stmts === 0)
	return {
		kind: kindOf(fn.name),
		signature: `${fn.schema}.${fn.name}(${fn.args})`,
		statements: statements.length,
		executed: statements.length - unexecuted.length,
		branches: branches.ratio,
		uncovered: Arr.map(unexecuted, (s) =>
			Option.match(Record.get(sourceOf, String(s.lineno)), {
				onNone: () => `line ${s.lineno} ${s.stmtname}`,
				onSome: (source) => `line ${s.lineno} ${s.stmtname}: ${source}`
			})
		)
	} satisfies PlpgsqlFunctionCoverage
})

const percent = (part: number, whole: number): string =>
	whole === 0 ? "100.0" : ((100 * part) / whole).toFixed(1)

/**
 * The report of `coverage`, from one database or several: per kind, then per function with its unexecuted statements.
 *
 * @internal
 */
export const plpgsqlCoverageReport = (
	coverage: ReadonlyArray<PlpgsqlFunctionCoverage>
): ReadonlyArray<string> => {
	const byKind = Arr.filter(
		Arr.map(kinds, (kind) => ({ kind, functions: Arr.filter(coverage, (c) => c.kind === kind) })),
		(group) => group.functions.length > 0
	)
	const kindLines = Arr.map(byKind, ({ kind, functions }) => {
		const statements = Num.sumAll(Arr.map(functions, (c) => c.statements))
		const executed = Num.sumAll(Arr.map(functions, (c) => c.executed))
		const fullBranches = Arr.filter(functions, (c) => c.branches === 1).length
		const meanBranches = Num.sumAll(Arr.map(functions, (c) => c.branches)) / functions.length
		return `  ${kind}: ${functions.length} function(s), statements ${executed}/${statements} (${percent(executed, statements)}%), branches ${(100 * meanBranches).toFixed(1)}% on average, ${fullBranches} with every branch taken`
	})
	const bySignature = Order.mapInput(
		Str.Order,
		(c: PlpgsqlFunctionCoverage) => `${c.kind}\u0000${c.signature}`
	)
	const functionLines = Arr.flatMap(
		Arr.sort(coverage, bySignature),
		(c: PlpgsqlFunctionCoverage) => [
			`  [${c.kind}] ${c.signature}: statements ${c.executed}/${c.statements} (${percent(c.executed, c.statements)}%), branches ${(100 * c.branches).toFixed(1)}%`,
			...Arr.map(c.uncovered, (line) => `      not executed: ${line}`)
		]
	)
	return [
		"PL/pgSQL coverage by kind:",
		...kindLines,
		"",
		"PL/pgSQL coverage by function:",
		...functionLines
	]
}

/**
 * The statement and branch coverage plpgsql_check's profiler recorded for every PL/pgSQL function in grizzle's
 * schemas of one database.
 *
 *   DATABASE_URL=<url> node --conditions=grizzle-source scripts/dev/plpgsql-coverage.ts
 *
 * The URL names a superuser of a server that preloads plpgsql_check with its profiler on, as the coverage cluster does
 * (`eval "$(scripts/pg/ctl.sh --coverage admin-env <database>)"`), and the database the tests ran in, read before it is
 * dropped: the profiler keeps each function's profile in shared memory under its database and the version of its
 * pg_proc row, so a function replaced since its runs reads as never run. The extension's SQL functions are created in
 * a transaction that always rolls back, so the database is left as it was; plpgsql_check is not a trusted extension,
 * hence the superuser.
 *
 * It prints, per kind of function (law function, advance function, below-SERIALIZABLE guard, refusal function, other),
 * the statements executed of all and the branches taken, then per function the same with every statement no run
 * executed and its source line. A statement counts when it has a source line, as plpgsql_check counts them; branch
 * coverage is plpgsql_check's ratio of the branches of IF, CASE and loops taken.
 */
/**
 * The coverage of every PL/pgSQL function in grizzle's schemas of the database `url` names, read as `main` describes.
 * A function's profile is reachable only while the function exists, so a harness reads a database before it drops
 * the schemas or the database.
 *
 * @internal
 */
export const readPlpgsqlCoverage = Effect.fn("readPlpgsqlCoverage")(function* (
	url: string
): Effect.fn.Return<
	ReadonlyArray<PlpgsqlFunctionCoverage>,
	CoverageRefused | QueryFailed,
	Scope.Scope
> {
	const client = yield* Effect.acquireRelease(
		Effect.sync(
			() => new Client({ connectionString: url, application_name: "grizzle plpgsql-coverage" })
		).pipe(
			Effect.tap((c) =>
				Effect.tryPromise({
					try: () => c.connect(),
					catch: (cause) => new QueryFailed({ sql: "(connect)", cause })
				})
			)
		),
		(c) => Effect.promise(() => c.end())
	)
	const preloadRows = yield* query({
		client,
		sql: "SELECT pg_catalog.current_setting('shared_preload_libraries') AS libraries",
		params: []
	})
	const [preload] = trusted<ReadonlyArray<{ readonly libraries: string }>>(preloadRows)
	if (
		preload === undefined ||
		!Arr.contains(Arr.map(Str.split(",")(preload.libraries), Str.trim), "plpgsql_check")
	) {
		return yield* new CoverageRefused({
			reason:
				"the server does not preload plpgsql_check, so no profile was recorded; use the coverage cluster"
		})
	}
	yield* run(client, "BEGIN")
	const coverage = yield* Effect.gen(function* () {
		const installedRows = yield* query({
			client,
			sql: "SELECT n.nspname::text AS schema FROM pg_catalog.pg_extension AS e JOIN pg_catalog.pg_namespace AS n ON n.oid = e.extnamespace WHERE e.extname = 'plpgsql_check'",
			params: []
		})
		const [installed] = trusted<ReadonlyArray<{ readonly schema: string }>>(installedRows)
		const ext = installed === undefined ? "gz_plpgsql_coverage" : installed.schema
		if (installed === undefined) {
			yield* run(client, `CREATE SCHEMA ${ext}`)
			yield* run(client, `CREATE EXTENSION plpgsql_check SCHEMA ${ext}`)
		}
		const functionRows = yield* query({
			client,
			sql: functionsSql,
			params: [isolationGuardName]
		})
		const functions = trusted<ReadonlyArray<FunctionRow>>(functionRows)
		return yield* Effect.forEach(functions, (fn) => coverageOf({ client, ext, fn }))
	}).pipe(Effect.ensuring(Effect.ignore(run(client, "ROLLBACK"))))
	return coverage
}, Effect.scoped)

const main = Effect.gen(function* () {
	const url = yield* Config.Redacted("DATABASE_URL")
	const coverage = yield* readPlpgsqlCoverage(Redacted.value(url))
	if (!Arr.isReadonlyArrayNonEmpty(coverage)) {
		return yield* new CoverageRefused({
			reason: "the database holds no PL/pgSQL function in a grizzle schema"
		})
	}
	yield* Effect.forEach(plpgsqlCoverageReport(coverage), (line) => Console.log(line), {
		discard: true
	})
}).pipe(
	Effect.catchTags({
		CoverageRefused: (refused) =>
			Console.error(`plpgsql-coverage: ${refused.reason}`).pipe(Effect.andThen(exitWith(2))),
		QueryFailed: (failed) =>
			Console.error(
				`plpgsql-coverage: ${failed.sql} failed\n${Inspectable.toStringUnknown(failed.cause)}`
			).pipe(Effect.andThen(exitWith(2)))
	})
)

const exitWith = (code: 2): Effect.Effect<void> =>
	Effect.sync(() => {
		process.exitCode = code
	})

if (import.meta.main) {
	NodeRuntime.runMain(main)
}
