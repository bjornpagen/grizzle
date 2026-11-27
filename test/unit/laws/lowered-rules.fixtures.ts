/** What the properties of lowered-rules.test.ts read: their spaces, the conditions restated, and their checkers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import {
	type Aimed,
	aimed,
	array,
	element,
	type Gen,
	int,
	shuffled,
	subarray,
	subset,
	weighted
} from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, Option, Order, Record as Rec } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import type { LawId, RelationIdent } from "#compiler/core/ids.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { lawsOfConstraint } from "#compiler/ir/products.ts"
import { compileLaws, triggerLawsOver } from "#compiler/laws/model/model.ts"
import { type Installation, installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { own } from "#compiler/schema/own.ts"
import {
	type ColumnDef,
	type ForeignKey,
	type SqlStatement,
	type TableConstraint,
	tableConstraints
} from "#compiler/sql/ast.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	type AuthoredRelationDesc,
	contained,
	decodedQuery,
	decodedSchema,
	f,
	key,
	literal,
	on,
	onWhere,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"

/**
 * A containment into a derived relation whose definition is a key-shaped conjunction of stored relations lowers to
 * native foreign keys (analysis/theory/laws.ts RuleLowering): one DEFERRABLE INITIALLY DEFERRED foreign key per match
 * of the definition, from the source's columns, then a constant column of the source for each constant the match fixes,
 * into a UNIQUE of the match's relation over exactly the fields it references, its declared key's own or a superkey of
 * it, or, where that costs the schema fewer indexes and columns, from the source's columns alone into the match's own
 * columns under its constants (laws/model/plan.ts sharedTargets); and the rule then holds no capture. Every other rule
 * over a query is kept for the set judge (physical/ddl/rules.ts addRules), a capture on each table it reads. The law
 * oracle's conservative installation (program/install.ts conservativeInstallation) keeps every rule so, under
 * the same laws.
 *
 * Each case draws a definition over R0 (id, a, b, k; keyed by id and by (a, b)) and R1 (id, a, k; keyed by id) on a
 * base level, and a containment of S's x, y, z into its one to three head terms on a level above: one or two matches,
 * each of either relation, each field bound to a head term's variable, to a variable of its own, to a literal, to a
 * variable a condition fixes to a literal, or to nothing; S, and R1, drawn on either level; and at most one condition
 * broken on purpose: a second arm, a negation, a literal head term, one variable at two head terms, a condition that
 * is no equality with a literal, or a head variable fixed to a literal. The rest of the seven conditions a draw breaks
 * as it falls: a variable of its own bound twice, a match binding no head term's variable, a match binding one at two
 * fields, and a match whose head and constant fields hold no key of its relation.
 *
 * Oracle: the seven conditions restated over the drawn definition, never over the engine's arms, and the catalog each
 * implies: lowered, every match's foreign key from S's paired columns and its constant columns, each generated from its
 * literal, into exactly a UNIQUE or the primary key of its relation, mapped to the rule's law, and no capture for the
 * rule; kept, the rule's captures on S and every relation it matches and no foreign key from S. The conservative
 * installation keeps the rule in every case, and both name the rule by one law. The law model's trigger laws over each
 * of S, R0 and R1 (laws/model/model.ts triggerLawsOver), which the isolation certifier reads, are the rule's law exactly
 * when it is kept and its query mentions the relation, by its source, a match or its negation.
 *
 * A second box states the level rule (schema/own.ts #checkLevels) over every target side of R0 on a level below S, its
 * terms one to three of R0's fields and its selection constants on others: the containment is admitted exactly when
 * the target's fields and constants hold a key R0 declares, whose UNIQUE, a superkey's where it is no key exactly, the
 * upper level installs, from a source on the level above or below it, whose table then holds the constants as
 * generated columns.
 *
 * Planted in a scratch copy, each of these fails the first box: a lowering that drops a match's constant column; one
 * whose superkey plans no UNIQUE; and one that ignores condition 4, lowering a definition whose matches share a
 * variable of their own.
 *
 * Features: each condition met or broken, one match or two, constants, S and R1 on either level, lowered and kept for
 * the lowering; each target side's key and selection, from above and below, for the level rule.
 */

type Target = "R0" | "R1"
type Level = "base" | "ledger"

