/**
 * The runtime's parameter serializers write exactly what their reference writes from the specification, and refuse
 * exactly what it refuses: path styles and templates (RFC 6570 simple, label and matrix, OAS path templating),
 * query styles (form, spaceDelimited, pipeDelimited, deepObject with its bracket convention and scalar switch),
 * header and cookie parameters (RFC 9110, RFC 6265, OAS 3.2 and Appendix D), and no refusal repeats a value.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Record as Rec, Result, Stream, String as Str } from "effect"
import { Headers, HttpBody, type HttpClientRequest } from "effect/http"
import * as Serialize from "#runtime-src/runtime/serialize.ts"
import {
	type AlternativeCase,
	type AlternativeFeature,
	alternativeFeatures,
	alternativeSpace,
	type BodyFeature,
	bodyBytes,
	bodyFeatures,
	bodyModel,
	bodySpace,
	type ContentFeature,
	contentFeatures,
	contentModel,
	contentSpace,
	type RequestFeature,
	requestFeatures,
	requestModel,
	requestSpace,
	type CookieFeature,
	cookieFeatures,
	cookieModel,
	cookieSpace,
	type Expanded,
	expanded,
	type HeaderFeature,
	headerFeatures,
	headerModel,
	headerSpace,
	outcomeOf,
	type PathFeature,
	pathFeatures,
	pathModel,
	pathParameterModel,
	pathSpace,
	type QueryFeature,
	queryFeatures,
	queryModel,
	querySpace,
	SECRET,
	templateOf
} from "#test/runtime/serialize.fixtures.ts"

/** A request with nothing but its body, as a body's codec is judged. */
const posted = (body: Serialize.RequestBody): Serialize.Request =>
	Serialize.request("POST", { body, headers: [], path: Serialize.path("/", []), query: [] })

/** A request's outcome: refused, or its body's bytes and Content-Type, a multipart boundary read as `<boundary>`. */
const sentOf = (request: Serialize.Request) =>
	Effect.matchEffect(request, {
		onFailure: () =>
			Effect.succeed(Option.none<readonly [Option.Option<string>, Option.Option<string>]>()),
		onSuccess: (built: HttpClientRequest.HttpClientRequest) =>
			Effect.map(bodyBytes(built.body), (bytes) => {
				const contentType = Headers.get(built.headers, "content-type")
				const boundary = Option.flatMap(contentType, (type) =>
					Arr.get(Str.split("boundary=")(type), 1)
				)
				const blank = (piece: string) =>
					Option.match(boundary, {
						onNone: () => piece,
						onSome: (marker) => Str.replaceAll(marker, "<boundary>")(piece)
					})
				return Option.some([Option.map(bytes, blank), Option.map(contentType, blank)] as const)
			})
	})

/** A refusal's message never repeats the secret a drawn value holds. */
const keepsSecret = (actual: Expanded): void =>
	assert.equal(
		Option.exists(actual.message, Str.includes(SECRET)),
		false,
		"a refusal repeats a value"
	)

const pathStyles = {
	simple: Serialize.simple,
	label: Serialize.label,
	matrix: Serialize.matrix
} as const

/**
 * Each path parameter expands, alone and in its template, to its reference's text, or is refused as the reference
 * refuses it. It replaces sixty-three example cases (type to text, simple, label, matrix, path and the path refusals);
 * its budget is 252 drawn paths, its floor 63, steered up to 252 while a situation is unreached.
 */
