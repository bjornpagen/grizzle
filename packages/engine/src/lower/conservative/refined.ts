import { guarantees } from "#compiler/check/refinement/index.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { Heading, HeadingColumn } from "#compiler/ir/rel.ts"
import { isRefined, type ScalarType } from "#compiler/ir/scalar.ts"
import { type LowerContext, refuse } from "#compiler/lower/conservative/context.ts"
import type { ScalarParamSlot } from "#compiler/lower/conservative/types.ts"
import type {
	Cte,
	Expr,
	FromItem,
	FromSource,
	ObjectName,
	Select,
	SelectBody,
	SelectCore,
	SetOperand,
	Target,
	TypeRef,
	With
} from "#compiler/sql/ast.ts"
import { cast, mapTargets, sameTypeRef } from "#compiler/sql/build.ts"
import { identityHooks, transformSelect } from "#compiler/sql/transform.ts"

type Verdict = "proved" | "unproved"

/**
 * The FROM items one SELECT core reads, by alias, and the scope it is nested in: the WITH lists in force, the CTE
 * columns whose definitions are being traced around it (a recursive CTE's step reads itself), and the enclosing core,
 * for a LATERAL or correlated reference, or undefined at the outermost core.
 */
export interface Scope {
	readonly items: ReadonlyMap<string, FromSource>
	readonly ctes: ReadonlyArray<With>
	readonly active: ReadonlySet<string>
	readonly outer: Scope | undefined
}

export const emptyScope: Scope = { items: new Map(), ctes: [], active: new Set(), outer: undefined }

const collectItems = (items: ReadonlyArray<FromItem>, into: Map<string, FromSource>): void => {
	for (const item of items) {
		switch (item.kind) {
			case "joins":
				collectItems([item.first, ...item.steps.map((step) => step.source)], into)
				continue
			case "cte":
				into.set(item.alias ?? item.name, item)
				continue
			case "table":
			case "enclosing":
			case "derived":
			case "function":
			case "recordset":
			case "values":
			case "context":
				into.set(item.alias, item)
				continue
		}
	}
}

export const coreScope = (core: SelectCore, enclosing: Scope): Scope => {
	const items = new Map<string, FromSource>()
	collectItems(core.from, items)
	return { items, ctes: enclosing.ctes, active: enclosing.active, outer: enclosing }
}

export const withScope = (select: Select, enclosing: Scope): Scope =>
	select.with === undefined ? enclosing : { ...enclosing, ctes: [select.with, ...enclosing.ctes] }

/** The key of an installed table's column: its schema, table and column, three identifiers, never one text. */
const storedKey = (table: ObjectName, column: string): string =>
	`${table.schema}\u0000${table.name}\u0000${column}`

/** Whether `type` is the claim's domain: never, when the installation names none. */
const isDomain = (type: TypeRef, claim: Claim): boolean =>
	claim.domain !== undefined && sameTypeRef(type, claim.domain)

/** What one refined delivered column is traced against. */
interface Claim {
	readonly type: ScalarType
	/** The domain's type, or undefined when the installation names none. */
	readonly domain: TypeRef | undefined
	readonly base: TypeRef
}

export class Tracer {
	readonly #stored: ReadonlyMap<string, ScalarType>

	constructor(stored: ReadonlyMap<string, ScalarType>) {
		this.#stored = stored
	}

	/** The verdicts of the values output position `position` of `select` delivers. */
	select(select: Select, position: number, scope: Scope, claim: Claim): ReadonlyArray<Verdict> {
		return this.body(select.body, position, withScope(select, scope), claim)
	}

	body(body: SelectBody, position: number, scope: Scope, claim: Claim): ReadonlyArray<Verdict> {
		switch (body.kind) {
			case "core": {
				const t = body.targets[position]
				return t === undefined ? ["unproved"] : this.expr(t.expr, coreScope(body, scope), claim)
			}
			case "setOp":
				return body.arms.flatMap((arm) => this.body(arm, position, scope, claim))
			case "select":
				return this.select(body, position, scope, claim)
		}
	}

