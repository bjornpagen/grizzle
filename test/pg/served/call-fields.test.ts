/**
 * A query reads the rows of the fields of a declared function's one row as sources, one evaluation of the call for
 * every field a statement reads.
 *
 * - **Property (the reference):** a case draws sessions with their seeds and their items, each of a slot, a key, a
 *   text and a mark, and one of the programs that read machine's row: one field (`alone`), two in one rule (`pair`),
 *   two in a union of rules (`either`), two in one rule per session, the call over the rule's variables (`each`). The
 *   served program answers exactly the reference evaluator's rows of its query (test/support/oracle/reference), which
 *   calls machine by its model (call-fields.fixtures.ts machineModel), a set, an empty field the empty source; and where
 *   the reference refuses the call, a row or a field NULL, an element NULL or holding NULL where the program reads it,
 *   the served call fails, and its statement, run, raises SQLSTATE 22004, null_value_not_allowed.
 * - **Property (the evaluation):** a case draws the same and one statement that reads several fields of one call:
 *   `pair`, `either`, `each`, or `land`, a ChangeSet of one stratum whose three members write a's, b's and c's rows.
 *   Each statement's plan calls machine once, a Function Scan of its own beyond one unnest of each field it reads, which
 *   a correlated call runs once per binding of its rule; and `land` writes exactly machine's model's rows of each
 *   field, or nothing where the call is refused.
 * - **Oracle:** the reference evaluator over machine's model, a second reading of its body, and PostgreSQL's plan.
 * - **Features:** each program and statement, an empty field, a repeated row read once, each refusal, rows answered.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { memberExplains, memberCalls } from "#adapter/db/handles.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import {
	answeredTexts,
	attachedBySession,
	attachedCaseGen,
	drawnFeatures,
	fieldBySession,
	factsOf,
	type FieldsFeature,
	type ReadProgram,
	type SharingProgram,
	fieldsTemplate,
	landedOf,
	landingOf,
	machineScans,
	paramsOf,
	programsOf,
	readCaseGen,
	referenceOf,
	sharingCaseGen,
	worldOf
} from "#test/pg/served/call-fields.fixtures.ts"
import { functionScans, readOnce, writeOnce } from "#test/support/calls.ts"
import { loadMigrated } from "#test/support/install-migrate.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const readFeatures = [
	"alone",
	"pair",
	"either",
	"each",
	"an empty field, the empty source",
	"a repeated row, read once",
	"a NULL row, refused",
	"a NULL field, refused",
	"a NULL element, refused",
	"a row holding NULL, refused",
	"rows answered"
] as const satisfies ReadonlyArray<Reached<FieldsFeature<ReadProgram>>>

/** A read of the fields of a function's one row answers the reference's rows of its model, a NULL refused 22004. */
export const aReadOfTheFieldsOfAFunctionsRowAnswersTheReferencesRowsOfItsModel = property.explore(
	readCaseGen,
	{
		needs: Substrate.oneOf({ fields: fieldsTemplate }, Substrate.fresh),
		situations: readFeatures,
		budget: { runs: 32, steered: readFeatures.length },
		check: (templates, notes: Case<FieldsFeature<ReadProgram>>) => (c) =>
			Effect.scoped(
				Effect.gen(function* () {
					for (const feature of drawnFeatures(c)) {
						notes.note(feature)
					}
					const expected = referenceOf(c)
					const taken = yield* templates.fields
					yield* Effect.provideService(
						Effect.gen(function* () {
							const installed = taken.value.installed
							yield* loadMigrated(installed, factsOf(c))
							const world = worldOf(installed.declared)
							yield* withServedDb(
								installed,
								world.server.roles.app,
								{},
								({ ctx: db, loadWithTables }) =>
									Effect.gen(function* () {
										const loaded = yield* loadWithTables(programsOf(installed.declared).programs)
										const read = member(loaded.members, c.program)
										const input = { params: paramsOf(c), facts: {} }
										const answered = yield* Effect.result(readOnce(memberCalls(db, read))(input))
										if (Result.isFailure(expected)) {
											assert.ok(
												Result.isFailure(answered),
												`a call the reference refuses (${expected.failure.held}) is refused: ${Formatter.format(answered)}`
											)
											const explains = memberExplains(db, loaded.tables, read)
											if (explains.kind !== "read") {
												return assert.fail("a read explains as a read")
											}
											const run = yield* Effect.result(explains.explainAnalyze(input))
											assert.ok(
												Result.isFailure(run) &&
													run.failure._tag === "ReadFailure" &&
													run.failure.reason._tag === "ServerError" &&
													run.failure.reason.sqlstate === sqlstates.nullValueNotAllowed,
												`its statement raises null_value_not_allowed: ${Formatter.format(run)}`
											)
											return
										}
										if (Result.isFailure(answered)) {
											return assert.fail(
												`the program answers: ${Formatter.format(answered.failure)}`
											)
										}
										if (expected.success.length > 0) {
											notes.note("rows answered")
										}
										assert.deepEqual(
											answeredTexts(answered.success),
											expected.success,
											"the served program answers the reference's rows of machine's model, each once"
										)
									})
							)
						}),
						Substrate,
						taken.substrate
					)
				})
			),
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator over machine's model, a reading of its body in TypeScript"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/call/index.ts",
				original: '\t\tcheck: refusingNull(cx, called.name, columns, "a row holding NULL")',
				replacement: "\t\tcheck: lit.bool(true)",
				why: "A row holding NULL at a field is evaluated whole, so a NULL field unnests as no rows and a program reading it answers where the reference refuses."
			},
			{
				file: "packages/engine/src/lower/conservative/call/index.ts",
				original: "[...evaluated.where, noNullRow], cx)",
				replacement: "[...evaluated.where], cx)",
				why: "A NULL element, or one holding NULL, of a field read is delivered, so its statement raises no 22004 where the reference refuses the call."
			},
			{
				file: "packages/engine/src/lower/conservative/call/index.ts",
				original: "\tconst at = called.row.indexOf(called.field)",
				replacement: "\tconst at = called.row.length - 1 - called.row.indexOf(called.field)",
				why: "A read unnests another field of the row than the one it names, so a program reads flow or c where it reads a, and answers what the reference does not."
			},
			{
				file: "packages/engine/src/analysis/physical/rules.ts",
				original:
					"\tfinish(node, cx, {\n\t\tfds: new DependencyDraft(node.heading.map((c) => c.name)),\n",
				replacement:
					'\tfinish(node, cx, {\n\t\tfds: ((fds) => {\n\t\t\tfds.identify(node.heading.map((c) => c.name), withReason(joinJustifications([justify({ premises: [nodePremise(node.id)] }), comparing(node.heading.map((c) => c.type))]), ["deduplicatedInput"]))\n\t\t\treturn fds\n\t\t})(new DependencyDraft(node.heading.map((c) => c.name))),\n',
				why: "A call's plain rows claim their heading distinct, so no consumer places the DISTINCT a field's array needs and a repeated row is answered twice."
			}
		]
	}
)

