/** What the properties of certify.test.ts read: its spaces, models and helpers. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int, shuffled, subset, weighted } from "@bjornpagen/testing/gen"
import type { Source } from "@bjornpagen/testing/source"
import { regex } from "arkregex"
import { Array as Arr, Option, Order, String as Str } from "effect"
import {
	type Candidate,
	certify,
	type Fence,
	isolationOf,
	readModes,
	type ReadSeal,
	readSeal
} from "#compiler/analysis/isolation/certify.ts"
import {
	type BodyFacts,
	type Binding,
	bindingText,
	type CteFacts,
	type CteUse,
	type InsertsFact,
	type IsolationInput,
	type MemberFacts,
	type ReadAt,
	type ReadFact,
	type RoleFacts,
	type RoleWrites,
	type RowSource,
	type SiteCore,
	type StatementFacts,
	type Unformed
} from "#compiler/analysis/isolation/facts.ts"
import {
	type IsolationCondition,
	type IsolationReason,
	type ReasonAt,
	type RoleIsolation
} from "#compiler/core/certificate.ts"
import type { TablePrivilege } from "#compiler/core/privilege.ts"
import { expanded, type FlatRowSource } from "#test/support/expanded.ts"
import { wild } from "#test/support/kernel/naming.ts"
import { upTo } from "#test/support/up-to.ts"

const RELATIONS = 4

const KEYS: ReadonlyArray<Arr.NonEmptyReadonlyArray<string>> = [["k0"], ["k1"], ["k0", "k1"]]

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
	readonly cores: ReadonlyArray<ReadonlyArray<FlatRowSource>>
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

/**
 * One shape of a rule over a query's violation (analysis/theory/query.ts Witness), by relation: one row of each of
 * `rows`, present, rows of `present` present beyond those, and rows of `absent` absent.
 */
interface WitnessSketch {
	readonly rows: Arr.NonEmptyReadonlyArray<number>
	readonly present: ReadonlyArray<number>
	readonly absent: ReadonlyArray<number>
}

/** A rule over a query its triggers hold, by its witnesses. */
type LawSketch = Arr.NonEmptyReadonlyArray<WitnessSketch>

/**
 * A relation: the rules over queries stated at it, each a fact of every relation its witnesses read and of it (the law
 * model's triggerLawsOver), its declared keys among KEYS, its counted groups and foreign keys, whether its first key is
 * raced (InsertsFact `race`), which only a relation with a key is.
 */