	/** A cast to the base type relabels a value of the domain without changing it. */
	expr(e: Expr, scope: Scope, claim: Claim): ReadonlyArray<Verdict> {
		switch (e.kind) {
			case "param":
				return [isDomain(e.type, claim) ? "proved" : "unproved"]
			case "literal":
				return [isDomain(e.type, claim) ? "proved" : "unproved"]
			case "cast":
				if (isDomain(e.type, claim)) {
					return ["proved"]
				}
				return sameTypeRef(e.type, claim.base) ? this.expr(e.expr, scope, claim) : ["unproved"]
			case "column":
				return e.table === undefined ? ["unproved"] : this.column(e.table, e.column, scope, claim)
			case "call": {
				const [only] = e.args
				if (
					e.fn.kind === "builtin" &&
					(e.fn.name === "min" || e.fn.name === "max") &&
					e.args.length === 1 &&
					only !== undefined &&
					!e.star
				) {
					return this.expr(only, scope, claim)
				}
				return ["unproved"]
			}
			case "greatest":
			case "least":
				return e.args.flatMap((a) => this.expr(a, scope, claim))
			case "case":
				return [
					...e.whens.flatMap((w) => this.expr(w.result, scope, claim)),
					...this.expr(e.else, scope, claim)
				]
			case "subquery":
				return this.select(e.query, 0, scope, claim)
			case "excluded":
			case "returning":
			case "collate":
			case "binary":
			case "negate":
			case "and":
			case "or":
			case "not":
			case "isTrue":
			case "between":
			case "inList":
			case "inQuery":
			case "exists":
			case "array":
			case "row":
			case "mergeAction":
			case "domainValue":
			case "user":
			case "plVar":
			case "plSpecial":
			case "field":
			case "regclass":
				return ["unproved"]
		}
	}

	column(alias: string, column: string, scope: Scope, claim: Claim): ReadonlyArray<Verdict> {
		for (let at: Scope | undefined = scope; at !== undefined; at = at.outer) {
			const item = at.items.get(alias)
			if (item !== undefined) {
				return this.item(item, column, at, claim)
			}
		}
		return ["unproved"]
	}

	/** A CTE of the statement holding this one as a part, which the part does not see. */
	item(item: FromSource, column: string, scope: Scope, claim: Claim): ReadonlyArray<Verdict> {
		switch (item.kind) {
			case "table": {
				/** A carrier holds no stored column. */
				const stored =
					typeof item.table === "string"
						? undefined
						: this.#stored.get(storedKey(item.table, column))
				return [stored !== undefined && guarantees(stored, claim.type) ? "proved" : "unproved"]
			}
			case "derived": {
				const position = item.columns.indexOf(column)
				return position < 0 ? ["unproved"] : this.select(item.query, position, scope, claim)
			}
			case "values": {
				const position = item.columns.indexOf(column)
				if (position < 0) {
					return ["unproved"]
				}
				return item.rows.flatMap((row) => {
					const e = row[position]
					return e === undefined ? ["unproved" as const] : this.expr(e, scope, claim)
				})
			}
			case "cte":
				return this.cte(item.name, column, scope, claim)
			case "enclosing":
			case "function":
			case "recordset":
			case "context":
				return ["unproved"]
		}
	}

	/**
	 * A recursive CTE's step reads itself: its values are the seed's and the step's own, so the feedback
	 * reference adds no definition of its own.
	 */
	cte(name: string, column: string, scope: Scope, claim: Claim): ReadonlyArray<Verdict> {
		for (const [i, w] of scope.ctes.entries()) {
			const cte = w.ctes.find((c) => c.name === name)
			if (cte === undefined) {
				continue
			}
			const key = `${i}\u0000${name}\u0000${column}`
			if (scope.active.has(key)) {
				return []
			}
			/**
			 * The body sees its own WITH list (an earlier sibling, or itself when recursive) and the enclosing ones,
			 * and no FROM item of the core that references it.
			 */
			const body: Scope = {
				items: new Map(),
				ctes: scope.ctes.slice(i),
				active: new Set([...scope.active, key]),
				outer: undefined
			}
			return this.cteBody(cte, column, body, claim)
		}
		return ["unproved"]
	}

