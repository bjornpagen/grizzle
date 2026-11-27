/**
 * What a law's refusal names: a native refusal witnessed on the host (suites/host.ts), statement-time native violations
 * under their law's constraint (suites/witness.ts), and a refused CHECK naming every law its row breaks
 * (suites/every.ts).
 */
import type { Reached } from "@bjornpagen/testing/features"
import { recorded } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import {
	backwardTemplate,
	cellCaseGen as everyCases,
	everyCase,
	type CellFeature as EveryFeature,
	forwardTemplate
} from "#test/pg/laws/outcomes/suites/every.ts"
import {
	accountCases,
	accountsTemplate,
	type AccountFeature as HostFeature,
	hostCase
} from "#test/pg/laws/outcomes/suites/host.ts"
import {
	clubsTemplate,
	nativeCase,
	nativeCaseGen,
	type NativeFeature,
	recordedNatives
} from "#test/pg/laws/outcomes/suites/witness.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A refused write names one law its accounts break and the key of an account that breaks it, each case on its own
 * clone of Accounts, installed once per member.
 *
 * Its pre-conversion budget: runs 60, coverage cases 60 (test/pg/laws/outcomes/suites/host.ts at 2b496802c).
 */
export const aRefusedWriteNamesOneLawItsAccountsBreakAndTheKeyOfAnAccountThatBreaksIt =
	property.explore(accountCases, {
		needs: { accounts: Substrate.fresh(accountsTemplate) },
		situations: [
			"refused by rate",
			"refused by units",
			"refused by positive",
			"refused by withinRate",
			"refused by distinct",
			"refused by code",
			"refused by alias",
			"refused by the code and the alias at once",
			"refused by two row CHECKs at once",
			"accepted",
			"witnessed among several breaking accounts"
		] satisfies ReadonlyArray<Reached<HostFeature>>,
		check:
			({ accounts }, c: Case<HostFeature>) =>
			(k) =>
				Effect.scoped(Effect.flatMap(accounts, (taken) => hostCase(taken, k, c))),
		oracle: {
			kind: "specification",
			name: "each account's rules restated over its drawn fields, and a witness naming an account that breaks the law"
		},
		show: Formatter.format,
		budget: { runs: 60, steered: 60 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/laws/outcomes/witness.test.ts#aRefusedWriteNamesOneLawItsAccountsBreakAndTheKeyOfAnAccountThatBreaksIt:-:0.0.2.0.2.0.0.1.1.0.1.1.0.2.0.0.0.1.0.0.1.0.0"
				),
				reason:
					"a bronze account past its rate beside a gold one whose rate is NULL: the gold row's generated NOT NULL refuses it before WithinRate, so WithinRate's witness is the bronze account",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/laws/outcomes/witness.test.ts#aRefusedWriteNamesOneLawItsAccountsBreakAndTheKeyOfAnAccountThatBreaksIt:-:1"
				),
				reason:
					"qti-pie's shape: one relation whose two fields share one pattern source, the second broken alone, so the refusal names that field and never the other",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/laws/outcomes/witness.test.ts#aRefusedWriteNamesOneLawItsAccountsBreakAndTheKeyOfAnAccountThatBreaksIt:-:2"
				),
				reason:
					"both fields of one pattern broken in one account: the domain PostgreSQL names refuses the first column it casts, and the refusal names both fields' laws",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/laws/outcomes/witness.test.ts#aRefusedWriteNamesOneLawItsAccountsBreakAndTheKeyOfAnAccountThatBreaksIt:-:0.0.1.0.0.0.0.1.0.0.1.0.1"
				),
				reason:
					"one account breaking Positive and Distinct, two row CHECKs: the host judges both, the vector one over the vectors themselves, so the refusal names both whichever PostgreSQL tried first",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/laws/outcomes/witness.test.ts#aRefusedWriteNamesOneLawItsAccountsBreakAndTheKeyOfAnAccountThatBreaksIt:-:0.0.2.0.1.9.0.1.0.0.1.0.0.1.1.j.0.1.1.0.1.1.1"
				),
				reason:
					"a row CHECK over two vectors, the second account's equal: the host judges from <> to over the vectors themselves, so Distinct's witness is that account, never unreported (lane VALUEONE: the host read no vector column, and left every vector check unjudged)",
				since: "2026-11-19"
			}
		],
		kills: []
	})

