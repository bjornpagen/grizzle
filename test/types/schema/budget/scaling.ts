import { Array as Arr } from "effect"
import { indices } from "#compiler/core/array.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { type PreludeAt, preludeProgram } from "#test/support/prelude.ts"

/**
 * The schema-scale programs, one per schema dimension, each checked at n, 2n and 4n (scaling.test.ts). A program at a
 * shape writes `relations` relations R0 … over P, each with its id, its parent and `fields` uuid fields f0 …, and
 * `laws` laws: the first contains its parent in P's ids, as issue #9's schema does; then, field by field, a key on the
 * field and a containment of the field in P's ids, in turn. Beside them stand a roster K of `handles` handles H0 …, the
 * set of its first `members` handles (Bits.of), and `closed` closed relations C0 … over it, which no role holds; a
 * roster and a set each list their handles once, which the type reads for a repeat. Over that schema it writes `roles`
 * full roles, each its base's whole entries
 * (wholeEntriesOf) beside a query entry of its own, writing every relation it may, spelled as `writes` says:
 * writableNamesOf(S), or a literal list of their names, which role reads for a repeat; each read as issue #9 reads
 * one, `ChangeSet.empty(role)` and `query(role)`; and over the base, for each of the last `readers` relations, a
 * ChangeSet and a query that read it by name: its addition, holding every written field, and a rule matching every
 * field.
 */
type SchemaShape = {
	readonly relations: number
	readonly closed: number
	readonly laws: number
	readonly fields: number
	readonly roles: number
	readonly writes: "writableNamesOf" | "listed"
	readonly readers: number
	readonly handles: number
	readonly members: number
}

/** One dimension: its name, the shape at n, and the shape at a size of its own along the dimension. */
interface SchemaDimension {
	readonly name: string
	readonly sizes: readonly [number, number, number]
	readonly shape: (size: number) => SchemaShape
}

/**
 * The dimensions and their sizes. The full role's entries reach past issue #9's cliff, 1,107 relations each with a law
 * under one full role, at which ChangeSet.empty(role) and query(role) failed with TS2589, and its closed relations,
 * which its entries leave out, grow with them. Each list a user grows whose names the type reads for a repeat (a full
 * role's write list, a roster's handles and a set's handles) runs past 1,200 names, where a recursive kernel failed
 * with TS2589 at 1,000; a key's fields and a side's terms, which the same kernel reads, stop at PostgreSQL's 32 columns
 * of one index.
 */
export const schemaDimensions: ReadonlyArray<SchemaDimension> = [
	{
		name: "relations",
		sizes: [250, 500, 1000],
		shape: (relations) => ({
			relations,
			closed: 1,
			laws: 1,
			fields: 1,
			roles: 0,
			writes: "writableNamesOf",
			readers: 1,
			handles: 2,
			members: 1
		})
	},
	{
		name: "full-role entries",
		sizes: [300, 600, 1200],
		shape: (relations) => ({
			relations,
			closed: relations / 10,
			laws: 1,
			fields: 1,
			roles: 1,
			writes: "writableNamesOf",
			readers: 1,
			handles: 2,
			members: 1
		})
	},
	{
		name: "write-list names",
		sizes: [300, 600, 1200],
		shape: (relations) => ({
			relations,
			closed: 1,
			laws: 1,
			fields: 1,
			roles: 1,
			writes: "listed",
			readers: 1,
			handles: 2,
			members: 1
		})
	},
	{
		name: "roster handles",
		sizes: [325, 650, 1300],
		shape: (handles) => ({
			relations: 25,
			closed: 1,
			laws: 1,
			fields: 1,
			roles: 0,
			writes: "writableNamesOf",
			readers: 1,
			handles,
			members: 1
		})
	},
	{
		name: "set handles",
		sizes: [325, 650, 1300],
		shape: (members) => ({
			relations: 25,
			closed: 1,
			laws: 1,
			fields: 1,
			roles: 0,
			writes: "writableNamesOf",
			readers: 1,
			handles: members,
			members
		})
	},
	{
		name: "laws per relation",
		sizes: [4, 8, 16],
		shape: (laws) => ({
			relations: 100,
			closed: 1,
			laws,
			fields: 16,
			roles: 1,
			writes: "writableNamesOf",
			readers: 1,
			handles: 2,
			members: 1
		})
	},
	{
		name: "roles per schema",
		sizes: [4, 8, 16],
		shape: (roles) => ({
			relations: 100,
			closed: 1,
			laws: 1,
			fields: 1,
			roles,
			writes: "writableNamesOf",
			readers: 1,
			handles: 2,
			members: 1
		})
	},
	{
		name: "fields per relation",
		sizes: [8, 16, 32],
		shape: (fields) => ({
			relations: 25,
			closed: 1,
			laws: 1,
			fields,
			roles: 1,
			writes: "writableNamesOf",
			readers: 25,
			handles: 2,
			members: 1
		})
	}
]

