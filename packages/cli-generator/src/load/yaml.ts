import { Array as Arr, Effect, Option, Predicate, Record, Schema } from "effect"
import { isAlias, isScalar, isSeq, LineCounter, parseAllDocuments } from "yaml"
import type {
	Alias,
	Document as YamlDocument,
	ParsedNode,
	Scalar,
	YAMLError,
	YAMLMap,
	YAMLSeq
} from "yaml"
import { byteOffset } from "#load/offset.ts"
import { refuse, wholeInput } from "#load/read.ts"
import type { LoadCode, LoadRefusal, Position } from "#load/read.ts"
import type { DocumentUri } from "#model/brands.ts"
import { formatPointer } from "#model/pointer.ts"
import type { Json } from "#model/pointer.ts"

interface Failure {
	readonly code: LoadCode
	/**
	 * Character index into the decoded text, when the failure has a place.
	 */
	readonly index?: number
	readonly pointer: string
}

/**
 * The one throwing seam: `yaml`'s parser, which can throw on pathological input (design 13.1 R7).
 */
class YamlParserFault extends Schema.TaggedError<
	YamlParserFault,
	{ readonly brand: unique symbol }
>()("YamlParserFault", {
	cause: Schema.Defect()
}) {}

const jsonTags: ReadonlySet<string> = new Set(
	Arr.map(
		["bool", "float", "int", "map", "null", "seq", "str"],
		(name) => `tag:yaml.org,2002:${name}`
	)
)

const isJsonScalar = Schema.is(Schema.Union([Schema.String, Schema.Boolean, Schema.Null]))

const isFinite = Schema.is(Schema.Finite)

const isString = Schema.is(Schema.String)

interface Walk {
	readonly active: Set<object>
	readonly doc: YamlDocument.Parsed
	readonly memo: Map<object, Json>
	readonly path: string[]
	failure: Failure | undefined
}

const fail = (walk: Walk, code: LoadCode, node: ParsedNode | null): void => {
	const index = node?.range[0]
	const pointer = formatPointer(walk.path)

	walk.failure ??= index === undefined ? { code, pointer } : { code, index, pointer }
}

const hasJsonTag = (tag: string | undefined): boolean => tag === undefined || jsonTags.has(tag)

const scalarOf = (walk: Walk, node: Scalar.Parsed): Json => {
	const { value } = node

	if (!hasJsonTag(node.tag)) {
		fail(walk, "DOC-14/yaml-non-json-tag", node)
	} else if (Predicate.isNumber(value) && !isFinite(value)) {
		fail(walk, "DOC-14/yaml-non-finite", node)
	} else if (Predicate.isNumber(value) || isJsonScalar(value)) {
		return value
	} else {
		fail(walk, "DOC-14/yaml-non-json-tag", node)
	}

	return null
}

const keyOf = (walk: Walk, key: ParsedNode | null): string => {
	if (isScalar(key) && isString(key.value)) {
		return key.value
	}

	fail(walk, "DOC-14/yaml-non-string-key", key)

	return ""
}

const aliasOf = (walk: Walk, node: Alias.Parsed): Json => {
	const target = node.resolve(walk.doc)
	const built = target === undefined ? undefined : walk.memo.get(target)

	if (target !== undefined && walk.active.has(target)) {
		fail(walk, "DOC-14/yaml-alias-cycle", node)
	} else if (built === undefined) {
		fail(walk, "DOC-14/invalid-yaml", node)
	} else {
		return built
	}

	return null
}

type Child = (node: ParsedNode | null) => Json

const buildSeq = (walk: Walk, node: YAMLSeq.Parsed, child: Child): Json => {
	const items: Json[] = []

	for (const [index, item] of node.items.entries()) {
		walk.path.push(String(index))
		items.push(child(item))
		walk.path.pop()

		if (walk.failure !== undefined) {
			break
		}
	}

	return items
}

const buildMap = (walk: Walk, node: YAMLMap.Parsed, child: Child): Json => {
	const entries: [string, Json][] = []

	for (const pair of node.items) {
		const key = keyOf(walk, pair.key)

		walk.path.push(key)
		entries.push([key, child(pair.value)])
		walk.path.pop()

		if (walk.failure !== undefined) {
			break
		}
	}

	return Record.fromEntries(entries)
}

