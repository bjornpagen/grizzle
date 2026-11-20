/**
 * The descriptor each column of a query is delivered at, as the checker types it: what a bare literal standing for a
 * column takes, a rule's head term or a binding of the column, wherever a rule of the query is inlined into another and
 * a substitution may put the literal where a term stands (analysis/theory/leaves.ts atColumn).
 */
import { fieldDescOf } from "#compiler/analysis/derived/fields.ts"
import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import { refuse } from "#compiler/analysis/theory/build.ts"
import type { ColumnTypes } from "#compiler/analysis/theory/leaves.ts"
import { checkDefinition } from "#compiler/check/index.ts"
import { unwrap } from "#compiler/core/canonical.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import type { InferredQuery } from "#compiler/ir/desc.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"

/**
 * The descriptor each column of `query`, read as the definition of `relation` (a derived relation, or the query a
 * navigation imports), is delivered at: its heading as the checker types it against the checked schema, a bare head
 * literal's column by its value or by its position in a union, each column the inferred field's own descriptor
 * (analysis/derived/fields.ts fieldDescOf), a computed numeric's its bound, whatever its value, NaN, an infinity or one
 * past numeric(p, s)'s limits included. The query is checked at the first column read, and once.
 */
const definitionColumns = (
	checked: CheckedSchema,
	relation: string,
	query: InferredQuery,
	loc: SourceLoc
): ColumnTypes => {
	let heading: ReadonlyMap<string, ScalarType> | undefined
	return (column) => {
		heading ??= checkedHeading(checked, relation, query)
		const type = heading.get(column)
		if (type === undefined) {
			return refuse("MalformedDescription", loc, `a column ${column} of ${relation}'s definition`)
		}
		const desc = fieldDescOf(type, checked.owned.contracts)
		return desc.ok
			? desc.value
			: refuse("MalformedDescription", loc, `a declared type of ${relation}.${column}`)
	}
}

/** Each column of `query`'s heading and its type, as the checker types it as the definition of `relation`: one check. */
const checkedHeading = (
	checked: CheckedSchema,
	relation: string,
	query: InferredQuery
): ReadonlyMap<string, ScalarType> =>
	new Map(
		unwrap(checkDefinition(checked, `derived ${relation}`, query)).dag.roots[0].heading.map(
			(c) => [c.name, c.type] as const
		)
	)

/**
 * The columns of each query `checked` reads (definitionColumns), each query's checked once however often it is read: the
 * relation it is first read as names it, and locates its refusal.
 */
export const knownColumns = (
	checked: CheckedSchema
): ((relation: string, query: InferredQuery, loc: SourceLoc) => ColumnTypes) => {
	const known = new WeakMap<InferredQuery, ColumnTypes>()
	return (relation, query, loc) => {
		const found = known.get(query)
		if (found !== undefined) {
			return found
		}
		const columns = definitionColumns(checked, relation, query, loc)
		known.set(query, columns)
		return columns
	}
}

/** The columns of each query a navigation inlines (definitionColumns), read where it meets a bare literal. */
export type QueryColumns = (query: InferredQuery) => ColumnTypes

/**
 * The columns of each query `checked` reads (`knownColumns`), each query's checked once however often a navigation
 * meets it, an imported query named for the refusal that locates at `loc`.
 */
export const queryColumns = (checked: CheckedSchema, loc: SourceLoc): QueryColumns => {
	const known = knownColumns(checked)
	return (query) => known("an imported query", query, loc)
}
