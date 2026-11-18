import {
	type BodyFacts,
	type CteUse,
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
	type StatementFacts,
	type TriggerLaw,
	type Unformed,
	type WriteFact
} from "#compiler/analysis/isolation/facts.ts"
import type { Witness } from "#compiler/analysis/theory/query.ts"
import { compareText } from "#compiler/core/canonical.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"
import * as Result from "#compiler/core/result.ts"
import { TupleSet } from "#compiler/core/tuple-map.ts"

/**
 * The conditions a role's change members must all meet to run READ COMMITTED, after `form`, that every change member
 * has a READ COMMITTED form (facts.ts Unformed), and `facts`, that the installation states a fact of every relation the
 * role holds a privilege on, reads, checks or writes. An outside read is a read of
 * rows another call can write: of a relation some role writes, neither grizzle's own key arbitration nor of the call's
 * own rows. A foreign key check (Check) is a read too, which no statement shows, made by PostgreSQL at another snapshot
 * than its statement's.
 *
 * - `members`: the role has a change member. A role with none writes, if at all, by direct SQL alone, which no member's
 *   facts prove: its writes are unknown (facts.ts RoleWrites), and every other role is judged beside the one member that
 *   bounds them (writtenFacts), which reads anything its grants let it read, present or absent, and writes all its
 *   privileges permit, so it is a pivot cause of every relation it writes, and conditions 2, 3 and 5c weigh its reads of
 *   every relation it can read. It takes no fence grizzle serves, so no foreign key check of a relation it writes is
 *   sealed (Writers.direct);
 * - `privileges`: the role holds only INSERT and SELECT, and every relation it writes is insert-only for every role of
 *   every login (Writers.insertOnly): no role holds UPDATE or DELETE on it, no member updates or deletes it, and no
 *   update of a relation it references cascades to it. The insert protocol at READ COMMITTED rests on it: a row DO
 *   SELECT finds beyond the snapshot never combines with the snapshot's reads into a write no serial order makes only
 *   while no occupant a probe saw can be deleted and replaced (write/insert/protocol.ts storedAbsent and the probe and
 *   ON CONFLICT DO SELECT arms of buildInsert; write/insert/unique.ts RelationUniques, its arbiter and probes);
 * - `laws`: every law over a relation it writes is native or monotone in its write of it (lawReasons): of each witness
 *   of a rule over a query (facts.ts TriggerLaw) the write breaks, making a row of the relation present where it stands
 *   among the witness's `rows` or `present`, or absent where it stands among its `absent`, exactly one occurrence is one
 *   some role's write can make true (Writers.makes), a row present or absent as it stands, and that one stands among
 *   its `rows`, a match of its breaking arm; and no change member of a role that runs SERIALIZABLE reads a relation it
 *   writes, by a statement or a foreign key check, but a fenced write's check of the rows that reference a row it
 *   deletes (fencedSite);
 * - `absence`: no change member of any role reads the absence or a count of a relation it writes, by a statement or by
 *   the check of a foreign key that references a row the member updates or deletes, a fenced write's again excepted;
 * - `snapshot`: in each of its members, an outside read that is no sealed group (ReadSeal) shares its statement with
 *   every other outside read, and no outside foreign key check, which reads at a later snapshot, stands beside it; an
 *   unsealed check stands beside no other outside read;
 * - `pivot`: a member with an outside read and a write is a pivot, each write of which another call may read. Each of
 *   its outside reads is a sealed group read positively, and each row it writes reaches every one of them: joined
 *   with each group its own statement reads from outside, and, after a statement that read from outside, with a row its own
 *   call wrote; no write comes before a group the member reads only later. A group it misses makes it write nothing;
 *   a group it reads again is the same rows or none, since a sealed group is immutable and never extended. Each of its
 *   foreign key checks is sealed: a sealed check finds its row, immutable or held (ReadSeal), or refuses the call whole;
 * - `writers`: no role that runs SERIALIZABLE and writes a relation the role reads from outside by a read no fence
 *   orders (RoleView.outside), by a statement or a probe of a rule over a query its own write fires (RoleView.probed),
 *   can miss another call's write (pivotCauseOf), so none is the pivot of a cycle through it: no
 *   statement of it reads from outside, none of its foreign key checks is unsealed or reads the rows that reference a
 *   row it changes, and it writes no relation a trigger-held law reads. A sealed check of its own, of an insert-only
 *   relation at a whole declared key or of one no role writes, finds an immutable row or refuses its call, which at
 *   SERIALIZABLE then commits nothing, so it misses no write; a held one finds a row its KEY SHARE lock keeps until it
 *   commits, or a row deleted since its snapshot, which PostgreSQL refuses at SERIALIZABLE with 40001
 *   (ri_triggers.c ri_LockPKTuple), or refuses its call. The role's own sealed checks of what such a writer writes are
 *   fenced instead: a sealed check that misses a key an in-flight writer inserts waits for no lock and refuses its call
 *   (NEGATION's case 3, the refusedCopy shape in test/unit/analysis/isolation/certify.test.ts), so the writer's login
 *   fences the relation (Fence), whose lock keeps every such check out of the writer's transaction and its snapshot
 *   after every check that committed before it. A sealed read is no
 *   exemption: a reader of one writer call's rows can miss an in-flight SERIALIZABLE writer whose read's writer committed
 *   before the reader began, which no serial order in real time explains, and a statement's read takes no lock a fence
 *   excludes. No role that runs SERIALIZABLE writes a relation the role writes, by a
 *   privilege, a member or a cascade: the installation's guard admits a READ COMMITTED write of a relation only where
 *   every role that writes it runs READ COMMITTED, and refuses any other with 25000 (physical/ddl/isolation.ts
 *   readCommittedRelations), so a role certified past it would have every write refused.
 *
 * A retirable unit's retirement (facts.ts WriteFact `retire`) is no update or delete of its relations: a change member
 * that touches a unit's bodies holds every group it touches from before its first statement that does until it commits
 * (physical/ddl/retire.ts, the hold), and a retirement locks every header it retires before it reads a body, so it waits
 * for every call that holds one; each call then reads a group's rows insert-only from its hold to its commit, and no
 * retired group is ever written again (the unit's fence). A retirement reads nothing besides the groups it locks and
 * makes no check, so it misses no write and is no pivot; it counts among its own role's writes, whose guard and laws it
 * meets, and among no other role's judgement of it (RoleView.guarded).
 *
 * A role is served the form its level chooses, so certification runs in rounds (certify): a role is judged over its
 * READ COMMITTED form, the one it is served while it runs READ COMMITTED, until a round leaves it SERIALIZABLE; it is
 * then lowered to its SERIALIZABLE form and never judged again, its certificate that round's. A role's own SERIALIZABLE
 * form is never among the facts it is judged by: it is served only once the role runs SERIALIZABLE, so no call of it
 * runs beside the role's READ COMMITTED calls. Whatever a lowered role's members read or write, conditions 2, 3 and 5c
 * included, is read from both its forms (Served), so every round reads the facts the one before it read and more.
 *
 * The criterion is strict serializability: every history the roles can run is one call at a time, in real time. With
 * these, an RC member's outside reads behave as one snapshot, its writes commit at once, every write-write conflict is
 * a native unique check decided in commit order, and no transaction, RC or SERIALIZABLE, can be the pivot of a
 * dangerous structure (Fekete et al., Making Snapshot Isolation Serializable, 2005).
 *
 * A rule over a query is checked at COMMIT by its triggers' probes (physical/ddl/rules.ts), each of a READ COMMITTED
 * call at a snapshot of its own: the latest commits and the call's own rows. Where every witness a write breaks is
 * monotone, as `laws` states it:
 *
 * 1. The rule holds in every committed state, whatever level wrote it. In commit order, a state that first breaks it
 *    through a witness was made so by the call that made the witness's one settable occurrence true, a row it wrote.
 *    Every other occurrence can only be made false, so it held at every earlier state and at that call's probe, which
 *    read its own row and refused it. A witness with more settable occurrences is broken by SERIALIZABLE writers
 *    alone, whose probes each read the others' occurrences, so SSI orders them; a READ COMMITTED write of its relations
 *    there only makes its occurrences false.
 * 2. A probe that passes at its snapshot passes at every later state: a write it missed is another row of the settable
 *    occurrence, in no witness through its own row, or one that only makes an occurrence false. So a READ COMMITTED
 *    call behaves as run at its COMMIT, in commit order, and a refused one as run at its probe's snapshot, unless a
 *    write its probe missed must come before it in every order: one whose writer missed another call's write that
 *    committed before the call began (NEGATION's case 3), which `writers` excludes over the relations its probes read.
 * 3. A SERIALIZABLE probe reads a relation a READ COMMITTED role writes only where it stands as an occurrence no role
 *    can make true, so a write of it SSI never sees could only have made the probe pass.
 */
