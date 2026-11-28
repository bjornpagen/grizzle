/** What the properties of laws.test.ts read: its spaces, models and helpers. */

import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import {
	array,
	boolean,
	element,
	type Gen,
	int,
	oneOf,
	shuffled,
	weighted
} from "@bjornpagen/testing/gen"
import type { Source } from "@bjornpagen/testing/source"
import { Array as Arr, Option, Record as Rec } from "effect"
import { keyLawsData } from "#adapter/served/refusals.ts"
import { keyLawsOf as keyLawsOver, noLevelAbove } from "#adapter/witness/keylaw.ts"
import { encode, withoutSourceLocs } from "#compiler/core/canonical.ts"
import { admittedIdentifier } from "#compiler/core/identity.ts"
import type { StatementDesc } from "#compiler/ir/desc.ts"
import type { ConstraintOwner } from "#compiler/ir/products.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { sameLaw } from "#compiler/public/changeset.ts"
import { Logic } from "#compiler/public/compute.ts"
import { closedId, domain, range, variant, int4, int8 } from "#compiler/public/fields.ts"
import {
	type AnyRelation,
	type AnySchema,
	closed,
	type RowScalars,
	schema,
	type Statement
} from "#compiler/public/schema.ts"
import { namedAbove, namedLaw } from "#compiler/runtime/law-entry.ts"
import {
	generatedField,
	generatedRelation,
	relationBuilder as relation
} from "#compiler/schema/relation.ts"
import {
	checkBuilder,
	containedBuilder,
	expansionDescOf,
	keyBuilder,
	mirrorsBuilder,
	mutableBuilder,
	onBuilder,
	sealedBuilder,
	selectBuilder,
	statementDescOf,
	unitBuilder
} from "#compiler/schema/statements.ts"
import { type ColumnDef, type ObjectName, tableConstraints } from "#compiler/sql/ast.ts"
import { regexField } from "#compiler/text/field.ts"
import type { IdentifiedLaw, Law, OwnLaw } from "#compiler/types/changeset/changeset.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyClosed, Relation } from "#compiler/types/schema/relation.ts"
import { Id } from "#test/support/ids.ts"
import { identityText, ownedStatementText } from "#test/support/kernel/naming.ts"
import { opened } from "#test/support/open.ts"
import {
	buildSwarm,
	featuresGen,
	type SwarmSpec,
	swarmSpecGen
} from "#test/support/pg/write/swarm/spec.ts"
import { jsMatcher } from "#test/support/regex.ts"
import { bareContract } from "#test/support/unit/schema/support.ts"
import { upTo } from "#test/support/up-to.ts"

type Flags = "u" | "su"

type Quantifier = "" | "*" | "+" | "?" | "{0,3}"

/** A pattern's atom, quantified. */
interface Part {
	readonly atom: string
	readonly quantifier: Quantifier
}

/** A pattern of the palette: its quantified atoms between `^` and `$`, under its flags. */
interface Pattern {
	readonly parts: Arr.NonEmptyReadonlyArray<Part>
	readonly flags: Flags
}

/** A pattern as a field declares it. */
export interface Spelled {
	readonly source: string
	readonly flags: Flags
}

/** The bigint contracts of one definition, `>= 0`, which share a domain with each other and with the span's endpoint. */
type Count = "Pos" | "Nonneg"

/** A table's field: a text of a pattern, a contract over a pattern, an integer, a count, a contract that refines
 * nothing, or a variant of its own whose arms hold a text of a pattern and a count. */
type FieldCase =
	| { readonly kind: "text"; readonly pattern: Spelled }
	| { readonly kind: "textContract"; readonly pattern: Spelled }
	| { readonly kind: "integer" }
	| { readonly kind: "count"; readonly contract: Count }
	| { readonly kind: "brand" }
	| { readonly kind: "variant"; readonly pattern: Spelled; readonly contract: Count }

/** A generated field: an integer read from an integer field, or a refined text read from a text field. */
type GeneratedCase =
	| { readonly kind: "integer"; readonly from: string }
	| { readonly kind: "text"; readonly from: string; readonly pattern: Spelled }

/** A table: keyed by its id, or by its id and its span `w` of minutes, a no-overlap key. */
interface TableCase {
	readonly name: string
	readonly keyed: "id" | "span"
	readonly fields: ReadonlyArray<readonly [name: string, field: FieldCase]>
	readonly generated: ReadonlyArray<readonly [name: string, field: GeneratedCase]>
}

/**
 * A statement over the tables, each table by its index. A "primary key" restates its table's primary key, which no
 * schema admits: the property adds one to a drawn case to see it refused, and no case draws one.
 */
