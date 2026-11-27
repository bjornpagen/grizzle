/** What the property of rule-cover.test.ts reads: the schema and its template, the space, and each case's run. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { aimed, array, boolean, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Formatter, Option, String as Str } from "effect"
import { clockOrders, probeRows, proofsOf } from "#compiler/analysis/theory/query.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { baselineRuleChecks } from "#compiler/deploy/snapshot/violation.ts"
import { lawsOfConstraint } from "#compiler/ir/products.ts"
import { countColumn } from "#compiler/physical/ddl/deltas.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	check,
	contained,
	derived,
	mutable,
	on,
	relation,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import {
	capturedDeltasOf,
	judgedDeltaReadsOf,
	raisedRule,
	standUpJudge
} from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { refusalOf } from "#test/support/substrate.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/**
 * A learner's rows beside what they may be judged against, keyed by one integer each, each relation mutable: R and X
 * in a unit of their own, keyed by c, every other relation in the unit of k or of a group, so every rule over them
 * reads the rows of two units, two borrows, and is probed (analysis/theory/query.ts probe), never judged whole over
 * units:
 *
 * - R, the covered relation, keyed by c, beside a cap; S, keyed by k, in a group with a score; S(k) ⊆ R(c), as the
 *   ledger's HumanOperatorValue is contained in Attempt at its attempt's key;
 * - T(k) ⊆ S(k), so T(k) ⊆ R(c) by composition alone (analysis/theory/unit.ts regionFactsOf);
 * - U(k) ⊆ V(k) and V(k) ⊆ U(k), a cycle;
 * - Lim, a group's maximum; X, a value at c; A and B, keys a definition reads; W, a key's dependence on another key x.
 *
 * Each containment's target holds a field it does not reference, so each is a foreign key checked at COMMIT, which a
 * transaction may break and repair before it ends. R is mutable, so S, which pins R's key, covers no read of R's cap: a
 * row R gains at a key may replace the one that stood there.
 */
const R = relation("R", { c: pg.integer, cap: pg.integer }, ["c"])
const S = relation("S", { k: pg.integer, grp: pg.integer, score: pg.integer }, ["k"])
const T = relation("T", { k: pg.integer, tag: pg.integer }, ["k"])
const U = relation("U", { k: pg.integer, score: pg.integer }, ["k"])
const V = relation("V", { k: pg.integer, flag: pg.integer }, ["k"])
const Lim = relation("Lim", { grp: pg.integer, max: pg.integer }, ["grp"])
const X = relation("X", { c: pg.integer, v: pg.integer }, ["c"])
const A = relation("A", { k: pg.integer }, ["k"])
const B = relation("B", { k: pg.integer }, ["k"])
const W = relation("W", { k: pg.integer, x: pg.integer }, ["k", "x"])

const opened = [R, S, T, U, V, Lim, X, A, B, W] as const

/**
 * A sitting's rows, each closed, its facts inserted and never changed or deleted, as qti-pie's ledger's sittings are:
 * a test's deadline (Test), keyed by the test apart from every sitting's rows, so each rule over them reads two units'
 * rows and is probed; a sitting of a test (Session); its candidate sessions, each with the instant it began (Visit); a
 * candidate session's pause (Pause); a presentation in one at an instant (Mark); an item session of the sitting, in a
 * candidate session (Item), and a response to it at an instant (Snap); and a sitting's seat limit, which no containment
 * relates to its sitting (Seat), as no declared containment holds qti's TestSession within its SittingTest. Each child
 * is contained in its parent at the parent's key, a foreign key checked at COMMIT, its parent holding a field it does
 * not reference: Session ⊆ Test at test, Visit ⊆ Session and Item ⊆ Session at s, Pause ⊆ Visit and Mark ⊆ Visit at
 * (s, k), Snap ⊆ Item at (s, n).
 */
const Test = relation("Test", { test: pg.integer, cap: pg.integer }, ["test"])
const Session = relation("Session", { s: pg.integer, test: pg.integer }, ["s"])
const Visit = relation("Visit", { s: pg.integer, k: pg.integer, at: pg.integer }, ["s", "k"])
const Pause = relation("Pause", { s: pg.integer, k: pg.integer }, ["s", "k"])
const Mark = relation("Mark", { s: pg.integer, k: pg.integer, at: pg.integer }, ["s", "k", "at"])
const Item = relation("Item", { s: pg.integer, n: pg.integer, k: pg.integer }, ["s", "n"])
const Snap = relation("Snap", { s: pg.integer, n: pg.integer, at: pg.integer }, ["s", "n", "at"])
const Seat = relation("Seat", { s: pg.integer, lim: pg.integer }, ["s"])

/**
 * R's and S's closed counterparts: Kin, keyed by c beside a cap, and Kid, keyed by k in a group, Kid(k) ⊆ Kin(c), so
 * a row Kin gains is one of a new key, and Kid, pinning Kin's key, covers a read of Kin's cap.
 */
const Kin = relation("Kin", { c: pg.integer, cap: pg.integer }, ["c"])
const Kid = relation("Kid", { k: pg.integer, grp: pg.integer }, ["k"])

const closedRelations = [Test, Session, Visit, Pause, Mark, Item, Snap, Seat, Kin, Kid] as const

const stored = [...opened, ...closedRelations] as const

const Base = schema("Cover", stored, [
	...Arr.map(opened, (t) => mutable(t)),
	contained(on(S, "k"), on(R, "c")),
	contained(on(T, "k"), on(S, "k")),
	contained(on(U, "k"), on(V, "k")),
	contained(on(V, "k"), on(U, "k")),
	contained(on(Session, "test"), on(Test, "test")),
	contained(on(Visit, "s"), on(Session, "s")),
	contained(on(Pause, "s", "k"), on(Visit, "s", "k")),
	contained(on(Mark, "s", "k"), on(Visit, "s", "k")),
	contained(on(Item, "s"), on(Session, "s")),
	contained(on(Snap, "s", "n"), on(Item, "s", "n")),
	contained(on(Kid, "k"), on(Kin, "c")),
	unit("Keyed", { k: pg.integer }),
	unit("Group", { grp: pg.integer }),
	unit("Covered", { c: pg.integer })
])

