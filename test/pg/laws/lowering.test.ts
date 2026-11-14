/**
 * A containment into a derived relation, lowered to foreign keys, against the same containment discharged by triggers,
 * on PostgreSQL 19rc2.
 *
 * The theory lowers contained(on(S, s̄), on(D, h̄)) to native objects where D's definition meets seven conditions
 * (analysis/theory/laws.ts RuleLowering): each match of the definition a part, referenced from S by a foreign key
 * DEFERRABLE INITIALLY DEFERRED into a UNIQUE over the match's head and constant fields, S holding a `__tag_` constant
 * column for each constant. The oracle is the same schema installed through conservativeInstallation
 * (physical/install/compile.ts), every rule over a query discharged by its deferred constraint triggers, which the
 * rule-query suites hold to the rule's meaning. Each shape is its own search, its installations migrated into one
 * database under schemas of their own (test/support/install-migrate.ts installMigratedThrough) and dropped when it
 * ends; a lowered shape is installed again through each history (lowering-support.ts histories), so its declared keys'
 * indexes and its lowering's UNIQUE are created in every order a deployment creates them.
 *
 * - **The oracle, a second implementation:** each transaction of a case runs on the oracle and on every lowered
 *   installation of the shape, fresh and through each history. A direct SQL writer's transaction commits on one exactly when it commits on the other, and
 *   a refusal is at the same moment with the same SQLSTATE, its constraint mapped through each installation's own
 *   constraint map to the same law. A write grizzle serves on the lowered installation, a ChangeSet of inserts and
 *   deletes, is accepted exactly when the same facts written by SQL commit on the oracle, and a refusal names the law
 *   the oracle's refusal names, the rule's witnessed `unreported`, as the triggers' COMMIT is. After every case each
 *   table holds the same rows on both.
 * - **A duplicate names its key, by itself:** a statement the lowered installation refuses with 23505 writes a row
 *   that repeats an earlier row on a declared key, and the refusal names that key's law, never the rule's, whichever
 *   index PostgreSQL refused it on: PostgreSQL inserts a row's index entries in the order of their indexes' OIDs, and a
 *   history that creates the key after the lowering's UNIQUE over a superkey of it has that UNIQUE refuse it first. A
 *   served write a declared key refuses is witnessed at that key's fields of a row it inserts, never a superkey's.
 * - **A broken containment names the rule, by itself:** every 23503 on the lowered installation maps to the rule's law.
 * - **One decision in every order:** every installation of a shape, fresh and through each history, carries the rule
 *   by a foreign key exactly when the fresh one does, and the oracle by none. Which definitions the theory lowers is
 *   test/unit/laws/lowered-rules.test.ts's, the seven conditions restated over generated definitions; here a shape that
 *   lowers is held to the triggers' verdicts, whatever natives it lowers to.
 *
 * The box (lowering-support.ts): nineteen shapes of D, eight meant to meet every condition and eleven to fail exactly
 * one, each condition by at least one; A, B and S over small domains, so a draw reaches a source row with no target,
 * the delete of a target row a source row references, a target outside D's constants, a duplicate of a primary key and
 * of a candidate key beside a superkey of it; histories of up to six transactions of up to three statements, by SQL on
 * both installations or served by grizzle on the lowered one. A shape whose rule the fresh installation carries by a
 * foreign key is also installed through each history.
 *
 * Features: a committed source row, the rule refusing a source row's write and a target row's, a served write
 * accepted and refused by the rule; for a shape whose matches fix a constant, a target outside it refused; and, where
 * the fresh catalog holds a UNIQUE the lowering added over a superkey of a declared key, each duplicate beside it
 * (featuresOf), read off the catalog, never off a table of what each shape should lower to. Plants:
 * ~/.cache/grizzle-release/BR09/plants/lowering-condition-4-ignored.patch, a lowering that lets a variable of its own
 * be bound twice, lowers the existential shape to foreign keys that miss its join and admits a row the triggers
 * refuse; lowering-no-constant-column.patch, the lowering dropping the constant column, so the foreign key references
 * the target's key alone and admits a target row outside D's constants; and lowering-no-target-unique.patch, the
 * lowering omitting the UNIQUE its foreign key references, which no installation then accepts.
 */
import { type Case, drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Data, Effect, Formatter, Layer, Option, Record as Rec } from "effect"
import { Db } from "#adapter/public/db.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { constraintLaw } from "#compiler/ir/products.ts"
import type { CallError } from "#compiler/live/index.ts"
import {
	compileInstallation,
	conservativeInstallation
} from "#compiler/physical/install/compile.ts"
import { ChangeSet, type KeyHost, type Witness } from "#compiler/public/changeset.ts"
import {
	type Catalogued,
	cleared,
	constraintText,
	type Seat,
	sameRoles,
	seatOfInstalled
} from "#test/pg/fin/installed.ts"
import {
	A,
	B,
	firstVersion,
	fixedKinds,
	heads,
	histories,
	type LoweringSchema,
	loweringSchema,
	type Order,
	RELATIONS,
	S,
	type Shape,
	shapes
} from "#test/pg/laws/lowering-support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { deepEquals, defined } from "#test/support/assert.ts"
import { answered } from "#test/support/calls.ts"
import {
	type Installed,
	type InstallVersion,
	installMigratedThrough
} from "#test/support/install-migrate.ts"
import { caseHang } from "#test/support/limits.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgErrorFields } from "#test/support/pg.ts"
import { servedFixture } from "#test/support/served-db.ts"
import { type Attempted, attempt, momentText, refusalText } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** A refusal on the lowered installation that names another law than the one its own violation is of. */
class Misnamed extends Data.TaggedError("Misnamed")<{ readonly message: string }> {}

/** A row of A, B or S, by field. */
interface ARow {
	readonly id: number
	readonly kind: number
	readonly grp: number
	readonly v: number
	readonly txt: string
}
interface BRow {
	readonly id: number
	readonly grp: number
	readonly tag: number
}
interface SRow {
	readonly sid: number
	readonly x: number
	readonly y: number
}

/** One statement of a transaction: an insert of a row, a delete of a key, or an update of one non-key field. */
type Op =
	| { readonly rel: "A"; readonly kind: "insert"; readonly row: ARow }
	| { readonly rel: "B"; readonly kind: "insert"; readonly row: BRow }
	| { readonly rel: "S"; readonly kind: "insert"; readonly row: SRow }
	| { readonly rel: "A" | "B" | "S"; readonly kind: "delete"; readonly key: number }
	| {
			readonly rel: "A"
			readonly kind: "update"
			readonly key: number
			readonly field: "kind" | "grp" | "v" | "txt"
			readonly value: number | string
	  }
	| {
			readonly rel: "B"
			readonly kind: "update"
			readonly key: number
			readonly field: "grp" | "tag"
			readonly value: number
	  }
	| {
			readonly rel: "S"
			readonly kind: "update"
			readonly key: number
			readonly field: "x" | "y"
			readonly value: number
	  }

