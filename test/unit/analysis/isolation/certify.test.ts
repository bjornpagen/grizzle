/**
 * The isolation certifier (analysis/isolation/certify.ts) over drawn installations: two logins' roles over four
 * relations, each relation with trigger-held laws or not, declared keys and counted groups, each role's privileges, and
 * its change members' statements, each reading relations, positively, negated, counted or as grizzle's key arbitration,
 * its own rows or not, by a group bound to a parameter or not, and writing relations, by insert, update or delete, with
 * each written row joined with some of its statement's reads. Some draws are counterexamples: two
 * copiers, each inserting into one relation and then copying the other's (by a scan, or at a whole key); a writer reading
 * another's absence beside a reader of both; a chain of SERIALIZABLE readers; a SERIALIZABLE pivot writing what an RC
 * member reads unsealed; and the sealed reads beside each other.
 *
 * The oracle restates every condition over the drawn facts, apart from the certifier's code: each role's own conditions,
 * then, of the roles that meet them, the greatest set none of whose members a role outside it gives a reason, found by
 * trying every subset. Every role's level is the oracle's, and every SERIALIZABLE role names exactly the conditions the
 * oracle finds it failing; a role with no change member is SERIALIZABLE by the members condition. Adding a capability
 * (a privilege, a read, a statement, a member, a role, an insert with no insert, a trigger-held law) never makes a
 * SERIALIZABLE role READ COMMITTED, nor does removing a relation's fact, but for the first change member of a role with
 * none, which the members condition alone held. An arbitration is sealed only where it binds a whole declared key of
 * an insert-only relation, and a role writes READ COMMITTED only relations no role updates or deletes.
 * Every counterexample comes out SERIALIZABLE.
 *
 * Planted in a scratch copy, each of these fails the search: condition 2's SERIALIZABLE readers left out; the fixpoint
 * run once; a pivot's write before a group read only later let through; a pivot's write after an outside read joined
 * with no row of its call let through; an unsealed read sharing a member with an outside read in another statement let
 * through; condition 5c left out; a read binding part of a declared key sealed as a point; a role with no change
 * member certified; an arbitration of no whole key sealed; an arbitration of a relation a role deletes sealed; and a
 * relation another role deletes written READ COMMITTED.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, type Gen, int, shuffled, subset, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import type { Source } from "@grizzle/testing/source"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	certify,
	type IsolationCondition,
	type ReadSeal,
	type RoleIsolation,
	readSeal
} from "#compiler/analysis/isolation/certify.ts"
import type { IsolationInput, RoleFacts } from "#compiler/analysis/isolation/facts.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"
import { assert } from "#test/support/assert.ts"
import { wild } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { upTo } from "#test/support/up-to.ts"

const RELATIONS = 4
const KEYS: ReadonlyArray<ReadonlyArray<string>> = [["k0"], ["k1"], ["k0", "k1"]]

interface WriteSketch {
	readonly relation: number
	readonly op: "insert" | "update" | "delete"
	readonly from: ReadonlyArray<number>
}

interface ReadSketch {
	readonly relation: number
	readonly mode: "positive" | "negated" | "counted" | "arbiter"
	readonly own: boolean
	readonly group: number | undefined
	readonly binding: number
}

interface StatementSketch {
	readonly writes: ReadonlyArray<WriteSketch>
	readonly reads: ReadonlyArray<ReadSketch>
}

interface RoleSketch {
	readonly login: number
	readonly privileges: ReadonlyArray<{
		readonly relation: number
		readonly privilege: TablePrivilege
	}>
	readonly members: ReadonlyArray<ReadonlyArray<StatementSketch>>
}

interface RelationSketch {
	readonly triggerLaws: boolean
	readonly keys: ReadonlyArray<number>
	readonly counted: ReadonlyArray<number>
}

interface Sketch {
	readonly relations: ReadonlyArray<RelationSketch>
	readonly roles: ReadonlyArray<RoleSketch>
}

/** One capability added to an installation, or a relation's fact dropped. */
type Extension =
	| {
			readonly kind: "privilege"
			readonly role: number
			readonly relation: number
			readonly privilege: TablePrivilege
	  }
	| { readonly kind: "read"; readonly role: number; readonly read: ReadSketch }
	| { readonly kind: "statement"; readonly role: number; readonly statement: StatementSketch }
	| {
			readonly kind: "member"
			readonly role: number
			readonly member: ReadonlyArray<StatementSketch>
	  }
	| { readonly kind: "role"; readonly role: RoleSketch }
	| { readonly kind: "insert"; readonly role: number; readonly relation: number }
	| { readonly kind: "triggerLaw"; readonly relation: number }
	| { readonly kind: "dropFact"; readonly relation: number }