const TARGETS: Arr.NonEmptyReadonlyArray<Target> = ["R0", "R1"]
const FIELDS: Readonly<Record<Target, ReadonlyArray<string>>> = {
	R0: ["id", "a", "b", "k"],
	R1: ["id", "a", "k"]
}
/** Each relation's declared keys: its primary key, and R0's key over (a, b). */
export const KEYS: Readonly<Record<Target, ReadonlyArray<ReadonlyArray<string>>>> = {
	R0: [["id"], ["a", "b"]],
	R1: [["id"]]
}
/** S's fields a containment pairs with the target's terms, in order. */
const SOURCE: ReadonlyArray<string> = ["x", "y", "z"]

const R0 = relation("R0", { id: f.integer, a: f.integer, b: f.integer, k: f.integer }, ["id"])
const R1 = relation("R1", { id: f.integer, a: f.integer, k: f.integer }, ["id"])
const S = relation("S", { id: f.integer, x: f.integer, y: f.integer, z: f.integer }, ["id"])

/** How a match binds one field of its relation. */
type Binding =
	| { readonly kind: "head"; readonly at: number }
	| { readonly kind: "own"; readonly name: number }
	| { readonly kind: "literal" }
	| { readonly kind: "fixed"; readonly name: number }
	| { readonly kind: "none" }

interface MatchCase {
	readonly target: Target
	/** One binding per field of the target, in its declared order. */
	readonly bindings: ReadonlyArray<Binding>
}

/** The one condition a definition breaks on purpose, beside those its matches break as drawn. */
type Break =
	| "none"
	| "a second arm"
	| "a negation"
	| "a literal head term"
	| "one variable at two head terms"
	| "a condition no equality with a literal"
	| "a head variable fixed to a literal"

interface LoweringCase {
	readonly heads: number
	readonly matches: Arr.NonEmptyReadonlyArray<MatchCase>
	readonly breaks: Break
	readonly source: Level
	readonly r1: Level
}

const bindingGen = (heads: number): Gen<Binding> =>
	weighted<Binding>([
		[4, (s) => ({ kind: "head", at: s.draw(int(0, heads - 1)) })],
		[2, (s) => ({ kind: "own", name: s.draw(int(0, 2)) })],
		[1, () => ({ kind: "literal" })],
		[1, (s) => ({ kind: "fixed", name: s.draw(int(0, 1)) })],
		[2, () => ({ kind: "none" })]
	])

/**
 * A case of two matches that meet at a variable of their own and break nothing else: R0 keyed at its head term's id,
 * and R1 keyed at its own, each binding k to the one variable.
 */
const joinedGen: Gen<LoweringCase> = (s) => {
	const heads = s.draw(int(1, 2))
	const none: Binding = { kind: "none" }
	const joined: Binding = { kind: "own", name: 0 }
	return {
		heads,
		matches: [
			{ target: "R0", bindings: [{ kind: "head", at: 0 }, none, none, joined] },
			{ target: "R1", bindings: [{ kind: "head", at: heads - 1 }, none, joined] }
		],
		breaks: "none",
		source: s.draw(element<Level>(["ledger", "base"])),
		r1: s.draw(element<Level>(["base", "ledger"]))
	}
}

/** The conditions a definition breaks on purpose, by a break of its own. */
const PURPOSED = ["condition 1", "condition 2", "condition 3"] as const

type Purposed = (typeof PURPOSED)[number]

/** The breaks that break each condition a definition breaks on purpose. */
const BREAKING: Readonly<Record<Purposed, Arr.NonEmptyReadonlyArray<Break>>> = {
	"condition 1": ["a second arm", "a negation"],
	"condition 2": ["a literal head term", "one variable at two head terms"],
	"condition 3": ["a condition no equality with a literal", "a head variable fixed to a literal"]
}

/** A field a purposed case leaves to its match: bound to nothing, or to its literal. */
const freeGen: Gen<Binding> = element<Binding>([{ kind: "none" }, { kind: "literal" }])

/**
 * A case breaking `condition` on purpose, by one of its breaks, and meeting every other condition: one match of R0, its
 * id and a bound to the two head terms and b and k free, from a source on the ledger level, above R0.
 */
