import { Array as Arr, Order } from "effect"
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
 * The statement-scale program, one type test of schema(...), role(...) and the lookups by name at scale. It writes one
 * TypeScript program over the public barrels with `relations` relations: each holds a containment into the one before
 * it and every fourth a candidate key, all in one schema(...) call; a role over every relation, which ChangeSet.empty
 * and query read as a schema, its kept laws among what they read; a role over a Pick of half of them; and a query over
 * the last relation. Every fourth relation, from the third, is relation.generated's, its generated field's term typed by
 * the row of its written fields alone: that callback's row and the relation's fields are typed at every one of them,
 * in the one schema(...) call.
 *
 * A schema's record and a role's hold each relation under its own name, and every index the types build over a
 * schema's statements places each statement under a name in one pass and is read by property, never through its keys
 * (`keyof`), which the checker computes again at every read of a remapped index. So every lookup by name is one
 * property read.
 *
 * Beside it stands its twin (batch/twins.ts): the same declarations over the first and the last relation's
 * neighbourhoods and the first generated relation alone. The head of a query over the last relation, the first's and
 * the last's candidate keys, and a generated relation's fact and addition are the twin's; and a statement naming a
 * relation no level declares, a relation under another name and a role's entry of a stranger are refused at scale as
 * over the twin.
 *
 * The relation count the type-test batch checks.
 */
export const largestStatementSize = 2000

/** Whether relation i declares a generated field: every fourth, from the third, so neither the first nor the last. */
const generates = (i: number): boolean => i % 4 === 2

/** The generated relation the probes read: the first. */
const generatedProbe = 2

const relationDeclaration = (ns: string, i: number): string =>
	generates(i)
		? `export const ${ns}R${i} = relation.generated("R${i}", { id: uuid, parent: uuid, label: ${ns}Label }, ["id"], (r) => ({ tag: generated(${ns}Label, r.label) }))\n`
		: `export const ${ns}R${i} = relation("R${i}", { id: uuid, parent: uuid, label: ${ns}Label }, ["id"])\n`

/**
 * The statements over the relations `declared`, under the prefix `ns`: a candidate key on every fourth relation, and a
 * containment from each relation into the one before it where both are declared.
 */
const statements = (ns: string, declared: ReadonlyArray<number>): string =>
	Arr.join(
		Arr.flatMap(declared, (i) => [
			...(i % 4 === 0 ? [`\tkey(on(${ns}R${i}, "label"))`] : []),
			...(i > 0 && Arr.contains(declared, i - 1)
				? [`\tcontained(on(${ns}R${i}, "parent"), on(${ns}R${i - 1}, "id"))`]
				: [])
		]),
		",\n"
	)

/** The schema over the relations `declared`, a stranger beside it, and the query over the last, under the prefix `ns`. */
const declarations = (ns: string, declared: ReadonlyArray<number>, last: number): string =>
	`export const ${ns}Label = str.regex("^[a-z]{1,32}$")
${Arr.join(
	Arr.map(declared, (i) => relationDeclaration(ns, i)),
	""
)}
export const ${ns}S = schema("Scale", [${Arr.join(
		Arr.map(declared, (i) => `${ns}R${i}`),
		", "
	)}], [
${statements(ns, declared)}
])
export const ${ns}Stray = relation("Stray", { id: uuid, parent: uuid, label: ${ns}Label }, ["id"])
export const ${ns}lastIds = query(${ns}S).rule((r) => {
	const { id } = v(${ns}R${last}, "last")
	return r.match(${ns}R${last}, { id }).find({ id })
})
`

/** The roles the program reads its schema through at scale: a role over every relation, and one over half of them. */
const roles = (relations: number): string => `
/**
 * A role over every relation, read as a schema by ChangeSet.empty and query, and one over a Pick of half of them. A
 * role keeps each law whose relations are its entries under their own names, read by name.
 */
export const Everything = role(S, "everything", wholeEntriesOf(S))
export const overEverything = query(Everything)
export const emptyEverything = ChangeSet.empty(Everything)
declare const half: Pick<typeof S.relations, ${Arr.join(
	Arr.map(indices(Math.floor(relations / 2)), (i) => `"R${i}"`),
	" | "
)}>
export const Half = role(S, "half", half)
export const overHalf = query(Half)
`

/** What the probes compare at scale and over the twin. */
const typeProbes = (last: number): ReadonlyArray<Over> => [
	(ns) => `HeadOf<typeof ${ns}lastIds>`,
	(ns) => `KeysOf<typeof ${ns}S, typeof ${ns}R0>`,
	(ns) => `KeysOf<typeof ${ns}S, typeof ${ns}R${last}>`,
	(ns) => `Fact<typeof ${ns}R${generatedProbe}>`,
	(ns) => `Addition<typeof ${ns}R${generatedProbe}>`
]

/** The refusal probes, each one line at scale and over the twin. */
const refusalProbes = (last: number): ReadonlyArray<RefusalProbe> => [
	{
		label: "undeclared",
		why: "a statement names a relation no level of the schema declares",
		line: (ns) =>
			`export const ${ns}undeclared = schema.extend(${ns}S, "Undeclared", {}, [contained(on(${ns}Stray, "parent"), on(${ns}R${last}, "id"))])`
	},
	{
		label: "aliased",
		why: "a schema holds each relation under its own name",
		line: (ns) =>
			`export const ${ns}aliased = schema.extend(${ns}S, "Aliased", { Strays: ${ns}Stray }, [])`
	},
	{
		label: "stray-entry",
		why: "a whole entry is a relation of the base under its own name",
		line: (ns) =>
			`export const ${ns}strayEntry = role(${ns}S, "stray", { R0: ${ns}R0, Stray: ${ns}Stray })`
	}
]

/**
 * The program over `relations` relations and its twin, its imports read through the gates' prelude as `entries`
 * reaches it.
 */
export const generateStatementSource = (relations: number, entries: PreludeAt): string => {
	const last = relations - 1
	const twin = Arr.sort(Arr.dedupe([...neighbourhood(relations), generatedProbe]), Order.Number)
	return preludeProgram(
		`// Generated by test/types/schema/budget/generate.ts with ${relations} relations and their twin.`,
		entries,
		`${declarations("", indices(relations), last)}${roles(relations)}
${declarations(twinPrefix, twin, last)}
${twinProbes(typeProbes(last), refusalProbes(last))}`
	)
}