/** A change of an A row: its delete, or an update of one non-key field. */
type AChange =
	| { readonly kind: "delete" }
	| {
			readonly kind: "update"
			readonly field: "kind" | "grp" | "v" | "txt"
			readonly value: number | string
	  }

/**
 * A drawn statement, resolved against the case as it stands when it runs (resolved), each `pick` counted from the row
 * written last: an op; the change `by` of the A row the `pick`-th S row references, A's row `pick` where no S row is
 * stored, a target row's write under its sources; the insert of S row `sid` referencing the `pick`-th A row through
 * `via`, the row of keys `pick` where no A row is stored, a source row whose target may hold; or the insert of the
 * `pick`-th A or B row under key `id`, a row repeating a stored one on every field but its key.
 */
type Drawn =
	| Op
	| {
			readonly rel: "A"
			readonly kind: "unreference"
			readonly pick: number
			readonly by: AChange
	  }
	| {
			readonly rel: "S"
			readonly kind: "reference"
			readonly sid: number
			readonly pick: number
			readonly via: Via
	  }
	| { readonly rel: "A" | "B"; readonly kind: "copy"; readonly pick: number; readonly id: number }

/** The fields of the A row a reference copies into S's `x` and `y`: the shape's target terms (heads), or others. */
type Via =
	| { readonly kind: "head" }
	| { readonly kind: "fields"; readonly x: "id" | "grp"; readonly y: "id" | "grp" | "v" }

/** A transaction: its writer, SQL on both installations or grizzle's served write on the lowered one, and its ops. */
interface Tx {
	readonly writer: "sql" | "served"
	readonly ops: Arr.NonEmptyReadonlyArray<Drawn>
}

/** A case of a shape: its transactions, each run on every installation of the shape. */
interface LoweringCase {
	readonly history: Arr.NonEmptyReadonlyArray<Tx>
}

type Feature =
	| "committed a source row"
	| "refused by the rule, a source row's write"
	| "refused by the rule, a target row's write"
	| "refused by the rule on a target outside its constants"
	| "a primary key's duplicate refused beside its superkey"
	| `a candidate key's duplicate refused beside its superkey, installed ${Order}`
	| "a candidate key's duplicate refused on its superkey's index, under the key's law"
	| `a served candidate key's duplicate beside its superkey, witnessed at the key's fields, installed ${Order}`
	| "a served write accepted"
	| "a served write refused by the rule"

/** An A row over the box's domains, its key drawn apart from its group, or equal to it as the doubled shape matches. */
const aRow: Gen<ARow> = (s) => {
	const grp = s.draw(element([0, 1]))
	return {
		id: s.draw(
			weighted<number>([
				[2, (t) => t.draw(int(0, 2))],
				[1, () => grp]
			])
		),
		kind: s.draw(element([1, 2])),
		grp,
		v: s.draw(element([0, 1])),
		txt: s.draw(element(["a", "b"]))
	}
}
const bRow: Gen<BRow> = (s) => ({
	id: s.draw(int(0, 2)),
	grp: s.draw(element([0, 1])),
	tag: s.draw(
		weighted<number>([
			[3, () => 3],
			[1, () => 4]
		])
	)
})
const sRow: Gen<SRow> = (s) => ({
	sid: s.draw(int(0, 2)),
	x: s.draw(int(0, 2)),
	y: s.draw(int(0, 2))
})

const insertGen: Gen<Drawn> = weighted<Drawn>([
	[3, (s) => ({ rel: "A", kind: "insert", row: aRow(s) })],
	[2, (s) => ({ rel: "B", kind: "insert", row: bRow(s) })],
	[
		2,
		(s) => ({
			rel: s.draw(element(["A", "B"] as const)),
			kind: "copy",
			pick: s.draw(int(0, 2)),
			id: s.draw(int(0, 2))
		})
	],
	[2, (s) => ({ rel: "S", kind: "insert", row: sRow(s) })],
	[
		3,
		(s) => ({
			rel: "S",
			kind: "reference",
			sid: s.draw(int(0, 2)),
			pick: s.draw(int(0, 2)),
			via: s.draw(
				weighted<Via>([
					[3, () => ({ kind: "head" })],
					[
						1,
						(t) => ({
							kind: "fields",
							x: t.draw(element(["id", "grp"] as const)),
							y: t.draw(element(["id", "grp", "v"] as const))
						})
					]
				])
			)
		})
	]
])

/** An update of one non-key field of an A row, to a value of the field's domain. */
const aUpdateGen: Gen<Extract<AChange, { readonly kind: "update" }>> = (s) => {
	const field = s.draw(element(["kind", "grp", "v", "txt"] as const))
	return {
		kind: "update",
		field,
		value:
			field === "kind"
				? s.draw(element([1, 2]))
				: field === "txt"
					? s.draw(element(["a", "b"]))
					: s.draw(element([0, 1]))
	}
}

/** A write of the A row a stored S row references: its delete, or an update of one non-key field. */
const unreferenceGen: Gen<Drawn> = (s) => ({
	rel: "A",
	kind: "unreference",
	pick: s.draw(int(0, 2)),
	by: s.draw(
		weighted<AChange>([
			[2, () => ({ kind: "delete" })],
			[1, aUpdateGen]
		])
	)
})

const deleteGen: Gen<Drawn> = weighted<Drawn>([
	[1, (s) => ({ rel: "A", kind: "delete", key: s.draw(int(0, 2)) })],
	[2, unreferenceGen],
	[1, (s) => ({ rel: "B", kind: "delete", key: s.draw(int(0, 2)) })],
	[1, (s) => ({ rel: "S", kind: "delete", key: s.draw(int(0, 2)) })]
])

const updateGen: Gen<Drawn> = weighted<Drawn>([
	[2, (s) => ({ rel: "A", key: s.draw(int(0, 2)), ...s.draw(aUpdateGen) })],
	[
		1,
		(s) => {
			const field = s.draw(element(["grp", "tag"] as const))
			return {
				rel: "B",
				kind: "update",
				key: s.draw(int(0, 2)),
				field,
				value: field === "grp" ? s.draw(element([0, 1])) : s.draw(element([3, 4]))
			}
		}
	],
	[
		2,
		(s) => ({
			rel: "S",
			kind: "update",
			key: s.draw(int(0, 2)),
			field: s.draw(element(["x", "y"] as const)),
			value: s.draw(int(0, 2))
		})
	]
])

/** A transaction's ops: one, then up to two more, each of `op`. */
const opsOf = (s: Parameters<Gen<Drawn>>[0], op: Gen<Drawn>): Arr.NonEmptyReadonlyArray<Drawn> => [
	s.draw(op),
	...s.draw(array(op, { min: 0, max: 2 }))
]

