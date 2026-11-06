import { Array as Arr, Option } from "effect"
import type { Column } from "#compiler/core/decoder.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import type { ParamDecl } from "#compiler/ir/products.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { contractOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { carrierSql } from "#compiler/scalar/registry.ts"
import type { Carriers } from "#compiler/types/core/phantom.ts"

/**
 * The engine's decoded heading, written as the TypeScript type its records have, so a generated program asserts the
 * type the types infer equal to it exactly (test/support/agreement/queries.ts).
 *
 * A column's host type is read off what the engine knows of it: the scalar type the checker gives it (its carrier and
 * contract) and the values its decoder's column delivers (core/decoder.ts Column): a head literal's column delivers its
 * literals, a closed id's its handles, narrowed to a handle's own member where the column is a constant's, and every
 * other column its carrier's host values, under its contract's brand. Every text the agreement schemas declare has the
 * language of every string, so a text is a string.
 */

/** A head literal's TypeScript literal type. */
const literalType = (value: unknown): string => {
	switch (typeof value) {
		case "string":
			return jsonText(value)
		case "bigint":
			return `${value}n`
		case "number":
		case "boolean":
			return String(value)
		case "function":
		case "object":
		case "symbol":
		case "undefined":
			throw new Error(`no head literal of the agreement is a ${typeof value}`)
	}
}

/** The union of TypeScript types, parenthesized so a brand intersects it whole. */
const union = (types: Arr.NonEmptyReadonlyArray<string>): string =>
	types.length === 1 ? types[0] : `(${Arr.join(Arr.dedupe(types), " | ")})`

/** A roster's handles as the union of their literals. */
const handles = (values: Arr.NonEmptyReadonlyArray<unknown>): string =>
	union(Arr.map(values, literalType))

/** The host values of a carrier, before a contract brands them. */
const carrierHost = (type: ScalarType): string => {
	switch (type.carrier) {
		case "int2":
		case "int4":
		case "float4":
		case "float8":
			return "number"
		case "int8":
		case "exactInteger":
			return "bigint"
		case "numeric":
			return "Decimal"
		case "money":
		case "exactMoney":
			return "Money"
		case "bool":
			return "boolean"
		case "uuid":
			return "Uuid"
		case "text":
			return "string"
		case "code":
			return handles(type.roster.handles)
		case "range4":
			return "Span<number>"
		case "range8":
			return "Span<bigint>"
		case "vector":
			return "Vector"
		case "date":
		case "bits":
			throw new Error(`no agreement schema declares a ${type.carrier} field`)
	}
}

/** A host type under its contract's brand, where the type is a contract's. */
const branded = (type: ScalarType, host: string): string => {
	const contract = contractOf(type)
	return contract === undefined ? host : `${host} & Brand.Brand<${jsonText(contract.name)}>`
}

/** The host type of a column the engine types `type` and decodes by `column`. */
const columnHost = (type: ScalarType, column: Column<unknown>): string => {
	switch (column.kind) {
		case "constant":
			return handles(column.values)
		case "code":
			return branded(type, handles(column.handles))
		case "convert":
		case "text":
		case "bits":
			return branded(type, carrierHost(type))
	}
}

/** A record type over named field types. */
export const recordType = (fields: ReadonlyArray<readonly [string, string]>): string =>
	Arr.isReadonlyArrayNonEmpty(fields)
		? `{ ${Arr.join(
				Arr.map(fields, ([name, type]) => `readonly ${name}: ${type}`),
				"; "
			)} }`
		: "{}"

/**
 * The fields of one heading group's records: each key its decoder reads, typed by the engine's heading and decoded by
 * the group's carriers.
 */
export const groupFields = (
	keys: ReadonlyArray<string>,
	carriers: Carriers,
	heading: Heading
): ReadonlyArray<readonly [string, string]> =>
	Arr.map(keys, (name) => {
		const column = Option.getOrThrowWith(
			Arr.findFirst(heading, (c) => c.name === name),
			() => new Error(`the engine's heading has no column ${name}`)
		)
		const carrier = carriers[name]
		if (carrier === undefined) {
			throw new Error(`the query's carriers have no field ${name}`)
		}
		return [name, columnHost(column.type, carrier.column)] as const
	})

/** A parameter's entry in a query's parameter map, as the types state it (ParamType, a relation's rows). */
const paramEntry = (p: ParamDecl): string => {
	if (p.kind === "relation") {
		const row = recordType(
			Arr.map(p.heading, (c) => [c.name, branded(c.type, carrierHost(c.type))] as const)
		)
		return `ReadonlyArray<${row}> | Stream.Stream<${row}>`
	}
	const sql = jsonText(carrierSql[p.type.carrier])
	const host = branded(p.type, carrierHost(p.type))
	return p.type.carrier === "code"
		? `ParamType<${host} & Rostered<${jsonText(p.type.roster.closed)}>, ${sql}, ${host}>`
		: `ParamType<${host}, ${sql}>`
}

/** A query's parameter map as the types state it: unknown where it takes none. */
export const paramsType = (params: ReadonlyArray<ParamDecl>): string =>
	Arr.isReadonlyArrayNonEmpty(params)
		? recordType(Arr.map(params, (p) => [p.name, paramEntry(p)] as const))
		: "unknown"
