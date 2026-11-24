/**
 * Where a derived relation's rows live, inferred by the installation from the schema's dependency structure and never
 * declared by its author: in a table of its own, which grizzle keeps equal to its definition at every COMMIT (the
 * judge's phase A, physical/ddl/rules.ts), or in its definition alone, which every reader reads in its place.
 *
 * A derived relation is stored exactly where the installation can keep it incrementally, its upkeep at a unit a
 * transaction wrote reading only rows that transaction's borrow covers:
 *
 * - its definition is unit-local within one declared unit (analysis/theory/unit.ts storedUnit): every relation it reads
 *   sits in that unit and is joined on its key, every negation correlated at it, every aggregate grouped by it, every
 *   recursion carrying it, so a fact of it is derived from the rows of one unit alone, which every writer of them holds
 *   exclusively, a closed relation's inserts and an open one's updates and deletes alike, and its upkeep there is exact
 *   at READ COMMITTED;
 * - every declared function it calls is immutable throughout, and no field it reads is one grizzle rewrites in place, a
 *   fold's accumulator, so no change of its rows escapes its unit's writes;
 * - its table can hold its rows: derived analysis admits its heading and its keys (analysis/derived/analyze.ts).
 *
 * Whether the relations it reads are closed decides nothing: a definition over closed relations alone that joins rows
 * of two units could lose a fact two writers inserted into the two at once, each blind to the other's, so it is live,
 * and one over an open relation inside its unit is kept under the borrow its writers hold. Every other derived relation
 * is live (`LiveReason`). One rule decides it, once, where the checked schema reads its derived relations level by
 * level (analysis/schema.ts CheckedSchema), so a stored relation is one of the relations the levels above it read, and
 * every reader, a query, a rule, an upkeep and a role, reads the one decision.
 */
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type * as Result from "@bjornpagen/grizzle-text/base/result"
import type { DerivedRelationAnalysis, OwnedDerived } from "#compiler/analysis/derived/analyze.ts"
import { type DeclaredMember, storedUnit } from "#compiler/analysis/theory/unit.ts"
import type { CompileError, LiveReason } from "#compiler/core/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { type RelationIdent, StoredRelationName } from "#compiler/core/ids.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type { InferredQuery } from "#compiler/ir/desc.ts"
import type { LawField, StoredDerivedRelation, TheoryRelation } from "#compiler/ir/law.ts"
import type { StoredUnit } from "#compiler/ir/unit.ts"
import type { Owned } from "#compiler/schema/own.ts"

/**
 * Where a derived relation's rows live (see the header): `stored`, in its table, with its analysis, the heading and keys
 * a Base over the table reads, and the relation as the theory and every reader above it read it (ir/law.ts
 * StoredDerivedRelation); or `live`, in its definition alone, and why (`LiveReason`).
 */
export type DerivedHolding =
	| {
			readonly kind: "stored"
			readonly analysis: DerivedRelationAnalysis
			readonly relation: StoredDerivedRelation
	  }
	| { readonly kind: "live"; readonly why: LiveReason }

/** What a derived relation's holding is decided over (`derivedHolding`). */
export interface HoldingInput {
	readonly owned: Owned
	readonly relation: OwnedDerived
	/** Its definition read live: every live derived relation it names read through its definition, every stored one by
	 * its table (analysis/theory/query.ts liveReading). */
	readonly definition: InferredQuery
	/** The ordinary and closed relations of the schema and the stored derived relations of the levels below its own. */
	readonly known: ReadonlyMap<string, TheoryRelation>
	/** The declared unit a relation's rows sit under: an ordinary relation's by the schema's unit statements, a stored
	 * derived relation's by its admission (ir/unit.ts StoredUnit `declared`). */
	readonly memberOf: (relation: string) => DeclaredMember | undefined
	/** Its derived analysis, run only where it is stored otherwise. */
	readonly analyze: () => Result.Result<DerivedRelationAnalysis, CompileError>
}

/** A derived relation read live, for `why`. */
const live = (why: LiveReason): DerivedHolding => Object.freeze({ kind: "live", why })

/**
 * Where a derived relation's rows live (see the header), each condition tried in turn, the first it lacks its reason:
 * its definition is unit-local within one declared unit, and its table holds its rows.
 */
export const derivedHolding = (input: HoldingInput): DerivedHolding => {
	const { owned, relation } = input
	const unit = storedUnit(input.definition, input.known, unfitCall(owned), input.memberOf)
	if ("condition" in unit) {
		return live({ kind: "notUnitLocal", lacks: unit })
	}
	const analyzed = input.analyze()
	if (!analyzed.ok) {
		return live({ kind: "unrepresentable", refusal: analyzed.error })
	}
	return Object.freeze({
		kind: "stored",
		analysis: analyzed.value,
		relation: storedRelationOf(analyzed.value, relation.ident, relation.desc.level, unit)
	})
}

/**
 * The ordinary relations `relation`'s definition reads at any depth, in name order: each it matches or filters by, and
 * each a derived relation it names reads in turn, its holders.
 */
export const holdersOf = (owned: Owned, relation: OwnedDerived): ReadonlyArray<string> => {
	const seen = new Set<string>()
	const holders: Array<string> = []
	const visit = (name: string): void => {
		if (seen.has(name)) {
			return
		}
		seen.add(name)
		const r = owned.relations[name]
		if (r?.kind === "derived") {
			r.reads.forEach(visit)
		} else if (r?.kind === "relation") {
			holders.push(name)
		}
	}
	relation.reads.forEach(visit)
	return holders.toSorted(compareStrings)
}

/**
 * Why a call of the declared function `fn` is no fit for a stored relation's definition, none where it is one: it, or a
 * function its body calls at any depth, is not immutable. grizzle never reads a body, so a function's declared volatility
 * and its declared calls are the author's promise, as PostgreSQL's IMMUTABLE is.
 */
