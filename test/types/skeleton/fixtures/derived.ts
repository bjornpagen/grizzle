import { ChangeSet } from "#compiler/public/changeset.ts"
import { schema } from "#compiler/public/schema.ts"
import type { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { WritableOf } from "#compiler/types/changeset/changeset.ts"
import type { DerivedConstructor } from "#compiler/types/derived/derived.ts"
import type { HeadOf, Query } from "#compiler/types/query/query.ts"
import type { Fact } from "#compiler/types/schema/relation.ts"
import type { KeysOf, LevelsOf } from "#compiler/types/schema/schema.ts"
import type { RefreshListOf } from "#compiler/types/schema/world.ts"
import { derived, query, v } from "#index.ts"
import {
	Account,
	Clock,
	Edu,
	type EpochDay,
	Instant,
	type RecentSittings,
	type Refresher,
	type Reporter,
	Reports,
	recentSittings,
	Sitting,
	StudentWeekly,
	Task,
	type Work
} from "#test/types/skeleton/fixtures/work.ts"
import type { Equals, Expect, IsAssignable, Not } from "#test/types/skeleton/support.ts"

/**
 * Derived relations and schema levels over declare-only values. Every
 * `@ts-expect-error -- TSnnnn` names the diagnostic the harness requires on the next line.
 */
type Base = typeof Edu
type Ext = typeof Reports

/**
 * Query<Ext> is not assignable to Query<Base>, so a definition over an extension never stands where a
 * query over its base is required. Query is invariant in its schema; where a query over a base may stand for one over
 * an extension, the consumer accepts every level of its
 * schema (LevelsOf), as the db fixture shows for readers and db.apply.
 */
export type ExtIsNotBase = Expect<
	Not<IsAssignable<Query<Ext, { readonly a: string }>, Query<Base, { readonly a: string }>>>
>

export type BaseIsNotExt = Expect<
	Not<IsAssignable<Query<Base, { readonly a: string }>, Query<Ext, { readonly a: string }>>>
>

export type UnrelatedSchemas = Expect<
	Not<IsAssignable<Query<typeof Work, unknown>, Query<Base, unknown>>>
>
/**
 * Edu and Reports differ in their relations and statements, so the two assertions above hold on structure alone.
 * Schemas that are structural subtypes of one another show that Query compares its schema invariantly: a covariant
 * phantom would let the wider schema, or the base, stand for the other.
 */
export const Narrow = schema("Same", { Account }, [])
export const Wide = schema("Same", { Account, Task }, [])
export const EmptyExt = schema.extend(Edu, {}, [])
export type WideIsNotNarrow = Expect<
	Not<
		IsAssignable<
			Query<typeof Wide, { readonly a: string }>,
			Query<typeof Narrow, { readonly a: string }>
		>
	>
>

export type BaseIsNotEmptyExt = Expect<
	Not<
		IsAssignable<
			Query<Base, { readonly a: string }>,
			Query<typeof EmptyExt, { readonly a: string }>
		>
	>
>
export type ExtLevels = Expect<Equals<LevelsOf<Ext>, Ext | Base>>
export type BaseLevels = Expect<Equals<LevelsOf<Base>, Base>>
export type NextLevels = Expect<Equals<LevelsOf<typeof NextLevel>, typeof NextLevel | Ext | Base>>

/** A derived relation's fields come from its definition's head; its keys from its definition's evidence. */
export type WeeklyFact = Expect<
	Equals<
		Fact<typeof StudentWeekly>,
		{
			readonly student: string
			readonly week: Fact<typeof Sitting>["day"]
			readonly sittings: bigint
			readonly passes: bigint
		}
	>
>

export type WeeklyKeys = Expect<
	Equals<KeysOf<Ext, typeof StudentWeekly>, ReadonlyArray<"student" | "week">>
>

export type RecentKeys = Expect<
	Equals<KeysOf<Ext, typeof RecentSittings>, ReadonlyArray<"student">>
>

export type WeekIsEpochDay = Expect<
	Equals<Fact<typeof StudentWeekly>["week"], ReturnType<typeof EpochDay>>
>

/** A derived relation is matchable in a rule over its extension, never over its base. */
export const weeklyPasses = query(Reports).rule((r) => {
	const { student, passes } = v(StudentWeekly)
	return r.match(StudentWeekly, { student, passes }).find({ student, total: r.sum(passes) })
})
export type WeeklyPassesTotal = Expect<Equals<HeadOf<typeof weeklyPasses>["total"], Decimal>>
export const readsOwnLevel = query(Edu).rule((r) => {
	const { student } = v(StudentWeekly)
	// @ts-expect-error -- TS2345 refusal: the relation is not in this query's schema
	return r.match(StudentWeekly, { student }).find({ student })
})

/**
 * Importing a query does not lift that restriction: a query over the extension, matched directly or through bind,
 * is not over a level of the base.
 */
export const importsOwnLevel = query(Edu).rule((r) => {
	const { student } = v(weeklyPasses)
	// @ts-expect-error -- TS2345 refusal: the query is not over a level of this query's schema
	return r.match(weeklyPasses, { student }).find({ student })
})

export const weeklyFor = query(Reports).rule((r) => {
	const { passes } = v(StudentWeekly)
	return r
		.match(StudentWeekly, { student: r.param("student", Sitting.fields.student), passes })
		.find({ passes })
})

export const bindsOwnLevel = query(Edu).rule((r) => {
	const { id } = v(Sitting)
	const weekly = weeklyFor.bind({ student: id })
	const { passes } = v(weekly)
	return (
		r
			.match(Sitting, { id })
			// @ts-expect-error -- TS2345 refusal: the query is not over a level of this query's schema
			.match(weekly, { passes })
			.find({ id, passes })
	)
})

/** A query over a lower level imports into a query over a higher one. */
export const importsLowerLevel = query(Reports).rule((r) => {
	const { student, recent } = v(recentSittings)
	return r.match(recentSittings, { student, recent }).find({ student, recent })
})

/**
 * Refused derived shapes: a parameterized definition, a definition reading its own level,
 * a ChangeSet member naming a derived relation, and a refresh outside the role's refresh list do not typecheck.
 */
export const parameterized = query(Edu).rule((r) => {
	const { student } = v(Sitting)
	return r.match(Sitting, { student: r.param("student", Sitting.fields.student) }).find({ student })
})
// @ts-expect-error -- TS2345: a derived definition reads no parameter
export const ParameterizedDerived = derived("Parameterized", parameterized)
/**
 * OwnLevel reads StudentWeekly, so it is declared one level above it; declared beside it, it would read its own level.
 */
export const OwnLevel = derived("OwnLevel", weeklyPasses)
export const NextLevel = schema.extend(Reports, { OwnLevel }, [])
// @ts-expect-error -- TS2322: OwnLevel's definition reads the level it would be declared at
export const ReadsItself = schema.extend(Edu, { StudentWeekly, OwnLevel }, [])
/** A definition may read any level below the one it is declared at, not only the one directly below. */
export const LowerLevel = derived("LowerLevel", recentSittings)
export const SkipsALevel = schema.extend(Reports, { LowerLevel }, [])

/** WritableOf excludes derived and closed relations, so no ChangeSet member names one. */
export type ReportsWritable = Expect<
	Equals<NameOfWritable<Ext>, "Student" | "Sitting" | "SchoolCalendar" | "Clock">
>

type NameOfWritable<S> =
	WritableOf<S> extends infer R ? (R extends { readonly name: infer N } ? N : never) : never
export const writesClock = ChangeSet.empty(Reports).put(Clock, [{ id: "current", at: Instant(0n) }])
// @ts-expect-error -- TS2345 refusal: a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes
export const writesDerived = ChangeSet.empty(Reports).insert(StudentWeekly, [])

/** The refresh reader: only the derived relations a role lists under refresh. */
export type RefresherList = Expect<
	Equals<RefreshListOf<typeof Refresher>, typeof StudentWeekly | typeof RecentSittings>
>
export type ReporterList = Expect<Equals<RefreshListOf<typeof Reporter>, never>>

/** The shipped derived has the public signature itself: no declare-only twin stands in for it. */
export type DerivedIsTheConstructor = Expect<Equals<typeof derived, DerivedConstructor>>