type StatementCase =
	| { readonly kind: "primary key"; readonly table: number }
	| { readonly kind: "key"; readonly table: number; readonly field: string }
	| { readonly kind: "selected key"; readonly table: number; readonly field: string }
	| { readonly kind: "check"; readonly table: number; readonly field: string }
	| { readonly kind: "contained"; readonly from: number; readonly to: number }
	| { readonly kind: "mirrors"; readonly left: number; readonly right: number }
	| { readonly kind: "coverage"; readonly from: number; readonly to: number }
	| { readonly kind: "mutable"; readonly table: number }

/** The schema's levels: one, or the tables a level above the core, restating the core's statements at these indices. */
type Levels =
	| { readonly kind: "one" }
	| { readonly kind: "above"; readonly restated: ReadonlyArray<number> }

/** Another order of a list: rotated by `by` places, then reversed or not. */
interface Reorder {
	readonly by: number
	readonly reversed: boolean
}

/** A drawn schema: its family core, its tables, their statements, its levels and another order of its declarations. */
interface SchemaCase {
	readonly core: SwarmSpec
	readonly tables: ReadonlyArray<TableCase>
	readonly statements: ReadonlyArray<StatementCase>
	/** Whether Kilo's kind is a tagged header whose lima and oscar arms each mirror the kilos of their kind. */
	readonly arms: boolean
	/** Whether the tables' level holds a sealed unit, Victor over Victor and Whiskey (`victorUnit`). */
	readonly sealed: boolean
	readonly payload: Option.Option<Spelled>
	readonly levels: Levels
	readonly reorder: Reorder
}

/** A drawn schema beside another drawn apart from it, whose statements the first may state or not. */
interface LawsCase extends SchemaCase {
	readonly other: SchemaCase
}

const partGen: Gen<Part> = (source) => ({
	atom: source.draw(element([".", "[\\d\\D]", "[^a]", "a", "[a-c]", "(?:a|[^a])", "\\d"])),
	quantifier: source.draw(
		weighted<Quantifier>([
			[4, element<Quantifier>(["*"])],
			[1, element<Quantifier>(["", "+", "?", "{0,3}"])]
		])
	)
})

const patternGen: Gen<Pattern> = (source) => ({
	parts: nonEmpty(source.draw(array(partGen, { min: 1, max: 2 })), "a pattern's parts"),
	flags: source.draw(element<Flags>(["u", "su"]))
})

/** How a field spells a palette pattern: as drawn, each atom in a group of its own, or each quantified atom respelled
 * as a longer run of the same language, `x*` as `x*x?`. */
type Spelling = "plain" | "grouped" | "respelled"

/** A quantified atom as a spelling writes it, every spelling of one part matching alike. */
const partSpelled = (p: Part, spelling: Spelling): string => {
	switch (spelling) {
		case "plain":
			return `${p.atom}${p.quantifier}`
		case "grouped":
			return `(?:${p.atom})${p.quantifier}`
		case "respelled":
			switch (p.quantifier) {
				case "*":
					return `${p.atom}*${p.atom}?`
				case "+":
					return `${p.atom}${p.atom}*`
				case "?":
					return `${p.atom}{0,1}`
				case "{0,3}":
					return `${p.atom}?${p.atom}{0,2}`
				case "":
					return `${p.atom}{1}`
			}
	}
}

const spelledGen =
	(palette: Arr.NonEmptyReadonlyArray<Pattern>): Gen<Spelled> =>
	(source) => {
		const pattern = source.draw(element(palette))
		const spelling = source.draw(element<Spelling>(["plain", "grouped", "respelled"]))
		return {
			source: `^${Arr.join(
				Arr.map(pattern.parts, (p) => partSpelled(p, spelling)),
				""
			)}$`,
			flags: pattern.flags
		}
	}

const fieldGen =
	(palette: Arr.NonEmptyReadonlyArray<Pattern>): Gen<FieldCase> =>
	(source) =>
		source.draw(
			weighted<FieldCase>([
				[5, (s) => ({ kind: "text", pattern: s.draw(spelledGen(palette)) })],
				[2, (s) => ({ kind: "textContract", pattern: s.draw(spelledGen(palette)) })],
				[3, () => ({ kind: "integer" })],
				[2, (s) => ({ kind: "count", contract: s.draw(element<Count>(["Pos", "Nonneg"])) })],
				[1, () => ({ kind: "brand" })],
				[
					1,
					(s) => ({
						kind: "variant",
						pattern: s.draw(spelledGen(palette)),
						contract: s.draw(element<Count>(["Pos", "Nonneg"]))
					})
				]
			])
		)

/** The fields of a kind a table holds, by name. */
const fieldsOfKind = (t: TableCase, kind: FieldCase["kind"]): ReadonlyArray<string> =>
	Arr.flatMap(t.fields, ([name, f]) => (f.kind === kind ? [name] : []))

