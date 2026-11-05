/**
 * Two SERIALIZABLE writers to one owner's family, every interleaving (W5.SC, fin.md §4.5's current count): each writer
 * runs the planner's three statements for an append to owner 0's ordered family, the count read, the count update
 * and the member insert at the slot the count gives, then COMMIT, on grizzle's installed lowering. The count update is
 * what makes two writers to one owner conflict: two that overlap in time cannot both commit, the later one meets 40001
 * (a concurrent update of the owner's row, or a key conflict with a row its snapshot cannot see), and nothing retries
 * it; two that do not overlap both commit, the second appending after the first.
 *
 * - **The interleaving model:** a run is allowed exactly when, if the two writers' spans overlap, one committed and the
 *   other failed with 40001 at its count update, its insert or its COMMIT, its outcomes ending at that failure; and if
 *   they do not, both committed. Either way the state read back holds the families theorem (theorem.ts) and every
 *   committed append, in commit order.
 * - **Every interleaving** of the two four-move transactions (the library's interleave, `every`, its statements all on
 *   the family's relations, so no two moves commute and every order runs).
 */
import { layer } from "@effect/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import { familySeat, familyStoredOf, storedSql } from "#test/pg/fin/family.ts"
import { cleared } from "#test/pg/fin/installed.ts"
import { assert, deepEquals } from "#test/support/assert.ts"
import { theorem } from "#test/support/families/theorem.ts"
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

const WRITERS = ["first", "second"] as const

/** Owner 0's family before every run: one member, at slot 0. */
const INITIAL = { members: [0] } as const

layer(Substrate.layer, { excludeTestServices: true })(
	"two SERIALIZABLE writers to one owner's family through grizzle's lowering",
	(it) => {
		it.effect(
			"in every interleaving of two appends' count read, count update and insert, overlapping writers meet 40001 once and nothing retries, and writers one after the other both commit",
			() =>
				Effect.gen(function* () {
					const s = yield* Substrate
					const f = yield* familySeat("ordered", "contention")
					const { seat } = f
					const c = (relation: string, role: string) => seat.column(relation, role)
					const owner = seat.table("Owner")
					const member = seat.table("Member")
					const plan = (m: number): ReadonlyArray<string> => [
						`SELECT ${c("Owner", "n")} FROM ${owner} WHERE ${c("Owner", "id")} = 0`,
						`UPDATE ${owner} SET ${c("Owner", "n")} = ${c("Owner", "n")} + 1 WHERE ${c("Owner", "id")} = 0`,
						`INSERT INTO ${member} (${c("Member", "member")}, ${c("Member", "g")}, ${c("Member", "at")}, ${c("Member", "‹n›")}) SELECT ${m}, 0, ${c("Owner", "n")} - 1, ${c("Owner", "n")} FROM ${owner} WHERE ${c("Owner", "id")} = 0`
					]
					const txns: ReadonlyArray<Txn> = Arr.map(WRITERS, (session, i): Txn => ({
						kind: "direct",
						session,
						steps: Arr.map(plan(10 + i), (sql) => interleaveStep(sql, everyRelation)),
						end: "commit",
						after: undefined
					}))
					const reset = Effect.gen(function* () {
						yield* cleared(seat, ["Owner", "Member"])
						const written = yield* attempt(seat.session, [
							`INSERT INTO ${owner} (${c("Owner", "id")}, ${c("Owner", "n")}) VALUES (0, ${INITIAL.members.length})`,
							`INSERT INTO ${member} (${c("Member", "member")}, ${c("Member", "g")}, ${c("Member", "at")}, ${c("Member", "‹n›")}) VALUES (0, 0, 0, ${INITIAL.members.length})`
						])
						assert.equal(written.kind, "committed", "the initial family is written")
					}).pipe(Effect.orDie)
					const judge = (run: Interleaving): Judgment => {
						const span = (w: string) => Option.fromUndefinedOr(run.spans[w])
						const [a, b] = [span("first"), span("second")]
						if (Option.isNone(a) || Option.isNone(b)) {
							return refusedJudgment("a writer never ran")
						}
						const overlapped = a.value.start < b.value.end && b.value.start < a.value.end
						const results = Rec.values(run.results)
						const committed = Arr.filter(results, (r) => r._tag === "Committed")
						const failed = Arr.filter(results, (r) => r._tag === "Failed")
						if (overlapped) {
							const [loser] = failed
							if (committed.length !== 1 || loser === undefined || failed.length !== 1) {
								return refusedJudgment(
									`overlapping writers: ${committed.length} committed, ${failed.length} failed, where one must commit and one meet 40001`
								)
							}
							if (loser.failure._tag !== "PgError" || loser.failure.fields.code !== "40001") {
								return refusedJudgment(
									`the losing writer failed with ${describeStepOutcome(loser.failure)}, not 40001`
								)
							}
						} else if (committed.length !== 2) {
							return refusedJudgment(
								`writers one after the other: ${committed.length} committed, where both must: ${Arr.join(
									Arr.map(failed, (r) => `${r.session} ${describeStepOutcome(r.failure)}`),
									"; "
								)}`
							)
						}
						if (run.state._tag !== "Read") {
							return refusedJudgment("the family was not read")
						}
						const read = theorem(familyStoredOf(run.state.rows))
						if (Result.isFailure(read)) {
							return refusedJudgment(
								`the committed state breaks the families theorem: ${Formatter.format(read.failure)}`
							)
						}
						const appended = Arr.map(run.commits, (w) => (w === "first" ? 10 : 11))
						const want = [...INITIAL.members, ...appended]
						const got = Arr.flatMap(read.success, (fam) => (fam.owner === 0 ? fam.members : []))
						return deepEquals(got, want)
							? allowed
							: refusedJudgment(
									`owner 0's family reads ${Formatter.format(got)}, not its committed appends in order, ${Formatter.format(want)}`
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
							name: "two appends to one owner's family",
							txns,
							reset,
							state: { _tag: "Read", sql: storedSql(f) },
							model: (run) => Effect.sync(() => judge(run)),
							maxInterleavings: runawayInterleavings
						},
						every
					)
					assert.ok(
						report.blocked > 0,
						`of ${report.interleavings} interleavings none blocked on the owner's row`
					)
					assert.ok(
						Arr.some([...report.committedSets.keys()], Str.includes(",")),
						`some interleaving committed both writers: ${Formatter.format([...report.committedSets])}`
					)
				})
		)
	}
)
