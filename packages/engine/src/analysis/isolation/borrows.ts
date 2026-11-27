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
 *   group per own row, the call borrowing the unit shared there (or exclusively, where it writes it at that key). It
 *   binds the key by bindings the call holds before its first snapshot (core/certificate.ts KeySite `bound`), a stored
 *   row's field bound to one among them; or by the fields of the row one other read of its body finds, a positive
 *   point lookup at a whole declared key bound so: of an immutable fact or a relation no role writes (`learned`), or of
 *   a unit's rows at that unit's whole key (`held`), the call borrowing that unit shared there too, before the unit the
 *   lookup keys. A
 *   read of the call's own rows, of a relation no role writes, an arbitration and a read of a row an arbitration
 *   fixed are sealed (certify.ts ReadSeal). Outside every unit, a positive whole-key or counted read of an
 *   insert-only relation is an immutable fact, gated (below), its key bound to values the call holds once before its
 *   first snapshot: parameters, context fields, constants, or the fields of a learned lookup's row (factSeal); a negated or counted read, or an arbitration of no whole
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
 * The order every call takes its locks in, over every member's borrows (core/certificate.ts LockOrder), is the least
 * by name of those that rank each lock a call borrows in flight before each it borrows at the judge, and each held
 * site's `under` before the lock it keys (lockOrder); an installation whose members need a cycle has none.
 */
import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import {
	bodyAt,
	breaksAt,
	cascaded,
	keyIn,
	madeBy,
	type Made,
	type PlacedRead,
	permitted,
	type ReadSeal,
	readsUnder,
	type SealOfRead,
	type SealView,
	sealOf
} from "#compiler/analysis/isolation/certify.ts"
import {
	bindingText,
	type FieldBinding,
	type MemberFacts,
	type ReadFact,
	type RelationFacts,
	type WriteFact
} from "#compiler/analysis/isolation/facts.ts"
import type {
	Borrow,
	BorrowLock,
	KeyField,
	KeySite,
	KeySource,
	LockOrder
} from "#compiler/core/certificate.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"

/**
 * Which unit a relation's rows sit under: the unit, and each field of its key in the key's order (UnitField).
 */
export interface UnitPlace {
	readonly unit: string
	readonly fields: NonEmptyReadonlyArray<UnitField>
}

/** One field of a unit's key as a relation under it holds it: the key's field (`key`, its heading's) and the relation's. */
export interface UnitField {
	readonly key: string
	readonly field: string
}

/** The relation's fields that hold a unit's key, in the key's order. */
const heldBy = (place: UnitPlace): NonEmptyReadonlyArray<string> =>
	mapNonEmpty(place.fields, (f) => f.field)

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

/** A unit key as a read binds it: a place the call holds whole keys of the unit (KeySite), or the fields it leaves. */
type KeyBinding =
	| { readonly kind: "site"; readonly site: KeySite }
	| { readonly kind: "missing"; readonly fields: NonEmptyReadonlyArray<string> }

/**
 * What one field a read binds holds the unit key field at, in the body the read stands in (`reads`): a binding the call
 * holds before its first snapshot (KeySource) or a constant, a stored row's field bound to one included, as the
 * equality makes it the same value; or the field of the row another read of the body finds (`lookup`, its place); none
 * for any other. A constant keys no lock (KeySource holds none), so a unit key it binds is a key no site holds.
 */
type FieldAt =
	| { readonly kind: "source"; readonly source: KeySource }
	| { readonly kind: "constant" }
	| { readonly kind: "lookup"; readonly read: number; readonly field: string }

const fieldAt = (reads: ReadonlyArray<ReadFact>, by: FieldBinding["by"]): FieldAt | undefined => {
	switch (by.kind) {
		case "param":
		case "context":
		case "input":
			return { kind: "source", source: by }
		case "constant":
			return { kind: "constant" }
		case "stored": {
			const learned = reads[by.read]?.group?.bound.find((b) => b.field === by.field)?.by
			return learned !== undefined && (isKeySource(learned) || learned.kind === "constant")
				? fieldAt(reads, learned)
				: { kind: "lookup", read: by.read, field: by.field }
		}
		case "own":
		case "proposed":
			return undefined
	}
}

