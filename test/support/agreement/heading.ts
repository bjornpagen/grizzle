import { longest, membersWithin } from "@bjornpagen/grizzle-text/regex/dfa"
import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Option, String as Str } from "effect"
import type { Column } from "#compiler/core/decoder.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import type { ParamDecl } from "#compiler/ir/products.ts"
import type { Fact } from "#compiler/ir/proof.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import {
	baseOf,
	patternsText,
	type RegexRef,
	rosterOf,
	type ScalarType
} from "#compiler/ir/scalar.ts"
import { carrierSql } from "#compiler/scalar/registry.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
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
 * endpoint contract's brand, a date's are calendar dates, and a vector's are vectors of its dimension count.
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
/** The host type of a column delivering `values`: their literal types' union, never where it delivers none. */
const handles = (values: ReadonlyArray<unknown>): string =>
	Arr.isReadonlyArrayNonEmpty(values) ? union(Arr.map(values, literalType)) : "never"

/** The host values of a carrier, before a contract brands them. */
const carrierHost = (descriptor: ScalarType): string => {
	const type = baseOf(descriptor)
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
			return typeof type.text === "string" ? "string" : textHost(type.text)
		case "code":
			return handles(type.roster.handles)
		case "range4":
		case "range8":
		case "rangeDate":
			return `Span<${branded(type.span.endpoint, carrierHost(type.span.endpoint))}>`
		case "vector":
			return `Vector<${type.typmod.dims}>`
		case "tsvector":
			return `SearchDocument<${jsonText(type.configuration)}>`
		case "date":
			return "CalendarDate"
		case "variant":
		case "sha256":
		case "bytes":
		case "bits":
		case "inet":
		case "cidr":
			throw new Error(`no agreement schema declares a ${type.carrier} field`)
	}
}

/**
 * The host values of a refined text: the members of a finite language, as the engine's text analysis proves it
 * (text/refinement.ts languageOf, its minimal automaton acyclic), and every string for any other.
 */
const textHost = (regex: RegexRef): string => {
	const analyzed = analyzeText(regex.patterns, SourceLoc("heading", []))
	if (!analyzed.ok) {
		throw new Error(`the engine refuses patterns it admitted: ${patternsText(regex.patterns)}`)
	}
	const { known } = analyzed.value
	if (known.kind === "structure") {
		return "string"
	}
	const dfa = known.dfa
	if (longest(dfa) === undefined) {
		return "string"
	}
	const members = membersWithin(dfa, 1, memberWeight)
	if (members === undefined || !Arr.isReadonlyArrayNonEmpty(members)) {
		throw new Error(
			`no agreement schema declares a finite text of so many members: ${patternsText(regex.patterns)}`
		)
	}
	return handles(members)
}

/** The weight a finite text's members are listed within: each member's bytes and one more, far above any declared. */
const memberWeight = 4096

/**
 * A host type under its contract's key, where the type is a contract's, `Marked<host, <name>Key>`, each contract a
 * program reads stating its key's type under its name (test/support/agreement/schema.ts CentsKey, test/support/ids.ts
 * IdKey): natural's, a count's among them, is the bigint it is, and no other contract takes its name.
 */
const branded = (type: ScalarType, host: string): string => {
	const { contract } = type
	return contract === undefined || contract.name === "natural"
		? host
		: `Marked<${host}, ${contract.name}Key>`
}

/**
 * A host type under its contract's name, where the type is a contract's, the identity its domain carries
 * (types/fields/field.ts Contract): natural's is the bigint it is.
 */
const named = (type: ScalarType, host: string): string => {
	const { contract } = type
	return contract === undefined || contract.name === "natural"
		? host
		: `${host} & Brand.Brand<${jsonText(contract.name)}>`
}

/** The host type of a column the engine types `type` and decodes by `column`. */
const columnHost = (type: ScalarType, column: Column<unknown>): string => {
	switch (column.kind) {
		case "constant":
			return handles(column.values)
		case "code":
			return branded(type, handles(column.handles))
		case "variant":
		case "convert":
		case "text":
		case "bits":
		case "bytes":
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
	for (let c = type.contract; c !== undefined; c = c.base.contract) {
		for (const f of c.facts) {
			facts.add(f)
		}
	}
	return Arr.sort([...facts], Str.Order)
}

/**
 * A type's identity as the types state it, a domain: its host under its contract's name, with one Declares per fact its
 * contracts declare (types/fields/field.ts Contract).
 */
const domainOf = (type: ScalarType, host: string): string =>
	Arr.join(
		[named(type, host), ...Arr.map(declaredFacts(type), (f) => `Declares<${jsonText(f)}>`)],
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
	const domain = paramDomain(p.type)
	return p.type.carrier === "code"
		? `ParamType<${named(p.type, carrierHost(p.type))} & Rostered<${jsonText(defined(rosterOf(p.type), "a closed id's roster").closed)}>, ${sql}, ${host}>`
		: domain === host
			? `ParamType<${host}, ${sql}>`
			: `ParamType<${domain}, ${sql}, ${host}>`
}

/**
 * A parameter's domain: its descriptor's (domainOf), a contract's brand and declared facts with it, but a span's, which
 * is the span of its endpoint's domain, the endpoint contract's declared facts with it. The carrier is the plain type's
 * at the contract's last level (baseOf), which holds the span; the domain is the descriptor's own.
 */
const paramDomain = (descriptor: ScalarType): string => {
	const type = baseOf(descriptor)
	switch (type.carrier) {
		case "range4":
		case "range8":
		case "rangeDate":
			return `Span<${domainOf(type.span.endpoint, carrierHost(type.span.endpoint))}>`
		case "variant":
		case "int2":
		case "int4":
		case "int8":
		case "numeric":
		case "float4":
		case "float8":
		case "money":
		case "bool":
		case "uuid":
		case "date":
		case "inet":
		case "cidr":
		case "bytes":
		case "sha256":
		case "text":
		case "code":
		case "bits":
		case "vector":
		case "tsvector":
		case "exactInteger":
		case "exactMoney":
			return domainOf(descriptor, carrierHost(descriptor))
	}
}

/** A query's parameter map as the types state it: unknown where it takes none. */
export const paramsType = (params: ReadonlyArray<ParamDecl>): string =>
	Arr.isReadonlyArrayNonEmpty(params)
		? recordType(Arr.map(params, (p) => [p.name, paramEntry(p)] as const))
		: "unknown"
