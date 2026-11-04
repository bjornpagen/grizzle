import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { noCoverage, requiredInSpace } from "@grizzle/testing/features"
import { element, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	Option,
	Record as Rec,
	String as Str
} from "effect"
import { installationWitness } from "#adapter/witness/index.ts"
import { identifierOf, identity, maxIdentifierBytes } from "#compiler/core/identity.ts"
import type { ConstraintName, LawId } from "#compiler/core/ids.ts"
import { namedDetail } from "#compiler/ir/law.ts"
import { constraintLaw } from "#compiler/ir/products.ts"
import { parseSchemaInput, schemaArtifacts } from "#compiler/program/schema.ts"
import { type ConcurrentChangeTag, encodeRefusalDetail } from "#compiler/write/refusal.ts"
import { awkwardCode, Club, Clubs, Member } from "#test/pg/laws/outcomes/schemas.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { encodeDetail } from "#test/support/detail.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { t7 } from "#test/support/fixtures/golden/work.ts"
import { decodedSchema, f, ge, literal, relation, value } from "#test/support/fixtures/ir/desc.ts"
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
import { nothingReported, type Reported, serverError } from "#test/support/server-error.ts"

/**
 * Witness decoding in the adapter, without a database: the classifier of packages/grizzle/src/adapter/witness over
 * the ErrorResponse fields PostgreSQL reports, for the worked example's Work and the Clubs schema of test/pg/laws/outcomes.
 *
 * It pins (a DETAIL decoded into the violating or refused key is the law families' on PostgreSQL, which raise real
 * ones):
 * - a missing or malformed DETAIL from a law function is no law outcome, never a guessed law: the outcome mapping
 *   makes it an ExecutionFailure carrying the server's report (test/unit/adapter/transactions.test.ts);
 * - a native violation (23505, 23503, 23514, a partial UNIQUE index) gives the law its constraint name maps to through
 *   the key-law map and no key, and no part of PostgreSQL's DETAIL reaches the witness;
 * - a domain constraint reports its domain's law, the text refinement domains included, by the domain PostgreSQL
 *   reports as the violation's data type, at any name length, never by its name;
 * - everything else is not a law outcome: another SQLSTATE class, no constraint, an unknown constraint, another schema,
 *   a 23000 on a native constraint, a native SQLSTATE on a residual law's identity;
 * - a write statement's raised refusal: a 40Z01 with an `a` DETAIL gives the concurrent change it names at a relation
 *   of the installation, and one without its DETAIL no outcome; a malformed refusal DETAIL, an unknown relation or
 *   field, or a law the installation does not have is no law outcome, and the DETAIL's tag, never the law, tells a
 *   refusal from a law function's violation;
 * - the classifier's answers are the outcome mapping's `rejected`, `aborted` and `failed` cases, so packages/grizzle/src/adapter/outcomes
 *   can consume it as its hook.
 */
const artifactsOf = (schema: unknown) => {
	const input = succeeded(parseSchemaInput(schema))
	return succeeded(
		schemaArtifacts(input, {
			installation: undefined,
			vectorSchema: undefined
		})
	)
}

const work = artifactsOf(W.Work)
const clubs = artifactsOf(Clubs)

const witnessOf = (artifacts: ReturnType<typeof artifactsOf>) => installationWitness(artifacts)

const workWitness = witnessOf(work)
const clubsWitness = witnessOf(clubs)

/**
 * Work's one residual law, its alternatives over Task's kind, as its installation compiles it: an alternatives value is
 * no one statement, so lawIdOf cannot name it. A law function raises its law id as the constraint.
 */
const taskKind = ((residuals: typeof work.laws.residuals) => {
	const [only, ...more] = residuals
	if (only === undefined || more.length > 0) {
		throw new Error("Work compiles exactly one residual law")
	}
	return only
})(work.laws.residuals)

/** The native constraints the tests classify by, and the laws they report, each named by src from its schema. */
const taskPk = constraintOf(W.Work, W.Task, "pk", ["id"])
const taskNoteFk = constraintOf(W.Work, W.TaskNote, "fk", ["task"])
const [memberOfClub, , captainCount, emailKey, positiveSeats] = Clubs.statements
const clubPk = constraintOf(Clubs, Club, "pk", ["region", "number", "code"])
const memberEmailKey = constraintOf(Clubs, Member, "key", ["email"])
const memberEmailLaw = lawIdOf(Clubs, emailKey)

/**
 * The domains the tests classify by, each named by src: Clubs' Seats contract and its code and email refinements, Work's
 * Cents contract and its account name refinement, and each domain's law.
 */
