/** What the properties of catalog-names.test.ts read: its spaces, models and helpers. */

import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { boolean, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import {
	closedId,
	range,
	bool,
	float4,
	float8,
	int4,
	int8,
	money,
	numeric
} from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, login, mutable, on, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { closedBuilder, derivedBuilder, relationBuilder } from "#compiler/schema/relation.ts"
import { unitBuilder } from "#compiler/schema/statements.ts"
import { roleBuilder } from "#compiler/schema/world.ts"
import { catalogSpelling, type CatalogTypeName } from "#compiler/sql/ast.ts"
import {
	type AmbientFeature,
	type AmbientSession,
	grizzleFirstSession,
	ordinarySession
} from "#test/support/ambient.ts"
import { contractDescriptor } from "#test/support/fixtures/descriptors.ts"
import { Id } from "#test/support/ids.ts"
import type { Version } from "#test/support/install-migrate.ts"
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

/**
 * A case's version under the allocated `name`, the values `grizzle generate` drafts and serves it from. Its schema: a
 * root named `name` holding the named objects, the holder of the types they shadow, a relation contained in it and the
 * units of each, and a level above it, `${name}_1`, holding the derived relation, which counts each holder's entries,
 * each entry matched by its key. Its login `server`: a writer holding and inserting the stored relations whole, and a
 * reader holding every one and the closed relation whole, so it reads the derived relation's table through its whole
 * view (schema/own.ts OwnedRole `wholeDerived`).
 *
 * The public signatures take a relation's, a roster's, a contract's and a derived relation's name as one literal
 * (types/schema/relation.ts RelationName, types/fields/constructors.ts OneContractName) and hold a role's whole
 * entries to the relations its level's type names (types/schema/world.ts EntriesCheck), which a level of names known
 * only at run time names none of; the box's names are drawn. So those values are
 * built on the builders' runtime paths, as a JavaScript caller's are (schema/relation.ts relationBuilder, closedBuilder
 * and derivedBuilder, schema/statements.ts unitBuilder, schema/world.ts roleBuilder,
 * test/support/fixtures/descriptors.ts contractDescriptor): the public builders' own cores, which admit the same
 * values. Every other value is the public builders'. Its uuids are Id's (ids.ts), a contract over pg_catalog's uuid,
 * which a drawn Uuid shadows: the builders refuse a bare uuid whose owner no contract names, at run time as in the types
 * (types/fields/field.ts NamedIds), as they refuse a consumer's.
 */
export const versionOf = (names: Names, name: string): Version => {
	const Kind = closedBuilder(names["closed relation"].declared, ["Low", "High"], "ordered", [])
	const Holder = relationBuilder(
		names.relation.declared,
		{
			id: Id,
			note: str.regex("^.*$", "su"),
			amount: contractDescriptor(names.contract.declared, int8, (amount: unknown) =>
				computeCore.ge(amount, 0n)
			),
			price: money,
			cost: numeric(12, 2),
			ratio: float4,
			exact: float8,
			flag: bool,
			kind: closedId(Kind),
			during: range(int4)
		},
		["id"],
		[]
	)
	const Entry = relationBuilder("Entry", { holder: Id, id: Id }, ["holder", "id"], [])
	const base = schema(
		name,
		[Kind, Holder, Entry],
		[
			contained(on(Entry, "holder"), on(Holder, "id")),
			mutable(Holder),
			unitBuilder("Held", { id: Id }, []),
			unitBuilder("Holding", { holder: Id }, [])
		]
	)
	const Counts = derivedBuilder(
		names["derived relation"].declared,
		query(base).rule((r) => {
			const { holder, id } = v(Entry, "entry")
			return r.match(Entry, { holder, id }).find({ holder, entries: r.count() })
		}),
		[]
	)
	const level = schema.extend([base], `${name}_1`, [Counts], [])
	const stored = { [Holder.name]: Holder, Entry }
	const writer = roleBuilder(level, "writer", stored, {
		insert: [Holder.name, Entry.name],
		write: []
	})
	const reader = roleBuilder(level, "reader", { ...stored, [Kind.name]: Kind })
	return { schema: level, logins: [login(level, "server", [writer, reader])] }
}

export const required: Arr.NonEmptyReadonlyArray<Reached<Feature>> = [
	...Arr.map(targets, (t): Reached<Feature> => [t, "grizzle-first path"]),
	...Arr.map(catalogNames, (n): Reached<Feature> => `named ${n.type}`)
]
