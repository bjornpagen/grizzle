/**
 * Help as a function of the model. A generated operation, with its flags, the declared schemes, the credentials and
 * certificates the names plan gave them and the run's diagnostics, renders to help whose contract is checked fact by
 * fact: the description is the source description, else the summary, sanitized; the line a command table shows is the
 * summary, else the description's first sentence, on one line; the sections are REQUEST, VARIANTS
 * when a body alternative is discriminated, AUTH, DEPRECATED when the operation is, RESPONSES, RESPONSE HEADERS when a
 * case declares one, NON-STANDARD when a switch marked a flag and REFUSED when an element or field of this operation was
 * refused, in that order; every section and every note is one line of safe text; path parameters are arguments and
 * everything else a flag; each note names its location first, then each switch's note, the body field's choices,
 * default and read-only mark, and `deprecated` last when it applies; REQUEST names the method, path, body media types
 * and operation id; AUTH names each alternative's schemes with their markers, credential sources, flows, scopes and
 * roles; RESPONSES names each case in order; REFUSED names each refused element of this operation and nothing else.
 *
 * An operation's docs are drawn as normalization holds them, sanitized and whole: a long description is kept to its
 * end.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order, Record } from "effect"
import { operationHelp } from "#emit/help.ts"
import { stripUnsafeText } from "#model/brands.ts"
import {
	type Feature,
	featuresOf,
	helpFindings,
	helpInputGen,
	isArgument,
	sectionsOf,
	tableLineOf
} from "#test/emit/help-text.fixtures.ts"

/**
 * Help states exactly the facts of its operation, flags, schemes and refusals, each on one safe line. Its budget is the
 * count its suite stated before the conversion: 400 independent cases, and up to 2000 steered while a situation is
 * unreached.
 */
