/** What the properties of rule-seeding.test.ts read: each shape's schema and template, its cases and aims, and its judges. */
import { type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert, defined } from "@bjornpagen/testing/assert"
import {
	array,
	boolean,
	element,
	type Gen,
	int,
	map,
	subset,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Data, Effect, Formatter, Option, String as Str } from "effect"
import { parsePlan, rowsRead } from "#bench/harness/explain.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { type LawId } from "#compiler/core/ids.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { baselineRuleChecks, lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { constraintLaw } from "#compiler/ir/products.ts"
import { countColumn } from "#compiler/physical/ddl/rules.ts"
import { type Installation } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, key, on, relation, schema } from "#compiler/public/schema.ts"
import { type PlStatement } from "#compiler/sql/ast.ts"
import { printStatement } from "#compiler/sql/print.ts"
import {
	cleared,
	type Seat,
	type SeatCase,
	type SeatTemplate,
	seatIn,
	seatTemplate
} from "#test/pg/fin/installed.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	foundQueryOf,
	type JudgedStatement,
	judgedStatementsOf,
	plannedQueryOf
} from "#test/support/judge.ts"
import { refusalOf } from "#test/support/substrate.ts"
import { type RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

const L1 = relation("L1", { id: pg.integer, up: pg.integer, v: pg.integer }, ["id"])
const L2 = relation("L2", { id: pg.integer, up: pg.integer, v: pg.integer }, ["id"])
const L3 = relation("L3", { id: pg.integer, up: pg.integer, v: pg.integer }, ["id"])
const M = relation("M", { id: pg.integer, up: pg.integer }, ["id"])
const N = relation("N", { id: pg.integer }, ["id"])

export const RELATIONS = ["L1", "L2", "L3", "M", "N"] as const
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
		Base,
		`${name}_1`,
		[Listed, Matched],
		[contained(on(Listed, "k"), on(Matched, "k"))]
	)
}

/**
 * viewed: titles over a materialized path, a derived relation its definitions read, which the rule's whole check reads
 * on its definition, live, as its triggers do, never through its view, which no write refreshes.
 */
const viewed = (name: string) => {
	const { Base } = base(name)
	const Path = derived.materialized(
		"Path",
		query(Base).rule((r) => {
			const { id: x1, up: k } = v(L1, "first")
			const { id: x2 } = v(L2, "second")
			return r.match(L1, { id: x1, up: k }).match(L2, { id: x2, up: x1 }).find({ k, x2 })
		})
	)
	const Mid = schema.extend(Base, `${name}_1`, [Path], [])
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
		Mid,
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
		Base,
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
	return schema.extend(Base, `${name}_1`, [Valued], [key(on(Valued, "k"))])
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
	return schema.extend(Base, `${name}_1`, [Tagged], [key(on(Tagged, "k", "tag"))])
}

export const shapes = ["titles", "viewed", "deep", "key", "tagged"] as const
export type Shape = (typeof shapes)[number]

/** What a shape's rule is: a containment, or a key. */
const ruleOf = {
	titles: "contained",
	viewed: "contained",
	deep: "contained",
	key: "key",
	tagged: "key"
} as const satisfies Record<Shape, "contained" | "key">

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
	}
}

/** The SQLSTATE a shape's rule is refused under: a containment's, or a key's. */
const codeOf = (shape: Shape): string => (ruleOf[shape] === "key" ? "23505" : "23503")

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

