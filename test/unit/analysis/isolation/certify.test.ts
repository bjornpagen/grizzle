/**
 * The isolation certifier (analysis/isolation/certify.ts) over drawn installations: two logins' roles over four
 * relations, each relation with trigger-held laws or not, declared keys, its first raced or not, counted groups and
 * foreign keys (immediate or deferred alike, an update cascading or not), each role's privileges, and its change members'
 * statements, each reading relations, positively, negated, counted or as grizzle's key arbitration, its own rows or not,
 * by a group whose fields are bound to one value or to one per own row, k0 and k1 to one parameter or each to its own,
 * or none, and writing relations, by insert, update, delete or a retirement, which changes none of them, with each
 * written row joined with some of its statement's reads; its members as served at READ COMMITTED, and those of its SERIALIZABLE
 * form, which certification lowers it to once a round leaves it SERIALIZABLE. Some draws are counterexamples: two copiers, each inserting
 * into one relation and then copying the other's (by a scan, or at a whole key); a writer reading another's absence
 * beside a reader of both; a chain of SERIALIZABLE readers; a SERIALIZABLE pivot writing what an RC member reads
 * unsealed; a write after an outside read joined with no row of its call; an insert into a relation an update cascades
 * to; an inserter beside a SERIALIZABLE role that may insert too, whose guard would refuse its every write; and
 * NEGATION's four histories no serial order in real time explains, each reproduced on PostgreSQL: a reader of one point
 * group lagging an in-flight SERIALIZABLE pivot, a reader of one group per own row, a copy whose foreign key check
 * misses that pivot's row, and a copy over many own rows whose deferred check reads at COMMIT; a referencer whose check
 * reads a relation a role updates (updatedCheck, updatedDeleter), or one whose writer of the referenced relation may
 * miss a write and fences nothing (unfencedPivot). Others are READ COMMITTED, the deleting login fencing the relation:
 * a referencer of a relation deleted from another login than the one that inserts it, by a privilege (heldCheck) or a
 * member (fencedDeleter), or deleted and inserted by one login (fencedCheck), edullm's publisher among them, which
 * replaces it in one member after an outside read (fencedPublisher). LEASE's race shapes: a
 * read of a race's winner that binds the raced key as its arbitration did and another field besides, arbitrated and
 * READ COMMITTED; the same read at another value of the key or of a part of it, and a raced relation's read at another
 * key its insertion was probed at, each a pivot; and that read where the relation is not raced, whose probed key is fixed too.
 *
 * A retirement counts among its own role's writes, whose laws and guard it meets, and among no other role's judgement of
 * it: no co-writer's guard and no pivot's write of what another reads (physical/ddl/retire.ts, the hold).
 *
 * The oracle restates every condition over the drawn facts, apart from the certifier's code, in rounds from none
 * lowered: each judged role's own conditions over its READ COMMITTED members, its foreign key checks among its reads,
 * a referencing check sealed where it binds a whole declared key of a relation no role updates (an insert-only one's,
 * a held one's and a fenced one's alike, fenced where one login's roles both delete and insert it), a fenced write's
 * check of the rows that reference a row it deletes no site of conditions 2 and 3, and a writer whose login fences a
 * relation no writer 5c weighs against a role that reads it from outside by fenced checks alone; then, of the judged roles that meet them, the greatest set none of whose members a role outside it gives a reason,
 * found by trying every subset, where whatever a lowered role's members read or write, conditions 2, 3 and 5c included,
 * is read from both its forms; each round lowers the judged roles it leaves SERIALIZABLE, with its conditions, until one
 * lowers none. Every role's level is the oracle's, the fences are exactly those of the relations the roles it leaves
 * READ COMMITTED check by fenced checks, one per login that fences each, and every SERIALIZABLE role names exactly the
 * conditions of the round
 * that lowered it, each of which it still fails at the fixpoint; a role with no change member is SERIALIZABLE by the
 * members condition. Every role's certificate is the same with its own SERIALIZABLE form dropped: that form is served
 * only once the role runs SERIALIZABLE, so it never judges the role. Adding a capability (a privilege, a read, a
 * statement, a member, a member of a SERIALIZABLE form, a role, an insert with no insert, a trigger-held law, a foreign
 * key, a race over a relation's first key) never makes a SERIALIZABLE role READ COMMITTED, nor does removing a relation's fact, but for the first change
 * member of a role with none, which the members condition alone held. Every counterexample comes out SERIALIZABLE.
 *
 * Planted in a scratch copy, each of these fails the search: condition 2's SERIALIZABLE readers left out; the fixpoint
 * run once; a pivot's write before a group read only later let through; a pivot's write after an outside read joined
 * with no row of its call let through; an unsealed read sharing a member with an outside read in another statement let
 * through; condition 5c left out; a read binding part of a declared key sealed as a point; a role with no change member
 * certified; an arbitration of no whole key sealed; an arbitration of a relation a role deletes sealed; a relation
 * another role deletes written READ COMMITTED; 5c's exemption of sealed reads restored; a read of one group per own row
 * sealed; foreign key checks left out of 5c; the checks of rows that reference a changed one left out; a cascading
 * update left out of the writers; a relation with no fact read as having no foreign key (the droppedReference shape); a
 * relation a SERIALIZABLE role writes too written READ COMMITTED; an unsealed read beneath a neutral probe; a probe
 * neutral with no positive read of its group, with a gated write no read of it joins (the unjoinedGate shape), or with
 * no row path from its core (the fallbacks), one through a read beneath other probes (the chainedPath shape), of
 * another group or no positive one (the arbiterPath shape), through one UNION arm alone (the unions at another key,
 * another relation or the recursion's own rows), through no UNION or no core at all; and the arbitrated read without
 * its clean prefix; a SERIALIZABLE writer's sealed foreign key checks counted as a pivot cause; that exemption extended
 * to a role's own checks, the publication's publisher certified READ COMMITTED; a SERIALIZABLE form left out of a
 * role's judging (the served cause), of the relations' writers (the served update) or of the absence sites (the served
 * absence); a lowered role judged again over both its forms, its own lowering's absence named in place of the reasons
 * that lowered it (the lowered absence, edullm's folded publisher); and a lowered role's certificate read from the last
 * round, over its READ COMMITTED form alone, where another role's lowering gives it an absence of its own (the lowered
 * cause); a check of a relation a role updates sealed (the updatedCheck shape); a fenced check relied on with no fence
 * stated (the fencedCheck shape); every check of referencing rows a fenced site (updatedDeleter); 5c sparing a writer
 * whose login fences nothing (unfencedPivot); and 5c leaving out every sealed foreign key check, edullm's G3 (b), which
 * NEGATION's case 3 refutes (the refusedCopy and publication shapes).
 *
 * Plants (~/.cache/grizzle-release/BR03/plants), two of those as patches: certify-memberless-role-certified (a role
 * with no change member certified) and certify-fixpoint-once (the fixpoint over the roles a SERIALIZABLE role gives a
 * reason run once). Plants (~/.cache/grizzle-release/CERTIFY/plants): certify-own-lowering-self-included and
 * certify-lowering-cause-dropped, the last two. Plants (~/.cache/grizzle-release/CERTDEL/plants): the last five,
 * certify-held-ignores-updates, certify-fence-dropped, certify-fenced-site-unfenced, certify-5c-spares-unfenced and
 * certify-5c-skips-sealed-checks. Plants (~/.cache/grizzle-release/LEASE/plants), each failing the search:
 * certify-key-match-by-relation (a read of an arbitrated relation at any bindings arbitrated), certify-key-match-no-
 * clean-prefix (a key-matched read arbitrated after an outside read), certify-key-match-part-of-key (a read matching
 * the first field of an arbitrated key alone arbitrated), certify-race-other-key-fixed (a raced relation's arbitration
 * at another key fixing its row) and certify-key-match-exact-group (a key-matched read with a binding besides the key
 * left a point read, the old exact-group rule).
 *
 * Features: each condition failed and met, each counterexample shape, each level, each capability added or fact
 * removed, a role lowered in a later round, a role whose lowered form alone reads the absence of what it writes, a held
 * check beside a READ COMMITTED role, a check of a relation one login deletes and inserts, and a fence a READ COMMITTED
 * role relies on (the required situations of the search).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, type Gen, int, shuffled, subset, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import type { Source } from "@grizzle/testing/source"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import {
	type Candidate,
	certify,
	type Fence,
	type IsolationCondition,
	isolationOf,
	type ReadSeal,
	type RoleIsolation,
	readSeal
} from "#compiler/analysis/isolation/certify.ts"
import type {
	InsertsFact,
	IsolationInput,
	MemberFacts,
	ReadFact,
	RoleFacts,
	RowSource
} from "#compiler/analysis/isolation/facts.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"
import * as Result from "#compiler/core/result.ts"
import { assert, defined } from "#test/support/assert.ts"
import { wild } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { upTo } from "#test/support/up-to.ts"

const RELATIONS = 4
const KEYS: ReadonlyArray<Arr.NonEmptyReadonlyArray<string>> = [["k0"], ["k1"], ["k0", "k1"]]

interface WriteSketch {
	readonly relation: number
	readonly op: "insert" | "update" | "delete" | "retire"
	readonly from: ReadonlyArray<number>
}

interface ReadSketch {
	readonly relation: number
	readonly mode: "positive" | "negated" | "counted" | "arbiter"
	readonly own: boolean
	readonly group: number | undefined
	/** What k0 is bound to, `$p<binding>`, and k1 too unless `split`, where k1 is bound to the other parameter. */
	readonly binding: number
	readonly split: boolean
	readonly rows: "one" | "many"
	/** The probes of its statement it stands beneath, by place; its mode composes them over its base. */
	readonly probes: ReadonlyArray<number>
}

/** A probe of a statement: the writes it gates, the core whose rows it filters, if any, and the probes a read on them
 * stands beneath. */
interface ProbeSketch {
	readonly gates: ReadonlyArray<number>
	readonly core: number | undefined
	readonly chain: ReadonlyArray<number>
}

/** A statement: its writes, its reads, its probes, and each of its cores' row sources by number (StatementFacts.cores). */
interface StatementSketch {
	readonly writes: ReadonlyArray<WriteSketch>
	readonly reads: ReadonlyArray<ReadSketch>
	readonly probes: ReadonlyArray<ProbeSketch>
	readonly cores: ReadonlyArray<ReadonlyArray<RowSource>>
}

/** A role: its login, its privileges, and its change members as served at READ COMMITTED and at SERIALIZABLE. */
interface RoleSketch {
	readonly login: number
	readonly privileges: ReadonlyArray<{
		readonly relation: number
		readonly privilege: TablePrivilege
	}>
	readonly members: ReadonlyArray<ReadonlyArray<StatementSketch>>
	readonly serializable: ReadonlyArray<ReadonlyArray<StatementSketch>>
}

/** A foreign key: the relation it references, the referenced key among KEYS, and its update action. */
interface ReferenceSketch {
	readonly relation: number
	readonly key: number
	readonly onUpdate: "cascade" | "noAction"
}

/** A relation: its trigger-held laws, its declared keys among KEYS, its counted groups and foreign keys, and whether
 * its first key is raced (InsertsFact `race`), which only a relation with a key is. */
interface RelationSketch {
	readonly triggerLaws: boolean
	readonly keys: ReadonlyArray<number>
	readonly race: boolean
	readonly counted: ReadonlyArray<number>
	readonly references: ReadonlyArray<ReferenceSketch>
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
			readonly kind: "member" | "served"
			readonly role: number
			readonly member: ReadonlyArray<StatementSketch>
	  }
	| { readonly kind: "role"; readonly role: RoleSketch }
	| { readonly kind: "insert"; readonly role: number; readonly relation: number }
	| { readonly kind: "triggerLaw"; readonly relation: number }
	| { readonly kind: "reference"; readonly relation: number; readonly reference: ReferenceSketch }
	| { readonly kind: "dropFact"; readonly relation: number }
	| { readonly kind: "race"; readonly relation: number }

type Shape =
	| "drawn"
	| "copiers"
	| "pointCopiers"
	| "absentThenInsert"
	| "chain"
	| "seals"
	| "pivotWriter"
	| "laggingReader"
	| "listReader"
	| "refusedCopy"
	| "deferredCopy"
	| "lateWriter"
	| "cascadedWriter"
	| "sharedWriter"
	| "protocolSealed"
	| "protocolUnsealed"
	| "absentGate"
	| "arbitratedRead"
	| "arbitratedGated"
	| "keyMatched"
	| "keyUnmatched"
	| "keyPartial"
	| "raceOtherKey"
	| "repeatableOtherKey"
	| "fallbackUnion"
	| "fallbackCount"
	| "unjoinedGate"
	| "chainedPath"
	| "unionSealed"
	| "unionOtherKey"
	| "unionOtherRelation"
	| "unionRecursion"
	| "arbiterPath"
	| "publication"
	| "servedCause"
	| "servedUpdate"
	| "servedAbsence"
	| "servedOwn"
	| "loweredAbsence"
	| "loweredCause"
	| "triggered"
	| "droppedReference"
	| "heldCheck"
	| "fencedCheck"
	| "updatedCheck"
	| "fencedPublisher"
	| "unfencedPivot"
	| "fencedDeleter"
	| "updatedDeleter"

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

