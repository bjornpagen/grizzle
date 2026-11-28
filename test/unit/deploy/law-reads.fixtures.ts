/** What the property of law-reads.test.ts reads: its space, its two versions and the checks their draft runs. */

import { defined } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { Declarations } from "#compiler/deploy/diff/plan.ts"
import { planFiles } from "#compiler/deploy/phases/files.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	check,
	contained,
	derived,
	key,
	mutable,
	on,
	relation,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { asDrafted, draftChain, fromEmpty, noDeclarations } from "#test/support/migrate/kit.ts"

/** A rule's law over D: a containment of S into it, a check over its facts, or a key over a projection of them. */
type Law = "contained" | "check" | "key"

/** What the second version does to T's `pay`, a column no law reads: drops it or renames it. */
type Change = "drop" | "rename"

/**
 * One case: its law; whether D's arm selects T by a literal of `a`; its judge, whole, T and S immutable, or probed, both
 * mutable inside the unit of their document and D's arm joining T to W, mutable in a unit of its own, so every rule
 * over D reads the rows of two units; and what the second version does to `pay`.
 */
interface Shape {
	readonly law: Law
	readonly selected: boolean
	readonly judge: "whole" | "probed"
	readonly change: Change
}

export const shapeGen: Gen<Shape> = (s) => ({
	law: s.draw(element<Law>(["contained", "check", "key"])),
	selected: s.draw(boolean),
	judge: s.draw(element<Shape["judge"]>(["whole", "probed"])),
	change: s.draw(element<Change>(["drop", "rename"]))
})

export type Reached =
	| "a whole rule kept unchecked"
	| "a probed rule kept unchecked"
	| "a column dropped"
	| "a column renamed"

/** T's fields but `pay`, which every law reads none of. */
const read = Object.freeze({ doc: int4, at: int4, a: int4, b: int4 })

/**
 * The schema of `shape` over T: S's references into D, T's facts by document and place with their `b`, selected by `a`
 * where the shape selects, each at a place W holds where the shape is probed; the rule its law states over D. T's
 * fourth column, unread, is `pay` in the first version, and absent or `paid` in the second.
 */
const schemaOf = (shape: Shape, unread: "pay" | "paid" | "none") => {
	const T = relation(
		"T",
		unread === "pay" ? { ...read, pay: int4 } : unread === "paid" ? { ...read, paid: int4 } : read,
		["doc", "at"]
	)
	const S = relation("S", { doc: int4, at: int4, ref: int4 }, ["doc", "at"])
	const W = relation("W", { wdoc: int4, at: int4 }, ["wdoc", "at"])
	const Base = schema(
		"law_reads",
		[T, S, W],
		shape.judge === "probed"
			? [
					unit("Document", { doc: int4 }),
					unit("Ws", { wdoc: int4 }),
					mutable(T),
					mutable(S),
					mutable(W)
				]
			: []
	)
	const D = derived(
		"D",
		query(Base).rule((r) => {
			const { doc, at, a, b } = v(T, "t")
			const matched = r.match(T, { doc, at, a: shape.selected ? 1 : a, b })
			return shape.judge === "probed"
				? matched.match(W, { wdoc: doc, at }).find({ doc, at, b })
				: matched.find({ doc, at, b })
		})
	)
	const law = (() => {
		switch (shape.law) {
			case "contained":
				return contained(on(S, "doc", "ref"), on(D, "doc", "at"))
			case "check":
				return check("Positive", D, (d) => d.ge(d.b, 0))
			case "key":
				return key(on(D, "doc", "b"))
		}
	})()
	return schema.extend([Base], "law_reads_1", [D], [law])
}

/** What the second version declares of `pay`: its drop, or its rename to `paid`. */
const declaredOf = (change: Change): Declarations => {
	const pay = { kind: "field" as const, relation: parsedName("T"), field: parsedName("pay") }
	switch (change) {
		case "drop":
			return { renames: [], drops: [pay] }
		case "rename":
			return {
				renames: [{ from: pay, to: { ...pay, field: parsedName("paid") } }],
				drops: []
			}
	}
}

/** The laws a draft checks over the rows it finds: each violation step of its plan, by its law. */
const checkedLaws = (plan: Parameters<typeof planFiles>[0]): ReadonlyArray<string> =>
	Arr.flatMap(planFiles(plan), (file) =>
		Arr.flatMap(file.drafts, (d) => (d.kind === "violation" ? [d.law] : []))
	)

/**
 * The laws the second version's draft checks again, and those the first's checked: the first drafted from no
 * installation, which checks every rule over a query it adds; the second from the first's snapshot, dropping or
 * renaming `pay`.
 */
export const drafted = (
	shape: Shape
): { readonly first: ReadonlyArray<string>; readonly second: ReadonlyArray<string> } => {
	const [first, second] = draftChain(
		[
			{ desc: schemaOf(shape, "pay"), options: asDrafted, declared: noDeclarations },
			{
				desc: schemaOf(shape, shape.change === "drop" ? "none" : "paid"),
				options: asDrafted,
				declared: declaredOf(shape.change)
			}
		],
		fromEmpty
	)
	return {
		first: checkedLaws(defined(first, "the first migration").plan),
		second: checkedLaws(defined(second, "the second migration").plan)
	}
}
