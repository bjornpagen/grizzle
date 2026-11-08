/**
 * patternLawsOf(schema) names exactly the pattern laws the installation records, each spelled as its field declares its
 * pattern.
 *
 * Each case draws a schema of one or two levels: ordinary relations under names drawn apart from name order, each with
 * fields drawn apart from name order, every field a text field of a pattern, a contract over a pattern, or an integer,
 * the patterns drawn from a small palette so fields share domains, each spelled plainly, with every atom grouped, or
 * respelled as a longer run of the same language (`x*` as `x*x?`), so one membership comes in spellings whose CHECKs
 * differ; beside them a closed relation whose payload is a palette pattern too. A pattern is `^`, one or two quantified
 * atoms, `$`, under `u` or `su`, so tautologies such as `^.*$` under `su` and `^(?:a|[^a])*$` come up beside refined
 * patterns.
 *
 * The oracle, read from the case and from the installation's text domain plan (physical/ddl/domains.ts
 * planTextDomains, which types each column), never from the law model: patternLawsOf is the text fields whose column a
 * planned domain types, by relation name, each relation's fields in declared order, each
 * `{ kind: "pattern", relation, field, source, flags }` as the case spelled it. Every pattern use a domain's constraint
 * records (Installation.constraintLaws) is one of those fields, each field is recorded once, under the planned domain
 * that types its column, and its recorded law is the field's (sameLaw).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, shuffled, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec } from "effect"
import { identifierOf } from "#compiler/core/identity.ts"
import { type TextDomain, textDomainIdentity } from "#compiler/physical/ddl/domains.ts"
import { sameLaw } from "#compiler/public/changeset.ts"
import { closedId, pg, uuid } from "#compiler/public/fields.ts"
import { type AnySchema, closed, patternLawsOf, relation, schema } from "#compiler/public/schema.ts"
import { regexField } from "#compiler/text/field.ts"
import { textLookup } from "#compiler/text/refinement.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import { assert, defined, nonEmpty } from "#test/support/assert.ts"
import { installationNamesOf, installationOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
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

type FieldCase =
	| { readonly kind: "text"; readonly pattern: Spelled }
	| { readonly kind: "contract"; readonly pattern: Spelled }
	| { readonly kind: "integer" }

interface RelationCase {
	readonly name: string
	readonly fields: ReadonlyArray<readonly [name: string, field: FieldCase]>
}

/** The schema's levels: one, or a level above the base holding relations of its own. */
type Levels =
	| { readonly kind: "one" }
	| { readonly kind: "above"; readonly relations: Arr.NonEmptyReadonlyArray<RelationCase> }