export const pathExpansion = property.explore(pathSpace, {
	needs: {},
	situations: [
		"simple",
		"label",
		"matrix",
		"list exploded",
		"object exploded",
		"list joined",
		"object joined",
		"reserved character passed",
		"percent triplet passed",
		"non-ASCII text encoded",
		"empty text",
		"delimiter refused",
		"lone surrogate refused",
		"nested value refused",
		"absent value refused",
		"non-finite number refused",
		"digit text kept",
		"empty expansion refused",
		"dot segment refused",
		"placeholder with no parameter",
		"parameter with no placeholder",
		"two parameters with one name",
		"path expanded"
	] satisfies ReadonlyArray<Reached<PathFeature>>,
	check: (_, c: Case<PathFeature>) => (path) =>
		Effect.gen(function* () {
			const template = templateOf(path)
			c.noteAll(pathFeatures(path, template))
			const parameters = Arr.map(path.parameters, (parameter) =>
				pathStyles[parameter.style](parameter.name, parameter.value, parameter)
			)
			for (const [parameter, built] of Arr.zip(path.parameters, parameters)) {
				const alone = yield* expanded(built.expand)
				assert.deepEqual(
					alone.outcome,
					outcomeOf(Result.map(pathParameterModel(parameter), Option.some))
				)
				keepsSecret(alone)
			}
			const whole = yield* expanded(Serialize.path(template, parameters).expand)
			assert.deepEqual(
				whole.outcome,
				outcomeOf(Result.map(pathModel(template, path.parameters), Option.some))
			)
			keepsSecret(whole)
		}),
	oracle: {
		kind: "specification",
		name: "RFC 6570's simple, label and matrix operators over RFC 3986 percent-encoding, with the design's refusals"
	},
	kept: [],
	budget: { runs: 252, steered: 252 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: "\tconst clash = Arr.some(parts(text), (part) =>",
			replacement: "\tconst clash = Arr.every(parts(text), (part) =>",
			why: "A path value is refused only when every piece holds a delimiter its style writes raw, so one ambiguous item or member is sent; the property fails (CATCH's evidence, mutant 03d6cadd53)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: '\treturn decoded === "." || decoded === ".."',
			replacement: '\treturn decoded === "." || decoded !== ".."',
			why: "Every segment but a lone dot reads as a dot segment, so a path with an ordinary segment is refused; the property fails (CATCH's evidence, mutant 6d75138800)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original:
				'if (explode && text.kind === "array") {\n\t\treturn Arr.join(\n\t\t\tArr.map(text.items, (item) => assignment(name, item)),\n\t\t\t""\n\t\t)\n\t}',
			replacement: "{}",
			why: "An exploded matrix list is written as one joined assignment instead of one per item; the property fails (CATCH's evidence, mutant 100eb0d7f9)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: '\t\t\tif (style === "matrix" && loneSurrogate.test(name)) {',
			replacement: '\t\t\tif (style !== "matrix" && loneSurrogate.test(name)) {',
			why: "A matrix name with a lone surrogate is sent while a simple or label one is refused; the property fails (CATCH's evidence, mutant 15e19f5cda)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: "percentTriplet.test(token) || Str.includes(token)(passed)",
			replacement: "percentTriplet.test(token)",
			why: "allowReserved passes percent triplets only, so the reserved characters a path keeps raw are encoded; the property fails (CATCH's evidence, mutant 23e975b1bb)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: "\t\t\tif (index % 2 === 0) {",
			replacement: "\t\t\tif (index % 2 === (-1)) {",
			why: "A path's literal pieces and its placeholders trade places, so every template expands to its parameters' names; the property fails (CATCH's evidence, mutant d151f80c60, from EOCG-CONV's output units)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original:
				'{\n\tconst decoded = Str.replaceAll(encodedDot, ".")(segment)\n\n\treturn decoded === "." || decoded === ".."\n}',
			replacement: "{ return true }",
			why: "Every segment reads as a dot segment, so every path is refused; the property fails (CATCH's evidence, mutant e5388547ef, from EOCG-CONV's output units)."
		}
	]
})

const queryStyles = {
	form: Serialize.form,
	spaceDelimited: Serialize.spaceDelimited,
	pipeDelimited: Serialize.pipeDelimited,
	deepObject: Serialize.deepObject
} as const

