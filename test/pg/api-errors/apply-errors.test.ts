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
 * - A parameter refusal: a call whose params hold a key that names none of its member's parameters is the CallError
 *   `input` before any SQL, its message naming the member and the key (adapter/errors/failures.ts CallInputRefused,
 *   UndeclaredParameter; reader/params.ts readParams), where it was an EncodingFailure of a fact's shape at the facts,
 *   `a value was refused: factShape`, which named neither, and metis read as its empty facts refused. The box: the
 *   described member and the array member, each called with one key more than it declares, a parameter another member
 *   takes, a parameter misspelt or the field the described member reads. The oracle is the specification: the member's
 *   declared parameters, against which the key is undeclared.
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
import { aimed, finite } from "@bjornpagen/testing/gen"
import { passed } from "@bjornpagen/testing/lsw"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result, String as Str } from "effect"
import { changeApplication, memberCalls, variantOf } from "#adapter/db/handles.ts"
import {
	callersParams,
	classFault,
	type UndeclaredFeature,
	undeclaredCaseGen,
	undeclaredParams,
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
		needs: { fixture: Substrate.fresh(applyTemplate) },
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
				file: "packages/engine/src/runtime/write/read-call.ts",
				original: "\t\t\t\tconst given = members.get(member.name)\n",
				replacement:
					"\t\t\t\tconst given = members.get(member.name)\n\t\t\t\tfor (const fact of given ?? []) {\n\t\t\t\t\tvalueBytes(fact)\n\t\t\t\t}\n",
				why: "The call's facts are measured off the caller's values before the write reads them, as shares measured them before the codec read them, so a refusing proxy's trap escapes as a defect where the codec refuses the value with its fault and slot."
			}
		]
	})

/**
 * A call whose params hold a key its member declares no parameter of is refused as input naming the member and the key,
 * before any SQL, and stores nothing.
 */
export const aCallWhoseParamsHoldAKeyItsMemberDeclaresNoParameterOfIsRefusedAsInputNamingTheMemberAndTheKey =
	property.exhaust(finite(undeclaredCaseGen), {
		needs: { fixture: Substrate.fresh(applyTemplate) },
		situations: [
			"the described member's params, one key more",
			"an array member's params, which it declares none of"
		] satisfies ReadonlyArray<Reached<UndeclaredFeature>>,
		check:
			({ fixture }, cx: Case<UndeclaredFeature>) =>
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
								const mark = tap.mark()
								const change = member(members, c.form)
								assertVariant(change, "kind", "change", "a ChangeSet loads as a change member")
								const tapped = { ...ctx, pool }
								const input = {
									params: undeclaredParams(c),
									facts: c.form === "parameter" ? {} : { insert: { Typed: [live] } }
								}
								const answered = yield* Effect.result(
									writeAnswerOf(writeOnce(memberCalls(tapped, change))(input))
								)
								assert.ok(Result.isFailure(answered), `${c.form} admits a params key ${c.key}`)
								assert.equal(answered.failure.kind, "input", answered.failure.message)
								const applied = yield* Effect.result(
									changeApplication(tapped, variantOf(tapped, change.variants))(input)
								)
								assert.ok(
									Result.isFailure(applied) && applied.failure._tag === "CallInputRefused",
									`the refusal is the call's input's: ${Formatter.format(applied)}`
								)
								assert.deepEqual(
									applied.failure.fault,
									{ program: c.form, parameter: c.key },
									"the refusal names the member and the key"
								)
								assert.equal(tap.since(mark).frontend.length, 0, "no statement before the refusal")
								const state = yield* tableState(o.installed, Typed)
								assert.deepEqual(state, [])
								cx.note(
									c.form === "parameter"
										? "the described member's params, one key more"
										: "an array member's params, which it declares none of"
								)
							}),
							Substrate,
							taken.substrate
						)
					})
				),
		oracle: {
			kind: "specification",
			name: "the member's declared parameters: a key of its params outside them is refused as itself, naming the member"
		},
		box: "the described member and the array member, each called with one key more than it declares: a parameter another member takes, a parameter misspelt, the field the described member reads",
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/reader/params.ts",
				original:
					"\t\t\t? Result.fail(new CallInputRefused({ fault: { program, parameter: undeclared.value } }))\n",
				replacement: '\t\t\t? Result.fail(encodeFailure("factShape", factPlace))\n',
				why: "The undeclared key is refused as a fact's shape at the facts, `a value was refused: factShape`, naming neither the member nor the key: metis's by-grade suite read its call's empty facts as refused."
			},
			{
				file: "packages/grizzle/src/adapter/reader/params.ts",
				original:
					"\t\tconst undeclared = Arr.findFirst(Rec.keys(params), (key) => !names.includes(key))\n",
				replacement: "\t\tconst undeclared = Arr.findFirst(Rec.keys(params), () => false)\n",
				why: "A key of the params that names no parameter binds nothing: a parameter the caller meant and misspelled, or one another member takes, is dropped without a word, and the write runs."
			}
		]
	})
