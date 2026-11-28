/** What the property of plan-shape.test.ts reads: its space of relation shapes, their installation, and the laws' states. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int, subset, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Record as Rec } from "effect"
import type { BenchSession } from "#bench/harness/session.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { drawnRequests, type RequestSpec } from "#test/pg/physical/serving.ts"
import {
	budgetOfScope,
	lawsOver,
	type PgClassState,
	pgClassStates,
	plannedScope,
	routineScopes,
	type StateLoad,
	standIn
} from "#test/support/advice.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import {
	type AuthoredStatementDesc,
	contained,
	f,
	key,
	mutable,
	on,
	relation,
	type SchemaDesc,
	unit
} from "#test/support/fixtures/ir/desc.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

export type PlanShapeFeature =
	| "a unit's members"
	| "a relation in no unit"
	| "a mutable member"
	| "a reference between members"
	| "a containment the rule judge reads"
	| "a lookup's index beside a key"
	| `a relation ${PgClassState}`
	| "a routine read through an index"

/** What a field holds: any number of values, or a boolean's two. */
type Holds = "many" | "few"

/**
 * One relation of a shape: the pg_class state its table stands in when the laws read it (test/support/advice.ts
 * PgClassState); whether it is a member of the unit (its primary key led by the unit's fields) and mutable inside it; its own fields, each by what it holds; its primary key's own fields, after the unit's; and its other keys,
 * each by its own fields and whether the unit's lead it.
 */
interface RelationSketch {
	readonly state: PgClassState
	readonly member: boolean
	readonly mutable: boolean
	readonly fields: Arr.NonEmptyReadonlyArray<Holds>
	readonly primary: Arr.NonEmptyReadonlyArray<number>
	readonly keys: ReadonlyArray<{
		readonly unitLed: boolean
		readonly fields: ReadonlyArray<number>
	}>
}

/** An equality lookup a workload asks of a relation: its own fields, after the unit's where the unit leads it. */
interface LookupSketch {
	readonly relation: number
	readonly unitLed: boolean
	readonly fields: Arr.NonEmptyReadonlyArray<number>
}

/**
 * A shape: a unit of one or two fields or none; the rows a unit holds in the load, 2^unitRows; one to three relations;
 * whether the second references the first's primary key; the first's fields, none of its keys among them, that the
 * second's rows are contained in, a containment no foreign key states, which the rule judge reads whole within the unit
 * where both are immutable members, or none; and the
 * equality lookups its workload asks.
 */
export interface ShapeSketch {
	readonly unitWidth: 0 | 1 | 2
	readonly unitRows: number
	readonly relations: Arr.NonEmptyReadonlyArray<RelationSketch>
	readonly references: boolean
	readonly judged: ReadonlyArray<number>
	readonly lookups: ReadonlyArray<LookupSketch>
}

/** Positions 0 to `count` - 1. */
const positions = (count: number): ReadonlyArray<number> =>
	Array.from({ length: count }, (_, i) => i)

/** Distinct positions among `count`, `min` to `max` of them, in drawn order, the first of a field of many values. */
const fieldsGen =
	(holds: ReadonlyArray<Holds>, min: number, max: number): Gen<Arr.NonEmptyReadonlyArray<number>> =>
	(source) => {
		const many = Arr.filter(positions(holds.length), (i) => holds[i] === "many")
		const first = many[source.draw(int(0, Math.max(0, many.length - 1)))] ?? 0
		const rest = source.draw(
			subset(
				Arr.filter(positions(holds.length), (i) => i !== first),
				{ min: Math.max(0, min - 1), max: Math.max(0, Math.min(max, holds.length) - 1) }
			)
		)
		return [first, ...rest]
	}

/** A relation of a unit `unitWidth` wide; keyed by its first two fields where `partKey`; an immutable member where
 * `judged`, a side of the containment the rule judge reads. */
