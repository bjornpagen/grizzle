import { boolean, element, type Gen, subarray, weighted } from "@grizzle/testing/gen"
import { Array as Arr, Option } from "effect"
import type { FieldDesc, LiteralDesc } from "#compiler/ir/desc.ts"
import {
	contractOf,
	numericTypmodOf,
	rosterOf,
	type ScalarType,
	textOf
} from "#compiler/ir/scalar.ts"
import {
	closed,
	f,
	type FixtureField,
	ge,
	literal,
	relation,
	type SchemaDesc,
	value
} from "#test/support/fixtures/ir/desc.ts"

/**
 * Small schemas the checker's models draw: the roster Kind and up to three relations, R0, R1 and R2, whose fields are
 * named from one short pool, so arms and matches over different relations meet at shared names, each field of a kind
 * from one dictionary of the types the checker's typing rules branch on.
 */

/** The roster every drawn schema declares, and its handles in roster order. */
export const rosterName = "Kind"
export const handles = ["H0", "H1", "H2"] as const
export type Handle = (typeof handles)[number]

/**
 * The kinds of field: integer, bigint, uuid, numeric at two typmods, text of two languages and the wildcard, Kind's
 * closed id, and Qty, a contract over integer of the values at least 0.
 */
export const columnKinds = [
	"int4",
	"int8",
	"uuid",
	"num10",
	"num12",
	"lower",
	"code",
	"prose",
	"kind",
	"qty"
] as const
export type ColumnKind = (typeof columnKinds)[number]

/** The kinds a key may hold: every bounded one. Lower-case text and the wildcard are unbounded, which a key refuses. */
const keyColumnKinds = ["int4", "int8", "uuid", "num10", "num12", "code", "kind", "qty"] as const

/**
 * What a kind is compatible with: its family, whose members differ at most in a numeric typmod or a text refinement. A
 * contract is compatible with itself alone.
 */
export type Family = "int4" | "int8" | "uuid" | "numeric" | "text" | "kind" | "qty"

export const familyOf = (kind: ColumnKind): Family => {
	switch (kind) {
		case "int4":
		case "int8":
		case "uuid":
		case "kind":
		case "qty":
			return kind
		case "num10":
		case "num12":
			return "numeric"
		case "lower":
		case "code":
		case "prose":
			return "text"
	}
}

/** Qty: a contract over integer whose values are at least 0. */
export const qtyDesc: FieldDesc = f.contract("Qty", f.integer, ge(value, literal(0)))

export const descriptorOf = (kind: ColumnKind): FieldDesc => {
	switch (kind) {
		case "int4":
			return f.integer
		case "int8":
			return f.bigint
		case "uuid":
			return f.uuid
		case "num10":
			return f.numeric(10, 2)
		case "num12":
			return f.numeric(12, 4)
		case "lower":
			return f.regex("^[a-z]+$", "u")
		case "code":
			return f.regex("^[a-z0-9]{1,32}$", "u")
		case "prose":
			return f.wildcard
		case "kind":
			return f.closedId(rosterName)
		case "qty":
			return qtyDesc
	}
}

export interface DrawnField {
	readonly name: string
	readonly kind: ColumnKind
}

/**
 * A relation of a drawn schema: its first field `id` and its key, `id` alone or with one more key field. `serial`
 * declares a bigint field `seq` its sequence writes.
 */
export interface DrawnRelation {
	readonly name: string
	readonly fields: Arr.NonEmptyReadonlyArray<DrawnField>
	readonly key: Arr.NonEmptyReadonlyArray<string>
	readonly serial: boolean
}

export interface DrawnSchema {
	readonly relations: Arr.NonEmptyReadonlyArray<DrawnRelation>
}

/** The names a relation's fields after `id` are drawn from. */
const fieldNames = ["a", "b", "c"] as const

/** The name of a relation's serial field. */
export const serialField = "seq"

const isKeyKind = (kind: ColumnKind): boolean => Arr.some(keyColumnKinds, (k) => k === kind)

/** The kinds of each family, the members a field of the family is drawn among. */
const familyKinds = (family: Family): Arr.NonEmptyReadonlyArray<ColumnKind> =>
	Arr.match(
		Arr.filter(columnKinds, (k) => familyOf(k) === family),
		{
			onEmpty: () => [columnKinds[0]],
			onNonEmpty: (kinds) => kinds
		}
	)

/** The families a name is planned in, those of several kinds, whose fields differ by a typmod or a refinement, most. */
const familyGen: Gen<Family> = weighted([
	[3, element(["numeric", "text"] as const)],
	[2, element(["int4", "int8", "uuid", "kind", "qty"] as const)]
])

/**
 * The family each field name's fields are drawn from, mostly: fields of one name across relations are then often of
 * one family, of one type or of two that differ in a typmod or a refinement, and sometimes of none.
 */
type FamilyPlan = ReadonlyMap<string, Family>

/** A kind of `family` five draws in six, any kind of `among` otherwise. */
const plannedKind = (
	family: Family,
	among: Arr.NonEmptyReadonlyArray<ColumnKind>
): Gen<ColumnKind> => {
	const planned = Arr.filter(familyKinds(family), (k) => Arr.contains(among, k))
	const [first, ...rest] = planned
	return first === undefined
		? element(among)
		: weighted([
				[5, element([first, ...rest])],
				[1, element(among)]
			])
}

