/**
 * The README as a function of what it is written from: the model, the author config, the names plan and every stage's
 * diagnostics, each made by the generator's own stages from a generated document and author config. Its contract,
 * checked fact by fact rather than as whole text: the title is the bin name; the sections come in their fixed order,
 * Secret fields and Webhooks only when there are any, and the OAuth2 and client certificate subsections only when a
 * token scheme or a certificate is planned; every planned credential's environment variable and file flag is listed,
 * and every certificate's three environment variables; the settings name the package's prefix; the refusal summary lists each refused operation once, sorted, as an escaped literal in a fence, and counts
 * the element and field refusals of the commands that remain; the webhooks are listed in document order as escaped
 * literals; every fence closes, and no line inside one could close it; no control, format, separator or lone surrogate
 * code point appears raw; and oxfmt leaves the Markdown unchanged.
 *
 * Plants, each applied to src/emit/readme.ts, seen to fail this suite and reverted: none yet.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import type { Gen } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { regex } from "arkregex"
import { Array as Arr, Duration, Effect, Formatter, Option, Order, String as Str } from "effect"
import { format } from "oxfmt"
import { stringLiteral } from "#emit/escape.ts"
import { emitReadme } from "#emit/readme.ts"
import type { ReadmeInput } from "#emit/readme.ts"
import { decodeAuthorConfig } from "#model/author-config.ts"
import { DocumentUri } from "#model/brands.ts"
import { isRefusal } from "#model/diagnostic.ts"
import { planNames } from "#names/index.ts"
import type { PlannedCommand } from "#names/plan.ts"
import { envPrefixOf } from "#names/plan.ts"
import { normalize } from "#normalize/index.ts"
import { resolve } from "#resolve/index.ts"
import { configGen, configOf, documentGen, documentOf } from "#test/emit/openapi-gen.ts"
import type { ConfigSketch, DocumentSketch } from "#test/emit/openapi-gen.ts"
import { harnessLayer } from "#test/support/cli-package.ts"

const document = DocumentUri.make("file:///readme/openapi.json")

const configDocument = DocumentUri.make("file:///readme/author-config.json")

/** A generated document and an author config that fits it. */
type ReadmeCase = Readonly<{ document: DocumentSketch; config: ConfigSketch }>

const caseGen: Gen<ReadmeCase> = (s) => {
	const sketch = s.draw(documentGen)
	return { document: sketch, config: s.draw(configGen(sketch)) }
}

/** What the README is written from, made by the generator's own stages. */
const readmeInputOf = (drawnCase: ReadmeCase) =>
	Effect.gen(function* () {
		const config = yield* decodeAuthorConfig(configOf(drawnCase.config), {
			document: configDocument
		})
		const resolution = yield* resolve({
			document,
			line: drawnCase.document.line,
			value: documentOf(drawnCase.document)
		})
		const normalized = yield* normalize(resolution, { checkFindings: [], config, configDocument })
		const plan = yield* planNames(normalized.api, { config, configDocument, strict: false })
		const input: ReadmeInput = {
			api: normalized.api,
			config,
			diagnostics: [...normalized.diagnostics, ...plan.diagnostics],
			plan
		}
		return input
	})

const headingPattern = regex("^#{2,3} ", "u")

const fenceOpen = regex("^(`{3,})text$", "u")

const escapeSet = regex("[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Cs}]", "u")

/** The lines of the README a heading opens, up to the next heading of its level or above. */
const sectionLines = (lines: ReadonlyArray<string>, heading: string): ReadonlyArray<string> => {
	const start = Arr.findFirstIndex(lines, (line) => line === heading)
	return Option.match(start, {
		onNone: () => [],
		onSome: (index) =>
			Arr.takeWhile(
				Arr.drop(lines, index + 1),
				(line) =>
					!(
						Str.startsWith("## ")(line) ||
						(Str.startsWith("### ")(heading) && Str.startsWith("### ")(line))
					)
			)
	})
}

/** The lines of every `text` fence, and whether each fence closes with no line inside it that could close it first. */
const fences = (
	lines: ReadonlyArray<string>
): ReadonlyArray<Readonly<{ body: ReadonlyArray<string>; sound: boolean }>> =>
	Arr.getSomes(
		Arr.map(lines, (line, index) =>
			Option.map(
				Option.flatMap(Option.fromNullishOr(fenceOpen.exec(line)), (match) => Arr.get(match, 1)),
				(marks) => {
					const rest = Arr.drop(lines, index + 1)
					const body = Arr.takeWhile(rest, (inner) => inner !== marks)
					return {
						body,
						sound: body.length < rest.length && !Arr.some(body, Str.startsWith(marks))
					}
				}
			)
		)
	)

