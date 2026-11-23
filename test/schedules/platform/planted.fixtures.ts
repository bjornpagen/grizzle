import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { type Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { columnOf, fieldsOf, racesAt, tableOf } from "#test/schedules/platform/support.ts"
import * as P from "#test/support/fixtures/api/platform.ts"
import { type Generated } from "#test/support/install-migrate.ts"
import { type Names, namesOf } from "#test/support/kernel/naming.ts"
import { loadOrder } from "#test/support/platform/generate.ts"
import { type RelationName } from "#test/support/platform/laws.ts"
import { openActors } from "#test/support/schedules/actors.ts"
import { beginBelow, rollback, schedule, sql } from "#test/support/schedules/build.ts"
import { describeOutcome, meets, misses } from "#test/support/schedules/match.ts"
import { rigIn } from "#test/support/schedules/rig.ts"
import { runSchedule } from "#test/support/schedules/runner.ts"
import { type Expectation, type ScheduleOutcome } from "#test/support/schedules/types.ts"
import { type BelowSerializable } from "#test/support/substrate/session.ts"
import { Substrate, type SubstrateCase } from "#test/support/substrate/substrate.ts"

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

type Mutability = "mutable" | "immutable"

/** The refusal that comes first (see the header). */
type Refusal = "25000" | "42501"
const refusalOf = (writer: Writer, statement: StatementKind, mutability: Mutability): Refusal => {
	if (writer === "owner") {
		return "25000"
	}
	switch (statement) {
		case "insert":
			return "25000"
		case "update":
		case "merge updating":
		case "delete":
		case "zero-row delete":
		case "merge deleting":
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

export type PlantedFeature =
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

/** A point of the space with the relation it writes. */
interface PlantedPoint extends Point {
	readonly relation: RelationName
}

/**
 * Every point of the space, each writing a relation of its mutability, the relations of each mutability in turn over
 * its points, so every one of the platform's tables is written in every run, where the search drew one relation of each
 * mutability for the whole run.
 */
const plantedPoints: Arr.NonEmptyReadonlyArray<PlantedPoint> = mapNonEmpty(everyPoint, (p, k) => {
	const nth = Arr.filter(Arr.take(everyPoint, k), (q) => q.mutability === p.mutability).length
	const of = p.mutability === "mutable" ? mutables : immutables
	return { ...p, relation: defined(of[nth % of.length], "a relation of the point's mutability") }
})

/** Every point of the space with its relation. */
export const plantedCases: Gen<PlantedPoint> = (source) => source.draw(element(plantedPoints))

/** Every point's feature: the space's every point. */
export const plantedFeatures = mapNonEmpty(everyPoint, featureOf)

/** A point's statement, below SERIALIZABLE, refused as the total table says, over the case's clone of the races' rig. */
export const plantedCase = (
	taken: SubstrateCase<Generated>,
	p: PlantedPoint,
	c: Case<PlantedFeature>
) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const rig = yield* rigIn(taken, racesAt)
		const names = namesOf(rig.installed)
		const actors = yield* openActors(s, {
			owner: { kind: "psql", as: s.owner },
			direct: { kind: "psql", as: rig.direct }
		})
		const refusal = refusalOf(p.writer, p.statement, p.mutability)
		yield* runSchedule(
			rig.env,
			schedule(`${p.writer}: ${p.statement} of ${p.relation} at ${p.level}`, [
				beginBelow(p.writer, p.level),
				sql(
					p.writer,
					statementSql(names, p.relation, p.statement),
					refusedWith(refusal, names, p.relation)
				),
				rollback(p.writer)
			]),
			{ direct: actors, grizzle: {} }
		)
		c.note(featureOf(p))
	})
