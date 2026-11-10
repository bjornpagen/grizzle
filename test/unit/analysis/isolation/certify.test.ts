/**
 * The isolation certifier (analysis/isolation/certify.ts) over drawn installations: two logins' roles over up to four
 * relations, each relation's laws native or not and read by a rule over a query or not, each role's privileges, and its
 * change members' statements, each writing relations, by insert, update or delete, with some keys fresh, and reading
 * relations positively, negated or counted, its own rows or not, by one key's group or not, into its writes or only
 * back to the caller. Some draws are the owner's two counterexamples: two copiers, each inserting into one relation and
 * copying the other's, and a writer that reads another's absence beside a reader of both.
 *
 * The oracle restates the five conditions over the drawn facts, apart from the certifier's code: each role's own
 * conditions, then, of the roles that meet them, the greatest set every member of which no change member of a role
 * outside it reads the writes of, found by trying every subset. Every role's level is the oracle's, and every
 * SERIALIZABLE role names exactly the conditions the oracle finds it failing against the final levels. Adding a
 * capability, a privilege, a read, a statement, a member, a role, an insert with no fresh key, a law that is not
 * native or a rule's read, never makes a SERIALIZABLE role READ COMMITTED. Both counterexamples always come out
 * SERIALIZABLE.
 *
 * Planted in a scratch copy, each of these fails the search: condition 2's SERIALIZABLE readers left out; the
 * fixpoint run once instead of to the end; a later statement's read of an updated relation let through; and a read by
 * a group whose relation an insert leaves stale admitted as sealed.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, shuffled, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	certify,
	type IsolationCondition,
	type RoleIsolation,
	readSeal
} from "#compiler/analysis/isolation/certify.ts"
import type { IsolationInput, Privilege, RoleFacts } from "#compiler/analysis/isolation/facts.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

const RELATIONS = 4
const KEYS: ReadonlyArray<ReadonlyArray<string>> = [["k0"], ["k1"]]

interface WriteSketch {
	readonly relation: number
	readonly op: "insert" | "update" | "delete"
	readonly fresh: ReadonlyArray<number>
}

interface ReadSketch {
	readonly relation: number
	readonly mode: "positive" | "negated" | "counted" | "arbiter"
	readonly own: boolean
	readonly group: number | undefined
	readonly feeds: "write" | "readBack"
}

interface StatementSketch {
	readonly writes: ReadonlyArray<WriteSketch>
	readonly reads: ReadonlyArray<ReadSketch>
}

interface RoleSketch {
	readonly login: number
	readonly privileges: ReadonlyArray<{ readonly relation: number; readonly privilege: Privilege }>
	readonly members: ReadonlyArray<ReadonlyArray<StatementSketch>>
}

interface RelationSketch {
	readonly nativeLaws: boolean
	readonly ruleRead: boolean
	readonly counted: ReadonlyArray<number>
}

interface Sketch {
	readonly relations: ReadonlyArray<RelationSketch>
	readonly roles: ReadonlyArray<RoleSketch>
}

/** One capability added to an installation. */
type Extension =
	| {
			readonly kind: "privilege"
			readonly role: number
			readonly relation: number
			readonly privilege: Privilege
	  }
	| { readonly kind: "read"; readonly role: number; readonly read: ReadSketch }
	| { readonly kind: "statement"; readonly role: number; readonly statement: StatementSketch }
	| {
			readonly kind: "member"
			readonly role: number
			readonly member: ReadonlyArray<StatementSketch>
	  }
	| { readonly kind: "role"; readonly role: RoleSketch }
	| { readonly kind: "staleInsert"; readonly role: number; readonly relation: number }
	| { readonly kind: "lawNotNative"; readonly relation: number }
	| { readonly kind: "ruleRead"; readonly relation: number }

/** A drawn installation, which may be one of the owner's counterexamples, and a capability to add to it. */
interface Case {
	readonly sketch: Sketch
	readonly shape: "drawn" | "copiers" | "absentThenInsert" | "chain"
	readonly extension: Extension
}

const relationGen: Gen<number> = int(0, RELATIONS - 1)
const privilegeGen: Gen<Privilege> = weighted<Privilege>([
	[4, () => "SELECT"],
	[4, () => "INSERT"],
	[1, () => "UPDATE"],
	[1, () => "DELETE"]
])

const writeGen: Gen<WriteSketch> = (s) => ({
	relation: s.draw(relationGen),
	op: s.draw(
		weighted<WriteSketch["op"]>([
			[6, () => "insert"],
			[1, () => "update"],
			[1, () => "delete"]
		])
	),
	fresh: s.draw(
		weighted<ReadonlyArray<number>>([
			[3, () => [0]],
			[1, () => [1]],
			[1, () => [0, 1]],
			[1, () => []]
		])
	)
})

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
			[1, () => undefined]
		])
	),
	feeds: s.draw(element<ReadSketch["feeds"]>(["write", "readBack"]))
})

