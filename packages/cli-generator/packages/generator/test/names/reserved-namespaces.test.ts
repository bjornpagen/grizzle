/**
 * Flags and commands are two namespaces (design 4.4). One operation holds one drawn name at one drawn site: its command
 * name, its group (tag), a query parameter's flag, or a JSON body field's flag. The name is ordinary, a reserved flag
 * name (Effect's built-in flags, the runtime's flags and their `no-` negations) or a reserved command name. Oracle: the
 * site's namespace alone decides. A command or group name is refused (`OPR-06/reserved-name`, `TAG-02/reserved-name`)
 * exactly when it is a reserved command name, and a parameter or body flag (`PRM-02/flag-collision`,
 * `RQB-03/flag-collision`) exactly when it is a reserved flag name, each once at its own pointer with no command for
 * the operation; otherwise the operation is a command, at the path its site gives. An operation that folds to a
 * runtime flag's name, such as `follow`, is a command, and so is a group named like one.
 *
 * Plants, owed at the swarm gate (not run yet): index.ts holding command names against the reserved flag names (the
 * over-refusal that cost GitHub's follow); plan.ts holding parameter flags against the reserved command names only;
 * index.ts dropping the reserved command names from the group check.
 */
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { jsonTextOf } from "@superstarter/json"
import { drawn, explore } from "@superstarter/testing/explore"
import { required } from "@superstarter/testing/features"
import { element, type Gen, oneOf } from "@superstarter/testing/gen"
import { notesOnly } from "@superstarter/testing/sense"
import { searched } from "@superstarter/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	FileSystem,
	Formatter,
	JsonPointer,
	Option,
	Order,
	Path,
	Schema,
	Stream
} from "effect"
import { generate } from "#generate.ts"
import { DocumentUri } from "#model/brands.ts"
import { reservedCommandNames, reservedFlagNames } from "#names/reserved.ts"
import { harnessLayer } from "#test/support/cli-package.ts"

/** Where the drawn name sits: the operation's command name, its group, a query parameter, or a JSON body field. */
type Site = "command" | "group" | "parameter" | "body"

/** One case: the drawn name, the site holding it, and the operation's method. */
type NameCase = Readonly<{ name: string; site: Site; method: "post" | "put" }>

/** The sorted members of a reserved set behind `first`, the member a counterexample shrinks to. */
const membersAfter = (
	first: string,
	names: ReadonlySet<string>
): Arr.NonEmptyReadonlyArray<string> => Arr.prepend(Arr.sort([...names], Order.String), first)

/** A name of each kind as often as the others: ordinary, a reserved flag name (`follow` first) or a reserved command. */
const nameGen: Gen<string> = oneOf([
	element(["limit", "owner", "page-size"]),
	element(membersAfter("follow", reservedFlagNames)),
	element(membersAfter("help", reservedCommandNames))
])

const caseGen: Gen<NameCase> = (s) => ({
	name: s.draw(nameGen),
	site: s.draw(element<Site>(["command", "group", "parameter", "body"])),
	method: s.draw(element<NameCase["method"]>(["post", "put"]))
})

const ok = { "200": { description: "ok" } }

/** The one operation, holding the name at its site. */
const operationOf = (c: NameCase): Schema.JsonObject => {
	switch (c.site) {
		case "command":
			return { operationId: c.name, responses: ok }
		case "group":
			return { operationId: "planted", tags: [c.name], responses: ok }
		case "parameter":
			return {
				operationId: "planted",
				parameters: [{ name: c.name, in: "query", schema: { type: "string" } }],
				responses: ok
			}
		case "body":
			return {
				operationId: "planted",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: { type: "object", properties: { [c.name]: { type: "string" } } }
						}
					}
				},
				responses: ok
			}
	}
}

const PATH = "/planted"

const pointerOf = (c: NameCase): string => `/paths/${JsonPointer.escapeToken(PATH)}/${c.method}`

/** What the generator does with the operation: the refusals it reports, and the command path when it names one. */
type Outcome = Readonly<{
	refusals: ReadonlyArray<readonly [code: string, pointer: string]>
	command: Option.Option<ReadonlyArray<string>>
}>

