import { Array as Arr, Effect } from "effect"
import type { Refused } from "#compiler/core/refusals.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/support/types/batch/batch.ts"

/**
 * The generic-base programs: a level schema.extend builds over a base parameter, `<Base extends Bound>(base: Base) =>
 * schema.extend([base], ...)`, its bound the least level it reads, `SchemaOver<typeof Root>`, or the weakest,
 * AnySchema, over every content a level may hold against what its base holds, instantiated over each base a bound
 * admits: Root itself, and Graded, a level over Root holding one relation more. Beside each, the same level over the
 * same base built directly, the call every check reads its base at. Each cell is printed into one program the type
 * batch checks.
 *
 * The oracle is the rules the engine holds every level to, computed here apart from the types (`definitionVerdict`,
 * `levelVerdict`): a name is declared once across a level and every level below it, a statement names only relations
 * some level declares, and a derived definition is a query over a level below. A generic level's call knows its base's
 * least level alone, so it is refused there by a rule that level breaks, and every rule the base itself breaks refuses
 * the level its instantiation builds, wherever that level is taken as a schema; a level over a built schema is refused
 * at its call by every rule.
 */

/** A base parameter's bound: the least level the level reads, Root, or AnySchema, which knows no relation's name. */
export type Bound = "SchemaOver<Root>" | "AnySchema"

/** The base a cell instantiates its level over: Root, or Graded over Root, which holds Gradebook too. */
export type Base = "Root" | "Graded"

/**
 * What a level holds against its base:
 * - `own`: a relation of its own and a containment between its own relations;
 * - `readsRoot`: a containment from its own relation into Root's Sitting;
 * - `readsGraded`: a containment from its own relation into Graded's Gradebook, which Root does not hold;
 * - `clashesRoot`: a relation named Sitting other than Root's;
 * - `clashesGraded`: a relation named Gradebook other than Graded's;
 * - `derivedOverRoot`: a derived relation whose definition is a query over Root;
 * - `relistsRoot`: Root's own Sitting listed again, as Root declares it.
 */
export type Content =
	| "own"
	| "readsRoot"
	| "readsGraded"
	| "clashesRoot"
	| "clashesGraded"
	| "derivedOverRoot"
	| "relistsRoot"

/** A cell: a level of one content, over a base parameter of one bound, instantiated over one base. */
export interface GenericBaseCell {
	readonly bound: Bound
	readonly content: Content
	readonly base: Base
}

const bounds: Arr.NonEmptyReadonlyArray<Bound> = ["SchemaOver<Root>", "AnySchema"]
const contents: Arr.NonEmptyReadonlyArray<Content> = [
	"own",
	"readsRoot",
	"readsGraded",
	"clashesRoot",
	"clashesGraded",
	"derivedOverRoot",
	"relistsRoot"
]
const bases: Arr.NonEmptyReadonlyArray<Base> = ["Root", "Graded"]

/**
 * The cells of genericBaseBox, minted as a dictionary in its door (test/types/schema/generic-base.dictionary.ts): every
 * bound, content and base.
 */
export const genericBaseBoxItems: Arr.NonEmptyReadonlyArray<GenericBaseCell> = Arr.flatMap(
	bounds,
	(bound) =>
		Arr.flatMap(contents, (content) =>
			Arr.map(bases, (base): GenericBaseCell => ({ bound, content, base }))
		)
)

/**
 * What a level's call is refused by: a named refusal, a refusal the checker states as no named one (a list's element
 * outside its constraint), or none.
 */
type Verdict =
	| { readonly kind: "admitted" }
	| { readonly kind: "refusal"; readonly refusal: Refused }
	| { readonly kind: "refused"; readonly why: string }

const admitted: Verdict = { kind: "admitted" }
const refusal = (r: Refused): Verdict => ({ kind: "refusal", refusal: r })

/** The relations a level's base holds by name, every level below it: Root's, and Graded's Gradebook beside them. */
const holds = (base: Base | "nothing"): ReadonlySet<string> =>
	new Set(
		base === "Root"
			? ["Series", "Sitting"]
			: base === "Graded"
				? ["Series", "Sitting", "Gradebook"]
				: []
	)