/**
 * The texts a witness of two palette patterns' overlap is searched among: every text of at most six characters over
 * `a`, `b`, `0` and `x`, the empty one first. Each palette atom's class is a union of the classes these four stand for
 * (`a`; `b`, which `[a-c]` holds and `a` does not; a digit; anything else), and every class that holds a line terminator
 * holds `x` too, so two quantified atoms meet at one of them wherever they meet at all; and two patterns of at most two
 * quantified atoms each that share a text share one of at most six characters, since a longer one keeps a character
 * that an unbounded atom of each pattern holds with another beside it, whose deletion leaves a shorter shared text.
 */
const overlapCandidates: ReadonlyArray<string> = Arr.flatMap(
	Array.from({ length: 7 }, (_, length) => length),
	(length) =>
		Arr.reduce(
			Array.from({ length }, () => ["a", "b", "0", "x"] as const),
			[""],
			(prefixes: ReadonlyArray<string>, letters) =>
				Arr.flatMap(prefixes, (prefix) => Arr.map(letters, (c) => `${prefix}${c}`))
		)
)

/**
 * The palette's patterns some text matches together with `read`, by an ECMAScript search over the candidates
 * (`overlapCandidates`): a generated field whose declared text shares no value with the text its expression reads is
 * refused when the schema compiles (check/generated.ts, `disjoint`), so a table draws a generated text only of a pattern
 * that meets the field it reads, `read`'s own palette pattern among them.
 */
const meeting = (
	palette: Arr.NonEmptyReadonlyArray<Pattern>,
	read: Spelled
): Arr.NonEmptyReadonlyArray<Pattern> => {
	const shared = Arr.filter(overlapCandidates, jsMatcher(read.source, read.flags))
	return nonEmpty(
		Arr.filter(palette, (p) => {
			const plain = plainSpelled(p)
			return Arr.some(shared, jsMatcher(plain.source, plain.flags))
		}),
		"the palette's patterns that meet a text field's, its own among them"
	)
}

/** A palette pattern as a field spells it plainly, which every spelling of it matches alike. */
const plainSpelled = (pattern: Pattern): Spelled => ({
	source: `^${Arr.join(
		Arr.map(pattern.parts, (p) => partSpelled(p, "plain")),
		""
	)}$`,
	flags: pattern.flags
})

const tableGen =
	(palette: Arr.NonEmptyReadonlyArray<Pattern>, name: string): Gen<TableCase> =>
	(source) => {
		const fields = Arr.map(
			source.draw(shuffled(["zeta", "code", "alpha", "mid"], { min: 0, max: 4 })),
			(field) => [field, source.draw(fieldGen(palette))] as const
		)
		const drawnTable: TableCase = {
			name,
			keyed: source.draw(element<TableCase["keyed"]>(["id", "span"])),
			fields,
			generated: []
		}
		const integers = fieldsOfKind(drawnTable, "integer")
		const texts = Arr.flatMap(drawnTable.fields, ([name, f]) =>
			f.kind === "text" ? [{ name, pattern: f.pattern }] : []
		)
		const sources: ReadonlyArray<Gen<GeneratedCase>> = [
			...(Arr.isReadonlyArrayNonEmpty(integers)
				? [(s: Source): GeneratedCase => ({ kind: "integer", from: s.draw(element(integers)) })]
				: []),
			...(Arr.isReadonlyArrayNonEmpty(texts)
				? [
						(s: Source): GeneratedCase => {
							const read = s.draw(element(texts))
							return {
								kind: "text",
								from: read.name,
								pattern: s.draw(spelledGen(meeting(palette, read.pattern)))
							}
						}
					]
				: [])
		]
		return Arr.isReadonlyArrayNonEmpty(sources)
			? {
					...drawnTable,
					generated: Arr.map(
						source.draw(shuffled(["gamma", "beta"], { min: 0, max: 2 })),
						(field) => [field, source.draw(oneOf(sources))] as const
					)
				}
			: drawnTable
	}

/** The statements a case's tables admit: a key, a selected key and a check over an integer, a containment and a
 * mirrors between two tables keyed by their ids, a coverage between two keyed by their spans. */
