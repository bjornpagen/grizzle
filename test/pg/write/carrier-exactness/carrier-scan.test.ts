/**
 * A carrier read per row of another relation is one function scan, on PostgreSQL 19: a right side read once per left
 * row, a correlated sub-query over a carrier, plans the carrier as a Function Scan of its arrays' unnest calls
 * (sql/print.ts printSettingRows), which reads its calls' rows into a tuplestore once and answers every rescan from it
 * while no parameter of its calls changes (nodeFunctionscan.c), and a carrier's calls read no row's value; so no
 * rescan parses the carrier's text again, where a select list's unnest under a ProjectSet is evaluated anew at each.
 *
 * The box, exhausted: a carrier of 1, 64 or 4096 integers filled as a write fills one (carrierStash) and a table of 64
 * or 4096 keys, read by `SELECT t.k, (SELECT count(*) FROM <carrier> AS r WHERE r.c2 = t.k) FROM t`, the carrier the
 * per-row right side of a SubPlan. Property, per case: EXPLAIN of the read holds, under its SubPlan, a Function Scan of
 * unnest and no ProjectSet. Oracle: PostgreSQL's plan. Kill: the carrier read as a select list's bare unnest.
 */
import { assert } from "@bjornpagen/testing/assert"
import { element, finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Result } from "effect"
import { type EstimatedNode, parsePlanTree } from "#bench/harness/explain.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { col, provedSelect, target } from "#compiler/sql/build.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { carrierRead } from "#compiler/write/carriers/carriers.ts"
import {
	carriedOf,
	carrierOf,
	loginLike,
	parameterOf,
	statementsOf
} from "#test/pg/write/carrier-exactness/carrier-exactness.fixtures.ts"
import { succeeded } from "#test/support/assert.ts"
import { baseSubstrate, Substrate } from "#test/support/substrate/substrate.ts"

/** The nodes of `node`'s plan a SubPlan of it runs, each with every node under it. */
const underSubPlans = (node: EstimatedNode, inside: boolean): ReadonlyArray<EstimatedNode> => {
	const here = inside || Option.getOrUndefined(node.parentRelationship) === "SubPlan"
	return [...(here ? [node] : []), ...Arr.flatMap(node.children, (c) => underSubPlans(c, here))]
}

/** A carrier read per row of another relation is one function scan, its rows read once and every rescan from them. */
export const aCarrierReadPerRowOfAnotherRelationIsOneFunctionScan = property.exhaust(
	finite((source) => ({
		carried: source.draw(element([1, 64, 4096] as const)),
		keys: source.draw(element([64, 4096] as const))
	})),
	{
		needs: { tx: Substrate.rolledBack(baseSubstrate) },
		situations: [],
		check:
			({ tx }) =>
			(c) =>
				Effect.gen(function* () {
					const { session, schema } = yield* tx
					const int4 = carriedOf("int4")
					const { names, wire, schema: own } = yield* loginLike(session, schema)
					const carrier = carrierOf(names, int4.type)
					const { create, load, fill } = statementsOf(carrier, int4.type, wire, own)
					yield* session.values(create, [])
					yield* session.values(
						load,
						parameterOf(
							int4.type,
							Array.from({ length: c.carried }, (_, i) => i + 1)
						)
					)
					yield* session.values(fill, [])
					const table = `${quoteIdent(own)}."t"`
					yield* session.values(`CREATE TABLE ${table} (k int4 PRIMARY KEY)`, [])
					yield* session.values(
						`INSERT INTO ${table} SELECT g FROM pg_catalog.generate_series(1, ${c.keys}) AS g`,
						[]
					)
					yield* session.values(`ANALYZE ${table}`, [])
					const values = printStatement(
						provedSelect("keyed", [target(col("r", "c2"))], [carrierRead(carrier, "r")], undefined)
					)
					const rows = yield* session.values(
						`EXPLAIN (FORMAT JSON) SELECT t.k, (SELECT pg_catalog.count(*) FROM (${values}) AS q WHERE q."c2" = t.k) FROM ${table} AS t`,
						[]
					)
					const plan = succeeded(Result.mapError(parsePlanTree(rows[0]?.[0]), (f) => f.message))
					const perRow = underSubPlans(plan, false)
					assert.ok(
						Arr.some(perRow, (n) => n.nodeType === "Function Scan"),
						"the per-row right side reads the carrier by a Function Scan of unnest"
					)
					assert.ok(
						!Arr.some(perRow, (n) => n.nodeType === "ProjectSet"),
						"no ProjectSet under the SubPlan evaluates the carrier again at each rescan"
					)
				}),
		oracle: {
			kind: "postgresql",
			name: "EXPLAIN of the per-row read: a Function Scan of unnest under its SubPlan, no ProjectSet"
		},
		box: "a carrier of 1, 64 or 4096 integers read per row of a table of 64 or 4096 keys",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: '\t\tcase "setting":\n\t\t\treturn printSettingRows(source.columns, alias)\n',
				replacement:
					'\t\tcase "setting":\n\t\t\treturn "(SELECT " + source.columns.map(printCarriedColumn).join(", ") + ") AS " + quoteIdent(alias)\n',
				why: "A carrier read as a select list's bare unnest: the SubPlan's ProjectSet parses the carrier's text again for every row of t."
			}
		]
	}
)
