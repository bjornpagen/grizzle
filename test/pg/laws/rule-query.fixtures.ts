/** What the properties of rule-query.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import {
	array,
	constant,
	element,
	type Gen,
	int,
	type Weighted,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Data, Effect, Layer, Option, Order } from "effect"
import { Db } from "#adapter/public/db.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { constraintLaw } from "#compiler/ir/products.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	check,
	constraintNamesOf,
	contained,
	derived,
	key,
	mutable,
	on,
	relation,
	schema,
	select
} from "#compiler/public/schema.ts"
import type { ColumnDefinition, PlStatement } from "#compiler/sql/ast.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import { seatOfInstalled } from "#test/pg/fin/installed.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { answered } from "#test/support/calls.ts"
import { testArtifacts, testCompile } from "#test/support/compile.ts"
import type { Moment } from "#test/support/families/mutate.ts"
import { type Installed, installedTemplate } from "#test/support/install-migrate.ts"
import { servedFixture } from "#test/support/served-db.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import {
	ownerSession,
	Substrate,
	type SubstrateCase,
	worldSession
} from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

const R = relation("R", { id: pg.integer, k: pg.integer, a: pg.integer }, ["id"])

const S = relation("S", { id: pg.integer, k: pg.integer, b: pg.integer }, ["id"])

const U = relation("U", { id: pg.integer, a: pg.integer, b: pg.integer }, ["id"])

const T = relation("T", { a: pg.integer, b: pg.integer }, ["a", "b"])

const W = relation("W", { id: pg.integer, k: pg.integer, note: pg.integer }, ["id"])

const V = relation("V", { id: pg.integer }, ["id"])

const N = relation("N", { form: pg.integer, id: pg.integer }, ["form", "id"])

/**
 * The fields of `relation` a write changes in place, as the schema decides them (ir/law.ts RelationInfo `inPlace`):
 * every one outside the key of a mutable relation, and none of an immutable one here, whose immutability guard holds
 * every other field fixed against every UPDATE (physical/ddl/immutable.ts).
 */
const inPlaceFields = (relation: Rel): ReadonlyArray<string> =>
	defined(inPlaceOf.get(relation), `the relation ${relation}`)

/** The negations whose rows N marks, each under a code of its own. */
export const forms = ["unpaired", "unlisted", "quiet", "unused"] as const

type Form = (typeof forms)[number]

const formCode: Readonly<Record<Form, number>> = { unpaired: 1, unlisted: 2, quiet: 3, unused: 4 }

/**
 * The schema under `name`: R, S, U, T, W, V and N stored, W mutable, whose k and note a writer changes in place, and
 * every other immutable, whose immutability guard refuses an UPDATE that changes its row (physical/ddl/immutable.ts);
 * J2, J3, Semi, Lonely, Self, Unpaired, Unlisted and Quiet derived over them, live, and Unused over J2 on a level above,
 * with a rule over each.
 */
const ruleQuery = (name: string) => {
	const Base = schema(name, [R, S, U, T, W, V, N], [mutable(W)])
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
	/** The k of an S row whose b some U row shares: a join, as a query. */
	const paired = query(Base).rule((r) => {
		const { k, b } = v(S, "s")
		return r.match(S, { k, b }).match(U, { b }).find({ k })
	})
	/** The R rows no S row joined with a U row shares a k with: a negated join. */
	const Unpaired = derived(
		"Unpaired",
		query(Base).rule((r) => {
			const { id, k } = v(R, "r")
			return r.match(R, { id, k }).where(r.not(paired, { k })).find({ id })
		})
	)
	/** The k of an S row whose b is 1, and of a W row: a union of two rules. */
	const listed = query(Base)
		.rule((r) => {
			const { k } = v(S, "s")
			return r.match(S, { k, b: 1 }).find({ k })
		})
		.rule((r) => {
			const { k } = v(W, "w")
			return r.match(W, { k }).find({ k })
		})
	/** The R rows the union lists no k of: a negated union. */
	const Unlisted = derived(
		"Unlisted",
		query(Base).rule((r) => {
			const { id, k } = v(R, "r")
			return r.match(R, { id, k }).where(r.not(listed, { k })).find({ id })
		})
	)
	/** The R rows whose a is not 2 and whose k no W row shares: a negation inside a conjunction. */
	const Quiet = derived(
		"Quiet",
		query(Base).rule((r) => {
			const { id, k, a } = v(R, "r")
			return r
				.match(R, { id, k, a })
				.where(r.and(r.ne(a, 2), r.not(W, { k })))
				.find({ id })
		})
	)
	const marked = (form: Form) =>
		on(
			select(N, (n) => n.eq(n.form, formCode[form])),
			"id"
		)
	const First = schema.extend(
		[Base],
		`${name}_1`,
		[J2, J3, Semi, Self, Lonely, Unpaired, Unlisted, Quiet],
		[
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
			contained(on(V, "id"), on(Lonely, "id")),
			contained(on(Unpaired, "id"), marked("unpaired")),
			contained(marked("unpaired"), on(Unpaired, "id")),
			contained(on(Unlisted, "id"), marked("unlisted")),
			contained(marked("unlisted"), on(Unlisted, "id")),
			contained(on(Quiet, "id"), marked("quiet")),
			contained(marked("quiet"), on(Quiet, "id"))
		]
	)
	/** The U rows whose a no fact of J2 holds: a negated derived relation, itself a join of R and S. */
	const Unused = derived(
		"Unused",
		query(First).rule((r) => {
			const { id, a } = v(U, "u")
			return r.match(U, { id, a }).where(r.not(J2, { a })).find({ id })
		})
	)
	return schema.extend(
		[First],
		`${name}_2`,
		[Unused],
		[contained(on(Unused, "id"), marked("unused")), contained(marked("unused"), on(Unused, "id"))]
	)
}

export const RELATIONS = ["R", "S", "U", "T", "W", "V", "N"] as const

/** The rules, in the schema's statement order. */
export const rules = [
	"source2",
	"target3",
	"key2",
	"check3",
	"semi",
	"self",
	"selected",
	"lonely",
	"vLonely",
	"unpaired",
	"nUnpaired",
	"unlisted",
	"nUnlisted",
	"quiet",
	"nQuiet",
	"unused",
	"nUnused"
] as const

export type Rule = (typeof rules)[number]

/** The rule that a negation's rows are marked, and the rule that every mark is one of its rows, by negation. */
const formRules: Readonly<Record<Form, readonly [Rule, Rule]>> = {
	unpaired: ["unpaired", "nUnpaired"],
	unlisted: ["unlisted", "nUnlisted"],
	quiet: ["quiet", "nQuiet"],
	unused: ["unused", "nUnused"]
}

