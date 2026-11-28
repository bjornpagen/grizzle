/** What the property of rewrite-checks.test.ts reads: its space, the schema's versions and what their drafts check. */

import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import { planFiles } from "#compiler/deploy/phases/files.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { Text } from "#compiler/public/compute.ts"
import {
	accumulated,
	closedId,
	drawn,
	generated,
	natural,
	bool,
	int4,
	int8
} from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	check,
	closed,
	counted,
	derived,
	fin,
	fold,
	Monoid,
	on,
	relation,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { asDrafted, draftChain, fromEmpty, noDeclarations } from "#test/support/migrate/kit.ts"

/**
 * A rule over a query of the schema, each over a column no other reads: Capped, Gs' `g`, T1's generated cap of its
 * tier; Plain, Xs' `x`, T1's caller field; Unsigned, Hs' `h`, T2's generated sign of its text; Bounded, Totals' `total`,
 * O's sum of its members' amounts. Each derived relation a rule reads is live, so the rule is judged over a query: Gs,
 * Xs and Hs deliver no document, so their heads hide the unit (analysis/derived/storage.ts), and Totals reads O, in no
 * unit.
 */
export const laws = ["Capped", "Plain", "Unsigned", "Bounded"] as const
export type Law = (typeof laws)[number]

/**
 * A stored derived relation of the schema: XsView over T1, each document's amount, unit-local in the unit Document,
 * which the installation stores. None stands over O, whose `total` its fold rewrites in place, which no stored relation
 * reads.
 */
export const views = ["XsView"] as const
export type View = (typeof views)[number]

/**
 * What the second version changes: nothing; a cap of the closed Cap, which T1's `g` reads by C.at (`cap`); T2's `h`
 * generation, the sign it tests for (`generation`); or the field O's fold sums (`fold`), so the backfill draws every
 * `total` again.
 */
const changes = ["none", "cap", "generation", "fold"] as const
export type Change = (typeof changes)[number]

export const changeGen: Gen<Change> = (s) => s.draw(element(changes))

/**
 * The rules a change's migration checks again, by the schema's own reads: each rule that reads a column whose values the
 * migration writes again, and no other, Plain reading T1's `x` beside the `g` a cap rewrites.
 */
export const checkedBy = (change: Change): ReadonlyArray<Law> => {
	switch (change) {
		case "none":
			return []
		case "cap":
			return ["Capped"]
		case "generation":
			return ["Unsigned"]
		case "fold":
			return ["Bounded"]
	}
}

/** The stored relations a change's migration creates again: each above a table a column of which it writes again. */
export const recreatedBy = (change: Change): ReadonlyArray<View> => {
	switch (change) {
		case "none":
		case "generation":
		case "fold":
			return []
		case "cap":
			return ["XsView"]
	}
}

const Tier = closed.ordered("Tier", ["low", "high"])

/** A sign and a digit, as T2's text holds them. */
const Signed = str.bytes(4, str.regex("^[-+]?[0-9]$", "u"))

/**
 * The schema at `version`: T1, each document's tier and amount `x`, and `g`, generated, the cap Cap holds for its tier;
 * T2, each document's signed text `s` and `h`, generated, whether `s` starts with a minus; O, each owner's counted
 * members M and `total`, the sum of their `x`; T1 and T2 in the unit Document, keyed by the document; and over them,
 * at level 1, Gs, Xs, Hs and Totals, each the column of its rule, Capped, Plain, Unsigned and Bounded, each live, and
 * XsView, stored. The second version holds the case's change: Cap's high cap 30 where it was 20, `h` testing for a plus, or the
 * fold summing `y`.
 */
