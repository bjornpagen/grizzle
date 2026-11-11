import {
	Array as Arr,
	Effect,
	Option,
	Order,
	Predicate,
	Record,
	Schema,
	String as Str
} from "effect"
import { DocumentUri } from "#model/brands.ts"
import { isObject, isArray } from "#model/json-tree.ts"
import { escapeToken, evaluatePointer } from "#model/pointer.ts"
import type { Json, PointerEvalError, PointerSyntaxError } from "#model/pointer.ts"
import { referenceAt } from "#resolve/index.ts"
import type { Resolution } from "#resolve/index.ts"

/** A use site: the document and the pointer an element is reached by. */
const Site = Schema.Struct({ document: DocumentUri, pointer: Schema.String })

/**
 * One request-affecting element at the outline level (design 8.3, R11), named by its use site: the
 * pointer is the path the element is reached by in the entry document, never the target of a
 * `$ref` it passes through.
 */
export const WalkElement = Schema.Union([
	Schema.Struct({
		...Site.fields,
		kind: Schema.Literal("operation"),
		method: Schema.String,
		path: Schema.String,
		/**
		 * The pointers, sorted, of the elements outside the operation that it takes: path-item
		 * parameters it does not override by `(name, in)`, the path item's servers or else the
		 * root's when it declares none, and the root security alternatives when it has no
		 * `security` key.
		 */
		inherits: Schema.Array(Schema.String),
		/**
		 * No level (operation, path item, root) has a `servers` key, so the default `/` applies.
		 */
		defaultServer: Schema.Boolean
	}),
	Schema.Struct({
		...Site.fields,
		kind: Schema.Literal("parameter"),
		in: Schema.String,
		name: Schema.String
	}),
	Schema.Struct({ ...Site.fields, kind: Schema.Literal("requestMedia"), mediaType: Schema.String }),
	Schema.Struct({ ...Site.fields, kind: Schema.Literal("response"), key: Schema.String }),
	Schema.Struct({
		...Site.fields,
		kind: Schema.Literal("securityAlternative"),
		schemes: Schema.Array(Schema.String)
	}),
	Schema.Struct({ ...Site.fields, kind: Schema.Literal("server"), url: Schema.String })
])

export type WalkElement = typeof WalkElement.Type

export type WalkError = PointerEvalError | PointerSyntaxError

/** A JSON value that may be absent: the member a node does not have. */
type Node = Option.Option<Json>

/** The own member `key` of an object value; any other value has none. */
const memberOf = (value: Json, key: string): Node =>
	isObject(value) ? Record.get(value, key) : Option.none()

const member = (node: Node, key: string): Node =>
	Option.flatMap(node, (value) => memberOf(value, key))

/** Own members in document order; a non-object has none. */
const entries = (node: Node): readonly (readonly [string, Json])[] =>
	Option.match(node, {
		onNone: () => [],
		onSome: (value) => (isObject(value) ? Record.toEntries(value) : [])
	})

const items = (node: Node): readonly Json[] =>
	Option.match(node, { onNone: () => [], onSome: (value) => (isArray(value) ? value : []) })

const text = (node: Node): Option.Option<string> => Option.filter(node, Predicate.isString)

/** Operation members of a path item (3.0 to 3.2). Callbacks and webhooks are not walked. */
const methods: ReadonlySet<string> = new Set([
	"delete",
	"get",
	"head",
	"options",
	"patch",
	"post",
	"put",
	"query",
	"trace"
])

const child = (pointer: string, ...tokens: readonly string[]): string =>
	`${pointer}${Arr.join(
		Arr.map(tokens, (token) => `/${escapeToken(token)}`),
		""
	)}`

const byPointer = Order.mapInput(Order.String, (element: WalkElement) => element.pointer)

type Parameter = Extract<WalkElement, { readonly kind: "parameter" }>

/** Header names compare case-insensitively (design 2.2); every other location exactly. */
const sameParameter = (left: Parameter, right: Parameter): boolean =>
	left.in === right.in &&
	(left.in === "header"
		? Str.toLowerCase(left.name) === Str.toLowerCase(right.name)
		: left.name === right.name)

const isParameter = (element: WalkElement): element is Parameter => element.kind === "parameter"

/**
 * What an operation may take from outside itself: its path item's parameters, and the servers and
 * security of the levels above it. `servers` is undefined when no level above has a `servers` key.
 */
interface Inheritance {
	readonly parameters: readonly Parameter[]
	readonly security: readonly WalkElement[]
	readonly servers: readonly WalkElement[] | undefined
}

/**
 * Lists the request-affecting elements of a resolved document: operations, `(name, in)`
 * parameters, request media, response keys, security alternatives and servers, each at its use
 * site, sorted by pointer. A `$ref` is followed only to read the object it stands for. The walker
 * imports the loader and resolver only, so it shares nothing with the model it checks.
 */
