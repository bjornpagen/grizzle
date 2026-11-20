/**
 * An XML Schema pattern of a count past 255 on PostgreSQL 19 and the host alike: Appendix F sets no bound on a count, so
 * grizzle-text's reader takes any (regex/xsd.ts), and PostgreSQL's RE_DUP_MAX of 255 binds only the ARE printed for
 * it, which spells such a count as pieces of counts within 255 (regex/print.ts quantified).
 *
 * For drawn patterns `x{m,n}`, `x{m}` and `x{m,}` of a character, a class or a group, a count past 255 among them,
 * alone or inside a group repeated two or three times, and texts of whole words of the body at the counts' edges and
 * one code point off them, three answers agree on every text:
 *
 * 1. the host's automaton of the reader's IR (match.ts Matcher), which counts the repetition rather than copying it;
 * 2. PostgreSQL's `~` with the ARE of that IR (print.ts toAre);
 * 3. PostgreSQL's `~` with the ARE of Compute.xsdPattern's admitted pattern, its source in grizzle's grammar
 *    (scalar/regex/admit.ts matchAre), as a check or a query reads it.
 *
 * And PostgreSQL refuses the count as an ARE writes it, `a{n}` for the count past 255, as an invalid regular expression
 * (SQLSTATE 2201B): the spelling as pieces is needed, not a choice.
 *
 * Oracle: PostgreSQL 19's regex engine, against the host.
 *
 * Features: a least count past 255, a greatest count past 255, an unbounded greatest, a nested count, a text the
 * pattern holds and a text it does not.
 */

import { Matcher } from "@bjornpagen/grizzle-text/regex/match"
import { buildNfa } from "@bjornpagen/grizzle-text/regex/nfa"
import { toAre } from "@bjornpagen/grizzle-text/regex/print"
import { xsdPattern } from "@bjornpagen/grizzle-text/regex/xsd"
import type { Reached } from "@bjornpagen/testing/features"
import { agree, exact, ordered } from "@bjornpagen/testing/oracle"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { Compute } from "#compiler/public/compute.ts"
import { matchAre } from "#compiler/scalar/regex/admit.ts"
import { truth } from "#test/pg/text/differential.fixtures.ts"
import { type CountsFeature, countsCaseGen, showCounts } from "#test/pg/text/xsd-counts.fixtures.ts"
import { succeeded } from "#test/support/assert.ts"
import { expectSqlstate } from "#test/support/substrate/expect.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** PostgreSQL's `~` of `are` over every text of a batch, `$1` their JSON array, in their order. */
const matchedSql = `SELECT (t.v COLLATE pg_catalog.pg_c_utf8 ~ $2::text)::text FROM jsonb_array_elements_text($1::text::jsonb) WITH ORDINALITY AS t(v, ord) ORDER BY t.ord`

/** An XML Schema pattern of a count past 255: the host's automaton and PostgreSQL's ARE of its IR and of its admitted pattern agree on every text, and PostgreSQL refuses the count written as one. */
export const anXmlSchemaPatternOfACountPast255TheHostsAutomatonAndPostgreSQLsAREOfItsIRAndOfItsAdmittedPatternAgreeOnEveryTextAndPostgreSQLRefusesTheCountWrittenAsOne =
	property.explore(countsCaseGen, {
		needs: { tx: Substrate.transaction },
		situations: [
			"a least count past 255",
			"a greatest count past 255",
			"an unbounded greatest",
			"a nested count",
			"a text the pattern holds",
			"a text the pattern does not hold"
		] satisfies ReadonlyArray<Reached<CountsFeature>>,
		show: showCounts,
		budget: { runs: 24, steered: 24 },
		check:
			({ tx }, k: Case<CountsFeature>) =>
			(c) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx
					for (const feature of c.features) {
						k.note(feature)
					}
					const ir = succeeded(xsdPattern(c.pattern), c.pattern)
					const matcher = Matcher.of(buildNfa(ir))
					const host = Arr.map(c.texts, (t) => matcher.matches(t))
					for (const held of host) {
						k.note(held ? "a text the pattern holds" : "a text the pattern does not hold")
					}
					const batch = jsonText(c.texts)
					const asked = (are: string) =>
						Effect.map(db.values(matchedSql, [batch, are]), (rows) =>
							Arr.map(rows, (row) => truth(row[0]))
						)
					const ofIr = yield* asked(toAre(ir))
					const ofAdmitted = yield* asked(matchAre(Compute.xsdPattern(c.pattern).source))
					yield* agree<ReadonlyArray<boolean>>(
						[
							["the host's automaton", host],
							["PostgreSQL's ARE of the IR", ofIr],
							["PostgreSQL's ARE of the admitted pattern", ofAdmitted]
						],
						ordered(exact)
					)
					yield* expectSqlstate(db.query("SELECT 'a' ~ $1::text", [`a{${c.past}}`]), "2201B")
				}),
		oracle: {
			kind: "postgresql",
			name: "PostgreSQL 19's regex engine, on the ARE of the reader's IR and of Compute.xsdPattern's admitted pattern"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/xsd.ts",
				original:
					'\t\treturn { min: countOf(min), max: most.kind === "bounded" ? countOf(most.numeral) : "unbounded" }\n',
				replacement:
					'\t\tif (countOf(min) > 255 || (most.kind === "bounded" && countOf(most.numeral) > 255)) {\n\t\t\tthrow this.#unsupported(at, this.#text(at, this.#pos), "a repetition bound above 255, PostgreSQL\'s limit")\n\t\t}\n\t\treturn { min: countOf(min), max: most.kind === "bounded" ? countOf(most.numeral) : "unbounded" }\n',
				why: "The reader refuses a count past PostgreSQL's RE_DUP_MAX, as it did before Appendix F's unbounded counts were read: every drawn pattern is refused."
			},
			{
				file: "packages/text/src/regex/print.ts",
				original: '\tanchors: { start: "\\\\A", end: "\\\\Z" },\n\tmostCount: regexMaxRepeat',
				replacement: '\tanchors: { start: "\\\\A", end: "\\\\Z" },\n\tmostCount: "unbounded"',
				why: "The ARE prints a count past 255 as it stands, which PostgreSQL refuses as an invalid regular expression."
			}
		]
	})
