import { Array as Arr, Formatter } from "effect"
import { canonicalTag } from "#compiler/core/canonical.ts"
import { type NodeScope, nodeScopes, postorder, topoOrder } from "#compiler/ir/dag.ts"
import { decimalPayload } from "#compiler/ir/decimal.ts"
import { describeOp, exprClosure, type ScalarExpr, type TypedLiteral } from "#compiler/ir/expr.ts"
import { claimedColumns } from "#compiler/ir/keys.ts"
import {
	type CompletedOrder,
	exprsOf,
	type FrameBound,
	type Heading,
	type RelDag,
	type RelNode,
	type TakeBound
} from "#compiler/ir/rel.ts"
import { type ScalarType, typeLabel } from "#compiler/ir/scalar.ts"
import { defined } from "#test/support/assert.ts"

const bigintText = (n: bigint): string => n.toString()

export const printLiteral = (literal: TypedLiteral, type: ScalarType): string => {
	const label = typeLabel(type)
	switch (literal.kind) {
		case "int":
			return `${bigintText(literal.value)}::${label}`
		case "numeric":
			return `${decimalPayload(literal.value)}::${label}`
		case "float":
			return `${String(literal.value)}::${label}`
		case "floatSpecial":
			return `'${literal.value}'::${label}`
		case "money":
			return `${literal.value[canonicalTag]().payload} minor::${label}`
		case "bool":
			return `${literal.value}::${label}`
		case "text":
			return `${Formatter.format(literal.value)}::${label}`
		case "uuid":
			return `'${literal.value}'::${label}`
		case "enum":
			return `'${literal.handle}'::${label}`
		case "span":
			return `[${bigintText(literal.start)},${bigintText(literal.end)})::${label}`
		case "vector":
			return `${literal.value[canonicalTag]().payload}::${label}`
	}
}

/**
 * Expression printing, in one O(V + E) traversal. An expression with arguments that has more than one use
 * in what is printed is shared: each use prints its id, and its definition prints once on its own line, `e3 =
 * (int8pl e1 e2)`. Every other expression is inlined at its single use, and a leaf (a column, parameter or literal)
 * inlines at every use, so the text is linear in the DAG's size however much it shares. Every term is rendered once,
 * when the printer is made, in an iterative postorder (dag.ts postorder), so a deep expression cannot overflow the stack.
 */
class ExprPrinter {
	readonly #shared = new Set<ScalarExpr>()
	/** The term of every expression the uses reach, each rendered after its arguments'. */
	readonly #terms: ReadonlyMap<ScalarExpr, string>

	/** `uses` lists every reference to an expression from what is printed: the nodes' and the starting points'. */
	constructor(uses: ReadonlyArray<ScalarExpr>) {
		const count = new Map<ScalarExpr, number>()
		const bump = (e: ScalarExpr) => count.set(e, (count.get(e) ?? 0) + 1)
		for (const e of uses) {
			bump(e)
		}
		for (const e of exprClosure(uses)) {
			for (const a of e.args) {
				bump(a)
			}
		}
		for (const [e, n] of count) {
			if (n > 1 && e.args.length > 0) {
				this.#shared.add(e)
			}
		}
		const terms = new Map<ScalarExpr, string>()
		this.#terms = terms
		for (const e of postorder(uses, (x) => x.args)) {
			terms.set(e, this.#render(e))
		}
	}

	/** How a use of `e` prints: the label of a shared expression, otherwise its term. */
	ref(e: ScalarExpr): string {
		return this.#shared.has(e) ? e.id : this.term(e)
	}

	/** The term of `root` itself, its arguments printed as uses. */
	term(root: ScalarExpr): string {
		return defined(this.#terms.get(root), "a term of an expression the uses reach")
	}

	/** The shared expressions the uses `roots` need defined, arguments first, each once over the printer's life. */
	readonly #defined = new Set<ScalarExpr>()
	definitions(roots: ReadonlyArray<ScalarExpr>): ReadonlyArray<string> {
		const lines: Array<string> = []
		const stack: Array<{ expr: ScalarExpr; next: number }> = []
		const enter = (e: ScalarExpr) => {
			if (this.#defined.has(e)) {
				return
			}
			this.#defined.add(e)
			stack.push({ expr: e, next: 0 })
		}
		for (const root of roots) {
			enter(root)
			for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
				const args: ReadonlyArray<ScalarExpr> = frame.expr.args
				const a = args[frame.next]
				if (a !== undefined) {
					enter(a)
					frame.next++
					continue
				}
				stack.pop()
				if (!this.#shared.has(frame.expr)) {
					continue
				}
				lines.push(`${frame.expr.id} = ${this.term(frame.expr)}`)
			}
		}
		return lines
	}

	#render(expr: ScalarExpr): string {
		const args = Arr.map(expr.args, (a) => this.ref(a))
		switch (expr.kind) {
			case "column":
				return `${expr.column.node}.${expr.column.name}`
			case "value":
				return "VALUE"
			case "param":
				return `$${expr.param}::${typeLabel(expr.type)}${expr.role === "compare" ? "" : `[${expr.role}]`}`
			case "literal":
				return printLiteral(expr.value, expr.type)
			case "op":
				return `(${describeOp(expr.op)}${Arr.join(
					Arr.map(args, (a) => ` ${a}`),
					""
				)})`
			case "cast":
				return `(${
					"proof" in expr
						? `${Arr.join(
								Arr.map(expr.proof, (p) => p.precondition.kind),
								" "
							)} `
						: ""
				}cast ${args[0]} ${typeLabel(expr.type)})`
			case "domainCast":
				return `(domain ${args[0]} ${typeLabel(expr.type)})`
			case "cond":
				return `(case ${args[0]} ${args[1]} else ${args[2]})`
		}
	}
}

