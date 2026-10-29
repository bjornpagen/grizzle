import { pipelinedOverSearch } from "#compiler/check/approximate/attach.ts"
import {
	Checker,
	type CheckOptions,
	type Operations,
	type RootRole
} from "#compiler/check/checker.ts"
import { type StructureOptions, validateQueryStructure } from "#compiler/check/description.ts"
import { fail, rootLoc, unwrap } from "#compiler/check/fail.ts"
import { checkMemberHeading } from "#compiler/check/member.ts"
import { resolveQuery } from "#compiler/check/params.ts"
import type { MemberRelation, SchemaReading } from "#compiler/check/schema.ts"
import { BudgetMeter } from "#compiler/core/budget.ts"
import { catchRefusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import { type Budgets, budgetKinds } from "#compiler/core/policy.ts"
import * as Result from "#compiler/core/result.ts"
import {
	decodeDesc,
	type MemberDesc,
	type QueryDesc,
	type ReadBackDesc
} from "#compiler/ir/desc.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"

export type { CheckOptions } from "#compiler/check/checker.ts"

/**
 * A private meter in the state of `meter`: the same limits and the same usage, so a probing pass is refused exactly
 * where the caller's meter would refuse it, while the caller's meter is charged only for the pass that is kept.
 *
 * An exhausted kind stays exhausted in the copy: the charge's refusal is the state being copied.
 */
const mirror = (meter: BudgetMeter, loc: SourceLoc): BudgetMeter => {
	const limits: Budgets = {
		nodes: meter.limit("nodes"),
		fields: meter.limit("fields"),
		sqlBytes: meter.limit("sqlBytes"),
		params: meter.limit("params"),
		variants: meter.limit("variants")
	}
	const copy = new BudgetMeter(limits)
	for (const kind of budgetKinds) {
		copy.charge(kind, meter.used(kind), loc)
	}
	return copy
}

/**
 * Charges `meter` with what `pass` consumed beyond the state it was mirrored from. A refusal here repeats the one the
 * pass already raised at its own location, which is the refusal reported.
 */
const commit = (meter: BudgetMeter, pass: BudgetMeter, loc: SourceLoc): void => {
	for (const kind of budgetKinds) {
		meter.charge(kind, pass.used(kind) - meter.used(kind), loc)
	}
}

/**
 * One check of a decoded description. A head parameter that no use had typed when its head was checked is typed by a
 * later use: the check runs again with the types the previous pass learned, until a pass leaves no head
 * parameter untyped. A pass that types no further pending parameter is final: its own refusal stands, and a pass that
 * completed with a head parameter still untyped refuses it. Only the kept pass is charged to the
 * caller's meter.
 */
const run = (
	schema: SchemaReading,
	desc: QueryDesc,
	options: CheckOptions,
	loc: SourceLoc,
	role: RootRole,
	operations: Operations
): LogicalQuery => {
	const meter = options.meter
	let seed: ReadonlyMap<string, ScalarType> = new Map()
	for (;;) {
		const passMeter = mirror(meter, loc)
		const resolved = resolveQuery(desc, seed)
		const pass = new Checker(schema, { ...options, meter: passMeter }, resolved.params, operations)
		/**
		 * A pass stands a placeholder in for an untyped head parameter, which can itself fail a later check (a union of
		 * arms typing the parameter differently): such a refusal is decided by a pass that knows it.
		 */
		const outcome = catchRefusal(() => pass.root(resolved.query, loc, role))
		const learned = resolved.params.scalarTypes()
		const pending = [...pass.pendingHeadParams]
		if (pending.some(([cell]) => learned.has(cell.name) && !seed.has(cell.name))) {
			seed = new Map([...seed, ...learned])
			continue
		}
		commit(meter, passMeter, loc)
		const dag = unwrap(outcome)
		for (const [cell, at] of pending) {
			fail(
				"MalformedDescription",
				at,
				`a type for parameter ${cell.name}: it appears only in a head, where it meets no term, and no comparison or member field types it`
			)
		}
		/** The pass is final, so every parameter the description names is typed. */
		const query: LogicalQuery = { dag, params: resolved.params.decls(loc) }
		/** A property of the whole query, refused here so that both lowerings accept the same programs. */
		const overSearch = pipelinedOverSearch(query.dag.roots[0])
		if (overSearch !== undefined) {
			fail("UnsupportedOperation", loc, overSearch)
		}
		return query
	}
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
		catchRefusal(() =>
			run(checked, q, options, rootLoc(options.label), { kind: options.read }, "any")
		)
	)

/**
 * A role's query entry: its definition checked over its base's checked schema, as a query of total operations only
 * (checker.ts Operations), so a refusal names the operation that can raise and where it stands.
 */
export const checkWorldDefinition = (
	base: SchemaReading,
	entry: { readonly name: string; readonly query: QueryDesc },
	meter: BudgetMeter
): Result.Result<LogicalQuery, CompileError> => {
	const options: CheckOptions = { read: "rows", label: `world ${entry.name}`, meter }
	return Result.flatMap(decoded(entry.query, { read: "rows" }), (q) =>
		catchRefusal(() => run(base, q, options, rootLoc(options.label), { kind: "rows" }, "total"))
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

/** A described member's LogicalQuery, with its head checked against the relation (DescribedHeadingMismatch). */
export const checkMember = (
	checked: SchemaReading,
	member: DescribedMember,
	options: Omit<CheckOptions, "read">
): Result.Result<LogicalQuery, CompileError> =>
	catchRefusal(() => {
		const { relation, op, loc } = member
		const q = unwrap(decoded(member.query, { read: "rows" }))
		const query = run(
			checked,
			q,
			{ ...options, read: "rows" },
			childLoc(loc, "query"),
			{ kind: "member", target: { relation, op } },
			"any"
		)
		checkMemberHeading(query, relation, op, loc)
		return query
	})
