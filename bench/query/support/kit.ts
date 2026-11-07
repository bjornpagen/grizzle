import { inspect } from "node:util"
import { type Equivalence, exact, ordered } from "@grizzle/testing/oracle"
import {
	Array as Arr,
	Data,
	Effect,
	Option,
	Order,
	Predicate,
	Record as Rec,
	Result,
	type Scope
} from "effect"
import { rowOptions } from "#adapter/engine.ts"
import { type ReadError, ReadFailure } from "#adapter/errors/execution.ts"
import { type AttachmentScope, attachmentHeads } from "#adapter/reader/analysis.ts"
import type { HostParams } from "#adapter/reader/execution.ts"
import { executionInputs, paramCodecs } from "#adapter/reader/relations.ts"
import { programFlight, templateProgram } from "#adapter/reader/run.ts"
import { type FlightFailure, type Prologue, readFrame, runFramed } from "#adapter/wire/batch.ts"
import { connectSession, type Session } from "#adapter/wire/session.ts"
import { type Summary, summarize } from "#bench/cold/stats.ts"
import type { ExplainOptions, MalformedPlan, PlanMode } from "#bench/harness/explain.ts"
import { type GateCheck, type Conditions, equivalence } from "#bench/harness/gate.ts"
import {
	type MalformedRows,
	measureVariant,
	type TextRow,
	textRows,
	type VariantMeasure,
	type VariantOptions,
	type VariantSpec,
	type VariantStatement,
	type VariantTransaction
} from "#bench/harness/variant.ts"
import { appendAll } from "#compiler/core/array.ts"
import { bindGroups, type RowDecoder } from "#compiler/core/decoder.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import * as Engine from "#compiler/core/result.ts"
import { jsonText, trusted } from "#compiler/core/trusted.ts"
import { ledgerStatements } from "#compiler/deploy/ledger/ledger.ts"
import type { CertificateRule } from "#compiler/ir/certificate.ts"
import { codeNames, codeOf } from "#compiler/ir/codes.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import type { OptimizedStatement } from "#compiler/lower/shapes/index.ts"
import { workloadExtension } from "#compiler/physical/access/extension.ts"
import { ledgerTableName } from "#compiler/physical/ddl/ledger.ts"
import { queryInput } from "#compiler/program/compile.ts"
import type { SchemaArtifacts } from "#compiler/program/schema.ts"
import { type CompiledTemplate, templateFor } from "#compiler/program/template.ts"
import type { WorkloadPlan } from "#compiler/program/workload/compile.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { isOrderedValue, isQueryValue } from "#compiler/query/build/query.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { AnyLogin, AnyRole } from "#compiler/types/schema/world.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import {
	compileTestWorkload,
	schemaInputOf,
	type TestNaming,
	testArtifacts,
	installedCodes,
	testCompile
} from "#test/support/compile.ts"
import { ledgerPrologue } from "#test/support/flight/model.ts"
import { type Installed, installMigrated as install } from "#test/support/install-migrate.ts"
import { parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { clusterConnection, parsedConnection, SqlError } from "#test/support/pg.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { type FullWorld, fullWorld } from "#test/support/worlds.ts"

/**
 * The shared kit of the query rule gates.
 *
 * "Reference baselines enforce the same laws, set semantics, refinements, ordering, approximation contract, and
 * transaction behavior. Compare a fused handwritten implementation to generated output; a bag query without checks is
 * not the baseline". Every gate file under bench/query measures three kinds of variant over one installed
 * fixture:
 *
 * - generated: grizzle's optimized artifact as the runtime sends it. The fixture is a schema built by the public
 *   builders and installed by the fresh-install compiler with its workload, so every index the statements
 *   rely on is one a law or a workload program justifies; the queries are compiled as a Db compiles them
 *   (packages/engine/src/program/template.ts) and delivered by the runtime's own delivery (packages/grizzle/src/adapter/reader/run.ts
 *   programFlight) on an adapter session logged in as the login of the fixture's full world, in the flights a Db of its
 *   role sends (packages/grizzle/src/adapter/wire/batch.ts readFrame, whose prologue enters the role). The statements that delivery sends, with their parameters exactly as bound (scalar
 *   encoders, the VALUES or recordset transport of a relation parameter, a per-execution variant), are recorded and
 *   become the variant the harness explains and times;
 * - conservative: the conservative artifact of the same template, delivered the same way: the oracle baseline that
 *   deduplicates at every set boundary and uses no certificate;
 * - handwritten: what a PostgreSQL expert writes for the same answer over the same tables and indexes, every output
 *   column cast to text in the generated heading's order, as the runtime's statements cast them, so the
 *   raw rows compare exactly.
 *
 * Equivalence is the testing library's judgment (@grizzle/testing/oracle), checked twice: raw text row sets between
 * statements that deliver the same rows (the harness's rowsAgree), and the delivered public results, nested
 * attachments and merged heading groups included, between the two artifacts (deliveredAgree). Double-precision
 * catalog entries compare keyed numeric texts within a stated tolerance (within).
 *
 * Statement structure is read from the compiled program, never from emitted text: each optimized statement's typed
 * AST (the kernel's shapeOf), its roles and fused attachments, its per-execution choices and the certificates' rules.
 * Plans are read by node, and an index access by the installed index's own key columns (installedIndexes).
 *
 * A failure of the kit that is a defect of the gate file, never a measurement: a query that does not compile, a fixture
 * the installer refuses, a statement, plan or reading a check needs and the run did not produce.
 */
export class GateSetupError extends Data.TaggedError("GateSetupError")<{ readonly what: string }> {
	override get message(): string {
		return this.what
	}
}

const round = (x: number): number => Math.round(x * 1000) / 1000

export interface Fixture<S> {
	readonly schema: S
	readonly installed: Installed
	/**
	 * The full world the fixture is installed with, over its declared schema (test/support/worlds.ts fullWorld): the role
	 * every raw and runtime session takes on unless a gate names another it installed.
	 */
	readonly world: FullWorld
	readonly workload: WorkloadPlan
	/** The names the fixture's schema is installed under, which every artifacts of it are computed under. */
	readonly naming: TestNaming
	/** The qualified, quoted table of a relation, and the quoted column of one of its fields. */
	readonly table: (relation: string) => string
	readonly column: (relation: string, field: string) => string
	/** The unquoted installed column of a field, as the catalog names an index's key columns. */
	readonly columnName: (relation: string, field: string) => string
	/** The unqualified table name of a relation, as EXPLAIN names the relation a scan reads. */
	readonly relationName: (relation: string) => string
	/** The qualified, quoted domain of a roster: what a code column, a code literal and a code array are typed by. */
	readonly rosterDomain: (closed: string) => string
	/**
	 * A roster handle as SQL: its code in the installation's codebook, cast to the roster's domain, which a column of
	 * the roster compares and stores. A handle the roster does not hold live is a defect of the gate.
	 */
	readonly handle: (closed: string, handle: string) => string
	/** Every table of the fixture, for VACUUM ANALYZE. */
	readonly tables: ReadonlyArray<string>
}

const workloadPlan = (
	schema: unknown,
	programs: Readonly<Record<string, unknown>>
): WorkloadPlan => {
	const planned = compileTestWorkload(
		[{ login: "server", workloads: [workload(schema, programs)] }],
		schema,
		testCompile
	)
	if (!planned.ok) {
		throw new GateSetupError({ what: `the workload does not compile: ${planned.error.message}` })
	}
	return planned.value
}

/**
 * Installs `schema` complete, with the access paths its workload programs request, under a fresh schema name of the
 * gate's database (R13: every index beyond a key's own has a recorded justification), with its full world and the
 * further `logins` a gate's own roles are in.
 */
export const installFixture = Effect.fn("installFixture")(function* <
	S extends Parameters<typeof fullWorld>[0]
>(
	schema: S,
	programs: Readonly<Record<string, unknown>>,
	label: string,
	logins: ReadonlyArray<AnyLogin>
): Effect.fn.Return<
	Fixture<S>,
	CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> {
	const plan = workloadPlan(schema, programs)
	const world: FullWorld = fullWorld<Parameters<typeof fullWorld>[0]>(schema)
	const installed = yield* install(schema, {
		ambient: ordinarySession,
		label,
		extensions: [workloadExtension(plan)],
		logins: [world.server, ...logins]
	})
	const names = installed.names
	const table = (relation: string): string => {
		const n = names.relation(relation)
		return `${quoteIdent(n.schema)}.${quoteIdent(n.name)}`
	}
	const columnName = (relation: string, field: string): string => names.column(relation, field)
	const rosterDomain = (closed: string): string => {
		const n = names.rosterDomain(parsedName(closed))
		return `${quoteIdent(n.schema)}.${quoteIdent(n.name)}`
	}
	const column = (relation: string, field: string): string =>
		quoteIdent(columnName(relation, field))
	const tables = installed.installation.owned.relations
	return {
		schema,
		installed,
		world,
		workload: plan,
		naming: {
			...testCompile,
			installation: identity.schema(parsedSchemaName(installed.declared)),
			codes: installedCodes(names.codes)
		},
		table,
		column,
		columnName,
		relationName: (relation: string) => names.relation(relation).name,
		rosterDomain,
		handle: (closed: string, handle: string) => {
			const roster = parsedName(closed)
			const codec = names.codes.rosters.get(roster)
			if (codec === undefined) {
				throw new GateSetupError({ what: `the fixture's codebook holds no roster ${closed}` })
			}
			return `${codeOf(codec, handle)}::${rosterDomain(closed)}`
		},
		tables: Arr.flatMap(Rec.values(tables), (r) => (r.kind === "relation" ? [table(r.name)] : []))
	}
})

/** Stores `rows` generated facts of `relation`: each column's SQL expression over the row number `g`, 1 to `rows`. */
/** One relation's fill: `rows` rows, each column the SQL expression `columns` gives it over g, the row's number from 1. */
interface Fill {
	readonly relation: string
	readonly rows: number
	readonly columns: Readonly<Record<string, string>>
}

/** The INSERT of one fill. */
const fillStatement = <S>(fixture: Fixture<S>, f: Fill): string =>
	`INSERT INTO ${fixture.table(f.relation)} (${Arr.join(
		Arr.map(Rec.keys(f.columns), (c) => fixture.column(f.relation, c)),
		", "
	)}) SELECT ${Arr.join(Rec.values(f.columns), ", ")} FROM pg_catalog.generate_series(1, ${f.rows}) AS g`

export const fill = Effect.fn("fill")(function* <S>(
	fixture: Fixture<S>,
	relation: string,
	rows: number,
	columns: Readonly<Record<string, string>>
): Effect.fn.Return<void, SqlError, Substrate> {
	const s = yield* Substrate
	yield* s.admin.query(fillStatement(fixture, { relation, rows, columns }), [])
})

/**
 * Several fills in one transaction: the relations of a cycle of deferred foreign keys, whose rows hold their laws only
 * together, so each relation's fill alone would commit a violation.
 */
export const fillTogether = Effect.fn("fillTogether")(function* <S>(
	fixture: Fixture<S>,
	fills: ReadonlyArray<Fill>
): Effect.fn.Return<void, SqlError | TransactionRolledBack, Substrate> {
	const s = yield* Substrate
	yield* transaction(
		s.admin,
		Arr.map(fills, (f) => fillStatement(fixture, f))
	)
})

/** Settled pages and fresh statistics: VACUUM (ANALYZE) every table of the fixture. bench/ alone runs ANALYZE. */
export const settle = Effect.fn("settle")(function* <S>(
	fixture: Fixture<S>
): Effect.fn.Return<void, SqlError, Substrate> {
	const s = yield* Substrate
	for (const t of fixture.tables) {
		yield* s.admin.query(`VACUUM (ANALYZE) ${t}`, [])
	}
})

/**
 * An index the catalog holds on a relation of the fixture: its name, its table's name, and its key columns in key order
 * (an INCLUDE column is no key column).
 */
export interface InstalledIndex {
	readonly name: string
	readonly table: string
	readonly columns: ReadonlyArray<string>
}

/**
 * A key of index `index` as its column. An expression key has no column, so its NULL fails the gate's setup rather than
 * vanish from the key.
 */
const keyColumn =
	(index: string) =>
	(key: string | null): string => {
		if (key === null) {
			throw new GateSetupError({ what: `the index ${index} has an expression key, no column` })
		}
		return key
	}

/**
 * The indexes installed on the fixture's relations, read from the catalog's structure. The migrations ledger's own
 * primary key is left out: the ledger is grizzle's deployment machinery, not a relation of the schema, and R13 judges
 * only indexes beyond a key's own.
 */
export const installedIndexes = Effect.fn("installedIndexes")(function* <S>(
	fixture: Fixture<S>
): Effect.fn.Return<ReadonlyArray<InstalledIndex>, SqlError, Substrate> {
	const s = yield* Substrate
	const rows = yield* s.admin.queryValues(
		`SELECT c.relname::text, t.relname::text, pg_catalog.array_agg(a.attname::text ORDER BY k.ord)
			 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
			 JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
			 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
			 CROSS JOIN LATERAL pg_catalog.unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
			 LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
			 WHERE n.nspname = $1::text AND NOT (t.relname = $2::text AND i.indisprimary) AND k.ord <= i.indnkeyatts
			 GROUP BY c.relname, t.relname ORDER BY 1`,
		[fixture.installed.schema, ledgerTableName]
	)
	return Arr.map(
		trusted<
			ReadonlyArray<readonly [name: string, table: string, keys: ReadonlyArray<string | null>]>
		>(rows),
		([name, table, keys]) => ({ name, table, columns: Arr.map(keys, keyColumn(name)) })
	)
})

/**
 * A raw direct session in a world of the fixture, `role` (fixture.world.app, its full role, or a role of a login the
 * gate installed): logged in as the role's login, with its defaults (the C.UTF-8 categories, extra_float_digits
 * = 1), and taking on the role. The session handwritten variants and every EXPLAIN run on.
 */
export const rawSession = Effect.fn("rawSession")(function* <S>(
	fixture: Fixture<S>,
	role: AnyRole,
	label: string
): Effect.fn.Return<RawSession, SqlError, Substrate | Scope.Scope> {
	const s = yield* Substrate
	return yield* s.session({ ...worldSession(fixture.installed.world(role)), label })
})

export interface Compiled {
	readonly compiled: CompiledTemplate
	/** The decoder of the query's rows, which a delivery reads them with. */
	readonly decoder: RowDecoder<unknown>
	readonly desc: QueryDesc
	readonly artifacts: SchemaArtifacts
	readonly spine: AttachmentScope
	/** The first compilation, and the compilations of the same query after it. */
	readonly compileFirstMs: number
	readonly compileWarmMs: Summary
}

const unwrap = <A>(result: Engine.Result<A, CompileError>, what: string): A => {
	if (!result.ok) {
		throw new GateSetupError({ what: `${what}: ${result.error.message}` })
	}
	return result.value
}

export interface CompileOptions {
	/**
	 * The role the query is read as, a role over the fixture's declared schema (fixture.world.app, or a role of a login
	 * the gate installed): the query is compiled against it, as a Db of the role compiles it, so its relations are read
	 * through the role's views.
	 */
	readonly role: AnyRole
	readonly context: TemplateContext
	/** The compilations timed after the first: at least one. */
	readonly warm: number
	/** A page read compiles the template its page program is built from (program/compile.ts, read "page"). */
	readonly read: "rows" | "page"
}

/**
 * Compiles `query` over the fixture's schema as the runtime does for one execution of a Db of `options.role`, then
 * `warm` more times.
 */
export const compile = <S>(
	fixture: Fixture<S>,
	query: unknown,
	options: CompileOptions
): Compiled => {
	if (!Number.isInteger(options.warm) || options.warm < 1) {
		throw new RangeError(`${options.warm} warm compilations`)
	}
	const request = { context: options.context, read: options.read } as const
	const reading = schemaInputOf(options.role)
	/**
	 * The role reads through the views its installation created, in the role schema named after the installed schema:
	 * its artifacts are computed once, under the installed schema's names, as a DbLayer computes them.
	 */
	const artifacts = unwrap(
		testArtifacts(reading, fixture.naming),
		"the role's artifacts under the installed schema"
	)
	const start = performance.now()
	/** The runtime parses the caller's query once (program/compile.ts queryInput), then compiles it. */
	const compile = () =>
		Engine.flatMap(queryInput(query), (input) => templateFor(input, reading, artifacts, request))
	const compiled = unwrap(compile(), "compile")
	const compileFirstMs = round(performance.now() - start)
	const warm: Array<number> = []
	for (let i = 0; i < options.warm; i++) {
		const t = performance.now()
		unwrap(compile(), "compile (warm)")
		warm.push(round(performance.now() - t))
	}
	const desc = compiled.desc
	if (!isQueryValue(query) && !isOrderedValue(query)) {
		throw new GateSetupError({ what: "a query value built by query(S)" })
	}
	return {
		compiled,
		decoder: query.rows,
		desc,
		artifacts,
		spine: attachmentHeads(desc),
		compileFirstMs,
		compileWarmMs: summarize(warm)
	}
}

/** The rules the optimized artifact's certificates name, each once (every rewrite records a certificate). */
export const certifiedRules = (compiled: Compiled): ReadonlyArray<CertificateRule> => [
	...new Set(Arr.map(compiled.compiled.template.programs.optimized.certificates, (c) => c.rule))
]

/**
 * Statement `index` of the optimized artifact, as compiled: its typed AST, parameters, role, fused attachments and
 * per-execution choices.
 */
export const optimizedStatement = (compiled: Compiled, index: number): OptimizedStatement => {
	const statement = flight(compiled.compiled.template.programs.optimized.roots)[index]
	if (statement === undefined) {
		throw new GateSetupError({ what: `the optimized artifact has no statement ${index}` })
	}
	return statement
}

export type Artifact = "optimized" | "conservative"

export interface Runtime {
	readonly session: Session
	/**
	 * What the session's framed transactions begin with: the fence at the installation's snapshot, then the role's
	 * installed name and no claims.
	 */
	readonly prologue: Prologue
	/**
	 * What the delivery sent since the last reset, in order, and in how many flights, each one round trip: mutable by
	 * design, the session appends to them beside timed code.
	 */
	readonly recorded: Array<VariantStatement>
	flights: number
}

/**
 * An adapter session on a direct connection logged in as the login of `role` (fixture.world.app, or a role of a login
 * the gate installed), the session the runtime reads on as that role, its prologue's two statements server statements
 * and every other unnamed, as a Db's. Every statement its flights send is recorded with its text
 * parameters, but the prologue's two statements that fence and enter the role (wire/batch.ts Prologue): they are no
 * statements of the delivery.
 *
 * @internal
 */
export const runtimeSession = Effect.fn("runtimeSession")(function* <S>(
	fixture: Fixture<S>,
	role: AnyRole
): Effect.fn.Return<Runtime, SqlError, Substrate | Scope.Scope> {
	const s = yield* Substrate
	const world = fixture.installed.world(role)
	const login = world.login
	const session = yield* Effect.mapError(
		connectSession(
			parsedConnection(clusterConnection(s.cluster, s.database, login.password), login.role)
		),
		(failure) =>
			new SqlError({
				reason: { _tag: "ConnectionError", message: failure.message },
				cause: failure
			})
	)
	const ledger = ledgerStatements(fixture.installed.schema)
	if (!ledger.ok) {
		return yield* Effect.die(
			new GateSetupError({ what: `the ledger statements of ${fixture.installed.schema}` })
		)
	}
	const prologue = ledgerPrologue(
		ledger.value,
		world.role,
		"",
		fixture.installed.snapshot.fingerprint
	)
	const recorded: Array<VariantStatement> = []
	const recording: Session = {
		...session,
		send: (closes, pipeline, onAnswer, onEnd) => {
			runtime.flights++
			appendAll(
				recorded,
				Arr.filterMap(pipeline, (query) =>
					query._tag === "statement" &&
					query.sql !== prologue.fence.server.sql &&
					query.sql !== prologue.enter.server.sql
						? Result.succeed({ sql: query.sql, params: [...query.params] })
						: Result.failVoid
				)
			)
			session.send(closes, pipeline, onAnswer, onEnd)
		}
	}
	const runtime: Runtime = { session: recording, prologue, recorded, flights: 0 }
	return runtime
})

/** A delivery that failed, its message the failure itself as inspect renders it, so a gate's record names it. */
export class DeliveryFailed extends Data.TaggedError("DeliveryFailed")<{
	readonly failure: string
}> {
	override get message(): string {
		return this.failure
	}
}

/** The DeliveryFailed of a delivery's `failure`, rendered at any depth on one line. */
export const deliveryFailed = (failure: ReadError | FlightFailure): DeliveryFailed =>
	new DeliveryFailed({
		failure: inspect(failure, { depth: 8, breakLength: Number.POSITIVE_INFINITY })
	})

/**
 * What the runtime's recording session sent since `runtime` was last reset: at least one statement, or the delivery
 * sent nothing a gate could measure.
 */
export const sentStatements = (runtime: Runtime): Arr.NonEmptyReadonlyArray<VariantStatement> => {
	const statements = [...runtime.recorded]
	if (!Arr.isReadonlyArrayNonEmpty(statements)) {
		throw new GateSetupError({ what: "the delivery sent no statement" })
	}
	return statements
}

export interface Delivered {
	readonly artifact: Artifact
	/** The delivered public rows, decoded, attachments stitched and heading groups merged. */
	readonly rows: ReadonlyArray<unknown>
	/** The statements the delivery sent, with their parameters, and the flights it sent them in. */
	readonly statements: Arr.NonEmptyReadonlyArray<VariantStatement>
	readonly flights: number
	readonly ms: number
}

/**
 * Delivers one artifact of `compiled` with `values`, as a read does: its relation inputs normalized before any SQL
 * (relations.ts), then its flights, a lone statement alone and anything more in one SERIALIZABLE READ ONLY transaction.
 */
export const deliver = Effect.fn("deliver")(
	function* (
		runtime: Runtime,
		compiled: Compiled,
		artifact: Artifact,
		values: HostParams
	): Effect.fn.Return<Delivered, DeliveryFailed | ReadError | FlightFailure> {
		const start = performance.now()
		const codes = compiled.artifacts.names.codes
		const inputs = executionInputs(paramCodecs(compiled.compiled.template.params, codes), values)
		if (Result.isFailure(inputs)) {
			return yield* deliveryFailed(new ReadFailure({ reason: inputs.failure }))
		}
		const program = templateProgram(compiled.compiled.template, artifact, compiled.spine, codes)
		const read = unwrap(
			bindGroups(compiled.decoder, program.layouts, {
				options: rowOptions,
				names: codeNames(codes)
			}),
			"the query's decoder bound"
		)
		const flight = yield* Effect.mapError(
			programFlight(program, inputs.success, read),
			(reason) => new ReadFailure({ reason })
		)
		runtime.recorded.length = 0
		runtime.flights = 0
		const rows = yield* Effect.flatMap(
			runFramed(runtime.session, readFrame(runtime.prologue), flight.statements),
			flight.read
		)
		return {
			artifact,
			rows,
			statements: sentStatements(runtime),
			flights: runtime.flights,
			ms: round(performance.now() - start)
		}
	},
	Effect.mapError((e) => (e._tag === "DeliveryFailed" ? e : deliveryFailed(e)))
)

/**
 * Times `samples` whole deliveries, the first excluded as warm-up: the operation as an application sees it, encode,
 * round trips, decode, stitching and the transaction boundary included.
 */
export const timeDeliveries = Effect.fn("timeDeliveries")(function* (
	runtime: Runtime,
	compiled: Compiled,
	artifact: Artifact,
	values: HostParams,
	samples: number
): Effect.fn.Return<Summary, DeliveryFailed> {
	yield* deliver(runtime, compiled, artifact, values)
	const ms: Array<number> = []
	for (let i = 0; i < Math.max(1, samples); i++) {
		ms.push((yield* deliver(runtime, compiled, artifact, values)).ms)
	}
	return summarize(ms)
})

/**
 * The transactions the bench runs its variants in: a lone statement alone, and the statements of a read of several in
 * one SERIALIZABLE READ ONLY transaction, as the runtime runs them (batch.ts readFrame).
 */
export const autocommit: VariantTransaction = { kind: "autocommit" }
export const readSnapshot: VariantTransaction = { kind: "snapshot", readOnly: true }

/**
 * The EXPLAIN of every capture of the query gates: WAL on, no SERIALIZE; and the capture with SERIALIZE TEXT, the
 * output conversion and TOAST fetches of the delivered payload.
 */
export const plainExplain: ExplainOptions = { wal: true, serialize: { kind: "off" } }
export const serializedExplain: ExplainOptions = {
	wal: true,
	serialize: { kind: "on", format: "text" }
}

const deliveredRole = (artifact: Artifact): "generated" | "conservative" =>
	artifact === "optimized" ? "generated" : "conservative"

/**
 * The variant of a delivery: the statements it sent, run again as the runtime ran them, with the phases timed outside
 * its executions beside them.
 */
export const deliveredAlone = (
	label: string,
	delivered: Delivered,
	outside: Readonly<Record<string, Summary>>
): VariantSpec => ({
	role: deliveredRole(delivered.artifact),
	label,
	statements: delivered.statements,
	transaction: delivered.statements.length > 1 ? readSnapshot : autocommit,
	decode: { kind: "none" },
	outside
})

/** The variant of a delivery of `compiled`, its compile timings and its whole operation beside it. */
export const deliveredVariant = (
	label: string,
	delivered: Delivered,
	compiled: Compiled,
	operation: Summary
): VariantSpec =>
	deliveredAlone(label, delivered, {
		compileFirstMs: summarize([compiled.compileFirstMs]),
		compileWarmMs: compiled.compileWarmMs,
		operationMs: operation
	})

/** What one judgment found: agreement, or the difference in words. */
type Agreement =
	| { readonly kind: "agree" }
	| { readonly kind: "differ"; readonly difference: string }

const agreementOf = (difference: Option.Option<string>): Agreement =>
	Option.match(difference, {
		onNone: () => ({ kind: "agree" }),
		onSome: (found) => ({ kind: "differ", difference: found })
	})

/** The equivalence check that `left` and `right` agree under `judge`, its difference the detail. */
export const judged = <O>(name: string, judge: Equivalence<O>, left: O, right: O): GateCheck => {
	const agreement = agreementOf(judge(left, right))
	return equivalence(
		name,
		agreement.kind === "agree",
		agreement.kind === "agree" ? "agree" : agreement.difference
	)
}

/** How a delivery's nested arrays compare: in order, or as sets, where a repeated item is a difference. */
export type NestedAgreement = "ordered" | "set"

/**
 * One delivered value as its canonical text: records by sorted key, bigints apart from numbers, a Decimal or Money by
 * its exact text, an Option by its case, a vector by its components; nested arrays in order, or as sets, each nested
 * set's repeated item pushed to `repeats`.
 */
const canonicalOf = (value: unknown, nested: NestedAgreement, repeats: Array<string>): string => {
	switch (typeof value) {
		case "undefined":
			return "undefined"
		case "string":
			return jsonText(value)
		case "bigint":
			return `${value}n`
		case "number":
			return Object.is(value, -0) ? "-0" : String(value)
		case "boolean":
			return value ? "true" : "false"
		case "symbol":
		case "function":
			return value.toString()
		case "object":
			return value === null ? "null" : canonicalObject(value, nested, repeats)
	}
}

/** A value whose class states its own text, as a Decimal, a Money and a Date do. */
const hasOwnText = (value: object): value is { toString(): string } =>
	Predicate.hasProperty(value, "toString") && value.toString !== Object.prototype.toString

/** One delivered object's canonical text, as canonicalOf states it. */
const canonicalObject = (
	value: object,
	nested: NestedAgreement,
	repeats: Array<string>
): string => {
	const text = (v: unknown): string => canonicalOf(v, nested, repeats)
	if (value instanceof Float32Array) {
		return `f32[${Arr.join(Arr.map([...value], String), ",")}]`
	}
	if (Arr.isArray(value)) {
		const items = Arr.map(value, (v: unknown) => text(v))
		if (nested === "ordered") {
			return `[${Arr.join(items, ",")}]`
		}
		const sorted = Arr.sort(items, Order.String)
		for (const [i, item] of sorted.entries()) {
			if (i > 0 && sorted[i - 1] === item) {
				repeats.push(item)
			}
		}
		return `[${Arr.join(sorted, ",")}]`
	}
	if (Option.isOption(value)) {
		return Option.isSome(value) ? `Some(${text(value.value)})` : "None"
	}
	if (hasOwnText(value)) {
		const own: { toString(): string } = value
		return `${value.constructor.name}(${own.toString()})`
	}
	return `{${Arr.join(
		Arr.map(
			Arr.sort(
				Rec.toEntries(value),
				Order.mapInput(Order.String, ([key]: readonly [string, unknown]) => key)
			),
			([k, v]) => `${jsonText(k)}:${text(v)}`
		),
		","
	)}}`
}

/**
 * Delivered (decoded) results as sets of their canonical forms; `nested` says whether nested arrays compare in order or
 * as sets. A delivery is a set, so a row it repeats, or an item a nested set repeats, is a difference on either side.
 * These results reach about 90 000 rows, so the canonical forms are sorted and compared in order, and a repeat is two
 * equal neighbours.
 */
export const deliveredAgree =
	(nested: NestedAgreement): Equivalence<ReadonlyArray<unknown>> =>
	(left, right) => {
		const canonical = (rows: ReadonlyArray<unknown>) => {
			const repeats: Array<string> = []
			const texts = Arr.sort(
				Arr.map(rows, (r) => canonicalOf(r, nested, repeats)),
				Order.String
			)
			for (const [i, row] of texts.entries()) {
				if (i > 0 && texts[i - 1] === row) {
					repeats.push(row)
				}
			}
			return { texts, repeats }
		}
		const l = canonical(left)
		const r = canonical(right)
		if (l.repeats.length > 0 || r.repeats.length > 0) {
			const [side, repeats] = l.repeats.length > 0 ? ["left", l.repeats] : ["right", r.repeats]
			return Option.some(`${side} repeats ${Arr.join(repeats, ", ")}, and a delivery is a set`)
		}
		return ordered(exact)(l.texts, r.texts)
	}

interface Keyed {
	/** Each key's first value. */
	readonly values: ReadonlyMap<string, string>
	/** The keys that occur more than once. */
	readonly repeated: ReadonlySet<string>
}

const keyedOf = (rows: ReadonlyArray<readonly [string, string]>): Keyed => {
	const values = new Map<string, string>()
	const repeated = new Set<string>()
	for (const [key, value] of rows) {
		if (values.has(key)) {
			repeated.add(key)
		} else {
			values.set(key, value)
		}
	}
	return { values, repeated }
}

const closeTo = (a: string, b: string, tolerance: number): boolean =>
	a === b || Math.abs(Number(a) - Number(b)) <= tolerance

/**
 * Keyed numeric texts agree when every key occurs once on each side and the two values are equal texts or within
 * `tolerance` as numbers. A repeated key on either side, a key on one side only, or a difference above the tolerance is
 * a disagreement, named in the returned text.
 */
export const within =
	(tolerance: number): Equivalence<ReadonlyArray<readonly [string, string]>> =>
	(left, right) => {
		const l = keyedOf(left)
		const r = keyedOf(right)
		const [leftRepeated] = l.repeated
		if (leftRepeated !== undefined) {
			return Option.some(`key ${leftRepeated} occurs more than once on the left`)
		}
		const [rightRepeated] = r.repeated
		if (rightRepeated !== undefined) {
			return Option.some(`key ${rightRepeated} occurs more than once on the right`)
		}
		for (const [key, a] of l.values) {
			const b = r.values.get(key)
			if (b === undefined) {
				return Option.some(`key ${key} is on the left only`)
			}
			if (!closeTo(a, b, tolerance)) {
				return Option.some(`key ${key}: ${a} and ${b} differ by more than ${tolerance}`)
			}
		}
		for (const key of r.values.keys()) {
			if (!l.values.has(key)) {
				return Option.some(`key ${key} is on the right only`)
			}
		}
		return Option.none()
	}

/**
 * Measures of the same comparison, for records: unmatched is the size of the symmetric difference of the key sets,
 * repeated counts keys that occur more than once on either side.
 */
export interface AgreementCounts {
	/** The keys of either side, each once. */
	readonly keys: number
	/** Keys once on each side whose values are textually equal, or only within the tolerance. */
	readonly exact: number
	readonly withinTolerance: number
	/** Keys once on each side whose values differ by more than the tolerance. */
	readonly outside: number
	readonly unmatched: number
	readonly repeated: number
	/** The largest numeric difference of a key once on each side. */
	readonly maxAbsDifference: number
}

export const agreementCounts = (
	tolerance: number,
	left: ReadonlyArray<readonly [string, string]>,
	right: ReadonlyArray<readonly [string, string]>
): AgreementCounts => {
	const l = keyedOf(left)
	const r = keyedOf(right)
	const keys = new Set([...l.values.keys(), ...r.values.keys()])
	const repeated = new Set([...l.repeated, ...r.repeated])
	let exactKeys = 0
	let withinKeys = 0
	let outside = 0
	let unmatched = 0
	let max = 0
	for (const key of keys) {
		const a = l.values.get(key)
		const b = r.values.get(key)
		if (a === undefined || b === undefined) {
			unmatched += 1
		} else if (!repeated.has(key)) {
			if (a === b) {
				exactKeys += 1
			} else {
				const d = Math.abs(Number(a) - Number(b))
				if (!Number.isNaN(d)) {
					max = Math.max(max, d)
				}
				if (d <= tolerance) {
					withinKeys += 1
				} else {
					outside += 1
				}
			}
		}
	}
	return {
		keys: keys.size,
		exact: exactKeys,
		withinTolerance: withinKeys,
		outside,
		unmatched,
		repeated: repeated.size,
		maxAbsDifference: max
	}
}

/**
 * The raw rows of statements run on the raw session, in order, concatenated, each cell as the text it was delivered.
 */
export const textRowsOf = Effect.fn("textRowsOf")(function* (
	raw: RawSession,
	statements: ReadonlyArray<VariantStatement>
): Effect.fn.Return<ReadonlyArray<TextRow>, SqlError | MalformedRows> {
	const out: Array<TextRow> = []
	for (const [i, s] of statements.entries()) {
		const values = yield* raw.values(s.sql, s.params)
		const texts = yield* Effect.fromResult(textRows(values, i))
		appendAll(out, texts)
	}
	return out
})

/**
 * A handwritten statement over `sql`, which delivers columns named as the generated heading: its outermost SELECT reads
 * them in the generated heading's order, each cast to text as the runtime's statement casts it.
 */
export const handwrittenRows = (heading: ReadonlyArray<string>, sql: string): string =>
	`SELECT ${Arr.join(
		Arr.map(heading, (h) => `h.${quoteIdent(h)}::text`),
		", "
	)} FROM (${sql}) AS h`

/** The public heading of a compiled template's delivering statement. */
export const headingOf = (compiled: Compiled): ReadonlyArray<string> =>
	Arr.map(compiled.compiled.template.heading, (c) => c.name)

/**
 * The position of column `name` in a compiled template's public heading, which its statements' rows deliver in order.
 */
export const columnAt = (compiled: Compiled, name: string): number => {
	const at = headingOf(compiled).indexOf(name)
	if (at < 0) {
		throw new GateSetupError({ what: `the heading has no column ${name}` })
	}
	return at
}

export const handwritten = (
	label: string,
	statements: Arr.NonEmptyReadonlyArray<VariantStatement>,
	transaction: VariantTransaction
): VariantSpec => ({
	role: "handwritten",
	label,
	statements,
	transaction,
	decode: { kind: "none" },
	outside: {}
})

/** A rejected rewrite of a query, kept as a counterexample: a handwritten form whose answer differs. */
export const counterexample = (
	label: string,
	statements: Arr.NonEmptyReadonlyArray<VariantStatement>,
	transaction: VariantTransaction
): VariantSpec => ({
	role: { counterexample: label },
	label,
	statements,
	transaction,
	decode: { kind: "none" },
	outside: {}
})

export const conditions = (c: {
	readonly workload: string
	readonly schemaState: string
	readonly data: string
	readonly parameters: Readonly<Record<string, unknown>>
	readonly semantics: string
	readonly cache: string
}): Conditions => ({
	workload: c.workload,
	schemaState: c.schemaState,
	dataDistribution: c.data,
	parameters: c.parameters,
	resultSemantics: c.semantics,
	cacheState: c.cache
})

/**
 * The phase names the query gates time: the harness's variant phases, the compile timings beside them and the whole
 * delivery as the application sees it.
 */
export const queryPhases = [
	"compileFirstMs",
	"compileWarmMs",
	"operationMs",
	"beginMs",
	"executeMs",
	"commitMs"
] as const

/** The check that both artifacts delivered the same public result, with the difference as its detail. */
export const agrees = (name: string, measure: QueryMeasure): GateCheck =>
	equivalence(
		name,
		measure.agreement.kind === "agree",
		measure.agreement.kind === "agree" ? "agree" : measure.agreement.difference
	)

export interface MeasureOptions {
	readonly samples: number
	readonly explainSamples: number
	readonly serverPlans: ReadonlyArray<PlanMode>
	readonly explain: ExplainOptions
	/** The conservative artifact's timed samples; its answer and plans are always captured. */
	readonly conservativeSamples: number
}

export interface QueryMeasure {
	readonly generated: VariantMeasure
	readonly conservative: VariantMeasure
	readonly delivered: { readonly generated: Delivered; readonly conservative: Delivered }
	/** The delivered public results of the two artifacts, as sets with nested arrays as sets. */
	readonly agreement: Agreement
}

/**
 * Delivers both artifacts of `compiled` through the runtime, times whole deliveries, and measures the statements each
 * sent on the raw session: the generated variant with its compile timings, the conservative one beside it.
 */
export const measureQuery = Effect.fn("measureQuery")(function* (
	runtime: Runtime,
	raw: RawSession,
	compiled: Compiled,
	values: HostParams,
	options: MeasureOptions
): Effect.fn.Return<QueryMeasure, DeliveryFailed | SqlError | MalformedPlan | MalformedRows> {
	const generated = yield* deliver(runtime, compiled, "optimized", values)
	const conservative = yield* deliver(runtime, compiled, "conservative", values)
	const generatedOp = yield* timeDeliveries(runtime, compiled, "optimized", values, options.samples)
	const conservativeOp = yield* timeDeliveries(
		runtime,
		compiled,
		"conservative",
		values,
		options.conservativeSamples
	)
	const variantOptions: VariantOptions = {
		samples: options.samples,
		warmup: 1,
		explainSamples: options.explainSamples,
		explain: options.explain,
		serverPlans: options.serverPlans
	}
	const generatedMeasure = yield* measureVariant(
		raw,
		deliveredVariant("generated", generated, compiled, generatedOp),
		variantOptions
	)
	const conservativeMeasure = yield* measureVariant(
		raw,
		deliveredAlone("conservative", conservative, { operationMs: conservativeOp }),
		{
			...variantOptions,
			samples: options.conservativeSamples,
			explainSamples: 1,
			serverPlans: []
		}
	)
	return {
		generated: generatedMeasure,
		conservative: conservativeMeasure,
		delivered: { generated, conservative },
		agreement: agreementOf(deliveredAgree("set")(generated.rows, conservative.rows))
	}
})