/** Two lists of lines, the same lines in the same order. */
const sameLines = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
	left.length === right.length && Arr.every(Arr.zip(left, right), ([a, b]) => a === b)

const credentialLine = (credential: Readonly<{ env: string; flag: string }>): string =>
	`- \`${credential.env}\` or \`--${credential.flag} <path|->\``

type OperationKey = Readonly<{ method: string; path: string }>

const byKey = Order.combine(
	Order.mapInput(Order.String, (key: OperationKey) => key.path),
	Order.mapInput(Order.String, (key: OperationKey) => key.method)
)

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`

/** Every way the README breaks its contract with what it was written from. */
const readmeFindings = (
	input: ReadmeInput,
	drawnCase: ReadmeCase,
	text: string
): ReadonlyArray<string> => {
	const lines = Str.split("\n")(text)
	const { plan } = input
	const tokenSchemes = Arr.map(
		Arr.filter(
			input.api.securitySchemes,
			(scheme) => scheme.kind.type === "oauth2Token" || scheme.kind.type === "oidcToken"
		),
		(scheme) => scheme.name
	)
	const tokens = Arr.filter(plan.credentials, (credential) =>
		Arr.contains(tokenSchemes, credential.scheme)
	)
	const secrets = Arr.sort(
		Arr.dedupe(
			Arr.flatMap(
				[...plan.root, ...Arr.flatMap(plan.groups, (group) => group.commands)],
				(command: PlannedCommand) =>
					Arr.flatMap(command.flags, (flag) =>
						flag.source._tag === "Body" && flag.source.kind === "secret-file" ? [flag.name] : []
					)
			)
		),
		Order.String
	)
	const refusals = Arr.filter(input.diagnostics, isRefusal)
	const operations = Arr.sort(
		Arr.dedupeWith(
			Arr.flatMap(refusals, (diagnostic): ReadonlyArray<OperationKey> =>
				diagnostic.scope === "operation" && diagnostic.operation !== undefined
					? [{ method: diagnostic.operation.method, path: diagnostic.operation.path }]
					: []
			),
			(left: OperationKey, right: OperationKey) => byKey(left, right) === 0
		),
		byKey
	)
	const remaining = (scope: "element" | "field") =>
		Arr.filter(
			refusals,
			(diagnostic) =>
				diagnostic.scope === scope &&
				!Arr.some(
					operations,
					(key) =>
						key.method === diagnostic.operation?.method && key.path === diagnostic.operation.path
				)
		).length
	const elements = remaining("element")
	const fields = remaining("field")
	const webhooks = drawnCase.document.webhooks
	const prefix = envPrefixOf(input.config)
	const headings = [
		"## Usage",
		"## How a command runs",
		"## Settings",
		"## Credentials",
		...(Arr.isReadonlyArrayNonEmpty(tokens) ? ["### OAuth2 and OpenID Connect"] : []),
		...(Arr.isReadonlyArrayNonEmpty(plan.certificates) ? ["### Client certificates"] : []),
		...(Arr.isReadonlyArrayNonEmpty(secrets) ? ["## Secret fields"] : []),
		"## Retries",
		"## Timeouts",
		"## Output",
		"## Proxies",
		"## Exit codes",
		"## Refusals",
		...(Arr.isReadonlyArrayNonEmpty(webhooks) ? ["## Webhooks"] : [])
	]
	const refusalFences = fences(sectionLines(lines, "## Refusals"))
	const webhookFences = fences(sectionLines(lines, "## Webhooks"))
	return [
		...(Arr.head(lines).pipe(Option.contains(`# ${input.config.binName}`))
			? []
			: ["the title is not the bin name"]),
		...(sameLines(
			Arr.filter(lines, (line) => headingPattern.test(line)),
			headings
		)
			? []
			: ["the sections"]),
		...Arr.flatMap(plan.credentials, (credential) =>
			Arr.contains(sectionLines(lines, "## Credentials"), credentialLine(credential))
				? []
				: [`credential ${credential.scheme}`]
		),
		...Arr.flatMap(tokens, (credential) =>
			Arr.contains(sectionLines(lines, "### OAuth2 and OpenID Connect"), credentialLine(credential))
				? []
				: [`token ${credential.scheme}`]
		),
		...Arr.flatMap(plan.certificates, (certificate) =>
			Arr.contains(
				sectionLines(lines, "### Client certificates"),
				`- \`${certificate.certEnv}\`, \`${certificate.keyEnv}\` and \`${certificate.caEnv}\``
			)
				? []
				: [`certificate ${certificate.scheme}`]
		),
		...(sameLines(
			Arr.filter(sectionLines(lines, "## Secret fields"), Str.startsWith("- ")),
			Arr.map(secrets, (name) => `- \`--${name} <path|->\``)
		)
			? []
			: ["the secret fields"]),
		...Arr.flatMap(["BASE_URL", "TIMEOUT", "IDLE_TIMEOUT", "ERROR_FORMAT"], (setting) =>
			Str.includes(`\`${prefix}_${setting}\``)(text) ? [] : [`the setting ${setting}`]
		),
		...((Arr.isReadonlyArrayNonEmpty(operations) || elements > 0 || fields > 0) ===
		!Arr.contains(lines, "Nothing in the description was refused.")
			? []
			: ["whether anything was refused"]),
		...(sameLines(
			Arr.flatMap(refusalFences, (fence) => fence.body),
			Arr.map(operations, (key) => `${key.method} ${stringLiteral(key.path)}`)
		)
			? []
			: ["the refused operations"]),
		...(elements === 0 ||
		Str.includes(`Generation refused ${plural(elements, "element")} of generated commands`)(text)
			? []
			: ["the element count"]),
		...(fields === 0 ||
		Str.includes(`Generation refused ${plural(fields, "body field")} of generated commands`)(text)
			? []
			: ["the field count"]),
		...(sameLines(
			Arr.flatMap(webhookFences, (fence) => fence.body),
			Arr.map(webhooks, stringLiteral)
		)
			? []
			: ["the webhooks"]),
		...(Arr.every([...refusalFences, ...webhookFences], (fence) => fence.sound)
			? []
			: ["a fence that does not close"]),
		...(escapeSet.test(Str.replaceAll("\n", "")(text))
			? ["a raw code point of the escape set"]
			: [])
	]
}

