import { sameMembers, sameOrder } from "@bjornpagen/grizzle-text/base/array"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { TupleMap, TupleSet } from "@bjornpagen/grizzle-text/base/tuple-map"
import {
	type BodyFacts,
	type CteUse,
	bindingRows,
	bindingText,
	type FieldBinding,
	groupFields,
	type IsolationInput,
	type MemberFacts,
	type ReadAt,
	type ReadFact,
	type RelationFacts,
	type RoleFacts,
	type RowSource,
	type SiteCore,
	sameBinding,
	type StatementFacts,
	type TriggerLaw,
	type Unformed,
	type WriteFact
} from "#compiler/analysis/isolation/facts.ts"
import type { Witness } from "#compiler/analysis/theory/query.ts"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import type {
	GivenCondition,
	Giver,
	IsolationCondition,
	IsolationReason,
	OwnCondition,
	ReasonAt,
	RoleIsolation,
	Serializable
} from "#compiler/core/certificate.ts"
import { noReadCommittedFormText } from "#compiler/core/errors.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"

/**
 * What a read of a change member is, for the conditions:
 *
 * - `arbiter`: grizzle's own key arbitration of an insert-only relation the statement writes, binding every field of a
 *   declared key, which PostgreSQL's unique check decides whatever the call read; an arbitration that binds no whole
 *   declared key is unsealed, since no unique check decides it, and so is one of a relation a role updates or deletes,
 *   where the occupant a probe saw may be replaced (the `privileges` condition's dependence);
 * - `own`: it reads only rows the call itself wrote;
 * - `unwritten`: no role writes the relation. The owner writes such a relation by its migrations only, and a migration
 *   takes the ledger's ACCESS EXCLUSIVE lock before any statement (deploy/ledger/ledger.ts ledgerStatements'
 *   `exclusive` and `fence`, grizzle adapter/migrate/apply.ts fenceOf), where every Db call holds it in ACCESS SHARE,
 *   so every call's snapshot sees one migration state of it. An owner's psql session writing it outside a migration
 *   holds no such lock and falls outside this proof, under the documented direct-SQL doctrine;
 * - `counted`: an outside read of one group of an insert-only relation that is a family's members under an immutable
 *   owner holding their count, a set the count law fixes, all of it or none;
 * - `point`: an outside read binding every field of a declared key of an insert-only relation, so one row at most,
 *   which no later call changes;
 * - `arbitrated`: a point read of an insert-only relation that binds each field of a key the call's own earlier
 *   statement arbitrated in it to what that arbitration bound it to, by its parameters, whatever else it binds: once
 *   that statement inserted the row or met it, DO SELECT waiting for its writer's commit, the row at the key is the
 *   call's own or committed and never changes, so the read sees exactly it, filtered by its other bindings, and misses
 *   no write. A raced relation's arbitration fixes only the row at its race key, the one it met there whatever it holds
 *   at its other keys;
 * - `held`: a foreign key check, binding every field of a declared key, of a relation no role updates and no login
 *   both deletes and inserts (Writers). PostgreSQL 19 takes the check's snapshot after its ROW SHARE lock on the
 *   relation and locks the row it finds FOR KEY SHARE until the call ends (ri_triggers.c ri_FastPathCheck and
 *   ri_LockPKTuple; the SPI path's FOR KEY SHARE query alike), a lock every deletion of the row waits for (heapam.c
 *   heap_delete), so a row it finds stays until the call commits. A key it misses is absent from a point after the
 *   call's statements took their snapshots: a deletion it waited on committed with no insert at the key in its own
 *   transaction, and an insert at the key in a later one waits on the deletion's index entry. A deletion and an insert
 *   at one key in one transaction refuse a READ COMMITTED check that waited on the deleted row with 23503 while the key
 *   stands throughout, since the check probes the key once, finds the row it waited on deleted (TM_Deleted) and never
 *   sees the inserted one; an update may move the key, which leaves the check unsealed. A statement's read takes no
 *   such lock and is never held;
 * - `fenced`: a held check, but of a relation some login both deletes and inserts, none updating it. Every login that
 *   deletes it fences it (Fence): every change member of the login that writes it begins its transaction with LOCK
 *   TABLE ... IN EXCLUSIVE MODE on it before any statement takes the transaction's snapshot (PostgreSQL 19 tcop/pquery.c
 *   PlannedStmtRequiresSnapshot), a lock the check's ROW SHARE lock, taken before its own snapshot, conflicts with
 *   (lock.c LockConflicts). So every check of the relation by a committed call either committed before such a member's
 *   lock, and so before its snapshot, which sees the call's rows, or took its own snapshot after the member committed:
 *   no check waits on a row such a member deletes, and none misses a row it inserts. A held check of a relation some
 *   login deletes is fenced the same way where the role relies on it, for conditions 2 and 3 (fencedSite), and every
 *   sealed check, a point's too, against each writer that may miss another call's write, for 5c (givenReasons);
 * - `unsealed`: any other outside read, with why; a read of one group per own row of the call among them, which
 *   another call's rows may split, some seen and some missed. An arbitration is no such read: the unique check decides
 *   each row it proposes on its own.
 */
export type ReadSeal =
	| { readonly kind: "arbiter"; readonly key: ReadonlyArray<string> }
	| { readonly kind: "own" }
	| { readonly kind: "unwritten" }
	| { readonly kind: "counted"; readonly key: ReadonlyArray<string> }
	| { readonly kind: "point"; readonly key: ReadonlyArray<string> }
	| { readonly kind: "arbitrated"; readonly key: ReadonlyArray<string> }
	| { readonly kind: "held"; readonly key: ReadonlyArray<string> }
	| { readonly kind: "fenced"; readonly key: ReadonlyArray<string> }
	| { readonly kind: "unsealed"; readonly detail: string }

/** The privileges a writer holds; a role holding none of them on a relation only reads it. */
const writing: ReadonlySet<TablePrivilege> = new Set(["INSERT", "UPDATE", "DELETE"])

/** The privileges a READ COMMITTED role may hold. */
const insertAndSelect: ReadonlySet<TablePrivilege> = new Set(["SELECT", "INSERT"])

/**
 * The relations an update of `updated` reaches: them, and each relation whose foreign key into one of them carries an
 * update to its rows (ON UPDATE CASCADE), again and again.
 */
export const cascaded = (
	relations: ReadonlyMap<string, RelationFacts>,
	updated: ReadonlySet<string>
): ReadonlySet<string> => {
	const out = new Set(updated)
	let grew = true
	while (grew) {
		grew = false
		for (const [relation, facts] of relations) {
			if (
				!out.has(relation) &&
				facts.references.some((r) => r.onUpdate === "cascade" && out.has(r.relation))
			) {
				out.add(relation)
				grew = true
			}
		}
	}
	return out
}

/**
 * One role as a round of certification reads it: its facts, and every change member it may be served, its READ
 * COMMITTED form while it is judged, and its SERIALIZABLE form beside it once it is lowered.
 */
interface Served {
	readonly role: RoleFacts
	readonly members: ReadonlyArray<MemberFacts>
}

/** The relations a role updates: those it holds UPDATE on and those the members it may be served update. */
const updatedBy = (served: Served): ReadonlySet<string> =>
	new Set([
		...[...served.role.privileges].flatMap(([relation, privileges]) =>
			privileges.has("UPDATE") ? [relation] : []
		),
		...served.members.flatMap((m) =>
			m.statements.flatMap((s) => s.writes.flatMap((w) => (w.op === "update" ? [w.relation] : [])))
		)
	])

/** The set `by` holds at `key`, made empty on first use. */
const setAt = <V>(by: Map<string, Set<V>>, key: string): Set<V> => {
	const held = by.get(key)
	if (held !== undefined) {
		return held
	}
	const made = new Set<V>()
	by.set(key, made)
	return made
}

/**
 * What a write can make of a row of the relation it writes, as a rule over a query reads it: `present`, a row there
 * that was not, and `absent`, a row gone that was there.
 */
export type Made = "present" | "absent"

/** What a write makes: an insert a row present, a delete one absent, and an update both. */
export const madeBy = (op: WriteFact["op"]): ReadonlyArray<Made> => {
	switch (op) {
		case "insert":
			return ["present"]
		case "delete":
			return ["absent"]
		case "update":
			return ["present", "absent"]
	}
}

/** The write a privilege permits, none for SELECT. */
export const permitted = (p: TablePrivilege): WriteFact["op"] | undefined => {
	switch (p) {
		case "SELECT":
			return undefined
		case "INSERT":
			return "insert"
		case "UPDATE":
			return "update"
		case "DELETE":
			return "delete"
	}
}

/** The name of the member that bounds a role's unknown writes (writtenFacts), which reasons name it by. */
const directSql = "(direct SQL)"

/** A read of `relation` that may read anything of it, present or absent: by no group, for its absence. */
const anyRead = (relation: string): ReadFact => ({
	relation,
	mode: "negated",
	base: "negated",
	probes: [],
	own: false,
	group: undefined
})

/**
 * The member facts a role's writes are read by (RoleWrites): its served members; or, for unknown writes, one member that
 * bounds every direct transaction its privileges permit, since a fact grizzle cannot know is no fact that is absent. Its
 * one statement reads every relation the role's grants let it read (RoleWrites `readable`), each by no group and for
 * its absence (anyRead), so it reads anything of them, present or absent, and may miss another call's write
 * (pivotCauseOf); and it writes each relation the role holds a writer's privilege on by each write that privilege
 * permits, joined with no read, so it makes every row of it present or absent that the privilege lets it, with every
 * foreign key check those writes make, and fires every trigger-held law a write of it breaks (RoleView.probed, which
 * reads the role's privileges). No other relation is read: PostgreSQL checks a plan's table privileges as its executor
 * starts (ExecCheckPermissions), so a statement that reads a relation outside the role's grants is refused with 42501
 * before it reads a row, and observes nothing a serial order must explain. A role that holds no writer's privilege
 * writes nothing, and a transaction of it, a read member's like, is never a pivot (RoleFacts).
 */
const writtenFacts = (role: RoleFacts): ReadonlyArray<MemberFacts> => {
	switch (role.writes.kind) {
		case "served":
			return role.writes.members
		case "unknown": {
			const writes = [...role.privileges].flatMap(([relation, privileges]) =>
				[...privileges].flatMap((p): ReadonlyArray<WriteFact> => {
					const op = permitted(p)
					return op === undefined ? [] : [{ relation, op, from: [] }]
				})
			)
			return isNonEmpty(writes)
				? [
						{
							name: directSql,
							statements: [
								{
									writes,
									reads: role.writes.readable.map(anyRead),
									probes: [],
									cores: [],
									uses: [],
									ctes: []
								}
							]
						}
					]
				: []
		}
	}
}

/** The relations one login's roles delete and those they insert, by a privilege or a member. */
interface LoginWrites {
	readonly deletes: Set<string>
	readonly inserts: Set<string>
}

/**
 * What the installation's roles state of each relation, read once: whether any role writes it, whether any updates or
 * deletes it, and whether any updates it, an update carried by a cascading foreign key among them; the logins whose
 * roles delete it, by a privilege or a member; and whether one login's roles both delete and insert it, so one
 * transaction of that login may delete a row and insert another at its key: a login acts as each of its roles by SET
 * ROLE (physical/ddl/roles.ts), and a direct transaction may change role between its statements; and the relations a
 * role with unknown writes holds a writer's privilege on (`direct`), which its direct transactions write taking no
 * fence grizzle serves.
 */
class Writers {
	readonly #written = new Set<string>()
	readonly #direct = new Set<string>()
	readonly #changed = new Set<string>()
	readonly #updated = new Set<string>()
	readonly #deleters = new Map<string, Set<string>>()
	readonly #replacers = new Map<string, Set<string>>()
	readonly #made = new Map<string, Set<Made>>()