const relationGen =
	(unitWidth: number, partKey: boolean, judged: boolean): Gen<RelationSketch> =>
	(source) => {
		const count = source.draw(int(2, 4))
		const fields: Arr.NonEmptyReadonlyArray<Holds> = [
			"many",
			...Array.from({ length: count - 1 }, (_, at) =>
				partKey && at === 0
					? "many"
					: source.draw(
							weighted<Holds>([
								[3, () => "many"],
								[1, () => "few"]
							])
						)
			)
		]
		const member =
			judged ||
			(unitWidth > 0 &&
				source.draw(
					weighted([
						[3, () => true],
						[1, () => false]
					])
				))
		return {
			state: source.draw(element(pgClassStates)),
			member,
			mutable: member && !judged && source.draw(boolean),
			fields,
			primary: partKey ? [0, 1] : source.draw(fieldsGen(fields, 1, 2)),
			keys: source.draw(
				array(
					(s) => ({
						unitLed: member && s.draw(boolean),
						fields: s.draw(fieldsGen(fields, 1, 2))
					}),
					{ min: 0, max: 1 }
				)
			)
		}
	}

/**
 * A shape: its unit's width and rows, one to three relations (the first, half the time, keyed by two fields of its own
 * with a lookup on the second, a key probe's binding beside an index on part of its key), the reference of the second
 * to the first where both are members or neither, and up to three equality lookups, each holding a field of many values.
 */
export const shapeGen: Gen<ShapeSketch> = (source) => {
	/** A containment no key states is the judge's only within one unit over immutable relations (laws/model/plan.ts
	 * containmentDischarge), which it reads whole: a third of the shapes are two such members and maybe a third. */
	const judgedArm = source.draw(
		weighted([
			[1, () => true],
			[2, () => false]
		])
	)
	const unitWidth = source.draw(judgedArm ? element([1, 2] as const) : element([0, 1, 2] as const))
	const partKey = source.draw(boolean)
	const count = source.draw(int(judgedArm ? 2 : 1, 3))
	const relations: Arr.NonEmptyReadonlyArray<RelationSketch> = [
		source.draw(relationGen(unitWidth, partKey, judgedArm)),
		...Array.from({ length: count - 1 }, (_, at) =>
			source.draw(relationGen(unitWidth, false, judgedArm && at === 0))
		)
	]
	const [first, second] = relations
	const lookups = source.draw(
		array(
			(s): LookupSketch => {
				const at = s.draw(int(0, relations.length - 1))
				const r = defined(relations[at], "a drawn relation")
				return {
					relation: at,
					unitLed: r.member && s.draw(boolean),
					fields: s.draw(fieldsGen(r.fields, 1, 2))
				}
			},
			{ min: 0, max: 3 }
		)
	)
	const paired = second !== undefined && second.member === first.member
	const target = judgedArm
		? source.draw(subset(positions(first.fields.length), { min: 1, max: 2 }))
		: []
	return {
		unitWidth,
		unitRows: source.draw(int(4, 6)),
		relations,
		references: paired && source.draw(boolean),
		judged: Arr.some([first.primary, ...Arr.map(first.keys, (k) => k.fields)], (k) =>
			Arr.every(k, (at) => target.includes(at))
		)
			? []
			: target,
		lookups: partKey ? [{ relation: 0, unitLed: first.member, fields: [1] }, ...lookups] : lookups
	}
}

/** What each field of the unit holds: any number of values. */
const unitHolds: Holds = "many"

/** The unit's fields, by width. */
const unitFields = (width: number): ReadonlyArray<string> => ["doc", "part"].slice(0, width)

/** A relation's name and its own fields' names. */
const relationName = (at: number): string => `R${at}`
const fieldName = (at: number): string => `f${at}`

/** The fields a member of the first relation's reference holds of its primary key: one a field of its own. */
const referenceFields = (first: RelationSketch): ReadonlyArray<string> =>
	Arr.map(first.primary, (at) => `p${at}`)

/** The fields of the second relation contained in the first's judged fields, each after the field it is contained in. */
const judgedFields = (sketch: ShapeSketch): ReadonlyArray<string> =>
	Arr.map(sketch.judged, (at) => `q${at}`)

/** A relation's every field: the unit's where it is a member, its own, and its reference's and its contained fields for
 * the second. */