type Shape =
	| "drawn"
	| "copiers"
	| "pointCopiers"
	| "absentThenInsert"
	| "chain"
	| "seals"
	| "pivotWriter"
	| "triggered"

/** A drawn installation, which may be one of the counterexamples or a fixed shape, and an extension of it. */
interface Case {
	readonly sketch: Sketch
	readonly shape: Shape
	readonly extension: Extension
}

const relationGen: Gen<number> = int(0, RELATIONS - 1)
const privilegeGen: Gen<TablePrivilege> = weighted<TablePrivilege>([
	[4, () => "SELECT"],
	[4, () => "INSERT"],
	[1, () => "UPDATE"],
	[1, () => "DELETE"]
])

const readGen: Gen<ReadSketch> = (s) => ({
	relation: s.draw(relationGen),
	mode: s.draw(
		weighted<ReadSketch["mode"]>([
			[6, () => "positive"],
			[1, () => "negated"],
			[1, () => "counted"],
			[1, () => "arbiter"]
		])
	),
	own: s.draw(
		weighted<boolean>([
			[1, () => true],
			[2, () => false]
		])
	),
	group: s.draw(
		weighted<number | undefined>([
			[3, () => 0],
			[1, () => 1],
			[2, () => 2],
			[1, () => undefined]
		])
	),
	binding: s.draw(int(0, 1))
})

const writeGen =
	(reads: number): Gen<WriteSketch> =>
	(s) => ({
		relation: s.draw(relationGen),
		op: s.draw(
			weighted<WriteSketch["op"]>([
				[6, () => "insert"],
				[1, () => "update"],
				[1, () => "delete"]
			])
		),
		from: s.draw(
			subset(
				upTo(reads, (i) => i),
				{ min: 0, max: reads }
			)
		)
	})

const statementGen: Gen<StatementSketch> = (s) => {
	const reads = s.draw(array(readGen, { min: 0, max: 2 }))
	return { reads, writes: s.draw(array(writeGen(reads.length), { min: 0, max: 2 })) }
}

const roleGen: Gen<RoleSketch> = (s) => ({
	login: s.draw(int(0, 1)),
	privileges: s.draw(
		array((t) => ({ relation: t.draw(relationGen), privilege: t.draw(privilegeGen) }), {
			min: 0,
			max: 3
		})
	),
	members: s.draw(array(array(statementGen, { min: 1, max: 3 }), { min: 0, max: 2 }))
})

const relationSketchGen: Gen<RelationSketch> = (s) => ({
	triggerLaws: s.draw(
		weighted<boolean>([
			[1, () => true],
			[5, () => false]
		])
	),
	keys: s.draw(
		weighted<ReadonlyArray<number>>([
			[2, () => [2]],
			[1, () => [0]],
			[1, () => [1]],
			[1, () => []]
		])
	),
	counted: s.draw(
		weighted<ReadonlyArray<number>>([
			[3, () => []],
			[1, () => [0]],
			[1, () => [1]]
		])
	)
})

const sketchGen: Gen<Sketch> = (s) => ({
	relations: Arr.makeBy(RELATIONS, () => s.draw(relationSketchGen)),
	roles: s.draw(array(roleGen, { min: 1, max: 4 }))
})

const clean = (keys: ReadonlyArray<number>): RelationSketch => ({
	triggerLaws: false,
	keys,
	counted: []
})

const insertOf = (relation: number, from: ReadonlyArray<number>): WriteSketch => ({
	relation,
	op: "insert",
	from
})

const readOf = (
	relation: number,
	mode: ReadSketch["mode"],
	group: number | undefined
): ReadSketch => ({ relation, mode, own: false, group, binding: 0 })

/** Every privilege a role writing and reading every relation as INSERT and SELECT holds. */
const insertSelectAll: RoleSketch["privileges"] = Arr.flatMap([0, 1, 2, 3], (relation) => [
	{ relation, privilege: "SELECT" },
	{ relation, privilege: "INSERT" }
])

/** m1 inserts A(v) and copies B into P, m2 inserts B(v) and copies A into Q: by a scan, or at A's and B's whole key. */
const copiersOf = (group: number | undefined): Sketch => ({
	relations: Arr.makeBy(RELATIONS, () => clean([2])),
	roles: Arr.map([0, 1], (i): RoleSketch => ({
		login: i,
		privileges: insertSelectAll,
		members: [
			[
				{ writes: [insertOf(i, [])], reads: [] },
				{ writes: [insertOf(2 + i, [0])], reads: [readOf(1 - i, "positive", group)] }
			]
		]
	}))
})

