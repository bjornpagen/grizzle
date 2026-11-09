/**
 * Rules over queries on PostgreSQL 19rc1: a rule whose side reads a derived relation holds at every COMMIT, judged on
 * its definition, live, whoever writes and however writes interleave.
 *
 * The schema joins two and three relations, selects, projects and negates: J2 = R ⋈ S on k, J3 = J2 ⋈ U on (a, b), the
 * semijoin Semi = R ⋉ S on k projected on R's id and k, the self-join Self of R's rows of one k whose a is below
 * another's, and the anti-join Lonely of R's rows no S row shares a k with. Its rules are a containment of a
 * two-relation query in a table, of a table in a three-relation query, of a semijoin in a table, of a self-join in a
 * table, of a selection of a query in a table, and of the anti-join in a table and a table in the anti-join (so V holds
 * exactly Lonely's ids, and both an S row's insert and its delete can break one), a key over a query and a check over a
 * three-relation query: every rule kind, with a query on either side of a containment.
 *
 * - **The specification turned into a checker:** each rule restated over the rows, a host model of R, S, U, T, W and V
 *   that evaluates J2, J3, Semi, Self and Lonely itself and judges every rule over the state a transaction leaves. A
 *   transaction commits exactly when the state it leaves keeps every rule. A direct SQL writer's refusal is at COMMIT,
 *   SQLSTATE 23503 for a containment, 23505 for the key and 23514 for the check, naming a trigger the installation's
 *   constraint map maps to a rule the model judges broken, the check's under the name constraintNamesOf gives its rule;
 *   grizzle's db.apply answers `invariant-rejected`, naming rules the model judges broken, its witness `unreported`.
 * - **Concurrent writers:** after its serial history, each case opens two direct SQL transactions at SERIALIZABLE, each
 *   taking its snapshot, commits a ChangeSet through grizzle's db.apply while both are open, then runs both SQL
 *   writers' statements, both open before either commits, and reads every table back: the state committed keeps every
 *   rule, whichever of them PostgreSQL refused, by a rule or by a serialization failure.
 *
 * Each case draws a history of transactions, by direct SQL or by grizzle, from coherent clusters (an R, S, U, T and W
 * row that keep every rule together), lonely rows (an R row with its V row), single inserts, deletes and, by SQL,
 * updates of drawn rows, the unwinding of a J3 fact, which deletes every row of its derivation from R, S and U in one
 * transaction while W may still need it, and the end of a lonely row, which deletes it and inserts an S row of its k in
 * one transaction while V may still hold its id: the two situations a target probe's relaxation exists for, which the
 * search requires.
 *
 * Planted in a scratch copy, each of these fails the search: no trigger on one table a rule reads; a NEW probe that
 * restricts only the first occurrence of the written relation in an arm, which misses the self-join; a key over a
 * query whose violation needs every heading field to differ; a target probe that joins the later occurrences as they
 * stand instead of relaxing them, which misses an unwinding; no probe for the rows a negated relation's write blocks or
 * unblocks; and a target probe that keeps the target's anti-joins, which misses a lonely row's end.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, type Weighted, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Data, Effect, Formatter, Layer, Option, Order } from "effect"
import { apply } from "#adapter/apply/index.ts"
import { dbContext } from "#adapter/db/context.ts"
import { Db } from "#adapter/public/db.ts"
import { constraintLaw } from "#compiler/ir/products.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	check,
	constraintNamesOf,
	contained,
	derived,
	key,
	on,
	relation,
	schema,
	select
} from "#compiler/public/schema.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { cleared, seatOfInstalled } from "#test/pg/fin/installed.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { defined } from "#test/support/assert.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { caseHang } from "#test/support/limits.ts"
import { attempt, momentText, refusalOf, refusalText } from "#test/support/substrate.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld, loginLayer } from "#test/support/worlds.ts"

const R = relation("R", { id: pg.integer, k: pg.integer, a: pg.integer }, ["id"])
const S = relation("S", { id: pg.integer, k: pg.integer, b: pg.integer }, ["id"])
const U = relation("U", { id: pg.integer, a: pg.integer, b: pg.integer }, ["id"])
const T = relation("T", { a: pg.integer, b: pg.integer }, ["a", "b"])
const W = relation("W", { id: pg.integer, k: pg.integer }, ["id"])
const V = relation("V", { id: pg.integer }, ["id"])

/**
 * The schema under `name`: R, S, U, T, W and V stored, and J2, J3, Semi, Lonely and Self derived over them, live, with
 * a rule over each.
 */
