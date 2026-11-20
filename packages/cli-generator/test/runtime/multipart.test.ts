/**
 * The multipart writers write exactly the parts their reference gives, read back by a reader of their own: every
 * declared, chosen, nested and positional part of a form under its name, type, header lines and transfer encoding, a
 * positional multipart/mixed body under its position and item rules; they refuse a value with no bytes, a header line
 * no part can carry and a part past its rules, naming the flag where one exists, and die on a form no generated handler
 * builds.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import { Array as Arr, Cause, Effect, Option, Record as Rec, Stream, String as Str } from "effect"
import { Headers, type HttpClientRequest } from "effect/http"
import * as Serialize from "#runtime-src/runtime/serialize.ts"
import {
	type AssertFeature,
	assertFeatures,
	assertFields,
	assertModel,
	assertOptions,
	assertSpace,
	type FormDataFeature,
	formDataFeatures,
	formDataInput,
	formDataModel,
	formDataSpace,
	type MixedFeature,
	mixedFeatures,
	mixedModel,
	mixedSpace,
	readMultipart,
	type Verdict,
	type Written
} from "#test/runtime/multipart.fixtures.ts"
import { latin1 } from "#test/runtime/serialize.fixtures.ts"

/** What a writer did, read back: a written body that does not read as multipart is shown whole. */
type Read =
	| Written
	| Readonly<{ kind: "unreadable"; contentType: Option.Option<string>; body: string }>

const writerType = regex(
	"^multipart/(form-data|mixed); boundary=(----EffectFormBoundary[0-9a-f]{32})$",
	"u"
)

/** The boundary a writer's Content-Type gives: 16 CSPRNG bytes in hex after the writer's prefix, under `kind`. */
const boundaryOf = (contentType: Option.Option<string>, kind: string): Option.Option<string> =>
	Option.flatMap(contentType, (type) =>
		Option.flatMap(Option.fromNullishOr(writerType.exec(type)), ([, written, boundary]) =>
			written === kind ? Option.some(boundary) : Option.none()
		)
	)

/** A request's body, read back as a multipart body of `kind`; a refusal and a defect as the writer's. */
const readBack = (request: Serialize.Request, kind: string): Effect.Effect<Read> =>
	Effect.matchCauseEffect(request, {
		onFailure: (cause) =>
			Effect.succeed<Read>(
				Cause.hasDies(cause)
					? { kind: "defect" }
					: {
							kind: "refused",
							flag: Option.flatMap(Cause.findErrorOption(cause), (error) =>
								Option.fromUndefinedOr(error.flag)
							)
						}
			),
		onSuccess: (built: HttpClientRequest.HttpClientRequest) => {
			const contentType = Headers.get(built.headers, "content-type")
			if (built.body._tag === "Empty") {
				return Effect.succeed<Read>(
					Option.isNone(contentType)
						? { kind: "empty" }
						: { kind: "unreadable", contentType, body: "" }
				)
			}
			if (built.body._tag !== "Stream") {
				return Effect.succeed<Read>({ kind: "unreadable", contentType, body: built.body._tag })
			}
			return Effect.map(Stream.runCollect(Stream.orDie(built.body.stream)), (chunks): Read => {
				const body = Arr.join(Arr.map(Arr.fromIterable(chunks), latin1), "")
				return Option.match(
					Option.flatMap(boundaryOf(contentType, kind), (boundary) =>
						readMultipart(body, boundary, true)
					),
					{
						onNone: (): Read => ({ kind: "unreadable", contentType, body }),
						onSome: (sections): Read => ({ kind: "sections", sections })
					}
				)
			})
		}
	})

/**
 * A multipart/form-data body reads back as exactly its reference's parts, or is refused or dies as the reference says.
 * It replaces twenty-three example cases (serialize's formData, serialize-nested's writers, multipart-json-part's and
 * multipart-transfer-encoding's); its budget is 92 drawn forms, its floor 23, steered up to 92.
 */
