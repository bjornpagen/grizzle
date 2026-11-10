import type {
	IsolationInput,
	MemberFacts,
	Privilege,
	ReadFact,
	RoleFacts
} from "#compiler/analysis/isolation/facts.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { isNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"

/**
 * The conditions a role's change members must all meet to run READ COMMITTED, in the owner's order:
 *
 * - `privileges`: the role holds only INSERT and SELECT;
 * - `laws`: every law over a relation it writes is native, and nothing that relies on SERIALIZABLE reads such a
 *   relation, neither a rule over a query's trigger nor a change member of a role that runs SERIALIZABLE;
 * - `absence`: no change member of any role reads the absence or a count of a relation it writes;
 * - `statements`: in each of its members, every statement after the first reads only rows the call wrote or rows of
 *   an insert-only relation;
 * - `sealed`: every read of its members of rows the call did not write is of a relation no role writes, or of one
 *   sealed group (ReadSeal), and a read the written rows are derived from finds them, so a group that is not there
 *   writes nothing.
 */
export type IsolationCondition = "privileges" | "laws" | "absence" | "statements" | "sealed"

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
 * What makes a read of a change member safe at READ COMMITTED, or why nothing does:
 *
 * - `arbiter`: it is grizzle's own key arbitration of a relation the statement writes, which PostgreSQL's unique check
 *   decides;
 * - `own`: it reads only rows the call itself wrote;
 * - `unwritten`: no role writes the relation, so every snapshot holds the same rows of it;
 * - `fresh`: it reads one group of an insert-only relation by a key every insert into the relation makes fresh to its
 *   call (a pg.uuidv7 drawn field, or a copy of one the call drew), so the group is one call's output;
 * - `counted`: it reads one group of an insert-only relation that is a family's members under an immutable owner
 *   holding their count, a set the count law fixes;
 * - `unsealed`: none of these, with why.
 */
export type ReadSeal =
	| { readonly kind: "arbiter" }
	| { readonly kind: "own" }
	| { readonly kind: "unwritten" }
	| { readonly kind: "fresh"; readonly key: ReadonlyArray<string> }
	| { readonly kind: "counted"; readonly key: ReadonlyArray<string> }
	| { readonly kind: "unsealed"; readonly detail: string }

/** The privileges a writer holds; a role holding none of them on a relation only reads it. */
const writing: ReadonlySet<Privilege> = new Set(["INSERT", "UPDATE", "DELETE"])

/** The privileges a READ COMMITTED role may hold. */
const insertAndSelect: ReadonlySet<Privilege> = new Set(["SELECT", "INSERT"])

/** Every statement of a role's members, each with its member and its place in the member's flight. */
interface Placed {
	readonly member: MemberFacts
	readonly index: number
	readonly reads: ReadonlyArray<ReadFact>
}

const placedOf = (role: RoleFacts): ReadonlyArray<Placed> =>
	role.members.flatMap((member) =>
		member.statements.map((s, index) => ({ member, index, reads: s.reads }))
	)

/** The relations a role writes: those it holds a writer's privilege on and those its members' statements write. */
const writtenBy = (role: RoleFacts): ReadonlySet<string> => {
	const out = new Set<string>()
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

/** Whether two keys name the same fields. */
const sameKey = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	a.length === b.length && a.every((f) => b.includes(f))

/**
 * What the installation's roles state of each relation, read once: whether any role writes it, whether any updates or
 * deletes it, and, of each key, whether every insert into it makes that key fresh.
 */
class Writers {
	readonly #written = new Set<string>()
	readonly #changed = new Set<string>()
	readonly #inserts = new Map<string, Array<ReadonlyArray<ReadonlyArray<string>>>>()

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
						if (w.op === "insert") {
							const fresh = this.#inserts.get(w.relation) ?? []
							fresh.push(w.fresh)
							this.#inserts.set(w.relation, fresh)
						} else {
							this.#changed.add(w.relation)
						}
					}
				}
			}
		}
	}

	/** Whether no role writes the relation: every snapshot holds the same rows of it. */
	unwritten(relation: string): boolean {
		return !this.#written.has(relation)
	}

	/** Whether no role updates or deletes the relation: a row of it, once committed, stays as it is. */
	insertOnly(relation: string): boolean {
		return !this.#changed.has(relation)
	}

	/** Whether every insert into the relation makes `key` fresh to its call. */
	freshAlways(relation: string, key: ReadonlyArray<string>): boolean {
		return (this.#inserts.get(relation) ?? []).every((fresh) => fresh.some((k) => sameKey(k, key)))
	}
}

