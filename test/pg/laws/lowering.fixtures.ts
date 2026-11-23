/**
 * The containment lowering's box and its judgment (lowering.test.ts): the drawn histories, each shape's installations as
 * templates, what each shape's plan decides, and one case of a shape against the containment's triggers.
 */
import { assert, deepEquals, defined } from "@bjornpagen/testing/assert"
import { aimed, array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Formatter, Layer, Option, Record as Rec } from "effect"
import { Db } from "#adapter/public/db.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import type { NativeColumn, TableRelation } from "#compiler/ir/law.ts"
import { lawsOfConstraint } from "#compiler/ir/products.ts"
import type { CallError } from "#compiler/live/index.ts"
import {
	compileInstallation,
	conservativeInstallation,
	type Installation
} from "#compiler/physical/install/compile.ts"
import { ChangeSet, type KeyHost, type Witness } from "#compiler/public/changeset.ts"
import {
	type Catalogued,
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
	type History,
	type Order,
	RELATIONS,
	S,
	type Shape,
	shapes
} from "#test/pg/laws/lowering-support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import {
	type Installed,
	type InstallVersion,
	migratedTemplate,
	noPlaceholders
} from "#test/support/install-migrate.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { draftCodes, fromEmpty, noDeclarations } from "#test/support/migrate/kit.ts"
import { planRealInstall } from "#test/support/oracle/install/real.ts"
import type { PgErrorFields } from "#test/support/pg.ts"
import { schemaDescIn } from "#test/support/policy.ts"
import { refusedEntries } from "#test/support/refused.ts"
import { servedFixture } from "#test/support/served-db.ts"
import { type Attempted, attempt, momentText, refusalText } from "#test/support/substrate.ts"
import {
	Substrate,
	type SubstrateCase,
	type SubstrateTemplate
} from "#test/support/substrate/substrate.ts"
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

export type Feature =
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

/**
 * A history aimed at a target row's write the rule refuses: a source built over an A row the shape's target holds, at
 * the kind its match fixes (lowering-support.ts fixedKinds) and group 0, then that row's delete, which the drawn
 * histories reach seldom.
 */
const targetRefusedGen =
	(shape: Shape): Gen<LoweringCase> =>
	(s) => ({
		history: [
			{
				writer: "sql",
				ops: [
					{
						rel: "A",
						kind: "insert",
						row: { ...aRow(s), kind: fixedKinds[shape], grp: 0 }
					},
					{ rel: "B", kind: "insert", row: bRow(s) },
					{ rel: "S", kind: "reference", sid: s.draw(int(0, 2)), pick: 0, via: { kind: "head" } }
				]
			},
			{ writer: "sql", ops: [{ rel: "A", kind: "unreference", pick: 0, by: { kind: "delete" } }] }
		]
	})

/** A shape's histories, aimed at a target row's write the rule refuses while it is pending (`targetRefusedGen`). */
export const loweringSpaceOf = (shape: Shape) =>
	aimed(caseGen, [["refused by the rule, a target row's write", targetRefusedGen(shape)] as const])

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

/** Every law a refusal names through `installed`'s own constraint map, by its table and constraint: none for another. */
const lawsOf = (installed: Installed, fields: PgErrorFields): ReadonlyArray<LawId> => {
	const constraint = fields.constraint
	const table = Option.flatMap(fields.table, (ident) =>
		Arr.findFirst(RELATIONS, (rel) => installed.names.relation(rel).name === ident)
	)
	return Option.isNone(table) || constraint === undefined
		? []
		: (lawsOfConstraint(
				installed.installation.constraintToLaw,
				{ kind: "table", name: installed.names.relation(table.value).name },
				constraint
			) ?? [])
}

/** The laws a refusal names, as a disagreement names them. */
const lawsText = (laws: ReadonlyArray<LawId>): string =>
	laws.length === 0 ? "law none" : `laws ${Arr.join(laws, ", ")}`

