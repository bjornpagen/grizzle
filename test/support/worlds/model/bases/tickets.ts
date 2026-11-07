import { textDomain } from "#test/support/worlds/model/text.ts"
import type { BaseSpec, FieldDomain, InstallSpec } from "#test/support/worlds/model/types.ts"

/** A ticket's code: a candidate key a caller names a ticket by. */
const code: FieldDomain = textDomain("^t_[a-z]{1,8}$", "u")

/**
 * The tickets base: a ticket's number is an identity the database draws, its primary key; its code is a candidate key;
 * and its seats are at most five, a row check. A ChangeSet that adds a ticket and leaves its number out states no
 * primary key, so a row check refusing that ticket names it by its code, the next key the relation declares (README
 * "Errors and outcomes": the key of the row the ChangeSet states, in the fields it was written in).
 */
const ticketsBase: BaseSpec = {
	name: "Tickets",
	closed: [],
	relations: [
		{
			name: "Ticket",
			fields: [
				{ name: "no", domain: { kind: "serial", bits: 64 } },
				{ name: "code", domain: code },
				{ name: "seats", domain: { kind: "integer", bits: 32 } }
			],
			key: ["no"],
			mutability: "immutable"
		}
	],
	laws: [
		{ kind: "key", relation: "Ticket", fields: ["code"] },
		{
			kind: "check",
			name: "FewSeats",
			relation: "Ticket",
			predicate: { kind: "compare", field: "seats", op: "<=", value: 5 }
		}
	],
	contexts: [],
	derived: []
}

/** The tickets base's one world: a clerk who writes tickets whole, in the login desk. */
export const ticketsInstall: InstallSpec = {
	base: ticketsBase,
	roles: [
		{
			name: "clerk",
			entries: { Ticket: { kind: "whole", relation: "Ticket" } },
			write: ["Ticket"],
			refresh: []
		}
	],
	logins: [{ name: "desk", roles: ["clerk"] }]
}
