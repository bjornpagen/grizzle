import { refuse, refuseNamed } from "#compiler/analysis/theory/build.ts"
import { appendAll } from "#compiler/core/array.ts"
import { compareText } from "#compiler/core/canonical.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import type {
	FieldDesc,
	InferredBindings,
	InferredExpr,
	InferredFieldDesc,
	InferredHead,
	InferredMatch,
	InferredQuery,
	InferredRule,
	InferredSource,
	InferredStage,
	SelectionDesc,
	TermDesc,
	VarDesc
} from "#compiler/ir/desc.ts"
import { connectiveExpr } from "#compiler/ir/desc.ts"
import { guardedTerm } from "#compiler/scalar/natural.ts"

/**
 * Rules over queries: a rule whose side reads a derived relation, judged on its definition, live.
 *
 * A side over a derived relation is its definition's facts projected onto the side's terms. The definition is read
 * live, every derived relation it matches inlined in turn (`liveArms`), into arms that each join stored and closed
 * relations by equalities, select by conditions over their variables and project onto heading terms: the
 * select-project-join queries a rule's side may be. Each negation of such an arm, alone as a filter or inside a
 * conjunction that is one, is read the same way: it negates the arms of a stored or closed relation, of a query or of
 * a derived relation, each a select-project-join arm of its own (`NegatedArm`). A definition that aggregates, recurses,
 * orders or takes, approximates, attaches or nests a stage, or negates a query that does or that negates in turn, is
 * refused (UnsupportedLawFamily), naming what it does.
 *
 * Every side of such a rule, a side over a stored relation among them, is read as arms (`SideArm`), so one
 * construction writes the rule's violation query (`violationQuery`), which the migration that adds the rule runs
 * over the rows it finds, and its trigger probes (`newProbes`, `oldProbes`), which the rule's deferred constraint
 * triggers run at COMMIT for the rows a transaction touched. Each is a query description the checker reads as any
 * query is, so grizzle's own query compiler types and lowers it. A relation a negated arm matches is read with the
 * negation's polarity: a row it gains withdraws the facts of the side that negates it, and a row it loses brings them
 * back.
 */

/** A match of a stored or closed relation in an arm, its bindings over the arm's variables. */
export interface ArmMatch {
	readonly relation: string
	readonly bindings: InferredBindings
	readonly loc: SourceLoc
}

/**
 * A conjunctive arm: its variables, its matches of stored and closed relations, its conditions over the variables, and
 * the fact it derives, a term per heading field.
 */
export interface ConjunctiveArm {
	readonly vars: ReadonlyArray<VarDesc>
	readonly matches: NonEmptyReadonlyArray<ArmMatch>
	readonly where: ReadonlyArray<InferredExpr>
	readonly head: Readonly<Record<string, InferredExpr>>
}

/**
 * A negation in an arm: that no fact of `arm`, an arm of what the definition negates, agrees with `bindings`, a term of
 * the negating arm for each heading field of `arm` the negation binds. `arm` is closed, its variables its own, and
 * nothing negates inside it. A negation of a union is one per arm of the union, since NOT EXISTS over a union is the
 * conjunction of NOT EXISTS over each arm, and an anti-join of one stored or closed relation is the arm of its one
 * match.
 */
export interface NegatedArm {
	readonly arm: ConjunctiveArm
	readonly bindings: InferredBindings
}

/** One arm of a definition: a conjunctive arm, and the negated arms each of which withdraws the facts it agrees with. */
export interface LiveArm extends ConjunctiveArm {
	readonly negated: ReadonlyArray<NegatedArm>
}

/** One arm of a rule's side: a live arm with the side's selection among its conditions, and the side's terms. */
export interface SideArm extends LiveArm {
	readonly terms: NonEmptyReadonlyArray<InferredExpr>
}

/**
 * A side of a rule over a query, as its statement declares it and as its arms read it: its relation, stored or derived,
 * its terms and selection, the selection's canonical texts, and its arms.
 */
export interface RuleSide {
	readonly relation: string
	readonly terms: NonEmptyReadonlyArray<TermDesc>
	readonly selection: SelectionDesc
	readonly texts: ReadonlyArray<string>
	readonly arms: NonEmptyReadonlyArray<SideArm>
}

/**
 * A rule at least one of whose sides reads a derived relation: a containment, a key over a derived relation's side,
 * or a row check over a derived relation's facts.
 */
export type QueryRule =
	| { readonly kind: "contained"; readonly from: RuleSide; readonly to: RuleSide }
	| { readonly kind: "key"; readonly side: RuleSide }
	| {
			readonly kind: "check"
			readonly name: string
			readonly predicate: InferredExpr
			/** The derived relation's facts: a side of every fact, its terms every heading field. */
			readonly side: RuleSide
	  }

/**
 * Where a live definition is read: each derived relation's definition by name, undefined for a stored or closed one, and
 * the descriptor each column of a definition, or of a query it imports, is delivered at.
 */
export interface LiveEnv {
	readonly definition: (relation: string) => InferredQuery | undefined
	/**
	 * The descriptor each column of `query`, read as a definition of `relation`, is delivered at, as the checker types
	 * it: the inferred field's own (analysis/derived/fields.ts fieldDescOf), a computed numeric's among them, which a
	 * bare head literal of the column is typed by, so the literal stands wherever a term of the column does.
	 */
	readonly columnType: (relation: string, query: InferredQuery, loc: SourceLoc) => ColumnTypes
	readonly loc: SourceLoc
}

/** The type of each column of a query's heading a bare head literal takes (LiveEnv.columnType). */
type ColumnTypes = (column: string) => InferredFieldDesc

/** The leaves an arm's expressions are rewritten by: a variable or a field, each to its replacement. */
interface Leaves {
	readonly var: (id: string) => InferredExpr | undefined
	readonly field: (field: string) => InferredExpr | undefined
}

