import { Array as Arr, Effect, type Option, Record as Rec, Result, type Scope } from "effect"
import { missingExtension } from "#adapter/admission/expectation.ts"
import { type DbContext, dbReadFrame, type RoleContext } from "#adapter/db/context.ts"
import { toResult } from "#adapter/engine.ts"
import { type ReadError, ReadFailure } from "#adapter/errors/execution.ts"
import {
	HandleReleased,
	MissingCapability,
	type UnreadableAnswer
} from "#adapter/errors/failures.ts"
import { page as pageRuntime } from "#adapter/page/index.ts"
import { compiledPageTemplate, type PageSource } from "#adapter/page/page.ts"
import type { PageRuntime } from "#adapter/page/template.ts"
import { attachmentFacts } from "#adapter/reader/analysis.ts"
import { getEligibility } from "#adapter/reader/eligibility.ts"
import type { ExecutionInputs } from "#adapter/reader/execution.ts"
import { hostParams, readParams, unreadableArguments } from "#adapter/reader/params.ts"
import {
	executionInputs,
	type InputRefusal,
	type ParamCodecs,
	paramCodecs
} from "#adapter/reader/relations.ts"
import {
	programFlight,
	programGetFlight,
	type ReadProgram,
	templateProgram
} from "#adapter/reader/run.ts"
import type {
	Decoding,
	GetArg,
	GetTarget,
	KeyTarget,
	QueryReader,
	QueryResult
} from "#adapter/types/db.ts"
import { asReadFailure, type Flight, runFramed } from "#adapter/wire/batch.ts"
import { mintNaming, nameStatements, type StatementNaming } from "#adapter/wire/naming.ts"
import { bindGroups, type Row, type RowDecoder } from "#compiler/core/decoder.ts"
import {
	type CompileError,
	type CursorError,
	malformedDescription,
	unsupported
} from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Engine from "#compiler/core/result.ts"
import { queryInput } from "#compiler/program/compile.ts"
import type { CompiledTemplate } from "#compiler/program/template.ts"
import { isOrderedValue, isQueryValue } from "#compiler/query/build/index.ts"
import { keyLookup } from "#compiler/query/build/key.ts"
import type { EmittedText } from "#compiler/sql/ast.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"
import type { Page } from "#compiler/types/page/page.ts"
import type { QueryBase } from "#compiler/types/query/query.ts"

/**
 * QueryReader, and the compiled reads of db.compile.
 *
 * The reader runtime of a Db. Every read runs through its ReadExecutor, which sends the read's one flight on a session
 * leased for it: one read-only transaction of the Db's role, in one round trip (../wire/batch.ts runFramed). Its
 * templates are compiled for the `snapshot` evidence context: every read sees a lawful committed snapshot.
 *
 * Reads:
 *
 * - execute(query, params) compiles the query against the Db's role, for this read, so a query over a schema the role
 *   does not admit is refused, sends the selected artifact's
 *   statements (run.ts) and delivers the complete result, which collect returns. The
 *   rows are fetched by execute, so collect cannot fail.
 * - get(query, params) is execute of a query proved at most one row per parameter binding (eligibility.ts), as an
 *   Option. get(key, values) builds the keyed lookup (key.ts) and reads it the same way, its row decoded by the keyed
 *   relation's fact decoder.
 * - compile(query, decoder), what db.compile runs for a query or ordered query, compiles its read form once
 *   (compileReadForm: the template and its parameters' codecs, the query's decoder bound, an ordered query's page
 *   template, and a server statement name for every statement text the handle can send, named from its text), checks
 *   its capability, and releases the names on every session that parsed them when its Scope ends. The layer compiles
 *   the same read form for each query and key of the login's workloads, once (db/workload.ts). A form's handle
 *   (readHandle) executes, gets and pages with each call's parameters. Direct execute and a compiled handle run the
 *   same template, so the same SQL texts.
 * - page(query, params, request) is the cursor runtime (../page).
 *
 * Rows. A read's delivered rows are decoded by the value's own decoder (core/decoder.ts): the query's `rows`, or for a
 * keyed lookup the keyed relation's `fact`, bound to the layouts of the template's program (run.ts), which are settled
 * once per template and artifact, so the binding is made once and found again. Every row has the decoder's type by
 * construction: nothing is told a row's type. A layout the decoder cannot bind (a head column the statement does not
 * deliver, an attachment the analysis does not prove in the stated delivery) is the binding's CompileError, a failure to
 * compile.
 *
 * Failures. A read's error channel is ReadError: a statement the server refused is a ReadFailure whose reason is the
 * server's report, and a session's failure one whose reason is the wire's classification (wire/batch.ts asReadFailure).
 * A query that does not compile for this Db on a direct read, its decoder's binding included, is a ReadFailure whose
 * reason is the CompileError, at stage compile, as compile surfaces it; a CompileError names a location and a
 * capability, never a parameter value. A template that needs a capability the admitted database lacks, such as an
 * extension a relation parameter's heading names that is not installed in its compiled schema, is found before any
 * SQL: a direct read fails with the MissingCapability reason, at stage capability, and compile with CompileError
 * UnsupportedOperation naming that capability. A relation input the codec refuses is a ReadFailure whose reason is the
 * EncodingFailure that names it, at stage encode, and parameters past a bound of their transport InputTooLarge, at
 * stage resource, both before any SQL is sent (relations.ts, wire/batch.ts). An acquisition that fails on a direct read
 * is its refusal, at stage acquire.
 *
 * Runs a read's flight on a session of its own (see the header).
 */