/**
 * The verdict the engine's rules give a level of `content` over a base holding `held`, in the order the call checks
 * them: the list's names (DeclaredOnce), each derived definition's level (its list's constraint), and the statements'
 * relations (StatementsWithin). `levels` is whether the call knows the base's levels, a base parameter bounded by
 * AnySchema knowing none, so a derived relation over Root is no query over a level it knows.
 */
const verdictOver = (content: Content, held: ReadonlySet<string>, levels: boolean): Verdict => {
	switch (content) {
		case "own":
		case "relistsRoot":
			return admitted
		case "readsRoot":
			return held.has("Sitting") || !levels ? admitted : refusal(undeclared)
		case "readsGraded":
			return held.has("Gradebook") || !levels ? admitted : refusal(undeclared)
		case "clashesRoot":
			return held.has("Sitting") ? refusal(clash) : admitted
		case "clashesGraded":
			return held.has("Gradebook") ? refusal(clash) : admitted
		case "derivedOverRoot":
			return levels
				? admitted
				: {
						kind: "refused",
						why: "a derived relation over Root, a level no bound of AnySchema knows"
					}
	}
}

const clash: Refused = "two relations of one name across a schema's levels"
const undeclared: Refused = "a statement names a relation no level of the schema declares"

/**
 * The verdict at a generic level's call: its content against its bound's least level, Root's relations for
 * SchemaOver<Root>, none known for AnySchema, whose statements the call admits over any name.
 */
const definitionVerdict = (c: GenericBaseCell): Verdict =>
	c.bound === "SchemaOver<Root>"
		? verdictOver(c.content, holds("Root"), true)
		: verdictOver(c.content, holds("nothing"), false)

/** The verdict of the level over the base itself: at a built base's call, and at a generic level's instantiation. */
const levelVerdict = (c: GenericBaseCell): Verdict => verdictOver(c.content, holds(c.base), true)

/** A content's list and statements, its own relations named by the cell's place. */
const contentText = (content: Content, at: number): { list: string; statements: string } => {
	switch (content) {
		case "own":
			return {
				list: `Note, Mark${at}`,
				statements: `contained(on(Mark${at}, "number"), on(Note, "number"))`
			}
		case "readsRoot":
			return { list: "Note", statements: 'contained(on(Note, "number"), on(Sitting, "number"))' }
		case "readsGraded":
			return { list: "Note", statements: 'contained(on(Note, "number"), on(Gradebook, "number"))' }
		case "clashesRoot":
			return { list: "OtherSitting", statements: "" }
		case "clashesGraded":
			return { list: "OtherGradebook", statements: "" }
		case "derivedOverRoot":
			return { list: "Sat", statements: "" }
		case "relistsRoot":
			return {
				list: "Sitting, Note",
				statements: 'contained(on(Note, "number"), on(Sitting, "number"))'
			}
	}
}

/** A directive for a line the verdict refuses, none for one it admits. */
const directive = (verdict: Verdict, why: string): ReadonlyArray<string> => {
	switch (verdict.kind) {
		case "admitted":
			return []
		case "refusal":
			return [`// @ts-expect-error -- refusal: ${verdict.refusal}`]
		case "refused":
			return [`// @ts-expect-error -- refused: ${why}, ${verdict.why}`]
	}
}

/**
 * A cell's lines: its generic level, refused at its call by its bound's verdict; where admitted, its instantiation over
 * the base, and a level over that, refused by the base's verdict, where the refused level is taken as a schema; and
 * the same level over the base built directly, refused at its call by the base's verdict.
 */
