/**
 * NULL is a value of grizzle's scalar language wherever it arises, on PostgreSQL 19: a differential search over
 * drawn expressions placed in every position a rule or a query reads one.
 *
 * Each case draws a world of closed relations over two rosters, some keys held by no row (language.ts World), rows of
 * every open relation, and an expression for each position, drawn by construction over every operator family
 * (comparisons, BETWEEN, IN, AND, OR and NOT, exact and IEEE 754 arithmetic, greatest and least, casts, text, sets,
 * range endpoints, conditionals, guards and a closed relation's presence, C.has, false at a key no row holds) over
 * every sort (integers, numerics, texts, closed ids, sets, booleans and
 * both floats, NaN and the infinities among them) and every NULL source (a closed read at an absent key, at a NULL
 * key, nested). Float arithmetic stands in a query alone, as grizzle admits it nowhere else. A span is never NULL, since
 * no closed relation holds one (closed.relation refuses a span field): its endpoints meet a NULL only beside a NULL
 * operand of the node above them. The positions:
 *
 * - three row checks on Checked;
 * - a containment of a selection of Contained into the closed Allowed;
 * - a key over a selection of Keyed, each row written at every kind;
 * - three generated relations, each a generated field of a drawn type and a row check;
 * - a fold, the sum of a family's integers under a drawn selection, filled by grizzle's writer: an owner with every row
 *   nested, a stored owner a member put at a time, and a refill past a deleted member;
 * - a query's filter, an aggregate's filter, keyed and with no key, and a query's head.
 *
 * The oracle is PostgreSQL itself: each expression, written in plain SQL from its meaning alone (closed relations as
 * values, a closed read a scalar subquery), evaluated by one SELECT at every row it is judged at. The model of
 * language.ts (Kleene's logic, strict operations) agrees with it at every row, and so does grizzle's host evaluator over
 * the law model's own expressions: each row check, the containment's guard, the key's selection and each generated
 * field. Through grizzle's writer and reader:
 *
 * - a row is accepted exactly where every law of its relation holds, a check and a selection holding where they are
 *   true; a refused row names exactly the laws it breaks, every check that is false or unknown at it, and a generated
 *   field NULL at it alone, as PostgreSQL checks NOT NULL first;
 * - each stored generated value is PostgreSQL's;
 * - each owner's fold total sums the members its selection makes true;
 * - a filter returns the rows it makes true, an aggregate the groups of those rows and no row where none is, and a head
 *   delivers PostgreSQL's value, or is refused at compile when it reads a closed relation.
 *
 * The generator aims a steered witness at each operator family a NULL operand has not reached in a position yet
 * (steeredCases): its world leaves its last kind absent from Pick, and the position's expression is built around a node
 * of that family over a read at it (language.ts aimedPredGen, aimedStoredGen).
 *
 * Features: every operator family in every position, reached by a NULL operand.
 */
