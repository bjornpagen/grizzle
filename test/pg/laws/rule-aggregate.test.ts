/**
 * Rules over aggregating derived relations on PostgreSQL 19, judged by their probes (analysis/theory/query.ts
 * GroupedMatch): a key, a check or a containment over a derived relation whose definition groups and folds, read where
 * the rule is not unit-local, at the groups a write touches. A grouped match is read at both polarities: the facts its
 * touched groups gain, recomputed at COMMIT at their keys, and those they lose, at their keys alone, the fold free; and
 * the step that reads a touched group's fact is bound to the group's keys (analysis/theory/navigate.ts #grouped).
 *
 * Each case draws a schema (rule-aggregate.fixtures.ts shapeGen): Attempt(child, item, n, at | score), keyed by the
 * child first, grouped by one to three of child, item, n and the topic a Topic row of its item joins in, folded by
 * count, sum, min or max of the score; ItemMode(item | adaptive), keyed by the item alone, negated inside the
 * aggregate's body or in the rule that reads it; Read, the derived relation the laws read, the aggregate itself, a rule
 * matching it (a query it imports or a derived relation a level below), or a rule matching it joined to Cap at its
 * first group column under the condition that the fold is below the cap, with or without the fold in its heading, and
 * with or without a second rule over Extra's rows, ItemMode negated there or not; and one or two laws over Read: a key
 * over some of its columns, a check that its fold is at most a bound, Expect's rows contained in it at the group
 * columns or at the fold too, and its groups contained in Allowed. A mutable shape's stored relations are all mutable,
 * each inside the unit its key leads with, and its writes insert, put and delete; an immutable shape's insert alone. A
 * shape whose rule every relation it reads could keep unit-local is mutable, so every rule here is judged by its probes.
 *
 * - **Equivalence:** the specification turned into a checker. A history of ChangeSets of inserts, puts and deletes of
 *   the shape's stored relations, each applied through grizzle's served write as the full world's login, each drawn
 *   over the state the model says the writes before it committed. The model recomputes every aggregate over the whole
 *   state after each write and judges each law over Read's facts: a write is accepted exactly when the state it leaves
 *   keeps every law, and refused `invariant-rejected` otherwise, naming only laws the model finds broken, its witness
 *   unreported. After the history every stored relation holds the model's rows. Kept: edullm's minimal trigger
 *   (out/aggrule-bisect/minimal, the key over DirectOpen(child, item) of `counts` with ItemMode negated in the reader)
 *   and its cross-arm variant (ItemMode negated in Read's other rule alone), each with a history whose refusal comes
 *   through ItemMode alone.
 * - **Locality:** an invariance, never a time. A shape's touched group stored beside 200 to 400 untouched groups, each an
 *   attempt of its own that is a group of its own under any grouping, and then beside 600 to 900 more; each time a
 *   second attempt of the touched group written in a transaction rolled back, and every judged statement explained while
 *   the deltas hold it, under the planner settings of a table large beside one group's rows. Each statement's scans
 *   read the same rows both times: a probe of a touched group reads that group alone, never the groups beside it. The
 *   settings are the test's, never grizzle's output, which carries none: what this proves is that a plan of every judged
 *   statement exists whose work is bounded by the touched group, the same at both counts of groups; not that
 *   PostgreSQL's planner, with no statistics, picks it.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { aimed, recorded } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import {
	aims,
	caseGen,
	type Feature,
	keptCases,
	keptLocality,
	localityGen,
	runHistory,
	runLocality
} from "#test/pg/laws/rule-aggregate.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * A rule over an aggregating derived relation commits exactly the writes whose state keeps every law, recomputed over
 * the whole state, and refuses the rest naming a law they break.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aRuleOverAnAggregatingDerivedRelationCommitsExactlyTheWritesWhoseStateKeepsEveryLawRecomputedOverTheWholeState =
	property.explore(aimed(recorded(caseGen, keptCases), aims), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"accepted",
			"refused by a key",
			"refused by a check",
			"refused by a containment into the aggregate",
			"refused by a containment out of the aggregate",
			"a containment into the aggregate refused by a fold its write changed",
			"a write of deletes alone refused",
			"a put of a score alone refused",
			"a write of ItemMode alone refused",
			"a write of Topic alone refused",
			"a write of Cap alone refused",
			"a write of Extra alone refused",
			"a write of Attempt alone refused through the aggregate's negation"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate }, c: Case<Feature>) =>
			(drawn) =>
				Effect.provideServiceEffect(
					Effect.scoped(runHistory(drawn, c.note)),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "every aggregate recomputed over the whole state and each law restated over the derived relation's facts: a write is accepted exactly when the state it leaves keeps every law, and refused naming only laws it breaks"
		},
		show: Formatter.format,
		kept: [
			{
				token: ReplayToken(
					"test/pg/laws/rule-aggregate.test.ts#aRuleOverAnAggregatingDerivedRelationCommitsExactlyTheWritesWhoseStateKeepsEveryLawRecomputedOverTheWholeState:-:1"
				),
				reason:
					"edullm's minimal trigger (out/aggrule-bisect/minimal, grizzle 077a8046f): a key over DirectOpen(child, item), the counted (child, item, n) sessions of the items ItemMode, keyed by the item alone, does not hold adaptive, refused at generate until the probes read an aggregate's groups; its history refused by two sessions of one item, then by the item made direct again through ItemMode alone",
				since: "2026-11-21"
			},
			{
				token: ReplayToken(
					"test/pg/laws/rule-aggregate.test.ts#aRuleOverAnAggregatingDerivedRelationCommitsExactlyTheWritesWhoseStateKeepsEveryLawRecomputedOverTheWholeState:-:2"
				),
				reason:
					"the trigger's cross-arm variant: ItemMode negated only in the rule of DirectOpen that reads no aggregate, an untried session of an adaptive item beside a counted one, brought back through ItemMode alone",
				since: "2026-11-21"
			}
		],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original:
					"\t\treturn folds(rule.head)\n\t\t\t? [this.#groupedArm(relation, rule, groupFields(rule.head), columns)]\n\t\t\t: this.#conjunctive(relation, rule, columns)",
				replacement: "\t\treturn this.#conjunctive(relation, rule, columns)",
				why: "The probes read an aggregating definition as a conjunction again, as before the fix, which they cannot: every shape's schema fails to compile, the trigger first."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original:
					'\t\t\t\t\t{\n\t\t\t\t\t\tdirection: "removed",\n\t\t\t\t\t\tregion: {\n\t\t\t\t\t\t\tkind: "groups",\n\t\t\t\t\t\t\tdepth,\n\t\t\t\t\t\t\ttouched: t.query,\n\t\t\t\t\t\t\tkeys: t.keys,\n\t\t\t\t\t\t\tread: { kind: "lost" }\n\t\t\t\t\t\t}\n\t\t\t\t\t}\n',
				replacement: "",
				why: "A touched group's lost fact is read by no probe, so a write that changes a group's fold withdraws the fact Expect holds it to unjudged, and a state breaking the containment into the aggregate commits."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original:
					'\t\t\t...relaxedOf(\n\t\t\t\t[arm],\n\t\t\t\t"removed",\n\t\t\t\t() => keys.map(([, term]) => term),\n\t\t\t\trelation,\n\t\t\t\tside,\n\t\t\t\tdepth,\n\t\t\t\tmemo,\n\t\t\t\tloc\n\t\t\t).map(({ candidate: c }) => deliver(c, c.where))\n',
				replacement: "",
				why: "A group is touched only by the facts of its body a write may add, never by those it withdraws, so a delete or a put that takes an attempt out of its group leaves the group's fold unjudged: a delete that raises a group's least score past the check's bound, or lowers a count Expect holds, commits."
			}
		]
	})

/**
 * A probe of the groups a write touched reads those groups alone, however many groups stand beside them.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aProbeOfTheGroupsAWriteTouchedReadsThoseGroupsAloneHoweverManyGroupsStandBesideThem =
	property.explore(recorded(localityGen, keptLocality), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: ["measured"] satisfies ReadonlyArray<Reached<"measured">>,
		check:
			({ substrate }, c: Case<"measured">) =>
			(drawn) =>
				Effect.provideServiceEffect(
					Effect.scoped(runLocality(drawn, c.note)),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "universal",
			name: "invariance: each judged statement's scans read the same rows, of stored relations and of the deltas, for a write of one group beside a few hundred untouched groups and beside a thousand"
		},
		show: Formatter.format,
		kept: [
			{
				token: ReplayToken(
					"test/pg/laws/rule-aggregate.test.ts#aProbeOfTheGroupsAWriteTouchedReadsThoseGroupsAloneHoweverManyGroupsStandBesideThem:-:1"
				),
				reason:
					"a count grouped by n and Topic's topic beside 200 groups and then 800, whose fold's join of Attempt and Topic PostgreSQL ordered one way and then the other while its body was read as written (14 rows, then 15, at 95abc7176), so no planner choice of join order is left inside a grouped read",
				since: "2026-11-21"
			},
			{
				token: ReplayToken(
					"test/pg/laws/rule-aggregate.test.ts#aProbeOfTheGroupsAWriteTouchedReadsThoseGroupsAloneHoweverManyGroupsStandBesideThem:-:0.0.3.1.0.0.1.1.0.0.0.2.0.1.2j.0"
				),
				reason:
					"a count grouped by child, item and n under a key of child and n beside 291 groups and then 891, whose touched group's two attempts PostgreSQL read by (child, n) and sorted, then read in order by the primary key: 12 rows handled, then 10, for the same two rows read (trunk's TEST_SEED=552969958 at f1bf91a2f), so the measure counts the rows scans read alone (rule-aggregate.fixtures.ts scannedWork)",
				since: "2026-11-22"
			}
		],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original:
					"\t\tconst inside = boundInside(source, bindings, fixedTerms(step), this.#columns)",
				replacement: "\t\tconst inside = source",
				why: "The step that reads a touched group's fact folds every group, unbound to the touched group's keys, so a write of one group reads every group stored beside it."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: "\t\t\tconst rule = foldedOverBody(arm, interned)",
				replacement: "\t\t\tconst rule = arm",
				why: "An aggregating rule's body is read as written, one join PostgreSQL orders by its estimates: a group of n and topic folds Attempt and Topic in one order beside a few hundred groups and in the other beside a thousand, so its probe handles a row more."
			},
			{
				file: "bench/harness/explain.ts",
				original:
					"export const rowsRead = (plan: PlanNode): number => scanned(planNodes(plan).filter(storedScan))",
				replacement:
					'export const rowsRead = (plan: PlanNode): number => scanned(planNodes(plan).filter((n) => storedScan(n) || n.nodeType === "Sort"))',
				why: "A sort's rows are counted as rows read, as every node's were: PostgreSQL sorts the kept case's touched group's two attempts beside a few hundred groups and reads them in order by the primary key beside a thousand, so its probe reads two rows more beside fewer groups for the same two rows of Attempt; the property fails."
			}
		]
	})