export const helpFacts = property.explore(helpInputGen, {
	needs: {},
	situations: [
		"a description",
		"a summary alone",
		"no prose",
		"a long description",
		"a path argument",
		"a negatable flag",
		"a body field with choices",
		"a body field with a default",
		"a read-only body field",
		"a deprecated flag",
		"a part content type option",
		"a required part header",
		"positional parts",
		"a discriminated body",
		"a deprecated operation",
		"an explicit empty security",
		"absent security",
		"an anonymous alternative",
		"two schemes in one alternative",
		"an author-supplied scheme",
		"a deprecated scheme",
		"an oauth2 scheme",
		"an openIdConnect scheme",
		"a mutualTLS certificate",
		"a credential with a prompt",
		"required scopes",
		"roles",
		"an undeclared scheme",
		"a response header",
		"a bracket-marked flag",
		"a scalar-marked flag",
		"a refused element",
		"a refused field",
		"another operation's refusal",
		"hostile text"
	] satisfies ReadonlyArray<Reached<Feature>>,
	check: (_, k: Case<Feature>) => (input) =>
		Effect.sync(() => {
			const help = operationHelp(input)
			k.noteAll(featuresOf(input))
			const { operation } = input
			const noFindings: ReadonlyArray<string> = []
			const wanted = {
				description: stripUnsafeText(operation.docs.description ?? operation.docs.summary ?? ""),
				summary: tableLineOf(operation.docs),
				sections: sectionsOf(input),
				arguments: Arr.sort(
					Arr.map(Arr.filter(input.flags, isArgument), (flag) => flag.name),
					Order.String
				),
				flags: Arr.sort(
					Arr.map(
						Arr.filter(input.flags, (flag) => !isArgument(flag)),
						(flag) => flag.name
					),
					Order.String
				),
				findings: noFindings
			}
			assert.deepEqual<typeof wanted>(
				{
					description: help.description,
					summary: help.summary,
					sections: Arr.map(help.sections, ([name]) => name),
					arguments: Arr.sort(Record.keys(help.arguments), Order.String),
					flags: Arr.sort(Record.keys(help.flags), Order.String),
					findings: helpFindings(input, help)
				},
				wanted
			)
		}),
	oracle: {
		kind: "specification",
		name: "help's contract, fact by fact, against the operation it renders"
	},
	kept: [
		{
			token: ReplayToken(
				"test/emit/help-text.test.ts#helpFacts:-:4.0.0.0.0.0.1.1.0.0.0.0.0.0.0.1.1.0.0.0.0.0.0.0.3.1.0.0.0.1.0.0.1.1.0.0.0.0.0.0.1.1.0.0.0.0.0.0.0.4.1.0.0.0.0.0.0.0.0.0.0.0.0.1.1.6.0.0.0.0.0.0"
			),
			reason:
				"a description of one sentence ending at its stop, with no summary: the command table's line keeps the stop (firstSentence's slice; the floor draws no such description)",
			since: "2026-11-17"
		}
	],
	budget: { runs: 400, steered: 2000 },
	kills: [
		{
			file: "packages/cli-generator/src/emit/help.ts",
			original: "\t\tonSome: (found) => Str.slice(0, found.index + 1)(first)",
			replacement: "\t\tonSome: (found) => Str.slice(0, found.index + 0)(first)",
			why: "A description's first sentence loses its closing stop, so a command table's line drawn from a description reads one character short; the property fails (CATCH's evidence, mutant ff8ac23e78)."
		},
		{
			file: "packages/cli-generator/src/emit/help.ts",
			original:
				'description: stripUnsafeText(operation.docs.description ?? operation.docs.summary ?? ""),',
			replacement:
				'description: stripUnsafeText(operation.docs.summary ?? operation.docs.description ?? ""),',
			why: "Help's description is taken from the summary before the description, so an operation with both shows its summary as its help; the property fails."
		},
		{
			file: "packages/cli-generator/src/emit/help.ts",
			original: 'line(operation.docs.summary ?? firstSentence(operation.docs.description ?? ""))',
			replacement:
				'line(operation.docs.description === undefined ? (operation.docs.summary ?? "") : firstSentence(operation.docs.description))',
			why: "The command table's line is taken from the description's first sentence before the summary, so an operation with both shows the wrong line; the property fails."
		},
		{
			file: "packages/cli-generator/src/emit/help.ts",
			original: '...(scheme.deprecated ? ["deprecated"] : [])',
			replacement: "...(scheme.deprecated ? [] : [])",
			why: "A deprecated scheme loses its `deprecated` marker in AUTH; the property fails."
		},
		{
			file: "packages/cli-generator/src/emit/help.ts",
			original: `\tconst mark = marked.length === 0 ? "" : \` [\${Arr.join(marked, ", ")}]\``,
			replacement: `\tconst mark = marked.length === 1 ? "" : \` [\${Arr.join(marked, ", ")}]\``,
			why: "A scheme carrying exactly one marker loses it in AUTH, so an author-supplied scheme reads as a spec scheme; the property fails (EOCG-EMIT's handoff from author-supplied.test.ts, mutant 94eb5750a5)."
		},
		{
			file: "packages/cli-generator/src/emit/help.ts",
			original: '\t...(scheme.source === "author-supplied" ? ["author-supplied"] : []),',
			replacement: '\t...(scheme.source !== "author-supplied" ? ["author-supplied"] : []),',
			why: "Every spec scheme is marked author-supplied in AUTH and an added one is not; the property fails (EOCG-EMIT's handoff from author-supplied.test.ts, mutant 264b82ec26)."
		},
		{
			file: "packages/cli-generator/src/emit/help.ts",
			original: "use.choice === choice",
			replacement: "true",
			why: "A switch's note goes on every flag of the operation, marked or not; the property fails (EOCG-EMIT's handoff from help-non-standard.test.ts, mutant d48a430647)."
		},
		{
			file: "packages/cli-generator/src/emit/help.ts",
			original: `\t\treturn marked.length === 0 ? [] : [\`\${Arr.join(names, ", ")} (\${choice})\`]`,
			replacement: `\t\treturn marked.length !== 0 ? [] : [\`\${Arr.join(names, ", ")} (\${choice})\`]`,
			why: "NON-STANDARD names the switches no flag uses and leaves out the ones that mark one; the property fails (EOCG-EMIT's handoff from help-non-standard.test.ts, mutant e54b7b6349)."
		},
		{
			file: "packages/cli-generator/src/emit/help.ts",
			original: "\tif (alternatives.length === 0) {",
			replacement: "\tif (alternatives.length !== 0) {",
			why: "An operation with security alternatives prints `no authentication` and one with none prints its alternatives; the property fails (EOCG-EMIT's handoff from sec-fixes.test.ts, mutant 278649c582)."
		},
		{
			file: "packages/cli-generator/src/emit/help.ts",
			original: '["RESPONSES", responsesLine(operation)]',
			replacement: "[responsesLine(operation)]",
			why: "The RESPONSES section loses its title; the property fails (EOCG-EMIT's handoff from fmt-fixes.test.ts, mutant 3a8d002a68)."
		},
		{
			file: "packages/cli-generator/src/emit/help.ts",
			original: "\tif (scopes.length === 0) {",
			replacement: "\tif (scopes.length === (-1)) {",
			why: "A use with no scopes still gets a scopes note, `roles  (never sent)`; the property fails (EOCG-EMIT's handoff from help-non-standard.test.ts, mutant 2feb74b8ca)."
		}
	]
})