export type IsolationCondition =
	| "form"
	| "facts"
	| "members"
	| "privileges"
	| "laws"
	| "absence"
	| "snapshot"
	| "pivot"
	| "writers"

/** One condition a role fails, where: the member and the statement in its flight, and the relation, where they apply. */
export interface IsolationReason {
	readonly condition: IsolationCondition
	readonly member: string | undefined
	readonly statement: number | undefined
	readonly relation: string | undefined
	readonly detail: string
}

/**
 * A role's level: READ COMMITTED only with every condition proved, otherwise SERIALIZABLE with the reasons of the round
 * that lowered it (certify).
 */
export type RoleCertificate =
	| { readonly level: Extract<Isolation, "readCommitted"> }
	| {
			readonly level: Extract<Isolation, "serializable">
			readonly reasons: NonEmptyReadonlyArray<IsolationReason>
	  }

/** One role of one login with its certificate. */
export interface RoleIsolation {
	readonly login: string
	readonly role: string
	readonly certificate: RoleCertificate
}

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
 *   sealed check, a point's too, against each writer that may miss another call's write, for 5c (serializableReasons);
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

/** Whether two keys name the same fields. */
const sameKey = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	a.length === b.length && a.every((f) => b.includes(f))

/**
 * The relations an update of `updated` reaches: them, and each relation whose foreign key into one of them carries an
 * update to its rows (ON UPDATE CASCADE), again and again.
 */