/** A read of a statement of `probes` probes: a negated or counted one beneath some of them, or none. */
const readGenOf =
	(probes: number): Gen<ReadSketch> =>
	(s) => {
		const mode = s.draw(
			weighted<ReadSketch["mode"]>([
				[6, () => "positive"],
				[1, () => "negated"],
				[1, () => "counted"],
				[1, () => "arbiter"]
			])
		)
		return {
			...s.draw(readBodyGen),
			mode,
			probes:
				mode === "negated" || mode === "counted"
					? s.draw(
							subset(
								upTo(probes, (i) => i),
								{ min: 0, max: probes }
							)
						)
					: []
		}
	}

const readGen: Gen<ReadSketch> = readGenOf(0)

const readBodyGen: Gen<Omit<ReadSketch, "mode" | "probes">> = (s) => ({
	relation: s.draw(relationGen),
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
	binding: s.draw(int(0, 1)),
	split: s.draw(
		weighted<boolean>([
			[1, () => true],
			[3, () => false]
		])
	),
	rows: s.draw(
		weighted<ReadSketch["rows"]>([
			[3, () => "one"],
			[1, () => "many"]
		])
	)
})

const writeGen =
	(reads: number): Gen<WriteSketch> =>
	(s) => ({
		relation: s.draw(relationGen),
		op: s.draw(
			weighted<WriteSketch["op"]>([
				[6, () => "insert"],
				[1, () => "update"],
				[1, () => "delete"],
				[1, () => "retire"]
			])
		),
		from: s.draw(
			subset(
				upTo(reads, (i) => i),
				{ min: 0, max: reads }
			)
		)
	})

/** The cores a drawn statement holds, core 0 its outermost. */
const CORES = 3

/**
 * The row sources of a statement's core `core` of `reads` reads: some of them, a later core, and, `depth` above none,
 * a UNION of two arms drawn alike, so every core refers to later ones alone.
 */
const sourcesGen =
	(reads: number, core: number, depth: number): Gen<ReadonlyArray<RowSource>> =>
	(s) => [
		...Arr.map(
			s.draw(
				subset(
					upTo(reads, (i) => i),
					{ min: 0, max: reads }
				)
			),
			(read): RowSource => ({ kind: "read", read })
		),
		...(core + 1 < CORES
			? s.draw(
					weighted<ReadonlyArray<RowSource>>([
						[2, () => []],
						[1, (t) => [{ kind: "core", core: t.draw(int(core + 1, CORES - 1)) }]]
					])
				)
			: []),
		...(depth > 0
			? s.draw(
					weighted<ReadonlyArray<RowSource>>([
						[3, () => []],
						[
							1,
							(t) => [
								{
									kind: "union",
									arms: [
										t.draw(sourcesGen(reads, core, depth - 1)),
										t.draw(sourcesGen(reads, core, depth - 1))
									]
								}
							]
						]
					])
				)
			: [])
	]

const statementGen: Gen<StatementSketch> = (s) => {
	const probeCount = s.draw(int(0, 2))
	const reads = s.draw(array(readGenOf(probeCount), { min: 0, max: 2 }))
	const writes = s.draw(array(writeGen(reads.length), { min: 0, max: 2 }))
	return {
		reads,
		writes,
		cores: upTo(CORES, (core) => s.draw(sourcesGen(reads.length, core, 1))),
		probes: upTo(probeCount, (id) => ({
			gates: s.draw(
				subset(
					upTo(writes.length, (i) => i),
					{ min: 0, max: writes.length }
				)
			),
			core: s.draw(
				weighted<number | undefined>([
					[3, () => 0],
					[1, () => 1],
					[1, () => undefined]
				])
			),
			chain: s.draw(
				weighted<ReadonlyArray<number>>([
					[3, () => []],
					[1, () => [id]]
				])
			)
		}))
	}
}

const roleGen: Gen<RoleSketch> = (s) => ({
	login: s.draw(int(0, 1)),
	serializable: s.draw(array(array(statementGen, { min: 1, max: 2 }), { min: 0, max: 1 })),
	privileges: s.draw(
		array((t) => ({ relation: t.draw(relationGen), privilege: t.draw(privilegeGen) }), {
			min: 0,
			max: 3
		})
	),
	members: s.draw(array(array(statementGen, { min: 1, max: 3 }), { min: 0, max: 2 }))
})

const referenceGen: Gen<ReferenceSketch> = (s) => ({
	relation: s.draw(relationGen),
	key: s.draw(int(0, KEYS.length - 1)),
	onUpdate: s.draw(
		weighted<ReferenceSketch["onUpdate"]>([
			[3, () => "noAction"],
			[1, () => "cascade"]
		])
	)
})

const relationSketchGen: Gen<RelationSketch> = (s) => {
	const keys = s.draw(
		weighted<ReadonlyArray<number>>([
			[2, () => [2]],
			[1, () => [0]],
			[1, () => [1]],
			[1, () => [0, 1]],
			[1, () => []]
		])
	)
	return {
		triggerLaws: s.draw(
			weighted<boolean>([
				[1, () => true],
				[5, () => false]
			])
		),
		keys,
		race:
			keys.length > 0 &&
			s.draw(
				weighted<boolean>([
					[1, () => true],
					[3, () => false]
				])
			),
		counted: s.draw(
			weighted<ReadonlyArray<number>>([
				[3, () => []],
				[1, () => [0]],
				[1, () => [1]]
			])
		),
		references: s.draw(
			weighted<ReadonlyArray<ReferenceSketch>>([
				[3, () => []],
				[1, (t) => [t.draw(referenceGen)]]
			])
		)
	}
}

const sketchGen: Gen<Sketch> = (s) => ({
	relations: Arr.makeBy(RELATIONS, () => s.draw(relationSketchGen)),
	roles: s.draw(array(roleGen, { min: 1, max: 4 }))
})

