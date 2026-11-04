import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	oneOf,
	weighted
} from "@grizzle/testing/gen"
import { exact, set } from "@grizzle/testing/oracle"
import { fullSwarm, keep, type Swarm, weightOf } from "@grizzle/testing/swarm"
import { Array as Arr, Option } from "effect"
import type { FieldDesc, LiteralDesc } from "#compiler/ir/desc.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { Heading, KeySet } from "#compiler/ir/rel.ts"
import { type ScalarType, sameScalarType } from "#compiler/ir/scalar.ts"
import type {
	AuthoredRelationDesc as RelationDesc,
	SchemaDesc,
	AuthoredStatementDesc as StatementDesc
} from "#test/support/fixtures/ir/desc.ts"
import {
	allTypeSpecs,
	baseTypeSpecs,
	fieldDescOf,
	keyFieldType,
	typedLiteralDesc,
	resolveValue,
	type Spelling,
	scalarOfSpec,
	type ValueSketch
} from "#test/support/oracle/gen/domain.ts"
import { cyclicAt, elementAt, nonEmptyList } from "#test/support/oracle/pick.ts"

/**
 * The features a case's data swarm turns on, off or thins: closed rosters, candidate keys, containments,
 * mutable relations, pure sets, composite primary keys, and how many facts each relation holds (facts.ts).
 */
export const dataFeatures = [
	"closed",
	"candidateKeys",
	"containments",
	"mutable",
	"pureSets",
	"compositeKeys",
	"rows"
] as const

export type DataFeature = (typeof dataFeatures)[number]

/** The data swarm that turns every feature on at full weight: a resolution without swarm testing. */
export const fullDataSwarm: Swarm<DataFeature> = fullSwarm(dataFeatures)

interface GenColumn {
	readonly name: string
	readonly type: ScalarType
}

export interface GenRelation {
	readonly name: string
	readonly columns: ReadonlyArray<GenColumn>
	readonly primaryKey: KeySet
	/** Candidate keys beyond the primary key, each lowered to UNIQUE. */
	readonly keys: ReadonlyArray<KeySet>
	readonly mutable: boolean
}

/** A closed relation: its roster of handles and its payload facts. Its rows are [handle, ...payload]. */
export interface GenClosed {
	readonly name: string
	readonly handles: Arr.NonEmptyReadonlyArray<string>
	readonly payload: ReadonlyArray<GenColumn>
	readonly rows: ReadonlyArray<ReadonlyArray<TypedLiteral>>
}

/** contained(from, to): a native FK from some fields of `from` into the primary key of `to`, an earlier relation. */
export interface GenContainment {
	readonly from: { readonly relation: string; readonly fields: ReadonlyArray<string> }
	readonly to: { readonly relation: string; readonly fields: ReadonlyArray<string> }
}

/**
 * Generated schemas.
 *
 * A generated schema has one to four stored relations and up to two closed rosters. Every relation declares its
 * primary key, which a pure set makes its whole heading, and up to two candidate keys; nothing else
 * implies uniqueness. Every key is representable: a key field over bare numeric is declared numeric(5,2),
 * and generated text is bounded (domain.ts). A relation may hold a closedId (enum) field of a roster and one containment of some of its
 * fields into an earlier relation's primary key, so the containment graph is acyclic and the fact generator can fill
 * referenced relations first. Some relations are declared mutable; immutable is the pinned default.
 *
 * The columns draw their types from a small per-case palette, so different relations share field types and the
 * query generator finds joins, unions and correlations often.
 *
 * The schema is generated as a sketch of plain numbers, every choice reduced modulo what is available, and resolved
 * under the case's data swarm, which draws its thinning decisions from the case's tape: any sketch is a valid schema,
 * and shrinking a number toward zero keeps it valid.
 */
export interface GenSchema {
	readonly name: string
	/** In declaration order; a containment's target precedes its source. */
	readonly relations: ReadonlyArray<GenRelation>
	readonly closed: ReadonlyArray<GenClosed>
	readonly containments: ReadonlyArray<GenContainment>
}

export const schemaName = "Oracle"

const columnIndex = (relation: GenRelation, name: string): number => {
	const i = Arr.findFirstIndex(relation.columns, (c) => c.name === name)
	if (Option.isNone(i)) {
		throw new Error(`${relation.name} has no column ${name}`)
	}
	return i.value
}

