/**
 * Index serving judged by the plan laws, over generated schemas and workloads and over drawn index requests, at volume,
 * in every pg_class state.
 *
 * The index engine (physical/indexes/engine.ts) claims, for every request it plans, an index that serves it, and it
 * creates an index only for a request nothing installed serves. grizzle carries each read's proven plan to PostgreSQL as
 * plan advice, so PostgreSQL judges the index each request resolves to, not a plan of its choosing (serving.ts): every
 * request's probe, held to its index by the advice that index's plan prints, plans as advised (Law 1), binds every
 * column it conditions by its index condition (Law 2), and reads within its descent and its rows' pages, with no sort
 * when it asks an order (the budget); and every created index is needed, some request it serves going unserved once it
 * is dropped. The serving rule is never restated here.
 *
 * Two populations, each installed by the fresh-install compiler, loaded at volume (serving.ts volumeRows) and stood in
 * each pg_class state in a transaction rolled back after it (never vacuumed, counted empty, analyzed, skewed, large):
 *
 * - Generated workloads. A program of the public-boundary generator (test/support/oracle/public) is a schema and its
 *   reads; its reads are the workload of its full world's login, installed as `grizzle generate` drafts it, every read
 *   as a served Db of the world reads it and every routine of the installation held to the plan laws, each of no
 *   parameter to its budget, and every request its bound plans and its laws asked held served. Every field of a
 *   relation's keys holds the series itself, so keys stay distinct, and every other field the series spread over 141
 *   values, so one field alone selects about 140 rows and two select about one: a scan of an index whose lead the probe
 *   leaves unbound is told from one that serves it. A workload whose access path PostgreSQL could not index (an
 *   unbounded text or numeric key) is refused as UnrepresentableKey, a named outcome. Its kept cases, each a failure
 *   report the index engine's fix closed (physical/indexes/engine.ts), are recorded beside the space
 *   (workloadRegressions) and replayed by their tokens with the draws their cases resolved them by, each reason the
 *   finding as the judge of its day read it.
 * - Drawn requests. A fixed schema holds a plain table, a span key's GiST index (Booking, on room and during), two span
 *   keys' GiST indexes led by a column of few values, a boolean (Shift, on standby, worker and during, standby true on
 *   one row in ten) and a closed id of a drawn roster of four to eight handles (Rota, on shade, worker and during, shade
 *   its first handle on nine rows in ten), a selected side's unique (at most one remainder deposit per line) beside a
 *   foreign key on its column, and the engine is handed drawn requests on it: workload B-tree requests of every use, law
 *   probes, and GiST range predicates on during with any of Booking's scalars. Its kept cases plant the requests an
 *   engine is tempted to serve wrongly: an equality pair beside a range over the same two columns in the other order,
 *   which one index serves; and, on Shift and on Rota of five and of eight shades, whose GiST indexes place their
 *   entries by worker, their first column of many values, ranges, lookups and law probes on worker or on the column of
 *   few values alone, which a B-tree serves.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import {
	requestCase,
	type RequestFeature,
	requestSketchGen,
	workloadCase,
	type WorkloadFeature,
	workloadGen,
	workloadSpace
} from "#test/pg/physical/serving.fixtures.ts"
import type { ServingFeature } from "#test/pg/physical/serving.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * Every served read and routine of a generated workload holds the plan laws, every request it plans is served, and
 * every index it creates is needed, in every pg_class state, each case installing its workload on its own substrate
 * (Substrate.fresh).
 *
 * Its pre-conversion budget: runs 10, coverage cases 10 (test/pg/physical/serving.test.ts at fa10bca50).
 */