const sqlTx: Gen<Tx> = (s) => ({
	writer: "sql",
	ops: opsOf(
		s,
		weighted<Drawn>([
			[4, insertGen],
			[2, deleteGen],
			[2, updateGen]
		])
	)
})

/**
 * A transaction that builds a source row's target and the row: an A row, a B row, and an S row referencing the A row
 * written last through the shape's target terms.
 */
const buildTx: Gen<Tx> = (s) => ({
	writer: "sql",
	ops: [
		{ rel: "A", kind: "insert", row: aRow(s) },
		{ rel: "B", kind: "insert", row: bRow(s) },
		{ rel: "S", kind: "reference", sid: s.draw(int(0, 2)), pick: 0, via: { kind: "head" } }
	]
})

/** A target write: of an A row a stored S row references, or of a B row. */
const targetGen: Gen<Drawn> = weighted<Drawn>([
	[4, unreferenceGen],
	[1, (s) => ({ rel: "B", kind: "insert", row: bRow(s) })],
	[1, (s) => ({ rel: "B", kind: "delete", key: s.draw(int(0, 2)) })],
	[
		1,
		(s) => ({
			rel: "B",
			kind: "update",
			key: s.draw(int(0, 2)),
			field: "grp",
			value: s.draw(element([0, 1]))
		})
	]
])

/** A transaction of target writes alone. */
const targetTx: Gen<Tx> = (s) => ({ writer: "sql", ops: opsOf(s, targetGen) })

const servedTx: Gen<Tx> = (s) => ({
	writer: "served",
	ops: opsOf(
		s,
		weighted<Drawn>([
			[3, insertGen],
			[1, deleteGen]
		])
	)
})

const txGen: Gen<Tx> = weighted<Tx>([
	[3, sqlTx],
	[2, servedTx],
	[2, buildTx],
	[2, targetTx]
])

const caseGen: Gen<LoweringCase> = (s) => ({
	history: [s.draw(txGen), ...s.draw(array(txGen, { min: 0, max: 5 }))]
})

/** The rows every stored relation holds, by key. */
interface State {
	readonly A: ReadonlyMap<number, ARow>
	readonly B: ReadonlyMap<number, BRow>
	readonly S: ReadonlyMap<number, SRow>
}

const emptyState: State = { A: new Map(), B: new Map(), S: new Map() }

/** A map with `key` set to `value`, or deleted where `value` is undefined. */
const withEntry = <K, V>(
	map: ReadonlyMap<K, V>,
	key: K,
	value: V | undefined
): ReadonlyMap<K, V> => {
	const next = new Map(map)
	if (value === undefined) {
		next.delete(key)
	} else {
		next.set(key, value)
	}
	return next
}

/** The state SQL leaves when every op of `ops` succeeds, in order: what a committed SQL transaction stored. */
const sqlAfter = (state: State, ops: ReadonlyArray<Op>): State =>
	Arr.reduce(ops, state, (st, op): State => {
		switch (op.kind) {
			case "insert":
				switch (op.rel) {
					case "A":
						return { ...st, A: withEntry(st.A, op.row.id, op.row) }
					case "B":
						return { ...st, B: withEntry(st.B, op.row.id, op.row) }
					case "S":
						return { ...st, S: withEntry(st.S, op.row.sid, op.row) }
				}
			case "delete":
				switch (op.rel) {
					case "A":
						return { ...st, A: withEntry(st.A, op.key, undefined) }
					case "B":
						return { ...st, B: withEntry(st.B, op.key, undefined) }
					case "S":
						return { ...st, S: withEntry(st.S, op.key, undefined) }
				}
			case "update":
				switch (op.rel) {
					case "A": {
						const row = st.A.get(op.key)
						return row === undefined
							? st
							: { ...st, A: withEntry(st.A, op.key, { ...row, [op.field]: op.value }) }
					}
					case "B": {
						const row = st.B.get(op.key)
						return row === undefined
							? st
							: { ...st, B: withEntry(st.B, op.key, { ...row, [op.field]: op.value }) }
					}
					case "S": {
						const row = st.S.get(op.key)
						return row === undefined
							? st
							: { ...st, S: withEntry(st.S, op.key, { ...row, [op.field]: op.value }) }
					}
				}
		}
	})

/** The `pick`-th row of `rows` counting from the one written last, none where it holds none. */
const newest = <V>(rows: ReadonlyMap<number, V>, pick: number): Option.Option<V> =>
	Arr.get(Arr.reverse([...rows.values()]), pick % Math.max(1, rows.size))

/** The op a drawn statement is over `state` in a case of `shape` (Drawn). */
const resolvedOp = (shape: Shape, state: State, d: Drawn): Op => {
	switch (d.kind) {
		case "unreference": {
			const head = heads[shape]
			const rows = [...state.A.values()]
			const key = Option.match(newest(state.S, d.pick), {
				onNone: () => d.pick,
				onSome: (r) =>
					Option.getOrElse(
						Option.orElse(
							Arr.findFirst(rows, (a) => a[head.x] === r.x && a[head.y] === r.y),
							() => Arr.findFirst(rows, (a) => a[head.x] === r.x)
						).pipe(Option.map((a) => a.id)),
						() => r.x
					)
			})
			return d.by.kind === "delete"
				? { rel: "A", kind: "delete", key }
				: { rel: "A", kind: "update", key, field: d.by.field, value: d.by.value }
		}
		case "reference": {
			const target = newest(state.A, d.pick)
			const via = d.via.kind === "head" ? heads[shape] : d.via
			return {
				rel: "S",
				kind: "insert",
				row: {
					sid: d.sid,
					x: Option.match(target, { onNone: () => d.pick, onSome: (a) => a[via.x] }),
					y: Option.match(target, { onNone: () => d.pick, onSome: (a) => a[via.y] })
				}
			}
		}
		case "copy":
			return d.rel === "A"
				? {
						rel: "A",
						kind: "insert",
						row: Option.match(newest(state.A, d.pick), {
							onNone: () => ({ id: d.id, kind: 2, grp: 0, v: 0, txt: "a" }),
							onSome: (a) => ({ ...a, id: d.id })
						})
					}
				: {
						rel: "B",
						kind: "insert",
						row: Option.match(newest(state.B, d.pick), {
							onNone: () => ({ id: d.id, grp: 0, tag: 3 }),
							onSome: (b) => ({ ...b, id: d.id })
						})
					}
		case "insert":
		case "delete":
		case "update":
			return d
	}
}

/**
 * The ops a transaction's drawn statements are over `state` in a case of `shape`, each over the state the ones before
 * it leave.
 */
