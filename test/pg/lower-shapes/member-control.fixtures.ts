/** What member-control.test.ts reads: its schema, its read and one case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
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
import { workload } from "#compiler/program/workload/value.ts"
import { Type } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, relation, schema } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	compileTemplate,
	compileTestWorkload,
	declaredOf,
	paramTexts,
	testCompile
} from "#test/support/compile.ts"
import { type Installed } from "#test/support/install-migrate.ts"
import { fullWorldTemplate } from "#test/support/installed.ts"
import { planAsRun } from "#test/support/judge.ts"
import { namesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { unprintedPaths } from "#test/support/read-indexes.ts"
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
 * with the item document it refers to;
 * each section that holds a member; each scope's stated `max-attempts`, by the scope's place (pantry's MaxAttempts); a
 * learner's item sessions, each of an item document of a package at a stage; and the learner's sittings of a test, each
 * at a stage.
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
const Stated = relation("Stated", { package: i, path: i, scope: i, attempts: i }, [
	"package",
	"path",
	"scope"
])
const ItemSession = relation("ItemSession", { child: i, n: i, package: i, path: i, stage: i }, [
	"child",
	"package",
	"path",
	"n"
])
const TestSession = relation("TestSession", { child: i, package: i, path: i, stage: i }, [
	"child",
	"package",
	"path"
])
const Content = schema(
	"MemberControl",
	[TestMember, ItemRefSection, Stated, ItemSession, TestSession],
	[]
)

/**
 * Each scope of a member, as qti-pie's member controls state them (ledger/src/member-controls.ts refScopes): the member
 * itself, each section that holds it, and its part.
 */
const refScopes = query(Content)
	.rule((r) => {
		const { package: pkg, path, start } = v(TestMember, "ownScope")
		return r
			.match(TestMember, { package: pkg, path, start })
			.find({ package: pkg, path, scope: start, start })
	})
	.rule((r) => {
		const { package: pkg, path, section, start } = v(ItemRefSection, "sectionScope")
		return r
			.match(ItemRefSection, { package: pkg, path, section, start })
			.find({ package: pkg, path, scope: section, start })
	})
	.rule((r) => {
		const { package: pkg, part, path, start } = v(TestMember, "partScope")
		return r
			.match(TestMember, { package: pkg, part, path, start })
			.find({ package: pkg, path, scope: part, start })
	})

/** Each scope of a member that states a `max-attempts`. */
const attemptScopes = query(Content).rule((r) => {
	const { package: pkg, path, scope, start } = v(refScopes, "attemptScope")
	return r
		.match(refScopes, { package: pkg, path, scope, start })
		.match(Stated, { package: pkg, path, scope })
		.find({ package: pkg, path, scope, start })
})

/** The nearest scope of a member that states a `max-attempts`, the one that starts last. */
const nearestAttempts = query(Content).rule((r) => {
	const { package: pkg, path, scope, start } = v(attemptScopes, "nearestAttemptScope")
	return r
		.match(attemptScopes, { package: pkg, path, scope, start })
		.find({ package: pkg, path, scope: r.max(scope), start })
})

/** Each member's `max-attempts` in force: the nearest scope's, else QTI's 1, a default list of every unstated member. */
const attemptsInForce = query(Content)
	.rule((r) => {
		const { package: pkg, path, scope, start } = v(nearestAttempts, "stated")
		const { attempts } = v(Stated, "attemptsInForce")
		return r
			.match(nearestAttempts, { package: pkg, path, scope, start })
			.match(Stated, { attempts, package: pkg, path, scope })
			.find({ maxAttempts: Type.cast(attempts, pg.bigint), package: pkg, path, start })
	})
	.rule((r) => {
		const { package: pkg, path, start } = v(TestMember, "defaultAttempts")
		return r
			.match(TestMember, { package: pkg, path, start })
			.where(r.not(nearestAttempts, { package: pkg, path, start }))
			.find({ maxAttempts: Type.literal(pg.bigint, 1n), package: pkg, path, start })
	})

