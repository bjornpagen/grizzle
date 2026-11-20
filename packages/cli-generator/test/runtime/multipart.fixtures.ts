/**
 * What the properties of multipart.test.ts read: multipart bodies as drawn (declared, chosen, nested and positional
 * parts of text, numbers, digit texts, JSON and files in chunks), a multipart reader written apart from the writer
 * (RFC 2046's delimiters, a part's head lines, its body), the bodies a reference writer's parts read as, and part
 * schemas with a checker of their own for the form assertion.
 */

import {
	aimed,
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	option,
	weighted
} from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import {
	Array as Arr,
	Option,
	Predicate,
	Record as Rec,
	Result,
	Schema,
	Stream,
	String as Str
} from "effect"
import { JsonNumber, jsonNull } from "#runtime-src/runtime/input.ts"
import type * as Multipart from "#runtime-src/runtime/multipart.ts"
import * as Serialize from "#runtime-src/runtime/serialize.ts"
import type { Json, Nested } from "#runtime-src/runtime/serialize.ts"
import {
	type HeaderCase,
	headerModel,
	holding,
	holdsLone,
	jsonModel,
	jsonValue,
	latin1,
	number,
	type Read,
	refused,
	text
} from "#test/runtime/serialize.fixtures.ts"

/** A file part's value as drawn: its file name and its bytes in the chunks they stream in. */
export type FileValue = Readonly<{
	kind: "file"
	filename: string
	chunks: ReadonlyArray<Uint8Array>
}>

/** One part value as drawn: text, a number, a boolean, a digit text, a JSON value, or a file. */
export type LeafValue =
	| Readonly<{ kind: "text"; value: string }>
	| Readonly<{ kind: "number"; value: number }>
	| Readonly<{ kind: "boolean"; value: boolean }>
	| Readonly<{ kind: "digits"; text: string }>
	| Readonly<{ kind: "json"; value: Json }>
	| FileValue

/** How one declared part is sent. */
export type Rule =
	| Readonly<{
			kind: "declared"
			contentType: string
			base64: boolean
			values: ReadonlyArray<LeafValue>
	  }>
	| Readonly<{
			kind: "chosen"
			contentType: Option.Option<string>
			headers: ReadonlyArray<HeaderCase>
			values: ReadonlyArray<LeafValue>
	  }>
	| Readonly<{ kind: "absent" }>
	| Readonly<{
			kind: "nested"
			form: "form-data" | "mixed"
			members: ReadonlyArray<
				readonly [name: string, contentType: string, values: ReadonlyArray<LeafValue>]
			>
	  }>
	| Readonly<{
			kind: "positional"
			flag: string
			item: Option.Option<string>
			positions: ReadonlyArray<string>
			files: ReadonlyArray<FileValue>
	  }>

/** A form a generated handler hands its writer by mistake: a value under no part, a chosen part also a field, a sent part with no type. */
export type Fault =
	| "none"
	| "undeclared field"
	| "chosen part also a field"
	| "chosen part with no type"

/** A multipart/form-data body as drawn: its parts in wire order, whether it is required, and a fault now and then. */
export type FormDataCase = Readonly<{
	parts: ReadonlyArray<readonly [name: string, rule: Rule]>
	required: boolean
	fault: Fault
}>

/** Part names: plain, and ones holding a quote, a lone LF, a CRLF and a non-ASCII letter the disposition escapes. */
const PART_NAMES: Arr.NonEmptyReadonlyArray<string> = [
	"title",
	"file",
	"note",
	'a"b',
	"a\nb",
	"a\r\nb",
	"é"
]

/** File names: plain, and ones holding a quote and a line break, which the disposition escapes but never normalizes. */
const FILE_NAMES: Arr.NonEmptyReadonlyArray<string> = [
	"contacts.csv",
	"scan.png",
	'a"b.bin',
	"a\nb",
	"a\rb"
]

/** Part media types. */
const PART_TYPES: Arr.NonEmptyReadonlyArray<string> = [
	"text/plain",
	"application/octet-stream",
	"application/json",
	"image/png",
	"application/vnd.meta+json",
	"text/csv"
]

/** A file's bytes as drawn: up to eight bytes in chunks of one to five, so a base64 quantum spans chunk boundaries. */
const fileValue: Gen<FileValue> = (source) => ({
	kind: "file",
	filename: element(FILE_NAMES)(source),
	chunks: array(
		map(array(int(0, 255), { min: 0, max: 5 }), (bytes) => Uint8Array.from(bytes)),
		{ min: 0, max: 3 }
	)(source)
})

/** A digit text: a JSON number past 2^53, a decimal, and a text that is none (a part sends it as given). */
const digitsValue: Gen<LeafValue> = map(
	element(["9007199254740993", "1.50", "42", "x1"]),
	(digits) => ({
		kind: "digits",
		text: digits
	})
)

/** One part value as drawn: text above all, then numbers, booleans, digit texts, JSON values and files. */
const leafValue: Gen<LeafValue> = weighted<LeafValue>([
	[5, map(text, (value): LeafValue => ({ kind: "text", value }))],
	[1, map(number, (value): LeafValue => ({ kind: "number", value }))],
	[1, map(boolean, (value): LeafValue => ({ kind: "boolean", value }))],
	[1, digitsValue],
	[2, map(jsonValue, (value): LeafValue => ({ kind: "json", value }))],
	[2, fileValue]
])

/** A header a chosen part carries: a token name, plain or absent or unsafe values. */
const partHeader: Gen<HeaderCase> = (source) => ({
	name: element(["X-Checksum", "X-Trace", "X-Tags"])(source),
	value: weighted<Nested>([
		[3, constant("9f86d0")],
		[1, constant(undefined)],
		[1, constant(["a", "b"])],
		[1, constant("a\r\nb")]
	])(source),
	explode: false,
	required: false
})