/** Whether a binding is one the call holds before its first snapshot. */
const isKeySource = (by: FieldBinding["by"]): by is KeySource =>
	by.kind === "param" || by.kind === "context" || by.kind === "input"

/**
 * Whether a field a read binds takes one value for the call before its first snapshot (fieldAt): a parameter, a
 * context's field, a constant, or the field of a row a learned point lookup of its body finds (lookupSite `learned`),
 * which is the call's before any write; never an input's field, one per row.
 */
const onceAt = (
	at: BorrowInstallation,
	reads: ReadonlyArray<ReadFact>,
	by: FieldBinding["by"]
): boolean => {
	const field = fieldAt(reads, by)
	if (field === undefined) {
		return false
	}
	if (field.kind === "constant") {
		return true
	}
	if (field.kind === "source") {
		return field.source.kind !== "input"
	}
	const lookup = reads[field.read]
	return (
		lookup !== undefined &&
		lookupSite(at, { read: lookup, reads }, [field.field])?.kind === "learned"
	)
}

/**
 * A read outside every unit as the borrow rules seal it (certify.ts ReadSeal): its seal over the call's own values
 * (sealOf); and, where that leaves it unsealed, a point where it binds every field to one value for the call before
 * its first snapshot (onceAt), a learned lookup's field or a constant among them, and those fields hold a whole declared
 * key of an insert-only relation: its row there is an immutable fact, as at a key its parameters bind.
 */
const factSeal = (
	at: BorrowInstallation,
	view: SealView,
	read: ReadFact,
	reads: ReadonlyArray<ReadFact>
): ReadSeal => {
	const seal = sealOf(view, read)
	const bound = read.group?.bound ?? []
	const facts = at.relations.get(read.relation)
	if (
		seal.kind !== "unsealed" ||
		read.mode === "arbiter" ||
		at.changed.has(read.relation) ||
		facts === undefined ||
		!bound.every((b) => onceAt(at, reads, b.by))
	) {
		return seal
	}
	const key = keyIn(
		facts,
		bound.map((b) => b.field)
	)
	return key === undefined ? seal : { kind: "point", key }
}

/**
 * The text that names the group a read reads under the borrow rules (certify.ts GroupOfRead): its relation and each
 * field it binds with what binds it (bindingText), a stored row's field by the group of the read of its body that finds
 * it and the field, so two reads of one learned key, in one body or two, name one group, and reads of two keys two.
 */
const factGroup = (read: ReadFact, reads: ReadonlyArray<ReadFact>): string =>
	groupText(read, reads, new Set())

/** factGroup's text, each read of `seen` named again by its relation alone, which closes a cycle of stored bindings. */
const groupText = (
	read: ReadFact,
	reads: ReadonlyArray<ReadFact>,
	seen: ReadonlySet<ReadFact>
): string => {
	if (seen.has(read)) {
		return `again ${read.relation}`
	}
	const within = new Set([...seen, read])
	const bound = (read.group?.bound ?? []).map(({ field, by }) => {
		const lookup = by.kind === "stored" ? reads[by.read] : undefined
		return `${field}=${
			by.kind !== "stored"
				? bindingText(by)
				: lookup === undefined
					? bindingText(by)
					: `${groupText(lookup, reads, within)}.${by.field}`
		}`
	})
	return `${read.relation}(${bound.join(",")})`
}

/** The fields of a read bound to bindings the call holds before its first snapshot, each with its source. */
const sourcesOf = (read: ReadFact): ReadonlyArray<KeyField> =>
	(read.group?.bound ?? []).flatMap((b) =>
		isKeySource(b.by) ? [{ field: b.field, source: b.by }] : []
	)

/** A read of a stored relation by its statement, the body it stands in (ReadAt) and that body's reads. */
interface SiteRead {
	readonly read: ReadFact
	readonly reads: ReadonlyArray<ReadFact>
}

/** A placed read as a SiteRead: its fact, and its body's reads. */
const siteOf = (member: MemberFacts, p: PlacedRead): SiteRead => {
	const s = member.statements[p.statement]
	const body = s === undefined ? undefined : bodyAt(s, p.at.cte)
	if (body === undefined) {
		defect("a placed read stands in a body of its member's statement")
	}
	return { read: p.read, reads: body.reads }
}

