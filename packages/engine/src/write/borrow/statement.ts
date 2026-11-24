/**
 * A call's borrow statement (README "Units"): one statement of its last flight, before every statement that reads or
 * writes a borrowed unit's rows takes its snapshot, that takes locks the call borrows in flight (core/certificate.ts
 * Borrow `flight`), each once at the strongest mode its borrows name, in the order of their ids (write/borrow/lock.ts
 * lockId), by the installation's borrow function (write/borrow/function.ts):
 *
 *   SELECT "<schema>"."__borrow"(pg_catalog.array_agg("r1"."c1" ORDER BY "r1"."c1"),
 *            pg_catalog.array_agg("r1"."c2" ORDER BY "r1"."c1"))::text AS "c3"
 *   FROM (SELECT "r2"."c1", pg_catalog.bool_or("r2"."c2") FROM (<arm> UNION ALL …) AS "r2"("c1", "c2")
 *         GROUP BY "r2"."c1") AS "r1"("c1", "c2")
 *
 * each arm one borrow's ids, `SELECT <lockId> AS c1, <exclusive> AS c2 FROM <its keys' source> [WHERE …]`, a series'
 * of no source. array_agg's ORDER BY fixes each array's order (PostgreSQL 19 documentation, "Aggregate Expressions"),
 * and the function walks them in it, so the locks are taken in id order whatever plan the statement runs by, and two
 * calls never wait on each other in a cycle. Every key is evaluated at the statement's snapshot, before any of its
 * locks: a key the call learns by reading is read again by the statements after it, at a snapshot that follows every
 * lock, so the certifier admits only a source that reads alike at both, sealed, or held by a lock an earlier borrow
 * statement of the flight took, every one of whose kinds ranks below every kind this one takes (core/certificate.ts
 * KeySite). The flight that sends it carries COMMIT in the same pipeline, so no lock is held across a round trip of the
 * host. Its one row carries nothing to decode.
 */
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { BorrowLock } from "#compiler/core/certificate.ts"
import type { Expr, FromItem, Select, SetOperand } from "#compiler/sql/ast.ts"
import {
	call,
	cast,
	col,
	core,
	derived,
	grouped,
	lit,
	operandSelect,
	operandUnionAll,
	provedSelect,
	qualifiedCall,
	target,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import { namedQuery, type NameSupply } from "#compiler/sql/naming.ts"
import { borrowFunctionName } from "#compiler/write/borrow/function.ts"
import { type LockKey, lockId } from "#compiler/write/borrow/lock.ts"

const internal = (purpose: string) => ({ kind: "internal", purpose }) as const

/**
 * One borrow as its arm of the borrow statement takes it: whether exclusive, and what it locks, a lock kind
 * (core/certificate.ts BorrowLock) whose rank its statement reads (`rankOf`): a unit, at its keys, the rows of a source,
 * one key per row, each key field's value over it in the unit's key order; or a series' lock, which takes no key.
 */
export type BorrowArm = { readonly exclusive: boolean } & (
	| { readonly kind: "unit"; readonly unit: string; readonly keys: BorrowKeys }
	| { readonly kind: "series"; readonly relation: string }
)

/** The keys of a borrow arm: its source's rows, filtered by `where`, each the key `fields` read over it. */
export interface BorrowKeys {
	readonly from: ReadonlyArray<FromItem>
	readonly where: Expr | undefined
	readonly fields: NonEmptyReadonlyArray<LockKey>
}

/** What names a borrow query's relations and columns: a statement's name supply, or a function body's own names. */
export type BorrowNames = Pick<NameSupply, "relation" | "column">

/**
 * The query that takes every lock of `arms` in the order of their ids, each once at the strongest mode its arms name, by
 * the borrow function of `schema` (see the module's header), each lock kind's rank `rankOf` gives: a write's rank
 * placeholder in a call's flight, the rank itself at the judge (physical/ddl/rules.ts).
 */
export const borrowQuery = (
	schema: string,
	arms: NonEmptyReadonlyArray<BorrowArm>,
	rankOf: (lock: BorrowLock) => Expr,
	names: BorrowNames
): Select => {
	const [id, exclusive] = [names.column(internal("lock id")), names.column(internal("exclusive"))]
	const arm = (a: BorrowArm): SetOperand => {
		const mode = targetAs(lit.bool(a.exclusive), exclusive)
		switch (a.kind) {
			case "unit":
				return core(
					[targetAs(lockId(rankOf(a), a.unit, a.keys.fields), id), mode],
					a.keys.from,
					a.keys.where
				)
			case "series":
				return core([targetAs(lockId(rankOf(a), a.relation, []), id), mode], [], undefined)
		}
	}
	const each = names.relation(internal("borrowed locks"))
	const locks = names.relation(internal("locks"))
	const byId = grouped(
		core(
			[target(col(each, id)), target(call("bool_or", [col(each, exclusive)]))],
			[
				derived(
					namedQuery(operandSelect(operandUnionAll(mapNonEmpty(arms, arm))), [id, exclusive]),
					each,
					false
				)
			],
			undefined
		),
		[col(each, id)]
	)
	const ordered = (column: string): Expr => ({
		...call("array_agg", [col(locks, column)]),
		orderBy: [{ expr: col(locks, id), direction: "ASC" }]
	})
	return provedSelect(
		"oneRow",
		[
			targetAs(
				cast(
					qualifiedCall(
						{ kind: "qualified", schema, name: borrowFunctionName, volatility: "VOLATILE" },
						[ordered(id), ordered(exclusive)]
					),
					types.text
				),
				names.column(internal("borrowed"))
			)
		],
		[derived(namedQuery(operandSelect(byId), [id, exclusive]), locks, false)],
		undefined
	)
}
