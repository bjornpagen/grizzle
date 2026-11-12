import { guarantees } from "#compiler/check/refinement/index.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { Heading, HeadingColumn } from "#compiler/ir/rel.ts"
import { isRefined, refinementText, type ScalarType } from "#compiler/ir/scalar.ts"
import { type LowerContext, refuse } from "#compiler/lower/conservative/context.ts"
import type { ConservativeParamSlot } from "#compiler/lower/conservative/types.ts"
import { CompilePatterns, type PatternReads } from "#compiler/scalar/regex/patterns.ts"
import type {
	Cte,
	Expr,
	FromItem,
	FromSource,
	ObjectName,
	OperandBody,
	OperandSelect,
	Select,
	SelectCore,
	SetOperand,
	Target,
	TypeRef,
	With
} from "#compiler/sql/ast.ts"
import { cast, mapTargets, sameTypeRef, setBodyOf, withArms } from "#compiler/sql/build.ts"

/**
 * What the trace finds of one definition of a delivered value: proved inside its refinement; unproved; or a declared
 * parameter's value, which its caller supplies and so is unproved, named as the query declares it, a relation
 * parameter's by its field (`<parameter>.<field>`), so a refusal names what the value came from.
 */
type Verdict = "proved" | "unproved" | { readonly kind: "parameter"; readonly name: string }

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
			case "probe":
			case "met":
			case "metRows":
			case "enclosing":
			case "derived":
			case "function":
			case "arrays":
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

export const withScope = (select: OperandSelect, enclosing: Scope): Scope =>
	select.with === undefined ? enclosing : { ...enclosing, ctes: [select.with, ...enclosing.ctes] }

/** The key of an installed table's column: its schema, table and column, three identifiers, never one text. */
const storedKey = (table: ObjectName, column: string): string =>
	`${table.schema}\u0000${table.name}\u0000${column}`

/** Whether `type` is the claim's domain: never, when the installation names none. */
const isDomain = (type: TypeRef, claim: Claim): boolean =>
	claim.domain !== undefined && sameTypeRef(type, claim.domain)

/** Whether `e` is FALSE, alone or as a conjunct of an AND. */
const isFalse = (e: Expr): boolean =>
	(e.kind === "literal" && e.value.kind === "bool" && !e.value.value) ||
	(e.kind === "and" && e.args.some(isFalse))

/**
 * Whether a text literal is a member of the claim's text pattern, decided on the host: a literal's value is fixed, so
 * PostgreSQL delivers exactly that value, and the pattern's automaton, read from `patterns`, decides its language as
 * the pattern's domain CHECK does. This is the proof for a literal whose pattern the installation names
 * no domain for, which a Closed node's query-local payload may carry. Only a text pattern is decided here: a
 * contract's predicate is the database's to evaluate, through its domain, which the installation always names.
 */
const admittedLiteral = (
	e: Extract<Expr, { readonly kind: "literal" }>,
	claim: Claim,
	patterns: PatternReads
): boolean => {
	const t = claim.type
	return (
		e.value.kind === "text" &&
		t.carrier === "text" &&
		t.contract === undefined &&
		t.text.regex !== "wildcard" &&
		patterns.member(t.text.regex, e.value.value)
	)
}

/** What one refined delivered column is traced against. */
interface Claim {
	readonly type: ScalarType
	/** The domain's type, or undefined when the installation names none. */
	readonly domain: TypeRef | undefined
	readonly base: TypeRef
}

/** A declared parameter's value as its placeholder carries it: the name the query declares it by, a relation
 * parameter's field as `<parameter>.<field>`, and the type PostgreSQL checks every value against as it binds it
 * (context.ts paramTypeRef, arrayCheck), which is what its value is proved to be. */
interface Supplied {
	readonly name: string
	readonly type: ScalarType
}

/** The placeholder a declared parameter's value fills, by its number (Supplied); none for a placeholder a lowering
 * allocates itself, or a ChangeSet member's, which no bind checks against its refinements. */
