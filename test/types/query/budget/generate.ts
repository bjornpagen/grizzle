import { Array as Arr, Effect } from "effect"
import { indices } from "#compiler/core/array.ts"
import { type PreludeAt, preludeAt, preludeFrom, preludeProgram } from "#test/support/prelude.ts"
import {
	neighbourhood,
	type Over,
	type RefusalProbe,
	twinPrefix,
	twinProbes
} from "#test/types/batch/twins.ts"

/**
 * The growing-schema program, one type test of the query facade at scale. It writes one TypeScript program over the
 * public facade (the query, schema, fields and text barrels) with `relations` relations, and for each relation the
 * shapes the seven statement readers see: candidate keys, containments, a closed roster, mutability, a
 * parameterized query with an attachment, a keyed lookup, a lookup fixed by a filter, a grouped aggregate, a two-arm
 * union ordered by its common fields, a bound import, and reads through the handles of a workload over the full role
 * Reader, one workload per relation. Reads are typed inside a function the program never calls, on a Db typed by its
 * relation's workload's programs.
 *
 * Beside it stands its twin (batch/twins.ts): the same declarations over the first and the last relation's
 * neighbourhoods alone, the relation before and after each. Every parameter, head, evidence and key inferred at the
 * first and the last relation is the twin's, and every refusal there raises what the twin's raises: a parameter of
 * another type, an order by a field one arm lacks.
 */
export const largestQuerySize = 200

const relationDeclaration = (ns: string, i: number): string =>
	`export const ${ns}R${i} = relation("R${i}", { id: uuid, parent: uuid, amount: pg.bigint, label: ${ns}Label, kind: closedId(${ns}Kind), qty: pg.integer }, ["id"])\n`

/** One relation's queries, workload and reads, under the prefix `ns`, in a schema of `relations` relations. */
const relationBlock = (ns: string, i: number, relations: number): string => {
	const child = (i + 1) % relations
	const owner = (i + relations - 1) % relations
	return `
export const ${ns}byParent${i} = query(${ns}S).rule((r) => {
	const { id, parent, amount, kind } = v(${ns}R${i}, "r${i}")
	return r.match(${ns}R${i}, { id, parent, amount, kind }).where(r.eq(parent, r.param("parent", uuid)), r.ge(amount, 0n)).find({ id, amount, kind })
}).attach("children", (p) => query(${ns}S).rule((r) => {
	const { id } = v(${ns}R${child}, "r${child}")
	return r.match(${ns}R${child}, { id, parent: p.id }).find({ id })
}), "array")
export const ${ns}byId${i} = query(${ns}S).rule((r) => {
	const { amount, label } = v(${ns}R${i}, "r${i}")
	return r.match(${ns}R${i}, { id: r.param("id", uuid), amount, label }).find({ amount, label })
})
export const ${ns}byFilter${i} = query(${ns}S).rule((r) => {
	const { id, label } = v(${ns}R${i}, "r${i}")
	return r.match(${ns}R${i}, { id, label }).where(r.eq(id, r.param("id", uuid))).find({ label })
})
export const ${ns}total${i} = query(${ns}S).rule((r) => {
	const { id, kind, qty } = v(${ns}R${i}, "r${i}")
	return r.match(${ns}R${i}, { id, kind, qty }).find({ kind, total: r.sum(qty), n: r.count() })
})
export const ${ns}arms${i} = query(${ns}S).rule((r) => {
	const { id, amount } = v(${ns}R${i}, "r${i}")
	return r.match(${ns}R${i}, { id, kind: "A", amount }).find({ id, kind: ${ns}Kind.handle("A"), amount })
}).rule((r) => {
	const { id, label } = v(${ns}R${i}, "r${i}")
	return r.match(${ns}R${i}, { id, kind: "B", label }).find({ id, kind: ${ns}Kind.handle("B"), label })
}).orderBy(["kind", "asc"], ["id", "desc"])
export const ${ns}imported${i} = query(${ns}S).rule((r) => {
	const { id: parent } = v(${ns}R${child}, "r${child}")
	const top = ${ns}byParent${i}.bind({ parent })
	const { id, amount } = v(top, "top")
	return r.match(${ns}R${child}, { id: parent }).match(top, { id, amount }).find({ parent, id, amount })
})
export const ${ns}owned${i} = query(${ns}S).rule((r) => {
	const { id, parent, kind } = v(${ns}R${i}, "r${i}")
	return r.match(${ns}R${i}, { id, parent, kind }).find({ id, parent, kind })
}).attach("owner", (p) => query(${ns}S).rule((r) => {
	const { label } = v(${ns}R${owner}, "r${owner}")
	return r.match(${ns}R${owner}, { id: p.parent, label }).find({ label })
}), ${i > 0 ? '"one"' : '"option"'}).attach("handle", (p) => query(${ns}S).rule((r) => r.match(${ns}Kind, { id: p.kind }).find({ handle: p.kind })), "one")
export const ${ns}w${i} = workload(${ns}Reader, {
	byId: ${ns}byId${i},
	byFilter: ${ns}byFilter${i},
	key: ${ns}R${i},
	byParent: ${ns}byParent${i},
	arms: ${ns}arms${i},
	top: ${ns}total${i}.orderBy(["kind", "asc"]).take(1)
})
export const ${ns}reads${i} = (db: DbOf<typeof ${ns}Reader, typeof ${ns}w${i}.programs>) => [
	db.workload.byId.once({ params: { id: "00000000-0000-4000-8000-000000000001" }, facts: {} }),
	db.workload.byFilter.once({ params: { id: "00000000-0000-4000-8000-000000000001" }, facts: {} }),
	db.workload.key.once({ params: { id: "00000000-0000-4000-8000-000000000001" }, facts: {} }),
	db.workload.byParent.once({ params: { parent: "00000000-0000-4000-8000-000000000002" }, facts: {} }),
	db.workload.arms.once({ params: {}, facts: {} }),
	db.workload.top.once({ params: {}, facts: {} })
] as const
`
}

