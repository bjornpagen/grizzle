/**
 * The native constraints grizzle installs mean what its laws mean. Three readings of one schema meet here: an oracle
 * of the laws' meaning; the native model (test/support/native/model.ts), which evaluates the native objects the law
 * model installs with PostgreSQL's semantics (UNIQUE NULLS DISTINCT and WITHOUT OVERLAPS, FOREIGN KEY … MATCH SIMPLE
 * and PERIOD, immediate or deferred, ON UPDATE CASCADE, CHECK, generated and drawn law columns, contract domains); and
 * PostgreSQL itself, at the pg tier. The oracle is never the compiler: the host law model (test/support/laws/model.ts)
 * for partial projections, keys, containments, span keys and coverage, and for a family the family model
 * (test/support/families), which states when PostgreSQL checks each of the lemma's constraints, and the theorem.
 *
 * Over every state, every law the host model finds broken is refused by a constraint that discharges it, and every
 * constraint the state breaks discharges a law it breaks, so the installation accepts a state exactly when every law
 * holds. Over every transaction from a committed state, each order a writer may send its statements in (one per table
 * and change, a table's removals before its additions, and each immediate reference's target added before and removed
 * after its source) commits exactly when the state it leaves is lawful, and a refusal names a law broken at that
 * moment. A family's transactions, its count's update writing its owner's row alone, since no member holds the count,
 * commit or are refused where the family model says, at the same statement or at COMMIT, reporting the laws of the constraints it finds broken.
 *
 * - Box: every rule of the partial-projection lowering with each of its selections, over every state of at most two
 *   Owner rows and three of every other relation, and every order a writer sends.
 * - Explored: drawn schemas over selections of the whole predicate language, puts included, their states and
 *   transactions drawn.
 * - Fin box: the fin lemma stated as plain laws, no owner or an owner of count 0 to 3 over its first four slots, each
 *   holding no row, one or two, every successor drawn from its slot and the count, against the family theorem's
 *   constraints.
 * - Fin programs: every state a family program's statements leave, lawful, breaking and misordered, refused at the
 *   statement or at COMMIT where the family model says.
 * - Family box: grizzle's own families, each shape ordered and counted, over the fin box's states.
 * - Family programs: grizzle's own families' transactions, drawn successors, count updates and each axis's deferral,
 *   as the family model runs them.
 * - Span box: every span rule over at most two rows of Visit and of Shift, keys WITHOUT OVERLAPS over fields and law
 *   columns and PERIOD foreign keys from and into selected sides.
 * - Pairs: two laws over selections of one relation kept apart, each refused by its own constraint but a key whose
 *   every violation breaks the other too, and a rule stated in both orientations installed as one law.
 *
 * Features: each suite's rule kinds, verdicts and variants (RuleFeature, ExploredFeature, FinFeature, FamilyFeature,
 * SpanFeature, PairFeature), the vocabularies its coverage requires.
 */

import { runProgram } from "@bjornpagen/testing/commands"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	applied,
	type MutationStatement as FamilyStatement,
	machineOf,
	realOf
} from "#test/support/families/mutate.ts"
import { type Families, storedOf } from "#test/support/families/theorem.ts"
import {
	BOX_RULES,
	boxGen,
	finBoxGen,
	PAIR_KINDS,
	pairGen,
	SPAN_BOX_RULES,
	spanBoxGen,
	VARIANTS
} from "#test/support/native/generate.ts"
import {
	RULE_KINDS,
	SPAN_RELATIONS,
	SPAN_RULE_KINDS,
	spanLawsOf,
	spanRuleText
} from "#test/support/native/schemas.ts"
import {
	brokenIn,
	type ExploredFeature,
	exploredSpace,
	familiesNeed,
	familiesStateNeed,
	FAMILY_ORACLE,
	familyBoxGen,
	type FamilyFeature,
	FIN,
	type FinFeature,
	finNeed,
	finState,
	holdsEverySide,
	HOST_ORACLE,
	install,
	installed,
	installRules,
	judgeFamily,
	judgeFamilyState,
	judgeFamilyTransaction,
	judgePair,
	judgePut,
	judgePuts,
	judgeState,
	judgeWrites,
	LEMMA_ORACLE,
	PAIR_ORACLE,
	PAIRED_KINDS,
	type PairFeature,
	programs,
	relations,
	type RuleEntry,
	type RuleFeature,
	type SpanEntry,
	type SpanFeature,
	VERDICTS
} from "#test/unit/laws/native.fixtures.ts"