import { type Reached } from "@bjornpagen/testing/features"
import { recorded, steered } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type Feature,
	nullCase,
	situations,
	steeredCases,
	recordedNullCases,
	type NullCase
} from "#test/pg/null/positions.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * NULL in every position is judged by PostgreSQL's three-valued logic in every rule and query, by the host evaluator and the writer alike.
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/null/positions.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/null/positions.test.ts` at its budget before,
 *   `{ runs: 24, steered: 48 }`, each kill's verdict printed with where its witnesses went red (judgedLine with the
 *   red's headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log; this budget run by path
 *   in run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its kill went red on its kept case
 * @decision 1, the least a generative search draws: no declared kill needs a floor or a rotating case; no headroom: a
 *   kill its witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
 */
export const nULLInEveryPositionIsJudgedByPostgreSQLsThreeValuedLogicInEveryRuleAndQueryByTheHostEvaluatorAndTheWriterAlike =
	property.explore(
		steered<NullCase, Feature>((steering) => recorded(steeredCases(steering), recordedNullCases)),
		{
			needs: { substrate: Substrate.fresh(baseSubstrate) },
			situations: situations satisfies ReadonlyArray<Reached<Feature>>,
			check:
				({ substrate }, c: Case<Feature>) =>
				(value) =>
					Effect.provideServiceEffect(
						nullCase(value, c),
						Substrate,
						Effect.map(substrate, (taken) => taken.substrate)
					),
			oracle: {
				kind: "postgresql",
				name: "each expression written in plain SQL from its meaning alone and evaluated by one SELECT at every row it is judged at, with the model of language.ts agreeing; grizzle's host evaluator, writer and reader held to its values"
			},
			budget: { runs: 1, steered: 48 },
			kept: [
				{
					token: ReplayToken(
						"test/pg/null/positions.test.ts#nULLInEveryPositionIsJudgedByPostgreSQLsThreeValuedLogicInEveryRuleAndQueryByTheHostEvaluatorAndTheWriterAlike:-:1"
					),
					reason:
						"a domain that refused NULL: a check or(eq(n, n), eq(subset(Next.row(Pick.at(flag, kind)), flags), true)) holds of a row of kind k1, and a generated set Next.row(Pick.at(flag, kind)) is refused by its NOT NULL, never by the set's domain",
					since: "2026-11-19"
				},
				{
					token: ReplayToken(
						"test/pg/null/positions.test.ts#nULLInEveryPositionIsJudgedByPostgreSQLsThreeValuedLogicInEveryRuleAndQueryByTheHostEvaluatorAndTheWriterAlike:-:2"
					),
					reason:
						"a containment NOT φ OR member: a row outside Allowed whose selection eq(Pick.at(n, kind), n) is unknown is accepted",
					since: "2026-11-19"
				},
				{
					token: ReplayToken(
						"test/pg/null/positions.test.ts#nULLInEveryPositionIsJudgedByPostgreSQLsThreeValuedLogicInEveryRuleAndQueryByTheHostEvaluatorAndTheWriterAlike:-:3"
					),
					reason:
						"a host evaluator that read NULL as unsupported, and a fold CHECK of two-valued logic: a member whose selection eq(Pick.at(n, kind), n) is unknown is filled, skipped, with its owner, into a stored owner and by a refill",
					since: "2026-11-19"
				},
				{
					token: ReplayToken(
						"test/pg/null/positions.test.ts#nULLInEveryPositionIsJudgedByPostgreSQLsThreeValuedLogicInEveryRuleAndQueryByTheHostEvaluatorAndTheWriterAlike:-:4"
					),
					reason:
						"a witness that judged NULL by heuristics: a row whose first check is unknown, second false and third true is refused naming the first two",
					since: "2026-11-19"
				},
				{
					token: ReplayToken(
						"test/pg/null/positions.test.ts#nULLInEveryPositionIsJudgedByPostgreSQLsThreeValuedLogicInEveryRuleAndQueryByTheHostEvaluatorAndTheWriterAlike:-:5"
					),
					reason:
						"a generated field NULL at a row judged against its table's CHECKs: Pick.at(n, kind) at k1 beside a false check is refused naming the generated field alone",
					since: "2026-11-19"
				},
				{
					token: ReplayToken(
						"test/pg/null/positions.test.ts#nULLInEveryPositionIsJudgedByPostgreSQLsThreeValuedLogicInEveryRuleAndQueryByTheHostEvaluatorAndTheWriterAlike:-:6"
					),
					reason:
						'a comparison over a concatenation decided by lengths, a prefix and a suffix: ne(concat(Pick.at(t, kind), "b"), t) is unknown at k1 for t empty, so the row check refuses the row and the containment\'s selection leaves it out',
					since: "2026-11-19"
				},
				{
					token: ReplayToken(
						"test/pg/null/positions.test.ts#nULLInEveryPositionIsJudgedByPostgreSQLsThreeValuedLogicInEveryRuleAndQueryByTheHostEvaluatorAndTheWriterAlike:-:7"
					),
					reason:
						'a generated field comparing texts that read no row field: cond(eq(Pick.at(t, k1), "a"), n, m), a constant comparison in a generation expression, installs and takes its else where Pick holds no row at k1',
					since: "2026-11-19"
				},
				{
					token: ReplayToken(
						"test/pg/null/positions.test.ts#nULLInEveryPositionIsJudgedByPostgreSQLsThreeValuedLogicInEveryRuleAndQueryByTheHostEvaluatorAndTheWriterAlike:-:8"
					),
					reason:
						"a closed read with no bound: a generated integer narrowing mul(n, Pick.at(n, kind)) under Num.within and a generated bigint casting add(n, Pick.at(n, kind)) compile, the first taking its otherwise at k1 and the second refused by its NOT NULL",
					since: "2026-11-19"
				},
				{
					token: ReplayToken(
						"test/pg/null/positions.test.ts#nULLInEveryPositionIsJudgedByPostgreSQLsThreeValuedLogicInEveryRuleAndQueryByTheHostEvaluatorAndTheWriterAlike:40000000000000000.42:0.0.1.2.0.0.1.0.0.0.1.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.1.2.0.0.0.0.1.0.0.0.0.0.1.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.1.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.1.0.1.3.0.0.0.0.0.0.0.0.0.0.1.3.0.1.1.0.1.0.0.1.0.1.0.1.0.0.0.1.0.0.8.1.2.0.0.0.0"
					),
					reason:
						"a head neg(0.0::float8), which PostgreSQL computes as -0 and grizzle delivers as -0, a value of its own: the model read every float zero as 0 and refused a delivered -0 (trunk's pg tier at f1bf91a2f, seed 2219874524, the steered phase's case 39)",
					since: "2026-11-21"
				}
			],
			kills: [
				{
					file: "packages/engine/src/scalar/values/float.ts",
					original: "export const convertDouble = (text: string): number => Number(text)",
					replacement: "export const convertDouble = (text: string): number => Number(text) + 0",
					why: "A delivered double's -0 is read as 0, the zero a value of its own is no spelling of: the head neg(0.0::float8) PostgreSQL computes as -0 is delivered as 0, and the property fails."
				}
			]
		}
	)
