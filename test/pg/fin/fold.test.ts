/**
 * Folds through grizzle's lowering, on PostgreSQL 19rc1 (fin.md §4.3, §11 "Identities", w4-w7 §2.3): one family per
 * (monoid, carrier) folded by grizzle's `fold` (folds.ts), every family of at most four members over a five-value
 * domain written by a direct SQL writer, the owner, with the accumulators the reference fold computes and with each
 * single junk accumulator, and PostgreSQL's verdict judged three ways.
 *
 * - **Two implementations agreeing:** the reference fold (test/support/families/fold.ts folded), exact: counts, int4
 *   and numeric sums and max in their least units, sets as code masks; and the host's fill (runtime/write/fill.ts
 *   filler over the installation's own families and codes), which must fill every lawful family exactly as the reference
 *   does before PostgreSQL judges what both wrote. Every lawful state must commit and read back exactly; the twos fold's at most one of K, `bit_count(twos & K) = 0` as a
 *   check of its twos plane, refuses exactly the families where a handle of K is held twice.
 * - **The fold's model** (fold.ts foldPredicted): each after proved by `CHECK ((after = combine(before, x)) IS TRUE)`
 *   in exact arithmetic, every after drawn, never generated, per the ruling; the identity pins at the first slot and at
 *   the empty family; the befores carried on the predecessor axis and the ends on the last axis. A junk accumulator must
 *   be refused at the model's moment, by an installed constraint whose role (folds.ts foldNativeOf) the model allows
 *   there, with its SQLSTATE, reporting the family's or the fold's law.
 * - **The pin at a tree's root:** a tree folded by count over each node's children, written in every forest of at most
 *   four rows with its root's accumulators over every small value: the root is outside its family, so its pin must
 *   admit it exactly one state, and refuse every other.
 *
 * The junk kinds (doctrine rule 6), each a named variant: the whole fold seeded from a junk identity, every before,
 * after and end consistent with it (the fold accumulator unconstrained at slot 0); one before; one after; one end; an
 * empty family's end. **Mutation rediscovery:** the int4 sum's installation with its first-slot pin dropped, and with
 * its empty-family pin dropped, each a schema of its own; each must be killed, committing a junk seed and a junk empty
 * end respectively. Features are (monoid, axis, verdict).
 */
import { layer } from "@effect/vitest"
import { exhaust, type Oracle } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { accumulated, drawn, natural, pg } from "#compiler/public/fields.ts"
import { fin, fold, Monoid, on, relation, schema, tree } from "#compiler/public/schema.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import {
	attemptedText,
	byMember,
	Disagreed,
	FOLD_SPECS,
	type FoldSpec,
	type FoldVerdict,
	foldInstalledOf,
	foldSeat,
	foldWriteOf,
	hostFilled,
	type Judging,
	judgedFold
} from "#test/pg/fin/folds.ts"
import {
	type Catalogued,
	cleared,
	droppedSql,
	mutated,
	type Seat,
	seatOf
} from "#test/pg/fin/installed.ts"
import { forestsOf } from "#test/pg/substrate/tree.ts"
import type { TreeRow } from "#test/pg/substrate/tree.ts"
import { deepEquals, nonEmpty } from "#test/support/assert.ts"
import {
	type FoldFamily,
	type FoldNative,
	type FoldStored,
	foldStoredFrom,
	foldStoredOf,
	foldedFrom,
	grizzleFold,
	identityOf,
	type Planes
} from "#test/support/families/fold.ts"
import { caseHang } from "#test/support/limits.ts"
import { attempt } from "#test/support/substrate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** No owner and no row: every case is written from it. */
const emptyFold: FoldStored = { owners: [], rows: [] }