/** `e` with every variable and field leaf `leaves` replaces, replaced; an imported query is closed and kept whole. */
const mapLeaves = (e: InferredExpr, leaves: Leaves): InferredExpr => {
	const m = (x: InferredExpr): InferredExpr => mapLeaves(x, leaves)
	switch (e.kind) {
		case "var":
			return leaves.var(e.var) ?? e
		case "field":
			return leaves.field(e.field) ?? e
		case "value":
		case "parent":
		case "param":
		case "literal":
			return e
		case "compute":
			return { ...e, args: e.args.map(m) }
		case "cast":
		case "base":
			return { ...e, arg: m(e.arg) }
		case "cond":
			return { ...e, pred: m(e.pred), onTrue: m(e.onTrue), onFalse: m(e.onFalse) }
		case "when":
			return { ...e, subject: m(e.subject), proved: m(e.proved), otherwise: m(e.otherwise) }
		case "compare":
			return { ...e, left: m(e.left), right: m(e.right) }
		case "between":
			return { ...e, arg: m(e.arg), low: m(e.low), high: m(e.high) }
		case "in":
			return { ...e, arg: m(e.arg) }
		case "and":
		case "or":
			return { ...e, args: mapNonEmpty(e.args, m) }
		case "not":
			return { ...e, arg: m(e.arg) }
		case "allen":
			return { ...e, left: m(e.left), right: m(e.right) }
		case "pointIn":
			return { ...e, point: m(e.point), span: m(e.span) }
		case "absent":
			return { ...e, bindings: mapBindings(e.bindings, leaves) }
		case "closedAt":
			return { ...e, args: mapNonEmpty(e.args, m) }
		case "closedRow":
			return { ...e, args: e.args.map(m) }
		case "closedHas":
			return { ...e, args: mapNonEmpty(e.args, m) }
	}
}

const mapBindings = (b: InferredBindings, leaves: Leaves): InferredBindings =>
	Object.fromEntries(Object.entries(b).map(([f, e]) => [f, mapLeaves(e, leaves)] as const))

/** The variables `e` reads, an imported query's own aside. */
const varsOf = (e: InferredExpr, into: Set<string>): Set<string> => {
	mapLeaves(e, {
		var: (id) => {
			into.add(id)
			return undefined
		},
		field: () => undefined
	})
	return into
}

/**
 * What an expression reads beyond a definition's own row: a negation below a disjunction, a negation or a scalar
 * expression, where it is no filter of the rule (check/scan.ts splitWhere), a parameter, a parent's column or a VALUE.
 */
const foreignLeaf = (e: InferredExpr): string | undefined => {
	let found: string | undefined
	const visit = (x: InferredExpr): void => {
		if (found !== undefined) {
			return
		}
		switch (x.kind) {
			case "absent":
				found = "negates a relation below a disjunction, a negation or a scalar expression"
				return
			case "param":
				found = "reads a parameter"
				return
			case "parent":
				found = "reads a parent's column"
				return
			case "value":
				found = "reads a contract's VALUE"
				return
			case "var":
			case "field":
			case "literal":
				return
			case "compute":
				x.args.forEach(visit)
				return
			case "cast":
			case "base":
			case "not":
				visit(x.arg)
				return
			case "cond":
				visit(x.pred)
				visit(x.onTrue)
				visit(x.onFalse)
				return
			case "when":
				visit(x.subject)
				visit(x.proved)
				visit(x.otherwise)
				return
			case "compare":
			case "allen":
				visit(x.left)
				visit(x.right)
				return
			case "between":
				visit(x.arg)
				visit(x.low)
				visit(x.high)
				return
			case "in":
				visit(x.arg)
				return
			case "and":
			case "or":
				x.args.forEach(visit)
				return
			case "pointIn":
				visit(x.point)
				visit(x.span)
				return
			case "closedAt":
			case "closedRow":
			case "closedHas":
				x.args.forEach(visit)
				return
		}
	}
	visit(e)
	return found
}

const eq = (left: InferredExpr, right: InferredExpr): InferredExpr => ({
	kind: "compare",
	op: "eq",
	left,
	right
})

/** A literal of no type of its own, which takes the type of the term it meets. */
type BareLiteral = Extract<InferredExpr, { readonly kind: "literal" }> & {
	readonly type?: undefined
}

/** Whether `e` is a bare literal, which takes the type of the term it meets and so never stands first. */
const isBare = (e: InferredExpr): e is BareLiteral => e.kind === "literal" && e.type === undefined

/** A bare literal under `type`, the type of the column it meets. */
const typedAs = (e: BareLiteral, type: InferredFieldDesc): InferredExpr => ({ ...e, type })

/**
 * `left` = `right` in the order the checker reads it: as written, but a bare literal second. A binding of a definition
 * may be a JavaScript literal, so every equality a rule's queries hold a binding by is built here.
 */
const equal = (left: InferredExpr, right: InferredExpr): InferredExpr =>
	isBare(left) ? eq(right, left) : eq(left, right)

const varRef = (id: string): InferredExpr => ({ kind: "var", var: id })

/** Whether a filter holds a negation as a filter of its rule: it is one, or a conjunction one of whose conjuncts does. */
const holdsNegation = (e: InferredExpr): boolean =>
	e.kind === "absent" || (e.kind === "and" && e.args.some(holdsNegation))

/**
 * A rule's filter as the filters of its conjunction: a conjunction that holds a negation its conjuncts, each so, and any
 * other filter itself, so a negation inside a conjunction is a filter of the rule as one standing alone is
 * (check/scan.ts splitWhere).
 */
const filtersOf = (e: InferredExpr): ReadonlyArray<InferredExpr> =>
	e.kind === "and" && holdsNegation(e) ? e.args.flatMap(filtersOf) : [e]

/** A conjunctive arm's own parts, read apart from what extends it. */
const conjunctive = (arm: ConjunctiveArm): ConjunctiveArm => ({
	vars: arm.vars,
	matches: arm.matches,
	where: arm.where,
	head: arm.head
})

/** A conjunctive arm joined to terms of another (`joined`): its variables left, its matches and its conditions. */
interface Joined {
	readonly vars: ReadonlyArray<VarDesc>
	readonly matches: NonEmptyReadonlyArray<ArmMatch>
	readonly where: ReadonlyArray<InferredExpr>
	/** The leaves of the arm's variables the bindings replaced, which every expression over them reads through. */
	readonly leaves: Leaves
}

/**
 * A conjunctive arm joined to terms of another through `bindings`, a term for each heading field of the arm it binds:
 * each heading field's variable that no earlier binding replaced is replaced by the term binding it, a bare literal
 * aside, and every other binding is an equality beside the arm's conditions. `missing` refuses a binding of a field the
 * arm derives none of.
 */
const joined = (
	arm: ConjunctiveArm,
	bindings: InferredBindings,
	missing: (field: string) => never
): Joined => {
	const local = new Set(arm.vars.map((v) => v.id))
	const replaced = new Map<string, InferredExpr>()
	const extra: Array<InferredExpr> = []
	const leaves: Leaves = { var: (id) => replaced.get(id), field: () => undefined }
	for (const [field, e] of Object.entries(bindings)) {
		const head = arm.head[field] ?? missing(field)
		const h = mapLeaves(head, leaves)
		if (h.kind === "var" && local.has(h.var) && !replaced.has(h.var) && !isBare(e)) {
			replaced.set(h.var, e)
		} else {
			extra.push(equal(e, h))
		}
	}
	return {
		vars: arm.vars.filter((v) => !replaced.has(v.id)),
		matches: mapNonEmpty(arm.matches, (m) => ({ ...m, bindings: mapBindings(m.bindings, leaves) })),
		where: [...arm.where.map((w) => mapLeaves(w, leaves)), ...extra],
		leaves
	}
}

