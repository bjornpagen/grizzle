import { extendNonEmpty } from "#compiler/core/nonempty.ts"
import type { WriteIR } from "#compiler/ir/write.ts"
import { columnIn } from "#compiler/lower/conservative/context.ts"
import { rowEq } from "#compiler/lower/conservative/vector/equality.ts"
import type { Cte, Delete, Expr, Insert } from "#compiler/sql/ast.ts"
import {
	and,
	col,
	conjunction,
	cteRef,
	lit,
	notExists,
	provedSelect,
	simpleSelect,
	target,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import { emitText } from "#compiler/sql/emit.ts"
import { NameSupply } from "#compiler/sql/naming.ts"
import {
	type Carrier,
	type CarrierColumn,
	type CarrierSupply,
	carrierColumns,
	carrierRow,
	carrierScan,
	relationCarrier
} from "#compiler/write/carriers/carriers.ts"
import type { FieldColumns } from "#compiler/write/defined.ts"
import type { NamedDelta } from "#compiler/write/frontend/compile.ts"
import type {
	DeleteResult,
	InsertResult,
	ModifyingStatement,
	ReturnedSide,
	WithSelect
} from "#compiler/write/insert/statement.ts"
import { namesPast } from "#compiler/write/insert/statement.ts"
import type { PutStatement } from "#compiler/write/put/statement.ts"

/** A relation's delta carriers. For a relation no statement both adds to and removes from, a carrier for each side a
 * read-back names, filled directly: added, removed or both. For one some statement adds to and some statement (or a put)
 * removes from, netted: both sides, whose statements after its first net against the pending sets. */
type DeltaCarriers =
	| { readonly kind: "added"; readonly added: Carrier }
	| { readonly kind: "removed"; readonly removed: Carrier }
	| { readonly kind: "both"; readonly added: Carrier; readonly removed: Carrier }
	| { readonly kind: "netted"; readonly added: Carrier; readonly removed: Carrier }

/** The carriers of a relation's delta, the added side's first. */
export const carriersOf = (carriers: DeltaCarriers): ReadonlyArray<Carrier> => {
	switch (carriers.kind) {
		case "added":
			return [carriers.added]
		case "removed":
			return [carriers.removed]
		case "both":
		case "netted":
			return [carriers.added, carriers.removed]
	}
}

/** The carrier of one side of a relation's delta, when a read-back names that side. */
export const sideCarrier = (
	carriers: DeltaCarriers,
	side: "added" | "removed"
): Carrier | undefined => {
	switch (carriers.kind) {
		case "added":
			return side === "added" ? carriers.added : undefined
		case "removed":
			return side === "removed" ? carriers.removed : undefined
		case "both":
		case "netted":
			return carriers[side]
	}
}

export interface DeltaPlan {
	/** Per relation a read-back's Delta names, its carriers. */
	readonly carriers: ReadonlyMap<string, DeltaCarriers>
}

/** The delta carriers of a WriteIR: one per relation and side a read-back names, both sides for a relation some action
 * adds to and some action removes from (an insert beside a delete, or a put), whose netting reads each pending set
 * beside the other.
 *
 * Read-back deltas from the write statements' RETURNING channels.
 *
 * `delta.added(R)` is the RETURNING of R's write statements restricted to what they made present, and `delta.removed(R)`
 * the RETURNING of R's deletions widened to the complete fact, the occupants a put displaced included.
 * A read-back over post-change state is a later statement, because a statement sees the snapshot from before its own
 * writes, so the deltas it needs are carried to it in a transaction-scoped carrier filled from those RETURNING CTEs.
 * A read-back is a statement of its own after the writes, whether a stratum's writes are sequential statements or one
 * single statement, and reads the carriers, which hold exactly the rows the RETURNING CTEs returned. This module plans
 * those carriers and adds to each write statement the data-modifying CTEs that fill them
 * from its RETURNING CTE, in the same statement, which is the only place the returned rows exist:
 *
 *   WITH ..., "r2" AS (INSERT ... RETURNING ...),
 *   "r5" AS (INSERT INTO "__carrier_<d>_1" ("c1", ...) SELECT "r2"."c4", ... FROM "r2")
 *   SELECT ... FROM "r2" ...
 *
 * Every column of a write statement's RETURNING is a stored column, so it has the carrier column's type exactly
 * (a delta carrier is typed as the relation's facts), and the fill casts nothing. A delta carrier
 * lists the relation's fields in heading order, the order a read-back's Delta node reads its columns position by
 * position (`delta`).
 *
 * Netting, across the strata of ChangeSet.sequence and within one: walking R's write statements in order, an addition
 * cancels a pending removal of the same fact and a removal cancels a pending addition. Within one stratum that nets a
 * fact its delete freed and a generated addition drew back identical (an identity sequence lagging the stored values),
 * which S' = (S \ D) ∪ A leaves unchanged (`stratumChange`). The carriers hold the pending sets, so every
 * write statement of R after its first fills them with the netting form, each a pair of sibling CTEs:
 *
 *   added fact g:   DELETE FROM <removed> USING r2 WHERE (<removed>.*) = (g)
 *                   INSERT INTO <added> SELECT g FROM r2 WHERE NOT EXISTS (SELECT 1 FROM <removed> WHERE (...) = (g))
 *   removed fact f: DELETE FROM <added> USING r2 WHERE (<added>.*) = (f)
 *                   INSERT INTO <removed> SELECT f FROM r2 WHERE NOT EXISTS (SELECT 1 FROM <added> WHERE (...) = (f))
 *
 * Siblings read the snapshot from before the statement, so each insertion tests the pending set as the
 * earlier statements left it. The pair never competes for one row: a fact a statement adds was absent before it and a
 * fact it removes was present, so the deletion's rows and the insertion's rows differ. A relation some statement adds
 * to and some statement removes from (an insert beside a delete, or a put, which may displace before it inserts)
 * therefore keeps both carriers whichever side a read-back names; R's first write statement inserts directly into empty
 * carriers. A relation only inserted into, or only deleted from, has nothing to cancel: its statements fill the
 * carriers a read-back names directly, however many statements write it.
 *
 * A protocol insert's RETURNING also yields its conflict witnesses. The statement raises every one of them, refusing
 * the ChangeSet or aborting it, which rolls the transaction and its carriers back, so the carrier
 * only ever survives holding facts the statement made present. A relation a read-back names but the ChangeSet never
 * writes has an empty delta: its carriers are created and never filled, as are those of a world relation whose
 * definition reads nothing the ChangeSet writes (`NamedDelta`). */
export const planDeltas = (
	ir: Pick<WriteIR<unknown>, "strata">,
	named: ReadonlyArray<NamedDelta>,
	supply: CarrierSupply
): DeltaPlan => {
	const actions = ir.strata.flatMap((stratum) => stratum.actions)
	const netted = (relation: string): boolean => {
		const own = actions.filter((a) => a.relation === relation)
		return own.some((a) => a.op !== "delete") && own.some((a) => a.op !== "insert")
	}
	const carriers = new Map<string, DeltaCarriers>()
	for (const delta of named) {
		/** A relation's carriers hold its facts; a world relation's empty delta's, its heading, and no statement fills them. */
		const { name, carrier } =
			delta.kind === "relation"
				? {
						name: delta.relation.name,
						carrier: () => relationCarrier(supply, delta.relation)
					}
				: { name: delta.name, carrier: () => supply.next(delta.heading) }
		if (delta.kind === "relation" && netted(name)) {
			const added = carrier()
			carriers.set(name, { kind: "netted", added, removed: carrier() })
			continue
		}
		switch (delta.sides) {
			case "added":
				carriers.set(name, { kind: "added", added: carrier() })
				break
			case "removed":
				carriers.set(name, { kind: "removed", removed: carrier() })
				break
			case "both": {
				const added = carrier()
				carriers.set(name, { kind: "both", added, removed: carrier() })
			}
		}
	}
	return { carriers }
}

/** A write statement with the CTEs that fill its relation's delta carriers from its RETURNING CTE, the sides its builder
 * states (`Returning`), re-emitted; the statement itself when no carrier takes its rows. `earlier`
 * states whether an earlier write statement of the artifact wrote the relation: a netted relation's statements after
 * its first net against the pending sets. */
export const withDeltaFills = <
	S extends ModifyingStatement<InsertResult | DeleteResult> | PutStatement
>(
	statement: S,
	carriers: DeltaCarriers | undefined,
	earlier: boolean,
	vectorSchema: string
): S => {
	if (carriers === undefined) {
		return statement
	}
	const returned = statement.returning
	const added = returned.kind === "removed" ? undefined : returned.added
	const removed = returned.kind === "added" ? undefined : returned.removed
	const used = namesPast(statement.sql.nameMap)
	const supply = new NameSupply({ relationStart: used.relation, columnStart: used.column })
	const extra: Array<Cte> = []
	const internal = (purpose: string) => ({ kind: "internal", purpose }) as const
	/** A carrier's fields as one side of the RETURNING holds them: a delta carrier holds its relation's fields, each read
	 * by its name as a column of an IR heading is. */
	const returnedAt = (columns: FieldColumns<string>): ((c: CarrierColumn) => Expr) => {
		const byName = new Map(columns.pairs.map((p) => [p.field.name, p.column] as const))
		return (c) => col(returned.cte, columnIn(byName, c.name))
	}
	const valuesOf = (carrier: Carrier, columns: FieldColumns<string>): ReadonlyArray<Expr> =>
		carrier.heading.map(returnedAt(columns))
	/** Whether the row of `carrier` under `alias` is the fact one side of the RETURNING holds: its columns equal
	 * position by position, each at its type, a vector through the extension's qualified operator, which no role's
	 * search_path resolves (lower/conservative/vector/equality.ts); and always for the unit row, the unit relation's one
	 * fact. */
	const sameFact = (carrier: Carrier, alias: string, columns: FieldColumns<string>): Expr => {
		const row = carrierRow(carrier)
		switch (row.kind) {
			case "unit":
				return lit.bool(true)
			case "columns":
				return rowEq(
					{
						fields: row.columns,
						typeOf: (c) => c.type,
						left: (c) => col(alias, c.column),
						right: returnedAt(columns)
					},
					vectorSchema
				)
		}
	}
	/** One column of a carrier's row under `alias`, a data-modifying CTE's RETURNING target: its first, or the unit
	 * marker for the unit row. */
	const anyColumn = (carrier: Carrier, alias: string): Expr => {
		const row = carrierRow(carrier)
		switch (row.kind) {
			case "unit":
				return lit.bool(true)
			case "columns":
				return col(alias, row.columns[0].column)
		}
	}
	/** Fills `into` from one side of the RETURNING, netting against `pending`, the opposite side's carrier, when given. */
	const fill = (into: Carrier, pending: Carrier | undefined, side: ReturnedSide): void => {
		const values = valuesOf(into, side.columns)
		if (pending !== undefined) {
			/** Cancel a pending opposite change of the same fact. */
			const alias = supply.relation(internal(`pending ${pending.name}`))
			const del: Delete = {
				kind: "delete",
				table: pending.name,
				alias,
				using: [cteRef(returned.cte)],
				where: and([sameFact(pending, alias, side.columns), ...side.conditions]),
				/** PostgreSQL needs no RETURNING here; the statement audit requires one of every data-modifying CTE. */
				returning: [targetAs(anyColumn(pending, alias), supply.column(internal("cancelled")))],
				with: undefined
			}
			extra.push({
				name: supply.relation(internal(`cancel ${pending.name}`)),
				query: del,
				columns: [],
				materialized: undefined
			})
		}
		const probe = (() => {
			if (pending === undefined) {
				return undefined
			}
			const alias = supply.relation(internal(`pending ${pending.name}`))
			return notExists(
				simpleSelect(
					[target(lit.int(1, types.integer))],
					[carrierScan(pending, alias)],
					sameFact(pending, alias, side.columns)
				)
			)
		})()
		const filled = supply.relation(internal(`target ${into.name}`))
		const conditions = [...side.conditions, ...(probe === undefined ? [] : [probe])]
		const insert: Insert = {
			kind: "insert",
			table: into.name,
			alias: filled,
			columns: carrierColumns(into),
			source: {
				kind: "query",
				query: provedSelect(
					"keyed",
					values.map((v) => target(v)),
					[cteRef(returned.cte)],
					conjunction(conditions)
				)
			},
			returning: [targetAs(anyColumn(into, filled), supply.column(internal("filled")))],
			with: undefined,
			overriding: undefined,
			onConflict: undefined
		}
		extra.push({
			name: supply.relation(internal(`fill ${into.name}`)),
			query: insert,
			columns: [],
			materialized: undefined
		})
	}
	/** Each carrier of the relation's delta, filled from the rows the statement returns. */
	const fillCarriers = (): void => {
		switch (carriers.kind) {
			case "added":
				if (added !== undefined) {
					fill(carriers.added, undefined, added)
				}
				return
			case "removed":
				if (removed !== undefined) {
					fill(carriers.removed, undefined, removed)
				}
				return
			case "both":
				if (added !== undefined) {
					fill(carriers.added, undefined, added)
				}
				if (removed !== undefined) {
					fill(carriers.removed, undefined, removed)
				}
				return
			case "netted":
				if (added !== undefined) {
					fill(carriers.added, earlier ? carriers.removed : undefined, added)
				}
				if (removed !== undefined) {
					fill(carriers.removed, earlier ? carriers.added : undefined, removed)
				}
				return
		}
	}
	fillCarriers()
	if (extra.length === 0) {
		return statement
	}
	const ast = statement.ast
	const augmented: WithSelect = {
		...ast,
		with: { ...ast.with, ctes: extendNonEmpty(ast.with.ctes, extra) }
	}
	const out: S = {
		...statement,
		ast: augmented,
		sql: emitText(augmented, [...statement.sql.nameMap, ...supply.map()])
	}
	return Object.freeze(out)
}
