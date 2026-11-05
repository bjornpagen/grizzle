/**
 * The platform shape on PostgreSQL 19rc1 (rows-first §8): a credit debit is a member of two counted families at once,
 * its usage charge's (`counted(on(CreditDebit, "event", "kind"), fin(UsageCharge, "debits"))`) and its credit grant's
 * (`counted(on(CreditDebit, "grant"), fin(CreditGrant, "spends"))`), each folded by a sum of its amounts and bounded by a
 * check: a charge never negative, a grant never spent past its cap. Two spenders of one grant run the planner's
 * statements for a debit each, under every interleaving: the read flight of the grant's count and sum, a new charge,
 * the grant's count and sum update, and the debit's insert with both families' hidden index, copy and accumulators.
 *
 * - **The interleaving model:** two spenders whose spans overlap cannot both commit, the later one meets 40001 and
 *   nothing retries it; one after the other, the second commits when the cap holds its amount too and is refused by
 *   the cap's CHECK (23514) at the grant's update when it does not. Every committed state holds the cap, and the grant's
 *   sum is the initial debit's amount plus each committed spender's.
 * - **Two caps:** one that holds both spenders, and one that holds either alone, so the bound's refusal is reached.
 * - **Every interleaving** (the library's interleave, `every`; no two moves commute, every order runs).
 */
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, String as Str } from "effect"
import { accumulated, drawn, natural, pg } from "#compiler/public/fields.ts"
import { check, counted, fin, fold, Monoid, on, relation, schema } from "#compiler/public/schema.ts"
import { cleared, seatOf } from "#test/pg/fin/installed.ts"
import { assert } from "#test/support/assert.ts"
import { openActors } from "#test/support/schedules/actors.ts"
import {
	allowed,
	every,
	everyRelation,
	exploreEnv,
	exploreInterleavings,
	type Interleaving,
	interleaveStep,
	type Judgment,
	refusedJudgment,
	runawayInterleavings,
	type Txn
} from "#test/support/schedules/interleave.ts"
import { describeStepOutcome } from "#test/support/schedules/match.ts"
import { attempt } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const UsageCharge = relation(
	"UsageCharge",
	{ event: pg.int4, kind: pg.int4, debits: drawn(natural), charged: accumulated(pg.int8, 0n) },
	["event", "kind"]
)
const CreditGrant = relation(
	"CreditGrant",
	{ id: pg.int4, cap: pg.int8, spends: drawn(natural), spent: accumulated(pg.int8, 0n) },
	["id"]
)
const CreditDebit = relation(
	"CreditDebit",
	{ id: pg.int4, event: pg.int4, kind: pg.int4, grant: pg.int4, amount: pg.int8 },
	["id"]
)
const perCharge = counted(on(CreditDebit, "event", "kind"), fin(UsageCharge, "debits"))
const perGrant = counted(on(CreditDebit, "grant"), fin(CreditGrant, "spends"))

const Platform = schema("fin_platform", { UsageCharge, CreditGrant, CreditDebit }, [
	perCharge,
	perGrant,
	fold(
		perCharge,
		Monoid.sum,
		on(CreditDebit, "event", "kind", "amount"),
		on(UsageCharge, "event", "kind", "charged")
	),
	fold(perGrant, Monoid.sum, on(CreditDebit, "grant", "amount"), on(CreditGrant, "id", "spent")),
	check("Charged", UsageCharge, (c) => c.ge(c.charged, 0n)),
	check("WithinCap", CreditGrant, (g) => g.le(g.spent, g.cap))
])

const RELATIONS = ["UsageCharge", "CreditGrant", "CreditDebit"] as const

const SPENDERS = ["first", "second"] as const

/** The grant's one debit before every run, and each spender's amount. */
const amounts = { initial: 3, first: 4, second: 5 } as const

/** The caps: one that holds both spenders, and one that holds either alone. */
const CAPS = [
	{ label: "both fit", cap: 12 },
	{ label: "one fits", cap: 9 }
] as const