/** The relation named `name`, with a serial field where `serial` allows one and the draw keeps it. */
const relationGen =
	(name: string, plan: FamilyPlan, serial: boolean): Gen<DrawnRelation> =>
	(source) => {
		const kindFor = (field: string, among: Arr.NonEmptyReadonlyArray<ColumnKind>): ColumnKind =>
			source.draw(plannedKind(plan.get(field) ?? "uuid", among))
		const id: DrawnField = { name: "id", kind: kindFor("id", keyColumnKinds) }
		const more = Arr.map(source.draw(subarray(fieldNames)), (n): DrawnField => ({
			name: n,
			kind: kindFor(n, columnKinds)
		}))
		const keyed = Arr.filter(more, (m) => isKeyKind(m.kind))
		const [firstKeyed, ...restKeyed] = keyed
		const second =
			firstKeyed !== undefined && source.draw(boolean)
				? source.draw(element([firstKeyed, ...restKeyed]))
				: undefined
		return {
			name,
			fields: [id, ...more],
			key: second === undefined ? ["id"] : ["id", second.name],
			serial: serial && source.draw(boolean)
		}
	}

/** A drawn schema of between one and `most` relations, a serial field allowed where `serial`. */
export const drawnSchemaGen =
	(most: number, serial: boolean): Gen<DrawnSchema> =>
	(source) => {
		const plan: FamilyPlan = new Map(
			Arr.map(["id", ...fieldNames], (n) => [n, source.draw(familyGen)] as const)
		)
		const count = source.draw(element(Arr.range(1, most)))
		const first = source.draw(relationGen("R0", plan, serial))
		const rest = Arr.map(Arr.range(1, count - 1), (i) =>
			source.draw(relationGen(`R${i}`, plan, serial))
		)
		return { relations: [first, ...(count > 1 ? rest : [])] }
	}

/** A relation's field kind by name, which the drawn relation declares. */
export const kindOf = (r: DrawnRelation, field: string): ColumnKind =>
	Option.getOrThrowWith(
		Arr.findFirst(r.fields, (x) => x.name === field),
		() => new Error(`${r.name} declares no field ${field}`)
	).kind

/** The relation at `index` of the schema, which the drawn case names. */
export const relationAt = (s: DrawnSchema, index: number): DrawnRelation =>
	Option.getOrThrowWith(
		Arr.get(s.relations, index),
		() => new Error(`the drawn schema declares no R${index}`)
	)

/** The drawn schema as the Description its builders record: Kind, then each relation. */
export const schemaDescOf = (s: DrawnSchema): SchemaDesc => ({
	name: "Drawn",
	relations: [
		closed(rosterName, handles),
		...Arr.map(s.relations, (r) => {
			const fields: Record<string, FixtureField> = {}
			for (const x of r.fields) {
				fields[x.name] = descriptorOf(x.kind)
			}
			if (r.serial) {
				fields[serialField] = f.bigserial
			}
			return relation(r.name, fields, r.key)
		})
	],
	statements: [],
	extends: undefined
})

/** A kind's value a typed literal states: one per family, admitted by every kind of its family. */
export const valueOf = (kind: ColumnKind): LiteralDesc => {
	switch (kind) {
		case "int4":
		case "qty":
			return 1
		case "int8":
			return 1n
		case "uuid":
			return "6f1c3a52-0c4e-4b1e-9a51-1c2f3e4d5a6b"
		case "num10":
		case "num12":
			return "1.5"
		case "lower":
		case "code":
		case "prose":
			return "abc"
		case "kind":
			return "H1"
	}
}

/**
 * The kind a checked type is, or `hull` for numeric of no typmod, which two typmods meet as; undefined for a type no
 * kind declares. A text type is told by its declared pattern, the wildcard by its canonical form.
 */
export const kindOfType = (t: ScalarType): ColumnKind | "hull" | undefined => {
	switch (t.carrier) {
		case "int4":
			return contractOf(t)?.name === "Qty"
				? "qty"
				: contractOf(t) === undefined
					? "int4"
					: undefined
		case "int8":
			return contractOf(t) === undefined ? "int8" : undefined
		case "uuid":
			return "uuid"
		case "numeric": {
			const typmod = numericTypmodOf(t)
			return typmod === undefined
				? "hull"
				: typmod.precision === 10 && typmod.scale === 2
					? "num10"
					: typmod.precision === 12 && typmod.scale === 4
						? "num12"
						: undefined
		}
		case "text": {
			const regex = textOf(t)?.regex
			return regex === "wildcard"
				? "prose"
				: regex?.source === "^[a-z]+$"
					? "lower"
					: regex?.source === "^[a-z0-9]{1,32}$"
						? "code"
						: undefined
		}
		case "code":
			return rosterOf(t)?.closed === rosterName ? "kind" : undefined
		case "int2":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "date":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "exactInteger":
		case "exactMoney":
			return undefined
	}
}
