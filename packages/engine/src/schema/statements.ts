import { isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { hasProperties, isList, isPlainRecord } from "#compiler/core/record.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import {
	type ArmDesc,
	builtNode,
	type ContainedDesc,
	candidateKeyFields,
	conjunctsOf,
	everyFact,
	type ExprDesc,
	type FieldDesc,
	type MonoidName,
	monoidNames,
	type SideDesc,
	type SlotsDesc,
	sideOver,
	type StatementDesc,
	type TermDesc,
	termText
} from "#compiler/ir/desc.ts"
import { isNaturalDesc } from "#compiler/scalar/natural.ts"
import {
	builderLoc,
	frozenCopy,
	frozenTuple,
	type HeadingTyping,
	isName,
	malformed,
	orThrow,
	ownedDesc,
	ownedEntry,
	ownValue,
	queryHeadingOf,
	builderRefusal,
	requireName
} from "#compiler/schema/protocol.ts"

import { canonicalStatementOf } from "#compiler/schema/own.ts"
import {
	fieldRoster,
	finOf,
	type NamedRelation,
	namedRelation,
	relationDescOf
} from "#compiler/schema/relation.ts"
import { checkPredicate, derivedRowScalars, rowScalars } from "#compiler/schema/terms.ts"
import type {
	Alternatives,
	AnyTerm,
	Check,
	Containment,
	Counted,
	Fin,
	Fold,
	Key,
	Mirrors,
	MirrorsBase,
	Monoid,
	Mutable,
	Ordered,
	Pred,
	Selection,
	Side,
	Statement,
	Tree
} from "#compiler/types/schema/statements.ts"

/**
 * The admission cores: each checks a JavaScript caller's arguments and returns the Description the statement is owned
 * with, the one path a statement's Description is built by. A statement is built of parts already decoded where they
 * entered (a side by on, a predicate by its check, a name by requireName), which it holds as they are.
 */
const admitted = (desc: StatementDesc): StatementDesc => builtNode(desc)

/**
 * The statement builders.
 *
 * key, mutable and check name one relation or side; on, select and pred build law sides; contained relates two sides;
 * mirrors is sugar for the two containments between its sides; alternatives is one statement, whose containments
 * ir/desc.ts expandAlternatives states; fin names a count's slots, which ordered, counted and tree index a family by,
 * and fold combines a family's members into its owner. Each returns a frozen value with its StatementDesc (or
 * SideDesc, or the ExpansionDesc of the containments mirrors is sugar for)
 * under a non-enumerable `desc`. Only `check` and `contract` take a name, which is their identity; every other
 * statement's SQL identity derives from what it names.
 *
 * Each builder is the one implementation of its value: its admission core first, then the literal of its arguments,
 * frozen copies, owned with the Description, so the value has its public type (types/schema/statements.ts) by
 * construction. Its type parameters are as wide as that value allows; the typed facade (schema/api.ts), the one
 * exporter of the public names, is a view that narrows them to the public signatures.
 *
 * The builders check what a JavaScript caller can get structurally wrong: a field that is not in the heading, pred of a
 * field that is not natural, a side pair of different widths, an arm map over handles the roster lacks. Semantic
 * judgments are ownership's (own.ts), because the same statement can arrive in a description TypeScript never
 * checked: which statements may read a derived relation, and its fields, which its definition infers. A check's and a
 * selection's callback over a derived relation reads its definition's heading as the builder typed it.
 */
export const statementDescOf = (value: unknown): StatementDesc | undefined =>
	ownedDesc(value, "statement")

/**
 * A statement value owned with its Description and its canonical form and text (own.ts CanonicalStatement), which its
 * schema's level content and ownership read it by, computed once, here, where the statement is built.
 */
const ownedStatement = <V extends Exclude<Statement, MirrorsBase>>(
	value: V,
	desc: StatementDesc
): V => ownValue(value, "statement", desc, canonicalStatementOf(desc))

/** A field of a relation whose heading is known, refused when the heading has no field of that name. */
const fieldOf = (
	rel: Exclude<NamedRelation, { readonly kind: "derived" }>,
	field: string,
	label: string
): FieldDesc => {
	const desc = Object.hasOwn(rel.fields, field) ? rel.fields[field] : undefined
	if (desc === undefined) {
		throw malformed(
			label,
			`fields of ${rel.name}; ${JSON.stringify(field)} is not one of its fields`
		)
	}
	return desc
}

