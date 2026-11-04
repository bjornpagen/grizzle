import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, Order, Record as Rec } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { roleReadNames, worldNames } from "#compiler/physical/ddl/names.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	context,
	derived,
	login,
	mutable,
	on,
	relation,
	role,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { ownRole } from "#compiler/schema/own.ts"
import { roleDescOf } from "#compiler/schema/world.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import {
	fixtureWorlds,
	installed,
	installedRoleOf,
	worldsExpectation
} from "#test/pg/physical/support.ts"
import { assert, defined, succeeded, unorderedEqual } from "#test/support/assert.ts"
import {
	expectedCatalog,
	type ProjectedCatalog,
	projectCatalog
} from "#test/support/catalog/expected.ts"

import { ordinarySession } from "#test/support/ambient.ts"
import {
	checkInstalled,
	type InstalledProblem,
	installedScope
} from "#test/support/catalog/installed.ts"
import { readCatalog } from "#test/support/catalog/read.ts"
import {
	type CatalogObject,
	type ErasureProblem,
	verifyErasure
} from "#test/support/catalog/verify.ts"
import { installMigrated as install } from "#test/support/install-migrate.ts"
import { installationNamesOf, namesOf } from "#test/support/kernel/naming.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { Ledger } from "#test/unit/physical/fixtures.ts"

const Sub = str.regex("^u_[a-z]{1,8}$")
const Doc = relation("Doc", { id: uuid, org: uuid, owner: Sub, words: pg.integer }, ["id"])
const Note = relation("Note", { no: pg.bigserial, doc: uuid, author: Sub }, ["no"])
const Session = context("Session", { sub: Sub })

/**
 * The drift base under `name`: documents (mutable) and the bigserial-keyed notes on them, a note's document existing,
 * a session's subject, and the derived DocCount, each organization's documents.
 */
const driftBase = (name: string) => {
	const base = schema(name, { Doc, Note }, [
		mutable(Doc),
		contained(on(Note, "doc"), on(Doc, "id"))
	])
	const DocCount = derived(
		"DocCount",
		query(base).rule((r) => {
			const { id, org } = v(Doc, "doc")
			return r.match(Doc, { id, org }).find({ org, docs: r.count() })
		})
	)
	return schema.extend(base, { DocCount }, [])
}

/**
 * The erasure verifier and the manifest comparison catch drift: test/support/catalog finds no UPDATE grant on an
 * immutable relation and no TRUNCATE.
 *
 * Every other physical test expects the verifier to find nothing, which a verifier that accepted everything would also
 * satisfy. Here an installation is changed, one drift per transaction, by the migration identity, and the verifier must
 * name exactly that drift, and nothing for a change that confers nothing. Each transaction is rolled back, so the
 * drifts do not accumulate.
 *
 * - The Ledger fixture, with its full writer and reader: a forbidden privilege, a PUBLIC grant or default privilege, an
 *   object outside the authored scope, row-level security, a trigger that is not a law trigger, a login's grant beyond
 *   what admission reads or the lack of one, the snapshot guard's EXECUTE revoked from the login or granted to a role,
 *   a membership's options from either side, a role outside the installation that a login may SET ROLE to or inherits
 *   a privilege from (one that holds nothing, as `rds_iam`, passes), a sequence privilege, the advance function's
 *   EXECUTE and volatility, a world role's stored setting, a login's setting for one database, and a NOT VALID
 *   constraint, which the manifest comparison catches.
 * - The drift worlds, whose role writes a query entry under row security: a world function's search_path, volatility
 *   and PUBLIC EXECUTE, a query entry's view without its security barrier and a whole entry's with one, a world
 *   schema's grant, a policy whose USING and WITH CHECK differ or whose roles widen, row security disabled or forced,
 *   MAINTAIN beyond the refreshers or a refresher's missing, and a USAGE the role's writes need revoked. A policy's
 *   predicate and a view's definition are what drift compares, not the shape rules.
 *
 * The drift worlds over the drift base declared under `name`: `editor` holds Doc and DocCount
 * whole, refreshes DocCount, and writes Mine, the notes of the documents its session's subject owns, whose filter reads
 * Doc beside Note, so a filter function serves its policy; `viewer` holds DocCount whole and refreshes nothing; both in
 * the login `desk`.
 */
