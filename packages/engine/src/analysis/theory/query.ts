import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import {
	extendNonEmpty,
	flatMapNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { refuse, refuseNamed } from "#compiler/analysis/theory/build.ts"
import {
	type ColumnTypes,
	equal,
	isBare,
	type LeafRewrite,
	mapBindings,
	mapLeaves,
	typedAs,
	varRef,
	varsOf
} from "#compiler/analysis/theory/leaves.ts"
import type { FieldContainment } from "#compiler/analysis/theory/unit.ts"
import { encode, withoutSourceLocs } from "#compiler/core/canonical.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { isList, isRecord, mapRecord } from "#compiler/core/record.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import type {
	ImportDesc,
	Inferred,
	InferredBindings,
	InferredExpr,
	InferredHead,
	InferredMatch,
	InferredQuery,
	InferredRule,
	InferredSource,
	InferredStage,
	Located,
	SelectionDesc,
	TermDesc,
	VarDesc
} from "#compiler/ir/desc.ts"
import { connectiveExpr, exprChildren, mapExpr, refusalCondition } from "#compiler/ir/desc.ts"
import type { LawField } from "#compiler/ir/law.ts"
import type { DeltaSide } from "#compiler/ir/rel.ts"
import type { Unit } from "#compiler/ir/unit.ts"
import { compatible, sameCarrier } from "#compiler/scalar/compute/types.ts"
import { type GuardedTerm, guardedTerm, naturalType } from "#compiler/scalar/natural.ts"

/**
 * Rules over queries: a rule whose side reads a derived relation, judged on its definition, live.
 *
 * A side over a derived relation is its definition's facts projected onto the side's terms. The definition is read
 * live, one arm for each of its rules (`liveArms`), each joining stored and closed relations by equalities, selecting
 * by conditions over its variables and projecting onto heading terms: the select-project-join queries a rule's side
 * may be. A derived relation or imported query it matches is inlined where its definition is one rule, joined to the
 * arm, and stays one match where it has several (`DefinedMatch`), a union of its arms, never distributed into an arm
 * for each choice of one of its rules. Each negation of such an arm, alone as a filter or inside a conjunction that is
 * one, is read the same way: it negates the arms of a stored or closed relation, of a query or of a derived relation,
 * each an arm of its own that may negate in turn (`Negation`). A definition that aggregates,
 * recurses, orders or takes, approximates, attaches or nests a stage, or negates a query that does, is refused
 * (UnsupportedLawFamily), naming what it does.
 *
 * Every side of such a rule, a side over a stored relation among them, is read as arms (`SideArm`) by its probes
 * (`probes`), which the judge runs at COMMIT over the rows a transaction wrote, the side its facts meet read by arm, so each probe reads the rows of the keys its write reaches and never the
 * whole side (`readAs`). The rule's violation query (`violationQuery`), which the migration that adds the rule runs
 * over the rows it finds, reads each side whole, as its declared source, each definition a query of its own. Each is a
 * query description the checker reads as any query is, so grizzle's own query compiler types and lowers it. A relation a negated arm matches is read with the
 * negation's polarity, composed through every negation it stands under (`Polarity`): under one, a row it gains
 * withdraws the facts of the side that negates it and a row it loses brings them back; under two, a row it gains
 * withdraws a fact of the arm that negates it and so brings back the side's facts that arm withdrew, and so on, each
 * negation flipping it once more.
 */

/**
 * A match in an arm, its bindings over the arm's variables: of a stored or closed relation (`StoredMatch`), of the
 * groups an aggregating rule folds (`GroupedMatch`), or of a definition of several rules (`DefinedMatch`).
 */
export type ArmMatch = StoredMatch | GroupedMatch | DefinedMatch

/**
 * A match an arm reads at a polarity (Polarity): a stored or closed relation's, or an aggregating rule's groups'. A
 * match of a definition reads what its arms read (`readsAt`).
 */
type ReadMatch = StoredMatch | GroupedMatch

/** A match of a stored or closed relation, binding its fields. */
export interface StoredMatch {
	readonly kind: "stored"
	readonly relation: string
	readonly bindings: InferredBindings
	readonly loc: SourceLoc
}

/**
 * A match of an aggregating rule's facts, one per group (`Groups`), binding its head fields. No row of what it folds
 * is a fact of it: a row its body gains or loses changes its group's fact, the old fact lost and the new one gained,
 * so a write of any relation its body reads touches it both ways, its gained facts its touched groups as they stand
 * at COMMIT and its lost ones those groups at any folded value (`matchTouches`).
 */
export interface GroupedMatch {
	readonly kind: "grouped"
	readonly groups: Groups
	readonly bindings: InferredBindings
	readonly loc: SourceLoc
}

/**
 * A match of a derived relation or an imported query whose definition has several rules, kept whole: its facts are
 * those of any of its arms (`arms`), each closed, its variables its own, as a negated definition's are (Negation), at
 * the heading fields it binds (`bindings`). `source` is the definition as a query reads it live, which a probe meets
 * the match as. Inlined, the arm would be distributed into one arm for each rule of the definition, each spelling
 * every other match again, and a rule over several such definitions, or over a chain of them each matching the one
 * below, into the product of their widths; kept whole, what a write touches of it is what the write moves of the
 * definition (`movedOf`), read once for every match and negation of it (`matchTouches`), and a probe of a write of
 * another of its arm's matches reads it as it stands at the keys the written rows hold (`definitionsKeyed`).
 */
export interface DefinedMatch {
	readonly kind: "defined"
	readonly source: DefinitionSource
	readonly arms: NonEmptyReadonlyArray<LiveArm>
	readonly bindings: InferredBindings
	readonly loc: SourceLoc
}

/** A derived relation's definition or an imported query, as a query reads it live (`LiveReading`), as rules (`rulesOf`). */
type DefinitionSource = Extract<InferredSource, { readonly kind: "query" }>

/**
 * What an aggregating rule folds: the rule read live, a query of its own that a probe reads its groups through; its
 * group fields, the head fields no aggregate derives, at whose values it holds one fact, a fold of the body's facts
 * there (check/checker.ts: a Group keyed by the non-aggregate head terms); and its body, the rule without its folds,
 * as live arms each deriving the group fields, whose facts a write touches.
 */
export interface Groups {
	readonly query: InferredQuery
	readonly keys: ReadonlyArray<string>
	readonly body: NonEmptyReadonlyArray<LiveArm>
}

/**
 * A conjunctive arm: its variables, its matches (ArmMatch), its conditions over the variables, and the fact it derives,
 * a term per heading field.
 */
export interface ConjunctiveArm {
	readonly vars: ReadonlyArray<VarDesc>
	readonly matches: NonEmptyReadonlyArray<ArmMatch>
	readonly where: ReadonlyArray<InferredExpr>
	readonly head: Readonly<Record<string, InferredExpr>>
}

/**
 * A negation in an arm: that no fact of what it negates agrees with `bindings`, a term of the negating arm for each
 * heading field the negation binds. `source` is what it negates as a query reads it live (`LiveReading`): a stored or
 * closed relation by its name, or a derived relation's definition or an imported query, as declared. `arms` are its
 * arms, each closed, its variables its own, each negating in turn, an Active of the sittings no ending and no standing
 * invalidation names, a standing invalidation being one no reinstatement names; an anti-join of one stored or closed
 * relation is the arm of its one match, which negates nothing. A probe reads the arms one by one (`movedOf`), since NOT
 * EXISTS over a union is the conjunction of NOT EXISTS over each arm; a query states the negation once (`absentsOf`).
 */
export interface Negation {
	readonly source: NegatedSource
	readonly bindings: InferredBindings
	readonly arms: NonEmptyReadonlyArray<LiveArm>
}

/** What a negation negates, as a query reads it: a stored or closed relation by its name, or a definition live. */
type NegatedSource = Extract<InferredSource, { readonly kind: "relation" }> | DefinitionSource

/** One arm of a definition: a conjunctive arm, and the negations each of which withdraws the facts it agrees with. */
export interface LiveArm extends ConjunctiveArm {
	readonly negated: ReadonlyArray<Negation>
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
 * A unit-local rule (analysis/theory/unit.ts), whatever its query reads: every relation it reads immutable, or all of
 * them in one declared unit, and leading its key with one unit key, which every rule of its violation query joins on,
 * so every fact of its violation lies within one unit. The judge reads its violation query, the one the migration that
 * adds it runs, over the units a transaction wrote (`judged`), once whatever rows of them it wrote, never row by row.
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
	 * The query of the violation each query `judged` reads was walked from, itself where the walk copied none: a copy
	 * reads the unit's channels its import binds (unit.ts passedChannels), which only that import types, so a union's
	 * heading is its definition's, checked where no channel is (analysis/theory/navigate.ts boundInside), never the
	 * copy's, checked alone.
	 */
	readonly definitionOf: (query: InferredQuery) => InferredQuery
	/**
	 * The holders whose gained rows its region reads only where they replace a row the transaction lost at the `fields`
	 * a witness fixes its rows at, proved at generate time to open a fact only there (unit.ts proofsOf): the rows each
	 * lost, at those fields, which the judge captures for the region, beside the sides its occurrences read.
	 */
	readonly replaced: ReadonlyArray<ReplacedRead>
	/**
	 * The violation query itself: the rule's check over every row, which the migration that adds the rule runs, the judge
	 * of the transaction that writes every row, whose units are every unit, so no region restricts it. Navigated as the
	 * judge navigates its statements (physical/ddl/rules.ts), it reads each relation by a lookup from the rows its first
	 * read delivers, once, where read per unit it ran a step for every unit of the installation.
	 */
	readonly everyRow: InferredQuery
}

/** A holder whose lost rows a whole rule's region reads, and the fields at which the witness that proves it fixes its
 * rows, a key of it among them or its tree's root fields (WholeRule `replaced`, unit.ts witnessesOf). */
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
	 * it: the inferred field's own (schema/field-desc.ts fieldDescOf), a computed numeric's among them, which a
	 * bare head literal of the column is typed by, so the literal stands wherever a term of the column does.
	 */
	readonly columnType: (relation: string, query: InferredQuery, loc: SourceLoc) => ColumnTypes
	/** How an aggregating rule a definition reads is read live, its groups' query (Groups `query`). */
	readonly live: LiveReading
	readonly loc: SourceLoc
}

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
	retype: undefined,
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
	negated: ReadonlyArray<Negation>,
	leaves: LeafRewrite
): ReadonlyArray<Negation> =>
	negated.map((n) => ({ ...n, bindings: mapBindings(n.bindings, leaves) }))

/** An arm still being flattened: no match yet is the arm of a rule that matched only derived relations so far. */
interface PartialArm {
	readonly vars: ReadonlyArray<VarDesc>
	readonly matches: ReadonlyArray<ArmMatch>
	readonly where: ReadonlyArray<InferredExpr>
	readonly head: Readonly<Record<string, InferredExpr>>
	readonly negated: ReadonlyArray<Negation>
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

/** Whether a rule's head folds the facts of its body: some head term aggregates. */
const folds = (head: InferredRule["head"]): boolean =>
	Object.values(head).some((h) => h.kind === "aggregate")

/** A rule's head without its aggregates: its group fields, at whose values it holds one fact. */
const groupFields = (head: InferredRule["head"]): Readonly<Record<string, InferredHead>> =>
	Object.fromEntries(Object.entries(head).filter(([, h]) => h.kind !== "aggregate"))

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
					"a rule reads a recursion only where it is unit-local: every relation it reads immutable or all of them in one declared unit, every match of it within one unit, and every step carrying the unit from self into its head"
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
		return folds(rule.head)
			? [this.#groupedArm(relation, rule, groupFields(rule.head), columns)]
			: this.#conjunctive(relation, rule, columns)
	}