/**
 * T1 reads B(k)'s absence and inserts A(k), T2 inserts B(k), and a third role's member reads A(k) and B(k) and writes
 * what it read.
 */
const absentThenInsert: Sketch = {
	relations: Arr.makeBy(RELATIONS, () => clean([])),
	roles: [
		{
			login: 0,
			privileges: [
				{ relation: 0, privilege: "INSERT" },
				{ relation: 1, privilege: "SELECT" }
			],
			members: [[{ writes: [insertOf(0, [])], reads: [readOf(1, "negated", 0)] }]]
		},
		{
			login: 0,
			privileges: [{ relation: 1, privilege: "INSERT" }],
			members: [[{ writes: [insertOf(1, [])], reads: [] }]]
		},
		{
			login: 1,
			privileges: [
				{ relation: 0, privilege: "SELECT" },
				{ relation: 1, privilege: "SELECT" },
				{ relation: 2, privilege: "INSERT" }
			],
			members: [
				[
					{
						writes: [insertOf(2, [0, 1])],
						reads: [readOf(0, "positive", 0), readOf(1, "positive", 0)]
					}
				]
			]
		}
	]
}

const threeOf = (s: Source): readonly [number, number, number] => {
	const [a = 0, b = 1, c = 2] = s.draw(shuffled([0, 1, 2, 3], { min: 3, max: 3 }))
	return [a, b, c]
}

/**
 * r0 updates c, so it runs SERIALIZABLE on its own, and reads what r1 writes; r1 reads what r2 writes at its whole key.
 * r1 runs SERIALIZABLE for r0's read, r2 for r1's, two steps from any failure of their own.
 */
const chainGen: Gen<Sketch> = (s) => {
	const [a, b, c] = threeOf(s)
	return {
		relations: Arr.makeBy(RELATIONS, (i) => clean(i === b ? [0] : [])),
		roles: [
			{
				login: s.draw(int(0, 1)),
				privileges: [{ relation: c, privilege: "UPDATE" }],
				members: [[{ writes: [], reads: [readOf(a, "positive", 0)] }]]
			},
			{
				login: s.draw(int(0, 1)),
				privileges: [{ relation: a, privilege: "INSERT" }],
				members: [[{ writes: [insertOf(a, [0])], reads: [readOf(b, "positive", 0)] }]]
			},
			{
				login: s.draw(int(0, 1)),
				privileges: [{ relation: b, privilege: "INSERT" }],
				members: [[{ writes: [insertOf(b, [])], reads: [] }]]
			}
		]
	}
}

/**
 * r0 inserts into b and c; b's key is (k0, k1) and c's group by k0 is a family's counted members; r1 reads b at its
 * whole key and c by k0 in one statement and inserts into a joined with both, arbitrating a at its whole key: a point
 * read, a counted group read and an arbitration a unique check decides.
 */
const sealsGen: Gen<Sketch> = (s) => {
	const [a = 0, b = 1, c = 2] = s.draw(shuffled([0, 1, 2, 3], { min: 3, max: 3 }))
	return {
		relations: Arr.makeBy(RELATIONS, (i) => ({
			triggerLaws: false,
			keys: i === b || i === a ? [2] : [],
			counted: i === c ? [0] : []
		})),
		roles: [
			{
				login: s.draw(int(0, 1)),
				privileges: [
					{ relation: b, privilege: "INSERT" },
					{ relation: c, privilege: "INSERT" }
				],
				members: [
					[
						{
							writes: [insertOf(b, []), insertOf(c, [])],
							reads: []
						}
					]
				]
			},
			{
				login: s.draw(int(0, 1)),
				privileges: [{ relation: a, privilege: "INSERT" }],
				members: [
					[
						{
							writes: [insertOf(a, [0, 1])],
							reads: [readOf(b, "positive", 2), readOf(c, "positive", 0), readOf(a, "arbiter", 2)]
						}
					]
				]
			}
		]
	}
}

/**
 * r0 updates c, so it runs SERIALIZABLE, inserts into b and reads a from outside: a pivot at SERIALIZABLE. r1 reads b
 * unsealed in a member that writes nothing and inserts into a in another, so it meets every condition of its own and
 * runs SERIALIZABLE by 5c alone.
 */