const statementGens = (
	tables: ReadonlyArray<TableCase>
): Arr.NonEmptyReadonlyArray<Gen<StatementCase>> => {
	const indexed = Arr.map(tables, (t, i) => ({ t, i }))
	const integral = Arr.flatMap(indexed, ({ t, i }) =>
		Arr.map(fieldsOfKind(t, "integer"), (field) => ({ table: i, field }))
	)
	const pairs = (keyed: TableCase["keyed"]) => {
		const of = Arr.flatMap(indexed, ({ t, i }) => (t.keyed === keyed ? [i] : []))
		return Arr.flatMap(of, (a) => Arr.flatMap(of, (b) => (a === b ? [] : [{ a, b }])))
	}
	const ids = pairs("id")
	const spans = pairs("span")
	const tableIndices = Arr.map(indexed, ({ i }) => i)
	return nonEmpty(
		[
			...(Arr.isReadonlyArrayNonEmpty(tableIndices)
				? [
						(s: Source): StatementCase => ({
							kind: "mutable",
							table: s.draw(element(tableIndices))
						})
					]
				: []),
			...(Arr.isReadonlyArrayNonEmpty(integral)
				? Arr.map(
						["key", "selected key", "check"] as const,
						(kind) =>
							(s: Source): StatementCase => ({ kind, ...s.draw(element(integral)) })
					)
				: []),
			...(Arr.isReadonlyArrayNonEmpty(ids)
				? [
						(s: Source): StatementCase => {
							const { a, b } = s.draw(element(ids))
							return { kind: "contained", from: a, to: b }
						},
						(s: Source): StatementCase => {
							const { a, b } = s.draw(element(ids))
							return { kind: "mirrors", left: a, right: b }
						}
					]
				: []),
			...(Arr.isReadonlyArrayNonEmpty(spans)
				? [
						(s: Source): StatementCase => {
							const { a, b } = s.draw(element(spans))
							return { kind: "coverage", from: a, to: b }
						}
					]
				: [])
		],
		"the statements a case admits"
	)
}

const schemaCaseGen: Gen<SchemaCase> = (source) => {
	const core = source.draw(swarmSpecGen(source.draw(featuresGen), false))
	const palette = nonEmpty(source.draw(array(patternGen, { min: 1, max: 3 })), "the palette")
	const names = source.draw(
		shuffled(["Tango", "Bravo", "Sierra", "Alpha", "Mike"], { min: 0, max: 5 })
	)
	const tables = Arr.map(names, (name) => source.draw(tableGen(palette, name)))
	const gens = Arr.isReadonlyArrayNonEmpty(tables)
		? Option.some(statementGens(tables))
		: Option.none()
	const statements = Option.match(gens, {
		onNone: () => [],
		onSome: (g) => {
			const once = source.draw(array(oneOf(g), { min: 0, max: 6 }))
			const twice = Arr.isReadonlyArrayNonEmpty(once) && source.draw(boolean)
			return twice ? [...once, source.draw(element(once))] : once
		}
	})
	const coreStatements = buildSwarm(core).rename("Laws").statements.length
	return {
		core,
		tables,
		statements,
		arms: source.draw(boolean),
		sealed: source.draw(boolean),
		payload: source.draw(boolean) ? Option.some(source.draw(spelledGen(palette))) : Option.none(),
		levels: source.draw(boolean)
			? {
					kind: "above",
					restated: source.draw(
						shuffled(
							upTo(coreStatements, (i) => i),
							{ min: 0, max: Math.min(2, coreStatements) }
						)
					)
				}
			: { kind: "one" },
		reorder: { by: source.draw(int(0, 64)), reversed: source.draw(boolean) }
	}
}

export const caseGen: Gen<LawsCase> = (source) => ({
	...source.draw(schemaCaseGen),
	other: source.draw(schemaCaseGen)
})

const textOf = (pattern: Spelled): FieldBase =>
	pattern.flags === "u" ? regexField(pattern.source, ["u"]) : regexField(pattern.source, ["su"])

const nonnegKey = Symbol("Nonneg")
const posKey = Symbol("Pos")
/** The contracts of one definition, `>= 0` over a bigint: the counts and the span's endpoint. */
const counts: Readonly<Record<Count, FieldBase>> = {
	Pos: domain<typeof posKey>()("Pos", int8, (c) => Logic.ge(c, 0n)),
	Nonneg: domain<typeof nonnegKey>()("Nonneg", int8, (c) => Logic.ge(c, 0n))
}

const minuteKey = Symbol("Minute")
const Minute = domain<typeof minuteKey>()("Minute", int8, (m) => Logic.ge(m, 0n))

const brandKey = Symbol("Brand")
const Brand = domain<typeof brandKey>()("Brand", int8)

/** The arms of every variant a table's field holds: a text of a pattern, or a count. */
const Arm = closed.unordered("Arm", ["word", "count"])

/** The name of the variant a table's field holds, its own: the table's and the field's. */
export const variantName = (t: TableCase, name: string): string => `${t.name}_${name}`

const fieldOf = (t: TableCase, name: string, f: FieldCase): FieldBase => {
	switch (f.kind) {
		case "text":
			return textOf(f.pattern)
		case "textContract":
			return bareContract(`${t.name}_${name}`, textOf(f.pattern))
		case "integer":
			return int4
		case "count":
			return counts[f.contract]
		case "brand":
			return Brand
		case "variant":
			return variant(variantName(t, name), Arm, {
				word: { word: textOf(f.pattern) },
				count: { count: counts[f.contract] }
			})
	}
}

