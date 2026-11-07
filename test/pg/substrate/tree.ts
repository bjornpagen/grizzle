/**
 * The tree relation of trees.md as hand-written DDL, the rows a writer sends, the model of what PostgreSQL does with
 * each transaction of them, the theorem's own checker, and the boxes of states, mutations and writes the substrate
 * proof (tree.test.ts) exhausts: its reference, never grizzle's lowering. The checker (breachOf) shares no code with
 * the model (predicted), so the one judges the other; test/pg/fin/tree.test.ts draws the same boxes and judges grizzle's
 * installed lowering against `predicted(RFC, …)`.
 *
 * A tree relation `node (id, root, parent, at, children, start, end)` is the ordered family of node over itself,
 * `node(parent, at)` counted by `fin(node, children)`, whose every row carries its pre-order interval `[start, end)`,
 * one tree per value of `root`. The family's lowering is G2's (fin.ts, fin.md §5.2), with the owner and the family one
 * table:
 *
 * - the merged parent copy (fin.md §15 rule 3), `FOREIGN KEY (parent, root, copy, parent_start) REFERENCES node (id,
 *   root, children, start) ON UPDATE CASCADE`: the ‹n› copy `copy`, T0's root copied down, and T3's `parentStart`;
 * - `CHECK (at < ‹n›)`, the family's key, the ‹p› closure carrying T4, and the deferred last slot carrying T5.
 *
 * The root is the one self-parented row, and fin.md §12.8 (the operator's ruling) selects it out of its own children
 * family: φ₀ is `parent ≠ id`, and the family's group column `grp` is `CASE WHEN parent <> id THEN parent END`, NULL at
 * the root, so the root holds no slot of the key, no target of T4's or T5's containments, and no check of the bound or
 * of T3. One guarded column stands for §5.1's guard on every term of the selected side: a NULL in one column of a
 * `NULLS DISTINCT` key keeps the tuple apart, and a NULL in one referencing column of a `MATCH SIMPLE` key skips it, as
 * a NULL in every column does. trees.md states the laws over every row; `selection: "every row"` is that text read
 * literally, and `targets: "every row"` keeps the family's selection but points T4 and T5 at every row, as trees.md
 * writes their targets `on(T, …)`. Both are controls the proof judges beside the ruling's lowering.
 *
 * The parent copy is not selected: the root copies itself, so its ‹n› is its own count and its `parentStart` its own
 * start, one representation. Every count, index and interval is the `natural` domain over int8, and every column
 * grizzle generates or copies is int8, its base type, as G2's are.
 */
import { element, type Gen, int, shuffled } from "@grizzle/testing/gen"
import { Array as Arr, Option, Order } from "effect"
import { indices, maxOf } from "#compiler/core/array.ts"
import { defined, nonEmpty } from "#test/support/assert.ts"
import type { Moment } from "#test/support/families/mutate.ts"
import { qualified, tuple } from "#test/support/substrate.ts"

/**
 * One row of the tree relation as a writer sends it: its fields, and the two copies the host draws from its parent's
 * row, which the merged parent copy holds to the parent's values.
 */
export interface TreeRow {
	readonly id: number
	/** The tree's root field, copied down from the parent. */
	readonly root: number
	readonly parent: number
	readonly at: number
	readonly children: number
	readonly start: number
	readonly end: number
	/** ‹n›: the parent's `children`. */
	readonly copy: number
	/** The parent's `start`, which T3's check reads. */
	readonly parentStart: number
}

/**
 * The laws a lowering installs beside the family's own constraints: T0, the parent copy's `root`; and T3 in its two
 * parts, the parent copy's `parentStart` and the check that reads it.
 */
export type Law = "T0" | "T1" | "T2" | "T3 copy" | "T3 check" | "T4" | "T5" | "T6"

/** Every law of trees.md §2. */
export const LAWS: ReadonlyArray<Law> = ["T0", "T1", "T2", "T3 copy", "T3 check", "T4", "T5", "T6"]

/**
 * A lowering of the tree relation:
 *
 * - `selection`: whether the children family and T3's check range over the non-root rows, φ₀ (fin.md §12.8), or over
 *   every row, as trees.md writes them;
 * - `targets`: whether T4's and T5's containments point at the non-root rows or at every row, `on(T, "parent", "at",
 *   "end")` read literally; every row whenever the family ranges over every row;
 * - `laws`: the laws installed beside the family's.
 */
export interface Lowering {
	readonly selection: "non-root" | "every row"
	readonly targets: "non-root" | "every row"
	readonly laws: ReadonlyArray<Law>
}

/** The constraints a lowering may install, each named `node_<constraint>` in the DDL. T0 adds none: it widens `copy`. */
export type NodeConstraint =
	| "identity"
	| "key"
	| "slots"
	| "ends"
	| "order"
	| "bound"
	| "root"
	| "first"
	| "interval"
	| "copy"
	| "closure"
	| "last"

const CONSTRAINTS: ReadonlyArray<NodeConstraint> = [
	"identity",
	"key",
	"slots",
	"ends",
	"order",
	"bound",
	"root",
	"first",
	"interval",
	"copy",
	"closure",
	"last"
]

const has = (lowering: Lowering, law: Law): boolean => Arr.contains(lowering.laws, law)

/** Whether a lowering's family carries an interval through a containment, and so needs the (grp, at, end) superkey. */
const carriesEnd = (lowering: Lowering): boolean => has(lowering, "T4") || has(lowering, "T5")

/**
 * The constraints a lowering installs: the family's (its identity, key, bound, copy, closure and last slot, and the
 * copy's target `slots`), the superkey `ends` when T4 or T5 carries an interval, and one per check or key of T1, T2, T3
 * and T6.
 */
const constraintsOf = (lowering: Lowering): ReadonlyArray<NodeConstraint> =>
	Arr.filter(CONSTRAINTS, (c) => {
		switch (c) {
			case "ends":
				return carriesEnd(lowering)
			case "order":
				return has(lowering, "T1")
			case "root":
				return has(lowering, "T2")
			case "first":
				return has(lowering, "T3 check")
			case "interval":
				return has(lowering, "T6")
			case "identity":
			case "key":
			case "slots":
			case "bound":
			case "copy":
			case "closure":
			case "last":
				return true
		}
	})

/** When PostgreSQL checks a constraint: the last slot at commit (the owner ↔ family cycle, §5.1), the rest at each statement. */
const timingOf = (constraint: NodeConstraint): "statement" | "commit" =>
	constraint === "last" ? "commit" : "statement"

/** The SQLSTATE PostgreSQL raises a constraint's violation with: 23505 for a key, 23514 for a check, 23503 for an FK. */
export const sqlstateOf = (constraint: NodeConstraint): string => {
	switch (constraint) {
		case "identity":
		case "key":
		case "slots":
		case "ends":
		case "order":
			return "23505"
		case "bound":
		case "root":
		case "first":
		case "interval":
			return "23514"
		case "copy":
		case "closure":
		case "last":
			return "23503"
	}
}

/** The constraint a reported name is, or none for a name no lowering installs. */
export const constraintNamed = (name: string | undefined): Option.Option<NodeConstraint> =>
	Arr.findFirst(CONSTRAINTS, (c) => `node_${c}` === name)

