import { CompileError } from "#compiler/core/errors.ts"
import { FieldId } from "#compiler/core/ids.ts"
import { hasProperties } from "#compiler/core/record.ts"
import {
	type BoundDesc,
	type BoundValueDesc,
	decodeContainedStatement,
	decodeDesc,
	decodeMirrorsStatement,
	type FieldDesc,
	type LiteralDesc,
	type SideDesc,
	type StatementDesc,
	type WeightDesc
} from "#compiler/ir/desc.ts"
import { literalFor } from "#compiler/schema/literal.ts"
import {
	builderLoc,
	frozenArray,
	frozenCopy,
	frozenTuple,
	isName,
	isPlainRecord,
	malformed,
	orThrow,
	ownedDesc,
	ownedEntry,
	ownValue,
	requireName,
	requireNames
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
	Capacity,
	CapacityRule,
	Check,
	Containment,
	Key,
	Mirrors,
	Mutable,
	Selection,
	Side
} from "#compiler/types/schema/statements.ts"

/**
 * The admission cores: each checks a JavaScript caller's arguments and returns the decoded Description the statement
 * is owned with, the one path a statement's Description is built by.
 */
const admitted = (desc: StatementDesc): StatementDesc => orThrow(decodeDesc("statement", desc))

/**
 * The statement constructors.
 *
 * key, mutable and check name one relation; on and select build law sides; contained and mirrors relate two sides;
 * alternatives is one statement, which the schema expands to a containment and one mirrors per arm; capacity bounds a
 * group with ref, weigh, duration and within. Each returns a frozen value with its StatementDesc (or SideDesc, or the
 * AlternativesDesc of its expansion) under a non-enumerable `desc`. Only `check` and `contract` take a name, which is
 * their identity; every other statement's SQL identity derives from what it names.
 *
 * Each builder is the one implementation of its value: its admission core first, then the literal of its arguments,
 * frozen copies, owned with the Description, so the value has its public type (types/schema/statements.ts) by
 * construction. Its type parameters are as wide as that value allows; the typed facade (schema/api.ts) is a view that
 * narrows them to the public signatures.
 *
 * The constructors check what a JavaScript caller can get structurally wrong: a field that is not in the heading, a
 * side pair of different widths, an arm map over handles the roster lacks. Semantic judgments are ownership's
 * (own.ts): a statement naming a derived relation is LawOnDerived there, because the same statement can
 * arrive in a description TypeScript never checked; the constructors record it. The one exception is check, whose
 * callback needs the row's fields, which a derived relation does not have before compilation.
 */
export const statementDescOf = (value: unknown): StatementDesc | undefined =>
	ownedDesc(value, "statement")

