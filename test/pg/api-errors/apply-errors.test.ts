/**
 * The public-API error matrix, the write side: each refusal that grizzle's own code decides, through a served change
 * member's once.
 *
 * - An encoding refusal: a value its codec refuses is the CallError `input` before any SQL, its message naming the fault
 *   the codec's vocabulary names for its class and the parameter it belongs to as its slot (core/errors.ts
 *   EncodingFailure, whose message names both, never the value). One field of an otherwise live fact at a time
 *   (an integer, a bigint, a boolean, a refined text, a uuid, a span) is drawn a value of its field's invalid class,
 *   constructed, never filtered (a string that holds a non-hex letter, an integer past its type's range, a non-boolean,
 *   a text holding NUL, a span whose end is not past its start), or a Wild value (@bjornpagen/testing/lsw), passed as a
 *   call's fact of an array member, or a scalar parameter of a described member. The oracle is the codecs' fault
 *   vocabulary (scalar/values/fault.ts), each class's one fault: a value of a class is refused with that fault, a
 *   parameter's with the parameter as its slot, with no frontend message sent and nothing stored; a wild value the
 *   codec admits is answered, never a defect (drawn as an arm of its own too, since a wild draw rarely lands on one).
 * - No scalar operation in a described member raises on a value: every one is total or stands with its proof, and a
 *   narrowing into a column without one is refused at compilation (PartialOperation, test/unit/compute/totality.test.ts),
 *   so a member's computed value is never an ExecutionFailure.
 *
 * Covered elsewhere through the public API: TransientFailure from an apply (test/schedules/write/races.test.ts).
 * Not provoked: TransportFailure and CommitUnknown arise only from a lost connection or an unacknowledged COMMIT, which
 * are infrastructure faults out of the suite's scope. A read-back's rows are converted, not validated (the public-boundary
 * differential reads each read-back as strictly as a read, test/pg/oracle/public/run.ts).
 *
 * Features: every field's invalid class in every form, a wild value admitted, and wild nulls, proxies and lone
 * surrogates refused.
 */

import { assert, assertVariant } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { passed } from "@bjornpagen/testing/lsw"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Result, String as Str } from "effect"
import { memberCalls, variantOf } from "#adapter/db/handles.ts"
import {
	callersParams,
	classFault,
	encodingCaseGen,
	type EncodingFeature,
	applyInstall,
	applyTemplate,
	Fixture,
	live,
	liveParams,
	plantedPairs,
	programs,
	seedFacts,
	Typed,
	encodingAims
} from "#test/pg/api-errors/apply-errors.fixtures.ts"
import { tappedPool } from "#test/pg/api-errors/support.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import { writeAnswerOf, writeOnce } from "#test/support/calls.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * ApplyError through the public API a value its codec refuses is refused as input naming its fault and slot, before any SQL; one it admits is answered.
 *
 * Its pre-conversion budget: runs 200, coverage cases 200 (test/pg/api-errors/apply-errors.test.ts at 8ad8d5b2c).
 */
export const applyErrorThroughThePublicAPIAValueItsCodecRefusesIsRefusedAsInputNamingItsFaultAndSlotBeforeAnySQLOneItAdmitsIsAnswered =
	property.explore(aimed(encodingCaseGen, encodingAims), {
		needs: { fixture: Substrate.freshOf(applyTemplate) },
		situations: [
			...Arr.map(plantedPairs, ({ field, form }): EncodingFeature => `refused ${field} as ${form}`),
			"wild admitted",
			"wild null refused",
			"wild proxy refused",
			"wild lone-surrogate refused"
		] satisfies ReadonlyArray<Reached<EncodingFeature>>,
		check:
			({ fixture }, cx: Case<EncodingFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.gen(function* () {
						const taken = yield* fixture
						const o = yield* openedIn(Fixture, seedFacts, applyInstall, taken)
						return yield* Effect.provideService(
							Effect.gen(function* () {
								const { ctx, load } = yield* openServedDb(o.installed, o.server.roles.app, {})
								const members = yield* load(programs)
								const { pool, tap } = yield* tappedPool(o.installed.as(o.server))
								const tapped = { ...ctx, pool }

								const value = c.value.kind === "refused" ? c.value.value : passed(c.value)
								const fact: Record<string, unknown> = { ...live, [c.field]: value }
								const mark = tap.mark()
								const change = member(members, c.form)
								assertVariant(change, "kind", "change", "a ChangeSet loads as a change member")
								const calls = memberCalls(tapped, change)
								const takes = variantOf(tapped, change.variants).call.kind
								const outcome = yield* Effect.result(
									c.form === "parameter"
										? Effect.suspend(() => {
												assert.equal(takes, "params", "the described member takes its parameters")
												return writeAnswerOf(
													writeOnce(calls)({
														params: callersParams({ ...liveParams, [c.field]: value }),
														facts: {}
													})
												)
											})
										: Effect.suspend(() => {
												assert.equal(takes, "facts", "an array member takes its call's facts")
												return writeAnswerOf(
													writeOnce(calls)({
														params: {},
														facts: { insert: { Typed: [fact] } }
													})
												)
											})
								)
								if (Result.isSuccess(outcome)) {
									assert.ok(c.value.kind === "wild", `a ${c.field} of its invalid class is refused`)
									cx.note("wild admitted")
									return
								}
								const error = outcome.failure
								assert.equal(error.kind, "input", error.message)
								assert.equal(tap.since(mark).frontend.length, 0, "no statement before the refusal")
								const state = yield* tableState(o.installed, Typed)
								assert.deepEqual(state, [])
								if (c.form === "parameter") {
									assert.ok(
										Str.startsWith(`the value of ${c.field} was refused: `)(error.message),
										`the refusal is at the slot ${c.field}: ${error.message}`
									)
								}
								if (c.value.kind === "refused") {
									assert.ok(
										Str.endsWith(` was refused: ${classFault[c.field]}`)(error.message),
										`the refusal's fault is ${classFault[c.field]}: ${error.message}`
									)
									cx.note(`refused ${c.field} as ${c.form}`)
								} else {
									cx.note(`wild ${c.value.wild.kind} refused`)
								}
							}),
							Substrate,
							taken.substrate
						)
					})
				),
		oracle: {
			kind: "specification",
			name: "the codecs' fault vocabulary: each invalid class's one fault, a parameter's at its slot"
		},
		budget: { runs: 200, steered: 200 },
		kept: [
			{
				token: ReplayToken(
					"test/pg/api-errors/apply-errors.test.ts#applyErrorThroughThePublicAPIAValueItsCodecRefusesIsRefusedAsInputNamingItsFaultAndSlotBeforeAnySQLOneItAdmitsIsAnswered:-:1.0.b"
				),
				reason:
					"f1bf91a2f's gate (TEST_SEED=2219874524, floor case 25): a call's fact whose id is a refusing proxy, which the shares' valueBytes read by instanceof before the codec, so its getPrototypeOf trap escaped as a WildTouched defect where the codec refuses it with its fault and slot (9e905ec1a)",
				since: "2026-11-22"
			}
		],
		kills: [
			{
				file: "packages/grizzle/src/adapter/apply/shares.ts",
				original: "\tconst read = readHost(unread, () =>",
				replacement: "\tconst read = Result.flatMap(Result.succeed(unread), () =>",
				why: "Shares read a call's facts outside the boundary's reader, as valueBytes did before the codec read them, so a refusing proxy's trap escapes as a defect where the codec refuses the value with its fault and slot."
			}
		]
	})