/** Negated arms with their bindings read through `leaves`. */
const negatedThrough = (
	negated: ReadonlyArray<NegatedArm>,
	leaves: Leaves
): ReadonlyArray<NegatedArm> =>
	negated.map((n) => ({ arm: n.arm, bindings: mapBindings(n.bindings, leaves) }))

/** An arm still being flattened: no match yet is the arm of a rule that matched only derived relations so far. */
interface PartialArm {
	readonly vars: ReadonlyArray<VarDesc>
	readonly matches: ReadonlyArray<ArmMatch>
	readonly where: ReadonlyArray<InferredExpr>
	readonly head: Readonly<Record<string, InferredExpr>>
	readonly negated: ReadonlyArray<NegatedArm>
}

/**
 * A variable no match of `p` binds that an equality of its conditions defines: `name`, equal to `term`, a term over
 * variables the matches bind or a constant.
 */
interface Definition {
	readonly name: string
	readonly term: InferredExpr
	readonly at: number
}

/** The first definition among `p`'s conditions of a variable no match binds (Definition), or none. */
const definitionIn = (p: PartialArm): Definition | undefined => {
	const bound = boundVars(p.matches)
	const defines = (v: InferredExpr, term: InferredExpr, at: number): Definition | undefined =>
		v.kind === "var" &&
		!bound.has(v.var) &&
		[...varsOf(term, new Set())].every((id) => bound.has(id))
			? { name: v.var, term, at }
			: undefined
	for (const [at, w] of p.where.entries()) {
		if (w.kind === "compare" && w.op === "eq") {
			const found = defines(w.left, w.right, at) ?? defines(w.right, w.left, at)
			if (found !== undefined) {
				return found
			}
		}
	}
	return undefined
}

/**
 * `p` with every variable no match binds but an equality of its conditions defines replaced by the term it equals, and
 * that equality dropped: inlining a derived relation equates the variable a match binds to a column with the column's
 * head, which is that term where the head is a literal or computed term, so the variable is the term and every variable
 * left in the arm is one a match binds.
 */
const definedArm = (p: PartialArm): PartialArm => {
	const d = definitionIn(p)
	if (d === undefined) {
		return p
	}
	const leaves: Leaves = {
		var: (id) => (id === d.name ? d.term : undefined),
		field: () => undefined
	}
	return definedArm({
		vars: p.vars.filter((v) => v.id !== d.name),
		matches: p.matches.map((m) => ({ ...m, bindings: mapBindings(m.bindings, leaves) })),
		where: p.where.flatMap((w, at) => (at === d.at ? [] : [mapLeaves(w, leaves)])),
		head: mapBindings(p.head, leaves),
		negated: negatedThrough(p.negated, leaves)
	})
}

/** Flattens definitions, each inlined definition's variables under a fresh prefix of its own. */
class Flattener {
	readonly env: LiveEnv
	#next = 0

	constructor(env: LiveEnv) {
		this.env = env
	}

