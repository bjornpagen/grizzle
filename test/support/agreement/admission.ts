import { Array as Arr, Predicate, Record as Rec, String as Str } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { compilePage, statedOrderOf } from "#compiler/lower/shapes/page/compile.ts"
import { type QueryTemplate, queryInput } from "#compiler/program/compile.ts"
import { Decimal, Money, pg, Vector } from "#compiler/public/fields.ts"
import { schema } from "#compiler/public/schema.ts"
import { queryOver, type QueryValue, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore, handleTerm } from "#compiler/scalar/compute/builders.ts"
import { check } from "#compiler/schema/statements.ts"
import type { TypeRefusal } from "#compiler/types/core/phantom.ts"
import { Agree, Cell, Cents, Shade, Tone } from "#test/support/agreement/schema.ts"
import { compileTemplate, testArtifacts, testCompile } from "#test/support/compile.ts"

/**
 * The admission agreement: types against the engine, over every position a constant may stand in and every kind of
 * constant (README "A constant is a JavaScript value or a typed term"). The class it closes is a program the types and
 * the engine disagree on: a position the types refuse though the engine admits it, or admit though it refuses.
 *
 * Every run draws, for each position and each constant kind, one statement over Cell: the constant's value, and the
 * Cell column of its type it meets, are drawn from the run's stream. The oracle is the engine: the statement is built
 * through the builder's JavaScript view (queryOver, varsOver, computeCore, the statements' check) and compiled as the
 * runtime compiles it, with no types. The program states each verdict: plain where the engine admits, under a
 * `@ts-expect-error` of the diagnostic the position raises where it refuses. The type batch checks the program
 * disarmed, so a statement the types refuse and the engine admits is a diagnostic no directive names, one they admit
 * and the engine refuses is a directive whose diagnostic never comes, and either fails the batch.
 *
 * Positions and constant kinds are closed unions read by exhaustive switches: a new one is a row of each, which the
 * compiler requires every reader to handle. Each statement is one line, so its diagnostic is on the line after its
 * directive: an object literal's property refuses with TS2322 (a binding, a head entry), a call's argument with
 * TS2345 (an operand, a Compute operand, a branch, a check's comparison, a handle's member).
 *
 * The discriminant position draws the kinds a head holds: a value no head holds is the head position's refusal. Three
 * positions stand in a self-join of Cell, whose second scope, named apart, is a second type: a constant bound at its
 * column, compared with its variable, or held in a self-join parent's head and bound by an attachment keyed by the
 * second scope's id (selfJoinAttachParent), is admitted exactly where it is at a rule's one scope.
 *
 * The rest stand where a constant meets a query rather than a column:
 * - paramBinding: Q.bind of a parameter declared at the constant's column, a property of bind's argument (TS2322).
 * - computedBinding: a second scope of Cell bound at the constant's column to the first scope's value plus the
 *   constant, a computed term: an exact integer or exact money at a plain integer or money column is the equality the
 *   checker writes widened, as Compute.eq's, and admitted both ways; an operand the sum refuses is its argument's
 *   diagnostic (TS2345), and a sum the column refuses, a contract's base at the contract, the binding's (TS2322).
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
 *
 * The combinator axis closes the same class over the query a combinator stands on rather than a constant: every
 * combinator (combinators: take, a page, orderBy, approximateNearest, attach, named, and a further arm of the shape's
 * heading or of another) over every shape (shapeBases: one rule, a union of one heading, a union of several headings,
 * an attached rule) under every wrapper (shapeWrappers: none, a name, a take), once each. All three are closed unions
 * read by exhaustive switches, so a new combinator, shape or wrapper is a compile error until it has its cells. A
 * combinator reads the fields at risk: orderBy orders by the name some record holds that the shape does not deliver as
 * a column (an arm's own field, an attachment), and an attachment's child heads an arm's own field over a union of
 * several headings. Its directive is the diagnostic the types raise where they refuse (combinatorDiagnostic).
 * A refusal both name is under its named directive (namedRefusal): a JavaScript value at a first operand (firstOperand,
 * computeFirst, condThen) is "a term first", whatever value it is. Every other refusal is the diagnostic of its
 * position. The positions whose verdict turns on two constants being one value (deadFilter, heteroClash,
 * threeArmsClash, attachedArmApart, attachedArmKeptApart) and the attached arms beside an arm of their heading, whose
 * verdict turns on no constant, draw only the kinds whose value the types carry, a primitive or a handle (valued): the
 * types take a Decimal, a Money and a typed Compute.literal to be any value of their type, the widening they keep
 * (types/query/query.ts Apart).
 */

