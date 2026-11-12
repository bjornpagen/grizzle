import type {
	IsolationInput,
	MemberFacts,
	ProbeFact,
	ReadFact,
	RelationFacts,
	RoleFacts,
	RowSource,
	StatementFacts,
	WriteFact
} from "#compiler/analysis/isolation/facts.ts"
import { compareText } from "#compiler/core/canonical.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"
import * as Result from "#compiler/core/result.ts"

/**
 * The conditions a role's change members must all meet to run READ COMMITTED, after `facts`, that the installation
 * states a fact of every relation the role holds a privilege on, reads, checks or writes. An outside read is a read of
 * rows another call can write: of a relation some role writes, neither grizzle's own key arbitration nor of the call's
 * own rows. A foreign key check (Check) is a read too, which no statement shows, made by PostgreSQL at another snapshot
 * than its statement's.
 *
 * - `members`: the role has a change member. A role with none writes, if at all, by direct SQL alone, which no member's
 *   facts prove;
 * - `privileges`: the role holds only INSERT and SELECT, and every relation it writes is insert-only for every role of
 *   every login (Writers.insertOnly): no role holds UPDATE or DELETE on it, no member updates or deletes it, and no
 *   update of a relation it references cascades to it. The insert protocol at READ COMMITTED rests on it: a row DO
 *   SELECT finds beyond the snapshot never combines with the snapshot's reads into a write no serial order makes only
 *   while no occupant a probe saw can be deleted and replaced (write/insert/protocol.ts storedAbsent and the probe and
 *   ON CONFLICT DO SELECT arms of buildInsert; write/insert/unique.ts RelationUniques, its arbiter and probes);
 * - `laws`: every law over a relation it writes is native, and no change member of a role that runs SERIALIZABLE reads
 *   such a relation, by a statement or a foreign key check, but a fenced write's check of the rows that reference a
 *   row it deletes (fencedSite);
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
 * - `writers`: no role that runs SERIALIZABLE and writes a relation the role reads from outside, by a statement or a
 *   foreign key check, can miss another call's write (pivotCauseOf), so none is the pivot of a cycle through it: no
 *   statement of it reads from outside, none of its foreign key checks is unsealed or reads the rows that reference a
 *   row it changes, and it writes no relation a trigger-held law reads. A sealed check of its own, of an insert-only
 *   relation at a whole declared key or of one no role writes, finds an immutable row or refuses its call, which at
 *   SERIALIZABLE then commits nothing, so it misses no write; a held one finds a row its KEY SHARE lock keeps until it
 *   commits, or a row deleted since its snapshot, which PostgreSQL refuses at SERIALIZABLE with 40001
 *   (ri_triggers.c ri_LockPKTuple), or refuses its call. The role's own checks are no such exemption: they are
 *   outside reads 5c weighs against every role that runs SERIALIZABLE (the publication shape in
 *   test/unit/analysis/isolation/certify.test.ts). A sealed check that misses a key an in-flight writer inserts waits
 *   for no lock and refuses its call (NEGATION's case 3, the refusedCopy shape there), unless the writer's login fences
 *   the relation (ReadSeal fenced), whose lock keeps every such check out of the writer's transaction and its snapshot
 *   after every check that committed before it; and a sealed read is no exemption either: a reader of one writer call's
 *   rows can miss an in-flight SERIALIZABLE writer whose read's writer committed before the reader began, which no
 *   serial order in real time explains. No role that runs SERIALIZABLE writes a relation the role writes, by a
 *   privilege, a member or a cascade: the installation's guard admits a READ COMMITTED write of a relation only where
 *   every role that writes it runs READ COMMITTED, and refuses any other with 25000 (physical/ddl/isolation.ts
 *   readCommittedRelations), so a role certified past it would have every write refused.
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
 */