/** Each member's controls in force, one row a member. */
const memberControls = query(Content).rule((r) => {
	const { package: pkg, path, start } = v(TestMember, "controlled")
	const { maxAttempts } = v(attemptsInForce, "memberAttempts")
	return r
		.match(TestMember, { package: pkg, path, start })
		.match(attemptsInForce, { maxAttempts, package: pkg, path, start })
		.find({ maxAttempts, package: pkg, path, start })
})

/**
 * Each item session's control, derived and never stored, as qti-pie's ItemSessionControl (ledger/src/session-control.ts
 * `controls`): the session, its sitting of the test, the test's member that refers to the session's item, and that
 * member's controls. The member is the one relation that carries the session's item to the member's place.
 */
const Control = derived(
	"Control",
	query(Content).rule((r) => {
		const { child, package: pkg, path, n, stage } = v(ItemSession, "memberSession")
		const { path: test } = v(TestSession, "memberSitting")
		const { start } = v(TestMember, "member")
		const { maxAttempts } = v(memberControls, "memberControl")
		return r
			.match(ItemSession, { child, n, package: pkg, path, stage })
			.match(TestSession, { child, package: pkg, path: test, stage })
			.match(TestMember, { document: path, package: pkg, path: test, start })
			.match(memberControls, { maxAttempts, package: pkg, path: test, start })
			.find({ child, maxAttempts, n, package: pkg, path })
	})
)
const Ledger = schema.extend([Content], "MemberControlLedger", [Control], [])

/**
 * A learner's item sessions of a stage, at the parameters, each with its control attached, read at the session's key, as
 * qti-pie's sessionControlOf is under metis's sitting.
 */
const controlRead = query(Ledger)
	.rule((r) => {
		const { child, n, package: pkg, path, stage } = v(ItemSession, "session")
		return r
			.match(ItemSession, { child, n, package: pkg, path, stage })
			.where(r.eq(child, r.param("child", i)), r.eq(stage, r.param("stage", i)))
			.find({ child, n, package: pkg, path })
	})
	.attach(
		"control",
		(head) =>
			query(Ledger).rule((r) => {
				const { maxAttempts } = v(Control, "control")
				return r
					.match(Control, {
						child: head.child,
						maxAttempts,
						n: head.n,
						package: head.package,
						path: head.path
					})
					.find({ maxAttempts })
			}),
		"array"
	)

/** The schemas installed through their first migration, with a reader whose workload's indexes the read earns. */
export const memberControlTemplate = fullWorldTemplate({
	declaredIn: import.meta,
	name: "member control",
	fixture: Ledger,
	programs: { controlRead },
	label: "member_control",
	ambient: ordinarySession
})

/** How a case's columns' statistics stand: as the stored rows' counts leave them, or stated (fill.ts statedDistinct). */
export type Statistics = "counted" | StatedDistinct

/**
 * A case: the learner's test of `members` members in `sections` sections, its part stating a `max-attempts` where
 * `partStated`, each section where `sectionStated`, every `ownEvery`-th member at its own scope; the learner's
 * `sessions` item sessions of the test's first members at stage 0; then `more` members stored beside them in the same
 * test before the read is explained again; and how the columns' statistics stand.
 */
export interface MemberCase {
	readonly members: number
	readonly sections: number
	readonly partStated: boolean
	readonly sectionStated: boolean
	readonly ownEvery: number
	readonly sessions: number
	readonly more: number
	readonly beside: number
	readonly besideMembers: number
	readonly statistics: Statistics
}

export const memberGen: Gen<MemberCase> = (s) => {
	const members = s.draw(int(2, 8))
	return {
		members,
		sections: s.draw(int(1, 3)),
		partStated: s.draw(boolean),
		sectionStated: s.draw(boolean),
		ownEvery: s.draw(int(1, 4)),
		sessions: s.draw(int(1, members)),
		more: s.draw(int(40, 120)),
		beside: s.draw(int(30, 60)),
		besideMembers: s.draw(int(40, 80)),
		statistics: s.draw(element<Statistics>(["counted", "unique", "one value"]))
	}
}

