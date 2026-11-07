import { Array as Arr, Option, String as Str } from "effect"
import type { Column } from "#compiler/core/decoder.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import type { ParamDecl } from "#compiler/ir/products.ts"
import type { Fact } from "#compiler/ir/proof.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { contractOf, type RegexRef, type ScalarType } from "#compiler/ir/scalar.ts"
import { admitPattern } from "#compiler/scalar/regex/admit.ts"
import { longest, membersWithin } from "#compiler/scalar/regex/dfa.ts"
import { carrierSql } from "#compiler/scalar/registry.ts"
import { languageOf } from "#compiler/text/refinement.ts"
import type { Carriers } from "#compiler/types/core/phantom.ts"

/**
 * The engine's decoded heading, written as the TypeScript type its records have, so a generated program asserts the
 * type the types infer equal to it exactly (test/support/agreement/queries.ts).
 *
 * A column's host type is read off what the engine knows of it: the scalar type the checker gives it (its carrier and
 * contract) and the values its decoder's column delivers (core/decoder.ts Column): a head literal's column delivers its
 * literals, a closed id's its handles, narrowed to a handle's own member where the column is a constant's, and every
 * other column its carrier's host values, under its contract's brand. A text is a string, but one whose refinement's
 * language is finite, whose values are its members. A span's host values are spans of its endpoint's, under the
 * endpoint contract's brand, and a vector's are vectors of its dimension count.
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
			return type.text.regex === "wildcard" ? "string" : textHost(type.text.regex)
		case "code":
			return handles(type.roster.handles)
		case "range4":
		case "range8":
			return `Span<${branded(type.span.endpoint, carrierHost(type.span.endpoint))}>`
		case "vector":
			return `Vector<${type.typmod.dims}>`
		case "date":
		case "bits":
			throw new Error(`no agreement schema declares a ${type.carrier} field`)
	}
}

/**
 * The host values of a refined text: the members of a finite language, as the engine's text analysis proves it
 * (text/refinement.ts languageOf, its minimal automaton acyclic), and every string for any other.
 */
const textHost = (regex: RegexRef): string => {
	const admitted = admitPattern(regex.source, regex.flags, SourceLoc("heading", []))
	if (!admitted.ok) {
		throw new Error(`the engine refuses a pattern it admitted: /${regex.source}/${regex.flags}`)
	}
	const language = languageOf(admitted.value.ir, admitted.value.nfa)
	if (language.kind === "empty" || language.known.kind === "structure") {
		return "string"
	}
	const dfa = language.known.dfa
	if (longest(dfa) === undefined) {
		return "string"
	}
	const members = membersWithin(dfa, 1, memberWeight)
	if (members === undefined || !Arr.isReadonlyArrayNonEmpty(members)) {
		throw new Error(
			`no agreement schema declares a finite text of so many members: /${regex.source}/`
		)
	}
	return handles(members)
}

/** The weight a finite text's members are listed within: each member's bytes and one more, far above any declared. */
const memberWeight = 4096

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

/**
 * The facts every value of a type has by its contracts' declarations, each contract level's (ir/scalar.ts
 * ContractInfo.facts), sorted and each once: none for a type of no contract.
 */
const declaredFacts = (type: ScalarType): ReadonlyArray<Fact> => {
	const facts = new Set<Fact>()
	for (let c = contractOf(type); c !== undefined; c = contractOf(c.base)) {
		for (const f of c.facts) {
			facts.add(f)
		}
	}
	return Arr.sort([...facts], Str.Order)
}

/**
 * A type's identity as the types state it, a domain: its host under its contract's brand, with one Declares per fact its
 * contracts declare (types/fields/field.ts Contract).
 */
const domainOf = (type: ScalarType, host: string): string =>
	Arr.join(
		[branded(type, host), ...Arr.map(declaredFacts(type), (f) => `Declares<${jsonText(f)}>`)],
		" & "
	)

/**
 * The facts a variable read from a column of the engine's type has, as the types state them (types/core/phantom.ts
 * ColumnFacts): its contracts' declared facts, or Facts, nothing proved, where none declares any.
 */
export const columnFacts = (type: ScalarType): string => {
	const facts = declaredFacts(type)
	return Arr.isReadonlyArrayNonEmpty(facts)
		? recordType(Arr.map(facts, (f) => [f, "true"] as const))
		: "Facts"
}

/**
 * A parameter's entry in a query's parameter map, as the types state it (ParamType, a relation's rows): its domain, its
 * SQL type, and its language where the two differ, a roster's and a contract's that declares a fact.
 */
const paramEntry = (p: ParamDecl): string => {
	if (p.kind === "relation") {
		const row = recordType(
			Arr.map(p.heading, (c) => [c.name, branded(c.type, carrierHost(c.type))] as const)
		)
		return `ReadonlyArray<${row}> | Stream.Stream<${row}>`
	}
	const sql = jsonText(carrierSql[p.type.carrier])
	const host = branded(p.type, carrierHost(p.type))
	const domain = domainOf(p.type, carrierHost(p.type))
	return p.type.carrier === "code"
		? `ParamType<${host} & Rostered<${jsonText(p.type.roster.closed)}>, ${sql}, ${host}>`
		: domain === host
			? `ParamType<${host}, ${sql}>`
			: `ParamType<${domain}, ${sql}, ${host}>`
}

/** A query's parameter map as the types state it: unknown where it takes none. */
export const paramsType = (params: ReadonlyArray<ParamDecl>): string =>
	Arr.isReadonlyArrayNonEmpty(params)
		? recordType(Arr.map(params, (p) => [p.name, paramEntry(p)] as const))
		: "unknown"
