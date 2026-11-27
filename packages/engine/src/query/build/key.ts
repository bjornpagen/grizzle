import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import type { RowDecoder } from "#compiler/core/decoder.ts"
import { type ExprDesc, exprFieldReads, type FieldDecl, mapExpr } from "#compiler/ir/desc.ts"
import type { OpenExpr } from "#compiler/ir/open.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { predicateValue, termExpr } from "#compiler/scalar/compute/term.ts"
import { ownedEntryOf } from "#compiler/schema/protocol.ts"
import { admittedClosedId, type NamedRelation, namedRelation } from "#compiler/schema/relation.ts"
import { candidateKeyOf, statementDescOf } from "#compiler/schema/statements.ts"

/** A relation or closed relation a builder made, as namedRelation reads it, with its fact decoder. */
interface BuiltRelation {
	readonly value: object
	readonly named: Exclude<NamedRelation, { readonly kind: "derived" }>
	/** The relation's facts' decoder, which a keyed lookup's rows are read by. */
	readonly fact: RowDecoder<unknown>
	/** Its fields' declarations, an ordinary relation's; none for a roster or a closed relation. */
	readonly decls: Readonly<Record<string, FieldDecl>>
}

/** A key generation of a key position (ir/law.ts FieldWriting keyGenerated): its field and its generation. */
interface KeyGeneration {
	readonly field: string
	readonly expr: ExprDesc
}

/**
 * What a key position names: the relation or closed relation it belongs to, the fields a lookup states its key by, and
 * the key generations among its key, each stated by the fields its generation reads (ir/law.ts keyHeads).
 */
export interface KeyPosition {
	/** The key position: the relation, the closed relation or the Key value. */
	readonly position: object
	readonly relation: BuiltRelation
	readonly fields: ReadonlyArray<string>
	readonly generations: ReadonlyArray<KeyGeneration>
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
	const built = ownedEntryOf(value)
	if (built?.kind !== "relation" && built?.kind !== "closed" && built?.kind !== "closedRelation") {
		return undefined
	}
	const named = namedRelation(built.value, "get")
	if (named.kind === "derived") {
		defect(`an owned relation, roster or closed relation ${named.name}, never a derived relation`)
	}
	return {
		value: built.value,
		named,
		fact: built.value.fact,
		decls: built.kind === "relation" ? built.desc.fields : {}
	}
}

/**
 * The key `key` of `relation` as a lookup states it, its key heads (ir/law.ts keyHeads): its fields but each key
 * generation, a generated field of the relation's primary key, then each generation's reads not already among them;
 * and the key generations, which the lookup compares with their generations over the reads' parameters, so PostgreSQL
 * reaches the row through the key's index.
 */
const keyHeadsOf = (
	relation: BuiltRelation,
	key: ReadonlyArray<string>
): Pick<KeyPosition, "fields" | "generations"> => {
	const generations = key.flatMap((field): ReadonlyArray<KeyGeneration> => {
		const writing = relation.decls[field]?.writing
		return writing?.kind === "generated" ? [{ field, expr: writing.expr }] : []
	})
	const written = key.filter((field) => !generations.some((g) => g.field === field))
	const reads = generations.flatMap((g) => exprFieldReads(g.expr))
	return { fields: [...new Set([...written, ...reads])], generations }
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
			: { position: keyed.key, relation, fields: keyed.fields, generations: [] }
	}
	const relation = builtRelation(value)
	return relation === undefined
		? undefined
		: { position: relation.value, relation, ...keyHeadsOf(relation, relation.named.primaryKey) }
}

/** Whether `value` names a key a workload member reads by: a relation or closed relation a builder made, or a Key over one. */
export const isKeyPosition = (value: unknown): boolean => keyTarget(value) !== undefined

/**
 * The query of a keyed lookup over `schema`, a schema or role value its builder parses (query.ts queryOver): every field
 * of the relation, the key's heads equal to their parameters and each key generation equal to its generation over them
 * (generationMet). A workload's key program, whose key position the workload admitted, reads through the one built
 * over its workload's schema (keyLookup) on each role it runs on.
 */
const keyQuery = (schema: unknown, target: KeyPosition): unknown => {
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
		const params = new Map(target.fields.map((f) => [f, param(f, descriptor(f))] as const))
		const stated = target.fields.reduce(
			(rule, f) => rule.where(eq(vars[f], params.get(f))),
			matched
		)
		return target.generations
			.reduce((rule, g) => rule.where(generationMet(termExpr(vars[g.field]), g, params)), stated)
			.find(vars)
	})
}

/**
 * The key generation `g`'s column equal to its generation over the parameters `params` its reads are stated by: the
 * generation's every field leaf the parameter of that field, so the lookup compares the stored column with the value
 * grizzle wrote there, which PostgreSQL meets in the key's index.
 *
 * This applies the generation its author DECLARED for this key, as a put or a delete of the relation does (main's
 * ruling, explicit cost): nothing is hidden, and nothing is hashed on grizzle's own. It is a key read's alone, a lookup
 * through a key (reader.get, a key member); a general query that states only the texts a key generation reads gets no
 * derived digest probe, its comparison a filter unless its author states the digest's equality.
 */
const generationMet = (
	column: OpenExpr | undefined,
	g: KeyGeneration,
	params: ReadonlyMap<string, unknown>
): unknown => {
	const read = (field: string): OpenExpr =>
		defined(termExpr(params.get(field)), `the parameter of ${field}, a field ${g.field} reads`)
	return predicateValue({
		kind: "compare",
		op: "eq",
		left: defined(column, `the variable of ${g.field}`),
		right: overParams(g.expr, read)
	})
}

/** A generation's expression with each field leaf the expression `read` gives it, every other node as it is. */
const overParams = (e: ExprDesc, read: (field: string) => OpenExpr): OpenExpr =>
	mapExpr(e, {
		leaf: (x) => {
			switch (x.kind) {
				case "field":
					return read(x.field)
				case "literal":
					return x
				case "var":
				case "value":
				case "parent":
				case "param":
					defect(`a generation reads its row's fields alone, never a ${x.kind}`)
			}
		},
		term: (x) => overParams(x, read),
		source: () => {
			defect("a generation reads no query")
		}
	})

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
export const keyLookup = (schema: unknown, value: unknown): KeyLookup | undefined => {
	const target = keyTarget(value)
	return target === undefined ? undefined : { query: keyQuery(schema, target), target }
}
