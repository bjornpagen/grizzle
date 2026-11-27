import { element, type Gen } from "@bjornpagen/testing/gen"
import { type Array as Arr, Effect, Record as Rec } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The plan shapes a read is held to one answer under, each a whole assignment of the planner settings it moves, so
 * one shape's assignment overrides every other's: hash joins and aggregates, merge joins and sorts, nested loops over
 * index scans, and every eligible query in a parallel worker (debug_parallel_query = regress). A test sets them on a
 * login in its case's own database before its Db opens (planShapeOn); grizzle sets none. A shape only widens what an
 * answer is compared under: a run under one asserts its answer's equality to the oracle's and nothing else, never a
 * page, a row count, a plan's shape or a cost bound, and no property that bounds a statement's work reads one
 * (test/support/oracle/perturb.ts, the same line).
 */
const planShapes = {
	hash: {
		enable_hashjoin: "on",
		enable_mergejoin: "off",
		enable_nestloop: "off",
		enable_hashagg: "on",
		enable_sort: "off",
		enable_seqscan: "on",
		debug_parallel_query: "off"
	},
	sort: {
		enable_hashjoin: "off",
		enable_mergejoin: "on",
		enable_nestloop: "off",
		enable_hashagg: "off",
		enable_sort: "on",
		enable_seqscan: "on",
		debug_parallel_query: "off"
	},
	index: {
		enable_hashjoin: "off",
		enable_mergejoin: "off",
		enable_nestloop: "on",
		enable_hashagg: "off",
		enable_sort: "on",
		enable_seqscan: "off",
		debug_parallel_query: "off"
	},
	parallel: {
		enable_hashjoin: "on",
		enable_mergejoin: "on",
		enable_nestloop: "on",
		enable_hashagg: "on",
		enable_sort: "on",
		enable_seqscan: "on",
		debug_parallel_query: "regress"
	}
} as const
export type PlanShape = keyof typeof planShapes

/** Every plan shape, by its name. */
export const planShapeNames: Arr.NonEmptyReadonlyArray<PlanShape> = [
	"hash",
	"sort",
	"index",
	"parallel"
]

export const planShapeGen: Gen<PlanShape> = element(planShapeNames)

/**
 * `shape`'s settings, each made the default of the role `role` in the case's database, which a session it opens reads:
 * a row of pg_db_role_setting, gone with the case's own database when it is dropped.
 */
export const planShapeOn = (
	role: string,
	shape: PlanShape
): Effect.Effect<void, never, Substrate> =>
	Effect.flatMap(Substrate, (substrate) => {
		const target = `ALTER ROLE ${quoteIdent(role)} IN DATABASE ${quoteIdent(substrate.database)}`
		return Effect.forEach(
			Rec.toEntries(planShapes[shape]),
			([parameter, value]) => substrate.superuser(`${target} SET ${parameter} = ${value}`),
			{ discard: true }
		)
	})