	#refuse(relation: string, what: string): never {
		return refuse(
			"UnsupportedLawFamily",
			this.env.loc,
			`a rule over a derived relation whose definition joins, selects and projects stored relations; ${relation}'s definition ${what}`
		)
	}

	/** Refuses a definition of a kind the types name too: one that aggregates, orders, recurses, searches or nests. */
	#refuseKind(refusal: Refused): never {
		return refuseNamed(this.env.loc, refusal)
	}

	/**
	 * The arms of `query`, a definition of `relation`, flattened, each bare head literal typed at its column's descriptor
	 * (LiveEnv.columnType), which the checker reads `query` for on the first such literal alone.
	 */
	arms(relation: string, query: InferredQuery): NonEmptyReadonlyArray<LiveArm> {
		let read: ColumnTypes | undefined
		const columns: ColumnTypes = (column) => {
			read ??= this.env.columnType(relation, query, this.env.loc)
			return read(column)
		}
		const arms = this.#stage(relation, query.stage, columns)
		if (!isNonEmpty(arms)) {
			return this.#refuse(relation, "derives no fact")
		}
		return arms
	}

	#stage(relation: string, stage: InferredStage, columns: ColumnTypes): ReadonlyArray<LiveArm> {
		switch (stage.kind) {
			case "rules":
				return stage.arms.flatMap((r) => this.#rule(relation, r, columns))
			case "union":
				return [
					...this.#stage(relation, stage.input, columns),
					...stage.arms.flatMap((r) => this.#rule(relation, r, columns))
				]
			case "named":
				return this.#stage(relation, stage.input, columns)
			case "recursive":
				return this.#refuseKind(
					"a rule reads a derived relation whose definition joins, selects and projects: this one recurses"
				)
			case "attach":
				return this.#refuseKind(
					"a rule reads a derived relation whose definition joins, selects and projects: this one attaches a nested query"
				)
			case "order":
			case "take":
				return this.#refuseKind(
					"a rule reads a derived relation whose definition joins, selects and projects: this one orders and takes"
				)
			case "approx":
				return this.#refuseKind(
					"a rule reads a derived relation whose definition joins, selects and projects: this one approximates a search"
				)
		}
	}

	/**
	 * One rule's arms: its own, every derived relation and imported query it matches inlined, each bare head literal typed
	 * at its column (`columns`).
	 */
	#rule(relation: string, rule: InferredRule, columns: ColumnTypes): ReadonlyArray<LiveArm> {
		if (rule.interiors.length > 0) {
			return this.#refuse(relation, "nests a stage")
		}
		if (rule.attach.length > 0) {
			return this.#refuseKind(
				"a rule reads a derived relation whose definition joins, selects and projects: this one attaches a nested query"
			)
		}
		const prefix = `q${this.#next++}.`
		const rename = (id: string): string => `${prefix}${id}`
		const leaves: Leaves = { var: (id) => varRef(rename(id)), field: () => undefined }
		const head: Record<string, InferredExpr> = {}
		for (const [name, term] of Object.entries(rule.head)) {
			const t = this.#headTerm(relation, term)
			head[name] = mapLeaves(isBare(t) ? typedAs(t, columns(name)) : t, leaves)
		}
		const where: Array<InferredExpr> = []
		const negated: Array<NegatedArm> = []
		for (const w of rule.where.flatMap(filtersOf)) {
			if (w.kind === "absent") {
				appendAll(negated, this.#negated(relation, w, leaves, rule.loc))
				continue
			}
			const foreign = foreignLeaf(w)
			if (foreign !== undefined) {
				return this.#refuse(relation, foreign)
			}
			where.push(mapLeaves(w, leaves))
		}
		let partials: ReadonlyArray<PartialArm> = [
			{
				vars: rule.vars.map((v) => ({ ...v, id: rename(v.id) })),
				matches: [],
				where,
				head,
				negated
			}
		]
		for (const match of rule.matches) {
			const bindings = mapBindings(match.bindings, leaves)
			for (const e of Object.values(match.bindings)) {
				const foreign = foreignLeaf(e)
				if (foreign !== undefined) {
					return this.#refuse(relation, foreign)
				}
			}
			const inlined = this.#source(relation, match.source, "matches")
			partials =
				inlined.kind === "stored"
					? partials.map((p) => ({
							...p,
							matches: [...p.matches, { relation: inlined.stored, bindings, loc: match.loc }]
						}))
					: partials.flatMap((p) =>
							inlined.arms.map((arm) => this.#merged(relation, p, arm, bindings))
						)
		}
		return partials.map((partial) => {
			const p = definedArm(partial)
			const [first, ...rest] = p.matches
			if (first === undefined) {
				return this.#refuse(relation, "matches no stored relation")
			}
			return { ...p, matches: [first, ...rest] }
		})
	}

	/**
	 * The partial arm `p` with the inlined arm `arm` joined in, through the bindings `bindings` of the match that inlined
	 * it: each heading field the match binds to an expression of `p` equals that expression, an inlined variable bound
	 * there replaced by it (`joined`), and the inlined arm's negations read through the same replacement.
	 */
	#merged(relation: string, p: PartialArm, arm: LiveArm, bindings: InferredBindings): PartialArm {
		const j = joined(arm, bindings, (field) =>
			this.#refuse(relation, `binds ${field}, which the definition it matches derives none of`)
		)
		return {
			vars: [...p.vars, ...j.vars],
			matches: [...p.matches, ...j.matches],
			where: [...p.where, ...j.where],
			head: p.head,
			negated: [...p.negated, ...negatedThrough(arm.negated, j.leaves)]
		}
	}

	/**
	 * The negated arms of a negation `w` in a rule of `relation`'s definition, its bindings read through the rule's
	 * `leaves`: the one arm of a stored or closed relation's one match, or one per arm of the derived relation or query it
	 * negates. An arm that negates in turn is refused, since a trigger reads each relation a negated arm matches with the
	 * polarity of one negation.
	 */
	#negated(
		relation: string,
		w: Extract<InferredExpr, { readonly kind: "absent" }>,
		leaves: Leaves,
		loc: SourceLoc
	): ReadonlyArray<NegatedArm> {
		for (const e of Object.values(w.bindings)) {
			const foreign = foreignLeaf(e)
			if (foreign !== undefined) {
				return this.#refuse(relation, foreign)
			}
		}
		const bindings = mapBindings(w.bindings, leaves)
		const source = this.#source(relation, w.source, "negates")
		if (source.kind === "stored") {
			return [{ arm: this.#relationArm(source.stored, Object.keys(bindings), loc), bindings }]
		}
		const negated =
			w.source.kind === "relation" ? `the derived relation ${w.source.name}` : "a query"
		return source.arms.map((arm): NegatedArm => {
			if (arm.negated.length > 0) {
				return this.#refuse(relation, `negates ${negated}, which negates in turn`)
			}
			for (const field of Object.keys(bindings)) {
				if (arm.head[field] === undefined) {
					return this.#refuse(
						relation,
						`binds ${field}, which ${negated} it negates derives none of`
					)
				}
			}
			return { arm: conjunctive(arm), bindings }
		})
	}

	/** The arm of one match of the stored or closed relation `relation`, binding each of `fields` to a variable it derives. */
	#relationArm(relation: string, fields: ReadonlyArray<string>, loc: SourceLoc): ConjunctiveArm {
		const prefix = `q${this.#next++}.`
		const bound = Object.fromEntries(fields.map((f) => [f, varRef(`${prefix}${f}`)] as const))
		return {
			vars: fields.map((f) => ({ id: `${prefix}${f}`, origin: { relation, field: f }, loc })),
			matches: [{ relation, bindings: bound, loc }],
			where: [],
			head: bound
		}
	}

	#headTerm(relation: string, term: InferredHead): InferredExpr {
		if (term.kind === "aggregate") {
			return this.#refuseKind(
				"a rule reads a derived relation whose definition joins, selects and projects: this one aggregates"
			)
		}
		if (term.kind === "producer") {
			return this.#refuseKind(
				"a rule reads a derived relation whose definition joins, selects and projects: this one produces spans"
			)
		}
		const foreign = foreignLeaf(term)
		return foreign === undefined ? term : this.#refuse(relation, foreign)
	}

	/**
	 * What a source the definition matches or negates (`verb`) is to an arm: a stored or closed relation, which the arm
	 * reads itself, or the arms it inlines, a derived relation's definition's or an imported query's that binds no
	 * parameter.
	 */
	#source(relation: string, source: InferredSource, verb: "matches" | "negates"): Matched {
		switch (source.kind) {
			case "relation": {
				const definition = this.env.definition(source.name)
				return definition === undefined
					? { kind: "stored", stored: source.name }
					: { kind: "inlined", arms: this.arms(source.name, definition) }
			}
			case "query":
				if (Object.keys(source.bind).length > 0) {
					return this.#refuse(relation, `${verb} an imported query that binds parameters`)
				}
				return { kind: "inlined", arms: this.arms(relation, source.query) }
			case "param":
			case "paramOf":
				return this.#refuse(relation, `${verb} a relation parameter`)
			case "context":
				return this.#refuse(relation, `${verb} a context`)
			case "interior":
			case "self":
			case "delta":
			case "row":
				return this.#refuse(relation, `${verb} a ${source.kind} source`)
		}
	}
}

/** What a match's source is to an arm (Flattener.#source). */
type Matched =
	| { readonly kind: "stored"; readonly stored: string }
	| { readonly kind: "inlined"; readonly arms: NonEmptyReadonlyArray<LiveArm> }

/** The live arms of the derived relation `relation`, whose definition is `query`. */
export const liveArms = (
	relation: string,
	query: InferredQuery,
	env: LiveEnv
): NonEmptyReadonlyArray<LiveArm> => new Flattener(env).arms(relation, query)

/** The heading of a definition's arms: the fields every arm derives, in the first arm's order. */
const armHeading = (arms: NonEmptyReadonlyArray<LiveArm>): ReadonlyArray<string> =>
	Object.keys(arms[0].head)