/** The column the family groups by: `grp`, NULL at the root, or `parent` itself when the family ranges over every row. */
const groupColumn = (lowering: Lowering): string =>
	lowering.selection === "non-root" ? "grp" : "parent"

/** The group column T4's and T5's targets read. */
const targetColumn = (lowering: Lowering): string =>
	lowering.targets === "non-root" ? groupColumn(lowering) : "parent"

/** A check over the family's rows: under φ₀ it holds at the root, `NOT φ₀ OR ψ`. */
const overFamily = (lowering: Lowering, check: string): string =>
	lowering.selection === "non-root" ? `parent = id OR ${check}` : check

/** The DDL of a lowering in `schema`, in order: the natural domain, then the table with every constraint. */
export const ddlOf = (schema: string, lowering: Lowering): ReadonlyArray<string> => {
	const node = qualified(schema, "node")
	const natural = qualified(schema, "natural")
	const present = constraintsOf(lowering)
	const g = groupColumn(lowering)
	const target = targetColumn(lowering)
	const ends = `${target}, at, "end"`
	const closureTarget = has(lowering, "T4") ? ends : `${g}, at`
	const lastTarget = has(lowering, "T5") ? ends : `${g}, at`
	const slots = Arr.join(
		[
			"id",
			...(has(lowering, "T0") ? ["root"] : []),
			"children",
			...(has(lowering, "T3 copy") ? ["start"] : [])
		],
		", "
	)
	const copied = Arr.join(
		[
			"parent",
			...(has(lowering, "T0") ? ["root"] : []),
			"copy",
			...(has(lowering, "T3 copy") ? ["parent_start"] : [])
		],
		", "
	)
	const parts = [
		"id int4 NOT NULL",
		"root int4 NOT NULL",
		"parent int4 NOT NULL",
		`at ${natural} NOT NULL`,
		`children ${natural} NOT NULL`,
		`start ${natural} NOT NULL`,
		`"end" ${natural} NOT NULL`,
		"copy int8 NOT NULL",
		"parent_start int8 NOT NULL",
		...(lowering.selection === "non-root"
			? ["grp int4 GENERATED ALWAYS AS (CASE WHEN parent <> id THEN parent END) STORED"]
			: []),
		"p int8 GENERATED ALWAYS AS (CASE WHEN at > 0 AND at < copy THEN at - 1 END) STORED",
		"last int8 GENERATED ALWAYS AS (CASE WHEN children > 0 THEN children - 1 END) STORED",
		"CONSTRAINT node_identity PRIMARY KEY (id)",
		`CONSTRAINT node_key UNIQUE NULLS DISTINCT (${g}, at)`,
		`CONSTRAINT node_slots UNIQUE NULLS DISTINCT (${slots})`,
		...(Arr.contains(present, "ends")
			? [`CONSTRAINT node_ends UNIQUE NULLS DISTINCT (${ends})`]
			: []),
		...(Arr.contains(present, "order")
			? ["CONSTRAINT node_order UNIQUE NULLS DISTINCT (root, start)"]
			: []),
		`CONSTRAINT node_bound CHECK (${overFamily(lowering, "at < copy")})`,
		...(Arr.contains(present, "root")
			? ["CONSTRAINT node_root CHECK ((parent = id) = (start = 0))"]
			: []),
		...(Arr.contains(present, "first")
			? [
					`CONSTRAINT node_first CHECK (${overFamily(lowering, "at > 0 OR start = parent_start + 1")})`
				]
			: []),
		...(Arr.contains(present, "interval")
			? ['CONSTRAINT node_interval CHECK ("end" > start AND (children > 0 OR "end" = start + 1))']
			: []),
		`CONSTRAINT node_copy FOREIGN KEY (${copied}) REFERENCES ${node} (${slots}) MATCH SIMPLE ON UPDATE CASCADE NOT DEFERRABLE`,
		`CONSTRAINT node_closure FOREIGN KEY (${g}, p${has(lowering, "T4") ? ", start" : ""}) REFERENCES ${node} (${closureTarget}) MATCH SIMPLE NOT DEFERRABLE`,
		`CONSTRAINT node_last FOREIGN KEY (id, last${has(lowering, "T5") ? ', "end"' : ""}) REFERENCES ${node} (${lastTarget}) MATCH SIMPLE DEFERRABLE INITIALLY DEFERRED`
	]
	return [
		`CREATE DOMAIN ${natural} AS int8 CONSTRAINT natural_nonnegative CHECK (VALUE >= 0)`,
		`CREATE TABLE ${node} (${Arr.join(parts, ", ")})`
	]
}

/** The columns a writer sends, in the order every insert and read names them. */
const COLUMNS = 'id, root, parent, at, children, start, "end", copy, parent_start'

const valuesOf = (row: TreeRow): ReadonlyArray<number> => [
	row.id,
	row.root,
	row.parent,
	row.at,
	row.children,
	row.start,
	row.end,
	row.copy,
	row.parentStart
]

/** One INSERT of `rows` in `schema`, in the order given. */
export const insertSql = (schema: string, rows: Arr.NonEmptyReadonlyArray<TreeRow>): string =>
	`INSERT INTO ${qualified(schema, "node")} (${COLUMNS}) VALUES ${Arr.join(
		Arr.map(rows, (r) => tuple(valuesOf(r))),
		", "
	)}`

/**
 * One INSERT of many rows in `schema` from nine array parameters, one per column, in the order the arrays hold them:
 * the statement of a batch too long for a VALUES list.
 */
export const batchInsertSql = (schema: string): string =>
	`INSERT INTO ${qualified(schema, "node")} (${COLUMNS}) SELECT * FROM ROWS FROM (${Arr.join(
		Arr.map(
			["int4", "int4", "int4", "int8", "int8", "int8", "int8", "int8", "int8"],
			(type, i) => `pg_catalog.unnest($${i + 1}::${type}[])`
		),
		", "
	)})`

/** The nine array parameters of batchInsertSql, each an array literal. */
export const batchParams = (rows: ReadonlyArray<TreeRow>): ReadonlyArray<string> =>
	Arr.map(
		Arr.makeBy(9, (column) => column),
		(column) =>
			`{${Arr.join(
				Arr.map(rows, (r) => String(Arr.getUnsafe(valuesOf(r), column))),
				","
			)}}`
	)

/** The read of a lowering's stored rows, every value an int4. */
export const readSql = (schema: string): string =>
	`SELECT id, root, parent, at::int4, children::int4, start::int4, "end"::int4, copy::int4, parent_start::int4 FROM ${qualified(schema, "node")}`

/** The rows the read returns. */
export const rowsOfRead = (rows: ReadonlyArray<ReadonlyArray<unknown>>): ReadonlyArray<TreeRow> =>
	Arr.map(rows, ([id, root, parent, at, children, start, end, copy, parentStart]) => ({
		id: Number(id),
		root: Number(root),
		parent: Number(parent),
		at: Number(at),
		children: Number(children),
		start: Number(start),
		end: Number(end),
		copy: Number(copy),
		parentStart: Number(parentStart)
	}))

