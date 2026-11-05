import {
	boundParam,
	type ParamCell,
	type ResolvedBindings,
	type ResolvedBound,
	type ResolvedExpr,
	type ResolvedHead,
	type ResolvedMatch,
	type ResolvedQuery,
	type ResolvedRule,
	type ResolvedSource
} from "#compiler/check/params.ts"
import type { RecArm } from "#compiler/check/recursion/scan.ts"
import { entries, ruleLeaves } from "#compiler/check/scan.ts"
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { mapProducer } from "#compiler/ir/desc.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"

/** Parent variables replaced by the variables an arm reads them through. */
type Subst = ReadonlyMap<string, ResolvedExpr>

/** A channel: a parameter the factored step writes, which its import's bind map binds to a column. */
const channel = (cell: ParamCell): ResolvedExpr => ({
	kind: "param",
	type: { kind: "channel" },
	cell
})
const variable = (id: string): ResolvedExpr => ({ kind: "var", var: id })

const substExpr = (e: ResolvedExpr, s: Subst): ResolvedExpr => {
	const sub = (x: ResolvedExpr) => substExpr(x, s)
	switch (e.kind) {
		case "parent":
			return s.get(e.column) ?? e
		case "var":
		case "field":
		case "value":
		case "param":
		case "literal":
			return e
		case "compute":
			return { ...e, args: e.args.map(sub) }
		case "and":
		case "or":
			return { ...e, args: mapNonEmpty(e.args, sub) }
		case "cast":
		case "base":
		case "not":
		case "in":
			return { ...e, arg: sub(e.arg) }
		case "cond":
			return { ...e, pred: sub(e.pred), onTrue: sub(e.onTrue), onFalse: sub(e.onFalse) }
		case "when":
			return { ...e, subject: sub(e.subject), proved: sub(e.proved), otherwise: sub(e.otherwise) }
		case "compare":
		case "allen":
			return { ...e, left: sub(e.left), right: sub(e.right) }
		case "between":
			return { ...e, arg: sub(e.arg), low: sub(e.low), high: sub(e.high) }
		case "pointIn":
			return { ...e, point: sub(e.point), span: sub(e.span) }
		case "absent":
			return { ...e, source: substSource(e.source, s), bindings: substBindings(e.bindings, s) }
		case "closedAt":
			return { ...e, args: mapNonEmpty(e.args, sub) }
		case "closedRow":
			return { ...e, args: e.args.map(sub) }
	}
}

const substBindings = (b: ResolvedBindings, s: Subst): ResolvedBindings => {
	const out: Record<string, ResolvedExpr> = {}
	for (const [k, e] of entries(b)) {
		out[k] = substExpr(e, s)
	}
	return out
}

/** An imported query's bind map is read in the importing rule's scope; the query itself is its own scope. */
const substSource = (src: ResolvedSource, s: Subst): ResolvedSource =>
	src.kind === "query"
		? {
				...src,
				bind: Object.fromEntries(
					entries(src.bind).map(([k, b]) => [k, b.kind === "relationParam" ? b : substExpr(b, s)])
				)
			}
		: src

const substHead = (h: ResolvedHead, s: Subst): ResolvedHead => {
	if (h.kind === "aggregate") {
		return h.fn === "count" ? h : { ...h, arg: substExpr(h.arg, s) }
	}
	return h.kind === "producer" ? mapProducer(h, (a) => substExpr(a, s)) : substExpr(h, s)
}

/**
 * A counter column's value in a transition, as an exact integer: a step already is one, and a bare literal takes the
 * type the other arms deliver; any other value, a copy, a typed literal or data, is lifted into the exact integers by
 * adding 0 (a bigint for a bigint column, a number for a narrower one, as a literal of the column's type is), so every
 * arm delivers the column at one exact type and the step narrows it into the row once, by the recursion's counter
 * interval (state.ts).
 */
const exactHead = (h: ResolvedHead, column: ScalarType): ResolvedHead =>
	h.kind === "aggregate" ||
	h.kind === "producer" ||
	h.kind === "compute" ||
	(h.kind === "literal" && h.type === undefined)
		? h
		: {
				kind: "compute",
				fn: "add",
				args: [
					h,
					{ kind: "literal", value: baseOf(column).carrier === "int8" ? 0n : 0, type: undefined }
				]
			}