export interface ReadExecutor {
	readonly run: <A>(flight: Flight<A, UnreadableAnswer>) => Effect.Effect<A, ReadError>
}

/**
 * Db's executor: each read leases a session of the Db's pool for its flight, runs it as the Db's role, and ends the lease
 * with the read.
 */
export const poolExecutor = (ctx: Pick<DbContext, "pool" | "prologue">): ReadExecutor => ({
	run: (flight) =>
		Effect.scoped(
			Effect.gen(function* () {
				const session = yield* Effect.mapError(
					ctx.pool.lease,
					(reason) => new ReadFailure({ reason })
				)
				const outcomes = yield* Effect.mapError(
					runFramed(session, dbReadFrame(ctx), flight.statements),
					asReadFailure
				)
				return yield* Effect.mapError(
					flight.read(outcomes),
					(reason) => new ReadFailure({ reason })
				)
			})
		)
})

/**
 * An executor that runs each flight as a compiled program of `naming` runs it: every statement text the program named
 * under its server statement (wire/naming.ts), the rest unnamed.
 */
const namingExecutor = (executor: ReadExecutor, naming: StatementNaming): ReadExecutor => ({
	run: (flight) =>
		executor.run({ statements: nameStatements(naming, flight.statements), read: flight.read })
})

/** Every statement text a run statement can send: its own form, and its large form when it has one. */
const runTexts = (run: {
	readonly spec: { readonly sql: EmittedText }
	readonly forms:
		| { readonly kind: "one" }
		| { readonly kind: "chosen"; readonly large: { readonly spec: { readonly sql: EmittedText } } }
}): ReadonlyArray<EmittedText> =>
	run.forms.kind === "chosen" ? [run.spec.sql, run.forms.large.spec.sql] : [run.spec.sql]

/** Every statement text a read program can send. */
export const programTexts = (program: ReadProgram): ReadonlyArray<EmittedText> =>
	Arr.flatMap(program.records, (r) => runTexts(r.run))

/** Every statement text a page runtime template can send, for its every request variant and probe, of both artifacts. */
const pageTexts = (runtime: PageRuntime): ReadonlyArray<EmittedText> =>
	Arr.flatMap(Rec.values(runtime.artifacts), (artifact) => [
		...Arr.flatMap(Rec.values(artifact.requests), (request) =>
			Arr.flatMap(request.records, (r) => runTexts(r.run))
		),
		...Arr.flatMap(Rec.values(artifact.probes), (probe) => runTexts(probe.statement))
	])

