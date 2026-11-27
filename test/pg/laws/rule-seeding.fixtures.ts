/** What the properties of rule-seeding.test.ts read: each shape's schema and template, its cases and aims, and its judges. */
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert, defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int, map, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Data, Effect, Formatter, Option } from "effect"
import { type LawId } from "#compiler/core/ids.ts"
import { baselineRuleChecks, lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { lawsOfConstraint } from "#compiler/ir/products.ts"
import { countColumn } from "#compiler/physical/ddl/deltas.ts"
import { type Installation } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, contained, derived, key, on, relation, schema } from "#compiler/public/schema.ts"
import { printStatement } from "#compiler/sql/print.ts"
import {
	type Seat,
	type SeatCase,
	type SeatTemplate,
	seatIn,
	seatTemplate,
	seededSeatTemplate
} from "#test/pg/fin/installed.ts"
import { dataStepOf, refusedByRecheck } from "#test/support/data-step.ts"
import {
	capturedDeltasOf,
	foundQueryOf,
	judgedDeltaReadsOf,
	judgedPlans,
	type JudgedStatement,
	scannedWork,
	standUpJudge
} from "#test/support/judge.ts"
import { firstRefusalOf, refusalOf } from "#test/support/substrate.ts"
import { type RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

const L1 = relation("L1", { id: pg.integer, up: pg.integer, v: pg.integer }, ["id"])
const L2 = relation("L2", { id: pg.integer, up: pg.integer, v: pg.integer }, ["id"])
const L3 = relation("L3", { id: pg.integer, up: pg.integer, v: pg.integer }, ["id"])
const M = relation("M", { id: pg.integer, up: pg.integer }, ["id"])
const N = relation("N", { id: pg.integer }, ["id"])

const RELATIONS = ["L1", "L2", "L3", "M", "N"] as const
type Table = (typeof RELATIONS)[number]
type Link = Extract<Table, "L1" | "L2" | "L3">
const LINKS = ["L1", "L2", "L3"] as const

/** A link with a link below it, whose rows' children an unwind deletes with them. */
type Upper = Extract<Link, "L1" | "L2">
const UPPERS = ["L1", "L2"] as const
const lowerOf = (upper: Upper): Link => (upper === "L1" ? "L2" : "L3")

/** The stored relations of every shape, and the path L1 ⋈ L2 from a key to its L2, an imported query. */
const base = (name: string) => {
	const Base = schema(name, [L1, L2, L3, M, N], [])
	const path = query(Base).rule((r) => {
		const { id: x1, up: k } = v(L1, "first")
		const { id: x2 } = v(L2, "second")
		return r.match(L1, { id: x1, up: k }).match(L2, { id: x2, up: x1 }).find({ k, x2 })
	})
	return { Base, path }
}

/** titles: edullm's LomObjectTitle in miniature. */
const titles = (name: string) => {
	const { Base, path } = base(name)
	const Listed = derived(
		"Listed",
		query(Base).rule((r) => {
			const { k, x2 } = v(path, "path")
			return r.match(M, { up: x2 }).match(path, { k, x2 }).find({ k })
		})
	)
	const Matched = derived(
		"Matched",
		query(Base)
			.rule((r) => {
				const { k, x2 } = v(path, "path")
				return r.match(path, { k, x2 }).match(L3, { up: x2, v: 1 }).find({ k })
			})
			.rule((r) => {
				const { k, x2 } = v(path, "path")
				return r
					.match(path, { k, x2 })
					.where(r.not(N, { id: x2 }))
					.find({ k })
			})
	)
	return schema.extend(
		[Base],
		`${name}_1`,
		[Listed, Matched],
		[contained(on(Listed, "k"), on(Matched, "k"))]
	)
}

/**
 * viewed: titles over a path at a level of its own, a derived relation its definitions read, which the rule's whole
 * check reads on its definition, live, as its triggers do.
 */
const viewed = (name: string) => {
	const { Base } = base(name)
	const Path = derived(
		"Path",
		query(Base).rule((r) => {
			const { id: x1, up: k } = v(L1, "first")
			const { id: x2 } = v(L2, "second")
			return r.match(L1, { id: x1, up: k }).match(L2, { id: x2, up: x1 }).find({ k, x2 })
		})
	)
	const Mid = schema.extend([Base], `${name}_1`, [Path], [])
	const Listed = derived(
		"Listed",
		query(Mid).rule((r) => {
			const { k, x2 } = v(Path, "path")
			return r.match(M, { up: x2 }).match(Path, { k, x2 }).find({ k })
		})
	)
	const Matched = derived(
		"Matched",
		query(Mid)
			.rule((r) => {
				const { k, x2 } = v(Path, "path")
				return r.match(Path, { k, x2 }).match(L3, { up: x2, v: 1 }).find({ k })
			})
			.rule((r) => {
				const { k, x2 } = v(Path, "path")
				return r
					.match(Path, { k, x2 })
					.where(r.not(N, { id: x2 }))
					.find({ k })
			})
	)
	return schema.extend(
		[Mid],
		`${name}_2`,
		[Listed, Matched],
		[contained(on(Listed, "k"), on(Matched, "k"))]
	)
}

/** deep: a source of two arms in a target of three, the first declared from its deepest link up. */
const deep = (name: string) => {
	const { Base } = base(name)
	const Marked = derived(
		"Marked",
		query(Base)
			.rule((r) => {
				const { id: x1, up: k } = v(L1, "first")
				return r.match(M, { up: x1 }).match(L1, { id: x1, up: k }).find({ k })
			})
			.rule((r) => {
				const { id: x1, up: k } = v(L1, "first")
				const { id: x2 } = v(L2, "second")
				return r
					.match(L2, { id: x2, up: x1, v: 1 })
					.match(M, { up: x2 })
					.match(L1, { id: x1, up: k })
					.find({ k })
			})
	)
	const Reached = derived(
		"Reached",
		query(Base)
			.rule((r) => {
				const { id: x1, up: k } = v(L1, "first")
				const { id: x2 } = v(L2, "second")
				return r
					.match(L3, { up: x2, v: 1 })
					.match(L2, { id: x2, up: x1 })
					.match(L1, { id: x1, up: k })
					.find({ k })
			})
			.rule((r) => {
				const { id: x1, up: k } = v(L1, "first")
				return r
					.match(L1, { id: x1, up: k, v: 1 })
					.where(r.not(N, { id: x1 }))
					.find({ k })
			})
			.rule((r) => {
				const { id: x1, up: k } = v(L1, "first")
				const { id: x2 } = v(L2, "second")
				const { id: x3 } = v(L3, "third")
				return r
					.match(L1, { id: x1, up: k })
					.match(L2, { id: x2, up: x1 })
					.match(L3, { id: x3, up: x2 })
					.where(r.not(N, { id: x3 }))
					.find({ k })
			})
	)
	return schema.extend(
		[Base],
		`${name}_1`,
		[Marked, Reached],
		[contained(on(Marked, "k"), on(Reached, "k"))]
	)
}

/** key: a key over a side of three arms. */
const keyed = (name: string) => {
	const { Base, path } = base(name)
	const Valued = derived(
		"Valued",
		query(Base)
			.rule((r) => {
				const { up: k, v: w } = v(L1, "first")
				return r.match(L1, { up: k, v: w }).find({ k, w })
			})
			.rule((r) => {
				const { id: x1, up: k } = v(L1, "first")
				const { v: w } = v(L2, "second")
				return r
					.match(L1, { id: x1, up: k })
					.match(L2, { up: x1, v: w })
					.where(r.not(N, { id: x1 }))
					.find({ k, w })
			})
			.rule((r) => {
				const { k, x2 } = v(path, "path")
				const { v: w } = v(L3, "third")
				return r.match(L3, { up: x2, v: w }).match(path, { k, x2 }).find({ k, w })
			})
	)
	return schema.extend([Base], `${name}_1`, [Valued], [key(on(Valued, "k"))])
}

/**
 * tagged: key's side, each arm tagging its facts by a literal, the first two by 1 and the third by 2, under a key over
 * the key and its tag, so a probe of one arm meets another's tag by the same literal or by a different one.
 */
const tagged = (name: string) => {
	const { Base, path } = base(name)
	const Tagged = derived(
		"Tagged",
		query(Base)
			.rule((r) => {
				const { up: k, v: w } = v(L1, "first")
				return r.match(L1, { up: k, v: w }).find({ k, tag: 1, w })
			})
			.rule((r) => {
				const { id: x1, up: k } = v(L1, "first")
				const { v: w } = v(L2, "second")
				return r
					.match(L1, { id: x1, up: k })
					.match(L2, { up: x1, v: w })
					.where(r.not(N, { id: x1 }))
					.find({ k, tag: 1, w })
			})
			.rule((r) => {
				const { k, x2 } = v(path, "path")
				const { v: w } = v(L3, "third")
				return r.match(L3, { up: x2, v: w }).match(path, { k, x2 }).find({ k, tag: 2, w })
			})
	)
	return schema.extend([Base], `${name}_1`, [Tagged], [key(on(Tagged, "k", "tag"))])
}

/**
 * standing: a key over the L1s no standing block holds out, a block standing where no mark lifts it: the side negates a
 * derived relation, Standing, that negates in turn, as an Active of the sittings no standing invalidation names does.
 * A block deleted brings back the facts it held out, a negated relation's rows lost; a mark inserted does too, a row
 * gained by a relation under two negations; and a mark deleted holds them out again.
 */
const standing = (name: string) => {
	const { Base } = base(name)
	const Standing = derived(
		"Standing",
		query(Base).rule((r) => {
			const { id: x } = v(N, "block")
			return r
				.match(N, { id: x })
				.where(r.not(M, { up: x }))
				.find({ x })
		})
	)
	const Mid = schema.extend([Base], `${name}_1`, [Standing], [])
	const Unheld = derived(
		"Unheld",
		query(Mid).rule((r) => {
			const { id: x1, up: k, v: w } = v(L1, "first")
			return r
				.match(L1, { id: x1, up: k, v: w })
				.where(r.not(Standing, { x: x1 }))
				.find({ k, w })
		})
	)
	return schema.extend([Mid], `${name}_2`, [Unheld], [key(on(Unheld, "k"))])
}

/**
 * lifted: a containment whose target is standing's side, the L1s no standing block holds out: the keys with a path to
 * an L2 are contained in the keys of an unheld L1, so a block inserted withdraws the target's facts it holds out, a
 * negated relation's rows gained, and a mark deleted does too, a row lost by a relation under two negations.
 */
const lifted = (name: string) => {
	const { Base, path } = base(name)
	const Standing = derived(
		"Standing",
		query(Base).rule((r) => {
			const { id: x } = v(N, "block")
			return r
				.match(N, { id: x })
				.where(r.not(M, { up: x }))
				.find({ x })
		})
	)
	const Mid = schema.extend([Base], `${name}_1`, [Standing], [])
	const Pathed = derived(
		"Pathed",
		query(Mid).rule((r) => {
			const { k, x2 } = v(path, "path")
			return r.match(path, { k, x2 }).find({ k })
		})
	)
	const Unheld = derived(
		"Unheld",
		query(Mid).rule((r) => {
			const { id: x1, up: k } = v(L1, "first")
			return r
				.match(L1, { id: x1, up: k })
				.where(r.not(Standing, { x: x1 }))
				.find({ k })
		})
	)
	return schema.extend(
		[Mid],
		`${name}_2`,
		[Pathed, Unheld],
		[contained(on(Pathed, "k"), on(Unheld, "k"))]
	)
}

/**
 * budget: edullm's First_budget in miniature, a check over a side three negations deep: an L1 is rate-paced where none
 * of its L2s is paceless, an L2 paceless where no block marks it time-dependent, and every L1 that is not rate-paced
 * holds value 1. A block deleted makes its L2 paceless and its L1 no longer rate-paced, an occurrence under three
 * negations losing a row; an L2 inserted under an L1 does too, one under two gaining one.
 */
const budget = (name: string) => {
	const { Base } = base(name)
	const Paceless = derived(
		"Paceless",
		query(Base).rule((r) => {
			const { id: x2, up: x1 } = v(L2, "member")
			return r
				.match(L2, { id: x2, up: x1 })
				.where(r.not(N, { id: x2 }))
				.find({ x: x1 })
		})
	)
	const Low = schema.extend([Base], `${name}_1`, [Paceless], [])
	const RatePaced = derived(
		"RatePaced",
		query(Low).rule((r) => {
			const { id: x1 } = v(L1, "root")
			return r
				.match(L1, { id: x1 })
				.where(r.not(Paceless, { x: x1 }))
				.find({ x: x1 })
		})
	)
	const Mid = schema.extend([Low], `${name}_2`, [RatePaced], [])
	const Limited = derived(
		"Limited",
		query(Mid).rule((r) => {
			const { id: x1, up: k, v: w } = v(L1, "first")
			return r
				.match(L1, { id: x1, up: k, v: w })
				.where(r.not(RatePaced, { x: x1 }))
				.find({ k, w })
		})
	)
	return schema.extend(
		[Mid],
		`${name}_3`,
		[Limited],
		[check("Budgeted", Limited, (l) => l.eq(l.w, 1))]
	)
}

export const shapes = [
	"titles",
	"viewed",
	"deep",
	"key",
	"tagged",
	"standing",
	"lifted",
	"budget"
] as const
export type Shape = (typeof shapes)[number]

/** What a shape's rule is: a containment, or a key. */
const ruleOf = {
	titles: "contained",
	viewed: "contained",
	deep: "contained",
	key: "key",
	tagged: "key",
	standing: "key",
	lifted: "contained",
	budget: "check"
} as const satisfies Record<Shape, "contained" | "key" | "check">

const schemaOf = (shape: Shape, name: string) => {
	switch (shape) {
		case "titles":
			return titles(name)
		case "viewed":
			return viewed(name)
		case "deep":
			return deep(name)
		case "key":
			return keyed(name)
		case "tagged":
			return tagged(name)
		case "standing":
			return standing(name)
		case "lifted":
			return lifted(name)
		case "budget":
			return budget(name)
	}
}

/** The SQLSTATE a shape's rule is refused under: a containment's, a key's or a check's. */
const codeOf = (shape: Shape): string => {
	switch (ruleOf[shape]) {
		case "contained":
			return "23503"
		case "key":
			return "23505"
		case "check":
			return "23514"
	}
}

/** One write of a transaction, as drawn. */
type Op =
	| {
			readonly kind: "chain"
			readonly k: number
			readonly ids: readonly [number, number, number]
			readonly values: readonly [number, number, number]
	  }
	| { readonly kind: "mark"; readonly id: number; readonly up: number }
	| { readonly kind: "block"; readonly id: number }
	| { readonly kind: "delete"; readonly table: Table; readonly id: number }
	| { readonly kind: "unwind"; readonly upper: Upper; readonly id: number }
	| { readonly kind: "relink"; readonly table: Link; readonly id: number; readonly up: number }
	| { readonly kind: "revalue"; readonly table: Link; readonly id: number; readonly value: number }

/**
 * The shapes the equivalence search judges: those whose rule reads a relation under two or three negations, where a
 * probe's deltas must be read with their polarity turned at each negation.
 */
export const judgedShapes = ["standing", "lifted", "budget"] as const satisfies ReadonlyArray<Shape>
export type JudgedShape = (typeof judgedShapes)[number]

interface Case {
	readonly shape: JudgedShape
	readonly history: ReadonlyArray<ReadonlyArray<Op>>
}

const idGen = int(1, 3)
const valueGen = int(0, 1)

const opGen: Gen<Op> = weighted<Op>([
	[
		4,
		(s) => ({
			kind: "chain",
			k: s.draw(int(1, 2)),
			ids: [s.draw(idGen), s.draw(idGen), s.draw(idGen)],
			values: [s.draw(valueGen), s.draw(valueGen), s.draw(valueGen)]
		})
	],
	[3, (s) => ({ kind: "mark", id: s.draw(int(1, 2)), up: s.draw(idGen) })],
	[2, (s) => ({ kind: "block", id: s.draw(idGen) })],
	[3, (s) => ({ kind: "delete", table: s.draw(element(RELATIONS)), id: s.draw(idGen) })],
	[3, (s) => ({ kind: "unwind", upper: s.draw(element(UPPERS)), id: s.draw(idGen) })],
	[
		2,
		(s) => ({ kind: "relink", table: s.draw(element(LINKS)), id: s.draw(idGen), up: s.draw(idGen) })
	],
	[
		2,
		(s) => ({
			kind: "revalue",
			table: s.draw(element(LINKS)),
			id: s.draw(idGen),
			value: s.draw(valueGen)
		})
	]
])

/** A case of one shape: a history drawn for it. */
export const caseGen =
	(shape: JudgedShape): Gen<Case> =>
	(s) => ({
		shape,
		history: s.draw(array(array(opGen, { min: 1, max: 3 }), { min: 3, max: 10 }))
	})

/**
 * How a constructed case's last transaction changes the facts it refuses by: by single-row deletes alone; by inserting
 * blocks alone, which withdraw the facts a negation of N admitted; by inserting marks alone, which bring back the facts
 * a standing block held out; by deleting marks alone, which let a block stand again; or by chains alone whose L1s stood,
 * each adding an L2 under its L1, which makes a rate-paced L1 paceless.
 */
type Withdrawal = "deletes" | "block" | "mark" | "unmark" | "pace"

/** The refusal a constructed case reaches by its withdrawal. */
const refusedAfter = {
	deletes: "refused once rows were deleted one at a time, and nothing else",
	block: "refused once a block was inserted",
	mark: "refused once a mark was inserted, and nothing else",
	unmark: "refused once a mark was deleted, and nothing else",
	pace: "refused once an L2 was added under an L1 that stood, and nothing else"
} as const satisfies Record<Withdrawal, EquivalenceFeature>

/** An id of 1 to 3 other than `id`: `id` moved on by one or two, wrapping. */
const otherThan = (id: number): Gen<number> => map(int(1, 2), (step) => ((id - 1 + step) % 3) + 1)

/**
 * standing's case refused by `withdrawal`, its values drawn. The build, one transaction: two chains of key k, their L1s
 * a1 and b1 apart, of values w and 1 - w, and a block of b1, which no mark lifts, so k has the one value w. Deleting the
 * block, or inserting a mark on b1, gives k the value 1 - w too, and the key is broken.
 */
const standingLifted =
	(withdrawal: Extract<Withdrawal, "deletes" | "mark">): Gen<Case> =>
	(s) => {
		const k = s.draw(int(1, 2))
		const a1 = s.draw(idGen)
		const b1 = s.draw(otherThan(a1))
		const w = s.draw(valueGen)
		const chain = (first: number, value: number): Op => ({
			kind: "chain",
			k,
			ids: [first, s.draw(idGen), s.draw(idGen)],
			values: [value, s.draw(valueGen), s.draw(valueGen)]
		})
		return {
			shape: "standing",
			history: [
				[chain(a1, w), chain(b1, 1 - w), { kind: "block", id: b1 }],
				withdrawal === "mark"
					? [{ kind: "mark", id: s.draw(int(1, 2)), up: b1 }]
					: [{ kind: "delete", table: "N", id: b1 }]
			]
		}
	}

/**
 * lifted's case refused by `withdrawal`, its values drawn. The build, one transaction: a chain of key k, its L1 a1 the
 * only L1 of k, so k is a key of a path and of an unheld L1; under `unmark`, a block of a1 too and a mark lifting it.
 * Inserting a block of a1, or deleting the mark, holds a1 out of the target, and the key of the path is contained in
 * none.
 */
const liftedWithdrawn =
	(withdrawal: Extract<Withdrawal, "block" | "unmark">): Gen<Case> =>
	(s) => {
		const k = s.draw(int(1, 2))
		const a1 = s.draw(idGen)
		const mark = s.draw(int(1, 2))
		const chain: Op = {
			kind: "chain",
			k,
			ids: [a1, s.draw(idGen), s.draw(idGen)],
			values: [s.draw(valueGen), s.draw(valueGen), s.draw(valueGen)]
		}
		return {
			shape: "lifted",
			history:
				withdrawal === "block"
					? [[chain], [{ kind: "block", id: a1 }]]
					: [
							[chain, { kind: "block", id: a1 }, { kind: "mark", id: mark, up: a1 }],
							[{ kind: "delete", table: "M", id: mark }]
						]
		}
	}

/**
 * budget's case refused by a block deleted alone, its values drawn: a chain of key k whose L1 a1 is of value 0 and whose
 * L2 a2, its only one, is under a block, so a1 is rate-paced and out of Limited; then the block deleted, which makes a2
 * paceless and a1 no longer rate-paced, and its value 0 breaks the check.
 */
const budgetUnblocked: Gen<Case> = (s) => {
	const k = s.draw(int(1, 2))
	const [a1, a2, a3] = [s.draw(idGen), s.draw(idGen), s.draw(idGen)]
	return {
		shape: "budget",
		history: [
			[
				{ kind: "chain", k, ids: [a1, a2, a3], values: [0, s.draw(valueGen), s.draw(valueGen)] },
				{ kind: "block", id: a2 }
			],
			[{ kind: "delete", table: "N", id: a2 }]
		]
	}
}

/**
 * budget's case refused by an L2 inserted under an L1 that stood, its values drawn: a chain of key k whose L1 a1 is of
 * value 0 and whose L2 a2, its only one, is under a block, so a1 is rate-paced and out of Limited; then a chain at a1
 * again, which inserts no L1 and an L2 b2 under it no block marks, a served insert of a relation under two negations, so
 * a1 is paceless, no longer rate-paced, and its value 0 breaks the check.
 */
const budgetPaced: Gen<Case> = (s) => {
	const k = s.draw(int(1, 2))
	const [a1, a2, a3] = [s.draw(idGen), s.draw(idGen), s.draw(idGen)]
	return {
		shape: "budget",
		history: [
			[
				{ kind: "chain", k, ids: [a1, a2, a3], values: [0, s.draw(valueGen), s.draw(valueGen)] },
				{ kind: "block", id: a2 }
			],
			[
				{
					kind: "chain",
					k,
					ids: [a1, s.draw(otherThan(a2)), s.draw(idGen)],
					values: [s.draw(valueGen), s.draw(valueGen), s.draw(valueGen)]
				}
			]
		]
	}
}

/**
 * The withdrawals that refuse a shape's rule, each with the case constructed to reach its refusal. A key's rule is
 * broken only by facts added: under standing's negation of a negation, deleting a block adds the facts it held out, and
 * a mark inserted does too. lifted's containment is refused by every fact its target holds a key by withdrawn while its
 * source keeps the key: a block inserted, or a mark deleted that lets a block stand again. budget's check is broken by
 * a block deleted under three negations, and by an L2 a served chain adds under an L1 that stood, under two.
 */
const withdrawalsOf = (
	shape: JudgedShape
): NonEmptyReadonlyArray<readonly [Withdrawal, Gen<Case>]> => {
	switch (shape) {
		case "standing":
			return [
				["deletes", standingLifted("deletes")],
				["mark", standingLifted("mark")]
			]
		case "lifted":
			return [
				["block", liftedWithdrawn("block")],
				["unmark", liftedWithdrawn("unmark")]
			]
		case "budget":
			return [
				["deletes", budgetUnblocked],
				["pace", budgetPaced]
			]
	}
}

/**
 * Each refusal a shape's withdrawals reach, with the case constructed to reach it, which a witness whose turn aims at
 * the refusal draws (aimed).
 */
export const aimsOf = (
	shape: JudgedShape
): ReadonlyArray<readonly [EquivalenceFeature, Gen<Case>]> =>
	Arr.map(
		withdrawalsOf(shape),
		([withdrawal, constructed]) => [refusedAfter[withdrawal], constructed] as const
	)

/**
 * Whether each write removes a row, a delete's, an unwind's, or a link's replacement, its row deleted and the new one
 * inserted: which a closed relation loses only in a data step (data-step.ts asDataStep).
 */
const removes: { readonly [K in Op["kind"]]: boolean } = {
	chain: false,
	mark: false,
	block: false,
	delete: true,
	unwind: true,
	relink: true,
	revalue: true
}

/** The statements of one write on `seat`. */
const statementsOf = (seat: Seat, op: Op): ReadonlyArray<string> => {
	const t = (r: Table) => seat.table(r)
	const c = (r: Table, f: string) => seat.column(r, f)
	const insertLink = (r: Link, id: number, up: number, value: number) =>
		`INSERT INTO ${t(r)} (${c(r, "id")}, ${c(r, "up")}, ${c(r, "v")}) VALUES (${id}, ${up}, ${value}) ON CONFLICT DO NOTHING`
	const remove = (r: Table, id: number) => `DELETE FROM ${t(r)} WHERE ${c(r, "id")} = ${id}`
	/**
	 * The link `id` of `r` replaced by one of parent `up` and value `value`, each over the deleted row `"gone"`: a link is
	 * immutable, its table refusing every UPDATE that changes a row (physical/ddl/immutable.ts), so a changed link is its
	 * row deleted and the new one inserted, in one statement.
	 */
	const replaced = (r: Link, id: number, up: string, value: string) =>
		`WITH "gone" AS (DELETE FROM ${t(r)} WHERE ${c(r, "id")} = ${id} RETURNING ${c(r, "id")}, ${c(r, "up")}, ${c(r, "v")}) INSERT INTO ${t(r)} (${c(r, "id")}, ${c(r, "up")}, ${c(r, "v")}) SELECT "gone".${c(r, "id")}, ${up}, ${value} FROM "gone"`
	switch (op.kind) {
		case "chain":
			return [
				insertLink("L1", op.ids[0], op.k, op.values[0]),
				insertLink("L2", op.ids[1], op.ids[0], op.values[1]),
				insertLink("L3", op.ids[2], op.ids[1], op.values[2])
			]
		case "mark":
			return [
				`INSERT INTO ${t("M")} (${c("M", "id")}, ${c("M", "up")}) VALUES (${op.id}, ${op.up}) ON CONFLICT DO NOTHING`
			]
		case "block":
			return [`INSERT INTO ${t("N")} (${c("N", "id")}) VALUES (${op.id}) ON CONFLICT DO NOTHING`]
		case "delete":
			return [remove(op.table, op.id)]
		case "unwind": {
			const lower = lowerOf(op.upper)
			return [remove(op.upper, op.id), `DELETE FROM ${t(lower)} WHERE ${c(lower, "up")} = ${op.id}`]
		}
		case "relink":
			return [replaced(op.table, op.id, `${op.up}`, `"gone".${c(op.table, "v")}`)]
		case "revalue":
			return [replaced(op.table, op.id, `"gone".${c(op.table, "up")}`, `${op.value}`)]
	}
}

/**
 * A shape installed: its seat, its rule's law, that law's whole violation query lowered by the oracle baseline, and its
 * check over every row, the judge's statements over the transaction that writes every row (deploy/snapshot/violation.ts
 * lawChecks), each a test of the state, printed.
 */
export interface Installed {
	readonly shape: Shape
	readonly seat: Seat
	readonly law: LawId
	readonly whole: string
	readonly everyRow: string
}

/** Installs `shape` through its first migration, its rule's law the one rule over a query its triggers discharge. */
/** Each shape's schema installed once per member (fin/installed.ts seatTemplate), where each search installed its shape. */
export const seedTemplates: { readonly [S in Shape]: SeatTemplate } = {
	titles: seatTemplate(import.meta, schemaOf("titles", "Seed_titles"), "rule_seed_titles"),
	viewed: seatTemplate(import.meta, schemaOf("viewed", "Seed_viewed"), "rule_seed_viewed"),
	deep: seatTemplate(import.meta, schemaOf("deep", "Seed_deep"), "rule_seed_deep"),
	key: seatTemplate(import.meta, schemaOf("key", "Seed_key"), "rule_seed_key"),
	tagged: seatTemplate(import.meta, schemaOf("tagged", "Seed_tagged"), "rule_seed_tagged"),
	standing: seatTemplate(import.meta, schemaOf("standing", "Seed_standing"), "rule_seed_standing"),
	lifted: seatTemplate(import.meta, schemaOf("lifted", "Seed_lifted"), "rule_seed_lifted"),
	budget: seatTemplate(import.meta, schemaOf("budget", "Seed_budget"), "rule_seed_budget")
}

/** A case's shape over its clone of the shape's template: its seat, its one rule's law, and the rule's whole check. */
export const installedIn = (taken: SeatCase, shape: Shape) =>
	Effect.gen(function* () {
		const seat = yield* seatIn(taken, RELATIONS, `rule_seed_${shape}`)
		const installation = taken.value.installation
		const [rule, ...others] = installation.laws.rules
		assert.ok(rule !== undefined && others.length === 0, `${shape}: one rule held by triggers`)
		const check = defined(
			Arr.findFirst(baselineRuleChecks(installation), (c) => c.law === rule.law.id).pipe(
				Option.getOrUndefined
			),
			`${shape}: the rule's whole check`
		)
		const everyRow = defined(
			Arr.findFirst(lawChecks(installation).rules, (c) => c.law === rule.law.id).pipe(
				Option.getOrUndefined
			),
			`${shape}: the rule's check over every row`
		)
		return {
			shape,
			seat,
			law: rule.law.id,
			whole: `SELECT EXISTS (${printStatement(check.query)})`,
			everyRow: foundQueryOf(everyRow.query)
		} satisfies Installed
	})
/** Every law a refusal's constraint serves, through the installation's constraint map: none for another table's. */
const refusedLaws = (
	installation: Installation,
	fields: { readonly table: Option.Option<string>; readonly constraint: string | undefined }
): ReadonlyArray<LawId> => {
	if (Option.isNone(fields.table) || fields.constraint === undefined) {
		return []
	}
	const table = fields.table.value
	const owner = Arr.findFirst(RELATIONS, (r) => installation.names.relation(r).name === table)
	return Option.isNone(owner)
		? []
		: (lawsOfConstraint(
				installation.constraintToLaw,
				{ kind: "table", name: installation.names.relation(owner.value).name },
				fields.constraint
			) ?? [])
}

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

export type EquivalenceFeature =
	| "committed"
	| `refused by ${JudgedShape}`
	| "refused once rows were deleted one at a time, and nothing else"
	| "refused once a block was inserted"
	| "refused once a mark was inserted, and nothing else"
	| "refused once a mark was deleted, and nothing else"
	| "refused once an L2 was added under an L1 that stood, and nothing else"

/** Whether the first cell of the first row is true. */
const truth = (rows: ReadonlyArray<ReadonlyArray<unknown>>): boolean => rows[0]?.[0] === true

/**
 * One drawn history on its shape's seat, from empty: each transaction judged by the rule's whole check before its
 * triggers run, and committed exactly when the check finds nothing, one that removes a row a data step (`removes`).
 */
export const judgeHistory = (
	installed: Installed,
	c: Case,
	note: (f: EquivalenceFeature) => void
) =>
	Effect.gen(function* () {
		const { seat } = installed
		const shape = c.shape
		const session = seat.session
		if (shape !== "lifted") {
			assert.deepEqual(
				Arr.filter(deltasOf(seat, "N"), (d) => Arr.contains(d.columns, countColumn)),
				[],
				`${shape}: no capture writes the rows N gains, which the rule reads under an odd number of negations, so a block inserted only holds facts out`
			)
		}
		/** The L1s that stand, by id, as the committed transactions leave them. */
		const firsts = new Set<number>()
		for (const [at, ops] of c.history.entries()) {
			const written = Arr.flatMap(ops, (op) => statementsOf(seat, op))
			/** A transaction that removes a closed relation's rows is a data step, inside the bracket a migration's runner
			 * sends (data-step.ts dataStepOf), whose checks run after the state it leaves is read. */
			const bracket = Arr.some(ops, (op) => removes[op.kind])
				? dataStepOf(seat.installed.installation)
				: { before: [], after: [] }
			const where = `transaction ${at} of ${Formatter.format(c)}`
			yield* session.begin
			for (const sql of [...bracket.before, ...written]) {
				yield* Effect.onError(session.query(sql, []), () => Effect.ignore(session.rollback))
			}
			const judged = yield* Effect.onError(session.values(installed.whole, []), () =>
				Effect.ignore(session.rollback)
			)
			const broken = truth(judged)
			const checked = yield* Effect.onError(session.values(installed.everyRow, []), () =>
				Effect.ignore(session.rollback)
			)
			if (truth(checked) !== broken) {
				yield* Effect.ignore(session.rollback)
				return yield* new Disagreed({
					message: `the check over every row finds ${truth(checked) ? "a row" : "none"} where the whole check finds ${broken ? "the rule broken" : "nothing"}, ${where}`
				})
			}
			/** The data step's bracket's checks, the judge and then the installation's re-check: a step that breaks the rule
			 * is refused there, never past it. */
			const bracketed = yield* firstRefusalOf(bracket.after, (sql) => session.query(sql, []))
			const refused = Option.isSome(bracketed)
				? bracketed
				: yield* refusalOf(session.query("SET CONSTRAINTS ALL IMMEDIATE", []))
			if (Option.isNone(refused)) {
				if (broken) {
					yield* Effect.ignore(session.rollback)
					return yield* new Disagreed({
						message: `the triggers accepted a state the whole check finds broken, ${where}`
					})
				}
				yield* session.commit
				note("committed")
				for (const op of ops) {
					if (op.kind === "chain") {
						firsts.add(op.ids[0])
					}
					if (
						(op.kind === "delete" || op.kind === "unwind") &&
						(op.kind === "unwind" ? op.upper === "L1" : op.table === "L1")
					) {
						firsts.delete(op.id)
					}
				}
				continue
			}
			yield* session.rollback
			const fields = refused.value
			const byJudge =
				fields.code === codeOf(shape) &&
				Arr.contains(refusedLaws(seat.installed.installation, fields), installed.law)
			/** Refused under the rule's law: at COMMIT's checks by the judge; in a data step's bracket by the judge, where its
			 * rows reach what the judge reads, or by the re-check, where its removals of closed rows alone break the rule. */
			const refusedAsLaw = Option.isNone(bracketed)
				? byJudge
				: byJudge || refusedByRecheck(fields, installed.law)
			if (!broken || !refusedAsLaw) {
				return yield* new Disagreed({
					message: `refused ${Option.isSome(bracketed) ? "in the data step's bracket " : ""}by ${fields.code} ${fields.constraint ?? "naming no constraint"} where the whole check finds ${broken ? "the rule broken" : "nothing"}, its law ${installed.law}, ${where}`
				})
			}
			note(`refused by ${shape}`)
			if (Arr.every(ops, (op) => op.kind === "delete")) {
				note("refused once rows were deleted one at a time, and nothing else")
			}
			if (Arr.some(ops, (op) => op.kind === "block")) {
				note("refused once a block was inserted")
			}
			if (Arr.every(ops, (op) => op.kind === "mark")) {
				note("refused once a mark was inserted, and nothing else")
			}
			if (Arr.every(ops, (op) => op.kind === "delete" && op.table === "M")) {
				note("refused once a mark was deleted, and nothing else")
			}
			if (Arr.every(ops, (op) => op.kind === "chain" && firsts.has(op.ids[0]))) {
				note("refused once an L2 was added under an L1 that stood, and nothing else")
			}
		}
	})

/**
 * The rows of keys `from` to `to`, each a chain of value 1, ids ten times its key plus 1 to 6, two marks and a block
 * of no link (id ten times the key plus 6), inserted by
 * one statement per table. The block holds no link out, so every rule reads the state as it would without it; it is
 * stored so that N's key index spans pages as every table's does: PostgreSQL 19 takes a SIRead lock on a whole B-tree
 * that holds no entry (nbtsearch.c _bt_first: "the index is completely empty. Lock relation because nothing finer to
 * lock exists"), so over an empty N every probe of a block, bounded by its key or not, would lock N's key index whole.
 */
const clusterSql = (seat: Seat, from: number, to: number): ReadonlyArray<string> => {
	const t = (r: Table) => seat.table(r)
	const c = (r: Table, f: string) => seat.column(r, f)
	const keys = `generate_series(${from}, ${to}) AS g(k)`
	const link = (r: Link, offset: number, up: string) =>
		`INSERT INTO ${t(r)} (${c(r, "id")}, ${c(r, "up")}, ${c(r, "v")}) SELECT k * 10 + ${offset}, ${up}, 1 FROM ${keys}`
	return [
		link("L1", 1, "k"),
		link("L2", 2, "k * 10 + 1"),
		link("L3", 3, "k * 10 + 2"),
		`INSERT INTO ${t("M")} (${c("M", "id")}, ${c("M", "up")}) SELECT k * 10 + 4, k * 10 + 2 FROM ${keys}`,
		`INSERT INTO ${t("M")} (${c("M", "id")}, ${c("M", "up")}) SELECT k * 10 + 5, k * 10 + 1 FROM ${keys}`,
		`INSERT INTO ${t("N")} (${c("N", "id")}) SELECT k * 10 + 6 FROM ${keys}`
	]
}

/**
 * The key a locality case's served write founds beside the drawn key `k`: past every key either template stores, so
 * the write adds rows of a new key alone, as every served write of the schema's closed relations does, never rewriting
 * or removing a stored one, which only a data step does, whose bracket's re-check judges it whole. The judge runs on the
 * rows a served write adds, and that is where its work is measured.
 */
const foundedKey = (k: number): number => localitySizes.many + k

/**
 * The served write a locality case of `shape` measures: key `k`'s chain, its marks and its block, founded as every
 * stored key's is (`clusterSql`); and for budget, whose judge reads an L1 only where its value is not 1 (Budgeted's
 * check, a selection of the reader of L1's added rows), an L1 of value 2 beside it, under no L2, so rate-paced and the
 * write lawful, which the judge reads.
 */
const foundingSql = (seat: Seat, shape: Shape, k: number): ReadonlyArray<string> => [
	...clusterSql(seat, k, k),
	...(shape === "budget"
		? [
				`INSERT INTO ${seat.table("L1")} (${seat.column("L1", "id")}, ${seat.column("L1", "up")}, ${seat.column("L1", "v")}) VALUES (${k * 10 + 7}, ${k}, 2)`
			]
		: [])
]

/** The tables a locality case measures the probes of: each a rule of `seat` reads, in the chain's order. */
export const touchedOf = (seat: Seat): ReadonlyArray<Table> => {
	const read = new Set<string>(
		Arr.flatMap(seat.installed.installation.laws.rules, (rule) =>
			Arr.map(rule.tables, (t) => t.relation.name)
		)
	)
	return Arr.filter(["L1", "L2", "L3", "M", "N"] as const, (t) => read.has(t))
}

/** A delta a capture writes: its table of pg_temp and its columns, the relation's columns by name. */
interface Delta {
	readonly name: string
	readonly columns: ReadonlyArray<string>
}

/** The deltas `table`'s capture writes (physical/ddl/rules.ts addRules), deduplicated by name. */
const deltasOf = (seat: Seat, table: Table): ReadonlyArray<Delta> =>
	Arr.dedupeWith(capturedDeltasOf(seat.installed.installation, table), (a, b) => a.name === b.name)

/**
 * Every probe of the judge over `table`'s rows, as the installation creates them: each statement the judge tests a rule
 * by that reads a delta `table`'s capture writes (physical/ddl/rules.ts addRules).
 */
const probesOn = (seat: Seat, table: Table): ReadonlyArray<JudgedStatement> => {
	const deltas = deltasOf(seat, table)
	return Arr.flatMap(judgedDeltaReadsOf(seat.installed.installation), (r) =>
		Arr.some(deltas, (d) => r.deltas.has(d.name)) ? [r.statement] : []
	)
}

/** What one touch of a row costs: the rows each probe reads, and the SIRead locks its triggers take, by type and relation. */
interface Footprint {
	readonly rows: ReadonlyArray<number>
	readonly locks: ReadonlyArray<string>
}

/** The integer cell at `at` of a row. */
const intCell = (row: ReadonlyArray<unknown>, at: number): number => {
	const cell = row[at]
	return typeof cell === "number" ? cell : assert.fail(`cell ${at} is an integer`)
}

/** The text cell at `at` of a row. */
const textCell = (row: ReadonlyArray<unknown>, at: number): string => {
	const cell = row[at]
	return typeof cell === "string" ? cell : assert.fail(`cell ${at} is text`)
}

/**
 * The SIRead locks the transaction open on `session` holds, by lock type and relation: its own, never a committed
 * transaction's that PostgreSQL keeps for a concurrent one.
 */
const siReadLocks = (session: RawSession) =>
	Effect.map(
		session.values(
			"SELECT l.locktype, coalesce(l.relation::regclass::text, ''), count(*)::int FROM pg_catalog.pg_locks l WHERE l.mode = 'SIReadLock' AND l.virtualtransaction = (SELECT o.virtualtransaction FROM pg_catalog.pg_locks o WHERE o.pid = pg_catalog.pg_backend_pid() AND o.locktype = 'virtualxid' AND o.granted) GROUP BY 1, 2 ORDER BY 1, 2",
			[]
		),
		(rows) => Arr.map(rows, (r) => `${textCell(r, 0)} ${textCell(r, 1)} ×${intCell(r, 2)}`)
	)

/**
 * The footprint of the served write that founds key `k` (`foundedKey`, `foundingSql`) on table `table`'s probes,
 * on a fresh session, in two transactions rolled back, each writing the chain alike through the
 * captures, which fill the deltas as any served write's do. In the first, each probe of the judge over the table is
 * explained while the deltas hold the chain's rows, before the judge reads and deletes them (test/support/judge.ts
 * judgedPlans); in the second, SET CONSTRAINTS ALL IMMEDIATE runs the judge over them and the SIRead locks the
 * transaction holds are counted, the judge's alone, no explained read's.
 */
const footprintOf = (seat: Seat, shape: Shape, k: number, table: Table) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const session = yield* substrate.session({ ...ownerSession(), label: "rule seed locality" })
		yield* standUpJudge(session, seat.installed.installation)
		const write = foundingSql(seat, shape, foundedKey(k))
		/** `measured` after the founding write, in a transaction rolled back after it. */
		const touching = <A, E>(measured: Effect.Effect<A, E>) =>
			Effect.gen(function* () {
				yield* session.begin
				const value = yield* Effect.onError(
					Effect.gen(function* () {
						for (const sql of write) {
							yield* session.query(sql, [])
						}
						return yield* measured
					}),
					() => Effect.ignore(session.rollback)
				)
				yield* session.rollback
				return value
			})
		const judged = yield* touching(
			judgedPlans(
				(sql) => session.values(sql, []),
				seat.installed.installation,
				probesOn(seat, table)
			)
		)
		const locks = yield* touching(
			Effect.andThen(session.query("SET CONSTRAINTS ALL IMMEDIATE", []), siReadLocks(session))
		)
		return { rows: Arr.map(judged, (p) => scannedWork(p.plan)), locks } satisfies Footprint
	})

