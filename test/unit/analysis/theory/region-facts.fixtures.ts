/** What region-facts.test.ts reads: its box of schemas, the instances it draws over them, and its oracle. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int, shuffled } from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter, Option, Record as Rec } from "effect"
import type { FieldContainment } from "#compiler/analysis/theory/unit.ts"
import type { ExprDesc, TermDesc } from "#compiler/ir/desc.ts"
import {
	contained,
	counted,
	decodedQuery,
	decodedSchema,
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

/** A stated containment of a plain relation into another or into the view V. */
interface Containment extends Requirement {
	readonly from: Plain
	readonly to: Plain | "V"
}

/** A rule of the view V: a plain relation matched with V's k and x its fields `k` and `x`. */
interface ViewRule {
	readonly relation: Plain
	readonly k: Field
	readonly x: Field
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
	/** The rules of the derived relation V(k, x), each reading one plain relation; none where no V stands. */
	readonly view: ReadonlyArray<ViewRule>
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

const viewRuleGen: Gen<ViewRule> = (s) => {
	const [k, x] = s.draw(shuffled(fields, { min: 2, max: 2 }))
	return { relation: s.draw(element(plain)), k: defined(k, "V's k"), x: defined(x, "V's x") }
}

/** A containment of a plain relation into V at one or both of V's fields. */
const intoViewGen: Gen<Containment> = (s) => {
	const width = s.draw(int(1, 2))
	return {
		from: s.draw(element(plain)),
		to: "V",
		left: s.draw(termsGen(width, false)),
		right: Arr.map(s.draw(shuffled(["k", "x"], { min: width, max: width })), (field) => ({
			field,
			pred: false
		})),
		source: s.draw(selectionGen),
		target: every
	}
}

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
	const view = s.draw(boolean) ? s.draw(array(viewRuleGen, { min: 1, max: 2 })) : []
	return {
		keys,
		containments: [
			...s.draw(array(containmentGen, { min: 1, max: 5 })),
			...(view.length > 0 ? s.draw(array(intoViewGen, { min: 1, max: 2 })) : [])
		],
		family: s.draw(boolean) ? s.draw(familyGen(keys)) : undefined,
		tree: s.draw(boolean),
		view
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

/** V's definition: each rule a match of its relation at its two fields, delivered as V's k and x; each relation named
 * by `named`. */
const viewOf = (view: Arr.NonEmptyReadonlyArray<ViewRule>, named: (r: string) => string) => ({
	kind: "derived" as const,
	name: named("V"),
	level: 1,
	query: decodedQuery({
		kind: "rules",
		arms: Arr.map(view, (r) => ({
			vars: [
				{ id: "vk", origin: { relation: named(r.relation), field: r.k } },
				{ id: "vx", origin: { relation: named(r.relation), field: r.x } }
			],
			matches: [
				{
					source: { kind: "relation" as const, name: named(r.relation) },
					bindings: {
						[r.k]: { kind: "var" as const, var: "vk" },
						[r.x]: { kind: "var" as const, var: "vx" }
					}
				}
			],
			where: [],
			head: { k: { kind: "var" as const, var: "vk" }, x: { kind: "var" as const, var: "vx" } },
			interiors: [],
			attach: []
		}))
	})
})

/**
 * The box's schema: A to D of k, x and y, its family's owner also of a drawn n, and, where it stands, the tree T, with
 * every statement among them; and, where V stands, an extension of it declaring V and the containments into V, as a
 * derived relation is declared above the schema its definition reads.
 */
export const schemaOfBox = (box: Box): SchemaDesc => schemaOfCopies(box, [""])

/**
 * The schema of disjoint copies of the box (schemaOfBox), one per suffix, each relation of a copy named with its suffix:
 * every statement of a copy is among its own relations, so no fact of one copy composes with another's.
 */
export const schemaOfCopies = (
	box: Box,
	suffixes: Arr.NonEmptyReadonlyArray<string>
): SchemaDesc => {
	const copies = Arr.map(suffixes, (suffix) => (r: string) => `${r}${suffix}`)
	const base = schemaOf(
		Arr.flatMap(copies, (named) => [
			...Arr.map(plain, (r) =>
				relation(
					named(r),
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
							named("T"),
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
		]),
		Arr.flatMap(copies, (named) => [
			...Arr.map(
				Arr.filter(box.containments, (c) => c.to !== "V"),
				(c) =>
					contained(sideOf(named(c.from), c.left, c.source), sideOf(named(c.to), c.right, c.target))
			),
			...(box.family === undefined
				? []
				: [
						counted(on(named(box.family.member), box.family.group), {
							owner: named(box.family.owner),
							count: "n"
						})
					]),
			...(box.tree
				? [
						{
							kind: "tree" as const,
							member: on(named("T"), ["parent", "at"]),
							slots: { owner: named("T"), count: "n" },
							root: ["k"] as const
						}
					]
				: [])
		])
	)
	const view = box.view
	return !Arr.isReadonlyArrayNonEmpty(view)
		? base
		: {
				name: "T_1",
				bases: [decodedSchema(base)],
				relations: Arr.map(copies, (named) => viewOf(view, named)),
				statements: Arr.flatMap(copies, (named) =>
					Arr.map(
						Arr.filter(box.containments, (c) => c.to === "V"),
						(c) =>
							contained(
								sideOf(named(c.from), c.left, c.source),
								sideOf(named(c.to), c.right, c.target)
							)
					)
				)
			}
}

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
				/** The source's rows at the round's start: a tree's source is its target, which the round adds to. */
				const count = source.length
				for (let at = 0; at < count; at += 1) {
					const e = defined(source[at], "a row of the source")
					const tuple = admits(e, q.source) ? tupleOf(e, q.left) : undefined
					const target =
						q.to === "V" ? viewRows(box, rows) : defined(rows[q.to], `the rows of ${q.to}`)
					if (
						tuple === undefined ||
						Arr.some(target, (n) => {
							const met = admits(n, q.target) ? tupleOf(n, q.right) : undefined
							return met !== undefined && sameTuple(met, tuple)
						})
					) {
						continue
					}
					if (q.to === "V") {
						/** A row of V is a row of the relation some rule reads: one drawn rule's, at its two fields. */
						const rule = defined(box.view[s.draw(int(0, box.view.length - 1))], "a rule of V")
						const row = rowAt(
							box,
							rule.relation,
							Arr.map(
								q.right,
								(t, i) =>
									[t.field === "k" ? rule.k : rule.x, defined(tuple[i], "a tuple's value")] as const
							),
							every
						)
						defined(rows[rule.relation], `the rows of ${rule.relation}`).push(
							defined(row, "a row of a rule's relation, which no selection refuses")
						)
						added = true
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
					defined(rows[q.to], `the rows of ${q.to}`).push(row)
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

/** V's rows over `instance`: each rule's relation's rows at its two fields, as V's k and x. */
const viewRows = (box: Box, instance: Instance): ReadonlyArray<Row> =>
	Arr.dedupeWith(
		Arr.flatMap(box.view, (r) =>
			Arr.map(instance[r.relation] ?? [], (row) => ({
				k: defined(row[r.k], "a rule's k"),
				x: defined(row[r.x], "a rule's x")
			}))
		),
		sameRow
	)

/** The rows of `fact`'s source its selection admits that no row of its target meets at its pairs, V's rows its
 * definition's over the instance. */
export const breaches = (
	box: Box,
	instance: Instance,
	fact: FieldContainment
): ReadonlyArray<Row> => {
	const rowsOf = (name: string): ReadonlyArray<Row> =>
		name === "V" ? viewRows(box, instance) : (instance[name] ?? [])
	return Arr.filter(
		rowsOf(fact.from),
		(e) =>
			Arr.every(fact.selection, (c) => conjunctHolds(e, c)) &&
			!Arr.some(rowsOf(fact.to), (n) => Arr.every(fact.pairs, (p) => n[p.to] === e[p.from]))
	)
}

/** The situations a case reaches. */
export type Feature =
	| "a stated containment"
	| "a composition"
	| "a composition projected onto the pairs its first reaches"
	| "a composition carrying its first's selection"
	| "a composition of three containments"
	| "a family's group into its owner's key"
	| "a tree's parent into its starts"
	| "a derived relation into the relation its every rule reads"
	| "a containment into a derived relation composed into a relation it reads"

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

/** A fact as the closures below read it: its relations, whether its source is selected, and its pairs. */
interface Held {
	readonly from: string
	readonly to: string
	readonly selected: boolean
	readonly pairs: ReadonlyArray<Pair>
}

/** V into each plain relation every rule of V reads, at the fields every rule reads alike. */
const viewFacts = (box: Box): ReadonlyArray<Held> =>
	Arr.flatMap(plain, (n) => {
		if (box.view.length === 0 || !Arr.every(box.view, (r) => r.relation === n)) {
			return []
		}
		const pairs = Arr.filter(
			[
				{ from: "k", to: defined(box.view[0], "a rule of V").k },
				{ from: "x", to: defined(box.view[0], "a rule of V").x }
			],
			(p) => Arr.every(box.view, (r) => (p.from === "k" ? r.k : r.x) === p.to)
		)
		return pairs.length > 0 ? [{ from: "V", to: n, selected: false, pairs }] : []
	})

/** A fact's relations and pairs as text, by which the closures below hold each once. */
const factText = (from: string, to: string, pairs: ReadonlyArray<Pair>): string =>
	`${from}>${to}:${Arr.join(
		Arr.map(pairs, (p) => `${p.from}=${p.to}`),
		","
	)}`

/**
 * The fewest of `box`'s containments each fact composes from, by its text, a fact of level n one of level n − 1
 * composed with a stated one: the closure the engine holds where `project` and `view` say so, and without its
 * projections, or without V's own containments, where they do not, against which a fact the engine holds is one that
 * a projection or V made.
 */
const closure = (box: Box, project: boolean, view: boolean): ReadonlyMap<string, number> => {
	const stated: ReadonlyArray<Held> = [
		...Arr.flatMap(requirementsOf(box), (q) => {
			const pairs = pairsOf(q)
			return pairs === undefined
				? []
				: [{ from: q.from, to: q.to, selected: q.source.kind !== "every", pairs }]
		}),
		...(view ? viewFacts(box) : [])
	]
	const depth = new Map<string, number>(
		Arr.map(stated, (c) => [factText(c.from, c.to, c.pairs), 1])
	)
	let level = stated
	for (let n = 2; level.length > 0; n += 1) {
		const next: Array<Held> = []
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
				if (
					pairs.length > 0 &&
					(project || pairs.length === second.pairs.length) &&
					!depth.has(text)
				) {
					depth.set(text, n)
					next.push({ from: first.from, to: second.to, selected: first.selected, pairs })
				}
			}
		}
		level = next
	}
	return depth
}

/** Whether `fact` is `held` read at its pairs, each in its place. */
const readsAt = (fact: FieldContainment, held: Held): boolean =>
	fact.from === held.from &&
	fact.to === held.to &&
	fact.pairs.length === held.pairs.length &&
	Arr.every(fact.pairs, (p, i) => {
		const q = held.pairs[i]
		return q !== undefined && p.from === q.from && p.to === q.to
	})

/** The situation `fact` reaches over `box`'s statements. */
export const featureOf = (box: Box, fact: FieldContainment): Feature => {
	if (fact.from === "T" && fact.to === "T") {
		return "a tree's parent into its starts"
	}
	if (fact.from === "V") {
		return "a derived relation into the relation its every rule reads"
	}
	const heldOf = (q: Requirement): ReadonlyArray<Held> => {
		const pairs = pairsOf(q)
		return pairs === undefined ? [] : [{ from: q.from, to: q.to, selected: false, pairs }]
	}
	const family = box.family
	if (
		family !== undefined &&
		Arr.some(
			heldOf({
				from: family.member,
				to: family.owner,
				left: Arr.map(family.group, (field) => ({ field, pred: false })),
				right: Arr.map(box.keys[family.owner], (field) => ({ field, pred: false })),
				source: every,
				target: every
			}),
			(h) => readsAt(fact, h)
		)
	) {
		return "a family's group into its owner's key"
	}
	if (Arr.some(Arr.flatMap(box.containments, heldOf), (h) => readsAt(fact, h))) {
		return "a stated containment"
	}
	const text = factText(fact.from, fact.to, fact.pairs)
	if (!closure(box, true, false).has(text)) {
		return "a containment into a derived relation composed into a relation it reads"
	}
	if ((closure(box, true, true).get(text) ?? 0) >= 3) {
		return "a composition of three containments"
	}
	if (!closure(box, false, true).has(text)) {
		return "a composition projected onto the pairs its first reaches"
	}
	return fact.selection.length > 0
		? "a composition carrying its first's selection"
		: "a composition"
}