const buildCollection = (walk: Walk, node: YAMLMap.Parsed | YAMLSeq.Parsed, child: Child): Json => {
	if (!hasJsonTag(node.tag)) {
		fail(walk, "DOC-14/yaml-non-json-tag", node)

		return null
	}

	return isSeq(node) ? buildSeq(walk, node, child) : buildMap(walk, node, child)
}

/**
 * Builds the JSON value of one node. Anchored nodes are memoized by identity, so an alias shares its target's value
 * and is never walked again (design 3.1): an alias bomb is as many references to one value, never as many copies.
 */
const build = (walk: Walk, node: ParsedNode | null): Json => {
	if (isAlias(node)) {
		return aliasOf(walk, node)
	}

	if (node === null || walk.failure !== undefined) {
		return null
	}

	const anchored = node.anchor !== undefined

	if (anchored) {
		walk.active.add(node)
	}

	const child: Child = (next) => build(walk, next)
	const built = isScalar(node) ? scalarOf(walk, node) : buildCollection(walk, node, child)

	if (anchored) {
		walk.active.delete(node)
		walk.memo.set(node, built)
	}

	return built
}

const errorCodes: ReadonlyMap<string, LoadCode> = new Map([
	["DUPLICATE_KEY", "DOC-14/duplicate-key"],
	["NON_STRING_KEY", "DOC-14/yaml-non-string-key"],
	["TAG_RESOLVE_FAILED", "DOC-14/yaml-non-json-tag"]
])

const failureOf = (error: YAMLError): Failure => ({
	code: errorCodes.get(error.code) ?? "DOC-14/invalid-yaml",
	index: error.pos[0],
	pointer: ""
})

type Outcome = { readonly failure: Failure } | { readonly value: Json }

const interpret = (documents: readonly YamlDocument.Parsed[]): Outcome => {
	for (const doc of documents) {
		const problem = doc.errors[0] ?? doc.warnings[0]

		if (problem !== undefined) {
			return { failure: failureOf(problem) }
		}
	}

	const [first, second] = documents

	if (first === undefined) {
		return { failure: { code: "DOC-14/invalid-yaml", pointer: "" } }
	}

	if (second !== undefined) {
		return {
			failure: { code: "DOC-14/yaml-multi-document", index: second.range[0], pointer: "" }
		}
	}

	const walk: Walk = {
		active: new Set(),
		doc: first,
		failure: undefined,
		memo: new Map(),
		path: []
	}
	const value = build(walk, first.contents)

	return walk.failure === undefined ? { value } : { failure: walk.failure }
}

const locate = (
	text: string,
	lineCounter: LineCounter,
	index: number,
	byteBase: number
): Position => {
	const { col, line } = lineCounter.linePos(index)

	return {
		column: col,
		line,
		offset: byteOffset(text, index, byteBase)
	}
}

/**
 * Strict YAML 1.2 (design 3.1): `yaml`'s core schema with unique, string keys and no merge, then a
 * walk that builds the JSON value and refuses what the parser accepts but JSON cannot hold.
 * `byteBase` is the number of bytes before `text` (a byte order mark), so offsets are input
 * offsets.
 */
export const parseStrictYaml = (
	text: string,
	document: DocumentUri,
	byteBase: number
): Effect.Effect<Json, LoadRefusal> => {
	const lineCounter = new LineCounter()

	return Effect.try({
		catch: (cause) => YamlParserFault.make({ cause }),
		try: () =>
			parseAllDocuments(text, {
				lineCounter,
				merge: false,
				schema: "core",
				stringKeys: true,
				uniqueKeys: true,
				version: "1.2"
			})
	}).pipe(
		Effect.matchEffect({
			onFailure: () => refuse(document, "DOC-14/invalid-yaml", wholeInput),
			onSuccess: (documents) => {
				const outcome = interpret(documents)

				if ("value" in outcome) {
					return Effect.succeed(outcome.value)
				}

				const { code, index, pointer } = outcome.failure

				return refuse(document, code, {
					pointer,
					position: Option.map(Option.fromUndefinedOr(index), (at) =>
						locate(text, lineCounter, at, byteBase)
					)
				})
			}
		})
	)
}
