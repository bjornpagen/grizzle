/**
 * The constants of a drafted migration on PostgreSQL 19 survive a text tool (deploy/render/filed.ts): a folder read and
 * written back by a tool that reads lines, as Python's text mode, str.splitlines and an editor that normalizes line
 * endings do, applies and passes the drift check, and installs the constants grizzle drafted. WINDOW2's report was a
 * draft whose CHECK held a raw carriage return in the XSD whitespace chain's constant: a resolve step read
 * 02-structure.sql in Python's text mode, the carriage return came back a line feed, every file applied, and the drift
 * check refused the two CHECKs, rightly, since the installed constant was another.
 *
 * A case draws texts of every run such a tool rewrites, each line boundary of str.splitlines among them, a tab, C0 and
 * C1 controls, the quote and backslash an escape string doubles, characters of up to four bytes, and long texts, of
 * 2^17 to 2^18 code units. Its schema checks Doc's kind against each forbidden text and checks its collapse, the replace
 * chain of the reported CHECKs with its own tab, LF and CR constants, against the first's; a level above selects Doc's
 * rows of the selected text outside Extra into D, and holds each Use's doc in D by triggers, whose PL/pgSQL bodies, and
 * the rule's validation block, hold the selected text. The folder is drafted as `grizzle generate` drafts it, every file
 * rewritten by the tool, and applied by the real runner as the owner.
 *
 * Properties, for every case:
 * - the rewritten folder applies, the drift check admits the catalog it reaches, replayed from the snapshot beside it,
 *   and the installed-catalog checker finds nothing;
 * - no drafted file holds a line boundary the tool rewrites, so the tool leaves each byte for byte;
 * - the installed constants are the drawn texts: a Doc of each forbidden text is refused by a check (23514); where the
 *   checks admit the selected text, a Use of a Doc of it commits, and where they admit its rewrite, which differs, a
 *   Use of a Doc of that is refused by the rule (23503).
 *
 * Oracle: PostgreSQL, its catalog through the drift check and the installed-catalog checker, and its verdict on each
 * write against the host's equality of texts.
 *
 * Features: each run in a check's constant and in a function body's, a long one of each, and each of the rule's
 * verdicts, each constructed by the steered phase while it is pending.
 */

import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	aims,
	caseGen,
	type LiteralFeature,
	literalFeatures,
	runCase
} from "#test/pg/migrate/literals.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** A drafted folder read and written back by a text tool applies, passes the drift check and installs the constants drafted, every control character and long constant among them. */
export const aDraftedFolderReadAndWrittenBackByATextToolAppliesPassesTheDriftCheckAndInstallsTheConstantsDrafted =
	property.explore(aimed(caseGen, aims), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: literalFeatures,
		check:
			({ substrate }, c: Case<LiteralFeature>) =>
			(value) =>
				Effect.provideServiceEffect(
					runCase(value, (feature) => c.note(feature)),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "postgresql",
			name: "the catalog the rewritten folder reaches, through the drift check and the installed-catalog checker, and PostgreSQL's verdict on each write against the host's equality of texts"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/render/filed.ts",
				original: "\t\tconst spelling = respelled(lexeme)",
				replacement: '\t\tconst spelling = lexeme.kind === "word" ? respelled(lexeme) : undefined',
				why: "A drafted file spells each constant raw, as before 1fc5a519, so the tool turns a carriage return in a CHECK's constant into a line feed and the drift check refuses the CHECK, WINDOW2's report."
			},
			{
				file: "packages/engine/src/deploy/render/filed.ts",
				original:
					'\t\t\treturn holdsUnfiled(lexeme.body, "lines")\n\t\t\t\t? { text: continuedPieces(lexeme.body), end: lexeme.end }\n\t\t\t\t: undefined',
				replacement: "\t\t\treturn undefined",
				why: "A function body is spelled raw, so the tool rewrites the carriage return a judge's constant holds and the drift check refuses the judge's function, whose source differs."
			},
			{
				file: "packages/engine/src/sql/escape.ts",
				original: '\t\tcase 0x5c:\n\t\t\treturn "\\\\\\\\"',
				replacement: '\t\tcase 0x5c:\n\t\t\treturn "\\\\"',
				why: "An escape string leaves a backslash undoubled, so a constant holding one installs another text or none, and the check refuses the forbidden text no longer, or the folder fails to apply."
			}
		]
	})