/** How one part is sent, as drawn. */
const ruleSpace: Gen<Rule> = weighted<Rule>([
	[
		6,
		(source) => ({
			kind: "declared",
			contentType: element(PART_TYPES)(source),
			base64: weighted([
				[4, constant(false)],
				[1, constant(true)]
			])(source),
			values: array(leafValue, { min: 0, max: 2 })(source)
		})
	],
	[
		2,
		(source) => ({
			kind: "chosen",
			contentType: map(element(PART_TYPES), Option.some)(source),
			headers: array(partHeader, { min: 0, max: 2 })(source),
			values: array(leafValue, { min: 0, max: 2 })(source)
		})
	],
	[1, constant<Rule>({ kind: "absent" })],
	[
		2,
		(source) => ({
			kind: "nested",
			form: element<"form-data" | "mixed">(["mixed", "form-data"])(source),
			members: Arr.map(
				Arr.dedupe(array(element(["meta", "note", "scan"]), { min: 1, max: 3 })(source)),
				(member) =>
					[
						member,
						element(PART_TYPES)(source),
						array(leafValue, { min: 0, max: 2 })(source)
					] as const
			)
		})
	],
	[
		2,
		(source) => ({
			kind: "positional",
			flag: "pages",
			item: option(element(PART_TYPES))(source),
			positions: array(element(PART_TYPES), { min: 0, max: 2 })(source),
			files: array(fileValue, { min: 0, max: 3 })(source)
		})
	]
])

/** A multipart/form-data body as drawn: parts under distinct names, a fault one draw in ten. */
const formDataDrawn: Gen<FormDataCase> = (source) => {
	const names = Arr.dedupe(array(element(PART_NAMES), { min: 0, max: 3 })(source))
	return {
		parts: Arr.map(names, (name) => [name, ruleSpace(source)] as const),
		required: boolean(source),
		fault: weighted<Fault>([
			[9, constant("none")],
			[
				1,
				element<Fault>(["undeclared field", "chosen part also a field", "chosen part with no type"])
			]
		])(source)
	}
}

/** One section of a multipart body as read: its head lines and its body, a nested multipart body read as sections. */
export type Section = Readonly<{ head: ReadonlyArray<string>; body: SectionBody }>

/** A section's body: bytes as latin-1 text, or the sections of a nested multipart body. */
export type SectionBody =
	| Readonly<{ kind: "bytes"; bytes: string }>
	| Readonly<{ kind: "nested"; sections: ReadonlyArray<Section> }>

const nestedType = regex("^Content-Type: multipart/([a-z-]+); boundary=(.+)$", "u")

/** A section's head lines and the rest after the blank line ending them, or none when no blank line ends them. */
const headOf = (chunk: string): Option.Option<readonly [ReadonlyArray<string>, string]> =>
	Str.startsWith("\r\n")(chunk)
		? Option.some([[], Str.slice(2)(chunk)] as const)
		: Option.map(
				Str.indexOf("\r\n\r\n")(chunk),
				(end) => [Str.split("\r\n")(Str.slice(0, end)(chunk)), Str.slice(end + 4)(chunk)] as const
			)

/**
 * A multipart body's sections (RFC 2046 5.1), read apart from any writer: no preamble, each part after a
 * `--boundary` line, its head lines, a blank line, its body and the CRLF before the next delimiter, and the close
 * delimiter `--boundary--` last (followed by CRLF at the top, by nothing inside a part). A section whose Content-Type
 * names a nested multipart body is read as that body, its boundary shown as `<nested>`. None for a body that does not
 * read so.
 */
export const readMultipart = (
	body: string,
	boundary: string,
	top: boolean
): Option.Option<ReadonlyArray<Section>> => {
	const close = `--${boundary}--${top ? "\r\n" : ""}`
	if (!Str.endsWith(close)(body)) {
		return Option.none()
	}
	const [preamble, ...chunks] = Str.split(`--${boundary}\r\n`)(
		Str.slice(0, body.length - close.length)(body)
	)
	if (preamble !== "" || !Arr.every(chunks, Str.endsWith("\r\n"))) {
		return Option.none()
	}
	return Option.all(
		Arr.map(chunks, (chunk) =>
			Option.flatMap(headOf(Str.slice(0, chunk.length - 2)(chunk)), ([head, rest]) => {
				const nested = Arr.findFirstWithIndex(head, (line) =>
					Option.fromNullishOr(nestedType.exec(line))
				)
				return Option.match(
					Option.map(nested, ([[, kind, inner], at]) => [at, kind, inner] as const),
					{
						onNone: () => Option.some<Section>({ head, body: { kind: "bytes", bytes: rest } }),
						onSome: ([at, kind, inner]) =>
							Option.map(readMultipart(rest, inner, false), (sections): Section => ({
								head: Arr.map(head, (each, place) =>
									place === at ? `Content-Type: multipart/${kind}; boundary=<nested>` : each
								),
								body: { kind: "nested", sections }
							}))
					}
				)
			})
		)
	)
}

const loneBreak = regex("\r(?!\n)|(?<!\r)\n", "gu")

/** WHATWG's multipart/form-data escape of a quoted name: a name's lone CR or LF first made CRLF, then LF, CR and quote as triplets. */
const quoted = (value: string, isName: boolean): string =>
	Str.replaceAll(
		'"',
		"%22"
	)(
		Str.replaceAll(
			"\r",
			"%0D"
		)(Str.replaceAll("\n", "%0A")(isName ? Str.replaceAll(loneBreak, "\r\n")(value) : value))
	)

/** A head line's UTF-8 bytes as the reader reads them, one character a byte. */
const asRead = (line: string): string => latin1(new TextEncoder().encode(line))

/** A form-data part's Content-Disposition line, with a file's name when the part is a file, as the reader reads it. */
const disposition = (name: string, filename: Option.Option<string>): string =>
	asRead(
		`Content-Disposition: form-data; name="${quoted(name, true)}"${Option.match(filename, {
			onNone: () => "",
			onSome: (file) => `; filename="${quoted(file, false)}"`
		})}`
	)

/** A file's bytes whole. */
const fileBytes = (file: FileValue): Uint8Array =>
	Uint8Array.from(Arr.flatMap(file.chunks, (chunk) => Arr.fromIterable(chunk)))

