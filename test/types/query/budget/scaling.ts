import { Array as Arr } from "effect"
import { indices } from "#compiler/core/array.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { type PreludeAt, preludeProgram } from "#test/support/prelude.ts"
import { type EqualSteps, equalSteps } from "#test/types/batch/measured.ts"

/**
 * The query-scale programs, one per dimension of what a program states over a schema, each checked at three sizes an
 * equal step apart (scaling.test.ts), each step a whole number of the dimension's period. The schema: `relations` relations R0 … with a candidate
 * key on every fifth, from the first, a containment chain, every relation's kind contained in the Kind roster and every
 * fifth relation mutable, from the third, so the relations repeat every five; and a full role Reader. Over it a
 * program at a shape writes:
 *
 * - `rules` queries, each a rule over relation i (round the relations) with a filter, an attachment of the relation
 *   before it keyed by the parent's field, delivered as the one child where the containment chain proves it, and a read
 *   of it through the handle of a workload over the Reader that serves it alone;
 * - one ChangeSet of `members` members in one stratum, round the relations: inserts, or inserts, deletes and puts in turn,
 *   each put of a mutable relation, round them, so a chain's every call is checked against the stratum the call before
 *   it made; or one insertAll of the first `members` relations, each key checked as its insert is;
 * - `contexts` contexts, each over one of the first five relations, round them, read by a query entry of one role, Ctx,
 *   and each entry's query run through the handle of a workload over Ctx that serves it alone.
 *
 * One dimension grows the schema with its rules and members, as an application grows: a call whose cost grows with the
 * schema it is over, rather than with what it reads, makes that dimension quadratic.
 */
type QueryShape = {
	readonly relations: number
	readonly rules: number
	readonly members: number
	readonly writes: "inserts" | "inserts, deletes and puts" | "insertAll"
	readonly contexts: number
}

/** One dimension: its name, its sizes, and the shape at a size along it. */
interface QueryDimension {
	readonly name: string
	readonly steps: EqualSteps
	readonly shape: (size: number) => QueryShape
}

/** The relations repeat every five: a key on every fifth, a mutable relation on every fifth. */
const relationPeriod = 5

/** The schema the dimensions over a fixed schema read: four periods of relations. */
const fixedRelations = 4 * relationPeriod

/**
 * The dimensions, each sized by its period: rules round the fixed relations; members round them, inserts, deletes and
 * puts taking turns, and each put round the four mutable relations, so every 60 members repeat; contexts round the
 * first five relations; and relations, with or without their rules and members, every five.
 */
export const queryDimensions: ReadonlyArray<QueryDimension> = [
	{
		name: "query rules and attachments",
		steps: equalSteps(fixedRelations),
		shape: (rules) => ({
			relations: fixedRelations,
			rules,
			members: 0,
			writes: "inserts",
			contexts: 0
		})
	},
	{
		name: "ChangeSet inserts",
		steps: equalSteps(3 * fixedRelations),
		shape: (members) => ({
			relations: fixedRelations,
			rules: 0,
			members,
			writes: "inserts",
			contexts: 0
		})
	},
	{
		name: "ChangeSet inserts, deletes and puts",
		steps: equalSteps(3 * fixedRelations),
		shape: (members) => ({
			relations: fixedRelations,
			rules: 0,
			members,
			writes: "inserts, deletes and puts",
			contexts: 0
		})
	},
	{
		name: "ChangeSet insertAll over every relation",
		steps: equalSteps(4 * relationPeriod),
		shape: (size) => ({
			relations: size,
			rules: 0,
			members: size,
			writes: "insertAll",
			contexts: 0
		})
	},
	{
		name: "contexts",
		steps: equalSteps(2 * relationPeriod),
		shape: (contexts) => ({
			relations: fixedRelations,
			rules: 0,
			members: 0,
			writes: "inserts",
			contexts
		})
	},
	{
		name: "relations with their rules and members",
		steps: equalSteps(4 * relationPeriod),
		shape: (size) => ({
			relations: size,
			rules: size,
			members: size,
			writes: "inserts",
			contexts: 0
		})
	}
]