/** The heading's field names, refusing a name that is not one where the heading is known. */
const requireFields = (rel: NamedRelation, fields: ReadonlyArray<string>, label: string): void => {
	if (rel.kind === "derived") {
		return
	}
	for (const f of fields) {
		fieldOf(rel, f, label)
	}
}

/** A side as a label spells it: its relation, its terms, and whether it selects. */
const sideLabel = (side: SideDesc): string =>
	`${side.relation}(${side.terms.map(termText).join(", ")})${side.selection.conjuncts.length === 0 ? "" : " selected"}`

export const sideDescOf = (value: unknown): SideDesc | undefined => ownedDesc(value, "side")

const sideOf = (value: unknown, label: string): SideDesc => {
	const desc = sideDescOf(value)
	if (desc === undefined) {
		throw malformed(label, "a law side built by on(...)")
	}
	return desc
}

/** A key statement's side, a SideDesc built by on(...). */
const admitKey = (side: unknown): StatementDesc => {
	const desc = sideOf(side, "key side")
	const label = `key ${sideLabel(desc)}`
	return admitted({
		kind: "key",
		side: desc,
		loc: builderLoc(label, [desc.relation, "key", ...desc.terms.map(termText)])
	})
}

/** key(side): UNIQUE NULLS DISTINCT over the side's terms. The value holds the side it was given. */
export const keyBuilder = <S>(side: S): Key<S> =>
	ownedStatement({ kind: "key", side }, admitKey(side))

/**
 * A Key value that is a candidate key, over a side of a whole relation whose terms are all fields
 * (ir/desc.ts candidateKeyFields): the Key, the relation value its side reads, and the fields. Undefined for any other
 * value, a Key over a selection or a pred term among them, which constrains only the facts its side reads and so names
 * no key of the relation.
 */
export const candidateKeyOf = (
	value: unknown
):
	| {
			readonly key: Key<unknown>
			readonly relation: unknown
			readonly fields: NonEmptyReadonlyArray<string>
	  }
	| undefined => {
	const owned = ownedEntry(value, "statement")
	if (owned?.desc.kind !== "key" || owned.value.kind !== "key") {
		return undefined
	}
	const fields = candidateKeyFields(owned.desc.side)
	const source = ownedEntry(owned.value.side, "side")?.value.source
	return fields === undefined || source === undefined
		? undefined
		: { key: owned.value, relation: source, fields }
}

/**
 * The relation and key fields a key position names: a relation stands for its primary key, a Key value over a whole
 * relation's fields for that candidate key.
 */
const keyRef = (
	value: unknown,
	label: string
): {
	readonly value: unknown
	readonly rel: NamedRelation
	readonly fields: ReadonlyArray<string>
} => {
	if (statementDescOf(value) !== undefined) {
		const keyed = candidateKeyOf(value)
		if (keyed === undefined) {
			throw malformed(label, "a relation or a Key built by key(on(relation, ...fields))")
		}
		return {
			value: keyed.relation,
			rel: namedRelation(keyed.relation, label),
			fields: keyed.fields
		}
	}
	const rel = namedRelation(value, label)
	if (rel.kind === "derived") {
		throw builderRefusal(
			label,
			"alternatives relate stored relations: a derived relation's rows are its definition's, which no write draws"
		)
	}
	return { value, rel, fields: rel.primaryKey }
}

/** The opt-in to in-place change; without it a relation is immutable, which is pinned. */
const admitMutable = (relation: unknown): StatementDesc => {
	const rel = namedRelation(relation, "mutable relation")
	return admitted({
		kind: "mutable",
		relation: rel.name,
		loc: builderLoc(`mutable ${rel.name}`, [rel.name, "mutable"])
	})
}

/**
 * Opt in to in-place change. Without it a relation is immutable: facts are added and deleted, never changed. The
 * default is pinned.
 */
export const mutableBuilder = <R>(relation: R): Mutable<R> =>
	ownedStatement({ kind: "mutable", relation }, admitMutable(relation))

/**
 * The predicate a row callback returns over the row of `relation`, `rel` its name and kind: a check's and a selection's
 * one reading of a row predicate. A stored relation's row is its fields, typed by their descriptors; a derived
 * relation's is its definition's heading, as the builder typed it (terms.ts derivedRowScalars).
 */