/**
 * The removal of every row a case left, so the next case starts from no state: a DELETE, since a case leaves a handful
 * of rows and TRUNCATE's new relation files cost more than deleting them.
 */
export const clearSql = (schema: string): string => `DELETE FROM ${qualified(schema, "node")}`

/** Rows in one canonical order, by id, for exact comparison. */
export const canonical = (rows: ReadonlyArray<TreeRow>): ReadonlyArray<TreeRow> =>
	Arr.sort(
		rows,
		Order.mapInput(Order.Number, (r: TreeRow) => r.id)
	)

/** One constraint a state breaks, on the row whose check, key or reference it is. */
interface Violation {
	readonly constraint: NodeConstraint
	readonly id: number
}

/** The family's group of a row: its parent, or none at the root when the family is over the non-root rows. */
const groupOf = (lowering: Lowering, row: TreeRow): Option.Option<number> =>
	lowering.selection === "every row" || row.parent !== row.id
		? Option.some(row.parent)
		: Option.none()

/** The group T4's and T5's targets read of a row. */
const targetGroupOf = (lowering: Lowering, row: TreeRow): Option.Option<number> =>
	lowering.targets === "every row" ? Option.some(row.parent) : groupOf(lowering, row)

/** ‹p›, `CASE WHEN at > 0 AND at < ‹n› THEN at − 1 END`. */
const predecessorOf = (row: TreeRow): Option.Option<number> =>
	row.at > 0 && row.at < row.copy ? Option.some(row.at - 1) : Option.none()

/** pred(children), `CASE WHEN children > 0 THEN children − 1 END`. */
const lastOf = (row: TreeRow): Option.Option<number> =>
	row.children > 0 ? Option.some(row.children - 1) : Option.none()

/** Whether a row is outside the family, so a check over the family holds of it. */
const outsideFamily = (lowering: Lowering, row: TreeRow): boolean =>
	lowering.selection === "non-root" && row.parent === row.id

/** Whether two key tuples are equal with no NULL in either: `NULLS DISTINCT`. */
const sameKey = (
	a: ReadonlyArray<Option.Option<number>>,
	b: ReadonlyArray<Option.Option<number>>
): boolean =>
	Arr.every(a, (x, i) => {
		const y = Arr.getUnsafe(b, i)
		return Option.isSome(x) && Option.isSome(y) && x.value === y.value
	})

/**
 * Every constraint of the lowering the stored rows break, whenever PostgreSQL checks it: a key two rows hold with no
 * NULL, a check that is false, and a `MATCH SIMPLE` reference with no NULL whose target no row holds.
 */
const violations = (lowering: Lowering, rows: ReadonlyArray<TreeRow>): ReadonlyArray<Violation> => {
	const present = constraintsOf(lowering)
	const some = Option.some
	const keyOf = (
		constraint: NodeConstraint,
		row: TreeRow
	): ReadonlyArray<Option.Option<number>> => {
		switch (constraint) {
			case "identity":
				return [some(row.id)]
			case "key":
				return [groupOf(lowering, row), some(row.at)]
			case "slots":
				return [
					some(row.id),
					...(has(lowering, "T0") ? [some(row.root)] : []),
					some(row.children),
					...(has(lowering, "T3 copy") ? [some(row.start)] : [])
				]
			case "ends":
				return [targetGroupOf(lowering, row), some(row.at), some(row.end)]
			case "order":
				return [some(row.root), some(row.start)]
			case "bound":
			case "root":
			case "first":
			case "interval":
			case "copy":
			case "closure":
			case "last":
				return []
		}
	}
	const keyed = (constraint: NodeConstraint): ReadonlyArray<Violation> =>
		Arr.flatMap(rows, (row, i) =>
			Arr.some(
				rows,
				(other, j) => j !== i && sameKey(keyOf(constraint, row), keyOf(constraint, other))
			)
				? [{ constraint, id: row.id }]
				: []
		)
	const checked = (constraint: NodeConstraint, holds: (row: TreeRow) => boolean) =>
		Arr.flatMap(rows, (row): ReadonlyArray<Violation> =>
			holds(row) ? [] : [{ constraint, id: row.id }]
		)
	/** A reference with no NULL holds when some row's target tuple equals it. */
	const referenced = (
		constraint: NodeConstraint,
		reference: (row: TreeRow) => ReadonlyArray<Option.Option<number>>,
		target: (row: TreeRow) => ReadonlyArray<Option.Option<number>>
	) =>
		checked(constraint, (row) => {
			const wanted = reference(row)
			return (
				!Arr.every(wanted, Option.isSome) ||
				Arr.some(rows, (other) => sameKey(wanted, target(other)))
			)
		})
	const familyTarget = (row: TreeRow) => [groupOf(lowering, row), some(row.at)]
	const endsTarget = (row: TreeRow) => [targetGroupOf(lowering, row), some(row.at), some(row.end)]
	const all = (constraint: NodeConstraint): ReadonlyArray<Violation> => {
		switch (constraint) {
			case "identity":
			case "key":
			case "slots":
			case "ends":
			case "order":
				return keyed(constraint)
			case "bound":
				return checked(constraint, (r) => outsideFamily(lowering, r) || r.at < r.copy)
			case "root":
				return checked(constraint, (r) => (r.parent === r.id) === (r.start === 0))
			case "first":
				return checked(
					constraint,
					(r) => outsideFamily(lowering, r) || r.at > 0 || r.start === r.parentStart + 1
				)
			case "interval":
				return checked(
					constraint,
					(r) => r.end > r.start && (r.children > 0 || r.end === r.start + 1)
				)
			case "copy":
				return referenced(
					constraint,
					(r) => [
						some(r.parent),
						...(has(lowering, "T0") ? [some(r.root)] : []),
						some(r.copy),
						...(has(lowering, "T3 copy") ? [some(r.parentStart)] : [])
					],
					(r) => keyOf("slots", r)
				)
			case "closure":
				return referenced(
					constraint,
					(r) =>
						has(lowering, "T4")
							? [groupOf(lowering, r), predecessorOf(r), some(r.start)]
							: [groupOf(lowering, r), predecessorOf(r)],
					has(lowering, "T4") ? endsTarget : familyTarget
				)
			case "last":
				return referenced(
					constraint,
					(r) =>
						has(lowering, "T5") ? [some(r.id), lastOf(r), some(r.end)] : [some(r.id), lastOf(r)],
					has(lowering, "T5") ? endsTarget : familyTarget
				)
		}
	}
	return Arr.flatMap(present, all)
}

/** What the model says PostgreSQL does with a transaction: it commits, or is refused at a moment by any of a set. */
export type Predicted =
	| { readonly kind: "committed"; readonly after: ReadonlyArray<TreeRow> }
	| {
			readonly kind: "refused"
			readonly moment: Moment
			readonly violations: Arr.NonEmptyReadonlyArray<Violation>
	  }

/**
 * The model of one transaction of inserts from no rows: after each statement every constraint checked at a statement
 * must hold of the whole state, which is PostgreSQL's check of the rows that statement inserted, since an insert never
 * breaks an earlier row's check, key or reference; at commit the deferred last slot must hold too.
 */