const ruleQuery = (name: string) => {
	const Base = schema(name, { R, S, U, T, W, V }, [])
	const J2 = derived(
		"J2",
		query(Base).rule((r) => {
			const { k, a } = v(R, "r")
			const { b } = v(S, "s")
			return r.match(R, { k, a }).match(S, { k, b }).find({ k, a, b })
		})
	)
	const J3 = derived(
		"J3",
		query(Base).rule((r) => {
			const { k, a } = v(R, "r")
			const { b } = v(S, "s")
			return r.match(R, { k, a }).match(S, { k, b }).match(U, { a, b }).find({ k, a, b })
		})
	)
	const Semi = derived(
		"Semi",
		query(Base).rule((r) => {
			const { id, k } = v(R, "r")
			return r.match(R, { id, k }).match(S, { k }).find({ id, k })
		})
	)
	/** The R rows no S row shares a k with: an anti-join. */
	const Lonely = derived(
		"Lonely",
		query(Base).rule((r) => {
			const { id, k } = v(R, "r")
			return r.match(R, { id, k }).where(r.not(S, { k })).find({ id, k })
		})
	)
	const Self = derived(
		"Self",
		query(Base).rule((r) => {
			const { k, a: lo } = v(R, "x")
			const { a: hi } = v(R, "y")
			return r.match(R, { k, a: lo }).match(R, { k, a: hi }).where(r.lt(lo, hi)).find({ k, lo, hi })
		})
	)
	return schema.extend(Base, `${name}_1`, { J2, J3, Semi, Self, Lonely }, [
		contained(on(J2, "a", "b"), on(T, "a", "b")),
		contained(on(W, "k"), on(J3, "k")),
		key(on(J2, "k", "a")),
		check("NoTwoTwo", J3, (j) => j.not(j.and(j.eq(j.a, 2), j.eq(j.b, 2)))),
		contained(on(Semi, "id"), on(W, "id")),
		contained(on(Self, "lo", "hi"), on(T, "a", "b")),
		contained(
			on(
				select(J2, (j) => j.eq(j.b, 1)),
				"k"
			),
			on(W, "k")
		),
		contained(on(Lonely, "id"), on(V, "id")),
		contained(on(V, "id"), on(Lonely, "id"))
	])
}

const RELATIONS = ["R", "S", "U", "T", "W", "V"] as const

/** The rules, in the schema's statement order. */
const rules = [
	"source2",
	"target3",
	"key2",
	"check3",
	"semi",
	"self",
	"selected",
	"lonely",
	"vLonely"
] as const
type Rule = (typeof rules)[number]

/** The rule an outcome's law is, by what it states. */
const ruleOf = (law: Law): Rule | undefined => {
	switch (law.kind) {
		case "contained":
			return law.from.relation === "J2" && law.to.relation === "T"
				? "source2"
				: law.from.relation === "W" && law.to.relation === "J3"
					? "target3"
					: law.from.relation === "Semi"
						? "semi"
						: law.from.relation === "Self"
							? "self"
							: law.from.relation === "J2" && law.to.relation === "W"
								? "selected"
								: law.from.relation === "Lonely"
									? "lonely"
									: law.from.relation === "V"
										? "vLonely"
										: undefined
		case "key":
			return law.side.relation === "J2" ? "key2" : undefined
		case "check":
			return law.name === "NoTwoTwo" ? "check3" : undefined
		case "contract":
		case "coverage":
		case "family":
		case "above":
		case "fold":
		case "generated":
		case "pattern":
		case "primaryKey":
		case "tree":
			return undefined
	}
}

/** The SQLSTATE a refusal of each rule raises: 23503 a containment, 23505 a key, 23514 a check. */
const codeOf = (rule: Rule): string =>
	rule === "key2" ? "23505" : rule === "check3" ? "23514" : "23503"

/** The host model: each relation's rows by primary key. */
interface State {
	readonly R: ReadonlyMap<number, { readonly k: number; readonly a: number }>
	readonly S: ReadonlyMap<number, { readonly k: number; readonly b: number }>
	readonly U: ReadonlyMap<number, { readonly a: number; readonly b: number }>
	readonly T: ReadonlyMap<string, readonly [number, number]>
	readonly W: ReadonlyMap<number, { readonly k: number }>
	readonly V: ReadonlyMap<number, number>
}

const emptyState: State = {
	R: new Map(),
	S: new Map(),
	U: new Map(),
	T: new Map(),
	W: new Map(),
	V: new Map()
}

const pair = (a: number, b: number): string => `${a},${b}`

interface Fact3 {
	readonly k: number
	readonly a: number
	readonly b: number
}

/** J2's facts, a set by its heading. */
const j2 = (s: State): ReadonlyArray<Fact3> =>
	Arr.dedupeWith(
		Arr.flatMap([...s.R.values()], (r) =>
			Arr.map(
				Arr.filter([...s.S.values()], (x) => x.k === r.k),
				(x) => ({ k: r.k, a: r.a, b: x.b })
			)
		),
		(x, y) => x.k === y.k && x.a === y.a && x.b === y.b
	)

const j3 = (s: State): ReadonlyArray<Fact3> =>
	Arr.filter(j2(s), (f) => Arr.some([...s.U.values()], (u) => u.a === f.a && u.b === f.b))

