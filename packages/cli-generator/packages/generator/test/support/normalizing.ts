import { constant, type Gen, oneOf } from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, Effect, Order, Schema, String as Str } from "effect"
import { AuthorConfig } from "#model/author-config.ts"
import { DocumentUri } from "#model/brands.ts"
import type { Json } from "#model/pointer.ts"
import type { SpecLine } from "#model/spec-section.ts"
import { normalize } from "#normalize/index.ts"
import { type Resolution, resolve, type ResolveMember } from "#resolve/index.ts"

/** The URI of the entry document every normalize property resolves: the spec a generation reads. */
export const entryText = "file:///spec/openapi.json"

/** The URI of the author config's document, which a config diagnostic names. */
export const configText = "file:///spec/author.json"

/** The entry document's URI, decoded. */
export const entryUri = Schema.decodeEffect(DocumentUri)(entryText)

/** The author config document's URI, decoded. */
export const configUri = Schema.decodeEffect(DocumentUri)(configText)

/** The `openapi` value a drawn document of each line declares. */
export const openapiOf: Readonly<Record<SpecLine, string>> = {
	"3.0": "3.0.3",
	"3.1": "3.1.1",
	"3.2": "3.2.0"
}

/** An OpenAPI line, each as likely as the others. */
export const lineGen: Gen<SpecLine> = oneOf([
	constant<SpecLine>("3.0"),
	constant<SpecLine>("3.1"),
	constant<SpecLine>("3.2")
])

/** An author config with nothing but its names, and with `extra` beside them. */
export const authorConfigOf = (extra: Readonly<Record<string, Json>>) =>
	Schema.decodeEffect(AuthorConfig)({
		binName: "example",
		package: { name: "example-cli", version: "1.0.0" },
		...extra
	})

/** The document of `line` holding `members` beside its info and its declared version. */
export const documentAt = (line: SpecLine, members: Readonly<Record<string, Json>>): Json => ({
	info: { title: "t", version: "1" },
	openapi: openapiOf[line],
	...members
})

/** The document set of `value` on `line`, entry first, then `members`. */
export const resolvedAt = (line: SpecLine, value: Json, members: ReadonlyArray<ResolveMember>) =>
	Effect.flatMap(entryUri, (document) =>
		resolve({ document, line, members: Arr.fromIterable(members), value })
	)

/** `value` on `line`, resolved and normalized under the author config `extra` makes, as generation's normalize reads it. */
export const normalizedAt = (line: SpecLine, value: Json, extra: Readonly<Record<string, Json>>) =>
	Effect.gen(function* () {
		const resolution: Resolution = yield* resolvedAt(line, value, [])
		const config = yield* authorConfigOf(extra)
		const configDocument = yield* configUri
		return yield* normalize(resolution, { checkFindings: [], config, configDocument })
	})

/** A JSON Pointer token, `~` and `/` escaped. */
export const token = (name: string): string =>
	Str.replaceAll("/", "~1")(Str.replaceAll("~", "~0")(name))

/** A JSON value that is no boolean: a number, a string, null, an object or an array. */
export const nonBoolean: Gen<Json> = oneOf([
	constant<Json>(1),
	constant<Json>("true"),
	constant<Json>(null),
	constant<Json>({ value: true }),
	constant<Json>([true])
])

/** A JSON Pointer token that is an array index. */
const arrayIndex = regex("^(?:0|[1-9][0-9]*)$", "u")

/** Pointers in document order (design 3.7): token by token, array indices numerically, every other token as a string. */
export const pointerOrder: Order.Order<string> = Order.mapInput(
	Order.Array(
		Order.make<string>((left, right) =>
			arrayIndex.test(left) && arrayIndex.test(right)
				? Order.Number(Number(left), Number(right))
				: Order.String(left, right)
		)
	),
	(pointer: string) => Arr.drop(Str.split(pointer, "/"), 1)
)
