/**
 * A declared function's refined result is checked where a served program reads it: the function's row type holds each
 * refined text at its base, `text`, and each read casts the call's value to its field's domain, which the installation
 * holds whatever stored field declares the refinement (physical/install/plan.ts textRefinements), so PostgreSQL refuses
 * a value outside the refinement before any row reaches the host, and the decoder trusts what arrives because the cast
 * ran.
 *
 * - **Property:** a case draws where the two refinements, Code (alpha or beta) and Word (gamma or delta), are named
 *   (the functions' results alone, or a stored field too), a true body or a rotated one, which returns the code and the
 *   word permuted, each field a value outside its own refinement and inside the other's, and how the served program
 *   reads the result (its rows, a field of rows of its one row, its value, or how many rows it returns, which delivers
 *   no refined value, so the call's cast is the only check of the body's: a read that delivers one is cast again at
 *   its delivery, lower/conservative/refined.ts castDomain, wherever no cast before it proved the value) at an item the
 *   case loads. A true body's
 *   read answers PostgreSQL's own rows of the call; a rotated body's is refused, its statement raising SQLSTATE 23514,
 *   check_violation, at the cast. Every attribute of the installation's row types holding a code or a word is `text`.
 * - **Oracle:** PostgreSQL: the owner's direct call of the function at the case's item, and its catalog.
 * - **Features:** each place, each body, each read.
 *
 * Red on the old naming (main a4434b75f): every function-only template is refused at generate, "physical: no structural
 * text domain for /^(alpha|beta)$/u".
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { memberExplains, memberCalls } from "#adapter/db/handles.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import {
	type Body,
	caseGen,
	factsOf,
	oracleRows,
	type Place,
	programOf,
	programsOf,
	type Read,
	refinementsTemplates,
	rowText,
	rowTypeColumns,
	sortedTexts,
	templateKey,
	worldOf
} from "#test/pg/served/call-refinements.fixtures.ts"
import { readOnce } from "#test/support/calls.ts"
import { loadMigrated } from "#test/support/install-migrate.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

type RefinementsFeature = Place | `a ${Body} body` | `a read of ${Read}`

const features = [
	"a function's result alone",
	"a stored field too",
	"a true body",
	"a rotated body",
	"a read of rows",
	"a read of a field of its row",
	"a read of its value",
	"a read of a count of its rows"
] as const satisfies ReadonlyArray<Reached<RefinementsFeature>>

/** A read of a function's refined result answers its rows where the body keeps to its refinements, and is refused at
 * the cast where it does not. Each case clones one of four installations and reads once, so its budget is the
 * runner's. */
export const aReadOfAFunctionsRefinedResultIsCheckedAtItsCast = property.explore(caseGen, {
	needs: Substrate.oneOf(refinementsTemplates, Substrate.seat),
	situations: features,
	check: (templates, notes: Case<RefinementsFeature>) => (c) =>
		Effect.scoped(
			Effect.gen(function* () {
				notes.note(c.place)
				notes.note(`a ${c.body} body`)
				notes.note(`a read of ${c.read}`)
				const taken = yield* templates[templateKey(c.place, c.body)]
				yield* Effect.provideService(
					Effect.gen(function* () {
						const substrate = yield* Substrate
						const installed = taken.value.installed
						yield* loadMigrated(installed, factsOf(c))
						const columns = yield* rowTypeColumns(substrate.admin, installed.schema)
						assert.ok(columns.length > 0, "the function's row types hold a code and a word")
						for (const column of columns) {
							assert.equal(
								column["type"],
								"text",
								`a row type's ${String(column["name"])} is installed at its base`
							)
						}
						const world = worldOf(c.place, c.body, installed.declared)
						yield* withServedDb(
							installed,
							world.server.roles.app,
							{},
							({ ctx: db, loadWithTables }) =>
								Effect.gen(function* () {
									const loaded = yield* loadWithTables(
										programsOf(c.place, c.body, installed.declared)
									)
									const run = member(loaded.members, programOf(c.read))
									const input = { params: { item: c.at }, facts: {} }
									const answered = yield* Effect.result(readOnce(memberCalls(db, run))(input))
									if (c.body === "rotated") {
										assert.ok(
											Result.isFailure(answered),
											`a rotated body's read is refused: ${Formatter.format(answered)}`
										)
										const explains = memberExplains(db, loaded.tables, run)
										if (explains.kind !== "read") {
											return assert.fail("a read explains as a read")
										}
										const ran = yield* Effect.result(explains.explainAnalyze(input))
										assert.ok(
											Result.isFailure(ran) &&
												ran.failure._tag === "ReadFailure" &&
												ran.failure.reason._tag === "ServerError" &&
												ran.failure.reason.sqlstate === sqlstates.checkViolation,
											`its statement raises check_violation at the cast: ${Formatter.format(ran)}`
										)
										return
									}
									if (Result.isFailure(answered)) {
										return assert.fail(`the read answers: ${Formatter.format(answered.failure)}`)
									}
									const expected = yield* oracleRows(substrate.admin, installed.schema, c)
									assert.deepEqual(
										sortedTexts(Arr.map(answered.success, rowText)),
										sortedTexts(Arr.map(expected, rowText)),
										"the read answers PostgreSQL's own rows of the call"
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
		name: "the owner's direct call of the function at the case's item, and the installation's catalog"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/lower/conservative/call/index.ts",
			original: "\t\t\t\t\tfieldColumnType(cx.names, c.type).type\n",
			replacement: "\t\t\t\t\tcx.baseTypeRef(c.type)\n",
			why: "A read of a function's rows takes the body's values at their base, the composite's own type, unchecked: a rotated body's count of rows is answered, no cast refusing its values, where a read that delivers them is still refused at its delivery's cast."
		}
	]
})
