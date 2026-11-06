import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	pipe,
	Record as Rec,
	String as Str
} from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { probeTextDomains } from "#test/pg/physical/checks.ts"
import { fixtureWorlds, worldsGrants } from "#test/pg/physical/support.ts"
import { assert } from "#test/support/assert.ts"
import { type ProjectedCatalog, projectCatalog } from "#test/support/catalog/expected.ts"
import { type Catalog, readCatalog } from "#test/support/catalog/read.ts"
import { installationSql } from "#test/support/compile.ts"
import type { SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { atName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	defaultSchemaLimits,
	fullDataSwarm,
	resolveSchema,
	schemaDesc,
	schemaSketchGen
} from "#test/support/oracle/gen/schema.ts"
import { defaultPlanOptions } from "#test/support/oracle/install/model.ts"
import { planInstall } from "#test/support/oracle/install/plan.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { owning } from "#test/support/policy.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The oracle installer and the real installer produce equivalent catalogs.
 *
 * The oracle's minimal installer (test/support/oracle/install) and the real one both install each generated schema (1-4
 * relations, candidate keys, closed rosters with payloads, containments into earlier relations' keys, mutable
 * relations, every scalar family the generators draw, the extended types included: contracts, spans and vectors) under
 * the one schema name the case allocates, each inside its own transaction on one pinned session, which reads the
 * catalog and rolls back, so nothing outlives the case and the two catalogs carry the same schema name.
 *
 * The oracle installs no role (plan.ts); the real installer installs the schema with the fixture's worlds
 * (test/pg/physical/support.ts fixtureWorlds: a full writer and a full reader in one login). They agree on every table,
 * column order and base type, NOT NULL, collation, identity and sequence; on every primary key, candidate key and
 * foreign key, by name, columns and referenced columns; and on enum labels in order. The real installer's grants are
 * judged against the worlds' grants derived from the declaration and the installed types alone (support.ts
 * worldsGrants), independent of the installer. The differences are exactly what the oracle records it leaves out or
 * what the real installer adds by rule, each checked here:
 *
 * - a column the oracle types as plain text is typed by the structural `__text_` domain of its pattern, whose base is
 *   that same text. Each domain's CHECK is judged by what it admits: every probe text (checks.ts) cast into the domain
 *   inside the real installation's transaction must be admitted exactly when the declared pattern, read by the
 *   JavaScript engine, matches it, and refused with 23514 naming the domain's CHECK;
 * - a contract domain is the real installer's without its CHECKs, which the minimal installer leaves out (plan.ts),
 *   named alike, by the digest of its definition, CHECK and all;
 * - a closed relation, which a roster's patterned payload declares, is the real installer's alone: the minimal installer
 *   skips it (plan.ts), and its constants are no part compared here;
 * - a table's storage CHECKs (a span's shape and width, a vector's norm) are the oracle's own statement of the
 *   documented rule, compared with the real installer's by name and by PostgreSQL's deparsed definition; a row check
 *   and a finite check are the real installer's alone, held by name to the ones its DDL states here, and by what they
 *   admit, with a contract's predicate and a span endpoint's, in checks.test.ts;
 * - a foreign key the law model defers (the referenced relation has fields outside the referenced key) is DEFERRABLE
 *   INITIALLY DEFERRED where the oracle's is immediate;
 * - the real installer adds the law-maintenance indexes its index engine created, each a non-unique index justified by
 *   a law, and nothing else;
 * - the real installer adds the refusal function its write statements raise through (packages/engine/src/write/refusal.ts),
 *   which the oracle's installer predates, and an advance function per serial field (physical/ddl/advance.ts), each
 *   executable by the writer alone.
 *
 * What a case reached of the differences the comparison allows, and of the extended types it compares.
 */
type PhysicalFeature =
	| "text domain"
	| "deferred foreign key"
	| "law index"
	| "contract domain"
	| "span key"
	| "vector column"
	| "text domain judged both ways"

