/**
 * The catalog verifiers against drift on PostgreSQL 19: the erasure verifier (test/support/catalog/verify.ts), the
 * installed checker (test/support/catalog/installed.ts) and the manifest projection (test/support/catalog/expected.ts),
 * which every other physical suite expects to find nothing, so a verifier that accepted everything would pass them all.
 * Each drift is made in a transaction rolled back, so drifts never accumulate (the drift worlds' JSDoc below states
 * them).
 *
 * - Erasure drifts and world drifts: each drawn drift is named exactly as its rule states, and one that confers nothing
 *   is named by nothing.
 * - Not valid: every foreign key re-added NOT VALID is caught by the manifest comparison alone, exhausted over the
 *   installation's foreign keys.
 *
 * Oracle: each rule as its specification states it, over targets drawn from the installation's own catalog and
 * expectation.
 *
 * Features: each drift kind, named and conferring nothing, and each foreign key.
 *
 * Plants (~/.cache/grizzle-release/BR11/plants): verify-public-unjudged (the erasure verifier names no privilege PUBLIC
 * holds), verify-not-valid-unread (the projection reads every constraint as validated) and verify-barrier-unjudged (no
 * view's security barrier is judged).
 */
import { layer } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, type Gen, int, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec } from "effect"
import { identifierOf } from "#compiler/core/identity.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import { type PrivilegeFamily, privilegeFamilies } from "#compiler/deploy/admission/roles.ts"
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
import type { ObjectName } from "#compiler/sql/ast.ts"
import { printObjectName, quoteIdent } from "#compiler/sql/print.ts"
import {
	fixtureWorlds,
	installed,
	installedRoleOf,
	worldsExpectation
} from "#test/pg/physical/support.ts"
import { assert, deepEquals, defined, nonEmpty } from "#test/support/assert.ts"
import { expectedCatalog, projectCatalog } from "#test/support/catalog/expected.ts"

import { ordinarySession } from "#test/support/ambient.ts"
import {
	checkInstalled,
	type InstalledProblem,
	installedScope
} from "#test/support/catalog/installed.ts"
import { type Catalog, type CatalogGrant, readCatalog } from "#test/support/catalog/read.ts"
import {
	type CatalogObject,
	type ErasureProblem,
	verifyErasure
} from "#test/support/catalog/verify.ts"
import { installMigrated as install } from "#test/support/install-migrate.ts"
import { caseHang } from "#test/support/limits.ts"
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
	const DocCount = derived.materialized(
		"DocCount",
		query(base).rule((r) => {
			const { id, org } = v(Doc, "doc")
			return r.match(Doc, { id, org }).find({ org, docs: r.count() })
		})
	)
	return schema.extend(base, `${name}_1`, { DocCount }, [])
}

/**
 * The erasure verifier and the installed checker catch drift: every other physical test expects them to find nothing,
 * which a verifier that accepted everything would also satisfy. A case draws one drift of an installation, made by the
 * migration identity in a transaction that is rolled back, so drifts never accumulate, and the verifier must name the
 * problem the drift's rule states, and nothing at all for a drift that confers nothing. The oracle is each rule as its
 * specification states it, over targets drawn from the installation's own catalog and expectation: the objects a GRANT
 * names, with the privileges PostgreSQL defines on each (deploy/admission/roles.ts privilegeFamilies), the roles, the
 * functions, views, policies and tables.
 *
 * - The Ledger fixture, with its full writer and reader: any privilege granted to PUBLIC or to a role outside the
 *   installation; one granted to the login that it lacks, or one of its own revoked; a grant already held, granted
 *   again (nothing); an elevated attribute; a trigger that is not a law trigger; row security enabled or forced; a
 *   world role's setting or the login's for one database; an unexpected table; a PUBLIC default privilege; a
 *   membership between a declared role and a stranger, either way, with drawn options (nothing when it lets no one SET
 *   ROLE, administer or inherit through it); an advance function's volatility. Every foreign key re-added NOT VALID
 *   keeps the verifier's shape rules and is caught by the manifest comparison alone (an exhaustion of the catalog's
 *   foreign keys).
 * - The drift worlds, whose role writes a query entry under row security: a world function's search_path reset, its
 *   volatility, its EXECUTE to PUBLIC or to a second role; a view's security barrier flipped (nothing when set as it
 *   stands); a world schema's USAGE beyond its role; a policy's predicate or roles; row security disabled or forced;
 *   MAINTAIN beyond the refreshers or a refresher's revoked; a sequence privilege to a world role; and an advance
 *   function's EXECUTE revoked from a role that inserts.
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

/**
 * The catalog of the installation whose level schemas are `schemas` (the root's first), as the migration identity sees
 * it after `statements`, which are then rolled back.
 */