/** The native constraints grizzle installs accept every state of a rule's box exactly when its laws hold, each broken law refused by its own constraint, in every order a writer sends. */
export const theNativeConstraintsGrizzleInstallsAcceptEveryStateOfARulesBoxExactlyWhenItsLawsHoldEachBrokenLawRefusedByItsOwnConstraintInEveryOrderAWriterSends =
	property.exhaust(
		finite(
			boxGen(Arr.map(BOX_RULES, (rule): RuleEntry => ({ rule, installed: installRules([rule]) })))
		),
		{
			needs: {},
			situations: [...RULE_KINDS, ...VERDICTS, "a put"] satisfies ReadonlyArray<
				Reached<RuleFeature>
			>,
			check: (_, c: Case<RuleFeature>) => (b) =>
				Effect.sync(() => {
					c.note(b.entry.rule.rule)
					const installed = b.entry.installed
					const broken = judgeState(installed, relations, b.state, c)
					judgeWrites(installed, relations, b.state, broken.size === 0, c)
					if (broken.size === 0) {
						judgePuts(installed, relations, b.state, c)
					}
				}),
			oracle: HOST_ORACLE,
			box: "every rule of the partial-projection lowering with each of its selections, over every state of at most two Owner rows and three of every other relation, each varying the fields its laws read over two or three values",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/laws/model/plan.ts",
					original: '\tterm.kind === "field" && selection.conjuncts.length === 0',
					replacement: '\tterm.kind === "field"',
					why: "A selected side's field term lowers to its field (laws/model/plan.ts termColumn), so its law holds over every fact; the box, the explored schemas, the span box and the pairs fail."
				},
				{
					file: "packages/engine/src/laws/model/model.ts",
					original: "\t\treturn from === to || (own !== undefined && own === cycleOf.get(to))",
					replacement: "\t\treturn from === to",
					why: "A foreign key on a cycle of the references is installed immediate (laws/model/model.ts onCycleOf finds only a self-reference on a cycle), so a lawful transaction is refused at its statement; the box and the explored schemas fail."
				},
				{
					file: "packages/engine/src/scalar/natural.ts",
					original: '\t\tguard: [{ kind: "compare", op: "gt", left: x, right: integer(0n) }],',
					replacement: '\t\tguard: [{ kind: "compare", op: "ge", left: x, right: integer(0n) }],',
					why: "pred(x) is guarded by x >= 0 (scalar/natural.ts predTerm), so pred(0) is −1 where it is NULL; the fin box and the fin programs fail, the closure refusing slot 0, as do the box, the explored schemas, grizzle's own families and the pairs."
				}
			]
		}
	)

/** The native constraints grizzle installs accept a drawn schema's states exactly when its laws hold, over selections of the whole predicate language, puts included. Its budget is its suite's before it was a property (test/unit/laws/native.test.ts at 4ca3036a): 1000 runs and 2000 steered cases. */
export const theNativeConstraintsGrizzleInstallsAcceptADrawnSchemasStatesExactlyWhenItsLawsHoldOverSelectionsOfTheWholePredicateLanguagePutsIncluded =
	property.explore(exploredSpace, {
		needs: {},
		budget: { runs: 1000, steered: 2000 },
		situations: [
			...RULE_KINDS,
			...VERDICTS,
			"a put",
			...VARIANTS,
			...Arr.flatMap(
				PAIRED_KINDS,
				(kind): ReadonlyArray<readonly [ExploredFeature, ExploredFeature]> => [
					[kind, "accepted"],
					[kind, "accepted with a row on every side"],
					[kind, "refused"]
				]
			)
		] satisfies ReadonlyArray<Reached<ExploredFeature>>,
		check: (_, c: Case<ExploredFeature>) => (e) =>
			Effect.sync(() => {
				const installed = installRules(e.rules)
				for (const variant of e.applied) {
					c.note(variant)
				}
				const broken = judgeState(installed, relations, e.state, c)
				for (const r of e.rules) {
					c.note(r.rule)
					c.pair(r.rule, broken.size === 0 ? "accepted" : "refused")
					if (broken.size === 0 && holdsEverySide(r, e.state)) {
						c.pair(r.rule, "accepted with a row on every side")
					}
				}
				judgeWrites(installed, relations, e.state, broken.size === 0, c)
				if (broken.size === 0) {
					judgePut(installed, relations, e.state, c)
				}
			}),
		oracle: HOST_ORACLE,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: '\tterm.kind === "field" && selection.conjuncts.length === 0',
				replacement: '\tterm.kind === "field"',
				why: "A selected side's field term lowers to its field (laws/model/plan.ts termColumn), so its law holds over every fact; the box, the explored schemas, the span box and the pairs fail."
			},
			{
				file: "packages/engine/src/laws/model/model.ts",
				original: "\t\treturn from === to || (own !== undefined && own === cycleOf.get(to))",
				replacement: "\t\treturn from === to",
				why: "A foreign key on a cycle of the references is installed immediate (laws/model/model.ts onCycleOf finds only a self-reference on a cycle), so a lawful transaction is refused at its statement; the box and the explored schemas fail."
			},
			{
				file: "packages/engine/src/scalar/natural.ts",
				original: '\t\tguard: [{ kind: "compare", op: "gt", left: x, right: integer(0n) }],',
				replacement: '\t\tguard: [{ kind: "compare", op: "ge", left: x, right: integer(0n) }],',
				why: "pred(x) is guarded by x >= 0 (scalar/natural.ts predTerm), so pred(0) is −1 where it is NULL; the fin box and the fin programs fail, the closure refusing slot 0, as do the box, the explored schemas, grizzle's own families and the pairs."
			}
		]
	})

