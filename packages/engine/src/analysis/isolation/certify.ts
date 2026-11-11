import type {
	IsolationInput,
	MemberFacts,
	ProbeFact,
	ReadFact,
	RelationFacts,
	RoleFacts,
	RowSource,
	StatementFacts
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
 *   with each group its own statement reads from outside, and, after a statement that read from outside, with a row its own
 *   call wrote; no write comes before a group the member reads only later. A group it misses makes it write nothing;
 *   a group it reads again is the same rows or none, since a sealed group is immutable and never extended. Each of its
 *   foreign key checks is sealed: a sealed check finds its row, immutable, or refuses the call whole;
 * - `writers`: no role that runs SERIALIZABLE and writes a relation the role reads from outside, by a statement or a
 *   foreign key check, can miss another call's write (pivotCauseOf), so none is the pivot of a cycle through it: no
 *   statement of it reads from outside, none of its foreign key checks is unsealed or reads the rows that reference a
 *   row it changes, and it writes no relation a trigger-held law reads. A sealed check of its own, of an insert-only
 *   relation at a whole declared key or of one no role writes, finds an immutable row or refuses its call, which at
 *   SERIALIZABLE then commits nothing, so it misses no write. The role's own checks are no such exemption: they are
 *   outside reads 5c weighs against every role that runs SERIALIZABLE (the publication shape in
 *   test/unit/analysis/isolation/certify.test.ts). A sealed read is no exemption: a reader of one writer call's rows can miss an
 *   in-flight SERIALIZABLE writer whose read's writer committed before the reader began, which no serial order in real
 *   time explains. No role that runs SERIALIZABLE writes a relation the role writes, by a privilege, a member or a
 *   cascade: the installation's guard admits a READ COMMITTED write of a relation only where every role that writes it
 *   runs READ COMMITTED, and refuses any other with 25000 (physical/ddl/isolation.ts readCommittedRelations), so a role
 *   certified past it would have every write refused.
 *
 * A role is served the form its level chooses (program/isolation/certification.ts): its own conditions read the change
 * members it is served at READ COMMITTED, and whatever another role's members read or write, conditions 2, 3 and 5c
 * included, is read from every member that role may be served, its SERIALIZABLE form's beside them (RoleFacts).
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
 * - `arbitrated`: a point read of an insert-only relation at exactly the group the call's own earlier statement
 *   arbitrated in it, by its parameters: once that statement inserted the row or met it as an exact repeat, DO SELECT
 *   waiting for its writer's commit, the row at the key is the call's own or committed and never changes, so the read
 *   sees exactly it and misses no write;
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

/** Every change member's facts a role may be served, in the form of either level (RoleFacts). */
const servedMembers = (role: RoleFacts): ReadonlyArray<MemberFacts> => [
	...role.members,
	...role.serializable
]

/** The relations a role updates: those it holds UPDATE on and those its members' statements update, in either form. */
const updatedBy = (role: RoleFacts): ReadonlySet<string> =>
	new Set([
		...[...role.privileges].flatMap(([relation, privileges]) =>
			privileges.has("UPDATE") ? [relation] : []
		),
		...servedMembers(role).flatMap((m) =>
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
			for (const member of servedMembers(role)) {
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
			...servedMembers(role).flatMap((m) =>
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

/** The relations a role writes: those it holds a writer's privilege on, those its members' statements write in either
 * form, and those its updates cascade to. */
const writtenBy = (at: Installation, role: RoleFacts): ReadonlySet<string> => {
	const out = new Set<string>(cascaded(at.input, updatedBy(role)))
	for (const [relation, privileges] of role.privileges) {
		if ([...privileges].some((p) => writing.has(p))) {
			out.add(relation)
		}
	}
	for (const member of servedMembers(role)) {
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
	readonly cause: string | undefined
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

/**
 * Why a role, were it SERIALIZABLE, may be the pivot of a cycle, by a read that can miss another call's write: an outside
 * read of a statement; a foreign key check that is unsealed, or that reads the rows referencing a row it changes; or a
 * law over a relation it writes held by triggers. None where it has no such read: each of its checks, sealed, finds an
 * immutable row or refuses its call whole.
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
		(relation) => (at.input.relations.get(relation)?.triggerLaws ?? []).length > 0
	)
	return held === undefined ? undefined : `a law over ${held}, which it writes, is held by triggers`
}

/** A role's view over `members`, its own members' views or every member it may be served (RoleFacts). */
const roleView = (
	at: Installation,
	role: RoleFacts,
	members: ReadonlyArray<MemberView>
): RoleView => {
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
	const written = writtenBy(at, role)
	return {
		role,
		members,
		written,
		cause: pivotCauseOf(at, members, written),
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
 * (RoleView.cause, pivotCauseOf), one per such relation.
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
 * One role twice: as its own conditions read it, over the members it is served at READ COMMITTED, and as it judges
 * others, over every member it may be served (RoleFacts).
 */
interface Judged {
	readonly own: RoleView
	readonly judge: RoleView
}

/**
 * Each role's certificate: READ COMMITTED exactly when its change members meet every condition, the roles that run
 * SERIALIZABLE judged against the final verdicts. The roles that meet every condition of their own start READ
 * COMMITTED; a role a SERIALIZABLE role gives a reason runs SERIALIZABLE, which may give another one, until none
 * changes. Each step only removes roles, so the set it ends at is the greatest one every member of which meets every
 * condition against it. A role that runs SERIALIZABLE by others alone names every reason each other role that runs
 * SERIALIZABLE at the end gives it, never one of its own making. A role's own conditions read the members it is served
 * at READ COMMITTED, and the reasons it gives others, the absence sites among them, every member it may be served
 * (Judged), so a role certification lowered to its SERIALIZABLE form judges others by that form's reads too. Each role
 * and member is read once into its view, and a reason names one site, never a pair of them. Roles keep the input's
 * order.
 */
export const certify = (input: IsolationInput): ReadonlyArray<RoleIsolation> => {
	const at = installationOf(input)
	const roles = input.roles.map((role): Judged => {
		const members = role.members.map((m) => memberView(at, m))
		return {
			own: roleView(at, role, members),
			judge: roleView(at, role, [...members, ...role.serializable.map((m) => memberView(at, m))])
		}
	})
	const absent = absenceSites(roles.map((r) => r.judge))
	const own = new Map<Judged, ReadonlyArray<IsolationReason>>(
		roles.map((r) => [r, ownReasons(at, r.own, absent)] as const)
	)
	const serializable = new Set(roles.filter((r) => (own.get(r) ?? []).length > 0))
	let changed = true
	while (changed) {
		changed = false
		const judges = [...serializable].map((r) => r.judge)
		for (const r of roles) {
			if (!serializable.has(r) && serializableReasons(r.own, judges).length > 0) {
				serializable.add(r)
				changed = true
			}
		}
	}
	return roles.map((r): RoleIsolation => {
		const mine = own.get(r) ?? []
		const failed =
			mine.length > 0 || !serializable.has(r)
				? mine
				: serializableReasons(
						r.own,
						[...serializable].flatMap((other) => (other === r ? [] : [other.judge]))
					)
		return {
			login: r.own.role.login,
			role: r.own.role.role,
			certificate: isNonEmpty(failed)
				? { level: "serializable", reasons: failed }
				: { level: "readCommitted" }
		}
	})
}
