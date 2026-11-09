/**
 * lawsOf(schema) lists exactly the laws the schema's installation can report, each once, in the schema's canonical order.
 *
 * Each case draws a schema of one or two levels: a family core as the family swarm draws it (test/pg/write/swarm/spec.ts:
 * ordered and counted families, trees, folds of every monoid, copies along every axis, generated fields, plain sets and
 * referrers, keys, checks, containments and selections over copies, mutable relations), beside tables under names drawn
 * apart from name order, each keyed by its id or by its id and a span of a checked contract, with fields drawn apart
 * from name order: texts of a palette pattern spelled plainly, with every atom grouped, or respelled as a longer run of
 * the same language, so one domain comes in spellings whose CHECKs differ and tautologies such as `^.*$` under `su` come
 * up beside refined patterns; contracts over a palette pattern; integers; two bigint contracts of one definition, which
 * share a domain with the span's; and a contract that refines nothing; and generated integers and refined texts read
 * from those fields. Statements over the tables restate a primary key, key an integer, key a selection, check a row,
 * contain one table's ids in another's, mirror two tables, cover one table's spans by another's and make a table
 * mutable, a statement drawn twice standing twice; an alternatives law over a roster and a closed relation of a palette
 * pattern's payload may stand beside them. On two levels the tables stand above the core, which may restate core
 * statements.
 *
 * The oracle is the installation's own constraint-to-law map (adapter/witness/keylaw.ts keyLawsOf), the map a refusal is
 * read through: the laws of every table constraint, unique index and domain constraint the install script creates, read
 * under the table or domain that owns it as PostgreSQL reports a violation; every law a write statement's refusal
 * raises; and the generated law of every column the script creates. Every law it can report is in lawsOf exactly once,
 * by sameLaw, and lawsOf holds no law it cannot report. The order is held to the case's declarations: lawsOf opens with
 * each ordinary relation's primary key by relation name, as the relation declares it, and closes with the pattern law of
 * every stored text field whose column a planned text domain types, spelled as the case declares it, then the law of
 * every generated field, each by relation name and each relation's fields in declared order; between them every contract's
 * law follows every statement's, by contract name; and the same schema declared in another order of its relations and
 * statements lists the same laws in the same order. Planted in a scratch copy, lawsOf leaving out the primary keys, the
 * pattern laws or the generated laws, listing a law twice, or ordering the pattern laws by declaration each fail it.
 *
 * lawsByStatement(schema) looks up exactly the laws each statement states. The oracle is the naming door and the
 * installation: each owned statement a statement value is (a mirrors' two containments), owned alone over the schema's
 * levels and matched among the schema's owned statements by identity text, and every law of the installation's theory
 * that holds one, as the installation describes the law its objects report. Every statement of the schema, and every
 * statement of its twin built again in another order, gives exactly those laws, in lawsOf's order, each one the
 * installation can report, a key restating a span primary key the primary key's law it shares; every law lawsOf lists
 * is some statement's, a primary key's, a contract's, a pattern's or a generated field's, and every statement's law is
 * one lawsOf lists. A statement of another drawn schema gives the laws the installation's theory holds for it when this
 * schema states it, and is refused as MalformedDescription when it does not, as is a copy of a statement no builder
 * made. Planted in a scratch copy, a mirrors giving only its first containment, and a key restating a primary key given
 * a key law of its own instead of the primary key's, each fail it.
 *
 * constraintNamesOf(schema) gives each check law lawsOf lists the name the installation reports it under on its
 * relation's table, through the same constraint-to-law map.
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	element,
	type Gen,
	int,
	oneOf,
	shuffled,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import type { Source } from "@grizzle/testing/source"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec } from "effect"
import { keyLawsData } from "#adapter/served/refusals.ts"
import { keyLawsOf as keyLawsOver, noLevelAbove } from "#adapter/witness/keylaw.ts"
import { admittedIdentifier } from "#compiler/core/identity.ts"
import type { StatementDesc } from "#compiler/ir/desc.ts"
import type { ConstraintOwner } from "#compiler/ir/products.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { sameLaw } from "#compiler/public/changeset.ts"
import { closedId, contract, pg, span, uuid } from "#compiler/public/fields.ts"
import {
	type AnyRelation,
	type AnySchema,
	closed,
	constraintNamesOf,
	lawsByStatement,
	lawsOf,
	type RowScalars,
	schema,
	type Statement
} from "#compiler/public/schema.ts"
import { generatedField, generatedRelation, relation } from "#compiler/schema/relation.ts"
import {
	alternativesBuilder,
	checkBuilder,
	containedBuilder,
	expansionDescOf,
	keyBuilder,
	mirrorsBuilder,
	mutableBuilder,
	onBuilder,
	selectBuilder,
	statementDescOf
} from "#compiler/schema/statements.ts"
import { type ColumnDef, type ObjectName, tableConstraints } from "#compiler/sql/ast.ts"
import { regexField } from "#compiler/text/field.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyClosed, Relation } from "#compiler/types/schema/relation.ts"
import { buildSwarm, featuresGen, type SwarmSpec, swarmSpecGen } from "#test/pg/write/swarm/spec.ts"
import { assert, defined, nonEmpty, throwsRefused } from "#test/support/assert.ts"
import { relationName } from "#test/support/families/fill.ts"
import {
	identityText,
	installationNamesOf,
	installationOf,
	ownedStatementText
} from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { upTo } from "#test/support/up-to.ts"
import { bareContract } from "#test/unit/schema/support.ts"

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
interface Spelled {
	readonly source: string
	readonly flags: Flags
}

/** The bigint contracts of one definition, `>= 0`, which share a domain with each other and with the span's endpoint. */
type Count = "Pos" | "Nonneg"

