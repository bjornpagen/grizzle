/**
 * The seeding of a rule over a query's deferred triggers on PostgreSQL 19rc2: each trigger's probe is the rule's
 * violation restricted to the rows its write touched and those its chain reaches from them, so it judges exactly what
 * the rule's whole check judges, and reads only the rows of the touched row's key.
 *
 * The shapes are four schemas of link tables L1, L2 and L3, each row linked up to the one before it and L1's to its
 * key, a mark M on a link and a block N of one, each a downstream shape in miniature:
 *
 * - **titles**, edullm's LomObjectTitle: the keys whose L2 a mark names, through an imported path L1 ⋈ L2, are
 *   contained in the keys of a path an L3 of value 1 extends or no N blocks, a target of two arms, one negated;
 * - **viewed**: titles over a materialized derived relation Path = L1 ⋈ L2 at a level of its own, which both sides'
 *   definitions read: the whole check reads each side as its definition, live, each definition a query of its own
 *   (analysis/theory/query.ts violationQuery), and the triggers as its arms, every definition inlined, so the
 *   equivalence holds the one against the other; and neither reads Path's view, which no write refreshes;
 * - **deep**: a source of two arms, a mark on L1 or on an L2 of value 1, contained in a target of three, the first
 *   declared from its deepest link up, the second an L1 of value 1 no N blocks, the third a chain of three whose L3 no N
 *   blocks;
 * - **key**: a key over a side of three arms, each a key's value read off an L1, an L2 under an unblocked L1, or an L3
 *   at the end of the path.
 *
 * - **Equivalence:** one search per shape, each with the budget of its own, so a shape added takes none of another's;
 *   each case draws a history of direct SQL transactions at SERIALIZABLE over keys 1 and 2
 *   and ids 1 to 3: chains of three links, marks, blocks, deletes of one row or of a link and its children at once,
 *   and updates of a link's parent or value. Each transaction, before its triggers run, runs the rule's whole violation
 *   query, the one the migration that adds the rule runs over every row (deploy/snapshot/violation.ts lawChecks), read
 *   whole and never seeded: that oracle judges the state the transaction leaves. Then SET CONSTRAINTS ALL IMMEDIATE runs
 *   the triggers, and the transaction commits exactly when the oracle finds no violation, refused otherwise at that
 *   moment by SQLSTATE 23503 for a containment and 23505 for a key, naming a trigger the installation's constraint map
 *   maps to the rule.
 * - **Locality:** one search per shape, as for equivalence, each with the rotating budget the one search over every
 *   shape had and no steered phase, since every case of a shape's search measures that shape; each case draws a count
 *   of keys from 250 to 400 and one of them, and 600 to 900 keys more.
 *   The shape holds the first keys' rows, each key a chain of value 1 and two marks, then every key's. Each of the
 *   drawn key's rows on a table the rule reads, and a block of each of its links, is touched: in a transaction of its
 *   own the row is written (each column set to itself, a block inserted and deleted again), SET CONSTRAINTS ALL
 *   IMMEDIATE runs its triggers, and the SIRead locks the transaction holds are counted by lock type and relation, the
 *   transaction rolled back; then every probe of every rule function on its table is explained with its NEW and OLD at
 *   the row. The rows each probe reads, as EXPLAIN ANALYZE counts them, and the SIRead locks are the same beside every
 *   key as beside the first, and no SIRead lock is on a whole relation: an invariance, no time. The first keys' rows
 *   fill more than one heap page of every table and the rest three more, so a probe that read every key would read
 *   more rows and lock more pages, or a relation, where a probe of the key reads its own. Both measurements plan as
 *   PostgreSQL plans once every table is large beside one key's rows: no sequential, bitmap or index-only scan, no hash
 *   or merge join, the plans a table of a few rows makes cheapest and an index-only scan's locks follow the visibility
 *   map; a probe that can read a key's rows by index then does, and one that cannot reads every row all the same.
 *
 * Two refusals are required of the equivalence search because a probe's delete semantics live in them: a transaction
 * of single-row deletes alone refused, so only a delete's probe can have found the break, its touched row gone at
 * COMMIT and read as OLD's values in its place; and one that deletes a link and its children at once, so one tuple
 * loses rows from several matches and the relaxation order decides which probe withdraws it. A drawn history reaches
 * either rarely, as it does a refusal by an inserted block, so each has a case constructed to reach it, which a witness
 * runs where its turn aims at the refusal (aimedCase): a lawful build drawn on the case's tape, then the withdrawal,
 * which leaves a source fact its every target fact withdrawn (withdrawalsOf). A key is refused by single-row deletes
 * of a block alone, which adds the facts it held out, and never by an unwind or an inserted block, so its search
 * requires the first refusal only.
 *
 * Planted, each a patch of analysis/theory/query.ts, each red in the floor stream of the searches it names, so on every
 * seed. Under ~/.cache/grizzle-release/LAWQUERY/plants/: violation-stale-view.patch, the whole check reading a
 * materialized derived relation a definition reads through its view, fails viewed's install in both its searches; and
 * old-probe-filters-old.patch, a delete's probe reading its touched relation filtered to OLD's key rather than OLD's
 * values in its place, which finds nothing once the row is gone, fails every shape's equivalence search by a break the
 * triggers accept. Under ~/.cache/grizzle-release/RULESEED/plants/: rule-seed-only-outer.patch, readAs reading a side
 * as one union of its arms, so every probe meets the side its facts meet whole, a union PostgreSQL builds before any
 * term meets it, fails every shape's locality search; rule-seed-drops-chain-reach.patch, a relaxation that keeps every
 * other match of the arm, so a delete probe reads them as they stand and a transaction that deletes a link and its
 * children leaves no probe that reaches the key, fails titles', viewed's and deep's equivalence searches by a break the
 * triggers accept; and rule-seed-arm-split-drops-arm.patch, lacks reading the target's first arm alone, so a probe's
 * negation of the target misses a key a later arm holds, fails them by refusing a lawful state.
 */