interface PatternLawsCase {
	readonly base: Arr.NonEmptyReadonlyArray<RelationCase>
	readonly levels: Levels
	readonly payload: Spelled
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

const spelled = (pattern: Pattern, spelling: Spelling): Spelled => ({
	source: `^${Arr.join(
		Arr.map(pattern.parts, (p) => partSpelled(p, spelling)),
		""
	)}$`,
	flags: pattern.flags
})

const spelledGen =
	(palette: Arr.NonEmptyReadonlyArray<Pattern>): Gen<Spelled> =>
	(source) =>
		spelled(
			source.draw(element(palette)),
			source.draw(element<Spelling>(["plain", "grouped", "respelled"]))
		)

const fieldGen =
	(palette: Arr.NonEmptyReadonlyArray<Pattern>): Gen<FieldCase> =>
	(source) =>
		source.draw(
			weighted<FieldCase>([
				[6, (s) => ({ kind: "text", pattern: s.draw(spelledGen(palette)) })],
				[2, (s) => ({ kind: "contract", pattern: s.draw(spelledGen(palette)) })],
				[1, () => ({ kind: "integer" })]
			])
		)

const relationGen =
	(palette: Arr.NonEmptyReadonlyArray<Pattern>, name: string): Gen<RelationCase> =>
	(source) => ({
		name,
		fields: Arr.map(
			source.draw(shuffled(["zeta", "code", "alpha", "mid"], { min: 0, max: 4 })),
			(field) => [field, source.draw(fieldGen(palette))] as const
		)
	})

const caseGen: Gen<PatternLawsCase> = (source) => {
	const palette = nonEmpty(source.draw(array(patternGen, { min: 1, max: 3 })), "the palette")
	const names = source.draw(
		shuffled(["Tango", "Bravo", "Sierra", "Alpha", "Mike"], { min: 1, max: 5 })
	)
	const split = source.draw(int(1, names.length))
	const relations = Arr.map(names, (name) => source.draw(relationGen(palette, name)))
	const base = nonEmpty(Arr.take(relations, split), "the base's relations")
	const above = Arr.drop(relations, split)
	return {
		base,
		levels: Arr.isReadonlyArrayNonEmpty(above)
			? { kind: "above", relations: above }
			: { kind: "one" },
		payload: source.draw(spelledGen(palette))
	}
}

const textOf = (pattern: Spelled): FieldBase =>
	pattern.flags === "u" ? regexField(pattern.source, ["u"]) : regexField(pattern.source, ["su"])

const fieldOf = (r: RelationCase, name: string, f: FieldCase): FieldBase => {
	switch (f.kind) {
		case "text":
			return textOf(f.pattern)
		case "contract":
			return bareContract(`${r.name}_${name}`, textOf(f.pattern))
		case "integer":
			return pg.integer
	}
}

const relationOf = (r: RelationCase) =>
	relation(
		r.name,
		{ id: uuid, ...Rec.fromEntries(Arr.map(r.fields, ([name, f]) => [name, fieldOf(r, name, f)])) },
		["id"]
	)

const relationsOf = (rs: ReadonlyArray<RelationCase>) =>
	Rec.fromEntries(Arr.map(rs, (r) => [r.name, relationOf(r)]))

type PatternLaw = Extract<Law, { readonly kind: "pattern" }>

/** The name of the domain a spelling's own definition gives, as the installation named a field's domain before it read
 * the plan: none for a pattern every text matches. */
const ownDomainName = (pattern: Spelled): Option.Option<string> => {
	const language = textLookup(pattern.source, pattern.flags)
	return language.ok && language.value.kind === "refined"
		? Option.some(
				identifierOf(
					textDomainIdentity({
						source: pattern.source,
						flags: pattern.flags,
						key: language.value.key,
						check: language.value.check
					})
				)
			)
		: Option.none()
}

const Key = closed("Key", ["one"])

/** The case's schema: its base, with the closed relation, and the level above when it has one. */
const subjectOf = (c: PatternLawsCase): AnySchema => {
	const Payload = closed.relation(
		"Payload",
		{ key: closedId(Key), value: textOf(c.payload) },
		["key"],
		[]
	)
	const base = schema("Patterns", { ...relationsOf(c.base), Key, Payload }, [])
	switch (c.levels.kind) {
		case "one":
			return base
		case "above":
			return schema.extend(base, relationsOf(c.levels.relations), [])
	}
}

const relationsAt = (c: PatternLawsCase): ReadonlyArray<RelationCase> => {
	switch (c.levels.kind) {
		case "one":
			return c.base
		case "above":
			return [...c.base, ...c.levels.relations]
	}
}

type PatternLawsFeature =
	| "a pattern grizzle erases"
	| "a refined pattern"
	| "a contract over a pattern"
	| "one domain over two fields"
	| "one domain spelled two ways"
	| "a spelling whose own definition the plan names no domain by"
	| "a field's domain the closed payload shares"
	| "a level above"
	| "relations declared apart from name order"

describe("patternLawsOf", () => {
	it.effect(
		"names exactly the pattern laws the installation records, by relation name, each relation's fields in declared order, each spelled as its field declares it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/program/pattern-laws",
						draw: drawn(caseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "the text fields whose column the installation's text domain plan types, spelled as the case declares them"
						},
						coverage: required<PatternLawsFeature>(
							[
								"a pattern grizzle erases",
								"a refined pattern",
								"a contract over a pattern",
								"one domain over two fields",
								"one domain spelled two ways",
								"a spelling whose own definition the plan names no domain by",
								"a field's domain the closed payload shares",
								"a level above",
								"relations declared apart from name order"
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
							const subject = subjectOf(c)
							const relations = relationsAt(c)
							const names = installationNamesOf(installationOf(subject, { kind: "declared" }))
							const domains = names.installation.textDomains
							const domainAt = (table: string, column: string): Option.Option<TextDomain> =>
								Arr.findFirst(domains, (d) =>
									Arr.some(d.uses, (u) => u.table === table && u.column === column)
								)
							const declared = Arr.flatMap(relations, (r) =>
								Arr.map(r.fields, ([field, f]) => ({
									relation: r.name,
									field,
									f,
									table: names.tableIdent({ name: r.name }),
									column: names.columnIdent({ name: r.name }, field)
								}))
							)
							const stating = (d: (typeof declared)[number]): ReadonlyArray<PatternLaw> =>
								d.f.kind === "text" && Option.isSome(domainAt(d.table, d.column))
									? [
											{
												kind: "pattern",
												relation: d.relation,
												field: d.field,
												source: d.f.pattern.source,
												flags: d.f.pattern.flags
											}
										]
									: []
							const byName: ReadonlyArray<RelationCase> = Arr.sortWith(
								relations,
								(r: RelationCase) => r.name,
								Order.String
							)
							const expected = Arr.flatMap(byName, (r) =>
								Arr.flatMap(declared, (d) => (d.relation === r.name ? stating(d) : []))
							)
							assert.deepEqual(patternLawsOf(subject), expected, "patternLawsOf")

							const recorded = Arr.flatMap(names.installation.constraintLaws, (cl) =>
								cl.kind === "domainConstraint"
									? Arr.flatMap(cl.uses, (use) =>
											use.law.described.kind === "pattern"
												? [{ owner: cl.owner, name: cl.name, use }]
												: []
										)
									: []
							)
							assert.equal(recorded.length, expected.length, "one recorded use per stated law")
							for (const { owner, name, use } of recorded) {
								const d = defined(
									Option.getOrUndefined(
										Arr.findFirst(declared, (x) => x.table === use.table && x.column === use.column)
									),
									`${use.table}.${use.column} is a declared field's column`
								)
								const domain = defined(
									Option.getOrUndefined(domainAt(use.table, use.column)),
									`${d.relation}.${d.field}'s column has a text domain`
								)
								assert.deepEqual(
									[owner, name],
									[domain.name, domain.constraint],
									`${d.relation}.${d.field}'s law is recorded under the domain that types its column`
								)
								const [law, ...more] = stating(d)
								assert.ok(
									law !== undefined && more.length === 0 && sameLaw(use.law.described, law),
									`${d.relation}.${d.field}'s recorded law is its own pattern law`
								)
							}

							for (const d of declared) {
								switch (d.f.kind) {
									case "text": {
										const domain = Option.getOrUndefined(domainAt(d.table, d.column))
										if (domain === undefined) {
											k.note("a pattern grizzle erases")
											break
										}
										k.note("a refined pattern")
										if (Option.exists(ownDomainName(d.f.pattern), (own) => own !== domain.name)) {
											k.note("a spelling whose own definition the plan names no domain by")
										}
										break
									}
									case "contract":
										k.note("a contract over a pattern")
										break
									case "integer":
										break
								}
							}
							for (const domain of domains) {
								const sources = Arr.flatMap(declared, (d) =>
									d.f.kind === "text" &&
									Option.exists(domainAt(d.table, d.column), (x) => x === domain)
										? [d.f.pattern.source]
										: []
								)
								if (sources.length > 1) {
									k.note("one domain over two fields")
								}
								if (new Set(sources).size > 1) {
									k.note("one domain spelled two ways")
								}
								if (
									sources.length > 0 &&
									Arr.some(domain.uses, (u) => !Arr.some(declared, (d) => d.table === u.table))
								) {
									k.note("a field's domain the closed payload shares")
								}
							}
							if (c.levels.kind === "above") {
								k.note("a level above")
							}
							const order = Arr.map(relations, (r) => r.name)
							if (Arr.join(order, " ") !== Arr.join(Arr.sort(order, Order.String), " ")) {
								k.note("relations declared apart from name order")
							}
						})
				)
			)
	)
})