/** S's score beside its group's maximum, at each k R holds: R read at its key alone, which S's row pins. */
const Direct = derived(
	"Direct",
	query(Base).rule((r) => {
		const { k, grp, score } = v(S, "s")
		const { max } = v(Lim, "lim")
		return r
			.match(S, { k, grp, score })
			.match(R, { c: k })
			.match(Lim, { grp, max })
			.find({ k, score, max })
	})
)

/**
 * S's score beside R's cap at its k: R's cap is a field no containment pins, and S's pin of R's key covers nothing, R
 * being mutable.
 */
const Capped = derived(
	"Capped",
	query(Base).rule((r) => {
		const { k, score } = v(S, "s")
		const { cap } = v(R, "r")
		return r.match(S, { k, score }).match(R, { c: k, cap }).find({ k, score, cap })
	})
)

/** X's value at each k T and R hold: R pinned by T through T ⊆ S ⊆ R alone. */
const Chained = derived(
	"Chained",
	query(Base).rule((r) => {
		const { k } = v(T, "t")
		const { v: value } = v(X, "x")
		return r.match(T, { k }).match(R, { c: k }).match(X, { c: k, v: value }).find({ k, value })
	})
)

/** X's value at each k U and V hold: U and V each contained in the other, each read at its key alone. */
const Cycled = derived(
	"Cycled",
	query(Base).rule((r) => {
		const { k } = v(U, "u")
		const { v: value } = v(X, "x")
		return r.match(U, { k }).match(V, { k }).match(X, { c: k, v: value }).find({ k, value })
	})
)

/** The keys R holds beside A's or B's: a definition of two rules, each reading R at its key. */
const Either = derived(
	"Either",
	query(Base)
		.rule((r) => {
			const { c: k } = v(R, "r")
			return r.match(R, { c: k }).match(A, { k }).find({ k })
		})
		.rule((r) => {
			const { c: k } = v(R, "r")
			return r.match(R, { c: k }).match(B, { k }).find({ k })
		})
)

/** The keys W makes depend on a key x R does not hold. */
const Blocked = derived(
	"Blocked",
	query(Base).rule((r) => {
		const { k, x } = v(W, "w")
		return r
			.match(W, { k, x })
			.where(r.not(R, { c: x }))
			.find({ k })
	})
)

/**
 * Each sign that a candidate session's candidate was there, by its instant: the session's beginning, a presentation in
 * it, and a response to one of its item sessions, as qti-pie's presence signs are. The response's item session is read
 * beside the response at its key, so a fresh item session's rows meet no stored response there.
 */
const signs = query(Base)
	.rule((r) => {
		const { s, k, at } = v(Visit, "visit")
		return r.match(Visit, { s, k, at }).find({ s, k, at })
	})
	.rule((r) => {
		const { s, k, at } = v(Mark, "mark")
		return r.match(Mark, { s, k, at }).find({ s, k, at })
	})
	.rule((r) => {
		const { s, n, at } = v(Snap, "snap")
		const { k } = v(Item, "item")
		return r.match(Snap, { s, n, at }).match(Item, { s, n, k }).find({ s, k, at })
	})

/** Each candidate session's last sign of presence, a fold of its signs grouped at its key. */
const lastSigns = query(Base).rule((r) => {
	const { s, k } = v(Visit, "signed")
	const { at } = v(signs, "sign")
	return r
		.match(Visit, { s, k })
		.match(signs, { s, k, at })
		.find({ s, k, at: r.max(at) })
})

/**
 * Each paused candidate session beside its sitting's test's deadline, the instant it began and its last sign of
 * presence, as qti-pie's SuspensionInTime reads a sitting, its visit, its budget, its suspension and its last presence:
 * the sitting and its test read beyond their keys, the visit at its key and its beginning, and the last sign a fold
 * grouped at the visit's key. Pause pins the sitting (Pause ⊆ Visit ⊆ Session, composed), the visit and the fold's
 * groups at their keys, and Session pins Test, so the rows a write adds to Session, Visit, Item or Test open no fact
 * another probe does not read.
 */
const Paused = derived(
	"Paused",
	query(Base).rule((r) => {
		const { s, test } = v(Session, "session")
		const { cap } = v(Test, "test")
		const { k, at: began } = v(Visit, "visit")
		const { at: last } = v(lastSigns, "last")
		return r
			.match(Session, { s, test })
			.match(Test, { test, cap })
			.match(Visit, { s, k, at: began })
			.match(Pause, { s, k })
			.match(lastSigns, { s, k, at: last })
			.find({ s, k, began, last, cap })
	})
)

/** The sitting's latest beginning of a candidate session, a fold of its visits grouped at the sitting alone. */
const latestVisits = query(Base).rule((r) => {
	const { s, k, at } = v(Visit, "visited")
	return r.match(Visit, { s, k, at }).find({ s, at: r.max(at) })
})

/**
 * Each pause of the sitting beside its latest beginning and its test's deadline: the fold keeps no candidate session,
 * so Pause, which pins the sitting, pins none of the visits it folds, and every visit a write adds is probed.
 */
const Lapsed = derived(
	"Lapsed",
	query(Base).rule((r) => {
		const { s, k } = v(Pause, "pause")
		const { at } = v(latestVisits, "latest")
		const { test } = v(Session, "session")
		const { cap } = v(Test, "test")
		return r
			.match(Pause, { s, k })
			.match(latestVisits, { s, at })
			.match(Session, { s, test })
			.match(Test, { test, cap })
			.find({ s, k, at, cap })
	})
)

/**
 * Kin's cap at each key, of two rules: beside Kid's row there, which pins Kin at its key, and beside X's, which pins
 * nothing, so one probe of Kin's added rows stands, holding the second rule's row alone.
 */
const Mixed = derived(
	"Mixed",
	query(Base)
		.rule((r) => {
			const { k } = v(Kid, "kid")
			const { cap } = v(Kin, "kin")
			return r.match(Kid, { k }).match(Kin, { c: k, cap }).find({ c: k, cap })
		})
		.rule((r) => {
			const { c, v: value } = v(X, "x")
			const { cap } = v(Kin, "kin")
			return r.match(X, { c, v: value }).match(Kin, { c, cap }).find({ c, cap })
		})
)