import { drawn, explore, type Case as Search } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
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
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Data, Effect, Formatter, Option, String as Str } from "effect"
import { parsePlan, rowsRead } from "#bench/harness/explain.ts"
import { identifierOf } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { lawChecks } from "#compiler/deploy/snapshot/violation.ts"
import { constraintLaw } from "#compiler/ir/products.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, key, on, relation, schema } from "#compiler/public/schema.ts"
import type { Expr, OperandSelect, PlStatement } from "#compiler/sql/ast.ts"
import { exists, lit, types } from "#compiler/sql/build.ts"
import { printExpr, printStatement } from "#compiler/sql/print.ts"
import { identityHooks, transformExpr } from "#compiler/sql/transform.ts"
import { cleared, type Seat, seatOfInstalled } from "#test/pg/fin/installed.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { caseHang } from "#test/support/limits.ts"
import { refusalOf } from "#test/support/substrate.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
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

const shapes = ["titles", "viewed", "deep", "key"] as const
type Shape = (typeof shapes)[number]

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
	}
}

/** The SQLSTATE a shape's rule is refused under: a containment's, or a key's. */
const codeOf = (shape: Shape): string => (shape === "key" ? "23505" : "23503")

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
const caseGen =
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
 * key's case refused by deleting a block, its values drawn. The build, one transaction: a chain of key k whose L1 and
 * L3 are of value w and whose L2 of 1 - w is under a block of its L1 a1, so k has the one value w. Deleting the block
 * gives k the value 1 - w through the side's second arm, and the key is broken.
 */
const blockWithdrawn: Gen<Case> = (s) => {
	const k = s.draw(int(1, 2))
	const [a1, a2, a3] = [s.draw(idGen), s.draw(idGen), s.draw(idGen)]
	const w = s.draw(valueGen)
	return {
		shape: "key",
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
			return [["deletes", blockWithdrawn]]
	}
}

/**
 * The case a witness runs: its drawn one, or, where its turn aims at a refusal a withdrawal reaches (Case.steering), the
 * case constructed to reach it, drawn on the case's own tape.
 */
const aimedCase = (drawnCase: Case, search: Search<EquivalenceFeature>): Case => {
	const pending = Option.getOrUndefined(search.steering)
	const aim = Arr.findFirst(
		withdrawalsOf(drawnCase.shape),
		([withdrawal]) => pending?.aimed(refusedAfter[withdrawal]) === true
	)
	return Option.isNone(aim) ? drawnCase : search.draw(aim.value[1])
}

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

/** A shape installed: its seat, its rule's law, and that law's whole violation query, printed. */
interface Installed {
	readonly shape: Shape
	readonly seat: Seat
	readonly law: LawId
	readonly whole: string
}

