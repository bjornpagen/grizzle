import { refuse, refuseNamed } from "#compiler/analysis/theory/build.ts"
import {
	type BareLiteral,
	equal,
	isBare,
	type LeafRewrite,
	mapBindings,
	mapLeaves,
	varRef,
	varsOf
} from "#compiler/analysis/theory/leaves.ts"
import { appendAll } from "#compiler/core/array.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import {
	extendNonEmpty,
	flatMapNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { mapRecord } from "#compiler/core/record.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import type {
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
import { connectiveExpr, exprChildren, mapExpr, refusalCondition } from "#compiler/ir/desc.ts"
import type { DeltaSide } from "#compiler/ir/rel.ts"
import type { Unit } from "#compiler/ir/unit.ts"
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
 * Every side of such a rule, a side over a stored relation among them, is read as arms (`SideArm`) by its probes
 * (`probes`), which the judge runs at COMMIT over the rows a transaction wrote, the side its facts meet read by arm, so each probe reads the rows of the keys its write reaches and never the
 * whole side (`readAs`). The rule's violation query (`violationQuery`), which the migration that adds the rule runs
 * over the rows it finds, reads each side whole, as its declared source, each definition a query of its own. Each is a
 * query description the checker reads as any query is, so grizzle's own query compiler types and lowers it. A relation a negated arm matches is read with the
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
 * A side of a rule over a query as its statement declares it: its relation, stored or derived, its terms and selection,
 * the selection's canonical texts, and its relation's heading, every field a fact of it holds, which a key's and a
 * check's violation reads whole.
 */
export interface LawSide {
	readonly relation: string
	readonly terms: NonEmptyReadonlyArray<TermDesc>
	readonly selection: SelectionDesc
	readonly texts: ReadonlyArray<string>
	readonly heading: NonEmptyReadonlyArray<string>
}

/** A side of a rule over a query as its probes read it: its declaration, and its arms (`SideArm`). */
export interface RuleSide extends LawSide {
	readonly arms: NonEmptyReadonlyArray<SideArm>
}

/** A rule over a query's law over sides `S`: a containment, a key over a side, or a row check over a relation's facts. */
export type RuleLaw<S> =
	| { readonly kind: "contained"; readonly from: S; readonly to: S }
	| { readonly kind: "key"; readonly side: S }
	| {
			readonly kind: "check"
			readonly name: string
			readonly predicate: InferredExpr
			/** The derived relation's facts: a side of every fact, its terms every heading field. */
			readonly side: S
	  }

/**
 * A rule at least one of whose sides reads a derived relation, judged at COMMIT by the rule judge (physical/ddl/rules.ts)
 * by the one strategy its kind states, chosen when the schema compiles (analysis/theory/unit.ts): a unit-local rule
 * whole, its violation read once over each unit a transaction wrote (`WholeRule`); any other by its probes of the facts
 * each row a transaction wrote touches (`ProbedRule`).
 */
export type QueryRule = ProbedRule | WholeRule

/**
 * A rule that is not unit-local, which the judge's probes judge, each reading the facts that break it about the rows a
 * write touched (`probes`), its sides read as their arms.
 */
export type ProbedRule = RuleLaw<RuleSide>

/**
 * A unit-local rule (analysis/theory/unit.ts), whatever its query reads: every relation it reads immutable and leading
 * its key with one unit key, which every rule of its violation query joins on, so every fact of its violation lies
 * within one unit. The judge reads its violation query, the one the migration that adds it runs, over the units a
 * transaction wrote (`judged`), once whatever rows of them it wrote, never row by row.
 */
export interface WholeRule {
	readonly kind: "whole"
	readonly law: RuleLaw<LawSide>
	/** Each occurrence of a stored relation its violation query reads, in the order the query reads them. */
	readonly reads: NonEmptyReadonlyArray<RelationRead>
	readonly unit: Unit
	/** The violation query restricted to the units a transaction wrote (unit.ts restrictToUnits): what the judge runs. */
	readonly judged: InferredQuery
	/**
	 * The holders whose gained rows its region reads only where they replace a row the transaction lost at the
	 * containment's `fields`, proved by a containment at generate time to open a fact only there (unit.ts replacedAt):
	 * the rows each lost, at those fields, which the judge captures for the region, beside the sides its occurrences
	 * read.
	 */
	readonly replaced: ReadonlyArray<ReplacedRead>
}

/** A holder whose lost rows a whole rule's region reads, and the fields, a key of it among them, at which the
 * containment that proves it pairs it (WholeRule `replaced`). */
export interface ReplacedRead {
	readonly relation: string
	readonly fields: NonEmptyReadonlyArray<string>
}

/**
 * One occurrence of a stored relation in a whole rule's violation query, and the columns it binds: positive where a
 * row it gains can add a violation (a match), negative where a row it loses can (a match under a negation), and both
 * where either can (a match an aggregate reads, which a row added or removed changes alike), its polarity composed
 * through every negation and aggregate it stands under.
 */
