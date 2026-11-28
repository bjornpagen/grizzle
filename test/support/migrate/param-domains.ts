/**
 * A history whose parameters' pattern domains meet stored fields and lose them: two versions of one schema, each drafted
 * by the current compiler, the second from the first's snapshot.
 *
 * Every version stores Item, read by one program, `passed`, which delivers each item's id beside two declared
 * parameters: `code` of Code and `slug` of Slug (versionOf). A version may store Coded, whose `code` holds Code, and
 * Tagged, whose `slug` holds Slug. The first stores Coded alone, so its installation holds Code's structural text
 * domain for a stored field, and Slug's for the parameter alone.
 */
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Id } from "#test/support/ids.ts"

/** A pattern the first version's stored field holds. */
const Code = str.regex("^[A-Z]{2,6}$")
/** A pattern no stored field of the first version holds. */
const Slug = str.regex("^[a-z][a-z0-9-]*$")

const Item = relation("Item", { id: Id, n: int4 }, ["id"])
const Coded = relation("Coded", { id: Id, code: Code }, ["id"])
const Tagged = relation("Tagged", { id: Id, slug: Slug }, ["id"])

/** Which of the two patterns a version stores: Code in Coded's `code`, Slug in Tagged's `slug`. */
export interface Stored {
	readonly code: boolean
	readonly slug: boolean
}

/** What the first version stores: Code, and Slug only as a parameter. */
export const firstStored: Stored = { code: true, slug: false }

/** The version storing `stored`: Item always, Coded where it stores Code, Tagged where it stores Slug. */
export const versionOf = (stored: Stored) =>
	schema(
		"ParamDomains",
		[Item, ...(stored.code ? [Coded] : []), ...(stored.slug ? [Tagged] : [])],
		[]
	)

/** The program every version serves: every item's id, beside the two parameters. */
export const passedOver = (s: ReturnType<typeof versionOf>) =>
	query(s).rule((r) => {
		const { id } = v(Item, "item")
		return r
			.match(Item, { id })
			.find({ id, code: r.param("code", Code), slug: r.param("slug", Slug) })
	})