/** Lonely's ids: the R rows no S row shares a k with. */
const lonely = (s: State): ReadonlyArray<number> =>
	Arr.map(
		Arr.filter([...s.R.entries()], ([, r]) => !Arr.some([...s.S.values()], (x) => x.k === r.k)),
		([id]) => id
	)

/** Every rule the state breaks, in rule order. */
const broken = (s: State): ReadonlyArray<Rule> => {
	const two = j2(s)
	const three = j3(s)
	const ws = [...s.W.values()]
	const semiIds = Arr.map(
		Arr.filter([...s.R.entries()], ([, r]) => Arr.some([...s.S.values()], (x) => x.k === r.k)),
		([id]) => id
	)
	const rs = [...s.R.values()]
	const lonelyIds = lonely(s)
	const selfs = Arr.flatMap(rs, (x) =>
		Arr.map(
			Arr.filter(rs, (y) => y.k === x.k && x.a < y.a),
			(y) => pair(x.a, y.a)
		)
	)
	const breaks: Readonly<Record<Rule, boolean>> = {
		source2: Arr.some(two, (f) => !s.T.has(pair(f.a, f.b))),
		target3: Arr.some(ws, (w) => !Arr.some(three, (f) => f.k === w.k)),
		key2: Arr.some(two, (f) => Arr.some(two, (g) => g.k === f.k && g.a === f.a && g.b !== f.b)),
		check3: Arr.some(three, (f) => f.a === 2 && f.b === 2),
		semi: Arr.some(semiIds, (id) => !s.W.has(id)),
		self: Arr.some(selfs, (lohi) => !s.T.has(lohi)),
		selected: Arr.some(two, (f) => f.b === 1 && !Arr.some(ws, (w) => w.k === f.k)),
		lonely: Arr.some(lonelyIds, (id) => !s.V.has(id)),
		vLonely: Arr.some([...s.V.keys()], (id) => !lonelyIds.includes(id))
	}
	return Arr.filter(rules, (r) => breaks[r])
}

type Rel = "R" | "S" | "U" | "W"
type Deleted = Rel | "V"

/**
 * One write of a transaction as drawn that inserts or deletes rows, which grizzle's ChangeSet states as well as SQL: a
 * pick resolves against the rows of its relation where it runs.
 */
type Edit =
	| { readonly kind: "cluster"; readonly k: number; readonly a: number; readonly b: number }
	| { readonly kind: "insert"; readonly relation: Rel; readonly x: number; readonly y: number }
	| { readonly kind: "insertT"; readonly a: number; readonly b: number }
	| { readonly kind: "lone"; readonly k: number; readonly a: number }
	| { readonly kind: "delete"; readonly relation: Deleted; readonly pick: number }
	| { readonly kind: "deleteT"; readonly pick: number }
	| { readonly kind: "unwind"; readonly pick: number }
	| { readonly kind: "unlone"; readonly pick: number; readonly keepV: boolean }

/**
 * One write of a direct SQL writer's transaction: an edit, an UPDATE of one field of a picked row, or the shift of a
 * picked J2 fact's W rows, whose b is 1, to another k a J3 fact holds, which leaves the fact's k without a W row.
 */
type Op =
	| Edit
	| {
			readonly kind: "update"
			readonly relation: Rel
			readonly pick: number
			readonly second: boolean
			readonly value: number
	  }
	| { readonly kind: "shift"; readonly pick: number }

const rels: Arr.NonEmptyReadonlyArray<Rel> = ["R", "S", "U", "W"]
const deleted: Arr.NonEmptyReadonlyArray<Deleted> = [...rels, "V"]

const edits: Arr.NonEmptyReadonlyArray<Weighted<Edit>> = [
	[
		3,
		(s) => ({ kind: "cluster", k: s.draw(int(0, 1)), a: s.draw(int(0, 2)), b: s.draw(int(0, 2)) })
	],
	[
		2,
		(s) => ({
			kind: "insert",
			relation: s.draw(element(rels)),
			x: s.draw(int(0, 2)),
			y: s.draw(int(0, 2))
		})
	],
	[1, (s) => ({ kind: "insertT", a: s.draw(int(0, 2)), b: s.draw(int(0, 2)) })],
	[1, (s) => ({ kind: "lone", k: s.draw(int(0, 2)), a: s.draw(int(0, 2)) })],
	[2, (s) => ({ kind: "delete", relation: s.draw(element(deleted)), pick: s.draw(int(0, 9)) })],
	[1, (s) => ({ kind: "deleteT", pick: s.draw(int(0, 9)) })],
	[2, (s) => ({ kind: "unwind", pick: s.draw(int(0, 9)) })],
	[1, (s) => ({ kind: "unlone", pick: s.draw(int(0, 9)), keepV: s.draw(element([false, true])) })]
]