/**
 * The unit key a read binds at its relation's place in a unit (KeySite): each key field bound to a binding the call
 * holds (`bound`); or each bound to the field of the row one other read of its body finds at a whole declared key it
 * binds to such bindings alone, a point lookup, `learned` where that row is an immutable fact or of a relation no role
 * writes, `held` where it is a unit's row the lookup binds the unit's whole key of, which the call so borrows; else the
 * key fields it leaves.
 */
const keyOf = (at: BorrowInstallation, site: SiteRead, place: UnitPlace): KeyBinding => {
	const fields = mapNonEmpty(place.fields, (f) => {
		const bound = site.read.group?.bound.find((b) => b.field === f.field)
		return { ...f, at: bound === undefined ? undefined : fieldAt(site.reads, bound.by) }
	})
	const missing = fields.flatMap((f) => (f.at === undefined ? [f.field] : []))
	if (isNonEmpty(missing)) {
		return { kind: "missing", fields: missing }
	}
	const sources = fields.flatMap((f) =>
		f.at?.kind === "source" ? [{ field: f.key, source: f.at.source }] : []
	)
	if (isNonEmpty(sources) && sources.length === fields.length) {
		return { kind: "site", site: { kind: "bound", fields: sources } }
	}
	const lookups = fields.flatMap((f) => (f.at?.kind === "lookup" ? [f.at] : []))
	const lookup = isNonEmpty(lookups) ? site.reads[lookups[0].read] : undefined
	const learned =
		isNonEmpty(lookups) &&
		lookup !== undefined &&
		lookups.length === fields.length &&
		lookups.every((l) => l.read === lookups[0].read)
			? lookupSite(
					at,
					{ read: lookup, reads: site.reads },
					mapNonEmpty(lookups, (l) => l.field)
				)
			: undefined
	return learned === undefined
		? { kind: "missing", fields: heldBy(place) }
		: { kind: "site", site: learned }
}

/**
 * The point lookup of `lookup` as a key site, its row's `columns` the unit key's: `held` of a unit's row it binds the
 * unit's whole key of, whatever its mode, since no other call changes that row while the call holds the unit; `learned`
 * of an immutable fact or a relation no role writes, read positively where every probe above it is neutral (its base
 * mode), as the gate holds such a fact, the lookup's own placement judging whether they are; none where it binds no
 * whole declared key to bindings the call holds, or its row may change while the call holds no borrow of it.
 */
const lookupSite = (
	at: BorrowInstallation,
	lookup: SiteRead,
	columns: NonEmptyReadonlyArray<string>
): KeySite | undefined => {
	const relation = lookup.read.relation
	const facts = at.relations.get(relation)
	const bound = sourcesOf(lookup.read)
	const declared =
		facts === undefined
			? undefined
			: keyIn(
					facts,
					bound.map((b) => b.field)
				)
	if (declared === undefined) {
		return undefined
	}
	const key = declared.flatMap((field) => bound.filter((b) => b.field === field))
	if (!isNonEmpty(key)) {
		return undefined
	}
	const place = at.units.get(relation)
	if (place !== undefined) {
		return place.fields.every((f) => key.some((k) => k.field === f.field))
			? { kind: "held", relation, key, columns, under: { kind: "unit", unit: place.unit } }
			: undefined
	}
	return at.changed.has(relation) || lookup.read.base !== "positive"
		? undefined
		: { kind: "learned", relation, key, columns }
}

/** A borrow being gathered: its lock, its mode, and its key sites, each once by its text. */
interface Gathered {
	readonly lock: BorrowLock
	mode: Borrow["mode"]
	readonly keys: Map<string, KeySite>
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
 * One member's proof under the borrow rules (the module's doc), over its facts and the installation's. Total: every
 * site is a borrow, needs none, or is a fault.
 */
