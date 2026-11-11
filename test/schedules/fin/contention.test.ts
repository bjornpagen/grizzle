/**
 * Two SERIALIZABLE writers appending to one stored owner's family, every interleaving: a direct writer running the
 * direct-writer protocol for an append to owner 0's counted family (the count read, the count update, and the member
 * insert at the slot the count gives, then COMMIT), and a grizzle writer applying a ChangeSet that inserts a member of
 * owner 0, run again after each TransientFailure until it answers, as an application runs it. Either append is lawful
 * before or after the other.
 *
 * - **The interleaving model:** a run is allowed exactly when the grizzle write answers accepted, every
 *   TransientFailure it met a SerializationFailure, never a refusal by the family's (group, index) key both writers
 *   drew from their snapshots; the direct writer commits, or fails with 40001 where the grizzle write committed inside
 *   its span; and the state read back holds the families theorem (theorem.ts), owner 0's family holding its first
 *   member and then every committed append in commit order.
 * - **Every interleaving** of the direct writer's four moves and the grizzle write's one (the library's interleave,
 *   `every`, every move on the family's relations, so no two moves commute and every order runs), some of which block
 *   the grizzle write on the owner row the direct writer updated, and run it again once that commits.
 *
 * Plant: ~/.cache/grizzle-release/BR08/plants/fin-scale-owner-axis-no-cascade.patch, the owner axis installed with no
 * action, refuses every append's count update and must turn the property red.
 */
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { openServed } from "#adapter/db/served.ts"
import type { TransientTag } from "#compiler/core/errors.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { drawn, natural, pg } from "#compiler/public/fields.ts"
import {
	counted,
	fin,
	login,
	mutable,
	on,
	relation,
	role,
	schema
} from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { familyStoredOf } from "#test/pg/fin/family.ts"
import { assert, deepEquals, defined } from "#test/support/assert.ts"
import { answered } from "#test/support/calls.ts"
import { theorem } from "#test/support/families/theorem.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { openActors } from "#test/support/schedules/actors.ts"
import { untilAnswered } from "#test/support/schedules/grizzle.ts"
import {
	allowed,
	every,
	everyRelation,
	exploreInterleavings,
	type Interleaving,
	interleaveStep,
	type Judgment,
	opStep,
	refusedJudgment,
	runawayInterleavings,
	type Txn
} from "#test/support/schedules/interleave.ts"
import { describeStepOutcome } from "#test/support/schedules/match.ts"
import { openRig } from "#test/support/schedules/rig.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const Owner = relation("Owner", { id: pg.int4, n: drawn(natural) }, ["id"])
const Member = relation("Member", { member: pg.int4, g: pg.int4 }, ["member"])

/**
 * The family under a schema name, with a role `app` the grizzle writer opens, whose login's workload holds the empty
 * ChangeSet its first call applies and the append of the members each call gives, and a role `direct` the direct
 * writer's.
 */
const contended = (name: string) => {
	const relations = { Owner, Member }
	const base = schema(name, relations, [mutable(Owner), counted(on(Member, "g"), fin(Owner, "n"))])
	const app = role(base, "app", relations, { write: ["Owner", "Member"] })
	const direct = role(base, "direct", relations, { write: ["Owner", "Member"] })
	return {
		schema: base,
		app,
		direct,
		server: login(base, "server", [app], {
			workload: [
				workload(app, {
					noop: ChangeSet.empty(base),
					append: ChangeSet.empty(base).insert(Member, [])
				})
			]
		}),
		psql: login(base, "psql", [direct])
	}
}

/** The one TransientFailure reason a concurrent append to the group may meet: the owner's row, updated by the other. */
const serializationFailure: TransientTag = "SerializationFailure"

/** The direct writer's member and the grizzle writer's. */
const DIRECT = 10
const GRIZZLE = 11