type BuiltRelation = Relation<
	string,
	Record<string, FieldBase>,
	readonly [string, ...Array<string>]
>

/** The row a selection's or a check's predicate reads, as a predicate over a relation built at run time reads it. */
type Row = RowScalars<BuiltRelation>

const term = (row: Row, name: string) => defined(row[name], `the field ${name}`)

const keyOf = (t: TableCase): readonly [string, ...Array<string>] =>
	t.keyed === "id" ? ["id"] : ["id", "w"]

const tableOf = (t: TableCase): BuiltRelation => {
	const written: Record<string, FieldBase> = {
		id: Id,
		...(t.keyed === "span" ? { w: range(Minute) } : {}),
		...Rec.fromEntries(Arr.map(t.fields, ([name, f]) => [name, fieldOf(t, name, f)] as const))
	}
	return Arr.isReadonlyArrayNonEmpty(t.generated)
		? generatedRelation(
				t.name,
				written,
				keyOf(t),
				(row) =>
					Rec.fromEntries(
						Arr.map(t.generated, ([name, g]) => [
							name,
							generatedField(g.kind === "integer" ? int4 : textOf(g.pattern), row[g.from], [])
						])
					),
				[]
			)
		: relation(t.name, written, keyOf(t), [])
}

const Kind = closed.ordered("Kind", ["plain", "lima", "oscar"])

const Kilo = relation("Kilo", { id: Id, kind: closedId(Kind) }, ["id"], [])

const Lima = relation("Lima", { kilo: Id, note: int4 }, ["kilo"], [])

const Oscar = relation("Oscar", { kilo: Id }, ["kilo"], [])

/** The kilos of one kind, a mirrors' side. */
const kilosOf = (kind: "lima" | "oscar") =>
	onBuilder(
		selectBuilder(Kilo, (k: RowScalars<typeof Kilo>) => k.eq(k.kind, kind)),
		["id"]
	)

/** Kilo's kind's arms: Lima mirrored with the lima kilos, Oscar with the oscar kilos. */
const kiloArms: ReadonlyArray<Statement> = [
	mirrorsBuilder(onBuilder(Lima, ["kilo"]), kilosOf("lima")),
	mirrorsBuilder(onBuilder(Oscar, ["kilo"]), kilosOf("oscar"))
]

const Key = closed.ordered("Key", ["one"])

/** A relation of a sealed unit, keyed by the unit's heading alone. */
const Victor = relation("Victor", { victor: Id, note: int4 }, ["victor"], [])

/** A relation of the sealed unit, keyed wider. */
const Whiskey = relation("Whiskey", { victor: Id, at: int4 }, ["victor", "at"], [])

/** The sealed unit over Victor and Whiskey, whose seal law lawsOf lists last. */
const victorUnit = sealedBuilder(unitBuilder("Victor", { victor: Id }, []), [])

/** A level's relations by name and its statements, in the order the case declares them. */
interface Level {
	readonly relations: ReadonlyArray<readonly [string, AnyRelation | AnyClosed]>
	readonly statements: ReadonlyArray<Statement>
}