/** The relation a Key value names, when `value` is one. */
const keyRelation = (value: unknown): { readonly relation: unknown } | undefined => {
	const owned = ownedEntry(value, "statement")?.value
	return owned?.kind === "key" ? { relation: owned.relation } : undefined
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

/** The heading's field names, refusing a name that is not one where the heading is known. */
const requireFields = (rel: NamedRelation, fields: ReadonlyArray<string>, label: string): void => {
	if (rel.kind === "derived") {
		return
	}
	for (const f of fields) {
		fieldOf(rel, f, label)
	}
}

/** An additional candidate key; lowers to an immediate UNIQUE. */
const admitKey = (relation: unknown, fields: unknown): StatementDesc => {
	const rel = namedRelation(relation, "key relation")
	const label = `key ${rel.name}`
	const list = requireNames(fields, label, "a nonempty candidate key")
	requireFields(rel, list, label)
	return admitted({
		kind: "key",
		relation: rel.name,
		fields: list,
		loc: builderLoc(label, [rel.name, "key", ...list])
	})
}

/** The value holds a frozen copy of the key's fields, `readonly [...K]`, which is K for every key a call writes. */
export const key = <R, const K extends ReadonlyArray<string>>(
	relation: R,
	fields: K
): Key<R, readonly [...K]> => {
	const desc = admitKey(relation, fields)
	return ownValue({ kind: "key", relation, fields: frozenTuple<K>(fields) }, "statement", desc)
}

/**
 * The relation and key fields a key position names: a relation stands for its primary key, a Key value for its
 * candidate key.
 */
const keyRef = (
	value: unknown,
	label: string
): { readonly rel: NamedRelation; readonly fields: ReadonlyArray<string> } => {
	const desc = statementDescOf(value)
	if (desc !== undefined) {
		const keyed = keyRelation(value)
		if (desc.kind !== "key" || keyed === undefined) {
			throw malformed(label, "a relation or a Key built by key(...)")
		}
		return { rel: namedRelation(keyed.relation, label), fields: desc.fields }
	}
	const rel = namedRelation(value, label)
	if (rel.kind === "derived") {
		throw CompileError.make({ _tag: "LawOnDerived", at: builderLoc(label, []), relation: rel.name })
	}
	return { rel, fields: rel.primaryKey }
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
export const mutable = <R>(relation: R): Mutable<R> =>
	ownValue({ kind: "mutable", relation }, "statement", admitMutable(relation))

export const admitCheck = (name: unknown, relation: unknown, predicate: unknown): StatementDesc => {
	const label = `check ${typeof name === "string" ? name : "?"}`
	const checkName = requireName(name, label, "a check name, the law's identity")
	const rel = namedRelation(relation, `${label} relation`)
	if (rel.kind === "derived") {
		throw CompileError.make({ _tag: "LawOnDerived", at: builderLoc(label, []), relation: rel.name })
	}
	if (typeof predicate !== "function") {
		throw malformed(label, "a predicate callback (row) => predicate")
	}
	const built: unknown = Reflect.apply(predicate, undefined, [
		rowScalars(rel.fields, rel.descriptors, (field) => fieldRoster(rel, field))
	])
	const expr = checkPredicate(built, label)
	return admitted({
		kind: "check",
		name: checkName,
		relation: rel.name,
		predicate: expr,
		loc: builderLoc(label, [rel.name, "check", checkName])
	})
}

/** A row check under its name, the law's identity; the predicate callback is admission's to call and read. */
export const check = <const Name extends string, R>(
	name: Name,
	relation: R,
	predicate: unknown
): Check<Name, R> => {
	const desc = admitCheck(name, relation, predicate)
	return ownValue({ kind: "check", name, relation }, "statement", desc)
}

export interface SelectionDesc {
	readonly relation: string
	readonly selection: Readonly<Record<string, LiteralDesc>>
}

/**
 * A conditional relation description for laws: the facts of `relation` whose fields equal the bindings.
 * An empty binding record selects every fact, so it is the relation itself.
 */
const admitSelect = (relation: unknown, bindings: unknown): SelectionDesc => {
	const rel = namedRelation(relation, "select relation")
	const label = `select ${rel.name}`
	if (!isPlainRecord(bindings)) {
		throw malformed(label, "bindings: a record of field values")
	}
	const selection: Record<string, LiteralDesc> = {}
	for (const [field, value] of Object.entries(bindings)) {
		if (rel.kind === "derived") {
			throw malformed(
				label,
				`bindings of ${rel.name}'s fields; its fields are inferred at compilation`
			)
		}
		selection[field] = literalFor(
			fieldOf(rel, field, label),
			value,
			`${label}.${field}`,
			fieldRoster(rel, field)
		)
	}
	return { relation: rel.name, selection }
}

/** The value holds a frozen copy of the bindings. */
export const select = <R, B extends object>(relation: R, bindings: B): Selection<R, B> => {
	const desc = admitSelect(relation, bindings)
	return ownValue({ relation, bindings: frozenCopy(bindings) }, "selection", desc)
}

export const sideDescOf = (value: unknown): SideDesc | undefined => ownedDesc(value, "side")

/** A law side: a relation, closed relation or selection projected onto fields, in order. */
const admitOn = (side: unknown, fields: ReadonlyArray<unknown>): SideDesc => {
	const selected = ownedEntry(side, "selection")
	const selection = selected?.desc
	const rel = namedRelation(selected === undefined ? side : selected.value.relation, "on side")
	const label = `on ${rel.name}`
	const list = requireNames(fields, label, "a side naming at least one field")
	requireFields(rel, list, label)
	return { relation: rel.name, fields: list, selection: selection?.selection ?? {} }
}

/**
 * A side names at least one field of its source, each once (ir/desc.ts SideDesc); the value holds a frozen copy of
 * them, `readonly [...F]`.
 */
export const on = <R, const F extends ReadonlyArray<string>>(
	side: R,
	fields: F
): Side<R, readonly [...F]> => {
	const desc = admitOn(side, fields)
	return ownValue({ source: side, fields: frozenTuple<F>(fields) }, "side", desc)
}

const sideOf = (value: unknown, label: string): SideDesc => {
	const desc = sideDescOf(value)
	if (desc === undefined) {
		throw malformed(label, "a law side built by on(...)")
	}
	return desc
}

const sidePair = (left: unknown, right: unknown, label: string): readonly [SideDesc, SideDesc] => {
	const l = sideOf(left, `${label} left`)
	const r = sideOf(right, `${label} right`)
	if (l.fields.length !== r.fields.length) {
		throw malformed(
			label,
			`sides of one width: ${l.fields.length} field(s) against ${r.fields.length}`
		)
	}
	return [l, r]
}

const sideLabel = (side: SideDesc): string =>
	`${side.relation}(${side.fields.join(", ")})${Object.keys(side.selection).length === 0 ? "" : " selected"}`

const admitContained = (
	left: unknown,
	right: unknown
): Extract<StatementDesc, { readonly kind: "contained" }> => {
	const [l, r] = sidePair(left, right, "contained")
	const label = `contained ${sideLabel(l)} in ${sideLabel(r)}`
	return orThrow(
		decodeContainedStatement({
			kind: "contained",
			left: l,
			right: r,
			origin: undefined,
			loc: builderLoc(label, [l.relation, "contained"])
		})
	)
}

export const contained = <L, R>(left: L, right: R): Containment<L, R> =>
	ownValue({ kind: "contained", left, right }, "statement", admitContained(left, right))

const admitMirrors = (
	left: unknown,
	right: unknown
): Extract<StatementDesc, { readonly kind: "mirrors" }> => {
	const [l, r] = sidePair(left, right, "mirrors")
	const label = `mirrors ${sideLabel(l)} and ${sideLabel(r)}`
	return orThrow(
		decodeMirrorsStatement({
			kind: "mirrors",
			left: l,
			right: r,
			origin: undefined,
			loc: builderLoc(label, [l.relation, "mirrors"])
		})
	)
}

export const mirrors = <L, R>(left: L, right: R): Mirrors<L, R> =>
	ownValue({ kind: "mirrors", left, right }, "statement", admitMirrors(left, right))

/** The origin marker of an alternatives expansion: the parent relation and discriminator, as one injective spelling. */
export const alternativesId = (parent: string, discriminator: string): string =>
	FieldId(parent, discriminator)

/**
 * alternatives(parentKey, discriminator, roster, arms) is one statement of a schema, which the schema expands to
 * contained(on(parent, discriminator), on(roster, "id")) plus one mirrors(on(select(parent, { [discriminator]: handle
 * }), ...parentKey), on(arm, ...armKey)) per handle with an arm, in roster order. Every statement of the
 * expansion carries the origin marker, so ownership can refuse the helper and its manual expansion together. The value
 * keeps its four inputs, which the query types read (types/evidence ArmProofOf); its Description is the expansion.
 */
export interface AlternativesDesc {
	readonly statements: ReadonlyArray<StatementDesc>
}

export const alternativesDescOf = (value: unknown): AlternativesDesc | undefined =>
	ownedDesc(value, "alternatives")

/**
 * The admission core of alternatives(...): the arguments checked and the expansion described. The discriminator must
 * be a closedId field of the roster itself: the expansion's select refuses only a handle the roster lacks, so a
 * discriminator over another roster with the same handles would pass it. Each arm is keyed like the parent, refused
 * here rather than by the expanded mirrors statement, which the caller never wrote; and each is a relation other than
 * the parent, whose own arm, keyed by a key of the parent, would hold every parent at its handle.
 */
const admitAlternatives = (
	parent: unknown,
	discriminator: unknown,
	roster: unknown,
	arms: unknown
): AlternativesDesc => {
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
	const parentKeyed = keyRelation(parent)
	const parentValue = parentKeyed === undefined ? parent : parentKeyed.relation
	const head = admitContained(on(parentValue, [disc]), on(roster, ["id"]))
	const statements: Array<StatementDesc> = [
		admitted({ ...head, origin, loc: builderLoc(label, [parentRel.name, "alternatives", disc]) })
	]
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
		const armKeyed = keyRelation(arm)
		const armValue = armKeyed === undefined ? arm : armKeyed.relation
		const m = admitMirrors(
			on(select(parentValue, { [disc]: h }), parentKey.fields),
			on(armValue, armKey.fields)
		)
		statements.push(
			admitted({
				...m,
				origin,
				loc: builderLoc(`${label} arm ${h}`, [parentRel.name, "alternatives", h])
			})
		)
	}
	return Object.freeze({ statements: frozenArray(statements) })
}

/** The value holds its four inputs, the arm map a frozen copy. */
export const alternatives = <P, const D extends string, C, Arms extends object>(
	parent: P,
	discriminator: D,
	roster: C,
	arms: Arms
): Alternatives<P, D, C, Arms> => {
	const desc = admitAlternatives(parent, discriminator, roster, arms)
	return ownValue(
		{ kind: "alternatives", parent, discriminator, roster, arms: frozenCopy(arms) },
		"alternatives",
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
export const ref = (field: unknown): RefValue =>
	Object.freeze({ ref: requireName(field, "ref", "a field of the capacity target") })

/** A span field whose width is a source fact's weight. */
export const duration = (spanField: unknown): DurationValue =>
	Object.freeze({
		duration: requireName(spanField, "duration", "a span field of the capacity source")
	})

export const weigh = (field: unknown): WeightValue => {
	if (hasProperties(field) && typeof field["duration"] === "string") {
		return Object.freeze({ weight: duration(field["duration"]) })
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
export const within = (low: unknown, ...rest: ReadonlyArray<unknown>): BoundValue => {
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
	if (t.fields.length !== f.fields.length) {
		throw malformed(
			"capacity",
			`sides of one width: ${t.fields.length} field(s) against ${f.fields.length}`
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

export const capacity = <T, F>(target: T, rule: CapacityRule<F>): Capacity<T, F> => {
	const desc = admitCapacity(target, rule)
	return ownValue({ kind: "capacity", target, from: rule.from }, "statement", desc)
}