export interface RelationRead {
	readonly relation: string
	readonly polarity: "positive" | "negative" | "both"
	readonly columns: ReadonlyArray<string>
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

/**
 * What each kind of node reads beyond a definition's own row, by itself: a negation below a disjunction, a negation or a
 * scalar expression, where it is no filter of the rule (check/scan.ts splitWhere), a parameter, a parent's column or a
 * VALUE; any other kind reads nothing beyond the row but through its children.
 */
const foreignReads: { readonly [K in InferredExpr["kind"]]: string | undefined } = {
	absent: "negates a relation below a disjunction, a negation or a scalar expression",
	exists: "reads a relation's existence below a disjunction, a negation or a scalar expression",
	param: "reads a parameter",
	parent: "reads a parent's column",
	value: "reads a contract's VALUE",
	var: undefined,
	field: undefined,
	literal: undefined,
	compute: undefined,
	cast: undefined,
	base: undefined,
	guarded: undefined,
	cond: undefined,
	when: undefined,
	compare: undefined,
	between: undefined,
	in: undefined,
	and: undefined,
	or: undefined,
	not: undefined,
	allen: undefined,
	pointIn: undefined,
	call: undefined,
	closedAt: undefined,
	closedRow: undefined,
	closedHas: undefined
}

/** What an expression reads beyond a definition's own row (foreignReads), the first in description order, if any. */
const foreignLeaf = (e: InferredExpr): string | undefined =>
	foreignReads[e.kind] ??
	exprChildren(e).reduce<string | undefined>((found, c) => found ?? foreignLeaf(c.term), undefined)

/** A bare literal under `type`, the type of the column it meets. */
const typedAs = (e: BareLiteral, type: InferredFieldDesc): InferredExpr => ({ ...e, type })

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
	readonly leaves: LeafRewrite
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
	const leaves: LeafRewrite = { var: (id) => replaced.get(id), field: () => undefined }
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
	leaves: LeafRewrite
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
	const leaves: LeafRewrite = {
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
					"a rule reads a recursion only where it is unit-local: every relation it reads immutable, every match of it within one unit, and every step carrying the unit from self into its head"
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
		const leaves: LeafRewrite = { var: (id) => varRef(rename(id)), field: () => undefined }
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
		leaves: LeafRewrite,
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
			case "step":
				return this.#refuse(relation, `${verb} a navigation step`)
			case "param":
			case "paramOf":
				return this.#refuse(relation, `${verb} a relation parameter`)
			case "context":
				return this.#refuse(relation, `${verb} a context`)
			case "call":
				return this.#refuse(relation, `${verb} a declared function's rows`)
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
/**
 * The heading of a derived relation's definition, `relation`'s: the fields its first rule derives, every rule of a
 * definition deriving one heading (schema/own.ts admits no other), and a recursion's its declared row, which every arm
 * of it delivers exactly (check/recursion/scan.ts).
 */
export const headingOf = (
	relation: string,
	query: InferredQuery,
	loc: SourceLoc
): NonEmptyReadonlyArray<string> => {
	const fieldsOf = (stage: InferredStage): ReadonlyArray<string> => {
		switch (stage.kind) {
			case "rules":
				return Object.keys(stage.arms[0].head)
			case "union":
			case "named":
			case "attach":
			case "order":
			case "take":
			case "approx":
				return fieldsOf(stage.input)
			case "recursive":
				return Object.keys(stage.recursive.row)
		}
	}
	const [field, ...fields] = fieldsOf(query.stage)
	return field === undefined
		? refuse("MalformedDescription", loc, `a definition of ${relation} that derives a field`)
		: [field, ...fields]
}

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
		const leaves: LeafRewrite = {
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
	const fields = [...read].toSorted(compareStrings)
	const id = (f: string): string => `${prefix}${f}`
	const leaves: LeafRewrite = { var: () => undefined, field: (f) => varRef(id(f)) }
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

/**
 * The stored relations a rule reads, sorted, each once: a probed rule's by a match of its arms or inside a negated arm,
 * a whole rule's every occurrence its violation query reads.
 */
export const ruleReads = (rule: QueryRule): ReadonlyArray<string> => {
	switch (rule.kind) {
		case "contained":
		case "key":
		case "check":
			return [
				...new Set(
					[...breakingArms(rule), ...targetArms(rule)].flatMap((a) =>
						[...a.matches, ...negatedMatches(a)].map((m) => m.relation)
					)
				)
			].toSorted(compareStrings)
		case "whole":
			return [...new Set(rule.reads.map((r) => r.relation))].toSorted(compareStrings)
	}
}

/** The arms of a rule's breaking side: a containment's source, a key's side, a check's relation's facts. */
const breakingArms = (rule: ProbedRule): NonEmptyReadonlyArray<SideArm> => {
	switch (rule.kind) {
		case "contained":
			return rule.from.arms
		case "key":
		case "check":
			return rule.side.arms
	}
}

/** The arms a rule's facts are withdrawn from: a containment's target's; a key and a check withdraw none. */
const targetArms = (rule: ProbedRule): ReadonlyArray<SideArm> =>
	rule.kind === "contained" ? rule.to.arms : []

/** The name of a rule's i-th pair, or of its i-th key term, in the queries the rule is written in. */
const termName = (i: number): string => `t${i}`

/** The name a key's query gives a heading field, apart from every term's. */
const headName = (field: string): string => `f_${field}`

/** The fresh variable a key's other fact holds a heading field in. */
const otherId = (field: string): string => `other.${field}`

/** The name a key's grouped read gives the count of the side's facts at a key, apart from every term's. */
const factsName = "facts"

/** The fresh variable a key's violation reads its i-th key term in. */
const keyId = (i: number): string => `key.${i}`

/** The fresh variable a key's violation reads the count of the side's facts at a key in. */
const factsId = "key.facts"

/** The fresh variable a lost tuple's probe reads an unbound term in. */
const wildcardId = (i: number): string => `wild.${i}`

/** An imported query of rules, binding no parameter. */
const imported = (arms: NonEmptyReadonlyArray<InferredRule>, loc: SourceLoc): InferredSource => ({
	kind: "query",
	query: queryOf(arms, loc),
	bind: {}
})

export const queryOf = (
	arms: NonEmptyReadonlyArray<InferredRule>,
	loc: SourceLoc
): InferredQuery => ({
	stage: { kind: "rules", arms, loc }
})

const matchDesc = (m: ArmMatch): InferredMatch => ({
	source: { kind: "relation", name: m.relation },
	bindings: m.bindings,
	loc: m.loc
})

export const ruleDesc = (
	vars: ReadonlyArray<VarDesc>,
	matches: ReadonlyArray<InferredMatch>,
	where: ReadonlyArray<InferredExpr>,
	head: Readonly<Record<string, InferredHead>>,
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
const conditionsOf = (
	arm: Pick<LiveArm, "where" | "negated">,
	loc: SourceLoc
): ReadonlyArray<InferredExpr> => [...arm.where, ...arm.negated.map((n) => absentOf(n, loc))]

/** A side's arm as a probe meets it (`readAs`): the arm's query, and the bindings that join it to the meeting terms. */
interface Met {
	readonly source: InferredSource
	readonly bindings: Readonly<Record<string, InferredExpr>>
}

/**
 * The sources a trigger's probe reads the side its breaking side's facts meet as, a containment's target or a key's
 * other fact: an imported query of each arm alone, each arm's rule delivering the row `head` gives it. A probe's facts
 * are the rows its write touched and those its chain reaches from them, and PostgreSQL reads a side at the terms such a
 * fact meets it on only where the side is one select-project-join it can join at those terms: a union, whose
 * duplicates it removes first, it builds whole before any term meets it, so a probe that met the whole side would read
 * every fact of it at every call. Read by arm, a negation of the side is one negation per arm, since no tuple of a
 * union agrees with the terms exactly when no tuple of any arm does, and a match of it is one rule per arm, since the
 * facts that agree with some tuple of a union are those that agree with some tuple of one of its arms: a probe read by
 * arm judges exactly what the whole check (`violationQuery`) does.
 *
 * Each arm is met at `terms`, the terms of the fact or tuple that meets it (`Met`), each term bound to the arm's term of
 * its pair. A probe is navigated before it is checked (physical/ddl/rules.ts compileProbe), which inlines each arm and
 * equates its head with the terms it is met at (analysis/theory/navigate.ts), so a union's arm whose literal differs
 * from the term's is a condition of two literals that differ: the arm read alone reads none of the facts the term
 * selects, and the union read by arm still judges what the whole check does.
 */
const readAs = (
	side: RuleSide,
	terms: ReadonlyArray<InferredExpr>,
	head: (arm: SideArm) => Readonly<Record<string, InferredExpr>>,
	loc: SourceLoc
): NonEmptyReadonlyArray<Met> =>
	mapNonEmpty(side.arms, (a) => ({
		source: imported(
			[ruleDesc(a.vars, a.matches.map(matchDesc), conditionsOf(a, loc), head(a), loc)],
			loc
		),
		bindings: Object.fromEntries(terms.map((term, i) => [termName(i), term] as const))
	}))

/** The tuples of a side's arms met at `terms`, each term under its pair's name: what a containment's other side meets. */
const tuples = (
	side: RuleSide,
	terms: ReadonlyArray<InferredExpr>,
	loc: SourceLoc
): NonEmptyReadonlyArray<Met> => readAs(side, terms, (a) => termHead(a.terms), loc)

/** That no tuple of a side read by arm agrees with `terms`: one negation of each arm's source. */
const lacks = (
	side: RuleSide,
	terms: ReadonlyArray<InferredExpr>,
	loc: SourceLoc
): NonEmptyReadonlyArray<InferredExpr> =>
	mapNonEmpty(tuples(side, terms, loc), (met) => ({ kind: "absent", ...met }))

/**
 * The facts of a key's side met at `terms`: each its terms under their pair names and its heading fields under their
 * head names.
 */
const facts = (
	side: RuleSide,
	terms: ReadonlyArray<InferredExpr>,
	heading: ReadonlyArray<string>,
	loc: SourceLoc
): NonEmptyReadonlyArray<Met> =>
	readAs(
		side,
		terms,
		(a) => ({
			...termHead(a.terms),
			...Object.fromEntries(heading.map((f) => [headName(f), headOf(a, f, loc)] as const))
		}),
		loc
	)

const headOf = (arm: Pick<ConjunctiveArm, "head">, field: string, loc: SourceLoc): InferredExpr =>
	arm.head[field] ??
	refuse(
		"MalformedDescription",
		loc,
		`a definition whose arms derive one heading; an arm derives no ${field}`
	)

/**
 * An arm of a rule's breaking side as a probe reads it (`violating`): a side's arm, or one a probe of the added side
 * holds to its region (`addedProbes`), whose matches are the arm's others, none where the arm reads that relation alone.
 */
interface ProbeArm extends Omit<SideArm, "matches"> {
	readonly matches: ReadonlyArray<ArmMatch>
}

/**
 * The rules of a probe an arm of the rule's breaking side states, the arm as the probe restricts it, the side it meets
 * read by arm (`readAs`): for a containment, its tuples the target lacks; for a key, its facts another fact of the side
 * agrees with on the key and differs from elsewhere in the heading, a rule per arm of the side; for a check, its facts
 * the condition refuses.
 */
const violating = (
	rule: ProbedRule,
	arm: ProbeArm,
	loc: SourceLoc
): NonEmptyReadonlyArray<InferredRule> => {
	switch (rule.kind) {
		case "contained":
			return [
				ruleDesc(
					arm.vars,
					arm.matches.map(matchDesc),
					[...conditionsOf(arm, loc), ...lacks(rule.to, arm.terms, loc)],
					termHead(arm.terms),
					loc
				)
			]
		case "key": {
			const heading = rule.side.heading
			const other = Object.fromEntries(
				heading.map((f) => [headName(f), varRef(otherId(f))] as const)
			)
			return mapNonEmpty(facts(rule.side, arm.terms, heading, loc), (met) =>
				ruleDesc(
					[...arm.vars, ...heading.map((f) => ({ id: otherId(f), origin: undefined, loc }))],
					[
						...arm.matches.map(matchDesc),
						{ source: met.source, bindings: { ...met.bindings, ...other }, loc }
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
			)
		}
		case "check": {
			const leaves: LeafRewrite = { var: () => undefined, field: (f) => headOf(arm, f, loc) }
			return [
				ruleDesc(
					arm.vars,
					arm.matches.map(matchDesc),
					[...conditionsOf(arm, loc), refusalCondition(mapLeaves(rule.predicate, leaves))],
					termHead(arm.terms),
					loc
				)
			]
		}
	}
}

/** `e` with the source of every negation in it read through `source`, at any depth. */
const sourcesThrough = (
	e: InferredExpr,
	source: (s: InferredSource) => InferredSource
): InferredExpr => mapExpr(e, { leaf: (x) => x, term: (x) => sourcesThrough(x, source), source })

/**
 * The source a rule's full violation query reads the relation `relation` through: a stored or closed relation by its
 * name; a derived relation, materialized or not, as its definition, read live and imported as a query of its own
 * (`liveQuery`), never through its view, which the migration that checks the rule may not have filled.
 */
const liveSource = (relation: string, definition: LiveEnv["definition"]): InferredSource => {
	const d = definition(relation)
	return d === undefined
		? { kind: "relation", name: relation }
		: { kind: "query", query: liveQuery(d, definition), bind: {} }
}

/**
 * A definition read live: every derived relation it matches or negates, at any depth, a recursion's base and steps
 * among it, read as its own definition, live, imported (`liveSource`), and every query it imports read so in turn. Each
 * stays a query of its own, so its rows are computed at a level of their own, joined to the level that reads them by
 * the columns that level binds; none stays a relation by its name, which a walk of the query (analysis/theory/unit.ts)
 * would read as a closed relation, the same at every state and in no unit.
 */
const liveQuery = (query: InferredQuery, definition: LiveEnv["definition"]): InferredQuery => {
	const source = (s: InferredSource): InferredSource => {
		switch (s.kind) {
			case "relation":
				return liveSource(s.name, definition)
			case "query":
			case "step":
				return { ...s, query: liveQuery(s.query, definition) }
			case "call":
				return {
					...s,
					args: mapRecord(s.args, (a) =>
						a.kind === "rows" ? { ...a, query: liveQuery(a.query, definition) } : a
					)
				}
			case "param":
			case "paramOf":
			case "interior":
			case "self":
			case "delta":
			case "context":
			case "row":
				return s
		}
	}
	const rule = (r: InferredRule): InferredRule => ({
		...r,
		matches: r.matches.map((m) => ({ ...m, source: source(m.source) })),
		where: r.where.map((w) => sourcesThrough(w, source))
	})
	const stage = (st: InferredStage): InferredStage => {
		switch (st.kind) {
			case "rules":
				return { ...st, arms: mapNonEmpty(st.arms, rule) }
			case "union":
				return { ...st, input: stage(st.input), arms: mapNonEmpty(st.arms, rule) }
			case "named":
				return { ...st, input: stage(st.input) }
			case "recursive":
				return {
					...st,
					recursive: {
						...st.recursive,
						base: mapNonEmpty(st.recursive.base, rule),
						rec: mapNonEmpty(st.recursive.rec, rule)
					}
				}
			case "attach":
			case "order":
			case "take":
			case "approx":
				return st
		}
	}
	return { ...query, stage: stage(query.stage) }
}

/**
 * A side as a rule's full violation query reads it, whole: one match of the side's source (`liveSource`) binding each
 * field the side reads, its terms', its selection's and `also`, to a variable of its own under `prefix`; its selection
 * and its terms' guards over those variables; its terms; and each bound field's variable by the field's name.
 */
interface WholeSide {
	readonly vars: ReadonlyArray<VarDesc>
	readonly match: InferredMatch
	readonly where: ReadonlyArray<InferredExpr>
	readonly terms: NonEmptyReadonlyArray<InferredExpr>
	readonly fields: Readonly<Record<string, InferredExpr>>
}

const wholeSide = (
	side: LawSide,
	definition: LiveEnv["definition"],
	also: ReadonlyArray<string>,
	prefix: string,
	loc: SourceLoc
): WholeSide => {
	const read = new Set<string>([...side.terms.map((t) => t.field), ...also])
	for (const c of side.selection.conjuncts) {
		fieldsOf(c, read)
	}
	const fields = [...read].toSorted(compareStrings)
	const id = (f: string): string => `${prefix}${f}`
	const leaves: LeafRewrite = { var: () => undefined, field: (f) => varRef(id(f)) }
	const bound = Object.fromEntries(fields.map((f) => [f, varRef(id(f))] as const))
	const guarded = mapNonEmpty(side.terms, guardedTerm)
	return {
		vars: fields.map((f) => ({ id: id(f), origin: { relation: side.relation, field: f }, loc })),
		match: { source: liveSource(side.relation, definition), bindings: bound, loc },
		where: [
			...side.selection.conjuncts.map((c) => mapLeaves(c, leaves)),
			...guarded.flatMap((g) => g.guard.map((x) => mapLeaves(x, leaves)))
		],
		terms: mapNonEmpty(guarded, (g) => mapLeaves(g.term, leaves)),
		fields: bound
	}
}

/** The variable a whole side binds `field` to. */
const wholeField = (side: WholeSide, field: string, loc: SourceLoc): InferredExpr =>
	side.fields[field] ??
	refuse("MalformedDescription", loc, `a side reading fields of its relation; ${field} is none`)

/**
 * The violation query of a rule over a query, which must be empty: every fact of its breaking side that breaks it, the
 * side it meets read whole. Each side is read as its declared source (`wholeSide`), a derived relation as its
 * definition, live, and every derived relation that definition reads as its own, each a query of its own, rather than
 * as the side's arms (`SideArm`), which inline every definition into one join of every stored relation it reads. The
 * two judge the same facts: a definition's arms are its rules with every definition they read inlined, a join
 * distributed over the arms of a union it reads and a negation of a union read as one negation per arm, and every
 * level both read is a set, so neither multiplicity nor the order of the joins is observable; an equality of a column
 * a definition derives is the equality the inlined arm states over the term that derives it. Read whole, PostgreSQL
 * plans each definition's own joins at a level of their own, a few relations each, where the inlined arms are one join
 * of every relation the definitions read, whose join search grows with the subsets of those relations.
 *
 * A key's violation is every key at which its side holds more than one fact: the side read once, every heading field
 * bound so that each fact is one row of it, grouped by its terms, its facts counted. A side is a set, so two of its
 * facts at one key differ elsewhere in the heading: the keys counted more than once are exactly those at which a fact
 * meets another that agrees with it on the key and differs from it elsewhere, which a self-join of the side asks by
 * deriving the side twice.
 */
export const violationQuery = (
	rule: RuleLaw<LawSide>,
	definition: LiveEnv["definition"],
	loc: SourceLoc
): InferredQuery => {
	switch (rule.kind) {
		case "contained": {
			const from = wholeSide(rule.from, definition, [], "s0.", loc)
			const to = wholeSide(rule.to, definition, [], "s1.", loc)
			return queryOf(
				[
					ruleDesc(
						from.vars,
						[from.match],
						[
							...from.where,
							{
								kind: "absent",
								source: imported(
									[ruleDesc(to.vars, [to.match], to.where, termHead(to.terms), loc)],
									loc
								),
								bindings: termHead(from.terms)
							}
						],
						termHead(from.terms),
						loc
					)
				],
				loc
			)
		}
		case "key": {
			const side = wholeSide(rule.side, definition, rule.side.heading, "s0.", loc)
			const keyTerms = mapNonEmpty(side.terms, (_, i) => varRef(keyId(i)))
			const counted = imported(
				[
					ruleDesc(
						side.vars,
						[side.match],
						side.where,
						{ ...termHead(side.terms), [factsName]: { kind: "aggregate", fn: "count" } },
						loc
					)
				],
				loc
			)
			return queryOf(
				[
					ruleDesc(
						[
							...keyTerms.map((_, i) => ({ id: keyId(i), origin: undefined, loc })),
							{ id: factsId, origin: undefined, loc }
						],
						[
							{
								source: counted,
								bindings: { ...termHead(keyTerms), [factsName]: varRef(factsId) },
								loc
							}
						],
						[
							{
								kind: "compare",
								op: "gt",
								left: varRef(factsId),
								right: { kind: "literal", value: 1n }
							}
						],
						termHead(keyTerms),
						loc
					)
				],
				loc
			)
		}
		case "check": {
			const heading = rule.side.heading
			const one = wholeSide(rule.side, definition, heading, "s0.", loc)
			const leaves: LeafRewrite = { var: () => undefined, field: (f) => wholeField(one, f, loc) }
			return queryOf(
				[
					ruleDesc(
						one.vars,
						[one.match],
						[...one.where, refusalCondition(mapLeaves(rule.predicate, leaves))],
						termHead(one.terms),
						loc
					)
				],
				loc
			)
		}
	}
}

/**
 * A side of a table's writes a rule's probe reads (ir/rel.ts DeltaSide): the images the transaction's net write adds to
 * it, `added`, and the rows it found and removes, `removed`. Every other part of the judge names a side by this one
 * vocabulary: the probes of a side (`probes`), what a write of a table can break (Touches) and its session's delta
 * (physical/ddl/rules.ts).
 */
export type ProbeSide = Extract<DeltaSide, "added" | "removed">

/** The variable a probe over its region reads the touched row's field `field` in. */
const regionId = (field: string): string => `region.${field}`

/**
 * A probe's region (`held`): its match of the delta of the touched relation's side, which the probe reads first, and the
 * variables it binds, one per field the touched occurrence binds.
 */
interface Region {
	readonly match: InferredMatch
	readonly vars: ReadonlyArray<VarDesc>
}

/** `rule` read over `region`: the region's match first and its variables after the rule's own. */
const overRegion = (region: Region, rule: InferredRule): InferredRule => ({
	...rule,
	vars: [...rule.vars, ...region.vars],
	matches: [region.match, ...rule.matches]
})

/**
 * A probe of each rule of a violation query read by arm, each over `region`: a rule's violation over the rows of the
 * touched relation the transaction wrote on one side (ProbeSide), one rule whose first match is that side's delta
 * (`held`), binding each field of the row its occurrence reads to a region variable. A probe reads no parameter:
 * PostgreSQL joins the region as it joins any relation the probe reads.
 */
const probesOf = (
	region: Region,
	rules: NonEmptyReadonlyArray<InferredRule>,
	loc: SourceLoc
): ReadonlyArray<InferredQuery> => rules.map((rule) => queryOf([overRegion(region, rule)], loc))

/** The variables a match binds itself, never through an expression over them. */
const boundVars = (matches: ReadonlyArray<ArmMatch>): ReadonlySet<string> =>
	new Set(
		matches.flatMap((m) =>
			Object.values(m.bindings).flatMap((e) => (e.kind === "var" ? [e.var] : []))
		)
	)

/**
 * A probe's match held to its region (`held`): the region, the variables the region's fields replaced, the variables left
 * free, the matches it reads as they stand and its conditions, each read through the replacement.
 */
interface Held {
	readonly region: Region
	readonly replaced: ReadonlySet<string>
	readonly leaves: LeafRewrite
	/** The variables only a dropped match binds, which nothing the probe reads holds. */
	readonly free: ReadonlySet<string>
	readonly unbound: (e: InferredExpr) => boolean
	readonly kept: ReadonlyArray<ArmMatch>
	readonly where: ReadonlyArray<InferredExpr>
}

/**
 * The match `touched` held to its region, the rows of its relation the transaction wrote on `side` (Region), beside the
 * variables `bound` the rest of the probe binds, the matches `kept` it reads as they stand and the matches `relaxed` it
 * drops: each field `touched` binds is read from the region into a variable of its own, each variable `touched` binds
 * that neither `bound` nor a kept match binds is that variable, every other binding of it an equality with it (a pin),
 * after the conditions `where`. A variable only a relaxed match binds is free, and a kept match's binding or a condition
 * over one is dropped, so the probe reads every candidate the dropped matches would have let through.
 */
const held = (
	touched: ArmMatch,
	side: ProbeSide,
	bound: ReadonlySet<string>,
	kept: ReadonlyArray<ArmMatch>,
	relaxed: ReadonlyArray<ArmMatch>,
	where: ReadonlyArray<InferredExpr>,
	loc: SourceLoc
): Held => {
	const byKept = new Set([...bound, ...boundVars(kept)])
	const replaced = new Map<string, InferredExpr>()
	const pinned: Array<InferredExpr> = []
	const fields = Object.keys(touched.bindings)
	for (const [field, e] of Object.entries(touched.bindings)) {
		const value = varRef(regionId(field))
		if (e.kind === "var" && !byKept.has(e.var) && !replaced.has(e.var)) {
			replaced.set(e.var, value)
		} else {
			pinned.push(equal(e, value))
		}
	}
	const free = new Set([...boundVars(relaxed)].filter((id) => !byKept.has(id) && !replaced.has(id)))
	const leaves: LeafRewrite = { var: (id) => replaced.get(id), field: () => undefined }
	const unbound = (e: InferredExpr): boolean => [...varsOf(e, new Set())].some((id) => free.has(id))
	return {
		region: {
			match: {
				source: { kind: "delta", side, relation: touched.relation },
				bindings: Object.fromEntries(fields.map((f) => [f, varRef(regionId(f))] as const)),
				loc
			},
			vars: fields.map((field): VarDesc => ({
				id: regionId(field),
				origin: { relation: touched.relation, field },
				loc
			}))
		},
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

/** The matches a probe of the removed side reads as they stand, and those it drops (removedProbes). */
interface Relaxed {
	readonly kept: ReadonlyArray<ArmMatch>
	readonly dropped: ReadonlyArray<ArmMatch>
}

/**
 * The relaxation of the `at`-th of an arm's `matches`: the matches before it in the arm's relaxation order, read as
 * they stand, and those after it, dropped. The order puts first the matches that bind a variable of `seeds`, what the
 * probe is judged at (a target arm's terms, a breaking arm's variables), then in rounds each match that shares a
 * variable with one already placed, then any other, each round in declared order. Every delete probe of the arm
 * relaxes by the one order, so a tuple whose rows a transaction removes from several matches is withdrawn by the
 * earliest of them in it, whose probe reads every earlier match as it stands: any one order is sound, and in this one
 * a match's probe reaches the seeds through the matches before it wherever the arm's joins connect them, so it reads
 * the rows its own row reaches and not the whole side. A probe whose seeds no earlier match reaches binds them to
 * nothing, and judges every candidate, the whole check.
 */
const relaxation = (
	matches: ReadonlyArray<ArmMatch>,
	seeds: ReadonlySet<string>,
	at: number
): Relaxed => {
	const reads = matches.map((m) =>
		Object.values(m.bindings).reduce((into, e) => varsOf(e, into), new Set<string>())
	)
	const reached = new Set(seeds)
	const order: Array<number> = []
	const next = (): ReadonlyArray<{ readonly i: number; readonly vars: ReadonlySet<string> }> =>
		reads.flatMap((vars, i) =>
			!order.includes(i) && [...vars].some((v) => reached.has(v)) ? [{ i, vars }] : []
		)
	for (let round = next(); round.length > 0; round = next()) {
		for (const { i, vars } of round) {
			order.push(i)
			for (const v of vars) {
				reached.add(v)
			}
		}
	}
	const ordered = [...order, ...matches.flatMap((_, i) => (order.includes(i) ? [] : [i]))]
	const place = ordered.indexOf(at)
	const of = (is: ReadonlyArray<number>): ReadonlyArray<ArmMatch> =>
		matches.flatMap((m, i) => (is.includes(i) ? [m] : []))
	return { kept: of(ordered.slice(0, place)), dropped: of(ordered.slice(place + 1)) }
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
	probe: (arm: A, open: Joined, touched: ArmMatch, at: number) => ReadonlyArray<InferredQuery>
): ReadonlyArray<InferredQuery> =>
	arms.flatMap((arm) =>
		arm.negated.flatMap((n) => {
			const open = opened(n, loc)
			return open.matches.flatMap((m, at) =>
				m.relation === relation ? probe(arm, open, m, at) : []
			)
		})
	)

/**
 * The probes of what a transaction's net write adds to `relation`, its region delta.added (ProbeSide `added`): the
 * images the relation holds at COMMIT that it did not hold before (physical/ddl/rules.ts addRules), so a probe reads
 * each row from the net write and never again from its table, where without statistics every equality is equally
 * selective and a read of the row by its key may take an index of a strict subset of the key's columns, a qti
 * attribute's (name, package), and read every row it holds:
 *
 * - for the facts it adds: one per occurrence of the relation in an arm of the rule's breaking side, the occurrence held
 *   to its region (`held`) and the arm's other matches read as they stand, and the rule's violation read over it;
 * - for the target tuples it withdraws: one per occurrence of the relation in a negated arm of an arm of a
 *   containment's target. The negated arm is opened into the target's arm (`opened`), its occurrence held to its region
 *   and its other matches read as they stand, the tuples the added rows now block, which stand blocked at COMMIT by a
 *   fact that reads one where they stood before. The target arm's negations are dropped: a tuple two inserts block at
 *   once, each through a negation of its own, is blocked by the other's too, and is a candidate all the same. The
 *   source tuples that need a candidate and that the target no longer holds are the violation.
 *
 * Every probe reads the side its facts meet by arm (`readAs`), each probe one rule of the violation: a probe per arm
 * of a key's side its fact meets, and per arm of a containment's source its candidate meets, each beside a negation
 * of every arm of the target.
 */
const addedProbes = (
	rule: ProbedRule,
	relation: string,
	loc: SourceLoc
): ReadonlyArray<InferredQuery> => {
	const added = breakingArms(rule).flatMap((arm) =>
		arm.matches.flatMap((m, i): ReadonlyArray<InferredQuery> => {
			if (m.relation !== relation) {
				return []
			}
			const h = held(
				m,
				"added",
				new Set(),
				arm.matches.filter((_, j) => j !== i),
				[],
				arm.where,
				loc
			)
			const read: ProbeArm = {
				vars: arm.vars.filter((v) => !h.replaced.has(v.id)),
				matches: h.kept,
				where: h.where,
				negated: arm.negated.map((n) => ({ ...n, bindings: mapBindings(n.bindings, h.leaves) })),
				head: mapBindings(arm.head, h.leaves),
				terms: mapNonEmpty(arm.terms, (t) => mapLeaves(t, h.leaves))
			}
			return probesOf(h.region, violating(rule, read, loc), loc)
		})
	)
	if (rule.kind !== "contained") {
		return added
	}
	const blocked = negatedProbes(rule.to.arms, relation, loc, (arm, open, touched, at) => {
		const h = held(
			touched,
			"added",
			boundVars(arm.matches),
			open.matches.filter((_, j) => j !== at),
			[],
			open.where,
			loc
		)
		return probesOf(
			h.region,
			mapNonEmpty(tuples(rule.from, arm.terms, loc), (met) =>
				ruleDesc(
					[...arm.vars, ...open.vars.filter((v) => !h.replaced.has(v.id))],
					[{ ...met, loc }, ...arm.matches.map(matchDesc), ...h.kept.map(matchDesc)],
					[...arm.where, ...h.where, ...lacks(rule.to, arm.terms, loc)],
					termHead(arm.terms),
					loc
				)
			),
			loc
		)
	})
	return [...added, ...blocked]
}

/**
 * The probes of what a transaction removes of `relation`, its region delta.removed (ProbeSide `removed`): the rows a
 * DELETE or an UPDATE of a column read found:
 *
 * - for the target tuples it withdraws: one per occurrence of the relation in an arm of a containment's target. The
 *   occurrence is held to its region, the matches before it in the arm's relaxation order (`relaxation`, seeded at the
 *   arm's terms) are read as they stand, and those after it are dropped, every term only they bind a wildcard: a tuple
 *   whose rows the transaction removes from several matches is still withdrawn by the first of them in that order,
 *   whose probe reads none of the later ones. The arm's negations are dropped too: a tuple the transaction both
 *   withdraws and blocks, its row deleted and a row of a negated relation inserted, is withdrawn by the delete, whose
 *   probe reads no insert, where the insert's probe reads the row as it stands, deleted. The source tuples that agree
 *   with a candidate on its bound terms and that the target no longer holds are the violation, so a candidate the
 *   dropped matches or negations would have excluded is judged against the target all the same;
 * - for the facts it adds by no longer blocking them: one per occurrence of the relation in a negated arm of an arm of
 *   the rule's breaking side. The negated arm is opened into the arm (`opened`) and read as a target's arm is, its
 *   occurrence held to its region, the matches before it in the negated arm's relaxation order, seeded at the breaking
 *   arm's variables, read as they stand and those after it dropped, so the facts some fact of the negated arm that read
 *   a removed row blocked are the candidates, however many of its rows the transaction removes; the rule's violation is
 *   read over them, the arm's negations as they stand at COMMIT.
 *
 * Every probe reads the side its candidates meet by arm (`readAs`), as the added side's do.
 */
const removedProbes = (
	rule: ProbedRule,
	relation: string,
	loc: SourceLoc
): ReadonlyArray<InferredQuery> => {
	const lost =
		rule.kind === "contained"
			? rule.to.arms.flatMap((arm) =>
					arm.matches.flatMap((m, i): ReadonlyArray<InferredQuery> =>
						m.relation === relation ? lostProbes(rule, arm, m, i, loc) : []
					)
				)
			: []
	const unblocked = negatedProbes(breakingArms(rule), relation, loc, (arm, open, touched, at) => {
		const bound = boundVars(arm.matches)
		const r = relaxation(open.matches, bound, at)
		const h = held(touched, "removed", bound, r.kept, r.dropped, open.where, loc)
		const restricted: SideArm = {
			...arm,
			vars: [...arm.vars, ...open.vars.filter((v) => !h.replaced.has(v.id) && !h.free.has(v.id))],
			matches: [...arm.matches, ...h.kept],
			where: [...arm.where, ...h.where]
		}
		return probesOf(h.region, violating(rule, restricted, loc), loc)
	})
	return [...lost, ...unblocked]
}

/** The probes of `touched`, the `at`-th match of an arm of a containment's target, held to its removed rows. */
const lostProbes = (
	rule: Extract<ProbedRule, { readonly kind: "contained" }>,
	arm: SideArm,
	touched: ArmMatch,
	at: number,
	loc: SourceLoc
): ReadonlyArray<InferredQuery> => {
	const r = relaxation(
		arm.matches,
		arm.terms.reduce((into, t) => varsOf(t, into), new Set<string>()),
		at
	)
	const h = held(touched, "removed", new Set(), r.kept, r.dropped, arm.where, loc)
	const mappedTerms = arm.terms.map((t) => mapLeaves(t, h.leaves))
	const bound = mappedTerms.map((t, i): InferredExpr => (h.unbound(t) ? varRef(wildcardId(i)) : t))
	const wilds = mappedTerms.flatMap((t, i) =>
		h.unbound(t) ? [{ id: wildcardId(i), origin: undefined, loc }] : []
	)
	return probesOf(
		h.region,
		mapNonEmpty(tuples(rule.from, bound, loc), (met) =>
			ruleDesc(
				[...arm.vars.filter((v) => !h.replaced.has(v.id) && !h.free.has(v.id)), ...wilds],
				[{ ...met, loc }, ...h.kept.map(matchDesc)],
				[...h.where, ...lacks(rule.to, bound, loc)],
				termHead(bound),
				loc
			)
		),
		loc
	)
}

/** The probes of `rule` over the rows the transaction wrote of `relation` on `side`, its region (ProbeSide). */
export const probes = (
	rule: ProbedRule,
	relation: string,
	side: ProbeSide,
	loc: SourceLoc
): ReadonlyArray<InferredQuery> => {
	switch (side) {
		case "added":
			return addedProbes(rule, relation, loc)
		case "removed":
			return removedProbes(rule, relation, loc)
	}
}

/**
 * What a write of one relation can break of a rule that reads it, by ProbeSide: by INSERT or by an UPDATE of a column
 * read, the facts it adds as a breaking side's match and the target tuples it blocks as a match of a negated arm of a
 * containment's target (`added`); by DELETE or by an UPDATE of a column read, the target tuples it withdraws as a
 * target's match and the facts it unblocks as a match of a negated arm of the breaking side (`removed`); or both. Each
 * names the columns read.
 */
export type Touches =
	| { readonly kind: "added"; readonly added: ReadonlyArray<string> }
	| { readonly kind: "removed"; readonly removed: ReadonlyArray<string> }
	| {
			readonly kind: "both"
			readonly added: ReadonlyArray<string>
			readonly removed: ReadonlyArray<string>
	  }

/** The columns `touches` reads on `side`, none where it reads none there. */
export const touchedOn = (touches: Touches, side: ProbeSide): ReadonlyArray<string> | undefined => {
	switch (touches.kind) {
		case "added":
			return side === "added" ? touches.added : undefined
		case "removed":
			return side === "removed" ? touches.removed : undefined
		case "both":
			return touches[side]
	}
}

/** The Touches of the columns read on each side, undefined where neither reads any. */
const touchesOf = (
	added: ReadonlyArray<string> | undefined,
	removed: ReadonlyArray<string> | undefined
): Touches | undefined => {
	if (added === undefined) {
		return removed === undefined ? undefined : { kind: "removed", removed }
	}
	return removed === undefined ? { kind: "added", added } : { kind: "both", added, removed }
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
		: [...new Set(read.flatMap((m) => Object.keys(m.bindings)))].toSorted(compareStrings)
}

/** What writing `relation` can break of `rule` (`Touches`), undefined where the rule reads no row of it. */
export const touches = (rule: QueryRule, relation: string): Touches | undefined => {
	switch (rule.kind) {
		case "contained":
		case "key":
		case "check":
			return probedTouches(rule, relation)
		case "whole":
			return wholeTouches(rule, relation)
	}
}

/**
 * What writing `relation` can break of a whole rule (`touches`): the columns its positive occurrences bind, by INSERT,
 * and its negative ones', by DELETE, an occurrence of both polarities on each side; and, by DELETE, the fields at which
 * its region reads the rows a holder lost to find the gained rows that replace them (WholeRule `replaced`).
 */
const wholeTouches = (rule: WholeRule, relation: string): Touches | undefined => {
	const of = rule.reads.filter((r) => r.relation === relation)
	const replaced = rule.replaced.filter((r) => r.relation === relation).flatMap((r) => r.fields)
	const columns = (
		polarity: "positive" | "negative",
		also: ReadonlyArray<string>
	): ReadonlyArray<string> | undefined => {
		const read = of.filter((r) => r.polarity === polarity || r.polarity === "both")
		return read.length === 0 && also.length === 0
			? undefined
			: [...new Set([...read.flatMap((r) => r.columns), ...also])].toSorted(compareStrings)
	}
	return touchesOf(columns("positive", []), columns("negative", replaced))
}

/** What writing `relation` can break of a probed rule (`touches`). */
const probedTouches = (rule: ProbedRule, relation: string): Touches | undefined =>
	touchesOf(
		columnsOf(breakingArms(rule), targetArms(rule), relation),
		columnsOf(targetArms(rule), breakingArms(rule), relation)
	)

/**
 * One shape a rule's violation takes, by the stored and closed relations it reads, each occurrence once, in arm order:
 *
 * - `rows`: one row of each, present: the matches of one arm of the breaking side, or of a key, the matches of each of
 *   the two arms its pair of facts comes through, an arm paired with itself listing its matches twice;
 * - `present`: rows it needs present beyond those, any number of each: the matches of every negated arm of a
 *   containment's target, each blocking a target tuple the source's fact would meet;
 * - `absent`: rows it needs absent: the matches of the negated arms of its breaking arms and of every arm of a
 *   containment's target.
 *
 * A whole rule's one witness is every occurrence its violation query reads: its positive occurrences among `rows`, its
 * negative ones among `absent`, and an occurrence of both polarities, which only an aggregate reads (RelationRead), a
 * read of its whole group, among `present` and `absent`, never among `rows`: a count, a sum, a min or a max changes
 * with every row of its group a write puts or takes, so no row of it is one row of a match, and its writer's row is never
 * the one occurrence its write makes true. A relation it reads twice counts twice, as two matches of an arm do. With no
 * positive occurrence, every occurrence stands among `rows`.
 *
 * Every violation of the rule is a violation through one of its witnesses. A write that makes a row present can break
 * the rule exactly where its relation stands among some witness's `rows` or `present`, and one that makes a row absent
 * where it stands among some witness's `absent`, as Touches names them (`touches`).
 */
export interface Witness {
	readonly rows: NonEmptyReadonlyArray<string>
	readonly present: ReadonlyArray<string>
	readonly absent: ReadonlyArray<string>
}

/** The relations of matches, in order, each occurrence once. */
const matched = (matches: NonEmptyReadonlyArray<ArmMatch>): NonEmptyReadonlyArray<string> =>
	mapNonEmpty(matches, (m) => m.relation)

/** The relations an arm's negated arms match, in order, each occurrence once. */
const negatedOf = (arm: LiveArm): ReadonlyArray<string> =>
	negatedMatches(arm).map((m) => m.relation)

/**
 * The witnesses of a rule (Witness): one per arm of a check's side and of a containment's source, each beside every arm
 * of the target, and one per pair of arms of a key's side, each arm with itself and with every arm after it.
 */
export const witnesses = (rule: QueryRule): NonEmptyReadonlyArray<Witness> => {
	switch (rule.kind) {
		case "whole": {
			const at = (polarities: ReadonlyArray<RelationRead["polarity"]>): ReadonlyArray<string> =>
				rule.reads.flatMap((r) => (polarities.includes(r.polarity) ? [r.relation] : []))
			const [first, ...rest] = at(["positive"])
			return [
				{
					rows: first === undefined ? mapNonEmpty(rule.reads, (r) => r.relation) : [first, ...rest],
					present: at(["both"]),
					absent: at(["negative", "both"])
				}
			]
		}
		case "check":
			return mapNonEmpty(rule.side.arms, (arm) => ({
				rows: matched(arm.matches),
				present: [],
				absent: negatedOf(arm)
			}))
		case "contained": {
			const present = rule.to.arms.flatMap(negatedOf)
			const target = rule.to.arms.flatMap((a) => matched(a.matches))
			return mapNonEmpty(rule.from.arms, (arm) => ({
				rows: matched(arm.matches),
				present,
				absent: [...negatedOf(arm), ...target]
			}))
		}
		case "key": {
			const arms = rule.side.arms
			return flatMapNonEmpty(arms, (arm, i) =>
				mapNonEmpty([arm, ...arms.slice(i + 1)], (other) => ({
					rows: extendNonEmpty(matched(arm.matches), matched(other.matches)),
					present: [],
					absent: [...negatedOf(arm), ...negatedOf(other)]
				}))
			)
		}
	}
}