const printHeading = (heading: Heading): string =>
	`(${Arr.join(
		Arr.map(heading, (c) => `${c.name} ${typeLabel(c.type)}`),
		", "
	)})`

const printOrder = (order: CompletedOrder): string =>
	`[${Arr.join(
		Arr.map(order.keys, (k) => `${k.column} ${k.dir}`),
		", "
	)}]`

const printBound = (bound: TakeBound): string =>
	bound.kind === "literal" ? bigintText(bound.k) : `$${bound.param}`

const list = (items: ReadonlyArray<string>): string => `[${Arr.join(items, ", ")}]`

const printFrameBound = (b: FrameBound): string =>
	typeof b === "string"
		? b
		: "preceding" in b
			? `${bigintText(b.preceding)} preceding`
			: `${bigintText(b.following)} following`

const printBody = (n: RelNode, printer: ExprPrinter): string => {
	const e = (x: ScalarExpr) => printer.ref(x)
	switch (n.kind) {
		case "Base":
			return `Base ${n.relation} as ${n.occurrence} pk${list(n.primaryKey)}${Arr.join(
				Arr.map(n.keys, (k) => ` key${list(k)}`),
				""
			)}${n.relationKind === "relation" ? "" : ` ${n.relationKind}`}`
		case "Closed":
			return `Closed ${n.closed} rows=${n.rows.length}`
		case "Context":
			return `Context ${n.context}`
		case "InputSet":
			switch (n.input.kind) {
				case "declared":
					return `InputSet $${n.input.param}`
				case "member":
					return `InputSet member $${n.input.slot} of ${n.input.relation}`
				case "row":
					return "InputSet row"
			}
		case "Delta":
			return `Delta ${n.side}(${n.relation})`
		case "MatchRegion": {
			const occ = Arr.map(n.occurrences, (o) => {
				const binds = [
					...Arr.map(o.bindings, (b) => `${b.column}=${b.var.id}`),
					...Arr.map(o.constants, (c) => `${c.column}=${e(c.expr)}`)
				]
				return `${o.id}:${o.source.id}{${Arr.join(binds, ", ")}}`
			})
			const eqs = Arr.map(n.equalities, (q) => `${q.a.id}=${q.b.id}`)
			const corr = Arr.map(n.correlated, (c) => `${c.var.id}=${e(c.expr)}`)
			return `MatchRegion ${n.scope} vars${list(Arr.map(n.vars, (v) => `${v.id} ${v.name}`))} ${Arr.join(occ, " ")}${eqs.length > 0 ? ` eq${list(eqs)}` : ""}${corr.length > 0 ? ` corr${list(corr)}` : ""}`
		}
		case "Filter":
			return `Filter ${n.input.id} where ${e(n.pred)}`
		case "ProjectSet":
			return `ProjectSet ${n.input.id} ${list(Arr.map(n.out, (o) => `${o.name}=${e(o.expr)}`))}`
		case "SemiJoin":
		case "AntiJoin":
			return `${n.kind} ${n.left.id} ${n.right.id} on${list(Arr.map(n.on, (p) => `${p.left}=${p.right}`))}`
		case "Union":
			return `Union ${Arr.join(
				Arr.map(
					n.groups,
					(g) =>
						`{${Arr.join(
							Arr.map(g.arms, (a) => a.id),
							" "
						)}}`
				),
				" "
			)}${n.discriminant.length > 0 ? ` by${list(n.discriminant)}` : ""}`
		case "Intersect":
		case "Difference":
			return `${n.kind} ${n.left.id} ${n.right.id}`
		case "Take":
			return `Take ${n.input.id} ${printBound(n.bound)} by ${printOrder(n.order)}${n.correlation.length > 0 ? ` per${list(Arr.map(n.correlation, (c) => `${c.column}=${e(c.expr)}`))}` : ""}`
		case "Group":
			return `Group ${n.input.id} bound${list(n.bound)} keys${list(n.keys)} ${list(Arr.map(n.aggs, (a) => `${a.name}=${a.op}(${a.args.length === 0 ? "*" : Arr.join(Arr.map(a.args, e), ", ")})${a.filter === undefined ? "" : ` filter ${e(a.filter)}`}`))}`
		case "Produce":
			return `Produce ${n.input.id} ${n.producer}(${Arr.join(Arr.map(n.args, e), ", ")}) as ${n.out} carry${list(n.carried)}`
		case "Recursive":
			return `Recursive ${n.name} base=${n.base.id} step=${n.step.id} self=${n.self.id}${n.origin.length === 0 ? "" : ` origin${list(n.origin)}`} terminates ${n.termination.kind} <=${bigintText(n.termination.stateEstimate)}`
		case "SelfRef":
			return `SelfRef -> ${n.recursive}`
		case "ApproximateNearest":
			return `ApproximateNearest ${n.source.id} by ${n.score} take ${bigintText(n.take)} sealed`
		case "OrderedResult":
			return `OrderedResult ${n.input.id} ${printOrder(n.order)}`
		case "Attach":
			return `Attach ${n.parent.id} ${n.name}=${n.child.id} ${n.delivered} on${list(Arr.map(n.correlation, (c) => `${c.parent}=${c.child}`))}${n.order === undefined ? "" : ` ${printOrder(n.order)}`}`
		case "Forbid":
			return `Forbid ${n.lawId} ${n.violation.id}`
		case "Window":
			return `Window ${n.input.id} ${n.out}=${n.fn}/${n.op}(${Arr.join(Arr.map(n.args, e), ", ")})${n.filter === undefined ? "" : ` filter ${e(n.filter)}`} over${list(n.partition)} ${printOrder(n.order)}${n.frame === undefined ? "" : ` rows ${printFrameBound(n.frame.start)}..${printFrameBound(n.frame.end)}`} by ${n.rule}`
		case "OrderedSetAggregate":
			return `OrderedSetAggregate ${n.input.id} ${list(n.outs)}=${n.fn}/${n.op}(${Arr.join(Arr.map(n.fractions, e), ", ")}) keys${list(n.keys)} ${printOrder(n.order)} by ${n.rule}`
	}
}

