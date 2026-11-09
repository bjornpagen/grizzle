import { canonicalTextOf, catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { defect } from "#compiler/core/invariant.ts"
import { bytesChunkLength } from "#compiler/core/limits.ts"
import * as Result from "#compiler/core/result.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { StatementSpec } from "#compiler/ir/products.ts"
import type {
	ConservativeParamSlot,
	ConservativeStatement,
	ProgramDelivery
} from "#compiler/lower/conservative/types.ts"
import {
	type DeliveredColumn,
	deliveredColumn,
	deliveredRows,
	type PlainQuery,
	textColumn
} from "#compiler/lower/delivery.ts"
import type {
	FusedStatement,
	OptimizedStatement,
	RelationChoice
} from "#compiler/lower/shapes/index.ts"
import type { FusedAttachment } from "#compiler/runtime/lower/fused.ts"
import { declaredSlotOf } from "#compiler/runtime/lower/slots.ts"
import {
	mapTree,
	type StatementOutput,
	statementOutput,
	type StatementRoots
} from "#compiler/runtime/lower/tree.ts"
import type { OperandBody, OrderItem, Select, SelectBody, Target } from "#compiler/sql/ast.ts"
import { col, derived, mapTargets, provedCore, target, targetAs } from "#compiler/sql/build.ts"
import { emit } from "#compiler/sql/emit.ts"
import { freshNames, NameSupply, namesPast, renderNameMap } from "#compiler/sql/naming.ts"

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
export const executableQuery = (statement: FusedStatement<ConservativeParamSlot>): Select => {
	const ast = statement.ast
	const columns = outputColumns(statementOutput(statement.role, statement.heading, statement.fused))
	const delivered = columns.map((c) => c.delivered)
	const supply = new NameSupply(namesPast(statement.sql.nameMap, freshNames))
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
export const statementSpec = <Slot extends ConservativeParamSlot, P>(
	statement: FusedStatement<Slot>,
	slotOf: (slot: Slot) => P
): Result.Result<StatementSpec<P>, CompileError> =>
	Result.flatMap(
		catchRefusal(() => executableQuery(statement)),
		(query) =>
			Result.map(emit(query, statement.sql.nameMap), (executable): StatementSpec<P> => ({
				sql: executable.text,
				paramSlots: statement.params.map(slotOf),
				heading: statementOutput(statement.role, statement.heading, statement.fused).heading,
				role: statement.role.kind,
				dependsOn: statement.dependsOn
			}))
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
 * - one encoder per placeholder: a scalar parameter's text codec, a relation parameter's array encoder over the input's
 *   normal facts (codec/recordset.ts normalArray), which writes that placeholder's array alone, and the delivered parent
 *   keys of an attachment, whose texts the runtime reads from the parent statement's rows;
 * - its heading, the statement's output heading: its rows are texts, a rows statement's its heading's columns then one
 *   per fused attachment column, an attachment statement's the parent key columns first, which the runtime stitches
 *   onto its parents; the value's decoder converts them (adapter/reader/execution.ts).
 */
export const specifiedStatements = <S extends FusedStatement>(
	roots: StatementRoots<S>,
	codes: Codebook
): Result.Result<
	StatementRoots<{ readonly statement: S; readonly spec: StatementSpec }>,
	CompileError
> =>
	catchRefusal(() =>
		mapTree(roots, (statement) => {
			const spec = statementSpec(statement, declaredSlotOf(codes))
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
