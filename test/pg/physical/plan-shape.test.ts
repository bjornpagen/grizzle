/**
 * The plan laws over every routine an installation installs (test/support/advice.ts): each statement grizzle sends is
 * planned under the plan advice it carries, and PostgreSQL plans exactly that plan, whatever its tables' statistics
 * hold, because nothing of the plan is PostgreSQL's choice any more (CARRY THE PLAN D1-D6).
 *
 * - **Property:** over drawn shapes (a unit of one or two fields or none; one to three relations, members of the unit
 *   or not, mutable inside it or not, keyed by one or two fields of their own after the unit's, with up to one key more;
 *   the second referencing the first's primary key; up to three equality lookups of a workload, each an index beside
 *   the keys, the first relation, half the time, keyed by two fields of its own with a lookup on the second; a third of
 *   the shapes two immutable members of the unit, the second's rows contained in fields of the first that hold none of
 *   its keys, a containment no foreign key states, which the rule judge reads), installed with the lookups as the
 *   engine's requests, each relation loaded with 2^14 rows and stood in a drawn pg_class state (never vacuumed; counted
 *   empty, counted as a VACUUM another session runs while its load is open counts it, every path then costing about a
 *   row, e1's tie;
 *   analyzed; skewed, analyzed over its first hundredth; large, counted at a million rows), in one transaction the case
 *   rolls back, the judge stood up: every routine of the installation (physical/install/compile.ts Installation
 *   `routines`, each query PL/pgSQL hands the planner) is planned under the advice its own SET clause holds, and
 *   - Law 1: its generated advice is the advice it carries, atom for atom, each atom matched, no node disabled;
 *   - Law 2: every column a read binds is in its scan's index condition, and no join's filter equates a stored read's
 *     column with another's;
 *   - Law 3: no two items of its plan share an alias, no two levels a name, and each atom is matched in exactly one of
 *     its queries;
 *   - the budget: each of its queries that reads no parameter, run on the filled tables, reads within the pages its plan
 *     gives (descents times its index's height, two pages a row its index condition selects, a whole read its table's
 *     pages), never descending more than once an evaluation.
 * - **Oracle:** PostgreSQL 19's own plans: its generated advice and its feedback on the supplied (EXPLAIN
 *   (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, FORMAT JSON)), each scan's conditions, and EXPLAIN ANALYZE's buffers.
 * - **Kills:** a level's first scan atom dropped from the advice, so PostgreSQL's own choice reads it; every request of a
 *   relation resolved to the relation's last index, a sibling, which leaves a bound column in a filter; a keyed read of
 *   a second relation printed as a plain join instead of a probe; a sublink's query read at a level PostgreSQL names,
 *   which it flattens into a join; the advice scope minting one alias over and over, so two relations of a routine
 *   share it; and the judge of an installation that judges no table reading the sentinel no stand-up makes.
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

/** Every routine of a drawn shape plans as the advice it carries, binds every bound column, and keeps its budget, in
 * every pg_class state. */
export const everyRoutinePlansAsItsAdviceCarriesInEveryState = property.explore(shapeGen, {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: [
		"a unit's members",
		"a relation in no unit",
		"a mutable member",
		"a reference between members",
		"a containment the rule judge reads",
		"a lookup's index beside a key",
		"a relation never vacuumed",
		"a relation counted empty",
		"a relation analyzed",
		"a relation skewed",
		"a relation large",
		"a routine read through an index"
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
		name: "PostgreSQL 19's generated advice, its feedback on the supplied, its scans' conditions and its buffers, under each routine's own advice in each pg_class state"
	},
	budget: { runs: 24, steered: 12 },
	show: Formatter.format,
	kept: [
		{
			token: ReplayToken(
				"test/pg/physical/plan-shape.test.ts#everyRoutinePlansAsItsAdviceCarriesInEveryState:-:0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.1.0.0.0"
			),
			reason:
				"two members of a unit and no judged relation (LAWS's run at 6230b6610): the installation held no stand-up, so no session ever stood the sentinel, and its judge's one query, DELETE FROM the sentinel, could not be planned (42P01), a function no capture fires; the judge with no table judged is an empty body (physical/ddl/rules.ts `judging`)",
			since: "2026-11-27"
		}
	],
	kills: [
		{
			file: "packages/engine/src/sql/advice.ts",
			original: "\t\t...scanned.flatMap((item) => scanAtom(item, at(item))),",
			replacement: "\t\t...scanned.slice(1).flatMap((item) => scanAtom(item, at(item))),",
			why: "A level's first scan atom dropped: PostgreSQL chooses that read's scan itself, the counted-empty tie's index among its choices, an atom grizzle does not carry (Law 1)."
		},
		{
			file: "packages/engine/src/physical/indexes/engine.ts",
			original: "\t\treturn hostIn(set, covered.value)?.ref ?? missed(held)\n",
			replacement:
				"\t\treturn (set.indexes.findLast((c) => c.relation === relation) ?? hostIn(set, covered.value))?.ref ?? missed(held)\n",
			why: "Every request of a relation resolved to its last index, a sibling of the one that serves it: the advice is obeyed and matched, and a column the read binds that the sibling does not lead with is a filter (Law 2)."
		},
		{
			file: "packages/engine/src/sql/bind.ts",
			original: "\t\tif (table !== undefined && bindings.some((b) => b.driven)) {",
			replacement: "\t\tif (false) {",
			why: "A keyed read of a second relation printed as a plain join, as before the binder (e3 P1): its binding to the earlier item's column is a join's filter, which no advice makes an index condition (Law 2)."
		},
		{
			file: "packages/engine/src/sql/bind.ts",
			original: "\tif (!readsAtOwnLevel(q)) {",
			replacement: "\tif (true) {",
			why: "A sublink's query read at the level PostgreSQL names itself: a correlated EXISTS is flattened into a semi-join grizzle never planned (e3 P5), its advice targeting a level that no longer exists (Law 1)."
		},
		{
			file: "packages/engine/src/physical/ddl/rules.ts",
			original: "\tconst judging: ReadonlyArray<PlStatement> = !isNonEmpty(tables)\n\t\t? []\n",
			replacement:
				"\tconst judging: ReadonlyArray<PlStatement> = !isNonEmpty(tables)\n\t\t? [consumed]\n",
			why: "The judge of an installation that judges no table still reads the sentinel, which no stand-up makes: its one query plans over a relation no session ever holds (42P01), a function nothing fires."
		},
		{
			file: "packages/engine/src/sql/naming.ts",
			original: "\t\tthis.#next += 1",
			replacement: "\t\tthis.#next += 0",
			why: "The advice scope mints one alias over and over: two relations of a routine share it, and each item meets both (Law 3)."
		}
	]
})
