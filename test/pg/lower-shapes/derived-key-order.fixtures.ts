/** What derived-key-order.test.ts reads: its schemas, its read and one case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { Num, Type } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, key, on, relation, schema, sealed, unit } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
import { compileTemplate, declaredOf, paramTexts, testCompile } from "#test/support/compile.ts"
import { type Installed } from "#test/support/install-migrate.ts"
import { fullWorldTemplate } from "#test/support/installed.ts"
import { keyedReadWork, planAsRun, probeCostOf, wideScans } from "#test/support/judge.ts"
import { namesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import type { PgConnection } from "#test/support/pg.ts"
import {
	countedAsVacuumed,
	rowsBeside,
	rowsPerPage,
	type StatedDistinct,
	statedDistinct
} from "#test/support/substrate/fill.ts"

const i = pg.integer

/**
 * A package's content, as pantry's node tree holds it: each node of a package's document by its start, and by its parent
 * and start too (a tree key, as pantry's), with a raw value, in the unit of its package, sealed as a publication seals a package (every row of it inserted by the
 * one write that founds it); and a learner's item sessions, each of an item of a package at a stage.
 */
const Node = relation("Node", { package: i, path: i, start: i, parent: i, raw: i }, [
	"package",
	"path",
	"start"
])
const Session = relation("Session", { child: i, n: i, package: i, path: i, stage: i }, [
	"child",
	"n"
])
const Package = sealed(unit("Package", { package: i }))
const Content = schema(
	"DerivedKeyOrder",
	[Node, Session],
	[Package, key(on(Node, "package", "path", "parent", "start"))]
)

/**
 * Each scope's allowance, as pantry's MaxAttempts holds an item ref's `max-attempts`: a value computed from a node's raw
 * value, by the node's package, path and parent. No key narrower than its heading is proven (two nodes may share a
 * parent), so its key is its whole heading, the computed `allowance` first by name. Unit-local in its package, so stored
 * (analysis/derived/storage.ts).
 */
const Allowance = derived(
	"Allowance",
	query(Content).rule((r) => {
		const { package: pkg, path, parent, raw } = v(Node, "control")
		return r
			.match(Node, { package: pkg, path, parent, raw })
			.find({ allowance: Type.cast(Num.add(raw, 1), pg.bigint), package: pkg, path, scope: parent })
	})
)
const Ledger = schema.extend([Content], "DerivedKeyOrderStored", [Allowance], [])

/**
 * A child's sessions of a stage, at the parameters, each with its item's allowances attached, as metis's session control
 * reads MaxAttempts at each session's package and path: a read binding the columns the derivation takes from Node's key,
 * none of the computed value.
 */
const allowanceRead = query(Ledger)
	.rule((r) => {
		const { child, n, package: pkg, path, stage } = v(Session, "session")
		return r
			.match(Session, { child, n, package: pkg, path, stage })
			.where(r.eq(child, r.param("child", i)), r.eq(stage, r.param("stage", i)))
			.find({ child, n, package: pkg, path })
	})
	.attach(
		"allowances",
		(head) =>
			query(Ledger).rule((r) => {
				const { allowance, scope } = v(Allowance, "allowance")
				return r
					.match(Allowance, { allowance, package: head.package, path: head.path, scope })
					.find({ allowance, scope })
			}),
		"array"
	)

/** The schemas installed through their first migration, with a reader whose workload's indexes the read earns. */
export const keyOrderTemplate = fullWorldTemplate({
	declaredIn: import.meta,
	name: "derived key order",
	fixture: Ledger,
	programs: { allowanceRead },
	label: "derived_key_order",
	ambient: ordinarySession
})

/** How a case's columns' statistics stand: as the stored rows' counts leave them, or stated (fill.ts statedDistinct). */
export type Statistics = "counted" | StatedDistinct

/**
 * A case: `packages` packages stored, each of `paths` items, each item's `scopes` scopes with an allowance each; the
 * child's `sessions` sessions at stage 0, each of an item of package 1; then `more` packages stored beside them before
 * the read is explained again; and how the columns' statistics stand.
 */
export interface KeyOrderCase {
	readonly packages: number
	readonly paths: number
	readonly scopes: number
	readonly sessions: number
	readonly more: number
	readonly statistics: Statistics
}

export const keyOrderGen: Gen<KeyOrderCase> = (s) => {
	const paths = s.draw(int(2, 6))
	return {
		packages: s.draw(int(2, 6)),
		paths,
		scopes: s.draw(int(1, 3)),
		sessions: s.draw(int(1, paths)),
		more: s.draw(int(20, 60)),
		statistics: s.draw(element<Statistics>(["counted", "unique", "one value"]))
	}
}

export type KeyOrderFeature =
	| "beside few packages"
	| "beside many packages"
	| "under counted statistics"
	| "under statistics stating each value its own"
	| "under statistics stating every row one value"

/**
 * The statements storing packages `from` to `to`: each item's scopes' allowances, Allowance's table filled as its upkeep
 * fills it from the nodes a publication writes (the read reads the stored table alone), then each table counted as a
 * VACUUM counts it, and its columns' statistics as the case
 * states them; the child's sessions with the first packages.
 */
