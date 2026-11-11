/**
 * Objects named like PostgreSQL's own types, migrated under every search path an owner's sessions can start under.
 *
 * A relation, a closed relation, a contract or a derived relation declared under a name a pg_catalog type holds
 * creates a type of that name in the installation's schema: the relation's and the derived relation's row types, the
 * closed relation's enum, the contract's domain. Where that schema comes before pg_catalog on a session's path, the
 * bare name resolves to the installation's type, so every type and function grizzle prints, migrates, replays or reads
 * must name pg_catalog's own absolutely, whatever the path.
 *
 * The box: every pg_catalog type grizzle names in the qualified spelling (sql/ast.ts catalogSpelling) that a declared
 * name converts to, each taken by each of the four objects once, the four of a case each named after a different type,
 * under the owner's ordinary path and under the installation's schemas first (test/support/ambient.ts), the second
 * migrate as the installation's own owner login, under the same path. A case's schema holds the named objects and the
 * types they shadow: a holder relation of text, uuid, money, numeric, real, double precision, a span, a serial and a
 * handle of the closed relation, mutable, with a contract field; a relation contained in it; and, a level up in a
 * schema of its own, the derived relation counting the holder's entries, each entry matched by its key, so the count
 * folds over keyed rows. Its login's writer and reader hold every relation whole. Properties, for every case:
 *
 * - its first migration applies, and migrate's drift check after it matches the catalog against the snapshot;
 * - the migrated catalog holds the installed-catalog checker's posture, its columns' types pg_catalog's own;
 * - migrating its folders again applies nothing, and the drift check after it matches again.
 *
 * Oracle: PostgreSQL, which resolves every name the migration prints under the session's path and refuses a statement
 * that names a type it does not mean; the drift check and the installed-catalog checker against the snapshot; and
 * idempotence, a second migrate applying nothing.
 *
 * Features: each object kind under the installation-first path, and every catalog type's name taken.
 *
 * Plants (~/.cache/grizzle-release/BR11/plants): catalog-names-bare (the printer spells every pg_catalog type it should
 * qualify bare, so the installation's own type of that name answers under the installation-first path).
 */
