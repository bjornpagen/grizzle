/**
 * Alias cycles in a request body (DOC-23): a body schema that reaches a cycle of references returning to a schema
 * without descending into the instance is refused at the cycle, once per schema on it, and planned as an opaque body,
 * never a defect; the same chain left open still resolves to its object. The space is every chain of one to four
 * component schemas, each link a bare `$ref` or a one-member `allOf`, `anyOf` or `oneOf`, either closed back onto its
 * first schema or ended in an object of one required string, reached by the request body directly or through one
 * property. Each case runs the pipeline in process: resolve, normalize and the names plan.
 *
 * Oracle (specification: DOC-23 and design 4.5's body flags): a closed chain gives one DOC-23/alias-cycle refusal at
 * each of its links and no field flag below the cycle, so a direct body has only `--body` and `--body-file`, and a
 * property reaching it is one JSON flag; an open chain gives no DOC-23, and where every link is `$ref` or `allOf` the
 * object's `name` is a string flag (`name`, or `inner.name` through the property), while an `anyOf` or `oneOf` link
 * leaves the body opaque as any union does.
 *
 * Features: a cycle of one schema, of two, of three or more; a cycle through each applicator; an open chain of each
 * kind; a body pointing straight into a cycle and one reaching it through a property.
 *
 * Plants: normalize/schemas.ts normalizeSchemas handing the converted store, cycle and all, to names (the store left
 * cyclic, as before the store refused alias cycles): every closed case dies with UnresolvedBodyRef.
 */
import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { element } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { testWorkers } from "@bjornpagen/testing/workers"
import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, Order, Record, Schema } from "effect"
import { AuthorConfig } from "#model/author-config.ts"
import { DocumentUri } from "#model/brands.ts"
import type { Json } from "#model/pointer.ts"
import { planNames } from "#names/index.ts"
import { normalize } from "#normalize/index.ts"
import { resolve } from "#resolve/index.ts"

/** How one schema of the chain reaches the next. */
type Link = "$ref" | "allOf" | "anyOf" | "oneOf"

/** One case: the chain's links in order, whether its last link returns to its first schema, and how the body reaches it. */
type ChainCase = Readonly<{
	links: Arr.NonEmptyReadonlyArray<Link>
	closed: boolean
	entry: "direct" | "property"
}>

type ChainFeature =
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

const links: Arr.NonEmptyReadonlyArray<Link> = ["$ref", "allOf", "anyOf", "oneOf"]

/** The link at place `at` of the chain numbered `index`, its places read as digits in base `links.length`. */
const linkAt = (index: number, at: number): Link =>
	links[Math.floor(index / links.length ** at) % links.length] ?? "$ref"

/** The chain numbered `index` of `length` links. */
const chainAt = (index: number, length: number): Arr.NonEmptyReadonlyArray<Link> =>
	Arr.prepend(
		Array.from({ length: length - 1 }, (_, at) => linkAt(index, at + 1)),
		linkAt(index, 0)
	)

/** Every chain of `length` links, numbered from the chain of `$ref` links alone. */
const chainsOf = (length: number): Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<Link>> =>
	Arr.prepend(
		Array.from({ length: links.length ** length - 1 }, (_, index) => chainAt(index + 1, length)),
		chainAt(0, length)
	)

const lengths: Arr.NonEmptyReadonlyArray<number> = [1, 2, 3, 4]

const closings: Arr.NonEmptyReadonlyArray<boolean> = [true, false]

const entries: Arr.NonEmptyReadonlyArray<ChainCase["entry"]> = ["direct", "property"]

const cases: Arr.NonEmptyReadonlyArray<ChainCase> = Arr.flatMap(lengths, (length) =>
	Arr.flatMap(chainsOf(length), (chain) =>
		Arr.flatMap(closings, (closed) =>
			Arr.map(entries, (entry): ChainCase => ({ closed, entry, links: chain }))
		)
	)
)

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

const plannedOf = (chain: ChainCase) =>
	Effect.gen(function* planned() {
		const document = yield* Schema.decodeEffect(DocumentUri)("file:///spec/openapi.json")
		const configDocument = yield* Schema.decodeEffect(DocumentUri)(
			"file:///spec/author-config.json"
		)
		const config = yield* Schema.decodeEffect(AuthorConfig)({
			binName: "chains",
			envPrefix: "CHAINS",
			package: { name: "chains-cli", version: "0.1.0" }
		})
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
const expectedOf = (chain: ChainCase): Planned => {
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

const featuresOf = (chain: ChainCase): readonly ChainFeature[] => {
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

describe("a request body that reaches an alias cycle", () => {
	it.effect(
		"is refused at the cycle and planned as opaque, and an open chain still resolves",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "names/alias-cycles",
						oracle: {
							kind: "specification",
							name: "DOC-23 at every link of a closed chain and an opaque body; an open chain's object flattened"
						},
						box: "every chain of one to four schemas, each link a $ref or a one-member allOf, anyOf or oneOf, closed or ended in an object, reached directly or through a property",
						concurrency: testWorkers,
						generator: element(cases),
						literal: Formatter.format,
						coverage: requiredInSpace<ChainFeature>([
							"a cycle of one schema",
							"a cycle of two schemas",
							"a cycle of three or more",
							"a cycle through allOf",
							"a cycle through anyOf",
							"a cycle through oneOf",
							"an open chain that resolves",
							"an open chain through a union",
							"a body pointing straight into a cycle",
							"a body reaching a cycle through a property"
						]),
						caseHang: Duration.seconds(30)
					},
					(chain, k) =>
						Effect.gen(function* () {
							k.noteAll(featuresOf(chain))
							const planned = yield* plannedOf(chain)
							deepStrictEqual(planned, expectedOf(chain))
						})
				)
			)
	)
})
