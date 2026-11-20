/**
 * Document validation (design 3.2): a document is validated against the dated official schema of the line its
 * `openapi` member names, through a copy, never touching the network; a document whose `openapi` member names no
 * supported line is refused as DOC-02 (design 8.1), citing its own line's release where its text begins with one; and
 * the vendored schemas the validator registers are read only when every file's sha256 matches the manifest.
 */

import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect, Result } from "effect"
import { Digest } from "effect/crypto"
import { digestService } from "#test/support/digest.ts"
import {
	allVendoredBytes,
	datedSchemaOf,
	declaredDocument,
	declaredSpace,
	instanceLocationOf,
	isAtOrAbove,
	type LineFeature,
	lineDocument,
	lineFeaturesOf,
	lineSpace,
	offlineSpace,
	type ManifestFeature,
	manifestSpace,
	plantedPointers,
	readerOf,
	specUri,
	validateOffline,
	unreadableFailure,
	verdictOf,
	type VersionFeature,
	versionFeaturesOf
} from "#test/validate/validate.fixtures.ts"
import { versionRefusal } from "#validate/dispatch.ts"
import { checkManifest, validateDocument } from "#validate/index.ts"

/**
 * Each line's documents, deep-frozen, get the verdict of the line's dated schema: a
 * document with no planted fault is valid with no error, and one with faults is invalid with an error at each fault
 * and none away from them.
 */
export const lineVerdicts = property.exhaust(lineSpace, {
	box: "every line, with each parameter location a line lists and two it does not, and each simple schema type and two words no dialect lists",
	needs: { digest: digestService },
	situations: [
		"line 3.0",
		"line 3.1",
		"line 3.2",
		"a valid document",
		"a parameter location no line lists",
		"a schema type no dialect lists",
		"both faults planted"
	] satisfies ReadonlyArray<Reached<LineFeature>>,
	check:
		({ digest }, c: Case<LineFeature>) =>
		(drawn) =>
			Effect.gen(function* () {
				c.noteAll(lineFeaturesOf(drawn))
				const service = yield* digest
				const result = yield* Effect.provideService(
					validateDocument(lineDocument(drawn)),
					Digest.Digest,
					service
				)
				const planted = Arr.map(plantedPointers(drawn), instanceLocationOf)
				const locations = Arr.map(result.errors, (unit) => unit.instanceLocation)
				assert.equal(result.line, drawn.line)
				assert.equal(result.schema, datedSchemaOf(drawn.line))
				assert.equal(result.valid, Arr.isReadonlyArrayEmpty(planted))
				assert.deepEqual(
					Arr.filter(planted, (pointer) => !Arr.contains(locations, pointer)),
					[],
					"a planted fault has no error"
				)
				assert.deepEqual(
					Arr.filter(
						locations,
						(location) => !Arr.some(planted, (pointer) => isAtOrAbove(location, pointer))
					),
					[],
					"an error lies away from every planted fault"
				)
			}),
	oracle: {
		kind: "specification",
		name: "OpenAPI 3.x's parameter locations and JSON Schema's simple types, each line's dated official schema by design 3.2, and the validator's instance locations as the planted faults' pointers"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/validate/dispatch.ts",
			original: '"3.1": "https://spec.openapis.org/oas/3.1/schema-base/2026-08-03"',
			replacement: '"3.1": "https://spec.openapis.org/oas/3.1/schema/2026-08-03"',
			why: "The 3.1 line validates against the plain schema, which validates no Schema Object, so a schema type no dialect lists passes; the property fails."
		},
		{
			file: "packages/cli-generator/src/validate/index.ts",
			original: "valid: output.valid",
			replacement: "valid: true",
			why: "Every document is reported valid; the property fails."
		},
		{
			file: "packages/cli-generator/src/validate/index.ts",
			original: "\t\t\t\t\t\tinstanceLocation,\n",
			replacement: "\t\t\t\t\t\tinstanceLocation: absoluteKeywordLocation,\n",
			why: "An error is reported at the schema keyword that failed, not at the document node it failed on; the property fails."
		}
	]
})

