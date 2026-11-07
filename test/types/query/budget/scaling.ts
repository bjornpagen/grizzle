import { Array as Arr } from "effect"
import { indices } from "#compiler/core/array.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { type PreludeAt, preludeProgram } from "#test/support/prelude.ts"

/**
 * The query-scale programs, one per dimension of what a program states over a schema, each checked at n, 2n and 4n
 * (scaling.test.ts). The schema is the growing-schema program's (generate.ts): `relations` relations R0 … with candidate
 * keys, a containment chain, every relation's kind contained in the Kind roster and every seventh relation mutable,
 * and a full role Reader. Over it a program at a shape writes:
 *
 * - `rules` queries, each a rule over relation i (round the relations) with a filter, an attachment of the relation
 *   before it keyed by the parent's field, delivered as the one child where the containment chain proves it, and a read
 *   of it through a Db of the Reader;
 * - one ChangeSet of `members` members in one stratum, round the relations: inserts, or inserts, deletes and puts in turn,
 *   each put of a mutable relation, so a chain's every call is checked against the stratum the call before it made;
 * - `contexts` contexts, each read by a query entry of one role, Ctx, and each entry's query run through a Db of Ctx.
 *
 * One dimension grows the schema with its rules and members, as an application grows: a call whose cost grows with the
 * schema it is over, rather than with what it reads, makes that dimension quadratic.
 */
type QueryShape = {
	readonly relations: number
	readonly rules: number
	readonly members: number
	readonly writes: "inserts" | "inserts, deletes and puts"
	readonly contexts: number
}

/** One dimension: its name, its sizes, and the shape at a size along it. */
interface QueryDimension {
	readonly name: string
	readonly sizes: readonly [number, number, number]
	readonly shape: (size: number) => QueryShape
}

export const queryDimensions: ReadonlyArray<QueryDimension> = [
	{
		name: "query rules and attachments",
		sizes: [25, 50, 100],
		shape: (rules) => ({ relations: 25, rules, members: 0, writes: "inserts", contexts: 0 })
	},
	{
		name: "ChangeSet inserts",
		sizes: [75, 150, 300],
		shape: (members) => ({ relations: 25, rules: 0, members, writes: "inserts", contexts: 0 })
	},
	{
		name: "ChangeSet inserts, deletes and puts",
		sizes: [75, 150, 300],
		shape: (members) => ({
			relations: 25,
			rules: 0,
			members,
			writes: "inserts, deletes and puts",
			contexts: 0
		})
	},
	{
		name: "contexts",
		sizes: [8, 16, 32],
		shape: (contexts) => ({ relations: 25, rules: 0, members: 0, writes: "inserts", contexts })
	},
	{
		name: "relations with their rules and members",
		sizes: [25, 50, 100],
		shape: (size) => ({
			relations: size,
			rules: size,
			members: size,
			writes: "inserts",
			contexts: 0
		})
	}
]

const statements = (relations: number): ReadonlyArray<string> =>
	Arr.flatMap(indices(relations), (i) => [
		...(i % 5 === 0 ? [`key(on(R${i}, "label"))`] : []),
		...(i > 0 ? [`contained(on(R${i}, "parent"), on(R${i - 1}, "id"))`] : []),
		`contained(on(R${i}, "kind"), on(Kind, "id"))`,
		...(i % 7 === 0 ? [`mutable(R${i})`] : [])
	])

/** Rule q: over relation i, with the relation before it attached by the parent's field. */
const ruleBlock = (q: number, relations: number): string => {
	const i = q % relations
	const prev = (i + relations - 1) % relations
	return `export const owned${q} = query(S).rule((r) => {
	const { id, parent, kind } = v(R${i}, "r")
	return r.match(R${i}, { id, parent, kind }).where(r.eq(kind, "A")).find({ id, parent, kind })
}).attach("owner", (p) => query(S).rule((r) => {
	const { label } = v(R${prev}, "o")
	return r.match(R${prev}, { id: p.parent, label }).find({ label })
}), ${i > 0 ? '"one"' : '"option"'})
export const read${q} = (db: DbOf<typeof Reader, unknown>) => db.execute(owned${q}, {})
`
}

/**
 * Member m: one fact of relation m, round the relations, inserted; or, writing inserts, deletes and puts, the m-th of
 * them in turn, each put of the mutable relations, every seventh (statements), round them.
 */
const memberCall = (m: number, shape: QueryShape): string => {
	const fact = `[{ id: someId, parent: someId, amount: 1n, label: "abc", kind: "A", qty: 1 }]`
	const turn = shape.writes === "inserts" ? 0 : m % 3
	if (turn === 2) {
		return `\t.put(R${7 * (m % Math.ceil(shape.relations / 7))}, ${fact})`
	}
	return `\t.${turn === 0 ? "insert" : "delete"}(R${m % shape.relations}, ${fact})`
}

/** Context j and the query entry of Ctx that reads it, over relation j, round the relations. */
const contextBlock = (
	j: number,
	relations: number
): string => `export const C${j} = context("C${j}", { user: uuid })
export const inC${j} = query(S).rule((r) => {
	const { id } = v(R${j % relations}, "e")
	return r.match(R${j % relations}, { id }).match(C${j}, { user: id }).find({ id })
})
`

/** A complete program at `shape`, its imports read through the gates' prelude as `entries` reaches it. */
export const queryScaleSource = (shape: QueryShape, entries: PreludeAt): string => {
	const names = Arr.join(
		Arr.map(indices(shape.relations), (i) => `R${i}`),
		", "
	)
	return preludeProgram(
		`// Generated by test/types/query/budget/scaling.ts at ${jsonText(shape)}.`,
		entries,
		`export const Label = str.regex("^[a-z]{1,32}$")
export const Kind = closed("Kind", ["A", "B", "C"])
${Arr.join(
	Arr.map(
		indices(shape.relations),
		(i) =>
			`export const R${i} = relation("R${i}", { id: uuid, parent: uuid, amount: pg.bigint, label: Label, kind: closedId(Kind), qty: pg.integer }, ["id"])\n`
	),
	""
)}
export const S = schema("Gen", { Kind, ${names} }, [
${Arr.join(
	Arr.map(statements(shape.relations), (s) => `\t${s}`),
	",\n"
)}
])
export const Reader = role(S, "reader", S.relations)
export const readAll = (db: DbOf<typeof Reader, unknown>) => db.get(R0, { id: "00000000-0000-4000-8000-000000000001" })
${Arr.join(
	Arr.map(indices(shape.rules), (q) => ruleBlock(q, shape.relations)),
	""
)}${
			shape.members > 0
				? `declare const someId: Uuid
export const change = ChangeSet.empty(S)
${Arr.join(
	Arr.map(indices(shape.members), (m) => memberCall(m, shape)),
	"\n"
)}
`
				: ""
		}${Arr.join(
			Arr.map(indices(shape.contexts), (j) => contextBlock(j, shape.relations)),
			""
		)}${
			shape.contexts > 0
				? `export const Ctx = role(S, "ctx", { ...S.relations, ${Arr.join(
						Arr.map(indices(shape.contexts), (j) => `InC${j}: inC${j}`),
						", "
					)} })
${Arr.join(
	Arr.map(
		indices(shape.contexts),
		(j) => `export const runC${j} = (db: DbOf<typeof Ctx, unknown>) => db.execute(inC${j}, {})\n`
	),
	""
)}`
				: ""
		}`
	)
}
