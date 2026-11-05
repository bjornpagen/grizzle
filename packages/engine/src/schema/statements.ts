import { CompileError } from "#compiler/core/errors.ts"
import { FieldId } from "#compiler/core/ids.ts"
import { isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { hasProperties, isList } from "#compiler/core/record.ts"
import {
	type BoundDesc,
	type BoundValueDesc,
	candidateKeyFields,
	conjunctsOf,
	decodeContainedStatement,
	decodeDesc,
	decodeSide,
	type ExprDesc,
	type FieldDesc,
	type SelectionDesc,
	type SideDesc,
	type StatementDesc,
	type TermDesc,
	termText,
	type WeightDesc
} from "#compiler/ir/desc.ts"
import { isNaturalDesc } from "#compiler/scalar/natural.ts"
import {
	builderLoc,
	frozenCopy,
	frozenTuple,
	isName,
	isPlainRecord,
	malformed,
	orThrow,
	ownedDesc,
	ownedEntry,
	ownValue,
	requireName
} from "#compiler/schema/protocol.ts"

import {
	fieldRoster,
	type NamedRelation,
	namedRelation,
	relationDescOf
} from "#compiler/schema/relation.ts"
import { checkPredicate, rowScalars } from "#compiler/schema/terms.ts"
import type {
	Alternatives,
	AnyTerm,
	Capacity,
	CapacityRule,
	Check,
	Containment,
	Key,
	Mirrors,
	Mutable,
	Pred,
	Selection,
	Side
} from "#compiler/types/schema/statements.ts"

/**
 * The admission cores: each checks a JavaScript caller's arguments and returns the decoded Description the statement
 * is owned with, the one path a statement's Description is built by.
 */
const admitted = (desc: StatementDesc): StatementDesc => orThrow(decodeDesc("statement", desc))

/**
 * The statement builders.
 *
 * key, mutable and check name one relation or side; on, select and pred build law sides; contained relates two sides;
 * mirrors is sugar for the two containments between its sides, and alternatives one statement, which the schema
 * expands to a containment and one mirrors per arm; capacity bounds a group with ref, weigh, duration and within. Each
 * returns a frozen value with its StatementDesc (or SideDesc, or the ExpansionDesc of the statements it is sugar for)
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
 * judgments are ownership's (own.ts): a statement naming a derived relation is LawOnDerived there, because the same
 * statement can arrive in a description TypeScript never checked; the builders record it. The exceptions are check and
 * select, whose callbacks need the row's fields, which a derived relation does not have before compilation.
 */
export const statementDescOf = (value: unknown): StatementDesc | undefined =>
	ownedDesc(value, "statement")

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
	ownValue({ kind: "key", side }, "statement", admitKey(side))

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
		throw CompileError.make({ _tag: "LawOnDerived", at: builderLoc(label, []), relation: rel.name })
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
	ownValue({ kind: "mutable", relation }, "statement", admitMutable(relation))

/**
 * The predicate a row callback returns over `rel`'s row, which `label` refuses when the relation is derived, whose
 * fields are inferred at compilation, or the callback is no callback: the one reading of a row predicate, a check's
 * and a selection's.
 */
const rowPredicate = (
	rel: NamedRelation,
	predicate: unknown,
	label: string,
	what: string
): ExprDesc => {
	if (rel.kind === "derived") {
		throw CompileError.make({ _tag: "LawOnDerived", at: builderLoc(label, []), relation: rel.name })
	}
	if (typeof predicate !== "function") {
		throw malformed(label, `a predicate callback (row) => predicate, ${what}`)
	}
	const built: unknown = Reflect.apply(predicate, undefined, [
		rowScalars(rel.fields, rel.descriptors, (field) => fieldRoster(rel, field))
	])
	return checkPredicate(built, label)
}

export const admitCheck = (name: unknown, relation: unknown, predicate: unknown): StatementDesc => {
	const label = `check ${typeof name === "string" ? name : "?"}`
	const checkName = requireName(name, label, "a check name, the law's identity")
	const rel = namedRelation(relation, `${label} relation`)
	const expr = rowPredicate(rel, predicate, label, "the law every fact keeps")
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
	return ownValue({ kind: "check", name, relation }, "statement", desc)
}

/** What a selection value is owned with: the relation it selects from and the row predicate that selects. */
export interface SelectedDesc {
	readonly relation: string
	readonly predicate: ExprDesc
}

/** The selection value of `relation`'s facts `predicate` holds of, owned with its Description. */
const selectionOf = <R>(relation: R, desc: SelectedDesc): Selection<R> =>
	ownValue({ relation }, "selection", desc)

/**
 * select(R, (row) => predicate): the facts of R the predicate holds of, in the row-check language a check is written
 * in. Its callback runs once, here, over R's row, and records the predicate.
 */
export const selectBuilder = <R>(relation: R, predicate: unknown): Selection<R> => {
	const rel = namedRelation(relation, "select relation")
	const label = `select ${rel.name}`
	const expr = rowPredicate(rel, predicate, label, "the facts the side reads")
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
		return { kind: "field", field: value }
	}
	if (hasProperties(value) && value["kind"] === "pred" && isName(value["field"])) {
		return { kind: "pred", field: value["field"] }
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
	const selection: SelectionDesc = {
		conjuncts: selected === undefined ? [] : conjunctsOf(selected.desc.predicate)
	}
	return orThrow(decodeSide({ relation: rel.name, terms: list, selection }))
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
	return ownValue({ source, terms: frozenTuple<T>(terms) }, "side", desc)
}

const sidePair = (left: unknown, right: unknown, label: string): readonly [SideDesc, SideDesc] => {
	const l = sideOf(left, `${label} left`)
	const r = sideOf(right, `${label} right`)
	if (l.terms.length !== r.terms.length) {
		throw malformed(
			label,
			`sides of one width: ${l.terms.length} term(s) against ${r.terms.length}`
		)
	}
	return [l, r]
}

/** The containment of `left` in `right`, two sides of one width, declared at `loc` by `origin`. */
const containedDesc = (
	left: SideDesc,
	right: SideDesc,
	origin: { readonly alternatives: string } | undefined,
	label: string,
	path: ReadonlyArray<string>
): Extract<StatementDesc, { readonly kind: "contained" }> =>
	orThrow(
		decodeContainedStatement({
			kind: "contained",
			left,
			right,
			origin,
			loc: builderLoc(label, path)
		})
	)

const admitContained = (
	left: unknown,
	right: unknown
): Extract<StatementDesc, { readonly kind: "contained" }> => {
	const [l, r] = sidePair(left, right, "contained")
	return containedDesc(l, r, undefined, `contained ${sideLabel(l)} in ${sideLabel(r)}`, [
		l.relation,
		"contained"
	])
}

export const containedBuilder = <L, R>(left: L, right: R): Containment<L, R> =>
	ownValue({ kind: "contained", left, right }, "statement", admitContained(left, right))

/**
 * The statements a sugar value states, which the schema holds in its place: a mirrors' two containments, or an
 * alternatives law's arms' mirrors.
 */
export interface ExpansionDesc {
	readonly statements: NonEmptyReadonlyArray<StatementDesc>
}

export const expansionDescOf = (value: unknown): ExpansionDesc | undefined =>
	ownedDesc(value, "expansion")

/** The two containments mirrors(left, right) is sugar for, left in right and right in left, from `origin`. */
const mirrored = (
	l: SideDesc,
	r: SideDesc,
	origin: { readonly alternatives: string } | undefined,
	label: string,
	path: ReadonlyArray<string>
): readonly [StatementDesc, StatementDesc] => [
	containedDesc(l, r, origin, label, path),
	containedDesc(r, l, origin, label, path)
]

const admitMirrors = (left: unknown, right: unknown): ExpansionDesc => {
	const [l, r] = sidePair(left, right, "mirrors")
	const label = `mirrors ${sideLabel(l)} and ${sideLabel(r)}`
	return Object.freeze({
		statements: frozenTuple(mirrored(l, r, undefined, label, [l.relation, "mirrors"]))
	})
}

/** mirrors(left, right): sugar for contained(left, right) and contained(right, left), which the schema states. */
export const mirrorsBuilder = <L, R>(left: L, right: R): Mirrors<L, R> =>
	ownValue({ kind: "mirrors", left, right }, "expansion", admitMirrors(left, right))

/** The origin marker of an alternatives expansion: the parent relation and discriminator, as one injective spelling. */
export const alternativesId = (parent: string, discriminator: string): string =>
	FieldId(parent, discriminator)

/**
 * The admission core of alternatives(...): the arguments checked and the expansion described.
 *
 * alternatives(parentKey, discriminator, roster, arms) is one statement of a schema, which the schema expands to, per
 * handle with an arm, in roster order, the two containments of mirrors(on(select(parent, (p) =>
 * p[discriminator].eq(h)), ...parentKey), on(arm, ...armKey)), the selection's predicate stated as that plain spelling
 * builds it, the handle an untyped literal its field types. No statement holds the discriminator to the roster's
 * handles: its closedId type does. Every statement of the expansion carries the origin marker, so ownership can refuse
 * the helper and its manual expansion together.
 *
 * The discriminator must be a closedId field of the roster itself: the expansion's selection refuses only a handle the
 * roster lacks, so a discriminator over another roster with the same handles would pass it. Each arm is keyed like the
 * parent, refused here rather than by the expanded statements, which the caller never wrote; and each is a relation
 * other than the parent, whose own arm, keyed by a key of the parent, would hold every parent at its handle.
 */
const admitAlternatives = (
	parent: unknown,
	discriminator: unknown,
	roster: unknown,
	arms: unknown
): ExpansionDesc => {
	const parentKey = keyRef(parent, "alternatives parent")
	const parentRel = parentKey.rel
	const label = `alternatives ${parentRel.name}`
	const disc = requireName(discriminator, label, "a discriminator field")
	requireFields(parentRel, [disc], label)
	const rosterRel = namedRelation(roster, `${label} roster`)
	if (rosterRel.kind !== "closed") {
		throw malformed(label, "a closed relation as the roster")
	}
	const discDesc = parentRel.kind === "derived" ? undefined : parentRel.fields[disc]
	if (
		discDesc !== undefined &&
		!(discDesc.kind === "closedId" && discDesc.roster === rosterRel.name)
	) {
		throw malformed(
			label,
			`a discriminator that is a closedId(${rosterRel.name}) field of ${parentRel.name}`
		)
	}
	if (!isPlainRecord(arms) || Object.keys(arms).length === 0) {
		throw malformed(label, "an arm map from handles to key descriptors, with at least one arm")
	}
	const rosterDesc = relationDescOf(roster, `${label} roster`)
	if (rosterDesc.kind !== "closed") {
		throw malformed(label, "a closed relation as the roster")
	}
	const rosterHandles = rosterDesc.handles
	for (const h of Object.keys(arms)) {
		if (!rosterHandles.includes(h)) {
			throw malformed(label, `arms keyed by ${rosterRel.name}'s handles; ${h} is not one`)
		}
	}
	const origin = { alternatives: alternativesId(parentRel.name, disc) }
	const armStatements: Array<StatementDesc> = []
	for (const h of rosterHandles) {
		const arm = arms[h]
		if (arm === undefined) {
			continue
		}
		const armKey = keyRef(arm, `${label} arm ${h}`)
		if (armKey.rel.name === parentRel.name) {
			throw malformed(label, `the arm ${h} a relation other than its parent ${parentRel.name}`)
		}
		if (armKey.fields.length !== parentKey.fields.length) {
			throw malformed(
				label,
				`the arm ${h} keyed like the parent: ${armKey.fields.length} key field(s) against ${parentKey.fields.length}`
			)
		}
		const ofHandle = selectionOf(parentKey.value, {
			relation: parentRel.name,
			predicate: {
				kind: "compare",
				op: "eq",
				left: { kind: "field", field: disc },
				right: { kind: "literal", value: h, type: undefined }
			}
		})
		armStatements.push(
			...mirrored(
				admitOn(ofHandle, parentKey.fields),
				admitOn(armKey.value, armKey.fields),
				origin,
				`${label} arm ${h}`,
				[parentRel.name, "alternatives", h]
			)
		)
	}
	const statements: ReadonlyArray<StatementDesc> = armStatements
	if (!isNonEmpty(statements)) {
		throw malformed(label, "an arm map from handles to key descriptors, with at least one arm")
	}
	return Object.freeze({ statements: frozenTuple(statements) })
}

/** The value holds its four inputs, the arm map a frozen copy. */
export const alternativesBuilder = <P, const D extends string, C, Arms extends object>(
	parent: P,
	discriminator: D,
	roster: C,
	arms: Arms
): Alternatives<P, D, C, Arms> => {
	const desc = admitAlternatives(parent, discriminator, roster, arms)
	return ownValue(
		{ kind: "alternatives", parent, discriminator, roster, arms: frozenCopy(arms) },
		"expansion",
		desc
	)
}

interface RefValue {
	readonly ref: string
}

interface DurationValue {
	readonly duration: string
}

interface WeightValue {
	readonly weight: string | DurationValue
}

interface BoundValue {
	readonly low: bigint | RefValue
	readonly high: bigint | RefValue | "*"
}

/** A bound naming a field of the target fact. */
export const runtimeRef = (field: unknown): RefValue =>
	Object.freeze({ ref: requireName(field, "ref", "a field of the capacity target") })

/** A span field whose width is a source fact's weight. */
export const runtimeDuration = (spanField: unknown): DurationValue =>
	Object.freeze({
		duration: requireName(spanField, "duration", "a span field of the capacity source")
	})

export const runtimeWeigh = (field: unknown): WeightValue => {
	if (hasProperties(field) && typeof field["duration"] === "string") {
		return Object.freeze({ weight: runtimeDuration(field["duration"]) })
	}
	return Object.freeze({
		weight: requireName(field, "weigh", "a field of the capacity source, or a duration(...)")
	})
}

const isRef = (value: unknown): value is RefValue => hasProperties(value) && isName(value["ref"])

const boundValue = (value: unknown, label: string): bigint | RefValue => {
	if (typeof value === "bigint") {
		if (value < 0n) {
			throw malformed(label, "a nonnegative bound")
		}
		return value
	}
	if (isRef(value)) {
		return Object.freeze({ ref: value.ref })
	}
	throw malformed(label, "a bigint bound or ref(field)")
}

/** within(n) is exactly n, within(low, high) the inclusive range, within(low, "*") no upper bound. */
export const runtimeWithin = (low: unknown, ...rest: ReadonlyArray<unknown>): BoundValue => {
	if (rest.length > 1) {
		throw malformed("within", 'within(n), within(low, high) or within(low, "*")')
	}
	const lo = boundValue(low, "within low")
	if (rest.length === 0) {
		return Object.freeze({ low: lo, high: lo })
	}
	const high = rest[0]
	if (high === "*") {
		return Object.freeze({ low: lo, high: "*" })
	}
	const hi = boundValue(high, "within high")
	if (typeof lo === "bigint" && typeof hi === "bigint" && lo > hi) {
		throw malformed("within", "a bound whose low does not exceed its high")
	}
	return Object.freeze({ low: lo, high: hi })
}

const boundDesc = (value: bigint | RefValue): BoundValueDesc =>
	typeof value === "bigint" ? value : { ref: value.ref }

const weightDesc = (value: unknown, label: string): WeightDesc => {
	if (!hasProperties(value)) {
		throw malformed(label, "a weight built by weigh(...)")
	}
	const w = value["weight"]
	if (typeof w === "string" && isName(w)) {
		return { kind: "field", field: w }
	}
	if (hasProperties(w) && isName(w["duration"])) {
		return { kind: "duration", field: w["duration"] }
	}
	throw malformed(label, "a weight built by weigh(field) or weigh(duration(spanField))")
}

const withinDesc = (value: unknown, label: string): BoundDesc => {
	if (!hasProperties(value)) {
		throw malformed(label, "a bound built by within(...)")
	}
	const low = boundValue(value["low"], `${label} low`)
	const high = value["high"] === "*" ? "*" : boundValue(value["high"], `${label} high`)
	return { low: boundDesc(low), high: high === "*" ? "*" : boundDesc(high) }
}

/** A bound on the count or total weight of source facts whose projection matches each target fact's. */
export const admitCapacity = (target: unknown, rule: unknown): StatementDesc => {
	const t = sideOf(target, "capacity target")
	if (!isPlainRecord(rule)) {
		throw malformed("capacity", "a rule { from, weight?, within }")
	}
	for (const k of Object.keys(rule)) {
		if (k !== "from" && k !== "weight" && k !== "within") {
			throw malformed("capacity", `a rule without ${k}`)
		}
	}
	const f = sideOf(rule["from"], "capacity from")
	if (t.terms.length !== f.terms.length) {
		throw malformed(
			"capacity",
			`sides of one width: ${t.terms.length} term(s) against ${f.terms.length}`
		)
	}
	const label = `capacity ${sideLabel(t)} from ${sideLabel(f)}`
	return admitted({
		kind: "capacity",
		target: t,
		from: f,
		weight:
			rule["weight"] === undefined
				? { kind: "count" }
				: weightDesc(rule["weight"], `${label} weight`),
		within: withinDesc(rule["within"], `${label} within`),
		loc: builderLoc(label, [t.relation, "capacity"])
	})
}

export const capacityBuilder = <T, F>(target: T, rule: CapacityRule<F>): Capacity<T, F> => {
	const desc = admitCapacity(target, rule)
	return ownValue({ kind: "capacity", target, from: rule.from }, "statement", desc)
}
