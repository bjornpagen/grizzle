/**
 * The CLI emitter's own refusals, by planted faults. A generated document gains one operation holding exactly one
 * construct the CLI emitter cannot express, from a named family; generation keeps the rest of the package and reports
 * that operation once, at its pointer, as `EMT-1/<reason>` for the family's reason, with no command named for it, and
 * the same run under `--strict` writes nothing and is refused as strict. The families: a boolean path parameter, a
 * path array before another positional, a path parameter written by content, form content in a query parameter (each
 * `unsupported-parameter`), and an event-stream request body, alone or beside an NDJSON or a text alternative
 * (`unsupported-body`).
 *
 * Plants, each applied to src/emit/cli.ts, seen to fail this suite and reverted:
 * - positionalEntry refusing a boolean path parameter as `unsupported-flag`, so its operation was reported as
 *   `EMT-1/unsupported-flag`.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { element, type Gen, oneOf, shuffled } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import {
	Array as Arr,
	Cause,
	Duration,
	Effect,
	Exit,
	FileSystem,
	Formatter,
	JsonPointer,
	Option,
	Path,
	Predicate,
	Record,
	Schema,
	Stream
} from "effect"
import { generate } from "#generate.ts"
import { DocumentUri } from "#model/brands.ts"
import { configGen, configOf, documentGen, documentOf, textOf } from "#test/emit/openapi-gen.ts"
import type { ConfigSketch, DocumentSketch } from "#test/emit/openapi-gen.ts"
import { harnessLayer } from "#test/support/cli-package.ts"

type Family =
	| "a boolean path parameter"
	| "a path array before another positional"
	| "a path parameter by content"
	| "form content in a query parameter"
	| "an event-stream request body"
	| "an event-stream alternative beside others"

/** One planted operation: its path, method and Operation Object, the family it belongs to and the reason it earns. */
type Plant = Readonly<{
	path: string
	method: string
	operation: Schema.Json
	family: Family
	reason: "unsupported-parameter" | "unsupported-body"
}>

const ok = { "200": { description: "ok" } } as const

const pathParameter = (name: string, schema: Schema.Json) => ({
	in: "path",
	name,
	required: true,
	schema
})

/** The alternatives an event-stream body may sit beside, which never make it sendable. */
const EVENT_STREAM_COMPANIONS: Arr.NonEmptyReadonlyArray<readonly [string, Schema.Json]> = [
	["application/x-ndjson", { schema: { type: "object" } }],
	["text/plain", { schema: { type: "string" } }]
]

const plantGen: Gen<Plant> = oneOf<Plant>([
	(s) => ({
		path: "/planted/{flag}",
		method: s.draw(element(["get", "post", "delete"])),
		operation: {
			operationId: "planted",
			parameters: [pathParameter("flag", { type: "boolean" })],
			responses: ok
		},
		family: "a boolean path parameter",
		reason: "unsupported-parameter"
	}),
	(s) => ({
		path: "/planted/{ids}/{id}",
		method: s.draw(element(["get", "put"])),
		operation: {
			operationId: "planted",
			parameters: [
				pathParameter("ids", { type: "array", items: { type: "string" } }),
				pathParameter("id", { type: "string" })
			],
			responses: ok
		},
		family: "a path array before another positional",
		reason: "unsupported-parameter"
	}),
	(s) => ({
		path: "/planted/{id}",
		method: s.draw(element(["get", "patch"])),
		operation: {
			operationId: "planted",
			parameters: [
				{
					in: "path",
					name: "id",
					required: true,
					content: { "application/json": { schema: { type: "object" } } }
				}
			],
			responses: ok
		},
		family: "a path parameter by content",
		reason: "unsupported-parameter"
	}),
	(s) => ({
		path: "/planted",
		method: s.draw(element(["get", "post"])),
		operation: {
			operationId: "planted",
			parameters: [
				{
					in: "query",
					name: "filter",
					content: {
						"application/x-www-form-urlencoded": {
							schema: { type: "object", properties: { a: { type: "string" } } }
						}
					}
				}
			],
			responses: ok
		},
		family: "form content in a query parameter",
		reason: "unsupported-parameter"
	}),
	(s) => ({
		path: "/planted",
		method: s.draw(element(["post", "put"])),
		operation: {
			operationId: "planted",
			requestBody: {
				required: true,
				content: { "text/event-stream": { schema: { type: "string" } } }
			},
			responses: ok
		},
		family: "an event-stream request body",
		reason: "unsupported-body"
	}),
	(s) => ({
		path: "/planted",
		method: s.draw(element(["post", "put"])),
		operation: {
			operationId: "planted",
			requestBody: {
				required: true,
				content: Record.fromEntries<readonly [string, Schema.Json]>([
					["text/event-stream", { schema: { type: "string" } }],
					...s.draw(shuffled(EVENT_STREAM_COMPANIONS, { min: 1, max: 2 }))
				])
			},
			responses: ok
		},
		family: "an event-stream alternative beside others",
		reason: "unsupported-body"
	})
])

