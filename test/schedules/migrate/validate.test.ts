/**
 * A migration's Validate phase against existing and concurrent rows.
 *
 * A migration that installs or tightens a law validates the complete relevant state before it publishes the law, each
 * law a native constraint validated by PostgreSQL itself, a selected side's containment the foreign key from its STORED
 * generated column. So:
 *
 * - over violating rows, every kind of law refuses with its identity and leaves the rows exactly as they were, never an
 *   automatic deletion; the files before the failing one stay applied, and once the reviewer fixes the rows the apply
 *   resumes at it. The kinds: a candidate key, a row check, a containment and a selected side's one; a contract's
 *   predicate tightened, which is another definition and so another domain, named by its digest, the column converted
 *   to it by its cast with no placeholder, refused with 23514 by that domain's CHECK as the cast judges each stored
 *   value; a text pattern narrowed, which types the field by the narrowed pattern's domain, converted and refused the
 *   same way by that domain's CHECK; and a closed payload outside the narrowed pattern, written into Publish's
 *   validation of the closed facts by the reviewer, refused there with 23514 by the same CHECK, the folder as drafted
 *   then completing. The rows' keys and values are drawn;
 * - a writer racing the migration cannot slip a violation past a selected side's foreign key. The migration to the
 *   selected side's containment, drafted for an installation of v1 holding one worker, races two direct writers, each
 *   inserting one active assignment, of the stored worker or of a worker none holds: its Structure file adds the
 *   foreign key NOT VALID under its locks, which a writer's open insert holds the migration behind and a later writer
 *   waits on, and its validation sees every row committed before it. The property is the law itself, over every point
 *   of that box and every order of the five moves (each writer's insert and COMMIT, and the migration's apply): the
 *   migration succeeds only if no violating row was committed, and is refused otherwise, by the foreign key's
 *   validation with 23503 on the law; a lawful writer commits; a violating writer commits only before the law, and is
 *   refused by it with 23503 otherwise, always when it begins after the migration ended, never when it ended before
 *   the migration began; the rows are exactly the committed writers' and the stored worker, never deleted; and a
 *   transient abort, of a writer or the migration, has a concurrent cause. Each case installs afresh, since a
 *   migration applies once, and the order is drawn decision by decision from the case, which the exhaustion
 *   enumerates.
 *
 * The migrations are drafted by generateMigration from the installed snapshot and applied by applyOnSession, exactly as
 * `grizzle migrate` applies them, as the database owner; each folder is applied with the same files every time,
 * so a resumed apply finds the files it already ran unchanged.
 *
 * Oracle: the specification restated over the data each case constructs to violate every law once, read by the law
 * each refusal names (its constraint through the tightened version's laws, or its domain's CHECK); and, for the race,
 * the law itself over every committed row, judged on each interleaving of the five moves.
 *
 * Features: the race's ends (the migration succeeded, refused by the law or aborted), each waiting on the other, and a
 * violation committed before the law or refused by it.
 */

