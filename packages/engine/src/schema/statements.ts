import { isNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { hasProperties, isList, isPlainRecord } from "#compiler/core/record.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import {
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
	termText,
	type UnitFieldDesc
} from "#compiler/ir/desc.ts"
import { isDrawnType, isNaturalDesc } from "#compiler/scalar/natural.ts"
import { descCapabilities } from "#compiler/scalar/registry.ts"
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
	ownedKind,
	ownValue,
	queryHeadingOf,
	builderRefusal,
	requireName,
	requireNames
} from "#compiler/schema/protocol.ts"

import { canonicalStatementOf } from "#compiler/schema/own.ts"
import {
	fieldRoster,
	finOf,
	type NamedRelation,
	namedRelation,
	valueTypeOf
} from "#compiler/schema/relation.ts"
import { checkPredicate, derivedRowScalars, rowScalars } from "#compiler/schema/terms.ts"
import type {
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
	OrderedFamily,
	Pred,
	Race,
	Selection,
	Series,
	Side,
	Statement,
	Tree,
	Unit
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
 * mirrors is sugar for the two containments between its sides; fin names a count's slots, which ordered, counted and
 * tree index a family by, and fold combines a family's members into its owner. Each returns a frozen value with its
 * StatementDesc (or SideDesc, or the ExpansionDesc of the containments mirrors is sugar for) under a non-enumerable
 * `desc`. Only `check` and `contract` take a name, which is their identity; every other statement's SQL identity
 * derives from what it names.
 *
 * Each builder is the one implementation of its value: its admission core first, then the literal of its arguments,
 * frozen copies, owned with the Description, so the value has its public type (types/schema/statements.ts) by
 * construction. Its type parameters are as wide as that value allows; the typed facade (schema/api.ts), the one
 * exporter of the public names, is a view that narrows them to the public signatures.
 *
 * The builders check what a JavaScript caller can get structurally wrong: a field that is not in the heading, pred of a
 * field that is not natural, a side pair of different widths. Semantic
 * judgments are ownership's (own.ts), because the same statement can arrive in a description TypeScript never
 * checked: which statements may read a derived relation, and its fields, which its definition infers. A check's and a
 * selection's callback over a derived relation reads its definition's heading as the builder typed it.
 */
export const statementDescOf = (value: unknown): StatementDesc | undefined =>
	ownedDesc(value, "statement")

/**
 * The canonical texts of the statements a statement value is owned as, the ones its build worked out (`ownedStatement`,
 * and a mirrors' at its build): a mirrors' two containments', any other statement's own; none for a value no statement
 * builder made.
 */
export const statementTextsOf = (value: unknown): ReadonlyArray<string> | undefined => {
	const expansion = ownedEntry(value, "expansion")
	if (expansion !== undefined) {
		return expansion.content.canonical.map((c) => c.text)
	}
	const statement = ownedEntry(value, "statement")
	return statement === undefined ? undefined : [statement.content.canonical.text]
}

/**
 * A statement value owned with its Description and its canonical form and text (own.ts CanonicalStatement), which its
 * schema's level content and ownership read it by, computed once, here, where the statement is built.
 */
const ownedStatement = <V extends Exclude<Statement, MirrorsBase>>(
	value: V,
	desc: StatementDesc
): V =>
	ownValue({
		kind: "statement",
		value: value,
		desc: desc,
		content: {
			canonical: canonicalStatementOf(desc),
			over: relationsOver(value)
		}
	})

/** Whether a value a statement holds is a relation, closed relation, roster or derived relation: a declaration. */
const isDeclaration = (value: Readonly<Record<string, unknown>>): boolean => {
	const kind = ownedKind(value) ?? value["kind"]
	return kind === "relation" || kind === "closed" || kind === "closedRelation" || kind === "derived"
}

/**
 * The relations a statement value was built over, each once, in the order met: a side's source or its selection's
 * relation, a mutable's or a check's relation, a family's slots' owner, a fold's step and end. A statement's
 * Description names each by its name alone (ir/desc.ts SideDesc), which a schema reads as its own relation of that
 * name, so the schema's build holds each to the schema's declaration of its name (schema.ts). The walk reads the
 * members the builders froze into the value, and stops at a relation, whose members are its own.
 */
const relationsOver = (value: unknown): ReadonlyArray<unknown> => {
	const over: Array<unknown> = []
	const pending: Array<unknown> = [value]
	for (let at = 0; at < pending.length; at += 1) {
		const member = pending[at]
		if (!hasProperties(member)) {
			continue
		}
		if (isDeclaration(member)) {
			if (!over.includes(member)) {
				over.push(member)
			}
			continue
		}
		for (const inner of isList(member) ? member : Object.values(member)) {
			pending.push(inner)
		}
	}
	return Object.freeze(over)
}

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

/** A side as a label spells it: its relation, its terms, and whether it selects. */
const sideLabel = (side: SideDesc): string =>
	`${side.relation}(${side.terms.map(termText).join(", ")})${side.selection.conjuncts.length === 0 ? "" : " selected"}`

export const sideDescOf = (value: unknown): SideDesc | undefined => ownedDesc(value, "side")

const sideOf = (value: unknown, label: string): SideDesc => {
	const desc = sideDescOf(value)
	if (desc !== undefined) {
		return desc
	}
	throw malformed(label, "a law side built by on(...)")
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

/** The race over a relation's primary key: its first insertion holds each key, which ownership judges (schema/own.ts). */
const admitRace = (relation: unknown): StatementDesc => {
	const rel = namedRelation(relation, "raced relation")
	return admitted({
		kind: "race",
		relation: rel.name,
		loc: builderLoc(`race ${rel.name}`, [rel.name, "race"])
	})
}

/**
 * Race a relation's primary key: the first insertion at a key holds it, and every later insertion there meets the row
 * that holds it, delivered in delta.met, never refused for differing from it.
 */
export const raceBuilder = <R>(relation: R): Race<R> =>
	ownedStatement({ kind: "race", relation }, admitRace(relation))

/**
 * The admission core of unit(...): a name, and a heading of at least one field, each a value type a key holds, its
 * caller's: no field grizzle or PostgreSQL writes, since the unit's fields lead the primary keys of its members, whose
 * callers state them. Which relations sit under it, and the rules every unit keeps beside the others, are ownership's
 * (schema/own.ts ownUnits).
 */
const admitUnit = (
	name: unknown,
	heading: unknown,
	extra: ReadonlyArray<unknown>
): StatementDesc => {
	const label = `unit ${typeof name === "string" ? name : "?"}`
	const unitName = requireName(name, label, "a unit's name")
	if (extra.length > 0) {
		throw malformed(label, "unit(name, heading): two arguments")
	}
	if (!isPlainRecord(heading)) {
		throw malformed(label, "a heading, a record of field descriptors")
	}
	const fields = Object.entries(heading).map(([field, value]): UnitFieldDesc => {
		const at = `${label} field ${field}`
		const type = valueTypeOf(value, at, () =>
			builderRefusal(
				at,
				"a unit's field is a value its caller writes, which no field grizzle writes is"
			)
		).desc
		if (!descCapabilities(type).includes("equality")) {
			throw builderRefusal(at, "a unit's field is of a type a key holds, one with equality")
		}
		return { field: requireName(field, at, "a field name"), type }
	})
	if (!isNonEmpty(fields)) {
		throw builderRefusal(label, "a unit's heading holds a field at least: a unit is a key")
	}
	Object.freeze(fields)
	return admitted({
		kind: "unit",
		name: unitName,
		heading: fields,
		sealed: false,
		loc: builderLoc(label, [unitName, "unit"])
	})
}

/** The value holds its name and a frozen copy of its heading, unsealed. */
export const unitBuilder = <const Name extends string, const Heading extends object>(
	name: Name,
	heading: Heading,
	extra: ReadonlyArray<unknown>
): Unit<Name, Heading, false> => {
	const desc = admitUnit(name, heading, extra)
	return ownedStatement({ kind: "unit", name, heading: frozenCopy(heading), sealed: false }, desc)
}

/**
 * The admission core of sealed(...): a unit statement unit(...) made, unsealed, its Description the unit's sealed. That
 * its relations are closed is ownership's, which sees every relation under it (schema/own.ts ownUnits).
 */
const admitSealed = (target: unknown, extra: ReadonlyArray<unknown>): StatementDesc => {
	const desc = statementDescOf(target)
	if (desc?.kind !== "unit") {
		throw malformed("sealed", "sealed(unit): a unit, unit(name, heading)'s value")
	}
	const label = `sealed unit ${desc.name}`
	if (extra.length > 0) {
		throw malformed(label, "sealed(unit): one argument")
	}
	if (desc.sealed) {
		throw malformed(label, "a unit sealed once: sealed(unit(name, heading))")
	}
	return admitted({ ...desc, sealed: true, loc: builderLoc(label, [desc.name, "unit"]) })
}

/** sealed(unit): the unit, sealed at founding; the value holds the unit's name and heading. */
export const sealedBuilder = <const Name extends string, const Heading>(
	target: Unit<Name, Heading, false>,
	extra: ReadonlyArray<unknown>
): Unit<Name, Heading, true> => {
	const desc = admitSealed(target, extra)
	return ownedStatement(
		{ kind: "unit", name: target.name, heading: target.heading, sealed: true },
		desc
	)
}

/**
 * The admission core of series(...): a stored relation whose primary key is one field, the series' numbers, of a type
 * grizzle draws (scalar/natural.ts isDrawnType): natural, or a contract over an integer, whose own CHECK refuses a number
 * past its bound. That the relation is immutable, and its level, are ownership's (schema/own.ts).
 */
const admitSeries = (relation: unknown): StatementDesc => {
	const rel = namedRelation(relation, "series relation")
	const label = `series ${rel.name}`
	if (rel.kind !== "relation") {
		throw builderRefusal(label, "a series is a stored relation, whose rows its writes append")
	}
	const [field, ...rest] = rel.primaryKey
	if (field === undefined || rest.length > 0 || !isDrawnType(fieldOf(rel, field, label))) {
		throw builderRefusal(
			label,
			"a series' relation is keyed by one field alone, the series' numbers, of a type grizzle draws: natural or a contract over an integer"
		)
	}
	return admitted({
		kind: "series",
		relation: rel.name,
		field,
		loc: builderLoc(label, [rel.name, "series"])
	})
}

/** series(R): R's one primary key field, of a drawn type, runs 0, 1, 2, … with no gap, its appends queued on one lock. */
export const seriesBuilder = <R>(relation: R): Series<R> =>
	ownedStatement({ kind: "series", relation }, admitSeries(relation))

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
	ownValue({ kind: "selection", value: { relation }, desc: desc, content: undefined })

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
	const value = { source, terms: frozenTuple<T>(terms) }
	return ownValue({ kind: "side", value, desc: admitOn(source, terms), content: undefined })
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
	ownValue({
		kind: "expansion",
		value: value,
		desc: expansion,
		content: {
			canonical: [
				canonicalStatementOf(expansion.statements[0]),
				canonicalStatementOf(expansion.statements[1])
			],
			over: relationsOver(value)
		}
	})

/** mirrors(left, right): sugar for contained(left, right) and contained(right, left), which the schema states. */
export const mirrorsBuilder = <L, R>(left: L, right: R): Mirrors<L, R> =>
	ownExpansion({ kind: "mirrors", left, right }, admitMirrors(left, right))

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
export const orderedBuilder = <F, Fi>(family: F, slots: Fi): OrderedFamily<F, Fi> =>
	ownedStatement({ kind: "ordered", family, slots }, admitFamily("ordered", family, slots))

/** counted(on(F, g…), fin(O, n)): the value holds its two inputs. */
export const countedBuilder = <F, Fi>(family: F, slots: Fi): Counted<F, Fi> =>
	ownedStatement({ kind: "counted", family, slots }, admitFamily("counted", family, slots))

/** tree(on(T, "parent", "at"), fin(T, n), { root }): the value holds its inputs, `root` the root fields' names. */
export const treeBuilder = <F, Fi, const Root extends ReadonlyArray<string>>(
	family: F,
	slots: Fi,
	root: { readonly root: Root }
): Tree<F, Fi, Root> => {
	const member = memberSide(
		family,
		"tree",
		"a tree is a family of T over itself, on(T, parent, at), keyed by its root fields then start, with drawn parent, start and end"
	)
	const slotsDesc = slotsOf(slots, "tree slots")
	if (!isPlainRecord(root)) {
		throw malformed("tree", "{ root }: the root fields each tree's rows share")
	}
	const rootFields = requireNames(
		root.root,
		"tree",
		"the root fields each tree's rows share",
		"a tree's root fields are distinct caller fields of its relation"
	)
	const desc = admitted({
		kind: "tree",
		member,
		slots: slotsDesc,
		root: rootFields,
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