const resolved = (shape: Shape, state: State, ops: ReadonlyArray<Drawn>): ReadonlyArray<Op> => {
	const out: Array<Op> = []
	let at = state
	for (const d of ops) {
		const op = resolvedOp(shape, at, d)
		out.push(op)
		at = sqlAfter(at, [op])
	}
	return out
}

/**
 * The facts a served write states for `ops` over `state`: each insert of a key the state does not hold and each delete
 * of one it holds, the earlier of two ops at one key kept; a ChangeSet states a fact once, so an op at a key an earlier
 * op of the transaction wrote is dropped. Undefined where none is left.
 */
interface ServedFacts {
	readonly insert: {
		readonly A: ReadonlyArray<ARow>
		readonly B: ReadonlyArray<BRow>
		readonly S: ReadonlyArray<SRow>
	}
	readonly delete: {
		readonly A: ReadonlyArray<ARow>
		readonly B: ReadonlyArray<BRow>
		readonly S: ReadonlyArray<SRow>
	}
}

const servedFactsOf = (state: State, ops: ReadonlyArray<Op>): ServedFacts | undefined => {
	const touched = { A: new Set<number>(), B: new Set<number>(), S: new Set<number>() }
	const insert = { A: new Array<ARow>(), B: new Array<BRow>(), S: new Array<SRow>() }
	const removed = { A: new Array<ARow>(), B: new Array<BRow>(), S: new Array<SRow>() }
	for (const op of ops) {
		const key = op.kind === "insert" ? keyOfRow(op) : op.key
		if (touched[op.rel].has(key)) {
			continue
		}
		touched[op.rel].add(key)
		switch (op.kind) {
			case "insert":
				switch (op.rel) {
					case "A":
						if (!state.A.has(op.row.id)) {
							insert.A.push(op.row)
						}
						break
					case "B":
						if (!state.B.has(op.row.id)) {
							insert.B.push(op.row)
						}
						break
					case "S":
						if (!state.S.has(op.row.sid)) {
							insert.S.push(op.row)
						}
						break
				}
				break
			case "delete": {
				switch (op.rel) {
					case "A": {
						const row = state.A.get(op.key)
						if (row !== undefined) {
							removed.A.push(row)
						}
						break
					}
					case "B": {
						const row = state.B.get(op.key)
						if (row !== undefined) {
							removed.B.push(row)
						}
						break
					}
					case "S": {
						const row = state.S.get(op.key)
						if (row !== undefined) {
							removed.S.push(row)
						}
						break
					}
				}
				break
			}
			case "update":
				break
		}
	}
	const count =
		insert.A.length +
		insert.B.length +
		insert.S.length +
		removed.A.length +
		removed.B.length +
		removed.S.length
	return count === 0 ? undefined : { insert, delete: removed }
}

const keyOfRow = (op: Extract<Op, { readonly kind: "insert" }>): number =>
	op.rel === "S" ? op.row.sid : op.row.id

/** The served facts as SQL ops, every delete before every insert, as the oracle writes them. */
const servedOps = (facts: ServedFacts): ReadonlyArray<Op> => [
	...Arr.map(facts.delete.S, (r): Op => ({ rel: "S", kind: "delete", key: r.sid })),
	...Arr.map(facts.delete.A, (r): Op => ({ rel: "A", kind: "delete", key: r.id })),
	...Arr.map(facts.delete.B, (r): Op => ({ rel: "B", kind: "delete", key: r.id })),
	...Arr.map(facts.insert.A, (row): Op => ({ rel: "A", kind: "insert", row })),
	...Arr.map(facts.insert.B, (row): Op => ({ rel: "B", kind: "insert", row })),
	...Arr.map(facts.insert.S, (row): Op => ({ rel: "S", kind: "insert", row }))
]

/** A literal of a field's value: an integer as it is, a text quoted. */
const sqlLiteral = (value: number | string): string =>
	typeof value === "number" ? String(value) : `'${value}'`

/** The key field of a relation. */
const keyField = (rel: "A" | "B" | "S"): string => (rel === "S" ? "sid" : "id")

/** An inserted row's fields with their values, in declared order. */
const entriesOf = (
	op: Extract<Op, { readonly kind: "insert" }>
): ReadonlyArray<readonly [string, number | string]> => {
	switch (op.rel) {
		case "A":
			return Rec.toEntries(op.row)
		case "B":
			return Rec.toEntries(op.row)
		case "S":
			return Rec.toEntries(op.row)
	}
}

/** A row's values by field, as a key witness holds them. */
type Fields = ReadonlyMap<string, KeyHost>

/** Every row a state holds of a relation, by key. */
const rowsOf = (state: State, rel: "A" | "B" | "S"): ReadonlyArray<readonly [number, Fields]> => {
	switch (rel) {
		case "A":
			return Arr.map([...state.A], ([k, row]) => [k, new Map(Rec.toEntries(row))] as const)
		case "B":
			return Arr.map([...state.B], ([k, row]) => [k, new Map(Rec.toEntries(row))] as const)
		case "S":
			return Arr.map([...state.S], ([k, row]) => [k, new Map(Rec.toEntries(row))] as const)
	}
}

/** Whether two rows hold one value at every field of `columns`. */
const sameAt = (a: Fields, b: Fields, columns: ReadonlyArray<string>): boolean =>
	Arr.every(columns, (column) => {
		const value = a.get(column)
		return value !== undefined && value === b.get(column)
	})

/** An op as one SQL statement on `seat`'s installation, its tables and columns that installation's own. */
const statementOf = (seat: Seat, op: Op): string => {
	const table = seat.table(op.rel)
	const col = (field: string): string => seat.column(op.rel, field)
	switch (op.kind) {
		case "insert": {
			const entries = entriesOf(op)
			return `INSERT INTO ${table} (${Arr.join(
				Arr.map(entries, ([f]) => col(f)),
				", "
			)}) VALUES (${Arr.join(
				Arr.map(entries, ([, value]) => sqlLiteral(value)),
				", "
			)})`
		}
		case "delete":
			return `DELETE FROM ${table} WHERE ${col(keyField(op.rel))} = ${String(op.key)}`
		case "update":
			return `UPDATE ${table} SET ${col(op.field)} = ${sqlLiteral(op.value)} WHERE ${col(keyField(op.rel))} = ${String(op.key)}`
	}
}

/** The law a refusal names through `installed`'s own constraint map, by its table and constraint. */
const lawOf = (installed: Installed, fields: PgErrorFields): LawId | undefined => {
	const constraint = fields.constraint
	const table = Option.flatMap(fields.table, (ident) =>
		Arr.findFirst(RELATIONS, (rel) => installed.names.relation(rel).name === ident)
	)
	return Option.isNone(table) || constraint === undefined
		? undefined
		: constraintLaw(
				installed.installation.constraintToLaw,
				{ kind: "table", name: installed.names.relation(table.value).name },
				constraint
			)
}