const fieldsOf = (
	sketch: ShapeSketch,
	at: number
): ReadonlyArray<readonly [name: string, holds: Holds, sql: (unitRows: number) => string]> => {
	const r = defined(sketch.relations[at], "a relation of the shape")
	const units = r.member ? unitFields(sketch.unitWidth) : []
	const first = sketch.relations[0]
	return [
		...Arr.map(
			units,
			(name, i) =>
				[
					name,
					unitHolds,
					(rows: number) => (i === 0 ? `(g / ${2 ** rows})::int8` : "0::int8")
				] as const
		),
		...Arr.map(r.fields, (holds, i) => [fieldName(i), holds, () => valueSql(holds, i)] as const),
		...(at === 1 && sketch.references
			? Arr.map(
					first.primary,
					(k) =>
						[
							`p${k}`,
							first.fields[k] ?? "many",
							() => valueSql(first.fields[k] ?? "many", k)
						] as const
				)
			: []),
		...(at === 1
			? Arr.map(
					sketch.judged,
					(k) =>
						[
							`q${k}`,
							first.fields[k] ?? "many",
							() => valueSql(first.fields[k] ?? "many", k)
						] as const
				)
			: [])
	]
}

/**
 * A field's value on row `g`: a field of many values a distinct value each row (its row times a prime of its own, modulo
 * a prime past the rows any state holds), so every key holding one holds each row once; a boolean, every other row.
 */
const valueSql = (holds: Holds, at: number): string =>
	holds === "few"
		? "(g % 2 = 0)"
		: `((g::int8 * ${[7919, 104_729, 15_485_863, 179_424_673][at] ?? 7919}) % 1000003)::int8`

/**
 * A relation's other keys, each by its fields: those of its drawn keys no other key holds nor holds, the primary key
 * among them, as a schema states each key once.
 */
const keysOf = (sketch: ShapeSketch, at: number): ReadonlyArray<ReadonlyArray<string>> => {
	const r = defined(sketch.relations[at], "a relation of the shape")
	const units = r.member ? unitFields(sketch.unitWidth) : []
	const nests = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
		Arr.every(a, (f) => b.includes(f)) || Arr.every(b, (f) => a.includes(f))
	const kept: Array<ReadonlyArray<string>> = [[...units, ...Arr.map(r.primary, fieldName)]]
	for (const k of r.keys) {
		const fields = [...(k.unitLed ? units : []), ...Arr.map(k.fields, fieldName)]
		if (!Arr.some(kept, (other) => nests(fields, other))) {
			kept.push(fields)
		}
	}
	return kept.slice(1)
}

/** The shape as a schema description, and its workload's lookups as the engine's requests. */
const describe = (
	sketch: ShapeSketch
): { readonly desc: SchemaDesc; readonly specs: ReadonlyArray<RequestSpec> } => {
	const units = unitFields(sketch.unitWidth)
	const relations = Arr.map(sketch.relations, (r, at) =>
		relation(
			relationName(at),
			Rec.fromEntries(
				Arr.map(
					fieldsOf(sketch, at),
					([name, holds]) => [name, holds === "few" ? f.boolean : f.bigint] as const
				)
			),
			[...(r.member ? units : []), ...Arr.map(r.primary, fieldName)]
		)
	)
	const first = sketch.relations[0]
	const statements: Array<AuthoredStatementDesc> = [
		...(Arr.some(sketch.relations, (r) => r.member)
			? [unit("Doc", Rec.fromEntries(Arr.map(units, (u) => [u, f.bigint] as const)))]
			: []),
		...Arr.flatMap(sketch.relations, (r, at) => [
			...(r.mutable ? [mutable(relationName(at))] : []),
			...Arr.map(keysOf(sketch, at), (k) => key(on(relationName(at), k)))
		]),
		...(sketch.references
			? [
					contained(
						on(relationName(1), [...(first.member ? units : []), ...referenceFields(first)]),
						on(relationName(0), [
							...(first.member ? units : []),
							...Arr.map(first.primary, fieldName)
						])
					)
				]
			: []),
		...(sketch.judged.length > 0
			? [
					contained(
						on(relationName(1), [...(first.member ? units : []), ...judgedFields(sketch)]),
						on(relationName(0), [
							...(first.member ? units : []),
							...Arr.map(sketch.judged, fieldName)
						])
					)
				]
			: [])
	]
	return {
		desc: { name: "PlanShape", relations, statements, bases: [] },
		specs: Arr.map(sketch.lookups, (l) => {
			const r = defined(sketch.relations[l.relation], "a looked-up relation")
			const [head, ...rest] = [
				...(l.unitLed && r.member ? units : []),
				...Arr.map(l.fields, fieldName)
			]
			return {
				kind: "access",
				relation: relationName(l.relation),
				use: "equality lookup",
				keys: [
					{ field: defined(head, "a lookup's first field"), dir: "asc" },
					...Arr.map(rest, (field) => ({ field, dir: "asc" as const }))
				]
			} satisfies RequestSpec
		})
	}
}

