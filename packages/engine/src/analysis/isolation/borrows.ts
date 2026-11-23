/**
 * The borrow rules a change member is proven by at READ COMMITTED, one member at a time (memberBorrows), and the one
 * order every call takes its locks in, over every member of an installation (lockOrder). No member's verdict reads
 * another's: an installation's facts (BorrowInstallation, built once from the IR) say which unit each relation's rows
 * sit under and what any role may do to each relation, and a member's own facts (analysis/isolation/facts.ts) say what
 * it reads and writes.
 *
 * The rules:
 *
 * - A write. An update or a delete of a relation is admitted only inside a unit: the statement reads the rows it
 *   changes at the unit's whole key, bound to the call (KeySource), so the call borrows the unit exclusively there. An
 *   insert into a unit's relation borrows the unit exclusively at the key its arbitration binds. An insert into a
 *   relation outside every unit is an insert-only append: no role updates or deletes the relation, and its
 *   arbitration, a read of mode `arbiter` sealed at a whole declared key, is decided by PostgreSQL's unique check.
 * - A read. A read of a unit's rows binding the unit's whole key is held, whatever its shape: negated, counted, one
 *   group per own row, the call borrowing the unit shared there (or exclusively, where it writes it at that key). A
 *   read of the call's own rows, of a relation no role writes, an arbitration and a read of a row an arbitration
 *   fixed are sealed (certify.ts ReadSeal). Outside every unit, a positive whole-key or counted read of an
 *   insert-only relation is an immutable fact, gated (below); a negated or counted read, or an arbitration of no whole
 *   key, of a relation a role inserts reads an absence no lock holds; and any other read of rows another call can
 *   write reads them without a borrow.
 * - The gate, for the immutable facts a member reads outside every unit: every row a write writes is joined with each
 *   such fact its statement reads, and, after a statement that read one, with a row its call wrote; and no such fact is
 *   first read after a write. A fact it misses then makes it write nothing, so its history is the one where it ran
 *   before the fact's writer, whatever later statement saw that writer's commit.
 * - A law a trigger holds. Of every witness a write breaks (certify.ts breaksAt), every occurrence but the written row
 *   is one no role's write can make true (certify.ts madeBy). A held occurrence, one of a unit the call borrows at the
 *   key the witness equates with the written row's, needs the witness's equated fields, which no fact states yet: it is
 *   a fault until they do.
 * - Foreign keys are PostgreSQL's own, checked at READ COMMITTED by row locks on both sides: a referencing check finds
 *   its row and holds it, or refuses its call. A check of a unit's row some role updates or deletes, where a delete and
 *   an insert at one key in one transaction refuse a check that waited on the old row, is a read of the unit: the call
 *   borrows it shared at the key the written row's references bind.
 *
 * Every site a member reads, writes or checks takes a borrow, needs none, or is a fault (BorrowFault): memberBorrows
 * is total, so a write's compile places the borrows it proves and certification reports every fault, grouped by cause.
 * The order every call takes its locks in, over every member's borrows (core/certificate.ts LockOrder), comes with
 * certification's switch to these rules.
 */
