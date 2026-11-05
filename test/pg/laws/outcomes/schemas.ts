import type { LawId } from "#compiler/core/ids.ts"
import { closedId, contract, pg, uuid } from "#compiler/public/fields.ts"
import {
	capacity,
	check,
	closed,
	contained,
	key,
	on,
	relation,
	schema,
	select,
	within
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

const membersPerClub = capacity(on(Club, "region", "number", "code"), {
	from: on(Member, "region", "number", "code"),
	within: within(1n, 2n)
})

export const captainCount = capacity(on(Club, "region", "number", "code"), {
	from: on(
		select(Member, (m) => m.eq(m.captain, true)),
		"region",
		"number",
		"code"
	),
	within: within(0n, 1n)
})
const emailKey = key(on(Member, "email"))
const positiveSeatsCheck = check("PositiveSeats", Club, (x) => x.gt(x.seats, 0))

/**
 * The law-bearing schema of the witness tests, beside the worked example's Work (test/support/fixtures/api/work.ts).
 *
 * Clubs puts every kind of violation a witness is decoded from on keys whose texts exercise the decoders: a club is
 * keyed by a closed handle, a bigint and a refined text, so a residual law's DetailCodec DETAIL carries an enum
 * label, an integer text and a text that needs JSON escaping.
 *
 * - `capacity(on(Club, region, number, code), { from: on(Member, ...), within: within(1n, 2n) })`: a residual capacity,
 *   lower bound one, so a club without members fails at COMMIT with the club's key in its DETAIL;
 * - `capacity(..., { from: on(select(Member, (m) => m.eq(m.captain, true)), ...), within: within(0n, 1n) })`: at most
 *   one captain per club over an unselected target, only a UNIQUE over the selected side's generated columns, no
 *   function, so a second captain is a 23505 on it, whose name maps to the law;
 * - the containment of a member's club into Club: a foreign key, deferred or immediate as the law model's deferral rule
 *   decides;
 * - `key(on(Member, "email"))`: a candidate key, a 23505 on its unique constraint;
 * - `check("PositiveSeats", Club, ...)`: a table CHECK, a 23514 whose DETAIL quotes the whole failing row;
 * - Seats, a contract domain over an integer, and the code's `^.{1,20}$` refinement, a text refinement domain: two
 *   domain constraints, 23514 with the domain as the data type.
 */
export const Clubs = schema("Clubs", { Region, Club, Member }, [
	memberOfClub,
	membersPerClub,
	captainCount,
	emailKey,
	positiveSeatsCheck
])

/**
 * The names of Clubs' fresh installation, and its laws, each read through the naming door from the statement that
 * declares it.
 */
export const clubs = installationNamesOf(installationOf(Clubs, { kind: "declared" }))
export const memberCount: LawId = clubs.lawOf(membersPerClub)
export const memberKey: LawId = clubs.lawOf(emailKey)
export const positiveSeats: LawId = clubs.lawOf(positiveSeatsCheck)
export const seatsLaw: LawId = clubs.contract("Seats").law
export const codeLaw: LawId = clubs.textDomain(Club, "code").law

/**
 * A club code a DETAIL must escape: a quote, a backslash, a comma and a bracket, inside the refinement's 20 characters.
 */
export const awkwardCode = 'q"\\,]x'
