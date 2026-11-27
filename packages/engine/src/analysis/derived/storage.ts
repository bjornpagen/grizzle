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
 * - its upkeep costs what the delta that runs it bounds (`deltaBounded`): its unit narrower than its declared unit, its
 *   key wider than the declared unit's, so a write re-derives the stored rows at the keys it touched alone, never the
 *   rest of the unit it borrows, and its definition rooted there (analysis/theory/unit.ts unitRooted), one holder's rows
 *   at the key binding a declared key of every other holder it reads, so the re-derivation reads the root's rows at the
 *   key and one row of each other holder for each, where a holder read at a prefix of the key beside another's rows
 *   would be read whole for each of them at every write (ledger's presentedSpans, each presentation's moments of the
 *   sitting, 180 to 244 pages a call); or its unit's key holding a declared key of every holder it reads, so it reads one
 *   row of each at a key; or its declared unit is
 *   sealed (schema/own.ts OwnedUnit `sealed`), so every row of every holder at a key is written by the one transaction
 *   that founds the key (analysis/theory/frozen.ts foundedAt), and the upkeep runs at that founding write alone, whose
 *   delta is the whole unit; or, its unit bounding none of these, its upkeep is a delta form that bounds it
 *   (analysis/theory/upkeep.ts deltaBoundOf, `UpkeepBound` `delta`): checked, its arms joining and negating relations
 *   alone, every rule reached from its head by keys, so a write reads each fact it gains from the rows it wrote outward
 *   and checks each fact it may withdraw at the fact, by probes of keys; or monotone over closed relations, so a
 *   served write only gains facts, read from the rows it wrote, and a data step's removal re-derives the units it
 *   touched; either whatever the width of its unit, as ledger's TestSnapshot, each response snapshot of a sitting's
 *   item session, stands at the learner, its sittings and item sessions keyed apart;
 * - its table can hold its rows: derived analysis admits its heading and its keys (analysis/derived/analyze.ts);
 * - and its rows are no relation's own, projected onto a key of it (`copiedRelation`): such a table would copy the
 *   relation, which every reader reads as cheaply by its key index, its upkeep costing every write for no gain.
 *
 * A head that hides its unit, which every rule of the definition binds, is no obstacle where the head determines it:
 * each rule matches one relation, the same in every rule, binding the unit at a field of it and one of its keys at
 * fields the head delivers (analysis/theory/unit.ts HiddenUnit), so no two of its facts at one head lie in two units.
 * Its table then holds the definition with its head extended by the unit's fields (unit.ts withUnitHeads), unit-local
 * at them, which its upkeep deletes and writes its rows at, and every reader reads the head's columns alone, each fact
 * once (metis's DashboardEntry, each sitting's number a learner's by Assignment's key on it).
 *
 * Whether the relations it reads are closed decides nothing alone: a definition over closed relations alone that joins
 * rows of two units could lose a fact two writers inserted into the two at once, each blind to the other's, so it is
 * live; one over an open relation inside its unit is kept under the borrow its writers hold; and one whose upkeep
 * re-derives its whole declared unit at every write of it, a learner's whole history at each answer, its delta form no
 * checked one, is live, its readers reading its definition at the keys they bind, with why its delta form is none
 * (core/causes.ts UncheckedDelta). Every other derived relation is live (`LiveReason`). One rule decides it, once, where the checked schema reads its derived relations level by
 * level (analysis/schema.ts CheckedSchema), so a stored relation is one of the relations the levels above it read, and
 * every reader, a query, a rule, an upkeep and a role, reads the one decision.
 */
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type * as Result from "@bjornpagen/grizzle-text/base/result"
import type { DerivedRelationAnalysis, DerivedSubject } from "#compiler/analysis/derived/analyze.ts"
import { foundedAt, frozenAt } from "#compiler/analysis/theory/frozen.ts"
import {
	type HiddenUnit,
	storedUnit,
	type UnitFacts,
	unitKeyed,
	unitRooted
} from "#compiler/analysis/theory/unit.ts"
import type { DeltaBound } from "#compiler/analysis/theory/upkeep.ts"
import type { CompileError, LiveReason } from "#compiler/core/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { type RelationIdent, StoredRelationName } from "#compiler/core/ids.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type { InferredQuery, InferredRule, QueryDesc } from "#compiler/ir/desc.ts"
import type { LawField, StoredDerivedRelation, TheoryRelation } from "#compiler/ir/law.ts"
import type { StoredHolding, StoredUnit } from "#compiler/ir/unit.ts"
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
			/** The query whose rows its table holds, which its fill and upkeep compute: its definition, or that definition
			 * with its head extended by the unit's fields where the head hides them and determines them (see the header). */
			readonly rows: QueryDesc
			/** How its upkeep's cost is bounded (`UpkeepBound`). */
			readonly bound: UpkeepBound
	  }
	| { readonly kind: "live"; readonly why: LiveReason }