/** The one rule over a query of an installation: the containment of S in D. */
const ruleLaw = (installation: Installation): LawId =>
	defined(
		Arr.findFirst(installation.laws.theory.laws, (l) => l.detail.kind === "rule").pipe(
			Option.map((l) => l.id),
			Option.getOrUndefined
		),
		"the containment of S in D, a rule over a query"
	)

/** A native column as a constraint's columns name it: a field by its name, a law column by no field's name. */
const nativeColumnName = (column: NativeColumn): string =>
	column.kind === "field" ? column.field.name : "‹law column›"

/** The relation of the box a planned constraint native lives on, none for any other. */
const nativeRelation = (relation: TableRelation): Option.Option<"A" | "B" | "S"> =>
	Arr.findFirst(RELATIONS, (r) => r === relation.name)

/**
 * The UNIQUEs a planned installation's lowering adds beside its declared keys: each unique native of A, B or S over no
 * declared key's fields, as the declared keys of its relation it holds whole.
 */
const plannedSuperkeys = (installation: Installation): ReadonlyArray<ReadonlyArray<DeclaredKey>> =>
	Arr.flatMap(installation.laws.natives, (native) => {
		if (native.namespace !== "constraint") {
			return []
		}
		const object = native.object
		const placed =
			object.kind === "Unique"
				? Option.some({
						relation: object.relation,
						columns: Arr.map(object.columns, nativeColumnName)
					})
				: object.kind === "PrimaryKey"
					? Option.some({
							relation: object.relation,
							columns: Arr.map(object.columns, (f) => f.name)
						})
					: Option.none()
		return Option.match(
			Option.flatMap(placed, (p) =>
				Option.map(nativeRelation(p.relation), (r) => [r, p.columns] as const)
			),
			{
				onNone: () => [],
				onSome: ([relation, columns]) => {
					const declared = declaredKeysOf(installation, relation)
					return Arr.some(declared, (k) => sameRoles(columns, k.fields))
						? []
						: [Arr.filter(declared, (k) => Arr.every(k.fields, (f) => columns.includes(f)))]
				}
			}
		)
	})

/** Whether a planned installation carries its rule by a foreign key: a FOREIGN KEY native that discharges the rule. */
const plannedCarried = (installation: Installation): boolean => {
	const rule = ruleLaw(installation)
	const foreignKeys = new Set<string>(
		Arr.flatMap(installation.laws.natives, (native) =>
			native.namespace === "constraint" && native.object.kind === "ForeignKey"
				? [identifierOf(native.named)]
				: []
		)
	)
	return Arr.some(
		installation.laws.constraints,
		(c) =>
			c.kind === "constraint" && foreignKeys.has(c.name) && Arr.some(c.laws, (l) => l.law === rule)
	)
}

/**
 * What a search of a shape must reach: a committed source row, the rule refusing a source row's write and a target
 * row's, a served write accepted and refused by the rule, and a target outside the constant its match fixes refused;
 * where the lowering adds a UNIQUE over a superkey of a primary key, a duplicate of that key beside it; and where it
 * adds one over a superkey of a candidate key and no primary key, in every order the shape is installed in, a direct
 * and a served duplicate of the candidate key beside it, and one PostgreSQL refuses on that UNIQUE's index, which
 * keyChanged's history creates before the key's. Each UNIQUE is read off the shape's planned installation, the natives
 * its fresh install creates, whose decision every case holds each installed catalog to (pairIn).
 */