const unfitCall =
	(owned: Owned) =>
	(fn: string): string | undefined => {
		const seen = new Set<string>()
		const pending = [fn]
		for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
			if (seen.has(at)) {
				continue
			}
			seen.add(at)
			const desc = owned.functions[at]?.desc
			if (desc === undefined) {
				return `which this schema declares nowhere`
			}
			if (desc.volatility !== "immutable") {
				return at === fn
					? `which is ${desc.volatility}`
					: `whose body calls ${at}, which is ${desc.volatility}`
			}
			for (const called of desc.calls) {
				pending.push(called)
			}
		}
		return undefined
	}

/** A proven key of a derived relation (analysis/derived/analyze.ts), with its unique index's name and its proof. */
type ProvenKey = DerivedRelationAnalysis["keys"][number]

/**
 * A stored relation's primary key, led by the fields its head delivers its unit at (ir/unit.ts StoredUnit `fields`), so
 * the upkeep's delete of its rows at a unit, and every read of them at one, a stored relation's above it among them, is
 * a range of the key's index: `proven`, the first of its proven keys, narrowest first, that holds every unit field, its
 * fields reordered unit first; or `superkey`, where none holds them, the unit's fields and then the narrowest key's
 * others, a superkey of it. `named` are the fields the key is named by (core/identity.ts derivedKey): a proven key's
 * own, which name its unique index for every reader (laws/model/catalog.ts derivedKeyConstraints), or the superkey's in
 * the heading's order, the code point order of their names, as a proven key's stand, so a superkey and the proven key
 * of the same fields it stands for where a proven key narrower than both appears are one name, one installed key.
 * Every proven key but a `proven` one keeps a unique index of its own.
 */
export type StoredPrimaryKey =
	| {
			readonly kind: "proven"
			readonly fields: NonEmptyReadonlyArray<string>
			readonly named: NonEmptyReadonlyArray<string>
			readonly key: ProvenKey
	  }
	| {
			readonly kind: "superkey"
			readonly fields: NonEmptyReadonlyArray<string>
			readonly named: NonEmptyReadonlyArray<string>
			readonly of: ProvenKey
	  }

/** The primary key of a stored relation of proven keys `keys`, narrowest first, at its unit's fields `unit`
 * (StoredPrimaryKey). */
export const storedPrimaryKey = (
	keys: ReadonlyArray<ProvenKey>,
	unit: NonEmptyReadonlyArray<string>
): StoredPrimaryKey => {
	const [narrowest] = keys
	if (narrowest === undefined) {
		throw defect("the proven keys of a derived relation, its heading's at least")
	}
	const led = (fields: ReadonlyArray<string>): NonEmptyReadonlyArray<string> => {
		const [u0, ...us] = unit
		return [u0, ...us, ...fields.filter((f) => !unit.includes(f))]
	}
	const holding = keys.find((k) => unit.every((f) => k.fields.includes(f)))
	if (holding === undefined) {
		const fields = led(narrowest.fields)
		const [first, ...rest] = fields.toSorted(compareStrings)
		if (first === undefined) {
			throw defect("a key of at least one field")
		}
		return { kind: "superkey", fields, named: [first, ...rest], of: narrowest }
	}
	return { kind: "proven", fields: led(holding.fields), named: holding.fields, key: holding }
}

/** The proven keys of `keys` a stored relation keys by `primary` holds each a unique index of: all but its primary's. */
export const storedSecondaryKeys = (
	keys: ReadonlyArray<ProvenKey>,
	primary: StoredPrimaryKey
): ReadonlyArray<ProvenKey> => keys.filter((k) => primary.kind !== "proven" || k !== primary.key)

/**
 * A stored derived relation as the theory reads it (ir/law.ts StoredDerivedRelation): its analysis `a`'s heading as its
 * fields, each named as its table's column (physical/ddl/names.ts viewColumn) and written by its upkeep alone; its
 * primary key led by its unit (`storedPrimaryKey`), and every other proven key, each named by its index; its table
 * `ident`, its level and its admitted unit.
 */
const storedRelationOf = (
	a: DerivedRelationAnalysis,
	ident: RelationIdent,
	level: number,
	unit: StoredUnit
): StoredDerivedRelation => {
	const fields = mapNonEmpty(a.heading, (c, position): LawField => ({
		name: c.name,
		type: c.type,
		desc: c.desc,
		column: identifierOf(identity.column(c.name)),
		position,
		writing: { kind: "caller" }
	}))
	const field = (name: string): LawField =>
		defined(
			fields.find((f) => f.name === name),
			`the field ${name} of stored relation ${a.name}`
		)
	const primary = storedPrimaryKey(a.keys, unit.fields)
	const secondary = storedSecondaryKeys(a.keys, primary)
	const primaryKey = primary.fields
	const primaryFields = mapNonEmpty(primaryKey, field)
	const keyFields = secondary.map((k) => mapNonEmpty(k.fields, field))
	return Object.freeze({
		kind: "stored",
		name: StoredRelationName(a.name),
		ident,
		fields,
		heading: fields,
		primaryKey,
		keys: secondary.map((k) => k.fields),
		primaryFields,
		keyFields,
		keyNames: [
			{
				fields: primaryFields,
				span: undefined,
				primary: true,
				named: identity.derivedKey(a.name, primary.named)
			},
			...secondary.map((k, i) => ({
				fields: defined(keyFields[i], "a proven key's fields"),
				span: undefined,
				primary: false,
				named: identity.derivedKey(a.name, k.fields)
			}))
		],
		mutable: false,
		level,
		loc: a.loc,
		unit,
		read: a.read
	})
}
