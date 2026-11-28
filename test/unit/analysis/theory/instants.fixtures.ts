/** What the property of instants.test.ts reads: its box, its model and its helpers. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import {
	contained,
	f,
	ge,
	literal,
	field,
	on,
	onWhere,
	pred,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import { schemaOf } from "#test/support/unit/analysis/theory/support.ts"

/**
 * One case of the box: three relations over an integer `c` and an instant `at`, P(c, at), Q(c, at, v) and X(c, at), and
 * the containments between their instants.
 *
 * - `pKey`: P keyed (c, at), so its clock's child is c; (at, c), its clock first in its key, of no child; or (c), its at
 *   outside its key.
 * - `qKey`: Q keyed (c, at, v), or (c, v), its at outside its key.
 * - `q`: Q's containment into P: (c, at) from every row of Q; from Q's rows of v ≥ 0, a selection; (at) alone, which
 *   carries no child; or none into P but Q's own gapless law, Q(c, at, pred(v)) within Q(c, at, v), whose pred term
 *   holds only where v is above zero, so it carries no row of v 0.
 * - `x`: X's containments: into Q at (c, at), into P at (c, at), into both, or none.
 * - `p`: P's containment into X at (c, at), every row of P, which closes a cycle where X's reach P; or none.
 */
export interface InstantsCase {
	readonly pKey: "c,at" | "at,c" | "c"
	readonly qKey: "c,at,v" | "c,v"
	readonly q: "whole" | "selected" | "unchilded" | "gapless" | "none"
	readonly x: "q" | "p" | "both" | "none"
	readonly p: "x" | "none"
}

export const instantsGen: Gen<InstantsCase> = (source) => ({
	pKey: source.draw(element(["c,at", "at,c", "c"] as const)),
	qKey: source.draw(element(["c,at,v", "c,v"] as const)),
	q: source.draw(element(["whole", "selected", "unchilded", "gapless", "none"] as const)),
	x: source.draw(element(["q", "p", "both", "none"] as const)),
	p: source.draw(element(["x", "none"] as const))
})

const keyOf = (spelled: string): ReadonlyArray<string> => Str.split(spelled, ",")

/** The case's relations, in the order of their names in code points. */
type Rel = "P" | "Q" | "X"
const rels: ReadonlyArray<Rel> = ["P", "Q", "X"]

/** A containment of the case, as the model reads it: its source and target relations, and each target field the
 * source field it pairs with, from every row of its source, from a selection of it, or with a pred term of v over
 * the source, which pairs pred(v) with v. */
interface Carried {
	readonly from: Rel
	readonly to: Rel
	readonly pairs: ReadonlyArray<readonly [string, string]>
	readonly whole: boolean
	readonly pred: boolean
}

/** The case's containments, in the order its schema states them. */
const carriedOf = (c: InstantsCase): ReadonlyArray<Carried> => {
	const childed: ReadonlyArray<readonly [string, string]> = [
		["c", "c"],
		["at", "at"]
	]
	const q: ReadonlyArray<Carried> =
		c.q === "none"
			? []
			: c.q === "gapless"
				? [{ from: "Q", to: "Q", pairs: childed, whole: true, pred: true }]
				: [
						{
							from: "Q",
							to: "P",
							pairs: c.q === "unchilded" ? [["at", "at"]] : childed,
							whole: c.q !== "selected",
							pred: false
						}
					]
	const intoQ: Carried = { from: "X", to: "Q", pairs: childed, whole: true, pred: false }
	const intoP: Carried = { from: "X", to: "P", pairs: childed, whole: true, pred: false }
	const x: ReadonlyArray<Carried> = [
		...(c.x === "q" || c.x === "both" ? [intoQ] : []),
		...(c.x === "p" || c.x === "both" ? [intoP] : [])
	]
	const p: ReadonlyArray<Carried> =
		c.p === "x" ? [{ from: "P", to: "X", pairs: childed, whole: true, pred: false }] : []
	return [...q, ...x, ...p]
}

/** The case's schema: P, Q and X, and its containments (carriedOf). */
export const instantsSchema = (c: InstantsCase): SchemaDesc =>
	schemaOf(
		[
			relation("P", { c: f.integer, at: f.instant }, keyOf(c.pKey)),
			relation("Q", { c: f.integer, at: f.instant, v: f.natural }, keyOf(c.qKey)),
			relation("X", { c: f.integer, at: f.instant }, ["c", "at"])
		],
		Arr.map(carriedOf(c), (k) =>
			k.pred
				? contained(on(k.from, ["c", "at", pred("v")]), on(k.to, ["c", "at", "v"]))
				: contained(
						k.whole
							? on(
									k.from,
									Arr.map(k.pairs, ([, from]) => from)
								)
							: onWhere(
									k.from,
									Arr.map(k.pairs, ([, from]) => from),
									ge(field("v"), literal(0n))
								),
						on(
							k.to,
							Arr.map(k.pairs, ([to]) => to)
						)
					)
		)
	)