/** The native constraints grizzle installs hold the fin lemma's laws exactly as the family theorem's constraints, over every state of one owner's first four slots. */
export const theNativeConstraintsGrizzleInstallsHoldTheFinLemmasLawsExactlyAsTheFamilyTheoremsConstraintsOverEveryStateOfOneOwnersFirstFourSlots =
	property.exhaust(finite(finBoxGen), {
		needs: {},
		situations: [
			"the theorem holds",
			"breach twice",
			"breach orphan",
			"breach beyond",
			"breach gap",
			"violates key",
			"violates holding",
			"violates last",
			"violates closure",
			"refused by ForeignKey",
			"refused by Unique",
			"refused at commit",
			"refused at a statement",
			"a removal"
		] satisfies ReadonlyArray<Reached<FinFeature>>,
		check: (_, c: Case<FinFeature>) => (stored) =>
			Effect.sync(() => {
				judgeFamily(installed, stored, c)
				const state = finState(stored)
				judgeWrites(installed, FIN, state, brokenIn(installed, state).size === 0, c)
			}),
		oracle: FAMILY_ORACLE,
		box: "no owner or an owner of count 0 to 3, over its first four slots, each holding no row, one or two, every successor drawn from its slot and the count",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/natural.ts",
				original: '\t\tguard: [{ kind: "compare", op: "gt", left: x, right: integer(0n) }],',
				replacement: '\t\tguard: [{ kind: "compare", op: "ge", left: x, right: integer(0n) }],',
				why: "pred(x) is guarded by x >= 0 (scalar/natural.ts predTerm), so pred(0) is −1 where it is NULL; the fin box and the fin programs fail, the closure refusing slot 0, as do the box, the explored schemas, grizzle's own families and the pairs."
			}
		]
	})

/** The native constraints grizzle installs hold the fin lemma's laws on every state a family program's statements leave, lawful, breaking and misordered. Its budget is its suite's before it was a property (test/unit/laws/native.test.ts at 4ca3036a): 300 runs and 400 steered cases. */
export const theNativeConstraintsGrizzleInstallsHoldTheFinLemmasLawsOnEveryStateAFamilyProgramsStatementsLeaveLawfulBreakingAndMisordered =
	property.explore(programs, {
		needs: { finNeed },
		budget: { runs: 300, steered: 400 },
		situations: [
			"the theorem holds",
			"breach twice",
			"breach orphan",
			"breach beyond",
			"breach gap",
			"violates identity",
			"violates key",
			"violates holding",
			"violates last",
			"violates closure"
		] satisfies ReadonlyArray<Reached<FinFeature>>,
		check:
			({ finNeed }, c: Case<FinFeature>) =>
			(p) =>
				Effect.gen(function* () {
					const installed = yield* finNeed
					return yield* Effect.suspend(() => {
						const every = (before: Families, statements: ReadonlyArray<FamilyStatement>) =>
							Effect.sync(() => {
								for (const stored of Arr.scan(statements, storedOf(before), applied)) {
									judgeFamily(installed, stored, c)
								}
							})
						return runProgram(
							machineOf(p.shape, p.families, p.forms),
							realOf({
								lawful: (_form, m, before) => every(before, m.statements),
								breaking: (_form, m, before) => every(before, m.statements),
								misordered: (m, before) => every(before, m.statements)
							}),
							p.steps
						)
					})
				}),
		oracle: FAMILY_ORACLE,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/natural.ts",
				original: '\t\tguard: [{ kind: "compare", op: "gt", left: x, right: integer(0n) }],',
				replacement: '\t\tguard: [{ kind: "compare", op: "ge", left: x, right: integer(0n) }],',
				why: "pred(x) is guarded by x >= 0 (scalar/natural.ts predTerm), so pred(0) is −1 where it is NULL; the fin box and the fin programs fail, the closure refusing slot 0, as do the box, the explored schemas, grizzle's own families and the pairs."
			}
		]
	})

