/** What the properties of rewrites.test.ts read: its spaces, models and helpers. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { familyTemplate } from "#test/pg/fin/family.ts"
import type { EndFeature } from "#test/pg/fin/installed.ts"
import { nonEmpty } from "#test/support/assert.ts"
import type { MutationStatement } from "#test/support/families/mutate.ts"
import { type Families, familyRowsFrom } from "#test/support/families/theorem.ts"
import { upTo } from "#test/support/up-to.ts"

/** A rewrite of owner 0's family: what it does, and the slot its suffix starts at with the suffix it writes there. */
type Form = "remove" | "insert-at" | "swap" | "append"

/** How its statements are sent: as the planner sends them, the count update first, or the inserts before the deletes. */
type Sending = "prescribed" | "count first" | "inserts first"

interface Rewrite {
	readonly form: Form
	readonly members: ReadonlyArray<number>
	readonly at: number
	readonly suffix: ReadonlyArray<number>
	readonly sending: Sending
}

/** The member owner 1 holds, untouched by every rewrite of owner 0. */
const BESIDE = 100

/** A new member, numbered after every member. */
const NEW = 50

export const before = (members: ReadonlyArray<number>): Families => [
	{ owner: 0, members },
	{ owner: 1, members: [BESIDE] }
]

/** Every rewrite of every family of zero to four members. */
const REWRITES: Arr.NonEmptyReadonlyArray<Omit<Rewrite, "sending">> = nonEmpty(
	Arr.flatMap(Arr.range(0, 4), (n) => {
		const members = upTo(n, (i) => i)
		const removes = Arr.map(members, (_, a) => ({
			form: "remove" as const,
			members,
			at: a,
			suffix: members.slice(a + 1)
		}))
		const inserts = upTo(n + 1, (a) => ({
			form: "insert-at" as const,
			members,
			at: a,
			suffix: [NEW, ...members.slice(a)]
		}))
		const swaps = Arr.flatMap(members, (_, i) =>
			Arr.flatMap(members, (__, j) => {
				if (j <= i) {
					return []
				}
				const swapped = Arr.map(members, (m, k) =>
					k === i ? Arr.getUnsafe(members, j) : k === j ? Arr.getUnsafe(members, i) : m
				)
				return [{ form: "swap" as const, members, at: i, suffix: swapped.slice(i) }]
			})
		)
		const appends = [{ form: "append" as const, members, at: n, suffix: [NEW] }]
		return [...removes, ...inserts, ...swaps, ...appends]
	}),
	"a rewrite"
)

const SENDINGS: Arr.NonEmptyReadonlyArray<Sending> = ["prescribed", "count first", "inserts first"]

export const rewriteGen: Gen<Rewrite> = (source) => ({
	...source.draw(element(REWRITES)),
	sending: source.draw(element(SENDINGS))
})

/** A rewrite's statements in its sending, and the families the prescribed order commits to. */
export const statementsOf = (
	r: Rewrite
): { readonly statements: ReadonlyArray<MutationStatement>; readonly after: Families } => {
	const count = r.at + r.suffix.length
	const deleted = r.members.slice(r.at)
	const deletes: ReadonlyArray<MutationStatement> = Arr.isReadonlyArrayNonEmpty(deleted)
		? [{ kind: "delete", members: deleted }]
		: []
	const counts: ReadonlyArray<MutationStatement> =
		r.members.length === count ? [] : [{ kind: "count", owner: 0, count }]
	const rows = familyRowsFrom(0, r.suffix, r.at, count)
	const inserts: ReadonlyArray<MutationStatement> = Arr.isReadonlyArrayNonEmpty(rows)
		? [{ kind: "insert", rows }]
		: []
	const statements = (() => {
		switch (r.sending) {
			case "prescribed":
				return [...deletes, ...counts, ...inserts]
			case "count first":
				return [...counts, ...deletes, ...inserts]
			case "inserts first":
				return [...counts, ...inserts, ...deletes]
		}
	})()
	return { statements, after: before([...r.members.slice(0, r.at), ...r.suffix]) }
}

/** Whether a rewrite lowers its family's count: a shrink. */
export const shrinks = (r: Rewrite): boolean => r.at + r.suffix.length < r.members.length

export type RewriteFeature =
	| EndFeature
	| `${Form} ${Sending} ${"committed" | "refused"}`
	| "a shrink sent count first refused at its count by the bound, 23514, reporting the family's law"

/** The ordered family installed once per member (family.ts familyTemplate), which each case's seat holds. */
export const rewritesTemplate = familyTemplate(import.meta, "ordered", "rewrites")
