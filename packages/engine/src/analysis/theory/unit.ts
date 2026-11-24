/**
 * Unit-local rules: a rule over a query every fact of whose violation lies within one unit, a value of the key every
 * relation it reads leads with, each of them immutable or all of them in one declared unit (ir/unit.ts), which the
 * judge reads whole over the units a transaction wrote, never probing the rows it wrote (analysis/theory/query.ts
 * WholeRule).
 *
 * A rule is unit-local when its violation query (query.ts violationQuery), the one the migration that adds it runs,
 * joins within one unit at every rule of it: every stored relation it reads leads its primary key with k fields of one
 * sequence of types; in every rule of the query, at any depth, every match of a stored relation binds those k fields to
 * one sequence of variables, the rule's unit, every match of an imported query binds the fields its head delivers its
 * unit at (`Delivered`) to those same variables, and every negation is correlated at them; an import whose head holds
 * no unit is the only source of a unit its rule reads; every rule of a union delivers its unit alike; and an
 * aggregating rule's head delivers its unit, so its groups lie inside one unit. A fact of such a query is then derived
 * from the rows of one unit alone, and a write changes it only at the units whose rows it writes. The width k is the
 * most for which the query is unit-local, so a unit is as narrow as the rule's joins allow; a rule unit-local at no
 * width is probed.
 *
 * The judge reads a whole rule's violation restricted to the units a transaction wrote (`restrictToUnits`): every
 * outermost rule of the query that binds a unit, from a stored relation it matches or a query that delivers one, is
 * read per unit (`unitStep`), the region of the units' keys first, a step made a set of them (`regionOf`), then the rule
 * as a step, a subquery PostgreSQL plans apart and reads LATERAL once per unit, its unit's variables the step's
 * channels. The unit is bound once, there: every rule the step's imports and negations read reads it from the channels,
 * joined or correlated at them, and
 * matches no region of its own (`Restriction`), which the step would read again for each unit of the region outside
 * it, the delta's every row once per written unit, or which PostgreSQL would anti-join against a second copy of the
 * region by a nested loop. The judge navigates the rule a step reads where it joins or negates a join
 * (analysis/theory/navigate.ts navigateQuery, physical/ddl/rules.ts judgedStatement): each relation it reads a step of
 * its own, a lookup by the unit's channels and the columns the steps before it bound, a negated derived relation's
 * definition included. So every read of a stored relation is an index range
 * at the unit key, which leads each stored relation's primary key, inside a step whose region holds the written units
 * alone: an aggregate's rule groups that unit's rows alone, and a negation reads the written units' rows alone, whether
 * PostgreSQL probes it at each fact or hashes it whole, whatever PostgreSQL estimates of the region. The region is a
 * set of unit keys: the union, over each
 * stored relation the rule reads and each side of its writes its captures hold (physical/ddl/rules.ts), of the leading
 * key fields of the rows that side holds. The restriction is one function for every whole rule, and it is the query's
 * own text, which the checker and the lowering read as they read any query.
 */
import { sameOrder } from "@bjornpagen/grizzle-text/base/array"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	headNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { TupleSet } from "@bjornpagen/grizzle-text/base/tuple-map"
import { refuse } from "#compiler/analysis/theory/build.ts"
import {
	type LeafRewrite,
	mapBindings,
	mapLeaves,
	varRef
} from "#compiler/analysis/theory/leaves.ts"
import {
	type LawSide,
	queryOf,
	type RelationRead,
	type ReplacedRead,
	ruleDesc,
	type RuleLaw,
	type WholeRule
} from "#compiler/analysis/theory/query.ts"
import { canonicalEquals, canonicalTextOf } from "#compiler/core/canonical.ts"
import type { UnitLocality } from "#compiler/core/causes.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import {
	combineAll,
	type Comparator,
	compareNumbers,
	compareStrings,
	listOrder,
	mapInput
} from "#compiler/core/order.ts"
import {
	callsOf,
	type ExprDesc,
	exprChildren,
	type FieldDesc,
	type InferredExpr,
	type InferredHead,
	type InferredMatch,
	type InferredQuery,
	type InferredRule,
	type InferredSource,
	type InferredStage,
	type LiteralDesc,
	type Located,
	mapBindTerms,
	mapExprChildren,
	type MatchDesc,
	type QueryDesc,
	queryParamNames,
	type Refs,
	type RuleDesc,
	type TermDesc,
	type VarDesc
} from "#compiler/ir/desc.ts"
import type { RelationInfo, TheoryRelation } from "#compiler/ir/law.ts"
import type { DeltaSide } from "#compiler/ir/rel.ts"
import { rosterOf, type ScalarType, sameScalarType } from "#compiler/ir/scalar.ts"
import type { FrozenUnit, StoredUnit, Unit } from "#compiler/ir/unit.ts"
import type { OwnedStatement } from "#compiler/schema/own.ts"

/** The name the region delivers position `j` of the unit key under. */
const unitColumn = (j: number): string => `u${j}`

/** The variable a region's rule binds position `j` of the unit key to. */
const regionVar = (j: number): string => `unit.${j}`

/**
 * How a walk restricts what it reads to the units a transaction wrote (`Walk`):
 *
 * - `deciding`: not at all, the walk that decides whether the query is unit-local (`unitAt`);
 * - `region`: at the root, where no rule binds the unit yet: an outermost rule that reads a stored relation itself
 *   matches the region and is read per unit as a step (`unitStep`);
 * - `bound`: inside such a step, whose channels hold one unit at a time: every rule there reads its unit from them,
 *   through the import that joins it or the negation correlated at them, so it matches no region of its own, which
 *   would be read again for every unit of the region outside; a recursion, which PostgreSQL computes whole whatever
 *   restricts what reads it, still reads the region (`unitLocalRecursion`).
 */
type Restriction =
	| { readonly kind: "deciding" }
	| { readonly kind: "region" | "bound"; readonly region: InferredSource }

const deciding: Restriction = { kind: "deciding" }

/**
 * What a walk of a query reads (`walked`): the stored relations that may hold its unit, each with the leading key
 * fields that hold it; how it restricts what it reads (`Restriction`); and every occurrence of a stored relation the
 * walk meets, in the order it meets them.
 */
interface Walk {
	readonly holders: ReadonlyMap<string, NonEmptyReadonlyArray<string>>
	readonly restrict: Restriction
	readonly reads: Array<RelationRead>
	/** Every occurrence of a unit's holder the walk meets, with the conditions on its own row (`RegionRead`). */
	readonly regions: Array<RegionRead>
	/** The fields of the row of the recursion whose step the walk reads, where it reads one, that hold its unit. */
	readonly self: ReadonlyArray<string> | undefined
	/** The query each copy the walk makes of a query was walked from (`walked`, WholeRule `definitionOf`). */
	readonly definitions: WeakMap<InferredQuery, InferredQuery>
	/** How it reads a declared function's call (`CallAdmission`). */
	readonly calls: CallAdmission
}

/**
 * How a walk reads a declared function's call: `rule`, as a rule's discharge always has, a call term through its
 * arguments and a call source as a source no unit holds; `stored`, a stored relation's admission (`storedUnit`), whose
 * every call is of a function immutable throughout, which it checks before the walk, a call admitted where it passes no
 * rows and no relation's existence, a call source then read as a function of the binding it stands at, which the rule's
 * other sources give its unit, as a text's tokens are.
 */
type CallAdmission = "rule" | "stored"

/** Whether `e` reads a relation's existence or absence at any depth: no value of the binding it stands at alone. */
const readsRelation = (e: InferredExpr): boolean =>
	e.kind === "absent" || e.kind === "exists" || exprChildren(e).some((c) => readsRelation(c.term))

/**
 * Why a call of `fn` with `args` is no unit-local read under `w` (`CallAdmission`), none where it is one. A rule's walk
 * admits a call term (`source` false) and reads no call source; a stored relation's admits either where every argument
 * is a value of the binding.
 */
const callUnfit = (
	fn: string,
	args: ReadonlyArray<InferredExpr | { readonly kind: "rows" }>,
	source: boolean,
	w: Walk
): NotLocal | undefined => {
	switch (w.calls) {
		case "rule":
			return source
				? lacking("shape", `it reads a call of ${fn} as a source, which no unit holds`)
				: undefined
		case "stored":
			return args.some((a) => a.kind === "rows" || readsRelation(a))
				? lacking(
						"call",
						`its call of ${fn} passes rows or a relation's existence, which no binding holds`
					)
				: undefined
	}
}

/** Where a walk stands in its query: the polarity of what it reads there. */
interface At {
	readonly polarity: RelationRead["polarity"]
}

/** The polarity a query's breaking facts are read at: positive, at its top. */
const top: At = { polarity: "positive" }

/** A polarity under a negation: positive and negative trade places, and both stays both. */
const flipped = (p: RelationRead["polarity"]): RelationRead["polarity"] =>
	p === "positive" ? "negative" : p === "negative" ? "positive" : "both"

/**
 * That a query is not unit-local, at which the walk stops: the first condition of unit-locality it met that the query
 * lacks (core/causes.ts UnitLocality), which a stored relation's admission refuses by (`storedUnit`) and a rule's
 * discharge reads only as "not whole" (`wholeRule`).
 */
class NotLocal {
	readonly lacks: UnitLocality
	constructor(lacks: UnitLocality) {
		this.lacks = lacks
	}
}

/** The query lacks `condition`, as `detail` names where. */
const lacking = (condition: UnitLocality["condition"], detail: string): NotLocal =>
	new NotLocal({ condition, detail })

/**
 * How a query delivers the units of its facts to a rule that matches or negates it: `none`, it reads no stored relation,
 * so its facts are the same at every state; `at` its head fields, every fact within the unit those fields hold; or
 * `hidden`, every fact within one unit, which no head field holds, so a rule that reads it with any other unit's facts
 * cannot keep the two in one unit.
 */
type Delivered =
	| { readonly kind: "none" }
	| { readonly kind: "at"; readonly fields: ReadonlyArray<string> }
	| { readonly kind: "hidden" }

const noUnit: Delivered = { kind: "none" }
const hiddenUnit: Delivered = { kind: "hidden" }

/** Whether two deliveries are one. */
const sameDelivery = (a: Delivered, b: Delivered): boolean =>
	a.kind === b.kind && (a.kind !== "at" || (b.kind === "at" && sameOrder(a.fields, b.fields)))

/**
 * A query as a walk leaves it: its text, and how it delivers its facts' units. A walk shares every part of the text it
 * leaves as it was, the query itself where it changes nothing, so a query the laws' violations import, read by each law
 * live as one (query.ts liveReading), is one query in every statement the judge navigates (navigate.ts boundInside).
 */
interface Walked {
	readonly query: InferredQuery
	readonly delivered: Delivered
}

/** The variables `bindings` binds `fields` to, in order, where each is a variable; `read` names the match. */
const varsAt = (
	bindings: Readonly<Record<string, InferredExpr>>,
	fields: ReadonlyArray<string>,
	read: string
): ReadonlyArray<string> | NotLocal => {
	const out: Array<string> = []
	for (const f of fields) {
		const e = bindings[f]
		if (e?.kind !== "var") {
			return lacking(
				"split",
				`${read} binds its unit field ${f} to ${e === undefined ? "nothing" : "no variable"}, so it reads beyond one unit`
			)
		}
		out.push(e.var)
	}
	return out
}

/**
 * The unit a source gives the rule that matches or negates it: `none`, a closed relation or a query that reads no
 * stored relation; `vars`, the rule's variables a stored relation's leading key fields, or an imported query's head
 * fields that deliver its unit, are bound to; or `hidden`, an imported query whose head delivers no unit.
 */
type SourceUnit =
	| { readonly kind: "none" }
	| { readonly kind: "vars"; readonly vars: ReadonlyArray<string> }
	| { readonly kind: "hidden" }

