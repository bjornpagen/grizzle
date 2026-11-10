import type {
	IsolationInput,
	MemberFacts,
	ReadFact,
	RelationFacts,
	RoleFacts
} from "#compiler/analysis/isolation/facts.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"

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
 *   such a relation, by a statement or a foreign key check;
 * - `absence`: no change member of any role reads the absence or a count of a relation it writes, by a statement or by
 *   the check of a foreign key that references a row the member updates or deletes;
 * - `snapshot`: in each of its members, an outside read that is no sealed group (ReadSeal) shares its statement with
 *   every other outside read, and no outside foreign key check, which reads at a later snapshot, stands beside it; an
 *   unsealed check stands beside no other outside read;
 * - `pivot`: a member with an outside read and a write is a pivot, each write of which another call may read. Each of
 *   its outside reads is a sealed group read positively, and each row it writes reaches every one of them: joined
 *   with each outside read of its own statement, and, after a statement that read from outside, with a row its own
 *   call wrote; no write comes before a group the member reads only later. A group it misses makes it write nothing;
 *   a group it reads again is the same rows or none, since a sealed group is immutable and never extended. Each of its
 *   foreign key checks is sealed: a sealed check finds its row, immutable, or refuses the call whole;
 * - `writers`: no role that runs SERIALIZABLE and writes a relation the role reads from outside, by a statement or a
 *   foreign key check, has an outside read of its own or a law over a relation it writes held by triggers, so none is
 *   the pivot of a cycle through it. A sealed read is no exemption: a reader of one writer call's rows can miss an
 *   in-flight SERIALIZABLE writer whose read's writer committed before the reader began, which no serial order in real
 *   time explains. No role that runs SERIALIZABLE writes a relation the role writes, by a privilege, a member or a
 *   cascade: the installation's guard admits a READ COMMITTED write of a relation only where every role that writes it
 *   runs READ COMMITTED, and refuses any other with 25000 (physical/ddl/isolation.ts readCommittedRelations), so a role
 *   certified past it would have every write refused.
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

