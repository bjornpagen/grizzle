/**
 * A closed relation's str.pattern field and the match that reads it by key (physical/ddl/constants.ts plannedAre,
 * lower/conservative/expr/index.ts patternAre), over drawn dictionaries: one to five distinct patterns over one
 * family's alphabet that Text.matches admits, each a domain's, and a stored relation whose CHECK matches its text
 * against its domain's pattern, `Text.matches(v.lexical, Pattern.at("pattern", v.domain))`.
 *
 * - **The translation is a fact of the constant:** the installation holds the field's ARE dictionary beside its
 *   dictionary, one text[] whose element at each code is that code's pattern as the ARE PostgreSQL reads, the
 *   dictionary's own value translated (scalar/regex/admit.ts matchAre), in the dictionary's code order.
 * - **The match translates nothing as it runs:** the CHECK, with the body of the row function it calls read for its
 *   call (physical/ddl/row-functions.ts), reads the ARE dictionary by the key the closed read reads, and its expression
 *   holds no CASE and no pattern, neither a source nor an ARE, so its size is the key's read whatever the patterns
 *   are.
 * - **Only a closed relation's own field holds patterns:** a stored relation's str.pattern field is refused where the
 *   schema is owned, a match over a closed relation's plain text payload where it is lowered, and a str.pattern value
 *   no Text.matches admission admits at the closed relation's rows, once, before any match reads it.
 *
 * Oracle: specification, the dictionary's own values each translated, and the CHECK's expression read node by node.
 *
 * Features: one pattern and several; each refusal.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { element, finite, type Gen, int, uniqueArray } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order, Record as Rec } from "effect"
import { isRecord } from "#compiler/core/record.ts"
import { literalKey } from "#compiler/laws/model/names.ts"
import { installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { Text } from "#compiler/public/compute.ts"
import { closedId, int4 } from "#compiler/public/fields.ts"
import { check, closed, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { matchAre } from "#compiler/scalar/regex/admit.ts"
import { textArrayLiteral } from "#compiler/sql/print.ts"
import { refusalLoc, refused, succeeded } from "#test/support/assert.ts"
import { installationNamesOf } from "#test/support/kernel/naming.ts"
import { ownedInput, owning } from "#test/support/policy.ts"
import { admittedPatternOver, families } from "#test/support/unit/text/generators.ts"

type PatternFeature = "one pattern" | "several patterns"

/** One to five distinct patterns over one family's alphabet, each admitted by Text.matches. */
const patternsGen: Gen<Arr.NonEmptyReadonlyArray<string>> = (source) => {
	const family = defined(families[source.draw(int(0, families.length - 1))], "a family")
	const admitted = admittedPatternOver(family.alphabet)
	const drawn = source.draw(uniqueArray(admitted, (p) => element([p]), { min: 1, max: 5 }))
	return Arr.isReadonlyArrayNonEmpty(drawn) ? drawn : [source.draw(admitted)]
}

/** The schema of a case: each pattern a domain's, and a CHECK matching a stored text against its domain's pattern. */
const schemaOf = (patterns: Arr.NonEmptyReadonlyArray<string>) => {
	const Domain = closed.ordered(
		"Domain",
		Arr.map(patterns, (_, i) => `D${i}`)
	)
	const Pattern = closed.relation(
		"Pattern",
		{ domain: closedId(Domain), pattern: str.pattern },
		["domain"],
		Arr.map(patterns, (pattern, i) => ({ domain: `D${i}`, pattern }))
	)
	const Value = relation(
		"Value",
		{ id: int4, domain: closedId(Domain), lexical: str.regex("^.*$", "su") },
		["id"]
	)
	const lexical = check("Lexical", Value, (v) =>
		Text.matches(v.lexical, Pattern.at("pattern", v.domain))
	)
	return { value: schema("Patterns", [Domain, Pattern, Value], [lexical]), lexical }
}

