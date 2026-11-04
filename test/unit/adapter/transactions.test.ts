import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Result, Schema, String as Str } from "effect"
import { ExecutionFailure, TransientFailure } from "#adapter/errors/execution.ts"
import {
	Deadlock,
	GeneratedSerialUnique,
	PutTargetConflict,
	SerializationFailure,
	UnseenOccupant
} from "#adapter/errors/failures.ts"
import { decodePlan } from "#adapter/explain/plan.ts"
import { classifyServerError, transientFailureOf } from "#adapter/outcomes/index.ts"
import { violationClassifier } from "#adapter/witness/classify.ts"
import { keyLaws } from "#adapter/witness/keylaw.ts"
import type { UniqueAbort } from "#compiler/write/program/artifact.ts"
import type { KeyDecoder } from "#compiler/write/program/outcome.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { contained, on } from "#test/support/fixtures/ir/desc.ts"
import * as W from "#test/support/fixtures/ir/work.ts"
import {
	installationNamesOf,
	installationOf,
	lawNamesOf,
	wild
} from "#test/support/kernel/naming.ts"
import { nothingReported, serverError } from "#test/support/server-error.ts"

/**
 * The pure parts of a write's outcome: the transient reasons of server errors, the outcome mapping of SQLSTATEs, and the
 * EXPLAIN (FORMAT JSON) decoder. How a flight and its COMMIT end is test/unit/adapter/batch.test.ts's.
 *
 * Work's laws, each named by src from its declaration: the residual law of its alternatives over Task's kind (the
 * statements the fixture's expansion marks with its origin), TaskNote's primary key, and TaskNote's foreign key into
 * Task.
 */
const L = lawNamesOf(W.WorkDesc)
const law = L.alternativesOfDesc(
	Arr.filter(
		W.WorkDesc.statements,
		(s) => (s.kind === "contained" || s.kind === "mirrors") && s.origin !== undefined
	)
).reverse
const pk = L.primaryKeyLaw({ name: "TaskNote" })
const fk = L.lawOfDesc(contained(on("TaskNote", ["task"]), on("Task", ["id"])))

/** The test's own DETAIL payload after its `w` tag: the relation and the key, as a JSON pair. */
const decodeDetail = Schema.decodeUnknownResult(
	Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String]))
)

/**
 * A witness decoder that reads `w["<relation>","<key>"]` as the relation's `id` (the program's own decoder is
 * write/program/outcome.ts witnessDecoder, pinned by its own tests). No test here raises a write statement's refusal.
 */
const decoder: KeyDecoder = {
	fromRefusal: () => {
		throw new Error("no write statement's refusal is raised here")
	},
	fromDetail: (detail) => {
		const [relation, key] = succeeded(decodeDetail(Str.slice(1)(detail)), "the DETAIL payload")
		return { kind: "key", relation, values: { id: key } }
	}
}

/**
 * The installation's laws: the alternatives' law a residual law, the others native constraints, each read under the
 * table PostgreSQL reports it on, through the installation's own constraint map (the key-law map's own rules are
 * packages/grizzle/src/adapter/witness's, pinned by test/unit/adapter/witness.test.ts).
 */
const installation = installationOf(W.WorkDesc, { kind: "declared" })
const names = installationNamesOf(installation)
const pkConstraint = L.constraintOf(pk, "PrimaryKey")
const fkConstraint = L.constraintOf(fk, "ForeignKey")
const laws = keyLaws({
	schema: names.schema,
	constraintLaws: installation.constraintLaws,
	theoryLaws: installation.theoryLaws
})

/** The three laws as an outcome names them: as the schema states them. */
const described = {
	reverse: { kind: "alternatives", relation: "Task", field: "kind" },
	pk: { kind: "primaryKey", relation: "TaskNote", fields: ["task"] },
	fk: {
		kind: "contained",
		from: { relation: "TaskNote", fields: ["task"], selection: [] },
		to: { relation: "Task", fields: ["id"], selection: [] }
	}
} as const

/**
 * What PostgreSQL reports beside a violation of TaskNote's primary key or of its foreign key into Task: the
 * installation's schema and TaskNote's table, which both constraints are on.
 */
const onTaskNote = {
	...nothingReported,
	schema: names.schema,
	table: names.tableIdent({ name: "TaskNote" })
}

/**
 * The outcome mapping consumes the installation's violation classifier.
 * A COMMIT-time classification: no statement's unique aborts.
 */
const context = { violation: violationClassifier(laws, decoder), uniqueAborts: [] }