/**
 * The names a rule reads in its parameter scope: its scalar parameters, each bound to itself under its declared type,
 * its relation parameters and its parent variables, through its interiors, which share that scope.
 */
const scopeNames = (
	rule: ResolvedRule,
	into: { readonly params: Map<ParamCell, ResolvedBound>; readonly parents: Set<string> }
): void => {
	const leaves = ruleLeaves(rule, true)
	for (const p of leaves.params) {
		if (!into.params.has(p.cell)) {
			into.params.set(
				p.cell,
				p.kind === "param"
					? { kind: "param", type: p.type, cell: p.cell }
					: { kind: "relationParam", cell: p.cell }
			)
		}
	}
	for (const p of leaves.parents) {
		into.parents.add(p)
	}
	const source = (src: ResolvedSource) => {
		if ((src.kind === "param" || src.kind === "paramOf") && !into.params.has(src.cell)) {
			into.params.set(src.cell, { kind: "relationParam", cell: src.cell })
		}
	}
	for (const m of rule.matches) {
		source(m.source)
	}
	const absentSources = (e: ResolvedExpr): void => {
		if (e.kind === "absent") {
			source(e.source)
		} else if (e.kind === "and" || e.kind === "or") {
			for (const a of e.args) {
				absentSources(a)
			}
		}
	}
	for (const w of rule.where) {
		absentSources(w)
	}
	for (const interior of rule.interiors) {
		for (const arm of interior.arms) {
			scopeNames(arm, into)
		}
	}
}

/** A name built from `stem` that no name in `taken` already is; the chosen name is taken. */
const freshName = (stem: string, taken: Set<string>): string => {
	let name = stem
	for (let n = 2; taken.has(name); n++) {
		name = `${stem}_${n}`
	}
	taken.add(name)
	return name
}

/**
 * Factoring several linear transition arms into one feedback scan.
 *
 * PostgreSQL's recursive term reads the working table once. Several recursive arms that each read `self` once are a
 * union of transitions T₁(R) ∪ … ∪ Tₖ(R), and emitting one self-reference per UNION branch is not legal. Each Tᵢ is
 * linear, so it distributes over the states: Tᵢ(R) = ∪_{s ∈ R} Tᵢ({s}), and the union of the arms is one scan of the
 * feedback joined with the common typed transition relation of every arm, evaluated per state:
 *
 *   step = { o | s ∈ self, o ∈ (T₁ ∪ … ∪ Tₖ)(s) }
 *
 * The factored step is one rule over the description. It matches `self` once, binding every declared state column to
 * a fresh variable, and matches an imported query, the transition relation, whose arms are the original arms. That
 * import is bound (Q.bind) to the scanned state's columns, so it is correlated to the scan and lowers
 * LATERAL. Inside it, each arm's `self` match reads instead a one-row interior stage of the arm, the
 * current state, whose head delivers the bound state columns; the arm's bindings of that match, its other matches,
 * its filters and its head are unchanged, at their own locations, so every refusal inside an arm still names the arm
 * the author wrote. The import's other parameters are the importer's own, bound to themselves. An attachment's parent
 * variables, which an imported query cannot read, travel the same way: each is bound to a parameter under a fresh
 * name and delivered by the current-state interior, where the arm reads it through a fresh variable.
 *
 * The factored transition reads `self` exactly once, so feedback stays linear and monotone, and the state it delivers
 * is the union of what the arms deliver: the same fixed point.
 *
 * A counter column, whose step is an exact integer, is delivered by every transition as one (exactHead), so the
 * transitions' union has one type per column, as the union of any query's arms does.
 *
 * The one factored recursive rule over the arms that each read `self` once, located below the definition's `rec`
 * list. `row` is the declared state, in canonical order; `counters`, its counter columns with their declared types.
 */