const situations = [
	"text domain",
	"deferred foreign key",
	"law index",
	"contract domain",
	"span key",
	"vector column",
	"text domain judged both ways"
] as const satisfies ReadonlyArray<PhysicalFeature>

/** Every CHECK of a catalog's tables, `<table>.<constraint>`, to PostgreSQL's deparsed definition of it. */
const checksOf = (catalog: Catalog): ReadonlyMap<string, string> =>
	new Map(
		Arr.flatMap(catalog.tables, (t) =>
			Arr.flatMap(t.constraints, (k) =>
				k.type === "c" ? [[`${t.name}.${k.name}`, k.definition] as const] : []
			)
		)
	)

/** The constraint of a `<table>.<constraint>` key of checksOf. */
const constraintOf = (key: string): string => {
	const dot = Option.getOrThrowWith(
		pipe(key, Str.indexOf(".")),
		() => new Error(`the check key ${key} holds a dot`)
	)
	return Str.slice(dot + 1)(key)
}

/**
 * One installation's catalog: `sql` run inside a transaction on the pinned session, the catalog of `schema` read in it,
 * `probes` run in it, and the transaction rolled back. CREATE SCHEMA, CREATE ROLE, ALTER ROLE and CREATE EXTENSION are
 * transactional, so the installation leaves nothing behind. Its projection, its tables' CHECKs as PostgreSQL deparses
 * them, and what the probes found.
 */
const installedCatalog = <A>(
	pinned: PgConnection,
	schema: string,
	sql: ReadonlyArray<string>,
	probes: Effect.Effect<A, SqlError>
) =>
	Effect.ensuring(
		Effect.gen(function* () {
			yield* pinned.query("BEGIN", [])
			for (const statement of sql) {
				yield* pinned.query(statement, [])
			}
			const installed = yield* readCatalog(pinned, schema)
			if (installed.kind === "absent") {
				return yield* Effect.die(new Error(`the installed schema ${schema} is absent`))
			}
			const probed = yield* probes
			return {
				projected: projectCatalog(installed.catalog),
				checks: checksOf(installed.catalog),
				probed
			}
		}),
		Effect.orDie(pinned.query("ROLLBACK", []))
	)