const driftWorlds = (name: string) => {
	const base = driftBase(name)
	const mine = query(base).rule((r) => {
		const { no, doc, author } = v(Note, "note")
		const { owner } = v(Doc, "doc")
		return r
			.match(Note, { no, doc, author })
			.match(Doc, { id: doc, owner })
			.match(Session, { sub: owner })
			.find({ no, doc, author })
	})
	const editor = role(
		base,
		"editor",
		{ Doc, DocCount: base.relations.DocCount, Mine: mine },
		{ write: ["Mine"], refresh: ["DocCount"] }
	)
	const viewer = role(base, "viewer", { DocCount: base.relations.DocCount })
	return { base, editor, viewer, desk: login(base, "desk", [editor, viewer]) }
}

/** The catalog of `schema` as the migration identity sees it after `statements`, which are then rolled back. */
const drifted = (schema: string, statements: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Substrate
			const pinned = yield* substrate.admin.pin
			yield* pinned.query("BEGIN", [])
			return yield* Effect.ensuring(
				Effect.gen(function* () {
					for (const sql of statements) {
						yield* pinned.query(sql, [])
					}
					const read = yield* readCatalog(pinned, schema)
					if (read.kind === "absent") {
						return yield* Effect.die(new Error(`the installed schema ${schema} is absent`))
					}
					return read.catalog
				}),
				Effect.ignore(pinned.query("ROLLBACK", []))
			)
		})
	)

