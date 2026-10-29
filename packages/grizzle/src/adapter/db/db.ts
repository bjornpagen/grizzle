import { type Array as Arr, Effect, type Option, type Scope } from "effect"
import {
	apply,
	type CompiledChangeValue,
	compileChange,
	compileFailure
} from "#adapter/apply/index.ts"
import { type DbContext, registerContext } from "#adapter/db/context.ts"
import { type ApplyError, type ReadError, ReadFailure } from "#adapter/errors/execution.ts"
import { explain } from "#adapter/explain/index.ts"
import {
	type CompiledRead,
	makeReader,
	poolExecutor,
	type ReaderValue
} from "#adapter/reader/reader.ts"
import { refresh } from "#adapter/refresh/index.ts"
import type {
	ApplyOutcome,
	CompilableProgram,
	Compiled,
	CompileTarget,
	DbOf,
	Plan,
	ProgramDecoding,
	QueryResult,
	WorkloadHandles
} from "#adapter/types/db.ts"
import type { RowDecoder } from "#compiler/core/decoder.ts"
import { type CompileError, type CursorError, malformedDescription } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { builtMark } from "#compiler/core/phantom.ts"
import { isOrderedValue, isQueryValue } from "#compiler/query/build/index.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"
import type { Page } from "#compiler/types/page/page.ts"
import { isChangeSetValue } from "#compiler/write/changeset/value.ts"

/**
 * What a JavaScript caller passes as a ChangeSet and is none: the refusal db.apply compiles it to.
 */
const notAChangeSet = (): CompileError =>
	malformedDescription(
		SourceLoc("db.apply", []),
		"a ChangeSet value built by ChangeSet.empty, union or sequence"
	)

const compileLoc = SourceLoc("db.compile", [])

/** What a JavaScript caller passes to db.compile and is no program. */
const notAProgram = (): CompileError =>
	malformedDescription(
		compileLoc,
		"a query, an ordered query or a ChangeSet value the builders made"
	)

/** The refusal of an operation its compiled program does not allow, which the typed handle never offers. */
const notItsOperation = (): CompileError =>
	malformedDescription(
		compileLoc,
		"an operation of the compiled program: execute, get and page read a query, apply applies a ChangeSet"
	)

/**
 * A program db.compile compiled, over records A (its rows, or its read-backs), as a JavaScript caller sees it: every
 * operation, those its program does not allow refused with the compile refusal before any SQL.
 */
export interface CompiledOps<A> {
	execute(params: ParamMap): Effect.Effect<QueryResult<A>, ReadError>
	get(params: ParamMap): Effect.Effect<Option.Option<A>, ReadError>
	page<Q>(params: ParamMap, request: unknown): Effect.Effect<Page<A, Q>, ReadError | CursorError>
	apply(params: ParamMap): Effect.Effect<ApplyOutcome<A>, ApplyError>
}

/** A compiled read's operations; it applies nothing. */
export const readOps = <A>(read: CompiledRead<A>): CompiledOps<A> => ({
	execute: (params) => read.execute(params),
	get: (params) => read.get(params),
	page: (params, request) => read.page(params, request),
	apply: () => compileFailure(notItsOperation())
})

/** A compiled ChangeSet's operations; it reads nothing. */
export const changeOps = <A>(change: CompiledChangeValue<A>): CompiledOps<A> => {
	const refused = Effect.fail(ReadFailure.make({ reason: notItsOperation() }))
	return {
		execute: () => refused,
		get: () => refused,
		page: () => refused,
		apply: (params) => change.apply(params)
	}
}

/** The typed handle of a compiled program X over records A, on a Db of S (types/db Compiled). */
export const typedCompiled = <S, X, A>(ops: CompiledOps<A>): Compiled<S, X, A> => {
	const handle: Compiled<S, X, A> = {
		...builtMark,
		execute: (params) => ops.execute(params),
		get: (params) => ops.get(params),
		page: (params, request) => ops.page<X>(params, request),
		apply: (params) => ops.apply(params)
	}
	return Object.freeze(handle)
}

/** The decoder of a program db.compile takes: a query's rows, or a ChangeSet's read-backs. */
const programDecoder = <A>(program: ProgramDecoding<A>): RowDecoder<A> =>
	"rows" in program ? program.rows : program.reads

/**
 * The runtime operations of the Db over one context, which its methods dispatch to, each taking a program as a
 * JavaScript caller's value is: the reader of its reads, db.compile's compilation of any program, and the write,
 * refresh and explain operations. Tests reach them through dbRuntime for what the typed Db refuses.
 */
