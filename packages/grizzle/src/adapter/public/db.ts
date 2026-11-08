import type {
	ApplyOutcome as ApplyOutcomeOf,
	ApplyOutcomeConstructor,
	DbOf
} from "#adapter/types/db.ts"

/**
 * Public barrel: Db, QueryReader, Compiled, ApplyOutcome, QueryResult, Plan and the page types.
 * packages/grizzle/src/index.ts re-exports it.
 *
 * `Db` is both the value Db.open lives on and the type of an opened database. The types are the public shapes of
 * packages/grizzle/src/adapter/types/db.ts; the value is the adapter's (packages/grizzle/src/adapter/db/open.ts). No driver type appears here.
 *
 * `ApplyOutcome` is both what db.apply answers and the value of its constructors, the adapter's own
 * (packages/grizzle/src/adapter/outcomes), so an application's test builds the exact outcome db.apply answers.
 *
 * The cursor pagination types: an application names a Page in its own signatures and
 * turns a cursor string from its caller back into an `after` or `before`. packages/engine/src/types/page holds them.
 */
export type { Page, PageCursor, PageEdge, PageInfo, PageRequest } from "#compiler/plan/read.ts"

import { DbValue } from "#adapter/db/open.ts"
import { applyOutcome } from "#adapter/outcomes/index.ts"

export type { NoTokenOptions, OpenOptions, TokenOptions } from "#adapter/types/db.ts"

export const Db: typeof DbValue = DbValue
export type Db<R, P> = DbOf<R, P>

export const ApplyOutcome: ApplyOutcomeConstructor = applyOutcome
export type ApplyOutcome<Reads> = ApplyOutcomeOf<Reads>

export type {
	AtMostOneRow,
	CompilableProgram,
	Compiled,
	CompileTarget,
	Plan,
	ProgramDecoding,
	QueryReader,
	QueryResult,
	WorkloadHandles
} from "#adapter/types/db.ts"
