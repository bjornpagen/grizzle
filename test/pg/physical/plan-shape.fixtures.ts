/** What the property of plan-shape.test.ts reads: its space of relation shapes, their installation, and the law's states. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int, subset, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Record as Rec, Result, String as Str } from "effect"
import { type EstimatedNode, parsePlanTree } from "#bench/harness/explain.ts"
import { isCompileError } from "#compiler/core/errors.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import {
	type CopiedTable,
	type Copy,
	dropCopy,
	fillCopy,
	standCopy
} from "#test/pg/physical/copies.ts"
import { type ScanBinding, scanBindings } from "#test/pg/physical/plan-bindings.ts"
import { drawnRequests, type RequestSpec } from "#test/pg/physical/serving.ts"
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
import {
	type JudgedStatement,
	judgedStatementsOf,
	plannedQueryOf,
	raisedRule
} from "#test/support/judge.ts"
import { installRealSchema } from "#test/support/oracle/install/real.ts"
import type { SqlError } from "#test/support/pg.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

export type PlanShapeFeature =
	| "a unit's member read by its unit"
	| "a key probe beside an index on part of its key"
	| "a foreign key checked from each side"
	| "an equality lookup on an index of its own"
	| "a mutable relation emptied, vacuumed and refilled"
	| "a relation in no unit"
	| "a relation refused for crossing keys"
	| "a containment the rule judge reads"

/** What a field holds: any number of values, or a boolean's two. */
type Holds = "many" | "few"

/**
 * One relation of a shape: whether it is a member of the unit (its primary key led by the unit's fields) and mutable
 * inside it; its own fields, each by what it holds; its primary key's own fields, after the unit's; and its other keys,
 * each by its own fields and whether the unit's lead it.
 */
interface RelationSketch {
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

/**
 * A statement the law plans over a relation: what it is, the columns it binds by equality, and whether it locks the
 * rows it finds, as PostgreSQL's own foreign key checks do (ri_triggers.c, `SELECT 1 FROM ONLY ... FOR KEY SHARE`).
 */
interface Probe {
	readonly label: string
	readonly binding: Arr.NonEmptyReadonlyArray<string>
	readonly locks: boolean
}

/** An index of a copy as the catalog holds it: its name, its access method, whether it is unique, and its key columns. */
interface CopyIndex {
	readonly name: string
	readonly method: string
	readonly unique: boolean
	readonly columns: ReadonlyArray<string>
}

/** The rows of an answer, each cell as text. */
const texts = (rows: ReadonlyArray<ReadonlyArray<unknown>>): ReadonlyArray<ReadonlyArray<string>> =>
	Arr.map(rows, (row) => Arr.map(row, (cell) => (typeof cell === "string" ? cell : String(cell))))

/** The indexes of a table or a copy (CopyIndex), an expression key's column the empty name. */
const indexesOf = (quoted: string) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const rows = yield* admin.queryValues(
			"SELECT c.relname::text, am.amname::text, x.indisunique::text, " +
				"pg_catalog.array_to_string(ARRAY(SELECT coalesce(a.attname::text, '') " +
				"FROM pg_catalog.unnest(x.indkey::pg_catalog.int2[]) WITH ORDINALITY AS k(attnum, ord) " +
				"LEFT JOIN pg_catalog.pg_attribute AS a ON a.attrelid = x.indrelid AND a.attnum = k.attnum " +
				"WHERE k.ord <= x.indnkeyatts ORDER BY k.ord), ',') " +
				"FROM pg_catalog.pg_index AS x JOIN pg_catalog.pg_class AS c ON c.oid = x.indexrelid " +
				"JOIN pg_catalog.pg_am AS am ON am.oid = c.relam WHERE x.indrelid = $1::text::pg_catalog.regclass ORDER BY 1",
			[quoted]
		)
		return Arr.map(
			texts(rows),
			([name = "", method = "", unique = "", columns = ""]): CopyIndex => ({
				name,
				method,
				unique: unique === "true",
				columns: columns === "" ? [] : Str.split(",")(columns)
			})
		)
	})

