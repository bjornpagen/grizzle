/**
 * The database-free parts of the native PG test substrate, each against a model:
 *
 * - Names. A schema label and a role name are lowercase ASCII letter words joined by single underscores; an allocated
 *   schema name is `gz_<label>_<pid>_<n>_<ten digits>`, its own conversion at the naming door, and every role and role
 *   schema minted under it starts with its prefix, so the global setup reads the allocating process off any of them
 *   and sweeps a dead one's; no name past maxIdentifierBytes is ever made, so PostgreSQL never cuts one. The oracle is
 *   the generator's own words, each drawn whole or with a fault planted, and the byte count of the name they spell.
 * - psql's verbose error report: stderr of noise lines and reports, each a severity line and its fields, is read as
 *   the last report, its message, and each field's first value that holds no line terminator; stderr with no severity
 *   line holds no report.
 * - An expectation judges its one attempt: the attempt runs once, and the expectation holds exactly for a PostgreSQL
 *   refusal of its SQLSTATE, and of its constraint where it names one.
 *
 * Every property states its oracle, the specification; invalid words, identifiers and allocations are named faults
 * the generators plant, drawn by explicit weight beside the lawful ones. Features: each verdict of each property.
 */

import { maxIdentifierBytes } from "@bjornpagen/grizzle-engine/core/identity"
import { type Reached } from "@bjornpagen/testing/features"
import { array, element, int, weighted } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Ref, Result, String as Str } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { assert, assertVariant } from "#test/support/assert.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import type { ExpectationFailed, PgErrorFields } from "#test/support/substrate/errors.ts"
import { expectConstraint, expectSqlstate } from "#test/support/substrate/expect.ts"
import {
	allocatingPid,
	assertIdentifier,
	roleName,
	rolePrefix,
	uniqueSchemaName
} from "#test/support/substrate/names.ts"
import { parseVerboseError } from "#test/support/substrate/psql.ts"
import {
	constraintOf,
	drawnWord,
	endingGen,
	endingOf,
	type ExpectFeature,
	expectationGen,
	firstOf,
	identifierGen,
	type Judgment,
	mintedUnder,
	type NameFeature,
	type NotPostgres,
	noiseGen,
	refuses,
	type ReportFeature,
	reportGen,
	reportText,
	type ServerRecord,
	unallocatedGen
} from "#test/unit/substrate/substrate.fixtures.ts"

