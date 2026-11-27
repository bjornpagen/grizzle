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
 * shape whose rule every relation it reads could keep unit-local is mutable, its relations open in the child's unit,
 * so its rule is judged whole over the children its writes touch (analysis/theory/unit.ts wholeRule), puts and deletes
 * among them; every other shape's rule is judged by its probes. A probed law over an aggregate read at a binding that
 * leaves a unit its body matches free is refused when its schema compiles, naming the remedy (analysis/theory/query.ts
 * refuseAggregatesAcrossUnits): a mutable shape grouped without the child, or joining Topic without the item, group
 * within a unit; one grouped within its units under a key whose terms omit the child, or the item where it joins Topic,
 * bind the unit's fields in the law. Its probe would fold again every row of every group at its binding across the
 * units at each write.
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
 * - **Locality:** an invariance, never a time. A shape's touched group stored beside 200 to 400 untouched groups, each
 *   an attempt of its own that is a group of its own under any grouping, in a learner's unit of its own, and then
 *   beside 600 to 900 more; each time a second attempt of the touched group written in a transaction rolled back, and
 *   every statement the judge runs over the touch explained while the deltas hold it (test/support/judge.ts judgeRun),
 *   under no planner setting, beside a background of untouched groups that makes every table larger than a probe: a
 *   stored aggregate's upkeep's DELETE and
 *   INSERT, run as the judge's phase A runs them, and each rule's statement over a delta holding a row, Attempt's side
 *   of news or one the upkeep's writes filled. Where Read's definition groups by the child and more, (child, item, n)
 *   or the like, Read is stored (analysis/derived/storage.ts), its unit wider than the learner's, so a rule over it
 *   reads its table and its deltas, and only its upkeep reads Attempt's: the upkeep's work is the touched group's, as
 *   a probe's is where Read is live. Each
 *   statement reads no table larger than a probe whole and does the same keyed work both times
 *   (test/support/judge.ts keyedWork): a stored aggregate's upkeep, a probe of a touched group, or a unit-local
 *   shape's whole statement of its unit, reads that group alone, never the groups beside it, as PostgreSQL plans it
 *   under the installation's declared statistics.
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
	type LocalityFeature,
	localityGen,
	refusedAcrossUnits,
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
			refusedAcrossUnits,
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
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original: '\t\t([field, e]) => !folded(field) || (e.kind === "var" && readNowhere(e.var))',
				replacement: "\t\t() => true",
				why: "A negation that reads a group's fold is read as its body too, the fold dropped: a containment of Expect's facts into the aggregate at its fold accepts a write that changes the fold under Expect, as long as the group stands."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\t\t\t\t\tconst free = freeUnitIn(body, at, unitOf)\n",
				replacement: "\t\t\t\t\tconst free = freeUnitIn(body, at, () => [])\n",
				why: "No binding leaves a unit free, so a law over an aggregate grouped across the learners compiles again and its probe folds every row of a touched group at each write: a shape whose groups omit the child installs where it is refused."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original:
					'\t\t\t\tconst head = arm.head[t.field]\n\t\t\t\treturn head?.kind === "var" ? [head.var] : []\n',
				replacement: "\t\t\t\tconst head = arm.head[t.field]\n\t\t\t\treturn []\n",
				why: "No law's terms hold a unit, so a law over a group inside one learner's unit is refused too: edullm's minimal trigger, a key over DirectOpen(child, item) grouped by (child, item, n), fails to compile."
			},
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
					'\t\t\t\t{\n\t\t\t\t\tdirection: "removed",\n\t\t\t\t\tregion: {\n\t\t\t\t\t\tkind: "groups",\n\t\t\t\t\t\tdepth,\n\t\t\t\t\t\ttouched: t.query,\n\t\t\t\t\t\tkeys: t.fields,\n\t\t\t\t\t\tread: { kind: "lost" }\n\t\t\t\t\t}\n\t\t\t\t}\n',
				replacement: "",
				why: "A touched group's lost fact is read by no probe, so a write that changes a group's fold withdraws the fact Expect holds it to unjudged, and a state breaking the containment into the aggregate commits."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\t\t\t\tbothWays,\n",
				replacement: '\t\t\t\t["added"],\n',
				why: "A group is touched only by the facts of its body a write may add, never by those it withdraws, so a delete or a put that takes an attempt out of its group leaves the group's fold unjudged: a delete that raises a group's least score past the check's bound, or lowers a count Expect holds, commits."
			}
		]
	})

