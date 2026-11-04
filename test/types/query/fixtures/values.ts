import type { DbOf } from "#adapter/types/db.ts"
import type { ChangeSet as PublicChangeSet } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import { Uuid, uuid } from "#compiler/public/fields.ts"
import { type HeadOf, type ParamsOf, type ParamType, query, v } from "#compiler/public/query.ts"
import { type Fact, relation, role, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { Equals, Expect } from "#test/types/query/support.ts"

/**
 * The value language of a column's type, uuid's and a refined text's, at every position a JavaScript value stands: a
 * binding, a comparison operand, a list, a parameter, a bound parameter, a typed constant and a fact. A uuid literal and
 * a value Uuid.parse returned are uuids; a text with fewer than four hyphens and a plain string are not. A term of one
 * pattern meets a column and a term of another, as the checker admits, while a JavaScript value is of its own column's
 * pattern. Every `@ts-expect-error -- TSnnnn` names the diagnostic the harness requires on the next line; uses of Db
 * and ChangeSet sit inside functions nothing calls.
 */
declare const ChangeSet: typeof PublicChangeSet

const Answer = str.regex("^(yes|no)$")
const Grade = str.regex("^(pass|fail)$")
export const Ledger = relation("Ledger", { id: uuid, owner: uuid, answer: Answer, grade: Grade }, [
	"id"
])
export const Books = schema("Books", { Ledger }, [])
export const Keeper = role(Books, "keeper", Books.relations, { write: ["Ledger"] })

const ledgerId = "0193d8f2-7c1e-7000-8000-00000000002a"
const ownerId = "0193d8f2-7c1e-7000-8000-00000000002b"

/** A fact's uuid fields are uuids and its texts their patterns' languages. */
export type LedgerFact = Expect<
	Equals<
		Fact<typeof Ledger>,
		{
			readonly id: Uuid
			readonly owner: Uuid
			readonly answer: "yes" | "no"
			readonly grade: "pass" | "fail"
		}
	>
>

/** A uuid column binds a uuid literal and a uuid term, and a comparison takes a uuid literal opposite one. */
export const byOwner = query(Books).rule((r) => {
	const { id, owner } = v(Ledger, "ledger")
	return r
		.match(Ledger, { id, owner })
		.where(r.eq(owner, r.param("owner", uuid)))
		.find({ id })
})
export const literalBinding = query(Books).rule((r) => {
	const { owner } = v(Ledger, "ledger")
	return r.match(Ledger, { id: ledgerId, owner }).find({ owner })
})
export const literalOperand = query(Books).rule((r) => {
	const { id, owner } = v(Ledger, "ledger")
	return r
		.match(Ledger, { id, owner })
		.where(r.eq(owner, ownerId), r.inSet(id, [ledgerId]))
		.find({ id })
})
export type ByOwnerHead = Expect<Equals<HeadOf<typeof byOwner>, { readonly id: Uuid }>>
export type ByOwnerParams = Expect<
	Equals<ParamsOf<typeof byOwner>, { readonly owner: ParamType<Uuid, "uuid"> }>
>

/** A parsed Uuid stands wherever a uuid literal does. */
export const parsedBinding = (id: Uuid) =>
	query(Books).rule((r) => {
		const { owner } = v(Ledger, "ledger")
		return r.match(Ledger, { id, owner }).where(r.ne(owner, id)).find({ owner })
	})

/** No text without four hyphens, no plain string and no text term stands at a uuid column or opposite a uuid term. */
export const refusedUuidPositions = (plain: string) => [
	query(Books).rule((r) => {
		const { owner } = v(Ledger, "ledger")
		// @ts-expect-error -- TS2322: a text with fewer than four hyphens is no uuid
		return r.match(Ledger, { id: "0193d8f2", owner }).find({ owner })
	}),
	query(Books).rule((r) => {
		const { owner } = v(Ledger, "ledger")
		// @ts-expect-error -- TS2322: a plain string is no uuid; Uuid.parse makes it one
		return r.match(Ledger, { id: plain, owner }).find({ owner })
	}),
	query(Books).rule((r) => {
		const { id, owner } = v(Ledger, "ledger")
		// @ts-expect-error -- TS2345: a plain string is never a uuid operand
		return r.match(Ledger, { id, owner }).where(r.eq(owner, plain)).find({ id })
	}),
	query(Books).rule((r) => {
		const { id, owner } = v(Ledger, "ledger")
		return (
			r
				.match(Ledger, { id, owner })
				// @ts-expect-error -- TS2322: a list of a uuid term holds uuids
				.where(r.inSet(owner, ["0193d8f2"]))
				.find({ id })
		)
	}),
	query(Books).rule((r) => {
		const { id, owner, answer } = v(Ledger, "ledger")
		// @ts-expect-error -- TS2345: a text term never meets a uuid term
		return r.match(Ledger, { id, owner, answer }).where(r.eq(owner, answer)).find({ id })
	}),
	// @ts-expect-error -- TS2345: a typed uuid constant is a uuid
	Compute.literal(uuid, "0193d8f2")
]

/** A uuid parameter takes a uuid literal or a parsed Uuid; a plain string is parsed first. */
export const ownerReads = (db: DbOf<typeof Keeper, unknown>, plain: string) => {
	const literal = db.execute(byOwner, { owner: ownerId })
	const parsed = Uuid.parse(plain)
	const fromParse = parsed.ok ? [db.execute(byOwner, { owner: parsed.value })] : []
	// @ts-expect-error -- TS2322: a text with fewer than four hyphens is no uuid
	const short = db.execute(byOwner, { owner: "0193d8f2" })
	// @ts-expect-error -- TS2322: a plain string is no uuid; Uuid.parse makes it one
	const unparsed = db.execute(byOwner, { owner: plain })
	return [literal, fromParse, short, unparsed]
}

/** A bound uuid parameter takes a uuid term or a uuid literal, never a text term. */
export const boundOwner = query(Books).rule((r) => {
	const { owner } = v(Ledger, "ledger")
	const owned = byOwner.bind({ owner })
	const { id } = v(owned, "owned")
	return r.match(Ledger, { id, owner }).match(owned, { id }).find({ id })
})
export const boundLiteral = byOwner.bind({ owner: ownerId })
export const refusedBinds = () => [
	query(Books).rule((r) => {
		const { answer } = v(Ledger, "ledger")
		// @ts-expect-error -- TS2322: a text term never binds a uuid parameter
		const owned = byOwner.bind({ owner: answer })
		const { id } = v(owned, "owned")
		return r.match(Ledger, { id, answer }).match(owned, { id }).find({ id })
	}),
	// @ts-expect-error -- TS2322: a text with fewer than four hyphens binds no uuid parameter
	byOwner.bind({ owner: "0193d8f2" })
]

/** A fact's uuid field is a uuid, and its text field of its own pattern. */
export const ledgerWrites = (plain: string) => {
	const written = ChangeSet.empty(Books).insert(Ledger, [
		{ id: ledgerId, owner: ownerId, answer: "yes", grade: "pass" }
	])
	const parsed = Uuid.parse(plain)
	const fromParse = parsed.ok
		? [
				ChangeSet.empty(Books).insert(Ledger, [
					{ id: parsed.value, owner: ownerId, answer: "no", grade: "fail" }
				])
			]
		: []
	const short = ChangeSet.empty(Books).insert(Ledger, [
		// @ts-expect-error -- TS2322: a text with fewer than four hyphens is no uuid
		{ id: "0193d8f2", owner: ownerId, answer: "yes", grade: "pass" }
	])
	const unparsed = ChangeSet.empty(Books).insert(Ledger, [
		// @ts-expect-error -- TS2322: a plain string is no uuid; Uuid.parse makes it one
		{ id: plain, owner: ownerId, answer: "yes", grade: "pass" }
	])
	const crossed = ChangeSet.empty(Books).insert(Ledger, [
		// @ts-expect-error -- TS2322: "yes" is Answer's, no value of Grade's pattern
		{ id: ledgerId, owner: ownerId, answer: "yes", grade: "yes" }
	])
	return [written, fromParse, short, unparsed, crossed]
}

/**
 * Two patterns' terms meet as texts, in a join and a comparison; a JavaScript value at a refined text column, opposite
 * one of its terms, in its list or as its typed constant is of that column's own pattern.
 */
export const gradedAsAnswered = query(Books).rule((r) => {
	const { id, answer, grade } = v(Ledger, "ledger")
	return r.match(Ledger, { id, answer, grade }).where(r.eq(grade, answer)).find({ id })
})
export const answerJoinsGrade = query(Books).rule((r) => {
	const { id, answer } = v(Ledger, "ledger")
	return r.match(Ledger, { id, answer, grade: answer }).find({ id, answer })
})
export type AnswerJoinsGradeHead = Expect<
	Equals<HeadOf<typeof answerJoinsGrade>, { readonly id: Uuid; readonly answer: "yes" | "no" }>
>
export const passing = query(Books).rule((r) => {
	const { id, grade } = v(Ledger, "ledger")
	return r
		.match(Ledger, { id, grade, answer: "yes" })
		.where(
			r.ne(grade, "fail"),
			r.inSet(grade, ["pass"]),
			r.eq(grade, Compute.literal(Grade, "pass"))
		)
		.find({ id })
})
export const refusedLanguages = () => [
	query(Books).rule((r) => {
		const { id } = v(Ledger, "ledger")
		// @ts-expect-error -- TS2322: "yes" is Answer's, no value of Grade's pattern
		return r.match(Ledger, { id, grade: "yes" }).find({ id })
	}),
	query(Books).rule((r) => {
		const { id, grade } = v(Ledger, "ledger")
		// @ts-expect-error -- TS2345: "yes" is Answer's, no operand of a Grade term
		return r.match(Ledger, { id, grade }).where(r.eq(grade, "yes")).find({ id })
	}),
	query(Books).rule((r) => {
		const { id, grade } = v(Ledger, "ledger")
		return (
			r
				.match(Ledger, { id, grade })
				// @ts-expect-error -- TS2322: "yes" is Answer's, no member of a Grade list
				.where(r.inSet(grade, ["yes"]))
				.find({ id })
		)
	}),
	// @ts-expect-error -- TS2345: "yes" is Answer's, no typed constant of Grade
	Compute.literal(Grade, "yes")
]

/**
 * A union's key is of the language its arms deliver: a JavaScript value outside the typed arm's pattern widens it to
 * text, as the checker's common type widens a refined text, so the other arm's value binds there.
 */
export const answeredOrMaybe = query(Books)
	.rule((r) => {
		const { id, answer } = v(Ledger, "ledger")
		return r.match(Ledger, { id, answer }).find({ id, answer })
	})
	.rule((r) => {
		const { id } = v(Ledger, "ledger")
		return r.match(Ledger, { id }).find({ id, answer: "maybe" })
	})
export const maybes = query(Books).rule((r) => {
	const { id } = v(answeredOrMaybe, "answered")
	return r.match(answeredOrMaybe, { id, answer: "maybe" }).find({ id })
})