/** Whether relation i is mutable: every fifth, from the third. */
const isMutable = (i: number): boolean => i % relationPeriod === 2

const statements = (relations: number): ReadonlyArray<string> =>
	Arr.flatMap(indices(relations), (i) => [
		...(i % relationPeriod === 0 ? [`key(on(R${i}, "label"))`] : []),
		...(i > 0 ? [`contained(on(R${i}, "parent"), on(R${i - 1}, "id"))`] : []),
		`contained(on(R${i}, "kind"), on(Kind, "id"))`,
		...(isMutable(i) ? [`mutable(R${i})`] : [])
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
export const w${q} = workload(Reader, { owned: owned${q} })
export const read${q} = (db: DbOf<typeof Reader, typeof w${q}.programs>) => db.workload.owned.execute({})
`
}

/** One fact of any relation, as a member writes it. */
const fact = `[{ id: someId, parent: someId, amount: 1n, label: "abc", kind: "A", qty: 1 }]`

/**
 * Member m: one fact of relation m, round the relations, inserted; or, writing inserts, deletes and puts, the m-th of
 * them in turn, the k-th put of the k-th mutable relation (isMutable), round them.
 */
const memberCall = (m: number, shape: QueryShape): string => {
	const turn = shape.writes === "inserts" ? 0 : m % 3
	if (turn === 2) {
		const put = Math.floor(m / 3) % (shape.relations / relationPeriod)
		return `\t.put(R${relationPeriod * put + 2}, ${fact})`
	}
	return `\t.${turn === 0 ? "insert" : "delete"}(R${m % shape.relations}, ${fact})`
}

/** The ChangeSet's members: a chain of calls, or one insertAll keyed by the first `members` relations. */
const members = (shape: QueryShape): string =>
	shape.writes === "insertAll"
		? `\t.insertAll({ ${Arr.join(
				Arr.map(indices(shape.members), (m) => `R${m}: ${fact}`),
				", "
			)} })`
		: Arr.join(
				Arr.map(indices(shape.members), (m) => memberCall(m, shape)),
				"\n"
			)

/** Context j and the query entry of Ctx that reads it, over relation j, round the first five. */
const contextBlock = (j: number): string => `export const C${j} = context("C${j}", { user: uuid })
export const inC${j} = query(S).rule((r) => {
	const { id } = v(R${j % relationPeriod}, "e")
	return r.match(R${j % relationPeriod}, { id }).match(C${j}, { user: id }).find({ id })
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
export const Reader = role(S, "reader", wholeEntriesOf(S))
export const keyed = workload(Reader, { key: R0 })
export const readAll = (db: DbOf<typeof Reader, typeof keyed.programs>) => db.workload.key.get({ id: "00000000-0000-4000-8000-000000000001" })
${Arr.join(
	Arr.map(indices(shape.rules), (q) => ruleBlock(q, shape.relations)),
	""
)}${
			shape.members > 0
				? `declare const someId: Uuid
export const change = ChangeSet.empty(S)
${members(shape)}
`
				: ""
		}${Arr.join(Arr.map(indices(shape.contexts), contextBlock), "")}${
			shape.contexts > 0
				? `export const Ctx = role(S, "ctx", { ...wholeEntriesOf(S), ${Arr.join(
						Arr.map(indices(shape.contexts), (j) => `InC${j}: inC${j}`),
						", "
					)} })
${Arr.join(
	Arr.map(
		indices(shape.contexts),
		(j) =>
			`export const wC${j} = workload(Ctx, { run: inC${j} })\nexport const runC${j} = (db: DbOf<typeof Ctx, typeof wC${j}.programs>) => db.workload.run.execute({})\n`
	),
	""
)}`
				: ""
		}`
	)
}