export type LocalityFeature = `${Shape} measured`

/**
 * One locality case: a shape, the keys it holds when first measured, 2,048, and when measured again, 1,024 more, and the
 * key it measures among the first. 1,024 keys more add pages, so a probe that read every key would read more rows and
 * lock more pages, or a relation, where a probe of the key reads its own.
 */
interface Locality {
	readonly shape: Shape
	readonly key: number
}

/** A locality case of one shape. */
export const localityGen =
	(shape: Shape): Gen<Locality> =>
	(s) => ({ shape, key: s.draw(int(1, localitySizes.few)) })

/**
 * The keys a locality case's shape holds stored, a template's: 2,048, then half as many again, every key's
 * rows lawful (`clusterSql`).
 */
const localitySizes = { few: 2048, many: 3072 } as const

/**
 * Each shape's schema installed with its first `keys` keys committed through the captures once per member, judged at
 * their COMMIT, then each table analyzed: the seat a locality case measures one key's footprint on. A judge that reads
 * every key's rows, a kill's, judges every loaded row against every key at that COMMIT, once a member.
 */
const localityTemplate = (shape: Shape, keys: number): SeatTemplate =>
	seededSeatTemplate(
		import.meta,
		schemaOf(shape, `Seed_${shape}`),
		RELATIONS,
		`rule_seed_${shape}_${keys}`,
		(seat) =>
			Effect.gen(function* () {
				yield* standUpJudge(seat.session, seat.installed.installation)
				yield* seat.session.begin
				for (const sql of clusterSql(seat, 1, keys)) {
					yield* seat.session.query(sql, [])
				}
				yield* seat.session.commit
				for (const r of RELATIONS) {
					yield* seat.session.query(`ANALYZE ${seat.table(r)}`, [])
				}
			})
	)

