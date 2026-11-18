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
 * The judge reads a whole rule's violation restricted to the units a transaction wrote (`restrictToUnits`): every rule
 * of the query that reads a stored relation itself, by a match or a negation in its conditions, inside a negation or
 * not, is read per unit (`perUnit`), the region of the units' keys first, then the rule as a step, a subquery
 * PostgreSQL plans apart and reads LATERAL once per unit, its unit's variables the step's channels. So every read of a
 * stored relation is an index range at the unit key, which leads each stored relation's primary key, inside a step
 * whose region holds the written units alone: an aggregate's rule groups that unit's rows alone, and a negation reads
 * the written units' rows alone, whether PostgreSQL probes it at each fact or hashes it whole, whatever PostgreSQL
 * estimates of the region. The region is a set of unit keys: the union, over each
 * stored relation the rule reads and each side of its writes its captures hold (physical/ddl/rules.ts), of the leading
 * key fields of the rows that side holds. The restriction is one function for every whole rule, and it is the query's
 * own text, which the checker and the lowering read as they read any query.
 */
import { refuse } from "#compiler/analysis/theory/build.ts"
import { type LeafRewrite, mapBindings, mapLeaves } from "#compiler/analysis/theory/leaves.ts"
import {
	type LawSide,
	queryOf,
	type RelationRead,
	ruleDesc,
	type RuleLaw,
	varRef,
	type WholeRule
} from "#compiler/analysis/theory/query.ts"
import { compareText } from "#compiler/core/canonical.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type {
	FieldDesc,
	InferredExpr,
	InferredHead,
	InferredMatch,
	InferredQuery,
	InferredRule,
	InferredSource,
	InferredStage,
	VarDesc
} from "#compiler/ir/desc.ts"
import type { RelationInfo, TheoryRelation } from "#compiler/ir/law.ts"
import type { DeltaSide } from "#compiler/ir/rel.ts"
import { sameScalarType } from "#compiler/ir/scalar.ts"
import type { Unit } from "#compiler/ir/unit.ts"

/** The name the region delivers position `j` of the unit key under. */
const unitColumn = (j: number): string => `u${j}`

/** The variable a region's rule binds position `j` of the unit key to. */
const regionVar = (j: number): string => `unit.${j}`

/**
 * What a walk of a query reads (`walked`): the stored relations that may hold its unit, each with the leading key
 * fields that hold it; the region a restricting walk matches in every rule of it that reads a stored relation itself,
 * none for the walk that decides whether the query is unit-local; and every occurrence of a stored
 * relation the walk meets, in the order it meets them.
 */
