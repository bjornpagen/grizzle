/** What the property of rule-concat-probe.test.ts reads: its schema and template, its space, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { planNodes } from "#bench/harness/explain.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import { Text } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import {
	judgedPlans,
	judgedStatementsOf,
	lookupSettings,
	scannedRowsOf,
	scannedTableOf,
	standUpJudge
} from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { countedAsVacuumed } from "#test/support/substrate/fill.ts"

/**
 * edullm's test-variable resolution in small (pantry's readings.ts, the qualified name `ITEMREF.VAR`): each reference
 * of a document, keyed by its element, holds an `identifier`, a text bounded at 256 bytes, which a lookup's index holds
 * as itself (one of no byte bound is a filter beside the index, README "Keys and indexes"); each variable a scope declares,
 * keyed by the scope and its name; and Resolved, the join of each variable with the references whose identifier is
 * the scope's name, a dot and the variable's, `identifier = scope || '.' || variable`, a computed text no row stores.
 * Every variable is held to a reference by a containment into that query, so the judge's probe of a written variable
 * reads Ref by its package and that identifier, which only the equation binds: the rows that share its package are
 * every reference of it.
 */
const Short = str.bytes(64, str.regex("^.*$", "su"))
const Identifier = str.bytes(256, str.regex("^.*$", "su"))

const Ref = relation(
	"Ref",
	{ package: Short, path: Short, start: pg.integer, identifier: Identifier },
	["package", "path", "start"]
)
const Var = relation("Var", { package: Short, scope: Short, variable: Short }, [
	"package",
	"scope",
	"variable"
])

const Base = schema("rule_concat", [Ref, Var], [])
const Resolved = derived(
	"Resolved",
	query(Base).rule((r) => {
		const { identifier, package: pkg, path, start } = v(Ref, "r")
		const { scope, variable } = v(Var, "s")
		return r
			.match(Var, { package: pkg, scope, variable })
			.match(Ref, { identifier, package: pkg, path, start })
			.where(r.eq(identifier, Text.concat(Text.concat(scope, "."), variable)))
			.find({ package: pkg, path, scope, start, variable })
	})
)
const concatSchema = schema.extend(
	[Base],
	"rule_concat_1",
	[Resolved],
	[contained(on(Var, "package", "scope", "variable"), on(Resolved, "package", "scope", "variable"))]
)

