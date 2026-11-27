/**
 * How grizzle keeps a stored derived relation equal to its definition at COMMIT (the judge's phase A,
 * physical/ddl/rules.ts upkeepBlock), its upkeep's form, chosen when the schema compiles from what its definition is
 * (`classOf`), one form for each class:
 *
 * - `founded`: its declared unit sealed (analysis/theory/frozen.ts foundedAt), so the one transaction that founds a key
 *   writes every row of every holder there and no other write changes them: its upkeep is the unit form, the definition
 *   read at the units the founding write wrote, each fact derived once, the optimum for a write whose delta is its unit;
 * - `checked`: every arm a join of relations, each negation of one relation, and each rule's every match reached from
 *   its head by a key, so a fact's every derivation is read at the fact by one probe of each relation's key (the rule's
 *   closure from its head, analysis/theory/unit.ts ruleClosures). Its upkeep is its delta program, both ways: the facts
 *   a write withdraws (`lost`, analysis/theory/query.ts lostFacts), the candidates a containment's lost probe reads of
 *   its target, each a whole fact checked at the fact against the definition as it stands at COMMIT, deleted from the
 *   table, by its heading, where no rule derives it any longer; then the facts a write gains, read from the rows it added and
 *   from the rows a negation no longer finds, outward (`gained`, query.ts gainedFacts), inserted where the table lacks
 *   them. No write reads the unit a fact lies in: an open holder's update costs the rows it wrote, as a served insert
 *   does, and a closed holder's removed rows are read by none, a data step's bracket refilling the table instead
 *   (physical/ddl/recheck.ts);
 * - `monotone`: every arm a join of relations read positively, none negated, but some rule not reached from its head
 *   by keys alone, so a fact lost cannot be checked at the fact by probes. A write makes it lose a fact only by removing
 *   a row one of its derivations read: its upkeep is the facts each write gains, as the checked form's, and the units
 *   the rows a transaction removed touch, re-derived as a unit form re-derives them (analysis/theory/unit.ts unitForm
 *   over the removed sides). A closed holder loses a row only to a migration's data step, the one writer that removes a
 *   closed fact (physical/ddl/immutable.ts), whose bracket refills the table (physical/ddl/recheck.ts), so over closed
 *   holders alone the upkeep reads what a write gains and nothing of the unit it lies in (ClosedLoss);
 * - `other`: any other definition, the units a transaction wrote and the definition read at them, which replaces the
 *   stored rows there (analysis/theory/unit.ts restrictToUnits): a sealed unit's founding write, whose delta is the whole
 *   unit, and every definition no delta form keeps yet, an aggregate's, a negation's not reached from its head, a
 *   recursion's.
 *
 * A delta form is exact for every write: a fact the definition lost lost each of its derivations, each of which read a
 * row the transaction removed, or meets a row a negation reads that it added, which a lost rule of that occurrence
 * reads as a candidate and the check deletes, or, for a monotone form, a removed row at the fact's own unit, which it
 * re-derives; a fact it gained derives from a row the transaction added or a row a negation no longer finds, which a
 * gained rule of that occurrence reads; and a fact a gained rule inserts is one the definition derives as the
 * transaction leaves its holders, inserted by the table's key, one the definition proves.
 */
import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { TupleSet } from "@bjornpagen/grizzle-text/base/tuple-map"
import {
	gainedFacts,
	isClosedRelation,
	type LiveArm,
	type LiveEnv,
	liveArms,
	lostFacts,
	type ProbeSide,
	type Proofs,
	queryOf,
	type RegionSide,
	sharedCalls,
	type StoredAt
} from "#compiler/analysis/theory/query.ts"
import {
	holderReads,
	type RegionFacts,
	type RegionRead,
	type RuleClosure,
	ruleClosures,
	solvedConjuncts,
	type StoredUpkeep,
	storedUpkeep,
	type UnitForm,
	unitForm
} from "#compiler/analysis/theory/unit.ts"
import { catchRefusal } from "#compiler/core/canonical.ts"
import type { UncheckedDelta } from "#compiler/core/causes.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type { FieldDesc, InferredQuery, InferredRule, InferredStage } from "#compiler/ir/desc.ts"
import type { StoredDerivedRelation, TheoryRelation } from "#compiler/ir/law.ts"
import type { StoredUnit } from "#compiler/ir/unit.ts"