const pivotWriterGen: Gen<Sketch> = (s) => {
	const [a, b, c] = threeOf(s)
	return {
		relations: Arr.makeBy(RELATIONS, () => clean([])),
		roles: [
			{
				login: s.draw(int(0, 1)),
				privileges: [
					{ relation: c, privilege: "UPDATE" },
					{ relation: b, privilege: "INSERT" }
				],
				members: [[{ writes: [insertOf(b, [])], reads: [readOf(a, "positive", undefined)] }]]
			},
			{
				login: s.draw(int(0, 1)),
				privileges: [{ relation: a, privilege: "INSERT" }],
				members: [
					[{ writes: [], reads: [readOf(b, "positive", undefined)] }],
					[{ writes: [insertOf(a, [])], reads: [] }]
				]
			}
		]
	}
}

/** A role that only inserts into a relation a trigger-held law reads, and that relation's fact dropped. */
const triggeredGen: Gen<Case> = (s) => {
	const x = s.draw(relationGen)
	return {
		sketch: {
			relations: Arr.makeBy(RELATIONS, (i) => ({ triggerLaws: i === x, keys: [], counted: [] })),
			roles: [
				{
					login: s.draw(int(0, 1)),
					privileges: [{ relation: x, privilege: "INSERT" }],
					members: [[{ writes: [insertOf(x, [])], reads: [] }]]
				}
			]
		},
		shape: "triggered",
		extension: { kind: "dropFact", relation: x }
	}
}

const extensionGen =
	(sketch: Sketch): Gen<Extension> =>
	(s) => {
		const role = s.draw(int(0, sketch.roles.length - 1))
		return s.draw(
			weighted<Extension>([
				[
					2,
					(t) => ({
						kind: "privilege",
						role,
						relation: t.draw(relationGen),
						privilege: t.draw(privilegeGen)
					})
				],
				[2, (t) => ({ kind: "read", role, read: t.draw(readGen) })],
				[1, (t) => ({ kind: "statement", role, statement: t.draw(statementGen) })],
				[
					1,
					(t) => ({
						kind: "member",
						role,
						member: t.draw(array(statementGen, { min: 1, max: 2 }))
					})
				],
				[1, (t) => ({ kind: "role", role: t.draw(roleGen) })],
				[1, (t) => ({ kind: "insert", role, relation: t.draw(relationGen) })],
				[1, (t) => ({ kind: "triggerLaw", relation: t.draw(relationGen) })],
				[1, (t) => ({ kind: "dropFact", relation: t.draw(relationGen) })]
			])
		)
	}

const shapeSketch = (s: Source, shape: Exclude<Shape, "triggered">): Sketch => {
	switch (shape) {
		case "copiers":
			return copiersOf(undefined)
		case "pointCopiers":
			return copiersOf(2)
		case "absentThenInsert":
			return absentThenInsert
		case "chain":
			return s.draw(chainGen)
		case "seals":
			return s.draw(sealsGen)
		case "pivotWriter":
			return s.draw(pivotWriterGen)
		case "drawn":
			return s.draw(sketchGen)
	}
}

const caseGen: Gen<Case> = (s) => {
	const shape = s.draw(
		weighted<Shape>([
			[8, () => "drawn"],
			[1, () => "copiers"],
			[1, () => "pointCopiers"],
			[1, () => "absentThenInsert"],
			[1, () => "chain"],
			[1, () => "seals"],
			[1, () => "pivotWriter"],
			[1, () => "triggered"]
		])
	)
	if (shape === "triggered") {
		return s.draw(triggeredGen)
	}
	const sketch = shapeSketch(s, shape)
	return { sketch, shape, extension: s.draw(extensionGen(sketch)) }
}

const relationName = (i: number): string => `R${i}`
const keyOf = (i: number): ReadonlyArray<string> => Arr.getUnsafe(KEYS, i)
const lawId = (i: number) => wild.lawId(`law_${i}`)

const readFact = (r: ReadSketch) => ({
	relation: relationName(r.relation),
	mode: r.mode,
	own: r.own,
	group: r.group === undefined ? undefined : keyOf(r.group),
	binding: r.group === undefined ? undefined : `$p${r.binding}`
})