const opGen: Gen<Op> = weighted<Op>([
	...edits,
	[
		2,
		(s) => ({
			kind: "update",
			relation: s.draw(element(rels)),
			pick: s.draw(int(0, 9)),
			second: s.draw(element([false, true])),
			value: s.draw(int(0, 2))
		})
	],
	[1, (s) => ({ kind: "shift", pick: s.draw(int(0, 9)) })]
])

const sqlGen: Gen<ReadonlyArray<Op>> = array(opGen, { min: 1, max: 4 })
const grizzleGen: Gen<ReadonlyArray<Edit>> = array(weighted(edits), { min: 1, max: 4 })

/** A transaction of the serial history: direct SQL statements, or one ChangeSet grizzle's db.apply writes. */
type Transaction =
	| { readonly writer: "sql"; readonly ops: ReadonlyArray<Op> }
	| { readonly writer: "grizzle"; readonly ops: ReadonlyArray<Edit> }

const transactionGen: Gen<Transaction> = weighted<Transaction>([
	[2, (s) => ({ writer: "sql", ops: s.draw(sqlGen) })],
	[1, (s) => ({ writer: "grizzle", ops: s.draw(grizzleGen) })]
])

/**
 * A case: its serial history, then two direct SQL writers and one grizzle writer at once, each drawn against the state
 * the history leaves.
 */
interface RuleCase {
	readonly history: ReadonlyArray<Transaction>
	readonly concurrent: {
		readonly first: ReadonlyArray<Op>
		readonly second: ReadonlyArray<Op>
		readonly grizzle: ReadonlyArray<Edit>
	}
}

const caseGen: Gen<RuleCase> = (s) => ({
	history: s.draw(array(transactionGen, { min: 1, max: 6 })),
	concurrent: { first: s.draw(sqlGen), second: s.draw(sqlGen), grizzle: s.draw(grizzleGen) }
})

type Feature =
	| "committed"
	| "committed a J3 fact"
	| "committed a lonely row"
	| `refused by ${Rule}`
	| "a fact unwound across tables while W needs it"
	| "a lonely row deleted and blocked at once while V needs it"
	| "a grizzle write committed"
	| "a grizzle write refused by a rule"
	| "concurrent writers all committed"
	| "concurrent writer refused"
	| "concurrent writer refused by a serialization failure"

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** The row of `rows` a pick names, in key order, or none of an empty relation. */
const picked = <V>(
	rows: ReadonlyMap<number, V>,
	pick: number
): Option.Option<readonly [number, V]> => {
	const entries = Arr.sort(
		[...rows.entries()],
		Order.mapInput(Order.Number, ([id]: readonly [number, V]) => id)
	)
	return entries.length === 0
		? Option.none()
		: Option.some(Arr.getUnsafe(entries, pick % entries.length))
}

/**
 * A transaction resolved against a state: its statements, the state it leaves, the k of each J3 fact it unwinds, and
 * the id of each lonely row it deletes beside an S row of its k it inserts, keeping its V row.
 */
interface Resolved {
	readonly statements: ReadonlyArray<string>
	readonly after: State
	readonly unwound: ReadonlyArray<number>
	readonly withdrawn: ReadonlyArray<number>
}

/** Fresh primary keys, one counter per relation, shared by every session of a case. */
class Keys {
	#next = 1
	fresh(): number {
		return this.#next++
	}
}

