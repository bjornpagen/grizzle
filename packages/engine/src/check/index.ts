import * as Result from "@bjornpagen/grizzle-text/base/result"
import { pipelinedOverSearch } from "#compiler/check/approximate/attach.ts"
import { Checker, type CheckOptions, type RootRole } from "#compiler/check/checker.ts"
import { validateQueryStructure } from "#compiler/check/description.ts"
import { fail, rootLoc } from "#compiler/check/fail.ts"
import { checkMemberHeading } from "#compiler/check/member.ts"
import { resolveQuery } from "#compiler/check/params.ts"
import type { MemberRelation, SchemaReading } from "#compiler/check/schema.ts"
import type { CheckSession } from "#compiler/check/session.ts"
import { nominal } from "#compiler/core/brand.ts"
import { catchRefusal, unwrap } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import { noClock } from "#compiler/ir/clock.ts"
import type { InferredQuery, ReadBackDesc, WriteOp } from "#compiler/ir/desc.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"

export type { CheckOptions } from "#compiler/check/checker.ts"
export { CheckSession } from "#compiler/check/session.ts"

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
 * admission rule is a property of the whole query, refused here so that both lowerings accept the same programs. A
 * rule's filter applies the schema's closed relations as the schema reads them (SchemaReading closedReads).
 */
const run = (
	schema: SchemaReading,
	desc: InferredQuery,
	options: CheckOptions,
	loc: SourceLoc,
	role: RootRole
): AdmittedQuery => {
	const resolved = resolveQuery(desc, options.session)
	const dag = new Checker(schema, options, resolved.params).root(resolved.query, loc, role)
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
 * decodeDesc), or one grizzle writes itself, whose typed literals may state an inferred field's descriptor (ir/desc.ts
 * Inferred), so only its structure is validated here (check/description.ts), never its shape again.
 */
export const checkQuery = (
	checked: SchemaReading,
	desc: InferredQuery,
	options: CheckOptions
): Result.Result<AdmittedQuery, CompileError> =>
	Result.flatMap(
		validateQueryStructure(desc, { read: options.read, session: options.session }),
		(q) =>
			catchRefusal(() => run(checked, q, options, rootLoc(options.label), { kind: options.read }))
	)

/**
 * A query whose rows are a relation the database itself reads, a set no caller reads in an order (checker.ts RootRole
 * `relation`), checked over `checked` as every query is, read as rows: a take it ends in bounds them and orders nothing
 * (checker.ts rootOrder). A rule's violation, which its judge reads (analysis/theory/theory.ts ruleViolation), and a
 * relation parameter a ChangeSet binds to a query (write/frontend/compile.ts), each under its own label and clock.
 */
export const checkRelation = (
	checked: SchemaReading,
	query: InferredQuery,
	options: Omit<CheckOptions, "read">
): Result.Result<AdmittedQuery, CompileError> =>
	Result.flatMap(validateQueryStructure(query, { read: "rows", session: options.session }), (q) =>
		catchRefusal(() =>
			run(checked, q, { ...options, read: "rows" }, rootLoc(options.label), { kind: "relation" })
		)
	)

/**
 * A definition, a derived relation's or a role's query entry's, checked over its base's checked schema as a relation
 * (checkRelation) under `label`, reading no clock. A role's view evaluates its definition's expressions on facts
 * outside the world too, which raises nothing, since every operation is total (scalar/compute/registry.ts Totality).
 */
export const checkDefinition = (
	base: SchemaReading,
	label: string,
	query: InferredQuery,
	session: CheckSession
): Result.Result<AdmittedQuery, CompileError> =>
	checkRelation(base, query, { label, clock: noClock, session })

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
	readonly op: WriteOp
	readonly relation: MemberRelation
	readonly query: InferredQuery
	readonly loc: SourceLoc
}

/** A member's LogicalQuery over its structurally valid query `q`, its head checked against the relation. */
const memberQuery = (
	checked: SchemaReading,
	member: DescribedMember,
	q: InferredQuery,
	options: Omit<CheckOptions, "read">
): AdmittedQuery => {
	const { relation, op, loc } = member
	const query = run(checked, q, { ...options, read: "rows" }, childLoc(loc, "query"), {
		kind: "member",
		target: { relation, op }
	})
	checkMemberHeading(query, relation, loc)
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
			unwrap(validateQueryStructure(member.query, { read: "rows", session: options.session })),
			options
		)
	)

/**
 * A query entry's fill (write/frontend/entry.ts fillQuery), checked as a member of the entry's target: the front end
 * builds it from the role's checked entry, so it is no Description to decode, and its relation parameter is the unit
 * relation, of no field, for an entry of no head field, which no author declares.
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
			unwrap(validateQueryStructure(member.query, { read: "rows", session: options.session })),
			options
		)
	)
