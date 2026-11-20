import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { jsonTextOf } from "@superstarter/json"
import { Array as Arr, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { generate } from "#generate.ts"
import { DocumentUri, JsonPointer } from "#model/brands.ts"
import { formatPointer, type Json } from "#model/pointer.ts"
import type { CommandNameSource, GroupNameSource } from "#names/plan.ts"
import { CommandName, GenerationReport } from "#report/index.ts"

const document = DocumentUri.make("file:///names/openapi.json")

const configDocument = DocumentUri.make("file:///names/author-config.json")

const layer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layerDigest)

const decodeReport = Schema.decodeEffect(Schema.fromJsonString(GenerationReport))

type CommandName = typeof CommandName.Type

const ok = { responses: { "200": { description: "ok" } } } as const

const baseConfig = {
	binName: "example",
	package: { name: "example-cli", version: "1.0.0" }
} as const

const spec = (paths: { readonly [path: string]: Json }): Json => ({
	info: { title: "names", version: "1" },
	openapi: "3.1.1",
	paths
})

/** One operation per naming source, plus one with two aliases and one emitCli refuses. */
const curated = spec({
	"/fern": {
		get: {
			...ok,
			operationId: "fernOp",
			"x-fern-sdk-group-name": "billing",
			"x-fern-sdk-method-name": "getInvoice"
		}
	},
	"/forge": {
		get: {
			...ok,
			operationId: "forgeOp",
			"x-fern-sdk-method-name": "ignored",
			"x-forge-group-name": "accounts.members",
			"x-forge-method-name": "list"
		}
	},
	"/notes": {
		post: {
			...ok,
			operationId: "notesCreate",
			requestBody: {
				content: { "text/event-stream": { schema: { type: "string" } } },
				required: true
			},
			tags: ["notes"],
			"x-forge-aliases": [{ "x-forge-group-name": "memo", "x-forge-method-name": "add" }]
		}
	},
	"/routes/{id}": {
		get: {
			...ok,
			parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }]
		}
	},
	"/tagged": { get: { ...ok, operationId: "listTagged", tags: ["things"] } },
	"/widgets": { get: { ...ok, operationId: "listWidgets", tags: ["widgets"] } },
	"/zones": {
		patch: {
			...ok,
			operationId: "editZone",
			"x-forge-aliases": [
				{ "x-forge-group-name": "dns", "x-forge-method-name": "edit-zone" },
				{ "x-fern-sdk-group-name": "legacy", "x-fern-sdk-method-name": "updateZone" }
			],
			"x-forge-group-name": "zones",
			"x-forge-method-name": "edit"
		}
	}
})

const curatedConfig = {
	...baseConfig,
	naming: { operations: { listWidgets: { command: "show-all", group: "inventory" } } }
} as const

/** Tags, operationIds and routes only. */
const plain = spec({
	"/health": { get: ok },
	"/pets": { get: { ...ok, operationId: "listPets", tags: ["pets"] } },
	"/pets/{id}": {
		get: {
			...ok,
			parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
			tags: ["pets"]
		}
	},
	"/version": { get: { ...ok, operationId: "getVersion" } }
})

/** The sources a spec without naming extensions can name a group or a command by. */
const plainSources: ReadonlyArray<GroupNameSource | CommandNameSource> = [
	"none",
	"operationId",
	"route",
	"tag"
]

const added = {
	...baseConfig,
	security: {
		add: {
			requirement: [{ token: [] }],
			schemes: { token: { scheme: "bearer", type: "http" } }
		}
	}
} as const

/** Runs `generate` in a scoped temp directory and answers the report file's bytes. */
const reportText = Effect.fn("reportText")(function* (value: Json, config: Json) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const dir = yield* fs.makeTempDirectoryScoped({ prefix: "nmx4-" })
	const specPath = path.join(dir, "openapi.json")
	const configPath = path.join(dir, "author-config.json")
	const out = path.join(dir, "out")
	yield* fs.writeFileString(specPath, jsonTextOf(value))
	yield* fs.writeFileString(configPath, jsonTextOf(config))
	yield* generate(
		{
			document,
			outDir: out,
			source: { _tag: "File", path: specPath },
			strict: false
		},
		{ document: configDocument, path: configPath }
	)

	return yield* fs.readFileString(path.join(out, "generation-report.json"))
}, Effect.scoped)