/**
 * The arms of a side over the derived relation whose live arms are `arms`: each arm with the side's selection, its
 * conjuncts over the heading read at the arm's head, among its conditions, each term's guard (pred(x) above zero)
 * beside them, and its terms read at the arm's head.
 */
export const derivedSideArms = (
	arms: NonEmptyReadonlyArray<LiveArm>,
	terms: NonEmptyReadonlyArray<TermDesc>,
	selection: SelectionDesc,
	loc: SourceLoc
): NonEmptyReadonlyArray<SideArm> =>
	mapNonEmpty(arms, (arm) => {
		const leaves: Leaves = {
			var: () => undefined,
			field: (f) =>
				arm.head[f] ??
				refuse("MalformedDescription", loc, `a side reading fields of its relation; ${f} is none`)
		}
		const guarded = mapNonEmpty(terms, guardedTerm)
		return {
			...arm,
			where: [
				...arm.where,
				...selection.conjuncts.map((c) => mapLeaves(c, leaves)),
				...guarded.flatMap((g) => g.guard.map((x) => mapLeaves(x, leaves)))
			],
			terms: mapNonEmpty(guarded, (g) => mapLeaves(g.term, leaves))
		}
	})

/** The fields a selection's conjunct reads. */
const fieldsOf = (e: InferredExpr, into: Set<string>): Set<string> => {
	mapLeaves(e, {
		var: () => undefined,
		field: (f) => {
			into.add(f)
			return undefined
		}
	})
	return into
}

/**
 * The one arm of a side over the stored or closed relation `relation`: a match binding each field the side reads,
 * its terms and its selection's, to a variable of its own, `prefix` keeping the arm's variables apart from another
 * side's.
 */
export const storedSideArm = (
	relation: string,
	terms: NonEmptyReadonlyArray<TermDesc>,
	selection: SelectionDesc,
	prefix: string,
	loc: SourceLoc
): SideArm => {
	const read = new Set<string>(terms.map((t) => t.field))
	for (const c of selection.conjuncts) {
		fieldsOf(c, read)
	}
	const fields = [...read].toSorted(compareText)
	const id = (f: string): string => `${prefix}${f}`
	const leaves: Leaves = { var: () => undefined, field: (f) => varRef(id(f)) }
	const bound = Object.fromEntries(fields.map((f) => [f, varRef(id(f))] as const))
	const guarded = mapNonEmpty(terms, guardedTerm)
	return {
		vars: fields.map((f) => ({ id: id(f), origin: { relation, field: f }, loc })),
		matches: [{ relation, bindings: bound, loc }],
		where: [
			...selection.conjuncts.map((c) => mapLeaves(c, leaves)),
			...guarded.flatMap((g) => g.guard.map((x) => mapLeaves(x, leaves)))
		],
		head: bound,
		negated: [],
		terms: mapNonEmpty(guarded, (g) => mapLeaves(g.term, leaves))
	}
}

/** The matches of an arm's negated arms, each a match of a relation the arm reads negatively. */
const negatedMatches = (arm: LiveArm): ReadonlyArray<ArmMatch> =>
	arm.negated.flatMap((n) => n.arm.matches)

/** The stored relations a rule's arms read, by a match or inside a negated arm, sorted, each once. */
export const ruleReads = (rule: QueryRule): ReadonlyArray<string> =>
	[
		...new Set(
			[...breakingArms(rule), ...targetArms(rule)].flatMap((a) =>
				[...a.matches, ...negatedMatches(a)].map((m) => m.relation)
			)
		)
	].toSorted(compareText)

/** The arms of a rule's breaking side: a containment's source, a key's side, a check's relation's facts. */
const breakingArms = (rule: QueryRule): NonEmptyReadonlyArray<SideArm> => {
	switch (rule.kind) {
		case "contained":
			return rule.from.arms
		case "key":
		case "check":
			return rule.side.arms
	}
}

/** The arms a rule's facts are withdrawn from: a containment's target's; a key and a check withdraw none. */
const targetArms = (rule: QueryRule): ReadonlyArray<SideArm> =>
	rule.kind === "contained" ? rule.to.arms : []

/** The name of a rule's i-th pair, or of its i-th key term, in the queries the rule is written in. */
const termName = (i: number): string => `t${i}`

/** The name a key's query gives a heading field, apart from every term's. */
const headName = (field: string): string => `f_${field}`

/** The fresh variable a key's other fact holds a heading field in. */
const otherId = (field: string): string => `other.${field}`

/** The fresh variable a lost tuple's probe reads an unbound term in. */
const wildcardId = (i: number): string => `wild.${i}`

/** An imported query of rules, binding no parameter. */
const imported = (arms: NonEmptyReadonlyArray<InferredRule>, loc: SourceLoc): InferredSource => ({
	kind: "query",
	query: queryOf(arms, loc),
	bind: {}
})

const queryOf = (arms: NonEmptyReadonlyArray<InferredRule>, loc: SourceLoc): InferredQuery => ({
	stage: { kind: "rules", arms, loc }
})

const matchDesc = (m: ArmMatch): InferredMatch => ({
	source: { kind: "relation", name: m.relation },
	bindings: m.bindings,
	loc: m.loc
})

const ruleDesc = (
	vars: ReadonlyArray<VarDesc>,
	matches: ReadonlyArray<InferredMatch>,
	where: ReadonlyArray<InferredExpr>,
	head: Readonly<Record<string, InferredExpr>>,
	loc: SourceLoc
): InferredRule => ({ vars, matches, where, head, interiors: [], attach: [], loc })

const termHead = (terms: ReadonlyArray<InferredExpr>): Readonly<Record<string, InferredExpr>> =>
	Object.fromEntries(terms.map((t, i) => [termName(i), t] as const))

/**
 * The negation `n` as an anti-join of one stored or closed relation, where its arm is that relation's facts as they are:
 * one match, no condition, each column it binds bound to a variable of its own, and a head that renames those
 * variables. Its bindings are then the negation's composed through the arm's, each heading field's term bound to the
 * column the field renames, and a column the head does not carry stays unbound, as an anti-join of the relation reads
 * it. Undefined for any other arm.
 */
