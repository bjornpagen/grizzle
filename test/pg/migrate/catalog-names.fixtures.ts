/** What the properties of catalog-names.test.ts read: its spaces, models and helpers. */

import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { boolean, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { decodeDesc, type LoginDesc, type SchemaDesc } from "#compiler/ir/desc.ts"
import { fullRoleDesc } from "#compiler/schema/own.ts"
import { catalogSpelling, type CatalogTypeName } from "#compiler/sql/ast.ts"
import {
	type AmbientFeature,
	type AmbientSession,
	grizzleFirstSession,
	ordinarySession
} from "#test/support/ambient.ts"
import { succeeded } from "#test/support/assert.ts"
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
	unit,
	value
} from "#test/support/fixtures/ir/desc.ts"
import { catalogDeclared } from "#test/support/kernel/dict.ts"

export const targets = ["relation", "closed relation", "contract", "derived relation"] as const

type Target = (typeof targets)[number]

export type Feature = Target | `named ${CatalogTypeName}` | AmbientFeature

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
export const caseGen: Gen<BoxCase> = (source) => ({
	ambient: source.draw(boolean) ? grizzleFirstSession : ordinarySession,
	names: namesAt(source.draw(int(0, catalogNames.length - 1)))
})

const entry = "Entry"

/** A case's schema: its named objects, the holder of the types they shadow, a relation contained in it, and a level
 * holding the derived relation. */
export const schemaOf = (names: Names): SchemaDesc => {
	const holder = names.relation.declared
	const kind = names["closed relation"].declared
	const base = decodedSchema({
		name: "Box",
		relations: [
			closed.ordered(kind, ["Low", "High"]),
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
					during: f.span(f.integer, undefined)
				},
				["id"]
			),
			relation(entry, { holder: f.uuid, id: f.uuid }, ["holder", "id"])
		],
		statements: [
			contained(on(entry, ["holder"]), on(holder, ["id"])),
			mutable(holder),
			unit("Held", { id: f.uuid }),
			unit("Holding", { holder: f.uuid })
		],
		bases: []
	})
	return decodedSchema({
		name: "Counts",
		bases: [base],
		relations: [
			{
				kind: "derived",
				name: names["derived relation"].declared,
				level: 1,
				storage: "stored",
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

/**
 * The login of a case's schema: a writer holding and writing its stored relations, and a reader holding every one, each
 * the full role's description over it (schema/own.ts fullRoleDesc, which states every list a role describes) narrowed
 * to what it holds and writes.
 */
export const loginOf = (desc: SchemaDesc, names: Names): LoginDesc => {
	const loc = SourceLoc("the catalog-names box", [])
	const whole = (held: ReadonlyArray<string>) =>
		Arr.map(held, (name) => ({ kind: "whole" as const, name, loc }))
	const stored = [names.relation.declared, entry]
	const read = [names["closed relation"].declared, ...stored, names["derived relation"].declared]
	const full = succeeded(fullRoleDesc(desc, "full", loc), "the full role over the box's schema")
	return succeeded(
		decodeDesc("login", {
			name: "server",
			base: desc,
			roles: [
				{ ...full, name: "writer", relations: whole(stored), write: stored },
				{ ...full, name: "reader", relations: whole(read), write: [] }
			],
			loc
		}),
		"the box's login"
	)
}

export const required: Arr.NonEmptyReadonlyArray<Reached<Feature>> = [
	...Arr.map(targets, (t): Reached<Feature> => [t, "grizzle-first path"]),
	...Arr.map(catalogNames, (n): Reached<Feature> => `named ${n.type}`)
]
