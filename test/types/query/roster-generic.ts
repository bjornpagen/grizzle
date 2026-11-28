import { Array as Arr, Effect } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/support/types/batch/batch.ts"

/**
 * The roster-generic program: a source generic over closed relations whose headings differ only in a closed id's
 * roster, `{ code: closedId(Roster), lexical }` over an ordered roster, an unordered one and another ordered one, as
 * pantry's lexical relations are, read by one helper written once, `codesOf(name, lexical)`, which joins a query's
 * attribute values to the lexical relation's code by its lexical form. The box is the relations the helper is
 * instantiated at.
 *
 * The oracle is a second implementation, the same join written by hand over the one relation: at each instantiation
 * the helper's rows are exactly the hand-written join's, its code of the relation's own roster, and never of another's.
 */

/** A lexical relation the helper is instantiated at: its name, its roster's name, the roster's order and handles. */
interface LexicalCell {
	readonly relation: string
	readonly roster: string
	readonly order: "ordered" | "unordered"
	readonly handles: readonly [string, string]
}

/** The cells of rosterGenericBox, minted as a dictionary in its door (test/types/query/roster-generic.dictionary.ts). */
export const rosterGenericBoxItems: Arr.NonEmptyReadonlyArray<LexicalCell> = [
	{
		relation: "BaseTypeLexical",
		roster: "BaseType",
		order: "ordered",
		handles: ["integer", "string"]
	},
	{
		relation: "ResourceTypeLexical",
		roster: "ResourceType",
		order: "unordered",
		handles: ["item", "test"]
	},
	{
		relation: "CardinalityLexical",
		roster: "Cardinality",
		order: "ordered",
		handles: ["single", "record"]
	}
]

/** A cell's roster's handles as a type: the union of their literals. */
const handlesType = (c: LexicalCell): string => Arr.join(Arr.map(c.handles, jsonText), " | ")

/** The schema every cell reads: each roster, its lexical relation, and the attributes the helper selects. */
const rosterGenericHeader = (): ReadonlyArray<string> => [
	'export const Text = str.regex("^[a-z]{1,16}$")',
	...Arr.flatMap(rosterGenericBoxItems, (c) => [
		`export const ${c.roster} = closed.${c.order}(${jsonText(c.roster)}, [${Arr.join(Arr.map(c.handles, jsonText), ", ")}])`,
		`export const ${c.relation} = closed.relation(${jsonText(c.relation)}, { code: closedId(${c.roster}), lexical: Text }, ["code"], ${c.roster}.handles.map((code) => ({ code, lexical: code })))`
	]),
	'export const Attribute = relation("Attribute", { id: pg.integer, name: Text, value: Text }, ["id"])',
	`export const Qti = schema("Qti", [${Arr.join(
		Arr.flatMap(rosterGenericBoxItems, (c) => [c.roster, c.relation]),
		", "
	)}, Attribute], [])`,
	"/** The attributes of one name, each by its id, with its value. */",
	"export const attributeValues = (name: string) =>",
	"\tquery(Qti).rule((r) => {",
	'\t\tconst { id, name: n, value } = v(Attribute, "attribute")',
	"\t\treturn r.match(Attribute, { id, name: n, value }).where(r.eq(n, name)).find({ id, value })",
	"\t})",
	`export type Lexical = ${Arr.join(
		Arr.map(rosterGenericBoxItems, (c) => `typeof ${c.relation}`),
		" | "
	)}`,
	"/** The helper written once over every lexical relation: each attribute's value joined to its code. */",
	"export const codesOf = <L extends Lexical>(name: string, lexical: L) => {",
	"\tconst attributes = attributeValues(name)",
	"\treturn query(Qti).rule((r) => {",
	'\t\tconst { id, value } = v(attributes, "attribute")',
	'\t\tconst { code } = v(lexical, "lexical")',
	"\t\treturn r.match(attributes, { id, value }).match(lexical, { code, lexical: value }).find({ code, id })",
	"\t})",
	"}",
	"export type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
	"export type Expect<T extends true> = T",
	""
]

/** A roster other than a cell's: the next cell's, whose handles no instantiation at the cell's relation holds. */
const otherOf = (c: LexicalCell): LexicalCell => {
	const at = rosterGenericBoxItems.indexOf(c)
	return rosterGenericBoxItems[(at + 1) % rosterGenericBoxItems.length] ?? c
}

/**
 * A cell's lines: the helper at its relation, the join written by hand over it, their rows the same, and the helper's
 * code never another roster's.
 */
const cellLines = (c: LexicalCell, at: number): ReadonlyArray<string> => [
	`// ${c.relation}: closedId(${c.roster}), ${c.order}`,
	`export const generic${at} = codesOf("n", ${c.relation})`,
	`export const hand${at} = query(Qti).rule((r) => {`,
	'\tconst { id, value } = v(attributeValues("n"), "attribute")',
	`\tconst { code } = v(${c.relation}, "lexical")`,
	`\treturn r.match(attributeValues("n"), { id, value }).match(${c.relation}, { code, lexical: value }).find({ code, id })`,
	"})",
	`export type rows${at} = Expect<Equals<HeadOf<typeof generic${at}>, HeadOf<typeof hand${at}>>>`,
	`export type code${at} = Expect<Equals<HeadOf<typeof generic${at}>["code"], ${handlesType(c)}>>`,
	`// @ts-expect-error -- refused: an instantiation's code is its own roster's, never ${otherOf(c).roster}'s`,
	`export type other${at} = Expect<Equals<HeadOf<typeof generic${at}>["code"], ${handlesType(otherOf(c))}>>`,
	""
]

/** The program's prelude (test/support/programs/roster-generic.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/roster-generic.ts"))

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const rosterGenericProgram = (
	cells: Arr.NonEmptyReadonlyArray<LexicalCell>,
	entry: Entry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/query/roster-generic.ts: one helper over closed relations whose closed ids differ in roster.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: rosterGenericHeader() },
			...Arr.map(cells, (c, at) => ({ owner: caseOwned(at), lines: cellLines(c, at) }))
		]
	)
]
