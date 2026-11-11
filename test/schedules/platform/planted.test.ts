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
 * immutable relation, each drawn per run among the platform's tables of its mutability (the fixture's mutable
 * statements say which are mutable).
 *
 * Features: every point of the space.
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): planted-guard-no-delete.patch (the SERIALIZABLE guard trigger firing
 * on no DELETE).
 */

import { layer } from "@effect/vitest"
import { exhaust, Run } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { floorSeed, rotatingSeed } from "@grizzle/testing/random"
import { sample } from "@grizzle/testing/source"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { columnOf, fieldsOf, racesAt, tableOf } from "#test/schedules/platform/support.ts"
import { defined, nonEmpty } from "#test/support/assert.ts"
import * as P from "#test/support/fixtures/api/platform.ts"
import { type Names, namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { loadOrder } from "#test/support/platform/generate.ts"
import type { RelationName } from "#test/support/platform/laws.ts"
import { openActors } from "#test/support/schedules/actors.ts"
import { beginBelow, rollback, schedule, sql } from "#test/support/schedules/build.ts"
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

/** The platform's mutable relations, read off the fixture's mutable statements, and its immutable ones. */
const mutables = nonEmpty(
	Arr.flatMap(P.Platform.statements, (s): ReadonlyArray<RelationName> =>
		s.kind === "mutable" ? [s.relation.name] : []
	),
	"the platform's mutable relations"
)
const immutables = nonEmpty(
	Arr.filter(loadOrder, (r) => !mutables.includes(r)),
	"the platform's immutable relations"
)

/** The relation of each mutability a run writes: one of the platform's tables, drawn from the run's own stream. */
const relationOf = (
	seed: number,
	of: Arr.NonEmptyReadonlyArray<RelationName>,
	mutability: Mutability
): RelationName =>
	defined(
		sample(
			element(of),
			rotatingSeed(seed, floorSeed(`platform/planted ${mutability} relation`)),
			1
		)[0],
		`a ${mutability} relation drawn for the run`
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

const everyPoint: Arr.NonEmptyReadonlyArray<Point> = Arr.flatMap(writers, (writer) =>
	Arr.flatMap(statements, (statement) =>
		Arr.flatMap(levels, (level) =>
			Arr.map(mutabilities, (mutability): Point => ({ writer, statement, level, mutability }))
		)
	)
)

layer(Substrate.layer, { excludeTestServices: true })(
	"planted writers below SERIALIZABLE on the platform",
	(it) => {
		it.effect("every write below SERIALIZABLE is refused before it writes a row", (ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const run = yield* Run
					const mutableRelation = relationOf(run.seed, mutables, "mutable")
					const immutableRelation = relationOf(run.seed, immutables, "immutable")
					const rig = yield* openRig(racesAt)
					const names = namesOf(rig.installed)
					const actors = yield* openActors(s, {
						owner: { kind: "psql", as: s.owner },
						direct: { kind: "psql", as: rig.direct }
					})
					return yield* exhaust(
						{
							box: "both writers, every statement kind, every level below SERIALIZABLE, on a mutable and an immutable relation",
							oracle: {
								kind: "specification",
								name: "privileges before triggers: 42501 for an ungranted statement, the guard's 25000 for every other"
							},
							suite: "platform/planted",
							generator: pointGen,
							literal: Formatter.format,
							limit: everyPoint.length,
							coverage: requiredInSpace<PlantedFeature>(Arr.map(everyPoint, featureOf)),
							caseHang
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
											refusedWith(refusal, names, relation)
										),
										rollback(p.writer)
									]),
									{ direct: actors, grizzle: {} }
								)
								c.note(featureOf(p))
							})
					)
				})
			)
		)
	}
)
