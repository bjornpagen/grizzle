/**
 * The plan-shape law (README "Declared statistics"): every statement an installation makes reads each table through
 * the index its binding asks for, in every state a table passes through, because grizzle declares each table's planner
 * statistics from the schema's facts and PostgreSQL plans the statement generically, as every login's role plans the
 * statements it prepares (plan_cache_mode at force_generic_plan).
 *
 * - **Property:** over drawn shapes (a unit of one or two fields or none; one to three relations, members of the unit
 *   or not, mutable inside it or not, keyed by one or two fields of their own after the unit's, with up to one key more;
 *   the second referencing the first's primary key; up to three equality lookups of a workload, the first relation,
 *   half the time, keyed by two fields of its own with a lookup on the second), installed with the lookups as the
 *   engine's requests, each relation's statements are planned on a copy of its table (copies.ts: its columns,
 *   constraints and indexes, and its declaration as the migration declares it): each key's probe, each lookup, each
 *   foreign key's check from each side as PostgreSQL's own triggers run it (`SELECT 1 FROM ONLY ... FOR KEY SHARE`),
 *   and a member's read by its unit. In each state:
 *   - empty as installed, a table no VACUUM has seen, which PostgreSQL plans at ten pages: a statement binding a key
 *     reads through a key's index it binds whole; nothing else is judged empty (a read of several rows may scan it);
 *   - filled at 2^14 rows and vacuumed: a statement binding a key reads through a key's index it binds whole, any other
 *     through indexes whose equalities bind as long a run of its binding as any B-tree of the relation does, and never
 *     scans the table where one binds any;
 *   - after ANALYZE, after VACUUM, and, a mutable relation, emptied, vacuumed, refilled and vacuumed (the recovery
 *     autovacuum's insert threshold runs): each statement reads as filled;
 *   - ANALYZEd at one row in a hundred of the filled state's, then loaded whole and vacuumed: each statement reads as
 *     filled, and as the law says.
 *   A relation whose keys and indexes cross is refused when it installs, as generate refuses it.
 * - **Oracle:** PostgreSQL, its generic plans (EXPLAIN EXECUTE under force_generic_plan), judged against the indexes its
 *   catalog holds.
 * - **Kills:** the declarations dropped, so PostgreSQL breaks a key probe's tie with an index on part of its key by the
 *   latest index; the unit's lead declared no anchor, so a member's read by its unit is priced at a share of the table
 *   and scans it; and each column's statistics target left at its default, so an ANALYZE at one row in a hundred
 *   samples the first units and a read by the unit scans the table once it is loaded.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import {
	type PlanShapeFeature,
	shapeCase,
	shapeGen
} from "#test/pg/physical/plan-shape.fixtures.ts"
import { baseSubstrate, Substrate } from "#test/support/substrate/substrate.ts"

/** Every statement of a drawn shape reads each table through the index its binding asks for, in every law state. */
export const everyStatementReadsThroughTheIndexItsBindingAsksForInEveryState = property.explore(
	shapeGen,
	{
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"a unit's member read by its unit",
			"a key probe beside an index on part of its key",
			"a foreign key checked from each side",
			"an equality lookup on an index of its own",
			"a mutable relation emptied, vacuumed and refilled",
			"a relation in no unit"
		] satisfies ReadonlyArray<Reached<PlanShapeFeature>>,
		check:
			({ substrate }, c: Case<PlanShapeFeature>) =>
			(sketch) =>
				Effect.provideServiceEffect(
					Effect.scoped(shapeCase(sketch, c.note)),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL's generic plans over copies of each table in the law's states, judged against its catalog's indexes"
		},
		budget: { runs: 12, steered: 12 },
		show: Formatter.format,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/statistics/statistics.ts",
				original: "\tfor (const relation of relations) {",
				replacement: "\tfor (const relation of relations.slice(0, 0)) {",
				why: "No table's statistics declared: without them PostgreSQL prices a key probe and an index on part of its key at one row each and breaks the tie by the latest index, which binds no key."
			},
			{
				file: "packages/engine/src/physical/statistics/declared.ts",
				original: "\t\tif (taken.includes(c)) {",
				replacement: "\t\tif (taken.includes(c) || shape.unit.includes(c)) {",
				why: "The unit's lead declared no anchor: its first field holds a few values at any size, so a member's read by its unit is priced at a share of the table and scans it."
			},
			{
				file: "packages/engine/src/sql/print.ts",
				original: `...statement.columns.map((c) => \`ALTER COLUMN \${quoteIdent(c.column)} SET STATISTICS 0\`)`,
				replacement: `...statement.columns.map((c) => \`ALTER COLUMN \${quoteIdent(c.column)} SET STATISTICS -1\`)`,
				why: "Each column's statistics target left at its default: an ANALYZE at one row in a hundred samples the first units over the declaration, and a read by the unit scans the loaded table."
			}
		]
	}
)
