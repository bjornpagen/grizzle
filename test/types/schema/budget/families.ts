import { Array as Arr, Option } from "effect"
import { indices } from "#compiler/core/array.ts"
import { type PreludeAt, preludeProgram } from "#test/support/prelude.ts"
import { type EqualSteps, equalSteps } from "#test/types/batch/measured.ts"
import { type Over, type RefusalProbe, twinPrefix, twinProbes } from "#test/types/batch/twins.ts"

/**
 * The family-scale program, one type test of families, trees, folds and nested additions at scale
 * (test/types/schema/budget/families.test.ts). It writes one TypeScript program over the public barrels with
 * `families` families and as many folds, all in one schema(...) call, in units of two families and two folds each:
 *
 * - a **nested** unit: an owner O with an ordered family of lines F over its drawn count n, each line itself the owner
 *   of an ordered family of parts G over its drawn count m (nesting depth 2), and a sum fold at each level, into an
 *   accumulated end of the owner above;
 * - every fourth unit, a **tree** unit: a tree T over its drawn children, start and end, with its root field doc and a
 *   count fold of each node's children, beside a counted family of items I in a pool P (an unordered set of member
 *   rows) with a count fold, flat: the pool and its items are each inserted as rows, an item's group key naming its
 *   pool.
 *
 * Over the schema it inserts every relation a ChangeSet inserts at its top level in one insertAll, the rows typed by
 * grizzle (InsertAllRowsOf), so the rows the types state are the rows insertAll takes.
 *
 * insertAll costs one step per key and one per family: each key's immutable owners are one read of the schema's index
 * of family owners by member (types/changeset/changeset.ts RowOwnerIndexOf), never a pass over its families, which made
 * the call keys times families; and rows typed by their addition fit it by identity, never by a walk of their fields,
 * which spent about 8,000 instantiations a key and passed TypeScript's 5,000,000 a statement at 1,000 families.
 *
 * A nested addition is indexed by mapping over the owner's families (types/changeset/changeset.ts AdditionIn), never
 * by a count field's name: an index by name failed with TS2859 at 1,000 families (U1's budget proof, 2026-11-05).
 *
 * At the largest size the program stands beside its twin (batch/twins.ts), the same declarations over the first and
 * the last unit of each kind alone: each one's additions, the relations a ChangeSet inserts at its top level and the
 * rows insertAll takes of them are the twin's, and an ordered member written alone and a counted member nested under
 * its owner are refused at scale as over the twin.
 */

/** A unit is two families, and every fourth unit a tree unit: the program repeats every eight families. */
const familyPeriod = 8

/** The family counts the scale test checks, each a program of its own: the growth law is read from their counts. */
export const familySizes: EqualSteps = equalSteps(familyPeriod * 85)

/** The family count the type-test batch checks the program at, beside its twin. */
export const largestFamilies = familySizes.sizes[2]

/** Whether unit u is a tree unit: every fourth, from the fourth, so the first and last units of each kind exist. */
const isTreeUnit = (u: number): boolean => u % 4 === 3

const nestedUnit = (
	ns: string,
	u: number
): string => `export const ${ns}O${u} = relation("O${u}", { id: uuid, n: drawn(natural), total: accumulated(pg.bigint, 0n) }, ["id"])
export const ${ns}F${u} = relation("F${u}", { owner: uuid, at: drawn(natural), m: drawn(natural), x: pg.bigint, parts: accumulated(pg.bigint, 0n) }, ["owner", "at"])
export const ${ns}G${u} = relation("G${u}", { owner: uuid, line: natural, at: drawn(natural), y: pg.bigint }, ["owner", "line", "at"])
export const ${ns}lines${u} = ordered(on(${ns}F${u}, "owner", "at"), fin(${ns}O${u}, "n"))
export const ${ns}parts${u} = ordered(on(${ns}G${u}, "owner", "line", "at"), fin(${ns}F${u}, "m"))
export const ${ns}lineSum${u} = fold(${ns}lines${u}, Monoid.sum, on(${ns}F${u}, "owner", "x"), on(${ns}O${u}, "id", "total"))
export const ${ns}partSum${u} = fold(${ns}parts${u}, Monoid.sum, on(${ns}G${u}, "owner", "line", "y"), on(${ns}F${u}, "owner", "at", "parts"))
`

const treeUnit = (
	ns: string,
	u: number
): string => `export const ${ns}T${u} = relation("T${u}", { doc: uuid, parent: drawn(natural), at: drawn(natural), children: drawn(natural), start: drawn(natural), end: drawn(natural), size: accumulated(natural, 0n) }, ["doc", "start"])
export const ${ns}P${u} = relation("P${u}", { id: uuid, k: drawn(natural), size: accumulated(natural, 0n) }, ["id"])
export const ${ns}I${u} = relation("I${u}", { pool: uuid, w: pg.integer }, ["pool", "w"])
export const ${ns}nodes${u} = tree(on(${ns}T${u}, "parent", "at"), fin(${ns}T${u}, "children"), { root: ["doc"] })
export const ${ns}nodeCount${u} = fold(${ns}nodes${u}, Monoid.count, on(${ns}T${u}, "doc", "parent"), on(${ns}T${u}, "doc", "start", "size"))
export const ${ns}items${u} = counted(on(${ns}I${u}, "pool"), fin(${ns}P${u}, "k"))
export const ${ns}itemCount${u} = fold(${ns}items${u}, Monoid.count, on(${ns}I${u}, "pool"), on(${ns}P${u}, "id", "size"))
`

