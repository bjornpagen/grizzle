import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import {
	builtinFunctions,
	type Cte,
	type Dml,
	type Expr,
	type FromItem,
	type FromSource,
	type OperandSelect,
	type SqlStatement,
	type With
} from "#compiler/sql/ast.ts"
import {
	type AstHooks,
	identityHooks,
	inertVisitor,
	transformQuery,
	transformStatement,
	visitDml,
	visitSelect
} from "#compiler/sql/transform.ts"

/**
 * Print once: a statement's text states a CTE only where PostgreSQL plans it as one.
 *
 * PostgreSQL inlines a CTE that its query reads exactly once, that is not MATERIALIZED, not recursive, writes nothing
 * and calls no VOLATILE function (subselect.c SS_process_ctes), and it inlines each such CTE by a walk of the whole
 * statement (inline_cte, inline_cte_walker): k inlined CTEs cost k walks, O(k * size), which in a megabyte statement of
 * hundreds of single-use CTEs was the larger part of its planning (lane PLANSIZE: 38-62% of a read's, 16-28% of a
 * write's). So the printer prints every such CTE in place, as the derived table PostgreSQL's inlining makes of it,
 * `(<its query>) AS "<the reference's alias>"(<its columns>)`, and PostgreSQL meets no CTE to inline: the same query,
 * the same plan, planned at O(size).
 *
 * A lowering names a sub-result by a CTE where it reads it; whether that CTE is printed as one is decided here alone,
 * by the one fact that decides it, how many references the statement holds to it after every rewrite of the statement
 * (write/program/slot-carriers.ts). A CTE read by two references or more, a MATERIALIZED one, a recursive WITH's, a
 * data-modifying one and one whose query calls a VOLATILE function (sql/ast.ts QualifiedFunctionRef and
 * builtinFunctions volatility; a context source calls the refusal function) stays a CTE, as PostgreSQL keeps it.
 *
 * A CTE PostgreSQL would inline that is still printed as one is an internal compiler error (assertPrintedOnce), the
 * invariant every statement is held to before it is printed (sql/print.ts printStatement).
 */

/** Where a reference to a CTE of a statement's own WITH stands: inside one of its CTEs, by place, or in its body. */
export type ReferenceSite =
	| { readonly kind: "cte"; readonly at: number }
	| { readonly kind: "body" }

/** Whether a CTE read by `references` references is printed in place (the module header). */
const printableInPlace = (cte: Cte, references: number): boolean =>
	references === 1 &&
	cte.materialized !== "MATERIALIZED" &&
	cte.query.kind === "select" &&
	!callsVolatile(cte.query)

/** Whether a query calls a VOLATILE function anywhere, its sub-queries' calls included (contain_volatile_functions). */
const callsVolatile = (query: OperandSelect): boolean => {
	let volatile = false
	visitSelect(query, {
		...inertVisitor,
		expr: (e: Expr) => {
			if (e.kind === "call") {
				volatile ||=
					e.fn.kind === "qualified"
						? e.fn.volatility === "VOLATILE"
						: builtinFunctions[e.fn.name].volatility === "VOLATILE"
			}
		},
		fromItem: (item: FromItem) => {
			volatile ||= item.kind === "context"
		}
	})
	return volatile
}

/** A statement holding a WITH of its own: a query, or a data-modifying statement. */
type Holder = OperandSelect | Exclude<Dml, { readonly kind: "select" }>

/** Every FROM item of `holder`, its own WITH's CTEs and every sub-query included. */
const visitItems = (holder: Holder, fromItem: (item: FromItem) => void): void => {
	if (holder.kind === "select") {
		visitSelect(holder, { ...inertVisitor, fromItem })
	} else {
		visitDml(holder, { ...inertVisitor, fromItem })
	}
}

/**
 * How many references `holder` holds to each CTE of its own WITH `w`: a CTE reference's (FromSource `cte`), a met rows
 * source's to its proposed rows and its insert, and an enclosing source's. A CTE that a met rows or an enclosing source
 * reads is printed by name there, so it is never printed in place, however many references read it (`pinned`).
 */
const referencesOf = (
	holder: Holder,
	w: With
): { readonly counts: ReadonlyMap<string, number>; readonly pinned: ReadonlySet<string> } => {
	const counts = new Map<string, number>(w.ctes.map((c) => [c.name, 0]))
	const pinned = new Set<string>()
	const read = (name: string, byName: boolean): void => {
		const n = counts.get(name)
		if (n !== undefined) {
			counts.set(name, n + 1)
			if (byName) {
				pinned.add(name)
			}
		}
	}
	visitItems(holder, (item) => {
		if (item.kind === "cte") {
			read(item.name, false)
		} else if (item.kind === "metRows") {
			read(item.proposed, true)
			read(item.insert, true)
		} else if (item.kind === "enclosing") {
			read(item.name, true)
		}
	})
	return { counts, pinned }
}

/** The CTEs of `holder`'s own WITH printed in place, by name (printableInPlace), none in a recursive WITH. */
const inPlaceCtes = (holder: Holder, w: With): ReadonlyMap<string, Cte> => {
	if (w.recursive) {
		return new Map()
	}
	const { counts, pinned } = referencesOf(holder, w)
	return new Map(
		w.ctes
			.filter((c) => !pinned.has(c.name) && printableInPlace(c, counts.get(c.name) ?? 0))
			.map((c) => [c.name, c])
	)
}