export type MemberFeature =
	| "beside few members"
	| "beside many members"
	| "under a stated part"
	| "under a stated section"
	| "with no scope stated"
	| "under counted statistics"
	| "under statistics stating each value its own"
	| "under statistics stating every row one value"

/** The test's package and path, and its part's place, past every member's and section's. */
const pkg = 1
const test = 1
const part = 100_000

/**
 * The statements storing the test's members `from` to `to` (each its own item document, the member's place its
 * number, in section `start mod sections`), the sections' and the part's stated attempts where the case states them and
 * every `ownEvery`-th member's own; the learner's sitting and sessions with the first members; then each table counted as
 * a VACUUM counts it, and its columns' statistics as the case states them.
 */
/** The case's tables, quoted. */
const tablesOf = (installed: Installed): ReadonlyArray<string> => {
	const names = namesOf(installed)
	return Arr.map([TestMember, ItemRefSection, Stated, ItemSession, TestSession], (t) =>
		names.table(t)
	)
}

/**
 * The packages stored beside the learner's, 2 to `beside` + 1: each a test of `besideMembers` members in three sections,
 * every other member and every other part stating attempts, and twenty learners of its own, each sitting it with sessions
 * of its first five members. They make each relation dozens of pages, as a store of many tests and learners is, so a
 * read of the learner's rows that scans a relation, or reads one at a prefix every package shares, reads every
 * package's, past the bound, and no index probe of the learner's rows costs PostgreSQL more than such a scan.
 */
const beside = (installed: Installed, c: MemberCase): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const packages = `generate_series(2, ${String(c.beside + 1)}) AS p(p)`
	const grid = `FROM ${packages}, generate_series(1, ${String(c.besideMembers)}) AS g(m)`
	return [
		`INSERT INTO ${names.table(TestMember)} (package, path, start, document, part) SELECT p, ${String(test)}, m, m, ${String(part)} ${grid}`,
		`INSERT INTO ${names.table(ItemRefSection)} (package, path, section, start) SELECT p, ${String(test)}, ${String(part)} + 1 + m % 3, m ${grid}`,
		`INSERT INTO ${names.table(Stated)} (package, path, scope, attempts) SELECT p, ${String(test)}, m, 3 ${grid} WHERE m % 2 = 0`,
		`INSERT INTO ${names.table(Stated)} (package, path, scope, attempts) SELECT p, ${String(test)}, ${String(part)}, 5 FROM ${packages} WHERE p % 2 = 0`,
		`INSERT INTO ${names.table(TestSession)} (child, package, path, stage) SELECT p * 100 + l, p, ${String(test)}, 0 FROM ${packages}, generate_series(1, 20) AS l(l)`,
		`INSERT INTO ${names.table(ItemSession)} (child, n, package, path, stage) SELECT p * 100 + l, 1, p, m, 0 FROM ${packages}, generate_series(1, 20) AS l(l), generate_series(1, 5) AS g(m)`
	]
}

