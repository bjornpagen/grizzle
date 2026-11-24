/**
 * A single statement's shapes write, judge and capture as its whole statement does, and an empty part fires nothing
 * (runtime/write/parted.ts), on PostgreSQL 19: a call sends the parts its inputs may give rows, and the rows it
 * stores, its outcome, the judge's verdict at COMMIT and the rows its captures hold are the whole statement's; and its
 * session stands up the judge's deltas of every relation the write writes before its first call, whatever parts that
 * call sends (adapter/apply/stand-up.ts), so no call makes a delta.
 *
 * The box: H, a header from a scalar parameter; three sidecars S1, S2, S3 from the relation parameters p1, p2, p3; G
 * from a union of one rule over p1 and one over p2; each sidecar's and G's nonnegative values lie in a header, a whole
 * rule the judge reads at COMMIT over the relation's delta. A case draws each parameter's facts, none to two, a
 * read-back of S1's added facts riding the statement or none, and whether p2's facts name a header no call writes,
 * which the judge refuses. Each case runs the call twice on a fresh clone, each through a Db of its own, under two
 * headers: first as served, the statement sent by its parts, then with every single statement sent whole whatever its
 * call's inputs give, every unit of its form assembled, as every call sent it before a statement was parted.
 *
 * The oracle is the whole statement (a second implementation): the stored rows of each header, the outcome and its
 * verdict, the read-back's rows and the counts are the whole statement's under its own header; by the box, each
 * sidecar stores its parameter's facts where the call commits and none where the judge refuses it, which no second
 * implementation decides, since the whole statement's units are the parts' own; and by the rule, the
 * deltas each call's session holds are those of every relation the write writes, S1, S2, S3 and G, its stand-up's,
 * whatever parts it sent and whether the judge refused or not, the stand-up having committed before the call
 * (physical/ddl/rules.ts addStandUps). A part the rider keeps over an empty parameter is sent and writes no row.
 *
 * Features: a part left out, every part sent, no sidecar sent, a rider keeping S1 whose parameter is empty, a refusal
 * at COMMIT.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result, String as Str } from "effect"
import { changeApplication, variantOf } from "#adapter/db/handles.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import {
	boxGen,
	changesOf,
	G,
	heldDeltas,
	Lab,
	labInstall,
	labTemplate,
	noFacts,
	paramsOf,
	S1,
	S2,
	S3,
	wholeChange
} from "#test/pg/write/parted/parted.fixtures.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

type Situation =
	| "a part left out"
	| "every part sent"
	| "no sidecar sent"
	| "a rider keeping S1 whose parameter is empty"
	| "a refusal at COMMIT"

const shaped = "00000000-0000-7000-8000-000000000001"
const whole = "00000000-0000-7000-8000-000000000002"

/** A value's text with either header spelled `H`, so two calls under their own headers compare. */
const unheadered = (value: unknown): string =>
	Str.replaceAll(whole, "H")(Str.replaceAll(shaped, "H")(Formatter.format(value)))