const drifted = (schemas: Arr.NonEmptyReadonlyArray<string>, statements: ReadonlyArray<string>) =>
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
					const read = yield* readCatalog(pinned, schemas)
					if (read.kind === "absent") {
						return yield* Effect.die(new Error(`the installed schema ${schemas[0]} is absent`))
					}
					return read.catalog
				}),
				Effect.ignore(pinned.query("ROLLBACK", []))
			)
		})
	)

/** A drift: the statements that make it, the problems its rule states (none for a drift that confers nothing), and
 * the feature it reaches. */
interface Drift<P, F extends string> {
	readonly statements: Arr.NonEmptyReadonlyArray<string>
	readonly raises: ReadonlyArray<P>
	readonly feature: F
}

/** The verifier's problems hold every one a drift raises, and are none for a drift that raises none. */
const named = <P, F extends string>(problems: ReadonlyArray<P>, drift: Drift<P, F>): void => {
	const why = Arr.join(drift.statements, "; ")
	if (!Arr.isReadonlyArrayNonEmpty(drift.raises)) {
		assert.deepEqual(problems, [], why)
		return
	}
	for (const raised of drift.raises) {
		assert.ok(
			Arr.some(problems, (p) => deepEquals(p, raised)),
			`${why}: ${Formatter.format(raised)} among ${Formatter.format(problems)}`
		)
	}
}

/** An object of the base schema a GRANT names: its privilege family, its name in a GRANT, the object a problem names,
 * and its grants. */
interface Grantable {
	readonly family: PrivilegeFamily
	readonly target: string
	readonly object: CatalogObject
	readonly grants: ReadonlyArray<CatalogGrant>
}

/** A schema-qualified, quoted name of the catalog's schema. */
const qualified = (catalog: Catalog, name: string): string =>
	`${quoteIdent(catalog.schema)}.${quoteIdent(name)}`

/** A function as ALTER FUNCTION and GRANT name it: qualified, with its identity arguments. */
const signature = (catalog: Catalog, f: Catalog["functions"][number]): string =>
	`${qualified(catalog, f.name)}(${f.args})`

/** Every object of the base schema a GRANT names, read from its catalog. */
const grantablesOf = (catalog: Catalog): Arr.NonEmptyReadonlyArray<Grantable> => [
	{
		family: "schema",
		target: `SCHEMA ${quoteIdent(catalog.schema)}`,
		object: { kind: "schema", name: catalog.schema },
		grants: catalog.schemaGrants
	},
	...Arr.map(catalog.tables, (t): Grantable => ({
		family: "table",
		target: `TABLE ${qualified(catalog, t.name)}`,
		object: { kind: "relation", name: t.name },
		grants: t.grants
	})),
	...Arr.map(catalog.sequences, (q): Grantable => ({
		family: "sequence",
		target: `SEQUENCE ${qualified(catalog, q.name)}`,
		object: { kind: "sequence", name: q.name },
		grants: q.grants
	})),
	...Arr.map(catalog.domains, (d): Grantable => ({
		family: "type",
		target: `DOMAIN ${qualified(catalog, d.name)}`,
		object: { kind: "domain", name: d.name },
		grants: d.grants
	})),
	...Arr.map(catalog.functions, (f): Grantable => ({
		family: "function",
		target: `FUNCTION ${signature(catalog, f)}`,
		object: { kind: "function", name: f.name },
		grants: f.grants
	}))
]

/** A privilege PostgreSQL defines on objects of a family. */
const privilegeOf = (family: PrivilegeFamily): Gen<string> =>
	element(nonEmpty(privilegeFamilies[family], `the privileges of ${family}`))