/** The one rule over a query of an installation: the containment of S in D. */
const ruleLaw = (installed: Installed): LawId =>
	defined(
		Arr.findFirst(installed.installation.laws.theory.laws, (l) => l.detail.kind === "rule").pipe(
			Option.map((l) => l.id),
			Option.getOrUndefined
		),
		"the containment of S in D, a rule over a query"
	)

/** The relation of the box a catalogued constraint lives on, none for any other. */
const relationOf = (c: Catalogued): Option.Option<"A" | "B" | "S"> =>
	Arr.findFirst(RELATIONS, (r) => r === c.relation)

/**
 * The UNIQUEs an installation's lowering added beside its declared keys: each unique constraint of A, B or S over no
 * declared key's fields, with the declared keys of its relation it holds whole, as the catalog states them.
 */
const superkeysOf = (
	seat: Seat
): ReadonlyArray<{ readonly unique: Catalogued; readonly holds: ReadonlyArray<DeclaredKey> }> =>
	Arr.flatMap(seat.constraints, (c) =>
		Option.match(relationOf(c), {
			onNone: () => [],
			onSome: (relation) => {
				const declared = declaredKeysOf(seat.installed, relation)
				return (c.kind === "unique" || c.kind === "primary") &&
					!Arr.some(declared, (k) => sameRoles(c.columns, k.fields))
					? [
							{
								unique: c,
								holds: Arr.filter(declared, (k) =>
									Arr.every(k.fields, (f) => c.columns.includes(f))
								)
							}
						]
					: []
			}
		})
	)

/**
 * What a search of a shape must reach: a committed source row, the rule refusing a source row's write and a target
 * row's, a served write accepted and refused by the rule; a shape whose matches fix a constant refusing a target outside
 * it; where the lowering added a UNIQUE over a superkey of a primary key, a duplicate of that key beside it; and where it
 * added one over a superkey of a candidate key and no primary key, in every order the shape is installed in, a direct
 * and a served duplicate of the candidate key beside it, and one PostgreSQL refuses on that UNIQUE's index, which
 * keyChanged's history creates before the key's. Each UNIQUE is read off the fresh installation's catalog.
 */
const featuresOf = (pair: Pair): Arr.NonEmptyReadonlyArray<Feature> => {
	const superkeys = superkeysOf(pair.fresh)
	const holding = (primary: boolean) =>
		Arr.some(superkeys, (u) =>
			primary
				? Arr.some(u.holds, (k) => k.primary)
				: Arr.some(u.holds, (k) => !k.primary) && !Arr.some(u.holds, (k) => k.primary)
		)
	const installed = [...pair.lows.keys()]
	return [
		"committed a source row",
		"refused by the rule, a source row's write",
		"refused by the rule, a target row's write",
		"a served write accepted",
		"a served write refused by the rule",
		...(Option.isSome(fixedKinds[pair.shape])
			? ["refused by the rule on a target outside its constants" as const]
			: []),
		...(holding(true) ? ["a primary key's duplicate refused beside its superkey" as const] : []),
		...(holding(false)
			? [
					...Arr.map(
						installed,
						(o) =>
							`a candidate key's duplicate refused beside its superkey, installed ${o}` as const
					),
					...Arr.map(
						installed,
						(o) =>
							`a served candidate key's duplicate beside its superkey, witnessed at the key's fields, installed ${o}` as const
					),
					"a candidate key's duplicate refused on its superkey's index, under the key's law" as const
				]
			: [])
	]
}

/** Whether an installed catalog holds a foreign key carrying its installation's rule. */
const carriedByForeignKey = (seat: Seat): boolean => {
	const rule = ruleLaw(seat.installed)
	return Arr.some(
		seat.constraints,
		(c) => c.kind === "foreign" && Option.exists(c.law, (l) => l === rule)
	)
}

/** A transaction's refusal. */
type Refused = Extract<Attempted, { readonly kind: "refused" }>

/** A key a schema declares on a relation, its primary key or a candidate key: its fields, and its law. */
interface DeclaredKey {
	readonly relation: "A" | "B" | "S"
	readonly fields: ReadonlyArray<string>
	readonly law: LawId
	readonly primary: boolean
}

/** The keys an installation's theory declares on `relation`, its primary key first. */
const declaredKeysOf = (
	installed: Installed,
	relation: "A" | "B" | "S"
): ReadonlyArray<DeclaredKey> => {
	const theory = installed.installation.laws.theory
	return [
		...Arr.flatMap(theory.primaryKeys, (p) =>
			p.relation.name === relation
				? [
						{
							relation,
							fields: Arr.map(p.relation.primaryFields, (f) => f.name),
							law: p.law.id,
							primary: true
						}
					]
				: []
		),
		...Arr.flatMap(theory.laws, (l) =>
			l.detail.kind === "key" && !l.detail.key.primary && l.detail.relation === relation
				? [
						{
							relation,
							fields: Arr.map(l.detail.key.fields, (f) => f.name),
							law: l.id,
							primary: false
						}
					]
				: []
		)
	]
}

/**
 * The declared keys of a relation, and the UNIQUEs the lowering added over a superkey of one, on whose fields a written
 * row repeats one of `others`.
 */
interface Duplicated {
	readonly keys: ReadonlyArray<DeclaredKey>
	readonly lowerings: ReadonlyArray<Catalogued>
}

const duplicatedOn = (
	seat: Seat,
	relation: "A" | "B" | "S",
	written: Fields,
	others: ReadonlyArray<Fields>
): Duplicated => {
	const repeats = (columns: ReadonlyArray<string>): boolean =>
		Arr.some(others, (other) => sameAt(other, written, columns))
	const declared = declaredKeysOf(seat.installed, relation)
	return {
		keys: Arr.filter(declared, (k) => repeats(k.fields)),
		lowerings: Arr.filter(
			seat.constraints,
			(c) =>
				c.relation === relation &&
				(c.kind === "primary" || c.kind === "unique") &&
				!Arr.some(declared, (k) => sameRoles(c.columns, k.fields)) &&
				repeats(c.columns)
		)
	}
}

/**
 * The refusal of a duplicate on a lowered installation, judged by itself: the statement refused with 23505 writes a
 * row that repeats a row `before` holds on the fields of a declared key, and the refusal names that key's law, never
 * the rule's, whichever index PostgreSQL refused it on. Judged keyed, with whether the key is the primary key, whether
 * the row repeats one on a UNIQUE the lowering added over a superkey of it too, and whether PostgreSQL refused it on
 * that UNIQUE's index; or misnamed, with what it named.
 */
type KeyJudgement =
	| {
			readonly kind: "keyed"
			readonly primary: boolean
			readonly beside: boolean
			readonly onSuperkey: boolean
	  }
	| { readonly kind: "misnamed"; readonly message: string }

