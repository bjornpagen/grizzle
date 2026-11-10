import { pipelinedOverSearch } from "#compiler/check/approximate/attach.ts"
import { Checker, type CheckOptions, type RootRole } from "#compiler/check/checker.ts"
import { validateQueryStructure } from "#compiler/check/description.ts"
import { fail, rootLoc, unwrap } from "#compiler/check/fail.ts"
import { checkMemberHeading } from "#compiler/check/member.ts"
import { resolveQuery } from "#compiler/check/params.ts"
import type { MemberRelation, SchemaReading } from "#compiler/check/schema.ts"
import { nominal } from "#compiler/core/brand.ts"
import { catchRefusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { MemberDesc, QueryDesc, ReadBackDesc } from "#compiler/ir/desc.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { admittedReads } from "#compiler/scalar/compute/lower.ts"
import { queryPatternReads } from "#compiler/schema/walk.ts"

export type { CheckOptions } from "#compiler/check/checker.ts"

declare const admittedQueryBrand: unique symbol

/**
 * A query whose whole holds the checker's admission rule (check/approximate/attach.ts pipelinedOverSearch): no
 * attachment that must be a statement of its own attaches to a statement whose rows read an approximate search. The
 * optimized lowering takes only this (lower/optimize/pipeline.ts lowerOptimized), so its rows statements fuse every
 * attachment exactly when their rows read a search, and no pipelined attachment's statement runs a search again. `admit` is its one parse, which every entry point of the checker runs and
 * admitQuery offers a query the checker did not hand over; a restatement that spreads an admitted query with a new
 * DAG keeps it.
 */
export type AdmittedQuery = LogicalQuery & { readonly [admittedQueryBrand]: true }

const admitted = nominal<LogicalQuery, AdmittedQuery>()

/** `query`, admitted, or refused at `loc` as UnsupportedOperation. */
const admit = (query: LogicalQuery, loc: SourceLoc): AdmittedQuery => {
	const overSearch = pipelinedOverSearch(query.dag.roots[0])
	if (overSearch !== undefined) {
		fail("UnsupportedOperation", loc, overSearch)
	}
	return admitted(query)
}

/**
 * The admission of a query the checker did not hand over itself, such as a read-back's root restated as a query of
 * its write's DAG (write/readback/lower.ts), refused at `loc` where the rule fails.
 */
export const admitQuery = (
	query: LogicalQuery,
	loc: SourceLoc
): Result.Result<AdmittedQuery, CompileError> => catchRefusal(() => admit(query, loc))

/**
 * One check of a decoded description: every parameter is of its declared type, so one pass types them all. The
 * admission rule is a property of the whole query, refused here so that both lowerings accept the same programs. The
 * query is its own lowering batch: the text payload fields its Compute.matches patterns read, through every rule,
 * import, negation and attachment (schema/walk.ts queryPatternReads), are admitted once for it (scalar/compute/lower.ts
 * admittedReads).
 */
const run = (
	schema: SchemaReading,
	desc: QueryDesc,
	options: CheckOptions,
	loc: SourceLoc,
	role: RootRole
): AdmittedQuery => {
	const resolved = resolveQuery(desc)
	const closed = admittedReads(schema.closedReads, queryPatternReads([desc]))
	const dag = new Checker(schema, options, resolved.params, closed).root(resolved.query, loc, role)
	return admit({ dag, params: resolved.params.decls(loc) }, loc)
}

/**
 * The checker's entry points: scope and type checking, with resolved variables, imports and overloads, exact headings and no nullable expressions.
 *
 * - checkQuery: a query description against a schema to its LogicalQuery: the scoped relational and scalar
 *   DAG with exact headings, binding semantics, parameter declarations and non-null proofs, valid by construction (the
 *   IR's DagBuilder).
 * - checkMember: a ChangeSet member described by a query, checked as a query whose head is written into the member's
 *   relation (DescribedHeadingMismatch).
 * - checkReadBack: a read-back query, which may read the delta sources of every ordinary relation; the ChangeSet's
 *   written relations supply theirs, and every other relation's is empty.
 * - checkDefinition: a derived relation's or a role's query entry's definition, a relation whose rows are a set.
 *
 * The plug-in directories recursion/, approximate/ and refinement/ are dispatched from checker.ts at fixed paths
 * (context.ts). Every entry point returns a Result and never throws.
 *
 * A query description against a schema, as the checker reads it: a QueryDesc, decoded where it entered (ir/desc.ts
 * decodeDesc), so only its structure is validated here (check/description.ts), never its shape again.
 */
export const checkQuery = (
	checked: SchemaReading,
	desc: QueryDesc,
	options: CheckOptions
): Result.Result<AdmittedQuery, CompileError> =>
	Result.flatMap(validateQueryStructure(desc, { read: options.read }), (q) =>
		catchRefusal(() => run(checked, q, options, rootLoc(options.label), { kind: options.read }))
	)

/**
 * A definition, a derived relation's or a role's query entry's, checked over its base's checked schema as every query
 * is, read as rows, under `label`. A definition is a relation, so its rows are a set: a take it ends in bounds them and
 * orders nothing (checker.ts rootOrder). A role's view evaluates its definition's expressions on facts outside the
 * world too, which raises nothing, since every operation is total (scalar/compute/registry.ts Totality).
 */
export const checkDefinition = (
	base: SchemaReading,
	label: string,
	query: QueryDesc
): Result.Result<AdmittedQuery, CompileError> => {
	const options: CheckOptions = { read: "rows", label }
	return Result.flatMap(validateQueryStructure(query, { read: "rows" }), (q) =>
		catchRefusal(() => run(base, q, options, rootLoc(label), { kind: "definition" }))
	)
}

/** A read-back of a ChangeSet. */
export const checkReadBack = (
	checked: SchemaReading,
	readBack: ReadBackDesc,
	options: Omit<CheckOptions, "read">
): Result.Result<AdmittedQuery, CompileError> =>
	checkQuery(checked, readBack.query, { ...options, read: "readBack" })

/**
 * A ChangeSet member described by a query, with the relation it writes, which its writer resolved by the member's name
 * (write/frontend/compile.ts): an ordinary relation, or a role's writable query entry; a closed or derived relation,
 * which no ChangeSet writes, is refused there.
 */
export interface DescribedMember {
	readonly op: MemberDesc["op"]
	readonly relation: MemberRelation
	readonly query: QueryDesc
	readonly loc: SourceLoc
}

/** A member's LogicalQuery over its structurally valid query `q`, its head checked against the relation. */
const memberQuery = (
	checked: SchemaReading,
	member: DescribedMember,
	q: QueryDesc,
	options: Omit<CheckOptions, "read">
): AdmittedQuery => {
	const { relation, op, loc } = member
	const query = run(checked, q, { ...options, read: "rows" }, childLoc(loc, "query"), {
		kind: "member",
		target: { relation, op }
	})
	checkMemberHeading(query, relation, op, loc)
	return query
}

/** A described member's LogicalQuery, with its head checked against the relation (DescribedHeadingMismatch). */
export const checkMember = (
	checked: SchemaReading,
	member: DescribedMember,
	options: Omit<CheckOptions, "read">
): Result.Result<AdmittedQuery, CompileError> =>
	catchRefusal(() =>
		memberQuery(
			checked,
			member,
			unwrap(validateQueryStructure(member.query, { read: "rows" })),
			options
		)
	)

/**
 * A query entry's fill (write/frontend/entry.ts fillQuery), checked as a member of the entry's target: the front end
 * builds it from the role's checked entry, so it is no Description to decode, and its relation parameter is the unit
 * relation, of no field, where every head field it carries writes a serial field, which no author declares.
 */
export const checkFill = (
	checked: SchemaReading,
	member: DescribedMember,
	options: Omit<CheckOptions, "read">
): Result.Result<AdmittedQuery, CompileError> =>
	catchRefusal(() =>
		memberQuery(
			checked,
			member,
			unwrap(validateQueryStructure(member.query, { read: "rows" })),
			options
		)
	)