const rowPredicate = (
	relation: unknown,
	rel: NamedRelation,
	predicate: unknown,
	label: string,
	what: string
): ExprDesc => {
	if (typeof predicate !== "function") {
		throw malformed(label, `a predicate callback (row) => predicate, ${what}`)
	}
	const row =
		rel.kind === "derived"
			? derivedRowScalars(derivedHeading(relation, label))
			: rowScalars(rel.fields, rel.descriptors, (field) => fieldRoster(rel, field))
	const built: unknown = Reflect.apply(predicate, undefined, [row])
	return checkPredicate(built, label)
}

/** The heading of a derived relation's definition as the builder typed it: a value derived(name, query) made. */
const derivedHeading = (relation: unknown, label: string): ReadonlyMap<string, HeadingTyping> => {
	const heading = hasProperties(relation) ? queryHeadingOf(relation["definition"]) : undefined
	if (heading === undefined) {
		throw malformed(label, "a derived relation built by derived(name, query) over a query value")
	}
	return heading
}

const admitCheck = (name: unknown, relation: unknown, predicate: unknown): StatementDesc => {
	const label = `check ${typeof name === "string" ? name : "?"}`
	const checkName = requireName(name, label, "a check name, the law's identity")
	const rel = namedRelation(relation, `${label} relation`)
	const expr = rowPredicate(relation, rel, predicate, label, "the law every fact keeps")
	return admitted({
		kind: "check",
		name: checkName,
		relation: rel.name,
		predicate: expr,
		loc: builderLoc(label, [rel.name, "check", checkName])
	})
}

/** A row check under its name, the law's identity; the predicate callback is admission's to call and read. */
export const checkBuilder = <const Name extends string, R>(
	name: Name,
	relation: R,
	predicate: unknown
): Check<Name, R> => {
	const desc = admitCheck(name, relation, predicate)
	return ownedStatement({ kind: "check", name, relation }, desc)
}

/** What a selection value is owned with: the relation it selects from and the row predicate that selects. */
export interface SelectedDesc {
	readonly relation: string
	readonly predicate: ExprDesc
}

/** The selection value of `relation`'s facts `predicate` holds of, owned with its Description. */
const selectionOf = <R>(relation: R, desc: SelectedDesc): Selection<R> =>
	ownValue({ relation }, "selection", desc, undefined)

/**
 * select(R, (row) => predicate): the facts of R the predicate holds of, in the row-check language a check is written
 * in. Its callback runs once, here, over R's row, and records the predicate.
 */
export const selectBuilder = <R>(relation: R, predicate: unknown): Selection<R> => {
	const rel = namedRelation(relation, "select relation")
	const label = `select ${rel.name}`
	const expr = rowPredicate(relation, rel, predicate, label, "the facts the side reads")
	return selectionOf(relation, { relation: rel.name, predicate: expr })
}

/** pred(field): a law side's term over a natural field, its value less one, defined only above zero. */
export const predBuilder = <const F extends string>(field: F): Pred<F> => {
	requireName(field, "pred", "a natural field of the side's relation")
	return Object.freeze({ kind: "pred", field })
}

/** A term a caller wrote: a field's name, or a pred(field) value, as data. */
const termOf = (value: unknown, label: string): TermDesc => {
	if (isName(value)) {
		return Object.freeze({ kind: "field", field: value })
	}
	if (hasProperties(value) && value["kind"] === "pred" && isName(value["field"])) {
		return Object.freeze({ kind: "pred", field: value["field"] })
	}
	throw malformed(label, "terms that are field names or pred(field) values")
}

/** A side's terms: nonempty, each a field or pred of one. The side's decoder holds each to once (ir/desc.ts). */
const requireTerms = (value: unknown, label: string): NonEmptyReadonlyArray<TermDesc> => {
	if (!isList(value)) {
		throw malformed(label, "a side naming at least one term")
	}
	const list: ReadonlyArray<unknown> = value
	const terms = list.map((t) => termOf(t, label))
	if (!isNonEmpty(terms)) {
		throw malformed(label, "a side naming at least one term")
	}
	return terms
}

/** Every term's field is in the heading, where it is known, and every pred term's field is natural. */
const requireTermsOf = (
	rel: NamedRelation,
	terms: NonEmptyReadonlyArray<TermDesc>,
	label: string
): void => {
	if (rel.kind === "derived") {
		return
	}
	for (const t of terms) {
		const desc = fieldOf(rel, t.field, label)
		if (t.kind === "pred" && !isNaturalDesc(desc)) {
			throw malformed(
				label,
				`pred of a natural field; ${rel.name}.${t.field} is not natural, and pred reads only a count`
			)
		}
	}
}

