/**
 * A containment into a derived relation whose definition is a key-shaped conjunction of stored relations lowers to
 * native foreign keys (analysis/theory/laws.ts RuleLowering): one DEFERRABLE INITIALLY DEFERRED foreign key per match
 * of the definition, from the source's columns, then a constant column of the source for each constant the match fixes,
 * into a UNIQUE of the match's relation over exactly the fields it references, its declared key's own or a superkey of
 * it; and the rule then holds no trigger. Every other rule over a query keeps its triggers. The law oracle's
 * conservative installation (physical/install/compile.ts conservativeInstallation) keeps the triggers of every rule,
 * under the same laws.
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
 * literal, into exactly a UNIQUE or the primary key of its relation, mapped to the rule's law, and no trigger of the
 * rule; kept, the rule's triggers on S and every relation it matches and no foreign key from S. The conservative
 * installation keeps the triggers in every case, and both name the rule by one law. The law model's trigger laws over
 * each of S, R0 and R1 (laws/model/model.ts triggerLawsOver), which the isolation certifier reads, are the rule's law
 * exactly when it keeps its triggers and its query mentions the relation, by its source, a match or its negation.
 *
 * A second box states the level rule (schema/own.ts #checkLevels) over every target side of R0 on a level below S, its
 * terms one to three of R0's fields and its selection constants on others: the containment is admitted exactly when
 * the target's fields and constants hold a key R0 declares, whose UNIQUE, a superkey's where it is no key exactly, the
 * upper level installs; from a source on the level below, exactly into an unselected one.
 *
 * Planted in a scratch copy, each of these fails the first box: a lowering that drops a match's constant column; one
 * whose superkey plans no UNIQUE; and one that ignores condition 4, lowering a definition whose matches share a
 * variable of their own.
 */