const relationAbsent = (
	n: NegatedArm
): Extract<InferredExpr, { readonly kind: "absent" }> | undefined => {
	const [match, ...more] = n.arm.matches
	if (more.length > 0 || n.arm.where.length > 0) {
		return undefined
	}
	const columnOf = new Map<string, string>()
	for (const [column, bound] of Object.entries(match.bindings)) {
		if (bound.kind !== "var" || columnOf.has(bound.var)) {
			return undefined
		}
		columnOf.set(bound.var, column)
	}
	const renamed = new Map<string, string>()
	for (const [field, term] of Object.entries(n.arm.head)) {
		const column = term.kind === "var" ? columnOf.get(term.var) : undefined
		if (column === undefined) {
			return undefined
		}
		renamed.set(field, column)
	}
	const bindings: Record<string, InferredExpr> = {}
	for (const [field, term] of Object.entries(n.bindings)) {
		const column = renamed.get(field)
		if (column === undefined || bindings[column] !== undefined) {
			return undefined
		}
		bindings[column] = term
	}
	return { kind: "absent", source: { kind: "relation", name: match.relation }, bindings }
}

/**
 * That no fact of a negated arm agrees with its bindings: an anti-join of the one relation the arm reads as it is
 * (`relationAbsent`), a negation of a stored or closed relation among them, as its definition states it; else an
 * anti-join of the arm, read as an imported query.
 */
const absentOf = (n: NegatedArm, loc: SourceLoc): InferredExpr =>
	relationAbsent(n) ?? {
		kind: "absent",
		source: imported(
			[ruleDesc(n.arm.vars, n.arm.matches.map(matchDesc), n.arm.where, n.arm.head, loc)],
			loc
		),
		bindings: n.bindings
	}

/** An arm's conditions as a query states them: its own, then an anti-join of each of its negated arms. */
const conditionsOf = (arm: LiveArm, loc: SourceLoc): ReadonlyArray<InferredExpr> => [
	...arm.where,
	...arm.negated.map((n) => absentOf(n, loc))
]

/** The tuples of a side's arms, each term under its pair's name: what a containment's other side meets. */
const tuples = (side: RuleSide, loc: SourceLoc): InferredSource =>
	imported(
		mapNonEmpty(side.arms, (a) =>
			ruleDesc(a.vars, a.matches.map(matchDesc), conditionsOf(a, loc), termHead(a.terms), loc)
		),
		loc
	)

/** The facts of a key's side: each its terms under their pair names and its heading fields under their head names. */
const facts = (side: RuleSide, heading: ReadonlyArray<string>, loc: SourceLoc): InferredSource =>
	imported(
		mapNonEmpty(side.arms, (a) =>
			ruleDesc(
				a.vars,
				a.matches.map(matchDesc),
				conditionsOf(a, loc),
				{
					...termHead(a.terms),
					...Object.fromEntries(heading.map((f) => [headName(f), headOf(a, f, loc)] as const))
				},
				loc
			)
		),
		loc
	)

const headOf = (arm: ConjunctiveArm, field: string, loc: SourceLoc): InferredExpr =>
	arm.head[field] ??
	refuse(
		"MalformedDescription",
		loc,
		`a definition whose arms derive one heading; an arm derives no ${field}`
	)

/**
 * The rule of a violation query an arm of the rule's breaking side states, the arm as a probe may restrict it: for a
 * containment, its tuples the target lacks; for a key, its facts another fact of the side agrees with on the key and
 * differs from elsewhere in the heading; for a check, its facts the condition refuses.
 */
const violating = (rule: QueryRule, arm: SideArm, loc: SourceLoc): InferredRule => {
	switch (rule.kind) {
		case "contained":
			return ruleDesc(
				arm.vars,
				arm.matches.map(matchDesc),
				[
					...conditionsOf(arm, loc),
					{ kind: "absent", source: tuples(rule.to, loc), bindings: termHead(arm.terms) }
				],
				termHead(arm.terms),
				loc
			)
		case "key": {
			const heading = armHeading(rule.side.arms)
			const other: Record<string, InferredExpr> = { ...termHead(arm.terms) }
			for (const f of heading) {
				other[headName(f)] = varRef(otherId(f))
			}
			return ruleDesc(
				[...arm.vars, ...heading.map((f) => ({ id: otherId(f), origin: undefined, loc }))],
				[
					...arm.matches.map(matchDesc),
					{ source: facts(rule.side, heading, loc), bindings: other, loc }
				],
				[
					...conditionsOf(arm, loc),
					connectiveExpr(
						"or",
						heading.map((f): InferredExpr => ({
							kind: "compare",
							op: "ne",
							left: headOf(arm, f, loc),
							right: varRef(otherId(f))
						}))
					)
				],
				termHead(arm.terms),
				loc
			)
		}
		case "check": {
			const leaves: Leaves = { var: () => undefined, field: (f) => headOf(arm, f, loc) }
			return ruleDesc(
				arm.vars,
				arm.matches.map(matchDesc),
				[...conditionsOf(arm, loc), { kind: "not", arg: mapLeaves(rule.predicate, leaves) }],
				termHead(arm.terms),
				loc
			)
		}
	}
}

/** The violation query of a rule over a query, which must be empty: every fact of its breaking side that breaks it. */
export const violationQuery = (rule: QueryRule, loc: SourceLoc): InferredQuery =>
	queryOf(
		mapNonEmpty(breakingArms(rule), (arm) => violating(rule, arm, loc)),
		loc
	)

/** A parameter of a probe: the field of the touched row, NEW or OLD, it reads. */
export interface ProbeParam {
	readonly record: "NEW" | "OLD"
	readonly field: string
}

/** A probe: a violation query over the rows a write touched, and what each of its parameters reads, by name. */
export interface Probe {
	readonly query: InferredQuery
	readonly params: ReadonlyMap<string, ProbeParam>
}

/** A field of the touched relation, with the descriptor a parameter reading it is typed by. */
export interface TouchedField {
	readonly name: string
	readonly desc: FieldDesc
}

const paramName = (record: "NEW" | "OLD", field: string): string =>
	`${record === "NEW" ? "new" : "old"}_${field}`

const paramOf = (record: "NEW" | "OLD", field: TouchedField): InferredExpr => ({
	kind: "param",
	name: paramName(record, field.name),
	type: field.desc
})

/** The field of the touched relation named `name`, refused where it has none. */
const touchedField =
	(fields: ReadonlyArray<TouchedField>, relation: string, loc: SourceLoc) =>
	(name: string): TouchedField =>
		fields.find((f) => f.name === name) ??
		refuse("MalformedDescription", loc, `a field ${relation}.${name}`)

/** The variables a match binds itself, never through an expression over them. */
const boundVars = (matches: ReadonlyArray<ArmMatch>): ReadonlySet<string> =>
	new Set(
		matches.flatMap((m) =>
			Object.values(m.bindings).flatMap((e) => (e.kind === "var" ? [e.var] : []))
		)
	)

/**
 * A probe's match held to the row its trigger touched (`held`): the variables the row's fields replaced, the variables
 * left free, the matches it reads as they stand and its conditions, each read through the replacement.
 */