/**
 * The statements over the relations `declared`, under the prefix `ns`: a candidate key on every fifth relation, a
 * containment from each relation into the one before it where both are declared, each relation's kind contained in the
 * Kind roster, and every seventh relation mutable.
 */
const statements = (ns: string, declared: ReadonlyArray<number>): string =>
	Arr.join(
		Arr.flatMap(declared, (i) => [
			...(i % 5 === 0 ? [`\tkey(on(${ns}R${i}, "label"))`] : []),
			...(i > 0 && Arr.contains(declared, i - 1)
				? [`\tcontained(on(${ns}R${i}, "parent"), on(${ns}R${i - 1}, "id"))`]
				: []),
			`\tcontained(on(${ns}R${i}, "kind"), on(${ns}Kind, "id"))`,
			...(i % 7 === 0 ? [`\tmutable(${ns}R${i})`] : [])
		]),
		",\n"
	)

/**
 * The schema over the relations `declared`, its full role Reader, and the blocks of the relations `blocked`, every
 * identifier under the prefix `ns`, in a program of `relations` relations.
 */
const declarations = (
	ns: string,
	declared: ReadonlyArray<number>,
	blocked: ReadonlyArray<number>,
	relations: number
): string => `export const ${ns}Label = str.regex("^[a-z]{1,32}$")
export const ${ns}Kind = closed("Kind", ["A", "B", "C"])
${Arr.join(
	Arr.map(declared, (i) => relationDeclaration(ns, i)),
	""
)}
export const ${ns}S = schema("Gen", { Kind: ${ns}Kind, ${Arr.join(
	Arr.map(declared, (i) => `R${i}: ${ns}R${i}`),
	", "
)} }, [
${statements(ns, declared)}
])
/** A full role reading every relation, which every program over the schema runs on. */
export const ${ns}Reader = role(${ns}S, "reader", wholeEntriesOf(${ns}S))
${Arr.join(
	Arr.map(blocked, (i) => relationBlock(ns, i, relations)),
	""
)}`

/** What relation i's probes compare at scale and over the twin. */
const typeProbes = (i: number): ReadonlyArray<Over> => [
	(ns) => `ParamsOf<typeof ${ns}byParent${i}>`,
	(ns) => `HeadOf<typeof ${ns}byParent${i}>`,
	(ns) => `EvidenceOfQuery<typeof ${ns}byParent${i}>["card"]`,
	(ns) => `EvidenceOfQuery<typeof ${ns}byParent${i}>["keys"]`,
	(ns) => `ParamsOf<typeof ${ns}byId${i}>`,
	(ns) => `HeadOf<typeof ${ns}byId${i}>`,
	(ns) => `EvidenceOfQuery<typeof ${ns}byId${i}>["card"]`,
	(ns) => `HeadOf<typeof ${ns}byFilter${i}>`,
	(ns) => `EvidenceOfQuery<typeof ${ns}byFilter${i}>["card"]`,
	(ns) => `HeadOf<typeof ${ns}total${i}>`,
	(ns) => `HeadOf<typeof ${ns}arms${i}>`,
	(ns) => `ParamsOf<typeof ${ns}imported${i}>`,
	(ns) => `HeadOf<typeof ${ns}imported${i}>`,
	(ns) => `HeadOf<typeof ${ns}owned${i}>`,
	(ns) => `KeysOf<typeof ${ns}S, typeof ${ns}R${i}>`
]

/** Relation i's refusal probes, each one line at scale and over the twin. */
const refusalProbes = (i: number): ReadonlyArray<RefusalProbe> => [
	{
		label: `q${i}-param`,
		why: "a parameter of another type than the one the query's uses inferred",
		line: (ns) =>
			`export const ${ns}wrongParam${i} = (db: DbOf<typeof ${ns}Reader, typeof ${ns}w${i}.programs>) => db.workload.byParent.once({ params: { parent: 1 }, facts: {} })`
	},
	{
		label: `q${i}-order`,
		why: "an order by a field one arm lacks",
		line: (ns) =>
			`export const ${ns}orderHidden${i} = ${ns}arms${i}.take(1).orderBy(["label", "asc"])`
	}
]

/** The type-cost gates' prelude (test/support/programs/budget.ts), every repository name their programs read. */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/budget.ts"))

/** The gates' prelude as a program's directory reaches it, `entry` spelling a repository path from there. */
export const entriesFrom = (entry: (path: string) => string): PreludeAt =>
	preludeFrom(prelude, entry)

/** The program at `relations` relations and its twin, its imports read through the gates' prelude as `entries` reaches it. */
export const generateQuerySource = (relations: number, entries: PreludeAt): string => {
	const all = indices(relations)
	const probed = Arr.dedupe([0, relations - 1])
	return preludeProgram(
		`// Generated by test/types/query/budget/generate.ts with ${relations} relations and their twin.`,
		entries,
		`${declarations("", all, all, relations)}
${declarations(twinPrefix, neighbourhood(relations), probed, relations)}
${twinProbes(Arr.flatMap(probed, typeProbes), Arr.flatMap(probed, refusalProbes))}`
	)
}
