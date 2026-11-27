/**
 * A role's certificate, which analysis/isolation/certify.ts gives each role of each login, the installation holds the
 * level of and generate prints: every term below not defined here is certify.ts's or facts.ts's.
 */
import { flatMapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { ParamId } from "#compiler/core/ids.ts"
import type { Isolation } from "#compiler/core/isolation.ts"

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
 * - `laws`: every law over a relation it writes is native or monotone in its write of it (certify.ts lawReasons): of each witness
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
 *   readCommittedRelations), so a role certified past it would have every write refused. And no role that runs
 *   SERIALIZABLE keeps a stored relation the role keeps (facts.ts RelationFacts `upkept`): the judge of each borrows
 *   the units it keeps before its upkeep reads them (physical/ddl/rules.ts judgeBorrow), which orders the two, but a
 *   SERIALIZABLE upkeep reads at its transaction's snapshot, which no lock moves past a READ COMMITTED writer's commit,
 *   and SSI never sees a READ COMMITTED write, so it would keep the unit as though that writer's rows were not there.
 *
 * A role is served the form its level chooses, so certification runs in rounds (analysis/isolation/certify.ts certify): a role is judged over its
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

/**
 * The conditions a role fails by itself, whatever level any other role runs at (certify.ts ownReasons, formReasons): every one but
 * `writers`, which only a role that runs SERIALIZABLE fails another by.
 */
export type OwnCondition = Exclude<IsolationCondition, "writers">

/**
 * The conditions a role that runs SERIALIZABLE fails another by (certify.ts givenReasons): `laws`, its second half, a change
 * member of it reading a relation the other writes; and `writers`.
 */
export type GivenCondition = Extract<IsolationCondition, "laws" | "writers">

/**
 * Where a role fails a condition: the role as a whole; a relation it touches; a change member's write of a relation,
 * which has no READ COMMITTED form; or a statement in a member's flight, by its place there, and the relation it reads
 * or writes.
 */
export type ReasonAt =
	| { readonly kind: "role" }
	| { readonly kind: "relation"; readonly relation: string }
	| { readonly kind: "member"; readonly member: string; readonly relation: string }
	| {
			readonly kind: "statement"
			readonly member: string
			readonly statement: number
			readonly relation: string
	  }

/** One condition a role fails, where (ReasonAt), and why. */
export interface IsolationReason<C extends IsolationCondition = IsolationCondition> {
	readonly condition: C
	readonly at: ReasonAt
	readonly detail: string
}

/**
 * A role that runs SERIALIZABLE and gives another a reason to (certify.ts givenReasons): its login's and its own name, and
 * every reason it gives, each once, a statement's place one of its own members'.
 */
export interface Giver {
	readonly login: string
	readonly role: string
	readonly reasons: NonEmptyReadonlyArray<IsolationReason<GivenCondition>>
}

/**
 * Why a role runs SERIALIZABLE, as the round that lowered it found: `own`, the conditions it fails itself, which hold
 * whatever level any other role runs at; or `given`, where it fails none of its own, each role that runs SERIALIZABLE
 * and gives it a reason, in the roles' order. A role with reasons of its own is told none it is given: it runs
 * SERIALIZABLE until its own are gone, whatever the other roles' levels. A role given reasons alone runs READ COMMITTED
 * once no role that runs SERIALIZABLE gives it one, by running READ COMMITTED itself or by giving none.
 */
export type Serializable =
	| { readonly kind: "own"; readonly reasons: NonEmptyReadonlyArray<IsolationReason<OwnCondition>> }
	| { readonly kind: "given"; readonly by: NonEmptyReadonlyArray<Giver> }

/** Every reason a role runs SERIALIZABLE by: its own, or each one each giver gives it, giver by giver. */
export const reasonsOf = (why: Serializable): NonEmptyReadonlyArray<IsolationReason> =>
	why.kind === "own" ? why.reasons : flatMapNonEmpty(why.by, (g) => g.reasons)

/**
 * A role's level: READ COMMITTED only with every condition proved, otherwise SERIALIZABLE with why, the reasons of the
 * round that lowered it (certify.ts certify).
 */
export type RoleCertificate =
	| { readonly level: Extract<Isolation, "readCommitted"> }
	| {
			readonly level: Extract<Isolation, "serializable">
			readonly why: Serializable
	  }

/** One role of one login with its certificate. */
export interface RoleIsolation {
	readonly login: string
	readonly role: string
	readonly certificate: RoleCertificate
}

