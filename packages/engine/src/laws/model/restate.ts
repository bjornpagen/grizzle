import {
	type LawIdentity,
	mentions,
	type ResolvedSelection,
	type TheoryLaw
} from "#compiler/analysis/theory/laws.ts"
import type { SpelledConjunct, Spelling } from "#compiler/analysis/theory/spelling.ts"
import { lawStatement } from "#compiler/analysis/theory/theory.ts"
import { ownedText, withoutSourceLocs } from "#compiler/core/canonical.ts"
import { identifierOf, identity, type LawColumnStatement } from "#compiler/core/identity.ts"
import type { Identifier, LawId } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { ComputeFn, ExprDesc, FieldDesc, LiteralDesc } from "#compiler/ir/desc.ts"
import { identityValueOf, type TypedLiteral } from "#compiler/ir/expr.ts"
import type { LawField, TheoryRelation } from "#compiler/ir/law.ts"
import { rosterOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { LawColumnPlan } from "#compiler/laws/model/plan.ts"
import { canonicalSelection } from "#compiler/schema/own.ts"

/**
 * How the previous snapshot names what the target names, as a draft reads its declarations (deploy/diff/declared.ts):
 * each relation and roster, each field of a relation, and each handle of a roster, by its names in the target, its
 * declared rename undone and an alike spelling the previous snapshot holds read as that spelling; none for a name new
 * to the migration, which the previous snapshot either does not hold or holds for something else, a name a rename took
 * away from it. `handleRenames` holds each roster, by its name in the target, a declaration renames a handle of.
 *
 * A draft restates the target's laws, law columns and drawn fields under it: what a declaration only renames states
 * exactly what the previous snapshot recorded of it, so the migration keeps it, its columns and their values; anything
 * that names something new states something new, which the migration installs and draws again.
 */
export interface PreviousNames {
	readonly relation: (relation: string) => string | undefined
	readonly field: (relation: string, field: string) => string | undefined
	readonly handle: (roster: string, handle: string) => string | undefined
	readonly handleRenames: ReadonlySet<string>
}

/** Each of `xs` mapped by `f`, or none where `f` maps one to none. */
const each = <A, B>(
	xs: ReadonlyArray<A>,
	f: (a: A) => B | undefined
): ReadonlyArray<B> | undefined => {
	const out: Array<B> = []
	for (const x of xs) {
		const y = f(x)
		if (y === undefined) {
			return undefined
		}
		out.push(y)
	}
	return out
}

const eachNonEmpty = <A, B>(
	xs: NonEmptyReadonlyArray<A>,
	f: (a: A) => B | undefined
): NonEmptyReadonlyArray<B> | undefined => {
	const [head, ...tail] = xs
	const first = f(head)
	const rest = each(tail, f)
	return first === undefined || rest === undefined ? undefined : [first, ...rest]
}

/** A typed literal of `type` as the previous snapshot spells it: a handle, or a set's handles, by their previous
 * names, none where one is new; any other literal as it is. */
const restatedLiteral = (
	value: TypedLiteral,
	type: ScalarType,
	names: PreviousNames
): TypedLiteral | undefined => {
	const roster = rosterOf(type)
	if (roster === undefined) {
		return value
	}
	switch (value.kind) {
		case "handle": {
			const handle = names.handle(roster.closed, value.handle)
			return handle === undefined ? undefined : { ...value, handle }
		}
		case "handles": {
			const handles = each(value.handles, (h) => names.handle(roster.closed, h))
			return handles === undefined ? undefined : { ...value, handles }
		}
		case "bool":
		case "int":
		case "text":
		case "numeric":
		case "float":
		case "floatSpecial":
		case "money":
		case "uuid":
		case "date":
		case "span":
		case "vector":
			return value
	}
}

/** What a predicate is restated in: its relation's fields' previous names and the rosters they are over, each by its
 * name in the target, and the roster a contract's VALUE is over. */
interface Scope {
	readonly field: (name: string) => string | undefined
	readonly roster: (name: string) => string | undefined
	readonly value: string | undefined
}

/** The roster a field descriptor's values are handles of, or sets over: a closed id's or a set's, a contract's base's. */
const descRoster = (t: FieldDesc): string | undefined => {
	switch (t.kind) {
		case "closedId":
		case "bits":
			return t.roster
		case "contract":
			return descRoster(t.base)
		case "pg":
		case "numeric":
		case "uuid":
		case "bytes":
		case "text":
		case "span":
		case "vector":
			return undefined
	}
}

/** The compute functions whose value is over the roster of their arguments': a set's union, intersection, difference
 * and singleton, and a closed id's least and greatest. */
const rosterFns: ReadonlySet<ComputeFn> = new Set<ComputeFn>([
	"union",
	"intersection",
	"difference",
	"singleton",
	"least",
	"greatest"
])

/** The roster an expression's value is a handle of or a set over, in the target's names, where its typing says: a
 * field's, a typed literal's, a cast's, a contract's VALUE's, and what a conditional, a guard or a set function
 * yields; none for any other value, and for a closed relation's read, which a draft restates only when no handle is
 * renamed (restatedExpr). */
const rosterIn = (e: ExprDesc, scope: Scope): string | undefined => {
	switch (e.kind) {
		case "field":
			return scope.roster(e.field)
		case "value":
			return scope.value
		case "literal":
			return e.type === undefined ? undefined : descRoster(e.type)
		case "cast":
			return descRoster(e.to)
		case "base":
			return rosterIn(e.arg, scope)
		case "cond":
			return rosterIn(e.onTrue, scope) ?? rosterIn(e.onFalse, scope)
		case "when":
			return rosterIn(e.proved, scope) ?? rosterIn(e.otherwise, scope)
		case "compute":
			return rosterFns.has(e.fn) ? firstRoster(e.args, scope) : undefined
		case "var":
		case "parent":
		case "param":
		case "compare":
		case "between":
		case "in":
		case "and":
		case "or":
		case "not":
		case "allen":
		case "pointIn":
		case "absent":
		case "closedAt":
		case "closedRow":
		case "closedHas":
			return undefined
	}
}

const firstRoster = (es: ReadonlyArray<ExprDesc>, scope: Scope): string | undefined => {
	for (const e of es) {
		const roster = rosterIn(e, scope)
		if (roster !== undefined) {
			return roster
		}
	}
	return undefined
}

/** A description literal of a value of `roster` as the previous snapshot spells it: a handle by its previous name, a
 * set's handles each by theirs, none where one is new; any other literal, and any literal of no roster, as it is. */
const restatedValue = (
	value: LiteralDesc,
	roster: string | undefined,
	names: PreviousNames
): LiteralDesc | undefined => {
	if (roster === undefined) {
		return value
	}
	if (typeof value === "string") {
		return names.handle(roster, value)
	}
	if (typeof value === "object" && "handles" in value) {
		const handles = each(value.handles, (h) => names.handle(roster, h))
		return handles === undefined ? undefined : { handles }
	}
	return value
}

/** A field descriptor as the previous snapshot spells it: each roster by its previous name, a contract's predicate
 * restated over its VALUE (restatedExpr); none where a roster is new. */
const restatedType = (t: FieldDesc, names: PreviousNames): FieldDesc | undefined => {
	switch (t.kind) {
		case "closedId":
		case "bits": {
			const roster = names.relation(t.roster)
			return roster === undefined ? undefined : { ...t, roster }
		}
		case "span": {
			const endpoint = restatedType(t.endpoint, names)
			return endpoint === undefined ? undefined : { ...t, endpoint }
		}
		case "contract": {
			const base = restatedType(t.base, names)
			const scope: Scope = {
				field: () => undefined,
				roster: () => undefined,
				value: descRoster(t.base)
			}
			const predicate =
				t.predicate === undefined ? undefined : restatedExpr(t.predicate, undefined, scope, names)
			return base === undefined || (t.predicate !== undefined && predicate === undefined)
				? undefined
				: { ...t, base, predicate }
		}
		case "pg":
		case "numeric":
		case "uuid":
		case "bytes":
		case "text":
		case "vector":
			return t
	}
}

/**
 * A predicate as the previous snapshot spells it: each field of its relation by its previous name, each roster and
 * closed relation by its previous name, and each literal that meets a closed id or a set as its roster's previous
 * handles, a literal's roster read off what it meets (`expected`, rosterIn), as the checker types it: the other side of
 * a comparison, an IN list's or a range's subject, a conditional's other branch, a set function's other arguments, a
 * cast's target. None where a name it reads is new to the migration; where a declared handle rename meets a closed
 * relation's read, whose fields' rosters the predicate does not state; and for a negation over a source, which no law
 * side's selection states.
 */
const restatedExpr = (
	e: ExprDesc,
	expected: string | undefined,
	scope: Scope,
	names: PreviousNames
): ExprDesc | undefined => {
	const sub = (x: ExprDesc, roster: string | undefined): ExprDesc | undefined =>
		restatedExpr(x, roster, scope, names)
	const own = (x: ExprDesc): ExprDesc | undefined => sub(x, rosterIn(x, scope))
	switch (e.kind) {
		case "field": {
			const previous = scope.field(e.field)
			return previous === undefined ? undefined : { ...e, field: previous }
		}
		case "var":
		case "value":
		case "parent":
		case "param":
			return e
		case "literal": {
			const value = restatedValue(
				e.value,
				(e.type === undefined ? undefined : descRoster(e.type)) ?? expected,
				names
			)
			const type = e.type === undefined ? undefined : restatedType(e.type, names)
			return value === undefined || (e.type !== undefined && type === undefined)
				? undefined
				: { ...e, value, type }
		}
		case "compute": {
			const roster = rosterFns.has(e.fn) ? (expected ?? firstRoster(e.args, scope)) : undefined
			const args =
				e.fn === "subset" || e.fn === "disjoint" || e.fn === "cardinality"
					? each(e.args, (a) => sub(a, firstRoster(e.args, scope)))
					: each(e.args, (a) => (roster === undefined ? own(a) : sub(a, roster)))
			return args === undefined ? undefined : { ...e, args }
		}
		case "cast": {
			const to = restatedType(e.to, names)
			const arg = sub(e.arg, rosterIn(e.arg, scope) ?? descRoster(e.to))
			return to === undefined || arg === undefined ? undefined : { ...e, to, arg }
		}
		case "base": {
			const arg = sub(e.arg, expected ?? rosterIn(e.arg, scope))
			return arg === undefined ? undefined : { ...e, arg }
		}
		case "not": {
			const arg = own(e.arg)
			return arg === undefined ? undefined : { ...e, arg }
		}
		case "in": {
			const roster = rosterIn(e.arg, scope)
			const arg = sub(e.arg, roster)
			const values = each(e.values, (v) => restatedValue(v, roster, names))
			return arg === undefined || values === undefined ? undefined : { ...e, arg, values }
		}
		case "cond": {
			const roster = expected ?? rosterIn(e, scope)
			const pred = own(e.pred)
			const onTrue = sub(e.onTrue, roster)
			const onFalse = sub(e.onFalse, roster)
			return pred === undefined || onTrue === undefined || onFalse === undefined
				? undefined
				: { ...e, pred, onTrue, onFalse }
		}
		case "when": {
			const roster = expected ?? rosterIn(e, scope)
			const subject = own(e.subject)
			const proved = sub(e.proved, roster)
			const otherwise = sub(e.otherwise, roster)
			return subject === undefined || proved === undefined || otherwise === undefined
				? undefined
				: { ...e, subject, proved, otherwise }
		}
		case "compare": {
			const left = sub(e.left, rosterIn(e.right, scope) ?? rosterIn(e.left, scope))
			const right = sub(e.right, rosterIn(e.left, scope) ?? rosterIn(e.right, scope))
			return left === undefined || right === undefined ? undefined : { ...e, left, right }
		}
		case "between": {
			const roster = firstRoster([e.arg, e.low, e.high], scope)
			const arg = sub(e.arg, roster)
			const low = sub(e.low, roster)
			const high = sub(e.high, roster)
			return arg === undefined || low === undefined || high === undefined
				? undefined
				: { ...e, arg, low, high }
		}
		case "and":
		case "or": {
			const args = eachNonEmpty(e.args, own)
			return args === undefined ? undefined : { ...e, args }
		}
		case "allen": {
			const left = own(e.left)
			const right = own(e.right)
			return left === undefined || right === undefined ? undefined : { ...e, left, right }
		}
		case "pointIn": {
			const point = own(e.point)
			const span = own(e.span)
			return point === undefined || span === undefined ? undefined : { ...e, point, span }
		}
		case "closedAt":
		case "closedHas": {
			const args = eachNonEmpty(e.args, own)
			const relation = names.relation(e.relation)
			return args === undefined || relation === undefined || names.handleRenames.size > 0
				? undefined
				: { ...e, relation, args }
		}
		case "closedRow": {
			const args = each(e.args, own)
			const relation = names.relation(e.relation)
			return args === undefined || relation === undefined || names.handleRenames.size > 0
				? undefined
				: { ...e, relation, args }
		}
		case "absent":
			return undefined
	}
}

/**
 * A selection over `relation` as the previous snapshot spells it: each conjunct's predicate restated
 * (restatedExpr), the selection put in canonical form again (schema/own.ts canonicalSelection), since a renamed field
 * or handle may reorder it, and each conjunct with its canonical text and the fields it reads under their previous
 * names. None where a conjunct does not restate.
 */
const restatedConjuncts = (
	relation: TheoryRelation,
	selection: ResolvedSelection,
	names: PreviousNames
): ReadonlyArray<SpelledConjunct> | undefined => {
	const rosters = new Map(relation.fields.map((f) => [f.name, rosterOf(f.type)?.closed] as const))
	const scope: Scope = {
		field: (name) => names.field(relation.name, name),
		roster: (name) => rosters.get(name),
		value: undefined
	}
	const predicates = each(selection.conjuncts, (c) =>
		restatedExpr(c.predicate, undefined, scope, names)
	)
	const previousFields = each(relation.fields, (f) => scope.field(f.name))
	if (predicates === undefined || previousFields === undefined) {
		return undefined
	}
	return canonicalSelection({ conjuncts: predicates }).conjuncts.map((p) => ({
		text: ownedText(p, withoutSourceLocs),
		reads: previousFields.filter((f) => mentions(p, f))
	}))
}

/**
 * The spelling of a statement as the previous snapshot names what it reads (PreviousNames). A name new to the migration
 * has no previous spelling, nor does a selection that does not restate (restatedConjuncts): the spelling then marks
 * itself incomplete, and a statement spelled by it is none the previous snapshot states, which its reader discards.
 */
export class PreviousSpelling implements Spelling {
	readonly #names: PreviousNames
	#complete = true

	constructor(names: PreviousNames) {
		this.#names = names
	}

	/** Whether every name and selection the spelling was asked for has a previous spelling. */
	get complete(): boolean {
		return this.#complete
	}

	#spelled<S extends string>(previous: S | undefined, own: S): S {
		if (previous === undefined) {
			this.#complete = false
			return own
		}
		return previous
	}

	/** A law's identifier as the previous snapshot would have named it (restatedLaw). */
	readonly law = (law: TheoryLaw): Identifier<"law"> =>
		this.#spelled(restatedLaw(law, this.#names), law.id)

	readonly relation = (relation: string): string =>
		this.#spelled(this.#names.relation(relation), relation)

	readonly field = (relation: string, field: string): string =>
		this.#spelled(this.#names.field(relation, field), field)

	readonly conjuncts = (
		relation: TheoryRelation,
		selection: ResolvedSelection
	): ReadonlyArray<SpelledConjunct> => {
		const restated = restatedConjuncts(relation, selection, this.#names)
		if (restated === undefined) {
			this.#complete = false
			return []
		}
		return restated
	}

	readonly literal = (value: TypedLiteral, at: LawField): TypedLiteral => {
		const restated = restatedLiteral(value, at.type, this.#names)
		if (restated === undefined) {
			this.#complete = false
			return value
		}
		return restated
	}
}

/**
 * A law's identifier as the previous snapshot would have named it (PreviousNames): its statement (theory.ts
 * lawStatement) spelled with every relation, field, handle and conjunct it names under its previous name. None where one
 * of them is new to the migration: such a law is new to it.
 */
const restatedLaw = (law: LawIdentity, names: PreviousNames): Identifier<"law"> | undefined => {
	const spelling = new PreviousSpelling(names)
	const statement = lawStatement(law, spelling)
	return spelling.complete ? identifierOf(identity.law(statement)) : undefined
}

/**
 * A law column's statement (model.ts lawColumnIdentity) as `spell` spells it, its laws by `law`: a constant by its
 * target, field and value; a term by its kind, its field and its selection's conjuncts; a drawn column by its family's
 * slots, its family's law and its fold's.
 */
const lawColumnStatement = (
	plan: LawColumnPlan,
	spell: PreviousSpelling,
	law: (id: LawId) => Identifier<"law">
): LawColumnStatement => {
	switch (plan.kind) {
		case "constant":
			return {
				kind: "constant",
				target: spell.relation(plan.target.name),
				field: spell.field(plan.target.name, plan.field.name),
				value: identityValueOf(spell.literal(plan.value, plan.field))
			}
		case "term":
			return {
				kind: "term",
				term: { kind: plan.term.kind, field: spell.field(plan.relation.name, plan.term.field) },
				selection: spell.conjuncts(plan.relation, plan.selection).map((c) => c.text)
			}
		case "drawn":
		case "indexPred": {
			const named = plan.named
			const owner = spell.relation(named.owner)
			const count = spell.field(named.owner, named.count)
			const family = law(named.family)
			switch (named.kind) {
				case "copy":
				case "index":
				case "parentStart":
				case "predecessor":
					return { kind: named.kind, owner, count, family }
				case "before":
				case "after":
					return {
						kind: named.kind,
						owner,
						count,
						family,
						fold: law(named.fold),
						plane: named.plane
					}
			}
		}
	}
}

/**
 * A law column's identifier as the previous snapshot would have named it (PreviousNames): its
 * statement with every relation, field, handle and law it names restated (restatedLaw). A column a declaration only
 * renames is then the very column the previous snapshot holds under that identifier, its values unchanged, so the
 * migration renames it; none where its statement names something new to the migration, a column new to it. `laws` holds
 * every law of the target's theory by its identifier.
 */
export const restatedLawColumn = (
	plan: LawColumnPlan,
	laws: ReadonlyMap<LawId, TheoryLaw>,
	names: PreviousNames
): Identifier<"lawColumn"> | undefined => {
	const spell = new PreviousSpelling(names)
	const law = (id: LawId): Identifier<"law"> => {
		const stated = laws.get(id)
		if (stated === undefined) {
			throw defect(`the law ${id} a drawn column is named by is a law of the theory`)
		}
		return spell.law(stated)
	}
	const statement = lawColumnStatement(plan, spell, law)
	return spell.complete ? identifierOf(identity.lawColumn(statement)) : undefined
}