/**
 * A stored relation's delta form (see the header): the facts each write gains, one query of a rule for each occurrence of
 * each holder in each arm on each side of its writes, over the rows the transaction wrote there, delivering the
 * definition's heading; and how it loses facts (`lost`): a checked form's lost rules (`CheckedLoss`), or a monotone
 * form's units the rows a transaction removed touch, re-derived (a unit form over the removed sides alone).
 */
export interface DeltaForm {
	readonly kind: "delta"
	readonly gained: InferredQuery
	readonly lost: CheckedLoss | UnitForm | ClosedLoss
}

/**
 * The loss of a delta form whose every holder is closed and none negated where a row it gains could withdraw a fact:
 * no served write removes a row any derivation of its facts reads, so no write makes it lose one, and its upkeep reads
 * no side of what a write removes. A migration's data step, which drops the guards, makes the stored relation its
 * definition's rows again in its own transaction (physical/ddl/recheck.ts).
 */
export interface ClosedLoss {
	readonly kind: "closed"
}

/**
 * The facts a checked form's write withdraws (analysis/theory/query.ts lostFacts): one query of a rule for each
 * candidate, each delivering a fact its definition no longer derives, which the upkeep deletes from the table.
 */
export interface CheckedLoss {
	readonly kind: "checked"
	readonly query: InferredQuery
}

/**
 * What a definition is to its upkeep (see the header): founded, its declared unit sealed; checked, with its live arms and
 * its lost rules; monotone, with its live arms; or anything else, which a delta form does not keep.
 */
type UpkeepClass =
	| { readonly kind: "founded" }
	| {
			readonly kind: "checked"
			readonly arms: NonEmptyReadonlyArray<LiveArm>
			readonly lost: DeltaRules
	  }
	| { readonly kind: "monotone"; readonly arms: NonEmptyReadonlyArray<LiveArm> }
	| { readonly kind: "other" }

/**
 * A definition's delta class, read live under its environment (see the header): `checked`, with its live arms and its
 * lost rules; `unchecked`, its arms matching tables alone but no checked form, and why (`UncheckedDelta`); or `unread`,
 * no arms a delta form reads, and why. The one decision both the storage admission (analysis/derived/storage.ts) and
 * the upkeep (`classOf`) read.
 */
export type DeltaClass =
	| {
			readonly kind: "checked"
			readonly arms: NonEmptyReadonlyArray<LiveArm>
			readonly lost: DeltaRules
	  }
	| {
			readonly kind: "unchecked"
			readonly arms: NonEmptyReadonlyArray<LiveArm>
			readonly why: UncheckedDelta
	  }
	| { readonly kind: "unread"; readonly why: UncheckedDelta }

/** What a definition's delta class is decided over (`deltaClassOf`). */
export interface DeltaInput {
	/** The stored relation's name. */
	readonly name: string
	/** The query its table holds, read live. */
	readonly definition: InferredQuery
	/** The fields of its heading, each a column of its table. */
	readonly heading: NonEmptyReadonlyArray<string>
	/** Where its lost facts are read at the fields a candidate binds (query.ts StoredAt): its table, where a derived
	 * relation of the schema names it, at its unit's fields. */
	readonly table: StoredAt
	/** The stored unit it is admitted at. */
	readonly stored: StoredUnit
	/** The ordinary and closed relations of the schema and the stored derived relations of the levels below its own. */
	readonly known: ReadonlyMap<string, TheoryRelation>
	readonly env: LiveEnv
	/** Whether a served write changes rows of `relation` the stored relation reads: an ordinary relation's or a stored
	 * one's, but a relation it reads by reference (ir/unit.ts StoredUnit `references`), whose rows at the keys its units
	 * name no write changes once a unit names them, so no delta rule reads its writes. */
	readonly holder: (relation: string) => boolean
	/** The field a relation's column is, which types each computed equality a delta rule states solved. */
	readonly fieldOf: (relation: string, field: string) => FieldDesc | undefined
	/**
	 * What its delta rules prove a cover by (analysis/theory/query.ts Proofs), so a rule reads no occurrence a sibling of
	 * its arm covers (a closed parent's rows beside the children that pin it), every fact through it one the sibling's
	 * rule reads: the schema's containments and keys at its upkeep (analysis/theory/theory.ts); none at its admission
	 * (analysis/schema.ts), which reads no region facts, so a definition only a cover keeps checked is admitted by its
	 * unit, never by its delta form.
	 */
	readonly proofs: Proofs
	readonly loc: SourceLoc
}

