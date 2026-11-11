import { array, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import {
	type Candidate,
	certify,
	type IsolationReason,
	isolationOf,
	type RoleCertificate,
	type RoleIsolation
} from "#compiler/analysis/isolation/certify.ts"
import type {
	IsolationInput,
	ReadFact,
	StatementFacts
} from "#compiler/analysis/isolation/facts.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"
import * as Result from "#compiler/core/result.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { pg } from "#compiler/public/fields.ts"
import { type AnyRole, login, relation, role, schema } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"
import { type ChangeSetValue, changeSetOver } from "#compiler/write/changeset/value.ts"
import type { Shape } from "#test/pg/isolation/support/race.ts"
import { defined } from "#test/support/assert.ts"

/**
 * Drawn installations of pivots and multi-statement members, the certificates of their facts as the certifier reads them
 * (`factCertificates`), and their certificates under main's conditions restated over the drawing itself
 * (`drawnCertificates`), a second statement of the rules the certifier implements, which the oracle runs beside
 * `certify`'s wherever the two differ.
 *
 * Four insert-only relations R0..R3, each (k, v) keyed by k. Each of two or three roles r<i> has one change member m<i> of one
 * or two statements, each inserting into a relation the role writes: from the call's parameters (`put`), from the row of
 * another relation at the call's k (`point`), from every row of another relation (`all`), or from the parameters where
 * another relation holds no row at k (`absent`). Each statement after the first runs after the one before it, a
 * ChangeSet.sequence, so a member of two statements reads two snapshots at READ COMMITTED.
 *
 * The conditions over a drawing (certify.ts), every read of a relation some role writes taken as a read of other calls'
 * rows, never its own:
 * - absence: no member of any role reads the absence of a relation the role writes;
 * - snapshot (5a): a member reads relations some role writes in at most one statement;
 * - pivot (5b): a member that reads a relation some role writes, and writes one some member reads, derives every row it
 *   writes positively from that read: one statement, a `point` or `all`;
 * - laws (2): no SERIALIZABLE role's member reads a relation a READ COMMITTED role writes;
 * - writers (5c): no SERIALIZABLE writer of a relation a READ COMMITTED role reads reads a relation some role writes.
 * The last two depend on the levels: every role that meets the first three starts READ COMMITTED, and each pass makes
 * SERIALIZABLE one that fails either against the others, until none changes.
 */

/** How a statement finds the rows it inserts. */
export type DrawnRead =
	| { readonly kind: "put" }
	| { readonly kind: "point" | "all" | "absent"; readonly from: number }

export interface DrawnStatement {
	readonly into: number
	readonly read: DrawnRead
}

/** A drawn installation: each role's member, its statements in order. */
export interface DrawnInstallation {
	readonly members: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<DrawnStatement>>
}

const RELATIONS = 4

const relations = {
	R0: relation("R0", { k: pg.integer, v: pg.integer }, ["k"]),
	R1: relation("R1", { k: pg.integer, v: pg.integer }, ["k"]),
	R2: relation("R2", { k: pg.integer, v: pg.integer }, ["k"]),
	R3: relation("R3", { k: pg.integer, v: pg.integer }, ["k"])
} as const

type RelationName = keyof typeof relations

const relationName = (i: number): RelationName =>
	defined((["R0", "R1", "R2", "R3"] as const)[i], `relation ${i}`)

const statementGen: Gen<DrawnStatement> = (source) => {
	const into = source.draw(int(0, RELATIONS - 1))
	const from = (s: Parameters<Gen<number>>[0]) => (into + s.draw(int(1, RELATIONS - 1))) % RELATIONS
	return {
		into,
		read: source.draw(
			weighted<DrawnRead>([
				[2, () => ({ kind: "put" })],
				[2, (s) => ({ kind: "point", from: from(s) })],
				[1, (s) => ({ kind: "all", from: from(s) })],
				[1, (s) => ({ kind: "absent", from: from(s) })]
			])
		)
	}
}

const memberGen: Gen<Arr.NonEmptyReadonlyArray<DrawnStatement>> = (source) => {
	const [first, ...rest] = source.draw(array(statementGen, { min: 1, max: 2 }))
	return [defined(first, "a member's first statement"), ...rest]
}

const drawnInstallationGen: Gen<DrawnInstallation> = (source) => {
	const [first, ...rest] = source.draw(array(memberGen, { min: 2, max: 3 }))
	return { members: [defined(first, "the first role's member"), ...rest] }
}

/** The relations role `i`'s member writes, by name. */
const writesOf = (d: DrawnInstallation, i: number): ReadonlyArray<RelationName> =>
	Arr.dedupe(Arr.map(defined(d.members[i], `member ${i}`), (s) => relationName(s.into)))

/** Which parameters a statement reads: k where it reads one row or inserts one, v where it inserts its own. */
const paramsOf = (statement: DrawnStatement): ReadonlyArray<"k" | "v"> => {
	switch (statement.read.kind) {
		case "put":
		case "absent":
			return ["k", "v"]
		case "point":
			return ["k"]
		case "all":
			return []
	}
}

/** The parameters a call of role `i`'s member takes, at `k` and `v`. */
export const callParams = (d: DrawnInstallation, i: number, k: number, value: number): ParamMap => {
	const named = new Set(Arr.flatMap(defined(d.members[i], `member ${i}`), paramsOf))
	return {
		...(named.has("k") ? { k } : {}),
		...(named.has("v") ? { v: value } : {})
	}
}

/**
 * The installation of `d` under the name `name`: its schema, a role `r<i>` per member, the login `app` over them, and
 * each role's workload of its one member, built through the untyped builders a drawn program takes (races.test.ts's
 * way), since the members' parameters are drawn.
 */
export const drawnShape =
	(d: DrawnInstallation) =>
	(name: string): Shape => {
		const base = schema(name, Rec.values(relations), [])
		const [firstRole, ...otherRoles] = Arr.map(d.members, (_, i) =>
			role(base, `r${i}`, relations, { insert: writesOf(d, i) })
		)
		const roles = [defined(firstRole, "a role"), ...otherRoles] as const
		const changeOf = (r: AnyRole, statement: DrawnStatement): ChangeSetValue => {
			const into = relations[relationName(statement.into)]
			const read = statement.read
			const empty = changeSetOver.empty(r)
			switch (read.kind) {
				case "put":
					return empty.insert(
						into,
						queryOver(r).rule((q: RuleValue) =>
							q.find({ k: q.param("k", pg.integer), v: q.param("v", pg.integer) })
						)
					)
				case "point":
					return empty.insert(
						into,
						queryOver(r).rule((q: RuleValue) => {
							const { k, v: value } = varsOver(relations[relationName(read.from)], "from")
							return q
								.match(relations[relationName(read.from)], { k, v: value })
								.where(q.eq(k, q.param("k", pg.integer)))
								.find({ k, v: value })
						})
					)
				case "all":
					return empty.insert(
						into,
						queryOver(r).rule((q: RuleValue) => {
							const { k, v: value } = varsOver(relations[relationName(read.from)], "from")
							return q
								.match(relations[relationName(read.from)], { k, v: value })
								.find({ k, v: value })
						})
					)
				case "absent":
					return empty.insert(
						into,
						queryOver(r).rule((q: RuleValue) =>
							q
								.where(q.not(relations[relationName(read.from)], { k: q.param("k", pg.integer) }))
								.find({ k: q.param("k", pg.integer), v: q.param("v", pg.integer) })
						)
					)
			}
		}
		const workloads = Arr.map(roles, (r, i) => {
			const [first, second] = defined(d.members[i], `member ${i}`)
			const one = changeOf(r, first)
			return workload(r, {
				[`m${i}`]: second === undefined ? one : changeSetOver.sequence(one, changeOf(r, second))
			})
		})
		return {
			schema: base,
			roles: Rec.fromEntries(Arr.map(roles, (r, i) => [`r${i}`, r] as const)),
			login: login(base, "app", roles, { workload: workloads })
		}
	}

/** A statement's facts as the certifier reads them: its arbitration of what it inserts, then the read it inserts from. */
const statementFacts = (statement: DrawnStatement): StatementFacts => {
	const into = relationName(statement.into)
	const arbiter: ReadFact = {
		relation: into,
		mode: "arbiter",
		base: "arbiter",
		probes: [],
		own: false,
		group: { fields: ["k"], binding: "excluded.k", rows: "one" }
	}
	const read = statement.read
	switch (read.kind) {
		case "put":
			return {
				writes: [{ relation: into, op: "insert", from: [] }],
				reads: [arbiter],
				probes: [],
				cores: []
			}
		case "point":
		case "all":
		case "absent":
			return {
				writes: [{ relation: into, op: "insert", from: read.kind === "absent" ? [] : [1] }],
				reads: [
					arbiter,
					{
						relation: relationName(read.from),
						mode: read.kind === "absent" ? "negated" : "positive",
						base: read.kind === "absent" ? "negated" : "positive",
						probes: [],
						own: false,
						group: read.kind === "all" ? undefined : { fields: ["k"], binding: "$k", rows: "one" }
					}
				],
				probes: [],
				cores: []
			}
	}
}

/**
 * The facts of `d` as the certifier reads them, one to one with the drawing: every relation keyed by k with every law
 * native, no counted group and no foreign key; each role SELECT on every relation and INSERT on those its member writes; each member's
 * statements in order.
 */
const drawnFacts = (d: DrawnInstallation): IsolationInput => ({
	relations: new Map(
		Arr.map(
			Rec.keys(relations),
			(name) =>
				[name, { triggerLaws: [], keys: [["k"]], countedGroups: [], references: [] }] as const
		)
	),
	roles: Arr.map(d.members, (member, i) => {
		const writes = new Set<string>(writesOf(d, i))
		return {
			login: "app",
			role: `r${i}`,
			privileges: new Map(
				Arr.map(Rec.keys(relations), (name): readonly [string, ReadonlySet<TablePrivilege>] => [
					name,
					new Set<TablePrivilege>(writes.has(name) ? ["SELECT", "INSERT"] : ["SELECT"])
				])
			),
			members: [{ name: `m${i}`, statements: mapNonEmpty(member, statementFacts) }]
		}
	})
})

/**
 * The certificates `certify` gives the facts of `d` (drawnFacts), each role lowered to a SERIALIZABLE form of no fact:
 * a drawing states its members' READ COMMITTED facts alone.
 */
export const factCertificates = (d: DrawnInstallation): ReadonlyArray<RoleIsolation> => {
	const input = drawnFacts(d)
	const certified = certify(
		input.relations,
		Arr.map(input.roles, (role): Candidate<undefined, undefined, never> => ({
			role,
			readCommitted: undefined,
			lower: () => Result.ok({ facts: [], form: undefined })
		}))
	)
	return certified.ok ? Arr.map(certified.value, isolationOf) : certified.error
}

/** A statement's read of a relation, with how it reads it. */
interface Read {
	readonly member: number
	readonly statement: number
	readonly from: number
	readonly mode: "positive" | "negated"
}

const readsOf = (d: DrawnInstallation): ReadonlyArray<Read> =>
	Arr.flatMap(d.members, (member, i) =>
		Arr.flatMap(member, (s, statement): ReadonlyArray<Read> =>
			s.read.kind === "put"
				? []
				: [
						{
							member: i,
							statement,
							from: s.read.from,
							mode: s.read.kind === "absent" ? "negated" : "positive"
						}
					]
		)
	)

const reason = (
	condition: IsolationReason["condition"],
	member: number,
	statement: number | undefined,
	relation: number | undefined,
	detail: string
): IsolationReason => ({
	condition,
	member: `m${member}`,
	statement,
	relation: relation === undefined ? undefined : relationName(relation),
	detail
})

/** The certificate of each role of `d` under the conditions in the header. */
export const drawnCertificates = (d: DrawnInstallation): ReadonlyArray<RoleIsolation> => {
	const roles = Arr.map(d.members, (_, i) => i)
	const writes = Arr.map(
		roles,
		(i) => new Set(Arr.map(defined(d.members[i], "member"), (s) => s.into))
	)
	const written = new Set(Arr.flatMap(writes, (w) => [...w]))
	const reads = readsOf(d)
	const othersRead = Arr.filter(reads, (r) => written.has(r.from))
	const readRelations = new Set(Arr.map(reads, (r) => r.from))
	const local = (i: number): ReadonlyArray<IsolationReason> => {
		const own = defined(writes[i], "writes")
		const member = defined(d.members[i], "member")
		const mine = Arr.filter(othersRead, (r) => r.member === i)
		const absence = Arr.filter(reads, (r) => r.mode === "negated" && own.has(r.from))
		const snapshots = new Set(Arr.map(mine, (r) => r.statement))
		const readIn = Arr.some([...own], (relation) => readRelations.has(relation))
		const derived =
			member.length === 1 && Arr.every(mine, (r) => r.mode === "positive") && mine.length === 1
		return [
			...Arr.map(absence, (r) =>
				reason("absence", r.member, r.statement, r.from, `m${r.member} reads its absence`)
			),
			...(snapshots.size > 1
				? [reason("snapshot", i, undefined, undefined, "reads other calls' rows in two statements")]
				: []),
			...(mine.length > 0 && readIn && !derived
				? [
						reason(
							"pivot",
							i,
							undefined,
							undefined,
							"reads other calls' rows and writes a relation a member reads, not every row derived from that read"
						)
					]
				: [])
		]
	}
	const locals = Arr.map(roles, local)
	const serializable = new Set(Arr.filter(roles, (i) => defined(locals[i], "local").length > 0))
	const readsOthers = (i: number) => Arr.some(othersRead, (r) => r.member === i)
	const global = (i: number): ReadonlyArray<IsolationReason> => {
		const own = defined(writes[i], "writes")
		const lawReaders = Arr.filter(
			reads,
			(r) => serializable.has(r.member) && r.member !== i && own.has(r.from)
		)
		const unsafeWriters = Arr.filter(
			Arr.filter(othersRead, (r) => r.member === i),
			(r) =>
				Arr.some(
					[...serializable],
					(w) => w !== i && defined(writes[w], "writes").has(r.from) && readsOthers(w)
				)
		)
		return [
			...Arr.map(lawReaders, (r) =>
				reason("laws", i, undefined, r.from, `SERIALIZABLE m${r.member} reads it`)
			),
			...Arr.map(unsafeWriters, (r) =>
				reason(
					"writers",
					i,
					r.statement,
					r.from,
					"a SERIALIZABLE writer of it reads other calls' rows"
				)
			)
		]
	}
	for (;;) {
		const fallen = Arr.filter(roles, (i) => !serializable.has(i) && global(i).length > 0)
		if (fallen.length === 0) {
			break
		}
		for (const i of fallen) {
			serializable.add(i)
		}
	}
	return Arr.map(roles, (i): RoleIsolation => {
		const [first, ...rest] = [...defined(locals[i], "local"), ...global(i)]
		const certificate: RoleCertificate =
			serializable.has(i) && first !== undefined
				? { level: "serializable", reasons: [first, ...rest] }
				: { level: "readCommitted" }
		return { login: "app", role: `r${i}`, certificate }
	})
}

/** A drawn race: the installation, two or three calls of its members, and the stored rows it starts from. */
export interface DrawnRace {
	readonly installation: DrawnInstallation
	readonly initial: ReadonlyArray<{
		readonly relation: number
		readonly k: number
		readonly v: number
	}>
	readonly calls: Arr.NonEmptyReadonlyArray<{
		readonly role: number
		readonly k: number
		readonly v: number
	}>
}

export const drawnRaceGen: Gen<DrawnRace> = (source) => {
	const installation = source.draw(drawnInstallationGen)
	const roles = installation.members.length
	const callGen: Gen<DrawnRace["calls"][number]> = (s) => ({
		role: s.draw(int(0, roles - 1)),
		k: s.draw(int(1, 2)),
		v: s.draw(int(0, 1))
	})
	const [first, ...rest] = source.draw(array(callGen, { min: 2, max: 3 }))
	return {
		installation,
		initial: source.draw(
			array(
				(s) => ({
					relation: s.draw(int(0, RELATIONS - 1)),
					k: s.draw(int(1, 2)),
					v: s.draw(element([0, 1]))
				}),
				{ min: 0, max: 2 }
			)
		),
		calls: [defined(first, "a race's first call"), ...rest]
	}
}