describe("the transient failure of a server error", () => {
	it("40001 and 40P01 anywhere; a unique violation only on a constraint the failing statement lists", () => {
		/** Each failure carries the server's report it was read from. */
		const serialization = serverError({ ...nothingReported, sqlstate: "40001" })
		assert.deepEqual(
			transientFailureOf(serialization, []),
			TransientFailure.make({ reason: SerializationFailure.make(), error: serialization })
		)
		const deadlock = serverError({ ...nothingReported, sqlstate: "40P01" })
		assert.deepEqual(
			transientFailureOf(deadlock, []),
			TransientFailure.make({ reason: Deadlock.make(), error: deadlock })
		)
		/** The constraints a statement lists are matched by equality, so the names are opaque tokens. */
		const seatPk = wild.constraint("seat_pk")
		const seatX = wild.constraint("seat_x")
		const seatRoomDuring = wild.constraint("seat_room_during")
		const serial: ReadonlyArray<UniqueAbort> = [
			{ constraint: seatPk, relation: "Seat", reason: "GeneratedSerialUnique" }
		]
		const onSeatPk = serverError({ ...nothingReported, sqlstate: "23505", constraint: seatPk })
		assert.deepEqual(
			transientFailureOf(onSeatPk, serial),
			TransientFailure.make({
				reason: GeneratedSerialUnique.make({ relation: "Seat", constraint: seatPk }),
				error: onSeatPk
			})
		)
		const onSeatX = serverError({ ...nothingReported, sqlstate: "23505", constraint: seatX })
		assert.equal(transientFailureOf(onSeatX, serial), undefined)
		assert.equal(transientFailureOf(onSeatPk, []), undefined)
		/**
		 * A probed insert's 23505 or 23P01 on a unique object besides its arbiter is an unseen occupant
		 * (write/insert/unique.ts); the same SQLSTATE on a constraint the statement does not list is not.
		 */
		const probed: ReadonlyArray<UniqueAbort> = [
			{ constraint: seatX, relation: "Seat", reason: "UnseenOccupant" },
			{ constraint: seatRoomDuring, relation: "Seat", reason: "UnseenOccupant" }
		]
		assert.deepEqual(
			transientFailureOf(onSeatX, probed),
			TransientFailure.make({
				reason: UnseenOccupant.make({ relation: "Seat", constraint: seatX }),
				error: onSeatX
			})
		)
		const exclusion = serverError({
			...nothingReported,
			sqlstate: "23P01",
			constraint: seatRoomDuring
		})
		assert.deepEqual(
			transientFailureOf(exclusion, probed),
			TransientFailure.make({
				reason: UnseenOccupant.make({ relation: "Seat", constraint: seatRoomDuring }),
				error: exclusion
			})
		)
		assert.equal(
			transientFailureOf(
				serverError({ ...nothingReported, sqlstate: "23P01", constraint: seatPk }),
				probed
			),
			undefined
		)
		/** A MERGE's unique violation at its put target names the relation only: the same cause as a conflict row. */
		const merge: ReadonlyArray<UniqueAbort> = [
			{ constraint: seatPk, relation: "Seat", reason: "PutTargetConflict" }
		]
		assert.deepEqual(
			transientFailureOf(onSeatPk, merge),
			TransientFailure.make({
				reason: PutTargetConflict.make({ relation: "Seat" }),
				error: onSeatPk
			})
		)
		assert.equal(
			transientFailureOf(
				serverError({ ...nothingReported, sqlstate: "23514", constraint: seatPk }),
				serial
			),
			undefined
		)
	})
})