const resolve = (
	ops: ReadonlyArray<Op>,
	before: State,
	keys: Keys,
	table: (relation: string) => string
): Resolved => {
	const R = new Map(before.R)
	const S = new Map(before.S)
	const U = new Map(before.U)
	const Tr = new Map(before.T)
	const Wr = new Map(before.W)
	const Vr = new Map(before.V)
	const statements: Array<string> = []
	const unwound: Array<number> = []
	const withdrawn: Array<number> = []
	const insertRow = (relation: Rel, id: number, x: number, y: number): void => {
		switch (relation) {
			case "R":
				R.set(id, { k: x, a: y })
				statements.push(`INSERT INTO ${table("R")} (id, k, a) VALUES (${id}, ${x}, ${y})`)
				return
			case "S":
				S.set(id, { k: x, b: y })
				statements.push(`INSERT INTO ${table("S")} (id, k, b) VALUES (${id}, ${x}, ${y})`)
				return
			case "U":
				U.set(id, { a: x, b: y })
				statements.push(`INSERT INTO ${table("U")} (id, a, b) VALUES (${id}, ${x}, ${y})`)
				return
			case "W":
				Wr.set(id, { k: x })
				statements.push(`INSERT INTO ${table("W")} (id, k) VALUES (${id}, ${x})`)
				return
		}
	}
	const insertT = (a: number, b: number): void => {
		Tr.set(pair(a, b), [a, b])
		statements.push(`INSERT INTO ${table("T")} (a, b) VALUES (${a}, ${b}) ON CONFLICT DO NOTHING`)
	}
	const rowsOf = (relation: Deleted): Map<number, unknown> =>
		relation === "R" ? R : relation === "S" ? S : relation === "U" ? U : relation === "W" ? Wr : Vr
	const deleteRow = (relation: Deleted, id: number): void => {
		rowsOf(relation).delete(id)
		statements.push(`DELETE FROM ${table(relation)} WHERE id = ${id}`)
	}
	for (const op of ops) {
		switch (op.kind) {
			case "cluster": {
				const id = keys.fresh()
				insertRow("R", id, op.k, op.a)
				insertRow("S", keys.fresh(), op.k, op.b)
				insertRow("U", keys.fresh(), op.a, op.b)
				insertT(op.a, op.b)
				insertRow("W", id, op.k, 0)
				break
			}
			case "insert":
				insertRow(op.relation, keys.fresh(), op.x, op.y)
				break
			case "insertT":
				insertT(op.a, op.b)
				break
			case "lone": {
				const id = keys.fresh()
				insertRow("R", id, op.k, op.a)
				Vr.set(id, id)
				statements.push(`INSERT INTO ${table("V")} (id) VALUES (${id})`)
				break
			}
			case "delete": {
				const found = picked(rowsOf(op.relation), op.pick)
				if (Option.isSome(found)) {
					deleteRow(op.relation, found.value[0])
				}
				break
			}
			case "deleteT": {
				const all = Arr.sort(
					[...Tr],
					Order.mapInput(Order.String, ([key]: readonly [string, readonly [number, number]]) => key)
				)
				const at = all.length === 0 ? undefined : all[op.pick % all.length]
				if (at !== undefined) {
					const [key, [a, b]] = at
					Tr.delete(key)
					statements.push(`DELETE FROM ${table("T")} WHERE a = ${a} AND b = ${b}`)
				}
				break
			}
			case "update": {
				const id = Option.map(picked(rowsOf(op.relation), op.pick), ([k]) => k)
				if (Option.isNone(id)) {
					break
				}
				const at = id.value
				const v = op.value
				switch (op.relation) {
					case "R": {
						const r = defined(R.get(at), "a picked row")
						R.set(at, op.second ? { ...r, a: v } : { ...r, k: v })
						statements.push(
							`UPDATE ${table("R")} SET ${op.second ? "a" : "k"} = ${v} WHERE id = ${at}`
						)
						break
					}
					case "S": {
						const r = defined(S.get(at), "a picked row")
						S.set(at, op.second ? { ...r, b: v } : { ...r, k: v })
						statements.push(
							`UPDATE ${table("S")} SET ${op.second ? "b" : "k"} = ${v} WHERE id = ${at}`
						)
						break
					}
					case "U": {
						const r = defined(U.get(at), "a picked row")
						U.set(at, op.second ? { ...r, b: v } : { ...r, a: v })
						statements.push(
							`UPDATE ${table("U")} SET ${op.second ? "b" : "a"} = ${v} WHERE id = ${at}`
						)
						break
					}
					case "W":
						Wr.set(at, { k: v })
						statements.push(`UPDATE ${table("W")} SET k = ${v} WHERE id = ${at}`)
						break
				}
				break
			}
			case "shift": {
				const now = { R, S, U, T: Tr, W: Wr, V: Vr }
				const ones = Arr.filter(j2(now), (f) => f.b === 1)
				const fact = ones.length === 0 ? undefined : ones[op.pick % ones.length]
				const to = fact === undefined ? undefined : Arr.findFirst(j3(now), (f) => f.k !== fact.k)
				if (fact === undefined || to === undefined || Option.isNone(to)) {
					break
				}
				for (const [id, w] of Wr) {
					if (w.k === fact.k) {
						Wr.set(id, { k: to.value.k })
						statements.push(`UPDATE ${table("W")} SET k = ${to.value.k} WHERE id = ${id}`)
					}
				}
				break
			}
			case "unlone": {
				const found = picked(
					new Map(Arr.filter([...R], ([, r]) => !Arr.some([...S.values()], (x) => x.k === r.k))),
					op.pick
				)
				if (Option.isNone(found)) {
					break
				}
				const [id, r] = found.value
				deleteRow("R", id)
				insertRow("S", keys.fresh(), r.k, 0)
				if (Vr.has(id)) {
					if (op.keepV) {
						withdrawn.push(id)
					} else {
						deleteRow("V", id)
					}
				}
				break
			}
			case "unwind": {
				const facts = j3({ R, S, U, T: Tr, W: Wr, V: Vr })
				const fact = facts.length === 0 ? undefined : facts[op.pick % facts.length]
				if (fact === undefined) {
					break
				}
				unwound.push(fact.k)
				for (const [id, r] of R) {
					if (r.k === fact.k && r.a === fact.a) {
						deleteRow("R", id)
					}
				}
				for (const [id, x] of S) {
					if (x.k === fact.k && x.b === fact.b) {
						deleteRow("S", id)
					}
				}
				for (const [id, u] of U) {
					if (u.a === fact.a && u.b === fact.b) {
						deleteRow("U", id)
					}
				}
				break
			}
		}
	}
	return { statements, after: { R, S, U, T: Tr, W: Wr, V: Vr }, unwound, withdrawn }
}

