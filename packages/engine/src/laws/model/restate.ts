import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import {
	type LawIdentity,
	mentions,
	type ResolvedSelection,
	type TheoryLaw
} from "#compiler/analysis/theory/laws.ts"
import type { LawSide } from "#compiler/analysis/theory/query.ts"
import type { SpelledConjunct, Spelling } from "#compiler/analysis/theory/spelling.ts"
import { lawStatement } from "#compiler/analysis/theory/theory.ts"
import { ownedText, withoutSourceLocs } from "#compiler/core/canonical.ts"
import { identifierOf, identity, type LawColumnStatement } from "#compiler/core/identity.ts"
import type { Identifier, LawId } from "#compiler/core/ids.ts"
import {
	type ComputeFn,
	decodeDesc,
	type ExprDesc,
	type FieldDesc,
	type LiteralDesc
} from "#compiler/ir/desc.ts"
import { identityValueOf, type TypedLiteral } from "#compiler/ir/expr.ts"
import type { LawField, TheoryRelation } from "#compiler/ir/law.ts"
import { rosterOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { LawColumnPlan } from "#compiler/laws/model/plan.ts"
import { languagePattern, predicateSource } from "#compiler/scalar/compute/predicate-source.ts"
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
	/** Whether the previous snapshot states the law of an identifier. */
	readonly stated: (law: Identifier<"law">) => boolean
}

/** The target theory's relations by name, whose closed relations type the reads a selection makes of them. */
type Relations = Readonly<Record<string, TheoryRelation>>

/** Each of `xs` mapped by `f`, or none where `f` maps one to none. */
const each = <A, B>(
	xs: ReadonlyArray<A>,
	f: (a: A, at: number) => B | undefined
): ReadonlyArray<B> | undefined => {
	const out: Array<B> = []
	for (const [at, x] of xs.entries()) {
		const y = f(x, at)
		if (y === undefined) {
			return undefined
		}
		out.push(y)
	}
	return out
}

const eachNonEmpty = <A, B>(
	xs: NonEmptyReadonlyArray<A>,
	f: (a: A, at: number) => B | undefined
): NonEmptyReadonlyArray<B> | undefined => {
	const [head, ...tail] = xs
	const first = f(head, 0)
	const rest = each(tail, (a, at) => f(a, at + 1))
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
		case "sha256":
		case "date":
		case "inet":
		case "cidr":
		case "span":
		case "vector":
		case "pattern":
			return value
	}
}

/** What a predicate is restated in: its relation's fields' previous names and the rosters they are over, each by its
 * name in the target, the roster a contract's VALUE is over, and the target's closed relations, whose fields type the
 * terms a closed read meets and yields. */
interface Scope {
	readonly field: (name: string) => string | undefined
	readonly roster: (name: string) => string | undefined
	readonly value: string | undefined
	readonly closed: (relation: string) => TheoryRelation | undefined
}

/** The roster a field's values are handles of or sets over, by its handle. */
const fieldRoster = (field: LawField | undefined): string | undefined =>
	field === undefined ? undefined : rosterOf(field.type)?.closed

/** The roster of the `at`th key field of a closed relation, which the `at`th term of a read of it meets. */
const keyRoster = (relation: TheoryRelation, at: number): string | undefined =>
	fieldRoster(relation.primaryFields[at])

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
		case "exact":
		case "computedNumeric":
		case "uuid":
		case "bytes":
		case "sha256":
		case "text":
		case "pattern":
		case "span":
		case "vector":
		case "search":
		case "variant":
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
 * field's, a typed literal's, a cast's, a contract's VALUE's, a closed relation's field a read yields or the set of its
 * last key field a row read yields, and what a conditional, a guard or a set function yields; none for any other
 * value. */