/** A part value's bytes (design 6.3): text as UTF-8, a finite number and a boolean as their text, a digit text as given, JSON as its compact text; refused otherwise. */
const leafBytes = (value: LeafValue): Read<Uint8Array> => {
	const utf8 = (written: string) => Result.succeed(new TextEncoder().encode(written))
	switch (value.kind) {
		case "text":
			return holdsLone(value.value) ? refused : utf8(value.value)
		case "number":
			return Number.isFinite(value.value) ? utf8(String(value.value)) : refused
		case "boolean":
			return utf8(String(value.value))
		case "digits":
			return utf8(value.text)
		case "json":
			return Option.match(jsonModel(value.value), {
				onNone: (): Read<Uint8Array> => refused,
				onSome: utf8
			})
		case "file":
			return Result.succeed(fileBytes(value))
	}
}

/** A leaf section: its disposition (form-data only), its header lines, its transfer encoding, its type, its bytes. */
const leafSection = (
	kind: "form-data" | "mixed",
	name: string,
	contentType: string,
	headers: ReadonlyArray<readonly [string, string]>,
	base64: boolean,
	value: LeafValue
): Read<Section> =>
	Result.map(leafBytes(value), (bytes): Section => ({
		head: [
			...(kind === "form-data"
				? [disposition(name, value.kind === "file" ? Option.some(value.filename) : Option.none())]
				: []),
			...Arr.map(headers, ([header, written]) => `${header}: ${written}`),
			...(base64 ? ["Content-Transfer-Encoding: base64"] : []),
			`Content-Type: ${contentType}`
		],
		body: { kind: "bytes", bytes: base64 ? Buffer.from(bytes).toString("base64") : latin1(bytes) }
	}))

/** What a multipart writer is to do: write these sections, send no body at all, refuse with a UsageError (naming a flag, maybe), or die. */
export type Written =
	| Readonly<{ kind: "sections"; sections: ReadonlyArray<Section> }>
	| Readonly<{ kind: "empty" }>
	| Readonly<{ kind: "refused"; flag: Option.Option<string> }>
	| Readonly<{ kind: "defect" }>

/** One part's sections, or the writer's refusal of it. */
type PartRead = Result.Result<ReadonlyArray<Section>, Written>

const refusedPart: PartRead = Result.fail({ kind: "refused", flag: Option.none() })

/** The sections of each value under one rule, or the first refusal. */
const allSections = (reads: ReadonlyArray<Read<Section>>): PartRead =>
	Result.mapError(Result.all(reads), (): Written => ({ kind: "refused", flag: Option.none() }))

/**
 * One declared part's sections (design 6.3): a declared or chosen part one section per value, a chosen part's sent
 * header lines before its type; a part nested by name one multipart section of its members' values in member order
 * (no names under mixed), none when no member has a value; a part nested by position one mixed section of its files,
 * file i under position i and later files under the item rule, none when no file is given, and a refusal naming its
 * flag past the last rule.
 */
const partSections = (name: string, rule: Rule, fault: Fault): PartRead => {
	switch (rule.kind) {
		case "absent":
			return Result.succeed([])
		case "declared":
			return allSections(
				Arr.map(rule.values, (value) =>
					leafSection("form-data", name, rule.contentType, [], rule.base64, value)
				)
			)
		case "chosen": {
			if (fault === "chosen part also a field") {
				return Result.fail({ kind: "defect" })
			}
			if (rule.values.length === 0) {
				return Result.succeed([])
			}
			if (fault === "chosen part with no type") {
				return Result.fail({ kind: "defect" })
			}
			const headers = Result.all(
				Arr.map(rule.headers, (header) =>
					Result.map(
						headerModel(header),
						Option.map((written) => [header.name, written] as const)
					)
				)
			)
			return Result.isFailure(headers)
				? refusedPart
				: allSections(
						Arr.map(rule.values, (value) =>
							leafSection(
								"form-data",
								name,
								Option.getOrElse(rule.contentType, () => ""),
								Arr.getSomes(headers.success),
								false,
								value
							)
						)
					)
		}
		case "nested": {
			if (Arr.every(rule.members, ([, , values]) => values.length === 0)) {
				return Result.succeed([])
			}
			return Result.map(
				allSections(
					Arr.flatMap(rule.members, ([member, contentType, values]) =>
						Arr.map(values, (value) =>
							leafSection(rule.form, member, contentType, [], false, value)
						)
					)
				),
				(sections): ReadonlyArray<Section> => [
					{
						head: [
							disposition(name, Option.none()),
							`Content-Type: multipart/${rule.form}; boundary=<nested>`
						],
						body: { kind: "nested", sections }
					}
				]
			)
		}
		case "positional": {
			if (rule.files.length === 0) {
				return Result.succeed([])
			}
			if (Option.isNone(rule.item) && rule.files.length > rule.positions.length) {
				return Result.fail({ kind: "refused", flag: Option.some(rule.flag) })
			}
			return Result.map(
				allSections(
					Arr.map(rule.files, (file, at) =>
						leafSection(
							"mixed",
							name,
							Option.getOrElse(Arr.get(rule.positions, at), () =>
								Option.getOrElse(rule.item, () => "")
							),
							[],
							false,
							file
						)
					)
				),
				(sections): ReadonlyArray<Section> => [
					{
						head: [
							disposition(name, Option.none()),
							"Content-Type: multipart/mixed; boundary=<nested>"
						],
						body: { kind: "nested", sections }
					}
				]
			)
		}
	}
}

/**
 * What the writer does with a form: a fault is a defect; else every part's sections in wire order, the first refusal
 * failing the whole; with no section an optional body is no body at all and a required one the close delimiter alone.
 */
export const formDataModel = (form: FormDataCase): Written => {
	if (form.fault === "undeclared field") {
		return { kind: "defect" }
	}
	const read = Result.all(
		Arr.map(form.parts, ([name, rule]) => partSections(name, rule, form.fault))
	)
	return Result.match(read, {
		onFailure: (written) => written,
		onSuccess: (parts): Written => {
			const sections = Arr.flatten(parts)
			return sections.length === 0 && !form.required
				? { kind: "empty" }
				: { kind: "sections", sections }
		}
	})
}