/** Whether `grantee` holds `privilege` among `grants`. */
const holds = (grants: ReadonlyArray<CatalogGrant>, grantee: string, privilege: string): boolean =>
	Arr.some(grants, (g) => g.grantee === grantee && g.privilege === privilege)

type ErasureFeature =
	| "PUBLIC granted a privilege"
	| "a stranger granted a privilege"
	| "the login granted a privilege it lacks"
	| "the login's privilege revoked"
	| "a held grant granted again"
	| "an elevated attribute"
	| "a foreign trigger"
	| "row security enabled"
	| "row security forced"
	| "a world role's setting"
	| "the login's database setting"
	| "an unexpected table"
	| "a PUBLIC default privilege"
	| "a stranger's membership that confers"
	| "a stranger's inert membership"
	| "an advance function's volatility changed"
	| "an advance function left volatile"

const erasureFeatures: Arr.NonEmptyReadonlyArray<ErasureFeature> = [
	"PUBLIC granted a privilege",
	"a stranger granted a privilege",
	"the login granted a privilege it lacks",
	"the login's privilege revoked",
	"a held grant granted again",
	"an elevated attribute",
	"a foreign trigger",
	"row security enabled",
	"row security forced",
	"a world role's setting",
	"the login's database setting",
	"an unexpected table",
	"a PUBLIC default privilege",
	"a stranger's membership that confers",
	"a stranger's inert membership",
	"an advance function's volatility changed",
	"an advance function left volatile"
]

type WorldFeature =
	| "a world function's search_path reset"
	| "a world function's volatility changed"
	| "a world function left stable"
	| "a world function executable by PUBLIC"
	| "a world function executable by a second role"
	| "a world function executable by its one role"
	| "a view's barrier flipped"
	| "a view's barrier set as it stands"
	| "a world schema's USAGE beyond its role"
	| "a policy's predicate changed"
	| "a policy widened to PUBLIC"
	| "row security disabled"
	| "row security forced"
	| "MAINTAIN beyond the refreshers"
	| "MAINTAIN revoked from a refresher"
	| "a sequence privilege to a world role"
	| "an advance function's EXECUTE revoked from an inserter"

const worldFeatures: Arr.NonEmptyReadonlyArray<WorldFeature> = [
	"a world function's search_path reset",
	"a world function's volatility changed",
	"a world function left stable",
	"a world function executable by PUBLIC",
	"a world function executable by a second role",
	"a world function executable by its one role",
	"a view's barrier flipped",
	"a view's barrier set as it stands",
	"a world schema's USAGE beyond its role",
	"a policy's predicate changed",
	"a policy widened to PUBLIC",
	"row security disabled",
	"row security forced",
	"MAINTAIN beyond the refreshers",
	"MAINTAIN revoked from a refresher",
	"a sequence privilege to a world role",
	"an advance function's EXECUTE revoked from an inserter"
]

/** A foreign key of the catalog, by its table. */
type ForeignKey = Readonly<{ table: string; key: Catalog["tables"][number]["constraints"][number] }>

/** The volatilities ALTER FUNCTION sets. */
const volatilityGen = element(["IMMUTABLE", "STABLE", "VOLATILE"] as const)

