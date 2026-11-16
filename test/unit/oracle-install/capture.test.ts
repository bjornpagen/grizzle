/**
 * Raw text capture, the host side of format('%L') (test/support/oracle/install/capture.ts unquoteLiteral): it reads a
 * quoted literal PostgreSQL's quote_literal writes back as the text it quoted, and refuses what quote_literal never
 * writes.
 *
 * - Round trip: unquoteLiteral(quote_literal(t)) = t for every text t, quote_literal restated from PostgreSQL's
 *   src/backend/utils/adt/quote.c (quotes and backslashes doubled, an E prefix when the text holds a backslash).
 * - Refusal: a literal quote_literal wrote with one fault planted is read as no literal: the bare word NULL, the
 *   opening or the closing quote dropped, one doubled quote halved, or, in an E literal, one doubled backslash halved.
 *
 * Texts are drawn from an alphabet with explicit weights, quote and backslash beside ordinary letters and any Unicode
 * scalar value, so the characters quote_literal doubles are no rarity. Features: a text holding a quote, one holding a
 * backslash (an E literal), one holding both, the empty text, and every planted fault.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Option, String as Str } from "effect"
import { assert } from "#test/support/assert.ts"
import { unquoteLiteral } from "#test/support/oracle/install/capture.ts"
import {
	faults,
	type Feature,
	planted,
	quoteLiteral,
	textGen
} from "#test/unit/oracle-install/capture.fixtures.ts"

/** UnquoteLiteral reads every literal quote_literal writes as its text, and refuses every literal with a fault planted. */
export const unquoteLiteralReadsEveryLiteralQuoteLiteralWritesAsItsTextAndRefusesEveryLiteralWithAFaultPlanted =
	property.explore(textGen, {
		needs: {},
		situations: [
			"a quote",
			"a backslash",
			"a quote and a backslash",
			"the empty text",
			"refused: the bare word NULL",
			"refused: the opening quote dropped",
			"refused: the closing quote dropped",
			"refused: a doubled quote halved",
			"refused: a doubled backslash halved"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (text) =>
			Effect.sync(() => {
				const quoted = quoteLiteral(text)
				assert.equal(unquoteLiteral(quoted), text, quoted)
				const quote = Str.includes("'")(text)
				const backslash = Str.includes("\\")(text)
				if (quote) {
					c.note("a quote")
				}
				if (backslash) {
					c.note("a backslash")
				}
				if (quote && backslash) {
					c.note("a quote and a backslash")
				}
				if (text.length === 0) {
					c.note("the empty text")
				}
				for (const fault of faults) {
					const broken = planted(quoted, fault)
					if (Option.isSome(broken)) {
						assert.equal(unquoteLiteral(broken.value), undefined, `${fault}: ${broken.value}`)
						c.note(`refused: ${fault}`)
					}
				}
			}),
		oracle: {
			kind: "universal",
			name: "unquoteLiteral ∘ quote_literal = id, and no planted fault reads back"
		},
		kept: [],
		kills: []
	})
