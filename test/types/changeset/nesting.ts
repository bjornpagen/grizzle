import { Array as Arr, Record as Rec } from "effect"
import { indices } from "#compiler/core/array.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import type { BudgetEntries } from "#test/types/query/budget/generate.ts"

/**
 * The nesting program: a tree insert typed by member types of any depth, generated over an exhaustive box. The schema
 * is a tree of nodes, each node also the owner of an ordered family of lines, each line the owner of an ordered family
 * of parts. A case's root type nests a chain of node member types T1 … Tk at `children`, the last one's children of the
 * type `back` names (the root itself, or one of T1 … Tk, so the types recur at every depth, each its own or the others'
 * member), and every node type nests lines at `n`, every line parts at `m`. A case may state, in one of those types, a
 * field its nesting does not take: a node's parent, root field, drawn index or a stranger, a line's drawn index or
 * group, a part's group or drawn index. The types are written as interfaces, as object type aliases, or as an Omit of a
 * row interface intersected with the nestings.
 *
 * The oracle: every type a case declares is reached from its root, so its insert is refused exactly when one of them
 * states such a field, or the root type recurs below itself with its root field; otherwise it is admitted, whatever
 * depth its types recur at. Each refusal carries its directive, which the type-test batch disarms.
 */

/** How a case writes its member types. */
export type Form = "interface" | "alias" | "intersection"

/** The fields a member type may state that its nesting does not take, by the member type that states it. */
const nodeExcess = { parent: "Uuid", doc: "Uuid", at: "bigint", note: "number" } as const
const lineExcess = { at: "bigint", node: "Uuid" } as const
const partExcess = { line: "bigint", at: "bigint" } as const

/** A field the nesting does not take, and the member type stating it: node type Ti, a line or a part. */
type Excess =
	| { readonly kind: "none" }
	| { readonly kind: "node"; readonly member: number; readonly field: keyof typeof nodeExcess }
	| { readonly kind: "line"; readonly field: keyof typeof lineExcess }
	| { readonly kind: "part"; readonly field: keyof typeof partExcess }

/**
 * One case: its form, its node member types T1 … T`members`, the type the last one's children are (0 the root, i the
 * type Ti), and the field one of its types states beyond its nesting's.
 */
export interface NestingCase {
	readonly form: Form
	readonly members: number
	readonly back: number
	readonly excess: Excess
}

const forms: ReadonlyArray<Form> = ["interface", "alias", "intersection"]

/** The largest chain of node member types the box draws. */
const largestChain = 3

const excesses = (members: number): ReadonlyArray<Excess> => [
	{ kind: "none" },
	...Arr.flatMap(indices(members), (i) =>
		Arr.map(Rec.keys(nodeExcess), (field): Excess => ({ kind: "node", member: i + 1, field }))
	),
	...Arr.map(Rec.keys(lineExcess), (field): Excess => ({ kind: "line", field })),
	...Arr.map(Rec.keys(partExcess), (field): Excess => ({ kind: "part", field }))
]

/** The chain lengths the box draws, 1 through largestChain. */
const chainLengths: ReadonlyArray<number> = Arr.map(indices(largestChain), (i) => i + 1)

/** Every case of the box: each form, chain length, back edge and excess. */
export const nestingCases: ReadonlyArray<NestingCase> = Arr.flatMap(forms, (form) =>
	Arr.flatMap(chainLengths, (members) =>
		Arr.flatMap(indices(members + 1), (back) =>
			Arr.map(excesses(members), (excess) => ({ form, members, back, excess }))
		)
	)
)

/** Whether a case's insert is refused: one of its types states a field its nesting does not take. */
export const nestingRefused = (c: NestingCase): boolean => c.excess.kind !== "none" || c.back === 0

/** A member type of case `name`: its own fields, its nestings, and the fields beyond them it states. */
const memberType = (
	form: Form,
	name: string,
	fields: ReadonlyArray<string>,
	nestings: ReadonlyArray<string>
): string => {
	const body = (members: ReadonlyArray<string>): string =>
		`{ ${Arr.join(
			Arr.map(members, (m) => `readonly ${m}`),
			"; "
		)} }`
	switch (form) {
		case "interface":
			return `interface ${name} ${body([...fields, ...nestings])}\n`
		case "alias":
			return `type ${name} = ${body([...fields, ...nestings])}\n`
		case "intersection":
			return `interface ${name}Row ${body([...fields, "end: bigint"])}\ntype ${name} = Omit<${name}Row, "end">${nestings.length === 0 ? "" : ` & ${body(nestings)}`}\n`
	}
}