/**
 * How a stored relation's upkeep costs what its delta bounds (see the header): `unit`, by its unit (`deltaBounded`), its
 * unit's key, a root, a key at every read, or a founding write; or `delta`, by its delta form, checked or monotone over
 * closed relations (analysis/theory/upkeep.ts deltaBoundOf), whatever its unit's width, which its upkeep then takes.
 */
export type UpkeepBound = "unit" | "delta"

/** What a canonical relation's holding is decided over (`derivedHolding`). */
export interface HoldingInput {
	readonly owned: Owned
	readonly subject: DerivedSubject
	/** Its definition read live: every live derived relation it names read through its definition, every stored one by
	 * its table (analysis/theory/query.ts liveReading). */
	readonly definition: InferredQuery
	/** The ordinary and closed relations of the schema and the stored derived relations of the levels below its own. */
	readonly known: ReadonlyMap<string, TheoryRelation>
	/** The declared unit a relation's rows sit under, an ordinary relation's by the schema's unit statements and a stored
	 * derived relation's by its admission (ir/unit.ts StoredUnit `declared`), which units are sealed, and the containments
	 * the schema states, which a read by reference stands on (analysis/theory/unit.ts UnitFacts). */
	readonly units: UnitFacts
	/** Its derived analysis, run only where it is stored otherwise. */
	readonly analyze: () => Result.Result<DerivedRelationAnalysis, CompileError>
	/** How the delta form of a definition, read live, stored at a unit, bounds its upkeep (analysis/theory/upkeep.ts
	 * deltaBoundOf), over the one delta class its upkeep reads too: read only where its unit bounds no upkeep. */
	readonly deltaBound: (definition: InferredQuery, unit: StoredUnit) => DeltaBound
	/** Its definition with its head extended by `fields`, each rule of its outermost stages binding them to the variables
	 * of `vars` (analysis/theory/unit.ts withUnitHeads), where its head hides its unit. */
	readonly extended: (
		fields: NonEmptyReadonlyArray<string>,
		vars: ReadonlyArray<NonEmptyReadonlyArray<string>>
	) => ExtendedDefinition
}

/** A definition with its head extended by the unit it hides (HoldingInput `extended`): the extension, read live, and
 * its derived analysis, run only where it is stored otherwise. */
export interface ExtendedDefinition {
	readonly query: QueryDesc
	readonly definition: InferredQuery
	readonly analyze: () => Result.Result<DerivedRelationAnalysis, CompileError>
}

/** A derived relation read live, for `why`. */
const live = (why: LiveReason): DerivedHolding => Object.freeze({ kind: "live", why })

/**
 * Where a derived relation's rows live (see the header), each condition tried in turn, the first it lacks its reason:
 * its definition is unit-local within one declared unit, and its table holds its rows.
 */
export const derivedHolding = (input: HoldingInput): DerivedHolding => {
	const { owned, subject } = input
	const copied = copiedRelation(input.definition, input.known)
	if (copied !== undefined) {
		return live({ kind: "copy", relation: copied })
	}
	const unit = storedUnit(
		input.definition,
		input.known,
		unfitCall(owned),
		input.units,
		frozenAt(owned, subject.reads)
	)
	if ("condition" in unit) {
		return live({ kind: "notUnitLocal", lacks: unit })
	}
	if (unit.kind === "hidden") {
		return determinedHolding(input, unit)
	}
	return keptHolding(input, unit, input.definition, subject.query, input.analyze)
}

/**
 * The relation `definition` copies, where it copies one (LiveReason `copy`): one rule of one rules stage that matches one
 * relation R with a table, an ordinary relation or a stored derived one, binding each field it binds to a variable of
 * its own, and states no condition, interior or attachment, its head each a variable of the match, the fields of some
 * key of R among those it delivers. Its rows are R's own, one for each row of R, projected: a table of them would be a
 * second copy of R's rows, which no reader reads more cheaply than R's key index, and its upkeep would cost every write
 * of R for no reader's gain (edullm's ledger canonical e2506d21e151aaaa, item_session's key, 74 pages of upkeep at every
 * take on the helper's sd6 row). A closed relation, which no table holds, is no such R: a table of its rows is the one a
 * reader reads by key.
 */