const seatsCheck = identifierOf(identity.domainCheck(identity.contractDomain(parsedName("Seats"))))
const centsCheck = identifierOf(identity.domainCheck(identity.contractDomain(parsedName("Cents"))))
const seatsContract = lawNamesOf(Clubs).contract("Seats")
const centsContract = lawNamesOf(W.Work).contract("Cents")
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

/**
 * A domain constraint's violation in the installation's schema that reports neither a table nor a data type: its
 * constraint name alone.
 */
const nameAlone = (witness: typeof clubsWitness, constraint: ConstraintName) =>
	witness.classify(
		serverError({ ...nothingReported, sqlstate: "23514", constraint, schema: witness.laws.schema })
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
/**
 * The F1 schema: one contract per converted name length up to the identifier limit, `x` repeated. Each contract's
 * domain is named readable at its full length, and every domain's CHECK is `check`, so only the domain PostgreSQL
 * reports tells their violations apart.
 */
const nameLengths = int(1, maxIdentifierBytes)
const contractNameOf = (n: number): string => Str.repeat(n)("x")
const Long = decodedSchema({
	name: "L",
	relations: [
		relation(
			"T",
			{
				id: f.uuid,
				...Rec.fromEntries(
					Arr.map(Arr.range(1, maxIdentifierBytes), (n) => [
						`c${n}`,
						f.contract(contractNameOf(n), f.bigint, ge(value, literal(0n)))
					])
				)
			},
			["id"]
		)
	],
	statements: [],
	extends: undefined
})

const key = (text: string) => [{ field: "id", text }]

describe("witness decoding (packages/grizzle/src/adapter/witness)", () => {
	describe("a law function's 23000", () => {
		const codec = namedDetail(taskKind.detail)

		it("reads the law only through the DETAIL a law function always raises, never guessing it without one", () => {
			const raised = { ...nothingReported, sqlstate: "23000", constraint: taskKind.lawId }
			assert.equal(
				workWitness.classify(serverError({ ...raised, detail: encodeDetail(codec, [t7]) }))?.kind,
				"rejected"
			)
			assert.equal(workWitness.classify(serverError(raised)), undefined)
		})

		it.effect("a 23000 on a constraint that is no residual law is not a law outcome", (ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/adapter/witness/no-residual-law",
						generator: element<string>([
							taskPk,
							taskNoteFk,
							workLaws.primaryKeyLaw(W.Task),
							workLaws.lawOfConstraint(
								{ kind: "table", name: workNames.tableIdent(W.TaskNote) },
								taskNoteFk
							),
							wild.constraint("no_such_law")
						]),
						literal: Formatter.format,
						limit: 5,
						coverage: noCoverage,
						caseHang: Duration.minutes(2)
					},
					(constraint) =>
						Effect.sync(() => {
							assert.equal(
								workWitness.classify(
									serverError({
										...nothingReported,
										sqlstate: "23000",
										constraint,
										detail: encodeDetail(codec, [t7])
									})
								),
								undefined,
								constraint
							)
						})
				)
			)
		)
	})

	describe("a write statement's raised refusal", () => {
		it("tells a refusal from a law function's violation by the DETAIL's tag, never by the law", () => {
			const asFunction = workWitness.classify(
				serverError({
					...nothingReported,
					sqlstate: "23000",
					constraint: taskKind.lawId,
					detail: encodeDetail(namedDetail(taskKind.detail), [t7])
				})
			)
			const asRefusal = workWitness.classify(
				serverError({
					...nothingReported,
					sqlstate: "23000",
					constraint: taskKind.lawId,
					detail: encodeRefusalDetail({ kind: "law", relation: "Task" }, key(t7))
				})
			)
			assert.deepEqual(asFunction, asRefusal)
			assert.deepEqual(asFunction, {
				kind: "rejected",
				law: { kind: "alternatives", relation: "Task", field: "kind" },
				witness: { kind: "key", relation: "Task", values: { id: t7 } }
			})
			assert.ok(asRefusal?.kind === "rejected" && asRefusal.witness.kind === "key")
			assert.ok(Object.isFrozen(asRefusal.witness), "the witness is frozen")
			assert.ok(Object.isFrozen(asRefusal.witness.values), "its key's values are frozen")
		})

		it("decodes a refused key of several fields through the columns' codecs, an escaped text among them", () => {
			const verdict = clubsWitness.classify(
				serverError({
					...nothingReported,
					sqlstate: "23000",
					constraint: clubKeyLaw,
					detail: encodeRefusalDetail({ kind: "law", relation: "Club" }, [
						{ field: "region", text: "North" },
						{ field: "number", text: "7" },
						{ field: "code", text: awkwardCode }
					])
				})
			)
			assert.ok(verdict?.kind === "rejected", "a refused key is a rejection")
			assert.deepEqual(
				verdict.law,
				defined(clubs.described.get(clubKeyLaw), "the key law's description")
			)
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
							caseHang: Duration.minutes(2)
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
										})
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
					serverError({ ...nothingReported, sqlstate: "40Z01", constraint: taskPk })
				),
				undefined
			)
		})

		it("a refusal of a law the installation does not have is no law outcome", () => {
			assert.equal(
				workWitness.classify(
					serverError({
						...nothingReported,
						sqlstate: "23000",
						constraint: wild.constraint("no_such_law"),
						detail: encodeRefusalDetail({ kind: "law", relation: "Task" }, key(t7))
					})
				),
				undefined
			)
		})
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
						 * A relation's key law is its primary key's entry of the key-law map; a named check's constraint is the one
						 * that reports its law.
						 */
						const checkLaw = lawIdOf(Clubs, positiveSeats)
						const checkConstraint = lawNamesOf(Clubs).constraintOf(checkLaw, "TableCheck")
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
									constraint: constraintOf(Clubs, Member, "key", ["region", "number", "code"]),
									table: clubsNames.tableIdent(Member)
								},
								lawIdOf(Clubs, captainCount)
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
								caseHang: Duration.minutes(2)
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
											})
										),
										{
											kind: "rejected",
											law: defined(clubs.described.get(law), "the law's description"),
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
					assert.equal(
						clubsWitness.laws.lawOf(seatsCheck, { kind: "domain", name: seatsContract.domain })
							?.law,
						seatsContract.law
					)
					assert.equal(
						workWitness.laws.lawOf(accountName.constraint, {
							kind: "domain",
							name: accountName.domain
						})?.law,
						accountName.law
					)
					assert.equal(
						workWitness.laws.lawOf(centsCheck, { kind: "domain", name: centsContract.domain })?.law,
						centsContract.law
					)
					return yield* exhaust(
						{
							/** The text refinements' domains of Clubs. */
							suite: "unit/adapter/witness/text-domains",
							generator: element<typeof code>([code, email]),
							literal: (r) => Formatter.format(r.constraint),
							limit: 2,
							coverage: noCoverage,
							caseHang: Duration.minutes(2)
						},
						(r) =>
							Effect.sync(() => {
								assert.equal(
									clubsWitness.laws.lawOf(r.constraint, { kind: "domain", name: r.domain })?.law,
									r.law
								)
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
						caseHang: Duration.minutes(2)
					},
					([witness, constraint]) =>
						Effect.sync(() => {
							assert.equal(nameAlone(witness, constraint), undefined, constraint)
						})
				)
			)
		)

		it.effect(
			"classifies a contract's violation at every name length up to the identifier limit",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const long = artifactsOf(Long)
						const witness = witnessOf(long)
						/** Its CHECK as installed. */
						const N = installationNamesOf(installationOf(Long, { kind: "declared" }))
						return yield* exhaust(
							{
								suite: "unit/adapter/witness/contract-name-lengths",
								generator: nameLengths,
								literal: Formatter.format,
								limit: maxIdentifierBytes,
								coverage: noCoverage,
								caseHang: Duration.minutes(2)
							},
							(n) =>
								Effect.sync(() => {
									const name = contractNameOf(n)
									const contract = N.contract(name)
									assert.ok(contract.kind === "checked", `the contract of ${n} bytes has a CHECK`)
									assert.deepEqual(
										witness.classify(
											serverError({
												...nothingReported,
												sqlstate: "23514",
												constraint: contract.constraint,
												dataType: contract.domain,
												schema: long.names.schema
											})
										),
										{
											kind: "rejected",
											law: { kind: "contract", contract: name },
											witness: { kind: "unreported" }
										},
										`${contract.constraint}: a contract of ${n} bytes`
									)
								})
						)
					})
				)
		)
	})

	describe("anything else is not a law outcome", () => {
		it("answers undefined for another class, no constraint, an unknown constraint or another schema", () => {
			/**
			 * A native SQLSTATE never carries a residual law's identity.
			 *
			 * A native violation that reports neither its table nor a data type.
			 *
			 * A constraint name is read only under its own table.
			 */
			const cases: ReadonlyArray<Reported> = [
				{ ...nothingReported, sqlstate: "40001" },
				{ ...nothingReported, sqlstate: "40P01", constraint: taskKind.lawId },
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
					constraint: taskKind.lawId,
					schema: "another_schema",
					detail: encodeDetail(namedDetail(taskKind.detail), [t7])
				},
				{
					...nothingReported,
					sqlstate: "23514",
					constraint: taskKind.lawId,
					schema: workWitness.laws.schema
				}
			]
			for (const [i, failure] of cases.entries()) {
				assert.equal(
					workWitness.classify(serverError({ ...nothingReported, ...failure })),
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
					})
				)?.kind,
				"rejected"
			)
		})
	})
})