const parameterOf = (slot: ConservativeParamSlot): ReadonlyArray<readonly [number, Supplied]> => {
	switch (slot.kind) {
		case "scalar":
			return [[slot.number, { name: slot.param, type: slot.type }]]
		case "relation": {
			const field = slot.part.kind === "column" ? slot.columns[slot.part.index] : undefined
			return field === undefined
				? []
				: [[slot.number, { name: `${slot.param}.${field.name}`, type: field.type }]]
		}
		case "member":
		case "nestedRows":
		case "page":
			return []
	}
}

export class Tracer {
	readonly #stored: ReadonlyMap<string, ScalarType>
	/** Each declared parameter's placeholder, by its number (Supplied). */
	readonly #parameters: ReadonlyMap<number, Supplied>
	/** The admitted patterns the trace's literals are judged by, one table per lowering's trace. */
	readonly #patterns = new CompilePatterns()

	constructor(
		stored: ReadonlyMap<string, ScalarType>,
		slots: ReadonlyArray<ConservativeParamSlot>
	) {
		this.#stored = stored
		this.#parameters = new Map(slots.flatMap(parameterOf))
	}

	/**
	 * The verdict of a value the placeholder `number` fills: a declared parameter's is proved where the type its bind
	 * checked every value against guarantees the claim, and named otherwise; any other placeholder's is unproved.
	 */
	#supplied(number: number, claim: Claim): Verdict {
		const supplied = this.#parameters.get(number)
		if (supplied === undefined) {
			return "unproved"
		}
		return guarantees(supplied.type, claim.type)
			? "proved"
			: { kind: "parameter", name: supplied.name }
	}

	/** The verdicts of the values output position `position` of `select` delivers. */
	select(
		select: OperandSelect,
		position: number,
		scope: Scope,
		claim: Claim
	): ReadonlyArray<Verdict> {
		return this.body(select.body, position, withScope(select, scope), claim)
	}

	/** A core whose WHERE is false delivers no row, so it defines no value: an empty Closed source's placeholder rows. */
	body(body: OperandBody, position: number, scope: Scope, claim: Claim): ReadonlyArray<Verdict> {
		switch (body.kind) {
			case "core": {
				if (body.where !== undefined && isFalse(body.where)) {
					return []
				}
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
				return [isDomain(e.type, claim) ? "proved" : this.#supplied(e.slot.number, claim)]
			case "clock":
				return [isDomain(e.type, claim) ? "proved" : "unproved"]
			case "literal":
				return [
					isDomain(e.type, claim) || admittedLiteral(e, claim, this.#patterns)
						? "proved"
						: "unproved"
				]
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
			case "coalesce":
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
			case "complement":
			case "nullif":
			case "subscript":
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
			case "probe":
			case "met": {
				const driven = item.columns.find((c) => c.as === column)
				const stored =
					driven === undefined ? undefined : this.#stored.get(storedKey(item.table, driven.read))
				return [stored !== undefined && guarantees(stored, claim.type) ? "proved" : "unproved"]
			}
			case "metRows":
				return ["unproved"]
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
			case "arrays": {
				const array =
					item.source.kind === "columns"
						? item.source.columns.find((c) => c.definition.name === column)
						: undefined
				return [array === undefined ? "unproved" : this.#supplied(array.array.number, claim)]
			}
			case "enclosing":
			case "function":
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
const domainOf = (cx: LowerContext, t: ScalarType): TypeRef | undefined => {
	const p = cx.physicalType(t)
	return p.kind === "type" && p.ref.kind === "named" ? p.ref : undefined
}

/**
 * The delivered targets with the domain casts at `casts` (position to domain), in every arm of a set operation: a cast
 * of targets keeps a set's rows a set.
 */
export const castBody = (body: OperandBody, casts: ReadonlyMap<number, TypeRef>): OperandBody => {
	switch (body.kind) {
		case "core":
			return castOperand(body, casts)
		case "setOp": {
			const [first, second, ...rest] = body.arms
			return withArms(body, [
				castOperand(first, casts),
				castOperand(second, casts),
				...rest.map((a) => castOperand(a, casts))
			])
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
 * refinement with no domain to cast to, a text pattern no stored field declares, is refused, naming the delivered
 * column, the pattern and what the trace could not prove inside it, and saying what to do: a value the query computes,
 * or a parameter whose declared type does not guarantee the pattern, since one whose type does is proved by its bind. A
 * contract's domain is always named, so only a pattern meets the refusal.
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
		const t = claim.type
		const pattern =
			t.carrier === "text" && t.text.regex !== "wildcard"
				? `the refinement ${refinementText(t.text.regex)}`
				: "a refinement"
		const parameters = [
			...new Set(verdicts.flatMap((v) => (typeof v === "object" ? [v.name] : [])))
		]
		const from =
			parameters.length === 0
				? "a value the query computes"
				: `the ${parameters.length === 1 ? "value of the parameter" : "values of the parameters"} ${parameters.join(", ")}`
		return refuse(
			"UnsupportedOperation",
			at,
			`${name}'s refinement, ${pattern}, which no stored field declares, so the installation holds no domain to check ${from} by as it is delivered; declare a field of that pattern on a stored relation, or type the value by a pattern a stored field declares`
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
 *   validated CHECK is immediate evidence), a placeholder or literal typed by the domain, a text literal the
 *   pattern's automaton admits on the host, or a cast into it; and a declared parameter's value, a scalar parameter's
 *   placeholder or a relation parameter's field array, whose declared type guarantees the refinement: PostgreSQL checks
 *   every value against its type's contract and pattern as it binds the parameter, its placeholder typed by the
 *   refinement's domain and its array cast through it (context.ts paramTypeRef, arrayCheck), as a stored column's
 *   domain checks it, so its refinement travels with it.
 *   A core whose WHERE is false delivers nothing and defines no value. min, max, LEAST, GREATEST and CASE deliver one
 *   of their operands' values, and a cast to the base type relabels without changing the value, so each is proved
 *   when its operands are;
 * - unproved: anything else, a parameter whose declared type does not guarantee the refinement, a base-typed
 *   placeholder or literal of no declared parameter, a base-typed recursive state column, a derived relation's column,
 *   or a definition the trace does not follow.
 *
 * Both deliveries use it: the optimized one in shapes/refined, and the conservative one here (refineConservative),
 * before emission. A declared parameter's placeholder stays typed by its refinement's domain, so PostgreSQL validates
 * it as it binds it, before any row exists, which is the parameter's one check: a value outside its refinement is
 * refused whatever the result delivers. The conservative lowering casts every refined column of a set operation's arms
 * to its base (union/arms.ts). Every refined delivered column some definition of which is unproved is cast to its domain
 * in the outermost target list, and an ORDER BY item that is the cast column is cast alike, which SELECT DISTINCT needs
 * of an ORDER BY expression. A refined output whose domain the installation does not name cannot be validated and is
 * refused.
 *
 * A law's violation probe (deploy/diff), the migration's check of a law over closed relations alone, delivers to no
 * host: its rows are declared values, which already satisfy their refinements, and the migration reads only whether one
 * exists. It claims nothing of its outputs, so it casts none of them, a contract's base pattern no domain names among
 * them.
 */
export const refineConservative = (
	cx: LowerContext,
	query: Select,
	delivered: Heading,
	unit: boolean
): Select => {
	const relabeled = query
	if (
		unit ||
		cx.options.subject.kind === "violationProbe" ||
		!delivered.some((c) => isRefined(c.type))
	) {
		return relabeled
	}
	const tracer = new Tracer(storedColumns(cx), cx.params.slots)
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
	return { ...relabeled, body: setBodyOf(body, "the refined outputs' casts"), orderBy }
}