/** What a stored relation's upkeep is built from (`upkeepOf`). */
export interface UpkeepInput extends DeltaInput {
	/** The stored relation, as admission stores it. */
	readonly relation: StoredDerivedRelation
	/** Whether its declared unit is founded (analysis/theory/frozen.ts foundedAt): sealed, every row of it written by the
	 * one transaction that founds it. */
	readonly founded: boolean
	/** How its admission bounds its upkeep (analysis/derived/storage.ts UpkeepBound): by its unit's key, or by its
	 * delta form (`deltaBoundOf`), checked or monotone over closed relations, which its class must then be. */
	readonly bound: "unit" | "delta"
	/** That query with each bare literal its heads deliver typed at its table's column (leaves.ts typedHeads). */
	readonly typed: InferredQuery
	readonly facts: RegionFacts
}

/** Both sides of a holder's writes, each of which a checked form reads: what a write adds and what it removes. */
const bothSides: NonEmptyReadonlyArray<ProbeSide> = ["added", "removed"]

/** The upkeep of a stored relation (see the header), its form its class's (`classOf`). */
export const upkeepOf = (u: UpkeepInput): StoredUpkeep => {
	const c = classOf(u)
	if (u.bound === "delta" && c.kind !== "checked" && c.kind !== "monotone") {
		defect(`stored relation ${u.name}, admitted for its delta form, a delta class`)
	}
	switch (c.kind) {
		case "founded":
		case "other":
			return storedUpkeep(u.name, u.typed, u.stored, u.known, u.facts, u.loc)
		case "checked": {
			const gained = gainedQuery(u, c.arms, bothSides)
			const [first, ...rest] = c.lost.rules
			return first === undefined
				? deltaUpkeep(u, gained, { kind: "closed" }, [])
				: deltaUpkeep(
						u,
						gained,
						{ kind: "checked", query: queryOf([first, ...rest], u.loc) },
						c.lost.touched
					)
		}
		case "monotone": {
			const gained = gainedQuery(u, c.arms, ["added"])
			if (heldBy(c.arms, u.holder).every((r) => closedIn(u, r))) {
				return deltaUpkeep(u, gained, { kind: "closed" }, [])
			}
			const removed = unitForm(u.typed, u.stored, u.known, u.facts, u.loc, "negative")
			return deltaUpkeep(u, gained, removed.form, removed.sides)
		}
	}
}

/**
 * Whether `relation` is a closed holder of the stored relation's definition (query.ts isClosedRelation), whose rows no
 * served write removes, so no rule of its upkeep reads its side of what a write removes.
 */
const closedIn = (u: DeltaInput, relation: string): boolean =>
	isClosedRelation(u.known.get(relation))

/** The sides of `relation`'s writes the upkeep's rules read: what a write adds, and, where it is mutable, what it removes. */
const sidesOf = (
	u: DeltaInput,
	relation: string,
	sides: NonEmptyReadonlyArray<ProbeSide>
): ReadonlyArray<ProbeSide> => sides.filter((side) => side === "added" || !closedIn(u, relation))

/**
 * The rules of one part of a delta form, each over a holder's side, and the sides they read (`touched`), each with the
 * fields its rules' region binds of the holder.
 */
interface DeltaRules {
	readonly rules: ReadonlyArray<InferredRule>
	readonly touched: ReadonlyArray<RegionSide>
}

/** The gained part of a delta form (`gainedQuery`): its one query, and the sides its rules read (DeltaRules `touched`). */
interface GainedRules {
	readonly query: InferredQuery
	readonly touched: ReadonlyArray<RegionSide>
}

/**
 * The upkeep of a stored relation by its delta form, `gained` and `lost`, its reads every holder's at both polarities,
 * and the sides of each holder its rules read (`touched`, and a unit form's lost region's), each with the columns every
 * read of the holder binds.
 */
const deltaUpkeep = (
	u: UpkeepInput,
	gained: GainedRules,
	lost: CheckedLoss | UnitForm | ClosedLoss,
	lostSides: ReadonlyArray<RegionSide>
): StoredUpkeep => {
	const reads = holderReads(u.typed, u.stored, u.known)
	const columnsOf = (relation: string): ReadonlyArray<string> =>
		[...new Set(reads.flatMap((r) => (r.relation === relation ? r.columns : [])))].toSorted(
			compareStrings
		)
	const touched = new TupleSet<ReadonlyArray<string>>()
	const sides: Array<RegionSide> = []
	for (const t of [...gained.touched, ...lostSides]) {
		if (touched.has([t.relation, t.side])) {
			continue
		}
		touched.add([t.relation, t.side])
		const [first, ...rest] = columnsOf(t.relation)
		sides.push({
			relation: t.relation,
			side: t.side,
			columns: first === undefined ? t.columns : [first, ...rest]
		})
	}
	return Object.freeze({
		relation: u.name,
		stored: u.stored,
		reads,
		sides,
		form: Object.freeze({ kind: "delta", gained: gained.query, lost }),
		loc: u.loc
	})
}