export const memberBorrows = (member: MemberFacts, at: BorrowInstallation): MemberBorrows => {
	const view = sealView(at)
	/** A read of a unit's rows at a key site seals as the call's own for placement: no other call writes them while
	 * the call holds the unit, so no probe above it reads a write another call may make. */
	const placementSeal: SealOfRead = (read, reads) => {
		const place = at.units.get(read.relation)
		return place !== undefined && keyOf(at, { read, reads }, place).kind === "site"
			? { kind: "own" }
			: factSeal(at, view, read, reads)
	}
	const { placed, fed } = readsUnder(
		{ seal: placementSeal, group: factGroup },
		at.relations,
		member
	)
	const faults: Array<BorrowFault> = []
	const gathered = new Map<string, Gathered>()
	const take = (unit: string, mode: Borrow["mode"], site: KeySite): void => {
		const held = gathered.getOrInsertComputed(unit, () => ({
			lock: { kind: "unit", unit },
			mode,
			keys: new Map()
		}))
		if (mode === "exclusive") {
			held.mode = "exclusive"
		}
		held.keys.set(siteText(site), site)
		const under = site.kind === "held" ? at.units.get(site.relation) : undefined
		if (site.kind === "held" && under !== undefined) {
			take(under.unit, "shared", { kind: "bound", fields: siteUnder(site, under) })
		}
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
				if (w.op === "update" || w.op === "delete") {
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
				keyOf(at, siteOf(member, p), place)
			)
			const bound = keys.flatMap((k) => (k.kind === "site" ? [k.site] : []))
			if (!isNonEmpty(bound)) {
				const [first] = keys
				faults.push({
					kind: "key",
					statement,
					relation: w.relation,
					unit: place.unit,
					missing: first?.kind === "missing" ? first.fields : heldBy(place)
				})
				continue
			}
			for (const site of bound) {
				take(place.unit, "exclusive", site)
			}
		}
	}
	for (const p of placed) {
		const place = at.units.get(p.read.relation)
		if (place !== undefined) {
			if (p.read.own) {
				continue
			}
			const key = keyOf(at, siteOf(member, p), place)
			if (key.kind === "site") {
				take(place.unit, "shared", key.site)
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
			keys: [...g.keys].toSorted(([a], [b]) => compareStrings(a, b)).map(([, site]) => site)
		}))
	return { borrows, faults: distinctFaults(faults) }
}

/** The key of `under` a held site's lookup binds: each of its unit's key fields with the lookup's source for it. */
const siteUnder = (
	site: Extract<KeySite, { readonly kind: "held" }>,
	under: UnitPlace
): NonEmptyReadonlyArray<KeyField> =>
	mapNonEmpty(under.fields, (f) => {
		const source = site.key.find((k) => k.field === f.field)?.source
		if (source === undefined) {
			defect("a held site's lookup binds its unit's whole key")
		}
		return { field: f.key, source }
	})

/** A key site's canonical text, by which the sites of one borrow are each kept once. */
const siteText = (site: KeySite): string => {
	switch (site.kind) {
		case "bound":
			return `bound ${keyText(site.fields)}`
		case "learned":
			return `learned ${site.relation}(${keyText(site.key)}).${site.columns.join(",")}`
		case "held":
			return `held ${site.relation}(${keyText(site.key)}).${site.columns.join(",")} under ${lockName(site.under)}`
		case "delta":
			return `delta ${site.relation}`
	}
}

/** A key's canonical text. */
const keyText = (key: ReadonlyArray<KeyField>): string =>
	key.map(({ field, source }) => `${field}=${bindingText(source)}`).join(",")

/** A lock's name, which orders the locks of a member and breaks the ties of LockOrder. */
export const lockName = (lock: BorrowLock): string =>
	lock.kind === "unit" ? `unit ${lock.unit}` : `series ${lock.relation}`

/** A change member by its place in the installation: its login's name, its role's, and its own, as an error names it. */
export interface MemberAt {
	readonly login: string
	readonly role: string
	readonly member: string
}

/**
 * One edge of the lock order (core/certificate.ts LockOrder), as a member's borrows need it: `from` ranks before `to`,
 * a lock `by` borrows in flight before one it borrows at the judge (`flight`), or a held site's `under` before the lock
 * that site keys (`under`), whose key the call reads only once it holds `under`.
 */
export interface OrderEdge {
	readonly from: BorrowLock
	readonly to: BorrowLock
	readonly by: MemberAt
	readonly why: "flight" | "under"
}

/** The edges one member's borrows need (OrderEdge): each flight lock before each judge lock, each held site's `under`
 * before the lock it keys. */