export const predicted = (
	lowering: Lowering,
	statements: ReadonlyArray<ReadonlyArray<TreeRow>>
): Predicted => {
	let state: ReadonlyArray<TreeRow> = []
	for (const [index, inserted] of statements.entries()) {
		state = Arr.appendAll(state, inserted)
		const broken = Arr.filter(
			violations(lowering, state),
			(v) => timingOf(v.constraint) === "statement"
		)
		if (Arr.isReadonlyArrayNonEmpty(broken)) {
			return { kind: "refused", moment: { kind: "statement", index }, violations: broken }
		}
	}
	const deferred = violations(lowering, state)
	return Arr.isReadonlyArrayNonEmpty(deferred)
		? { kind: "refused", moment: { kind: "commit" }, violations: deferred }
		: { kind: "committed", after: state }
}

/** The lowering fin.md §12.8 rules: every law of trees.md §2, T0 to T6, the root selected out of its own family. */
export const RFC: Lowering = { selection: "non-root", targets: "non-root", laws: LAWS }

/** Why a state is no forest of trees, by the theorem: the first of these its rows show, in this order. */
export type TreeBreach =
	| "an orphan"
	| "no root"
	| "two roots"
	| "a cycle"
	| "a row under another tree"
	| "a family"
	| "a copy"
	| "an interval"

/**
 * The theorem's checker, per value of the root field and independent of the constraints: every parent a row; one
 * self-parented row of each value; every row reached from its value's root through rows of its own value, an unreached
 * row named by where its parent links lead, around a cycle or to another tree; each row's non-root children at the
 * slots 0 … n − 1, n its count; each row's copies its parent's count and start; and every `[start, end)` the interval a
 * naive depth-first walk of its tree numbers, children in slot order. A root's own `at` is outside every family, and
 * the theorem says nothing of it.
 */
export const breachOf = (rows: ReadonlyArray<TreeRow>): Option.Option<TreeBreach> => {
	const rowOf = (id: number): Option.Option<TreeRow> => Arr.findFirst(rows, (r) => r.id === id)
	const childrenOf = (id: number): ReadonlyArray<TreeRow> =>
		Arr.sort(
			Arr.filter(rows, (r) => r.parent === id && r.id !== id),
			Order.mapInput(Order.Number, (r: TreeRow) => r.at)
		)
	if (Arr.some(rows, (r) => Option.isNone(rowOf(r.parent)))) {
		return Option.some("an orphan")
	}
	const values = Arr.dedupe(Arr.map(rows, (r) => r.root))
	const rootsOf = (value: number) => Arr.filter(rows, (r) => r.root === value && r.parent === r.id)
	if (Arr.some(values, (v) => rootsOf(v).length === 0)) {
		return Option.some("no root")
	}
	if (Arr.some(values, (v) => rootsOf(v).length > 1)) {
		return Option.some("two roots")
	}
	/** The walk of a tree from `id` through its own value's rows: each row once, in pre-order. */
	const walk = (id: number, value: number, seen: ReadonlyArray<number>): ReadonlyArray<number> =>
		Arr.contains(seen, id)
			? seen
			: Arr.reduce(
					Arr.filter(childrenOf(id), (c) => c.root === value),
					Arr.append(seen, id),
					(s: ReadonlyArray<number>, c) => walk(c.id, value, s)
				)
	const rootOf = (value: number): TreeRow => defined(rootsOf(value)[0])
	const reached = Arr.flatMap(values, (v) => walk(rootOf(v).id, v, []))
	/** Whether a row's parent links reach a self-parented row, or circle first. */
	const rooted = (row: TreeRow): boolean => {
		let at = row
		for (const _ of rows) {
			if (at.parent === at.id) {
				return true
			}
			at = Option.getOrElse(rowOf(at.parent), () => at)
		}
		return at.parent === at.id
	}
	const stray = Arr.findFirst(rows, (r) => !Arr.contains(reached, r.id))
	if (Option.isSome(stray)) {
		return Option.some(rooted(stray.value) ? "a row under another tree" : "a cycle")
	}
	if (
		Arr.some(rows, (r) => {
			const kids = childrenOf(r.id)
			return r.children !== kids.length || Arr.some(kids, (k, i) => k.at !== i)
		})
	) {
		return Option.some("a family")
	}
	if (
		Arr.some(rows, (r) =>
			Option.match(rowOf(r.parent), {
				onNone: () => true,
				onSome: (p) => r.copy !== p.children || r.parentStart !== p.start
			})
		)
	) {
		return Option.some("a copy")
	}
	const exact = Arr.every(values, (v) =>
		Arr.every(walk(rootOf(v).id, v, []), (id, index) =>
			Option.match(rowOf(id), {
				onNone: () => false,
				onSome: (r) => r.start === index && r.end === index + walk(id, v, []).length
			})
		)
	)
	return exact ? Option.none() : Option.some("an interval")
}

/**
 * P3's counterexample (trees.md §2, T0), up to relabelling: roots A and B of two root values, A a leaf over [0, 1), B
 * over [0, 3) with one child c of B's value over [1, 3), and c's one child x, of A's value, over [2, 3).
 */
export const isP3 = (rows: ReadonlyArray<TreeRow>): boolean => {
	const roots = Arr.sort(
		Arr.filter(rows, (r) => r.parent === r.id),
		Order.mapInput(Order.Number, (r: TreeRow) => r.end)
	)
	const only = (parent: TreeRow) =>
		Arr.filter(rows, (r) => r.parent === parent.id && r.id !== parent.id)
	const [a, b] = roots
	if (rows.length !== 4 || roots.length !== 2 || a === undefined || b === undefined) {
		return false
	}
	const [c] = only(b)
	const [x] = c === undefined ? [] : only(c)
	return (
		a.root !== b.root &&
		a.start === 0 &&
		a.end === 1 &&
		b.start === 0 &&
		b.end === 3 &&
		c !== undefined &&
		c.root === b.root &&
		c.start === 1 &&
		c.end === 3 &&
		x !== undefined &&
		x.root === a.root &&
		x.start === 2 &&
		x.end === 3
	)
}

/** A shape: each row's parent and root value, its `at` and `children` the host's (familyOf). */
export interface ForestShape {
	readonly parents: Arr.NonEmptyReadonlyArray<number>
	readonly roots: Arr.NonEmptyReadonlyArray<number>
}

/**
 * A shape's class under relabelling, read off its structure: each component as its cycle rotated to its least
 * reading, each node as its root value and its children in slot order with the cycle's own child marked `*`, and a
 * root's component as its tree. Two shapes are one class exactly when their codes are equal: with one root value and at
 * most one self-parented row, the classes it counts at one to six rows, 1, 2, 6, 21, 70 and 260, agree with a brute
 * force over every relabelling.
 */
