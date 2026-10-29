import { type DbContext, dbContext } from "#adapter/db/context.ts"
import { type DbRuntime, dbRuntime } from "#adapter/db/db.ts"
import type { Db } from "#adapter/public/db.ts"
import type { ReaderValue } from "#adapter/reader/reader.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"

/**
 * The runtime of an opened Db (packages/grizzle/src/adapter/db/db.ts), for what the typed Db refuses: a program whose type the schema
 * type argument does not admit, a ChangeSet outside the role's write list, or a loop over queries of different
 * types. Each helper takes the Db itself and calls the very method record the Db value is (dbRuntime), so a guard, a
 * span or an ordering in db.ts reaches the tests through it; the runtime types every program it takes `unknown`, as
 * a JavaScript caller's value is.
 *
 * The DbContext of an opened Db; any other value is a defect of the test.
 */
export const contextOf = <R, P>(db: Db<R, P>): DbContext => {
	const ctx = dbContext(db)
	if (ctx === undefined) {
		throw new Error("not a Db value")
	}
	return ctx
}

/** The runtime of an opened Db; any other value is a defect of the test. */
const runtimeOf = <R, P>(db: Db<R, P>): DbRuntime => {
	const runtime = dbRuntime(db)
	if (runtime === undefined) {
		throw new Error("not a Db value")
	}
	return runtime
}

/** The reader db.get, db.execute and db.page dispatch to: one transaction per read from the pool. */
export const dbReader = <R, P>(db: Db<R, P>): ReaderValue => runtimeOf(db).reader

/** db.apply. */
export const applyRuntime = <R, P>(
	db: Db<R, P>,
	changes: unknown,
	params: ParamMap
): ReturnType<DbRuntime["methods"]["apply"]> => runtimeOf(db).methods.apply(changes, params)

/** db.compile(program) for any program: its compiled handle, its operations as a JavaScript caller sees them. */
export const compileRuntime = <R, P>(
	db: Db<R, P>,
	program: unknown
): ReturnType<DbRuntime["compile"]> => runtimeOf(db).compile(program)