/**
 * One occurrence of a unit's holder in a whole rule's violation query, as the region reads its writes: its relation,
 * the polarity it is read at, and the conditions its reading states of its row alone, over the row's fields: a field
 * its match binds to a literal, two it binds to one variable, and each condition of the rule that reads only
 * variables the match binds. A row of the relation that fails them gives the occurrence no fact, so writing it changes
 * nothing the occurrence reads, and its unit is no unit the occurrence needs judged.
 */
interface RegionRead {
	readonly relation: string
	readonly polarity: RelationRead["polarity"]
	readonly where: ReadonlyArray<InferredExpr>
	/** Each field its match binds to a variable, with that variable. */
	readonly bound: Readonly<Record<string, string>>
	/**
	 * The place among the walk's occurrences (Walk `regions`) of every other occurrence of a holder its rule matches
	 * beside it, at its polarity: each fact the occurrence reads holds a row of each of them, at the variables they
	 * share.
	 */
	readonly beside: ReadonlyArray<number>
}

/** The fields `bindings` binds to a variable, with the variable. */
const boundVars = (
	bindings: Readonly<Record<string, InferredExpr>>
): Readonly<Record<string, string>> =>
	Object.fromEntries(
		Object.entries(bindings).flatMap(([field, e]) =>
			e.kind === "var" ? [[field, e.var] as const] : []
		)
	)

/** A field of the row a region reads, as a condition of it names it. */
const rowField = (field: string): InferredExpr => ({ kind: "field", field })

/** Whether `e` reads only the variables `bound` holds, and no parameter or source. */
const readsOnly = (e: InferredExpr, bound: ReadonlyMap<string, string>): boolean => {
	switch (e.kind) {
		case "absent":
		case "exists":
		case "param":
			return false
		case "var":
			return bound.has(e.var)
		case "field":
		case "value":
		case "parent":
		case "literal":
		case "compute":
		case "cast":
		case "base":
		case "retype":
		case "guarded":
		case "cond":
		case "when":
		case "compare":
		case "between":
		case "in":
		case "and":
		case "or":
		case "not":
		case "allen":
		case "pointIn":
		case "closedAt":
		case "closedRow":
		case "closedHas":
		case "call":
			return exprChildren(e).every((c) => readsOnly(c.term, bound))
	}
}

/**
 * The conditions an occurrence's reading states of its row alone (`RegionRead`), from its bindings and `where`, the
 * conditions of the rule that matches it, none for a negation's beyond its bindings.
 */
const rowConditions = (
	bindings: Readonly<Record<string, InferredExpr>>,
	where: ReadonlyArray<InferredExpr>
): ReadonlyArray<InferredExpr> => {
	const fieldOf = new Map<string, string>()
	const conditions: Array<InferredExpr> = []
	for (const [field, e] of Object.entries(bindings)) {
		if (e.kind === "literal") {
			conditions.push({ kind: "compare", op: "eq", left: rowField(field), right: e })
		} else if (e.kind === "var") {
			const first = fieldOf.get(e.var)
			if (first === undefined) {
				fieldOf.set(e.var, field)
			} else {
				conditions.push({
					kind: "compare",
					op: "eq",
					left: rowField(first),
					right: rowField(field)
				})
			}
		}
	}
	const leaves: LeafRewrite = {
		var: (id) => {
			const field = fieldOf.get(id)
			return field === undefined ? undefined : rowField(field)
		},
		field: () => undefined
	}
	for (const c of where) {
		if (readsOnly(c, fieldOf)) {
			conditions.push(mapLeaves(c, leaves))
		}
	}
	return conditions
}

/** What a source delivers to the rule that reads it: its unit, and its text walked. */
interface SourceRead {
	readonly unit: SourceUnit
	readonly source: InferredSource
}

/**
 * A source read where a rule matches or negates it with `bindings`, at `at` (`SourceRead`), the reading rule stating
 * `where` of it: a stored relation by its leading key fields; an imported query of no bind map walked, by the head
 * fields that deliver its unit; a closed relation by none, and a text's tokens by none, a function of the binding it
 * stands at, which the rule's other sources give its unit; not unit-local for any other source. Every occurrence of a
 * stored or closed relation is read, and every occurrence of a holder with the conditions on its row (`RegionRead`).
 */
const sourceUnit = (
	source: InferredSource,
	bindings: Readonly<Record<string, InferredExpr>>,
	where: ReadonlyArray<InferredExpr>,
	at: At,
	w: Walk
): SourceRead | NotLocal => {
	switch (source.kind) {
		case "relation": {
			w.reads.push({
				relation: source.name,
				polarity: at.polarity,
				columns: Object.keys(bindings).toSorted(compareStrings)
			})
			const fields = w.holders.get(source.name)
			if (fields === undefined) {
				return { unit: { kind: "none" }, source }
			}
			w.regions.push({
				relation: source.name,
				polarity: at.polarity,
				where: rowConditions(bindings, where),
				bound: boundVars(bindings),
				beside: []
			})
			const vars = varsAt(bindings, fields, `a match of ${source.name}`)
			return vars instanceof NotLocal ? vars : { unit: { kind: "vars", vars }, source }
		}
		case "query": {
			if (Object.keys(source.bind).length > 0) {
				return lacking("shape", "it reads a query under a bind map")
			}
			const inner = walked(source.query, at, w)
			if (inner instanceof NotLocal) {
				return inner
			}
			const bind = passedChannels(inner.query)
			const read =
				inner.query === source.query && Object.keys(bind).length === 0
					? source
					: { ...source, query: inner.query, bind }
			const delivered = inner.delivered
			switch (delivered.kind) {
				case "none":
					return { unit: { kind: "none" }, source: read }
				case "hidden":
					return { unit: { kind: "hidden" }, source: read }
				case "at": {
					const vars = varsAt(bindings, delivered.fields, "a match of a query it imports")
					return vars instanceof NotLocal ? vars : { unit: { kind: "vars", vars }, source: read }
				}
			}
		}
		case "self": {
			if (w.self === undefined) {
				return lacking("recursion", "it reads self outside a recursion's step")
			}
			const vars = varsAt(bindings, w.self, "a step's read of self")
			return vars instanceof NotLocal ? vars : { unit: { kind: "vars", vars }, source }
		}
		case "split":
		case "series":
			return { unit: { kind: "none" }, source }
		case "call":
		case "callField": {
			const unfit = callUnfit(source.function, Object.values(source.args), true, w)
			return unfit ?? { unit: { kind: "none" }, source }
		}
		case "step":
		case "param":
		case "paramOf":
		case "interior":
		case "delta":
		case "context":
		case "row":
			return lacking("shape", `it reads a ${source.kind} source, which no unit holds`)
	}
}

/**
 * Expressions walked (`walkedExpr`), in order, or not unit-local where one is not.
 */
const walkedExprs = (
	xs: ReadonlyArray<InferredExpr>,
	unit: ReadonlyArray<string> | undefined,
	at: At,
	w: Walk
): ReadonlyArray<InferredExpr> | NotLocal => {
	const out: Array<InferredExpr> = []
	for (const x of xs) {
		const r = walkedExpr(x, unit, at, w)
		if (r instanceof NotLocal) {
			return r
		}
		out.push(r)
	}
	return out
}

/**
 * An expression walked: every relational filter in it, at any depth, its source walked under the filter, a negation's
 * at the flipped polarity and an existence's at the rule's own, and its unit, where it reads one, the rule's own,
 * `unit`, at which it is correlated, so the facts it reads lie in the rule's unit.
 */
const walkedExpr = (
	e: InferredExpr,
	unit: ReadonlyArray<string> | undefined,
	at: At,
	w: Walk
): InferredExpr | NotLocal => {
	if (e.kind === "absent" || e.kind === "exists") {
		const polarity = e.kind === "absent" ? flipped(at.polarity) : at.polarity
		const read = sourceUnit(e.source, e.bindings, [], { polarity }, w)
		if (read instanceof NotLocal) {
			return read
		}
		const correlated =
			read.unit.kind === "none" ||
			(read.unit.kind === "vars" && unit !== undefined && sameOrder(read.unit.vars, unit))
		if (!correlated) {
			const what = e.source.kind === "relation" ? `of ${e.source.name}` : "of a query"
			return e.kind === "absent"
				? lacking("negation", `a negation ${what} is not correlated at the unit`)
				: lacking("negation", `an existence ${what} is not correlated at the unit`)
		}
		return read.source === e.source ? e : { ...e, source: read.source }
	}
	if (e.kind === "call") {
		const unfit = callUnfit(e.function, Object.values(e.args), false, w)
		if (unfit !== undefined) {
			return unfit
		}
	}
	const children: { lacks: NotLocal | undefined; changed: boolean } = {
		lacks: undefined,
		changed: false
	}
	const each = mapExprChildren(e, (x) => {
		const r = walkedExpr(x, unit, at, w)
		if (r instanceof NotLocal) {
			children.lacks ??= r
			return x
		}
		children.changed ||= r !== x
		return r
	})
	return children.lacks ?? (children.changed ? each : e)
}

/** A rule as a walk leaves it: its text, and how it delivers its facts' units. */
interface WalkedRule {
	readonly rule: InferredRule
	readonly delivered: Delivered
	/** The variables its sources bind its unit to, none where it reads no unit or a hidden one. */
	readonly unit: ReadonlyArray<string> | undefined
}

/** A rule's matches and conditions as a walk leaves them, and the unit its sources bind (`walkedRule`). */
interface RuleBody {
	readonly matches: ReadonlyArray<InferredMatch>
	readonly where: ReadonlyArray<InferredExpr>
	readonly unit: ReadonlyArray<string> | undefined
	readonly hidden: boolean
}

/**
 * A rule's matches and conditions walked under `w` (`walkedRule`): its unit is its sources' (`SourceUnit`), every
 * source that gives variables giving the same ones; a source whose unit is hidden is its only source with a unit, and
 * its facts each lie within one unit hidden in turn, so it negates nothing of a unit and aggregates nothing; and each
 * negation in its conditions is correlated at its unit.
 */
const ruleBody = (r: InferredRule, at: At, aggregates: boolean, w: Walk): RuleBody | NotLocal => {
	const units: Array<SourceUnit> = []
	const matches: Array<InferredMatch> = []
	/** Where in `w.regions` each holder this rule matches itself stands, its own occurrences beside one another. */
	const own: Array<number> = []
	for (const match of r.matches) {
		const before = w.regions.length
		const read = sourceUnit(match.source, match.bindings, r.where, at, w)
		if (read instanceof NotLocal) {
			return read
		}
		if (match.source.kind === "relation" && w.regions.length === before + 1) {
			own.push(before)
		}
		units.push(read.unit)
		matches.push(read.source === match.source ? match : { ...match, source: read.source })
	}
	for (const [j, i] of own.entries()) {
		const occurrence = defined(w.regions[i], "an occurrence this rule matches")
		w.regions[i] = { ...occurrence, beside: own.filter((_, k) => k !== j) }
	}
	const bearing = units.filter((u) => u.kind !== "none")
	const hidden = bearing.some((u) => u.kind === "hidden")
	if (hidden && (bearing.length > 1 || aggregates)) {
		return lacking(
			"hidden",
			aggregates
				? "an aggregate reads a query whose head hides its unit"
				: "a rule reads a query whose head hides its unit beside another read of a unit"
		)
	}
	const vars = bearing.flatMap((u) => (u.kind === "vars" ? [u.vars] : []))
	const [unit] = vars
	if (unit !== undefined && !vars.every((v) => sameOrder(v, unit))) {
		return lacking("split", "a rule's matches bind their unit fields to different variables")
	}
	const where = walkedExprs(r.where, unit, at, w)
	return where instanceof NotLocal ? where : { matches, where, unit, hidden }
}

