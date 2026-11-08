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
import type { ExprDesc, FieldDesc, LiteralDesc } from "#compiler/ir/desc.ts"
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

/** Whether a declared rename renames a handle of the roster a type is over. */
const handlesMoved = (names: PreviousNames, type: ScalarType): boolean => {
	const roster = rosterOf(type)
	return roster !== undefined && names.handleRenames.has(roster.closed)
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

/** A field descriptor as the previous snapshot spells it, each roster by its previous name; none for a contract's
 * when a declared rename renames handles, since its predicate may name one. */
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
			if (names.handleRenames.size > 0) {
				return undefined
			}
			const base = restatedType(t.base, names)
			const predicate =
				t.predicate === undefined ? undefined : restatedExpr(t.predicate, () => undefined, names)
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

/** Whether a literal may spell a handle a declared rename renames: a set of handles, or a literal typed over a roster
 * whose handles a declaration renames. */
const literalMoved = (
	value: LiteralDesc,
	type: FieldDesc | undefined,
	names: PreviousNames
): boolean =>
	names.handleRenames.size > 0 &&
	((typeof value === "object" && "handles" in value) ||
		((type?.kind === "closedId" || type?.kind === "bits") && names.handleRenames.has(type.roster)))

/**
 * A selection's predicate as the previous snapshot spells it: each field of its relation by `field`, each roster and
 * closed relation by its previous name. None where a declared handle rename may reach it (a literal over a roster whose
 * handles move, a read of a closed relation, a contract's predicate), and for a negation over a source, which no law
 * side's selection states.
 */
const restatedExpr = (
	e: ExprDesc,
	field: (name: string) => string | undefined,
	names: PreviousNames
): ExprDesc | undefined => {
	const sub = (x: ExprDesc): ExprDesc | undefined => restatedExpr(x, field, names)
	switch (e.kind) {
		case "field": {
			const previous = field(e.field)
			return previous === undefined ? undefined : { ...e, field: previous }
		}
		case "var":
		case "value":
		case "parent":
		case "param":
			return e
		case "literal": {
			if (literalMoved(e.value, e.type, names)) {
				return undefined
			}
			const type = e.type === undefined ? undefined : restatedType(e.type, names)
			return e.type !== undefined && type === undefined ? undefined : { ...e, type }
		}
		case "compute": {
			const args = each(e.args, sub)
			return args === undefined ? undefined : { ...e, args }
		}
		case "cast": {
			const to = restatedType(e.to, names)
			const arg = sub(e.arg)
			return to === undefined || arg === undefined ? undefined : { ...e, to, arg }
		}
		case "base":
		case "not": {
			const arg = sub(e.arg)
			return arg === undefined ? undefined : { ...e, arg }
		}
		case "in": {
			const arg = sub(e.arg)
			return arg === undefined || e.values.some((v) => literalMoved(v, undefined, names))
				? undefined
				: { ...e, arg }
		}
		case "cond": {
			const pred = sub(e.pred)
			const onTrue = sub(e.onTrue)
			const onFalse = sub(e.onFalse)
			return pred === undefined || onTrue === undefined || onFalse === undefined
				? undefined
				: { ...e, pred, onTrue, onFalse }
		}
		case "when": {
			const subject = sub(e.subject)
			const proved = sub(e.proved)
			const otherwise = sub(e.otherwise)
			return subject === undefined || proved === undefined || otherwise === undefined
				? undefined
				: { ...e, subject, proved, otherwise }
		}
		case "compare": {
			const left = sub(e.left)
			const right = sub(e.right)
			return left === undefined || right === undefined ? undefined : { ...e, left, right }
		}
		case "between": {
			const arg = sub(e.arg)
			const low = sub(e.low)
			const high = sub(e.high)
			return arg === undefined || low === undefined || high === undefined
				? undefined
				: { ...e, arg, low, high }
		}
		case "and":
		case "or": {
			const args = eachNonEmpty(e.args, sub)
			return args === undefined ? undefined : { ...e, args }
		}
		case "allen": {
			const left = sub(e.left)
			const right = sub(e.right)
			return left === undefined || right === undefined ? undefined : { ...e, left, right }
		}
		case "pointIn": {
			const point = sub(e.point)
			const span = sub(e.span)
			return point === undefined || span === undefined ? undefined : { ...e, point, span }
		}
		case "closedAt":
		case "closedHas": {
			const args = eachNonEmpty(e.args, sub)
			const relation = names.relation(e.relation)
			return args === undefined || relation === undefined || names.handleRenames.size > 0
				? undefined
				: { ...e, relation, args }
		}
		case "closedRow": {
			const args = each(e.args, sub)
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
 * may reorder it, and each conjunct with its canonical text and the fields it reads under their previous names. None
 * where a conjunct reads a field over a roster whose handles a declaration renames, or a predicate does not restate.
 */
const restatedConjuncts = (
	relation: TheoryRelation,
	selection: ResolvedSelection,
	names: PreviousNames
): ReadonlyArray<SpelledConjunct> | undefined => {
	if (selection.conjuncts.some((c) => c.reads.some((f: LawField) => handlesMoved(names, f.type)))) {
		return undefined
	}
	const field = (name: string): string | undefined => names.field(relation.name, name)
	const predicates = each(selection.conjuncts, (c) => restatedExpr(c.predicate, field, names))
	const previousFields = each(relation.fields, (f) => field(f.name))
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