const reportOf = (value: Json, config: Json) =>
	Effect.flatMap(reportText(value, config), decodeReport)

const pointerOf = (path: string, method: string): typeof JsonPointer.Type =>
	JsonPointer.make(formatPointer(["paths", path, method]))

const entry = (
	path: ReadonlyArray<string>,
	group: GroupNameSource,
	command: CommandNameSource,
	at: readonly [string, string]
): CommandName => ({ command, document, group, path, pointer: pointerOf(...at) })

const aliased = (alias: number, name: CommandName): CommandName => ({ alias, ...name })

describe("generation report commandNames", () => {
	test("lists every emitted command with the source of its group and command name", () =>
		Effect.gen(function* () {
			const report = yield* reportOf(curated, curatedConfig)

			expect(report.commandNames).toEqual([
				entry(["billing", "get-invoice"], "x-fern", "x-fern", ["/fern", "get"]),
				entry(["accounts", "members", "list"], "x-forge", "x-forge", ["/forge", "get"]),
				entry(["things", "list-tagged"], "tag", "operationId", ["/tagged", "get"]),
				entry(["inventory", "show-all"], "config", "config", ["/widgets", "get"]),
				entry(["zones", "edit"], "x-forge", "x-forge", ["/zones", "patch"]),
				aliased(0, entry(["dns", "edit-zone"], "x-forge", "x-forge", ["/zones", "patch"])),
				aliased(1, entry(["legacy", "update-zone"], "x-fern", "x-fern", ["/zones", "patch"])),
				entry(["get-routes-by-id"], "none", "route", ["/routes/{id}", "get"])
			])
		}).pipe(Effect.provide(layer), Effect.runPromise))

	test("an operation emitCli refuses is reported once and none of its names is listed", () =>
		Effect.gen(function* () {
			const report = yield* reportOf(curated, curatedConfig)
			const refused = Arr.filter(report.refusals, (diagnostic) => diagnostic.row === "EMT-1")

			expect(Arr.map(refused, ({ code, pointer }) => `${code} ${pointer}`)).toEqual([
				`EMT-1/unsupported-body ${pointerOf("/notes", "post")}`
			])
			expect(
				Arr.filter(report.commandNames, (name) => name.pointer === pointerOf("/notes", "post"))
			).toEqual([])
		}).pipe(Effect.provide(layer), Effect.runPromise))

	test("a spec without naming extensions lists tag, none, operationId and route sources only", () =>
		Effect.gen(function* () {
			const report = yield* reportOf(plain, baseConfig)
			const sources = Arr.flatMap(report.commandNames, (name) => [name.group, name.command])

			expect(Arr.every(sources, (source) => Arr.contains(plainSources, source))).toBe(true)
			expect(Arr.map(report.commandNames, ({ command, group }) => ({ command, group }))).toEqual([
				{ command: "operationId", group: "tag" },
				{ command: "route", group: "tag" },
				{ command: "route", group: "none" },
				{ command: "operationId", group: "none" }
			])
			expect(Arr.some(report.commandNames, (name) => "alias" in name)).toBe(false)
		}).pipe(Effect.provide(layer), Effect.runPromise))

	test("two runs print equal bytes", () =>
		Effect.gen(function* () {
			const first = yield* reportText(curated, curatedConfig)
			const second = yield* reportText(curated, curatedConfig)

			expect(first).toBe(second)
		}).pipe(Effect.provide(layer), Effect.runPromise))

	test("an author-supplied scheme reaches the written report", () =>
		Effect.gen(function* () {
			const report = yield* reportOf(plain, added)

			expect(report.authorSuppliedSchemes).toEqual([
				{ key: "security.add.schemes.token", name: "token" }
			])
		}).pipe(Effect.provide(layer), Effect.runPromise))
})