const onceFeatures = [
	"pair",
	"either",
	"each",
	"land",
	"a NULL row, refused",
	"a NULL field, refused",
	"rows answered"
] as const satisfies ReadonlyArray<Reached<FieldsFeature<SharingProgram>>>

/** A statement that reads several fields of one call plans one call of it, and writes its model's rows of each. */
export const aStatementThatReadsSeveralFieldsOfOneCallCallsItOnce = property.explore(
	sharingCaseGen,
	{
		needs: Substrate.oneOf({ fields: fieldsTemplate }, Substrate.fresh),
		situations: onceFeatures,
		budget: { runs: 16, steered: onceFeatures.length },
		check: (templates, notes: Case<FieldsFeature<SharingProgram>>) => (c) =>
			Effect.scoped(
				Effect.gen(function* () {
					const statement = c.program
					for (const feature of drawnFeatures(c)) {
						if (
							feature === statement ||
							feature === "a NULL row, refused" ||
							feature === "a NULL field, refused"
						) {
							notes.note(feature)
						}
					}
					const taken = yield* templates.fields
					yield* Effect.provideService(
						Effect.gen(function* () {
							const substrate = yield* Substrate
							const installed = taken.value.installed
							yield* loadMigrated(installed, factsOf(c))
							const world = worldOf(installed.declared)
							yield* withServedDb(
								installed,
								world.server.roles.app,
								{},
								({ ctx: db, loadWithTables }) =>
									Effect.gen(function* () {
										const loaded = yield* loadWithTables(programsOf(installed.declared).programs)
										const read = member(loaded.members, statement)
										const input = { params: paramsOf(c), facts: {} }
										const explains = memberExplains(db, loaded.tables, read)
										const plans = yield* explains.explain(input)
										assert.equal(
											machineScans(plans, statement, functionScans),
											1,
											`${statement} plans one call of machine for every field it reads: ${Formatter.format(Arr.map(plans, (p) => functionScans(p.plan)))}`
										)
										if (statement !== "land") {
											return
										}
										const landing = landingOf(c)
										const applied = yield* Effect.result(writeOnce(memberCalls(db, read))(input))
										if (Result.isFailure(landing)) {
											assert.ok(
												Result.isFailure(applied),
												`land of a call the model refuses is refused: ${Formatter.format(applied)}`
											)
											return
										}
										if (Result.isFailure(applied)) {
											return assert.fail(`land applies: ${Formatter.format(applied.failure)}`)
										}
										notes.note("rows answered")
										const landed = yield* landedOf(substrate.admin, installed.schema)
										assert.deepEqual(
											landed,
											landing.success,
											"land writes exactly the model's rows of each field"
										)
									})
							)
						}),
						Substrate,
						taken.substrate
					)
				})
			),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL's plan of each statement, and machine's model of the rows land writes"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/index.ts",
				original:
					"\t\tthis.cx.hostStatementEvaluations(statementEvaluations(this.state.log.ctes, this.cx))\n",
				replacement: "",
				why: "A query's statement holds no evaluation of its own, so each read of a field calls machine itself: pair's and either's plans call it twice."
			},
			{
				file: "packages/engine/src/lower/conservative/match-region/index.ts",
				original: "\t\t\tkeyed.filter((other) => other.key === k.key).length > 1\n",
				replacement: "\t\t\tkeyed.filter((other) => other.key === k.key).length > keyed.length\n",
				why: "A rule's region holds no evaluation of the call its matches read the fields of, so each field read over the rule's variables calls machine again per binding: each's plan calls it twice."
			},
			{
				file: "packages/engine/src/write/program/compile.ts",
				original:
					"\t\t...heldEvaluations(cx, [\n\t\t\t...shares.map((share) => share.node),\n\t\t\t...writes.flatMap(plannedNodes)\n\t\t]).map(",
				replacement: "\t\t...heldEvaluations(cx, []).map(",
				why: "A single statement holds no evaluation as a part of its own, so each member's statement part holds its own, and land's plan calls machine three times."
			}
		]
	}
)