export const keyIndices = (relation: GenRelation, key: KeySet): ReadonlyArray<number> =>
	Arr.map(key, (name) => columnIndex(relation, name))

export const isPureSet = (relation: GenRelation): boolean =>
	relation.primaryKey.length === relation.columns.length

/** The primary key first, then the candidate keys. */
export const allKeys = (relation: GenRelation): ReadonlyArray<KeySet> => [
	relation.primaryKey,
	...relation.keys
]

/** A stored relation's heading: every column under its field's name, at its type. */
export const relationHeading = (relation: GenRelation): Heading =>
	Arr.map(relation.columns, (c) => ({ name: c.name, type: c.type }))

/** Whether a type is a span, which only a span key keeps in a key. */
const isSpanType = (type: ScalarType): boolean =>
	type.carrier === "range4" || type.carrier === "range8"

export const closedIdType = (closed: Pick<GenClosed, "name" | "handles">): ScalarType =>
	scalarOfSpec({ carrier: "enum", roster: { closed: closed.name, handles: closed.handles } })

/** A closed relation's heading: the handle column `id`, typed by its roster, then the payload. */
export const closedHeading = (closed: GenClosed): Heading => [
	{ name: "id", type: closedIdType(closed) },
	...Arr.map(closed.payload, (c) => ({ name: c.name, type: c.type }))
]

export const relationNamed = (schema: GenSchema, name: string): GenRelation => {
	const r = Arr.findFirst(schema.relations, (rel) => rel.name === name)
	if (Option.isNone(r)) {
		throw new Error(`no relation ${name}`)
	}
	return r.value
}

/**
 * The schema's Description: relation, closed, key, mutable and contained, exactly what the
 * public constructors record for this schema. It is an admissible schema: ownership (packages/engine/src/schema/own.ts)
 * accepts it, every key representable.
 */
export const schemaDesc = (schema: GenSchema): SchemaDesc => {
	const closed: Array<RelationDesc> = Arr.map(schema.closed, (c) => {
		const payload: Record<string, FieldDesc> = {}
		for (const col of c.payload) {
			payload[col.name] = fieldDescOf(col.type)
		}
		const facts: Record<string, Record<string, LiteralDesc>> = {}
		for (const row of c.rows) {
			const handle = elementAt(row, 0, "a closed row")
			if (handle.kind !== "enum") {
				throw new Error("a closed row starts with its handle")
			}
			const fact: Record<string, LiteralDesc> = {}
			for (const [i, col] of c.payload.entries()) {
				fact[col.name] = typedLiteralDesc(elementAt(row, i + 1, "a closed row"), col.type)
			}
			facts[handle.handle] = fact
		}
		return {
			kind: "closed",
			name: c.name,
			handles: c.handles,
			payload,
			facts
		}
	})
	const relations: Array<RelationDesc> = Arr.map(schema.relations, (r) => {
		const fields: Record<string, FieldDesc> = {}
		for (const col of r.columns) {
			fields[col.name] = fieldDescOf(col.type)
		}
		const [key, ...rest] = r.primaryKey
		if (key === undefined) {
			throw new Error(`the generated relation ${r.name} has no primary key`)
		}
		return { kind: "relation", name: r.name, fields, primaryKey: [key, ...rest] }
	})
	const statements: Array<StatementDesc> = []
	for (const r of schema.relations) {
		for (const key of r.keys) {
			statements.push({
				kind: "key",
				relation: r.name,
				fields: nonEmptyList(key, "a candidate key")
			})
		}
		if (r.mutable) {
			statements.push({ kind: "mutable", relation: r.name })
		}
	}
	for (const c of schema.containments) {
		statements.push({
			kind: "contained",
			left: {
				relation: c.from.relation,
				fields: nonEmptyList(c.from.fields, "a containment's fields"),
				selection: {}
			},
			right: {
				relation: c.to.relation,
				fields: nonEmptyList(c.to.fields, "a containment's fields"),
				selection: {}
			},
			origin: undefined
		})
	}
	return { name: schema.name, relations: [...closed, ...relations], statements, extends: undefined }
}

interface ClosedSketch {
	readonly handles: number
	readonly payload: ReadonlyArray<{
		readonly type: number
		readonly values: ReadonlyArray<ValueSketch>
	}>
}

