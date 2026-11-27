/** What import-upkeep.test.ts reads: its schema, its template and one case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { type PlanNode, rowsRead } from "#bench/harness/explain.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, relation, schema, sealed, unit } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { standUpJudge, upkeepRuns } from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { countedAsVacuumed, rowsBeside, rowsPerPage } from "#test/support/substrate/fill.ts"

const i = pg.integer

/**
 * A package's document tree as pantry's node relation holds it: each element by its place, its kind and its parent's
 * place, in the unit of its package, sealed as a publication seals a package (every row of it written by the one write
 * that founds it).
 */
const Node = relation("Node", { package: i, path: i, start: i, kind: i, parent: i }, [
	"package",
	"path",
	"start"
])
const Content = schema("ImportUpkeep", [Node], [sealed(unit("Package", { package: i }))])

/** The kinds of a branch rule's element and of the target a branch names, as pantry's QTI kinds. */
const kinds = { rule: 302, target: 106 } as const

/**
 * The branch targets of a document: each target element, a selection of the nodes of one kind, its key kept, which a
 * table would copy (analysis/derived/storage.ts copiedRelation), so it is read in its definition's place, a closed
 * import of the rule below, as pantry's ForwardBranchRule imports its targets.
 */
const targets = query(Content).rule((r) => {
	const { package: pkg, path, start, parent } = v(Node, "target")
	return r
		.match(Node, { package: pkg, path, start, kind: kinds.target, parent })
		.find({ package: pkg, path, start, parent })
})

/**
 * Each branch rule with the targets under it, pantry's ForwardBranchRule in small: a rule element and each target the
 * closed import finds under it, unit-local in the package, sealed, so the installation stores it and its upkeep reads it
 * at the packages a founding write wrote (analysis/theory/upkeep.ts `founded`).
 */
const Forward = derived(
	"Forward",
	query(Content).rule((r) => {
		const { package: pkg, path, start: rule } = v(Node, "rule")
		const { start: target } = v(targets, "branch")
		return r
			.match(Node, { package: pkg, path, start: rule, kind: kinds.rule })
			.match(targets, { package: pkg, path, start: target, parent: rule })
			.find({ package: pkg, path, rule, target })
	})
)
const Ledger = schema.extend([Content], "ImportUpkeepStored", [Forward], [])

/** The schemas installed through their first migration, with no login. */
export const importUpkeepTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "import upkeep",
	content: { schema: Ledger.name, logins: [] },
	versions: [{ schema: Ledger, declarations: noDeclarations }],
	options: {
		label: "import_upkeep",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/**
 * A case: `beside` packages committed first, then one package founded, each of `documents` documents of `rules` rule
 * elements, each rule with `targets` targets under it and as many elements of another kind beside them.
 */
export interface ImportUpkeepCase {
	readonly beside: number
	readonly documents: number
	readonly rules: number
	readonly targets: number
}

export const importUpkeepGen: Gen<ImportUpkeepCase> = (s) => ({
	beside: s.draw(int(4, 300)),
	documents: s.draw(int(1, 3)),
	rules: s.draw(int(1, 4)),
	targets: s.draw(int(1, 3))
})

export type ImportUpkeepFeature = "beside a few packages" | "beside hundreds of packages"

/**
 * The statement writing packages `from` to `to`: in each document, rule `r` at place 100r, each of its targets at 100r
 * + t, and an element of another kind beside each at 100r + 50 + t.
 */
const nodesOf = (installed: Installed, c: ImportUpkeepCase, from: number, to: number): string =>
	`INSERT INTO ${namesOf(installed).table(Node)} SELECT p, d, 100 * r + e, CASE WHEN e = 0 THEN ${String(kinds.rule)} WHEN e < 50 THEN ${String(kinds.target)} ELSE 1 END, CASE WHEN e = 0 THEN 0 ELSE 100 * r END ` +
	`FROM generate_series(${String(from)}, ${String(to)}) AS g(p), generate_series(1, ${String(c.documents)}) AS h(d), generate_series(1, ${String(c.rules)}) AS k(r), ` +
	`(SELECT 0 UNION ALL SELECT t FROM generate_series(1, ${String(c.targets)}) AS t UNION ALL SELECT 50 + t FROM generate_series(1, ${String(c.targets)}) AS t) AS x(e)`

/**
 * One case in its one transaction, which the case's end rolls back: the judge stood up, `beside` packages written, and as
 * many more as make the nodes a table worth planning, and
 * judged (SET CONSTRAINTS ALL IMMEDIATE, Forward's upkeep storing their rows and the deltas emptied), their tables
 * counted as a VACUUM counts them; then one package founded, and Forward's upkeep's statements explained with
 * ANALYZE over its deltas as the judge runs them, its removal's loop, its query and each DELETE of one stale row, and
 * then its INSERT (support/judge.ts upkeepRuns). Every statement of the upkeep reads at most four times the founded package's nodes,
 * its region of the written package and the closed import of targets read at it: the targets' definition read at the
 * package the founding write wrote, never every package's targets, which grow with the packages beside it.
 */
export const runImportUpkeep = (
	installed: Installed,
	connection: PgConnection,
	c: ImportUpkeepCase,
	k: Case<ImportUpkeepFeature>
) =>
	Effect.gen(function* () {
		yield* standUpJudge(connection, installed.installation)
		const names = namesOf(installed)
		const own = c.documents * c.rules * (1 + 2 * c.targets)
		/** Forward's rows in a package: each rule's targets. */
		const forward = c.documents * c.rules * c.targets
		/**
		 * Packages enough beside the founded one that a scan of the nodes, and of Forward's table, prices past a seek of
		 * each of the package's rows of it (fill.ts rowsBeside), so PostgreSQL reads each through an index wherever a
		 * statement binds its key, never a table of a page or two it scans whole.
		 */
		const beside =
			c.beside +
			Math.max(
				Math.ceil(rowsBeside(own, rowsPerPage(5 * 4)) / own),
				Math.ceil(rowsBeside(forward, rowsPerPage(4 * 4)) / forward)
			)
		for (const sql of [
			nodesOf(installed, c, 2, beside + 1),
			"SET CONSTRAINTS ALL IMMEDIATE",
			"SET CONSTRAINTS ALL DEFERRED",
			...Arr.map([names.table(Node), names.table(Forward)], countedAsVacuumed),
			nodesOf(installed, c, 1, 1)
		]) {
			yield* connection.query(sql, [])
		}
		const plans: ReadonlyArray<PlanNode> = yield* upkeepRuns(
			(sql) => connection.queryValues(sql, []),
			installed.installation,
			Forward.name
		)
		const bound = 4 * own
		for (const [at, plan] of plans.entries()) {
			const read = rowsRead(plan)
			assert.ok(
				read <= bound,
				`${Formatter.format(c)}: Forward's upkeep's statement ${String(at)} reads ${String(read)} rows beside ${String(beside)} packages, past its bound ${String(bound)} (the founded package's ${String(own)} nodes)`
			)
		}
		k.note(c.beside < 64 ? "beside a few packages" : "beside hundreds of packages")
	})
