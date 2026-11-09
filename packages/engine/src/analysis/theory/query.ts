import { refuse } from "#compiler/analysis/theory/build.ts"
import { compareText } from "#compiler/core/canonical.ts"
import type { Identity } from "#compiler/core/identity.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type {
	BindingsDesc,
	ExprDesc,
	FieldDesc,
	HeadTermDesc,
	MatchDesc,
	QueryDesc,
	QueryStageDesc,
	RuleDesc,
	SelectionDesc,
	SourceDesc,
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
 * select-project-join queries a rule's side may be. A definition that negates, aggregates, recurses, orders or takes,
 * approximates, attaches or nests a stage is refused (UnsupportedLawFamily), naming what it does.
 *
 * Every side of such a rule, a side over a stored relation among them, is read as arms (`SideArm`), so one
 * construction writes the rule's violation query (`violationQuery`), which the migration that adds the rule runs
 * over the rows it finds, and its trigger probes (`newProbes`, `lostProbes`), which the rule's deferred constraint
 * triggers run at COMMIT for the rows a transaction touched. Each is a query description the checker reads as any
 * query is, so grizzle's own query compiler types and lowers it.
 */

/** A match of a stored or closed relation in an arm, its bindings over the arm's variables. */
export interface ArmMatch {
	readonly relation: string
	readonly bindings: BindingsDesc
	readonly loc: SourceLoc
}

/**
 * One conjunctive arm of a definition: its variables, its matches of stored and closed relations, its conditions over
 * the variables, and the fact it derives, a term per heading field.
 */
export interface LiveArm {
	readonly vars: ReadonlyArray<VarDesc>
	readonly matches: NonEmptyReadonlyArray<ArmMatch>
	readonly where: ReadonlyArray<ExprDesc>
	readonly head: Readonly<Record<string, ExprDesc>>
}

/** One arm of a rule's side: a live arm with the side's selection among its conditions, and the side's terms. */
export interface SideArm extends LiveArm {
	readonly terms: NonEmptyReadonlyArray<ExprDesc>
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
			readonly predicate: ExprDesc
			/** The check's identity at the naming door, which names the triggers that hold it on each table. */
			readonly named: Identity<"check">
			/** The derived relation's facts: a side of every fact, its terms every heading field. */
			readonly side: RuleSide
	  }

/** Where a live definition is read: each derived relation's definition by name, undefined for a stored or closed one. */
export interface LiveEnv {
	readonly definition: (relation: string) => QueryDesc | undefined
	readonly loc: SourceLoc
}

/** The leaves an arm's expressions are rewritten by: a variable or a field, each to its replacement. */
interface Leaves {
	readonly var: (id: string) => ExprDesc | undefined
	readonly field: (field: string) => ExprDesc | undefined
}