const keyJudgement = (
	seat: Seat,
	state: State,
	ops: ReadonlyArray<Op>,
	refused: Refused
): KeyJudgement => {
	const index = refused.moment.kind === "statement" ? refused.moment.index : ops.length
	const before = sqlAfter(state, Arr.take(ops, index))
	const op = Arr.get(ops, index)
	const duplicated = Option.match(
		Option.flatMap(op, (o) => {
			if (o.kind === "delete") {
				return Option.none()
			}
			const key = o.kind === "insert" ? keyOfRow(o) : o.key
			return Option.map(
				Arr.findFirst(rowsOf(sqlAfter(before, [o]), o.rel), ([k]) => k === key),
				([, fields]) =>
					duplicatedOn(
						seat,
						o.rel,
						fields,
						Arr.map(
							Arr.filter(rowsOf(before, o.rel), ([k]) => o.kind === "insert" || k !== key),
							([, other]) => other
						)
					)
			)
		}),
		{ onNone: (): Duplicated => ({ keys: [], lowerings: [] }), onSome: (d) => d }
	)
	const law = lawOf(seat.installed, refused.fields)
	const named = seat.refusedBy(refused.fields)
	const key = Arr.findFirst(duplicated.keys, (k) => k.law === law)
	if (Option.isSome(key)) {
		return {
			kind: "keyed",
			primary: key.value.primary,
			beside: duplicated.lowerings.length > 0,
			onSuperkey: Option.exists(named, (c) =>
				Arr.some(duplicated.lowerings, (l) => l.name === c.name)
			)
		}
	}
	const statement = Option.match(op, {
		onNone: () => "the COMMIT",
		onSome: (o) => statementOf(seat, o)
	})
	const keys =
		duplicated.keys.length === 0
			? "no declared key"
			: Arr.join(
					Arr.map(duplicated.keys, (k) => `the key (${Arr.join(k.fields, ", ")}) of law ${k.law}`),
					" and "
				)
	const by = Option.match(named, {
		onNone: () => "a constraint the catalog does not hold",
		onSome: constraintText
	})
	return {
		kind: "misnamed",
		message: `${statement} repeats ${keys}, and is refused by ${by} naming law ${law ?? "none"}: ${refusalText(refused.fields)}`
	}
}

/**
 * The declared keys a served write's facts break over `state`: each key of a relation on whose fields a row the facts
 * insert repeats another row the relation holds once the facts' deletes are made, stored or inserted beside it.
 */
const brokenKeysOf = (
	installed: Installed,
	state: State,
	facts: ServedFacts
): ReadonlyArray<DeclaredKey> => {
	const kept = sqlAfter(
		state,
		Arr.filter(servedOps(facts), (op) => op.kind === "delete")
	)
	return Arr.flatMap(RELATIONS, (rel) => {
		const inserted = insertedOf(facts, rel)
		const stored = Arr.map(rowsOf(kept, rel), ([, fields]) => fields)
		return Arr.filter(declaredKeysOf(installed, rel), (k) =>
			Arr.some(inserted, (row, i) =>
				Arr.some([...stored, ...Arr.filter(inserted, (_, j) => j !== i)], (other) =>
					sameAt(other, row, k.fields)
				)
			)
		)
	})
}

/** Every row a served write's facts insert into a relation, each its fields. */
const insertedOf = (facts: ServedFacts, rel: "A" | "B" | "S"): ReadonlyArray<Fields> => {
	switch (rel) {
		case "A":
			return Arr.map(facts.insert.A, (row) => new Map(Rec.toEntries(row)))
		case "B":
			return Arr.map(facts.insert.B, (row) => new Map(Rec.toEntries(row)))
		case "S":
			return Arr.map(facts.insert.S, (row) => new Map(Rec.toEntries(row)))
	}
}

/**
 * The served refusal of a duplicate of a declared key, judged by its witness: the key's relation, and the key's fields
 * exactly, holding the values of a row the write inserts that repeats a row stored or inserted beside it there, never a
 * superkey's. Judged witnessed, with whether that row repeats one on a UNIQUE the lowering added over a superkey of the
 * key too; or misnamed, with the witness.
 */
type WitnessJudgement =
	| { readonly kind: "witnessed"; readonly beside: boolean }
	| { readonly kind: "misnamed"; readonly message: string }

const witnessJudgement = (
	seat: Seat,
	key: DeclaredKey,
	state: State,
	facts: ServedFacts,
	witness: Witness
): WitnessJudgement => {
	const inserted = insertedOf(facts, key.relation)
	const stored = Arr.map(rowsOf(state, key.relation), ([, fields]) => fields)
	const values: Fields = new Map(witness.kind === "key" ? Rec.toEntries(witness.values) : [])
	const row = Arr.findFirst(
		Arr.map(inserted, (fields, i) => ({
			fields,
			others: [...stored, ...Arr.filter(inserted, (_, j) => j !== i)]
		})),
		(r) =>
			witness.kind === "key" &&
			witness.relation === key.relation &&
			sameRoles([...values.keys()], key.fields) &&
			sameAt(r.fields, values, key.fields) &&
			Arr.some(r.others, (other) => sameAt(other, r.fields, key.fields))
	)
	return Option.match(row, {
		onNone: (): WitnessJudgement => ({
			kind: "misnamed",
			message: `the served refusal of the key (${Arr.join(key.fields, ", ")}) of law ${key.law} is witnessed ${Formatter.format(witness)}, not at the key's fields of a row it inserts that repeats one`
		}),
		onSome: (r): WitnessJudgement => ({
			kind: "witnessed",
			beside: duplicatedOn(seat, key.relation, r.fields, r.others).lowerings.length > 0
		})
	})
}

/** A lowered installation of a shape in one order: its seat, and the served write of its login. */
interface LoweredInstall {
	readonly seat: Seat
	readonly write: (facts: ServedFacts) => Effect.Effect<ServedOutcome, CallError>
}

/** A shape's installations: the lowered one fresh and in each order it is installed in, and the oracle's seat. */
interface Pair {
	readonly shape: Shape
	readonly fresh: Seat
	readonly lows: ReadonlyMap<Order, LoweredInstall>
	readonly oracle: Seat
}

/** What a served write answered, as the comparison reads it. */
type ServedOutcome =
	| { readonly kind: "accepted" }
	| {
			readonly kind: "refused"
			readonly laws: ReadonlyArray<LawId | string>
			readonly witness: Witness
	  }
	| { readonly kind: "other"; readonly text: string }

/** The full role's workload: one ChangeSet that inserts and deletes rows of A, B and S, from its call's facts. */
const programsOf = (value: LoweringSchema) => ({
	write: ChangeSet.empty(value)
		.delete(S, [])
		.delete(A, [])
		.delete(B, [])
		.insert(A, [])
		.insert(B, [])
		.insert(S, [])
})