/** A table's field: a text of a pattern, a contract over a pattern, an integer, a count, or a contract that refines
 * nothing. */
type FieldCase =
	| { readonly kind: "text"; readonly pattern: Spelled }
	| { readonly kind: "textContract"; readonly pattern: Spelled }
	| { readonly kind: "integer" }
	| { readonly kind: "count"; readonly contract: Count }
	| { readonly kind: "brand" }

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

/** A statement over the tables, each table by its index. */
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
	readonly alternatives: boolean
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
				[1, () => ({ kind: "brand" })]
			])
		)

/** The fields of a kind a table holds, by name. */
const fieldsOfKind = (t: TableCase, kind: FieldCase["kind"]): ReadonlyArray<string> =>
	Arr.flatMap(t.fields, ([name, f]) => (f.kind === kind ? [name] : []))

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
		const texts = fieldsOfKind(drawnTable, "text")
		const sources: ReadonlyArray<Gen<GeneratedCase>> = [
			...(Arr.isReadonlyArrayNonEmpty(integers)
				? [(s: Source): GeneratedCase => ({ kind: "integer", from: s.draw(element(integers)) })]
				: []),
			...(Arr.isReadonlyArrayNonEmpty(texts)
				? [
						(s: Source): GeneratedCase => ({
							kind: "text",
							from: s.draw(element(texts)),
							pattern: s.draw(spelledGen(palette))
						})
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
							kind: "primary key",
							table: s.draw(element(tableIndices))
						}),
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
		alternatives: source.draw(boolean),
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

const caseGen: Gen<LawsCase> = (source) => ({
	...source.draw(schemaCaseGen),
	other: source.draw(schemaCaseGen)
})

const textOf = (pattern: Spelled): FieldBase =>
	pattern.flags === "u" ? regexField(pattern.source, ["u"]) : regexField(pattern.source, ["su"])

/** The contracts of one definition, `>= 0` over a bigint: the counts and the span's endpoint. */
const counts: Readonly<Record<Count, FieldBase>> = {
	Pos: contract("Pos", pg.bigint, (c) => c.ge(0n)),
	Nonneg: contract("Nonneg", pg.bigint, (c) => c.ge(0n))
}
const Minute = contract("Minute", pg.bigint, (m) => m.ge(0n))
const Brand = contract("Brand", pg.bigint)

const fieldOf = (t: TableCase, name: string, f: FieldCase): FieldBase => {
	switch (f.kind) {
		case "text":
			return textOf(f.pattern)
		case "textContract":
			return bareContract(`${t.name}_${name}`, textOf(f.pattern))
		case "integer":
			return pg.integer
		case "count":
			return counts[f.contract]
		case "brand":
			return Brand
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
		id: uuid,
		...(t.keyed === "span" ? { w: span(Minute) } : {}),
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
							generatedField(g.kind === "integer" ? pg.integer : textOf(g.pattern), row[g.from], [])
						])
					),
				[]
			)
		: relation(t.name, written, keyOf(t), [])
}

