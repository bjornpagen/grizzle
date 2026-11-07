import type { LawId } from "#compiler/core/ids.ts"
import { closedId, contract, pg, uuid } from "#compiler/public/fields.ts"
import {
	check,
	closed,
	contained,
	key,
	on,
	relation,
	schema,
	select
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { installationNamesOf, installationOf } from "#test/support/kernel/naming.ts"

const Region = closed("Region", ["North", "South"])
export const Seats = contract("Seats", pg.integer, (x) => x.le(500))
const code = str.regex("^.{1,20}$", "su")
export const Club = relation(
	"Club",
	{ region: closedId(Region), number: pg.bigint, code, seats: Seats },
	["region", "number", "code"]
)

export const Member = relation(
	"Member",
	{
		id: uuid,
		region: closedId(Region),
		number: pg.bigint,
		code,
		email: str.regex("^.{1,80}$", "su"),
		captain: pg.boolean
	},
	["id"]
)

const memberOfClub = contained(
	on(Member, "region", "number", "code"),
	on(Club, "region", "number", "code")
)

export const captainKey = key(
	on(
		select(Member, (m) => m.eq(m.captain, true)),
		"region",
		"number",
		"code"
	)
)
const emailKey = key(on(Member, "email"))
const positiveSeatsCheck = check("PositiveSeats", Club, (x) => x.gt(x.seats, 0))

/**
 * The law-bearing schema of the witness tests, beside the worked example's Work (test/support/fixtures/api/work.ts).
 *
 * Clubs puts every kind of native violation a refusal is classified from on keys of every carrier a witness decodes:
 * a club is keyed by a closed id, a bigint and a refined text. Every law is native, so each refusal names its law's
 * constraint and a key witness only where grizzle's own insert protocol reads the requested fact.
 *
 * - `key(on(select(Member, (m) => m.eq(m.captain, true)), "region", "number", "code"))`: at most one captain per club,
 *   a key of the selected side, a UNIQUE over its generated law columns and no function, so a second captain is a 23505
 *   on it, whose name maps to the law;
 * - the containment of a member's club into Club: a foreign key, deferred or immediate as the law model's deferral rule
 *   decides;
 * - `key(on(Member, "email"))`: a candidate key, a 23505 on its unique constraint;
 * - `check("PositiveSeats", Club, ...)`: a table CHECK, a 23514 whose DETAIL quotes the whole failing row;
 * - Seats, a contract domain over an integer, and the code's `^.{1,20}$` refinement, a text refinement domain: two
 *   domain constraints, 23514 with the domain as the data type. Club's code and Member's code share the refinement's
 *   one domain, each field its own pattern law, which the table the refused statement writes decides.
 */
export const Clubs = schema("Clubs", { Region, Club, Member }, [
	memberOfClub,
	captainKey,
	emailKey,
	positiveSeatsCheck
])

/**
 * The names of Clubs' fresh installation, and its laws, each read through the naming door from the statement that
 * declares it.
 */
export const clubs = installationNamesOf(installationOf(Clubs, { kind: "declared" }))
export const memberKey: LawId = clubs.lawOf(emailKey)
export const positiveSeats: LawId = clubs.lawOf(positiveSeatsCheck)
export const seatsLaw: LawId = clubs.contract("Seats").law
/** Club's code and Member's code share the one domain of `^.{1,20}$`, each field its own law. */
export const clubCodeLaw: LawId = clubs.patternLaw(Club, "code")
export const memberCodeLaw: LawId = clubs.patternLaw(Member, "code")

/**
 * A club code a DETAIL must escape: a quote, a backslash, a comma and a bracket, inside the refinement's 20 characters.
 */
export const awkwardCode = 'q"\\,]x'
