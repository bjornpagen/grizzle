import { defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, String as Str } from "effect"
import type { Refused } from "#compiler/core/refusals.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/types/batch/batch.ts"

/**
 * The relation-name program: the box of every constructor that names a relation (relation, relation.generated,
 * closed.ordered, closed.unordered, closed.relation, derived, and the dynamic door's relation,
 * relation.generated, closed.ordered, closed.unordered and closed.relation) by every spelling of the name it is
 * handed, exhausted and printed as one program the type batch checks.
 *
 * The oracle: a call is refused exactly when the type of the name it is handed is no one string literal (string, a
 * template with a hole, a union of names), at the name itself, the call's first argument (the declared-name rule's
 * characters are ownership's to read, core/identity.ts DeclaredNamespace, never the type's): a helper that takes its
 * name as `string` and hands it on is refused inside the helper, at the constructor its name reaches, and one that
 * takes it as `RelationName<N>` is admitted, its caller's literal its N. A union of names is refused by the
 * parameter's type, `RelationName<"A" | "B">`, under which its members are compared one at a time, so its diagnostic
 * prints no refusal. Every call it admits keeps its level's types: the relation, listed in a level over the root
 * beside a relation whose containment reads the root, leaves that relation's inputs its rows, where a level holding
 * a relation of a name no literal states holds every relation under any name, and its inputs none. The dynamic door
 * (public/dynamic.ts) admits every spelling, a name its caller knows only at run time, which the run time checks.
 */

/** The constructors that name a relation, each by the callee a program writes. */
const constructorNames = [
	"relation",
	"relation.generated",
	"closed.ordered",
	"closed.unordered",
	"closed.relation",
	"derived",
	"dynamicRelation",
	"dynamicRelation.generated",
	"dynamicClosed.ordered",
	"dynamicClosed.unordered",
	"dynamicClosed.relation"
] as const

type ConstructorName = (typeof constructorNames)[number]

/** Whose types a constructor's name is checked by: the package root's, or the dynamic door's, which take any string. */
const doorOf = (callee: ConstructorName): "checked" | "dynamic" => {
	switch (callee) {
		case "relation":
		case "relation.generated":
		case "closed.ordered":
		case "closed.unordered":
		case "closed.relation":
		case "derived":
			return "checked"
		case "dynamicRelation":
		case "dynamicRelation.generated":
		case "dynamicClosed.ordered":
		case "dynamicClosed.unordered":
		case "dynamicClosed.relation":
			return "dynamic"
	}
}

/**
 * How a call spells the relation's name: a literal; a constant typed `string`, a union of two literals or a template
 * with a hole; a helper's parameter typed
 * `RelationName<N>`, called with a literal (forwarded); and a helper's parameter typed `string`, called with a literal
 * (widened), the helper of the defect, whose own call reads as a literal's.
 */
const spellings = ["literal", "string", "union", "template", "forwarded", "widened"] as const

type Spelling = (typeof spellings)[number]

/** The arguments each constructor takes after the name: a relation of a written field, a roster of two handles. */
const restOf: { readonly [C in ConstructorName]: ReadonlyArray<string> } = {
	relation: ["{ id: Id, n: pg.integer }", '["id"]'],
	"relation.generated": [
		"{ id: Id, n: pg.integer }",
		'["id"]',
		"(r) => ({ m: generated(pg.integer, r.n) })"
	],
	"closed.ordered": ['["a", "b"]'],
	"closed.unordered": ['["a", "b"]'],
	"closed.relation": [
		"{ kind: closedId(Kind), w: pg.integer }",
		'["kind"]',
		'[{ kind: "a", w: 1 }]'
	],
	derived: ["Items"],
	dynamicRelation: ["{ id: Id, n: pg.integer }", '["id"]'],
	"dynamicRelation.generated": [
		"{ id: Id, n: pg.integer }",
		'["id"]',
		"(r) => ({ m: generated(pg.integer, r.n) })"
	],
	"dynamicClosed.ordered": ['["a", "b"]'],
	"dynamicClosed.unordered": ['["a", "b"]'],
	"dynamicClosed.relation": [
		"{ kind: closedId(Kind), w: pg.integer }",
		'["kind"]',
		'[{ kind: "a", w: 1 }]'
	]
}

/** One case: its callee and the spelling of the name its call is handed. */
interface NameCase {
	readonly callee: ConstructorName
	readonly spelling: Spelling
}

/** The box: every constructor by every spelling of its name. */
const boxCases: ReadonlyArray<NameCase> = Arr.flatMap(constructorNames, (callee) =>
	Arr.map(spellings, (spelling): NameCase => ({ callee, spelling }))
)

/** The cells of namesBox, minted as a dictionary in its door (test/types/api/names.dictionary.ts). */
export const namesBoxItems: Arr.NonEmptyReadonlyArray<NameCase> = [
	defined(boxCases[0], "a case of the names box"),
	...Arr.drop(boxCases, 1)
]

const nameRefusal: Refused =
	"a relation's name is one string literal, the key its schema's types hold it under"