/**
 * The class of a stored relation's definition (see the header), read live under its environment: founded where its
 * declared unit is sealed, whose founding write's delta is the whole unit, which a unit form derives once where a delta
 * form would derive each fact again from each occurrence's rows; else checked where its delta class is
 * (`deltaClassOf`); monotone where its arms match relations alone and negate none; any other where an arm folds or reads
 * a definition of several rules, or where the probes cannot read it as arms at all (a recursion, an attachment, an order
 * and take), which liveArms refuses.
 */
const classOf = (u: UpkeepInput): UpkeepClass => {
	if (u.founded) {
		return { kind: "founded" }
	}
	const c = deltaClassOf(u)
	switch (c.kind) {
		case "checked":
			return c
		case "unchecked":
			return c.arms.every((arm) => arm.negated.length === 0)
				? { kind: "monotone", arms: c.arms }
				: { kind: "other" }
		case "unread":
			return { kind: "other" }
	}
}

/**
 * The delta class of `d`'s definition (DeltaClass): checked where its live arms (query.ts liveArms) match relations
 * alone and negate relations alone, every rule of its definition is reached from its head by keys or seeks
 * (`unreachedRule`), and every candidate of a fact it loses binds the fact's whole heading or is read from its table at
 * more than its unit's fields (query.ts lostFacts); the first condition it lacks otherwise. A checked form's upkeep costs
 * what its delta does at any width of its unit: it reads each fact a write gains from the rows the write wrote outward
 * and checks each fact it may withdraw at the fact, one probe of a key or one seek of each relation, and never reads the
 * rest of the unit.
 */
export const deltaClassOf = (d: DeltaInput): DeltaClass => {
	const read = catchRefusal(() => liveArms(d.name, d.definition, d.env))
	if (!read.ok) {
		return { kind: "unread", why: { reason: "arms", detail: read.error.message } }
	}
	const arms = read.value
	const query = arms.flatMap((arm) => arm.matches.flatMap((m) => (m.kind === "stored" ? [] : [m])))
	if (query.length > 0) {
		return {
			kind: "unread",
			why: {
				reason: "match",
				detail: "an arm matches a definition of several rules or a fold's groups, read as a query"
			}
		}
	}
	const negatedQuery = arms.some((arm) => arm.negated.some((n) => n.source.kind !== "relation"))
	if (negatedQuery) {
		return {
			kind: "unchecked",
			arms,
			why: { reason: "negation", detail: "an arm negates a query, not one relation" }
		}
	}
	const unreached = unreachedRule(d)
	if (unreached !== undefined) {
		return { kind: "unchecked", arms, why: { reason: "unreached", detail: unreached } }
	}
	const lost = lostRules(d, arms)
	return lost === undefined
		? {
				kind: "unchecked",
				arms,
				why: {
					reason: "loss",
					detail: "a fact a write may withdraw leaves a field of its heading free"
				}
			}
		: { kind: "checked", arms, lost }
}

/**
 * How a definition's delta form bounds its upkeep where its unit bounds none (analysis/derived/storage.ts boundOf):
 * `checked`, its delta class checked (`deltaClassOf`), each fact a write gains read from the rows it wrote outward and
 * each fact it may withdraw checked at the fact, by probes of keys; `monotone`, its arms joining relations alone and
 * negating none, every relation they hold an ordinary one no served write updates or deletes, closed, so a served write
 * gains facts alone, each read from the rows it wrote outward, and only a migration's data step removes a row, whose
 * bracket makes the table its definition's rows again (physical/ddl/recheck.ts, the form's loss ClosedLoss); or
 * `unbounded`, with why its delta form is no checked one. Either bound costs what a served write's delta does at any
 * width of its unit: ledger's TestSnapshot, each response snapshot of a sitting's item session at the learner, whose
 * sittings and item sessions are keyed apart, is checked, a removed snapshot's stage read from its table at the
 * snapshot; each snapshot of an enrolled learner, the enrolment matched first, whose removal's candidate is the learner
 * alone, is monotone over closed relations.
 */
