/**
 * Worlds across migrations on PostgreSQL 19: each case draws a starting version of a schema with worlds and a history
 * of one or two later versions, each turning a drawn set of the knobs a world rests on, and migrates through its
 * generated, reviewed folders (`migrated`: each drafted under the renames its version declares, applied by the real
 * runner, which drift-checks the catalog it reaches). The oracle is PostgreSQL's catalog: each login's and role's OID,
 * the drift check, Db.open's admission and the installed-catalog checker.
 *
 * The schema: documents of organizations on a tier (a roster, whose closed ids are smallint codes), each with a word
 * count and a cap (a contract), their shares and their notes (each its document's and its number there), and a stored
 * derived relation over the documents' word counts, the documents open in a unit of their own. Two contexts are read:
 * the session's subject, and a quota whose cap is the contract. `editor` holds the documents whole, so it reads the
 * derived relation in full, reads Capped (the documents at the quota's cap) and writes Mine, its notes under row
 * security; `viewer` holds the organizations and the tier whole, relations of the base alone; `tally` holds the
 * documents alone, so it reads the derived relation in full too. All three are of one login.
 *
 * The knobs, each a change a world rests on when it turns:
 * - a read query entry's head;
 * - a written entry's policy filter, among the notes of documents the subject owns, of documents shared with it, and
 *   its own, so a filter function reads another relation or stops reading one;
 * - a context's contract, the cap's least value, raised or lowered;
 * - the login's name, declared renamed (`--rename @desk=@counter`, and back);
 * - the tier's roster grown by a handle, a new names constant and roster domain under the viewer's view of the
 *   organizations, which decodes each organization's tier through the names constant;
 * - the word count retyped from integer to bigint, a column under the derived relation, whose table goes and comes back
 *   refilled, and under the editor's view of the documents.
 * A roster only grows and the word count only widens: a shrunk roster or a narrowed column is a declared drop or a data
 * step, which is another suite's.
 *
 * Properties, for every history:
 * - each folder applies and the drift check admits the catalog it reaches: every world object reading what changed was
 *   dropped before the change and created after it, in the same transaction;
 * - Db.open admits every role at the last snapshot;
 * - the installed-catalog checker finds nothing: among it, one whole view of each relation some role holds whole, the
 *   derived relation's one view granted SELECT to the editor and the tally, who read it in full, each whole view
 *   granted to exactly the roles holding its relation whole or reading it in full with USAGE on its schema of whole
 *   views, the viewer's on the base's alone, and a role's own schema standing only where it holds a query entry, the
 *   editor's alone;
 * - no migration recreates a login or a role: each keeps its OID across the versions, so a password and what other
 *   roles were granted survive, a renamed login included;
 * - each role reads, by the certifier's bound of its direct transactions (physical/ddl/roles.ts readableRelations),
 *   exactly the stored relations PostgreSQL lets a statement of it read: each table it holds a table or column
 *   privilege on, and each its views read, through views to any depth, by the catalog's dependencies.
 *
 * Features: each knob's turn, the login renamed back, several knobs at once and a history of two migrations, each a
 * steered case constructs while it is pending: a start where the knob turns, and the turn.
 */

import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order, Record as Rec } from "effect"
import { roleNameOf } from "#adapter/served/served.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { readableRelations } from "#compiler/physical/ddl/roles.ts"
import {
	aims,
	type Built,
	historyFeatures,
	historyGen,
	type Knobs,
	oidQuery,
	versionOf,
	type WorldsFeature
} from "#test/pg/migrate/worlds.fixtures.ts"
import { checkInstalled, installedScope } from "#test/support/catalog/installed.ts"
import { readCatalog } from "#test/support/catalog/read.ts"
import { migrated, type Version } from "#test/support/installed.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { withServedDb } from "#test/support/served-db.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * The tables a PostgreSQL role can read, by schema and name: each it holds a table or column privilege on, and each a
 * view it can read depends on, through views to any depth (a view's rewrite rule depends on every relation its
 * definition reads).
 */
