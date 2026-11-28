/** What the properties of dependencies.test.ts read: its spaces, models and helpers. */

import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { array, element, type Gen, int, oneOf, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr, Record as Rec } from "effect"
import {
	type Dependencies,
	DependencyDraft,
	hiddenIn,
	justify,
	rowAttribute
} from "#compiler/analysis/physical/fds.ts"
import type { PhysicalProps } from "#compiler/analysis/physical/props.ts"
import { type EvidenceContext, lessDemanding } from "#compiler/ir/evidence.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import { conservativeMeta } from "#compiler/ir/rel.ts"
import { ownedFixture } from "#test/support/evidence.ts"
import { Ir, SchemaModel } from "#test/support/fixtures/ir/build.ts"
import { f, key, on, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { physical, propsOf, snapshotOver } from "#test/support/unit/analysis/physical/support.ts"

const columnsPool = ["a", "b", "c", "d", "e", "f"] as const

const hiddenPool = Object.freeze([hiddenIn("t", "h1"), hiddenIn("t", "h2")])

type Context = Extract<EvidenceContext, "queryLocal" | "immediate">

const contexts: readonly [Context, Context] = ["queryLocal", "immediate"]

export const rank = (c: EvidenceContext): number => (lessDemanding(c, "immediate") ? 0 : 1)

interface Dep {
	readonly from: ReadonlyArray<string>
	readonly at: ReadonlyArray<string>
	readonly to: ReadonlyArray<string>
	readonly context: Context
}

interface Pin {
	readonly from: ReadonlyArray<string>
	readonly span: string
	readonly context: Context
}

/** Alternatives, each a conjunction of requirements, each a disjunction of key options over the heading. */
type Identity = ReadonlyArray<ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>>>

interface Spec {
	readonly heading: Arr.NonEmptyReadonlyArray<string>
	readonly deps: ReadonlyArray<Dep>
	readonly pins: ReadonlyArray<Pin>
	readonly identity: Identity
}

/** A spec drawn freely over a heading of at least `least` columns of the pool. */
const freeSpecGen =
	(least: number): Gen<Spec> =>
	(source) => {
		const width = source.draw(int(least, columnsPool.length))
		const heading: Arr.NonEmptyReadonlyArray<string> = [
			columnsPool[0],
			...columnsPool.slice(1, width)
		]
		const pool = [...heading, ...hiddenPool]
		const dep: Gen<Dep> = (s) => ({
			from: s.draw(subarray(pool)),
			at: s.draw(subarray(heading)),
			to: s.draw(subarray(pool)),
			context: s.draw(element(contexts))
		})
		const pin: Gen<Pin> = (s) => ({
			from: s.draw(subarray(pool)),
			span: s.draw(element(heading)),
			context: s.draw(element(contexts))
		})
		const option: Gen<ReadonlyArray<string>> = subarray(heading)
		const requirement = array(option, { min: 1, max: 3 })
		const alternative = array(requirement, { min: 1, max: 2 })
		return {
			heading,
			deps: source.draw(array(dep, { min: 0, max: 7 })),
			pins: source.draw(array(pin, { min: 0, max: 2 })),
			identity: source.draw(array(alternative, { min: 0, max: 2 }))
		}
	}

/**
 * A spec with a shortcut, over a heading of at least three columns a, b and c: a more demanding dependency from a alone
 * to c, listed before a less demanding one from a and b to c, and an identity alternative requiring c, beside a free
 * spec's own. From (a, b) the less demanding context proves the row, while the whole closure first reaches c through
 * the more demanding dependency, so only the order of the contexts finds the strongest proof.
 */
const shortcutSpecGen: Gen<Spec> = (source) => {
	const free = source.draw(freeSpecGen(3))
	/** The first three columns of the pool, which a heading of three or more begins with. */
	const [x, y, t] = columnsPool
	return {
		...free,
		deps: [
			{ from: [x], at: [], to: [t], context: "immediate" },
			{ from: [x, y], at: [], to: [t], context: "queryLocal" },
			...free.deps
		],
		identity: [[[[t]]], ...free.identity]
	}
}

/** Every spec of the search: one drawn freely, or one with a shortcut. */
export const specGen: Gen<Spec> = oneOf([freeSpecGen(1), shortcutSpecGen])

/** A requirement's hidden attribute, as a rule region names an occurrence's row. */
const requirementAttr = (alternative: number, requirement: number): string =>
	hiddenIn(`alternative${alternative}`, `requirement${requirement}`)

export const tableOf = (s: Spec): Dependencies => {
	const draft = new DependencyDraft(s.heading)
	for (const d of s.deps) {
		draft.implyAt(d.from, d.at, d.to, justify({ context: d.context }))
	}
	for (const p of s.pins) {
		draft.pin(p.from, p.span, justify({ context: p.context }))
	}
	for (const [a, alternative] of s.identity.entries()) {
		for (const [r, requirement] of alternative.entries()) {
			for (const o of requirement) {
				draft.imply(o, [requirementAttr(a, r)], justify({}))
			}
		}
		draft.identify(
			Arr.map(alternative, (_, r) => requirementAttr(a, r)),
			justify({})
		)
	}
	return draft.freeze(s.heading)
}

/** One dependency as the oracle fires it: as the draft normalizes it, admitted at the context's rank. */
interface OracleDep {
	readonly from: ReadonlySet<string>
	readonly at: ReadonlySet<string>
	readonly to: ReadonlyArray<string>
	readonly rank: number
}

export const oracleDeps = (s: Spec): ReadonlyArray<OracleDep> => {
	const normal = (
		from: ReadonlyArray<string>,
		at: ReadonlyArray<string>,
		to: ReadonlyArray<string>,
		context: EvidenceContext
	): ReadonlyArray<OracleDep> => {
		const f = new Set(from)
		const a = new Set(Arr.filter(at, (c) => !f.has(c)))
		const t = Arr.filter([...new Set(to)], (c) => !f.has(c))
		return t.length === 0 ? [] : [{ from: f, at: a, to: t, rank: rank(context) }]
	}
	return [
		...Arr.flatMap(s.deps, (d) => normal(d.from, d.at, d.to, d.context)),
		...Arr.flatMap(s.identity, (alternative, a) => [
			...Arr.flatMap(alternative, (requirement, r) =>
				Arr.flatMap(requirement, (o) => normal(o, [], [requirementAttr(a, r)], "queryLocal"))
			),
			...normal(
				Arr.map(alternative, (_, r) => requirementAttr(a, r)),
				[],
				[rowAttribute],
				"queryLocal"
			)
		])
	]
}

/** Every fact the start reaches by firing every dependency and point rule of rank at most `upto` until none adds one. */
export const oracleClosure = (
	s: Spec,
	start: ReadonlyArray<string>,
	upto: number,
	withIdentity: boolean
): ReadonlySet<string> => {
	const deps = withIdentity
		? oracleDeps(s)
		: Arr.filter(oracleDeps({ ...s, identity: [] }), (d) => !d.to.includes(rowAttribute))
	const columns = new Set(start)
	const points = new Set<string>()
	for (let changed = true; changed;) {
		changed = false
		for (const d of deps) {
			if (d.rank > upto) {
				continue
			}
			const fires =
				Arr.every([...d.from], (c) => columns.has(c)) &&
				Arr.every([...d.at], (c) => columns.has(c) || points.has(c))
			if (fires && Arr.some(d.to, (c) => !columns.has(c))) {
				for (const c of d.to) {
					columns.add(c)
				}
				changed = true
			}
		}
		for (const p of s.pins) {
			if (rank(p.context) > upto || p.from.includes(p.span)) {
				continue
			}
			if (Arr.every(p.from, (c) => columns.has(c)) && !columns.has(p.span) && !points.has(p.span)) {
				points.add(p.span)
				changed = true
			}
		}
	}
	return columns
}

/** Whether a closure of the plain dependencies satisfies the identity: some alternative's every requirement met. */
export const satisfies = (identity: Identity, closure: ReadonlySet<string>): boolean =>
	Arr.some(identity, (alternative) =>
		Arr.every(alternative, (requirement) =>
			Arr.some(requirement, (o) => Arr.every(o, (c) => closure.has(c)))
		)
	)

/** Columns as a message lists them. */
export const listed = (cs: ReadonlyArray<string>): string => Arr.join(cs, ", ")

/** Every subset of the heading, in heading order. */
export const subsetsOf = (heading: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> => {
	const subsets: Array<ReadonlyArray<string>> = [[]]
	for (const c of heading) {
		appendAll(
			subsets,
			Arr.map(subsets, (subset) => [...subset, c])
		)
	}
	return subsets
}

/** The capped minimal-key search the analysis once ran, at most `bound` keys, as an oracle of what it proved. */
export const cappedKeys = (
	heading: ReadonlyArray<string>,
	candidates: ReadonlyArray<ReadonlyArray<string>>,
	isKey: (cs: ReadonlyArray<string>) => boolean,
	bound: number,
	deps: ReadonlyArray<OracleDep>
): ReadonlyArray<ReadonlyArray<string>> => {
	const inHeading = (cs: ReadonlyArray<string>) => Arr.filter(heading, (c) => cs.includes(c))
	const found: Array<ReadonlyArray<string>> = []
	const add = (candidate: ReadonlyArray<string>): void => {
		let key = inHeading(candidate)
		if (!isKey(key)) {
			return
		}
		for (let i = key.length - 1; i >= 0; i--) {
			const without = key.toSpliced(i, 1)
			if (isKey(without)) {
				key = without
			}
		}
		if (!Arr.some(found, (k) => k.length === key.length && Arr.every(k, (c) => key.includes(c)))) {
			found.push(key)
		}
	}
	for (const c of candidates) {
		add(c)
	}
	for (const key of found) {
		for (const d of deps) {
			if (found.length >= bound) {
				break
			}
			const exchanged = inHeading([...d.from, ...Arr.filter(key, (c) => !d.to.includes(c))])
			if (!Arr.some(found, (k) => Arr.every(k, (c) => exchanged.includes(c)))) {
				add(exchanged)
			}
		}
		if (found.length >= bound) {
			break
		}
	}
	return found
}

export type DependencyFeature =
	| "identified"
	| "not identified"
	| "a less demanding stage chosen"
	| "a proof stronger than the whole closure's"
	| "a key the capped search found"
	| "more minimal keys than the cap"

/** A relation of two keys, id and email, and a column no key holds. */
const Person = relation(
	"Person",
	{ id: f.uuid, email: f.regex("^[a-z]{1,20}$", "u"), city: f.wildcard },
	["id"]
)

const crm = ownedFixture({
	name: "Crm",
	relations: [Person],
	statements: [key(on("Person", ["email"]))],
	bases: []
} satisfies SchemaDesc)

export const scanColumns = ["id", "email", "city"] as const

type ScanColumn = (typeof scanColumns)[number]

/** The literal each column is fixed to, of its type. */
const scanLiterals: { readonly [C in ScanColumn]: string } = {
	id: "00000000-0000-4000-8000-000000000001",
	email: "ann",
	city: "Oslo"
}

/** A scan of Person: the columns it binds, each to a variable of its name, and the constants it fixes columns to. */
export interface Scan {
	readonly bound: ReadonlyArray<ScanColumn>
	readonly constants: ReadonlyArray<readonly [ScanColumn, "literal" | "param"]>
}

/**
 * Where a scan's constants on its bound columns are stated: on the occurrence, beside the rest; or as one filter over
 * the scan without them, equating each such variable with its value.
 */
type Placement = "on the occurrence" | "as a filter"

/** The properties of `scan` with its bound columns' constants placed as `placement` says. */
export const scanProps = (scan: Scan, placement: Placement): PhysicalProps => {
	const m = new Ir(new SchemaModel(crm, {}))
	const base = m.base("Person")
	const value = (column: ScanColumn, kind: "literal" | "param"): ScalarExpr =>
		kind === "literal"
			? m.litFor(base, column, scanLiterals[column])
			: m.param(`${column}Value`, m.column(base, column).type, "compare")
	const filtered = Arr.filter(
		scan.constants,
		([column]) => placement === "as a filter" && scan.bound.includes(column)
	)
	const region = m.region(
		[
			{
				source: base,
				bind: Rec.fromEntries(Arr.map(scan.bound, (column) => [column, column])),
				constants: Rec.fromEntries(
					Arr.map(
						Arr.filter(scan.constants, (c) => !filtered.includes(c)),
						([column, kind]) => [column, value(column, kind)]
					)
				)
			}
		],
		conservativeMeta
	)
	const equalities = Arr.map(filtered, ([column, kind]) =>
		m.eq(m.col(region, column), value(column, kind))
	)
	const [only, ...more] = equalities
	const root =
		only === undefined
			? region
			: m.filter(region, more.length === 0 ? only : m.op("and", equalities))
	return propsOf(physical(m.build(root).dag, snapshotOver(m)), root)
}

export type RegionFeature =
	| "a bound column's constant fixes its variable"
	| "an unbound column's constant"
	| "a key's constant fixes the row"

/** Whether `key` is a minimal key under `isKey`: a key no proper subset of which is one. */
export const oldKeyMinimal = (
	key: ReadonlyArray<string>,
	isKey: (cs: ReadonlyArray<string>) => boolean
): boolean => isKey(key) && Arr.every(key, (k) => !isKey(Arr.filter(key, (x) => x !== k)))