/** Every row of each stored relation on `seat`, in key order, each a text of its fields in declared order. */
const rowsOn = (seat: Seat) =>
	Effect.forEach(RELATIONS, (rel) =>
		seat.session.values(
			`SELECT ${Arr.join(
				Arr.map(fieldsOf(rel), (f) => seat.column(rel, f)),
				", "
			)} FROM ${seat.table(rel)} ORDER BY ${seat.column(rel, keyField(rel))}`,
			[]
		)
	)

const fieldsOf = (rel: "A" | "B" | "S"): ReadonlyArray<string> => {
	switch (rel) {
		case "A":
			return ["id", "kind", "grp", "v", "txt"]
		case "B":
			return ["id", "grp", "tag"]
		case "S":
			return ["sid", "x", "y"]
	}
}

/** Whether two SQL verdicts agree: both committed, or both refused at one moment with one SQLSTATE naming one law. */
const sameVerdict = (
	low: Attempted,
	oracle: Attempted,
	lawLow: LawId | undefined,
	lawOracle: LawId | undefined
): boolean => {
	if (low.kind === "committed" || oracle.kind === "committed") {
		return low.kind === oracle.kind
	}
	return (
		momentText(low.moment) === momentText(oracle.moment) &&
		low.fields.code === oracle.fields.code &&
		lawLow !== undefined &&
		lawLow === lawOracle
	)
}

/**
 * The lowered installation of `shape` reached by `versions`, the last of them the shape's schema with the full login:
 * its catalog read on a seat, and the served write of its login's full role.
 */
const loweredInstall = (
	shape: Shape,
	order: Order,
	versions: Arr.NonEmptyReadonlyArray<InstallVersion>
) =>
	Effect.gen(function* () {
		const installed = yield* installMigratedThrough(versions, {
			label: "lowering",
			extensions: [],
			ambient: ordinarySession,
			compile: compileInstallation
		})
		const value = loweringSchema(shape, installed.schema)
		const served = yield* servedFixture(installed, fullWorld(value, programsOf(value)).server)
		const context = yield* Layer.build(served.layer)
		const db = yield* Db.open(served.login.roles.app, {}).pipe(Effect.provideContext(context))
		const low: LoweredInstall = {
			seat: yield* seatOfInstalled(installed, RELATIONS, `lowering_${order}`),
			write: (facts) =>
				Effect.map(
					answered(db.workload.write.once({ params: {}, facts: facts })),
					(outcome): ServedOutcome => {
						switch (outcome.kind) {
							case "accepted":
							case "unchanged":
								return { kind: "accepted" }
							case "refused":
								return {
									kind: "refused",
									laws: Arr.map(outcome.refused.laws, (r) => r.id),
									witness: outcome.witness
								}
							case "outsideWorld":
								return { kind: "other", text: Formatter.format(outcome) }
						}
					}
				)
		}
		return low
	})

/**
 * A shape's installations, as its search reads them: the lowered one fresh, and through every history for a lowered
 * shape, and the oracle's. Each is installed in the search's scope and dropped with it, so the searches of the shapes
 * hold one shape's sessions at a time.
 */
const pairOf = (shape: Shape) =>
	Effect.gen(function* () {
		const lastOf = (name: string): InstallVersion => {
			const declared = loweringSchema(shape, name)
			return {
				schema: declared,
				logins: [fullWorld(declared, {}).server],
				declarations: noDeclarations
			}
		}
		const fresh = yield* loweredInstall(shape, "fresh", [lastOf("Lowering")])
		const lows = new Map<Order, LoweredInstall>([["fresh", fresh]])
		const lowered = carriedByForeignKey(fresh.seat)
		for (const history of lowered ? histories : []) {
			const reached = yield* loweredInstall(shape, history, [
				{
					schema: firstVersion(history, shape, "Lowering"),
					logins: [],
					declarations: noDeclarations
				},
				lastOf("Lowering")
			])
			lows.set(history, reached)
		}
		const oracle = yield* installMigratedThrough(
			[
				{
					schema: loweringSchema(shape, "LoweringOracle"),
					logins: [],
					declarations: noDeclarations
				}
			],
			{
				label: "lowering_oracle",
				extensions: [],
				ambient: ordinarySession,
				compile: conservativeInstallation
			}
		)
		for (const [order, low] of lows) {
			if (carriedByForeignKey(low.seat) !== lowered) {
				return yield* new Disagreed({
					message: `${shape}, installed ${order}: the installed rule ${lowered ? "carried by no" : "carried by a"} foreign key, where the fresh installation's is ${lowered ? "" : "not "}carried by one`
				})
			}
		}
		const oracleSeat = yield* seatOfInstalled(oracle, RELATIONS, "lowering_oracle")
		if (carriedByForeignKey(oracleSeat)) {
			return yield* new Disagreed({
				message: `${shape}: the oracle's installed rule carried by a foreign key`
			})
		}
		const pair: Pair = { shape, fresh: fresh.seat, lows, oracle: oracleSeat }
		return pair
	})

