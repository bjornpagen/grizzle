import { Array as Arr } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import * as Result from "#compiler/core/result.ts"
import {
	type ConservativeProgram,
	type ConservativeStatement,
	traverseTree
} from "#compiler/lower/conservative/types.ts"
import type { Expr, FromItem, Select, SelectBody, SelectCore } from "#compiler/sql/ast.ts"
import { emit, unmetered } from "#compiler/sql/emit.ts"

/** The node each relation alias of a statement names. */
export const aliasOrigins = (statement: ConservativeStatement): ReadonlyMap<string, NodeId> => {
	const out = new Map<string, NodeId>()
	for (const entry of statement.sql.nameMap) {
		if (entry.role === "relation" && entry.origin.kind === "node") {
			out.set(entry.name, entry.origin.node)
		}
	}
	return out
}

export interface VisitContext {
	/** Beneath an EXISTS or NOT EXISTS subquery: an emptiness observation. */
	readonly underExists: boolean
}

/** A statement's own top level, beneath no EXISTS. */
export const topLevelContext: VisitContext = { underExists: false }

export interface Visitor {
	/** The query of a derived FROM item, its own derived items already visited; `node` is what its alias names. */
	readonly derived: (query: Select, node: NodeId | undefined, ctx: VisitContext) => Select
	/** Every core, after its FROM items and subqueries. */
	readonly core: (core: SelectCore, ctx: VisitContext) => SelectCore
}

/** The visitor that rewrites nothing, which a visitor of one part spreads. */
export const identityVisitor: Visitor = { derived: (query) => query, core: (core) => core }

const sameArray = <A>(a: ReadonlyArray<A>, b: ReadonlyArray<A>): boolean =>
	a.length === b.length && Arr.every(a, (x, i) => x === b[i])

const mapArray = <A>(items: ReadonlyArray<A>, f: (a: A) => A): ReadonlyArray<A> => {
	const out = Arr.map(items, f)
	return sameArray(out, items) ? items : out
}

class Rewriter {
	readonly origins: ReadonlyMap<string, NodeId>
	readonly visitor: Visitor

	constructor(origins: ReadonlyMap<string, NodeId>, visitor: Visitor) {
		this.origins = origins
		this.visitor = visitor
	}

	select(s: Select, ctx: VisitContext): Select {
		const ctes = s.with?.ctes
		const nextCtes =
			ctes === undefined
				? undefined
				: mapArray(ctes, (cte) => {
						if (cte.query.kind !== "select") {
							return cte
						}
						const q = this.select(cte.query, ctx)
						return q === cte.query ? cte : { ...cte, query: q }
					})
		const body = this.body(s.body, ctx)
		if (body === s.body && nextCtes === ctes) {
			return s
		}
		const out: Select = { ...s, body }
		return s.with === undefined || nextCtes === undefined
			? out
			: { ...out, with: { ...s.with, ctes: nextCtes } }
	}

	body(b: SelectBody, ctx: VisitContext): SelectBody {
		switch (b.kind) {
			case "core":
				return this.core(b, ctx)
			case "setOp": {
				const left = this.body(b.left, ctx)
				const right = this.body(b.right, ctx)
				return left === b.left && right === b.right ? b : { ...b, left, right }
			}
			case "select":
				return this.select(b, ctx)
		}
	}

	core(c: SelectCore, ctx: VisitContext): SelectCore {
		const from = mapArray(c.from, (f) => this.from(f, ctx))
		const where = c.where === undefined ? undefined : this.expr(c.where, ctx)
		const having = c.having === undefined ? undefined : this.expr(c.having, ctx)
		const targets = mapArray(c.targets, (t) => {
			const e = this.expr(t.expr, ctx)
			return e === t.expr ? t : { ...t, expr: e }
		})
		let next: SelectCore = c
		if (from !== c.from || where !== c.where || having !== c.having || targets !== c.targets) {
			next = { ...c, targets, from, where, having }
		}
		return this.visitor.core(next, ctx)
	}