const reachQuery = `WITH RECURSIVE reach(oid) AS (
	SELECT c.oid FROM pg_catalog.pg_class AS c
	WHERE c.relkind IN ('r', 'p', 'v')
		AND (pg_catalog.has_table_privilege($1::text, c.oid, 'SELECT,INSERT,UPDATE,DELETE')
			OR pg_catalog.has_any_column_privilege($1::text, c.oid, 'SELECT,INSERT,UPDATE'))
	UNION
	SELECT d.refobjid FROM reach AS r
	JOIN pg_catalog.pg_class AS v ON v.oid = r.oid AND v.relkind = 'v'
	JOIN pg_catalog.pg_rewrite AS w ON w.ev_class = v.oid
	JOIN pg_catalog.pg_depend AS d ON d.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass
		AND d.objid = w.oid AND d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.refobjid <> v.oid
)
SELECT n.nspname::text, c.relname::text FROM reach AS r
JOIN pg_catalog.pg_class AS c ON c.oid = r.oid
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')`

/** Worlds across migrations every history of the changes a world rests on migrates with its roles kept and its catalog admitted. */
export const worlds = property.explore(aimed(historyGen, aims), {
	needs: { caseSubstrate: Substrate.fresh(baseSubstrate) },
	situations: [
		"a read query entry's head changes",
		"a written entry's policy filter stops reading another relation",
		"a filter function reads another relation",
		"a context's contract changes",
		"the login is renamed",
		"the login is renamed back",
		"a roster under a world view grows",
		"a column under a derived relation and a world view is retyped",
		"several knobs turn at once",
		"a history of two migrations"
	] satisfies ReadonlyArray<Reached<WorldsFeature>>,
	/** Its pre-conversion budget: runs 2, coverage cases 16 (worlds.test.ts at bf4f43bb). */
	budget: { runs: 2, steered: 16 },
	check:
		({ caseSubstrate }, reached: Case<WorldsFeature>) =>
		(h) =>
			Effect.provideServiceEffect(
				Effect.gen(function* () {
					reached.noteAll(historyFeatures(h))
					const versions = [h.start, ...h.later]
					const substrate = yield* Substrate
					const built: Array<Built> = []
					const version =
						(k: Knobs) =>
						(name: string): Version => {
							const b = versionOf(name, k)
							built.push(b)
							return { schema: b.schema, logins: [b.login] }
						}
					const oids: Array<ReadonlyArray<string>> = []
					const m = yield* migrated({
						label: "worlds_mig",
						schemaName: { kind: "unique" },
						first: version(h.start),
						later: Arr.map(h.later, version),
						/** The one placeholder these versions draft: the word count's conversion, from its own value. */
						apply: {
							kind: "values",
							value: () =>
								`${quoteIdent(identifierOf(identity.column(parsedName("words"))))}::bigint`
						},
						/** Each login's rename, the one name a version takes from another, declared; nothing is dropped. */
						declared: (i) => {
							const from = versions[i - 1]
							const to = defined(versions[i], "a version")
							return from !== undefined && from.login !== to.login
								? {
										renames: [
											{
												from: { kind: "login", login: parsedName(from.login) },
												to: { kind: "login", login: parsedName(to.login) }
											}
										],
										drops: []
									}
								: noDeclarations
						},
						observe: Option.some((i: number, owner: RawSession) =>
							Effect.gen(function* () {
								const b = defined(built[i], `version ${i}`)
								const found: Array<string> = []
								for (const world of [b.login, b.editor, b.viewer, b.tally]) {
									const rows = yield* owner.values(oidQuery, [roleNameOf(world, {})])
									for (const row of rows) {
										found.push(String(row[0]))
									}
								}
								oids.push(found)
							})
						)
					})
					/** Each version's login and roles are the same PostgreSQL roles. */
					const first = defined(oids[0], "the first version's roles")
					assert.equal(first.length, 4, "the first version's login and roles exist")
					for (const later of oids.slice(1)) {
						assert.deepEqual(later, first, "a login and its roles keep their OIDs")
					}
					yield* m.reapply
					const last = defined(built[built.length - 1], "the last version")
					yield* withServedDb(m, last.login.roles.editor, { sub: "u_ann" }, () => Effect.void)
					yield* withServedDb(m, last.login.roles.viewer, {}, () => Effect.void)
					const read = yield* readCatalog(
						substrate.admin,
						mapNonEmpty(m.installation.names.levels, identifierOf)
					)
					assert.ok(read.kind === "present", `the migrated schema ${m.schema} is absent`)
					assert.deepEqual(
						checkInstalled(read.catalog, installedScope(m.installation, m.snapshot)),
						[]
					)
					/** Each relation PostgreSQL stores a table of, by its table's qualified name. */
					const tabled = new Map<string, string>(
						Arr.flatMap(Rec.toEntries(m.installation.laws.owned.relations), ([name, r]) => {
							if (
								r.kind === "relation" ||
								m.installation.checked.holdings.get(name)?.kind === "stored"
							) {
								const table = m.installation.names.relation(name)
								return [[`${table.schema}.${table.name}`, name] as const]
							}
							return []
						})
					)
					const installed = Arr.flatMap(m.installation.worlds, (l) => l.roles)
					for (const { checked } of Arr.flatMap(m.installation.logins, (l) => l.roles)) {
						const name = checked.world.role.name
						const pgRole = defined(
							Option.getOrUndefined(Arr.findFirst(installed, (r) => r.name === name)),
							`the installed role ${name}`
						).role
						const rows = yield* m.owner.values(reachQuery, [pgRole])
						const reached = Arr.sort(
							Arr.flatMap(rows, (row) => {
								const relation = tabled.get(`${String(row[0])}.${String(row[1])}`)
								return relation === undefined ? [] : [relation]
							}),
							Order.String
						)
						const stored = new Set(tabled.values())
						assert.deepEqual(
							Arr.filter(readableRelations(m.installation.laws, checked), (r) => stored.has(r)),
							reached,
							`${name} reads by its grants exactly what PostgreSQL lets it read`
						)
					}
				}),
				Substrate,
				Effect.map(caseSubstrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "postgresql",
		name: "the catalog: each login's and role's OID across the versions, the runner's drift check, Db.open's admission, the installed-catalog checker, and each role's privileges and its views' dependencies"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/physical/ddl/roles.ts",
			original: "\t\t\t\tviewSchemas.set(view.schema.name, view.schema.node)\n",
			replacement:
				"\t\t\t\tfor (const w of whole.values()) {\n\t\t\t\t\tviewSchemas.set(w.schema.name, w.schema.node)\n\t\t\t\t}\n",
			why: "A role holding any relation whole is granted USAGE on every level's schema of whole views (physical/ddl/roles.ts), where it holds USAGE only on the schemas of the whole views it reads, so the viewer, who holds relations of the base alone, holds USAGE on the derived relation's level's schema of whole views: the installed-catalog checker finds it."
		},
		{
			file: "packages/engine/src/deploy/diff/declared.ts",
			original: "\tif (logins.size === 0) {",
			replacement: "\tif (logins.size >= 0) {",
			why: "A draft ignores every declared login rename, so the renamed login is a new PostgreSQL role and loses its OID."
		},
		{
			file: "packages/engine/src/physical/ddl/roles.ts",
			original: '\t\t\tentry.kind === "whole" ? [] : entry.reads.flatMap(stored)',
			replacement: '\t\t\tentry.kind === "whole" ? [] : []',
			why: "A role's query entries read nothing by its grants, so a direct writer's reads miss a relation its view of the shared notes reads (Share), and the certifier bounds it short of what PostgreSQL lets it read."
		},
		{
			file: "packages/engine/src/physical/ddl/roles.ts",
			original:
				"\treturn [...new Set([...viewed, ...grantedPrivileges(model, checked).keys()])].toSorted(",
			replacement:
				"\treturn [...new Set([...viewed, ...Object.keys(role.base.relations)])].toSorted(",
			why: "A role read as reading every relation of its base regardless of its grants (a17decc0's bound), the organizations among the editor's reads."
		},
		{
			file: "packages/engine/src/physical/ddl/roles.ts",
			original: "\t\t\t\tread.push(view.create.name)",
			replacement: "\t\t\t\tappendAll(read, [...whole.values()].map((v) => v.create.name))",
			why: "Every role is granted SELECT on every whole view, so the viewer reads the documents' whole view, which it does not hold: a read the installed-catalog checker refuses as a grant to a role not holding the relation, and the certifier's bound of the viewer misses."
		},
		{
			file: "packages/engine/src/physical/ddl/roles.ts",
			original: "\t\t\t\tviewSchemas.set(view.schema.name, view.schema.node)",
			replacement: "\t\t\t\tafter.push(view.schema.node)",
			why: "A role holds SELECT on its whole views and no USAGE on their schema of whole views, so PostgreSQL refuses every read of them (42501), which the installed-catalog checker refuses as a missing USAGE."
		}
	]
})