const clean = (keys: ReadonlyArray<number>): RelationSketch => ({
	triggerLaws: false,
	keys,
	race: false,
	counted: [],
	references: []
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
): ReadSketch => ({
	relation,
	mode,
	own: false,
	group,
	binding: 0,
	split: false,
	rows: "one",
	probes: []
})

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
		serializable: [],
		privileges: insertSelectAll,
		members: [
			[
				{ writes: [insertOf(i, [])], reads: [], probes: [], cores: [] },
				{
					writes: [insertOf(2 + i, [0])],
					reads: [readOf(1 - i, "positive", group)],
					probes: [],
					cores: []
				}
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
			serializable: [],
			privileges: [
				{ relation: 0, privilege: "INSERT" },
				{ relation: 1, privilege: "SELECT" }
			],
			members: [
				[{ writes: [insertOf(0, [])], reads: [readOf(1, "negated", 0)], probes: [], cores: [] }]
			]
		},
		{
			login: 0,
			serializable: [],
			privileges: [{ relation: 1, privilege: "INSERT" }],
			members: [[{ writes: [insertOf(1, [])], reads: [], probes: [], cores: [] }]]
		},
		{
			login: 1,
			serializable: [],
			privileges: [
				{ relation: 0, privilege: "SELECT" },
				{ relation: 1, privilege: "SELECT" },
				{ relation: 2, privilege: "INSERT" }
			],
			members: [
				[
					{
						writes: [insertOf(2, [0, 1])],
						reads: [readOf(0, "positive", 0), readOf(1, "positive", 0)],
						probes: [],
						cores: []
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
				serializable: [],
				privileges: [{ relation: c, privilege: "UPDATE" }],
				members: [[{ writes: [], reads: [readOf(a, "positive", 0)], probes: [], cores: [] }]]
			},
			{
				login: s.draw(int(0, 1)),
				serializable: [],
				privileges: [{ relation: a, privilege: "INSERT" }],
				members: [
					[{ writes: [insertOf(a, [0])], reads: [readOf(b, "positive", 0)], probes: [], cores: [] }]
				]
			},
			{
				login: s.draw(int(0, 1)),
				serializable: [],
				privileges: [{ relation: b, privilege: "INSERT" }],
				members: [[{ writes: [insertOf(b, [])], reads: [], probes: [], cores: [] }]]
			}
		]
	}
}

/**
 * r0 inserts into b and c; b's key is (k0, k1) and c's group by k0 is a family's counted members; r1 reads b at its
 * whole key and c by k0 in one statement and inserts into a joined with both, arbitrating a at its whole key, and a's
 * foreign key references b's key: a point read, a counted group read, an arbitration a unique check decides and a
 * sealed foreign key check.
 */
const sealsGen: Gen<Sketch> = (s) => {
	const [a = 0, b = 1, c = 2] = s.draw(shuffled([0, 1, 2, 3], { min: 3, max: 3 }))
	return {
		relations: Arr.makeBy(RELATIONS, (i) => ({
			triggerLaws: false,
			keys: i === b || i === a ? [2] : [],
			race: false,
			counted: i === c ? [0] : [],
			references: i === a ? [{ relation: b, key: 2, onUpdate: "noAction" }] : []
		})),
		roles: [
			{
				login: s.draw(int(0, 1)),
				serializable: [],
				privileges: [
					{ relation: b, privilege: "INSERT" },
					{ relation: c, privilege: "INSERT" }
				],
				members: [
					[
						{
							writes: [insertOf(b, []), insertOf(c, [])],
							reads: [],
							probes: [],
							cores: []
						}
					]
				]
			},
			{
				login: s.draw(int(0, 1)),
				serializable: [],
				privileges: [{ relation: a, privilege: "INSERT" }],
				members: [
					[
						{
							writes: [insertOf(a, [0, 1])],
							reads: [readOf(b, "positive", 2), readOf(c, "positive", 0), readOf(a, "arbiter", 2)],
							probes: [],
							cores: []
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
				serializable: [],
				privileges: [
					{ relation: c, privilege: "UPDATE" },
					{ relation: b, privilege: "INSERT" }
				],
				members: [
					[
						{
							writes: [insertOf(b, [])],
							reads: [readOf(a, "positive", undefined)],
							probes: [],
							cores: []
						}
					]
				]
			},
			{
				login: s.draw(int(0, 1)),
				serializable: [],
				privileges: [{ relation: a, privilege: "INSERT" }],
				members: [
					[{ writes: [], reads: [readOf(b, "positive", undefined)], probes: [], cores: [] }],
					[{ writes: [insertOf(a, [])], reads: [], probes: [], cores: [] }]
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
			relations: Arr.makeBy(RELATIONS, (i) => ({
				triggerLaws: i === x,
				keys: [],
				race: false,
				counted: [],
				references: []
			})),
			roles: [
				{
					login: s.draw(int(0, 1)),
					serializable: [],
					privileges: [{ relation: x, privilege: "INSERT" }],
					members: [[{ writes: [insertOf(x, [])], reads: [], probes: [], cores: [] }]]
				}
			]
		},
		shape: "triggered",
		extension: { kind: "dropFact", relation: x }
	}
}

/**
 * W's m1 inserts A(k) where B(k) is absent and its m2 inserts B(k), so W runs SERIALIZABLE by absence; C reads A at its
 * key and copies it. C can miss m1 in flight while m2, whose B m1 missed, committed before C began: no serial order in
 * real time explains it, whatever C's read is sealed by (NEGATION's case 1, REGEX's readers single).
 */
const laggingReader: Sketch = {
	relations: [clean([0]), clean([0]), clean([]), clean([])],
	roles: [
		{
			login: 0,
			serializable: [],
			privileges: [
				{ relation: 0, privilege: "INSERT" },
				{ relation: 1, privilege: "INSERT" }
			],
			members: [
				[{ writes: [insertOf(0, [])], reads: [readOf(1, "negated", 0)], probes: [], cores: [] }],
				[{ writes: [insertOf(1, [])], reads: [], probes: [], cores: [] }]
			]
		},
		{
			login: 1,
			serializable: [],
			privileges: [{ relation: 2, privilege: "INSERT" }],
			members: [
				[{ writes: [insertOf(2, [0])], reads: [readOf(0, "positive", 0)], probes: [], cores: [] }]
			]
		}
	]
}

/**
 * W as in the lagging reader, its m2 inserting B(1) and A(2) together; C copies A at a list of keys, one group per own
 * row, and may see A(2) but miss A(1): no serial order at all (NEGATION's case 2).
 */
const listReader: Sketch = {
	relations: [clean([0]), clean([0]), clean([]), clean([])],
	roles: [
		{
			login: 0,
			serializable: [],
			privileges: [
				{ relation: 0, privilege: "INSERT" },
				{ relation: 1, privilege: "INSERT" }
			],
			members: [
				[{ writes: [insertOf(0, [])], reads: [readOf(1, "negated", 0)], probes: [], cores: [] }],
				[{ writes: [insertOf(1, []), insertOf(0, [])], reads: [], probes: [], cores: [] }]
			]
		},
		{
			login: 1,
			serializable: [],
			privileges: [{ relation: 2, privilege: "INSERT" }],
			members: [
				[
					{
						writes: [insertOf(2, [0])],
						reads: [{ ...readOf(0, "positive", 0), rows: "many" }],
						probes: [],
						cores: []
					}
				]
			]
		}
	]
}

/**
 * W as in the lagging reader; C inserts into C's relation, whose foreign key references A, reading nothing else: its
 * check misses m1's A(k) in flight and refuses, after m2 committed (NEGATION's case 3).
 */
const refusedCopy: Sketch = {
	relations: [
		clean([0]),
		clean([0]),
		{ ...clean([0]), references: [{ relation: 0, key: 0, onUpdate: "noAction" }] },
		clean([])
	],
	roles: [
		{
			login: 0,
			serializable: [],
			privileges: [
				{ relation: 0, privilege: "INSERT" },
				{ relation: 1, privilege: "INSERT" }
			],
			members: [
				[{ writes: [insertOf(0, [])], reads: [readOf(1, "negated", 0)], probes: [], cores: [] }],
				[{ writes: [insertOf(1, [])], reads: [], probes: [], cores: [] }]
			]
		},
		{
			login: 1,
			serializable: [],
			privileges: [{ relation: 2, privilege: "INSERT" }],
			members: [[{ writes: [insertOf(2, [])], reads: [], probes: [], cores: [] }]]
		}
	]
}

/**
 * Every role READ COMMITTED but for what the conditions find: R copies A at a list of keys into Copy, whose foreign key
 * references Parent and is checked at COMMIT; m inserts A(2); p inserts Parent(1) where it finds A(2). R misses A(2)
 * while its check finds Parent(1): no serial order at all (NEGATION's case 4).
 */
const deferredCopy: Sketch = {
	relations: [
		clean([0]),
		clean([0]),
		{ ...clean([0]), references: [{ relation: 1, key: 0, onUpdate: "noAction" }] },
		clean([])
	],
	roles: [
		{
			login: 0,
			serializable: [],
			privileges: [{ relation: 2, privilege: "INSERT" }],
			members: [
				[
					{
						writes: [insertOf(2, [0])],
						reads: [{ ...readOf(0, "positive", 0), rows: "many" }],
						probes: [],
						cores: []
					}
				]
			]
		},
		{
			login: 0,
			serializable: [],
			privileges: [{ relation: 0, privilege: "INSERT" }],
			members: [[{ writes: [insertOf(0, [])], reads: [], probes: [], cores: [] }]]
		},
		{
			login: 1,
			serializable: [],
			privileges: [{ relation: 1, privilege: "INSERT" }],
			members: [
				[{ writes: [insertOf(1, [0])], reads: [readOf(0, "positive", 0)], probes: [], cores: [] }]
			]
		}
	]
}

/**
 * r0 reads A at its key in one statement and inserts into B in the next, joined with nothing it wrote, so a row it
 * writes reaches no group it read; r1 inserts into A. r0 fails the pivot condition by that alone.
 */
const lateWriter: Sketch = {
	relations: [clean([0]), clean([]), clean([]), clean([])],
	roles: [
		{
			login: 0,
			serializable: [],
			privileges: [{ relation: 1, privilege: "INSERT" }],
			members: [
				[
					{ writes: [], reads: [readOf(0, "positive", 0)], probes: [], cores: [] },
					{ writes: [insertOf(1, [])], reads: [], probes: [], cores: [] }
				]
			]
		},
		{
			login: 1,
			serializable: [],
			privileges: [{ relation: 0, privilege: "INSERT" }],
			members: [[{ writes: [insertOf(0, [])], reads: [], probes: [], cores: [] }]]
		}
	]
}

/**
 * B's foreign key into A carries A's updates (ON UPDATE CASCADE); r0 holds UPDATE on A and updates it by its one
 * member, so it updates B too; r1 inserts into B, which is then no insert-only relation, and its check of A reads a
 * relation r0 updates.
 */
const cascadedWriter: Sketch = {
	relations: [
		clean([0]),
		{ ...clean([]), references: [{ relation: 0, key: 0, onUpdate: "cascade" }] },
		clean([]),
		clean([])
	],
	roles: [
		{
			login: 0,
			privileges: [{ relation: 0, privilege: "UPDATE" }],
			members: [
				[{ writes: [{ relation: 0, op: "update", from: [] }], reads: [], probes: [], cores: [] }]
			],
			serializable: []
		},
		{
			login: 1,
			serializable: [],
			privileges: [{ relation: 1, privilege: "INSERT" }],
			members: [[{ writes: [insertOf(1, [])], reads: [], probes: [], cores: [] }]]
		}
	]
}

/**
 * r0 inserts into A by its one member; r1 holds INSERT on A and has no member, so it runs SERIALIZABLE, and the guard
 * keeps A's: r0 runs SERIALIZABLE too, every write of it refused at READ COMMITTED otherwise (LOADER's Badge).
 */
const sharedWriter: Sketch = {
	relations: [clean([0]), clean([]), clean([]), clean([])],
	roles: [
		{
			login: 0,
			serializable: [],
			privileges: [{ relation: 0, privilege: "INSERT" }],
			members: [[{ writes: [insertOf(0, [])], reads: [], probes: [], cores: [] }]]
		},
		{ login: 1, privileges: [{ relation: 0, privilege: "INSERT" }], members: [], serializable: [] }
	]
}

/**
 * The insert protocol over a sealed point: r0 reads A at its key positively, the read joined with its insert into B, and
 * again beneath a probe gating that insert, as the refusal arm and the duplicate check read the proposed rows; r1
 * inserts into A. The probe is a function of the positive read, so it reads no absence and both run READ COMMITTED.
 */
const protocolSealedOf = (rows: ReadSketch["rows"]): Sketch => ({
	relations: [clean([0]), clean([]), clean([]), clean([])],
	roles: [
		{
			login: 0,
			serializable: [],
			privileges: [{ relation: 1, privilege: "INSERT" }],
			members: [
				[
					{
						writes: [insertOf(1, [0])],
						reads: [
							{ ...readOf(0, "positive", 0), rows },
							{ ...readOf(0, "negated", 0), rows, probes: [0] }
						],
						probes: [{ gates: [0], core: 0, chain: [] }],
						cores: [[{ kind: "read", read: 0 }], [{ kind: "read", read: 1 }]]
					}
				]
			]
		},
		{
			login: 1,
			serializable: [],
			privileges: [{ relation: 0, privilege: "INSERT" }],
			members: [[{ writes: [insertOf(0, [])], reads: [], probes: [], cores: [] }]]
		}
	]
})

/**
 * Write skew at a sealed point: r0 inserts into B where A's point is absent, a probe no positive read of A gates; r1
 * inserts into A. The probe is an absence read, so r1 runs SERIALIZABLE by absence, and r0 by its pivot.
 */
const absentGate: Sketch = {
	relations: [clean([0]), clean([]), clean([]), clean([])],
	roles: [
		{
			login: 0,
			serializable: [],
			privileges: [{ relation: 1, privilege: "INSERT" }],
			members: [
				[
					{
						writes: [insertOf(1, [])],
						reads: [{ ...readOf(0, "negated", 0), probes: [0] }],
						probes: [{ gates: [0], core: 0, chain: [] }],
						cores: [[], [{ kind: "read", read: 0 }]]
					}
				]
			]
		},
		{
			login: 1,
			serializable: [],
			privileges: [{ relation: 0, privilege: "INSERT" }],
			members: [[{ writes: [insertOf(0, [])], reads: [], probes: [], cores: [] }]]
		}
	]
}

/**
 * NEGATION's fallback and its count twin: r0 inserts into B from a UNION of two rules. The first arm joins A at its key,
 * so B's write reads A positively; the second, in its own core, inserts a default where A's point is absent, or the
 * count of A's point, a value an ungrouped count yields over no row. Its probe gates the same write, but the core whose
 * rows it touches never reads A, so it is no function of the positive read: r1, inserting into A, runs SERIALIZABLE by
 * absence, and r0 by its pivot.
 */
const fallbackOf = (mode: "negated" | "counted"): Sketch => ({
	relations: [clean([0]), clean([]), clean([]), clean([])],
	roles: [
		{
			login: 0,
			serializable: [],
			privileges: [{ relation: 1, privilege: "INSERT" }],
			members: [
				[
					{
						writes: [insertOf(1, [0])],
						reads: [readOf(0, "positive", 0), { ...readOf(0, mode, 0), probes: [0] }],
						probes: [{ gates: [0], core: 1, chain: [] }],
						cores: [
							[{ kind: "read", read: 0 }],
							[],
							mode === "counted" ? [] : [{ kind: "read", read: 1 }]
						]
					}
				]
			]
		},
		{
			login: 1,
			serializable: [],
			privileges: [{ relation: 0, privilege: "INSERT" }],
			members: [[{ writes: [insertOf(0, [])], reads: [], probes: [], cores: [] }]]
		}
	]
})

/**
 * The insert protocol over a UNION: r0 inserts into B from a UNION of two arms, the first reading A at its key, where a
 * NOT EXISTS over the UNION's rows reads A's point again; r1 inserts into A. Where the second arm reads A's point too
 * (`same`), every row of the UNION comes through it, so the probe is a function of the positive reads and both run READ
 * COMMITTED. Where it reads A at another key (`key`), a relation no role writes (`relation`), or only its recursion's
 * own rows (`recursion`), as a recursive CTE's recursive arm does, the second arm's rows never pass through A's point,
 * so the NOT EXISTS is an absence read: r1 runs SERIALIZABLE by absence, and r0 by its pivot.
 */
const unionOf = (arm: "same" | "key" | "relation" | "recursion"): Sketch => {
	const other: ReadonlyArray<ReadSketch> =
		arm === "recursion"
			? []
			: [
					arm === "relation"
						? readOf(2, "positive", 0)
						: { ...readOf(0, "positive", 0), binding: arm === "key" ? 1 : 0 }
				]
	const probed = 1 + other.length
	return {
		relations: [clean([0]), clean([]), clean([0]), clean([])],
		roles: [
			{
				login: 0,
				serializable: [],
				privileges: [{ relation: 1, privilege: "INSERT" }],
				members: [
					[
						{
							writes: [
								insertOf(
									1,
									upTo(probed, (i) => i)
								)
							],
							reads: [
								readOf(0, "positive", 0),
								...other,
								{ ...readOf(0, "negated", 0), probes: [0] }
							],
							probes: [{ gates: [0], core: 0, chain: [] }],
							cores: [
								[
									{
										kind: "union",
										arms: [[{ kind: "core", core: 1 }], [{ kind: "core", core: 2 }]]
									}
								],
								[{ kind: "read", read: 0 }],
								Arr.map(other, (_, i): RowSource => ({ kind: "read", read: 1 + i })),
								[{ kind: "read", read: probed }]
							]
						}
					]
				]
			},
			{
				login: 1,
				serializable: [],
				privileges: [{ relation: 0, privilege: "INSERT" }],
				members: [[{ writes: [insertOf(0, [])], reads: [], probes: [], cores: [] }]]
			}
		]
	}
}

/**
 * A row path through an arbitration: r0 inserts into B joined with A's point, read in a core of its own, where core 0's
 * NOT EXISTS reads A's point, and core 0's only source is an arbitration of A's point, which no positive read is. The
 * NOT EXISTS is no function of a positive read: r1, inserting into A, runs SERIALIZABLE by absence, and r0 by its pivot.
 */
const arbiterPath: Sketch = {
	relations: [clean([0]), clean([]), clean([]), clean([])],
	roles: [
		{
			login: 0,
			serializable: [],
			privileges: [{ relation: 1, privilege: "INSERT" }],
			members: [
				[
					{
						writes: [insertOf(1, [0])],
						reads: [
							readOf(0, "positive", 0),
							{ ...readOf(0, "negated", 0), probes: [0] },
							readOf(0, "arbiter", 0)
						],
						probes: [{ gates: [0], core: 0, chain: [] }],
						cores: [
							[{ kind: "read", read: 2 }],
							[{ kind: "read", read: 1 }],
							[{ kind: "read", read: 0 }]
						]
					}
				]
			]
		},
		{
			login: 1,
			serializable: [],
			privileges: [{ relation: 0, privilege: "INSERT" }],
			members: [[{ writes: [insertOf(0, [])], reads: [], probes: [], cores: [] }]]
		}
	]
}

/**
 * A gate no write joins: r0's statement inserts into B from a grouped count of A's point, the probe of that count judged
 * by its own rows, and into C from a positive read of A's point that feeds C alone, as a data-modifying CTE's source
 * reads it. Every row of the count's core comes through A's point, but no read of A joins B, the write the probe gates,
 * so the probe is no function of the positive read: r1, inserting into A, runs SERIALIZABLE by absence, and r0 by its
 * pivot.
 */
const unjoinedGate: Sketch = {
	relations: [clean([0]), clean([]), clean([]), clean([])],
	roles: [
		{
			login: 0,
			serializable: [],
			privileges: [
				{ relation: 1, privilege: "INSERT" },
				{ relation: 2, privilege: "INSERT" }
			],
			members: [
				[
					{
						writes: [insertOf(1, []), insertOf(2, [0])],
						reads: [readOf(0, "positive", 0), { ...readOf(0, "counted", 0), probes: [0] }],
						probes: [{ gates: [0], core: 0, chain: [0] }],
						cores: [[{ kind: "read", read: 1 }], [{ kind: "read", read: 0 }]]
					}
				]
			]
		},
		{
			login: 1,
			serializable: [],
			privileges: [{ relation: 0, privilege: "INSERT" }],
			members: [[{ writes: [insertOf(0, [])], reads: [], probes: [], cores: [] }]]
		}
	]
}

/**
 * A row path beneath another probe: r0 inserts into B joined with A's point read in a core of its own, where core 0's
 * NOT EXISTS reads A's point, and core 0 reads A's point only through a grouped derived table, beneath that table's own
 * probe. Every row of core 0 comes through that read, but not beneath the probes the NOT EXISTS stands beneath, so the
 * NOT EXISTS is no function of the positive read: r1, inserting into A, runs SERIALIZABLE by absence, and r0 by its
 * pivot.
 */
const chainedPath: Sketch = {
	relations: [clean([0]), clean([]), clean([]), clean([])],
	roles: [
		{
			login: 0,
			serializable: [],
			privileges: [{ relation: 1, privilege: "INSERT" }],
			members: [
				[
					{
						writes: [insertOf(1, [0])],
						reads: [
							readOf(0, "positive", 0),
							{ ...readOf(0, "negated", 0), probes: [0] },
							{ ...readOf(0, "counted", 0), probes: [1] }
						],
						probes: [
							{ gates: [0], core: 0, chain: [] },
							{ gates: [0], core: 3, chain: [1] }
						],
						cores: [
							[{ kind: "core", core: 3 }],
							[{ kind: "read", read: 1 }],
							[{ kind: "read", read: 0 }],
							[{ kind: "read", read: 2 }]
						]
					}
				]
			]
		},
		{
			login: 1,
			serializable: [],
			privileges: [{ relation: 0, privilege: "INSERT" }],
			members: [[{ writes: [insertOf(0, [])], reads: [], probes: [], cores: [] }]]
		}
	]
}

/**
 * r0's first statement inserts into A arbitrated at A's key by its parameters, reading nothing else, and its second
 * reads A back at that key and a row of its own and inserts into B from both: the read is arbitrated, so no group comes
 * later than a write. Gated, the first statement also reads C at its key, so it may propose no row of A, and the
 * read-back is a point read again, a group read only later (NEGATION's claimStart).
 */
const arbitratedOf = (gated: boolean): Sketch => ({
	relations: [clean([0]), clean([]), clean([0]), clean([])],
	roles: [
		{
			login: 0,
			serializable: [],
			privileges: [
				{ relation: 0, privilege: "INSERT" },
				{ relation: 1, privilege: "INSERT" }
			],
			members: [
				[
					{
						writes: [insertOf(0, gated ? [1] : [])],
						reads: [readOf(0, "arbiter", 0), ...(gated ? [readOf(2, "positive", 0)] : [])],
						probes: [],
						cores: []
					},
					{
						writes: [insertOf(1, [0, 1])],
						reads: [readOf(0, "positive", 0), { ...readOf(3, "positive", undefined), own: true }],
						probes: [],
						cores: []
					}
				]
			]
		},
		{
			login: 1,
			serializable: [],
			privileges: [{ relation: 2, privilege: "INSERT" }],
			members: [[{ writes: [insertOf(2, [])], reads: [], probes: [], cores: [] }]]
		}
	]
})

/**
 * A race and the read of its winner. r0's first statement inserts into A, arbitrated at its key by its parameters, and
 * its second reads A back and a row of its own and inserts into B from both. Key-matched (`matched`), A is raced at
 * its key k0 and the read binds k0 as the arbitration did and k1 as well, so it reads the row the arbitration fixed,
 * filtered: arbitrated, and r0 runs READ COMMITTED. Unmatched (`unmatched`), the read binds k0 to the other
 * parameter: another call's row, read after r0's write, so r0 fails the pivot condition. With A keyed by (k0, k1), its
 * arbitration binding both to one parameter (`partial`), a read binding k0 alike and k1 to the other parameter matches
 * part of the key alone: another call's row, so r0 fails the pivot condition. With A keyed by k0 and by k1
 * and its insertion probed at k1 too (`raceOther`, `repeatableOther`), the read is at k1, the probe's binding: where A
 * is raced at k0 the row met there may hold another k1, so the read is another call's row and r0 fails the pivot
 * condition; where A is not raced every row an insertion meets is an exact repeat, so the row at k1 is fixed too.
 */
const keyedOf = (
	kind: "matched" | "unmatched" | "partial" | "raceOther" | "repeatableOther"
): Sketch => {
	const otherKey = kind === "raceOther" || kind === "repeatableOther"
	const a: RelationSketch = {
		...clean(otherKey ? [0, 1] : kind === "partial" ? [2] : [0]),
		race: kind !== "repeatableOther"
	}
	const arbitrations: ReadonlyArray<ReadSketch> = otherKey
		? [readOf(0, "arbiter", 0), readOf(0, "arbiter", 1)]
		: [readOf(0, "arbiter", kind === "partial" ? 2 : 0)]
	const back: ReadSketch = otherKey
		? readOf(0, "positive", 1)
		: { ...readOf(0, "positive", 2), binding: kind === "unmatched" ? 1 : 0, split: true }
	return {
		relations: [a, clean([]), clean([0]), clean([])],
		roles: [
			{
				login: 0,
				serializable: [],
				privileges: [
					{ relation: 0, privilege: "INSERT" },
					{ relation: 1, privilege: "INSERT" }
				],
				members: [
					[
						{ writes: [insertOf(0, [])], reads: arbitrations, probes: [], cores: [] },
						{
							writes: [insertOf(1, [0, 1])],
							reads: [back, { ...readOf(3, "positive", undefined), own: true }],
							probes: [],
							cores: []
						}
					]
				]
			},
			{
				login: 1,
				serializable: [],
				privileges: [{ relation: 2, privilege: "INSERT" }],
				members: [[{ writes: [insertOf(2, [])], reads: [], probes: [], cores: [] }]]
			}
		]
	}
}

/**
 * A role's SERIALIZABLE form, which it judges others by beside its READ COMMITTED one once lowered. r0 holds UPDATE on
 * D, so it runs SERIALIZABLE by its own privileges, and inserts into B in either form. In its SERIALIZABLE form it also
 * reads B by an own column (`cause`), so it may miss another call's write, and r1, reading B at its key, runs
 * SERIALIZABLE by r0's writes; it updates A (`update`), so r1's point read of A, which r2 inserts, is unsealed, and r1
 * and r2 run SERIALIZABLE; or it reads C's absence (`absence`), so r1, inserting into C, runs SERIALIZABLE. Where r0
 * holds no UPDATE (`own`), its READ COMMITTED form reads nothing, so it is never lowered and its SERIALIZABLE form,
 * which reads C by an own column before it writes, is never a fact: every role runs READ COMMITTED.
 */
const servedOf = (kind: "cause" | "update" | "absence" | "own"): Sketch => {
	const serializable: StatementSketch = {
		writes: [
			insertOf(1, []),
			...(kind === "update" ? [{ relation: 0, op: "update" as const, from: [] }] : [])
		],
		reads:
			kind === "cause"
				? [{ ...readOf(1, "positive", 0), rows: "many" }]
				: kind === "absence"
					? [readOf(2, "negated", 0)]
					: kind === "own"
						? [{ ...readOf(2, "positive", 0), rows: "many" }]
						: [],
		probes: [],
		cores: []
	}
	return {
		relations: [clean([0]), clean([0]), clean([0]), clean([])],
		roles: [
			{
				login: 0,
				serializable: [[serializable]],
				privileges: [
					{ relation: 1, privilege: "INSERT" },
					...(kind === "own" ? [] : [{ relation: 3, privilege: "UPDATE" as const }])
				],
				members: [[{ writes: [insertOf(1, [])], reads: [], probes: [], cores: [] }]]
			},
			{
				login: 1,
				serializable: [],
				privileges: [{ relation: 2, privilege: "INSERT" }],
				members: [
					[
						{
							writes: [insertOf(2, [0, 1])],
							reads: [readOf(1, "positive", 0), readOf(0, "positive", 0)],
							probes: [],
							cores: []
						}
					]
				]
			},
			{
				login: 1,
				serializable: [],
				privileges: [{ relation: 0, privilege: "INSERT" }],
				members: [[{ writes: [insertOf(0, [])], reads: [], probes: [], cores: [] }]]
			}
		]
	}
}

/**
 * edullm's folded publisher, QTI's publisher writing the media policy too: r0 publishes into P and writes M, which a
 * trigger-held law reads, so it runs SERIALIZABLE by its own laws and may miss another call's write; r1, the learner,
 * inserts into S joined with P read at its key, so r0 gives it 5c; r2 inserts into V joined with S read at its key, so
 * r1, reading P from outside, gives it 5c, and it reads S, which gives r1 condition 2's other half. In its SERIALIZABLE
 * form r1 also reads the absence of S, which it writes, and where `other` r2's SERIALIZABLE form reads a count of S.
 * r1's certificate names 5c and condition 2, the reasons of the round that lowered it, never the absence its own
 * lowered form or r2's reads.
 */
const loweredOf = (other: boolean): Sketch => ({
	relations: [clean([0]), clean([0]), { ...clean([0]), triggerLaws: true }, clean([0])],
	roles: [
		{
			login: 0,
			serializable: [],
			privileges: [
				{ relation: 0, privilege: "INSERT" },
				{ relation: 2, privilege: "INSERT" }
			],
			members: [
				[{ writes: [insertOf(0, [])], reads: [], probes: [], cores: [] }],
				[{ writes: [insertOf(2, [])], reads: [], probes: [], cores: [] }]
			]
		},
		{
			login: 1,
			serializable: [
				[
					{
						writes: [insertOf(1, [0])],
						reads: [readOf(0, "positive", 0), readOf(1, "negated", 0)],
						probes: [],
						cores: []
					}
				]
			],
			privileges: [{ relation: 1, privilege: "INSERT" }],
			members: [
				[{ writes: [insertOf(1, [0])], reads: [readOf(0, "positive", 0)], probes: [], cores: [] }]
			]
		},
		{
			login: 1,
			serializable: other
				? [
						[
							{
								writes: [insertOf(3, [0])],
								reads: [readOf(1, "positive", 0), readOf(1, "counted", 0)],
								probes: [],
								cores: []
							}
						]
					]
				: [],
			privileges: [{ relation: 3, privilege: "INSERT" }],
			members: [
				[{ writes: [insertOf(3, [0])], reads: [readOf(1, "positive", 0)], probes: [], cores: [] }]
			]
		}
	]
})

/**
 * The publication layer: r0 inserts Q where B's key is absent and inserts B, so it runs SERIALIZABLE and may miss
 * another call's write; r1 publishes, inserting into P, whose foreign key references Q's key, so its check of Q is an
 * outside read 5c weighs against r0 and it runs SERIALIZABLE; r2 inserts into L, referencing P's key, and reads P at
 * its key. r1's own check of Q, sealed, finds an immutable row, so r1 is no pivot cause and r2 runs READ COMMITTED; r1
 * forced READ COMMITTED would see r0's in-flight row of Q refused while r0 commits, which no serial order in real time
 * explains.
 */
const publication: Sketch = {
	relations: [
		clean([0]),
		{ ...clean([0]), references: [{ relation: 0, key: 0, onUpdate: "noAction" }] },
		{ ...clean([0]), references: [{ relation: 1, key: 0, onUpdate: "noAction" }] },
		clean([0])
	],
	roles: [
		{
			login: 0,
			serializable: [],
			privileges: [
				{ relation: 0, privilege: "INSERT" },
				{ relation: 3, privilege: "INSERT" }
			],
			members: [
				[{ writes: [insertOf(0, [])], reads: [readOf(3, "negated", 0)], probes: [], cores: [] }],
				[{ writes: [insertOf(3, [])], reads: [], probes: [], cores: [] }]
			]
		},
		{
			login: 0,
			serializable: [],
			privileges: [{ relation: 1, privilege: "INSERT" }],
			members: [[{ writes: [insertOf(1, [])], reads: [], probes: [], cores: [] }]]
		},
		{
			login: 1,
			serializable: [],
			privileges: [{ relation: 2, privilege: "INSERT" }],
			members: [
				[
					{
						writes: [insertOf(2, [0])],
						reads: [readOf(1, "positive", 0)],
						probes: [],
						cores: []
					}
				]
			]
		}
	]
}

/**
 * A deleted referenced relation: r0 inserts into R(b), whose foreign key references R(a) at its key, reading nothing
 * else; r1 holds a privilege on R(a) and serves no member, deleting it from another login than r2's (`held`), deleting
 * it from r2's login (`fenced`), or updating it (`updated`); r2 inserts into R(a). r0's check is held where no login
 * both deletes and inserts R(a), and fenced where one does: that login's members that write R(a) lock it before their
 * snapshot, so a same-key replace, which would refuse r0's READ COMMITTED check with 23503 while the key stands
 * throughout (PostgreSQL 19 ri_triggers.c ri_FastPathProbeOne and ri_LockPKTuple), never meets the check. Either way
 * r0 runs READ COMMITTED, with a fence of r1's login, which deletes R(a). An update may move the key: r0's check is
 * unsealed and r0 runs SERIALIZABLE.
 */
const referencedWriterOf = (s: Source, kind: "held" | "fenced" | "updated"): Sketch => {
	const [a, b] = threeOf(s)
	const login = s.draw(int(0, 1))
	return {
		relations: Arr.makeBy(RELATIONS, (i) =>
			i === b
				? { ...clean([0]), references: [{ relation: a, key: 0, onUpdate: "noAction" }] }
				: clean([0])
		),
		roles: [
			{
				login: s.draw(int(0, 1)),
				serializable: [],
				privileges: [{ relation: b, privilege: "INSERT" }],
				members: [[{ writes: [insertOf(b, [])], reads: [], probes: [], cores: [] }]]
			},
			{
				login: kind === "fenced" ? login : 1 - login,
				serializable: [],
				privileges: [{ relation: a, privilege: kind === "updated" ? "UPDATE" : "DELETE" }],
				members: []
			},
			{
				login,
				serializable: [],
				privileges: [{ relation: a, privilege: "INSERT" }],
				members: [[{ writes: [insertOf(a, [])], reads: [], probes: [], cores: [] }]]
			}
		]
	}
}

/**
 * edullm's replace: r0, a learner, inserts into R(b), whose foreign key references R(a), reading nothing else; r1, the
 * publisher, deletes R(a) and inserts it again in one member, after reading R(c) from outside at its key, which r2
 * inserts, so r1 may miss another call's write (pivotCauseOf), and its deletion checks R(b)'s rows that reference R(a).
 * r1's login fences R(a): its member locks R(a) before its snapshot, so r0's check is fenced, 5c weighs r1 against no
 * fenced check of r0's, and the check of R(b)'s referencing rows is no site of r0's conditions 2 and 3. r0 runs READ
 * COMMITTED with a fence of r1's login.
 */
const fencedPublisher = (s: Source): Sketch => {
	const [a, b, c] = threeOf(s)
	return {
		relations: Arr.makeBy(RELATIONS, (i) =>
			i === b
				? { ...clean([0]), references: [{ relation: a, key: 0, onUpdate: "noAction" }] }
				: clean([0])
		),
		roles: [
			{
				login: s.draw(int(0, 1)),
				serializable: [],
				privileges: [{ relation: b, privilege: "INSERT" }],
				members: [[{ writes: [insertOf(b, [])], reads: [], probes: [], cores: [] }]]
			},
			{
				login: s.draw(int(0, 1)),
				serializable: [],
				privileges: [
					{ relation: a, privilege: "DELETE" },
					{ relation: a, privilege: "INSERT" },
					{ relation: c, privilege: "SELECT" }
				],
				members: [
					[
						{ writes: [{ relation: a, op: "delete", from: [] }], reads: [], probes: [], cores: [] },
						{ writes: [insertOf(a, [0])], reads: [readOf(c, "positive", 0)], probes: [], cores: [] }
					]
				]
			},
			{
				login: s.draw(int(0, 1)),
				serializable: [],
				privileges: [{ relation: c, privilege: "INSERT" }],
				members: [[{ writes: [insertOf(c, [])], reads: [], probes: [], cores: [] }]]
			}
		]
	}
}

/**
 * NEGATION's case 3 beside a fence: r1's login fences R(a), deleting and inserting it by its privileges, but r3, of the
 * other login, inserts R(a) where it reads R(c) absent, so it may miss another call's write and fences nothing. r0's
 * fenced check of R(a) can miss r3's row in flight and refuse r0, which no serial order in real time explains once r3's
 * read missed a write committed before r0 began: 5c weighs r3 against it, and r0 runs SERIALIZABLE.
 */
const unfencedPivot = (s: Source): Sketch => {
	const [a, b, c] = threeOf(s)
	const login = s.draw(int(0, 1))
	return {
		relations: Arr.makeBy(RELATIONS, (i) =>
			i === b
				? { ...clean([0]), references: [{ relation: a, key: 0, onUpdate: "noAction" }] }
				: clean([0])
		),
		roles: [
			{
				login: s.draw(int(0, 1)),
				serializable: [],
				privileges: [{ relation: b, privilege: "INSERT" }],
				members: [[{ writes: [insertOf(b, [])], reads: [], probes: [], cores: [] }]]
			},
			{
				login,
				serializable: [],
				privileges: [
					{ relation: a, privilege: "DELETE" },
					{ relation: a, privilege: "INSERT" }
				],
				members: []
			},
			{
				login: s.draw(int(0, 1)),
				serializable: [],
				privileges: [{ relation: c, privilege: "INSERT" }],
				members: [[{ writes: [insertOf(c, [])], reads: [], probes: [], cores: [] }]]
			},
			{
				login: 1 - login,
				serializable: [],
				privileges: [{ relation: a, privilege: "INSERT" }],
				members: [
					[{ writes: [insertOf(a, [])], reads: [readOf(c, "negated", 0)], probes: [], cores: [] }]
				]
			}
		]
	}
}

/**
 * A deleter by a member: r1 deletes R(a) by a member, from another login than r2's, which inserts it, so r0's check of
 * R(a) is held, and r1's deletion checks R(b)'s rows that reference the deleted one for their absence. Where no role
 * updates R(a), r1's login fences it (`fenced`): r1's member locks R(a) before its snapshot, its check of the referencing
 * rows is no site of r0's conditions 2 and 3, and 5c weighs it against no held check of r0's, so r0 runs READ
 * COMMITTED with a fence of r1's login. Where r1 also updates R(a) (`updated`), nothing fences it: r0's check is
 * unsealed, and r0 runs SERIALIZABLE, naming absence, laws and writers too.
 */
const deleterOf = (s: Source, kind: "fenced" | "updated"): Sketch => {
	const [a, b] = threeOf(s)
	const login = s.draw(int(0, 1))
	return {
		relations: Arr.makeBy(RELATIONS, (i) =>
			i === b
				? { ...clean([0]), references: [{ relation: a, key: 0, onUpdate: "noAction" }] }
				: clean([0])
		),
		roles: [
			{
				login: s.draw(int(0, 1)),
				serializable: [],
				privileges: [{ relation: b, privilege: "INSERT" }],
				members: [[{ writes: [insertOf(b, [])], reads: [], probes: [], cores: [] }]]
			},
			{
				login: 1 - login,
				serializable: [],
				privileges:
					kind === "updated"
						? [
								{ relation: a, privilege: "DELETE" },
								{ relation: a, privilege: "UPDATE" }
							]
						: [{ relation: a, privilege: "DELETE" }],
				members: [
					[{ writes: [{ relation: a, op: "delete", from: [] }], reads: [], probes: [], cores: [] }]
				]
			},
			{
				login,
				serializable: [],
				privileges: [{ relation: a, privilege: "INSERT" }],
				members: [[{ writes: [insertOf(a, [])], reads: [], probes: [], cores: [] }]]
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
					(t) => ({
						kind: "member",
						role,
						member: t.draw(array(statementGen, { min: 1, max: 2 }))
					})
				],
				[
					1,
					(t) => ({
						kind: "served",
						role,
						member: t.draw(array(statementGen, { min: 1, max: 2 }))
					})
				],
				[1, (t) => ({ kind: "role", role: t.draw(roleGen) })],
				[1, (t) => ({ kind: "insert", role, relation: t.draw(relationGen) })],
				[1, (t) => ({ kind: "triggerLaw", relation: t.draw(relationGen) })],
				[
					1,
					(t) => ({
						kind: "reference",
						relation: t.draw(relationGen),
						reference: t.draw(referenceGen)
					})
				],
				[1, (t) => ({ kind: "dropFact", relation: t.draw(relationGen) })],
				[1, (t) => ({ kind: "race", relation: t.draw(relationGen) })]
			])
		)
	}

/**
 * The deferred copy with Copy's fact dropped: its foreign key into Parent is then unknown, so r0's write of it may
 * check any relation, Parent among them, and r2, which r0's check of Parent held SERIALIZABLE, stays so.
 */
const droppedReference: Case = {
	sketch: deferredCopy,
	shape: "droppedReference",
	extension: { kind: "dropFact", relation: 2 }
}

const shapeSketch = (
	s: Source,
	shape: Exclude<Shape, "triggered" | "droppedReference">
): Sketch => {
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
		case "laggingReader":
			return laggingReader
		case "listReader":
			return listReader
		case "refusedCopy":
			return refusedCopy
		case "deferredCopy":
			return deferredCopy
		case "lateWriter":
			return lateWriter
		case "cascadedWriter":
			return cascadedWriter
		case "sharedWriter":
			return sharedWriter
		case "protocolSealed":
			return protocolSealedOf("one")
		case "protocolUnsealed":
			return protocolSealedOf("many")
		case "absentGate":
			return absentGate
		case "arbitratedRead":
			return arbitratedOf(false)
		case "arbitratedGated":
			return arbitratedOf(true)
		case "keyMatched":
			return keyedOf("matched")
		case "keyUnmatched":
			return keyedOf("unmatched")
		case "keyPartial":
			return keyedOf("partial")
		case "raceOtherKey":
			return keyedOf("raceOther")
		case "repeatableOtherKey":
			return keyedOf("repeatableOther")
		case "fallbackUnion":
			return fallbackOf("negated")
		case "fallbackCount":
			return fallbackOf("counted")
		case "unjoinedGate":
			return unjoinedGate
		case "chainedPath":
			return chainedPath
		case "unionSealed":
			return unionOf("same")
		case "unionOtherKey":
			return unionOf("key")
		case "unionOtherRelation":
			return unionOf("relation")
		case "unionRecursion":
			return unionOf("recursion")
		case "arbiterPath":
			return arbiterPath
		case "publication":
			return publication
		case "servedCause":
			return servedOf("cause")
		case "servedUpdate":
			return servedOf("update")
		case "servedAbsence":
			return servedOf("absence")
		case "servedOwn":
			return servedOf("own")
		case "loweredAbsence":
			return loweredOf(false)
		case "loweredCause":
			return loweredOf(true)
		case "heldCheck":
			return referencedWriterOf(s, "held")
		case "fencedCheck":
			return referencedWriterOf(s, "fenced")
		case "updatedCheck":
			return referencedWriterOf(s, "updated")
		case "fencedPublisher":
			return fencedPublisher(s)
		case "unfencedPivot":
			return unfencedPivot(s)
		case "fencedDeleter":
			return deleterOf(s, "fenced")
		case "updatedDeleter":
			return deleterOf(s, "updated")
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
			[1, () => "laggingReader"],
			[1, () => "listReader"],
			[1, () => "refusedCopy"],
			[1, () => "deferredCopy"],
			[1, () => "lateWriter"],
			[1, () => "cascadedWriter"],
			[1, () => "sharedWriter"],
			[1, () => "protocolSealed"],
			[1, () => "protocolUnsealed"],
			[1, () => "absentGate"],
			[1, () => "arbitratedRead"],
			[1, () => "arbitratedGated"],
			[1, () => "keyMatched"],
			[1, () => "keyUnmatched"],
			[1, () => "keyPartial"],
			[1, () => "raceOtherKey"],
			[1, () => "repeatableOtherKey"],
			[1, () => "fallbackUnion"],
			[1, () => "fallbackCount"],
			[1, () => "unjoinedGate"],
			[1, () => "chainedPath"],
			[1, () => "unionSealed"],
			[1, () => "unionOtherKey"],
			[1, () => "unionOtherRelation"],
			[1, () => "unionRecursion"],
			[1, () => "arbiterPath"],
			[1, () => "publication"],
			[1, () => "servedCause"],
			[1, () => "servedUpdate"],
			[1, () => "servedAbsence"],
			[1, () => "servedOwn"],
			[1, () => "loweredAbsence"],
			[1, () => "loweredCause"],
			[1, () => "triggered"],
			[1, () => "droppedReference"],
			[1, () => "heldCheck"],
			[1, () => "fencedCheck"],
			[1, () => "updatedCheck"],
			[1, () => "fencedPublisher"],
			[1, () => "unfencedPivot"],
			[1, () => "fencedDeleter"],
			[1, () => "updatedDeleter"]
		])
	)
	if (shape === "droppedReference") {
		return droppedReference
	}
	if (shape === "triggered") {
		return s.draw(triggeredGen)
	}
	const sketch = shapeSketch(s, shape)
	return { sketch, shape, extension: s.draw(extensionGen(sketch)) }
}

const relationName = (i: number): string => `R${i}`

/** Whether some role of the sketch deletes the relation, by a privilege or by a member of either of its forms. */
const deletedIn = (sketch: Sketch, relation: number): boolean =>
	Arr.some(
		sketch.roles,
		(r) =>
			Arr.some(r.privileges, (p) => p.relation === relation && p.privilege === "DELETE") ||
			Arr.some([...r.members, ...r.serializable], (statements) =>
				Arr.some(statements, (st) =>
					Arr.some(st.writes, (w) => w.relation === relation && w.op === "delete")
				)
			)
	)

/** A read's mode were every probe above it neutral: an arbitration's, positive beneath a probe, else its own. */
const baseOf = (r: ReadSketch): ReadSketch["mode"] => {
	if (r.probes.length === 0 || r.mode === "arbiter") {
		return r.mode
	}
	return "positive"
}
const keyOf = (i: number): Arr.NonEmptyReadonlyArray<string> => Arr.getUnsafe(KEYS, i)
const lawId = (i: number) => wild.lawId(`law_${i}`)

/** What a read binds `field` to: `$p<binding>`, or k1, where it is split, the other parameter. */
const byOf = (r: ReadSketch, field: string): string =>
	`$p${field === "k1" && r.split ? 1 - r.binding : r.binding}`

const readFact = (r: ReadSketch): ReadFact => ({
	relation: relationName(r.relation),
	mode: r.mode,
	base: baseOf(r),
	probes: r.probes,
	own: r.own,
	group:
		r.group === undefined
			? undefined
			: {
					bound: Arr.map(keyOf(r.group), (field) => ({ field, by: byOf(r, field) })),
					rows: r.rows
				}
})

/** What an insertion into a sketched relation meets at its first key: a race there where it is raced, else a
 * repeatable insertion's. */
const insertsOf = (r: RelationSketch): InsertsFact =>
	Arr.match(r.keys, {
		onEmpty: (): InsertsFact => ({ kind: "repeatable" }),
		onNonEmpty: ([first]): InsertsFact =>
			r.race ? { kind: "race", key: keyOf(first) } : { kind: "repeatable" }
	})

/** A role's members as the certifier reads them, each named by its place; a member of no statement sends none. */
const membersOf = (
	members: ReadonlyArray<ReadonlyArray<StatementSketch>>
): ReadonlyArray<MemberFacts> =>
	Arr.flatMap(members, (statements, m) =>
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
							reads: Arr.map(st.reads, readFact),
							probes: st.probes,
							cores: st.cores
						}))
					}
				]
			: []
	)