/**
 * A query parameter expands to its reference's pairs, sends nothing, or is refused as the reference says. It replaces
 * seventy example cases (form, allowReserved, the delimited styles, deepObject with brackets and scalars, its bracketed
 * member names, allowEmptyValue); its budget is 280 drawn parameters, its floor 70, steered up to 280.
 */
export const queryExpansion = property.explore(querySpace, {
	needs: {},
	situations: [
		"form",
		"spaceDelimited",
		"pipeDelimited",
		"deepObject",
		"list exploded",
		"object exploded",
		"list joined",
		"object joined",
		"bracket convention",
		"scalar under deepObject",
		"reserved character passed",
		"percent triplet passed",
		"empty value sent",
		"nothing sent",
		"required value refused",
		"delimiter refused",
		"bracket in a member name refused",
		"nested value refused",
		"lone surrogate refused",
		"name encoded"
	] satisfies ReadonlyArray<Reached<QueryFeature>>,
	check: (_, c: Case<QueryFeature>) => (parameter) =>
		Effect.gen(function* () {
			c.noteAll(queryFeatures(parameter))
			const actual = yield* expanded(
				queryStyles[parameter.style](parameter.name, parameter.value, parameter).expand
			)
			assert.deepEqual(actual.outcome, outcomeOf(queryModel(parameter)))
			keepsSecret(actual)
		}),
	oracle: {
		kind: "specification",
		name: "OAS query styles as RFC 6570 form expansion over RFC 3986 percent-encoding, with the design's refusals"
	},
	kept: [],
	budget: { runs: 280, steered: 280 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: 'style === "deepObject" && !deepObjectTakes(text, options.scalars === true)',
			replacement: "!deepObjectTakes(text, options.scalars === true)",
			why: "Every style, not only deepObject, refuses a value that is not an object; the property fails (CATCH's evidence, mutant a1dfc19cc0)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: 'if (explode && text.kind === "array") {\n\t\treturn Arr.map(text.items',
			replacement: "if (explode) {\n\t\treturn Arr.map(text.items",
			why: "An exploded object is written as one pair per member text under the parameter's name; the property fails (CATCH's evidence, mutant f0718a2894)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: '\tstyle === "deepObject" && brackets && !(scalars && isScalar(value))',
			replacement: '\tstyle !== "deepObject" && brackets && !(scalars && isScalar(value))',
			why: "The bracket convention applies to every style but deepObject, so a deepObject value with brackets on is refused as nested; the property fails (CATCH's evidence, mutant 8051b9b8f0)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: "\t\t\t: Arr.filter(Rec.toEntries(value), ([, member]) => member !== undefined)",
			replacement: "\t\t\t: Arr.filter(Rec.toEntries(value), ([, member]) => false)",
			why: "The bracket convention drops every object member, so a bracketed object sends nothing; the property fails (CATCH's evidence, mutant ffa07913bd)."
		}
	]
})

/**
 * A header parameter's value is its reference's unencoded simple expansion, nothing, or a refusal. It replaces twenty
 * example cases (header, the header repairs); its budget is 80 drawn headers, its floor 20, steered up to 80.
 */
