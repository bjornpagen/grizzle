import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { nominal } from "#compiler/core/brand.ts"
import { canonicalTextOf } from "#compiler/core/canonical.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { FieldId, NodeId, OccurrenceId, ParamId, VarId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { temporarySchema } from "#compiler/core/temporary.ts"
import {
	bodyPositionNames,
	type ColumnDef,
	type FromSource,
	type CteBody,
	isSetQuery,
	type OperandBody,
	type OperandSelect,
	type OrderItem,
	type Select,
	type SelectCore,
	type SetOperand
} from "#compiler/sql/ast.ts"
import { mapTargets, qualifiedCall, withArms } from "#compiler/sql/build.ts"

/**
 * Single-assignment SQL names.
 *
 * "Every relation occurrence in a statement receives a fresh alias r<n>. Every column a stage produces receives a
 * fresh name c<n> where it is defined and is referenced only as r<n>.c<n> afterwards. A name is defined exactly once
 * per statement and never shadowed ... CTEs and derived tables carry explicit column lists ... UNION arms rename their
 * columns position by position to the union's names. Only the outermost SELECT renames to the public heading."
 *
 * A NameSupply hands out those names for one statement and records where each came from; the NameMap it yields is
 * what diagnostics show beside the SQL, and the SQL never contains it. Names are never reused: there is no
 * register pressure, and the generated forms stay far inside the 63-byte identifier limit. The test kernel's structural
 * audit (test/support/oracle/verify/sql.ts) checks that a statement actually obeys the discipline; this module only
 * produces names and performs the one rename.
 *
 * A column that passes through a stage unchanged may keep its name, as the insert protocol's input columns do:
 * what is defined once is the qualified pair r<n>.c<n>, never a relation alias.
 *
 * Where a generated name came from. It travels in diagnostics only, never in SQL.
 */
export type NameOrigin =
	| { readonly kind: "occurrence"; readonly occurrence: OccurrenceId; readonly relation: string }
	| { readonly kind: "node"; readonly node: NodeId }
	| { readonly kind: "var"; readonly var: VarId }
	| { readonly kind: "field"; readonly field: FieldId }
	| { readonly kind: "param"; readonly param: ParamId }
	| { readonly kind: "internal"; readonly purpose: string }

interface NameEntry {
	readonly name: string
	readonly role: "relation" | "column"
	readonly origin: NameOrigin
}

/** In allocation order, which is deterministic for one lowering of one input. */
export type NameMap = ReadonlyArray<NameEntry>

export const emptyNameMap: NameMap = []

/**
 * A carrier's declaration: the columns of its CREATE TEMPORARY TABLE, of any width, and its key's columns, or none.
 */
export interface CarrierDeclaration {
	readonly columns: ReadonlyArray<ColumnDef>
	readonly primaryKey: NonEmptyReadonlyArray<string> | undefined
}

/**
 * __carrier_<ordinal>_<digest>: a write program's transaction-scoped carrier (write/carriers), the one name CREATE
 * TEMPORARY TABLE takes. Only carrierName spells one, through the naming door (core/identity.ts
 * identity.carrier). The ordinal is the carrier's place among its program's carriers, from 1, and the digest is its
 * declaration's: a session keeps each served statement under its text (core/prepared.ts), and PostgreSQL plans it again
 * over the carrier its next call creates, so a text that names a carrier must name one declaration, or a statement of
 * another program over a carrier of its ordinal with other column types or collations meets the plan its text cached
 * and fails as "cached plan must not change result type".
 */
export type CarrierName = string & { readonly [carrierNameBrand]: true }
declare const carrierNameBrand: unique symbol
const CarrierName = nominal<string, CarrierName>()

/**
 * The name of `carrier`'s reader, the session function every statement reads the carrier through (sql/print.ts
 * carrierReader): the carrier's own name and `_rows`, beside its emptying, which takes the carrier's name itself
 * (sql/print.ts carrierEmptying), within PostgreSQL's identifier length since a carrier's name is a fixed-width digest's.
 */
export const carrierReaderName = (carrier: CarrierName): string => `${carrier}${carrierReaderTail}`

/**
 * The rows of the carrier `carrier`, whose columns are `columns` in its table's order, as a statement reads them under
 * `alias`: through its reader, pg_temp."<carrier>_rows"() (`carrierReaderName`, write/carriers/carriers.ts
 * carrierReader), each column named in the FROM item's alias list as the carrier's table names it, so the statement's
 * plan depends on the function, never on the table its emptying may truncate. The one way a statement reads a carrier.
 */