/** Kid's group beside Kin's cap at that group: Kin read at a field Kid's containment into Kin pins no value of. */
const Crossed = derived(
	"Crossed",
	query(Base).rule((r) => {
		const { k, grp } = v(Kid, "kid")
		const { cap } = v(Kin, "kin")
		return r.match(Kid, { k, grp }).match(Kin, { c: grp, cap }).find({ k, grp, cap })
	})
)

/** Each sitting beside its test's deadline and its seat limit, which no containment relates to the sitting. */
const Booked = derived(
	"Booked",
	query(Base).rule((r) => {
		const { s, test } = v(Session, "session")
		const { cap } = v(Test, "test")
		const { lim } = v(Seat, "seat")
		return r
			.match(Session, { s, test })
			.match(Test, { test, cap })
			.match(Seat, { s, lim })
			.find({ s, cap, lim })
	})
)

/** The bound every check holds its facts to. */
const bound = 5

/** The first level: the checks over the base's joins, and the definitions the levels above read. */
const Cover1 = schema.extend(
	[Base],
	"Cover_1",
	[Direct, Capped, Chained, Cycled, Either, Blocked, Paused, Lapsed, Mixed, Crossed, Booked],
	[
		check("Direct_within", Direct, (d) => d.le(d.score, d.max)),
		check("Capped_within", Capped, (d) => d.le(d.score, d.cap)),
		check("Chained_within", Chained, (d) => d.le(d.value, bound)),
		check("Cycled_within", Cycled, (d) => d.le(d.value, bound)),
		check("Paused_within", Paused, (p) => p.le(p.last, p.cap)),
		check("Lapsed_within", Lapsed, (p) => p.le(p.at, p.cap)),
		check("Mixed_within", Mixed, (d) => d.ge(d.cap, 2)),
		check("Crossed_within", Crossed, (d) => d.le(d.cap, bound)),
		check("Booked_within", Booked, (b) => b.le(b.cap, b.lim))
	]
)

/** A's and B's keys no dependence blocks: a definition of two rules, R read in each under two negations, at x. */
const Unblocked = derived(
	"Unblocked",
	query(Cover1)
		.rule((r) => {
			const { k } = v(A, "a")
			return r.match(A, { k }).where(r.not(Blocked, { k })).find({ k })
		})
		.rule((r) => {
			const { k } = v(B, "b")
			return r.match(B, { k }).where(r.not(Blocked, { k })).find({ k })
		})
)

/** S's score at each k of Either. */
const Defined = derived(
	"Defined",
	query(Cover1).rule((r) => {
		const { k, score } = v(S, "s")
		return r.match(S, { k, score }).match(Either, { k }).find({ k, score })
	})
)

/** The second level: Defined's check, and Unblocked, which the level above reads. */
const Cover2 = schema.extend(
	[Cover1],
	"Cover_2",
	[Defined, Unblocked],
	[check("Defined_within", Defined, (d) => d.le(d.score, bound))]
)

/** S's score at each k of Unblocked. */
const Negated = derived(
	"Negated",
	query(Cover2).rule((r) => {
		const { k, score } = v(S, "s")
		return r.match(S, { k, score }).match(Unblocked, { k }).find({ k, score })
	})
)

/** Each rule, its check over a derived relation (a rule over a query the judge holds by its probes). */
const Cover = schema.extend(
	[Cover2],
	"Cover_3",
	[Negated],
	[check("Negated_within", Negated, (d) => d.le(d.score, bound))]
)