/** What a case of the attached read reaches: one session, several, or a call machine refuses. */
type AttachedFeature = "one session" | "several sessions" | "a refused call, every read refused"

const attachedFeatures = [
	"one session",
	"several sessions",
	"a refused call, every read refused"
] as const satisfies ReadonlyArray<Reached<AttachedFeature>>

/**
 * A read whose attachments read one call at their parent's key answers what a read of each field over the parents
 * answers, and plans one call of machine: `attached`, each session with its attachments a and c each reading machine's
 * run at the session's key, against `eachA` and `eachC`, each session's rows of one field read in a region.
 */
export const aReadWhoseAttachmentsReadOneCallAtTheirParentsKeyAnswersWhatEachFieldsReadAnswersInOneCall =
	property.explore(attachedCaseGen, {
		needs: Substrate.oneOf({ fields: fieldsTemplate }, Substrate.fresh),
		situations: attachedFeatures,
		budget: { runs: 16, steered: attachedFeatures.length },
		check: (templates, notes: Case<AttachedFeature>) => (c) =>
			Effect.scoped(
				Effect.gen(function* () {
					const taken = yield* templates.fields
					yield* Effect.provideService(
						Effect.gen(function* () {
							const installed = taken.value.installed
							yield* loadMigrated(installed, factsOf(c))
							const world = worldOf(installed.declared)
							yield* withServedDb(
								installed,
								world.server.roles.app,
								{},
								({ ctx: db, loadWithTables }) =>
									Effect.gen(function* () {
										const loaded = yield* loadWithTables(programsOf(installed.declared).programs)
										const input = { params: {}, facts: {} }
										const run = (name: string) =>
											Effect.result(readOnce(memberCalls(db, member(loaded.members, name)))(input))
										const attached = yield* run("attached")
										const [a, cs] = [yield* run("eachA"), yield* run("eachC")]
										const explains = memberExplains(
											db,
											loaded.tables,
											member(loaded.members, "attached")
										)
										if (explains.kind !== "read") {
											return assert.fail("a read explains as a read")
										}
										if (Result.isFailure(a) || Result.isFailure(cs)) {
											notes.note("a refused call, every read refused")
											assert.ok(
												Result.isFailure(attached),
												`the attached read of a call machine refuses is refused: ${Formatter.format(attached)}`
											)
											return
										}
										if (Result.isFailure(attached)) {
											return assert.fail(
												`the attached read answers: ${Formatter.format(attached.failure)}`
											)
										}
										notes.note(c.sessions.length > 1 ? "several sessions" : "one session")
										const plans = yield* explains.explain(input)
										assert.equal(
											Arr.reduce(plans, 0, (n: number, p) => n + functionScans(p.plan)) - 2,
											1,
											`attached plans one call of machine beside its two fields' unnests: ${Formatter.format(Arr.map(plans, (p) => functionScans(p.plan)))}`
										)
										for (const [field, each] of [
											["a", a.success],
											["c", cs.success]
										] as const) {
											const by = fieldBySession(each)
											for (const [session, children] of attachedBySession(
												attached.success,
												field
											)) {
												assert.deepEqual(
													children,
													by.get(session) ?? [],
													`session ${session}'s attachment ${field} holds the rows of ${field} at its key`
												)
											}
										}
									})
							)
						}),
						Substrate,
						taken.substrate
					)
				})
			),
		oracle: {
			kind: "second-implementation",
			name: "each field's rows read in a region over the sessions, and PostgreSQL's plan of the attached read"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/index.ts",
				original: "\t\tconst child = this.cx.withEvaluations(evaluations)\n",
				replacement: "\t\tconst child = this.cx\n",
				why: "No host holds the attachments' call for the sessions' rows: each attachment's child calls machine again, and the attached read plans two calls."
			},
			{
				file: "packages/engine/src/lower/conservative/call/index.ts",
				original:
					"\t\t\t\tconjunction(\n\t\t\t\t\tevaluation.keys.map((k) => cx.equal(k.type, col(at, k.column), valueAt(k.name)))\n\t\t\t\t),\n",
				replacement: "\t\t\t\tundefined,\n",
				why: "An attachment reads the evaluation of every session, never at its own parent's key: with two sessions of items each session's attachment holds both sessions' rows."
			}
		]
	})