const Kind = closed("Kind", ["plain", "lima", "oscar"])
const Kilo = relation("Kilo", { id: uuid, kind: closedId(Kind) }, ["id"], [])
const Lima = relation("Lima", { kilo: uuid, note: pg.integer }, ["kilo"], [])
const Oscar = relation("Oscar", { kilo: uuid }, ["kilo"], [])
const Key = closed("Key", ["one"])

/** A level's relations by name and its statements, in the order the case declares them. */
interface Level {
	readonly relations: ReadonlyArray<readonly [string, AnyRelation | AnyClosed]>
	readonly statements: ReadonlyArray<Statement>
}

/** The case's levels: the core's, and the tables' beside it or above it. */
const levelsOf = (
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
	const tables: Level = {
		relations: [
			...Arr.map(values, (v) => [v.name, v] as const),
			...(c.alternatives
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
			})
		],
		statements: [
			...statements,
			...(c.alternatives
				? [alternativesBuilder(Kilo, "kind", Kind, { lima: Lima, oscar: Oscar })]
				: [])
		]
	}
	const base: Level = { relations: Rec.toEntries(core.relations), statements: core.statements }
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
const reordered = <A>(items: ReadonlyArray<A>, r: Reorder): ReadonlyArray<A> => {
	const at = items.length === 0 ? 0 : r.by % items.length
	const rotated = [...Arr.drop(items, at), ...Arr.take(items, at)]
	return r.reversed ? Arr.reverse(rotated) : rotated
}

