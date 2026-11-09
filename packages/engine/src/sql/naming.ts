import { nominal } from "#compiler/core/brand.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import { maxIdentifierBytes } from "#compiler/core/identity.ts"
import type { FieldId, NodeId, OccurrenceId, ParamId, VarId } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import { derived } from "#compiler/core/limits.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import {
	isSetQuery,
	type OperandBody,
	type OperandSelect,
	type OrderItem,
	type Select,
	type SelectCore,
	type SetOperand
} from "#compiler/sql/ast.ts"
import { mapTargets, withArms } from "#compiler/sql/build.ts"

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

/** Whether a text spells a natural number in decimal with no leading zero ("0" itself included). */
export const isDecimal = (text: string): boolean => {
	if (text === "") {
		return false
	}
	if (text.length > 1 && text.startsWith("0")) {
		return false
	}
	for (const ch of text) {
		if (ch < "0" || ch > "9") {
			return false
		}
	}
	return true
}

/** What every carrier's name starts with. */
export const carrierPrefix = "__carrier_"

/** What parts a carrier's types digest from its ordinal. */
export const carrierSeparator = "_"

/**
 * The decimal digits of the longest ordinal a carrier's name holds: Number.MAX_SAFE_INTEGER's decimal length. An
 * ordinal counts the carriers of one column-type class that one program holds, each an object the program keeps, so
 * the count stays a safe integer, which this many decimal digits write.
 *
 * @formatConstant a carrier's ordinal: a safe integer, in decimal
 */
const ordinalDigits = String(Number.MAX_SAFE_INTEGER).length

/**
 * The hex digits of a carrier's types digest: the leading digits of SHA-256 over its column types' canonical text.
 * Collision arithmetic: n distinct column-type lists in one process share a digest with probability at most
 * n(n - 1) / 2 / 2^144, below 2^-81 for n = 2^32; two programs that share one never meet, since a carrier lives in
 * one transaction and every statement runs unnamed, and one program that holds both is refused at compile time
 * (write/carriers CarrierSupply).
 */
export const carrierDigestHex = derived({
	owner: "grizzle's carrier names (sql/naming.ts carrierName)",
	unit: "hex digits",
	scope: "the types digest of one carrier's name",
	from: [maxIdentifierBytes],
	derivation:
		"maxIdentifierBytes less the lengths of carrierPrefix, carrierSeparator and the longest ordinal (ordinalDigits): the widest digest a name with the longest ordinal still fits in PostgreSQL's identifier, which would truncate a longer one",
	compute: ([identifier]) =>
		identifier.value - carrierPrefix.length - carrierSeparator.length - ordinalDigits
})

/**
 * __carrier_<digest>_<ordinal>: a write program's transaction-scoped carrier (write/carriers), the one name CREATE
 * TEMPORARY TABLE and ANALYZE take. Only carrierName spells one. The digest names the carrier's column types and the
 * ordinal its place among the program's carriers of those types (write/carriers), so equal statement text addresses
 * carriers of equal column types in every program, and no count of carriers runs out of names.
 */
export type CarrierName = string & { readonly [carrierNameBrand]: true }
declare const carrierNameBrand: unique symbol
const CarrierName = nominal<string, CarrierName>()

/**
 * The `ordinal`-th carrier, from 1, of the column types whose digest is `digest` (carrierDigestHex lowercase hex
 * digits, write/carriers typesDigest).
 */
export const carrierName = (digest: string, ordinal: number): CarrierName =>
	CarrierName(`${carrierPrefix}${digest}${carrierSeparator}${ordinal}`)

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

/** Fresh names for one statement. Local mutable state owned by one lowering; never shared across statements. */
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
}

const describeOrigin = (origin: NameOrigin): string => {
	switch (origin.kind) {
		case "occurrence":
			return `occurrence ${origin.occurrence} of ${origin.relation}`
		case "node":
			return `node ${origin.node}`
		case "var":
			return `variable ${origin.var}`
		case "field":
			return `field ${origin.field}`
		case "param":
			return `parameter ${origin.param}`
		case "internal":
			return `internal ${origin.purpose}`
	}
}

/** The name map as diagnostics show it, one line per name: "r1 relation occurrence o1 of Task". */
export const renderNameMap = (map: NameMap): string =>
	map.map((entry) => `${entry.name} ${entry.role} ${describeOrigin(entry.origin)}`).join("\n")

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
 * The column names a query body's output carries, position by position, as PostgreSQL derives them: a target's alias,
 * or for an unaliased column reference the column's own name; undefined for any other unaliased target. A set
 * operation's names are its left arm's, as PostgreSQL takes them. The kernel's audit holds a set operation's ORDER BY
 * and its arms' names to these, so the rename below reads the same names.
 */
export const bodyPositionNames = (body: OperandBody): ReadonlyArray<string | undefined> => {
	switch (body.kind) {
		case "core":
			return body.targets.map(
				(target) => target.alias ?? (target.expr.kind === "column" ? target.expr.column : undefined)
			)
		case "setOp":
			return bodyPositionNames(body.arms[0])
		case "select":
			return bodyPositionNames(body.body)
	}
}

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