const edgesOf = (by: MemberAt, borrows: ReadonlyArray<Borrow>): ReadonlyArray<OrderEdge> => [
	...borrows.flatMap((first) =>
		first.at === "flight"
			? borrows.flatMap((then): ReadonlyArray<OrderEdge> =>
					then.at === "judge" ? [{ from: first.lock, to: then.lock, by, why: "flight" }] : []
				)
			: []
	),
	...borrows.flatMap((b) =>
		b.keys.flatMap((site): ReadonlyArray<OrderEdge> =>
			site.kind === "held" ? [{ from: site.under, to: b.lock, by, why: "under" }] : []
		)
	)
]

/**
 * The order every call takes its locks in (core/certificate.ts LockOrder), over every change member's borrows: each
 * lock any of them borrows or holds a site under, in a topological order of the edges their borrows need (OrderEdge),
 * the least lock by name (lockName) first wherever several may come next, so the order is the least such by name;
 * or, where the edges cycle, so no order meets them all, the edges of one cycle in its order, each as the first member
 * that needs it states it (error `order`). An edge from a lock to itself, a held site under the lock it keys or one
 * lock in flight and at the judge, is a cycle of one.
 */
export const lockOrder = (
	members: ReadonlyArray<{ readonly at: MemberAt; readonly borrows: ReadonlyArray<Borrow> }>
): Result.Result<LockOrder, NonEmptyReadonlyArray<OrderEdge>> => {
	const locks = new Map<string, BorrowLock>()
	const edges = new Map<string, OrderEdge>()
	for (const { at, borrows } of members) {
		for (const b of borrows) {
			locks.getOrInsert(lockName(b.lock), b.lock)
		}
		for (const e of edgesOf(at, borrows)) {
			locks.getOrInsert(lockName(e.from), e.from)
			edges.getOrInsert(JSON.stringify([lockName(e.from), lockName(e.to)]), e)
		}
	}
	/** The edges into each lock, by its name, each by the name of the lock it comes from. */
	const into = new Map<string, Map<string, OrderEdge>>()
	for (const e of edges.values()) {
		into.getOrInsertComputed(lockName(e.to), () => new Map()).set(lockName(e.from), e)
	}
	const order: Array<BorrowLock> = []
	const placed = new Set<string>()
	const ready = (name: string): boolean =>
		!placed.has(name) && [...(into.get(name)?.keys() ?? [])].every((from) => placed.has(from))
	const names = [...locks.keys()].toSorted(compareStrings)
	for (let next = names.find(ready); next !== undefined; next = names.find(ready)) {
		placed.add(next)
		order.push(defined(locks.get(next), "a lock of the order"))
	}
	if (order.length === names.length) {
		return Result.ok(order)
	}
	return Result.err(
		cycleAmong(
			names.filter((name) => !placed.has(name)),
			into
		)
	)
}

/**
 * One cycle among `left`, locks no order can place, each with an edge into it from another of them (lockOrder's
 * `into`, the first lock by name first): from the least, back along those edges until a lock comes again, its edges
 * in the cycle's order.
 */
const cycleAmong = (
	left: ReadonlyArray<string>,
	into: ReadonlyMap<string, ReadonlyMap<string, OrderEdge>>
): NonEmptyReadonlyArray<OrderEdge> => {
	const unplaced = new Set(left)
	const walked: Array<string> = []
	const back: Array<OrderEdge> = []
	for (let at = left[0]; at !== undefined;) {
		const seen = walked.indexOf(at)
		if (seen >= 0) {
			const cycle = back.slice(seen).toReversed()
			if (!isNonEmpty(cycle)) {
				defect("a lock met again closes a cycle of one edge at least")
			}
			return cycle
		}
		walked.push(at)
		const from = [...(into.get(at) ?? [])]
			.filter(([name]) => unplaced.has(name))
			.toSorted(([a], [b]) => compareStrings(a, b))[0]
		if (from === undefined) {
			defect("a lock no order places has an edge from another such lock")
		}
		back.push(from[1])
		at = from[0]
	}
	defect("the locks no order places are some")
}

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
	const groupAt = (p: PlacedRead): string => factGroup(p.read, siteOf(member, p).reads)
	const first = new Map<string, number>()
	for (const p of facts) {
		const g = groupAt(p)
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
				(p) => p.statement === statement && !(joined?.joined.has(groupAt(p)) ?? false)
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
