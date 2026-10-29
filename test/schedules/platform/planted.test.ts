/**
 * Planted writers below SERIALIZABLE on the platform's tables: every write is refused before it writes a row.
 *
 * grizzle runs every transaction at SERIALIZABLE, and every table's statement trigger refuses a write below it with
 * 25000, naming the table in SCHEMA and TABLE. PostgreSQL checks a statement's
 * privileges before any trigger fires, and grizzle grants a world role INSERT and DELETE on what it writes,
 * UPDATE only on a mutable relation, and TRUNCATE to no one, so which refusal comes first is a total table of who
 * writes, what statement, and whether the relation is mutable:
 *
 * - the schema's owner holds every privilege on its tables: every statement is refused by the guard, 25000;
 * - a world role (the races' `direct`, taken on through its login) is refused by privilege, 42501, for a TRUNCATE, and
 *   for an UPDATE or a MERGE that updates when the relation is immutable; every other statement it is granted (an
 *   INSERT, a DELETE, a DELETE that matches no row, a MERGE that deletes, an UPDATE or updating MERGE of a mutable
 *   relation) is refused by the guard, 25000.
 *
 * Every statement would write rows if it ran (an INSERT of a copy of every row, which the key would refuse, a DELETE of
 * every row), so a guard that let it through is seen as another outcome, or as a row-level failure, never as 25000. A
 * statement trigger fires whether or not any row is touched, so the DELETE that matches nothing and the MERGE whose
 * condition matches nothing are refused too; a TRUNCATE cascades, so no foreign key's check comes before its trigger.
 * The space is exhausted: both writers, every statement kind, every level below SERIALIZABLE, and a mutable and an
 * immutable relation, the immutable one drawn per run among the platform's tables.
 */

import { layer } from "@effect/vitest"
import { exhaust, Run } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { floorSeed, rotatingSeed } from "@grizzle/testing/random"
import { sample } from "@grizzle/testing/source"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter } from "effect"
import { columnOf, fieldsOf, racesAt, tableOf } from "#test/schedules/platform/support.ts"
import { defined, nonEmpty } from "#test/support/assert.ts"
import { type Names, namesOf } from "#test/support/kernel/naming.ts"
import { loadOrder } from "#test/support/platform/generate.ts"
import type { RelationName } from "#test/support/platform/laws.ts"
import { openActors } from "#test/support/schedules/actors.ts"
import { beginBelow, complete, rollback, schedule, sql } from "#test/support/schedules/build.ts"
import { describeOutcome, meets, misses } from "#test/support/schedules/match.ts"
import { openRig } from "#test/support/schedules/rig.ts"
import { runSchedule } from "#test/support/schedules/runner.ts"
import { type Expectation, type ScheduleOutcome } from "#test/support/schedules/types.ts"
import type { BelowSerializable } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const writers = ["owner", "direct"] as const
type Writer = (typeof writers)[number]

const statements = [
	"insert",
	"update",
	"delete",
	"zero-row delete",
	"truncate",
	"merge updating",
	"merge deleting"
] as const
type StatementKind = (typeof statements)[number]

const levels: Arr.NonEmptyReadonlyArray<BelowSerializable> = [
	"read uncommitted",
	"read committed",
	"repeatable read"
]

/** The platform's one mutable relation (mutable(WorkspaceLimit) in the fixture), and an immutable one drawn per run. */
const mutableRelation: RelationName = "WorkspaceLimit"
const immutables = nonEmpty(
	Arr.filter(loadOrder, (r) => r !== mutableRelation),
	"the platform's immutable relations"
)

/** The immutable relation a run writes: one of the platform's immutable tables, drawn from the run's own stream. */
const immutableOf = (seed: number): RelationName =>
	defined(
		sample(
			element(immutables),
			rotatingSeed(seed, floorSeed("platform/planted immutable relation")),
			1
		)[0],
		"an immutable relation drawn for the run"
	)

type Mutability = "mutable" | "immutable"

/** The refusal that comes first (see the header). */
type Refusal = "25000" | "42501"
const refusalOf = (writer: Writer, statement: StatementKind, mutability: Mutability): Refusal => {
	if (writer === "owner") {
		return "25000"
	}
	switch (statement) {
		case "insert":
		case "delete":
		case "zero-row delete":
		case "merge deleting":
			return "25000"
		case "update":
		case "merge updating":
			return mutability === "mutable" ? "25000" : "42501"
		case "truncate":
			return "42501"
	}
}