/** The case's levels: the core's, and the tables' beside it or above it. */
export const levelsOf = (
	c: SchemaCase
): { readonly base: Level; readonly above: Option.Option<Level> } => {
	const core = buildSwarm(c.core).rename("Laws")
	const values = Arr.map(c.tables, tableOf)
	const valueAt = (i: number): BuiltRelation => defined(values[i], `the table ${String(i)}`)
	const sideOf = (i: number, terms: ReadonlyArray<string>) => onBuilder(valueAt(i), terms)
	const statements = Arr.map(c.statements, (s): Statement => {
		switch (s.kind) {
			case "primary key":
				return keyBuilder(sideOf(s.table, keyOf(defined(c.tables[s.table], "a table"))))
			case "key":
				return keyBuilder(sideOf(s.table, [s.field]))
			case "selected key":
				return keyBuilder(
					onBuilder(
						selectBuilder(valueAt(s.table), (row: Row) => row.gt(term(row, s.field), 0)),
						[s.field]
					)
				)
			case "check":
				return checkBuilder(`Bounded_${s.field}`, valueAt(s.table), (row: Row) =>
					row.ge(term(row, s.field), 0)
				)
			case "contained":
				return containedBuilder(sideOf(s.from, ["id"]), sideOf(s.to, ["id"]))
			case "mirrors":
				return mirrorsBuilder(sideOf(s.left, ["id"]), sideOf(s.right, ["id"]))
			case "coverage":
				return containedBuilder(sideOf(s.from, ["id", "w"]), sideOf(s.to, ["id", "w"]))
			case "mutable":
				return mutableBuilder(valueAt(s.table))
		}
	})
	/**
	 * The units the mutable tables sit in (test/support/open.ts opened), stated on the base level, the core's: a unit is
	 * stated at or below every relation under it, and the core's relations key by id first, as every table does.
	 */
	const units = Arr.filter(
		opened(Arr.flatMap(c.statements, (s) => (s.kind === "mutable" ? [valueAt(s.table)] : []))),
		(s) => statementDescOf(s)?.kind === "unit"
	)
	const tables: Level = {
		relations: [
			...Arr.map(values, (v) => [v.name, v] as const),
			...(c.arms
				? [
						["Kind", Kind] as const,
						["Kilo", Kilo] as const,
						["Lima", Lima] as const,
						["Oscar", Oscar] as const
					]
				: []),
			...Option.match(c.payload, {
				onNone: () => [],
				onSome: (payload) => [
					["Key", Key] as const,
					[
						"Payload",
						closed.relation("Payload", { key: closedId(Key), value: textOf(payload) }, ["key"], [])
					] as const
				]
			}),
			...(c.sealed ? [["Victor", Victor] as const, ["Whiskey", Whiskey] as const] : []),
			...(Arr.some(c.tables, (t) => Arr.some(t.fields, ([, f]) => f.kind === "variant"))
				? [["Arm", Arm] as const]
				: [])
		],
		statements: [...statements, ...(c.arms ? kiloArms : []), ...(c.sealed ? [victorUnit] : [])]
	}
	const base: Level = {
		relations: Rec.toEntries(core.relations),
		statements: [...core.statements, ...units]
	}
	switch (c.levels.kind) {
		case "one":
			return {
				base: {
					relations: [...base.relations, ...tables.relations],
					statements: [...base.statements, ...tables.statements]
				},
				above: Option.none()
			}
		case "above":
			return {
				base,
				above: Option.some({
					relations: tables.relations,
					statements: [
						...tables.statements,
						...Arr.map(c.levels.restated, (i) => defined(core.statements[i], "a core statement"))
					]
				})
			}
	}
}

/** A list in another order: rotated, then reversed or not. */
export const reordered = <A>(items: ReadonlyArray<A>, r: Reorder): ReadonlyArray<A> => {
	const at = items.length === 0 ? 0 : r.by % items.length
	const rotated = [...Arr.drop(items, at), ...Arr.take(items, at)]
	return r.reversed ? Arr.reverse(rotated) : rotated
}

/** The case's schema, each level's relations and statements in the order `order` puts them. */
export const subjectOf = (
	c: SchemaCase,
	order: <A>(items: ReadonlyArray<A>) => ReadonlyArray<A>
): AnySchema => {
	const { base, above } = levelsOf(c)
	const declared = schema(
		"Laws",
		Rec.values(Rec.fromEntries(order(base.relations))),
		order(base.statements)
	)
	return Option.match(above, {
		onNone: () => declared,
		onSome: (level) =>
			schema.extend(
				[declared],
				"LawsAbove",
				Rec.values(Rec.fromEntries(order(level.relations))),
				order(level.statements)
			)
	})
}

/** The installation's own constraint-to-law map, as adapter/served/refusals.ts installationWitness builds it. */
const keyLawsOf = (installation: Installation) =>
	keyLawsOver(
		keyLawsData({
			names: installation.names,
			constraintLaws: installation.constraintLaws,
			theoryLaws: installation.theoryLaws,
			relations: [...installation.checked.relations.values()],
			rosters: new Set(installation.names.codes.rosters.keys()),
			generatedEntries: installation.laws.owned.declared.generated
		}),
		noLevelAbove,
		installation.names.codes
	)

/**
 * Whether the installation reports the check `law` under `name` on its relation's table, as PostgreSQL reports the
 * violation of a row check's CHECK or a derived check's trigger: by the table and the constraint's name.
 */
export const reportsCheckAs = (
	installation: Installation,
	law: Extract<Law, { readonly kind: "check" }>,
	name: string
): boolean => {
	const found = keyLawsOf(installation).lawsOf(admittedIdentifier(name), {
		kind: "table",
		name: installation.names.relation(law.relation).name
	})
	return (
		found?.kind === "object" && Arr.some(found.laws, (l) => sameLaw(namedLaw(l.described), law))
	)
}

/**
 * Every law an installed object of `installation` can report, through the installation's own constraint-to-law map
 * (adapter/witness/keylaw.ts keyLawsOf, as adapter/served/refusals.ts installationWitness builds it): the laws of each table
 * constraint, unique index and domain constraint the install script creates, read under the table or domain that owns
 * it, as PostgreSQL reports a violation's constraint and owner; every law a write statement's refusal raises; and the
 * generated law of each column the script creates, which a NOT NULL violation reports; and the seal law each seal
 * trigger's refusal reports under the trigger's name. Each as often as an object reports it.
 */