const rosterIn = (e: ExprDesc, scope: Scope): string | undefined => {
	switch (e.kind) {
		case "field":
			return scope.roster(e.field)
		case "value":
			return scope.value
		case "literal":
			return e.type === undefined ? undefined : descRoster(e.type)
		case "cast":
		case "retype":
			return descRoster(e.to)
		case "guarded":
		case "base":
			return rosterIn(e.arg, scope)
		case "cond":
			return rosterIn(e.onTrue, scope) ?? rosterIn(e.onFalse, scope)
		case "when":
			return rosterIn(e.proved, scope) ?? rosterIn(e.otherwise, scope)
		case "compute":
			return rosterFns.has(e.fn) ? firstRoster(e.args, scope) : undefined
		case "variant":
			return undefined
		case "closedAt":
			return fieldRoster(scope.closed(e.relation)?.fields.find((f) => f.name === e.field))
		case "closedRow": {
			const closed = scope.closed(e.relation)
			return closed === undefined ? undefined : keyRoster(closed, e.args.length)
		}
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
		case "exists":
		case "closedHas":
		case "call":
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

/** A field descriptor as the previous snapshot spells it: each roster by its previous name, a variant's arms by their
 * handles' previous names, a contract's predicate restated over its VALUE (restatedExpr); none where a roster or a
 * handle is new. */
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
				value: descRoster(t.base),
				closed: () => undefined
			}
			const predicate =
				t.predicate === undefined ? undefined : restatedExpr(t.predicate, undefined, scope, names)
			return base === undefined || (t.predicate !== undefined && predicate === undefined)
				? undefined
				: { ...t, base, predicate }
		}
		case "variant": {
			const roster = names.relation(t.roster)
			const arms = each(t.arms, (arm) => {
				const handle = names.handle(t.roster, arm.handle)
				const fields = each(arm.fields, (f) => {
					const desc = restatedType(f.desc, names)
					return desc === undefined ? undefined : { name: f.name, desc }
				})
				const check =
					arm.check === undefined
						? undefined
						: restatedArms(arm.check, (h) => names.handle(t.roster, h))
				return handle === undefined ||
					fields === undefined ||
					(arm.check !== undefined && check === undefined)
					? undefined
					: { handle, fields, check }
			})
			return roster === undefined || arms === undefined ? undefined : { ...t, roster, arms }
		}
		case "pg":
		case "numeric":
		case "exact":
		case "computedNumeric":
		case "uuid":
		case "bytes":
		case "sha256":
		case "text":
		case "pattern":
		case "vector":
		case "search":
			return t
	}
}

/**
 * A predicate as the previous snapshot spells it: each field of its relation by its previous name, each roster and
 * closed relation by its previous name, and each literal that meets a closed id or a set as its roster's previous
 * handles, a literal's roster read off what it meets (`expected`, rosterIn), as the checker types it: the other side of
 * a comparison, an IN list's or a range's subject, a conditional's other branch, a set function's other arguments, a
 * cast's target, the key field of a closed relation a read's term meets. None where a name it reads is new to the
 * migration, and for a negation over a source, which no law side's selection states.
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
			if (value === undefined) {
				return undefined
			}
			if (e.type === undefined) {
				return { ...e, value }
			}
			const type = restatedType(e.type, names)
			return type === undefined ? undefined : { ...e, value, type }
		}
		case "variant": {
			const args = each(e.args, own)
			if (args === undefined) {
				return undefined
			}
			if (e.op.kind !== "make") {
				return { ...e, args }
			}
			const variant = restatedType(e.op.variant, names)
			const handle =
				e.op.variant.kind === "variant" ? names.handle(e.op.variant.roster, e.op.handle) : undefined
			return variant === undefined || handle === undefined
				? undefined
				: { ...e, op: { ...e.op, variant, handle }, args }
		}
		case "compute": {
			const roster = rosterFns.has(e.fn) ? (expected ?? firstRoster(e.args, scope)) : undefined
			const args =
				e.fn === "subset" || e.fn === "disjoint" || e.fn === "cardinality"
					? each(e.args, (a) => sub(a, firstRoster(e.args, scope)))
					: each(e.args, (a) => (roster === undefined ? own(a) : sub(a, roster)))
			return args === undefined ? undefined : { ...e, args }
		}
		case "cast":
		case "retype": {
			const to = restatedType(e.to, names)
			const arg = sub(e.arg, rosterIn(e.arg, scope) ?? descRoster(e.to))
			return to === undefined || arg === undefined ? undefined : { ...e, to, arg }
		}
		case "guarded":
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
		case "closedAt": {
			const closed = scope.closed(e.relation)
			const relation = names.relation(e.relation)
			const field = names.field(e.relation, e.field)
			const args =
				closed === undefined
					? undefined
					: eachNonEmpty(e.args, (a, at) => sub(a, keyRoster(closed, at)))
			return args === undefined || relation === undefined || field === undefined
				? undefined
				: { ...e, relation, field, args }
		}
		case "closedHas": {
			const closed = scope.closed(e.relation)
			const relation = names.relation(e.relation)
			const args =
				closed === undefined
					? undefined
					: eachNonEmpty(e.args, (a, at) => sub(a, keyRoster(closed, at)))
			return args === undefined || relation === undefined ? undefined : { ...e, relation, args }
		}
		case "closedRow": {
			const closed = scope.closed(e.relation)
			const relation = names.relation(e.relation)
			const args =
				closed === undefined ? undefined : each(e.args, (a, at) => sub(a, keyRoster(closed, at)))
			return args === undefined || relation === undefined ? undefined : { ...e, relation, args }
		}
		case "call": {
			const args = each(Object.entries(e.args), ([name, a]) => {
				const term = own(a)
				return term === undefined ? undefined : ([name, term] as const)
			})
			return args === undefined ? undefined : { ...e, args: Object.fromEntries(args) }
		}
		case "absent":
		case "exists":
			return undefined
	}
}

/**
 * A selection over `relation` as the previous snapshot spells it: each conjunct's predicate restated
 * (restatedExpr), the selection put in canonical form again (schema/own.ts canonicalSelection), since a renamed field
 * or handle may reorder it, and each conjunct with its canonical text and the fields it reads under their previous
 * names, in the relation's field order. None where a conjunct does not restate: one that reads a field new to the
 * migration. A field new to the migration that no conjunct reads is no part of the selection, so a field added to the
 * relation leaves every selection over it, and every law and law column it names, as the previous snapshot spelled it.
 */
