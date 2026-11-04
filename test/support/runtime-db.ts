import { type Array as Arr, Effect, type Scope } from "effect"
import { apply } from "#adapter/apply/index.ts"
import { type DbContext, dbContext } from "#adapter/db/context.ts"
import { type CompiledOps, runtimeOf } from "#adapter/db/db.ts"
import type { ApplyError } from "#adapter/errors/execution.ts"
import type { Db } from "#adapter/public/db.ts"
import type { ReaderValue } from "#adapter/reader/reader.ts"
import type { ApplyOutcome } from "#adapter/types/db.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { isOrderedValue, isQueryValue } from "#compiler/query/build/index.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"
import { isChangeSetValue } from "#compiler/write/changeset/value.ts"

/**
 * The runtime of an opened Db (packages/grizzle/src/adapter/db/db.ts runtimeOf), for what the typed Db refuses: a
 * program whose type the schema type argument does not admit, a ChangeSet outside the role's write list, or a loop over
 * queries of different types. It is the runtime the Db's methods dispatch to, built over the Db's own context, so a
 * guard, a span or an ordering there reaches the tests through it; it types every program `unknown`, as a JavaScript
 * caller's value is, and a value that is no program the builders made is a defect of the test.
 */
export interface DbRuntime {
	/** The reader db.get, db.execute and db.page dispatch to: one transaction per read from the pool. */
	readonly reader: ReaderValue
	/** db.compile(program) for any program: its compiled handle, its operations as a JavaScript caller sees them. */
	readonly compile: (
		program: unknown
	) => Effect.Effect<CompiledOps<unknown>, CompileError, Scope.Scope>
	readonly methods: {
		/** db.apply. */
		readonly apply: (
			changes: unknown,
			params: ParamMap
		) => Effect.Effect<ApplyOutcome<unknown>, ApplyError>
		/** db.refresh. */
		readonly refresh: (
			relations: Arr.NonEmptyReadonlyArray<unknown>
		) => Effect.Effect<void, ApplyError>
	}
}

/** The runtime over an opened Db's context (see DbRuntime). */
const runtimeFor = (ctx: DbContext): DbRuntime => {
	const runtime = runtimeOf(ctx)
	return {
		reader: runtime.reader,
		compile: (program) =>
			isChangeSetValue(program)
				? runtime.compileTyped(program, program.reads)
				: isQueryValue(program) || isOrderedValue(program)
					? runtime.compileTyped(program, program.rows)
					: Effect.die(new Error("db.compile of a value that is no program")),
		methods: {
			apply: (changes, params) =>
				Effect.suspend(() =>
					isChangeSetValue(changes)
						? apply(ctx, changes, changes.reads, params)
						: Effect.die(new Error("db.apply of a value that is no ChangeSet"))
				),
			refresh: runtime.refresh
		}
	}
}

/**
 * The DbContext of an opened Db; any other value is a defect of the test.
 */
export const contextOf = <R, P>(db: Db<R, P>): DbContext => {
	const ctx = dbContext(db)
	if (ctx === undefined) {
		throw new Error("not a Db value")
	}
	return ctx
}

/** The runtime of an opened Db (see DbRuntime); undefined for a value Db.open did not return. */
export const dbRuntime = <R, P>(db: Db<R, P>): DbRuntime | undefined => {
	const ctx = dbContext(db)
	return ctx === undefined ? undefined : runtimeFor(ctx)
}

/** The reader db.get, db.execute and db.page dispatch to: one transaction per read from the pool. */
export const dbReader = <R, P>(db: Db<R, P>): ReaderValue => runtimeFor(contextOf(db)).reader

/** db.apply. */
export const applyRuntime = <R, P>(
	db: Db<R, P>,
	changes: unknown,
	params: ParamMap
): ReturnType<DbRuntime["methods"]["apply"]> =>
	runtimeFor(contextOf(db)).methods.apply(changes, params)

/** db.compile(program) for any program: its compiled handle, its operations as a JavaScript caller sees them. */
export const compileRuntime = <R, P>(
	db: Db<R, P>,
	program: unknown
): ReturnType<DbRuntime["compile"]> => runtimeFor(contextOf(db)).compile(program)
