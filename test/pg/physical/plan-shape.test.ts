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
 *   a member's read by its unit, and, where an index of a member is led by a field of its primary key after the unit's,
 *   a coordinate, the key's probe joined from two sides as metis's submit probes processed_attempt's key: its unit's
 *   fields from a carrier of parameters, its other fields from a row of the table read at that unit, in an anti join.
 *   A member's binding that holds none of the columns that scope its rows, its unit's fields and its keys' first fields,
 *   spans its units: its declaration prices it at a share of the table, which PostgreSQL may scan. In each state:
 *   - empty as installed, a table no VACUUM has seen, which PostgreSQL plans at ten pages: a lookup binding a key
 *     reads at most one row by a key, through an index the leading run of whose columns its index condition binds by
 *     equality holds a key (copies.ts readsOneRowByKey), a key's index bound whole or one leading with a key's columns
 *     in another order; nothing else is judged empty (a read of several rows may scan it);
 *   - filled at 2^14 rows and vacuumed: a lookup binding a key reads at most one row by a key, as empty, any other
 *     through indexes whose equalities bind as long a run of its binding as any B-tree of the relation does, and never
 *     scans the table where one binds any, but a binding that spans a member's units may; the joined probe binds by its index
 *     condition a column that scopes the rows, so it reads within one scope, never by the coordinates alone (its paths
 *     priced over loops as unlike as the carrier's ten rows and the table's, a prefix bounded within a scope may win
 *     over the key's whole index, which no declaration ranks);
 *   - after ANALYZE, after VACUUM, and, a mutable relation, emptied, vacuumed, refilled and vacuumed (the recovery
 *     autovacuum's insert threshold runs): each lookup that spans no scope reads as filled, and each statement as the
 *     law says;
 *   - ANALYZEd at one row in a hundred of the filled state's, then loaded whole and vacuumed: each lookup that spans no
 *     scope reads as filled, and each statement as the law says.
 *   A relation whose keys and indexes cross is refused when it installs, as generate refuses it.
 *   A third of the shapes are two immutable members of the unit, the second's rows contained in fields of the first that
 *   hold none of its keys, a containment no foreign key states, which the rule judge reads: every statement of the judge
 *   is planned over the shape's own tables, filled with their triggers off and vacuumed, then after ANALYZE, and each of
 *   its scans is judged by what its plan offers it, its own equalities and the conditions of the join that probes its
 *   side (plan-bindings.ts), as a probe's scan is: a scan whose binding holds a key reads at most one row by a key, any
 *   other the longest run any B-tree binds; each read after ANALYZE as filled.
 * - **Oracle:** PostgreSQL, its generic plans (EXPLAIN EXECUTE under force_generic_plan), judged against the indexes its
 *   catalog holds.
 * - **Kills:** the declarations dropped, so PostgreSQL breaks a key probe's tie with an index on part of its key by the
 *   latest index; the unit's lead declared no anchor, so a member's read by its unit is priced at a share of the table
 *   and scans it; and each column's statistics target left at its default, so an ANALYZE at one row in a hundred
 *   samples the first units and a read by the unit scans the table once it is loaded; the judge's delta readers at
 *   PostgreSQL's estimate of a thousand rows, so it hashes a scan of the container; and every unit-local containment
 *   judged whole, so the judge reads the container's unit and matches the binding in a Join Filter (LC-WRITERS' judge,
 *   the first kept case); and every index's first column of many values declared an anchor, a member's too, as 042c0f107 declared, so
 *   the joined probe of a key reads through an index led by its coordinate and filters the unit after (metis's
 *   processed_attempt, the second kept case).
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
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
			"a relation in no unit",
			"a containment the rule judge reads",
			"a key probed from two sides beside an index led by a coordinate"
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
		/** The fewest rotating cases at which every kill is killed under TEST_SEED=2219874524: at 12, once the judged arm
		 * took a third of the shapes, the statistics target's kill went unkilled; at 24 all five are. */
		budget: { runs: 24, steered: 12 },
		show: Formatter.format,
		kept: [
			{
				token: ReplayToken(
					"test/pg/physical/plan-shape.test.ts#everyStatementReadsThroughTheIndexItsBindingAsksForInEveryState:54.6:0.0.1.0.0.0.0.0.0.0.0.0.1.0.0.0"
				),
				reason:
					"LC-WRITERS' judge at small scale: R1(doc, q0) contained in R0(doc, f0) within the unit doc, R0 keyed (doc, f0, f1), both immutable; judged whole, the judge read R0's unit under a Materialize and matched f0 in its Join Filter, as LC's outline_start_in_standard_child judge read standard_child's 280,000-row unit for each outline row (23 minutes); judged key by key over its delta's rows, each read binds (doc, f0) by its index",
				since: "2026-11-23"
			},
			{
				token: ReplayToken(
					"test/pg/physical/plan-shape.test.ts#everyStatementReadsThroughTheIndexItsBindingAsksForInEveryState:-:1.1.0.0.1.0.0.0.0.0.1.0.0.1.0.0.1.0.0"
				),
				reason:
					"metis's processed_attempt at small scale: a member of the unit doc keyed (doc, f0, f1), a workload's lookup of (f0, f1) asking an index led by the coordinate f0, as processed_attempt (child, package, path, n, at) asks (package, path, n, child): declared an anchor for leading that index, f0 was priced at a fixed count of rows a value, and the key's probe joined from its unit's carrier and its own rows read through (f0, f1), filtering doc after, every unit's rows at the item, as metis's submit read 41,208 rows for each of 34 probes at 45785e7c9; declared a share of the table, the probe reads within its unit",
				since: "2026-11-24"
			}
		],
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
				file: "packages/engine/src/physical/statistics/declared.ts",
				original: "\tif (shape.unit.length === 0) {",
				replacement: "\tif (shape.unit.length >= 0) {",
				why: "Every index's first column of many values an anchor, as 042c0f107 declared: a coordinate leading an index is priced at a fixed count of rows a value, and a probe of the whole key joined from two sides reads through that index's prefix, filtering the unit after (the second kept case, metis's processed_attempt)."
			},
			{
				file: "packages/engine/src/sql/print.ts",
				original: `...statement.columns.map((c) => \`ALTER COLUMN \${quoteIdent(c.column)} SET STATISTICS 0\`)`,
				replacement: `...statement.columns.map((c) => \`ALTER COLUMN \${quoteIdent(c.column)} SET STATISTICS -1\`)`,
				why: "Each column's statistics target left at its default: an ANALYZE at one row in a hundred samples the first units over the declaration, and a read by the unit scans the loaded table."
			},
			{
				file: "packages/engine/src/physical/ddl/deltas.ts",
				original: 'rows: { kind: "declared", rows: sessionReaderRows }',
				replacement: 'rows: { kind: "planner" }',
				why: "The judge's delta readers at PostgreSQL's own estimate of a set-returning function's rows, a thousand: a key-by-key probe of the container is priced over a thousand delta rows, and PostgreSQL hashes a sequential scan of the container instead (the kept case: R0 read by a Seq Scan, binding none of its columns)."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: "\t\t\tmutableSide(d.from) || mutableSide(d.to)\n\t\t\t\t? whole",
				replacement: "\t\t\ttrue || mutableSide(d.from) || mutableSide(d.to)\n\t\t\t\t? whole",
				why: "Every unit-local containment judged whole, as before: the judge reads the container's unit under a Materialize and matches the binding in its Join Filter (the kept case, LC's symptom)."
			}
		]
	}
)