/** The rows each relation of a case loads: 2^14, at every unit's size 2^8 units and more. */
const filledRows = 2 ** 14

/** A relation of a case as installed: its table, quoted and qualified, and each column's load SQL over the row `g`. */
interface Loaded {
	readonly quoted: string
	readonly columns: ReadonlyArray<readonly [column: string, sql: string]>
}

/** Relation `at` of `sketch` as `installation` installed it (`Loaded`). */
const loadedOf = (installation: Installation, sketch: ShapeSketch, at: number): Loaded => {
	const q = installation.names.relation(relationName(at))
	return {
		quoted: `${quoteIdent(q.schema)}.${quoteIdent(q.name)}`,
		columns: Arr.map(
			fieldsOf(sketch, at),
			([name, , sql]) =>
				[
					quoteIdent(installation.names.column(relationName(at), name)),
					sql(sketch.unitRows)
				] as const
		)
	}
}

/** A relation's load, its rows `from` to `to` of 1 to `filledRows` inserted on `session` (StateLoad). */
const loadOf = (session: BenchSession, loaded: Loaded): StateLoad => ({
	tables: [loaded.quoted],
	units: filledRows,
	load: (from, to) =>
		Effect.asVoid(
			session.values(
				`INSERT INTO ${loaded.quoted} (${Arr.join(
					Arr.map(loaded.columns, ([c]) => c),
					", "
				)}) SELECT ${Arr.join(
					Arr.map(loaded.columns, ([, sql]) => sql),
					", "
				)} FROM pg_catalog.generate_series(${from - 1}, ${to - 1}) AS g`,
				[]
			)
		)
})

/**
 * A case (see plan-shape.test.ts): the shape installed through its first migration, as `grizzle generate` composes it,
 * with its workload's lookups as the engine's requests; in one
 * transaction on the owner's pinned session, which the case rolls back, the judge stood up and each relation loaded,
 * a referenced relation before the one referencing it, and stood in its drawn pg_class state; then the laws over every routine the
 * installation installs (test/support/advice.ts routineScopes, lawsOver), and the budget over each routine's queries of no
 * parameter on the filled data (budgetOfScope).
 */
export const shapeCase = (sketch: ShapeSketch, note: (feature: PlanShapeFeature) => void) =>
	Effect.gen(function* () {
		const { desc, specs } = describe(sketch)
		const installed = yield* installMigrated(desc, {
			label: "plan_shape",
			extensions: [drawnRequests(specs)],
			ambient: ordinarySession
		})
		const installation = installed.installation
		const substrate = yield* Substrate
		const scopes = routineScopes(installation)
		const read = (sql: string) => substrate.superuserRead((rows) => rows(sql))
		for (const r of sketch.relations) {
			note(r.member ? "a unit's members" : "a relation in no unit")
			note(`a relation ${r.state}`)
			if (r.mutable) {
				note("a mutable member")
			}
		}
		if (sketch.references) {
			note("a reference between members")
		}
		if (sketch.judged.length > 0) {
			note("a containment the rule judge reads")
		}
		if (sketch.lookups.length > 0) {
			note("a lookup's index beside a key")
		}
		if (Arr.some(scopes, (scope) => scope.reads.length > 0)) {
			note("a routine read through an index")
		}
		const problems = yield* Effect.scoped(
			Effect.flatMap(substrate.admin.pin, (pinned) => {
				const session: BenchSession = { values: pinned.queryValues }
				return Effect.acquireUseRelease(
					pinned.query("BEGIN", []),
					() =>
						Effect.gen(function* () {
							for (const [at, r] of sketch.relations.entries()) {
								yield* standIn(
									session,
									loadOf(session, loadedOf(installation, sketch, at)),
									r.state
								)
							}
							const found: Array<string> = []
							for (const scope of scopes) {
								const planned = yield* plannedScope(session, scope)
								for (const problem of lawsOver(scope, planned)) {
									found.push(problem)
								}
								const budget = yield* budgetOfScope(session, read, scope)
								for (const problem of budget) {
									found.push(problem)
								}
							}
							return found
						}),
					() => Effect.orDie(pinned.query("ROLLBACK", []))
				)
			})
		)
		assert.deepEqual(problems, [], `the plan laws hold over every routine of ${desc.name}`)
	})