	/** A CTE without a column list names its columns by its body, which the lowering never emits: unproved. */
	cteBody(cte: Cte, column: string, scope: Scope, claim: Claim): ReadonlyArray<Verdict> {
		if (cte.query.kind !== "select" || cte.columns.length === 0) {
			return ["unproved"]
		}
		const position = cte.columns.indexOf(column)
		return position < 0 ? ["unproved"] : this.select(cte.query, position, scope, claim)
	}
}

/** `query` with each placeholder of a retyped slot, by number, cast to the slot's new type. */
export const retypePlaceholders = (
	query: Select,
	retyped: ReadonlyMap<number, ScalarParamSlot>
): Select =>
	retyped.size === 0
		? query
		: transformSelect(query, {
				...identityHooks,
				expr: (e) => {
					if (e.kind !== "param") {
						return e
					}
					const slot = retyped.get(e.slot.number)
					return slot === undefined ? e : { ...e, type: slot.sqlType }
				}
			})

/** The declared type of every stored column of a non-derived relation the DAG reads, by its installed table and column. */
export const storedColumns = (cx: LowerContext): ReadonlyMap<string, ScalarType> => {
	const out = new Map<string, ScalarType>()
	for (const node of topoOrder(cx.dag)) {
		if (node.kind !== "Base" || node.relationKind !== "relation") {
			continue
		}
		const table = cx.names.relation(node.relation)
		for (const c of node.heading) {
			out.set(storedKey(table, cx.names.column(node.relation, c.name)), c.type)
		}
	}
	return out
}

/**
 * The named type of a refined value, or undefined when it has none: a builtin, or a text refinement whose `__text_`
 * domain the installation does not name, which the conservative context's own typeRef refuses. Every other failure
 * of the type mapping propagates.
 */
export const domainOf = (cx: LowerContext, t: ScalarType): TypeRef | undefined => {
	const p = cx.physicalType(t)
	return p.kind === "type" && p.ref.kind === "named" ? p.ref : undefined
}

/** The delivered targets with the domain casts at `casts` (position to domain), in every arm of a set operation. */
export const castBody = (body: SelectBody, casts: ReadonlyMap<number, TypeRef>): SelectBody => {
	switch (body.kind) {
		case "core":
			return castOperand(body, casts)
		case "setOp": {
			const [first, second, ...rest] = body.arms
			return {
				...body,
				arms: [
					castOperand(first, casts),
					castOperand(second, casts),
					...rest.map((a) => castOperand(a, casts))
				]
			}
		}
		case "select":
			return castOperand(body, casts)
	}
}

const castOperand = (operand: SetOperand, casts: ReadonlyMap<number, TypeRef>): SetOperand =>
	operand.kind === "core"
		? mapTargets(operand, (t, i): Target => {
				const domain = casts.get(i)
				return domain === undefined ? t : { ...t, expr: cast(t.expr, domain) }
			})
		: { ...operand, body: castBody(operand.body, casts) }

/** The claim one refined column is traced against. */
export const claimOf = (cx: LowerContext, column: HeadingColumn): Claim => ({
	type: column.type,
	domain: domainOf(cx, column.type),
	base: cx.baseTypeRef(column.type)
})

/**
 * The domain a refined value must be cast to: none when every definition of it is proved, else its claim's domain. A
 * refinement with no domain to cast to is refused.
 */
export const castDomain = (
	verdicts: ReadonlyArray<Verdict>,
	claim: Claim,
	name: string,
	at: string
): TypeRef | undefined => {
	if (verdicts.every((v) => v === "proved")) {
		return undefined
	}
	if (claim.domain === undefined) {
		return refuse(
			"UnsupportedOperation",
			at,
			`the domain of ${name}'s refinement, which its delivered value must be cast to`
		)
	}
	return claim.domain
}