/**
 * Statement-time native violations are raised under their law's constraint, and a served write reports the law, each
 * case on its own clone of Clubs, installed once per member, its facts loaded.
 *
 * Its pre-conversion budget: runs 60, coverage cases 60 (test/pg/laws/outcomes/suites/witness.ts at 2b496802c).
 */
export const statementTimeNativeViolationsAreRaisedUnderTheirLawsConstraintAndAServedWriteReportsTheLaw =
	property.explore(recorded(nativeCaseGen, recordedNatives), {
		needs: { clubs: Substrate.fresh(clubsTemplate) },
		situations: [
			"refused by a candidate key",
			"refused by a selected side's UNIQUE",
			"refused by a selected side's UNIQUE within one input",
			"refused by a table CHECK",
			"refused by a contract domain",
			"refused by a text refinement domain",
			"refused by a text refinement domain another relation shares"
		] satisfies ReadonlyArray<Reached<NativeFeature>>,
		check:
			({ clubs }, c: Case<NativeFeature>) =>
			(k) =>
				Effect.scoped(
					Effect.flatMap(clubs, (taken) =>
						Effect.provideService(nativeCase(taken, k, c), Substrate, taken.substrate)
					)
				),
		oracle: {
			kind: "postgresql",
			name: "each kind's constraint, read through the naming door, as PostgreSQL raises it, and the outcome a served write must report"
		},
		show: Formatter.format,
		budget: { runs: 60, steered: 60 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/laws/outcomes/witness.test.ts#statementTimeNativeViolationsAreRaisedUnderTheirLawsConstraintAndAServedWriteReportsTheLaw:-:1"
				),
				reason:
					"qti-pie's shape: one pattern source in two relations, Club's code and Member's code, one domain PostgreSQL names alike; a member's code past it is refused by Member's code's law, never Club's",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/laws/outcomes/witness.test.ts#statementTimeNativeViolationsAreRaisedUnderTheirLawsConstraintAndAServedWriteReportsTheLaw:7f.0:0.0.0.0.0.0.0.0.0"
				),
				reason:
					"a member who is no captain, of the stored club whose captain holds the club's code, at the stored captain's email: the email key refuses it, never the captain key, whose guard the member is outside (trunk red at f1bf91a2f, seed 2219874524)",
				since: "2026-11-22"
			}
		],
		kills: [
			{
				file: "packages/engine/src/write/probe.ts",
				original: "\t\t() => withinRow(w.cx, u, (f) => col(rows, column(f)))",
				replacement: "\t\t() => []",
				why: "A met row at SERIALIZABLE is classed at a guarded key wherever a stored row inside its guards agrees with it at the key's fields, its own guards unread: a member who is no captain, refused by the email key, is classed at the captain key, which comes first, and the served write names the captain key's law."
			}
		]
	})

/**
 * A cell breaking one to three rules is refused naming every rule it breaks, under any naming of its CHECKs, each case
 * on its own clones of both namings' installations, each installed once per member.
 *
 * Its pre-conversion budget: runs 100, coverage cases 100 (test/pg/laws/outcomes/suites/every.ts at 2b496802c).
 */