/**
 * A rule walked (`ruleBody`). An aggregating rule's matches are read at both polarities and its head delivers its unit,
 * so its groups lie inside one unit. Where the walk restricts at the root and the rule binds a unit, from a stored
 * relation it matches or a query that delivers one, the region is matched first, bound to its unit, and the rule is
 * read per unit (`unitStep`), every rule its imports and its negations read walked with the unit bound
 * (`Restriction`): the unit is bound once, by the outermost rule that binds it, so the two sides of a containment
 * between two queries are read inside one step, not each per unit of a region of its own. A rule at the root that
 * binds no unit, which reads closed relations alone or a query whose unit is hidden, leaves the root's restriction to
 * the rules it reads.
 */
const walkedRule = (r: InferredRule, outer: At, w: Walk): WalkedRule | NotLocal => {
	if (r.interiors.length > 0 || r.attach.length > 0) {
		return lacking("shape", "a rule nests or attaches a query")
	}
	const aggregates = Object.values(r.head).some((h) => h.kind === "aggregate")
	const at: At = aggregates ? { polarity: "both" } : outer
	const restriction = w.restrict
	const bound =
		restriction.kind === "region"
			? ruleBody(r, at, aggregates, {
					...w,
					restrict: { kind: "bound", region: restriction.region }
				})
			: ruleBody(r, at, aggregates, w)
	if (bound instanceof NotLocal) {
		return bound
	}
	const body =
		restriction.kind === "region" && bound.unit === undefined
			? ruleBody(r, at, aggregates, w)
			: bound
	if (body instanceof NotLocal) {
		return body
	}
	const { matches, where, unit } = body
	const walkedText: InferredRule =
		sameOrder(matches, r.matches) && sameOrder(where, r.where) ? r : { ...r, matches, where }
	if (unit === undefined) {
		return {
			rule: walkedText,
			delivered: body.hidden ? hiddenUnit : noUnit,
			unit: undefined
		}
	}
	const fields = unit.flatMap((v) => {
		const field = Object.entries(r.head).find(([, h]) => h.kind === "var" && h.var === v)?.[0]
		return field === undefined ? [] : [field]
	})
	const delivered: Delivered = fields.length === unit.length ? { kind: "at", fields } : hiddenUnit
	if (aggregates && delivered.kind !== "at") {
		return lacking("aggregate", "an aggregate's groups do not hold the unit")
	}
	return {
		rule:
			restriction.kind === "region" ? unitStep(walkedText, unit, restriction.region) : walkedText,
		delivered,
		unit
	}
}

/**
 * The bind map of an import whose query, walked with the unit bound (`Restriction`), reads the channels of the step it
 * stands in, a recursion's seeds and steps reading the unit there: each channel it reads bound to the importer's own of
 * that name, so the step's channels reach it, as an imported query's parameters are bound only by its bind map. A
 * violation query reads no parameter of its own, so every parameter a walked query reads is a channel; none for a query
 * that reads none.
 */
const passedChannels = (query: InferredQuery): Readonly<Record<string, InferredExpr>> =>
	Object.fromEntries(
		[...queryParamNames(query)].map((name): readonly [string, InferredExpr] => [
			name,
			{ kind: "param", name, type: { kind: "channel" } }
		])
	)

/** The channel a rule read per unit binds position `j` of its unit key to (`unitStep`). */
const unitParam = (j: number): InferredExpr => ({
	kind: "param",
	name: `unit${j}`,
	type: { kind: "channel" }
})

/** The variable a rule read per unit delivers its head field `field` in. */
const deliveredVar = (field: string): string => `delivered.${field}`

/**
 * A rule read per unit of the region: the region's keys first, each bound to the rule's unit variables, then the rule
 * itself as a step (ir/desc.ts SourceDesc `step`), its unit variables its channels (`channelled`), which the step's bind
 * map binds to the region's keys, delivering its head (`readPerUnit`). A step is a subquery PostgreSQL never pulls up,
 * read LATERAL after the region (lower/conservative/step), so the rule runs once per unit the transaction wrote, its
 * every read an index range at that unit's key, and an aggregate or a negation in it reads that unit alone, whatever
 * PostgreSQL estimates of the region.
 */
const unitStep = (
	r: InferredRule,
	unit: ReadonlyArray<string>,
	region: InferredSource
): InferredRule =>
	readPerUnit(
		queryOf([channelled(r, unit)], r.loc),
		r.vars.filter((v) => unit.includes(v.id)),
		Object.keys(r.head),
		region,
		r.loc
	)

/**
 * A rule with its unit's variables `unit` read as the channels a step's bind map binds them to, position by position,
 * wherever the rule reads them: its matches' bindings, the terms its sources take in its scope (ir/desc.ts
 * mapBindTerms: a call's arguments, a text's split, an import's bind map), its conditions and its head.
 */
const channelled = (r: InferredRule, unit: ReadonlyArray<string>): InferredRule => {
	const channels = new Map(unit.map((v, j) => [v, unitParam(j)] as const))
	const leaves: LeafRewrite = { var: (id) => channels.get(id), field: () => undefined }
	return {
		...r,
		vars: r.vars.filter((v) => !channels.has(v.id)),
		matches: r.matches.map((m) => ({
			...m,
			source: mapBindTerms(m.source, (e) => mapLeaves(e, leaves)),
			bindings: mapBindings(m.bindings, leaves)
		})),
		where: r.where.map((x) => mapLeaves(x, leaves)),
		head: Object.fromEntries(
			Object.entries(r.head).map(([field, h]): readonly [string, InferredHead] => [
				field,
				h.kind === "aggregate" || h.kind === "producer" ? h : mapLeaves(h, leaves)
			])
		)
	}
}

/**
 * The query `step`, every rule of which reads the unit at the channels, read per unit of the region: the region's keys
 * first, bound to `unit`'s variables, then `step` as a step whose bind map binds the channels to them, its facts'
 * `fields` delivered.
 */
const readPerUnit = (
	step: InferredQuery,
	unit: ReadonlyArray<VarDesc>,
	fields: ReadonlyArray<string>,
	region: InferredSource,
	loc: SourceLoc
): InferredRule => ({
	vars: [...unit, ...fields.map((f) => ({ id: deliveredVar(f), origin: undefined, loc }))],
	matches: [
		{
			source: region,
			bindings: Object.fromEntries(unit.map((v, j) => [unitColumn(j), varRef(v.id)] as const)),
			loc
		},
		{
			source: {
				kind: "step",
				query: step,
				bind: Object.fromEntries(unit.map((v, j) => [`unit${j}`, varRef(v.id)] as const))
			},
			bindings: Object.fromEntries(fields.map((f) => [f, varRef(deliveredVar(f))] as const)),
			loc
		}
	],
	where: [],
	head: Object.fromEntries(fields.map((f) => [f, varRef(deliveredVar(f))] as const)),
	interiors: [],
	attach: [],
	loc
})

/** The rules of a stage walked, with how they deliver their facts' units (`walkedRules`). */
interface WalkedStage {
	readonly rules: NonEmptyReadonlyArray<InferredRule>
	readonly delivered: Delivered
}

/**
 * How a union of facts delivered as `a` and as `b` delivers them: alike where they are one delivery; hidden where both
 * hold their facts within units, but not at the same fields; and not unit-local where one reads no unit and the other
 * does, whose facts no unit holds.
 */
const joinedDelivery = (a: Delivered, b: Delivered): Delivered | NotLocal => {
	if (sameDelivery(a, b)) {
		return a
	}
	return a.kind === "none" || b.kind === "none"
		? lacking("split", "a union's rule reads no stored relation beside one that reads a unit")
		: hiddenUnit
}

/** Rules of one stage walked, and how the union of their facts delivers its units (`joinedDelivery`). */
const walkedRules = (
	rules: NonEmptyReadonlyArray<InferredRule>,
	at: At,
	w: Walk
): WalkedStage | NotLocal => {
	const out: Array<WalkedRule> = []
	for (const r of rules) {
		const read = walkedRule(r, at, w)
		if (read instanceof NotLocal) {
			return read
		}
		out.push(read)
	}
	const [first, ...rest] = out
	if (first === undefined) {
		throw defect("a stage of at least one rule")
	}
	let delivered: Delivered | NotLocal = first.delivered
	for (const r of rest) {
		delivered = delivered instanceof NotLocal ? delivered : joinedDelivery(delivered, r.delivered)
	}
	return delivered instanceof NotLocal
		? delivered
		: { rules: mapNonEmpty([first, ...rest], (r) => r.rule), delivered }
}

/** Whether a rule reads self among its matches: a recursion's step, where the checker admits it (check/recursion). */
const readsSelf = (r: InferredRule): boolean => r.matches.some((m) => m.source.kind === "self")

/**
 * A recursion walked where it is unit-local, the one decision of it that both the admission (`wholeRule`) and the
 * restriction (`restrictToUnits`) read, through `walked`: its seeds, its base rules and every recursive rule that reads
 * no self, which the checker folds into the base (check/recursion/scan.ts), each walked as any rule is and delivering
 * the recursion's unit alike, at the fields `fields` of its row (`joinedDelivery`); and every step, a recursive rule that
 * reads self, carrying the unit: walked with self read at those fields (`sourceUnit`), its self match and every match of
 * a stored relation or a query binding the unit to one sequence of variables (`walkedRule`), and its head delivering
 * exactly those variables at those same fields (`carries`). Not unit-local where a seed delivers no unit or a hidden
 * one, or a step leaves it.
 *
 * Where the walk restricts, the recursion is read per unit of the region as one query (`readPerUnit`), every seed and
 * every step reading the unit at the channels (`channelled`): each read of a stored relation is then an index range at
 * the unit's key, the step's as well as the seed's, whatever PostgreSQL estimates of the working table. That is the
 * whole restriction of the fixed point: every state is derived from one seed by steps, each of which delivers the unit
 * it read from self, so every state holds its seed's unit, and the states of one unit are exactly the fixed point of the
 * seeds at that unit under the same steps, σ(lfp(B, T)) = lfp(σB, T) for σ over the carried unit fields; a step reads
 * the channel where it read self's unit, which every state it extends holds. No rule of the recursion is read per unit
 * on its own (`unitStep`): a step read so would nest self inside a subquery, which no recursion admits. A seed's bare
 * head literals are typed by the row's declared columns (`typedSeed`), as the checker types them in a recursion's arm.
 */
const unitLocalRecursion = (
	st: Extract<InferredStage, { readonly kind: "recursive" }>,
	at: At,
	w: Walk
): WalkedQueryStage | NotLocal => {
	const row = st.recursive.row
	const plain: Walk = { ...w, restrict: deciding }
	const read = new Map<InferredRule, WalkedRule>()
	let delivered: Delivered | NotLocal | undefined
	for (const r of [...st.recursive.base, ...st.recursive.rec.filter((x) => !readsSelf(x))]) {
		const seed = walkedRule(typedSeed(r, row), at, plain)
		if (seed instanceof NotLocal) {
			return seed
		}
		delivered =
			delivered === undefined
				? seed.delivered
				: delivered instanceof NotLocal
					? delivered
					: joinedDelivery(delivered, seed.delivered)
		read.set(r, seed)
	}
	if (delivered instanceof NotLocal) {
		return delivered
	}
	if (delivered?.kind !== "at") {
		return lacking("recursion", "a recursion's seeds deliver no unit at its row's fields")
	}
	const fields = delivered.fields
	const stepWalk: Walk = { ...plain, self: fields }
	for (const r of st.recursive.rec) {
		if (read.has(r)) {
			continue
		}
		const step = walkedRule(r, at, stepWalk)
		if (step instanceof NotLocal) {
			return step
		}
		if (!carries(step, fields)) {
			return lacking(
				"recursion",
				"a recursion's step does not carry the unit from self into its head"
			)
		}
		read.set(r, step)
	}
	const restrict = w.restrict
	const ruleOf = (r: InferredRule): InferredRule => {
		const walkedOne = defined(read.get(r), "a walked rule per rule of the recursion")
		return restrict.kind === "deciding" || walkedOne.unit === undefined
			? walkedOne.rule
			: channelled(walkedOne.rule, walkedOne.unit)
	}
	const recursion: InferredStage = {
		...st,
		recursive: {
			...st.recursive,
			base: mapNonEmpty(st.recursive.base, ruleOf),
			rec: mapNonEmpty(st.recursive.rec, ruleOf)
		}
	}
	if (restrict.kind !== "region") {
		return { stage: recursion, delivered }
	}
	const region = restrict.region
	const unit = fields.map((_, j): VarDesc => ({
		id: recursionUnitVar(j),
		origin: undefined,
		loc: st.loc
	}))
	return {
		stage: {
			kind: "rules",
			arms: [readPerUnit({ stage: recursion }, unit, Object.keys(row), region, st.loc)],
			loc: st.loc
		},
		delivered
	}
}