/** The native constraints grizzle installs hold grizzle's own families, ordered and counted, as the family theorem's constraints, over every state of one owner's first four slots. */
export const theNativeConstraintsGrizzleInstallsHoldGrizzlesOwnFamiliesOrderedAndCountedAsTheFamilyTheoremsConstraintsOverEveryStateOfOneOwnersFirstFourSlots =
	property.exhaust(finite(familyBoxGen), {
		needs: { familiesStateNeed },
		situations: [
			"ordered",
			"counted",
			"the theorem holds",
			"breach twice",
			"breach orphan",
			"breach beyond",
			"breach gap"
		] satisfies ReadonlyArray<Reached<FamilyFeature>>,
		check:
			({ familiesStateNeed }, c: Case<FamilyFeature>) =>
			([shape, stored]) =>
				Effect.gen(function* () {
					const installed = yield* familiesStateNeed
					return yield* Effect.sync(() => judgeFamilyState(installed[shape], shape, stored, c))
				}),
		oracle: LEMMA_ORACLE,
		box: "each shape, ordered and counted, with no owner or an owner of count 0 to 3, over its first four slots, each holding no row, one or two, every successor drawn from its slot and the count",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/natural.ts",
				original: '\t\tguard: [{ kind: "compare", op: "gt", left: x, right: integer(0n) }],',
				replacement: '\t\tguard: [{ kind: "compare", op: "ge", left: x, right: integer(0n) }],',
				why: "pred(x) is guarded by x >= 0 (scalar/natural.ts predTerm), so pred(0) is −1 where it is NULL; the fin box and the fin programs fail, the closure refusing slot 0, as do the box, the explored schemas, grizzle's own families and the pairs."
			},
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: "\t\tconst predecessorBase = appendNonEmpty(successorKey, index)\n",
				replacement: "\t\tconst predecessorBase = appendNonEmpty(successorKey, next)\n",
				why: "The predecessor axis pairs each member's own successor with its predecessor's, not its index (laws/model/plan.ts): the member at slot 1 of three names the one at 0 with successor 2, which holds 1, so a lawful family of three is refused; the family box fails."
			}
		]
	})

/** The native constraints grizzle installs run every family program's transactions on grizzle's own families as the family model runs them: drawn successors, count updates and each axis's deferral. Its budget is its suite's before it was a property (test/unit/laws/native.test.ts at 4ca3036a): 300 runs and 400 steered cases. */
export const theNativeConstraintsGrizzleInstallsRunEveryFamilyProgramsTransactionsOnGrizzlesOwnFamiliesAsTheFamilyModelRunsThemDrawnSuccessorsCountUpdatesAndEachAxissDeferral =
	property.explore(programs, {
		needs: { familiesNeed },
		budget: { runs: 300, steered: 400 },
		situations: [
			"ordered",
			"counted",
			"committed",
			"refused at a statement",
			"refused at commit",
			"a count update",
			"refused by identity",
			"refused by key",
			"refused by holding",
			"refused by last",
			"refused by closure",
			["ordered", "refused by closure"],
			["counted", "refused by closure"],
			["ordered", "a count update"],
			["counted", "a count update"]
		] satisfies ReadonlyArray<Reached<FamilyFeature>>,
		check:
			({ familiesNeed }, c: Case<FamilyFeature>) =>
			(p) =>
				Effect.gen(function* () {
					const installed = yield* familiesNeed
					return yield* Effect.suspend(() => {
						const every = (before: Families, statements: ReadonlyArray<FamilyStatement>) =>
							Effect.sync(() => {
								judgeFamilyTransaction(installed[p.shape], p.shape, before, statements, c)
								for (const stored of Arr.scan(statements, storedOf(before), applied)) {
									judgeFamilyState(installed[p.shape], p.shape, stored, c)
								}
							})
						return runProgram(
							machineOf(p.shape, p.families, p.forms),
							realOf({
								lawful: (_form, m, before) => every(before, m.statements),
								breaking: (_form, m, before) => every(before, m.statements),
								misordered: (m, before) => every(before, m.statements)
							}),
							p.steps
						)
					})
				}),
		oracle: LEMMA_ORACLE,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original:
					'\t\t\t\tindex.kind === "field" && !this.#recognizer.refillDeferred("predecessor", f)',
				replacement: '\t\t\t\t!this.#recognizer.refillDeferred("predecessor", f)',
				why: "A counted family's predecessor axis is immediate, which swap-with-last breaks mid-plan; the family programs fail."
			}
		]
	})