/** The case's schema, each level's relations and statements in the order `order` puts them. */
const subjectOf = (
	c: SchemaCase,
	order: <A>(items: ReadonlyArray<A>) => ReadonlyArray<A>
): AnySchema => {
	const { base, above } = levelsOf(c)
	const declared = schema("Laws", Rec.fromEntries(order(base.relations)), order(base.statements))
	return Option.match(above, {
		onNone: () => declared,
		onSome: (level) =>
			schema.extend(
				declared,
				"LawsAbove",
				Rec.fromEntries(order(level.relations)),
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
			relations: [...installation.checked.relations.values()]
		}),
		noLevelAbove,
		installation.names.codes
	)

/**
 * Whether the installation reports the check `law` under `name` on its relation's table, as PostgreSQL reports the
 * violation of a row check's CHECK or a derived check's trigger: by the table and the constraint's name.
 */
const reportsCheckAs = (
	installation: Installation,
	law: Extract<Law, { readonly kind: "check" }>,
	name: string
): boolean => {
	const found = keyLawsOf(installation).lawsOf(admittedIdentifier(name), {
		kind: "table",
		name: installation.names.relation(law.relation).name
	})
	return found !== undefined && Arr.some(found.laws, (l) => sameLaw(l.described, law))
}

/**
 * Every law an installed object of `installation` can report, through the installation's own constraint-to-law map
 * (adapter/witness/keylaw.ts keyLawsOf, as adapter/served/refusals.ts installationWitness builds it): the laws of each table
 * constraint, unique index and domain constraint the install script creates, read under the table or domain that owns
 * it, as PostgreSQL reports a violation's constraint and owner; every law a write statement's refusal raises; and the
 * generated law of each column the script creates, which a NOT NULL violation reports. Each as often as an object
 * reports it.
 */
const reportable = (installation: Installation): ReadonlyArray<Law> => {
	const map = keyLawsOf(installation)
	const installed = (name: ObjectName): boolean => map.schemas.has(name.schema)
	const native = (owner: ConstraintOwner, constraint: string): ReadonlyArray<Law> => {
		const found = map.lawsOf(admittedIdentifier(constraint), owner)
		return found === undefined
			? []
			: [...Arr.map(found.laws, (l) => l.described), ...Arr.map(found.uses, (u) => u.law.described)]
	}
	const ofTable = (table: ObjectName, constraint: string): ReadonlyArray<Law> =>
		installed(table)
			? native({ kind: "table", name: admittedIdentifier(table.name) }, constraint)
			: []
	const ofColumn = (table: ObjectName, column: ColumnDef): ReadonlyArray<Law> =>
		installed(table)
			? Option.toArray(
					Option.map(
						Option.fromNullishOr(
							map.generatedOf(admittedIdentifier(table.name), admittedIdentifier(column.name))
						),
						(refused) => refused.law
					)
				)
			: []
	const created = Arr.flatMap(installation.statements, (s): ReadonlyArray<Law> => {
		switch (s.kind) {
			case "createTable":
				return [
					...Arr.flatMap(tableConstraints(s), (c) => ofTable(s.table, c.name)),
					...Arr.flatMap(s.columns, (column) => ofColumn(s.table, column))
				]
			case "alterTable":
				return Arr.flatMap(s.actions, (a): ReadonlyArray<Law> => {
					switch (a.kind) {
						case "addColumn":
						case "addColumnPlaceholder":
						case "addColumnDefault":
							return ofColumn(s.table, a.column)
						case "addConstraint":
							return ofTable(s.table, a.constraint.name)
						case "addConstraintUsingIndex":
							return ofTable(s.table, a.name)
						case "dropColumn":
						case "dropDefault":
						case "alterColumnType":
						case "addIdentity":
						case "dropIdentity":
						case "validateConstraint":
						case "dropConstraint":
						case "enableRowSecurity":
						case "disableRowSecurity":
						case "setExpression":
							return []
					}
				})
			case "createIndex":
				return s.unique ? ofTable(s.table, s.name) : []
			case "createConstraintTrigger":
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
			case "rename":
			case "renameColumn":
			case "renameConstraint":
			case "lockTable":
			case "createGuardTrigger":
			case "dropTrigger":
			case "createMaterializedView":
			case "drop":
			case "revoke":
			case "createStatistics":
			case "dropIndex":
			case "createFunction":
			case "createConstant":
			case "packConstant":
			case "dropFunction":
			case "refresh":
			case "dropPolicy":
			case "alterDatabaseDefault":
			case "revokeRole":
			case "alterDefaultPrivileges":
			case "createExtension":
			case "select":
			case "analyze":
			case "comment":
			case "insert":
			case "update":
			case "delete":
			case "merge":
			case "createCarrier":
			case "begin":
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
	return [...created, ...Arr.map([...map.raised.values()], (l) => l.described)]
}

/** The owned statements a statement value is: a mirrors' two containments, any other statement itself. */
const ownedAs = (statement: Statement): Arr.NonEmptyReadonlyArray<StatementDesc> => {
	const expansion = expansionDescOf(statement)
	return expansion === undefined
		? [defined(statementDescOf(statement), "a built statement's description")]
		: expansion.statements
}

/**
 * The laws a statement states in `installation`, through the naming door: each owned statement the value is, owned alone
 * over the installation's levels (ownedStatementText) and matched by identity text among its owned statements, and every
 * law of its theory that holds one, in theory order, described as the installation describes the law its objects
 * report. None when the installation states not every owned statement the value is.
 */
const statedBy = (
	installation: Installation
): ((statement: Statement) => Option.Option<ReadonlyArray<Law>>) => {
	const { owned, theory } = installation.laws
	const texts = Arr.map(owned.statements, identityText)
	const indexOf = (desc: StatementDesc): Option.Option<number> => {
		const text = ownedStatementText(owned.desc, desc)
		return text.ok ? Arr.findFirstIndex(texts, (t) => t === text.value) : Option.none()
	}
	return (statement) =>
		Option.map(Option.all(Arr.map(ownedAs(statement), indexOf)), (indices) =>
			Arr.map(
				Arr.filter(theory.laws, (law) => Arr.some(law.statements, (i) => indices.includes(i))),
				(law) =>
					defined(
						installation.described.get(law.id),
						`the installation describes the law ${law.id}`
					)
			)
		)
}

/** The law kinds an outcome can name, each a coverage feature: a kind a case never lists fails the search. */
const lawKinds = {
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
	generated: "a generated law"
} as const satisfies { readonly [K in Exclude<Law["kind"], "above">]: `a ${K} law` }

type LawsFeature =
	| (typeof lawKinds)[Exclude<Law["kind"], "above">]
	| "a pattern grizzle erases"
	| "one domain over two fields"
	| "one domain spelled two ways"
	| "a contract over a pattern"
	| "two contracts of one domain"
	| "a contract that refines nothing"
	| "a generated refined text"
	| "a key restating the primary key"
	| "a mirrors"
	| "an alternatives law"
	| "a statement declared twice"
	| "a statement restated a level above"
	| "a level above"
	| "a check's installed name"
	| "another order listing the same laws"
	| "a statement stating no law"
	| "a law two statements state"
	| "a key sharing the primary key's law"
	| "an equal statement built again"
	| "a statement of another schema stated here"
	| "a statement of another schema refused"
	| "a value no builder made refused"

type PatternLaw = Extract<Law, { readonly kind: "pattern" }>

/** A relation's fields in declared order with what each states beside its column's law: a table's written fields,
 * then its generated ones. */
const declaredFields = (
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

describe("lawsOf", () => {
	it.effect(
		"lists exactly the laws the installation can report, each once, in the schema's canonical order",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/program/laws",
						draw: drawn(caseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the installation's constraint-to-law map, the naming door's owned statements, and the case's declared keys, patterns and generated fields"
						},
						coverage: required<LawsFeature>(
							[
								"a pattern grizzle erases",
								"one domain over two fields",
								"one domain spelled two ways",
								"a contract over a pattern",
								"two contracts of one domain",
								"a contract that refines nothing",
								"a generated refined text",
								"a key restating the primary key",
								"a mirrors",
								"an alternatives law",
								"a statement declared twice",
								"a statement restated a level above",
								"a level above",
								"another order listing the same laws",
								"a statement stating no law",
								"a law two statements state",
								"a key sharing the primary key's law",
								"an equal statement built again",
								"a statement of another schema stated here",
								"a statement of another schema refused",
								"a value no builder made refused",
								"a check's installed name",
								...Rec.values(lawKinds)
							],
							{ cases: 120, sense: notesOnly }
						),
						kept: [],
						runs: 120,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							const subject = subjectOf(c, (items) => items)
							const laws = lawsOf(subject)
							const installation = installationOf(subject, { kind: "declared" })
							const names = installationNamesOf(installation)
							const reported = reportable(installation)
							const constraintNameOf = constraintNamesOf(subject)
							for (const law of laws) {
								if (law.kind === "check") {
									assert.ok(
										reportsCheckAs(installation, law, constraintNameOf(law)),
										`the installation reports the check ${Formatter.format(law)} under the name constraintNamesOf gives it`
									)
									k.note("a check's installed name")
								}
							}

							for (const [i, law] of laws.entries()) {
								assert.equal(
									Arr.filter(laws, (other) => sameLaw(law, other)).length,
									1,
									`lawsOf lists its ${law.kind} law at ${String(i)} once`
								)
								assert.ok(
									Arr.some(reported, (r) => sameLaw(law, r)),
									`the installation can report lawsOf's ${law.kind} law at ${String(i)}: ${Formatter.format(law)}`
								)
								if (law.kind === "above") {
									assert.fail(
										`lawsOf lists no law of a level above its schema: ${Formatter.format(law)}`
									)
								} else {
									k.note(lawKinds[law.kind])
								}
							}
							for (const law of reported) {
								assert.ok(
									Arr.some(laws, (l) => sameLaw(law, l)),
									`lawsOf lists the ${law.kind} law the installation can report: ${Formatter.format(law)}`
								)
							}

							const { base, above } = levelsOf(c)
							const relations = Arr.sort(
								Arr.flatMap([base, ...Option.toArray(above)], (level) =>
									Arr.flatMap(level.relations, ([, r]): ReadonlyArray<AnyRelation> =>
										r.kind === "relation" ? [r] : []
									)
								),
								Order.mapInput(Order.String, (r: AnyRelation) => r.name)
							)
							const primaryKeys = Arr.map(relations, (r): Law => ({
								kind: "primaryKey",
								relation: r.name,
								fields: r.primaryKey
							}))
							const domainAt = (relation: string, field: string) =>
								Arr.findFirst(names.installation.textDomains, (d) =>
									Arr.some(
										d.uses,
										(u) =>
											u.table === names.tableIdent({ name: relation }) &&
											u.column === names.columnIdent({ name: relation }, field)
									)
								)
							const tableAt = (name: string) => Arr.findFirst(c.tables, (t) => t.name === name)
							const patterns = Arr.flatMap(relations, (r) =>
								Option.match(tableAt(r.name), {
									onNone: () => [],
									onSome: (t) =>
										Arr.flatMap(declaredFields(t), ([field, pattern]): ReadonlyArray<PatternLaw> =>
											Option.isSome(pattern) && Option.isSome(domainAt(r.name, field))
												? [
														{
															kind: "pattern",
															relation: r.name,
															field,
															patterns: [
																{ source: pattern.value.source, flags: pattern.value.flags }
															]
														}
													]
												: []
										)
								})
							)
							const generated = Arr.flatMap(relations, (r): ReadonlyArray<Law> => {
								const core = Arr.findFirst(
									c.core.fill.relations,
									(_, i) => relationName(i) === r.name
								)
								return Option.isSome(core)
									? core.value.generated
										? [{ kind: "generated", relation: r.name, field: "g" }]
										: []
									: Option.match(tableAt(r.name), {
											onNone: () => [],
											onSome: (t) =>
												Arr.map(t.generated, ([field]): Law => ({
													kind: "generated",
													relation: r.name,
													field
												}))
										})
							})
							const middle = Arr.drop(
								Arr.take(laws, laws.length - patterns.length - generated.length),
								primaryKeys.length
							)
							assert.deepEqual(
								laws,
								[...primaryKeys, ...middle, ...patterns, ...generated],
								"lawsOf opens with the primary keys and closes with the pattern laws, then the generated fields' laws, as the case declares them"
							)
							const contracts = Arr.flatMap(middle, (l) =>
								l.kind === "contract" ? [l.contract] : []
							)
							assert.deepEqual(
								Arr.drop(middle, middle.length - contracts.length),
								Arr.map(Arr.sort(contracts, Order.String), (contract): Law => ({
									kind: "contract",
									contract
								})),
								"every contract's law follows every statement's, by contract name"
							)
							const twin = subjectOf(c, (items) => reordered(items, c.reorder))
							assert.deepEqual(
								lawsOf(twin),
								laws,
								"the schema declared in another order lists the same laws in the same order"
							)
							if (
								Arr.join(Rec.keys(twin.relations), " ") !==
								Arr.join(Rec.keys(subject.relations), " ")
							) {
								k.note("another order listing the same laws")
							}

							const lawsOfStatement = lawsByStatement(subject)
							const stated = statedBy(installation)
							const looked = Arr.map(subject.statements, (statement) => ({
								texts: Arr.join(Arr.map(ownedAs(statement), identityText), " "),
								laws: lawsOfStatement(statement)
							}))
							for (const statement of [...subject.statements, ...twin.statements]) {
								const expected = Option.getOrThrowWith(
									stated(statement),
									() => new Error(`the installation states its ${statement.kind}`)
								)
								const got = lawsOfStatement(statement)
								assert.deepEqual(
									got,
									expected,
									`lawsByStatement gives the laws the installation's ${statement.kind} states, in lawsOf's order`
								)
								for (const law of got) {
									assert.ok(
										Arr.some(reported, (r) => sameLaw(law, r)),
										`the installation can report the ${statement.kind}'s ${law.kind} law: ${Formatter.format(law)}`
									)
								}
								if (got.length === 0) {
									k.note("a statement stating no law")
								}
								throwsRefused(
									() => lawsOfStatement({ ...statement }),
									"MalformedDescription",
									`a copy of the ${statement.kind} no builder made is no statement of the schema`
								)
								k.note("a value no builder made refused")
							}
							if (twin.statements.length > 0) {
								k.note("an equal statement built again")
							}
							for (const [i, a] of looked.entries()) {
								for (const b of Arr.drop(looked, i + 1)) {
									if (
										a.texts !== b.texts &&
										Arr.some(a.laws, (l) => Arr.some(b.laws, (m) => sameLaw(l, m)))
									) {
										k.note("a law two statements state")
									}
								}
							}
							if (Arr.some(looked, (l) => Arr.some(l.laws, (law) => law.kind === "primaryKey"))) {
								k.note("a key sharing the primary key's law")
							}
							const fromStatements = Arr.flatMap(looked, (l) => l.laws)
							const unstated = [
								...primaryKeys,
								...Arr.filter(reported, (l) => l.kind === "contract"),
								...patterns,
								...generated
							]
							for (const law of laws) {
								assert.ok(
									Arr.some([...fromStatements, ...unstated], (l) => sameLaw(law, l)),
									`lawsOf's ${law.kind} law is a statement's, a primary key's, a contract's, a pattern's or a generated field's: ${Formatter.format(law)}`
								)
							}
							for (const law of fromStatements) {
								assert.ok(
									Arr.some(laws, (l) => sameLaw(law, l)),
									`lawsOf lists the ${law.kind} law a statement states: ${Formatter.format(law)}`
								)
							}
							for (const statement of subjectOf(c.other, (items) => items).statements) {
								Option.match(stated(statement), {
									onNone: () => {
										throwsRefused(
											() => lawsOfStatement(statement),
											"MalformedDescription",
											`a ${statement.kind} of another schema this one does not state is refused`
										)
										k.note("a statement of another schema refused")
									},
									onSome: (expected) => {
										assert.deepEqual(
											lawsOfStatement(statement),
											expected,
											`a ${statement.kind} of another schema this one states gives the laws it states here`
										)
										k.note("a statement of another schema stated here")
									}
								})
							}

							for (const t of c.tables) {
								for (const [field, f] of t.fields) {
									switch (f.kind) {
										case "text":
											if (Option.isNone(domainAt(t.name, field))) {
												k.note("a pattern grizzle erases")
											}
											break
										case "textContract":
											k.note("a contract over a pattern")
											break
										case "brand":
											k.note("a contract that refines nothing")
											break
										case "integer":
										case "count":
											break
									}
								}
								for (const [field, g] of t.generated) {
									if (g.kind === "text" && Option.isSome(domainAt(t.name, field))) {
										k.note("a generated refined text")
									}
								}
							}
							for (const domain of names.installation.textDomains) {
								const spelled = Arr.flatMap(patterns, (p) =>
									Option.exists(domainAt(p.relation, p.field), (d) => d.name === domain.name)
										? [
												Arr.join(
													Arr.map(p.patterns, (q) => q.source),
													" & "
												)
											]
										: []
								)
								if (spelled.length > 1) {
									k.note("one domain over two fields")
								}
								if (new Set(spelled).size > 1) {
									k.note("one domain spelled two ways")
								}
							}
							for (const cl of installation.constraintLaws) {
								if (
									cl.kind === "domainConstraint" &&
									Arr.filter(cl.laws, (l) => l.described.kind === "contract").length > 1
								) {
									k.note("two contracts of one domain")
								}
							}
							for (const s of c.statements) {
								switch (s.kind) {
									case "primary key":
										k.note("a key restating the primary key")
										break
									case "mirrors":
										k.note("a mirrors")
										break
									case "key":
									case "selected key":
									case "check":
									case "contained":
									case "coverage":
									case "mutable":
										break
								}
							}
							if (
								new Set(Arr.map(c.statements, (s) => Formatter.format(s))).size <
								c.statements.length
							) {
								k.note("a statement declared twice")
							}
							if (c.alternatives) {
								k.note("an alternatives law")
							}
							if (c.levels.kind === "above") {
								k.note("a level above")
								if (c.levels.restated.length > 0) {
									k.note("a statement restated a level above")
								}
							}
						})
				)
			)
	)
})