/** The refusal the site's reserved set earns the name, with the pointer it is reported at. */
const refusalOf = (c: NameCase): Option.Option<readonly [code: string, pointer: string]> => {
	const operation = pointerOf(c)
	switch (c.site) {
		case "command":
			return reservedCommandNames.has(c.name)
				? Option.some(["OPR-06/reserved-name", operation])
				: Option.none()
		case "group":
			return reservedCommandNames.has(c.name)
				? Option.some(["TAG-02/reserved-name", `${operation}/tags/0`])
				: Option.none()
		case "parameter":
			return reservedFlagNames.has(c.name)
				? Option.some(["PRM-02/flag-collision", `${operation}/parameters/0`])
				: Option.none()
		case "body":
			return reservedFlagNames.has(c.name)
				? Option.some([
						"RQB-03/flag-collision",
						`${operation}/requestBody/content/${JsonPointer.escapeToken("application/json")}`
					])
				: Option.none()
	}
}

/** The site's namespace decides: the refusal its reserved set earns, else the command at the path the site gives. */
const expectedOf = (c: NameCase): Outcome => {
	const refusal = refusalOf(c)
	const path: ReadonlyArray<string> =
		c.site === "command" ? [c.name] : c.site === "group" ? [c.name, "planted"] : ["planted"]
	return {
		refusals: Option.match(refusal, { onNone: () => [], onSome: (one) => [one] }),
		command: Option.isSome(refusal) ? Option.none() : Option.some(path)
	}
}

type NamespaceFeature =
	| `${Site} admitted`
	| `${Site} refused`
	| "a runtime flag's name as a command"
	| "a runtime flag's name as a group"

/** A feature when it holds, none otherwise. */
const when = (holds: boolean, feature: NamespaceFeature): ReadonlyArray<NamespaceFeature> =>
	holds ? [feature] : []

/** The features a case reaches: its site's outcome, and a runtime flag's name taken as a command or group. */
const featuresOf = (c: NameCase, expected: Outcome): ReadonlyArray<NamespaceFeature> => {
	const outcome: NamespaceFeature = Option.isSome(expected.command)
		? `${c.site} admitted`
		: `${c.site} refused`
	const flagName = reservedFlagNames.has(c.name) && !reservedCommandNames.has(c.name)
	return [
		outcome,
		...when(flagName && c.site === "command", "a runtime flag's name as a command"),
		...when(flagName && c.site === "group", "a runtime flag's name as a group")
	]
}

/** Generates the case's document into a scoped directory and reads its refusals and command off the report. */
const outcomeOf = (c: NameCase) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const dir = yield* fs.makeTempDirectoryScoped({ prefix: "reserved-namespaces-" })
		const configPath = path.join(dir, "author-config.json")
		yield* fs.writeFileString(
			configPath,
			jsonTextOf({
				package: { name: "reserved-namespaces", version: "1.0.0" },
				binName: "rn",
				envPrefix: "RN"
			})
		)
		const document = {
			openapi: "3.1.0",
			info: { title: "Reserved namespaces", version: "1.0.0" },
			paths: { [PATH]: { [c.method]: operationOf(c) } }
		}
		const result = yield* generate(
			{
				document: DocumentUri.make("file:///reserved/openapi.json"),
				outDir: path.join(dir, "out"),
				source: {
					_tag: "Stream",
					stream: Stream.make(new TextEncoder().encode(jsonTextOf(document)))
				},
				strict: false
			},
			{ document: DocumentUri.make("file:///reserved/author-config.json"), path: configPath }
		)
		const outcome: Outcome = {
			refusals: Arr.map(
				result.report.refusals,
				(refusal): readonly [code: string, pointer: string] => [refusal.code, refusal.pointer]
			),
			command: Option.map(
				Arr.findFirst(result.report.commandNames, (command) => command.pointer === pointerOf(c)),
				(command) => command.path
			)
		}
		return outcome
	})

layer(harnessLayer, { excludeTestServices: true })("names: reserved namespaces", (it) => {
	it.effect("a name is refused at a site exactly when that site's namespace reserves it", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "reserved namespaces",
					draw: drawn(caseGen),
					literal: Formatter.format,
					coverage: required<NamespaceFeature>(
						[
							"command admitted",
							"command refused",
							"group admitted",
							"group refused",
							"parameter admitted",
							"parameter refused",
							"body admitted",
							"body refused",
							"a runtime flag's name as a command",
							"a runtime flag's name as a group"
						],
						{ cases: 100, sense: notesOnly }
					),
					kept: [],
					runs: 40,
					shrink: { kind: "bounded", candidates: 60 },
					concurrency: 1,
					steerEvery: 20,
					caseHang: Duration.seconds(30)
				},
				(c, k) =>
					Effect.scoped(
						Effect.gen(function* () {
							const expected = expectedOf(c)
							k.noteAll(featuresOf(c, expected))
							const outcome = yield* outcomeOf(c)
							deepStrictEqual(
								outcome,
								expected,
								"the site's namespace alone decides whether the name is refused"
							)
						})
					)
			)
		)
	)
})
