import { maxOf } from "#compiler/core/array.ts"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import { defect } from "#compiler/core/invariant.ts"
import { bytesChunkLength } from "#compiler/core/limits.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { StatementSpec } from "#compiler/ir/products.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import type { ConservativeParamSlot, ProgramDelivery } from "#compiler/lower/conservative/types.ts"
import {
	type DeliveredColumn,
	deliveredColumn,
	deliveredRows,
	type PlainQuery,
	textColumn
} from "#compiler/lower/delivery.ts"
import { type PartDivision, partCellColumn, partTagColumn } from "#compiler/lower/parts.ts"
import type {
	DeliveredPart,
	FusedStatement,
	OptimizedDeliveryProgram,
	RelationChoice,
	SentStatement,
	StatementParts
} from "#compiler/lower/shapes/index.ts"
import type { StatementForms } from "#compiler/runtime/lower/forms.ts"
import type { FusedAttachment } from "#compiler/runtime/lower/fused.ts"
import { declaredSlotOf } from "#compiler/runtime/lower/slots.ts"
import {
	type StatementOutput,
	statementOutput,
	type StatementRoots
} from "#compiler/runtime/lower/tree.ts"
import { wildcardText } from "#compiler/scalar/compute/types.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import type { OperandBody, OrderItem, Select, SelectBody, Target } from "#compiler/sql/ast.ts"
import { col, derived, mapTargets, provedCore, target, targetAs } from "#compiler/sql/build.ts"
import { freshNames, NameSupply, namesPast } from "#compiler/sql/naming.ts"

/** One output column of a statement: its public name and how it is delivered (lower/delivery.ts). */
interface OutputColumn {
	readonly name: string
	readonly delivered: DeliveredColumn
}

/**
 * Each output column, position by position: each heading column as its type delivers it, then each fused attachment's
 * array column, a text.
 */
const outputColumns = (output: StatementOutput<FusedAttachment>): ReadonlyArray<OutputColumn> => [
	...output.heading.map((c) => ({ name: c.name, delivered: deliveredColumn(c.type) })),
	...output.fused.map((f): OutputColumn => ({ name: f.name, delivered: textColumn }))
]