/** The variable a recursion read per unit binds position `j` of the region's unit key to (`unitLocalRecursion`). */
const recursionUnitVar = (j: number): string => `recursion.unit.${j}`

/** A seed with each bare literal of its head typed by the row's declared column of its field (`unitLocalRecursion`). */
const typedSeed = (r: InferredRule, row: Readonly<Record<string, FieldDesc>>): InferredRule => ({
	...r,
	head: Object.fromEntries(
		Object.entries(r.head).map(([field, h]): readonly [string, InferredHead] => {
			const declared = row[field]
			return [
				field,
				h.kind === "literal" && h.type === undefined && declared !== undefined
					? { ...h, type: declared }
					: h
			]
		})
	)
})

/** Whether a walked step carries its recursion's unit: its head delivers its unit's variables at exactly `fields`. */
const carries = (step: WalkedRule, fields: ReadonlyArray<string>): boolean => {
	const unit = step.unit
	return (
		unit !== undefined &&
		unit.length === fields.length &&
		fields.every((f, j) => {
			const h = step.rule.head[f]
			return h?.kind === "var" && h.var === unit[j]
		})
	)
}

/** A stage walked, and how it delivers its facts' units. */
interface WalkedQueryStage {
	readonly stage: InferredStage
	readonly delivered: Delivered
}

/**
 * A query walked (`Walked`): each rule of its rules and union stages, through a name, walked (`walkedRule`), a union's
 * input and arms joined (`joinedDelivery`); a recursion walked where it carries its unit through every step
 * (`unitLocalRecursion`); an order, a take, an approximation or an attachment is no unit-local query.
 */
const walked = (query: InferredQuery, at: At, w: Walk): Walked | NotLocal => {
	const stage = (st: InferredStage): WalkedQueryStage | NotLocal => {
		switch (st.kind) {
			case "rules": {
				const read = walkedRules(st.arms, at, w)
				return read instanceof NotLocal
					? read
					: {
							stage: sameOrder(read.rules, st.arms) ? st : { ...st, arms: read.rules },
							delivered: read.delivered
						}
			}
			case "union": {
				const input = stage(st.input)
				const read = walkedRules(st.arms, at, w)
				if (input instanceof NotLocal) {
					return input
				}
				if (read instanceof NotLocal) {
					return read
				}
				const delivered = joinedDelivery(input.delivered, read.delivered)
				return delivered instanceof NotLocal
					? delivered
					: {
							stage:
								input.stage === st.input && sameOrder(read.rules, st.arms)
									? st
									: { ...st, input: input.stage, arms: read.rules },
							delivered
						}
			}
			case "named": {
				const input = stage(st.input)
				return input instanceof NotLocal
					? input
					: {
							stage: input.stage === st.input ? st : { ...st, input: input.stage },
							delivered: input.delivered
						}
			}
			case "recursive":
				return unitLocalRecursion(st, at, w)
			case "attach":
			case "order":
			case "take":
			case "approx":
				return lacking("shape", `it reads a query of an ${st.kind} stage`)
		}
	}
	const read = stage(query.stage)
	if (read instanceof NotLocal) {
		return read
	}
	return {
		query: read.stage === query.stage ? query : copied(query, read.stage, w),
		delivered: read.delivered
	}
}

/** A copy of `query` at the stage a walk leaves it (`walked`), recorded as walked from `query` (Walk `definitions`). */
const copied = (query: InferredQuery, stage: InferredStage, w: Walk): InferredQuery => {
	const copy: InferredQuery = { ...query, stage }
	w.definitions.set(copy, query)
	return copy
}

/** A unit's holders by relation, each with its leading key fields. */
const holdersOf = (unit: Unit): ReadonlyMap<string, NonEmptyReadonlyArray<string>> =>
	new Map(unit.holders.map((h) => [h.relation, h.fields] as const))

/** The variable a region's rule binds `field` of a written row to, beside its unit key's (`regionOf`). */
const rowVar = (field: string): string => `row.${field}`

/** The sides of a relation's writes an occurrence read at `polarity` needs: what it gains where it is read positively,
 * what it loses where negatively, both where either changes it. */
const sidesAt = (polarity: RelationRead["polarity"]): ReadonlyArray<DeltaSide> => {
	switch (polarity) {
		case "positive":
			return ["added"]
		case "negative":
			return ["removed"]
		case "both":
			return ["added", "removed"]
	}
}

/**
 * A containment the schema states between the fields of two stored relations over the rows of its source its
 * selection admits (`regionFactsOf`): each row of `from` every conjunct of `selection` holds of, every row where it
 * states none, holds at `pairs[i].from` the values some row of `to` holds at `pairs[i].to`. A law, it holds in every
 * committed state: the migration that adds it checks every row, and every COMMIT after holds it, whatever discharges
 * it, its foreign key or the rule judge.
 */
export interface FieldContainment {
	readonly from: string
	readonly to: string
	readonly pairs: NonEmptyReadonlyArray<{ readonly from: string; readonly to: string }>
	/** The conjuncts of its source's selection, each a predicate of a row of `from` over its fields. */
	readonly selection: ReadonlyArray<ExprDesc>
}

/** What a whole rule's region reads of the schema's laws (`regionOf`): each containment over the rows of its source its
 * selection admits, and each tree's root fields by its relation (`witnessesOf`); and what navigation orders a chain by
 * (analysis/theory/navigate.ts Navigation `narrower`), those containments and each stored relation's keys. */
export interface RegionFacts {
	readonly containments: ReadonlyArray<FieldContainment>
	/**
	 * Each stored relation's keys over every row, by the relation: its primary key, then each candidate key a statement
	 * of the schema states of it, each once. A lookup bound at every field of one reads one row at most.
	 */
	readonly keys: ReadonlyMap<string, NonEmptyReadonlyArray<NonEmptyReadonlyArray<string>>>
	/**
	 * Each relation a tree statement states the tree of, `tree(on(T, parent, at), fin(T, n), { root: [r…] })`, with its
	 * root fields r…, which its primary key (r…, start) leads with (analysis/theory/families.ts treeShape): its rows at
	 * one value of r… are one tree, its every row but its root a member of its parent at one slot below its count.
	 */
	readonly roots: ReadonlyMap<string, NonEmptyReadonlyArray<string>>
	/**
	 * Each stored relation that sits in a declared unit, by name, with the unit and the fields its primary key leads
	 * with (schema/own.ts unitOf): every write of its rows borrows that unit at their key exclusively, so its rows at a
	 * unit a transaction writes are the transaction's own until it commits (`declaredOf`).
	 */
	readonly members: ReadonlyMap<string, DeclaredMember>
}

/**
 * The containments derived relation `name`'s definition states of it into a relation it reads (`regionFactsOf`): D(F) ⊆
 * N(G) wherever every rule of its one rules stage matches N, stored or derived, by a match that binds each field of G
 * to the variable the rule's head delivers at the paired field of F, the pairs every rule's match binds alike. Each row
 * of D is a rule's fact, derived from a row n of N its match reads, and the rule delivers at each field of F the
 * variable the match binds at its pair in G, so the row holds at F the values n holds at G. The first rule's matches of
 * N each start a candidate, which each later rule narrows to the pairs of its match that keeps the most of them; a
 * definition of another stage, a recursion or an order, states none.
 */
const definedOf = (
	name: string,
	query: QueryDesc,
	held: (name: string) => boolean
): ReadonlyArray<FieldContainment> => {
	const stage = query.stage
	if (stage.kind !== "rules") {
		return []
	}
	/** The pairs of D's head fields and N's fields a rule's match `m` binds alike. */
	const pairsOf = (
		rule: RuleDesc,
		m: MatchDesc
	): ReadonlyArray<{ readonly from: string; readonly to: string }> =>
		Object.entries(rule.head).flatMap(([from, h]) =>
			h.kind === "var"
				? Object.entries(m.bindings).flatMap(([to, b]) =>
						b.kind === "var" && b.var === h.var ? [{ from, to }] : []
					)
				: []
		)
	const same = (
		a: { readonly from: string; readonly to: string },
		b: { readonly from: string; readonly to: string }
	) => a.from === b.from && a.to === b.to
	const [first, ...rest] = stage.arms
	return first.matches.flatMap((m) => {
		const n = m.source.kind === "relation" ? m.source.name : undefined
		if (n === undefined || !held(n)) {
			return []
		}
		const pairs = rest.reduce(
			(kept, rule) =>
				rule.matches
					.filter((o) => o.source.kind === "relation" && o.source.name === n)
					.map((o) => kept.filter((p) => pairsOf(rule, o).some((q) => same(p, q))))
					.reduce<ReadonlyArray<{ readonly from: string; readonly to: string }>>(
						(best, next) => (next.length > best.length ? next : best),
						[]
					),
			pairsOf(first, m)
		)
		return isNonEmpty(pairs) ? [{ from: name, to: n, pairs, selection: [] }] : []
	})
}

/** The containments one statement states between stored relations (`regionFactsOf`), each a FieldContainment. */
const statedOf = (
	s: OwnedStatement,
	stored: (name: string) => RelationInfo | undefined,
	held: (name: string) => boolean
): ReadonlyArray<FieldContainment> => {
	switch (s.kind) {
		case "contained": {
			const pairs = s.pairs.flatMap((p) =>
				p.left.kind === "field" && p.right.kind === "field"
					? [{ from: p.left.field, to: p.right.field }]
					: []
			)
			return stored(s.left.relation) !== undefined &&
				held(s.right.relation) &&
				isNonEmpty(pairs) &&
				pairs.length === s.pairs.length
				? [
						{
							from: s.left.relation,
							to: s.right.relation,
							pairs,
							selection: s.left.selection.conjuncts
						}
					]
				: []
		}
		case "family":
		case "tree": {
			const member = stored(s.member.relation)
			const owner = stored(s.slots.owner)
			if (member === undefined || owner === undefined) {
				return []
			}
			const group =
				s.kind === "family"
					? s.member.terms.slice(0, owner.primaryFields.length)
					: [
							...s.root.map((field): TermDesc => ({ kind: "field", field })),
							...s.member.terms.slice(0, 1)
						]
			const pairs = owner.primaryFields.flatMap((key, j) => {
				const term = group[j]
				return term?.kind === "field" ? [{ from: term.field, to: key.name }] : []
			})
			return isNonEmpty(pairs) && pairs.length === owner.primaryFields.length
				? [{ from: member.name, to: owner.name, pairs, selection: [] }]
				: []
		}
		case "key":
		case "mutable":
		case "race":
		case "check":
		case "fold":
		case "alternatives":
		case "unit":
		case "series":
			return []
	}
}

/** A containment's relations and field pairs as one text: what two canonically equal containments share. */
const pairedKey = (c: FieldContainment): string =>
	[c.from, c.to, ...c.pairs.flatMap((p) => [p.from, p.to])].join("\u0000")