	/**
	 * The arm of an aggregating rule's facts: one grouped match (GroupedMatch) binding each head field to a variable of
	 * its own, its head those variables, as the arm of a stored relation's one match is (`#relationArm`). The match holds
	 * the rule read live, its group fields, the head fields `plain` derives, and its body's arms, the rule with `plain`
	 * for its head, each flattened as any rule is, so a body that matches a derived relation, negates or aggregates in
	 * turn is read as it would be anywhere.
	 */
	#groupedArm(
		relation: string,
		rule: InferredRule,
		plain: Readonly<Record<string, InferredHead>>,
		columns: ColumnTypes
	): LiveArm {
		const [first, ...rest] = this.#conjunctive(relation, { ...rule, head: plain }, columns)
		if (first === undefined) {
			return this.#refuse(relation, "derives no fact")
		}
		const prefix = `q${this.#next++}.`
		const bound = Object.fromEntries(
			Object.keys(rule.head).map((f) => [f, varRef(`${prefix}${f}`)] as const)
		)
		return {
			vars: Object.keys(rule.head).map((f) => ({
				id: `${prefix}${f}`,
				origin: undefined,
				loc: rule.loc
			})),
			matches: [
				{
					kind: "grouped",
					groups: {
						query: this.env.live.rule(rule),
						keys: Object.keys(plain),
						body: [first, ...rest]
					},
					bindings: bound,
					loc: rule.loc
				}
			],
			where: [],
			head: bound,
			negated: []
		}
	}

	/**
	 * The arms of a rule whose head folds nothing (`#rule`): one, each definition of one rule it matches joined in
	 * (`#merged`) and each of several a match of its own (`#defined`), never distributed into an arm for each choice of
	 * one of its rules.
	 */
	#conjunctive(relation: string, rule: InferredRule, columns: ColumnTypes): ReadonlyArray<LiveArm> {
		const prefix = `q${this.#next++}.`
		const rename = (id: string): string => `${prefix}${id}`
		const leaves: LeafRewrite = { var: (id) => varRef(rename(id)), field: () => undefined }
		const head: Record<string, InferredExpr> = {}
		for (const [name, term] of Object.entries(rule.head)) {
			const t = this.#headTerm(relation, term)
			head[name] = mapLeaves(isBare(t) ? typedAs(t, columns(name)) : t, leaves)
		}
		const where: Array<InferredExpr> = []
		const negated: Array<Negation> = []
		for (const w of rule.where.flatMap(filtersOf)) {
			if (w.kind === "absent") {
				negated.push(this.#negated(relation, w, leaves, rule.loc))
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
							matches: [
								...p.matches,
								{ kind: "stored", relation: inlined.stored, bindings, loc: match.loc }
							]
						}))
					: inlined.arms.length > 1
						? partials.map((p) => ({
								...p,
								matches: [...p.matches, this.#defined(relation, inlined, bindings, match.loc)]
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
	 * The match of `inlined`, a definition of several rules, kept whole (DefinedMatch) at the bindings `bindings` of the
	 * match that reads it, each field it binds one every arm of the definition derives.
	 */
	#defined(
		relation: string,
		inlined: Inlined,
		bindings: InferredBindings,
		loc: SourceLoc
	): DefinedMatch {
		this.#derived(
			relation,
			inlined.arms,
			bindings,
			(field) => `binds ${field}, which the definition it matches derives none of`
		)
		return { kind: "defined", source: inlined.source, arms: inlined.arms, bindings, loc }
	}

	/** Refuses, by `refusal`, a field of `bindings` some arm of `arms` derives none of. */
	#derived(
		relation: string,
		arms: NonEmptyReadonlyArray<LiveArm>,
		bindings: InferredBindings,
		refusal: (field: string) => string
	): void {
		for (const arm of arms) {
			for (const field of Object.keys(bindings)) {
				if (arm.head[field] === undefined) {
					this.#refuse(relation, refusal(field))
				}
			}
		}
	}

	/**
	 * The negation `w` in a rule of `relation`'s definition, its bindings read through the rule's `leaves`, its source read
	 * live: of a stored or closed relation, the one arm of its one match; of a derived relation or a query, each arm of its
	 * definition, each with every negation of its own, which a probe reads with the polarity flipped once more
	 * (`Polarity`).
	 */
	#negated(
		relation: string,
		w: Extract<InferredExpr, { readonly kind: "absent" }>,
		leaves: LeafRewrite,
		loc: SourceLoc
	): Negation {
		for (const e of Object.values(w.bindings)) {
			const foreign = foreignLeaf(e)
			if (foreign !== undefined) {
				return this.#refuse(relation, foreign)
			}
		}
		const bindings = mapBindings(w.bindings, leaves)
		const source = this.#source(relation, w.source, "negates")
		if (source.kind === "stored") {
			return {
				source: { kind: "relation", name: source.stored },
				bindings,
				arms: [this.#relationArm(source.stored, Object.keys(bindings), loc)]
			}
		}
		const negated =
			w.source.kind === "relation" ? `the derived relation ${w.source.name}` : "a query"
		this.#derived(
			relation,
			source.arms,
			bindings,
			(field) => `binds ${field}, which ${negated} it negates derives none of`
		)
		return { source: source.source, bindings, arms: source.arms }
	}

	/** The arm of one match of the stored or closed relation `relation`, binding each of `fields` to a variable it derives. */
	#relationArm(relation: string, fields: ReadonlyArray<string>, loc: SourceLoc): LiveArm {
		const prefix = `q${this.#next++}.`
		const bound = Object.fromEntries(fields.map((f) => [f, varRef(`${prefix}${f}`)] as const))
		return {
			vars: fields.map((f) => ({ id: `${prefix}${f}`, origin: { relation, field: f }, loc })),
			matches: [{ kind: "stored", relation, bindings: bound, loc }],
			where: [],
			head: bound,
			negated: []
		}
	}

	/** A head term of a rule that folds nothing: an aggregating rule is its own arm (`#groupedArm`). */
	#headTerm(relation: string, term: InferredHead): InferredExpr {
		if (term.kind === "aggregate") {
			throw defect("a rule that folds is read as its groups, never as a conjunctive arm")
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
	 * reads itself, or a derived relation's definition or an imported query that binds no parameter (Inlined).
	 */
	#source(relation: string, source: InferredSource, verb: "matches" | "negates"): Matched {
		switch (source.kind) {
			case "relation": {
				const definition = this.env.definition(source.name)
				return definition === undefined
					? { kind: "stored", stored: source.name }
					: this.#inlined(source.name, definition)
			}
			case "query":
				if (Object.keys(source.bind).length > 0) {
					return this.#refuse(relation, `${verb} an imported query that binds parameters`)
				}
				return this.#inlined(relation, source.query)
			case "step":
				return this.#refuse(relation, `${verb} a navigation step`)
			case "param":
			case "paramOf":
				return this.#refuse(relation, `${verb} a relation parameter`)
			case "context":
				return this.#refuse(relation, `${verb} a context`)
			case "call":
			case "callField":
				return this.#refuse(relation, `${verb} a declared function's rows`)
			case "split":
				return this.#refuse(relation, `${verb} a text's split, which only a unit-local rule reads`)
			case "series":
				return this.#refuse(relation, `${verb} a series, which only a unit-local rule reads`)
			case "interior":
			case "self":
			case "delta":
			case "row":
				return this.#refuse(relation, `${verb} a ${source.kind} source`)
		}
	}

	/**
	 * `query`, the definition of `relation` or an imported query, as a match or a negation reads it (Inlined): read live,
	 * as rules (`rulesOf`), and its arms.
	 */
	#inlined(relation: string, query: InferredQuery): Inlined {
		return {
			kind: "inlined",
			source: { kind: "query", query: rulesOf(this.env.live.query(query)), bind: {} },
			arms: this.arms(relation, query)
		}
	}
}

/** What a match's source is to an arm (Flattener.#source): a stored or closed relation, or a definition (Inlined). */
type Matched = { readonly kind: "stored"; readonly stored: string } | Inlined

/**
 * A definition a rule matches or negates, a derived relation's or an imported query's: the query a query reads it as,
 * live (DefinitionSource), and its arms.
 */
interface Inlined {
	readonly kind: "inlined"
	readonly source: DefinitionSource
	readonly arms: NonEmptyReadonlyArray<LiveArm>
}

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

/** A rule's side's term as a row expression: a field, or pred of a natural, the one type a side's pred reads. */
const sideTerm = (term: TermDesc): GuardedTerm => guardedTerm(term, naturalType)

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
		const guarded = mapNonEmpty(terms, sideTerm)
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
	const guarded = mapNonEmpty(terms, sideTerm)
	return {
		vars: fields.map((f) => ({ id: id(f), origin: { relation, field: f }, loc })),
		matches: [{ kind: "stored", relation, bindings: bound, loc }],
		where: [
			...selection.conjuncts.map((c) => mapLeaves(c, leaves)),
			...guarded.flatMap((g) => g.guard.map((x) => mapLeaves(x, leaves)))
		],
		head: bound,
		negated: [],
		terms: mapNonEmpty(guarded, (g) => mapLeaves(g.term, leaves))
	}
}

/**
 * How an arm reads a relation it matches, composed through every negation the match stands under: `positive`, a match
 * of the arm itself or one under an even count of negations, where a row the relation gains can add a fact of the arm;
 * `negative`, one under an odd count, where a row it loses can.
 */
type Polarity = "positive" | "negative"

/** The polarity a negation turns `p` into. */
const flipped = (p: Polarity): Polarity => (p === "positive" ? "negative" : "positive")

/** What an arm reads (`readsAt`): its matches and its negations, an arm's or an alternative's (Alternative). */
interface ArmReads {
	readonly matches: ReadonlyArray<ArmMatch>
	readonly negated: ReadonlyArray<Negation>
}

/** The matches an arm's negations read at `polarity` (Polarity), at any depth: what each negated arm reads at the other. */
const negatedReads = (
	arm: Pick<LiveArm, "negated">,
	polarity: Polarity
): ReadonlyArray<ReadMatch> =>
	arm.negated.flatMap((n) => n.arms.flatMap((a) => readsAt(a, flipped(polarity))))

/**
 * The matches an arm reads at `polarity` (Polarity), at any depth: its own matches positively, a definition it matches
 * by what each of its arms reads at the same polarity (DefinedMatch), and its negations'.
 */
const readsAt = (arm: ArmReads, polarity: Polarity): ReadonlyArray<ReadMatch> => [
	...arm.matches.flatMap((m): ReadonlyArray<ReadMatch> =>
		m.kind === "defined"
			? m.arms.flatMap((a) => readsAt(a, polarity))
			: polarity === "positive"
				? [m]
				: []
	),
	...negatedReads(arm, polarity)
]

/**
 * The stored and closed relations a match reads: a stored or closed relation's itself, and an aggregating rule's every
 * one its body reads, at any depth and either polarity, a row any of them gains or loses changing a group's fact.
 */
const storedOf = (m: ReadMatch): ReadonlyArray<StoredMatch> => {
	switch (m.kind) {
		case "stored":
			return [m]
		case "grouped":
			return m.groups.body.flatMap((arm) =>
				[...readsAt(arm, "positive"), ...readsAt(arm, "negative")].flatMap(storedOf)
			)
	}
}

/** The stored and closed matches among `matches`, read as their relations' rows are. */
const storedAmong = (matches: ReadonlyArray<ReadMatch>): ReadonlyArray<StoredMatch> =>
	matches.flatMap((m) => (m.kind === "stored" ? [m] : []))

/** What the aggregating rules among `matches` read (`storedOf`), each a read of both polarities. */
const groupedAmong = (matches: ReadonlyArray<ReadMatch>): ReadonlyArray<StoredMatch> =>
	matches.flatMap((m) => (m.kind === "grouped" ? storedOf(m) : []))

/** Every match an arm reads, at any depth and either polarity. */
const everyRead = (arm: ArmReads): ReadonlyArray<ReadMatch> => [
	...readsAt(arm, "positive"),
	...readsAt(arm, "negative")
]

/**
 * The stored relations a rule reads, sorted, each once: a probed rule's by a match of its arms or inside a negated arm,
 * at any depth, an aggregating rule's body among them, a whole rule's every occurrence its violation query reads.
 */