interface RelationSketch {
	readonly triggerLaws: ReadonlyArray<LawSketch>
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
	| { readonly kind: "triggerLaw"; readonly relation: number; readonly law: LawSketch }
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
	| "directReached"
	| "directUnreached"
	| "fencedDeleter"
	| "updatedDeleter"
	| "monotoneWriter"
	| "monotoneCure"
	| "monotoneDeleted"
	| "monotoneSelfJoin"
	| "monotonePresent"
	| "monotoneProbed"
	| "newlyFenced"
	| "newlyFencedRead"

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

/** The cores a drawn statement holds, core 0 its outermost. */
const CORES = 3

/**
 * The row sources of a statement's core `core` of `reads` reads: some of them, a later core, and, `depth` above none,
 * a UNION of two arms drawn alike, so every core refers to later ones alone.
 */
const sourcesGen =
	(reads: number, core: number, depth: number): Gen<ReadonlyArray<FlatRowSource>> =>
	(s) => [
		...Arr.map(
			s.draw(
				subset(
					upTo(reads, (i) => i),
					{ min: 0, max: reads }
				)
			),
			(read): FlatRowSource => ({ kind: "read", read })
		),
		...(core + 1 < CORES
			? s.draw(
					weighted<ReadonlyArray<FlatRowSource>>([
						[2, () => []],
						[1, (t) => [{ kind: "core", core: t.draw(int(core + 1, CORES - 1)) }]]
					])
				)
			: []),
		...(depth > 0
			? s.draw(
					weighted<ReadonlyArray<FlatRowSource>>([
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
			weighted<ReadonlyArray<LawSketch>>([
				[1, (t) => [t.draw(lawGen)]],
				[4, () => []]
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

/** Some relations, none to `max`, each drawn on its own. */
const relationsGen = (max: number): Gen<ReadonlyArray<number>> =>
	array(relationGen, { min: 0, max })

/** A witness: one or two rows of matches, an absence of none to two relations, rarely a presence beyond them. */
const witnessGen: Gen<WitnessSketch> = (s) => ({
	rows: [s.draw(relationGen), ...s.draw(relationsGen(1))],
	present: s.draw(
		weighted<ReadonlyArray<number>>([
			[4, () => []],
			[1, (t) => [t.draw(relationGen)]]
		])
	),
	absent: s.draw(relationsGen(2))
})

const lawGen: Gen<LawSketch> = (s) => [
	s.draw(witnessGen),
	...s.draw(array(witnessGen, { min: 0, max: 1 }))
]

const sketchGen: Gen<Sketch> = (s) => ({
	relations: Arr.makeBy(RELATIONS, () => s.draw(relationSketchGen)),
	roles: s.draw(array(roleGen, { min: 1, max: 4 }))
})

const clean = (keys: ReadonlyArray<number>): RelationSketch => ({
	triggerLaws: [],
	keys,
	race: false,
	counted: [],
	references: []
})

/** A rule over a query whose one witness reads two rows of `relation`, a self-join: any insert of it breaks the rule
 * through two occurrences it can make true. */
const selfJoined = (relation: number): LawSketch => [
	{ rows: [relation, relation], present: [], absent: [] }
]

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
			...clean(i === b || i === a ? [2] : []),
			counted: i === c ? [0] : [],
			references: i === a ? [{ relation: b, key: 2, onUpdate: "noAction" as const }] : []
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

/** A role that only inserts into a relation a self-joined trigger-held law reads, and that relation's fact dropped. */
const triggeredGen: Gen<Case> = (s) => {
	const x = s.draw(relationGen)
	return {
		sketch: {
			relations: Arr.makeBy(RELATIONS, (i) => ({
				...clean([]),
				triggerLaws: i === x ? [selfJoined(x)] : []
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
 * A pivot's fence, and its bound, built. L0's r0 inserts A beside reading D's absence and inserts D, so it runs
 * SERIALIZABLE and may miss another call's write; L1's r2 inserts C, which references B, joined with a read of B. L0's
 * r1 inserts B, and reads A one of two ways. The extension adds a role of L0 that deletes A, so L0 both deletes and
 * inserts A.
 *
 * - `check` (the newlyFenced shape): B references A, so r1 reads A by its insert's foreign key check, a point, sealed.
 *   L0 fences A for r1 as r0's login, and r1 runs READ COMMITTED before the extension and after it, its check then
 *   fenced: no level rests on a fence (the monotonicity property). Before pivots fenced, this was the one relaxation
 *   the monotonicity property let through, TEST_SEED=3958976376's rotating case 421, shrunk (8acf7cdf).
 * - `plain` (the newlyFencedRead shape): B references nothing; r1 reads A at its key in a member of its own, which
 *   writes nothing, so the read, unsealed once A is deleted, meets no condition of r1's own, and inserts B in another.
 *   A fence covers a sealed check alone, so r1 relies on no fence (Fence.for leaves it out) and keeps 5c's reason
 *   against r0: it stays SERIALIZABLE. A 5c that spared any read of a fenced relation would relax it, unsoundly.
 *
 * The relations A to D are placed by a drawn permutation.
 */
const newlyFencedGen =
	(how: "check" | "plain"): Gen<Case> =>
	(s) => {
		const [a = 0, b = 1, c = 2, d = 3] = s.draw(shuffled([0, 1, 2, 3], { min: 4, max: 4 }))
		const read = (relation: number, mode: ReadSketch["mode"]): ReadSketch => ({
			relation,
			mode,
			own: false,
			group: 0,
			binding: 0,
			split: false,
			rows: "one",
			probes: []
		})
		const statement = (
			writes: ReadonlyArray<WriteSketch>,
			reads: ReadonlyArray<ReadSketch>
		): StatementSketch => ({ writes, reads, probes: [], cores: [] })
		const references = (i: number): ReadonlyArray<ReferenceSketch> =>
			i === b && how === "check"
				? [{ relation: a, key: 0, onUpdate: "noAction" }]
				: i === c
					? [{ relation: b, key: 0, onUpdate: "noAction" }]
					: []
		return {
			sketch: {
				relations: Arr.makeBy(RELATIONS, (i) => ({ ...clean([0]), references: references(i) })),
				roles: [
					{
						login: 0,
						serializable: [],
						privileges: [
							{ relation: a, privilege: "INSERT" },
							{ relation: d, privilege: "INSERT" }
						],
						members: [
							[statement([insertOf(a, [])], [read(d, "negated")])],
							[statement([insertOf(d, [])], [])]
						]
					},
					{
						login: 0,
						serializable: [],
						privileges: [{ relation: b, privilege: "INSERT" }],
						members:
							how === "check"
								? [[statement([insertOf(b, [])], [])]]
								: [[statement([], [read(a, "positive")])], [statement([insertOf(b, [])], [])]]
					},
					{
						login: 1,
						serializable: [],
						privileges: [{ relation: c, privilege: "INSERT" }],
						members: [[statement([insertOf(c, [0])], [read(b, "positive")])]]
					}
				]
			},
			shape: how === "check" ? "newlyFenced" : "newlyFencedRead",
			extension: {
				kind: "role",
				role: {
					login: 0,
					serializable: [],
					privileges: [],
					members: [[statement([{ relation: a, op: "delete", from: [] }], [])]]
				}
			}
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
 * check misses m1's A(k) in flight and refuses, after m2 committed (NEGATION's case 3). W's login fences A, so m1 locks
 * it before its snapshot: C's check either committed before m1's lock, and m1's snapshot then sees m2, which committed
 * before C began, or takes its snapshot after m1 committed and finds A(k). C runs READ COMMITTED, W SERIALIZABLE.
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
								Arr.map(other, (_, i): FlatRowSource => ({ kind: "read", read: 1 + i })),
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
	relations: [clean([0]), clean([0]), { ...clean([0]), triggerLaws: [selfJoined(2)] }, clean([0])],
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
 * another call's write; r1 publishes, inserting into P, whose foreign key references Q's key, so its check of Q is a
 * sealed check, which r0's login fences as a pivot's; r2 inserts into L, referencing P's key, and reads P at its key.
 * r1's own check of Q, sealed, finds an immutable row, so r1 is no pivot cause, and r1 and r2 run READ COMMITTED;
 * without the fence, r1 at READ COMMITTED would see r0's in-flight row of Q refused while r0 commits, which no serial
 * order in real time explains.
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
 * it from r2's login (`fenced`), or updating it (`updated`); r2 inserts into R(a). r1 writes by direct SQL alone, so
 * its writes are unknown (facts.ts RoleWrites): a transaction of it may read what its grants reach, R(a), for its
 * absence, so it may miss another call's write, delete R(a) at the key r0's check finds and, from r2's login, insert it
 * again, and take no fence grizzle serves. r0's check of R(a) is unsealed (certify.ts referencingSeal), so r0 runs
 * SERIALIZABLE, though r1's grants never reach R(b). A deleter by a member keeps r0 READ COMMITTED with its fence
 * (fencedDeleter, fencedPublisher). An update may move the key: r0's check is unsealed by it too.
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
 * NEGATION's case 3 beside a fence: r1 deletes and inserts R(a) by its privileges alone, and r3, of the other login,
 * inserts R(a) where it reads R(c) absent, so it may miss another call's write. r0's fenced check of R(a) could miss
 * r3's row in flight and refuse r0, which no serial order in real time explains once r3's read missed a write
 * committed before r0 began, so r3's login fences R(a) too; but r1 serves no member, so its writes are unknown, a
 * direct replace of R(a) that takes no fence, and r0's check of R(a) is unsealed: r0 runs SERIALIZABLE.
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

/**
 * A direct writer beside an insert-only role: r0 inserts into R(b), which no other role writes; r1 serves no member, so
 * it writes by direct SQL alone, deleting and inserting R(a), which no foreign key joins to R(b), and, where its grants
 * reach R(b) (`reached`), holding SELECT on it. A transaction of r1 reads only what its grants let it read
 * (facts.ts RoleWrites `readable`): where they reach R(b) it may read R(b)'s absence and miss r0's row, condition 3, so
 * r0 runs SERIALIZABLE; where they do not, PostgreSQL refuses its read of R(b) with 42501 before it reads a row, nothing
 * of r1 meets r0, and r0 runs READ COMMITTED (`unreached`: test/pg/write/met's rc beside its direct deleter, and the
 * write races' inserter and claimer beside theirs).
 */
const directWriterOf = (s: Source, reach: "reached" | "unreached"): Sketch => {
	const [a, b] = threeOf(s)
	return {
		relations: Arr.makeBy(RELATIONS, () => clean([0])),
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
					...(reach === "reached" ? [{ relation: b, privilege: "SELECT" as const }] : [])
				],
				members: []
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
				[1, (t) => ({ kind: "triggerLaw", relation: t.draw(relationGen), law: t.draw(lawGen) })],
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

type MonotoneShape = Extract<
	Shape,
	| "monotoneWriter"
	| "monotoneCure"
	| "monotoneDeleted"
	| "monotoneSelfJoin"
	| "monotonePresent"
	| "monotoneProbed"
>

/** DENSEATS's repro and its neighbours (monotoneOf), drawn as one arm of the shapes. */
const monotoneShapes: Arr.NonEmptyReadonlyArray<MonotoneShape> = [
	"monotoneWriter",
	"monotoneCure",
	"monotoneDeleted",
	"monotoneSelfJoin",
	"monotonePresent",
	"monotoneProbed"
]

/**
 * DENSEATS's repro over R0 (R), R1 (E) and R2, which no role writes (a closed relation's place): the rule over a query
 * whose one witness reads one row of R and of R2 and the absence of E (`Live = R where not E`, `check(Live, n <
 * C.at(...))`), which r0 breaks by inserting R. As the writer, r0 inserts R and E and runs READ COMMITTED: its insert of
 * E only withdraws violations; and r1 inserts R3, whose foreign key references R, so it checks what r0 writes, which no
 * login fences: r0's trigger-held law would make it a pivot were it SERIALIZABLE, and at READ COMMITTED it is none. As
 * the cure, r0 inserts E alone, which fires no probe, and runs READ COMMITTED too. Each
 * other shape adds one more occurrence some write can make true, and r0 runs
 * SERIALIZABLE by laws: r1 deletes E (the deleted), the witness reads two rows of R (the self-join), r0 inserts E where
 * the witness reads its rows present (the present). In the probed, r0 inserts R alone, and r1, SERIALIZABLE by its UPDATE of R3, inserts E, a relation r0's
 * probe reads, which a trigger-held law reads, so it may miss another call's write: 5c holds r0 SERIALIZABLE
 * (NEGATION's case 3 through the probe).
 */
const monotoneOf = (shape: MonotoneShape): Sketch => {
	const law: LawSketch =
		shape === "monotoneSelfJoin"
			? [{ rows: [0, 0], present: [], absent: [1] }]
			: shape === "monotonePresent"
				? [{ rows: [0, 2], present: [1], absent: [] }]
				: [{ rows: [0, 2], present: [], absent: [1] }]
	const inserts = shape === "monotoneProbed" ? [0] : shape === "monotoneCure" ? [1] : [0, 1]
	const writer: RoleSketch = {
		login: 0,
		serializable: [],
		privileges: Arr.flatMap(inserts, (relation) => [
			{ relation, privilege: "SELECT" as const },
			{ relation, privilege: "INSERT" as const }
		]),
		members: Arr.map(inserts, (relation) => [
			{ writes: [insertOf(relation, [])], reads: [], probes: [], cores: [] }
		])
	}
	const other: ReadonlyArray<RoleSketch> =
		shape === "monotoneDeleted"
			? [
					{
						login: 1,
						serializable: [],
						privileges: [{ relation: 1, privilege: "DELETE" }],
						members: [
							[
								{
									writes: [{ relation: 1, op: "delete", from: [] }],
									reads: [],
									probes: [],
									cores: []
								}
							]
						]
					}
				]
			: shape === "monotoneProbed"
				? [
						{
							login: 1,
							serializable: [],
							privileges: [
								{ relation: 1, privilege: "INSERT" },
								{ relation: 3, privilege: "UPDATE" }
							],
							members: [[{ writes: [insertOf(1, [])], reads: [], probes: [], cores: [] }]]
						}
					]
				: shape === "monotoneWriter"
					? [
							{
								login: 1,
								serializable: [],
								privileges: [{ relation: 3, privilege: "INSERT" }],
								members: [[{ writes: [insertOf(3, [])], reads: [], probes: [], cores: [] }]]
							}
						]
					: []
	return {
		relations: [
			{ ...clean([0]), triggerLaws: [law] },
			clean([0]),
			clean([0]),
			shape === "monotoneWriter"
				? { ...clean([0]), references: [{ relation: 0, key: 0, onUpdate: "noAction" }] }
				: clean([0])
		],
		roles: [writer, ...other]
	}
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
	shape: Exclude<Shape, "triggered" | "droppedReference" | "newlyFenced" | "newlyFencedRead">
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
		case "directReached":
			return directWriterOf(s, "reached")
		case "directUnreached":
			return directWriterOf(s, "unreached")
		case "fencedDeleter":
			return deleterOf(s, "fenced")
		case "updatedDeleter":
			return deleterOf(s, "updated")
		case "monotoneWriter":
		case "monotoneCure":
		case "monotoneDeleted":
		case "monotoneSelfJoin":
		case "monotonePresent":
		case "monotoneProbed":
			return monotoneOf(shape)
		case "drawn":
			return s.draw(sketchGen)
	}
}

export const caseGen: Gen<Case> = (s) => {
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
			[1, () => "directReached"],
			[1, () => "directUnreached"],
			[1, () => "fencedDeleter"],
			[1, () => "updatedDeleter"],
			[1, (t) => t.draw(element(monotoneShapes))]
		])
	)
	return s.draw(shapeCaseGen(shape))
}

/** A case of `shape`, drawn as caseGen draws one. */
export const shapeCaseGen =
	(shape: Shape): Gen<Case> =>
	(s) => {
		if (shape === "droppedReference") {
			return droppedReference
		}
		if (shape === "triggered") {
			return s.draw(triggeredGen)
		}
		if (shape === "newlyFenced" || shape === "newlyFencedRead") {
			return s.draw(newlyFencedGen(shape === "newlyFenced" ? "check" : "plain"))
		}
		const sketch = shapeSketch(s, shape)
		return { sketch, shape, extension: s.draw(extensionGen(sketch)) }
	}

const relationName = (i: number): string => `R${i}`

/** Whether some role of the sketch deletes the relation, by a privilege or by a member of either of its forms. */
export const deletedIn = (sketch: Sketch, relation: number): boolean =>
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

const lawId = (home: number, at: number) => wild.lawId(`law_${home}_${at}`)

/** Whether a law's witnesses read the relation. */
export const mentions = (law: LawSketch, relation: number): boolean =>
	Arr.some(
		law,
		(w) => w.rows.includes(relation) || w.present.includes(relation) || w.absent.includes(relation)
	)

/**
 * The laws over a relation, each by the relation it is stated at and its place there: those stated at it and those
 * whose witnesses read it, as the law model's triggerLawsOver gives them.
 */
export const lawsOver = (
	relations: ReadonlyArray<RelationSketch>,
	relation: number
): ReadonlyArray<{ readonly home: number; readonly at: number; readonly law: LawSketch }> =>
	Arr.flatMap(relations, (r, home) =>
		Arr.flatMap(r.triggerLaws, (law, at) =>
			home === relation || mentions(law, relation) ? [{ home, at, law }] : []
		)
	)

/** What a read binds `field` to: `$p<binding>`, or k1, where it is split, the other parameter. */
const byOf = (r: ReadSketch, field: string): string =>
	`$p${field === "k1" && r.split ? 1 - r.binding : r.binding}`

/** The binding byOf names, as a read's fact binds it: that parameter, or, one group per own row, that own column. */
const bindingOf = (r: ReadSketch, field: string): Binding =>
	r.rows === "one"
		? { kind: "param", name: byOf(r, field) }
		: { kind: "own", alias: "own", column: byOf(r, field), rows: "many" }

export const readFact = (r: ReadSketch): ReadFact => ({
	relation: relationName(r.relation),
	mode: r.mode,
	base: baseOf(r),
	probes: r.probes,
	own: r.own,
	group:
		r.group === undefined
			? undefined
			: {
					bound: Arr.map(keyOf(r.group), (field) => ({ field, by: bindingOf(r, field) }))
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
								from: Arr.map(w.from, (read) => ({ cte: undefined, read }))
							})),
							reads: Arr.map(st.reads, readFact),
							probes: st.probes,
							cores: st.cores,
							uses: [],
							ctes: []
						}))
					}
				]
			: []
	)

/** The facts of sketched relations, as the certifier reads them. */
export const relationsOf = (
	relations: ReadonlyArray<RelationSketch>
): IsolationInput["relations"] =>
	new Map(
		Arr.map(relations, (r, i) => [
			relationName(i),
			{
				triggerLaws: Arr.map(lawsOver(relations, i), ({ home, at, law }) => ({
					law: lawId(home, at),
					witnesses: Arr.map(law, (w) => ({
						rows: Arr.map(w.rows, relationName),
						present: Arr.map(w.present, relationName),
						absent: Arr.map(w.absent, relationName)
					}))
				})),
				keys: Arr.map(r.keys, keyOf),
				countedGroups: Arr.map(r.counted, keyOf),
				references: Arr.map(r.references, (ref) => ({
					relation: relationName(ref.relation),
					columns: keyOf(ref.key),
					onUpdate: ref.onUpdate
				})),
				inserts: insertsOf(r),
				upkept: []
			}
		])
	)

/** A sketched role's privileges, by relation. */
const privilegesOf = (
	privileges: RoleSketch["privileges"]
): ReadonlyMap<string, ReadonlySet<TablePrivilege>> => {
	const by = new Map<string, Set<TablePrivilege>>()
	for (const p of privileges) {
		const held = by.get(relationName(p.relation)) ?? new Set<TablePrivilege>()
		held.add(p.privilege)
		by.set(relationName(p.relation), held)
	}
	return by
}

/** The facts a sketch states, as the certifier reads them. */
export const inputOf = (sketch: Sketch): IsolationInput => ({
	relations: relationsOf(sketch.relations),
	roles: Arr.map(sketch.roles, (role, i): RoleFacts => ({
		login: `L${role.login}`,
		role: `r${i}`,
		privileges: privilegesOf(role.privileges),
		writes: writesOf(role.privileges, role.members, membersOf(role.members))
	}))
})

/**
 * The relations a role's grants let it read, by index in order: each it holds a privilege on, a sketch's SELECT standing
 * for every way a role reads a relation it does not write, a view's as a table's (physical/ddl/roles.ts
 * readableRelations).
 */
const readableOf = (privileges: RoleSketch["privileges"]): ReadonlyArray<number> =>
	Arr.sort(Arr.dedupe(Arr.map(privileges, (p) => p.relation)), Order.Number)

/**
 * A role's writes: served by its members' facts, or unknown where it has no change member, reading what its grants let
 * it read (RoleWrites).
 */
const writesOf = (
	privileges: RoleSketch["privileges"],
	sketched: ReadonlyArray<unknown>,
	members: ReadonlyArray<MemberFacts>
): RoleWrites =>
	sketched.length > 0
		? { kind: "served", members }
		: { kind: "unknown", readable: Arr.map(readableOf(privileges), relationName) }

/**
 * Each role of a sketch as certification takes it, its relations' facts `relations`: its READ COMMITTED facts, and its
 * lowering to the sketch's SERIALIZABLE form; and what certification gives them.
 */
const certifiedOf = (sketch: Sketch, relations: IsolationInput["relations"]) =>
	certify(
		relations,
		Arr.map(inputOf(sketch).roles, (role, i): Candidate<undefined, undefined, never> => ({
			kind: "formed",
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
export const verdictsOf = (
	sketch: Sketch,
	relations: IsolationInput["relations"]
): ReadonlyArray<RoleIsolation> => {
	const certified = certifiedOf(sketch, relations)
	return certified.ok ? Arr.map(certified.value.roles, isolationOf) : certified.error
}

/** The fences certification states (certifiedOf). */
export const fencesOf = (
	sketch: Sketch,
	relations: IsolationInput["relations"]
): ReadonlyArray<Fence> => {
	const certified = certifiedOf(sketch, relations)
	return certified.ok ? certified.value.fences : certified.error
}

/** Fences by login, then relation, each in code-unit order. */
const fenceOrder: Order.Order<Fence> = Order.combine(
	Order.mapInput(Order.String, (f: Fence) => f.login),
	Order.mapInput(Order.String, (f: Fence) => f.relation)
)

/**
 * The fences the oracle expects at its fixpoint: for each relation a role it leaves READ COMMITTED checks by a sealed
 * check, one fence of each login that fences it (each that deletes it, and each of a lowered role that may miss
 * another call's write and writes it), naming those roles in their order, by login then relation.
 */
export const expectedFences = (
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

export const withRole = (
	sketch: Sketch,
	at: number,
	edit: (role: RoleSketch) => RoleSketch
): Sketch => ({
	...sketch,
	roles: Arr.map(sketch.roles, (role, i) => (i === at ? edit(role) : role))
})

export const withRelation = (
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
			return withRelation(sketch, e.relation, (r) => ({
				...r,
				triggerLaws: [...r.triggerLaws, e.law]
			}))
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
export const givesFirstMember = (sketch: Sketch, e: Extension): boolean => {
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

/**
 * Whether `e` adds an arbitration to a role's first statement, a read of `arbiter` mode: grizzle's own key arbitration,
 * which adds no read another call's write can meet, and which fixes the row a later statement of the member reads at that
 * key (certify.ts fixedFor), so it may make that read sealed and the role READ COMMITTED, as the keyMatched shape's
 * arbitration does where keyUnmatched's does not.
 */
export const addsArbitration = (e: Extension): boolean =>
	e.kind === "read" && e.read.mode === "arbiter"

/**
 * The roles certification leaves READ COMMITTED once `c`'s extension is applied that rely on a fence of a relation by a
 * login that did not fence it before (Fence; `lowered`, the roles the case's certification lowered): an extension that
 * makes a login newly fence a relation may relax such a reader (the module's header).
 */
/** Whether some fence is of a relation no role deletes, a fence only a pivot's login holds (fencesOf). */
export const fencesUndeleted = (sketch: Sketch, fences: ReadonlyArray<Fence>): boolean =>
	Arr.some(fences, (f) =>
		Arr.some(sketch.relations, (_, r) => relationName(r) === f.relation && !deletedIn(sketch, r))
	)

/** The certificates after a case's extension: a dropped fact leaves its relation out of the facts. */
export const afterOf = (c: Case): ReadonlyArray<RoleIsolation> => {
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
export const oracleRound = (sketch: Sketch, lowered: ReadonlySet<number>) => {
	const roles = sketch.roles
	const relations = sketch.relations
	/** Whether role i's writes are unknown: it has no change member, so it writes by direct SQL alone. */
	const unknown = (i: number): boolean => Arr.getUnsafe(roles, i).members.length === 0
	/**
	 * The members role i's writes are read by at READ COMMITTED: its own; or, where its writes are unknown and it holds a
	 * writer's privilege, one member of one statement that reads every relation its grants let it read (readableOf) for
	 * its absence, by no group, and writes each relation by each write its privileges permit, joined with nothing.
	 */
	const served = (i: number): ReadonlyArray<ReadonlyArray<StatementSketch>> => {
		const role = Arr.getUnsafe(roles, i)
		if (!unknown(i)) {
			return role.members
		}
		const writes = Arr.flatMap(role.privileges, (p): ReadonlyArray<WriteSketch> => {
			switch (p.privilege) {
				case "SELECT":
					return []
				case "INSERT":
					return [{ relation: p.relation, op: "insert", from: [] }]
				case "UPDATE":
					return [{ relation: p.relation, op: "update", from: [] }]
				case "DELETE":
					return [{ relation: p.relation, op: "delete", from: [] }]
			}
		})
		const reads = Arr.map(readableOf(role.privileges), (relation): ReadSketch => ({
			relation,
			mode: "negated",
			own: false,
			group: undefined,
			binding: 0,
			split: false,
			rows: "one",
			probes: []
		}))
		return writes.length === 0 ? [] : [[{ writes, reads, probes: [], cores: [] }]]
	}
	const formsOf = (i: number): ReadonlyArray<ReadonlyArray<StatementSketch>> =>
		lowered.has(i) ? [...served(i), ...Arr.getUnsafe(roles, i).serializable] : served(i)
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
	/** What a role writes as another role's judge reads it: everything it writes. */
	const guardedSet = (i: number): ReadonlySet<number> =>
		new Set([
			...Arr.flatMap(Arr.getUnsafe(roles, i).privileges, (p) =>
				p.privilege === "SELECT" ? [] : [p.relation]
			),
			...Arr.map(writesOf(i), (w) => w.relation),
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
	/** Whether role i's writes, by a privilege, a member or a cascade, make a row of the relation present, or absent:
	 * an insert present, a delete absent, an update both. */
	const roleMakes = (i: number, relation: number, made: "present" | "absent") =>
		Arr.some(
			Arr.getUnsafe(roles, i).privileges,
			(p) =>
				p.relation === relation &&
				(p.privilege === "UPDATE" || p.privilege === (made === "present" ? "INSERT" : "DELETE"))
		) ||
		Arr.some(
			writesOf(i),
			(w) =>
				w.relation === relation &&
				(w.op === "update" || w.op === (made === "present" ? "insert" : "delete"))
		) ||
		updatedOf(i).has(relation)
	/** Whether some role's write makes a row of it present, or absent. */
	const makes = (relation: number, made: "present" | "absent") =>
		Arr.some(roles, (_, i) => roleMakes(i, relation, made))
	/** Whether role i's write of the relation breaks the witness: it makes a row present where the relation is among its
	 * rows or presences, or absent where it is among its absences. */
	const breaks = (i: number, w: WitnessSketch, relation: number) =>
		(roleMakes(i, relation, "present") &&
			(w.rows.includes(relation) || w.present.includes(relation))) ||
		(roleMakes(i, relation, "absent") && w.absent.includes(relation))
	/** Whether exactly one occurrence of the witness is one some write can make true, and that one is one of its rows. */
	const monotone = (w: WitnessSketch) => {
		const rows = Arr.filter(w.rows, (x) => makes(x, "present")).length
		const others =
			Arr.filter(w.present, (x) => makes(x, "present")).length +
			Arr.filter(w.absent, (x) => makes(x, "absent")).length
		return rows === 1 && others === 0
	}
	/** The witnesses role i's writes break, with the relation each write breaks it at. */
	const brokenBy = (i: number) =>
		Arr.flatMap([...writtenSet(i)], (relation) =>
			Arr.flatMap(lawsOver(relations, relation), ({ law }) =>
				Arr.flatMap(law, (w) => (breaks(i, w, relation) ? [{ relation, w }] : []))
			)
		)
	/** The relations the probes of role i's writes read: every relation of every witness they break. */
	const probedBy = (i: number): ReadonlySet<number> =>
		new Set(Arr.flatMap(brokenBy(i), ({ w }) => [...w.rows, ...w.present, ...w.absent]))
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
	/** Whether a role whose writes are unknown holds a writer's privilege on the relation: its direct transactions take
	 * no fence, so no check of the relation is sealed. */
	const direct = (relation: number) =>
		Arr.some(
			roles,
			(r, i) =>
				unknown(i) &&
				Arr.some(r.privileges, (p) => p.relation === relation && p.privilege !== "SELECT")
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
					w.op === "delete" ? [] : Arr.getUnsafe(relations, w.relation).references,
					(ref): OracleCheck => {
						const seal: OracleSeal = !anyWrites(ref.relation)
							? "unwritten"
							: !covers(ref.relation, keyOf(ref.key)) ||
								  updates(ref.relation) ||
								  direct(ref.relation)
								? "unsealed"
								: replaced(ref.relation)
									? "fenced"
									: "sealed"
						return { at, relation: ref.relation, side: "referencing", seal, write: w.relation }
					}
				),
				...(w.op === "insert"
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
	/** Whether a check of a member of role o is a fenced write's check of the rows that reference a row it deletes,
	 * which reads nothing conditions 2 and 3 weigh: o's login fences the deleted relation. */
	const fencedSite = (o: number, c: OracleCheck) =>
		c.side === "referenced" && fences(Arr.getUnsafe(roles, o).login, c.write)
	/**
	 * Whether every row of a core with row sources `sources` comes through reads `fits` admits: through some source, a
	 * read `fits` admits, a core whose own rows do, or a UNION each of whose arms does.
	 */
	const passes = (
		st: StatementSketch,
		sources: ReadonlyArray<FlatRowSource>,
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
					Arr.map(keyOf(r.group), (f) => `${f}=${bindingText(bindingOf(r, f))}`),
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
	/** The relations a member of role o reads the absence or a count of, by a statement or the check of a changed row,
	 * but a fenced write's. */
	const absent = (statements: ReadonlyArray<StatementSketch>, o: number): ReadonlySet<number> =>
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
				c.side === "referenced" && !fencedSite(o, c) ? [c.relation] : []
			)
		])
	/** Whether a check's seal is a sealed one's, a point's, a held one's or a fenced one's: of a relation no role updates,
	 * at a whole key, which every login whose writes could meet it out of order fences. */
	const locked = (c: OracleCheck) => c.seal === "fenced" || c.seal === "sealed"
	/** The relations role i's READ COMMITTED members check by a sealed check. */
	const lockedChecks = (i: number): ReadonlySet<number> =>
		new Set(
			Arr.flatMap(served(i), (statements) =>
				Arr.flatMap(checksOf(statements), (c) => (locked(c) ? [c.relation] : []))
			)
		)
	/** Whether role o, served the forms of its round, may miss another call's write: an outside read of a statement, a
	 * check of referencing rows or an unsealed one, or a write of a relation a rule over a query reads. */
	const pivot = (o: number): boolean =>
		Arr.some(formsOf(o), (statements) =>
			Arr.some(placedOf(statements), (placed) => Arr.some(placed, (p) => isOutside(p.seal)))
		) ||
		Arr.some(formsOf(o), (statements) =>
			Arr.some(
				checksOf(statements),
				(c) => isOutside(c.seal) && (c.side === "referenced" || c.seal === "unsealed")
			)
		) ||
		Arr.some([...writtenSet(o)], (x) => lawsOver(relations, x).length > 0)
	/** The logins that fence the relation, each once: each whose roles delete it, no role updating it, and each of a
	 * lowered role that may miss another call's write and writes it. */
	const fencers = (relation: number): ReadonlyArray<number> =>
		Arr.filter(
			[...new Set(Arr.map(roles, (r) => r.login))],
			(login) =>
				fences(login, relation) ||
				Arr.some(
					[...lowered],
					(o) => Arr.getUnsafe(roles, o).login === login && pivot(o) && guardedSet(o).has(relation)
				)
		)
	/** The relations role i reads from outside by a read no fence orders: by a statement or a probe of its writes; a
	 * sealed check is fenced, and an unsealed one fails the pivot condition itself. */
	const unfencedReads = (i: number): ReadonlySet<number> =>
		new Set([
			...Arr.flatMap(served(i), (statements) =>
				Arr.flatMap(placedOf(statements), (placed) =>
					Arr.flatMap(placed, (p) => (isOutside(p.seal) ? [p.read.relation] : []))
				)
			),
			...probedBy(i)
		])
	const own = (i: number): ReadonlySet<IsolationCondition> => {
		const role = Arr.getUnsafe(roles, i)
		const failed = new Set<IsolationCondition>()
		if (unknown(i)) {
			failed.add("members")
		}
		if (
			Arr.some(role.privileges, (p) => p.privilege === "UPDATE" || p.privilege === "DELETE") ||
			Arr.some([...writtenSet(i)], changes)
		) {
			failed.add("privileges")
		}
		if (Arr.some(brokenBy(i), ({ w }) => !monotone(w))) {
			failed.add("laws")
		}
		for (const relation of guardedSet(i)) {
			if (
				Arr.some(roles, (_, r) =>
					Arr.some(formsOf(r), (statements) => absent(statements, r).has(relation))
				)
			) {
				failed.add("absence")
			}
		}
		for (const statements of served(i)) {
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
		const reads = unfencedReads(i)
		const out = new Set<IsolationCondition>()
		for (const o of Arr.filter([...judges], (x) => x !== i)) {
			if (
				Arr.some(
					formsOf(o),
					(statements) =>
						Arr.some(statements, (st) => Arr.some(st.reads, (r) => written.has(r.relation))) ||
						Arr.some(checksOf(statements), (c) => written.has(c.relation) && !fencedSite(o, c))
				)
			) {
				out.add("laws")
			}
			const shared = Arr.some([...guardedSet(o)], (x) => reads.has(x))
			if ((shared && pivot(o)) || Arr.some([...guardedSet(o)], (x) => written.has(x))) {
				out.add("writers")
			}
		}
		return out
	}
	return {
		own,
		given,
		absent,
		served,
		written: writtenSet,
		replaced,
		lockedChecks,
		fencers,
		brokenBy,
		monotone
	}
}

/**
 * One role's level and conditions as the oracle finds them: `own`, the conditions it fails itself; and `givers`, where
 * it runs SERIALIZABLE failing none of its own, each other role that runs SERIALIZABLE at its round's end and gives it a
 * condition, by index, with the conditions it gives, none otherwise.
 */
interface OracleVerdict {
	readonly readCommitted: boolean
	readonly failed: ReadonlySet<IsolationCondition>
	readonly own: ReadonlySet<IsolationCondition>
	readonly givers: ReadonlyMap<number, ReadonlySet<IsolationCondition>>
}

/**
 * One round as the oracle runs it: every role outside `lowered` judged over its READ COMMITTED form, the roles of
 * `lowered` served both forms and SERIALIZABLE, and the judged roles left READ COMMITTED the greatest set that meet
 * their own conditions none of whose members a role outside it gives a reason, found by trying every subset. A judged
 * role's conditions are its own where it fails any, else those the round's other SERIALIZABLE roles give it, each such
 * role with the conditions it gives alone.
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
	const giversOf = (i: number): ReadonlyMap<number, ReadonlySet<IsolationCondition>> =>
		new Map(
			Arr.flatMap([...outside], (j) => {
				const given = j === i ? new Set<IsolationCondition>() : at.given(new Set([j]), i)
				return given.size > 0 ? [[j, given] as const] : []
			})
		)
	return new Map(
		Arr.map(
			judged,
			({ i, own }) =>
				[
					i,
					{
						readCommitted: best.has(i),
						failed: own.size > 0 ? own : at.given(outside, i),
						own,
						givers: own.size > 0 || best.has(i) ? new Map() : giversOf(i)
					}
				] as const
		)
	)
}

/**
 * The oracle: rounds from the roles `start` lowers already, each with its verdict, each round lowering the roles it
 * judges SERIALIZABLE with that round's conditions, until one lowers none; with the roles lowered, by the round that
 * lowered them (none for a role `start` lowers), a role's own form never among the facts it was judged by.
 */
export const oracleFrom = (sketch: Sketch, start: ReadonlyMap<number, OracleVerdict>) => {
	const lowered = new Map<number, OracleVerdict>(start)
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

/** The oracle from none lowered (oracleFrom). */
export const oracle = (sketch: Sketch) => oracleFrom(sketch, new Map())

/**
 * Whether lowered role i's SERIALIZABLE form alone reads the absence or a count of a relation it writes, among the
 * forms the roles of `lowered` are served: no READ COMMITTED form does, nor another lowered role's.
 */
export const absenceOfItsOwnLowering = (
	sketch: Sketch,
	lowered: ReadonlySet<number>,
	i: number
): boolean => {
	const at = oracleRound(sketch, lowered)
	return Arr.some(
		[...at.written(i)],
		(x) =>
			Arr.some(Arr.getUnsafe(sketch.roles, i).serializable, (sts) => at.absent(sts, i).has(x)) &&
			!Arr.some(sketch.roles, (r, j) =>
				Arr.some(
					j !== i && lowered.has(j) ? [...at.served(j), ...r.serializable] : at.served(j),
					(sts) => at.absent(sts, j).has(x)
				)
			)
	)
}

export type IsolationFeature =
	| "a role certified READ COMMITTED"
	| `a role SERIALIZABLE by ${IsolationCondition}`
	| "a role SERIALIZABLE only through roles that run SERIALIZABLE"
	| "a role SERIALIZABLE through two roles that run SERIALIZABLE"
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
	| "a fence of a relation no role deletes"
	| "a check of the rows that reference a changed one"
	| "an update carried by a cascading foreign key"
	| `the ${Exclude<Shape, "drawn">}`
	| "a fact dropped beside a READ COMMITTED role"
	| "a dropped fact a SERIALIZABLE role's level rests on alone"
	| "a role whose lowered form alone reads the absence of what it writes"
	| "a role lowered in a later round"
	| "a READ COMMITTED role whose write fires a monotone rule's probe"
	| "a READ COMMITTED role whose writes of a rule's relations only withdraw its violations"

export const conditions: ReadonlyArray<IsolationCondition> = [
	"members",
	"privileges",
	"laws",
	"absence",
	"snapshot",
	"pivot",
	"writers"
]

/** Every condition a reason names, `facts` included, which no drawn installation fails. */
export const everyCondition: ReadonlyArray<IsolationCondition> = ["facts", ...conditions]

/**
 * The fixed shapes, each a required feature by its name, which the search draws within its coverage budget.
 */
export const shapes: ReadonlyArray<Exclude<Shape, "drawn">> = [
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
	"directReached",
	"directUnreached",
	"fencedDeleter",
	"updatedDeleter",
	"monotoneWriter",
	"monotoneCure",
	"monotoneDeleted",
	"monotoneSelfJoin",
	"monotonePresent",
	"monotoneProbed",
	"newlyFenced",
	"newlyFencedRead"
]

/**
 * The fixed shape each required situation a shape reaches is aimed at: each shape's own, and a pivot's fence,
 * refusedCopy's.
 */
export const shapeAims: ReadonlyArray<readonly [IsolationFeature, Exclude<Shape, "drawn">]> = [
	["a fence of a relation no role deletes", "refusedCopy"],
	...Arr.map(shapes, (shape) => [`the ${shape}`, shape] as const)
]

export const levelsOf = (verdicts: ReadonlyArray<RoleIsolation>) =>
	Arr.map(verdicts, (v) => v.certificate.level)

export const sealFeature = (seal: ReadSeal): IsolationFeature | undefined => {
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
export const counterexampleRoles = (shape: Shape): ReadonlyArray<number> => {
	switch (shape) {
		case "copiers":
		case "pointCopiers":
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
			return [0, 1]
		case "publication":
		case "refusedCopy":
			return [0]
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
		case "newlyFencedRead":
			return [1]
		case "updatedCheck":
		case "updatedDeleter":
		case "heldCheck":
		case "fencedCheck":
		case "unfencedPivot":
		case "directReached":
		case "monotoneDeleted":
		case "monotoneSelfJoin":
		case "monotonePresent":
		case "monotoneProbed":
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
		case "fencedPublisher":
		case "fencedDeleter":
		case "directUnreached":
		case "monotoneWriter":
		case "monotoneCure":
		case "newlyFenced":
			return []
	}
}

/** The roles a shape the certifier must prove runs READ COMMITTED: a key-matched read of a race's winner, a repeatable
 * insertion's probed key, the monotone writer and the cure, and the checks a pivot's login fences. */
export const certifiedRoles = (shape: Shape): ReadonlyArray<number> => {
	switch (shape) {
		case "keyMatched":
		case "repeatableOtherKey":
		case "monotoneWriter":
			return [0, 1]
		case "monotoneCure":
		case "directUnreached":
			return [0]
		case "refusedCopy":
		case "newlyFenced":
			return [1]
		case "publication":
			return [1, 2]
		case "drawn":
		case "copiers":
		case "pointCopiers":
		case "absentThenInsert":
		case "chain":
		case "seals":
		case "pivotWriter":
		case "laggingReader":
		case "listReader":
		case "deferredCopy":
		case "lateWriter":
		case "cascadedWriter":
		case "sharedWriter":
		case "protocolSealed":
		case "protocolUnsealed":
		case "absentGate":
		case "arbitratedRead":
		case "arbitratedGated":
		case "keyUnmatched":
		case "keyPartial":
		case "raceOtherKey":
		case "fallbackUnion":
		case "fallbackCount":
		case "unjoinedGate":
		case "chainedPath":
		case "unionSealed":
		case "unionOtherKey":
		case "unionOtherRelation":
		case "unionRecursion":
		case "arbiterPath":
		case "servedCause":
		case "servedUpdate":
		case "servedAbsence":
		case "servedOwn":
		case "loweredAbsence":
		case "loweredCause":
		case "triggered":
		case "droppedReference":
		case "unfencedPivot":
		case "directReached":
		case "heldCheck":
		case "fencedCheck":
		case "updatedCheck":
		case "fencedPublisher":
		case "fencedDeleter":
		case "updatedDeleter":
		case "monotoneDeleted":
		case "monotoneSelfJoin":
		case "monotonePresent":
		case "monotoneProbed":
		case "newlyFencedRead":
			return []
	}
}

/** The query CTE instances a drawn statement holds, at most. */
const INSTANCES = 3

/**
 * How a case of statements read through instances is drawn, chosen per case: `broad`, every relation, read and write
 * the main search draws; or `dense`, two insert-only relations keyed by k0, each read at k0's one parameter, written by
 * inserts alone, so outside reads are sealed points of one group and a probe's judgement turns on its row path.
 */
type Profile = "broad" | "dense"

/** A read of a dense case, of a body of `probes` probes: of R0 or R1 at k0, the call's own or not. */
const denseReadGen =
	(probes: number): Gen<ReadSketch> =>
	(s) => {
		const mode = s.draw(
			weighted<ReadSketch["mode"]>([
				[3, () => "positive"],
				[2, () => "negated"],
				[1, () => "counted"]
			])
		)
		return {
			relation: s.draw(int(0, 1)),
			own: false,
			group: 0,
			binding: 0,
			split: false,
			rows: "one",
			mode,
			probes:
				mode === "positive"
					? []
					: s.draw(
							subset(
								upTo(probes, (i) => i),
								{ min: 0, max: probes }
							)
						)
		}
	}

/**
 * A body's use of a query CTE instance among `targets`: beneath none or one of the body's `probes` probes, in one of
 * its first two cores or, where `outside`, a statement's own body's, in none, after some of its `reads` reads.
 */
const useGen =
	(
		targets: Arr.NonEmptyReadonlyArray<number>,
		probes: number,
		reads: number,
		outside: boolean
	): Gen<CteUse> =>
	(s) => ({
		cte: s.draw(element(targets)),
		probes:
			probes === 0
				? []
				: s.draw(
						weighted<ReadonlyArray<number>>([
							[1, () => []],
							[2, (t) => [t.draw(int(0, probes - 1))]]
						])
					),
		core: s.draw(
			weighted<number | undefined>([
				[3, () => 0],
				[2, () => 1],
				...(outside ? [[1, (): number | undefined => undefined] as const] : [])
			])
		),
		at: s.draw(int(0, reads))
	})

/**
 * One body of a drawn statement of `writes` writes: its reads, of up to two probes, each probe's gates, core (`core`)
 * and chain, its cores' row sources, a use among them, and its uses of `targets`, by the reads before each.
 */
const bodyGen =
	<Core extends SiteCore>(
		profile: Profile,
		targets: ReadonlyArray<number>,
		writes: number,
		core: Gen<Core>,
		outside: boolean
	): Gen<BodyFacts<Core>> =>
	(s) => {
		const probeCount = s.draw(int(0, 2))
		const reads = Arr.map(
			s.draw(
				array(profile === "dense" ? denseReadGen(probeCount) : readGenOf(probeCount), {
					min: 0,
					max: 3
				})
			),
			readFact
		)
		const uses = Arr.isReadonlyArrayNonEmpty(targets)
			? Arr.sort(
					s.draw(array(useGen(targets, probeCount, reads.length, outside), { min: 0, max: 3 })),
					Order.mapInput(Order.Number, (u: CteUse) => u.at)
				)
			: []
		return {
			reads,
			probes: upTo(probeCount, (id) => ({
				gates: s.draw(
					subset(
						upTo(writes, (i) => i),
						{ min: 0, max: writes }
					)
				),
				core: s.draw(core),
				chain: s.draw(
					weighted<ReadonlyArray<number>>([
						[3, () => []],
						[1, () => [id]]
					])
				)
			})),
			cores: upTo(CORES, (at) => [
				...s.draw(sourcesGen(reads.length, at, 1)),
				...(uses.length === 0
					? []
					: s.draw(
							weighted<ReadonlyArray<RowSource>>([
								[1, () => []],
								[2, (t) => [{ kind: "use", use: t.draw(int(0, uses.length - 1)) }]]
							])
						))
			]),
			uses
		}
	}

/** The row sources of an instance of `uses` uses: its first core, none, one of its uses, or a UNION of both. */
const rowsGen =
	(uses: number): Gen<ReadonlyArray<RowSource>> =>
	(s) =>
		s.draw(
			weighted<ReadonlyArray<RowSource>>([
				[3, () => [{ kind: "core", core: 0 }]],
				[1, () => []],
				...(uses === 0
					? []
					: [
							[
								2,
								(t: Source): ReadonlyArray<RowSource> => [
									{ kind: "use", use: t.draw(int(0, uses - 1)) }
								]
							] as const,
							[
								1,
								(t: Source): ReadonlyArray<RowSource> => [
									{
										kind: "union",
										arms: [
											[{ kind: "core", core: 0 }],
											[{ kind: "use", use: t.draw(int(0, uses - 1)) }]
										]
									}
								]
							] as const
						])
			])
		)

/**
 * A statement whose query CTEs are instances (StatementFacts): one to three instances, each using only later ones, so
 * no use reaches its own body again, each probe of one in one of its cores or in the core of the site that reads it;
 * its own body, using any of them; and up to two writes, each fed by some reads of any body.
 */
const sharedStatementGen =
	(profile: Profile): Gen<StatementFacts> =>
	(s) => {
		const count = s.draw(int(1, INSTANCES))
		const writes = s.draw(int(0, 2))
		const ctes = upTo(count, (i): CteFacts => {
			const body = s.draw(
				bodyGen(
					profile,
					upTo(count - i - 1, (j) => i + 1 + j),
					writes,
					weighted<number | "site">([
						[2, () => 0],
						[1, () => 1],
						[2, () => "site"]
					]),
					false
				)
			)
			return { ...body, rows: s.draw(rowsGen(body.uses.length)), query: s.draw(int(0, i)) }
		})
		const own = s.draw(
			bodyGen(
				profile,
				upTo(count, (j) => j),
				writes,
				weighted<number | undefined>([
					[3, () => 0],
					[1, () => 1],
					[1, () => undefined]
				]),
				true
			)
		)
		const places: ReadonlyArray<ReadAt> = [
			...Arr.map(own.reads, (_, read) => ({ cte: undefined, read })),
			...Arr.flatMap(ctes, (c, cte) => Arr.map(c.reads, (_, read) => ({ cte, read })))
		]
		return {
			...own,
			writes: upTo(writes, () => {
				const w = s.draw(writeGen(0))
				return {
					relation: relationName(profile === "dense" ? w.relation % 2 : w.relation),
					op: profile === "dense" ? "insert" : w.op,
					from: s.draw(subset(places, { min: 0, max: places.length }))
				}
			}),
			ctes
		}
	}

/** The group a read reads, as the row path features compare them: its relation and its bindings. */
const groupKey = (r: ReadFact): string =>
	`${r.relation}(${Arr.join(
		Arr.map(r.group?.bound ?? [], (b) => `${b.field}=${bindingText(b.by)}`),
		","
	)})`

/**
 * The row path situations a statement reaches, in its expansion (test/support/expanded.ts), its reads sealed among
 * `input`'s roles: a probe with an outside read beneath it, every one sealed, each group read positively beneath no
 * probe and joined into every write the probe gates, so the probe's row path alone decides it; over a read of an
 * instance, or a `site` probe of an instance read at two sites.
 */
export const rowPathFeatures = (
	input: IsolationInput,
	st: StatementFacts
): ReadonlyArray<SharedFeature> => {
	const flat = expanded(st)
	const sites = (cte: number): number =>
		Arr.filter(
			Arr.flatMap([st, ...st.ctes], (b: BodyFacts<SiteCore>) => b.uses),
			(u) => u.cte === cte
		).length
	return Arr.flatMap(flat.probes, (probe, id): ReadonlyArray<SharedFeature> => {
		const beneath = Arr.filter(
			Arr.map(flat.reads, (read, at) => ({ read, at, seal: readSeal(input, read) })),
			({ read, seal }) =>
				read.probes.includes(id) &&
				seal.kind !== "arbiter" &&
				seal.kind !== "own" &&
				seal.kind !== "unwritten"
		)
		const decided =
			beneath.length > 0 &&
			Arr.every(beneath, ({ read, seal }) => {
				const g = groupKey(read)
				return (
					seal.kind !== "unsealed" &&
					Arr.some(
						flat.reads,
						(r) => r.probes.length === 0 && r.mode === "positive" && groupKey(r) === g
					) &&
					Arr.every(probe.gates, (k) =>
						Arr.some(
							flat.writes[k]?.from ?? [],
							(at) => flat.reads[at] !== undefined && groupKey(Arr.getUnsafe(flat.reads, at)) === g
						)
					)
				)
			})
		if (!decided) {
			return []
		}
		const origin = flat.probeOrigins[id]
		const instance = origin?.cte === undefined ? undefined : st.ctes[origin.cte]
		return [
			...(Arr.some(beneath, ({ at }) => flat.origins[at]?.cte !== undefined)
				? ["a probe decided by its row path over an instance's reads" as const]
				: []),
			...(origin?.cte !== undefined &&
			instance?.probes[origin.probe]?.core === "site" &&
			sites(origin.cte) >= 2
				? ["a site probe of an instance read at two sites, decided by its row path" as const]
				: [])
		]
	})
}

/** A role whose change members' statements read query CTE instances, as served at READ COMMITTED and SERIALIZABLE. */
interface SharedRole {
	readonly login: number
	readonly privileges: RoleSketch["privileges"]
	readonly members: ReadonlyArray<ReadonlyArray<StatementFacts>>
	readonly serializable: ReadonlyArray<ReadonlyArray<StatementFacts>>
}

/** An installation whose roles' statements read query CTE instances, drawn by `profile`. */
export interface SharedCase {
	readonly profile: Profile
	readonly relations: ReadonlyArray<RelationSketch>
	readonly roles: ReadonlyArray<SharedRole>
}

export const sharedCaseGen: Gen<SharedCase> = (s) => {
	const profile = s.draw(
		weighted<Profile>([
			[1, () => "broad"],
			[1, () => "dense"]
		])
	)
	const statements = array(array(sharedStatementGen(profile), { min: 1, max: 2 }), {
		min: 0,
		max: 2
	})
	return {
		profile,
		relations: Arr.makeBy(RELATIONS, () =>
			profile === "dense" ? clean([0]) : s.draw(relationSketchGen)
		),
		roles: s.draw(
			array(
				(t): SharedRole => ({
					login: t.draw(int(0, 1)),
					privileges: t.draw(
						array(
							(u) => ({
								relation: u.draw(relationGen),
								privilege:
									profile === "dense"
										? u.draw(
												weighted<TablePrivilege>([
													[1, () => "SELECT"],
													[1, () => "INSERT"]
												])
											)
										: u.draw(privilegeGen)
							}),
							{ min: 0, max: 3 }
						)
					),
					members: t.draw(statements),
					serializable: t.draw(
						array(array(sharedStatementGen(profile), { min: 1, max: 2 }), { min: 0, max: 1 })
					)
				}),
				{ min: 1, max: 3 }
			)
		)
	}
}

/**
 * A statement of `profile` whose first instance reads its second once and is read at two sites of the statement's own
 * body, the second beneath a probe of the statement that an outside read of no one group stands beneath, so that probe
 * is never neutral; the second instance holds a negated read of the call's own rows beneath a probe of its own, beneath
 * which no outside read stands, so that probe is neutral. The second instance is reached only through the first, once
 * from each of the first's two reaches, one neutral and one not, so its read takes its base mode at one and the mode it
 * composes at the other: a certifier entering an instance from one reach of its user alone reads it in one mode where
 * the expansion reads it in two. Everything else is drawn as sharedStatementGen draws it.
 */
const twoReachStatementGen =
	(profile: Profile): Gen<StatementFacts> =>
	(s) => {
		const writes = s.draw(int(0, 2))
		const siteCore = weighted<number | "site">([
			[2, () => 0],
			[1, () => 1],
			[2, () => "site"]
		])
		const outer = s.draw(bodyGen(profile, [], writes, siteCore, false))
		const inner = s.draw(bodyGen(profile, [], writes, siteCore, false))
		const own = s.draw(
			bodyGen(
				profile,
				[],
				writes,
				weighted<number | undefined>([
					[3, () => 0],
					[1, () => 1],
					[1, () => undefined]
				]),
				true
			)
		)
		const ownRows = readFact({
			...s.draw(readBodyGen),
			own: true,
			mode: "negated",
			probes: [inner.probes.length]
		})
		const noGroup = readFact({
			...s.draw(readBodyGen),
			own: false,
			group: undefined,
			mode: "negated",
			probes: [own.probes.length]
		})
		const reads = [...own.reads, noGroup]
		return {
			...own,
			reads,
			probes: [...own.probes, { gates: [], core: 0, chain: [] }],
			uses: [
				{ cte: 0, probes: [], core: 0, at: reads.length },
				{ cte: 0, probes: [own.probes.length], core: 0, at: reads.length }
			],
			writes: [
				...upTo(writes, () => {
					const w = s.draw(writeGen(0))
					return {
						relation: relationName(profile === "dense" ? w.relation % 2 : w.relation),
						op: profile === "dense" ? "insert" : w.op,
						from: []
					}
				}),
				{ relation: noGroup.relation, op: "insert", from: [] }
			],
			ctes: [
				{
					...outer,
					uses: [{ cte: 1, probes: [], core: 0, at: outer.reads.length }],
					rows: [{ kind: "use", use: 0 }],
					query: 0
				},
				{
					...inner,
					reads: [...inner.reads, ownRows],
					probes: [...inner.probes, { gates: [], core: 0, chain: [] }],
					rows: s.draw(rowsGen(inner.uses.length)),
					query: s.draw(int(0, 1))
				}
			]
		}
	}

/**
 * A drawn case whose first role's members are one statement of twoReachStatementGen's, the rest as sharedCaseGen draws
 * them: aimed at a read of an instance one other reads once, taking two modes.
 */
export const twoReachCaseGen: Gen<SharedCase> = (s) => {
	const drawn = s.draw(sharedCaseGen)
	const statement = s.draw(twoReachStatementGen(drawn.profile))
	return {
		...drawn,
		roles: Arr.map(drawn.roles, (role, i) => (i === 0 ? { ...role, members: [[statement]] } : role))
	}
}

/** A statement read again at each site of each instance it holds (test/support/expanded.ts), as the certifier reads it. */
export const flatFacts = (st: StatementFacts): StatementFacts => {
	const flat = expanded(st)
	return {
		writes: Arr.map(flat.writes, (w) => ({
			...w,
			from: Arr.map(w.from, (read) => ({ cte: undefined, read }))
		})),
		reads: flat.reads,
		probes: flat.probes,
		cores: flat.cores,
		uses: [],
		ctes: []
	}
}

/** Members of statements as the certifier reads them, each named by its place, each statement `as` gives it. */
const sharedMembers = (
	members: ReadonlyArray<ReadonlyArray<StatementFacts>>,
	as: (st: StatementFacts) => StatementFacts
): ReadonlyArray<MemberFacts> =>
	Arr.flatMap(members, (statements, m) =>
		Arr.isReadonlyArrayNonEmpty(statements)
			? [{ name: `m${m}`, statements: Arr.map(statements, as) }]
			: []
	)

/**
 * The member that stands for the unknown writes of a role with no change member (certify.ts writtenFacts), restated: by
 * its name, one statement that reads every relation its grants let it read (readableOf) for its absence, by no group,
 * and writes each relation the role holds a writer's privilege on by each write the privilege permits, joined with
 * nothing; none where it holds none.
 */
const directOf = (
	privileges: RoleSketch["privileges"]
): ReadonlyArray<readonly [string, ReadonlyArray<StatementFacts>]> => {
	const writes = Arr.flatMap(privileges, (p): ReadonlyArray<StatementFacts["writes"][number]> => {
		switch (p.privilege) {
			case "SELECT":
				return []
			case "INSERT":
				return [{ relation: relationName(p.relation), op: "insert", from: [] }]
			case "UPDATE":
				return [{ relation: relationName(p.relation), op: "update", from: [] }]
			case "DELETE":
				return [{ relation: relationName(p.relation), op: "delete", from: [] }]
		}
	})
	const reads = Arr.map(readableOf(privileges), (r): ReadFact => ({
		relation: relationName(r),
		mode: "negated",
		base: "negated",
		probes: [],
		own: false,
		group: undefined
	}))
	const distinct = Arr.dedupeWith(writes, (a, b) => a.relation === b.relation && a.op === b.op)
	return distinct.length === 0
		? []
		: [["(direct SQL)", [{ writes: distinct, reads, probes: [], cores: [], uses: [], ctes: [] }]]]
}

/** A case's facts as the certifier reads them, each statement `as` gives it (sharedMembers). */
export const sharedInput = (
	c: SharedCase,
	as: (st: StatementFacts) => StatementFacts
): IsolationInput => ({
	relations: relationsOf(c.relations),
	roles: Arr.map(c.roles, (role, i): RoleFacts => ({
		login: `L${role.login}`,
		role: `r${i}`,
		privileges: privilegesOf(role.privileges),
		writes: writesOf(role.privileges, role.members, sharedMembers(role.members, as))
	}))
})

/** What certification gives a case's roles, each statement `as` gives it (sharedMembers). */
export const sharedCertified = (c: SharedCase, as: (st: StatementFacts) => StatementFacts) =>
	certify(
		relationsOf(c.relations),
		Arr.map(sharedInput(c, as).roles, (role, i): Candidate<undefined, undefined, never> => ({
			kind: "formed",
			role,
			readCommitted: undefined,
			lower: () =>
				Result.ok({
					facts: sharedMembers(Arr.getUnsafe(c.roles, i).serializable, as),
					form: undefined
				})
		}))
	)

/** One mode one read of a member takes: the member, the statement, the read of the drawn statement it is, the mode. */
export interface ModeTaken {
	readonly member: number
	readonly statement: number
	readonly origin: ReadAt
	readonly mode: ReadFact["mode"]
}

/** A read's mode as the comparison keys it. */
export const modeKey = (t: ModeTaken): string =>
	`${t.member}|${t.statement}|${t.origin.cte ?? "-"}|${t.origin.read}|${t.mode}`

/**
 * Each mode each read of each of `members`' statements takes (readModes), among the case's roles, each statement `as`
 * gives it, each read named by the read of the drawn statement it is (`origin`), each once.
 */
export const modesTaken = (
	c: SharedCase,
	members: ReadonlyArray<ReadonlyArray<StatementFacts>>,
	as: (st: StatementFacts) => StatementFacts,
	origin: (statement: StatementFacts, at: ReadAt) => ReadAt | undefined
): ReadonlyArray<ModeTaken> => {
	const input = sharedInput(c, as)
	return Arr.dedupeWith(
		Arr.flatMap(members, (statements, m) =>
			Arr.flatMap(sharedMembers([statements], as), (member) =>
				Arr.flatMap(readModes(input, member), (r): ReadonlyArray<ModeTaken> => {
					const from = origin(Arr.getUnsafe(statements, r.statement), r.at)
					return from === undefined
						? []
						: [{ member: m, statement: r.statement, origin: from, mode: r.mode }]
				})
			)
		),
		(a, b) => modeKey(a) === modeKey(b)
	)
}

/** The features of the modes the reads of `members`' instances take (modesTaken). */
export const modeFeatures = (
	members: ReadonlyArray<ReadonlyArray<StatementFacts>>,
	taken: ReadonlyArray<ModeTaken>
): ReadonlyArray<SharedFeature> => {
	const nested = new Set(
		Arr.flatMap(Arr.flatten(members), (st) =>
			Arr.flatMap(st.ctes, (i) => Arr.map(i.uses, (u) => u.cte))
		)
	)
	return Arr.flatMap(taken, (t): ReadonlyArray<SharedFeature> => {
		const cte = t.origin.cte
		const twice = Arr.some(
			taken,
			(o) =>
				o.mode !== t.mode &&
				o.member === t.member &&
				o.statement === t.statement &&
				o.origin.cte === cte &&
				o.origin.read === t.origin.read
		)
		const statement = members[t.member]?.[t.statement]
		return !twice || cte === undefined
			? []
			: [
					"an instance read taking two modes",
					...(nested.has(cte)
						? ["a read of an instance another reads, taking two modes" as const]
						: []),
					...(statement !== undefined &&
					Arr.some(statement.ctes, (c) => Arr.some(c.uses, (u) => u.cte === cte)) &&
					usesOf(statement, cte) === 1
						? ["a read of an instance one other reads once, taking two modes" as const]
						: [])
				]
	})
}

/** How many uses of the instance at `cte` a statement's bodies hold, its own and its instances'. */
const usesOf = (st: StatementFacts, cte: number): number =>
	Arr.filter(
		Arr.flatMap([st, ...st.ctes], (b: BodyFacts<SiteCore>) => b.uses),
		(u) => u.cte === cte
	).length

/** The text of the reason a write joined with none of some outside reads of its statement gives, before its count. */
export const unjoinedReason = "a row it writes is not joined with the read of "

/** The count a write's reason gives of the other outside reads of its statement it is joined with none of. */
const unjoinedCount = regex("nor with \\d+ more outside read\\(s\\) there$")

/** A reason as the comparison keys it, whole. */
/** A reason's place as its keys spell it: its member, its statement and its relation, `-` for each it names none of. */
const placeText = (at: ReasonAt): string => {
	switch (at.kind) {
		case "role":
			return "-|-|-"
		case "relation":
			return `-|-|${at.relation}`
		case "member":
			return `${at.member}|-|${at.relation}`
		case "statement":
			return `${at.member}|${at.statement}|${at.relation}`
	}
}

export const unmaskedKey = (r: IsolationReason): string =>
	`${r.condition}|${placeText(r.at)}|${r.detail}`

/**
 * The reasons the writes of role `i`'s members give where they are joined with none of some outside reads of their
 * statement, as the contract restates them over the statements' expansions (test/support/expanded.ts), among `c`'s roles
 * at READ COMMITTED alone, so every round reads the same installation: for each write of a member with an outside read
 * and a write, the outside reads of its statement whose group none of its `from` reads, in their order, the first
 * named and the others counted each once, a read again at another site or arrival of its query CTE the same read
 * (CteFacts.query); with how many reads of the expansion (`reads`) and of the statement (`places`) that is, whether
 * one read of the statement among them takes two modes (`modes`), whether one read of a query CTE among them is read at
 * two of its instances (`instances`), and whether one of them takes two modes as an outside read it is joined with none
 * of (`outsideModes`).
 */
export const unjoinedOracle = (
	c: SharedCase,
	i: number
): ReadonlyArray<{
	readonly key: string
	readonly reads: number
	readonly places: number
	readonly modes: boolean
	readonly instances: boolean
	readonly outsideModes: boolean
}> => {
	const input = sharedInput(c, flatFacts)
	const role = Arr.getUnsafe(c.roles, i)
	const members: ReadonlyArray<readonly [string, ReadonlyArray<StatementFacts>]> =
		role.members.length > 0
			? Arr.map(role.members, (statements, m) => [`m${m}`, statements] as const)
			: directOf(role.privileges)
	return Arr.flatMap(members, ([name, statements]) => {
		const flats = Arr.map(statements, expanded)
		const placed = Arr.flatMap(sharedMembers([statements], flatFacts), (member) =>
			readModes(input, member)
		)
		const outsides = Arr.dedupeWith(
			Arr.filter(placed, (p) => p.outside),
			(a: (typeof placed)[number], b: (typeof placed)[number]) =>
				a.statement === b.statement && a.at.read === b.at.read
		)
		if (outsides.length === 0 || Arr.every(flats, (f) => f.writes.length === 0)) {
			return []
		}
		return Arr.flatMap(flats, (flat, j) =>
			Arr.flatMap(flat.writes, (w) => {
				const groupAt = (at: number): string => groupKey(Arr.getUnsafe(flat.reads, at))
				const joined = new Set(Arr.map(w.from, groupAt))
				const unjoined = Arr.filter(
					outsides,
					(p) => p.statement === j && !joined.has(groupAt(p.at.read))
				)
				const [missed] = unjoined
				if (missed === undefined) {
					return []
				}
				const st = Arr.getUnsafe(statements, j)
				const placeOf = (at: number): string => {
					const origin = Arr.getUnsafe(flat.origins, at)
					return origin.cte === undefined
						? `-|${origin.read}`
						: `${Arr.getUnsafe(st.ctes, origin.cte).query}|${origin.read}`
				}
				const places = new Set(Arr.map(unjoined, (p) => placeOf(p.at.read)))
				const taken = Arr.dedupe(
					Arr.flatMap(placed, (p) =>
						p.statement === j && places.has(placeOf(p.at.read))
							? [`${placeOf(p.at.read)}|${p.mode}`]
							: []
					)
				)
				const instances = new Set(
					Arr.map(
						unjoined,
						(p) => `${placeOf(p.at.read)}|${Arr.getUnsafe(flat.origins, p.at.read).cte ?? "-"}`
					)
				)
				const outsideTaken = Arr.dedupe(
					Arr.flatMap(placed, (p) =>
						p.outside && p.statement === j && !joined.has(groupAt(p.at.read))
							? [`${placeOf(p.at.read)}|${p.mode}`]
							: []
					)
				)
				return [
					{
						key: `pivot|${name}|${j}|${w.relation}|${unjoinedReason}${Arr.getUnsafe(flat.reads, missed.at.read).relation} in its statement, nor with ${places.size - 1} more outside read(s) there`,
						reads: unjoined.length,
						places: places.size,
						modes: taken.length > places.size,
						instances: instances.size > places.size,
						outsideModes: outsideTaken.length > places.size
					}
				]
			})
		)
	})
}

/**
 * A reason as the comparison of a statement with its expansion keys it: whole, but the count of the other outside reads
 * a write is joined with none of, which counts each read of the statement once, where the expansion counts each read
 * again at each site (unjoinedOracle holds the count to that).
 */
export const reasonKey = (r: IsolationReason): string =>
	`${r.condition}|${placeText(r.at)}|${Str.replace(
		unjoinedCount,
		"nor with more outside reads there"
	)(r.detail)}`

/** The situations the comparison of statements with their expansions must reach. */
export type SharedFeature =
	| "an instance read at two sites"
	| "an instance read beneath a probe of its site"
	| "an instance reading another"
	| "a site probe of an instance read at two sites"
	| "a role certified READ COMMITTED over an instance"
	| "a role SERIALIZABLE"
	| "a reason the expansion gives again"
	| "an instance read taking two modes"
	| "a read of an instance another reads, taking two modes"
	| "a probe decided by its row path over an instance's reads"
	| "a site probe of an instance read at two sites, decided by its row path"
	| "a write joined with none of a CTE's read at two sites or arrivals"
	| "a write joined with none of a read taking two modes"
	| "an instance reading another, read at two sites, one beneath a probe"
	| "a read of an instance one other reads once, taking two modes"
	| "a write joined with none of one query's read at two of its instances"
	| "a write joined with none of an outside read taking two modes"

/** The structural situations a statement reaches: what its instances' uses read and where. */
export const sharedFeatures = (st: StatementFacts): ReadonlyArray<SharedFeature> => {
	const bodies: ReadonlyArray<BodyFacts<SiteCore>> = [st, ...st.ctes]
	const uses = Arr.flatMap(bodies, (b) => b.uses)
	const sites = (cte: number): number => Arr.filter(uses, (u) => u.cte === cte).length
	return [
		...(Arr.some(st.ctes, (_, cte) => sites(cte) >= 2)
			? ["an instance read at two sites" as const]
			: []),
		...(Arr.some(uses, (u) => u.probes.length > 0)
			? ["an instance read beneath a probe of its site" as const]
			: []),
		...(Arr.some(st.ctes, (c) => c.uses.length > 0)
			? ["an instance reading another" as const]
			: []),
		...(Arr.some(
			st.ctes,
			(c, cte) => sites(cte) >= 2 && Arr.some(c.probes, (p) => p.core === "site")
		)
			? ["a site probe of an instance read at two sites" as const]
			: []),
		...(Arr.some(
			st.ctes,
			(c, cte) =>
				c.uses.length > 0 &&
				sites(cte) >= 2 &&
				Arr.some(uses, (u) => u.cte === cte && u.probes.length > 0)
		)
			? ["an instance reading another, read at two sites, one beneath a probe" as const]
			: [])
	]
}

/**
 * A case of the form search: a drawn installation (caseGen's), and the roles with a change member that has no READ
 * COMMITTED form (analysis/isolation/facts.ts Unformed), each with the sites it has none at, by member and relation, an
 * insert into a span primary key. Such a role has no member at READ COMMITTED, so its sketch's READ COMMITTED members
 * are none (`formOf`).
 */
interface FormCase {
	readonly sketch: Sketch
	readonly unformed: ReadonlyArray<{
		readonly role: number
		readonly sites: Arr.NonEmptyReadonlyArray<Unformed>
	}>
}

const unformedSiteGen: Gen<Unformed> = (s) => ({
	member: `m${s.draw(int(0, 2))}`,
	relation: relationName(s.draw(relationGen))
})

export const formCaseGen: Gen<FormCase> = (s) => {
	const { sketch } = s.draw(caseGen)
	return {
		sketch,
		unformed: Arr.flatMap(sketch.roles, (_, role) =>
			s.draw(
				weighted<boolean>([
					[2, () => false],
					[1, () => true]
				])
			)
				? [
						{
							role,
							sites: [
								s.draw(unformedSiteGen),
								...s.draw(array(unformedSiteGen, { min: 0, max: 1 }))
							]
						}
					]
				: []
		)
	}
}

/** The case's installation as certification reads it: each role with no READ COMMITTED form holding no member there. */
export const formOf = (c: FormCase): Sketch =>
	Arr.reduce(c.unformed, c.sketch, (sketch, u) =>
		withRole(sketch, u.role, (r) => ({ ...r, members: [[]] }))
	)

/** Each role of a form case as certification takes it: formed, or lowered already by its sites (Candidate). */
export const formCandidates = (
	c: FormCase
): ReadonlyArray<Candidate<undefined, undefined, never>> =>
	Arr.map(inputOf(formOf(c)).roles, (role, i): Candidate<undefined, undefined, never> => {
		const facts = membersOf(Arr.getUnsafe(c.sketch.roles, i).serializable)
		return Option.match(
			Arr.findFirst(c.unformed, (u) => u.role === i),
			{
				onNone: () => ({
					kind: "formed",
					role,
					readCommitted: undefined,
					lower: () => Result.ok({ facts, form: undefined })
				}),
				onSome: (u) => ({
					kind: "unformed",
					role,
					unformed: u.sites,
					lowering: { facts, form: undefined }
				})
			}
		)
	})

/** A reason as the form search compares it: where it applies and its condition, not its prose. */
export type ReasonSite = Pick<IsolationReason, "condition" | "at">

export const reasonSite = (r: IsolationReason): ReasonSite => ({ condition: r.condition, at: r.at })

export type FormFeature =
	| "a role SERIALIZABLE by form"
	| "a role certified READ COMMITTED beside a role with no READ COMMITTED form"
	| "a role SERIALIZABLE by reasons a role with no READ COMMITTED form gives"
	| "a judged role SERIALIZABLE by its own conditions beside a role with no READ COMMITTED form"
