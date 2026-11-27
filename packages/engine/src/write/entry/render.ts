import { appendNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { CheckedEntry, CheckedSchema } from "#compiler/analysis/schema.ts"
import { checkQuery } from "#compiler/check/index.ts"
import { CheckSession } from "#compiler/check/session.ts"
import { CompileError, prose } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { noClock } from "#compiler/ir/clock.ts"
import { typedEq } from "#compiler/ir/compare.ts"
import { servedQuery } from "#compiler/ir/derived.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import type { EvidenceCatalog } from "#compiler/ir/evidence.ts"
import type { LawField } from "#compiler/ir/law.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { ValidDag } from "#compiler/ir/rel.ts"
import { queryEvidence } from "#compiler/logical/annotate.ts"
import {
	columnIn,
	carriesNothing,
	evaluatedAsItStands,
	LowerContext
} from "#compiler/lower/conservative/context.ts"
import { dispatchNode } from "#compiler/lower/conservative/dispatch.ts"
import { lowerComposed, optimizedInput } from "#compiler/lower/optimize/pipeline.ts"
import type { Expr, ObjectName, OperandBody, OperandSelect, SetOperand } from "#compiler/sql/ast.ts"
import {
	and,
	binary,
	col,
	exists,
	lit,
	mapTargets,
	not,
	simpleSelect,
	table,
	target,
	withArms
} from "#compiler/sql/build.ts"
import type { OutsideProbe } from "#compiler/write/insert/unique.ts"
import { withinRow } from "#compiler/write/probe.ts"

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
const unaliasedBody = (body: OperandBody): OperandBody => {
	switch (body.kind) {
		case "core":
		case "select":
			return unaliasedOperand(body)
		case "setOp": {
			const [first, second, ...rest] = body.arms
			return withArms(body, [
				unaliasedOperand(first),
				unaliasedOperand(second),
				...rest.map(unaliasedOperand)
			])
		}
	}
}

const unaliasedOperand = (operand: SetOperand): SetOperand =>
	operand.kind === "core"
		? mapTargets(operand, (t) => ({ ...t, alias: undefined }))
		: unaliased(operand)

const unaliased = (query: OperandSelect): OperandSelect => ({
	...query,
	body: unaliasedBody(query.body)
})

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
 * the same rows, and the filter is asked of one row. It is lowered composed (lower/optimize/pipeline.ts lowerComposed),
 * never printed apart: its row is the caller's, named by the statement that asks the membership, which alone binds it.
 * The membership is EXISTS over it: true or false, never NULL, so
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
	return filter.kind === "none"
		? Result.ok(lit.bool(true))
		: renderFilter(filter.query, filter.fields, `write ${entry.entry}`, options)
}

/**
 * A membership query over the row the caller names, `query`, reading the row's `fields`, as SQL at that row: EXISTS over
 * its lowering (see `renderMembership`), labelled `label` where it is refused. A writable entry's filter is one; a
 * member's claims filter is another (schema/scope.ts claimsFilter), which a claims-held write's precheck asks of each fact it
 * states.
 */
export const renderFilter = (
	filterQuery: QueryDesc,
	fields: ReadonlyArray<LawField>,
	label: string,
	options: MembershipOptions
): Result.Result<Expr, CompileError> => {
	const query = checkQuery(options.schema, filterQuery, {
		read: "membership",
		label,
		clock: noClock,
		session: CheckSession.own()
	})
	if (!query.ok) {
		return query
	}
	/** A membership is asked at a statement of a write, which may have written the holders of a stored derived relation
	 * its COMMIT's upkeep has yet to replace: every derived relation is read through its definition (ir/derived.ts). */
	const annotated = optimizedInput(
		servedQuery(query.value, options.schema.expanded()),
		queryEvidence
	)
	if (!annotated.ok) {
		return annotated
	}
	const read = new Map(fields.map((field, position) => [field.name, { field, position }] as const))
	const program = lowerComposed(annotated.value, {
		names: options.names,
		subject: {
			kind: "membership",
			row: (name) => {
				const { field, position } = columnIn(read, name)
				return options.row(field, position)
			}
		},
		context: "transaction",
		catalog: options.catalog
	})
	if (!program.ok) {
		return program
	}
	const loc = SourceLoc(label, ["filter"])
	const parts = program.value.parts
	if (
		parts.kind !== "one" ||
		parts.delivered.role.kind !== "main" ||
		parts.delivered.fused.length > 0 ||
		parts.delivered.params.length > 0
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
	return Result.ok(exists(unaliased(parts.delivered.ast)))
}

/**
 * What a writable entry's probes are rendered over (renderProbes): the membership's options but its row, the law model's
 * DAG, which holds a unique object's guards, T's table, and the column of each of T's fields there.
 */
export interface ProbeOptions extends Omit<MembershipOptions, "row"> {
	readonly dag: ValidDag
	readonly table: ObjectName
	readonly column: (field: LawField) => string
}

/** The alias a probe reads T's row under: r0, the input-row alias the write protocols use, since a lowering numbers its
 * own FROM items from r1, so no item inside the membership takes it. */
const probeRow = "r0"

/**
 * The body of each probe of a writable entry (physical/ddl/roles.ts installs one per unique object of T its precheck
 * calls, write/entry/precheck.ts), at the values `given` names for the fields it compares (write/insert/unique.ts
 * probeParams): true where a fact of T outside the entry meets them at the probed object, within its guards on both
 * sides, equal at its compared fields, overlapping at its span, the entry's membership at that fact false:
 *
 *   EXISTS (SELECT true FROM T AS r0 WHERE <guards at r0> AND <guards at given> AND r0.f = <f given> ...
 *     [AND r0.span && <span given>] AND NOT (<membership at r0>) IS TRUE)
 *
 * The membership is rendered once for every probe of the entry. One rendering serves both readers: the probe function
 * the installation creates, over its parameters, and the certifier's read of a call of it, over the call's arguments
 * (program/isolation/certification.ts).
 */
export const renderProbes = (
	entry: CheckedEntry,
	options: ProbeOptions
): Result.Result<
	(probed: OutsideProbe, given: (field: LawField) => Expr) => Expr,
	CompileError
> => {
	const stored = (field: LawField): Expr => col(probeRow, options.column(field))
	const membership = renderMembership(entry, { ...options, row: stored })
	if (!membership.ok) {
		return membership
	}
	const outside = not({ kind: "isTrue", expr: membership.value })
	/** The context a unique object's guards lower in: the law model's DAG, which holds them, and the installation's
	 * names. A guard reads its row alone, so it takes no parameter. */
	const guardCx = new LowerContext(
		options.dag,
		{ names: options.names, params: [], subject: { kind: "query" } },
		dispatchNode,
		evaluatedAsItStands,
		carriesNothing
	)
	/** A probed object's guards over one side's values (write/probe.ts withinRow): a declared key's none, since it holds
	 * every fact apart. */
	const within = (probed: OutsideProbe, of: (field: LawField) => Expr): ReadonlyArray<Expr> =>
		probed.kind === "unique" ? withinRow(guardCx, probed.object, of) : []
	return Result.ok((probed, given) => {
		const u = probed.object
		return exists(
			simpleSelect(
				[target(lit.bool(true))],
				[table(options.table.schema, options.table.name, probeRow)],
				and(
					appendNonEmpty(
						[
							...within(probed, stored),
							...within(probed, given),
							...u.equal.map((f) => typedEq(f.type, stored(f), given(f), options.names)),
							...(u.kind === "span" ? [binary("&&", stored(u.span), given(u.span))] : [])
						],
						outside
					)
				)
			)
		)
	})
}