const schemaOf = (change: Change, version: "first" | "second") => {
	const changed = (c: Change): boolean => version === "second" && change === c
	const Cap = closed.relation(
		"Cap",
		{ tier: closedId(Tier), cap: int4 },
		["tier"],
		[
			{ tier: "low", cap: 10 },
			{ tier: "high", cap: changed("cap") ? 30 : 20 }
		]
	)
	const T1 = relation.generated(
		"T1",
		{ doc: int4, tier: closedId(Tier), x: int4 },
		["doc"],
		(r) => ({ g: generated(int4, Cap.at("cap", r.tier)) })
	)
	const T2 = relation.generated("T2", { doc: int4, s: Signed }, ["doc"], (r) => ({
		h: generated(bool, Text.startsWith(r.s, changed("generation") ? "+" : "-"))
	}))
	const O = relation("O", { id: int4, n: drawn(natural), total: accumulated(int8, 0n) }, ["id"])
	const M = relation("M", { member: int4, o: int4, x: int8, y: int8 }, ["member"])
	const members = counted(on(M, "o"), fin(O, "n"))
	const Base = schema(
		"rewrite_checks",
		[T1, T2, O, M, Tier, Cap],
		[
			unit("Document", { doc: int4 }),
			members,
			fold(members, Monoid.sum, on(M, "o", changed("fold") ? "y" : "x"), on(O, "id", "total"))
		]
	)
	const Gs = derived(
		"Gs",
		query(Base).rule((r) => {
			const { doc, g } = v(T1, "t")
			return r.match(T1, { doc, g }).find({ g })
		})
	)
	const Xs = derived(
		"Xs",
		query(Base).rule((r) => {
			const { doc, x } = v(T1, "t")
			return r.match(T1, { doc, x }).find({ x })
		})
	)
	const Hs = derived(
		"Hs",
		query(Base).rule((r) => {
			const { doc, h } = v(T2, "t")
			return r.match(T2, { doc, h }).find({ h })
		})
	)
	/** Each document's amount of at least 0, a selection of T1's rows, so XsView is no copy of them
	 * (analysis/derived/storage.ts copiedRelation) and is stored. */
	const xs = query(Base).rule((r) => {
		const { doc, x } = v(T1, "t")
		return r.match(T1, { doc, x }).where(r.ge(x, 0)).find({ doc, x })
	})
	const Totals = derived(
		"Totals",
		query(Base).rule((r) => {
			const { id, total } = v(O, "o")
			return r.match(O, { id, total }).find({ id, total })
		})
	)
	return schema.extend(
		[Base],
		"rewrite_checks_1",
		[Gs, Xs, Hs, Totals, derived("XsView", xs)],
		[
			check("Capped", Gs, (d) => d.le(d.g, 25)),
			check("Plain", Xs, (d) => d.ge(d.x, 0)),
			check("Unsigned", Hs, (d) => d.eq(d.h, false)),
			check("Bounded", Totals, (d) => d.le(d.total, 1000n))
		]
	)
}

/** The law a check's identifier names, by its stem: its own name's. */
const lawOf = (id: string): Law =>
	Option.getOrThrowWith(
		Arr.findFirst(laws, (law) => Str.includes(`check_${Str.toLowerCase(law)}`)(id)),
		() => new Error(`a law of the schema, not ${id}`)
	)

/** The stored relation a created stored table is, by its identifier, its canonical form's (core/identity.ts view), as
 * the draft's snapshot records it. */
const viewOf =
	(snapshot: DeploySnapshot) =>
	(name: string): View =>
		Option.getOrThrowWith(
			Arr.findFirst(views, (view) => snapshot.theory.relations[view]?.ident === name),
			() => new Error(`a view of the schema, not ${name}`)
		)

/** What one draft checks and creates: each rule it checks over the stored rows, and each stored table it creates. */
export interface Drafted {
	readonly checked: ReadonlyArray<Law>
	readonly created: ReadonlyArray<View>
}

const draftedOf = (plan: Parameters<typeof planFiles>[0], snapshot: DeploySnapshot): Drafted => {
	const drafts = Arr.flatMap(planFiles(plan), (file) => file.drafts)
	return {
		checked: Arr.flatMap(drafts, (d) => (d.kind === "violation" ? [lawOf(d.law)] : [])),
		created: Arr.flatMap(drafts, (d) =>
			d.kind === "statement" && d.statement.kind === "createStoredTable"
				? [viewOf(snapshot)(d.statement.name.name)]
				: []
		)
	}
}

/** What the first version's draft, from no installation, and the second's, over it, check and create. */
export const drafted = (change: Change): { readonly first: Drafted; readonly second: Drafted } => {
	const [first, second] = draftChain(
		[
			{ desc: schemaOf(change, "first"), options: asDrafted, declared: noDeclarations },
			{ desc: schemaOf(change, "second"), options: asDrafted, declared: noDeclarations }
		],
		fromEmpty
	)
	const firstDraft = defined(first, "the first migration")
	const secondDraft = defined(second, "the second migration")
	return {
		first: draftedOf(firstDraft.plan, firstDraft.snapshot),
		second: draftedOf(secondDraft.plan, secondDraft.snapshot)
	}
}