const runtimeOf = <S>(ctx: DbContext) => {
	const reader = makeReader<S>(ctx, poolExecutor(ctx))
	/** What db.compile runs: a query or ordered query through the reader, a ChangeSet through the write runtime. */
	const compileTyped = <A>(
		program: unknown,
		decoder: RowDecoder<A>
	): Effect.Effect<CompiledOps<A>, CompileError, Scope.Scope> =>
		Effect.suspend(() =>
			isChangeSetValue(program)
				? Effect.map(compileChange(ctx, program, decoder), changeOps)
				: isQueryValue(program) || isOrderedValue(program)
					? Effect.map(
							reader.compileWith(program, () => decoder),
							readOps
						)
					: Effect.fail(notAProgram())
		)
	/** The same for a JavaScript caller's value: a program carries its decoder, and any other value is refused. */
	const compile = (
		program: unknown
	): Effect.Effect<CompiledOps<unknown>, CompileError, Scope.Scope> =>
		isChangeSetValue(program)
			? compileTyped(program, program.reads)
			: isQueryValue(program) || isOrderedValue(program)
				? compileTyped(program, program.rows)
				: Effect.fail(notAProgram())
	const methods = {
		apply: (changes: unknown, params: ParamMap): Effect.Effect<ApplyOutcome<unknown>, ApplyError> =>
			Effect.suspend(() =>
				isChangeSetValue(changes)
					? apply(ctx, changes, changes.reads, params)
					: compileFailure(notAChangeSet())
			),
		refresh: (...relations: Arr.NonEmptyReadonlyArray<unknown>) =>
			Effect.suspend(() => refresh(ctx, relations)),
		explain: (program: unknown, params: ParamMap) =>
			Effect.suspend(() => explain(ctx, program, params))
	}
	return { reader, compileTyped, compile, methods }
}

/**
 * The Db object.
 *
 * Db<R, P> is a QueryReader whose reads each acquire their own transaction (reader/reader.ts poolExecutor), plus the
 * operations of the opened database:
 *
 * - workload holds the handles of the login's workload programs over R, compiled once by the layer (workload.ts);
 * - compile(program) compiles a query or ordered query through the reader, a ChangeSet through the write runtime;
 * - apply and explain are the write and explain runtime (../apply, ../explain), and refresh the
 *   derived-relation runtime (../refresh). The Db dispatches to each on a fixed path.
 *
 * Every operation reads the one DbContext Db.open built (context.ts), which is also registered for the operations that
 * need the Db's internals (dbContext). The Db value is built under the public type Db<R, P>: each method is implemented
 * under its signature, so its program argument has its precise type, and dispatches to the runtime operation that
 * runs it. The rows a read delivers and the read-backs an apply delivers are the records of the program value's own
 * decoders (a query's rows, a ChangeSet's reads), and parameters arrive as ParamArg<P>, each a ParamValue, which the
 * runtime takes as a ParamMap (types/core).
 *
 * The runtime a Db dispatches to, as a JavaScript caller sees it: its runtime operations, the reader of its reads
 * (under the reader view, reader.ts ReaderValue), and db.compile's compilation of any program.
 */
export interface DbRuntime {
	readonly reader: ReaderValue
	readonly compile: (
		program: unknown
	) => Effect.Effect<CompiledOps<unknown>, CompileError, Scope.Scope>
	readonly methods: DbOperations
}

interface DbOperations {
	apply(changes: unknown, params: ParamMap): Effect.Effect<ApplyOutcome<unknown>, ApplyError>
	refresh(...relations: Arr.NonEmptyReadonlyArray<unknown>): Effect.Effect<void, ApplyError>
	explain(program: unknown, params: ParamMap): Effect.Effect<ReadonlyArray<Plan>, ReadError>
}

const runtimes = new WeakMap<object, DbRuntime>()

export const makeDb = <R, P>(ctx: DbContext, workload: WorkloadHandles<R, P>): DbOf<R, P> => {
	const runtime = runtimeOf<R>(ctx)
	const { reader } = runtime
	const view: DbRuntime = runtime
	const db: DbOf<R, P> = {
		workload,
		get: reader.get,
		execute: reader.execute,
		page: reader.page,
		/** The program's decoder is its own: a query's rows, or a ChangeSet's read-backs. */
		compile: <X extends CompilableProgram, A>(
			program: CompileTarget<R, X, A>
		): Effect.Effect<Compiled<R, X, A>, CompileError, Scope.Scope> => {
			const decoder: RowDecoder<A> = programDecoder<A>(program)
			return Effect.map(runtime.compileTyped(program, decoder), (ops) =>
				typedCompiled<R, X, A>(ops)
			)
		},
		apply: (changes, params) =>
			Effect.suspend(() =>
				isChangeSetValue(changes)
					? apply(ctx, changes, changes.reads, params)
					: compileFailure(notAChangeSet())
			),
		refresh: (...relations) => runtime.methods.refresh(...relations),
		explain: (program, params) => runtime.methods.explain(program, params)
	}
	registerContext(db, ctx)
	runtimes.set(db, view)
	return db
}

/**
 * The runtime the opened Db dispatches every operation to, for what its types refuse (a program over a schema the
 * role does not admit, a ChangeSet outside the role's write list, a loop over queries of different types); undefined
 * for a value Db.open did not return.
 */
export const dbRuntime = <R, P>(db: DbOf<R, P>): DbRuntime | undefined => runtimes.get(db)