layer(Substrate.layer, { excludeTestServices: true })(
	"a direct writer and a grizzle writer appending to one stored owner's family",
	(it) => {
		it.effect(
			"in every interleaving the grizzle write is accepted, its only refusals serialization failures, and both appends are stored at distinct slots in commit order",
			() =>
				Effect.gen(function* () {
					const s = yield* Substrate
					const rig = yield* openRig(contended)
					const names = namesOf(rig.installed)
					const family = defined(names.model.families[0], "the family")
					const owner = names.table(Owner)
					const member = names.table(Member)
					const id = names.column(Owner, "id")
					const n = names.column(Owner, "n")
					const m = names.column(Member, "member")
					const g = names.column(Member, "g")
					const at = quoteIdent(
						family.index.kind === "law"
							? family.index.column
							: names.columnIdent({ name: "Member" }, family.index.field.name)
					)
					const copy = quoteIdent(family.copy)
					const app = yield* rig.servedWriter(
						"app",
						(context) => openServed(rig.served.roles.app, {}).pipe(Effect.provideContext(context)),
						(db) => answered(db.workload.noop.once({ params: {}, facts: {} }))
					)
					const direct = yield* openActors(s, { direct: { kind: "raw", as: rig.direct } })
					/** The grizzle write's refusals and answer in the current run, set by its move. */
					let ran:
						| Result.Result<
								{ readonly refused: ReadonlyArray<TransientTag>; readonly answer: string },
								string
						  >
						| undefined
					const txns: ReadonlyArray<Txn> = [
						{
							kind: "direct",
							session: "direct",
							steps: Arr.map(
								[
									`SELECT ${n} FROM ${owner} WHERE ${id} = 0`,
									`UPDATE ${owner} SET ${n} = ${n} + 1 WHERE ${id} = 0`,
									`INSERT INTO ${member} (${m}, ${g}, ${at}, ${copy}) SELECT ${DIRECT}, 0, ${n} - 1, ${n} FROM ${owner} WHERE ${id} = 0`
								],
								(sql) => interleaveStep(sql, everyRelation)
							),
							end: "commit",
							after: undefined
						},
						{
							kind: "grizzle",
							session: "app",
							steps: [
								opStep(
									"the grizzle append",
									app.db.workload.append
										.once({
											params: {},
											facts: { insert: { Member: [{ member: GRIZZLE, g: 0 }] } }
										})
										.pipe(
											answered,
											untilAnswered,
											Effect.result,
											Effect.tap((r) =>
												Effect.sync(() => {
													ran = Result.isSuccess(r)
														? Result.succeed({
																refused: r.success.refused,
																answer: r.success.answered.kind
															})
														: Result.fail(r.failure.message)
												})
											)
										),
									everyRelation
								)
							],
							after: undefined
						}
					]
					const reset = Effect.andThen(
						Effect.sync(() => {
							ran = undefined
						}),
						rig.replace([
							`INSERT INTO ${owner} (${id}, ${n}) VALUES (0, 1)`,
							`INSERT INTO ${member} (${m}, ${g}, ${at}, ${copy}) VALUES (0, 0, 0, 1)`
						])
					).pipe(Effect.orDie)
					/** Runs in which the grizzle write was refused by a TransientFailure and ran again. */
					let retried = 0
					/** Runs in which both writers committed. */
					let bothCommitted = 0
					const judge = (run: Interleaving): Judgment => {
						if (ran === undefined) {
							return refusedJudgment("the grizzle write made no move")
						}
						if (Result.isFailure(ran)) {
							return refusedJudgment(`the grizzle write failed: ${ran.failure}`)
						}
						const { refused, answer } = ran.success
						if (answer !== "accepted") {
							return refusedJudgment(
								`the grizzle write answered ${answer} after refusals [${Arr.join(refused, ", ")}], where its append is lawful in either order`
							)
						}
						const other = Arr.filter(refused, (r) => r !== serializationFailure)
						if (Arr.isReadonlyArrayNonEmpty(other)) {
							return refusedJudgment(
								`the grizzle write was refused by ${Arr.join(other, ", ")}, where only a serialization failure meets a concurrent append`
							)
						}
						if (refused.length > 0) {
							retried += 1
						}
						const result = defined(run.results["direct"], "the direct writer's result")
						const span = (w: string) => defined(run.spans[w], `${w}'s span`)
						const [d, a] = [span("direct"), span("app")]
						if (result._tag === "Failed") {
							const inside = d.start < a.end && a.end < d.end
							if (
								result.failure._tag !== "PgError" ||
								result.failure.fields.code !== "40001" ||
								!inside
							) {
								return refusedJudgment(
									`the direct writer failed with ${describeStepOutcome(result.failure)}, where only 40001 inside a grizzle commit's span is allowed`
								)
							}
						} else if (result._tag !== "Committed") {
							return refusedJudgment(`the direct writer ended ${result._tag}`)
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
						if (Arr.contains(run.commits, "direct") && Arr.contains(run.commits, "app")) {
							bothCommitted += 1
						}
						const want = [0, ...Arr.map(run.commits, (w) => (w === "direct" ? DIRECT : GRIZZLE))]
						const got = Arr.flatMap(read.success, (f) => (f.owner === 0 ? f.members : []))
						return deepEquals(got, want)
							? allowed
							: refusedJudgment(
									`owner 0's family reads ${Formatter.format(got)}, not its committed appends in order, ${Formatter.format(want)}`
								)
					}
					const report = yield* exploreInterleavings(
						rig.env,
						{ direct, grizzle: { app: app.actor } },
						{
							name: "a direct and a grizzle append to one owner's family",
							txns,
							reset,
							state: {
								_tag: "Read",
								sql: `SELECT 0, ${id}::int8, ${n}::int8, 0::int8, 0::int8 FROM ${owner} UNION ALL SELECT 1, ${m}::int8, ${g}::int8, ${at}::int8, ${copy}::int8 FROM ${member}`
							},
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
						retried > 0,
						`of ${report.interleavings} interleavings none refused the grizzle write and ran it again`
					)
					assert.ok(
						bothCommitted > 0,
						`of ${report.interleavings} interleavings none committed both writers`
					)
				})
		)
	}
)