/** Installs `shape` through its first migration, its rule's law the one rule over a query its triggers discharge. */
const installShape = (shape: Shape) =>
	Effect.gen(function* () {
		const done = yield* installMigrated(schemaOf(shape, `Seed_${shape}`), {
			ambient: ordinarySession,
			label: `rule_seed_${shape}`,
			logins: [],
			extensions: []
		})
		const seat = yield* seatOfInstalled(done, RELATIONS, `rule_seed_${shape}`)
		const installation = done.installation
		const [rule, ...others] = installation.laws.rules
		assert.ok(rule !== undefined && others.length === 0, `${shape}: one rule held by triggers`)
		const check = defined(
			Arr.findFirst(lawChecks(installation).rules, (c) => c.law === rule.law.id).pipe(
				Option.getOrUndefined
			),
			`${shape}: the rule's whole check`
		)
		return {
			shape,
			seat,
			law: rule.law.id,
			whole: printStatement(check.query)
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

type EquivalenceFeature =
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
			return undefined
	}
}

/**
 * One drawn history on its shape's seat, from empty: each transaction judged by the rule's whole check before its
 * triggers run, and committed exactly when the check finds nothing.
 */
const judgeHistory = (installed: Installed, c: Case, note: (f: EquivalenceFeature) => void) =>
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
			const judged = yield* Effect.onError(
				session.values(`SELECT EXISTS (${installed.whole})`, []),
				() => Effect.ignore(session.rollback)
			)
			const broken = truth(judged)
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
const touchedOf = (seat: Seat, k: number): ReadonlyArray<Touched> => {
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

/** The probes of a rule function's body: the query of each EXISTS its IFs test. */
const probesIn = (body: ReadonlyArray<PlStatement>): ReadonlyArray<OperandSelect> =>
	Arr.flatMap(body, (s) =>
		s.kind === "if"
			? Arr.flatMap(s.branches, (b) => [
					...(b.condition.kind === "exists" ? [b.condition.query] : []),
					...probesIn(b.body)
				])
			: []
	)

/** Every probe of the rule functions on `table`, as the installation creates them. */
const probesOn = (seat: Seat, table: Table): ReadonlyArray<OperandSelect> => {
	const installation = seat.installed.installation
	const functions = new Set<string>(
		Arr.flatMap(installation.laws.rules, (rule) =>
			Arr.flatMap(rule.tables, (t) => (t.relation.name === table ? [identifierOf(t.function)] : []))
		)
	)
	return Arr.flatMap(installation.statements, (s) =>
		s.kind === "createFunction" && s.language === "plpgsql" && functions.has(s.name.name)
			? probesIn(s.body.body)
			: []
	)
}

/** A probe's EXISTS with every field of NEW and OLD read at `row`, by column. */
const probeAt = (probe: OperandSelect, row: ReadonlyMap<string, number>): string =>
	printExpr(
		transformExpr(exists(probe), {
			...identityHooks,
			expr: (e: Expr): Expr =>
				e.kind === "field" && e.record.kind === "plSpecial"
					? lit.int(defined(row.get(e.field), `the touched row's ${e.field}`), types.integer)
					: e
		})
	)

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
 * The footprint of touching `touched`, on a fresh session planning for large tables: first the SIRead locks of a
 * transaction that writes the row as it stands (each column set to itself, or a block inserted and deleted again) and
 * runs its triggers, rolled back; then the rows each probe on its table reads at the row.
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
		const fields = seat.roles(table)
		const write = touched.stored
			? [
					`UPDATE ${t} SET ${Arr.join(
						Arr.map(fields, (f) => `${seat.column(table, f)} = ${seat.column(table, f)}`),
						", "
					)} WHERE ${id} = ${touched.id}`
				]
			: [
					`INSERT INTO ${t} (${id}) VALUES (${touched.id})`,
					`DELETE FROM ${t} WHERE ${id} = ${touched.id}`
				]
		yield* session.begin
		const locks = yield* Effect.onError(
			Effect.gen(function* () {
				for (const sql of write) {
					yield* session.query(sql, [])
				}
				yield* session.query("SET CONSTRAINTS ALL IMMEDIATE", [])
				return yield* siReadLocks(session)
			}),
			() => Effect.ignore(session.rollback)
		)
		yield* session.rollback
		const stored = touched.stored
			? yield* session.values(
					`SELECT ${Arr.join(
						Arr.map(fields, (f) => seat.column(table, f)),
						", "
					)} FROM ${t} WHERE ${id} = ${touched.id}`,
					[]
				)
			: [[touched.id]]
		const values = defined(stored[0], `${table} ${touched.id} is stored`)
		const row = new Map(Arr.map(fields, (f, i) => [columnOf(seat, table, f), intCell(values, i)]))
		const rows: Array<number> = []
		for (const probe of probesOn(seat, table)) {
			const explained = yield* session.values(
				`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SETTINGS, FORMAT JSON) SELECT ${probeAt(probe, row)}`,
				[]
			)
			rows.push(rowsRead(succeeded(parsePlan(explained[0]?.[0]), "one EXPLAIN plan").plan))
		}
		return { rows, locks } satisfies Footprint
	})