const copiedRelation = (
	definition: InferredQuery,
	known: ReadonlyMap<string, TheoryRelation>
): string | undefined => {
	const stage = definition.stage
	if (stage.kind !== "rules" || stage.arms.length !== 1) {
		return undefined
	}
	const [rule] = stage.arms
	const [match, ...more] = rule.matches
	if (
		match?.source.kind !== "relation" ||
		more.length > 0 ||
		rule.where.length > 0 ||
		rule.interiors.length > 0 ||
		rule.attach.length > 0
	) {
		return undefined
	}
	const relation = match.source.name
	const r = known.get(relation)
	const fieldOf = new Map<string, string>()
	for (const [field, e] of Object.entries(match.bindings)) {
		if (e.kind !== "var" || fieldOf.has(e.var)) {
			return undefined
		}
		fieldOf.set(e.var, field)
	}
	const delivered = new Set<string>()
	for (const h of Object.values(rule.head)) {
		const field = h.kind === "var" ? fieldOf.get(h.var) : undefined
		if (field === undefined) {
			return undefined
		}
		delivered.add(field)
	}
	return r !== undefined &&
		r.kind !== "closed" &&
		[r.primaryKey, ...r.keys].some((key) => key.every((f) => delivered.has(f)))
		? relation
		: undefined
}

/**
 * The holding of a definition whose head hides its unit `hidden` and determines it (see the header): its extension's,
 * stored where the extension is unit-local with the unit's fields delivered, live for the condition it lacks, its
 * borrow's among them, or for the hidden unit where it delivers another.
 */
const determinedHolding = (input: HoldingInput, hidden: HiddenUnit): DerivedHolding => {
	const extension = input.extended(hidden.fields, hidden.vars)
	const unit = storedUnit(
		extension.definition,
		input.known,
		unfitCall(input.owned),
		input.units,
		undefined
	)
	if ("condition" in unit) {
		return live({ kind: "notUnitLocal", lacks: unit })
	}
	return unit.kind !== "unit" || !hidden.fields.every((f) => unit.fields.includes(f))
		? live({ kind: "notUnitLocal", lacks: hidden.lacks })
		: keptHolding(input, unit, extension.definition, extension.query, extension.analyze)
}

/**
 * The holding of a definition unit-local at `unit` whose table holds the rows of `rows`, read live as `definition`,
 * analyzed by `analyze`: stored where its upkeep costs what its delta bounds and its table holds its rows, live for the
 * first it lacks.
 */
const keptHolding = (
	input: HoldingInput,
	unit: StoredHolding,
	definition: InferredQuery,
	rows: QueryDesc,
	analyze: () => Result.Result<DerivedRelationAnalysis, CompileError>
): DerivedHolding => {
	const { owned, subject } = input
	if (unit.kind === "unit" && recursive(definition) && !foundedAt(owned, unit.declared.unit)) {
		return live({ kind: "recursion", unit: unit.declared.unit, fields: unit.fields })
	}
	const bound = boundOf(input, unit, definition)
	if (bound.kind === "unbounded") {
		return live(bound.why)
	}
	const analyzed = analyze()
	if (!analyzed.ok) {
		return live({ kind: "unrepresentable", refusal: analyzed.error })
	}
	return Object.freeze({
		kind: "stored",
		analysis: analyzed.value,
		relation: storedRelationOf(analyzed.value, subject.ident, subject.level, unit),
		rows,
		bound: bound.kind
	})
}

/**
 * How the upkeep of a relation admitted at `unit` over `definition` is bounded (`UpkeepBound`): by its unit where it is
 * (`deltaBounded`), a frozen relation's having no upkeep; else by its delta form where it bounds it
 * (analysis/theory/upkeep.ts deltaBoundOf); else unbounded, its upkeep re-deriving its whole declared unit at every
 * write of it, with why its delta form is no checked one.
 */
const boundOf = (
	input: HoldingInput,
	unit: StoredHolding,
	definition: InferredQuery
): { readonly kind: UpkeepBound } | { readonly kind: "unbounded"; readonly why: LiveReason } => {
	if (unit.kind !== "unit" || deltaBounded(input.owned, unit, input.known, definition)) {
		return { kind: "unit" }
	}
	const c = input.deltaBound(definition, unit)
	switch (c.kind) {
		case "checked":
		case "monotone":
			return { kind: "delta" }
		case "unbounded":
			return {
				kind: "unbounded",
				why: {
					kind: "unboundedUpkeep",
					unit: unit.declared.unit,
					fields: unit.fields,
					delta: c.why
				}
			}
	}
}