export const headerExpansion = property.explore(headerSpace, {
	needs: {},
	situations: [
		"scalar sent unencoded",
		"list sent",
		"object sent",
		"object exploded",
		"empty text sent",
		"latin-1 text sent",
		"nothing sent",
		"required value refused",
		"unsafe text refused",
		"comma refused",
		"name not a token refused",
		"nested value refused"
	] satisfies ReadonlyArray<Reached<HeaderFeature>>,
	check: (_, c: Case<HeaderFeature>) => (parameter) =>
		Effect.gen(function* () {
			c.noteAll(headerFeatures(parameter))
			const actual = yield* expanded(
				Serialize.header(parameter.name, parameter.value, parameter).expand
			)
			assert.deepEqual(actual.outcome, outcomeOf(headerModel(parameter)))
			keepsSecret(actual)
		}),
	oracle: {
		kind: "specification",
		name: "RFC 6570 simple expansion with no percent-encoding, refused where RFC 9110 field values cannot carry it"
	},
	kept: [],
	budget: { runs: 80, steered: 80 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original:
				"\n\t\tif (text === undefined) {\n\t\t\treturn text\n\t\t}\n\n\t\tif (Arr.some(headerTexts(text), unsafeHeaderText)) {",
			replacement: "\n\t\t{}\n\n\t\tif (Arr.some(headerTexts(text), unsafeHeaderText)) {",
			why: "A header with no value runs on into the text checks and fails instead of sending nothing; the property fails (CATCH's evidence, mutant 21a3a45aa0)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original:
				'headerLineBreak.test(text) || Str.includes("\\u0000")(text) || wideCodePoint.test(text)',
			replacement: 'Str.includes("\\u0000")(text) || wideCodePoint.test(text)',
			why: "A CR or LF in a header value is no longer refused, so a value no header line can carry is sent; the property fails (CATCH's evidence, mutant 3834dba2a3)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original:
				'\texpand: Effect.gen(function* headerExpansion() {\n\t\tif (!headerToken.test(name)) {\n\t\t\treturn yield* refuse("a header parameter has a name that is not an RFC 9110 token")',
			replacement:
				'\texpand: Effect.gen(function* headerExpansion() {\n\t\tif (headerToken.test(name)) {\n\t\t\treturn yield* refuse("a header parameter has a name that is not an RFC 9110 token")',
			why: "A header name that is a token is refused and one that is none is sent; the property fails (CATCH's evidence, mutant 475cf51163)."
		}
	]
})

/**
 * A cookie parameter's pair is its reference's, nothing, or a refusal, on every OpenAPI line and both styles. It
 * replaces twenty-eight example cases (serialize-cookie's five tables); its budget is 112 drawn cookies, its floor 28,
 * steered up to 112.
 */
export const cookieExpansion = property.explore(cookieSpace, {
	needs: {},
	situations: [
		"form scalar encoded",
		"form reserved character passed on 3.2",
		"form reserved character encoded before 3.2",
		"cookie style text sent",
		"cookie style list exploded",
		"cookie style object exploded",
		"nothing sent",
		"required value refused",
		"form list or object refused",
		"cookie style text refused",
		"explode false refused on 3.2",
		"cookie style before 3.2 refused",
		"name not a token refused"
	] satisfies ReadonlyArray<Reached<CookieFeature>>,
	check: (_, c: Case<CookieFeature>) => (parameter) =>
		Effect.gen(function* () {
			c.noteAll(cookieFeatures(parameter))
			const actual = yield* expanded(
				Serialize.cookie(parameter.name, parameter.value, parameter).expand
			)
			assert.deepEqual(actual.outcome, outcomeOf(cookieModel(parameter)))
			keepsSecret(actual)
		}),
	oracle: {
		kind: "specification",
		name: "OAS 3.2 cookie and form styles, RFC 6265 cookie-octet, OAS Appendix D's form-cookie rule"
	},
	kept: [],
	budget: { runs: 112, steered: 112 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: '\t\tif (options.style === "cookie" && options.line !== "3.2") {',
			replacement: '\t\tif (options.style !== "cookie" && options.line !== "3.2") {',
			why: "Style form, not style cookie, is refused before 3.2, so a 3.0 or 3.1 form cookie is refused; the property fails (CATCH's evidence, mutant 2b76713925)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original:
				'\n\t\tif (text === undefined) {\n\t\t\treturn text\n\t\t}\n\n\t\tif (options.style === "cookie") {',
			replacement: '\n\t\t{}\n\n\t\tif (options.style === "cookie") {',
			why: "A cookie with no value runs on into the text checks and fails instead of sending nothing; the property fails (CATCH's evidence, mutant 312665f5bd)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: 'if (options.line === "3.2" && !options.explode) {',
			replacement: "if (false) {",
			why: "explode false is sent on 3.2, which forbids it for a cookie; the property fails (CATCH's evidence, mutant f72c681e8c)."
		}
	]
})

