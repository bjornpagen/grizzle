import type { Json } from "@bjornpagen/grizzle-text/utf8"
import { Array as Arr, Effect, Option, Order, Predicate, Record, String as Str } from "effect"
import type { AuthorConfig } from "#model/author-config.ts"
import type { DocumentUri } from "#model/brands.ts"
import { sortDiagnostics } from "#model/diagnostic.ts"
import type { Diagnostic } from "#model/diagnostic.ts"
import type { Api, Docs, Tag } from "#model/entities.ts"
import { isArray, isObject } from "#model/json-tree.ts"
import type { JsonObject } from "#model/json-tree.ts"
import { rootPointer } from "#model/pointer.ts"
import { declaredOpenapi } from "#model/spec-section.ts"
import { docsOf } from "#normalize/docs.ts"
import { collectInformational } from "#normalize/informational.ts"
import { assembleOperations, distinctDiagnostics } from "#normalize/operations.ts"
import type { OperationsError } from "#normalize/operations.ts"
import { normalizeSchemas } from "#normalize/schemas.ts"
import type { SchemaImportDefect } from "#normalize/schemas.ts"
import { normalizeSecurityPolicy, normalizeSecuritySchemes } from "#normalize/security.ts"
import { effectiveServers } from "#normalize/servers.ts"
import type { ServersContext } from "#normalize/servers.ts"
import type { Resolution } from "#resolve/index.ts"

/**
 * What normalization needs besides the resolution: the author config, the document it came from,
 * and the findings the spec-text check stage raised for this run (`checkSpecText`).
 */
export interface NormalizeContext {
	readonly checkFindings: readonly Diagnostic[]
	readonly config: AuthorConfig
	readonly configDocument: DocumentUri
}

/**
 * The normalized `Api` and every diagnostic its stages raised, in document order (design 3.7).
 */
export interface Normalization {
	readonly api: Api
	readonly diagnostics: readonly Diagnostic[]
}

export type NormalizeError = OperationsError | SchemaImportDefect

/** An object's member `name` when it holds a string. */
const textOf = (object: JsonObject, name: string): Option.Option<string> =>
	Option.filter(Record.get(object, name), Predicate.isString)

/** The help text an Info or Tag Object gives: each of `description` and `summary` it holds as a string, made safe. */
const objectDocsOf = (object: JsonObject): Docs =>
	docsOf(
		Option.getOrUndefined(textOf(object, "description")),
		Option.getOrUndefined(textOf(object, "summary"))
	)

/** A Tag Object of the root's `tags`, none when it is no object or names no tag. */
const tagOf = (entry: Json): readonly Tag[] => {
	if (!isObject(entry)) {
		return []
	}

	return Option.match(Option.filter(textOf(entry, "name"), Str.isNonEmpty), {
		onNone: () => [],
		onSome: (name) => {
			const described =
				Option.isSome(textOf(entry, "description")) || Option.isSome(textOf(entry, "summary"))
			const kind = textOf(entry, "kind")
			const parent = textOf(entry, "parent")

			return [
				{
					...(described ? { docs: objectDocsOf(entry) } : {}),
					...(Option.isSome(kind) ? { kind: kind.value } : {}),
					name,
					...(Option.isSome(parent) ? { parent: parent.value } : {})
				}
			]
		}
	})
}

/** The stored definitions by their `$defs` key, in key order. */
const storeOf = (definitions: ReadonlyMap<string, Json>): JsonObject =>
	Record.fromEntries(
		Arr.sort(
			Arr.fromIterable(definitions),
			Order.mapInput(Order.String, ([key]: readonly [string, Json]) => key)
		)
	)

/**
 * Builds the `Api` from the resolved entry document (design 2.2, 3.5): the document's info and
 * tags, its root servers, security schemes and schema store, the informational elements, and the
 * operations of `assembleOperations`. The diagnostics are those of every normalization stage, with
 * repeats dropped, in the order of design 3.7: document, then pointer token by token, then code.
 * Earlier stages (validation, resolution, spec-text checks) report their own.
 */
export const normalize = Effect.fn("normalize.normalize")(function* normalize(
	resolution: Resolution,
	context: NormalizeContext
): Effect.fn.Return<Normalization, NormalizeError> {
	const root = Option.liftPredicate(resolution.value, isObject)
	const openapi = Option.getOrElse(declaredOpenapi(resolution.value), () => resolution.line)
	const member = (name: string): Option.Option<Json> =>
		Option.flatMap(root, (fields) => Record.get(fields, name))
	const servers: ServersContext = {
		config: context.config,
		configDocument: context.configDocument,
		document: resolution.document,
		line: resolution.line,
		openapi
	}
	const schemes = yield* normalizeSecuritySchemes(
		resolution,
		{ config: context.config, configDocument: context.configDocument },
		context.checkFindings
	)
	const schemas = yield* normalizeSchemas(resolution)
	const assembly = yield* assembleOperations(resolution, schemes, servers, context.checkFindings)
	const policy = yield* normalizeSecurityPolicy(resolution, schemes, Option.none())
	const rootServers = effectiveServers(
		{
			root: {
				tokens: ["servers"],
				value: member("servers")
			}
		},
		servers
	)
	const informational = yield* collectInformational(resolution)
	const api: Api = {
		documents: Arr.fromIterable(resolution.documents.keys()),
		entry: resolution.document,
		info: Option.match(Option.filter(member("info"), isObject), {
			onNone: () => ({}),
			onSome: objectDocsOf
		}),
		informational,
		line: resolution.line,
		openapi,
		operations: assembly.operations,
		origin: { document: resolution.document, pointer: rootPointer },
		rows: ["DOC-01", "DOC-02", "DOC-04"],
		schemas: {
			defs: storeOf(schemas.definitions),
			origin: { document: resolution.document, pointer: rootPointer },
			rows: ["SCO-01"]
		},
		securitySchemes: schemes.schemes,
		servers: rootServers.servers,
		tags: Option.match(Option.filter(member("tags"), isArray), {
			onNone: () => [],
			onSome: (tags) => Arr.flatMap(tags, tagOf)
		})
	}

	return {
		api,
		diagnostics: sortDiagnostics(
			[resolution.document],
			distinctDiagnostics([
				...schemes.diagnostics,
				...schemas.diagnostics,
				...policy.diagnostics,
				...rootServers.diagnostics,
				...assembly.diagnostics
			])
		)
	}
})
