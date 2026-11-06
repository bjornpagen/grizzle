import { hasConstraint, type RefinedConstant } from "#compiler/check/refinement/index.ts"
import {
	canonicalEquals,
	canonicalTextOf,
	catchRefusal,
	everyProperty
} from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { nodesByLabel } from "#compiler/ir/dag.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { Heading, NodeOf } from "#compiler/ir/rel.ts"
import { isRefined } from "#compiler/ir/scalar.ts"
import { type LowerContext, physicalTypeRef, refuse } from "#compiler/lower/conservative/context.ts"
import { lowerLiteral } from "#compiler/lower/conservative/expr/index.ts"
import {
	castBody,
	claimOf,
	coreScope,
	domainOf,
	emptyScope,
	castDomain,
	retypePlaceholders,
	type Scope,
	storedColumns,
	Tracer,
	withScope
} from "#compiler/lower/conservative/refined.ts"
import type { ScalarParamSlot } from "#compiler/lower/conservative/types.ts"
import type {
	Cte,
	Expr,
	FromItem,
	FromSource,
	Select,
	SelectBody,
	SelectCore,
	Target,
	TypeRef
} from "#compiler/sql/ast.ts"
import { cast, col, mapTargets, sameTypeRef, simpleSelect, targetAs } from "#compiler/sql/build.ts"
import {
	identityHooks,
	inertVisitor,
	transformSelect,
	visitSelect
} from "#compiler/sql/transform.ts"

/**
 * The placeholders of `query` cast to a refinement's domain, which an emitted refined parameter is, each
 * recast to its base, its slot with it; and the base of each recast placeholder, by index. A placeholder typed by a
 * domain is validated when it is bound, before any row exists, so an emitted parameter that an empty result never
 * delivers would still fail; bound as its base, it is validated by the domain cast in the delivered
 * output list, for every delivered row and only then.
 */
const relabelRefinedPlaceholders = (
	cx: LowerContext,
	query: Select
): { readonly query: Select; readonly retype: ReadonlyMap<number, TypeRef> } => {
	const used = new Map<number, TypeRef>()
	visitSelect(query, {
		...inertVisitor,
		expr: (e) => {
			if (e.kind === "param") {
				used.set(e.slot.number, e.type)
			}
		}
	})
	const retyped = new Map<number, ScalarParamSlot>()
	for (const slot of cx.params.slots) {
		const type = used.get(slot.number)
		if (slot.kind !== "scalar" || type?.kind !== "named" || !isRefined(slot.type)) {
			continue
		}
		const domain = domainOf(cx, slot.type)
		if (domain === undefined || !sameTypeRef(type, domain)) {
			continue
		}
		retyped.set(slot.number, cx.params.retype(slot, cx.baseTypeRef(slot.type)))
	}
	return {
		query: retypePlaceholders(query, retyped),
		retype: new Map(Array.from(retyped, ([number, slot]) => [number, slot.sqlType] as const))
	}
}

/** Base types by position or member index. */
type Positions = Map<number, TypeRef>

const positionsOf = <K>(map: Map<K, Positions>, key: K): Positions => {
	let p = map.get(key)
	if (p === undefined) {
		p = new Map()
		map.set(key, p)
	}
	return p
}

/** Whether `e` already carries exactly `type`, so a cast to it would restate it. */
const carries = (e: Expr, type: TypeRef): boolean =>
	(e.kind === "param" || e.kind === "literal" || e.kind === "cast") && sameTypeRef(type, e.type)

const widthOf = (body: SelectBody): number => {
	switch (body.kind) {
		case "core":
			return body.targets.length
		case "setOp":
			return widthOf(body.arms[0])
		case "select":
			return widthOf(body.body)
	}
}

/** No CTE column's definition is being traced. */
const noCtes: ReadonlySet<string> = new Set()

/**
 * Which expressions of a relabeled statement now carry a recast placeholder's base where they carried its domain, and
 * the casts that make every member of a type-agreement site carry it alike. Generated names are single-assignment:
 * a relation alias or CTE name is defined once per statement, so a column reference resolves by its
 * alias alone.
 */