/**
 * The containments `statements` state over the rows of a stored relation its source's selection admits, field by field
 * into a stored relation (`RegionFacts`), and every one they compose to:
 *
 * - a `contained` statement whose source is a stored relation (`stored`) and whose target is a stored or a derived
 *   one, at its pairs of a field on each side, its source's selection its own (FieldContainment `selection`), its
 *   target selecting rows or not, since a row in a selection of `to` is a row of `to`;
 * - a derived relation into each relation every rule of its definition matches at the fields its head delivers there
 *   (`definedOf`), so a containment into a derived relation composes into the relations its definition reads;
 * - a family's member relation at its group into its owner at the owner's primary key, the group's j-th field paired
 *   with the key's j-th, as counted(on(F, g…), fin(O, n)) and ordered(on(F, g…, i), fin(O, n)) pair them
 *   (analysis/theory/families.ts familyShape), over every row of F: every member names its owner, a law every
 *   committed state holds, whatever discharges it; and a tree's relation into itself at its root fields and its parent
 *   paired with its root fields and its start (treeShape), over every row: every member's parent is a row of its tree,
 *   and each root is its own parent;
 * - and E ⊆ N wherever E ⊆ M and M ⊆ N hold, M ⊆ N over every row of M, at each pair of M ⊆ N whose field of M one of
 *   E ⊆ M's pairs reaches, over the rows of E E ⊆ M's selection admits (`composed`).
 *
 * A containment holds at any of its pairs alone, its projection: each row of its source meets a row of its target at
 * every pair, and so at those kept. So a composition keeps the pairs of M ⊆ N that E ⊆ M reaches, where it reaches
 * one, and a witness reads a containment at the pairs its two occurrences bind alike (`witnessesOf`). A statement with
 * a pred term holds only of the rows whose predecessor is defined, a condition none of its field pairs states, so it
 * states no fact a region reads. A containment of a relation into itself at its own fields
 * states nothing and is not held. In statement order, then each composition in the order the closure meets it, each
 * containment once. Beside them, each tree statement's stored relation with its root fields (RegionFacts `roots`),
 * and each stored relation's keys, its primary key and each candidate key a statement states of it (RegionFacts
 * `keys`).
 */
export const regionFactsOf = (
	statements: ReadonlyArray<OwnedStatement>,
	relations: ReadonlyMap<string, TheoryRelation>,
	definitions: ReadonlyMap<string, QueryDesc>,
	members: ReadonlyMap<string, DeclaredMember>
): RegionFacts => {
	const stored = (name: string): RelationInfo | undefined => {
		const r = relations.get(name)
		return r?.kind === "relation" ? r : undefined
	}
	const known = (name: string): boolean => stored(name) !== undefined || definitions.has(name)
	const stated = [
		...statements.flatMap((s) => statedOf(s, stored, known)),
		...[...definitions].flatMap(([name, query]) => definedOf(name, query, known))
	]
	const containments: Array<FieldContainment> = []
	/**
	 * The containments held, by their relations and field pairs (`pairedKey`): one held is another only where both are
	 * alike, so a containment is compared, by canonical equality, with the few held at its own pairs alone.
	 */
	const heldAt = new Map<string, Array<FieldContainment>>()
	const hold = (c: FieldContainment): void => {
		const states = c.from !== c.to || c.pairs.some((p) => p.from !== p.to)
		if (!states) {
			return
		}
		const key = pairedKey(c)
		const alike = heldAt.get(key) ?? []
		if (alike.some((held) => canonicalEquals(held, c))) {
			return
		}
		alike.push(c)
		heldAt.set(key, alike)
		containments.push(c)
	}
	stated.forEach(hold)
	/** The stated containments over every row of their source, by it: each a second a composition reads (`composed`). */
	const everyRowOf = Map.groupBy(
		stated.filter((s) => s.selection.length === 0),
		(s) => s.from
	)
	for (let at = 0; at < containments.length; at++) {
		const first = defined(containments[at], "a containment the closure holds")
		for (const second of everyRowOf.get(first.to) ?? []) {
			const c = composed(first, second)
			if (c !== undefined) {
				hold(c)
			}
		}
	}
	const roots = new Map(
		statements.flatMap((s) =>
			s.kind === "tree" && stored(s.member.relation) !== undefined
				? [[s.member.relation, s.root] as const]
				: []
		)
	)
	const candidates = Map.groupBy(
		statements.flatMap((s) =>
			s.kind === "key" && s.key.kind === "candidate"
				? [[s.side.relation, s.key.key.fields] as const]
				: []
		),
		([relation]) => relation
	)
	const keys = new Map(
		[...relations.values()].flatMap((r) => {
			if (r.kind !== "relation") {
				return []
			}
			const held: [NonEmptyReadonlyArray<string>, ...Array<NonEmptyReadonlyArray<string>>] = [
				mapNonEmpty(r.primaryFields, (f) => f.name)
			]
			for (const [, key] of candidates.get(r.name) ?? []) {
				if (!held.some((k) => k.length === key.length && key.every((f) => k.includes(f)))) {
					held.push(key)
				}
			}
			return [[r.name, held] as const]
		})
	)
	return { containments, roots, keys, members }
}

/** E ⊆ N from E ⊆ M (`first`) and M ⊆ N (`second`), a containment over every row of M (`regionFactsOf` reads each
 * stated one out of first's target), over the rows of E `first`'s selection admits, at the pairs of `second` whose
 * field of M one of `first`'s pairs reaches, its projection there, where `first` reaches one. */
const composed = (
	first: FieldContainment,
	second: FieldContainment
): FieldContainment | undefined => {
	const pairs = second.pairs.flatMap((p) => {
		const from = first.pairs.find((q) => q.to === p.from)
		return from === undefined ? [] : [{ from: from.from, to: p.to }]
	})
	return isNonEmpty(pairs)
		? { from: first.from, to: second.to, pairs, selection: first.selection }
		: undefined
}

/**
 * The field `e` bounds and the literals it bounds it within (`implies`, `covers`): an equality of a field with a
 * literal, either side, the literal alone, or a field's membership in a list of literals; none for any other condition.
 */
const membership = <R extends Refs>(
	e: ExprDesc<Located, R>
): { readonly field: string; readonly values: ReadonlyArray<LiteralDesc> } | undefined => {
	if (e.kind === "in") {
		return e.arg.kind === "field" ? { field: e.arg.field, values: e.values } : undefined
	}
	if (e.kind !== "compare" || e.op !== "eq") {
		return undefined
	}
	if (e.left.kind === "field" && e.right.kind === "literal") {
		return { field: e.left.field, values: [e.right.value] }
	}
	return e.right.kind === "field" && e.left.kind === "literal"
		? { field: e.right.field, values: [e.left.value] }
		: undefined
}

/** Whether each of `values` is one of `within`, as canonical text spells literals. */
const among = (values: ReadonlyArray<LiteralDesc>, within: ReadonlyArray<LiteralDesc>): boolean =>
	values.every((v) => within.some((w) => canonicalEquals(v, w)))

/**
 * Whether every row a reading's `conditions` admit meets `conjunct`, a selection's conjunct over the same row's fields
 * (`covers`): some condition is the conjunct itself, as canonical text spells both; or the conjunct bounds a field
 * within literals (`membership`) and some condition bounds the field within some of them. A condition holds of every
 * row the reading reads, so a row it admits meets the conjunct. No other conjunct is implied: a selection the
 * conditions do not imply states no fact of the rows they read.
 */
const implies = (conditions: ReadonlyArray<InferredExpr>, conjunct: ExprDesc): boolean => {
	if (conditions.some((c) => canonicalEquals(c, conjunct))) {
		return true
	}
	const within = membership(conjunct)
	return (
		within !== undefined &&
		conditions.some((c) => {
			const bound = membership(c)
			return bound?.field === within.field && among(bound.values, within.values)
		})
	)
}

/**
 * Whether every row of `from` a reading's `conditions` admit meets one of `selections`, each a selection's conjuncts
 * (`witnessesOf`): the conditions imply one of them at each of its conjuncts (`implies`); or each is one conjunct
 * bounding one field f within literals (`membership`), and together they list every value of f a row the conditions
 * admit can hold: every value some condition bounds f within, or every value of f's type, a boolean's true and false or
 * a closed id's every handle, no type's domain holding a null. No other union is read: a value of f none of them lists,
 * which a row the conditions admit can hold, is one of a row none of them meets.
 */
const covers = (
	conditions: ReadonlyArray<InferredExpr>,
	selections: ReadonlyArray<ReadonlyArray<ExprDesc>>,
	from: RelationInfo
): boolean => {
	if (selections.some((s) => s.every((conjunct) => implies(conditions, conjunct)))) {
		return true
	}
	const bounds = selections.flatMap((s) => {
		const [only, ...more] = s
		const bound = only !== undefined && more.length === 0 ? membership(only) : undefined
		return bound === undefined ? [] : [bound]
	})
	const [first] = bounds
	if (
		first === undefined ||
		bounds.length !== selections.length ||
		!bounds.every((b) => b.field === first.field)
	) {
		return false
	}
	const listed = bounds.flatMap((b) => b.values)
	const type = from.heading.find((f) => f.name === first.field)?.type
	const domain = type === undefined ? undefined : finiteDomain(type)
	return (
		conditions.some((c) => {
			const bound = membership(c)
			return bound?.field === first.field && among(bound.values, listed)
		}) ||
		(domain !== undefined && among(domain, listed))
	)
}

/** Every value of a type, where it has finitely many a selection's literals can list (`covers`): a boolean's true and
 * false, a closed id's every handle, a contract's its base's; none for any other type. */
const finiteDomain = (t: ScalarType): ReadonlyArray<LiteralDesc> | undefined =>
	t.carrier === "bool" ? [true, false] : t.carrier === "code" ? rosterOf(t)?.handles : undefined

/**
 * What a witness fixes N's rows at (`witnessesOf`): `key`, the fields its two occurrences bind alike, a key of N among
 * them, or `roots`, N's tree's root fields, which they bind alike, no key among them.
 */
interface FixedAt {
	readonly by: "key" | "roots"
	readonly fields: NonEmptyReadonlyArray<string>
}

/** A containment's target: what the containments into a relation are grouped by (`containmentsInto`). */
const targetOf = (c: FieldContainment): string => c.to

/**
 * Each region facts value's containments by their target, each target's in their order among the facts' containments,
 * made where a proof first reads the facts: the one place a region's state attaches to its facts, which are immutable,
 * so a value read again reads its index. A WeakMap holds nothing alive and is never enumerated.
 */
const containmentsByTarget = new WeakMap<
	RegionFacts,
	ReadonlyMap<string, ReadonlyArray<FieldContainment>>
>()

/**
 * The containments of `facts` into `relation`, in their order among its containments: what an occurrence's proof reads
 * (`witnessesOf`), from the facts' index by target (`containmentsByTarget`), O(1) an occurrence where each occurrence
 * scanned every containment of the schema, O(occurrences × containments) over a theory: 5,171,760 tests over the 2,612
 * occurrences of edullm's QTI schema's whole rules (qti-pie 1bf7dcc).
 */
const containmentsInto = (
	facts: RegionFacts,
	relation: string
): ReadonlyArray<FieldContainment> => {
	const known = containmentsByTarget.get(facts)
	const index = known ?? Map.groupBy(facts.containments, targetOf)
	containmentsByTarget.set(facts, index)
	return index.get(relation) ?? []
}

/** A witness of an occurrence (`witnessesOf`): what it fixes N's rows at, and the place of the occurrence beside it the
 * proof rests on. */
interface Witness extends FixedAt {
	readonly beside: number
}

/** A key's witness before a root's (`witnessOrder`). */
const fixedRank = { key: 0, roots: 1 } as const satisfies Record<FixedAt["by"], number>