/** The foreign keys of a table: each its referencing columns, its referenced table, quoted, and its referenced columns. */
const referencesOf = (quoted: string) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const rows = yield* admin.queryValues(
			"SELECT pg_catalog.array_to_string(ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(k.conkey) WITH ORDINALITY AS u(attnum, ord) " +
				"JOIN pg_catalog.pg_attribute AS a ON a.attrelid = k.conrelid AND a.attnum = u.attnum ORDER BY u.ord), ','), " +
				"(SELECT n.nspname::text FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace WHERE c.oid = k.confrelid), " +
				"(SELECT c.relname::text FROM pg_catalog.pg_class AS c WHERE c.oid = k.confrelid), " +
				"pg_catalog.array_to_string(ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(k.confkey) WITH ORDINALITY AS u(attnum, ord) " +
				"JOIN pg_catalog.pg_attribute AS a ON a.attrelid = k.confrelid AND a.attnum = u.attnum ORDER BY u.ord), ',') " +
				"FROM pg_catalog.pg_constraint AS k WHERE k.conrelid = $1::text::pg_catalog.regclass AND k.contype = 'f'::\"char\"",
			[quoted]
		)
		return Arr.map(texts(rows), ([from = "", schema = "", name = "", to = ""]) => ({
			from: Str.split(",")(from),
			target: `${quoteIdent(schema)}.${quoteIdent(name)}`,
			name,
			to: Str.split(",")(to)
		}))
	})

/** What a scan reads its relation through: the indexes it scans, or the table itself. */
const readText = (scan: ScanBinding): string =>
	scan.nodeType === "Seq Scan" ? "a Seq Scan" : Arr.join(scan.indexes, " and ")

/** The plan of a statement as EXPLAIN (VERBOSE) prints it, each column qualified by its relation's alias. */
const verbosePlan = (
	explained: ReadonlyArray<ReadonlyArray<unknown>>,
	label: string
): EstimatedNode => {
	const plan = parsePlanTree(explained[0]?.[0])
	return Result.isFailure(plan)
		? assert.fail(`no plan of ${label}: ${plan.failure.message}`)
		: plan.success
}

/**
 * A probe's generic plan over `copy` (PREPARE, then EXPLAIN EXECUTE under force_generic_plan with every parameter null,
 * as every login's role plans the statements it prepares): its one scan of the copy, or why it is none.
 */
const planned = (
	copy: Copy,
	probe: Probe
): Effect.Effect<Result.Result<ScanBinding, string>, SqlError, Substrate> =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const sql = `SELECT 1 FROM ONLY ${copy.quoted} AS x WHERE ${Arr.join(
			Arr.map(probe.binding, (c, at) => `x.${quoteIdent(c)} = $${at + 1}`),
			" AND "
		)}${probe.locks ? " FOR KEY SHARE OF x" : ""}`
		const answer = yield* Effect.acquireUseRelease(
			admin.query(`PREPARE judged_law AS ${sql}`, []),
			() =>
				Effect.andThen(
					admin.query("SET plan_cache_mode = force_generic_plan", []),
					admin.queryValues(
						`EXPLAIN (VERBOSE, FORMAT JSON) EXECUTE judged_law(${Arr.join(
							Arr.map(probe.binding, () => "NULL"),
							", "
						)})`,
						[]
					)
				),
			() =>
				Effect.andThen(
					Effect.ignore(admin.query("RESET plan_cache_mode", [])),
					Effect.ignore(admin.query("DEALLOCATE judged_law", []))
				)
		)
		const scans = Arr.filter(
			scanBindings(verbosePlan(answer, probe.label)),
			(scan) => scan.relation === copy.name
		)
		const [scan, ...more] = scans
		return scan === undefined || more.length > 0
			? Result.fail(`${scans.length} scans of the relation`)
			: Result.succeed(scan)
	})

/** The leading run of an index's key columns `columns` holds. */
const covered = (index: CopyIndex, columns: ReadonlySet<string>): number =>
	Option.getOrElse(
		Arr.findFirstIndex(index.columns, (c) => !columns.has(c)),
		() => index.columns.length
	)

/** Whether `index` is a key's whose every column `columns` holds. */
const keyIn = (index: CopyIndex, columns: ReadonlySet<string>): boolean =>
	index.unique && index.columns.length > 0 && Arr.every(index.columns, (c) => columns.has(c))

/**
 * The law's judgment of one scan (see plan-shape.test.ts): a scan whose binding holds a key binds that key's index whole
 * by its index condition; any other binds by its index condition as long a run of its binding as any B-tree of the
 * relation does, none if none binds any, and never scans the table where one does.
 */
const judged = (
	indexes: ReadonlyArray<CopyIndex>,
	label: string,
	scan: ScanBinding
): Option.Option<string> => {
	const used = Arr.filter(indexes, (i) => scan.indexes.includes(i.name))
	if (Arr.some(indexes, (i) => keyIn(i, scan.binding))) {
		return Arr.some(used, (i) => keyIn(i, scan.bound))
			? Option.none()
			: Option.some(
					`${label} binds a key and reads ${readText(scan)}, binding (${Arr.join([...scan.bound], ", ")}), no key's index whole`
				)
	}
	const best = Arr.reduce(
		Arr.filter(indexes, (i) => i.method === "btree"),
		0,
		(most, i) => Math.max(most, covered(i, scan.binding))
	)
	const reached = Arr.reduce(used, 0, (most, i) => Math.max(most, covered(i, scan.bound)))
	return best === 0 || reached >= best
		? Option.none()
		: Option.some(
				`${label} reads ${readText(scan)}, binding ${reached} of its columns where an index of the relation binds ${best}`
			)
}

