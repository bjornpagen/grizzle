/**
 * The physical analysis's dependency tables (analysis/physical/fds.ts Dependencies), against a brute-force oracle over
 * small generated tables: a heading of up to six columns, hidden attributes beside it, dependencies that read spans at
 * a point, point rules, evidence contexts, and an identity of alternatives of requirements of key options, the shape a
 * rule region's identification takes, encoded as the rules encode it (one hidden attribute per requirement).
 *
 * - The closure of every start among the heading's columns holds exactly the columns, and the row, that firing every
 *   dependency and point rule until none adds a fact holds: the reduction at freeze drops nothing a start can reach.
 * - A start identifies a row exactly when that closure holds the row, which is exactly when, under the identity's own
 *   reading (some alternative whose every requirement has an option inside the closure of the plain dependencies), the
 *   start is a key: the encoding is the identity.
 * - The proof is the strongest: its context is the least demanding one under which a closure of only the dependencies
 *   holding in it reaches the row.
 * - The canonical key lies among the start's columns, identifies a row, and drops no column it could drop on a proof no
 *   more demanding.
 * - Every key the capped enumeration the analysis once ran finds (at most eight minimal keys from the options and the
 *   heading, closed under the exchange), the table identifies: the analysis without caps proves at least what the
 *   capped one proved.
 *
 * And a rule region's table (analysis/physical/rules.ts regionProps), over every scan of a relation of two keys that
 * binds some of its columns and fixes some to a literal or a parameter: a constant on a bound column fixes the column's
 * variable, so the table closes and identifies from every start among the variables exactly as the scan without those
 * constants does under a filter equating each such variable with its value.
 *
 * Plants (~/.cache/grizzle-release/BR03/plants): proof-most-demanding-first (a start's proof sought in the most
 * demanding context first, so it is not the strongest) for the tables; region-bound-constant-unfixed (a constant on a
 * bound column fixes no variable) for the region's constants. Features: each table's closures, identities and contexts;
 * each placement of each constant.
 */
