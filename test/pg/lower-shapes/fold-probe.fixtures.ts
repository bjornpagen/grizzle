/** What fold-probe.test.ts reads: the schema, its template, the space, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { type PlanNode, planNodes, scannedRows } from "#bench/harness/explain.ts"
import { identity } from "#compiler/core/identity.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, relation, schema } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, declaredOf, paramTexts, testCompile } from "#test/support/compile.ts"
import { type Installed } from "#test/support/install-migrate.ts"
import { fullWorldTemplate } from "#test/support/installed.ts"
import { planAsRun } from "#test/support/judge.ts"
import { namesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import type { PgConnection } from "#test/support/pg.ts"

/**
 * edullm's learning-commons crosswalk, as its Knowledge Graph stores it: which learning components support which
 * standard, and the pairs of a state standard and a hub standard that share components, with how many they share.
 */
const Supports = relation("Supports", { component: pg.integer, item: pg.integer }, [
	"component",
	"item"
])

const Pair = relation("Pair", { state: pg.integer, hub: pg.integer, shared: pg.integer }, [
	"state",
	"hub"
])

const Stored = schema("FoldProbe", [Supports, Pair], [])

/** How many components support each standard some component supports: a fold of Supports by its item. */
const SupportCount = derived(
	"SupportCount",
	query(Stored).rule((r) => {
		const { component, item } = v(Supports, "supports")
		return r.match(Supports, { component, item }).find({ standard: item, supports: r.count() })
	})
)

const Views = schema.extend([Stored], "FoldProbe_1", [SupportCount], [])

/** The order a read matches its relations in. */
type MatchOrder = "pair first" | "counts first"

/**
 * A standard's crosswalk, whichever end of it the standard is: each pair, with how many components support each end,
 * the two counts the fold's occurrences joined by the pair's ends, as learning-commons' reader reads them; the pair
 * matched first, as the reader matches it, or after the counts, whose keys only the pair binds.
 */
const crosswalkOf = (order: MatchOrder) =>
	query(Views).rule((r) => {
		const { state, hub, shared } = v(Pair, "pair")
		const stateCount = v(SupportCount, "stateCount")
		const hubCount = v(SupportCount, "hubCount")
		const standard = r.param("standard", pg.integer)
		const matched =
			order === "pair first"
				? r
						.match(Pair, { state, hub, shared })
						.match(SupportCount, { standard: state, supports: stateCount.supports })
						.match(SupportCount, { standard: hub, supports: hubCount.supports })
				: r
						.match(SupportCount, { standard: state, supports: stateCount.supports })
						.match(SupportCount, { standard: hub, supports: hubCount.supports })
						.match(Pair, { state, hub, shared })
		return matched.where(r.or([r.eq(state, standard), r.eq(hub, standard)])).find({
			state,
			hub,
			shared,
			stateSupports: stateCount.supports,
			hubSupports: hubCount.supports
		})
	})

const crosswalk = crosswalkOf("pair first")
const countsFirst = crosswalkOf("counts first")

/** The schema installed through its first migration, with a reader login whose workload's indexes the read earns. */
export const foldProbeTemplate = fullWorldTemplate({
	declaredIn: import.meta,
	name: "fold probe",
	fixture: Views,
	programs: { crosswalk, countsFirst },
	label: "fold_probe",
	ambient: ordinarySession
})

/**
 * A case: how many standards there are, the most components that support one (standard i has 1 + i mod `most`), how
 * many state standards there are, each paired with `hubs` hubs among the standards after them, the standard the read
 * asks for, a state or a hub, the order the read matches its relations in, and whether the tables are analyzed before
 * the read, as autovacuum would.
 */
export interface FoldProbe {
	readonly standards: number
	readonly most: number
	readonly states: number
	readonly hubs: number
	readonly asked: "a state" | "a hub"
	readonly order: MatchOrder
	readonly at: number
	readonly statistics: "none" | "analyzed"
}

export const foldProbeGen: Gen<FoldProbe> = (s) => {
	const states = s.draw(int(200, 400))
	return {
		standards: s.draw(int(3000, 5000)),
		most: s.draw(int(4, 16)),
		states,
		hubs: s.draw(int(3, 12)),
		asked: s.draw(element(["a state", "a hub"] as const)),
		order: s.draw(element(["pair first", "counts first"] as const)),
		at: s.draw(int(1, states)),
		statistics: s.draw(element(["none", "analyzed"] as const))
	}
}

export type FoldProbeFeature = "a state asked" | "a hub asked" | "the counts matched first"

/** How many components support standard `i`. */
const supportsOf = (c: FoldProbe, i: number): number => 1 + (i % c.most)

/** The hubs state `s` is paired with: `hubs` standards past the states, the k-th at states + 1 + (7s + k) mod 100. */
const hubsOf = (c: FoldProbe, s: number): ReadonlyArray<number> =>
	Array.from({ length: c.hubs }, (_, i) => c.states + 1 + ((7 * s + i + 1) % 100))

/** The standard the case asks for: state `at`, or the first hub state `at` is paired with. */
const askedOf = (c: FoldProbe): number =>
	c.asked === "a state" ? c.at : (hubsOf(c, c.at)[0] ?? c.at)