const stated = (excess: Excess, holder: Excess["kind"], member: number): ReadonlyArray<string> => {
	switch (excess.kind) {
		case "none":
			return []
		case "node":
			return holder === "node" && member === excess.member
				? [`${excess.field}: ${nodeExcess[excess.field]}`]
				: []
		case "line":
			return holder === "line" ? [`${excess.field}: ${lineExcess[excess.field]}`] : []
		case "part":
			return holder === "part" ? [`${excess.field}: ${partExcess[excess.field]}`] : []
	}
}

const caseBlock = (c: NestingCase, index: number): string => {
	const t = (i: number): string => (i === 0 ? `Root${index}` : `T${index}_${i}`)
	const lines = `L${index}`
	const parts = `P${index}`
	const nodes = Arr.map(
		Arr.map(indices(c.members), (i) => i + 1),
		(i) =>
			memberType(
				c.form,
				t(i),
				["id: Uuid", "label: number", ...stated(c.excess, "node", i)],
				[
					`children: ReadonlyArray<${t(i === c.members ? c.back : i + 1)}>`,
					`n: ReadonlyArray<${lines}>`
				]
			)
	)
	return `// ${c.form}, T1 … T${c.members}, the last nesting ${c.back === 0 ? "the root" : `T${c.back}`}, ${c.excess.kind === "none" ? "no field beyond its nesting's" : `${c.excess.kind === "node" ? `T${c.excess.member}` : c.excess.kind} stating ${c.excess.field}`}
${memberType(c.form, parts, ["y: number", ...stated(c.excess, "part", 0)], [])}${memberType(c.form, lines, ["qty: number", ...stated(c.excess, "line", 0)], [`m: ReadonlyArray<${parts}>`])}${Arr.join(nodes, "")}${memberType(c.form, t(0), ["id: Uuid", "doc: Uuid", "label: number"], [`children: ReadonlyArray<${t(1)}>`, `n: ReadonlyArray<${lines}>`])}declare const root${index}: ${t(0)}
export const insert${index} = ChangeSet.empty(Nesting).insert(
	Node,
${nestingRefused(c) ? "\t// @ts-expect-error -- TS2345 refusal: a member fact is not a fact of the relation\n" : ""}	[root${index}]
)
`
}

/** The program over the cases, importing the ChangeSet, fields and schema barrels from `entries`. */
export const nestingSource = (entries: BudgetEntries, cases: ReadonlyArray<NestingCase>): string =>
	`// Generated by test/types/changeset/nesting.ts over ${cases.length} cases.
import { ChangeSet } from ${jsonText(entries.changeset)}
import { drawn, natural, pg, type Uuid, uuid } from ${jsonText(entries.fields)}
import { fin, on, ordered, relation, schema, tree } from ${jsonText(entries.schema)}

export const Node = relation(
	"Node",
	{ id: uuid, parent: uuid, at: drawn(natural), children: drawn(natural), start: drawn(natural), end: drawn(natural), doc: uuid, label: pg.integer, n: drawn(natural) },
	["id"]
)
export const Line = relation("Line", { node: uuid, at: drawn(natural), qty: pg.integer, m: drawn(natural) }, ["node", "at"])
export const Part = relation("Part", { node: uuid, line: natural, at: drawn(natural), y: pg.integer }, ["node", "line", "at"])
export const nodes = tree(on(Node, "parent", "at"), fin(Node, "children"), { root: "doc" })
export const lines = ordered(on(Line, "node", "at"), fin(Node, "n"))
export const parts = ordered(on(Part, "node", "line", "at"), fin(Line, "m"))
export const Nesting = schema("Nesting", { Node, Line, Part }, [nodes, lines, parts])

${Arr.join(Arr.map(cases, caseBlock), "\n")}`