const cascaded = (
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
type Made = "present" | "absent"

/** What a write makes: an insert a row present, a delete one absent, and an update both, as a retirement does, which
 * deletes a unit's bodies' rows and sets its header's retirement field (physical/ddl/retire.ts). */
const madeBy = (op: WriteFact["op"]): ReadonlyArray<Made> => {
	switch (op) {
		case "insert":
			return ["present"]
		case "delete":
			return ["absent"]
		case "update":
		case "retire":
			return ["present", "absent"]
	}
}

/** The write a privilege permits, none for SELECT. */
const permitted = (p: TablePrivilege): WriteFact["op"] | undefined => {
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
		for (const [relation, facts] of relations) {
			if (facts.retirable) {
				for (const m of madeBy("retire")) {
					setAt(this.#made, relation).add(m)
				}
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

	/** One write of `relation` by a role of `login`. A retirement writes it but neither updates, deletes nor inserts a
	 * row of it: its relation's calls read each group they hold insert-only (facts.ts WriteFact `retire`). It makes rows
	 * present and absent all the same (madeBy), as the triggers it fires read them. */
	#note(relation: string, op: WriteFact["op"], login: LoginWrites): void {
		this.#written.add(relation)
		for (const m of madeBy(op)) {
			setAt(this.#made, relation).add(m)
		}
		switch (op) {
			case "retire":
				return
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

	/** Whether some role's write, or a retirable unit's retirement (RelationFacts.retirable), can make a row of the relation
	 * present, or absent (Made). */
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
			: [...(this.#deleters.get(relation) ?? [])].toSorted(compareText)
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

const sealOf = (at: Installation, read: ReadFact): ReadSeal => {
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
	const group = read.group
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
	if (facts.countedGroups.some((k) => sameKey(k, fields))) {
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
const keyIn = (
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
interface PlacedRead {
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
const bodyAt = (s: StatementFacts, cte: number | undefined): Body | undefined =>
	cte === undefined ? s : s.ctes[cte]

/** One read of a statement by its body and place, with its fact. */
interface StatedRead {
	readonly at: ReadAt
	readonly read: ReadFact
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
					out.push({ at: { cte, read: next }, read })
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

const sameProbes = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean =>
	a.length === b.length && a.every((p, i) => b[i] === p)

/**
 * The chain below the instance a body's use reaches, at `place` among the body's uses, where `chain` is the chain below
 * the body: the instance's own probes the probe chains, for the use it is judged at, else none; nothing where the use
 * stands beneath other probes than the chain names, so no read beneath it stands on it.
 */
const below = (chain: Chain, place: number, use: CteUse): Chain | undefined => {
	if (!sameProbes(use.probes, chain.local)) {
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
	fits: (r: ReadFact) => boolean
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
	fits: (r: ReadFact) => boolean
): RowPath | undefined => {
	switch (source.kind) {
		case "read": {
			const r = body.reads[source.read]
			return r !== undefined &&
				chain.via === undefined &&
				sameProbes(r.probes, chain.local) &&
				fits(r)
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
const rowPathOf = (s: StatementFacts, judged: Judged, g: string): RowPath | undefined => {
	const sources = judged.core === undefined ? undefined : judged.body.cores[judged.core]
	return sources === undefined
		? undefined
		: pathOf(
				s,
				judged.body,
				sources,
				judged.chain,
				(r) => r.base === "positive" && groupOf(r) === g
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
}

/** The first of `reads` of each group, by place. */
const firstOfEach = (reads: ReadonlyArray<StatedRead>): ReadonlyMap<string, ReadAt> => {
	const first = new Map<string, ReadAt>()
	for (const { at, read } of reads) {
		const g = groupOf(read)
		if (!first.has(g)) {
			first.set(g, at)
		}
	}
	return first
}

/**
 * A statement's grounds (Grounds), over `reads`, its reads some site reaches (statementReads): the bodies a site
 * beneath no probe reaches are its own and each instance a use beneath no probe of such a body reads.
 */
const groundsOf = (s: StatementFacts, reads: ReadonlyArray<StatedRead>): Grounds => {
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
			)
		),
		joined: s.writes.map((w) =>
			firstOfEach(
				w.from.flatMap((at) => {
					const read = bodyAt(s, at.cte)?.reads[at.read]
					return read !== undefined && reached.has([at.cte, at.read]) ? [{ at, read }] : []
				})
			)
		)
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
	const path = rowPathOf(s, judged, g)
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

/** `into` with the outside read `read`, sealed by `seal`. */
const gatherRead = (into: Gathering, read: ReadFact, seal: ReadSeal): void => {
	if (seal.kind === "unsealed") {
		into.unsealed = true
	} else {
		into.groups.add(groupOf(read))
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

const sealedOf = (s: StatementFacts, sealOfRead: (read: ReadFact) => ReadSeal): Sealed => {
	const own = s.reads.map(sealOfRead)
	const ctes = s.ctes.map((instance) => instance.reads.map(sealOfRead))
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
					gatherRead(into, read, seal)
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
						gatherRead(at(id), read, seal)
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
				const ownProbes = owned.get(use.cte) ?? own(use.cte, instance)
				owned.set(use.cte, ownProbes)
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
				const held = reaches.get(use.cte) ?? []
				held.push({ from: { body: from, place, use }, neutral, probes })
				reaches.set(use.cte, held)
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
	return facts.inserts.kind === "repeatable" || sameKey(facts.inserts.key, key)
}

/** The row of `fixed` a read reads: one fixed earlier in its member, of its relation, whose key fields it binds each to
 * what the arbitration bound it to, whatever else it binds; none where no such row is. */
const fixedFor = (
	fixed: ReadonlyArray<Fixed>,
	read: ReadFact,
	statement: number
): Fixed | undefined => {
	const group = read.group
	return group === undefined
		? undefined
		: fixed.find(
				(f) =>
					f.relation === read.relation &&
					f.statement < statement &&
					f.bound.every((b) => group.bound.some((r) => r.field === b.field && r.by === b.by))
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
const readsOf = (installation: Installation, member: MemberFacts): ReadonlyArray<PlacedRead> => {
	const stated = member.statements.map((s) => ({ s, reads: statementReads(s) }))
	const fixed: Array<Fixed> = []
	for (const [statement, { reads }] of stated.entries()) {
		const seals = reads.map(({ read }) => ({ read, seal: sealOf(installation, read) }))
		if (seals.some(({ seal }) => seal.kind !== "own" && seal.kind !== "arbiter")) {
			break
		}
		for (const { read, seal } of seals) {
			const group = read.group
			if (
				read.mode === "arbiter" &&
				seal.kind === "arbiter" &&
				group?.rows === "one" &&
				fixesAt(installation.relations.get(read.relation), seal.key)
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
	return stated.flatMap(({ s, reads }, statement) => {
		const sealed = sealedOf(s, (read): ReadSeal => {
			const seal = sealOf(installation, read)
			const by = seal.kind === "point" ? fixedFor(fixed, read, statement) : undefined
			return by === undefined ? seal : { kind: "arbitrated", key: by.key }
		})
		const reaches = reachesOf(s, groundsOf(s, reads), sealed)
		return reads.flatMap(({ at, read }): ReadonlyArray<PlacedRead> => {
			const seal = sealed.seals(at)
			if (seal === undefined) {
				return []
			}
			const modes = new Set(
				(reaches.get(at.cte) ?? []).map((r) =>
					r.neutral && read.probes.every((id) => r.probes[id] !== undefined) ? read.base : read.mode
				)
			)
			const query = at.cte === undefined ? undefined : s.ctes[at.cte]?.query
			return [...modes].map((mode) => ({ statement, at, query, read, seal, mode }))
		})
	})
}

/**
 * Each mode each read of `member` takes, by its statement and its body and place there, and whether the read is an
 * outside read, among the installation's roles each served its READ COMMITTED form (readsOf).
 */
export const readModes = (
	input: IsolationInput,
	member: MemberFacts
): ReadonlyArray<{
	readonly statement: number
	readonly at: ReadAt
	readonly mode: ReadFact["mode"]
	readonly outside: boolean
}> =>
	readsOf(
		installationOf(
			input.relations,
			input.roles.map((role) => ({ role, members: writtenFacts(role) }))
		),
		member
	).map((p) => ({ statement: p.statement, at: p.at, mode: p.mode, outside: outside(p.seal) }))

/** The text that names one group a read reads: its relation, its fields and what they are bound to. */
const groupOf = (r: ReadFact): string =>
	r.group === undefined
		? `${r.relation}()`
		: `${r.relation}(${groupFields(r.group).join(",")})=${r.group.bound.map((b) => b.by).join(",")}`

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
			...(w.op === "delete" || w.op === "retire"
				? []
				: referencingChecks(at, w.relation, statement)),
			...(w.op === "insert" || w.op === "retire" ? [] : referencedChecks(at, w.relation, statement))
		])
	)

/** The relations a role writes: those it holds a writer's privilege on, those the members it may be served write, and
 * those its updates cascade to. */
const writtenBy = (
	at: Installation,
	served: Served,
	retired: "counted" | "apart"
): ReadonlySet<string> => {
	const out = new Set<string>(cascaded(at.relations, updatedBy(served)))
	for (const [relation, privileges] of served.role.privileges) {
		if ([...privileges].some((p) => writing.has(p))) {
			out.add(relation)
		}
	}
	for (const member of served.members) {
		for (const s of member.statements) {
			for (const w of s.writes) {
				if (w.op !== "retire" || retired === "counted") {
					out.add(w.relation)
				}
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
	/**
	 * What it writes as another role's judge reads it: what it writes but by a retirement alone (`writtenBy` apart). A
	 * retirement waits for every call that holds a group it retires and reads nothing besides, so it is no pivot of any
	 * cycle, and its guard is no role's grants: a role's own retirement of a relation another role writes changes neither
	 * that role's level nor whether that relation keeps its guard.
	 */
	readonly guarded: ReadonlySet<string>
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
	const reads = readsOf(at, member)
	return {
		member,
		reads,
		outsides: reads.filter((p) => outside(p.seal)),
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
const breaksAt = (made: ReadonlySet<Made>, w: Witness, relation: string): boolean =>
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
	const site = (relation: string, s: ReadSite): void => {
		const held = sites.get(relation) ?? []
		held.push(s)
		sites.set(relation, held)
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
	const written = writtenBy(at, served, "counted")
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
		guarded: writtenBy(at, served, "apart"),
		made,
		probed,
		cause: pivotCauseOf(at, members, written),
		outside: read,
		sites
	}
}

const reason = (
	condition: IsolationCondition,
	at: { readonly member?: string; readonly statement?: number; readonly relation?: string },
	detail: string
): IsolationReason => ({
	condition,
	member: at.member,
	statement: at.statement,
	relation: at.relation,
	detail
})

/** Every relation the role touches, by a privilege, a write, a check, a probe of its writes or a read of other than its
 * own call's rows, that the installation states no fact of. */
const factReasons = (at: Installation, view: RoleView): ReadonlyArray<IsolationReason> =>
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
			: [reason("facts", { relation }, "the installation states no fact of it")]
	)

/** The members condition: the role has a change member, whose facts the other conditions read. */
const memberReasons = (role: RoleFacts): ReadonlyArray<IsolationReason> =>
	role.writes.kind === "unknown"
		? [
				reason(
					"members",
					{},
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
): ReadonlyArray<IsolationReason> => [
	...[...role.privileges].flatMap(([relation, privileges]) =>
		[...privileges].flatMap((p) =>
			insertAndSelect.has(p) ? [] : [reason("privileges", { relation }, `holds ${p}`)]
		)
	),
	...[...written].flatMap((relation) =>
		at.writers.insertOnly(relation)
			? []
			: [
					reason(
						"privileges",
						{ relation },
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
const lawReasons = (at: Installation, view: RoleView): ReadonlyArray<IsolationReason> =>
	[...view.made].flatMap(([relation, made]): ReadonlyArray<IsolationReason> => {
		const laws = broken(at, relation, made).flatMap((b) =>
			b.witnesses.every((w) => monotone(at.writers, w)) ? [] : [b.law.law]
		)
		return laws.length === 0
			? []
			: [
					reason(
						"laws",
						{ relation },
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
	const add = (relation: string, s: AbsenceSite): void => {
		const held = out.get(relation) ?? []
		held.push(s)
		out.set(relation, held)
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

/** Condition 3: no change member of any role reads the absence or a count of a relation the role writes. */
const absenceReasons = (
	view: RoleView,
	absent: ReadonlyMap<string, ReadonlyArray<AbsenceSite>>
): ReadonlyArray<IsolationReason> =>
	[...view.guarded].flatMap((relation) =>
		(absent.get(relation) ?? []).map((s) =>
			reason(
				"absence",
				{ member: s.member, statement: s.statement, relation },
				`${s.reader.role} of ${s.reader.login} ${s.how}`
			)
		)
	)

/**
 * Condition 5a: an outside read that is no sealed group shares its statement with every other outside read, and no
 * outside foreign key check, which reads at a later snapshot, stands beside it; an unsealed check stands beside no other
 * outside read. One reason per unsealed read or check that has another snapshot beside it.
 */
const snapshotReasons = (view: RoleView): ReadonlyArray<IsolationReason> =>
	view.members.flatMap((v) => {
		const checks = v.checks.filter((c) => outside(c.seal))
		const statements = new Set(v.outsides.map((p) => p.statement))
		return [
			...v.outsides.flatMap((p) =>
				p.seal.kind === "unsealed" && (statements.size > 1 || checks.length > 0)
					? [
							reason(
								"snapshot",
								{ member: v.member.name, statement: p.statement, relation: p.read.relation },
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
								{ member: v.member.name, statement: c.statement, relation: c.relation },
								`its foreign key check of ${c.relation} is unsealed and reads at another snapshot than the member's other outside reads: ${c.seal.detail}`
							)
						]
					: []
			)
		]
	})

/** Placed reads by the place of their statement, each statement's in their order. */
const byStatement = (
	placed: ReadonlyArray<PlacedRead>
): ReadonlyMap<number, ReadonlyArray<PlacedRead>> => {
	const by = new Map<number, Array<PlacedRead>>()
	for (const p of placed) {
		const held = by.get(p.statement)
		if (held === undefined) {
			by.set(p.statement, [p])
		} else {
			held.push(p)
		}
	}
	return by
}

/**
 * The first placed read of each read of the statement among `placed`, in their order: a read is its place in the
 * statement's own body, or its place in the query CTE every instance of which reads it (PlacedRead), whatever modes it
 * takes.
 */
const distinctReads = (placed: ReadonlyArray<PlacedRead>): ReadonlyArray<PlacedRead> => {
	const seen = new TupleSet<readonly [number | undefined, number]>()
	return placed.filter((p) => {
		const known = seen.has([p.query, p.at.read])
		seen.add([p.query, p.at.read])
		return !known
	})
}

/**
 * Condition 5b: a member with an outside read and a write reads every outside group sealed and positively, and every
 * row it writes reaches every outside group it reads: joined with each outside read of its statement, and, after a
 * statement that read from outside, with a row its own call wrote; no write comes before a group read only later. Each
 * of its foreign key checks is sealed. One reason per read, mode, check or write that fails. A write joined with none
 * of its statement's outside reads of some groups gives one reason: "a row it writes is not joined with the read of X
 * in its statement, nor with N more outside read(s) there", X the relation of the first such read and N the number of
 * the others, each read counted once (distinctReads): a read of a query CTE is one read, however many sites read the
 * CTE and however they arrive, and a read taking several modes is one read.
 */
const pivotReasons = (view: RoleView): ReadonlyArray<IsolationReason> =>
	view.members.flatMap((v) => {
		const name = v.member.name
		const checks = v.checks.flatMap((c) =>
			c.seal.kind === "unsealed"
				? [
						reason(
							"pivot",
							{ member: name, statement: c.statement, relation: c.relation },
							`its foreign key check: ${c.seal.detail}`
						)
					]
				: []
		)
		const writes = v.member.statements.flatMap((s, statement) =>
			s.writes.map((w) => ({ statement, w }))
		)
		if (v.outsides.length === 0 || writes.length === 0) {
			return checks
		}
		const unsealed = v.outsides.flatMap((p) => {
			const where = { member: name, statement: p.statement, relation: p.read.relation }
			if (p.seal.kind === "unsealed") {
				return [reason("pivot", where, p.seal.detail)]
			}
			return p.mode === "positive" ? [] : [reason("pivot", where, `it reads the group ${p.mode}`)]
		})
		const first = new Map<string, number>()
		for (const p of v.outsides) {
			const g = groupOf(p.read)
			first.set(g, Math.min(first.get(g) ?? p.statement, p.statement))
		}
		const lastFirst = [...first.values()].reduce(
			(most, at) => Math.max(most, at),
			Number.NEGATIVE_INFINITY
		)
		const firstOutside = v.outsides.reduce(
			(least, p) => Math.min(least, p.statement),
			Number.POSITIVE_INFINITY
		)
		const readsAt = byStatement(v.reads)
		const outsidesAt = byStatement(v.outsides)
		const unjoined = writes.flatMap(({ statement, w }) => {
			const where = { member: name, statement, relation: w.relation }
			const from = new TupleSet<readonly [number | undefined, number]>()
			for (const at of w.from) {
				from.add([at.cte, at.read])
			}
			const fed = (readsAt.get(statement) ?? []).filter((p) => from.has([p.at.cte, p.at.read]))
			const joined = new Set(fed.map((p) => groupOf(p.read)))
			const [missed, ...more] = distinctReads(
				(outsidesAt.get(statement) ?? []).filter((p) => !joined.has(groupOf(p.read)))
			)
			const own = fed.some((p) => p.seal.kind === "own" && p.mode === "positive")
			return [
				...(missed === undefined
					? []
					: [
							reason(
								"pivot",
								where,
								`a row it writes is not joined with the read of ${missed.read.relation} in its statement, nor with ${more.length} more outside read(s) there`
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

/** Every reason a role fails that no other role's verdict changes. */
const ownReasons = (
	at: Installation,
	view: RoleView,
	absent: ReadonlyMap<string, ReadonlyArray<AbsenceSite>>
): ReadonlyArray<IsolationReason> => [
	...factReasons(at, view),
	...memberReasons(view.role),
	...privilegeReasons(at, view.role, view.written),
	...lawReasons(at, view),
	...absenceReasons(view, absent),
	...snapshotReasons(view),
	...pivotReasons(view)
]

/**
 * The reasons the roles that run SERIALIZABLE give a role: condition 2's other half, a change member of one reading a
 * relation the role writes, by a statement or a foreign key check, one per site; and condition 5c, one writing a
 * relation the role's members read from outside by a read no fence orders (RoleView.outside), sealed or not, while it
 * may miss another call's write itself (RoleView.cause, pivotCauseOf), one per such relation. A sealed foreign key
 * check (lockedSeal) is no such read: it reads a relation no role updates, so every write of it may lock it, and the
 * writer's login fences it (Fence, fencesOf). Each such check committed before the writer's lock, which its snapshot
 * follows, so the writer misses no write that committed before the role's call ended, or took its own snapshot after
 * the writer committed, so it misses no row the writer inserted and finds no row the writer deleted: the edges a cycle
 * in real time through the role and the writer needs (NEGATION's case 3 needs one).
 */
const serializableReasons = (
	view: RoleView,
	judges: ReadonlyArray<RoleView>
): ReadonlyArray<IsolationReason> =>
	judges.flatMap((other) => {
		const readers = [...view.written].flatMap((relation) =>
			(other.sites.get(relation) ?? []).map((s) =>
				reason(
					"laws",
					{ member: s.member, statement: s.statement, relation },
					s.by === "statement"
						? `${other.role.role} of ${other.role.login} reads it at SERIALIZABLE`
						: `${other.role.role} of ${other.role.login} reads it by a foreign key check at SERIALIZABLE`
				)
			)
		)
		const cowriters = [...other.guarded].flatMap((relation) =>
			view.written.has(relation)
				? [
						reason(
							"writers",
							{ relation },
							`${other.role.role} of ${other.role.login} runs SERIALIZABLE and writes it too, so the guard admits no READ COMMITTED write of it`
						)
					]
				: []
		)
		const pivot = other.cause
		return pivot === undefined
			? [...readers, ...cowriters]
			: [
					...readers,
					...cowriters,
					...[...other.guarded].flatMap((relation) =>
						view.outside.has(relation)
							? [
									reason(
										"writers",
										{ relation },
										`${other.role.role} of ${other.role.login} writes it, and ${pivot}`
									)
								]
							: []
					)
				]
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
 * form; or SERIALIZABLE, served its lowered form, with the reasons of the round that lowered it, the ones that made it
 * SERIALIZABLE.
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
			readonly reasons: NonEmptyReadonlyArray<IsolationReason>
	  }

/** A certified role's certificate, by its login and its role. */
export const isolationOf = <R, S>(certified: Certified<R, S>): RoleIsolation => ({
	login: certified.role.login,
	role: certified.role.role,
	certificate:
		certified.level === "readCommitted"
			? { level: certified.level }
			: { level: certified.level, reasons: certified.reasons }
})

/** A role a round lowered: its lowering, and the reasons of that round, which it keeps. */
interface Lowered<R, S, E> {
	readonly kind: "lowered"
	readonly candidate: Candidate<R, S, E>
	readonly lowering: Lowering<S>
	readonly reasons: NonEmptyReadonlyArray<IsolationReason>
}

/** A role a round reads: judged, over its READ COMMITTED form, or lowered by a round before it or by its form. */
type Standing<R, S, E> =
	| { readonly kind: "judged"; readonly candidate: Formed<R, S, E> }
	| Lowered<R, S, E>

/**
 * A role after a round: judged READ COMMITTED, judged SERIALIZABLE with the round's reasons, which lowers it, or
 * lowered by a round before it.
 */
type Judgement<R, S, E> =
	| { readonly kind: "readCommitted"; readonly candidate: Formed<R, S, E> }
	| {
			readonly kind: "serializable"
			readonly candidate: Formed<R, S, E>
			readonly reasons: NonEmptyReadonlyArray<IsolationReason>
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
			readonly own: ReadonlyArray<IsolationReason>
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
					own: ownReasons(at, view, absent)
				}
			: { ...standing, view }
	)
	const serializable = new Set(roles.filter((r) => r.kind === "lowered" || r.own.length > 0))
	let changed = true
	while (changed) {
		changed = false
		const judges = [...serializable].map((r) => r.view)
		for (const r of roles) {
			if (!serializable.has(r) && serializableReasons(r.view, judges).length > 0) {
				serializable.add(r)
				changed = true
			}
		}
	}
	const judgementOf = (r: Viewed<R, S, E>): Judgement<R, S, E> => {
		if (r.kind === "lowered") {
			return { kind: "lowered", candidate: r.candidate, lowering: r.lowering, reasons: r.reasons }
		}
		const failed =
			r.own.length > 0 || !serializable.has(r)
				? r.own
				: serializableReasons(
						r.view,
						[...serializable].flatMap((other) => (other === r ? [] : [other.view]))
					)
		return isNonEmpty(failed)
			? { kind: "serializable", candidate: r.candidate, reasons: failed }
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
				reasons: judgement.reasons
			}

/**
 * A relation a login fences: a role certified READ COMMITTED checks it by a sealed foreign key check (lockedSeal), no
 * role updating it, and the login's writes of it could otherwise meet that check out of any order in real time: its
 * roles delete it, a deletion the check may wait on and then miss the key's insertion in the same transaction (ReadSeal
 * fenced), or that a deleting member's check of the rows referencing it relies on (fencedSite); or a role of it that runs
 * SERIALIZABLE and may miss another call's write (RoleView.cause) writes it, an insertion the check may miss in flight
 * after the writer missed a write that committed before the check's call began (NEGATION's case 3, serializableReasons).
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

/** Every role certified, in the candidates' order, and the fences the READ COMMITTED ones rely on. */
export interface Certifications<R, S> {
	readonly roles: ReadonlyArray<Certified<R, S>>
	readonly fences: ReadonlyArray<Fence>
}

/**
 * The fences of a settled round's roles, over its installation (`at`), each role with its view there: for each relation
 * a role certified READ COMMITTED checks by a sealed check (lockedSeal), one fence of each login that fences it (Fence):
 * each login whose roles delete it (Writers.fencers), and each login of a role that runs SERIALIZABLE, may miss another
 * call's write (RoleView.cause) and writes it but by a retirement alone (RoleView.guarded), the writers 5c spared for the
 * fence (serializableReasons); by login then relation in code-unit order.
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
			const roles = relying.get(relation) ?? []
			roles.push({ login, role })
			relying.set(relation, roles)
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
		.toSorted((a, b) => compareText(a.login, b.login) || compareText(a.relation, b.relation))
}

/** The condition `form`: one reason per change member with no READ COMMITTED form, at the relation it has none for. */
const formReasons = (
	unformed: NonEmptyReadonlyArray<Unformed>
): NonEmptyReadonlyArray<IsolationReason> =>
	mapNonEmpty(unformed, (u) =>
		reason(
			"form",
			{ member: u.member, relation: u.relation },
			`it inserts into ${u.relation}, whose primary key holds a span: an exclusion constraint arbitrates by ON CONFLICT DO NOTHING alone, so the insert has no READ COMMITTED form`
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
				reasons: formReasons(candidate.unformed)
			}

/**
 * Every role's certificate, in rounds over the relations' facts `relations`, the roles `candidates` in their order. The
 * first round judges every role over its READ COMMITTED form, a role with none lowered before it, by the condition
 * `form` alone; each round lowers the roles it judged SERIALIZABLE (their `lower`), which keep that round's reasons as
 * their certificate's, and the next judges the rest beside every lowering, until a round lowers none. A lowered role is
 * never judged again: it runs SERIALIZABLE from then on, since each round reads every fact the one before it read
 * (servedOf), and its certificate names the reasons that made it SERIALIZABLE, never one its own lowering gave. Every
 * round but the last lowers a role, so there are at most one more rounds than roles. A lowering that fails fails
 * certification. The fences are the last round's (fencesOf), over its installation and its views.
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
				fences: fencesOf(judged.at, settled)
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
					reasons: j.reasons
				})
			} else {
				next.push(j.kind === "readCommitted" ? { kind: "judged", candidate: j.candidate } : j)
			}
		}
		standings = next
	}
}