export const reportable = (installation: Installation): ReadonlyArray<IdentifiedLaw> => {
	const map = keyLawsOf(installation)
	const installed = (name: ObjectName): boolean => map.schemas.has(name.schema)
	const native = (owner: ConstraintOwner, constraint: string): ReadonlyArray<IdentifiedLaw> => {
		const found = map.lawsOf(admittedIdentifier(constraint), owner)
		if (found === undefined) {
			return []
		}
		switch (found.kind) {
			case "object":
				return Arr.map(found.laws, (l) => ({ law: namedLaw(l.described), id: l.law }))
			case "domain":
				return Arr.map(found.uses, (u) => ({ law: namedLaw(u.law.described), id: u.law.law }))
			case "aboveCheck":
				return [{ law: namedAbove(found.law.described), id: found.law.law }]
			case "above":
				return Arr.map(found.laws, (l) => ({ law: namedAbove(l.described), id: l.law }))
		}
	}
	const ofTable = (table: ObjectName, constraint: string): ReadonlyArray<IdentifiedLaw> =>
		installed(table)
			? native({ kind: "table", name: admittedIdentifier(table.name) }, constraint)
			: []
	const ofColumn = (table: ObjectName, column: ColumnDef): ReadonlyArray<IdentifiedLaw> =>
		installed(table)
			? Option.toArray(
					Option.map(
						Option.fromNullishOr(
							map.generatedOf(admittedIdentifier(table.name), admittedIdentifier(column.name))
						),
						(refused) => ({ law: refused.law, id: refused.id })
					)
				)
			: []
	const created = Arr.flatMap(installation.statements, (s): ReadonlyArray<IdentifiedLaw> => {
		switch (s.kind) {
			case "createTable":
				return [
					...Arr.flatMap(tableConstraints(s), (c) => ofTable(s.table, c.name)),
					...Arr.flatMap(s.columns, (column) => ofColumn(s.table, column))
				]
			case "alterTable":
				return Arr.flatMap(s.actions, (a): ReadonlyArray<IdentifiedLaw> => {
					switch (a.kind) {
						case "addColumn":
						case "addColumnPlaceholder":
						case "addColumnDefault":
						case "addColumnUnchecked":
							return ofColumn(s.table, a.column)
						case "addConstraint":
							return ofTable(s.table, a.constraint.name)
						case "addConstraintUsingIndex":
							return ofTable(s.table, a.name)
						case "dropColumn":
						case "dropDefault":
						case "setNotNull":
						case "alterColumnType":
						case "validateConstraint":
						case "alterConstraintDeferral":
						case "dropConstraint":
						case "enableRowSecurity":
						case "disableRowSecurity":
						case "replicaIdentity":
						case "setExpression":
							return []
					}
				})
			case "createIndex":
				return s.unique ? ofTable(s.table, s.name) : []
			case "createConstraintTrigger":
			case "createTransitionTrigger":
				return ofTable(s.table, s.name)
			case "createDomain":
				return installed(s.name)
					? Arr.flatMap(s.constraints, (c) =>
							native({ kind: "domain", name: admittedIdentifier(s.name.name) }, c.name)
						)
					: []
			case "alterDomain":
				return installed(s.name) && s.action.kind === "addConstraint"
					? native(
							{ kind: "domain", name: admittedIdentifier(s.name.name) },
							s.action.constraint.name
						)
					: []
			case "alterRowType":
			case "rename":
			case "replaceConstant":
			case "renameColumn":
			case "renameConstraint":
			case "lockTable":
			case "createGuardTrigger":
			case "createImmutableGuardTrigger":
			case "createPublication":
			case "dropPublication":
			case "createLiveSecret":
			case "dropTrigger":
			case "createDeclaredFunction":
			case "handOverFunction":
			case "createRowType":
			case "adoptRole":
			case "endHolders":
			case "createStoredTable":
			case "drop":
			case "revoke":
			case "dropIndex":
			case "createFunction":
			case "createConstant":
			case "stubConstant":
			case "packConstant":
			case "dropFunction":
			case "fillStored":
			case "dropPolicy":
			case "guardBracket":
			case "revokeRole":
			case "alterDefaultPrivileges":
			case "createExtension":
			case "select":
			case "comment":
			case "insert":
			case "update":
			case "delete":
			case "merge":
			case "beginRead":
			case "beginWrite":
			case "commit":
			case "rollback":
			case "setConstraintsImmediate":
			case "createSchema":
			case "createView":
			case "createPolicy":
			case "grantColumns":
			case "grantRole":
			case "createRole":
			case "alterRole":
			case "grant":
				return []
		}
	})
	return [
		...created,
		...Arr.map([...map.raised.values()], (l) => ({ law: namedLaw(l.described), id: l.law }))
	]
}