class Agreement {
	readonly #retype: ReadonlyMap<number, TypeRef>
	readonly #items = new Map<string, FromSource>()
	readonly #ctes = new Map<string, Cte>()
	readonly #exprs = new Map<Expr, TypeRef | undefined>()
	readonly #bodies = new Map<SelectBody, Map<number, TypeRef | undefined>>()
	/**
	 * The casts to the base: per set operation arm and position, per VALUES list and row and position, and per CASE,
	 * GREATEST or LEAST and member (a CASE's ELSE is the member after its WHENs).
	 */
	readonly #arms = new Map<SelectCore | Select, Positions>()
	readonly #cells = new Map<FromItem, Map<number, Positions>>()
	readonly #members = new Map<Expr, Positions>()

	/** Every site, wherever it sits: a set operation, a VALUES list, a CASE, GREATEST or LEAST. */
	constructor(query: Select, retype: ReadonlyMap<number, TypeRef>) {
		this.#retype = retype
		visitSelect(query, {
			...inertVisitor,
			/** A join names no relation of its own; the walk visits its sides. */
			fromItem: (item) => {
				switch (item.kind) {
					case "table":
					case "enclosing":
					case "derived":
					case "values":
					case "function":
					case "arrays":
					case "context":
						this.#items.set(item.alias, item)
						return
					case "cte":
						this.#items.set(item.alias ?? item.name, item)
						return
					case "joins":
						return
				}
			},
			with: (w) => {
				for (const c of w.ctes) {
					if (!this.#ctes.has(c.name)) {
						this.#ctes.set(c.name, c)
					}
				}
			}
		})
		visitSelect(query, {
			...inertVisitor,
			setOp: (body) => {
				for (let p = 0; p < widthOf(body); p++) {
					this.#body(body, p, noCtes)
				}
			},
			fromItem: (item) => {
				if (item.kind === "values") {
					for (let p = 0; p < item.columns.length; p++) {
						this.#cell(item, p, noCtes)
					}
				}
			},
			expr: (e) => {
				if (e.kind === "case" || e.kind === "greatest" || e.kind === "least") {
					this.#expr(e, noCtes)
				}
			}
		})
	}

	get changes(): boolean {
		return this.#arms.size > 0 || this.#cells.size > 0 || this.#members.size > 0
	}

	/** The statement with every cast this agreement found. */
	apply(query: Select): Select {
		if (!this.changes) {
			return query
		}
		return transformSelect(query, {
			...identityHooks,
			core: (node, original) => {
				const arm = this.#arms.get(original)
				return arm === undefined
					? node
					: mapTargets(node, (t, i) => {
							const base = arm.get(i)
							return base === undefined ? t : { ...t, expr: cast(t.expr, base) }
						})
			},
			select: (node, original) => {
				const arm = this.#arms.get(original)
				return arm === undefined ? node : { ...node, body: castBody(node.body, arm) }
			},
			/** A VALUES list is rebuilt as a VALUES list. */
			fromSource: (item, original) => {
				const cells = this.#cells.get(original)
				if (cells === undefined || item.kind !== "values") {
					return item
				}
				return {
					...item,
					rows: mapNonEmpty(item.rows, (row, r) => {
						const at = cells.get(r)
						return at === undefined
							? row
							: row.map((e, i) => {
									const base = at.get(i)
									return base === undefined ? e : cast(e, base)
								})
					})
				}
			},
			expr: (e, original) => {
				const members = this.#members.get(original)
				if (members === undefined) {
					return e
				}
				const castAt = (x: Expr, i: number): Expr => {
					const base = members.get(i)
					return base === undefined ? x : cast(x, base)
				}
				if (e.kind === "case") {
					return {
						...e,
						whens: mapNonEmpty(e.whens, (w, i) => ({ ...w, result: castAt(w.result, i) })),
						else: castAt(e.else, e.whens.length)
					}
				}
				if (e.kind === "greatest" || e.kind === "least") {
					return { ...e, args: mapNonEmpty(e.args, castAt) }
				}
				return e
			}
		})
	}