const purposedGen =
	(condition: Purposed): Gen<LoweringCase> =>
	(s) => ({
		heads: 2,
		matches: [
			{
				target: "R0",
				bindings: [
					{ kind: "head", at: 0 },
					{ kind: "head", at: 1 },
					s.draw(freeGen),
					s.draw(freeGen)
				]
			}
		],
		breaks: s.draw(element(BREAKING[condition])),
		source: "ledger",
		r1: s.draw(element<Level>(["base", "ledger"]))
	})

/**
 * A case: its matches' relations, a field of its own for each head term's variable, drawn apart so every head term
 * reads a bound variable, and every other field's binding drawn.
 */
const drawnGen: Gen<LoweringCase> = (s) => {
	const heads = s.draw(int(1, 3))
	const targets = nonEmpty(s.draw(array(element(TARGETS), { min: 1, max: 2 })), "the matches")
	const slots = Arr.flatMap(targets, (target, m) =>
		Arr.map(FIELDS[target], (_, field) => ({ m, field }))
	)
	const placed = s.draw(shuffled(slots, { min: heads, max: heads }))
	const drawnMatches = Arr.map(targets, (target, m) => ({
		target,
		bindings: Arr.map(FIELDS[target], (_, field): Binding =>
			Option.match(
				Arr.findFirstIndex(placed, (p) => p.m === m && p.field === field),
				{
					onNone: () => s.draw(bindingGen(heads)),
					onSome: (at) => ({ kind: "head", at })
				}
			)
		)
	}))
	/** A match that fixes its relation's primary key to a literal and binds nothing else: one row it needs to hold. */
	const constantMatches = s.draw(
		weighted<ReadonlyArray<MatchCase>>([
			[5, () => []],
			[
				1,
				(t) => {
					const target = t.draw(element(TARGETS))
					return [
						{
							target,
							bindings: Arr.map(FIELDS[target], (_, field): Binding =>
								field === 0 ? { kind: "literal" } : { kind: "none" }
							)
						}
					]
				}
			]
		])
	)
	return {
		heads,
		matches: Arr.appendAll(drawnMatches, constantMatches),
		breaks: s.draw(
			weighted<Break>([
				[8, () => "none"],
				[1, () => "a second arm"],
				[1, () => "a negation"],
				[1, () => "a literal head term"],
				[1, () => (heads > 1 ? "one variable at two head terms" : "none")],
				[1, () => "a condition no equality with a literal"],
				[1, () => "a head variable fixed to a literal"]
			])
		),
		source: s.draw(element<Level>(["ledger", "base"])),
		r1: s.draw(element<Level>(["base", "ledger"]))
	}
}

/**
 * The drawn definitions, aimed: a case whose turn aims at a condition a definition breaks on purpose is drawn breaking
 * it alone (purposedGen), and one aiming at condition 4 is drawn as two matches meeting at a variable of their own
 * (joinedGen), which a drawn definition, breaking others as it falls, seldom is.
 */
export const caseSpace: Aimed<LoweringCase, Shape> = aimed(drawnGen, [
	...Arr.map(PURPOSED, (condition) => [condition, purposedGen(condition)] as const),
	["condition 4", joinedGen]
])

const levelOf = (level: Level): number => (level === "ledger" ? 1 : 0)
const targetLevel = (c: LoweringCase, target: Target): number =>
	target === "R1" ? levelOf(c.r1) : levelOf("base")

const headVar = (at: number): string => `h${at}`
const ownVar = (name: number): string => `o${name}`
const fixedVar = (name: number): string => `c${name}`

/** The literal a match binds a field to, one per relation and field, so each constant column is told apart. */
const literalOf = (target: Target, field: number): number =>
	100 + 10 * TARGETS.indexOf(target) + field
/** The literal a condition fixes a fixed variable to. */
const fixedLiteral = (name: number): number => 7 + name

const fieldAt = (target: Target, at: number): string =>
	defined(FIELDS[target][at], "a binding names a field of its relation")

/** The fields a match fixes to a literal, each with its literal, in field order. */
const constantsOf = (
	m: MatchCase
): ReadonlyArray<{ readonly field: string; readonly value: number }> =>
	Arr.flatMap(m.bindings, (b, i) =>
		b.kind === "literal"
			? [{ field: fieldAt(m.target, i), value: literalOf(m.target, i) }]
			: b.kind === "fixed"
				? [{ field: fieldAt(m.target, i), value: fixedLiteral(b.name) }]
				: []
	)

