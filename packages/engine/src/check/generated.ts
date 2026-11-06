import type { GeneratedRule } from "#compiler/core/causes.ts"
import { NodeId } from "#compiler/core/ids.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { type ScalarType, sameScalarType, typeLabel } from "#compiler/ir/scalar.ts"

/**
 * A generated field's rule: a STORED generated column's expression reads its own row's written fields, literals and
 * closed relations, and nothing else, and its value is of the column's declared type (PostgreSQL: "The generation
 * expression can only use immutable functions and cannot use subqueries or reference anything other than the current
 * row in any way", "A generation expression cannot reference another generated column",
 * https://github.com/postgres/postgres/blob/REL_19_RC1/doc/src/sgml/ddl.sgml#L406-L413).
 *
 * analysis/schema.ts applies it to every generated field of a checked schema, in field order, as the one place the rule
 * lives: the builder's row is typed by the written fields alone, so a JavaScript caller never meets it, and a decoded
 * Description meets it here.
 */

/** An input beyond a generation expression's own row: the ExprDesc kinds a row-local expression never holds. */
type ForeignKind = Extract<GeneratedRule, { readonly kind: "notRowLocal" }>["input"]

/** An expression's direct subexpressions, in the order its description states them. */
const subterms = (e: ExprDesc): ReadonlyArray<ExprDesc> => {
	switch (e.kind) {
		case "var":
		case "field":
		case "value":
		case "parent":
		case "param":
		case "literal":
			return []
		case "compute":
		case "and":
		case "or":
		case "closedAt":
		case "closedRow":
			return e.args
		case "cast":
		case "base":
		case "not":
		case "in":
			return [e.arg]
		case "cond":
			return [e.pred, e.onTrue, e.onFalse]
		case "when":
			return [e.subject, e.proved, e.otherwise]
		case "compare":
		case "allen":
			return [e.left, e.right]
		case "between":
			return [e.arg, e.low, e.high]
		case "pointIn":
			return [e.point, e.span]
		case "absent":
			return Object.values(e.bindings)
	}
}

/** The kind of `e` when it is an input beyond the row, or undefined for a row-local node. */
const foreignKind = (e: ExprDesc): ForeignKind | undefined => {
	switch (e.kind) {
		case "var":
		case "param":
		case "parent":
		case "value":
		case "absent":
			return e.kind
		case "field":
		case "literal":
		case "compute":
		case "and":
		case "or":
		case "closedAt":
		case "closedRow":
		case "cast":
		case "base":
		case "not":
		case "in":
		case "cond":
		case "when":
		case "compare":
		case "allen":
		case "between":
		case "pointIn":
			return undefined
	}
}

/** The first input of `e` beyond its row, in the order its description states it, or undefined for none. */
const firstForeign = (e: ExprDesc): ForeignKind | undefined => {
	const own = foreignKind(e)
	if (own !== undefined) {
		return own
	}
	for (const s of subterms(e)) {
		const found = firstForeign(s)
		if (found !== undefined) {
			return found
		}
	}
	return undefined
}

/** Every field `e` reads, each once, into `out`. */
const fieldReads = (e: ExprDesc, out: Set<string>): Set<string> => {
	if (e.kind === "field") {
		out.add(e.field)
	}
	for (const s of subterms(e)) {
		fieldReads(s, out)
	}
	return out
}

/** Every closed relation `e` applies, by C.at or C.row, each once, in the order its description states them. */
export const closedReadNames = (e: ExprDesc): ReadonlyArray<string> => {
	const out = new Set<string>()
	const visit = (x: ExprDesc): void => {
		for (const s of subterms(x)) {
			visit(s)
		}
		if (x.kind === "closedAt" || x.kind === "closedRow") {
			out.add(x.relation)
		}
	}
	visit(e)
	return [...out]
}

/**
 * Why the generation expression `expr` breaks the rule before it is typed, or undefined when it keeps it: the first
 * input beyond its row in description order (notRowLocal), else the least field it reads in code-unit order that
 * `generated` says is generated, itself among them (readsGenerated), else the least one `unwritten` says grizzle draws
 * or accumulates on the host (readsUnwritten). So of a relation whose generated fields read one another, a cycle or
 * not, the refusal names the least generated field read.
 */
export const generatedRule = (
	expr: ExprDesc,
	generated: (field: string) => boolean,
	unwritten: (field: string) => "drawn" | "accumulated" | undefined
): GeneratedRule | undefined => {
	const input = firstForeign(expr)
	if (input !== undefined) {
		return { kind: "notRowLocal", input }
	}
	const reads = [...fieldReads(expr, new Set())].toSorted(compareStrings)
	const read = reads.find(generated)
	if (read !== undefined) {
		return { kind: "readsGenerated", read }
	}
	for (const field of reads) {
		const writing = unwritten(field)
		if (writing !== undefined) {
			return { kind: "readsUnwritten", read: field, writing }
		}
	}
	return undefined
}

/**
 * Why a generation expression of type `expression` cannot fill a column of type `declared`, or undefined when it can:
 * the two are one type (sameScalarType), since PostgreSQL types a generation expression by its column and grizzle casts
 * nothing implicitly (OPEN-U4).
 */
export const generatedTypeRule = (
	declared: ScalarType,
	expression: ScalarType
): GeneratedRule | undefined =>
	sameScalarType(declared, expression)
		? undefined
		: { kind: "type", declared: typeLabel(declared), expression: typeLabel(expression) }

/**
 * The node a generated field's expression reads its row as: each field it reads is a column of this node, named by the
 * field, which the installation reads as the column of the field's own table.
 */
export const rowNode: NodeId = NodeId("row")