/** A law side: a relation, closed relation or selection projected onto terms, in order. */
const admitOn = (source: unknown, terms: unknown): SideDesc => {
	const selected = ownedEntry(source, "selection")
	const rel = namedRelation(selected === undefined ? source : selected.value.relation, "on side")
	const label = `on ${rel.name}`
	const list = requireTerms(terms, label)
	requireTermsOf(rel, list, label)
	const selection =
		selected === undefined
			? everyFact
			: Object.freeze({ conjuncts: Object.freeze(conjunctsOf(selected.desc.predicate)) })
	return orThrow(sideOver(rel.name, list, selection))
}

/**
 * A side reads at least one term of its source, each once (ir/desc.ts SideDesc); the value holds a frozen copy of
 * them, `readonly [...T]`.
 */
export const onBuilder = <R, const T extends ReadonlyArray<AnyTerm>>(
	source: R,
	terms: T
): Side<R, readonly [...T]> => {
	const desc = admitOn(source, terms)
	return ownValue({ source, terms: frozenTuple<T>(terms) }, "side", desc, undefined)
}

const sidePair = (left: unknown, right: unknown, label: string): readonly [SideDesc, SideDesc] => {
	const l = sideOf(left, `${label} left`)
	const r = sideOf(right, `${label} right`)
	if (l.terms.length !== r.terms.length) {
		throw builderRefusal(label, "the sides' field types differ")
	}
	return [l, r]
}

/** The containment of `left` in `right`, two sides of one width, declared at `loc`. */
const containedDesc = (
	left: SideDesc,
	right: SideDesc,
	label: string,
	path: ReadonlyArray<string>
): ContainedDesc => builtNode({ kind: "contained", left, right, loc: builderLoc(label, path) })

const admitContained = (left: unknown, right: unknown): ContainedDesc => {
	const [l, r] = sidePair(left, right, "contained")
	return containedDesc(l, r, `contained ${sideLabel(l)} in ${sideLabel(r)}`, [
		l.relation,
		"contained"
	])
}

export const containedBuilder = <L, R>(left: L, right: R): Containment<L, R> =>
	ownedStatement({ kind: "contained", left, right }, admitContained(left, right))

/** The statements mirrors states, which the schema holds in its place: its two containments. */
export interface ExpansionDesc {
	readonly statements: readonly [ContainedDesc, ContainedDesc]
}

export const expansionDescOf = (value: unknown): ExpansionDesc | undefined =>
	ownedDesc(value, "expansion")

const admitMirrors = (left: unknown, right: unknown): ExpansionDesc => {
	const [l, r] = sidePair(left, right, "mirrors")
	const label = `mirrors ${sideLabel(l)} and ${sideLabel(r)}`
	const path = [l.relation, "mirrors"]
	return Object.freeze({
		statements: Object.freeze([
			containedDesc(l, r, label, path),
			containedDesc(r, l, label, path)
		] as const)
	})
}

/** A mirrors value owned with its two containments and their canonical forms, computed once, here (ownedStatement). */
const ownExpansion = <V extends MirrorsBase>(value: V, expansion: ExpansionDesc): V =>
	ownValue(value, "expansion", expansion, [
		canonicalStatementOf(expansion.statements[0]),
		canonicalStatementOf(expansion.statements[1])
	])

/** mirrors(left, right): sugar for contained(left, right) and contained(right, left), which the schema states. */
export const mirrorsBuilder = <L, R>(left: L, right: R): Mirrors<L, R> =>
	ownExpansion({ kind: "mirrors", left, right }, admitMirrors(left, right))

/**
 * The admission core of alternatives(...): the arguments checked and the statement described.
 *
 * alternatives(parentKey, discriminator, roster, arms) is one statement of a schema (ir/desc.ts expandAlternatives
 * states its containments): its parent's key side, its discriminator, its roster, and per handle with an arm, in roster
 * order, the arm's key side. No statement holds the discriminator to the roster's handles: its closedId type does.
 *
 * The discriminator must be a closedId field of the roster itself: the containments' selections refuse only a handle
 * the roster lacks, so a discriminator over another roster with the same handles would pass them. Each arm is keyed
 * like the parent, refused here rather than by the stated containments, which the caller never wrote; and each is a
 * relation other than the parent, whose own arm, keyed by a key of the parent, would hold every parent at its handle.
 */