/** A part value as the runtime takes it. */
const formValueOf = (value: LeafValue): Serialize.FormValue => {
	switch (value.kind) {
		case "text":
		case "number":
		case "boolean":
			return value.value
		case "digits":
			return { text: value.text }
		case "json":
			return Serialize.jsonPart(value.value)
		case "file":
			return { filename: value.filename, stream: Stream.fromIterable(value.chunks) }
	}
}

/** A form's fields and part entries as a generated handler hands them to `formData`, its fault planted. */
export const formDataInput = (
	form: FormDataCase
): Readonly<{ fields: Serialize.FormFields; parts: ReadonlyArray<Serialize.FormPartEntry> }> => {
	const entries = Arr.map(
		form.parts,
		([name, rule]): readonly [
			Serialize.FormPartEntry,
			Option.Option<readonly [string, ReadonlyArray<Serialize.FormValue>]>
		] => {
			switch (rule.kind) {
				case "absent":
					return [[name, undefined], Option.none()]
				case "declared":
					return [
						rule.base64 ? [name, rule.contentType, "base64"] : [name, rule.contentType],
						Option.some([name, Arr.map(rule.values, formValueOf)] as const)
					]
				case "chosen":
					return [
						[
							name,
							{
								contentType:
									form.fault === "chosen part with no type" ? Option.none() : rule.contentType,
								headers: Arr.map(rule.headers, (header) =>
									Serialize.header(header.name, header.value, header)
								),
								values: Arr.map(rule.values, formValueOf)
							}
						],
						form.fault === "chosen part also a field"
							? Option.some([name, []] as const)
							: Option.none()
					]
				case "nested":
					return [
						[
							name,
							{
								kind: rule.form,
								parts: Arr.map(
									rule.members,
									([member, contentType]) => [member, contentType] as const
								)
							}
						],
						Option.some([
							name,
							Serialize.nestedValues(
								Rec.fromEntries(
									Arr.map(
										rule.members,
										([member, , values]) => [member, Arr.map(values, formValueOf)] as const
									)
								)
							)
						] as const)
					]
				case "positional":
					return [
						[
							name,
							Option.match(rule.item, {
								onNone: () => ({
									flag: rule.flag,
									kind: "mixed" as const,
									positions: rule.positions
								}),
								onSome: (item) => ({
									flag: rule.flag,
									item,
									kind: "mixed" as const,
									positions: rule.positions
								})
							})
						],
						Option.some([name, Arr.map(rule.files, formValueOf)] as const)
					]
			}
		}
	)
	const fields = Rec.fromEntries(Arr.getSomes(Arr.map(entries, ([, field]) => field)))
	return {
		fields: form.fault === "undeclared field" ? { ...fields, stray: ["x"] } : fields,
		parts: Arr.map(entries, ([entry]) => entry)
	}
}

/** The situations a multipart/form-data body reaches. */
export type FormDataFeature =
	| "text part"
	| "number part"
	| "digit text part"
	| "JSON part"
	| "file part"
	| "base64 part"
	| "base64 across chunks"
	| "chosen part with header lines"
	| "nested by name, mixed"
	| "nested by name, form-data"
	| "nested by position"
	| "name escaped"
	| "file name escaped"
	| "required body with no part"
	| "optional body with no part"
	| "part value refused"
	| "header line refused"
	| "file beyond the positions refused"
	| "defect"

/** Every value a form sends, with the rule it is sent under. */
const valuesOf = (form: FormDataCase): ReadonlyArray<readonly [Rule, LeafValue]> =>
	Arr.flatMap(form.parts, ([, rule]): ReadonlyArray<readonly [Rule, LeafValue]> => {
		switch (rule.kind) {
			case "absent":
				return []
			case "declared":
			case "chosen":
				return Arr.map(rule.values, (value) => [rule, value] as const)
			case "nested":
				return Arr.flatMap(rule.members, ([, , values]) =>
					Arr.map(values, (value) => [rule, value] as const)
				)
			case "positional":
				return Arr.map(rule.files, (file): readonly [Rule, LeafValue] => [rule, file])
		}
	})

/** What a multipart/form-data case reaches. */
export const formDataFeatures = (form: FormDataCase): ReadonlyArray<FormDataFeature> => {
	const written = formDataModel(form)
	const sent = written.kind === "sections"
	const values = valuesOf(form)
	const sentRules = Arr.filter(
		form.parts,
		([, rule]) =>
			Result.isSuccess(partSections("", rule, form.fault)) &&
			Result.getOrElse(partSections("", rule, form.fault), () => []).length > 0
	)
	const valueKinds = Arr.map(values, ([, value]) => value.kind)
	return holding<FormDataFeature>([
		["text part", sent && Arr.contains(valueKinds, "text")],
		["number part", sent && Arr.contains(valueKinds, "number")],
		["digit text part", sent && Arr.contains(valueKinds, "digits")],
		["JSON part", sent && Arr.contains(valueKinds, "json")],
		["file part", sent && Arr.contains(valueKinds, "file")],
		["base64 part", sent && Arr.some(values, ([rule]) => rule.kind === "declared" && rule.base64)],
		[
			"base64 across chunks",
			sent &&
				Arr.some(
					values,
					([rule, value]) =>
						rule.kind === "declared" &&
						rule.base64 &&
						value.kind === "file" &&
						Arr.some(value.chunks, (chunk) => chunk.length % 3 !== 0) &&
						value.chunks.length > 1
				)
		],
		[
			"chosen part with header lines",
			sent &&
				Arr.some(
					sentRules,
					([, rule]) =>
						rule.kind === "chosen" && Arr.some(rule.headers, (header) => header.value !== undefined)
				)
		],
		[
			"nested by name, mixed",
			sent && Arr.some(sentRules, ([, rule]) => rule.kind === "nested" && rule.form === "mixed")
		],
		[
			"nested by name, form-data",
			sent && Arr.some(sentRules, ([, rule]) => rule.kind === "nested" && rule.form === "form-data")
		],
		["nested by position", sent && Arr.some(sentRules, ([, rule]) => rule.kind === "positional")],
		["name escaped", sent && Arr.some(sentRules, ([name]) => quoted(name, true) !== name)],
		[
			"file name escaped",
			sent &&
				Arr.some(
					values,
					([, value]) => value.kind === "file" && quoted(value.filename, false) !== value.filename
				)
		],
		["required body with no part", sent && written.sections.length === 0],
		["optional body with no part", written.kind === "empty"],
		[
			"part value refused",
			written.kind === "refused" &&
				Option.isNone(written.flag) &&
				Arr.some(values, ([, value]) => Result.isFailure(leafBytes(value)))
		],
		[
			"header line refused",
			written.kind === "refused" &&
				Arr.some(
					form.parts,
					([, rule]) =>
						rule.kind === "chosen" &&
						rule.values.length > 0 &&
						Arr.some(rule.headers, (header) => Result.isFailure(headerModel(header)))
				)
		],
		[
			"file beyond the positions refused",
			written.kind === "refused" && Option.isSome(written.flag)
		],
		["defect", written.kind === "defect"]
	])
}