/** The derived relation each negation is. */
const formRelation: Readonly<Record<Form, string>> = {
	unpaired: "Unpaired",
	unlisted: "Unlisted",
	quiet: "Quiet",
	unused: "Unused"
}

/** The negation a derived relation is, if it is one. */
const formNamed = (relation: string): Form | undefined =>
	Option.getOrUndefined(Arr.findFirst(forms, (f) => formRelation[f] === relation))

/** The rule an outcome's law is, by what it states. */
export const ruleOf = (law: Law): Rule | undefined => {
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
										: markedRule(law.from.relation, law.to.relation)
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

/** A containment between a negation and its marks: out of the negation, or out of N into it. */
const markedRule = (from: string, to: string): Rule | undefined => {
	const out = formNamed(from)
	if (out !== undefined && to === "N") {
		return formRules[out][0]
	}
	const into = formNamed(to)
	return into !== undefined && from === "N" ? formRules[into][1] : undefined
}

/** The SQLSTATE a refusal of each rule raises: 23503 a containment, 23505 a key, 23514 a check. */
export const codeOf = (rule: Rule): string =>
	rule === "key2" ? "23505" : rule === "check3" ? "23514" : "23503"

/** The host model: each relation's rows by primary key. */
export interface State {
	readonly R: ReadonlyMap<number, { readonly k: number; readonly a: number }>
	readonly S: ReadonlyMap<number, { readonly k: number; readonly b: number }>
	readonly U: ReadonlyMap<number, { readonly a: number; readonly b: number }>
	readonly T: ReadonlyMap<string, readonly [number, number]>
	/** Each W row's k and its note, which no rule reads. */
	readonly W: ReadonlyMap<number, { readonly k: number; readonly note: number }>
	readonly V: ReadonlyMap<number, number>
	/** The marks, each a negation's code and a row's id, by both. */
	readonly N: ReadonlyMap<string, readonly [number, number]>
}

export const emptyState: State = {
	R: new Map(),
	S: new Map(),
	U: new Map(),
	T: new Map(),
	W: new Map(),
	V: new Map(),
	N: new Map()
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

export const j3 = (s: State): ReadonlyArray<Fact3> =>
	Arr.filter(j2(s), (f) => Arr.some([...s.U.values()], (u) => u.a === f.a && u.b === f.b))

/** Lonely's ids: the R rows no S row shares a k with. */
export const lonely = (s: State): ReadonlyArray<number> =>
	Arr.map(
		Arr.filter([...s.R.entries()], ([, r]) => !Arr.some([...s.S.values()], (x) => x.k === r.k)),
		([id]) => id
	)

/** The ids of the rows of each negation, from the rows a state holds. */
export const negated = (s: State): Readonly<Record<Form, ReadonlyArray<number>>> => {
	const ss = [...s.S.values()]
	const us = [...s.U.values()]
	const ws = [...s.W.values()]
	const two = j2(s)
	const ids = <V>(rows: ReadonlyMap<number, V>, keep: (row: V) => boolean): ReadonlyArray<number> =>
		Arr.map(
			Arr.filter([...rows.entries()], ([, row]) => keep(row)),
			([id]) => id
		)
	return {
		unpaired: ids(
			s.R,
			(r) => !Arr.some(ss, (x) => x.k === r.k && Arr.some(us, (u) => u.b === x.b))
		),
		unlisted: ids(
			s.R,
			(r) => !Arr.some(ss, (x) => x.k === r.k && x.b === 1) && !Arr.some(ws, (w) => w.k === r.k)
		),
		quiet: ids(s.R, (r) => r.a !== 2 && !Arr.some(ws, (w) => w.k === r.k)),
		unused: ids(s.U, (u) => !Arr.some(two, (f) => f.a === u.a))
	}
}

/** A mark's key in N. */
const markKey = (form: number, id: number): string => `${form},${id}`

/** The ids N marks under a negation's code. */
const marksOf = (s: State, form: Form): ReadonlyArray<number> =>
	Arr.flatMap([...s.N.values()], ([code, id]) => (code === formCode[form] ? [id] : []))

/** Every rule the state breaks, in rule order. */
export const broken = (s: State): ReadonlyArray<Rule> => {
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
	const rows = negated(s)
	const unmarked = (form: Form): boolean =>
		Arr.some(rows[form], (id) => !s.N.has(markKey(formCode[form], id)))
	const stray = (form: Form): boolean =>
		Arr.some(marksOf(s, form), (id) => !rows[form].includes(id))
	const breaks: Readonly<Record<Rule, boolean>> = {
		source2: Arr.some(two, (f) => !s.T.has(pair(f.a, f.b))),
		target3: Arr.some(ws, (w) => !Arr.some(three, (f) => f.k === w.k)),
		key2: Arr.some(two, (f) => Arr.some(two, (g) => g.k === f.k && g.a === f.a && g.b !== f.b)),
		check3: Arr.some(three, (f) => f.a === 2 && f.b === 2),
		semi: Arr.some(semiIds, (id) => !s.W.has(id)),
		self: Arr.some(selfs, (lohi) => !s.T.has(lohi)),
		selected: Arr.some(two, (f) => f.b === 1 && !Arr.some(ws, (w) => w.k === f.k)),
		lonely: Arr.some(lonelyIds, (id) => !s.V.has(id)),
		vLonely: Arr.some([...s.V.keys()], (id) => !lonelyIds.includes(id)),
		unpaired: unmarked("unpaired"),
		nUnpaired: stray("unpaired"),
		unlisted: unmarked("unlisted"),
		nUnlisted: stray("unlisted"),
		quiet: unmarked("quiet"),
		nQuiet: stray("quiet"),
		unused: unmarked("unused"),
		nUnused: stray("unused")
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
	| {
			readonly kind: "insert"
			readonly relation: Rel
			readonly x: number
			readonly y: number
			readonly marked: boolean
	  }
	| { readonly kind: "insertT"; readonly a: number; readonly b: number }
	| { readonly kind: "lone"; readonly k: number; readonly a: number; readonly marked: boolean }
	| { readonly kind: "delete"; readonly relation: Deleted; readonly pick: number }
	| { readonly kind: "deleteT"; readonly pick: number }
	| { readonly kind: "unwind"; readonly pick: number }
	| { readonly kind: "unlone"; readonly pick: number; readonly keepV: boolean }
	| { readonly kind: "sync" }
	| { readonly kind: "list"; readonly pick: number }
	| { readonly kind: "pair"; readonly pick: number }
	| { readonly kind: "unpair"; readonly pick: number }
	| { readonly kind: "mark"; readonly form: Form; readonly pick: number }
	| { readonly kind: "unmark"; readonly pick: number }
	| { readonly kind: "clusters"; readonly clusters: ReadonlyArray<Cluster> }

/**
 * A cluster of `clusters`: an R, S, U, T and W row that keep every rule together, less the row `omit` names, whose
 * absence breaks source2 where it omits T and semi where it omits W, unless another row holds what it would have.
 */
interface Cluster {
	readonly k: number
	readonly a: number
	readonly b: number
	readonly omit: "none" | "T" | "W"
}

/**
 * One write of a direct SQL writer's transaction: an edit, an UPDATE of one field of a picked row, the shift of a
 * picked J2 fact's W rows, whose b is 1, to another k a J3 fact holds, which leaves the fact's k without a W row, an
 * UPDATE of a picked W row's note, which no rule reads, a SAVEPOINT, a ROLLBACK TO the latest one, or SET CONSTRAINTS ALL
 * IMMEDIATE, after which every statement is judged at its end.
 */
export type Op =
	| Edit
	| {
			readonly kind: "update"
			readonly relation: Rel
			readonly pick: number
			readonly second: boolean
			readonly value: number
	  }
	| { readonly kind: "shift"; readonly pick: number }
	| { readonly kind: "renote"; readonly pick: number; readonly value: number }
	| { readonly kind: "savepoint" }
	| { readonly kind: "rollbackTo" }
	| { readonly kind: "immediate" }

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
			y: s.draw(int(0, 2)),
			marked: s.draw(element([false, true]))
		})
	],
	[1, (s) => ({ kind: "insertT", a: s.draw(int(0, 2)), b: s.draw(int(0, 2)) })],
	[
		2,
		(s) => ({
			kind: "lone",
			k: s.draw(int(0, 2)),
			a: s.draw(int(0, 2)),
			marked: s.draw(element([false, true]))
		})
	],
	[2, (s) => ({ kind: "delete", relation: s.draw(element(deleted)), pick: s.draw(int(0, 9)) })],
	[1, (s) => ({ kind: "deleteT", pick: s.draw(int(0, 9)) })],
	[2, (s) => ({ kind: "unwind", pick: s.draw(int(0, 9)) })],
	[3, (s) => ({ kind: "unlone", pick: s.draw(int(0, 9)), keepV: s.draw(element([false, true])) })],
	[2, () => ({ kind: "sync" })],
	[2, (s) => ({ kind: "list", pick: s.draw(int(0, 9)) })],
	[1, (s) => ({ kind: "mark", form: s.draw(element(forms)), pick: s.draw(int(0, 9)) })],
	[1, (s) => ({ kind: "unmark", pick: s.draw(int(0, 9)) })],
	[
		2,
		(s) => ({
			kind: "clusters",
			clusters: s.draw(
				array(
					(t): Cluster => ({
						k: t.draw(int(0, 3)),
						a: t.draw(int(0, 3)),
						b: t.draw(int(0, 3)),
						omit: t.draw(
							weighted<Cluster["omit"]>([
								[2, constant("none")],
								[1, constant("T")],
								[1, constant("W")]
							])
						)
					}),
					{ min: 2, max: 5 }
				)
			)
		})
	]
]