/** Substrate names allocate exactly the names the word rule and the byte limit admit, every name under an allocation carrying its prefix and its process. */
export const substrateNamesAllocateExactlyTheNamesTheWordRuleAndTheByteLimitAdmitEveryNameUnderAnAllocationCarryingItsPrefixAndItsProcess =
	property.explore(
		(source) => ({
			label: source.draw(drawnWord(source.draw(element([6, 24, 60] as const)))),
			allocation: source.draw(
				weighted<number>([
					[3, int(0, 199)],
					[1, int(0, 2 ** 31 - 1)]
				])
			),
			role: source.draw(drawnWord(source.draw(element([6, 24, 60] as const)))),
			unallocated: source.draw(unallocatedGen),
			identifier: source.draw(identifierGen)
		}),
		{
			needs: {},
			situations: [
				"an identifier admitted",
				"an identifier past the limit",
				"an identifier refused",
				"allocated",
				"a label refused",
				"a label past the limit",
				"a role named",
				"a role refused",
				"a role past the limit",
				"no allocation"
			] satisfies ReadonlyArray<Reached<NameFeature>>,
			check:
				(_, c: Case<NameFeature>) =>
				({ label, allocation, role, unallocated, identifier }) =>
					Effect.sync(() => {
						const plain =
							Option.isNone(identifier.fault) &&
							Buffer.byteLength(identifier.text) <= maxIdentifierBytes
						assert.equal(
							refuses(() => assertIdentifier(identifier.text)),
							!plain,
							identifier.text
						)
						c.note(
							plain
								? "an identifier admitted"
								: Option.isSome(identifier.fault)
									? "an identifier refused"
									: "an identifier past the limit"
						)
						assert.ok(Option.isNone(allocatingPid(unallocated)), unallocated)
						assert.ok(
							refuses(() => roleName(unallocated, "worker")),
							unallocated
						)
						c.note("no allocation")
						const bytes = Buffer.byteLength(
							`gz_${label.text}_${process.pid}_${allocation}_0000000000`
						)
						const fits = bytes <= maxIdentifierBytes
						const made = Result.try(() => uniqueSchemaName(label.text, allocation))
						assert.equal(Result.isSuccess(made), Option.isNone(label.fault) && fits, label.text)
						if (Result.isFailure(made)) {
							c.note(Option.isSome(label.fault) ? "a label refused" : "a label past the limit")
							return
						}
						const schema = made.success
						c.note("allocated")
						assert.equal(Buffer.byteLength(schema), bytes)
						assert.equal<string>(identifierOf(identity.schema(parsedSchemaName(schema))), schema)
						assert.deepEqual(allocatingPid(schema), Option.some(process.pid))
						const prefix = rolePrefix(schema)
						for (const name of mintedUnder(schema)) {
							if (Buffer.byteLength(name) <= maxIdentifierBytes) {
								assert.ok(Str.startsWith(prefix)(name), `${name} starts with ${prefix}`)
								assert.deepEqual(allocatingPid(name), Option.some(process.pid), name)
							}
						}
						const full = `${schema}__${role.text}`
						const named = Result.try(() => roleName(schema, role.text))
						const roleFits = Buffer.byteLength(full) <= maxIdentifierBytes
						assert.equal(Result.isSuccess(named), Option.isNone(role.fault) && roleFits, full)
						if (Result.isFailure(named)) {
							c.note(Option.isSome(role.fault) ? "a role refused" : "a role past the limit")
							return
						}
						c.note("a role named")
						assert.equal(named.success, full)
						assert.ok(Str.startsWith(prefix)(named.success))
						assert.deepEqual(allocatingPid(named.success), Option.some(process.pid))
					}),
			oracle: {
				kind: "specification",
				name: "the word rule on the generator's own words, and the bytes of the names they spell"
			},
			kept: [
				{
					token: ReplayToken(
						"test/unit/substrate/substrate.test.ts#substrateNamesAllocateExactlyTheNamesTheWordRuleAndTheByteLimitAdmitEveryNameUnderAnAllocationCarryingItsPrefixAndItsProcess:-:0.0.1.2.f.6.0.0.0.0.1.1.0.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
					),
					reason:
						"a label pg: its allocation is a schema name the naming door admits, which pg_ never leads",
					since: "2026-11-08"
				}
			],
			kills: []
		}
	)