/**
 * The readers are built under their public types (types/db QueryReader, QueryResult): makeReader's methods
 * are implemented under QueryReader<S>'s signatures, so a query argument has its precise type, and the rows a read
 * delivers are its decoder's records. Parameters arrive as ParamArg<P>, each value a ParamValue by construction
 * (types/core), which the read pipeline takes as a ParamMap.
 *
 * What a JavaScript caller sees: a reader and result over any query, each method taking what such a
 * caller may pass. It is a view of the typed values, never a second reader: every typed reader is one,
 * since its methods are declared with method syntax. The tests that read over values known only at run time, loops
 * over queries of different types among them, read the typed readers through it.
 */
export interface QueryResultValue<Head = unknown> {
	readonly collect: Effect.Effect<ReadonlyArray<Head>, ReadError>
}

export interface ReaderValue {
	get(target: unknown, params: unknown): Effect.Effect<Option.Option<unknown>, ReadError>
	execute(query: unknown, params: unknown): Effect.Effect<QueryResultValue, ReadError>
	compile(query: unknown): Effect.Effect<CompiledReadValue, CompileError, Scope.Scope>
	page(
		query: unknown,
		params: unknown,
		request: unknown
	): Effect.Effect<Page<unknown, unknown>, ReadError | CursorError>
}

/**
 * A query db.compile compiled once, over records of type A, until its Scope ends: its reads with each call's
 * parameters. get reads a query proved at most one row per parameter binding, and page an ordered query; the typed
 * handle (types/db Compiled) offers exactly the reads its query allows, and the others answer their compile refusal.
 */
export interface CompiledRead<A> {
	/** The template the handle reads through. */
	readonly compiled: CompiledTemplate
	execute(params: ParamMap): Effect.Effect<QueryResult<A>, ReadError>
	get(params: ParamMap): Effect.Effect<Option.Option<A>, ReadError>
	page<Q>(params: ParamMap, request: unknown): Effect.Effect<Page<A, Q>, ReadError | CursorError>
}

/** A compiled read as a JavaScript caller sees it, each method taking what such a caller may pass: every one is one. */
export interface CompiledReadValue {
	readonly compiled: CompiledTemplate
	execute(params: unknown): Effect.Effect<QueryResultValue, ReadError>
	get(params: unknown): Effect.Effect<Option.Option<unknown>, ReadError>
	page(
		params: unknown,
		request: unknown
	): Effect.Effect<Page<unknown, unknown>, ReadError | CursorError>
}

/** A read's complete result over its typed rows. */
const collected = <A>(rows: ReadonlyArray<A>): QueryResult<A> => ({ collect: Effect.succeed(rows) })

/** A compiled read: its template, the program its rows are delivered through, and its parameters' codecs. */
interface ReadArtifacts {
	readonly compiled: CompiledTemplate
	readonly program: ReadProgram
	readonly codecs: ParamCodecs
}

/** A compiled read and its decoder bound to the program's layouts: each delivered Row read to a record of type A. */
interface Bound<A> {
	readonly compiled: ReadArtifacts
	readonly read: (row: Row) => A
}

/** The evidence context every read's template is compiled for. */
const context = "snapshot"

/**
 * The decoder of a get target's rows: a query's rows decoder, or the keyed relation's fact decoder. The target is
 * known to be a query, a built relation or closed relation, or a Key over a side of one (key.ts), so it carries its
 * decoder.
 */
const decoderOf = <A>(target: Decoding<A>): RowDecoder<A> =>
	"rows" in target ? target.rows : "fact" in target ? target.fact : target.side.source.fact

/**
 * A typed reader: QueryReader<S>'s operations as properties, each a function a caller may take off the reader, and the
 * compiled read db.compile runs for a query, its rows read by `decoder`.
 */
export interface Reader<S> {
	readonly get: QueryReader<S>["get"]
	readonly execute: QueryReader<S>["execute"]
	readonly page: QueryReader<S>["page"]
	/** A query compiled once, its rows read by its own rows decoder: the reader view's compile. */
	readonly compile: (
		query: unknown
	) => Effect.Effect<CompiledRead<unknown>, CompileError, Scope.Scope>
	/** A query compiled once, its rows read by `decoder`: what db.compile runs for a query or ordered query. */
	readonly compileWith: <A>(
		query: unknown,
		decoder: () => RowDecoder<A>
	) => Effect.Effect<CompiledRead<A>, CompileError, Scope.Scope>
}