/** The writes of a direct SQL writer but its savepoints and SET CONSTRAINTS ALL IMMEDIATE. */
const writeOps: Arr.NonEmptyReadonlyArray<Weighted<Op>> = [
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
	[1, (s) => ({ kind: "shift", pick: s.draw(int(0, 9)) })],
	[1, (s) => ({ kind: "renote", pick: s.draw(int(0, 9)), value: s.draw(int(1, 3)) })]
]

const opGen: Gen<Op> = weighted<Op>(writeOps)

/** A deferred transaction's writes, savepoints and rollbacks to them among them. */
const deferredGen: Gen<ReadonlyArray<Op>> = array(
	weighted<Op>([
		...writeOps,
		[2, () => ({ kind: "savepoint" })],
		[2, () => ({ kind: "rollbackTo" })]
	]),
	{ min: 1, max: 6 }
)

/** Writes with SET CONSTRAINTS ALL IMMEDIATE among them, at a drawn place, and no savepoint. */
const immediateGen: Gen<ReadonlyArray<Op>> = (s) => {
	const ops = s.draw(array(opGen, { min: 1, max: 4 }))
	const at = s.draw(int(0, ops.length))
	return [...ops.slice(0, at), { kind: "immediate" }, ...ops.slice(at)]
}

const sqlGen: Gen<ReadonlyArray<Op>> = weighted<ReadonlyArray<Op>>([
	[3, (s) => s.draw(deferredGen)],
	[1, (s) => s.draw(immediateGen)]
])

/** The concurrent writers' statements: writes alone, judged at COMMIT. */
const concurrentGen: Gen<ReadonlyArray<Op>> = array(opGen, { min: 1, max: 4 })

const grizzleGen: Gen<ReadonlyArray<Edit>> = array(weighted(edits), { min: 1, max: 4 })

/**
 * A transaction of the serial history: direct SQL statements, one ChangeSet grizzle's served write applies, or a
 * tamper: direct SQL writes by a login over the installation that, after a judged write it committed and a
 * DISCARD TEMP, created every delta the judge names as a table of its own first, granted it to the judge's definer, and
 * empties each before COMMIT.
 */
type Transaction =
	| { readonly writer: "sql"; readonly ops: ReadonlyArray<Op> }
	| { readonly writer: "grizzle"; readonly ops: ReadonlyArray<Edit> }
	| { readonly writer: "tamper"; readonly ops: ReadonlyArray<Edit> }

