import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert, defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { type PreludeAt, preludeProgram } from "#test/support/prelude.ts"
import { assertClean, type Measuring, measuredEach } from "#test/types/batch/measured.ts"

/**
 * The records-fragment programs (records-fragment.test.ts): over a schema of thirteen relations, `units` times, a
 * query's records (records(...)) and a fragment holding their relations and the records' own laws, as den lists a
 * recorded tree in a library:
 * flat records, of a query that attaches nothing; records of an array of children each with an option of its own, two
 * levels below the root; or records of a document scan (scanOf), as metis records a read of a document. The records
 * hold their relations and laws as unions of the members alone, read once their query is known
 * (types/schema/records.ts RecordsHeld), so a statement list holding them, which the fragment reads back by name
 * (StatementsReadBack), relates them member by member, never through the recursion over the attachment tree that built
 * them: TS2589 at two levels, and at a document scan.
 */
export type FragmentShape =
	| "flat records"
	| "records of an array of options"
	| "records of a document scan"

/** The cells of recordsFragments, minted as a dictionary in its door (test/types/schema/budget/records-fragment.dictionary.ts). */
export const fragmentShapesItems: readonly [FragmentShape, ...ReadonlyArray<FragmentShape>] = [
	"flat records",
	"records of an array of options",
	"records of a document scan"
]

/**
 * A document scan's nodes, as pantry's export reads a document (documentScanOf): N's rows of the parent `p`, in order,
 * each with its document row on its first node, an option, the row's declaration under it, an option, and the
 * declaration's encoding and standalone, an option each; its attributes and its open attributes, arrays, each attribute
 * with its entities, an array of the one name under both; and its namespaces, an array.
 */
const scanOf = (i: number): string => `query(S).rule((r) => {
	const { s, x } = v(N, "n${i}")
	return r.match(N, { p: p.id, s, x }).find({ p: p.id, s, x })
}).attach("row", (n) => query(S).rule((r) => {
	const { w } = v(Dr, "dr${i}")
	return r.match(Dr, { p: n.p, w }).where(r.eq(n.s, 0)).find({ p: n.p, w })
}).attach("declaration", (d) => query(S).rule((r) => {
	const { w } = v(Xd, "xd${i}")
	return r.match(Xd, { p: d.p, w }).find({ p: d.p, w })
}).attach("encoding", (x) => query(S).rule((r) => {
	const { w } = v(En, "en${i}")
	return r.match(En, { p: x.p, w }).find({ w })
}), "option").attach("standalone", (x) => query(S).rule((r) => {
	const { w } = v(Sd, "sd${i}")
	return r.match(Sd, { p: x.p, w }).find({ w })
}), "option"), "option"), "option").attach("attributes", (n) => query(S).rule((r) => {
	const { k, w } = v(At, "at${i}")
	return r.match(At, { p: n.p, s: n.s, k, w }).find({ p: n.p, s: n.s, k, w })
}).attach("entities", (a) => query(S).rule((r) => {
	const { o, w } = v(Ae, "ae${i}")
	return r.match(Ae, { p: a.p, s: a.s, k: a.k, o, w }).find({ o, w })
}).orderBy(["o", "asc"]), "array").orderBy(["k", "asc"]), "array").attach("openAttributes", (n) => query(S).rule((r) => {
	const { k, w } = v(Oa, "oa${i}")
	return r.match(Oa, { p: n.p, s: n.s, k, w }).find({ p: n.p, s: n.s, k, w })
}).attach("entities", (a) => query(S).rule((r) => {
	const { o, w } = v(Oe, "oe${i}")
	return r.match(Oe, { p: a.p, s: a.s, k: a.k, o, w }).find({ o, w })
}).orderBy(["o", "asc"]), "array").orderBy(["k", "asc"]), "array").attach("namespaces", (n) => query(S).rule((r) => {
	const { k, w } = v(Ns, "ns${i}")
	return r.match(Ns, { p: n.p, s: n.s, k, w }).find({ k, w })
}).orderBy(["k", "asc"]), "array").orderBy(["s", "asc"])`

/**
 * The query of unit i: P's row at a parameter, and for nested records its C children, each with its D option, or its
 * document scan (scanOf), an array.
 */