	constructor(relations: ReadonlyMap<string, RelationFacts>, roles: ReadonlyArray<Served>) {
		const deleted = new Map<string, Set<string>>()
		const inserted = new Map<string, Set<string>>()
		for (const served of roles) {
			const login: LoginWrites = {
				deletes: setAt(deleted, served.role.login),
				inserts: setAt(inserted, served.role.login)
			}
			for (const [relation, privileges] of served.role.privileges) {
				for (const p of privileges) {
					const op = permitted(p)
					if (op !== undefined) {
						this.#note(relation, op, login)
						if (served.role.writes.kind === "unknown") {
							this.#direct.add(relation)
						}
					}
				}
			}
			for (const member of served.members) {
				for (const s of member.statements) {
					for (const w of s.writes) {
						this.#note(w.relation, w.op, login)
					}
				}
			}
			for (const relation of cascaded(relations, updatedBy(served))) {
				this.#note(relation, "update", login)
			}
		}
		for (const [login, deletes] of deleted) {
			const inserts = setAt(inserted, login)
			for (const relation of deletes) {
				setAt(this.#deleters, relation).add(login)
				if (inserts.has(relation)) {
					setAt(this.#replacers, relation).add(login)
				}
			}
		}
	}

	/** One write of `relation` by a role of `login`, which makes rows present or absent as its op does (madeBy). */
	#note(relation: string, op: WriteFact["op"], login: LoginWrites): void {
		this.#written.add(relation)
		for (const m of madeBy(op)) {
			setAt(this.#made, relation).add(m)
		}
		switch (op) {
			case "insert":
				login.inserts.add(relation)
				return
			case "update":
				this.#changed.add(relation)
				this.#updated.add(relation)
				return
			case "delete":
				this.#changed.add(relation)
				login.deletes.add(relation)
				return
		}
	}

	/** Whether no role writes the relation. */
	unwritten(relation: string): boolean {
		return !this.#written.has(relation)
	}

	/** Whether some role's write can make a row of the relation present, or absent (Made). */
	makes(relation: string, made: Made): boolean {
		return this.#made.get(relation)?.has(made) ?? false
	}

	/**
	 * Whether a role with unknown writes writes the relation (facts.ts RoleWrites): its direct transactions take no lock
	 * a fence orders, so a foreign key check of the relation is ordered against them by no fence (referencingSeal).
	 */
	direct(relation: string): boolean {
		return this.#direct.has(relation)
	}

	/** Whether no role updates or deletes the relation: a row of it, once committed, stays as it is. */
	insertOnly(relation: string): boolean {
		return !this.#changed.has(relation)
	}

	/** Whether some role updates the relation, so a row may change the key a foreign key check found it at. */
	updated(relation: string): boolean {
		return this.#updated.has(relation)
	}

	/** Whether one login's roles both delete and insert the relation, so one transaction may delete a row and insert
	 * another at its key. */
	replaced(relation: string): boolean {
		return this.#replacers.has(relation)
	}

	/**
	 * Whether `login` fences the relation by its deletions (Fence): its roles delete it and no role updates it, so every
	 * change member of the login that writes it locks it before its snapshot where a READ COMMITTED check of it relies on
	 * that lock. A login whose role may miss another call's write fences what it writes too (fencesOf), which no deletion
	 * of its own decides.
	 */
	fences(login: string, relation: string): boolean {
		return !this.#updated.has(relation) && (this.#deleters.get(relation)?.has(login) ?? false)
	}

	/** The logins that fence the relation by their deletions, in code-unit order. */
	fencers(relation: string): ReadonlyArray<string> {
		return this.#updated.has(relation)
			? []
			: [...(this.#deleters.get(relation) ?? [])].toSorted(compareStrings)
	}
}

/** What the certifier reads of every role a round serves at once, and every relation the installation names: those it
 * states a fact of, and those a role holds a privilege on, reads or writes. */
interface Installation {
	readonly relations: ReadonlyMap<string, RelationFacts>
	readonly writers: Writers
	readonly named: ReadonlySet<string>
}

const installationOf = (
	relations: ReadonlyMap<string, RelationFacts>,
	roles: ReadonlyArray<Served>
): Installation => ({
	relations,
	writers: new Writers(relations, roles),
	named: new Set([
		...relations.keys(),
		...roles.flatMap((served) => [
			...served.role.privileges.keys(),
			...served.members.flatMap((m) =>
				m.statements.flatMap((s) => [
					...s.writes.map((w) => w.relation),
					...statementReads(s).flatMap(({ read }) => (read.own ? [] : [read.relation]))
				])
			)
		])
	])
})

/** What `read` is among the installation's roles, each served its READ COMMITTED form (ReadSeal). */
export const readSeal = (input: IsolationInput, read: ReadFact): ReadSeal =>
	sealOf(
		installationOf(
			input.relations,
			input.roles.map((role) => ({ role, members: writtenFacts(role) }))
		),
		read
	)

/** What a read's seal reads of an installation: each relation's facts, and whether a role writes it, and whether any
 * updates or deletes it. */
export interface SealView {
	readonly relations: ReadonlyMap<string, RelationFacts>
	readonly writers: {
		readonly unwritten: (relation: string) => boolean
		readonly insertOnly: (relation: string) => boolean
	}
}

/**
 * The group a read binds by values the call holds or its own rows carry: its bindings but each to the row another read
 * finds (facts.ts Binding `stored`), which no rule here reads, and how many groups that is, `one` where every binding
 * takes one value for the call, a constant's among them, else `many`, one per own row; none where it binds no such
 * field.
 */
export interface CallGroup {
	readonly bound: NonEmptyReadonlyArray<FieldBinding>
	readonly rows: "one" | "many"
}

/** A read's CallGroup. */
export const callGroup = (read: ReadFact): CallGroup | undefined => {
	const bound = (read.group?.bound ?? []).filter((b) => b.by.kind !== "stored")
	return isNonEmpty(bound)
		? { bound, rows: bound.every((b) => bindingRows(b.by) === "one") ? "one" : "many" }
		: undefined
}

/** A read's seal among `at`'s writers (ReadSeal), by its CallGroup. */
export const sealOf = (at: SealView, read: ReadFact): ReadSeal => {
	if (read.own) {
		return { kind: "own" }
	}
	const facts = at.relations.get(read.relation)
	if (facts === undefined) {
		return { kind: "unsealed", detail: "the installation states no fact of it" }
	}
	if (at.writers.unwritten(read.relation)) {
		return { kind: "unwritten" }
	}
	const group = callGroup(read)
	if (read.mode === "arbiter") {
		return at.writers.insertOnly(read.relation)
			? arbiterSeal(facts, group === undefined ? undefined : groupFields(group))
			: {
					kind: "unsealed",
					detail:
						"a role updates or deletes the relation, so an occupant its arbitration saw may be replaced"
				}
	}
	if (group === undefined) {
		return { kind: "unsealed", detail: "it reads rows of no one group" }
	}
	if (group.rows === "many") {
		return {
			kind: "unsealed",
			detail:
				"it reads one group per row of the call's own, which another call's rows may split, some seen and some missed"
		}
	}
	if (!at.writers.insertOnly(read.relation)) {
		return { kind: "unsealed", detail: "a role updates or deletes the relation" }
	}
	const fields = groupFields(group)
	if (facts.countedGroups.some((k) => sameMembers(k, fields))) {
		return { kind: "counted", key: fields }
	}
	return keyedSeal("point", facts, fields)
}

/**
 * A read by `columns` of an insert-only relation, a point, or a check of a relation Writers finds held or fenced, held
 * or fenced: where they hold a whole declared key, else unsealed. A statement's read binds fields, a check the columns
 * its foreign key references, law columns among them (RelationFacts): a key over law columns is whole only to a check.
 */
const keyedSeal = (
	kind: "point" | "held" | "fenced",
	facts: RelationFacts,
	columns: ReadonlyArray<string>
): ReadSeal => {
	const key = keyIn(facts, columns)
	return key === undefined ? unkeyed(columns) : { kind, key }
}

/** A declared key of the relation whose every column `columns` holds, none where no key is. */
export const keyIn = (
	facts: RelationFacts,
	columns: ReadonlyArray<string>
): ReadonlyArray<string> | undefined => facts.keys.find((k) => k.every((c) => columns.includes(c)))

/** The seal of a read by `columns` that hold no whole declared key, nor a family's counted members. */
const unkeyed = (columns: ReadonlyArray<string>): ReadSeal => ({
	kind: "unsealed",
	detail: `its group by ${columns.join(", ")} is neither a family's counted members nor a whole declared key`
})

/** An arbitration's seal: the declared key its group binds whole, which the unique check decides, or unsealed. */
const arbiterSeal = (facts: RelationFacts, group: ReadonlyArray<string> | undefined): ReadSeal => {
	const key = group === undefined ? undefined : keyIn(facts, group)
	return key === undefined
		? {
				kind: "unsealed",
				detail: "it arbitrates no whole declared key, which no unique check decides"
			}
		: { kind: "arbiter", key }
}

/** Whether a read's seal makes it an outside read: of rows another call can write. */
const outside = (seal: ReadSeal): boolean =>
	seal.kind !== "arbiter" &&
	seal.kind !== "own" &&
	seal.kind !== "unwritten" &&
	seal.kind !== "arbitrated"

/**
 * One read of a member as the conditions read it: its statement's place in the member's flight, its body and its place
 * there (ReadAt), the query CTE its body walks (CteFacts.query, none for the statement's own body), its seal, and one
 * mode it takes where a site reaches it (readsOf): a read takes one PlacedRead per mode it takes. The reads of the
 * instances of one query at one place are one read of the statement.
 */
export interface PlacedRead {
	readonly statement: number
	readonly at: ReadAt
	readonly query: number | undefined
	readonly read: ReadFact
	readonly seal: ReadSeal
	readonly mode: ReadFact["mode"]
}

/** One body of a statement, its own or a query CTE instance's, as the certifier reads both. */
type Body = BodyFacts<SiteCore>

/** The body of `s` at `cte`: its own, none, or its instance `cte`; none where it holds no such instance. */
export const bodyAt = (s: StatementFacts, cte: number | undefined): Body | undefined =>
	cte === undefined ? s : s.ctes[cte]

/** One read of a statement by its body and place, with its fact and its body's reads. */
interface StatedRead {
	readonly at: ReadAt
	readonly read: ReadFact
	readonly body: ReadonlyArray<ReadFact>
}

/**
 * A read's seal under some rules (ReadSeal), given the reads of the body it stands in (`body`), which a read bound to a
 * row another of them finds reads (facts.ts Binding `stored`).
 */
export type SealOfRead = (read: ReadFact, body: ReadonlyArray<ReadFact>) => ReadSeal

/**
 * The text that names the group a read reads under some rules, given the reads of the body it stands in (`body`): two
 * reads of one group, in one body or two of one statement, by one text.
 */
export type GroupOfRead = (read: ReadFact, body: ReadonlyArray<ReadFact>) => string

/** What a rule set places a member's reads by: each read's seal and its group's text. */
export interface ReadRules {
	readonly seal: SealOfRead
	readonly group: GroupOfRead
}

/**
 * Every read of a statement some site reaches, each once, in the order a walk that read each query CTE again at each of
 * its sites would first find it: its own body's reads, and each instance's at its first use, between the reads of the
 * using body before it and after it. An instance no use reaches reads nothing.
 */
const statementReads = (s: StatementFacts): ReadonlyArray<StatedRead> => {
	const out: Array<StatedRead> = []
	const reached = new Set<number>()
	const visit = (cte: number | undefined, body: Body): void => {
		let next = 0
		const upTo = (end: number): void => {
			for (; next < end; next++) {
				const read = body.reads[next]
				if (read !== undefined) {
					out.push({ at: { cte, read: next }, read, body: body.reads })
				}
			}
		}
		for (const use of body.uses) {
			upTo(use.at)
			const instance = s.ctes[use.cte]
			if (instance !== undefined && !reached.has(use.cte)) {
				reached.add(use.cte)
				visit(use.cte, instance)
			}
		}
		upTo(body.reads.length)
	}
	visit(undefined, s)
	return out
}

/**
 * The proof every row of a probe's core comes through a positive read of a group beneath the probes the probe chains,
 * along the core's row sources (BodyFacts.cores): the read itself, by its place in its body's reads; a derived table's
 * core, by its number, with its own proof; a UNION's, one proof per arm in arm order, each row of it one arm's; or a
 * query CTE's, by the place of its use, with the proof along its instance's rows.
 */
type RowPath =
	| { readonly kind: "read"; readonly read: number }
	| { readonly kind: "core"; readonly core: number; readonly path: RowPath }
	| { readonly kind: "union"; readonly arms: NonEmptyReadonlyArray<RowPath> }
	| { readonly kind: "use"; readonly use: number; readonly path: RowPath }

/**
 * The probes a read must stand beneath, below one body, to lie on a probe's row path: `local`, the body's; and, for a
 * probe of an instance the body reads, judged in the core of one of its sites (SiteCore `site`), `via`, the place of the
 * use of that site in the body and the instance's probes the probe chains. A read of an instance stands, at a use of
 * it, beneath the use's probes and then its own.
 */
interface Chain {
	readonly local: ReadonlyArray<number>
	readonly via: { readonly use: number; readonly chain: ReadonlyArray<number> } | undefined
}

/**
 * The chain below the instance a body's use reaches, at `place` among the body's uses, where `chain` is the chain below
 * the body: the instance's own probes the probe chains, for the use it is judged at, else none; nothing where the use
 * stands beneath other probes than the chain names, so no read beneath it stands on it.
 */
const below = (chain: Chain, place: number, use: CteUse): Chain | undefined => {
	if (!sameOrder(use.probes, chain.local)) {
		return undefined
	}
	if (chain.via === undefined) {
		return { local: [], via: undefined }
	}
	return chain.via.use === place ? { local: chain.via.chain, via: undefined } : undefined
}

/**
 * The proof of the first of `sources`, row sources of `body`, whose every row comes through reads standing on `chain`
 * that `fits` admits; none where no source has one.
 */
const pathOf = (
	s: StatementFacts,
	body: Body,
	sources: ReadonlyArray<RowSource>,
	chain: Chain,
	fits: (r: ReadFact, body: Body) => boolean
): RowPath | undefined => {
	for (const source of sources) {
		const path = sourcePath(s, body, source, chain, fits)
		if (path !== undefined) {
			return path
		}
	}
	return undefined
}

/**
 * One row source's proof: its read where it stands on `chain` and `fits` admits it, its core's proof, one proof for each
 * of its arms, or the proof along the rows of the instance its use reads.
 */
const sourcePath = (
	s: StatementFacts,
	body: Body,
	source: RowSource,
	chain: Chain,
	fits: (r: ReadFact, body: Body) => boolean
): RowPath | undefined => {
	switch (source.kind) {
		case "read": {
			const r = body.reads[source.read]
			return r !== undefined &&
				chain.via === undefined &&
				sameOrder(r.probes, chain.local) &&
				fits(r, body)
				? source
				: undefined
		}
		case "core": {
			const sources = body.cores[source.core]
			const path = sources === undefined ? undefined : pathOf(s, body, sources, chain, fits)
			return path === undefined ? undefined : { kind: "core", core: source.core, path }
		}
		case "union": {
			const arms = source.arms.flatMap((arm) => {
				const path = pathOf(s, body, arm, chain, fits)
				return path === undefined ? [] : [path]
			})
			return arms.length === source.arms.length && isNonEmpty(arms)
				? { kind: "union", arms }
				: undefined
		}
		case "use": {
			const use = body.uses[source.use]
			const instance = use === undefined ? undefined : s.ctes[use.cte]
			const next = use === undefined ? undefined : below(chain, source.use, use)
			const path =
				instance === undefined || next === undefined
					? undefined
					: pathOf(s, instance, instance.rows, next, fits)
			return path === undefined ? undefined : { kind: "use", use: source.use, path }
		}
	}
}

/**
 * Where a probe is judged: the body whose core the probe's rows are, that core, none where it stands in no core, and
 * the chain below that body the reads on its row path stand beneath (Chain).
 */
interface Judged {
	readonly body: Body
	readonly core: number | undefined
	readonly chain: Chain
}

/** The row path from a judged probe's core to positive reads of group `g` on its chain, none where it stands in no core
 * or no such path is. */
const rowPathOf = (
	s: StatementFacts,
	judged: Judged,
	g: string,
	group: GroupOfRead
): RowPath | undefined => {
	const sources = judged.core === undefined ? undefined : judged.body.cores[judged.core]
	return sources === undefined
		? undefined
		: pathOf(
				s,
				judged.body,
				sources,
				judged.chain,
				(r, body) => r.base === "positive" && group(r, body.reads) === g
			)
}

/**
 * Why one outside read beneath a probe leaves the probe a function of positive reads: the statement's positive read of
 * its sealed group beneath no probe at all (`positive`), the read of that group in the `from` of each write the probe
 * gates (`joins`), and the row path from the probe's core to positive reads of it beneath the probe's own probes alone
 * (`path`).
 */
interface Neutral {
	readonly positive: ReadAt
	readonly joins: ReadonlyArray<ReadAt>
	readonly path: RowPath
}

/**
 * What a statement's probes are judged against, read once: the first read of each group it reads positively beneath no
 * probe, at a site no probe stands above either (`positive`), and for each of its writes, by place, the first read of
 * each group among its `from` (`joined`), each a read some site reaches.
 */
interface Grounds {
	readonly positive: ReadonlyMap<string, ReadAt>
	readonly joined: ReadonlyArray<ReadonlyMap<string, ReadAt>>
	/** The text a read's group is named by (GroupOfRead), its rule set's. */
	readonly group: GroupOfRead
}

/** The first of `reads` of each group, by place, each group named by `group`. */
const firstOfEach = (
	reads: ReadonlyArray<StatedRead>,
	group: GroupOfRead
): ReadonlyMap<string, ReadAt> => {
	const first = new Map<string, ReadAt>()
	for (const { at, read, body } of reads) {
		first.getOrInsert(group(read, body), at)
	}
	return first
}

/**
 * A statement's grounds (Grounds), over `reads`, its reads some site reaches (statementReads): the bodies a site
 * beneath no probe reaches are its own and each instance a use beneath no probe of such a body reads.
 */
const groundsOf = (
	s: StatementFacts,
	reads: ReadonlyArray<StatedRead>,
	group: GroupOfRead
): Grounds => {
	const bare = new Set<number>()
	const reach = (body: Body): void => {
		for (const use of body.uses) {
			const instance = s.ctes[use.cte]
			if (use.probes.length === 0 && instance !== undefined && !bare.has(use.cte)) {
				bare.add(use.cte)
				reach(instance)
			}
		}
	}
	reach(s)
	const reached = new TupleSet<readonly [number | undefined, number]>()
	for (const { at } of reads) {
		reached.add([at.cte, at.read])
	}
	return {
		positive: firstOfEach(
			reads.filter(
				({ at, read }) =>
					(at.cte === undefined || bare.has(at.cte)) &&
					read.probes.length === 0 &&
					read.mode === "positive"
			),
			group
		),
		joined: s.writes.map((w) =>
			firstOfEach(
				w.from.flatMap((at) => {
					const body = bodyAt(s, at.cte)
					const read = body?.reads[at.read]
					return body !== undefined && read !== undefined && reached.has([at.cte, at.read])
						? [{ at, read, body: body.reads }]
						: []
				}),
				group
			)
		),
		group
	}
}

/** The proof an outside read of sealed group `g` beneath a probe gating `gates`, judged at `judged`, leaves it neutral,
 * none where a part of it is missing. */
const neutralBy = (
	s: StatementFacts,
	grounds: Grounds,
	gates: ReadonlyArray<number>,
	judged: Judged,
	g: string
): Neutral | undefined => {
	const positive = grounds.positive.get(g)
	const joins = gates.flatMap((k) => {
		const at = grounds.joined[k]?.get(g)
		return at === undefined ? [] : [at]
	})
	const path = rowPathOf(s, judged, g, grounds.group)
	return positive === undefined || joins.length < gates.length || path === undefined
		? undefined
		: { positive, joins, path }
}

/** The outside reads beneath a probe as its judgement reads them: whether one is unsealed, and the groups of the others. */
interface Beneath {
	readonly unsealed: boolean
	readonly groups: ReadonlySet<string>
}

/** A Beneath being gathered. */
interface Gathering {
	unsealed: boolean
	readonly groups: Set<string>
}

const gathering = (): Gathering => ({ unsealed: false, groups: new Set() })

/** `into` with every outside read `from` holds. */
const gather = (into: Gathering, from: Beneath): void => {
	into.unsealed ||= from.unsealed
	for (const g of from.groups) {
		into.groups.add(g)
	}
}

/** `into` with an outside read, sealed by `seal`, of the group named `group`. */
const gatherRead = (into: Gathering, group: string, seal: ReadSeal): void => {
	if (seal.kind === "unsealed") {
		into.unsealed = true
	} else {
		into.groups.add(group)
	}
}

/**
 * A statement's reads as its probes' judgements read them, by body: the seal of every read of every body
 * (`seals`, its own body's first, then each instance's), and, for each body, the outside reads beneath each of its
 * probes, each read once under every probe it stands beneath, and every read of each instance a use beneath it reads.
 */
interface Sealed {
	readonly seals: (at: ReadAt) => ReadSeal | undefined
	readonly beneath: (cte: number | undefined, probe: number) => Beneath | undefined
}

const sealedOf = (s: StatementFacts, sealOfRead: SealOfRead, group: GroupOfRead): Sealed => {
	const own = s.reads.map((read) => sealOfRead(read, s.reads))
	const ctes = s.ctes.map((instance) =>
		instance.reads.map((read) => sealOfRead(read, instance.reads))
	)
	const sealsOf = (cte: number | undefined): ReadonlyArray<ReadSeal> | undefined =>
		cte === undefined ? own : ctes[cte]
	const whole: Array<Beneath | undefined> = []
	const wholeOf = (cte: number): Beneath => {
		const known = whole[cte]
		if (known !== undefined) {
			return known
		}
		const into = gathering()
		const instance = s.ctes[cte]
		const seals = ctes[cte]
		if (instance !== undefined && seals !== undefined) {
			for (const [i, read] of instance.reads.entries()) {
				const seal = seals[i]
				if (seal !== undefined && outside(seal)) {
					gatherRead(into, group(read, instance.reads), seal)
				}
			}
			for (const use of instance.uses) {
				gather(into, wholeOf(use.cte))
			}
		}
		whole[cte] = into
		return into
	}
	const probed = new Map<number | undefined, ReadonlyMap<number, Beneath>>()
	const probedOf = (cte: number | undefined): ReadonlyMap<number, Beneath> => {
		const known = probed.get(cte)
		if (known !== undefined) {
			return known
		}
		const by = new Map<number, Gathering>()
		const at = (id: number): Gathering => {
			const held = by.get(id)
			if (held !== undefined) {
				return held
			}
			const made = gathering()
			by.set(id, made)
			return made
		}
		const body = bodyAt(s, cte)
		const seals = sealsOf(cte)
		if (body !== undefined && seals !== undefined) {
			for (const [i, read] of body.reads.entries()) {
				const seal = seals[i]
				if (seal !== undefined && outside(seal)) {
					for (const id of new Set(read.probes)) {
						gatherRead(at(id), group(read, body.reads), seal)
					}
				}
			}
			for (const use of body.uses) {
				for (const id of new Set(use.probes)) {
					gather(at(id), wholeOf(use.cte))
				}
			}
		}
		probed.set(cte, by)
		return by
	}
	return {
		seals: (place) => sealsOf(place.cte)?.[place.read],
		beneath: (cte, probe) => probedOf(cte).get(probe)
	}
}

/**
 * A probe's judgement: neutral, with one proof per group of the outside reads beneath it, where none of them is
 * unsealed and each group has its proof (neutralBy); none where it is not neutral.
 */
const probeJudgement = (
	s: StatementFacts,
	grounds: Grounds,
	gates: ReadonlyArray<number>,
	judged: Judged,
	beneath: Beneath | undefined
): ReadonlyArray<Neutral> | undefined => {
	if (beneath === undefined) {
		return []
	}
	if (beneath.unsealed) {
		return undefined
	}
	const proofs: Array<Neutral> = []
	for (const g of beneath.groups) {
		const proof = neutralBy(s, grounds, gates, judged, g)
		if (proof === undefined) {
			return undefined
		}
		proofs.push(proof)
	}
	return proofs
}

/**
 * How a site reaches a body: through the use at `place` among `body`'s uses, none for a statement's own body; whether
 * every probe above the body on the way there is neutral (`neutral`); and the judgement of each of the body's own probes
 * there (`probes`, probeJudgement), its `site` probes judged in the core of that use.
 */
interface Reach {
	readonly from: { readonly body: Body; readonly place: number; readonly use: CteUse } | undefined
	readonly neutral: boolean
	readonly probes: ReadonlyArray<ReadonlyArray<Neutral> | undefined>
}

/**
 * Every way some site reaches each body of a statement (Reach), by the body's instance, none for its own: its own body
 * once, beneath no probe, then each instance from each reach of each body that uses it, in an order that reaches every
 * body using an instance before the instance. A probe is a function of positive reads (neutral) where each outside read
 * beneath it is of a sealed group the statement also reads positively beneath no probe, every write it gates is joined
 * with that group, and every row of the core whose rows it filters or counts comes through a positive read of it
 * beneath no further probe (rowPathOf), a UNION's through one in each arm, so every row the probe touches passes through
 * the group. NEGATION's fallback: a rule's NOT EXISTS in another arm of the same write's UNION, or beside a UNION one of
 * whose arms, a recursive CTE's base or its recursion's own rows among them, never reads the group, gates rows the group
 * never reaches; and an ungrouped count, which yields a row over no input, is judged by the core its value lands in. A
 * sealed group is read whole or not at all at the statement's one snapshot, and a miss empties every write the probe
 * gates, so the probe's result reaches no write the positive read does not; a refusal it raises needs the group present.
 * Any other probe keeps the mode it composes, so a negation of a sealed point no positive read gates is still an absence
 * read. A probe of an instance is judged as each site's walk would find it: in its own core, alike at every site, or in
 * the core of the site that reads it (SiteCore `site`), once for each use.
 */
const reachesOf = (
	s: StatementFacts,
	grounds: Grounds,
	sealed: Sealed
): ReadonlyMap<number | undefined, ReadonlyArray<Reach>> => {
	const own = (
		cte: number | undefined,
		body: Body
	): ReadonlyArray<ReadonlyArray<Neutral> | undefined> =>
		body.probes.map((probe, id) =>
			probe.core === "site"
				? undefined
				: probeJudgement(
						s,
						grounds,
						probe.gates,
						{ body, core: probe.core, chain: { local: probe.chain, via: undefined } },
						sealed.beneath(cte, id)
					)
		)
	const order: Array<number> = []
	const visited = new Set<number>()
	const visit = (body: Body): void => {
		for (const use of body.uses) {
			const instance = s.ctes[use.cte]
			if (instance === undefined || visited.has(use.cte)) {
				continue
			}
			visited.add(use.cte)
			visit(instance)
			order.push(use.cte)
		}
	}
	visit(s)
	const reaches = new Map<number | undefined, Array<Reach>>([
		[undefined, [{ from: undefined, neutral: true, probes: own(undefined, s) }]]
	])
	const seen = new TupleSet<readonly [number, Body, number, boolean]>()
	const owned = new Map<number, ReadonlyArray<ReadonlyArray<Neutral> | undefined>>()
	const enter = (from: Body, fromReaches: ReadonlyArray<Reach>): void => {
		for (const [place, use] of from.uses.entries()) {
			const instance = s.ctes[use.cte]
			if (instance === undefined) {
				continue
			}
			for (const r of fromReaches) {
				const neutral = r.neutral && use.probes.every((id) => r.probes[id] !== undefined)
				if (seen.has([use.cte, from, place, neutral])) {
					continue
				}
				seen.add([use.cte, from, place, neutral])
				const ownProbes = owned.getOrInsertComputed(use.cte, () => own(use.cte, instance))
				const probes = instance.probes.map((probe, id) =>
					probe.core === "site"
						? probeJudgement(
								s,
								grounds,
								probe.gates,
								{
									body: from,
									core: use.core,
									chain: {
										local: use.probes,
										via: probe.chain.length === 0 ? undefined : { use: place, chain: probe.chain }
									}
								},
								sealed.beneath(use.cte, id)
							)
						: ownProbes[id]
				)
				const held = reaches.getOrInsertComputed(use.cte, () => [])
				held.push({ from: { body: from, place, use }, neutral, probes })
			}
		}
	}
	enter(s, reaches.get(undefined) ?? [])
	for (const cte of order.toReversed()) {
		const instance = s.ctes[cte]
		if (instance !== undefined) {
			enter(instance, reaches.get(cte) ?? [])
		}
	}
	return reaches
}

/**
 * A row a statement of a member fixed by its arbitration: the relation, the declared key it arbitrated (`key`), what
 * each of that key's fields is bound to (`bound`), and the statement.
 */
interface Fixed {
	readonly relation: string
	readonly key: ReadonlyArray<string>
	readonly bound: ReadonlyArray<FieldBinding>
	readonly statement: number
}

/**
 * Whether a committed arbitration at `key` of a relation whose facts are `facts` fixes the row there: every one of a
 * repeatable relation, whose insertion at a stored row is an exact repeat at every field it states or refused, so each
 * key it states holds the row it proposed; and a raced relation's at its race key alone, where the row it met may hold
 * other values at its other keys than the ones it proposed. None of a relation the installation states no fact of.
 */
const fixesAt = (facts: RelationFacts | undefined, key: ReadonlyArray<string>): boolean => {
	if (facts === undefined) {
		return false
	}
	return facts.inserts.kind === "repeatable" || sameMembers(facts.inserts.key, key)
}

/** The row of `fixed` a read reads: one fixed earlier in its member, of its relation, whose key fields it binds each to
 * what the arbitration bound it to, whatever else it binds; none where no such row is. */
const fixedFor = (
	fixed: ReadonlyArray<Fixed>,
	read: ReadFact,
	statement: number
): Fixed | undefined => {
	const group = callGroup(read)
	return group === undefined
		? undefined
		: fixed.find(
				(f) =>
					f.relation === read.relation &&
					f.statement < statement &&
					f.bound.every((b) =>
						group.bound.some((r) => r.field === b.field && sameBinding(r.by, b.by))
					)
			)
}

/**
 * Every read of a member some site reaches, each placed, sealed, and with each mode it takes: at each way a site reaches
 * it (reachesOf), its base mode where every probe above it there is neutral, else the mode it composes. A point read of
 * a row an earlier statement of the member fixed by its arbitration, each field of the arbitrated key bound to what the
 * arbitration bound it to, is arbitrated, whatever its mode and whatever else it binds, since the row there is fixed and
 * its other bindings only filter that row, where that statement and every one before it read only the call's own rows
 * and arbitrations, so the row it proposes at the key is the call's whatever the installation holds: an insert an
 * outside read gates may propose nothing, and the later read then meets another call's row (NEGATION's claimStart, the
 * publication case). A raced relation's arbitration fixes only the row at its race key (fixesAt). Reads come in the order
 * statementReads finds them, each read's modes in the order its reaches take them.
 */
const placementsOf = (
	rules: ReadRules,
	relations: ReadonlyMap<string, RelationFacts>,
	member: MemberFacts,
	visit: (statement: number, s: StatementFacts, placed: StatementPlacement) => void
): void => {
	const stated = member.statements.map((s) => ({ s, reads: statementReads(s) }))
	const fixed: Array<Fixed> = []
	for (const [statement, { reads }] of stated.entries()) {
		const seals = reads.map(({ read, body }) => ({ read, seal: rules.seal(read, body) }))
		if (seals.some(({ seal }) => seal.kind !== "own" && seal.kind !== "arbiter")) {
			break
		}
		for (const { read, seal } of seals) {
			const group = callGroup(read)
			if (
				read.mode === "arbiter" &&
				seal.kind === "arbiter" &&
				group?.rows === "one" &&
				fixesAt(relations.get(read.relation), seal.key)
			) {
				fixed.push({
					relation: read.relation,
					key: seal.key,
					bound: group.bound.filter((b) => seal.key.includes(b.field)),
					statement
				})
			}
		}
	}
	for (const [statement, { s, reads }] of stated.entries()) {
		const sealed = sealedOf(
			s,
			(read, body): ReadSeal => {
				const seal = rules.seal(read, body)
				const by = seal.kind === "point" ? fixedFor(fixed, read, statement) : undefined
				return by === undefined ? seal : { kind: "arbitrated", key: by.key }
			},
			rules.group
		)
		const reaches = reachesOf(s, groundsOf(s, reads, rules.group), sealed)
		visit(statement, s, {
			reads,
			seal: (at) => sealed.seals(at),
			modes: (at, read) =>
				new Set(
					(reaches.get(at.cte) ?? []).map((r) =>
						r.neutral && read.probes.every((id) => r.probes[id] !== undefined)
							? read.base
							: read.mode
					)
				),
			query: (at) => (at.cte === undefined ? undefined : s.ctes[at.cte]?.query)
		})
	}
}

/**
 * One statement as readsOf places it: every read some site reaches, in statementReads' order, each read's seal at its
 * place, each mode it takes at the instance that reads it (reachesOf), and the query CTE an instance walks.
 */
interface StatementPlacement {
	readonly reads: ReadonlyArray<StatedRead>
	readonly seal: (at: ReadAt) => ReadSeal | undefined
	readonly modes: (at: ReadAt, read: ReadFact) => ReadonlySet<ReadFact["mode"]>
	readonly query: (at: ReadAt) => number | undefined
}

/**
 * A member's reads as the conditions read them (MemberView): each read placed once for every mode it takes, the instances
 * of one query at one place reading one read, one read fact alike (its canonical text), one read of the statement
 * (PlacedRead), its seal its read's at its statement (sealOf, fixedFor), in the order statementReads finds them; and, for each write of each statement, what condition 5b reads of
 * the reads that feed it (Fed), taken at the instances its rows come through.
 */
export interface MemberReads {
	readonly placed: ReadonlyArray<PlacedRead>
	readonly fed: ReadonlyArray<ReadonlyArray<Fed>>
}

/**
 * What condition 5b reads of the reads one write's rows are positively joined with (WriteFact `from`), each at the
 * instance it is read at: the groups they read (groupOf), and whether one of them is the call's own row read positively.
 */
export interface Fed {
	readonly joined: ReadonlySet<string>
	readonly own: boolean
}

/** A read placed (PlacedRead): one for each read of a statement, mode and seal the conditions read (readsOf). */
const placedRead = (
	statement: number,
	at: ReadAt,
	query: number | undefined,
	read: ReadFact,
	seal: ReadSeal,
	mode: ReadFact["mode"]
): PlacedRead => ({ statement, at, query, read, seal, mode })

/** The rules the rounds certifier places reads by: each read's seal among `installation`'s roles, its group by its
 * CallGroup (groupOf). */
const roundRules = (installation: Installation): ReadRules => ({
	seal: (read) => sealOf(installation, read),
	group: (read) => groupOf(read)
})

const readsOf = (installation: Installation, member: MemberFacts): MemberReads =>
	readsUnder(roundRules(installation), installation.relations, member)

/**
 * A member's reads placed and moded under `rules`, each read's seal and group among some installation's roles (readsOf's
 * under certification's, analysis/isolation/borrows.ts's under the borrow rules), the relations' facts `relations`
 * deciding which arbitrations fix their rows (fixesAt): every read some site reaches, each mode it takes, and what
 * each write's rows are joined with (MemberReads).
 */
export const readsUnder = (
	rules: ReadRules,
	relations: ReadonlyMap<string, RelationFacts>,
	member: MemberFacts
): MemberReads => {
	const placed: Array<PlacedRead> = []
	const fed: Array<ReadonlyArray<Fed>> = []
	/** Each read fact's canonical text, written once for every instance that holds it (readKey). */
	const texts = new Map<ReadFact, string>()
	const readKey = (read: ReadFact): string =>
		texts.getOrInsertComputed(read, () => canonicalTextOf(read))
	placementsOf(rules, relations, member, (statement, s, at) => {
		const seen = new TupleSet<readonly [number | undefined, number, string, ReadFact["mode"]]>()
		for (const { at: place, read } of at.reads) {
			const seal = at.seal(place)
			if (seal === undefined) {
				continue
			}
			const query = at.query(place)
			for (const mode of at.modes(place, read)) {
				const key = [
					place.cte === undefined ? undefined : query,
					place.read,
					readKey(read),
					mode
				] as const
				if (place.cte !== undefined && seen.has(key)) {
					continue
				}
				seen.add(key)
				placed.push(placedRead(statement, place, query, read, seal, mode))
			}
		}
		fed.push(
			s.writes.map((w): Fed => {
				const joined = new Set<string>()
				let own = false
				for (const place of w.from) {
					const body = bodyAt(s, place.cte)
					const read = body?.reads[place.read]
					const seal = at.seal(place)
					if (body === undefined || read === undefined || seal === undefined) {
						continue
					}
					const modes = at.modes(place, read)
					if (modes.size === 0) {
						continue
					}
					joined.add(rules.group(read, body.reads))
					own ||= seal.kind === "own" && modes.has("positive")
				}
				return { joined, own }
			})
		)
	})
	return { placed, fed }
}

/**
 * Each mode each read of `member` takes, by its statement and its body and place there, at every instance that reads
 * it, and whether the read is an outside read, among the installation's roles each served its READ COMMITTED form
 * (placementsOf).
 */
export const readModes = (
	input: IsolationInput,
	member: MemberFacts
): ReadonlyArray<{
	readonly statement: number
	readonly at: ReadAt
	readonly mode: ReadFact["mode"]
	readonly outside: boolean
}> => {
	const out: Array<{
		readonly statement: number
		readonly at: ReadAt
		readonly mode: ReadFact["mode"]
		readonly outside: boolean
	}> = []
	const installation = installationOf(
		input.relations,
		input.roles.map((role) => ({ role, members: writtenFacts(role) }))
	)
	placementsOf(roundRules(installation), installation.relations, member, (statement, _s, at) => {
		for (const { at: place, read } of at.reads) {
			const seal = at.seal(place)
			if (seal === undefined) {
				continue
			}
			for (const mode of at.modes(place, read)) {
				out.push({ statement, at: place, mode, outside: outside(seal) })
			}
		}
	})
	return out
}

/** The text that names one group a read reads: its relation, its CallGroup's fields and what they are bound to. */
const groupOf = (r: ReadFact): string => {
	const group = callGroup(r)
	return group === undefined
		? `${r.relation}()`
		: `${r.relation}(${groupFields(group).join(",")})=${group.bound.map((b) => bindingText(b.by)).join(",")}`
}

/**
 * A read PostgreSQL makes for a foreign key, which no statement of the member shows: `referencing`, the insert or
 * update of a row of a relation that holds the key reads the referenced row at the written row's values; `referenced`,
 * the update or delete of a row the key references reads the rows that reference it, for their absence (NO ACTION).
 * Under READ COMMITTED each reads the latest committed rows, and a deferred key reads them at COMMIT: never at its
 * statement's snapshot. A referencing check that finds no row refuses the call whole, so in a committed call every one
 * found its row.
 */
interface Check {
	readonly statement: number
	readonly relation: string
	readonly side: "referencing" | "referenced"
	readonly seal: ReadSeal
	/** The relation whose write by the member makes the check. */
	readonly write: string
}

/**
 * A referencing check's seal: of the referenced relation, at its referenced key's columns, law columns among them. A
 * point where the relation is insert-only; where no role updates it, held (ReadSeal) where no login both deletes and
 * inserts it, and fenced where one does; unsealed where a role updates it, and where a role with unknown writes writes
 * it (Writers.direct). Every sealed check rests on the fence of each writer of its relation that may miss another
 * call's write (fencesOf), and such a role is one: its direct transactions read what its grants reach, which some role
 * writes, and take no fence grizzle serves, so a check may miss a row one of them has in flight (NEGATION's case 3).
 * The checks its own deletions make of the rows that reference a deleted one stay sites of conditions 2 and 3 where its
 * login fences the deleted relation (fencedSite), but no READ COMMITTED role writes those rows: it only inserts them, so
 * it checks the relation they reference, which is this unsealed check.
 */
const referencingSeal = (
	at: Installation,
	relation: string,
	columns: ReadonlyArray<string>
): ReadSeal => {
	const facts = at.relations.get(relation)
	if (facts === undefined) {
		return { kind: "unsealed", detail: "the installation states no fact of it" }
	}
	if (at.writers.unwritten(relation)) {
		return { kind: "unwritten" }
	}
	if (at.writers.direct(relation)) {
		return {
			kind: "unsealed",
			detail: "a role writes it by direct SQL alone, whose transactions take no fence"
		}
	}
	if (at.writers.insertOnly(relation)) {
		return keyedSeal("point", facts, columns)
	}
	if (at.writers.updated(relation)) {
		return {
			kind: "unsealed",
			detail: "a role updates the relation, which may move the key a check found"
		}
	}
	return keyedSeal(at.writers.replaced(relation) ? "fenced" : "held", facts, columns)
}

/** A referenced check's seal: every row of the referencing relation that references the written one. */
const referencedSeal = (at: Installation, relation: string): ReadSeal =>
	at.writers.unwritten(relation)
		? { kind: "unwritten" }
		: { kind: "unsealed", detail: "it reads every row that references the one written" }

/** A check whose foreign key the installation states no fact of, which may read any relation it names. */
const unknownSeal = (at: Installation, relation: string): ReadSeal =>
	at.writers.unwritten(relation)
		? { kind: "unwritten" }
		: {
				kind: "unsealed",
				detail:
					"the installation states no fact of a relation the write meets, whose foreign keys are unknown"
			}

/** The referencing checks a write of `relation` makes: one per foreign key it holds, or, with no fact of it, a read of
 * every relation the installation names. */
const referencingChecks = (
	at: Installation,
	relation: string,
	statement: number
): ReadonlyArray<Check> => {
	const facts = at.relations.get(relation)
	return facts === undefined
		? [...at.named].map((r) => ({
				statement,
				relation: r,
				side: "referencing",
				seal: unknownSeal(at, r),
				write: relation
			}))
		: facts.references.map((r) => ({
				statement,
				relation: r.relation,
				side: "referencing",
				seal: referencingSeal(at, r.relation, r.columns),
				write: relation
			}))
}

/** The referenced checks an update or delete of `relation` makes: one per relation whose foreign key references it,
 * and one per relation the installation states no fact of, which may. */
const referencedChecks = (
	at: Installation,
	relation: string,
	statement: number
): ReadonlyArray<Check> =>
	[...at.named].flatMap((r): ReadonlyArray<Check> => {
		const facts = at.relations.get(r)
		if (facts === undefined) {
			return [
				{ statement, relation: r, side: "referenced", seal: unknownSeal(at, r), write: relation }
			]
		}
		return facts.references.some((ref) => ref.relation === relation)
			? [
					{
						statement,
						relation: r,
						side: "referenced",
						seal: referencedSeal(at, r),
						write: relation
					}
				]
			: []
	})

/** Every foreign key check a member's writes make, at each write's statement. */
const checksOf = (at: Installation, member: MemberFacts): ReadonlyArray<Check> =>
	member.statements.flatMap((s, statement) =>
		s.writes.flatMap((w): ReadonlyArray<Check> => [
			...(w.op === "delete" ? [] : referencingChecks(at, w.relation, statement)),
			...(w.op === "insert" ? [] : referencedChecks(at, w.relation, statement))
		])
	)

/** The relations a role writes: those it holds a writer's privilege on, those the members it may be served write, and
 * those its updates cascade to. */
const writtenBy = (at: Installation, served: Served): ReadonlySet<string> => {
	const out = new Set<string>(cascaded(at.relations, updatedBy(served)))
	for (const [relation, privileges] of served.role.privileges) {
		if ([...privileges].some((p) => writing.has(p))) {
			out.add(relation)
		}
	}
	for (const member of served.members) {
		for (const s of member.statements) {
			for (const w of s.writes) {
				out.add(w.relation)
			}
		}
	}
	return out
}

/**
 * One member as the conditions read it, built once: its reads placed and sealed, its outside ones, and its foreign key
 * checks.
 */
interface MemberView {
	readonly member: MemberFacts
	readonly reads: ReadonlyArray<PlacedRead>
	readonly outsides: ReadonlyArray<PlacedRead>
	/** What condition 5b reads of the reads that feed each write, by statement then write (Fed). */
	readonly fed: ReadonlyArray<ReadonlyArray<Fed>>
	readonly checks: ReadonlyArray<Check>
}

/** A site a role's member reads a relation at, by a statement's read or a foreign key check. */
interface ReadSite {
	readonly member: string
	readonly statement: number
	readonly by: "statement" | "check"
}

/**
 * One role as the conditions read it, built once: its members' views, the relations it writes, what its writes make of
 * them, those its writes' probes read, those it reads from outside by a read no fence orders (`outside`), every
 * relation it reads with the sites it reads it at, but the checks of the rows that reference a row its member deletes
 * where its login fences the deleted relation (fencedSite), and why it may miss another call's write were it
 * SERIALIZABLE (pivotCauseOf).
 */
interface RoleView {
	readonly role: RoleFacts
	readonly members: ReadonlyArray<MemberView>
	readonly written: ReadonlySet<string>
	/** What it writes as another role's judge reads it: everything it writes. */
	readonly guarded: ReadonlySet<string>
	/**
	 * The stored relations its writes keep (facts.ts RelationFacts `upkept`), each re-derived by the judge of its
	 * transaction at the units it wrote, reading at the transaction's snapshot.
	 */
	readonly upkept: ReadonlySet<string>
	/** What its writes make of each relation it writes (Made), by a privilege, a member or a cascade. */
	readonly made: ReadonlyMap<string, ReadonlySet<Made>>
	/**
	 * The relations the probes of its writes read: every relation of every witness of a rule over a query (TriggerLaw)
	 * that a write of it breaks (breaksAt), read at COMMIT at a snapshot of each probe's own. Each is an outside read of
	 * it, by no lock, so no fence orders it (`outside`).
	 */
	readonly probed: ReadonlySet<string>
	/**
	 * The relations it reads from outside by a read no fence orders, sealed or not: a statement's, or a probe's of its
	 * writes. Its foreign key checks are none: a sealed one (lockedSeal) reads a relation no role updates, and every
	 * login whose writes of it could meet the check out of order fences it (Fence, fencesOf); an unsealed one fails
	 * `pivot` itself (pivotReasons).
	 */
	readonly outside: ReadonlySet<string>
	readonly sites: ReadonlyMap<string, ReadonlyArray<ReadSite>>
	readonly cause: string | undefined
}

/**
 * Whether a check's seal is a sealed referencing check's, a point, held or fenced: of a relation no role updates, at a
 * whole declared key. Every referencing check takes ROW SHARE on its relation before its own snapshot and locks the row
 * it finds FOR KEY SHARE until its call ends (PostgreSQL 19 ri_triggers.c ri_FastPathCheck and ri_LockPKTuple), so a
 * login that fences the relation (Fence) keeps every such check out of each of its writes of it: the check committed
 * before the write's lock, which the write's snapshot follows, or takes its snapshot after the write committed.
 */
const lockedSeal = (seal: ReadSeal): boolean =>
	seal.kind === "point" || seal.kind === "held" || seal.kind === "fenced"

/**
 * Whether a check of a member of a role of `login` is a fenced write's check of the rows that reference the row it
 * deletes, so no site of conditions 2 and 3: the login fences the deleted relation, so every member of it that writes
 * the relation locks it IN EXCLUSIVE MODE before its snapshot. Every committed call whose row references one the member
 * deletes checked the deleted relation, under the ROW SHARE lock that conflicts with it, either committing before the
 * member's lock, which lets the member's snapshot and its check see the row, or checking after the member committed,
 * which refuses the call where the member deleted the row it references; the check of the referencing rows reads the
 * latest committed ones (ri_triggers.c ri_PerformCheck), and a row in flight that references a deleted one fails its
 * own check.
 */
const fencedSite = (at: Installation, login: string, c: Check): boolean =>
	c.side === "referenced" && at.writers.fences(login, c.write)

const memberView = (at: Installation, member: MemberFacts): MemberView => {
	const { placed, fed } = readsOf(at, member)
	return {
		member,
		reads: placed,
		outsides: placed.filter((p) => outside(p.seal)),
		fed,
		checks: checksOf(at, member)
	}
}

/**
 * Why a role, were it SERIALIZABLE, may be the pivot of a cycle, by a read that can miss another call's write: an outside
 * read of a statement; a foreign key check that is unsealed, or that reads the rows referencing a row it changes; or a
 * law over a relation it writes held by triggers. None where it has no such read: each of its checks, sealed, finds an
 * immutable row, or one its KEY SHARE lock holds until it commits (held), or refuses its call whole, a held row deleted
 * since its snapshot refusing it with 40001.
 */
const pivotCauseOf = (
	at: Installation,
	members: ReadonlyArray<MemberView>,
	written: ReadonlySet<string>
): string | undefined => {
	for (const v of members) {
		const [read] = v.outsides
		if (read !== undefined) {
			return `it reads ${read.read.relation} from outside at SERIALIZABLE`
		}
		const check = v.checks.find(
			(c) => outside(c.seal) && (c.side === "referenced" || c.seal.kind === "unsealed")
		)
		if (check !== undefined) {
			return `its foreign key check of ${check.relation} may miss another call's row at SERIALIZABLE`
		}
	}
	const [held] = [...written].filter(
		(relation) => (at.relations.get(relation)?.triggerLaws ?? []).length > 0
	)
	return held === undefined ? undefined : `a law over ${held}, which it writes, is held by triggers`
}

/** What a role's writes make of each relation it writes (Made): its privileges', its members' and its cascades'. */
const madeOf = (at: Installation, served: Served): ReadonlyMap<string, ReadonlySet<Made>> => {
	const out = new Map<string, Set<Made>>()
	const note = (relation: string, op: WriteFact["op"]): void => {
		for (const m of madeBy(op)) {
			setAt(out, relation).add(m)
		}
	}
	for (const [relation, privileges] of served.role.privileges) {
		for (const p of privileges) {
			const op = permitted(p)
			if (op !== undefined) {
				note(relation, op)
			}
		}
	}
	for (const member of served.members) {
		for (const s of member.statements) {
			for (const w of s.writes) {
				note(w.relation, w.op)
			}
		}
	}
	for (const relation of cascaded(at.relations, updatedBy(served))) {
		note(relation, "update")
	}
	return out
}

/**
 * Whether a write of `relation` that makes `made` of its rows breaks witness `w`, firing the probe that reads it: it
 * makes a row present where the relation stands among the witness's `rows` or `present`, or absent where it stands
 * among its `absent`.
 */
export const breaksAt = (made: ReadonlySet<Made>, w: Witness, relation: string): boolean =>
	(made.has("present") && (w.rows.includes(relation) || w.present.includes(relation))) ||
	(made.has("absent") && w.absent.includes(relation))

/** The occurrences of a witness some role's write can make true, each by where it stands and its relation. */
const settable = (
	writers: Writers,
	w: Witness
): ReadonlyArray<{ readonly at: "rows" | "present" | "absent"; readonly relation: string }> => [
	...w.rows.flatMap((relation) =>
		writers.makes(relation, "present") ? [{ at: "rows" as const, relation }] : []
	),
	...w.present.flatMap((relation) =>
		writers.makes(relation, "present") ? [{ at: "present" as const, relation }] : []
	),
	...w.absent.flatMap((relation) =>
		writers.makes(relation, "absent") ? [{ at: "absent" as const, relation }] : []
	)
]

/**
 * Whether a witness is monotone: exactly one of its occurrences is one some role's write can make true, and it stands
 * among its `rows`, one row of a match of its breaking arm. A probe of the write that makes it true reads every other
 * occurrence as one no write makes true.
 */
const monotone = (writers: Writers, w: Witness): boolean => {
	const [one, ...more] = settable(writers, w)
	return one !== undefined && more.length === 0 && one.at === "rows"
}

/** The rules over queries over `relation` a write of it that makes `made` breaks a witness of (breaksAt), each with the
 * witnesses it breaks. */
const broken = (
	at: Installation,
	relation: string,
	made: ReadonlySet<Made>
): ReadonlyArray<{ readonly law: TriggerLaw; readonly witnesses: ReadonlyArray<Witness> }> =>
	(at.relations.get(relation)?.triggerLaws ?? []).flatMap((law) => {
		const ws = law.witnesses.filter((w) => breaksAt(made, w, relation))
		return ws.length === 0 ? [] : [{ law, witnesses: ws }]
	})

/** A role's view over every member it may be served (Served), each member read once into its view. */
const roleView = (at: Installation, served: Served): RoleView => {
	const members = served.members.map((m) => memberView(at, m))
	const sites = new Map<string, Array<ReadSite>>()
	/** Each site once, whatever reads or modes reach it there. */
	const seen = new TupleSet<readonly [string, string, number, ReadSite["by"]]>()
	const site = (relation: string, s: ReadSite): void => {
		const key = [relation, s.member, s.statement, s.by] as const
		if (seen.has(key)) {
			return
		}
		seen.add(key)
		const held = sites.getOrInsertComputed(relation, () => [])
		held.push(s)
	}
	for (const v of members) {
		for (const p of v.reads) {
			site(p.read.relation, { member: v.member.name, statement: p.statement, by: "statement" })
		}
		for (const c of v.checks) {
			if (!fencedSite(at, served.role.login, c)) {
				site(c.relation, { member: v.member.name, statement: c.statement, by: "check" })
			}
		}
	}
	const written = writtenBy(at, served)
	const made = madeOf(at, served)
	const probed = new Set(
		[...made].flatMap(([relation, m]) =>
			broken(at, relation, m).flatMap((b) =>
				b.witnesses.flatMap((w) => [...w.rows, ...w.present, ...w.absent])
			)
		)
	)
	const read = new Set([
		...members.flatMap((v) => v.outsides.map((p) => p.read.relation)),
		...probed
	])
	return {
		role: served.role,
		members,
		written,
		guarded: written,
		upkept: new Set([...written].flatMap((relation) => at.relations.get(relation)?.upkept ?? [])),
		made,
		probed,
		cause: pivotCauseOf(at, members, written),
		outside: read,
		sites
	}
}

const reason = <C extends IsolationCondition>(
	condition: C,
	at: ReasonAt,
	detail: string
): IsolationReason<C> => ({
	condition,
	at,
	detail
})

/** A relation a role touches, as a reason's place. */
const atRelation = (relation: string): ReasonAt => ({ kind: "relation", relation })

/** A statement in a member's flight and the relation it reads or writes, as a reason's place. */
const atStatement = (member: string, statement: number, relation: string): ReasonAt => ({
	kind: "statement",
	member,
	statement,
	relation
})

/** Every relation the role touches, by a privilege, a write, a check, a probe of its writes or a read of other than its
 * own call's rows, that the installation states no fact of. */
const factReasons = (at: Installation, view: RoleView): ReadonlyArray<IsolationReason<"facts">> =>
	[
		...new Set([
			...view.role.privileges.keys(),
			...view.written,
			...view.probed,
			...view.members.flatMap((v) => [
				...v.reads.flatMap((p) => (p.read.own ? [] : [p.read.relation])),
				...v.checks.map((c) => c.relation)
			])
		])
	].flatMap((relation) =>
		at.relations.has(relation)
			? []
			: [reason("facts", atRelation(relation), "the installation states no fact of it")]
	)

/** The members condition: the role has a change member, whose facts the other conditions read. */
const memberReasons = (role: RoleFacts): ReadonlyArray<IsolationReason<"members">> =>
	role.writes.kind === "unknown"
		? [
				reason(
					"members",
					{ kind: "role" },
					"it has no change member: it writes, if at all, by direct SQL alone, which no member's facts prove"
				)
			]
		: []

/** Condition 1: every privilege the role holds is INSERT or SELECT, and no role updates or deletes a relation it
 * writes. */
const privilegeReasons = (
	at: Installation,
	role: RoleFacts,
	written: ReadonlySet<string>
): ReadonlyArray<IsolationReason<"privileges">> => [
	...[...role.privileges].flatMap(([relation, privileges]) =>
		[...privileges].flatMap((p) =>
			insertAndSelect.has(p) ? [] : [reason("privileges", atRelation(relation), `holds ${p}`)]
		)
	),
	...[...written].flatMap((relation) =>
		at.writers.insertOnly(relation)
			? []
			: [
					reason(
						"privileges",
						atRelation(relation),
						"it writes the relation, which a role updates or deletes, so it is not insert-only"
					)
				]
	)
]

/**
 * Condition 2's own half: every law over a relation the role writes that a deferred trigger holds is monotone in its
 * write there: each witness its write of the relation breaks is monotone (`monotone`). One reason per relation whose
 * write breaks one that is not, naming every such law.
 */
const lawReasons = (at: Installation, view: RoleView): ReadonlyArray<IsolationReason<"laws">> =>
	[...view.made].flatMap(([relation, made]): ReadonlyArray<IsolationReason<"laws">> => {
		const laws = broken(at, relation, made).flatMap((b) =>
			b.witnesses.every((w) => monotone(at.writers, w)) ? [] : [b.law.law]
		)
		return laws.length === 0
			? []
			: [
					reason(
						"laws",
						atRelation(relation),
						`laws ${laws.join(", ")} over it are held by triggers, and its write of it can make a violation true that reads another row some role's write can make present or absent, or reads its row other than as one row of a match`
					)
				]
	})

/** A site some role's member reads a relation's absence or count at, for condition 3, with how. */
interface AbsenceSite {
	readonly reader: RoleFacts
	readonly member: string
	readonly statement: number
	readonly how: string
}

/**
 * Every relation some member of some role reads by absence or by count, with each site: a read negated, counted, or an
 * arbitration no unique check decides, which is an absence probe; or the check of the rows that reference a row the
 * member updates or deletes, but a fenced write's (fencedSite).
 */
const absenceSites = (
	installation: Installation,
	views: ReadonlyArray<RoleView>
): ReadonlyMap<string, ReadonlyArray<AbsenceSite>> => {
	const out = new Map<string, Array<AbsenceSite>>()
	/** Each site once, whatever reads or modes reach it there. */
	const seen = new TupleSet<readonly [string, RoleFacts, string, number, string]>()
	const add = (relation: string, s: AbsenceSite): void => {
		const key = [relation, s.reader, s.member, s.statement, s.how] as const
		if (seen.has(key)) {
			return
		}
		seen.add(key)
		const held = out.getOrInsertComputed(relation, () => [])
		held.push(s)
	}
	for (const view of views) {
		for (const v of view.members) {
			const at = { reader: view.role, member: v.member.name }
			for (const p of v.reads) {
				if (p.mode === "negated" || p.mode === "counted") {
					add(p.read.relation, { ...at, statement: p.statement, how: `reads it ${p.mode}` })
				} else if (p.mode === "arbiter" && p.seal.kind === "unsealed") {
					add(p.read.relation, {
						...at,
						statement: p.statement,
						how: "reads it as an arbitration of no whole declared key"
					})
				}
			}
			for (const c of v.checks) {
				if (c.side === "referenced" && !fencedSite(installation, view.role.login, c)) {
					add(c.relation, {
						...at,
						statement: c.statement,
						how: "checks the absence of its rows that reference a row it updates or deletes"
					})
				}
			}
		}
	}
	return out
}

/**
 * Condition 3: no change member of any role reads the absence or a count of a relation the role writes. It never decides
 * a level alone: generate's report names each site it finds, with its fix, so an author sees what to restate, but every
 * site leaves the roles writing its relation SERIALIZABLE by another condition too. A site of a role that runs
 * SERIALIZABLE is one of its sites (RoleView `sites`, every read and unfenced check), which gives every role writing the
 * relation `laws` (givenReasons). A site of a judged role makes that role SERIALIZABLE by a condition of its own, which
 * then gives `laws` too: its change member writes, so a negated or counted read of another call's rows fails `pivot`
 * (pivotReasons reads every outside read's mode), as an arbitration of no whole key does, unsealed; and a check of the
 * rows that reference a row it updates or deletes is a role's that holds UPDATE or DELETE, which fails `privileges`. The
 * sites left read the call's own rows, or a row its own arbitration fixed, which no other call changes.
 */
const absenceReasons = (
	view: RoleView,
	absent: ReadonlyMap<string, ReadonlyArray<AbsenceSite>>
): ReadonlyArray<IsolationReason<"absence">> =>
	[...view.guarded].flatMap((relation) =>
		(absent.get(relation) ?? []).map((s) =>
			reason(
				"absence",
				atStatement(s.member, s.statement, relation),
				`${s.reader.role} of ${s.reader.login} ${s.how}`
			)
		)
	)

/**
 * Condition 5a: an outside read that is no sealed group shares its statement with every other outside read, and no
 * outside foreign key check, which reads at a later snapshot, stands beside it; an unsealed check stands beside no other
 * outside read. One reason per unsealed read or check that has another snapshot beside it. It never decides a level
 * alone: generate's report names each such read, with its fix, but every read it names is an unsealed outside read of a
 * change member, which writes, so it fails `pivot` too, and every check it names is unsealed, which fails `pivot`
 * whatever the member reads (pivotReasons).
 */
const snapshotReasons = (view: RoleView): ReadonlyArray<IsolationReason<"snapshot">> =>
	view.members.flatMap((v) => {
		const checks = v.checks.filter((c) => outside(c.seal))
		const statements = new Set(v.outsides.map((p) => p.statement))
		return [
			...v.outsides.flatMap((p) =>
				p.seal.kind === "unsealed" && (statements.size > 1 || checks.length > 0)
					? [
							reason(
								"snapshot",
								atStatement(v.member.name, p.statement, p.read.relation),
								`it reads ${p.read.relation} unsealed while the member reads rows another call can write at another snapshot too: ${p.seal.detail}`
							)
						]
					: []
			),
			...checks.flatMap((c) =>
				c.seal.kind === "unsealed" && (v.outsides.length > 0 || checks.length > 1)
					? [
							reason(
								"snapshot",
								atStatement(v.member.name, c.statement, c.relation),
								`its foreign key check of ${c.relation} is unsealed and reads at another snapshot than the member's other outside reads: ${c.seal.detail}`
							)
						]
					: []
			)
		]
	})

/** An outside read placed (PlacedRead) with the group it reads (groupOf), its text written once for the read. */
interface GroupedRead {
	readonly placed: PlacedRead
	readonly group: string
}

/**
 * A statement's outside reads as condition 5b reads them of every write of the statement, built once for the statement
 * (`statementOutsides`): its outside placed reads with their groups, in their order; how many reads they are, a read
 * being its place in the statement's own body, or its place in the query CTE every instance of which reads it
 * (PlacedRead), whatever modes it takes and whatever read facts its instances read, so one read may read several groups;
 * how many groups each read reads, by the read's number, its place among the reads; and the reads of each group.
 */
interface StatementOutsides {
	readonly placed: NonEmptyReadonlyArray<GroupedRead>
	readonly reads: number
	readonly groupsOf: ReadonlyArray<number>
	readonly readsOf: ReadonlyMap<string, ReadonlyArray<number>>
}

/** Each statement's outside reads (StatementOutsides), by the place of the statement, from `grouped` in their order. */
const statementOutsides = (
	grouped: ReadonlyArray<GroupedRead>
): ReadonlyMap<number, StatementOutsides> => {
	const placed = new Map<number, Array<GroupedRead>>()
	for (const g of grouped) {
		placed.getOrInsertComputed(g.placed.statement, () => []).push(g)
	}
	const out = new Map<number, StatementOutsides>()
	for (const [statement, of] of placed) {
		if (!isNonEmpty(of)) {
			continue
		}
		const numbers = new TupleMap<readonly [number | undefined, number], number>()
		const groupsOf: Array<number> = []
		const readsOf = new Map<string, Array<number>>()
		const held = new TupleSet<readonly [number, string]>()
		for (const { placed: p, group } of of) {
			const read = numbers.getOrInsertComputed([p.query, p.at.read], () => {
				groupsOf.push(0)
				return groupsOf.length - 1
			})
			if (held.has([read, group])) {
				continue
			}
			held.add([read, group])
			groupsOf[read] = (groupsOf[read] ?? 0) + 1
			readsOf.getOrInsertComputed(group, () => []).push(read)
		}
		out.set(statement, { placed: of, reads: groupsOf.length, groupsOf, readsOf })
	}
	return out
}

/**
 * The reads of a statement's outside reads (StatementOutsides) a write joined with the groups `joined` (Fed) is not
 * joined with, each read one where some instance of it reads a group the write is joined with none of: the first placed
 * such read, in their order, and how many more reads; none where it is joined with every one. The count is the
 * statement's reads less those whose every group the write is joined with, read off the reads of each joined group, so a
 * write reads its own joined groups and the placed reads ahead of its first unjoined one, never every read of the
 * statement again.
 */
const unjoinedOf = (
	at: StatementOutsides,
	joined: ReadonlySet<string>
): { readonly first: PlacedRead; readonly more: number } | undefined => {
	const first = at.placed.find((r) => !joined.has(r.group))
	if (first === undefined) {
		return undefined
	}
	const joinedGroups = new Map<number, number>()
	for (const group of joined) {
		for (const read of at.readsOf.get(group) ?? []) {
			joinedGroups.set(read, (joinedGroups.get(read) ?? 0) + 1)
		}
	}
	let covered = 0
	for (const [read, groups] of joinedGroups) {
		if (groups === at.groupsOf[read]) {
			covered++
		}
	}
	return { first: first.placed, more: at.reads - covered - 1 }
}

/**
 * Condition 5b: a member with an outside read and a write reads every outside group sealed and positively, and every
 * row it writes reaches every outside group it reads: joined with each outside read of its statement, and, after a
 * statement that read from outside, with a row its own call wrote; no write comes before a group read only later. Each
 * of its foreign key checks is sealed. One reason per read, mode, check or write that fails. A write joined with none
 * of its statement's outside reads of some groups gives one reason: "a row it writes is not joined with the read of X
 * in its statement, nor with N more outside read(s) there", X the relation of the first such read and N the number of
 * the others, each read counted once (statementOutsides): a read of a query CTE is one read, however many sites read the
 * CTE and however they arrive, and a read taking several modes is one read.
 */
const pivotReasons = (view: RoleView): ReadonlyArray<IsolationReason<"pivot">> =>
	view.members.flatMap((v) => {
		const name = v.member.name
		const checks = v.checks.flatMap((c) =>
			c.seal.kind === "unsealed"
				? [
						reason(
							"pivot",
							atStatement(name, c.statement, c.relation),
							`its foreign key check: ${c.seal.detail}`
						)
					]
				: []
		)
		const writes = v.member.statements.flatMap((s, statement) =>
			s.writes.map((w, place) => ({ statement, w, fed: v.fed[statement]?.[place] }))
		)
		if (v.outsides.length === 0 || writes.length === 0) {
			return checks
		}
		const unsealed = v.outsides.flatMap((p) => {
			const where = atStatement(name, p.statement, p.read.relation)
			if (p.seal.kind === "unsealed") {
				return [reason("pivot", where, p.seal.detail)]
			}
			return p.mode === "positive" ? [] : [reason("pivot", where, `it reads the group ${p.mode}`)]
		})
		/** Each outside read with its group, the group's text written once for the read, however many writes read it. */
		const grouped = v.outsides.map((p): GroupedRead => ({ placed: p, group: groupOf(p.read) }))
		const first = new Map<string, number>()
		for (const { placed: p, group } of grouped) {
			first.set(group, Math.min(first.get(group) ?? p.statement, p.statement))
		}
		const lastFirst = [...first.values()].reduce(
			(most, at) => Math.max(most, at),
			Number.NEGATIVE_INFINITY
		)
		const firstOutside = v.outsides.reduce(
			(least, p) => Math.min(least, p.statement),
			Number.POSITIVE_INFINITY
		)
		const outsidesAt = statementOutsides(grouped)
		const unjoined = writes.flatMap(({ statement, w, fed }) => {
			const where = atStatement(name, statement, w.relation)
			const outsides = outsidesAt.get(statement)
			const missed =
				outsides === undefined ? undefined : unjoinedOf(outsides, fed?.joined ?? new Set<string>())
			const own = fed?.own ?? false
			return [
				...(missed === undefined
					? []
					: [
							reason(
								"pivot",
								where,
								`a row it writes is not joined with the read of ${missed.first.read.relation} in its statement, nor with ${missed.more} more outside read(s) there`
							)
						]),
				...(statement > firstOutside && !own
					? [
							reason(
								"pivot",
								where,
								"a row it writes after a statement that read from outside is joined with no row its call wrote"
							)
						]
					: []),
				...(lastFirst > statement
					? [
							reason(
								"pivot",
								where,
								"a row it writes comes before a group the member reads only later"
							)
						]
					: [])
			]
		})
		return [...checks, ...unsealed, ...unjoined]
	})

/**
 * Reasons each once, in their order: a reason names one site (IsolationReason), so two of one condition, place and detail
 * are one reason, however many reads, modes or instances of a query CTE gave it.
 */
const distinctReasons = <C extends IsolationCondition>(
	reasons: ReadonlyArray<IsolationReason<C>>
): ReadonlyArray<IsolationReason<C>> => {
	const seen = new Set<string>()
	return reasons.filter((r) => {
		const key = canonicalTextOf(r)
		if (seen.has(key)) {
			return false
		}
		seen.add(key)
		return true
	})
}

/** Every reason a role fails that no other role's verdict changes. */
const ownReasons = (
	at: Installation,
	view: RoleView,
	absent: ReadonlyMap<string, ReadonlyArray<AbsenceSite>>
): ReadonlyArray<IsolationReason<OwnCondition>> => [
	...factReasons(at, view),
	...memberReasons(view.role),
	...privilegeReasons(at, view.role, view.written),
	...lawReasons(at, view),
	...absenceReasons(view, absent),
	...snapshotReasons(view),
	...pivotReasons(view)
]

/**
 * The reasons a role that runs SERIALIZABLE, `other`, gives a role: condition 2's other half, a change member of it
 * reading a relation the role writes, by a statement or a foreign key check, one per site; and condition 5c, it writing
 * a relation the role's members read from outside by a read no fence orders (RoleView.outside), sealed or not, while it
 * may miss another call's write itself (RoleView.cause, pivotCauseOf), one per such relation. A sealed foreign key
 * check (lockedSeal) is no such read: it reads a relation no role updates, so every write of it may lock it, and the
 * writer's login fences it (Fence, fencesOf). Each such check committed before the writer's lock, which its snapshot
 * follows, so the writer misses no write that committed before the role's call ended, or took its own snapshot after
 * the writer committed, so it misses no row the writer inserted and finds no row the writer deleted: the edges a cycle
 * in real time through the role and the writer needs (NEGATION's case 3 needs one). Each detail speaks of `other` as
 * "it", the giver its reasons are told by (Giver).
 */
const givenReasons = (
	view: RoleView,
	other: RoleView
): ReadonlyArray<IsolationReason<GivenCondition>> => {
	const readers = [...view.written].flatMap((relation) =>
		(other.sites.get(relation) ?? []).map((s) =>
			reason(
				"laws",
				atStatement(s.member, s.statement, relation),
				s.by === "statement"
					? "it reads the relation at SERIALIZABLE"
					: "it reads the relation by a foreign key check at SERIALIZABLE"
			)
		)
	)
	const cowriters = [...other.guarded].flatMap((relation) =>
		view.written.has(relation)
			? [
					reason(
						"writers",
						atRelation(relation),
						"it runs SERIALIZABLE and writes the relation too, so the guard admits no READ COMMITTED write of it"
					)
				]
			: []
	)
	const keepers = [...other.upkept].flatMap((relation) =>
		view.upkept.has(relation)
			? [
					reason(
						"writers",
						atRelation(relation),
						"it runs SERIALIZABLE and its writes keep the stored relation at units the role's writes keep it at, its upkeep reading them at its transaction's snapshot, which misses a READ COMMITTED writer's commit"
					)
				]
			: []
	)
	const pivot = other.cause
	return pivot === undefined
		? [...readers, ...cowriters, ...keepers]
		: [
				...readers,
				...cowriters,
				...keepers,
				...[...other.guarded].flatMap((relation) =>
					view.outside.has(relation)
						? [reason("writers", atRelation(relation), `it writes the relation, and ${pivot}`)]
						: []
				)
			]
}

/**
 * Each of `judges`, the roles that run SERIALIZABLE, that gives a role a reason (givenReasons), with the reasons it
 * gives, each once, in the judges' order.
 */
const giversOf = (view: RoleView, judges: ReadonlyArray<RoleView>): ReadonlyArray<Giver> =>
	judges.flatMap((other) => {
		const reasons = distinctReasons(givenReasons(view, other))
		return isNonEmpty(reasons) ? [{ login: other.role.login, role: other.role.role, reasons }] : []
	})

/**
 * What certification lowers a role to once it runs SERIALIZABLE: its change members compiled for SERIALIZABLE, as
 * their facts (`facts`) and as the form it is served (`form`).
 */
export interface Lowering<S> {
	readonly facts: ReadonlyArray<MemberFacts>
	readonly form: S
}

/**
 * One role to certify, by its facts (`role`), its privileges and its change members compiled for READ COMMITTED:
 * `formed`, every member with a READ COMMITTED form, the form it is served while it runs READ COMMITTED
 * (`readCommitted`), and its lowering (`lower`), which certification takes once, in the round that first leaves it
 * SERIALIZABLE; or `unformed`, a member with none (facts.ts Unformed), so it has no member at READ COMMITTED and runs
 * SERIALIZABLE from the first round, by the condition `form`, its lowering already taken (`lowering`).
 */
export type Candidate<R, S, E> =
	| {
			readonly kind: "formed"
			readonly role: RoleFacts
			readonly readCommitted: R
			readonly lower: () => Result.Result<Lowering<S>, E>
	  }
	| {
			readonly kind: "unformed"
			readonly role: RoleFacts
			readonly unformed: NonEmptyReadonlyArray<Unformed>
			readonly lowering: Lowering<S>
	  }

/** A role certification judges over its READ COMMITTED form. */
type Formed<R, S, E> = Extract<Candidate<R, S, E>, { readonly kind: "formed" }>

/**
 * One role certified, with the form it is served at its level: READ COMMITTED, every condition proved, served its own
 * form; or SERIALIZABLE, served its lowered form, with why (Serializable), the reasons of the round that lowered it, the
 * ones that made it SERIALIZABLE.
 */
export type Certified<R, S> =
	| {
			readonly level: Extract<Isolation, "readCommitted">
			readonly role: RoleFacts
			readonly form: R
	  }
	| {
			readonly level: Extract<Isolation, "serializable">
			readonly role: RoleFacts
			readonly form: S
			readonly why: Serializable
	  }

/** A certified role's certificate, by its login and its role. */
export const isolationOf = <R, S>(certified: Certified<R, S>): RoleIsolation => ({
	login: certified.role.login,
	role: certified.role.role,
	certificate:
		certified.level === "readCommitted"
			? { level: certified.level }
			: { level: certified.level, why: certified.why }
})

/** A role a round lowered: its lowering, and why that round lowered it, which it keeps. */
interface Lowered<R, S, E> {
	readonly kind: "lowered"
	readonly candidate: Candidate<R, S, E>
	readonly lowering: Lowering<S>
	readonly why: Serializable
}

/** A role a round reads: judged, over its READ COMMITTED form, or lowered by a round before it or by its form. */
type Standing<R, S, E> =
	| { readonly kind: "judged"; readonly candidate: Formed<R, S, E> }
	| Lowered<R, S, E>

/**
 * A role after a round: judged READ COMMITTED, judged SERIALIZABLE with why, the round's reasons, which lowers it, or
 * lowered by a round before it.
 */
type Judgement<R, S, E> =
	| { readonly kind: "readCommitted"; readonly candidate: Formed<R, S, E> }
	| {
			readonly kind: "serializable"
			readonly candidate: Formed<R, S, E>
			readonly why: Serializable
	  }
	| Lowered<R, S, E>

/**
 * Every member a role may be served: its READ COMMITTED form while it is judged, and its SERIALIZABLE form beside it once
 * lowered. A lowered role keeps its READ COMMITTED form among the facts it judges others by, so each round reads every
 * fact the one before it read and every reason a round gave holds at the fixpoint.
 */
const servedOf = <R, S, E>(standing: Standing<R, S, E>): Served => ({
	role: standing.candidate.role,
	members:
		standing.kind === "judged"
			? writtenFacts(standing.candidate.role)
			: [...writtenFacts(standing.candidate.role), ...standing.lowering.facts]
})

/** One role of a round, read once into its view: judged, with the reasons of its own conditions, or lowered. */
type Viewed<R, S, E> =
	| {
			readonly kind: "judged"
			readonly candidate: Formed<R, S, E>
			readonly view: RoleView
			readonly own: ReadonlyArray<IsolationReason<OwnCondition>>
	  }
	| (Lowered<R, S, E> & { readonly view: RoleView })

/** A round's installation, and every role's judgement with its view there, in the roles' order. */
interface Round<R, S, E> {
	readonly at: Installation
	readonly roles: ReadonlyArray<{ readonly judgement: Judgement<R, S, E>; readonly view: RoleView }>
}

/**
 * One round: the judgement of every judged role, over the members each role is served (servedOf). A judged role meets
 * its own conditions over its READ COMMITTED form and every role's served members, its own SERIALIZABLE form never among
 * them; the absence sites of condition 3 are every role's. The lowered roles run SERIALIZABLE, and so do the judged roles
 * that fail a condition of their own; a judged role one of those gives a reason runs SERIALIZABLE too, which may give
 * another one, until none changes. Each step only adds roles, so the judged roles left READ COMMITTED are the greatest
 * set every member of which meets every condition against the rest. A role that runs SERIALIZABLE by others alone names
 * every reason each other role that runs SERIALIZABLE at the round's end gives it, never one of its own making. Each role
 * and member is read once into its view, and a reason names one site, never a pair of them. Roles keep their order.
 */
const round = <R, S, E>(
	relations: ReadonlyMap<string, RelationFacts>,
	standings: ReadonlyArray<Standing<R, S, E>>
): Round<R, S, E> => {
	const forms = standings.map((standing) => ({ standing, served: servedOf(standing) }))
	const at = installationOf(
		relations,
		forms.map((f) => f.served)
	)
	const viewed = forms.map(({ standing, served }) => ({ standing, view: roleView(at, served) }))
	const absent = absenceSites(
		at,
		viewed.map((v) => v.view)
	)
	const roles = viewed.map(({ standing, view }): Viewed<R, S, E> =>
		standing.kind === "judged"
			? {
					kind: "judged",
					candidate: standing.candidate,
					view,
					own: distinctReasons(ownReasons(at, view, absent))
				}
			: { ...standing, view }
	)
	const serializable = new Set(roles.filter((r) => r.kind === "lowered" || r.own.length > 0))
	let changed = true
	while (changed) {
		changed = false
		const judges = [...serializable].map((r) => r.view)
		for (const r of roles) {
			if (!serializable.has(r) && judges.some((other) => givenReasons(r.view, other).length > 0)) {
				serializable.add(r)
				changed = true
			}
		}
	}
	const judgementOf = (r: Viewed<R, S, E>): Judgement<R, S, E> => {
		if (r.kind === "lowered") {
			return { kind: "lowered", candidate: r.candidate, lowering: r.lowering, why: r.why }
		}
		if (isNonEmpty(r.own)) {
			return { kind: "serializable", candidate: r.candidate, why: { kind: "own", reasons: r.own } }
		}
		const by = serializable.has(r)
			? giversOf(
					r.view,
					roles.flatMap((other) => (other !== r && serializable.has(other) ? [other.view] : []))
				)
			: []
		return isNonEmpty(by)
			? { kind: "serializable", candidate: r.candidate, why: { kind: "given", by } }
			: { kind: "readCommitted", candidate: r.candidate }
	}
	return { at, roles: roles.map((r) => ({ judgement: judgementOf(r), view: r.view })) }
}

/** A settled role's certificate with the form it is served at it. */
const certifiedOf = <R, S, E>(
	judgement: Exclude<Judgement<R, S, E>, { readonly kind: "serializable" }>
): Certified<R, S> =>
	judgement.kind === "readCommitted"
		? {
				level: "readCommitted",
				role: judgement.candidate.role,
				form: judgement.candidate.readCommitted
			}
		: {
				level: "serializable",
				role: judgement.candidate.role,
				form: judgement.lowering.form,
				why: judgement.why
			}

/**
 * A relation a login fences: a role certified READ COMMITTED checks it by a sealed foreign key check (lockedSeal), no
 * role updating it, and the login's writes of it could otherwise meet that check out of any order in real time: its
 * roles delete it, a deletion the check may wait on and then miss the key's insertion in the same transaction (ReadSeal
 * fenced), or that a deleting member's check of the rows referencing it relies on (fencedSite); or a role of it that runs
 * SERIALIZABLE and may miss another call's write (RoleView.cause) writes it, an insertion the check may miss in flight
 * after the writer missed a write that committed before the check's call began (NEGATION's case 3, givenReasons).
 * Every change member of the login that writes it begins its transaction with LOCK TABLE ... IN EXCLUSIVE MODE on it
 * before any statement takes the snapshot, and the installation grants the login MAINTAIN on it, the least privilege
 * that permits the lock (PostgreSQL 19 lockcmds.c LockTableAclCheck): every check takes ROW SHARE on it before its own
 * snapshot, which the lock excludes, so each either committed before such a write's lock, which the write's snapshot
 * follows, or takes its snapshot after the write committed. `for` names the roles certified READ COMMITTED whose checks
 * of it rely on the lock, in the roles' order.
 */
export interface Fence {
	readonly login: string
	readonly relation: string
	readonly for: NonEmptyReadonlyArray<{ readonly login: string; readonly role: string }>
}

/**
 * A writer that may be the pivot of a dangerous structure through a relation it writes (Fekete et al., 2005): a role
 * that runs SERIALIZABLE and may miss another call's write (RoleView.cause, pivotCauseOf), by its login, its name and that
 * cause, which a read of the relation that SSI does not track could see beside the write it missed. A role certified
 * READ COMMITTED is none: `pivot` holds each of its writes to one made after outside reads of sealed groups alone, which
 * a group it misses empties, and `laws` its probes to ones that pass at every later state, so it behaves as run at once.
 */
export interface PivotWriter {
	readonly login: string
	readonly role: string
	readonly cause: string
}

/**
 * Every role certified, in the candidates' order; the fences the READ COMMITTED ones rely on; and each relation a writer
 * that may be a pivot writes (`pivots`, PivotWriter), with every such writer, in the roles' order.
 */
export interface Certifications<R, S> {
	readonly roles: ReadonlyArray<Certified<R, S>>
	readonly fences: ReadonlyArray<Fence>
	readonly pivots: ReadonlyMap<string, NonEmptyReadonlyArray<PivotWriter>>
}

/**
 * The fences of a settled round's roles, over its installation (`at`), each role with its view there: for each relation
 * a role certified READ COMMITTED checks by a sealed check (lockedSeal), one fence of each login that fences it (Fence):
 * each login whose roles delete it (Writers.fencers), and each login of a role that runs SERIALIZABLE, may miss another
 * call's write (RoleView.cause) and writes it (RoleView.guarded), the writers 5c spared for the
 * fence (givenReasons); by login then relation in code-unit order.
 */
const fencesOf = <R, S, E>(
	at: Installation,
	settled: ReadonlyArray<{
		readonly judgement: Exclude<Judgement<R, S, E>, { readonly kind: "serializable" }>
		readonly view: RoleView
	}>
): ReadonlyArray<Fence> => {
	const pivots = settled.flatMap(({ judgement, view }) =>
		judgement.kind === "lowered" && view.cause !== undefined ? [view] : []
	)
	const relying = new Map<string, Array<{ readonly login: string; readonly role: string }>>()
	for (const { judgement, view } of settled) {
		if (judgement.kind !== "readCommitted") {
			continue
		}
		const { login, role } = view.role
		const checked = new Set(
			view.members.flatMap((v) => v.checks.flatMap((c) => (lockedSeal(c.seal) ? [c.relation] : [])))
		)
		for (const relation of checked) {
			const roles = relying.getOrInsertComputed(relation, () => [])
			roles.push({ login, role })
		}
	}
	return [...relying]
		.flatMap(([relation, roles]): ReadonlyArray<Fence> => {
			const fencers = new Set([
				...at.writers.fencers(relation),
				...pivots.flatMap((p) => (p.guarded.has(relation) ? [p.role.login] : []))
			])
			return isNonEmpty(roles) ? [...fencers].map((login) => ({ login, relation, for: roles })) : []
		})
		.toSorted((a, b) => compareStrings(a.login, b.login) || compareStrings(a.relation, b.relation))
}

/**
 * The pivots of a settled round's roles, each with its view there (Certifications `pivots`): each role that runs
 * SERIALIZABLE and may miss another call's write (RoleView.cause), at each relation it writes (RoleView.guarded), its
 * cause read off every member it may be served, both its forms (servedOf), as 5c and the fences read it
 * (serializableReasons, fencesOf).
 */
const pivotsOf = <R, S, E>(
	settled: ReadonlyArray<{
		readonly judgement: Exclude<Judgement<R, S, E>, { readonly kind: "serializable" }>
		readonly view: RoleView
	}>
): ReadonlyMap<string, NonEmptyReadonlyArray<PivotWriter>> => {
	const out = new Map<string, NonEmptyReadonlyArray<PivotWriter>>()
	for (const { judgement, view } of settled) {
		const cause = view.cause
		if (judgement.kind !== "lowered" || cause === undefined) {
			continue
		}
		const writer: PivotWriter = { login: view.role.login, role: view.role.role, cause }
		for (const relation of view.guarded) {
			out.set(relation, [...(out.get(relation) ?? []), writer])
		}
	}
	return out
}

/** The condition `form`: one reason per change member with no READ COMMITTED form, at the relation it has none for. */
const formReasons = (
	unformed: NonEmptyReadonlyArray<Unformed>
): NonEmptyReadonlyArray<IsolationReason<"form">> =>
	mapNonEmpty(unformed, (u) =>
		reason(
			"form",
			{ kind: "member", member: u.member, relation: u.relation },
			noReadCommittedFormText(u.relation)
		)
	)

/** A role as the first round reads it: judged over its READ COMMITTED form, or lowered already by its `form`. */
const standingOf = <R, S, E>(candidate: Candidate<R, S, E>): Standing<R, S, E> =>
	candidate.kind === "formed"
		? { kind: "judged", candidate }
		: {
				kind: "lowered",
				candidate,
				lowering: candidate.lowering,
				why: { kind: "own", reasons: formReasons(candidate.unformed) }
			}

/**
 * Every role's certificate, in rounds over the relations' facts `relations`, the roles `candidates` in their order. The
 * first round judges every role over its READ COMMITTED form, a role with none lowered before it, by the condition
 * `form` alone; each round lowers the roles it judged SERIALIZABLE (their `lower`), which keep that round's reasons as
 * their certificate's, and the next judges the rest beside every lowering, until a round lowers none. A lowered role is
 * never judged again: it runs SERIALIZABLE from then on, since each round reads every fact the one before it read
 * (servedOf), and its certificate names the reasons that made it SERIALIZABLE, never one its own lowering gave. Every
 * round but the last lowers a role, so there are at most one more rounds than roles. A lowering that fails fails
 * certification. The fences are the last round's (fencesOf), over its installation and its views, and so are the pivots
 * (pivotsOf).
 */
export const certify = <R, S, E>(
	relations: ReadonlyMap<string, RelationFacts>,
	candidates: ReadonlyArray<Candidate<R, S, E>>
): Result.Result<Certifications<R, S>, E> => {
	let standings = candidates.map(standingOf)
	for (;;) {
		const judged = round(relations, standings)
		const settled = judged.roles.flatMap(({ judgement, view }) =>
			judgement.kind === "serializable" ? [] : [{ judgement, view }]
		)
		if (settled.length === judged.roles.length) {
			return Result.ok({
				roles: settled.map((r) => certifiedOf(r.judgement)),
				fences: fencesOf(judged.at, settled),
				pivots: pivotsOf(settled)
			})
		}
		const next: Array<Standing<R, S, E>> = []
		for (const { judgement: j } of judged.roles) {
			if (j.kind === "serializable") {
				const lowering = j.candidate.lower()
				if (!lowering.ok) {
					return lowering
				}
				next.push({
					kind: "lowered",
					candidate: j.candidate,
					lowering: lowering.value,
					why: j.why
				})
			} else {
				next.push(j.kind === "readCommitted" ? { kind: "judged", candidate: j.candidate } : j)
			}
		}
		standings = next
	}
}