/**
 * The hooks that print each CTE of `chosen` at its one reference: the derived table of its query, the references that
 * query makes to others of `chosen` printed in place in it too, under the reference's alias, or its name where the
 * reference has none, and its columns.
 */
const inPlaceHooks = (chosen: ReadonlyMap<string, Cte>): AstHooks => {
	const hooks: AstHooks = {
		...identityHooks,
		replaceSource: (source: FromSource): FromSource | undefined => {
			if (source.kind !== "cte") {
				return undefined
			}
			const cte = chosen.get(source.name)
			if (cte?.query.kind !== "select") {
				return undefined
			}
			return {
				kind: "derived",
				query: transformQuery(cte.query, hooks),
				alias: source.alias ?? cte.name,
				columns: cte.columns,
				lateral: false
			}
		}
	}
	return hooks
}

/** `w` without the CTEs of `chosen`: none, where it held no other. */
const withoutChosen = (w: With, chosen: ReadonlyMap<string, Cte>): With | undefined => {
	const kept = w.ctes.filter((c) => !chosen.has(c.name))
	return isNonEmpty(kept) ? { ...w, ctes: kept } : undefined
}

/** A query whose own WITH holds no CTE printed in place: each printed at its reference. */
const queryPrintedOnce = (query: OperandSelect): OperandSelect => {
	const w = query.with
	const chosen = w === undefined ? new Map<string, Cte>() : inPlaceCtes(query, w)
	return w === undefined || chosen.size === 0
		? query
		: transformQuery({ ...query, with: withoutChosen(w, chosen) }, inPlaceHooks(chosen))
}

/**
 * The statement as it is printed (the module header): every CTE PostgreSQL would inline printed in place, its
 * sub-queries' first, then its own WITH's, a data-modifying statement's among them. Held to assertPrintedOnce.
 */
export const printedOnce = (statement: SqlStatement): SqlStatement => {
	const nested = transformStatement(statement, { ...identityHooks, select: queryPrintedOnce })
	const printed = isDmlWithWith(nested) ? dmlPrintedOnce(nested) : nested
	assertPrintedOnce(printed)
	return printed
}

/** A data-modifying statement whose own WITH holds no CTE printed in place: each printed at its reference. */
const dmlPrintedOnce = (
	statement: Exclude<Dml, { readonly kind: "select" }> & { readonly with: With }
): SqlStatement => {
	const chosen = inPlaceCtes(statement, statement.with)
	return chosen.size === 0
		? statement
		: transformStatement(
				{ ...statement, with: withoutChosen(statement.with, chosen) },
				inPlaceHooks(chosen)
			)
}

/** A data-modifying statement with a WITH of its own. */
const isDmlWithWith = (
	statement: SqlStatement
): statement is Exclude<Dml, { readonly kind: "select" }> & { readonly with: With } =>
	(statement.kind === "insert" ||
		statement.kind === "update" ||
		statement.kind === "delete" ||
		statement.kind === "merge") &&
	statement.with !== undefined

/**
 * Where each CTE of a single statement's own WITH that is printed in place has its one reference (ReferenceSite):
 * inside which of its CTEs, by place, or in its body. A single statement's units read it to keep each such CTE's text in
 * the unit that reads it (write/program/single.ts partedOf).
 */
export const inPlaceSites = (query: OperandSelect): ReadonlyMap<string, ReferenceSite> => {
	const w = query.with
	if (w === undefined) {
		return new Map()
	}
	const chosen = inPlaceCtes(query, w)
	const sites = new Map<string, ReferenceSite>()
	let site: ReferenceSite = { kind: "body" }
	const note = (item: FromItem): void => {
		if (item.kind === "cte" && chosen.has(item.name)) {
			sites.set(item.name, site)
		}
	}
	w.ctes.forEach((c, at) => {
		site = { kind: "cte", at }
		visitItems(c.query, note)
	})
	site = { kind: "body" }
	visitItems({ ...query, with: undefined }, note)
	return sites
}

/**
 * The invariant every printed statement is held to: no query or data-modifying statement of it holds in its own WITH a
 * CTE PostgreSQL would inline (printableInPlace). A statement that breaks it is a defect of the printer, which prints
 * every such CTE in place (printedOnce), never a property of the lowering's input.
 */
export const assertPrintedOnce = (statement: SqlStatement): void => {
	const refuse = (holder: Holder, w: With): void => {
		for (const cte of inPlaceCtes(holder, w).values()) {
			throw defect(
				`print once: the CTE ${cte.name} is read once, is not MATERIALIZED, writes nothing and calls no VOLATILE function, so PostgreSQL would inline it by a walk of the whole statement; the printer prints it in place (sql/print-once.ts)`
			)
		}
	}
	transformStatement(statement, {
		...identityHooks,
		select: (query) => {
			if (query.with !== undefined) {
				refuse(query, query.with)
			}
			return query
		}
	})
	if (isDmlWithWith(statement)) {
		refuse(statement, statement.with)
	}
}