/** A role's level: READ COMMITTED only with every condition proved, otherwise SERIALIZABLE with every reason. */
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
const cascaded = (input: IsolationInput, updated: ReadonlySet<string>): ReadonlySet<string> => {
	const out = new Set(updated)
	let grew = true
	while (grew) {
		grew = false
		for (const [relation, facts] of input.relations) {
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

/** The relations a role updates: those it holds UPDATE on and those its members' statements update. */
const updatedBy = (role: RoleFacts): ReadonlySet<string> =>
	new Set([
		...[...role.privileges].flatMap(([relation, privileges]) =>
			privileges.has("UPDATE") ? [relation] : []
		),
		...role.members.flatMap((m) =>
			m.statements.flatMap((s) => s.writes.flatMap((w) => (w.op === "update" ? [w.relation] : [])))
		)
	])

/** What the installation's roles state of each relation, read once: whether any role writes it, and whether any
 * updates or deletes it, an update carried by a cascading foreign key among them. */
class Writers {
	readonly #written = new Set<string>()
	readonly #changed = new Set<string>()

	constructor(input: IsolationInput) {
		for (const role of input.roles) {
			for (const [relation, privileges] of role.privileges) {
				for (const p of privileges) {
					if (writing.has(p)) {
						this.#written.add(relation)
					}
					if (p === "UPDATE" || p === "DELETE") {
						this.#changed.add(relation)
					}
				}
			}
			for (const member of role.members) {
				for (const s of member.statements) {
					for (const w of s.writes) {
						this.#written.add(w.relation)
						if (w.op !== "insert") {
							this.#changed.add(w.relation)
						}
					}
				}
			}
			for (const relation of cascaded(input, updatedBy(role))) {
				this.#written.add(relation)
				this.#changed.add(relation)
			}
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
}

/** What the certifier reads of every role at once, and every relation the installation names: those it states a fact
 * of, and those a role holds a privilege on, reads or writes. */
interface Installation {
	readonly input: IsolationInput
	readonly writers: Writers
	readonly named: ReadonlySet<string>
}

const installationOf = (input: IsolationInput): Installation => ({
	input,
	writers: new Writers(input),
	named: new Set([
		...input.relations.keys(),
		...input.roles.flatMap((role) => [
			...role.privileges.keys(),
			...role.members.flatMap((m) =>
				m.statements.flatMap((s) => [
					...s.writes.map((w) => w.relation),
					...s.reads.flatMap((r) => (r.own ? [] : [r.relation]))
				])
			)
		])
	])
})

/** What `read` is among the installation's roles (ReadSeal). */
export const readSeal = (input: IsolationInput, read: ReadFact): ReadSeal =>
	sealOf(installationOf(input), read)

const sealOf = (at: Installation, read: ReadFact): ReadSeal => {
	if (read.own) {
		return { kind: "own" }
	}
	const facts = at.input.relations.get(read.relation)
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
	return pointSeal(facts, group.fields)
}

/** A read by `fields` of an insert-only relation: a point read where they hold a whole declared key, else unsealed. */
const pointSeal = (facts: RelationFacts, fields: ReadonlyArray<string>): ReadSeal => {
	const point = facts.keys.find((k) => k.every((f) => fields.includes(f)))
	return point === undefined
		? {
				kind: "unsealed",
				detail: `its group by ${fields.join(", ")} is neither a family's counted members nor a whole declared key`
			}
		: { kind: "point", key: point }
}

/** An arbitration's seal: the declared key its group binds whole, which the unique check decides, or unsealed. */
const arbiterSeal = (facts: RelationFacts, group: ReadonlyArray<string> | undefined): ReadSeal => {
	const key =
		group === undefined ? undefined : facts.keys.find((k) => k.every((f) => group.includes(f)))
	return key === undefined
		? {
				kind: "unsealed",
				detail: "it arbitrates no whole declared key, which no unique check decides"
			}
		: { kind: "arbiter", key }
}

/** Whether a read's seal makes it an outside read: of rows another call can write. */
const outside = (seal: ReadSeal): boolean =>
	seal.kind !== "arbiter" && seal.kind !== "own" && seal.kind !== "unwritten"

/** One read of a member, at its statement's place in the member's flight and its own in the statement's reads. */
interface PlacedRead {
	readonly statement: number
	readonly index: number
	readonly read: ReadFact
	readonly seal: ReadSeal
}

/** Every read of a member, each placed and sealed. */
const readsOf = (at: Installation, member: MemberFacts): ReadonlyArray<PlacedRead> =>
	member.statements.flatMap((s, statement) =>
		s.reads.map((read, index) => ({ statement, index, read, seal: sealOf(at, read) }))
	)

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
}

/** A referencing check's seal: of the referenced relation, at its referenced key's fields. */
const referencingSeal = (
	at: Installation,
	relation: string,
	fields: ReadonlyArray<string>
): ReadSeal => {
	const facts = at.input.relations.get(relation)
	if (facts === undefined) {
		return { kind: "unsealed", detail: "the installation states no fact of it" }
	}
	if (at.writers.unwritten(relation)) {
		return { kind: "unwritten" }
	}
	return at.writers.insertOnly(relation)
		? pointSeal(facts, fields)
		: { kind: "unsealed", detail: "a role updates or deletes the relation" }
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
	const facts = at.input.relations.get(relation)
	return facts === undefined
		? [...at.named].map((r) => ({
				statement,
				relation: r,
				side: "referencing",
				seal: unknownSeal(at, r)
			}))
		: facts.references.map((r) => ({
				statement,
				relation: r.relation,
				side: "referencing",
				seal: referencingSeal(at, r.relation, r.fields)
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
		const facts = at.input.relations.get(r)
		if (facts === undefined) {
			return [{ statement, relation: r, side: "referenced", seal: unknownSeal(at, r) }]
		}
		return facts.references.some((ref) => ref.relation === relation)
			? [{ statement, relation: r, side: "referenced", seal: referencedSeal(at, r) }]
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

/** The relations a role writes: those it holds a writer's privilege on, those its members' statements write, and those
 * its updates cascade to. */
const writtenBy = (at: Installation, role: RoleFacts): ReadonlySet<string> => {
	const out = new Set<string>(cascaded(at.input, updatedBy(role)))
	for (const [relation, privileges] of role.privileges) {
		if ([...privileges].some((p) => writing.has(p))) {
			out.add(relation)
		}
	}
	for (const member of role.members) {
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
 * One role as the conditions read it, built once: its members' views, the relations it writes, those it reads from
 * outside, by a statement or a check, sealed or not, and every relation it reads with the sites it reads it at.
 */
interface RoleView {
	readonly role: RoleFacts
	readonly members: ReadonlyArray<MemberView>
	readonly written: ReadonlySet<string>
	readonly outside: ReadonlySet<string>
	readonly sites: ReadonlyMap<string, ReadonlyArray<ReadSite>>
}

const memberView = (at: Installation, member: MemberFacts): MemberView => {
	const reads = readsOf(at, member)
	return {
		member,
		reads,
		outsides: reads.filter((p) => outside(p.seal)),
		checks: checksOf(at, member)
	}
}

const roleView = (at: Installation, role: RoleFacts): RoleView => {
	const members = role.members.map((m) => memberView(at, m))
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
			site(c.relation, { member: v.member.name, statement: c.statement, by: "check" })
		}
	}
	return {
		role,
		members,
		written: writtenBy(at, role),
		outside: new Set(
			members.flatMap((v) => [
				...v.outsides.map((p) => p.read.relation),
				...v.checks.flatMap((c) => (outside(c.seal) ? [c.relation] : []))
			])
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
		at.input.relations.has(relation)
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
		const laws = at.input.relations.get(relation)?.triggerLaws ?? []
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
 * member updates or deletes.
 */
const absenceSites = (
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
				if (p.read.mode === "negated" || p.read.mode === "counted") {
					add(p.read.relation, { ...at, statement: p.statement, how: `reads it ${p.read.mode}` })
				} else if (p.read.mode === "arbiter" && p.seal.kind === "unsealed") {
					add(p.read.relation, {
						...at,
						statement: p.statement,
						how: "reads it as an arbitration of no whole declared key"
					})
				}
			}
			for (const c of v.checks) {
				if (c.side === "referenced") {
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
			return p.read.mode === "positive"
				? []
				: [reason("pivot", where, `it reads the group ${p.read.mode}`)]
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
			const [missed, ...more] = v.outsides.filter(
				(p) => p.statement === statement && !from.has(p.index)
			)
			const own = v.reads.some(
				(p) =>
					p.statement === statement &&
					p.seal.kind === "own" &&
					p.read.mode === "positive" &&
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

/** Why a role that runs SERIALIZABLE may be the pivot of a cycle: a relation it reads from outside, or a trigger-held
 * law over one it writes; none where it is neither. */
const pivotCause = (at: Installation, view: RoleView): string | undefined => {
	const [read] = view.outside
	if (read !== undefined) {
		return `it reads ${read} from outside at SERIALIZABLE`
	}
	const [held] = [...view.written].filter(
		(relation) => (at.input.relations.get(relation)?.triggerLaws ?? []).length > 0
	)
	return held === undefined ? undefined : `a law over ${held}, which it writes, is held by triggers`
}

/**
 * The reasons the roles that run SERIALIZABLE give a role: condition 2's other half, a change member of one reading a
 * relation the role writes, by a statement or a foreign key check, one per site; and condition 5c, one writing a
 * relation the role's members read from outside, sealed or not, while it reads from outside itself or writes a relation
 * a trigger-held law reads, one per such relation.
 */
const serializableReasons = (
	at: Installation,
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
		const pivot = pivotCause(at, other)
		return pivot === undefined
			? [...readers, ...cowriters]
			: [
					...readers,
					...cowriters,
					...[...other.written].flatMap((relation) =>
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
 * Each role's certificate: READ COMMITTED exactly when its change members meet every condition, the roles that run
 * SERIALIZABLE judged against the final verdicts. The roles that meet every condition of their own start READ
 * COMMITTED; a role a SERIALIZABLE role gives a reason runs SERIALIZABLE, which may give another one, until none
 * changes. Each step only removes roles, so the set it ends at is the greatest one every member of which meets every
 * condition against it. A role that runs SERIALIZABLE by others alone names every reason each other role that runs
 * SERIALIZABLE at the end gives it, never one of its own making. Each role and member is read once into its view, and a
 * reason names one site, never a pair of them. Roles keep the input's order.
 */
export const certify = (input: IsolationInput): ReadonlyArray<RoleIsolation> => {
	const at = installationOf(input)
	const views = input.roles.map((role) => roleView(at, role))
	const absent = absenceSites(views)
	const own = new Map<RoleView, ReadonlyArray<IsolationReason>>(
		views.map((view) => [view, ownReasons(at, view, absent)] as const)
	)
	const serializable = new Set(views.filter((view) => (own.get(view) ?? []).length > 0))
	let changed = true
	while (changed) {
		changed = false
		const judges = [...serializable]
		for (const view of views) {
			if (!serializable.has(view) && serializableReasons(at, view, judges).length > 0) {
				serializable.add(view)
				changed = true
			}
		}
	}
	return views.map((view): RoleIsolation => {
		const mine = own.get(view) ?? []
		const failed =
			mine.length > 0 || !serializable.has(view)
				? mine
				: serializableReasons(
						at,
						view,
						[...serializable].filter((other) => other !== view)
					)
		return {
			login: view.role.login,
			role: view.role.role,
			certificate: isNonEmpty(failed)
				? { level: "serializable", reasons: failed }
				: { level: "readCommitted" }
		}
	})
}