const printMeta = (n: RelNode, scope: NodeScope): string => {
	const m = n.meta
	const parts: Array<string> = [m.card]
	if (m.logicalKeys.length > 0) {
		parts.push(
			`keys${Arr.join(
				Arr.map(m.logicalKeys, (k) => list(claimedColumns(k))),
				""
			)}`
		)
	}
	if (m.paramDeps.length > 0) {
		parts.push(`params${list(m.paramDeps)}`)
	}
	if (m.reads.length > 0) {
		parts.push(`reads${list(m.reads)}`)
	}
	if (scope.freeVars.length > 0) {
		parts.push(`free${list(scope.freeVars)}`)
	}
	return Arr.join(parts, " ")
}

const nodeLine = (n: RelNode, printer: ExprPrinter, scope: NodeScope): string =>
	`${n.id} = ${printBody(n, printer)} :: ${printHeading(n.heading)} {${printMeta(n, scope)}}`

/**
 * A deterministic text rendering of the IR, for the printable form of a generated case (print.ts).
 *
 * One line per reachable node in topological order, inputs first, then the roots. Expressions print as prefix terms,
 * `(int8pl n1.amount 1::bigint)`, inlined at a single use and defined once by id when shared. The rendering is a
 * function of the DAG's content only, so equal DAGs print identically; it is not SQL and is never emitted.
 *
 * The whole DAG: one line per node in topological order, inputs first, each shared expression defined on its own line
 * before the first node that uses it, then the roots. A node's free variables are its scope's (ir/dag.ts nodeScopes).
 */
export const printDag = (dag: RelDag): string => {
	const nodes = topoOrder(dag)
	const scopes = nodeScopes(dag)
	const printer = new ExprPrinter(Arr.flatMap(nodes, (n) => exprsOf(n)))
	const lines = Arr.flatMap(nodes, (n) => [
		...printer.definitions(exprsOf(n)),
		nodeLine(n, printer, scopes.of(n))
	])
	return Arr.join([...lines, `roots ${list(Arr.map(dag.roots, (root) => root.id))}`], "\n")
}