/** Cover installed through its first migration, with no login: the template every case clones. */
export const coverTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "cover",
	content: { schema: "Cover", logins: [] },
	versions: [{ schema: Cover, declarations: noDeclarations }],
	options: {
		label: "cover",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/** The relations a write names, by name: the learner's mutable rows, then the sitting's closed ones. */
const relations = {
	R,
	S,
	T,
	U,
	V,
	X,
	A,
	B,
	W,
	Test,
	Session,
	Visit,
	Pause,
	Mark,
	Item,
	Snap,
	Seat,
	Kin,
	Kid
} as const
type Written = keyof typeof relations

/** The mutable relations a write puts, sets or removes rows of: every one of the learner's but W, which `depend` writes. */
const opens = ["R", "S", "T", "U", "V", "X", "A", "B"] as const
type Opened = (typeof opens)[number]

/** The closed relations a write inserts rows of, and never changes or deletes. */
const closes = [
	"Test",
	"Session",
	"Visit",
	"Pause",
	"Mark",
	"Item",
	"Snap",
	"Seat",
	"Kin",
	"Kid"
] as const
type Closed = (typeof closes)[number]

/**
 * The two keys, values below and above the bound, R's and Kin's two caps on either side of every score and of the
 * bound, and two limits on either side of a score above the bound. The sitting's rows are of its one sitting, of its one test,
 * and of candidate session k, with item session k in it, a value an instant (a score) or a deadline or seat limit (a
 * limit).
 */
const keys = [1, 2] as const
type Key = (typeof keys)[number]
const scores = [3, 9] as const
const caps = [2, 10] as const
const limits = [5, 10] as const

/** One write of a transaction, as drawn. */
export type Op =
	| {
			readonly kind: "put"
			readonly relation: Opened | Closed
			readonly k: Key
			readonly value: number
	  }
	| {
			readonly kind: "set"
			readonly relation: "R" | "S" | "U" | "X"
			readonly k: Key
			readonly value: number
	  }
	| { readonly kind: "remove"; readonly relation: Opened; readonly k: Key }
	| { readonly kind: "depend"; readonly k: Key; readonly x: Key }
	| { readonly kind: "undepend"; readonly k: Key; readonly x: Key }

/** A case: its transactions, each its writes in order, each judged against every law's whole check. */
export interface Schedule {
	readonly transactions: ReadonlyArray<ReadonlyArray<Op>>
}

const keyGen = element(keys)
const openedGen = element(opens)
const closedGen = element(closes)

/**
 * A value a put or a set of `relation` writes: R's or Kin's cap, a test's deadline or a seat limit, a score, X's value
 * or an instant, or a tag or flag of no rule.
 */
const valueOf = (relation: Written, s: Parameters<Gen<Op>>[0]): number =>
	relation === "R" || relation === "Kin"
		? s.draw(element(caps))
		: relation === "Test" || relation === "Seat"
			? s.draw(element(limits))
			: s.draw(element(scores))

const opGen: Gen<Op> = weighted<Op>([
	[
		6,
		(s) => {
			const relation = s.draw(openedGen)
			return { kind: "put", relation, k: s.draw(keyGen), value: valueOf(relation, s) }
		}
	],
	[
		6,
		(s) => {
			const relation = s.draw(closedGen)
			return { kind: "put", relation, k: s.draw(keyGen), value: valueOf(relation, s) }
		}
	],
	[
		3,
		(s) => {
			const relation = s.draw(element(["R", "S", "U", "X"] as const))
			return { kind: "set", relation, k: s.draw(keyGen), value: valueOf(relation, s) }
		}
	],
	[3, (s) => ({ kind: "remove", relation: s.draw(openedGen), k: s.draw(keyGen) })],
	[1, (s) => ({ kind: "depend", k: s.draw(keyGen), x: s.draw(keyGen) })],
	[1, (s) => ({ kind: "undepend", k: s.draw(keyGen), x: s.draw(keyGen) })]
])

const scheduleGen: Gen<Schedule> = (s) => ({
	transactions: s.draw(array(array(opGen, { min: 1, max: 5 }), { min: 1, max: 4 }))
})

/** The situations a search must reach. */
export type CoverFeature =
	| "committed"
	| "refused by a rule"
	| "refused by a containment"
	| "S's and R's rows added in one transaction"
	| "a containment broken in its own transaction"
	| "R's row replaced at its key under another cap"
	| "a row of R unblocking a negated definition"
	| "a dependence withdrawn beside S's row"
	| "a cycle's two rows added in one transaction"
	| "a chain's first row added beside R's"
	| "a sitting's rule refused"
	| "a sitting, its visit and its pause added in one transaction"
	| "a pause added to a visit that stood"
	| "a presentation added to a paused visit that stood"
	| "a response added in a paused visit that stood"
	| "an item session and its response added beside a pause"
	| "a seat added under a sitting that stood"
	| "a visit added beside another's pause that stood"
	| "a row of Kin added at a group a row of Kid stood in"

export const coverFeatures: Arr.NonEmptyReadonlyArray<CoverFeature> = [
	"committed",
	"refused by a rule",
	"refused by a containment",
	"S's and R's rows added in one transaction",
	"a containment broken in its own transaction",
	"R's row replaced at its key under another cap",
	"a row of R unblocking a negated definition",
	"a dependence withdrawn beside S's row",
	"a cycle's two rows added in one transaction",
	"a chain's first row added beside R's",
	"a sitting's rule refused",
	"a sitting, its visit and its pause added in one transaction",
	"a pause added to a visit that stood",
	"a presentation added to a paused visit that stood",
	"a response added in a paused visit that stood",
	"an item session and its response added beside a pause",
	"a seat added under a sitting that stood",
	"a visit added beside another's pause that stood",
	"a row of Kin added at a group a row of Kid stood in"
]

const put = (relation: Opened | Closed, k: Key, value: number): Op => ({
	kind: "put",
	relation,
	k,
	value
})

/** The sitting of the one test, its deadline `cap`, and its candidate session k, begun at `began`. */
const sitting = (k: Key, cap: number, began: number): ReadonlyArray<Op> => [
	put("Test", k, cap),
	put("Session", k, 0),
	put("Visit", k, began)
]

/** For each situation, a case constructed to reach it, its values drawn, so it commits or is refused as they make it. */
const coverAims: ReadonlyArray<readonly [CoverFeature, Gen<Schedule>]> = [
	[
		"S's and R's rows added in one transaction",
		(s) => {
			const k = s.draw(keyGen)
			return {
				transactions: [
					[
						put("R", k, s.draw(element(caps))),
						put("S", k, s.draw(element(scores))),
						...(s.draw(boolean) ? [put("A", k, 0)] : [])
					]
				]
			}
		}
	],
	[
		"a containment broken in its own transaction",
		(s) => {
			const k = s.draw(keyGen)
			return {
				transactions: [
					s.draw(boolean)
						? [put("S", k, s.draw(element(scores)))]
						: [
								put("R", k, 10),
								put("S", k, 3),
								put("T", k, 0),
								{ kind: "remove", relation: "S", k }
							]
				]
			}
		}
	],
	[
		"R's row replaced at its key under another cap",
		(s) => {
			const k = s.draw(keyGen)
			const score = s.draw(element(scores))
			return {
				transactions: [
					[put("R", k, 10), put("S", k, score)],
					s.draw(boolean)
						? [{ kind: "set", relation: "R", k, value: s.draw(element(caps)) }]
						: [{ kind: "remove", relation: "R", k }, put("R", k, s.draw(element(caps)))]
				]
			}
		}
	],
	...Arr.map(
		[
			"a row of R unblocking a negated definition",
			"a dependence withdrawn beside S's row"
		] as const,
		(feature): readonly [CoverFeature, Gen<Schedule>] => [
			feature,
			(s) => {
				const k = s.draw(keyGen)
				const x: Key = k === 1 ? 2 : 1
				return {
					transactions: [
						[
							put("R", k, 10),
							put("S", k, s.draw(element(scores))),
							put(s.draw(element(["A", "B"] as const)), k, 0),
							{ kind: "depend", k, x }
						],
						[
							feature === "a row of R unblocking a negated definition"
								? put("R", x, 10)
								: { kind: "undepend", k, x }
						]
					]
				}
			}
		]
	),
	[
		"a cycle's two rows added in one transaction",
		(s) => {
			const k = s.draw(keyGen)
			return {
				transactions: [[put("X", k, s.draw(element(scores)))], [put("U", k, 0), put("V", k, 0)]]
			}
		}
	],
	[
		"a chain's first row added beside R's",
		(s) => {
			const k = s.draw(keyGen)
			return {
				transactions: [
					[put("R", k, 10), put("S", k, 3), put("X", k, s.draw(element(scores)))],
					[put("T", k, 0)]
				]
			}
		}
	],
	[
		"a sitting, its visit and its pause added in one transaction",
		(s) => {
			const k = s.draw(keyGen)
			return {
				transactions: [
					[...sitting(k, s.draw(element(limits)), s.draw(element(scores))), put("Pause", k, 0)]
				]
			}
		}
	],
	[
		"a pause added to a visit that stood",
		(s) => {
			const k = s.draw(keyGen)
			return {
				transactions: [
					sitting(k, s.draw(element(limits)), s.draw(element(scores))),
					[put("Pause", k, 0)]
				]
			}
		}
	],
	[
		"a presentation added to a paused visit that stood",
		(s) => {
			const k = s.draw(keyGen)
			return {
				transactions: [
					[...sitting(k, 5, 3), put("Pause", k, 0)],
					[put("Mark", k, s.draw(element(scores)))]
				]
			}
		}
	],
	[
		"a response added in a paused visit that stood",
		(s) => {
			const k = s.draw(keyGen)
			return {
				transactions: [
					[...sitting(k, 5, 3), put("Pause", k, 0), put("Item", k, 0)],
					[put("Snap", k, s.draw(element(scores)))]
				]
			}
		}
	],
	[
		"an item session and its response added beside a pause",
		(s) => {
			const k = s.draw(keyGen)
			return {
				transactions: [
					[...sitting(k, 5, 3), put("Pause", k, 0)],
					[put("Item", k, 0), put("Snap", k, s.draw(element(scores)))]
				]
			}
		}
	],
	[
		"a seat added under a sitting that stood",
		(s) => {
			const k = s.draw(keyGen)
			return {
				transactions: [
					sitting(k, s.draw(element(limits)), 3),
					[put("Seat", k, s.draw(element(limits)))]
				]
			}
		}
	],
	[
		"a visit added beside another's pause that stood",
		(s) => ({
			transactions: [
				[...sitting(1, 5, 3), put("Pause", 1, 0)],
				[put("Visit", 2, s.draw(element(scores)))]
			]
		})
	],
	[
		"a row of Kin added at a group a row of Kid stood in",
		(s) => ({
			transactions: [[put("Kin", 2, 10), put("Kid", 2, 0)], [put("Kin", 1, s.draw(element(caps)))]]
		})
	]
]

export const coverSpace = aimed(scheduleGen, coverAims)

/** The column a learner's relation's key is in: R's and X's c, every other's k. */
const keyColumn = (relation: Opened | "W"): "c" | "k" =>
	relation === "R" || relation === "X" ? "c" : "k"

/** The statement of one write, on the installation's names. */
const statementOf = (installed: Installed, op: Op): string => {
	const names = namesOf(installed)
	switch (op.kind) {
		case "put": {
			const t = names.table(relations[op.relation])
			switch (op.relation) {
				case "R":
					return `INSERT INTO ${t} (c, cap) VALUES (${op.k}, ${op.value}) ON CONFLICT DO NOTHING`
				case "S":
					return `INSERT INTO ${t} (k, grp, score) VALUES (${op.k}, 1, ${op.value}) ON CONFLICT DO NOTHING`
				case "T":
					return `INSERT INTO ${t} (k, tag) VALUES (${op.k}, 0) ON CONFLICT DO NOTHING`
				case "U":
					return `INSERT INTO ${t} (k, score) VALUES (${op.k}, ${op.value}) ON CONFLICT DO NOTHING`
				case "V":
					return `INSERT INTO ${t} (k, flag) VALUES (${op.k}, 0) ON CONFLICT DO NOTHING`
				case "X":
					return `INSERT INTO ${t} (c, v) VALUES (${op.k}, ${op.value}) ON CONFLICT DO NOTHING`
				case "A":
				case "B":
					return `INSERT INTO ${t} (k) VALUES (${op.k}) ON CONFLICT DO NOTHING`
				case "Test":
					return `INSERT INTO ${t} (test, cap) VALUES (1, ${op.value}) ON CONFLICT DO NOTHING`
				case "Session":
					return `INSERT INTO ${t} (s, test) VALUES (1, 1) ON CONFLICT DO NOTHING`
				case "Visit":
					return `INSERT INTO ${t} (s, k, at) VALUES (1, ${op.k}, ${op.value}) ON CONFLICT DO NOTHING`
				case "Pause":
					return `INSERT INTO ${t} (s, k) VALUES (1, ${op.k}) ON CONFLICT DO NOTHING`
				case "Mark":
					return `INSERT INTO ${t} (s, k, at) VALUES (1, ${op.k}, ${op.value}) ON CONFLICT DO NOTHING`
				case "Item":
					return `INSERT INTO ${t} (s, n, k) VALUES (1, ${op.k}, ${op.k}) ON CONFLICT DO NOTHING`
				case "Snap":
					return `INSERT INTO ${t} (s, n, at) VALUES (1, ${op.k}, ${op.value}) ON CONFLICT DO NOTHING`
				case "Seat":
					return `INSERT INTO ${t} (s, lim) VALUES (1, ${op.value}) ON CONFLICT DO NOTHING`
				case "Kin":
					return `INSERT INTO ${t} (c, cap) VALUES (${op.k}, ${op.value}) ON CONFLICT DO NOTHING`
				case "Kid":
					return `INSERT INTO ${t} (k, grp) VALUES (${op.k}, 1) ON CONFLICT DO NOTHING`
			}
		}
		case "set": {
			const column = { R: "cap", S: "score", U: "score", X: "v" }[op.relation]
			return `UPDATE ${names.table(relations[op.relation])} SET ${column} = ${op.value} WHERE ${keyColumn(op.relation)} = ${op.k}`
		}
		case "remove":
			return `DELETE FROM ${names.table(relations[op.relation])} WHERE ${keyColumn(op.relation)} = ${op.k}`
		case "depend":
			return `INSERT INTO ${names.table(W)} (k, x) VALUES (${op.k}, ${op.x}) ON CONFLICT DO NOTHING`
		case "undepend":
			return `DELETE FROM ${names.table(W)} WHERE k = ${op.k} AND x = ${op.x}`
	}
}

/**
 * Each containment the schema states, as its source's name, its target's and the columns each pairs: a foreign key
 * checked at COMMIT.
 */
const containments = [
	["S", "R", [["k", "c"]]],
	["T", "S", [["k", "k"]]],
	["U", "V", [["k", "k"]]],
	["V", "U", [["k", "k"]]],
	["Session", "Test", [["test", "test"]]],
	["Visit", "Session", [["s", "s"]]],
	[
		"Pause",
		"Visit",
		[
			["s", "s"],
			["k", "k"]
		]
	],
	[
		"Mark",
		"Visit",
		[
			["s", "s"],
			["k", "k"]
		]
	],
	["Item", "Session", [["s", "s"]]],
	[
		"Snap",
		"Item",
		[
			["s", "s"],
			["n", "n"]
		]
	],
	["Kid", "Kin", [["k", "c"]]]
] as const satisfies ReadonlyArray<
	readonly [Written, Written, Arr.NonEmptyReadonlyArray<readonly [string, string]>]
>

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** Every law a refusal's constraint serves, through the installation's constraint map. */
const refusedLaws = (
	installation: Installation,
	fields: { readonly table: Option.Option<string>; readonly constraint: string | undefined }
): ReadonlyArray<LawId> => {
	if (Option.isNone(fields.table) || fields.constraint === undefined) {
		return []
	}
	const table = fields.table.value
	const owner = Arr.findFirst(stored, (r) => installation.names.relation(r.name).name === table)
	return Option.isNone(owner)
		? []
		: (lawsOfConstraint(
				installation.constraintToLaw,
				{ kind: "table", name: installation.names.relation(owner.value.name).name },
				fields.constraint
			) ?? [])
}

/**
 * Judges the state `session`'s transaction leaves against every law: each rule's whole check (its violation query over
 * every fact, lowered by the oracle baseline, deploy/snapshot/violation.ts baselineRuleChecks), which reads no probe,
 * and each containment's rows of its source no row of its target holds at its key. Then runs the judge and the
 * deferred foreign keys (SET CONSTRAINTS ALL IMMEDIATE): they must refuse exactly when a law is broken, naming one that
 * is. Answers which kind of law refused, none where they accepted.
 */
const judged = (installed: Installed, session: RawSession, where: string) =>
	Effect.gen(function* () {
		const installation = installed.installation
		const names = namesOf(installed)
		const broken = new Set<LawId>()
		for (const c of baselineRuleChecks(installation)) {
			const found = yield* session.values(`SELECT EXISTS (${printStatement(c.query)})`, [])
			if (found[0]?.[0] === true) {
				broken.add(c.law)
			}
		}
		const brokenContainments: Array<string> = []
		for (const [from, to, pairs] of containments) {
			const meets = Arr.join(
				Arr.map(pairs, ([f, t]) => `t.${t} = f.${f}`),
				" AND "
			)
			const found = yield* session.values(
				`SELECT EXISTS (SELECT FROM ${names.table(relations[from])} AS f WHERE NOT EXISTS (SELECT FROM ${names.table(relations[to])} AS t WHERE ${meets}))`,
				[]
			)
			if (found[0]?.[0] === true) {
				brokenContainments.push(`${from} in ${to}`)
			}
		}
		const refused = yield* refusalOf(session.query("SET CONSTRAINTS ALL IMMEDIATE", []))
		if (Option.isNone(refused)) {
			if (broken.size > 0 || brokenContainments.length > 0) {
				return yield* new Disagreed({
					message: `the judge accepted a state that breaks ${Formatter.format([...broken, ...brokenContainments])}, ${where}`
				})
			}
			return Option.none<{
				readonly by: "rule" | "containment"
				readonly laws: ReadonlyArray<LawId>
			}>()
		}
		const laws = refusedLaws(installation, refused.value)
		if (refused.value.code === "23514" && Arr.some(laws, (law) => broken.has(law))) {
			return Option.some({ by: "rule" as const, laws })
		}
		if (refused.value.code === "23503" && brokenContainments.length > 0) {
			return Option.some({ by: "containment" as const, laws })
		}
		return yield* new Disagreed({
			message: `refused under ${refused.value.code} ${refused.value.constraint ?? "naming no constraint"} where the laws broken are ${Formatter.format([...broken, ...brokenContainments])}, ${where}`
		})
	})

/**
 * The side of `side` of `relation`, the delta its capture writes (rules.ts addRules): news, the one with a count of
 * each image, or olds; none where no rule reads that side of it.
 */
const deltaOf = (installation: Installation, relation: Written, side: "news" | "olds") =>
	Arr.findFirst(
		capturedDeltasOf(installation, relation),
		(d) => Arr.contains(d.columns, countColumn) === (side === "news")
	).pipe(Option.map((d) => d.name))

/**
 * Which relations' added rows each rule's probes read, as a sibling's cover decides (analysis/theory/query.ts
 * `coverOf`):
 *
 * - R, read at its key alone, is covered by S in Direct and Defined (S ⊆ R, through Either's two rules in Defined), and
 *   by T in Chained through T ⊆ S ⊆ R, a composition alone;
 * - R's cap in Capped is a field S pins no value of, and R is mutable, so S's pin of its key covers nothing: a row R
 *   gains at the key S stood at may replace the row that stood there, under another cap, and Capped reads R's added
 *   rows;
 * - R's rows in Negated, read under two negations inside Unblocked, add facts no row of S pins; U and V, each read at
 *   its key alone and each contained in the other: U, first, is covered by V, and V by nothing, U's chain reaching
 *   back to it, so the cycle keeps V's probe;
 * - a sitting's closed rows (Paused): Visit pins Session, Pause pins Visit and the last-sign fold at their keys, Snap
 *   pins Item at its key inside a sign's rule of the fold, and Session pins Test, a chain Test, Session, Visit, Pause
 *   that ends at Pause, though no composition carries Test's key to Pause, so only Pause's, Mark's and Snap's added
 *   rows are probed, the four covered relations being closed, each row a write adds of them one of a new key (Cover
 *   `fresh`); Mark and Snap stand in the fold with nothing pinning them, presentations
 *   and responses added in a paused session that stood, which their own probes judge;
 * - Lapsed: the fold of the sitting's visits keeps no candidate session, so Pause pins no visit it folds and Visit's
 *   added rows stay probed, while Pause pins Session and Session Test;
 * - Mixed: Kin read beside Kid, which pins its key, and beside X, which pins nothing: its probe of Kin's added rows
 *   holds X's rule's row alone (`coveredRows`);
 * - Crossed: Kin read at Kid's group, a field Kid ⊆ Kin pins no value of, stays probed;
 * - Booked: no containment relates Seat to Session, so both stay probed, and Session pins Test.
 *
 * Test and Item, which no other rule reads, have no side of news at all: no capture writes their inserts. And no
 * closed relation has a side of olds: no probe reads the rows a write removes of one, which no served write removes.
 */
const probed: ReadonlyArray<readonly [string, ReadonlyArray<Written>, ReadonlyArray<Written>]> = [
	["Direct_within", ["S"], ["R"]],
	["Capped_within", ["S", "R"], []],
	["Chained_within", ["T", "X"], ["R"]],
	["Cycled_within", ["V", "X"], ["U"]],
	["Defined_within", ["S", "A", "B"], ["R"]],
	["Negated_within", ["S", "A", "B", "R"], []],
	["Paused_within", ["Pause", "Mark", "Snap"], ["Session", "Visit", "Item", "Test"]],
	["Lapsed_within", ["Pause", "Visit"], ["Session", "Test"]],
	["Mixed_within", ["Kid", "X", "Kin"], []],
	["Crossed_within", ["Kid", "Kin"], []],
	["Booked_within", ["Session", "Seat"], ["Test"]]
]

/** The closed relations whose inserts no capture writes, every rule's probes of them covered. */
const uncaptured: ReadonlyArray<Written> = ["Test", "Item"]

/**
 * Holds the probes of the installation's judge to `probed`: those it reads and those a cover prunes, each pruned
 * relation recorded with its covers and no block of its added rows (laws/model/model.ts RuleTrigger `covered`, what
 * snapshot.json's `proved` records); no capture of the inserts of `uncaptured`; no capture of a closed relation's
 * removed rows; and Negated_within's probes reading the dependences W loses, a mutable relation's, which unblock its
 * facts.
 */
export const coverage = (installed: Installed) => {
	const installation = installed.installation
	const reads = judgedDeltaReadsOf(installation)
	for (const [name, read, pruned] of probed) {
		const rule = defined(
			Arr.findFirst(installation.laws.rules, (r) => Str.includes(name)(r.law.named.display)).pipe(
				Option.getOrUndefined
			),
			`the rule ${name}`
		)
		const id = identifierOf(rule.named)
		const its = Arr.filter(reads, (r) => Option.contains(raisedRule(r.statement), id))
		const readsDelta = (delta: Option.Option<string>) =>
			Option.isSome(delta) && Arr.some(its, (r) => r.deltas.has(delta.value))
		for (const relation of read) {
			assert.ok(
				readsDelta(deltaOf(installation, relation, "news")),
				`${name}'s probes read ${relation}'s added rows`
			)
		}
		for (const relation of pruned) {
			assert.ok(
				!readsDelta(deltaOf(installation, relation, "news")),
				`${name}'s probes read no added row of ${relation}, which a contained relation's rows pin`
			)
			const record = Arr.findFirst(rule.covered, (c) => c.relation === relation)
			assert.ok(
				Option.isSome(record) && !Arr.contains(record.value.sides, "added"),
				`${name} records ${relation}'s covers and no block of its added rows`
			)
		}
	}
	for (const relation of uncaptured) {
		assert.ok(
			Option.isNone(deltaOf(installation, relation, "news")),
			`no capture writes ${relation}'s inserts: every probe of its added rows is covered`
		)
	}
	const negated = defined(
		Arr.findFirst(installation.laws.rules, (r) =>
			Str.includes("Negated_within")(r.law.named.display)
		).pipe(Option.getOrUndefined),
		"the rule Negated_within"
	)
	const olds = Arr.findFirst(
		capturedDeltasOf(installation, "W"),
		(d) => !Arr.contains(d.columns, countColumn)
	).pipe(Option.map((d) => d.name))
	assert.ok(
		Option.isSome(olds) &&
			Arr.some(
				reads,
				(r) =>
					Option.contains(raisedRule(r.statement), identifierOf(negated.named)) &&
					r.deltas.has(olds.value)
			),
		"Negated_within's probes read W's removed rows: a dependence withdrawn unblocks its facts"
	)
	for (const relation of closes) {
		assert.ok(
			Option.isNone(deltaOf(installation, relation, "olds")),
			`no capture writes ${relation}'s removed rows: no served write removes a closed relation's row`
		)
	}
	const mixed = defined(
		Arr.findFirst(installation.laws.rules, (r) =>
			Str.includes("Mixed_within")(r.law.named.display)
		).pipe(Option.getOrUndefined),
		"the rule Mixed_within"
	)
	if (mixed.rule.kind === "whole") {
		return assert.fail("Mixed_within is probed: it reads two units' rows")
	}
	assert.equal(
		probeRows(
			mixed.rule,
			"Kin",
			"added",
			proofsOf(
				installation.laws.theory.regionFacts,
				(relation) => installation.laws.theory.relations[relation],
				clockOrders(installation.laws.theory.instants)
			),
			mixed.law.loc
		).length,
		coveredRows,
		"Mixed_within's probe of Kin's added rows holds the row of its rule beside X alone"
	)
}

/** The rows of Mixed_within's probe of Kin's added rows: its rule beside X's row, which no cover spares. */
const coveredRows = 1

/** The situations one transaction reaches, from its writes and the state before it. */
const reachedBy = (
	ops: ReadonlyArray<Op>,
	before: ReadonlySet<string>
): ReadonlyArray<CoverFeature> => {
	const reached: Array<CoverFeature> = []
	const puts = (relation: Written) =>
		Arr.filter(ops, (o) => o.kind === "put" && o.relation === relation)
	const putAt = (relation: Written, k: number) =>
		Arr.some(ops, (o) => o.kind === "put" && o.relation === relation && o.k === k)
	if (Arr.some(puts("S"), (o) => o.kind === "put" && putAt("R", o.k))) {
		reached.push("S's and R's rows added in one transaction")
	}
	if (Arr.some(puts("U"), (o) => o.kind === "put" && putAt("V", o.k))) {
		reached.push("a cycle's two rows added in one transaction")
	}
	if (Arr.some(puts("T"), (o) => o.kind === "put" && before.has(`R ${o.k}`))) {
		reached.push("a chain's first row added beside R's")
	}
	if (
		Arr.some(
			ops,
			(o) =>
				o.kind === "set" && o.relation === "R" && before.has(`R ${o.k}`) && before.has(`S ${o.k}`)
		) ||
		Arr.some(
			ops,
			(o, i) =>
				o.kind === "remove" &&
				o.relation === "R" &&
				before.has(`S ${o.k}`) &&
				Arr.some(ops.slice(i + 1), (p) => p.kind === "put" && p.relation === "R" && p.k === o.k)
		)
	) {
		reached.push("R's row replaced at its key under another cap")
	}
	if (
		Arr.some(
			puts("R"),
			(o) =>
				o.kind === "put" &&
				Arr.some([...before], (row) => Str.startsWith("W ")(row) && Str.endsWith(` ${o.k}`)(row))
		)
	) {
		reached.push("a row of R unblocking a negated definition")
	}
	const stood = (relation: Written, k: number) => before.has(`${relation} ${k}`)
	if (
		Arr.some(puts("Pause"), (o) => o.kind === "put" && putAt("Visit", o.k) && putAt("Session", o.k))
	) {
		reached.push("a sitting, its visit and its pause added in one transaction")
	}
	if (Arr.some(puts("Pause"), (o) => o.kind === "put" && stood("Visit", o.k))) {
		reached.push("a pause added to a visit that stood")
	}
	if (Arr.some(puts("Mark"), (o) => o.kind === "put" && stood("Pause", o.k))) {
		reached.push("a presentation added to a paused visit that stood")
	}
	if (Arr.some(puts("Snap"), (o) => o.kind === "put" && stood("Pause", o.k))) {
		reached.push("a response added in a paused visit that stood")
	}
	if (
		Arr.some(
			puts("Snap"),
			(o) => o.kind === "put" && putAt("Item", o.k) && (stood("Pause", o.k) || putAt("Pause", o.k))
		)
	) {
		reached.push("an item session and its response added beside a pause")
	}
	if (Arr.isReadonlyArrayNonEmpty(puts("Seat")) && before.has("Session")) {
		reached.push("a seat added under a sitting that stood")
	}
	if (
		Arr.some(
			puts("Visit"),
			(o) => o.kind === "put" && Arr.some(keys, (k) => k !== o.k && stood("Pause", k))
		)
	) {
		reached.push("a visit added beside another's pause that stood")
	}
	if (
		Arr.some(
			ops,
			(o) => o.kind === "undepend" && before.has(`W ${o.k} ${o.x}`) && before.has(`S ${o.k}`)
		)
	) {
		reached.push("a dependence withdrawn beside S's row")
	}
	if (
		Arr.some(
			puts("Kin"),
			(o) =>
				o.kind === "put" && o.k === 1 && Arr.some(keys, (k) => k !== 1 && before.has(`Kid ${k}`))
		)
	) {
		reached.push("a row of Kin added at a group a row of Kid stood in")
	}
	return reached
}

/**
 * The rows that stand of the relations a situation reads, as `relation key` (W's as `W k x`), a sitting's rows by their
 * sitting.
 */
const standingOf = (installed: Installed, session: RawSession) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const rows: Array<string> = []
		for (const relation of ["R", "S"] as const) {
			for (const row of yield* session.values(
				`SELECT ${keyColumn(relation)} FROM ${names.table(relations[relation])}`,
				[]
			)) {
				rows.push(`${relation} ${String(row[0])}`)
			}
		}
		for (const relation of ["Visit", "Pause", "Kid"] as const) {
			for (const row of yield* session.values(
				`SELECT k FROM ${names.table(relations[relation])}`,
				[]
			)) {
				rows.push(`${relation} ${String(row[0])}`)
			}
		}
		const sessions = yield* session.values(`SELECT FROM ${names.table(Session)}`, [])
		if (Arr.isReadonlyArrayNonEmpty(sessions)) {
			rows.push("Session")
		}
		for (const row of yield* session.values(`SELECT k, x FROM ${names.table(W)}`, [])) {
			rows.push(`W ${String(row[0])} ${String(row[1])}`)
		}
		return new Set(rows)
	})

