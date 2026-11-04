import type { built, phantom } from "#compiler/core/phantom.ts"
import type {
	Evidence,
	Finished,
	Ordered,
	Query,
	QueryBuilder,
	Rule
} from "#compiler/public/query.ts"
import type { Work } from "#test/types/query/fixtures/work.ts"
import type { Equals, Expect } from "#test/types/query/support.ts"

/**
 * The surface of the typed facade: every method the public types promise on a rule, a query builder, a query, an
 * ordered query and a finished arm, listed once. The lists are checked against the types here and against the runtime
 * builder's values by query.test.ts, so a method the types declare and the builder lacks, or the reverse, fails.
 *
 * A surface is the same at every schema and heading: the members of each interface are listed at the worked example's.
 */
type S = typeof Work
type Head = { readonly id: string }

/**
 * The phantoms the type level reads and no runtime value carries, all under the one phantom key, the brand every
 * builder-made value carries (core/phantom.ts), and a value's heading of carriers and decoders, none of them a method.
 */
type Phantom =
	| typeof built
	| typeof phantom
	| "heading"
	| "evidence"
	| "params"
	| "paramsInvariant"
	| "sourceParams"
	| "schema"
	| "rows"
	| "immediate"

export const ruleMethods = [
	"match",
	"where",
	"find",
	"interior",
	"param",
	"relation",
	"eq",
	"ne",
	"lt",
	"le",
	"gt",
	"ge",
	"between",
	"inSet",
	"and",
	"or",
	"not",
	"allen",
	"pointIn",
	"intersection",
	"difference",
	"pack",
	"count",
	"sum",
	"mean",
	"min",
	"max"
] as const
export type RuleSurface = Expect<Equals<keyof Rule<S>, (typeof ruleMethods)[number]>>

export const builderMethods = ["rule", "recursive"] as const
export type BuilderSurface = Expect<Equals<keyof QueryBuilder<S>, (typeof builderMethods)[number]>>

export const queryMethods = [
	"rule",
	"attach",
	"named",
	"bind",
	"orderBy",
	"approximateNearest"
] as const

export type QuerySurface = Expect<
	Equals<Exclude<keyof Query<S, Head>, Phantom>, (typeof queryMethods)[number]>
>

export const orderedMethods = ["take"] as const
export type OrderedSurface = Expect<
	Equals<Exclude<keyof Ordered<S, Head>, Phantom>, (typeof orderedMethods)[number]>
>

export const finishedMethods = ["attach"] as const
export type FinishedSurface = Expect<
	Equals<Exclude<keyof Finished<Head, Evidence.Unknown>, Phantom>, (typeof finishedMethods)[number]>
>