const admitAlternatives = (
	parent: unknown,
	discriminator: unknown,
	roster: unknown,
	arms: unknown
): StatementDesc => {
	const parentKey = keyRef(parent, "alternatives parent")
	const parentRel = parentKey.rel
	const label = `alternatives ${parentRel.name}`
	const disc = requireName(discriminator, label, "a discriminator field")
	requireFields(parentRel, [disc], label)
	const rosterDesc = relationDescOf(roster, `${label} roster`)
	if (rosterDesc.kind !== "closed") {
		throw malformed(label, "a roster built by closed(name, handles)")
	}
	const discDesc = parentRel.kind === "derived" ? undefined : parentRel.fields[disc]
	if (
		discDesc !== undefined &&
		!(discDesc.kind === "closedId" && discDesc.roster === rosterDesc.name)
	) {
		throw malformed(
			label,
			`a discriminator that is a closedId(${rosterDesc.name}) field of ${parentRel.name}`
		)
	}
	if (!isPlainRecord(arms)) {
		throw malformed(label, "an arm map from handles to key descriptors")
	}
	if (Object.keys(arms).length === 0) {
		throw builderRefusal(label, "alternatives takes at least one arm")
	}
	for (const h of Object.keys(arms)) {
		if (!rosterDesc.handles.includes(h)) {
			throw builderRefusal(`${label} arm ${h}`, "an arm is keyed by a handle of its roster")
		}
	}
	const armDescs: Array<ArmDesc> = []
	for (const h of rosterDesc.handles) {
		const arm = arms[h]
		if (arm === undefined) {
			continue
		}
		const armKey = keyRef(arm, `${label} arm ${h}`)
		if (armKey.rel.name === parentRel.name) {
			throw builderRefusal(`${label} arm ${h}`, "an arm is a relation other than its parent")
		}
		if (armKey.fields.length !== parentKey.fields.length) {
			throw builderRefusal(`${label} arm ${h}`, "the arm's key does not match the parent key")
		}
		armDescs.push(Object.freeze({ handle: h, arm: admitOn(armKey.value, armKey.fields) }))
	}
	const [first, ...rest] = armDescs
	if (first === undefined) {
		throw builderRefusal(label, "alternatives takes at least one arm")
	}
	const armList: readonly [ArmDesc, ...Array<ArmDesc>] = [first, ...rest]
	Object.freeze(armList)
	return admitted({
		kind: "alternatives",
		parent: admitOn(parentKey.value, parentKey.fields),
		discriminator: disc,
		roster: rosterDesc.name,
		arms: armList,
		loc: builderLoc(label, [parentRel.name, "alternatives", disc])
	})
}

/** The value holds its four inputs, the arm map a frozen copy. */
export const alternativesBuilder = <P, const D extends string, C, Arms extends object>(
	parent: P,
	discriminator: D,
	roster: C,
	arms: Arms
): Alternatives<P, D, C, Arms> => {
	const desc = admitAlternatives(parent, discriminator, roster, arms)
	return ownedStatement(
		{ kind: "alternatives", parent, discriminator, roster, arms: frozenCopy(arms) },
		desc
	)
}

/**
 * fin(O, n): the slots of O's count n, data a family's former or a closed relation's key reads: O an ordinary or a
 * closed relation, and n one of its fields (finOf). Whether n is a count of the right kind is for what reads it to
 * judge: a family's theory, which reads the whole schema, or a closed relation's ownership.
 */
export const finBuilder = <O, const N extends string>(owner: O, count: N): Fin<O, N> => {
	finOf({ kind: "fin", owner, count }, "fin")
	return Object.freeze({ kind: "fin", owner, count })
}

/**
 * A family's slots: a fin value whose owner is an ordinary relation, whose drawn count the family draws. A closed
 * relation's count numbers the slots of a closed relation's key instead.
 */
const slotsOf = (value: unknown, label: string): SlotsDesc => {
	const fin = finOf(value, label)
	if (fin.owner.kind !== "relation") {
		throw builderRefusal(
			label,
			"a family counts by an ordinary relation's drawn count: a closed relation's count numbers the slots of its key"
		)
	}
	return Object.freeze(fin.slots)
}

/**
 * A family's or a tree's member side: a side of an ordinary relation, over every fact. A selection breaks `rule`: a
 * family's member side, or a tree's own shape, on(T, parent, at) over T itself.
 */
