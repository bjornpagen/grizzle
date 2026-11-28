/** What probe-share.test.ts reads: the schema, its template, the space, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { planNodes } from "#bench/harness/explain.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, derived, relation, schema } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import {
	judgedPlans,
	judgedStatementsOf,
	readWork,
	scannedTableOf,
	scannedWork,
	standUpJudge
} from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"

/** A seat of a unit, at its place `k`, sitting a test: the relation a write inserts into, whose probe the case reads. */
const Seat = relation("Seat", { unit: int4, k: int4, test: int4 }, ["unit", "k"])

/** The document each test delivers, as metis's TestContent binds a test to its QTI package and path. */
const Content = relation("Content", { test: int4, doc: int4 }, ["test"])

/** A document's timed scopes, and its paced ones: the content a union of two rules reads, as QTI's timing scopes. */
const Timed = relation("Timed", { doc: int4, scope: int4 }, ["doc", "scope"])
const Paced = relation("Paced", { doc: int4, scope: int4 }, ["doc", "scope"])

/** A seat's budget left, at its unit and place. */
const Budget = relation("Budget", { unit: int4, k: int4, remaining: int4 }, ["unit", "k"])

const Base = schema("ProbeShare", [Seat, Content, Timed, Paced, Budget], [])

/** Every document's scopes, timed or paced: a union of two rules over content alone, metis's TimingScope. */
const scopes = query(Base)
	.rule((r) => {
		const { doc, scope } = v(Timed, "timed")
		return r.match(Timed, { doc, scope }).find({ doc, scope })
	})
	.rule((r) => {
		const { doc, scope } = v(Paced, "paced")
		return r.match(Paced, { doc, scope }).find({ doc, scope })
	})

/**
 * Each seat's scopes beside its budget, by two rules, each reading `scopes` at the document its seat's test delivers, a
 * field a step binds: the seat's budget left, or, where none is stated, its scope itself, as metis's FirstBudget reads
 * timeLimits in each of its rules.
 */
const Limited = derived(
	"Limited",
	query(Base)
		.rule((r) => {
			const { unit, k, test } = v(Seat, "budgeted")
			const { doc } = v(Content, "budgetedContent")
			const { scope } = v(scopes, "budgetedScope")
			const { remaining } = v(Budget, "budget")
			return r
				.match(Seat, { unit, k, test })
				.match(Content, { test, doc })
				.match(scopes, { doc, scope })
				.match(Budget, { unit, k, remaining })
				.find({ unit, k, scope, remaining })
		})
		.rule((r) => {
			const { unit, k, test } = v(Seat, "open")
			const { doc } = v(Content, "openContent")
			const { scope } = v(scopes, "openScope")
			return r
				.match(Seat, { unit, k, test })
				.match(Content, { test, doc })
				.match(scopes, { doc, scope })
				.where(r.not(Budget, { unit, k }))
				.find({ unit, k, scope, remaining: scope })
		})
)

const Checked = schema.extend(
	[Base],
	"ProbeShare_1",
	[Limited],
	[check("Scoped", Limited, (l) => l.le(l.scope, l.remaining))]
)

/** The schema installed through its first migration, its tables empty. */
export const probeShareTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "probe share",
	content: { schema: Checked.name, logins: [] },
	versions: [{ schema: Checked, declarations: noDeclarations }],
	options: {
		label: "probe_share",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/**
 * The documents of one share of the population, each with its test, two timed and two paced scopes, and a seat, on
 * relations of the case's own (the rolled-back seat's fresh relations, substrate.ts): a heap page of Content's rows, so
 * each share the population grows by adds a page to every table the probe looks up by key, and a read of a table whole
 * reads more over the growth, where a probe of a written seat's keys reads its own.
 *
 * @limitKind derived
 * @owner PostgreSQL 19's heap page layout (bufpage.h PageHeaderData, htup_details.h HeapTupleHeaderData)
 * @unit documents
 * @scope each share of one case's population
 * @derivation Content's row is two int4 columns: a 24-byte tuple header, MAXALIGNed, 8 bytes of data and a 4-byte line
 *   pointer, 36 bytes, so an 8,192-byte page less its 24-byte header holds floor(8,168 / 36) = 226 rows, one a document.
 */
const share = 226

/** How many shares the population grows to, from one. */
const growths = [2, 4, 8, 16] as const

/** The documents a written seat's test delivers, each of the first share. */
const written = [0, 1, 31, 63] as const

export interface ProbeShareCase {
	readonly growth: (typeof growths)[number]
	readonly doc: (typeof written)[number]
}

/** The box: every growth, a seat written at each of four documents. */
export const probeShareGen: Gen<ProbeShareCase> = (s) => ({
	growth: s.draw(element(growths)),
	doc: s.draw(element(written))
})

export type ProbeShareFeature = "a union read by two rules" | "the population grown sixteen times"

export const probeShareFeatures: readonly [ProbeShareFeature, ...Array<ProbeShareFeature>] = [
	"a union read by two rules",
	"the population grown sixteen times"
]

/**
 * The population's documents `from` to `to`, exclusive, as INSERTs over generate_series's i: test i delivering document
 * i, its scopes 1 and 2 timed and 3 and 4 paced, and a seat of unit i at place 0 sitting test i with 1,000 left.
 */
const population = (installed: Installed, from: number, to: number): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const into = (r: Parameters<typeof names.table>[0], fields: ReadonlyArray<string>): string =>
		`INSERT INTO ${names.table(r)} (${Arr.join(
			Arr.map(fields, (f) => quoteIdent(names.columnIdent(r, f))),
			", "
		)})`
	const series = `FROM pg_catalog.generate_series(${from}, ${to - 1}) AS g(i)`
	return [
		`${into(Content, ["test", "doc"])} SELECT i, i ${series}`,
		`${into(Timed, ["doc", "scope"])} SELECT i, s ${series}, (VALUES (1), (2)) AS t(s)`,
		`${into(Paced, ["doc", "scope"])} SELECT i, s ${series}, (VALUES (3), (4)) AS t(s)`,
		`${into(Seat, ["unit", "k", "test"])} SELECT i, 0, i ${series}`,
		`${into(Budget, ["unit", "k", "remaining"])} SELECT i, 0, 1000 ${series}`
	]
}

