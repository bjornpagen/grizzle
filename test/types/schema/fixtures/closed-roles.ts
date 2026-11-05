import type { DbOf } from "#adapter/types/db.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import { type HeadOf, query, v } from "#compiler/public/query.ts"
import { closed, login, relation, role, schema } from "#compiler/public/schema.ts"
import type { Equals, Expect } from "#test/types/schema/support.ts"

/**
 * A role over a base that declares a closed relation keeps the base as a level, as the type checker reads it. Typechecked
 * only.
 *
 * The oracle is the type checker. A closed relation is no entry: its rows are constants every role reads (D3), so a role
 * holds every relation of its base whole when it holds every one but the closed relations, and a query over the base
 * is a query over one of the role's levels, a closed read among its matches.
 */
const Tier = closed("Tier", ["Free", "Pro"])
const TierInfo = closed.relation(
	"TierInfo",
	{ tier: closedId(Tier), seats: pg.integer },
	["tier"],
	[
		{ tier: "Free", seats: 1 },
		{ tier: "Pro", seats: 5 }
	]
)
const Account = relation("Account", { id: pg.integer, tier: closedId(Tier) }, ["id"])
const Plans = schema("Plans", { Tier, TierInfo, Account }, [])

/** Every relation but the closed relation, as a full role holds them. */
const app = role(Plans, "app", { Tier, Account }, { write: ["Account"] })
export const server = login(Plans, "server", [app])

/** A query over the base, a closed relation's rows among its matches. */
const seatsOf = query(Plans).rule((r) => {
	const { id, tier } = v(Account, "account")
	const { seats } = v(TierInfo, "info")
	return r.match(Account, { id, tier }).match(TierInfo, { tier, seats }).find({ id, seats })
})

export type HeadOfSeats = Expect<
	Equals<HeadOf<typeof seatsOf>, { readonly id: number; readonly seats: number }>
>

/** The query runs in the role's world: the base is among its levels, so a Db of the role executes it. */
export const seatsRead = (db: DbOf<typeof app, unknown>) => db.execute(seatsOf, {})