const queryOf = (shape: FragmentShape, i: number): string => {
	const root = `query(S).rule((r) => {
	const { id, n } = v(P, "p${i}")
	return r.match(P, { id, n }).where(r.eq(id, r.param("p", Id))).find({ id, n })
})`
	switch (shape) {
		case "flat records":
			return root
		case "records of an array of options":
			return `${root}.attach("cs", (p) => query(S).rule((r) => {
	const { k, w } = v(C, "c${i}")
	return r.match(C, { p: p.id, k, w }).find({ k, w })
}).attach("d", (c) => query(S).rule((r) => {
	const { w } = v(D, "d${i}")
	return r.match(D, { k: c.k, w }).find({ w })
}), "option").orderBy(["k", "asc"]), "array")`
		case "records of a document scan":
			return `${root}.attach("nodes", (p) => ${scanOf(i)}, "array")`
	}
}

/** Unit i: its query, its records, and the fragment holding them. */
const unitOf = (
	shape: FragmentShape,
	i: number
): string => `export const q${i} = ${queryOf(shape, i)}
export const k${i} = records("K${i}", q${i}, { run: Id }, ["run"])
export const F${i} = fragment([...k${i}.relations], [...k${i}.rules])
`

/** The program of `units` units of a shape, its imports read through the gates' prelude as `entries` reaches it. */
const fragmentProgram = (shape: FragmentShape, units: number, entries: PreludeAt): string =>
	preludeProgram(
		`// Generated by test/types/schema/budget/records-fragment.ts at ${jsonText({ shape, units })}.`,
		entries,
		`export const P = relation("P", { id: Id, n: pg.integer }, ["id"])
export const C = relation("C", { p: Id, k: pg.integer, w: pg.integer }, ["p", "k"])
export const D = relation("D", { k: pg.integer, w: pg.integer }, ["k"])
export const N = relation("N", { p: Id, s: pg.integer, x: pg.integer }, ["p", "s"])
export const Dr = relation("Dr", { p: Id, w: pg.integer }, ["p"])
export const Xd = relation("Xd", { p: Id, w: pg.integer }, ["p"])
export const En = relation("En", { p: Id, w: pg.integer }, ["p"])
export const Sd = relation("Sd", { p: Id, w: pg.integer }, ["p"])
export const At = relation("At", { p: Id, s: pg.integer, k: pg.integer, w: pg.integer }, ["p", "s", "k"])
export const Ae = relation("Ae", { p: Id, s: pg.integer, k: pg.integer, o: pg.integer, w: pg.integer }, ["p", "s", "k", "o"])
export const Oa = relation("Oa", { p: Id, s: pg.integer, k: pg.integer, w: pg.integer }, ["p", "s", "k"])
export const Oe = relation("Oe", { p: Id, s: pg.integer, k: pg.integer, o: pg.integer, w: pg.integer }, ["p", "s", "k", "o"])
export const Ns = relation("Ns", { p: Id, s: pg.integer, k: pg.integer, w: pg.integer }, ["p", "s", "k"])
export const S = schema("S", [P, C, D, N, Dr, Xd, En, Sd, At, Ae, Oa, Oe, Ns], [contained(on(C, "p"), on(P, "id"))])
${Arr.join(
	Arr.map(indices(units), (i) => unitOf(shape, i)),
	""
)}`
	)

/** The units of the smaller program; the larger writes twice as many, so the step adds `step` units. */
const step = 10