/** A generated document, an author config that fits it, and the operation planted into it. */
type RefusalCase = Readonly<{ document: DocumentSketch; config: ConfigSketch; plant: Plant }>

const caseGen: Gen<RefusalCase> = (s) => {
	const document = s.draw(documentGen)
	return { document, config: s.draw(configGen(document)), plant: s.draw(plantGen) }
}

const isObject = (value: Schema.Json): value is Schema.JsonObject =>
	Predicate.isObject(value) && !Arr.isArray(value)

/** The document with the planted operation at its own path. */
const plantedDocument = (drawnCase: RefusalCase): Schema.JsonObject => {
	const document = documentOf(drawnCase.document)
	const paths = Option.getOrElse(
		Option.filter(Record.get<string, Schema.Json>(document, "paths"), isObject),
		(): Schema.JsonObject => ({})
	)
	const planted: Schema.JsonObject = { [drawnCase.plant.method]: drawnCase.plant.operation }
	return Record.set<string, Schema.Json, string, Schema.Json>(
		document,
		"paths",
		Record.set<string, Schema.Json, string, Schema.Json>(paths, drawnCase.plant.path, planted)
	)
}

const pointerOf = (plant: Plant): string =>
	`/paths/${JsonPointer.escapeToken(plant.path)}/${plant.method}`

/** Generates the case into a fresh directory, strict or not, and gives the run's exit with that directory. */
const generated = (drawnCase: RefusalCase, strict: boolean) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const dir = yield* fs.makeTempDirectoryScoped({ prefix: "emit-refusal-" })
		const configPath = path.join(dir, "author-config.json")
		yield* fs.writeFileString(configPath, textOf(configOf(drawnCase.config)))
		const outDir = path.join(dir, "out")
		const exit = yield* Effect.exit(
			generate(
				{
					document: DocumentUri.make("file:///refusal/openapi.json"),
					outDir,
					source: {
						_tag: "Stream",
						stream: Stream.make(new TextEncoder().encode(textOf(plantedDocument(drawnCase))))
					},
					strict
				},
				{ document: DocumentUri.make("file:///refusal/author-config.json"), path: configPath }
			)
		)
		return { exit, written: yield* fs.exists(outDir) }
	})

layer(harnessLayer, { excludeTestServices: true })("emit: operation refusals", (it) => {
	it.effect(
		"an operation holding one construct the CLI emitter cannot express is refused once at its pointer, and strict writes nothing",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "emit refusals",
						oracle: {
							kind: "specification",
							name: "each planted family's EMT-1 reason, once at its pointer, and nothing written under --strict"
						},
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<Family>(
							[
								"a boolean path parameter",
								"a path array before another positional",
								"a path parameter by content",
								"form content in a query parameter",
								"an event-stream request body",
								"an event-stream alternative beside others"
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
					(drawnCase, k) =>
						Effect.scoped(
							Effect.gen(function* () {
								k.note(drawnCase.plant.family)
								const pointer = pointerOf(drawnCase.plant)
								const lenient = yield* generated(drawnCase, false)
								const strict = yield* generated(drawnCase, true)
								const result = yield* lenient.exit
								deepStrictEqual(
									{
										refusals: Arr.map(
											Arr.filter(
												result.diagnostics,
												(diagnostic) => diagnostic.pointer === pointer
											),
											(diagnostic) => diagnostic.code
										),
										commands: Arr.filter(
											result.report.commandNames,
											(command) => command.pointer === pointer
										).length,
										strict: Exit.match(strict.exit, {
											onSuccess: () => Option.none<string>(),
											onFailure: (cause) =>
												Option.map(Cause.findErrorOption(cause), (error) =>
													error._tag === "GenerateRefused" ? error.reason : error._tag
												)
										}),
										strictWrote: strict.written
									},
									{
										refusals: [`EMT-1/${drawnCase.plant.reason}`],
										commands: 0,
										strict: Option.some("strict"),
										strictWrote: false
									}
								)
							})
						)
				)
			)
	)
})