const cellLines = (c: GenericBaseCell, at: number): ReadonlyArray<string> => {
	const { list, statements } = contentText(c.content, at)
	const bound = c.bound === "AnySchema" ? "AnySchema" : "SchemaOver<typeof Root>"
	const definition = definitionVerdict(c)
	const level = levelVerdict(c)
	const own =
		c.content === "own"
			? [`const Mark${at} = relation("Mark${at}", { number: natural }, ["number"])`]
			: []
	const generic = [
		...directive(definition, "the generic level's call"),
		`export const of${at} = <B extends ${bound}>(base: B) => schema.extend([base], "Level${at}", [${list}], [${statements}])`
	]
	const instantiated =
		definition.kind === "admitted"
			? [
					`export const level${at} = of${at}(${c.base})`,
					...directive(level, "the instantiated level taken as a base"),
					`export const above${at} = schema.extend([level${at}], "Above${at}", [], [])`
				]
			: []
	return [
		`// ${c.content} over a base bounded by ${c.bound}, instantiated over ${c.base}`,
		...own,
		...generic,
		...instantiated,
		...directive(level, "the level over the built base"),
		`export const built${at} = schema.extend([${c.base}], "Built${at}", [${list}], [${statements}])`,
		""
	]
}

/**
 * The schema every cell reads: Root, its roster and Sitting; Graded over it, holding Gradebook, contained in Sitting;
 * Note, a relation of the levels' own; OtherSitting and OtherGradebook, relations named as Root's and Graded's and
 * other than them; and Sat, a derived relation whose definition is a query over Root. Beside them, a level over Root
 * and Graded both, refused: a level over several bases is not built yet; a level over Root spelled with no list, the
 * spelling before the list, refused at its call; and Viewing, a level over Graded holding Viewed, a derived relation over
 * Graded, read by a query over Viewing, so a level over a listed base keeps every relation of it as itself.
 */
const genericBaseHeader = (): ReadonlyArray<string> => [
	'export const Series = closed.unordered("Series", ["a", "b"])',
	'export const Sitting = relation("Sitting", { number: natural, series: closedId(Series) }, ["number"])',
	'export const Root = schema("Root", [Series, Sitting], [])',
	'export const Gradebook = relation("Gradebook", { number: natural }, ["number"])',
	'export const Graded = schema.extend([Root], "Graded", [Gradebook], [contained(on(Gradebook, "number"), on(Sitting, "number"))])',
	'export const Note = relation("Note", { number: natural }, ["number"])',
	'export const OtherSitting = relation("Sitting", { number: natural }, ["number"])',
	'export const OtherGradebook = relation("Gradebook", { number: natural, note: natural }, ["number"])',
	"export const Sat = derived(",
	'\t"Sat",',
	"\tquery(Root).rule((r) => {",
	'\t\tconst { number } = v(Sitting, "s")',
	"\t\treturn r.match(Sitting, { number }).find({ number })",
	"\t})",
	")",
	"// @ts-expect-error -- refusal: schema.extend takes one base: a level over several bases is not built yet",
	'export const TwoBases = schema.extend([Root, Graded], "TwoBases", [], [])',
	"// @ts-expect-error -- refusal: schema.extend takes one base: a level over several bases is not built yet",
	'export const BareBase = schema.extend(Root, "BareBase", [], [])',
	"export const Viewed = derived(",
	'\t"Viewed",',
	"\tquery(Graded).rule((r) => {",
	'\t\tconst { number } = v(Gradebook, "g")',
	"\t\treturn r.match(Gradebook, { number }).find({ number })",
	"\t})",
	")",
	'export const Viewing = schema.extend([Graded], "Viewing", [Viewed], [])',
	"export const readsViewed = query(Viewing).rule((r) => {",
	'\tconst { number } = v(Viewed, "w")',
	"\treturn r.match(Viewed, { number }).find({ number })",
	"})",
	""
]

/** The program's prelude (test/support/programs/generic-base.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/generic-base.ts"))

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const genericBaseProgram = (
	cells: Arr.NonEmptyReadonlyArray<GenericBaseCell>,
	entry: Entry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/schema/generic-base.ts: a level over a base parameter, at its call and its instantiation.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: genericBaseHeader() },
			...Arr.map(cells, (c, at) => ({ owner: caseOwned(at), lines: cellLines(c, at) }))
		]
	)
]