/** The fields a match binds head terms' variables at, each with its term's position, in the terms' order. */
const headFieldsOf = (
	m: MatchCase
): ReadonlyArray<{ readonly field: string; readonly at: number }> =>
	Arr.sort(
		Arr.flatMap(m.bindings, (b, i) =>
			b.kind === "head" ? [{ field: fieldAt(m.target, i), at: b.at }] : []
		),
		Order.mapInput(Order.Number, (h: { readonly at: number }) => h.at)
	)

export type Shape =
	| "lowered"
	| "kept"
	| "two matches"
	| "a constant column"
	| "a superkey's UNIQUE"
	| "condition 1"
	| "condition 2"
	| "condition 3"
	| "condition 4"
	| "condition 5"
	| "condition 6"
	| "condition 7"
	| "the level rule"

/** The conditions the drawn definition breaks, restated over it: the seven, and the level rule beside them. */
export const brokenConditions = (c: LoweringCase): ReadonlyArray<Shape> => {
	const own = Arr.flatMap(c.matches, (m) =>
		Arr.flatMap(m.bindings, (b) => (b.kind === "own" ? [b.name] : []))
	)
	const holdsKey = (m: MatchCase): boolean => {
		const held = [
			...Arr.map(headFieldsOf(m), (h) => h.field),
			...Arr.map(constantsOf(m), (k) => k.field)
		]
		return Arr.some(KEYS[m.target], (k) => Arr.every(k, (field) => held.includes(field)))
	}
	const twice = (m: MatchCase): boolean => {
		const at = Arr.map(headFieldsOf(m), (h) => h.at)
		return new Set(at).size !== at.length
	}
	const broken: ReadonlyArray<readonly [Shape, boolean]> = [
		...Arr.map(PURPOSED, (condition): readonly [Shape, boolean] => [
			condition,
			Arr.contains(BREAKING[condition], c.breaks)
		]),
		["condition 4", Arr.some(own, (name) => Arr.filter(own, (n) => n === name).length > 1)],
		["condition 5", Arr.some(c.matches, (m) => headFieldsOf(m).length === 0)],
		["condition 6", Arr.some(c.matches, twice)],
		["condition 7", !Arr.every(c.matches, holdsKey)],
		["the level rule", Arr.some(c.matches, (m) => targetLevel(c, m.target) > levelOf(c.source))]
	]
	return Arr.flatMap(broken, ([shape, holds]) => (holds ? [shape] : []))
}

const varRef = (name: string): ExprDesc => ({ kind: "var", var: name })

const compare = (op: "eq" | "lt", left: ExprDesc, right: ExprDesc): ExprDesc => ({
	kind: "compare",
	op,
	left,
	right
})

const relationSource = (name: string): { readonly kind: "relation"; readonly name: string } => ({
	kind: "relation",
	name
})

/** The case's derived relation's definition as a description, each of its arm's variables bound by a match. */
const definitionOf = (c: LoweringCase) => {
	const origins = new Map<string, { readonly relation: string; readonly field: string }>()
	const fixed = new Set<number>()
	const matches = Arr.map(c.matches, (m) => ({
		source: relationSource(m.target),
		bindings: Rec.fromEntries(
			Arr.flatMap(m.bindings, (b, i): ReadonlyArray<readonly [string, ExprDesc]> => {
				const field = fieldAt(m.target, i)
				const bound = (name: string): ReadonlyArray<readonly [string, ExprDesc]> => {
					if (!origins.has(name)) {
						origins.set(name, { relation: m.target, field })
					}
					return [[field, varRef(name)]]
				}
				switch (b.kind) {
					case "head":
						return bound(headVar(b.at))
					case "own":
						return bound(ownVar(b.name))
					case "fixed":
						fixed.add(b.name)
						return bound(fixedVar(b.name))
					case "literal":
						return [[field, literal(literalOf(m.target, i))]]
					case "none":
						return []
				}
			})
		)
	}))
	const broken: ReadonlyArray<ExprDesc> =
		c.breaks === "a negation"
			? [{ kind: "absent", source: relationSource("R1"), bindings: { k: varRef(headVar(0)) } }]
			: c.breaks === "a condition no equality with a literal"
				? [compare("lt", varRef(headVar(0)), literal(5))]
				: c.breaks === "a head variable fixed to a literal"
					? [compare("eq", varRef(headVar(0)), literal(5))]
					: []
	const head = Rec.fromEntries(
		Arr.map(indices(c.heads), (at): readonly [string, ExprDesc] => [
			`t${at}`,
			at === 0 && c.breaks === "a literal head term"
				? literal(9)
				: at === 1 && c.breaks === "one variable at two head terms"
					? varRef(headVar(0))
					: varRef(headVar(at))
		])
	)
	const arm = {
		vars: Arr.map(Arr.fromIterable(origins), ([id, origin]) => ({ id, origin })),
		matches: nonEmpty(matches, "a definition's matches"),
		where: [
			...Arr.map(Arr.fromIterable(fixed), (name) =>
				compare("eq", varRef(fixedVar(name)), literal(fixedLiteral(name)))
			),
			...broken
		],
		head,
		interiors: [],
		attach: []
	}
	return decodedQuery({
		kind: "rules",
		arms: c.breaks === "a second arm" ? [arm, arm] : [arm]
	})
}