const shapeCode = (parents: ReadonlyArray<number>, roots: ReadonlyArray<number>): string => {
	const n = parents.length
	const parentOf = (i: number): number => Arr.getUnsafe(parents, i)
	const kids = (v: number): ReadonlyArray<number> =>
		Arr.filter(indices(n), (u) => u !== v && parentOf(u) === v)
	const cycleOf = (i: number): Option.Option<ReadonlyArray<number>> => {
		const cycle = [i]
		for (let v = parentOf(i); v !== i; v = parentOf(v)) {
			if (cycle.length > n) {
				return Option.none()
			}
			cycle.push(v)
		}
		return Option.some(cycle)
	}
	const onCycle = (i: number): boolean => Option.isSome(cycleOf(i))
	const tree = (v: number): string =>
		`${Arr.getUnsafe(roots, v)}(${Arr.join(
			Arr.map(kids(v), (u) => (onCycle(u) ? "*" : tree(u))),
			""
		)})`
	const components = Arr.flatMap(indices(n), (i): ReadonlyArray<string> =>
		Option.match(cycleOf(i), {
			onNone: () => [],
			onSome: (cycle) => {
				if (Arr.some(cycle, (v) => v < i)) {
					return []
				}
				if (cycle.length === 1) {
					return [`R${tree(i)}`]
				}
				const readings = Arr.map(cycle, (_, r) =>
					Arr.join(Arr.map([...cycle.slice(r), ...cycle.slice(0, r)], tree), "")
				)
				return [`C${defined(Arr.sort(readings, Order.String)[0])}`]
			}
		})
	)
	return Arr.join(Arr.sort(components, Order.String), "|")
}

/** A bound on the self-parented rows of a shape. */
export interface Roots {
	readonly min: number
	readonly max: number
}

/**
 * Every shape of `n` rows with a number of self-parented rows within `selfParented` and every assignment of `values`
 * root values to its rows, one per class under relabelling and under swapping the two values (shapeCode).
 */
const shapesOf = (n: number, selfParented: Roots, values: 1 | 2): ReadonlyArray<ForestShape> => {
	const seen = new Set<string>()
	const shapes: Array<ForestShape> = []
	for (let code = 0; code < n ** n; code += 1) {
		const parents = nonEmpty(Arr.map(indices(n), (i) => Math.floor(code / n ** i) % n))
		const fixed = Arr.filter(parents, (p, i) => p === i).length
		if (fixed >= selfParented.min && fixed <= selfParented.max) {
			for (let assignment = 0; assignment < values ** n; assignment += 1) {
				const roots = nonEmpty(
					Arr.map(indices(n), (i) => Math.floor(assignment / values ** i) % values)
				)
				const key = defined(
					Arr.sort(
						[
							shapeCode(parents, roots),
							shapeCode(
								parents,
								Arr.map(roots, (r) => values - 1 - r)
							)
						],
						Order.String
					)[0]
				)
				if (!seen.has(key)) {
					seen.add(key)
					shapes.push({ parents, roots })
				}
			}
		}
	}
	return shapes
}

/** Every shape of `from` to `to` rows, as shapesOf bounds them. */
export const shapesBetween = (
	from: number,
	to: number,
	selfParented: Roots,
	values: 1 | 2
): ReadonlyArray<ForestShape> =>
	Arr.flatMap(Arr.range(from, to), (n) => shapesOf(n, selfParented, values))

/** A row without its copies, which withCopies draws from its parent's row. */
type Bare = Omit<TreeRow, "copy" | "parentStart">

/** Rows with each copy its parent's count and start, as the host draws them. Every box's parents are rows of its own. */
const withCopies = (rows: Arr.NonEmptyReadonlyArray<Bare>): Arr.NonEmptyReadonlyArray<TreeRow> =>
	Arr.map(rows, (r) => {
		const parent = Arr.findFirst(rows, (p) => p.id === r.parent)
		return {
			...r,
			copy: Option.match(parent, { onNone: () => 0, onSome: (p) => p.children }),
			parentStart: Option.match(parent, { onNone: () => 0, onSome: (p) => p.start })
		}
	})

/** A shape's slots and counts as the host draws them: each row's non-root children, in id order. */
const familyOf = (
	parents: ReadonlyArray<number>
): { readonly at: ReadonlyArray<number>; readonly children: ReadonlyArray<number> } => {
	const n = parents.length
	const childrenOf = (i: number) =>
		Arr.filter(indices(n), (u) => u !== i && Arr.getUnsafe(parents, u) === i)
	return {
		at: Arr.map(indices(n), (i) => {
			const p = Arr.getUnsafe(parents, i)
			return p === i ? 0 : Arr.filter(childrenOf(p), (u) => u < i).length
		}),
		children: Arr.map(indices(n), (i) => childrenOf(i).length)
	}
}

/** A shape's rows with the given starts and ends, the family and the copies the host's. */
const shapeRows = (
	shape: ForestShape,
	starts: ReadonlyArray<number>,
	ends: ReadonlyArray<number>
): Arr.NonEmptyReadonlyArray<TreeRow> => {
	const { at, children } = familyOf(shape.parents)
	return withCopies(
		Arr.map(shape.parents, (parent, id) => ({
			id,
			root: Arr.getUnsafe(shape.roots, id),
			parent,
			at: Arr.getUnsafe(at, id),
			children: Arr.getUnsafe(children, id),
			start: Arr.getUnsafe(starts, id),
			end: Arr.getUnsafe(ends, id)
		}))
	)
}

/** The bound on self-parented rows every box of two root values keeps: none to two, a root per value. */
export const upToTwoRoots: Roots = { min: 0, max: 2 }

/**
 * The full box: every shape of one or two rows with every root assignment, each row's `at`, `children` and `start`
 * over [0, N] and its `end` over [0, N + 1], every range one past its own, and the copies the host's.
 */
export const fullGen =
	(shapes: Arr.NonEmptyReadonlyArray<ForestShape>): Gen<Arr.NonEmptyReadonlyArray<TreeRow>> =>
	(source) => {
		const shape = source.draw(element(shapes))
		const n = shape.parents.length
		return withCopies(
			Arr.map(shape.parents, (parent, id) => {
				const at = source.draw(int(0, n))
				const children = source.draw(int(0, n))
				const start = source.draw(int(0, n))
				const end = source.draw(int(0, n + 1))
				return { id, root: Arr.getUnsafe(shape.roots, id), parent, at, children, start, end }
			})
		)
	}

/** How many states fullGen draws of its shapes: (N + 1)³ (N + 2) a row. */
export const fullCases = (shapes: ReadonlyArray<ForestShape>): number =>
	Arr.reduce(
		shapes,
		0,
		(sum, s) => sum + ((s.parents.length + 1) ** 3 * (s.parents.length + 2)) ** s.parents.length
	)

/** Every shape with each row's start in [0, N) and end in [1, N], the family and copies the host's. */
export const shapeGen =
	(shapes: Arr.NonEmptyReadonlyArray<ForestShape>): Gen<Arr.NonEmptyReadonlyArray<TreeRow>> =>
	(source) => {
		const shape = source.draw(element(shapes))
		const n = shape.parents.length
		const drawn = Arr.map(shape.parents, () => {
			const start = source.draw(int(0, n - 1))
			return { start, end: source.draw(int(1, n)) }
		})
		return shapeRows(
			shape,
			Arr.map(drawn, (d) => d.start),
			Arr.map(drawn, (d) => d.end)
		)
	}

