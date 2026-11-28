/** What the property of contract-host.test.ts reads: its schema, its contracts' keys and mints, and its space. */

import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Logic } from "#compiler/public/compute.ts"
import {
	closedId,
	contract,
	Decimal,
	type Infer,
	mintOf,
	pg,
	type Uuid,
	uuid
} from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"

/** A holding's tone, a closed roster's handle. */
const Tones = closed.ordered("Tones", ["low", "mid", "high"])

/** A code's base: a few lowercase letters. */
const codeBase = str.regex("^[a-z]{1,8}$")

/** The keys of the module's contracts, which this module alone holds, so its mints are the one way in. */
const amountKey = Symbol("Amount")
const codeKey = Symbol("Code")
const priceKey = Symbol("Price")
const toneKey = Symbol("Tone")
const accountKey = Symbol("Account")

/**
 * A contract over each kind of column a contract's host reads (core/decoder.ts hostColumn): a bigint and a numeric, each
 * converted by its carrier, a pattern's text, read as its cell, a closed id, read by its roster's names, and a uuid.
 * The amount is never negative, which the database checks of every write.
 */
const Amount = contract<typeof amountKey>()("Amount", pg.bigint, (a) => Logic.ge(a, 0n))
const Code = contract<typeof codeKey>()("Code", codeBase)
const Price = contract<typeof priceKey>()("Price", pg.numeric(9, 2))
const Tone = contract<typeof toneKey>()("Tone", closedId(Tones))
const Account = contract<typeof accountKey>()("Account", uuid)

/** The mints of the contracts' values, each from a value of its base. */
const toAmount: (amount: bigint) => Infer<typeof Amount> = mintOf(amountKey)
const toCode: (code: Infer<typeof codeBase>) => Infer<typeof Code> = mintOf(codeKey)
const toPrice: (price: Decimal) => Infer<typeof Price> = mintOf(priceKey)
const toTone: (tone: (typeof Tones.handles)[number]) => Infer<typeof Tone> = mintOf(toneKey)
const toAccount: (account: Uuid) => Infer<typeof Account> = mintOf(accountKey)

/** A holding: one value of each contract, by its id. */
const Held = relation(
	"Held",
	{ id: pg.integer, amount: Amount, code: Code, price: Price, tone: Tone, account: Account },
	["id"]
)

export const Holdings = schema("Holdings", [Tones, Held], [])

/**
 * The full world's workload: holdings written with the facts each call gives, every holding read back, and the ids
 * whose amount a parameter of the contract names.
 */
const programs = Object.freeze({
	store: ChangeSet.empty(Holdings).insert(Held, []),
	held: query(Holdings).rule((r) => {
		const { id, amount, code, price, tone, account } = v(Held, "h")
		return r
			.match(Held, { id, amount, code, price, tone, account })
			.find({ id, amount, code, price, tone, account })
	}),
	byAmount: query(Holdings).rule((r) => {
		const { id } = v(Held, "h")
		return r.match(Held, { id, amount: r.param("amount", Amount) }).find({ id })
	})
})

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const holdingsInstall = Object.freeze({ label: "contract host", programs })

/** Holdings installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const holdingsTemplate = fixtureTemplate(import.meta, Holdings, holdingsInstall)

/** The amounts a holding is drawn with: zero, one, bigint's greatest, and one below zero, which Amount refuses. */
const amounts = [0n, 1n, 9223372036854775807n, -1n] as const

/** The codes, the prices and the accounts a holding is drawn with, each its type's edges. */
const codes = ["a", "zz", "abcdefgh"] as const
const prices = ["0", "-1.5", "9999999.99"] as const
const accounts = [
	"00000000-0000-4000-8000-000000000000",
	"ffffffff-ffff-4fff-bfff-ffffffffffff",
	"0123abcd-4567-4890-abcd-ef0123456789"
] as const

/** A drawn holding, each of its values as the mints take them. */
export interface Holding {
	readonly id: number
	readonly amount: bigint
	readonly code: (typeof codes)[number]
	readonly price: (typeof prices)[number]
	readonly tone: (typeof Tones.handles)[number]
	readonly account: (typeof accounts)[number]
}

/** A holding's values, each drawn from its dictionary. */
const valuesGen: Gen<Omit<Holding, "id">> = (s) => ({
	amount: s.draw(element(amounts)),
	code: s.draw(element(codes)),
	price: s.draw(element(prices)),
	tone: s.draw(element(Tones.handles)),
	account: s.draw(element(accounts))
})

/** A drawn case: one to four holdings, keyed by their place. */
export const space: Gen<Arr.NonEmptyReadonlyArray<Holding>> = (s) => {
	const first = s.draw(valuesGen)
	const more = s.draw(array(valuesGen, { min: 0, max: 3 }))
	return Arr.map(Arr.prepend(more, first), (h, at): Holding => ({ id: at + 1, ...h }))
}

export type Feature =
	| "an amount Amount refuses"
	| "every amount Amount admits"
	| "several holdings in one insert"

export const notes = (holdings: Arr.NonEmptyReadonlyArray<Holding>): ReadonlyArray<Feature> => [
	Arr.some(holdings, (h) => h.amount < 0n)
		? ("an amount Amount refuses" as const)
		: ("every amount Amount admits" as const),
	...(holdings.length > 1 ? (["several holdings in one insert"] as const) : [])
]

/** A holding as its fact, each value its contract's mint's. */
export const factOf = (h: Holding) => ({
	id: h.id,
	amount: toAmount(h.amount),
	code: toCode(h.code),
	price: toPrice(Decimal.of(h.price)),
	tone: toTone(h.tone),
	account: toAccount(h.account)
})
