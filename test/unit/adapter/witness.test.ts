import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { noCoverage, requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { installationWitness } from "#adapter/witness/index.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { ConstraintName, DomainName, LawId } from "#compiler/core/ids.ts"
import { codeOf } from "#compiler/ir/codes.ts"
import { constraintLaw } from "#compiler/ir/products.ts"
import { type ConcurrentChangeTag, encodeRefusalDetail } from "#compiler/write/refusal.ts"
import { awkwardCode, Club, Clubs, Member } from "#test/pg/laws/outcomes/schemas.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { t7 } from "#test/support/fixtures/golden/work.ts"
import {
	constraintOf,
	installationNamesOf,
	installationOf,
	lawIdOf,
	lawNamesOf,
	type NamedRelation,
	type Names,
	parsedName,
	spelled,
	wild
} from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { nothingReported, type Reported, serverError } from "#test/support/server-error.ts"

/**
 * Witness decoding in the adapter, without a database: the classifier of packages/grizzle/src/adapter/witness over
 * the ErrorResponse fields PostgreSQL reports, for the worked example's Work and the Clubs schema of test/pg/laws/outcomes.
 *
 It pins (a DETAIL decoded into the refused key is the write statements' on PostgreSQL, which raise real ones):
 * - a native violation (23505, 23503, 23514, a selected side's UNIQUE) gives the law its constraint name maps to through
 *   the key-law map and no key, and no part of PostgreSQL's DETAIL reaches the witness;
 * - a domain constraint reports its domain's law, the text refinement domains included, by the domain PostgreSQL
 *   reports as the violation's data type, at any name length, never by its name;
 * - everything else is not a law outcome: another SQLSTATE class, no constraint, an unknown constraint, another schema,
 *   a 23000 on a native constraint, a native SQLSTATE on a law's identity;
 * - a write statement's raised refusal: a 23000 whose DETAIL carries grizzle's tag gives its law and the refused key, and
 *   one without its DETAIL, or under a foreign DETAIL, no outcome (the outcome mapping makes it an ExecutionFailure
 *   carrying the server's report, test/unit/adapter/transactions.test.ts); a 40Z01 with an `a` DETAIL gives the
 *   concurrent change it names at a relation of the installation, and one without its DETAIL no outcome; a refusal of
 *   a law the installation does not have is no law outcome;
 * - the classifier's answers are the outcome mapping's `rejected`, `aborted` and `failed` cases, so packages/grizzle/src/adapter/outcomes
 *   can consume it as its hook.
 */
const artifactsOf = (schema: unknown) => succeeded(testArtifacts(schema, testCompile))

const work = artifactsOf(W.Work)
const clubs = artifactsOf(Clubs)

const witnessOf = (artifacts: ReturnType<typeof artifactsOf>) => installationWitness(artifacts)

const workWitness = witnessOf(work)
const clubsWitness = witnessOf(clubs)

/** The native constraints the tests classify by, and the laws they report, each named by src from its schema. */
const taskPk = constraintOf(W.Work, W.Task, "pk", ["id"])
const taskNoteFk = constraintOf(W.Work, W.TaskNote, "fk", ["task"])
const [memberOfClub, captainKey, emailKey, positiveSeats] = Clubs.statements
const clubPk = constraintOf(Clubs, Club, "pk", ["region", "number", "code"])
const memberEmailKey = constraintOf(Clubs, Member, "key", ["email"])
const memberEmailLaw = lawIdOf(Clubs, emailKey)

/**
 * The domains the tests classify by, each named by src: Clubs' Seats contract and its code and email refinements, Work's
 * Cents contract and its account name refinement, and each domain's law.
 */
/** A contract's CHECK, named by its domain's definition digest (physical/ddl/names.ts contractNamed). */
const checkedContract = (contract: ReturnType<ReturnType<typeof lawNamesOf>["contract"]>) => {
	if (contract.kind !== "checked") {
		throw new Error(`the contract of ${contract.domain} has a CHECK`)
	}
	return contract
}
const seatsContract = checkedContract(lawNamesOf(Clubs).contract("Seats"))
const centsContract = checkedContract(lawNamesOf(W.Work).contract("Cents"))
const seatsCheck = seatsContract.constraint
const centsCheck = centsContract.constraint
const clubsNames = installationNamesOf(installationOf(Clubs, { kind: "declared" }))
const workNames = installationNamesOf(installationOf(W.Work, { kind: "declared" }))
const clubKeyLaw = defined(
	constraintLaw(
		clubs.constraintToLaw,
		{ kind: "table", name: clubsNames.tableIdent(Club) },
		clubPk
	),
	"Club's key law"
)
const workLaws = lawNamesOf(W.Work)
/** Task's key law, a law of Work's theory: the identity a write statement raises a refusal of it under. */
const taskKeyLaw = workLaws.primaryKeyLaw(W.Task)

/**
 * A domain constraint's violation in the installation's schema that reports neither a table nor a data type: its
 * constraint name alone.
 */
const nameAlone = (witness: typeof clubsWitness, constraint: ConstraintName) =>
	witness.classify(
		serverError({ ...nothingReported, sqlstate: "23514", constraint, schema: witness.laws.schema }),
		[]
	)

/** The text refinement domain an installation types a column by: its CHECK's name, its domain and its law. */
const refinementOf = (names: Names, relation: NamedRelation, field: string) => {
	const table = names.tableIdent(relation)
	const column = names.columnIdent(relation, field)
	const assignment = Option.getOrThrowWith(
		Arr.findFirst(names.installation.textDomains, (d) =>
			Arr.some(d.uses, (u) => u.table === table && u.column === column)
		),
		() => new Error(`${relation.name}.${field} is typed by a text refinement domain`)
	)
	return {
		constraint: assignment.constraint,
		domain: assignment.name,
		law: identifierOf(identity.patternLaw(assignment.named))
	}
}
const code = refinementOf(clubsNames, Club, "code")
const email = refinementOf(clubsNames, Member, "email")
const accountName = refinementOf(workNames, W.Account, "name")
const key = (text: string) => [{ field: "id", text }]

/** The laws the key-law map reads a domain's constraint as, under the domain PostgreSQL reports. */
const lawIdsOf = (
	witness: typeof clubsWitness,
	constraint: ConstraintName,
	domain: DomainName
): ReadonlyArray<LawId> =>
	Arr.map(
		defined(witness.laws.lawsOf(constraint, { kind: "domain", name: domain }), constraint).laws,
		(l) => l.law
	)

describe("witness decoding (packages/grizzle/src/adapter/witness)", () => {
	describe("a write statement's raised refusal", () => {
		it("reads the law and the refused key only through the DETAIL a refusal always raises, never guessing them", () => {
			const raised = { ...nothingReported, sqlstate: "23000", constraint: taskKeyLaw }
			const asRefusal = workWitness.classify(
				serverError({
					...raised,
					detail: encodeRefusalDetail({ kind: "law", relation: "Task" }, key(t7))
				}),
				[]
			)
			assert.deepEqual(asRefusal, {
				kind: "rejected",
				laws: [defined(work.described.get(taskKeyLaw), "Task's key law's description")],
				witness: { kind: "key", relation: "Task", values: { id: t7 } }
			})
			assert.ok(asRefusal?.kind === "rejected" && asRefusal.witness.kind === "key")
			assert.ok(Object.isFrozen(asRefusal.witness), "the witness is frozen")
			assert.ok(Object.isFrozen(asRefusal.witness.values), "its key's values are frozen")
			/** No DETAIL, or one under no tag of grizzle's (a foreign trigger's), is no law outcome. */
			assert.equal(workWitness.classify(serverError(raised), []), undefined)
			assert.equal(
				workWitness.classify(serverError({ ...raised, detail: `["Task","${t7}"]` }), []),
				undefined
			)
		})

		/** A Region handle's code as a refusal's DETAIL carries it: the digits of the code the installation holds for it. */
		const regionCode = (handle: string): string =>
			String(
				codeOf(
					defined(clubs.names.codes.rosters.get(parsedName("Region")), "Region's codec"),
					handle
				)
			)

		it("decodes a refused key of several fields through the columns' codecs, a code and an escaped text among them", () => {
			const verdict = clubsWitness.classify(
				serverError({
					...nothingReported,
					sqlstate: "23000",
					constraint: clubKeyLaw,
					detail: encodeRefusalDetail({ kind: "law", relation: "Club" }, [
						{ field: "region", text: regionCode("North") },
						{ field: "number", text: "7" },
						{ field: "code", text: awkwardCode }
					])
				}),
				[]
			)
			assert.ok(verdict?.kind === "rejected", "a refused key is a rejection")
			assert.deepEqual(verdict.laws, [
				defined(clubs.described.get(clubKeyLaw), "the key law's description")
			])
			assert.deepEqual(verdict.witness, {
				kind: "key",
				relation: "Club",
				values: { region: "North", number: 7n, code: awkwardCode }
			})
		})

		it.effect(
			"decodes a concurrent change into its TransientFailure reason at the relation",
			(ctx) =>
				searched(
					ctx,
					exhaust(
						{
							suite: "unit/adapter/witness/concurrent-change",
							generator: element<ConcurrentChangeTag>(["PutTargetConflict", "SpanKeyChange"]),
							literal: Formatter.format,
							limit: 2,
							coverage: requiredInSpace<ConcurrentChangeTag>([
								"PutTargetConflict",
								"SpanKeyChange"
							]),
							caseHang
						},
						(reason, c) =>
							Effect.sync(() => {
								c.note(reason)
								assert.deepEqual(
									workWitness.classify(
										serverError({
											...nothingReported,
											sqlstate: "40Z01",
											constraint: taskPk,
											detail: encodeRefusalDetail(
												{ kind: "change", reason, relation: "Task" },
												key(t7)
											)
										}),
										[]
									),
									{ kind: "aborted", reason: { _tag: reason, relation: "Task" } }
								)
							})
					)
				)
		)

		it("reads a concurrent change only through its DETAIL, never guessing a reason without one", () => {
			assert.equal(
				workWitness.classify(
					serverError({ ...nothingReported, sqlstate: "40Z01", constraint: taskPk }),
					[]
				),
				undefined
			)
		})

		it.effect(
			"a refusal of a law the installation does not have, a native constraint's name among them, is no law outcome",
			(ctx) =>
				searched(
					ctx,
					exhaust(
						{
							suite: "unit/adapter/witness/no-such-law",
							generator: element<string>([taskPk, taskNoteFk, wild.constraint("no_such_law")]),
							literal: Formatter.format,
							limit: 3,
							coverage: noCoverage,
							caseHang
						},
						(constraint) =>
							Effect.sync(() => {
								assert.equal(
									workWitness.classify(
										serverError({
											...nothingReported,
											sqlstate: "23000",
											constraint,
											detail: encodeRefusalDetail({ kind: "law", relation: "Task" }, key(t7))
										}),
										[]
									),
									undefined,
									constraint
								)
							})
					)
				)
		)
	})

	describe("a native violation reports its constraint's law and no key", () => {
		it.effect(
			"maps each native SQLSTATE through the key-law map, keeping none of PostgreSQL's text",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const prose = "Failing row contains (North, 7, secret payload, 0)."
						/**
						 * A relation's key law is its primary key's entry of the key-law map; a named check's constraint, and a
						 * selected side's key's UNIQUE over its law columns, are the ones that report their laws.
						 */
						const checkLaw = lawIdOf(Clubs, positiveSeats)
						const checkConstraint = lawNamesOf(Clubs).constraintOf(checkLaw, "TableCheck")
						const captainLaw = lawIdOf(Clubs, captainKey)
						const captainConstraint = lawNamesOf(Clubs).constraintOf(captainLaw, "Unique")
						const cases: Arr.NonEmptyReadonlyArray<readonly [Reported, LawId]> = [
							[
								{
									...nothingReported,
									sqlstate: "23505",
									constraint: memberEmailKey,
									table: clubsNames.tableIdent(Member)
								},
								memberEmailLaw
							],
							[
								{
									...nothingReported,
									sqlstate: "23505",
									constraint: clubPk,
									table: clubsNames.tableIdent(Club)
								},
								clubKeyLaw
							],
							[
								{
									...nothingReported,
									sqlstate: "23505",
									constraint: captainConstraint,
									table: clubsNames.tableIdent(Member)
								},
								captainLaw
							],
							[
								{
									...nothingReported,
									sqlstate: "23503",
									constraint: constraintOf(Clubs, Member, "fk", ["region", "number", "code"]),
									table: clubsNames.tableIdent(Member)
								},
								lawIdOf(Clubs, memberOfClub)
							],
							[
								{
									...nothingReported,
									sqlstate: "23514",
									constraint: checkConstraint,
									table: clubsNames.tableIdent(Club)
								},
								checkLaw
							],
							[
								{
									...nothingReported,
									sqlstate: "23514",
									constraint: seatsCheck,
									dataType: seatsContract.domain
								},
								seatsContract.law
							],
							[
								{
									...nothingReported,
									sqlstate: "23514",
									constraint: code.constraint,
									dataType: code.domain
								},
								code.law
							]
						]
						return yield* exhaust(
							{
								suite: "unit/adapter/witness/native-violations",
								generator: element<readonly [Reported, LawId]>(cases),
								literal: (row) => Formatter.format(row[0].constraint),
								limit: cases.length,
								coverage: noCoverage,
								caseHang
							},
							(row) =>
								Effect.sync(() => {
									const [fields, law] = row
									assert.deepEqual(
										clubsWitness.classify(
											serverError({
												...nothingReported,
												...fields,
												schema: clubsWitness.laws.schema,
												detail: prose
											}),
											[]
										),
										{
											kind: "rejected",
											laws: [defined(clubs.described.get(law), "the law's description")],
											witness: { kind: "unreported" }
										},
										String(fields.constraint)
									)
								})
						)
					})
				)
		)

		it.effect("reports each domain constraint's law by its data type", (ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					assert.deepEqual(lawIdsOf(clubsWitness, seatsCheck, seatsContract.domain), [
						seatsContract.law
					])
					assert.deepEqual(lawIdsOf(workWitness, accountName.constraint, accountName.domain), [
						accountName.law
					])
					assert.deepEqual(lawIdsOf(workWitness, centsCheck, centsContract.domain), [
						centsContract.law
					])
					return yield* exhaust(
						{
							/** The text refinements' domains of Clubs. */
							suite: "unit/adapter/witness/text-domains",
							generator: element<typeof code>([code, email]),
							literal: (r) => Formatter.format(r.constraint),
							limit: 2,
							coverage: noCoverage,
							caseHang
						},
						(r) =>
							Effect.sync(() => {
								assert.deepEqual(lawIdsOf(clubsWitness, r.constraint, r.domain), [r.law])
							})
					)
				})
			)
		)

		it.effect("never classifies a domain constraint by its name alone", (ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/adapter/witness/name-alone",
						generator: element<readonly [typeof clubsWitness, ConstraintName]>([
							[clubsWitness, seatsCheck],
							[clubsWitness, code.constraint],
							[clubsWitness, email.constraint],
							[workWitness, centsCheck],
							[workWitness, accountName.constraint],
							[clubsWitness, spelled.constraint("__text_other__check")],
							[clubsWitness, centsCheck]
						]),
						literal: (row) => Formatter.format(row[1]),
						limit: 7,
						coverage: noCoverage,
						caseHang
					},
					([witness, constraint]) =>
						Effect.sync(() => {
							assert.equal(nameAlone(witness, constraint), undefined, constraint)
						})
				)
			)
		)
	})

	describe("anything else is not a law outcome", () => {
		it("answers undefined for another class, no constraint, an unknown constraint or another schema", () => {
			/**
			 * A native SQLSTATE never carries a law's identity.
			 *
			 * A native violation that reports neither its table nor a data type.
			 *
			 * A constraint name is read only under its own table.
			 */
			const cases: ReadonlyArray<Reported> = [
				{ ...nothingReported, sqlstate: "40001" },
				{ ...nothingReported, sqlstate: "40P01", constraint: taskKeyLaw },
				{ ...nothingReported, sqlstate: "42501", constraint: taskPk },
				{ ...nothingReported, sqlstate: "23505" },
				{
					...nothingReported,
					sqlstate: "23502",
					constraint: wild.constraint("task_account_not_null")
				},
				{
					...nothingReported,
					sqlstate: "23505",
					constraint: wild.constraint("unrelated_pk"),
					schema: work.names.schema,
					table: workNames.tableIdent(W.Task)
				},
				{
					...nothingReported,
					sqlstate: "23505",
					constraint: taskPk,
					schema: work.names.schema,
					table: workNames.tableIdent(W.TaskNote)
				},
				{ ...nothingReported, sqlstate: "23505", constraint: taskPk, schema: work.names.schema },
				{
					...nothingReported,
					sqlstate: "23505",
					constraint: taskPk,
					schema: "another_schema",
					table: workNames.tableIdent(W.Task)
				},
				{
					...nothingReported,
					sqlstate: "23000",
					constraint: taskKeyLaw,
					schema: "another_schema",
					detail: encodeRefusalDetail({ kind: "law", relation: "Task" }, key(t7))
				},
				{
					...nothingReported,
					sqlstate: "23514",
					constraint: taskKeyLaw,
					schema: workWitness.laws.schema
				}
			]
			for (const [i, failure] of cases.entries()) {
				assert.equal(
					workWitness.classify(serverError({ ...nothingReported, ...failure }), []),
					undefined,
					`case ${i}: ${failure.sqlstate}`
				)
			}
		})

		it("accepts the installation's own schema on a native violation", () => {
			assert.equal(
				workWitness.classify(
					serverError({
						...nothingReported,
						sqlstate: "23505",
						constraint: taskPk,
						schema: work.names.schema,
						table: workNames.tableIdent(W.Task)
					}),
					[]
				)?.kind,
				"rejected"
			)
		})
	})
})