/** How many states shapeGen draws of its shapes: N² a row. */
export const shapeCases = (shapes: ReadonlyArray<ForestShape>): number =>
	Arr.reduce(shapes, 0, (sum, s) => sum + (s.parents.length * s.parents.length) ** s.parents.length)

/** A shape with starts its rows' T1, T2 and T3 pass, whose ends checkedGen draws. */
export interface PlacedShape {
	readonly shape: ForestShape
	readonly starts: ReadonlyArray<number>
}

/**
 * Every start assignment of a shape its rows' own checks pass, built from the checks' structure rather than filtered:
 * T3 puts a first child one past its parent, so the rows fall into first-child chains, each headed by a root or a
 * later sibling and holding consecutive starts; T2 puts a root's chain at 0 and every other chain at 1 or later; and T1
 * keeps each root value's starts apart. A shape with a cycle of first children, which no chain heads, has none. Every
 * start is in [0, N).
 */
export const placementsOf = (shape: ForestShape): ReadonlyArray<PlacedShape> => {
	const n = shape.parents.length
	const parentOf = (i: number) => Arr.getUnsafe(shape.parents, i)
	const rootOf = (i: number) => Arr.getUnsafe(shape.roots, i)
	const { at } = familyOf(shape.parents)
	const firstChild = (i: number) =>
		Arr.findFirst(indices(n), (u) => u !== i && parentOf(u) === i && Arr.getUnsafe(at, u) === 0)
	const chainOf = (head: number): ReadonlyArray<number> =>
		Option.match(firstChild(head), {
			onNone: () => [head],
			onSome: (next) => [head, ...chainOf(next)]
		})
	const chains = Arr.map(
		Arr.filter(indices(n), (i) => parentOf(i) === i || Arr.getUnsafe(at, i) > 0),
		chainOf
	)
	if (Arr.reduce(chains, 0, (sum, chain) => sum + chain.length) !== n) {
		return []
	}
	type Pair = readonly [row: number, start: number]
	const placed = (
		rest: ReadonlyArray<ReadonlyArray<number>>,
		pairs: ReadonlyArray<Pair>
	): ReadonlyArray<ReadonlyArray<Pair>> => {
		const [chain, ...others] = rest
		if (chain === undefined) {
			return [pairs]
		}
		const head = Arr.getUnsafe(chain, 0)
		const starts =
			parentOf(head) === head ? [0] : Arr.filter(indices(n), (s) => s >= 1 && s + chain.length <= n)
		return Arr.flatMap(starts, (s) => {
			const next = [...pairs, ...Arr.map(chain, (row, k): Pair => [row, s + k])]
			const clash = Arr.some(next, ([a, sa], i) =>
				Arr.some(next, ([b, sb], j) => j > i && sa === sb && rootOf(a) === rootOf(b))
			)
			return clash ? [] : placed(others, next)
		})
	}
	return Arr.map(placed(chains, []), (pairs) => ({
		shape,
		starts: Arr.map(indices(n), (i) =>
			Option.getOrElse(
				Arr.findFirst(pairs, ([row]) => row === i).pipe(Option.map(([, s]) => s)),
				() => 0
			)
		)
	}))
}

/** Every placement with each end T6 passes: a leaf's its start + 1, any other row's in (start, N]. */
export const checkedGen =
	(placements: Arr.NonEmptyReadonlyArray<PlacedShape>): Gen<Arr.NonEmptyReadonlyArray<TreeRow>> =>
	(source) => {
		const { shape, starts } = source.draw(element(placements))
		const n = shape.parents.length
		const { children } = familyOf(shape.parents)
		const ends = Arr.map(starts, (start, i) =>
			Arr.getUnsafe(children, i) === 0 ? start + 1 : source.draw(int(start + 1, n))
		)
		return shapeRows(shape, starts, ends)
	}

/** How many states checkedGen draws of a placement: N − start choices for each row with children. */
export const checkedCases = (p: PlacedShape): number => {
	const { children } = familyOf(p.shape.parents)
	return Arr.reduce(p.starts, 1, (product, start, i) =>
		Arr.getUnsafe(children, i) > 0 ? product * (p.shape.parents.length - start) : product
	)
}

/**
 * The rows of the plane tree a pre-order depth sequence draws, built by construction rather than by the checker's
 * walk: each row's id `first` plus its pre-order index, its start that index, its parent the last row one shallower,
 * its slot its rank among its parent's children, and its end the index of the next row as shallow as it, or N.
 */
const treeOf = (
	depths: Arr.NonEmptyReadonlyArray<number>,
	root: number,
	first: number
): Arr.NonEmptyReadonlyArray<TreeRow> => {
	const n = depths.length
	const depth = (i: number) => Arr.getUnsafe(depths, i)
	const parentOf = (i: number): number =>
		Option.getOrElse(
			Arr.findLast(indices(i), (j) => depth(j) === depth(i) - 1),
			() => i
		)
	const endOf = (i: number): number =>
		Option.getOrElse(
			Arr.findFirst(indices(n), (j) => j > i && depth(j) <= depth(i)),
			() => n
		)
	const childrenOf = (i: number) => Arr.filter(indices(n), (j) => j !== i && parentOf(j) === i)
	return withCopies(
		Arr.map(depths, (_, i) => ({
			id: first + i,
			root,
			parent: first + parentOf(i),
			at: i === 0 ? 0 : Arr.filter(childrenOf(parentOf(i)), (j) => j < i).length,
			children: childrenOf(i).length,
			start: i,
			end: endOf(i)
		}))
	)
}

/**
 * Every plane tree's pre-order depth sequence of 1 to `most` rows: the root at depth 0, and each next row one deeper
 * than the row before it or as shallow as depth 1, so each tree is drawn once, Catalan(N − 1) of N rows.
 */
const depthsOf = (most: number): ReadonlyArray<Arr.NonEmptyReadonlyArray<number>> => {
	const sequences = (
		prefix: Arr.NonEmptyReadonlyArray<number>,
		n: number
	): ReadonlyArray<Arr.NonEmptyReadonlyArray<number>> =>
		prefix.length === n
			? [prefix]
			: Arr.flatMap(Arr.range(1, Arr.lastNonEmpty(prefix) + 1), (d) =>
					sequences(Arr.append(prefix, d), n)
				)
	return Arr.flatMap(Arr.range(1, most), (n) => sequences([0], n))
}

/**
 * Every tree of at most `most` rows, of root value 0, and every forest of two such trees of at most `most` rows in
 * all, the second of root value 1, one per pair up to swapping the two.
 */
export const forestsOf = (
	most: number
): Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<TreeRow>> => {
	const depths = depthsOf(most)
	return nonEmpty(
		[
			...Arr.map(depths, (d) => treeOf(d, 0, 0)),
			...Arr.flatMap(depths, (a, i) =>
				Arr.flatMap(depths, (b, j) =>
					j >= i && a.length + b.length <= most
						? [Arr.appendAll(treeOf(a, 0, 0), treeOf(b, 1, a.length))]
						: []
				)
			)
		],
		"a forest of one tree"
	)
}