/**
 * What one unit of each shape adds to a program's instantiations, at most: what it adds now records hold their
 * relations and laws as unions of the members alone, each relation one type for one child.
 *
 * @limitKind measured
 * @owner the records' type cost gates (test/types/schema/budget/records-fragment.ts)
 * @unit instantiations a unit adds
 * @scope one unit of the shape (a query, its records and the fragment holding them and their laws), checked by one checker against the engine's and the shell's declarations, as
 *   test/types/batch/measured.ts checks a program
 * @evidence ~/.cache/grizzle-release/recnames-tools/ts2589 (a mirror of pantry's documentScanOf and metis's fragment
 *   of its records beside a retirable body, checked as measured.ts checks a program: tsgo --checkers 1
 *   --extendedDiagnostics, before and after; --generateTrace, the relation types several copies of one child and the
 *   variance of AttachedLaws and ApartRelations at the depth limit), recnames-tools/depth (gen.py, a chain of
 *   attachments one to eight deep; gen2.py, an array of nodes with siblings under it, the least shape that died) and
 *   records-fragment.test.ts run with each bound at 0, whose assertion states what a unit of each shape adds
 *   (recnames-tools/rf*.log)
 * @observed 2026-11-22, 08:00 to 11:30 UTC
 * @environment cassowary, Ubuntu 26.04 arm64, 64 cores; Node 26.13.1, TypeScript 7.1.0-beta (tsgo); grizzle at hub
 *   main 4926eb52f and lane RECNAMES's unboxed records over it
 * @workload a schema of thirteen relations; 10 and 20 units of each shape, each program checked alone
 * @result per added unit: flat records 5,527 instantiations (5,328 before: the three unions each read once their query
 *   is known), records of an array of options 24,653 (25,544 before), records of a document scan 107,663 (TS2589 at the
 *   fragment before, after 1,319,369 instantiations for the whole mirror; 256,943 for it after); a chain of options one
 *   to eight deep adds 8,390 to 9,707 a level, a node's sibling 8,500 to 9,800; every program clean. Since records take
 *   the names their author states (RecordNames, the naming threaded through each level): flat records 5,544, records of
 *   an array of options 24,536, records of a document scan 103,734;
 *   at REPLAYFIX's exact-bound car (2026-11-26, over ousxtqsu on train C's 1170fa12 and its empty-level car), every type
 *   budget run with each program's count logged, width 8, load in the hundreds: flat records 4,771 a unit, records of an
 *   array of options 23,751, records of a document scan 102,809; at the merged tree of every lane (52df3631e,
 *   2026-11-26), measured as this test measures it with each count logged, 4,743, 22,894 and 99,949, alternatives and
 *   arm attachments gone (271ffecf2); at PIN 3's merge (2026-11-26), measured as this test measures it with each count
 *   logged at the old base 1323e214, at BRAND-P3 97c889164588 and at the merge: flat records 4,743, 4,823 and 4,823,
 *   records of an array of options 22,894, 22,986 and 22,986, records of a document scan 99,949, 100,058 and 100,058,
 *   BRAND-P3's 80, 92 and 109 more the cost of a consumer's mark (core/brand.ts Marked), a type-level intersection on
 *   every contract-typed field of the units' rows.
 * @decision the bound is the count at the tree it was last measured at, exactly, the counts being a function of the
 *   tree: a change that makes a fragment of records cost more fails here and moves the bound in its own commit, its
 *   cost stated, and a change that lowers it lowers the bound
 * @revalidate a TypeScript 7 or tsgo upgrade; another machine; any change to records' types (types/schema/records.ts),
 *   or to a fragment's or a schema's statements (types/schema/schema.ts) that moves a unit's cost, which states its
 *   cost here
 */
const addedAtMost: { readonly [S in FragmentShape]: number } = {
	"flat records": 4823,
	"records of an array of options": 22986,
	"records of a document scan": 100058
}

/** How a shape prints. */
export const fragmentShapeName = (shape: FragmentShape): string => `fragments of ${shape}`

/**
 * The cost of a shape's units, measured: both programs typecheck with no diagnostic, and the units the larger adds cost
 * no more, each, than the shape's bound.
 */
export const fragmentCost = (at: Measuring, shape: FragmentShape) =>
	Effect.gen(function* () {
		const measured = yield* measuredEach(
			at,
			Arr.map([step, 2 * step], (units) => ({
				size: units,
				source: (entries: PreludeAt) => fragmentProgram(shape, units, entries)
			}))
		)
		for (const m of measured) {
			assertClean(m, fragmentShapeName(shape))
		}
		const count = (i: number): number =>
			defined(measured[i], `the program of ${shape} at ${i}`).instantiations
		const added = (count(1) - count(0)) / step
		assert.ok(
			added <= addedAtMost[shape],
			`a unit of ${shape} adds ${added} instantiations, more than ${addedAtMost[shape]}`
		)
	})