/** The native constraints grizzle installs accept every state of a span rule's box exactly when its laws hold: keys WITHOUT OVERLAPS over fields and law columns, and PERIOD foreign keys from and into selected sides. */
export const theNativeConstraintsGrizzleInstallsAcceptEveryStateOfASpanRulesBoxExactlyWhenItsLawsHoldKeysWITHOUTOVERLAPSOverFieldsAndLawColumnsAndPERIODForeignKeysFromAndIntoSelectedSides =
	property.exhaust(
		finite(
			spanBoxGen(
				Arr.map(SPAN_BOX_RULES, (rule): SpanEntry => ({
					rule,
					installed: install(spanRuleText(rule), SPAN_RELATIONS, spanLawsOf(rule))
				}))
			)
		),
		{
			needs: {},
			situations: [
				...SPAN_RULE_KINDS,
				"accepted",
				"refused",
				"refused by WithoutOverlaps",
				"refused by PeriodForeignKey",
				"refused at a statement",
				"refused at commit",
				"a put",
				"a removal"
			] satisfies ReadonlyArray<Reached<SpanFeature>>,
			check: (_, c: Case<SpanFeature>) => (b) =>
				Effect.sync(() => {
					c.note(b.entry.rule.rule)
					const installed = b.entry.installed
					const broken = judgeState(installed, SPAN_RELATIONS, b.state, c)
					judgeWrites(installed, SPAN_RELATIONS, b.state, broken.size === 0, c)
					if (broken.size === 0) {
						judgePuts(installed, SPAN_RELATIONS, b.state, c)
					}
				}),
			oracle: HOST_ORACLE,
			box: "every span rule over at most two rows of Visit and of Shift, each varying the fields its laws read, its owner over two values and its span over two adjacent halves and their whole",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/laws/model/plan.ts",
					original: '\tterm.kind === "field" && selection.conjuncts.length === 0',
					replacement: '\tterm.kind === "field"',
					why: "A selected side's field term lowers to its field (laws/model/plan.ts termColumn), so its law holds over every fact; the box, the explored schemas, the span box and the pairs fail."
				}
			]
		}
	)

/** The native constraints grizzle installs keep two laws over selections of one relation apart, each refused by its own constraint, and install a rule stated in both orientations as one law. Its budget is its suite's before it was a property (test/unit/laws/native.test.ts at 4ca3036a): 100 runs and 500 steered cases. */
export const theNativeConstraintsGrizzleInstallsKeepTwoLawsOverSelectionsOfOneRelationApartEachRefusedByItsOwnConstraintAndInstallARuleStatedInBothOrientationsAsOneLaw =
	property.explore(pairGen, {
		needs: {},
		budget: { runs: 100, steered: 500 },
		situations: [
			...PAIR_KINDS,
			...Arr.map(PAIR_KINDS, (kind): readonly [PairFeature, PairFeature] => [
				kind,
				"two laws over selections of one relation"
			]),
			"two laws over selections of one relation",
			"a comparison stated in both orientations",
			"a law of a pair refused alone"
		] satisfies ReadonlyArray<Reached<PairFeature>>,
		check: (_, c: Case<PairFeature>) => (p) => Effect.sync(() => judgePair(p, c)),
		oracle: PAIR_ORACLE,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/plan.ts",
				original: '\tterm.kind === "field" && selection.conjuncts.length === 0',
				replacement: '\tterm.kind === "field"',
				why: "A selected side's field term lowers to its field (laws/model/plan.ts termColumn), so its law holds over every fact; the box, the explored schemas, the span box and the pairs fail."
			},
			{
				file: "packages/engine/src/scalar/natural.ts",
				original: '\t\tguard: [{ kind: "compare", op: "gt", left: x, right: integer(0n) }],',
				replacement: '\t\tguard: [{ kind: "compare", op: "ge", left: x, right: integer(0n) }],',
				why: "pred(x) is guarded by x >= 0 (scalar/natural.ts predTerm), so pred(0) is −1 where it is NULL; the fin box and the fin programs fail, the closure refusing slot 0, as do the box, the explored schemas, grizzle's own families and the pairs."
			}
		]
	})