/**
 * A form aimed at what plain draws reach rarely: a base64 file in uneven chunks, a chosen part with a header line sent
 * and one refused, and a positional part with no item rule past its positions.
 */
export const formDataSpace = aimed<FormDataCase, FormDataFeature>(formDataDrawn, [
	[
		"base64 across chunks",
		(source) => ({
			parts: [
				[
					"file",
					{
						kind: "declared",
						contentType: "application/octet-stream",
						base64: true,
						values: [
							{
								kind: "file",
								filename: "doc.bin",
								chunks: array(
									map(array(int(0, 255), { min: 1, max: 4 }), (bytes) => Uint8Array.from(bytes)),
									{ min: 2, max: 4 }
								)(source)
							}
						]
					}
				]
			],
			required: true,
			fault: "none"
		})
	],
	[
		"chosen part with header lines",
		(source) => ({
			parts: [
				[
					"photo",
					{
						kind: "chosen",
						contentType: Option.some("image/png"),
						headers: [
							{
								name: "X-Trace",
								value: element(["trace-1", "a b", "0"])(source),
								explode: false,
								required: false
							}
						],
						values: [{ kind: "text", value: "x" }]
					}
				]
			],
			required: true,
			fault: "none"
		})
	],
	[
		"header line refused",
		(source) => ({
			parts: [
				[
					"photo",
					{
						kind: "chosen",
						contentType: Option.some("image/png"),
						headers: [
							{
								name: "X-Trace",
								value: element(["a\r\nb", "a\nb", "\u0000"])(source),
								explode: false,
								required: false
							}
						],
						values: [{ kind: "text", value: "x" }]
					}
				]
			],
			required: true,
			fault: "none"
		})
	],
	[
		"file beyond the positions refused",
		(source) => ({
			parts: [
				[
					"pages",
					{
						kind: "positional",
						flag: "pages",
						item: Option.none(),
						positions: ["application/json"],
						files: array(fileValue, { min: 2, max: 3 })(source)
					}
				]
			],
			required: true,
			fault: "none"
		})
	]
])

/** A positional multipart/mixed body as drawn: its parts' bytes, position and item rules, bounds and presence. */
export type MixedCase = Readonly<{
	bodies: ReadonlyArray<Readonly<{ chunks: ReadonlyArray<Uint8Array>; streamed: boolean }>>
	prefix: ReadonlyArray<Multipart.PartEncoding>
	item: Option.Option<Multipart.PartEncoding>
	maxParts: Option.Option<number>
	minParts: Option.Option<number>
	required: boolean
}>

/** One position's or the item's encoding: a type, and base64 now and then. */
const partEncoding: Gen<Multipart.PartEncoding> = (source) => {
	const contentType = option(element(PART_TYPES))(source)
	const base64 = weighted([
		[3, constant(false)],
		[1, constant(true)]
	])(source)
	return {
		...Option.match(contentType, { onNone: () => ({}), onSome: (type) => ({ contentType: type }) }),
		...(base64 ? { contentEncoding: "base64" as const } : {})
	}
}

/** A positional body as drawn. */
const mixedDrawn: Gen<MixedCase> = (source) => ({
	bodies: array(
		(inner) => ({
			chunks: array(
				map(array(int(0, 255), { min: 0, max: 4 }), (bytes) => Uint8Array.from(bytes)),
				{ min: 1, max: 2 }
			)(inner),
			streamed: boolean(inner)
		}),
		{ min: 0, max: 4 }
	)(source),
	prefix: array(partEncoding, { min: 0, max: 3 })(source),
	item: option(partEncoding)(source),
	maxParts: option(int(0, 4))(source),
	minParts: option(int(0, 3))(source),
	required: boolean(source)
})

/**
 * A positional body's writing (design 6.3, HT:B15, MED-07, MED-08, MED-15): none at all when optional and empty;
 * refused naming `part` past its rules or bounds; else part i under position i and later parts under the item rule,
 * no disposition, its transfer encoding and type, unused positions writing nothing.
 */
export const mixedModel = (mixed: MixedCase): Written => {
	if (mixed.bodies.length === 0 && !mixed.required) {
		return { kind: "empty" }
	}
	const most = Math.min(
		Option.isNone(mixed.item) ? mixed.prefix.length : Number.POSITIVE_INFINITY,
		Option.getOrElse(mixed.maxParts, () => Number.POSITIVE_INFINITY)
	)
	if (
		mixed.bodies.length > most ||
		mixed.bodies.length < Option.getOrElse(mixed.minParts, () => 0)
	) {
		return { kind: "refused", flag: Option.some("part") }
	}
	return {
		kind: "sections",
		sections: Arr.map(mixed.bodies, (body, at): Section => {
			const encoding: Multipart.PartEncoding = Option.getOrElse(
				Option.orElse(Arr.get(mixed.prefix, at), () => mixed.item),
				(): Multipart.PartEncoding => ({})
			)
			const bytes = Uint8Array.from(Arr.flatMap(body.chunks, (chunk) => Arr.fromIterable(chunk)))
			const base64 = encoding.contentEncoding === "base64"
			return {
				head: [
					...(base64 ? ["Content-Transfer-Encoding: base64"] : []),
					...(encoding.contentType === undefined ? [] : [`Content-Type: ${encoding.contentType}`])
				],
				body: {
					kind: "bytes",
					bytes: base64 ? Buffer.from(bytes).toString("base64") : latin1(bytes)
				}
			}
		})
	}
}