interface Held {
	readonly replaced: ReadonlySet<string>
	readonly leaves: Leaves
	/** The variables only a dropped match binds, which nothing the probe reads holds. */
	readonly free: ReadonlySet<string>
	readonly unbound: (e: InferredExpr) => boolean
	readonly kept: ReadonlyArray<ArmMatch>
	readonly where: ReadonlyArray<InferredExpr>
}

/**
 * The match `touched` held to the row its trigger touched, read at `record`, beside the variables `bound` the rest of
 * the probe binds, the matches `kept` it reads as they stand and the matches `relaxed` it drops: each variable `touched`
 * binds that neither `bound` nor a kept match binds is the row's field, every other binding of it an equality with the
 * field (a pin), after the conditions `where`. A variable only a relaxed match binds is free, and a kept match's binding
 * or a condition over one is dropped, so the probe reads every candidate the dropped matches would have let through.
 */
const held = (
	touched: ArmMatch,
	record: "NEW" | "OLD",
	bound: ReadonlySet<string>,
	kept: ReadonlyArray<ArmMatch>,
	relaxed: ReadonlyArray<ArmMatch>,
	where: ReadonlyArray<InferredExpr>,
	fieldOf: (name: string) => TouchedField,
	params: Map<string, ProbeParam>
): Held => {
	const byKept = new Set([...bound, ...boundVars(kept)])
	const replaced = new Map<string, InferredExpr>()
	const pinned: Array<InferredExpr> = []
	for (const [field, e] of Object.entries(touched.bindings)) {
		const value = paramOf(record, fieldOf(field))
		params.set(paramName(record, field), { record, field })
		if (e.kind === "var" && !byKept.has(e.var) && !replaced.has(e.var)) {
			replaced.set(e.var, value)
		} else {
			pinned.push(equal(e, value))
		}
	}
	const free = new Set([...boundVars(relaxed)].filter((id) => !byKept.has(id) && !replaced.has(id)))
	const leaves: Leaves = { var: (id) => replaced.get(id), field: () => undefined }
	const unbound = (e: InferredExpr): boolean => [...varsOf(e, new Set())].some((id) => free.has(id))
	return {
		replaced: new Set(replaced.keys()),
		leaves,
		free,
		unbound,
		kept: kept.map((k): ArmMatch => {
			const bindings: Record<string, InferredExpr> = {}
			for (const [f, e] of Object.entries(k.bindings)) {
				const mapped = mapLeaves(e, leaves)
				if (!unbound(mapped)) {
					bindings[f] = mapped
				}
			}
			return { ...k, bindings }
		}),
		where: [...where, ...pinned].map((w) => mapLeaves(w, leaves)).filter((w) => !unbound(w))
	}
}

/**
 * A negated arm of `arm` opened into it: its matches and conditions joined to the terms of `arm` its negation binds
 * (`joined`), so a probe reads, positively, the facts of the negated arm that agree with a fact of `arm`.
 */
const opened = (n: NegatedArm, loc: SourceLoc): Joined =>
	joined(n.arm, n.bindings, (field) =>
		refuse("MalformedDescription", loc, `a negated arm that derives the field ${field} it binds`)
	)

/**
 * The probes of each occurrence of `relation` in a negated arm of `arms`, each by its arm, the negated arm opened into
 * it, and the occurrence with its index among the opened arm's matches.
 */
const negatedProbes = <A extends LiveArm>(
	arms: ReadonlyArray<A>,
	relation: string,
	loc: SourceLoc,
	probe: (arm: A, open: Joined, touched: ArmMatch, at: number) => Probe
): ReadonlyArray<Probe> =>
	arms.flatMap((arm) =>
		arm.negated.flatMap((n) => {
			const open = opened(n, loc)
			return open.matches.flatMap((m, at) =>
				m.relation === relation ? [probe(arm, open, m, at)] : []
			)
		})
	)

/**
 * The probes an INSERT or an UPDATE of `relation`'s row runs at COMMIT, NEW its values:
 *
 * - for the facts it adds: one per occurrence of the relation in an arm of the rule's breaking side, the arm with that
 *   occurrence held to the row now stored at NEW's primary key, `key`, and the rule's violation read over it. A row
 *   deleted or changed later in the transaction is judged as it stands at COMMIT, which its own write probes again;
 * - for the target tuples it withdraws: one per occurrence of the relation in a negated arm of an arm of a
 *   containment's target. The negated arm is opened into the target's arm (`opened`), its occurrence held to NEW's
 *   values and its other matches read as they stand, the tuples NEW now blocks, which stand blocked at COMMIT by a fact
 *   that reads NEW where they stood before. The target arm's negations are dropped: a tuple two inserts block at once,
 *   each through a negation of its own, is blocked by the other's too, and is a candidate all the same. The source
 *   tuples that need a candidate and that the target no longer holds are the violation.
 */
export const newProbes = (
	rule: QueryRule,
	relation: string,
	key: NonEmptyReadonlyArray<TouchedField>,
	fields: ReadonlyArray<TouchedField>,
	loc: SourceLoc
): ReadonlyArray<Probe> => {
	const keyed = new Map(
		key.map((f) => [paramName("NEW", f.name), { record: "NEW", field: f.name }] as const)
	)
	const added = breakingArms(rule).flatMap((arm) =>
		arm.matches.flatMap((m, i): ReadonlyArray<Probe> => {
			if (m.relation !== relation) {
				return []
			}
			const bindings: Record<string, InferredExpr> = { ...m.bindings }
			const pinned: Array<InferredExpr> = []
			for (const f of key) {
				const bound = bindings[f.name]
				if (bound === undefined) {
					bindings[f.name] = paramOf("NEW", f)
				} else {
					pinned.push(equal(bound, paramOf("NEW", f)))
				}
			}
			const restricted: SideArm = {
				...arm,
				matches: mapNonEmpty(arm.matches, (x, j) => (j === i ? { ...x, bindings } : x)),
				where: [...arm.where, ...pinned]
			}
			return [{ query: queryOf([violating(rule, restricted, loc)], loc), params: keyed }]
		})
	)
	if (rule.kind !== "contained") {
		return added
	}
	const fieldOf = touchedField(fields, relation, loc)
	const blocked = negatedProbes(rule.to.arms, relation, loc, (arm, open, touched, at): Probe => {
		const params = new Map<string, ProbeParam>()
		const h = held(
			touched,
			"NEW",
			boundVars(arm.matches),
			open.matches.filter((_, j) => j !== at),
			[],
			open.where,
			fieldOf,
			params
		)
		return {
			query: queryOf(
				[
					ruleDesc(
						[...arm.vars, ...open.vars.filter((v) => !h.replaced.has(v.id))],
						[
							{ source: tuples(rule.from, loc), bindings: termHead(arm.terms), loc },
							...arm.matches.map(matchDesc),
							...h.kept.map(matchDesc)
						],
						[
							...arm.where,
							...h.where,
							{ kind: "absent", source: tuples(rule.to, loc), bindings: termHead(arm.terms) }
						],
						termHead(arm.terms),
						loc
					)
				],
				loc
			),
			params
		}
	})
	return [...added, ...blocked]
}