export const aCellBreakingOneToThreeRulesIsRefusedNamingEveryRuleItBreaksUnderAnyNamingOfItsChecks =
	property.explore(everyCases, {
		needs: {
			forward: Substrate.fresh(forwardTemplate),
			backward: Substrate.fresh(backwardTemplate)
		},
		situations: [
			"accepted",
			"1 rules broken",
			"2 rules broken",
			"3 rules broken",
			"the namings try the CHECKs in other orders",
			"a count rule broken beside another",
			"an end rule broken beside another",
			"a rule over the count and the end broken beside another",
			"a count rule an empty family breaks held beside a broken rule",
			"an empty family beside a broken rule",
			"a stored cell inserted again beside the refused one, which the refusal names",
			"a stored cell inserted again that may be the refused one, unreported",
			"a stored cell with its parts stated again beside a refused one"
		] satisfies ReadonlyArray<Reached<EveryFeature>>,
		check:
			({ forward, backward }, c: Case<EveryFeature>) =>
			(k) =>
				Effect.scoped(
					Effect.gen(function* () {
						const takenForward = yield* forward
						const takenBackward = yield* backward
						yield* everyCase(takenForward, takenBackward, k, c)
					})
				),
		oracle: {
			kind: "specification",
			name: "the four rules restated over the drawn values, the count the parts' number and the end their sum"
		},
		show: Formatter.format,
		budget: { runs: 100, steered: 100 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/laws/outcomes/witness.test.ts#aCellBreakingOneToThreeRulesIsRefusedNamingEveryRuleItBreaksUnderAnyNamingOfItsChecks:-:0.2.0.2.1.0"
				),
				reason:
					"qti-pie's p21-sum-as-condition: an operator of two operands, which its arity admits, beside a rule it breaks, once refused naming the arity too, judged at the empty family's count",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/laws/outcomes/witness.test.ts#aCellBreakingOneToThreeRulesIsRefusedNamingEveryRuleItBreaksUnderAnyNamingOfItsChecks:-:0.2.0.0"
				),
				reason:
					"an operator of no operands, fewer than its arity's least, beside a rule it breaks: the arity named too",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/laws/outcomes/witness.test.ts#aCellBreakingOneToThreeRulesIsRefusedNamingEveryRuleItBreaksUnderAnyNamingOfItsChecks:-:0.2.1.3.0.0.0"
				),
				reason:
					"a tuple of three parts, more than its arity's most, beside a rule it breaks, which forward tries before the arity: once refused naming only that rule, judged at the empty family's count",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/laws/outcomes/witness.test.ts#aCellBreakingOneToThreeRulesIsRefusedNamingEveryRuleItBreaksUnderAnyNamingOfItsChecks:-:0.2.1.3.3.0.2"
				),
				reason:
					"a tuple of three parts beside a rule it breaks, which backward tries after the arity: once refused naming the arity first and no witness, the arity held at the empty family's count",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/laws/outcomes/witness.test.ts#aCellBreakingOneToThreeRulesIsRefusedNamingEveryRuleItBreaksUnderAnyNamingOfItsChecks:-:1.0.0.0.0.0.1"
				),
				reason:
					"the fallback audit's re-insert residual: a stored sum cell inserted again beside a new one of no parts, which its arity and balance refuse, once witnessed by the stored cell judged at an empty family",
				since: "2026-11-19"
			},
			{
				token: ReplayToken(
					"test/pg/laws/outcomes/witness.test.ts#aCellBreakingOneToThreeRulesIsRefusedNamingEveryRuleItBreaksUnderAnyNamingOfItsChecks:-:1.0.0.2.0.1.1.1"
				),
				reason:
					"a stored sum cell inserted again before a new one of one part, which its caller rule and balance refuse: once witnessed under backward by the stored cell judged at an empty family, which breaks the balance there",
				since: "2026-11-19"
			}
		],
		kills: [
			{
				file: "packages/grizzle/src/adapter/witness/classify.ts",
				original:
					"): Arr.NonEmptyReadonlyArray<L> => Arr.sort(laws, (a: L, b: L) => compareCodePoints(a.id, b.id))",
				replacement:
					"): Arr.NonEmptyReadonlyArray<L> => Arr.sort(laws, (a: L, b: L) => compareCodePoints(b.id, a.id))",
				why: "Operator mutant (operands swapped) in adapter/witness/classify.ts byIdentity, where the one canonical order of a refusal's laws is decided (canonicalRefusal; restated from runtime/write/witness.ts brokenLaws's theory-order sort, which 2cf8b4bf1a's canonical order superseded and which is gone): a refusal lists the laws its row breaks against their identities' code point order, so a cell breaking two rules names them out of it, and the property fails."
			}
		]
	})