export const factorArms = (
	arms: NonEmptyReadonlyArray<RecArm>,
	row: ReadonlyArray<string>,
	counters: ReadonlyMap<string, ScalarType>,
	at: SourceLoc
): ResolvedRule => {
	const outer = { params: new Map<ParamCell, ResolvedBound>(), parents: new Set<string>() }
	for (const arm of arms) {
		scopeNames(arm.rule, outer)
	}
	const params = new Set([...outer.params.keys()].map((p) => p.name))
	/**
	 * The parameter each state column and each parent variable is passed under, and the column of the current-state
	 * interior that delivers it.
	 */
	const stateParams = new Map(
		row.map((c) => [c, boundParam(freshName(`__self_${c}`, params))] as const)
	)
	const columns = new Set(row)
	const parents = [...outer.parents].toSorted(compareStrings).map((p) => ({
		parent: p,
		param: boundParam(freshName(`__parent_${p}`, params)),
		column: freshName(`__parent_${p}`, columns)
	}))
	const here = childLoc(at, "factored")
	const current: ResolvedRule = {
		vars: [],
		matches: [],
		where: [],
		head: Object.fromEntries([
			...[...stateParams].map(([c, p]) => [c, channel(p)] as const),
			...parents.map((p) => [p.column, channel(p.param)] as const)
		]),
		interiors: [],
		attach: [],
		loc: childLoc(here, "state")
	}

	const transitions = mapNonEmpty(arms, (arm): ResolvedRule => {
		const rule = arm.rule
		const self = arm.self.match
		const varIds = new Set(rule.vars.map((v) => v.id))
		const parentVars = parents.map((p) => ({
			...p,
			var: freshName(`__parent_${p.parent}`, varIds)
		}))
		const s: Subst = new Map(parentVars.map((p) => [p.parent, variable(p.var)] as const))
		const interior = freshName("__state", new Set(rule.interiors.map((i) => i.id)))
		const state: ResolvedMatch = {
			source: { kind: "interior", id: interior },
			bindings: {
				...substBindings(self.bindings, s),
				...Object.fromEntries(parentVars.map((p) => [p.column, variable(p.var)] as const))
			},
			loc: self.loc
		}
		return {
			vars: [
				...rule.vars,
				...parentVars.map((p) => ({ id: p.var, loc: arm.loc, origin: undefined }))
			],
			matches: rule.matches.map((m, i) =>
				i === arm.self.at
					? state
					: {
							source: substSource(m.source, s),
							bindings: substBindings(m.bindings, s),
							loc: m.loc
						}
			),
			where: rule.where.map((w) => substExpr(w, s)),
			head: Object.fromEntries(
				entries(rule.head).map(([k, h]) => {
					const head = substHead(h, s)
					const counter = counters.get(k)
					return [k, counter === undefined ? head : exactHead(head, counter)]
				})
			),
			interiors: [...rule.interiors, { id: interior, arms: [current] }],
			attach: [],
			loc: arm.loc
		}
	})

	/** The feedback scan binds every declared state column; the transitions read them through their parameters. */
	const varIds = new Set<string>()
	/** Each state column's scan variable, with the parameter the transitions read it through. */
	const scanVars = [...stateParams].map(
		([column, stateParam]) =>
			({ column, param: stateParam, var: freshName(`__state_${column}`, varIds) }) as const
	)
	const outputs = new Map(row.map((c) => [c, freshName(`__next_${c}`, varIds)] as const))
	const bind: Record<string, ResolvedBound> = {}
	for (const scanVar of scanVars) {
		bind[scanVar.param.name] = variable(scanVar.var)
	}
	for (const [p, bound] of outer.params) {
		bind[p.name] = bound
	}
	for (const p of parents) {
		bind[p.param.name] = { kind: "parent", column: p.parent }
	}
	const transition: ResolvedQuery = {
		stage: { kind: "rules", arms: transitions, loc: childLoc(here, "transitions") }
	}
	return {
		vars: [...scanVars.map((s) => s.var), ...outputs.values()].map((id) => ({
			id,
			loc: childLoc(here, id),
			origin: undefined
		})),
		matches: [
			{
				source: { kind: "self" },
				bindings: Object.fromEntries(scanVars.map((s) => [s.column, variable(s.var)])),
				loc: childLoc(here, "self")
			},
			{
				source: { kind: "query", query: transition, bind },
				bindings: Object.fromEntries([...outputs].map(([c, v]) => [c, variable(v)])),
				loc: childLoc(here, "transitions")
			}
		],
		where: [],
		head: Object.fromEntries([...outputs].map(([c, v]) => [c, variable(v)])),
		interiors: [],
		attach: [],
		loc: here
	}
}