/** A single junk accumulator of a family (the header's kinds), at a slot and a plane where it names one. */
type Junk =
	| { readonly kind: "none" }
	| { readonly kind: "a junk seed" }
	| {
			readonly kind: "a junk before" | "a junk after"
			readonly slot: number
			readonly plane: number
	  }
	| { readonly kind: "a junk end"; readonly plane: number }
	| { readonly kind: "a junk step"; readonly slot: number }

/** A junk kind as a feature, the first slot and the empty family told apart: the axis it is on. */
type JunkAxis =
	| "lawful"
	| "a junk seed"
	| "a junk before at the first slot"
	| "a junk before past the first slot"
	| "a junk after"
	| "a junk end"
	| "a junk end of an empty family"
	| "a junk step at the first slot"
	| "a junk step past the first slot"

const axisOf = (junk: Junk, n: number): JunkAxis => {
	switch (junk.kind) {
		case "none":
			return "lawful"
		case "a junk seed":
			return "a junk seed"
		case "a junk before":
			return junk.slot === 0
				? "a junk before at the first slot"
				: "a junk before past the first slot"
		case "a junk after":
			return "a junk after"
		case "a junk end":
			return n === 0 ? "a junk end of an empty family" : "a junk end"
		case "a junk step":
			return junk.slot === 0 ? "a junk step at the first slot" : "a junk step past the first slot"
	}
}

/** A case: a family of owner 0, its members' value indices into the domain, and one junk or none. */
interface Sketch {
	readonly values: ReadonlyArray<number>
	readonly junk: Junk
}

/** Families of up to four members are written lawful; families of up to three also with every single junk. */
const box = { lawful: 4, junked: 3 } as const

const junksOf = (n: number, planes: number): ReadonlyArray<Junk> => [
	{ kind: "a junk seed" },
	...Arr.flatMap(Arr.range(0, n - 1).slice(0, n), (slot) =>
		Arr.flatMap(Arr.range(0, planes - 1), (plane): ReadonlyArray<Junk> => [
			{ kind: "a junk before", slot, plane },
			{ kind: "a junk after", slot, plane }
		])
	),
	...Arr.map(Arr.range(0, planes - 1), (plane): Junk => ({ kind: "a junk end", plane })),
	...Arr.map(Arr.range(0, n - 1).slice(0, n), (slot): Junk => ({ kind: "a junk step", slot }))
]

const sketchGen =
	(planes: number): Gen<Sketch> =>
	(source) => {
		const n = source.draw(element(nonEmpty(Arr.range(0, box.lawful))))
		const values = Arr.map(Arr.range(0, n - 1).slice(0, n), () =>
			source.draw(element([0, 1, 2, 3, 4] as const))
		)
		const junks: Arr.NonEmptyReadonlyArray<Junk> =
			n <= box.junked ? [{ kind: "none" }, ...junksOf(n, planes)] : [{ kind: "none" }]
		return { values, junk: source.draw(element(junks)) }
	}

const sketchCases = (planes: number): number =>
	Arr.reduce(
		Arr.range(0, box.lawful),
		0,
		(sum, n) => sum + 5 ** n * (1 + (n <= box.junked ? junksOf(n, planes).length : 0))
	)

/** A plane list with one plane replaced. */
const replacedPlane = (planes: Planes, plane: number, value: bigint): Planes =>
	nonEmpty(Arr.map(planes, (v, i) => (i === plane ? value : v)))

/** The stored state a sketch writes: the reference fold of its family, then its junk. */
/** A sketch's family as its caller writes it: owner 0's members, each its value and whether its row is selected. */
const familyOf = (spec: FoldSpec, sketch: Sketch): FoldFamily => ({
	owner: 0,
	members: Arr.map(sketch.values, (i, member) => ({
		member,
		x: Arr.getUnsafe(spec.domain, i),
		selected: Option.match(spec.selected, { onNone: () => true, onSome: (s) => s(i) })
	}))
})