const stored = (
	installed: Installed,
	c: MemberCase,
	from: number,
	to: number
): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const members = `FROM generate_series(${String(from)}, ${String(to)}) AS g(m)`
	const section = `(${String(part)} + 1 + m % ${String(c.sections)})`
	const tables = tablesOf(installed)
	const statistics = c.statistics
	const first = from === 1
	return [
		`INSERT INTO ${names.table(TestMember)} (package, path, start, document, part) SELECT ${String(pkg)}, ${String(test)}, m, m, ${String(part)} ${members}`,
		`INSERT INTO ${names.table(ItemRefSection)} (package, path, section, start) SELECT ${String(pkg)}, ${String(test)}, ${section}, m ${members}`,
		`INSERT INTO ${names.table(Stated)} (package, path, scope, attempts) SELECT ${String(pkg)}, ${String(test)}, m, 3 ${members} WHERE m % ${String(c.ownEvery)} = 0`,
		...(first && c.sectionStated
			? [
					`INSERT INTO ${names.table(Stated)} (package, path, scope, attempts) SELECT ${String(pkg)}, ${String(test)}, ${String(part)} + 1 + s, 2 FROM generate_series(0, ${String(c.sections - 1)}) AS h(s)`
				]
			: []),
		...(first && c.partStated
			? [
					`INSERT INTO ${names.table(Stated)} (package, path, scope, attempts) VALUES (${String(pkg)}, ${String(test)}, ${String(part)}, 5)`
				]
			: []),
		...(first
			? [
					`INSERT INTO ${names.table(TestSession)} (child, package, path, stage) VALUES (1, ${String(pkg)}, ${String(test)}, 0)`,
					`INSERT INTO ${names.table(ItemSession)} (child, n, package, path, stage) SELECT 1, 1, ${String(pkg)}, m, 0 FROM generate_series(1, ${String(c.sessions)}) AS g(m)`,
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
 * One case in its one transaction, which the case's end rolls back: the test's members stored with the learner's
 * sessions and the packages beside them, the read of the learner's stage explained, under no planner setting;
 * then `more` members stored beside them in the same test, and the read explained again. Both times its scans read at
 * most four times the learner's own rows: each session, its sitting, the member that refers to its item, the member's
 * scopes and their stated attempts. Each session's control reads its member's attempts in force at the member's place,
 * the place the member carries from the session's item. Where the member is an existence test over the session and the
 * attempts in force (R02), the attempts are derived for every member of the test, the member's test applied to each.
 */
export const runMemberControl = (
	installed: Installed,
	connection: PgConnection,
	c: MemberCase,
	k: Case<MemberFeature>
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
			compileTemplate(controlRead, undefined, options),
			"the read compiles"
		)
		const [statement, ...others] = template.optimized
		assert.ok(statement !== undefined && others.length === 0, "the read is one statement")
		const params = paramTexts(
			statement,
			{ child: 1, stage: 0 },
			declaredOf(template, controlRead, undefined, options)
		)
		const explained = planAsRun(connection.queryValues, statement.sql, params)
		/** Each session's own rows: the session, its sitting, its member, the member's three scopes and their statements. */
		const own = c.sessions * (3 + 3 + 3)
		const bound = 4 * own
		const bounded = (members: number) =>
			Effect.map(explained, (plan) => {
				const scanned = work(plan)
				assert.ok(
					scanned <= bound,
					`${Formatter.format(c)}: the read of the learner's stage beside a test of ${String(members)} members reads ${String(scanned)} rows, past its bound ${String(bound)} (the learner's ${String(own)})\n${statement.sql}`
				)
			})
		const planned = succeeded(
			compileTestWorkload(
				[{ login: "reader", workloads: [workload(Ledger, { controlRead })] }],
				Ledger,
				options
			),
			"the workload plans"
		)
		assert.equal(
			Arr.join(unprintedPaths(planned.requests, [template.run.statement.spec.plan]), ", "),
			"",
			`${Formatter.format(c)}: paths the workload's access asks at a binding no statement of the read prints`
		)
		yield* bounded(c.members)
		for (const sql of stored(installed, c, c.members + 1, c.members + c.more)) {
			yield* connection.query(sql, [])
		}
		yield* bounded(c.members + c.more)
		k.note(c.members + c.more < 60 ? "beside few members" : "beside many members")
		if (c.partStated) {
			k.note("under a stated part")
		}
		if (c.sectionStated) {
			k.note("under a stated section")
		}
		if (!c.partStated && !c.sectionStated) {
			k.note("with no scope stated")
		}
		k.note(
			c.statistics === "counted"
				? "under counted statistics"
				: c.statistics === "unique"
					? "under statistics stating each value its own"
					: "under statistics stating every row one value"
		)
	})
