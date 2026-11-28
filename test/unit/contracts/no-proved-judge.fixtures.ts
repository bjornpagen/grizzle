/**
 * What the no-proved-judge contract (no-proved-judge.test.ts) reads: its space of laws over a parent and its children,
 * each compiled into an installation, and the model of which deltas a law's judge can be proven never to need.
 *
 * A shape is a unit Doc of `doc`; a parent P(doc, p, pv) keyed by (doc, p); and one or two children Ci(doc, p, ci, cvi)
 * keyed by (doc, p, ci), each held to P at (doc, p) by a containment, a foreign key, or not; each relation closed or
 * mutable inside the unit. The law is a check over X, the join of P and the children at (doc, p): each child's cvi at
 * most its parent's pv, X delivering (doc, pv, cv0[, cv1]), a document's own heading, which the installation reads live
 * and holds the check over by its rule judge, or that and (p, c0), the first child's key, which it may store X by,
 * holding the check by its stored table's natives, its upkeep re-deriving the rows a write touched
 * (analysis/derived/storage.ts).
 */

import { defined } from "@bjornpagen/testing/assert"
import { boolean, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import { countColumn } from "#compiler/physical/ddl/deltas.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { int8 } from "#compiler/public/fields.ts"
import { check, contained, mutable, on, schema, unit } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { derivedBuilder, relationBuilder } from "#compiler/schema/relation.ts"
import { schemaBuilder } from "#compiler/schema/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { capturedDeltasOf, type JudgeStatement } from "#test/support/judge.ts"
import { owning } from "#test/support/policy.ts"

/** The parent: whether it is mutable inside the unit. */
interface Parent {
	readonly mutable: boolean
}

/** A child: whether it is mutable inside the unit, and whether a foreign key holds it to the parent at (doc, p). */
interface Held extends Parent {
	readonly contained: boolean
}

/**
 * A shape: its parent, its children, and whether X delivers the first child's key, (doc, p, c0), beside the values,
 * which the installation may store X by (analysis/derived/storage.ts), or (doc) alone, which it reads live.
 */
interface LawShape {
	readonly parent: Parent
	readonly children: readonly [Held] | readonly [Held, Held]
	readonly wide: boolean
}

const heldGen: Gen<Held> = (source) => ({
	mutable: source.draw(boolean),
	contained: source.draw(boolean)
})

export const lawShapeGen: Gen<LawShape> = (source) => {
	const first = source.draw(heldGen)
	return {
		parent: { mutable: source.draw(boolean) },
		children: source.draw(int(1, 2)) === 1 ? [first] : [first, source.draw(heldGen)],
		wide: source.draw(boolean)
	}
}

export const parentName = "P"
const childName = (at: number): string => `C${at}`

/** The relations the law reads, each by its name: the parent, then its children. */
export const lawRelations = (
	s: LawShape
): ReadonlyArray<{ readonly name: string; readonly held: Parent }> => [
	{ name: parentName, held: s.parent },
	...Arr.map(s.children, (held, at) => ({ name: childName(at), held }))
]

/** The shape's schema: the base of P and its children, and X with the check above it. */
const schemaOf = (s: LawShape) => {
	const P = relationBuilder(parentName, { doc: int8, p: int8, pv: int8 }, ["doc", "p"], [])
	const children = Arr.map(s.children, (_, at) =>
		relationBuilder(
			childName(at),
			{ doc: int8, p: int8, [`c${at}`]: int8, [`cv${at}`]: int8 },
			["doc", "p", `c${at}`],
			[]
		)
	)
	const child = (at: number) => defined(children[at], "a child")
	const base = schema(
		"Judged",
		[P, ...children],
		[
			unit("Doc", { doc: int8 }),
			...(s.parent.mutable ? [mutable(P)] : []),
			...Arr.flatMap(s.children, (c, at) => [
				...(c.mutable ? [mutable(child(at))] : []),
				...(c.contained ? [contained(on(child(at), "doc", "p"), on(P, "doc", "p"))] : [])
			])
		]
	)
	const X = derivedBuilder(
		"X",
		queryOver(base).rule((r: RuleValue) => {
			const p = varsOver(P, "p")
			let ruled = r.match(P, { doc: p["doc"], p: p["p"], pv: p["pv"] })
			const values: Array<readonly [string, unknown]> = s.wide ? [["p", p["p"]]] : []
			for (const at of Arr.map(s.children, (_, i) => i)) {
				const c = varsOver(child(at), `c${at}`)
				ruled = ruled.match(child(at), {
					doc: p["doc"],
					p: p["p"],
					[`c${at}`]: c[`c${at}`],
					[`cv${at}`]: c[`cv${at}`]
				})
				values.push([`cv${at}`, c[`cv${at}`]])
				if (s.wide && at === 0) {
					values.push(["c0", c["c0"]])
				}
			}
			return ruled.find({ doc: p["doc"], pv: p["pv"], ...Rec.fromEntries(values) })
		}),
		[]
	)
	return schemaBuilder.extend(
		[base],
		"Judged_1",
		[X],
		[
			check("Bounded", X, (x) =>
				x.and(
					Arr.map(s.children, (_, at) =>
						x.le(defined(x[`cv${at}`], "a child's value"), defined(x["pv"], "the parent's value"))
					)
				)
			)
		],
		[]
	)
}

/** The shape's installation, as the fresh-install compiler compiles it. */
export const installationOf = (s: LawShape): Installation => {
	const owned = owning(schemaOf(s))
	return succeeded(compileInstallation(owned, installOptions(owned)))
}

/** A side of a relation's writes the judge holds a delta of: its news, the rows a write adds, or its olds. */
type Side = "news" | "olds"

/**
 * The deltas of each relation the law reads, by its name and side, from the relation's capture (support/judge.ts): its
 * news counts each image it holds (deltas.ts countColumn), its olds do not; a side the capture writes no delta of is
 * none, as a closed relation's olds are.
 */
export const deltasOf = (
	installation: Installation,
	s: LawShape
): ReadonlyMap<string, ReadonlyMap<Side, string>> =>
	new Map(
		Arr.map(lawRelations(s), ({ name }) => {
			const captured = capturedDeltasOf(installation, name)
			return [
				name,
				new Map(
					Arr.map(
						captured,
						(d) => [d.columns.includes(countColumn) ? "news" : "olds", d.name] as const
					)
				)
			] as const
		})
	)

/**
 * What the model proves of each delta of a relation the law reads (see no-proved-judge.test.ts): its olds, where the
 * relation is closed, which no write fills; and P's news, where P is closed and a child is held to it at (doc, p),
 * which every occurrence of P in X is joined to the child at: a fresh P row's key is one no stored row of P held, so no
 * stored child row references it, and it meets only a child row the same write adds, which that child's news drives.
 */
export const provedEmpty = (
	s: LawShape
): ReadonlyArray<{ readonly relation: string; readonly side: Side }> => [
	...Arr.flatMap(lawRelations(s), ({ name, held }) =>
		held.mutable ? [] : [{ relation: name, side: "olds" as const }]
	),
	...(!s.parent.mutable && Arr.some(s.children, (c) => c.contained)
		? [{ relation: parentName, side: "news" as const }]
		: [])
]

/** The judge's statements that read `delta`. */
export const readersOfDelta = (
	statements: ReadonlyArray<JudgeStatement>,
	delta: string
): ReadonlyArray<JudgeStatement> => Arr.filter(statements, (st) => st.deltas.has(delta))