const storedOf = (spec: FoldSpec, sketch: Sketch): FoldStored => {
	const { members } = familyOf(spec, sketch)
	const lawful = foldStoredOf(spec.monoid, [{ owner: 0, members }])
	const junk = spec.carrier.junk
	const j = sketch.junk
	switch (j.kind) {
		case "none":
			return lawful
		case "a junk seed":
			return foldStoredFrom(
				spec.monoid,
				[{ owner: 0, members }],
				nonEmpty(Arr.map(identityOf(spec.monoid), junk))
			)
		case "a junk before":
		case "a junk after":
			return {
				owners: lawful.owners,
				rows: Arr.map(lawful.rows, (r) =>
					r.at !== j.slot
						? r
						: j.kind === "a junk before"
							? {
									...r,
									before: replacedPlane(r.before, j.plane, junk(Arr.getUnsafe(r.before, j.plane)))
								}
							: {
									...r,
									after: replacedPlane(r.after, j.plane, junk(Arr.getUnsafe(r.after, j.plane)))
								}
				)
			}
		case "a junk step":
			return {
				owners: lawful.owners,
				rows: Arr.map(lawful.rows, (r) => {
					if (r.at !== j.slot) {
						return r
					}
					const before = nonEmpty(Arr.map(r.before, junk))
					return {
						...r,
						before,
						after: Arr.getUnsafe(foldedFrom(spec.monoid, before, [r]).slots, 0).after
					}
				})
			}
		case "a junk end":
			return {
				owners: Arr.map(lawful.owners, (o) => ({
					...o,
					end: replacedPlane(o.end, j.plane, junk(Arr.getUnsafe(o.end, j.plane)))
				})),
				rows: lawful.rows
			}
	}
}

type Mutant = "first pin dropped" | "empty pin dropped"

type FoldFeature = `${string} ${JunkAxis} ${FoldVerdict}` | `${Mutant} killed by ${JunkAxis}`

const ORACLE: Oracle = {
	kind: "second-implementation",
	name: "the reference fold (test/support/families/fold.ts folded), exact, beside the fold's model of each installed native's moment (fold.ts foldPredicted)"
}

/** The features a seat must reach: lawful commits and each junk refused by the native that owns its axis. */
const requiredOf = (spec: FoldSpec): ReadonlyArray<FoldFeature> => {
	const l = spec.label
	return [
		`${l} lawful committed`,
		`${l} a junk seed refused first slot`,
		`${l} a junk end of an empty family refused empty family`,
		`${l} a junk after refused combine`,
		`${l} a junk before past the first slot refused combine`,
		`${l} a junk end refused last axis`,
		`${l} a junk step at the first slot refused first slot`,
		`${l} a junk step past the first slot refused predecessor axis`
	]
}

/** The tree folded by count over each node's children: its accumulators named, its root outside the family. */
const FoldedNode = relation(
	"Node",
	{
		id: pg.int4,
		doc: pg.int4,
		parent: pg.int4,
		at: drawn(natural),
		children: drawn(natural),
		start: drawn(natural),
		end: drawn(natural),
		before: accumulated(natural, 0n),
		after: accumulated(natural, 0n),
		total: accumulated(natural, 0n)
	},
	["id"]
)

const FoldedTree = (() => {
	const t = tree(on(FoldedNode, "parent", "at"), fin(FoldedNode, "children"), { root: "doc" })
	return schema("fin_fold_tree", { Node: FoldedNode }, [
		t,
		fold(
			t,
			Monoid.count,
			on(FoldedNode, "parent", "before", "after"),
			on(FoldedNode, "id", "total")
		)
	])
})()

/** A folded tree row: the tree's row and its count fold's before, after and total. */
interface FoldedRow extends TreeRow {
	readonly before: number
	readonly after: number
	readonly total: number
}

const TREE_COLUMNS = [
	"id",
	"doc",
	"parent",
	"at",
	"children",
	"start",
	"end",
	"‹n›",
	"‹ps›",
	"before",
	"after",
	"total"
] as const

