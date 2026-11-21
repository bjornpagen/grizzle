/**
 * `--dry-run` (design 4.6 DM3-8, D-OUT3, 7.5, M3-DR1): `Output.send` builds the request as for sending, prints it to
 * stdout with every credential replaced by `<redacted:<scheme>>`, and sends nothing. The properties run each send through
 * the send harness (test/support/send.ts sendIn), as the generated entry runs it:
 *
 * - a dry run shows the placeholders of the alternative a real run would choose, or the first one's when none is
 *   configured, never prompts and always exits 0;
 * - a configured value the real run refuses is refused by the dry run in the same words;
 * - a body prints as its text with every secret its placeholder, a body from stdin or a binary one as a summary that
 *   reads nothing of it, a multipart body part by part;
 * - a value under a redacted header or query name prints as `<redacted>` unless it is exactly the run's own placeholder;
 * - a one-character credential is never spelled out inside a placeholder on any print path (hater m3 HB1), and a
 *   credential a server echoes inside placeholder-shaped text is still scrubbed (its security review).
 */

import { assert, containsText, lacksText, matchesObject } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Option, Ref, Runtime } from "effect"
import {
	aimedBodies,
	aimedDecorations,
	BEARER,
	BODY_FEATURES,
	type BodyFeature,
	bodyFeatures,
	bodyOf,
	bodyWorld,
	DECORATED_FEATURES,
	type DecoratedFeature,
	decoratedFeatures,
	decoratedWorld,
	type Echo,
	ECHOES,
	echoedWorld,
	echoes,
	errorLineOf,
	expectedBody,
	expectedDecorated,
	expectedPreview,
	exposedIn,
	type Flaw,
	FLAWS,
	INJECTED,
	type OneCharacter,
	oneCharacters,
	oneCharacterWorld,
	OUTPUT_PATHS,
	type OutputPath,
	PASSWORD,
	PREVIEW_FEATURES,
	type PreviewFeature,
	previewFeatures,
	previews,
	previewWorld,
	refusals,
	refusedWorld,
	type Scheme,
	type Seen,
	seenOf,
	verboseBlocks
} from "#test/runtime/output-dry-run.fixtures.ts"
import { sendIn } from "#test/support/send.ts"

/**
 * A dry run shows the placeholders of the alternative the real run would choose (the first that names a scheme and has
 * every scheme configured), else none where `{}` allows anonymous access, else the first alternative's, in the
 * alternative's order; it prints nothing on stderr, never prompts, even on a terminal, sends nothing and exits 0. It
 * replaces five example cases, the print of a JSON POST's request line and headers among them; the exhaustion proves
 * it over every requirement of at most two alternatives.
 */
export const previewedCredentials = property.exhaust(previews, {
	needs: {},
	box: "every requirement of at most two alternatives over the bearer and apiKey schemes and {}, under every set of configured schemes, on a terminal and off one",
	situations: PREVIEW_FEATURES satisfies ReadonlyArray<Reached<PreviewFeature>>,
	check: (_, c: Case<PreviewFeature>) => (preview) =>
		Effect.gen(function* () {
			c.noteAll(previewFeatures(preview))
			const sent = yield* sendIn(previewWorld(preview))
			assert.deepEqual<Seen>(seenOf(sent), expectedPreview(preview))
		}),
	oracle: {
		kind: "specification",
		name: "design 4.6 and D-OUT3: the chosen alternative's placeholders, the first alternative's when none is configured, no prompt, no send"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
			original: "const first = allowsAnonymous(requirement) ? [] : (requirement[0] ?? [])",
			replacement: "const first = requirement[0] ?? []",
			why: "A requirement whose {} allows anonymous access shows its first alternative's placeholders when nothing is configured; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
			original: "\t\t\tif (alternative.length === 0) {\n\t\t\t\tcontinue\n\t\t\t}",
			replacement: "\t\t\tif (alternative.length === 0) {\n\t\t\t\treturn Option.some([])\n\t\t\t}",
			why: "A {} before a configured alternative is chosen, so the dry run shows an anonymous request where the real run sends the credential; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
			original: "return { credentials: configured.value, placeholders: configured.value }",
			replacement: "return { credentials: configured.value, placeholders: [] }",
			why: "A configured alternative's placeholders are never written, so the dry run hides where its credentials go; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "const chosen = dryRun",
			replacement: "const chosen = !dryRun",
			why: "The dry run evaluates the requirement as a real run does, so it prompts on a terminal and fails for a missing credential; the property fails."
		}
	]
})