/**
 * A content-based parameter in the query, a header, a cookie or the whole query string writes its codec's text as its
 * location writes it, sends nothing when absent and optional, or is refused as the reference says. It replaces
 * twenty-two example cases (serialize-content-parameter, and querystring under non-form media); its budget is 88
 * drawn parameters, its floor 22, steered up to 88.
 */
export const contentParameters = property.explore(contentSpace, {
	needs: {},
	situations: [
		"query content",
		"header content",
		"cookie content",
		"querystring content",
		"JSON content",
		"text content",
		"digit text kept",
		"absent and optional",
		"absent and required refused",
		"non-text under text media refused",
		"number with no JSON text refused",
		"header line break refused",
		"cookie-octet refused",
		"name refused"
	] satisfies ReadonlyArray<Reached<ContentFeature>>,
	check: (_, c: Case<ContentFeature>) => (parameter) =>
		Effect.gen(function* () {
			c.noteAll(contentFeatures(parameter))
			const value = Option.getOrUndefined(parameter.value)
			const options = { required: parameter.required }
			const built = {
				query: () =>
					Serialize.queryContent(parameter.name, parameter.mediaType, value, options).expand,
				header: () =>
					Serialize.headerContent(parameter.name, parameter.mediaType, value, options).expand,
				cookie: () =>
					Serialize.cookieContent(parameter.name, parameter.mediaType, value, options).expand,
				querystring: () =>
					Serialize.querystring(parameter.name, parameter.mediaType, value, options).expand
			}[parameter.location]()
			const actual = yield* expanded(built)
			assert.deepEqual(actual.outcome, outcomeOf(contentModel(parameter)))
			keepsSecret(actual)
		}),
	oracle: {
		kind: "specification",
		name: "OAS content parameters: the media type's codec, then each location's encoding and refusals"
	},
	kept: [],
	budget: { runs: 88, steered: 88 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original:
				"const absentContent = (name: string, options: ContentOptions) =>\n\toptions.required",
			replacement:
				"const absentContent = (name: string, options: ContentOptions) =>\n\t!options.required",
			why: "An absent content value is refused when optional and sends nothing when required; the property fails (CATCH's evidence, mutant 2840e0a0e8)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original:
				'\texpand: Effect.gen(function* headerContentExpansion() {\n\t\tif (!headerToken.test(name)) {\n\t\t\treturn yield* refuse("a header parameter has a name that is not an RFC 9110 token")\n\t\t}\n\n\t\tif (value === undefined) {',
			replacement:
				"\texpand: Effect.gen(function* headerContentExpansion() {\n\t\t{}\n\n\t\tif (value === undefined) {",
			why: "A header content parameter whose name is no token is sent; the property fails (CATCH's evidence, mutant 43628eae5e)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original:
				'\t\t\treturn yield* refuse("a cookie parameter has a name that is not an RFC 6265 token")\n\t\t}\n\n\t\tif (value === undefined) {\n\t\t\treturn yield* absentContent(name, options)\n\t\t}\n',
			replacement:
				'\t\t\treturn yield* refuse("a cookie parameter has a name that is not an RFC 6265 token")\n\t\t}\n\n\t\tif (value !== undefined) {\n\t\t\treturn yield* absentContent(name, options)\n\t\t}\n',
			why: "A present cookie content value is read as absent and an absent one runs on into the codec; the property fails (CATCH's evidence, mutant b1506d168f)."
		}
	]
})

/**
 * A request's URL is its path and its sent query pairs (none left in urlParams), its headers each header sent and one
 * Cookie header of the cookies' pairs, or it is refused as its descriptors are, or for two headers of one name or a Cookie header beside
 * cookie parameters. It replaces sixteen example cases (request, serialize-cookie-request, the header repairs); its
 * budget is 64 drawn requests, its floor 16, steered up to 64.
 */
