/** What the properties of text.test.ts read: its spaces, models and helpers. */

import { array, boolean, element, type Gen, int, map, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import { identity } from "#compiler/core/identity.ts"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { Compute } from "#compiler/public/compute.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import { check, closed, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { judged, probe } from "#test/pg/physical/checks.ts"
import { defined } from "#test/support/assert.ts"
import { installationNamesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { owning } from "#test/support/policy.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import {
	baseParams,
	type LeafBinding,
	lowerWith,
	plainRender,
	renderSql,
	testPg
} from "#test/unit/compute/support.ts"
import {
	admittedPatternOver,
	families,
	jsMatcher,
	patternOver,
	stringsOver
} from "#test/unit/text/generators.ts"

/** A text whose pattern bounds its bytes, which a query's `~` reads (lower.ts regexReadable); every drawn row is short. */
const textColumn: LeafBinding = { kind: "column", type: testPg.regex("^.{0,64}$", "su").scalar }

const boolColumn: LeafBinding = { kind: "column", type: testPg.boolean.scalar }

export const variable = (name: string): ExprDesc => ({ kind: "var", var: name })

export const text = (value: string): ExprDesc => ({ kind: "literal", value })

export const compute = (
	fn: "matches" | "concat" | "startsWith" | "endsWith",
	...args: ReadonlyArray<ExprDesc>
): ExprDesc => ({ kind: "compute", fn, args })

/** One expression case: a family, the patterns of its match, the row batch and the dictionary's choice. */
interface SqlCase {
	readonly family: number
	readonly sources: Arr.NonEmptyReadonlyArray<string>
	readonly rows: ReadonlyArray<{
		readonly v: string
		readonly w: string
		readonly r: string
		readonly p: boolean
	}>
}

export type SqlFeature =
	| "a literal's match held"
	| "a literal's match failed"
	| "a dictionary's match held"
	| "a dictionary's match failed"
	| "a prefix held"
	| "an equation held"

export const sqlCase: Gen<SqlCase> = (source) => {
	const fi = source.draw(int(0, families.length - 1))
	const family = defined(families[fi], "a family")
	const pattern: Gen<string> = weighted([
		[
			1,
			map(
				element(
					Arr.isReadonlyArrayNonEmpty(family.patterns) ? family.patterns : [["^$", "u"] as const]
				),
				([s]) => s
			)
		],
		[2, patternOver(family.alphabet)]
	])
	const first = source.draw(pattern)
	const second = source.draw(boolean) ? [source.draw(pattern)] : []
	const strings = stringsOver(element(family.alphabet), 8)
	return {
		family: fi,
		sources: [first, ...second],
		rows: source.draw(
			array(
				(row) => {
					const w = row.draw(strings)
					const r = row.draw(strings)
					/** Half the time v is w then r, so prefix tests and equations hold as often as not. */
					const v = row.draw(boolean) ? `${w}${r}` : row.draw(strings)
					return { v, w, r, p: row.draw(boolean) }
				},
				{ min: 1, max: 64 }
			)
		)
	}
}

/** A lowered expression of a case, its SQL and the reference evaluator's value per row. */
export interface Probe {
	readonly label: string
	readonly expr: ScalarExpr
	readonly sql: string
}

export const lowered = (
	label: string,
	desc: ExprDesc,
	predicate: boolean,
	mode: "query" | "check"
): Probe | undefined => {
	const result = lowerWith(
		mode,
		desc,
		{ v: textColumn, w: textColumn, r: textColumn, p: boolColumn },
		predicate,
		baseParams
	)
	if (!result.ok) {
		return undefined
	}
	const expr = result.value.root.expr
	return { label, expr, sql: renderSql(expr, plainRender) }
}

/** The text PostgreSQL prints a host value as: a boolean's word, a text itself. */
export const printed = (value: unknown): string =>
	typeof value === "boolean" ? (value ? "true" : "false") : String(value)

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

/** Patterns over the case's family that Compute.matches admits, the dictionary's and the literal's. */
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
		{ domain: closedId(Domain), pattern: str.regex("^.*$", "su") },
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
		Compute.matches(v.lexical, Pattern.at("pattern", v.domain))
	)
	const literal = check("Literal", Tagged, (t) =>
		Compute.matches(t.code, Compute.pattern(d.literal))
	)
	const value = schema("Dictionary", [Domain, Pattern, Value, Tagged], [lexical, literal])
	return { value, Value, Tagged, lexical, literal }
}

export const textInstallation = (s: ReturnType<typeof dictionarySchema>) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const schemaName = yield* substrate.schema({ create: false, label: "text" })
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

/** Installs `sql` on the pinned session in a transaction, runs `body` in it, and rolls back. */
export const inInstallation = <A>(
	pinned: PgConnection,
	sql: ReadonlyArray<string>,
	body: Effect.Effect<A, SqlError>
): Effect.Effect<A, SqlError> =>
	Effect.ensuring(
		Effect.gen(function* () {
			yield* pinned.query("BEGIN", [])
			for (const statement of sql) {
				yield* pinned.query(statement, [])
			}
			return yield* body
		}),
		Effect.orDie(pinned.query("ROLLBACK", []))
	)

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