/**
 * A configured value the real run refuses (a CR, LF or NUL, leading or trailing whitespace, a code point above U+00FF)
 * is refused by the dry run as the real run refuses it (M3-DR1, m3-hb5): the same UsageError, exit 2, the same stderr
 * naming the scheme and never the value's text, nothing on stdout, nothing sent. It replaces two example cases.
 */
export const refusedLikeTheRealRun = property.exhaust(refusals, {
	needs: {},
	box: "every flaw a configured value can carry, in each scheme's credential",
	situations: [...FLAWS, "bearerAuth", "apiKey"] satisfies ReadonlyArray<Reached<Flaw | Scheme>>,
	check: (_, c: Case<Flaw | Scheme>) => (refusal) =>
		Effect.gen(function* () {
			c.noteAll([refusal.flaw, refusal.scheme])
			const real = yield* sendIn(refusedWorld(refusal))
			const dry = yield* sendIn({ ...refusedWorld(refusal), dryRun: true })
			matchesObject(
				dry.failure,
				Option.some({ _tag: "UsageError", [Runtime.errorExitCode]: 2 }),
				"the dry run is refused with a usage error, exit 2"
			)
			matchesObject(
				real.failure,
				Option.some({ _tag: "UsageError" }),
				"the real run is refused with a usage error"
			)
			assert.deepEqual(
				{
					stderr: dry.stderr,
					stdout: dry.stdout,
					sent: dry.requests.length + real.requests.length
				},
				{ stderr: real.stderr, stdout: "", sent: 0 }
			)
			containsText(dry.stderr, `the credential for ${refusal.scheme} has a CR, LF, NUL`)
			lacksText(dry.stderr, INJECTED)
		}),
	oracle: {
		kind: "specification",
		name: "M3-DR1: a dry run fails where the real run would, with the real run's error"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
			original:
				"value === undefined ? Effect.void : Effect.asVoid(attachOne(request, { ...entry, value }))",
			replacement: "Effect.void",
			why: "The dry run writes the placeholder of a value the real run refuses, so it previews a request that cannot be sent; the property fails."
		}
	]
})

/**
 * A dry run's body (design 4.6 DM3-8): a text body in memory, from a file or sequential prints as its text with the
 * recorded secret-file value and the credential each its placeholder, wherever its chunks are cut; a body from stdin
 * prints `<body from stdin>` for a text media type and `<binary body from stdin>` for any other, and stdin is never
 * read; a binary body prints `<binary body, N bytes>`; a multipart body prints its delimiters and part heads, each text
 * part scrubbed, a file part `<file <filename>, N bytes>` and a binary part `<binary part, N bytes>`. Nothing is sent,
 * stderr is empty, and neither secret prints anywhere. It replaces nine example cases.
 */