layer(Substrate.layer, { excludeTestServices: true })(
	"two spenders of one grant on PostgreSQL 19rc1",
	(it) => {
		for (const { label, cap } of CAPS) {
			it.effect(
				`in every interleaving two spenders of one grant meet 40001 once when they overlap, and the cap holds (${label})`,
				() =>
					Effect.gen(function* () {
						const s = yield* Substrate
						const seat = yield* seatOf(Platform, RELATIONS, `platform ${label}`)
						const c = (relation: string, role: string) => seat.column(relation, role)
						const charge = seat.table("UsageCharge")
						const grant = seat.table("CreditGrant")
						const debit = seat.table("CreditDebit")
						const debitColumns = Arr.join(
							Arr.map(
								[
									"id",
									"event",
									"kind",
									"grant",
									"amount",
									"‹i@debits›",
									"‹n@debits›",
									"‹before 0.0@debits›",
									"‹after 0.0@debits›",
									"‹i@spends›",
									"‹n@spends›",
									"‹before 0.0@spends›",
									"‹after 0.0@spends›"
								],
								(r) => c("CreditDebit", r)
							),
							", "
						)
						/** A spender's plan for one debit of `amount` on a new charge `event`, as the planner sends it. */
						const plan = (id: number, event: number, amount: number): ReadonlyArray<string> => [
							`SELECT ${c("CreditGrant", "spends")}, ${c("CreditGrant", "spent")} FROM ${grant} WHERE ${c("CreditGrant", "id")} = 0`,
							`INSERT INTO ${charge} (${c("UsageCharge", "event")}, ${c("UsageCharge", "kind")}, ${c("UsageCharge", "debits")}, ${c("UsageCharge", "charged")}) VALUES (${event}, 0, 1, ${amount})`,
							`UPDATE ${grant} SET ${c("CreditGrant", "spends")} = ${c("CreditGrant", "spends")} + 1, ${c("CreditGrant", "spent")} = ${c("CreditGrant", "spent")} + ${amount} WHERE ${c("CreditGrant", "id")} = 0`,
							`INSERT INTO ${debit} (${debitColumns}) SELECT ${id}, ${event}, 0, 0, ${amount}, 0, 1, 0, ${amount}, ${c("CreditGrant", "spends")} - 1, ${c("CreditGrant", "spends")}, ${c("CreditGrant", "spent")} - ${amount}, ${c("CreditGrant", "spent")} FROM ${grant} WHERE ${c("CreditGrant", "id")} = 0`
						]
						const txns: ReadonlyArray<Txn> = Arr.map(SPENDERS, (session, i): Txn => ({
							kind: "direct",
							session,
							steps: Arr.map(plan(10 + i, 200 + i, amounts[session]), (sql) =>
								interleaveStep(sql, everyRelation)
							),
							end: "commit",
							after: undefined
						}))
						const reset = Effect.gen(function* () {
							yield* cleared(seat, RELATIONS)
							const written = yield* attempt(seat.session, [
								`INSERT INTO ${grant} (${c("CreditGrant", "id")}, ${c("CreditGrant", "cap")}, ${c("CreditGrant", "spends")}, ${c("CreditGrant", "spent")}) VALUES (0, ${cap}, 1, ${amounts.initial})`,
								`INSERT INTO ${charge} (${c("UsageCharge", "event")}, ${c("UsageCharge", "kind")}, ${c("UsageCharge", "debits")}, ${c("UsageCharge", "charged")}) VALUES (100, 0, 1, ${amounts.initial})`,
								`INSERT INTO ${debit} (${debitColumns}) VALUES (1, 100, 0, 0, ${amounts.initial}, 0, 1, 0, ${amounts.initial}, 0, 1, 0, ${amounts.initial})`
							])
							assert.equal(
								written.kind,
								"committed",
								`the initial grant is written: ${Formatter.format(written)}`
							)
						}).pipe(Effect.orDie)
						const judge = (run: Interleaving): Judgment => {
							const span = (w: string) => Option.fromUndefinedOr(run.spans[w])
							const [a, b] = [span("first"), span("second")]
							if (Option.isNone(a) || Option.isNone(b)) {
								return refusedJudgment("a spender never ran")
							}
							const overlapped = a.value.start < b.value.end && b.value.start < a.value.end
							const results = Rec.values(run.results)
							const committed = Arr.filter(results, (r) => r._tag === "Committed")
							const failed = Arr.filter(results, (r) => r._tag === "Failed")
							const codeOf = (r: (typeof failed)[number]) =>
								r.failure._tag === "PgError"
									? r.failure.fields.code
									: describeStepOutcome(r.failure)
							if (overlapped) {
								const [loser] = failed
								if (
									committed.length !== 1 ||
									loser === undefined ||
									failed.length !== 1 ||
									codeOf(loser) !== "40001"
								) {
									return refusedJudgment(
										`overlapping spenders: ${committed.length} committed and ${Arr.join(Arr.map(failed, codeOf), ", ")} failed, where one commits and one meets 40001`
									)
								}
							} else {
								const fits = amounts.initial + amounts.first + amounts.second <= cap
								const ok = fits
									? committed.length === 2
									: committed.length === 1 &&
										failed.length === 1 &&
										Arr.every(failed, (r) => codeOf(r) === "23514")
								if (!ok) {
									return refusedJudgment(
										`spenders one after the other: ${committed.length} committed and ${Arr.join(Arr.map(failed, codeOf), ", ")} failed, where ${fits ? "both commit" : "the second meets the cap's 23514"}`
									)
								}
							}
							if (run.state._tag !== "Read") {
								return refusedJudgment("the grant was not read")
							}
							const [row] = run.state.rows
							const spent = Number(row?.[0])
							const want =
								amounts.initial +
								Arr.reduce(
									run.commits,
									0,
									(sum, w) => sum + (w === "first" ? amounts.first : amounts.second)
								)
							return spent === want && spent <= cap
								? allowed
								: refusedJudgment(
										`the grant's sum reads ${spent}, not ${want} within its cap ${cap}`
									)
						}
						const env = yield* exploreEnv(s)
						const direct = yield* openActors(s, {
							first: { kind: "raw", as: s.owner },
							second: { kind: "raw", as: s.owner }
						})
						const report = yield* exploreInterleavings(
							env,
							{ direct, grizzle: {} },
							{
								name: `two spenders of one grant (${label})`,
								txns,
								reset,
								state: {
									_tag: "Read",
									sql: `SELECT ${c("CreditGrant", "spent")}::text FROM ${grant} WHERE ${c("CreditGrant", "id")} = 0`
								},
								model: (run) => Effect.sync(() => judge(run)),
								maxInterleavings: runawayInterleavings
							},
							every
						)
						assert.ok(
							report.blocked > 0,
							`of ${report.interleavings} interleavings none blocked on the grant's row`
						)
						assert.ok(
							Arr.some([...report.committedSets.keys()], Str.includes(",")) ===
								amounts.initial + amounts.first + amounts.second <= cap,
							`both spenders committed in some interleaving exactly when the cap holds both: ${Formatter.format([...report.committedSets])}`
						)
					})
			)
		}
	}
)