/**
 * What a borrow locks: a declared unit (`unit`), by its name, at the keys its sites name; or the declared series lock
 * (`series`) of a relation, one lock for the whole relation, which takes no key.
 */
export type BorrowLock =
	| { readonly kind: "unit"; readonly unit: string }
	| { readonly kind: "series"; readonly relation: string }

/**
 * How a call borrows a lock: `shared` (&), reading the unit's rows while no other call writes them; or `exclusive`
 * (&mut), writing them while no other call reads or writes them. A call borrows each lock once, at the strongest mode
 * any of its sites needs: no borrow is ever upgraded.
 */
export type BorrowMode = "shared" | "exclusive"

/**
 * Where a call takes a borrow: `flight`, in one statement of its last flight before any statement that reads or writes
 * the unit's rows takes its snapshot; or `judge`, at COMMIT, before the deferred judge reads the rows the borrow holds.
 * A lock a call borrows in flight is never borrowed again at the judge.
 */
export type BorrowAt = "flight" | "judge"

/**
 * One field of a unit key as a call holds it before its first snapshot, by a binding alone: a declared scalar
 * parameter, by its name; a field of a context the session's claims hold, by the context's name and the field's; a
 * field of the call's own rows (`input`), a relation parameter's or a member slot's, by its ParamId (a relation
 * parameter's its name, a member slot's its reserved slot id, ir/slots.ts reservedSlot, one space, inReservedSpace
 * telling them apart) and a field of its heading by name, one key per distinct value among its rows.
 */
export type KeySource =
	| { readonly kind: "param"; readonly name: string }
	| { readonly kind: "context"; readonly context: string; readonly field: string }
	| { readonly kind: "input"; readonly parameter: ParamId; readonly field: string }

/** One field of a key with the binding the call holds it by: the field by its name, and its source (KeySource). */
export interface KeyField {
	readonly field: string
	readonly source: KeySource
}

/**
 * A place a call holds whole keys of a borrowed unit, each lowered from bindings alone, never from a statement of the
 * member's:
 *
 * - `bound`: each of the unit's key fields, in key order, with its binding (KeyField), the keys of the rows the call
 *   writes or reads at bound values;
 * - `learned`: a point lookup of `relation` at a whole declared key of it, each of that key's fields in its order with
 *   the binding it is looked up at (`key`), each unit key field the lookup's column at its place in `columns`: the
 *   certifier admits one only over
 *   an immutable fact (an insert-only relation outside every unit) or a relation no role writes, so the lookup and the
 *   member's own read of it see one row;
 * - `held`: the same lookup over a relation every writer of which borrows `under` exclusively, the call holding `under`
 *   at a key the lookup's key covers: the lookup reads a row no other call changes while the call holds it, after the
 *   call's own borrow of `under` (LockOrder ranks `under` before the lock this site keys);
 * - `delta`: at the judge alone, the unit key fields of the rows the call wrote to `relation`.
 */
export type KeySite =
	| { readonly kind: "bound"; readonly fields: NonEmptyReadonlyArray<KeyField> }
	| {
			readonly kind: "learned"
			readonly relation: string
			readonly key: NonEmptyReadonlyArray<KeyField>
			readonly columns: NonEmptyReadonlyArray<string>
	  }
	| {
			readonly kind: "held"
			readonly relation: string
			readonly key: NonEmptyReadonlyArray<KeyField>
			readonly columns: NonEmptyReadonlyArray<string>
			readonly under: BorrowLock
	  }
	| { readonly kind: "delta"; readonly relation: string }

/**
 * One borrow of one compiled write of a change member (its variant), as the certifier proves the write needs it and the
 * lock plan places it, or of the judge, which borrows at COMMIT each unit a stored relation is kept under at the keys
 * its transaction wrote (physical/ddl/rules.ts judgeBorrows): what it locks, how, where, and every site whose keys it
 * locks (none for the series lock). The borrows of a compiled write are complete: its lowering takes no lock of its
 * own.
 */
export interface Borrow {
	readonly lock: BorrowLock
	readonly mode: BorrowMode
	readonly at: BorrowAt
	readonly keys: ReadonlyArray<KeySite>
}

/**
 * Every lock kind of an installation in the one order every call takes them in, each kind's rank its place here: a
 * topological order of the edges from each lock a call borrows in flight to each it borrows at the judge, and from each
 * `held` site's `under` to the lock it keys (KeySite), over every change member of every login, ties broken by name. The certifier refuses an installation whose edges cycle, so the
 * order exists; the lock plan reads a kind's rank and orders by nothing else.
 */
export type LockOrder = ReadonlyArray<BorrowLock>