/** Appends each of `more` to `into`. */
const record = (into: Array<string>, more: ReadonlyArray<string>): void => {
	for (const problem of more) {
		into.push(problem)
	}
}

/** The rows the filled state holds, the load's 2^14 at every unit's size, 2^8 units and more. */
const filledRows = 2 ** 14

/** The rows the sampled state's ANALYZE reads before the rest is loaded, one in a hundred of the filled state's. */
const sampledRows = filledRows / 100

/**
 * One relation of a case as the law plans it: its table, quoted and qualified; its load's columns, each by its SQL over
 * g; its probes; and whether it is mutable.
 */
interface Judgeable {
	readonly installation: Installation
	readonly table: CopiedTable
	readonly columns: ReadonlyArray<readonly [column: string, sql: string]>
	readonly probes: ReadonlyArray<Probe>
	readonly mutable: boolean
}

/** Every probe's read in a state of `copy`, with the problems the law finds in them. */
const statePlans = (copy: Copy, probes: ReadonlyArray<Probe>, label: string) =>
	Effect.gen(function* () {
		const indexes = yield* indexesOf(copy.quoted)
		const reads = new Map<string, string>()
		const problems: Array<string> = []
		for (const p of probes) {
			const scan = yield* planned(copy, p)
			if (Result.isFailure(scan)) {
				problems.push(`${label}: ${p.label}: ${scan.failure}`)
				continue
			}
			reads.set(p.label, readText(scan.success))
			Option.match(judged(indexes, p.label, scan.success), {
				onNone: () => undefined,
				onSome: (why) => problems.push(`${label}: ${why}`)
			})
		}
		return { reads, problems }
	})

/** The problems of a state whose reads are not the filled state's. */
const unlike = (
	label: string,
	filled: ReadonlyMap<string, string>,
	now: ReadonlyMap<string, string>
): ReadonlyArray<string> =>
	Arr.flatMap([...filled], ([statement, read]) => {
		const other = now.get(statement)
		return other === undefined || other === read
			? []
			: [`${label}: ${statement} reads ${other}, filled ${read}`]
	})

/**
 * The law over one relation (see plan-shape.test.ts): its copy empty as installed, every key's probe; filled and
 * vacuumed, every probe; then after ANALYZE, after VACUUM, and, mutable, emptied, vacuumed, refilled and vacuumed, each
 * read as filled; and a copy ANALYZEd at one row in a hundred, then loaded whole and vacuumed, each read as filled.
 */
const lawOver = (r: Judgeable, note: (feature: PlanShapeFeature) => void) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const problems: Array<string> = []
		const keyed = yield* indexesOf(r.table.quoted)
		const keyProbes = Arr.filter(r.probes, (p) =>
			Arr.some(keyed, (i) => keyIn(i, new Set(p.binding)))
		)
		const filled = yield* Effect.acquireUseRelease(
			standCopy(r.installation, r.table),
			(copy) =>
				Effect.gen(function* () {
					const empty = yield* statePlans(copy, keyProbes, "empty as installed")
					record(problems, empty.problems)
					yield* fillCopy(copy, r.columns, 0, filledRows - 1)
					yield* admin.query(`VACUUM ${copy.quoted}`, [])
					const at = yield* statePlans(copy, r.probes, "filled")
					record(problems, at.problems)
					yield* admin.query(`ANALYZE ${copy.quoted}`, [])
					const analyzed = yield* statePlans(copy, r.probes, "after ANALYZE")
					record(problems, unlike("after ANALYZE", at.reads, analyzed.reads))
					yield* admin.query(`VACUUM ${copy.quoted}`, [])
					const vacuumed = yield* statePlans(copy, r.probes, "after VACUUM")
					record(problems, unlike("after VACUUM", at.reads, vacuumed.reads))
					if (r.mutable) {
						note("a mutable relation emptied, vacuumed and refilled")
						yield* admin.query(`DELETE FROM ${copy.quoted}`, [])
						yield* admin.query(`VACUUM ${copy.quoted}`, [])
						yield* fillCopy(copy, r.columns, 0, filledRows - 1)
						yield* admin.query(`VACUUM ${copy.quoted}`, [])
						const refilled = yield* statePlans(copy, r.probes, "refilled")
						record(
							problems,
							unlike("emptied, vacuumed, refilled and vacuumed", at.reads, refilled.reads)
						)
					}
					return at.reads
				}),
			dropCopy
		)
		yield* Effect.acquireUseRelease(
			standCopy(r.installation, r.table),
			(copy) =>
				Effect.gen(function* () {
					yield* fillCopy(copy, r.columns, 0, sampledRows - 1)
					yield* admin.query(`ANALYZE ${copy.quoted}`, [])
					yield* fillCopy(copy, r.columns, sampledRows, filledRows - 1)
					yield* admin.query(`VACUUM ${copy.quoted}`, [])
					const sampled = yield* statePlans(copy, r.probes, "analyzed at one row in a hundred")
					record(problems, sampled.problems)
					record(problems, unlike("analyzed at one row in a hundred", filled, sampled.reads))
				}),
			dropCopy
		)
		return problems
	})