/**
 * The directive over a case's name, none where its name is one declarable literal or its constructor the dynamic
 * door's: the refusal grizzle's type names, or, for a union of names, the refusal no diagnostic prints.
 */
const directiveOf = (c: NameCase): ReadonlyArray<string> => {
	if (doorOf(c.callee) === "dynamic") {
		return []
	}
	switch (c.spelling) {
		case "literal":
		case "forwarded":
			return []
		case "string":
		case "template":
		case "widened":
			return [`// @ts-expect-error -- refusal: ${nameRefusal}`]
		case "union":
			return [
				"// @ts-expect-error -- refused: a union of names is no one literal, compared at the name member by member"
			]
	}
}

/** The declaration a case's name reads, none for a literal or a helper's parameter. */
const nameDeclaration = (spelling: Spelling, index: number): ReadonlyArray<string> => {
	switch (spelling) {
		case "string":
			return [`export declare const n${index}: string`]
		case "union":
			return [`export declare const n${index}: "A${index}" | "B${index}"`]
		case "template":
			return [`export declare const n${index}: \`\${string}N${index}\``]
		case "literal":
		case "forwarded":
		case "widened":
			return []
	}
}

/** The name expression a case's constructor call is handed. */
const nameExpression = (spelling: Spelling, index: number): string => {
	switch (spelling) {
		case "literal":
			return `"N${index}"`
		case "string":
		case "union":
		case "template":
			return `n${index}`
		case "forwarded":
		case "widened":
			return "name"
	}
}

/** The constructor's call over the name expression, each argument on a line of its own under `indent`. */
const callLines = (c: NameCase, index: number, indent: string): ReadonlyArray<string> => [
	`${c.callee}(`,
	...Arr.map(directiveOf(c), (line) => `${indent}\t${line}`),
	`${indent}\t${Arr.join([nameExpression(c.spelling, index), ...restOf[c.callee]], `,\n${indent}\t`)}`,
	`${indent})`
]

/** The case's value: the call itself, or a helper's over its parameter called with a literal. */
const valueLines = (c: NameCase, index: number): ReadonlyArray<string> => {
	const value = `c${index}`
	switch (c.spelling) {
		case "literal":
		case "string":
		case "union":
		case "template":
			return Str.split(`export const ${value} = ${Arr.join(callLines(c, index, ""), "\n")}`, "\n")
		case "forwarded":
		case "widened": {
			const parameter =
				c.spelling === "forwarded"
					? "<const N extends string>(name: RelationName<N>)"
					: "(name: string)"
			return Str.split(
				`export const make${index} = ${parameter} =>
	${Arr.join(callLines(c, index, "\t"), "\n")}
export const ${value} = make${index}("N${index}")`,
				"\n"
			)
		}
	}
}

/**
 * What an admitted case keeps: its relation, listed in a level of its own beside Tag, whose containment reads the
 * root, leaves Tag's inputs its rows. A dynamic door's value keeps no name: its type's name is `string` whatever its
 * call is handed, so no schema's types key on it.
 */
const keptLines = (c: NameCase, index: number): ReadonlyArray<string> => {
	if (doorOf(c.callee) === "dynamic") {
		return [
			`export const lost${index}: string extends (typeof c${index})["name"] ? true : false = true`
		]
	}
	switch (c.spelling) {
		case "literal":
		case "forwarded":
			return [
				`export const L${index} = schema.extend([Root], "L${index}", [Tag, c${index}], [tagged])`,
				`export const kept${index}: InsertAllRowsOf<typeof L${index}>["Tag"] = [{ id: tagId, item: tagId }]`
			]
		case "string":
		case "union":
		case "template":
		case "widened":
			return []
	}
}

const caseBlock = (c: NameCase, index: number): ReadonlyArray<string> => [
	`// ${c.callee}, its name ${c.spelling}`,
	...nameDeclaration(c.spelling, index),
	...valueLines(c, index),
	...keptLines(c, index),
	""
]

/** The program's prelude (test/support/programs/names.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/names.ts"))

/** The root, the roster and the relations every cell's call and level read, the batch's own. */
const namesHeader = `export const Item = relation("Item", { id: Id, n: pg.integer }, ["id"])
export const Kind = closed.ordered("Kind", ["a", "b"])
export const Root = schema("Root", [Item, Kind], [])
export const Tag = relation("Tag", { id: Id, item: Id }, ["id"])
export const tagged = contained(on(Tag, "item"), on(Item, "id"))
export const Items = query(Root).rule((r) => {
	const { id, n } = v(Item, "item")
	return r.match(Item, { id, n }).find({ id, n })
})
export const tagId = toId("00000000-0000-0000-0000-000000000000")
`

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const namesProgram = (cells: Arr.NonEmptyReadonlyArray<NameCase>, entry: Entry): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/api/names.ts: the constructors that name a relation, by every spelling of the name.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: Str.split(namesHeader, "\n") },
			...Arr.map(cells, (c, at) => ({ owner: caseOwned(at), lines: caseBlock(c, at) }))
		]
	)
]