/** The column identifier of a field, unquoted, as a probe's NEW and OLD fields name it. */
const columnOf = (seat: Seat, table: Table, field: string): string =>
	defined(
		Arr.findFirst(
			defined(seat.model.checked.relations.get(table), `${table} is checked`).fields,
			(f) => f.name === field
		).pipe(Option.getOrUndefined),
		`${table}.${field} is a field`
	).column

type LocalityFeature = `${Shape} measured`

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
const localityGen =
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
const footprints = (seat: Seat, k: number, from: number, to: number) =>
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
const requiredOf = (shape: Shape): NonEmptyReadonlyArray<EquivalenceFeature> => {
	const containment: ReadonlyArray<EquivalenceFeature> =
		shape === "key" ? [] : ["committed a needed key no first target arm holds"]
	return [
		"committed",
		`refused by ${shape}`,
		...Arr.map(withdrawalsOf(shape), ([withdrawal]) => refusedAfter[withdrawal]),
		...containment
	]
}

layer(Substrate.layer, { excludeTestServices: true })(
	"a rule over a query's triggers, seeded at the touched row's key",
	(it) => {
		for (const shape of shapes) {
			it.effect(
				`commit exactly the transactions whose state the rule's whole check finds lawful, refusing the rest by the rule: ${shape}`,
				(ctx) =>
					searched(
						ctx,
						Effect.gen(function* () {
							const installed = yield* installShape(shape)
							return yield* explore(
								{
									suite: `laws/rule-seeding/${shape}`,
									draw: drawn(caseGen(shape)),
									literal: Formatter.format,
									oracle: {
										kind: "postgresql",
										name: "the rule's whole violation query, the migration's check over every row, unseeded: a transaction commits exactly when it finds nothing in the state the transaction leaves"
									},
									coverage: required<EquivalenceFeature>(requiredOf(shape), {
										cases: 200,
										sense: notesOnly
									}),
									kept: [],
									runs: 80,
									shrink: { kind: "bounded", candidates: 200 },
									concurrency: 1,
									steerEvery: 16,
									caseHang
								},
								(c, search) => judgeHistory(installed, aimedCase(c, search), search.note)
							)
						})
					)
			)
		}

		for (const shape of shapes) {
			it.effect(
				`read the same rows and take the same SIRead locks beside hundreds more keys, none on a whole relation: ${shape}`,
				(ctx) =>
					searched(
						ctx,
						Effect.gen(function* () {
							const { seat } = yield* installShape(shape)
							return yield* explore(
								{
									suite: `laws/rule-seeding-locality/${shape}`,
									draw: drawn(localityGen(shape)),
									literal: Formatter.format,
									oracle: {
										kind: "universal",
										name: "invariance: a probe of a key reads the same rows and its triggers take the same SIRead locks whatever other keys hold"
									},
									coverage: required<LocalityFeature>([`${shape} measured`], {
										cases: 0,
										sense: notesOnly
									}),
									kept: [],
									runs: 6,
									shrink: { kind: "bounded", candidates: 12 },
									concurrency: 1,
									steerEvery: 4,
									caseHang
								},
								(l, search) =>
									Effect.gen(function* () {
										yield* cleared(seat, RELATIONS)
										const few = yield* footprints(seat, l.key, 1, l.before)
										const many = yield* footprints(seat, l.key, l.before + 1, l.after)
										for (const [i, touched] of touchedOf(seat, l.key).entries()) {
											const where = `${Formatter.format(l)}, ${touched.table} ${touched.id}`
											const before = defined(few[i], "a footprint beside the first keys")
											const after = defined(many[i], "a footprint beside every key")
											assert.ok(before.rows.length > 0, `${where}: a probe reads the touched table`)
											assert.deepEqual(
												after.rows,
												before.rows,
												`${where}: each probe reads the same rows`
											)
											assert.deepEqual(after.locks, before.locks, `${where}: the same SIRead locks`)
											assert.deepEqual(
												Arr.filter(after.locks, Str.startsWith("relation ")),
												[],
												`${where}: no SIRead lock on a whole relation`
											)
										}
										search.note(`${l.shape} measured`)
									})
							)
						})
					)
			)
		}
	}
)