/** A table of the shape as the judge's law fills it: its table, and its load's columns, each by its SQL over g. */
interface Loaded {
	readonly table: CopiedTable
	readonly columns: ReadonlyArray<readonly [column: string, sql: string]>
}

/** Each scan of a shape's table in every statement of the judge, by the statement and the scan's alias, in a state. */
const judgeReads = (
	statements: ReadonlyArray<JudgedStatement>,
	tables: ReadonlyArray<Loaded>,
	label: string
) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const indexes = new Map<string, ReadonlyArray<CopyIndex>>()
		for (const t of tables) {
			const of = yield* indexesOf(t.table.quoted)
			indexes.set(t.table.quoted, of)
		}
		const reads = new Map<string, string>()
		const problems: Array<string> = []
		for (const [at, statement] of statements.entries()) {
			const name = `the judge's statement ${at + 1} of ${Option.getOrElse(raisedRule(statement), () => "no rule")}`
			const explained = yield* admin.queryValues(
				`EXPLAIN (VERBOSE, FORMAT JSON) ${plannedQueryOf(statement)}`,
				[]
			)
			const plan = verbosePlan(explained, name)
			for (const scan of scanBindings(plan)) {
				const of = indexes.get(`${quoteIdent(scan.schema)}.${quoteIdent(scan.relation)}`)
				if (of === undefined) {
					continue
				}
				const read = `${name}'s scan of ${scan.relation} as ${scan.alias}`
				reads.set(read, readText(scan))
				Option.match(judged(of, read, scan), {
					onNone: () => undefined,
					onSome: (why) => problems.push(`${label}: ${why}`)
				})
			}
		}
		return { reads, problems }
	})

/**
 * The law over the judge's statements (see plan-shape.test.ts), over the shape's own tables, which they read together:
 * each filled at the filled state's rows in the shape's order, a referenced relation before the one referencing it, its
 * own triggers off so no capture or judge runs (a foreign key's, the system's, checks the fill, which holds: a reference
 * holds the values of the row it references), and vacuumed, every scan of every
 * statement judged; then after ANALYZE, each read as filled.
 */
const judgeLaw = (
	installation: Installation,
	tables: ReadonlyArray<Loaded>,
	note: (feature: PlanShapeFeature) => void
) =>
	Effect.gen(function* () {
		const statements = judgedStatementsOf(installation)
		if (statements.length === 0) {
			return []
		}
		note("a containment the rule judge reads")
		const { admin } = yield* Substrate
		for (const t of tables) {
			yield* admin.query(`ALTER TABLE ${t.table.quoted} DISABLE TRIGGER USER`, [])
			yield* admin.query(
				`INSERT INTO ${t.table.quoted} (${Arr.join(
					Arr.map(t.columns, ([c]) => c),
					", "
				)}) SELECT ${Arr.join(
					Arr.map(t.columns, ([, sql]) => sql),
					", "
				)} FROM pg_catalog.generate_series(0, ${filledRows - 1}) AS g`,
				[]
			)
			yield* admin.query(`VACUUM ${t.table.quoted}`, [])
		}
		const filled = yield* judgeReads(statements, tables, "the judge, filled")
		for (const t of tables) {
			yield* admin.query(`ANALYZE ${t.table.quoted}`, [])
		}
		const analyzed = yield* judgeReads(statements, tables, "the judge, after ANALYZE")
		return [
			...filled.problems,
			...analyzed.problems,
			...unlike("the judge, after ANALYZE", filled.reads, analyzed.reads)
		]
	})