/**
 * The order of an occurrence's witnesses (`witnessesOf`), the one that reads least first, a total order over what each
 * witness is and none over where the schema states its containment: a key's before a root's, since at a key the region
 * reads a gained row only where the one row of N at the key's values was lost, and at a root wherever any row of its
 * tree was; then the fields by name, element by element, the longer first where one begins the other (core/order.ts
 * listOrder); then the occurrence beside, in the walk's order.
 */
const witnessOrder: Comparator<Witness> = combineAll([
	mapInput(compareNumbers, (w: Witness) => fixedRank[w.by]),
	mapInput(listOrder(compareStrings), (w: Witness) => w.fields),
	mapInput(compareNumbers, (w: Witness) => w.beside)
])

/**
 * The witnesses that may prove an occurrence `r` of a holder N needs no unit of a row N gained beyond those of the rows
 * it gained where it lost one at the fields the witness names (`proofsOf`), each the place of the occurrence beside it
 * the proof rests on and those fields of N: `r` positive, matched beside an occurrence of E at its polarity, a
 * containment of E into N over the rows of E its selection admits, read at its projection onto the pairs the two
 * occurrences bind alike, each pair's field of E and of N to one variable, F_E and F_N; the containment one the schema
 * states or composes (RegionFacts `containments`), or N's identity, N ⊆ N at each of its fields, which every row of N
 * holds of itself, so that two occurrences of N bound alike at a key, or in one tree, witness each other; the fields
 * named those at which a row of N standing fixes N's rows (`proofsOf`): F_N, where a key of N is among them, else the
 * root fields of N's tree (RegionFacts `roots`), where they are among them; and the occurrence of E reading only rows
 * the containment holds over: its conditions imply its selection (`implies`), or the selections of every containment
 * of E into N that witnesses at that occurrence and those fields together hold every row its conditions admit
 * (`covers`), each such row of E in one of them, which proves it at the same fields. Every such occurrence beside
 * `r`, those whose one containment's selection its conditions imply and those the union of their containments'
 * selections covers alone, in the order of what each reads (`witnessOrder`), least first, so the order the schema
 * states its containments in decides no proof; none where `r` is not positive, or N is mutable: an update of N's row in
 * place gains a row at a key where the side of olds lost none, since it captures an update only where it changes a
 * column that side reads (query.ts wholeTouches), so no proof finds the gained row a replacement. A mutable E needs no
 * such care: an update of a row of E beside `r` changes a column the rule reads there, or none the proof rests on, and
 * its unit is captured as any write of its side is.
 */
const witnessesOf = (
	r: RegionRead,
	regions: ReadonlyArray<RegionRead>,
	facts: RegionFacts,
	relations: ReadonlyMap<string, TheoryRelation>
): ReadonlyArray<Witness> => {
	const n = relations.get(r.relation)
	if (r.polarity !== "positive" || n?.kind !== "relation" || n.mutable) {
		return []
	}
	const root = facts.roots.get(n.name)
	/** The fields among `alike` at which a row of N standing fixes N's rows: themselves where a key of N is among them,
	 * N's tree's root fields where they are among them. */
	const fixedAt = (alike: NonEmptyReadonlyArray<string>): FixedAt | undefined =>
		[n.primaryFields, ...n.keyFields].some((key) => key.every((f) => alike.includes(f.name)))
			? { by: "key", fields: alike }
			: root?.every((f) => alike.includes(f)) === true
				? { by: "roots", fields: root }
				: undefined
	const identity: FieldContainment = {
		from: n.name,
		to: n.name,
		pairs: mapNonEmpty(n.heading, (f) => ({ from: f.name, to: f.name })),
		selection: []
	}
	/** Each containment into N of the relation of an occurrence beside `r`, by the occurrence's place, at the fields of N
	 * it fixes N's rows at (`fixedAt`) among the pairs both bind alike, with the selection it holds over. */
	const held = [...containmentsInto(facts, n.name), identity].flatMap((c) =>
		r.beside.flatMap((beside) => {
			const e = defined(regions[beside], "an occurrence beside another")
			if (e.relation !== c.from) {
				return []
			}
			const alike = c.pairs.flatMap((p) => {
				const v = r.bound[p.to]
				return v !== undefined && v === e.bound[p.from] ? [p.to] : []
			})
			const fixed = isNonEmpty(alike) ? fixedAt(alike) : undefined
			return fixed === undefined ? [] : [{ ...fixed, beside, selection: c.selection }]
		})
	)
	const where = (beside: number): ReadonlyArray<InferredExpr> =>
		defined(regions[beside], "an occurrence beside another").where
	/** Whether two containments witness at one occurrence and one set of fields. */
	const together = (a: (typeof held)[number], b: (typeof held)[number]): boolean =>
		a.beside === b.beside && sameOrder(a.fields, b.fields)
	const implied = held.filter((h) =>
		h.selection.every((conjunct) => implies(where(h.beside), conjunct))
	)
	const united = held.filter((h, j) => {
		const e = relations.get(defined(regions[h.beside], "an occurrence beside another").relation)
		return (
			e?.kind === "relation" &&
			held.findIndex((o) => together(o, h)) === j &&
			!implied.some((w) => together(w, h)) &&
			covers(
				where(h.beside),
				held.filter((o) => together(o, h)).map((o) => o.selection),
				e
			)
		)
	})
	return [...implied, ...united]
		.map(({ by, beside, fields }) => ({ by, beside, fields }))
		.toSorted(witnessOrder)
}

/**
 * Each occurrence of the walk `regions` a witness proves needs the rows N gained only where they replace a row N lost
 * at the fields the witness names (`regionOf`), by its place, with those fields: the proofs made at generate time,
 * once, as one assignment. The assignment takes the occurrences fewer conditions restrict first, then in the walk's
 * order, each proved by its first witness in the order of what each reads (`witnessesOf`, `witnessOrder`) whose chain
 * does not reach back to it: following each proved occurrence to the occurrence its witness rests on, every chain ends
 * at an occurrence the assignment proves of nothing, which reads every row its relation gained that its conditions
 * admit. A proof spares the region the rows its occurrence's relation gained, and an occurrence its conditions restrict
 * reads fewer of them where it stands unproved, so where occurrences prove each other, the one its conditions restrict
 * most is the one read.
 *
 * The proof. Let `r` be a positive occurrence of N matched beside an occurrence of E, a containment of E into N, one
 * the schema states or composes or N's identity, holding over the rows of E its selection admits, the occurrence of E
 * reading only such rows, and E(F_E) ⊆ N(F_N) its projection onto the pairs both occurrences bind to one variable each
 * (`witnessesOf`), N immutable. The projection holds wherever the containment does: each row of E meets a row of N at
 * every pair, so at the pairs kept; and E and N may be one relation, a tree's own parent axis or N's identity, two
 * occurrences of it beside each other. A fact that `r` reads from a row n that a transaction gave N holds a row e of E
 * with e[F_E] = n[F_N], one the occurrence of E reads, so one the selection admits. If the transaction gave E the row e
 * too, the fact holds a row its relation gained at the occurrence of E, which the assignment proves of nothing, so its
 * region reads e among the rows E gained, an update of a mutable E at a field the occurrence reads among them (query.ts
 * wholeTouches), or proves by a witness of its own, whose chain is shorter by one: by induction along the chain, which
 * ends at an occurrence proved of nothing, every occurrence of it beside the next in one rule and so in the fact, the
 * fact's unit is the region's, through a row gained at that last occurrence or a row lost at one before it. Otherwise e
 * stood before the transaction at the fields the occurrence reads, F_E among them, in a committed state, where the
 * containment held: a row n0 of N stood with n0[F_N] = e[F_E] = n[F_N], and so at n's values of the fields G the
 * witness names, no field of N `r` reads being changed in place (law.ts RelationInfo `inPlace`, which wholeRule admits
 * none of and N's immutability guard holds against every UPDATE, physical/ddl/immutable.ts):
 *
 * - G = F_N, a key of N among them: N holds at most one row at those values, so the transaction removed n0, which its
 *   delta of the rows N lost holds, at n's values of F_N;
 * - G = r…, the root fields of N's tree (RegionFacts `roots`): the rows of N at n's values of r… before the transaction,
 *   n0 among them, were one tree, its root ρ the one at start 0 (T2 and the root pin; the key r…, start). Were no row
 *   of N at those values lost, every one stood after it, ρ among them, and the rows gained there would be rows of that
 *   one tree: the one of them of least start, g, is no root, since ρ is the one row at start 0; so its parent p, whose
 *   start is below g's (T3, T4 and T6: a member starts past its parent's start), stands after the transaction and was
 *   not gained, g's start being least, so p stood before; p's count is the same in both states, and in each its members
 *   fill exactly the slots below it, one each (its family's laws, at the key r…, parent, at); the member at g's slot
 *   before the transaction is no row lost, so it stands after at that slot, and it is g, which so was not gained. So the
 *   transaction lost a row of N at n's values of r….
 *
 * So a row N gained opens a fact through `r` only where E gained its row or where N lost a row at the row's values of
 * G, and the region reads a row N gained only where the transaction lost a row of N at its values of G (`replacing`).
 *
 * The proof reads `r`'s own polarity alone, positive, and changes no other occurrence's reads: an occurrence of N under
 * a negation, or one an aggregate reads, where a row N loses can open a violation, reads its own sides as before
 * (`sidesAt`), the rows N lost among them.
 */
const proofsOf = (
	regions: ReadonlyArray<RegionRead>,
	facts: RegionFacts,
	relations: ReadonlyMap<string, TheoryRelation>
): ReadonlyMap<number, NonEmptyReadonlyArray<string>> => {
	const proved = new Map<
		number,
		{ readonly beside: number; readonly fields: NonEmptyReadonlyArray<string> }
	>()
	/** Whether following the proofs from the occurrence at `from` to the occurrences they rest on reaches `to`. */
	const reaches = (from: number, to: number): boolean => {
		for (let at: number | undefined = from; at !== undefined; at = proved.get(at)?.beside) {
			if (at === to) {
				return true
			}
		}
		return false
	}
	const order = regions
		.map((r, at) => ({ at, conditions: r.where.length }))
		.toSorted((a, b) => a.conditions - b.conditions || a.at - b.at)
	for (const { at } of order) {
		const r = defined(regions[at], "an occurrence of the walk")
		const proof = witnessesOf(r, regions, facts, relations).find((w) => !reaches(w.beside, at))
		if (proof !== undefined) {
			proved.set(at, proof)
		}
	}
	return new Map([...proved].map(([at, proof]) => [at, proof.fields] as const))
}

/**
 * What a region's rule of an occurrence is canonically (`regionOf`): its side, its relation, the fields it binds in
 * their order, those its rule of gained rows reads a lost row at (`replacing`), in code point order, as a record holds
 * its keys, and the canonical text of each of its occurrence's conditions in their order, each segment of fields
 * led by its length. Its rule's every other part is a function of these: its variables and bindings of its fields,
 * named apart by `varOf`, its conditions those conditions with their fields renamed by it, its head its unit's key. Two
 * occurrences hold one identity exactly when their rules are canonically one rule.
 */
type RuleIdentity = ReadonlyArray<string | number>

/**
 * The region of a unit's keys: the union, over each occurrence of a holder (`RegionRead`) and each side its polarity
 * reads, delta.added for a side of news and delta.removed for one of olds, of the leading key fields of the rows the
 * side holds that meet the occurrence's conditions on its row, a set of unit keys under `u0`…`u(k-1)`, each rule once.
 * A written row that meets no occurrence's conditions changes no fact the query reads, so its unit is read only where
 * another row puts it there: a containment of the nodes of one kind reads the units of the nodes of that kind a
 * transaction wrote, and of the rows of its target it removed.
 *
 * The region is a step (ir/rel.ts Step), which no rewrite inlines into the rule that reads it, so its rows are the unit
 * keys alone, and as the occurrence before the rule's step it is made a set of them (analysis/physical/consumers.ts):
 * the rule's step runs once per written unit. An import would be inlined, its delta read as the occurrence itself, a set
 * by the delta's own key that holds a unit once per row written, and the rule's step would run once per row: a package's
 * publish would read the package once for each of its rows.
 */