const restatedConjuncts = (
	relation: TheoryRelation,
	selection: ResolvedSelection,
	names: PreviousNames,
	relations: Relations
): ReadonlyArray<SpelledConjunct> | undefined => {
	const rosters = new Map(relation.fields.map((f) => [f.name, fieldRoster(f)] as const))
	const restated = restatedSelection(
		relation.name,
		(name) => rosters.get(name),
		selection.conjuncts.map((c) => c.predicate),
		names,
		relations
	)
	if (restated === undefined) {
		return undefined
	}
	const previousFields = relation.fields.flatMap((f) => {
		const was = names.field(relation.name, f.name)
		return was === undefined ? [] : [was]
	})
	return restated.map((p) => ({
		text: ownedText(p, withoutSourceLocs),
		display: predicateSource(p, (f) => f, languagePattern),
		reads: previousFields.filter((f) => mentions(p, f))
	}))
}

/**
 * A side of a rule over a query's conjuncts (analysis/theory/query.ts LawSide) as the previous snapshot spells them,
 * its selection restated as a stored relation's is (restatedSelection): its relation's fields' rosters where it is a
 * stored relation, and none for a derived relation's head, whose handles a declaration renames nowhere. None where a
 * conjunct does not restate.
 */
const restatedSideSelection = (
	side: LawSide,
	names: PreviousNames,
	relations: Relations
): ReadonlyArray<ExprDesc> | undefined => {
	const stored = relations[side.relation]
	const rosters = new Map(
		stored === undefined ? [] : stored.fields.map((f) => [f.name, fieldRoster(f)] as const)
	)
	return restatedSelection(
		side.relation,
		(name) => rosters.get(name),
		side.selection.conjuncts,
		names,
		relations
	)
}

/**
 * A selection's conjuncts over the relation named `relation` as the previous snapshot spells them: each predicate
 * restated under the previous snapshot's names (restatedExpr), its literals typed by `rosters`, the selection put in
 * canonical form again (schema/own.ts canonicalSelection), since a renamed field or handle may reorder it: the
 * previous snapshot records every selection in that one canonical form, so the selection it states is this one. None
 * where a conjunct does not restate.
 */
const restatedSelection = (
	relation: string,
	rosters: (field: string) => string | undefined,
	predicates: ReadonlyArray<ExprDesc>,
	names: PreviousNames,
	relations: Relations
): ReadonlyArray<ExprDesc> | undefined => {
	const scope: Scope = {
		field: (name) => names.field(relation, name),
		roster: rosters,
		value: undefined,
		closed: (name) => {
			const r = relations[name]
			return r?.kind === "closed" ? r : undefined
		}
	}
	const restated = each(predicates, (p) => restatedExpr(p, undefined, scope, names))
	if (restated === undefined) {
		return undefined
	}
	return canonicalSelection({ conjuncts: restated }).conjuncts
}

/** A spelling of a statement as the previous snapshot names what it reads (PreviousSpelling), as its readers take it:
 * whether it spelled every name, and each law it names by the identifier the previous snapshot states it under. */
export interface RestatingSpelling extends Spelling {
	readonly complete: boolean
	readonly law: (law: TheoryLaw) => Identifier<"law">
}

/**
 * The spelling of a statement as the previous snapshot names what it reads (PreviousNames). A name new to the migration
 * has no previous spelling, nor does a selection that does not restate (restatedConjuncts): the spelling then marks
 * itself incomplete, and a statement spelled by it is none the previous snapshot states, which its reader discards.
 */
class PreviousSpelling implements RestatingSpelling {
	readonly #names: PreviousNames
	readonly #relations: Relations
	#complete = true