import { assert, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { applyOnSession } from "#adapter/migrate/apply.ts"
import type { MigrationPlace, ServerReport } from "#adapter/migrate/errors.ts"
import type { FolderTexts } from "#adapter/migrate/input.ts"
import { reportedOwner } from "#adapter/witness/keylaw.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { lawsOfConstraint } from "#compiler/ir/products.ts"
import { constraintLawMap } from "#compiler/laws/model/model.ts"
import {
	Assignment,
	assignmentColumns,
	assignmentFields,
	assignmentOf,
	assignmentWorker,
	backendOf,
	Desk,
	deskColumns,
	deskFields,
	type ForeignKeyLaw,
	issuedDesk,
	judgeRacing,
	type Migrated,
	missingWorker,
	narrowedPayload,
	nonNegative,
	prepare,
	type RacingFeature,
	racingGen,
	refusalName,
	type Refusing,
	rewrittenRow,
	staffed,
	staffing,
	storedWorker,
	succeededStep,
	tightened,
	ValidatedBadge,
	validatedDomainCheck,
	violatingRuns,
	violationsGen,
	Worker,
	workerColumns,
	workerFields,
	workerName
} from "#test/schedules/migrate/validate.fixtures.ts"
import { chunked, joined } from "#test/support/chunked.ts"
import { lawIdOf, lawNamesOf } from "#test/support/kernel/naming.ts"
import { parsedTarget, statementRows, type TextTarget } from "#test/support/pg/migrate/support.ts"
import { type GrizzleActor, openActors } from "#test/support/schedules/actors.ts"
import {
	allowed,
	everyRelation,
	exploreEnv,
	exploreInterleavings,
	interleaveStep,
	refusedJudgment,
	type Txn
} from "#test/support/schedules/interleave.ts"
import { beginSerializableAction } from "#test/support/schedules/types.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * A migration's Validate phase over violating rows every kind of law refuses with its identity and leaves the rows intact.
 *
 * Its pre-conversion budget: runs violatingRuns, no coverage cases, so the runner's 200 steered (test/schedules/migrate/validate.test.ts at d8eed1786).
 */
export const aMigrationsValidatePhaseOverViolatingRowsEveryKindOfLawRefusesWithItsIdentityAndLeavesTheRowsIntact =
	property.explore(violationsGen, {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [],
		check:
			({ substrate }) =>
			(v) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							const [first, second, missing, later] = v.workers
							const [shared, renamed, fixedName] = v.names
							const [negative, positive] = v.hours
							const [negativeAssignment, orphanAssignment] = v.assignments
							const [desk, coded, laterDesk] = v.desks
							const x = yield* prepare(tightened, (names) => [
								`INSERT INTO ${names.table(Worker)} (${workerColumns(names)}) VALUES (${first}, '${shared}'), (${second}, '${shared}')`,
								`INSERT INTO ${names.table(Assignment)} (${assignmentColumns(names)}) VALUES (${negativeAssignment}, ${first}, true, ${negative}, 1), (${orphanAssignment}, ${missing}, false, ${positive}, ${v.rate})`,
								`INSERT INTO ${names.table(ValidatedBadge)} (${names.column(ValidatedBadge, "id")}, ${names.column(ValidatedBadge, "desk")}, ${names.column(ValidatedBadge, "issued")}) VALUES (${v.badge}, ${desk}, true)`,
								`INSERT INTO ${names.table(Desk)} (${deskColumns(names)}) VALUES (${coded}, '${v.code}')`
							])
							const { names } = x
							const worker = names.table(Worker)
							/** The laws of the tightened version, which is not installed yet. */
							const next = tightened(x.done.schema)
							/**
							 * A table's law by what PostgreSQL names: its constraint or its key's index under the table PostgreSQL
							 * reports, which the tightened version's laws map to it (a candidate key's unique index fails its build in
							 * Indexes with 23505).
							 */
							const tightenedLaws = constraintLawMap(lawNamesOf(next).model.constraints)
							const reportsLaw =
								(id: LawId) =>
								(server: ServerReport): boolean => {
									if (server.by !== "server" || server.error.constraint === undefined) {
										return false
									}
									const owner = reportedOwner(server.error, new Set([names.schema]))
									return (
										owner !== undefined &&
										Arr.contains(
											lawsOfConstraint(tightenedLaws, owner, server.error.constraint) ?? [],
											id
										)
									)
								}
							/**
							 * The narrowed pattern's domain, which types the desk's code and FloorCode's payload in the next version:
							 * one domain, since a pattern has one domain whatever uses it, and a closed relation has no table to name
							 * it by, its payload cast to the domain in Publish's validation of its facts, so Desk's column names it.
							 */
							const codeDomain = x.nextNames.textDomain(Desk, "code")
							const floorDomain = codeDomain
							/** Desk's code's pattern law, which names both of the domain's refusals, over its rows and its payload. */
							const codeLaw = x.nextNames.patternLaw(Desk, "code")
							/** The tightened contract's domain, which types the assignment's rate in the next version. */
							const rateDomain = x.nextNames.contract("Rate")
							if (rateDomain.kind !== "checked") {
								return assert.fail("the tightened contract Rate checks its predicate")
							}
							/**
							 * The reviewer writes Ground's payload out of the narrowed pattern into Publish's validation of the
							 * closed facts; restoring the folder as drafted is the fix. The file the edit changes is the one
							 * validating the closed facts.
							 */
							const drafted = x.drafted
							const payloadFiles = Arr.filter(
								drafted.files,
								(file) => narrowedPayload(joined(file.text)) !== joined(file.text)
							)
							assert.equal(
								payloadFiles.length,
								1,
								"Publish validates FloorCode's payloads in one file"
							)
							const payloadFile = defined(
								payloadFiles[0],
								"the file validating FloorCode's payloads"
							).name
							/** Whether a refusal is in the file validating the closed facts. */
							const inPayloadFile = (place: MigrationPlace): boolean =>
								(place.kind === "file" || place.kind === "statement") && place.file === payloadFile
							/** The reviewer's data step for each law, which the migration never performs itself. */
							const fixes: ReadonlyArray<Refusing> = [
								{
									law: lawIdOf(next, workerName),
									over: "rows",
									reports: reportsLaw(lawIdOf(next, workerName)),
									fix: rewrittenRow(
										worker,
										workerFields(names),
										{ column: names.column(Worker, "id"), value: `${second}` },
										{ column: names.column(Worker, "name"), value: `'${renamed}'` }
									)
								},
								{
									law: lawIdOf(next, nonNegative),
									over: "rows",
									reports: reportsLaw(lawIdOf(next, nonNegative)),
									fix: rewrittenRow(
										names.table(Assignment),
										assignmentFields(names),
										{ column: names.column(Assignment, "id"), value: `${negativeAssignment}` },
										{ column: names.column(Assignment, "hours"), value: `${positive}` }
									)
								},
								{
									law: lawIdOf(next, assignmentWorker),
									over: "rows",
									reports: reportsLaw(lawIdOf(next, assignmentWorker)),
									fix: `INSERT INTO ${worker} (${workerColumns(names)}) VALUES (${missing}, '${fixedName}')`
								},
								{
									law: lawIdOf(next, issuedDesk),
									over: "rows",
									reports: reportsLaw(lawIdOf(next, issuedDesk)),
									fix: `INSERT INTO ${names.table(Desk)} (${deskColumns(names)}) VALUES (${desk}, 'abc')`
								},
								{
									law: rateDomain.law,
									over: "rows",
									reports: (server, place) =>
										validatedDomainCheck(rateDomain)(server) && !inPayloadFile(place),
									fix: rewrittenRow(
										names.table(Assignment),
										assignmentFields(names),
										{ column: names.column(Assignment, "id"), value: `${orphanAssignment}` },
										{ column: names.column(Assignment, "rate"), value: "100" }
									)
								},
								{
									law: codeLaw,
									over: "rows",
									reports: (server, place) =>
										validatedDomainCheck(codeDomain)(server) && !inPayloadFile(place),
									fix: rewrittenRow(
										names.table(Desk),
										deskFields(names),
										{ column: names.column(Desk, "id"), value: `${coded}` },
										{ column: names.column(Desk, "code"), value: "'abc'" }
									)
								}
							]
							const payloads = Arr.map(x.target.folders, (f): FolderTexts =>
								f === drafted
									? {
											...f,
											files: Arr.map(f.files, (file) => ({
												...file,
												text: chunked(narrowedPayload(joined(file.text)))
											}))
										}
									: f
							)
							const payload: Refusing = {
								law: codeLaw,
								over: "a payload",
								reports: (server, place) =>
									validatedDomainCheck(floorDomain)(server) && inPayloadFile(place),
								fix: "restore the folder as drafted"
							}
							let target: TextTarget = { snapshot: x.target.snapshot, folders: payloads }
							const refused: Array<string> = []
							for (let round = 0; round <= fixes.length + 1; round++) {
								const before = yield* x.contents
								const result = yield* Effect.result(
									applyOnSession(x.migrator, [parsedTarget(target)])
								)
								if (result._tag === "Success") {
									break
								}
								const e = result.failure
								const server = e.server
								const found = Option.getOrThrowWith(
									Arr.findFirst([...fixes, payload], (f) => f.reports(server, e.place)),
									() =>
										new Error(
											`refused by no law this data violates: ${Formatter.format(server)}: ${e.message}`
										)
								)
								assert.ok(
									!refused.includes(refusalName(found)),
									`refused by a law this data violates, once: ${Formatter.format(server)}: ${e.message}`
								)
								refused.push(refusalName(found))
								const contents = yield* x.contents
								assert.deepEqual(
									contents,
									before,
									`the refusal by ${refusalName(found)} left the rows intact`
								)
								if (found === payload) {
									target = x.target
								} else {
									yield* x.dataStep(found.fix)
								}
							}
							unorderedEqual(
								refused,
								Arr.map([...fixes, payload], refusalName),
								"every law refused once where the data violates it"
							)
							yield* Effect.result(applyOnSession(x.migrator, [parsedTarget(x.target)]))
							const violation = yield* Effect.result(
								x.owner(
									`INSERT INTO ${worker} (${workerColumns(names)}) VALUES (${later}, '${shared}')`
								)
							)
							assert.equal(violation._tag, "Failure", "the candidate key is installed")
							const narrowed = yield* Effect.result(
								x.owner(
									`INSERT INTO ${names.table(Desk)} (${deskColumns(names)}) VALUES (${laterDesk}, '${v.code}')`
								)
							)
							assert.equal(narrowed._tag, "Failure", "the narrowed pattern is installed")
						})
					),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "every law the constructed data violates refuses once, by its identity, leaving the rows as they were, and holds once fixed"
		},
		budget: { runs: violatingRuns, steered: 200 },
		kept: [],
		kills: []
	})