	from(f: FromItem, ctx: VisitContext): FromItem {
		switch (f.kind) {
			case "derived": {
				const inner = this.select(f.query, ctx)
				const visited = this.visitor.derived(inner, this.origins.get(f.alias), ctx)
				return visited === f.query ? f : { ...f, query: visited }
			}
			case "join": {
				const left = this.from(f.left, ctx)
				const right = this.from(f.right, ctx)
				const on = this.expr(f.on, ctx)
				return left === f.left && right === f.right && on === f.on ? f : { ...f, left, right, on }
			}
			case "crossJoin": {
				const left = this.from(f.left, ctx)
				const right = this.from(f.right, ctx)
				return left === f.left && right === f.right ? f : { ...f, left, right }
			}
			case "cte":
			case "enclosing":
			case "function":
			case "recordset":
			case "table":
			case "values":
			case "context":
				return f
		}
	}

	expr(e: Expr, ctx: VisitContext): Expr {
		switch (e.kind) {
			case "exists": {
				const q = this.select(e.query, { ...ctx, underExists: true })
				return q === e.query ? e : { ...e, query: q }
			}
			case "subquery":
			case "array":
			case "inQuery": {
				const q = this.select(e.query, ctx)
				return q === e.query ? e : { ...e, query: q }
			}
			case "binary": {
				const left = this.expr(e.left, ctx)
				const right = this.expr(e.right, ctx)
				return left === e.left && right === e.right ? e : { ...e, left, right }
			}
			case "and":
			case "or": {
				const args = mapArray(e.args, (a) => this.expr(a, ctx))
				return args === e.args ? e : { ...e, args }
			}
			case "not":
			case "negate":
			case "isTrue":
			case "cast": {
				const inner = this.expr(e.expr, ctx)
				return inner === e.expr ? e : { ...e, expr: inner }
			}
			case "between":
			case "call":
			case "case":
			case "collate":
			case "column":
			case "domainValue":
			case "excluded":
			case "field":
			case "greatest":
			case "inList":
			case "least":
			case "literal":
			case "mergeAction":
			case "param":
			case "plSpecial":
			case "plVar":
			case "returning":
			case "row":
			case "user":
				return e
		}
	}
}

/** A statement with `visitor` applied bottom-up; the same object when nothing changed. */
export const rewriteSelect = (
	select: Select,
	origins: ReadonlyMap<string, NodeId>,
	visitor: Visitor,
	ctx: VisitContext
): Select => new Rewriter(origins, visitor).select(select, ctx)

/** A query whose body is a DISTINCT core, with the DISTINCT removed; undefined when it has none to remove. */
export const withoutDistinct = (query: Select): Select | undefined => {
	if (query.body.kind !== "core" || query.body.distinct !== true) {
		return undefined
	}
	return { ...query, body: { ...query.body, distinct: false } }
}

/** The conjuncts of a WHERE: the operands of a top-level AND, or the condition itself. */
export const conjuncts = (where: Expr | undefined): ReadonlyArray<Expr> =>
	where === undefined ? [] : where.kind === "and" ? where.args : [where]

/** Whether an expression reads a column of `alias`, at any depth, subqueries included. */
export const readsAlias = (e: Expr, alias: string): boolean => {
	switch (e.kind) {
		case "column":
			return e.table === alias
		case "binary":
			return readsAlias(e.left, alias) || readsAlias(e.right, alias)
		case "and":
		case "or":
		case "greatest":
		case "least":
			return Arr.some(e.args, (a) => readsAlias(a, alias))
		case "call":
			return (
				Arr.some(e.args, (a) => readsAlias(a, alias)) ||
				(e.star && e.filter !== undefined && readsAlias(e.filter, alias))
			)
		case "not":
		case "negate":
		case "isTrue":
		case "cast":
		case "collate":
			return readsAlias(e.expr, alias)
		case "between":
			return readsAlias(e.expr, alias) || readsAlias(e.low, alias) || readsAlias(e.high, alias)
		case "inList":
			return readsAlias(e.expr, alias) || Arr.some(e.list, (a) => readsAlias(a, alias))
		case "inQuery":
			return readsAlias(e.expr, alias) || selectReads(e.query, alias)
		case "exists":
		case "subquery":
		case "array":
			return selectReads(e.query, alias)
		case "row":
			return Arr.some(e.items, (a) => readsAlias(a, alias))
		case "case":
			return (
				(e.operand !== undefined && readsAlias(e.operand, alias)) ||
				readsAlias(e.else, alias) ||
				Arr.some(e.whens, (w) => readsAlias(w.when, alias) || readsAlias(w.result, alias))
			)
		case "domainValue":
		case "excluded":
		case "field":
		case "literal":
		case "mergeAction":
		case "param":
		case "plSpecial":
		case "plVar":
		case "returning":
		case "user":
			return false
	}
}