export type DeltaBound =
	| { readonly kind: "checked" }
	| { readonly kind: "monotone" }
	| { readonly kind: "unbounded"; readonly why: UncheckedDelta }

/** How `d`'s delta form bounds its upkeep (`DeltaBound`). */
export const deltaBoundOf = (d: DeltaInput): DeltaBound => {
	const c = deltaClassOf(d)
	switch (c.kind) {
		case "checked":
			return { kind: "checked" }
		case "unchecked": {
			if (c.arms.some((arm) => arm.negated.length > 0)) {
				return { kind: "unbounded", why: c.why }
			}
			const open = heldBy(c.arms, d.holder).find((r) => {
				const held = d.known.get(r)
				return held?.kind !== "relation" || held.mutable
			})
			return open === undefined
				? { kind: "monotone" }
				: {
						kind: "unbounded",
						why: {
							reason: "open",
							detail: `it holds ${open}, open or stored, whose rows a served write removes`
						}
					}
		}
		case "unread":
			return { kind: "unbounded", why: c.why }
	}
}

/**
 * Why some rule of the stored relation's definition is not reached from its head by keys, none where every one is: each
 * rule an outermost rule of it whose every occurrence of a holder its closure from its head's variables reaches by a key
 * (analysis/theory/unit.ts ruleClosures, StepBy `key`): one probe of a key of each, its fields bound by the head, by a
 * constant or by an occurrence reached before it, so the definition read at one fact reads at most one row of each
 * occurrence; or by a seek, an existence test of one occurrence at the fields the closure binds, one descent of an index
 * of them (StepBy `seek`), whose rows' changes name the facts they move by a key read of their own: the closure from the
 * seek's bound fields alone binds every variable of the head by keys, so each changed row of it moves the one fact its
 * fields name (`movedByKey`). A step by a successor or a probe reads more than one row's index entry for some fact, and an
 * occurrence the closure does not reach is read across a part of its key. The index each key and seek reads is the index
 * engine's to infer, a missing one an internal compiler error (physical/ddl/rules.ts programRequests).
 */
const unreachedRule = (d: DeltaInput): string | undefined => {
	const outermost = new Set(outermostRules(d.definition.stage))
	for (const { rule, close } of ruleClosures(d.definition, d.known, d.stored)) {
		if (!outermost.has(rule)) {
			return "a rule of a query it imports is read beside its own"
		}
		const head = Object.values(rule.head).flatMap((h) => (h.kind === "var" ? [h.var] : []))
		const closure = close(new Set(head))
		const [left] = closure.unreached
		if (left !== undefined) {
			return `its head reaches ${left.relation} by no key`
		}
		for (const step of closure.steps) {
			switch (step.by) {
				case "key":
					break
				case "seek": {
					const moved = movedByKey(step.read, closure.keyed, head, close)
					if (moved !== undefined) {
						return moved
					}
					break
				}
				case "successor":
				case "probe":
					return `its head reaches ${step.read.relation} by a ${step.by}, not a key`
			}
		}
	}
	return undefined
}

/**
 * Why a change of the rows a seek reads, `read` at the fields `keyed` binds, moves no one fact its fields name, none
 * where it does (`unreachedRule`): the closure from those fields alone, the rule's `close`, binds every variable of the
 * rule's `head` by keys, so a changed row of it names its one fact by a key read; where it binds some head variable by
 * no key, a changed row moves every fact of the rows that variable ranges over.
 */
const movedByKey = (
	read: RegionRead,
	keyed: ReadonlySet<string>,
	head: ReadonlyArray<string>,
	close: (start: ReadonlySet<string>) => RuleClosure
): string | undefined => {
	const at = Object.entries(read.bound).filter(([, v]) => keyed.has(v))
	const back = close(new Set(at.map(([, v]) => v)))
	const missing = head.find((v) => !back.keyed.has(v))
	return missing === undefined
		? undefined
		: `a row of ${read.relation} its head reaches by a seek at (${at.map(([f]) => f).join(", ")}) names its facts by no key: ${missing} is bound by no key from them`
}

/** The rules of a query's outermost stages: its rules, a union's input's and arms, a name's input's. */
const outermostRules = (stage: InferredStage): ReadonlyArray<InferredRule> => {
	switch (stage.kind) {
		case "rules":
			return stage.arms
		case "union":
			return [...outermostRules(stage.input), ...stage.arms]
		case "named":
			return outermostRules(stage.input)
		case "recursive":
		case "attach":
		case "order":
		case "take":
		case "approx":
			return []
	}
}