interface RelationSketch {
	/** One palette pick per column. */
	readonly columns: ReadonlyArray<number>
	readonly pkMask: number
	readonly pure: boolean
	readonly keyMasks: ReadonlyArray<number>
	readonly mutable: boolean
	/**
	 * A containment into relation (target mod index), when enabled and the field types line up. A `typed` containment
	 * lines them up: a target key field no column of the relation matches retypes the first unused column to it.
	 */
	readonly fk: { readonly enabled: boolean; readonly target: number; readonly typed: boolean }
	/** Whether the primary key is a span key, where the limits draw them and the relation holds a span field. */
	readonly spanKey: boolean
}

export interface SchemaSketch {
	/** Picks into allTypeSpecs, the base specs first; the case's palette. */
	readonly palette: ReadonlyArray<number>
	readonly closed: ReadonlyArray<ClosedSketch>
	readonly relations: ReadonlyArray<RelationSketch>
}

export interface SchemaLimits {
	readonly minRelations: number
	readonly maxRelations: number
	readonly maxColumns: number
	readonly maxClosed: number
	/** The most palette entries a case draws its column types from (the closed rosters' enums are added to it). */
	readonly maxPalette: number
	/**
	 * Whether the palette draws the extended flavors too (domain.ts carrierDraws): contracts over bigint and over refined
	 * text, and unbounded text with TOAST-sized values.
	 */
	readonly extended: boolean
	/**
	 * Whether half the palette picks draw wide payload, which a take may fetch by key after it has chosen its rows:
	 * unbounded text with TOAST-sized values, and vectors too unless only text is asked for; or none ("none").
	 */
	readonly wide: "none" | "text" | "textAndVectors"
	/**
	 * How the relations after the first declare a containment into an earlier one: half of them where the field types
	 * line up ("drawn"); three in four, retyping a column where the field types do not line up, so most multi-relation
	 * schemas have one for a query to read through ("often"); or never ("none").
	 */
	readonly containments: "drawn" | "often" | "none"
	/**
	 * Whether a relation's primary key may be a span key ("spanKeys"): one span field kept as a range, the key's last
	 * field, beside at least one scalar field, whose facts never overlap per scalar value; a containment into it is a
	 * PERIOD foreign key. "scalar" keys every span field by its endpoint's type.
	 */
	readonly keys: "scalar" | "spanKeys"
}

export const defaultSchemaLimits: SchemaLimits = {
	minRelations: 1,
	maxRelations: 4,
	maxColumns: 5,
	maxClosed: 2,
	maxPalette: 3,
	extended: false,
	wide: "none",
	containments: "drawn",
	keys: "scalar"
}

export const valueSketchGen: Gen<ValueSketch> = (source) => ({
	cls: source.draw(int(0, 15)),
	sp: source.draw(int(0, 3))
})

const closedSketchGen: Gen<ClosedSketch> = (source) => ({
	handles: source.draw(int(1, 3)),
	payload: source.draw(
		array(
			(payload) => ({
				type: payload.draw(int(0, baseTypeSpecs.length - 1)),
				values: payload.draw(array(valueSketchGen, { min: 3, max: 3 }))
			}),
			{ min: 0, max: 2 }
		)
	)
})

const fkSketchGen = (containments: SchemaLimits["containments"]): Gen<RelationSketch["fk"]> => {
	switch (containments) {
		case "drawn":
			return (source) => ({
				enabled: source.draw(boolean),
				target: source.draw(int(0, 3)),
				typed: false
			})
		case "often":
			return (source) => ({
				enabled: source.draw(
					weighted([
						[3, constant(true)],
						[1, constant(false)]
					])
				),
				target: source.draw(int(0, 3)),
				typed: true
			})
		case "none":
			return constant({ enabled: false, target: 0, typed: false })
	}
}

const relationSketchGen = (limits: SchemaLimits): Gen<RelationSketch> => {
	const fk = fkSketchGen(limits.containments)
	return (source) => ({
		columns: source.draw(array(int(0, 7), { min: 1, max: limits.maxColumns })),
		pkMask: source.draw(int(0, 31)),
		pure: source.draw(boolean),
		keyMasks: source.draw(array(int(0, 31), { min: 0, max: 2 })),
		mutable: source.draw(boolean),
		fk: source.draw(fk),
		spanKey: limits.keys === "spanKeys" ? source.draw(boolean) : false
	})
}