import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import {
	array,
	element,
	type Gen,
	int,
	shuffled,
	subarray,
	subset,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	Record as Rec,
	String as Str
} from "effect"
import { indices } from "#compiler/core/array.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { LawId, RelationIdent } from "#compiler/core/ids.ts"
import * as Result from "#compiler/core/result.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { constraintLaw } from "#compiler/ir/products.ts"
import { compileLaws, triggerLawsOver } from "#compiler/laws/model/model.ts"
import {
	compileInstallation,
	conservativeInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { own } from "#compiler/schema/own.ts"
import { everySlice } from "#compiler/schema/reach.ts"
import {
	type ColumnDef,
	type ForeignKey,
	type SqlStatement,
	type TableConstraint,
	tableConstraints
} from "#compiler/sql/ast.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { assert, defined, nonEmpty, succeeded } from "#test/support/assert.ts"
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
import { caseHang } from "#test/support/limits.ts"

type Target = "R0" | "R1"
type Level = "base" | "ledger"

const TARGETS: Arr.NonEmptyReadonlyArray<Target> = ["R0", "R1"]
const FIELDS: Readonly<Record<Target, ReadonlyArray<string>>> = {
	R0: ["id", "a", "b", "k"],
	R1: ["id", "a", "k"]
}
/** Each relation's declared keys: its primary key, and R0's key over (a, b). */
const KEYS: Readonly<Record<Target, ReadonlyArray<ReadonlyArray<string>>>> = {
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

const caseGen: Gen<LoweringCase> = weighted<LoweringCase>([
	[6, (s) => s.draw(drawnGen)],
	[1, (s) => s.draw(joinedGen)]
])

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

type Shape =
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
const brokenConditions = (c: LoweringCase): ReadonlyArray<Shape> => {
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
		["condition 1", c.breaks === "a second arm" || c.breaks === "a negation"],
		[
			"condition 2",
			c.breaks === "a literal head term" || c.breaks === "one variable at two head terms"
		],
		[
			"condition 3",
			c.breaks === "a condition no equality with a literal" ||
				c.breaks === "a head variable fixed to a literal"
		],
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
		extends: extending,
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
const schemaOf = (c: LoweringCase): SchemaDesc => {
	const on1 = (level: Level, r: AuthoredRelationDesc): ReadonlyArray<AuthoredRelationDesc> =>
		level === "ledger" ? [r] : []
	const on0 = (level: Level, r: AuthoredRelationDesc): ReadonlyArray<AuthoredRelationDesc> =>
		level === "base" ? [r] : []
	const rule: Layer = {
		relations: [{ kind: "derived", name: "D", level: 1, storage: "live", query: definitionOf(c) }],
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
const compiled = (
	desc: SchemaDesc,
	compile: typeof compileInstallation
): Result.Result<Installation, CompileError> =>
	Result.flatMap(own(decodedSchema(desc)), (owned) =>
		compile(owned, installOptions(owned, "grizzle_dev"))
	)

/** The relations the case's rule reads: S, every relation its definition matches, and the one it negates. */
const readBy = (c: LoweringCase): ReadonlyArray<string> => [
	"S",
	...Arr.map(c.matches, (m) => m.target),
	...(c.breaks === "a negation" ? ["R1"] : [])
]

/**
 * Asserts the installation's law model reports, for each of S, R0 and R1, exactly the rule's law when the rule keeps
 * its triggers and reads the relation, and no law otherwise (laws/model/model.ts triggerLawsOver).
 */
const assertTriggerLaws = (c: LoweringCase, desc: SchemaDesc, law: LawId, kept: boolean): void => {
	const model = succeeded(
		Result.flatMap(own(decodedSchema(desc)), (owned) =>
			compileLaws(owned, everySlice(owned), { kind: "planned" })
		)
	)
	for (const relation of ["S", "R0", "R1"]) {
		assert.deepEqual(
			triggerLawsOver(model, relation),
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

const tableOf = (installation: Installation, relation: string): RelationIdent =>
	installation.names.relation(relation).name

/** The value `found` holds, which the catalog must hold. */
const holding = <A>(found: Option.Option<A>, what: string): A =>
	Option.getOrThrowWith(found, () => new Error(`the catalog holds ${what}`))

/** The names under `table` the installation's law map maps to `law`. */
const namesFor = (installation: Installation, table: string, law: LawId): ReadonlyArray<string> =>
	Arr.flatMap(Rec.toEntries(installation.constraintToLaw.tables[table] ?? {}), ([name, l]) =>
		l === law ? [name] : []
	)

/** The rule's law as the installation names it: the one law S's table holds beside its primary key's. */
const ruleLaw = (installation: Installation): LawId => {
	const table = tableOf(installation, "S")
	const primaryName = holding(
		Arr.findFirst(
			constraintsOf(installation.statements),
			(c) => c.table === table && c.constraint.kind === "primaryKey"
		),
		"S's primary key"
	).constraint.name
	const primaryLaw = constraintLaw(
		installation.constraintToLaw,
		{ kind: "table", name: table },
		primaryName
	)
	const laws = Arr.filter(
		Arr.dedupe(Rec.values(installation.constraintToLaw.tables[table] ?? {})),
		(l) => l !== primaryLaw
	)
	assert.equal(laws.length, 1, "S's table names one law beside its primary key's")
	return defined(laws[0], "the rule's law")
}

/** The tables the installation holds a trigger of `law` on. */
const triggerTables = (installation: Installation, law: LawId): ReadonlyArray<string> =>
	Arr.flatMap(installation.statements, (s) =>
		s.kind === "createConstraintTrigger" &&
		namesFor(installation, s.table.name, law).includes(s.name)
			? [s.table.name]
			: []
	)

/** The foreign keys from S's table. */
const foreignKeysFromS = (installation: Installation): ReadonlyArray<ForeignKey> => {
	const table = tableOf(installation, "S")
	return Arr.flatMap(constraintsOf(installation.statements), (c) =>
		c.table === table && c.constraint.kind === "foreignKey" ? [c.constraint] : []
	)
}

/** Asserts `installation` keeps the rule's triggers, on S and every relation its definition matches, with no foreign
 * key from S. */
const assertKept = (c: LoweringCase, installation: Installation, law: LawId): void => {
	const held = triggerTables(installation, law)
	for (const relation of ["S", ...Arr.map(c.matches, (m) => m.target)]) {
		assert.ok(
			held.includes(tableOf(installation, relation)),
			`a trigger of the rule on ${relation}`
		)
	}
	assert.deepEqual(foreignKeysFromS(installation), [], "no foreign key from S")
}

/**
 * Asserts `installation` lowers the rule: one deferred foreign key per match from S's paired columns, then a constant
 * column per constant, each generated from its literal, into exactly a UNIQUE or the primary key of the match's
 * relation, each mapped to the rule's law, and no trigger of the rule. The shapes it met.
 */
const assertLowered = (
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
		const fk = holding(
			Arr.findFirst(
				keys,
				(k) =>
					k.references.name === target &&
					Arr.join(
						Arr.map(k.referencedColumns, (r) => r.column),
						", "
					) === over &&
					Arr.join(
						Arr.take(
							Arr.map(k.columns, (col) => col.column),
							heads.length
						),
						", "
					) === Arr.join(paired, ", ")
			),
			`a foreign key from S's ${Arr.join(paired, ", ")} into ${m.target} over ${over}`
		)
		assert.equal(fk.deferrable, "INITIALLY DEFERRED", "the foreign key is deferred")
		assert.equal(
			constraintLaw(installation.constraintToLaw, { kind: "table", name: sTable }, fk.name),
			law,
			"the foreign key names the rule's law"
		)
		const referencing = Arr.map(fk.columns, (col) => col.column)
		Arr.forEach(constants, (k, i) => {
			const name = defined(referencing[heads.length + i], "a constant column per constant")
			const generation = holding(
				Arr.findFirst(columns, (col) => col.column.name === name),
				`the constant column ${name} of S`
			).column.generated
			assert.ok(
				generation?.kind === "stored" && Str.includes(`${k.value}`)(printExpr(generation.expr)),
				`${name} is generated, stored, from ${k.value}`
			)
			shapes.push("a constant column")
		})
		const isReferenced = (column: string): boolean => Arr.some(referenced, (r) => r === column)
		assert.ok(
			Arr.some(
				constraints,
				(x) =>
					x.table === target &&
					(x.constraint.kind === "unique" || x.constraint.kind === "primaryKey") &&
					x.constraint.columns.length === referenced.length &&
					Arr.every(x.constraint.columns, (col) => isReferenced(col.column))
			),
			`a UNIQUE of ${m.target} over exactly ${over}`
		)
		const declared = Arr.some(
			KEYS[m.target],
			(k) =>
				k.length === referenced.length &&
				Arr.every(k, (field) => isReferenced(installation.names.column(m.target, field)))
		)
		if (!declared) {
			shapes.push("a superkey's UNIQUE")
		}
	}
	assert.deepEqual(triggerTables(installation, law), [], "no trigger of the rule")
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

const levelGen: Gen<LevelCase> = (s) => {
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
const levelSchemaOf = (c: LevelCase): SchemaDesc => {
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

describe("a containment into a key-shaped conjunction of stored relations", () => {
	it.effect(
		"lowers to one deferred foreign key per match exactly when its definition meets the seven conditions, and the conservative installation keeps its triggers under the same law",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/laws/lowered-rules",
						draw: drawn(caseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the seven conditions restated over the drawn definition, and the catalog of foreign keys, UNIQUEs, constant columns and triggers each implies"
						},
						coverage: required<Shape>(
							[
								"lowered",
								"kept",
								"two matches",
								"a constant column",
								"a superkey's UNIQUE",
								["lowered", "two matches"],
								["lowered", "a constant column"],
								["lowered", "a superkey's UNIQUE"],
								"condition 1",
								"condition 2",
								"condition 3",
								"condition 4",
								"condition 5",
								"condition 6",
								"condition 7",
								"the level rule"
							],
							{ cases: 400, sense: notesOnly }
						),
						kept: [],
						runs: 400,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const broken = brokenConditions(c)
							const desc = schemaOf(c)
							const lowered = succeeded(compiled(desc, compileInstallation))
							const conservative = succeeded(compiled(desc, conservativeInstallation))
							const law = ruleLaw(lowered)
							assert.equal(
								ruleLaw(conservative),
								law,
								"both installations name the rule by one law"
							)
							assertKept(c, conservative, law)
							if (c.matches.length > 1) {
								k.note("two matches")
							}
							const [only, ...more] = broken
							if (only !== undefined && more.length === 0) {
								k.note(only)
							}
							assertTriggerLaws(c, desc, law, only !== undefined)
							if (only !== undefined) {
								k.note("kept")
								assertKept(c, lowered, law)
								return
							}
							k.note("lowered")
							if (c.matches.length > 1) {
								k.pair("lowered", "two matches")
							}
							for (const shape of assertLowered(c, lowered, law)) {
								k.note(shape)
								k.pair("lowered", shape)
							}
						})
				)
			)
	)

	it.effect(
		"reaches a lower level's relation exactly through a side holding a key it declares, selected by constants only from a source above it",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/laws/lowered-rules/levels",
						generator: levelGen,
						literal: Formatter.format,
						limit: 200,
						box: "every target side of R0 over one to three of its fields, selected by constants on any of the others, from S on the level above R0 and on the level below it",
						oracle: {
							kind: "specification",
							name: "the level rule: a side whose fields and constants hold a key R0 declares, selected only from a source above it"
						},
						coverage: requiredInSpace<"admitted" | "refused" | "a superkey" | "constants">([
							"admitted",
							"refused",
							"a superkey",
							"constants"
						]),
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const held = [...c.terms, ...c.fixed]
							const keyed = Arr.some(KEYS.R0, (key) =>
								Arr.every(key, (field) => held.includes(field))
							)
							const admitted = keyed && (!c.lowerSource || c.fixed.length === 0)
							if (c.fixed.length > 0) {
								k.note("constants")
							}
							if (
								keyed &&
								!Arr.some(
									KEYS.R0,
									(key) =>
										key.length === held.length && Arr.every(key, (field) => held.includes(field))
								)
							) {
								k.note("a superkey")
							}
							const result = compiled(levelSchemaOf(c), compileInstallation)
							k.note(admitted ? "admitted" : "refused")
							if (admitted) {
								succeeded(result)
								return
							}
							assert.ok(
								!result.ok && result.error.reason._tag === "LevelRefused",
								"the containment is LevelRefused"
							)
						})
				)
			)
	)
})
