/** What import-upkeep.test.ts reads: its schema, its template and one case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { type PlanNode, rowsRead } from "#bench/harness/explain.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, relation, schema, sealed, unit } from "#compiler/public/schema.ts"
import { pgClassStates, standIn } from "#test/support/advice.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { standUpJudge, upkeepRuns } from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"

const i = int4

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
 * One case in its one transaction, which the case's end rolls back, held in every pg_class state (test/support/advice.ts
 * PgClassState), each within a savepoint rolled back after it: the judge stood up, `beside` packages written a package
 * at a time and judged (SET CONSTRAINTS ALL IMMEDIATE, Forward's upkeep storing their rows and the deltas emptied), the
 * nodes and Forward's table stood in the state (standIn); then one package founded, and Forward's upkeep's statements explained with
 * ANALYZE over its deltas as the judge runs them, its removal's loop, its query and each DELETE of one stale row, and
 * then its INSERT (support/judge.ts upkeepRuns). Every statement of the upkeep reads at most four times the founded package's nodes,
 * its region of the written package and the closed import of targets read at it: the targets' definition read at the
 * package the founding write wrote, never every package's targets, which grow with the packages beside it.
 */
export const runImportUpkeep = (
	installed: Installed,
	connection: PgConnection,
	bare: PgConnection,
	c: ImportUpkeepCase,
	k: Case<ImportUpkeepFeature>
) =>
	Effect.gen(function* () {
		yield* standUpJudge(connection, installed.installation)
		const names = namesOf(installed)
		const own = c.documents * c.rules * (1 + 2 * c.targets)
		const run = (statements: ReadonlyArray<string>) =>
			Effect.forEach(statements, (sql) => connection.query(sql, []), { discard: true })
		const bound = 4 * own
		for (const state of pgClassStates) {
			yield* bare.query("SAVEPOINT the_state", [])
			yield* standIn(
				{ values: connection.queryValues },
				{
					tables: [names.table(Node), names.table(Forward)],
					units: c.beside,
					load: (from, to) =>
						run([
							nodesOf(installed, c, from + 1, to + 1),
							"SET CONSTRAINTS ALL IMMEDIATE",
							"SET CONSTRAINTS ALL DEFERRED"
						])
				},
				state
			)
			yield* run([nodesOf(installed, c, 1, 1)])
			const plans: ReadonlyArray<PlanNode> = yield* upkeepRuns(
				(sql) => connection.queryValues(sql, []),
				installed.installation,
				Forward.name
			)
			for (const [at, plan] of plans.entries()) {
				const read = rowsRead(plan)
				assert.ok(
					read <= bound,
					`${Formatter.format(c)}, with every table ${state}: Forward's upkeep's statement ${String(at)} reads ${String(read)} rows beside ${String(c.beside)} packages, past its bound ${String(bound)} (the founded package's ${String(own)} nodes)`
				)
			}
			yield* bare.query("ROLLBACK TO SAVEPOINT the_state", [])
		}
		k.note(c.beside < 64 ? "beside a few packages" : "beside hundreds of packages")
	})