/** The palette picks of the wide payload types, into allTypeSpecs. */
const widePicks = (wide: "text" | "textAndVectors"): ReadonlyArray<number> =>
	Arr.flatMap(allTypeSpecs, (t, i) =>
		t.carrier === "longText" || (wide === "textAndVectors" && t.carrier === "vector") ? [i] : []
	)

const palettePickGen = (limits: SchemaLimits): Gen<number> => {
	const pick = int(0, (limits.extended ? allTypeSpecs.length : baseTypeSpecs.length) - 1)
	return limits.wide === "none"
		? pick
		: oneOf([pick, element(nonEmptyList(widePicks(limits.wide), "the wide picks"))])
}

export const schemaSketchGen = (limits: SchemaLimits): Gen<SchemaSketch> => {
	const palette = array(palettePickGen(limits), { min: 1, max: limits.maxPalette })
	const closed = array(closedSketchGen, { min: 0, max: limits.maxClosed })
	const relations = array(relationSketchGen(limits), {
		min: limits.minRelations,
		max: limits.maxRelations
	})
	return (source) => ({
		palette: source.draw(palette),
		closed: source.draw(closed),
		relations: source.draw(relations)
	})
}

const columnNames = ["a", "b", "c", "d", "e", "f", "g", "h"] as const

const maskColumns = (mask: number, width: number): ReadonlyArray<number> => {
	const out: Array<number> = []
	for (let i = 0; i < width; i++) {
		if (((mask >> i) & 1) === 1) {
			out.push(i)
		}
	}
	return out
}

/** Two keys are one key when they hold the same columns, in any order. */
const sameKey = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	Option.isNone(set(exact)(a, b))

/**
 * Resolves a sketch to a schema under the case's data swarm, drawing the swarm's thinning decisions from the case's
 * tape. The closed rosters come first, since the relations' palette includes their enums.
 *
 * A pick past the base types names an extended type; a sketch drawn without them never makes one.
 *
 * The span key's span field is no other key's.
 *
 * A candidate key that contains the primary key is implied by it; a repeated key is one key.
 */
