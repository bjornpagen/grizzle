import { extendNonEmpty } from "#compiler/core/nonempty.ts"
import type { RelationInfo } from "#compiler/ir/law.ts"
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
import { NameSupply, namesPast } from "#compiler/sql/naming.ts"
import {
	type WriteCarrier,
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
import { ownStatement } from "#compiler/write/insert/statement.ts"
import type { PutStatement } from "#compiler/write/put/statement.ts"

/** A relation's delta carriers. For a relation no statement both adds to and removes from, a carrier for each side a
 * read-back names, filled directly: added, removed or both. For one some statement adds to and some statement (or a put)
 * removes from, netted: both sides, whose statements after its first net against the pending sets. */
type DeltaCarriers =
	| { readonly kind: "added"; readonly added: WriteCarrier }
	| { readonly kind: "removed"; readonly removed: WriteCarrier }
	| { readonly kind: "both"; readonly added: WriteCarrier; readonly removed: WriteCarrier }
	| { readonly kind: "netted"; readonly added: WriteCarrier; readonly removed: WriteCarrier }

/** The carriers of a relation's delta, the added side's first. */
export const carriersOf = (carriers: DeltaCarriers): ReadonlyArray<WriteCarrier> => {
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
const sideCarrier = (
	carriers: DeltaCarriers,
	side: "added" | "removed"
): WriteCarrier | undefined => {
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
	/** Per relation whose delta's rows cross statements to a read-back after the writes, its carriers. */
	readonly carriers: ReadonlyMap<string, DeltaCarriers>
	/** The relations, and world relations, whose delta is empty by construction: no statement writes them. */
	readonly empty: ReadonlySet<string>
}

/**
 * One side of a relation's delta as a read-back reads it: the carrier its write statements fill, where its rows cross
 * statements; a CTE of the one statement that writes the relation, over the rows that statement returns, where the
 * read-back rides that statement (`deltaCte`), each the relation's fields in heading order with the column that holds
 * it; or the empty relation, where no statement writes it.
 */
export type DeltaHeld =
	| { readonly kind: "carrier"; readonly carrier: WriteCarrier }
	| { readonly kind: "cte"; readonly cte: string; readonly heading: ReadonlyArray<CarrierColumn> }
	| { readonly kind: "empty" }

/** A delta a read-back after the writes reads, as the plan holds it: empty, or the carrier of its side; none for a
 * delta the plan holds no part of. */
export const plannedDelta = (
	plan: DeltaPlan,
	name: string,
	side: "added" | "removed"
): DeltaHeld | undefined => {
	if (plan.empty.has(name)) {
		return { kind: "empty" }
	}
	const carriers = plan.carriers.get(name)
	const carrier = carriers === undefined ? undefined : sideCarrier(carriers, side)
	return carrier === undefined ? undefined : { kind: "carrier", carrier }
}

/** A relation's delta whose rows cross statements: the sides the read-backs after the writes name. */
export type CarriedDelta = Extract<NamedDelta, { readonly kind: "relation" }>

/** The delta carriers of a WriteIR: one per relation and side a read-back names, both sides for a relation some action
 * adds to and some action removes from (an insert beside a delete, or a put), whose netting reads each pending set
 * beside the other.
 *
 * Read-back deltas from the write statements' RETURNING channels.
 *
 * `delta.added(R)` is the RETURNING of R's write statements restricted to what they made present, and `delta.removed(R)`
 * the RETURNING of R's deletions widened to the complete fact, the occupants a put displaced included.
 * A read-back whose deltas one statement writes, and whose state that statement and every later one leave alone, rides
 * that statement and reads its RETURNING CTEs there (`deltaCte`). Any other read-back is a later statement, because a
 * statement sees the snapshot from before its own writes, so the deltas it needs are carried to it in a
 * transaction-scoped carrier filled from those RETURNING CTEs, which holds exactly the rows they returned. This module
 * plans those carriers and adds to each write statement the data-modifying CTEs that fill them from its RETURNING CTE,
 * in the same statement, which is the only place the returned rows exist:
 *
 *   WITH ..., "r2" AS (INSERT ... RETURNING ...),
 *   "r5" AS (INSERT INTO "__carrier_1" ("c1", ...) SELECT "r2"."c4", ... FROM "r2")
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
 * writes has an empty delta by construction, as has a world relation whose definition reads nothing the ChangeSet
 * writes (`NamedDelta`): no carrier holds it, and a read-back reads it as the empty relation. A read-back that rides the
 * one statement writing every delta it reads reads them as that statement's CTEs (`deltaCte`), and no carrier holds
 * them for it either: the carriers here are only those of the deltas `carried` names, whose rows cross statements. */
export const planDeltas = (
	ir: Pick<WriteIR<unknown>, "strata">,
	carried: ReadonlyArray<CarriedDelta>,
	empty: ReadonlySet<string>,
	supply: CarrierSupply
): DeltaPlan => {
	const actions = ir.strata.flatMap((stratum) => stratum.actions)
	const netted = (relation: string): boolean => {
		const own = actions.filter((a) => a.relation === relation)
		return own.some((a) => a.op !== "delete") && own.some((a) => a.op !== "insert")
	}
	const carriers = new Map<string, DeltaCarriers>()
	for (const delta of carried) {
		/** A relation's carriers hold its facts. */
		const name = delta.relation.name
		const carrier = () => relationCarrier(supply, delta.relation)
		if (netted(name)) {
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
	return { carriers, empty }
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
	const supply = new NameSupply(namesPast(statement.sql.nameMap, ownStatement))
	const extra: Array<Cte> = []
	const internal = (purpose: string) => ({ kind: "internal", purpose }) as const
	/** A carrier's fields as one side of the RETURNING holds them: a delta carrier holds its relation's fields, each read
	 * by its name as a column of an IR heading is. */
	const returnedAt = (columns: FieldColumns<string>): ((c: CarrierColumn) => Expr) => {
		const byName = new Map(columns.pairs.map((p) => [p.field.name, p.column] as const))
		return (c) => col(returned.cte, columnIn(byName, c.name))
	}
	const valuesOf = (carrier: WriteCarrier, columns: FieldColumns<string>): ReadonlyArray<Expr> =>
		carrier.heading.map(returnedAt(columns))
	/** Whether the row of `carrier` under `alias` is the fact one side of the RETURNING holds: its columns equal
	 * position by position, each at its type, a vector through the extension's qualified operator, which no role's
	 * search_path resolves (lower/conservative/vector/equality.ts); and always for the unit row, the unit relation's one
	 * fact. */
	const sameFact = (carrier: WriteCarrier, alias: string, columns: FieldColumns<string>): Expr => {
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
	const anyColumn = (carrier: WriteCarrier, alias: string): Expr => {
		const row = carrierRow(carrier)
		switch (row.kind) {
			case "unit":
				return lit.bool(true)
			case "columns":
				return col(alias, row.columns[0].column)
		}
	}
	/** Fills `into` from one side of the RETURNING, netting against `pending`, the opposite side's carrier, when given. */
	const fill = (
		into: WriteCarrier,
		pending: WriteCarrier | undefined,
		side: ReturnedSide
	): void => {
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

/** The CTE of one side of a relation's delta within the statement that writes it (`deltaCte`): its name, and each of
 * the relation's fields, in heading order, with the column that holds it, as a carrier of its facts holds them
 * (`relationCarrier`). */
export interface DeltaCteName {
	readonly relation: RelationInfo
	readonly side: "added" | "removed"
	readonly cte: string
	readonly heading: ReadonlyArray<CarrierColumn>
}

/** The name of the CTE of `relation`'s delta on `side`, and its columns, from `supply`. A statement's two forms name it
 * alike, so a read-back riding the statement reads it by one name in either. */
export const deltaCteName = (
	relation: RelationInfo,
	side: "added" | "removed",
	supply: NameSupply
): DeltaCteName => {
	const origin = { kind: "internal", purpose: `delta ${side} of ${relation.name}` } as const
	return {
		relation,
		side,
		cte: supply.relation(origin),
		heading: relation.heading.map((f) => ({
			name: f.name,
			type: f.type,
			column: supply.column(origin)
		}))
	}
}

/** The rows of `named`'s side `statement`'s RETURNING returns, none where it returns no rows of that side, as an
 * insertion removes nothing. */
const returnedSideOf = (
	statement: ModifyingStatement<InsertResult | DeleteResult> | PutStatement,
	side: "added" | "removed"
): ReturnedSide | undefined => {
	const returned = statement.returning
	return side === "added"
		? returned.kind === "removed"
			? undefined
			: returned.added
		: returned.kind === "added"
			? undefined
			: returned.removed
}

/**
 * The CTE `named` of `statement`, the one statement that writes its relation, for the read-backs riding that statement:
 * the rows its RETURNING CTE returns of that side, restricted as a carrier's fill restricts them (`withDeltaFills`), so
 * it holds exactly the facts the statement made present or absent, each of the relation's fields in heading order:
 *
 *   WITH ..., "r2" AS (INSERT ... RETURNING ...),
 *   "r9"("c20", "c21") AS (SELECT "r2"."c4", "r2"."c5" FROM "r2")
 *
 * None where the statement returns no rows of that side, whose delta is the empty relation (`deltaIn`). A read-back
 * riding the statement reads it in place of a carrier, so its delta never leaves the statement.
 */
export const deltaCte = (
	statement: ModifyingStatement<InsertResult | DeleteResult> | PutStatement,
	named: DeltaCteName
): Cte | undefined => {
	const returned = returnedSideOf(statement, named.side)
	if (returned === undefined) {
		return undefined
	}
	const byName = new Map(returned.columns.pairs.map((p) => [p.field.name, p.column] as const))
	const cte = statement.returning.cte
	return {
		name: named.cte,
		columns: named.heading.map((c) => c.column),
		materialized: undefined,
		query: provedSelect(
			"keyed",
			named.heading.map((c) => target(col(cte, columnIn(byName, c.name)))),
			[cteRef(cte)],
			conjunction(returned.conditions)
		)
	}
}

/** What a read-back riding `statement` reads of the delta `named`: its CTE, or the empty relation where the statement
 * returns no rows of its side (`deltaCte`). */
export const deltaIn = (
	statement: ModifyingStatement<InsertResult | DeleteResult> | PutStatement,
	named: DeltaCteName
): DeltaHeld =>
	returnedSideOf(statement, named.side) === undefined
		? { kind: "empty" }
		: { kind: "cte", cte: named.cte, heading: named.heading }