/**
 * The generator's `validate` command, run where no socket can open, validates each line's valid document with nothing
 * to report: validation reads the vendored schemas alone and reaches for no network.
 */
export const offlineValidation = property.exhaust(offlineSpace, {
	box: "every line's valid document, through the generator's command line under Node's permission model with file reads alone allowed",
	needs: { checkout: Checkout.dir, dir: Scratch.dir },
	situations: ["line 3.0", "line 3.1", "line 3.2"] satisfies ReadonlyArray<Reached<LineFeature>>,
	check:
		({ checkout, dir }, c: Case<LineFeature>) =>
		(drawn) =>
			Effect.gen(function* () {
				c.note(`line ${drawn.line}`)
				const root = yield* checkout
				const scratch = yield* dir
				const run = yield* validateOffline(root, scratch, lineDocument(drawn))
				assert.deepEqual(run, { exitCode: 0, stderr: "", stdout: "" })
			}),
	oracle: {
		kind: "specification",
		name: "design 3.2: validation against the vendored schemas alone, under Node's permission model, which refuses every network access"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/validate/index.ts",
			original: "\tyield* registered\n",
			replacement: "",
			why: "Validation compiles a line's schema before the vendored schemas are registered, so the validator fetches it from the network; the property fails."
		}
	]
})

/**
 * A document's `openapi` member selects its line, or the document is refused as DOC-02 with the value it declared, the
 * message for it and the release it cites. It replaces six example cases; its budget is the runner's.
 */
export const versionGate = property.explore(declaredSpace, {
	needs: { digest: digestService },
	situations: [
		"absent",
		"not a string",
		"a supported version",
		"a known line refused",
		"an unknown line"
	] satisfies ReadonlyArray<Reached<VersionFeature>>,
	check:
		({ digest }, c: Case<VersionFeature>) =>
		(declared) =>
			Effect.gen(function* () {
				c.noteAll(versionFeaturesOf(declared))
				const service = yield* digest
				const expected = verdictOf(declared)
				const validated = yield* Effect.result(
					Effect.provideService(
						validateDocument(declaredDocument(declared)),
						Digest.Digest,
						service
					)
				)
				if (expected.kind === "selected") {
					assert.ok(Result.isSuccess(validated), "a supported version is refused")
					assert.equal(validated.success.line, expected.line)
					return
				}
				assert.ok(
					Result.isFailure(validated) && validated.failure._tag === "UnsupportedOpenApiVersion",
					"an unsupported version is not refused as one"
				)
				assert.deepEqual(validated.failure.openapi, expected.declared)
				const refusal = yield* versionRefusal(validated.failure, specUri)
				assert.deepEqual(
					{
						code: refusal.code,
						document: refusal.document,
						element: refusal.element,
						message: refusal.message,
						openapi: refusal.openapi,
						pointer: String(refusal.pointer),
						row: refusal.row,
						scope: refusal.scope,
						severity: refusal.severity,
						specSection: String(refusal.specSection)
					},
					{
						code: expected.code,
						document: specUri,
						element: "openapi",
						message: expected.message,
						openapi: expected.openapi,
						pointer: "/openapi",
						row: "DOC-02",
						scope: "document",
						severity: "refusal",
						specSection: expected.specSection
					}
				)
			}),
	oracle: {
		kind: "specification",
		name: "design 3.2's version grammar (3, a minor of 0, 1 or 2, a patch of digits) and 8.1's DOC-02 refusal, judged from the parts each version is written from"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/validate/dispatch.ts",
			original: '"^(?<line>3\\\\.[012])\\\\.[0-9]+$"',
			replacement: '"^(?<line>3\\\\.[012])\\\\.[0-9]+"',
			why: "A supported version followed by a suffix (3.1.0-rc1, 3.1.0 and a newline) selects its line; the property fails."
		},
		{
			file: "packages/cli-generator/src/validate/dispatch.ts",
			original: '"^(?<line>3\\\\.[012])(?![0-9])"',
			replacement: '"^(?<line>3\\\\.[012])"',
			why: "A minor of two digits that begins with 0, 1 or 2 (3.10.0) cites that one-digit line's release instead of the latest; the property fails."
		},
		{
			file: "packages/cli-generator/src/validate/dispatch.ts",
			original: 'Option.isNone(declared) ? "DOC-02/missing-version" : "DOC-02/unsupported-version"',
			replacement:
				'Option.isNone(declared) ? "DOC-02/unsupported-version" : "DOC-02/missing-version"',
			why: "A missing version is reported as unsupported and a declared one as missing; the property fails."
		},
		{
			file: "packages/cli-generator/src/validate/dispatch.ts",
			original: "openapi: Option.getOrElse(declared, () => patchVersion[line])",
			replacement: "openapi: patchVersion[line]",
			why: "A refusal states the release it cites as the document's version, not the value the document declared; the property fails."
		},
		{
			file: "packages/cli-generator/src/validate/dispatch.ts",
			original: "new UnsupportedOpenApiVersion({ openapi })",
			replacement: "new UnsupportedOpenApiVersion({ openapi: Option.none() })",
			why: "A refused version loses the value it declared, so the document is reported as declaring none; the property fails."
		}
	]
})

