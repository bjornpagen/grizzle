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
import { sameOrder } from "#compiler/core/array.ts"
import { canonicalEquals } from "#compiler/core/canonical.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
/**
 * Unit-local rules: a rule over a query every fact of whose violation lies within one unit, a value of the key every
 * relation it reads leads with, each of them immutable (ir/unit.ts), which the judge reads whole over the units a
 * transaction wrote, never probing the rows it wrote (analysis/theory/query.ts WholeRule).
 *
 * A rule is unit-local when its violation query (query.ts violationQuery), the one the migration that adds it runs,
 * joins within one unit at every rule of it: every stored relation it reads is immutable and leads its primary key with
 * k fields of one sequence of types; in every rule of the query, at any depth, every match of a stored relation binds
 * those k fields to one sequence of variables, the rule's unit, every match of an imported query binds the fields its
 * head delivers its unit at (`Delivered`) to those same variables, and every negation is correlated at them; an import
 * whose head holds no unit is the only source of a unit its rule reads; every rule of a union delivers its unit alike;
 * and an aggregating rule's head delivers its unit, so its groups lie inside one unit. A fact of such a query is then
 * derived from the rows of one unit alone, and a write changes it only at the units whose rows it writes. The width k
 * is the most for which the query is unit-local, so a unit is as narrow as the rule's joins allow; a rule unit-local at
 * no width is probed.
 *
 * The judge reads a whole rule's violation restricted to the units a transaction wrote (`restrictToUnits`): every
 * outermost rule of the query that binds a unit, from a stored relation it matches or a query that delivers one, is
 * read per unit (`perUnit`), the region of the units' keys first, a step made a set of them (`regionOf`), then the rule
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
import { compareStrings } from "#compiler/core/order.ts"
import {
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
	mapExprChildren,
	queryParamNames,
	type TermDesc,
	type VarDesc
} from "#compiler/ir/desc.ts"
import type { RelationInfo, TheoryRelation } from "#compiler/ir/law.ts"
import type { DeltaSide } from "#compiler/ir/rel.ts"
import { sameScalarType } from "#compiler/ir/scalar.ts"
import type { Unit } from "#compiler/ir/unit.ts"
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
 *   matches the region and is read per unit as a step (`perUnit`);
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

/** That a query is not unit-local, at which the walk stops. */
const notLocal = Symbol("not unit-local")
type NotLocal = typeof notLocal

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

/** A query as a walk leaves it: its text, and how it delivers its facts' units. */
interface Walked {
	readonly query: InferredQuery
	readonly delivered: Delivered
}