export const everyRequestAGeneratedWorkloadPlansIsServedAndEveryIndexItCreatesIsNeeded =
	property.explore(workloadSpace, {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: ["a workload installed", "equality probe served"] satisfies ReadonlyArray<
			Reached<ServingFeature | WorkloadFeature>
		>,
		check:
			({ substrate }, c: Case<ServingFeature | WorkloadFeature>) =>
			(sketch) =>
				Effect.provideServiceEffect(
					Effect.scoped(workloadCase(c.draw(workloadGen(sketch)), c.note)),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL 19's plans under the carried advice in every pg_class state: each served read's and routine's, and each planned request's probe through the index it resolves to, its generated advice, feedback, index conditions and buffers; every created index needed"
		},
		budget: { runs: 10, steered: 10 },
		show: Formatter.format,
		kept: [
			{
				token: ReplayToken(
					"test/pg/physical/serving.test.ts#everyRequestAGeneratedWorkloadPlansIsServedAndEveryIndexItCreatesIsNeeded:-:0.3.1.0.0.1.0.0.1.0.1.0.1.0.0.1.0.0.1.0.1.0.1.0.1.0.1.0.1.0.1.2.1.0.1.0.1.0.1.0.0.1.0.0.1.2.1.2.0.1.0.1.0.1.0.1.2.1.2.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.0.b8k.0.0.0.2.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.1.11xc.guu.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.0.0.0.0.1.0.0"
				),
				reason:
					"Rel0x0 keyed by a numeric(5,2) field, filled past 99,999 rows in a filled state, where the load's key, its series over 100, passed 999.99 and the fill failed 22003 before any plan was read (rotating seed 0xaf91f91d at NOSETTINGS): each fixed value is now drawn within the column's precision (serving.fixtures.ts fixedValues)",
				since: "2026-11-26"
			},
			{
				token: ReplayToken(
					"test/pg/physical/serving.test.ts#everyRequestAGeneratedWorkloadPlansIsServedAndEveryIndexItCreatesIsNeeded:-:1.0.0.0.0.0.0.2.0.0.2.2.2.1.0.0.1.1.0.0.0.0.0.0.0.3.0.2.2.2.2.2.0.0.1.0.1.0.0.0.0.1.0.0.2.0.0.0.0.0.0.1.0.0.1.0.1.2.1.1.0.0.0.0.0.0.1.0.1.1.0.0.2.2.2.2.2.0.0.3.2.3.2.0.0.0.0.1.0.0"
				),
				reason:
					"an equality lookup on A's boolean key column, which answers half its rows through the primary key, beside a range predicate on Task binding its closed id but not the numeric of many values after it in the GiST index another range predicate creates",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/pg/physical/serving.test.ts#everyRequestAGeneratedWorkloadPlansIsServedAndEveryIndexItCreatesIsNeeded:-:2.0.0.0.2.2.1.1.1.1.0.1.2.2.2.1.1.0.1.1.1.0.0.2.2.2.1.0.0.1.1.0.2.1.1.0.3.0.0.0.2.0.2.0.2.1.1.0.1.1.1.0.2.1.2.0.2.0.2.2.3.3.2.0.1.0.1.0.1.1.0.0.1.2.1.3.2.1.1.0.1.1.0.2.0.0.1.1.3.1.0.1.1.1"
				),
				reason:
					"a range on Overlaps' JsonbPretty, a closed handle, by equality and its fixed0, a numeric of many values, by a range, beside range predicates whose GiST index holds both: GiST places its entries by fixed0, so its scan would read the range across every handle, and the range is planned on a B-tree of its own. Planned generically at the load's 20,000 rows, the B-tree (5.41) ties the GiST index (5.40): each is priced at one page of the 50 rows the default range selectivity estimates, and gistcostestimate charges its descent ceil(ln N) comparisons against btcostestimate's ceil(log2 N), 0.0125 less, so PostgreSQL takes the GiST index, which read 75 of its 149 pages, its whole size the most such a read touches. Filled at its derived 51,613 rows, past one page of the GiST index (129.0 rows a page at the load), PostgreSQL takes the B-tree (measured 2026-11-23)",
				since: "2026-11-10"
			},
			{
				token: ReplayToken(
					"test/pg/physical/serving.test.ts#everyRequestAGeneratedWorkloadPlansIsServedAndEveryIndexItCreatesIsNeeded:-:3.1.0.1.0.1.0.0.0.3.3.1.0.1.3.1.1.2.0.0.1.2.1.1.1.3.3.0.3.2.1.3.3.3.1.2.1.1"
				),
				reason:
					"a range on DateSubtract's (fixed0, tick0, B1), planned on a B-tree led by fixed0, beside range predicates whose GiST index leads with Bool for one on (LineVertical, Bool) and holds fixed0 and tick0 but not B1: PostgreSQL sweeps that GiST index for the range, which no order of it serves beside the requests its order answers to, though it lacks one of the range's fields (serving.ts keyOrdersConflict)",
				since: "2026-11-14"
			},
			{
				token: ReplayToken(
					"test/pg/physical/serving.test.ts#everyRequestAGeneratedWorkloadPlansIsServedAndEveryIndexItCreatesIsNeeded:-:4.1.0.1.1.0.1.0.0.1.1.0.1.1.0.1.0.0.0.1.1.1.0.1.1.1.1.1.0.1.0.1.1.1.1.1.0.0.1.1.1.0.1.0.0.0.1.2.0.1.0.1.1.1.1.0.1.1.1.0.1.2.1.1.1.1.1.0.1.1.1.1.0.0.1.1.1.0.0.0.1.0.0.1.0.1.1.1.0.0.1.1.0.0.0.1.1.0.1.0.1.1.0.1.0.1.1.0.0.0.0.0.1.1.1.1.1.1.0.0.1.1.0.0.0.0.0.0.1.0.0.1.0.1.1.0.0.0.1.0.1.0.1.1.0.0.0.0"
				),
				reason:
					"lookups and a join key on DistPs's (fixed0, tick0), (Nameicregexeq, tick0) and four of its fields beside range predicates on five of its fields, on (Nameicregexeq, tick0, Bool), on (tick0, Bool) and on Bool alone: the widest predicate's GiST index answers every one of the predicates, each column that may lead it kept until the one on Bool narrows them (physical/indexes/engine.ts leadDraft), so it leads with Bool, and PostgreSQL sweeps it for the lookups, which no order of it serves beside them",
				since: "2026-11-14"
			},
			{
				token: ReplayToken(
					"test/pg/physical/serving.test.ts#everyRequestAGeneratedWorkloadPlansIsServedAndEveryIndexItCreatesIsNeeded:-:5.0.0.1.0.0.1.0.0.0.0.1.1.0.1.1.0.0.0.1.1.0.1.0.0.0.0.1.0.0.2.1.1.0.1.0.0.0.0.1.0.0.0.0.0.0.1.0.1.0.1.1.0.0.0.0.0.0.0.0.1.0.1.0.0.0.1.1.0.0.1.1.0.0.0.1.1.0.0.0.1.1.0.1.0.0.1.0.1.0.0.0.0.1.0.0.1.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.1.0.0.0.0.0.0.1.1.0.1.0.0.0.0.0.1.0.1.0.0.1.0.0.0.0.0.0.2.2.0.0.1.1.0.0.1.1.1.0.0.0.1.1.2.1.1.1.0.1.1"
				),
				reason:
					"an equality lookup on SpgTextLeafConsistent's Name, planned on its primary key, beside a range predicate on (Name, tick0, Bool) whose GiST index leads with tick0 for a range predicate on (tick0, Bool) that another GiST index serves, one its order answers to (PlannedIndex answers): PostgreSQL sweeps it for the lookup, which no order of it serves beside them",
				since: "2026-11-14"
			},
			{
				token: ReplayToken(
					"test/pg/physical/serving.test.ts#everyRequestAGeneratedWorkloadPlansIsServedAndEveryIndexItCreatesIsNeeded:-:0.4.1.0.1.0.1.0.1.0.0.1.0.1.0.1.2.0.0.1.0.1.0.1.0.0.0.1.2.0.1.0.1.0.0.1.0.0.1.0.1.0.1.0.1.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.2.0.0.0.0.0.pa8.0.0.3.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.1.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.pa8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.pa8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.4.0.0.0.0.0.0.1.0"
				),
				reason:
					"a key lookup on Rel0x0's key (Bool, field0) beside a page seek on (field0, Bool), field0 bound and Bool ordered, which needs an index leading with the key's columns in the other order, where the key's index serves the lookup and an equality lookup on Bool: empty as installed, PostgreSQL breaks the tie of the two indexes by the latest, the seek's, and reads the key's one row through it, which the judge held to the key's own index until it read the plan for the run its index condition binds (serving.ts, empty as installed)",
				since: "2026-11-24"
			},
			{
				token: ReplayToken(
					"test/pg/physical/serving.test.ts#everyRequestAGeneratedWorkloadPlansIsServedAndEveryIndexItCreatesIsNeeded:-:0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.0.0.0.0.0.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"a take seek on Rel2x0 ordered by field0 descending, completed by its key Bool ascending, beside a take seek that binds field0 by equality and orders by Bool descending: one index on (field0, Bool) serves both, field0 holding one value within the second seek, so any direction serves it, where the engine directed the second seek's fixed key as its order and put the two seeks apart, creating a second index on (field0, Bool) whose keys run one way, which PostgreSQL did not need",
				since: "2026-11-24"
			},
			{
				token: ReplayToken(
					"test/pg/physical/serving.test.ts#everyRequestAGeneratedWorkloadPlansIsServedAndEveryIndexItCreatesIsNeeded:-:0.4.1.0.1.0.1.0.1.0.0.1.0.1.0.1.2.0.0.1.0.1.0.1.0.0.0.1.2.0.0.1.0.1.0.1.0.0.1.0.1.0.1.0.1.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.2.0.guu.0.0.0.pa8.0.0.3.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.1.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.pa8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.guu.pa8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.pa8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.1.1.3.3.0.3.0.0.0.0.0.0"
				),
				reason:
					"Rel0x0 keyed (Bool, field0), Bool a boolean, beside an equality lookup on (field0, field1, tick0) that stops at (field0, tick0) on a join key's index: the set apart asks field0 for 4 rows a value, and Bool, which holds 2, halves them once, so no number of values Bool's type holds brings the key to one row; the declaration leaves the key at 2 rows, carried by its own unique index, which PostgreSQL prices at one tuple whatever the statistics, where e637d8a3d refused the workload, asking Bool for 2^2 values (physical/statistics/exponents.ts carried)",
				since: "2026-11-24"
			}
		],
		kills: [
			{
				file: "packages/engine/src/sql/bind.ts",
				original: '\t\t\t\teq: bindings.filter((b) => b.op === "="),\n',
				replacement: "\t\t\t\teq: bindings,\n",
				why: "A span's read binds a membership through its GiST index, which searches no array: DatetimePl's read at its span's equality bound bool IN (0, 1, 0) as an index condition of the GiST index of (pg_create_physical_replication_slot, span_40, tick_0, fixed_0, bool), where PostgreSQL filtered it (Law 2, the kept case of Overlaps' JsonbPretty)."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\t\t\tdirected: isNonEmpty(order) ? order : undefined",
				replacement: "\t\t\tdirected: keys",
				why: "An ordered request's fixed keys directed as its order, as before: two seeks that differ only in a fixed key's direction are apart, and each takes an index of its own on the same columns, one of which PostgreSQL does not need."
			}
		]
	})