/** Each shape's locality templates, by the keys they hold. */
const localityPair = (shape: Shape) => ({
	few: localityTemplate(shape, localitySizes.few),
	many: localityTemplate(shape, localitySizes.many)
})

export const localityTemplates: {
	readonly [S in Shape]: { readonly few: SeatTemplate; readonly many: SeatTemplate }
} = {
	titles: localityPair("titles"),
	viewed: localityPair("viewed"),
	deep: localityPair("deep"),
	key: localityPair("key"),
	tagged: localityPair("tagged"),
	standing: localityPair("standing"),
	lifted: localityPair("lifted"),
	budget: localityPair("budget")
}

/**
 * Every footprint of key `k` on `seat`, beside the keys its template committed (localityTemplates), each measured on a
 * session of its own that closes once it is read.
 */
export const footprints = (seat: Seat, shape: Shape, k: number) =>
	Effect.forEach(touchedOf(seat), (table) => Effect.scoped(footprintOf(seat, shape, k, table)))

/**
 * The refusals and commits a shape's search must reach: every shape commits, is refused by its rule, and is refused by
 * each withdrawal that can refuse it (withdrawalsOf), a constructed case reaching each.
 */
export const requiredOf = (shape: JudgedShape): NonEmptyReadonlyArray<EquivalenceFeature> => [
	"committed",
	`refused by ${shape}`,
	...Arr.map(withdrawalsOf(shape), ([withdrawal]) => refusedAfter[withdrawal])
]
