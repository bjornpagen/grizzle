import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { nominal } from "#compiler/core/brand.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import type { FieldId, NodeId, OccurrenceId, ParamId, VarId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import {
	bodyPositionNames,
	type ColumnDef,
	type CteBody,
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

/** A carrier's declaration: its columns, of any width, each typed as its values travel (write/carriers). */
export interface CarrierDeclaration {
	readonly columns: ReadonlyArray<ColumnDef>
}

/**
 * __carrier_<ordinal>: a write program's carrier (write/carriers), the name its settings take (write/carriers/carriers.ts
 * carrierSetting), the ordinal its place among its program's carriers, from 1. Only carrierName spells one. A carrier
 * lives in its transaction's settings, which its flight writes before any statement reads it, so a name is its program's
 * alone: two programs' carriers of one ordinal never meet, and every reader's text casts the setting to the type it
 * reads.
 */
export type CarrierName = string & { readonly [carrierNameBrand]: true }
declare const carrierNameBrand: unique symbol
const CarrierName = nominal<string, CarrierName>()

/** What every carrier's name starts with, before its ordinal (`carrierName`). */
export const carrierPrefix = "__carrier_"

/** The `ordinal`-th carrier of a program, from 1. */
export const carrierName = (ordinal: number): CarrierName =>
	CarrierName(`${carrierPrefix}${ordinal}`)

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

declare const aliasBrand: unique symbol

/**
 * An alias a plan names a relation or a level by: one an advice scope minted (AdviceScope), `r<n>`, n from 1; or one a
 * role's view's body names its relation by (`wholeViewAlias`), `v<n>`, which PostgreSQL plans the relation under once it
 * flattens the view into the level that reads it, a spelling no scope mints, so a statement's own aliases and its views'
 * never meet. So no plan names `x`, the alias PostgreSQL's own foreign key queries plan under (ri_triggers.c) whatever
 * advice is in force, nor `*RESULT*`, `*SELECT*`, `unnamed_subquery`, `ANY_subquery`, nor any `<word>_<n>` the planner
 * names a sublink's or a set operation's level by (planner.c choose_plan_name): impossible by the spelling, never
 * refused by a check.
 */
export type Alias = (`r${number}` | `v${number}` | `v${number}n${number}`) & {
	readonly [aliasBrand]: true
}

const mintAlias = nominal<`r${number}` | `v${number}` | `v${number}n${number}`, Alias>()

/**
 * The alias the body of the whole view of the `ordinal`-th stored relation, from 1, names its table by (physical/ddl/
 * roles.ts wholeView, physical/access/catalog.ts wholeViewAliases): `v<ordinal>`, a spelling no advice scope mints.
 */
export const wholeViewAlias = (ordinal: number): Alias => mintAlias(`v${ordinal}`)

/** What a binding mints its aliases from (sql/bind.ts): an advice scope, or a world view's scope. */
export interface Scope {
	alias(origin: NameOrigin): Alias
}

/**
 * The scope a role's world view's body is bound under (sql/bind.ts bindView), the `ordinal`-th of its role's query
 * entries by name: `v<ordinal>n<j>`, j from 1, a spelling no advice scope mints. PostgreSQL plans the view apart under
 * the reference's alias, so a read's targets inside it are `v<ordinal>n<j>@<reference alias>`, and each level of its
 * own is named `v<ordinal>n<j>`, a name no other view of the role holds. Every binding of one view's body mints the same
 * names in the same order, its installation's and each reader's alike. Local mutable state owned by one binding.
 */
export class ViewScope implements Scope {
	readonly #ordinal: number
	#minted = 0

	constructor(ordinal: number) {
		this.#ordinal = ordinal
	}

	alias(_origin: NameOrigin): Alias {
		this.#minted += 1
		return mintAlias(`v${this.#ordinal}n${this.#minted}`)
	}

	/** How many aliases the scope minted. */
	minted(): number {
		return this.#minted
	}
}

/**
 * One advice scope (sql/advice.ts): every alias of every statement bound in it, a relation's, a sub-query's, a probe's
 * and a CTE's, comes from it, so no two relations of the scope share one and every advice item names one relation of
 * one statement (Law 3). A scope is one transaction's, all it may send under the advice its first flight sets: a served
 * write's statements, every unit of each parted one, its read-backs, its refused-COMMIT witness and the EXPLAIN of any
 * of them; a served read's statements; an installed routine's, every statement of its body; or a statement deploy sends
 * by itself. Its numbering is its own, from r1: local mutable state owned by the one binding of the scope
 * (sql/bind.ts).
 */
export class AdviceScope implements Scope {
	#next = 1
	readonly #entries: Array<NameEntry> = []

	/** A fresh alias of the scope, recorded with where it came from, which diagnostics show beside the SQL. */
	alias(origin: NameOrigin): Alias {
		const name = mintAlias(`r${this.#next}`)
		this.#next += 1
		this.#entries.push({ name, role: "relation", origin })
		return name
	}

	/** Every alias the scope minted, in minting order. */
	map(): NameMap {
		return [...this.#entries]
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
		defect(`a name for each of a query's outputs: ${renamed.error.message}`)
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
		defect(
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
			defect("a rename that keeps a set query a set")
		}
		return renamed
	})
