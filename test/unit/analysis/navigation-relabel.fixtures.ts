/** What navigation-relabel.test.ts reads: its space, its rule over a relabeled equality, and the keys each step reads at. */

import { assert } from "@bjornpagen/testing/assert"
import { type Gen, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter, Record as Rec } from "effect"
import { queryColumns } from "#compiler/analysis/theory/columns.ts"
import { Navigation, navigateQuery } from "#compiler/analysis/theory/navigate.ts"
import { buildTheory } from "#compiler/analysis/theory/theory.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { InferredExpr, InferredQuery, InferredRule } from "#compiler/ir/desc.ts"
import { queryInput } from "#compiler/program/input.ts"
import { Logic, Type } from "#compiler/public/compute.ts"
import { contract, int4, int8 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { key, on, relation, schema } from "#compiler/public/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { checking } from "#test/support/policy.ts"

/**
 * The four matches of qti-pie's LinearPresentations as a judge of the later presentation reads them: the later
 * presentation, the written row, at the call's parameters; its place, at the same key, which binds its prior; the
 * earlier member's place, at the place the prior is the base of; and the earlier member's presentation, at that place's
 * path.
 */
export type Match = "after presented" | "after place" | "member place" | "member presented"

/** A case: the order the rule writes its four matches in. */
export type Order = ReadonlyArray<Match>

const matches: Arr.NonEmptyReadonlyArray<Match> = [
	"after presented",
	"after place",
	"member place",
	"member presented"
]

export const orderGen: Gen<Order> = shuffled(matches, { min: 4, max: 4 })

export type Reached =
	| "the member's presentation written before its place"
	| "the member's place written before its presentation"
	| "the written row's matches written last"

const placingKey = Symbol("Placing")
/** A place in a sitting's order: a whole number from 1, a domain over bigint as qti-pie's `natural` is. */
const Placing = contract<typeof placingKey>()("Placing", int8, (x) => Logic.ge(x, 1n))

const Presented = relation("Presented", { child: int4, stage: int4, path: int4, at: int8 }, [
	"child",
	"stage",
	"path"
])

const Place = relation(
	"Place",
	{ child: int4, stage: int4, path: int4, place: Placing, prior: int8 },
	["child", "stage", "path"]
)

const Linear = schema(
	"navigation_relabel",
	[Presented, Place],
	[key(on(Place, "child", "stage", "place")), key(on(Place, "child", "stage", "prior"))]
)

const loc = SourceLoc("navigation relabel", [])
const columns = queryColumns(checking(Linear), loc)

/** The keys Linear's theory holds of each relation, its primary key and each key it states (RegionFacts `keys`). */
const facts = succeeded(buildTheory(checking(Linear))).regionFacts

/** The case's rule: the four matches in the case's order, the after member's prior the base of the member's place. */
const queryOf = (order: Order): InferredQuery =>
	succeeded(
		queryInput(
			query(Linear).rule((r) => {
				const child = r.param("child", int4)
				const stage = r.param("stage", int4)
				const path = r.param("path", int4)
				const { at: afterAt } = v(Presented, "after")
				const { prior } = v(Place, "afterPlace")
				const { path: memberPath, place } = v(Place, "memberPlace")
				const { at: memberAt } = v(Presented, "member")
				const step = (m: Match, rule: typeof r): typeof r => {
					switch (m) {
						case "after presented":
							return rule.match(Presented, { child, stage, path, at: afterAt })
						case "after place":
							return rule.match(Place, { child, stage, path, prior })
						case "member place":
							return rule.match(Place, { child, stage, path: memberPath, place })
						case "member presented":
							return rule.match(Presented, { child, stage, path: memberPath, at: memberAt })
					}
				}
				return Arr.reduce(order, r, (rule, m) => step(m, rule))
					.where(r.eq(prior, Type.base(place)))
					.find({ after: afterAt, member: memberAt })
			})
		)
	).desc

/** `e` read through each `Type.base` around it. */
const unwrapped = (e: InferredExpr): InferredExpr => (e.kind === "base" ? unwrapped(e.arg) : e)

/**
 * The columns of match `m` of step rule `r` a parameter binds, the step's channels among them: bound to one, or to a
 * variable a condition of the step equates with one, through each `Type.base` either side holds, which the step prints
 * inside its subquery, where PostgreSQL seeks the relation by it.
 */
const keyedColumns = (
	r: InferredRule,
	m: InferredRule["matches"][number]
): ReadonlyArray<string> => {
	const atParam = new Set(
		Arr.flatMap(r.where, (w) => {
			if (w.kind !== "compare" || w.op !== "eq") {
				return []
			}
			const left = unwrapped(w.left)
			const right = unwrapped(w.right)
			return left.kind === "var" && right.kind === "param"
				? [left.var]
				: right.kind === "var" && left.kind === "param"
					? [right.var]
					: []
		})
	)
	return Arr.filter(Rec.keys(m.bindings), (column) => {
		const e = m.bindings[column]
		return e?.kind === "param" || (e?.kind === "var" && atParam.has(e.var))
	})
}

/** Each relation a step of `q` reads, at any depth, with the columns it is sought by (`keyedColumns`). */
const stepReads = (
	q: InferredQuery
): ReadonlyArray<{ readonly relation: string; readonly keyed: ReadonlyArray<string> }> => {
	const out: Array<{ readonly relation: string; readonly keyed: ReadonlyArray<string> }> = []
	const rules = (query: InferredQuery, inStep: boolean): void => {
		if (query.stage.kind !== "rules") {
			return
		}
		for (const rule of query.stage.arms) {
			for (const m of rule.matches) {
				if (m.source.kind === "relation" && inStep) {
					out.push({ relation: m.source.name, keyed: keyedColumns(rule, m) })
				} else if (m.source.kind === "step") {
					rules(m.source.query, true)
				}
			}
		}
	}
	rules(q, false)
	return out
}

/**
 * Judges case `order`: whatever order the rule writes its matches in, each of the four is read by a step sought at a
 * key of its relation, one row at most, the member's place at (child, stage, place) once the after place has bound the
 * prior it is the base of, and its presentation at that place's path: never the sitting's every presentation.
 */
export const readAtKeys = (order: Order, note: (r: Reached) => void): void => {
	note(
		order.indexOf("member presented") < order.indexOf("member place")
			? "the member's presentation written before its place"
			: "the member's place written before its presentation"
	)
	if (order.indexOf("after presented") >= 2 && order.indexOf("after place") >= 2) {
		note("the written row's matches written last")
	}
	const navigated = navigateQuery(
		queryOf(order),
		loc,
		columns,
		{ kind: "perStatement", extent: "units" },
		new Navigation(facts)
	)
	const reads = stepReads(navigated)
	const shown = `${Formatter.format(order)}: the steps read ${Formatter.format(reads)}`
	assert.equal(reads.length, 4, `${shown}\neach of the four matches is a step of its own`)
	for (const read of reads) {
		const keys = facts.keys.get(read.relation) ?? []
		assert.ok(
			Arr.some(keys, (k) => Arr.every(k, (f) => read.keyed.includes(f))),
			`${shown}\n${read.relation} is read at ${Formatter.format(read.keyed)}, no key of it (${Formatter.format(keys)})`
		)
	}
}