const regionOf = (
	unit: Unit,
	regions: ReadonlyArray<RegionRead>,
	facts: RegionFacts,
	relations: ReadonlyMap<string, TheoryRelation>,
	loc: SourceLoc
): Region => {
	const holders = holdersOf(unit)
	const rules: Array<InferredRule> = []
	const replaced: Array<ReplacedRead> = []
	/** Each relation and fields `replaced` holds, so each is held once, in the order the occurrences first prove it. */
	const replacedAt = new TupleSet<ReadonlyArray<string>>()
	const proofs = proofsOf(regions, facts, relations)
	/**
	 * The identity of each rule made (RuleIdentity), so a rule is made once, at the first occurrence that makes it. A walk
	 * reads an import once at each place it is read, so one occurrence stands many times in a region, and a region of o
	 * occurrences making r rules compared each occurrence with what was made before: its rule with every rule held, O(o ·
	 * r) canonical comparisons of whole rules, then its conditions with every set made at its side, relation and proof,
	 * O(o · b) for the b sets of each, with every new rule still compared with every rule held. A rule's identity is
	 * exactly what its rule is canonically, so the region makes O(o) lookups of a set of identities, each identity reading
	 * its occurrence's conditions by their canonical texts, each condition's written once (`textOf`). Over the 559 regions
	 * of edullm's QTI schema (qti-pie 1bf7dcc; 5,626 sides of 4,957 occurrences, 1,935 rules, one region of 1,319
	 * occurrences and 50 rules) the comparisons were 7,453 of conditions and 6,835 of rules, and the regions of a lawsOf
	 * went from 162 to 185 ms to 143 to 153 ms, four runs of each.
	 */
	const made = new TupleSet<RuleIdentity>()
	const texts = new Map<InferredExpr, string>()
	const textOf = (c: InferredExpr): string => texts.getOrInsertComputed(c, canonicalTextOf)
	for (const [place, r] of regions.entries()) {
		const key = defined(holders.get(r.relation), "a region read's relation, a holder of its unit")
		const read = new Set<string>()
		for (const c of r.where) {
			mapLeaves(c, {
				var: () => undefined,
				field: (f) => {
					read.add(f)
					return undefined
				}
			})
		}
		const varOf = (field: string): string => {
			const j = key.indexOf(field)
			return j >= 0 ? regionVar(j) : rowVar(field)
		}
		const at = proofs.get(place)
		const fields = [...new Set([...key, ...[...read, ...(at ?? [])].toSorted(compareStrings)])]
		const leaves: LeafRewrite = { var: () => undefined, field: (f) => varRef(varOf(f)) }
		if (at !== undefined && !replacedAt.has([r.relation, ...at])) {
			replacedAt.add([r.relation, ...at])
			replaced.push({ relation: r.relation, fields: at })
		}
		const conditions = r.where.map(textOf)
		for (const side of sidesAt(r.polarity)) {
			const replaces = at !== undefined && side === "added" ? at.toSorted(compareStrings) : []
			const identity: RuleIdentity = [
				side,
				r.relation,
				fields.length,
				...fields,
				replaces.length,
				...replaces,
				...conditions
			]
			if (made.has(identity)) {
				continue
			}
			made.add(identity)
			const rule = ruleDesc(
				fields.map((field) => ({ id: varOf(field), origin: { relation: r.relation, field }, loc })),
				[
					{
						source: { kind: "delta", side, relation: r.relation },
						bindings: Object.fromEntries(fields.map((f) => [f, varRef(varOf(f))] as const)),
						loc
					}
				],
				[
					...r.where.map((c) => mapLeaves(c, leaves)),
					...(at !== undefined && side === "added" ? [replacing(r.relation, at, varOf)] : [])
				],
				Object.fromEntries(key.map((_, j) => [unitColumn(j), varRef(regionVar(j))] as const)),
				loc
			)
			rules.push(rule)
		}
	}
	if (!isNonEmpty(rules)) {
		return refuse("MalformedDescription", loc, "a whole rule whose captures hold a side")
	}
	return { source: { kind: "step", query: queryOf(rules, loc), bind: {} }, replaced }
}

/**
 * That the transaction lost a row of `relation` at the values a row it gained holds at `fields` (`regionOf`): an
 * existence of the relation's delta of lost rows, each of `fields` bound to the variable `varOf` names it by. A region's
 * rule of the rows a proved occurrence's relation N gained reads them under it (`proofsOf`): every row the proof needs
 * read is one N gained where it lost a row at its F_N values, so the rule reads exactly those, per key, in every
 * transaction: a publish, which loses no row of N, and a removal, which gains none, read none of them, and a ChangeSet
 * that removes rows of N and writes them again reads the ones it wrote again alone. The existence is correlated at F_N
 * alone, a key of N among them, and reads a delta, which navigation reads as written (analysis/theory/navigate.ts
 * readsOfRule), so PostgreSQL plans it as a semi-join of the gained rows against the lost ones, hashed once per
 * statement, never a lookup of the lost rows per row gained.
 */
const replacing = (
	relation: string,
	fields: NonEmptyReadonlyArray<string>,
	varOf: (field: string) => string
): InferredExpr => ({
	kind: "exists",
	source: { kind: "delta", side: "removed", relation },
	bindings: Object.fromEntries(fields.map((f) => [f, varRef(varOf(f))] as const))
})

/** A whole rule's region (`regionOf`): the step of its unit keys, and the lost rows it reads of each holder it proves
 * reads its gained rows only where they replace one (`proofsOf`). */
interface Region {
	readonly source: InferredSource
	readonly replaced: ReadonlyArray<ReplacedRead>
}

/**
 * `violation` restricted to the units a transaction wrote, the one restriction of every whole rule (see the header):
 * the region of `unit`'s keys, read from the occurrences of its holders `regions` (`regionOf`), matched in every
 * outermost rule of the query that binds a unit. A defect where the query is not unit-local at `unit`, which
 * `wholeRule` decides before it restricts.
 */
const restrictToUnits = (
	violation: InferredQuery,
	unit: Unit,
	regions: ReadonlyArray<RegionRead>,
	facts: RegionFacts,
	relations: ReadonlyMap<string, TheoryRelation>,
	loc: SourceLoc,
	calls: CallAdmission
): Pick<WholeRule, "judged" | "replaced" | "definitionOf"> & { readonly region: InferredQuery } => {
	const region = regionOf(unit, regions, facts, relations, loc)
	const definitions = new WeakMap<InferredQuery, InferredQuery>()
	const read = walked(violation, top, {
		holders: holdersOf(unit),
		restrict: { kind: "region", region: region.source },
		reads: [],
		regions: [],
		self: undefined,
		definitions,
		calls
	})
	if (read instanceof NotLocal) {
		throw defect("a whole rule's violation query is unit-local at its unit")
	}
	const definitionOf = (query: InferredQuery): InferredQuery => {
		const walkedFrom = definitions.get(query)
		return walkedFrom === undefined ? query : definitionOf(walkedFrom)
	}
	const units = region.source
	if (units.kind !== "step") {
		throw defect("a region read as a step of its unit keys")
	}
	return { judged: read.query, replaced: region.replaced, definitionOf, region: units.query }
}

/** What a query unit-local at a width reads (`unitAt`): its unit, every occurrence of a stored relation it reads, every
 * occurrence of a holder with the conditions on its row, and how its head delivers the unit. */
interface UnitFound {
	readonly unit: Unit
	readonly reads: NonEmptyReadonlyArray<RelationRead>
	readonly regions: ReadonlyArray<RegionRead>
	readonly delivered: Delivered
}

/**
 * The unit of a query at width `k` over the stored relations it reads, `stored`, where it is unit-local there, its
 * calls read as `calls` admits them: its key's types and holders, every occurrence of a stored relation it reads and
 * how its head delivers the unit; the first condition it lacks where it is not.
 */
const unitAt = (
	query: InferredQuery,
	stored: NonEmptyReadonlyArray<HolderRelation>,
	k: number,
	calls: CallAdmission
): UnitFound | NotLocal => {
	const [first] = stored
	const key = first.primaryFields.slice(0, k).map((f) => f.type)
	if (!isNonEmpty(key) || key.length !== k) {
		return lacking("unitKey", `${first.name}'s primary key holds fewer than ${k} fields`)
	}
	const holders: Array<Unit["holders"][number]> = []
	for (const r of stored) {
		const fields = r.primaryFields.slice(0, k)
		const names = fields.map((f) => f.name)
		if (
			!isNonEmpty(names) ||
			names.length !== k ||
			!fields.every((f, j) => {
				const t = key[j]
				return t !== undefined && sameScalarType(f.type, t)
			})
		) {
			return lacking(
				"unitKey",
				`${r.name}'s primary key does not lead with ${k} field${k === 1 ? "" : "s"} of the types ${first.name}'s does`
			)
		}
		holders.push({ relation: r.name, fields: names })
	}
	const [h0, ...hs] = holders
	if (h0 === undefined) {
		throw defect("a unit's holders, one per stored relation read")
	}
	const held: Unit["holders"] = [h0, ...hs]
	const unit: Unit = Object.freeze({ key, holders: held })
	const reads: Array<RelationRead> = []
	const regions: Array<RegionRead> = []
	const read = walked(query, top, {
		holders: holdersOf(unit),
		restrict: deciding,
		reads,
		regions,
		self: undefined,
		definitions: new WeakMap(),
		calls
	})
	if (read instanceof NotLocal) {
		return read
	}
	const [r0, ...rs] = reads
	return r0 === undefined
		? lacking("noUnit", "it reads no stored relation")
		: { unit, reads: [r0, ...rs], regions, delivered: read.delivered }
}

/**
 * The first read of `found` at a field an immutable relation's rows change in place (law.ts RelationInfo `inPlace`), if
 * any: grizzle's own rewrites, a fold's accumulator through its owner axis, which no write of the relation itself
 * makes. A mutable relation's every field changes in place by its own writes, which a whole rule and a stored relation
 * read under their unit's exclusive borrow (`wholeRule`, `storedUnit`), each update captured as any write is.
 */
const inPlaceRead = (
	found: UnitFound,
	stored: ReadonlyArray<HolderRelation>
): { readonly relation: string; readonly column: string } | undefined => {
	for (const r of found.reads) {
		const relation = stored.find((s) => s.name === r.relation && !s.mutable)
		const column = r.columns.find((c) => relation?.inPlace.includes(c) === true)
		if (column !== undefined) {
			return { relation: r.relation, column }
		}
	}
	return undefined
}

/**
 * The whole rule of `law`, whose violation query is `violation`, where it is unit-local (see the header), decided once
 * when the schema compiles: no field it reads one an immutable relation's rows change in place (law.ts RelationInfo
 * `inPlace`), and every stored relation it reads immutable, so every row it reads holds the values it was inserted with
 * until it is deleted, which its immutability guard holds against every UPDATE (physical/ddl/immutable.ts), or, where
 * it reads a mutable one, every relation it reads sitting in one declared unit whose key leads its own, the admission a
 * stored relation's definition passes (`declaredOf`): every write of their rows, a mutable relation's updates and
 * deletes among them, borrows that unit exclusively, so the rows the judge reads at a unit its transaction wrote are
 * that transaction's alone until it commits, and an update of a column the rule reads is captured as any write of its
 * side is (query.ts wholeTouches), the unit written; at the widest unit key its joins allow, its violation restricted
 * to the units a transaction wrote (`restrictToUnits`); none where it is not unit-local, which its probes judge.
 */
