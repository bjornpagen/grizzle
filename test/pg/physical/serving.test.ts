/**
 * Index serving judged by PostgreSQL, over generated schemas and workloads and over drawn index requests, at volume.
 *
 * The index engine (physical/indexes/engine.ts) claims, for every request it plans, an index that serves it, and it
 * creates an index only for a request nothing installed serves. PostgreSQL is the judge of both claims (serving.ts):
 * every request's probe must run through an index the installation planned, with an index condition, one descent, no
 * sort and a bounded count of touched buffers, and through its own index alone searching every condition it states, so
 * no filtered row; and every created index must be needed, some request it holds going unserved once it is dropped. The
 * serving rule is never restated here.
 *
 * Two populations, each installed by the fresh-install compiler and loaded at volume (serving.ts volumeRows):
 *
 * - Generated workloads. A program of the public-boundary generator (test/support/oracle/public) is a schema and its
 *   reads; its reads are the workload, compiled by the workload compiler and installed with the access paths its extraction
 *   draws (physical/access/extract.ts). Every field of a relation's keys holds the series itself, so keys stay
 *   distinct, and every other field the series spread over 141 values, so one field alone selects about 140 rows and
 *   two select about one: an index on a column the probe does not fix first is told from one that serves it. A relation
 *   whose key admits fewer rows (its key fields closed handles, say) holds as many as its key admits, too few for any
 *   index to tell from a scan, and is not judged (serving.ts). A workload whose access path PostgreSQL could not index
 *   (an unbounded text or numeric key) is refused as UnrepresentableKey, a named outcome. Its kept cases, each a
 *   failure report the index engine's fix closed (physical/indexes/engine.ts), recorded beside the space
 *   (workloadRegressions) and replayed by its token with the draws its case resolved it by: an equality lookup on a
 *   boolean key column, whose answer is half its relation, beside a span predicate that a GiST index led by a closed
 *   id, then a numeric of many values the predicate leaves unbound, does not serve; a range on a closed handle by
 *   equality and a numeric of many values by a range, beside span predicates whose GiST index holds both, which places
 *   its entries by the numeric, so that its scan would read the range across every handle, three times the range's
 *   share: a B-tree serves it; and three that PostgreSQL's cost model reads through a GiST index that holds a field of
 *   the probe outside its lead, sweeping it, where no order of that index serves the probe beside the requests its
 *   order answers to (serving.ts keyOrdersConflict): a range on DateSubtract's (fixed0, tick0, B1) through a GiST index
 *   led by Bool that lacks B1, lookups on DistPs's (fixed0, tick0) and its other lookups through the GiST index of span
 *   predicates that leads with Bool for the one on Bool alone, the engine keeping every column that may lead until that
 *   one narrows them, and an equality lookup on SpgTextLeafConsistent's Name through a GiST index that leads with tick0
 *   for a span predicate on (tick0, Bool) another GiST index serves. One more, kept by the token its draw made, the
 *   judge's reading closed: a key lookup on Rel0x0's key (Bool, field0) beside a page seek on (field0, Bool), whose
 *   index leads with the key's columns in the other order, which PostgreSQL reads the lookup through empty as
 *   installed, at most one row by the key, as the plan's index condition shows (serving.ts). And one more the engine's
 *   fix closed, killed by its fixed keys directed again: a take seek on Rel2x0 ordered by field0 then its key Bool the
 *   other way, beside a take seek that binds field0 and orders by Bool, which one index serves, field0 holding one value
 *   within the second, where directing it put the two apart on two indexes (physical/indexes/engine.ts
 *   orderedPlacements). And one the declared statistics' fix closed, killed by the key refused again: Rel0x0 keyed
 *   (Bool, field0), Bool a boolean, beside a lookup whose set apart (field0, tick0) asks field0 for 4 rows a value, which
 *   Bool's 2 values cannot bring to one row: its own unique index carries the key (physical/statistics/exponents.ts),
 *   where the workload was refused. The judge's own excuses are its own (serving.ts):
 *   a join key's GiST sweep no plan the engine makes avoids, a span predicate's GiST index needed beside a B-tree that
 *   finds its one row, btree_gist's pricing of multibyte text (README, PostgreSQL known issues), and a skip scan's
 *   descents over closed keys.
 * - Drawn requests. A fixed schema holds a plain table, a span key's GiST index (Booking, on room and during), two span
 *   keys' GiST indexes led by a column of few values, a boolean (Shift, on standby, worker and during, standby true on
 *   one row in ten) and a closed id of a drawn roster of four to eight handles (Rota, on shade, worker and during, shade
 *   its first handle on nine rows in ten), a selected side's unique (at most one remainder deposit per line) beside a foreign key on its column, and the engine is
 *   handed drawn requests on it: workload B-tree requests of every use, law probes, and GiST span predicates on during
 *   with any of Booking's scalars. Its kept cases plant the requests a planner is tempted to serve wrongly: an equality
 *   pair beside a range over the same two columns in the other order, which one index serves; and, on Shift and on
 *   Rota of five and of eight shades, whose GiST indexes place
 *   their entries by worker, their first column of many values: a range on worker after the column of few values, and
 *   a law probe and a range on that column alone, which the index holds in order but whose scan reads the range across
 *   every value of that column, or every entry; and a lookup and a range on worker alone, which the index holds after
 *   that column, unbound, so that its scan descends once per value of it: a B-tree serves each; and a range on Shift's
 *   (worker, standby) beside one on (standby, worker), the first planned on Shift's GiST key, which PostgreSQL reads
 *   through the second's B-tree by a skip scan over standby in 2 descents, fewer buffers than the GiST key reads, a
 *   read held to the descents its closed keys allow (serving.ts descentsUnder).
 *
 * A field's value on row g (see the header): `value` the series or its spread, `key` whether the field lies in a key.
 *
 * At most two code points, as the generated text field admits: two CJK ideographs name a million keys.
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
 * Every request a generated workload plans is served, and every index it creates is needed, each case installing its
 * workload on its own substrate (Substrate.fresh).
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
			name: "PostgreSQL's serving judge: every planned request's probe runs through an index the installation planned, and every created index is needed"
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
					"an equality lookup on A's boolean key column, which answers half its rows through the primary key, beside a span predicate on Task binding its closed id but not the numeric of many values after it in the GiST index another span predicate creates",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/pg/physical/serving.test.ts#everyRequestAGeneratedWorkloadPlansIsServedAndEveryIndexItCreatesIsNeeded:-:2.0.0.0.2.2.1.1.1.1.0.1.2.2.2.1.1.0.1.1.1.0.0.2.2.2.1.0.0.1.1.0.2.1.1.0.3.0.0.0.2.0.2.0.2.1.1.0.1.1.1.0.2.1.2.0.2.0.2.2.3.3.2.0.1.0.1.0.1.1.0.0.1.2.1.3.2.1.1.0.1.1.0.2.0.0.1.1.3.1.0.1.1.1"
				),
				reason:
					"a range on Overlaps' JsonbPretty, a closed handle, by equality and its fixed0, a numeric of many values, by a range, beside span predicates whose GiST index holds both: GiST places its entries by fixed0, so its scan would read the range across every handle, and the range is planned on a B-tree of its own. Planned generically at the load's 20,000 rows, the B-tree (5.41) ties the GiST index (5.40): each is priced at one page of the 50 rows the default range selectivity estimates, and gistcostestimate charges its descent ceil(ln N) comparisons against btcostestimate's ceil(log2 N), 0.0125 less, so PostgreSQL takes the GiST index, which read 75 of its 149 pages, its whole size the most such a read touches. Filled at its derived 51,613 rows, past one page of the GiST index (129.0 rows a page at the load), PostgreSQL takes the B-tree (measured 2026-11-23)",
				since: "2026-11-10"
			},
			{
				token: ReplayToken(
					"test/pg/physical/serving.test.ts#everyRequestAGeneratedWorkloadPlansIsServedAndEveryIndexItCreatesIsNeeded:-:3.1.0.1.0.1.0.0.0.3.3.1.0.1.3.1.1.2.0.0.1.2.1.1.1.3.3.0.3.2.1.3.3.3.1.2.1.1"
				),
				reason:
					"a range on DateSubtract's (fixed0, tick0, B1), planned on a B-tree led by fixed0, beside span predicates whose GiST index leads with Bool for one on (LineVertical, Bool) and holds fixed0 and tick0 but not B1: PostgreSQL sweeps that GiST index for the range, which no order of it serves beside the requests its order answers to, though it lacks one of the range's fields (serving.ts keyOrdersConflict)",
				since: "2026-11-14"
			},
			{
				token: ReplayToken(
					"test/pg/physical/serving.test.ts#everyRequestAGeneratedWorkloadPlansIsServedAndEveryIndexItCreatesIsNeeded:-:4.1.0.1.1.0.1.0.0.1.1.0.1.1.0.1.0.0.0.1.1.1.0.1.1.1.1.1.0.1.0.1.1.1.1.1.0.0.1.1.1.0.1.0.0.0.1.2.0.1.0.1.1.1.1.0.1.1.1.0.1.2.1.1.1.1.1.0.1.1.1.1.0.0.1.1.1.0.0.0.1.0.0.1.0.1.1.1.0.0.1.1.0.0.0.1.1.0.1.0.1.1.0.1.0.1.1.0.0.0.0.0.1.1.1.1.1.1.0.0.1.1.0.0.0.0.0.0.1.0.0.1.0.1.1.0.0.0.1.0.1.0.1.1.0.0.0.0"
				),
				reason:
					"lookups and a join key on DistPs's (fixed0, tick0), (Nameicregexeq, tick0) and four of its fields beside span predicates on five of its fields, on (Nameicregexeq, tick0, Bool), on (tick0, Bool) and on Bool alone: the widest predicate's GiST index answers every one of the predicates, each column that may lead it kept until the one on Bool narrows them (physical/indexes/engine.ts leadDraft), so it leads with Bool, and PostgreSQL sweeps it for the lookups, which no order of it serves beside them",
				since: "2026-11-14"
			},
			{
				token: ReplayToken(
					"test/pg/physical/serving.test.ts#everyRequestAGeneratedWorkloadPlansIsServedAndEveryIndexItCreatesIsNeeded:-:5.0.0.1.0.0.1.0.0.0.0.1.1.0.1.1.0.0.0.1.1.0.1.0.0.0.0.1.0.0.2.1.1.0.1.0.0.0.0.1.0.0.0.0.0.0.1.0.1.0.1.1.0.0.0.0.0.0.0.0.1.0.1.0.0.0.1.1.0.0.1.1.0.0.0.1.1.0.0.0.1.1.0.1.0.0.1.0.1.0.0.0.0.1.0.0.1.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.1.0.0.0.0.0.0.1.1.0.1.0.0.0.0.0.1.0.1.0.0.1.0.0.0.0.0.0.2.2.0.0.1.1.0.0.1.1.1.0.0.0.1.1.2.1.1.1.0.1.1"
				),
				reason:
					"an equality lookup on SpgTextLeafConsistent's Name, planned on its primary key, beside a span predicate on (Name, tick0, Bool) whose GiST index leads with tick0 for a span predicate on (tick0, Bool) that another GiST index serves, one its order answers to (PlannedIndex answers): PostgreSQL sweeps it for the lookup, which no order of it serves beside them",
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
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\t\t\tdirected: isNonEmpty(order) ? order : undefined",
				replacement: "\t\t\tdirected: keys",
				why: "An ordered request's fixed keys directed as its order, as before: two seeks that differ only in a fixed key's direction are apart, and each takes an index of its own on the same columns, one of which PostgreSQL does not need."
			}
		]
	})

/**
 * Every drawn request is served, and every index the engine creates for them is needed, each case installing the
 * drawn suite's schema with its requests on its own substrate (Substrate.fresh).
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
			"a span predicate on during alone"
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
			name: "PostgreSQL's serving judge over drawn requests: each served, every created index needed"
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
		kills: []
	})
