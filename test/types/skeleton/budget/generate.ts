import { Array as Arr } from "effect"
import { indices } from "#compiler/core/array.ts"
import { type PreludeAt, preludeProgram } from "#test/support/prelude.ts"
import {
	neighbourhood,
	type Over,
	type RefusalProbe,
	twinPrefix,
	twinProbes
} from "#test/types/batch/twins.ts"

/**
 * The growing-schema ChangeSet program, one type test of write inference at scale. It writes one TypeScript program
 * over the public barrels with `relations` relations, each with a contract column, and for each relation a ChangeSet
 * with a read-back applied through the handle of a workload over the full role Writer that serves it alone, each call
 * giving its insert's facts, beside the queries it writes from. The query shapes at scale are the growing-schema query
 * program's (test/types/query/budget/generate.ts); this one holds what it lacks.
 *
 * Beside it stands its twin (batch/twins.ts): the same declarations over the first and the last relation's
 * neighbourhoods alone. A contract host through a query head, a relation's fact and candidate keys, and the relations a
 * ChangeSet writes, inferred at the first and the last relation, are the twin's; and a ChangeSet in a workload over a
 * role that does not write its relation, and a query's rows inserted into another relation, are refused at scale as
 * over the twin.
 */
export const largestSkeletonSize = 200

const relationDeclaration = (ns: string, i: number): string =>
	`export const ${ns}R${i} = relation("R${i}", { id: uuid, parent: uuid, amount: ${ns}Cents, label: ${ns}Label, kind: closedId(${ns}Kind), qty: pg.integer }, ["id"])\n`

/** One relation's queries, ChangeSet and its once, under the prefix `ns`, in a schema of `relations` relations. */
const relationBlock = (ns: string, i: number, relations: number): string => {
	const child = (i + 1) % relations
	return `
export const ${ns}byParent${i} = query(${ns}S).rule((r) => {
	const { id, parent, amount, kind } = v(${ns}R${i}, "r${i}")
	return r.match(${ns}R${i}, { id, parent, amount, kind }).where(r.eq(parent, r.param("parent", uuid)), r.ge(amount, 0n)).find({ id, amount, kind })
}).attach("children", (p) => query(${ns}S).rule((r) => {
	const { id } = v(${ns}R${child}, "r${child}")
	return r.match(${ns}R${child}, { id, parent: p.id }).find({ id })
}), "array")
export const ${ns}owned${i} = query(${ns}S).rule((r) => {
	const { id, parent, kind } = v(${ns}R${i}, "r${i}")
	return r.match(${ns}R${i}, { id, parent, kind }).find({ id, parent, kind })
})
export const ${ns}change${i} = ChangeSet.empty(${ns}S)
	.insert(${ns}R${i}, [{ id: "00000000-0000-4000-8000-000000000001", parent: "00000000-0000-4000-8000-000000000002", amount: ${ns}Cents(1n), label: "abc", kind: "A", qty: 1 }])
	.read("added", (d) => query(${ns}S).rule((r) => {
		const { id } = v(d.added(${ns}R${i}), "addedR${i}")
		return r.match(d.added(${ns}R${i}), { id }).find({ id })
	}))
export const ${ns}w${i} = workload(${ns}Writer, { change: ${ns}change${i} })
export const ${ns}run${i} = (db: DbOf<typeof ${ns}Writer, typeof ${ns}w${i}.programs>) =>
	db.workload.change.once({ params: {}, facts: { insert: { R${i}: [{ id: "00000000-0000-4000-8000-000000000003", parent: "00000000-0000-4000-8000-000000000002", amount: ${ns}Cents(2n), label: "abd", kind: "B", qty: 2 }] } } })
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
 * The schema over the relations `declared`, its full roles, and the blocks of the relations `blocked`, every
 * identifier under the prefix `ns`, in a program of `relations` relations.
 */
const declarations = (
	ns: string,
	declared: ReadonlyArray<number>,
	blocked: ReadonlyArray<number>,
	relations: number
): string => `export const ${ns}Cents = contract("Cents", pg.bigint, (x) => x.ge(0n))
export const ${ns}Label = str.regex("^[a-z]{1,32}$")
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
/** A full reader and a full writer of every relation, which every program over the schema runs on. */
export const ${ns}Reader = role(${ns}S, "reader", wholeEntriesOf(${ns}S))
export const ${ns}Writer = role(${ns}S, "writer", wholeEntriesOf(${ns}S), { write: writableNamesOf(${ns}S) })
${Arr.join(
	Arr.map(blocked, (i) => relationBlock(ns, i, relations)),
	""
)}`

/** What relation i's probes compare at scale and over the twin. */
const typeProbes = (i: number): ReadonlyArray<Over> => [
	(ns) => `HeadOf<typeof ${ns}byParent${i}>`,
	(ns) => `HeadOf<typeof ${ns}owned${i}>`,
	(ns) => `KeysOf<typeof ${ns}S, typeof ${ns}R${i}>`,
	(ns) => `Fact<typeof ${ns}R${i}>`,
	(ns) => `WritesOf<typeof ${ns}change${i}>`
]

/** Relation i's refusal probes, each one line at scale and over the twin. */
const refusalProbes = (i: number, relations: number): ReadonlyArray<RefusalProbe> => {
	const owner = (i + relations - 1) % relations
	return [
		{
			label: `s${i}-reader-work`,
			why: "a ChangeSet of a workload over a role writes only relations its role's write list names",
			line: (ns) =>
				`export const ${ns}readerWork${i} = workload(${ns}Reader, { change: ${ns}change${i} })`
		},
		{
			label: `s${i}-wrong-member`,
			why: "a query's rows inserted into a relation they are no facts of",
			line: (ns) =>
				`export const ${ns}wrongMember${i} = ChangeSet.empty(${ns}S).insert(${ns}R${owner}, ${ns}owned${i})`
		}
	]
}

/** The program at `relations` relations and its twin, its imports read through the gates' prelude as `entries` reaches it. */
export const generateSchemaSource = (relations: number, entries: PreludeAt): string => {
	const all = indices(relations)
	const probed = Arr.dedupe([0, relations - 1])
	return preludeProgram(
		`// Generated by test/types/skeleton/budget/generate.ts with ${relations} relations and their twin.`,
		entries,
		`${declarations("", all, all, relations)}
${declarations(twinPrefix, neighbourhood(relations), probed, relations)}
${twinProbes(
	Arr.flatMap(probed, typeProbes),
	Arr.flatMap(probed, (i) => refusalProbes(i, relations))
)}`
	)
}