/** The forests the mutation and write boxes start from: every tree or pair of trees of at most six rows in all. */
export const forestBox = { rows: 6 } as const

/** A named single corruption of a tree or forest (doctrine rule 6). */
export type MutationKind =
	| "a wrong start"
	| "a wrong end"
	| "a wrong at"
	| "a root's at"
	| "a wrong count"
	| "swapped siblings"
	| "a second root"
	| "a cycle"
	| "a child outside its parent"
	| "re-parented within an ancestor"
	| "moved under another tree"
	| "a row in another tree"
	| "overlapping siblings"
	| "a gap"
	| "a stale copy"

/** Every kind, the one the RFC's lowering commits first: a root's `at` is outside every family. */
export const MUTATION_KINDS: ReadonlyArray<Exclude<MutationKind, "a root's at">> = [
	"a wrong start",
	"a wrong end",
	"a wrong at",
	"a wrong count",
	"swapped siblings",
	"a second root",
	"a cycle",
	"a child outside its parent",
	"re-parented within an ancestor",
	"moved under another tree",
	"a row in another tree",
	"overlapping siblings",
	"a gap",
	"a stale copy"
]

/** One single mutation of a forest: its kind and the whole state it leaves, written from no rows in one INSERT. */
export interface Mutation {
	readonly kind: MutationKind
	readonly rows: Arr.NonEmptyReadonlyArray<TreeRow>
}

/** A forest's rows with one row's fields replaced, every copy kept as it was. */
const patched = (
	rows: Arr.NonEmptyReadonlyArray<TreeRow>,
	id: number,
	patch: Partial<TreeRow>
): Arr.NonEmptyReadonlyArray<TreeRow> =>
	Arr.map(rows, (r) => (r.id === id ? { ...r, ...patch } : r))

/**
 * Row `x` moved under `parent` (itself, for a second root), its interval and root value kept: it leaves its old
 * parent's family, whose later slots close up, takes the next slot of its new parent's family, and every copy is
 * redrawn, as the host would draw them from the new parent links.
 */
const moved = (
	rows: Arr.NonEmptyReadonlyArray<TreeRow>,
	x: TreeRow,
	parent: number
): Arr.NonEmptyReadonlyArray<TreeRow> => {
	const old = x.parent
	const leaves = old !== x.id
	const joins = parent !== x.id
	const slot = Option.match(
		Arr.findFirst(rows, (r) => r.id === parent),
		{ onNone: () => 0, onSome: (p) => p.children - (leaves && old === parent ? 1 : 0) }
	)
	return withCopies(
		Arr.map(rows, (r): Bare => {
			const children =
				r.children - (leaves && r.id === old ? 1 : 0) + (joins && r.id === parent ? 1 : 0)
			if (r.id === x.id) {
				return { ...r, parent, at: joins ? slot : 0, children }
			}
			const at = leaves && r.parent === old && r.id !== old && r.at > x.at ? r.at - 1 : r.at
			return { ...r, at, children }
		})
	)
}

/**
 * The rows of `x`'s tree from `x` on in pre-order moved `by` places, `x`'s ancestors' ends with them: one break, at
 * `x`, against the sibling or the parent before it, with every other interval consistent.
 */
const shifted = (
	rows: Arr.NonEmptyReadonlyArray<TreeRow>,
	x: TreeRow,
	by: number
): Arr.NonEmptyReadonlyArray<TreeRow> =>
	withCopies(
		Arr.map(rows, (r) =>
			r.root !== x.root
				? r
				: r.start >= x.start
					? { ...r, start: r.start + by, end: r.end + by }
					: r.end > x.start
						? { ...r, end: r.end + by }
						: r
		)
	)

/**
 * Every single mutation of a forest of N rows (each tree's starts its pre-order, treeOf), each named:
 *
 * - a wrong start, in [0, N], every copy of it redrawn; a wrong end, in [0, N + 1];
 * - a wrong `at` of a non-root row, in [0, N); a root's `at`, in [1, N], outside every family; a wrong count, in
 *   [0, N], its children's copies redrawn;
 * - two siblings' slots swapped, their intervals kept;
 * - a second root: a non-root row made self-parented, its interval kept or its start made 0, and a new self-parented
 *   row of each root value at start 0 or one past its tree;
 * - a cycle: a row, a root too, moved under one of its descendants;
 * - a child outside its parent, a row moved under a row of its tree whose interval does not hold its own;
 *   re-parented within an ancestor, under one whose interval does; and moved under another tree, under a row of the
 *   other root value, its own value kept;
 * - a row in another tree: one row's root value the other one;
 * - overlapping siblings and a gap: the rows of a tree from a non-first sibling, or from any non-root row, on in
 *   pre-order moved one place down or up, so the one break is at it;
 * - a stale copy: one row's ‹n› or `parentStart` one off.
 */
