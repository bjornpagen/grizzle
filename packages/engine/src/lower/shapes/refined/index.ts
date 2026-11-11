import {
	hasConstraint,
	type RefinedConstant,
	refinedSiteText
} from "#compiler/check/refinement/index.ts"
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
	emptyScope,
	castDomain,
	type Scope,
	storedColumns,
	Tracer,
	withScope
} from "#compiler/lower/conservative/refined.ts"
import type { Expr, Select, Target, TypeRef } from "#compiler/sql/ast.ts"
import {
	cast,
	col,
	mapTargets,
	provedSelect,
	sameTypeRef,
	setBodyOf,
	targetAs
} from "#compiler/sql/build.ts"

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
			case "coalesce":
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
 * refineDelivered works on the statement the optimized delivery is about to emit. A declared parameter's placeholder
 * stays typed by its refinement's domain (lower/conservative/context.ts paramTypeRef): PostgreSQL validates it as it
 * binds it, before any row exists, which is the parameter's one check, so a value outside its refinement is refused
 * whatever the result delivers, as nothing on the host checks it. Then each refined delivered column, and each refined field of a fused attachment's array (shapes/attach), is
 * traced back through its derived tables, CTEs, VALUES lists and set operation arms to the expressions that define
 * its values, and each definition is classified:
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
	const body = setBodyOf(castBody(query.body, casts), "the refined outputs' casts")
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
	const agreed = query
	const refined = heading.flatMap((c, i) => (isRefined(c.type) ? [{ column: c, position: i }] : []))
	const fused = agreed.body.kind === "core" && agreed.body.targets.length > heading.length
	if (refined.length === 0 && !fused) {
		return agreed
	}
	const tracer = new Tracer(storedColumns(cx), cx.params.slots)
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
			const at = refinedSiteText(c.site)
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
			provedSelect(
				"keyed",
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