import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { type Reached, requiredInSpace } from "@grizzle/testing/features"
import { boolean, type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { decodeDesc, type LoginDesc, type SchemaDesc } from "#compiler/ir/desc.ts"
import { type CatalogTypeName, catalogSpelling } from "#compiler/sql/ast.ts"
import { apply, noFurther, openMigrator } from "#test/pg/migrate/support.ts"
import {
	type AmbientFeature,
	type AmbientSession,
	ambientFeatures,
	grizzleFirstSession,
	ordinarySession
} from "#test/support/ambient.ts"
import { assert, defined, nonEmpty, succeeded } from "#test/support/assert.ts"
import {
	closed,
	contained,
	decodedQuery,
	decodedSchema,
	f,
	ge,
	literal,
	mutable,
	on,
	relation,
	value
} from "#test/support/fixtures/ir/desc.ts"
import { installMigrated } from "#test/support/install-migrate.ts"
import { catalogDeclared } from "#test/support/kernel/dict.ts"
import { caseHang } from "#test/support/limits.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const targets = ["relation", "closed relation", "contract", "derived relation"] as const
type Target = (typeof targets)[number]

type Feature = Target | `named ${CatalogTypeName}` | AmbientFeature

/** A catalog type a declared name converts to: its declared name and the type it names. */
interface CatalogName {
	readonly type: CatalogTypeName
	readonly declared: string
}

/** Every qualified catalog type a declared name converts to, in the record's order. */
const catalogNames: Arr.NonEmptyReadonlyArray<CatalogName> = nonEmpty(
	Arr.flatMap(Rec.toEntries(catalogSpelling), ([type, spelling]) => {
		const declared = spelling === "qualified" ? catalogDeclared(type) : undefined
		return declared === undefined ? [] : [{ type, declared }]
	}),
	"a qualified catalog type a declared name converts to"
)

/** A case's names: each object's, each a different catalog type. */
type Names = Readonly<Record<Target, CatalogName>>

interface BoxCase {
	readonly ambient: AmbientSession
	readonly names: Names
}

/** The catalog name `offset` places after the `at`th, wrapping around. */
const nameAt = (at: number, offset: number): CatalogName =>
	defined(catalogNames[(at + offset) % catalogNames.length], `the catalog name ${at} + ${offset}`)

/**
 * The names of the `at`th schema: the relation takes the `at`th catalog name, the closed relation the next, the contract
 * the one after and the derived relation the one after that, so across the schemas each name meets each object once.
 */
const namesAt = (at: number): Names => ({
	relation: nameAt(at, 0),
	"closed relation": nameAt(at, 1),
	contract: nameAt(at, 2),
	"derived relation": nameAt(at, 3)
})

/**
 * Every case of the box: the owner's path, the ordinary one or the installation's schemas first, and the schema whose
 * relation takes a catalog name of the roster, each of the other objects the names after it.
 */
const caseGen: Gen<BoxCase> = (source) => ({
	ambient: source.draw(boolean) ? grizzleFirstSession : ordinarySession,
	names: namesAt(source.draw(int(0, catalogNames.length - 1)))
})

const entry = "Entry"

/** A case's schema: its named objects, the holder of the types they shadow, a relation contained in it, and a level
 * holding the derived relation. */
const schemaOf = (names: Names): SchemaDesc => {
	const holder = names.relation.declared
	const kind = names["closed relation"].declared
	const base = decodedSchema({
		name: "Box",
		relations: [
			closed(kind, ["Low", "High"]),
			relation(
				holder,
				{
					id: f.uuid,
					note: f.wildcard,
					amount: f.contract(names.contract.declared, f.bigint, ge(value, literal(0n))),
					price: f.pg("money"),
					cost: f.numeric(12, 2),
					ratio: f.pg("real"),
					exact: f.pg("double precision"),
					flag: f.boolean,
					kind: f.closedId(kind),
					during: f.span(f.integer, undefined),
					sq: f.bigserial
				},
				["id"]
			),
			relation(entry, { id: f.uuid, holder: f.uuid }, ["id"])
		],
		statements: [contained(on(entry, ["holder"]), on(holder, ["id"])), mutable(holder)],
		extends: undefined
	})
	return decodedSchema({
		name: "Counts",
		extends: base,
		relations: [
			{
				kind: "derived",
				name: names["derived relation"].declared,
				level: 1,
				storage: "materialized",
				query: decodedQuery({
					kind: "rules",
					arms: [
						{
							vars: [
								{ id: "id", origin: { relation: entry, field: "id" } },
								{ id: "holder", origin: { relation: entry, field: "holder" } }
							],
							matches: [
								{
									source: { kind: "relation", name: entry },
									bindings: {
										id: { kind: "var", var: "id" },
										holder: { kind: "var", var: "holder" }
									}
								}
							],
							where: [],
							head: {
								holder: { kind: "var", var: "holder" },
								entries: { kind: "aggregate", fn: "count" }
							},
							interiors: [],
							attach: []
						}
					]
				})
			}
		],
		statements: []
	})
}

/** The login of a case's schema: a writer holding and writing its stored relations, and a reader holding every one. */
const loginOf = (desc: SchemaDesc, names: Names): LoginDesc => {
	const loc = SourceLoc("the catalog-names box", [])
	const whole = (held: ReadonlyArray<string>) =>
		Arr.map(held, (name) => ({ kind: "whole" as const, name, loc }))
	const stored = [names.relation.declared, entry]
	const read = [names["closed relation"].declared, ...stored, names["derived relation"].declared]
	return succeeded(
		decodeDesc("login", {
			name: "server",
			base: desc,
			roles: [
				{ name: "writer", base: desc, relations: whole(stored), write: stored, refresh: [], loc },
				{ name: "reader", base: desc, relations: whole(read), write: [], refresh: [], loc }
			],
			loc
		}),
		"the box's login"
	)
}

const literalOf = (c: BoxCase): string =>
	`${c.ambient.path.kind}: ${Arr.join(
		Arr.map(targets, (t) => `${t} ${c.names[t].declared}`),
		", "
	)}`

const required: Arr.NonEmptyReadonlyArray<Reached<Feature>> = [
	...Arr.map(targets, (t): Reached<Feature> => [t, "grizzle-first path"]),
	...Arr.map(catalogNames, (n): Reached<Feature> => `named ${n.type}`)
]

layer(Substrate.layer)("objects named like PostgreSQL's own types", (it) => {
	it.effect(
		"every catalog type's name on every object, under every path: migrate and drift match, and a second migrate applies nothing",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "every qualified catalog type's declared name on each of a relation, a closed relation, a contract and a derived relation, under the ordinary and the installation-first path",
						oracle: {
							kind: "postgresql",
							name: "PostgreSQL resolves every printed name under the session's path; drift and the installed-catalog checker match; a second migrate applies nothing"
						},
						suite: "pg/migrate/catalog-names",
						generator: caseGen,
						literal: literalOf,
						coverage: requiredInSpace<Feature>(required),
						caseHang
					},
					(c, k) =>
						Effect.gen(function* () {
							for (const feature of ambientFeatures(c.ambient)) {
								k.note(feature)
							}
							for (const t of targets) {
								k.note(t)
								k.note(`named ${c.names[t].type}`)
								for (const feature of ambientFeatures(c.ambient)) {
									k.pair(t, feature)
								}
							}
							const substrate = yield* Substrate
							const desc = schemaOf(c.names)
							const installed = yield* installMigrated(desc, {
								ambient: c.ambient,
								label: "catalog_names",
								logins: [loginOf(desc, c.names)],
								extensions: []
							})
							const m = yield* openMigrator(substrate, installed.ambientOwner.credentials)
							const again = yield* apply(
								m,
								{ snapshot: installed.snapshot, folders: installed.folders },
								noFurther
							)
							assert.deepEqual(again.applied, [], "a second migrate applies nothing")
						}).pipe(Effect.scoped)
				)
			)
	)
})
