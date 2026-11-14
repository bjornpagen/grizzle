/**
 * A history whose parameters' pattern domains change definition: the first version, frozen as grizzle installed it
 * before parameter domains were named by their whole definition (param-domains.files.ts), and the version after it.
 *
 * Both versions store Item, read by one program, `passed`, which delivers each item's id beside two declared
 * parameters: `code` of Code and `slug` of Slug. The first stores Coded, whose `code` holds Code, so its installation
 * holds Code's structural text domain; Slug no stored field holds. The second drops Coded and stores Tagged, whose
 * `slug` holds Slug.
 *
 * The first version was drafted by grizzle 6311f975's test kit (compile asDrafted with the program's parameter types,
 * paramsOver; generate from the empty snapshot; writeSnapshot over derivedOf) and is frozen verbatim as a committed
 * migrations directory (test/support/migrate/param-domains/), which oxfmt leaves as written. That compiler named a parameter's pattern domain
 * by its place and its pattern's text domain's definition alone, and created it over that text domain where a stored
 * field held the pattern (d74bbf7b), with a CHECK of its own otherwise. So it holds `code`'s domain over Code's text
 * domain and `slug`'s with its own CHECK, under the same names: the shape every parameter domain had from edc9d8a6
 * until d74bbf7b, and pantry's three at fa30bb28.
 *
 * Its schema is installed under its declared name, `param_domains`, which its migration's SQL and its snapshot's
 * fingerprint hold.
 */
import { Effect } from "effect"
import { readSnapshot } from "#adapter/boundary/snapshot.ts"
import type { FolderSource } from "#adapter/migrate/input.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { succeeded } from "#test/support/assert.ts"
import { fileText, repoRoot } from "#test/support/files.ts"

/** A pattern the first version's stored field holds, and the second's none. */
const Code = str.regex("^[A-Z]{2,6}$")
/** A pattern no stored field of the first version holds, and the second's does. */
const Slug = str.regex("^[a-z][a-z0-9-]*$")

const Item = relation("Item", { id: uuid, n: pg.int4 }, ["id"])
const Coded = relation("Coded", { id: uuid, code: Code }, ["id"])
const Tagged = relation("Tagged", { id: uuid, slug: Slug }, ["id"])

/** The first version: Code stored, Slug passed alone. */
export const firstVersion = schema("ParamDomains", [Item, Coded], [])
/** The second version: Coded dropped, Slug stored. */
export const secondVersion = schema("ParamDomains", [Item, Tagged], [])

/** The program each version serves: every item's id, beside the two parameters. */
export const passedOver = (s: typeof firstVersion | typeof secondVersion) =>
	query(s).rule((r) => {
		const { id } = v(Item, "item")
		return r
			.match(Item, { id })
			.find({ id, code: r.param("code", Code), slug: r.param("slug", Slug) })
	})

/** The first version's installation as its generator left it: the snapshot its first migration reaches, and that
 * migration's folder. */
export interface FrozenFirst {
	readonly snapshot: DeploySnapshot
	readonly folder: FolderSource
}

/** The first version's migrations directory, its files verbatim as its generator wrote them. */
const frozenDirectory = `${repoRoot}test/support/migrate/param-domains/`
/** Its one migration folder and that folder's files. */
const firstFolder = "20261012000001_first"
const firstFiles = ["01-setup.sql", "02-structure.sql", "03-publish.sql"] as const

/** The first version as the command line reads its committed directory: its snapshot, its fingerprint checked, and its
 * migration folder. */
export const frozenFirst: Effect.Effect<FrozenFirst> = Effect.gen(function* () {
	const at = (name: string) => fileText(`${frozenDirectory}${name}`)
	const snapshot = yield* at("snapshot.json")
	const manifest = yield* at("manifest.json")
	const metaText = yield* at(`${firstFolder}/meta.json`)
	const files = yield* Effect.forEach(firstFiles, (name) =>
		Effect.map(at(`${firstFolder}/${name}`), (text) => ({ name, text }))
	)
	return {
		snapshot: succeeded(
			readSnapshot({ snapshot, manifest }),
			"the first version's committed snapshot reads"
		).snapshot,
		folder: { name: firstFolder, metaText, files }
	}
})
