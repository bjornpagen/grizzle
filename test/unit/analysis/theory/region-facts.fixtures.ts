/** What region-facts.test.ts reads: its box of schemas, the instances it draws over them, and its oracle. */

import { array, boolean, element, type Gen, int, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter, Option, Record as Rec } from "effect"
import type { FieldContainment } from "#compiler/analysis/theory/unit.ts"
import type { ExprDesc, TermDesc } from "#compiler/ir/desc.ts"
import { assert, defined } from "#test/support/assert.ts"
import {
	contained,
	counted,
	f,
	on,
	onWhere,
	pred,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"
import {
	drawnNatural,
	schemaOf,
	type TestTheory,
	violates
} from "#test/unit/analysis/theory/support.ts"

/** The box's four plain relations, each of the fields k, x and y. */
const plain = ["A", "B", "C", "D"] as const
type Plain = (typeof plain)[number]
const fields = ["k", "x", "y"] as const
type Field = (typeof fields)[number]

/** A row predicate a side's selection states: none, a field at one value, or a field among two. */
type Selection =
	| { readonly kind: "every" }
	| { readonly kind: "eq"; readonly field: Field; readonly value: bigint }
	| { readonly kind: "in"; readonly field: Field; readonly values: readonly [bigint, bigint] }

const every: Selection = { kind: "every" }

/** A term of a side: a field, or the field's predecessor, read where the field is above zero. */
interface Term {
	readonly field: string
	readonly pred: boolean
}

/** A containment the instance holds: a source's rows its selection admits, each met at the target's terms by a row its
 * selection admits. */
interface Requirement {
	readonly from: string
	readonly to: string
	readonly left: ReadonlyArray<Term>
	readonly right: ReadonlyArray<Term>
	readonly source: Selection
	readonly target: Selection
}

/** A stated containment between two plain relations. */
interface Containment extends Requirement {
	readonly from: Plain
	readonly to: Plain
}

/** A counted family of `member` under `owner`, its group the member's fields `group`, one per field of the owner's key. */
interface Family {
	readonly member: Plain
	readonly owner: Plain
	readonly group: ReadonlyArray<Field>
}

/** A schema of the box: each plain relation's key, its containments, at most one family, and whether its tree stands. */
export interface Box {
	readonly keys: Readonly<Record<Plain, Arr.NonEmptyReadonlyArray<Field>>>
	readonly containments: ReadonlyArray<Containment>
	readonly family: Family | undefined
	readonly tree: boolean
}

const valueGen: Gen<bigint> = (s) => BigInt(s.draw(int(0, 2)))

const selectionGen: Gen<Selection> = (s) => {
	switch (s.draw(int(0, 3))) {
		case 0:
			return { kind: "eq", field: s.draw(element(fields)), value: s.draw(valueGen) }
		case 1:
			return {
				kind: "in",
				field: s.draw(element(fields)),
				values: [s.draw(valueGen), s.draw(valueGen)]
			}
		default:
			return every
	}
}

/** `width` distinct fields of a side, each its predecessor where `preds` allows and the draw says. */
const termsGen =
	(width: number, preds: boolean): Gen<ReadonlyArray<Term>> =>
	(s) =>
		Arr.map(s.draw(shuffled(fields, { min: width, max: width })), (field) => ({
			field,
			pred: preds && s.draw(int(0, 3)) === 0
		}))

/** Another plain relation than `r`. */
const otherGen =
	(r: Plain): Gen<Plain> =>
	(s) =>
		defined(plain[(plain.indexOf(r) + 1 + s.draw(int(0, 2))) % plain.length], "a plain relation")

const containmentGen: Gen<Containment> = (s) => {
	const from = s.draw(element(plain))
	const width = s.draw(int(1, 2))
	return {
		from,
		to: s.draw(otherGen(from)),
		left: s.draw(termsGen(width, true)),
		right: s.draw(termsGen(width, false)),
		source: s.draw(selectionGen),
		target: s.draw(boolean) ? s.draw(selectionGen) : every
	}
}

const keyGen: Gen<Arr.NonEmptyReadonlyArray<Field>> = (s) => (s.draw(boolean) ? ["k"] : ["k", "x"])

const familyGen =
	(keys: Box["keys"]): Gen<Family> =>
	(s) => {
		const owner = s.draw(element(plain))
		const width = keys[owner].length
		return {
			owner,
			member: s.draw(otherGen(owner)),
			group: s.draw(shuffled(fields, { min: width, max: width }))
		}
	}

export const boxGen: Gen<Box> = (s) => {
	const keys = { A: s.draw(keyGen), B: s.draw(keyGen), C: s.draw(keyGen), D: s.draw(keyGen) }
	return {
		keys,
		containments: s.draw(array(containmentGen, { min: 1, max: 5 })),
		family: s.draw(boolean) ? s.draw(familyGen(keys)) : undefined,
		tree: s.draw(boolean)
	}
}

/** A side's selection as the builders state it. */
const predicateOf = (sel: Exclude<Selection, { readonly kind: "every" }>): ExprDesc =>
	sel.kind === "eq"
		? {
				kind: "compare",
				op: "eq",
				left: { kind: "field", field: sel.field },
				right: { kind: "literal", value: sel.value }
			}
		: { kind: "in", arg: { kind: "field", field: sel.field }, values: sel.values }

const sideOf = (relationName: string, terms: ReadonlyArray<Term>, sel: Selection) => {
	const descs = Arr.map(terms, (t): string | TermDesc => (t.pred ? pred(t.field) : t.field))
	return sel.kind === "every"
		? on(relationName, descs)
		: onWhere(relationName, descs, predicateOf(sel))
}

/** The fields every row of `relationName` holds: k, x and y, and an owner's drawn n; the tree's own. */
const headingOf = (box: Box, relationName: string): ReadonlyArray<string> =>
	relationName === "T"
		? ["k", "parent", "at", "n", "start", "end"]
		: [...fields, ...(box.family?.owner === relationName ? ["n"] : [])]

/** The box's schema: A, B and C of k, x and y, its family's owner also of a drawn n, and, where it stands, the tree T. */
export const schemaOfBox = (box: Box): SchemaDesc =>
	schemaOf(
		[
			...Arr.map(plain, (r) =>
				relation(
					r,
					{
						k: f.natural,
						x: f.natural,
						y: f.natural,
						...(box.family?.owner === r ? { n: drawnNatural } : {})
					},
					box.keys[r]
				)
			),
			...(box.tree
				? [
						relation(
							"T",
							{
								k: f.natural,
								parent: drawnNatural,
								at: drawnNatural,
								n: drawnNatural,
								start: drawnNatural,
								end: drawnNatural
							},
							["k", "start"]
						)
					]
				: [])
		],
		[
			...Arr.map(box.containments, (c) =>
				contained(sideOf(c.from, c.left, c.source), sideOf(c.to, c.right, c.target))
			),
			...(box.family === undefined
				? []
				: [
						counted(on(box.family.member, box.family.group), {
							owner: box.family.owner,
							count: "n"
						})
					]),
			...(box.tree
				? [
						{
							kind: "tree" as const,
							member: on("T", ["parent", "at"]),
							slots: { owner: "T", count: "n" },
							root: ["k"] as const
						}
					]
				: [])
		]
	)

/** A row of the box: every field a natural. */
type Row = Readonly<Record<string, bigint>>

/** Rows of each relation, a set by their values. */
export type Instance = Readonly<Record<string, ReadonlyArray<Row>>>

const admits = (row: Row, sel: Selection): boolean =>
	sel.kind === "every"
		? true
		: sel.kind === "eq"
			? row[sel.field] === sel.value
			: Arr.some(sel.values, (v) => v === row[sel.field])

/** A side's tuple of `row`: each term's value, a predecessor's one less; none where a predecessor's field is 0. */
const tupleOf = (row: Row, terms: ReadonlyArray<Term>): ReadonlyArray<bigint> | undefined => {
	const out: Array<bigint> = []
	for (const t of terms) {
		const v = defined(row[t.field], `${t.field} of a row`)
		if (t.pred && v === 0n) {
			return undefined
		}
		out.push(t.pred ? v - 1n : v)
	}
	return out
}

const sameTuple = (a: ReadonlyArray<bigint>, b: ReadonlyArray<bigint>): boolean =>
	a.length === b.length && Arr.every(a, (v, i) => v === b[i])

/** A row of `relationName` at the values `at`, its selection's field at a value it admits, every other field 0; none
 * where the selection refuses the values. */
const rowAt = (
	box: Box,
	relationName: string,
	at: ReadonlyArray<readonly [string, bigint]>,
	sel: Selection
): Row | undefined => {
	const row: Record<string, bigint> = Rec.fromEntries(
		Arr.map(headingOf(box, relationName), (h) => [h, 0n] as const)
	)
	if (sel.kind !== "every") {
		row[sel.field] = sel.kind === "eq" ? sel.value : sel.values[0]
	}
	for (const [field, value] of at) {
		row[field] = value
	}
	return admits(row, sel) ? row : undefined
}

/** Every containment the box's statements make the instance hold: each stated one, the family's group into its
 * owner's key, and the tree's parent into its starts. */
const requirementsOf = (box: Box): ReadonlyArray<Requirement> => {
	const fieldsOf = (names: ReadonlyArray<string>): ReadonlyArray<Term> =>
		Arr.map(names, (field) => ({ field, pred: false }))
	return [
		...box.containments,
		...(box.family === undefined
			? []
			: [
					{
						from: box.family.member,
						to: box.family.owner,
						left: fieldsOf(box.family.group),
						right: fieldsOf(box.keys[box.family.owner]),
						source: every,
						target: every
					}
				]),
		...(box.tree
			? [
					{
						from: "T",
						to: "T",
						left: fieldsOf(["k", "parent"]),
						right: fieldsOf(["k", "start"]),
						source: every,
						target: every
					}
				]
			: [])
	]
}

/** Whether two rows hold one value at every field. */
const sameRow = (a: Row, b: Row): boolean => Arr.every(Rec.keys(a), (h) => a[h] === b[h])

/**
 * An instance of the box: a few rows of each relation drawn, then every containment its statements state made to hold
 * (`requirementsOf`), a missing target row added at the values its source row names, in rounds until none is
 * missing; none where a target's selection refuses the values a row must hold there, or no round leaves none missing.
 */
export const instanceGen =
	(box: Box): Gen<Instance | undefined> =>
	(s) => {
		const names = [...plain, ...(box.tree ? ["T"] : [])]
		const rows: Record<string, Array<Row>> = Rec.fromEntries(
			Arr.map(names, (r) => {
				const row: Gen<Row> = (t) =>
					Rec.fromEntries(Arr.map(headingOf(box, r), (h) => [h, t.draw(valueGen)] as const))
				return [r, Arr.copy(s.draw(array(row, { min: 0, max: 3 })))] as const
			})
		)
		const requirements = requirementsOf(box)
		for (let round = 0; round < 12; round += 1) {
			let added = false
			for (const q of requirements) {
				const source = defined(rows[q.from], `the rows of ${q.from}`)
				const target = defined(rows[q.to], `the rows of ${q.to}`)
				/** The source's rows at the round's start: a tree's source is its target, which the round adds to. */
				const count = source.length
				for (let at = 0; at < count; at += 1) {
					const e = defined(source[at], "a row of the source")
					const tuple = admits(e, q.source) ? tupleOf(e, q.left) : undefined
					if (
						tuple === undefined ||
						Arr.some(target, (n) => {
							const met = admits(n, q.target) ? tupleOf(n, q.right) : undefined
							return met !== undefined && sameTuple(met, tuple)
						})
					) {
						continue
					}
					const row = rowAt(
						box,
						q.to,
						Arr.map(
							q.right,
							(t, i) =>
								[t.field, defined(tuple[i], "a tuple's value") + (t.pred ? 1n : 0n)] as const
						),
						q.target
					)
					if (row === undefined) {
						return undefined
					}
					target.push(row)
					added = true
				}
			}
			if (!added) {
				return Rec.map(rows, (rs) => Arr.dedupeWith(rs, sameRow))
			}
		}
		return undefined
	}

/** Whether every containment law the theory states holds over `instance`, as its violation queries read it. */
export const containmentsHold = (t: TestTheory, instance: Instance): boolean =>
	Arr.every(t.laws, (law) => law.shape !== "contained" || !violates(t, law, instance))

/** Whether a fact's selection conjunct, a field at a literal or among literals, holds of `row`. */
const conjunctHolds = (row: Row, conjunct: ExprDesc): boolean => {
	if (
		conjunct.kind === "compare" &&
		conjunct.op === "eq" &&
		conjunct.left.kind === "field" &&
		conjunct.right.kind === "literal"
	) {
		return row[conjunct.left.field] === conjunct.right.value
	}
	if (conjunct.kind === "in" && conjunct.arg.kind === "field") {
		const value = row[conjunct.arg.field]
		return Arr.some(conjunct.values, (v) => v === value)
	}
	return assert.fail(`a selection conjunct the box states: ${Formatter.format(conjunct)}`)
}

/** The rows of `fact`'s source its selection admits that no row of its target meets at its pairs. */
export const breaches = (instance: Instance, fact: FieldContainment): ReadonlyArray<Row> =>
	Arr.filter(
		instance[fact.from] ?? [],
		(e) =>
			Arr.every(fact.selection, (c) => conjunctHolds(e, c)) &&
			!Arr.some(instance[fact.to] ?? [], (n) => Arr.every(fact.pairs, (p) => n[p.to] === e[p.from]))
	)

/** The situations a case reaches. */
export type Feature =
	| "a stated containment"
	| "a composition"
	| "a composition projected onto the pairs its first reaches"
	| "a composition carrying its first's selection"
	| "a composition of three containments"
	| "a family's group into its owner's key"
	| "a tree's parent into its starts"

/** A pair of a source's field and a target's. */
interface Pair {
	readonly from: string
	readonly to: string
}

/** A requirement's pairs, each of a field term on either side, none where a term is a predecessor. */
const pairsOf = (q: Requirement): ReadonlyArray<Pair> | undefined =>
	Arr.some(q.left, (t) => t.pred)
		? undefined
		: Arr.map(q.left, (t, i) => ({ from: t.field, to: defined(q.right[i], "a paired term").field }))

/** Whether `fact` is requirement `q` read at its pairs, each in its place. */
const readsAt = (fact: FieldContainment, q: Requirement): boolean => {
	const pairs = pairsOf(q)
	return (
		pairs !== undefined &&
		fact.from === q.from &&
		fact.to === q.to &&
		fact.pairs.length === pairs.length &&
		Arr.every(fact.pairs, (p, i) => {
			const q = pairs[i]
			return q !== undefined && p.from === q.from && p.to === q.to
		})
	)
}

/** A fact's relations and pairs as text, by which the closure below holds each once. */
const factText = (from: string, to: string, pairs: ReadonlyArray<Pair>): string =>
	`${from}>${to}:${Arr.join(
		Arr.map(pairs, (p) => `${p.from}=${p.to}`),
		","
	)}`

/**
 * The facts of `box` composed only where a first containment reaches every pair of a second, never projected: the
 * closure the engine would hold without projections, against which a fact it holds is one a projection made.
 */
const unprojected = (box: Box): ReadonlySet<string> => {
	const stated = Arr.flatMap(requirementsOf(box), (q) => {
		const pairs = pairsOf(q)
		return pairs === undefined
			? []
			: [{ from: q.from, to: q.to, selected: q.source.kind !== "every", pairs }]
	})
	const held = Arr.copy(stated)
	for (let at = 0; at < held.length; at += 1) {
		const first = defined(held[at], "a held fact")
		for (const second of stated) {
			if (first.to !== second.from || second.selected) {
				continue
			}
			const pairs = Arr.flatMap(second.pairs, (p) =>
				Option.match(
					Arr.findFirst(first.pairs, (x) => x.to === p.from),
					{ onNone: () => [], onSome: (q) => [{ from: q.from, to: p.to }] }
				)
			)
			const text = factText(first.from, second.to, pairs)
			if (
				pairs.length === second.pairs.length &&
				!Arr.some(held, (h) => factText(h.from, h.to, h.pairs) === text)
			) {
				held.push({ from: first.from, to: second.to, selected: first.selected, pairs })
			}
		}
	}
	return new Set(Arr.map(held, (h) => factText(h.from, h.to, h.pairs)))
}

/**
 * The fewest of `box`'s containments each fact composes from, by its text: the closure the engine holds, projections
 * among it, read level by level, a fact of level n one of level n − 1 composed with a stated one.
 */
const depths = (box: Box): ReadonlyMap<string, number> => {
	const stated = Arr.flatMap(requirementsOf(box), (q) => {
		const pairs = pairsOf(q)
		return pairs === undefined
			? []
			: [{ from: q.from, to: q.to, selected: q.source.kind !== "every", pairs }]
	})
	const depth = new Map<string, number>(
		Arr.map(stated, (c) => [factText(c.from, c.to, c.pairs), 1])
	)
	let level = stated
	for (let n = 2; level.length > 0; n += 1) {
		const next: Array<(typeof stated)[number]> = []
		for (const first of level) {
			for (const second of stated) {
				if (first.to !== second.from || second.selected) {
					continue
				}
				const pairs = Arr.flatMap(second.pairs, (p) =>
					Option.match(
						Arr.findFirst(first.pairs, (x) => x.to === p.from),
						{ onNone: () => [], onSome: (q) => [{ from: q.from, to: p.to }] }
					)
				)
				const text = factText(first.from, second.to, pairs)
				if (pairs.length > 0 && !depth.has(text)) {
					depth.set(text, n)
					next.push({ from: first.from, to: second.to, selected: first.selected, pairs })
				}
			}
		}
		level = next
	}
	return depth
}

/** The situation `fact` reaches over `box`'s statements. */
export const featureOf = (box: Box, fact: FieldContainment): Feature => {
	if (fact.from === "T" && fact.to === "T") {
		return "a tree's parent into its starts"
	}
	const family = box.family
	if (
		family !== undefined &&
		readsAt(fact, {
			from: family.member,
			to: family.owner,
			left: Arr.map(family.group, (field) => ({ field, pred: false })),
			right: Arr.map(box.keys[family.owner], (field) => ({ field, pred: false })),
			source: every,
			target: every
		})
	) {
		return "a family's group into its owner's key"
	}
	if (Arr.some(box.containments, (c) => readsAt(fact, c))) {
		return "a stated containment"
	}
	const text = factText(fact.from, fact.to, fact.pairs)
	if ((depths(box).get(text) ?? 0) >= 3) {
		return "a composition of three containments"
	}
	if (!unprojected(box).has(text)) {
		return "a composition projected onto the pairs its first reaches"
	}
	return fact.selection.length > 0
		? "a composition carrying its first's selection"
		: "a composition"
}