/** Every record a value holds, depth first: what the statements and the CHECK's expression are searched by. */
const nodes = (value: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> =>
	Arr.isArray(value)
		? Arr.flatMap(value, nodes)
		: isRecord(value)
			? [value, ...Arr.flatMap(Rec.values(value), nodes)]
			: []

/** A record's member `key` where it is a record. */
const recordAt = (node: Readonly<Record<string, unknown>>, key: string) => {
	const value = node[key]
	return isRecord(value) ? value : undefined
}

/** The text a constant's body states: its array literal's, where its body is a text literal. */
const bodyText = (statement: Readonly<Record<string, unknown>>): string | undefined => {
	const literal = recordAt(statement, "body")
	const value = literal === undefined ? undefined : recordAt(literal, "value")
	const text = value?.["value"]
	return typeof text === "string" ? text : undefined
}

/** A str.pattern field's match reads each pattern's ARE by its key from the one ARE dictionary its constants plan, its CHECK stating no CASE and no pattern. */
export const aStrPatternFieldsMatchReadsEachPatternsAREByItsKeyFromItsAREDictionaryAndItsCHECKStatesNoCASEAndNoPattern =
	property.explore(patternsGen, {
		needs: {},
		situations: ["one pattern", "several patterns"] satisfies ReadonlyArray<PatternFeature>,
		check: (_, c: Case<PatternFeature>) => (patterns) =>
			Effect.sync(() => {
				c.note(patterns.length === 1 ? "one pattern" : "several patterns")
				const s = schemaOf(patterns)
				const owned = owning(s.value)
				const installation = succeeded(compileInstallation(owned, installOptions(owned)))
				const ordered = Arr.map(
					Arr.sort(
						Arr.map(patterns, (source) => ({
							source,
							key: literalKey({ kind: "text", value: source })
						})),
						Order.mapInput(Order.String, (p: { readonly key: string }) => p.key)
					),
					(p) => p.source
				)
				const ares = Arr.map(ordered, (source) => matchAre(source))
				const statements = nodes(installation.statements)
				/** The names of the constants whose body is the array literal `text`. */
				const constantsOf = (text: string): ReadonlyArray<string> =>
					Arr.flatMap(statements, (n) => {
						const name = recordAt(n, "name")?.["name"]
						return n["kind"] === "createConstant" &&
							bodyText(n) === text &&
							typeof name === "string"
							? [name]
							: []
					})
				assert.ok(
					constantsOf(textArrayLiteral(ordered)).length > 0,
					"the field's dictionary, its patterns in code order"
				)
				const areNames = constantsOf(textArrayLiteral(ares))
				assert.ok(
					areNames.length > 0,
					"the field's ARE dictionary, each code's pattern as ARE in code order"
				)
				const names = installationNamesOf(installation)
				const constraint = names.constraintOf(names.lawOf(s.lexical), "TableCheck")
				const check = Arr.findFirst(
					statements,
					(n) => n["kind"] === "check" && n["name"] === constraint
				)
				assert.ok(Option.isSome(check), `the CHECK ${constraint}`)
				/** The body of each row function the installation creates, by its name: what a call of one reads. */
				const rowBodies = new Map(
					Arr.flatMap(statements, (n) => {
						const name = recordAt(n, "name")?.["name"]
						return n["kind"] === "createConstant" &&
							n["language"] === "plpgsql" &&
							typeof name === "string"
							? [[name, n["body"]] as const]
							: []
					})
				)
				const predicate = nodes(check.value["predicate"])
				const read = [
					...predicate,
					...Arr.flatMap(predicate, (n) => {
						const name = n["kind"] === "qualified" ? n["name"] : undefined
						return typeof name === "string" && rowBodies.has(name) ? nodes(rowBodies.get(name)) : []
					})
				]
				assert.ok(
					Arr.some(
						read,
						(n) =>
							n["kind"] === "qualified" &&
							typeof n["name"] === "string" &&
							areNames.includes(n["name"])
					),
					"the CHECK reads the ARE dictionary"
				)
				assert.equal(
					Arr.filter(read, (n) => n["kind"] === "case").length,
					0,
					"the CHECK states no CASE"
				)
				const stated = new Set([...patterns, ...ares])
				assert.deepEqual(
					Arr.flatMap(read, (n) => {
						const value = n["value"]
						return typeof value === "string" && stated.has(value) ? [value] : []
					}),
					[],
					"the CHECK states no pattern, its source or its ARE"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the dictionary's own values each translated, and the CHECK's expression read node by node"
		},
		budget: { runs: 60, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/expr/index.ts",
				original: '{ kind: "are", field: read.field }',
				replacement: '{ kind: "at", field: read.field }',
				why: "A match reads its pattern's source where it should read its ARE: PostgreSQL's `~` reads grizzle's grammar as an ARE, and the CHECK names no ARE dictionary."
			},
			{
				file: "packages/engine/src/physical/ddl/constants.ts",
				original: "\tconst values = space.values.map((value): TypedLiteral => {",
				replacement: "\tconst values = space.values.toReversed().map((value): TypedLiteral => {",
				why: "The ARE dictionary out of its dictionary's code order: a key reads another code's pattern, and no constant holds the patterns' ARE in code order."
			}
		]
	})

type Misplaced =
	| "a stored relation's str.pattern"
	| "a text payload as a pattern"
	| "a pattern no admission admits"
	| "a text payload no pattern reads"

const misplaced: Arr.NonEmptyReadonlyArray<Misplaced> = [
	"a stored relation's str.pattern",
	"a text payload as a pattern",
	"a pattern no admission admits",
	"a text payload no pattern reads"
]

/** A schema of one misplaced pattern, and the schema's refusal of it. */
const misplacedSchema = (kind: Misplaced) => {
	const Domain = closed.ordered("Domain", ["D0"])
	if (kind === "a stored relation's str.pattern") {
		const Stored = relation("Stored", { id: int4, pattern: str.pattern }, ["id"])
		return schema("Misplaced", [Domain, Stored], [])
	}
	const text = kind === "a text payload as a pattern" || kind === "a text payload no pattern reads"
	const Pattern = closed.relation(
		"Pattern",
		{ domain: closedId(Domain), pattern: text ? str.regex("^.*$", "su") : str.pattern },
		["domain"],
		[{ domain: "D0", pattern: kind === "a text payload as a pattern" ? "^a$" : "(" }]
	)
	const Value = relation(
		"Value",
		{ id: int4, domain: closedId(Domain), lexical: str.regex("^.*$", "su") },
		["id"]
	)
	const lexical =
		kind === "a text payload no pattern reads"
			? check("Lexical", Value, (v) => v.eq(v.lexical, Pattern.at("pattern", v.domain)))
			: check("Lexical", Value, (v) => Text.matches(v.lexical, Pattern.at("pattern", v.domain)))
	return schema("Misplaced", [Domain, Pattern, Value], [lexical])
}

/** Only a closed relation's own field holds patterns: a stored relation's str.pattern, a text payload read as a pattern and a str.pattern value no admission admits are each refused, the last at the relation's rows, and a text payload no match reads is never admitted as one. */
export const onlyAClosedRelationsOwnStrPatternFieldHoldsPatternsAndEachOfItsValuesIsAdmittedOnceAtItsRows =
	property.exhaust(
		finite((source) => source.draw(element(misplaced))),
		{
			box: "each misplaced pattern",
			needs: {},
			situations: misplaced satisfies ReadonlyArray<Reached<Misplaced>>,
			check: (_, c: Case<Misplaced>) => (kind) =>
				Effect.sync(() => {
					c.note(kind)
					const owned = ownedInput(misplacedSchema(kind))
					if (kind === "a stored relation's str.pattern") {
						refused(owned, "MalformedDescription", kind)
						return
					}
					if (kind === "a text payload no pattern reads") {
						succeeded(
							compileInstallation(succeeded(owned), installOptions(succeeded(owned))),
							"a text payload no match reads is never admitted as a pattern"
						)
						return
					}
					const error = refused(
						compileInstallation(succeeded(owned), installOptions(succeeded(owned))),
						"MalformedDescription",
						kind
					)
					if (kind === "a pattern no admission admits") {
						assert.deepEqual(
							refusalLoc(error).path.slice(0, 2),
							["Pattern", "rows"],
							"refused at the closed relation's rows, before any match reads it"
						)
					}
				}),
			oracle: { kind: "specification", name: "str.pattern's place: a closed relation's own field" },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/schema/own.ts",
					original:
						'\t\t\t\tif (d.kind === "pattern" && (entry.desc.kind !== "closedRelation" || d !== desc)) {',
					replacement: "\t\t\t\tif (false) {",
					why: "A stored relation's str.pattern is owned, a text of patterns no closed relation states and no match can read by key."
				},
				{
					file: "packages/engine/src/check/closed.ts",
					original: '\tif (textOf(type) !== "pattern") {',
					replacement: "\tif (textOf(type) === undefined) {",
					why: "Every text payload is admitted as patterns: a plain text payload no match reads is parsed as one, and a value no admission admits refuses the schema."
				},
				{
					file: "packages/engine/src/check/closed.ts",
					original: "\t\tunwrap(matchValueAt(admission, at))\n",
					replacement: "",
					why: "A str.pattern value no admission admits is kept until a match reads it, refused at the match, not once at the relation's rows."
				}
			]
		}
	)