/** The facts a sketch states, as the certifier reads them. */
const inputOf = (sketch: Sketch): IsolationInput => ({
	relations: new Map(
		Arr.map(sketch.relations, (r, i) => [
			relationName(i),
			{
				triggerLaws: r.triggerLaws ? [lawId(i)] : [],
				keys: Arr.map(r.keys, keyOf),
				countedGroups: Arr.map(r.counted, keyOf)
			}
		])
	),
	roles: Arr.map(sketch.roles, (role, i): RoleFacts => {
		const privileges = new Map<string, Set<TablePrivilege>>()
		for (const p of role.privileges) {
			const held = privileges.get(relationName(p.relation)) ?? new Set<TablePrivilege>()
			held.add(p.privilege)
			privileges.set(relationName(p.relation), held)
		}
		return {
			login: `L${role.login}`,
			role: `r${i}`,
			privileges,
			members: Arr.flatMap(role.members, (statements, m) =>
				Arr.isReadonlyArrayNonEmpty(statements)
					? [
							{
								name: `m${m}`,
								statements: Arr.map(statements, (st) => ({
									writes: Arr.map(st.writes, (w) => ({
										relation: relationName(w.relation),
										op: w.op,
										from: w.from
									})),
									reads: Arr.map(st.reads, readFact)
								}))
							}
						]
					: []
			)
		}
	})
})

const withRole = (sketch: Sketch, at: number, edit: (role: RoleSketch) => RoleSketch): Sketch => ({
	...sketch,
	roles: Arr.map(sketch.roles, (role, i) => (i === at ? edit(role) : role))
})

const withRelation = (
	sketch: Sketch,
	at: number,
	edit: (r: RelationSketch) => RelationSketch
): Sketch => ({
	...sketch,
	relations: Arr.map(sketch.relations, (r, i) => (i === at ? edit(r) : r))
})

/** The sketch with one capability added; a dropped fact is dropped from the facts (afterOf). */
const extended = (sketch: Sketch, e: Extension): Sketch => {
	switch (e.kind) {
		case "privilege":
			return withRole(sketch, e.role, (r) => ({
				...r,
				privileges: [...r.privileges, { relation: e.relation, privilege: e.privilege }]
			}))
		case "read":
			return withRole(sketch, e.role, (r) => ({
				...r,
				members: Arr.match(r.members, {
					onEmpty: () => [[{ writes: [], reads: [e.read] }]],
					onNonEmpty: ([first, ...rest]) => [
						Arr.match(first, {
							onEmpty: () => [{ writes: [], reads: [e.read] }],
							onNonEmpty: ([head, ...tail]) => [
								{ ...head, reads: [...head.reads, e.read] },
								...tail
							]
						}),
						...rest
					]
				})
			}))
		case "statement":
			return withRole(sketch, e.role, (r) => ({
				...r,
				members: Arr.match(r.members, {
					onEmpty: () => [[e.statement]],
					onNonEmpty: ([first, ...rest]) => [[...first, e.statement], ...rest]
				})
			}))
		case "member":
			return withRole(sketch, e.role, (r) => ({ ...r, members: [...r.members, e.member] }))
		case "role":
			return { ...sketch, roles: [...sketch.roles, e.role] }
		case "insert":
			return withRole(sketch, e.role, (r) => ({
				...r,
				members: [...r.members, [{ writes: [insertOf(e.relation, [])], reads: [] }]]
			}))
		case "triggerLaw":
			return withRelation(sketch, e.relation, (r) => ({ ...r, triggerLaws: true }))
		case "dropFact":
			return sketch
	}
}

/** Whether an extension gives a role with no change member its first, which the members condition alone held
 * SERIALIZABLE, so it and the roles it held may relax. */
const givesFirstMember = (sketch: Sketch, e: Extension): boolean => {
	switch (e.kind) {
		case "read":
		case "statement":
		case "member":
		case "insert":
			return Arr.some(sketch.roles, (role, i) => i === e.role && role.members.length === 0)
		case "privilege":
		case "role":
		case "triggerLaw":
		case "dropFact":
			return false
	}
}

/** The facts after a case's extension: a dropped fact leaves its relation out of the facts. */
const afterOf = (c: Case): IsolationInput => {
	const input = inputOf(extended(c.sketch, c.extension))
	const e = c.extension
	return e.kind === "dropFact"
		? {
				...input,
				relations: new Map(
					Arr.filter([...input.relations], ([name]) => name !== relationName(e.relation))
				)
			}
		: input
}

const writesOfRole = (role: RoleSketch) =>
	Arr.flatMap(role.members, (statements) => Arr.flatMap(statements, (st) => st.writes))

