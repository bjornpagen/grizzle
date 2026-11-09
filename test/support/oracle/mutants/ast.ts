import { Array as Arr } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import * as Result from "#compiler/core/result.ts"
import {
	type ConservativeProgram,
	type ConservativeStatement
} from "#compiler/lower/conservative/types.ts"
import { traverseTree } from "#compiler/runtime/lower/tree.ts"
import type {
	CoreProjection,
	Expr,
	FromItem,
	FromSource,
	JoinStep,
	OperandBody,
	OperandSelect,
	Select,
	SelectCore,
	SetOperand,
	SetOperation,
	Target
} from "#compiler/sql/ast.ts"
import { setQueryOf, withArms } from "#compiler/sql/build.ts"
import { emit } from "#compiler/sql/emit.ts"

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
	readonly derived: (
		query: OperandSelect,
		node: NodeId | undefined,
		ctx: VisitContext
	) => OperandSelect
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

const mapNonEmptyArray = <A>(
	items: Arr.NonEmptyReadonlyArray<A>,
	f: (a: A) => A
): Arr.NonEmptyReadonlyArray<A> => {
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

	select(s: OperandSelect, ctx: VisitContext): OperandSelect {
		const ctes = s.with?.ctes
		const nextCtes =
			ctes === undefined
				? undefined
				: mapNonEmptyArray(ctes, (cte) => {
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
		const out: OperandSelect = { ...s, body }
		return s.with === undefined || nextCtes === undefined
			? out
			: { ...out, with: { ...s.with, ctes: nextCtes } }
	}

	body(b: OperandBody, ctx: VisitContext): OperandBody {
		switch (b.kind) {
			case "core":
				return this.core(b, ctx)
			case "setOp": {
				const [first, second, ...rest] = b.arms
				const arms: SetOperation["arms"] = [
					this.operand(first, ctx),
					this.operand(second, ctx),
					...Arr.map(rest, (arm) => this.operand(arm, ctx))
				]
				return sameArray(arms, b.arms) ? b : withArms(b, arms)
			}
			case "select":
				return this.select(b, ctx)
		}
	}

	operand(o: SetOperand, ctx: VisitContext): SetOperand {
		return o.kind === "core" ? this.core(o, ctx) : this.select(o, ctx)
	}

	core(c: SelectCore, ctx: VisitContext): SelectCore {
		const from = mapArray(c.from, (f) => this.from(f, ctx))
		const where = c.where === undefined ? undefined : this.expr(c.where, ctx)
		const having = c.having === undefined ? undefined : this.expr(c.having, ctx)
		const target = (t: Target): Target => {
			const e = this.expr(t.expr, ctx)
			return e === t.expr ? t : { ...t, expr: e }
		}
		const projection: CoreProjection =
			c.distinct !== false
				? { distinct: c.distinct, targets: mapNonEmptyArray(c.targets, target) }
				: c.rows === "operand"
					? { distinct: false, rows: c.rows, targets: mapArray(c.targets, target) }
					: { distinct: false, rows: c.rows, targets: mapArray(c.targets, target) }
		let next: SelectCore = c
		if (
			from !== c.from ||
			where !== c.where ||
			having !== c.having ||
			projection.targets !== c.targets
		) {
			next = { kind: "core", from, where, groupBy: c.groupBy, having, ...projection }
		}
		return this.visitor.core(next, ctx)
	}

	from(f: FromItem, ctx: VisitContext): FromItem {
		if (f.kind !== "joins") {
			return this.source(f, ctx)
		}
		const first = this.source(f.first, ctx)
		const steps = mapNonEmptyArray(f.steps, (step): JoinStep => {
			const source = this.source(step.source, ctx)
			if (step.kind === "cross") {
				return source === step.source ? step : { ...step, source }
			}
			const on = this.expr(step.on, ctx)
			return source === step.source && on === step.on ? step : { ...step, source, on }
		})
		return first === f.first && steps === f.steps ? f : { ...f, first, steps }
	}

	source(f: FromSource, ctx: VisitContext): FromSource {
		switch (f.kind) {
			case "derived": {
				const inner = this.select(f.query, ctx)
				const visited = this.visitor.derived(inner, this.origins.get(f.alias), ctx)
				return visited === f.query ? f : { ...f, query: visited }
			}
			case "cte":
			case "enclosing":
			case "function":
			case "arrays":
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
			case "inQuery": {
				const q = this.select(e.query, ctx)
				return q === e.query ? e : { ...e, query: q }
			}
			case "array": {
				const q = this.select(e.query, ctx)
				return q === e.query
					? e
					: { ...e, query: setQueryOf(q, "a mutant's rewrite of an ARRAY query") }
			}
			case "binary": {
				const left = this.expr(e.left, ctx)
				const right = this.expr(e.right, ctx)
				return left === e.left && right === e.right ? e : { ...e, left, right }
			}
			case "and":
			case "or": {
				const args = mapNonEmptyArray(e.args, (a) => this.expr(a, ctx))
				return args === e.args ? e : { ...e, args }
			}
			case "not":
			case "negate":
			case "isTrue":
			case "complement":
			case "cast": {
				const inner = this.expr(e.expr, ctx)
				return inner === e.expr ? e : { ...e, expr: inner }
			}
			case "nullif": {
				const inner = this.expr(e.expr, ctx)
				const absent = this.expr(e.absent, ctx)
				return inner === e.expr && absent === e.absent ? e : { ...e, expr: inner, absent }
			}
			case "subscript": {
				const array = this.expr(e.array, ctx)
				const index = this.expr(e.index, ctx)
				return array === e.array && index === e.index ? e : { ...e, array, index }
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
			case "coalesce":
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
			case "regclass":
				return e
		}
	}
}

/**
 * A statement with `visitor` applied bottom-up; the same object when nothing changed. A statement's rows are a set, so a
 * visitor that leaves them a plain operand is a defect of the visitor: a mutant claims a proof its rows lack instead.
 */
export const rewriteSelect = (
	select: Select,
	origins: ReadonlyMap<string, NodeId>,
	visitor: Visitor,
	ctx: VisitContext
): Select =>
	setQueryOf(
		new Rewriter(origins, visitor).select(select, ctx),
		"a mutant's rewrite of a statement"
	)

/** A query that stands as an operand, a CTE's or a derived table's, with `visitor` applied bottom-up (rewriteSelect). */
export const rewriteOperand = (
	select: OperandSelect,
	origins: ReadonlyMap<string, NodeId>,
	visitor: Visitor,
	ctx: VisitContext
): OperandSelect => new Rewriter(origins, visitor).select(select, ctx)

/**
 * A query whose body is a DISTINCT core, with the DISTINCT removed under a multiplicity certificate the analysis never
 * issued, the claim a wrong certificate makes; undefined when it has no DISTINCT to remove.
 */
export const withoutDistinct = (query: OperandSelect): OperandSelect | undefined => {
	if (query.body.kind !== "core" || query.body.distinct !== true) {
		return undefined
	}
	return { ...query, body: { ...query.body, distinct: false, rows: "certified" } }
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
		case "coalesce":
			return Arr.some(e.args, (a) => readsAlias(a, alias))
		case "call":
			return (
				Arr.some(e.args, (a) => readsAlias(a, alias)) ||
				(e.star && e.filter !== undefined && readsAlias(e.filter, alias))
			)
		case "not":
		case "negate":
		case "isTrue":
		case "complement":
		case "cast":
		case "collate":
			return readsAlias(e.expr, alias)
		case "nullif":
			return readsAlias(e.expr, alias) || readsAlias(e.absent, alias)
		case "subscript":
			return readsAlias(e.array, alias) || readsAlias(e.index, alias)
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
		case "regclass":
			return false
	}
}

const fromReads = (f: FromItem, alias: string): boolean => {
	switch (f.kind) {
		case "derived":
			return selectReads(f.query, alias)
		case "function":
			return Arr.some(f.call.args, (a) => readsAlias(a, alias))
		case "arrays":
		case "context":
			return false
		case "values":
			return Arr.some(f.rows, (row) => Arr.some(row, (a) => readsAlias(a, alias)))
		case "joins":
			return (
				fromReads(f.first, alias) ||
				Arr.some(
					f.steps,
					(step) =>
						fromReads(step.source, alias) || (step.kind === "on" && readsAlias(step.on, alias))
				)
			)
		case "cte":
		case "enclosing":
		case "table":
			return false
	}
}

const bodyReads = (b: OperandBody, alias: string): boolean => {
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
			return Arr.some(b.arms, (arm) => bodyReads(arm, alias))
		case "select":
			return selectReads(b, alias)
	}
}

/** Whether a query reads a column of `alias` anywhere: an outer reference when the alias is not its own. */
const selectReads = (s: OperandSelect, alias: string): boolean =>
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
 *   names node n is n's lowering;
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
		return Result.map(emit(ast, statement.sql.nameMap), (sql) => ({
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