/** Every position a constant may stand in. */
export const admissionPositions = [
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
	"attachedArmKeptApart"
] as const
export type AdmissionPosition = (typeof admissionPositions)[number]

/**
 * Every kind of constant: a JavaScript value of each carrier, a roster's handle, a typed Compute.literal and a
 * contract's, an uppercase uuid, which the builder canonicalizes, and a finite refined text's member, and the
 * ill-typed: another roster's handle, a contract's constant at its base, a handle off its roster, a text that is no
 * uuid's spelling at a uuid, another pattern's member at a refined text.
 */
export const constantKinds = [
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
	"otherLanguage"
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
			return { source: JSON.stringify(v), value: () => v, column: "text" }
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
			return { source: JSON.stringify(v), value: () => v, column: "uuid" }
		}
		case "decimal": {
			const v = of(["1.5", "2"])
			return {
				source: `Decimal.of(${JSON.stringify(v)})`,
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
				source: `Tone.handle(${JSON.stringify(m)})`,
				value: () => Tone.handle(m),
				column: "tone"
			}
		}
		case "typed": {
			const v = of([1, 2])
			return {
				source: `Compute.literal(pg.integer, ${v})`,
				value: () => computeCore.literal(pg.integer, v),
				column: "integer"
			}
		}
		case "contract": {
			const v = of([1n, 2n])
			return {
				source: `Compute.literal(Cents, ${v}n)`,
				value: () => computeCore.literal(Cents, v),
				column: "cents"
			}
		}
		case "wrongRoster": {
			const m = of(["low", "dark"] as const)
			return {
				source: `Shade.handle(${JSON.stringify(m)})`,
				value: () => Shade.handle(m),
				column: "tone"
			}
		}
		case "contractAtBase": {
			const v = of([1n, 2n])
			return {
				source: `Compute.literal(Cents, ${v}n)`,
				value: () => computeCore.literal(Cents, v),
				column: "bigint"
			}
		}
		case "offRoster":
			return {
				source: `Tone.handle("none")`,
				value: () => handleTerm(Tone, "none"),
				column: "tone"
			}
		case "uuidUpper": {
			const v = of(["00000000-0000-4000-8000-00000000000A", "00000000-0000-4000-8000-0000000000BC"])
			return { source: JSON.stringify(v), value: () => v, column: "uuid" }
		}
		case "notUuid": {
			const v = of(["0193d8f2", "00000000-0000-4000-8000"])
			return { source: JSON.stringify(v), value: () => v, column: "uuid" }
		}
		case "language": {
			const v = of(["pass", "fail"])
			return { source: JSON.stringify(v), value: () => v, column: "grade" }
		}
		case "otherLanguage": {
			const v = of(["yes", "no"])
			return { source: JSON.stringify(v), value: () => v, column: "grade" }
		}
	}
}

/** Whether a position holds a constant as a head holds it. */
const headed = (position: AdmissionPosition): boolean =>
	position === "head" ||
	position === "discriminant" ||
	position === "attachParent" ||
	position === "selfJoinAttachParent" ||
	position === "pageOrderKey"

/** The diagnostic a refused statement raises: a handle's member's, else its position's (see the header). */
const refusalCode = (position: AdmissionPosition, kind: ConstantKind): "TS2322" | "TS2345" =>
	position === "computedBinding"
		? kind === "contract"
			? "TS2322"
			: "TS2345"
		: kind === "offRoster" ||
			  !(
					position === "binding" ||
					position === "unionBinding" ||
					position === "selfJoinBinding" ||
					position === "paramBinding" ||
					headed(position)
			  )
			? "TS2345"
			: "TS2322"

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
			return false
	}
}