export const requestAssembly = property.explore(requestSpace, {
	needs: {},
	situations: [
		"query pairs joined",
		"no query pair, no question mark",
		"header set",
		"header with no value left out",
		"cookies joined",
		"no cookie pair, no Cookie header",
		"extension method kept",
		"header names alike refused",
		"Cookie header beside cookies refused",
		"descriptor refusal"
	] satisfies ReadonlyArray<Reached<RequestFeature>>,
	check: (_, c: Case<RequestFeature>) => (request) =>
		Effect.gen(function* () {
			c.noteAll(requestFeatures(request))
			const built = Serialize.request(request.method, {
				path: Serialize.path(
					templateOf(request.path),
					Arr.map(request.path.parameters, (parameter) =>
						pathStyles[parameter.style](parameter.name, parameter.value, parameter)
					)
				),
				query: Arr.map(request.query, (parameter) =>
					queryStyles[parameter.style](parameter.name, parameter.value, parameter)
				),
				headers: Arr.map(request.headers, (header) =>
					Serialize.header(header.name, header.value, header)
				),
				cookies: Arr.map(request.cookies, (cookie) =>
					Serialize.cookie(cookie.name, cookie.value, cookie)
				)
			})
			const actual = yield* Effect.match(built, {
				onFailure: () => Option.none(),
				onSuccess: (made) =>
					Option.some({
						method: made.method,
						url: made.url,
						headers: Rec.fromEntries(Rec.toEntries(made.headers)),
						urlParams: Arr.fromIterable(made.urlParams)
					})
			})
			const expected = Result.match(requestModel(request), {
				onFailure: () => Option.none(),
				onSuccess: (sent) => Option.some({ method: request.method, ...sent, urlParams: [] })
			})
			assert.deepEqual(actual, expected)
		}),
	oracle: {
		kind: "specification",
		name: "design 4.5's request assembly over each descriptor's reference expansion"
	},
	kept: [],
	budget: { runs: 64, steered: 64 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original:
				'\n\t\tif (new Set(names).size !== names.length) {\n\t\t\treturn yield* refuse("two header parameters have one name")',
			replacement:
				'\n\t\tif (new Set(names).size === names.length) {\n\t\t\treturn yield* refuse("two header parameters have one name")',
			why: "Headers with distinct names are refused and two of one name are sent; the property fails (CATCH's evidence, mutant ad2a0508fc)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original:
				'if (new Set(names).size !== names.length) {\n\t\t\treturn yield* refuse("two header parameters have one name")\n\t\t}',
			replacement: "{}",
			why: "Two header parameters whose names differ only in case are both set; the property fails (CATCH's evidence, mutant fac55e368f)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: 'if (cookies.length > 0 && Arr.contains(names, "cookie")) {',
			replacement: "if (false) {",
			why: "A header parameter named Cookie is sent beside the cookie parameters' own Cookie header; the property fails."
		}
	]
})

/**
 * A body is sent as its reference writes it under its media type: compact JSON with every digit text kept, text as
 * given, bytes passed through, the empty body with no Content-Type; or it is refused as the reference says. It replaces
 * twenty-two example cases (body, the request repairs, serialize-json-number's tables); its budget is 88 drawn bodies,
 * its floor 22, steered up to 88.
 */