/** The situations a positional body reaches. */
export type MixedFeature =
	| "position rules"
	| "item rule"
	| "unused positions"
	| "base64 part"
	| "required with no part"
	| "optional with no part"
	| "past the rules refused"
	| "past maxParts refused"
	| "under minParts refused"

/** What a positional body reaches. */
export const mixedFeatures = (mixed: MixedCase): ReadonlyArray<MixedFeature> => {
	const written = mixedModel(mixed)
	const sent = written.kind === "sections"
	const count = mixed.bodies.length
	const ruled = Option.isNone(mixed.item) ? mixed.prefix.length : Number.POSITIVE_INFINITY
	return holding<MixedFeature>([
		["position rules", sent && count > 0 && mixed.prefix.length > 0],
		["item rule", sent && count > mixed.prefix.length && Option.isSome(mixed.item)],
		["unused positions", sent && count > 0 && mixed.prefix.length > count],
		[
			"base64 part",
			sent &&
				Arr.some(Arr.take(mixed.prefix, count), (encoding) => encoding.contentEncoding === "base64")
		],
		["required with no part", sent && count === 0],
		["optional with no part", written.kind === "empty"],
		["past the rules refused", written.kind === "refused" && count > ruled],
		[
			"past maxParts refused",
			written.kind === "refused" &&
				count <= ruled &&
				Option.exists(mixed.maxParts, (most) => count > most)
		],
		[
			"under minParts refused",
			written.kind === "refused" &&
				Option.exists(mixed.minParts, (least) => count < least) &&
				count <= ruled &&
				!Option.exists(mixed.maxParts, (most) => count > most)
		]
	])
}

/** A positional body, as drawn. */
export const mixedSpace: Gen<MixedCase> = mixedDrawn

/** What a part's schema asks of it: text, a three-letter code, a whole number, one of two words, a list of texts, a non-empty file, a JSON record, one positional file. */
export type PartKind = "text" | "code" | "count" | "choice" | "tags" | "file" | "meta" | "pages"

/** One part of a body schema as drawn: its kind, name, whether the schema makes it optional, and the values given for it. */
export type AssertLeaf = Readonly<{
	kind: PartKind
	name: string
	optional: boolean
	values: ReadonlyArray<LeafValue>
}>

/** A schema part: a leaf, or a part nested by name with members of its own (HT:B16). */
export type AssertPart =
	| AssertLeaf
	| Readonly<{
			kind: "nested"
			name: string
			optional: boolean
			members: ReadonlyArray<AssertLeaf>
	  }>

/** A keyed choice of `chooseParts` as drawn: its key, the part it moves, the type it carries, and its headers. */
export type Choice = Readonly<{
	key: string
	part: string
	contentType: Option.Option<string>
	headers: ReadonlyArray<HeaderCase>
}>

/** A form asserted against its body schema before any request, and split for the api builder. */
export type AssertCase = Readonly<{
	parts: ReadonlyArray<AssertPart>
	required: boolean
	choices: ReadonlyArray<Choice>
}>

/** Valid and invalid values per part kind, each kind's own: the schema's types, a JSON record, files for presence. */
const kindValue = (kind: PartKind): Gen<LeafValue> => {
	const textOf = (value: string): LeafValue => ({ kind: "text", value })
	switch (kind) {
		case "text":
			return weighted<LeafValue>([
				[3, map(text, textOf)],
				[1, constant<LeafValue>({ kind: "number", value: 3 })]
			])
		case "code":
			return map(element(["ABC", "XYZ", "abc", "SECRET"]), textOf)
		case "count":
			return weighted<LeafValue>([
				[
					2,
					map(element(["42", "9007199254740993", "1.50", "x1"]), (digits): LeafValue => ({
						kind: "digits",
						text: digits
					}))
				],
				[1, constant<LeafValue>({ kind: "number", value: 7 })]
			])
		case "choice":
			return map(element(["skip", "upsert", "replace"]), textOf)
		case "tags":
			return weighted<LeafValue>([
				[3, map(text, textOf)],
				[1, constant<LeafValue>({ kind: "boolean", value: true })]
			])
		case "file":
			return weighted<LeafValue>([
				[3, fileValue],
				[1, map(element(["", "inline"]), textOf)]
			])
		case "meta":
			return map(element([true, false]), (valid): LeafValue => ({
				kind: "json",
				value: {
					big: valid ? new JsonNumber("9007199254740993") : "SECRET",
					name: "Ada",
					tags: [jsonNull, 1]
				}
			}))
		case "pages":
			return fileValue
	}
}

/** Whether a kind is sent one value per item. */
const repeats = (kind: PartKind): boolean => kind === "tags" || kind === "pages"

/** A leaf part as drawn under a name: its kind, optionality and values (a repeated kind any number, others at most one now and then two). */
const assertLeaf =
	(name: string, kinds: Arr.NonEmptyReadonlyArray<PartKind>): Gen<AssertLeaf> =>
	(source) => {
		const kind = element(kinds)(source)
		return {
			kind,
			name,
			optional: boolean(source),
			values: array(
				kindValue(kind),
				repeats(kind) ? { min: 0, max: 3 } : { min: 0, max: 1 }
			)(source)
		}
	}

