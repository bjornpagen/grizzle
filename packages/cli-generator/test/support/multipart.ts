import { regex } from "arkregex"
import { Array as Arr, Option, String as Str } from "effect"
import type { Header, HeaderList } from "#test/support/http.ts"

/**
 * A multipart part as the suites' reference reader reads it: the name and file name its Content-Disposition gives,
 * every other header line of its head, and its bytes.
 */
export type Part = Readonly<{
	name: string
	filename: Option.Option<string>
	headers: HeaderList
	body: Uint8Array
}>

const BOUNDARY = regex("^multipart/[a-z-]+; boundary=(.+)$", "u")

const DISPOSITION_NAME = regex('name="([^"]*)"', "u")

const DISPOSITION_FILE = regex('filename="([^"]*)"', "u")

/** The boundary a multipart Content-Type names, none for any other. */
export const boundaryOf = (contentType: string): Option.Option<string> =>
	Option.map(Option.fromNullishOr(BOUNDARY.exec(contentType)), ([, boundary]) => boundary)

/** A part head's line split at its first colon, the value without the whitespace around it. */
const headLine = (line: string): Header =>
	Option.match(Str.indexOf(":")(line), {
		onNone: () => [line, ""],
		onSome: (colon) => [Str.slice(0, colon)(line), Str.trim(Str.slice(colon + 1)(line))]
	})

/**
 * A multipart body's parts, read apart from any writer: the body split at each `--<boundary>` delimiter, each section
 * a head of CRLF-ended lines, a blank line, and the part's bytes before the CRLF that precedes the next delimiter. A
 * section with no Content-Disposition name is no part; the closing delimiter's section is none.
 */
export const partsOf = (body: Uint8Array, boundary: string): ReadonlyArray<Part> =>
	Arr.flatMap(
		Arr.drop(Str.split(`--${boundary}`)(Buffer.from(body).toString("latin1")), 1),
		(section) =>
			Option.match(Str.indexOf("\r\n\r\n")(section), {
				onNone: () => [],
				onSome: (headEnd) => {
					const lines = Arr.map(Str.split("\r\n")(Str.slice(2, headEnd)(section)), headLine)
					const disposition = Arr.findFirst(
						lines,
						([name]) => Str.toLowerCase(name) === "content-disposition"
					)
					return Option.match(
						Option.flatMap(disposition, ([, value]) =>
							Option.fromNullishOr(DISPOSITION_NAME.exec(value))
						),
						{
							onNone: (): ReadonlyArray<Part> => [],
							onSome: ([, name]): ReadonlyArray<Part> => [
								{
									name,
									filename: Option.flatMap(disposition, ([, value]) =>
										Option.map(
											Option.fromNullishOr(DISPOSITION_FILE.exec(value)),
											([, file]) => file
										)
									),
									headers: Arr.filter(
										lines,
										([header]) => Str.toLowerCase(header) !== "content-disposition"
									),
									body: Uint8Array.from(
										Buffer.from(Str.slice(headEnd + 4, section.length - 2)(section), "latin1")
									)
								}
							]
						}
					)
				}
			})
	)

/** The essence of a part's Content-Type, the media type before any parameter, none when it has no such line. */
export const partType = (part: Part): Option.Option<string> =>
	Option.map(
		Arr.findFirst(part.headers, ([name]) => Str.toLowerCase(name) === "content-type"),
		([, value]) => Str.trim(Arr.headNonEmpty(Str.split(";")(value)))
	)
