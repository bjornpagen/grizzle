/**
 * What the property of print-once.test.ts reads: drawn statements of one to four CTEs, each plain, MATERIALIZED, NOT
 * MATERIALIZED or calling a VOLATILE function, each read by none, one or two references of the body, the CTE after it
 * reading it once or not, under a WITH that is recursive or not; the statement a shape builds; and the statement print
 * once must print of it, built a second way: each CTE PostgreSQL would inline written in place by hand.
 */

import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type {
	Cte,
	FromSource,
	OperandSelect,
	QualifiedFunctionRef,
	Select
} from "#compiler/sql/ast.ts"
import {
	col,
	core,
	cteRefAs,
	derived,
	distinctCore,
	operandSelect,
	qualifiedCall,
	select,
	table,
	target,
	targetAs
} from "#compiler/sql/build.ts"

/** A CTE's kind: what decides, beside its references, whether PostgreSQL would inline it. */
export type CteKind = "plain" | "materialized" | "notMaterialized" | "volatile"

/** One CTE: its kind, how many references the body holds to it, and whether the CTE after it reads it once. */
export interface CteShape {
	readonly kind: CteKind
	readonly bodyReads: number
	readonly readByNext: boolean
}

/** A drawn statement: its CTEs in order, and whether its WITH is recursive. */
export interface StatementShape {
	readonly ctes: ReadonlyArray<CteShape>
	readonly recursive: boolean
}

const cteGen: Gen<CteShape> = (source) => ({
	kind: source.draw(element(["plain", "materialized", "notMaterialized", "volatile"] as const)),
	bodyReads: source.draw(int(0, 2)),
	readByNext: source.draw(boolean)
})

export const statementGen: Gen<StatementShape> = (source) => ({
	ctes: source.draw(array(cteGen, { min: 1, max: 4 })),
	recursive: source.draw(boolean)
})

/** A VOLATILE function of pg_catalog, as a reference to it declares it. */
const random: QualifiedFunctionRef = {
	kind: "qualified",
	schema: "pg_catalog",
	name: "random",
	volatility: "VOLATILE"
}

const nameOf = (i: number): string => `r${100 + i}`
const columnOf = (i: number): string => `c${100 + i}`

/** How many references the statement holds to CTE `i`: the body's, and the next CTE's read of it. */
const referencesOf = (shape: StatementShape, i: number): number => {
	const own = shape.ctes[i]
	return (own?.bodyReads ?? 0) + (own?.readByNext === true && i + 1 < shape.ctes.length ? 1 : 0)
}

/** Whether PostgreSQL would inline CTE `i` of `shape`, so print once prints it in place. */
export const inPlace = (shape: StatementShape, i: number): boolean => {
	const own = shape.ctes[i]
	return (
		own !== undefined &&
		!shape.recursive &&
		referencesOf(shape, i) === 1 &&
		(own.kind === "plain" || own.kind === "notMaterialized")
	)
}

/**
 * The statement of `shape`, each reference to a CTE read through `read`: CTE i reads CTE i - 1 once where that one is
 * `readByNext`, and a table otherwise; the body reads each CTE as many times as its `bodyReads`, every reference under
 * an alias of its own, named by its place, so both constructions name every alias alike, and a table where it reads
 * none.
 */
const built = (
	shape: StatementShape,
	read: (i: number, alias: string, self: (i: number) => OperandSelect) => FromSource,
	keep: (i: number) => boolean
): Select => {
	const query = (i: number): OperandSelect => {
		const own = shape.ctes[i]
		const previous = shape.ctes[i - 1]
		const at = `r${200 + i}`
		const from =
			i > 0 && previous?.readByNext === true ? read(i - 1, at, query) : table("s", "t", at)
		const value =
			own?.kind === "volatile"
				? qualifiedCall(random, [])
				: col(at, i > 0 && previous?.readByNext === true ? columnOf(i - 1) : "a")
		return operandSelect(core([targetAs(value, columnOf(i))], [from], undefined))
	}
	const ctes: Array<Cte> = []
	Arr.forEach(shape.ctes, (c, i) => {
		if (keep(i)) {
			ctes.push({
				name: nameOf(i),
				materialized:
					c.kind === "materialized"
						? "MATERIALIZED"
						: c.kind === "notMaterialized"
							? "NOT MATERIALIZED"
							: undefined,
				query: query(i)
			})
		}
	})
	const from = Arr.flatMap(shape.ctes, (c, i) =>
		Array.from({ length: c.bodyReads }, (_, k) => read(i, `r${300 + 3 * i + k}`, query))
	)
	const [first, ...rest] = ctes
	const body = distinctCore(
		[target(col("r0", "x"))],
		from.length > 0 ? from : [table("s", "t", "r0")],
		undefined
	)
	return {
		...select(body),
		with: first === undefined ? undefined : { recursive: shape.recursive, ctes: [first, ...rest] }
	}
}

/** The statement a shape builds, every CTE a CTE. */
export const statementOf = (shape: StatementShape): Select =>
	built(
		shape,
		(i, alias) => cteRefAs(nameOf(i), alias),
		() => true
	)

/**
 * The statement print once prints of a shape, built by hand: each CTE PostgreSQL would inline written in place, at its
 * one reference, as the derived table of its query under the reference's alias and its columns, and every other CTE a
 * CTE.
 */
export const printedByHand = (shape: StatementShape): Select =>
	built(
		shape,
		(i, alias, query) =>
			inPlace(shape, i) ? derived(query(i), alias, false) : cteRefAs(nameOf(i), alias),
		(i) => !inPlace(shape, i)
	)

/** What a case is about. */
export type PrintOnceFeature =
	| "a CTE printed in place"
	| "a CTE read twice kept"
	| "a MATERIALIZED CTE kept"
	| "a CTE calling a VOLATILE function kept"
	| "a recursive WITH kept"
	| "a chain printed in place"

export const printOnceFeatures: ReadonlyArray<PrintOnceFeature> = [
	"a CTE printed in place",
	"a CTE read twice kept",
	"a MATERIALIZED CTE kept",
	"a CTE calling a VOLATILE function kept",
	"a recursive WITH kept",
	"a chain printed in place"
]

/** The features a shape holds. */
export const featuresOf = (shape: StatementShape): ReadonlyArray<PrintOnceFeature> => {
	const features = new Set<PrintOnceFeature>()
	Arr.forEach(shape.ctes, (c, i) => {
		const refs = referencesOf(shape, i)
		if (inPlace(shape, i)) {
			features.add("a CTE printed in place")
			if (i > 0 && shape.ctes[i - 1]?.readByNext === true && inPlace(shape, i - 1)) {
				features.add("a chain printed in place")
			}
		}
		if (refs === 2) {
			features.add("a CTE read twice kept")
		}
		if (refs === 1 && c.kind === "materialized") {
			features.add("a MATERIALIZED CTE kept")
		}
		if (refs === 1 && c.kind === "volatile") {
			features.add("a CTE calling a VOLATILE function kept")
		}
		if (refs === 1 && shape.recursive && c.kind === "plain") {
			features.add("a recursive WITH kept")
		}
	})
	return [...features]
}