/**
 * The probes a DELETE or an UPDATE of `relation`'s row runs at COMMIT, OLD its values:
 *
 * - for the target tuples it withdraws: one per occurrence of the relation in an arm of a containment's target. The
 *   occurrence is replaced by OLD's values, the matches declared before it are read as they stand, and those after it
 *   are dropped, every term only they bind a wildcard: a tuple whose rows the transaction removes from several matches
 *   is still withdrawn by the first of them, whose probe reads none of the later ones. The arm's negations are dropped
 *   too: a tuple the transaction both withdraws and blocks, its row deleted and a row of a negated relation inserted,
 *   is withdrawn by the delete, whose probe reads no insert, where the insert's probe reads the row as it stands,
 *   deleted. The source tuples that agree with a candidate on its bound terms and that the target no longer holds are
 *   the violation, so a candidate the dropped matches or negations would have excluded is judged against the target
 *   all the same;
 * - for the facts it adds by no longer blocking them: one per occurrence of the relation in a negated arm of an arm of
 *   the rule's breaking side. The negated arm is opened into the arm (`opened`) and read as a target's arm is, its
 *   occurrence held to OLD's values, the matches declared before it read as they stand and those after it dropped, so
 *   the facts some fact of the negated arm that read OLD blocked are the candidates, however many of its rows the
 *   transaction removes; the rule's violation is read over them, the arm's negations as they stand at COMMIT.
 */
export const oldProbes = (
	rule: QueryRule,
	relation: string,
	fields: ReadonlyArray<TouchedField>,
	loc: SourceLoc
): ReadonlyArray<Probe> => {
	const fieldOf = touchedField(fields, relation, loc)
	const lost =
		rule.kind === "contained"
			? rule.to.arms.flatMap((arm) =>
					arm.matches.flatMap((m, i): ReadonlyArray<Probe> =>
						m.relation === relation ? [lostProbe(rule, arm, m, i, fieldOf, loc)] : []
					)
				)
			: []
	const unblocked = negatedProbes(
		breakingArms(rule),
		relation,
		loc,
		(arm, open, touched, at): Probe => {
			const params = new Map<string, ProbeParam>()
			const h = held(
				touched,
				"OLD",
				boundVars(arm.matches),
				open.matches.slice(0, at),
				open.matches.slice(at + 1),
				open.where,
				fieldOf,
				params
			)
			const restricted: SideArm = {
				...arm,
				vars: [...arm.vars, ...open.vars.filter((v) => !h.replaced.has(v.id) && !h.free.has(v.id))],
				matches: [...arm.matches, ...h.kept],
				where: [...arm.where, ...h.where]
			}
			return { query: queryOf([violating(rule, restricted, loc)], loc), params }
		}
	)
	return [...lost, ...unblocked]
}

/** The probe of `touched`, the `at`-th match of an arm of a containment's target, held to OLD's values (oldProbes). */
const lostProbe = (
	rule: Extract<QueryRule, { readonly kind: "contained" }>,
	arm: SideArm,
	touched: ArmMatch,
	at: number,
	fieldOf: (name: string) => TouchedField,
	loc: SourceLoc
): Probe => {
	const params = new Map<string, ProbeParam>()
	const h = held(
		touched,
		"OLD",
		new Set(),
		arm.matches.slice(0, at),
		arm.matches.slice(at + 1),
		arm.where,
		fieldOf,
		params
	)
	const mappedTerms = arm.terms.map((t) => mapLeaves(t, h.leaves))
	const bound = mappedTerms.map((t, i): InferredExpr => (h.unbound(t) ? varRef(wildcardId(i)) : t))
	const wilds = mappedTerms.flatMap((t, i) =>
		h.unbound(t) ? [{ id: wildcardId(i), origin: undefined, loc }] : []
	)
	return {
		query: queryOf(
			[
				ruleDesc(
					[...arm.vars.filter((v) => !h.replaced.has(v.id) && !h.free.has(v.id)), ...wilds],
					[
						{ source: tuples(rule.from, loc), bindings: termHead(bound), loc },
						...h.kept.map(matchDesc)
					],
					[...h.where, { kind: "absent", source: tuples(rule.to, loc), bindings: termHead(bound) }],
					termHead(bound),
					loc
				)
			],
			loc
		),
		params
	}
}

/**
 * What a write of one relation can break of a rule that reads it: by INSERT or by an UPDATE of a column read, the
 * facts it adds as a breaking side's match and the target tuples it blocks as a match of a negated arm of a
 * containment's target (`news`); by DELETE or by an UPDATE of a column read, the target tuples it withdraws as a
 * target's match and the facts it unblocks as a match of a negated arm of the breaking side (`olds`); or both. Each
 * names the columns read.
 */
export type Touches =
	| { readonly kind: "news"; readonly news: ReadonlyArray<string> }
	| { readonly kind: "olds"; readonly olds: ReadonlyArray<string> }
	| {
			readonly kind: "both"
			readonly news: ReadonlyArray<string>
			readonly olds: ReadonlyArray<string>
	  }

/** The columns that arms' matches of `relation` and other arms' negated arms' matches of it read, sorted, each once. */
const columnsOf = (
	matched: ReadonlyArray<LiveArm>,
	negating: ReadonlyArray<LiveArm>,
	relation: string
): ReadonlyArray<string> | undefined => {
	const read = [...matched.flatMap((a) => a.matches), ...negating.flatMap(negatedMatches)].filter(
		(m) => m.relation === relation
	)
	return read.length === 0
		? undefined
		: [...new Set(read.flatMap((m) => Object.keys(m.bindings)))].toSorted(compareText)
}

/** What writing `relation` can break of `rule` (`Touches`), undefined where the rule reads no row of it. */
export const touches = (rule: QueryRule, relation: string): Touches | undefined => {
	const news = columnsOf(breakingArms(rule), targetArms(rule), relation)
	const olds = columnsOf(targetArms(rule), breakingArms(rule), relation)
	if (news === undefined) {
		return olds === undefined ? undefined : { kind: "olds", olds }
	}
	return olds === undefined ? { kind: "news", news } : { kind: "both", news, olds }
}