/** The facts a sketch states, as the certifier reads them. */
const inputOf = (sketch: Sketch): IsolationInput => ({
	relations: new Map(
		Arr.map(sketch.relations, (r, i) => [
			relationName(i),
			{
				triggerLaws: r.triggerLaws ? [lawId(i)] : [],
				keys: Arr.map(r.keys, keyOf),
				countedGroups: Arr.map(r.counted, keyOf),
				references: Arr.map(r.references, (ref) => ({
					relation: relationName(ref.relation),
					fields: keyOf(ref.key),
					onUpdate: ref.onUpdate
				})),
				inserts: insertsOf(r)
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
			members: membersOf(role.members)
		}
	})
})

/**
 * Each role of a sketch as certification takes it, its relations' facts `relations`: its READ COMMITTED facts, and its
 * lowering to the sketch's SERIALIZABLE form; and what certification gives them.
 */
const certifiedOf = (sketch: Sketch, relations: IsolationInput["relations"]) =>
	certify(
		relations,
		Arr.map(inputOf(sketch).roles, (role, i): Candidate<undefined, undefined, never> => ({
			role,
			readCommitted: undefined,
			lower: () =>
				Result.ok({
					facts: membersOf(Arr.getUnsafe(sketch.roles, i).serializable),
					form: undefined
				})
		}))
	)

/** Every role's certificate (certifiedOf). */
const verdictsOf = (
	sketch: Sketch,
	relations: IsolationInput["relations"]
): ReadonlyArray<RoleIsolation> => {
	const certified = certifiedOf(sketch, relations)
	return certified.ok ? Arr.map(certified.value.roles, isolationOf) : certified.error
}

/** The fences certification states (certifiedOf). */
const fencesOf = (sketch: Sketch, relations: IsolationInput["relations"]): ReadonlyArray<Fence> => {
	const certified = certifiedOf(sketch, relations)
	return certified.ok ? certified.value.fences : certified.error
}

/** Fences by login, then relation, each in code-unit order. */
const fenceOrder: Order.Order<Fence> = Order.combine(
	Order.mapInput(Order.String, (f: Fence) => f.login),
	Order.mapInput(Order.String, (f: Fence) => f.relation)
)

/**
 * The fences the oracle expects at its fixpoint: for each relation a role it leaves READ COMMITTED checks by a held or
 * fenced check, one fence of each login that deletes it, naming those roles in their order, by login then relation.
 */
const expectedFences = (
	sketch: Sketch,
	expected: {
		readonly lowered: ReadonlySet<number>
		readonly verdicts: ReadonlyArray<OracleVerdict>
	}
): ReadonlyArray<Fence> => {
	const at = oracleRound(sketch, expected.lowered)
	const relying = new Map<number, Array<number>>()
	for (const [i, v] of expected.verdicts.entries()) {
		if (v.readCommitted) {
			for (const relation of at.lockedChecks(i)) {
				relying.set(relation, [...(relying.get(relation) ?? []), i])
			}
		}
	}
	return Arr.sort(
		Arr.flatMap([...relying], ([relation, readers]): ReadonlyArray<Fence> => {
			const roles = Arr.map(readers, (i) => ({
				login: `L${Arr.getUnsafe(sketch.roles, i).login}`,
				role: `r${i}`
			}))
			return Arr.isReadonlyArrayNonEmpty(roles)
				? Arr.map(at.fencers(relation), (login) => ({
						login: `L${login}`,
						relation: relationName(relation),
						for: roles
					}))
				: []
		}),
		fenceOrder
	)
}

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
					onEmpty: () => [[{ writes: [], reads: [e.read], probes: [], cores: [] }]],
					onNonEmpty: ([first, ...rest]) => [
						Arr.match(first, {
							onEmpty: () => [{ writes: [], reads: [e.read], probes: [], cores: [] }],
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
		case "served":
			return withRole(sketch, e.role, (r) => ({
				...r,
				serializable: [...r.serializable, e.member]
			}))
		case "role":
			return { ...sketch, roles: [...sketch.roles, e.role] }
		case "insert":
			return withRole(sketch, e.role, (r) => ({
				...r,
				members: [
					...r.members,
					[{ writes: [insertOf(e.relation, [])], reads: [], probes: [], cores: [] }]
				]
			}))
		case "triggerLaw":
			return withRelation(sketch, e.relation, (r) => ({ ...r, triggerLaws: true }))
		case "reference":
			return withRelation(sketch, e.relation, (r) => ({
				...r,
				references: [...r.references, e.reference]
			}))
		case "dropFact":
			return sketch
		case "race":
			return withRelation(sketch, e.relation, (r) => ({ ...r, race: r.keys.length > 0 }))
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
		case "served":
		case "privilege":
		case "role":
		case "triggerLaw":
		case "reference":
		case "dropFact":
		case "race":
			return false
	}
}

/** The certificates after a case's extension: a dropped fact leaves its relation out of the facts. */
const afterOf = (c: Case): ReadonlyArray<RoleIsolation> => {
	const sketch = extended(c.sketch, c.extension)
	const relations = inputOf(sketch).relations
	const e = c.extension
	return verdictsOf(
		sketch,
		e.kind === "dropFact"
			? new Map(Arr.filter([...relations], ([name]) => name !== relationName(e.relation)))
			: relations
	)
}

type OracleSeal = "arbiter" | "own" | "unwritten" | "arbitrated" | "sealed" | "fenced" | "unsealed"

/** A foreign key check a statement's write makes, restated: the relation it reads, which side, and its seal. */
interface OracleCheck {
	readonly at: number
	readonly relation: number
	readonly side: "referencing" | "referenced"
	readonly seal: OracleSeal
	/** The relation whose write makes the check. */
	readonly write: number
}

/**
 * Each condition stated over the sketch on its own, in a round where the roles of `lowered` are served both their forms
 * and every other role its READ COMMITTED form alone: `own(i)`, the conditions role i's own members fail, and
 * `given(judges, i)`, those the roles of `judges` but i give it; `absent(statements)`, the relations a member reads the
 * absence or a count of; and `written(i)`, the relations role i writes.
 */
const oracleRound = (sketch: Sketch, lowered: ReadonlySet<number>) => {
	const roles = sketch.roles
	const relations = sketch.relations
	const formsOf = (i: number): ReadonlyArray<ReadonlyArray<StatementSketch>> => {
		const role = Arr.getUnsafe(roles, i)
		return lowered.has(i) ? [...role.members, ...role.serializable] : role.members
	}
	const writesOf = (i: number) =>
		Arr.flatMap(formsOf(i), (statements) => Arr.flatMap(statements, (st) => st.writes))
	const reach = (from: ReadonlySet<number>): ReadonlySet<number> => {
		const out = new Set(from)
		for (let step = 0; step < RELATIONS; step += 1) {
			for (const [i, r] of relations.entries()) {
				if (Arr.some(r.references, (ref) => ref.onUpdate === "cascade" && out.has(ref.relation))) {
					out.add(i)
				}
			}
		}
		return out
	}
	const updatedOf = (i: number): ReadonlySet<number> =>
		reach(
			new Set([
				...Arr.flatMap(Arr.getUnsafe(roles, i).privileges, (p) =>
					p.privilege === "UPDATE" ? [p.relation] : []
				),
				...Arr.flatMap(writesOf(i), (w) => (w.op === "update" ? [w.relation] : []))
			])
		)
	const writtenSet = (i: number): ReadonlySet<number> =>
		new Set([
			...Arr.flatMap(Arr.getUnsafe(roles, i).privileges, (p) =>
				p.privilege === "SELECT" ? [] : [p.relation]
			),
			...Arr.map(writesOf(i), (w) => w.relation),
			...updatedOf(i)
		])
	/** What a role writes as another role's judge reads it: but by a retirement alone, which waits for every call that
	 * holds a group it retires and reads nothing besides. */
	const guardedSet = (i: number): ReadonlySet<number> =>
		new Set([
			...Arr.flatMap(Arr.getUnsafe(roles, i).privileges, (p) =>
				p.privilege === "SELECT" ? [] : [p.relation]
			),
			...Arr.flatMap(writesOf(i), (w) => (w.op === "retire" ? [] : [w.relation])),
			...updatedOf(i)
		])
	const anyWrites = (relation: number) => Arr.some(roles, (_, i) => writtenSet(i).has(relation))
	const changes = (relation: number) =>
		Arr.some(
			roles,
			(r, i) =>
				Arr.some(
					r.privileges,
					(p) => p.relation === relation && (p.privilege === "UPDATE" || p.privilege === "DELETE")
				) ||
				Arr.some(
					writesOf(i),
					(w) => w.relation === relation && (w.op === "update" || w.op === "delete")
				) ||
				updatedOf(i).has(relation)
		)
	const updates = (relation: number) => Arr.some(roles, (_, i) => updatedOf(i).has(relation))
	/** Whether some role of `login` holds a privilege on the relation, or serves a member, that writes it by `op`. */
	const loginWrites = (login: number, relation: number, op: "insert" | "delete") =>
		Arr.some(
			roles,
			(r, i) =>
				r.login === login &&
				(Arr.some(
					r.privileges,
					(p) => p.relation === relation && p.privilege === (op === "insert" ? "INSERT" : "DELETE")
				) ||
					Arr.some(writesOf(i), (w) => w.relation === relation && w.op === op))
		)
	/** Whether `login`'s roles delete the relation, by a privilege or a member, and no role updates it: the login fences
	 * it. */
	const fences = (login: number, relation: number) =>
		!updates(relation) && loginWrites(login, relation, "delete")
	/** Whether one login's roles both delete and insert the relation, by a privilege or a member. */
	const replaced = (relation: number) =>
		Arr.some(
			roles,
			(r) => loginWrites(r.login, relation, "delete") && loginWrites(r.login, relation, "insert")
		)
	const covers = (relation: number, fields: ReadonlyArray<string>) =>
		Arr.some(Arr.getUnsafe(relations, relation).keys, (k) =>
			Arr.every(keyOf(k), (f) => fields.includes(f))
		)
	const sealOfRead = (read: ReadSketch): OracleSeal => {
		if (read.own) {
			return "own"
		}
		if (!anyWrites(read.relation)) {
			return "unwritten"
		}
		const group = read.group
		const facts = Arr.getUnsafe(relations, read.relation)
		const keyed = group !== undefined && covers(read.relation, keyOf(group))
		if (read.mode === "arbiter") {
			return keyed && !changes(read.relation) ? "arbiter" : "unsealed"
		}
		if (group === undefined || read.rows === "many" || changes(read.relation)) {
			return "unsealed"
		}
		return facts.counted.includes(group) || keyed ? "sealed" : "unsealed"
	}
	/** Whether a read's seal is a point's: sealed, by a whole key, not as a counted group. */
	const isPoint = (read: ReadSketch): boolean =>
		sealOfRead(read) === "sealed" &&
		read.group !== undefined &&
		!Arr.getUnsafe(relations, read.relation).counted.includes(read.group)
	const checksOf = (statements: ReadonlyArray<StatementSketch>): ReadonlyArray<OracleCheck> =>
		Arr.flatMap(statements, (st, at) =>
			Arr.flatMap(st.writes, (w) => [
				...Arr.map(
					w.op === "delete" || w.op === "retire"
						? []
						: Arr.getUnsafe(relations, w.relation).references,
					(ref): OracleCheck => {
						const seal: OracleSeal = !anyWrites(ref.relation)
							? "unwritten"
							: !covers(ref.relation, keyOf(ref.key)) || updates(ref.relation)
								? "unsealed"
								: replaced(ref.relation)
									? "fenced"
									: "sealed"
						return { at, relation: ref.relation, side: "referencing", seal, write: w.relation }
					}
				),
				...(w.op === "insert" || w.op === "retire"
					? []
					: Arr.flatMap([...relations.entries()], ([i, r]): ReadonlyArray<OracleCheck> =>
							Arr.some(r.references, (ref) => ref.relation === w.relation)
								? [
										{
											at,
											relation: i,
											side: "referenced",
											seal: anyWrites(i) ? "unsealed" : "unwritten",
											write: w.relation
										}
									]
								: []
						))
			])
		)
	const isOutside = (seal: OracleSeal) =>
		seal === "sealed" || seal === "fenced" || seal === "unsealed"
	/** Whether a check of a member of a role of `login` is a fenced write's check of the rows that reference a row it
	 * deletes, which reads nothing conditions 2 and 3 weigh. */
	const fencedSite = (login: number, c: OracleCheck) =>
		c.side === "referenced" && fences(login, c.write)
	/**
	 * Whether every row of a core with row sources `sources` comes through reads `fits` admits: through some source, a
	 * read `fits` admits, a core whose own rows do, or a UNION each of whose arms does.
	 */
	const passes = (
		st: StatementSketch,
		sources: ReadonlyArray<RowSource>,
		fits: (r: ReadSketch) => boolean
	): boolean =>
		Arr.some(sources, (source) => {
			switch (source.kind) {
				case "read":
					return fits(Arr.getUnsafe(st.reads, source.read))
				case "core":
					return passes(st, Arr.getUnsafe(st.cores, source.core), fits)
				case "union":
					return Arr.every(source.arms, (arm) => passes(st, arm, fits))
			}
		})
	const groupName = (r: ReadSketch) =>
		r.group === undefined
			? `${r.relation}/-`
			: `${r.relation}/${Arr.join(
					Arr.map(keyOf(r.group), (f) => `${f}=${byOf(r, f)}`),
					","
				)}`
	/** The fields of a read's group, none where it binds none. */
	const fieldsOfRead = (r: ReadSketch): ReadonlyArray<string> =>
		r.group === undefined ? [] : keyOf(r.group)
	/**
	 * The row an arbitration fixes, where it fixes one: its relation's first declared key its group binds whole, of a
	 * relation not raced, or raced at that key, its first.
	 */
	const fixedKeyOf = (r: ReadSketch): ReadonlyArray<string> | undefined => {
		const relation = Arr.getUnsafe(relations, r.relation)
		const fields = fieldsOfRead(r)
		const key = Arr.findFirst(relation.keys, (k) => Arr.every(keyOf(k), (f) => fields.includes(f)))
		if (Option.isNone(key)) {
			return undefined
		}
		const raced = Arr.head(relation.keys)
		return !relation.race || (Option.isSome(raced) && raced.value === key.value)
			? keyOf(key.value)
			: undefined
	}
	/**
	 * A member's reads, each with its seal, an arbitrated one among them where an earlier statement of a prefix reading
	 * only own rows and arbitrations arbitrated a key whose row it fixes, each field of which the read binds as the
	 * arbitration did, and its mode, its base where every probe above it is neutral.
	 */
	const placedOf = (statements: ReadonlyArray<StatementSketch>) => {
		const fixed: Array<{
			readonly at: number
			readonly read: ReadSketch
			readonly key: ReadonlyArray<string>
		}> = []
		for (const [at, st] of statements.entries()) {
			if (
				Arr.some(st.reads, (r) => {
					const seal = sealOfRead(r)
					return seal !== "own" && seal !== "arbiter"
				})
			) {
				break
			}
			for (const r of st.reads) {
				const key = fixedKeyOf(r)
				if (
					r.mode === "arbiter" &&
					sealOfRead(r) === "arbiter" &&
					r.group !== undefined &&
					r.rows === "one" &&
					key !== undefined
				) {
					fixed.push({ at, read: r, key })
				}
			}
		}
		return Arr.map(statements, (st, at) => {
			const sealed = Arr.map(st.reads, (read, index) => {
				const fields = fieldsOfRead(read)
				const arbitrated = Arr.some(
					fixed,
					(f) =>
						f.at < at &&
						f.read.relation === read.relation &&
						Arr.every(f.key, (k) => fields.includes(k) && byOf(read, k) === byOf(f.read, k))
				)
				const seal: OracleSeal = isPoint(read) && arbitrated ? "arbitrated" : sealOfRead(read)
				return { at, index, read, seal }
			})
			const neutral = (probe: number): boolean =>
				Arr.every(sealed, ({ read, seal }) => {
					if (!read.probes.includes(probe) || !isOutside(seal)) {
						return true
					}
					const g = groupName(read)
					const p = Arr.getUnsafe(st.probes, probe)
					const core = p.core
					return (
						seal !== "unsealed" &&
						Arr.some(
							st.reads,
							(r) => r.probes.length === 0 && r.mode === "positive" && groupName(r) === g
						) &&
						Arr.every(
							st.writes,
							(w, k) =>
								!p.gates.includes(k) ||
								Arr.some(st.reads, (r, i) => w.from.includes(i) && groupName(r) === g)
						) &&
						core !== undefined &&
						passes(
							st,
							Arr.getUnsafe(st.cores, core),
							(r) =>
								Arr.join(Arr.map(r.probes, String), ",") ===
									Arr.join(Arr.map(p.chain, String), ",") &&
								baseOf(r) === "positive" &&
								groupName(r) === g
						)
					)
				})
			return Arr.map(sealed, (p) => ({
				...p,
				mode: Arr.every(p.read.probes, neutral) ? baseOf(p.read) : p.read.mode
			}))
		})
	}
	/** The relations a member of a role of `login` reads the absence or a count of, by a statement or the check of a
	 * changed row, but a fenced write's. */
	const absent = (statements: ReadonlyArray<StatementSketch>, login: number): ReadonlySet<number> =>
		new Set([
			...Arr.flatMap(placedOf(statements), (placed) =>
				Arr.flatMap(placed, (p) =>
					p.mode === "negated" ||
					p.mode === "counted" ||
					(p.mode === "arbiter" && p.seal === "unsealed")
						? [p.read.relation]
						: []
				)
			),
			...Arr.flatMap(checksOf(statements), (c) =>
				c.side === "referenced" && !fencedSite(login, c) ? [c.relation] : []
			)
		])
	/** Whether a check's seal is a held or a fenced one's, of a relation no role updates (a point's never meets a fence). */
	const locked = (c: OracleCheck) =>
		c.seal === "fenced" || (c.seal === "sealed" && changes(c.relation))
	/** The relations a role reads from outside by held or fenced checks alone, none by a statement or another check. */
	const lockedOnly = (role: RoleSketch): ReadonlySet<number> => {
		const checks = Arr.flatMap(role.members, (statements) =>
			Arr.filter(checksOf(statements), (c) => isOutside(c.seal))
		)
		const others = new Set([
			...Arr.flatMap(role.members, (statements) =>
				Arr.flatMap(placedOf(statements), (placed) =>
					Arr.flatMap(placed, (p) => (isOutside(p.seal) ? [p.read.relation] : []))
				)
			),
			...Arr.flatMap(checks, (c) => (locked(c) ? [] : [c.relation]))
		])
		return new Set(
			Arr.flatMap(checks, (c) => (locked(c) && !others.has(c.relation) ? [c.relation] : []))
		)
	}
	/** The relations role i's READ COMMITTED members check by a held or fenced check. */
	const lockedChecks = (i: number): ReadonlySet<number> =>
		new Set(
			Arr.flatMap(Arr.getUnsafe(roles, i).members, (statements) =>
				Arr.flatMap(checksOf(statements), (c) => (locked(c) ? [c.relation] : []))
			)
		)
	/** The logins that fence the relation, each once. */
	const fencers = (relation: number): ReadonlyArray<number> =>
		Arr.filter([...new Set(Arr.map(roles, (r) => r.login))], (login) => fences(login, relation))
	const outsideReads = (role: RoleSketch): ReadonlySet<number> =>
		new Set(
			Arr.flatMap(role.members, (statements) => [
				...Arr.flatMap(placedOf(statements), (placed) =>
					Arr.flatMap(placed, (p) => (isOutside(p.seal) ? [p.read.relation] : []))
				),
				...Arr.flatMap(checksOf(statements), (c) => (isOutside(c.seal) ? [c.relation] : []))
			])
		)
	const own = (i: number): ReadonlySet<IsolationCondition> => {
		const role = Arr.getUnsafe(roles, i)
		const failed = new Set<IsolationCondition>()
		if (role.members.length === 0) {
			failed.add("members")
		}
		if (
			Arr.some(role.privileges, (p) => p.privilege === "UPDATE" || p.privilege === "DELETE") ||
			Arr.some([...writtenSet(i)], changes)
		) {
			failed.add("privileges")
		}
		for (const relation of writtenSet(i)) {
			if (Arr.getUnsafe(relations, relation).triggerLaws) {
				failed.add("laws")
			}
		}
		for (const relation of guardedSet(i)) {
			if (
				Arr.some(roles, (other, r) =>
					Arr.some(formsOf(r), (statements) => absent(statements, other.login).has(relation))
				)
			) {
				failed.add("absence")
			}
		}
		for (const statements of role.members) {
			const placed = placedOf(statements)
			const outs = Arr.flatMap(placed, (ps) => Arr.filter(ps, (p) => isOutside(p.seal)))
			const checks = Arr.filter(checksOf(statements), (c) => isOutside(c.seal))
			if (
				Arr.some(
					outs,
					(p) =>
						p.seal === "unsealed" && (Arr.some(outs, (o) => o.at !== p.at) || checks.length > 0)
				) ||
				Arr.some(
					checks,
					(c, k) =>
						c.seal === "unsealed" && (outs.length > 0 || Arr.some(checks, (_, j) => j !== k))
				)
			) {
				failed.add("snapshot")
			}
			if (Arr.some(checks, (c) => c.seal === "unsealed")) {
				failed.add("pivot")
			}
			const writes = Arr.flatMap(statements, (st, at) => Arr.map(st.writes, (w) => ({ at, w })))
			if (outs.length > 0 && writes.length > 0) {
				if (Arr.some(outs, (o) => o.seal === "unsealed" || o.mode !== "positive")) {
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
					const ps = Arr.getUnsafe(placed, at)
					const joinedOwn = Arr.some(
						ps,
						(p) => p.seal === "own" && p.mode === "positive" && w.from.includes(p.index)
					)
					const joined = new Set(
						Arr.flatMap(ps, (p) => (w.from.includes(p.index) ? [groupName(p.read)] : []))
					)
					if (Arr.some(outs, (o) => o.at === at && !joined.has(groupName(o.read)))) {
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
	const given = (judges: ReadonlySet<number>, i: number): ReadonlySet<IsolationCondition> => {
		const written = writtenSet(i)
		const reads = outsideReads(Arr.getUnsafe(roles, i))
		const lockedReads = lockedOnly(Arr.getUnsafe(roles, i))
		const out = new Set<IsolationCondition>()
		for (const o of Arr.filter([...judges], (x) => x !== i)) {
			const login = Arr.getUnsafe(roles, o).login
			if (
				Arr.some(
					formsOf(o),
					(statements) =>
						Arr.some(statements, (st) => Arr.some(st.reads, (r) => written.has(r.relation))) ||
						Arr.some(checksOf(statements), (c) => written.has(c.relation) && !fencedSite(login, c))
				)
			) {
				out.add("laws")
			}
			const shared = Arr.some(
				[...guardedSet(o)],
				(x) => reads.has(x) && !(lockedReads.has(x) && fences(login, x))
			)
			const pivot =
				Arr.some(formsOf(o), (statements) =>
					Arr.some(placedOf(statements), (placed) => Arr.some(placed, (p) => isOutside(p.seal)))
				) ||
				Arr.some(formsOf(o), (statements) =>
					Arr.some(
						checksOf(statements),
						(c) => isOutside(c.seal) && (c.side === "referenced" || c.seal === "unsealed")
					)
				) ||
				Arr.some([...writtenSet(o)], (x) => Arr.getUnsafe(relations, x).triggerLaws)
			if ((shared && pivot) || Arr.some([...guardedSet(o)], (x) => written.has(x))) {
				out.add("writers")
			}
		}
		return out
	}
	return { own, given, absent, written: writtenSet, replaced, lockedChecks, fencers }
}

/** One role's level and conditions as the oracle finds them. */
interface OracleVerdict {
	readonly readCommitted: boolean
	readonly failed: ReadonlySet<IsolationCondition>
	readonly own: ReadonlySet<IsolationCondition>
}

/**
 * One round as the oracle runs it: every role outside `lowered` judged over its READ COMMITTED form, the roles of
 * `lowered` served both forms and SERIALIZABLE, and the judged roles left READ COMMITTED the greatest set that meet
 * their own conditions none of whose members a role outside it gives a reason, found by trying every subset. A judged
 * role's conditions are its own where it fails any, else those the round's other SERIALIZABLE roles give it.
 */
const judgedRound = (
	sketch: Sketch,
	lowered: ReadonlySet<number>
): ReadonlyMap<number, OracleVerdict> => {
	const at = oracleRound(sketch, lowered)
	const judged = Arr.flatMap(sketch.roles, (_, i) =>
		lowered.has(i) ? [] : [{ i, own: at.own(i) }]
	)
	const candidates = Arr.flatMap(judged, (j) => (j.own.size === 0 ? [j.i] : []))
	const all = new Set(Arr.map(sketch.roles, (_, i) => i))
	let best = new Set<number>()
	for (let mask = 0; mask < 1 << candidates.length; mask += 1) {
		const set = new Set(Arr.filter(candidates, (_, b) => (mask & (1 << b)) !== 0))
		const outside = new Set(Arr.filter([...all], (i) => !set.has(i)))
		if (Arr.every([...set], (i) => at.given(outside, i).size === 0)) {
			best = new Set([...best, ...set])
		}
	}
	const outside = new Set(Arr.filter([...all], (i) => !best.has(i)))
	return new Map(
		Arr.map(
			judged,
			({ i, own }) =>
				[
					i,
					{ readCommitted: best.has(i), failed: own.size > 0 ? own : at.given(outside, i), own }
				] as const
		)
	)
}

/**
 * The oracle: rounds from none lowered, each lowering the roles it judges SERIALIZABLE with that round's conditions,
 * until one lowers none; with the roles lowered, by the round that lowered them, a role's own form never among the
 * facts it was judged by.
 */
const oracle = (sketch: Sketch) => {
	const lowered = new Map<number, OracleVerdict>()
	const rounds = new Map<number, number>()
	for (let at = 0; ; at += 1) {
		const round = judgedRound(sketch, new Set(lowered.keys()))
		const fresh = Arr.filter([...round], ([, v]) => !v.readCommitted)
		if (fresh.length === 0) {
			return {
				lowered: new Set(lowered.keys()),
				rounds,
				verdicts: Arr.map(sketch.roles, (_, i) =>
					defined(lowered.get(i) ?? round.get(i), `the oracle's verdict of r${i}`)
				)
			}
		}
		for (const [i, v] of fresh) {
			lowered.set(i, v)
			rounds.set(i, at)
		}
	}
}

/**
 * Whether lowered role i's SERIALIZABLE form alone reads the absence or a count of a relation it writes, among the
 * forms the roles of `lowered` are served: no READ COMMITTED form does, nor another lowered role's.
 */
const absenceOfItsOwnLowering = (
	sketch: Sketch,
	lowered: ReadonlySet<number>,
	i: number
): boolean => {
	const at = oracleRound(sketch, lowered)
	return Arr.some(
		[...at.written(i)],
		(x) =>
			Arr.some(Arr.getUnsafe(sketch.roles, i).serializable, (sts) =>
				at.absent(sts, Arr.getUnsafe(sketch.roles, i).login).has(x)
			) &&
			!Arr.some(sketch.roles, (r, j) =>
				Arr.some(j !== i && lowered.has(j) ? [...r.members, ...r.serializable] : r.members, (sts) =>
					at.absent(sts, r.login).has(x)
				)
			)
	)
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
	| "a read of one group per own row"
	| "a foreign key check beside a READ COMMITTED role"
	| "a held foreign key check beside a READ COMMITTED role"
	| "a check of a relation one login deletes and inserts"
	| "a fence a READ COMMITTED role relies on"
	| "a check of the rows that reference a changed one"
	| "a retirement"
	| "an update carried by a cascading foreign key"
	| `the ${Exclude<Shape, "drawn">}`
	| "a fact dropped beside a READ COMMITTED role"
	| "a dropped fact a SERIALIZABLE role's level rests on alone"
	| "a role whose lowered form alone reads the absence of what it writes"
	| "a role lowered in a later round"

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

/**
 * The fixed shapes, each a required feature by its name, which the search draws within its coverage budget.
 */
const shapes: ReadonlyArray<Exclude<Shape, "drawn">> = [
	"copiers",
	"pointCopiers",
	"absentThenInsert",
	"chain",
	"seals",
	"pivotWriter",
	"laggingReader",
	"listReader",
	"refusedCopy",
	"deferredCopy",
	"lateWriter",
	"cascadedWriter",
	"sharedWriter",
	"protocolSealed",
	"protocolUnsealed",
	"absentGate",
	"arbitratedRead",
	"arbitratedGated",
	"keyMatched",
	"keyUnmatched",
	"keyPartial",
	"raceOtherKey",
	"repeatableOtherKey",
	"fallbackUnion",
	"fallbackCount",
	"unjoinedGate",
	"chainedPath",
	"unionSealed",
	"unionOtherKey",
	"unionOtherRelation",
	"unionRecursion",
	"arbiterPath",
	"publication",
	"servedCause",
	"servedUpdate",
	"servedAbsence",
	"servedOwn",
	"loweredAbsence",
	"loweredCause",
	"triggered",
	"droppedReference",
	"heldCheck",
	"fencedCheck",
	"updatedCheck",
	"fencedPublisher",
	"unfencedPivot",
	"fencedDeleter",
	"updatedDeleter"
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
		case "arbitrated":
		case "held":
		case "fenced":
		case "unsealed":
			return undefined
	}
}

/** The roles a counterexample must leave SERIALIZABLE. */
const counterexampleRoles = (shape: Shape): ReadonlyArray<number> => {
	switch (shape) {
		case "copiers":
		case "pointCopiers":
		case "publication":
		case "servedCause":
		case "servedAbsence":
			return [0, 1]
		case "servedUpdate":
		case "loweredAbsence":
		case "loweredCause":
			return [0, 1, 2]
		case "absentThenInsert":
			return [2]
		case "chain":
			return [1, 2]
		case "pivotWriter":
			return [1]
		case "laggingReader":
		case "listReader":
		case "refusedCopy":
			return [0, 1]
		case "deferredCopy":
		case "lateWriter":
		case "sharedWriter":
		case "arbitratedGated":
		case "keyUnmatched":
		case "keyPartial":
		case "raceOtherKey":
			return [0]
		case "protocolUnsealed":
		case "absentGate":
		case "fallbackUnion":
		case "fallbackCount":
		case "unjoinedGate":
		case "chainedPath":
		case "unionOtherKey":
		case "unionOtherRelation":
		case "unionRecursion":
		case "arbiterPath":
			return [0, 1]
		case "cascadedWriter":
			return [1]
		case "updatedCheck":
		case "unfencedPivot":
		case "updatedDeleter":
			return [0]
		case "drawn":
		case "seals":
		case "protocolSealed":
		case "unionSealed":
		case "servedOwn":
		case "arbitratedRead":
		case "keyMatched":
		case "repeatableOtherKey":
		case "triggered":
		case "droppedReference":
		case "heldCheck":
		case "fencedCheck":
		case "fencedPublisher":
		case "fencedDeleter":
			return []
	}
}

/** The roles a shape the certifier must prove runs READ COMMITTED: a key-matched read of a race's winner, and a
 * repeatable insertion's probed key. */
const certifiedRoles = (shape: Shape): ReadonlyArray<number> =>
	shape === "keyMatched" || shape === "repeatableOtherKey" ? [0, 1] : []

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
							name: "every condition restated over the drawn facts, in rounds each the greatest of every subset"
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
								"a read of one group per own row",
								"a foreign key check beside a READ COMMITTED role",
								"a held foreign key check beside a READ COMMITTED role",
								"a check of a relation one login deletes and inserts",
								"a fence a READ COMMITTED role relies on",
								"a check of the rows that reference a changed one",
								"a retirement",
								"an update carried by a cascading foreign key",
								...Arr.map(shapes, (s) => `the ${s}` as const),
								"a fact dropped beside a READ COMMITTED role",
								"a dropped fact a SERIALIZABLE role's level rests on alone",
								"a role whose lowered form alone reads the absence of what it writes",
								"a role lowered in a later round"
							],
							{ cases: 500, sense: notesOnly }
						),
						kept: [],
						runs: 500,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const input = inputOf(c.sketch)
							const verdicts = verdictsOf(c.sketch, input.relations)
							const expected = oracle(c.sketch)
							const fences = fencesOf(c.sketch, input.relations)
							assert.deepEqual(
								fences,
								expectedFences(c.sketch, expected),
								"the fences the READ COMMITTED roles' fenced checks rely on"
							)
							if (fences.length > 0) {
								k.note("a fence a READ COMMITTED role relies on")
							}
							for (const [i, v] of verdicts.entries()) {
								const o = Arr.getUnsafe(expected.verdicts, i)
								assert.equal(
									v.certificate.level,
									o.readCommitted ? "readCommitted" : "serializable",
									`${v.role}'s level`
								)
								assert.deepEqual(
									Arr.getUnsafe(
										verdictsOf(
											withRole(c.sketch, i, (r) => ({ ...r, serializable: [] })),
											input.relations
										),
										i
									),
									v,
									`${v.role}'s certificate is the same without its own SERIALIZABLE form`
								)
								if (v.certificate.level === "serializable") {
									const named = new Set(Arr.map(v.certificate.reasons, (r) => r.condition))
									assert.deepEqual(
										Arr.filter(everyCondition, (x) => named.has(x)),
										Arr.filter(everyCondition, (x) => o.failed.has(x)),
										`${v.role} names exactly the conditions of the round that lowered it`
									)
									const judges = new Set(Arr.filter([...expected.lowered], (j) => j !== i))
									const at = oracleRound(c.sketch, judges)
									const still = new Set([...at.own(i), ...at.given(judges, i)])
									for (const r of named) {
										assert.ok(
											still.has(r),
											`${v.role} still fails ${r}, which lowered it, at the fixpoint`
										)
										k.note(`a role SERIALIZABLE by ${r}`)
									}
									if (o.own.size === 0) {
										k.note("a role SERIALIZABLE only through roles that run SERIALIZABLE")
									}
									if (defined(expected.rounds.get(i), `the round that lowered ${v.role}`) > 0) {
										k.note("a role lowered in a later round")
									}
									if (absenceOfItsOwnLowering(c.sketch, expected.lowered, i)) {
										k.note("a role whose lowered form alone reads the absence of what it writes")
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
											if (
												Arr.some(
													st.writes,
													(w) =>
														(w.op === "insert" || w.op === "update") &&
														Arr.getUnsafe(c.sketch.relations, w.relation).references.length > 0
												)
											) {
												k.note("a foreign key check beside a READ COMMITTED role")
											}
											if (
												Arr.some(
													st.writes,
													(w) =>
														(w.op === "insert" || w.op === "update") &&
														Arr.some(
															Arr.getUnsafe(c.sketch.relations, w.relation).references,
															(ref) => deletedIn(c.sketch, ref.relation)
														)
												)
											) {
												k.note("a held foreign key check beside a READ COMMITTED role")
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
							for (const i of certifiedRoles(c.shape)) {
								assert.equal(
									Arr.getUnsafe(levelsOf(verdicts), i),
									"readCommitted",
									`the ${c.shape}'s role r${i} runs READ COMMITTED`
								)
							}
							const settled = oracleRound(c.sketch, expected.lowered)
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
											if (read.group !== undefined && read.rows === "many" && !read.own) {
												k.note("a read of one group per own row")
											}
										}
										for (const w of st.writes) {
											if (
												(w.op === "insert" || w.op === "update") &&
												Arr.some(Arr.getUnsafe(c.sketch.relations, w.relation).references, (ref) =>
													settled.replaced(ref.relation)
												)
											) {
												k.note("a check of a relation one login deletes and inserts")
											}
											const referencing = Arr.filter(c.sketch.relations, (r) =>
												Arr.some(r.references, (ref) => ref.relation === w.relation)
											)
											if ((w.op === "update" || w.op === "delete") && referencing.length > 0) {
												k.note("a check of the rows that reference a changed one")
											}
											if (w.op === "retire") {
												k.note("a retirement")
											}
											if (
												w.op === "update" &&
												Arr.some(referencing, (r) =>
													Arr.some(
														r.references,
														(ref) => ref.relation === w.relation && ref.onUpdate === "cascade"
													)
												)
											) {
												k.note("an update carried by a cascading foreign key")
											}
										}
									}
								}
							}
							const first = givesFirstMember(c.sketch, c.extension)
							if (first) {
								k.note("a first change member given to a role with none")
							}
							const after = levelsOf(afterOf(c))
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
								).verdicts
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