const situationsOf = (
	installation: Installation,
	installed: ReadonlyArray<Order>
): ReadonlyArray<Feature> => {
	const superkeys = plannedSuperkeys(installation)
	const holding = (primary: boolean) =>
		Arr.some(superkeys, (holds) =>
			primary
				? Arr.some(holds, (k) => k.primary)
				: Arr.some(holds, (k) => !k.primary) && !Arr.some(holds, (k) => k.primary)
		)
	return [
		"committed a source row",
		"refused by the rule, a source row's write",
		"refused by the rule, a target row's write",
		"a served write accepted",
		"a served write refused by the rule",
		"refused by the rule on a target outside its constants",
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
	const rule = ruleLaw(seat.installed.installation)
	return Arr.some(
		seat.constraints,
		(c) => c.kind === "foreign" && Arr.some(c.laws, (l) => l === rule)
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
	installation: Installation,
	relation: "A" | "B" | "S"
): ReadonlyArray<DeclaredKey> => {
	const theory = installation.laws.theory
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
	const declared = declaredKeysOf(seat.installed.installation, relation)
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
	const laws = lawsOf(seat.installed, refused.fields)
	const named = seat.refusedBy(refused.fields)
	const key = Arr.findFirst(duplicated.keys, (k) => Arr.contains(laws, k.law))
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
		message: `${statement} repeats ${keys}, and is refused by ${by} naming laws ${Arr.join(laws, ", ") || "none"}: ${refusalText(refused.fields)}`
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
		return Arr.filter(declaredKeysOf(installed.installation, rel), (k) =>
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

/**
 * Whether two SQL verdicts agree: both committed, or both refused at one moment with one SQLSTATE naming one set of
 * laws, each installation's own constraint map's (lawsOf), in code point order.
 */
const sameVerdict = (
	low: Attempted,
	oracle: Attempted,
	lawsLow: ReadonlyArray<LawId>,
	lawsOracle: ReadonlyArray<LawId>
): boolean => {
	if (low.kind === "committed" || oracle.kind === "committed") {
		return low.kind === oracle.kind
	}
	return (
		momentText(low.moment) === momentText(oracle.moment) &&
		low.fields.code === oracle.fields.code &&
		lawsLow.length > 0 &&
		Arr.join(lawsLow, " ") === Arr.join(lawsOracle, " ")
	)
}

/** The fields a lowered installation's latest version declares under the declared name `name`, with its full world's login. */
const lastOf = (shape: Shape, name: string): InstallVersion => {
	const declared = loweringSchema(shape, name)
	return {
		schema: declared,
		logins: [fullWorld(declared, {}).server],
		declarations: noDeclarations
	}
}

/** How every lowered installation is drafted: grizzle's own compile, no placeholder. */
const loweredOptions = {
	label: "lowering",
	extensions: [],
	ambient: ordinarySession,
	compile: compileInstallation,
	review: noPlaceholders
} as const

/** The name a shape's fresh installation is planned under to read what it lowers to: it is never installed. */
const plannedName = "lowering"

/**
 * A shape's fresh installation as grizzle plans its first migration (oracle/install/real.ts planRealInstall, as
 * install-migrate.ts draftVersion plans it), read without installing it.
 */
const plannedOf = (shape: Shape): Installation => {
	const version = lastOf(shape, "Lowering")
	const desc = succeeded(schemaDescIn(version.schema))
	return succeeded(
		planRealInstall(desc, {
			installation: identity.schema(parsedSchemaName(plannedName)),
			logins: version.logins,
			extensions: [],
			codes: succeeded(draftCodes(desc, fromEmpty, version.declarations)),
			compile: compileInstallation
		})
	).installation
}

/**
 * A shape of the box with the situations its search must reach (situationsOf), read off its plan, in every order it is
 * installed in, fresh and through each history.
 */
export interface PlannedShape {
	readonly shape: Shape
	readonly situations: ReadonlyArray<Feature>
}

/**
 * Every shape of the box, planned (plannedOf): each one's plan carries its rule by a foreign key, the box's premise, so
 * a shape whose plan does not fails where the box is read.
 */
export const loweredShapes: ReadonlyArray<PlannedShape> = Arr.map(shapes, (shape) => {
	const installation = plannedOf(shape)
	assert.ok(plannedCarried(installation), `${shape}'s plan carries its rule by a foreign key`)
	return { shape, situations: situationsOf(installation, ["fresh", ...histories]) }
})

/** A lowered shape installed through `history`, its first version then its last, once per member. */
const historyTemplate = (shape: Shape, history: History): SubstrateTemplate<Installed> =>
	migratedTemplate({
		declaredIn: import.meta,
		name: `lowering ${shape} ${history}`,
		content: { shape, order: history },
		versions: [
			{
				schema: firstVersion(history, shape, "Lowering"),
				logins: [],
				declarations: noDeclarations
			},
			lastOf(shape, "Lowering")
		],
		options: loweredOptions
	})

/**
 * Each shape's installations once per member through their migrations (install-migrate.ts migratedTemplate), where each
 * search installed them before its cases: the lowered one fresh and through each history, and the oracle's, every
 * one's tables emptied by its seat after a case.
 */
export const loweringTemplatesOf = (shape: Shape) => ({
	fresh: migratedTemplate({
		declaredIn: import.meta,
		name: `lowering ${shape} fresh`,
		content: { shape, order: "fresh" },
		versions: [lastOf(shape, "Lowering")],
		options: loweredOptions
	}),
	histories: {
		aboveLater: historyTemplate(shape, "aboveLater"),
		keysLater: historyTemplate(shape, "keysLater"),
		keyChanged: historyTemplate(shape, "keyChanged")
	} satisfies Readonly<Record<History, SubstrateTemplate<Installed>>>,
	oracle: migratedTemplate({
		declaredIn: import.meta,
		name: `lowering ${shape} oracle`,
		content: { shape, order: "oracle" },
		versions: [
			{ schema: loweringSchema(shape, "LoweringOracle"), logins: [], declarations: noDeclarations }
		],
		options: { ...loweredOptions, label: "lowering_oracle", compile: conservativeInstallation }
	})
})

/** A lowered installation of a case's clone (`taken`): its seat, and its writes through a served Db of its full world. */
const loweredIn = (taken: SubstrateCase<Installed>, shape: Shape, order: Order) =>
	Effect.provideService(
		Effect.gen(function* () {
			const installed = taken.value
			const value = loweringSchema(shape, installed.schema)
			const served = yield* servedFixture(installed, fullWorld(value, programsOf(value)).server)
			const context = yield* Layer.build(served.layer)
			const db = yield* Db.open(served.login.roles.app, {}).pipe(Effect.provideContext(context))
			const low: LoweredInstall = {
				seat: yield* seatOfInstalled(installed, RELATIONS, `lowering_${order}`),
				write: (facts) =>
					Effect.map(
						writeAnswerOf(db.workload.write.once({ params: {}, facts: facts })),
						(outcome): ServedOutcome => {
							switch (outcome.kind) {
								case "accepted":
								case "unchanged":
									return { kind: "accepted" }
								case "refused":
									return {
										kind: "refused",
										laws: Arr.map(refusedEntries(outcome.refused), (r) => r.id),
										witness: outcome.witness
									}
								case "outsideWorld":
									return { kind: "other", text: Formatter.format(outcome) }
							}
						}
					)
			}
			return low
		}),
		Substrate,
		taken.substrate
	)

/**
 * A shape's installations as a case reads them over its clones: the lowered one fresh and through every history, and
 * the oracle's; every lowered installation's catalog carrying the rule by a foreign key, as its plan does
 * (loweredShapes), and the oracle's by none.
 */
export const pairIn = (
	planned: PlannedShape,
	fresh: SubstrateCase<Installed>,
	reached: ReadonlyArray<readonly [History, SubstrateCase<Installed>]>,
	oracle: SubstrateCase<Installed>
) =>
	Effect.gen(function* () {
		const shape = planned.shape
		const freshLow = yield* loweredIn(fresh, shape, "fresh")
		const lows = new Map<Order, LoweredInstall>([["fresh", freshLow]])
		for (const [history, taken] of reached) {
			const low = yield* loweredIn(taken, shape, history)
			lows.set(history, low)
		}
		for (const [order, low] of lows) {
			if (!carriedByForeignKey(low.seat)) {
				return yield* new Disagreed({
					message: `${shape}, installed ${order}: the installed rule carried by no foreign key, where its plan carries it by one`
				})
			}
		}
		const oracleSeat = yield* Effect.provideService(
			seatOfInstalled(oracle.value, RELATIONS, "lowering_oracle"),
			Substrate,
			oracle.substrate
		)
		if (carriedByForeignKey(oracleSeat)) {
			return yield* new Disagreed({
				message: `${shape}: the oracle's installed rule carried by a foreign key`
			})
		}
		const pair: Pair = { shape, fresh: freshLow.seat, lows, oracle: oracleSeat }
		return pair
	})

/** What a case of `pair`'s shape holds to, as the header states it, noting what it reached. */
export const loweringCase = (pair: Pair) => (lc: LoweringCase, c: Case<Feature>) =>
	Effect.gen(function* () {
		const shape = pair.shape
		const oracle = pair.oracle
		const rule = ruleLaw(oracle.installed.installation)
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
				const oracleLaws: ReadonlyArray<LawId> =
					verdict.kind === "refused" ? lawsOf(oracle.installed, verdict.fields) : []
				const broken = brokenKeysOf(oracle.installed, state, facts)
				const breaks = (law: LawId | string): boolean =>
					broken.length === 0
						? Arr.some(oracleLaws, (l) => l === law)
						: Arr.some(broken, (k) => k.law === law)
				if (
					verdict.kind === "refused" &&
					broken.length > 0 &&
					!Arr.some(oracleLaws, (l) => Arr.some(broken, (k) => k.law === l))
				) {
					return yield* new Disagreed({
						message: `${shape}: the triggers' installation ${verdictText(verdict, oracleLaws)}, where the facts break the keys ${Formatter.format(Arr.map(broken, (k) => k.law))}: ${Formatter.format(facts)}`
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
							message: `${shape}, installed ${order}: grizzle's served write answered ${Formatter.format(outcome)}, where the triggers' installation ${verdictText(verdict, oracleLaws)}: ${Formatter.format(facts)}`
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
				} else if (Arr.contains(oracleLaws, rule)) {
					c.note("a served write refused by the rule")
				}
				continue
			}
			const onOracle = yield* attempt(
				oracle.session,
				Arr.map(ops, (op) => statementOf(oracle, op))
			)
			const lawsOracle =
				onOracle.kind === "refused" ? lawsOf(oracle.installed, onOracle.fields) : []
			for (const [order, low] of pair.lows) {
				const seat = low.seat
				const onLow = yield* attempt(
					seat.session,
					Arr.map(ops, (op) => statementOf(seat, op))
				)
				const lawsLow = onLow.kind === "refused" ? lawsOf(seat.installed, onLow.fields) : []
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
				if (
					onLow.kind === "refused" &&
					onLow.fields.code === "23503" &&
					!Arr.contains(lawsLow, rule)
				) {
					return yield* new Misnamed({
						message: `${shape}, installed ${order}: a broken containment refused by ${refusalText(onLow.fields)} names laws ${Arr.join(lawsLow, ", ") || "none"}, not the rule's ${rule}: ${Formatter.format(ops)}`
					})
				}
				if (!sameVerdict(onLow, onOracle, lawsLow, lawsOracle)) {
					return yield* new Disagreed({
						message: `${shape}, installed ${order}: the lowered installation ${verdictText(onLow, lawsLow)}, the triggers' ${verdictText(onOracle, lawsOracle)}: ${Formatter.format(ops)}`
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
			if (Arr.contains(lawsOracle, rule)) {
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

/** A refusal or commit as a disagreement names it. */
const verdictText = (verdict: Attempted, laws: ReadonlyArray<LawId>): string =>
	verdict.kind === "committed"
		? "committed"
		: `refused ${momentText(verdict.moment)} by ${refusalText(verdict.fields)} (${lawsText(laws)})`

/** Whether an op writes an A row outside the constants of a shape's match: a kind other than the one it fixes. */
const outsideConstants = (shape: Shape, op: Op): boolean =>
	op.rel === "A" &&
	(op.kind === "insert"
		? op.row.kind !== fixedKinds[shape]
		: op.kind === "update" && op.field === "kind" && op.value !== fixedKinds[shape])