/** A body schema's parts as drawn: up to four leaves and now and then a nested part, and keyed choices over the leaves. */
const assertDrawn: Gen<AssertCase> = (source) => {
	const names = Arr.dedupe(
		array(element(["code", "count", "file", "on_conflict", "tags", "meta", "pages"]), {
			min: 0,
			max: 4
		})(source)
	)
	const leaves = Arr.map(names, (name) =>
		assertLeaf(name, ["text", "code", "count", "choice", "tags", "file", "meta", "pages"])(source)
	)
	const nested = weighted<ReadonlyArray<AssertPart>>([
		[2, constant([])],
		[
			1,
			(inner) => [
				{
					kind: "nested",
					name: "form",
					optional: boolean(inner),
					members: Arr.map(
						Arr.dedupe(array(element(["x", "y", "scan", "tags"]), { min: 1, max: 3 })(inner)),
						(member) => assertLeaf(member, ["text", "count", "file", "tags"])(inner)
					)
				}
			]
		]
	])(source)
	return {
		parts: [...leaves, ...nested],
		required: boolean(source),
		choices: Arr.map(
			Arr.filter(leaves, () =>
				weighted([
					[3, constant(false)],
					[1, constant(true)]
				])(source)
			),
			(leaf) => ({
				key: `${leaf.name}Part`,
				part: leaf.name,
				contentType: option(element(PART_TYPES))(source),
				headers: array(partHeader, { min: 0, max: 1 })(source)
			})
		)
	}
}

/** A part's flag: its name with underscores as dashes, a nested member's after its part's and a dot. */
const flagOf = (path: ReadonlyArray<string>): string =>
	Arr.join(Arr.map(path, Str.replaceAll("_", "-")), ".")

/** A part kind's schema. */
const schemaOf = (kind: PartKind): Schema.Top => {
	switch (kind) {
		case "text":
			return Schema.String
		case "code":
			return Schema.String.check(Schema.isPattern(threeLetters))
		case "count":
			return Schema.Int
		case "choice":
			return Schema.Literals(["skip", "upsert"])
		case "tags":
			return Schema.Array(Schema.String)
		case "file":
			return Schema.String.check(Schema.isMinLength(1))
		case "meta":
			return Schema.Struct({
				big: Schema.Finite,
				name: Schema.String,
				tags: Schema.Array(Schema.Unknown)
			})
		case "pages":
			return Schema.Tuple([Schema.Struct({ id: Schema.Int })])
	}
}

const threeLetters = regex("^[A-Z]{3}$", "u")

/** A record of schemas, each optional or not. */
const structOf = (members: ReadonlyArray<readonly [string, Schema.Top, boolean]>): Schema.Top =>
	Schema.Struct(
		Rec.fromEntries(
			Arr.map(
				members,
				([name, schema, optional]) =>
					[name, optional ? Schema.optionalKey(schema) : schema] as const
			)
		)
	)

/** Whether a schema part is nested by name. */
const isNestedPart = (part: AssertPart): part is Extract<AssertPart, { kind: "nested" }> =>
	part.kind === "nested"

/** A form's body schema and options, as the emitted handler states them. */
export const assertOptions = (form: AssertCase): Serialize.FormSchemaOptions => {
	const nested = Arr.filter(form.parts, isNestedPart)
	return {
		flags: Rec.fromEntries(
			Arr.map(
				form.parts,
				(part) =>
					[
						part.name,
						part.kind === "nested"
							? flagOf([
									part.name,
									Option.getOrElse(
										Option.map(Arr.head(part.members), (member) => member.name),
										() => ""
									)
								])
							: flagOf([part.name])
					] as const
			)
		),
		repeated: Arr.map(
			Arr.filter(form.parts, (part) => part.kind !== "nested" && repeats(part.kind)),
			(part) => part.name
		),
		nested: Rec.fromEntries(
			Arr.map(
				nested,
				(part) =>
					[
						part.name,
						{
							flags: Rec.fromEntries(
								Arr.map(
									part.members,
									(member) => [member.name, flagOf([part.name, member.name])] as const
								)
							),
							repeated: Arr.map(
								Arr.filter(part.members, (member) => repeats(member.kind)),
								(member) => member.name
							)
						}
					] as const
			)
		),
		required: form.required,
		schema: structOf(
			Arr.map(
				form.parts,
				(part) =>
					[
						part.name,
						part.kind === "nested"
							? structOf(
									Arr.map(
										part.members,
										(member) => [member.name, schemaOf(member.kind), member.optional] as const
									)
								)
							: schemaOf(part.kind),
						part.optional
					] as const
			)
		)
	}
}

/** A form's fields as the handler hands them to the assertion: each leaf's values, a nested part's members' as one value. */
export const assertFields = (form: AssertCase): Serialize.FormFields =>
	Rec.fromEntries(
		Arr.map(
			form.parts,
			(part) =>
				[
					part.name,
					part.kind === "nested"
						? Serialize.nestedValues(
								Rec.fromEntries(
									Arr.map(
										part.members,
										(member) => [member.name, Arr.map(member.values, formValueOf)] as const
									)
								)
							)
						: Arr.map(part.values, formValueOf)
				] as const
		)
	)

/** A value as the body schema reads it: a file present (its content never read), a digit text as its number, JSON as parsed. */
type Asserted = Readonly<{ file: boolean; value: unknown }>

const assertedOf = (value: LeafValue): Asserted => {
	switch (value.kind) {
		case "file":
			return { file: true, value: "" }
		case "digits":
			return { file: false, value: Number(value.text) }
		case "json":
			return { file: false, value: value.value }
		case "text":
		case "number":
		case "boolean":
			return { file: false, value: value.value }
	}
}

/** Whether a value is a string. */
const isText = (value: unknown): value is string => typeof value === "string"

/** Whether a read value satisfies its kind (a whole number a safe integer, a JSON record's digit text any number). */
const satisfies = (kind: PartKind, value: unknown): boolean => {
	switch (kind) {
		case "text":
			return isText(value)
		case "code":
			return isText(value) && threeLetters.test(value)
		case "count":
			return Number.isSafeInteger(value)
		case "choice":
			return value === "skip" || value === "upsert"
		case "tags":
			return Arr.isArray(value) && Arr.every(value, isText)
		case "file":
			return isText(value) && value.length > 0
		case "meta":
			return (
				Predicate.isObject(value) &&
				Predicate.hasProperty(value, "big") &&
				(value.big instanceof JsonNumber || typeof value.big === "number") &&
				Predicate.hasProperty(value, "name") &&
				isText(value.name) &&
				Predicate.hasProperty(value, "tags") &&
				Arr.isArray(value.tags)
			)
		case "pages":
			return Arr.isArray(value) && value.length === 1 && Predicate.isObject(value[0])
	}
}