/** The variables `bindings` binds `fields` to, in order, where each is a variable. */
const varsAt = (
	bindings: Readonly<Record<string, InferredExpr>>,
	fields: ReadonlyArray<string>
): ReadonlyArray<string> | NotLocal => {
	const out: Array<string> = []
	for (const f of fields) {
		const e = bindings[f]
		if (e?.kind !== "var") {
			return notLocal
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
 * fields that deliver its unit; a closed relation by none; not unit-local for any other source. Every occurrence of a
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
			const vars = varsAt(bindings, fields)
			return vars === notLocal ? notLocal : { unit: { kind: "vars", vars }, source }
		}
		case "query": {
			if (Object.keys(source.bind).length > 0) {
				return notLocal
			}
			const inner = walked(source.query, at, w)
			if (inner === notLocal) {
				return notLocal
			}
			const read = { ...source, query: inner.query, bind: passedChannels(inner.query) }
			const delivered = inner.delivered
			switch (delivered.kind) {
				case "none":
					return { unit: { kind: "none" }, source: read }
				case "hidden":
					return { unit: { kind: "hidden" }, source: read }
				case "at": {
					const vars = varsAt(bindings, delivered.fields)
					return vars === notLocal ? notLocal : { unit: { kind: "vars", vars }, source: read }
				}
			}
		}
		case "self": {
			if (w.self === undefined) {
				return notLocal
			}
			const vars = varsAt(bindings, w.self)
			return vars === notLocal ? notLocal : { unit: { kind: "vars", vars }, source }
		}
		case "step":
		case "param":
		case "paramOf":
		case "interior":
		case "delta":
		case "context":
		case "row":
			return notLocal
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
		if (r === notLocal) {
			return notLocal
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
		if (read === notLocal) {
			return notLocal
		}
		const correlated =
			read.unit.kind === "none" ||
			(read.unit.kind === "vars" && unit !== undefined && sameOrder(read.unit.vars, unit))
		return correlated ? { ...e, source: read.source } : notLocal
	}
	const children = { local: true }
	const each = mapExprChildren(e, (x) => {
		const r = walkedExpr(x, unit, at, w)
		if (r === notLocal) {
			children.local = false
			return x
		}
		return r
	})
	return children.local ? each : notLocal
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
		if (read === notLocal) {
			return notLocal
		}
		if (match.source.kind === "relation" && w.regions.length === before + 1) {
			own.push(before)
		}
		units.push(read.unit)
		matches.push({ ...match, source: read.source })
	}
	for (const [j, i] of own.entries()) {
		const occurrence = defined(w.regions[i], "an occurrence this rule matches")
		w.regions[i] = { ...occurrence, beside: own.filter((_, k) => k !== j) }
	}
	const bearing = units.filter((u) => u.kind !== "none")
	const hidden = bearing.some((u) => u.kind === "hidden")
	if (hidden && (bearing.length > 1 || aggregates)) {
		return notLocal
	}
	const vars = bearing.flatMap((u) => (u.kind === "vars" ? [u.vars] : []))
	const [unit] = vars
	if (unit !== undefined && !vars.every((v) => sameOrder(v, unit))) {
		return notLocal
	}
	const where = walkedExprs(r.where, unit, at, w)
	return where === notLocal ? notLocal : { matches, where, unit, hidden }
}

/**
 * A rule walked (`ruleBody`). An aggregating rule's matches are read at both polarities and its head delivers its unit,
 * so its groups lie inside one unit. Where the walk restricts at the root and the rule binds a unit, from a stored
 * relation it matches or a query that delivers one, the region is matched first, bound to its unit, and the rule is
 * read per unit (`perUnit`), every rule its imports and its negations read walked with the unit bound
 * (`Restriction`): the unit is bound once, by the outermost rule that binds it, so the two sides of a containment
 * between two queries are read inside one step, not each per unit of a region of its own. A rule at the root that
 * binds no unit, which reads closed relations alone or a query whose unit is hidden, leaves the root's restriction to
 * the rules it reads.
 */