layer(Substrate.layer)("oracle and real installer", (it) => {
	it.effect("generated schemas, extended types included, install to equivalent catalogs", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const substrate = yield* Substrate
				return yield* explore(
					{
						suite: "physical/oracle",
						draw: drawn(
							schemaSketchGen({ ...defaultSchemaLimits, extended: true, keys: "spanKeys" })
						),
						literal: Formatter.format,
						coverage: required<PhysicalFeature>(situations, { cases: 400, sense: notesOnly }),
						kept: [],
						/**
						 * The floor stream runs 100 and the rotating stream 400: 500 schemas, each installed twice.
						 */
						runs: 400,
						shrink: { kind: "complete" },
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(sketch, c) =>
						Effect.scoped(
							Effect.gen(function* () {
								/** The full data swarm keeps every place, so the resolution draws nothing. */
								const desc: SchemaDesc = schemaDesc(
									c.draw(resolveSchema(sketch, { mode: "drawn", edge: false }, fullDataSwarm))
								)
								/**
								 * The schema name first, the pinned session second: the session is released before
								 * the name's finalizer runs on the admin connection.
								 */
								const schema = yield* substrate.schema({ create: false, label: "physical" })
								const pinned = yield* substrate.admin.pin
								const plan = planInstall(desc, atName(schema), {
									...defaultPlanOptions,
									unsupported: "skip"
								})
								if (!plan.ok) {
									return yield* Effect.die(new Error(`oracle plan ${plan.error.message}`))
								}
								/**
								 * What the plan skips: exactly the closed relations, a roster's patterned payload
								 * (gen/schema.ts schemaDesc), constants, which no part compared here holds, beside their
								 * text domain, a structural domain like any other.
								 */
								const skippedClosed = Arr.flatMap(desc.relations, (r) =>
									r.kind === "closedRelation" ? [`closed relation ${r.name}`] : []
								)
								assert.deepEqual(
									Arr.map(plan.value.skipped, (o) => o.what),
									skippedClosed
								)
								const owned = owning(desc)
								const worlds = fixtureWorlds(desc)
								const real = compileInstallation(owned, {
									...installOptions(owned, substrate.owner.role),
									installation: identity.schema(parsedSchemaName(schema)),
									logins: [worlds.login]
								})
								if (!real.ok) {
									return yield* Effect.die(new Error(`real compile ${real.error.message}`))
								}
								const oracle = yield* installedCatalog(pinned, schema, plan.value.sql, Effect.void)
								/**
								 * The real installation's text refinement domains judged by what they admit
								 * (checks.ts).
								 */
								const actual = yield* installedCatalog(
									pinned,
									schema,
									installationSql(real.value),
									probeTextDomains(pinned, real.value, desc)
								)
								assert.deepEqual(actual.probed.problems, [])
								if (actual.probed.admitted && actual.probed.refused) {
									c.note("text domain judged both ways")
								}
								const o = oracle.projected
								const r = actual.projected
								/** The projected catalogs hold plain names, compared side against side. */
								const textDomains = new Set<string>(Arr.map(real.value.textDomains, (d) => d.name))
								const created = new Set<string>(
									Arr.map(
										Arr.filter(
											real.value.indexes,
											(x) => x.index.kind === "created" && x.requests.length > 0
										),
										(x) => x.index.name
									)
								)
								const deferred = new Set<string>(
									Arr.flatMap(real.value.laws.natives, (n) =>
										n.namespace === "constraint" &&
										n.object.kind === "ForeignKey" &&
										n.object.deferrable
											? [identifierOf(n.named)]
											: []
									)
								)
								/** The row CHECKs and the closed laws' CHECKs, which the oracle does not model. */
								const rowChecks = new Set<string>(
									Arr.flatMap(real.value.laws.natives, (n) =>
										n.namespace === "constraint" &&
										(n.object.kind === "TableCheck" || n.object.kind === "ClosedCheck")
											? [identifierOf(n.named)]
											: []
									)
								)
								const oracleTables = Rec.values(plan.value.tables)
								if (textDomains.size > 0) {
									c.note("text domain")
								}
								if (deferred.size > 0) {
									c.note("deferred foreign key")
								}
								if (created.size > 0) {
									c.note("law index")
								}
								if (Rec.keys(plan.value.domains).length > 0) {
									c.note("contract domain")
								}
								if (
									Arr.some(oracleTables, (x) =>
										Arr.some([x.primaryKey, ...x.keys], (k) => k.span.kind === "span")
									)
								) {
									c.note("span key")
								}
								if (
									Arr.some(oracleTables, (x) =>
										Arr.some(x.columns, (col) => col.type.value.kind === "vector")
									)
								) {
									c.note("vector column")
								}
								/**
								 * Domains: the real installer's structural text domains, over text, its roster
								 * domains, the oracle's CHECK and all, and its contract domains, which are the
								 * oracle's but for their CHECKs.
								 */
								const rosterDomains = new Set<string>(
									Arr.map(
										[...real.value.names.codes.rosters.keys()],
										(roster) => real.value.names.rosterDomain(roster).name
									)
								)
								const textDomainsOf = Arr.filter(r.domains, (d) => textDomains.has(d.name))
								assert.deepEqual(
									Arr.map(textDomainsOf, (d) => d.name),
									Arr.sort([...textDomains], Order.String)
								)
								for (const d of textDomainsOf) {
									assert.deepEqual(d.base, { schema: "pg_catalog", name: "text", typmod: -1 })
								}
								assert.deepEqual(
									o.domains,
									Arr.map(
										Arr.filter(r.domains, (d) => !textDomains.has(d.name)),
										(d) => (rosterDomains.has(d.name) ? d : { ...d, constraints: [] })
									)
								)
								/**
								 * Tables, with domain-typed text columns read as their base, the real installer's
								 * row and finite CHECKs left out and deferral factored out: the storage CHECKs
								 * compare by name.
								 */
								const baseOf = (x: { schema: string; name: string; typmod: number }) =>
									textDomains.has(x.name) ? { schema: "pg_catalog", name: "text", typmod: -1 } : x
								const tables = (catalog: ProjectedCatalog, isReal: boolean) =>
									Arr.map(catalog.tables, (x) => ({
										...x,
										columns: Arr.map(x.columns, (col) => ({ ...col, type: baseOf(col.type) })),
										constraints: Arr.flatMap(x.constraints, (k) =>
											!isReal
												? [k]
												: k.type === "c" && rowChecks.has(k.name)
													? []
													: deferred.has(k.name)
														? [{ ...k, deferrable: false, deferred: false }]
														: [k]
										)
									}))
								assert.deepEqual(tables(r, true), tables(o, false))
								/**
								 * The storage CHECKs (a span's shape and width, a vector's norm) by definition: the
								 * oracle states each documented rule itself (plan.ts), so PostgreSQL's deparsing of
								 * both installations' predicates agrees.
								 */
								const storageChecks: ReadonlyMap<string, string> = new Map(
									Arr.filter([...actual.checks], ([key]) => !rowChecks.has(constraintOf(key)))
								)
								assert.deepEqual(storageChecks, oracle.checks)
								/**
								 * Row CHECKs: the oracle models none of the real installer's row checks (plan.ts
								 * leaves them out), so the CHECKs the real catalog holds, table by table, are held
								 * to the ones the real installation's DDL states, and every check law the law model
								 * recognizes is among them: a CHECK dropped, doubled, renamed or unexpected fails.
								 */
								const statedChecks = Arr.flatMap(real.value.statements, (st) =>
									st.kind === "createTable"
										? Arr.flatMap(st.secondary, (k) =>
												k.kind === "check" ? [`${st.table.name}.${k.name}`] : []
											)
										: st.kind === "alterTable"
											? Arr.flatMap(st.actions, (a) =>
													a.kind === "addConstraint" && a.constraint.kind === "check"
														? [`${st.table.name}.${a.constraint.name}`]
														: []
												)
											: []
								)
								const installedChecks = Arr.flatMap(r.tables, (x) =>
									Arr.flatMap(x.constraints, (k) => (k.type === "c" ? [`${x.name}.${k.name}`] : []))
								)
								assert.deepEqual(
									Arr.sort([...installedChecks], Order.String),
									Arr.sort([...statedChecks], Order.String)
								)
								const checkNames = new Set(
									Arr.flatMap(r.tables, (x) =>
										Arr.flatMap(x.constraints, (k) => (k.type === "c" ? [k.name] : []))
									)
								)
								for (const check of rowChecks) {
									assert.ok(checkNames.has(check), `the check law ${check} is installed`)
								}
								for (const x of r.tables) {
									for (const k of x.constraints) {
										if (deferred.has(k.name)) {
											assert.deepEqual([k.deferrable, k.deferred], [true, true])
										}
									}
								}
								assert.deepEqual(
									o.indexes,
									Arr.filter(r.indexes, (x) => !created.has(x.name))
								)
								for (const x of Arr.filter(r.indexes, (index) => created.has(index.name))) {
									assert.equal(x.unique, false)
								}
								assert.equal(r.enumLabels, 0, "the real installer installs no enum label")
								assert.deepEqual(r.sequences, o.sequences)
								assert.deepEqual(o.roles, [])
								assert.deepEqual(o.grants, [])
								assert.deepEqual(r.grants, worldsGrants(desc, real.value, worlds, r))
							})
						)
				)
			})
		)
	)
})