const statementGen: Gen<StatementSketch> = (s) => ({
	writes: s.draw(array(writeGen, { min: 0, max: 2 })),
	reads: s.draw(array(readGen, { min: 0, max: 2 }))
})

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
	nativeLaws: s.draw(
		weighted<boolean>([
			[5, () => true],
			[1, () => false]
		])
	),
	ruleRead: s.draw(
		weighted<boolean>([
			[1, () => true],
			[5, () => false]
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

const insertOf = (relation: number, fresh: ReadonlyArray<number>): WriteSketch => ({
	relation,
	op: "insert",
	fresh
})

const readOf = (
	relation: number,
	mode: ReadSketch["mode"],
	group: number | undefined
): ReadSketch => ({ relation, mode, own: false, group, feeds: "write" })

/**
 * The first counterexample: m1 inserts A(v) and copies B into P, m2 inserts B(v) and copies A into Q, each its own
 * role holding INSERT and SELECT on all four relations, every law native.
 */
const copiers: Sketch = {
	relations: Arr.makeBy(RELATIONS, () => ({ nativeLaws: true, ruleRead: false, counted: [] })),
	roles: Arr.map([0, 1], (i): RoleSketch => ({
		login: i,
		privileges: Arr.flatMap([0, 1, 2, 3], (relation) => [
			{ relation, privilege: "SELECT" },
			{ relation, privilege: "INSERT" }
		]),
		members: [
			[
				{ writes: [insertOf(i, [])], reads: [] },
				{ writes: [insertOf(2 + i, [])], reads: [readOf(1 - i, "positive", undefined)] }
			]
		]
	}))
}

/**
 * The second counterexample: T1 reads B(k)'s absence and inserts A(k), T2 inserts B(k), and a third role's member reads
 * A(k) and B(k) and writes what it read.
 */
const absentThenInsert: Sketch = {
	relations: Arr.makeBy(RELATIONS, () => ({ nativeLaws: true, ruleRead: false, counted: [] })),
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
						writes: [insertOf(2, [])],
						reads: [readOf(0, "positive", 0), readOf(1, "positive", 0)]
					}
				]
			]
		}
	]
}

/**
 * A chain of readers: r0 updates a relation, so it runs SERIALIZABLE on its own, and reads what r1 writes; r1 reads a
 * sealed group of what r2 writes. r1 runs SERIALIZABLE for r0's read, and r2 for r1's, two steps from any failure of
 * their own. The three relations and the logins are drawn.
 */
const chainGen: Gen<Sketch> = (s) => {
	const [a = 0, b = 1, c = 2] = s.draw(shuffled([0, 1, 2, 3], { min: 3, max: 3 }))
	return {
		relations: Arr.makeBy(RELATIONS, () => ({ nativeLaws: true, ruleRead: false, counted: [] })),
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
				members: [[{ writes: [insertOf(b, [0])], reads: [] }]]
			}
		]
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
					(t) => ({ kind: "member", role, member: t.draw(array(statementGen, { min: 1, max: 2 })) })
				],
				[1, (t) => ({ kind: "role", role: t.draw(roleGen) })],
				[1, (t) => ({ kind: "staleInsert", role, relation: t.draw(relationGen) })],
				[1, (t) => ({ kind: "lawNotNative", relation: t.draw(relationGen) })],
				[1, (t) => ({ kind: "ruleRead", relation: t.draw(relationGen) })]
			])
		)
	}

const caseGen: Gen<Case> = (s) => {
	const shape = s.draw(
		weighted<Case["shape"]>([
			[8, () => "drawn"],
			[1, () => "copiers"],
			[1, () => "absentThenInsert"],
			[1, () => "chain"]
		])
	)
	const sketch =
		shape === "copiers"
			? copiers
			: shape === "absentThenInsert"
				? absentThenInsert
				: shape === "chain"
					? s.draw(chainGen)
					: s.draw(sketchGen)
	return { sketch, shape, extension: s.draw(extensionGen(sketch)) }
}

const relationName = (i: number): string => `R${i}`
const keyOf = (i: number): ReadonlyArray<string> => Arr.getUnsafe(KEYS, i)

