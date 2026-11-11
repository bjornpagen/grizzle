import { array, boolean, element, type Gen } from "@grizzle/testing/gen"
import { Array as Arr } from "effect"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import {
	type AuthoredExprDesc,
	f,
	ge,
	literal,
	type QueryDesc,
	relation,
	type SchemaDesc,
	value
} from "#test/support/fixtures/ir/desc.ts"
import { qtyDesc } from "#test/unit/check/drawn.ts"
import {
	cast,
	match,
	queryDesc,
	ref,
	relationSource,
	rule,
	typedLit,
	vars
} from "#test/unit/check/dsl.ts"

/**
 * Contracts a query declares by casting a literal into them, beside a schema that declares Qty, a contract over integer
 * of the values at least 0, or none; and the identity rule restated as a model: one name, one descriptor, across the
 * query and its schema (DuplicateIdentity).
 */

/** The names a query's contracts take: the schema's own, and one only a query declares. */
const contractNames = ["Qty", "Fresh"] as const
export type ContractName = (typeof contractNames)[number]

/** A contract a query declares: its name, its base, and whether its predicate states its values are at least 0. */
export interface DeclaredContract {
	readonly name: ContractName
	readonly base: "int4" | "int8"
	readonly nonnegative: boolean
}

export interface ContractCase {
	/** Whether the schema declares Qty, by a field of it. */
	readonly schemaQty: boolean
	readonly declared: Arr.NonEmptyReadonlyArray<DeclaredContract>
}

/** The schema's Qty, as a query declares it. */
const schemaQty: DeclaredContract = { name: "Qty", base: "int4", nonnegative: true }

const same = (a: DeclaredContract, b: DeclaredContract): boolean =>
	a.name === b.name && a.base === b.base && a.nonnegative === b.nonnegative

/** The names declared with two descriptors, across the query and, where it declares Qty, the schema. */
export const conflicting = (c: ContractCase): ReadonlyArray<ContractName> => {
	const all = [...(c.schemaQty ? [schemaQty] : []), ...c.declared]
	return Arr.filter(contractNames, (name) => {
		const [first, ...rest] = Arr.filter(all, (d) => d.name === name)
		return first !== undefined && Arr.some(rest, (d) => !same(first, d))
	})
}

const baseDesc = (base: DeclaredContract["base"]): FieldDesc =>
	base === "int4" ? f.integer : f.bigint

/** The descriptor a declaration states. */
const descriptorOf = (d: DeclaredContract): FieldDesc => ({
	kind: "contract",
	name: d.name,
	base: baseDesc(d.base),
	predicate: d.nonnegative ? ge(value, literal(d.base === "int4" ? 0 : 0n)) : undefined,
	facts: []
})

/** The schema: R0 of an id and, where it declares Qty, a field of it. */
export const contractSchema = (c: ContractCase): SchemaDesc => ({
	name: "Contracts",
	relations: [relation("R0", c.schemaQty ? { id: f.uuid, n: qtyDesc } : { id: f.uuid }, ["id"])],
	statements: [],
	extends: undefined
})

/** The query: R0's ids, each row with one column per declaration, the literal 1 of its base cast into it. */
export const contractQuery = (c: ContractCase): QueryDesc => {
	const head: Record<string, AuthoredExprDesc> = { id: ref("R0", "id") }
	for (const [i, d] of c.declared.entries()) {
		head[`c${i}`] = cast(typedLit(d.base === "int4" ? 1 : 1n, baseDesc(d.base)), descriptorOf(d))
	}
	return queryDesc(
		rule({
			vars: vars("R0", "id"),
			matches: [match(relationSource("R0"), { id: ref("R0", "id") })],
			where: [],
			head,
			interiors: [],
			attach: []
		})
	)
}

const declaredGen: Gen<DeclaredContract> = (source) => ({
	name: source.draw(element(contractNames)),
	base: source.draw(element(["int4", "int8"] as const)),
	nonnegative: source.draw(boolean)
})

export const contractCaseGen: Gen<ContractCase> = (source) => ({
	schemaQty: source.draw(boolean),
	declared: [source.draw(declaredGen), ...source.draw(array(declaredGen, { min: 0, max: 2 }))]
})

/** What a case reached: a refusal or an admission, and whether the schema's own descriptor was declared again. */
export type ContractFeature =
	| "one name declared with two descriptors"
	| "the schema's contract declared otherwise"
	| "the schema's own descriptor declared again"
	| "one descriptor declared twice"
	| "admitted"

export const contractFeatures = (c: ContractCase): ReadonlyArray<ContractFeature> => {
	const clash = conflicting(c)
	const declaredAgain = c.schemaQty && Arr.some(c.declared, (d) => same(d, schemaQty))
	const otherwise =
		c.schemaQty && Arr.some(c.declared, (d) => d.name === "Qty" && !same(d, schemaQty))
	const twice = Arr.some(c.declared, (d, i) => Arr.some(c.declared.slice(i + 1), (e) => same(d, e)))
	return [
		...(clash.length > 0
			? ["one name declared with two descriptors" as const]
			: ["admitted" as const]),
		...(otherwise ? ["the schema's contract declared otherwise" as const] : []),
		...(declaredAgain && clash.length === 0
			? ["the schema's own descriptor declared again" as const]
			: []),
		...(twice && clash.length === 0 ? ["one descriptor declared twice" as const] : [])
	]
}
