/**
 * Worlds across migrations on PostgreSQL 19: each case draws a starting version of a schema with worlds and a history
 * of one or two later versions, each turning a drawn set of the knobs a world rests on, and migrates through its
 * generated, reviewed folders (`migrated`: each drafted under the renames its version declares, applied by the real
 * runner, which drift-checks the catalog it reaches). The oracle is PostgreSQL's catalog: each login's and role's OID,
 * the drift check, Db.open's admission and the installed-catalog checker.
 *
 * The schema: documents of organizations on a tier (a roster, whose closed ids are smallint codes), each with a word
 * count and a cap (a contract), their shares and their notes (a serial field), and a derived relation over the
 * documents' word counts. Two contexts are read: the session's subject, and a quota whose cap is the contract. `editor`
 * holds the documents and the derived relation whole, refreshes it, reads Capped (the documents at the quota's cap) and
 * writes Mine, its notes under row security; `viewer` holds the organizations, the tier and the derived relation whole.
 * Both are of one login.
 *
 * The knobs, each a change a world rests on when it turns:
 * - a read query entry's head;
 * - a written entry's policy filter, among the notes of documents the subject owns, of documents shared with it, and
 *   its own, so a filter function reads another relation or stops reading one;
 * - a context's contract, the cap's least value, raised or lowered;
 * - the login's name, declared renamed (`--rename @desk=@counter`, and back);
 * - the tier's roster grown by a handle, a new names constant and roster domain under the viewer's view of the
 *   organizations, which decodes each organization's tier through the names constant;
 * - the word count retyped from integer to bigint, a column under the derived relation, whose materialized view goes and
 *   comes back, and under the editor's view of the documents.
 * A roster only grows and the word count only widens: a shrunk roster or a narrowed column is a declared drop or a data
 * step, which is another suite's.
 *
 * Properties, for every history:
 * - each folder applies and the drift check admits the catalog it reaches: every world object reading what changed was
 *   dropped before the change and created after it, in the same transaction;
 * - Db.open admits every role at the last snapshot;
 * - the installed-catalog checker finds nothing;
 * - no migration recreates a login or a role: each keeps its OID across the versions, so a password and what other
 *   roles were granted survive, a renamed login included.
 *
 * Features: each knob's turn, the login renamed back, several knobs at once and a history of two migrations, each a
 * steered case constructs while it is pending: a start where the knob turns, and the turn.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { roleNameOf } from "#adapter/served/served.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
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
import { assert, defined } from "#test/support/assert.ts"
import { checkInstalled, installedScope } from "#test/support/catalog/installed.ts"
import { readCatalog } from "#test/support/catalog/read.ts"
import { migrated, type Version } from "#test/support/installed.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { withServedDb } from "#test/support/served-db.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Worlds across migrations every history of the changes a world rests on migrates with its roles kept and its catalog admitted. */
export const worlds = property.explore(aimed(historyGen, aims), {
	needs: { caseSubstrate: Substrate.installing },
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
								for (const world of [b.login, b.editor, b.viewer]) {
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
					assert.equal(first.length, 3, "the first version's login and roles exist")
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
				}),
				Substrate,
				caseSubstrate
			),
	oracle: {
		kind: "postgresql",
		name: "the catalog: each login's and role's OID across the versions, the runner's drift check, Db.open's admission and the installed-catalog checker"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/deploy/diff/declared.ts",
			original: "\tif (logins.size === 0) {",
			replacement: "\tif (logins.size >= 0) {",
			why: "A draft ignores every declared login rename, so the renamed login is a new PostgreSQL role and loses its OID."
		}
	]
})