export const carrierReaderScan = (
	carrier: CarrierName,
	columns: ReadonlyArray<string>,
	alias: string
): FromSource => ({
	kind: "function",
	call: qualifiedCall(
		{
			kind: "qualified",
			schema: temporarySchema,
			name: carrierReaderName(carrier),
			volatility: "VOLATILE"
		},
		[]
	),
	alias,
	columns: { kind: "named", names: columns, ordinality: false },
	lateral: false
})

/** What a carrier's reader's name adds to the carrier's (`carrierReaderName`). */
const carrierReaderTail = "_rows"

/**
 * The carrier whose reader `fn` names (`carrierReaderName`), none where it names no reader: how a reading of a
 * statement finds the carriers it reads through their readers (test/support/carrier-reads.ts).
 */
export const readerCarrier = (fn: string): CarrierName | undefined =>
	fn.endsWith(carrierReaderTail) ? CarrierName(fn.slice(0, -carrierReaderTail.length)) : undefined

/**
 * Whose session tables a program's carriers are: the role it runs as, or reality's. A login's pooled session runs every
 * role of the login, each transaction under one, and a carrier, a session table every COMMIT keeps (sql/ast.ts
 * CreateCarrier), is owned by the role whose stand-up made it, which alone may truncate it, as a use's emptying does
 * (sql/print.ts carrierEmptying): so a carrier's name digests its scope beside its declaration, and two roles' programs
 * of one declaration never meet one table, where the second's TRUNCATE of the first's was refused (42501).
 */
export type CarrierScope = string & { readonly [carrierScopeBrand]: true }
declare const carrierScopeBrand: unique symbol
const CarrierScope = nominal<string, CarrierScope>()

/** The carrier scope of a program that runs as the role `role`, or as reality where none. */
export const carrierScope = (role: string | undefined): CarrierScope =>
	CarrierScope(role === undefined ? "reality" : `role ${role}`)

/** The `ordinal`-th carrier of a program, from 1, of `declaration`, in its scope `scope`. */
export const carrierName = (
	scope: CarrierScope,
	ordinal: number,
	declaration: CarrierDeclaration
): CarrierName =>
	CarrierName(identifierOf(identity.carrier(scope, ordinal, canonicalTextOf(declaration))))

/**
 * The first relation and column numbers: 1 for a statement of its own; the write protocols number the input arrays
 * r0, and a statement that continues another's numbering starts after it.
 */
export interface NameSupplyStart {
	readonly relationStart: number
	readonly columnStart: number
}

/** A statement's own numbering, from r1 and c1. */
export const freshNames: NameSupplyStart = { relationStart: 1, columnStart: 1 }

/**
 * The numbering past every generated name `map` holds, from `from` at least: a statement that reads or continues the
 * one `map` names starts there, so their names never collide.
 */
export const namesPast = (map: NameMap, from: NameSupplyStart): NameSupplyStart => {
	let relationStart = from.relationStart
	let columnStart = from.columnStart
	for (const entry of map) {
		const next = Number(entry.name.slice(1)) + 1
		if (entry.role === "relation") {
			relationStart = Math.max(relationStart, next)
		} else {
			columnStart = Math.max(columnStart, next)
		}
	}
	return { relationStart, columnStart }
}

/** Fresh names for one statement. Local mutable state owned by one lowering; a later statement names past it. */
export class NameSupply {
	#relation: number
	#column: number
	readonly #entries: Array<NameEntry> = []

	constructor(start: NameSupplyStart) {
		this.#relation = start.relationStart
		this.#column = start.columnStart
	}

	relation(origin: NameOrigin): string {
		const name = `r${this.#relation}`
		this.#relation += 1
		this.#entries.push({ name, role: "relation", origin })
		return name
	}

	column(origin: NameOrigin): string {
		const name = `c${this.#column}`
		this.#column += 1
		this.#entries.push({ name, role: "column", origin })
		return name
	}

	/** One fresh column name per origin, in order. */
	columns(origins: ReadonlyArray<NameOrigin>): ReadonlyArray<string> {
		return origins.map((origin) => this.column(origin))
	}

