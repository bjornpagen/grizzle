import { Array as Arr, Record as Rec, String as Str } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import { isSpan } from "#test/support/laws/model.ts"
import { relationSpecOf } from "#test/support/worlds/model/session/state.ts"
import type {
	BaseSpec,
	FieldDomain,
	HostFact,
	InstalledNames,
	SqlState,
	HostValue
} from "#test/support/worlds/model/types.ts"

import { regex } from "arkregex"
/**
 * A domain PostgreSQL installs as a DOMAIN whose CHECK is a law of its own: a contract keeps its integers in
 * [min, max], a refined text its pattern.
 */
export type LawDomain = Extract<FieldDomain, { readonly kind: "contract" | "text" }>

/**
 * The key `InstalledNames.domains` holds a law domain's CHECK law under, as the base declares the domain: a contract's
 * name, a refined text's regex literal `/pattern/flags`. A contract's name is an identifier, so no contract's key
 * begins with the slash every text's does.
 */
export const domainLawKey = (domain: LawDomain): string =>
	domain.kind === "contract" ? domain.name : `/${domain.pattern}/${domain.flags}`

/**
 * A fault of a value's base type: a value of another type altogether, an integer or a span past its type's range, a
 * handle outside its roster, or a text PostgreSQL cannot hold. grizzle's encoder refuses it before any SQL, and
 * PostgreSQL's input function as it reads a direct writer's literal.
 */
export type EncodingFault = "type" | "range" | "roster" | "unholdable"

/**
 * Why a value is not one of its field's domain: a fault of its base type, or a value of the base type that its law
 * domain's CHECK refuses, an integer past its contract's bounds or a text past its pattern. grizzle's encoder checks
 * the base type alone and admits such a value; the domain's CHECK refuses it as a statement casts it.
 */
type DomainFault =
	| { readonly kind: "encoding"; readonly fault: EncodingFault }
	| { readonly kind: "check"; readonly domain: LawDomain }

const typeFault: DomainFault = { kind: "encoding", fault: "type" }
const rangeFault: DomainFault = { kind: "encoding", fault: "range" }
const rosterFault: DomainFault = { kind: "encoding", fault: "roster" }
const unholdableFault: DomainFault = { kind: "encoding", fault: "unholdable" }

/** Whether a number is an integer of `bits` bits: every safe integer is a 64-bit one. */
const fits = (value: number, bits: 16 | 32 | 64): boolean =>
	Number.isSafeInteger(value) &&
	(bits === 64 || (value >= -(2 ** (bits - 1)) && value < 2 ** (bits - 1)))

const uuidPattern = regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "i")

/** What a field's domain makes of a value: undefined when it admits it. */
const domainFault = (domain: FieldDomain, value: HostValue): DomainFault | undefined => {
	switch (domain.kind) {
		case "uuid":
			return typeof value === "string" && uuidPattern.test(value) ? undefined : typeFault
		case "text":
			if (typeof value !== "string") {
				return typeFault
			}
			if (!value.isWellFormed() || Str.includes("\u0000")(value)) {
				return unholdableFault
			}
			return domain.matcher.test(value) ? undefined : { kind: "check", domain }
		case "integer":
		case "serial":
			if (typeof value !== "number") {
				return typeFault
			}
			return fits(value, domain.bits) ? undefined : rangeFault
		case "contract":
			if (typeof value !== "number") {
				return typeFault
			}
			if (!fits(value, domain.bits)) {
				return rangeFault
			}
			return value >= domain.min && value <= domain.max ? undefined : { kind: "check", domain }
		case "boolean":
			return typeof value === "boolean" ? undefined : typeFault
		case "handle":
			return typeof value === "string" && domain.members.includes(value) ? undefined : rosterFault
		case "span":
			if (!isSpan(value)) {
				return typeFault
			}
			return fits(value.start, domain.bits) &&
				fits(value.end, domain.bits) &&
				value.start < value.end
				? undefined
				: rangeFault
	}
}

/**
 * Whether a value is of its domain's JavaScript type, as a query builder takes a literal of the field's type: a string
 * for a uuid, a text or a handle; a number for an integer, a serial or a contract; a boolean; a span.
 */
export const ofDomainType = (domain: FieldDomain, value: HostValue): boolean => {
	switch (domain.kind) {
		case "uuid":
		case "text":
		case "handle":
			return typeof value === "string"
		case "integer":
		case "serial":
		case "contract":
			return typeof value === "number"
		case "boolean":
			return typeof value === "boolean"
		case "span":
			return isSpan(value)
	}
}

/**
 * One value a statement writes, at a field of the relation it writes, of the field's domain; none where the statement
 * leaves the field out.
 */
export interface Cell {
	readonly field: string
	readonly domain: FieldDomain
	readonly value: HostValue | undefined
}

