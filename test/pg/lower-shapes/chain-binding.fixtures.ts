/** What chain-binding.test.ts reads: its schema, its read and one case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import {
	type PlanNode,
	planNodes,
	rowsGenerated,
	rowsRead,
	scannedRows
} from "#bench/harness/explain.ts"
import { identity } from "#compiler/core/identity.ts"
import { Type } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, declaredOf, paramTexts, testCompile } from "#test/support/compile.ts"
import { type Installed } from "#test/support/install-migrate.ts"
import { fullWorldTemplate } from "#test/support/installed.ts"
import { planAsRun } from "#test/support/judge.ts"
import { namesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import type { PgConnection } from "#test/support/pg.ts"
import {
	countedAsVacuumed,
	type StatedDistinct,
	statedDistinct
} from "#test/support/substrate/fill.ts"

const i = pg.integer

/**
 * A test's content and a learner's sittings of it, as qti-pie's ledger reads pantry's test views: each member of a test
 * by the test's package, its part, the test's path and the member's place `start`, keyed as pantry's TestMember is (its
 * key leads with the package and the part, so a read at the test's package and path binds a one-column prefix of it),
 * with the item document it refers to; each section's members, by the section and the member's place; each member's
 * stated feedback display and time limit, by its place; and a learner's sittings of a test, each at a stage.
 */
const TestMember = relation("TestMember", { package: i, path: i, start: i, document: i, part: i }, [
	"package",
	"part",
	"path",
	"start"
])
const ItemRefSection = relation("ItemRefSection", { package: i, path: i, section: i, start: i }, [
	"package",
	"path",
	"section",
	"start"
])
const Shown = relation("Shown", { package: i, path: i, start: i, shown: i }, [
	"package",
	"path",
	"start"
])
const Limit = relation("Limit", { package: i, path: i, start: i, seconds: i }, [
	"package",
	"path",
	"start"
])
const TestSession = relation("TestSession", { child: i, package: i, path: i, stage: i }, [
	"child",
	"package",
	"path"
])
const Content = schema("ChainBinding", [TestMember, ItemRefSection, Shown, Limit, TestSession], [])

/**
 * Each section member's feedback display in force, as qti-pie's member controls state a control: the stated one, else
 * 0, a default list of every section member that states none. It reads no TestMember, so a read of it at a test's
 * package and path binds a two-column prefix of every relation it reads, one more than TestMember's.
 */
const shownInForce = query(Content)
	.rule((r) => {
		const { package: pkg, path, shown, start } = v(Shown, "statedShown")
		return r
			.match(Shown, { package: pkg, path, shown, start })
			.find({ package: pkg, path, shown, start })
	})
	.rule((r) => {
		const { package: pkg, path, start } = v(ItemRefSection, "defaultShown")
		return r
			.match(ItemRefSection, { package: pkg, path, start })
			.where(r.not(Shown, { package: pkg, path, start }))
			.find({ package: pkg, path, shown: Type.literal(pg.integer, 0), start })
	})

/** Each section member's time limit in force: the stated one, else 0, a default list as shownInForce's. */
const limitInForce = query(Content)
	.rule((r) => {
		const { package: pkg, path, seconds, start } = v(Limit, "statedLimit")
		return r
			.match(Limit, { package: pkg, path, seconds, start })
			.find({ package: pkg, path, seconds, start })
	})
	.rule((r) => {
		const { package: pkg, path, start } = v(ItemRefSection, "defaultLimit")
		return r
			.match(ItemRefSection, { package: pkg, path, start })
			.where(r.not(Limit, { package: pkg, path, start }))
			.find({ package: pkg, path, seconds: Type.literal(pg.integer, 0), start })
	})

/**
 * A learner's sittings of a stage, at the parameters, each with its test's members attached, each member with its item
 * document and both controls in force: a region of the member and the two controls at the sitting's package and path,
 * all three binding the member's place. A control, read at a two-column prefix, leads the region's chain (cte-policy
 * keyedRegionChain) and binds the place; the other control and the member are read at it.
 */
const membersRead = query(Content)
	.rule((r) => {
		const { child, package: pkg, path, stage } = v(TestSession, "sitting")
		return r
			.match(TestSession, { child, package: pkg, path, stage })
			.where(r.eq(child, r.param("child", i)), r.eq(stage, r.param("stage", i)))
			.find({ package: pkg, path })
	})
	.attach(
		"members",
		(head) =>
			query(Content).rule((r) => {
				const { document, start } = v(TestMember, "member")
				const { shown } = v(shownInForce, "memberShown")
				const { seconds } = v(limitInForce, "memberLimit")
				return r
					.match(TestMember, { document, package: head.package, path: head.path, start })
					.match(shownInForce, { package: head.package, path: head.path, shown, start })
					.match(limitInForce, { package: head.package, path: head.path, seconds, start })
					.find({ document, seconds, shown, start })
			}),
		"array"
	)