export const printedBodies = property.explore(aimedBodies, {
	needs: {},
	situations: BODY_FEATURES satisfies ReadonlyArray<Reached<BodyFeature>>,
	check: (_, c: Case<BodyFeature>) => (body) =>
		Effect.gen(function* () {
			c.noteAll(bodyFeatures(body))
			const read = yield* Ref.make(false)
			const world = yield* bodyWorld(body, read)
			const sent = yield* sendIn(world)
			const stdinRead = yield* Ref.get(read)
			assert.deepEqual(
				{
					exit: sent.exit._tag,
					sent: sent.requests.length,
					stdinRead,
					stderr: sent.stderr,
					body: bodyOf(sent.stdout)
				},
				{
					exit: "Success",
					sent: 0,
					stdinRead: false,
					stderr: "",
					body: Option.some(expectedBody(body))
				}
			)
			lacksText(sent.stdout, PASSWORD)
			lacksText(sent.stdout, BEARER)
		}),
	oracle: {
		kind: "specification",
		name: "design 4.6 DM3-8: each body kind's print, every recorded value and credential its placeholder"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original:
				'return line(printsAsText(mediaType) ? "<body from stdin>" : "<binary body from stdin>")',
			replacement:
				'return line(printsAsText(mediaType) ? "<binary body from stdin>" : "<body from stdin>")',
			why: "A text body from stdin prints as a binary one and a binary one as text; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "if (body.contentLength === undefined) {",
			replacement: "if (false) {",
			why: "A body from stdin is read to print it, or summarized with no size; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: `this.summary = \`file \${filename}\``,
			replacement: "this.summary = undefined",
			why: "A multipart file part's content prints where its summary belongs; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: 'this.summary = "binary part"',
			replacement: "this.summary = undefined",
			why: "A multipart binary part's bytes print where its summary belongs; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "(scrubber, chunk: Uint8Array) => [scrubber, scrubber.push(chunk)] as const",
			replacement: "(scrubber, chunk: Uint8Array) => [scrubber, [chunk]] as const",
			why: "A streamed text body prints unscrubbed, so the recorded value and the credential show; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "for (const piece of this.text.push(bytes)) {",
			replacement: "for (const piece of [Result.succeed(bytes)]) {",
			why: "A multipart text part prints unscrubbed, so the recorded value and the credential show; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "onSome: (text) => line(scrubValues(text, recorded))",
			replacement: "onSome: (text) => line(text)",
			why: "A text body in memory prints unscrubbed, so a recorded secret-file value shows; the property fails."
		}
	]
})

/**
 * A dry run prints a value under a redacted name as `<redacted>` unless it is exactly the run's own placeholder (design
 * 4.6, 7.5): a `Redacted` query value always; a plain one under a redacted query name unless it is the placeholder; a
 * redacted header unless it is a placeholder form of the run's (after `Bearer` or `Basic`); a Cookie pair by pair, a
 * bare pair always; another scheme's placeholder is no placeholder of the run's; every value under a plain name prints
 * as it is. It replaces five example cases.
 */
export const printedRedactedNames = property.explore(aimedDecorations, {
	needs: {},
	situations: DECORATED_FEATURES satisfies ReadonlyArray<Reached<DecoratedFeature>>,
	check: (_, c: Case<DecoratedFeature>) => (decorated) =>
		Effect.gen(function* () {
			c.noteAll(decoratedFeatures(decorated))
			const sent = yield* sendIn(decoratedWorld(decorated))
			assert.deepEqual(
				{ exit: sent.exit._tag, sent: sent.requests.length, stdout: sent.stdout },
				{ exit: "Success", sent: 0, stdout: expectedDecorated(decorated) }
			)
		}),
	oracle: {
		kind: "specification",
		name: "design 4.6 and 7.5: a redacted name's value is the run's own placeholder or <redacted>, pair by pair in a Cookie"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
			original: "return forms.has(value) ? value : redactedPlaceholder()",
			replacement: "return value",
			why: "A value under a redacted header name prints as it is; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
			original: "onNone: () => redactedPlaceholder(),",
			replacement: "onNone: () => pair,",
			why: "A Cookie pair with no = prints as it is; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/auth.ts",
			original: "written.has(Str.slice(equals + 1)(pair))",
			replacement: "true",
			why: "Every Cookie pair is kept, its value no placeholder of the run's; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "\t\tif (Redacted.isRedacted(value)) {\n\t\t\treturn redactedPlaceholder()",
			replacement: "\t\tif (Redacted.isRedacted(value)) {\n\t\t\treturn Redacted.value(value)",
			why: "A Redacted query value prints as it is; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: "UrlParams.isRedactedName(decodedQueryName(Str.slice(0, equals)(part)), names)",
			replacement: "false",
			why: "A query value under a redacted name prints as it is; the property fails."
		}
	]
})

/**
 * A one-character credential, shorter than every placeholder, is never spelled out inside one (hater m3 HB1): on a dry
 * run's two streams, a verbose send's request and response blocks and its stdout, and a JSON error's scrubbed fields,
 * removing every placeholder the run emits whole leaves neither the credential's character nor an angle bracket, the
 * mark of a placeholder nested in another. Each run also ends as its path does: the dry run sends nothing, the verbose
 * send its one request, and the refused send fails with the server's 400. It replaces three example cases, each over the
 * credential `a`; the exhaustion proves it over every letter the runtime's own output spells.
 */
export const oneCharacterCredential = property.exhaust(oneCharacters, {
	needs: {},
	box: "every letter of the runtime's own output as the bearer credential, on a dry run, a verbose send and a JSON error",
	situations: OUTPUT_PATHS satisfies ReadonlyArray<Reached<OutputPath>>,
	check: (_, c: Case<OutputPath>) => (one: OneCharacter) =>
		Effect.gen(function* () {
			c.note(one.path)
			const sent = yield* sendIn(oneCharacterWorld(one))
			const exposed = (text: string) => exposedIn(text, one.credential)
			switch (one.path) {
				case "a dry run":
					assert.deepEqual(
						{
							exit: sent.exit._tag,
							sent: sent.requests.length,
							stdout: exposed(sent.stdout),
							stderr: exposed(sent.stderr)
						},
						{ exit: "Success", sent: 0, stdout: [], stderr: [] }
					)
					return
				case "a verbose send":
					assert.deepEqual(
						{
							exit: sent.exit._tag,
							sent: sent.requests.length,
							stdout: exposed(sent.stdout),
							blocks: exposed(verboseBlocks(sent.stderr))
						},
						{ exit: "Success", sent: 1, stdout: [], blocks: [] }
					)
					return
				case "a JSON error": {
					const error = Option.map(errorLineOf(sent.stderr), (fields) => ({
						kind: fields.kind,
						status: fields.status,
						body: exposed(fields.body),
						message: exposed(fields.message),
						operation: exposed(fields.operation)
					}))
					assert.deepEqual(
						{ exit: sent.exit._tag, stdout: exposed(sent.stdout), error },
						{
							exit: "Failure",
							stdout: [],
							error: Option.some({
								kind: "ApiResponseError",
								status: 400,
								body: [],
								message: [],
								operation: []
							})
						}
					)
					return
				}
			}
		}),
	oracle: {
		kind: "specification",
		name: "hater m3 HB1: no character of a credential outside a placeholder, and no placeholder inside another"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/redact.ts",
			original: "\t\t\t\tinsideToken(start, start + form.length)\n\t\t\t\t\t? Result.failVoid",
			replacement: "\t\t\t\tfalse\n\t\t\t\t\t? Result.failVoid",
			why: "A placeholder the run already printed is scrubbed again, so a one-character credential is spelled out inside it; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/response.ts",
			original:
				'\t\tisSuccess(response.status)\n\t\t\t? Effect.succeed(response)\n\t\t\t: Effect.fail(toApiResponseError(table, response, "", scrubbed, Option.none()))',
			replacement:
				'\t\tisSuccess(response.status)\n\t\t\t? Effect.fail(toApiResponseError(table, response, "", scrubbed, Option.none()))\n\t\t\t: Effect.succeed(response)',
			why: "A 2xx answer is classified as an API error and a 400 as a success, so the verbose send fails and the refused one succeeds; the property fails (TESTPOLICY2's census of this module, mutant 65041189b6)."
		}
	]
})