export const mutationsOf = (
	forest: Arr.NonEmptyReadonlyArray<TreeRow>
): ReadonlyArray<Mutation> => {
	const n = forest.length
	const sameTree = (a: TreeRow, b: TreeRow) => a.root === b.root
	const descends = (d: TreeRow, x: TreeRow) =>
		sameTree(d, x) && d.start > x.start && d.start < x.end
	const holds = (q: TreeRow, x: TreeRow) => sameTree(q, x) && q.start <= x.start && x.end <= q.end
	const others = Arr.filter(forest, (r) => r.parent !== r.id)
	const roots = Arr.filter(forest, (r) => r.parent === r.id)
	const except = (values: ReadonlyArray<number>, value: number) =>
		Arr.filter(values, (v) => v !== value)
	const of = (kind: MutationKind, states: ReadonlyArray<Arr.NonEmptyReadonlyArray<TreeRow>>) =>
		Arr.map(states, (rows): Mutation => ({ kind, rows }))
	const added = (root: TreeRow, start: number): Arr.NonEmptyReadonlyArray<TreeRow> =>
		Arr.append(forest, {
			id: n,
			root: root.root,
			parent: n,
			at: 0,
			children: 0,
			start,
			end: start + 1,
			copy: 0,
			parentStart: start
		})
	return [
		...of(
			"a wrong start",
			Arr.flatMap(forest, (x) =>
				Arr.map(except(Arr.range(0, n), x.start), (start) =>
					withCopies(patched(forest, x.id, { start }))
				)
			)
		),
		...of(
			"a wrong end",
			Arr.flatMap(forest, (x) =>
				Arr.map(except(Arr.range(0, n + 1), x.end), (end) => patched(forest, x.id, { end }))
			)
		),
		...of(
			"a wrong at",
			Arr.flatMap(others, (x) =>
				Arr.map(except(indices(n), x.at), (at) => patched(forest, x.id, { at }))
			)
		),
		...of(
			"a root's at",
			Arr.flatMap(roots, (x) => Arr.map(Arr.range(1, n), (at) => patched(forest, x.id, { at })))
		),
		...of(
			"a wrong count",
			Arr.flatMap(forest, (x) =>
				Arr.map(except(Arr.range(0, n), x.children), (children) =>
					withCopies(patched(forest, x.id, { children }))
				)
			)
		),
		...of(
			"swapped siblings",
			Arr.flatMap(others, (a) =>
				Arr.map(
					Arr.filter(others, (b) => b.parent === a.parent && b.at > a.at),
					(b) => patched(patched(forest, a.id, { at: b.at }), b.id, { at: a.at })
				)
			)
		),
		...of("a second root", [
			...Arr.flatMap(others, (x) => [
				moved(forest, x, x.id),
				withCopies(patched(moved(forest, x, x.id), x.id, { start: 0 }))
			]),
			...Arr.flatMap(roots, (root) => [added(root, 0), added(root, root.end)])
		]),
		...of(
			"a cycle",
			Arr.flatMap(forest, (x) =>
				Arr.map(
					Arr.filter(forest, (d) => descends(d, x)),
					(d) => moved(forest, x, d.id)
				)
			)
		),
		...of(
			"a child outside its parent",
			Arr.flatMap(others, (x) =>
				Arr.map(
					Arr.filter(
						forest,
						(q) =>
							sameTree(q, x) &&
							q.id !== x.id &&
							q.id !== x.parent &&
							!descends(q, x) &&
							!holds(q, x)
					),
					(q) => moved(forest, x, q.id)
				)
			)
		),
		...of(
			"re-parented within an ancestor",
			Arr.flatMap(others, (x) =>
				Arr.map(
					Arr.filter(forest, (q) => q.id !== x.id && q.id !== x.parent && holds(q, x)),
					(q) => moved(forest, x, q.id)
				)
			)
		),
		...of(
			"moved under another tree",
			Arr.flatMap(others, (x) =>
				Arr.map(
					Arr.filter(forest, (q) => !sameTree(q, x)),
					(q) => moved(forest, x, q.id)
				)
			)
		),
		...of(
			"a row in another tree",
			Arr.map(forest, (x) => patched(forest, x.id, { root: 1 - x.root }))
		),
		...of(
			"overlapping siblings",
			Arr.map(
				Arr.filter(others, (x) => x.at > 0),
				(x) => shifted(forest, x, -1)
			)
		),
		...of(
			"a gap",
			Arr.map(others, (x) => shifted(forest, x, 1))
		),
		...of(
			"a stale copy",
			Arr.flatMap(forest, (x) =>
				Arr.map(
					[
						{ copy: x.copy + 1 },
						...(x.copy > 0 ? [{ copy: x.copy - 1 }] : []),
						{ parentStart: x.parentStart + 1 },
						...(x.parentStart > 0 ? [{ parentStart: x.parentStart - 1 }] : [])
					],
					(patch) => patched(forest, x.id, patch)
				)
			)
		)
	]
}

/** A forest written one way: its rows in one order within one INSERT, or an order of them split into INSERTs. */
export type Write =
	| { readonly kind: "one insert"; readonly rows: Arr.NonEmptyReadonlyArray<TreeRow> }
	| {
			readonly kind: "split"
			readonly order: "pre-order" | "reverse pre-order"
			readonly statements: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<TreeRow>>
	  }

/** The statements a write sends. */
export const statementsOf = (
	write: Write
): Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<TreeRow>> =>
	write.kind === "one insert" ? [write.rows] : write.statements

/** `rows` cut into consecutive statements after each row i whose bit i − 1 of `cuts` is set. */
const splitAt = (
	rows: Arr.NonEmptyReadonlyArray<TreeRow>,
	cuts: number
): Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<TreeRow>> => {
	const ends = [
		...Arr.filter(indices(rows.length), (i) => i > 0 && ((cuts >> (i - 1)) & 1) === 1),
		rows.length
	]
	return nonEmpty(
		Arr.map(ends, (end, k) =>
			nonEmpty(rows.slice(k === 0 ? 0 : Arr.getUnsafe(ends, k - 1), end), "a statement holds a row")
		),
		"a write sends a statement"
	)
}

/**
 * Every write of every forest: each order of its rows within one INSERT, and each split of its pre-order (each tree's
 * in turn) and of its reverse into consecutive INSERTs, by the 2^(N − 1) ways to cut N rows.
 */
export const writeGen =
	(forests: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<TreeRow>>): Gen<Write> =>
	(source) => {
		const forest = source.draw(element(forests))
		const n = forest.length
		if (source.draw(element<Write["kind"]>(["one insert", "split"])) === "one insert") {
			return {
				kind: "one insert",
				rows: nonEmpty(source.draw(shuffled(forest, { min: n, max: n })))
			}
		}
		const order = source.draw(
			element<"pre-order" | "reverse pre-order">(["pre-order", "reverse pre-order"])
		)
		const rows = order === "pre-order" ? forest : Arr.reverse(forest)
		return {
			kind: "split",
			order,
			statements: splitAt(rows, source.draw(int(0, 2 ** (n - 1) - 1)))
		}
	}

/** A tree of `rows` rows in breadth-first numbering, every row with up to `fanout` children, its rows in pre-order. */
export const loadTree = (rows: number, fanout: number): Arr.NonEmptyReadonlyArray<TreeRow> => {
	const parentOf = (i: number) => (i === 0 ? 0 : Math.floor((i - 1) / fanout))
	const kidsOf = (i: number) =>
		Arr.filter(Arr.range(i * fanout + 1, i * fanout + fanout), (k) => k < rows)
	const sizes = Arr.makeBy(rows, () => 1)
	for (let i = rows - 1; i > 0; i -= 1) {
		sizes[parentOf(i)] = defined(sizes[parentOf(i)]) + defined(sizes[i])
	}
	/** Pre-order starts, top-down: a first child one past its parent, each next one past its predecessor's subtree. */
	const starts = Arr.makeBy(rows, () => 0)
	for (let i = 0; i < rows; i += 1) {
		let next = defined(starts[i]) + 1
		for (const k of kidsOf(i)) {
			starts[k] = next
			next += defined(sizes[k])
		}
	}
	return withCopies(
		Arr.sort(
			Arr.map(Arr.range(0, rows - 1), (i): Bare => ({
				id: i,
				root: 0,
				parent: parentOf(i),
				at: i === 0 ? 0 : (i - 1) % fanout,
				children: kidsOf(i).length,
				start: defined(starts[i]),
				end: defined(starts[i]) + defined(sizes[i])
			})),
			Order.mapInput(Order.Number, (r: Bare) => r.start)
		)
	)
}

/**
 * The rows of one tree by depth, the root's alone first: each row one deeper than its parent, read in pre-order, which
 * puts every parent before its children.
 */
export const rowsByDepth = (
	rows: Arr.NonEmptyReadonlyArray<TreeRow>
): Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<TreeRow>> => {
	const depths = new Map<number, number>()
	for (const r of rows) {
		depths.set(r.id, r.parent === r.id ? 0 : defined(depths.get(r.parent), "a parent's depth") + 1)
	}
	const deepest = maxOf(depths.values(), 0)
	return nonEmpty(
		Arr.map(Arr.range(0, deepest), (depth) =>
			nonEmpty(
				Arr.filter(rows, (r) => depths.get(r.id) === depth),
				`a row at depth ${depth}`
			)
		),
		"the root's depth"
	)
}