import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { isNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import {
	breaksAt,
	cascaded,
	groupOf,
	madeBy,
	type Made,
	type PlacedRead,
	permitted,
	type ReadSeal,
	readsUnder,
	type SealView,
	sealOf
} from "#compiler/analysis/isolation/certify.ts"
import type {
	MemberFacts,
	ReadFact,
	RelationFacts,
	WriteFact
} from "#compiler/analysis/isolation/facts.ts"
import type { Borrow, BorrowLock, KeyField, KeySource } from "#compiler/core/certificate.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"

/**
 * Which unit a relation's rows sit under: the unit, its key's fields (`key`, its heading's, in order), and the relation's
 * fields that hold them (`fields`, one for each of the key's, in its order).
 */
export interface UnitPlace {
	readonly unit: string
	readonly key: NonEmptyReadonlyArray<string>
	readonly fields: NonEmptyReadonlyArray<string>
}

/**
 * An installation as the borrow rules read it, built once from the IR (borrowInstallation): every relation's facts; the
 * unit each relation that sits in one sits under, a stored relation's by its theory's unit as a stored one's (D11), one
 * map every reader reads membership from; and what roles may make of each relation (Made), by their grants and the
 * updates those grants carry by ON UPDATE CASCADE, and a stored relation's rows as its holders' writers make them, none
 * for a relation no role writes.
 */
export interface BorrowInstallation {
	readonly relations: ReadonlyMap<string, RelationFacts>
	readonly units: ReadonlyMap<string, UnitPlace>
	readonly made: ReadonlyMap<string, ReadonlySet<Made>>
	/** Whether some role updates or deletes the relation, so a row of it, once committed, may change. */
	readonly changed: ReadonlySet<string>
}

/**
 * The installation's borrow facts (BorrowInstallation) from each relation's facts, every role's privileges, the units
 * the IR declares by relation, and the stored relations (D11), whose rows the judge deletes and inserts again at a unit
 * as its holders change, so each is changed and made present and absent by its writers whatever the grants say.
 */
export const borrowInstallation = (
	relations: ReadonlyMap<string, RelationFacts>,
	privileges: ReadonlyArray<ReadonlyMap<string, ReadonlySet<TablePrivilege>>>,
	units: ReadonlyMap<string, UnitPlace>,
	stored: ReadonlySet<string>
): BorrowInstallation => {
	const made = new Map<string, Set<Made>>()
	const changed = new Set<string>()
	const note = (relation: string, op: WriteFact["op"]): void => {
		const at = made.getOrInsertComputed(relation, () => new Set<Made>())
		for (const m of madeBy(op)) {
			at.add(m)
		}
		if (op !== "insert") {
			changed.add(relation)
		}
	}
	const updated = new Set<string>()
	for (const grants of privileges) {
		for (const [relation, held] of grants) {
			for (const p of held) {
				const op = permitted(p)
				if (op !== undefined) {
					note(relation, op)
				}
				if (op === "update") {
					updated.add(relation)
				}
			}
		}
	}
	for (const relation of cascaded(relations, updated)) {
		note(relation, "update")
	}
	for (const relation of stored) {
		note(relation, "insert")
		note(relation, "delete")
	}
	return { relations, units, made, changed }
}

/** The installation as certify.ts's seals read it: a relation no role writes is unwritten, one no role changes insert-only. */
const sealView = (at: BorrowInstallation): SealView => ({
	relations: at.relations,
	writers: {
		unwritten: (relation) => !at.made.has(relation),
		insertOnly: (relation) => !at.changed.has(relation)
	}
})

/** The site of a fault in a member's flight: a statement by its place, and the relation it reads, writes or checks. */
export interface FaultSite {
	readonly statement: number
	readonly relation: string
}

/**
 * Why a site of a member is not proven:
 *
 * - `update`, `delete`: it changes rows of a relation outside every unit;
 * - `insert`: it inserts into a relation outside every unit that some role updates or deletes, so no append there is
 *   decided by its key alone;
 * - `key`: it reads or writes a unit's rows at no key it can borrow: the unit's key fields are not all bound to the
 *   call's bindings (`missing`, the unit's fields it does not bind);
 * - `borrow`: it reads rows another call can write, outside every unit, by no whole key of an immutable fact;
 * - `absence`: it reads the absence or a count of a relation a role inserts, outside every unit, or arbitrates no
 *   whole declared key of it (`mode`);
 * - `gate`: a write of it is not joined with an immutable fact its statement reads, or follows a statement that read
 *   one without a row its call wrote, or comes before a fact the member reads only later (`why`);
 * - `law`: a law a trigger holds over a relation it writes reads another occurrence some role can make true;
 * - `check`: its foreign key check reads a unit's row some role changes at no key it borrows.
 */
export type BorrowFault = FaultSite &
	(
		| { readonly kind: "update" | "delete" | "insert" }
		| {
				readonly kind: "key"
				readonly unit: string
				readonly missing: NonEmptyReadonlyArray<string>
		  }
		| { readonly kind: "borrow"; readonly detail: string }
		| { readonly kind: "absence"; readonly mode: ReadFact["mode"] }
		| { readonly kind: "gate"; readonly why: "unjoined" | "unowned" | "early" }
		| { readonly kind: "law"; readonly law: string; readonly occurrence: string }
		| { readonly kind: "check"; readonly unit: string }
	)

/** A member's proof: the borrows every site it proves takes, and every site it does not prove. */
export interface MemberBorrows {
	readonly borrows: ReadonlyArray<Borrow>
	readonly faults: ReadonlyArray<BorrowFault>
}

/** A unit key as a site binds it: the binding of each of the unit's key fields, in its order, or the fields it leaves. */
type KeyBinding =
	| { readonly kind: "bound"; readonly key: NonEmptyReadonlyArray<KeyField> }
	| { readonly kind: "missing"; readonly fields: NonEmptyReadonlyArray<string> }

/**
 * The unit key a read binds at its relation's place in a unit, each key field bound to a binding the call holds
 * (`sourceOf`, a FieldBinding's text as a KeySource, none for one the call does not hold before its first snapshot).
 */
const keyOf = (
	read: ReadFact,
	place: UnitPlace,
	sourceOf: (by: string) => KeySource | undefined
): KeyBinding => {
	const missing: Array<string> = []
	const key: Array<KeyField> = []
	for (const [i, field] of place.fields.entries()) {
		const bound = read.group?.bound.find((b) => b.field === field)
		const source = bound === undefined ? undefined : sourceOf(bound.by)
		const named = place.key[i]
		if (source === undefined || named === undefined) {
			missing.push(field)
		} else {
			key.push({ field: named, source })
		}
	}
	return isNonEmpty(missing)
		? { kind: "missing", fields: missing }
		: isNonEmpty(key)
			? { kind: "bound", key }
			: { kind: "missing", fields: place.fields }
}

/** A borrow being gathered: its lock, its mode, and its keys, each once by its text. */
interface Gathered {
	readonly lock: BorrowLock
	mode: Borrow["mode"]
	readonly keys: Map<string, NonEmptyReadonlyArray<KeyField>>
}

/** Whether a placed read's seal needs no borrow: the call's own rows, a relation no role writes, an arbitration, or a
 * row an arbitration fixed. */
const sealed = (seal: ReadSeal): boolean =>
	seal.kind === "own" ||
	seal.kind === "unwritten" ||
	seal.kind === "arbiter" ||
	seal.kind === "arbitrated"

/** Whether a placed read is an immutable fact outside every unit: a whole-key or counted group of an insert-only
 * relation, read positively. */
const immutableFact = (p: PlacedRead): boolean =>
	p.mode === "positive" && (p.seal.kind === "point" || p.seal.kind === "counted")

/**
 * One member's proof under the borrow rules (the module's doc), over its facts and the installation's, each binding a
 * read's group holds read as a KeySource by `sourceOf`. Total: every site is a borrow, needs none, or is a fault.
 */
export const memberBorrows = (
	member: MemberFacts,
	at: BorrowInstallation,
	sourceOf: (by: string) => KeySource | undefined
): MemberBorrows => {
	const view = sealView(at)
	/** A read of a unit's rows at a key it binds seals as the call's own for placement: no other call writes them while
	 * the call holds the unit, so no probe above it reads a write another call may make. */
	const placementSeal = (read: ReadFact): ReadSeal => {
		const place = at.units.get(read.relation)
		return place !== undefined && keyOf(read, place, sourceOf).kind === "bound"
			? { kind: "own" }
			: sealOf(view, read)
	}
	const { placed, fed } = readsUnder(placementSeal, at.relations, member)
	const faults: Array<BorrowFault> = []
	const gathered = new Map<string, Gathered>()
	const take = (unit: string, mode: Borrow["mode"], key: NonEmptyReadonlyArray<KeyField>): void => {
		const held = gathered.getOrInsertComputed(unit, () => ({
			lock: { kind: "unit", unit },
			mode,
			keys: new Map()
		}))
		if (mode === "exclusive") {
			held.mode = "exclusive"
		}
		held.keys.set(keyText(key), key)
	}
	/** The unit keys a statement's reads of a relation bind, for its writes of that relation. */
	const writtenKeys = (statement: number, relation: string, op: WriteFact["op"]) =>
		placed.filter(
			(p) =>
				p.statement === statement &&
				p.read.relation === relation &&
				(op === "insert" ? p.mode === "arbiter" : p.mode !== "arbiter")
		)
	for (const [statement, s] of member.statements.entries()) {
		for (const w of s.writes) {
			const place = at.units.get(w.relation)
			if (place === undefined) {
				if (w.op === "update" || w.op === "delete" || w.op === "retire") {
					faults.push({
						kind: w.op === "update" ? "update" : "delete",
						statement,
						relation: w.relation
					})
				} else if (at.changed.has(w.relation)) {
					faults.push({ kind: "insert", statement, relation: w.relation })
				}
				continue
			}
			const keys = writtenKeys(statement, w.relation, w.op).map((p) =>
				keyOf(p.read, place, sourceOf)
			)
			const bound = keys.flatMap((k) => (k.kind === "bound" ? [k.key] : []))
			if (!isNonEmpty(bound)) {
				const [first] = keys
				faults.push({
					kind: "key",
					statement,
					relation: w.relation,
					unit: place.unit,
					missing: first?.kind === "missing" ? first.fields : place.fields
				})
				continue
			}
			for (const key of bound) {
				take(place.unit, "exclusive", key)
			}
		}
	}
	for (const p of placed) {
		const place = at.units.get(p.read.relation)
		if (place !== undefined) {
			if (p.read.own) {
				continue
			}
			const key = keyOf(p.read, place, sourceOf)
			if (key.kind === "bound") {
				take(place.unit, "shared", key.key)
			} else {
				faults.push({
					kind: "key",
					statement: p.statement,
					relation: p.read.relation,
					unit: place.unit,
					missing: key.fields
				})
			}
			continue
		}
		if (sealed(p.seal) || immutableFact(p)) {
			continue
		}
		const site = { statement: p.statement, relation: p.read.relation }
		if (at.changed.has(p.read.relation)) {
			faults.push({
				...site,
				kind: "borrow",
				detail: "a role updates or deletes it outside every unit"
			})
		} else if (p.mode === "negated" || p.mode === "counted" || p.mode === "arbiter") {
			faults.push({ ...site, kind: "absence", mode: p.mode })
		} else {
			faults.push({
				...site,
				kind: "borrow",
				detail: p.seal.kind === "unsealed" ? p.seal.detail : `it reads the relation ${p.mode}`
			})
		}
	}
	appendAll(faults, gateFaults(member, placed, fed, at))
	appendAll(faults, lawFaults(member, at))
	appendAll(faults, checkFaults(member, at))
	const borrows = [...gathered.values()]
		.toSorted((a, b) => compareStrings(lockName(a.lock), lockName(b.lock)))
		.map((g): Borrow => ({
			lock: g.lock,
			mode: g.mode,
			at: "flight",
			keys: [...g.keys]
				.toSorted(([a], [b]) => compareStrings(a, b))
				.map(([, fields]) => ({ kind: "bound", fields }))
		}))
	return { borrows, faults: distinctFaults(faults) }
}

/** A key's canonical text, by which the keys of one borrow are each kept once. */
const keyText = (key: NonEmptyReadonlyArray<KeyField>): string =>
	key.map(({ field, source }) => `${field}=${sourceText(source)}`).join(",")

/** A binding's canonical text. */
const sourceText = (source: KeySource): string => {
	switch (source.kind) {
		case "param":
			return `:${source.name}`
		case "context":
			return `context.${source.field}`
		case "input":
			return `${source.parameter}.${source.field}`
	}
}

/** A lock's name, which orders the locks of a member and breaks the ties of LockOrder. */
const lockName = (lock: BorrowLock): string =>
	lock.kind === "unit" ? `unit ${lock.unit}` : `series ${lock.relation}`

/** Faults each once, in their order. */
const distinctFaults = (faults: ReadonlyArray<BorrowFault>): ReadonlyArray<BorrowFault> => {
	const seen = new Set<string>()
	return faults.filter((f) => {
		const key = JSON.stringify(f)
		const fresh = !seen.has(key)
		seen.add(key)
		return fresh
	})
}

/**
 * The gate's faults (the module's doc), over the immutable facts outside every unit a member reads: each write not
 * joined with such a fact its statement reads (`unjoined`), each after a statement that read one not joined with a
 * row its call wrote (`unowned`), and each before a statement that first reads one (`early`).
 */
const gateFaults = (
	member: MemberFacts,
	placed: ReadonlyArray<PlacedRead>,
	fed: ReadonlyArray<
		ReadonlyArray<{ readonly joined: ReadonlySet<string>; readonly own: boolean }>
	>,
	at: BorrowInstallation
): ReadonlyArray<BorrowFault> => {
	const facts = placed.filter(
		(p) => !at.units.has(p.read.relation) && !sealed(p.seal) && immutableFact(p)
	)
	if (!isNonEmpty(facts)) {
		return []
	}
	const first = new Map<string, number>()
	for (const p of facts) {
		const g = groupOf(p.read)
		first.set(g, Math.min(first.get(g) ?? p.statement, p.statement))
	}
	const firsts = [...first.values()]
	const firstFact = firsts.reduce((least, s) => Math.min(least, s), Number.POSITIVE_INFINITY)
	const lastFirst = firsts.reduce((most, s) => Math.max(most, s), Number.NEGATIVE_INFINITY)
	return member.statements.flatMap((s, statement) =>
		s.writes.flatMap((w, place): ReadonlyArray<BorrowFault> => {
			const joined = fed[statement]?.[place]
			const site = { statement, relation: w.relation }
			const unjoined = facts.some(
				(p) => p.statement === statement && !(joined?.joined.has(groupOf(p.read)) ?? false)
			)
			return [
				...(unjoined ? [{ ...site, kind: "gate" as const, why: "unjoined" as const }] : []),
				...(statement > firstFact && !(joined?.own ?? false)
					? [{ ...site, kind: "gate" as const, why: "unowned" as const }]
					: []),
				...(lastFirst > statement
					? [{ ...site, kind: "gate" as const, why: "early" as const }]
					: [])
			]
		})
	)
}

/**
 * The laws' faults: of each witness a write of a relation breaks, every occurrence but one of the written relation's
 * that some role's write can make true, which no borrow holds until witnesses state the fields they equate.
 */
const lawFaults = (member: MemberFacts, at: BorrowInstallation): ReadonlyArray<BorrowFault> =>
	member.statements.flatMap((s, statement) =>
		s.writes.flatMap((w) => {
			const made = new Set(madeBy(w.op))
			return (at.relations.get(w.relation)?.triggerLaws ?? []).flatMap((law) =>
				law.witnesses
					.filter((witness) => breaksAt(made, witness, w.relation))
					.flatMap((witness) => {
						const occurrences = [
							...witness.rows.map((relation) => ({ relation, makes: "present" as const })),
							...witness.present.map((relation) => ({ relation, makes: "present" as const })),
							...witness.absent.map((relation) => ({ relation, makes: "absent" as const }))
						]
						const own = occurrences.findIndex((o) => o.relation === w.relation && made.has(o.makes))
						return occurrences.flatMap((o, i): ReadonlyArray<BorrowFault> =>
							i !== own && (at.made.get(o.relation)?.has(o.makes) ?? false)
								? [
										{
											kind: "law",
											statement,
											relation: w.relation,
											law: law.law,
											occurrence: o.relation
										}
									]
								: []
						)
					})
			)
		})
	)

/**
 * The foreign key checks' faults: each insert or update of a relation referencing a unit's relation some role changes,
 * where a delete and an insert at one key in one transaction refuse a check that waited on the old row, is a read of
 * that unit at the referencing columns, which no fact binds to the call yet.
 */
const checkFaults = (member: MemberFacts, at: BorrowInstallation): ReadonlyArray<BorrowFault> =>
	member.statements.flatMap((s, statement) =>
		s.writes.flatMap((w) =>
			w.op === "insert" || w.op === "update"
				? (at.relations.get(w.relation)?.references ?? []).flatMap(
						(r): ReadonlyArray<BorrowFault> => {
							const place = at.units.get(r.relation)
							return place !== undefined && at.changed.has(r.relation)
								? [{ kind: "check", statement, relation: r.relation, unit: place.unit }]
								: []
						}
					)
				: []
		)
	)