/** A seat of a unit no other row names, at place 0, sitting the test of document `doc`: the write the case probes. */
const seatAt = (installed: Installed, unit: number, doc: number): string => {
	const names = namesOf(installed)
	return `INSERT INTO ${names.table(Seat)} (${Arr.join(
		Arr.map(["unit", "k", "test"], (f) => quoteIdent(names.columnIdent(Seat, f))),
		", "
	)}) VALUES (${unit}, 0, ${doc})`
}

/**
 * The rows each table's scans read over the judge's statements that read the session's delta, explained with ANALYZE as
 * the judge would run them, each under its routine's advice (judge.ts judgedPlans): by the table each scan names, the
 * rows it returned and its filters removed over all of its loops (judge.ts scannedWork).
 */
const rowsReadByTable = (installed: Installed, connection: PgConnection) =>
	Effect.gen(function* () {
		const plans = yield* judgedPlans(
			(sql) => connection.queryValues(sql, []),
			installed.installation,
			judgedStatementsOf(installed.installation)
		)
		const out: Record<string, number> = {}
		for (const { plan } of plans) {
			for (const n of planNodes(plan)) {
				const table = scannedTableOf(n)
				const read = scannedWork(n)
				if (Option.isSome(table) && read > 0) {
					out[table.value] = (out[table.value] ?? 0) + read
				}
			}
		}
		return out
	})

/**
 * The work of the judge's statements over a load of the population written at once, explained with ANALYZE as the
 * judge would run them while the deltas hold the load (judge.ts judgedPlans): every row their scans of stored
 * relations read and their reads of the deltas yield, and every row each scan of a CTE reads, over all of its loops
 * (judge.ts readWork), where a set the statement computes once and joins inside a probe evaluated per written row
 * is scanned whole at each.
 */
const loadWork = (installed: Installed, connection: PgConnection) =>
	Effect.map(
		judgedPlans(
			(sql) => connection.queryValues(sql, []),
			installed.installation,
			judgedStatementsOf(installed.installation)
		),
		(plans) => Arr.reduce(plans, 0, (sum, { plan }) => sum + readWork(plan))
	)

/** The judge run over what the transaction wrote since it last ran, then deferred again: it must accept. */
const judged = (connection: PgConnection) =>
	Effect.gen(function* () {
		yield* connection.query("SET CONSTRAINTS ALL IMMEDIATE", [])
		yield* connection.query("SET CONSTRAINTS ALL DEFERRED", [])
	})

/**
 * One case in its one transaction, which the case's end rolls back: one share of the population written, the judge's
 * statements explained over it, and judged; a seat at the case's document written and the statements explained over
 * it; the judge run; the population grown to the case's shares, the statements explained over the growth, and judged;
 * a second seat at the same document written and the statements explained again. Each table's rows read over the
 * second seat equal those over the first: the probe reads the rows its write's keys reach, whatever the population. And
 * the judge's work over the growth, its shares but the first written at once, is at most their count times its work
 * over the first share: each written row's probe reads the rows its keys reach, whatever else the transaction wrote.
 */
export const runProbeShare = (
	installed: Installed,
	connection: PgConnection,
	drawn: ProbeShareCase,
	c: Case<ProbeShareFeature>
) =>
	Effect.gen(function* () {
		c.note("a union read by two rules")
		if (drawn.growth === 16) {
			c.note("the population grown sixteen times")
		}
		yield* standUpJudge(connection, installed.installation)
		yield* connection.query("SET CONSTRAINTS ALL DEFERRED", [])
		for (const sql of population(installed, 0, share)) {
			yield* connection.query(sql, [])
		}
		const first = yield* loadWork(installed, connection)
		yield* judged(connection)
		yield* connection.query(seatAt(installed, -1, drawn.doc), [])
		const small = yield* rowsReadByTable(installed, connection)
		yield* judged(connection)
		for (const sql of population(installed, share, share * drawn.growth)) {
			yield* connection.query(sql, [])
		}
		const growth = yield* loadWork(installed, connection)
		yield* judged(connection)
		yield* connection.query(seatAt(installed, -2, drawn.doc), [])
		const grown = yield* rowsReadByTable(installed, connection)
		const tables = Arr.dedupe([...Rec.keys(small), ...Rec.keys(grown)])
		for (const table of tables) {
			assert.equal(
				grown[table] ?? 0,
				small[table] ?? 0,
				`${Formatter.format(drawn)}: the judge's statements read ${grown[table] ?? 0} rows of ${table} over a seat written at ${drawn.growth} shares of the population, where over one they read ${small[table] ?? 0}`
			)
		}
		const shares = drawn.growth - 1
		assert.ok(
			growth <= shares * first,
			`${Formatter.format(drawn)}: the judge's statements read ${growth} rows over the ${shares} shares of the population written at once, past ${shares} times the ${first} they read over the first share`
		)
	})