/** A stamp as the model states it: the clock's relation, and the stamped row's fields holding its child, in order. */
export interface ModelStamp {
	readonly clock: string
	readonly child: ReadonlyArray<string>
}

/** An instant's role as the model states it: a clock with its stamp, or a reference with its containments' count and
 * its stamp, none where it has none. */
export type ModelRole =
	| { readonly kind: "clock"; readonly stamp: ModelStamp }
	| {
			readonly kind: "reference"
			readonly carriers: number
			readonly stamp: ModelStamp | undefined
	  }

/** What the model says of a case: the clock it refuses, outside its key or first in it, the first by relation name, or
 * each relation's `at` with its role. */
export type ModelVerdict =
	| {
			readonly kind: "refused"
			readonly relation: Rel
			readonly rule: "clockOutsideKey" | "childless"
	  }
	| { readonly kind: "roles"; readonly roles: ReadonlyMap<string, ModelRole> }

/**
 * The model of the classifier (ir/instant.ts), stated again over the case's own shape: an instant is a reference where
 * a containment from every row of its relation pairs it with another relation's instant, else a clock, which stands in
 * its primary key, its child the key's fields before it; a reference is stamped by the one clock its containments all
 * reach at the child each carries its row to, by none where one reaches none, a clock at a child it does not pair, or
 * another clock or child than the rest. A walk that meets a relation again reaches no clock.
 */
export const modelOf = (c: InstantsCase): ModelVerdict => {
	const keys: Readonly<Record<Rel, ReadonlyArray<string>>> = {
		P: keyOf(c.pKey),
		Q: keyOf(c.qKey),
		X: ["c", "at"]
	}
	const carriers = (r: Rel): ReadonlyArray<Carried> =>
		Arr.filter(carriedOf(c), (k) => k.whole && !k.pred && k.from === r)
	for (const r of rels) {
		const key = keys[r]
		if (carriers(r).length === 0 && key.indexOf("at") < 1) {
			return {
				kind: "refused",
				relation: r,
				rule: key.includes("at") ? "childless" : "clockOutsideKey"
			}
		}
	}
	const stampOf = (r: Rel, seen: ReadonlyArray<Rel>): ModelStamp | undefined => {
		const key = keys[r]
		const own = carriers(r)
		if (own.length === 0) {
			return { clock: r, child: key.slice(0, key.indexOf("at")) }
		}
		if (seen.includes(r)) {
			return undefined
		}
		const through = Arr.map(own, (k) => {
			const target = stampOf(k.to, [...seen, r])
			if (target === undefined) {
				return undefined
			}
			const paired = Arr.map(target.child, (t) =>
				Option.getOrUndefined(Arr.findFirst(k.pairs, ([to]) => to === t))
			)
			const child = Arr.flatMap(paired, (p) => (p === undefined ? [] : [p[1]]))
			return child.length === paired.length ? { clock: target.clock, child } : undefined
		})
		const [first, ...rest] = through
		return first !== undefined &&
			Arr.every(
				rest,
				(s) =>
					s !== undefined &&
					s.clock === first.clock &&
					s.child.length === first.child.length &&
					Arr.every(s.child, (n, i) => first.child[i] === n)
			)
			? first
			: undefined
	}
	return {
		kind: "roles",
		roles: new Map(
			Arr.map(rels, (r): readonly [string, ModelRole] => {
				const own = carriers(r)
				const key = keys[r]
				return [
					r,
					own.length === 0
						? { kind: "clock", stamp: { clock: r, child: key.slice(0, key.indexOf("at")) } }
						: { kind: "reference", carriers: own.length, stamp: stampOf(r, []) }
				]
			})
		)
	}
}

/** What a case reaches. */
export type InstantsFeature =
	| "a clock outside its key, refused"
	| "a clock first in its key, refused"
	| "a clock with a child"
	| "a reference stamped through another reference"
	| "a reference stamped by its clock directly"
	| "a reference no clock stamps: no child carried"
	| "a reference no clock stamps: two clocks"
	| "a reference no clock stamps: a cycle"
	| "a containment over a selection carries nothing"
	| "a containment with a pred term carries nothing"