/** The refusal a cell's types name, with its diagnostic; none where the refusal is structural. */
const namedRefusal = (
	position: AdmissionPosition,
	kind: ConstantKind
): { readonly code: "TS2322" | "TS2345"; readonly message: TypeRefusal } | undefined => {
	switch (position) {
		case "firstOperand":
		case "computeFirst":
		case "condThen":
			return isJavaScriptValue(kind)
				? {
						code: "TS2345",
						message: "a term first: a literal takes its place opposite a term, never first"
					}
				: undefined
		case "deadFilter":
			return { code: "TS2322", message: "no arm of the source delivers the bound constants" }
		case "heteroClash":
		case "threeArmsClash":
			return {
				code: "TS2345",
				message: "arms of different headings share a field that holds a different constant in each"
			}
		case "attachedArm":
		case "attachedArmTaken":
		case "attachedArmNamed":
		case "attachedArmKept":
			return {
				code: "TS2345",
				message: "an attachment on an arm of a union whose heading several arms share"
			}
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
		case "heteroArms":
		case "threeArms":
		case "attachedArmApart":
		case "attachedArmKeptApart":
			return undefined
	}
}

/** The directive over a refused statement: its named refusal, else its diagnostic and why. */
const directiveOf = (position: AdmissionPosition, kind: ConstantKind): string => {
	const named = namedRefusal(position, kind)
	return named === undefined
		? `// @ts-expect-error -- ${refusalCode(position, kind)}: the engine refuses ${kind} at ${position}`
		: `// @ts-expect-error -- ${named.code} refusal: ${named.message}`
}

/** One statement of the matrix: its lines in the program, and how the engine reads it. */
interface Statement {
	readonly lines: Arr.NonEmptyReadonlyArray<string>
	readonly verdict: () => boolean
}

/**
 * A built query's page as db.page compiles it (adapter/page/template.ts): the page compiler over the template compiled
 * for a page and the stated order of the query's Description, against the schema's names.
 */