/** The schema installed through its first migration, with a reader whose workload's indexes the read earns. */
export const chainBindingTemplate = fullWorldTemplate({
	declaredIn: import.meta,
	name: "chain binding",
	fixture: Content,
	programs: { membersRead },
	label: "chain_binding",
	ambient: ordinarySession
})

/** How a case's columns' statistics stand: as the stored rows' counts leave them, or stated (fill.ts statedDistinct). */
export type Statistics = "counted" | StatedDistinct

/**
 * A case: the learner's test of `members` members in `sections` sections, every `shownEvery`-th member stating its
 * feedback display and every `limitEvery`-th its time limit, and the learner's sitting of it at stage 0; `beside`
 * packages stored beside it, each a test of `besideMembers` members; then `more` members stored in the learner's test
 * before the read is explained again; and how the columns' statistics stand.
 */
export interface ChainCase {
	readonly members: number
	readonly sections: number
	readonly shownEvery: number
	readonly limitEvery: number
	readonly more: number
	readonly beside: number
	readonly besideMembers: number
	readonly statistics: Statistics
}

export const chainGen: Gen<ChainCase> = (s) => ({
	members: s.draw(int(2, 8)),
	sections: s.draw(int(1, 3)),
	shownEvery: s.draw(int(1, 4)),
	limitEvery: s.draw(int(1, 4)),
	more: s.draw(int(40, 120)),
	beside: s.draw(int(30, 60)),
	besideMembers: s.draw(int(40, 80)),
	statistics: s.draw(element<Statistics>(["counted", "unique", "one value"]))
})

export type ChainFeature =
	| "beside few members"
	| "beside many members"
	| "with every member stating its controls"
	| "with some member stating none"
	| "under counted statistics"
	| "under statistics stating each value its own"
	| "under statistics stating every row one value"

/** The learner's test's package and path, and its part's place, past every member's and section's. */
const pkg = 1
const test = 1
const part = 100_000

/** The case's tables, quoted. */
const tablesOf = (installed: Installed): ReadonlyArray<string> => {
	const names = namesOf(installed)
	return Arr.map([TestMember, ItemRefSection, Shown, Limit, TestSession], (t) => names.table(t))
}

/**
 * The packages stored beside the learner's, 2 to `beside` + 1: each a test of `besideMembers` members in three sections,
 * every other member stating its controls, and twenty learners of its own sitting it. They make each relation dozens of
 * pages, as a store of many tests and learners is, so a read of the learner's rows that scans a relation, or reads one
 * at a prefix every package shares, reads every package's, past the bound, and no index probe of the learner's rows
 * costs PostgreSQL more than such a scan.
 */
const beside = (installed: Installed, c: ChainCase): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const packages = `generate_series(2, ${String(c.beside + 1)}) AS p(p)`
	const grid = `FROM ${packages}, generate_series(1, ${String(c.besideMembers)}) AS g(m)`
	return [
		`INSERT INTO ${names.table(TestMember)} (package, path, start, document, part) SELECT p, ${String(test)}, m, m, ${String(part)} ${grid}`,
		`INSERT INTO ${names.table(ItemRefSection)} (package, path, section, start) SELECT p, ${String(test)}, ${String(part)} + 1 + m % 3, m ${grid}`,
		`INSERT INTO ${names.table(Shown)} (package, path, start, shown) SELECT p, ${String(test)}, m, 1 ${grid} WHERE m % 2 = 0`,
		`INSERT INTO ${names.table(Limit)} (package, path, start, seconds) SELECT p, ${String(test)}, m, 60 ${grid} WHERE m % 2 = 1`,
		`INSERT INTO ${names.table(TestSession)} (child, package, path, stage) SELECT p * 100 + l, p, ${String(test)}, 0 FROM ${packages}, generate_series(1, 20) AS l(l)`
	]
}

/**
 * The statements storing the learner's test's members `from` to `to` (each its own item document, the member's place its
 * number, in section `start mod sections`), the controls the case states; at the first, the learner's sitting and the
 * packages beside it; then each table counted as a VACUUM counts it, and its columns' statistics as the case states
 * them.
 */