/** What a case of `pair`'s shape holds to, as the header states it, noting what it reached. */
const property = (pair: Pair) => (lc: LoweringCase, c: Case<Feature>) =>
	Effect.gen(function* () {
		const shape = pair.shape
		const oracle = pair.oracle
		for (const low of pair.lows.values()) {
			yield* cleared(low.seat, RELATIONS)
		}
		yield* cleared(oracle, RELATIONS)
		const rule = ruleLaw(oracle.installed)
		let state: State = emptyState
		for (const tx of lc.history) {
			const ops = resolved(shape, state, tx.ops)
			if (tx.writer === "served") {
				const facts = servedFactsOf(state, ops)
				if (facts === undefined) {
					continue
				}
				const verdict = yield* attempt(
					oracle.session,
					Arr.map(servedOps(facts), (op) => statementOf(oracle, op))
				)
				const oracleLaw =
					verdict.kind === "refused" ? lawOf(oracle.installed, verdict.fields) : undefined
				const broken = brokenKeysOf(oracle.installed, state, facts)
				const breaks = (law: LawId | string | undefined): boolean =>
					broken.length === 0 ? law === oracleLaw : Arr.some(broken, (k) => k.law === law)
				if (verdict.kind === "refused" && !breaks(oracleLaw)) {
					return yield* new Disagreed({
						message: `${shape}: the triggers' installation ${verdictText(verdict, oracleLaw)}, where the facts break the keys ${Formatter.format(Arr.map(broken, (k) => k.law))}: ${Formatter.format(facts)}`
					})
				}
				for (const [order, low] of pair.lows) {
					const outcome = yield* low.write(facts)
					if (verdict.kind === "committed" && outcome.kind === "accepted") {
						continue
					}
					if (
						verdict.kind === "committed" ||
						outcome.kind !== "refused" ||
						!Arr.isReadonlyArrayNonEmpty(outcome.laws) ||
						!Arr.every(outcome.laws, breaks) ||
						(outcome.laws.includes(rule) && outcome.witness.kind !== "unreported")
					) {
						return yield* new Disagreed({
							message: `${shape}, installed ${order}: grizzle's served write answered ${Formatter.format(outcome)}, where the triggers' installation ${verdictText(verdict, oracleLaw)}: ${Formatter.format(facts)}`
						})
					}
					const key = Arr.findFirst(broken, (k) => outcome.laws.includes(k.law))
					if (Option.isSome(key)) {
						const judged = witnessJudgement(low.seat, key.value, state, facts, outcome.witness)
						if (judged.kind === "misnamed") {
							return yield* new Misnamed({
								message: `${shape}, installed ${order}: ${judged.message}: ${Formatter.format(facts)}`
							})
						}
						if (judged.beside && !key.value.primary) {
							c.note(
								`a served candidate key's duplicate beside its superkey, witnessed at the key's fields, installed ${order}`
							)
						}
					}
				}
				if (verdict.kind === "committed") {
					state = sqlAfter(state, servedOps(facts))
					c.note("a served write accepted")
					if (facts.insert.S.length > 0) {
						c.note("committed a source row")
					}
				} else if (oracleLaw === rule) {
					c.note("a served write refused by the rule")
				}
				continue
			}
			const onOracle = yield* attempt(
				oracle.session,
				Arr.map(ops, (op) => statementOf(oracle, op))
			)
			const lawOracle =
				onOracle.kind === "refused" ? lawOf(oracle.installed, onOracle.fields) : undefined
			for (const [order, low] of pair.lows) {
				const seat = low.seat
				const onLow = yield* attempt(
					seat.session,
					Arr.map(ops, (op) => statementOf(seat, op))
				)
				const lawLow = onLow.kind === "refused" ? lawOf(seat.installed, onLow.fields) : undefined
				if (onLow.kind === "refused" && onLow.fields.code === "23505") {
					const judged = keyJudgement(seat, state, ops, onLow)
					if (judged.kind === "misnamed") {
						return yield* new Misnamed({
							message: `${shape}, installed ${order}: ${judged.message}`
						})
					}
					if (judged.beside) {
						c.note(
							judged.primary
								? "a primary key's duplicate refused beside its superkey"
								: `a candidate key's duplicate refused beside its superkey, installed ${order}`
						)
					}
					if (judged.onSuperkey && !judged.primary) {
						c.note(
							"a candidate key's duplicate refused on its superkey's index, under the key's law"
						)
					}
				}
				if (onLow.kind === "refused" && onLow.fields.code === "23503" && lawLow !== rule) {
					return yield* new Misnamed({
						message: `${shape}, installed ${order}: a broken containment refused by ${refusalText(onLow.fields)} names law ${lawLow ?? "none"}, not the rule's ${rule}: ${Formatter.format(ops)}`
					})
				}
				if (!sameVerdict(onLow, onOracle, lawLow, lawOracle)) {
					return yield* new Disagreed({
						message: `${shape}, installed ${order}: the lowered installation ${verdictText(onLow, lawLow)}, the triggers' ${verdictText(onOracle, lawOracle)}: ${Formatter.format(ops)}`
					})
				}
			}
			if (onOracle.kind === "committed") {
				const after = sqlAfter(state, ops)
				if (Arr.some(ops, (op) => op.rel === "S" && op.kind !== "delete") && after.S.size > 0) {
					c.note("committed a source row")
				}
				state = after
				continue
			}
			if (lawOracle === rule) {
				c.note(
					Arr.some(ops, (op) => op.rel === "S" && op.kind !== "delete")
						? "refused by the rule, a source row's write"
						: "refused by the rule, a target row's write"
				)
				if (Arr.some(ops, (op) => outsideConstants(shape, op))) {
					c.note("refused by the rule on a target outside its constants")
				}
			}
		}
		const rowsOracle = yield* rowsOn(oracle)
		for (const [order, low] of pair.lows) {
			const rowsLow = yield* rowsOn(low.seat)
			if (!deepEquals(rowsLow, rowsOracle)) {
				return yield* new Disagreed({
					message: `${shape}, installed ${order}: the installations hold different rows: ${Formatter.format(rowsLow)} against ${Formatter.format(rowsOracle)}`
				})
			}
		}
	})

/**
 * The steered phase's cases per shape, measured on 4fdaafc3: the slowest shape's last required feature, fixedTwo's
 * "refused by the rule, a target row's write", is reached in the steered window that ends at case 192 (at 176 it is
 * not), candidatePair's at 160, existential's at 128, headFixed's at 112, and doubled's, the same feature as
 * fixedTwo's, at 48; 240 is three windows of 16 past the slowest.
 */
const steeredCases = 240

layer(Substrate.layer, { excludeTestServices: true })(
	"a containment into a derived relation, lowered to foreign keys, on PostgreSQL 19rc2",
	(it) => {
		for (const shape of shapes) {
			it.effect(
				`${shape}: commits and refuses every history exactly as the containment's triggers do, naming the same law, and refuses a duplicate by its key before any superkey of it in every install order`,
				(ctx) =>
					searched(
						ctx,
						Effect.gen(function* () {
							const pair = yield* pairOf(shape)
							return yield* explore(
								{
									suite: `laws/lowering/${shape}`,
									draw: drawn(caseGen),
									literal: Formatter.format,
									oracle: {
										kind: "second-implementation",
										name: "the same schema installed through conservativeInstallation, every rule over a query discharged by its triggers"
									},
									coverage: required<Feature>(featuresOf(pair), {
										cases: steeredCases,
										sense: notesOnly
									}),
									kept: [],
									runs: 32,
									shrink: { kind: "bounded", candidates: 60 },
									concurrency: 1,
									steerEvery: 16,
									caseHang
								},
								property(pair)
							)
						}).pipe(Effect.scoped)
					)
			)
		}
	}
)

/** A refusal or commit as a disagreement names it. */
const verdictText = (verdict: Attempted, law: LawId | undefined): string =>
	verdict.kind === "committed"
		? "committed"
		: `refused ${momentText(verdict.moment)} by ${refusalText(verdict.fields)} (law ${law ?? "none"})`

/** Whether an op writes an A row outside the constants of a lowered shape's match: a kind other than the one it fixes. */
const outsideConstants = (shape: Shape, op: Op): boolean =>
	Option.exists(
		fixedKinds[shape],
		(kind) =>
			op.rel === "A" &&
			(op.kind === "insert"
				? op.row.kind !== kind
				: op.kind === "update" && op.field === "kind" && op.value !== kind)
	)
