import { Array as Arr, Effect, Exit, Option, Schema, String as Str } from "effect"
import { describe, expect, test } from "vitest"
import { fixedDocumentUri } from "#model/brands.ts"
import { isDiagnostic } from "#model/diagnostic.ts"
import type { Diagnostic } from "#model/diagnostic.ts"
import {
	GenerationReport,
	generatorExitStatus,
	makeGenerationReport,
	printGenerationReport
} from "#report/index.ts"
import type { GenerationReportInput } from "#report/index.ts"

/** The run's entry document, which the report names every document against. */
const entry = fixedDocumentUri("file:///spec.json")

const base = {
	document: "file:///spec.json",
	element: "Parameter style deepObject",
	message: "deepObject value has nested objects",
	openapi: "3.0.3",
	specSection: "https://spec.openapis.org/oas/v3.0.4.html#style-values"
} as const

const make = (
	severity: "notice" | "refusal",
	scope: "document" | "element" | "operation",
	code: string,
	pointer: string
) =>
	Schema.decodeUnknownSync(Schema.declare(isDiagnostic))({
		...base,
		code,
		pointer,
		row: code.split("/")[0],
		scope,
		severity
	})

const documentRefusal = make("refusal", "document", "DOC-1/unsupported-version", "")

const operationRefusal = make("refusal", "operation", "PRM-27/compound-nested", "/paths/~1x/get")

const notice = make("notice", "element", "PRM-19/ignored-header", "/paths/~1x/get/p/1")

const inputs = Schema.decodeUnknownSync(GenerationReport.fields.inputs)([
	{ document: "file:///spec.json", sha256: "a".repeat(64) },
	{ document: "file:///other.json", sha256: "b".repeat(64) }
])

const renames = Schema.decodeUnknownSync(GenerationReport.fields.renames)([
	{ from: "list", pointer: "/paths/~1x/get", to: "list-2" }
])

const input = (diagnostics: readonly Diagnostic[]): GenerationReportInput => ({
	acceptedServers: ["https://api.example.com"],
	diagnostics,
	inputs,
	renames,
	version: "0.1.0"
})

const print = (diagnostics: readonly Diagnostic[]) =>
	Effect.runSync(printGenerationReport(makeGenerationReport(input(diagnostics)), entry))

describe("generation report bytes", () => {
	const text = print([operationRefusal, notice])

	const parsed: unknown = JSON.parse(text)

	test("keys are sorted at the top level of the printed text", () => {
		const keys = Arr.flatMap(Str.split("\n")(text), (line) =>
			Str.startsWith('  "')(line) ? Option.toArray(Arr.get(Str.split('"')(line), 1)) : []
		)

		expect(keys).toEqual([
			"acceptedServers",
			"commandNames",
			"generator",
			"inputs",
			"nonStandard",
			"notices",
			"refusals",
			"renames",
			"skipped"
		])
	})

	test("records servers, input digests in given order, version and renames, each document by its label", () => {
		expect(parsed).toMatchObject({
			acceptedServers: ["https://api.example.com"],
			generator: { version: "0.1.0" },
			inputs: [
				{ document: "spec.json", sha256: Str.repeat(64)("a") },
				{ document: "other.json", sha256: Str.repeat(64)("b") }
			],
			renames
		})
	})

	test("lists refusals and notices in full, split by severity, in the order given", () => {
		expect(parsed).toMatchObject({
			notices: [{ code: "PRM-19/ignored-header", document: "spec.json" }],
			refusals: [{ code: "PRM-27/compound-nested", document: "spec.json", message: base.message }]
		})
	})

	test("a bad digest fails with a schema error", () => {
		const bad = {
			...makeGenerationReport(input([])),
			inputs: inputs.map((entry) => ({ ...entry, sha256: "xyz" }))
		}

		expect(Exit.isFailure(Effect.runSyncExit(printGenerationReport(bad, entry)))).toBe(true)
	})
})

describe("generatorExitStatus", () => {
	test("output written with no refusals exits 0", () => {
		expect(generatorExitStatus({ _tag: "Written", diagnostics: [notice], strict: false })).toBe(0)
		expect(generatorExitStatus({ _tag: "Written", diagnostics: [notice], strict: true })).toBe(0)
	})

	test("a partly refused run exits 0 without --strict", () => {
		expect(
			generatorExitStatus({ _tag: "Written", diagnostics: [operationRefusal], strict: false })
		).toBe(0)
	})

	test("a document refusal exits 1", () => {
		expect(
			generatorExitStatus({
				_tag: "Written",
				diagnostics: [notice, documentRefusal],
				strict: false
			})
		).toBe(1)
	})

	test("any refusal exits 1 under --strict", () => {
		expect(
			generatorExitStatus({ _tag: "Written", diagnostics: [operationRefusal], strict: true })
		).toBe(1)
	})
})