/**
 * Every drawn request is served, and every index the engine creates for them is needed, in every pg_class state, each
 * case installing the drawn suite's schema with its requests on its own substrate (Substrate.fresh).
 *
 * Its pre-conversion budget: runs 16, coverage cases 16 (test/pg/physical/serving.test.ts at fa10bca50).
 */
export const everyDrawnRequestIsServedAndEveryIndexTheEngineCreatesForThemIsNeeded =
	property.explore(requestSketchGen, {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"equality probe served",
			"range probe served",
			"ordered probe served",
			"overlap probe served",
			"served by a created index",
			"served by a key or enforcement index",
			"a GiST index serving a B-tree request",
			"a created index needed",
			"a range predicate on during alone"
		] satisfies ReadonlyArray<Reached<RequestFeature>>,
		check:
			({ substrate }, c: Case<RequestFeature>) =>
			(sketch) =>
				Effect.provideServiceEffect(
					Effect.scoped(requestCase(sketch, c.note)),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL 19's plans of each drawn request's probe through the index it resolves to, under the advice that plan prints, in every pg_class state: its generated advice, feedback, index conditions and buffers; every created index needed"
		},
		budget: { runs: 16, steered: 16 },
		show: Formatter.format,
		kept: [
			{
				token: ReplayToken(
					"test/pg/physical/serving.test.ts#everyDrawnRequestIsServedAndEveryIndexTheEngineCreatesForThemIsNeeded:-:0.2.0.2.0.0.1.1.0.4.0.2.1.0.1.0.0.4"
				),
				reason:
					"a range on Shift's worker then standby, planned on Shift's GiST key, beside a range on standby then worker, through whose B-tree PostgreSQL reads the first by a skip scan over standby, a boolean, in 2 descents and fewer buffers than the GiST key alone reads: an index PostgreSQL chose by its cost is held to the descents its closed keys allow, not to the engine's claim (serving.ts descentsUnder). Filled at its derived 26,491 rows (the GiST key 66.2 rows a page at the load), PostgreSQL reads the first through the GiST key and the second through its own B-tree (measured 2026-11-23)",
				since: "2026-11-14"
			},
			{
				token: ReplayToken(
					"test/pg/physical/serving.test.ts#everyDrawnRequestIsServedAndEveryIndexTheEngineCreatesForThemIsNeeded:-:0.2.0.0.1.0.1.2.0.1.0.0.2.0.1.1.0.4"
				),
				reason: "an equality pair on (account, created) beside a range on created then account",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/pg/physical/serving.test.ts#everyDrawnRequestIsServedAndEveryIndexTheEngineCreatesForThemIsNeeded:-:0.1.0.2.0.0.1.1.0.4"
				),
				reason:
					"a range on Shift's worker after its standby, a boolean, which Shift's GiST index holds in that order and places by worker, so that its scan reads the range across every value of standby, and a B-tree serves it",
				since: "2026-11-10"
			},
			{
				token: ReplayToken(
					"test/pg/physical/serving.test.ts#everyDrawnRequestIsServedAndEveryIndexTheEngineCreatesForThemIsNeeded:-:0.2.1.2.0.0.0.0.2.0.0.0.4"
				),
				reason:
					"a law probe and a range on Shift's standby alone, a boolean, which Shift's GiST index leads with and places by worker, so that its scan reads every entry, and a B-tree serves both. Filled at 13,246 rows, derived from the GiST key's 66.2 rows a page at the load, the range spans 0.93 of a page of it and still reads the key; stood up again at 14,217 it takes the B-tree on standby (measured 2026-11-23)",
				since: "2026-11-10"
			},
			{
				token: ReplayToken(
					"test/pg/physical/serving.test.ts#everyDrawnRequestIsServedAndEveryIndexTheEngineCreatesForThemIsNeeded:-:0.2.0.2.1.0.0.1.0.2.1.0.0.4"
				),
				reason:
					"an equality lookup and a range on Shift's worker alone, which Shift's GiST index holds after its standby, a boolean, unbound, so that its scan descends once per value of standby, and a B-tree serves both",
				since: "2026-11-10"
			},
			{
				token: ReplayToken(
					"test/pg/physical/serving.test.ts#everyDrawnRequestIsServedAndEveryIndexTheEngineCreatesForThemIsNeeded:-:1.1.0.3.0.0.1.1.0.4"
				),
				reason:
					"a range on Rota's worker after its shade, a closed id of 5 handles, which Rota's GiST index holds in that order and places by worker, so that its scan reads the range across every value of shade, and a B-tree serves it",
				since: "2026-11-10"
			},
			{
				token: ReplayToken(
					"test/pg/physical/serving.test.ts#everyDrawnRequestIsServedAndEveryIndexTheEngineCreatesForThemIsNeeded:-:1.2.1.3.0.0.0.0.3.0.0.0.4"
				),
				reason:
					"a law probe and a range on Rota's shade alone, a closed id of 5 handles, which Rota's GiST index leads with and places by worker, so that its scan reads every entry, and a B-tree serves both",
				since: "2026-11-10"
			},
			{
				token: ReplayToken(
					"test/pg/physical/serving.test.ts#everyDrawnRequestIsServedAndEveryIndexTheEngineCreatesForThemIsNeeded:-:1.2.0.3.1.0.0.1.0.3.1.0.0.4"
				),
				reason:
					"an equality lookup and a range on Rota's worker alone, which Rota's GiST index holds after its shade, a closed id of 5 handles, unbound, so that its scan descends once per value of shade, and a B-tree serves both",
				since: "2026-11-10"
			},
			{
				token: ReplayToken(
					"test/pg/physical/serving.test.ts#everyDrawnRequestIsServedAndEveryIndexTheEngineCreatesForThemIsNeeded:-:4.1.0.3.0.0.1.1.0.4"
				),
				reason:
					"a range on Rota's worker after its shade, a closed id of 8 handles, which Rota's GiST index holds in that order and places by worker, so that its scan reads the range across every value of shade, and a B-tree serves it",
				since: "2026-11-10"
			},
			{
				token: ReplayToken(
					"test/pg/physical/serving.test.ts#everyDrawnRequestIsServedAndEveryIndexTheEngineCreatesForThemIsNeeded:-:4.2.1.3.0.0.0.0.3.0.0.0.4"
				),
				reason:
					"a law probe and a range on Rota's shade alone, a closed id of 8 handles, which Rota's GiST index leads with and places by worker, so that its scan reads every entry, and a B-tree serves both",
				since: "2026-11-10"
			},
			{
				token: ReplayToken(
					"test/pg/physical/serving.test.ts#everyDrawnRequestIsServedAndEveryIndexTheEngineCreatesForThemIsNeeded:-:4.2.0.3.1.0.0.1.0.3.1.0.0.4"
				),
				reason:
					"an equality lookup and a range on Rota's worker alone, which Rota's GiST index holds after its shade, a closed id of 8 handles, unbound, so that its scan descends once per value of shade, and a B-tree serves both",
				since: "2026-11-10"
			}
		],
		kills: [
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\tconst host = hostIn(hosts, covered.value)\n",
				replacement:
					"\tconst host = hosts.byRelation.get(relation)?.at(-1) ?? hostIn(hosts, covered.value)\n",
				why: "Every request of a relation resolved to its last index, a sibling of the one that serves it: the probe held to it binds a column it conditions outside the index condition, or descends past its rows, or sorts above an index that does not order it (Law 2, the budget)."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\t\t\t\tif (chainedOf(entry) !== undefined || land(entry)) {\n",
				replacement: "\t\t\t\tif (chainedOf(entry) !== undefined) {\n",
				why: "An index created for every request no chain holds, one an index already serves among them: the request still lands on the index that served it, and the one created for it serves nothing, which the judgment finds not needed."
			}
		]
	})