const stored = (
	installed: Installed,
	c: KeyOrderCase,
	from: number,
	to: number
): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const grid = `FROM generate_series(${String(from)}, ${String(to)}) AS g(p), generate_series(1, ${String(c.paths)}) AS h(path), generate_series(1, ${String(c.scopes)}) AS k(scope)`
	const tables = Arr.map([Session, Allowance], (t) => names.table(t))
	const statistics = c.statistics
	return [
		`INSERT INTO ${names.table(Allowance)} (allowance, package, path, scope) SELECT scope * 10 + 1, p, path, scope ${grid}`,
		...(from === 1
			? [
					`INSERT INTO ${names.table(Session)} SELECT 1, n, 1, n, 0 FROM generate_series(1, ${String(c.sessions)}) AS g(n)`
				]
			: []),
		...Arr.map(tables, countedAsVacuumed),
		...(statistics === "counted" ? [] : Arr.map(tables, (t) => statedDistinct(t, statistics)))
	]
}

/**
 * The packages a case stores beside its own before any of them, numbered past every package a case stores, each of one
 * item of one scope's allowance, and as many other children's sessions of them: a store large beside the child's rows,
 * so PostgreSQL reads each relation the read binds by key through its index under no planner setting (fill.ts
 * rowsBeside), at `probes` probes of each table, the narrowest four integers a row.
 */
const besidePackages = (installed: Installed, probes: number): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const packages = `FROM generate_series(1000000, ${String(1_000_000 + rowsBeside(probes, rowsPerPage(4 * 4)) - 1)}) AS g(p)`
	return [
		`INSERT INTO ${names.table(Allowance)} (allowance, package, path, scope) SELECT 11, p, 1, 1 ${packages}`,
		`INSERT INTO ${names.table(Session)} SELECT p, 1, p, 1, 0 ${packages}`
	]
}

/**
 * One case in its one transaction, which the case's end rolls back: the packages beside (`besidePackages`) stored, then
 * packages 1 to `packages` with the child's sessions, the read of the child's stage explained under no planner setting;
 * then `more` packages stored beside them, and the read explained again. Both times it reads no table larger than a
 * probe whole, and its keyed work (test/support/judge.ts keyedReadWork) is at most three times the child's sessions
 * and their items' allowances: each session's attachment seeks Allowance at its package and path, a
 * prefix of its key in key order (analysis/logical/derived.ts inheritedKeys). A key led by the computed allowance binds
 * no prefix: the attachment is co-grouped, Allowance read whole, every package's, past the bound once a few packages
 * stand beside the child's.
 */
export const runKeyOrder = (
	installed: Installed,
	connection: PgConnection,
	c: KeyOrderCase,
	k: Case<KeyOrderFeature>
) =>
	Effect.gen(function* () {
		const probeCost = yield* probeCostOf((sql) => connection.queryValues(sql, []))
		for (const sql of [
			...besidePackages(installed, 2 * c.sessions),
			...stored(installed, c, 1, c.packages)
		]) {
			yield* connection.query(sql, [])
		}
		const options = {
			...testCompile,
			installation: identity.schema(parsedSchemaName(installed.declared))
		}
		const template = succeeded(
			compileTemplate(allowanceRead, undefined, options),
			"the read compiles"
		)
		const [statement, ...others] = template.optimized
		assert.ok(statement !== undefined && others.length === 0, "the read is one statement")
		const params = paramTexts(
			statement,
			{ child: 1, stage: 0 },
			declaredOf(template, allowanceRead, undefined, options)
		)
		const explained = Effect.map(
			planAsRun(connection.queryValues, statement.sql, params),
			(plan) => ({ work: keyedReadWork(plan, probeCost), wide: wideScans(plan, probeCost) })
		)
		/** The child's sessions and their items' allowances. */
		const own = c.sessions * (1 + c.scopes)
		const bound = 3 * own
		const bounded = (packages: number) =>
			Effect.map(explained, ({ work, wide }) => {
				assert.deepEqual(
					wide,
					[],
					`${Formatter.format(c)}: the read of the child's stage beside ${String(packages)} packages reads no table larger than a probe whole\n${statement.sql}`
				)
				assert.ok(
					work <= bound,
					`${Formatter.format(c)}: the read of the child's stage beside ${String(packages)} packages reads ${String(work)} rows, past its bound ${String(bound)} (the child's ${String(own)})\n${statement.sql}`
				)
			})
		yield* bounded(c.packages)
		for (const sql of stored(installed, c, c.packages + 1, c.packages + c.more)) {
			yield* connection.query(sql, [])
		}
		yield* bounded(c.packages + c.more)
		k.note(c.packages < 4 ? "beside few packages" : "beside many packages")
		k.note(
			c.statistics === "counted"
				? "under counted statistics"
				: c.statistics === "unique"
					? "under statistics stating each value its own"
					: "under statistics stating every row one value"
		)
	})
