/**
 * What the property of reserved-namespaces.test.ts reads: one operation holding a drawn name at a drawn site, the
 * document and author config it is generated from, and the outcome its namespace alone decides.
 */

import { jsonText } from "@bjornpagen/grizzle-text/utf8"
import { dictionary, word } from "@bjornpagen/testing/dictionary"
import {
	aimed,
	type Aimed,
	boolean,
	constant,
	element,
	type Gen,
	oneOf
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, FileSystem, JsonPointer, Option, Order, Path, Stream } from "effect"
import type { Schema } from "effect"
import { generate } from "#generate.ts"
import { fixedDocumentUri } from "#model/brands.ts"
import { reservedCommandNames, reservedFlagNames } from "#names/reserved.ts"

/**
 * Where the drawn name sits: the operation's command name, its group (tag), a query parameter, a JSON body field, or a
 * path parameter (a positional) beside a body field.
 */
export type Site = "command" | "group" | "parameter" | "body" | "positional"

/** The body field beside a positional: one of its name, one sharing its leading word, or none. */
type Beside = "same name" | "leading word" | "none"

/** One case: the drawn name, the site holding it, the operation's method, and for a positional its neighbour and rename. */
export type NameCase = Readonly<{
	name: string
	site: Site
	method: "post" | "put"
	beside: Beside
	renamed: boolean
}>

/** The sorted members of a reserved set behind `first`, the member a counterexample shrinks to. */
const membersAfter = (
	first: string,
	names: ReadonlySet<string>
): Arr.NonEmptyReadonlyArray<string> => Arr.prepend(Arr.sort([...names], Order.String), first)

/** The reserved sets are the generator's own vocabulary of what it holds back, read as dictionaries. */
const FLAG_NAMES = dictionary(membersAfter("follow", reservedFlagNames))

const COMMAND_NAMES = dictionary(membersAfter("help", reservedCommandNames))

const ordinary = element(["limit", "owner", "page-size"])

/** A name of each kind as often as the others: ordinary, a reserved flag name (`follow` first) or a reserved command. */
const nameGen: Gen<string> = oneOf([ordinary, word(FLAG_NAMES), word(COMMAND_NAMES)])

const caseGen =
	(site: Gen<Site>): Gen<NameCase> =>
	(s) => {
		const drawnSite = s.draw(site)
		return {
			name: drawnSite === "positional" ? s.draw(ordinary) : s.draw(nameGen),
			site: drawnSite,
			method: s.draw(element<NameCase["method"]>(["post", "put"])),
			beside:
				drawnSite === "positional"
					? s.draw(element<Beside>(["same name", "leading word", "none"]))
					: "none",
			renamed: drawnSite === "positional" && s.draw(boolean)
		}
	}

const ok = { "200": { description: "ok" } } as const

const jsonBody = (field: string): Schema.JsonObject => ({
	required: true,
	content: {
		"application/json": { schema: { type: "object", properties: { [field]: { type: "string" } } } }
	}
})

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
			return { operationId: "planted", requestBody: jsonBody(c.name), responses: ok }
		case "positional":
			return {
				operationId: "planted",
				parameters: [{ name: c.name, in: "path", required: true, schema: { type: "string" } }],
				...(c.beside === "none"
					? {}
					: { requestBody: jsonBody(c.beside === "same name" ? c.name : `${c.name}-prefix`) }),
				responses: ok
			}
	}
}

const pathOf = (c: NameCase): string =>
	c.site === "positional" ? `/planted/{${c.name}}` : "/planted"

const pointerOf = (c: NameCase): string =>
	`/paths/${JsonPointer.escapeToken(pathOf(c))}/${c.method}`

/** What the generator does with the operation: the refusals it reports, and the command path when it names one. */
export type Outcome = Readonly<{
	refusals: ReadonlyArray<readonly [code: string, pointer: string]>
	command: Option.Option<ReadonlyArray<string>>
}>

/** The refusal the site's namespace earns the name, with the pointer it is reported at. */
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
		case "positional":
			return c.beside === "same name" && !c.renamed
				? Option.some(["PRM-02/flag-collision", `${operation}/parameters/0`])
				: Option.none()
	}
}

/** The site's namespace decides: the refusal it earns the name, else the command at the path the site gives. */
export const expectedOf = (c: NameCase): Outcome => {
	const refusal = refusalOf(c)
	const path: ReadonlyArray<string> =
		c.site === "command" ? [c.name] : c.site === "group" ? [c.name, "planted"] : ["planted"]
	return {
		refusals: Option.match(refusal, { onNone: () => [], onSome: (one) => [one] }),
		command: Option.isSome(refusal) ? Option.none() : Option.some(path)
	}
}