export const ruleReads = (rule: QueryRule): ReadonlySet<string> => {
	switch (rule.kind) {
		case "contained":
		case "key":
		case "check":
			return new Set(
				[...breakingArms(rule), ...targetArms(rule)]
					.flatMap((a) =>
						everyRead(a)
							.flatMap(storedOf)
							.map((m) => m.relation)
					)
					.toSorted(compareStrings)
			)
		case "whole":
			return new Set(rule.reads.map((r) => r.relation).toSorted(compareStrings))
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

/**
 * A match as a query reads it: a stored or closed relation by its name, an aggregating rule's groups as its query, a
 * definition of several rules as the definition, live.
 */
const matchDesc = (m: ArmMatch): InferredMatch => ({
	source: sourceOf(m),
	bindings: m.bindings,
	loc: m.loc
})

/** What a match reads (`matchDesc`). */
const sourceOf = (m: ArmMatch): InferredSource => {
	switch (m.kind) {
		case "stored":
			return { kind: "relation", name: m.relation }
		case "grouped":
			return { kind: "query", query: m.groups.query, bind: {} }
		case "defined":
			return m.source
	}
}

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
 * one match, no condition and no negation, each column it binds bound to a variable of its own, and a head that renames those
 * variables. Its bindings are then the negation's composed through the arm's, each heading field's term bound to the
 * column the field renames, and a column the head does not carry stays unbound, as an anti-join of the relation reads
 * it. Undefined for any other arm.
 */
const relationAbsent = (
	arm: LiveArm,
	negation: InferredBindings
): Extract<InferredExpr, { readonly kind: "absent" }> | undefined => {
	const [match, ...more] = arm.matches
	if (
		match.kind !== "stored" ||
		more.length > 0 ||
		arm.where.length > 0 ||
		arm.negated.length > 0
	) {
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
	for (const [field, term] of Object.entries(arm.head)) {
		const column = term.kind === "var" ? columnOf.get(term.var) : undefined
		if (column === undefined) {
			return undefined
		}
		renamed.set(field, column)
	}
	const bindings: Record<string, InferredExpr> = {}
	for (const [field, term] of Object.entries(negation)) {
		const column = renamed.get(field)
		if (column === undefined || bindings[column] !== undefined) {
			return undefined
		}
		bindings[column] = term
	}
	return { kind: "absent", source: { kind: "relation", name: match.relation }, bindings }
}

/**
 * That no fact of what a negation negates agrees with its bindings, as a query states it. Of one arm: an anti-join of
 * the one relation the arm reads as it is (`relationAbsent`), a negation of a stored or closed relation among them, as
 * its definition states it, else of the arm read as an imported query, its own negations among its conditions
 * (`conditionsOf`). Of several: one anti-join of its source as declared, read live, which navigation reads arm by arm,
 * each arm keyed by the negating row's terms (analysis/theory/navigate.ts Navigator `#filtered`), where an anti-join of
 * each arm spelled the arm's unfolding, a match of a union in the definition distributed into an arm per rule of the
 * union and each negation of the definition spelled again in each: a negation of a definition that matches a union and
 * negates in turn grew as the product of the unions' widths at every depth.
 */
const absentsOf = (n: Negation, loc: SourceLoc): ReadonlyArray<InferredExpr> =>
	n.arms.length > 1
		? [{ kind: "absent", source: n.source, bindings: n.bindings }]
		: n.arms.map(
				(arm) =>
					relationAbsent(arm, n.bindings) ?? {
						kind: "absent",
						source: imported(
							[
								ruleDesc(
									arm.vars,
									arm.matches.map(matchDesc),
									conditionsOf(arm, loc),
									arm.head,
									loc
								)
							],
							loc
						),
						bindings: n.bindings
					}
			)

/** An arm's conditions as a query states them: its own, then an anti-join of each of its negations. */
const conditionsOf = (
	arm: Pick<LiveArm, "where" | "negated">,
	loc: SourceLoc
): ReadonlyArray<InferredExpr> => [...arm.where, ...arm.negated.flatMap((n) => absentsOf(n, loc))]

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
 * equates its head with the terms it is met at (analysis/theory/navigate.ts), each literal typed at its column, so a
 * union's arm whose literal differs from the term's is a condition of two literals of the column's type that differ:
 * the arm read alone reads none of the facts the term selects, and the union read by arm still judges what the whole
 * check does.
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
 * An arm of a rule's breaking side as a probe reads it (`rowOf`): a side's arm, or one a probe of the added side holds
 * to its region (`gainedOf`), whose matches are the arm's others, none where the arm reads that relation alone.
 */
interface ProbeArm extends Omit<SideArm, "matches"> {
	readonly matches: ReadonlyArray<ArmMatch>
}

/**
 * One row of a probe (`probeOf`): a candidate the write may break the rule at, over its region (none for an arm the
 * check over every row reads as it stands), as a rule deriving what the rule's meeting part reads of it (`meetings`):
 * each term under its pair's name and, for a key or a check, each heading field under its head name.
 */
interface ProbeRow {
	readonly region: Region | undefined
	readonly rule: InferredRule
}

/** The heading fields a rule's meeting part reads of a row beside its terms: a key's and a check's side's heading. */
const rowFields = (rule: ProbedRule): ReadonlyArray<string> =>
	rule.kind === "contained" ? [] : rule.side.heading

/** The row an arm of the rule's breaking side states over `region`: its facts as it stands, its conditions and negations among them. */
const rowOf = (
	rule: ProbedRule,
	region: Region | undefined,
	arm: ProbeArm,
	loc: SourceLoc
): ProbeRow => ({
	region,
	rule: ruleDesc(
		arm.vars,
		arm.matches.map(matchDesc),
		conditionsOf(arm, loc),
		rowHeadOf(rule, arm, loc),
		loc
	)
})

/** What a row derives of an arm (ProbeRow): its terms under their pair names, and a key's or a check's heading fields. */
const rowHeadOf = (
	rule: ProbedRule,
	arm: Pick<SideArm, "terms" | "head">,
	loc: SourceLoc
): Readonly<Record<string, InferredExpr>> => ({
	...termHead(arm.terms),
	...Object.fromEntries(rowFields(rule).map((f) => [headName(f), headOf(arm, f, loc)] as const))
})

/**
 * What the meeting part of a probe reads its rows as (`meetings`): variables, matches and conditions that hold one row
 * each, its terms, and each heading field a key or a check reads.
 */
interface Reading {
	readonly vars: ReadonlyArray<VarDesc>
	readonly matches: ReadonlyArray<InferredMatch>
	readonly where: ReadonlyArray<InferredExpr>
	readonly terms: NonEmptyReadonlyArray<InferredExpr>
	readonly field: (field: string) => InferredExpr
}

/**
 * The rules of a probe's meeting part over its rows read as `r`, the side they meet read by arm (`readAs`): for a
 * containment, its tuples the target lacks; for a key, its facts another fact of the side agrees with on the key and
 * differs from elsewhere in the heading, a rule per arm of the side; for a check, its facts the condition refuses.
 */
const meetings = (
	rule: ProbedRule,
	r: Reading,
	loc: SourceLoc
): NonEmptyReadonlyArray<InferredRule> => {
	switch (rule.kind) {
		case "contained":
			return [
				ruleDesc(
					r.vars,
					r.matches,
					[...r.where, ...lacks(rule.to, r.terms, loc)],
					termHead(r.terms),
					loc
				)
			]
		case "key": {
			const heading = rule.side.heading
			const other = Object.fromEntries(
				heading.map((f) => [headName(f), varRef(otherId(f))] as const)
			)
			return mapNonEmpty(facts(rule.side, r.terms, heading, loc), (met) =>
				ruleDesc(
					[...r.vars, ...heading.map((f) => ({ id: otherId(f), origin: undefined, loc }))],
					[...r.matches, { source: met.source, bindings: { ...met.bindings, ...other }, loc }],
					[
						...r.where,
						connectiveExpr(
							"or",
							heading.map((f): InferredExpr => ({
								kind: "compare",
								op: "ne",
								left: r.field(f),
								right: varRef(otherId(f))
							}))
						)
					],
					termHead(r.terms),
					loc
				)
			)
		}
		case "check": {
			const leaves: LeafRewrite = { var: () => undefined, field: r.field }
			return [
				ruleDesc(
					r.vars,
					r.matches,
					[...r.where, refusalCondition(mapLeaves(rule.predicate, leaves))],
					termHead(r.terms),
					loc
				)
			]
		}
	}
}

/** `rule` read over `region` (`overRegion`), itself where it has none. */
const overAny = (region: Region | undefined, rule: InferredRule, loc: SourceLoc): InferredRule =>
	region === undefined ? rule : overRegion(region, rule, loc)

/** The fresh variable a probe's meeting part reads its rows' field `name` in (`probeOf`). */
const rowId = (name: string): string => `row.${name}`

/**
 * The probe of `rows`, the candidates a write may break the rule at: the rule's meeting part (`meetings`) read once over
 * every row, never once per candidate. A probe of one candidate reads it as the meeting part's own matches; of several,
 * the union of their rows, each over its region (`overRegion`), each row of the union the meeting part meets apart,
 * the target's negation keyed by the row's terms as before. A rule breaks at some candidate exactly when it breaks at
 * some row of their union, (∃i)(Cᵢ ∧ ¬T) being (∪ᵢ Cᵢ) ∧ ¬T, so the probe judges what one probe of each candidate did,
 * where each read the meeting part again, a containment's whole target, its derived relations unfolded, once per
 * candidate: edullm ledger's servable rule read Servable's unfolding again in each of 157 probes of Attribute's added
 * rows. A candidate whose key (`probeKey`) an earlier one holds is the same rows and is read once.
 */
const probeOf = (
	rule: ProbedRule,
	rows: NonEmptyReadonlyArray<ProbeRow>,
	loc: SourceLoc
): InferredQuery => {
	const seen = new Set<string>()
	const [first, ...rest] = rows.filter((row) => {
		const key = probeKey(overAny(row.region, row.rule, loc))
		if (seen.has(key)) {
			return false
		}
		seen.add(key)
		return true
	})
	const terms = mapNonEmpty(breakingArms(rule)[0].terms, (_, i) => termName(i))
	const fields = rowFields(rule).map(headName)
	if (first === undefined) {
		throw defect("a probe of no candidate")
	}
	if (!isNonEmpty(rest)) {
		const head = first.rule.head
		const term = (name: string): InferredExpr => {
			const h = head[name]
			if (h === undefined || h.kind === "aggregate" || h.kind === "producer") {
				throw defect(`a probe's row derives its term ${name}`)
			}
			return h
		}
		const reading: Reading = {
			vars: first.rule.vars,
			matches: first.rule.matches,
			where: first.rule.where,
			terms: mapNonEmpty(terms, term),
			field: (f) => term(headName(f))
		}
		return queryOf(
			mapNonEmpty(meetings(rule, reading, loc), (m) => overAny(first.region, m, loc)),
			loc
		)
	}
	const read = [...terms, ...fields]
	const reading: Reading = {
		vars: read.map((name) => ({ id: rowId(name), origin: undefined, loc })),
		matches: [
			{
				source: imported(
					mapNonEmpty([first, ...rest], (row) => overAny(row.region, row.rule, loc)),
					loc
				),
				bindings: Object.fromEntries(read.map((name) => [name, varRef(rowId(name))] as const)),
				loc
			}
		],
		where: [],
		terms: mapNonEmpty(terms, (name) => varRef(rowId(name))),
		field: (f) => varRef(rowId(headName(f)))
	}
	return queryOf(meetings(rule, reading, loc), loc)
}

/** `e` with the source of every negation in it read through `source`, at any depth. */
const sourcesThrough = (
	e: InferredExpr,
	source: (s: InferredSource) => InferredSource
): InferredExpr => mapExpr(e, { leaf: (x) => x, term: (x) => sourcesThrough(x, source), source })

/**
 * How a theory's violation queries read their relations live: the source each relation is read through, an ordinary,
 * closed or stored derived relation by its name, a live derived relation as its definition, read live and imported as a
 * query of its own (`liveQuery`); and each query read live, once however many laws read it (`liveReading`).
 */
export interface LiveReading {
	readonly relation: (relation: string) => InferredSource
	readonly query: (query: InferredQuery) => InferredQuery
	/** One rule of a definition as a query of its own, read live, once however many laws read it: an aggregating rule's
	 * groups (Groups `query`). */
	readonly rule: (rule: InferredRule) => InferredQuery
}

/**
 * The live reading of the relations `definition` defines (`LiveReading`), each query read live once: every law over a
 * derived relation reads the one live definition, and every query that definition imports the one live query, so the
 * judge's statements, each a navigated violation of a law, meet one query wherever they read it, its heading checked
 * once (analysis/theory/navigate.ts boundInside, physical/ddl/context.ts InstallBuilder.columns), where each law read
 * a copy of its own.
 */
export const liveReading = (definition: LiveEnv["definition"]): LiveReading => {
	const known = new WeakMap<InferredQuery, InferredQuery>()
	const rules = new WeakMap<InferredRule, InferredQuery>()
	const reading: LiveReading = {
		relation: (relation) => {
			const d = definition(relation)
			return d === undefined
				? { kind: "relation", name: relation }
				: { kind: "query", query: reading.query(d), bind: {} }
		},
		query: (query) => {
			const found = known.get(query)
			if (found !== undefined) {
				return found
			}
			const read = liveQuery(query, reading)
			known.set(query, read)
			return read
		},
		rule: (rule) => {
			const found = rules.get(rule)
			if (found !== undefined) {
				return found
			}
			const read = reading.query(queryOf([rule], rule.loc))
			rules.set(rule, read)
			return read
		}
	}
	return reading
}

/**
 * A query read live: every derived relation it matches or negates that the reading reads no table of, at any depth, in
 * every stage, interior stage, attachment and import of it, read as its own definition, live, imported (`LiveReading`),
 * and every query it imports read so in turn. Each stays a query of its own, so its rows are computed at a level of
 * their own, joined to the level that reads them by the columns that level binds; none stays a relation by its name,
 * which a walk of the query (analysis/theory/unit.ts) would read as a closed relation, the same at every state and in
 * no unit, and the checker as a table. The query builder names every derived relation by its name, whatever the
 * installation infers of its storage (query/build/state.ts), so the reading is where a definition takes its place.
 */
const liveQuery = (query: InferredQuery, live: LiveReading): InferredQuery => {
	/** A query read under a bind map, live, and each query's rows its bind map binds a relation parameter to. */
	const liveImport = <I extends ImportDesc<Located, Inferred>>(i: I): I => ({
		...i,
		query: live.query(i.query),
		bind: mapRecord(i.bind, (b) => (b.kind === "rows" ? liveImport(b) : b))
	})
	const source = (s: InferredSource): InferredSource => {
		switch (s.kind) {
			case "relation":
				return live.relation(s.name)
			case "query":
			case "step":
				return liveImport(s)
			case "call":
			case "callField":
				return {
					...s,
					args: mapRecord(s.args, (a) => (a.kind === "rows" ? liveImport(a) : a))
				}
			case "split":
			case "series":
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
		where: r.where.map((w) => sourcesThrough(w, source)),
		interiors: r.interiors.map((i) => ({ ...i, arms: mapNonEmpty(i.arms, rule) })),
		attach: r.attach.map((a) => ({ ...a, child: live.query(a.child) }))
	})
	const stage = (st: InferredStage): InferredStage => {
		switch (st.kind) {
			case "rules":
				return { ...st, arms: mapNonEmpty(st.arms, rule) }
			case "union":
				return { ...st, input: stage(st.input), arms: mapNonEmpty(st.arms, rule) }
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
				return {
					...st,
					input: stage(st.input),
					attach: { ...st.attach, child: live.query(st.attach.child) }
				}
			case "named":
			case "order":
			case "take":
			case "approx":
				return { ...st, input: stage(st.input) }
		}
	}
	return { ...query, stage: stage(query.stage) }
}

/**
 * `query` as a query of rules, the stage a negation's source is read in (`Negation`): a named stage's input, a union's
 * input's rules and then its own, each in order; itself where it is one. A definition a rule reads holds no other stage
 * (`Flattener`).
 */
const rulesOf = (query: InferredQuery): InferredQuery => {
	const arms = (stage: InferredStage): NonEmptyReadonlyArray<InferredRule> => {
		switch (stage.kind) {
			case "rules":
				return stage.arms
			case "union":
				return extendNonEmpty(arms(stage.input), stage.arms)
			case "named":
				return arms(stage.input)
			case "recursive":
			case "attach":
			case "order":
			case "take":
			case "approx":
				throw defect(`a negated definition of a ${stage.kind} stage, which no rule reads`)
		}
	}
	const stage = query.stage
	switch (stage.kind) {
		case "union":
		case "named":
			return queryOf(arms(stage), stage.loc)
		case "rules":
		case "recursive":
		case "attach":
		case "order":
		case "take":
		case "approx":
			return query
	}
}

/**
 * A side as a rule's full violation query reads it, whole: one match of the side's source (`LiveReading`) binding each
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
	live: LiveReading,
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
	const guarded = mapNonEmpty(side.terms, sideTerm)
	return {
		vars: fields.map((f) => ({ id: id(f), origin: { relation: side.relation, field: f }, loc })),
		match: { source: live.relation(side.relation), bindings: bound, loc },
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
	live: LiveReading,
	loc: SourceLoc
): InferredQuery => {
	switch (rule.kind) {
		case "contained": {
			const from = wholeSide(rule.from, live, [], "s0.", loc)
			const to = wholeSide(rule.to, live, [], "s1.", loc)
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
			const side = wholeSide(rule.side, live, rule.side.heading, "s0.", loc)
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
			const one = wholeSide(rule.side, live, heading, "s0.", loc)
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

/** The variable a probe over its region reads the touched occurrence's field `field` in. */
const regionId = (field: string): string => `region.${field}`

/**
 * The channel a probe over touched groups at nesting `depth` reads its `place`-th group field in (Region `groups`), named
 * by its place, never the field's name: the body a channel reads is then one sub-query whatever the names of the
 * touched set's keys, so a lowering computes it once for every probe that reads it at keys of one domain
 * (lower/shapes/share/copies.ts), where named by field the body read at (child, stage) and at (child, number) was two.
 */
const groupParam = (depth: number, place: number): InferredExpr => ({
	kind: "param",
	name: groupChannel(depth, place),
	type: { kind: "channel" }
})

/** The name of a probe's channel at nesting `depth` for its `place`-th group field (groupParam). */
const groupChannel = (depth: number, place: number): string => `groups${depth}.${place}`

/** The variable a probe over touched groups delivers its head field `field` in. */
const deliveredId = (field: string): string => `delivered.${field}`

/**
 * A probe's region, what it reads first, and the fields of the touched occurrence it holds (`held`):
 *
 * - `delta`: the rows of a stored relation a transaction wrote on one side, a match of that side's delta binding every
 *   field the occurrence binds;
 * - `groups`: a touched set of keys, what a write moves of a definition or of an aggregating rule's body, the groups it
 *   touched (`movedOf`), a query over the write's own region delivering the fields `keys` it holds, read as a step, so
 *   its rows are a set of keys (analysis/physical/consumers.ts), and the probe after it a step of its own reading those
 *   keys through channels (`groupParam`), as a whole rule reads its units (analysis/theory/unit.ts readPerUnit): the
 *   probe runs once per touched key, never once per row its write wrote. On the side of the facts it gains (`gained`)
 *   the probe reads the groups or the definition (`query`) at their keys as they stand at COMMIT, every field of the
 *   occurrence held, a group recomputed from its rows; on the side of those it loses (`lost`), a fact held before the
 *   write, it holds the keys alone, each other field free, as a relaxed match's are (`held`), so every fact held at
 *   those keys at any value is a candidate.
 */
type Region =
	| {
			readonly kind: "delta"
			readonly side: ProbeSide
			readonly relation: string
			readonly fields: ReadonlyArray<string>
	  }
	| {
			readonly kind: "groups"
			readonly depth: number
			readonly touched: InferredQuery
			readonly keys: ReadonlyArray<string>
			readonly read:
				| {
						readonly kind: "gained"
						readonly query: InferredQuery
						readonly fields: ReadonlyArray<string>
				  }
				| { readonly kind: "lost" }
	  }

/** The fields of the touched occurrence `region` holds, each read in its region variable (`regionId`). */
const heldFields = (region: Region): ReadonlyArray<string> => {
	switch (region.kind) {
		case "delta":
			return region.fields
		case "groups":
			return region.read.kind === "gained" ? region.read.fields : region.keys
	}
}

/** The declarations of the variables `region` holds its fields in. */
const regionVars = (region: Region, loc: SourceLoc): ReadonlyArray<VarDesc> =>
	heldFields(region).map((field) => ({
		id: regionId(field),
		origin: region.kind === "delta" ? { relation: region.relation, field } : undefined,
		loc
	}))

/**
 * `rule` read over `region`: a delta's match first and its variables after the rule's own; touched groups as a step of
 * their keys, then the rule as a step reading them through its channels (Region `groups`), the groups at their keys
 * read first inside it on the side of what they gain, its head delivered.
 */
const overRegion = (region: Region, rule: InferredRule, loc: SourceLoc): InferredRule => {
	switch (region.kind) {
		case "delta":
			return {
				...rule,
				vars: [...rule.vars, ...regionVars(region, loc)],
				matches: [
					{
						source: { kind: "delta", side: region.side, relation: region.relation },
						bindings: Object.fromEntries(
							region.fields.map((f) => [f, varRef(regionId(f))] as const)
						),
						loc
					},
					...rule.matches
				]
			}
		case "groups": {
			const read = region.read
			const groups: ReadonlyArray<InferredMatch> =
				read.kind === "gained"
					? [
							{
								source: { kind: "query", query: read.query, bind: {} },
								bindings: Object.fromEntries(
									read.fields.map((f) => [f, varRef(regionId(f))] as const)
								),
								loc
							}
						]
					: []
			const reads = new Set<string>()
			for (const m of [...groups, ...rule.matches]) {
				for (const e of Object.values(m.bindings)) {
					varsOf(e, reads)
				}
			}
			for (const w of rule.where) {
				varsOf(w, reads)
			}
			for (const h of Object.values(rule.head)) {
				if (h.kind !== "aggregate" && h.kind !== "producer") {
					varsOf(h, reads)
				}
			}
			const keys = region.keys.filter((k) => reads.has(regionId(k)))
			const channels = new Map(
				keys.map((k, place) => [regionId(k), groupParam(region.depth, place)] as const)
			)
			const leaves: LeafRewrite = { var: (id) => channels.get(id), field: () => undefined }
			const inner: InferredRule = {
				...rule,
				vars: [
					...rule.vars,
					...regionVars(region, loc).filter((v) => reads.has(v.id) && !channels.has(v.id))
				],
				matches: [...groups, ...rule.matches].map((m) => ({
					...m,
					bindings: mapBindings(m.bindings, leaves)
				})),
				where: rule.where.map((w) => mapLeaves(w, leaves)),
				head: Object.fromEntries(
					Object.entries(rule.head).map(([field, h]): readonly [string, InferredHead] => [
						field,
						h.kind === "aggregate" || h.kind === "producer" ? h : mapLeaves(h, leaves)
					])
				)
			}
			const fields = Object.keys(rule.head)
			const delivered = Object.fromEntries(fields.map((f) => [f, varRef(deliveredId(f))] as const))
			return ruleDesc(
				[
					...keys.map((k) => ({ id: regionId(k), origin: undefined, loc })),
					...fields.map((f) => ({ id: deliveredId(f), origin: undefined, loc }))
				],
				[
					{
						source: { kind: "step", query: region.touched, bind: {} },
						bindings: Object.fromEntries(keys.map((k) => [k, varRef(regionId(k))] as const)),
						loc
					},
					{
						source: {
							kind: "step",
							query: queryOf([inner], loc),
							bind: Object.fromEntries(
								keys.map(
									(k, place) => [groupChannel(region.depth, place), varRef(regionId(k))] as const
								)
							)
						},
						bindings: delivered,
						loc
					}
				],
				[],
				delivered,
				loc
			)
		}
	}
}

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
	/** The variables only a dropped match, or a field of the touched one its region does not hold, binds. */
	readonly free: ReadonlySet<string>
	readonly unbound: (e: InferredExpr) => boolean
	readonly kept: ReadonlyArray<ArmMatch>
	readonly where: ReadonlyArray<InferredExpr>
}

/**
 * The match `touched` held to `region` (Region), beside the variables `bound` the rest of the probe binds, the matches
 * `kept` it reads as they stand and the matches `relaxed` it drops: each field the region holds is read from it into a
 * variable of its own, each variable such a field binds that neither `bound` nor a kept match binds is that variable,
 * every other binding of it an equality with it (a pin), after the conditions `where`. A variable only a relaxed match,
 * or only a field the region does not hold (a lost group's folded value), binds is free, and a kept match's binding or
 * a condition over one is dropped, so the probe reads every candidate the dropped matches and values would have let
 * through.
 */
const held = (
	touched: InferredBindings,
	region: Region,
	bound: ReadonlySet<string>,
	kept: ReadonlyArray<ArmMatch>,
	relaxed: ReadonlyArray<ArmMatch>,
	where: ReadonlyArray<InferredExpr>
): Held => {
	const byKept = new Set([...bound, ...boundVars(kept)])
	const holds = new Set(heldFields(region))
	const replaced = new Map<string, InferredExpr>()
	const pinned: Array<InferredExpr> = []
	const unheld: Array<string> = []
	for (const [field, e] of Object.entries(touched)) {
		if (!holds.has(field)) {
			if (e.kind === "var") {
				unheld.push(e.var)
			}
			continue
		}
		const value = varRef(regionId(field))
		if (e.kind === "var" && !byKept.has(e.var) && !replaced.has(e.var)) {
			replaced.set(e.var, value)
		} else {
			pinned.push(equal(e, value))
		}
	}
	const free = new Set(
		[...boundVars(relaxed), ...unheld].filter((id) => !byKept.has(id) && !replaced.has(id))
	)
	const leaves: LeafRewrite = { var: (id) => replaced.get(id), field: () => undefined }
	const unbound = (e: InferredExpr): boolean => [...varsOf(e, new Set())].some((id) => free.has(id))
	return {
		region,
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
 * How a transaction's write of one relation on one side touches an occurrence of an arm: the way the occurrence's facts
 * move, `added` where it may gain facts and `removed` where it may lose some, and the region a probe reads them from. A
 * stored relation's occurrence moves the way its rows do, its region the rows written; an aggregating rule's groups
 * move both ways at once for any write its body reads, whichever side it is on: a row its body gains or loses replaces
 * the fact of its group, so each group it touches (`movedOf` of its body, `bothWays`) is a region of either way (Region
 * `groups`); a definition's facts (DefinedMatch) move the ways what the write moves of the definition does (`movedOf`),
 * the facts it may gain read at the keys they bind as they stand at COMMIT, those it may lose at the fields they bind
 * (Region `groups`) (`matchTouches`).
 */
interface Touch {
	readonly direction: ProbeSide
	readonly region: Region
}

/** How a write of `relation` on `side` touches the match `m` (Touch), its groups' region nested `depth` deep. */
const matchTouches = (
	m: ArmMatch,
	relation: string,
	side: ProbeSide,
	depth: number,
	memo: MovedMemo,
	loc: SourceLoc
): ReadonlyArray<Touch> => {
	switch (m.kind) {
		case "stored":
			return m.relation === relation
				? [
						{
							direction: side,
							region: { kind: "delta", side, relation, fields: Object.keys(m.bindings) }
						}
					]
				: []
		case "defined": {
			const fields = Object.keys(m.bindings)
			const keys = Object.entries(m.bindings)
				.flatMap(([f, e]) => (isBare(e) ? [] : [f]))
				.toSorted(compareStrings)
			return (["added", "removed"] as const).flatMap((direction) =>
				movedOf(m, keys, [direction], relation, side, depth + 1, memo, loc).map((moved): Touch => ({
					direction,
					region: {
						kind: "groups",
						depth,
						touched: moved.query,
						keys: moved.fields,
						read:
							direction === "added"
								? { kind: "gained", query: m.source.query, fields }
								: { kind: "lost" }
					}
				}))
			)
		}
		case "grouped": {
			const fields = Object.keys(m.bindings)
			return movedOf(
				{ source: { kind: "query", query: m.groups.query, bind: {} }, arms: m.groups.body },
				m.groups.keys,
				bothWays,
				relation,
				side,
				depth + 1,
				memo,
				loc
			).flatMap((t): ReadonlyArray<Touch> => [
				{
					direction: "added",
					region: {
						kind: "groups",
						depth,
						touched: t.query,
						keys: t.fields,
						read: { kind: "gained", query: m.groups.query, fields }
					}
				},
				{
					direction: "removed",
					region: {
						kind: "groups",
						depth,
						touched: t.query,
						keys: t.fields,
						read: { kind: "lost" }
					}
				}
			])
		}
	}
}

/**
 * The ways a write touches an aggregating rule's groups (GroupedMatch): a row its body gains or loses replaces its
 * group's fact either way, so the groups touched are the keys of every fact of its body the write moves, added or
 * withdrawn (`movedOf`).
 */
const bothWays: NonEmptyReadonlyArray<ProbeSide> = ["added", "removed"]

/** The matches a relaxed probe reads as they stand, and those it drops (`relaxedOf`). */
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
 * A candidate of an arm's facts a write touches, read over its region (`held`): its variables, the matches it reads as
 * they stand, its conditions and the negations it reads as they stand at COMMIT, and the replacement and the free
 * variables its region left, which the arm's head and terms are read through (`leaves`, `unbound`).
 */
interface Candidate {
	readonly region: Region
	readonly vars: ReadonlyArray<VarDesc>
	readonly matches: ReadonlyArray<ArmMatch>
	readonly where: ReadonlyArray<InferredExpr>
	readonly negated: ReadonlyArray<Negation>
	readonly leaves: LeafRewrite
	readonly unbound: (e: InferredExpr) => boolean
}

/**
 * What a write may move of a definition a negation reads (`movedOf`), as one query of its rules: the facts of the
 * definition whose standing the write may change in one direction, each at the heading fields the negation binds that
 * its rule binds, `fields`; a field a rule leaves unbound (a relaxed match's alone) is no field of its query, so its
 * reader joins it at the fields it holds and at no other.
 */
interface Moved {
	readonly fields: ReadonlyArray<string>
	readonly query: InferredQuery
}

/** The direction a negation turns a move: a definition gaining facts withdraws those of the arm that negates it. */
const turned = (direction: ProbeSide): ProbeSide => (direction === "added" ? "removed" : "added")

/** What a probe's rows read of the definitions they meet, once a definition, fields, directions and depth (`movedOf`). */
type MovedMemo = Map<string | InferredQuery, Map<string, ReadonlyArray<Moved>>>

/** The key a definition is read once by (MovedMemo): a stored or closed relation by its name, a query as the one object. */
const movedKey = (source: NegatedSource): string | InferredQuery =>
	source.kind === "relation" ? source.name : source.query

/**
 * The facts of a definition, the arms of what a negation negates, of a definition a match reads (DefinedMatch) or of an
 * aggregating rule's body (GroupedMatch), that a transaction's write of `relation` on `side` may move in one of
 * `directions`, at the heading fields `fields` (Moved), as queries of rules, one for each set of those fields its rules
 * bind: the candidates of its arms' facts the write moves those ways, relaxed (`relaxedOf`, seeded at `fields`), each
 * rule its candidate over its region, read nested `depth` deep, delivering the fields it binds to a variable. A field
 * its arm derives by a computed term, a concatenation or a guarded cast an inlined definition's head left, is delivered
 * by no rule: the query is keys a reader holds, and a computed head beside a key's equations is a computation no query
 * holds (check/checker.ts: a concatenation stands in a query only where it is compared), where a reader held at fewer
 * keys reads every fact at those it holds. It is a superset of the facts that move: each candidate reads the matches on
 * its path to `fields` alone, the arm's others and its negations dropped, and every reader reads the facts it delivers
 * again as they stand: a negating arm by its negation at COMMIT (`movedBy`), a matched definition's gained facts by the
 * definition at their keys (`matchTouches`), a fold's touched groups by the fold at their keys, every group moved
 * either way (`bothWays`), and a lost fact by whatever its probe judges it against. So no rule of it reads a
 * definition's facts as they stand to confirm them: its reader reads them so at the keys it delivers, and a
 * confirmation at those keys read the same definition there again (metis's beacon judged Suspended in time over its
 * last presences, a fold of a union of seven rules, whose touched groups read that union again at the presences a
 * beacon moved, 23 of its 71.8 KB).
 *
 * The query is the definition's own, read once whatever reads it: every negation and match of one source at one set of
 * fields in one set of directions and depth reads the one query (`memo`), which navigation navigates once and the
 * checker builds once, so a probe's rows read each definition the write moves once, where each was spelled again on
 * every path of arms down to the occurrence, the product of the arms of every definition along it.
 */
const movedOf = (
	definition: Pick<Negation, "source" | "arms">,
	fields: ReadonlyArray<string>,
	directions: NonEmptyReadonlyArray<ProbeSide>,
	relation: string,
	side: ProbeSide,
	depth: number,
	memo: MovedMemo,
	loc: SourceLoc
): ReadonlyArray<Moved> => {
	const key = `${fields.join(",")} ${directions.join("+")} ${String(depth)}`
	const bySource = memo.get(movedKey(definition.source)) ?? new Map<string, ReadonlyArray<Moved>>()
	memo.set(movedKey(definition.source), bySource)
	const known = bySource.get(key)
	if (known !== undefined) {
		return known
	}
	const candidates = directions.flatMap((direction) =>
		relaxedOf(
			definition.arms,
			direction,
			(arm) => fields.map((f) => headOf(arm, f, loc)),
			relation,
			side,
			depth,
			memo,
			loc
		)
	)
	const groups = new Map<string, { fields: ReadonlyArray<string>; rules: Array<InferredRule> }>()
	for (const { arm, candidate: c } of candidates) {
		const bound = fields.flatMap((f) => {
			const mapped = mapLeaves(headOf(arm, f, loc), c.leaves)
			return mapped.kind !== "var" || c.unbound(mapped) ? [] : [[f, mapped] as const]
		})
		const r = {
			fields: bound.map(([f]) => f),
			rule: overRegion(
				c.region,
				ruleDesc(c.vars, c.matches.map(matchDesc), c.where, Object.fromEntries(bound), loc),
				loc
			)
		}
		const k = r.fields.join(",")
		const group = groups.get(k) ?? { fields: r.fields, rules: [] }
		group.rules.push(r.rule)
		groups.set(k, group)
	}
	const moved = [...groups.values()].flatMap((g): ReadonlyArray<Moved> => {
		const [first, ...more] = g.rules
		return first === undefined ? [] : [{ fields: g.fields, query: queryOf([first, ...more], loc) }]
	})
	bySource.set(key, moved)
	return moved
}

/**
 * What a write moves of a definition (Moved) as a probe's region nested `depth` deep: the keys of a touched set, read as
 * a step, and the probe a step of its own reading them through its channels (Region `groups`, its keys held alone), as
 * a write's touched groups are read, so the probe starts from the moved facts and reads the rest of its arm at the keys
 * they bind, never the arm whole.
 */
const movedRegion = (moved: Moved, depth: number): Region => ({
	kind: "groups",
	depth,
	touched: moved.query,
	keys: moved.fields,
	read: { kind: "lost" }
})

/**
 * The candidate of the facts of `arm` a write moves through its negation `n`, by moving `moved` of the negated
 * definition: the arm over the moved facts as its region (`movedRegion`), each variable a field of `n` binds held to it
 * (`held`), its matches read as they stand and its negations as they stand at COMMIT. A field bound to a bare literal is
 * read at every value: the moved facts are those whose standing the write may change, so reading more of them only
 * judges more candidates, each judged as it stands, and no literal stands at a column of a query that reads a delta,
 * whose heading no check of a definition types.
 */
const movedBy = (arm: LiveArm, n: Negation, moved: Moved, depth: number): Candidate => {
	const h = held(
		Object.fromEntries(
			moved.fields.flatMap((f) => {
				const term = n.bindings[f]
				return term === undefined || isBare(term) ? [] : [[f, term] as const]
			})
		),
		movedRegion(moved, depth),
		new Set(),
		arm.matches,
		[],
		arm.where
	)
	return {
		region: h.region,
		vars: arm.vars.filter((v) => !h.replaced.has(v.id)),
		matches: h.kept,
		where: h.where,
		negated: arm.negated.map((m) => ({ ...m, bindings: mapBindings(m.bindings, h.leaves) })),
		leaves: h.leaves,
		unbound: h.unbound
	}
}

/**
 * The candidates of the facts of `arms` a transaction's write of `relation` on `side` moves in `direction` through
 * their negations, each beside its arm: what the write moves of each negated definition the other way (`movedOf`,
 * `turned`), nested a level deeper, as the arm's region (`movedBy`).
 */
const movedCandidates = <A extends LiveArm>(
	arms: ReadonlyArray<A>,
	direction: ProbeSide,
	relation: string,
	side: ProbeSide,
	depth: number,
	memo: MovedMemo,
	loc: SourceLoc
): ReadonlyArray<{ readonly arm: A; readonly candidate: Candidate }> =>
	arms.flatMap((arm) =>
		arm.negated.flatMap((n) =>
			movedOf(
				n,
				Object.keys(n.bindings).toSorted(compareStrings),
				[turned(direction)],
				relation,
				side,
				depth + 1,
				memo,
				loc
			).map((moved) => ({
				arm,
				candidate: movedBy(arm, n, moved, depth)
			}))
		)
	)

/**
 * The candidate of the facts the `at`-th match of `arm` gains by `touch`: the match held to its region, the arm's other
 * matches read as they stand, and its negations as they stand at COMMIT.
 */
const gainedBy = (arm: LiveArm, touched: ArmMatch, at: number, touch: Touch): Candidate => {
	const h = held(
		touched.bindings,
		touch.region,
		new Set(),
		arm.matches.filter((_, j) => j !== at),
		[],
		arm.where
	)
	return {
		region: h.region,
		vars: arm.vars.filter((v) => !h.replaced.has(v.id)),
		matches: h.kept,
		where: h.where,
		negated: arm.negated.map((n) => ({ ...n, bindings: mapBindings(n.bindings, h.leaves) })),
		leaves: h.leaves,
		unbound: h.unbound
	}
}

/** The variable `e` is, if it is a bare one. */
const varOf = (e: InferredExpr | undefined): string | undefined =>
	e?.kind === "var" ? e.var : undefined

/**
 * Whether the added rows of `relation` that `m`, a match of a probed rule's breaking arm `arm`, reads add no fact of the
 * arm that another probe of the rule does not read: a sibling stored match covers it (`covers`) and no match of the arm
 * covers that sibling, so a chain of containments keeps the probe of its last link and a cycle prunes none of its
 * links.
 */
const covered = (
	arm: LiveArm,
	m: ArmMatch,
	relation: string,
	containments: ReadonlyArray<FieldContainment>
): boolean =>
	arm.matches.some(
		(s) =>
			s !== m &&
			s.kind === "stored" &&
			covers(s, m, relation, containments) &&
			!arm.matches.some(
				(t) => t !== s && t.kind === "stored" && covers(t, s, s.relation, containments)
			)
	)

/**
 * Whether the stored match `s` covers `m`'s reads of `relation` (`covered`): a containment over every row of `s`'s
 * relation, s[F] ⊆ R[G] with R `relation` (`containments`, the schema's closed under composition), where each field `m`
 * reads of R is a field of G bound to the variable `s` binds at its pair in F, directly where `m` is R's match, or
 * through the heading of a definition of several rules (DefinedMatch) every arm of which reads R in such matches of its
 * own alone and under no negation, at fields its head delivers at the heading fields `m` binds.
 *
 * Every row of `s`'s relation that is no row the transaction added stood before it, and so did a row of R that agreed
 * with it at G, since every committed state holds the containment: one that agrees, at every field `m` reads of R, with
 * any row of R the transaction added that the fact meets `s`'s row beside. So a fact the arm gains through an added row
 * of R and a row of `s`'s relation that stood was the arm's fact before the transaction, the stood row of R in place of
 * the added one, unless another of its rows is one the transaction added, or one of a relation it negates is one it
 * removed, which that row's own probe reads; and where `s`'s row is one it added, the probe of `s`'s relation's added
 * rows reads the fact. A fact the arm held before held its law then, the same values now.
 */
const covers = (
	s: StoredMatch,
	m: ArmMatch,
	relation: string,
	containments: ReadonlyArray<FieldContainment>
): boolean =>
	containments.some((c) => {
		if (c.from !== s.relation || c.to !== relation || c.selection.length > 0) {
			return false
		}
		/** Whether the field `field` of R, read at the variable `v`, is a field of G at whose pair `s` binds `v`. */
		const pinned = (field: string, v: string | undefined): boolean =>
			v !== undefined && c.pairs.some((p) => p.to === field && varOf(s.bindings[p.from]) === v)
		return readsPinned(m, relation, pinned)
	})

/**
 * Whether every field `m` reads of `relation` is `pinned` at the variable `m`'s arm reads it at (`covers`): `m` being
 * R's stored match, at its own bindings; a definition of several rules, at the heading field each of its arms delivers
 * it at, every match of `relation` in each arm a stored one of it, none under a negation, and no other match of the arm
 * reading it at any depth.
 */
const readsPinned = (
	m: ArmMatch,
	relation: string,
	pinned: (field: string, v: string | undefined) => boolean
): boolean => {
	switch (m.kind) {
		case "stored":
			return (
				m.relation === relation &&
				Object.entries(m.bindings).every(([field, e]) => pinned(field, varOf(e)))
			)
		case "grouped":
			return false
		case "defined":
			return m.arms.every((a) => {
				const outer = (v: string | undefined): ReadonlyArray<string> =>
					Object.entries(a.head).flatMap(([h, e]) => {
						const w = varOf(m.bindings[h])
						return v !== undefined && varOf(e) === v && w !== undefined ? [w] : []
					})
				return (
					!readsAt({ matches: [], negated: a.negated }, "positive")
						.concat(readsAt({ matches: [], negated: a.negated }, "negative"))
						.flatMap(storedOf)
						.some((o) => o.relation === relation) &&
					a.matches.every((o) =>
						o.kind === "stored"
							? o.relation !== relation ||
								Object.entries(o.bindings).every(([field, e]) =>
									outer(varOf(e)).some((w) => pinned(field, w))
								)
							: !everyRead({ matches: [o], negated: [] })
									.flatMap(storedOf)
									.some((r) => r.relation === relation)
					)
				)
			})
	}
}

/**
 * The candidates of the facts of `arms` a transaction's write of `relation` on `side` may add, each beside its arm, of
 * the matches `touching` holds of (every match of a group's body; of a probed rule's breaking side, those no sibling
 * covers, `uncovered`):
 *
 * - by a match that gains facts (Touch `added`): a stored relation's rows added, or an aggregating rule's groups it
 *   touched as they stand (`gainedBy`);
 * - by a negation that no longer blocks them: what the write withdraws of the negated definition (`movedCandidates`).
 */
const gainedOf = <A extends LiveArm>(
	arms: ReadonlyArray<A>,
	relation: string,
	side: ProbeSide,
	depth: number,
	memo: MovedMemo,
	touching: (arm: A, m: ArmMatch) => boolean,
	loc: SourceLoc
): ReadonlyArray<{ readonly arm: A; readonly candidate: Candidate }> => [
	...arms.flatMap((arm) =>
		arm.matches.flatMap((m, at) =>
			(touching(arm, m) ? matchTouches(m, relation, side, depth, memo, loc) : []).flatMap((t) =>
				t.direction === "added"
					? [
							{
								arm,
								candidate: gainedBy(arm, m, at, {
									...t,
									region: definitionsKeyed(arm, t.region, depth, loc)
								})
							}
						]
					: []
			)
		)
	),
	...movedCandidates(arms, "added", relation, side, depth, memo, loc)
]

/**
 * `region` read at its keys alone (Region `groups` `lost`): the groups or the definition's facts at those keys, each
 * other field free, never read again as they stand, which only a reader of the facts themselves needs (`relaxedOf`).
 */
const keyed = (region: Region): Region =>
	region.kind === "groups" ? { ...region, read: { kind: "lost" } } : region

/**
 * `region` as an arm that reads a definition of several rules as it stands (DefinedMatch) reads its rows, nested
 * `depth` deep: a delta's rows as a set of the keys they hold, every field of them, a step the arm reads through
 * channels (Region `groups`), as touched groups are read, so the definition is read at the keys a row binds it at,
 * restricted inside to them (analysis/theory/navigate.ts boundInside), where beside the delta's rows as a join
 * navigation read it whole, every unit's facts, before the delta's first row; any other region, and any region of an
 * arm that reads no such definition, as it is.
 */
const definitionsKeyed = (
	arm: Pick<LiveArm, "matches">,
	region: Region,
	depth: number,
	loc: SourceLoc
): Region =>
	region.kind === "delta" && arm.matches.some((m) => m.kind === "defined")
		? {
				kind: "groups",
				depth,
				touched: queryOf(
					[
						overRegion(
							region,
							ruleDesc(
								[],
								[],
								[],
								Object.fromEntries(region.fields.map((f) => [f, varRef(regionId(f))] as const)),
								loc
							),
							loc
						)
					],
					loc
				),
				keys: region.fields,
				read: { kind: "lost" }
			}
		: region

/**
 * The candidates of the facts of `arms` a transaction's write of `relation` on `side` may move in `direction`, each
 * beside its arm and relaxed (`relaxation`), `seeds` the terms each arm's candidates are judged at:
 *
 * - by a match whose facts move that way (Touch `direction`): a stored relation's rows written on that side, an
 *   aggregating rule's groups it touched, or what it moves of a definition (DefinedMatch). The occurrence is held to
 *   its region at its keys (`keyed`), the matches before it in the arm's relaxation order (`relaxation`, seeded at the
 *   terms) are read as they stand, and those after it are dropped, every term only they bind unbound. Where the facts
 *   are withdrawn, a fact whose rows the transaction removes from several matches is still withdrawn by the first of
 *   them in that order, whose probe reads none of the later ones; where they are added, the facts each candidate holds
 *   are a superset of those its match adds, each of which stands at COMMIT on every match. The arm's negations are
 *   dropped too: a fact the transaction both withdraws and blocks, its row deleted and a row of a negated relation
 *   inserted, is withdrawn by the delete, whose probe reads no insert, where the insert's probe reads the row as it
 *   stands, deleted;
 * - by a negation that moves them that way: what the write moves of the negated definition the other way
 *   (`movedCandidates`), the arm read as it stands.
 *
 * What a containment's target loses is read so (`lostRows`), its rows judged against the target as it stands, as is
 * what a write moves of a definition (`movedOf`) either way, a superset its every reader reads again as it stands.
 */
const relaxedOf = <A extends LiveArm>(
	arms: ReadonlyArray<A>,
	direction: ProbeSide,
	seeds: (arm: A) => ReadonlyArray<InferredExpr>,
	relation: string,
	side: ProbeSide,
	depth: number,
	memo: MovedMemo,
	loc: SourceLoc
): ReadonlyArray<{ readonly arm: A; readonly candidate: Candidate }> => [
	...arms.flatMap((arm) =>
		arm.matches.flatMap((m, at) =>
			matchTouches(m, relation, side, depth, memo, loc).flatMap((t) => {
				if (t.direction !== direction) {
					return []
				}
				const r = relaxation(
					arm.matches,
					seeds(arm).reduce((into, s) => varsOf(s, into), new Set<string>()),
					at
				)
				const h = held(
					m.bindings,
					keyed(definitionsKeyed(arm, t.region, depth, loc)),
					new Set(),
					r.kept,
					r.dropped,
					arm.where
				)
				return [
					{
						arm,
						candidate: {
							region: h.region,
							vars: arm.vars.filter((v) => !h.replaced.has(v.id) && !h.free.has(v.id)),
							matches: h.kept,
							where: h.where,
							negated: [],
							leaves: h.leaves,
							unbound: h.unbound
						}
					}
				]
			})
		)
	),
	...movedCandidates(arms, direction, relation, side, depth, memo, loc)
]

/**
 * The rows of the facts of the rule's breaking side a transaction's write of `relation` on `side` may add (`gainedOf`):
 * each its arm over its candidate, the arm's head and terms read through the candidate's region, its negations among
 * its conditions.
 */
const gainedRows = (
	rule: ProbedRule,
	relation: string,
	side: ProbeSide,
	containments: ReadonlyArray<FieldContainment>,
	memo: MovedMemo,
	loc: SourceLoc
): ReadonlyArray<ProbeRow> =>
	gainedOf(
		breakingArms(rule),
		relation,
		side,
		0,
		memo,
		(arm, m) => side === "removed" || !covered(arm, m, relation, containments),
		loc
	).map(({ arm, candidate: c }) =>
		rowOf(
			rule,
			c.region,
			{
				vars: c.vars,
				matches: c.matches,
				where: c.where,
				negated: c.negated,
				head: mapBindings(arm.head, c.leaves),
				terms: mapNonEmpty(arm.terms, (t) => mapLeaves(t, c.leaves))
			},
			loc
		)
	)

/**
 * The rows of the target tuples of a containment a transaction's write of `relation` on `side` may withdraw (`relaxedOf`,
 * seeded at each target arm's terms): each the source tuples that agree with the candidate on its bound terms, every term its region left unbound a wildcard, a row per arm of the
 * source. The arm's negations are dropped: the meeting part judges each row against the target, so a candidate the
 * dropped matches or negations would have excluded is judged against the target all the same.
 */
const lostRows = (
	rule: Extract<ProbedRule, { readonly kind: "contained" }>,
	relation: string,
	side: ProbeSide,
	memo: MovedMemo,
	loc: SourceLoc
): ReadonlyArray<ProbeRow> =>
	relaxedOf(rule.to.arms, "removed", (arm) => arm.terms, relation, side, 0, memo, loc).flatMap(
		({ arm, candidate: c }) => {
			const mappedTerms = arm.terms.map((t) => mapLeaves(t, c.leaves))
			const bound = mapNonEmpty(arm.terms, (t, i): InferredExpr => {
				const mapped = mappedTerms[i] ?? t
				return c.unbound(mapped) ? varRef(wildcardId(i)) : mapped
			})
			const wilds = mappedTerms.flatMap((t, i) =>
				c.unbound(t) ? [{ id: wildcardId(i), origin: undefined, loc }] : []
			)
			return tuples(rule.from, bound, loc).map((met): ProbeRow => ({
				region: c.region,
				rule: ruleDesc(
					[...c.vars, ...wilds],
					[{ ...met, loc }, ...c.matches.map(matchDesc)],
					c.where,
					termHead(bound),
					loc
				)
			}))
		}
	)

/**
 * The check of a probed rule over every row, the one the migration that adds the rule runs: the judge of the
 * transaction that writes every row into an installation that holds none, whose net write adds every row of each
 * relation and removes none. Each fact of an arm of the breaking side reads a row of every stored relation the arm
 * matches, so the row of the facts one of its matches adds (`gainedBy`), its region every row of that match's
 * relation, holds every fact of the arm: the arm's first match of a stored relation (`stored`), whose rows the probe
 * reads once, each the start of a chain of lookups (analysis/theory/navigate.ts). An arm of closed relations and
 * aggregating rules' groups alone, which reads no stored row of its own, is read as it stands. The judge's other
 * rows add nothing: that transaction removes no row, so it withdraws no target tuple, and the facts' row is met by the
 * target as it stands, blocked wherever its rows block it. One probe of every arm's row (`probeOf`).
 */
export const everyRowProbe = (
	rule: ProbedRule,
	stored: (relation: string) => boolean,
	loc: SourceLoc
): InferredQuery =>
	probeOf(
		rule,
		mapNonEmpty(breakingArms(rule), (arm): ProbeRow => {
			const at = arm.matches.findIndex((m) => m.kind === "stored" && stored(m.relation))
			const anchor = arm.matches[at]
			if (anchor?.kind !== "stored") {
				return rowOf(rule, undefined, arm, loc)
			}
			const c = gainedBy(arm, anchor, at, {
				direction: "added",
				region: {
					kind: "delta",
					side: "added",
					relation: anchor.relation,
					fields: Object.keys(anchor.bindings)
				}
			})
			return rowOf(
				rule,
				c.region,
				{
					vars: c.vars,
					matches: c.matches,
					where: c.where,
					negated: c.negated,
					head: mapBindings(arm.head, c.leaves),
					terms: mapNonEmpty(arm.terms, (t) => mapLeaves(t, c.leaves))
				},
				loc
			)
		}),
		loc
	)

/**
 * The rows of `rule` a transaction's write of `relation` on `side` may break it at, each over its region: the facts of
 * its breaking side the write may add (`gainedRows`) and, of a containment, the target tuples it may withdraw
 * (`lostRows`). On the side of what a transaction adds (delta.added, the images the relation holds at COMMIT that it did
 * not hold before, so a row is read from the net write and never again from its table), the gained first; on the side
 * of what it removes (delta.removed, the rows a DELETE or an UPDATE of a column read found), the lost first. A match
 * of the written relation that a sibling covers through one of the schema's `containments` (`covered`) adds no row:
 * every fact it gains another probe of the rule reads.
 */
const rowsOf = (
	rule: ProbedRule,
	relation: string,
	side: ProbeSide,
	containments: ReadonlyArray<FieldContainment>,
	loc: SourceLoc
): ReadonlyArray<ProbeRow> => {
	const memo: MovedMemo = new Map()
	const gained = gainedRows(rule, relation, side, containments, memo, loc)
	const lost = rule.kind === "contained" ? lostRows(rule, relation, side, memo, loc) : []
	return side === "added" ? [...gained, ...lost] : [...lost, ...gained]
}

/** The rows of `rule` a transaction's write of `relation` on `side` may break it at (`rowsOf`), each over its region. */
export const probeRows = (
	rule: ProbedRule,
	relation: string,
	side: ProbeSide,
	containments: ReadonlyArray<FieldContainment>,
	loc: SourceLoc
): ReadonlyArray<InferredRule> =>
	rowsOf(rule, relation, side, containments, loc).map((row) => overAny(row.region, row.rule, loc))

/**
 * The probe of `rule` over what a transaction wrote of `relation` on `side`, none where the write breaks it at no row:
 * the rule's meeting part over every row the write may break it at (`probeOf`), each row read from the net write's
 * region outward (analysis/theory/navigate.ts), the side its rows meet read by arm (`readAs`): a key's side and a
 * containment's target arm by arm, each negation of the target keyed by the row's terms. `containments` are the
 * schema's, closed under composition (analysis/theory/unit.ts RegionFacts), which every committed state holds.
 */
export const probe = (
	rule: ProbedRule,
	relation: string,
	side: ProbeSide,
	containments: ReadonlyArray<FieldContainment>,
	loc: SourceLoc
): InferredQuery | undefined => {
	const rows = rowsOf(rule, relation, side, containments, loc)
	return isNonEmpty(rows) ? probeOf(rule, rows, loc) : undefined
}

/** The fields of each stored relation's primary key, in key order, by its name; none for a closed relation. */
export type KeysOf = (relation: string) => ReadonlyArray<string> | undefined

/** A stored relation's field as the law model holds it (ir/law.ts LawField), its type and its descriptor; none else. */
export type FieldsOf = (relation: string, field: string) => LawField | undefined

/**
 * `term`, a value of the field `from`, as it stands at the field `to` its equality with `from` binds it to: itself where
 * the two types meet (scalar/compute/types.ts compatible); retyped to `to`'s type where they are two refinements of one
 * base carrier, which the equality proves it lies in (ir/desc.ts RetypeDesc); itself otherwise, which the checker
 * refuses as operands of two types.
 */
const standingAt = (
	term: InferredExpr,
	from: LawField | undefined,
	to: LawField | undefined
): InferredExpr =>
	from === undefined ||
	to === undefined ||
	compatible(from.type, to.type) ||
	!sameCarrier(from.type, to.type)
		? term
		: { kind: "retype", to: to.desc, arg: term }

/**
 * What a probe's guard reads (`probeGuard`): the stored relation `relation` every row of the probe reads as it stands
 * at the unit, its fields `fields` there, and the fields `delta` of the written relation's delta that hold the same unit,
 * position by position.
 */
interface Guard {
	readonly relation: string
	readonly fields: NonEmptyReadonlyArray<string>
	readonly delta: NonEmptyReadonlyArray<string>
}

/**
 * The guard of the probe of `rule` over what a transaction wrote of `relation` on `side` (`probe`): the rows of a stored
 * relation S at the units of that side's delta, a query the judge runs before the probe and the probe only where it
 * finds a row (physical/ddl/rules.ts), so a write whose units hold no row of S neither plans nor runs the probe:
 * PL/pgSQL plans a statement when it first runs it. None where no such S is found.
 *
 * The guard is the probe's own necessary condition. S qualifies where every arm of the rule's breaking side matches S,
 * a relation other than the written one, each binding the same fields of S, `fields`, to variables of its own, the
 * arm's unit (a learner's rows' package and path beside the content they read), and every way the written relation
 * reaches the arm carries that unit to it (`Carry`): each of its matches of the written relation
 * binds the unit at the same fields of it, `delta`, and each definition, group or negation through which the arm reads
 * it binds the unit at heading fields its every arm holds as its own unit in turn. Every row of the probe (`rowsOf`) is
 * then an arm's candidate whose region is some rows of the written side, a delta's rows or what they move of a
 * definition, so its unit is the unit of some row of that side's delta; and it reads every other match of its arm as
 * it stands at COMMIT (`gainedBy`, `movedBy`), S's among them, at that unit, so a unit of the delta that holds no row
 * of S holds no row of the probe. A containment's target loses tuples by rows of the written side too (`lostRows`):
 * each such row reads the source's tuples at the row's terms, so S qualifies there only where the source's unit
 * variables are terms of each of its arms, at positions every arm of the target holds as variables the written
 * relation carries the unit to. A written S is no guard: a row the write adds is a row the probe reads, which the
 * delta holds, not S as it stood. The guard reads S as it stands at COMMIT, a row the same transaction wrote among
 * them.
 *
 * Which S rows can break an arm: only those its match of S reads, and that match binds S's `fields` to the unit
 * variables, so a fact of the arm holds an S row whose `fields` are the fact's unit. And a fact the write may break the
 * rule at is a row of the probe, whose unit is, by the carry, the `delta` fields of a row of the written side: every
 * occurrence of the written relation in the arm, at any depth, binds those variables at those fields, so a row that
 * starts from it holds the written row's values there. An S row of another unit than every written row's is no row
 * of any fact a row of the probe holds. The carry is checked on every way the arm reads the written relation, never
 * on matches that read none of it: a closed relation, a roster's constant rows (qti's kinds and base types beside the
 * content in Human within maximum), holds no stored row a write moves, so no row of the probe starts from it, and its
 * rows, which bind no unit, join a fact at whatever unit the fact's other matches hold, as a definition over other
 * relations does. An arm that reaches the written relation through a match binding the unit's variable to nothing of
 * the written row (Carry `#occurrence` refuses it), or reads S other than at the unit's variables (`armUnit` finds no
 * match), is no guarded arm: no guard stands before its probe (test/pg/laws/rule-guard, Linked). The unit is each field
 * of S whose variable the written relation carries alone, all of them together.
 *
 * The carry is checked on the ways that yield a row of the probe's side, never on the others (Carry `Yields`). A row is
 * a fact the side's write may break the rule at: a breaking arm's fact it adds (`gainedOf`), which an occurrence of the
 * written relation at the side's polarity yields, positive under an even count of negations where the side adds rows,
 * negative where it removes them; or, of a containment, a target's fact it withdraws (`lostRows`, `relaxedOf`), which
 * an occurrence at the other polarity yields; an aggregating rule's groups move both ways for either. An occurrence at
 * the other polarity only moves its arm's facts the other way, into the rule's favour, so no row of this probe starts
 * from it: an S row at the unit it would bind, or at none, breaks nothing the probe judges. qti's ItemSession in
 * Servable reads Node two ways: under one negation at the item's own package (an unresolved processing), and under two
 * at a published template's package, any package. Adding a Node only makes items servable by the second, so the probe
 * of Node's added rows is guarded by ItemSession at the written package; removing one can make an item of another
 * package unservable by it, so the probe of Node's removed rows is not (test/pg/laws/rule-guard, Ready).
 *
 * Which S guards is a cost, never a soundness, choice: the guard is one more statement of each COMMIT that writes the
 * relation, which pays only where a write of it finds no row of S at its units. S guards where its key leads with no
 * field of the unit (`keys`): its rows at a unit are another lifecycle's, a learner's rows keyed by the learner beside
 * the content they read, which a first publish of the content precedes; a relation keyed by a field of the unit holds
 * the unit's own rows, which every write of the unit's other rows accompanies, so its guard would always find a row.
 */
export const probeGuard = (
	rule: ProbedRule,
	relation: string,
	side: ProbeSide,
	keys: KeysOf,
	fieldOf: FieldsOf,
	loc: SourceLoc
): InferredQuery | undefined => {
	const breaking = breakingArms(rule)
	for (const m of breaking[0].matches) {
		if (m.kind !== "stored" || m.relation === relation) {
			continue
		}
		const fields = Object.entries(m.bindings)
			.flatMap(([f, e]) =>
				e.kind === "var" && guardOf(rule, relation, side, m.relation, [f]) !== undefined ? [f] : []
			)
			.toSorted(compareStrings)
		const lead = keys(m.relation)?.[0]
		if (!isNonEmpty(fields) || lead === undefined || fields.includes(lead)) {
			continue
		}
		const guard = guardOf(rule, relation, side, m.relation, fields)
		if (guard !== undefined) {
			const vars = mapNonEmpty(guard.fields, (_, k) => ({ id: guardId(k), origin: undefined, loc }))
			return queryOf(
				[
					ruleDesc(
						vars,
						[
							{
								source: { kind: "delta", side, relation },
								bindings: Object.fromEntries(
									guard.delta.map((f, k) => [f, varRef(guardId(k))] as const)
								),
								loc
							},
							{
								source: { kind: "relation", name: guard.relation },
								bindings: Object.fromEntries(
									guard.fields.map(
										(f, k) =>
											[
												f,
												standingAt(
													varRef(guardId(k)),
													fieldOf(relation, guard.delta[k] ?? f),
													fieldOf(guard.relation, f)
												)
											] as const
									)
								),
								loc
							}
						],
						[],
						Object.fromEntries(guard.fields.map((f, k) => [f, varRef(guardId(k))] as const)),
						loc
					)
				],
				loc
			)
		}
	}
	return undefined
}

/** The variable a probe's guard reads position `k` of the unit in (`probeGuard`). */
const guardId = (k: number): string => `guard.${k}`

/**
 * The guard of `rule`'s probes of `written` on `side` by the stored relation `relation` at its fields `fields`
 * (`probeGuard`): none where some arm of the breaking side does not match it there at its unit, or the written relation
 * does not carry every arm's unit to fields of its own along every way that yields a row of the side (`Carry`), the
 * target's arms' too for a containment: a breaking arm gains facts by its occurrences of the side's polarity, a
 * positive one where the side adds rows and a negative one where it removes them (`gainedOf`), and a target arm loses
 * them by the other (`lostRows`, `relaxedOf`).
 */
const guardOf = (
	rule: ProbedRule,
	written: string,
	side: ProbeSide,
	relation: string,
	fields: NonEmptyReadonlyArray<string>
): Guard | undefined => {
	const carry = new Carry(written, fields.length)
	const gains: Polarity = side === "added" ? "positive" : "negative"
	const breaking = breakingArms(rule)
	const units: Array<ReadonlyMap<string, number>> = []
	for (const arm of breaking) {
		const unit = armUnit(arm, relation, fields)
		if (unit === undefined || !carry.arm(arm, unit, gains)) {
			return undefined
		}
		units.push(unit)
	}
	if (rule.kind === "contained") {
		const positions = fields.map((_, k) => {
			const at = breaking.map((arm, i) =>
				arm.terms.findIndex((t) => t.kind === "var" && units[i]?.get(t.var) === k)
			)
			const [j, ...rest] = at
			return j !== undefined && j >= 0 && rest.every((x) => x === j) ? j : undefined
		})
		for (const arm of rule.to.arms) {
			const unit = new Map<string, number>()
			for (const [k, j] of positions.entries()) {
				const term = j === undefined ? undefined : arm.terms[j]
				if (term?.kind !== "var") {
					return undefined
				}
				unit.set(term.var, k)
			}
			if (unit.size !== fields.length || !carry.arm(arm, unit, flipped(gains))) {
				return undefined
			}
		}
	}
	const delta = carry.fields()
	return delta === undefined ? undefined : { relation, fields, delta }
}

/**
 * The unit of `arm` a match of `relation` at `fields` reads it at: each field's variable, one a position, where `arm`
 * matches `relation` binding every field of `fields` to a variable of its own; none otherwise.
 */
const armUnit = (
	arm: LiveArm,
	relation: string,
	fields: NonEmptyReadonlyArray<string>
): ReadonlyMap<string, number> | undefined => {
	for (const m of arm.matches) {
		if (m.kind !== "stored" || m.relation !== relation) {
			continue
		}
		const unit = new Map<string, number>()
		for (const [k, f] of fields.entries()) {
			const e = m.bindings[f]
			if (e?.kind !== "var" || unit.has(e.var)) {
				break
			}
			unit.set(e.var, k)
		}
		if (unit.size === fields.length) {
			return unit
		}
	}
	return undefined
}

/**
 * The polarity of an occurrence of the written relation, read from the arm it stands in, that yields a row of a probe
 * (`Carry`): one polarity, or either under an aggregating rule's groups, which a write of their body touches both ways
 * (`matchTouches`).
 */
type Yields = Polarity | "both"

/** Whether an occurrence of polarity `p` yields a row where `yields` does. */
const yieldsAt = (yields: Yields, p: Polarity): boolean => yields === "both" || yields === p

/** What a negation turns `yields` into: an occurrence below it moves the negating arm the other way. */
const flippedYields = (yields: Yields): Yields => (yields === "both" ? "both" : flipped(yields))

/**
 * Whether the written relation carries a unit to every way an arm reads it that yields a row of the probe
 * (`probeGuard`), and the fields of it that hold each position of the unit, the same at every such occurrence
 * (`fields`).
 */
class Carry {
	readonly #written: string
	readonly #at: Array<string | undefined>
	/** Whether an arm reads the written relation at a polarity that yields a row, by the arm and the polarity. */
	readonly #reads = new WeakMap<LiveArm, Map<Yields, boolean>>()

	constructor(written: string, width: number) {
		this.#written = written
		this.#at = Array.from({ length: width }, () => undefined)
	}

	/** The written relation's fields that hold each position of the unit, none where it is read nowhere. */
	fields(): NonEmptyReadonlyArray<string> | undefined {
		const [first, ...rest] = this.#at
		if (first === undefined) {
			return undefined
		}
		const out: Array<string> = []
		for (const f of rest) {
			if (f === undefined) {
				return undefined
			}
			out.push(f)
		}
		return [first, ...out]
	}

	/**
	 * Whether every way `arm`, whose variables `unit` hold its unit by position, reads the written relation at a
	 * polarity `yields` admits carries the unit to it: each such match of it binds every position at one field of it,
	 * the field of every other occurrence; each definition, group or negation that reads it so binds every position at
	 * a heading field each of its arms holds as a variable, carried in that arm in turn, a negation's at the polarity
	 * turned. An occurrence of the other polarity moves the arm's facts the other way only, so it yields no row of the
	 * probe and need carry nothing.
	 */
	arm(arm: LiveArm, unit: ReadonlyMap<string, number>, yields: Yields): boolean {
		for (const m of arm.matches) {
			switch (m.kind) {
				case "stored":
					if (
						m.relation === this.#written &&
						yieldsAt(yields, "positive") &&
						!this.#occurrence(m.bindings, unit)
					) {
						return false
					}
					break
				case "defined":
					if (!this.#through(m.bindings, m.arms, unit, yields)) {
						return false
					}
					break
				case "grouped":
					if (!this.#through(m.bindings, m.groups.body, unit, "both")) {
						return false
					}
					break
			}
		}
		return arm.negated.every((n) => this.#through(n.bindings, n.arms, unit, flippedYields(yields)))
	}

	/** Whether an occurrence of the written relation binding `bindings` binds every position of `unit` where the others do. */
	#occurrence(bindings: InferredBindings, unit: ReadonlyMap<string, number>): boolean {
		const at = [...this.#at]
		for (const [f, e] of Object.entries(bindings)) {
			const k = e.kind === "var" ? unit.get(e.var) : undefined
			if (k !== undefined && at[k] === undefined) {
				at[k] = f
			}
		}
		for (const [k, f] of at.entries()) {
			const e = f === undefined ? undefined : bindings[f]
			if (e?.kind !== "var" || unit.get(e.var) !== k) {
				return false
			}
			this.#at[k] = f
		}
		return true
	}

	/**
	 * Whether a definition, group or negation over `arms`, read at `bindings`, carries the unit: it reads the written
	 * relation nowhere, or it binds every position at a heading field each of its arms holds as a variable of its own,
	 * which carries it in that arm.
	 */
	#through(
		bindings: InferredBindings,
		arms: NonEmptyReadonlyArray<LiveArm>,
		unit: ReadonlyMap<string, number>,
		yields: Yields
	): boolean {
		if (!arms.some((a) => this.#readsWritten(a, yields))) {
			return true
		}
		const fields = new Map<string, number>()
		for (const [f, e] of Object.entries(bindings)) {
			const k = e.kind === "var" ? unit.get(e.var) : undefined
			if (k !== undefined && ![...fields.values()].includes(k)) {
				fields.set(f, k)
			}
		}
		if (fields.size !== unit.size) {
			return false
		}
		return arms.every((a) => {
			const inner = new Map<string, number>()
			for (const [f, k] of fields) {
				const head = a.head[f]
				if (head?.kind !== "var" || inner.has(head.var)) {
					return false
				}
				inner.set(head.var, k)
			}
			return this.arm(a, inner, yields)
		})
	}

	/**
	 * Whether `arm` reads the written relation at any depth at a polarity `yields` admits, a match, a definition, a
	 * group or a negation of it.
	 */
	#readsWritten(arm: LiveArm, yields: Yields): boolean {
		const memo = this.#reads.get(arm) ?? new Map<Yields, boolean>()
		this.#reads.set(arm, memo)
		const known = memo.get(yields)
		if (known !== undefined) {
			return known
		}
		memo.set(yields, false)
		const reads =
			arm.matches.some((m) => this.#matchReads(m, yields)) ||
			arm.negated.some((n) => n.arms.some((a) => this.#readsWritten(a, flippedYields(yields))))
		memo.set(yields, reads)
		return reads
	}

	/** Whether match `m` reads the written relation at any depth at a polarity `yields` admits (`#readsWritten`). */
	#matchReads(m: ArmMatch, yields: Yields): boolean {
		switch (m.kind) {
			case "stored":
				return m.relation === this.#written && yieldsAt(yields, "positive")
			case "defined":
				return m.arms.some((a) => this.#readsWritten(a, yields))
			case "grouped":
				return m.groups.body.some((a) => this.#readsWritten(a, "both"))
		}
	}
}

/**
 * A probe's identity up to its variables' names (`probes`): its canonical text, source locations omitted, with every
 * variable renamed `v0`, `v1`, … in the order a walk of it first names one, each record's members in canonical order.
 * The renaming is a bijection of the probe's variables, applied to each declaration (VarDesc `id`) and each reference
 * (a `var` leaf) alike, so two probes have one key exactly when each is the other with its variables renamed: one
 * query, the same rows at every state. Flattening names the variables of each definition it inlines apart, under a
 * prefix of its own (`Flattener`), so the probes of one occurrence reached through two reads of its definition differ
 * in their names alone, and the judge compiles one probe of each key (physical/ddl/rules.ts), where it compiled every
 * one and kept one statement of each canonical text after.
 */
export const probeKey = (row: InferredRule): string => {
	const names = new Map<string, string>()
	const named = (id: string): string => {
		const known = names.get(id)
		if (known !== undefined) {
			return known
		}
		const fresh = `v${names.size}`
		names.set(id, fresh)
		return fresh
	}
	const renamed = (value: unknown): unknown => {
		if (isList(value)) {
			return value.map(renamed)
		}
		if (!isRecord(value)) {
			return value
		}
		const out: Record<string, unknown> = {}
		for (const key of Object.keys(value).toSorted(compareStrings)) {
			const member = value[key]
			const variable =
				typeof member === "string" &&
				((key === "var" && value["kind"] === "var") || (key === "id" && "origin" in value))
			out[key] = variable ? named(member) : renamed(member)
		}
		return out
	}
	const text = encode(renamed(row), withoutSourceLocs)
	if (!text.ok) {
		throw defect(`a probe's canonical text: ${text.error.message}`)
	}
	return text.value
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

/**
 * The columns `relation`'s matches among `reads` read, sorted, each once: of the matches the breaking arms read at one
 * polarity and the target's arms at the other (Polarity), at any depth.
 */
const columnsOf = (
	reads: ReadonlyArray<StoredMatch>,
	relation: string
): ReadonlyArray<string> | undefined => {
	const read = reads.filter((m) => m.relation === relation)
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

/**
 * What writing `relation` can break of a probed rule (`touches`): by adding rows, what the breaking arms read positively
 * and the target's arms negatively; by removing them, what the target's arms read positively and the breaking arms
 * negatively (Polarity); and by either, what an aggregating rule's groups read anywhere (`storedOf`), whose facts any
 * row of their body put or taken replaces.
 */
const probedTouches = (rule: ProbedRule, relation: string): Touches | undefined => {
	const reads = (arms: ReadonlyArray<LiveArm>, polarity: Polarity) =>
		arms.flatMap((a) => readsAt(a, polarity))
	const grouped = groupedAmong([...breakingArms(rule), ...targetArms(rule)].flatMap(everyRead))
	return touchesOf(
		columnsOf(
			[
				...storedAmong([
					...reads(breakingArms(rule), "positive"),
					...reads(targetArms(rule), "negative")
				]),
				...grouped
			],
			relation
		),
		columnsOf(
			[
				...storedAmong([
					...reads(targetArms(rule), "positive"),
					...reads(breakingArms(rule), "negative")
				]),
				...grouped
			],
			relation
		)
	)
}

/**
 * One shape a rule's violation takes, by the stored and closed relations it reads, each occurrence once, in arm order:
 *
 * - `rows`: one row of each, present: the matches of one arm of the breaking side, or of a key, the matches of each of
 *   the two arms its pair of facts comes through, an arm paired with itself listing its matches twice;
 * - `present`: rows it needs present beyond those, any number of each: what a containment's target reads negatively,
 *   each blocking a target tuple the source's fact would meet, and what its breaking arms read positively under two
 *   negations or more, each blocking a fact that would block the breaking fact (Polarity);
 * - `absent`: rows it needs absent: what its breaking arms read negatively, at any depth, and what a containment's
 *   target reads positively, at any depth.
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

/**
 * An arm with each definition it matches (DefinedMatch) read through one of the definition's arms, at any depth: one
 * choice of a rule at every match of a definition, the facts of the arm being those of some choice. Its matches are
 * the arm's own and the chosen arms', in the arm's order, and its negations the arm's own, then the chosen arms'.
 */
interface Alternative extends ArmReads {
	readonly matches: ReadonlyArray<ReadMatch>
}

/**
 * The alternatives of `arm` (Alternative), one for each choice of an arm at every definition it matches, at any depth:
 * a witness is a shape of a violation through one row of each match, so it reads one rule of a union it matches, as an
 * arm the union is distributed into does. Inside a negation no choice is made: no fact of a definition agrees with the
 * negated terms exactly when none of any of its arms does, so a negation reads every arm (`readsAt`).
 */
const alternativesOf = (
	arm: Pick<LiveArm, "matches" | "negated">
): NonEmptyReadonlyArray<Alternative> =>
	arm.matches.reduce<NonEmptyReadonlyArray<Alternative>>(
		(partials, m) =>
			m.kind === "defined"
				? flatMapNonEmpty(partials, (p) =>
						mapNonEmpty(flatMapNonEmpty(m.arms, alternativesOf), (c) => ({
							matches: [...p.matches, ...c.matches],
							negated: [...p.negated, ...c.negated]
						}))
					)
				: mapNonEmpty(partials, (p) => ({ ...p, matches: [...p.matches, m] })),
		[{ matches: [], negated: arm.negated }]
	)

/**
 * The relations of an alternative's matches a witness holds one row of each of, in order, each occurrence once: its
 * stored and closed matches'; one that matches aggregating rules' groups alone, every relation they read (`storedOf`),
 * as a whole rule with no positive occurrence lists every occurrence.
 */
const matched = (matches: ReadonlyArray<ReadMatch>): NonEmptyReadonlyArray<string> => {
	const [first, ...rest] = storedAmong(matches).map((m) => m.relation)
	if (first !== undefined) {
		return [first, ...rest]
	}
	const [one, ...more] = groupedAmong(matches).map((m) => m.relation)
	if (one === undefined) {
		throw defect("an arm's groups read some relation")
	}
	return [one, ...more]
}

/** The relations of the stored matches an arm reads at `polarity`, at any depth, in order, each occurrence once. */
const readAt = (arm: Alternative, polarity: Polarity): ReadonlyArray<string> =>
	storedAmong(readsAt(arm, polarity)).map((m) => m.relation)

/** The relations of the stored matches an arm's negations read at `polarity`, at any depth, in order, each once. */
const negatedAt = (arm: Alternative, polarity: Polarity): ReadonlyArray<string> =>
	storedAmong(negatedReads(arm, polarity)).map((m) => m.relation)

/**
 * The relations the aggregating rules an arm reads at any depth read (`storedOf`), each occurrence once: a witness
 * holds them both present and absent, a fold changed by every row of its group a write puts or takes, as a whole
 * rule's occurrence of both polarities is.
 */
const groupedAt = (arm: Alternative): ReadonlyArray<string> =>
	groupedAmong(everyRead(arm)).map((m) => m.relation)

/**
 * The witnesses of a rule (Witness): one per alternative (`alternativesOf`) of an arm of a check's side and of a
 * containment's source, each beside every alternative of the target, and one per pair of alternatives of a key's side,
 * each with itself and with every one after it.
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
			return mapNonEmpty(flatMapNonEmpty(rule.side.arms, alternativesOf), (arm) => ({
				rows: matched(arm.matches),
				present: [...negatedAt(arm, "positive"), ...groupedAt(arm)],
				absent: [...readAt(arm, "negative"), ...groupedAt(arm)]
			}))
		case "contained": {
			const to = flatMapNonEmpty(rule.to.arms, alternativesOf)
			const grouped = to.flatMap(groupedAt)
			const present = [...to.flatMap((a) => readAt(a, "negative")), ...grouped]
			const target = [...to.flatMap((a) => readAt(a, "positive")), ...grouped]
			return mapNonEmpty(flatMapNonEmpty(rule.from.arms, alternativesOf), (arm) => ({
				rows: matched(arm.matches),
				present: [...present, ...negatedAt(arm, "positive"), ...groupedAt(arm)],
				absent: [...readAt(arm, "negative"), ...groupedAt(arm), ...target]
			}))
		}
		case "key": {
			const arms = flatMapNonEmpty(rule.side.arms, alternativesOf)
			return flatMapNonEmpty(arms, (arm, i) =>
				mapNonEmpty([arm, ...arms.slice(i + 1)], (other) => ({
					rows: extendNonEmpty(matched(arm.matches), matched(other.matches)),
					present: [
						...negatedAt(arm, "positive"),
						...negatedAt(other, "positive"),
						...groupedAt(arm),
						...groupedAt(other)
					],
					absent: [
						...readAt(arm, "negative"),
						...readAt(other, "negative"),
						...groupedAt(arm),
						...groupedAt(other)
					]
				}))
			)
		}
	}
}