/**
 * The template of a query compiled for `role` and the program its rows are delivered through (run.ts), whose
 * attachments the analysis describes (analysis.ts), with its parameters' codecs. The caller's value is parsed here, once
 * (program/compile.ts queryInput), and the compiler takes the parsed query.
 */
const compileArtifacts = (
	role: RoleContext,
	query: unknown
): Result.Result<ReadArtifacts, CompileError> =>
	Result.map(
		toResult(
			Engine.flatMap(queryInput(query), (input) => role.compile(input, { context, read: "rows" }))
		),
		(compiled): ReadArtifacts => ({
			compiled,
			program: templateProgram(
				compiled.template,
				compiled.selection.artifact,
				attachmentFacts(compiled.template, compiled.desc),
				role.artifacts.names.codes
			),
			codecs: paramCodecs(compiled.template.params, role.artifacts.names.codes)
		})
	)

/**
 * A decoder bound to a compiled read's layouts under `role`'s bind context, once per template and artifact. The decoder
 * is read once the query compiled, since a JavaScript caller's value may be no query.
 */
const bindArtifacts = <A>(
	role: RoleContext,
	compiled: ReadArtifacts,
	decoder: () => RowDecoder<A>
): Result.Result<Bound<A>, CompileError> =>
	Result.map(toResult(bindGroups(decoder(), compiled.program.layouts, role.bind)), (read) => ({
		compiled,
		read
	}))

/**
 * The capability a template needs that the admitted database lacks, if any: an extension a relation parameter's
 * heading or a stored relation needs, installed nowhere or in another schema than its compiled names expect. Found
 * before any of the template's SQL is sent.
 */
const missingOf = (
	compiled: ReadArtifacts,
	installed: ReadonlyMap<string, string>
): string | undefined => missingExtension(compiled.compiled.template.requirements, installed)

/** How a read delivers its program's rows: every one, or the one row of a query proved at most one (run.ts). */
type Delivery<A, X> = (
	program: ReadProgram,
	inputs: ExecutionInputs,
	read: (row: Row) => A
) => Effect.Effect<Flight<X, UnreadableAnswer>, InputRefusal>

/** One run of a bound read with the parameters, through `through`, its rows delivered by `delivery`. */
const runBound = <A, X>(
	bound: Bound<A>,
	params: ParamMap,
	through: ReadExecutor,
	delivery: Delivery<A, X>
): Effect.Effect<X, ReadError> =>
	Effect.gen(function* () {
		const compiled = bound.compiled
		const values = yield* hostParams(compiled.compiled.template.params, params)
		const flight = yield* Effect.mapError(
			Effect.flatMap(Effect.fromResult(executionInputs(compiled.codecs, values)), (ready) =>
				delivery(compiled.program, ready, bound.read)
			),
			(reason) => new ReadFailure({ reason })
		)
		return yield* through.run(flight)
	})

/**
 * `run` while the Scope of the compiled handle it belongs to holds, and `released` after it ends: the handle's server
 * statements are released with its Scope, and any reference can outlive a Scope, so a use after it is the caller's,
 * refused with HandleReleased before any SQL.
 */
export const whileLive = <X, E>(
	live: () => boolean,
	released: () => E,
	run: () => Effect.Effect<X, E>
): Effect.Effect<X, E> => Effect.suspend(() => (live() ? run() : Effect.fail(released())))

/** A read of a handle whose Scope ended. */
const readReleased = (): ReadFailure => new ReadFailure({ reason: new HandleReleased() })

/**
 * A query compiled once for a role, ahead of the reads that run it: its template and parameters' codecs, its decoder
 * bound, an ordered query's page template, whether get may read it, and a server statement name for every statement
 * text its reads can send (wire/naming.ts), each named from its text. db.compile compiles one for its Db, and the layer
 * one for each query and key of the login's workloads, for every role it runs on.
 */
