/**
 * Row security across migrations on PostgreSQL 19, over Note and Card, each an id and a shelf, and two roles, clerk and
 * keeper, in one login. A case draws two or three versions; in each, each role holds each relation whole or through a
 * query entry whose filter fixes the shelf at a drawn value, and writes it or not. Each version's folder is generated,
 * reviewed and applied by the real runner, which drift-checks the catalog it reaches (`migrated`).
 *
 * The model, read from the catalog after each migration: a table has row security exactly when some writer of it writes
 * it through a narrowed entry, and then holds exactly one policy per writer of it, the narrowed writer's its entry's
 * membership and a whole writer's TRUE, since under row security a role with no policy writes nothing; a table no writer
 * narrows has neither row security nor a policy, the migration dropping both where an earlier version had them. At the
 * last version both roles open, and the installed-catalog checker finds nothing. Then a drawn change by hand, row
 * security disabled or forced on every table under it: both roles still open, since Db.open checks nothing of the
 * database, and the drift check grizzle migrate runs refuses exactly a catalog with a changed table, naming each.
 *
 * Features: a narrowed writer beside a whole one, a narrowed reader that writes nothing, row security added and dropped,
 * a narrowed writer's filter changed, and each hand change drifted or none.
 */

import { assert, assertVariant, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order, String as Str } from "effect"
import { Drifted } from "#adapter/migrate/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import {
	type Built,
	caseGen,
	expectedAt,
	featuresOf,
	type PolicySeen,
	type RelationName,
	roleNames,
	type RowSecurityFeature,
	secureds,
	type Seen,
	type Uses,
	versionOf
} from "#test/pg/physical/row-security.fixtures.ts"
import { checkInstalled, installedScope } from "#test/support/catalog/installed.ts"
import { readCatalog, readCatalogWith } from "#test/support/catalog/read.ts"
import { migrated, type Version } from "#test/support/installed.ts"
import { namesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { withServedDb } from "#test/support/served-db.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Row security across migrations a table has row security and every writer's policy exactly while some writer narrows it, across migrations, and Db.open refuses a narrowed writer of a table whose row security a hand changed.
 *
 * Its pre-conversion budget: runs 6, coverage cases 12 (test/pg/physical/row-security.test.ts at d8eed1786).
 */
export const rowSecurityAcrossMigrationsATableHasRowSecurityAndEveryWritersPolicyExactlyWhileSomeWriterNarrowsItAcrossMigrationsAndDbOpenRefusesANarrowedWriterOfATableWhoseRowSecurityAHandChanged =
	property.explore(caseGen, {
		needs: { substrate2: Substrate.installing },
		situations: [
			"a narrowed writer beside a whole one",
			"a narrowed reader that writes nothing",
			"row security added",
			"row security dropped",
			"a narrowed writer's filter changed",
			"a changed table drifted, row security disabled",
			"a changed table drifted, row security forced",
			"no table changed"
		] satisfies ReadonlyArray<Reached<RowSecurityFeature>>,
		check:
			({ substrate2 }, k: Case<RowSecurityFeature>) =>
			({ history, planted }) =>
				Effect.provideServiceEffect(
					Effect.scoped(
						Effect.gen(function* () {
							k.noteAll(featuresOf(history))
							const substrate = yield* Substrate
							const built: Array<Built> = []
							const version =
								(uses: Uses) =>
								(name: string): Version => {
									const b = versionOf(name, uses)
									built.push(b)
									return { schema: b.schema, logins: [b.login] }
								}
							const seen: Array<Seen> = []
							const [first, ...later] = Arr.map(history, version)
							const m = yield* migrated({
								label: "row_security",
								schemaName: { kind: "unique" },
								first,
								later,
								apply: { kind: "noPlaceholders" },
								declared: () => noDeclarations,
								observe: Option.some((i: number, owner: RawSession) =>
									Effect.gen(function* () {
										const b = defined(built[i], `version ${i}`)
										const installed = identifierOf(identity.schema(parsedSchemaName(b.declared)))
										const read = yield* readCatalogWith(
											(sql, params) => owner.values(sql, params),
											[installed]
										)
										assert.ok(read.kind === "present", `the migrated schema ${installed} is absent`)
										seen.push({
											rowSecure: Arr.sort(
												Arr.flatMap(read.catalog.tables, (t): ReadonlyArray<string> =>
													t.rowSecurity ? [t.name] : []
												),
												Order.String
											),
											policies: Arr.map(read.catalog.policies, (p): PolicySeen => ({
												table: p.table,
												roles: p.roles,
												holds:
													Option.exists(p.using, (u) => u === "true") &&
													Option.exists(p.check, (c) => c === "true")
														? "every row"
														: "narrowed"
											}))
										})
									})
								)
							})
							const last = defined(built[built.length - 1], "the last version")
							const names = namesOf(m)
							const tableOf = (r: RelationName): string =>
								names.tableIdent(r === "Note" ? last.Note : last.Card)
							assert.equal(seen.length, history.length, "a reading after each migration")
							for (const [i, uses] of history.entries()) {
								const b = defined(built[i], `version ${i}`)
								const at = defined(seen[i], `the reading of version ${i}`)
								const want = expectedAt(uses, b, tableOf)
								assert.deepEqual(
									at.rowSecure,
									want.rowSecure,
									`the tables under row security at ${i}`
								)
								unorderedEqual(at.policies, want.policies, `the policies at ${i}`)
							}
							yield* m.reapply
							yield* withServedDb(m, last.login.roles.clerk, {}, () => Effect.void)
							yield* withServedDb(m, last.login.roles.keeper, {}, () => Effect.void)
							const read = yield* readCatalog(substrate.admin, [m.schema])
							assert.ok(read.kind === "present", `the migrated schema ${m.schema} is absent`)
							assert.deepEqual(
								checkInstalled(read.catalog, installedScope(m.installation, m.snapshot)),
								[]
							)
							const lastUses = Arr.lastNonEmpty(history)
							const changed = secureds(lastUses)
							for (const r of changed) {
								yield* substrate.admin.query(
									`ALTER TABLE ${quoteIdent(m.schema)}.${quoteIdent(tableOf(r))} ${planted === "disabled" ? "DISABLE" : "FORCE"} ROW LEVEL SECURITY`,
									[]
								)
							}
							for (const who of roleNames) {
								yield* withServedDb(
									m,
									who === "clerk" ? last.login.roles.clerk : last.login.roles.keeper,
									{},
									() => Effect.void
								)
							}
							const drift = yield* Effect.result(m.reapply)
							if (!Arr.isReadonlyArrayNonEmpty(changed)) {
								assertVariant(drift, "_tag", "Success", "drift admits the unchanged catalog")
								k.note("no table changed")
								return
							}
							assertVariant(drift, "_tag", "Failure", "drift refuses the changed tables")
							const reason = drift.failure.reason
							assert.ok(reason instanceof Drifted)
							const facts = Arr.map(reason.mismatches, (d) => d.fact)
							for (const r of changed) {
								assert.ok(
									Arr.some(facts, (f) => Str.includes(tableOf(r))(f)),
									`drift names the changed table ${tableOf(r)}: ${Arr.join(facts, "; ")}`
								)
							}
							k.note(`a changed table drifted, row security ${planted}`)
						})
					),
					Substrate,
					substrate2
				),
		oracle: {
			kind: "specification",
			name: "row security exactly where a writer narrows, one policy per writer there, read from the catalog after each migration; the drift check, refusing exactly a catalog whose row security was changed by hand"
		},
		budget: { runs: 6, steered: 12 },
		kept: [],
		kills: []
	})
