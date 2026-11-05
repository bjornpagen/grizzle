import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import {
	type AttachDesc,
	type BindingsDesc,
	type ExprDesc,
	type HeadTermDesc,
	type InteriorDesc,
	type MatchDesc,
	mapProducer,
	type QueryDesc,
	type QueryStageDesc,
	type RuleDesc,
	type SourceDesc,
	type VarDesc
} from "#compiler/ir/desc.ts"
import type { OwnedRole } from "#compiler/schema/own.ts"

/**
 * A program over a role, read over the role's base for planning.
 *
 * A role's world relation is a view over its base, and the indexes that serve a program reading it are the base
 * tables' indexes its definition reads through. inlineWorlds rewrites a query over a role so that each match of a world
 * relation imports its definition instead, a query source over the base, under the same bindings: the definition's
 * heading is the world relation's, so every binding names the same column. A whole entry is the base relation of its
 * name and stays. The access-path extraction (physical/access/extract.ts) then reads base relations only, so a program
 * over a role plans exactly the indexes its views' definitions need, and a world relation's own name, which may be a
 * base relation's, never reaches an index. A variable a world relation's field named is a fresh one over the base.
 *
 * `query`, over `role`, with every match of a world relation importing its definition.
 */
export const inlineWorlds = (query: QueryDesc, role: OwnedRole): QueryDesc => {
	const worlds = new Map<string, QueryDesc>(
		Object.values(role.relations).flatMap((e) =>
			e.kind === "world" ? [[e.name, e.query] as const] : []
		)
	)
	const source = (s: SourceDesc): SourceDesc => {
		switch (s.kind) {
			case "relation": {
				const definition = worlds.get(s.name)
				return definition === undefined ? s : { kind: "query", query: definition, bind: {} }
			}
			case "query":
				return {
					...s,
					query: inQuery(s.query),
					bind: Object.fromEntries(
						Object.entries(s.bind).map(([param, b]) => [
							param,
							b.kind === "relationParam" ? b : expr(b)
						])
					)
				}
			case "param":
			case "paramOf":
			case "interior":
			case "self":
			case "delta":
			case "context":
			case "row":
				return s
		}
	}
	const bindings = (b: BindingsDesc): BindingsDesc =>
		Object.fromEntries(Object.entries(b).map(([field, e]) => [field, expr(e)]))
	const expr = (e: ExprDesc): ExprDesc => {
		switch (e.kind) {
			case "absent":
				return { ...e, source: source(e.source), bindings: bindings(e.bindings) }
			case "cast":
			case "base":
			case "not":
				return { ...e, arg: expr(e.arg) }
			case "cond":
				return { ...e, pred: expr(e.pred), onTrue: expr(e.onTrue), onFalse: expr(e.onFalse) }
			case "when":
				return {
					...e,
					subject: expr(e.subject),
					proved: expr(e.proved),
					otherwise: expr(e.otherwise)
				}
			case "compare":
				return { ...e, left: expr(e.left), right: expr(e.right) }
			case "between":
				return { ...e, arg: expr(e.arg), low: expr(e.low), high: expr(e.high) }
			case "in":
				return { ...e, arg: expr(e.arg) }
			case "and":
			case "or":
				return { ...e, args: mapNonEmpty(e.args, expr) }
			case "allen":
				return { ...e, left: expr(e.left), right: expr(e.right) }
			case "pointIn":
				return { ...e, point: expr(e.point), span: expr(e.span) }
			case "compute":
				return { ...e, args: e.args.map(expr) }
			case "closedAt":
				return { ...e, args: mapNonEmpty(e.args, expr) }
			case "closedRow":
				return { ...e, args: e.args.map(expr) }
			case "var":
			case "field":
			case "value":
			case "parent":
			case "param":
			case "literal":
				return e
		}
	}
	const head = (t: HeadTermDesc): HeadTermDesc => {
		switch (t.kind) {
			case "aggregate":
				return t.fn === "count" ? t : { ...t, arg: expr(t.arg) }
			case "producer":
				return mapProducer(t, expr)
			case "absent":
			case "allen":
			case "and":
			case "base":
			case "between":
			case "cast":
			case "compare":
			case "compute":
			case "cond":
			case "when":
			case "field":
			case "in":
			case "literal":
			case "not":
			case "or":
			case "param":
			case "parent":
			case "pointIn":
			case "value":
			case "var":
			case "closedAt":
			case "closedRow":
				return expr(t)
		}
	}
	const variable = (v: VarDesc): VarDesc =>
		v.origin !== undefined && worlds.has(v.origin.relation) ? { ...v, origin: undefined } : v
	const match = (m: MatchDesc): MatchDesc => ({
		...m,
		source: source(m.source),
		bindings: bindings(m.bindings)
	})
	const interior = (i: InteriorDesc): InteriorDesc => ({ ...i, arms: mapNonEmpty(i.arms, rule) })
	const attach = (a: AttachDesc): AttachDesc => ({ ...a, child: inQuery(a.child) })
	const rule = (r: RuleDesc): RuleDesc => ({
		...r,
		vars: r.vars.map(variable),
		matches: r.matches.map(match),
		where: r.where.map(expr),
		head: Object.fromEntries(Object.entries(r.head).map(([field, t]) => [field, head(t)])),
		interiors: r.interiors.map(interior),
		attach: r.attach.map(attach)
	})
	const stage = (s: QueryStageDesc): QueryStageDesc => {
		switch (s.kind) {
			case "rules":
				return { ...s, arms: mapNonEmpty(s.arms, rule) }
			case "recursive":
				return {
					...s,
					recursive: {
						...s.recursive,
						base: mapNonEmpty(s.recursive.base, rule),
						rec: mapNonEmpty(s.recursive.rec, rule)
					}
				}
			case "union":
				return { ...s, input: stage(s.input), arms: mapNonEmpty(s.arms, rule) }
			case "attach":
				return { ...s, input: stage(s.input), attach: attach(s.attach) }
			case "named":
			case "order":
			case "take":
			case "approx":
				return { ...s, input: stage(s.input) }
		}
	}
	const inQuery = (q: QueryDesc): QueryDesc => ({ ...q, stage: stage(q.stage) })
	return inQuery(query)
}