/**
 * A migration's Validate phase a writer racing the migration cannot slip a violation past a selected side's foreign key.
 */
export const aMigrationsValidatePhaseAWriterRacingTheMigrationCannotSlipAViolationPastASelectedSidesForeignKey =
	property.exhaust(finite(racingGen), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: [
			"the migration succeeded",
			"the migration refused by the law",
			"the migration waited on a writer",
			"a writer waited on the migration",
			"a violation committed before the law",
			"a violation refused by the law"
		] satisfies ReadonlyArray<Reached<RacingFeature>>,
		check:
			({ substrate }, c: Case<RacingFeature>) =>
			(k) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							const x = yield* prepare(staffed, (names) => [
								`INSERT INTO ${names.table(Worker)} (${workerColumns(names)}) VALUES (${storedWorker}, 'a')`
							])
							const { names } = x
							const fk: ForeignKeyLaw = {
								laws: constraintLawMap(lawNamesOf(staffed(x.done.schema)).model.constraints),
								schema: names.schema,
								refusing: lawIdOf(staffed(x.done.schema), staffing)
							}
							const direct = yield* openActors(x.s, {
								w1: { kind: "raw", as: x.writer },
								w2: { kind: "raw", as: x.writer }
							})
							const pid = yield* Effect.map(
								Effect.orDie(
									statementRows(x.migrator, "SELECT pg_catalog.pg_backend_pid()::text", [])
								),
								backendOf
							)
							const m: GrizzleActor = {
								name: "m",
								role: x.s.owner.role,
								backend: Effect.succeedSome(pid)
							}
							const env = yield* exploreEnv(x.s)
							const assignment = names.table(Assignment)
							const insertOf = (w: "w1" | "w2") =>
								`INSERT INTO ${assignment} (${assignmentColumns(names)}) VALUES (${assignmentOf[w]}, ${k[w] === "lawful" ? storedWorker : missingWorker}, true, 8, 1)`
							const migrated = new Map<"m", Migrated>()
							const txns: ReadonlyArray<Txn> = [
								...Arr.map(["w1", "w2"] as const, (w): Txn => ({
									kind: "direct",
									begin: beginSerializableAction,
									session: w,
									steps: [interleaveStep(insertOf(w), everyRelation)],
									end: "commit",
									after: undefined
								})),
								{
									kind: "grizzle",
									session: "m",
									steps: [
										{
											label: "migrate apply",
											outcome: Effect.map(
												Effect.result(applyOnSession(x.migrator, [parsedTarget(x.target)])),
												(r) => {
													migrated.set("m", r)
													return succeededStep
												}
											),
											footprint: everyRelation
										}
									],
									after: undefined
								}
							]
							const ids = (sql: string) =>
								Effect.map(env.observer.queryValues(sql, []), (rows) =>
									Arr.map(rows, (row) => String(row[0]))
								)
							yield* exploreInterleavings(
								env,
								{ direct, grizzle: { m } },
								{
									name: "a migration racing two writers",
									txns,
									reset: Effect.void,
									state: { _tag: "Unread" },
									model: (run) =>
										Effect.gen(function* () {
											const stored = {
												assignments: yield* ids(
													`SELECT ${names.column(Assignment, "id")}::text FROM ${assignment}`
												),
												workers: yield* ids(
													`SELECT ${names.column(Worker, "id")}::text FROM ${names.table(Worker)}`
												)
											}
											const judged = judgeRacing(
												k,
												fk,
												defined(migrated.get("m"), "the migration's result"),
												run,
												stored
											)
											if (Result.isFailure(judged)) {
												return refusedJudgment(judged.failure)
											}
											c.noteAll(judged.success)
											return allowed
										})
								},
								{ kind: "drawn", nature: c }
							)
						})
					),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "the selected side's containment over every committed row: the migration succeeds only if no violation committed"
		},
		box: "each racing writer's assignment lawful or violating, under every order of the five moves",
		kept: [],
		kills: []
	})
