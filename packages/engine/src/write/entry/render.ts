import type { CheckedEntry, CheckedSchema } from "#compiler/analysis/schema.ts"
import { checkQuery } from "#compiler/check/index.ts"
import { BudgetMeter } from "#compiler/core/budget.ts"
import { CompileError, prose } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { compileBudgets } from "#compiler/core/policy.ts"
import * as Result from "#compiler/core/result.ts"
import type { EvidenceCatalog } from "#compiler/ir/evidence.ts"
import type { LawField } from "#compiler/ir/law.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import { queryEvidence } from "#compiler/logical/annotate.ts"
import { columnIn } from "#compiler/lower/conservative/context.ts"
import { lowerOptimized, optimizedInput } from "#compiler/lower/optimize/pipeline.ts"
import type { Expr, Select, SelectBody, SetOperand } from "#compiler/sql/ast.ts"
import { exists, lit, mapTargets } from "#compiler/sql/build.ts"

export interface MembershipOptions {
	/** The base the entry's role is over, checked: the filter query reads its relations. */
	readonly schema: CheckedSchema
	/** The physical names the filter's relations are read under: the base's installed names, since a policy's filter
	 * function and a precheck read reality, never the role's views. */
	readonly names: PhysicalNames
	/** The schema's installed keys and containments, named as ownership installs them (laws/model/catalog.ts
	 * evidenceCatalog): what the filter's lowering may rely on, of which the transaction context admits only what holds
	 * at every statement. */
	readonly catalog: EvidenceCatalog
	/** The value of each field of T the filter reads, at the row whose membership is asked: the field, and its position
	 * among the fields the filter reads (filterFields). */
	readonly row: (field: LawField, position: number) => Expr
}

/** The fields of T an entry's membership reads, in T's canonical field order: a filter function's parameters. */
export const filterFields = (entry: CheckedEntry): ReadonlyArray<LawField> =>
	entry.filter.kind === "none" ? [] : entry.filter.fields

/** Whether an entry's membership reads a stored relation besides T's row, so it runs as the owner, in the role's filter
 * function. */
export const filterReadsOther = (entry: CheckedEntry): boolean =>
	entry.filter.kind === "query" && entry.filter.readsOther

/** `body` with no output column named: an EXISTS answers no column, so the names of the query it wraps are unobservable. */
const unaliasedBody = (body: SelectBody): SelectBody => {
	switch (body.kind) {
		case "core":
		case "select":
			return unaliasedOperand(body)
		case "setOp": {
			const [first, second, ...rest] = body.arms
			return {
				...body,
				arms: [unaliasedOperand(first), unaliasedOperand(second), ...rest.map(unaliasedOperand)]
			}
		}
	}
}

const unaliasedOperand = (operand: SetOperand): SetOperand =>
	operand.kind === "core"
		? mapTargets(operand, (t) => ({ ...t, alias: undefined }))
		: unaliased(operand)

const unaliased = (query: Select): Select => ({ ...query, body: unaliasedBody(query.body) })

/** The membership of the row `options.row` names in `entry` (see `renderMembership`).
 *
 * A writable entry's membership as SQL: `fixed ∧ w` at one row of T.
 *
 * The filter query is checked against the base as a membership, which reads its row (schema/entry.ts), and lowered by
 * the optimized lowering in the `transaction` evidence context, as a role's world view is
 * (physical/derived/definition.ts lowerDefinition): its rewrites rest on descriptor, immediate and query-local evidence
 * only, so its meaning holds at every statement of a transaction, where a deferred law may be false for a moment, and a
 * policy and a write's precheck both run there. The row is exactly one fact, so every relation the filter joins to it
 * is read at the values the row fixes. The lowering's subject is the membership at the row the caller names: the row
 * lowers to the one-row VALUES of the caller's values, each cast to its column's base type and collated as a stored
 * column is (lower/conservative/input-set inputSetSource), so the statement holds no placeholder. Its placement
 * deduplicates only where a node observes repeats, so a stored relation the filter joins is a plain FROM item
 * PostgreSQL flattens into one join with the row, read at the values the row fixes, by an index on them, rather than
 * scanned and deduplicated whole on every call. The program is the small form of its one statement: every form delivers
 * the same rows, and the filter is asked of one row. The membership is EXISTS over it: true or false, never NULL, so
 * `NOT membership` refuses exactly the rows outside the entry. An entry whose filter is none holds every row: its
 * membership is TRUE.
 *
 * One rendering serves every reader: the role's policy on T over T's own columns, the role's filter function over its
 * arguments (when the filter reads another relation), and each write statement's precheck over the rows
 * it is about to write (frontend). */
export const renderMembership = (
	entry: CheckedEntry,
	options: MembershipOptions
): Result.Result<Expr, CompileError> => {
	const filter = entry.filter
	if (filter.kind === "none") {
		return Result.ok(lit.bool(true))
	}
	const meter = new BudgetMeter(compileBudgets)
	const query = checkQuery(options.schema, filter.query, {
		read: "membership",
		meter,
		label: `write ${entry.entry}`
	})
	if (!query.ok) {
		return query
	}
	const annotated = optimizedInput(query.value, queryEvidence)
	if (!annotated.ok) {
		return annotated
	}
	const read = new Map(
		filter.fields.map((field, position) => [field.name, { field, position }] as const)
	)
	const program = lowerOptimized(annotated.value, {
		names: options.names,
		subject: {
			kind: "membership",
			row: (name) => {
				const { field, position } = columnIn(read, name)
				return options.row(field, position)
			}
		},
		context: "transaction",
		catalog: options.catalog,
		meter
	})
	if (!program.ok) {
		return program
	}
	const loc = SourceLoc(`write ${entry.entry}`, ["filter"])
	const [root, ...rest] = program.value.roots
	const main = root.statement
	if (
		rest.length > 0 ||
		root.attachments.length > 0 ||
		main.role.kind !== "main" ||
		main.fused.length > 0 ||
		main.params.length > 0
	) {
		return Result.err(
			CompileError.make(
				prose(
					"UnsupportedOperation",
					loc,
					"a filter that lowers to one statement of no placeholder"
				)
			)
		)
	}
	return Result.ok(exists(unaliased(main.ast)))
}