	map(): NameMap {
		return [...this.#entries]
	}

	/**
	 * The numbering past every name this supply minted, from its start at least: where a statement after it starts.
	 */
	past(): NameSupplyStart {
		return { relationStart: this.#relation, columnStart: this.#column }
	}
}

/** The core's targets aliased by the heading, position by position: the lengths are equal, so every target has its alias. */
const renameCore = (
	c: SelectCore,
	heading: ReadonlyArray<string>
): Result.Result<SelectCore, CompileError> =>
	c.targets.length === heading.length
		? Result.ok(mapTargets(c, (target, i) => ({ expr: target.expr, alias: heading[i] })))
		: Result.err(
				malformedDescription(
					SourceLoc("sql outermost select", []),
					`a public heading of ${c.targets.length} columns, not ${heading.length}`
				)
			)

/**
 * Over a set operation or a parenthesized query, ORDER BY names the output columns unqualified (the kernel audit's
 * "output" mode), so renaming the outputs renames those references with them, position by position. Over a core, ORDER BY
 * reads the FROM relations, qualified, and is untouched.
 */
const renameOrderBy = (
	orderBy: ReadonlyArray<OrderItem>,
	old: ReadonlyArray<string | undefined>,
	heading: ReadonlyArray<string>
): ReadonlyArray<OrderItem> =>
	orderBy.map((item) => {
		const e = item.expr
		if (e.kind !== "column" || e.table !== undefined) {
			return item
		}
		/** renameBody has matched the heading to the outputs, so every output position names a heading column. */
		const column = heading[old.indexOf(e.column)]
		return column === undefined ? item : { ...item, expr: { ...e, column } }
	})

const renameSelect = (
	select: OperandSelect,
	heading: ReadonlyArray<string>
): Result.Result<OperandSelect, CompileError> =>
	Result.map(renameBody(select.body, heading), (body) => {
		if (select.orderBy.length === 0 || select.body.kind === "core") {
			return { ...select, body }
		}
		return {
			...select,
			body,
			orderBy: renameOrderBy(select.orderBy, bodyPositionNames(select.body), heading)
		}
	})

/**
 * UNION arms rename position by position to the union's names: every arm, not only the first, so
 * each arm reads on its own.
 */
const renameBody = (
	body: OperandBody,
	heading: ReadonlyArray<string>
): Result.Result<OperandBody, CompileError> => {
	switch (body.kind) {
		case "core":
		case "select":
			return renameOperand(body, heading)
		case "setOp": {
			const [first, second, ...rest] = body.arms
			return Result.flatMap(renameOperand(first, heading), (a) =>
				Result.flatMap(
					renameOperand(second, heading),
					(b): Result.Result<OperandBody, CompileError> => {
						const more: Array<SetOperand> = []
						for (const arm of rest) {
							const renamed = renameOperand(arm, heading)
							if (!renamed.ok) {
								return renamed
							}
							more.push(renamed.value)
						}
						return Result.ok(withArms(body, [a, b, ...more]))
					}
				)
			)
		}
	}
}

const renameOperand = (
	operand: SetOperand,
	heading: ReadonlyArray<string>
): Result.Result<SetOperand, CompileError> =>
	operand.kind === "core" ? renameCore(operand, heading) : renameSelect(operand, heading)

/**
 * `select` with its outputs named `names`, position by position, and the ORDER BY over a set operation's outputs
 * renamed with them (renameSelect): how a derived table's or a CTE's columns are given, its query their one place. A
 * count of names other than the query's outputs is a defect, of its maker's, before any statement holds it.
 */
export const namedQuery = (select: OperandSelect, names: ReadonlyArray<string>): OperandSelect => {
	const renamed = renameSelect(select, names)
	if (!renamed.ok) {
		throw defect(`a name for each of a query's outputs: ${renamed.error.message}`)
	}
	return renamed.value
}

/**
 * A CTE's body with its outputs named `names`: a query's (namedQuery), or a data-modifying statement's RETURNING targets',
 * position by position, a count of names other than its outputs a defect, as `namedQuery`'s.
 */
export const namedBody = (body: CteBody, names: ReadonlyArray<string>): CteBody => {
	if (body.kind === "select") {
		return namedQuery(body, names)
	}
	if (body.returning.length !== names.length) {
		throw defect(
			`a name for each of a data-modifying statement's ${body.returning.length} RETURNING targets, not ${names.length}`
		)
	}
	return { ...body, returning: body.returning.map((t, i) => ({ expr: t.expr, alias: names[i] })) }
}

/**
 * Renames the outermost SELECT's output columns to the public heading, by position, and the ORDER BY
 * references to those outputs with them. Nothing nested is touched: every inner stage keeps its generated names.
 */
export const renameToPublicHeading = (
	select: Select,
	heading: ReadonlyArray<string>
): Result.Result<Select, CompileError> =>
	Result.map(renameSelect(select, heading), (renamed) => {
		if (!isSetQuery(renamed)) {
			throw defect("a rename that keeps a set query a set")
		}
		return renamed
	})