export type NamespaceFeature =
	| `${Site} admitted`
	| `${Site} refused`
	| "a runtime flag's name as a command"
	| "a runtime flag's name as a group"
	| "a positional renamed past a body field"
	| "a positional and a field sharing a leading word"

/** A feature when it holds, none otherwise. */
const when = (holds: boolean, feature: NamespaceFeature): ReadonlyArray<NamespaceFeature> =>
	holds ? [feature] : []

/** The features a case reaches: its site's outcome, a runtime flag's name as a command or group, a positional's neighbour. */
export const featuresOf = (c: NameCase): ReadonlyArray<NamespaceFeature> => {
	const expected = expectedOf(c)
	const outcome: NamespaceFeature = Option.isSome(expected.command)
		? `${c.site} admitted`
		: `${c.site} refused`
	const flagName = reservedFlagNames.has(c.name) && !reservedCommandNames.has(c.name)
	return [
		outcome,
		...when(flagName && c.site === "command", "a runtime flag's name as a command"),
		...when(flagName && c.site === "group", "a runtime flag's name as a group"),
		...when(
			c.site === "positional" && c.beside === "same name" && c.renamed,
			"a positional renamed past a body field"
		),
		...when(
			c.site === "positional" && c.beside === "leading word",
			"a positional and a field sharing a leading word"
		)
	]
}

/** The author config: the bin, and for a renamed positional its `path:<name>` flag override. */
const configOf = (c: NameCase): Schema.JsonObject => ({
	package: { name: "reserved-namespaces", version: "1.0.0" },
	binName: "rn",
	envPrefix: "RN",
	...(c.renamed
		? {
				naming: {
					operations: { planted: { parameters: { [`path:${c.name}`]: { flag: `${c.name}-key` } } } }
				}
			}
		: {})
})

/** Generates the case's document under `dir` and reads its refusals and the operation's command off the report. */
export const outcomeOf = (c: NameCase, dir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const configPath = path.join(dir, "author-config.json")
		yield* fs.writeFileString(configPath, jsonText(configOf(c)))
		const document = {
			openapi: "3.1.0",
			info: { title: "Reserved namespaces", version: "1.0.0" },
			paths: { [pathOf(c)]: { [c.method]: operationOf(c) } }
		}
		const result = yield* generate(
			{
				document: fixedDocumentUri("file:///reserved/openapi.json"),
				outDir: path.join(dir, "out"),
				source: {
					_tag: "Stream",
					stream: Stream.make(new TextEncoder().encode(jsonText(document)))
				},
				strict: false
			},
			{ document: fixedDocumentUri("file:///reserved/author-config.json"), path: configPath }
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

const anySite = element<Site>(["command", "group", "parameter", "body", "positional"])

/** A case at `site` holding a name `name` draws, its positional fields as drawn. */
const at =
	(site: Site, name: Gen<string>): Gen<NameCase> =>
	(s) => ({ ...s.draw(caseGen(constant(site))), name: s.draw(name) })

/** A positional case with its neighbour and rename fixed. */
const positional =
	(beside: Beside, renamed: boolean): Gen<NameCase> =>
	(s) => ({ ...s.draw(caseGen(constant("positional"))), beside, renamed })

/** Name cases, aimed at each site admitting and refusing and at the namespaces' edges. */
export const nameSpace: Aimed<NameCase, NamespaceFeature> = aimed(caseGen(anySite), [
	["command admitted", at("command", ordinary)],
	["command refused", at("command", word(COMMAND_NAMES))],
	["group admitted", at("group", ordinary)],
	["group refused", at("group", word(COMMAND_NAMES))],
	["parameter admitted", at("parameter", ordinary)],
	["parameter refused", at("parameter", word(FLAG_NAMES))],
	["body admitted", at("body", ordinary)],
	["body refused", at("body", word(FLAG_NAMES))],
	["positional admitted", positional("none", false)],
	["positional refused", positional("same name", false)],
	["a runtime flag's name as a command", at("command", constant("follow"))],
	["a runtime flag's name as a group", at("group", constant("follow"))],
	["a positional renamed past a body field", positional("same name", true)],
	["a positional and a field sharing a leading word", positional("leading word", false)]
])