/** R0's key over (a, b), stated on the level R0 is declared on. */
const r0Key = (relations: ReadonlyArray<{ readonly name: string }>): SchemaDesc["statements"] =>
	Arr.some(relations, (r) => r.name === "R0") ? [key(on("R0", ["a", "b"]))] : []

/** One level of a layered schema: its relations and its statements, R0's key with R0. */
interface Layer {
	readonly relations: SchemaDesc["relations"]
	readonly statements: SchemaDesc["statements"]
}

/** A schema of `layers`, root first, each level extending the one before it, each named by its depth. */
const layered = (layers: Arr.NonEmptyReadonlyArray<Layer>): SchemaDesc => {
	const [root, ...above] = layers
	const levelOf = (layer: Layer, at: number, extending: SchemaDesc | undefined): SchemaDesc => ({
		name: `Level${at}`,
		bases: extending === undefined ? [] : [extending],
		relations: layer.relations,
		statements: [...r0Key(layer.relations), ...layer.statements]
	})
	return Arr.reduce(above, levelOf(root, 0, undefined), (below, layer, i) =>
		levelOf(layer, i + 1, decodedSchema(below))
	)
}

/**
 * The case's schema: R0 on the root level, R1 and S each on the root level or the one above it, and the derived
 * relation with the containment of S into it on the first level above every relation it matches, S's own where S
 * stands there, as a level's own containment into the content below it does.
 */
export const schemaOf = (c: LoweringCase): SchemaDesc => {
	const on1 = (level: Level, r: AuthoredRelationDesc): ReadonlyArray<AuthoredRelationDesc> =>
		level === "ledger" ? [r] : []
	const on0 = (level: Level, r: AuthoredRelationDesc): ReadonlyArray<AuthoredRelationDesc> =>
		level === "base" ? [r] : []
	const rule: Layer = {
		relations: [{ kind: "derived", name: "D", level: 1, query: definitionOf(c) }],
		statements: [
			contained(
				on("S", Arr.take(SOURCE, c.heads)),
				on(
					"D",
					Arr.map(indices(c.heads), (at) => `t${at}`)
				)
			)
		]
	}
	const root: Layer = {
		relations: [R0, ...on0(c.r1, R1), ...on0(c.source, S)],
		statements: []
	}
	const middle = [...on1(c.r1, R1), ...on1(c.source, S)]
	return c.r1 === "base"
		? layered([root, { relations: [...middle, ...rule.relations], statements: rule.statements }])
		: layered([root, { relations: middle, statements: [] }, rule])
}

/** A schema description's installation by `compile`, or the refusal its owner or its compile gives it. */
export const compiled = (
	desc: SchemaDesc,
	compile: typeof compileInstallation
): Result.Result<Installation, CompileError> =>
	Result.flatMap(own(decodedSchema(desc)), (owned) => compile(owned, installOptions(owned)))

/** The relations the case's rule reads: S, every relation its definition matches, and the one it negates. */
const readBy = (c: LoweringCase): ReadonlyArray<string> => [
	"S",
	...Arr.map(c.matches, (m) => m.target),
	...(c.breaks === "a negation" ? ["R1"] : [])
]

/**
 * Asserts the installation's law model reports, for each of S, R0 and R1, exactly the rule's law when the rule is kept
 * and reads the relation, and no law otherwise (laws/model/model.ts triggerLawsOver).
 */
