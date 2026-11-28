/** What the property of text.test.ts reads: its dictionary space, its schema and its judge. */

import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { type Installation, installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { Text } from "#compiler/public/compute.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import { check, closed, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { installationNamesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { judged, probe } from "#test/support/pg/physical/checks.ts"
import { owning } from "#test/support/policy.ts"
import { jsMatcher } from "#test/support/regex.ts"
import { admittedPatternOver, families, stringsOver } from "#test/support/unit/text/generators.ts"

/** The dictionary a case installs: each domain's pattern, the literal pattern of its Tagged rows, and the probe texts. */
interface Dictionary {
	readonly family: number
	readonly patterns: Arr.NonEmptyReadonlyArray<string>
	readonly literal: string
	readonly probes: ReadonlyArray<{ readonly domain: number; readonly lexical: string }>
}

export type DictionaryFeature =
	| "dictionary admits"
	| "dictionary refuses"
	| "literal admits"
	| "literal refuses"

/** Patterns over the case's family that Text.matches admits, the dictionary's and the literal's. */
export const dictionary: Gen<Dictionary> = (source) => {
	const fi = source.draw(int(0, families.length - 1))
	const family = defined(families[fi], "a family")
	const admitted = admittedPatternOver(family.alphabet)
	const first = source.draw(admitted)
	const more = source.draw(array(admitted, { min: 0, max: 3 }))
	const strings = stringsOver(element(family.alphabet), 6)
	return {
		family: fi,
		patterns: [first, ...more],
		literal: source.draw(admitted),
		probes: source.draw(
			array((p) => ({ domain: p.draw(int(0, 3)), lexical: p.draw(strings) }), {
				min: 1,
				max: 12
			})
		)
	}
}

export const dictionarySchema = (d: Dictionary) => {
	const handles = Arr.map(d.patterns, (_, i) => `D${i}`)
	const Domain = closed.ordered("Domain", Arr.isReadonlyArrayNonEmpty(handles) ? handles : ["D0"])
	const Pattern = closed.relation(
		"Pattern",
		{ domain: closedId(Domain), pattern: str.pattern },
		["domain"],
		Arr.map(d.patterns, (pattern, i) => ({ domain: `D${i}`, pattern }))
	)
	const Value = relation(
		"Value",
		{ id: pg.integer, domain: closedId(Domain), lexical: str.regex("^.*$", "su") },
		["id"]
	)
	const Tagged = relation("Tagged", { id: pg.integer, code: str.regex("^.*$", "su") }, ["id"])
	const lexical = check("Lexical", Value, (v) =>
		Text.matches(v.lexical, Pattern.at("pattern", v.domain))
	)
	const literal = check("Literal", Tagged, (t) => Text.matches(t.code, Text.pattern(d.literal)))
	const value = schema("Dictionary", [Domain, Pattern, Value, Tagged], [lexical, literal])
	return { value, Value, Tagged, lexical, literal }
}

export const textInstallation = (s: ReturnType<typeof dictionarySchema>, schemaName: string) =>
	Effect.gen(function* () {
		const owned = owning(s.value)
		const real = compileInstallation(owned, {
			...installOptions(owned),
			levels: [identity.schema(parsedSchemaName(schemaName))]
		})
		if (!real.ok) {
			return yield* Effect.die(new Error(`real compile ${real.error.message}`))
		}
		return real.value
	})

export const judgeDictionary = (
	pinned: PgConnection,
	installation: Installation,
	s: ReturnType<typeof dictionarySchema>,
	d: Dictionary
) =>
	Effect.gen(function* () {
		const names = installationNamesOf(installation)
		const lexicalCheck = names.constraintOf(names.lawOf(s.lexical), "TableCheck")
		const literalCheck = names.constraintOf(names.lawOf(s.literal), "TableCheck")
		const problems: Array<string> = []
		const reached = new Set<DictionaryFeature>()
		const ofPatterns = Arr.map(d.patterns, (pattern) => jsMatcher(pattern, "u"))
		const ofLiteral = jsMatcher(d.literal, "u")
		let id = 0
		for (const p of d.probes) {
			const domain = p.domain % d.patterns.length
			const pattern = defined(d.patterns[domain])
			const holds = defined(ofPatterns[domain])(p.lexical)
			id += 1
			const verdict = yield* probe(
				pinned,
				`INSERT INTO ${names.table(s.Value)} (${names.column(s.Value, "id")}, ${names.column(s.Value, "domain")}, ${names.column(s.Value, "lexical")}) VALUES ($1, $2, $3)`,
				[id, domain, p.lexical]
			)
			appendAll(
				problems,
				judged(
					`Value /${pattern}/u over ${Formatter.format(p.lexical)}`,
					holds,
					verdict,
					lexicalCheck
				)
			)
			reached.add(holds ? "dictionary admits" : "dictionary refuses")
			const tagged = ofLiteral(p.lexical)
			const literalVerdict = yield* probe(
				pinned,
				`INSERT INTO ${names.table(s.Tagged)} (${names.column(s.Tagged, "id")}, ${names.column(s.Tagged, "code")}) VALUES ($1, $2)`,
				[id, p.lexical]
			)
			appendAll(
				problems,
				judged(
					`Tagged /${d.literal}/u over ${Formatter.format(p.lexical)}`,
					tagged,
					literalVerdict,
					literalCheck
				)
			)
			reached.add(tagged ? "literal admits" : "literal refuses")
		}
		return { problems, reached }
	})