/** `e` with every variable and field leaf `leaves` replaces, replaced; an imported query is closed and kept whole. */
const mapLeaves = (e: ExprDesc, leaves: Leaves): ExprDesc => {
	const m = (x: ExprDesc): ExprDesc => mapLeaves(x, leaves)
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

const mapBindings = (b: BindingsDesc, leaves: Leaves): BindingsDesc =>
	Object.fromEntries(Object.entries(b).map(([f, e]) => [f, mapLeaves(e, leaves)] as const))

/** The variables `e` reads, an imported query's own aside. */
const varsOf = (e: ExprDesc, into: Set<string>): Set<string> => {
	mapLeaves(e, {
		var: (id) => {
			into.add(id)
			return undefined
		},
		field: () => undefined
	})
	return into
}

/** What an expression reads beyond a definition's own row: a negation, a parameter, a parent's column or a VALUE. */
const foreignLeaf = (e: ExprDesc): string | undefined => {
	let found: string | undefined
	const visit = (x: ExprDesc): void => {
		if (found !== undefined) {
			return
		}
		switch (x.kind) {
			case "absent":
				found = "negates a relation inside a condition"
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

const eq = (left: ExprDesc, right: ExprDesc): ExprDesc => ({
	kind: "compare",
	op: "eq",
	left,
	right
})

/** Whether `e` is a bare literal, which takes the type of the term it meets and so never stands first. */
const isBare = (e: ExprDesc): boolean => e.kind === "literal" && e.type === undefined

/**
 * `left` = `right` in the order the checker reads it: as written, but a bare literal second. A binding of a definition
 * may be a JavaScript literal, so every equality a rule's queries hold a binding by is built here.
 */
const equal = (left: ExprDesc, right: ExprDesc): ExprDesc =>
	isBare(left) ? eq(right, left) : eq(left, right)

const varRef = (id: string): ExprDesc => ({ kind: "var", var: id })

/** An arm still being flattened: no match yet is the arm of a rule that matched only derived relations so far. */
interface PartialArm {
	readonly vars: ReadonlyArray<VarDesc>
	readonly matches: ReadonlyArray<ArmMatch>
	readonly where: ReadonlyArray<ExprDesc>
	readonly head: Readonly<Record<string, ExprDesc>>
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

	/** The arms of `query`, a definition of `relation`, flattened. */
	arms(relation: string, query: QueryDesc): NonEmptyReadonlyArray<LiveArm> {
		const arms = this.#stage(relation, query.stage)
		if (!isNonEmpty(arms)) {
			return this.#refuse(relation, "derives no fact")
		}
		return arms
	}

	#stage(relation: string, stage: QueryStageDesc): ReadonlyArray<LiveArm> {
		switch (stage.kind) {
			case "rules":
				return stage.arms.flatMap((r) => this.#rule(relation, r))
			case "union":
				return [
					...this.#stage(relation, stage.input),
					...stage.arms.flatMap((r) => this.#rule(relation, r))
				]
			case "named":
				return this.#stage(relation, stage.input)
			case "recursive":
				return this.#refuse(relation, "recurses")
			case "attach":
				return this.#refuse(relation, "attaches a nested query")
			case "order":
			case "take":
				return this.#refuse(relation, "orders and takes")
			case "approx":
				return this.#refuse(relation, "approximates a search")
		}
	}

	/** One rule's arms: its own, every derived relation and imported query it matches inlined. */
	#rule(relation: string, rule: RuleDesc): ReadonlyArray<LiveArm> {
		if (rule.interiors.length > 0) {
			return this.#refuse(relation, "nests a stage")
		}
		if (rule.attach.length > 0) {
			return this.#refuse(relation, "attaches a nested query")
		}
		const prefix = `q${this.#next++}.`
		const rename = (id: string): string => `${prefix}${id}`
		const leaves: Leaves = { var: (id) => varRef(rename(id)), field: () => undefined }
		const head: Record<string, ExprDesc> = {}
		for (const [name, term] of Object.entries(rule.head)) {
			head[name] = mapLeaves(this.#headTerm(relation, term), leaves)
		}
		const where = rule.where.map((w) => {
			const foreign = w.kind === "absent" ? this.#negation(w) : foreignLeaf(w)
			if (foreign !== undefined) {
				return this.#refuse(relation, foreign)
			}
			return mapLeaves(w, leaves)
		})
		let partials: ReadonlyArray<PartialArm> = [
			{ vars: rule.vars.map((v) => ({ ...v, id: rename(v.id) })), matches: [], where, head }
		]
		for (const match of rule.matches) {
			const bindings = mapBindings(match.bindings, leaves)
			for (const e of Object.values(match.bindings)) {
				const foreign = foreignLeaf(e)
				if (foreign !== undefined) {
					return this.#refuse(relation, foreign)
				}
			}
			const inlined = this.#source(relation, match.source)
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
		return partials.map((p) => {
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
	 * there replaced by it.
	 */
	#merged(relation: string, p: PartialArm, arm: LiveArm, bindings: BindingsDesc): PartialArm {
		const local = new Set(arm.vars.map((v) => v.id))
		const replaced = new Map<string, ExprDesc>()
		const extra: Array<ExprDesc> = []
		const leaves: Leaves = { var: (id) => replaced.get(id), field: () => undefined }
		for (const [field, e] of Object.entries(bindings)) {
			const head = arm.head[field]
			if (head === undefined) {
				return this.#refuse(
					relation,
					`binds ${field}, which the definition it matches derives none of`
				)
			}
			const h = mapLeaves(head, leaves)
			if (h.kind === "var" && local.has(h.var) && !replaced.has(h.var) && !isBare(e)) {
				replaced.set(h.var, e)
			} else {
				extra.push(equal(e, h))
			}
		}
		return {
			vars: [...p.vars, ...arm.vars.filter((v) => !replaced.has(v.id))],
			matches: [
				...p.matches,
				...arm.matches.map((m) => ({ ...m, bindings: mapBindings(m.bindings, leaves) }))
			],
			where: [...p.where, ...arm.where.map((w) => mapLeaves(w, leaves)), ...extra],
			head: p.head
		}
	}

	/**
	 * What a negation of the definition reads beyond an anti-join of one stored or closed relation, which a rule reads
	 * with its polarity (`negations`): nothing, or the refusal's words for a negation of a query, of a derived relation,
	 * or of a binding that reads beyond the row.
	 */
	#negation(w: Extract<ExprDesc, { readonly kind: "absent" }>): string | undefined {
		const source = w.source
		if (source.kind !== "relation") {
			return "negates a query, where a rule reads an anti-join of one relation"
		}
		if (this.env.definition(source.name) !== undefined) {
			return `negates the derived relation ${source.name}, where a rule reads an anti-join of one stored relation`
		}
		for (const e of Object.values(w.bindings)) {
			const foreign = foreignLeaf(e)
			if (foreign !== undefined) {
				return foreign
			}
		}
		return undefined
	}

	#headTerm(relation: string, term: HeadTermDesc): ExprDesc {
		if (term.kind === "aggregate") {
			return this.#refuse(relation, "aggregates")
		}
		if (term.kind === "producer") {
			return this.#refuse(relation, "produces spans")
		}
		const foreign = foreignLeaf(term)
		return foreign === undefined ? term : this.#refuse(relation, foreign)
	}

	/**
	 * What a match's source is to an arm: a stored or closed relation, which the arm matches itself, or the arms it
	 * inlines, a derived relation's definition's or an imported query's that binds no parameter.
	 */
	#source(relation: string, source: SourceDesc): Matched {
		switch (source.kind) {
			case "relation": {
				const definition = this.env.definition(source.name)
				return definition === undefined
					? { kind: "stored", stored: source.name }
					: { kind: "inlined", arms: this.arms(source.name, definition) }
			}
			case "query":
				if (Object.keys(source.bind).length > 0) {
					return this.#refuse(relation, "binds an imported query's parameters")
				}
				return { kind: "inlined", arms: this.arms(relation, source.query) }
			case "param":
			case "paramOf":
				return this.#refuse(relation, "matches a relation parameter")
			case "context":
				return this.#refuse(relation, "matches a context")
			case "interior":
			case "self":
			case "delta":
			case "row":
				return this.#refuse(relation, `matches a ${source.kind} source`)
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
	query: QueryDesc,
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
const fieldsOf = (e: ExprDesc, into: Set<string>): Set<string> => {
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
		terms: mapNonEmpty(guarded, (g) => mapLeaves(g.term, leaves))
	}
}

/**
 * An anti-join of an arm: a condition of its `where`, at `index`, that no fact of the stored or closed relation
 * `relation` matches `bindings`. Its relation is read negatively: a fact of it withdraws the arm's facts it matches.
 */
interface Negation {
	readonly index: number
	readonly relation: string
	readonly bindings: BindingsDesc
}

/** The anti-joins of an arm, in condition order. */
const negations = (arm: LiveArm): ReadonlyArray<Negation> =>
	arm.where.flatMap((w, index): ReadonlyArray<Negation> =>
		w.kind === "absent" && w.source.kind === "relation"
			? [{ index, relation: w.source.name, bindings: w.bindings }]
			: []
	)

/** The stored relations a rule's arms read, by a match or an anti-join, sorted, each once. */
export const ruleReads = (rule: QueryRule): ReadonlyArray<string> =>
	[
		...new Set(
			[...breakingArms(rule), ...targetArms(rule)].flatMap((a) => [
				...a.matches.map((m) => m.relation),
				...negations(a).map((n) => n.relation)
			])
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
const imported = (arms: NonEmptyReadonlyArray<RuleDesc>, loc: SourceLoc): SourceDesc => ({
	kind: "query",
	query: queryOf(arms, loc),
	bind: {}
})

const queryOf = (arms: NonEmptyReadonlyArray<RuleDesc>, loc: SourceLoc): QueryDesc => ({
	stage: { kind: "rules", arms, loc }
})

const matchDesc = (m: ArmMatch): MatchDesc => ({
	source: { kind: "relation", name: m.relation },
	bindings: m.bindings,
	loc: m.loc
})

const ruleDesc = (
	vars: ReadonlyArray<VarDesc>,
	matches: ReadonlyArray<MatchDesc>,
	where: ReadonlyArray<ExprDesc>,
	head: Readonly<Record<string, ExprDesc>>,
	loc: SourceLoc
): RuleDesc => ({ vars, matches, where, head, interiors: [], attach: [], loc })

const termHead = (terms: ReadonlyArray<ExprDesc>): Readonly<Record<string, ExprDesc>> =>
	Object.fromEntries(terms.map((t, i) => [termName(i), t] as const))

/** The tuples of a side's arms, each term under its pair's name: what a containment's other side meets. */
const tuples = (side: RuleSide, loc: SourceLoc): SourceDesc =>
	imported(
		mapNonEmpty(side.arms, (a) =>
			ruleDesc(a.vars, a.matches.map(matchDesc), a.where, termHead(a.terms), loc)
		),
		loc
	)

/** The facts of a key's side: each its terms under their pair names and its heading fields under their head names. */
const facts = (side: RuleSide, heading: ReadonlyArray<string>, loc: SourceLoc): SourceDesc =>
	imported(
		mapNonEmpty(side.arms, (a) =>
			ruleDesc(
				a.vars,
				a.matches.map(matchDesc),
				a.where,
				{
					...termHead(a.terms),
					...Object.fromEntries(heading.map((f) => [headName(f), headOf(a, f, loc)] as const))
				},
				loc
			)
		),
		loc
	)

const headOf = (arm: LiveArm, field: string, loc: SourceLoc): ExprDesc =>
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
const violating = (rule: QueryRule, arm: SideArm, loc: SourceLoc): RuleDesc => {
	switch (rule.kind) {
		case "contained":
			return ruleDesc(
				arm.vars,
				arm.matches.map(matchDesc),
				[
					...arm.where,
					{ kind: "absent", source: tuples(rule.to, loc), bindings: termHead(arm.terms) }
				],
				termHead(arm.terms),
				loc
			)
		case "key": {
			const heading = armHeading(rule.side.arms)
			const other: Record<string, ExprDesc> = { ...termHead(arm.terms) }
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
					...arm.where,
					connectiveExpr(
						"or",
						heading.map((f): ExprDesc => ({
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
				[...arm.where, { kind: "not", arg: mapLeaves(rule.predicate, leaves) }],
				termHead(arm.terms),
				loc
			)
		}
	}
}

/** The violation query of a rule over a query, which must be empty: every fact of its breaking side that breaks it. */
export const violationQuery = (rule: QueryRule, loc: SourceLoc): QueryDesc =>
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
	readonly query: QueryDesc
	readonly params: ReadonlyMap<string, ProbeParam>
}

/** A field of the touched relation, with the descriptor a parameter reading it is typed by. */
export interface TouchedField {
	readonly name: string
	readonly desc: FieldDesc
}

const paramName = (record: "NEW" | "OLD", field: string): string =>
	`${record === "NEW" ? "new" : "old"}_${field}`

const paramOf = (record: "NEW" | "OLD", field: TouchedField): ExprDesc => ({
	kind: "param",
	name: paramName(record, field.name),
	type: field.desc
})

/** The pins holding an anti-join's bindings to the touched row's values, read at `record`. */
const pinnedTo = (
	n: Negation,
	record: "NEW" | "OLD",
	fieldOf: (name: string) => TouchedField,
	params: Map<string, ProbeParam>
): ReadonlyArray<ExprDesc> =>
	Object.entries(n.bindings).map(([field, e]) => {
		params.set(paramName(record, field), { record, field })
		return equal(e, paramOf(record, fieldOf(field)))
	})

/** The field of the touched relation named `name`, refused where it has none. */
const touchedField =
	(fields: ReadonlyArray<TouchedField>, relation: string, loc: SourceLoc) =>
	(name: string): TouchedField =>
		fields.find((f) => f.name === name) ??
		refuse("MalformedDescription", loc, `a field ${relation}.${name}`)

/**
 * The probes an INSERT or an UPDATE of `relation`'s row runs at COMMIT, NEW its values:
 *
 * - for the facts it adds: one per occurrence of the relation in an arm of the rule's breaking side, the arm with that
 *   occurrence held to the row now stored at NEW's primary key, `key`, and the rule's violation read over it. A row
 *   deleted or changed later in the transaction is judged as it stands at COMMIT, which its own write probes again;
 * - for the target tuples it withdraws: one per anti-join of the relation in an arm of a containment's target, the arm
 *   without that anti-join and with its bindings held to NEW's values, the tuples NEW now blocks; the source tuples
 *   that need one of them and that the target no longer holds are the violation.
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
			const bindings: Record<string, ExprDesc> = { ...m.bindings }
			const pinned: Array<ExprDesc> = []
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
	const blocked = rule.to.arms.flatMap((arm) =>
		negations(arm).flatMap((n): ReadonlyArray<Probe> => {
			if (n.relation !== relation) {
				return []
			}
			const params = new Map<string, ProbeParam>()
			const where = [
				...arm.where.filter((_, k) => k !== n.index),
				...pinnedTo(n, "NEW", fieldOf, params)
			]
			return [
				{
					query: queryOf(
						[
							ruleDesc(
								arm.vars,
								[
									{ source: tuples(rule.from, loc), bindings: termHead(arm.terms), loc },
									...arm.matches.map(matchDesc)
								],
								[
									...where,
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
			]
		})
	)
	return [...added, ...blocked]
}

/**
 * The probes a DELETE or an UPDATE of `relation`'s row runs at COMMIT, OLD its values:
 *
 * - for the target tuples it withdraws: one per occurrence of the relation in an arm of a containment's target. The
 *   occurrence is replaced by OLD's values, the matches declared before it are read as they stand, and those after it
 *   are dropped, every term only they bind a wildcard: a tuple whose rows the transaction removes from several matches
 *   is still withdrawn by the first of them, whose probe reads none of the later ones. The arm's anti-joins are dropped
 *   too: a tuple the transaction both withdraws and blocks, its row deleted and a row of the negated relation inserted,
 *   is withdrawn by the delete, whose probe reads no insert, where the insert's probe reads the row as it stands,
 *   deleted. The source tuples that agree with a candidate on its bound terms and that the target no longer holds are
 *   the violation, so a candidate the dropped matches or anti-joins would have excluded is judged against the target
 *   all the same;
 * - for the facts it adds by no longer blocking them: one per anti-join of the relation in an arm of the rule's
 *   breaking side, the arm with that anti-join's bindings held to OLD's values, and the rule's violation read over it.
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
						m.relation === relation
							? [
									lostProbe(
										rule,
										arm,
										m,
										arm.matches.slice(0, i),
										arm.matches.slice(i + 1),
										fieldOf,
										loc
									)
								]
							: []
					)
				)
			: []
	const unblocked = breakingArms(rule).flatMap((arm) =>
		negations(arm).flatMap((n): ReadonlyArray<Probe> => {
			if (n.relation !== relation) {
				return []
			}
			const params = new Map<string, ProbeParam>()
			const pinned: SideArm = {
				...arm,
				where: [...arm.where, ...pinnedTo(n, "OLD", fieldOf, params)]
			}
			return [{ query: queryOf([violating(rule, pinned, loc)], loc), params }]
		})
	)
	return [...lost, ...unblocked]
}

/** The variables a match binds itself, never through an expression over them. */
const boundVars = (matches: ReadonlyArray<ArmMatch>): ReadonlySet<string> =>
	new Set(
		matches.flatMap((m) =>
			Object.values(m.bindings).flatMap((e) => (e.kind === "var" ? [e.var] : []))
		)
	)

const lostProbe = (
	rule: Extract<QueryRule, { readonly kind: "contained" }>,
	arm: SideArm,
	touched: ArmMatch,
	kept: ReadonlyArray<ArmMatch>,
	relaxed: ReadonlyArray<ArmMatch>,
	fieldOf: (name: string) => TouchedField,
	loc: SourceLoc
): Probe => {
	const byKept = boundVars(kept)
	const replaced = new Map<string, ExprDesc>()
	const pinned: Array<ExprDesc> = []
	const params = new Map<string, ProbeParam>()
	for (const [field, e] of Object.entries(touched.bindings)) {
		const old = paramOf("OLD", fieldOf(field))
		params.set(paramName("OLD", field), { record: "OLD", field })
		if (e.kind === "var" && !byKept.has(e.var) && !replaced.has(e.var)) {
			replaced.set(e.var, old)
		} else {
			pinned.push(equal(e, old))
		}
	}
	const free = new Set([...boundVars(relaxed)].filter((id) => !byKept.has(id) && !replaced.has(id)))
	const leaves: Leaves = { var: (id) => replaced.get(id), field: () => undefined }
	const unbound = (e: ExprDesc): boolean => [...varsOf(e, new Set())].some((id) => free.has(id))
	const keptMatches = kept.map((k): MatchDesc => {
		const bindings: Record<string, ExprDesc> = {}
		for (const [f, e] of Object.entries(k.bindings)) {
			const mapped = mapLeaves(e, leaves)
			if (!unbound(mapped)) {
				bindings[f] = mapped
			}
		}
		return matchDesc({ ...k, bindings })
	})
	const where = [...arm.where.filter((w) => w.kind !== "absent"), ...pinned]
		.map((w) => mapLeaves(w, leaves))
		.filter((w) => !unbound(w))
	const mappedTerms = arm.terms.map((t) => mapLeaves(t, leaves))
	const bound = mappedTerms.map((t, i): ExprDesc => (unbound(t) ? varRef(wildcardId(i)) : t))
	const wilds = mappedTerms.flatMap((t, i) =>
		unbound(t) ? [{ id: wildcardId(i), origin: undefined, loc }] : []
	)
	return {
		query: queryOf(
			[
				ruleDesc(
					[...arm.vars.filter((v) => !replaced.has(v.id) && !free.has(v.id)), ...wilds],
					[{ source: tuples(rule.from, loc), bindings: termHead(bound), loc }, ...keptMatches],
					[...where, { kind: "absent", source: tuples(rule.to, loc), bindings: termHead(bound) }],
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
 * facts it adds as a breaking side's match and the target tuples it blocks as an anti-join of a containment's target
 * (`news`); by DELETE or by an UPDATE of a column read, the target tuples it withdraws as a target's match and the facts
 * it unblocks as an anti-join of the breaking side (`olds`); or both. Each names the columns read.
 */
export type Touches =
	| { readonly kind: "news"; readonly news: ReadonlyArray<string> }
	| { readonly kind: "olds"; readonly olds: ReadonlyArray<string> }
	| {
			readonly kind: "both"
			readonly news: ReadonlyArray<string>
			readonly olds: ReadonlyArray<string>
	  }

/** The columns that arms' matches of `relation` and their anti-joins of it read, sorted, each once. */
const columnsOf = (
	matched: ReadonlyArray<LiveArm>,
	negated: ReadonlyArray<LiveArm>,
	relation: string
): ReadonlyArray<string> | undefined => {
	const read = [
		...matched.flatMap((a) => a.matches.filter((m) => m.relation === relation)),
		...negated.flatMap((a) => negations(a).filter((n) => n.relation === relation))
	]
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