/** psql's writer protocol reads psql's verbose report as its last severity line's message and each field's first one-line value. */
export const psqlWriterProtocolReadsPsqlsVerboseReportAsItsLastSeverityLinesMessageAndEachFieldsFirstOneLineValue =
	property.explore(
		(source) => ({
			before: source.draw(array(noiseGen, { min: 0, max: 2 })),
			reports: source.draw(array(reportGen, { min: 0, max: 2 })),
			after: source.draw(
				array(element(["NOTICE:  00000: later", "WARNING:  01000: later"] as const), {
					min: 0,
					max: 1
				})
			),
			sqlstate: source.draw(element(["23505", "XX000"] as const))
		}),
		{
			needs: {},
			situations: [
				"no report",
				"one report",
				"the last of several",
				"a field read",
				"a field skipped"
			] satisfies ReadonlyArray<Reached<ReportFeature>>,
			check:
				(_, c: Case<ReportFeature>) =>
				({ before, reports, after, sqlstate }) =>
					Effect.sync(() => {
						const stderr = Arr.join(
							Arr.map([...before, ...Arr.flatMap(reports, reportText), ...after], (l) => `${l}\n`),
							""
						)
						const read = parseVerboseError(sqlstate, stderr)
						const last = Arr.last(reports)
						if (Option.isNone(last)) {
							c.note("no report")
							assert.equal(read, undefined)
							return
						}
						c.note(reports.length === 1 ? "one report" : "the last of several")
						const r = last.value
						assert.deepEqual(read, {
							code: sqlstate,
							message: r.message,
							detail: firstOf(r, "detail"),
							hint: firstOf(r, "hint"),
							where: firstOf(r, "where"),
							schema: firstOf(r, "schema"),
							table: firstOf(r, "table"),
							column: firstOf(r, "column"),
							dataType: firstOf(r, "dataType"),
							constraint: constraintOf(r)
						})
						for (const f of Arr.getSomes(r.lines)) {
							c.note(Str.includes(" ")(f.value) ? "a field skipped" : "a field read")
						}
					}),
			oracle: {
				kind: "specification",
				name: "the last report printed, its message and each field's first one-line value"
			},
			kept: [],
			kills: []
		}
	)

/** Expectations run their attempt once and hold exactly for a PostgreSQL refusal of their SQLSTATE and constraint. */
export const expectationsRunTheirAttemptOnceAndHoldExactlyForAPostgreSQLRefusalOfTheirSQLSTATEAndConstraint =
	property.explore(
		(source) => ({
			ending: source.draw(endingGen),
			expected: source.draw(expectationGen)
		}),
		{
			needs: {},
			situations: [
				"sqlstate, held",
				"sqlstate, failed: succeeded",
				"sqlstate, failed: not PostgreSQL's",
				"sqlstate, failed: another SQLSTATE",
				"constraint, held",
				"constraint, failed: succeeded",
				"constraint, failed: not PostgreSQL's",
				"constraint, failed: another SQLSTATE",
				"constraint, failed: another constraint"
			] satisfies ReadonlyArray<Reached<ExpectFeature>>,
			check:
				(_, c: Case<ExpectFeature>) =>
				({ ending, expected }) =>
					Effect.gen(function* () {
						const runs = yield* Ref.make(0)
						const attempt: Effect.Effect<number, string | NotPostgres | ServerRecord> =
							Effect.andThen(
								Ref.update(runs, (n) => n + 1),
								endingOf(ending)
							)
						const expectation: Effect.Effect<PgErrorFields, ExpectationFailed> =
							expected.form === "sqlstate"
								? expectSqlstate(attempt, expected.code)
								: expectConstraint(attempt, expected.constraint, expected.code)
						const judged = yield* Effect.result(expectation)
						const ran = yield* Ref.get(runs)
						assert.equal(ran, 1, "the attempt runs once")
						const feature: Judgment =
							ending.kind === "succeeds"
								? "failed: succeeded"
								: ending.kind === "fails"
									? "failed: not PostgreSQL's"
									: ending.code !== expected.code
										? "failed: another SQLSTATE"
										: expected.form === "constraint" &&
											  !Option.contains(ending.constraint, expected.constraint)
											? "failed: another constraint"
											: "held"
						c.note(`${expected.form}, ${feature}`)
						if (feature !== "held") {
							assertVariant(judged, "_tag", "Failure", feature)
							assert.equal(judged.failure._tag, "ExpectationFailed")
							return
						}
						assertVariant(judged, "_tag", "Success")
						if (ending.kind === "refused") {
							assert.equal(judged.success.code, ending.code)
							assert.equal(judged.success.constraint, Option.getOrUndefined(ending.constraint))
						}
					}),
			oracle: {
				kind: "specification",
				name: "an expectation holds exactly for a refusal of its SQLSTATE and, where it names one, its constraint"
			},
			kept: [],
			kills: []
		}
	)