export const requestBody = property.explore(bodySpace, {
	needs: {},
	situations: [
		"JSON text",
		"digit text kept",
		"structured JSON media",
		"text as given",
		"bytes passed through",
		"streamed bytes passed through",
		"empty body, no Content-Type",
		"number with no JSON text refused",
		"non-text under text media refused",
		"lone surrogate in text refused",
		"media type no header carries refused"
	] satisfies ReadonlyArray<Reached<BodyFeature>>,
	check: (_, c: Case<BodyFeature>) => (body) =>
		Effect.gen(function* () {
			c.noteAll(bodyFeatures(body))
			const given = {
				json: () => (body.payload.kind === "json" ? body.payload.value : ""),
				bytes: () =>
					body.payload.kind === "bytes" && body.payload.as === "stream"
						? HttpBody.stream(Stream.make(body.payload.bytes))
						: HttpBody.uint8Array(
								body.payload.kind === "bytes" ? body.payload.bytes : new Uint8Array(0)
							),
				empty: () => HttpBody.empty
			}[body.payload.kind]()
			const built = yield* Effect.result(posted(Serialize.body(body.mediaType, given)))
			const expected = bodyModel(body)
			assert.ok(
				Result.isSuccess(built) === Result.isSuccess(expected),
				"refused exactly when the reference refuses"
			)
			if (!Result.isSuccess(built) || !Result.isSuccess(expected)) {
				return
			}
			const made = built.success
			const contentType = Headers.get(made.headers, "content-type")
			const sent = expected.success
			switch (sent.kind) {
				case "empty":
					assert.equal(made.body._tag, "Empty")
					assert.deepEqual(contentType, Option.none())
					break
				case "given":
					assert.ok(made.body === given, "bytes pass through as given")
					assert.deepEqual(contentType, Option.some(sent.contentType))
					break
				case "text": {
					const bytes = yield* bodyBytes(made.body)
					assert.deepEqual(bytes, Option.some(Buffer.from(sent.text, "utf8").toString("latin1")))
					assert.deepEqual(contentType, Option.some(sent.contentType))
				}
			}
		}),
	oracle: {
		kind: "second-implementation",
		name: "JSON text through effect's formatter with each digit text spliced in, the media type's codec otherwise"
	},
	kept: [],
	budget: { runs: 88, steered: 88 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: "if (value instanceof JsonNumber) {\n\t\treturn !isJsonNumberText(value.text)\n\t}",
			replacement: "{}",
			why: "A digit text that is no JSON number is written into the JSON body; the property fails (CATCH's evidence, mutant f4d0ddac91)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: "\thasUnwritableNumber(value)\n\t\t?",
			replacement: "\t!hasUnwritableNumber(value)\n\t\t?",
			why: "A JSON body is refused when its numbers are all writable and written when one is not; the property fails (CATCH's evidence, mutant c5077ca9c0)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: "\t\t\tdescriptors.body.ownsContentType === true",
			replacement: "\t\t\tdescriptors.body.ownsContentType !== true",
			why: "A body that owns no Content-Type sends its own type and a multipart body its media type without the boundary; the property fails (CATCH's evidence, mutant a676da4918)."
		}
	]
})

/** The body each key of a chosen-codec case's table takes. */
type TableBodies = {
	"application/json": Serialize.Body
	"application/x-www-form-urlencoded": Serialize.Json | undefined
	"image/*": Serialize.Body
	"multipart/form-data": Serialize.FormFields
}

/** The table a chosen-codec case reads: each key's codec, recording the Content-Type it is handed into `seen`. */
const tableOf = (seen: Array<string>): Serialize.Alternatives<TableBodies> => ({
	"application/json": (body, contentType) => {
		seen.push(contentType)
		return Serialize.body(contentType, body)
	},
	"application/x-www-form-urlencoded": (body, contentType) => {
		seen.push(contentType)
		return Serialize.urlEncoded(contentType, body, {
			properties: [
				["name", {}],
				["tags", { explode: false }]
			],
			required: true
		})
	},
	"image/*": (body, contentType) => {
		seen.push(contentType)
		return Serialize.body(contentType, body)
	},
	"multipart/form-data": (body, contentType) => {
		seen.push(contentType)
		return Serialize.formData(body, {
			parts: [
				["name", "text/plain"],
				["file", "application/octet-stream"]
			],
			required: true
		})
	}
})

