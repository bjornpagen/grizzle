/**
 * What the properties of report.test.ts read: the run a generation report records (accepted servers, diagnostics of
 * either severity at every scope, input documents and the digests of their contents, renames and the generator's
 * version), the report design 8.1 makes of it, and the exit statuses of design 8.1 over every outcome of a run.
 */

import {
	array,
	boolean,
	element,
	finite,
	type FiniteSpace,
	type Gen,
	subset
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import type { Digest } from "effect/crypto"
import { fixedDocumentUri } from "#model/brands.ts"
import {
	type Diagnostic,
	type DiagnosticInput,
	diagnosticScopes,
	diagnosticSeverities,
	makeDiagnostic
} from "#model/diagnostic.ts"
import { sha256Hex } from "#model/digest.ts"
import { formatPointer } from "#model/pointer.ts"
import type { GenerationReportInput, GeneratorOutcome } from "#report/index.ts"

/** A diagnostic of a run: its severity and scope, and the row it is coded under. */
export type DiagnosticSketch = Readonly<{
	severity: Diagnostic["severity"]
	scope: Diagnostic["scope"]
	code: string
}>

const CODES = [
	"PRM-27/compound-nested",
	"PRM-19/ignored-header",
	"DOC-1/unsupported-version"
] as const

const diagnosticGen: Gen<DiagnosticSketch> = (source) => ({
	severity: source.draw(element(diagnosticSeverities)),
	scope: source.draw(element(diagnosticScopes)),
	code: source.draw(element(CODES))
})

/** The diagnostic a sketch stands for, made as the generator makes one. */
const diagnosticOf = (sketch: DiagnosticSketch, place: number): Effect.Effect<Diagnostic> => {
	const fields: DiagnosticInput = {
		code: sketch.code,
		document: fixedDocumentUri("file:///spec.json"),
		element: "Parameter style deepObject",
		message: `diagnostic ${String(place)}`,
		openapi: "3.0.3",
		pointer: formatPointer(["paths", "/x", "get", String(place)]),
		scope: sketch.scope,
		severity: sketch.severity,
		specSection: fixedDocumentUri("https://spec.openapis.org/oas/v3.0.4.html#style-values")
	}
	return makeDiagnostic(fields)
}

/** One run a report records. */
export type RunSketch = Readonly<{
	servers: ReadonlyArray<string>
	diagnostics: ReadonlyArray<DiagnosticSketch>
	inputs: ReadonlyArray<Readonly<{ document: string; content: string }>>
	renames: ReadonlyArray<Readonly<{ from: string; to: string }>>
	version: string
}>

/** Runs of up to four diagnostics, three inputs, two servers and two renames, in any order. */
export const runSpace: Gen<RunSketch> = (source) => ({
	servers: source.draw(
		array(element(["https://api.example.com", "https://eu.example.com/v2"]), { min: 0, max: 2 })
	),
	diagnostics: source.draw(array(diagnosticGen, { min: 0, max: 4 })),
	inputs: source.draw(
		array(
			(inner) => ({
				document: inner.draw(
					element(["file:///spec.json", "file:///other.json", "file:///config.json"])
				),
				content: inner.draw(element(["{}", "openapi: 3.1.0", ""]))
			}),
			{ min: 1, max: 3 }
		)
	),
	renames: source.draw(
		array(
			(inner) => ({
				from: inner.draw(element(["list", "get"])),
				to: inner.draw(element(["list-2", "get-2"]))
			}),
			{ min: 0, max: 2 }
		)
	),
	version: source.draw(element(["0.1.0", "1.0.0-rc.1"]))
})

export type RunFeature =
	| "a refusal"
	| "a notice"
	| "refusals and notices interleaved"
	| "two inputs"
	| "a rename"
	| "no server"

export const runFeatures = (run: RunSketch): ReadonlyArray<RunFeature> => {
	const when = (holds: boolean, feature: RunFeature): ReadonlyArray<RunFeature> =>
		holds ? [feature] : []
	const severities = Arr.map(run.diagnostics, (sketch) => sketch.severity)
	return [
		...when(Arr.contains(severities, "refusal"), "a refusal"),
		...when(Arr.contains(severities, "notice"), "a notice"),
		...when(
			Arr.some(
				severities,
				(severity, index) =>
					severity === "notice" && Arr.contains(Arr.drop(severities, index + 1), "refusal")
			),
			"refusals and notices interleaved"
		),
		...when(run.inputs.length > 1, "two inputs"),
		...when(Arr.isReadonlyArrayNonEmpty(run.renames), "a rename"),
		...when(Arr.isReadonlyArrayEmpty(run.servers), "no server")
	]
}

/** What a run tells the report, its diagnostics and digests made as the generator makes them. */
export const inputOf = (
	run: RunSketch
): Effect.Effect<
	Readonly<{ input: GenerationReportInput; diagnostics: ReadonlyArray<Diagnostic> }>,
	never,
	Digest.Digest
> =>
	Effect.gen(function* () {
		const diagnostics = yield* Effect.forEach(run.diagnostics, diagnosticOf)
		const inputs = yield* Effect.forEach(run.inputs, ({ document, content }) =>
			Effect.map(sha256Hex(content), (sha256) => ({ document: fixedDocumentUri(document), sha256 }))
		)
		return {
			diagnostics,
			input: {
				acceptedServers: run.servers,
				diagnostics,
				inputs,
				renames: Arr.map(run.renames, ({ from, to }) => ({
					from,
					pointer: formatPointer(["paths", "/x", from]),
					to
				})),
				version: run.version
			}
		}
	})

/** The entry document the report names every document against (report/index.ts printGenerationReport). */
export const reportEntry = fixedDocumentUri("file:///spec.json")

/**
 * A document's name in the printed report: every document a run draws sits beside the entry, in the root folder, so
 * its label is its file name alone, with no scheme and no host path.
 */
const labelOf = (document: string): string => Str.replace("file:///", "")(document)

/**
 * Design 8.1's report of a run as its text prints it: its servers, inputs in the order given, version and renames as
 * given, its refusals and its notices each in the order given, every document named by its label (labelOf), and no
 * command, non-standard element, skipped operation or added scheme, which the run has none of.
 */
export const expectedReport = (
	input: GenerationReportInput,
	diagnostics: ReadonlyArray<Diagnostic>
) => {
	const labelled = (diagnostic: Diagnostic) => ({
		...diagnostic,
		document: labelOf(diagnostic.document)
	})
	return {
		acceptedServers: input.acceptedServers,
		commandNames: [],
		generator: { version: input.version },
		inputs: Arr.map(input.inputs, (entry) => ({ ...entry, document: labelOf(entry.document) })),
		nonStandard: [],
		notices: Arr.map(
			Arr.filter(diagnostics, (diagnostic) => diagnostic.severity === "notice"),
			labelled
		),
		refusals: Arr.map(
			Arr.filter(diagnostics, (diagnostic) => diagnostic.severity === "refusal"),
			labelled
		),
		renames: input.renames,
		skipped: []
	}
}

/** The keys of the printed report's top-level object, in the order its text lists them: each line indented once. */
export const topLevelKeys = (text: string): ReadonlyArray<string> =>
	Arr.flatMap(Str.split("\n")(text), (line) =>
		Str.startsWith('  "')(line) ? Option.toArray(Arr.get(Str.split('"')(line), 1)) : []
	)

/** How a run ended: another run holds the lock, or output was written with diagnostics of these scopes. */
export type OutcomeSketch =
	| Readonly<{ kind: "lockHeld" }>
	| Readonly<{
			kind: "written"
			strict: boolean
			notice: boolean
			refused: ReadonlyArray<Diagnostic["scope"]>
	  }>

/** Every outcome: a held lock, and output written with or without --strict, a notice, and refusals at each scope. */
export const outcomeSpace: FiniteSpace<OutcomeSketch> = finite((source) =>
	source.draw(boolean)
		? { kind: "lockHeld" }
		: {
				kind: "written",
				strict: source.draw(boolean),
				notice: source.draw(boolean),
				refused: source.draw(subset(diagnosticScopes, { min: 0, max: diagnosticScopes.length }))
			}
)

export type OutcomeFeature =
	| "a held lock"
	| "a run with no refusal"
	| "a document refusal"
	| "a partly refused run"
	| "a partly refused run under --strict"

/** The outcome a sketch stands for, its diagnostics made as the generator makes them. */
export const outcomeOf = (sketch: OutcomeSketch): Effect.Effect<GeneratorOutcome> => {
	switch (sketch.kind) {
		case "lockHeld":
			return Effect.succeed({ _tag: "LockHeld" })
		case "written":
			return Effect.map(
				Effect.forEach(
					[
						...(sketch.notice
							? [{ severity: "notice", scope: "element", code: "PRM-19/ignored-header" } as const]
							: []),
						...Arr.map(sketch.refused, (scope) => ({
							severity: "refusal" as const,
							scope,
							code: "PRM-27/compound-nested"
						}))
					],
					diagnosticOf
				),
				(diagnostics) => ({ _tag: "Written", diagnostics, strict: sketch.strict })
			)
	}
}

/**
 * Design 8.1's exit status: 1 when another run holds the lock, on a document refusal, and on any refusal under
 * --strict; 0 when output was written otherwise, refusals of operations and elements among it.
 */
export const expectedStatus = (sketch: OutcomeSketch): 0 | 1 => {
	switch (sketch.kind) {
		case "lockHeld":
			return 1
		case "written":
			return Arr.contains(sketch.refused, "document") ||
				(sketch.strict && Arr.isReadonlyArrayNonEmpty(sketch.refused))
				? 1
				: 0
	}
}

export const outcomeFeature = (sketch: OutcomeSketch): OutcomeFeature => {
	switch (sketch.kind) {
		case "lockHeld":
			return "a held lock"
		case "written":
			if (Arr.contains(sketch.refused, "document")) {
				return "a document refusal"
			}
			if (Arr.isReadonlyArrayEmpty(sketch.refused)) {
				return "a run with no refusal"
			}
			return sketch.strict ? "a partly refused run under --strict" : "a partly refused run"
	}
}