import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, element, type Gen, int, subarray } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Record as Rec } from "effect"
import {
	type Dependencies,
	DependencyDraft,
	hiddenIn,
	justify,
	rowAttribute
} from "#compiler/analysis/physical/fds.ts"
import type { PhysicalProps } from "#compiler/analysis/physical/props.ts"
import { appendAll } from "#compiler/core/array.ts"
import { type EvidenceContext, lessDemanding } from "#compiler/ir/evidence.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import { conservativeMeta } from "#compiler/ir/rel.ts"
import { assert, defined } from "#test/support/assert.ts"
import { ownedFixture } from "#test/support/evidence.ts"
import { Ir, SchemaModel } from "#test/support/fixtures/ir/build.ts"
import { f, key, on, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import { physical, propsOf, snapshotOver } from "#test/unit/analysis/physical/support.ts"

const columnsPool = ["a", "b", "c", "d", "e", "f"] as const
const hiddenPool = Object.freeze([hiddenIn("t", "h1"), hiddenIn("t", "h2")])

type Context = Extract<EvidenceContext, "queryLocal" | "immediate">
const contexts: readonly [Context, Context] = ["queryLocal", "immediate"]
const rank = (c: EvidenceContext): number => (lessDemanding(c, "immediate") ? 0 : 1)

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

const specGen: Gen<Spec> = (source) => {
	const width = source.draw(int(1, columnsPool.length))
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

/** A requirement's hidden attribute, as a rule region names an occurrence's row. */
const requirementAttr = (alternative: number, requirement: number): string =>
	hiddenIn(`alternative${alternative}`, `requirement${requirement}`)

const tableOf = (s: Spec): Dependencies => {
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

const oracleDeps = (s: Spec): ReadonlyArray<OracleDep> => {
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
const oracleClosure = (
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
const satisfies = (identity: Identity, closure: ReadonlySet<string>): boolean =>
	Arr.some(identity, (alternative) =>
		Arr.every(alternative, (requirement) =>
			Arr.some(requirement, (o) => Arr.every(o, (c) => closure.has(c)))
		)
	)

/** Columns as a message lists them. */
const listed = (cs: ReadonlyArray<string>): string => Arr.join(cs, ", ")

/** Every subset of the heading, in heading order. */
const subsetsOf = (heading: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> => {
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
const cappedKeys = (
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

type DependencyFeature =
	| "identified"
	| "not identified"
	| "a less demanding stage chosen"
	| "a key the capped search found"
	| "more minimal keys than the cap"

describe("a fragment's dependency table", () => {
	it.effect(
		"closes, identifies and keys exactly as the brute-force oracle does, and proves every key the capped search found",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "firing every dependency and point rule by brute force until none adds a fact, under each context"
						},
						suite: "unit/analysis/physical/dependencies",
						draw: drawn(specGen),
						literal: Formatter.format,
						coverage: required<DependencyFeature>(["identified", "not identified"], {
							cases: 400,
							sense: notesOnly
						}),
						kept: [
							{
								note: "a dependency that reads the point an immediate rule pins and derives that span's column: the row's proof holds the pin, so it is immediate, never the dependency's query-local context alone",
								sketch: {
									heading: ["a", "b", "c", "d", "e"],
									deps: [{ from: [], at: ["c"], to: ["c"], context: "queryLocal" }],
									pins: [{ from: [], span: "c", context: "immediate" }],
									identity: [[[["c"]]]]
								},
								draws: "",
								reaches: ["identified"]
							}
						],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(s, c) =>
						Effect.sync(() => {
							const table = tableOf(s)
							const visible = [...s.heading, rowAttribute]
							const plainDeps = oracleDeps({ ...s, identity: [] })
							const oldKey = (cs: ReadonlyArray<string>): boolean =>
								satisfies(s.identity, oracleClosure(s, cs, 1, false))
							for (const start of subsetsOf(s.heading)) {
								const expected = oracleClosure(s, start, 1, true)
								const closure = table.closure(start)
								for (const v of visible) {
									assert.equal(
										closure.columns.has(v),
										expected.has(v),
										`${v} from (${listed(start)})`
									)
								}
								const identified = table.identification(start)
								assert.equal(
									identified !== undefined,
									expected.has(rowAttribute),
									`the row from (${listed(start)})`
								)
								assert.equal(
									identified !== undefined,
									oldKey(start),
									`the identity at (${listed(start)})`
								)
								if (identified === undefined) {
									c.note("not identified")
									continue
								}
								c.note("identified")
								const least = oracleClosure(s, start, 0, true).has(rowAttribute) ? 0 : 1
								assert.equal(
									rank(identified.just.context),
									least,
									`the proof's context at (${listed(start)})`
								)
								if (least === 0 && Arr.some(s.deps, (d) => d.context === "immediate")) {
									c.note("a less demanding stage chosen")
								}
								const key = identified.key
								assert.ok(
									Arr.every(key, (k) => start.includes(k)),
									`the key (${listed(key)}) among (${listed(start)})`
								)
								const proof = defined(table.proof(key), `the key (${listed(key)}) identifies a row`)
								for (const k of key) {
									const narrower = table.proof(Arr.filter(key, (x) => x !== k))
									assert.ok(
										narrower === undefined || lessDemanding(proof.context, narrower.context),
										`the key (${listed(key)}) keeps ${k} only for a proof no more demanding`
									)
								}
							}
							const minimal = Arr.filter(subsetsOf(s.heading), (k) =>
								oldKeyMinimal(k, oldKey)
							).length
							if (minimal > 8) {
								c.note("more minimal keys than the cap")
							}
							const options = Arr.flatMap(s.identity, (alternative) => alternative.flat())
							for (const key of cappedKeys(
								s.heading,
								[...options, s.heading],
								oldKey,
								8,
								plainDeps
							)) {
								c.note("a key the capped search found")
								assert.ok(
									table.identification(key) !== undefined,
									`the capped search's key (${listed(key)})`
								)
							}
						})
				)
			)
	)
})

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
	extends: undefined
} satisfies SchemaDesc)

const scanColumns = ["id", "email", "city"] as const
type ScanColumn = (typeof scanColumns)[number]

/** The literal each column is fixed to, of its type. */
const scanLiterals: { readonly [C in ScanColumn]: string } = {
	id: "00000000-0000-4000-8000-000000000001",
	email: "ann",
	city: "Oslo"
}

/** A scan of Person: the columns it binds, each to a variable of its name, and the constants it fixes columns to. */
interface Scan {
	readonly bound: ReadonlyArray<ScanColumn>
	readonly constants: ReadonlyArray<readonly [ScanColumn, "literal" | "param"]>
}

/**
 * Where a scan's constants on its bound columns are stated: on the occurrence, beside the rest; or as one filter over
 * the scan without them, equating each such variable with its value.
 */
type Placement = "on the occurrence" | "as a filter"

/** The properties of `scan` with its bound columns' constants placed as `placement` says. */
const scanProps = (scan: Scan, placement: Placement): PhysicalProps => {
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

type RegionFeature =
	| "a bound column's constant fixes its variable"
	| "an unbound column's constant"
	| "a key's constant fixes the row"

describe("a rule region's dependency table", () => {
	it.effect(
		"fixes a bound column's variable by the column's constant, as a filter on the variable does",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "every scan of Person binding any of its columns and fixing any to a literal or a parameter",
						oracle: {
							kind: "universal",
							name: "differential: the constants on the occurrence close and identify as the same scan under a filter equating each bound variable with its value"
						},
						suite: "unit/analysis/physical/region-constants",
						generator: (source): Scan => ({
							bound: source.draw(subarray(scanColumns)),
							constants: Arr.map(
								source.draw(subarray(scanColumns)),
								(column) => [column, source.draw(element(["literal", "param"] as const))] as const
							)
						}),
						literal: Formatter.format,
						/** The space: 8 sets of bound columns, by 27 assignments of no constant, a literal or a parameter. */
						limit: 216,
						coverage: requiredInSpace<RegionFeature>([
							"a bound column's constant fixes its variable",
							"an unbound column's constant",
							"a key's constant fixes the row"
						]),
						caseHang
					},
					(scan, c) =>
						Effect.sync(() => {
							if (scan.bound.length === 0) {
								return
							}
							const stated = scanProps(scan, "on the occurrence")
							const filtered = scanProps(scan, "as a filter")
							for (const start of subsetsOf(scan.bound)) {
								const closure = stated.dependencies.closure(start)
								const expected = filtered.dependencies.closure(start)
								for (const v of [...scan.bound, rowAttribute]) {
									assert.equal(
										closure.columns.has(v),
										expected.columns.has(v),
										`${v} from (${listed(start)})`
									)
								}
								assert.equal(
									stated.dependencies.identification(start) !== undefined,
									filtered.dependencies.identification(start) !== undefined,
									`the row from (${listed(start)})`
								)
							}
							const fixed = stated.dependencies.closure([])
							for (const [column] of scan.constants) {
								if (!scan.bound.includes(column)) {
									c.note("an unbound column's constant")
									continue
								}
								c.note("a bound column's constant fixes its variable")
								assert.ok(fixed.columns.has(column), `the constant fixes ${column}`)
								if (column !== "city") {
									c.note("a key's constant fixes the row")
									assert.ok(
										fixed.columns.has(rowAttribute),
										`the constant on the key ${column} fixes the row`
									)
								}
							}
						})
				)
			)
	)
})

/** Whether `key` is a minimal key under `isKey`: a key no proper subset of which is one. */
const oldKeyMinimal = (
	key: ReadonlyArray<string>,
	isKey: (cs: ReadonlyArray<string>) => boolean
): boolean => isKey(key) && Arr.every(key, (k) => !isKey(Arr.filter(key, (x) => x !== k)))