/** A leaf's failure as the assertion counts it: none when it passes or when its values hold a file (presence only), else its slot and whether it was given. */
const leafFailure = (
	leaf: AssertLeaf,
	path: ReadonlyArray<string>
): Option.Option<readonly [ReadonlyArray<string>, boolean]> => {
	if (leaf.values.length === 0) {
		return leaf.optional ? Option.none() : Option.some([path, false] as const)
	}
	const read = Arr.map(leaf.values, assertedOf)
	if (Arr.some(read, (one) => one.file)) {
		return Option.none()
	}
	const value = repeats(leaf.kind)
		? Arr.map(read, (one) => one.value)
		: Option.getOrUndefined(Option.map(Arr.head(read), (one) => one.value))
	return satisfies(leaf.kind, value) ? Option.none() : Option.some([path, true] as const)
}

/** The assertion's verdict: the fields pass unchanged, or a UsageError names a flag and says why. */
export type Verdict =
	| Readonly<{ kind: "passed" }>
	| Readonly<{ kind: "refused"; flag: string; message: string }>

/**
 * The form assertion (design 4.5, C2, 6.3, HT:B16): an optional body given nothing is not asserted; otherwise each
 * part, in declared order and a nested part's members before it, fails when required and not given, or given and not
 * matching its schema, but never for holding a file, asserted for presence only; the first failing part's flag is
 * named (a nested part's own flag its first member's), saying the request needs it when it was not given and that it
 * does not match otherwise.
 */
export const assertModel = (form: AssertCase): Verdict => {
	const given = (part: AssertPart): boolean =>
		part.kind === "nested"
			? Arr.some(part.members, (member) => member.values.length > 0)
			: part.values.length > 0
	if (!form.required && !Arr.some(form.parts, given)) {
		return { kind: "passed" }
	}
	const failures = Arr.flatMap(
		form.parts,
		(part): ReadonlyArray<readonly [ReadonlyArray<string>, boolean]> => {
			if (part.kind !== "nested") {
				return Option.toArray(leafFailure(part, [part.name]))
			}
			if (!given(part)) {
				return part.optional
					? []
					: [
							[
								[
									part.name,
									...Option.toArray(Option.map(Arr.head(part.members), (member) => member.name))
								],
								false
							] as const
						]
			}
			return Arr.flatMap(part.members, (member) =>
				Option.toArray(leafFailure(member, [part.name, member.name]))
			)
		}
	)
	return Option.match(Arr.head(failures), {
		onNone: (): Verdict => ({ kind: "passed" }),
		onSome: ([path, sent]): Verdict => {
			const flag = flagOf(path)
			return {
				kind: "refused",
				flag,
				message: sent
					? `--${flag}: does not match the request body schema`
					: `--${flag}: this request needs it`
			}
		}
	})
}

/** The situations a form assertion reaches. */
export type AssertFeature =
	| "valid form passed"
	| "file part passed for presence only"
	| "digit text asserted as its number"
	| "JSON part asserted as parsed"
	| "repeated part asserted whole"
	| "optional body given nothing passed"
	| "required part missing refused"
	| "value not matching refused"
	| "nested member refused by its flag"
	| "nested part passed"
	| "keyed part moved"
	| "keyed part with no value left out"

/** What a form assertion's case reaches. */
export const assertFeatures = (form: AssertCase): ReadonlyArray<AssertFeature> => {
	const verdict = assertModel(form)
	const passed = verdict.kind === "passed"
	const leaves = Arr.flatMap(form.parts, (part): ReadonlyArray<AssertLeaf> =>
		part.kind === "nested" ? part.members : [part]
	)
	const given = Arr.filter(leaves, (leaf) => leaf.values.length > 0)
	const fields = assertFields(form)
	return holding<AssertFeature>([
		["valid form passed", passed && given.length > 1],
		[
			"file part passed for presence only",
			passed &&
				Arr.some(
					given,
					(leaf) =>
						(leaf.kind === "file" || leaf.kind === "pages") &&
						Arr.some(leaf.values, (value) => value.kind === "file")
				)
		],
		[
			"digit text asserted as its number",
			Arr.some(
				given,
				(leaf) => leaf.kind === "count" && Arr.some(leaf.values, (value) => value.kind === "digits")
			)
		],
		["JSON part asserted as parsed", Arr.some(given, (leaf) => leaf.kind === "meta")],
		[
			"repeated part asserted whole",
			passed && Arr.some(given, (leaf) => leaf.kind === "tags" && leaf.values.length > 1)
		],
		[
			"optional body given nothing passed",
			passed && !form.required && given.length === 0 && form.parts.length > 0
		],
		[
			"required part missing refused",
			verdict.kind === "refused" && Str.endsWith("needs it")(verdict.message)
		],
		[
			"value not matching refused",
			verdict.kind === "refused" && Str.endsWith("schema")(verdict.message)
		],
		[
			"nested member refused by its flag",
			verdict.kind === "refused" && Str.includes(".")(verdict.flag)
		],
		[
			"nested part passed",
			passed &&
				Arr.some(
					form.parts,
					(part) =>
						part.kind === "nested" && Arr.some(part.members, (member) => member.values.length > 0)
				)
		],
		[
			"keyed part moved",
			Arr.some(form.choices, (choice) =>
				Option.exists(Rec.get(fields, choice.part), Arr.isReadonlyArrayNonEmpty)
			)
		],
		[
			"keyed part with no value left out",
			Arr.some(
				form.choices,
				(choice) => !Option.exists(Rec.get(fields, choice.part), Arr.isReadonlyArrayNonEmpty)
			)
		]
	])
}

/** A form assertion, aimed at a repeated part of several valid items, which a plain draw reaches rarely. */
export const assertSpace = aimed<AssertCase, AssertFeature>(assertDrawn, [
	[
		"repeated part asserted whole",
		(source) => ({
			parts: [
				{
					kind: "tags",
					name: "tags",
					optional: boolean(source),
					values: array(
						map(text, (value): LeafValue => ({ kind: "text", value })),
						{ min: 2, max: 3 }
					)(source)
				}
			],
			required: boolean(source),
			choices: []
		})
	]
])
