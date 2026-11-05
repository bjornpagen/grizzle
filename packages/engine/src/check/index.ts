import { pipelinedOverSearch } from "#compiler/check/approximate/attach.ts"
import { Checker, type CheckOptions, type RootRole } from "#compiler/check/checker.ts"
import { type StructureOptions, validateQueryStructure } from "#compiler/check/description.ts"
import { fail, rootLoc, unwrap } from "#compiler/check/fail.ts"
import { checkMemberHeading } from "#compiler/check/member.ts"
import { resolveQuery } from "#compiler/check/params.ts"
import type { MemberRelation, SchemaReading } from "#compiler/check/schema.ts"
import type { BudgetMeter } from "#compiler/core/budget.ts"
import { catchRefusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import {
	decodeDesc,
	type MemberDesc,
	type QueryDesc,
	type ReadBackDesc
} from "#compiler/ir/desc.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"

export type { CheckOptions } from "#compiler/check/checker.ts"

/**
 * One check of a decoded description, charged to the caller's meter: every parameter is of its declared type, so one
 * pass types them all.
 */
const run = (
	schema: SchemaReading,
	desc: QueryDesc,
	options: CheckOptions,
	loc: SourceLoc,
	role: RootRole
): LogicalQuery => {
	const resolved = resolveQuery(desc)
	const dag = new Checker(schema, options, resolved.params).root(resolved.query, loc, role)
	const query: LogicalQuery = { dag, params: resolved.params.decls(loc) }
	/** A property of the whole query, refused here so that both lowerings accept the same programs. */
	const overSearch = pipelinedOverSearch(query.dag.roots[0])
	if (overSearch !== undefined) {
		fail("UnsupportedOperation", loc, overSearch)
	}
	return query
}

const decoded = (desc: unknown, options: StructureOptions) =>
	Result.flatMap(decodeDesc("query", desc), (q) => validateQueryStructure(q, options))

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
 *
 * The plug-in directories recursion/, approximate/ and refinement/ are dispatched from checker.ts at fixed paths
 * (context.ts). Every entry point returns a Result and never throws.
 *
 * A query description against a schema, as the checker reads it.
 */
export const checkQuery = (
	checked: SchemaReading,
	desc: unknown,
	options: CheckOptions
): Result.Result<LogicalQuery, CompileError> =>
	Result.flatMap(decoded(desc, { read: options.read }), (q) =>
		catchRefusal(() => run(checked, q, options, rootLoc(options.label), { kind: options.read }))
	)

/**
 * A role's query entry: its definition checked over its base's checked schema, as every query is. Its role's view
 * evaluates the definition's expressions on facts outside the world too, which raises nothing, since every operation is
 * total (scalar/compute/registry.ts Totality).
 */
export const checkWorldDefinition = (
	base: SchemaReading,
	entry: { readonly name: string; readonly query: QueryDesc },
	meter: BudgetMeter
): Result.Result<LogicalQuery, CompileError> => {
	const options: CheckOptions = { read: "rows", label: `world ${entry.name}`, meter }
	return Result.flatMap(decoded(entry.query, { read: "rows" }), (q) =>
		catchRefusal(() => run(base, q, options, rootLoc(options.label), { kind: "rows" }))
	)
}

/** A read-back of a ChangeSet. */
export const checkReadBack = (
	checked: SchemaReading,
	readBack: ReadBackDesc,
	options: Omit<CheckOptions, "read">
): Result.Result<LogicalQuery, CompileError> =>
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
): LogicalQuery => {
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
): Result.Result<LogicalQuery, CompileError> =>
	catchRefusal(() =>
		memberQuery(checked, member, unwrap(decoded(member.query, { read: "rows" })), options)
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
): Result.Result<LogicalQuery, CompileError> =>
	catchRefusal(() =>
		memberQuery(
			checked,
			member,
			unwrap(validateQueryStructure(member.query, { read: "rows" })),
			options
		)
	)