/** The statement's SQL on a relation. */
const statementSql = (names: Names, relation: RelationName, statement: StatementKind): string => {
	const table = tableOf(names, relation)
	const column = columnOf(
		names,
		relation,
		defined(fieldsOf[relation][0], `${relation}'s first field`)
	)
	switch (statement) {
		case "insert": {
			const columns = Arr.join(
				Arr.map(fieldsOf[relation], (f) => columnOf(names, relation, f)),
				", "
			)
			return `INSERT INTO ${table} (${columns}) SELECT ${columns} FROM ${table}`
		}
		case "update":
			return `UPDATE ${table} SET ${column} = ${column}`
		case "delete":
			return `DELETE FROM ${table}`
		case "zero-row delete":
			return `DELETE FROM ${table} WHERE false`
		case "truncate":
			return `TRUNCATE ${table} CASCADE`
		case "merge updating":
			return `MERGE INTO ${table} AS m USING (SELECT 1 AS one) AS s ON false WHEN MATCHED THEN UPDATE SET ${column} = m.${column}`
		case "merge deleting":
			return `MERGE INTO ${table} AS m USING (SELECT 1 AS one) AS s ON false WHEN MATCHED THEN DELETE`
	}
}

/** The statement refused with `refusal`: 42501, or 25000 naming the relation's table and schema. */
const refusedWith =
	(refusal: Refusal, names: Names, relation: RelationName): Expectation<ScheduleOutcome> =>
	(outcome) => {
		const shown = describeOutcome(outcome)
		if (outcome._tag !== "PgError" || outcome.fields.code !== refusal) {
			return misses(shown, `expected ${refusal}`)
		}
		if (refusal === "42501") {
			return meets(shown)
		}
		const table = outcome.fields.table
		const schemaName = outcome.fields.schema
		return table._tag === "Some" &&
			table.value === names.tableIdent({ name: relation }) &&
			schemaName._tag === "Some" &&
			schemaName.value === names.schema
			? meets(shown)
			: misses(
					shown,
					`expected 25000 naming ${names.schema}.${names.tableIdent({ name: relation })}`
				)
	}

interface Point {
	readonly writer: Writer
	readonly statement: StatementKind
	readonly level: BelowSerializable
	readonly mutability: Mutability
}

const mutabilities = ["mutable", "immutable"] as const

const pointGen: Gen<Point> = (source) => ({
	writer: source.draw(element(writers)),
	statement: source.draw(element(statements)),
	level: source.draw(element(levels)),
	mutability: source.draw(element(mutabilities))
})

type PlantedFeature =
	`${Writer} ${StatementKind} of a ${Mutability} relation at ${BelowSerializable}: ${Refusal}`

const featureOf = (p: Point): PlantedFeature =>
	`${p.writer} ${p.statement} of a ${p.mutability} relation at ${p.level}: ${refusalOf(p.writer, p.statement, p.mutability)}`

const everyPoint: ReadonlyArray<Point> = Arr.flatMap(writers, (writer) =>
	Arr.flatMap(statements, (statement) =>
		Arr.flatMap(levels, (level) =>
			Arr.map(mutabilities, (mutability): Point => ({ writer, statement, level, mutability }))
		)
	)
)

layer(Substrate.layer, { excludeTestServices: true })(
	"planted writers below SERIALIZABLE on the platform",
	(it) => {
		it.effect(
			"every write below SERIALIZABLE is refused before it writes a row",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const immutableRelation = immutableOf((yield* Run).seed)
						const rig = yield* openRig("Platform", racesAt)
						const names = namesOf(rig.installed)
						const actors = yield* openActors(s, {
							owner: { kind: "psql", as: s.owner },
							direct: { kind: "psql", as: rig.direct }
						})
						return yield* exhaust(
							{
								suite: "platform/planted",
								generator: pointGen,
								literal: Formatter.format,
								limit: everyPoint.length,
								features: features<PlantedFeature>(Arr.map(everyPoint, featureOf)),
								caseHang: Duration.minutes(2)
							},
							(p, c) =>
								Effect.gen(function* () {
									const relation = p.mutability === "mutable" ? mutableRelation : immutableRelation
									const refusal = refusalOf(p.writer, p.statement, p.mutability)
									yield* runSchedule(
										rig.env,
										schedule(`${p.writer}: ${p.statement} of ${relation} at ${p.level}`, [
											beginBelow(p.writer, p.level),
											sql(
												p.writer,
												statementSql(names, relation, p.statement),
												refusedWith(refusal, names, relation),
												complete
											),
											rollback(p.writer)
										]),
										{ direct: actors, grizzle: {} }
									)
									c.note(featureOf(p))
								})
						)
					})
				),
			600_000
		)
	}
)
