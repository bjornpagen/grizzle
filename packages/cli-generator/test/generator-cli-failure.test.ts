/**
 * The generator's one-line failures (design 8.1): every failure of a run but a refusal prints one line on stderr. A
 * held run lock prints the lock line and a refused write its reason; any other failure names its tag, then its reason
 * and its subject where it has them, the subject as its JSON text. No line holds a control, format, separator or lone
 * surrogate character raw, each written as a visible `\u{hex}` escape, and the subject reads back from its field.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Option, String as Str } from "effect"
import { failureLine } from "#main.ts"
import {
	type Feature,
	failureSpace,
	featuresOf,
	holdsUnsafe,
	readSubject
} from "#test/generator-cli-failure.fixtures.ts"

/**
 * A drawn failure prints the line the design gives it, safe to print, its subject read back whole. It replaces five
 * example cases; its budget is the runner's.
 */
export const failureLines = property.explore(failureSpace, {
	needs: {},
	situations: [
		"the lock line",
		"a refused write",
		"a reason and a subject",
		"a reason alone",
		"neither field",
		"the RunLockHeld line",
		"the WriteRefused line",
		"the PrinterError line",
		"the ApiEmitError line",
		"the CliEmitError line",
		"the DomainEmitError line",
		"the PackageEmitError line",
		"the SchemaManifestError line",
		"the InvalidInstanceLocation line",
		"the SchemaImportDefect line",
		"the ValidatorError line",
		"the RunLockUnavailable line",
		"a character JSON escapes",
		"a character only the sanitizer escapes",
		"a lone surrogate",
		"a sanitizer escape spelled in the subject"
	] satisfies ReadonlyArray<Reached<Feature>>,
	check: (_, c: Case<Feature>) => (drawn) =>
		Effect.sync(() => {
			c.noteAll(featuresOf(drawn))
			const line = failureLine(drawn.failure)
			assert.equal(holdsUnsafe(line), false, "the line holds a character raw")
			if (drawn.expected.kind === "whole") {
				assert.equal(line, drawn.expected.line)
				return
			}
			const { head, subject } = drawn.expected
			assert.ok(Str.startsWith(head)(line), "the line names its tag and its reason")
			const rest = Str.slice(head.length)(line)
			Option.match(subject, {
				onNone: () => assert.equal(rest, ""),
				onSome: (expected) => {
					assert.ok(Str.startsWith(" subject ")(rest), "the subject follows the reason")
					assert.deepEqual(readSubject(Str.slice(" subject ".length)(rest)), Option.some(expected))
				}
			})
		}),
	oracle: {
		kind: "universal",
		name: "the design's line for each failure class, its subject read back as the JSON string it is with the sanitizer's escapes undone, and no character of Unicode's Cc, Cf, Zl, Zp or Cs categories raw"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/main.ts",
			original: 'RunLockHeld: () => "error: another run holds the output directory\'s lock",',
			replacement: "RunLockHeld: tagAlone,",
			why: "A held run lock prints as a generation failure, so the operator is not told another run holds the output; the property fails."
		},
		{
			file: "packages/cli-generator/src/main.ts",
			original: "refused.reason",
			replacement: "refused.subject",
			why: "A refused write prints its subject where its reason belongs; the property fails."
		},
		{
			file: "packages/cli-generator/src/main.ts",
			original: "PrinterError: withSubject,",
			replacement: "PrinterError: withReason,",
			why: "A printer failure's line drops its subject, so the operator is not told what the printer refused; the property fails."
		},
		{
			file: "packages/cli-generator/src/main.ts",
			original: "sanitizeField(jsonText(subject))",
			replacement: "jsonText(subject)",
			why: "A subject's DEL, C1 control, format character or separator, which JSON leaves raw, reaches the terminal raw; the property fails."
		},
		{
			file: "packages/cli-generator/src/main.ts",
			original: "sanitizeField(jsonText(subject))",
			replacement: "sanitizeField(subject)",
			why: "A subject is printed unquoted, so a newline in it splits the line and a space in it reads as the field's end; the property fails."
		},
		{
			file: "packages/cli-generator/src/main.ts",
			original: `\`\${reasonField(failure.reason)}\${subjectField(failure.subject)}\``,
			replacement: `\`\${subjectField(failure.subject)}\${reasonField(failure.reason)}\``,
			why: "The subject is printed before the reason; the property fails."
		},
		{
			file: "packages/cli-generator/src/report/human.ts",
			original: '"^[\\\\p{Cc}\\\\p{Cf}\\\\p{Zl}\\\\p{Zp}\\\\p{Cs}]$"',
			replacement: '"^[\\\\p{Cc}\\\\p{Zl}\\\\p{Zp}\\\\p{Cs}]$"',
			why: "A format character (a zero-width space, a bidirectional override) is left raw in a subject, where it hides or reorders what the line shows; the property fails."
		}
	]
})