export const assertTriggerLaws = (
	c: LoweringCase,
	desc: SchemaDesc,
	law: LawId,
	kept: boolean
): void => {
	const model = succeeded(
		Result.flatMap(own(decodedSchema(desc)), (owned) => compileLaws(owned, { kind: "planned" }))
	)
	for (const relation of ["S", "R0", "R1"]) {
		assert.deepEqual(
			Arr.map(triggerLawsOver(model, relation), (t) => t.law),
			kept && readBy(c).includes(relation) ? [law] : [],
			`the trigger laws over ${relation}`
		)
	}
}

/** Every constraint of every table the installation creates or alters, each with its table's name. */
const constraintsOf = (
	statements: ReadonlyArray<SqlStatement>
): ReadonlyArray<{ readonly table: string; readonly constraint: TableConstraint }> =>
	Arr.flatMap(statements, (s) =>
		s.kind === "createTable"
			? Arr.map(tableConstraints(s), (constraint) => ({ table: s.table.name, constraint }))
			: s.kind === "alterTable"
				? Arr.flatMap(s.actions, (a) =>
						a.kind === "addConstraint" ? [{ table: s.table.name, constraint: a.constraint }] : []
					)
				: []
	)

/** Every column of every table the installation creates or alters, each with its table's name. */
const columnsOf = (
	statements: ReadonlyArray<SqlStatement>
): ReadonlyArray<{ readonly table: string; readonly column: ColumnDef }> =>
	Arr.flatMap(statements, (s) =>
		s.kind === "createTable"
			? Arr.map(s.columns, (column) => ({ table: s.table.name, column }))
			: s.kind === "alterTable"
				? Arr.flatMap(s.actions, (a) =>
						a.kind === "addColumn" ? [{ table: s.table.name, column: a.column }] : []
					)
				: []
	)

/**
 * A column of S as a foreign key from S references from it: one of S's fields, a constant column generated and stored
 * from one integer literal, or any other generated column, which no match's key references from.
 */
type Referencing =
	| { readonly kind: "field"; readonly column: string }
	| { readonly kind: "constant"; readonly value: number }
	| { readonly kind: "generated"; readonly text: string }

/** A printed stored generation that is one integer literal, cast or parenthesized or not: the literal. */
const literalText = regex("^\\(*(-?\\d+)\\)*(?:::[a-z ]+)?\\)*$")

/** The column `name` of S, among S's `columns`, as a foreign key references from it (`Referencing`). */
const referencingOf = (
	columns: ReadonlyArray<{ readonly table: string; readonly column: ColumnDef }>,
	name: string
): Referencing => {
	const generation = holding(
		Arr.findFirst(columns, (col) => col.column.name === name),
		`the column ${name} of S`
	).column.generated
	if (generation === undefined) {
		return { kind: "field", column: name }
	}
	const text = generation.kind === "stored" ? printExpr(generation.expr) : generation.kind
	const literal = literalText.exec(text)?.[1]
	return literal === undefined
		? { kind: "generated", text }
		: { kind: "constant", value: Number(literal) }
}

/** Whether two lists of referencing columns are one, column for column. */
const sameReferencing = (x: ReadonlyArray<Referencing>, y: ReadonlyArray<Referencing>): boolean =>
	x.length === y.length &&
	Arr.every(x, (a, i) => {
		const b = y[i]
		switch (a.kind) {
			case "field":
				return b?.kind === "field" && b.column === a.column
			case "constant":
				return b?.kind === "constant" && b.value === a.value
			case "generated":
				return b?.kind === "generated" && b.text === a.text
		}
	})

const tableOf = (installation: Installation, relation: string): RelationIdent =>
	installation.names.relation(relation).name

/** The value `found` holds, which the catalog must hold. */
const holding = <A>(found: Option.Option<A>, what: string): A =>
	Option.getOrThrowWith(found, () => new Error(`the catalog holds ${what}`))

/** The rule's law as the installation names it: the one law S's table holds beside its primary key's. */
export const ruleLaw = (installation: Installation): LawId => {
	const table = tableOf(installation, "S")
	const primaryName = holding(
		Arr.findFirst(
			constraintsOf(installation.statements),
			(c) => c.table === table && c.constraint.kind === "primaryKey"
		),
		"S's primary key"
	).constraint.name
	const primaryLaws =
		lawsOfConstraint(installation.constraintToLaw, { kind: "table", name: table }, primaryName) ??
		[]
	const laws = Arr.filter(
		Arr.dedupe(Arr.flatten(Rec.values(installation.constraintToLaw.tables[table] ?? {}))),
		(l) => !Arr.contains(primaryLaws, l)
	)
	assert.equal(laws.length, 1, "S's table names one law beside its primary key's")
	return defined(laws[0], "the rule's law")
}