/** The relations a role writes, by its privileges and its members' writes. */
const writtenSet = (role: RoleSketch): ReadonlySet<number> =>
	new Set([
		...Arr.flatMap(role.privileges, (p) => (p.privilege === "SELECT" ? [] : [p.relation])),
		...Arr.map(writesOfRole(role), (w) => w.relation)
	])

type OracleSeal = "arbiter" | "own" | "unwritten" | "sealed" | "unsealed"

/**
 * The oracle: each condition stated over the sketch on its own, and the levels as the greatest set of roles that meet
 * their own conditions none of whose members a role outside the set gives a reason.
 */
const oracle = (sketch: Sketch) => {
	const roles = sketch.roles
	const anyWrites = (relation: number) => Arr.some(roles, (r) => writtenSet(r).has(relation))
	const changes = (relation: number) =>
		Arr.some(
			roles,
			(r) =>
				Arr.some(
					r.privileges,
					(p) => p.relation === relation && (p.privilege === "UPDATE" || p.privilege === "DELETE")
				) || Arr.some(writesOfRole(r), (w) => w.relation === relation && w.op !== "insert")
		)
	const sealOfRead = (read: ReadSketch): OracleSeal => {
		if (read.own) {
			return "own"
		}
		if (!anyWrites(read.relation)) {
			return "unwritten"
		}
		const group = read.group
		const facts = Arr.getUnsafe(sketch.relations, read.relation)
		const keyed =
			group !== undefined &&
			Arr.some(facts.keys, (k) => Arr.every(keyOf(k), (f) => keyOf(group).includes(f)))
		if (read.mode === "arbiter") {
			return keyed && !changes(read.relation) ? "arbiter" : "unsealed"
		}
		if (group === undefined || changes(read.relation)) {
			return "unsealed"
		}
		return facts.counted.includes(group) || keyed ? "sealed" : "unsealed"
	}
	const isOutside = (seal: OracleSeal) => seal === "sealed" || seal === "unsealed"
	const groupName = (r: ReadSketch) =>
		`${r.relation}/${r.group ?? "-"}/${r.group === undefined ? "-" : r.binding}`
	const outsideReads = (role: RoleSketch, unsealedOnly: boolean): ReadonlySet<number> =>
		new Set(
			Arr.flatMap(role.members, (statements) =>
				Arr.flatMap(statements, (st) =>
					Arr.flatMap(st.reads, (r) => {
						const seal = sealOfRead(r)
						return isOutside(seal) && (!unsealedOnly || seal === "unsealed") ? [r.relation] : []
					})
				)
			)
		)
	const own = (role: RoleSketch): ReadonlySet<IsolationCondition> => {
		const failed = new Set<IsolationCondition>()
		if (role.members.length === 0) {
			failed.add("members")
		}
		if (
			Arr.some(role.privileges, (p) => p.privilege === "UPDATE" || p.privilege === "DELETE") ||
			Arr.some([...writtenSet(role)], changes)
		) {
			failed.add("privileges")
		}
		for (const relation of writtenSet(role)) {
			if (Arr.getUnsafe(sketch.relations, relation).triggerLaws) {
				failed.add("laws")
			}
			if (
				Arr.some(roles, (r) =>
					Arr.some(r.members, (statements) =>
						Arr.some(statements, (st) =>
							Arr.some(
								st.reads,
								(read) =>
									read.relation === relation &&
									(read.mode === "negated" ||
										read.mode === "counted" ||
										(read.mode === "arbiter" && sealOfRead(read) === "unsealed"))
							)
						)
					)
				)
			) {
				failed.add("absence")
			}
		}
		for (const statements of role.members) {
			const outs = Arr.flatMap(statements, (st, at) =>
				Arr.flatMap(st.reads, (read, index) => {
					const seal = sealOfRead(read)
					return isOutside(seal) ? [{ at, index, read, seal }] : []
				})
			)
			if (Arr.some(outs, (p) => p.seal === "unsealed" && Arr.some(outs, (o) => o.at !== p.at))) {
				failed.add("snapshot")
			}
			const writes = Arr.flatMap(statements, (st, at) => Arr.map(st.writes, (w) => ({ at, w })))
			if (outs.length > 0 && writes.length > 0) {
				if (Arr.some(outs, (o) => o.seal === "unsealed" || o.read.mode !== "positive")) {
					failed.add("pivot")
				}
				const firstOut = Arr.reduce(outs, Number.POSITIVE_INFINITY, (least, o) =>
					Math.min(least, o.at)
				)
				const firstAt = new Map<string, number>()
				for (const o of outs) {
					const name = groupName(o.read)
					firstAt.set(name, Math.min(firstAt.get(name) ?? o.at, o.at))
				}
				for (const { at, w } of writes) {
					const st = Arr.getUnsafe(statements, at)
					const joinedOwn = Arr.some(
						st.reads,
						(read, index) =>
							sealOfRead(read) === "own" && read.mode === "positive" && w.from.includes(index)
					)
					if (Arr.some(outs, (o) => o.at === at && !w.from.includes(o.index))) {
						failed.add("pivot")
					}
					if (at > firstOut && !joinedOwn) {
						failed.add("pivot")
					}
					if (Arr.some([...firstAt.values()], (g) => g > at)) {
						failed.add("pivot")
					}
				}
			}
		}
		return failed
	}
	const owns = Arr.map(roles, own)
	const candidates = Arr.filter(
		Arr.map(roles, (_, i) => i),
		(i) => Arr.getUnsafe(owns, i).size === 0
	)
	const given = (outside: ReadonlySet<number>, i: number): ReadonlySet<IsolationCondition> => {
		const role = Arr.getUnsafe(roles, i)
		const written = writtenSet(role)
		const unsealed = outsideReads(role, true)
		const out = new Set<IsolationCondition>()
		for (const o of Arr.filter([...outside], (x) => x !== i)) {
			const other = Arr.getUnsafe(roles, o)
			if (
				Arr.some(other.members, (statements) =>
					Arr.some(statements, (st) => Arr.some(st.reads, (r) => written.has(r.relation)))
				)
			) {
				out.add("laws")
			}
			const shared = Arr.some([...writtenSet(other)], (x) => unsealed.has(x))
			const pivot =
				outsideReads(other, false).size > 0 ||
				Arr.some([...writtenSet(other)], (x) => Arr.getUnsafe(sketch.relations, x).triggerLaws)
			if (shared && pivot) {
				out.add("writers")
			}
		}
		return out
	}
	const all = new Set(Arr.map(roles, (_, i) => i))
	let best = new Set<number>()
	for (let mask = 0; mask < 1 << candidates.length; mask += 1) {
		const set = new Set(Arr.filter(candidates, (_, b) => (mask & (1 << b)) !== 0))
		const outside = new Set(Arr.filter([...all], (i) => !set.has(i)))
		if (Arr.every([...set], (i) => given(outside, i).size === 0)) {
			best = new Set([...best, ...set])
		}
	}
	const outside = new Set(Arr.filter([...all], (i) => !best.has(i)))
	return Arr.map(roles, (_, i) => {
		const owned = Arr.getUnsafe(owns, i)
		const failed = owned.size > 0 ? owned : given(outside, i)
		return { readCommitted: best.has(i), failed, own: owned }
	})
}

