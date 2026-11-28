import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { Array as Arr, Predicate, Record as Rec, String as Str } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { compilePage, statedOrderOf } from "#compiler/lower/shapes/page/compile.ts"
import { type QueryTemplate } from "#compiler/program/compile.ts"
import { queryInput } from "#compiler/program/input.ts"
import { Decimal, Money, pg, Vector } from "#compiler/public/fields.ts"
import { schema } from "#compiler/public/schema.ts"
import { queryOver, type QueryValue, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { paramTerm } from "#compiler/query/build/terms.ts"
import { computeCore, handleTerm } from "#compiler/scalar/compute/builders.ts"
import { check } from "#compiler/schema/api.ts"
import { closedIdOf } from "#compiler/schema/relation.ts"
import { costChosen } from "#compiler/sql/emit.ts"
import {
	changeSetDesc,
	changeSetOver,
	type ChangeSetValue
} from "#compiler/write/changeset/value.ts"
import { compileChangeSet } from "#compiler/write/frontend/compile.ts"
import {
	Agree,
	AgreeAbove,
	Apart,
	Cell,
	Cents,
	Item,
	Note,
	Shade,
	Tone
} from "#test/support/agreement/schema.ts"
import {
	compileTemplate,
	frontendOptions,
	testArtifacts,
	testCompile
} from "#test/support/compile.ts"
import { Id } from "#test/support/ids.ts"
import { checking } from "#test/support/policy.ts"
import { type PreludeAt, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Program } from "#test/support/types/batch/batch.ts"

/**
 * The admission agreement: types against the engine, over every position a constant may stand in and every kind of
 * constant (docs/reads-and-writes.md "Differences from SQL"). The class it closes is a program the types and
 * the engine disagree on: a position the types refuse though the engine admits it, or admit though it refuses.
 *
 * For each position and each constant kind, the program states one statement over Cell for every value of the kind
 * and every stage it keeps an arm under, each statement once (matrixLines): the box is every position against every
 * kind, and each cell its every pick. The oracle is the engine: the statement is built
 * through the builder's JavaScript view (queryOver, varsOver, computeCore, and check over an untyped row) and
 * compiled as the runtime compiles it, with no types. The program states each verdict: plain where the engine admits,
 * under a `@ts-expect-error` where it refuses, naming the refusal the types name. The type batch checks the program
 * disarmed, so a statement the types refuse and the engine admits is a diagnostic no directive names, one they admit
 * and the engine refuses is a directive whose diagnostic never comes, and either fails the batch.
 *
 * Positions and constant kinds are closed unions read by exhaustive switches: a new one is a row of each, which the
 * compiler requires every reader to handle. Each statement is one line, so its diagnostic is on the line after its
 * directive, whichever diagnostic the checker elaborates its refusal to.
 *
 * The discriminant position draws the kinds a head holds: a value no head holds is the head position's refusal. Three
 * positions stand in a self-join of Cell, whose second scope, named apart, is a second type: a constant bound at its
 * column, compared with its variable, or held in a self-join parent's head and bound by an attachment keyed by the
 * second scope's id (selfJoinAttachParent), is admitted exactly where it is at a rule's one scope.
 *
 * The rest stand where a constant meets a query rather than a column:
 * - paramBinding: Q.bind of a parameter declared at the constant's column, a property of bind's argument.
 * - computedBinding: a second scope of Cell bound at the constant's column to the first scope's value plus the
 *   constant, a computed term: an exact integer or exact money at a plain integer or money column is the equality the
 *   checker writes widened, as Logic.eq's, and admitted both ways; an operand the sum refuses is refused at its
 *   argument, and a sum the column refuses, a contract's base at the contract, at the binding.
 * - deadFilter: a union source whose every arm holds the constant at a field, matched with another of its kind bound
 *   there, a filter no fact meets, which both refuse by name (DeadConstants, check/checker.ts RuleCheck #selected).
 * - heteroArms and heteroClash: two arms of different headings holding constants at one field, different ones, which
 *   discriminate the union, or one, which leaves it no discriminant.
 * - threeArms and threeArmsClash: three arms of different headings, told apart only by two fields together, or two of
 *   them alike at the one field left common when the third arm lacks the other.
 * - attachedArm and attachedArmApart: a union with an attached arm, of the other arm's heading, which both refuse by
 *   name (ArmsMeet, check/checker.ts Checker.union), or of another heading the constants tell apart, which both admit.
 * - attachedArmTaken, attachedArmNamed and attachedArmKept: the attached arm under the stages that keep its records,
 *   and so its attachment: a take, a name, or two of them drawn in turn, beside an arm of its heading, which both
 *   refuse by name; attachedArmKeptApart, under one or two drawn stages, beside an arm of another heading, which both
 *   admit. An order reaches an arm only through the take that closes it, since an ordered query has no rule.
 * - flaggedArm: a union of two arms of one heading whose first arm's field is one of two values under a boolean the
 *   program does not know, the column's variable or the constant (`flag ? x : c`), and whose second holds another
 *   constant of the kind there. The engine reads the union under each value the flag may take, so it is admitted where
 *   both readings compile, the second arm meeting the variable and the constant each; where either is refused, the
 *   types refuse the union at the second arm by name, as an arm meeting each carrier the arms before it deliver at a
 *   field, a carrier that is one of two values read as each (types/query/query.ts Mismatched).
 *
 * The combinator axis closes the same class over the query a combinator stands on rather than a constant: every
 * combinator (combinators: take, a page, orderBy, approximateNearest, attach, named, and a further arm of the shape's
 * heading or of another) over every shape (shapeBases: one rule, a union of one heading, a union of several headings,
 * an attached rule) under every wrapper (shapeWrappers: none, a name, a take), once each. All three are closed unions
 * read by exhaustive switches, so a new combinator, shape or wrapper is a compile error until it has its cells. A
 * combinator reads the fields at risk: orderBy orders by the name some record holds that the shape does not deliver as
 * a column (an arm's own field, an attachment), and an attachment's child heads an arm's own field over a union of
 * several headings. Its directive is the refusal the types name where they refuse, or a structural refusal
 * (combinatorRefusal).
 * The scope axis closes it over the schema a matched query is written over, what a relation parameter of an imported
 * query is bound to, and where a relational negation stands (scopeCells): a rule matches a query, as it is or bound,
 * only over a level of its schema, though the schemas share every relation the query reads; a relation parameter binds
 * the importing rule's own relation parameter alone; and r.not is a rule's filter, alone or in a conjunction there,
 * never in a disjunction. Each refusal is named, and the engine's reason must be the one its refusal names. Each cell
 * the engine admits states its parameters too, as the ones a call of it supplies: a query's every declared one, a
 * write's every one its bind map leaves free, a bound query's those its bind map needs and a query's its own among them
 * (scopeVerdict).
 * A refusal both name is under its named directive (namedRefusal): a JavaScript value at a first operand (firstOperand,
 * computeFirst, condThen) is "a term first", whatever value it is. Every other refusal is structural: the statement
 * does not compile. The positions whose verdict turns on two constants being one value (deadFilter, heteroClash,
 * threeArmsClash, attachedArmApart, attachedArmKeptApart) and the attached arms beside an arm of their heading, whose
 * verdict turns on no constant, draw only the kinds whose value the types carry, a primitive or a handle (valued): the
 * types take a Decimal, a Money and a typed Type.literal to be any value of their type, the widening they keep
 * (types/query/query.ts Apart).
 */

/** Every position a constant may stand in. */
const admissionPositions = [
	"binding",
	"unionBinding",
	"selfJoinBinding",
	"selfJoinOperand",
	"secondOperand",
	"firstOperand",
	"computeSecond",
	"computeFirst",
	"condThen",
	"condElse",
	"head",
	"discriminant",
	"attachParent",
	"selfJoinAttachParent",
	"pageOrderKey",
	"checkRow",
	"paramBinding",
	"computedBinding",
	"deadFilter",
	"heteroArms",
	"heteroClash",
	"threeArms",
	"threeArmsClash",
	"attachedArm",
	"attachedArmApart",
	"attachedArmTaken",
	"attachedArmNamed",
	"attachedArmKept",
	"attachedArmKeptApart",
	"flaggedArm"
] as const
export type AdmissionPosition = (typeof admissionPositions)[number]

/**
 * Every kind of constant: a JavaScript value of each carrier, a roster's handle, a typed Type.literal and a
 * contract's, an uppercase uuid, which the builder canonicalizes, a finite refined text's member, and a parameter of
 * the column's own descriptor; and the ill-typed: another roster's handle, a contract's constant at its base, a handle
 * off its roster, a text that is no uuid's spelling at a uuid, another pattern's member at a refined text, a
 * parameter of another column's descriptor, a term of its own type that adopts nothing from its uses, and a roster's
 * member as a typed constant of its closed id, Type.literal, which is X.handle(member) instead.
 */
const constantKinds = [
	"text",
	"integer",
	"bigint",
	"boolean",
	"uuid",
	"decimal",
	"money",
	"vector",
	"handle",
	"typed",
	"contract",
	"wrongRoster",
	"contractAtBase",
	"offRoster",
	"uuidUpper",
	"notUuid",
	"language",
	"otherLanguage",
	"param",
	"otherParam",
	"rosterLiteral"
] as const
export type ConstantKind = (typeof constantKinds)[number]

/** A column of Cell a constant meets. */
type Column = keyof typeof Cell.fields

/** A drawn constant: its source in the program, its value through the builder's JavaScript view, and its column. */
interface Constant {
	readonly source: string
	readonly value: () => unknown
	readonly column: Column
}

/** The mint of each of Cell's contract columns' values, as the program names it (test/support/ids.ts, ./schema.ts). */
const columnMints: { readonly [C in Column]?: string } = { uuid: "toId", cents: "toCents" }

/**
 * A constant's source where it becomes a value of its column, a conditional's other arm beside the column's variable:
 * a JavaScript value at a contract's column is its mint's (types/fields ValueLiteralOf), and anything else, a term or a
 * typed constant, is as it is.
 */
const madeOf = (c: Constant): string => {
	const mint = columnMints[c.column]
	return mint === undefined ||
		Str.startsWith("Type.literal(")(c.source) ||
		Str.startsWith("r.param(")(c.source)
		? c.source
		: `${mint}(${c.source})`
}

/**
 * The builder's parameter as a JavaScript caller reaches it, with any descriptor: a drawn column's, whose type is the
 * union of every column's.
 */
const hostParam: {
	term(name: string, descriptor: unknown, label: string): unknown
} = { term: paramTerm }

/** A parameter of the descriptor of Cell's column `descriptor`, named for it, meeting the column `column`. */
const parameterOf = (descriptor: Column, column: Column): Constant => ({
	source: `r.param("k_${descriptor}", Cell.fields.${descriptor})`,
	value: () =>
		hostParam.term(`k_${descriptor}`, Cell.fields[descriptor], `r.param(k_${descriptor})`),
	column
})

const vector =
	(scale: number): (() => unknown) =>
	() =>
		Vector.make(Float32Array.of(0.5 * scale, 1, 2), 3)

/** The constant of a kind at the pick-th of its values. */
const constantOf = (kind: ConstantKind, pick: number): Constant => {
	const of = <A>(values: Arr.NonEmptyReadonlyArray<A>): A =>
		Arr.getUnsafe(values, pick % values.length)
	switch (kind) {
		case "text": {
			const v = of(["a", "b"])
			return { source: jsonText(v), value: () => v, column: "text" }
		}
		case "integer": {
			const v = of([1, 2])
			return { source: String(v), value: () => v, column: "integer" }
		}
		case "bigint": {
			const v = of([5n, 7n])
			return { source: `${v}n`, value: () => v, column: "bigint" }
		}
		case "boolean": {
			const v = of([true, false])
			return { source: String(v), value: () => v, column: "boolean" }
		}
		case "uuid": {
			const v = of(["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"])
			return { source: jsonText(v), value: () => v, column: "uuid" }
		}
		case "decimal": {
			const v = of(["1.5", "2"])
			return {
				source: `Decimal.of(${jsonText(v)})`,
				value: () => Decimal.of(v),
				column: "numeric"
			}
		}
		case "money": {
			const v = of([150n, 7n])
			return { source: `Money.of(${v}n)`, value: () => Money.of(v), column: "money" }
		}
		case "vector": {
			const scale = of([1, 2])
			return {
				source: `Vector.make(Float32Array.of(${0.5 * scale}, 1, 2), 3)`,
				value: vector(scale),
				column: "vector"
			}
		}
		case "handle": {
			const m = of(["low", "mid", "high"] as const)
			return {
				source: `Tone.handle(${jsonText(m)})`,
				value: () => Tone.handle(m),
				column: "tone"
			}
		}
		case "typed": {
			const v = of([1, 2])
			return {
				source: `Type.literal(pg.integer, ${v})`,
				value: () => computeCore.literal(pg.integer, v),
				column: "integer"
			}
		}
		case "contract": {
			const v = of([1n, 2n])
			return {
				source: `Type.literal(Cents, toCents(${v}n))`,
				value: () => computeCore.literal(Cents, v),
				column: "cents"
			}
		}
		case "wrongRoster": {
			const m = of(["low", "dark"] as const)
			return {
				source: `Shade.handle(${jsonText(m)})`,
				value: () => Shade.handle(m),
				column: "tone"
			}
		}
		case "contractAtBase": {
			const v = of([1n, 2n])
			return {
				source: `Type.literal(Cents, toCents(${v}n))`,
				value: () => computeCore.literal(Cents, v),
				column: "bigint"
			}
		}
		case "offRoster":
			return {
				source: `Tone.handle("none")`,
				value: () => handleTerm(Tone, closedIdOf(Tone, []), "none"),
				column: "tone"
			}
		case "uuidUpper": {
			const v = of(["00000000-0000-4000-8000-00000000000A", "00000000-0000-4000-8000-0000000000BC"])
			return { source: jsonText(v), value: () => v, column: "uuid" }
		}
		case "notUuid": {
			const v = of(["0193d8f2", "00000000-0000-4000-8000"])
			return { source: jsonText(v), value: () => v, column: "uuid" }
		}
		case "language": {
			const v = of(["pass", "fail"])
			return { source: jsonText(v), value: () => v, column: "grade" }
		}
		case "otherLanguage": {
			const v = of(["yes", "no"])
			return { source: jsonText(v), value: () => v, column: "grade" }
		}
		case "param": {
			const column = of(["integer", "uuid", "cents", "tone", "text"] as const)
			return parameterOf(column, column)
		}
		case "rosterLiteral": {
			const m = of(["low", "mid", "high"] as const)
			return {
				source: `Type.literal(Cell.fields.tone, ${jsonText(m)})`,
				value: () => computeCore.literal(Cell.fields.tone, m),
				column: "tone"
			}
		}
		case "otherParam": {
			const [descriptor, column] = of<readonly [Column, Column]>([
				["uuid", "cents"],
				["shade", "tone"],
				["cents", "bigint"]
			])
			return parameterOf(descriptor, column)
		}
	}
}

/**
 * Whether a kind is a JavaScript value, which a first operand refuses by name (types/compute/scalar.ts FirstTerm),
 * rather than a typed term.
 */
const isJavaScriptValue = (kind: ConstantKind): boolean => {
	switch (kind) {
		case "text":
		case "integer":
		case "bigint":
		case "boolean":
		case "uuid":
		case "decimal":
		case "money":
		case "vector":
		case "uuidUpper":
		case "notUuid":
		case "language":
		case "otherLanguage":
			return true
		case "handle":
		case "typed":
		case "contract":
		case "wrongRoster":
		case "contractAtBase":
		case "offRoster":
		case "param":
		case "otherParam":
		case "rosterLiteral":
			return false
	}
}

/** The refusal a cell's types name; none where the refusal is structural. */
const namedRefusal = (position: AdmissionPosition, kind: ConstantKind): Refused | undefined => {
	switch (position) {
		case "firstOperand":
		case "computeFirst":
		case "condThen":
			return isJavaScriptValue(kind)
				? "a term first: a literal takes its place opposite a term, never first"
				: undefined
		case "deadFilter":
			return "no arm of the source delivers the bound constants"
		case "heteroClash":
		case "threeArmsClash":
			return "arms of different headings share a field that holds a different constant in each"
		case "attachedArm":
		case "attachedArmTaken":
		case "attachedArmNamed":
		case "attachedArmKept":
			return "an attachment on an arm of a union whose heading several arms share"
		case "binding":
		case "unionBinding":
		case "selfJoinBinding":
		case "selfJoinOperand":
		case "secondOperand":
		case "computeSecond":
		case "condElse":
		case "head":
		case "discriminant":
		case "attachParent":
		case "selfJoinAttachParent":
		case "pageOrderKey":
		case "checkRow":
		case "paramBinding":
		case "computedBinding":
		case "attachedArmApart":
		case "attachedArmKeptApart":
			return undefined
		case "heteroArms":
		case "threeArms":
			return kind === "param" || kind === "otherParam"
				? "a union's arms deliver each field at one type"
				: undefined
		case "flaggedArm":
			return "a union's arms deliver each field at one type"
	}
}

/**
 * The directive over a refused statement: a roster's member as Type.literal is the literal's own refusal, its
 * descriptor's, wherever it stands; else its named refusal; else a structural refusal and why.
 */
const directiveOf = (position: AdmissionPosition, kind: ConstantKind): string => {
	if (kind === "rosterLiteral") {
		return "// @ts-expect-error -- refused: a roster's member is X.handle(member), never Type.literal"
	}
	const named = namedRefusal(position, kind)
	return named === undefined
		? `// @ts-expect-error -- refused: the engine refuses ${kind} at ${position}`
		: `// @ts-expect-error -- refusal: ${named}`
}

/** One statement of the matrix: its lines in the program, and how the engine reads it. */
interface Statement {
	readonly lines: Arr.NonEmptyReadonlyArray<string>
	readonly verdict: () => boolean
}

/**
 * A built query's page as a paged workload member's page compiles (adapter/page/template.ts): the page compiler over
 * the template compiled for a page and the stated order of the query's Description, against the schema's names.
 */
const paged = (q: unknown, template: QueryTemplate): Result.Result<unknown, CompileError> =>
	Result.flatMap(testArtifacts(Agree, testCompile), (artifacts) =>
		Result.flatMap(queryInput(q), (input) =>
			Result.flatMap(statedOrderOf(input.desc, SourceLoc("query", [])), (stated) =>
				compilePage({
					binding: costChosen,
					checked: template.programs.checked,
					stated,
					optimized: template.programs.optimized,
					names: artifacts.names
				})
			)
		)
	)

/** A built query's engine verdict: the builder admits it and the compiler compiles it, read as rows or a page. */
const compiles =
	(build: () => unknown, read: "rows" | "page"): (() => boolean) =>
	() =>
		Result.flatMap(catchCompileError(build), (q) =>
			Result.flatMap(
				compileTemplate(q, undefined, { ...testCompile, read }),
				(template): Result.Result<unknown, CompileError> =>
					read === "page" ? paged(q, template) : Result.ok(template)
			)
		).ok

/** A row's field as the check's predicate receives it, refused as no field when the row holds none. */
const rowField = (row: unknown, column: Column): unknown =>
	Predicate.hasProperty(row, column) ? row[column] : undefined

/**
 * An arm of a union over Cell of its own heading: Cell's id, the constant under d, each further constant under its
 * field, and the column `own` under `as`, which no other arm of the union delivers.
 */
const ownArm =
	(
		d: Constant,
		more: ReadonlyArray<readonly [string, number]>,
		own: Column,
		as: string
	): ((r: RuleValue) => unknown) =>
	(r) => {
		const vars = varsOver(Cell, "cell")
		return r
			.match(Cell, { id: vars["id"], [own]: vars[own] })
			.find({ id: vars["id"], d: d.value(), ...Rec.fromEntries(more), [as]: vars[own] })
	}

/**
 * An arm over Cell holding Cell's id and the constant under d, each further constant under its field, with an
 * attachment of the Cell its id keys: an attached arm, whose rows carry the attachment.
 */
const attachedArm =
	(d: Constant, more: ReadonlyArray<readonly [string, number]>): ((r: RuleValue) => unknown) =>
	(r) => {
		const vars = varsOver(Cell, "cell")
		return r
			.match(Cell, { id: vars["id"] })
			.find({ id: vars["id"], d: d.value(), ...Rec.fromEntries(more) })
			.attach(
				"c",
				(p: Readonly<Record<string, unknown>>) =>
					queryOver(Agree).rule((q: RuleValue) =>
						q.match(Cell, { id: p["id"] }).find({ found: true })
					),
				"array"
			)
	}

/** The source of attachedArm's arm. */
const attachedArmSource = (d: Constant, more: ReadonlyArray<readonly [string, number]>): string =>
	`(r) => { const { id } = v(Cell, "cell"); return r.match(Cell, { id }).find({ id, d: ${d.source}${Arr.join(
		Arr.map(more, ([field, value]) => `, ${field}: ${value}`),
		""
	)} }).attach("c", (p) => query(Agree).rule((q) => q.match(Cell, { id: p.id }).find({ found: true })), "array") }`

/** An arm over Cell holding Cell's id and the constant under d, each further constant under its field. */
const plainArm =
	(d: Constant, more: ReadonlyArray<readonly [string, number]>): ((r: RuleValue) => unknown) =>
	(r) => {
		const vars = varsOver(Cell, "cell")
		return r
			.match(Cell, { id: vars["id"] })
			.find({ id: vars["id"], d: d.value(), ...Rec.fromEntries(more) })
	}

/** The source of plainArm's arm. */
const plainArmSource = (d: Constant, more: ReadonlyArray<readonly [string, number]>): string =>
	`(r) => { const { id } = v(Cell, "cell"); return r.match(Cell, { id }).find({ id, d: ${d.source}${Arr.join(
		Arr.map(more, ([field, value]) => `, ${field}: ${value}`),
		""
	)} }) }`

/** A stage over a query that keeps its records: a name, or an order and the take that closes it. */
type Kept = "named" | "take"

/** Every two kept stages in turn, innermost first. */
const twoKept: Arr.NonEmptyReadonlyArray<readonly [Kept, Kept]> = [
	["named", "named"],
	["named", "take"],
	["take", "named"],
	["take", "take"]
]

/** Every one or two kept stages in turn. */
const anyKept: Arr.NonEmptyReadonlyArray<ReadonlyArray<Kept>> = [["named"], ["take"], ...twoKept]

/** The value of `values` a cell's draw picks. */
const drawn = <A>(values: Arr.NonEmptyReadonlyArray<A>, draw: number): A =>
	Arr.getUnsafe(values, draw % values.length)

/** A stage over a query: its source in the program, and the stage through the builder's JavaScript view. */
interface StageOver {
	readonly source: string
	readonly over: (q: QueryValue) => QueryValue
}

/** The j-th kept stage over a query, innermost first. */
const keptStage = (stage: Kept, j: number): StageOver => {
	switch (stage) {
		case "named":
			return { source: `.named("kept${j}")`, over: (q) => q.named(`kept${j}`) }
		case "take":
			return {
				source: '.orderBy(["id", "asc"]).take(2)',
				over: (q) => q.orderBy(["id", "asc"]).take(2)
			}
	}
}

/**
 * A query whose one arm is attachedArm's under the kept stages, innermost first, with plainArm's arm joining it: its
 * line in the program and its engine verdict.
 */
const keptAttachedStatement = (
	name: string,
	stages: ReadonlyArray<Kept>,
	attached: Constant,
	joining: Constant,
	more: ReadonlyArray<readonly [string, number]>
): Statement => {
	const kept = Arr.map(stages, keptStage)
	const sources = Arr.join(
		Arr.map(kept, (s) => s.source),
		""
	)
	return {
		lines: [
			`export const ${name} = query(Agree).rule(${attachedArmSource(attached, [])})${sources}.rule(${plainArmSource(joining, more)})`
		],
		verdict: compiles(() => {
			const start = queryOver(Agree).rule(attachedArm(attached, []))
			return Arr.reduce(kept, start, (q, s) => s.over(q)).rule(plainArm(joining, more))
		}, "rows")
	}
}

/** The source of ownArm's arm. */
const ownArmSource = (
	d: Constant,
	more: ReadonlyArray<readonly [string, number]>,
	own: Column,
	as: string
): string =>
	`(r) => { const { id, ${own} } = v(Cell, "cell"); return r.match(Cell, { id, ${own} }).find({ id, d: ${d.source}, ${Arr.join(
		Arr.map(more, ([field, value]) => `${field}: ${value}, `),
		""
	)}${as}: ${own} }) }`

/** The statement of one cell of the matrix, named by `i`, any stages it keeps an arm under drawn by `draw`. */
const statementOf = (
	position: AdmissionPosition,
	c: Constant,
	other: Constant,
	draw: number,
	i: string
): Statement => {
	const col = c.column
	const name = `m${i}`
	const matched = `const { id, ${col}: x } = v(Cell, "cell"); return r.match(Cell, { id, ${col}: x })`
	const rows = (head: (r: RuleValue, x: unknown) => unknown) =>
		compiles(
			() =>
				queryOver(Agree).rule((r: RuleValue) => {
					const vars = varsOver(Cell, "cell")
					return r
						.match(Cell, { id: vars["id"], [col]: vars[col] })
						.find({ id: vars["id"], k: head(r, vars[col]) })
				}),
			"rows"
		)
	const plain = (k: string) =>
		`export const ${name} = query(Agree).rule((r) => { ${matched}.find({ id, k: ${k} }) })`
	switch (position) {
		case "binding":
			return {
				lines: [
					`export const ${name} = query(Agree).rule((r) => { const { id } = v(Cell, "cell"); return r.match(Cell, { id, ${col}: ${c.source} }).find({ id }) })`
				],
				verdict: compiles(
					() =>
						queryOver(Agree).rule((r: RuleValue) => {
							const vars = varsOver(Cell, "cell")
							return r.match(Cell, { id: vars["id"], [col]: c.value() }).find({ id: vars["id"] })
						}),
					"rows"
				)
			}
		case "unionBinding": {
			const arm = (r: RuleValue) => {
				const vars = varsOver(Cell, "cell")
				return r
					.match(Cell, { id: vars["id"], [col]: vars[col] })
					.find({ id: vars["id"], [col]: vars[col] })
			}
			const armSource = `(r) => { ${matched}.find({ id, ${col}: x }) }`
			return {
				lines: [
					`const u${i} = query(Agree).rule(${armSource}).rule(${armSource})`,
					`export const ${name} = query(Agree).rule((r) => { const { id } = v(u${i}, "union"); return r.match(u${i}, { id, ${col}: ${c.source} }).find({ id }) })`
				],
				verdict: compiles(() => {
					const union = queryOver(Agree).rule(arm).rule(arm)
					return queryOver(Agree).rule((r: RuleValue) => {
						const vars = varsOver(union, "union")
						return r.match(union, { id: vars["id"], [col]: c.value() }).find({ id: vars["id"] })
					})
				}, "rows")
			}
		}
		case "selfJoinBinding":
			return {
				lines: [
					`export const ${name} = query(Agree).rule((r) => { const cell = v(Cell, "cell"); const peer = v(Cell, "peer"); return r.match(Cell, { id: cell.id }).match(Cell, { id: peer.id, ${col}: ${c.source} }).find({ cell: cell.id, peer: peer.id }) })`
				],
				verdict: compiles(
					() =>
						queryOver(Agree).rule((r: RuleValue) => {
							const cell = varsOver(Cell, "cell")
							const peer = varsOver(Cell, "peer")
							return r
								.match(Cell, { id: cell["id"] })
								.match(Cell, { id: peer["id"], [col]: c.value() })
								.find({ cell: cell["id"], peer: peer["id"] })
						}),
					"rows"
				)
			}
		case "selfJoinOperand":
			return {
				lines: [
					`export const ${name} = query(Agree).rule((r) => { const cell = v(Cell, "cell"); const peer = v(Cell, "peer"); return r.match(Cell, { id: cell.id }).match(Cell, { id: peer.id, ${col}: peer.${col} }).where(r.eq(peer.${col}, ${c.source})).find({ cell: cell.id, peer: peer.id }) })`
				],
				verdict: compiles(
					() =>
						queryOver(Agree).rule((r: RuleValue) => {
							const cell = varsOver(Cell, "cell")
							const peer = varsOver(Cell, "peer")
							return r
								.match(Cell, { id: cell["id"] })
								.match(Cell, { id: peer["id"], [col]: peer[col] })
								.where(r.eq(peer[col], c.value()))
								.find({ cell: cell["id"], peer: peer["id"] })
						}),
					"rows"
				)
			}
		case "secondOperand":
			return {
				lines: [
					`export const ${name} = query(Agree).rule((r) => { ${matched}.where(r.eq(x, ${c.source})).find({ id }) })`
				],
				verdict: compiles(
					() =>
						queryOver(Agree).rule((r: RuleValue) => {
							const vars = varsOver(Cell, "cell")
							return r
								.match(Cell, { id: vars["id"], [col]: vars[col] })
								.where(r.eq(vars[col], c.value()))
								.find({ id: vars["id"] })
						}),
					"rows"
				)
			}
		case "firstOperand":
			return {
				lines: [
					`export const ${name} = query(Agree).rule((r) => { ${matched}.where(r.eq(${c.source}, x)).find({ id }) })`
				],
				verdict: compiles(
					() =>
						queryOver(Agree).rule((r: RuleValue) => {
							const vars = varsOver(Cell, "cell")
							return r
								.match(Cell, { id: vars["id"], [col]: vars[col] })
								.where(r.eq(c.value(), vars[col]))
								.find({ id: vars["id"] })
						}),
					"rows"
				)
			}
		case "computeSecond":
			return {
				lines: [plain(`Num.add(x, ${c.source})`)],
				verdict: rows((_r, x) => computeCore.add(x, c.value()))
			}
		case "computeFirst":
			return {
				lines: [plain(`Num.add(${c.source}, x)`)],
				verdict: rows((_r, x) => computeCore.add(c.value(), x))
			}
		case "condThen":
			return {
				lines: [plain(`Logic.cond(r.eq(x, x), ${c.source}, x)`)],
				verdict: rows((r, x) => computeCore.cond(r.eq(x, x), c.value(), x))
			}
		case "condElse":
			return {
				lines: [plain(`Logic.cond(r.eq(x, x), x, ${madeOf(c)})`)],
				verdict: rows((r, x) => computeCore.cond(r.eq(x, x), x, c.value()))
			}
		case "head":
			return {
				lines: [plain(c.source)],
				verdict: rows(() => c.value())
			}
		case "discriminant": {
			const arm = (k: Constant) => (r: RuleValue) => {
				const vars = varsOver(Cell, "cell")
				return r.match(Cell, { id: vars["id"] }).find({ id: vars["id"], d: k.value() })
			}
			const armSource = (k: Constant) =>
				`(r) => { const { id } = v(Cell, "cell"); return r.match(Cell, { id }).find({ id, d: ${k.source} }) }`
			return {
				lines: [
					`export const ${name} = query(Agree).rule(${armSource(c)}).rule(${armSource(other)})`
				],
				verdict: compiles(() => queryOver(Agree).rule(arm(c)).rule(arm(other)), "rows")
			}
		}
		case "attachParent":
			return {
				lines: [
					`export const ${name} = query(Agree).rule((r) => { const { id } = v(Cell, "cell"); return r.match(Cell, { id }).find({ id, k: ${c.source} }) }).attach("c", (p) => query(Agree).rule((r) => { const { id } = v(Cell, "cell"); return r.match(Cell, { id, ${col}: p.k }).find({ id }) }), "array")`
				],
				verdict: compiles(
					() =>
						queryOver(Agree)
							.rule((r: RuleValue) => {
								const vars = varsOver(Cell, "cell")
								return r.match(Cell, { id: vars["id"] }).find({ id: vars["id"], k: c.value() })
							})
							.attach(
								"c",
								(p: Readonly<Record<string, unknown>>) =>
									queryOver(Agree).rule((r: RuleValue) => {
										const vars = varsOver(Cell, "cell")
										return r.match(Cell, { id: vars["id"], [col]: p["k"] }).find({ id: vars["id"] })
									}),
								"array"
							),
					"rows"
				)
			}
		case "selfJoinAttachParent":
			return {
				lines: [
					`export const ${name} = query(Agree).rule((r) => { const cell = v(Cell, "cell"); const peer = v(Cell, "peer"); return r.match(Cell, { id: cell.id }).match(Cell, { id: peer.id }).find({ cell: cell.id, peer: peer.id, k: ${c.source} }) }).attach("c", (p) => query(Agree).rule((r) => r.match(Cell, { id: p.peer, ${col}: p.k }).find({ found: true })), "option")`
				],
				verdict: compiles(
					() =>
						queryOver(Agree)
							.rule((r: RuleValue) => {
								const cell = varsOver(Cell, "cell")
								const peer = varsOver(Cell, "peer")
								return r
									.match(Cell, { id: cell["id"] })
									.match(Cell, { id: peer["id"] })
									.find({ cell: cell["id"], peer: peer["id"], k: c.value() })
							})
							.attach(
								"c",
								(p: Readonly<Record<string, unknown>>) =>
									queryOver(Agree).rule((r: RuleValue) =>
										r.match(Cell, { id: p["peer"], [col]: p["k"] }).find({ found: true })
									),
								"option"
							),
					"rows"
				)
			}
		case "pageOrderKey":
			return {
				lines: [
					`export const ${name} = query(Agree).rule((r) => { const { id } = v(Cell, "cell"); return r.match(Cell, { id }).find({ id, k: ${c.source} }) }).orderBy(["k", "asc"])`
				],
				verdict: compiles(
					() =>
						queryOver(Agree)
							.rule((r: RuleValue) => {
								const vars = varsOver(Cell, "cell")
								return r.match(Cell, { id: vars["id"] }).find({ id: vars["id"], k: c.value() })
							})
							.orderBy(["k", "asc"]),
					"page"
				)
			}
		case "checkRow":
			return {
				lines: [
					`export const ${name} = check(${jsonText(name)}, Cell, (p) => p.eq(p.${col}, ${c.source}))`
				],
				verdict: () =>
					Result.flatMap(
						catchCompileError(() =>
							check(name, Cell, (row: unknown) => computeCore.eq(rowField(row, col), c.value()))
						),
						(made) => testArtifacts(schema("AgreeCheck", [Tone, Shade, Cell], [made]), testCompile)
					).ok
			}
		case "computedBinding":
			return {
				lines: [
					`export const ${name} = query(Agree).rule((r) => { ${Str.replace("return ", 'const peer = v(Cell, "peer"); return ')(matched)}.match(Cell, { id: peer.id, ${col}: Num.add(x, ${c.source}) }).find({ id }) })`
				],
				verdict: compiles(
					() =>
						queryOver(Agree).rule((r: RuleValue) => {
							const cell = varsOver(Cell, "cell")
							const peer = varsOver(Cell, "peer")
							return r
								.match(Cell, { id: cell["id"], [col]: cell[col] })
								.match(Cell, { id: peer["id"], [col]: computeCore.add(cell[col], c.value()) })
								.find({ id: cell["id"] })
						}),
					"rows"
				)
			}
		case "paramBinding": {
			const inner = () =>
				queryOver(Agree).rule((r: RuleValue) => {
					const vars = varsOver(Cell, "cell")
					return r
						.match(Cell, { id: vars["id"], [col]: r.param("p", Cell.fields[col]) })
						.find({ id: vars["id"] })
				})
			return {
				lines: [
					`const q${i} = query(Agree).rule((r) => { const { id } = v(Cell, "cell"); return r.match(Cell, { id, ${col}: r.param("p", Cell.fields.${col}) }).find({ id }) })`,
					`export const ${name} = query(Agree).rule((r) => { const { id } = v(Cell, "cell"); return r.match(Cell, { id }).match(q${i}.bind({ p: ${c.source} }), { id }).find({ id }) })`
				],
				verdict: compiles(() => {
					const imported = inner()
					return queryOver(Agree).rule((r: RuleValue) => {
						const vars = varsOver(Cell, "cell")
						return r
							.match(Cell, { id: vars["id"] })
							.match(imported.bind({ p: c.value() }), { id: vars["id"] })
							.find({ id: vars["id"] })
					})
				}, "rows")
			}
		}
		case "deadFilter": {
			const arm = (r: RuleValue) => {
				const vars = varsOver(Cell, "cell")
				return r.match(Cell, { id: vars["id"] }).find({ id: vars["id"], d: c.value() })
			}
			const armSource = `(r) => { const { id } = v(Cell, "cell"); return r.match(Cell, { id }).find({ id, d: ${c.source} }) }`
			return {
				lines: [
					`const u${i} = query(Agree).rule(${armSource}).rule(${armSource})`,
					`export const ${name} = query(Agree).rule((r) => { const { id } = v(u${i}, "union"); return r.match(u${i}, { id, d: ${other.source} }).find({ id }) })`
				],
				verdict: compiles(() => {
					const union = queryOver(Agree).rule(arm).rule(arm)
					return queryOver(Agree).rule((r: RuleValue) => {
						const vars = varsOver(union, "union")
						return r.match(union, { id: vars["id"], d: other.value() }).find({ id: vars["id"] })
					})
				}, "rows")
			}
		}
		case "heteroArms":
		case "heteroClash": {
			const second = position === "heteroArms" ? other : c
			return {
				lines: [
					`export const ${name} = query(Agree).rule(${ownArmSource(c, [], "integer", "n")}).rule(${ownArmSource(second, [], "bigint", "b")})`
				],
				verdict: compiles(
					() =>
						queryOver(Agree)
							.rule(ownArm(c, [], "integer", "n"))
							.rule(ownArm(second, [], "bigint", "b")),
					"rows"
				)
			}
		}
		case "threeArms":
		case "threeArmsClash": {
			const third: ReadonlyArray<readonly [string, number]> =
				position === "threeArms" ? [["e", 1]] : []
			return {
				lines: [
					`export const ${name} = query(Agree).rule(${ownArmSource(c, [["e", 1]], "integer", "n")}).rule(${ownArmSource(c, [["e", 2]], "bigint", "b")}).rule(${ownArmSource(other, third, "text", "t")})`
				],
				verdict: compiles(
					() =>
						queryOver(Agree)
							.rule(ownArm(c, [["e", 1]], "integer", "n"))
							.rule(ownArm(c, [["e", 2]], "bigint", "b"))
							.rule(ownArm(other, third, "text", "t")),
					"rows"
				)
			}
		}
		case "attachedArm":
			return {
				lines: [
					`export const ${name} = query(Agree).rule(${plainArmSource(c, [])}).rule(${attachedArmSource(other, [])})`
				],
				verdict: compiles(
					() => queryOver(Agree).rule(plainArm(c, [])).rule(attachedArm(other, [])),
					"rows"
				)
			}
		case "attachedArmApart":
			return keptAttachedStatement(name, [], c, other, [["e", 1]])
		case "attachedArmTaken":
			return keptAttachedStatement(name, ["take"], other, c, [])
		case "attachedArmNamed":
			return keptAttachedStatement(name, ["named"], other, c, [])
		case "attachedArmKept":
			return keptAttachedStatement(name, drawn(twoKept, draw), other, c, [])
		case "attachedArmKeptApart":
			return keptAttachedStatement(name, drawn(anyKept, draw), c, other, [["e", 1]])
		case "flaggedArm": {
			const union = (k: (x: unknown) => unknown) =>
				compiles(
					() =>
						queryOver(Agree)
							.rule((r: RuleValue) => {
								const vars = varsOver(Cell, "cell")
								return r
									.match(Cell, { id: vars["id"], [col]: vars[col] })
									.find({ id: vars["id"], k: k(vars[col]) })
							})
							.rule((r: RuleValue) => {
								const vars = varsOver(Cell, "cell")
								return r
									.match(Cell, { id: vars["id"], [col]: vars[col] })
									.find({ id: vars["id"], k: other.value() })
							}),
					"rows"
				)
			const asVariable = union((x) => x)
			const asConstant = union(() => c.value())
			return {
				lines: [
					`export const ${name} = query(Agree).rule((r) => { ${matched}.find({ id, k: flag ? x : ${c.source} }) }).rule((r) => { ${matched}.find({ id, k: ${other.source} }) })`
				],
				verdict: () => asVariable() && asConstant()
			}
		}
	}
}

/** The kinds whose value the types carry, a primitive JavaScript value or a handle (see the header). */
const valued: ReadonlyArray<ConstantKind> = [
	"text",
	"integer",
	"bigint",
	"boolean",
	"uuid",
	"handle",
	"wrongRoster"
]

/**
 * The kinds a position draws: every kind, but where a flagged arm holds the constant none refused where it stands, a
 * handle off its roster, which its roster refuses whatever union it is in; where a head holds the constant only those a head holds, where the
 * verdict turns on two constants being one value only those whose value the types carry (see the header), in a
 * check's predicate, which is no rule's and so has no r.param to declare one, no parameter, and at a discriminant,
 * whose two arms hold two constants of one kind, no parameter: two drawn parameters are of two descriptors, so their
 * arms would differ in type, the union's own refusal.
 */
const kindsAt = (position: AdmissionPosition): ReadonlyArray<ConstantKind> => {
	switch (position) {
		case "discriminant":
			return Arr.filter(constantKinds, (k) => k !== "vector" && k !== "param" && k !== "otherParam")
		case "heteroArms":
		case "threeArms":
			return Arr.filter(constantKinds, (k) => k !== "vector")
		case "flaggedArm":
			return Arr.filter(constantKinds, (k) => k !== "vector" && k !== "offRoster")
		case "deadFilter":
		case "heteroClash":
		case "threeArmsClash":
		case "attachedArm":
		case "attachedArmApart":
		case "attachedArmTaken":
		case "attachedArmNamed":
		case "attachedArmKept":
		case "attachedArmKeptApart":
			return valued
		case "binding":
		case "unionBinding":
		case "selfJoinBinding":
		case "selfJoinOperand":
		case "secondOperand":
		case "firstOperand":
		case "computeSecond":
		case "computeFirst":
		case "condThen":
		case "condElse":
		case "head":
		case "attachParent":
		case "selfJoinAttachParent":
		case "pageOrderKey":
		case "paramBinding":
		case "computedBinding":
			return constantKinds
		case "checkRow":
			return Arr.filter(constantKinds, (k) => k !== "param" && k !== "otherParam")
	}
}

/**
 * One cell of the matrix as the program states it, named by `id`: its statement under every pick of its kind's values
 * and of the stages it keeps an arm under, each pick's statement once, its verdict the engine's, its lines under the
 * directive its refusal raises. The picks run until a statement repeats one already stated: the constant and the
 * stages each repeat with their roster's length, so the first repeat closes a whole period of both.
 */
const matrixLines = (
	position: AdmissionPosition,
	kind: ConstantKind,
	id: string
): ReadonlyArray<string> => {
	const statementAt = (pick: number, name: string): Statement =>
		statementOf(position, constantOf(kind, pick), constantOf(kind, pick + 1), pick, name)
	const sameStatement = (a: Statement, b: Statement): boolean =>
		Arr.join(a.lines, "\n") === Arr.join(b.lines, "\n")
	const picks: Array<number> = []
	const stated: Array<Statement> = []
	for (let pick = 0; ; pick += 1) {
		const statement = statementAt(pick, "")
		if (Arr.some(stated, (earlier) => sameStatement(earlier, statement))) {
			break
		}
		picks.push(pick)
		stated.push(statement)
	}
	return Arr.flatMap(picks, (pick) => {
		const statement = statementAt(pick, `${id}_${pick}`)
		const admitted = statement.verdict()
		const [first, ...rest] = Arr.reverse(statement.lines)
		return [
			`/** ${kind} at ${position}, pick ${pick} of its constant and stages: the engine ${admitted ? "admits" : "refuses"} it. */`,
			...(admitted ? statement.lines : [...Arr.reverse(rest), directiveOf(position, kind), first])
		]
	})
}

/** The shapes a combinator stands over: one rule, a union of one heading, a union of several, an attached rule. */
const shapeBases = ["plain", "union", "heterogeneous", "attached"] as const
export type ShapeBase = (typeof shapeBases)[number]

/** What stands between a shape and the combinator over it: nothing, or a kept stage. */
const shapeWrappers = ["bare", "named", "take"] as const
export type ShapeWrapper = (typeof shapeWrappers)[number]

/** Every combinator over a query: its stages, a page of it, and a further arm of its heading or of another. */
const combinators = [
	"take",
	"page",
	"orderBy",
	"approximateNearest",
	"attach",
	"named",
	"unionArm",
	"unionArmApart"
] as const
export type Combinator = (typeof combinators)[number]

/** A query of the axis: its source in the program, and its value through the builder's JavaScript view. */
interface Shaped {
	readonly source: string
	readonly value: () => QueryValue
}

/** An arm of the axis: its source in the program, and its rule through the builder's JavaScript view. */
interface ShapedArm {
	readonly source: string
	readonly rule: (r: RuleValue) => unknown
}

/**
 * An arm over Cell holding Cell's id, d, the cosine distance s of the Cell's vector to one query vector, which an
 * approximate search ranks by, and each further constant under its field.
 */
const scoredArm = (d: string, more: ReadonlyArray<readonly [string, number]>): ShapedArm => ({
	source: `(r) => { const { id, vector } = v(Cell, "cell"); return r.match(Cell, { id, vector }).find({ id, d: ${jsonText(d)}, s: Distance.cosine(vector, Vector.make(Float32Array.of(0.5, 1, 2), 3))${Arr.join(
		Arr.map(more, ([field, value]) => `, ${field}: ${value}`),
		""
	)} }) }`,
	rule: (r) => {
		const vars = varsOver(Cell, "cell")
		return r.match(Cell, { id: vars["id"], vector: vars["vector"] }).find({
			id: vars["id"],
			d,
			s: computeCore.cosineDistance(vars["vector"], vector(1)()),
			...Rec.fromEntries(more)
		})
	}
})

/** The child of an attachment named `name`: the Cell its parent's id keys, heading the parent field `at` when given. */
const cellAttachment = (name: string, at: string | undefined): StageOver => ({
	source: `.attach(${jsonText(name)}, (p) => query(Agree).rule((q) => q.match(Cell, { id: p.id }).find({ found: true${at === undefined ? "" : `, at: p.${at}`} })), "array")`,
	over: (q) =>
		q.attach(
			name,
			(p: Readonly<Record<string, unknown>>) =>
				queryOver(Agree).rule((c: RuleValue) =>
					c
						.match(Cell, { id: p["id"] })
						.find(at === undefined ? { found: true } : { found: true, at: p[at] })
				),
			"array"
		)
})

/** A shape's base: one scored arm, two of one heading, two of two headings told apart by d, or one attached. */
const shapeBase = (base: ShapeBase): Shaped => {
	const a = scoredArm("a", [])
	switch (base) {
		case "plain":
			return {
				source: `query(Agree).rule(${a.source})`,
				value: () => queryOver(Agree).rule(a.rule)
			}
		case "union":
		case "heterogeneous": {
			const b = scoredArm("b", base === "union" ? [] : [["e", 1]])
			return {
				source: `query(Agree).rule(${a.source}).rule(${b.source})`,
				value: () => queryOver(Agree).rule(a.rule).rule(b.rule)
			}
		}
		case "attached": {
			const c = cellAttachment("c", undefined)
			return {
				source: `query(Agree).rule(${a.source})${c.source}`,
				value: () => c.over(queryOver(Agree).rule(a.rule))
			}
		}
	}
}

/** A shape: its base under its wrapper. */
const shapeOf = (base: ShapeBase, wrapper: ShapeWrapper): Shaped => {
	const shape = shapeBase(base)
	switch (wrapper) {
		case "bare":
			return shape
		case "named":
		case "take": {
			const stage = keptStage(wrapper, 0)
			return { source: `${shape.source}${stage.source}`, value: () => stage.over(shape.value()) }
		}
	}
}

/**
 * The field orderBy orders a shape by: d, which every record of a plain or one-heading shape delivers, and otherwise
 * the name some record holds that the shape does not deliver as a column, an arm's own field or an attachment.
 */
const orderedBy = (base: ShapeBase): string => {
	switch (base) {
		case "plain":
		case "union":
			return "d"
		case "heterogeneous":
			return "e"
		case "attached":
			return "c"
	}
}

/** The parent field an attachment's child heads: d, except over a union of several headings its one arm's own e. */
const parentField = (base: ShapeBase): string => {
	switch (base) {
		case "plain":
		case "union":
		case "attached":
			return "d"
		case "heterogeneous":
			return "e"
	}
}

/** A combinator over a query: what it appends to the query's source and value, and how the engine reads the result. */
interface Applied {
	readonly line: (name: string, shape: string) => string
	readonly build: (shape: QueryValue) => unknown
	readonly read: "rows" | "page"
}

/** The combinator over a shape of base `base`. */
const applied = (combinator: Combinator, base: ShapeBase): Applied => {
	const rows = (stage: StageOver): Applied => ({
		line: (name, shape) => `export const ${name} = ${shape}${stage.source}`,
		build: stage.over,
		read: "rows"
	})
	switch (combinator) {
		case "take":
			return rows({
				source: '.orderBy(["id", "asc"]).take(3)',
				over: (q) => q.orderBy(["id", "asc"]).take(3)
			})
		case "page":
			return {
				line: (name, shape) =>
					`export const ${name}_p = paged(${shape}.orderBy(["id", "asc"])); export const ${name} = (h: WorkloadHandles<typeof Reader, { readonly p: typeof ${name}_p }>["p"]) => h.once({ params: {}, facts: {}, window: { anchor: { kind: "start" }, size: 10 } })`,
				build: (q) => q.orderBy(["id", "asc"]),
				read: "page"
			}
		case "orderBy": {
			const field = orderedBy(base)
			return {
				line: (name, shape) =>
					`export const ${name} = ${shape}.orderBy([${jsonText(field)}, "desc"])`,
				build: (q) => q.orderBy([field, "desc"]),
				read: "rows"
			}
		}
		case "approximateNearest":
			return rows({
				source: '.approximateNearest({ by: "s", take: 3 })',
				over: (q) => q.approximateNearest({ by: "s", take: 3 })
			})
		case "attach":
			return rows(cellAttachment("k", parentField(base)))
		case "named":
			return rows(keptStage("named", 1))
		case "unionArm":
		case "unionArmApart": {
			const arm = scoredArm("z", combinator === "unionArm" ? [] : [["f", 1]])
			return rows({ source: `.rule(${arm.source})`, over: (q) => q.rule(arm.rule) })
		}
	}
}

/**
 * The refusal of a union of several headings under a take, which the types name for an arm over it, a second take
 * and a page alike (types/query/query.ts GroupedArm, OneTakeOverGroups, PageOverGroups).
 */
const groupsTaken = (base: ShapeBase, wrapper: ShapeWrapper): boolean =>
	base === "heterogeneous" && wrapper === "take"

/** The refusal the types name for an approximate search over a shape (types/query/query.ts SearchSource). */
const searchRefusal = (base: ShapeBase, wrapper: ShapeWrapper): Refused | undefined => {
	switch (wrapper) {
		case "take":
			return "approximateNearest over one rule's projection; this source is a bounded subset, whose own order already selects among the rows"
		case "bare":
		case "named":
			switch (base) {
				case "plain":
					return undefined
				case "union":
				case "heterogeneous":
					return "approximateNearest over one rule's projection; this source is a union of rules, which no single index orders"
				case "attached":
					return "approximateNearest over one rule's projection; this source is a query with attachments"
			}
	}
}

/**
 * The refusal the types name for a combinator over a shape where they refuse it; none where the refusal is structural,
 * a field no order or parent variable has, or a call's argument.
 */
const combinatorRefusal = (
	combinator: Combinator,
	base: ShapeBase,
	wrapper: ShapeWrapper
): Refused | undefined => {
	switch (combinator) {
		case "take":
			return groupsTaken(base, wrapper)
				? "one take over a union of several headings: each heading group is a statement of its own, which one take bounds and the merge across them keeps"
				: undefined
		case "page":
			return groupsTaken(base, wrapper)
				? "a page over a bounded heterogeneous union: a group statement cannot tell which of its rows are among the union's first k"
				: undefined
		case "orderBy":
		case "attach":
		case "named":
			return undefined
		case "approximateNearest":
			return searchRefusal(base, wrapper)
		case "unionArm":
			return groupsTaken(base, wrapper)
				? "an arm over a union of several headings: only a query's result delivers each heading group"
				: base === "attached"
					? "an attachment on an arm of a union whose heading several arms share"
					: undefined
		case "unionArmApart":
			return groupsTaken(base, wrapper)
				? "an arm over a union of several headings: only a query's result delivers each heading group"
				: base === "union" && wrapper === "take"
					? "arms of different headings share a field that holds a different constant in each"
					: undefined
	}
}

/**
 * One cell of the combinator axis, named by `id`: its combinator over its shape under its wrapper, the engine's
 * verdict, its line under a directive where the engine refuses.
 */
const combinatorLines = (
	combinator: Combinator,
	base: ShapeBase,
	wrapper: ShapeWrapper,
	id: string
): ReadonlyArray<string> => {
	const shape = shapeOf(base, wrapper)
	const combined = applied(combinator, base)
	const admitted = compiles(() => combined.build(shape.value()), combined.read)()
	const line = combined.line(`n${id}`, shape.source)
	const refusal = combinatorRefusal(combinator, base, wrapper)
	const directive =
		refusal === undefined
			? `// @ts-expect-error -- refused: the engine refuses ${combinator} over ${base} under ${wrapper}`
			: `// @ts-expect-error -- refusal: ${refusal}`
	return [
		`/** ${combinator} over ${base} under ${wrapper}: the engine ${admitted ? "admits" : "refuses"} it. */`,
		...(admitted ? [line] : [directive, line])
	]
}

/**
 * The level a matched query is written over, beside the schema of the rule that matches it: the rule's own, one below
 * it (the rule over AgreeAbove, an extension of Agree, the query over Agree), one above it (the query over AgreeAbove,
 * the rule over Agree), or one apart (the rule over Apart, which holds Cell but is no level of Agree).
 */
const matchedLevels = ["own", "below", "above", "apart"] as const
type MatchedLevel = (typeof matchedLevels)[number]

/** How a rule reads the query it matches: the query as it is, or bound through Q.bind. */
const matchedForms = ["query", "bound"] as const
type MatchedForm = (typeof matchedForms)[number]

/**
 * What a relation parameter of an imported query is bound to: the importing rule's own relation parameter, a query, a
 * bound query or an interior stage of the importing rule.
 */
const relationSources = ["relationParam", "query", "boundQuery", "interior"] as const
type RelationSource = (typeof relationSources)[number]

/**
 * The levels of a binding cell: the import's, the bound query's and the importing rule's. All three over Agree ("own");
 * the bound query over AgreeAbove, a schema the import's is a level of, and the rule over it ("above"); the import over
 * AgreeAbove and the bound query over Agree, a level of the import's ("below"); the bound query over Apart, of which
 * Agree is no level nor it one of Agree, and the rule over it ("apart"); the bound query over AgreeAbove and the rule
 * over Agree, which matches the bound import, over AgreeAbove, a level above its own ("aboveRule"). A relation
 * parameter of the importing rule and an interior stage are bound at "own" alone: they are of no level of their own.
 */
const bindLevels = ["own", "above", "below", "apart", "aboveRule"] as const
type BindLevel = (typeof bindLevels)[number]

/** The levels a source of a relation parameter is bound at (bindLevels): a query's every one, any other's its own. */
const bindLevelsOf = (source: RelationSource): Arr.NonEmptyReadonlyArray<BindLevel> =>
	source === "query" || source === "boundQuery" ? bindLevels : ["own"]

/** A schema of the scope cells: its name in the program, and its value. */
interface Over {
	readonly source: string
	readonly value: unknown
}
const agreeOver: Over = { source: "Agree", value: Agree }
const aboveOver: Over = { source: "AgreeAbove", value: AgreeAbove }
const apartOver: Over = { source: "Apart", value: Apart }

/** The schema a matched query of a level is written over, and the one the rule that matches it is over. */
const oversOf = (level: MatchedLevel): { readonly query: Over; readonly rule: Over } => {
	switch (level) {
		case "own":
			return { query: agreeOver, rule: agreeOver }
		case "below":
			return { query: agreeOver, rule: aboveOver }
		case "above":
			return { query: aboveOver, rule: agreeOver }
		case "apart":
			return { query: agreeOver, rule: apartOver }
	}
}

/** Cell's ids over a schema, as it is or under an integer parameter p, which Q.bind binds to 1. */
const matchedOf = (
	over: Over,
	form: MatchedForm
): { readonly source: string; readonly value: () => unknown } => {
	switch (form) {
		case "query":
			return {
				source: `query(${over.source}).rule((r) => { const { id } = v(Cell, "cell"); return r.match(Cell, { id }).find({ id }) })`,
				value: () =>
					queryOver(over.value).rule((r: RuleValue) => {
						const vars = varsOver(Cell, "cell")
						return r.match(Cell, { id: vars["id"] }).find({ id: vars["id"] })
					})
			}
		case "bound":
			return {
				source: `query(${over.source}).rule((r) => { const { id } = v(Cell, "cell"); return r.match(Cell, { id, integer: r.param("p", Cell.fields.integer) }).find({ id }) }).bind({ p: 1 })`,
				value: () =>
					queryOver(over.value)
						.rule((r: RuleValue) => {
							const vars = varsOver(Cell, "cell")
							return r
								.match(Cell, { id: vars["id"], integer: r.param("p", Cell.fields.integer) })
								.find({ id: vars["id"] })
						})
						.bind({ p: 1 })
			}
	}
}

/**
 * Cell's ids keyed by a relation parameter of ids, over a schema: the query whose parameter the relation cells bind,
 * `byIds` over Agree and `byIdsAbove` over AgreeAbove, each stated once in the program, a batch's own.
 */
interface ByIds {
	readonly name: string
	readonly over: Over
}
const byIdsAgree: ByIds = { name: "byIds", over: agreeOver }
const byIdsAbove: ByIds = { name: "byIdsAbove", over: aboveOver }

/** A ByIds query's statement in the program. */
const byIdsSource = (q: ByIds): string =>
	`export const ${q.name} = query(${q.over.source}).rule((r) => { const ids = r.relation("ids", { id: Id }); const { id } = v(Cell, "cell"); return r.match(ids, { id }).match(Cell, { id }).find({ id }) })`

/** A ByIds query's value, as its statement builds it. */
const byIdsValue = (q: ByIds): QueryValue =>
	queryOver(q.over.value).rule((r: RuleValue) => {
		const ids = r.relation("ids", { id: Id })
		const vars = varsOver(Cell, "cell")
		return r.match(ids, { id: vars["id"] }).match(Cell, { id: vars["id"] }).find({ id: vars["id"] })
	})

/** The schemas of a binding cell at a level (bindLevels): the import's, the bound query's and the importing rule's. */
const bindOversOf = (
	level: BindLevel
): { readonly imported: ByIds; readonly bound: Over; readonly rule: Over } => {
	switch (level) {
		case "own":
			return { imported: byIdsAgree, bound: agreeOver, rule: agreeOver }
		case "above":
			return { imported: byIdsAgree, bound: aboveOver, rule: aboveOver }
		case "below":
			return { imported: byIdsAbove, bound: agreeOver, rule: aboveOver }
		case "apart":
			return { imported: byIdsAgree, bound: apartOver, rule: apartOver }
		case "aboveRule":
			return { imported: byIdsAgree, bound: aboveOver, rule: agreeOver }
	}
}

/**
 * What a relation parameter is bound to, inside the importing rule: its source, and its value under that rule, a
 * query's over `over`.
 */
const relationSourceOf = (
	source: RelationSource,
	over: Over
): { readonly source: string; readonly value: (r: RuleValue) => unknown } => {
	const cellIds = matchedOf(over, "query")
	const boundIds = matchedOf(over, "bound")
	switch (source) {
		case "relationParam":
			return {
				source: 'r.relation("outer", { id: Id })',
				value: (r) => r.relation("outer", { id: Id })
			}
		case "query":
			return { source: cellIds.source, value: () => cellIds.value() }
		case "boundQuery":
			return { source: boundIds.source, value: () => boundIds.value() }
		case "interior":
			return {
				source:
					'r.interior((s) => { const { id } = v(Cell, "inner"); return s.match(Cell, { id }).find({ id }) })',
				value: (r) =>
					r.interior((s: RuleValue) => {
						const vars = varsOver(Cell, "inner")
						return s.match(Cell, { id: vars["id"] }).find({ id: vars["id"] })
					})
			}
	}
}

/**
 * What ChangeSet.bind binds a write's parameters to, the write axis: its relation parameter `ids` to a query or a bound
 * query of its rows; to a bound query whose bind map binds the query's `p` to a parameter `q` of the call's
 * (callerBoundQuery), which the write then needs beside its own `p`; to a query whose own parameter `p` joins the
 * write's `p` at its type (joiningQuery) or clashes with it at another (clashingQuery); to a query of a parameter `q`
 * of its own, the write's `p` bound to a value beside it (valueBeside); to a query delivering a field beside the
 * parameter's heading (widerQuery); or the write's scalar parameter `p` to a query (scalar).
 */
const writeBounds = [
	"query",
	"boundQuery",
	"callerBoundQuery",
	"joiningQuery",
	"clashingQuery",
	"valueBeside",
	"widerQuery",
	"scalar"
] as const
type WriteBound = (typeof writeBounds)[number]

/**
 * The levels of a write cell: the write's and the bound query's. Both over Agree ("own"); the query over AgreeAbove
 * ("above"), the bound write then over it; the write over AgreeAbove and the query over Agree, a level of it ("below");
 * the query over Apart, neither a level of the other ("apart").
 */
const writeLevels = ["own", "above", "below", "apart"] as const
type WriteLevel = (typeof writeLevels)[number]

/** The levels a write cell binds at (writeLevels): a query's and a bound query's every one, any other's its own. */
const writeLevelsOf = (bound: WriteBound): Arr.NonEmptyReadonlyArray<WriteLevel> =>
	bound === "query" || bound === "boundQuery" ? writeLevels : ["own"]

/**
 * A write whose rule matches the relation parameter `ids` and compares Note's k with its scalar parameter `p`, over a
 * schema: `idsWrite` over Agree and `idsWriteAbove` over AgreeAbove, each stated once in the program, a batch's own.
 */
interface IdsWrite {
	readonly name: string
	readonly over: Over
}
const idsWriteAgree: IdsWrite = { name: "idsWrite", over: agreeOver }
const idsWriteAbove: IdsWrite = { name: "idsWriteAbove", over: aboveOver }

/** An IdsWrite's statement in the program. */
const idsWriteSource = (w: IdsWrite): string =>
	`export const ${w.name} = ChangeSet.empty(${w.over.source}).delete(Note, query(${w.over.source}).rule((r) => { const ids = r.relation("ids", { id: Id }); const { id } = v(ids, "ids"); const { k } = v(Note, "note"); return r.match(ids, { id }).match(Note, { item: id, k }).where(r.eq(k, r.param("p", Cell.fields.integer))).find({ item: id, k }) }))`

/** An IdsWrite's value, as its statement builds it. */
const idsWriteValue = (w: IdsWrite): ChangeSetValue =>
	changeSetOver.empty(w.over.value).delete(
		Note,
		queryOver(w.over.value).rule((r: RuleValue) => {
			const ids = r.relation("ids", { id: Id })
			const i = varsOver(ids, "ids")
			const note = varsOver(Note, "note")
			return r
				.match(ids, { id: i["id"] })
				.match(Note, { item: i["id"], k: note["k"] })
				.where(r.eq(note["k"], r.param("p", Cell.fields.integer)))
				.find({ item: i["id"], k: note["k"] })
		})
	)

/** The schemas of a write cell at a level (writeLevels): the write's and the bound query's. */
const writeOversOf = (level: WriteLevel): { readonly write: IdsWrite; readonly bound: Over } => {
	switch (level) {
		case "own":
			return { write: idsWriteAgree, bound: agreeOver }
		case "above":
			return { write: idsWriteAgree, bound: aboveOver }
		case "below":
			return { write: idsWriteAbove, bound: agreeOver }
		case "apart":
			return { write: idsWriteAgree, bound: apartOver }
	}
}

/** Cell's ids over `over`, `name` a parameter of its own at the field `field` of Cell. */
const ownParamIds = (
	over: Over,
	field: "integer" | "text",
	name: "p" | "q"
): { readonly source: string; readonly value: () => QueryValue } => ({
	source: `query(${over.source}).rule((r) => { const { id } = v(Cell, "cell"); return r.match(Cell, { id, ${field}: r.param("${name}", Cell.fields.${field}) }).find({ id }) })`,
	value: () =>
		queryOver(over.value).rule((r: RuleValue) => {
			const vars = varsOver(Cell, "cell")
			return r
				.match(Cell, { id: vars["id"], [field]: r.param(name, Cell.fields[field]) })
				.find({ id: vars["id"] })
		})
})

/** A parameter a write cell's bind map binds: its name, and the source and value it is bound to. */
interface WriteEntry {
	readonly param: string
	readonly source: string
	readonly value: () => unknown
}

/** What a write cell binds and to what (writeBounds): each parameter's name, and its source and value over `over`. */
const writeBoundOf = (bound: WriteBound, over: Over): Arr.NonEmptyReadonlyArray<WriteEntry> => {
	switch (bound) {
		case "query":
			return [{ param: "ids", ...matchedOf(over, "query") }]
		case "boundQuery":
			return [{ param: "ids", ...matchedOf(over, "bound") }]
		case "callerBoundQuery": {
			const own = ownParamIds(over, "integer", "p")
			return [
				{
					param: "ids",
					source: `${own.source}.bind({ p: param("q", Cell.fields.integer) })`,
					value: () => own.value().bind({ p: hostParam.term("q", Cell.fields.integer, "param(q)") })
				}
			]
		}
		case "joiningQuery":
			return [{ param: "ids", ...ownParamIds(over, "integer", "p") }]
		case "clashingQuery":
			return [{ param: "ids", ...ownParamIds(over, "text", "p") }]
		case "valueBeside":
			return [
				{ param: "p", source: "1", value: () => 1 },
				{ param: "ids", ...ownParamIds(over, "integer", "q") }
			]
		case "widerQuery":
			return [
				{
					param: "ids",
					source: `query(${over.source}).rule((r) => { const { id, integer } = v(Cell, "cell"); return r.match(Cell, { id, integer }).find({ id, integer }) })`,
					value: () =>
						queryOver(over.value).rule((r: RuleValue) => {
							const vars = varsOver(Cell, "cell")
							return r
								.match(Cell, { id: vars["id"], integer: vars["integer"] })
								.find({ id: vars["id"], integer: vars["integer"] })
						})
				}
			]
		case "scalar":
			return [{ param: "p", ...matchedOf(over, "query") }]
	}
}

/** One cell of the scope axis: what it reaches, the engine's verdict, and its lines. */
interface ScopeCell {
	readonly what: string
	readonly admitted: boolean
	readonly lines: ReadonlyArray<string>
}

/**
 * The engine's verdict on a scope cell's statement, built and compiled as the runtime does: where it admits it, the
 * parameters a call of it supplies, a query's every declared one, a write's every one its bind map leaves free; where it
 * refuses it, the refusal the types name for its reason: a query over no level of the rule's schema (ForeignLevel), the
 * level axis's and a binding's whose bound import stands above its rule; and a relation parameter's binding the engine
 * refuses by a named rule (Refused): no relation-valued term, or a query over a level apart from the import's. Any
 * other refusal is the generator's defect.
 */
const scopeVerdict = (
	axis: ScopeAxis,
	what: string,
	build: () => unknown
):
	| { readonly admitted: true; readonly params: ReadonlyArray<string> }
	| { readonly admitted: false; readonly refusal: Refused } => {
	const compiled = Result.flatMap(catchCompileError(build), (built) =>
		axis === "write"
			? Result.map(
					compileChangeSet(
						checking(AgreeAbove),
						defined(changeSetDesc(built), "a write cell builds a ChangeSet"),
						frontendOptions(AgreeAbove)
					),
					(write) =>
						Arr.map(
							Arr.filter(write.params, (p) => !Arr.contains(write.bindings, p.name)),
							(p) => p.name
						)
				)
			: Result.map(
					compileTemplate(built, undefined, { ...testCompile, read: "rows" }),
					(template) => Arr.map(template.params, (p) => p.name)
				)
	)
	if (compiled.ok) {
		return { admitted: true, params: compiled.value }
	}
	const reason = compiled.error.reason
	switch (axis) {
		case "level":
			if (reason._tag === "ForeignLevel") {
				return { admitted: false, refusal: "the query is not over a level of this query's schema" }
			}
			break
		case "binding":
			if (reason._tag === "ForeignLevel") {
				return { admitted: false, refusal: "the query is not over a level of this query's schema" }
			}
			if (reason._tag === "Refused") {
				return { admitted: false, refusal: reason.refusal }
			}
			break
		case "write":
			if (reason._tag === "Refused") {
				return { admitted: false, refusal: reason.refusal }
			}
			if (
				reason._tag === "MalformedDescription" &&
				Str.startsWith("compatible uses of parameter")(reason.what)
			) {
				return {
					admitted: false,
					refusal:
						"a bound query's parameter is the ChangeSet's parameter of its name, at its one type"
				}
			}
			break
		case "negation":
			if (reason._tag === "UnsupportedOperation" && reason.at.label !== "Query.bind") {
				return {
					admitted: false,
					refusal: "relational negation is a rule-level filter, alone or in a top-level conjunction"
				}
			}
			break
	}
	throw new Error(
		`the engine refuses the scope cell ${what} for no reason of its axis: ${reason._tag}`
	)
}

/** What a scope cell holds to the engine's reason: a match's level, a relation binding, a negation's place. */
type ScopeAxis = "level" | "binding" | "write" | "negation"

/**
 * Where a relational negation stands in a rule's filters: alone, in a conjunction there, the rule's or Logic's, in a
 * conjunction of one, in a disjunction, the rule's or Logic's, in a conjunction inside a disjunction, under Logic.not,
 * as a conditional's test, in the array a disjunction's list spreads, the rule's or Logic's, and in a conjunction beside
 * a disjunction whose list a spread array leads, the rule's or Logic's, qti-pie's E1_derived check (its pantry's
 * overlay-queries/expression.ts at 3ab19845, `p.or([...rootLanguages.map(…), p.and(…), p.and(…)])`), Logic's spread
 * holding a parameter.
 */
const negationPlaces = [
	"filter",
	"conjunction",
	"computeConjunction",
	"nestedConjunction",
	"disjunction",
	"computeDisjunction",
	"conjunctionInDisjunction",
	"computeNegation",
	"conditionalTest",
	"spreadInDisjunction",
	"spreadInComputeDisjunction",
	"besideSpreadLedDisjunction",
	"besideSpreadLedComputeDisjunction"
] as const
type NegationPlace = (typeof negationPlaces)[number]

/** A filter of Item's rule holding r.not(Note, ...) at a place: its source, and its value under that rule. */
const negationAt = (
	place: NegationPlace
): {
	readonly source: string
	readonly value: (r: RuleValue, id: unknown, n: unknown) => unknown
} => {
	const negation = (r: RuleValue, id: unknown) => r.not(Note, { item: id })
	switch (place) {
		case "filter":
			return { source: "r.not(Note, { item: id })", value: (r, id) => negation(r, id) }
		case "conjunction":
			return {
				source: "r.and([r.not(Note, { item: id }), r.eq(n, 1)])",
				value: (r, id, n) => r.and([negation(r, id), r.eq(n, 1)])
			}
		case "nestedConjunction":
			return {
				source: "r.and([r.and([r.not(Note, { item: id })]), r.eq(n, 1)])",
				value: (r, id, n) => r.and([r.and([negation(r, id)]), r.eq(n, 1)])
			}
		case "disjunction":
			return {
				source: "r.or([r.not(Note, { item: id }), r.eq(n, 1)])",
				value: (r, id, n) => r.or([negation(r, id), r.eq(n, 1)])
			}
		case "conjunctionInDisjunction":
			return {
				source: "r.or([r.and([r.not(Note, { item: id })]), r.eq(n, 1)])",
				value: (r, id, n) => r.or([r.and([negation(r, id)]), r.eq(n, 1)])
			}
		case "computeConjunction":
			return {
				source: "Logic.and([r.not(Note, { item: id }), r.eq(n, 1)])",
				value: (r, id, n) => computeCore.and([negation(r, id), r.eq(n, 1)])
			}
		case "computeDisjunction":
			return {
				source: "Logic.or([r.not(Note, { item: id }), r.eq(n, 1)])",
				value: (r, id, n) => computeCore.or([negation(r, id), r.eq(n, 1)])
			}
		case "computeNegation":
			return {
				source: "Logic.not(r.not(Note, { item: id }))",
				value: (r, id) => computeCore.not(negation(r, id))
			}
		case "conditionalTest":
			return {
				source: "r.eq(Logic.cond(r.not(Note, { item: id }), n, 0), 1)",
				value: (r, id, n) => r.eq(computeCore.cond(negation(r, id), n, 0), 1)
			}
		case "spreadInDisjunction":
			return {
				source: "r.or([...[id].map((i) => r.not(Note, { item: i })), r.eq(n, 1)])",
				value: (r, id, n) => r.or([...Arr.map([id], (i) => negation(r, i)), r.eq(n, 1)])
			}
		case "spreadInComputeDisjunction":
			return {
				source: "Logic.or([...[id].map((i) => r.not(Note, { item: i })), r.eq(n, 1)])",
				value: (r, id, n) => computeCore.or([...Arr.map([id], (i) => negation(r, i)), r.eq(n, 1)])
			}
		case "besideSpreadLedDisjunction":
			return {
				source:
					"r.and([r.not(Note, { item: id }), r.or([...[1, 2].map((k) => r.eq(n, k)), r.and([r.eq(n, 3), r.eq(n, 4)]), r.and([r.eq(n, 5), r.eq(n, 6)])])])",
				value: (r, id, n) =>
					r.and([
						negation(r, id),
						r.or([
							...Arr.map([1, 2], (k) => r.eq(n, k)),
							r.and([r.eq(n, 3), r.eq(n, 4)]),
							r.and([r.eq(n, 5), r.eq(n, 6)])
						])
					])
			}
		case "besideSpreadLedComputeDisjunction":
			return {
				source:
					'r.and([r.not(Note, { item: id }), Logic.or([...[r.param("p", Item.fields.n)].map((p) => r.eq(n, p)), Logic.and([r.eq(n, 3), r.eq(n, 4)]), Logic.and([r.eq(n, 5), r.eq(n, 6)])])])',
				value: (r, id, n) =>
					r.and([
						negation(r, id),
						computeCore.or([
							...Arr.map([r.param("p", Item.fields.n)], (p) => r.eq(n, p)),
							computeCore.and([r.eq(n, 3), r.eq(n, 4)]),
							computeCore.and([r.eq(n, 5), r.eq(n, 6)])
						])
					])
			}
	}
}

/**
 * A scope cell's lines: its statement `name`, `export const name = statement`, under the directive of its refusal where
 * the engine refuses it, and where it admits it, the statement's parameters held to the ones a call of it supplies.
 */
const scopeCellOf = (
	axis: ScopeAxis,
	what: string,
	name: string,
	statement: string,
	build: () => unknown
): ScopeCell => {
	const verdict = scopeVerdict(axis, what, build)
	const line = `export const ${name} = ${statement}`
	return {
		what,
		admitted: verdict.admitted,
		lines: verdict.admitted
			? [
					line,
					`export type ${name}Params = Expect<Equals<keyof ParamsOf<typeof ${name}>, ${namesType(verdict.params)}>>`
				]
			: [`// @ts-expect-error -- refusal: ${verdict.refusal}`, line]
	}
}

/** A union of parameter names, as a type: never for none. */
const namesType = (names: ReadonlyArray<string>): string =>
	Arr.match(names, {
		onEmpty: () => "never",
		onNonEmpty: (some) =>
			Arr.join(
				Arr.map(some, (n) => jsonText(n)),
				" | "
			)
	})

/**
 * One cell of the scope axis, named by `id`: a level a matched query may be written over against its rule's schema, as
 * it is or bound (matchedLevels, matchedForms), a source a relation parameter of an imported query may be bound to
 * (relationSources), or a place a relational negation stands (negationPlaces), its verdict the engine's, its refusal the
 * one the types name.
 */
const scopeLines = (cell: ScopeKey, id: string): ReadonlyArray<string> => {
	const scoped = ((): ScopeCell => {
		switch (cell.axis) {
			case "level": {
				const overs = oversOf(cell.level)
				const matched = matchedOf(overs.query, cell.form)
				return scopeCellOf(
					"level",
					`${cell.form === "bound" ? "a bound query" : "a query"} over the ${cell.level} level`,
					`l${id}`,
					`query(${overs.rule.source}).rule((r) => { const m = ${matched.source}; const { id } = v(m, "m"); return r.match(m, { id }).find({ id }) })`,
					() => {
						const m = matched.value()
						return queryOver(overs.rule.value).rule((r: RuleValue) => {
							const vars = varsOver(m, "m")
							return r.match(m, { id: vars["id"] }).find({ id: vars["id"] })
						})
					}
				)
			}
			case "write": {
				const overs = writeOversOf(cell.level)
				const entries = writeBoundOf(cell.bound, overs.bound)
				return scopeCellOf(
					"write",
					`a write's ${Arr.join(
						Arr.map(entries, (e) => e.param),
						" and "
					)} bound by ChangeSet.bind to: ${cell.bound} at ${cell.level}`,
					`w${id}`,
					`${overs.write.name}.bind({ ${Arr.join(
						Arr.map(entries, (e) => `${e.param}: ${e.source}`),
						", "
					)} })`,
					() =>
						idsWriteValue(overs.write).bind(
							Rec.fromEntries(Arr.map(entries, (e) => [e.param, e.value()] as const))
						)
				)
			}
			case "binding": {
				const overs = bindOversOf(cell.level)
				const bound = relationSourceOf(cell.source, overs.bound)
				return scopeCellOf(
					"binding",
					`a relation parameter bound to: ${cell.source} at ${cell.level}`,
					`b${id}`,
					`query(${overs.rule.source}).rule((r) => { const m = ${overs.imported.name}.bind({ ids: ${bound.source} }); const { id } = v(m, "m"); return r.match(m, { id }).find({ id }) })`,
					() => {
						const q = byIdsValue(overs.imported)
						return queryOver(overs.rule.value).rule((r: RuleValue) => {
							const m = q.bind({ ids: bound.value(r) })
							const vars = varsOver(m, "m")
							return r.match(m, { id: vars["id"] }).find({ id: vars["id"] })
						})
					}
				)
			}
			case "negation": {
				const filter = negationAt(cell.place)
				return scopeCellOf(
					"negation",
					`a relational negation at: ${cell.place}`,
					`g${id}`,
					`query(Agree).rule((r) => { const { id, n } = v(Item, "item"); return r.match(Item, { id, n }).where(${filter.source}).find({ id }) })`,
					() =>
						queryOver(Agree).rule((r: RuleValue) => {
							const vars = varsOver(Item, "item")
							return r
								.match(Item, { id: vars["id"], n: vars["n"] })
								.where(filter.value(r, vars["id"], vars["n"]))
								.find({ id: vars["id"] })
						})
				)
			}
		}
	})()
	return [
		`/** ${scoped.what}: the engine ${scoped.admitted ? "admits" : "refuses"} it. */`,
		...scoped.lines
	]
}

/** A cell of the scope axis, by the axis it closes and its place on it. */
type ScopeKey =
	| Readonly<{ axis: "level"; level: MatchedLevel; form: MatchedForm }>
	| Readonly<{ axis: "binding"; source: RelationSource; level: BindLevel }>
	| Readonly<{ axis: "write"; bound: WriteBound; level: WriteLevel }>
	| Readonly<{ axis: "negation"; place: NegationPlace }>

/**
 * One cell of the admission agreement's box: a position a constant stands in against a constant kind (the matrix), a
 * combinator over a shape under a wrapper, or a cell of the scope axis.
 */
export type AdmissionCell =
	| Readonly<{ axis: "matrix"; position: AdmissionPosition; kind: ConstantKind }>
	| Readonly<{ axis: "combinator"; combinator: Combinator; base: ShapeBase; wrapper: ShapeWrapper }>
	| Readonly<{ axis: "scope"; cell: ScopeKey }>

/** The cells of admissionBox, minted as a dictionary in its door (test/types/evidence/agreement.dictionary.ts). */
export const admissionBoxItems: Arr.NonEmptyReadonlyArray<AdmissionCell> = [
	...Arr.flatMap(combinators, (combinator) =>
		Arr.flatMap(shapeBases, (base) =>
			Arr.map(shapeWrappers, (wrapper): AdmissionCell => ({
				axis: "combinator",
				combinator,
				base,
				wrapper
			}))
		)
	),
	...Arr.flatMap(admissionPositions, (position) =>
		Arr.map(kindsAt(position), (kind): AdmissionCell => ({ axis: "matrix", position, kind }))
	),
	...Arr.flatMap(matchedLevels, (level) =>
		Arr.map(matchedForms, (form): AdmissionCell => ({
			axis: "scope",
			cell: { axis: "level", level, form }
		}))
	),
	...Arr.flatMap(relationSources, (source) =>
		Arr.map(bindLevelsOf(source), (level): AdmissionCell => ({
			axis: "scope",
			cell: { axis: "binding", source, level }
		}))
	),
	...Arr.flatMap(writeBounds, (bound) =>
		Arr.map(writeLevelsOf(bound), (level): AdmissionCell => ({
			axis: "scope",
			cell: { axis: "write", bound, level }
		}))
	),
	...Arr.map(negationPlaces, (place): AdmissionCell => ({
		axis: "scope",
		cell: { axis: "negation", place }
	}))
]

/** A cell's lines, named by `id`. */
const cellLines = (cell: AdmissionCell, id: string): ReadonlyArray<string> => {
	switch (cell.axis) {
		case "matrix":
			return matrixLines(cell.position, cell.kind, id)
		case "combinator":
			return combinatorLines(cell.combinator, cell.base, cell.wrapper, id)
		case "scope":
			return scopeLines(cell.cell, id)
	}
}

/**
 * The program of a batch of the box's cells, each cell's lines owned by it and named by its place among them, after the
 * imported query a relation parameter is bound from, the batch's own and exported, so a batch that binds none leaves it
 * unused but stated.
 */
export const admissionProgram = (
	cells: Arr.NonEmptyReadonlyArray<AdmissionCell>,
	at: PreludeAt
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/support/agreement/admission.ts: the admission agreement over every position and constant kind.",
		at,
		[
			{
				owner: batchOwned,
				lines: [
					byIdsSource(byIdsAgree),
					byIdsSource(byIdsAbove),
					idsWriteSource(idsWriteAgree),
					idsWriteSource(idsWriteAbove),
					"/** A boolean the program does not know, which a flagged arm's field turns on (flaggedArm). */",
					"export declare const flag: boolean",
					"export type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
					"export type Expect<T extends true> = T",
					""
				]
			},
			...Arr.map(cells, (cell, i) => ({
				owner: caseOwned(i),
				lines: [...cellLines(cell, `${i}`), ""]
			}))
		]
	)
]