/**
 * A credential a server echoes in its error body is scrubbed in every form, placeholder-shaped text among them (the
 * security review of m3-hb1): bare, inside `<redacted:...>`, inside an unclosed one, after the scheme's own label, and
 * beside the scheme's placeholder, under the text and the JSON error format. The run fails, stderr holds the scheme's
 * placeholder, and neither stream holds the credential. It replaces one example case, the first two echo forms under
 * JSON errors.
 */
export const echoedInsidePlaceholders = property.exhaust(echoes, {
	needs: {},
	box: "every echo form of the configured bearer credential in a 400's body, under each error format",
	situations: ECHOES satisfies ReadonlyArray<Reached<Echo>>,
	check: (_, c: Case<Echo>) => (echoed) =>
		Effect.gen(function* () {
			c.note(echoed.echo)
			const sent = yield* sendIn(echoedWorld(echoed))
			assert.equal(sent.exit._tag, "Failure")
			containsText(sent.stderr, "<redacted:bearerAuth>")
			lacksText(sent.stdout, BEARER)
			lacksText(sent.stderr, BEARER)
		}),
	oracle: {
		kind: "specification",
		name: "the security review of m3-hb1: placeholder-shaped text a server sends is ordinary input to the scrub"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/redact.ts",
			original: "Arr.dedupe([redactedPlaceholder(), ...Arr.map(entries, placeholderOf)])",
			replacement:
				"Arr.dedupe([redactedPlaceholder(), ...Arr.map(entries, placeholderOf), ...Arr.map(Arr.fromIterable(text.matchAll(/<redacted:[^>]*>/gu)), (match) => match[0])])",
			why: "Any placeholder-shaped text is opaque to the scrub, so a credential a server wraps in one prints; the property fails."
		}
	]
})