/** What makes `read` safe at READ COMMITTED among the installation's roles (ReadSeal). */
export const readSeal = (input: IsolationInput, read: ReadFact): ReadSeal =>
	sealOf({ input, writers: new Writers(input) }, read)

const sealOf = (at: Installation, read: ReadFact): ReadSeal => {
	if (read.mode === "arbiter") {
		return { kind: "arbiter" }
	}
	if (read.own) {
		return { kind: "own" }
	}
	if (at.writers.unwritten(read.relation)) {
		return { kind: "unwritten" }
	}
	const group = read.group
	if (group === undefined) {
		return { kind: "unsealed", detail: "it reads rows of no one group" }
	}
	if (!at.writers.insertOnly(read.relation)) {
		return { kind: "unsealed", detail: "a role updates or deletes the relation" }
	}
	if (at.writers.freshAlways(read.relation, group)) {
		return { kind: "fresh", key: group }
	}
	const counted = at.input.relations.get(read.relation)?.countedGroups ?? []
	return counted.some((k) => sameKey(k, group))
		? { kind: "counted", key: group }
		: {
				kind: "unsealed",
				detail: `its group by ${group.join(", ")} is neither made fresh by every insert nor a family's counted members`
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

/** What the certifier reads of every role at once. */
interface Installation {
	readonly input: IsolationInput
	readonly writers: Writers
}

/** Condition 1: every privilege the role holds is INSERT or SELECT. */
const privilegeReasons = (role: RoleFacts): ReadonlyArray<IsolationReason> =>
	[...role.privileges].flatMap(([relation, privileges]) =>
		[...privileges].flatMap((p) =>
			insertAndSelect.has(p) ? [] : [reason("privileges", { relation }, `holds ${p}`)]
		)
	)

/** Condition 2's own half: every law over a relation the role writes is native, and no rule over a query reads it. */
const lawReasons = (
	at: Installation,
	written: ReadonlySet<string>
): ReadonlyArray<IsolationReason> =>
	[...written].flatMap((relation): ReadonlyArray<IsolationReason> => {
		const facts = at.input.relations.get(relation)
		if (facts === undefined) {
			return [reason("laws", { relation }, "the installation states no facts of it")]
		}
		return [
			...(facts.nativeLaws ? [] : [reason("laws", { relation }, "a law over it is not native")]),
			...(facts.ruleRead ? [reason("laws", { relation }, "a rule over a query reads it")] : [])
		]
	})

/** Condition 3: no change member of any role reads the absence or a count of a relation the role writes. */
const absenceReasons = (
	at: Installation,
	written: ReadonlySet<string>
): ReadonlyArray<IsolationReason> =>
	at.input.roles.flatMap((other) =>
		placedOf(other).flatMap((p) =>
			p.reads.flatMap((r) =>
				(r.mode === "negated" || r.mode === "counted") && written.has(r.relation)
					? [
							reason(
								"absence",
								{ member: p.member.name, statement: p.index, relation: r.relation },
								`${other.role} of ${other.login} reads it ${r.mode}`
							)
						]
					: []
			)
		)
	)

/** Condition 4: a statement after the first reads only rows the call wrote or rows of an insert-only relation. */
const statementReasons = (at: Installation, role: RoleFacts): ReadonlyArray<IsolationReason> =>
	placedOf(role).flatMap((p) =>
		p.index === 0
			? []
			: p.reads.flatMap((r) =>
					r.mode === "arbiter" || r.own || at.writers.insertOnly(r.relation)
						? []
						: [
								reason(
									"statements",
									{ member: p.member.name, statement: p.index, relation: r.relation },
									"a later statement reads rows another call may update or delete"
								)
							]
				)
	)

/**
 * Condition 5: a read of rows the call did not write reads a relation no role writes, or one sealed group, and a read
 * the written rows are derived from finds them.
 */
const sealedReasons = (at: Installation, role: RoleFacts): ReadonlyArray<IsolationReason> =>
	placedOf(role).flatMap((p) =>
		p.reads.flatMap((r) =>
			sealReasons(sealOf(at, r), r, {
				member: p.member.name,
				statement: p.index,
				relation: r.relation
			})
		)
	)

/** What a read's seal leaves of condition 5: nothing for a safe read, else why it is not. */
const sealReasons = (
	seal: ReadSeal,
	read: ReadFact,
	where: { readonly member: string; readonly statement: number; readonly relation: string }
): ReadonlyArray<IsolationReason> => {
	switch (seal.kind) {
		case "arbiter":
		case "own":
		case "unwritten":
			return []
		case "unsealed":
			return [reason("sealed", where, seal.detail)]
		case "fresh":
		case "counted":
			return read.feeds === "write" && read.mode !== "positive"
				? [reason("sealed", where, `the rows it writes depend on the group ${read.mode}`)]
				: []
	}
}

/** Every reason a role fails that no other role's verdict changes. */
const ownReasons = (at: Installation, role: RoleFacts): ReadonlyArray<IsolationReason> => {
	const written = writtenBy(role)
	return [
		...privilegeReasons(role),
		...lawReasons(at, written),
		...absenceReasons(at, written),
		...statementReasons(at, role),
		...sealedReasons(at, role)
	]
}

/** Condition 2's other half: no change member of a SERIALIZABLE role reads a relation the role writes. */
const serializableReaders = (
	role: RoleFacts,
	serializable: ReadonlyArray<RoleFacts>
): ReadonlyArray<IsolationReason> => {
	const written = writtenBy(role)
	return serializable.flatMap((other) =>
		placedOf(other).flatMap((p) =>
			p.reads.flatMap((r) =>
				written.has(r.relation)
					? [
							reason(
								"laws",
								{ member: p.member.name, statement: p.index, relation: r.relation },
								`${other.role} of ${other.login} reads it at SERIALIZABLE`
							)
						]
					: []
			)
		)
	)
}

/**
 * Each role's certificate: READ COMMITTED exactly when its change members meet every condition, its reads by roles
 * that run SERIALIZABLE judged against the final verdicts. The roles that meet every condition of their own start
 * READ COMMITTED; a role a SERIALIZABLE role's member reads the writes of runs SERIALIZABLE, which may make another so,
 * until none changes. Each step only removes roles, so the set it ends at is the greatest one every member of which
 * meets every condition against it. Roles keep the input's order.
 */
export const certify = (input: IsolationInput): ReadonlyArray<RoleIsolation> => {
	const at: Installation = { input, writers: new Writers(input) }
	const reasons = new Map<RoleFacts, ReadonlyArray<IsolationReason>>(
		input.roles.map((role) => [role, ownReasons(at, role)] as const)
	)
	let changed = true
	while (changed) {
		changed = false
		const serializable = input.roles.filter((role) => (reasons.get(role) ?? []).length > 0)
		for (const role of input.roles) {
			if ((reasons.get(role) ?? []).length > 0) {
				continue
			}
			const read = serializableReaders(role, serializable)
			if (read.length > 0) {
				reasons.set(role, read)
				changed = true
			}
		}
	}
	return input.roles.map((role): RoleIsolation => {
		const failed = reasons.get(role) ?? []
		return {
			login: role.login,
			role: role.role,
			certificate: isNonEmpty(failed)
				? { level: "serializable", reasons: failed }
				: { level: "readCommitted" }
		}
	})
}
