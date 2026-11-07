import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import {
	type BindingsDesc,
	type ExprDesc,
	type HeadTermDesc,
	type MatchDesc,
	mapProducer,
	type RuleDesc,
	type SourceDesc
} from "#compiler/ir/desc.ts"
import type {
	InteriorRef,
	OpenBindings,
	OpenExpr,
	OpenHead,
	OpenMatch,
	OpenRule,
	OpenSource,
	ParentRef,
	VarRef
} from "#compiler/ir/open.ts"

/** How an open rule's references are spelled: a variable, a parent variable and an interior stage. */
interface Spellings {
	readonly var: (ref: VarRef) => string
	readonly parent: (ref: ParentRef) => string
	readonly interior: (ref: InteriorRef) => string
}

const spellBindings = (b: OpenBindings, s: Spellings): BindingsDesc => {
	const out: Record<string, ExprDesc> = {}
	for (const [k, e] of Object.entries(b)) {
		out[k] = spellExpr(e, s)
	}
	return out
}

const spellSource = (source: OpenSource, s: Spellings): SourceDesc => {
	switch (source.kind) {
		case "interior":
			return { kind: "interior", id: s.interior(source.id) }
		case "query":
			return {
				kind: "query",
				query: source.query,
				bind: Object.fromEntries(
					Object.entries(source.bind).map(([k, b]) => [
						k,
						b.kind === "relationParam" ? b : spellExpr(b, s)
					])
				)
			}
		case "param":
		case "paramOf":
		case "relation":
		case "self":
		case "delta":
		case "context":
		case "row":
			return source
	}
}

/** An open expression with every reference spelled. */
export const spellExpr = (e: OpenExpr, s: Spellings): ExprDesc => {
	switch (e.kind) {
		case "var":
			return { kind: "var", var: s.var(e.var) }
		case "parent":
			return { kind: "parent", column: s.parent(e.column) }
		case "field":
		case "value":
		case "param":
		case "literal":
			return e
		case "compute":
			return e.fn === "round" || e.fn === "trunc"
				? { kind: "compute", fn: e.fn, args: e.args.map((a) => spellExpr(a, s)), scale: e.scale }
				: { kind: "compute", fn: e.fn, args: e.args.map((a) => spellExpr(a, s)) }
		case "cast":
			return { kind: "cast", to: e.to, arg: spellExpr(e.arg, s) }
		case "base":
			return { kind: "base", arg: spellExpr(e.arg, s) }
		case "not":
			return { kind: "not", arg: spellExpr(e.arg, s) }
		case "cond":
			return {
				kind: "cond",
				pred: spellExpr(e.pred, s),
				onTrue: spellExpr(e.onTrue, s),
				onFalse: spellExpr(e.onFalse, s)
			}
		case "when":
			return {
				kind: "when",
				guard: e.guard,
				subject: spellExpr(e.subject, s),
				proved: spellExpr(e.proved, s),
				otherwise: spellExpr(e.otherwise, s)
			}
		case "compare":
			return { kind: "compare", op: e.op, left: spellExpr(e.left, s), right: spellExpr(e.right, s) }
		case "between":
			return {
				kind: "between",
				arg: spellExpr(e.arg, s),
				low: spellExpr(e.low, s),
				high: spellExpr(e.high, s)
			}
		case "in":
			return { kind: "in", arg: spellExpr(e.arg, s), values: e.values }
		case "and":
		case "or":
			return { kind: e.kind, args: mapNonEmpty(e.args, (a) => spellExpr(a, s)) }
		case "allen":
			return {
				kind: "allen",
				left: spellExpr(e.left, s),
				mask: e.mask,
				right: spellExpr(e.right, s)
			}
		case "pointIn":
			return { kind: "pointIn", point: spellExpr(e.point, s), span: spellExpr(e.span, s) }
		case "absent":
			return {
				kind: "absent",
				source: spellSource(e.source, s),
				bindings: spellBindings(e.bindings, s)
			}
		case "closedAt":
			return {
				kind: "closedAt",
				relation: e.relation,
				field: e.field,
				args: mapNonEmpty(e.args, (a) => spellExpr(a, s))
			}
		case "closedRow":
			return { kind: "closedRow", relation: e.relation, args: e.args.map((a) => spellExpr(a, s)) }
		case "closedHas":
			return {
				kind: "closedHas",
				relation: e.relation,
				args: mapNonEmpty(e.args, (a) => spellExpr(a, s))
			}
	}
}

/** A head term spelled: an aggregate's argument, a producer's arguments, or the scalar expression. */
const spellHead = (h: OpenHead, s: Spellings): HeadTermDesc => {
	if (h.kind === "aggregate") {
		return h.fn === "count" ? h : { kind: "aggregate", fn: h.fn, arg: spellExpr(h.arg, s) }
	}
	if (h.kind === "producer") {
		return mapProducer(h, (a) => spellExpr(a, s))
	}
	return spellExpr(h, s)
}

const spellMatch = (m: OpenMatch, s: Spellings): MatchDesc => ({
	...m,
	source: spellSource(m.source, s),
	bindings: spellBindings(m.bindings, s)
})

/**
 * An open rule with its own clauses spelled: its matches (each source's bind map and the bindings), its where
 * predicates and its head. Its interior stages, its attachments' children and the queries its sources import are
 * nested scopes, already spelled, and are kept as they are; a relational negation (`absent`) is part of the clause it
 * appears in, its bindings and its source's bind map clause terms, the query it reads nested.
 *
 * The clauses are visited in the order they were written: the matches, then the predicates, then the head, so a
 * spelling that numbers first uses numbers them in reading order.
 */
export const spellRule = (rule: OpenRule, s: Spellings): RuleDesc => {
	const matches = rule.matches.map((m) => spellMatch(m, s))
	const where = rule.where.map((w) => spellExpr(w, s))
	const head: Record<string, HeadTermDesc> = {}
	for (const [k, h] of Object.entries(rule.head)) {
		head[k] = spellHead(h, s)
	}
	return { ...rule, matches, where, head }
}
