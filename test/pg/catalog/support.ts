import { array, constant, type Gen, int, map, weighted } from "@grizzle/testing/gen"
import { Array as Arr, Order } from "effect"
import { catchRefusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import { canonicalZero } from "#compiler/ir/carriers.ts"
import type { Certificate, CertificateRule } from "#compiler/ir/certificate.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { LowerContext } from "#compiler/lower/conservative/context.ts"
import { ConservativeDelivery } from "#compiler/lower/conservative/deliver.ts"
import type { CatalogOptions } from "#compiler/lower/shapes/catalog/context.ts"
import { type CatalogResult, rewriteCatalog } from "#compiler/lower/shapes/catalog/rewrite.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { defined } from "#test/support/assert.ts"
import { catalogDispatch } from "#test/support/compile.ts"
import { genCatalog } from "#test/support/evidence.ts"
import type { QueryDesc } from "#test/support/fixtures/ir/desc.ts"
import { canonicalFacts } from "#test/support/oracle/gen/facts.ts"
import { genParamDecls } from "#test/support/oracle/gen/query.ts"
import { type GenSchema, schemaDesc } from "#test/support/oracle/gen/schema.ts"
import {
	type LabelledCase,
	type Lowering,
	type SentProgram,
	sentConservative
} from "#test/support/oracle/runner.ts"
import { checkAuthored, checking, checkOptions } from "#test/support/policy.ts"

const int4 = plainType("int4")
const int8 = plainType("int8")
const float8 = plainType("float8")

/** Sitting(id, student, day, score), Price(id, student, day, amount), Point(id, grp, x, y). */
export const lab: GenSchema = {
	name: "Lab",
	relations: [
		{
			name: "Sitting",
			columns: [
				{ name: "id", type: int8 },
				{ name: "student", type: int4 },
				{ name: "day", type: int4 },
				{ name: "score", type: float8 }
			],
			primaryKey: ["id"],
			keys: [],
			mutable: false
		},
		{
			name: "Price",
			columns: [
				{ name: "id", type: int8 },
				{ name: "student", type: int4 },
				{ name: "day", type: int4 },
				{ name: "amount", type: int8 }
			],
			primaryKey: ["id"],
			keys: [],
			mutable: false
		},
		{
			name: "Point",
			columns: [
				{ name: "id", type: int8 },
				{ name: "grp", type: int4 },
				{ name: "x", type: float8 },
				{ name: "y", type: float8 }
			],
			primaryKey: ["id"],
			keys: [],
			mutable: false
		}
	],
	closed: [],
	containments: []
}

/**
 * The catalog rewrites over the lab, in a snapshot read under its own catalog, the parent-set policy decided per take.
 */
export const labOptions: CatalogOptions = { catalog: genCatalog(lab), parents: "auto" }

const i = (value: number): TypedLiteral => ({ kind: "int", value: BigInt(value) })
const d = (value: number): TypedLiteral => ({ kind: "float", value: canonicalZero(value) })

/**
 * Sittings: student 1 has ties on the day broken by id; student 2 one sitting; student 3 ties on the score; student 4
 * an earlier day than every price; student 5 no price at all. Scores are dyadic, so every sum is exact.
 */
const sittings = (rows: ReadonlyArray<readonly [number, number, number, number]>) =>
	Arr.map(rows, ([id, student, day, score]) => [i(id), i(student), i(day), d(score)])

const defaultSittings: ReadonlyArray<readonly [number, number, number, number]> = [
	[1, 1, 10, 3.5],
	[2, 1, 10, 1.25],
	[3, 1, 12, 7],
	[4, 1, 15, 3.5],
	[5, 1, 15, 0.5],
	[6, 2, 11, 9],
	[7, 3, 20, 4],
	[8, 3, 21, 4],
	[9, 3, 22, 4],
	[10, 3, 23, 2],
	[11, 4, 1, 6],
	[12, 4, 3, 6.5],
	[13, 5, 30, 1]
]

/**
 * Prices: student 1 at days 9, 10 (twice, a tie at the prefix), 13 and 16; student 3 at 21 and 25; student 4 only after
 * its sittings; student 5 none.
 */
const defaultPrices: ReadonlyArray<readonly [number, number, number, number]> = [
	[101, 1, 9, 90],
	[102, 1, 10, 100],
	[103, 1, 10, 105],
	[104, 1, 13, 130],
	[105, 1, 16, 160],
	[106, 3, 21, 210],
	[107, 3, 25, 250],
	[108, 4, 5, 50],
	[109, 2, 11, 110]
]

/**
 * The lab's facts: sittings (id, student, day, score), prices (id, student, day, amount) and points (id, grp, x, y).
 */
export interface Facts {
	readonly sittings: ReadonlyArray<readonly [number, number, number, number]>
	readonly prices: ReadonlyArray<readonly [number, number, number, number]>
	readonly points: ReadonlyArray<readonly [number, number, number, number]>
}

/** The lab's planted facts above, no point. */
export const labFacts: Facts = { sittings: defaultSittings, prices: defaultPrices, points: [] }

const facts = (f: Facts) => ({
	Sitting: sittings(f.sittings),
	Price: Arr.map(f.prices, ([id, student, day, amount]) => [i(id), i(student), i(day), i(amount)]),
	Point: Arr.map(f.points, ([id, grp, x, y]) => [i(id), i(grp), d(x), d(y)])
})

/**
 * A relation's drawn rows over small domains, so ties on a group's day and score, groups of one row and groups of none
 * come up: up to `max` rows, ids distinct, the other fields from the domains given. A fifth of draws plant the empty
 * relation.
 */
const rowsOf = (
	max: number,
	group: Gen<number>,
	day: Gen<number>,
	value: Gen<number>
): Gen<ReadonlyArray<readonly [number, number, number, number]>> =>
	weighted<ReadonlyArray<readonly [number, number, number, number]>>([
		[1, constant([])],
		[
			4,
			map(
				array((source) => [source.draw(group), source.draw(day), source.draw(value)] as const, {
					min: 1,
					max
				}),
				(rows) => Arr.map(rows, ([g, x, y], k) => [k + 1, g, x, y] as const)
			)
		]
	])

/**
 * Drawn lab facts: five students, days 1 to 12, small domains of dyadic scores and integer amounts, so ties come up;
 * points over five groups with dyadic coordinates, many sharing an x, the score a match reads them at.
 */
export const factsGen: Gen<Facts> = (source) => ({
	sittings: source.draw(
		rowsOf(
			14,
			int(1, 5),
			int(1, 12),
			map(int(-8, 40), (q) => q / 4)
		)
	),
	prices: source.draw(rowsOf(10, int(1, 5), int(1, 12), int(0, 300))),
	points: source.draw(
		rowsOf(
			12,
			int(0, 4),
			map(int(-4, 4), (q) => q / 2),
			map(int(-16, 16), (q) => q / 4)
		)
	)
})

export const checkedQuery = (desc: QueryDesc): LogicalQuery => {
	const r = checkAuthored(checking(schemaDesc(lab)), desc, checkOptions("query"))
	if (!r.ok) {
		throw new Error(`the query does not check: ${r.error.message}`)
	}
	return r.value
}

export const oracleCase = (label: string, desc: QueryDesc, f: Facts): LabelledCase => {
	const q = checkedQuery(desc)
	return {
		label,
		schema: lab,
		facts: canonicalFacts(facts(f)),
		query: { dag: q.dag, params: {} },
		spelling: { mode: "drawn", edge: false }
	}
}

/**
 * The compile-target catalog's agreement harness.
 *
 * Every case is a query over the Lab fixture written as an author writes the composition and checked by the real
 * checker, so the recognizers meet the IR the frontend produces. The oracle runner (test/support/oracle/runner.ts)
 * installs the fixture in a rolled-back transaction, runs the composed lowering (the conservative lowering of the
 * checked DAG) and the catalog's lowering (the rewritten DAG, its Window and OrderedSetAggregate nodes lowered to their
 * native targets by native.ts), and compares the raw text sets statement by statement. The catalog side also
 * returns the certificates, so each case asserts that its entry was actually applied: an agreement that never exercised
 * the target would prove nothing.
 *
 * The catalog's lowering of a case, keeping the rewrite's certificates and decisions for the case to inspect: `last` is
 * the latest rewrite's result, after the lowering ran.
 */
export const catalogLowering = (
	options: CatalogOptions
): Lowering & { readonly last: () => CatalogResult } => {
	const results: Array<CatalogResult> = []
	return {
		name: "catalog",
		last: () => defined(results.at(-1), "a catalog rewrite ran"),
		lower: ({ case: c, names }) =>
			Result.flatMap(
				rewriteCatalog(c.query.dag, options),
				(rewritten): Result.Result<SentProgram, CompileError> => {
					results.push(rewritten)
					return Result.flatMap(
						catchRefusal(() =>
							new ConservativeDelivery(
								new LowerContext(
									rewritten.dag,
									{
										names,
										params: genParamDecls(c.query),
										subject: { kind: "query" }
									},
									catalogDispatch
								)
							).program(c.query.dag.roots[0])
						),
						sentConservative
					)
				}
			)
	}
}

/** The rules a rewrite applied. */
export const appliedRules = (result: CatalogResult): ReadonlyArray<CertificateRule> =>
	Arr.sort(
		[...new Set(Arr.map(result.certificates, (cert: Certificate) => cert.rule))],
		Order.String
	)