layer(Substrate.layer)("catalog drift", (it) => {
	it.effect(
		"the erasure verifier names each drawn drift's problem, and nothing for a drift that confers nothing",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const worlds = fixtureWorlds(Ledger)
					const { installation, catalog, schema } = yield* installed(Ledger, "drift", [
						worlds.login
					])
					const { login, role: writer } = installedRoleOf(installation, worlds.writer)
					const reader = installedRoleOf(installation, worlds.reader).role
					const expectation = worldsExpectation(Ledger, installation, worlds)
					const substrate = yield* Substrate
					const database = substrate.database
					const owner = catalog.owner
					/** A role outside the installation, unique to this schema and created inside each rolled-back drift. */
					const outsider = `${schema}_outsider`
					const createOutsider = `CREATE ROLE ${quoteIdent(outsider)} NOLOGIN`
					assert.deepEqual(verifyErasure(catalog, expectation), [], "the installation as installed")
					const grantables = grantablesOf(catalog)
					const grantableGen = element(grantables)
					const held = nonEmpty(
						Arr.flatMap(grantables, (g) =>
							Arr.flatMap(g.grants, (grant) =>
								grant.grantee === owner ? [] : [{ grantable: g, grant }]
							)
						),
						"a grant the installation holds"
					)
					const loginHeld = nonEmpty(
						Arr.filter(held, ({ grant }) => grant.grantee === login),
						"a grant the login holds"
					)
					const authored = nonEmpty(
						Arr.filter(
							catalog.tables,
							(t) => t.kind === "r" && expectation.tables.has(t.name) && !t.rowSecurity
						),
						"an authored table without row security"
					)
					const advances = nonEmpty(
						Arr.filter(
							catalog.functions,
							(f) => expectation.functions.get(f.name)?.kind === "advance"
						),
						"an advance function"
					)
					const worldRoles = [writer, reader] as const
					type Erasure = Drift<ErasureProblem, ErasureFeature>
					const driftGen: Gen<Erasure> = oneOf<Erasure>([
						(source) => {
							const g = source.draw(grantableGen)
							const privilege = source.draw(privilegeOf(g.family))
							return {
								statements: [`GRANT ${privilege} ON ${g.target} TO PUBLIC`],
								raises: [{ kind: "publicHolds", object: g.object, privilege }],
								feature: "PUBLIC granted a privilege"
							}
						},
						(source) => {
							const g = source.draw(grantableGen)
							const privilege = source.draw(privilegeOf(g.family))
							return {
								statements: [
									createOutsider,
									`GRANT ${privilege} ON ${g.target} TO ${quoteIdent(outsider)}`
								],
								raises: [{ kind: "strangerHolds", object: g.object, grantee: outsider, privilege }],
								feature: "a stranger granted a privilege"
							}
						},
						(source) => {
							const g = source.draw(grantableGen)
							const privilege = source.draw(privilegeOf(g.family))
							const statements: Arr.NonEmptyReadonlyArray<string> = [
								`GRANT ${privilege} ON ${g.target} TO ${quoteIdent(login)}`
							]
							return holds(g.grants, login, privilege)
								? { statements, raises: [], feature: "a held grant granted again" }
								: {
										statements,
										raises: [{ kind: "loginHolds", object: g.object, login, privilege }],
										feature: "the login granted a privilege it lacks"
									}
						},
						(source) => {
							const { grantable, grant } = source.draw(element(loginHeld))
							return {
								statements: [
									`REVOKE ${grant.privilege} ON ${grantable.target} FROM ${quoteIdent(login)}`
								],
								raises: [
									{
										kind: "loginLacks",
										object: grantable.object,
										login,
										privilege: grant.privilege
									}
								],
								feature: "the login's privilege revoked"
							}
						},
						(source) => {
							const { grantable, grant } = source.draw(element(held))
							return {
								statements: [
									`GRANT ${grant.privilege} ON ${grantable.target} TO ${quoteIdent(grant.grantee)}`
								],
								raises: [],
								feature: "a held grant granted again"
							}
						},
						(source) => {
							const r = source.draw(element([writer, reader, login] as const))
							const attribute = source.draw(element(["CREATEDB", "CREATEROLE"] as const))
							return {
								statements: [`ALTER ROLE ${quoteIdent(r)} ${attribute}`],
								raises: [{ kind: "elevated", role: r }],
								feature: "an elevated attribute"
							}
						},
						(source) => {
							const t = source.draw(element(authored))
							const timing = source.draw(element(["BEFORE", "AFTER"] as const))
							const event = source.draw(element(["INSERT", "UPDATE", "DELETE"] as const))
							return {
								statements: [
									`CREATE TRIGGER "drift" ${timing} ${event} ON ${qualified(catalog, t.name)} FOR EACH ROW EXECUTE FUNCTION pg_catalog.suppress_redundant_updates_trigger()`
								],
								raises: [{ kind: "foreignTrigger", trigger: "drift", table: t.name }],
								feature: "a foreign trigger"
							}
						},
						(source) => {
							const t = source.draw(element(authored))
							return source.draw(boolean)
								? {
										statements: [
											`ALTER TABLE ${qualified(catalog, t.name)} ENABLE ROW LEVEL SECURITY`
										],
										raises: [{ kind: "rowSecurityUnneeded", table: t.name }],
										feature: "row security enabled"
									}
								: {
										statements: [
											`ALTER TABLE ${qualified(catalog, t.name)} FORCE ROW LEVEL SECURITY`
										],
										raises: [{ kind: "rowSecurityForced", table: t.name }],
										feature: "row security forced"
									}
						},
						(source) => {
							const megabytes = source.draw(int(1, 64))
							const setting = `work_mem=${megabytes}MB`
							const assignment = `work_mem = '${megabytes}MB'`
							if (source.draw(boolean)) {
								return {
									statements: [
										`ALTER ROLE ${quoteIdent(login)} IN DATABASE ${quoteIdent(database)} SET ${assignment}`
									],
									raises: [{ kind: "loginDatabaseSetting", role: login, setting }],
									feature: "the login's database setting"
								}
							}
							const r = source.draw(element(worldRoles))
							const scope = source.draw(boolean) ? ` IN DATABASE ${quoteIdent(database)}` : ""
							return {
								statements: [`ALTER ROLE ${quoteIdent(r)}${scope} SET ${assignment}`],
								raises: [{ kind: "worldRoleSetting", role: r, setting }],
								feature: "a world role's setting"
							}
						},
						(source) => {
							const table = `drift_${source.draw(int(0, 3))}`
							return {
								statements: [`CREATE TABLE ${qualified(catalog, table)} ("a" bigint NOT NULL)`],
								raises: [{ kind: "unexpectedTable", table }],
								feature: "an unexpected table"
							}
						},
						(source) => {
							const [objects, objectType, family] = source.draw(
								element([
									["TABLES", "r", "table"],
									["SEQUENCES", "S", "sequence"],
									["FUNCTIONS", "f", "function"],
									["TYPES", "T", "type"]
								] as const)
							)
							const privilege = source.draw(privilegeOf(family))
							return {
								statements: [
									`ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdent(owner)} IN SCHEMA ${quoteIdent(schema)} GRANT ${privilege} ON ${objects} TO PUBLIC`
								],
								raises: [
									{ kind: "defaultAclPublic", schema: Option.some(schema), objectType, privilege }
								],
								feature: "a PUBLIC default privilege"
							}
						},
						(source) => {
							const d = source.draw(element([writer, reader, login] as const))
							const inherit = source.draw(boolean)
							const set = source.draw(boolean)
							const admin = source.draw(boolean)
							const options = `WITH INHERIT ${inherit ? "TRUE" : "FALSE"}, SET ${set ? "TRUE" : "FALSE"}, ADMIN ${admin ? "TRUE" : "FALSE"}`
							const membership = { role: outsider, inherit, set, admin }
							if (source.draw(boolean)) {
								const confers = inherit || set || admin
								return {
									statements: [
										createOutsider,
										`GRANT ${quoteIdent(d)} TO ${quoteIdent(outsider)} ${options}`
									],
									raises: confers
										? [{ kind: "membershipBeyond", role: d, side: "members", membership }]
										: [],
									feature: confers
										? "a stranger's membership that confers"
										: "a stranger's inert membership"
								}
							}
							const confers = set || admin
							return {
								statements: [
									createOutsider,
									`GRANT ${quoteIdent(outsider)} TO ${quoteIdent(d)} ${options}`
								],
								raises: confers
									? [{ kind: "membershipBeyond", role: d, side: "memberOf", membership }]
									: [],
								feature: confers
									? "a stranger's membership that confers"
									: "a stranger's inert membership"
							}
						},
						(source) => {
							const f = source.draw(element(advances))
							const volatility = source.draw(volatilityGen)
							return {
								statements: [`ALTER FUNCTION ${signature(catalog, f)} ${volatility}`],
								raises:
									volatility === "VOLATILE"
										? []
										: [{ kind: "volatility", function: f.name, required: "VOLATILE" }],
								feature:
									volatility === "VOLATILE"
										? "an advance function left volatile"
										: "an advance function's volatility changed"
							}
						}
					])
					return yield* explore(
						{
							suite: "physical/verify/erasure drifts",
							draw: drawn(driftGen),
							literal: (drift) => Formatter.format(drift.statements),
							oracle: {
								kind: "specification",
								name: "each drift's rule as the erasure verifier's specification states it, over the installation's own objects"
							},
							coverage: required<ErasureFeature>(erasureFeatures, {
								cases: 240,
								sense: notesOnly
							}),
							kept: [],
							runs: 64,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(drift, c) =>
							Effect.map(drifted([schema], drift.statements), (after) => {
								named(verifyErasure(after, expectation), drift)
								c.note(drift.feature)
							})
					)
				})
			)
	)

	it.effect(
		"every foreign key re-added NOT VALID keeps the verifier's shape rules, and the manifest comparison catches it",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const worlds = fixtureWorlds(Ledger)
					const { installation, catalog, schema } = yield* installed(Ledger, "invalidated", [
						worlds.login
					])
					const expectation = worldsExpectation(Ledger, installation, worlds)
					const expected = expectedCatalog(installation)
					assert.deepEqual(projectCatalog(catalog), expected, "the installation as installed")
					const foreignKeys: Arr.NonEmptyReadonlyArray<ForeignKey> = nonEmpty(
						Arr.flatMap(catalog.tables, (t) =>
							Arr.map(
								Arr.filter(t.constraints, (k) => k.type === "f"),
								(key) => ({ table: t.name, key })
							)
						),
						"a foreign key"
					)
					return yield* exhaust(
						{
							suite: "physical/verify/not valid",
							generator: element<ForeignKey>(foreignKeys),
							literal: ({ table, key }) => `${table}.${key.name}`,
							coverage: requiredInSpace<"a foreign key re-added NOT VALID">([
								"a foreign key re-added NOT VALID"
							]),
							box: "every foreign key of the installation",
							oracle: {
								kind: "specification",
								name: "the manifest's projection, differing in that constraint's validation alone"
							},
							caseHang
						},
						({ table, key }, c) =>
							Effect.map(
								drifted(
									[schema],
									[
										`ALTER TABLE ${qualified(catalog, table)} DROP CONSTRAINT ${quoteIdent(key.name)}`,
										`ALTER TABLE ${qualified(catalog, table)} ADD CONSTRAINT ${quoteIdent(key.name)} ${key.definition} NOT VALID`
									]
								),
								(after) => {
									assert.deepEqual(verifyErasure(after, expectation), [], "the shape rules hold")
									const projected = projectCatalog(after)
									assert.deepEqual(
										projected,
										{
											...expected,
											tables: Arr.map(expected.tables, (t) =>
												t.name === table
													? {
															...t,
															constraints: Arr.map(t.constraints, (k) =>
																k.name === key.name ? { ...k, validated: false } : k
															)
														}
													: t
											)
										},
										"only the constraint's validation differs"
									)
									c.note("a foreign key re-added NOT VALID")
								}
							)
					)
				})
			)
	)

	it.effect(
		"the installed checker names each drawn drift of a world written under row security",
		(ctx) =>
			searched(
				ctx,
				Effect.scoped(
					Effect.gen(function* () {
						const declared = driftWorlds("Drift")
						const done = yield* install(declared.base, {
							ambient: ordinarySession,
							label: "drift",
							logins: [declared.desk],
							extensions: []
						})
						const schemas = mapNonEmpty(done.installation.names.levels, identifierOf)
						/** Each stored or derived relation's table or view, by its identifier, in its level's schema. */
						const placed = new Map<string, ObjectName>(
							Arr.flatMap(Rec.values(done.installation.owned.relations), (r) => {
								if (r.kind !== "relation" && r.kind !== "derived") {
									return []
								}
								const at = done.installation.names.relation(r.name)
								return [[at.name, at] as const]
							})
						)
						const tableIn = (name: string): string =>
							printObjectName(defined(placed.get(name), `the installed table or view ${name}`))
						const scope = installedScope(done.installation, done.snapshot)
						const expect = scope.erasure
						const baseline = yield* drifted(schemas, [])
						assert.deepEqual(checkInstalled(baseline, scope), [], "the installation as installed")
						const owner = baseline.owner
						const roles = nonEmpty(
							Arr.flatMap([...expect.logins.values()], (r) => [...r]),
							"a world role"
						)
						const logins = nonEmpty([...expect.logins.keys()], "a login")
						const executorsOf = (grants: ReadonlyArray<CatalogGrant>): ReadonlyArray<string> =>
							Arr.flatMap(grants, (g) =>
								g.grantee === owner || g.grantee === "PUBLIC" ? [] : [g.grantee]
							)
						const worldFunctions = nonEmpty(
							Arr.filter(baseline.functions, (f) => expect.functions.get(f.name)?.kind === "world"),
							"a world function"
						)
						const views = nonEmpty(
							Arr.flatMap(baseline.worlds, (w) =>
								Arr.flatMap(w.relations, (v) =>
									v.kind === "v"
										? [
												{
													world: w.name,
													view: v.name,
													barrier: Arr.contains(v.options, "security_barrier=true")
												}
											]
										: []
								)
							),
							"a world view"
						)
						const policies = nonEmpty(baseline.policies, "a policy")
						const secured = nonEmpty(
							Arr.filter(baseline.tables, (t) => expect.rowSecure.has(t.name)),
							"a table under row security"
						)
						const refreshed = nonEmpty(
							Arr.flatMap(
								Arr.filter(baseline.tables, (t) => t.kind === "m"),
								(m: Catalog["tables"][number]) =>
									Arr.map(roles, (r) => ({
										view: m.name,
										role: r,
										refreshes: expect.refreshes.get(r)?.has(m.name) === true
									}))
							),
							"a role and a materialized view"
						)
						const inserters = nonEmpty(
							Arr.flatMap(baseline.functions, (f) => {
								const expected = expect.functions.get(f.name)
								return expected?.kind === "advance"
									? Arr.map(executorsOf(f.grants), (role) => ({ f, role, table: expected.table }))
									: []
							}),
							"a role that executes an advance function"
						)
						const sequences = nonEmpty(baseline.sequences, "a sequence")
						type World = Drift<InstalledProblem, WorldFeature>
						const driftGen: Gen<World> = oneOf<World>([
							(source) => {
								const f = source.draw(element(worldFunctions))
								const kind = source.draw(
									element(["search_path", "volatility", "PUBLIC", "role"] as const)
								)
								switch (kind) {
									case "search_path":
										return {
											statements: [`ALTER FUNCTION ${signature(baseline, f)} RESET search_path`],
											raises: [{ kind: "searchPathUnfixed", function: f.name }],
											feature: "a world function's search_path reset"
										}
									case "volatility": {
										const volatility = source.draw(volatilityGen)
										return {
											statements: [`ALTER FUNCTION ${signature(baseline, f)} ${volatility}`],
											raises:
												volatility === "STABLE"
													? []
													: [{ kind: "volatility", function: f.name, required: "STABLE" }],
											feature:
												volatility === "STABLE"
													? "a world function left stable"
													: "a world function's volatility changed"
										}
									}
									case "PUBLIC":
										return {
											statements: [`GRANT EXECUTE ON FUNCTION ${signature(baseline, f)} TO PUBLIC`],
											raises: [
												{
													kind: "publicHolds",
													object: { kind: "function", name: f.name },
													privilege: "EXECUTE"
												}
											],
											feature: "a world function executable by PUBLIC"
										}
									case "role": {
										const executors = executorsOf(f.grants)
										const other = source.draw(element(roles))
										const after = Arr.sort(Arr.dedupe([...executors, other]), Order.String)
										return {
											statements: [
												`GRANT EXECUTE ON FUNCTION ${signature(baseline, f)} TO ${quoteIdent(other)}`
											],
											raises:
												after.length > 1
													? [{ kind: "worldFunctionExecutors", function: f.name, executors: after }]
													: [],
											feature:
												after.length > 1
													? "a world function executable by a second role"
													: "a world function executable by its one role"
										}
									}
								}
							},
							(source) => {
								const v = source.draw(element(views))
								const flip = source.draw(boolean)
								const barrier = flip ? !v.barrier : v.barrier
								return {
									statements: [
										`ALTER VIEW ${quoteIdent(v.world)}.${quoteIdent(v.view)} SET (security_barrier = ${barrier ? "true" : "false"})`
									],
									raises: flip
										? [
												v.barrier
													? { kind: "barrierMissing", world: v.world, view: v.view }
													: { kind: "barrierUnneeded", world: v.world, view: v.view }
											]
										: [],
									feature: flip ? "a view's barrier flipped" : "a view's barrier set as it stands"
								}
							},
							(source) => {
								const w = source.draw(element(nonEmpty(baseline.worlds, "a world")))
								const grantee = source.draw(
									element(
										nonEmpty(
											Arr.filter([...logins, ...roles], (g) => !holds(w.grants, g, "USAGE")),
											"a role or login outside the world"
										)
									)
								)
								return {
									statements: [
										`GRANT USAGE ON SCHEMA ${quoteIdent(w.name)} TO ${quoteIdent(grantee)}`
									],
									raises: [
										{
											kind: "strayWorldGrant",
											object: { kind: "world", name: w.name },
											grantee,
											privilege: "USAGE"
										}
									],
									feature: "a world schema's USAGE beyond its role"
								}
							},
							(source) => {
								const p = source.draw(element(policies))
								const on = `${quoteIdent(p.name)} ON ${tableIn(p.table)}`
								return source.draw(boolean)
									? {
											statements: [`ALTER POLICY ${on} USING (true)`],
											raises: [{ kind: "policyPredicates", policy: p.name, table: p.table }],
											feature: "a policy's predicate changed"
										}
									: {
											statements: [`ALTER POLICY ${on} TO PUBLIC`],
											raises: [
												{ kind: "policyRoles", policy: p.name, table: p.table, roles: ["PUBLIC"] }
											],
											feature: "a policy widened to PUBLIC"
										}
							},
							(source) => {
								const t = source.draw(element(secured))
								return source.draw(boolean)
									? {
											statements: [`ALTER TABLE ${tableIn(t.name)} DISABLE ROW LEVEL SECURITY`],
											raises: [{ kind: "rowSecurityMissing", table: t.name }],
											feature: "row security disabled"
										}
									: {
											statements: [`ALTER TABLE ${tableIn(t.name)} FORCE ROW LEVEL SECURITY`],
											raises: [{ kind: "rowSecurityForced", table: t.name }],
											feature: "row security forced"
										}
							},
							(source) => {
								const { view, role: r, refreshes } = source.draw(element(refreshed))
								return refreshes
									? {
											statements: [`REVOKE MAINTAIN ON ${tableIn(view)} FROM ${quoteIdent(r)}`],
											raises: [{ kind: "maintainMissing", view, role: r }],
											feature: "MAINTAIN revoked from a refresher"
										}
									: {
											statements: [`GRANT MAINTAIN ON ${tableIn(view)} TO ${quoteIdent(r)}`],
											raises: [{ kind: "maintainBeyondRefresh", view, grantee: r }],
											feature: "MAINTAIN beyond the refreshers"
										}
							},
							(source) => {
								const q = source.draw(element(sequences))
								const r = source.draw(element(roles))
								const privilege = source.draw(privilegeOf("sequence"))
								return {
									statements: [
										`GRANT ${privilege} ON SEQUENCE ${qualified(baseline, q.name)} TO ${quoteIdent(r)}`
									],
									raises: [
										{
											kind: "roleHolds",
											object: { kind: "sequence", name: q.name },
											role: r,
											privilege
										}
									],
									feature: "a sequence privilege to a world role"
								}
							},
							(source) => {
								const { f, role: r, table } = source.draw(element(inserters))
								return {
									statements: [
										`REVOKE EXECUTE ON FUNCTION ${signature(baseline, f)} FROM ${quoteIdent(r)}`
									],
									raises: [{ kind: "insertWithoutAdvance", function: f.name, role: r, table }],
									feature: "an advance function's EXECUTE revoked from an inserter"
								}
							}
						])
						return yield* explore(
							{
								suite: "physical/verify/world drifts",
								draw: drawn(driftGen),
								literal: (drift) => Formatter.format(drift.statements),
								oracle: {
									kind: "specification",
									name: "each drift's rule as the installed checker's specification states it, over the installation's own world objects"
								},
								coverage: required<WorldFeature>(worldFeatures, { cases: 240, sense: notesOnly }),
								kept: [],
								runs: 64,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								caseHang
							},
							(drift, c) =>
								Effect.map(drifted(schemas, drift.statements), (after) => {
									named(checkInstalled(after, scope), drift)
									c.note(drift.feature)
								})
						)
					})
				)
			)
	)
})