export interface ReadForm<A> {
	readonly query: unknown
	readonly decoder: () => RowDecoder<A>
	readonly bound: Bound<A>
	readonly page: PageSource
	readonly naming: StatementNaming
	readonly eligible: ReturnType<typeof getEligibility>
}

/** The read form of `query` for `role`, its rows read by `decoder`: a query that does not compile is its CompileError. */
export const compileReadForm = <A>(
	role: RoleContext,
	query: unknown,
	decoder: () => RowDecoder<A>
): Result.Result<ReadForm<A>, CompileError> =>
	Result.gen(function* () {
		const compiled = yield* compileArtifacts(role, query)
		const bound = yield* bindArtifacts(role, compiled, decoder)
		const page: PageSource = isOrderedValue(query)
			? { kind: "compiled", page: yield* compiledPageTemplate(role, query) }
			: { kind: "query" }
		const naming = mintNaming([
			...programTexts(compiled.program),
			...(page.kind === "compiled" ? pageTexts(page.page.runtime) : [])
		])
		return {
			query,
			decoder,
			bound,
			page,
			naming,
			eligible: getEligibility(compiled.compiled.template)
		}
	})

/** The capability a read form needs that the admitted database lacks, if any: its template's, or its page's. */
export const readFormMissing = (
	form: ReadForm<unknown>,
	installed: ReadonlyMap<string, string>
): string | undefined =>
	missingOf(form.bound.compiled, installed) ??
	(form.page.kind === "compiled"
		? missingExtension(form.page.page.compiled.template.requirements, installed)
		: undefined)

/**
 * The handle of a read form on a Db: its reads run through `executor` under the form's server statements, while
 * `live` holds; a read after it ends is refused with HandleReleased.
 */
export const readHandle = <A>(
	ctx: DbContext,
	executor: ReadExecutor,
	form: ReadForm<A>,
	live: () => boolean
): CompiledRead<A> => {
	const named = namingExecutor(executor, form.naming)
	const alive = <X, E>(read: () => Effect.Effect<X, E>) =>
		whileLive<X, E | ReadFailure>(live, readReleased, read)
	const { bound, eligible } = form
	return {
		compiled: bound.compiled.compiled,
		execute: (params) =>
			alive(() => Effect.map(runBound(bound, params, named, programFlight), collected)),
		get: (params) =>
			alive(() =>
				Result.isFailure(eligible)
					? Effect.fail(new ReadFailure({ reason: eligible.failure }))
					: runBound(bound, params, named, programGetFlight)
			),
		page: <Q>(params: ParamMap, request: unknown) =>
			alive(() =>
				pageRuntime<A, Q>({
					ctx,
					executor: named,
					query: form.query,
					decoder: form.decoder,
					params,
					request,
					source: form.page
				})
			)
	}
}

/**
 * The reader of `ctx`, its reads run by `executor`. A JavaScript caller may pass any value; one that names no key does
 * not compile.
 */