export const formDataBody = property.explore(formDataSpace, {
	needs: {},
	situations: [
		"text part",
		"number part",
		"digit text part",
		"JSON part",
		"file part",
		"base64 part",
		"base64 across chunks",
		"chosen part with header lines",
		"nested by name, mixed",
		"nested by name, form-data",
		"nested by position",
		"name escaped",
		"file name escaped",
		"required body with no part",
		"optional body with no part",
		"part value refused",
		"header line refused",
		"file beyond the positions refused",
		"defect"
	] satisfies ReadonlyArray<Reached<FormDataFeature>>,
	check: (_, c: Case<FormDataFeature>) => (form) =>
		Effect.gen(function* () {
			c.noteAll(formDataFeatures(form))
			const { fields, parts } = formDataInput(form)
			const read = yield* readBack(
				Serialize.request("POST", {
					body: Serialize.formData(fields, { parts, required: form.required }),
					headers: [],
					path: Serialize.path("/uploads", []),
					query: []
				}),
				"form-data"
			)
			assert.deepEqual(read, formDataModel(form))
		}),
	oracle: {
		kind: "second-implementation",
		name: "a multipart reader of RFC 2046's delimiters over the design 6.3 parts a reference writes"
	},
	kept: [],
	budget: { runs: 92, steered: 92 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: 'Predicate.isObject(value) && "stream" in value',
			replacement: "false",
			why: "No part value reads as a file, so a file part is written as text and loses its file name; the property fails (CATCH's evidence, mutant f924c6f61c)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: 'Predicate.isObject(value) && "json" in value',
			replacement: "false",
			why: "No part value reads as JSON, so a JSON part is written as its object's text instead of its compact JSON; the property fails (CATCH's evidence, mutant d8604d98b0)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: "Predicate.isNumber(value) && !Number.isFinite(value)",
			replacement: "!Number.isFinite(value)",
			why: "A digit text, whose text is not a number at all, is refused as a number with no text form; the property fails (CATCH's evidence, mutant 38e329357f)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: "\t\tif (Arr.some(Rec.keys(fields), (name) => !declared.has(name))) {",
			replacement: "\t\tif (Arr.some(Rec.keys(fields), (name) => declared.has(name))) {",
			why: "A form whose every field has its declared part dies, and one with an undeclared field is written; the property fails (CATCH's evidence, mutant 7c4de027d5)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: "\t\t\tif (part === undefined || part.values.length === 0) {",
			replacement: "\t\t\tif (part === undefined || part.values.length !== 0) {",
			why: "A part with values is skipped and one with none writes nothing yet is taken as sent; the property fails (CATCH's evidence, mutant 853ffbdba5)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/multipart.ts",
			original:
				'\tpart.contentEncoding === "base64" ? base64Stream(bodyStream(part.body)) : bodyStream(part.body)',
			replacement:
				'\tpart.contentEncoding !== "base64" ? base64Stream(bodyStream(part.body)) : bodyStream(part.body)',
			why: "A base64 part's bytes are written raw and every other part's base64-encoded; the property fails (CATCH's evidence, mutant cabc8ae591)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/multipart.ts",
			original:
				"Stream.succeed(partHead(boundary, kind, part, null)).pipe(\n\t\t\t\tStream.concat(leafBody(part)),\n\t\t\t\tStream.concat(Stream.succeed(encoder.encode(crlf)))\n\t\t\t)",
			replacement:
				"Stream.succeed(partHead(boundary, kind, part, null)).pipe(Stream.concat(leafBody(part)))",
			why: "A leaf part's bytes run into the next delimiter with no CRLF before it; the property fails (CATCH's evidence, mutant a75f3a3a01)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: "if (values.length > ruled) {",
			replacement: "if (false) {",
			why: "A file beyond a positional part's rules is written under no type instead of being refused naming its flag; the property fails (CATCH's evidence, mutant fac18650f9)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original:
				"\tArr.some(Rec.values(fields), Arr.isReadonlyArrayNonEmpty) ? [{ nested: fields }] : []",
			replacement:
				"\tArr.every(Rec.values(fields), Arr.isReadonlyArrayNonEmpty) ? [{ nested: fields }] : []",
			why: "A part nested by name is sent only when every member has a value, so one with some members empty is dropped; the property fails (CATCH's evidence, mutant 624bb20cdb)."
		}
	]
})

/**
 * A positional multipart/mixed body reads back as its reference's parts, or is refused naming `--part`. It replaces
 * six example cases (serialize-mixed); its budget is 24 drawn bodies, its floor 6, steered up to 24.
 */
export const mixedBody = property.explore(mixedSpace, {
	needs: {},
	situations: [
		"position rules",
		"item rule",
		"unused positions",
		"base64 part",
		"required with no part",
		"optional with no part",
		"past the rules refused",
		"past maxParts refused",
		"under minParts refused"
	] satisfies ReadonlyArray<Reached<MixedFeature>>,
	check: (_, c: Case<MixedFeature>) => (mixed) =>
		Effect.gen(function* () {
			c.noteAll(mixedFeatures(mixed))
			const read = yield* readBack(
				Serialize.request("POST", {
					body: Serialize.mixed(
						Arr.map(mixed.bodies, (body) =>
							body.streamed
								? Stream.fromIterable(body.chunks)
								: Uint8Array.from(Arr.flatMap(body.chunks, (chunk) => Arr.fromIterable(chunk)))
						),
						{
							prefixEncoding: mixed.prefix,
							required: mixed.required,
							...Option.match(mixed.item, {
								onNone: () => ({}),
								onSome: (itemEncoding) => ({ itemEncoding })
							}),
							...Option.match(mixed.maxParts, {
								onNone: () => ({}),
								onSome: (maxParts) => ({ maxParts })
							}),
							...Option.match(mixed.minParts, {
								onNone: () => ({}),
								onSome: (minParts) => ({ minParts })
							})
						}
					),
					headers: [],
					path: Serialize.path("/uploads", []),
					query: []
				}),
				"mixed"
			)
			assert.deepEqual<Read>(read, mixedModel(mixed))
		}),
	oracle: {
		kind: "second-implementation",
		name: "a multipart reader of RFC 2046's delimiters over design 6.3's positional rules"
	},
	kept: [],
	budget: { runs: 24, steered: 24 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: "bodies.length === 0 && !options.required",
			replacement: "bodies.length === 0",
			why: "A required positional body with no part sends no body at all instead of the close delimiter; the property fails (CATCH's evidence, mutant 96a5382c53)."
		}
	]
})

/**
 * A form's part values pass their body schema's assertion unchanged, or a UsageError names the first failing part's
 * flag in declared order, a file asserted for presence only; and its keyed parts leave its fields with their types and
 * headers, one with no value left out. It replaces twenty example cases (serialize's assertFormData and chooseParts,
 * serialize-nested's and multipart-json-part's assertions); its budget is 80 drawn forms, its floor 20, steered up to 80.
 */
export const formAssertion = property.explore(assertSpace, {
	needs: {},
	situations: [
		"valid form passed",
		"file part passed for presence only",
		"digit text asserted as its number",
		"JSON part asserted as parsed",
		"repeated part asserted whole",
		"optional body given nothing passed",
		"required part missing refused",
		"value not matching refused",
		"nested member refused by its flag",
		"nested part passed",
		"keyed part moved",
		"keyed part with no value left out"
	] satisfies ReadonlyArray<Reached<AssertFeature>>,
	check: (_, c: Case<AssertFeature>) => (form) =>
		Effect.gen(function* () {
			c.noteAll(assertFeatures(form))
			const fields = assertFields(form)
			const verdict = yield* Effect.match(Serialize.assertFormData(assertOptions(form))(fields), {
				onFailure: (error): Verdict => ({
					kind: "refused",
					flag: error.flag ?? "",
					message: error.message
				}),
				onSuccess: (passed): Verdict => {
					assert.ok(passed === fields, "the fields pass through unchanged")
					return { kind: "passed" }
				}
			})
			assert.deepEqual(verdict, assertModel(form))
			assert.equal(
				verdict.kind === "refused" && Str.includes("SECRET")(verdict.message),
				false,
				"a refusal repeats a value"
			)
			const keyed = Arr.map(
				form.choices,
				(choice) =>
					[
						choice,
						Arr.map(choice.headers, (header) => Serialize.header(header.name, header.value, header))
					] as const
			)
			const chosen = yield* Serialize.chooseParts(
				Rec.fromEntries(
					Arr.map(
						keyed,
						([choice, carried]) =>
							[choice.key, [choice.part, choice.contentType, carried] as const] as const
					)
				)
			)(fields)
			const moved = new Set(Arr.map(form.choices, (choice) => choice.part))
			const wanted = {
				...Rec.fromEntries(
					Arr.map(keyed, ([choice, carried]) => {
						const values = Option.getOrElse(
							Rec.get(fields, choice.part),
							(): ReadonlyArray<Serialize.FormValue> => []
						)
						return [
							choice.key,
							values.length === 0
								? undefined
								: carried.length === 0
									? { contentType: choice.contentType, values }
									: { contentType: choice.contentType, headers: carried, values }
						] as const
					})
				),
				fields: Rec.filter(fields, (_, name) => !moved.has(name))
			}
			assert.deepEqual<typeof wanted>(chosen, wanted)
		}),
	oracle: {
		kind: "specification",
		name: "design 4.5's form assertion over a checker of each part kind's schema, and ENC-10's split of keyed parts"
	},
	kept: [],
	budget: { runs: 80, steered: 80 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original:
				"entries.push([name, repeated.has(name) ? Arr.map(leaves, assertedValue) : assertedValue(first)])",
			replacement: "{}",
			why: "No part's value reaches the asserted object, so every required part given a value is refused as missing; the property fails (CATCH's evidence, mutant c4fccda7a7)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original:
				"[\n\t\t\t...Arr.map(Rec.toEntries(options.nested?.[name]?.flags ?? {}), ([member, memberFlag]) => ({\n\t\t\t\tflag: memberFlag,\n\t\t\t\tslot: partPath([name, member])\n\t\t\t})),\n\t\t\t{ flag, slot: partPath([name]) }\n\t\t]",
			replacement: "[{ flag, slot: partPath([name]) }]",
			why: "A nested part's members are never named, so a failing member is reported under no flag; the property fails (CATCH's evidence, mutant 01c59b272d)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: "\t\t\tif (seen.sent.size === 0 && !options.required) {",
			replacement: "\t\t\tif (seen.sent.size === 0 && options.required) {",
			why: "A required body given nothing passes unasserted and an optional one is asserted; the property fails (CATCH's evidence, mutant 7b97e2e03b)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: "slot === undefined || !seen.files.has(slot)",
			replacement: "slot === undefined",
			why: "A file part's stand-in fails its schema, so a file asserted for presence only is refused; the property fails (CATCH's evidence, mutant 6d183c2a05)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: "\t\t\tif (failing.size === 0) {",
			replacement: "\t\t\tif (failing.size === (-1)) {",
			why: "A form whose only failures are under file parts is refused with no flag instead of passing; the property fails (CATCH's evidence, mutant 07df1a6298)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: "if (values.length === 0) {\n\t\t\t\treturn undefined\n\t\t\t}",
			replacement: "{}",
			why: "A keyed part with no value is carried with an empty value list instead of left out; the property fails (CATCH's evidence, mutant 2ec1a8e856)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: "!named.has(name)",
			replacement: "true",
			why: "A keyed part's values stay among the fields as well as moving with their type; the property fails (CATCH's evidence, mutant ccaa6824f3)."
		}
	]
})