describe("the outcome mapping", () => {
	it.effect(
		"a law's integrity violation is invariant-rejected on the stated law; a native one's key is unreported",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					assert.deepEqual(
						classifyServerError(
							serverError({ ...onTaskNote, sqlstate: "23503", constraint: fkConstraint }),
							context
						),
						{
							kind: "rejected",
							law: described.fk,
							witness: { kind: "unreported" }
						}
					)
					assert.deepEqual(
						classifyServerError(
							serverError({ ...onTaskNote, sqlstate: "23505", constraint: pkConstraint }),
							context
						),
						{
							kind: "rejected",
							law: described.pk,
							witness: { kind: "unreported" }
						}
					)
					return yield* exhaust(
						{
							/** A check's and an exclusion's violation on a law's constraint. */
							suite: "unit/adapter/law-violations",
							generator: element(["23514", "23P01"] as const),
							literal: Formatter.format,
							limit: 2,
							coverage: requiredInSpace<"23514" | "23P01">(["23514", "23P01"]),
							caseHang: Duration.minutes(2)
						},
						(sqlstate, c) =>
							Effect.sync(() => {
								c.note(sqlstate)
								assert.equal(
									classifyServerError(
										serverError({ ...onTaskNote, sqlstate, constraint: pkConstraint }),
										context
									).kind,
									"rejected"
								)
							})
					)
				})
			)
	)

	it("a residual law's 23000 carries the key its function's DETAIL lists, never prose", () => {
		const raised = serverError({
			...nothingReported,
			sqlstate: "23000",
			constraint: law,
			detail: 'w["Task","t7"]'
		})
		assert.deepEqual(classifyServerError(raised, context), {
			kind: "rejected",
			law: described.reverse,
			witness: { kind: "key", relation: "Task", values: { id: "t7" } }
		})
	})

	/**
	 * The classifier claims neither a native SQLSTATE on a residual law's identity, nor another schema's violation,
	 * nor a law function's 23000 or a concurrent change raised without the DETAIL grizzle's own code always raises
	 * with: no law or reason is guessed, and the failure carries the server's report as given.
	 */
	type Unclaimed =
		| "a law function's 23000 without its DETAIL"
		| "a concurrent change without its DETAIL"
		| "a native SQLSTATE on a residual law"
		| "another schema's violation"
		| "an unmanaged constraint"
		| "a violation naming no constraint"
		| "another integrity class"
		| "a refusal of another class"
	const unclaimed: Arr.NonEmptyReadonlyArray<readonly [Unclaimed, ReturnType<typeof serverError>]> =
		[
			[
				"a law function's 23000 without its DETAIL",
				serverError({ ...nothingReported, sqlstate: "23000", constraint: law })
			],
			[
				"a concurrent change without its DETAIL",
				serverError({ ...onTaskNote, sqlstate: "40Z01", constraint: pkConstraint })
			],
			[
				"a native SQLSTATE on a residual law",
				serverError({ ...nothingReported, sqlstate: "23514", constraint: law })
			],
			[
				"another schema's violation",
				serverError({
					...onTaskNote,
					sqlstate: "23505",
					constraint: pkConstraint,
					schema: "elsewhere"
				})
			],
			[
				"an unmanaged constraint",
				serverError({ ...onTaskNote, sqlstate: "23505", constraint: "unmanaged" })
			],
			["a violation naming no constraint", serverError({ ...nothingReported, sqlstate: "23503" })],
			["another integrity class", serverError({ ...nothingReported, sqlstate: "22012" })],
			[
				"a refusal of another class",
				serverError({ ...onTaskNote, sqlstate: "42501", constraint: pkConstraint })
			]
		]

	it.effect(
		"an integrity violation the classifier does not claim, and every other SQLSTATE, is ExecutionFailure",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/adapter/unclaimed-violations",
						generator: element<readonly [Unclaimed, ReturnType<typeof serverError>]>(unclaimed),
						literal: (row) => Formatter.format(row[0]),
						limit: unclaimed.length,
						coverage: requiredInSpace<Unclaimed>(Arr.map(unclaimed, ([name]) => name)),
						caseHang: Duration.minutes(2)
					},
					(row, c) =>
						Effect.sync(() => {
							const [name, raised] = row
							c.note(name)
							assert.deepEqual(classifyServerError(raised, context), {
								kind: "failed",
								error: ExecutionFailure.make({ reason: raised })
							})
						})
				)
			)
	)
})

describe("EXPLAIN (FORMAT JSON) decoding", () => {
	const document = [
		{
			Plan: {
				"Node Type": "Hash Join",
				"Parallel Aware": false,
				"Startup Cost": 1.5,
				"Total Cost": 40.25,
				"Plan Rows": 12,
				"Plan Width": 48,
				"Hash Cond": "(a.id = b.id)",
				Plans: [
					{
						"Node Type": "Seq Scan",
						"Startup Cost": 0,
						"Total Cost": 20,
						"Plan Rows": 100,
						"Plan Width": 16
					},
					{
						"Node Type": "Hash",
						"Startup Cost": 1,
						"Total Cost": 1,
						"Plan Rows": 10,
						"Plan Width": 32,
						Plans: [
							{
								"Node Type": "Index Scan",
								"Startup Cost": 0.1,
								"Total Cost": 1,
								"Plan Rows": 10,
								"Plan Width": 32
							}
						]
					}
				]
			}
		}
	]
	const expected = {
		node: "Hash Join",
		startupCost: 1.5,
		totalCost: 40.25,
		rows: 12,
		width: 48,
		children: [
			{ node: "Seq Scan", startupCost: 0, totalCost: 20, rows: 100, width: 16, children: [] },
			{
				node: "Hash",
				startupCost: 1,
				totalCost: 1,
				rows: 10,
				width: 32,
				children: [
					{ node: "Index Scan", startupCost: 0.1, totalCost: 1, rows: 10, width: 32, children: [] }
				]
			}
		]
	}

	it("keeps exactly the node type and estimates of the json text", () => {
		assert.deepEqual(decodePlan(JSON.stringify(document)), Result.succeed(expected))
	})
})