/** The owned statements a statement value is: a mirrors' two containments, any other statement itself. */
export const ownedAs = (statement: Statement): Arr.NonEmptyReadonlyArray<StatementDesc> => {
	const expansion = expansionDescOf(statement)
	return expansion === undefined
		? [defined(statementDescOf(statement), "a built statement's description")]
		: expansion.statements
}

/**
 * The laws a statement states in `installation`, through the naming door: each owned statement the value is, owned alone
 * over the installation's levels (ownedStatementText) and matched by identity text among its owned statements, and every
 * law of its theory that holds one, in theory order, described as the installation describes the law its objects
 * report; then a sealed unit's seal law, as the installation's constraint map describes it (physical/ddl/seal.ts). None
 * when the installation states not every owned statement the value is.
 */
export const statedBy = (
	installation: Installation
): ((statement: Statement) => Option.Option<ReadonlyArray<OwnLaw>>) => {
	const { owned, theory } = installation.laws
	const texts = Arr.map(owned.statements, identityText)
	const indexOf = (desc: StatementDesc): Option.Option<number> => {
		const text = ownedStatementText(owned.desc, desc)
		return text.ok ? Arr.findFirstIndex(texts, (t) => t === text.value) : Option.none()
	}
	const seals = Arr.flatMap(installation.constraintLaws, (c) =>
		c.kind === "constraint"
			? Arr.flatMap(c.laws, (l) => (l.described.kind === "sealed" ? [l.described] : []))
			: []
	)
	const sealOf = (desc: StatementDesc): ReadonlyArray<OwnLaw> =>
		desc.kind === "unit" && desc.sealed
			? Arr.take(
					Arr.map(
						Arr.filter(seals, (l) => l.unit === desc.name),
						namedLaw
					),
					1
				)
			: []
	return (statement) =>
		Option.map(Option.all(Arr.map(ownedAs(statement), indexOf)), (indices) => [
			...Arr.map(
				Arr.filter(theory.laws, (law) => Arr.some(law.statements, (i) => indices.includes(i))),
				(law) =>
					namedLaw(
						defined(
							installation.described.get(law.id),
							`the installation describes the law ${law.id}`
						)
					)
			),
			...Arr.flatMap(ownedAs(statement), sealOf)
		])
}

/** The law kinds an outcome can name, each a coverage feature: a kind a case never lists fails the search. */
export const lawKinds = {
	primaryKey: "a primaryKey law",
	key: "a key law",
	check: "a check law",
	contained: "a contained law",
	coverage: "a coverage law",
	family: "a family law",
	tree: "a tree law",
	fold: "a fold law",
	contract: "a contract law",
	pattern: "a pattern law",
	variant: "a variant law",
	generated: "a generated law",
	sealed: "a sealed law"
} as const satisfies { readonly [K in OwnLaw["kind"]]: `a ${K} law` }

export type LawsFeature =
	| (typeof lawKinds)[OwnLaw["kind"]]
	| "a pattern grizzle erases"
	| "one domain over two fields"
	| "one domain spelled two ways"
	| "a contract over a pattern"
	| "two contracts of one domain"
	| "a contract that refines nothing"
	| "a generated refined text"
	| "a key restating the primary key refused"
	| "a mirrors"
	| "a tagged header's arms"
	| "a statement declared twice"
	| "a statement restated a level above"
	| "a level above"
	| "a check's installed name"
	| "an arm's field's domain beside a stored field's"
	| "another order listing the same laws"
	| "a statement stating no law"
	| "a law two statements state"
	| "an equal statement built again"
	| "a statement of another schema stated here"
	| "a statement of another schema refused"
	| "a value no builder made refused"

export type PatternLaw = Extract<Law, { readonly kind: "pattern" }>

/** A relation's fields in declared order with what each states beside its column's law: a table's written fields,
 * then its generated ones. */
export const declaredFields = (
	t: TableCase
): ReadonlyArray<readonly [name: string, pattern: Option.Option<Spelled>]> => [
	...Arr.map(
		t.fields,
		([name, f]) => [name, f.kind === "text" ? Option.some(f.pattern) : Option.none()] as const
	),
	...Arr.map(
		t.generated,
		([name, g]) => [name, g.kind === "text" ? Option.some(g.pattern) : Option.none()] as const
	)
]

/**
 * A law's canonical text apart from its source locations (core/canonical.ts withoutSourceLocs), the identity sameLaw
 * compares; none for a law that has none. A list's laws are encoded once and compared by their texts.
 */
export const lawText = (law: Law): Option.Option<string> => {
	const text = encode(law, withoutSourceLocs)
	return text.ok ? Option.some(text.value) : Option.none()
}

/** Whether two laws' texts (lawText) are one law's, as sameLaw says: both encoded, and equal. */
export const sameLawText = (a: Option.Option<string>, b: Option.Option<string>): boolean =>
	Option.isSome(a) && Option.isSome(b) && a.value === b.value