const transactionGen: Gen<Transaction> = weighted<Transaction>([
	[4, (s) => ({ writer: "sql", ops: s.draw(sqlGen) })],
	[2, (s) => ({ writer: "grizzle", ops: s.draw(grizzleGen) })],
	[1, (s) => ({ writer: "tamper", ops: s.draw(grizzleGen) })]
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

/** A case of `history`, beside its drawn concurrent writers. */
const caseOf =
	(history: Gen<ReadonlyArray<Transaction>>): Gen<RuleCase> =>
	(s) => ({
		history: s.draw(history),
		concurrent: {
			first: s.draw(concurrentGen),
			second: s.draw(concurrentGen),
			grizzle: s.draw(grizzleGen)
		}
	})

export const caseGen: Gen<RuleCase> = caseOf(array(transactionGen, { min: 1, max: 6 }))

export type Feature =
	| "committed"
	| "committed a J3 fact"
	| "committed a lonely row"
	| `committed a row of ${Form}`
	| `refused by ${Rule}`
	| "a fact unwound across tables while W needs it"
	| "a lonely row deleted and blocked at once while V needs it"
	| "a marked row listed through both negations of its arm at once"
	| "a marked row paired through its negated join's second table alone"
	| "a row brought back to Unpaired by an S row and its U rows deleted at once"
	| "a grizzle write committed"
	| "a grizzle write refused by a rule"
	| "refused at a statement past SET CONSTRAINTS ALL IMMEDIATE"
	| "committed past SET CONSTRAINTS ALL IMMEDIATE"
	| "a write rolled back to a savepoint"
	| "a note no rule reads updated"
	| "an update of an immutable row refused by its guard"
	| "clusters with none omitting a row"
	| "clusters with one omitting a row"
	| "clusters with several omitting a row"
	| "a tamper refused"
	| "a tamper whose writes break a rule refused"
	| "concurrent writers all committed"
	| "concurrent writer refused"
	| "concurrent writer refused by a serialization failure"

/**
 * The histories constructed to reach the situations a drawn history reaches rarely, each its last transaction's one
 * edit, from a state that keeps every rule:
 *
 * - a marked row listed through both negations of its arm at once: a marked lonely row, then the listing of its k;
 * - a marked row paired through U alone: two clusters, at k 0 with b 0 and at k 1 with b 1, the first's U row deleted
 *   and its W row moved to k 1, which a J3 fact holds, and every mark synced, so the first R row is a marked row of
 *   Unpaired whose k an S row holds; then its pairing;
 * - a row brought back to Unpaired: one cluster, its b below 2 so its J3 fact keeps the check, then the unpairing of
 *   its k;
 * - refused by check3: one cluster whose J3 fact's a and b are both 2, which NoTwoTwo refuses, every other rule kept by
 *   the cluster's own rows: an update of R, S or U, which an immutable relation's guard refuses, no longer reaches it.
 */
const constructed: Arr.NonEmptyReadonlyArray<readonly [Feature, Gen<ReadonlyArray<Transaction>>]> =
	[
		[
			"a marked row listed through both negations of its arm at once",
			(s) => [
				{
					writer: "sql",
					ops: [{ kind: "lone", k: s.draw(int(0, 2)), a: s.draw(int(0, 2)), marked: true }]
				},
				{ writer: s.draw(element(["sql", "grizzle"] as const)), ops: [{ kind: "list", pick: 0 }] }
			]
		],
		[
			"a marked row paired through its negated join's second table alone",
			(s) => [
				{
					writer: "sql",
					ops: [
						{ kind: "cluster", k: 0, a: s.draw(int(0, 2)), b: 0 },
						{ kind: "cluster", k: 1, a: s.draw(int(0, 2)), b: 1 },
						{ kind: "delete", relation: "U", pick: 0 },
						{ kind: "update", relation: "W", pick: 0, second: false, value: 1 },
						{ kind: "sync" }
					]
				},
				{ writer: s.draw(element(["sql", "grizzle"] as const)), ops: [{ kind: "pair", pick: 0 }] }
			]
		],
		[
			"a row brought back to Unpaired by an S row and its U rows deleted at once",
			(s) => [
				{
					writer: "sql",
					ops: [
						{ kind: "cluster", k: s.draw(int(0, 1)), a: s.draw(int(0, 2)), b: s.draw(int(0, 1)) }
					]
				},
				{ writer: s.draw(element(["sql", "grizzle"] as const)), ops: [{ kind: "unpair", pick: 0 }] }
			]
		],
		[
			"refused by check3",
			(s) => [
				{
					writer: s.draw(element(["sql", "grizzle"] as const)),
					ops: [{ kind: "cluster", k: s.draw(int(0, 1)), a: 2, b: 2 }]
				}
			]
		]
	]

/**
 * Each situation a history is constructed to reach, with the case a witness whose turn aims at it draws (aimed): that
 * history, beside drawn concurrent writers.
 */
export const aims: ReadonlyArray<readonly [Feature, Gen<RuleCase>]> = Arr.map(
	constructed,
	([feature, history]) => [feature, caseOf(history)] as const
)

export class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

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
 * A transaction resolved against a state: its statements, the state it leaves, the k of each J3 fact it unwinds, the
 * id of each lonely row it deletes beside an S row of its k it inserts, keeping its V row, the id of each marked row
 * of Unlisted whose k it lists through both negated arms of Unlisted's one arm at once, keeping its mark, the id of
 * each marked row of Unpaired a U row it inserts pairs through an S row already standing, keeping its mark, and the id
 * of each row it brings back to Unpaired by deleting the one S row of its k and the U rows that pair it at once,
 * leaving it unmarked. Past a SET CONSTRAINTS ALL IMMEDIATE, each statement from it on is judged at its end:
 * `immediate` holds, for each, its index and the rules the state it leaves breaks. Beside them, what the transaction
 * did that the search requires: the rows it rolled back to a savepoint, the notes it changed, and the clusters it
 * inserted with the rules each breaks alone.
 */
export interface Resolved {
	readonly statements: ReadonlyArray<string>
	readonly after: State
	readonly unwound: ReadonlyArray<number>
	readonly withdrawn: ReadonlyArray<number>
	readonly listed: ReadonlyArray<number>
	readonly paired: ReadonlyArray<number>
	readonly unpaired: ReadonlyArray<number>
	readonly immediate: ReadonlyArray<{
		readonly index: number
		readonly breaks: ReadonlyArray<Rule>
	}>
	readonly rolledBack: boolean
	readonly renoted: boolean
	/** The index of its first UPDATE its relation's immutability guard refuses (`updated`), none where it holds none. */
	readonly guarded: Option.Option<number>
	readonly clusters: ReadonlyArray<ReadonlyArray<Cluster>>
}

/** Fresh primary keys, one counter per relation, shared by every session of a case. */
export class Keys {
	#next = 1
	fresh(): number {
		return this.#next++
	}
}

/**
 * The verdict a direct SQL transaction must have: committed where no statement judged at its end and not the state it
 * leaves breaks a rule; else refused at its first refused statement, an UPDATE its relation's immutability guard
 * refuses (`guarded`, 42501, whatever any rule finds) or one past SET CONSTRAINTS ALL IMMEDIATE that leaves a broken
 * state, by a rule that state breaks, or at COMMIT, by a rule the state it leaves breaks.
 */
type Expected =
	| { readonly kind: "committed" }
	| {
			readonly kind: "refused"
			readonly moment: Moment
			readonly breaks: Arr.NonEmptyReadonlyArray<Rule>
	  }
	| { readonly kind: "guarded"; readonly index: number }

export const expectedOf = (t: Resolved): Expected => {
	const guarded = Option.getOrElse(t.guarded, () => t.statements.length)
	for (const check of t.immediate) {
		if (check.index >= guarded) {
			break
		}
		if (Arr.isReadonlyArrayNonEmpty(check.breaks)) {
			return {
				kind: "refused",
				moment: { kind: "statement", index: check.index },
				breaks: check.breaks
			}
		}
	}
	if (Option.isSome(t.guarded)) {
		return { kind: "guarded", index: t.guarded.value }
	}
	const breaks = broken(t.after)
	return Arr.isReadonlyArrayNonEmpty(breaks)
		? { kind: "refused", moment: { kind: "commit" }, breaks }
		: { kind: "committed" }
}

export const resolve = (
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
	const Nr = new Map(before.N)
	const statements: Array<string> = []
	const unwound: Array<number> = []
	const withdrawn: Array<number> = []
	const listed: Array<number> = []
	const paired: Array<number> = []
	const unpaired: Array<number> = []
	const immediate: Array<{ readonly index: number; readonly breaks: ReadonlyArray<Rule> }> = []
	const clusters: Array<ReadonlyArray<Cluster>> = []
	const savepoints: Array<State> = []
	let rolledBack = false
	let renoted = false
	const now = (): State => ({ R, S, U, T: Tr, W: Wr, V: Vr, N: Nr })
	/** Appends a statement, judged at its end once the transaction is past SET CONSTRAINTS ALL IMMEDIATE. */
	const emit = (sql: string): void => {
		statements.push(sql)
		if (immediate.length > 0 || sql === immediateSql) {
			immediate.push({ index: statements.length - 1, breaks: broken(now()) })
		}
	}
	let guarded: Option.Option<number> = Option.none()
	/**
	 * An UPDATE of `relation`'s `field` from `from` to `to`, emitted: refused by the relation's immutability guard where
	 * it changes a field the relation's rows hold fixed, any field outside the ones the schema changes in place
	 * (`inPlaceFields`), the first such statement recorded.
	 */
	const updated = (relation: Rel, field: string, from: number, to: number, sql: string): void => {
		if (Option.isNone(guarded) && from !== to && !inPlaceFields(relation).includes(field)) {
			guarded = Option.some(statements.length)
		}
		emit(sql)
	}
	/** Every relation as `state` holds it. */
	const restore = (state: State): void => {
		const refill = <K, V>(into: Map<K, V>, from: ReadonlyMap<K, V>): void => {
			into.clear()
			for (const [k, v] of from) {
				into.set(k, v)
			}
		}
		refill(R, state.R)
		refill(S, state.S)
		refill(U, state.U)
		refill(Tr, state.T)
		refill(Wr, state.W)
		refill(Vr, state.V)
		refill(Nr, state.N)
	}
	const insertRow = (relation: Rel, id: number, x: number, y: number): void => {
		switch (relation) {
			case "R":
				R.set(id, { k: x, a: y })
				emit(`INSERT INTO ${table("R")} (id, k, a) VALUES (${id}, ${x}, ${y})`)
				return
			case "S":
				S.set(id, { k: x, b: y })
				emit(`INSERT INTO ${table("S")} (id, k, b) VALUES (${id}, ${x}, ${y})`)
				return
			case "U":
				U.set(id, { a: x, b: y })
				emit(`INSERT INTO ${table("U")} (id, a, b) VALUES (${id}, ${x}, ${y})`)
				return
			case "W":
				Wr.set(id, { k: x, note: 0 })
				emit(`INSERT INTO ${table("W")} (id, k, note) VALUES (${id}, ${x}, 0)`)
				return
		}
	}
	const insertT = (a: number, b: number): void => {
		Tr.set(pair(a, b), [a, b])
		emit(`INSERT INTO ${table("T")} (a, b) VALUES (${a}, ${b}) ON CONFLICT DO NOTHING`)
	}
	const mark = (form: number, id: number): void => {
		Nr.set(markKey(form, id), [form, id])
		emit(`INSERT INTO ${table("N")} (form, id) VALUES (${form}, ${id}) ON CONFLICT DO NOTHING`)
	}
	const unmark = (form: number, id: number): void => {
		Nr.delete(markKey(form, id))
		emit(`DELETE FROM ${table("N")} WHERE form = ${form} AND id = ${id}`)
	}
	/** Marks the rows of each of `marked`'s negations as they stand, and unmarks every other mark of theirs. */
	const marking = (marked: ReadonlyArray<Form>): void => {
		const rows = negated({ R, S, U, T: Tr, W: Wr, V: Vr, N: Nr })
		for (const form of marked) {
			const code = formCode[form]
			for (const [at, id] of Nr.values()) {
				if (at === code && !rows[form].includes(id)) {
					unmark(code, id)
				}
			}
			for (const id of rows[form]) {
				if (!Nr.has(markKey(code, id))) {
					mark(code, id)
				}
			}
		}
	}
	/**
	 * Runs `write`, then moves the marks it moves: marks each row a negation gains by it, unmarks each marked row a
	 * negation loses by it, and leaves every other mark as it stands.
	 */
	const moving = (write: () => void): void => {
		const was = negated({ R, S, U, T: Tr, W: Wr, V: Vr, N: Nr })
		write()
		const is = negated({ R, S, U, T: Tr, W: Wr, V: Vr, N: Nr })
		for (const form of forms) {
			const code = formCode[form]
			for (const id of was[form]) {
				if (!is[form].includes(id) && Nr.has(markKey(code, id))) {
					unmark(code, id)
				}
			}
			for (const id of is[form]) {
				if (!was[form].includes(id) && !Nr.has(markKey(code, id))) {
					mark(code, id)
				}
			}
		}
	}
	/** Runs `write`, moving the marks it moves (`moving`) exactly when `marked`. */
	const writing = (marked: boolean, write: () => void): void => (marked ? moving(write) : write())
	const rowsOf = (relation: Deleted): Map<number, unknown> =>
		relation === "R" ? R : relation === "S" ? S : relation === "U" ? U : relation === "W" ? Wr : Vr
	const deleteRow = (relation: Deleted, id: number): void => {
		rowsOf(relation).delete(id)
		emit(`DELETE FROM ${table(relation)} WHERE id = ${id}`)
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
			case "insert": {
				const id = keys.fresh()
				writing(op.marked, () => insertRow(op.relation, id, op.x, op.y))
				break
			}
			case "insertT":
				insertT(op.a, op.b)
				break
			case "lone": {
				const id = keys.fresh()
				writing(op.marked, () => {
					insertRow("R", id, op.k, op.a)
					Vr.set(id, id)
					emit(`INSERT INTO ${table("V")} (id) VALUES (${id})`)
				})
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
					emit(`DELETE FROM ${table("T")} WHERE a = ${a} AND b = ${b}`)
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
						updated(
							"R",
							op.second ? "a" : "k",
							op.second ? r.a : r.k,
							v,
							`UPDATE ${table("R")} SET ${op.second ? "a" : "k"} = ${v} WHERE id = ${at}`
						)
						break
					}
					case "S": {
						const r = defined(S.get(at), "a picked row")
						S.set(at, op.second ? { ...r, b: v } : { ...r, k: v })
						updated(
							"S",
							op.second ? "b" : "k",
							op.second ? r.b : r.k,
							v,
							`UPDATE ${table("S")} SET ${op.second ? "b" : "k"} = ${v} WHERE id = ${at}`
						)
						break
					}
					case "U": {
						const r = defined(U.get(at), "a picked row")
						U.set(at, op.second ? { ...r, b: v } : { ...r, a: v })
						updated(
							"U",
							op.second ? "b" : "a",
							op.second ? r.b : r.a,
							v,
							`UPDATE ${table("U")} SET ${op.second ? "b" : "a"} = ${v} WHERE id = ${at}`
						)
						break
					}
					case "W": {
						const w = defined(Wr.get(at), "a picked row")
						Wr.set(at, { ...w, k: v })
						updated("W", "k", w.k, v, `UPDATE ${table("W")} SET k = ${v} WHERE id = ${at}`)
						break
					}
				}
				break
			}
			case "shift": {
				const now = { R, S, U, T: Tr, W: Wr, V: Vr, N: Nr }
				const ones = Arr.filter(j2(now), (f) => f.b === 1)
				const fact = ones.length === 0 ? undefined : ones[op.pick % ones.length]
				const to = fact === undefined ? undefined : Arr.findFirst(j3(now), (f) => f.k !== fact.k)
				if (fact === undefined || to === undefined || Option.isNone(to)) {
					break
				}
				for (const [id, w] of Wr) {
					if (w.k === fact.k) {
						Wr.set(id, { ...w, k: to.value.k })
						updated(
							"W",
							"k",
							w.k,
							to.value.k,
							`UPDATE ${table("W")} SET k = ${to.value.k} WHERE id = ${id}`
						)
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
				moving(() => {
					deleteRow("R", id)
					insertRow("S", keys.fresh(), r.k, 0)
				})
				if (Vr.has(id)) {
					if (op.keepV) {
						withdrawn.push(id)
					} else {
						deleteRow("V", id)
					}
				}
				break
			}
			case "sync":
				marking(forms)
				break
			case "list": {
				const found = picked(
					new Map(
						Arr.filter(
							[...R],
							([id, r]) =>
								Nr.has(markKey(formCode.unlisted, id)) &&
								!Arr.some([...S.values()], (x) => x.k === r.k)
						)
					),
					op.pick
				)
				if (Option.isNone(found)) {
					break
				}
				const [id, r] = found.value
				insertRow("S", keys.fresh(), r.k, 1)
				insertRow("U", keys.fresh(), r.a, 1)
				for (const [other, o] of R) {
					if (o.k !== r.k) {
						continue
					}
					insertT(o.a, 1)
					if (!Wr.has(other)) {
						insertRow("W", other, r.k, 0)
					}
					if (Vr.has(other)) {
						deleteRow("V", other)
					}
				}
				marking(Arr.filter(forms, (f) => f !== "unlisted"))
				listed.push(id)
				break
			}
			case "pair": {
				const rows = negated({ R, S, U, T: Tr, W: Wr, V: Vr, N: Nr }).unpaired
				const found = picked(
					new Map(
						Arr.flatMap([...R], ([id, r]) =>
							rows.includes(id) && Nr.has(markKey(formCode.unpaired, id))
								? Arr.map(
										Arr.take(
											Arr.filter([...S.values()], (x) => x.k === r.k && (r.a !== 2 || x.b !== 2)),
											1
										),
										(x) => [id, { a: r.a, b: x.b }] as const
									)
								: []
						)
					),
					op.pick
				)
				if (Option.isNone(found)) {
					break
				}
				const [id, u] = found.value
				insertRow("U", keys.fresh(), u.a, u.b)
				paired.push(id)
				break
			}
			case "unpair": {
				const found = picked(
					new Map(
						Arr.filter(
							[...S],
							([, x]) =>
								!Arr.some([...S.values()], (y) => y !== x && (y.k === x.k || y.b === x.b)) &&
								Arr.some([...U.values()], (u) => u.b === x.b) &&
								Arr.some([...R.values()], (r) => r.k === x.k) &&
								!Arr.some([...R], ([id, r]) => r.k !== x.k && Wr.get(id)?.k === x.k)
						)
					),
					op.pick
				)
				if (Option.isNone(found)) {
					break
				}
				const [at, x] = found.value
				deleteRow("S", at)
				for (const [id, u] of U) {
					if (u.b === x.b) {
						deleteRow("U", id)
					}
				}
				for (const [id, w] of Wr) {
					if (w.k === x.k) {
						deleteRow("W", id)
					}
				}
				for (const [id, r] of R) {
					if (r.k !== x.k) {
						continue
					}
					Vr.set(id, id)
					statements.push(`INSERT INTO ${table("V")} (id) VALUES (${id})`)
					unpaired.push(id)
				}
				marking(Arr.filter(forms, (f) => f !== "unpaired"))
				break
			}
			case "mark": {
				const found =
					op.form === "unused"
						? Option.map(picked(U, op.pick), ([id]) => id)
						: Option.map(picked(R, op.pick), ([id]) => id)
				if (Option.isSome(found)) {
					mark(formCode[op.form], found.value)
				}
				break
			}
			case "unmark": {
				const all = Arr.sort([...Nr.keys()], Order.String)
				const at = all.length === 0 ? undefined : all[op.pick % all.length]
				const row = at === undefined ? undefined : Nr.get(at)
				if (row !== undefined) {
					unmark(row[0], row[1])
				}
				break
			}
			case "clusters": {
				for (const c of op.clusters) {
					const id = keys.fresh()
					insertRow("R", id, c.k, c.a)
					insertRow("S", keys.fresh(), c.k, c.b)
					insertRow("U", keys.fresh(), c.a, c.b)
					if (c.omit !== "T") {
						insertT(c.a, c.b)
					}
					if (c.omit !== "W") {
						insertRow("W", id, c.k, 0)
					}
				}
				clusters.push(op.clusters)
				break
			}
			case "renote": {
				const found = picked(Wr, op.pick)
				if (Option.isSome(found)) {
					const [id, w] = found.value
					renoted = renoted || w.note !== op.value
					Wr.set(id, { ...w, note: op.value })
					updated(
						"W",
						"note",
						w.note,
						op.value,
						`UPDATE ${table("W")} SET note = ${op.value} WHERE id = ${id}`
					)
				}
				break
			}
			case "savepoint":
				savepoints.push({
					R: new Map(R),
					S: new Map(S),
					U: new Map(U),
					T: new Map(Tr),
					W: new Map(Wr),
					V: new Map(Vr),
					N: new Map(Nr)
				})
				emit(`SAVEPOINT s${savepoints.length}`)
				break
			case "rollbackTo": {
				const last = savepoints.at(-1)
				if (last !== undefined) {
					rolledBack = rolledBack || !unchanged(last, now())
					restore(last)
					emit(`ROLLBACK TO SAVEPOINT s${savepoints.length}`)
				}
				break
			}
			case "immediate":
				emit(immediateSql)
				break
			case "unwind": {
				const facts = j3({ R, S, U, T: Tr, W: Wr, V: Vr, N: Nr })
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
	return {
		statements,
		after: now(),
		unwound,
		withdrawn,
		listed,
		paired,
		unpaired,
		immediate,
		rolledBack,
		renoted,
		guarded,
		clusters
	}
}

/** The rows a table holds now, read back as integers. */
export const readState = <E>(
	values: (sql: string) => Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, E>,
	table: (relation: string) => string
): Effect.Effect<State, E> =>
	Effect.gen(function* () {
		const n = (x: unknown): number => Number(x)
		const r = yield* values(`SELECT id, k, a FROM ${table("R")}`)
		const s = yield* values(`SELECT id, k, b FROM ${table("S")}`)
		const u = yield* values(`SELECT id, a, b FROM ${table("U")}`)
		const t = yield* values(`SELECT a, b FROM ${table("T")}`)
		const w = yield* values(`SELECT id, k, note FROM ${table("W")}`)
		const vs = yield* values(`SELECT id FROM ${table("V")}`)
		const ns = yield* values(`SELECT form, id FROM ${table("N")}`)
		return {
			R: new Map(Arr.map(r, (x) => [n(x[0]), { k: n(x[1]), a: n(x[2]) }] as const)),
			S: new Map(Arr.map(s, (x) => [n(x[0]), { k: n(x[1]), b: n(x[2]) }] as const)),
			U: new Map(Arr.map(u, (x) => [n(x[0]), { a: n(x[1]), b: n(x[2]) }] as const)),
			T: new Map(Arr.map(t, (x) => [pair(n(x[0]), n(x[1])), [n(x[0]), n(x[1])] as const] as const)),
			W: new Map(Arr.map(w, (x) => [n(x[0]), { k: n(x[1]), note: n(x[2]) }] as const)),
			V: new Map(Arr.map(vs, (x) => [n(x[0]), n(x[0])] as const)),
			N: new Map(
				Arr.map(ns, (x) => [markKey(n(x[0]), n(x[1])), [n(x[0]), n(x[1])] as const] as const)
			)
		}
	})

/** The rows `after` holds at a key `before` does not. */
const added = <K, A>(
	before: ReadonlyMap<K, A>,
	after: ReadonlyMap<K, A>
): ReadonlyArray<readonly [K, A]> => Arr.filter([...after.entries()], ([key]) => !before.has(key))

/**
 * The facts of the ChangeSet that takes `before` to `after`, as a grizzle transaction's edits reach it: each row of
 * `after` at a key `before` lacks inserted, each row of `before` at a key `after` lacks deleted. An edit inserts at a
 * fresh key and changes no row, so no key holds a row on both sides that differs.
 */
const factsOf = (before: State, after: State) => {
	const edits = (from: State, to: State) => ({
		R: Arr.map(added(from.R, to.R), ([id, r]) => ({ id, k: r.k, a: r.a })),
		S: Arr.map(added(from.S, to.S), ([id, x]) => ({ id, k: x.k, b: x.b })),
		U: Arr.map(added(from.U, to.U), ([id, u]) => ({ id, a: u.a, b: u.b })),
		T: Arr.map(added(from.T, to.T), ([, [a, b]]) => ({ a, b })),
		W: Arr.map(added(from.W, to.W), ([id, w]) => ({ id, k: w.k, note: w.note })),
		V: Arr.map(added(from.V, to.V), ([id]) => ({ id })),
		N: Arr.map(added(from.N, to.N), ([, [form, id]]) => ({ form, id }))
	})
	return { insert: edits(before, after), delete: edits(after, before) }
}

/** The full role's workload: the ChangeSet that inserts and deletes rows of every stored relation, from its call's facts. */
const programsOf = (value: ReturnType<typeof ruleQuery>) => ({
	write: ChangeSet.empty(value)
		.insert(R, [])
		.insert(S, [])
		.insert(U, [])
		.insert(T, [])
		.insert(W, [])
		.insert(V, [])
		.insert(N, [])
		.delete(R, [])
		.delete(S, [])
		.delete(U, [])
		.delete(T, [])
		.delete(W, [])
		.delete(V, [])
		.delete(N, [])
})

/** Whether two versions of a relation hold the same keys. */
const sameKeys = <K, A>(before: ReadonlyMap<K, A>, after: ReadonlyMap<K, A>): boolean =>
	added(before, after).length === 0 && added(after, before).length === 0

/** Whether `before` and `after` hold the same keys of every relation. */
export const unchanged = (before: State, after: State): boolean =>
	sameKeys(before.R, after.R) &&
	sameKeys(before.S, after.S) &&
	sameKeys(before.U, after.U) &&
	sameKeys(before.T, after.T) &&
	sameKeys(before.W, after.W) &&
	sameKeys(before.V, after.V) &&
	sameKeys(before.N, after.N)

/**
 * The situations a transaction of one constructed edit reaches, each where the state it leaves breaks one rule alone:
 * a marked row of Unpaired paired by a U row inserted alone through an S row already standing, its stale mark broken,
 * which only a probe of U, the second table of Unpaired's negated join, reads; and rows brought back to Unpaired by the
 * one S row of their k and the U rows that pair it deleted at once, unmarked, which only a probe that drops the
 * negated arm's other match reads, since each deleted row's other is gone at COMMIT.
 */
export const alone = (
	ops: ReadonlyArray<Op>,
	t: Resolved,
	breaks: ReadonlyArray<Rule>
): ReadonlyArray<Feature> => {
	const [only, ...more] = breaks
	if (ops.length !== 1 || only === undefined || more.length > 0) {
		return []
	}
	return [
		...(only === "nUnpaired" && t.paired.length > 0
			? ["a marked row paired through its negated join's second table alone" as const]
			: []),
		...(only === "unpaired" && t.unpaired.length > 0
			? ["a row brought back to Unpaired by an S row and its U rows deleted at once" as const]
			: [])
	]
}

/** The statement after which every check is judged at the end of each statement. */
const immediateSql = "SET CONSTRAINTS ALL IMMEDIATE"

/** A serialization failure's SQLSTATE. */
export const serializationFailure = "40001"

/** A tamper's refusal: the judge's capture refuses a delta its definer does not own (physical/ddl/rules.ts foreign). */
export const insufficientPrivilege = "42501"

/** Every PL/pgSQL statement of `body`, at any depth. */
const plStatementsOf = (body: ReadonlyArray<PlStatement>): ReadonlyArray<PlStatement> =>
	Arr.flatMap(body, (st): ReadonlyArray<PlStatement> => {
		switch (st.kind) {
			case "if":
				return [
					st,
					...Arr.flatMap(st.branches, (b) => plStatementsOf(b.body)),
					...plStatementsOf(st.else)
				]
			case "forQuery":
				return [st, ...plStatementsOf(st.body)]
			case "whenFound":
				return [st, ...plStatementsOf(st.body)]
			case "case":
				return [st, ...Arr.flatMap(st.whens, (w) => plStatementsOf(w.body))]
			case "assign":
			case "perform":
			case "lockRows":
			case "modify":
			case "returnQuery":
			case "createSessionTable":
			case "truncateSessionTable":
			case "createSessionTrigger":
			case "raise":
			case "return":
				return [st]
		}
	})

/**
 * The session deltas an installation's rule captures create, each once: the tables of pg_temp of a column or more that
 * its functions' CREATE TEMPORARY TABLE statements name (the sentinel has none). None for the per-row installation.
 */
const sessionDeltas = (
	installed: Installed
): ReadonlyArray<{ readonly name: string; readonly columns: ReadonlyArray<ColumnDefinition> }> =>
	Arr.dedupeWith(
		Arr.flatMap(installed.installation.statements, (st) =>
			st.kind === "createFunction" && st.language === "plpgsql"
				? Arr.flatMap(plStatementsOf(st.body.body), (pl) =>
						pl.kind === "createSessionTable" && pl.columns.length > 0
							? [{ name: pl.name, columns: pl.columns }]
							: []
					)
				: []
		),
		(a, b) => a.name === b.name
	)

/** The schema rule-query's cases run on, as declared. */
const declared = ruleQuery("RuleQuery")

/** Each stored relation's fields a write changes in place, as the declared schema decides them (`inPlaceFields`). */
const inPlaceOf: ReadonlyMap<string, ReadonlyArray<string>> = new Map(
	Arr.map(
		[
			...succeeded(testArtifacts(declared, testCompile), "rule-query's schema compiles").derived
				.schema.relations
		],
		([name, info]) => [name, info.inPlace] as const
	)
)

/** The schema installed through its first migration once per member (install-migrate.ts installedTemplate). */
export const judgedTemplate = installedTemplate({
	declaredIn: import.meta,
	name: "rule query",
	schema: declared,
	options: {
		ambient: ordinarySession,
		label: "rule_query",
		logins: [fullWorld(declared, {}).server],
		extensions: []
	}
})

/**
 * A case's clone of the template (judgedTemplate), with everything a case runs on it: its seat, whose owner session
 * writes direct SQL; a second owner session; a session of the full world's login as its role, which writes the
 * tampers; its served write; the rule a refusal names through the installation's own constraint map; the name the
 * check over J3 reports; the deltas the judge's captures create; and the judge by its signature.
 */
export const judgedIn = (taken: SubstrateCase<Installed>, label: string) =>
	Effect.gen(function* () {
		const done = taken.value
		const value = ruleQuery(done.schema)
		const checkName = constraintNamesOf(value)({
			kind: "check",
			relation: "J3",
			name: "NoTwoTwo"
		})
		const world = fullWorld(value, programsOf(value))
		const seat = yield* seatOfInstalled(done, RELATIONS, label)
		const served = yield* servedFixture(done, world.server)
		const context = yield* Layer.build(served.layer)
		const db = yield* Db.open(served.login.roles.app, {}).pipe(Effect.provideContext(context))
		const substrate = yield* Substrate
		const second = yield* substrate.session({ ...ownerSession(), label: `${label}_second` })
		const writer = yield* substrate.session({
			...worldSession(done.world(world.app)),
			label: `${label}_writer`
		})
		const installation = seat.installed.installation
		const tableRelation = (ident: string): string | undefined =>
			Option.getOrUndefined(
				Arr.findFirst(RELATIONS, (r) => installation.names.relation(r).name === ident)
			)
		/** The rule a refusal's raise reports, through the installation's constraint map. */
		const refusedRule = (fields: {
			readonly table: Option.Option<string>
			readonly constraint: string | undefined
		}): Rule | undefined => {
			const relation = Option.isNone(fields.table) ? undefined : tableRelation(fields.table.value)
			if (relation === undefined || fields.constraint === undefined) {
				return undefined
			}
			const law = constraintLaw(
				installation.constraintToLaw,
				{ kind: "table", name: installation.names.relation(relation).name },
				fields.constraint
			)
			const described = law === undefined ? undefined : installation.described.get(law)
			return described === undefined ? undefined : ruleOf(described)
		}
		/** The ChangeSet taking `before` to `after`, applied by its served member as the application's login. */
		const write = (before: State, after: State) =>
			answered(db.workload.write.once({ params: {}, facts: factsOf(before, after) }))
		return {
			seat,
			second,
			writer,
			write,
			refusedRule,
			checkName,
			deltas: sessionDeltas(done),
			judge: `${quoteIdent(installation.names.schema)}.${quoteIdent(identifierOf(identity.ruleJudge()))}()`
		}
	}).pipe(Effect.provideService(Substrate, taken.substrate))

/**
 * The tables of a session's own temporary schema that hold a row: none at a transaction's end, where every delta and
 * the sentinel are ON COMMIT DELETE ROWS and a rollback takes back what the transaction wrote.
 */
export const heldSessionRows = (session: RawSession) =>
	Effect.gen(function* () {
		const names = yield* session.values(
			"SELECT c.relname FROM pg_catalog.pg_class AS c WHERE c.relnamespace = pg_catalog.pg_my_temp_schema() AND c.relkind = 'r'",
			[]
		)
		const held: Array<string> = []
		for (const [name] of names) {
			const counted = yield* session.values(
				`SELECT count(*) FROM pg_temp.${quoteIdent(String(name))}`,
				[]
			)
			if (Arr.some(counted, (row) => Number(row[0]) > 0)) {
				held.push(String(name))
			}
		}
		return held
	})