export const concatProbeTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "rule concat probe",
	content: { schema: concatSchema.name, logins: [] },
	versions: [{ schema: concatSchema, logins: [], declarations: noDeclarations }],
	options: {
		label: "rule_concat",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/** A case: the packages stored, each one's references, and the variables written. */
export interface Stored {
	readonly packages: number
	readonly references: number
	readonly written: number
}

/**
 * A few packages of thousands of references: a package's references outnumber what any one probe matches by three
 * orders of magnitude, and each table spans tens of pages, which a lookup through an index reads two or three of, so
 * PostgreSQL, over analyzed tables, plans the lookup where an index serves it; the bound each scan is held to is one row
 * a loop whatever their number, so a probe that reads a package's references reads thousands of rows past it.
 */
export const storedGen: Gen<Stored> = (s) => ({
	packages: s.draw(int(2, 4)),
	references: s.draw(int(3000, 9000)),
	written: s.draw(int(5, 40))
})

export type ConcatProbeFeature =
	| "a few thousand references a package"
	| "six thousand references a package and more"
	| "a variable no reference names refused"

/**
 * One case in its one transaction, which the case's end rolls back: `packages` packages of `references` references,
 * reference i of each named `scope<i / 10>.var<i>`, loaded with the captures off, and counted as a VACUUM counts it
 * (fill.ts countedAsVacuumed), as autovacuum leaves a loaded table: an ANALYZE there, which samples a hundred rows of a
 * table of declared statistics, counted no live row over the pages earlier cases' rolled-back loads left dead, so
 * PostgreSQL priced every read of Ref at one row and probed it by its primary key's package alone; then, through the
 * captures, `written` variables of package 1, each a reference's scope and name, whose rows the deltas hold until the judge
 * reads them. Each query the judge raises on is explained over them before the judge runs (test/support/judge.ts
 * judgedPlans), and then the judge runs (SET CONSTRAINTS ALL IMMEDIATE) and accepts the lawful state: every scan of Ref
 * reads, a loop, at most the rows of one package that share an identifier, one, never the package's references,
 * which a probe by its package alone reads, every one at each variable. A variable whose qualified name no reference
 * holds is refused by the containment (23503).
 */
export const runConcatProbe = (
	installed: Installed,
	connection: PgConnection,
	stored: Stored,
	c: Case<ConcatProbeFeature>
) =>
	Effect.gen(function* () {
		yield* standUpJudge(connection, installed.installation)
		const names = namesOf(installed)
		const ref = names.table(Ref)
		const variable = names.table(Var)
		const r = (f: "package" | "path" | "start" | "identifier") => names.column(Ref, f)
		const s = (f: "package" | "scope" | "variable") => names.column(Var, f)
		const pkg = (p: string) => `'package/' || (${p})`
		const loaded = [
			`ALTER TABLE ${ref} DISABLE TRIGGER USER`,
			`INSERT INTO ${ref} (${r("package")}, ${r("path")}, ${r("start")}, ${r("identifier")}) SELECT ${pkg("p")}, 'document/' || (i % 7), i, 'scope' || (i / 10) || '.var' || i FROM generate_series(1, ${stored.packages}) AS p(p), generate_series(0, ${stored.references - 1}) AS i(i)`,
			`ALTER TABLE ${ref} ENABLE TRIGGER USER`,
			countedAsVacuumed(ref),
			countedAsVacuumed(variable)
		]
		/** Written variable k is reference k·(references / written)'s, of package 1, spread over its references. */
		const written = [
			"SET CONSTRAINTS ALL DEFERRED",
			`INSERT INTO ${variable} (${s("package")}, ${s("scope")}, ${s("variable")}) SELECT ${pkg("1")}, 'scope' || (k * ${Math.floor(stored.references / stored.written)} / 10), 'var' || (k * ${Math.floor(stored.references / stored.written)}) FROM generate_series(0, ${stored.written - 1}) AS k(k)`,
			...lookupSettings
		]
		for (const sql of [...loaded, ...written]) {
			yield* connection.query(sql, [])
		}
		/** The most rows one lookup of Ref matches. */
		const [bounds] = yield* connection.queryValues(
			`SELECT max(n)::text FROM (SELECT count(*) AS n FROM ${ref} GROUP BY ${r("package")}, ${r("identifier")}) AS g`,
			[]
		)
		const most = Number(bounds?.[0])
		/** The judged queries over the deltas the write stood up, each explained before the judge runs: those it runs. */
		const judged = yield* judgedPlans(
			(sql) => connection.queryValues(sql, []),
			installed.installation,
			judgedStatementsOf(installed.installation)
		)
		for (const { plan } of judged) {
			const reads = Arr.flatMap([...planNodes(plan)], (n) =>
				Option.match(scannedTableOf(n), {
					onNone: () => [],
					onSome: (table) =>
						`${quoteIdent(names.schema)}.${quoteIdent(table)}` === ref
							? [
									{
										node: n.nodeType,
										index: Option.getOrUndefined(n.index),
										loops: n.actualLoops,
										rows: scannedRowsOf(n)
									}
								]
							: []
				})
			)
			assert.ok(
				Arr.every(reads, (read) => read.rows <= most),
				`${Formatter.format(stored)}: each scan of Ref the judge's probe makes reads, a loop, at most the ${most} rows one package's identifier matches, beside ${stored.references} references of the package: ${Formatter.format(reads)}`
			)
		}
		yield* connection.query("SET CONSTRAINTS ALL IMMEDIATE", [])
		c.note(
			stored.references < 6000
				? "a few thousand references a package"
				: "six thousand references a package and more"
		)
		/** A variable of package 1 whose qualified name no reference holds: `var<n>` past every reference's. */
		const unnamed = `INSERT INTO ${variable} (${s("package")}, ${s("scope")}, ${s("variable")}) VALUES (${pkg("1")}, 'scope0', 'var${stored.references}')`
		const [deferred, inserted, judgedUnnamed] = yield* connection.exchange([
			{ sql: "SET CONSTRAINTS ALL DEFERRED", params: [] },
			{ sql: unnamed, params: [] },
			{ sql: "SET CONSTRAINTS ALL IMMEDIATE", params: [] }
		])
		assert.ok(
			Result.isSuccess(deferred) && inserted !== undefined && Result.isSuccess(inserted),
			`${Formatter.format(stored)}: a variable no reference's identifier names is inserted, its judgment deferred`
		)
		assert.equal(
			judgedUnnamed !== undefined && Result.isFailure(judgedUnnamed)
				? pgErrorFields(judgedUnnamed.failure)?.code
				: undefined,
			"23503",
			`${Formatter.format(stored)}: a variable no reference's identifier names is refused by the containment`
		)
		c.note("a variable no reference names refused")
	})