/** A chosen case's body as its key's codec takes it, and what the codec `table` holds under that key makes of it
 * alone, each arm calling its own key's codec. */
const chosenOf = (
	chosen: AlternativeCase,
	table: Serialize.Alternatives<TableBodies>
): Readonly<{ choice: Serialize.Chosen<TableBodies>; alone: Serialize.RequestBody }> => {
	switch (chosen.key) {
		case "application/json":
			return {
				choice: { key: chosen.key, contentType: chosen.contentType, body: chosen.body },
				alone: table[chosen.key](chosen.body, chosen.contentType)
			}
		case "application/x-www-form-urlencoded": {
			const body = { name: chosen.body.name, tags: chosen.body.tags }
			return {
				choice: { key: chosen.key, contentType: chosen.contentType, body },
				alone: table[chosen.key](body, chosen.contentType)
			}
		}
		case "image/*": {
			const body = HttpBody.uint8Array(chosen.body)
			return {
				choice: { key: chosen.key, contentType: chosen.contentType, body },
				alone: table[chosen.key](body, chosen.contentType)
			}
		}
		case "multipart/form-data": {
			const body = {
				name: [chosen.body.name],
				file: [{ filename: "a.bin", stream: Stream.make(chosen.body.file) }]
			}
			return {
				choice: { key: chosen.key, contentType: chosen.contentType, body },
				alone: table[chosen.key](body, chosen.contentType)
			}
		}
	}
}

/**
 * The alternatives table runs exactly the chosen key's codec, handed the chosen Content-Type, and sends what that
 * codec sends alone (a JSON choice, what the body's reference writes). It replaces four example cases (serialize-alternatives); its budget is 16 drawn choices, its
 * floor 4.
 */
export const chosenCodec = property.explore(alternativeSpace, {
	needs: {},
	situations: [
		"application/json",
		"application/x-www-form-urlencoded",
		"image/*",
		"multipart/form-data",
		"range key's concrete type sent"
	] satisfies ReadonlyArray<Reached<AlternativeFeature>>,
	check: (_, c: Case<AlternativeFeature>) => (chosen) =>
		Effect.gen(function* () {
			c.noteAll(alternativeFeatures(chosen))
			const seen: Array<string> = []
			const { choice, alone } = chosenOf(chosen, tableOf([]))
			const through = yield* sentOf(posted(Serialize.alternatives(choice, tableOf(seen))))
			assert.deepEqual(seen, [chosen.contentType])
			const sentAlone = yield* sentOf(posted(alone))
			assert.deepEqual(through, sentAlone)
			if (chosen.key === "application/json") {
				assert.deepEqual(
					through,
					Result.match(
						bodyModel({
							mediaType: chosen.contentType,
							payload: { kind: "json", value: chosen.body }
						}),
						{
							onFailure: () => Option.none(),
							onSuccess: (sent) =>
								Option.some([
									Option.some(
										sent.kind === "text" ? Buffer.from(sent.text, "utf8").toString("latin1") : ""
									),
									Option.some(chosen.contentType)
								] as const)
						}
					)
				)
			}
		}),
	oracle: { kind: "universal", name: "a chosen alternative sends what its own codec sends alone" },
	kept: [],
	budget: { runs: 16, steered: 16 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/sequential.ts",
			original:
				'{\n\tconst essence = mediaEssence(mediaType)\n\n\treturn essence === "application/json" || essence.endsWith("+json")\n}',
			replacement: "{ return false }",
			why: "No media type is JSON, so the chosen JSON codec refuses an object body as non-text; the property fails (CATCH's evidence, mutant 363f6be2dd)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/serialize.ts",
			original: "table[chosen.key](chosen.body, chosen.contentType)",
			replacement: "table[chosen.key](chosen.body, chosen.key)",
			why: "A range key's codec is handed the range itself, not the operator's concrete type, which it then sends; the property fails."
		}
	]
})
