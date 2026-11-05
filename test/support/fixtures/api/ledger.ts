import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"

const Posting = relation("Posting", { id: uuid, account: uuid, amount: pg.bigint }, ["id"])

/**
 * The contribution-identity ledger in public-API form: a fold reads each fact it matches once, by its key. byFact binds
 * the posting id although its head omits it, so two postings of one account and amount both contribute; byAmount folds
 * the distinct (account, amount) values, a stage of its own matched whole, so they are one value.
 */
export const Ledger = schema("Ledger", { Posting }, [])

export const byFact = query(Ledger).rule((r) => {
	const { id, account, amount } = v(Posting, "posting")
	return r.match(Posting, { id, account, amount }).find({ account, total: r.sum(amount) })
})

export const byAmount = query(Ledger).rule((r) => {
	const amounts = r.interior((inner) => {
		const { account, amount } = v(Posting, "posting")
		return inner.match(Posting, { account, amount }).find({ account, amount })
	})
	const { account, amount } = v(amounts, "amounts")
	return r.match(amounts, { account, amount }).find({ account, total: r.sum(amount) })
})