/** A field whose value its law domain's CHECK refuses, with that domain. */
export interface CheckedField {
	readonly field: string
	readonly domain: LawDomain
}

/**
 * What the values a statement writes meet: a fault of a base type first, which the encoder (a Db) or the literal's
 * input function (a direct writer) meets before the statement runs; else the fields whose law domain's CHECK refuses a
 * value, each once, all met as the statement casts its values, in an order the model leaves open. PostgreSQL names the
 * domain alone; a Db names a pattern's refusal by the field.
 */
export type RowFault =
	| { readonly kind: "encoding"; readonly fault: EncodingFault }
	| { readonly kind: "checks"; readonly fields: Arr.NonEmptyReadonlyArray<CheckedField> }

/**
 * The fault of the cells a statement writes; a cell the statement leaves out is a value of no type unless its field is
 * serial, which the identity default draws.
 */
export const rowFault = (cells: ReadonlyArray<Cell>): RowFault | undefined => {
	const checks = new Map<string, CheckedField>()
	for (const cell of cells) {
		const fault =
			cell.value === undefined
				? cell.domain.kind === "serial"
					? undefined
					: typeFault
				: domainFault(cell.domain, cell.value)
		if (fault?.kind === "encoding") {
			return fault
		}
		if (fault !== undefined) {
			checks.set(cell.field, { field: cell.field, domain: fault.domain })
		}
	}
	const [first, ...rest] = checks.values()
	return first === undefined ? undefined : { kind: "checks", fields: [first, ...rest] }
}

/** The cells of a fact written into a relation, at the fields it carries, in the relation's field order. */
export const factCells = (
	base: BaseSpec,
	relation: string,
	fact: HostFact,
	carried: ReadonlyArray<string>
): ReadonlyArray<Cell> =>
	Arr.flatMap(relationSpecOf(base, relation)?.fields ?? [], (field) =>
		carried.includes(field.name)
			? [{ field: field.name, domain: field.domain, value: fact[field.name] }]
			: []
	)

/** Whether a field's domain is a law domain: a contract or a refined text. */
export const lawDomainOf = (domain: FieldDomain): LawDomain | undefined =>
	domain.kind === "contract" || domain.kind === "text" ? domain : undefined

/** The law domains of a base's relation fields, each once. */
export const lawDomainsOf = (base: BaseSpec): ReadonlyArray<LawDomain> => [
	...new Map(
		Arr.flatMap(base.relations, (r) =>
			Arr.flatMap(r.fields, (f) => {
				const domain = lawDomainOf(f.domain)
				return domain === undefined ? [] : [[domainLawKey(domain), domain] as const]
			})
		)
	).values()
]

/**
 * The law a law domain's CHECK reports where PostgreSQL alone names it, to a direct writer or reader, by the domain and
 * never the column: the law the installation's constraint map gives the DOMAIN's CHECK. Every contract has one; a
 * refined text has one where the installation installs a DOMAIN for it that types a stored field, and none for a
 * pattern that admits every text or one only a context field carries.
 */
export const installedCheck = (names: InstalledNames, domain: LawDomain): LawId | undefined => {
	const key = domainLawKey(domain)
	return Rec.has(names.domains, key) ? names.domains[key] : undefined
}

/** The CHECK law of a law domain a value breaks: a domain that refuses a value has a CHECK, so the installation names it. */
export const checkLaw = (names: InstalledNames, domain: LawDomain): LawId => {
	const law = installedCheck(names, domain)
	if (law === undefined) {
		throw new Error(
			`the installation names no CHECK law of the domain ${domainLawKey(domain)}, which refuses a value`
		)
	}
	return law
}

/**
 * The law a Db's refusal names for a field of `relation` whose law domain's CHECK refuses its value: a contract's law,
 * or the field's own pattern law, which the host decides by the column, never another field the pattern's domain types.
 */
export const fieldLaw = (names: InstalledNames, relation: string, checked: CheckedField): LawId => {
	if (checked.domain.kind === "contract") {
		return checkLaw(names, checked.domain)
	}
	const law = names.patterns[relation]?.[checked.field]
	if (law === undefined) {
		throw new Error(
			`the installation names no pattern law of ${relation}.${checked.field}, whose domain refuses a value`
		)
	}
	return law
}

/**
 * The SQLSTATE PostgreSQL meets a base type's fault with as it reads a direct writer's literal: a handle outside its
 * roster or a malformed value is invalid text for its type (22P02), an integer past its type out of range (22003), and
 * a text PostgreSQL cannot hold an encoding error.
 */
export const encodingState = (fault: EncodingFault): SqlState => {
	switch (fault) {
		case "roster":
		case "type":
			return "22P02"
		case "range":
			return "22003"
		case "unholdable":
			return "other"
	}
}