/** A single statement's shapes write, judge and capture as its whole statement does, and an empty part fires nothing. */
export const aSingleStatementsShapesWriteJudgeAndCaptureAsItsWholeStatementDoesAndAnEmptyPartFiresNothing =
	property.exhaust(finite(boxGen), {
		box: "H, three sidecars from p1, p2 and p3, G over p1 and p2, each judged into H at COMMIT, each parameter none to two facts, a rider of S1's added facts or none, p2's facts naming another header or not",
		needs: { lab: Substrate.fresh(labTemplate) },
		situations: [
			"a part left out",
			"every part sent",
			"no sidecar sent",
			"a rider keeping S1 whose parameter is empty",
			"a refusal at COMMIT"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check:
			({ lab }, c: Case<Situation>) =>
			(box) =>
				Effect.scoped(
					Effect.gen(function* () {
						const seat = yield* lab
						const opened = yield* openedIn(Lab, noFacts, labInstall, seat)
						const admin = seat.substrate.admin
						const names = namesOf(opened.installed)
						const changes = changesOf(box.rider)
						const run = (header: string, sentWhole: boolean) =>
							withServedDb(opened.installed, opened.server.roles.app, {}, ({ ctx, load }) =>
								Effect.gen(function* () {
									const served = box.rider ? "riderWrite" : "write"
									const members = yield* load({ [served]: changes })
									const loaded = member(members, served)
									if (loaded.kind !== "change") {
										return yield* Effect.die(new Error("the write loads as a change"))
									}
									const change = variantOf(ctx, loaded.variants)
									const outcome = yield* Effect.result(
										changeApplication(
											ctx,
											sentWhole ? wholeChange(change) : change
										)({
											params: paramsOf(box, header),
											facts: {}
										})
									)
									const deltas = yield* heldDeltas(admin)
									const rows = yield* Effect.forEach([S1, S2, S3, G], (S) =>
										Effect.map(
											admin.query(
												`SELECT variable, value FROM ${names.table(S)} WHERE id = $1 ORDER BY variable`,
												[header]
											),
											(result) => result.rows
										)
									)
									const headers = yield* admin.query(
										`SELECT count(*)::text AS n FROM ${names.table(Lab.relations.H)} WHERE id = $1`,
										[header]
									)
									return { outcome, deltas, rows, headers: headers.rows }
								})
							)
						const parts = yield* run(shaped, false)
						const oracle = yield* run(whole, true)
						assert.equal(
							unheadered(parts.outcome),
							unheadered(oracle.outcome),
							"the call's outcome, its verdict, counts and read-back rows, are the whole statement's"
						)
						assert.equal(
							unheadered(parts.rows),
							unheadered(oracle.rows),
							"the rows it stores are the whole statement's"
						)
						assert.equal(unheadered(parts.headers), unheadered(oracle.headers), "its header too")
						const holds = { p1: box.facts.p1 > 0, p2: box.facts.p2 > 0, p3: box.facts.p3 > 0 }
						const refused = box.orphan && holds.p2
						const committed =
							Result.isSuccess(parts.outcome) && parts.outcome.success.kind === "accepted"
						assert.equal(committed, !refused, "the judge refuses exactly an orphan's facts")
						assert.deepEqual(
							Arr.map(Arr.take(parts.rows, 3), (stored) => stored.length),
							committed ? [box.facts.p1, box.facts.p2, box.facts.p3] : [0, 0, 0],
							"each sidecar stores its parameter's facts where the call commits, and none where the judge refuses it"
						)
						assert.deepEqual(
							parts.deltas,
							["G", "S1", "S2", "S3"],
							"its session stands up the deltas of every relation the write writes, whatever parts its call sent"
						)
						assert.deepEqual(
							oracle.deltas,
							parts.deltas,
							`the whole statement's session stands up the deltas the call's does, ${Formatter.format(parts.deltas)}`
						)
						c.note(holds.p1 && holds.p2 && holds.p3 ? "every part sent" : "a part left out")
						if (!holds.p1 && !holds.p2 && !holds.p3) {
							c.note("no sidecar sent")
						}
						if (box.rider && !holds.p1) {
							c.note("a rider keeping S1 whose parameter is empty")
						}
						if (refused) {
							c.note("a refusal at COMMIT")
						}
					})
				),
		oracle: {
			kind: "second-implementation",
			name: "the whole statement, every unit sent: its stored rows, outcome, verdict and read-back rows; by the box, each sidecar's rows its parameter's facts; and by the rule, the deltas a call's session holds are its stand-up's, every relation the write writes"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/write/parted.ts",
				original: '\t\tif (unit.kind === "part" && !holds(unit.needs, holdsFact)) {',
				replacement:
					'\t\tif (unit.kind === "part" && (!holds(unit.needs, holdsFact) || unit.needs.flat().length === 1)) {',
				why: "A call leaves out every part whose rows need one input, though its input holds facts: the sidecars' rows are lost and the judge never reads them."
			}
		]
	})