const walkedRule = (r: InferredRule, outer: At, w: Walk): WalkedRule | NotLocal => {
	if (r.interiors.length > 0 || r.attach.length > 0) {
		return notLocal
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
	if (bound === notLocal) {
		return notLocal
	}
	const body =
		restriction.kind === "region" && bound.unit === undefined
			? ruleBody(r, at, aggregates, w)
			: bound
	if (body === notLocal) {
		return notLocal
	}
	const { matches, where, unit } = body
	if (unit === undefined) {
		return {
			rule: { ...r, matches, where },
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
		return notLocal
	}
	const walkedText: InferredRule = { ...r, matches, where }
	return {
		rule:
			restriction.kind === "region" ? perUnit(walkedText, unit, restriction.region) : walkedText,
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

/** The channel a rule read per unit binds position `j` of its unit key to (`perUnit`). */
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
const perUnit = (
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

/** A rule with its unit's variables `unit` read as the channels a step's bind map binds them to, position by position. */
const channelled = (r: InferredRule, unit: ReadonlyArray<string>): InferredRule => {
	const channels = new Map(unit.map((v, j) => [v, unitParam(j)] as const))
	const leaves: LeafRewrite = { var: (id) => channels.get(id), field: () => undefined }
	return {
		...r,
		vars: r.vars.filter((v) => !channels.has(v.id)),
		matches: r.matches.map((m) => ({ ...m, bindings: mapBindings(m.bindings, leaves) })),
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
	return a.kind === "none" || b.kind === "none" ? notLocal : hiddenUnit
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
		if (read === notLocal) {
			return notLocal
		}
		out.push(read)
	}
	const [first, ...rest] = out
	if (first === undefined) {
		return notLocal
	}
	let delivered: Delivered | NotLocal = first.delivered
	for (const r of rest) {
		delivered = delivered === notLocal ? notLocal : joinedDelivery(delivered, r.delivered)
	}
	return delivered === notLocal
		? notLocal
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
 * on its own (`perUnit`): a step read so would nest self inside a subquery, which no recursion admits. A seed's bare
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
		if (seed === notLocal) {
			return notLocal
		}
		delivered =
			delivered === undefined
				? seed.delivered
				: delivered === notLocal
					? notLocal
					: joinedDelivery(delivered, seed.delivered)
		read.set(r, seed)
	}
	if (delivered === undefined || delivered === notLocal || delivered.kind !== "at") {
		return notLocal
	}
	const fields = delivered.fields
	const stepWalk: Walk = { ...plain, self: fields }
	for (const r of st.recursive.rec) {
		if (read.has(r)) {
			continue
		}
		const step = walkedRule(r, at, stepWalk)
		if (step === notLocal || !carries(step, fields)) {
			return notLocal
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
				return read === notLocal
					? notLocal
					: { stage: { ...st, arms: read.rules }, delivered: read.delivered }
			}
			case "union": {
				const input = stage(st.input)
				const read = walkedRules(st.arms, at, w)
				if (input === notLocal || read === notLocal) {
					return notLocal
				}
				const delivered = joinedDelivery(input.delivered, read.delivered)
				return delivered === notLocal
					? notLocal
					: { stage: { ...st, input: input.stage, arms: read.rules }, delivered }
			}
			case "named": {
				const input = stage(st.input)
				return input === notLocal
					? notLocal
					: { stage: { ...st, input: input.stage }, delivered: input.delivered }
			}
			case "recursive":
				return unitLocalRecursion(st, at, w)
			case "attach":
			case "order":
			case "take":
			case "approx":
				return notLocal
		}
	}
	const read = stage(query.stage)
	return read === notLocal
		? notLocal
		: { query: { ...query, stage: read.stage }, delivered: read.delivered }
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
 * selection admits. */
export interface RegionFacts {
	readonly containments: ReadonlyArray<FieldContainment>
}

/** The containments one statement states between stored relations (`regionFactsOf`), each a FieldContainment. */
const statedOf = (
	s: OwnedStatement,
	stored: (name: string) => RelationInfo | undefined
): ReadonlyArray<FieldContainment> => {
	switch (s.kind) {
		case "contained": {
			const pairs = s.pairs.flatMap((p) =>
				p.left.kind === "field" && p.right.kind === "field"
					? [{ from: p.left.field, to: p.right.field }]
					: []
			)
			return stored(s.left.relation) !== undefined &&
				stored(s.right.relation) !== undefined &&
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
		case "retirable":
			return []
	}
}

/**
 * The containments `statements` state over the rows of a stored relation its source's selection admits, field by field
 * into a stored relation (`RegionFacts`), and every one they compose to:
 *
 * - a `contained` statement whose sides are stored relations (`stored`), at its pairs of a field on each side, its
 *   source's selection its own (FieldContainment `selection`), its target selecting rows or not, since a row in a
 *   selection of `to` is a row of `to`;
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
 * containment once.
 */
export const regionFactsOf = (
	statements: ReadonlyArray<OwnedStatement>,
	relations: ReadonlyMap<string, TheoryRelation>
): RegionFacts => {
	const stored = (name: string): RelationInfo | undefined => {
		const r = relations.get(name)
		return r?.kind === "relation" ? r : undefined
	}
	const stated = statements.flatMap((s) => statedOf(s, stored))
	const containments: Array<FieldContainment> = []
	const hold = (c: FieldContainment): void => {
		const states = c.from !== c.to || c.pairs.some((p) => p.from !== p.to)
		if (states && !containments.some((held) => canonicalEquals(held, c))) {
			containments.push(c)
		}
	}
	stated.forEach(hold)
	for (let at = 0; at < containments.length; at++) {
		const first = defined(containments[at], "a containment the closure holds")
		for (const second of stated) {
			const c = composed(first, second)
			if (c !== undefined) {
				hold(c)
			}
		}
	}
	return { containments }
}

/** E ⊆ N from E ⊆ M (`first`) and M ⊆ N (`second`), over the rows of E `first`'s selection admits, where `second`
 * holds over every row of M, at the pairs of `second` whose field of M one of `first`'s pairs reaches, its projection
 * there, where `first` reaches one (`regionFactsOf`). */
const composed = (
	first: FieldContainment,
	second: FieldContainment
): FieldContainment | undefined => {
	if (first.to !== second.from || second.selection.length > 0) {
		return undefined
	}
	const pairs = second.pairs.flatMap((p) => {
		const from = first.pairs.find((q) => q.to === p.from)
		return from === undefined ? [] : [{ from: from.from, to: p.to }]
	})
	return isNonEmpty(pairs)
		? { from: first.from, to: second.to, pairs, selection: first.selection }
		: undefined
}

/**
 * Whether every row a reading's `conditions` admit meets `conjunct`, a selection's conjunct over the same row's fields
 * (`witnessesOf`): some condition is the conjunct itself, as canonical text spells both; or the conjunct is a field's
 * membership in a list of literals and some condition fixes the field to one of them, or bounds it to a list each of
 * whose literals is one of them. A condition holds of every row the reading reads, so a row it admits meets the
 * conjunct. No other conjunct is implied: a selection the conditions do not imply states no fact of the rows they read.
 */
const implies = (conditions: ReadonlyArray<InferredExpr>, conjunct: ExprDesc): boolean => {
	if (conditions.some((c) => canonicalEquals(c, conjunct))) {
		return true
	}
	if (conjunct.kind !== "in" || conjunct.arg.kind !== "field") {
		return false
	}
	const field = conjunct.arg.field
	const listed = (value: LiteralDesc): boolean =>
		conjunct.values.some((v) => canonicalEquals(v, value))
	/** Whether `term` is the conjunct's field and `other` one of its literals. */
	const fixes = (term: InferredExpr, other: InferredExpr): boolean =>
		term.kind === "field" && term.field === field && other.kind === "literal" && listed(other.value)
	return conditions.some((c) =>
		c.kind === "compare"
			? c.op === "eq" && (fixes(c.left, c.right) || fixes(c.right, c.left))
			: c.kind === "in" && c.arg.kind === "field" && c.arg.field === field && c.values.every(listed)
	)
}

/**
 * The containments that may prove an occurrence of a holder N needs no unit of a row N gained beyond those of the rows
 * it gained where it lost one (`proofsOf`), each with the place of the occurrence beside it the proof rests on and the
 * fields of N it pairs: `r` positive, matched beside an occurrence of E at its polarity, the schema stating the
 * containment E(F) ⊆ N(G) over the rows of E its selection admits (RegionFacts), the occurrence of E reading only such
 * rows, its conditions implying the selection (`implies`), read at its projection onto the pairs the two occurrences
 * bind alike, each pair's field of E and of N to one variable, F_E and F_N, a key of N among F_N. Every such
 * occurrence beside `r`, by its containment; none where `r` is not positive.
 */
const witnessesOf = (
	r: RegionRead,
	regions: ReadonlyArray<RegionRead>,
	facts: RegionFacts,
	relations: ReadonlyMap<string, TheoryRelation>
): ReadonlyArray<{ readonly beside: number; readonly fields: NonEmptyReadonlyArray<string> }> => {
	const n = relations.get(r.relation)
	if (r.polarity !== "positive" || n?.kind !== "relation") {
		return []
	}
	const keyed = (fields: ReadonlyArray<string>): boolean =>
		[n.primaryFields, ...n.keyFields].some((key) => key.every((f) => fields.includes(f.name)))
	return facts.containments.flatMap((c) =>
		c.to === r.relation
			? r.beside.flatMap((beside) => {
					const e = defined(regions[beside], "an occurrence beside another")
					if (
						e.relation !== c.from ||
						!c.selection.every((conjunct) => implies(e.where, conjunct))
					) {
						return []
					}
					const alike = c.pairs.flatMap((p) => {
						const v = r.bound[p.to]
						return v !== undefined && v === e.bound[p.from] ? [p.to] : []
					})
					return isNonEmpty(alike) && keyed(alike) ? [{ beside, fields: alike }] : []
				})
			: []
	)
}

/**
 * Each occurrence of the walk `regions` a containment proves needs the rows N gained only where they replace a row N
 * lost (`regionOf`), by its place, with the fields of N, a key of N among them, of the containment that proves it: the
 * proofs made at generate time, once, as one assignment. Each proof rests on an occurrence beside it the assignment
 * proves of nothing, which reads every row its relation gained that its conditions admit. The assignment takes the
 * occurrences fewer conditions restrict first, then in the walk's order, each proved by its first witness
 * (`witnessesOf`) whose occurrence is not proved, which is then never proved: a proof spares the region the rows its
 * occurrence's relation gained, and an occurrence its conditions restrict reads fewer of them where it stands unproved,
 * so where two occurrences each prove the other, the one its conditions restrict is the one read.
 *
 * The proof. Let `r` be a positive occurrence of N matched beside an occurrence of E, the schema stating, or
 * composing, a containment of E into N over the rows of E its selection admits, the occurrence of E reading only such
 * rows, and E(F_E) ⊆ N(F_N) its projection onto the pairs both occurrences bind to one variable each, a key of N among
 * F_N's fields (`witnessesOf`), N and E immutable, as every holder of a unit is (`wholeRule`). The projection holds
 * wherever the containment does: each row of E meets a row of N at every pair, so at the pairs kept; and E and N may
 * be one relation, a tree's own parent axis, two occurrences of it beside each other. A fact that `r` reads from a row n that a transaction gave N
 * holds a row e of E with e[F_E] = n[F_N], one the occurrence of E reads, so one the selection admits. If the
 * transaction gave E the row e too, the occurrence of E reads e among the rows E gained, and its unit is the region's
 * through that occurrence, which reads every row E gained that its conditions admit, since the assignment proves that
 * occurrence of nothing. Otherwise e stood before the transaction, in a committed state, where the containment held: a
 * row n0 of N stood with n0[F_N] = e[F_E] = n[F_N]. N holds at most one row at those values, by its key among F_N, and rows of N are never updated, so the
 * transaction removed n0, which its delta of the rows N lost holds. So a row N gained opens a fact through `r` only
 * where E gained one at it or where N lost a row at the same F_N values, and the region reads a row N gained only where
 * the transaction lost a row of N at its F_N values (`replacing`).
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
	const proved = new Map<number, NonEmptyReadonlyArray<string>>()
	const read = new Set<number>()
	const order = regions
		.map((r, at) => ({ at, conditions: r.where.length }))
		.toSorted((a, b) => a.conditions - b.conditions || a.at - b.at)
	for (const { at } of order) {
		if (read.has(at)) {
			continue
		}
		const r = defined(regions[at], "an occurrence of the walk")
		const proof = witnessesOf(r, regions, facts, relations).find((w) => !proved.has(w.beside))
		if (proof !== undefined) {
			proved.set(at, proof.fields)
			read.add(proof.beside)
		}
	}
	return proved
}

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
	const proofs = proofsOf(regions, facts, relations)
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
		if (
			at !== undefined &&
			!replaced.some((x) => x.relation === r.relation && sameOrder(x.fields, at))
		) {
			replaced.push({ relation: r.relation, fields: at })
		}
		for (const side of sidesAt(r.polarity)) {
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
			if (!rules.some((held) => canonicalEquals(held, rule))) {
				rules.push(rule)
			}
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
	loc: SourceLoc
): { readonly judged: InferredQuery; readonly replaced: ReadonlyArray<ReplacedRead> } => {
	const region = regionOf(unit, regions, facts, relations, loc)
	const read = walked(violation, top, {
		holders: holdersOf(unit),
		restrict: { kind: "region", region: region.source },
		reads: [],
		regions: [],
		self: undefined
	})
	if (read === notLocal) {
		throw defect("a whole rule's violation query is unit-local at its unit")
	}
	return { judged: read.query, replaced: region.replaced }
}

/**
 * The unit of a query at width `k` over the stored relations it reads, `stored`, where it is unit-local there: its
 * key's types and holders, and every occurrence of a stored relation it reads; none where it is not.
 */
const unitAt = (
	violation: InferredQuery,
	stored: NonEmptyReadonlyArray<RelationInfo>,
	k: number
):
	| {
			readonly unit: Unit
			readonly reads: NonEmptyReadonlyArray<RelationRead>
			readonly regions: ReadonlyArray<RegionRead>
	  }
	| undefined => {
	const [first] = stored
	const key = first.primaryFields.slice(0, k).map((f) => f.type)
	if (!isNonEmpty(key) || key.length !== k) {
		return undefined
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
			return undefined
		}
		holders.push({ relation: r.name, fields: names })
	}
	const [h0, ...hs] = holders
	if (h0 === undefined) {
		return undefined
	}
	const held: Unit["holders"] = [h0, ...hs]
	const unit: Unit = Object.freeze({ key, holders: held })
	const reads: Array<RelationRead> = []
	const regions: Array<RegionRead> = []
	const read = walked(violation, top, {
		holders: holdersOf(unit),
		restrict: deciding,
		reads,
		regions,
		self: undefined
	})
	const [r0, ...rs] = reads
	return read === notLocal || r0 === undefined ? undefined : { unit, reads: [r0, ...rs], regions }
}

/**
 * The whole rule of `law`, whose violation query is `violation`, where it is unit-local (see the header), decided once
 * when the schema compiles: every stored relation it reads immutable, at the widest unit key its joins allow, its
 * violation restricted to the units a transaction wrote (`restrictToUnits`); none where it is not unit-local, which its
 * probes judge.
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
	if (first === undefined || stored.some((r) => r.mutable)) {
		return undefined
	}
	const all: NonEmptyReadonlyArray<RelationInfo> = [first, ...rest]
	const widest = all.reduce(
		(k, r) => Math.min(k, r.primaryFields.length),
		first.primaryFields.length
	)
	for (let k = widest; k >= 1; k--) {
		const found = unitAt(violation, all, k)
		if (found !== undefined) {
			return Object.freeze({
				kind: "whole",
				law,
				reads: found.reads,
				unit: found.unit,
				...restrictToUnits(violation, found.unit, found.regions, facts, relations, loc)
			})
		}
	}
	return undefined
}

/** The ordinary relations a query matches or filters by, at any depth, sorted by name, each once. */
const storedReads = (
	query: InferredQuery,
	relations: ReadonlyMap<string, TheoryRelation>
): ReadonlyArray<RelationInfo> => {
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
	return [...names].toSorted(compareStrings).flatMap((name) => {
		const r = relations.get(name)
		return r?.kind === "relation" ? [r] : []
	})
}
