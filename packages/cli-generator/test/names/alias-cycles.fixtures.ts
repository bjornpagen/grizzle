/**
 * What the property of alias-cycles.test.ts reads: chains of component schemas, the document each describes, the
 * pipeline's answer for it (resolve, normalize and the names plan, in process) and the specification's.
 */

import type { Json } from "@bjornpagen/grizzle-text/utf8"
import { word } from "@bjornpagen/testing/dictionary"
import { boolean, finite, type FiniteSpace, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Order, Record } from "effect"
import { decodeAuthorConfig } from "#model/author-config.ts"
import { fixedDocumentUri } from "#model/brands.ts"
import { planNames } from "#names/index.ts"
import { normalize } from "#normalize/index.ts"
import { resolve } from "#resolve/index.ts"
import { type Entry, entries, type Link, links } from "#test/names/alias-cycles.dictionary.ts"

/** One case: the chain's links in order, whether its last link returns to its first schema, and how the body reaches it. */
export type ChainCase = Readonly<{
	links: Arr.NonEmptyReadonlyArray<Link>
	closed: boolean
	entry: Entry
}>

export type ChainFeature =
	| "a cycle of one schema"
	| "a cycle of two schemas"
	| "a cycle of three or more"
	| "a cycle through allOf"
	| "a cycle through anyOf"
	| "a cycle through oneOf"
	| "an open chain that resolves"
	| "an open chain through a union"
	| "a body pointing straight into a cycle"
	| "a body reaching a cycle through a property"

const schemaName = (at: number): string => `S${String(at)}`

const refTo = (at: number): Json => ({ $ref: `#/components/schemas/${schemaName(at)}` })

/** A link to the schema at `to`, as `link` writes it. */
const linkTo = (link: Link, to: number): Json =>
	link === "$ref" ? refTo(to) : { [link]: [refTo(to)] }

/** The object an open chain ends in. */
const leaf: Json = {
	properties: { name: { type: "string" } },
	required: ["name"],
	type: "object"
}

const documentOf = (chain: ChainCase): Json => {
	const last = chain.links.length
	const schemas = Record.fromEntries([
		...Arr.map(chain.links, (link, at): readonly [string, Json] => [
			schemaName(at),
			linkTo(link, at + 1 === last && chain.closed ? 0 : at + 1)
		]),
		...(chain.closed ? [] : [[schemaName(last), leaf] as const])
	])
	const body: Json =
		chain.entry === "direct" ? refTo(0) : { properties: { inner: refTo(0) }, type: "object" }

	return {
		components: { schemas },
		info: { title: "alias cycles", version: "1" },
		openapi: "3.1.1",
		paths: {
			"/things": {
				post: {
					operationId: "postThing",
					requestBody: { content: { "application/json": { schema: body } }, required: true },
					responses: { "200": { description: "ok" } }
				}
			}
		}
	}
}

/** The pointer of a link's reference site, which the DOC-23 refusal names. */
const linkPointer = (link: Link, at: number): string =>
	link === "$ref"
		? `/components/schemas/${schemaName(at)}`
		: `/components/schemas/${schemaName(at)}/${link}/0`

/** What a case's pipeline gives: its DOC-23 refusals' pointers, sorted, and its command's flag names and kinds. */
interface Planned {
	readonly cycles: readonly string[]
	readonly flags: readonly string[]
}

export const plannedOf = (chain: ChainCase) =>
	Effect.gen(function* planned() {
		const document = fixedDocumentUri("file:///spec/openapi.json")
		const configDocument = fixedDocumentUri("file:///spec/author-config.json")
		const config = yield* decodeAuthorConfig(
			{
				binName: "chains",
				envPrefix: "CHAINS",
				package: { name: "chains-cli", version: "0.1.0" }
			},
			{ document: configDocument }
		)
		const resolution = yield* resolve({ document, line: "3.1", value: documentOf(chain) })
		const normalized = yield* normalize(resolution, { checkFindings: [], config, configDocument })
		const plan = yield* planNames(normalized.api, { config, configDocument, strict: false })
		const commands = [...plan.root, ...Arr.flatMap(plan.groups, (group) => group.commands)]
		const flags = Arr.flatMap(commands, (command) =>
			Arr.flatMap(command.flags, (flag) =>
				flag.source._tag === "Body" ? [`${flag.name}:${flag.source.kind}`] : []
			)
		)
		const cycles = Arr.flatMap([...normalized.diagnostics, ...plan.diagnostics], (diagnostic) =>
			diagnostic.code === "DOC-23/alias-cycle" ? [diagnostic.pointer] : []
		)
		const found: Planned = {
			cycles: Arr.sort(Arr.dedupe(cycles), Order.String),
			flags: Arr.sort(flags, Order.String)
		}

		return found
	})

const wholeBody: ReadonlyArray<string> = ["body-file:body-file", "body:body"]

/** The specification's answer for a case (see the module's header). */
export const expectedOf = (chain: ChainCase): Planned => {
	if (chain.closed) {
		return {
			cycles: Arr.sort(
				Arr.map(chain.links, (link, at) => linkPointer(link, at)),
				Order.String
			),
			flags:
				chain.entry === "direct" ? wholeBody : Arr.sort([...wholeBody, "inner:json"], Order.String)
		}
	}

	const resolves = Arr.every(chain.links, (link) => link === "$ref" || link === "allOf")
	const reached = chain.entry === "direct" ? "name:string" : "inner.name:string"
	const opaque = chain.entry === "direct" ? [] : ["inner:json"]

	return {
		cycles: [],
		flags: Arr.sort([...wholeBody, ...(resolves ? [reached] : opaque)], Order.String)
	}
}

export const featuresOf = (chain: ChainCase): readonly ChainFeature[] => {
	if (!chain.closed) {
		return Arr.every(chain.links, (link) => link === "$ref" || link === "allOf")
			? ["an open chain that resolves"]
			: ["an open chain through a union"]
	}

	const length = chain.links.length
	const sized: ChainFeature =
		length === 1
			? "a cycle of one schema"
			: length === 2
				? "a cycle of two schemas"
				: "a cycle of three or more"
	const through = Arr.flatMap(chain.links, (link): readonly ChainFeature[] =>
		link === "$ref" ? [] : [`a cycle through ${link}`]
	)

	return [
		sized,
		...through,
		chain.entry === "direct"
			? "a body pointing straight into a cycle"
			: "a body reaching a cycle through a property"
	]
}

/**
 * Every chain of one to four links, each link any applicator, closed back onto its first schema or ended in an object,
 * reached directly or through a property: 1,360 cases.
 */
export const chainSpace: FiniteSpace<ChainCase> = finite((s) => {
	const length = s.draw(int(1, 4))
	const first = s.draw(word(links))
	const rest = Array.from({ length: length - 1 }, () => s.draw(word(links)))
	return { links: [first, ...rest], closed: s.draw(boolean), entry: s.draw(word(entries)) }
})