/** A pair the read delivers: its ends, how many components they share, and how many support each end. */
interface Delivered {
	readonly state: number
	readonly hub: number
	readonly shared: number
	readonly stateSupports: number
	readonly hubSupports: number
}

/** The read's rows on the host. */
const expected = (c: FoldProbe): ReadonlyArray<Delivered> => {
	const asked = askedOf(c)
	return Arr.flatMap(
		Array.from({ length: c.states }, (_, i) => i + 1),
		(s) =>
			Arr.flatMap(hubsOf(c, s), (h, k) =>
				s === asked || h === asked
					? [
							{
								state: s,
								hub: h,
								shared: k + 1,
								stateSupports: supportsOf(c, s),
								hubSupports: supportsOf(c, h)
							}
						]
					: []
			)
	)
}

/** A delivered pair as text, `state hub shared stateSupports hubSupports`. */
const textOf = (d: Delivered): string =>
	`${d.state} ${d.hub} ${d.shared} ${d.stateSupports} ${d.hubSupports}`

/** The statements storing the case's rows by ordinary writes, then ANALYZE where the case draws it. */
const loaded = (installed: Installed, c: FoldProbe): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const supports = names.table(Supports)
	const pair = names.table(Pair)
	return [
		`INSERT INTO ${supports} SELECT k, i FROM generate_series(1, ${c.standards}) AS g(i), generate_series(1, 1 + i % ${c.most}) AS h(k)`,
		`INSERT INTO ${pair} SELECT s, ${c.states} + 1 + (7 * s + k) % 100, k FROM generate_series(1, ${c.states}) AS g(s), generate_series(1, ${c.hubs}) AS h(k)`,
		...(c.statistics === "analyzed" ? Arr.map([supports, pair], (t) => `ANALYZE ${t}`) : [])
	]
}

/**
 * The rows a plan's scans of `table` read over every loop, each scan's output and what its filters removed, and the
 * most the sum may exceed the rows read by: PostgreSQL 19 states a scan's rows a loop rounded to two places
 * (scannedRows), so each loop's rows may read up to half a hundredth over.
 */
const readOf = (plan: PlanNode, table: string): { readonly rows: number; readonly slack: number } =>
	Arr.reduce(
		Arr.filter(
			Arr.fromIterable(planNodes(plan)),
			(n) => Option.contains(n.relation, table) && n.nodeType !== "Bitmap Index Scan"
		),
		{ rows: 0, slack: 0 },
		(sum, n) => ({ rows: sum.rows + scannedRows(n), slack: sum.slack + n.actualLoops / 200 })
	)

/** A row the read delivers, its fields as text in heading order: `hub hubSupports shared state stateSupports`. */
const rowOf = (row: ReadonlyArray<unknown>): string => {
	const [hub, hubSupports, shared, state, stateSupports] = Arr.map(row, (x) =>
		typeof x === "string" ? x : String(x)
	)
	return `${state} ${hub} ${shared} ${stateSupports} ${hubSupports}`
}

/**
 * One case in its one transaction, which the case's end rolls back: the standards' supports and the pairs stored, then
 * the read of one standard's crosswalk explained as it runs, and run. It answers the host's pairs with each end's count,
 * and its scans of Supports read, over every loop, at most the supports of each delivered pair's two ends: each count
 * is the fold of its own standard's supports, read through the index on the standard, never every standard's.
 */
export const runFoldProbe = (
	installed: Installed,
	connection: PgConnection,
	c: FoldProbe,
	k: Case<FoldProbeFeature>
) =>
	Effect.gen(function* () {
		for (const sql of loaded(installed, c)) {
			yield* connection.query(sql, [])
		}
		const options = {
			...testCompile,
			installation: identity.schema(parsedSchemaName(installed.declared))
		}
		const read = c.order === "pair first" ? crosswalk : countsFirst
		const template = succeeded(compileTemplate(read, undefined, options), "the read compiles")
		const [statement, ...others] = template.optimized
		assert.ok(statement !== undefined && others.length === 0, "the read is one statement")
		const params = paramTexts(
			statement,
			{ standard: askedOf(c) },
			declaredOf(template, read, undefined, options)
		)
		const plan = yield* planAsRun(connection.queryValues, statement.sql, params)
		const rows = yield* connection.queryValues(statement.sql, params)
		const want = expected(c)
		assert.deepEqual(
			Arr.sort(Arr.map(rows, rowOf), Order.String),
			Arr.sort(Arr.map(want, textOf), Order.String),
			`${Formatter.format(c)}: the crosswalk of ${askedOf(c)}`
		)
		const bound = Arr.reduce(want, 0, (sum, d) => sum + d.stateSupports + d.hubSupports)
		const scanned = readOf(plan, namesOf(installed).tableIdent(Supports))
		assert.ok(
			scanned.rows <= bound + scanned.slack,
			`${Formatter.format(c)}: the read's scans of Supports read ${scanned.rows} rows, at most the ${bound} supports of its ${want.length} pairs' ends, of the ${Arr.reduce(
				Array.from({ length: c.standards }, (_, i) => i + 1),
				0,
				(sum, i) => sum + supportsOf(c, i)
			)} stored`
		)
		k.note(c.asked === "a state" ? "a state asked" : "a hub asked")
		if (c.order === "counts first") {
			k.note("the counts matched first")
		}
	})
