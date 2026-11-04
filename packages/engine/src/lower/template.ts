import { encodeFailure, slotPlace } from "#compiler/codec/fault.ts"
import {
	keyedColumns,
	normalEncoder,
	type RelationSpec,
	recordsetEncoder
} from "#compiler/codec/recordset.ts"
import { paramEncoder, resultTextCasts } from "#compiler/codec/scalar.ts"
import type { BudgetMeter } from "#compiler/core/budget.ts"
import { canonicalEquals, catchRefusal, everyProperty, Refusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { defect } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type {
	Encoder,
	MemberEncoder,
	PageFill,
	ParamSlot,
	StatementSpec,
	WriteSlot
} from "#compiler/ir/products.ts"

import {
	type ConservativeParamSlot,
	type ConservativeStatement,
	type DeclaredParamSlot,
	type MemberParamSlot,
	mapTree,
	type PageParamSlot,
	type PageStatementSlot,
	type ProgramDelivery,
	type RelationColumn,
	type StatementOutput,
	type StatementRoots,
	statementOutput,
	type WriteParamSlot
} from "#compiler/lower/conservative/types.ts"
import type { FusedAttachment } from "#compiler/lower/shapes/attach/decode.ts"
import type {
	FusedStatement,
	OptimizedStatement,
	RelationChoice
} from "#compiler/lower/shapes/index.ts"
import type { Expr, OrderItem, Select, SelectBody, Target } from "#compiler/sql/ast.ts"
import {
	cast,
	col,
	core,
	derived,
	mapTargets,
	select,
	target,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import { emit, metered, unmetered } from "#compiler/sql/emit.ts"
import { NameSupply, renderNameMap } from "#compiler/sql/naming.ts"

const textCast = (e: Expr, castTypes: ReadonlyArray<"numeric" | "text">): Expr =>
	castTypes.reduce<Expr>((acc, t) => cast(acc, t === "numeric" ? types.numeric : types.text), e)

/** One output column of a statement: its public name and the casts that make its result text. */
interface OutputColumn {
	readonly name: string
	readonly casts: ReadonlyArray<"numeric" | "text">
}

/**
 * Each output column, position by position: each heading column with its own casts, then text for each fused
 * attachment's array column.
 */
const outputColumns = (output: StatementOutput<FusedAttachment>): ReadonlyArray<OutputColumn> => [
	...output.heading.map((c) => ({ name: c.name, casts: resultTextCasts(c.type) })),
	...output.fused.map((f): OutputColumn => ({ name: f.name, casts: ["text"] }))
]

/** The output targets of a query body: a core's own, and a set operation's its left arm's, as PostgreSQL takes them. */
const outputTargets = (body: SelectBody): ReadonlyArray<Target> => {
	switch (body.kind) {
		case "core":
			return body.targets
		case "setOp":
			return outputTargets(body.arms[0])
		case "select":
			return outputTargets(body.body)
	}
}

/**
 * Each outermost target with its output column. The one site of the fact that a statement's outermost targets are its
 * output's columns, position by position: renameToPublicHeading renamed them to the output's names and refuses any
 * other count, and the Select AST's target list carries no count.
 */
const targetColumns = (
	targets: ReadonlyArray<Target>,
	columns: ReadonlyArray<OutputColumn>
): ReadonlyArray<{ readonly target: Target; readonly column: OutputColumn }> => {
	const each = columns.values()
	const out = targets.flatMap((t) => {
		const column = each.next()
		return column.done === true ? [] : [{ target: t, column: column.value }]
	})
	if (out.length !== targets.length || each.next().done !== true) {
		throw defect("a statement's outermost targets are its output's columns")
	}
	return out
}

/** The first relation and column numbers no generated name of the statement uses. */
const freshSupply = (statement: ConservativeStatement<ConservativeParamSlot>): NameSupply => {
	let relation = 0
	let column = 0
	for (const entry of statement.sql.nameMap) {
		const n = Number(entry.name.slice(1))
		if (!Number.isSafeInteger(n)) {
			continue
		}
		if (entry.role === "relation") {
			relation = Math.max(relation, n)
		} else {
			column = Math.max(column, n)
		}
	}
	return new NameSupply({ relationStart: relation + 1, columnStart: column + 1 })
}

const outerCore = (body: SelectBody) => (body.kind === "core" ? body : undefined)

/**
 * Checks of a host value an encoder reads, each narrowing by the check it performs. An object with an
 * iterator method key is iterated by the encoder, exactly as the runtime iteration protocol reads it.
 */
const isIterableObject = (value: unknown): value is Iterable<unknown> =>
	typeof value === "object" &&
	value !== null &&
	Symbol.iterator in value &&
	typeof value[Symbol.iterator] === "function"

/**
 * The statement's AST with every output column cast to its result text. The lowering built the statement: its
 * outermost body is a SELECT core whose targets are named, and a deduplicating statement orders by its output columns.
 */
export const executableQuery = (statement: FusedStatement<ConservativeParamSlot>): Select => {
	const ast = statement.ast
	const columns = outputColumns(statementOutput(statement.role, statement.heading, statement.fused))
	const plain = outerCore(ast.body)
	if (plain?.distinct === false && plain.groupBy.length === 0) {
		const targets = targetColumns(plain.targets, columns).map(({ target: t, column }) => ({
			...t,
			expr: textCast(t.expr, column.casts)
		}))
		return { ...ast, body: { ...plain, targets } }
	}
	/** SELECT r.c1::text AS name1, ... FROM (<statement>) AS r(c1, ...) ORDER BY r.c<k> ... */
	const supply = freshSupply(statement)
	const origin = { kind: "internal", purpose: "result text casts" } as const
	const alias = supply.relation(origin)
	const outputs = targetColumns(outputTargets(ast.body), columns).map((c) => ({
		...c,
		derived: supply.column(origin)
	}))
	/**
	 * A deduplicating statement orders by its output columns, as PostgreSQL requires of SELECT DISTINCT: the one site of
	 * that fact, which the lowering builds every such statement by and the ORDER BY AST does not carry.
	 */
	const orderBy: ReadonlyArray<OrderItem> = ast.orderBy.map((item) => {
		const output = outputs.find((o) => canonicalEquals(o.target.expr, item.expr, everyProperty))
		if (output === undefined) {
			throw defect("an ORDER BY item that is an output column of a deduplicating statement")
		}
		return { ...item, expr: col(alias, output.derived) }
	})
	/**
	 * The public names move to the outer SELECT, the only one that renames; the derived table's own
	 * columns are named by its column list.
	 */
	const inner = outerCore(ast.body)
	const query: Select =
		inner === undefined ? ast : { ...ast, body: mapTargets(inner, (t) => target(t.expr)) }
	return {
		...select(
			core(
				outputs.map((o) =>
					targetAs(textCast(col(alias, o.derived), o.column.casts), o.column.name)
				),
				[
					derived(
						query,
						alias,
						outputs.map((o) => o.derived),
						false
					)
				],
				undefined
			)
		),
		orderBy
	}
}

/** The recordset spec of a relation-valued placeholder over `columns`, its refusals naming `label`. */
const placeholderSpec = (label: string, columns: ReadonlyArray<RelationColumn>): RelationSpec => ({
	relation: label,
	slot: { kind: "slot", name: label },
	columns: keyedColumns(
		columns.map((c) => ({ name: c.name, type: c.type, key: c.definition.name }))
	)
})

/**
 * The encoder of a member slot's placeholder over `columns`: the host normalized the slot's facts already, so it
 * writes their rows in its column order (codec/recordset.ts normalRows) and refuses no same-key pair.
 */
const memberEncoder = (label: string, columns: ReadonlyArray<RelationColumn>): MemberEncoder => {
	const encode = normalEncoder(placeholderSpec(label, columns))
	return (facts) => Result.map(encode(facts), (encoded) => encoded.json)
}

/**
 * The deduplicating recordset encoder of a relation parameter's placeholder over `columns`, its refusals naming
 * `label`: a relation parameter is a set of facts, deduplicated.
 */
const relationEncoder = (label: string, columns: ReadonlyArray<RelationColumn>): Encoder => {
	const encode = recordsetEncoder(placeholderSpec(label, columns))
	return (value) => {
		if (!isIterableObject(value)) {
			return Result.err(encodeFailure("factShape", slotPlace(label)))
		}
		return Result.map(encode(value), (encoded) => encoded.json)
	}
}

/**
 * The label a page placeholder's encoder names. It is never observable: the page runtime turns an encoding refusal of
 * a page placeholder into a defect, and binds a boundary as the cursor's text without encoding it
 * (adapter/page/execute.ts).
 */
const pageLabel = (fill: PageFill): string => {
	switch (fill.kind) {
		case "limit":
			return "page limit"
		case "size":
			return "page size"
		case "boundary":
			return `page boundary ${fill.position}`
	}
}

/** What fills a declared parameter's placeholder, with its encoder: a scalar's text codec, a relation's recordset encoder. */
export const declaredSlotOf = (
	slot: DeclaredParamSlot
): Extract<ParamSlot, { readonly kind: "scalar" | "relation" }> => {
	switch (slot.kind) {
		case "scalar":
			return { kind: "scalar", param: slot.param, encode: paramEncoder(slot.type, slot.param) }
		case "relation":
			return {
				kind: "relation",
				param: slot.param,
				encode: relationEncoder(slot.param, slot.columns)
			}
	}
}

/** What fills a member slot's placeholder, with its recordset encoder over the slot's normal facts. */
const memberSlotOf = (slot: MemberParamSlot): Extract<ParamSlot, { readonly kind: "member" }> => ({
	kind: "member",
	slot: slot.slot,
	encode: memberEncoder(slot.relation, slot.columns)
})

/** What fills a page placeholder, with its integer or comparator codec. */
export const pageSlotOf = (slot: PageParamSlot): Extract<ParamSlot, { readonly kind: "page" }> => ({
	kind: "page",
	fill: slot.fill,
	encode: paramEncoder(slot.type, pageLabel(slot.fill))
})

/** What fills a write statement's placeholder, with its encoder: a declared parameter's or a member slot's. */
export const writeSlotOf = (slot: WriteParamSlot): WriteSlot =>
	slot.kind === "member" ? memberSlotOf(slot) : declaredSlotOf(slot)

/** What fills a page statement's placeholder, with its encoder: a declared parameter's or a page fill's. */
export const pageStatementSlotOf = (slot: PageStatementSlot): ParamSlot =>
	slot.kind === "page" ? pageSlotOf(slot) : declaredSlotOf(slot)

/**
 * How the executable texts are charged: against the compilation's meter, an overrun located at the artifact the
 * statements are; or not at all, as the runtime rebuilds the specs of a page template its compilation already charged.
 */
export type SpecCharge =
	| { readonly kind: "metered"; readonly meter: BudgetMeter; readonly artifact: string }
	| { readonly kind: "unmetered" }

/** A query statement's large form as a template holds it: the large mode's statement and the spec emitted from it. */
export interface SpecifiedForm {
	readonly statement: FusedStatement
	readonly spec: StatementSpec
}

/**
 * A statement of an artifact as the runtime binds, sends and decodes it: the lowered statement, read as an optimized
 * one, its large form with its own spec, and the spec emitted from it.
 */
export interface SpecifiedStatement {
	readonly statement: OptimizedStatement<RelationChoice, SpecifiedForm>
	readonly spec: StatementSpec
}

/** An artifact as the runtime runs it: its statements, each with its spec, in their tree, and their delivery. */
export interface SpecifiedArtifact {
	readonly delivery: ProgramDelivery
	readonly roots: StatementRoots<SpecifiedStatement>
}

/** The spec emitted from `statement`, each placeholder filled as `slotOf` says. */
export const statementSpec = <Slot extends ConservativeParamSlot, P extends ParamSlot>(
	statement: FusedStatement<Slot>,
	charge: SpecCharge,
	index: number,
	slotOf: (slot: Slot) => P
): Result.Result<StatementSpec<P>, CompileError> =>
	Result.flatMap(
		catchRefusal(() => {
			const executable = emit(
				executableQuery(statement),
				statement.sql.nameMap,
				charge.kind === "metered"
					? metered(
							charge.meter,
							SourceLoc(`${charge.artifact} template`, ["statements", index, statement.role.kind])
						)
					: unmetered
			)
			if (!executable.ok) {
				return Result.err(executable.error)
			}
			return Result.ok({
				sql: executable.value.text,
				paramSlots: statement.params.map(slotOf),
				heading: statementOutput(statement.role, statement.heading, statement.fused).heading,
				role: statement.role.kind,
				dependsOn: statement.dependsOn
			})
		}),
		(spec) => spec
	)

/**
 * Every statement of one query artifact, each with the spec emitted from it.
 *
 * Template assembly: a lowered program's statements as the runtime binds, executes and converts them.
 *
 * Each statement of either artifact becomes a StatementSpec:
 *
 * - its executable text: the outermost SELECT casts each delivered column to text, money through numeric (codec
 *   resultTextCasts), and the converters read PostgreSQL's exact text forms, which the runtime takes as the server sent
 *   them and parses none (adapter/wire/session.ts). A fused attachment's array column is cast to text as well, which
 *   is its array literal. Where the outermost SELECT deduplicates, a cast in its target list would deduplicate the
 *   texts rather than the values (1.0 and 1.00 are one numeric and two texts: PostgreSQL's output texts are raw, and
 *   only decode reads them into one form), so the statement is read as a derived table that deduplicates values and
 *   the casts are applied outside it, with its ORDER BY re-applied to the uncast columns;
 * - one encoder per placeholder: a scalar parameter's text codec, a relation parameter's deduplicating recordset
 *   encoder (codec/recordset.ts), and the delivered parent keys of an attachment, whose texts the runtime reads from
 *   the parent statement's rows;
 * - its heading, the statement's output heading: its rows are texts, a rows statement's its heading's columns then one
 *   per fused attachment column, an attachment statement's the parent key columns first, which the runtime stitches
 *   onto its parents; the value's decoder converts them (adapter/reader/execution.ts).
 */
export const specifiedStatements = <S extends FusedStatement>(
	roots: StatementRoots<S>,
	charge: SpecCharge
): Result.Result<
	StatementRoots<{ readonly statement: S; readonly spec: StatementSpec }>,
	CompileError
> =>
	catchRefusal(() =>
		mapTree(roots, (statement, i) => {
			const spec = statementSpec(statement, charge, i, declaredSlotOf)
			if (!spec.ok) {
				throw new Refusal(spec.error)
			}
			return { statement, spec: spec.value }
		})
	)

/** Each statement's generated names, `<statement>:<name>`, to what they stand for. */
export const templateNameMap = (
	statements: ReadonlyArray<ConservativeStatement<ConservativeParamSlot>>
): Readonly<Record<string, string>> => {
	const out: Record<string, string> = {}
	for (const [i, s] of statements.entries()) {
		for (const entry of s.sql.nameMap) {
			out[`${i}:${entry.name}`] = renderNameMap([entry]).slice(entry.name.length + 1)
		}
	}
	return out
}