	/**
	 * The members' common base, when one of them carries a recast placeholder's base; each other member is cast to it.
	 * `active` names the CTE columns whose definitions are being traced around them (#cte).
	 */
	#unify(
		members: ReadonlyArray<Expr | undefined>,
		mark: (i: number, base: TypeRef) => void,
		active: ReadonlySet<string>
	): TypeRef | undefined {
		const shifts = members.map((m) => (m === undefined ? undefined : this.#expr(m, active)))
		const base = shifts.find((s) => s !== undefined)
		if (base === undefined) {
			return undefined
		}
		for (const [i, m] of members.entries()) {
			if (m !== undefined && shifts[i] === undefined && !carries(m, base)) {
				mark(i, base)
			}
		}
		return base
	}

	#expr(e: Expr, active: ReadonlySet<string>): TypeRef | undefined {
		if (this.#exprs.has(e)) {
			return this.#exprs.get(e)
		}
		const out = this.#exprType(e, active)
		this.#exprs.set(e, out)
		return out
	}

	/**
	 * A cast fixes its type; an operator, a function or an aggregate has its own result type, and a
	 * polymorphic one resolves a domain argument to its base already.
	 */
	#exprType(e: Expr, active: ReadonlySet<string>): TypeRef | undefined {
		switch (e.kind) {
			case "param":
				return this.#retype.get(e.slot.number)
			case "column":
				return e.table === undefined ? undefined : this.#column(e.table, e.column, active)
			case "case":
				return this.#unify(
					[...e.whens.map((w) => w.result), e.else],
					(i, base) => {
						positionsOf(this.#members, e).set(i, base)
					},
					active
				)
			case "greatest":
			case "least":
				return this.#unify(
					e.args,
					(i, base) => {
						positionsOf(this.#members, e).set(i, base)
					},
					active
				)
			case "subquery":
				return this.#body(e.query, 0, active)
			case "excluded":
			case "returning":
			case "literal":
			case "cast":
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
			case "call":
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
				return undefined
		}
	}

	/**
	 * A table's, a function's or an input array's column is no SELECT's output, and a part sees no column of the
	 * statement holding it: none is unified here.
	 */
	#column(alias: string, column: string, active: ReadonlySet<string>): TypeRef | undefined {
		const item = this.#items.get(alias)
		switch (item?.kind) {
			case "derived": {
				const p = item.columns.indexOf(column)
				return p < 0 ? undefined : this.#body(item.query, p, active)
			}
			case "values": {
				const p = item.columns.indexOf(column)
				return p < 0 ? undefined : this.#cell(item, p, active)
			}
			case "cte":
				return this.#cte(item.name, column, active)
			case "table":
			case "enclosing":
			case "function":
			case "arrays":
			case "context":
			case undefined:
				return undefined
		}
	}

	#cell(
		item: Extract<FromItem, { readonly kind: "values" }>,
		p: number,
		active: ReadonlySet<string>
	): TypeRef | undefined {
		const cells = item.rows.map((row) => row[p])
		return this.#unify(
			cells,
			(r, base) => {
				let rows = this.#cells.get(item)
				if (rows === undefined) {
					rows = new Map()
					this.#cells.set(item, rows)
				}
				positionsOf(rows, r).set(p, base)
			},
			active
		)
	}

	/** A CTE without a column list names its columns by its body, which the lowering never emits: unproved. */
	#cte(name: string, column: string, active: ReadonlySet<string>): TypeRef | undefined {
		const cte = this.#ctes.get(name)
		if (cte?.query.kind !== "select" || cte.columns.length === 0) {
			return undefined
		}
		const p = cte.columns.indexOf(column)
		if (p < 0) {
			return undefined
		}
		/** A recursive CTE's feedback reference adds no definition of its own; its state is base-typed. */
		const key = `${name}\u0000${column}`
		return active.has(key) ? undefined : this.#body(cte.query, p, new Set([...active, key]))
	}

	#body(body: SelectBody, p: number, active: ReadonlySet<string>): TypeRef | undefined {
		const memo = this.#bodies.get(body) ?? new Map<number, TypeRef | undefined>()
		this.#bodies.set(body, memo)
		if (memo.has(p)) {
			return memo.get(p)
		}
		const out = this.#bodyType(body, p, active)
		memo.set(p, out)
		return out
	}

	#bodyType(body: SelectBody, p: number, active: ReadonlySet<string>): TypeRef | undefined {
		switch (body.kind) {
			case "core": {
				const t = body.targets[p]
				return t === undefined ? undefined : this.#expr(t.expr, active)
			}
			case "select":
				return this.#body(body.body, p, active)
			case "setOp":
				return this.#setOpType(body, p, active)
		}
	}

	/**
	 * A set operation's column is typed by its first arm that types it; every other arm that neither types it nor already
	 * carries that type is marked to be cast to it.
	 */
	#setOpType(
		body: Extract<SelectBody, { readonly kind: "setOp" }>,
		p: number,
		active: ReadonlySet<string>
	): TypeRef | undefined {
		const arms = body.arms
		const shifts = arms.map((arm) => this.#body(arm, p, active))
		const out = shifts.find((s) => s !== undefined)
		if (out === undefined) {
			return undefined
		}
		for (const [i, arm] of arms.entries()) {
			const t = arm.kind === "core" ? arm.targets[p] : undefined
			if (shifts[i] === undefined && !(t !== undefined && carries(t.expr, out))) {
				positionsOf(this.#arms, arm).set(p, out)
			}
		}
		return out
	}
}

/** The ARRAY(SELECT ...) a fused attachment column is, under the casts its delivery wraps it in. */
const fusedArray = (e: Expr): Extract<Expr, { readonly kind: "array" }> | undefined =>
	e.kind === "array" ? e : e.kind === "cast" ? fusedArray(e.expr) : undefined

const replaceArray = (e: Expr, array: Expr): Expr =>
	e.kind === "array" ? array : e.kind === "cast" ? { ...e, expr: replaceArray(e.expr, array) } : e

const notFused = (at: string): never =>
	refuse(
		"MalformedDescription",
		at,
		"a fused attachment column, ARRAY(SELECT <element> FROM (<child rows>) AS r(...)), after the delivered heading"
	)

/**
 * The Attach node a fused array's child rows are named after: shapes/attach fusedAttachment wraps them under the
 * attachment's id, which the statement's name supply records as the derived table's origin. The delivery hands this
 * plug-in the statement and its heading only, so the child's heading is found
 * through that origin: a name, read through the DAG's labels, a label no Attach holds being no fused column.
 */
const attachOf = (cx: LowerContext, alias: string): NodeOf<"Attach"> | undefined => {
	const origin = cx.supply.map().find((e) => e.role === "relation" && e.name === alias)?.origin
	if (origin?.kind !== "node") {
		return undefined
	}
	const node = nodesByLabel(cx.dag).get(origin.node)
	return node?.kind === "Attach" ? node : undefined
}

/**
 * A fused attachment column with each unproved refined field of its element cast to its domain inside the element,
 * the array subquery's target list, which PostgreSQL evaluates for every element it delivers.
 */
const refineFused = (cx: LowerContext, tracer: Tracer, t: Target, outer: Scope): Target => {
	const at = "a fused attachment column of the optimized delivery"
	const array = fusedArray(t.expr) ?? notFused(at)
	const inner = array.query
	if (inner.body.kind !== "core") {
		return notFused(at)
	}
	const core = inner.body
	const [rows] = core.from
	const element = core.targets.length === 1 ? core.targets[0] : undefined
	if (element === undefined || rows?.kind !== "derived") {
		return notFused(at)
	}
	const attach = attachOf(cx, rows.alias) ?? notFused(at)
	const child = attach.child.heading
	const scope = coreScope(core, withScope(inner, outer))
	const fields = (e: Expr): Expr => {
		switch (e.kind) {
			case "column": {
				if (e.table !== rows.alias) {
					return e
				}
				const column = child[rows.columns.indexOf(e.column)]
				if (column === undefined || !isRefined(column.type)) {
					return e
				}
				const fieldAt = `the refined field ${column.name} of the attachment ${attach.name}`
				const claim = claimOf(cx, column)
				const verdicts = tracer.item(rows, e.column, scope, claim)
				const domain = castDomain(verdicts, claim, column.name, fieldAt)
				return domain === undefined ? e : cast(e, domain)
			}
			case "cast": {
				const inside = fields(e.expr)
				return inside === e.expr ? e : { ...e, expr: inside }
			}
			case "call": {
				if (e.star) {
					return e
				}
				const args = e.args.map(fields)
				return args.every((a, i) => a === e.args[i]) ? e : { ...e, args }
			}
			case "row": {
				const items = mapNonEmpty(e.items, fields)
				return items.every((x, i) => x === e.items[i]) ? e : { ...e, items }
			}
			case "excluded":
			case "returning":
			case "param":
			case "literal":
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
			case "subquery":
			case "array":
			case "case":
			case "greatest":
			case "least":
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
				return e
		}
	}
	const refined = fields(element.expr)
	if (refined === element.expr) {
		return t
	}
	const query: Select = { ...inner, body: { ...core, targets: [{ ...element, expr: refined }] } }
	return { ...t, expr: replaceArray(t.expr, { ...array, query }) }
}

/**
 * Refined output casts and constant validation statements.
 *
 * A refined output is a delivered column whose descriptor is refined: a contract, or text with a specific pattern. A
 * value PostgreSQL has not proved to be in the refinement may be delivered under it only through a cast to the domain
 * in the delivered output list, which PostgreSQL evaluates for every delivered row, so any delivered value has been
 * checked and an empty result claims nothing. A cast that a scan, WHERE, unused CTE or EXISTS target list
 * carries could be pruned and is never relied on.
 *
 * refineDelivered works on the statement the optimized delivery is about to emit,
 * in three steps.
 *
 * 1. Relabel. Every placeholder the statement types by a refinement's domain, an emitted refined parameter
 *    (check/checker.ts head params), is recast to its base, and its slot with it. PostgreSQL validates a
 *    domain-typed placeholder when it binds it, before any row exists, so a query that emits a parameter it also
 *    compares would fail on an out-of-pattern value its empty result never delivers; bound as its
 *    base, the value is validated by the domain cast in the delivered output list instead.
 * 2. Agreement. The relabel changes the PostgreSQL type of every expression whose value is such a placeholder's, from
 *    the domain to its base. Where such an expression meets others whose type must agree with it, the arms of a set
 *    operation, the rows of a VALUES list, the results of a CASE and the arguments of GREATEST and LEAST, every other
 *    member is cast to that base, so the statement never relies on PostgreSQL's type resolution across them.
 *    A cast to the base relabels a value of the domain without changing it; the member it wraps is a
 *    target or a value, never an indexed column in a predicate.
 * 3. Casts. Each refined delivered column, and each refined field of a fused attachment's array (shapes/attach), is
 *    traced back through its derived tables, CTEs, VALUES lists and set operation arms to the expressions that define
 *    its values, and each definition is classified:
 *
 *    - proved: a stored column of a non-derived relation whose declared type guarantees the refinement (the domain's
 *      validated CHECK is immediate evidence), a placeholder or literal typed by the domain, or a cast into
 *      it. A value of a domain type exists only once PostgreSQL has validated it, so the value it delivers has been
 *      checked wherever the definition sits. min, max, LEAST, GREATEST and CASE deliver one of their operands' values,
 *      and a cast to the base type relabels without changing the value, so each is proved when its operands are;
 *    - unproved: anything else, an array column of a relation parameter, a base-typed placeholder or literal, a
 *      base-typed recursive state column, a derived relation's column, or a definition this trace does not follow. A
 *      base-typed literal is checked at compilation (ContractLiteral), but the compiler relies on its
 *      membership only once PostgreSQL has validated it, and no admission path runs the constant validation of a
 *      query's literals, so it is cast like any other unproved value.
 *
 *    The trace is the conservative delivery's too (conservative/refined.ts), which shares it rather than restating it.
 *    A delivered column with an unproved definition is cast to its domain in the delivered output list, and every arm
 *    of a delivered set operation alike, so the arms keep one type. A fused attachment's field with one is cast to its
 *    domain inside the array's element, the target list of the ARRAY(SELECT ...) subquery, which PostgreSQL evaluates
 *    for every element it delivers. A column whose definitions are all proved is left as it is, and a statement with
 *    nothing to change is returned unchanged, the same object. A refined output whose domain the installation does
 *    not name cannot be validated and is refused, as the conservative lowering refuses it.
 *
 * constantValidations builds the installation's validation statements for the refined constants check/refinement
 * lists: per domain, one SELECT of the constants cast to the domain in its output list over a VALUES list of base-typed
 * literals. Every row is delivered, so PostgreSQL validates every constant, and an invalid one fails the statement
 * with 23514 naming the domain's constraint. The installer's refined-constants extension (physical/refined/constants.ts)
 * adds the closed payloads' statement to an installation's Publish phase, where every domain holds the target's
 * constraints alone.
 *
 * The fused attachment columns follow the heading in the outermost core.
 */
/**
 * `query` with the outputs at `casts` cast to their domains, and each ORDER BY item that is one of those outputs cast
 * alike: SELECT DISTINCT orders only by expressions of its output list, and the cast output is the one there.
 */
const castOutputs = (query: Select, casts: ReadonlyMap<number, TypeRef>): Select => {
	const body = castBody(query.body, casts)
	const before = query.body.kind === "core" ? query.body.targets : []
	const after = body.kind === "core" ? body.targets : []
	const orderBy = query.orderBy.map((item) => {
		const at = before.findIndex((t) => canonicalEquals(t.expr, item.expr, everyProperty))
		const now = after[at]
		return at < 0 || now === undefined || now.expr === item.expr
			? item
			: { ...item, expr: now.expr }
	})
	return { ...query, body, orderBy }
}

export const refineDelivered = (cx: LowerContext, query: Select, heading: Heading): Select => {
	const relabeled = relabelRefinedPlaceholders(cx, query)
	const agreement =
		relabeled.retype.size === 0 ? undefined : new Agreement(relabeled.query, relabeled.retype)
	const agreed = agreement === undefined ? relabeled.query : agreement.apply(relabeled.query)
	const refined = heading.flatMap((c, i) => (isRefined(c.type) ? [{ column: c, position: i }] : []))
	const fused = agreed.body.kind === "core" && agreed.body.targets.length > heading.length
	if (refined.length === 0 && !fused) {
		return agreed
	}
	const tracer = new Tracer(storedColumns(cx))
	const casts = new Map<number, TypeRef>()
	for (const { column, position } of refined) {
		const at = `the refined output ${column.name}`
		const claim = claimOf(cx, column)
		const verdicts = tracer.select(agreed, position, emptyScope, claim)
		const domain = castDomain(verdicts, claim, column.name, at)
		if (domain !== undefined) {
			casts.set(position, domain)
		}
	}
	let out = casts.size === 0 ? agreed : castOutputs(agreed, casts)
	if (out.body.kind === "core" && out.body.targets.length > heading.length) {
		const body = out.body
		const outer = coreScope(body, withScope(out, emptyScope))
		const refinedCore = mapTargets(body, (t, i) =>
			i < heading.length ? t : refineFused(cx, tracer, t, outer)
		)
		if (refinedCore.targets.some((t, i) => t !== body.targets[i])) {
			out = { ...out, body: refinedCore }
		}
	}
	return out
}

/**
 * The validation statements of the refined constants (check/refinement refinedConstants): per
 * domain, in order of first appearance, `SELECT "r1"."c1"::<domain> AS "value" FROM (VALUES (<literal>::<base>), ...)
 * AS "r1"("c1")`, each distinct constant once. A constant whose type carries no CHECK is not listed (hasConstraint).
 */
const constantValidations = (
	names: PhysicalNames,
	constants: ReadonlyArray<RefinedConstant>
): Result.Result<ReadonlyArray<Select>, CompileError> =>
	catchRefusal(() => {
		/** Each domain with its distinct constants, a group made with its first. */
		const groups: Array<{ domain: TypeRef; rows: [Expr, ...Array<Expr>]; seen: Set<string> }> = []
		for (const c of constants) {
			if (!hasConstraint(c.type)) {
				continue
			}
			const at = c.site
			const domain = physicalTypeRef(names, c.type, at)
			const group = groups.find((g) => sameTypeRef(g.domain, domain))
			const value = lowerLiteral(names, c.literal, c.type)
			const text = canonicalTextOf(value)
			if (group === undefined) {
				groups.push({ domain, rows: [value], seen: new Set([text]) })
				continue
			}
			if (group.seen.has(text)) {
				continue
			}
			group.seen.add(text)
			group.rows.push(value)
		}
		return groups.map((g) =>
			simpleSelect(
				[targetAs(cast(col("r1", "c1"), g.domain), "value")],
				[{ kind: "values", rows: mapNonEmpty(g.rows, (r) => [r]), alias: "r1", columns: ["c1"] }],
				undefined
			)
		)
	})

/**
 * The validation object the installation's Publish phase runs for the refined constants: a `validation` object of the
 * obligation graph, its statements those of constantValidations. A cast meets every constraint its domain holds, and a
 * migration replaces a domain's one constraint in Structure, so the constants are cast in Publish, judged by the
 * target's constraint once every constraint is in place (deploy/diff/diff.ts validations). It is shaped as
 * the installer's ObjectSpec (physical/obligations), which the installer's extension hook accepts, without this lower
 * layer importing the installer.
 */
interface ConstantValidationObject {
	readonly kind: "validation"
	readonly ident: string
	readonly ddl: ReadonlyArray<Select>
	readonly reasons: ReadonlyArray<{ readonly kind: "enforcement"; readonly of: string }>
	readonly phase: "publish"
}

export const constantValidationObjects = (
	names: PhysicalNames & { readonly schema: string },
	constants: ReadonlyArray<RefinedConstant>
): Result.Result<ReadonlyArray<ConstantValidationObject>, CompileError> =>
	Result.map(constantValidations(names, constants), (statements) =>
		statements.length === 0
			? []
			: [
					{
						kind: "validation",
						ident: `${names.schema}.__validate_refined_constants`,
						ddl: statements,
						reasons: [{ kind: "enforcement", of: "refined constants" }],
						phase: "publish"
					}
				]
	)