/** A unit's relations, in declaration order. */
const relationsOf = (u: number): ReadonlyArray<string> =>
	isTreeUnit(u) ? [`T${u}`, `P${u}`, `I${u}`] : [`O${u}`, `F${u}`, `G${u}`]

/** A unit's statements: its two families and its two folds. */
const statementsOf = (u: number): ReadonlyArray<string> =>
	isTreeUnit(u)
		? [`nodes${u}`, `nodeCount${u}`, `items${u}`, `itemCount${u}`]
		: [`lines${u}`, `parts${u}`, `lineSum${u}`, `partSum${u}`]

/** The schema of `units`, under the prefix `ns`, and the insertAll of every relation it inserts at its top level. */
const unitsSource = (ns: string, units: ReadonlyArray<number>): string => `${Arr.join(
	Arr.map(units, (u) => (isTreeUnit(u) ? treeUnit(ns, u) : nestedUnit(ns, u))),
	""
)}
export const ${ns}S = schema("FamilyScale", { ${Arr.join(
	Arr.map(Arr.flatMap(units, relationsOf), (name) => `${name}: ${ns}${name}`),
	", "
)} }, [
${Arr.join(
	Arr.map(Arr.flatMap(units, statementsOf), (s) => `\t${ns}${s}`),
	",\n"
)}
])

/** Every relation a ChangeSet inserts at its top level, inserted at once, their rows typed from grizzle. */
declare const ${ns}rows: InsertAllRowsOf<typeof ${ns}S>
export const ${ns}insertedAll = ChangeSet.empty(${ns}S).insertAll(${ns}rows)
`

/** The program of `families` families, an even count, two per unit, its imports read through `entries`. */
export const generateFamiliesSource = (families: number, entries: PreludeAt): string =>
	preludeProgram(
		`// Generated by test/types/schema/budget/families.ts with ${families} families and ${families} folds.`,
		entries,
		unitsSource("", indices(Math.floor(families / 2)))
	)

/** The first and the last of `units`, once each. */
const ends = (units: ReadonlyArray<number>): ReadonlyArray<number> =>
	Arr.dedupe(Arr.getSomes([Arr.head(units), Arr.last(units)]))

/** What a unit's probes compare at scale and over the twin: its additions. */
const unitProbes = (u: number): ReadonlyArray<Over> =>
	Arr.map(
		relationsOf(u),
		(name) => (ns: string) => `AdditionIn<typeof ${ns}S, typeof ${ns}${name}>`
	)

/** What the whole schema's probes compare, restricted to the twin's relations: what a ChangeSet inserts, and its rows. */
const schemaProbes: ReadonlyArray<Over> = [
	(ns) => `Extract<InsertableNameOf<typeof ${ns}S>, keyof typeof ${twinPrefix}S.relations>`,
	(ns) => `Pick<InsertAllRowsOf<typeof ${ns}S>, keyof InsertAllRowsOf<typeof ${twinPrefix}S>>`
]

/** The refusal probes, each one line at scale and over the twin. */
const refusalProbes = (lastNested: number, lastTree: number): ReadonlyArray<RefusalProbe> => [
	{
		label: "member-alone",
		why: "a sequence's member is written under its owner, never alone",
		line: (ns) =>
			`export const ${ns}memberAlone = ChangeSet.empty(${ns}S).insert(${ns}F${lastNested}, [{ owner: id, x: 1n, m: [] }])`
	},
	{
		label: "counted-nested",
		why: "a counted member is never nested under its owner",
		line: (ns) =>
			`export const ${ns}countedNested = ChangeSet.empty(${ns}S).insert(${ns}P${lastTree}, [{ id, k: [{ w: 1 }] }])`
	}
]

/**
 * The program of `families` families beside its twin, the first and the last unit of each kind, and the probes that
 * compare them, its imports read through `entries`.
 */
export const familiesTwinSource = (families: number, entries: PreludeAt): string => {
	const units = indices(Math.floor(families / 2))
	const nested = Arr.filter(units, (u) => !isTreeUnit(u))
	const trees = Arr.filter(units, isTreeUnit)
	const lastNested = Arr.last(nested)
	const lastTree = Arr.last(trees)
	if (Option.isNone(lastNested) || Option.isNone(lastTree)) {
		throw new Error(
			`a family-scale program of ${families} families holds a nested unit and a tree unit`
		)
	}
	const probed = [...ends(nested), ...ends(trees)]
	return preludeProgram(
		`// Generated by test/types/schema/budget/families.ts with ${families} families and ${families} folds, and their twin.`,
		entries,
		`${unitsSource("", units)}
${unitsSource(twinPrefix, probed)}
declare const id: Uuid
${twinProbes(
	[...Arr.flatMap(probed, unitProbes), ...schemaProbes],
	refusalProbes(lastNested.value, lastTree.value)
)}`
	)
}