interface Case {
	readonly shape: Shape
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
	(shape: Shape): Gen<Case> =>
	(s) => ({
		shape,
		history: s.draw(array(array(opGen, { min: 1, max: 3 }), { min: 3, max: 10 }))
	})

/** How a constructed case's last transaction removes rows: single-row deletes alone, or one unwind alone. */
type Removal = "deletes" | "unwind"

/**
 * How a constructed case's last transaction withdraws facts: by removing rows, or by inserting blocks alone, which
 * withdraw the facts a negation of N admitted.
 */
type Withdrawal = Removal | "block"

/** The refusal a constructed case reaches by its withdrawal. */
const refusedAfter = {
	deletes: "refused once rows were deleted one at a time, and nothing else",
	unwind: "refused once a link and its children were deleted at once, and nothing else",
	block: "refused once a block was inserted"
} as const satisfies Record<Withdrawal, EquivalenceFeature>

/** An id of 1 to 3 other than `id`: `id` moved on by one or two, wrapping. */
const otherThan = (id: number): Gen<number> => map(int(1, 2), (step) => ((id - 1 + step) % 3) + 1)

/**
 * titles' and viewed's case refused by `withdrawal`, its values drawn. The build, one transaction: a mark on the L2 a2 of
 * a path (k, a2), which a block of a2 and an L3 of value 0 hold out of the target, and a second path (k, b2), b2 another
 * L2, that holds k in the target, so the state is lawful. The withdrawal takes the second path's L2, or its L1 where
 * that is another L1 than a1: deleted alone, or with the link below it, or unwound. The marked path stays and no path
 * of k stays in the target, so the whole check finds the rule broken.
 */
const pathsWithdrawn =
	(shape: Shape, withdrawal: Removal): Gen<Case> =>
	(s) => {
		const k = s.draw(int(1, 2))
		const [a1, a2, a3] = [s.draw(idGen), s.draw(idGen), s.draw(idGen)]
		const upper = s.draw(element(UPPERS))
		const b1 = upper === "L1" ? s.draw(otherThan(a1)) : s.draw(idGen)
		const b2 = s.draw(otherThan(a2))
		const b3 = s.draw(idGen)
		const build: ReadonlyArray<Op> = [
			{ kind: "chain", k, ids: [a1, a2, a3], values: [s.draw(valueGen), s.draw(valueGen), 0] },
			{ kind: "mark", id: s.draw(int(1, 2)), up: a2 },
			{ kind: "block", id: a2 },
			{
				kind: "chain",
				k,
				ids: [b1, b2, b3],
				values: [s.draw(valueGen), s.draw(valueGen), s.draw(valueGen)]
			}
		]
		const id = upper === "L1" ? b1 : b2
		const withdrawn = (): ReadonlyArray<Op> => {
			const below: ReadonlyArray<Op> = s.draw(boolean)
				? [{ kind: "delete", table: lowerOf(upper), id: upper === "L1" ? b2 : b3 }]
				: []
			return [{ kind: "delete", table: upper, id }, ...below]
		}
		return {
			shape,
			history: [build, withdrawal === "unwind" ? [{ kind: "unwind", upper, id }] : withdrawn()]
		}
	}

/**
 * deep's case refused by `withdrawal`, its values drawn. The build, one transaction: a chain of key k whose L1 a1 is of
 * value 0, out of the target's second arm, and a mark on a1, so k is a source fact through the first arm; the chain's
 * L3 a3 holds k in the target by the first arm where it is of value 1 (a block of a3 holding it out of the third, if
 * drawn) and by the third where it is of value 0, so the state is lawful. The withdrawal takes the chain's L2 a2, its
 * L3 or both, deleted one at a time, or unwinds a2 with its L3: the mark's L1 stays and no arm of the target holds k.
 */
const deepWithdrawn =
	(withdrawal: Removal): Gen<Case> =>
	(s) => {
		const k = s.draw(int(1, 2))
		const [a1, a2, a3] = [s.draw(idGen), s.draw(idGen), s.draw(idGen)]
		const last = s.draw(valueGen)
		const chain: Op = { kind: "chain", k, ids: [a1, a2, a3], values: [0, s.draw(valueGen), last] }
		const mark: Op = { kind: "mark", id: s.draw(int(1, 2)), up: a1 }
		const blocked: ReadonlyArray<Op> =
			last === 1 && s.draw(boolean) ? [{ kind: "block", id: a3 }] : []
		const deletes: ReadonlyArray<Op> = [
			{ kind: "delete", table: "L2", id: a2 },
			{ kind: "delete", table: "L3", id: a3 }
		]
		return {
			shape: "deep",
			history: [
				[chain, mark, ...blocked],
				withdrawal === "unwind"
					? [{ kind: "unwind", upper: "L2", id: a2 }]
					: s.draw(subset(deletes, { min: 1, max: 2 }))
			]
		}
	}

/**
 * titles' and viewed's case refused by a block, its values drawn: a mark on the L2 a2 of a path (k, a2), which only the
 * absence of a block of a2 holds in the target, its L3 of value 0; then a block of a2 alone.
 */
const pathBlocked =
	(shape: Shape): Gen<Case> =>
	(s) => {
		const k = s.draw(int(1, 2))
		const [a1, a2, a3] = [s.draw(idGen), s.draw(idGen), s.draw(idGen)]
		return {
			shape,
			history: [
				[
					{ kind: "chain", k, ids: [a1, a2, a3], values: [s.draw(valueGen), s.draw(valueGen), 0] },
					{ kind: "mark", id: s.draw(int(1, 2)), up: a2 }
				],
				[{ kind: "block", id: a2 }]
			]
		}
	}

/**
 * deep's case refused by blocks, its values drawn: a mark on the L1 a1 of a chain of key k whose L3 a3 is of value 0,
 * which holds k in the target by the third arm while no block of a3 stands, and by the second while a1 is of value 1
 * and no block of a1 stands; then blocks of a3 and, where a1 is of value 1, of a1 alone.
 */
const deepBlocked: Gen<Case> = (s) => {
	const k = s.draw(int(1, 2))
	const [a1, a2, a3] = [s.draw(idGen), s.draw(idGen), s.draw(idGen)]
	const first = s.draw(valueGen)
	const blocks: ReadonlyArray<Op> =
		first === 1 && a1 !== a3
			? [
					{ kind: "block", id: a1 },
					{ kind: "block", id: a3 }
				]
			: [{ kind: "block", id: a3 }]
	return {
		shape: "deep",
		history: [
			[
				{ kind: "chain", k, ids: [a1, a2, a3], values: [first, s.draw(valueGen), 0] },
				{ kind: "mark", id: s.draw(int(1, 2)), up: a1 }
			],
			blocks
		]
	}
}

/**
 * key's and tagged's case refused by deleting a block, its values drawn. The build, one transaction: a chain of key k
 * whose L1 and L3 are of value w and whose L2 of 1 - w is under a block of its L1 a1, so k has the one value w (under
 * tagged, w under each tag). Deleting the block gives k the value 1 - w through the side's second arm, which tags it as
 * the first does, and the key is broken.
 */
const blockWithdrawn =
	(shape: Extract<Shape, "key" | "tagged">): Gen<Case> =>
	(s) => {
		const k = s.draw(int(1, 2))
		const [a1, a2, a3] = [s.draw(idGen), s.draw(idGen), s.draw(idGen)]
		const w = s.draw(valueGen)
		return {
			shape,
			history: [
				[
					{ kind: "chain", k, ids: [a1, a2, a3], values: [w, 1 - w, w] },
					{ kind: "block", id: a1 }
				],
				[{ kind: "delete", table: "N", id: a1 }]
			]
		}
	}

/**
 * The withdrawals that refuse a shape's rule, each with the case constructed to reach its refusal. A containment is
 * refused by each, every fact its target holds a key by withdrawn while its source keeps the key. A key's rule is
 * broken only by facts added: deleting a block adds the facts it held out, and an unwind, which deletes links alone,
 * and an inserted block only withdraw facts, so they never refuse a key.
 */
const withdrawalsOf = (shape: Shape): NonEmptyReadonlyArray<readonly [Withdrawal, Gen<Case>]> => {
	switch (shape) {
		case "titles":
		case "viewed":
			return [
				["deletes", pathsWithdrawn(shape, "deletes")],
				["unwind", pathsWithdrawn(shape, "unwind")],
				["block", pathBlocked(shape)]
			]
		case "deep":
			return [
				["deletes", deepWithdrawn("deletes")],
				["unwind", deepWithdrawn("unwind")],
				["block", deepBlocked]
			]
		case "key":
		case "tagged":
			return [["deletes", blockWithdrawn(shape)]]
	}
}

/**
 * Each refusal a shape's withdrawals reach, with the case constructed to reach it, which a witness whose turn aims at
 * the refusal draws (aimed).
 */
export const aimsOf = (shape: Shape): ReadonlyArray<readonly [EquivalenceFeature, Gen<Case>]> =>
	Arr.map(
		withdrawalsOf(shape),
		([withdrawal, constructed]) => [refusedAfter[withdrawal], constructed] as const
	)

/** The statements of one write on `seat`. */
const statementsOf = (seat: Seat, op: Op): ReadonlyArray<string> => {
	const t = (r: Table) => seat.table(r)
	const c = (r: Table, f: string) => seat.column(r, f)
	const insertLink = (r: Link, id: number, up: number, value: number) =>
		`INSERT INTO ${t(r)} (${c(r, "id")}, ${c(r, "up")}, ${c(r, "v")}) VALUES (${id}, ${up}, ${value}) ON CONFLICT DO NOTHING`
	const remove = (r: Table, id: number) => `DELETE FROM ${t(r)} WHERE ${c(r, "id")} = ${id}`
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
			return [
				`UPDATE ${t(op.table)} SET ${c(op.table, "up")} = ${op.up} WHERE ${c(op.table, "id")} = ${op.id}`
			]
		case "revalue":
			return [
				`UPDATE ${t(op.table)} SET ${c(op.table, "v")} = ${op.value} WHERE ${c(op.table, "id")} = ${op.id}`
			]
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
	tagged: seatTemplate(import.meta, schemaOf("tagged", "Seed_tagged"), "rule_seed_tagged")
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
/** The law a refusal's trigger reports, through the installation's constraint map. */
const refusedLaw = (
	installation: Installation,
	fields: { readonly table: Option.Option<string>; readonly constraint: string | undefined }
): LawId | undefined => {
	if (Option.isNone(fields.table) || fields.constraint === undefined) {
		return undefined
	}
	const table = fields.table.value
	const owner = Arr.findFirst(RELATIONS, (r) => installation.names.relation(r).name === table)
	return Option.isNone(owner)
		? undefined
		: constraintLaw(
				installation.constraintToLaw,
				{ kind: "table", name: installation.names.relation(owner.value).name },
				fields.constraint
			)
}

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

export type EquivalenceFeature =
	| "committed"
	| `refused by ${Shape}`
	| "refused once a link and its children were deleted at once, and nothing else"
	| "refused once rows were deleted one at a time, and nothing else"
	| "refused once a block was inserted"
	| "committed a needed key no first target arm holds"

/** Whether the first cell of the first row is true. */
const truth = (rows: ReadonlyArray<ReadonlyArray<unknown>>): boolean => rows[0]?.[0] === true

/**
 * A key the source needs that the target's first arm holds none of, on `seat`: titles' marked paths no L3 of value 1
 * extends, and deep's marks no chain of three whose L3 is of value 1 reaches.
 */
const laterArmOnly = (seat: Seat, shape: Shape): string | undefined => {
	const t = (r: Table) => seat.table(r)
	const c = (r: Table, f: string) => seat.column(r, f)
	switch (shape) {
		case "titles":
		case "viewed":
			return `SELECT EXISTS (SELECT 1 FROM ${t("M")} m JOIN ${t("L2")} b ON b.${c("L2", "id")} = m.${c("M", "up")} JOIN ${t("L1")} a ON a.${c("L1", "id")} = b.${c("L2", "up")} WHERE NOT EXISTS (SELECT 1 FROM ${t("L1")} a2 JOIN ${t("L2")} b2 ON b2.${c("L2", "up")} = a2.${c("L1", "id")} JOIN ${t("L3")} z ON z.${c("L3", "up")} = b2.${c("L2", "id")} WHERE a2.${c("L1", "up")} = a.${c("L1", "up")} AND z.${c("L3", "v")} = 1))`
		case "deep":
			return `SELECT EXISTS (SELECT 1 FROM ${t("M")} m JOIN ${t("L1")} a ON a.${c("L1", "id")} = m.${c("M", "up")} WHERE NOT EXISTS (SELECT 1 FROM ${t("L1")} a2 JOIN ${t("L2")} b2 ON b2.${c("L2", "up")} = a2.${c("L1", "id")} JOIN ${t("L3")} z ON z.${c("L3", "up")} = b2.${c("L2", "id")} WHERE a2.${c("L1", "up")} = a.${c("L1", "up")} AND z.${c("L3", "v")} = 1))`
		case "key":
		case "tagged":
			return undefined
	}
}

/**
 * One drawn history on its shape's seat, from empty: each transaction judged by the rule's whole check before its
 * triggers run, and committed exactly when the check finds nothing.
 */
export const judgeHistory = (
	installed: Installed,
	c: Case,
	note: (f: EquivalenceFeature) => void
) =>
	Effect.gen(function* () {
		const { seat, shape } = installed
		const session = seat.session
		yield* cleared(seat, RELATIONS)
		for (const [at, ops] of c.history.entries()) {
			const statements = Arr.flatMap(ops, (op) => statementsOf(seat, op))
			const where = `transaction ${at} of ${Formatter.format(c)}`
			yield* session.begin
			for (const sql of statements) {
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
			const refused = yield* refusalOf(session.query("SET CONSTRAINTS ALL IMMEDIATE", []))
			if (Option.isNone(refused)) {
				if (broken) {
					yield* Effect.ignore(session.rollback)
					return yield* new Disagreed({
						message: `the triggers accepted a state the whole check finds broken, ${where}`
					})
				}
				const later = laterArmOnly(seat, shape)
				const found = later === undefined ? [] : yield* session.values(later, [])
				const needed = truth(found)
				yield* session.commit
				note("committed")
				if (needed) {
					note("committed a needed key no first target arm holds")
				}
				continue
			}
			yield* session.rollback
			const fields = refused.value
			const law = refusedLaw(seat.installed.installation, fields)
			if (!broken || fields.code !== codeOf(shape) || law !== installed.law) {
				return yield* new Disagreed({
					message: `refused by ${fields.code} ${fields.constraint ?? "naming no constraint"} where the whole check finds ${broken ? "the rule broken" : "nothing"}, ${where}`
				})
			}
			note(`refused by ${shape}`)
			if (Arr.every(ops, (op) => op.kind === "unwind")) {
				note("refused once a link and its children were deleted at once, and nothing else")
			}
			if (Arr.every(ops, (op) => op.kind === "delete")) {
				note("refused once rows were deleted one at a time, and nothing else")
			}
			if (Arr.some(ops, (op) => op.kind === "block")) {
				note("refused once a block was inserted")
			}
		}
	})

/** A key's base, ten times the key: its rows' ids are base + 1 to base + 5. */
const keyBase = (k: number): number => k * 10

/** The rows of keys `from` to `to`, each a chain of value 1 and two marks, inserted by one statement per table. */
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
		`INSERT INTO ${t("M")} (${c("M", "id")}, ${c("M", "up")}) SELECT k * 10 + 5, k * 10 + 1 FROM ${keys}`
	]
}

/** A row of key 1 a locality case touches: its table and id, a block of one of its links among them. */
interface Touched {
	readonly table: Table
	readonly id: number
	/** Whether the row is stored: a block is not, and is inserted and deleted again. */
	readonly stored: boolean
}

/** Each row of key `k` on a table `seat`'s rule reads, and a block of each of its links where it reads N. */
export const touchedOf = (seat: Seat, k: number): ReadonlyArray<Touched> => {
	const b = keyBase(k)
	const read = new Set<string>(
		Arr.flatMap(seat.installed.installation.laws.rules, (rule) =>
			Arr.map(rule.tables, (t) => t.relation.name)
		)
	)
	return Arr.filter<Touched>(
		[
			{ table: "L1", id: b + 1, stored: true },
			{ table: "L2", id: b + 2, stored: true },
			{ table: "L3", id: b + 3, stored: true },
			{ table: "M", id: b + 4, stored: true },
			{ table: "M", id: b + 5, stored: true },
			{ table: "N", id: b + 1, stored: false },
			{ table: "N", id: b + 2, stored: false },
			{ table: "N", id: b + 3, stored: false }
		],
		(t) => read.has(t.table)
	)
}

/** A delta a capture writes: its table of pg_temp and its columns, the relation's columns by name. */
interface Delta {
	readonly name: string
	readonly columns: ReadonlyArray<string>
}

/** The session tables with columns a capture's body creates, at any depth: its deltas. */
const deltasIn = (body: ReadonlyArray<PlStatement>): ReadonlyArray<Delta> =>
	Arr.flatMap(body, (s): ReadonlyArray<Delta> =>
		s.kind === "createSessionTable" && s.columns.length > 0
			? [{ name: s.name, columns: Arr.map(s.columns, (c) => c.name) }]
			: s.kind === "if"
				? [...Arr.flatMap(s.branches, (b) => deltasIn(b.body)), ...deltasIn(s.else)]
				: []
	)

/** The deltas `table`'s capture writes (physical/ddl/rules.ts addRules), deduplicated by name. */
const deltasOf = (seat: Seat, table: Table): ReadonlyArray<Delta> =>
	Arr.dedupeWith(
		deltasIn(bodyOf(seat.installed.installation, identifierOf(identity.ruleCapture(table)))),
		(a, b) => a.name === b.name
	)

/** The PL/pgSQL body of the installation's function named `name`. */
const bodyOf = (installation: Installation, name: string): ReadonlyArray<PlStatement> =>
	Arr.flatMap(installation.statements, (s) =>
		s.kind === "createFunction" && s.language === "plpgsql" && s.name.name === name
			? s.body.body
			: []
	)

/**
 * Every probe of the judge over `table`'s rows, as the installation creates them: each statement the judge tests a rule
 * by that reads a delta `table`'s capture writes (physical/ddl/rules.ts addRules).
 */
const probesOn = (seat: Seat, table: Table): ReadonlyArray<JudgedStatement> => {
	const deltas = deltasOf(seat, table)
	return Arr.filter(judgedStatementsOf(seat.installed.installation), (probe) => {
		const text = plannedQueryOf(probe)
		return Arr.some(deltas, (d) => Str.includes(`"pg_temp".${quoteIdent(d.name)}`)(text))
	})
}

/** The planner settings of a table large beside one key's rows (the header). */
const largeTables = [
	"SET enable_seqscan = off",
	"SET enable_bitmapscan = off",
	"SET enable_hashjoin = off",
	"SET enable_mergejoin = off",
	"SET enable_indexonlyscan = off"
] as const

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
 * The footprint of touching `touched`, on a fresh session planning for large tables, in one transaction rolled back. A
 * stored row stands in every delta of its table as it is stored: a statement of each event that writes no row runs the
 * captures, which make the session's deltas, and the row's image is copied into each, so the judge's region is the
 * row and the table is not written, which would move the row's index entries. A block is inserted and deleted again,
 * which the captures take, and its image put back on the side of news, which the delete cancelled there, so each side
 * holds it as each held it before the side of news was the transaction's net write. Then SET CONSTRAINTS ALL IMMEDIATE
 * runs the judge over the deltas; the SIRead locks the
 * transaction holds are counted; and each probe of the judge over the table is explained while the deltas hold the
 * row's images.
 */
const footprintOf = (seat: Seat, touched: Touched) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const session = yield* substrate.session({ ...ownerSession(), label: "rule seed locality" })
		for (const setting of largeTables) {
			yield* session.query(setting, [])
		}
		const table = touched.table
		const t = seat.table(table)
		const id = seat.column(table, "id")
		const write = touched.stored
			? [
					`INSERT INTO ${t} (${id}) SELECT ${touched.id} WHERE false`,
					`DELETE FROM ${t} WHERE false`,
					...Arr.map(deltasOf(seat, table), (d) => {
						const columns = Arr.join(Arr.map(d.columns, quoteIdent), ", ")
						const values = Arr.join(
							Arr.map(d.columns, (c) => (c === countColumn ? "1" : quoteIdent(c))),
							", "
						)
						return `INSERT INTO pg_temp.${quoteIdent(d.name)} (${columns}) SELECT ${values} FROM ${t} WHERE ${id} = ${touched.id}`
					})
				]
			: [
					`INSERT INTO ${t} (${id}) VALUES (${touched.id})`,
					`DELETE FROM ${t} WHERE ${id} = ${touched.id}`,
					...Arr.flatMap(deltasOf(seat, table), (d) =>
						Arr.contains(d.columns, countColumn)
							? [
									`INSERT INTO pg_temp.${quoteIdent(d.name)} (${Arr.join(Arr.map(d.columns, quoteIdent), ", ")}) SELECT ${Arr.join(
										Arr.map(d.columns, (c) =>
											c === countColumn
												? "1"
												: quoteIdent(c) === id
													? `${touched.id}`
													: assert.fail(`a block's delta holds ${c}`)
										),
										", "
									)}`
								]
							: []
					)
				]
		yield* session.begin
		const footprint = yield* Effect.onError(
			Effect.gen(function* () {
				for (const sql of write) {
					yield* session.query(sql, [])
				}
				yield* session.query("SET CONSTRAINTS ALL IMMEDIATE", [])
				const locks = yield* siReadLocks(session)
				const rows: Array<number> = []
				for (const probe of probesOn(seat, table)) {
					const explained = yield* session.values(
						`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SETTINGS, FORMAT JSON) ${plannedQueryOf(probe)}`,
						[]
					)
					rows.push(rowsRead(succeeded(parsePlan(explained[0]?.[0]), "one EXPLAIN plan").plan))
				}
				return { rows, locks } satisfies Footprint
			}),
			() => Effect.ignore(session.rollback)
		)
		yield* session.rollback
		return footprint
	})

export type LocalityFeature = `${Shape} measured`

/**
 * One locality case: a shape, the keys it holds when first measured, 250 to 400, and when measured again, 600 to 900
 * more, and the key it measures among the first. 250 keys' rows fill more than one heap page of every table, and 600
 * more add three, so a probe that read every key would read more rows and lock more pages, or a relation, where a
 * probe of the key reads its own.
 */
interface Locality {
	readonly shape: Shape
	readonly before: number
	readonly after: number
	readonly key: number
}

/** A locality case of one shape. */
export const localityGen =
	(shape: Shape): Gen<Locality> =>
	(s) => {
		const before = s.draw(int(250, 400))
		return {
			shape,
			before,
			after: s.draw(int(before + 600, before + 900)),
			key: s.draw(int(1, before))
		}
	}

/** Every footprint of key `k` on `seat` once keys `from` to `to` are loaded beside those it holds. */
export const footprints = (seat: Seat, k: number, from: number, to: number) =>
	Effect.gen(function* () {
		yield* seat.session.begin
		for (const sql of clusterSql(seat, from, to)) {
			yield* Effect.onError(seat.session.query(sql, []), () => Effect.ignore(seat.session.rollback))
		}
		yield* seat.session.commit
		for (const r of RELATIONS) {
			yield* seat.session.query(`ANALYZE ${seat.table(r)}`, [])
		}
		return yield* Effect.forEach(touchedOf(seat, k), (touched) => footprintOf(seat, touched))
	})

/**
 * The refusals and commits a shape's search must reach: every shape commits, is refused by its rule, and is refused by
 * each withdrawal that can refuse it (withdrawalsOf), a constructed case reaching each; the three shapes whose rule is
 * a containment also commit a key only a later arm of the target holds, which a key's side, no target of arms, never
 * has.
 */
export const requiredOf = (shape: Shape): NonEmptyReadonlyArray<EquivalenceFeature> => {
	const containment: ReadonlyArray<EquivalenceFeature> =
		ruleOf[shape] === "key" ? [] : ["committed a needed key no first target arm holds"]
	return [
		"committed",
		`refused by ${shape}`,
		...Arr.map(withdrawalsOf(shape), ([withdrawal]) => refusedAfter[withdrawal]),
		...containment
	]
}