	constructor(names: PreviousNames, relations: Relations) {
		this.#names = names
		this.#relations = relations
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
		this.#spelled(restatedLaw(law, this.#names, this.#relations), law.id)

	readonly relation = (relation: string): string =>
		this.#spelled(this.#names.relation(relation), relation)

	readonly field = (relation: string, field: string): string =>
		this.#spelled(this.#names.field(relation, field), field)

	readonly conjuncts = (
		relation: TheoryRelation,
		selection: ResolvedSelection
	): ReadonlyArray<SpelledConjunct> => {
		const restated = restatedConjuncts(relation, selection, this.#names, this.#relations)
		if (restated === undefined) {
			this.#complete = false
			return []
		}
		return restated
	}

	readonly texts = (side: LawSide): ReadonlyArray<string> => {
		const restated = restatedSideSelection(side, this.#names, this.#relations)
		if (restated === undefined) {
			this.#complete = false
			return side.texts
		}
		return restated.map((p) => ownedText(p, withoutSourceLocs))
	}

	readonly displays = (side: LawSide): ReadonlyArray<string> => {
		const restated = restatedSideSelection(side, this.#names, this.#relations)
		if (restated === undefined) {
			this.#complete = false
			return side.selection.conjuncts.map((p) => predicateSource(p, (f) => f, languagePattern))
		}
		return restated.map((p) => predicateSource(p, (f) => f, languagePattern))
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
 * What `restate` makes of the target's statements as the previous snapshot spells them (PreviousSpelling); none where
 * the spelling meets a name new to the migration.
 */
export const restatedBy = <A>(
	names: PreviousNames,
	relations: Relations,
	restate: (spell: RestatingSpelling) => A | undefined
): A | undefined => {
	const spell = new PreviousSpelling(names, relations)
	const a = restate(spell)
	return spell.complete ? a : undefined
}

/**
 * A law's identifier as the previous snapshot would have named it (PreviousNames): its statement (theory.ts
 * lawStatement) spelled with every relation, field, handle and conjunct it names under its previous name, the one it
 * states (PreviousNames.stated). None where one of them is new to the migration: such a law is new to it.
 */
export const restatedLaw = (
	law: LawIdentity,
	names: PreviousNames,
	relations: Relations
): Identifier<"law"> | undefined =>
	restatedBy(names, relations, (spell) => identifierOf(identity.law(lawStatement(law, spell))))

/**
 * A law column's statement (model.ts lawColumnIdentity) as `spell` spells it, its laws by `law`: a constant by its
 * target, field and value; a term by its kind, its field and its selection's conjuncts; a drawn column by its family's
 * slots, its family's law and its fold's.
 */
const lawColumnStatement = (
	plan: LawColumnPlan,
	spell: RestatingSpelling,
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
		case "term": {
			const conjuncts = spell.conjuncts(plan.relation, plan.selection)
			return {
				kind: "term",
				term: { kind: plan.term.kind, field: spell.field(plan.relation.name, plan.term.field) },
				selection: conjuncts.map((c) => c.text),
				displays: conjuncts.map((c) => c.display)
			}
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
 * A law column's identifier as the previous snapshot would have named it (PreviousNames): its statement with every
 * relation, field, handle and law it names restated (restatedLaw). A column a declaration only renames is then the very
 * column the
 * previous snapshot holds under that identifier, its values unchanged, so the migration renames it; none where its
 * statement names something new to the migration, a column new to it. `laws` holds every law of the target's theory by
 * its identifier, and `relations` its relations by name.
 */
export const restatedLawColumn = (
	plan: LawColumnPlan,
	laws: ReadonlyMap<LawId, TheoryLaw>,
	names: PreviousNames,
	relations: Relations
): Identifier<"lawColumn"> | undefined =>
	restatedBy(names, relations, (spell) => {
		const law = (id: LawId): Identifier<"law"> => {
			const stated = laws.get(id)
			if (stated === undefined) {
				defect(`the law ${id} a drawn column is named by is a law of the theory`)
			}
			return spell.law(stated)
		}
		return identifierOf(identity.lawColumn(lawColumnStatement(plan, spell, law)))
	})

/**
 * An arm's check (ir/desc.ts VariantArmDesc `check`) under the history's handle renames: each of its variant's
 * operations naming an arm by its handle names it by the handle it is renamed to, `handle`'s, or by its own where
 * none renames it. A check is plain data, its operations nested at any depth.
 */
const restatedArms = (
	check: ExprDesc,
	handle: (h: string) => string | undefined
): ExprDesc | undefined => {
	const walk = (x: unknown): unknown => {
		if (Array.isArray(x)) {
			return x.map(walk)
		}
		if (typeof x !== "object" || x === null) {
			return x
		}
		const out: Record<string, unknown> = {}
		for (const [key, value] of Object.entries(x)) {
			out[key] = walk(value)
		}
		const op = out["op"]
		if (out["kind"] === "variant" && typeof op === "object" && op !== null && "handle" in op) {
			const own = Reflect.get(op, "handle")
			out["op"] = { ...op, handle: typeof own === "string" ? (handle(own) ?? own) : own }
		}
		return Object.freeze(out)
	}
	const restated = decodeDesc("expr", walk(check))
	return restated.ok ? restated.value : undefined
}