const memberSide = (value: unknown, label: string, rule: Refused): SideDesc => {
	const side = sideOf(value, `${label} member`)
	if (side.selection.conjuncts.length > 0) {
		throw builderRefusal(label, rule)
	}
	return side
}

const admitFamily = (
	order: "ordered" | "counted",
	family: unknown,
	slots: unknown
): StatementDesc => {
	const member = memberSide(
		family,
		order,
		"a family's member side is a relation, never a selection: its members are every fact of the relation"
	)
	const slotsDesc = slotsOf(slots, `${order} slots`)
	return admitted({
		kind: "family",
		order,
		member,
		slots: slotsDesc,
		loc: builderLoc(`${order} ${member.relation}`, [member.relation, order, slotsDesc.count])
	})
}

/** ordered(on(F, g…, i), fin(O, n)): the value holds its two inputs. */
export const orderedBuilder = <F, Fi>(family: F, slots: Fi): Ordered<F, Fi> =>
	ownedStatement({ kind: "ordered", family, slots }, admitFamily("ordered", family, slots))

/** counted(on(F, g…), fin(O, n)): the value holds its two inputs. */
export const countedBuilder = <F, Fi>(family: F, slots: Fi): Counted<F, Fi> =>
	ownedStatement({ kind: "counted", family, slots }, admitFamily("counted", family, slots))

/** tree(on(T, "parent", "at"), fin(T, n), { root }): the value holds its inputs, `root` the root field's name. */
export const treeBuilder = <F, Fi, const Root extends string>(
	family: F,
	slots: Fi,
	root: { readonly root: Root }
): Tree<F, Fi, Root> => {
	const member = memberSide(
		family,
		"tree",
		"a tree is a family of T over itself, on(T, parent, at), with drawn start and end"
	)
	const slotsDesc = slotsOf(slots, "tree slots")
	if (!isPlainRecord(root)) {
		throw malformed("tree", "{ root }: the root field each tree's rows share")
	}
	const rootField = requireName(root.root, "tree", "the root field each tree's rows share")
	const desc = admitted({
		kind: "tree",
		member,
		slots: slotsDesc,
		root: rootField,
		loc: builderLoc(`tree ${member.relation}`, [member.relation, "tree"])
	})
	return ownedStatement({ kind: "tree", family, slots, root: root.root }, desc)
}

/** The closed set of monoids, each a frozen value its fold names. */
export const monoids: { readonly [M in MonoidName]: Monoid<M> } = Object.freeze({
	count: Object.freeze({ kind: "monoid", name: "count", planes: 1 }),
	sum: Object.freeze({ kind: "monoid", name: "sum", planes: 1 }),
	or: Object.freeze({ kind: "monoid", name: "or", planes: 1 }),
	twos: Object.freeze({ kind: "monoid", name: "twos", planes: 2 }),
	max: Object.freeze({ kind: "monoid", name: "max", planes: 1 }),
	concat: Object.freeze({ kind: "monoid", name: "concat", planes: 1 })
})

/** The monoid a fold names: one of the closed set's values. */
const monoidOf = (value: unknown, label: string): MonoidName => {
	const name = hasProperties(value) && value["kind"] === "monoid" ? value["name"] : undefined
	const found = monoidNames.find((m) => m === name)
	if (found === undefined) {
		throw malformed(label, `a monoid of the closed set, Monoid.${monoidNames.join(", Monoid.")}`)
	}
	return found
}

/** The slots of the family a fold folds: a family's or a tree's statement value. */
const foldedSlots = (value: unknown, label: string): SlotsDesc => {
	const desc = statementDescOf(value)
	if (desc?.kind !== "family" && desc?.kind !== "tree") {
		throw malformed(label, "a family built by ordered, counted or tree")
	}
	return desc.slots
}

/** fold(family, Monoid.m, step, end): the value holds its four inputs. */
export const foldBuilder = <Fa, M, S, E>(
	family: Fa,
	monoid: M,
	step: S,
	end: E
): Fold<Fa, M, S, E> => {
	const slots = foldedSlots(family, "fold family")
	const name = monoidOf(monoid, "fold monoid")
	const stepSide = sideOf(step, "fold step")
	const endSide = sideOf(end, "fold end")
	const desc = admitted({
		kind: "fold",
		family: slots,
		monoid: name,
		step: stepSide,
		end: endSide,
		loc: builderLoc(`fold ${stepSide.relation}`, [stepSide.relation, "fold", name])
	})
	return ownedStatement({ kind: "fold", family, monoid, step, end }, desc)
}
