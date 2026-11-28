/** What the property of rule-concat-probe.test.ts reads: its schema and template, its space, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { planNodes } from "#bench/harness/explain.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { Text } from "#compiler/public/compute.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, seededTemplate } from "#test/support/install-migrate.ts"
import {
	judgedPlans,
	judgedStatementsOf,
	scannedRowsOf,
	scannedTableOf,
	standUpJudge
} from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { storedSeed } from "#test/support/stored.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import type { SubstrateTemplate } from "#test/support/substrate/substrate.ts"

/**
 * edullm's test-variable resolution in small (pantry's readings.ts, the qualified name `ITEMREF.VAR`): each reference
 * of a document, keyed by its element, holds an `identifier`, a text bounded at 256 bytes, which a lookup's index holds
 * as itself (one of no byte bound is a filter beside the index, docs/limits.md "Keys and indexes"); each variable a scope declares,
 * keyed by the scope and its name; and Resolved, the join of each variable with the references whose identifier is
 * the scope's name, a dot and the variable's, `identifier = scope || '.' || variable`, a computed text no row stores.
 * Every variable is held to a reference by a containment into that query, so the judge's probe of a written variable
 * reads Ref by its package and that identifier, which only the equation binds: the rows that share its package are
 * every reference of it.
 */
const Short = str.bytes(64, str.regex("^.*$", "su"))
const Identifier = str.bytes(256, str.regex("^.*$", "su"))

const Ref = relation("Ref", { package: Short, path: Short, start: int4, identifier: Identifier }, [
	"package",
	"path",
	"start"
])
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

/** The packages stored: a few, each of thousands of references. */
const packages = 3

/** Each package's references, a template's: a few thousand, and six thousand. */
const referenceCounts = [3000, 6000] as const
type References = (typeof referenceCounts)[number]

/**
 * The rows of `packages` packages of `references` references, reference i of each named `scope<i / 10>.var<i>`.
 */
const referenceRows = (installed: Installed, references: number): string => {
	const names = namesOf(installed)
	const r = (f: "package" | "path" | "start" | "identifier") => names.column(Ref, f)
	return `INSERT INTO ${names.table(Ref)} (${r("package")}, ${r("path")}, ${r("start")}, ${r("identifier")}) SELECT 'package/' || p, 'document/' || (i % 7), i, 'scope' || (i / 10) || '.var' || i FROM generate_series(1, ${packages}) AS p(p), generate_series(0, ${references - 1}) AS i(i)`
}

/**
 * concatSchema installed, and `packages` packages of `references` references each committed through the captures once
 * per member, judged at their COMMIT (stored.ts storedSeed): the template a case of that many references writes beside.
 */
const concatProbeTemplate = (references: References): SubstrateTemplate<Installed> =>
	seededTemplate({
		declaredIn: import.meta,
		name: `rule concat probe ${references}`,
		schema: concatSchema,
		options: { ambient: ordinarySession, extensions: [], label: "rule_concat" },
		seed: storedSeed((installed) => [referenceRows(installed, references)])
	})

export const concatProbeTemplates: {
	readonly [R in References as `${R}`]: SubstrateTemplate<Installed>
} = { "3000": concatProbeTemplate(3000), "6000": concatProbeTemplate(6000) }

/** A case: each package's references, its template's, and the variables written. */
export interface Stored {
	readonly references: References
	readonly written: number
}

/**
 * A few packages of thousands of references: a package's references outnumber what any one probe matches by three
 * orders of magnitude, and each table spans tens of pages, which a lookup through an index reads two or three of, so
 * PostgreSQL, over analyzed tables, plans the lookup where an index serves it; the bound each scan is held to is one row
 * a loop whatever their number, so a probe that reads a package's references reads thousands of rows past it.
 */
export const storedGen: Gen<Stored> = (s) => ({
	references: s.draw(element(referenceCounts)),
	written: s.draw(int(5, 40))
})

export type ConcatProbeFeature =
	| "a few thousand references a package"
	| "six thousand references a package and more"
	| "a variable no reference names refused"

/**
 * One case in its one transaction over a clone of its template (concatProbeTemplates), which the case's end rolls back:
 * the template's `packages` packages of `references` committed references, reference i of each named
 * `scope<i / 10>.var<i>`, read under the advice each judged query carries, so no estimate of Ref's rows prices it at one
 * row and probes it by its primary key's package alone, as one did when PostgreSQL chose; then, through the
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
		/** Written variable k is reference k·(references / written)'s, of package 1, spread over its references. */
		const written = [
			"SET CONSTRAINTS ALL DEFERRED",
			`INSERT INTO ${variable} (${s("package")}, ${s("scope")}, ${s("variable")}) SELECT ${pkg("1")}, 'scope' || (k * ${Math.floor(stored.references / stored.written)} / 10), 'var' || (k * ${Math.floor(stored.references / stored.written)}) FROM generate_series(0, ${stored.written - 1}) AS k(k)`
		]
		for (const sql of written) {
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