type IsolationFeature =
	| "a role certified READ COMMITTED"
	| `a role SERIALIZABLE by ${IsolationCondition}`
	| "a role SERIALIZABLE only through roles that run SERIALIZABLE"
	| "a counted group read"
	| "a point read"
	| "a read of a relation no role writes"
	| "an arbitration a unique check decides"
	| "an arbitration of no whole declared key"
	| "a first change member given to a role with none"
	| `the ${Exclude<Shape, "drawn">}`
	| "a fact dropped beside a READ COMMITTED role"
	| "a dropped fact a SERIALIZABLE role's level rests on alone"

const conditions: ReadonlyArray<IsolationCondition> = [
	"members",
	"privileges",
	"laws",
	"absence",
	"snapshot",
	"pivot",
	"writers"
]

/** Every condition a reason names, `facts` included, which no drawn installation fails. */
const everyCondition: ReadonlyArray<IsolationCondition> = ["facts", ...conditions]

const shapes: ReadonlyArray<Exclude<Shape, "drawn">> = [
	"copiers",
	"pointCopiers",
	"absentThenInsert",
	"chain",
	"seals",
	"pivotWriter",
	"triggered"
]

const levelsOf = (verdicts: ReadonlyArray<RoleIsolation>) =>
	Arr.map(verdicts, (v) => v.certificate.level)

const sealFeature = (seal: ReadSeal): IsolationFeature | undefined => {
	switch (seal.kind) {
		case "counted":
			return "a counted group read"
		case "point":
			return "a point read"
		case "unwritten":
			return "a read of a relation no role writes"
		case "arbiter":
			return "an arbitration a unique check decides"
		case "own":
		case "unsealed":
			return undefined
	}
}