/** The output targets of a query body: a core's own, and a set operation's its left arm's, as PostgreSQL takes them. */
const outputTargets = (body: OperandBody): ReadonlyArray<Target> => {
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

const outerCore = (body: SelectBody) => (body.kind === "core" ? body : undefined)

/**
 * The statement's AST as it delivers its rows (lower/delivery.ts deliveredRows): every output column cast to its result
 * text, or, where one is bytes, every row in chunks. The lowering built the statement: its outermost body is a SELECT
 * core whose targets are named, and a deduplicating statement orders by its output columns.
 */
export const executableQuery = (statement: FusedStatement<ConservativeParamSlot>): Select =>
	executableQueryFrom(statement, new NameSupply(namesPast(statement.sql.nameMap, freshNames)))

/**
 * The statement's executable query (`executableQuery`), the names it adds drawn from `supply`: a read-back riding a write
 * statement draws them past every name of that statement, its own statements' included, so no part of the write
 * statement defines a name another defines.
 */
export const executableQueryFrom = (
	statement: Pick<FusedStatement<ConservativeParamSlot>, "ast" | "role" | "heading" | "fused">,
	supply: NameSupply
): PlainQuery => {
	const ast = statement.ast
	const columns = outputColumns(statementOutput(statement.role, statement.heading, statement.fused))
	const delivered = columns.map((c) => c.delivered)
	const plain = outerCore(ast.body)
	if (plain?.distinct === false && plain.groupBy.length === 0) {
		return deliveredRows({ ...ast, body: plain }, delivered, [], supply, bytesChunkLength.value)
	}
	/** SELECT r.c1 AS name1, ... FROM (<statement>) AS r(c1, ...) ORDER BY r.c<k> ..., delivered. */
	const origin = { kind: "internal", purpose: "result text casts" } as const
	const alias = supply.relation(origin)
	const outputs = targetColumns(outputTargets(ast.body), columns).map((c) => ({
		...c,
		derived: supply.column(origin)
	}))
	const outputTexts = outputs.map((o) => canonicalTextOf(o.target.expr))
	/**
	 * A deduplicating statement orders by its output columns, as PostgreSQL requires of SELECT DISTINCT: the one site of
	 * that fact, which the lowering builds every such statement by and the ORDER BY AST does not carry.
	 */
	const orderBy: ReadonlyArray<OrderItem> = ast.orderBy.map((item) => {
		const output = outputs[outputTexts.indexOf(canonicalTextOf(item.expr))]
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
	const rows: PlainQuery = {
		kind: "select",
		with: undefined,
		limit: undefined,
		offset: undefined,
		body: provedCore(
			"keyed",
			outputs.map((o) => targetAs(col(alias, o.derived), o.column.name)),
			[
				derived(
					query,
					alias,
					outputs.map((o) => o.derived),
					false
				)
			],
			undefined
		),
		orderBy
	}
	return deliveredRows(rows, delivered, [], supply, bytesChunkLength.value)
}

/** A program statement's large form as a template holds it: the large mode's statement and the spec emitted from it. */
export interface SpecifiedForm {
	readonly statement: SentStatement
	readonly spec: StatementSpec
}

/**
 * The statement an artifact sends as the runtime binds, sends and decodes it: the program's statement, its large form
 * with its own spec, and the spec emitted from it.
 */
export interface SpecifiedStatement extends SentStatement {
	readonly forms: StatementForms<RelationChoice, SpecifiedForm>
	readonly spec: StatementSpec
}

/**
 * An artifact as the runtime runs it: its statement with its spec, how its rows divide into parts, its parts in their
 * tree, and their delivery.
 */
export interface SpecifiedArtifact {
	readonly delivery: ProgramDelivery
	readonly statement: SpecifiedStatement
	readonly parts: StatementParts
	readonly roots: StatementRoots<DeliveredPart>
}

/**
 * The output heading of a program's statement as its parts divide it: its one part's output, or the tag and the cells
 * after it, each a text (lower/parts.ts taggedParts).
 */
export const sentHeading = (parts: PartDivision, roots: StatementRoots<DeliveredPart>): Heading => {
	if (parts.kind === "tagged") {
		const width = maxOf(
			parts.parts.map((p) => (p.kind === "numbered" ? p.width + 1 : p.width)),
			0
		)
		return [
			{ name: partTagColumn, type: wildcardText },
			...Array.from({ length: width }, (_, i) => ({
				name: `${partCellColumn}${i + 1}`,
				type: wildcardText
			}))
		]
	}
	const [root] = roots
	return statementOutput(root.statement.role, root.statement.heading, root.statement.fused).heading
}

/**
 * The spec of the program statement `statement`, whose rows divide into `parts`, each placeholder filled as `slotOf`
 * says: its text, already executable, and its output heading.
 */
export const sentSpec = <Slot extends ConservativeParamSlot, P>(
	statement: SentStatement<Slot>,
	parts: PartDivision,
	roots: StatementRoots<DeliveredPart>,
	slotOf: (slot: Slot) => P
): StatementSpec<P> => ({
	sql: statement.sql.text,
	paramSlots: statement.params.map(slotOf),
	heading: sentHeading(parts, roots),
	role: "main",
	dependsOn: []
})

/** An optimized program as the runtime runs it: its statement and its large form, each with its spec. */
export const specifiedProgram = (
	program: OptimizedDeliveryProgram<RelationChoice>,
	codes: Codebook
): SpecifiedArtifact => {
	const slotOf = declaredSlotOf(codes, new CompilePatterns())
	const { statement, parts, roots } = program
	const spec = sentSpec(statement, parts, roots, slotOf)
	const forms = statement.forms
	return {
		delivery: program.delivery,
		statement: {
			...statement,
			forms:
				forms.kind === "one"
					? forms
					: {
							...forms,
							large: {
								statement: forms.large,
								spec: sentSpec(forms.large, parts, roots, slotOf)
							}
						},
			spec
		},
		parts,
		roots
	}
}