/**
 * The tables the set judge captures for the rule of `law` (physical/ddl/rules.ts addRules): each table a capture
 * trigger sits on whose object the law justifies, a rule's captures being the statement triggers of each table its
 * query reads.
 */
const capturedTables = (installation: Installation, law: LawId): ReadonlyArray<string> =>
	Arr.flatMap(installation.manifest.objects, (o) =>
		o.kind === "lawTrigger" && Arr.some(o.reasons, (r) => r.kind === "law" && r.law === law)
			? Arr.flatMap(o.ddl, (st) => (st.kind === "createTransitionTrigger" ? [st.table.name] : []))
			: []
	)

/** The foreign keys from S's table. */
const foreignKeysFromS = (installation: Installation): ReadonlyArray<ForeignKey> => {
	const table = tableOf(installation, "S")
	return Arr.flatMap(constraintsOf(installation.statements), (c) =>
		c.table === table && c.constraint.kind === "foreignKey" ? [c.constraint] : []
	)
}

/** Asserts `installation` keeps the rule for the judge, capturing S and every relation its definition matches, with no
 * foreign key from S. */
export const assertKept = (c: LoweringCase, installation: Installation, law: LawId): void => {
	const held = capturedTables(installation, law)
	for (const relation of ["S", ...Arr.map(c.matches, (m) => m.target)]) {
		assert.ok(
			held.includes(tableOf(installation, relation)),
			`a capture of the rule on ${relation}`
		)
	}
	assert.deepEqual(foreignKeysFromS(installation), [], "no foreign key from S")
}

/**
 * Asserts `installation` lowers the rule: one deferred foreign key per match from S's paired columns, then a constant
 * column per constant, each generated from its literal, into exactly a UNIQUE or the primary key of the match's
 * relation, or, where the law model finds it costs the schema less (laws/model/plan.ts sharedTargets), from the paired
 * columns alone into the match's own columns under its constants, which a UNIQUE of the relation holds; each mapped to
 * the rule's law, and no capture for the rule. The shapes it met.
 */