const stored = (
	installed: Installed,
	c: ChainCase,
	from: number,
	to: number
): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const members = `FROM generate_series(${String(from)}, ${String(to)}) AS g(m)`
	const section = `(${String(part)} + 1 + m % ${String(c.sections)})`
	const tables = tablesOf(installed)
	const statistics = c.statistics
	return [
		`INSERT INTO ${names.table(TestMember)} (package, path, start, document, part) SELECT ${String(pkg)}, ${String(test)}, m, m, ${String(part)} ${members}`,
		`INSERT INTO ${names.table(ItemRefSection)} (package, path, section, start) SELECT ${String(pkg)}, ${String(test)}, ${section}, m ${members}`,
		`INSERT INTO ${names.table(Shown)} (package, path, start, shown) SELECT ${String(pkg)}, ${String(test)}, m, 1 ${members} WHERE m % ${String(c.shownEvery)} = 0`,
		`INSERT INTO ${names.table(Limit)} (package, path, start, seconds) SELECT ${String(pkg)}, ${String(test)}, m, 60 ${members} WHERE m % ${String(c.limitEvery)} = 0`,
		...(from === 1
			? [
					`INSERT INTO ${names.table(TestSession)} (child, package, path, stage) VALUES (1, ${String(pkg)}, ${String(test)}, 0)`,
					...beside(installed, c)
				]
			: []),
		...Arr.map(tables, countedAsVacuumed),
		...(statistics === "counted" ? [] : Arr.map(tables, (t) => statedDistinct(t, statistics)))
	]
}

/**
 * The work of a statement's scans, every loop: the rows each scan of a stored relation reads, each read of a function
 * yields, and each scan of a CTE reads, its output and what its filter removed.
 */
const work = (plan: PlanNode): number =>
	rowsRead(plan) +
	rowsGenerated(plan) +
	Arr.reduce(
		Arr.filter([...planNodes(plan)], (n) => n.nodeType === "CTE Scan"),
		0,
		(sum, n) => sum + scannedRows(n)
	)

/**
 * One case in its one transaction, which the case's end rolls back: the learner's test stored with its sitting and the
 * packages beside it, the read of the learner's stage explained, under no planner setting; then `more` members stored
 * in the test, and the read explained again. Both times its scans read at most four times the learner's own rows: the
 * sitting, and each member, its section membership and its stated controls. The control that leads the chain binds
 * each member's place, and the other control is read at it, as the member is. Where the place joins the second control
 * only at the member's step, last, the second control meets the first at the test's package and path alone, every
 * member's beside every member's: the test's members squared.
 */
export const runChainBinding = (
	installed: Installed,
	connection: PgConnection,
	c: ChainCase,
	k: Case<ChainFeature>
) =>
	Effect.gen(function* () {
		for (const sql of stored(installed, c, 1, c.members)) {
			yield* connection.query(sql, [])
		}
		const options = {
			...testCompile,
			installation: identity.schema(parsedSchemaName(installed.declared))
		}
		const template = succeeded(
			compileTemplate(membersRead, undefined, options),
			"the read compiles"
		)
		const [statement, ...others] = template.optimized
		assert.ok(statement !== undefined && others.length === 0, "the read is one statement")
		const params = paramTexts(
			statement,
			{ child: 1, stage: 0 },
			declaredOf(template, membersRead, undefined, options)
		)
		const explained = Effect.map(planAsRun(connection.queryValues, statement.sql, params), work)
		const bounded = (members: number) =>
			Effect.map(explained, (scanned) => {
				/** The learner's own rows: the sitting, and each member, its section membership and its two controls. */
				const own = 1 + members * 4
				const bound = 4 * own
				assert.ok(
					scanned <= bound,
					`${Formatter.format(c)}: the read of the learner's sitting of a test of ${String(members)} members reads ${String(scanned)} rows, past its bound ${String(bound)} (the learner's ${String(own)})\n${statement.sql}`
				)
			})
		yield* bounded(c.members)
		for (const sql of stored(installed, c, c.members + 1, c.members + c.more)) {
			yield* connection.query(sql, [])
		}
		yield* bounded(c.members + c.more)
		k.note(c.members + c.more < 60 ? "beside few members" : "beside many members")
		k.note(
			c.shownEvery === 1 && c.limitEvery === 1
				? "with every member stating its controls"
				: "with some member stating none"
		)
		k.note(
			c.statistics === "counted"
				? "under counted statistics"
				: c.statistics === "unique"
					? "under statistics stating each value its own"
					: "under statistics stating every row one value"
		)
	})