/**
 * A conservative delivered statement with its refined outputs validated where they are delivered (see the header).
 *
 * Refined outputs of a delivered statement: the trace that proves a delivered value already in its refinement, and the
 * conservative delivery's casts.
 *
 * A refined output is a delivered column whose descriptor is refined: a contract, or text with a specific pattern. A
 * value PostgreSQL has not proved to be in the refinement may be delivered under it only through a cast to the domain
 * in the delivered output list, which PostgreSQL evaluates for every delivered row, so any delivered value has been
 * checked and an empty result claims nothing. The Tracer classifies the definitions of one delivered
 * column, followed back through derived tables, CTEs, VALUES lists and set operation arms:
 *
 * - proved: a stored column of a non-derived relation whose declared type guarantees the refinement (the domain's
 *   validated CHECK is immediate evidence), a placeholder or literal typed by the domain, or a cast into
 *   it. min, max, LEAST, GREATEST and CASE deliver one of their operands' values, and a cast to the base type relabels
 *   without changing the value, so each is proved when its operands are;
 * - unproved: anything else, a recordset column of a relation parameter, a base-typed placeholder or literal, a
 *   base-typed recursive state column, a derived relation's column, or a definition the trace does not follow.
 *
 * Both deliveries use it: the optimized one in shapes/refined, and the conservative one here (refineConservative), in
 * two steps before emission.
 *
 * 1. Every placeholder typed by a refinement's domain, which in a delivered statement is an emitted refined parameter
 *    (expr/index.ts types a written or emitted one by its domain, and a query writes nothing), is retyped to its base,
 *    its slot with it. PostgreSQL validates a domain-typed placeholder when it binds it, before any row
 *    exists, so an empty result would fail on a value it never delivers; bound as its base, the value
 *    is validated by step 2 for every delivered row and only then. The conservative lowering casts every refined column
 *    of a set operation's arms to its base (union/arms.ts), so a retyped value agrees with the other arms.
 * 2. Every refined delivered column some definition of which is unproved is cast to its domain in the outermost target
 *    list, and an ORDER BY item that is the cast column is cast alike, which SELECT DISTINCT needs of an ORDER BY
 *    expression. A refined output whose domain the installation does not name cannot be validated and is refused.
 */
export const refineConservative = (
	cx: LowerContext,
	query: Select,
	delivered: Heading,
	unit: boolean
): Select => {
	const retyped = new Map<number, ScalarParamSlot>()
	for (const slot of cx.params.slots) {
		if (slot.kind !== "scalar" || !isRefined(slot.type) || slot.sqlType.kind !== "named") {
			continue
		}
		const base = cx.baseTypeRef(slot.type)
		if (sameTypeRef(base, slot.sqlType)) {
			continue
		}
		retyped.set(slot.number, cx.params.retype(slot, base))
	}
	const relabeled = retypePlaceholders(query, retyped)
	if (unit || !delivered.some((c) => isRefined(c.type))) {
		return relabeled
	}
	const tracer = new Tracer(storedColumns(cx))
	const casts = new Map<number, TypeRef>()
	for (const [position, column] of delivered.entries()) {
		if (!isRefined(column.type)) {
			continue
		}
		const at = `the refined output ${column.name}`
		const claim = claimOf(cx, column)
		const domain = castDomain(
			tracer.select(relabeled, position, emptyScope, claim),
			claim,
			column.name,
			at
		)
		if (domain !== undefined) {
			casts.set(position, domain)
		}
	}
	if (casts.size === 0) {
		return relabeled
	}
	const body = castBody(relabeled.body, casts)
	/** An ORDER BY item that is a cast target is cast alike. */
	const before = relabeled.body.kind === "core" ? relabeled.body.targets : []
	const after = body.kind === "core" ? body.targets : []
	const renamed = new Map<Expr, Expr>()
	for (const [i, t] of before.entries()) {
		const now = after[i]
		if (now !== undefined && now.expr !== t.expr) {
			renamed.set(t.expr, now.expr)
		}
	}
	const orderBy = relabeled.orderBy.map((o) => {
		const now = renamed.get(o.expr)
		return now === undefined ? o : { ...o, expr: now }
	})
	return { ...relabeled, body, orderBy }
}