/**
 * The manifest check hands back every vendored schema's bytes, in the manifest's order, when each file's sha256
 * matches, and refuses at the one file altered by a byte (a mismatch) or unreadable (keeping the read's failure as its
 * cause).
 */
export const manifestReads = property.exhaust(manifestSpace, {
	box: "every vendored schema read intact, and each one of them altered by a byte or unreadable",
	needs: { digest: digestService },
	situations: ["intact", "altered", "unreadable"] satisfies ReadonlyArray<Reached<ManifestFeature>>,
	check:
		({ digest }, c: Case<ManifestFeature>) =>
		(drawn) =>
			Effect.gen(function* () {
				c.note(drawn.kind)
				const service = yield* digest
				const checked = yield* Effect.result(
					Effect.provideService(checkManifest(readerOf(drawn)), Digest.Digest, service)
				)
				if (drawn.kind === "intact") {
					const files = yield* allVendoredBytes
					assert.ok(Result.isSuccess(checked), "an intact manifest is refused")
					assert.deepEqual(checked.success, files)
					return
				}
				assert.ok(Result.isFailure(checked), "a changed manifest is accepted")
				assert.equal(checked.failure.file, drawn.file)
				if (drawn.kind === "altered") {
					assert.equal(checked.failure.reason, "sha256-mismatch")
					assert.equal(checked.failure.cause, undefined)
					return
				}
				assert.equal(checked.failure.reason, "unreadable")
				assert.equal(checked.failure.cause, unreadableFailure)
			}),
	oracle: {
		kind: "specification",
		name: "the manifest's sha256 of each vendored file, against the files' bytes as they stand, altered by a byte, or unread"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/validate/index.ts",
			original: "hex === entry.sha256",
			replacement: "true",
			why: "A vendored schema altered on disk is registered as the official one; the property fails."
		},
		{
			file: "packages/cli-generator/src/validate/index.ts",
			original: 'new SchemaManifestError({ cause, file: entry.file, reason: "unreadable" })',
			replacement: 'new SchemaManifestError({ file: entry.file, reason: "unreadable" })',
			why: "An unreadable vendored file's refusal drops the read's failure, so the operator is not told why; the property fails."
		},
		{
			file: "packages/cli-generator/src/validate/index.ts",
			original: "Effect.forEach(manifest, (entry) =>",
			replacement: "Effect.forEach(Arr.reverse(manifest), (entry) =>",
			why: "The verified bytes come back out of the manifest's order, so schemas register before the ones they depend on; the property fails."
		}
	]
})