/**
 * The lost rules of a checked form (CheckedLoss): for each holder its arms read, a positive match's or a negation's, and
 * each side of its writes, a closed holder's added rows alone (`sidesOf`), the facts that write withdraws (query.ts
 * lostFacts), each computed equality stated solved (`withSolved`); undefined where a candidate leaves a field of the
 * heading free. None where every holder is closed and none is negated, the loss a closed form's (ClosedLoss).
 */
const lostRules = (u: DeltaInput, arms: NonEmptyReadonlyArray<LiveArm>): DeltaRules | undefined => {
	const heading = u.heading
	const rules: Array<InferredRule> = []
	const touched: Array<RegionSide> = []
	for (const r of heldBy(arms, u.holder)) {
		for (const side of sidesOf(u, r, bothSides)) {
			const lost = lostFacts(arms, r, side, heading, u.table, u.loc, u.proofs)
			if (lost === undefined) {
				return undefined
			}
			if (isNonEmpty(lost)) {
				touched.push({ relation: r, side, columns: heading })
			}
			appendAll(
				rules,
				lost.map((rule) => withSolved(rule, u.fieldOf))
			)
		}
	}
	return { rules, touched }
}

/**
 * The facts a delta form gains (DeltaForm `gained`): for each holder its arms read and each of `sides` its writes have,
 * a closed holder's added rows alone (`sidesOf`), the facts that write gains (query.ts gainedFacts), no occurrence a
 * sibling covers among them, each computed equality stated solved (`withSolved`). A monotone form's are the added
 * side's alone, a removal gaining none of its facts.
 */
const gainedQuery = (
	u: UpkeepInput,
	arms: NonEmptyReadonlyArray<LiveArm>,
	sides: NonEmptyReadonlyArray<ProbeSide>
): GainedRules => {
	const touched: Array<RegionSide> = []
	const rules = heldBy(arms, u.holder).flatMap((r) =>
		sidesOf(u, r, sides).flatMap((side) => {
			const gained = gainedFacts(arms, r, side, u.loc, u.proofs)
			if (isNonEmpty(gained)) {
				touched.push({ relation: r, side, columns: u.heading })
			}
			return gained.map((rule) => withSolved(rule, u.fieldOf))
		})
	)
	const [first, ...rest] = rules
	if (first === undefined) {
		defect(`the gained rules of stored relation ${u.name}, one for each holder no sibling covers`)
	}
	return { touched, query: sharedCalls([first, ...rest], u.loc) }
}

/** The holders `arms` read, a match's relation or a negated one's, each once, in name order. */
const heldBy = (
	arms: NonEmptyReadonlyArray<LiveArm>,
	holder: (relation: string) => boolean
): ReadonlyArray<string> =>
	[
		...new Set(
			arms.flatMap((arm) => [
				...arm.matches.flatMap((m) => (m.kind === "stored" ? [m.relation] : [])),
				...arm.negated.flatMap((n) => (n.source.kind === "relation" ? [n.source.name] : []))
			])
		)
	]
		.filter(holder)
		.toSorted(compareStrings)

/**
 * `rule`, a delta rule over the rows a write wrote, with each computed equality of its conditions stated solved for the
 * variable those rows leave free where the equality is injective in it (analysis/theory/unit.ts solvedConjuncts), in that
 * variable's own type, its field's by its origin (`fieldOf`): `k = next.k - 1` beside `next.k = k + 1`, so navigation
 * reads k's relation by the key k completes, one probe, where the equality alone left the relation read across the unit
 * and filtered (SittingOrder's suspension of a candidate session, from the next session's visit). The rows its first
 * match, the delta's, binds are bound.
 */
const withSolved = (
	rule: InferredRule,
	fieldOf: (relation: string, field: string) => FieldDesc | undefined
): InferredRule => {
	const [delta] = rule.matches
	const bound = new Set(
		Object.values(delta?.bindings ?? {}).flatMap((e) => (e.kind === "var" ? [e.var] : []))
	)
	const origins = new Map(rule.vars.map((v) => [v.id, v.origin] as const))
	const fieldOfVar = (x: string): FieldDesc | undefined => {
		const origin = origins.get(x)
		return origin === undefined ? undefined : fieldOf(origin.relation, origin.field)
	}
	return { ...rule, where: [...rule.where, ...solvedConjuncts(rule, bound, fieldOfVar)] }
}
