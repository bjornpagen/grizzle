/** What existence-witness.test.ts reads: the schema, its template, the space, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { type PlanNode, parsePlan, planNodes, scannedRows } from "#bench/harness/explain.ts"
import { identity } from "#compiler/core/identity.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { natural, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { namesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"

/** The left side's rows, a few keys and a count each. */
const Asked = relation("Asked", { k1: pg.integer, k2: pg.integer, v: natural }, ["k1", "k2"])

/** A large store of facts by key, several at each key. */
const Held = relation("Held", { k1: pg.integer, k2: pg.integer, x: pg.integer }, ["k1", "k2", "x"])

/** A second store, joined to the first by the key. */
const Marked = relation("Marked", { k1: pg.integer, k2: pg.integer, y: pg.integer }, [
	"k1",
	"k2",
	"y"
])

const Stored = schema("ExistenceWitness", [Asked, Held, Marked], [])

/** The facts of Held at a key Marked holds too: a right side of two sources. */
const joined = query(Stored).rule((r) => {
	const { k1, k2, x } = v(Held, "held")
	const { y } = v(Marked, "marked")
	return r.match(Held, { k1, k2, x }).match(Marked, { k1, k2, y }).find({ k1, k2 })
})

/** How many facts Held holds at each key: a fold by the key. */
const folded = query(Stored).rule((r) => {
	const { k1, k2, x } = v(Held, "held")
	return r.match(Held, { k1, k2, x }).find({ k1, k2, n: r.count() })
})

/** What a case negates: the join by the key, the fold by the key, or the fold by its count. */
export type Shape = "the join by the key" | "the fold by the key" | "the fold by its count"

/** The asked keys no fact of the shape's right side matches. */
const negated = (shape: Shape) =>
	query(Stored).rule((r) => {
		const { k1, k2, v: count } = v(Asked, "asked")
		const asked = r.match(Asked, { k1, k2, v: count })
		switch (shape) {
			case "the join by the key":
				return asked.where(r.not(joined, { k1, k2 })).find({ k1, k2 })
			case "the fold by the key":
				return asked.where(r.not(folded, { k1, k2 })).find({ k1, k2 })
			case "the fold by its count":
				return asked.where(r.not(folded, { k1, n: count })).find({ k1, k2 })
		}
	})

/** The schema installed through its first migration. */
export const existenceWitnessTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "existence witness",
	content: { schema: Stored.name, logins: [] },
	versions: [{ schema: Stored, declarations: noDeclarations }],
	options: {
		label: "existence_witness",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/**
 * A case: the shape negated, how many keys the store holds (key i is (i, i mod 7)), how many facts Held holds at each
 * and how many keys are asked, every third at a key Marked holds, and whether the tables are analyzed, as autovacuum
 * would.
 */
export interface Witness {
	readonly shape: Shape
	readonly keys: number
	readonly each: number
	readonly asked: number
	readonly statistics: "none" | "analyzed"
}

export const witnessGen: Gen<Witness> = (s) => ({
	shape: s.draw(
		element(["the join by the key", "the fold by the key", "the fold by its count"] as const)
	),
	keys: s.draw(int(2000, 4000)),
	each: s.draw(int(1, 4)),
	asked: s.draw(int(2, 6)),
	statistics: s.draw(element(["none", "analyzed"] as const))
})

export type WitnessFeature = Shape | "statistics read"

/** The asked keys: i * 97 mod keys for i < asked, a key of the store each. */
const askedKeys = (c: Witness): ReadonlyArray<number> =>
	Array.from({ length: c.asked }, (_, i) => 1 + ((i * 97) % c.keys))

/** Whether Marked holds key i: every third key. */
const marked = (i: number): boolean => i % 3 === 0

/** The count of the asked key at place `at`, its v: the facts Held holds at each key, or one more for every other asked key. */
const countOf = (c: Witness, at: number): number => c.each + (at % 2)

/** The keys the read delivers, as `k1 k2`, from the shape's rule on the host. */
const expected = (c: Witness): ReadonlyArray<string> =>
	Arr.flatMap(askedKeys(c), (i, at) => {
		const kept =
			c.shape === "the join by the key"
				? !marked(i)
				: c.shape === "the fold by the key"
					? false
					: countOf(c, at) !== c.each
		return kept ? [`${i} ${i % 7}`] : []
	})

/** The statements storing the case's rows by ordinary writes, then ANALYZE where the case draws it. */
const loaded = (installed: Installed, c: Witness): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const asked = names.table(Asked)
	const held = names.table(Held)
	const markedTable = names.table(Marked)
	const tables = [asked, held, markedTable]
	return [
		`INSERT INTO ${held} SELECT i, i % 7, x FROM generate_series(1, ${c.keys}) AS g(i), generate_series(1, ${c.each}) AS h(x)`,
		`INSERT INTO ${markedTable} SELECT i, i % 7, 1 FROM generate_series(3, ${c.keys}, 3) AS g(i)`,
		...Arr.map(
			askedKeys(c),
			(i, at) => `INSERT INTO ${asked} VALUES (${i}, ${i % 7}, ${countOf(c, at)})`
		),
		...(c.statistics === "analyzed" ? Arr.map(tables, (t) => `ANALYZE ${t}`) : [])
	]
}