/**
 * Whether the upkeep of a stored relation admitted at `unit` over `definition` costs what its delta bounds (see the
 * header), its region (analysis/theory/unit.ts StoredUpkeep) the keys a write touched at the unit's width: its unit's
 * key wider than its declared unit's and its definition rooted at it (unit.ts unitRooted), so it reads the root's rows at
 * each and one row of every other holder for each; or every read of a holder at a declared key of it, a primary key or
 * any other, that the unit's variables bind (unit.ts unitKeyed), so it reads at most one row of each; or its declared
 * unit is founded (analysis/theory/frozen.ts foundedAt), so the one write that runs its upkeep at a key wrote every row
 * there.
 */
const deltaBounded = (
	owned: Owned,
	unit: StoredUnit,
	known: ReadonlyMap<string, TheoryRelation>,
	definition: InferredQuery
): boolean =>
	(unit.fields.length > unit.declared.fields.length && unitRooted(definition, known, unit)) ||
	unitKeyed(definition, known, unit) ||
	foundedAt(owned, unit.declared.unit)

/**
 * Whether `definition` recurses, in its own stages or a query it imports at any depth: a recursion over a unit no
 * founding write writes whole has no delta rule its upkeep can run (lane DELTAUP's dispatch), so it is live, its
 * readers reading its definition at the keys they bind; under a founded unit its upkeep runs at the founding write.
 */
const recursive = (definition: InferredQuery): boolean => {
	const seen = new Set<InferredQuery>()
	const visit = (q: InferredQuery): boolean => {
		if (seen.has(q)) {
			return false
		}
		seen.add(q)
		return stageRecursive(q.stage)
	}
	const stageRecursive = (stage: InferredQuery["stage"]): boolean => {
		switch (stage.kind) {
			case "recursive":
				return true
			case "rules":
				return stage.arms.some(armRecursive)
			case "union":
				return stageRecursive(stage.input) || stage.arms.some(armRecursive)
			case "attach":
			case "named":
			case "order":
			case "take":
			case "approx":
				return stageRecursive(stage.input)
		}
	}
	const armRecursive = (arm: InferredRule): boolean =>
		arm.matches.some((m) => m.source.kind === "query" && visit(m.source.query))
	return visit(definition)
}

/**
 * The ordinary relations a definition reading `reads` reads at any depth, in name order: each it matches or filters by,
 * and each a derived relation it names reads in turn, its holders.
 */
export const holdersOf = (owned: Owned, reads: ReadonlyArray<string>): ReadonlyArray<string> => {
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
	reads.forEach(visit)
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
 * own, which name its unique index for every reader (laws/model/catalog.ts derivedEvidence), or the superkey's in
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

/** The primary key of a stored relation of proven keys `keys`, narrowest first, at its unit's fields `unit`, none for
 * one frozen at the installation, whose primary key is its narrowest (StoredPrimaryKey). */
export const storedPrimaryKey = (
	keys: ReadonlyArray<ProvenKey>,
	unit: ReadonlyArray<string>
): StoredPrimaryKey => {
	const [narrowest] = keys
	if (narrowest === undefined) {
		defect("the proven keys of a derived relation, its heading's at least")
	}
	const led = (fields: NonEmptyReadonlyArray<string>): NonEmptyReadonlyArray<string> => {
		const [first, ...rest] = [...unit, ...fields.filter((f) => !unit.includes(f))]
		if (first === undefined) {
			defect("a key of at least one field")
		}
		return [first, ...rest]
	}
	const holding = keys.find((k) => unit.every((f) => k.fields.includes(f)))
	if (holding === undefined) {
		const fields = led(narrowest.fields)
		const [first, ...rest] = fields.toSorted(compareStrings)
		if (first === undefined) {
			defect("a key of at least one field")
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
	unit: StoredHolding
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
	const primary = storedPrimaryKey(a.keys, unit.kind === "unit" ? unit.fields : [])
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
				named: identity.derivedKey(a.name, a.ident, primary.named)
			},
			...secondary.map((k, i) => ({
				fields: defined(keyFields[i], "a proven key's fields"),
				span: undefined,
				primary: false,
				named: identity.derivedKey(a.name, a.ident, k.fields)
			}))
		],
		mutable: false,
		level,
		loc: a.loc,
		unit,
		read: a.read
	})
}