/** The rows a table holds now, read back as integers. */
const readState = <E>(
	values: (sql: string) => Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, E>,
	table: (relation: string) => string
): Effect.Effect<State, E> =>
	Effect.gen(function* () {
		const n = (x: unknown): number => Number(x)
		const r = yield* values(`SELECT id, k, a FROM ${table("R")}`)
		const s = yield* values(`SELECT id, k, b FROM ${table("S")}`)
		const u = yield* values(`SELECT id, a, b FROM ${table("U")}`)
		const t = yield* values(`SELECT a, b FROM ${table("T")}`)
		const w = yield* values(`SELECT id, k FROM ${table("W")}`)
		const vs = yield* values(`SELECT id FROM ${table("V")}`)
		return {
			R: new Map(Arr.map(r, (x) => [n(x[0]), { k: n(x[1]), a: n(x[2]) }] as const)),
			S: new Map(Arr.map(s, (x) => [n(x[0]), { k: n(x[1]), b: n(x[2]) }] as const)),
			U: new Map(Arr.map(u, (x) => [n(x[0]), { a: n(x[1]), b: n(x[2]) }] as const)),
			T: new Map(Arr.map(t, (x) => [pair(n(x[0]), n(x[1])), [n(x[0]), n(x[1])] as const] as const)),
			W: new Map(Arr.map(w, (x) => [n(x[0]), { k: n(x[1]) }] as const)),
			V: new Map(Arr.map(vs, (x) => [n(x[0]), n(x[0])] as const))
		}
	})

/** The rows `after` holds at a key `before` does not. */
const added = <K, A>(
	before: ReadonlyMap<K, A>,
	after: ReadonlyMap<K, A>
): ReadonlyArray<readonly [K, A]> => Arr.filter([...after.entries()], ([key]) => !before.has(key))

/**
 * The ChangeSet that takes `before` to `after`, as a grizzle transaction's edits reach it: each row of `after` at a key
 * `before` lacks inserted, each row of `before` at a key `after` lacks deleted. An edit inserts at a fresh key and
 * changes no row, so no key holds a row on both sides that differs.
 */
const changesOf = (value: ReturnType<typeof ruleQuery>, before: State, after: State) =>
	ChangeSet.empty(value)
		.insert(
			R,
			Arr.map(added(before.R, after.R), ([id, r]) => ({ id, k: r.k, a: r.a }))
		)
		.insert(
			S,
			Arr.map(added(before.S, after.S), ([id, x]) => ({ id, k: x.k, b: x.b }))
		)
		.insert(
			U,
			Arr.map(added(before.U, after.U), ([id, u]) => ({ id, a: u.a, b: u.b }))
		)
		.insert(
			T,
			Arr.map(added(before.T, after.T), ([, [a, b]]) => ({ a, b }))
		)
		.insert(
			W,
			Arr.map(added(before.W, after.W), ([id, w]) => ({ id, k: w.k }))
		)
		.insert(
			V,
			Arr.map(added(before.V, after.V), ([id]) => ({ id }))
		)
		.delete(
			R,
			Arr.map(added(after.R, before.R), ([id, r]) => ({ id, k: r.k, a: r.a }))
		)
		.delete(
			S,
			Arr.map(added(after.S, before.S), ([id, x]) => ({ id, k: x.k, b: x.b }))
		)
		.delete(
			U,
			Arr.map(added(after.U, before.U), ([id, u]) => ({ id, a: u.a, b: u.b }))
		)
		.delete(
			T,
			Arr.map(added(after.T, before.T), ([, [a, b]]) => ({ a, b }))
		)
		.delete(
			W,
			Arr.map(added(after.W, before.W), ([id, w]) => ({ id, k: w.k }))
		)
		.delete(
			V,
			Arr.map(added(after.V, before.V), ([id]) => ({ id }))
		)

/** Whether two versions of a relation hold the same keys. */
const sameKeys = <K, A>(before: ReadonlyMap<K, A>, after: ReadonlyMap<K, A>): boolean =>
	added(before, after).length === 0 && added(after, before).length === 0

/** Whether `before` and `after` hold the same keys of every relation. */
const unchanged = (before: State, after: State): boolean =>
	sameKeys(before.R, after.R) &&
	sameKeys(before.S, after.S) &&
	sameKeys(before.U, after.U) &&
	sameKeys(before.T, after.T) &&
	sameKeys(before.W, after.W) &&
	sameKeys(before.V, after.V)

/** A serialization failure's SQLSTATE. */
const serializationFailure = "40001"