export type IsolationCondition =
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
 *   takes the ledger's ACCESS EXCLUSIVE lock before any statement (deploy/ledger/ledger.ts:266 and :331, grizzle
 *   adapter/migrate/apply.ts:104), where every Db call holds it in ACCESS SHARE, so every call's snapshot sees one
 *   migration state of it. An owner's psql session writing it outside a migration holds no such lock and falls outside
 *   this proof, under the documented direct-SQL doctrine;
 * - `counted`: an outside read of one group of an insert-only relation that is a family's members under an immutable
 *   owner holding their count, a set the count law fixes, all of it or none;
 * - `point`: an outside read binding every field of a declared key of an insert-only relation, so one row at most,
 *   which no later call changes;
 * - `arbitrated`: a point read of an insert-only relation at exactly the group the call's own earlier statement
 *   arbitrated in it, by its parameters: once that statement inserted the row or met it as an exact repeat, DO SELECT
 *   waiting for its writer's commit, the row at the key is the call's own or committed and never changes, so the read
 *   sees exactly it and misses no write;
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
 *   login deletes is fenced the same way where the role relies on it, for conditions 2, 3 and 5c (fencedSite,
 *   serializableReasons);
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
const setAt = (by: Map<string, Set<string>>, key: string): Set<string> => {
	const held = by.get(key)
	if (held !== undefined) {
		return held
	}
	const made = new Set<string>()
	by.set(key, made)
	return made
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
 * ROLE (physical/ddl/roles.ts), and a direct transaction may change role between its statements.
 */
class Writers {
	readonly #written = new Set<string>()
	readonly #changed = new Set<string>()
	readonly #updated = new Set<string>()
	readonly #deleters = new Map<string, Set<string>>()
	readonly #replacers = new Map<string, Set<string>>()

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

	/** One write of `relation` by a role of `login`. */
	#note(relation: string, op: WriteFact["op"], login: LoginWrites): void {
		this.#written.add(relation)
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
	 * Whether `login` fences the relation (Fence): its roles delete it and no role updates it, so every change member of
	 * the login that writes it locks it before its snapshot where a READ COMMITTED check of it relies on that lock.
	 */
	fences(login: string, relation: string): boolean {
		return !this.#updated.has(relation) && (this.#deleters.get(relation)?.has(login) ?? false)
	}

	/** The logins that fence the relation, in code-unit order. */
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
					...s.reads.flatMap((r) => (r.own ? [] : [r.relation]))
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
			input.roles.map((role) => ({ role, members: role.members }))
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
			? arbiterSeal(facts, group?.fields)
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
	if (facts.countedGroups.some((k) => sameKey(k, group.fields))) {
		return { kind: "counted", key: group.fields }
	}
	return keyedSeal("point", facts, group.fields)
}

/**
 * A read by `fields` of an insert-only relation, a point, or a check of a relation Writers finds held or fenced, held or
 * fenced: where they hold a whole declared key, else unsealed.
 */
const keyedSeal = (
	kind: "point" | "held" | "fenced",
	facts: RelationFacts,
	fields: ReadonlyArray<string>
): ReadSeal => {
	const key = keyIn(facts, fields)
	return key === undefined ? unkeyed(fields) : { kind, key }
}

/** A declared key of the relation whose every field `fields` holds, none where no key is. */
const keyIn = (
	facts: RelationFacts,
	fields: ReadonlyArray<string>
): ReadonlyArray<string> | undefined => facts.keys.find((k) => k.every((f) => fields.includes(f)))

/** The seal of a read by `fields` that hold no whole declared key, nor a family's counted members. */
const unkeyed = (fields: ReadonlyArray<string>): ReadSeal => ({
	kind: "unsealed",
	detail: `its group by ${fields.join(", ")} is neither a family's counted members nor a whole declared key`
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

/** One read of a member, at its statement's place in the member's flight and its own in the statement's reads. */
interface PlacedRead {
	readonly statement: number
	readonly index: number
	readonly read: ReadFact
	readonly seal: ReadSeal
	readonly mode: ReadFact["mode"]
}

/**
 * The proof every row of a probe's core comes through a positive read of a group beneath the probes the probe chains,
 * along the core's row sources (StatementFacts.cores): the read itself, by its place in its statement's reads; a
 * derived table's or a CTE's core, by its number, with its own proof; or a UNION's, one proof per arm in arm order,
 * each row of it one arm's.
 */
type RowPath =
	| { readonly kind: "read"; readonly read: number }
	| { readonly kind: "core"; readonly core: number; readonly path: RowPath }
	| { readonly kind: "union"; readonly arms: NonEmptyReadonlyArray<RowPath> }

/** The proof of the first of `sources` whose every row comes through reads `fits` admits; none where no source has one. */
const pathOf = (
	s: StatementFacts,
	sources: ReadonlyArray<RowSource>,
	fits: (r: ReadFact) => boolean
): RowPath | undefined => {
	for (const source of sources) {
		const path = sourcePath(s, source, fits)
		if (path !== undefined) {
			return path
		}
	}
	return undefined
}

/** One row source's proof: its read where `fits` admits it, its core's proof, or one proof for each of its arms. */
const sourcePath = (
	s: StatementFacts,
	source: RowSource,
	fits: (r: ReadFact) => boolean
): RowPath | undefined => {
	switch (source.kind) {
		case "read": {
			const r = s.reads[source.read]
			return r !== undefined && fits(r) ? source : undefined
		}
		case "core": {
			const sources = s.cores[source.core]
			const path = sources === undefined ? undefined : pathOf(s, sources, fits)
			return path === undefined ? undefined : { kind: "core", core: source.core, path }
		}
		case "union": {
			const arms = source.arms.flatMap((arm) => {
				const path = pathOf(s, arm, fits)
				return path === undefined ? [] : [path]
			})
			return arms.length === source.arms.length && isNonEmpty(arms)
				? { kind: "union", arms }
				: undefined
		}
	}
}

/**
 * The row path from a probe's core to positive reads of group `g` beneath the probes it chains, none where the probe
 * stands in no core or no such path is.
 */
const rowPathOf = (s: StatementFacts, probe: ProbeFact, g: string): RowPath | undefined => {
	const sources = probe.core === undefined ? undefined : s.cores[probe.core]
	return sources === undefined
		? undefined
		: pathOf(
				s,
				sources,
				(r) =>
					r.probes.length === probe.chain.length &&
					r.probes.every((step, i) => probe.chain[i] === step) &&
					r.base === "positive" &&
					groupOf(r) === g
			)
}

/**
 * Why one outside read beneath a probe leaves the probe a function of positive reads: the statement's positive read of
 * its sealed group beneath no probe (`positive`), the read of that group in the `from` of each write the probe gates
 * (`joins`), and the row path from the probe's core to positive reads of it beneath the probe's own probes alone
 * (`path`).
 */
interface Neutral {
	readonly positive: number
	readonly joins: ReadonlyArray<number>
	readonly path: RowPath
}

/** The proof an outside read of sealed group `g` beneath `probe` leaves it neutral, none where a part of it is missing. */
const neutralBy = (s: StatementFacts, probe: ProbeFact, g: string): Neutral | undefined => {
	const positive = s.reads.findIndex(
		(r) => r.probes.length === 0 && r.mode === "positive" && groupOf(r) === g
	)
	const joins = probe.gates.flatMap((k) => {
		const at = s.writes[k]?.from.find((i) => {
			const r = s.reads[i]
			return r !== undefined && groupOf(r) === g
		})
		return at === undefined ? [] : [at]
	})
	const path = rowPathOf(s, probe, g)
	return positive < 0 || joins.length < probe.gates.length || path === undefined
		? undefined
		: { positive, joins, path }
}

/**
 * The probes of a statement that are a function of positive reads, by their places, each with its proof, one Neutral
 * per non-own outside read beneath it: each such read is of a sealed group the statement also reads positively, beneath
 * no probe, every write the probe gates is joined with that group, and every row of the core whose rows the probe
 * filters or counts comes through a positive read of it beneath no further probe (rowPathOf), a UNION's through one in
 * each arm, so every row the probe touches passes through the group. NEGATION's fallback: a rule's NOT EXISTS in another
 * arm of the same write's UNION, or beside a UNION one of whose arms, a recursive CTE's base or its recursion's own rows
 * among them, never reads the group, gates rows the group never reaches; and an ungrouped count, which yields a row
 * over no input, is judged by the core its value lands in. A sealed
 * group is read whole or not at all at the statement's one snapshot, and a miss empties every write the probe gates, so
 * the probe's result reaches no write the positive read does not; a refusal it raises needs the group present. Any
 * other probe keeps the mode it composes, so a negation of a sealed point no positive read gates is still an absence
 * read.
 */
const neutralOf = (
	s: StatementFacts,
	placed: ReadonlyArray<{ readonly read: ReadFact; readonly seal: ReadSeal }>
): ReadonlyMap<number, ReadonlyArray<Neutral>> => {
	const neutral = new Map<number, ReadonlyArray<Neutral>>()
	for (const [id, probe] of s.probes.entries()) {
		const proofs: Array<Neutral> = []
		const holds = placed.every(({ read, seal }) => {
			if (!read.probes.includes(id) || !outside(seal)) {
				return true
			}
			const proof = seal.kind === "unsealed" ? undefined : neutralBy(s, probe, groupOf(read))
			if (proof !== undefined) {
				proofs.push(proof)
			}
			return proof !== undefined
		})
		if (holds) {
			neutral.set(id, proofs)
		}
	}
	return neutral
}

/**
 * Every read of a member, each placed, sealed, and with its mode: its base mode where every probe above it is neutral
 * (neutralOf), else the mode it composes. A point read at a group an earlier statement of the member arbitrated is
 * arbitrated, whatever its mode, since the row there is fixed, where that statement and every one before it read only the call's own rows and arbitrations, so the
 * row it proposes at the group is the call's whatever the installation holds: an insert an outside read gates may
 * propose nothing, and the later read then meets another call's row (NEGATION's claimStart, the publication case).
 */
const readsOf = (at: Installation, member: MemberFacts): ReadonlyArray<PlacedRead> => {
	const arbitrated = new Map<string, number>()
	for (const [statement, s] of member.statements.entries()) {
		const seals = s.reads.map((read) => ({ read, seal: sealOf(at, read) }))
		if (seals.some(({ seal }) => seal.kind !== "own" && seal.kind !== "arbiter")) {
			break
		}
		for (const { read, seal } of seals) {
			const g = groupOf(read)
			if (
				read.mode === "arbiter" &&
				seal.kind === "arbiter" &&
				read.group?.rows === "one" &&
				!arbitrated.has(g)
			) {
				arbitrated.set(g, statement)
			}
		}
	}
	return member.statements.flatMap((s, statement) => {
		const placed = s.reads.map((read, index) => {
			const seal = sealOf(at, read)
			const by = arbitrated.get(groupOf(read))
			return {
				index,
				read,
				seal:
					seal.kind === "point" && by !== undefined && by < statement
						? { kind: "arbitrated" as const, key: seal.key }
						: seal
			}
		})
		const neutral = neutralOf(s, placed)
		return placed.map((p): PlacedRead => ({
			...p,
			statement,
			mode: p.read.probes.every((id) => neutral.has(id)) ? p.read.base : p.read.mode
		}))
	})
}

/** The text that names one group a read reads: its relation, its fields and what they are bound to. */
const groupOf = (r: ReadFact): string =>
	r.group === undefined
		? `${r.relation}()`
		: `${r.relation}(${r.group.fields.join(",")})=${r.group.binding}`

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
 * A referencing check's seal: of the referenced relation, at its referenced key's fields. A point where the relation
 * is insert-only; where no role updates it, held (ReadSeal) where no login both deletes and inserts it, and fenced where
 * one does; unsealed where a role updates it.
 */
const referencingSeal = (
	at: Installation,
	relation: string,
	fields: ReadonlyArray<string>
): ReadSeal => {
	const facts = at.relations.get(relation)
	if (facts === undefined) {
		return { kind: "unsealed", detail: "the installation states no fact of it" }
	}
	if (at.writers.unwritten(relation)) {
		return { kind: "unwritten" }
	}
	if (at.writers.insertOnly(relation)) {
		return keyedSeal("point", facts, fields)
	}
	if (at.writers.updated(relation)) {
		return {
			kind: "unsealed",
			detail: "a role updates the relation, which may move the key a check found"
		}
	}
	return keyedSeal(at.writers.replaced(relation) ? "fenced" : "held", facts, fields)
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
				seal: referencingSeal(at, r.relation, r.fields),
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
	readonly checks: ReadonlyArray<Check>
}

/** A site a role's member reads a relation at, by a statement's read or a foreign key check. */
interface ReadSite {
	readonly member: string
	readonly statement: number
	readonly by: "statement" | "check"
}

/**
 * One role as the conditions read it, built once: its members' views, the relations it writes, those of them its
 * login fences (Writers.fences), those it reads from outside, by a statement or a check, sealed or not, those of them
 * it reads from outside by held or fenced checks alone (lockedSeal), and every relation it reads with the sites it reads
 * it at, but the checks of the rows that reference a row its member deletes where its login fences the deleted
 * relation (fencedSite).
 */
interface RoleView {
	readonly role: RoleFacts
	readonly members: ReadonlyArray<MemberView>
	readonly written: ReadonlySet<string>
	readonly fences: ReadonlySet<string>
	readonly outside: ReadonlySet<string>
	readonly locked: ReadonlySet<string>
	readonly sites: ReadonlyMap<string, ReadonlyArray<ReadSite>>
	readonly cause: string | undefined
}

/** Whether a seal is a held or a fenced check's: of a relation no role updates, whose found row its KEY SHARE lock holds,
 * which a deleting login's fence keeps out of every fenced write's transaction. */
const lockedSeal = (seal: ReadSeal): boolean => seal.kind === "held" || seal.kind === "fenced"

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
	const written = writtenBy(at, served)
	const read = new Set(members.flatMap((v) => v.outsides.map((p) => p.read.relation)))
	const checked = members.flatMap((v) => v.checks.filter((c) => outside(c.seal)))
	const unlocked = new Set(checked.flatMap((c) => (lockedSeal(c.seal) ? [] : [c.relation])))
	return {
		role: served.role,
		members,
		written,
		fences: new Set([...written].filter((r) => at.writers.fences(served.role.login, r))),
		cause: pivotCauseOf(at, members, written),
		outside: new Set([...read, ...checked.map((c) => c.relation)]),
		locked: new Set(
			checked.flatMap((c) =>
				lockedSeal(c.seal) && !read.has(c.relation) && !unlocked.has(c.relation) ? [c.relation] : []
			)
		),
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

/** Every relation the role touches, by a privilege, a write, a check or a read of other than its own call's rows, that
 * the installation states no fact of. */
const factReasons = (at: Installation, view: RoleView): ReadonlyArray<IsolationReason> =>
	[
		...new Set([
			...view.role.privileges.keys(),
			...view.written,
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
	role.members.length === 0
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

/** Condition 2's own half: no law over a relation the role writes is held by a deferred trigger. */
const lawReasons = (
	at: Installation,
	written: ReadonlySet<string>
): ReadonlyArray<IsolationReason> =>
	[...written].flatMap((relation): ReadonlyArray<IsolationReason> => {
		const laws = at.relations.get(relation)?.triggerLaws ?? []
		return laws.length === 0
			? []
			: [reason("laws", { relation }, `laws ${laws.join(", ")} over it are held by triggers`)]
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
	[...view.written].flatMap((relation) =>
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

/**
 * Condition 5b: a member with an outside read and a write reads every outside group sealed and positively, and every
 * row it writes reaches every outside group it reads: joined with each outside read of its statement, and, after a
 * statement that read from outside, with a row its own call wrote; no write comes before a group read only later. Each
 * of its foreign key checks is sealed. One reason per read, check or write that fails.
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
		const unjoined = writes.flatMap(({ statement, w }) => {
			const where = { member: name, statement, relation: w.relation }
			const from = new Set(w.from)
			const joined = new Set(
				v.reads.flatMap((p) =>
					p.statement === statement && from.has(p.index) ? [groupOf(p.read)] : []
				)
			)
			const [missed, ...more] = v.outsides.filter(
				(p) => p.statement === statement && !joined.has(groupOf(p.read))
			)
			const own = v.reads.some(
				(p) =>
					p.statement === statement &&
					p.seal.kind === "own" &&
					p.mode === "positive" &&
					from.has(p.index)
			)
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
	...lawReasons(at, view.written),
	...absenceReasons(view, absent),
	...snapshotReasons(view),
	...pivotReasons(view)
]

/**
 * The reasons the roles that run SERIALIZABLE give a role: condition 2's other half, a change member of one reading a
 * relation the role writes, by a statement or a foreign key check, one per site; and condition 5c, one writing a
 * relation the role's members read from outside, sealed or not, while it may miss another call's write itself
 * (RoleView.cause, pivotCauseOf), one per such relation, but one the role reads from outside by held or fenced checks
 * alone that the writer's login fences. Each of those checks committed before the writer's lock, which its snapshot
 * follows, or took its own snapshot after the writer committed, so none misses a row the writer inserts and none finds
 * a row the writer then deletes, the edges a cycle in real time through the role and the writer needs (NEGATION's case
 * 3 needs one).
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
		const cowriters = [...other.written].flatMap((relation) =>
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
					...[...other.written].flatMap((relation) =>
						view.outside.has(relation) && !(view.locked.has(relation) && other.fences.has(relation))
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
 * One role to certify: its facts (`role`), whose members are its change members compiled for READ COMMITTED; the form
 * it is served while it runs READ COMMITTED (`readCommitted`); and its lowering (`lower`), which certification takes
 * once, in the round that first leaves it SERIALIZABLE.
 */
export interface Candidate<R, S, E> {
	readonly role: RoleFacts
	readonly readCommitted: R
	readonly lower: () => Result.Result<Lowering<S>, E>
}

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

/** A role a round reads: judged, over its READ COMMITTED form, or lowered by a round before it. */
type Standing<R, S, E> =
	| { readonly kind: "judged"; readonly candidate: Candidate<R, S, E> }
	| Lowered<R, S, E>

/**
 * A role after a round: judged READ COMMITTED, judged SERIALIZABLE with the round's reasons, which lowers it, or
 * lowered by a round before it.
 */
type Judgement<R, S, E> =
	| { readonly kind: "readCommitted"; readonly candidate: Candidate<R, S, E> }
	| {
			readonly kind: "serializable"
			readonly candidate: Candidate<R, S, E>
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
			? standing.candidate.role.members
			: [...standing.candidate.role.members, ...standing.lowering.facts]
})

/** One role of a round, read once into its view: judged, with the reasons of its own conditions, or lowered. */
type Viewed<R, S, E> =
	| {
			readonly kind: "judged"
			readonly candidate: Candidate<R, S, E>
			readonly view: RoleView
			readonly own: ReadonlyArray<IsolationReason>
	  }
	| (Lowered<R, S, E> & { readonly view: RoleView })

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
): ReadonlyArray<Judgement<R, S, E>> => {
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
	return roles.map((r): Judgement<R, S, E> => {
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
	})
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
 * A relation a login fences: the login's roles delete it, none updating it, and a role certified READ COMMITTED checks
 * it by a foreign key (ReadSeal held or fenced). Every change member of the login that writes it begins its transaction
 * with LOCK TABLE ... IN EXCLUSIVE MODE on it before any statement takes the snapshot, and the installation grants the
 * login MAINTAIN on it, the least privilege that permits the lock (PostgreSQL 19 lockcmds.c LockTableAclCheck). `for`
 * names the roles certified READ COMMITTED whose checks of it rely on the lock, in the roles' order.
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
 * The fences of the settled roles `settled`, over the installation the round that settled them served: for each
 * relation a role certified READ COMMITTED checks by a held or fenced check (lockedSeal), one fence of each login that
 * deletes it, by login then relation in code-unit order.
 */
const fencesOf = <R, S, E>(
	relations: ReadonlyMap<string, RelationFacts>,
	standings: ReadonlyArray<Standing<R, S, E>>,
	settled: ReadonlyArray<Exclude<Judgement<R, S, E>, { readonly kind: "serializable" }>>
): ReadonlyArray<Fence> => {
	const at = installationOf(relations, standings.map(servedOf))
	const relying = new Map<string, Array<{ readonly login: string; readonly role: string }>>()
	for (const j of settled) {
		if (j.kind !== "readCommitted") {
			continue
		}
		const { login, role } = j.candidate.role
		const checked = new Set(
			j.candidate.role.members.flatMap((m) =>
				checksOf(at, m).flatMap((c) => (lockedSeal(c.seal) ? [c.relation] : []))
			)
		)
		for (const relation of checked) {
			const roles = relying.get(relation) ?? []
			roles.push({ login, role })
			relying.set(relation, roles)
		}
	}
	return [...relying]
		.flatMap(([relation, roles]): ReadonlyArray<Fence> =>
			isNonEmpty(roles)
				? at.writers.fencers(relation).map((fencer) => ({ login: fencer, relation, for: roles }))
				: []
		)
		.toSorted((a, b) => compareText(a.login, b.login) || compareText(a.relation, b.relation))
}

/**
 * Every role's certificate, in rounds over the relations' facts `relations`, the roles `candidates` in their order. The
 * first round judges every role over its READ COMMITTED form; each round lowers the roles it judged SERIALIZABLE (their
 * `lower`), which keep that round's reasons as their certificate's, and the next judges the rest beside every lowering,
 * until a round lowers none. A lowered role is never judged again: it runs SERIALIZABLE from then on, since each round
 * reads every fact the one before it read (servedOf), and its certificate names the reasons that made it SERIALIZABLE,
 * never one its own lowering gave. Every round but the last lowers a role, so there are at most one more rounds than
 * roles. A lowering that fails fails certification. The fences are the last round's (fencesOf).
 */
export const certify = <R, S, E>(
	relations: ReadonlyMap<string, RelationFacts>,
	candidates: ReadonlyArray<Candidate<R, S, E>>
): Result.Result<Certifications<R, S>, E> => {
	let standings = candidates.map((candidate): Standing<R, S, E> => ({ kind: "judged", candidate }))
	for (;;) {
		const judged = round(relations, standings)
		const settled = judged.flatMap((j) => (j.kind === "serializable" ? [] : [j]))
		if (settled.length === judged.length) {
			return Result.ok({
				roles: settled.map(certifiedOf),
				fences: fencesOf(relations, standings, settled)
			})
		}
		const next: Array<Standing<R, S, E>> = []
		for (const j of judged) {
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