const fieldNames = (fields: number): ReadonlyArray<string> =>
	Arr.map(indices(fields), (j) => `f${j}`)

/** Relation i's laws: its parent in P's ids, then a key and a containment on its fields, in turn. */
const lawsOf = (i: number, laws: number): ReadonlyArray<string> =>
	Arr.map(indices(laws), (j) =>
		j === 0
			? `contained(on(R${i}, "parent"), on(P, "id"))`
			: j % 2 === 1
				? `key(on(R${i}, "f${j - 1}"))`
				: `contained(on(R${i}, "f${j - 1}"), on(P, "id"))`
	)

/**
 * Role g's own query entry, the ids of one relation: every role holds every relation of the base whole but the closed
 * ones, a full role, and one entry of its own, so no two roles are one type.
 */
const seenEntry = (g: number, relations: number): string =>
	`query(S).rule((r) => {
	const { id } = v(R${g % relations}, "seen")
	return r.match(R${g % relations}, { id }).find({ id })
})`

/** Every relation a full role may write, as `writes` spells it: writableNamesOf(S), or a literal list of names. */
const writesSource = (shape: SchemaShape): string => {
	switch (shape.writes) {
		case "writableNamesOf":
			return "writableNamesOf(S)"
		case "listed":
			return `["P", ${Arr.join(
				Arr.map(indices(shape.relations), (i) => `"R${i}"`),
				", "
			)}]`
	}
}

/** The first `count` handles of the roster K, each a literal in the program. */
const handlesSource = (count: number): string =>
	Arr.join(
		Arr.map(indices(count), (h) => `"H${h}"`),
		", "
	)

/** A complete program at `shape`, its imports read through the gates' prelude as `entries` reaches it. */
export const schemaScaleSource = (shape: SchemaShape, entries: PreludeAt): string => {
	const last = shape.relations - 1
	const writes = writesSource(shape)
	const fields = fieldNames(shape.fields)
	const heading = Arr.join(
		Arr.map(["id", "parent", ...fields], (f) => `${f}: uuid`),
		", "
	)
	const written = Arr.join(
		Arr.map(["id", "parent", ...fields], (f) => `${f}: someId`),
		", "
	)
	const bound = Arr.join(["id", "parent", ...fields], ", ")
	return preludeProgram(
		`// Generated by test/types/schema/budget/scaling.ts at ${jsonText(shape)}.`,
		entries,
		`export const P = relation("P", { id: uuid }, ["id"])
export const K = closed("K", [${handlesSource(shape.handles)}])
export const members = Bits.of(K, [${handlesSource(shape.members)}])
${Arr.join(
	Arr.map(
		indices(shape.closed),
		(c) =>
			`export const C${c} = closed.relation("C${c}", { k: closedId(K), weight: pg.integer }, ["k"], [{ k: "H0", weight: ${c} }])\n`
	),
	""
)}${Arr.join(
			Arr.map(
				indices(shape.relations),
				(i) => `export const R${i} = relation("R${i}", { ${heading} }, ["id"])\n`
			),
			""
		)}
export const S = schema("Scale", { P, K, ${Arr.join(
			Arr.map(indices(shape.closed), (c) => `C${c}`),
			", "
		)}, ${Arr.join(
			Arr.map(indices(shape.relations), (i) => `R${i}`),
			", "
		)} }, [
${Arr.join(
	Arr.flatMap(indices(shape.relations), (i) => Arr.map(lawsOf(i, shape.laws), (law) => `\t${law}`)),
	",\n"
)}
])
${Arr.join(
	Arr.map(
		indices(shape.roles),
		(
			g
		) => `export const Full${g} = role(S, "full${g}", { ...wholeEntriesOf(S), Seen${g}: ${seenEntry(g, shape.relations)} }, { write: ${writes} })
export const empty${g} = ChangeSet.empty(Full${g})
export const over${g} = query(Full${g})
`
	),
	""
)}
declare const someId: Uuid
${Arr.join(
	Arr.map(
		indices(shape.readers),
		(k) => `export const insert${k} = ChangeSet.empty(S).insert(R${last - k}, [{ ${written} }])
export const read${k} = query(S).rule((r) => {
	const { ${bound} } = v(R${last - k}, "read")
	return r.match(R${last - k}, { ${bound} }).find({ ${bound} })
})
`
	),
	""
)}`
	)
}
