/**
 * Xml.isPattern on PostgreSQL 19 and the host alike: whether a text is a string of XML Schema 1.0's regExp
 * production (Part 2, Appendix F), the language of QTI 3.0.1's pattern-mask and of a literal qti-pattern-match.
 *
 * Over batches of texts drawn from five spaces, three verdicts on every text are one:
 *
 * 1. grizzle-text's reader of Appendix F's grammar (regex/xsd.ts xsdPattern), which admits or refuses it;
 * 2. the library function's SQL (physical/ddl/library.ts xsdPatternDefinition), created in the session's pg_temp, over
 *    the batch in one round trip: the reader's moves as a table its recursive query reads once over the characters;
 * 3. the host evaluator's value of the term (scalar/compute/evaluate.ts).
 *
 * The spaces: drawn patterns of every construct Appendix F defines; one construct outside the grammar each, `(?i)yes`,
 * `[a-z` and `a{` among them; a drawn pattern one character off; a run of the grammar's characters and category
 * names; and groups or class subtractions nested from one to 2,000 deep, closed, or one bracket short or over.
 *
 * Oracle: the reader, a second implementation beside the table PostgreSQL reads, and the host's own evaluation.
 *
 * Features: each space, nesting past a thousand among them, and a text admitted and one refused.
 */

import { xsdPattern } from "@bjornpagen/grizzle-text/regex/xsd"
import type { Reached } from "@bjornpagen/testing/features"
import { agree, exact, ordered } from "@bjornpagen/testing/oracle"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { inInstallation } from "#test/pg/compute/utf16-length.fixtures.ts"
import {
	batchGen,
	createLibrary,
	hostVerdict,
	testedSql,
	type XsdPatternFeature
} from "#test/pg/compute/xsd-pattern.fixtures.ts"
import { truth } from "#test/pg/text/differential.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Xml.isPattern on PostgreSQL 19: the library function's verdict on every text is the reader's and the host's. */
export const computeIsXsdPatternOnPostgreSQL19TheLibraryFunctionsVerdictOnEveryTextIsTheReadersAndTheHosts =
	property.explore(batchGen, {
		needs: { substrate: Substrate.installing },
		situations: [
			"a pattern of every construct",
			"a construct outside the grammar",
			"a pattern one character off",
			"a run of the grammar's characters",
			"nested groups",
			"nested class subtractions",
			"nesting past a thousand",
			"a text the reader admits",
			"a text the reader refuses"
		] satisfies ReadonlyArray<Reached<XsdPatternFeature>>,
		check:
			({ substrate }, k: Case<XsdPatternFeature>) =>
			(batch) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const texts = Arr.map(batch, (d) => d.text)
						const read = Arr.map(texts, (t) => xsdPattern(t).ok)
						for (const [i, drawn] of batch.entries()) {
							for (const feature of drawn.features) {
								k.note(feature)
							}
							k.note(read[i] === true ? "a text the reader admits" : "a text the reader refuses")
						}
						const pinned = yield* s.admin.pin
						const rows = yield* inInstallation(
							pinned,
							[createLibrary],
							pinned.queryValues(testedSql, [jsonText(texts)])
						)
						yield* agree<ReadonlyArray<boolean>>(
							[
								["the reader", read],
								["PostgreSQL", Arr.map(rows, (row) => truth(row[0]))],
								["the host", Arr.map(texts, hostVerdict)]
							],
							ordered(exact)
						)
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "grizzle-text's reader of Appendix F's grammar, beside the table PostgreSQL reads, and the host's evaluation of the term"
		},
		budget: { runs: 24, steered: 24 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/library.ts",
				original: '\t\t\t\t\t\t\t["closeGroup", unless(gt(r("parens"), integer(0)))],\n',
				replacement: '\t\t\t\t\t\t\t["closeGroup", next],\n',
				why: "A `)` closes a group though none is open, so a `(` after it balances the count: `a)(b` is admitted, which the reader refuses."
			},
			{
				file: "packages/engine/src/physical/ddl/library.ts",
				original:
					'\t\t\t\t\t\t\t["closeClass", when(eq(r("depth"), integer(1)), state("atom"), state("subtracted"))],\n',
				replacement: '\t\t\t\t\t\t\t["closeClass", state("atom")],\n',
				why: "A subtraction's `]` closes its whole class, so the class's own `]` after it is refused: `[a-[b]]` is refused, which the reader admits."
			},
			{
				file: "packages/engine/src/physical/ddl/library.ts",
				original: "\tconst categories = [...xsdCategoryNames, ",
				replacement: '\tconst categories = ["Foo", ...xsdCategoryNames, ',
				why: "A category escape's name the tables do not hold is admitted: `\\p{Foo}` is admitted, which the reader refuses."
			},
			{
				file: "packages/engine/src/physical/ddl/library.ts",
				original: "\t\t\t\t\t\t\t\t\t\tlt(length(least), length(most)),\n",
				replacement: "\t\t\t\t\t\t\t\t\t\tlit.bool(true),\n",
				why: "A count's greatest is not compared with its least: `a{2,1}` is admitted, which the reader refuses."
			}
		]
	})
