import type { RelationInfo } from "#compiler/ir/law.ts"
import type { DeltaSide } from "#compiler/ir/rel.ts"
import { columnIn } from "#compiler/lower/conservative/context.ts"
import type { Cte } from "#compiler/sql/ast.ts"
import { col, conjunction, cteRef, provedSelect, target } from "#compiler/sql/build.ts"
import type { NameSupply } from "#compiler/sql/naming.ts"
import type { CarrierColumn } from "#compiler/write/carriers/carriers.ts"
import type {
	DeleteResult,
	InsertResult,
	ModifyingStatement,
	ReturnedSide
} from "#compiler/write/insert/statement.ts"
import type { PutStatement } from "#compiler/write/put/statement.ts"

/**
 * One side of a relation's delta as a read-back reads it: a CTE of the one statement that makes that side, over the
 * rows that statement returns, where the read-back rides that statement (`deltaCte`), each of the relation's fields in
 * heading order with the column that holds it; or the empty relation, where no statement writes the relation.
 *
 * Read-back deltas from the write statements' RETURNING channels.
 *
 * `delta.added(R)` is the RETURNING of R's write statements restricted to what they made present, `delta.removed(R)`
 * the RETURNING of R's deletions widened to the complete fact, the occupants a put displaced included, and
 * `delta.met(R)` the stored facts an insertion met at its arbiter key and did not refuse. A statement sees
 * the snapshot from before its own writes, and its RETURNING exists only inside it, so a delta never leaves the
 * statement that makes it: a read-back over a delta some statement writes is evaluated inside that statement, over its
 * RETURNING, and its rows are that statement's rows behind the read-back's tag (write/program/single.ts). The schedule
 * places it there only where that statement makes every side it reads whole and the state it reads is settled there
 * (write/schedule/plan.ts placeReadBacks), and refuses it otherwise; so no carrier ever holds a delta.
 *
 * A relation a read-back names but the ChangeSet never writes has an empty delta by construction, as has a world
 * relation whose definition reads nothing the ChangeSet writes (`NamedDelta` "empty"): a read-back reads it as the empty
 * relation, wherever it runs.
 */
export type DeltaHeld =
	| { readonly kind: "cte"; readonly cte: string; readonly heading: ReadonlyArray<CarrierColumn> }
	| { readonly kind: "empty" }

/** A side of a delta a read-back reads outside the statement that makes it: the empty relation, where no statement
 * makes `side` of `name`'s delta, `made` holding the sides some statement makes; none for any other, whose rows no
 * statement but the one making them holds (write/schedule/plan.ts placeReadBacks). */
export const emptyDelta = (
	made: ReadonlyMap<string, ReadonlySet<DeltaSide>>,
	name: string,
	side: DeltaSide
): DeltaHeld | undefined => (made.get(name)?.has(side) === true ? undefined : { kind: "empty" })

/** The CTE of one side of a relation's delta within the statement that writes it (`deltaCte`): its name, and each of
 * the relation's fields, in heading order, with the column that holds it. */
export interface DeltaCteName {
	readonly relation: RelationInfo
	readonly side: DeltaSide
	readonly cte: string
	readonly heading: ReadonlyArray<CarrierColumn>
}

/** The name of the CTE of `relation`'s delta on `side`, and its columns, from `supply`. A statement's two forms name it
 * alike, so a read-back riding the statement reads it by one name in either. */
export const deltaCteName = (
	relation: RelationInfo,
	side: DeltaSide,
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

/** The rows of `named`'s side `statement`'s RETURNING returns, none where it returns no rows of that side: an
 * insertion removes nothing and only an insertion meets stored facts it did not refuse (insert/protocol.ts
 * writesMet). */
const returnedSideOf = (
	statement: ModifyingStatement<InsertResult | DeleteResult> | PutStatement,
	side: DeltaSide
): ReturnedSide | undefined => {
	const returned = statement.returning
	switch (side) {
		case "added":
			return returned.kind === "removed" ? undefined : returned.added
		case "removed":
			return returned.kind === "removed" || returned.kind === "both" ? returned.removed : undefined
		case "met":
			return returned.kind === "insertion" ? returned.met : undefined
	}
}

/**
 * The CTE `named` of `statement`, the one statement that makes that side of its relation's delta, for the read-backs
 * riding that statement: the rows its RETURNING CTE returns of that side, restricted by the side's conditions, so it
 * holds exactly the facts the statement made present or absent, each of the relation's fields in heading order:
 *
 *   WITH ..., "r2" AS (INSERT ... RETURNING ...),
 *   "r9"("c20", "c21") AS (SELECT "r2"."c4", "r2"."c5" FROM "r2")
 *
 * Every column of a write statement's RETURNING is a stored column, so it has the relation's type exactly and the CTE
 * casts nothing. None where the statement returns no rows of that side, whose delta is the empty relation (`deltaIn`).
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