/**
 * One case on its own clone: Lim's one group at the bound, then each transaction's writes in order on an owner session
 * at SERIALIZABLE, its end judged as `judged` judges it: refused, the transaction rolls back; accepted, it commits.
 */
export const runSchedule = (
	installed: Installed,
	admin: PgConnection,
	session: RawSession,
	schedule: Schedule,
	c: Case<CoverFeature>
) =>
	Effect.gen(function* () {
		yield* standUpJudge(admin, installed.installation)
		yield* standUpJudge(session, installed.installation)
		const names = namesOf(installed)
		yield* admin.query(`INSERT INTO ${names.table(Lim)} (grp, max) VALUES (1, ${bound})`, [])
		const sittings = new Set<LawId>(
			Arr.flatMap(installed.installation.laws.rules, (r) =>
				Arr.some(["Paused_within", "Lapsed_within", "Booked_within"], (name) =>
					Str.includes(name)(r.law.named.display)
				)
					? [r.law.id]
					: []
			)
		)
		for (const [at, ops] of schedule.transactions.entries()) {
			const where = `transaction ${at} of ${Formatter.format(schedule)}`
			yield* session.begin
			const before = yield* standingOf(installed, session)
			for (const op of ops) {
				yield* session.query(statementOf(installed, op), [])
			}
			c.noteAll(reachedBy(ops, before))
			const verdict = yield* judged(installed, session, where)
			if (Option.isNone(verdict)) {
				yield* session.commit
				c.note("committed")
			} else {
				c.note(verdict.value.by === "rule" ? "refused by a rule" : "refused by a containment")
				if (verdict.value.by === "containment" && Arr.some(ops, (o) => o.kind === "put")) {
					c.note("a containment broken in its own transaction")
				}
				if (Arr.some(verdict.value.laws, (law) => sittings.has(law))) {
					c.note("a sitting's rule refused")
				}
				yield* session.rollback
			}
		}
	})