type Feature =
	| "a credential"
	| "a token scheme"
	| "a certificate"
	| "a secret field"
	| "a refused operation"
	| "an element refusal"
	| "nothing refused"
	| "a webhook"
	| "an env prefix"

const featuresOf = (
	input: ReadmeInput,
	drawnCase: ReadmeCase,
	text: string
): ReadonlyArray<Feature> => {
	const lines = Str.split("\n")(text)
	return [
		...(Arr.isReadonlyArrayNonEmpty(input.plan.credentials) ? (["a credential"] as const) : []),
		...(Arr.contains(lines, "### OAuth2 and OpenID Connect") ? (["a token scheme"] as const) : []),
		...(Arr.isReadonlyArrayNonEmpty(input.plan.certificates) ? (["a certificate"] as const) : []),
		...(Arr.contains(lines, "## Secret fields") ? (["a secret field"] as const) : []),
		...(Str.includes("operation, which have no command:")(text) ||
		Str.includes("operations, which have no command:")(text)
			? (["a refused operation"] as const)
			: []),
		...(Str.includes(" of generated commands;")(text) ? (["an element refusal"] as const) : []),
		...(Arr.contains(lines, "Nothing in the description was refused.")
			? (["nothing refused"] as const)
			: []),
		...(Arr.isReadonlyArrayNonEmpty(drawnCase.document.webhooks) ? (["a webhook"] as const) : []),
		...(Option.isSome(drawnCase.config.envPrefix) ? (["an env prefix"] as const) : [])
	]
}

layer(harnessLayer, { excludeTestServices: true })("emit: the README", (it) => {
	it.effect(
		"the README states exactly what its model, config, plan and diagnostics hold, in Markdown the formatter keeps",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "readme",
						oracle: {
							kind: "specification",
							name: "the README's contract, fact by fact, against the model, config, plan and diagnostics it is written from"
						},
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<Feature>(
							[
								"a credential",
								"a token scheme",
								"a certificate",
								"a secret field",
								"a refused operation",
								"an element refusal",
								"nothing refused",
								"a webhook",
								"an env prefix"
							],
							{ cases: 800, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: { kind: "bounded", candidates: 200 },
						concurrency: 1,
						steerEvery: 100,
						caseHang: Duration.seconds(20)
					},
					(drawnCase, k) =>
						Effect.gen(function* () {
							const input = yield* readmeInputOf(drawnCase)
							const { content } = emitReadme(input)
							const formatted = yield* Effect.promise(() => format("README.md", content))
							k.noteAll(featuresOf(input, drawnCase, content))
							deepStrictEqual(
								{
									formatted: formatted.code,
									errors: formatted.errors.length,
									findings: readmeFindings(input, drawnCase, content)
								},
								{ formatted: content, errors: 0, findings: [] }
							)
						})
				)
			)
	)
})
