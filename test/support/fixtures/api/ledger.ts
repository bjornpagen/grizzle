import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"

const Posting = relation("Posting", { id: uuid, account: uuid, amount: pg.bigint }, ["id"])

/**
 * The contribution-identity ledger in public-API form: bound variables define contribution identity.
 * byFact binds the posting id although its head omits it, so two postings of one account and amount both contribute;
 * byAmount never binds it, so they are one binding.
 */
export const Ledger = schema("Ledger", { Posting }, [])

export const byFact = query(Ledger).rule((r) => {
	const { id, account, amount } = v(Posting)
	return r.match(Posting, { id, account, amount }).find({ account, total: r.sum(amount) })
})

export const byAmount = query(Ledger).rule((r) => {
	const { account, amount } = v(Posting)
	return r.match(Posting, { account, amount }).find({ account, total: r.sum(amount) })
})