/**
 * The int4 sum's fold CHECK re-created without its first-slot pin, `((after = before + x) IS TRUE)` in place of
 * `(((at > 0 OR before = 0) AND after = before + x) IS TRUE)`: the mutant of the fold accumulator unconstrained at
 * slot 0, the same combine with the pin's conjunct gone.
 */
const pinlessSql = (seat: Seat, checks: ReadonlyArray<Catalogued>): ReadonlyArray<string> =>
	Arr.flatMap(checks, (c) => [
		droppedSql(seat, c),
		`ALTER TABLE ${seat.table("Member")} ADD CONSTRAINT ${quoteIdent(c.name)} CHECK ((${seat.column("Member", "after")} = ${seat.column("Member", "before")}::int8 + ${seat.column("Member", "x")}::int8) IS TRUE)`
	])

layer(Substrate.layer)("folds through grizzle's lowering on PostgreSQL 19rc1", (it) => {
	for (const spec of FOLD_SPECS) {
		it.effect(
			`commit the reference fold of every family of at most four members over five values, and refuse every single junk accumulator by the native that owns its axis: ${spec.label}`,
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const grizzle: Judging = {
							label: spec.label,
							fold: yield* foldSeat(spec, spec.label),
							lowering: grizzleFold(spec.shape)
						}
						const mutants: ReadonlyArray<Judging & { readonly mutant: Mutant }> =
							spec.label === "sum of int4"
								? yield* Effect.forEach(
										["first pin dropped", "empty pin dropped"] as const,
										(mutant) =>
											Effect.gen(function* () {
												const f = yield* foldSeat(spec, `${spec.label} ${mutant}`)
												const native: FoldNative =
													mutant === "first pin dropped" ? "first slot" : "empty family"
												const seat = yield* mutated(
													f.seat,
													["Owner", "Member"],
													`${spec.label} ${mutant}`,
													mutant === "first pin dropped"
														? pinlessSql(f.seat, foldInstalledOf(f, "combine"))
														: Arr.map(foldInstalledOf(f, native), (c) => droppedSql(f.seat, c))
												)
												return {
													label: `${spec.label} ${mutant}`,
													fold: { ...f, seat },
													lowering: {
														...grizzleFold(spec.shape),
														firstPin: mutant !== "first pin dropped",
														emptyPin: mutant !== "empty pin dropped"
													},
													mutant
												}
											})
									)
								: []
						const planes = spec.planes.length
						return yield* exhaust(
							{
								suite: `fin/fold ${spec.label}`,
								generator: sketchGen(planes),
								literal: Formatter.format,
								limit: sketchCases(planes),
								box: "owner 0 with every family of zero to four members over the seat's five step values, each written lawful, and every family of zero to three members with every single junk accumulator: a junk seed, one before, one after, one end",
								oracle: ORACLE,
								coverage: requiredInSpace<FoldFeature>(
									nonEmpty([
										...requiredOf(spec),
										...(Arr.isReadonlyArrayNonEmpty(mutants)
											? ([
													"first pin dropped killed by a junk seed",
													"empty pin dropped killed by a junk end of an empty family"
												] as const)
											: [])
									])
								),
								caseHang
							},
							(sketch, c) =>
								Effect.gen(function* () {
									const stored = storedOf(spec, sketch)
									const axis = axisOf(sketch.junk, sketch.values.length)
									if (sketch.junk.kind === "none") {
										const host = hostFilled(grizzle.fold, familyOf(spec, sketch))
										if (
											Result.isFailure(host) ||
											!deepEquals(byMember(host.success), byMember(stored))
										) {
											return yield* new Disagreed({
												message: `${spec.label}: the host's fill ${Result.isFailure(host) ? host.failure : Formatter.format(host.success)} is not the reference fold ${Formatter.format(stored)}`
											})
										}
									}
									const verdict = yield* judgedFold(grizzle, emptyFold, foldWriteOf(stored), [])
									c.note(`${spec.label} ${axis} ${verdict}`)
									if (sketch.junk.kind !== "none" && verdict === "committed") {
										return yield* new Disagreed({
											message: `${spec.label}: ${axis} committed: ${Formatter.format(stored)}`
										})
									}
									for (const m of mutants) {
										const v = yield* judgedFold(m, emptyFold, foldWriteOf(stored), [])
										if (v === "committed" && sketch.junk.kind !== "none") {
											c.note(`${m.mutant} killed by ${axis}`)
										}
									}
								})
						)
					})
				)
		)
	}

	it.effect(
		"admit a tree's root exactly one state of its fold's accumulators, and refuse every other, in every forest of at most four rows",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const seat = yield* seatOf(FoldedTree, ["Node"], "fold tree")
					const laws = [...seat.lawsOf("tree"), ...seat.lawsOf("fold")]
					const forests = nonEmpty(forestsOf(4), "a forest")
					/** A forest's rows with each member's count accumulators by its slot, each total its count. */
					const lawful = (rows: ReadonlyArray<TreeRow>): ReadonlyArray<FoldedRow> =>
						Arr.map(rows, (r) => ({ ...r, before: r.at, after: r.at + 1, total: r.children }))
					const candidates = Arr.flatMap([0, 1], (before) =>
						Arr.map([0, 1, 2], (after) => ({ before, after }))
					)
					type RootFeature = "a root's one state committed" | "a root's other states refused"
					return yield* exhaust(
						{
							suite: "fin/fold-tree-root",
							generator: element(forests),
							literal: Formatter.format,
							limit: forests.length,
							box: "every tree and forest of two trees of at most four rows, each root's before over 0 to 1 and after over 0 to 2, every other accumulator the count fold's",
							oracle: {
								kind: "specification",
								name: "a pin's contract: the root, outside its family, admits exactly one state of its accumulators"
							},
							coverage: requiredInSpace<RootFeature>([
								"a root's one state committed",
								"a root's other states refused"
							]),
							caseHang
						},
						(forest, c) =>
							Effect.gen(function* () {
								const committed: Array<{ readonly before: number; readonly after: number }> = []
								for (const candidate of candidates) {
									const rows = Arr.map(lawful(forest), (r) =>
										r.parent === r.id ? { ...r, ...candidate } : r
									)
									const values = (r: FoldedRow) => [
										r.id,
										r.root,
										r.parent,
										r.at,
										r.children,
										r.start,
										r.end,
										r.copy,
										r.parentStart,
										r.before,
										r.after,
										r.total
									]
									const real = yield* attempt(seat.session, [
										`INSERT INTO ${seat.table("Node")} (${Arr.join(
											Arr.map(TREE_COLUMNS, (col) => seat.column("Node", col)),
											", "
										)}) VALUES ${Arr.join(
											Arr.map(rows, (r) => `(${Arr.join(Arr.map(values(r), String), ", ")})`),
											", "
										)}`
									])
									yield* seat.session.resetStatements
									if (real.kind === "committed") {
										committed.push(candidate)
										yield* cleared(seat, ["Node"])
									} else {
										const named = seat.refusedBy(real.fields)
										if (
											real.fields.code !== "23514" ||
											!Option.exists(named, (n) => Option.exists(n.law, (l) => laws.includes(l)))
										) {
											return yield* new Disagreed({
												message: `a root's accumulators ${Formatter.format(candidate)} were refused by ${attemptedText(real)}, not by a pin of the tree or the fold`
											})
										}
										c.note("a root's other states refused")
									}
								}
								if (committed.length !== 1) {
									return yield* new Disagreed({
										message: `the root admits ${committed.length} states of its accumulators, ${Formatter.format(committed)}, not exactly one, in ${Formatter.format(forest)}`
									})
								}
								c.note("a root's one state committed")
							})
					)
				})
			)
	)
})