const fromReads = (f: FromItem, alias: string): boolean => {
	switch (f.kind) {
		case "derived":
			return selectReads(f.query, alias)
		case "function":
			return Arr.some(f.call.args, (a) => readsAlias(a, alias))
		case "recordset":
		case "context":
			return false
		case "values":
			return Arr.some(f.rows, (row) => Arr.some(row, (a) => readsAlias(a, alias)))
		case "join":
			return fromReads(f.left, alias) || fromReads(f.right, alias) || readsAlias(f.on, alias)
		case "crossJoin":
			return fromReads(f.left, alias) || fromReads(f.right, alias)
		case "cte":
		case "enclosing":
		case "table":
			return false
	}
}

const bodyReads = (b: SelectBody, alias: string): boolean => {
	switch (b.kind) {
		case "core":
			return (
				Arr.some(b.targets, (t) => readsAlias(t.expr, alias)) ||
				Arr.some(b.from, (f) => fromReads(f, alias)) ||
				(b.where !== undefined && readsAlias(b.where, alias)) ||
				Arr.some(b.groupBy, (g) => readsAlias(g, alias)) ||
				(b.having !== undefined && readsAlias(b.having, alias))
			)
		case "setOp":
			return bodyReads(b.left, alias) || bodyReads(b.right, alias)
		case "select":
			return selectReads(b, alias)
	}
}

/** Whether a query reads a column of `alias` anywhere: an outer reference when the alias is not its own. */
const selectReads = (s: Select, alias: string): boolean =>
	bodyReads(s.body, alias) ||
	Arr.some(s.with?.ctes ?? [], (c) => c.query.kind === "select" && selectReads(c.query, alias)) ||
	Arr.some(s.orderBy, (o) => readsAlias(o.expr, alias))

/**
 * Post-processing the conservative lowering's SQL AST: mutants are AST post-processors over conservative output.
 *
 * A mutant rewrites the statements the conservative lowering emitted, never the lowering itself, so the harness proves
 * that it catches a wrong rewrite of real output. Two facts of the conservative output make that precise:
 *
 * - every node is lowered to one query, and every consumer reads it as a derived table whose fresh alias the
 *   statement's name map attributes to the node (types.ts, sql/naming.ts): the query of a derived FROM item whose alias
 *   names node n is n's lowering. A Group's lowering contains one more derived table attributed to the Group, its
 *   contributions, which is a DISTINCT core without GROUP BY;
 * - the AST is plain immutable data, so a rewrite rebuilds the spine it changes and keeps everything else by
 *   reference, and an unchanged statement is the same object.
 *
 * rewriteSelect walks a statement bottom-up, visiting the query of every derived FROM item with the node its alias
 * names and whether it lies beneath an EXISTS. A mutated statement is emitted again through the statement and text
 * audits (sql/emit.ts), with its name map and placeholders unchanged: a mutant changes which rows a statement returns,
 * never how the runner fills it.
 *
 * Applies a statement rewrite to every statement of a program and emits each changed one again.
 */
export const rewriteProgram = (
	program: ConservativeProgram,
	rewrite: (statement: ConservativeStatement) => Select
): Result.Result<ConservativeProgram, CompileError> => {
	const rewritten = (
		statement: ConservativeStatement
	): Result.Result<ConservativeStatement, CompileError> => {
		const ast = rewrite(statement)
		if (ast === statement.ast) {
			return Result.ok(statement)
		}
		return Result.map(emit(ast, statement.sql.nameMap, unmetered), (sql) => ({
			...statement,
			ast,
			sql
		}))
	}
	return Result.map(traverseTree(program.roots, rewritten), (roots): ConservativeProgram => ({
		roots,
		delivery: program.delivery
	}))
}