export const walk = (resolution: Resolution): Effect.Effect<readonly WalkElement[], WalkError> => {
	const { document } = resolution
	const at = (pointer: string) => ({ document, pointer })

	const deref = (pointer: string, node: Node): Effect.Effect<Node, WalkError> => {
		const reference = referenceAt(resolution, pointer)

		return reference === undefined
			? Effect.succeed(node)
			: Effect.asSome(evaluatePointer(resolution.value, reference.target.pointer))
	}

	const parameter = (
		pointer: string,
		node: Json
	): Effect.Effect<readonly WalkElement[], WalkError> =>
		deref(pointer, Option.some(node)).pipe(
			Effect.map((target): readonly WalkElement[] =>
				Option.match(
					Option.all({ name: text(member(target, "name")), where: text(member(target, "in")) }),
					{
						onNone: () => [],
						onSome: ({ name, where }) => [{ ...at(pointer), in: where, kind: "parameter", name }]
					}
				)
			)
		)

	const parameters = (
		owner: string,
		node: Node
	): Effect.Effect<readonly WalkElement[], WalkError> =>
		Effect.forEach(items(node), (entry, index) =>
			parameter(child(owner, "parameters", String(index)), entry)
		).pipe(Effect.map(Arr.flatten))

	const servers = (owner: string, node: Node): readonly WalkElement[] =>
		Arr.flatMap(items(node), (entry, index): readonly WalkElement[] =>
			Option.match(text(memberOf(entry, "url")), {
				onNone: () => [],
				onSome: (url) => [{ ...at(child(owner, "servers", String(index))), kind: "server", url }]
			})
		)

	const security = (owner: string, node: Node): readonly WalkElement[] =>
		Arr.map(items(node), (entry, index): WalkElement => ({
			...at(child(owner, "security", String(index))),
			kind: "securityAlternative",
			schemes: Arr.sort(isObject(entry) ? Record.keys(entry) : [], Order.String)
		}))

	const requestMedia = (
		owner: string,
		node: Json
	): Effect.Effect<readonly WalkElement[], WalkError> =>
		deref(child(owner, "requestBody"), memberOf(node, "requestBody")).pipe(
			Effect.map((body) =>
				Arr.map(entries(member(body, "content")), ([mediaType]): WalkElement => ({
					...at(child(owner, "requestBody", "content", mediaType)),
					kind: "requestMedia",
					mediaType
				}))
			)
		)

	const operation = (
		path: string,
		owner: string,
		method: string,
		node: Json,
		above: Inheritance
	): Effect.Effect<readonly WalkElement[], WalkError> =>
		Effect.all([parameters(owner, memberOf(node, "parameters")), requestMedia(owner, node)]).pipe(
			Effect.map(([own, media]): readonly WalkElement[] => [
				{
					...at(owner),
					defaultServer: above.servers === undefined && Option.isNone(memberOf(node, "servers")),
					inherits: Arr.sort(
						Arr.map(
							[
								...Arr.filter(
									above.parameters,
									(shared) =>
										!Arr.some(Arr.filter(own, isParameter), (mine) => sameParameter(mine, shared))
								),
								...(Option.isNone(memberOf(node, "security")) ? above.security : []),
								...(Option.isNone(memberOf(node, "servers")) ? (above.servers ?? []) : [])
							],
							(element) => element.pointer
						),
						Order.String
					),
					kind: "operation",
					method,
					path
				},
				...own,
				...media,
				...Arr.map(entries(memberOf(node, "responses")), ([key]): WalkElement => ({
					...at(child(owner, "responses", key)),
					key,
					kind: "response"
				})),
				...security(owner, memberOf(node, "security")),
				...servers(owner, memberOf(node, "servers"))
			])
		)

	const root = resolution.value
	const rootSecurity = security("", memberOf(root, "security"))
	const rootServers = Option.isNone(memberOf(root, "servers"))
		? undefined
		: servers("", memberOf(root, "servers"))

	const pathItem = (
		path: string,
		owner: string,
		node: Json
	): Effect.Effect<readonly WalkElement[], WalkError> =>
		deref(owner, Option.some(node)).pipe(
			Effect.flatMap((item) => {
				const itemServers = Option.isNone(member(item, "servers"))
					? undefined
					: servers(owner, member(item, "servers"))

				return parameters(owner, member(item, "parameters")).pipe(
					Effect.flatMap((shared) =>
						Effect.forEach(
							Arr.filter(entries(item), ([method]) => methods.has(method)),
							([method, value]) =>
								operation(path, child(owner, method), method, value, {
									parameters: Arr.filter(shared, isParameter),
									security: rootSecurity,
									servers: itemServers ?? rootServers
								})
						).pipe(
							Effect.map((operations): readonly WalkElement[] => [
								...shared,
								...Arr.flatten(operations),
								...(itemServers ?? [])
							])
						)
					)
				)
			})
		)

	return Effect.forEach(entries(memberOf(root, "paths")), ([path, node]) =>
		pathItem(path, child("", "paths", path), node)
	).pipe(
		Effect.map((found) =>
			Arr.sort([...Arr.flatten(found), ...rootSecurity, ...(rootServers ?? [])], byPointer)
		)
	)
}
