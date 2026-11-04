import type { Option } from "effect"
import { type HeadOf, query, type Uuid, v } from "#index.ts"
import { Account, AccountCost, Reports, Task, Work } from "#test/types/api/fixtures/schema.ts"
import type { Equals, Expect } from "#test/types/api/support.ts"

/**
 * An attachment from a derived relation to the base facts it summarizes: no law touches a derived
 * relation, so the compiler draws no containment evidence from its definition, and the attachment's delivery is licensed
 * by the base relation's own keys alone: an Option where those keys allow at most one fact, never the bare fact, and a
 * set where they allow several. The same attachment from the base relation, whose containment is declared, may be bare.
 * Every `@ts-expect-error -- TSnnnn` names the diagnostic the harness requires on the next line.
 *
 * Every AccountCost fact's account is a Task's account, which Account contains; the type knows only Account's key.
 */
export const costOwners = query(Reports)
	.rule((r) => {
		const { account, total } = v(AccountCost, "accountCost")
		return r.match(AccountCost, { account, total }).find({ account, total })
	})
	.attach(
		"owner",
		(c) =>
			query(Work).rule((r) => {
				const { name } = v(Account, "account")
				return r.match(Account, { id: c.account, name }).find({ name })
			}),
		"option"
	)
	.attach(
		"tasks",
		(c) =>
			query(Work).rule((r) => {
				const { id } = v(Task, "task")
				return r.match(Task, { id, account: c.account }).find({ id })
			}),
		"array"
	)

export type DerivedToBaseOwner = Expect<
	Equals<HeadOf<typeof costOwners>["owner"], Option.Option<{ readonly name: string }>>
>

export type DerivedToBaseTasks = Expect<
	Equals<HeadOf<typeof costOwners>["tasks"], ReadonlyArray<{ readonly id: Uuid }>>
>

export const bareOwner = (row: HeadOf<typeof costOwners>) => {
	// @ts-expect-error -- TS2322: a derived relation carries no containment into its base: the owner is an Option
	const owner: { readonly name: string } = row.owner
	return owner
}

/** The same attachment from Task, whose containment into Account is declared, delivers the owner bare. */
export const taskOwners = query(Work)
	.rule((r) => {
		const { id, account } = v(Task, "task")
		return r.match(Task, { id, account }).find({ id, account })
	})
	.attach(
		"owner",
		(t) =>
			query(Work).rule((r) => {
				const { name } = v(Account, "account")
				return r.match(Account, { id: t.account, name }).find({ name })
			}),
		"one"
	)

export type BaseToBaseOwner = Expect<
	Equals<HeadOf<typeof taskOwners>["owner"], { readonly name: string }>
>

/** Stating the derived relation's owner as the one child is refused: its evidence proves at most one owner per cost. */
export const costOwnerBare = () =>
	query(Reports)
		.rule((r) => {
			const { account, total } = v(AccountCost, "accountCost")
			return r.match(AccountCost, { account, total }).find({ account, total })
		})
		.attach(
			"owner",
			(c) =>
				// @ts-expect-error -- TS2322 refusal: the one child needs a child the evidence proves exactly one per parent
				query(Work).rule((r) => {
					const { name } = v(Account, "account")
					return r.match(Account, { id: c.account, name }).find({ name })
				}),
			"one"
		)