const paged = (q: unknown, template: QueryTemplate): Result.Result<unknown, CompileError> =>
	Result.flatMap(testArtifacts(Agree, testCompile), (artifacts) =>
		Result.flatMap(queryInput(q), (input) =>
			Result.flatMap(statedOrderOf(input.desc, SourceLoc("query", [])), (stated) =>
				compilePage({
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

/** The statement of one cell of the matrix, named by its index, any stages it keeps an arm under drawn by `draw`. */
const statementOf = (
	position: AdmissionPosition,
	c: Constant,
	other: Constant,
	draw: number,
	i: number
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
				lines: [plain(`Compute.add(x, ${c.source})`)],
				verdict: rows((_r, x) => computeCore.add(x, c.value()))
			}
		case "computeFirst":
			return {
				lines: [plain(`Compute.add(${c.source}, x)`)],
				verdict: rows((_r, x) => computeCore.add(c.value(), x))
			}
		case "condThen":
			return {
				lines: [plain(`Compute.cond(r.eq(x, x), ${c.source}, x)`)],
				verdict: rows((r, x) => computeCore.cond(r.eq(x, x), c.value(), x))
			}
		case "condElse":
			return {
				lines: [plain(`Compute.cond(r.eq(x, x), x, ${c.source})`)],
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
					`export const ${name} = check(${JSON.stringify(name)}, Cell, (p) => p.${col}.eq(${c.source}))`
				],
				verdict: () =>
					Result.flatMap(
						catchCompileError(() =>
							check(name, Cell, (row: unknown) => computeCore.eq(rowField(row, col), c.value()))
						),
						(made) =>
							testArtifacts(schema("AgreeCheck", { Tone, Shade, Cell }, [made]), testCompile)
					).ok
			}
		case "computedBinding":
			return {
				lines: [
					`export const ${name} = query(Agree).rule((r) => { ${Str.replace("return ", 'const peer = v(Cell, "peer"); return ')(matched)}.match(Cell, { id: peer.id, ${col}: Compute.add(x, ${c.source}) }).find({ id }) })`
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
	}
}

/** One cell of the matrix as the program states it: its position and kind, its lines, and the engine's verdict. */
export interface AdmissionCell {
	readonly position: AdmissionPosition
	readonly kind: ConstantKind
	readonly admitted: boolean
	readonly lines: ReadonlyArray<string>
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
 * The kinds a position draws: every kind, but where a head holds the constant only those a head holds, and where the
 * verdict turns on two constants being one value only those whose value the types carry (see the header).
 */
const kindsAt = (position: AdmissionPosition): ReadonlyArray<ConstantKind> => {
	switch (position) {
		case "discriminant":
		case "heteroArms":
		case "threeArms":
			return Arr.filter(constantKinds, (k) => k !== "vector")
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
		case "checkRow":
		case "paramBinding":
		case "computedBinding":
			return constantKinds
	}
}

/**
 * The matrix under a run's picks: every position and kind, its constant the pick-th value of its kind and any stages
 * it keeps an arm under the pick-th, its verdict the engine's, its lines under the directive its refusal raises.
 */
export const admissionCells = (pick: (cell: number) => number): ReadonlyArray<AdmissionCell> =>
	Arr.map(
		Arr.flatMap(admissionPositions, (position) =>
			Arr.map(kindsAt(position), (kind) => ({ position, kind }))
		),
		({ position, kind }, i): AdmissionCell => {
			const at = pick(i)
			const statement = statementOf(position, constantOf(kind, at), constantOf(kind, at + 1), at, i)
			const admitted = statement.verdict()
			const [first, ...rest] = Arr.reverse(statement.lines)
			const refused = [...Arr.reverse(rest), directiveOf(position, kind), first]
			return { position, kind, admitted, lines: admitted ? statement.lines : refused }
		}
	)

/** The shapes a combinator stands over: one rule, a union of one heading, a union of several, an attached rule. */
export const shapeBases = ["plain", "union", "heterogeneous", "attached"] as const
export type ShapeBase = (typeof shapeBases)[number]

/** What stands between a shape and the combinator over it: nothing, or a kept stage. */
export const shapeWrappers = ["bare", "named", "take"] as const
export type ShapeWrapper = (typeof shapeWrappers)[number]

/** Every combinator over a query: its stages, a page of it, and a further arm of its heading or of another. */
export const combinators = [
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
	source: `(r) => { const { id, vector } = v(Cell, "cell"); return r.match(Cell, { id, vector }).find({ id, d: ${JSON.stringify(d)}, s: Compute.cosineDistance(vector, Vector.make(Float32Array.of(0.5, 1, 2), 3))${Arr.join(
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
	source: `.attach(${JSON.stringify(name)}, (p) => query(Agree).rule((q) => q.match(Cell, { id: p.id }).find({ found: true${at === undefined ? "" : `, at: p.${at}`} })), "array")`,
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
					`export const ${name} = (db: DbOf<typeof Reader, unknown>) => db.page(${shape}.orderBy(["id", "asc"]), {}, { first: 10 })`,
				build: (q) => q.orderBy(["id", "asc"]),
				read: "page"
			}
		case "orderBy": {
			const field = orderedBy(base)
			return {
				line: (name, shape) =>
					`export const ${name} = ${shape}.orderBy([${JSON.stringify(field)}, "desc"])`,
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
const searchRefusal = (base: ShapeBase, wrapper: ShapeWrapper): TypeRefusal | undefined => {
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
 * The diagnostic a combinator over a shape raises where the types refuse it: the refusal they name, or the structural
 * error of its argument, a field no order or parent variable has (TS2322, TS2339) or a call's argument (TS2345).
 */
const combinatorDiagnostic = (
	combinator: Combinator,
	base: ShapeBase,
	wrapper: ShapeWrapper
): { readonly code: "TS2322" | "TS2339" | "TS2345"; readonly message: TypeRefusal | undefined } => {
	switch (combinator) {
		case "take":
			return {
				code: "TS2345",
				message: groupsTaken(base, wrapper)
					? "one take over a union of several headings: each heading group is a statement of its own, which one take bounds and the merge across them keeps"
					: undefined
			}
		case "page":
			return {
				code: "TS2345",
				message: groupsTaken(base, wrapper)
					? "a page over a bounded heterogeneous union: a group statement cannot tell which of its rows are among the union's first k"
					: undefined
			}
		case "orderBy":
			return { code: "TS2322", message: undefined }
		case "approximateNearest":
			return { code: "TS2345", message: searchRefusal(base, wrapper) }
		case "attach":
			return { code: "TS2339", message: undefined }
		case "named":
			return { code: "TS2345", message: undefined }
		case "unionArm":
			return {
				code: "TS2345",
				message: groupsTaken(base, wrapper)
					? "an arm over a union of several headings: only a query's result delivers each heading group"
					: base === "attached"
						? "an attachment on an arm of a union whose heading several arms share"
						: undefined
			}
		case "unionArmApart":
			return {
				code: "TS2345",
				message: groupsTaken(base, wrapper)
					? "an arm over a union of several headings: only a query's result delivers each heading group"
					: base === "union" && wrapper === "take"
						? "arms of different headings share a field that holds a different constant in each"
						: undefined
			}
	}
}

/** One cell of the combinator axis: its combinator, shape and wrapper, the engine's verdict, and its lines. */
export interface CombinatorCell {
	readonly combinator: Combinator
	readonly base: ShapeBase
	readonly wrapper: ShapeWrapper
	readonly admitted: boolean
	readonly lines: ReadonlyArray<string>
}

/**
 * The combinator axis: every combinator over every shape under every wrapper, its verdict the engine's, its line under
 * the directive of the diagnostic the types raise where the engine refuses.
 */
export const combinatorCells = (): ReadonlyArray<CombinatorCell> =>
	Arr.map(
		Arr.flatMap(combinators, (combinator) =>
			Arr.flatMap(shapeBases, (base) =>
				Arr.map(shapeWrappers, (wrapper) => ({ combinator, base, wrapper }))
			)
		),
		({ combinator, base, wrapper }, i): CombinatorCell => {
			const shape = shapeOf(base, wrapper)
			const combined = applied(combinator, base)
			const admitted = compiles(() => combined.build(shape.value()), combined.read)()
			const line = combined.line(`n${i}`, shape.source)
			const diagnostic = combinatorDiagnostic(combinator, base, wrapper)
			const directive =
				diagnostic.message === undefined
					? `// @ts-expect-error -- ${diagnostic.code}: the engine refuses ${combinator} over ${base} under ${wrapper}`
					: `// @ts-expect-error -- ${diagnostic.code} refusal: ${diagnostic.message}`
			return { combinator, base, wrapper, admitted, lines: admitted ? [line] : [directive, line] }
		}
	)

/**
 * The module holding the matrix and the combinator axis, its imports spelled by `entries`; a page reads through the
 * role of the whole schema.
 */
export const admissionModule = (
	entries: {
		readonly query: string
		readonly compute: string
		readonly fields: string
		readonly db: string
		readonly declare: string
		readonly schema: string
	},
	cells: ReadonlyArray<AdmissionCell>,
	combined: ReadonlyArray<CombinatorCell>
): string =>
	Arr.join(
		[
			"// Generated by test/support/agreement/admission.ts: the admission agreement over every position and constant kind.",
			`import { Compute } from ${JSON.stringify(entries.compute)}`,
			`import { Decimal, Money, pg, Vector } from ${JSON.stringify(entries.fields)}`,
			`import { query, v } from ${JSON.stringify(entries.query)}`,
			`import type { DbOf } from ${JSON.stringify(entries.db)}`,
			`import { check, role } from ${JSON.stringify(entries.declare)}`,
			`import { Agree, Cell, Cents, Shade, Tone } from ${JSON.stringify(entries.schema)}`,
			"",
			'const Reader = role(Agree, "reader", Agree.relations)',
			"",
			...Arr.flatMap(cells, (c) => [
				`/** ${c.kind} at ${c.position}: the engine ${c.admitted ? "admits" : "refuses"} it. */`,
				...c.lines
			]),
			...Arr.flatMap(combined, (c) => [
				`/** ${c.combinator} over ${c.base} under ${c.wrapper}: the engine ${c.admitted ? "admits" : "refuses"} it. */`,
				...c.lines
			]),
			""
		],
		"\n"
	)

/** Every position's and every kind's cells, so a run's matrix is never short of one. */
export const admissionSize = Arr.reduce(admissionPositions, 0, (n, p) => n + kindsAt(p).length)