layer(Substrate.layer, { excludeTestServices: true })(
	"rules over queries on PostgreSQL 19rc1",
	(it) => {
		it.effect(
			"commit exactly the histories whose every state keeps every rule over a query, refusing the rest by the broken rule's trigger, and commit no broken state under concurrent writers",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const declared = ruleQuery("RuleQuery")
						const done = yield* installMigrated(declared, {
							ambient: ordinarySession,
							label: "rule_query",
							logins: [fullWorld(declared).server],
							extensions: []
						})
						const value = ruleQuery(done.schema)
						/** The name a direct writer's refusal by the check over J3 reports, its triggers', taken from grizzle. */
						const checkName = constraintNamesOf(value)({
							kind: "check",
							relation: "J3",
							name: "NoTwoTwo"
						})
						const world = fullWorld(value)
						const seat = yield* seatOfInstalled(done, RELATIONS, "rule_query")
						const context = yield* Layer.build(loginLayer(done, world.server))
						const db = yield* Db.open(world.server.roles.app, {}).pipe(
							Effect.provideContext(context)
						)
						const dbc = dbContext(db)
						if (dbc === undefined) {
							return yield* Effect.die(new Error("Db.open registered no context"))
						}
						const substrate = yield* Substrate
						const second = yield* substrate.session({
							...ownerSession(),
							label: "rule_query_second"
						})
						const installation = seat.installed.installation
						/** The ChangeSet taking `before` to `after`, applied by grizzle's db.apply as the application's login. */
						const write = (before: State, after: State) => {
							const changes = changesOf(value, before, after)
							return apply(dbc, changes, changes.reads, {})
						}
						/** The rule a refusal's trigger reports, through the installation's constraint map. */
						const refusedRule = (fields: {
							readonly table: Option.Option<string>
							readonly constraint: string | undefined
						}): Rule | undefined => {
							if (Option.isNone(fields.table) || fields.constraint === undefined) {
								return undefined
							}
							const law = constraintLaw(
								installation.constraintToLaw,
								{
									kind: "table",
									name: installation.names.relation(tableRelation(fields.table.value)).name
								},
								fields.constraint
							)
							const described = law === undefined ? undefined : installation.described.get(law)
							return described === undefined ? undefined : ruleOf(described)
						}
						const tableRelation = (ident: string): string =>
							Option.getOrThrowWith(
								Arr.findFirst(RELATIONS, (r) => installation.names.relation(r).name === ident),
								() => new Error(`the table ${ident} of a relation of the schema`)
							)
						return yield* explore(
							{
								suite: "laws/rule-query",
								draw: drawn(caseGen),
								literal: Formatter.format,
								oracle: {
									kind: "specification",
									name: "every rule restated over the rows: a transaction commits exactly when the state it leaves keeps every rule, and concurrent writers commit no state that breaks one"
								},
								coverage: required<Feature>(
									[
										"committed",
										"committed a J3 fact",
										"committed a lonely row",
										...Arr.map(rules, (r) => `refused by ${r}` as const),
										"a fact unwound across tables while W needs it",
										"a lonely row deleted and blocked at once while V needs it",
										"a grizzle write committed",
										"a grizzle write refused by a rule",
										"concurrent writers all committed",
										"concurrent writer refused",
										"concurrent writer refused by a serialization failure"
									],
									{ cases: 200, sense: notesOnly }
								),
								kept: [],
								runs: 120,
								shrink: { kind: "bounded", candidates: 60 },
								concurrency: 1,
								steerEvery: 16,
								caseHang
							},
							(rc, c) =>
								Effect.gen(function* () {
									yield* cleared(seat, RELATIONS)
									const keys = new Keys()
									let state: State = emptyState
									const committed = (after: State): void => {
										state = after
										c.note("committed")
										if (j3(state).length > 0) {
											c.note("committed a J3 fact")
										}
										if (lonely(state).length > 0) {
											c.note("committed a lonely row")
										}
									}
									for (const tx of rc.history) {
										const t = resolve(tx.ops, state, keys, seat.table)
										const breaks = broken(t.after)
										const needed = Arr.some(t.unwound, (k) =>
											Arr.some([...state.W.values()], (w) => w.k === k)
										)
										if (tx.writer === "grizzle") {
											const outcome = yield* write(state, t.after)
											if (outcome.kind === "accepted" || outcome.kind === "no-change") {
												if (
													breaks.length > 0 ||
													(outcome.kind === "no-change") !== unchanged(state, t.after)
												) {
													return yield* new Disagreed({
														message: `grizzle's write answered ${outcome.kind} where the state it leaves breaks ${Arr.join(breaks, ", ") || "nothing"}: ${Formatter.format(tx.ops)}`
													})
												}
												committed(t.after)
												c.note("a grizzle write committed")
												continue
											}
											const named =
												outcome.kind === "invariant-rejected"
													? Arr.map(outcome.refused.laws, ruleOf)
													: []
											const broke = (r: Rule | undefined): boolean =>
												r !== undefined && breaks.includes(r)
											if (
												outcome.kind !== "invariant-rejected" ||
												outcome.witness.kind !== "unreported" ||
												!(outcome.refused.kind === "some"
													? Arr.some(named, broke)
													: Arr.isReadonlyArrayNonEmpty(named) && Arr.every(named, broke))
											) {
												return yield* new Disagreed({
													message: `grizzle's write answered ${Formatter.format(outcome)} where the state it leaves breaks ${Arr.join(breaks, ", ") || "nothing"}: ${Formatter.format(tx.ops)}`
												})
											}
											for (const r of named) {
												if (broke(r)) {
													c.note(`refused by ${defined(r, "a rule the refusal names")}`)
												}
											}
											c.note("a grizzle write refused by a rule")
											if (needed && breaks.includes("target3")) {
												c.note("a fact unwound across tables while W needs it")
											}
											if (t.withdrawn.length > 0 && breaks.includes("vLonely")) {
												c.note("a lonely row deleted and blocked at once while V needs it")
											}
											continue
										}
										const verdict = yield* attempt(seat.session, t.statements)
										yield* seat.session.resetStatements
										if (verdict.kind === "committed") {
											if (breaks.length > 0) {
												return yield* new Disagreed({
													message: `committed a state breaking ${Arr.join(breaks, ", ")}: ${Formatter.format(t.statements)}`
												})
											}
											committed(t.after)
											continue
										}
										const rule = refusedRule(verdict.fields)
										if (
											breaks.length === 0 ||
											rule === undefined ||
											!breaks.includes(rule) ||
											verdict.fields.code !== codeOf(rule) ||
											(rule === "check3" && verdict.fields.constraint !== checkName) ||
											verdict.moment.kind !== "commit"
										) {
											return yield* new Disagreed({
												message: `refused ${momentText(verdict.moment)} by ${refusalText(verdict.fields)} (rule ${rule ?? "none"}), where the state breaks ${Arr.join(breaks, ", ") || "nothing"}: ${Formatter.format(t.statements)}`
											})
										}
										c.note(`refused by ${rule}`)
										if (needed && breaks.includes("target3")) {
											c.note("a fact unwound across tables while W needs it")
										}
										if (t.withdrawn.length > 0 && breaks.includes("vLonely")) {
											c.note("a lonely row deleted and blocked at once while V needs it")
										}
									}
									const a = resolve(rc.concurrent.first, state, keys, seat.table)
									const b = resolve(rc.concurrent.second, state, keys, seat.table)
									const g = resolve(rc.concurrent.grizzle, state, keys, seat.table)
									const run = (session: typeof seat.session, statements: ReadonlyArray<string>) =>
										Effect.gen(function* () {
											for (const sql of statements) {
												const refused = yield* refusalOf(session.query(sql, []))
												if (Option.isSome(refused)) {
													return refused
												}
											}
											return Option.none()
										})
									/**
									 * Each SQL writer takes its snapshot first, so grizzle's write commits while both are open and
									 * neither sees it; a writer that meets another's row lock gives up at once, so none waits on a
									 * commit that comes after it.
									 */
									const opening = ["SET LOCAL lock_timeout = '200ms'", "SELECT 1"]
									yield* seat.session.begin
									yield* second.begin
									const snapA = yield* run(seat.session, opening)
									const snapB = yield* run(second, opening)
									const grizzle = yield* write(state, g.after).pipe(
										Effect.map((outcome) =>
											outcome.kind === "accepted" || outcome.kind === "no-change"
												? "committed"
												: "refused"
										),
										Effect.catchTag("TransientFailure", () =>
											Effect.succeed("serialization" as const)
										)
									)
									const openA = Option.isSome(snapA)
										? snapA
										: yield* run(seat.session, a.statements)
									const openB = Option.isSome(snapB) ? snapB : yield* run(second, b.statements)
									const commitA = Option.isSome(openA)
										? openA
										: yield* refusalOf(seat.session.commit)
									if (Option.isSome(openA)) {
										yield* seat.session.rollback
									}
									const commitB = Option.isSome(openB) ? openB : yield* refusalOf(second.commit)
									if (Option.isSome(openB)) {
										yield* second.rollback
									}
									yield* seat.session.resetStatements
									yield* second.resetStatements
									const now = yield* readState((sql) => seat.session.values(sql, []), seat.table)
									const after = broken(now)
									if (after.length > 0) {
										return yield* new Disagreed({
											message: `concurrent writers committed a state breaking ${Arr.join(after, ", ")}: ${Formatter.format([a.statements, b.statements, rc.concurrent.grizzle])}`
										})
									}
									const refusals = Arr.getSomes([commitA, commitB])
									c.note(
										refusals.length === 0 && grizzle === "committed"
											? "concurrent writers all committed"
											: "concurrent writer refused"
									)
									if (
										grizzle === "serialization" ||
										Arr.some(refusals, (f) => f.code === serializationFailure)
									) {
										c.note("concurrent writer refused by a serialization failure")
									}
								})
						)
					})
				)
		)
	}
)