/** The roles a counterexample must leave SERIALIZABLE. */
const counterexampleRoles = (shape: Shape): ReadonlyArray<number> => {
	switch (shape) {
		case "copiers":
		case "pointCopiers":
			return [0, 1]
		case "absentThenInsert":
			return [2]
		case "chain":
			return [1, 2]
		case "pivotWriter":
			return [1]
		case "drawn":
		case "seals":
		case "triggered":
			return []
	}
}

describe("the isolation certifier", () => {
	it.effect(
		"runs a role READ COMMITTED exactly when every condition proves it, names every condition a SERIALIZABLE role fails, and never relaxes a role for an added capability or a missing fact",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/analysis/isolation",
						draw: drawn(caseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "every condition restated over the drawn facts, the fixpoint as the greatest of every subset"
						},
						coverage: required<IsolationFeature>(
							[
								"a role certified READ COMMITTED",
								...Arr.map(conditions, (c) => `a role SERIALIZABLE by ${c}` as const),
								"a role SERIALIZABLE only through roles that run SERIALIZABLE",
								"a counted group read",
								"a point read",
								"a read of a relation no role writes",
								"an arbitration a unique check decides",
								"an arbitration of no whole declared key",
								"a first change member given to a role with none",
								...Arr.map(shapes, (s) => `the ${s}` as const),
								"a fact dropped beside a READ COMMITTED role",
								"a dropped fact a SERIALIZABLE role's level rests on alone"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const input = inputOf(c.sketch)
							const verdicts = certify(input)
							const expected = oracle(c.sketch)
							for (const [i, v] of verdicts.entries()) {
								const o = Arr.getUnsafe(expected, i)
								assert.equal(
									v.certificate.level,
									o.readCommitted ? "readCommitted" : "serializable",
									`${v.role}'s level`
								)
								if (v.certificate.level === "serializable") {
									const named = new Set(Arr.map(v.certificate.reasons, (r) => r.condition))
									assert.deepEqual(
										Arr.filter(everyCondition, (x) => named.has(x)),
										Arr.filter(everyCondition, (x) => o.failed.has(x)),
										`${v.role} names exactly the conditions it fails`
									)
									for (const r of named) {
										k.note(`a role SERIALIZABLE by ${r}`)
									}
									if (o.own.size === 0) {
										k.note("a role SERIALIZABLE only through roles that run SERIALIZABLE")
									}
								} else {
									k.note("a role certified READ COMMITTED")
									const role = Arr.getUnsafe(c.sketch.roles, i)
									for (const statements of role.members) {
										for (const st of statements) {
											for (const read of st.reads) {
												const feature = sealFeature(readSeal(input, readFact(read)))
												if (feature !== undefined) {
													k.note(feature)
												}
											}
										}
									}
								}
							}
							if (c.shape !== "drawn") {
								k.note(`the ${c.shape}`)
							}
							for (const i of counterexampleRoles(c.shape)) {
								assert.equal(
									Arr.getUnsafe(levelsOf(verdicts), i),
									"serializable",
									`the ${c.shape}'s role r${i} runs SERIALIZABLE`
								)
							}
							for (const role of c.sketch.roles) {
								for (const statements of role.members) {
									for (const st of statements) {
										for (const read of st.reads) {
											if (
												read.mode === "arbiter" &&
												readSeal(input, readFact(read)).kind === "unsealed"
											) {
												k.note("an arbitration of no whole declared key")
											}
										}
									}
								}
							}
							const first = givesFirstMember(c.sketch, c.extension)
							if (first) {
								k.note("a first change member given to a role with none")
							}
							const after = levelsOf(certify(afterOf(c)))
							for (const [i, level] of levelsOf(verdicts).entries()) {
								if (level === "serializable" && !first) {
									assert.equal(
										Arr.getUnsafe(after, i),
										"serializable",
										`r${i} stays SERIALIZABLE once ${c.extension.kind} is applied`
									)
								}
							}
							const e = c.extension
							if (e.kind === "dropFact") {
								if (Arr.some(levelsOf(verdicts), (l) => l === "readCommitted")) {
									k.note("a fact dropped beside a READ COMMITTED role")
								}
								const lifted = oracle(
									withRelation(c.sketch, e.relation, (r) => ({ ...r, triggerLaws: false }))
								)
								if (
									Arr.some(
										lifted,
										(o, i) =>
											o.readCommitted && Arr.getUnsafe(levelsOf(verdicts), i) === "serializable"
									)
								) {
									k.note("a dropped fact a SERIALIZABLE role's level rests on alone")
								}
							}
						})
				)
			)
	)
})
