import type { RowDecoder } from "#compiler/core/decoder.ts"
import { defect } from "#compiler/core/invariant.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { ownedEntry } from "#compiler/schema/protocol.ts"
import { admittedClosedId, type NamedRelation, namedRelation } from "#compiler/schema/relation.ts"
import { candidateKeyOf, statementDescOf } from "#compiler/schema/statements.ts"

/** A relation or closed relation a builder made, as namedRelation reads it, with its fact decoder. */
interface BuiltRelation {
	readonly value: object
	readonly named: Exclude<NamedRelation, { readonly kind: "derived" }>
	/** The relation's facts' decoder, which a keyed lookup's rows are read by. */
	readonly fact: RowDecoder<unknown>
}

/** What a key position names: the relation or closed relation it belongs to, and its key fields. */
export interface KeyPosition {
	/** The key position: the relation, the closed relation or the Key value. */
	readonly position: object
	readonly relation: BuiltRelation
	readonly fields: ReadonlyArray<string>
}

/** A keyed lookup: its query over the schema it was built over, and the key it reads through. */
export interface KeyLookup {
	readonly query: unknown
	readonly target: KeyPosition
}

/**
 * A built relation, roster or closed relation, read once; undefined for any other value. namedRelation reads an owned
 * relation, roster or closed relation through its own Description, so it neither refuses one nor names it derived.
 */
const builtRelation = (value: unknown): BuiltRelation | undefined => {
	const built =
		ownedEntry(value, "relation") ??
		ownedEntry(value, "closed") ??
		ownedEntry(value, "closedRelation")
	if (built === undefined) {
		return undefined
	}
	const named = namedRelation(built.value, "get")
	if (named.kind === "derived") {
		throw defect(
			`an owned relation, roster or closed relation ${named.name}, never a derived relation`
		)
	}
	return { value: built.value, named, fact: built.value.fact }
}

/**
 * The relation and key fields a key position names, or undefined for a value that names none: a built relation's
 * primary key, a built closed relation's ["id"], or a Key value's candidate key of a built relation, a key over its
 * whole relation's fields. A Key over a selection or a pred term names no key of its relation, so it is no position.
 */
const keyTarget = (value: unknown): KeyPosition | undefined => {
	if (statementDescOf(value) !== undefined) {
		const keyed = candidateKeyOf(value)
		const relation = keyed === undefined ? undefined : builtRelation(keyed.relation)
		return keyed === undefined || relation === undefined
			? undefined
			: { position: keyed.key, relation, fields: keyed.fields }
	}
	const relation = builtRelation(value)
	return relation === undefined
		? undefined
		: { position: relation.value, relation, fields: relation.named.primaryKey }
}

/** Whether `value` names a key a workload member reads by: a relation or closed relation a builder made, or a Key over one. */
export const isKeyPosition = (value: unknown): boolean => keyTarget(value) !== undefined

/**
 * The query of a keyed lookup over `schema`: every field of the relation, the key fields equal to their parameters. A
 * workload's key program, whose key position the workload admitted, reads through it over each role it runs on.
 */
export const keyQuery = (schema: object, target: KeyPosition): unknown => {
	const { value, named } = target.relation
	const descriptor = (field: string): unknown =>
		named.kind === "closed" && field === "id" ? admittedClosedId(value) : named.descriptors[field]
	return queryOver(schema).rule((r: RuleValue) => {
		/**
		 * The rule builder's methods are closures over its state, so they are read off it and called directly (the
		 * dependency audit, test/unit/deps, refuses a `.match(` call under src/ as a possible String.prototype.match).
		 */
		const { match, eq, param } = r
		const vars = varsOver(value, "value")
		const matched = match(value, vars)
		return target.fields
			.reduce((rule, f) => rule.where(eq(vars[f], param(f, descriptor(f)))), matched)
			.find(vars)
	})
}

/**
 * A keyed lookup: get over a key, and a workload's key program.
 *
 * `reader.get(R, values)` reads through R's primary key, `reader.get(byName, values)` through the candidate key that
 * key(...) declared, and a closed relation stands for its key ["id"]. A keyed lookup is an ordinary query, so it is
 * built as one with the public builder and read through the same pipeline as any other: every field of the relation
 * matched to a variable, each key field compared with a parameter of the field's own name and descriptor (a closed
 * relation's id a closedId over it), and the fact as the head. Its bindings cover a key, so its cardinality is at most
 * one per binding, and get returns an Option. The parameter of a key field compared against a refined field binds the
 * base type and matches nothing outside the refinement.
 *
 * Its rows are decoded by the keyed relation's own fact decoder, so a key position is a relation or closed relation a
 * builder made, or a Key over one: a JavaScript look-alike carries no decoder and names no key.
 *
 * The lookup over `schema`, a schema or role value, of the key position `value`; undefined for a value that names no
 * key.
 */
export const keyLookup = (schema: object, value: unknown): KeyLookup | undefined => {
	const target = keyTarget(value)
	return target === undefined ? undefined : { query: keyQuery(schema, target), target }
}