/**
 * A case: the shape installed with its workload's lookups as the engine's requests, each relation's probes (each key's,
 * each lookup's, each foreign key's check from each side, and a member's read by its unit), and the law over each
 * relation; a relation refused for crossing keys is the refusal generate states, and judged no further.
 */
export const shapeCase = (sketch: ShapeSketch, note: (feature: PlanShapeFeature) => void) =>
	Effect.gen(function* () {
		const { desc, specs } = describe(sketch)
		const installed = yield* Effect.result(
			installRealSchema(desc, {
				label: "plan_shape",
				logins: [],
				extensions: [drawnRequests(specs)]
			})
		)
		if (Result.isFailure(installed)) {
			const e = installed.failure
			if (isCompileError(e) && Str.includes("declared statistics")(String(e))) {
				note("a relation refused for crossing keys")
				return
			}
			return assert.fail(`the shape does not install: ${String(e)}`)
		}
		const installation = installed.success.plan.installation
		const units = unitFields(sketch.unitWidth)
		const tableOf = (at: number): CopiedTable => {
			const q = installation.names.relation(relationName(at))
			return {
				schema: q.schema,
				name: q.name,
				quoted: `${quoteIdent(q.schema)}.${quoteIdent(q.name)}`
			}
		}
		const column = (at: number, field: string): string =>
			installation.names.column(relationName(at), field)
		const probesOf = new Map<string, Array<Probe>>()
		const add = (quoted: string, probe: Probe): void => {
			const list = probesOf.get(quoted) ?? []
			if (!Arr.some(list, (p) => p.label === probe.label)) {
				list.push(probe)
			}
			probesOf.set(quoted, list)
		}
		for (const [at, r] of sketch.relations.entries()) {
			const table = tableOf(at)
			if (!r.member) {
				note("a relation in no unit")
			}
			for (const i of yield* indexesOf(table.quoted)) {
				const [head, ...rest] = i.columns
				if (i.unique && head !== undefined && head !== "") {
					add(table.quoted, {
						label: `${table.name}'s probe of key (${Arr.join(i.columns, ", ")})`,
						binding: [head, ...rest],
						locks: false
					})
				}
			}
			const [unitHead, ...unitRest] = r.member ? Arr.map(units, (u) => column(at, u)) : []
			if (r.member && unitHead !== undefined) {
				note("a unit's member read by its unit")
				add(table.quoted, {
					label: `${table.name}'s read of its unit`,
					binding: [unitHead, ...unitRest],
					locks: false
				})
			}
			for (const reference of yield* referencesOf(table.quoted)) {
				note("a foreign key checked from each side")
				add(table.quoted, {
					label: `${table.name}'s check of its references (${Arr.join(reference.from, ", ")})`,
					binding: reference.from,
					locks: true
				})
				add(reference.target, {
					label: `${reference.name}'s check of a reference to (${Arr.join(reference.to, ", ")})`,
					binding: reference.to,
					locks: true
				})
			}
		}
		for (const l of sketch.lookups) {
			const r = defined(sketch.relations[l.relation], "a looked-up relation")
			const table = tableOf(l.relation)
			const fields = [...(l.unitLed && r.member ? units : []), ...Arr.map(l.fields, fieldName)]
			const [head, ...rest] = Arr.map(fields, (field) => column(l.relation, field))
			if (head !== undefined) {
				note("an equality lookup on an index of its own")
				add(table.quoted, {
					label: `${table.name}'s lookup of (${Arr.join(fields, ", ")})`,
					binding: [head, ...rest],
					locks: false
				})
			}
			if (
				l.fields.length < r.primary.length &&
				Arr.every(l.fields, (field) => r.primary.includes(field)) &&
				!l.fields.includes(r.primary[0])
			) {
				note("a key probe beside an index on part of its key")
			}
		}
		const problems: Array<string> = []
		const loaded = Arr.map(sketch.relations, (_, at): Loaded => ({
			table: tableOf(at),
			columns: Arr.map(
				fieldsOf(sketch, at),
				([name, , sql]) => [quoteIdent(column(at, name)), sql(sketch.unitRows)] as const
			)
		}))
		for (const [at, r] of sketch.relations.entries()) {
			const { table, columns } = defined(loaded[at], "a loaded relation")
			const found = yield* lawOver(
				{
					installation,
					table,
					columns,
					probes: probesOf.get(table.quoted) ?? [],
					mutable: r.mutable
				},
				note
			)
			record(problems, found)
		}
		const judges = yield* judgeLaw(installation, loaded, note)
		record(problems, judges)
		assert.deepEqual(problems, [], `the plan-shape law holds over ${desc.name}`)
	})