export const makeReader = <S>(ctx: DbContext, executor: ReadExecutor): Reader<S> => {
	/**
	 * A direct read's template and bound decoder: a query that does not compile, or whose decoder does not bind, is
	 * refused with its CompileError, and a capability the database lacks with MissingCapability.
	 */
	const readable = <A>(
		query: unknown,
		decoder: () => RowDecoder<A>
	): Effect.Effect<Bound<A>, ReadError> =>
		Effect.suspend(() => {
			const compiled = compileArtifacts(ctx, query)
			if (Result.isFailure(compiled)) {
				return Effect.fail(new ReadFailure({ reason: compiled.failure }))
			}
			const missing = missingOf(compiled.success, ctx.installedExtensions)
			if (missing !== undefined) {
				return Effect.fail(
					new ReadFailure({ reason: new MissingCapability({ capability: missing }) })
				)
			}
			return Effect.mapError(
				Effect.fromResult(bindArtifacts(ctx, compiled.success, decoder)),
				(reason) => new ReadFailure({ reason })
			)
		})

	/** A read of a query value through `decoder`: its compiled template, run with the parameters. */
	const executeQuery = <A>(
		query: unknown,
		decoder: () => RowDecoder<A>,
		params: ParamMap
	): Effect.Effect<ReadonlyArray<A>, ReadError> =>
		Effect.flatMap(readable(query, decoder), (bound) =>
			runBound(bound, params, executor, programFlight)
		)

	const getQuery = <A>(
		query: unknown,
		decoder: () => RowDecoder<A>,
		params: ParamMap
	): Effect.Effect<Option.Option<A>, ReadError> =>
		Effect.flatMap(readable(query, decoder), (bound) => {
			const eligible = getEligibility(bound.compiled.compiled.template)
			if (Result.isFailure(eligible)) {
				return Effect.fail(new ReadFailure({ reason: eligible.failure }))
			}
			return runBound(bound, params, executor, programGetFlight)
		})

	/**
	 * The row of get's target: a query's, or the keyed lookup's (key.ts), whose parameters are the key's values and
	 * whose rows the keyed relation's fact decoder reads.
	 */
	const getRow = <A>(
		target: unknown,
		decoding: Decoding<A>,
		params: ParamMap
	): Effect.Effect<Option.Option<A>, ReadError> =>
		Effect.suspend(() => {
			if (isQueryValue(target) || isOrderedValue(target)) {
				return getQuery(target, () => decoderOf(decoding), params)
			}
			const lookup = keyLookup(ctx.schema.value, target)
			if (lookup === undefined) {
				return Effect.fail(
					new ReadFailure({
						reason: malformedDescription(
							SourceLoc("reader.get", []),
							"a query, a relation, a closed relation or a Key built by key()"
						)
					})
				)
			}
			/**
			 * The key values off the caller's map, read once at the boundary (params.ts readParams): a map or a value
			 * whose reading throws encodes nothing.
			 */
			const bound = readParams(lookup.target.fields, params, unreadableArguments())
			if (Result.isFailure(bound)) {
				return Effect.fail(bound.failure)
			}
			return getQuery(lookup.query, () => decoderOf(decoding), bound.success)
		})

	/**
	 * The compiled read of `query` for db.compile (see the header): its read form compiled once, refused with
	 * UnsupportedOperation for a capability the database lacks; its server statements released when the Scope ends,
	 * after which the handle's compiled form is dropped and a read of it is refused with HandleReleased.
	 */
	const compileRead = <A>(
		query: unknown,
		decoder: () => RowDecoder<A>
	): Effect.Effect<CompiledRead<A>, CompileError, Scope.Scope> =>
		Effect.gen(function* () {
			const form = yield* Effect.suspend(() =>
				Effect.fromResult(compileReadForm(ctx, query, decoder))
			)
			const missing = readFormMissing(form, ctx.installedExtensions)
			if (missing !== undefined) {
				return yield* Effect.fail(unsupported(SourceLoc("db.compile", []), missing))
			}
			const state = { live: true }
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					state.live = false
					ctx.pool.release([...form.naming.values()])
				})
			)
			return readHandle(ctx, executor, form, () => state.live)
		})

	return {
		get: <X extends QueryBase | KeyTarget, A>(
			target: GetTarget<S, X, A>,
			params: NoInfer<GetArg<X>>
		): Effect.Effect<Option.Option<A>, ReadError> => {
			const decoding: Decoding<A> = target
			return getRow(target, decoding, params)
		},
		execute: (query, params) =>
			Effect.map(
				executeQuery(query, () => query.rows, params),
				collected
			),
		page: (query, params, request) =>
			pageRuntime({
				ctx,
				executor,
				query,
				decoder: () => query.rows,
				params,
				request,
				source: { kind: "query" }
			}),
		compile: (query) =>
			isQueryValue(query) || isOrderedValue(query)
				? compileRead(query, () => query.rows)
				: Effect.fail(
						malformedDescription(
							SourceLoc("db.compile", []),
							"a query or an ordered query value the builders made"
						)
					),
		compileWith: compileRead
	}
}