layer(Substrate.layer)("catalog drift", (it) => {
	const fn = (name: string): CatalogObject => ({ kind: "function", name })
	it.effect(
		"the verifier names each drift exactly, and the manifest comparison a NOT VALID constraint",
		(ctx) =>
			Effect.gen(function* () {
				const worlds = fixtureWorlds(Ledger)
				const { installation, catalog, schema } = yield* installed(Ledger, "drift", [worlds.login])
				const { login, role: writer } = installedRoleOf(installation, worlds.writer)
				const reader = installedRoleOf(installation, worlds.reader).role
				const expectation = worldsExpectation(Ledger, installation, worlds)
				const database = (yield* Substrate).database
				const owner = catalog.owner
				const q = (name: string) => `${quoteIdent(schema)}.${quoteIdent(name)}`
				/** A role outside the installation, unique to this schema and created inside each rolled-back drift. */
				const outsider = `${schema}_outsider`
				const names = installationNamesOf(installation)
				const account = names.tableIdent({ name: "Account" })
				const entry = names.tableIdent({ name: "Entry" })
				const payout = names.tableIdent({ name: "Payout" })
				const relation = (name: string): CatalogObject => ({ kind: "relation", name })
				const currency = Option.getOrThrowWith(
					Rec.get(installation.closedTemplates, "Currency"),
					() => new Error("Ledger's Currency enum")
				).enum.name
				/** Entry's serial field: its identity sequence and its advance function. */
				const entryId = `${entry}.${names.columnIdent({ name: "Entry" }, "id")}`
				const entrySequence = Option.getOrThrowWith(
					Arr.findFirst(catalog.sequences, (s) => s.ownedBy === entryId),
					() => new Error(`the identity sequence of ${entryId}`)
				).name
				const sequence: CatalogObject = { kind: "sequence", name: entrySequence }
				const entryAdvance = installation.names.advance("Entry", "id").name
				/** The structural text domain typing Account's code. */
				const codeDomain = names.textDomain({ name: "Account" }, "code").domain
				/** The snapshot guard, which every login and no role executes. */
				const snapshotGuard = identifierOf(identity.snapshotGuard())
				assert.deepEqual(verifyErasure(catalog, expectation), [])
				const drifts: Arr.NonEmptyReadonlyArray<
					readonly [ReadonlyArray<string>, ReadonlyArray<ErasureProblem>]
				> = [
					[
						[`GRANT UPDATE ON ${q(account)} TO ${quoteIdent(writer)}`],
						[{ kind: "immutableUpdate", object: relation(account), grantee: writer }]
					],
					[
						[`GRANT TRUNCATE ON ${q(entry)} TO ${quoteIdent(writer)}`],
						[
							{ kind: "roleHolds", object: relation(entry), role: writer, privilege: "TRUNCATE" },
							{ kind: "truncate", relation: entry, grantee: writer }
						]
					],
					[
						[`GRANT USAGE ON TYPE ${q(currency)} TO PUBLIC`],
						[{ kind: "publicHolds", object: { kind: "enum", name: currency }, privilege: "USAGE" }]
					],
					[
						[`GRANT USAGE ON TYPE ${q(codeDomain)} TO PUBLIC`],
						[
							{
								kind: "publicHolds",
								object: { kind: "domain", name: codeDomain },
								privilege: "USAGE"
							}
						]
					],
					[
						[`GRANT SELECT ON ${q(payout)} TO PUBLIC`],
						[{ kind: "publicHolds", object: relation(payout), privilege: "SELECT" }]
					],
					[
						[`GRANT USAGE ON SEQUENCE ${q(entrySequence)} TO PUBLIC`],
						[{ kind: "publicHolds", object: sequence, privilege: "USAGE" }]
					],
					[
						[`GRANT CREATE ON SCHEMA ${quoteIdent(schema)} TO PUBLIC`],
						[{ kind: "publicHolds", object: { kind: "schema", name: schema }, privilege: "CREATE" }]
					],
					[
						[
							`ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdent(owner)} GRANT EXECUTE ON FUNCTIONS TO PUBLIC`
						],
						[{ kind: "defaultAclMissing", objectType: "f" }]
					],
					[
						[
							`ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdent(owner)} IN SCHEMA ${quoteIdent(schema)} GRANT SELECT ON TABLES TO PUBLIC`
						],
						[
							{
								kind: "defaultAclPublic",
								schema: Option.some(schema),
								objectType: "r",
								privilege: "SELECT"
							}
						]
					],
					[
						[`CREATE TABLE ${q("extra")} ("a" bigint NOT NULL)`],
						[{ kind: "unexpectedTable", table: "extra" }]
					],
					[
						[`ALTER TABLE ${q(account)} ENABLE ROW LEVEL SECURITY`],
						[{ kind: "rowSecurityUnneeded", table: account }]
					],
					[
						[
							`CREATE TRIGGER "audit" BEFORE UPDATE ON ${q(entry)} FOR EACH ROW EXECUTE FUNCTION pg_catalog.suppress_redundant_updates_trigger()`
						],
						[
							{ kind: "foreignTrigger", trigger: "audit", table: entry },
							{ kind: "triggerNotDeferred", trigger: "audit", table: entry }
						]
					],
					[[`ALTER ROLE ${quoteIdent(writer)} CREATEDB`], [{ kind: "elevated", role: writer }]],
					[
						[`GRANT SELECT ON ${q(entry)} TO ${quoteIdent(login)}`],
						[{ kind: "loginHolds", object: relation(entry), login, privilege: "SELECT" }]
					],
					[
						[`REVOKE USAGE ON SCHEMA ${quoteIdent(schema)} FROM ${quoteIdent(login)}`],
						[
							{
								kind: "loginLacks",
								object: { kind: "schema", name: schema },
								login,
								privilege: "USAGE"
							}
						]
					],
					[
						[`REVOKE EXECUTE ON FUNCTION ${q(snapshotGuard)}(text) FROM ${quoteIdent(login)}`],
						[{ kind: "loginLacks", object: fn(snapshotGuard), login, privilege: "EXECUTE" }]
					],
					[
						[`GRANT EXECUTE ON FUNCTION ${q(snapshotGuard)}(text) TO ${quoteIdent(writer)}`],
						[{ kind: "roleHolds", object: fn(snapshotGuard), role: writer, privilege: "EXECUTE" }]
					],
					[
						[`GRANT ${quoteIdent(writer)} TO ${quoteIdent(login)} WITH ADMIN TRUE`],
						[
							{
								kind: "membershipOptions",
								role: login,
								side: "memberOf",
								membership: { role: writer, inherit: false, set: true, admin: true }
							},
							{
								kind: "membershipOptions",
								role: writer,
								side: "members",
								membership: { role: login, inherit: false, set: true, admin: true }
							}
						]
					],
					[
						[`GRANT ${quoteIdent(writer)} TO ${quoteIdent(reader)} WITH INHERIT FALSE, SET TRUE`],
						[
							{
								kind: "membershipBeyond",
								role: reader,
								side: "memberOf",
								membership: { role: writer, inherit: false, set: true, admin: false }
							},
							{
								kind: "membershipBeyond",
								role: writer,
								side: "members",
								membership: { role: reader, inherit: false, set: true, admin: false }
							}
						]
					],
					[
						[
							`CREATE ROLE ${quoteIdent(outsider)} NOLOGIN`,
							`GRANT ${quoteIdent(login)} TO ${quoteIdent(outsider)} WITH INHERIT FALSE, SET FALSE`
						],
						[]
					],
					[
						[
							`CREATE ROLE ${quoteIdent(outsider)} NOLOGIN`,
							`GRANT ${quoteIdent(login)} TO ${quoteIdent(outsider)} WITH INHERIT FALSE, SET TRUE`
						],
						[
							{
								kind: "membershipBeyond",
								role: login,
								side: "members",
								membership: { role: outsider, inherit: false, set: true, admin: false }
							}
						]
					],
					[
						[
							`CREATE ROLE ${quoteIdent(outsider)} NOLOGIN`,
							`GRANT ${quoteIdent(outsider)} TO ${quoteIdent(login)} WITH INHERIT TRUE, SET FALSE`
						],
						[]
					],
					[
						[
							`CREATE ROLE ${quoteIdent(outsider)} NOLOGIN`,
							`GRANT ${quoteIdent(outsider)} TO ${quoteIdent(login)} WITH INHERIT FALSE, SET TRUE`
						],
						[
							{
								kind: "membershipBeyond",
								role: login,
								side: "memberOf",
								membership: { role: outsider, inherit: false, set: true, admin: false }
							}
						]
					],
					[
						[
							`CREATE ROLE ${quoteIdent(outsider)} NOLOGIN`,
							`GRANT SELECT ON ${q(entry)} TO ${quoteIdent(outsider)}`,
							`GRANT ${quoteIdent(outsider)} TO ${quoteIdent(login)} WITH INHERIT TRUE, SET FALSE`
						],
						[
							{
								kind: "strangerHolds",
								object: relation(entry),
								grantee: outsider,
								privilege: "SELECT"
							},
							{
								kind: "inheritsPrivilege",
								role: login,
								from: outsider,
								object: relation(entry),
								privilege: "SELECT"
							}
						]
					],
					[
						[
							`CREATE ROLE ${quoteIdent(outsider)} NOLOGIN`,
							`GRANT ${quoteIdent(writer)} TO ${quoteIdent(outsider)} WITH INHERIT FALSE, SET FALSE`
						],
						[]
					],
					[
						[`GRANT SELECT ON SEQUENCE ${q(entrySequence)} TO ${quoteIdent(writer)}`],
						[{ kind: "roleHolds", object: sequence, role: writer, privilege: "SELECT" }]
					],
					[
						[`REVOKE EXECUTE ON FUNCTION ${q(entryAdvance)} FROM ${quoteIdent(writer)}`],
						[{ kind: "insertWithoutAdvance", function: entryAdvance, role: writer, table: entry }]
					],
					[
						[`GRANT EXECUTE ON FUNCTION ${q(entryAdvance)} TO ${quoteIdent(reader)}`],
						[{ kind: "advanceWithoutInsert", function: entryAdvance, role: reader, table: entry }]
					],
					[
						[`ALTER FUNCTION ${q(entryAdvance)} STABLE`],
						[{ kind: "volatility", function: entryAdvance, required: "VOLATILE" }]
					],
					[
						[`ALTER ROLE ${quoteIdent(writer)} SET work_mem = '8MB'`],
						[{ kind: "worldRoleSetting", role: writer, setting: "work_mem=8MB" }]
					],
					[
						[
							`ALTER ROLE ${quoteIdent(login)} IN DATABASE ${quoteIdent(database)} SET work_mem = '8MB'`
						],
						[{ kind: "loginDatabaseSetting", role: login, setting: "work_mem=8MB" }]
					]
				]
				yield* searched(
					ctx,
					exhaust(
						{
							suite: "physical/verify/erasure drifts",
							generator: element(drifts),
							literal: Formatter.format,
							limit: drifts.length,
							coverage: noCoverage,
							caseHang: Duration.minutes(2)
						},
						([statements, expected]) =>
							Effect.map(drifted(schema, statements), (after) =>
								unorderedEqual(
									verifyErasure(after, expectation),
									expected,
									Arr.join(statements, "; ")
								)
							)
					)
				)
				/** Every drift above was rolled back. */
				const restored = yield* readCatalog((yield* Substrate).admin, schema)
				if (restored.kind === "absent") {
					return yield* Effect.die(new Error(`the installed schema ${schema} is absent`))
				}
				assert.deepEqual(verifyErasure(restored.catalog, expectation), [])

				/**
				 * A foreign key re-added NOT VALID: the verifier's shape rules hold, and the manifest comparison
				 * refuses it.
				 */
				const fk = Option.getOrThrowWith(
					Option.flatMap(
						Arr.findFirst(catalog.tables, (t) => t.name === entry),
						(t) =>
							Arr.findFirst(
								t.constraints,
								(k) => k.type === "f" && Option.contains(k.references, account)
							)
					),
					() => new Error("Ledger: no foreign key from Entry to Account")
				)
				const after = yield* drifted(schema, [
					`ALTER TABLE ${q(entry)} DROP CONSTRAINT ${quoteIdent(fk.name)}`,
					`ALTER TABLE ${q(entry)} ADD CONSTRAINT ${quoteIdent(fk.name)} ${fk.definition} NOT VALID`
				])
				const expected = expectedCatalog(installation)
				assert.deepEqual(projectCatalog(catalog), expected)
				const project = projectCatalog(after)
				assert.notDeepEqual(project, expected)
				const constraintsOf = (c: ProjectedCatalog) =>
					Option.getOrThrowWith(
						Arr.findFirst(c.tables, (t) => t.name === entry),
						() => new Error(`the projected table ${entry}`)
					).constraints
				const reAdded = constraintsOf(project)
				assert.deepEqual(
					Arr.map(
						Arr.filter(reAdded, (k) => k.name === fk.name),
						(k) => k.validated
					),
					[false]
				)
				assert.deepEqual(
					constraintsOf(expected),
					Arr.map(reAdded, (k) => (k.name === fk.name ? { ...k, validated: true } : k))
				)
			}),
		120_000
	)

	it.effect(
		"the verifier names each drift of a world written under row security",
		(ctx) =>
			Effect.scoped(
				Effect.gen(function* () {
					const declared = driftWorlds("Drift")
					const installed = yield* install(declared.base, {
						ambient: ordinarySession,
						label: "drift",
						logins: [declared.desk],
						extensions: []
					})
					const opened = driftWorlds(installed.declared)
					const schema = installed.schema
					const q = (name: string) => `${quoteIdent(schema)}.${quoteIdent(name)}`
					const editor = installed.role(opened.editor)
					const viewer = installed.role(opened.viewer)
					const desk = installed.world(opened.editor).login.role
					const names = namesOf(installed)
					const ownedEditor = succeeded(
						ownRole(defined(roleDescOf(opened.editor), "the editor's description"))
					)
					const world = worldNames(ownedEditor, installed.installation.names.installation)
					const filter = world.filterFunction("Mine", []).name
					const probe = world.keyProbe("Mine", ["no"], []).name
					const view = roleReadNames(installed.installation.names, ownedEditor).relation("Mine")
					const docView = roleReadNames(installed.installation.names, ownedEditor).relation("Doc")
					const note = names.tableIdent(Note)
					const docCount = names.tableIdent(opened.base.relations.DocCount)
					const advance = installed.installation.names.advance("Note", "no").name
					const noteNo = `${note}.${names.columnIdent(Note, "no")}`
					const scope = installedScope(installed.installation, installed.snapshot)
					const baseline = yield* drifted(schema, [])
					const sequence = Option.getOrThrowWith(
						Arr.findFirst(baseline.sequences, (s) => s.ownedBy === noteNo),
						() => new Error(`the identity sequence of ${noteNo}`)
					).name
					const sub = names.textDomain(Note, "author").domain
					assert.deepEqual(checkInstalled(baseline, scope), [])
					const drifts: Arr.NonEmptyReadonlyArray<
						readonly [ReadonlyArray<string>, ReadonlyArray<InstalledProblem>]
					> = [
						[
							[`ALTER FUNCTION ${q(filter)} RESET search_path`],
							[{ kind: "searchPathUnfixed", function: filter }]
						],
						[
							[`ALTER FUNCTION ${q(filter)} VOLATILE`],
							[{ kind: "volatility", function: filter, required: "STABLE" }]
						],
						[
							[`GRANT EXECUTE ON FUNCTION ${q(filter)} TO PUBLIC`],
							[{ kind: "publicHolds", object: fn(filter), privilege: "EXECUTE" }]
						],
						[
							[`GRANT EXECUTE ON FUNCTION ${q(probe)} TO PUBLIC`],
							[{ kind: "publicHolds", object: fn(probe), privilege: "EXECUTE" }]
						],
						[
							[`GRANT EXECUTE ON FUNCTION ${q(probe)} TO ${quoteIdent(viewer)}`],
							[
								{
									kind: "worldFunctionExecutors",
									function: probe,
									executors: Arr.sort([editor, viewer], Order.String)
								}
							]
						],
						[
							[
								`ALTER VIEW ${quoteIdent(view.schema)}.${quoteIdent(view.name)} SET (security_barrier = false)`
							],
							[{ kind: "barrierMissing", world: view.schema, view: view.name }]
						],
						[
							[
								`ALTER VIEW ${quoteIdent(docView.schema)}.${quoteIdent(docView.name)} SET (security_barrier = true)`
							],
							[{ kind: "barrierUnneeded", world: docView.schema, view: docView.name }]
						],
						[
							[`GRANT USAGE ON SCHEMA ${quoteIdent(view.schema)} TO ${quoteIdent(desk)}`],
							[
								{
									kind: "strayWorldGrant",
									object: { kind: "world", name: view.schema },
									grantee: desk,
									privilege: "USAGE"
								}
							]
						],
						[
							[`ALTER POLICY ${quoteIdent(editor)} ON ${q(note)} USING (true)`],
							[{ kind: "policyPredicates", policy: editor, table: note }]
						],
						[
							[`ALTER POLICY ${quoteIdent(editor)} ON ${q(note)} TO PUBLIC`],
							[{ kind: "policyRoles", policy: editor, table: note, roles: ["PUBLIC"] }]
						],
						[
							[`ALTER TABLE ${q(note)} DISABLE ROW LEVEL SECURITY`],
							[{ kind: "rowSecurityMissing", table: note }]
						],
						[
							[`ALTER TABLE ${q(note)} FORCE ROW LEVEL SECURITY`],
							[{ kind: "rowSecurityForced", table: note }]
						],
						[
							[`GRANT MAINTAIN ON ${q(docCount)} TO ${quoteIdent(viewer)}`],
							[{ kind: "maintainBeyondRefresh", view: docCount, grantee: viewer }]
						],
						[
							[`REVOKE MAINTAIN ON ${q(docCount)} FROM ${quoteIdent(editor)}`],
							[{ kind: "maintainMissing", view: docCount, role: editor }]
						],
						[
							[`GRANT SELECT ON SEQUENCE ${q(sequence)} TO ${quoteIdent(editor)}`],
							[
								{
									kind: "roleHolds",
									object: { kind: "sequence", name: sequence },
									role: editor,
									privilege: "SELECT"
								}
							]
						],
						[
							[`REVOKE EXECUTE ON FUNCTION ${q(advance)} FROM ${quoteIdent(editor)}`],
							[{ kind: "insertWithoutAdvance", function: advance, role: editor, table: note }]
						],
						[
							[`REVOKE USAGE ON DOMAIN ${q(sub)} FROM ${quoteIdent(editor)}`],
							[{ kind: "usageMissing", role: editor, type: { kind: "domain", name: sub } }]
						]
					]
					yield* searched(
						ctx,
						exhaust(
							{
								suite: "physical/verify/world drifts",
								generator: element(drifts),
								literal: Formatter.format,
								limit: drifts.length,
								coverage: noCoverage,
								caseHang: Duration.minutes(2)
							},
							([statements, expected]) =>
								Effect.map(drifted(schema, statements), (after) =>
									unorderedEqual(checkInstalled(after, scope), expected, Arr.join(statements, "; "))
								)
						)
					)
				})
			),
		120_000
	)
})