export const wholeRule = (
	law: RuleLaw<LawSide>,
	violation: InferredQuery,
	relations: ReadonlyMap<string, TheoryRelation>,
	facts: RegionFacts,
	loc: SourceLoc
): WholeRule | undefined => {
	const stored = storedReads(violation, relations)
	const [first, ...rest] = stored
	if (first === undefined) {
		return undefined
	}
	const all: NonEmptyReadonlyArray<HolderRelation> = [first, ...rest]
	for (let k = widestOf(all); k >= 1; k--) {
		const found = unitAt(violation, all, k, "rule")
		if (found instanceof NotLocal) {
			continue
		}
		if (
			inPlaceRead(found, all) !== undefined ||
			(all.some((r) => r.mutable) &&
				"condition" in
					declaredOf(found.unit, headNonEmpty(found.unit.holders).fields, (relation) =>
						facts.members.get(relation)
					))
		) {
			return undefined
		}
		const { judged, replaced, definitionOf } = restrictToUnits(
			violation,
			found.unit,
			found.regions,
			facts,
			relations,
			loc,
			"rule"
		)
		return Object.freeze({
			kind: "whole",
			law,
			reads: found.reads,
			unit: found.unit,
			judged,
			replaced,
			definitionOf,
			everyRow: violation
		})
	}
	return undefined
}

/** The widest unit a query over `stored` may have: the shortest primary key among them. */
const widestOf = (stored: NonEmptyReadonlyArray<HolderRelation>): number =>
	stored.reduce(
		(k, r) => Math.min(k, r.primaryFields.length),
		headNonEmpty(stored).primaryFields.length
	)

/** A stored relation's membership in a declared unit (schema/own.ts UnitMember): the unit, and its fields holding the
 * unit's key, its primary key's first. */
export interface DeclaredMember {
	readonly unit: string
	readonly fields: NonEmptyReadonlyArray<string>
}

/**
 * The declared unit a stored relation's rows sit under (ir/unit.ts StoredUnit `declared`), where its definition is
 * unit-local at `unit`, its head delivering the unit at `fields`: the one declared unit every holder of it sits in
 * (`memberOf`, the schema's Owned.unitOf), whose key, m fields, leads the unit's, so its first m fields are the
 * holders' and S's fields carrying it are `fields`' first m; or `borrow`, where a holder sits in no declared unit, two
 * sit in two, or the declared unit is wider than the definition's, which then reads several declared units at one of
 * its own, each written under a borrow of its own.
 */
const declaredOf = (
	unit: Unit,
	fields: NonEmptyReadonlyArray<string>,
	memberOf: (relation: string) => DeclaredMember | undefined
): { readonly unit: string; readonly fields: NonEmptyReadonlyArray<string> } | UnitLocality => {
	const [h0, ...hs] = unit.holders
	const first = memberOf(h0.relation)
	if (first === undefined) {
		return {
			condition: "borrow",
			detail: `${h0.relation} sits in no declared unit, so no borrow covers a write of its rows`
		}
	}
	for (const h of hs) {
		const member = memberOf(h.relation)
		if (member === undefined) {
			return {
				condition: "borrow",
				detail: `${h.relation} sits in no declared unit, so no borrow covers a write of its rows`
			}
		}
		if (member.unit !== first.unit) {
			return {
				condition: "borrow",
				detail: `${h.relation} sits in unit ${member.unit} and ${h0.relation} in ${first.unit}, two borrows`
			}
		}
	}
	const width = first.fields.length
	const [f0, ...fs] = fields.slice(0, width)
	if (width > unit.key.length || f0 === undefined) {
		return {
			condition: "borrow",
			detail: `unit ${first.unit}'s key (${first.fields.join(", ")}) is wider than its own (${h0.fields.join(", ")}), so its rows at one unit read several of ${first.unit}'s`
		}
	}
	const carrying: NonEmptyReadonlyArray<string> = [f0, ...fs]
	return Object.freeze({ unit: first.unit, fields: carrying })
}

/**
 * The unit of a stored derived relation's definition, read live (ir/unit.ts StoredUnit), decided once when the schema
 * compiles, by the one walk a whole rule's discharge reads: unit-local, no field it reads one an immutable relation's
 * rows change in place, every relation it reads sitting in one declared unit whose key leads its own (`declaredOf`), so
 * every write of its rows, a mutable relation's updates and deletes among them, holds that unit exclusively and its
 * upkeep at COMMIT runs under the same borrow, every declared function it calls anywhere, its head's among them,
 * immutable throughout (`unfit` names why one is not, none where it is), at the widest unit whose key its head delivers,
 * so its rows at one unit are replaced by that unit's key; or the condition it lacks (core/causes.ts UnitLocality): its
 * unit and its calls first, then, of the narrowest unit, one field wide, the first the walk meets in the definition's
 * order, then its fields changed in place, its head, and its declared unit. An immutable function's value at one argument
 * tuple is the same at every state, and a call's Description carries the digest of the whole function, body included
 * (ir/expr.ts CalledFunction), so its rows change only with its unit's rows, and with a migration that changes the
 * function.
 */
export const storedUnit = (
	definition: InferredQuery,
	relations: ReadonlyMap<string, TheoryRelation>,
	unfit: (fn: string) => string | undefined,
	memberOf: (relation: string) => DeclaredMember | undefined,
	frozen: FrozenUnit | undefined
): StoredUnit | FrozenUnit | UnitLocality => {
	for (const fn of [...callsOf(definition)].toSorted(compareStrings)) {
		const why = unfit(fn)
		if (why !== undefined) {
			return { condition: "call", detail: `it calls ${fn}, ${why}` }
		}
	}
	if (frozen !== undefined) {
		return frozen
	}
	const stored = storedReads(definition, relations)
	const [first, ...rest] = stored
	if (first === undefined) {
		return { condition: "noUnit", detail: "it reads no relation a write changes" }
	}
	const all: NonEmptyReadonlyArray<HolderRelation> = [first, ...rest]
	for (let k = widestOf(all); k >= 1; k--) {
		const found = unitAt(definition, all, k, "stored")
		if (found instanceof NotLocal) {
			if (k === 1) {
				return found.lacks
			}
			continue
		}
		const changing = inPlaceRead(found, all)
		if (changing !== undefined) {
			return {
				condition: "inPlace",
				detail: `it reads ${changing.relation}.${changing.column}, which grizzle rewrites in place`
			}
		}
		const delivered = found.delivered
		if (delivered.kind === "at" && isNonEmpty(delivered.fields)) {
			const declared = declaredOf(found.unit, delivered.fields, memberOf)
			return "condition" in declared
				? declared
				: Object.freeze({ kind: "unit", unit: found.unit, fields: delivered.fields, declared })
		}
		if (k === 1) {
			return { condition: "hidden", detail: "its head delivers no field that holds its unit" }
		}
	}
	throw defect("a stored relation's definition decided at some width from its widest to one")
}

/**
 * How grizzle keeps a stored derived relation equal to its definition at COMMIT (physical/ddl/rules.ts, the judge's
 * phase A): the units a transaction wrote (`region`, a query of their keys under u0…u(k-1)), and its definition read at
 * those units alone (`judged`), whose rows replace the stored rows there; each occurrence of a holder its definition
 * reads, every one of them at both polarities, since a row a holder gains or loses at a unit changes the stored rows
 * there whatever negation or aggregate reads it; and the definition each query `judged` reads was walked from
 * (WholeRule `definitionOf`). Its region reads both sides of every occurrence and no witness narrows it (`witnessesOf`
 * proves only a positive occurrence), where a rule's reads only the sides that can break it: a removal, which no
 * positive occurrence of a rule reads, is a change of the stored rows.
 */
export interface StoredUpkeep {
	readonly relation: string
	readonly stored: StoredUnit
	readonly region: InferredQuery
	readonly judged: InferredQuery
	/** Each read of a holder of its unit, a relation whose rows a write changes (`storedReads`), whose captures the
	 * upkeep's block reads: never a closed relation's, whose rows no write changes, which its definition may match
	 * itself or through a live derived relation it reads (a roster's constants, Declares-like facts). */
	readonly reads: NonEmptyReadonlyArray<RelationRead>
	readonly definitionOf: (query: InferredQuery) => InferredQuery
	/** The stored relation's declaration, which a refusal of its upkeep names. */
	readonly loc: SourceLoc
}

/** The upkeep of stored relation `relation`, admitted at `stored` over `definition`, read live (`StoredUpkeep`). */
export const storedUpkeep = (
	relation: string,
	definition: InferredQuery,
	stored: StoredUnit,
	relations: ReadonlyMap<string, TheoryRelation>,
	facts: RegionFacts,
	loc: SourceLoc
): StoredUpkeep => {
	const [first, ...rest] = storedReads(definition, relations)
	if (first === undefined) {
		throw defect("a stored relation's definition, which reads a stored relation")
	}
	const found = unitAt(definition, [first, ...rest], stored.unit.key.length, "stored")
	if (found instanceof NotLocal) {
		throw defect("a stored relation's definition unit-local at its admitted unit")
	}
	const every = found.regions.map((r): RegionRead => ({ ...r, polarity: "both" }))
	const holders = new Set<string>([first, ...rest].map((h) => h.name))
	const [held, ...more] = found.reads.filter((r) => holders.has(r.relation))
	if (held === undefined) {
		throw defect("a stored relation's definition, which reads a holder of its unit")
	}
	const reads = mapNonEmpty([held, ...more], (r): RelationRead => ({ ...r, polarity: "both" }))
	const { judged, definitionOf, region } = restrictToUnits(
		definition,
		found.unit,
		every,
		facts,
		relations,
		loc,
		"stored"
	)
	return Object.freeze({ relation, stored, region, judged, reads, definitionOf, loc })
}

/** The ordinary and stored derived relations a query matches or filters by, at any depth, sorted by name, each once
 * (HolderRelation). */
const storedReads = (
	query: InferredQuery,
	relations: ReadonlyMap<string, TheoryRelation>
): ReadonlyArray<HolderRelation> => {
	const names = new Set<string>()
	const inSource = (s: InferredSource): void => {
		if (s.kind === "relation") {
			names.add(s.name)
		} else if (s.kind === "query" || s.kind === "step") {
			inQuery(s.query)
		}
	}
	const inExpr = (e: InferredExpr): void => {
		if (e.kind === "absent" || e.kind === "exists") {
			inSource(e.source)
			return
		}
		for (const c of exprChildren(e)) {
			inExpr(c.term)
		}
	}
	const inRule = (r: InferredRule): void => {
		for (const m of r.matches) {
			inSource(m.source)
		}
		for (const w of r.where) {
			inExpr(w)
		}
	}
	const inStage = (st: InferredStage): void => {
		switch (st.kind) {
			case "rules":
				st.arms.forEach(inRule)
				return
			case "union":
				inStage(st.input)
				st.arms.forEach(inRule)
				return
			case "named":
			case "attach":
			case "order":
			case "take":
			case "approx":
				inStage(st.input)
				return
			case "recursive":
				st.recursive.base.forEach(inRule)
				st.recursive.rec.forEach(inRule)
				return
		}
	}
	const inQuery = (q: InferredQuery): void => inStage(q.stage)
	inQuery(query)
	return [...names].toSorted(compareStrings).flatMap((name): ReadonlyArray<HolderRelation> => {
		const r = relations.get(name)
		if (r?.kind === "relation") {
			return [r]
		}
		return r?.kind === "stored" && r.unit.kind === "unit"
			? [
					{
						kind: "relation",
						name: r.name,
						primaryFields: r.primaryFields,
						mutable: false,
						inPlace: []
					}
				]
			: []
	})
}

/**
 * A relation a query reads that may hold its unit, as unit-locality reads it (`storedReads`): an ordinary relation, or a
 * stored derived relation, immutable, whose rows only the judge's phase A deletes and inserts, so none changes in place
 * and its primary key leads with its unit's fields (analysis/theory/theory.ts storedRelationOf).
 */
type HolderRelation = Pick<RelationInfo, "kind" | "name" | "primaryFields" | "mutable" | "inPlace">
