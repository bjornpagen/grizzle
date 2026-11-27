import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import { refuse } from "#compiler/analysis/theory/build.ts"
import type { ColumnTypes } from "#compiler/analysis/theory/leaves.ts"
import { checkDefinition, checkQuery } from "#compiler/check/index.ts"
/**
 * The descriptor each column of a query is delivered at, as the checker types it: what a bare literal standing for a
 * column takes, a rule's head term or a binding of the column, wherever a rule of the query is inlined into another and
 * a substitution may put the literal where a term stands (analysis/theory/leaves.ts atColumn).
 */
import { CheckSession } from "#compiler/check/session.ts"
import { unwrap } from "#compiler/core/canonical.ts"
import type { IdentityDigest } from "#compiler/core/fingerprint.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { deepFreeze } from "#compiler/core/record.ts"
import { noClock } from "#compiler/ir/clock.ts"
import { descIdentity, type InferredQuery } from "#compiler/ir/desc.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { fieldDescOf, ownedContractsByName } from "#compiler/schema/field-desc.ts"

/**
 * The descriptor each column of `query`, read as the definition of `relation` (a derived relation, or the query a
 * navigation imports), is delivered at: its heading as the checker types it against the checked schema, a bare head
 * literal's column by its value or by its position in a union, each column the inferred field's own descriptor
 * (schema/field-desc.ts fieldDescOf), a computed numeric's its bound, whatever its value, NaN, an infinity or one
 * past numeric(p, s)'s limits included. The query is checked at the first column read, and once, in `session`, the
 * checks its reader's queries share.
 */
const definitionColumns = (
	checked: CheckedSchema,
	session: CheckSession,
	relation: string,
	query: InferredQuery,
	loc: SourceLoc
): ColumnTypes => {
	let heading: ReadonlyMap<string, ScalarType> | undefined
	return (column) => {
		heading ??= checkedHeading(checked, session, relation, query)
		const type = heading.get(column)
		if (type === undefined) {
			return refuse("MalformedDescription", loc, `a column ${column} of ${relation}'s definition`)
		}
		const desc = fieldDescOf(type, ownedContractsByName(checked.owned.contracts))
		return desc.ok
			? desc.value
			: refuse("MalformedDescription", loc, `a declared type of ${relation}.${column}`)
	}
}

/**
 * Each column of `query`'s heading and its type, as the checker types it as the definition of `relation`: one check, in
 * `session`.
 */
const checkedHeading = (
	checked: CheckedSchema,
	session: CheckSession,
	relation: string,
	query: InferredQuery
): ReadonlyMap<string, ScalarType> =>
	new Map(
		unwrap(
			checkDefinition(checked, `derived ${relation}`, query, session)
		).dag.roots[0].heading.map((c) => [c.name, c.type] as const)
	)

/**
 * The columns of each query `checked` reads (definitionColumns), each query's checked once however often it is read: the
 * relation it is first read as names it, and locates its refusal. Every check is one session's (check/session.ts
 * CheckSession), so an import the definitions share is resolved once, for its identity, where a session of each check's
 * own resolved the whole chain of imports below a definition again at each level of a chain of definitions.
 */
export const knownColumns = (
	checked: CheckedSchema
): ((relation: string, query: InferredQuery, loc: SourceLoc) => ColumnTypes) => {
	const known = new WeakMap<InferredQuery, ColumnTypes>()
	const session = new CheckSession(checked.patterns)
	return (relation, query, loc) => {
		const found = known.get(query)
		if (found !== undefined) {
			return found
		}
		const columns = definitionColumns(checked, session, relation, query, loc)
		known.set(query, columns)
		return columns
	}
}

/**
 * The columns of each source a navigation reads: an imported query's each by the descriptor the checker types it at,
 * which a bare literal standing for it takes (`desc`, definitionColumns); a relation's field by its type as the schema
 * declares it (`field`), a stored, closed or derived relation's, which navigation reads for its one fact
 * (ir/scalar.ts equalityIsIdentity, analysis/theory/navigate.ts sourceType).
 */
export interface QueryColumns {
	readonly desc: (query: InferredQuery) => ColumnTypes
	readonly type: (query: InferredQuery, column: string) => ScalarType | undefined
	readonly field: (relation: string, column: string) => ScalarType
}

/**
 * Each column of `query` and its type, as the checker types it read as a rule judge's region reads it (check/checker.ts
 * QueryRead `region`), which admits every source a reader of an import reads, a delta among them, so an import a
 * write's read-back or a judge reads is typed as its reader types it; undefined where the check refuses the query read
 * apart from every reader, a parameter only its reader's bind map binds among them. One check, in `session`.
 */
const typedHeading = (
	checked: CheckedSchema,
	session: CheckSession,
	query: InferredQuery
): ReadonlyMap<string, ScalarType> | undefined => {
	const result = checkQuery(checked, query, {
		read: "region",
		label: "an imported query navigation types",
		clock: noClock,
		session
	})
	return result.ok
		? new Map(result.value.dag.roots[0].heading.map((c) => [c.name, c.type] as const))
		: undefined
}

/**
 * The columns of each source `checked` reads (QueryColumns): each query's descriptors checked once however often a
 * navigation meets it (`knownColumns`), an imported query named for the refusal that locates at `loc`; each query's
 * types checked once for its identity (ir/desc.ts descIdentity, `typedHeading`), so two Descriptions of one query, a
 * walked copy and its definition, every reader's, are one check, and each relation's heading read once.
 */
export const queryColumns = (checked: CheckedSchema, loc: SourceLoc): QueryColumns => {
	const known = knownColumns(checked)
	const session = new CheckSession(checked.patterns)
	const typed = new Map<IdentityDigest, ReadonlyMap<string, ScalarType> | undefined>()
	const headings = new Map<string, ReadonlyMap<string, ScalarType>>()
	const headingOf = (relation: string): ReadonlyMap<string, ScalarType> => {
		const info = checked.relation(relation, loc)
		const heading =
			info.kind === "relation" || info.kind === "closed" ? info.heading : info.analysis.read.heading
		return new Map(heading.map((c) => [c.name, c.type] as const))
	}
	return {
		desc: (query) => known("an imported query", query, loc),
		type: (query, column) =>
			typed
				.getOrInsertComputed(unwrap(descIdentity(deepFreeze(query))), () =>
					typedHeading(checked, session, query)
				)
				?.get(column),
		field: (relation, column) =>
			headings.getOrInsertComputed(relation, headingOf).get(column) ??
			refuse("MalformedDescription", loc, `a field ${column} of ${relation}`)
	}
}

/**
 * `columns` read at the definition each query `definitionOf` reads it as: a walked copy of a query at the query it was
 * walked from (physical/ddl/rules.ts, analysis/theory/unit.ts WholeRule `definitionOf`).
 */
export const definedAt = (
	columns: QueryColumns,
	definitionOf: (query: InferredQuery) => InferredQuery
): QueryColumns => ({
	desc: (query) => columns.desc(definitionOf(query)),
	type: (query, column) => columns.type(definitionOf(query), column),
	field: columns.field
})
