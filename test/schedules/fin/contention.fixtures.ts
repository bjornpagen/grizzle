import { assert, deepEquals, defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Formatter, Record as Rec, Result } from "effect"
import { openServed } from "#adapter/db/served.ts"
import { type TransientTag } from "#compiler/core/errors.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { drawn, natural, int4 } from "#compiler/public/fields.ts"
import {
	counted,
	fin,
	login,
	mutable,
	on,
	relation,
	role,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import { theorem } from "#test/support/families/theorem.ts"
import { type Generated } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { familyStoredOf } from "#test/support/pg/fin/family.ts"
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
	type Txn
} from "#test/support/schedules/interleave.ts"
import { describeStepOutcome } from "#test/support/schedules/match.ts"
import { rigIn, rigTemplate } from "#test/support/schedules/rig.ts"
import { beginSerializableAction } from "#test/support/schedules/types.ts"
import { Substrate, type SubstrateCase } from "#test/support/substrate/substrate.ts"

const Owner = relation("Owner", { id: int4, n: drawn(natural) }, ["id"])
const Member = relation("Member", { member: int4, g: int4 }, ["member"])

/**
 * The family under a schema name, with a role `app` the grizzle writer opens, whose login's workload holds the empty
 * ChangeSet its first call applies and the append of the members each call gives, and a role `direct` the direct
 * writer's.
 */
const contended = (name: string) => {
	const relations = { Owner, Member }
	const base = schema(name, Rec.values(relations), [
		unit("Owner", { id: int4 }),
		mutable(Owner),
		counted(on(Member, "g"), fin(Owner, "n"))
	])
	const app = role(base, "app", relations, { insert: ["Member"], write: ["Owner"] })
	const direct = role(base, "direct", relations, { insert: ["Member"], write: ["Owner"] })
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

/** The schedule's installation made once per member (support/schedules/rig.ts rigTemplate), which each case's seat holds. */
export const contendedRig = rigTemplate(import.meta, "fin contention", contended)

/**
 * Every interleaving of the direct writer's append and the grizzle writer's over the case's clone of the rig (`taken`),
 * each held to the interleaving model; some block, some refuse the grizzle write and run it again, and some commit both.
 */
export const contentionCase = (taken: SubstrateCase<Generated>) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const rig = yield* rigIn(taken, contended)
		const names = namesOf(rig.installed)
		const family = defined(names.model.families[0], "the family")
		const owner = names.table(Owner)
		const member = names.table(Member)
		const id = names.column(Owner, "id")
		const n = names.column(Owner, "n")
		const m = names.column(Member, "member")
		const g = names.column(Member, "g")
		const at = quoteIdent(
			family.shape.kind === "counted"
				? family.shape.index.column
				: names.columnIdent({ name: "Member" }, family.shape.index.field.name)
		)
		const next = quoteIdent(family.next)
		const app = yield* rig.servedWriter(
			"app",
			(context) => openServed(rig.served.roles.app, {}).pipe(Effect.provideContext(context)),
			(db) => writeAnswerOf(db.workload.noop.once({ params: {}, facts: {} }))
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
				begin: beginSerializableAction,
				session: "direct",
				steps: Arr.map(
					[
						`SELECT ${n} FROM ${owner} WHERE ${id} = 0`,
						`UPDATE ${owner} SET ${n} = ${n} + 1 WHERE ${id} = 0`,
						`UPDATE ${member} SET ${next} = ${at} + 1 WHERE ${g} = 0 AND ${at} = (SELECT ${n} - 2 FROM ${owner} WHERE ${id} = 0)`,
						`INSERT INTO ${member} (${m}, ${g}, ${at}, ${next}) SELECT ${DIRECT}, 0, ${n} - 1, ${n} - 1 FROM ${owner} WHERE ${id} = 0`
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
								writeAnswerOf,
								untilAnswered,
								Effect.result,
								Effect.tap((r) =>
									Effect.sync(() => {
										ran = Result.isSuccess(r)
											? Result.succeed({
													refused: r.success.refused,
													answer: r.success.answered._tag
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
				`INSERT INTO ${member} (${m}, ${g}, ${at}, ${next}) VALUES (0, 0, 0, 0)`
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
					sql: `SELECT 0, ${id}::int8, ${n}::int8, 0::int8, 0::int8 FROM ${owner} UNION ALL SELECT 1, ${m}::int8, ${g}::int8, ${at}::int8, ${next}::int8 FROM ${member}`
				},
				model: (run) => Effect.sync(() => judge(run))
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