interface Walk {
	readonly holders: ReadonlyMap<string, NonEmptyReadonlyArray<string>>
	readonly region: InferredSource | undefined
	readonly reads: Array<RelationRead>
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
	a.kind === b.kind && (a.kind !== "at" || (b.kind === "at" && sameNames(a.fields, b.fields)))

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

/** Whether two sequences of names are one. */
const sameNames = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	a.length === b.length && a.every((v, j) => v === b[j])

/**
 * The unit a source gives the rule that matches or negates it: `none`, a closed relation or a query that reads no
 * stored relation; `vars`, the rule's variables a stored relation's leading key fields, or an imported query's head
 * fields that deliver its unit, are bound to; or `hidden`, an imported query whose head delivers no unit.
 */
type SourceUnit =
	| { readonly kind: "none" }
	| { readonly kind: "vars"; readonly vars: ReadonlyArray<string> }
	| { readonly kind: "hidden" }

/** What a source delivers to the rule that reads it: its unit, whether it is a stored relation, and its text walked. */
interface SourceRead {
	readonly unit: SourceUnit
	readonly stored: boolean
	readonly source: InferredSource
}

/**
 * A source read where a rule matches or negates it with `bindings`, at `at` (`SourceRead`): a stored relation by its
 * leading key fields; an imported query of no bind map walked, by the head fields that deliver its unit; a closed
 * relation by none; not unit-local for any other source. Every occurrence of a stored or closed relation is read.
 */
const sourceUnit = (
	source: InferredSource,
	bindings: Readonly<Record<string, InferredExpr>>,
	at: At,
	w: Walk
): SourceRead | NotLocal => {
	switch (source.kind) {
		case "relation": {
			w.reads.push({
				relation: source.name,
				polarity: at.polarity,
				columns: Object.keys(bindings).toSorted(compareText)
			})
			const fields = w.holders.get(source.name)
			if (fields === undefined) {
				return { unit: { kind: "none" }, stored: false, source }
			}
			const vars = varsAt(bindings, fields)
			return vars === notLocal ? notLocal : { unit: { kind: "vars", vars }, stored: true, source }
		}
		case "query": {
			if (Object.keys(source.bind).length > 0) {
				return notLocal
			}
			const inner = walked(source.query, at, w)
			if (inner === notLocal) {
				return notLocal
			}
			const read = { ...source, query: inner.query }
			const delivered = inner.delivered
			switch (delivered.kind) {
				case "none":
					return { unit: { kind: "none" }, stored: false, source: read }
				case "hidden":
					return { unit: { kind: "hidden" }, stored: false, source: read }
				case "at": {
					const vars = varsAt(bindings, delivered.fields)
					return vars === notLocal
						? notLocal
						: { unit: { kind: "vars", vars }, stored: false, source: read }
				}
			}
		}
		case "self": {
			if (w.self === undefined) {
				return notLocal
			}
			const vars = varsAt(bindings, w.self)
			return vars === notLocal ? notLocal : { unit: { kind: "vars", vars }, stored: false, source }
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
 * An expression walked: every negation in it, at any depth, its source walked under the negation, and its unit, where
 * it reads one, the rule's own, `unit`, at which it is correlated, so the facts it reads lie in the rule's unit.
 */
const walkedExpr = (
	e: InferredExpr,
	unit: ReadonlyArray<string> | undefined,
	at: At,
	w: Walk
): InferredExpr | NotLocal => {
	const m = (x: InferredExpr): InferredExpr | NotLocal => walkedExpr(x, unit, at, w)
	switch (e.kind) {
		case "absent": {
			const read = sourceUnit(e.source, e.bindings, { polarity: flipped(at.polarity) }, w)
			if (read === notLocal) {
				return notLocal
			}
			const correlated =
				read.unit.kind === "none" ||
				(read.unit.kind === "vars" && unit !== undefined && sameNames(read.unit.vars, unit))
			return correlated ? { ...e, source: read.source } : notLocal
		}
		case "var":
		case "field":
		case "value":
		case "parent":
		case "param":
		case "literal":
			return e
		case "and":
		case "or": {
			const args = walkedExprs(e.args, unit, at, w)
			return args === notLocal || !isNonEmpty(args) ? notLocal : { ...e, args }
		}
		case "closedAt":
		case "closedHas": {
			const args = walkedExprs(e.args, unit, at, w)
			return args === notLocal || !isNonEmpty(args) ? notLocal : { ...e, args }
		}
		case "compute":
		case "closedRow": {
			const args = walkedExprs(e.args, unit, at, w)
			return args === notLocal ? notLocal : { ...e, args }
		}
		case "not":
		case "cast":
		case "guarded":
		case "base":
		case "in": {
			const arg = m(e.arg)
			return arg === notLocal ? notLocal : { ...e, arg }
		}
		case "compare":
		case "allen": {
			const left = m(e.left)
			const right = m(e.right)
			return left === notLocal || right === notLocal ? notLocal : { ...e, left, right }
		}
		case "cond": {
			const pred = m(e.pred)
			const onTrue = m(e.onTrue)
			const onFalse = m(e.onFalse)
			return pred === notLocal || onTrue === notLocal || onFalse === notLocal
				? notLocal
				: { ...e, pred, onTrue, onFalse }
		}
		case "when": {
			const subject = m(e.subject)
			const proved = m(e.proved)
			const otherwise = m(e.otherwise)
			return subject === notLocal || proved === notLocal || otherwise === notLocal
				? notLocal
				: { ...e, subject, proved, otherwise }
		}
		case "between": {
			const arg = m(e.arg)
			const low = m(e.low)
			const high = m(e.high)
			return arg === notLocal || low === notLocal || high === notLocal
				? notLocal
				: { ...e, arg, low, high }
		}
		case "pointIn": {
			const point = m(e.point)
			const span = m(e.span)
			return point === notLocal || span === notLocal ? notLocal : { ...e, point, span }
		}
	}
}

/** A rule as a walk leaves it: its text, and how it delivers its facts' units. */
interface WalkedRule {
	readonly rule: InferredRule
	readonly delivered: Delivered
	/** The variables its sources bind its unit to, none where it reads no unit or a hidden one. */
	readonly unit: ReadonlyArray<string> | undefined
}

/**
 * A rule walked. Its unit is its sources' (`SourceUnit`): every source that gives variables gives the same ones, its
 * unit; a source whose unit is hidden is its only source with a unit, and its facts each lie within one unit hidden in
 * turn, so it negates nothing of a unit and aggregates nothing. Each negation in its conditions is correlated at its
 * unit. An aggregating rule's matches are read at both polarities and its head delivers its unit, so its groups lie
 * inside one unit. Where the walk restricts and the rule reads a stored relation itself, by a match or a negation in its
 * conditions, the region is matched first, bound to its unit, a negated rule's as well as any other's.
 */
const walkedRule = (r: InferredRule, outer: At, w: Walk): WalkedRule | NotLocal => {
	if (r.interiors.length > 0 || r.attach.length > 0) {
		return notLocal
	}
	const aggregates = Object.values(r.head).some((h) => h.kind === "aggregate")
	const at: At = aggregates ? { polarity: "both" } : outer
	const units: Array<SourceUnit> = []
	let stored = false
	const matches: Array<InferredMatch> = []
	for (const match of r.matches) {
		const read = sourceUnit(match.source, match.bindings, at, w)
		if (read === notLocal) {
			return notLocal
		}
		units.push(read.unit)
		stored ||= read.stored
		matches.push({ ...match, source: read.source })
	}
	const bearing = units.filter((u) => u.kind !== "none")
	const hidden = bearing.some((u) => u.kind === "hidden")
	if (hidden && (bearing.length > 1 || aggregates)) {
		return notLocal
	}
	const vars = bearing.flatMap((u) => (u.kind === "vars" ? [u.vars] : []))
	const [unit] = vars
	if (unit !== undefined && !vars.every((v) => sameNames(v, unit))) {
		return notLocal
	}
	const where = walkedExprs(r.where, unit, at, w)
	if (where === notLocal) {
		return notLocal
	}
	if (unit === undefined) {
		return {
			rule: { ...r, matches, where },
			delivered: hidden ? hiddenUnit : noUnit,
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
			w.region !== undefined && (stored || r.where.some((x) => negatesHolder(x, w.holders)))
				? perUnit(walkedText, unit, w.region)
				: walkedText,
		delivered,
		unit
	}
}

/** Whether `e` negates a stored relation itself, at any depth of it: an absent whose source is a holder. */
const negatesHolder = (e: InferredExpr, holders: Walk["holders"]): boolean =>
	e.kind === "absent"
		? e.source.kind === "relation" && holders.has(e.source.name)
		: childrenOf(e).some((x) => negatesHolder(x, holders))

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
	const plain: Walk = { ...w, region: undefined }
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
	const region = w.region
	const ruleOf = (r: InferredRule): InferredRule => {
		const walkedOne = defined(read.get(r), "a walked rule per rule of the recursion")
		return region === undefined || walkedOne.unit === undefined
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
	if (region === undefined) {
		return { stage: recursion, delivered }
	}
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

/**
 * The region of a unit's keys: the union, over each of its holders and each side `sides` gives it, delta.added for a
 * side of news and delta.removed for one of olds, of the leading key fields of the rows the side holds, a set of unit
 * keys under `u0`…`u(k-1)`.
 */
const regionOf = (
	unit: Unit,
	sides: (relation: string) => ReadonlyArray<DeltaSide>,
	loc: SourceLoc
): InferredSource => {
	const rules = unit.holders.flatMap((h) =>
		sides(h.relation).map((side) =>
			ruleDesc(
				h.fields.map((field, j) => ({
					id: regionVar(j),
					origin: { relation: h.relation, field },
					loc
				})),
				[
					{
						source: { kind: "delta", side, relation: h.relation },
						bindings: Object.fromEntries(
							h.fields.map((f, j) => [f, varRef(regionVar(j))] as const)
						),
						loc
					}
				],
				[],
				Object.fromEntries(h.fields.map((_, j) => [unitColumn(j), varRef(regionVar(j))] as const)),
				loc
			)
		)
	)
	if (!isNonEmpty(rules)) {
		return refuse("MalformedDescription", loc, "a whole rule whose captures hold a side")
	}
	return { kind: "query", query: queryOf(rules, loc), bind: {} }
}

/**
 * `violation` restricted to the units a transaction wrote, the one restriction of every whole rule (see the header):
 * the region of `unit`'s keys, read from the sides `sides` gives each holder, matched in every rule of the query that
 * reads a stored relation itself, bound to that rule's unit. A defect where the query is not unit-local
 * at `unit`, which `wholeRule` decides before it restricts.
 */
const restrictToUnits = (
	violation: InferredQuery,
	unit: Unit,
	sides: (relation: string) => ReadonlyArray<DeltaSide>,
	loc: SourceLoc
): InferredQuery => {
	const read = walked(violation, top, {
		holders: holdersOf(unit),
		region: regionOf(unit, sides, loc),
		reads: [],
		self: undefined
	})
	if (read === notLocal) {
		throw defect("a whole rule's violation query is unit-local at its unit")
	}
	return read.query
}

/** The sides of a relation's writes a whole rule's captures hold, by the polarities its occurrences read. */
const sidesOf =
	(reads: ReadonlyArray<RelationRead>) =>
	(relation: string): ReadonlyArray<DeltaSide> => {
		const of = reads.filter((r) => r.relation === relation)
		return [
			...(of.some((r) => r.polarity !== "negative") ? ["added" as const] : []),
			...(of.some((r) => r.polarity !== "positive") ? ["removed" as const] : [])
		]
	}

/**
 * The unit of a query at width `k` over the stored relations it reads, `stored`, where it is unit-local there: its
 * key's types and holders, and every occurrence of a stored relation it reads; none where it is not.
 */
const unitAt = (
	violation: InferredQuery,
	stored: NonEmptyReadonlyArray<RelationInfo>,
	k: number
): { readonly unit: Unit; readonly reads: NonEmptyReadonlyArray<RelationRead> } | undefined => {
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
	const read = walked(violation, top, {
		holders: holdersOf(unit),
		region: undefined,
		reads,
		self: undefined
	})
	const [r0, ...rs] = reads
	return read === notLocal || r0 === undefined ? undefined : { unit, reads: [r0, ...rs] }
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
				judged: restrictToUnits(violation, found.unit, sidesOf(found.reads), loc)
			})
		}
	}
	return undefined
}

/** The ordinary relations a query matches or negates, at any depth, sorted by name, each once. */
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
		if (e.kind === "absent") {
			inSource(e.source)
			return
		}
		for (const x of childrenOf(e)) {
			inExpr(x)
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
	return [...names].toSorted(compareText).flatMap((name) => {
		const r = relations.get(name)
		return r?.kind === "relation" ? [r] : []
	})
}

/** The expressions directly inside `e`, a negation's none: its source is a query of its own. */
const childrenOf = (e: InferredExpr): ReadonlyArray<InferredExpr> => {
	switch (e.kind) {
		case "var":
		case "field":
		case "value":
		case "parent":
		case "param":
		case "literal":
		case "absent":
			return []
		case "and":
		case "or":
		case "compute":
		case "closedRow":
		case "closedAt":
		case "closedHas":
			return e.args
		case "not":
		case "cast":
		case "guarded":
		case "base":
		case "in":
			return [e.arg]
		case "compare":
		case "allen":
			return [e.left, e.right]
		case "cond":
			return [e.pred, e.onTrue, e.onFalse]
		case "when":
			return [e.subject, e.proved, e.otherwise]
		case "between":
			return [e.arg, e.low, e.high]
		case "pointIn":
			return [e.point, e.span]
	}
}