/** The rows a plan's scans of `table` read over every loop, and the most PostgreSQL's rounding may add to the sum. */
const readOf = (plan: PlanNode, table: string): { readonly rows: number; readonly slack: number } =>
	Arr.reduce(
		Arr.filter(
			Arr.fromIterable(planNodes(plan)),
			(n) => Option.contains(n.relation, table) && n.nodeType !== "Bitmap Index Scan"
		),
		{ rows: 0, slack: 0 },
		(sum, n) => ({ rows: sum.rows + scannedRows(n), slack: sum.slack + n.actualLoops / 200 })
	)

/**
 * The most rows the read's scans of Held may read: for a right side read per left row, the facts at each asked key,
 * and one more for the witness's index probe of a key it does not hold; for the fold by its count, whose count stops
 * every key's restriction, the whole fold, once.
 */
const boundOf = (c: Witness): number =>
	c.shape === "the fold by its count" ? c.keys * c.each : c.asked * (c.each + 1)

/** A row the read delivers as `k1 k2`. */
const rowOf = (row: ReadonlyArray<unknown>): string =>
	Arr.join(
		Arr.map(row, (x) => (typeof x === "string" ? x : String(x))),
		" "
	)

/**
 * One case in its one transaction, which the case's end rolls back: the store and the asked keys stored, then the
 * conservative read of the asked keys the shape's right side does not match explained as it runs, and run. It answers the
 * host's keys, and its scans of Held read at most the facts at the asked keys where the right side is read per left
 * row, however many keys the store holds, and the whole fold once, never once per asked key, where a count is bound.
 */
export const runWitness = (
	installed: Installed,
	connection: PgConnection,
	c: Witness,
	k: Case<WitnessFeature>
) =>
	Effect.gen(function* () {
		for (const sql of loaded(installed, c)) {
			yield* connection.query(sql, [])
		}
		const options = {
			...testCompile,
			installation: identity.schema(parsedSchemaName(installed.declared))
		}
		const template = succeeded(
			compileTemplate(negated(c.shape), undefined, options),
			"the read compiles"
		)
		const [statement, ...others] = template.conservative
		assert.ok(statement !== undefined && others.length === 0, "the read is one statement")
		const explained = yield* connection.queryValues(
			`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SETTINGS, FORMAT JSON) ${statement.sql}`,
			[]
		)
		const plan = succeeded(parsePlan(explained[0]?.[0]), "one EXPLAIN plan").plan
		const rows = yield* connection.queryValues(statement.sql, [])
		assert.deepEqual(
			Arr.sort(Arr.map(rows, rowOf), Order.String),
			Arr.sort(expected(c), Order.String),
			`${Formatter.format(c)}: the asked keys the right side does not match`
		)
		const bound = boundOf(c)
		const scanned = readOf(plan, namesOf(installed).tableIdent(Held))
		assert.ok(
			scanned.rows <= bound + scanned.slack,
			`${Formatter.format(c)}: the read's scans of Held read ${scanned.rows} rows, at most ${bound}, of the ${c.keys * c.each} stored\n${statement.sql}`
		)
		k.note(c.shape)
		if (c.statistics === "analyzed") {
			k.note("statistics read")
		}
	})