export const assertLowered = (
	c: LoweringCase,
	installation: Installation,
	law: LawId
): ReadonlyArray<Shape> => {
	const shapes: Array<Shape> = []
	const sTable = tableOf(installation, "S")
	const keys = foreignKeysFromS(installation)
	const specs = Arr.dedupe(
		Arr.map(c.matches, (m) =>
			Arr.join(
				[
					m.target,
					...Arr.map(headFieldsOf(m), (h) => `${h.at}:${h.field}`),
					...Arr.map(constantsOf(m), (k) => `${k.field}=${k.value}`)
				],
				" "
			)
		)
	)
	assert.equal(
		keys.length,
		specs.length,
		"one foreign key from S per match, two of one reference being one"
	)
	const constraints = constraintsOf(installation.statements)
	const columns = Arr.filter(columnsOf(installation.statements), (col) => col.table === sTable)
	for (const m of c.matches) {
		const target = tableOf(installation, m.target)
		const heads = headFieldsOf(m)
		const constants = constantsOf(m)
		const referenced = [
			...Arr.map(heads, (h) => installation.names.column(m.target, h.field)),
			...Arr.map(constants, (k) => installation.names.column(m.target, k.field))
		]
		const over = Arr.join(referenced, ", ")
		const paired = Arr.map(heads, (h) =>
			installation.names.column("S", defined(SOURCE[h.at], "a source field per head term"))
		)
		const fields = Arr.map(paired, (column): Referencing => ({ kind: "field", column }))
		/** The match's own foreign key: from its paired fields, then a constant column per constant, into its fields at
		 * its head terms and constants; or from the paired fields alone into its own columns under its constants, one per
		 * head term, its guarded term's a law column and every other its field (laws/model/plan.ts sideColumns). Two
		 * matches of one relation may reference the same columns, so the referencing columns, read as what each holds,
		 * tell their keys apart. */
		const fk = holding(
			Arr.findFirst(keys, (k) => {
				const from = Arr.map(k.columns, (col) => referencingOf(columns, col.column))
				return (
					k.references.name === target &&
					((Arr.join(
						Arr.map(k.referencedColumns, (r) => r.column),
						", "
					) === over &&
						sameReferencing(from, [
							...fields,
							...Arr.map(constants, (x): Referencing => ({ kind: "constant", value: x.value }))
						])) ||
						(constants.length > 0 &&
							sameReferencing(from, fields) &&
							k.referencedColumns.length === heads.length &&
							Arr.filter(k.referencedColumns, (r) => !Arr.contains(referenced, r.column)).length ===
								1))
				)
			}),
			`a foreign key from S's ${Arr.join(paired, ", ")} and a constant column of each of ${Arr.join(
				Arr.map(constants, (x) => `${x.field} = ${x.value}`),
				", "
			)} into ${m.target} over ${over}, or from the paired columns alone over its own columns under the match's constants`
		)
		assert.equal(fk.deferrable, "INITIALLY DEFERRED", "the foreign key is deferred")
		assert.deepEqual(
			lawsOfConstraint(installation.constraintToLaw, { kind: "table", name: sTable }, fk.name),
			[law],
			"the foreign key names the rule's law"
		)
		const atOwnColumns = fk.columns.length === heads.length && constants.length > 0
		if (!atOwnColumns) {
			Arr.forEach(constants, () => shapes.push("a constant column"))
		}
		const landed = atOwnColumns ? Arr.map(fk.referencedColumns, (r) => r.column) : referenced
		const isReferenced = (column: string): boolean => Arr.some(landed, (r) => r === column)
		assert.ok(
			Arr.some(
				constraints,
				(x) =>
					x.table === target &&
					(x.constraint.kind === "unique" || x.constraint.kind === "primaryKey") &&
					x.constraint.columns.length === landed.length &&
					Arr.every(x.constraint.columns, (col) => isReferenced(col.column))
			),
			`a UNIQUE of ${m.target} over exactly ${Arr.join(landed, ", ")}`
		)
		const declared = Arr.some(
			KEYS[m.target],
			(k) =>
				k.length === referenced.length &&
				Arr.every(k, (field) =>
					Arr.contains(referenced, installation.names.column(m.target, field))
				)
		)
		if (!declared && !atOwnColumns) {
			shapes.push("a superkey's UNIQUE")
		}
	}
	assert.deepEqual(capturedTables(installation, law), [], "no capture for the rule")
	return shapes
}

/** A target side of R0 in the level box: its terms, one to three of R0's fields, and the fields it fixes, none of
 * them a term. */
interface LevelCase {
	readonly terms: Arr.NonEmptyReadonlyArray<string>
	readonly fixed: ReadonlyArray<string>
	/** Whether S stands on the level below R0's, rather than above it. */
	readonly lowerSource: boolean
}

export const levelGen: Gen<LevelCase> = (s) => {
	const terms = nonEmpty(
		s.draw(subset(FIELDS.R0, { min: 1, max: SOURCE.length })),
		"a side's terms"
	)
	return {
		terms,
		fixed: s.draw(subarray(Arr.filter(FIELDS.R0, (field) => !terms.includes(field)))),
		lowerSource: s.draw(element([false, true]))
	}
}

/** The level box's schema: a containment of S into R0's side, each on the level its case draws. */
export const levelSchemaOf = (c: LevelCase): SchemaDesc => {
	const [first, ...rest] = c.fixed
	const target =
		first === undefined
			? on("R0", c.terms)
			: onWhere(
					"R0",
					c.terms,
					Arr.reduce(
						rest,
						compare("eq", { kind: "field", field: first }, literal(3)),
						(conjunction, field): ExprDesc => ({
							kind: "and",
							args: [conjunction, compare("eq", { kind: "field", field }, literal(3))]
						})
					)
				)
	const statements = [contained(on("S", Arr.take(SOURCE, c.terms.length)), target)]
	return c.lowerSource
		? layered([
				{ relations: [S], statements: [] },
				{ relations: [R0], statements }
			])
		: layered([
				{ relations: [R0], statements: [] },
				{ relations: [S], statements }
			])
}

/** What the level box notes: the level rule's verdict, a superkey, and constants. */
export type LevelFeature = "admitted" | "refused" | "a superkey" | "constants"
