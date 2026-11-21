/**
 * A strict declared function's call at a NULL argument is NULL, or no row for a function of rows, without running its
 * body, on PostgreSQL 19, in its own call, in the reference's model of it, in the host's evaluation and through a
 * served program; a function called on NULL input runs its body there.
 *
 * - **Property:** the box, exhausted: each function's signature (`plain`, an integer and a text; `coded`, a digest's
 *   bytea and a closed id's code), its result (a value, or rows of a heading), its language, its null input (`called`
 *   or `strict`) and what its body does at a NULL argument (answers 7, answers NULL, or fails), one installation holding
 *   every one (strict-calls.fixtures.ts). Each case calls its function at every pattern of its two arguments, each NULL
 *   or one of two values: PostgreSQL's answer is the declaration's meaning (a strict function's at a NULL argument NULL,
 *   or no row, every other call its body's answer, its failure among them), and the reference's call of the function's
 *   model (reference/functions.ts modelledCall) is PostgreSQL's. A plain function of a value is called besides by a
 *   served program over every probe of two keys, whose filter reads the call at Pick's payload at each key, NULL at the
 *   key Pick holds no row at: the host evaluates the call grizzle checks NULL exactly where it is strict and an argument
 *   is NULL, declining every other, and the program keeps exactly the probes whose call answers a value, a strict
 *   call's NULL leaving its probe unknown, or fails as PostgreSQL's calls fail, 22004 where a function called on NULL
 *   input answers NULL.
 * - **Oracle:** PostgreSQL's own call of each installed function at literal arguments, as the owner, and the
 *   declaration's meaning: STRICT's, and the body's text read in TypeScript.
 * - **Features:** every axis of the box, each kind of call at a NULL argument, the host's NULL, a probe a strict filter
 *   leaves unknown, and a served call refused.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { memberCalls, memberExplains } from "#adapter/db/handles.ts"
import {
	anyNull,
	byPattern,
	caseGen,
	directAnswer,
	drawnFeatures,
	expectedAnswer,
	expectedServed,
	features,
	hostAnswers,
	isServed,
	nameOf,
	patterns,
	probeFacts,
	probePattern,
	programOf,
	referenceAnswer,
	type Served,
	type StrictFeature,
	strictTemplate,
	worldOf
} from "#test/pg/served/strict-calls.fixtures.ts"
import { readOnce } from "#test/support/calls.ts"
import { loadMigrated } from "#test/support/install-migrate.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A strict function's call at a NULL argument is NULL or no row, its body never run, wherever it is evaluated. */
export const aStrictFunctionsCallAtANullArgumentIsNullWithoutRunningItsBody = property.exhaust(
	finite(caseGen),
	{
		needs: Substrate.oneOf({ strict: strictTemplate }, Substrate.seat),
		situations: features satisfies ReadonlyArray<Reached<StrictFeature>>,
		check: (templates, notes: Case<StrictFeature>) => (c) =>
			Effect.scoped(
				Effect.gen(function* () {
					for (const feature of drawnFeatures(c)) {
						notes.note(feature)
					}
					const taken = yield* templates.strict
					yield* Effect.provideService(
						Effect.gen(function* () {
							const substrate = yield* Substrate
							const installed = taken.value.installed
							const direct = yield* Effect.forEach(patterns, (pattern) =>
								Effect.map(
									directAnswer(substrate.admin, installed.schema, c, pattern),
									(answer) => ({ pattern, answer })
								)
							)
							for (const { pattern, answer } of direct) {
								if (anyNull(pattern)) {
									notes.note(
										c.nullInput === "strict"
											? "a strict call at a NULL argument, its body never run"
											: "a called call at a NULL argument, its body run"
									)
									if (c.nullInput === "strict" && c.returns === "rows") {
										notes.note("a strict set-returning call at a NULL argument, no row")
									}
								}
								assert.deepEqual(
									answer,
									expectedAnswer(c, pattern),
									`PostgreSQL's call of ${nameOf(c)} at ${Arr.join(Arr.map(pattern, String), ", ")} is its declaration's meaning`
								)
								assert.deepEqual(
									referenceAnswer(c, pattern),
									answer,
									`the reference's call of ${nameOf(c)} at ${Arr.join(Arr.map(pattern, String), ", ")} is PostgreSQL's`
								)
							}
							if (!isServed(c)) {
								return
							}
							for (const { pattern, answer } of hostAnswers(c)) {
								const strictAtNull = c.nullInput === "strict" && anyNull(pattern)
								assert.equal(
									answer,
									strictAtNull ? "null" : "declined",
									`the host evaluates ${nameOf(c)} at ${Arr.join(Arr.map(pattern, String), ", ")} NULL exactly where it is strict and an argument is NULL`
								)
								if (strictAtNull) {
									notes.note("the host's NULL of a strict call at a NULL argument")
								}
							}
							yield* loadMigrated(installed, probeFacts)
							const expected = expectedServed(c, direct)
							const world = worldOf(installed.declared)
							const served: Served = yield* withServedDb(
								installed,
								world.server.roles.app,
								{},
								({ ctx: db, loadWithTables }) =>
									Effect.gen(function* () {
										const loaded = yield* loadWithTables(programOf(c, installed.declared))
										const run = member(loaded.members, nameOf(c))
										const input = { params: {}, facts: {} }
										const answered = yield* Effect.result(readOnce(memberCalls(db, run))(input))
										if (Result.isSuccess(answered)) {
											return {
												kind: "kept",
												probes: Arr.sort(
													Arr.map(answered.success, (row) =>
														probePattern(Reflect.get(row, "key"), Reflect.get(row, "other"))
													),
													byPattern
												)
											} satisfies Served
										}
										const explains = memberExplains(db, loaded.tables, run)
										if (explains.kind !== "read") {
											return assert.fail("a read explains as a read")
										}
										const ran = yield* Effect.result(explains.explainAnalyze(input))
										return Result.isFailure(ran) &&
											ran.failure._tag === "ReadFailure" &&
											ran.failure.reason._tag === "ServerError"
											? ({ kind: "refused", code: ran.failure.reason.sqlstate } satisfies Served)
											: assert.fail(
													`a refused call's statement raises: ${Formatter.format(answered.failure)}`
												)
									})
							)
							if (served.kind === "refused") {
								notes.note("a served call refused")
							}
							if (
								c.nullInput === "strict" &&
								served.kind === "kept" &&
								served.probes.length < patterns.length
							) {
								notes.note("a strict filter leaving a probe unknown")
							}
							assert.deepEqual(
								served,
								expected,
								`the program over ${nameOf(c)} answers PostgreSQL's calls of it at every probe`
							)
						}),
						Substrate,
						taken.substrate
					)
				})
			),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL's own call of each installed function at literal arguments, as the owner, and the declaration's meaning: STRICT's, and the body's text read in TypeScript"
		},
		box: "each function's signature, result, language, null input and body's NULL behaviour, every pattern of its two arguments NULL or a value",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/functions.ts",
				original: "\t\t\t\t\t\tnullInput: nullInputClause[nullInputOf(fn.desc)],",
				replacement: "\t\t\t\t\t\tnullInput: undefined,",
				why: "A strict function installs called on NULL input, so its body runs at a NULL argument: it answers 7, or fails, where STRICT answers NULL."
			},
			{
				file: "packages/engine/src/lower/conservative/expr/index.ts",
				original: '\t\texpr.nonNull === "strict" && value.args.length > 0',
				replacement: "\t\tfalse",
				why: "A strict call's NULL at a NULL argument is refused 22004 as a NULL its body returned, so a strict filter fails where it leaves a probe unknown."
			},
			{
				file: "packages/engine/src/scalar/compute/typing.ts",
				original: "\t\t\tnonNull: callNonNull[nullInputOf(fn.desc)],",
				replacement: '\t\t\tnonNull: "returned",',
				why: "A strict call is typed as one called on NULL input, never NULL, so the host declines its NULL at a NULL argument and the lowering refuses it 22004."
			},
			{
				file: "packages/engine/src/scalar/compute/evaluate.ts",
				original: "\t\t\t\t\t\treturn strictCallExpr(expr, expr.args.map(node))",
				replacement: '\t\t\t\t\t\treturn refusedExpr("a call of a declared function")',
				why: "The host declines a strict call at a NULL argument, whose value PostgreSQL answers NULL without running its body."
			},
			{
				file: "test/support/oracle/reference/functions.ts",
				original: '\t\t\treturn { kind: "rows", rows: [] }',
				replacement: '\t\t\treturn { kind: "rows", rows: [null] }',
				why: "The reference answers a strict set-returning call at a NULL argument one NULL row, where PostgreSQL answers none."
			}
		]
	}
)