/** The facts a sketch states, as the certifier reads them. */
const inputOf = (sketch: Sketch): IsolationInput => ({
	relations: new Map(
		Arr.map(sketch.relations, (r, i) => [
			relationName(i),
			{ nativeLaws: r.nativeLaws, ruleRead: r.ruleRead, countedGroups: Arr.map(r.counted, keyOf) }
		])
	),
	roles: Arr.map(sketch.roles, (role, i): RoleFacts => {
		const privileges = new Map<string, Set<Privilege>>()
		for (const p of role.privileges) {
			const held = privileges.get(relationName(p.relation)) ?? new Set<Privilege>()
			held.add(p.privilege)
			privileges.set(relationName(p.relation), held)
		}
		return {
			login: `L${role.login}`,
			role: `r${i}`,
			privileges,
			members: Arr.map(role.members, (statements, m) => ({
				name: `m${m}`,
				statements: Arr.map(statements, (st) => ({
					writes: Arr.map(st.writes, (w) => ({
						relation: relationName(w.relation),
						op: w.op,
						fresh: Arr.map(w.fresh, keyOf)
					})),
					reads: Arr.map(st.reads, (r) => ({
						relation: relationName(r.relation),
						mode: r.mode,
						own: r.own,
						group: r.group === undefined ? undefined : keyOf(r.group),
						feeds: r.feeds
					}))
				}))
			}))
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

/** The sketch with one capability added. */
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
		case "staleInsert":
			return withRole(sketch, e.role, (r) => ({
				...r,
				members: [...r.members, [{ writes: [insertOf(e.relation, [])], reads: [] }]]
			}))
		case "lawNotNative":
			return withRelation(sketch, e.relation, (r) => ({ ...r, nativeLaws: false }))
		case "ruleRead":
			return withRelation(sketch, e.relation, (r) => ({ ...r, ruleRead: true }))
	}
}

/** Every read of a role's members, each with its statement's place in its member's flight. */
const readsOfRole = (role: RoleSketch) =>
	Arr.flatMap(role.members, (statements) =>
		Arr.flatMap(statements, (st, index) => Arr.map(st.reads, (read) => ({ read, index })))
	)

const writesOfRole = (role: RoleSketch) =>
	Arr.flatMap(role.members, (statements) => Arr.flatMap(statements, (st) => st.writes))

/** The relations a role writes, by its privileges and its members' writes. */
const writtenSet = (role: RoleSketch): ReadonlySet<number> =>
	new Set([
		...Arr.flatMap(role.privileges, (p) => (p.privilege === "SELECT" ? [] : [p.relation])),
		...Arr.map(writesOfRole(role), (w) => w.relation)
	])

/**
 * The oracle: each condition stated over the sketch on its own, and the levels as the greatest set of roles that meet
 * their own conditions every member of which no member of a role outside the set reads the writes of.
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
	const sealed = (relation: number, key: number) =>
		!changes(relation) &&
		(Arr.every(roles, (r) =>
			Arr.every(
				writesOfRole(r),
				(w) => w.relation !== relation || w.op !== "insert" || w.fresh.includes(key)
			)
		) ||
			Arr.getUnsafe(sketch.relations, relation).counted.includes(key))
	const own = (role: RoleSketch): ReadonlySet<IsolationCondition> => {
		const failed = new Set<IsolationCondition>()
		if (Arr.some(role.privileges, (p) => p.privilege === "UPDATE" || p.privilege === "DELETE")) {
			failed.add("privileges")
		}
		const written = writtenSet(role)
		for (const relation of written) {
			const facts = Arr.getUnsafe(sketch.relations, relation)
			if (!facts.nativeLaws || facts.ruleRead) {
				failed.add("laws")
			}
			if (
				Arr.some(roles, (r) =>
					Arr.some(
						readsOfRole(r),
						({ read }) =>
							read.relation === relation && (read.mode === "negated" || read.mode === "counted")
					)
				)
			) {
				failed.add("absence")
			}
		}
		for (const { read, index } of readsOfRole(role)) {
			if (read.mode === "arbiter") {
				continue
			}
			if (index > 0 && !read.own && changes(read.relation)) {
				failed.add("statements")
			}
			if (!read.own && anyWrites(read.relation)) {
				const groupSealed = read.group !== undefined && sealed(read.relation, read.group)
				if (!groupSealed || (read.feeds === "write" && read.mode !== "positive")) {
					failed.add("sealed")
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
	const readers = (outside: ReadonlySet<number>, i: number) =>
		Arr.some([...outside], (o) =>
			Arr.some(readsOfRole(Arr.getUnsafe(roles, o)), ({ read }) =>
				writtenSet(Arr.getUnsafe(roles, i)).has(read.relation)
			)
		)
	const all = new Set(Arr.map(roles, (_, i) => i))
	let best = new Set<number>()
	for (let mask = 0; mask < 1 << candidates.length; mask += 1) {
		const set = new Set(Arr.filter(candidates, (_, b) => (mask & (1 << b)) !== 0))
		const outside = new Set(Arr.filter([...all], (i) => !set.has(i)))
		if (Arr.every([...set], (i) => !readers(outside, i))) {
			best = new Set([...best, ...set])
		}
	}
	const outside = new Set(Arr.filter([...all], (i) => !best.has(i)))
	const throughReaders = (i: number): boolean =>
		Arr.getUnsafe(owns, i).size === 0 && readers(outside, i)
	return Arr.map(roles, (_, i) => {
		const failed = new Set(Arr.getUnsafe(owns, i))
		if (failed.size === 0 && readers(outside, i)) {
			failed.add("laws")
		}
		const chained =
			throughReaders(i) &&
			Arr.every(
				[...outside],
				(o) =>
					!Arr.some(readsOfRole(Arr.getUnsafe(roles, o)), ({ read }) =>
						writtenSet(Arr.getUnsafe(roles, i)).has(read.relation)
					) || throughReaders(o)
			)
		return { readCommitted: best.has(i), failed, own: Arr.getUnsafe(owns, i), chained }
	})
}

type IsolationFeature =
	| "a role certified READ COMMITTED"
	| `a role SERIALIZABLE by ${IsolationCondition}`
	| "a role SERIALIZABLE only through a SERIALIZABLE reader"
	| "a role SERIALIZABLE only through readers SERIALIZABLE only through readers"
	| "a sealed group read"
	| "a counted group read"
	| "a read of a relation no role writes"
	| "the copiers"
	| "the absent-then-insert"
	| "a capability added"

const conditions: ReadonlyArray<IsolationCondition> = [
	"privileges",
	"laws",
	"absence",
	"statements",
	"sealed"
]

const levelsOf = (verdicts: ReadonlyArray<RoleIsolation>) =>
	Arr.map(verdicts, (v) => v.certificate.level)

describe("the isolation certifier", () => {
	it.effect(
		"runs a role READ COMMITTED exactly when the five conditions prove it, names every condition a SERIALIZABLE role fails, and never relaxes a role for an added capability",
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
							name: "the five conditions restated over the drawn facts, the fixpoint as the greatest of every subset"
						},
						coverage: required<IsolationFeature>(
							[
								"a role certified READ COMMITTED",
								...Arr.map(conditions, (c) => `a role SERIALIZABLE by ${c}` as const),
								"a role SERIALIZABLE only through a SERIALIZABLE reader",
								"a role SERIALIZABLE only through readers SERIALIZABLE only through readers",
								"a sealed group read",
								"a counted group read",
								"a read of a relation no role writes",
								"the copiers",
								"the absent-then-insert",
								"a capability added"
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
										Arr.filter(conditions, (x) => named.has(x)),
										Arr.filter(conditions, (x) => o.failed.has(x)),
										`${v.role} names exactly the conditions it fails`
									)
									for (const r of named) {
										k.note(`a role SERIALIZABLE by ${r}`)
									}
									if (o.own.size === 0) {
										k.note("a role SERIALIZABLE only through a SERIALIZABLE reader")
									}
									if (o.chained) {
										k.note(
											"a role SERIALIZABLE only through readers SERIALIZABLE only through readers"
										)
									}
								} else {
									k.note("a role certified READ COMMITTED")
									const role = Arr.getUnsafe(c.sketch.roles, i)
									for (const { read } of readsOfRole(role)) {
										if (!read.own && read.mode !== "arbiter") {
											const seal = readSeal(input, {
												relation: relationName(read.relation),
												mode: read.mode,
												own: read.own,
												group: read.group === undefined ? undefined : keyOf(read.group),
												feeds: read.feeds
											})
											k.note(
												seal.kind === "unwritten"
													? "a read of a relation no role writes"
													: seal.kind === "counted"
														? "a counted group read"
														: "a sealed group read"
											)
										}
									}
								}
							}
							if (c.shape === "copiers" || c.shape === "absentThenInsert") {
								k.note(c.shape === "copiers" ? "the copiers" : "the absent-then-insert")
								const involved = c.shape === "copiers" ? [0, 1] : [2]
								for (const i of involved) {
									assert.equal(
										Arr.getUnsafe(levelsOf(verdicts), i),
										"serializable",
										`the counterexample's role r${i} runs SERIALIZABLE`
									)
								}
							}
							const after = levelsOf(certify(inputOf(extended(c.sketch, c.extension))))
							for (const [i, level] of levelsOf(verdicts).entries()) {
								if (level === "serializable") {
									assert.equal(
										Arr.getUnsafe(after, i),
										"serializable",
										`r${i} stays SERIALIZABLE once ${c.extension.kind} is added`
									)
								}
							}
							k.note("a capability added")
						})
				)
			)
	)
})