/**
 * A probe of the groups a write touched reads those groups alone, however many groups stand beside them, as a
 * unit-local shape's whole statement reads its unit's and a stored aggregate's upkeep its touched group's.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aProbeOfTheGroupsAWriteTouchedReadsThoseGroupsAloneHoweverManyGroupsStandBesideThem =
	property.explore(recorded(localityGen, keptLocality), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: ["measured", refusedAcrossUnits] satisfies ReadonlyArray<Reached<LocalityFeature>>,
		check:
			({ substrate }, c: Case<LocalityFeature>) =>
			(drawn) =>
				Effect.provideServiceEffect(
					Effect.scoped(runLocality(drawn, c.note)),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "universal",
			name: "a bound and invariance: each statement the judge runs over a write of one group, a stored aggregate's upkeep's and a rule's alike, reads no table larger than a probe whole and does the same keyed work, the rows it reads of stored relations and of the deltas but a table read whole for what its probe costs, beside a few hundred untouched groups and beside a thousand more, beside a background of 2,048"
		},
		show: Formatter.format,
		kept: [
			{
				token: ReplayToken(
					"test/pg/laws/rule-aggregate.test.ts#aProbeOfTheGroupsAWriteTouchedReadsThoseGroupsAloneHoweverManyGroupsStandBesideThem:-:1"
				),
				reason:
					"a count grouped by n and Topic's topic beside 200 groups and then 800, whose fold's join of Attempt and Topic PostgreSQL ordered one way and then the other while its body was read as written (14 rows, then 15, at 95abc7176), counted by the rows its plan handled; under the installation's declared statistics and no planner setting, beside a background of 2,048 groups, the body read as written does the keyed work its chain did (at NOSETTINGS), so the fold reads its body as written again",
				since: "2026-11-21"
			},
			{
				token: ReplayToken(
					"test/pg/laws/rule-aggregate.test.ts#aProbeOfTheGroupsAWriteTouchedReadsThoseGroupsAloneHoweverManyGroupsStandBesideThem:-:0.0.3.1.0.0.1.1.0.0.0.2.0.1.2j.0"
				),
				reason:
					"a count grouped by child, item and n under a key of child and n beside 291 groups and then 891, whose touched group's two attempts PostgreSQL read by (child, n) and sorted, then read in order by the primary key: 12 rows handled, then 10, for the same two rows read (trunk's TEST_SEED=552969958 at f1bf91a2f), so the measure counts the rows scans read alone (test/support/judge.ts scannedWork); Read, over the aggregate, is stored, its unit (child, item, n) wider than the learner's, so the touched group is read by Read's upkeep",
				since: "2026-11-22"
			},
			{
				token: ReplayToken(
					"test/pg/laws/rule-aggregate.test.ts#aProbeOfTheGroupsAWriteTouchedReadsThoseGroupsAloneHoweverManyGroupsStandBesideThem:-:0.0.1.1.1.1.1.0.1.0.0.0.1.0.0"
				),
				reason:
					"a count grouped by item over Attempt's rows whose item is not adaptive, read by both arms of a plain union beside 200 groups and then 800, its body computed once for each touched item beside it (share/keyed.ts carried, a LATERAL aggregate PostgreSQL never pulls up): with the body beside the key set unfenced, PostgreSQL joined them by a Materialize of every Attempt row under a join filter, 405 rows read, then 1,605 (DECIDE4's compute-once at 8f997ec92)",
				since: "2026-11-24"
			},
			{
				token: ReplayToken(
					"test/pg/laws/rule-aggregate.test.ts#aProbeOfTheGroupsAWriteTouchedReadsThoseGroupsAloneHoweverManyGroupsStandBesideThem:-:0.1.1.2.1.0.0.0.1.1.0.0.0.0.0"
				),
				reason:
					"a count grouped by n over closed Attempt joined to Topic, read by a rule matching it, under a containment of Expect's groups into it beside 200 groups and then 800, under no planner setting (rotating seed 0xa6359e29, case 45, at NOSETTINGS): the containment's probe negated the aggregate at the touched n as written, its fold over a join of Attempt and Topic that PostgreSQL hashed, both tables read whole, no index led by n; a negation of groups at their keys is their body's existence there (analysis/theory/navigate.ts filteredArm), a chain, Attempt stepped at n by an index the step asks for, then Topic by its key",
				since: "2026-11-26"
			},
			{
				token: ReplayToken(
					"test/pg/laws/rule-aggregate.test.ts#aProbeOfTheGroupsAWriteTouchedReadsThoseGroupsAloneHoweverManyGroupsStandBesideThem:-:0.0.3.2.0.0.0.1.0.0.0.1.1.0.0"
				),
				reason:
					"a key at the item alone over each learner's counted sessions of an item, grouped by (child, item, n) inside the learner's unit and read under Cap at the child, open: its probe at the item read every learner's group of the item and folded each again, its work growing with the learners (live, unboundedUpkeep, at ef0faa71 under no planner setting); refused since, naming the remedy, bind the unit's fields (child) in the law",
				since: "2026-11-26"
			},
			{
				token: ReplayToken(
					"test/pg/laws/rule-aggregate.test.ts#aProbeOfTheGroupsAWriteTouchedReadsThoseGroupsAloneHoweverManyGroupsStandBesideThem:-:0.1.1.2.0.0.1.2.0.1.0.0.0"
				),
				reason:
					"a count grouped by n over closed Attempt joined to Topic, read directly, under a containment of Expect into it at its groups and its fold beside 200 groups and then 800, under no planner setting (rotating seed 0x06f1f915 at NOSETTINGS): the containment's probe negated the aggregate at the touched n and its fold as written, its body a join of Attempt and Topic PostgreSQL hashed whole, no index led by n; a filter over a query's groups is navigated (analysis/theory/navigate.ts testsGroups), the groups a step restricted inside at n, the fold compared after",
				since: "2026-11-26"
			}
		],
		kills: [
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: "\t\t\t\t\tconst at = innerSeeds(m.bindings, m.groups.keys, body, holds)\n",
				replacement:
					"\t\t\t\t\tconst at = innerSeeds(m.bindings, m.groups.keys, body, () => true)\n",
				why: "A law's binding reaches every group field, as its groups' own refusal read them, so a key over each learner's counted sessions of an item, read at the item alone, compiles, its Read live under Cap, a probed key over it among the rules, and its probe folds every learner's group of the item at each write."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original:
					"\t\t\tfilteredArm(arm, e.bindings) !== arm ||\n\t\t\tarm.matches.some((m) => foldsIn(m.source) !== undefined)",
				replacement: "\t\t\tfilteredArm(arm, e.bindings) !== arm",
				why: "A filter whose arm reads an aggregate's fold stays as written: the containment of Expect into a count by n of Attempt joined to Topic at its fold reads the fold's body as one join beside the touched n, both tables hashed whole."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original:
					'\t\tsharing.kind === "perStatement" && (interned.overSteps(read) || read.where.some(testsGroups))',
				replacement: '\t\tsharing.kind === "perStatement" && interned.overSteps(read)',
				why: "A negation of an aggregate's groups at their keys stays the fold as written: the containment of Expect into a count by n of Attempt joined to Topic hashes both tables whole beside the touched n, every group's rows read."
			},
			{
				file: "packages/engine/src/analysis/theory/navigate.ts",
				original:
					"\t\tconst inside = boundInside(source, bindings, fixedTerms(step), this.#columns)",
				replacement: "\t\tconst inside = source",
				why: "The step that reads a touched group's fact folds every group, unbound to the touched group's keys, so a write of one group reads every group stored beside it."
			}
		]
	})