export const resolveSchema =
	(sketch: SchemaSketch, spelling: Spelling, swarm: Swarm<DataFeature>): Gen<GenSchema> =>
	(source) => {
		const rosters = weightOf(swarm, "closed") > 0 ? sketch.closed : []
		const closed: Array<GenClosed> = Arr.map(rosters, (c, ci) => {
			const name = `K${ci}`
			const handles = Arr.makeBy(c.handles, (h) => `H${h}`)
			const payload: Array<GenColumn> = Arr.map(c.payload, (p, pi) => ({
				name: `p${pi}`,
				type: scalarOfSpec(cyclicAt(baseTypeSpecs, p.type, "the base type specs"))
			}))
			const rows = Arr.map(handles, (handle, h) => [
				{ kind: "enum", handle } satisfies TypedLiteral,
				...Arr.map(payload, (col, pi) => {
					const values = elementAt(c.payload, pi, "a closed sketch's payload").values
					return resolveValue(col.type, cyclicAt(values, h, "a payload's values"), spelling.edge)
				})
			])
			return { name, handles, payload, rows }
		})
		const palette: Array<ScalarType> = []
		const addType = (t: ScalarType) => {
			if (!Arr.some(palette, (p) => sameScalarType(p, t))) {
				palette.push(t)
			}
		}
		for (const pick of sketch.palette) {
			addType(scalarOfSpec(cyclicAt(allTypeSpecs, pick, "the type specs")))
		}
		for (const c of closed) {
			addType(closedIdType(c))
		}
		const relations: Array<GenRelation> = []
		const containments: Array<GenContainment> = []
		for (const [ri, rs] of sketch.relations.entries()) {
			const name = `R${ri}`
			const picked: ReadonlyArray<GenColumn> = Arr.map(rs.columns, (pick, ci) => ({
				name: elementAt(columnNames, ci, "the column names"),
				type: cyclicAt(palette, pick, "the palette")
			}))
			const all = Arr.map(picked, (c) => c.name)
			const pkColumns =
				rs.pure && source.draw(keep(swarm, "pureSets"))
					? all
					: Arr.map(maskColumns(rs.pkMask, picked.length), (i) =>
							elementAt(all, i, "the picked columns")
						)
			const composite =
				pkColumns.length <= 1 ||
				all.length === pkColumns.length ||
				source.draw(keep(swarm, "compositeKeys"))
			const drawnKey =
				pkColumns.length === 0 || !composite
					? [elementAt(pkColumns.length === 0 ? all : pkColumns, 0, "the key columns")]
					: pkColumns
			/**
			 * A span key keeps the relation's first span field a range as its last field, beside the drawn key's other
			 * fields, or the first other field when the drawn key has none; a relation of one field has no span key.
			 */
			const spanField = rs.spanKey
				? Option.map(
						Arr.findFirst(picked, (c) => isSpanType(c.type)),
						(c) => c.name
					)
				: Option.none()
			const spanScalars = Arr.filter(drawnKey, (f) => !Option.contains(spanField, f))
			const scalars =
				spanScalars.length > 0
					? spanScalars
					: Arr.filter(all, (f) => !Option.contains(spanField, f)).slice(0, 1)
			const span = scalars.length > 0 ? spanField : Option.none()
			const primaryKey = Option.match(span, {
				onNone: () => drawnKey,
				onSome: (field) => [...scalars, field]
			})
			const keys: Array<KeySet> = []
			for (const mask of weightOf(swarm, "candidateKeys") > 0 ? rs.keyMasks : []) {
				const key = Arr.map(maskColumns(mask, picked.length), (i) =>
					elementAt(all, i, "the picked columns")
				)
				if (key.length === 0) {
					continue
				}
				if (Option.exists(span, (field) => key.includes(field))) {
					continue
				}
				if (Arr.every(primaryKey, (c) => key.includes(c))) {
					continue
				}
				if (Arr.some(keys, (k) => sameKey(k, key))) {
					continue
				}
				keys.push(key)
			}
			/** Every key passes the representability check: a key field takes its representable type. */
			const keyed = new Set([...primaryKey, ...keys.flat()])
			let columns: ReadonlyArray<GenColumn> = Arr.map(picked, (c) =>
				keyed.has(c.name)
					? {
							name: c.name,
							type: keyFieldType(c.type, Option.contains(span, c.name) ? "span" : "scalar")
						}
					: c
			)
			const mutable = rs.mutable && source.draw(keep(swarm, "mutable"))
			/**
			 * The columns matched to `target`'s primary key fields in order, each retyped to its field's type where needed;
			 * the matching stops at the first field no column matches.
			 */
			const matchedFields = (target: GenRelation): ReadonlyArray<string> => {
				const used = new Set<string>()
				const fields: Array<string> = []
				for (const pkName of target.primaryKey) {
					const pkType = Option.getOrThrowWith(
						Arr.findFirst(target.columns, (c) => c.name === pkName),
						() => new Error(`${target.name} has no primary key column ${pkName}`)
					).type
					/**
					 * A target key field is of a key field's type, so a column retyped to it stays representable in a key. A
					 * span key's span field pairs with a span field outside the relation's keys, retyped to it where none
					 * matches: the containment is a PERIOD foreign key.
					 */
					const period = isSpanType(pkType)
					const free = (c: GenColumn) => !used.has(c.name) && !(period && keyed.has(c.name))
					const match = Option.orElse(
						Arr.findFirst(columns, (c) => free(c) && sameScalarType(c.type, pkType)),
						() => (rs.fk.typed || period ? Arr.findFirst(columns, free) : Option.none())
					)
					if (Option.isNone(match)) {
						return fields
					}
					const matched = match.value
					columns = Arr.map(columns, (c) =>
						c.name === matched.name && !sameScalarType(matched.type, pkType)
							? { name: c.name, type: pkType }
							: c
					)
					used.add(matched.name)
					fields.push(matched.name)
				}
				return fields
			}
			if (rs.fk.enabled && ri > 0 && source.draw(keep(swarm, "containments"))) {
				const target = elementAt(relations, rs.fk.target % ri, "the earlier relations")
				const fields = matchedFields(target)
				if (fields.length === target.primaryKey.length) {
					containments.push({
						from: { relation: name, fields },
						to: { relation: target.name, fields: [...target.primaryKey] }
					})
				}
			}
			relations.push({ name, columns, primaryKey, keys, mutable })
		}
		return { name: schemaName, relations, closed, containments }
	}

/** The containment out of a relation, when it has one. */
export const containmentFrom = (
	schema: GenSchema,
	relation: string
): Option.Option<GenContainment> =>
	Arr.findFirst(schema.containments, (c) => c.from.relation === relation)
