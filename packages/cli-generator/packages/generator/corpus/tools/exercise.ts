import { availableParallelism } from "node:os"
import { jsonTextOf } from "@superstarter/json"
import {
	Array as Arr,
	Effect,
	FileSystem,
	JsonPointer,
	Option,
	Path,
	Predicate,
	Record,
	Schema,
	String as Str
} from "effect"
import type { Built } from "#corpus/tools/run.ts"
import { CorpusRunFailed, spawn } from "#corpus/tools/run.ts"
import { isArray, isObject } from "#model/json-tree.ts"
import type { JsonObject } from "#model/json-tree.ts"
import type { Json } from "#model/pointer.ts"

type Command = Built["commands"][number]

type Flag = Command["flags"][number]

/** The base URL every exercised command is pointed at: `--dry-run` sends nothing, so nothing listens. */
const base = "http://127.0.0.1:9"

/** The deepest array an exercised body fills: one item down to here, empty below. */
const filledArrayDepth = 2

const decodeText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String))

/** A body the walk cannot build: a reference it does not follow, or a schema no value it builds meets. */
class Unbuildable extends Schema.TaggedError<Unbuildable, { readonly brand: unique symbol }>()(
	"Unbuildable",
	{ reason: Schema.String }
) {}

const unbuildable = (reason: string): Effect.Effect<never, Unbuildable> =>
	Effect.fail(Unbuildable.make({ reason }))

/** The node at a list of RFC 6901 tokens below `root`. */
const nodeAtTokens = (root: Json, tokens: readonly string[]): Option.Option<Json> =>
	Arr.reduce(tokens, Option.some(root), (found, token) =>
		Option.flatMap(found, (at) => {
			if (isObject(at)) {
				return Record.get(at, token)
			}

			return isArray(at) ? Arr.get(at, Number(token)) : Option.none()
		})
	)

/** The node at a `--describe` pointer of the specification. */
const nodeOf = (value: Json, pointer: string): Option.Option<Json> =>
	nodeAtTokens(value, JsonPointer.parseUriFragment(`#${pointer}`) ?? [])

const textAt = (node: JsonObject, key: string): Option.Option<string> =>
	Option.filter(Record.get(node, key), Predicate.isString)

const numberAt = (node: JsonObject, key: string): Option.Option<number> =>
	Option.filter(Record.get(node, key), Predicate.isNumber)

const listAt = (node: JsonObject, key: string): readonly Json[] =>
	Option.getOrElse(Option.filter(Record.get(node, key), isArray), () => [])

/** The schema's first `type` that is not `null`, if it names one. */
const typeOf = (node: JsonObject): Option.Option<string> =>
	Option.orElse(textAt(node, "type"), () =>
		Arr.findFirst(
			listAt(node, "type"),
			(each): each is string => Predicate.isString(each) && each !== "null"
		)
	)

/** A number at the schema's lower bound, or zero where it has none. */
const numberOf = (node: JsonObject): number =>
	Option.getOrElse(
		Option.orElse(numberAt(node, "minimum"), () =>
			Option.map(numberAt(node, "exclusiveMinimum"), (above) => above + 1)
		),
		() =>
			Math.min(
				0,
				Option.getOrElse(numberAt(node, "maximum"), () => 0)
			)
	)

/** Where the walk is: the resource fragment references resolve in, the references it is inside, and its arrays. */
interface Walk {
	readonly arrays: number
	readonly following: readonly string[]
	readonly resource: Json
}

/**
 * The node a fragment-only `$ref` names in the walk's resource, the innermost enclosing schema with its own `$id` or
 * else the document (JSON Schema 2020-12, 8.2.1), as grizzle's nested facts name their levels. A reference it is
 * already inside is a cycle with no value at its end, and any other reference is one the walk does not follow.
 */
const referenced = (ref: string, walk: Walk): Effect.Effect<Json, Unbuildable> => {
	const tokens = Str.startsWith("#")(ref) ? JsonPointer.parseUriFragment(ref) : undefined
	if (tokens === undefined || walk.following.includes(ref)) {
		return unbuildable(`the walk does not follow ${ref} from here`)
	}

	return Option.match(nodeAtTokens(walk.resource, tokens), {
		onNone: () => unbuildable(`${ref} names no node`),
		onSome: Effect.succeed
	})
}

/** The first branch the walk builds a value of, in order. */
const firstOf = (
	branches: readonly Json[],
	walk: Walk,
	value: (schema: Json, walk: Walk) => Effect.Effect<Json, Unbuildable>
): Effect.Effect<Json, Unbuildable> => {
	const none: Effect.Effect<Json, Unbuildable> = unbuildable("no branch has a value")

	return Arr.reduce(branches, none, (earlier, branch) =>
		Effect.catchTag(earlier, "Unbuildable", () => value(branch, walk))
	)
}

/**
 * A value of `schema`: its `const`, its first `enum` member, the value of its first `oneOf` or `anyOf` branch that has
 * one, an object of the properties it and its `allOf` members require, an array of one item while fewer than
 * `filledArrayDepth` arrays hold it (and of as many as `minItems` asks), a string of `minLength` letters, a number at
 * its lower bound, `false` or `null`. The dry run needs a value its schema admits, not a meaningful one: a generated
 * CLI checks no `pattern` or `format` (SCH-37, SCH-54), so a string ignores them.
 */
const valueOf = (schema: Json, walk: Walk): Effect.Effect<Json, Unbuildable> =>
	Effect.gen(function* value() {
		if (schema === true || (isObject(schema) && Record.isEmptyReadonlyRecord(schema))) {
			return null
		}

		if (!isObject(schema)) {
			return yield* unbuildable("a schema no value meets")
		}

		const inner: Walk = Option.isSome(textAt(schema, "$id")) ? { ...walk, resource: schema } : walk
		const ref = textAt(schema, "$ref")
		if (Option.isSome(ref)) {
			const target = yield* referenced(ref.value, inner)

			return yield* valueOf(target, { ...inner, following: [...inner.following, ref.value] })
		}

		const constant = Record.get(schema, "const")
		if (Option.isSome(constant)) {
			return constant.value
		}

		const choice = Arr.head(listAt(schema, "enum"))
		if (Option.isSome(choice)) {
			return choice.value
		}

		const branches = [...listAt(schema, "oneOf"), ...listAt(schema, "anyOf")]
		if (Arr.isReadonlyArrayNonEmpty(branches)) {
			return yield* firstOf(branches, inner, valueOf)
		}

		const parts = [schema, ...Arr.filter(listAt(schema, "allOf"), isObject)]
		const properties = Record.fromEntries(
			Arr.flatMap(parts, (part) =>
				Option.match(Option.filter(Record.get(part, "properties"), isObject), {
					onNone: () => [],
					onSome: Record.toEntries
				})
			)
		)
		const required = Arr.dedupe(
			Arr.flatMap(parts, (part) => Arr.filter(listAt(part, "required"), Predicate.isString))
		)
		const type = Option.getOrElse(typeOf(schema), () => (required.length > 0 ? "object" : ""))

		if (type === "object") {
			const entries = yield* Effect.forEach(required, (name) =>
				Effect.map(
					valueOf(
						Option.getOrElse(Record.get(properties, name), (): Json => true),
						inner
					),
					(found) => [name, found] as const
				)
			)

			return Record.fromEntries(entries)
		}

		if (type === "array") {
			const prefixed = listAt(schema, "prefixItems")
			const items = Option.getOrElse(Record.get(schema, "items"), (): Json => true)
			const wanted = Math.max(
				Option.getOrElse(numberAt(schema, "minItems"), () => 0),
				inner.arrays < filledArrayDepth ? 1 : 0
			)
			const count = Math.min(
				wanted,
				Option.getOrElse(numberAt(schema, "maxItems"), () => wanted)
			)
			const below: Walk = { ...inner, arrays: inner.arrays + 1 }

			return yield* Effect.forEach(
				Array.from({ length: count }, (_, at) => at),
				(at) =>
					valueOf(
						Option.getOrElse(Arr.get(prefixed, at), () => items),
						below
					)
			)
		}

		if (type === "string") {
			return Str.repeat(Option.getOrElse(numberAt(schema, "minLength"), () => 0))("a")
		}

		if (type === "integer" || type === "number") {
			return numberOf(schema)
		}

		return type === "boolean" ? false : null
	})

/** The JSON request body schema of the command's operation, where it has one. */
const bodySchemaOf = (value: Json, command: Command): Option.Option<Json> =>
	nodeOf(value, `${command.pointer}/requestBody/content/application~1json/schema`)

/** A constant header as a dry run prints it: its lowercased name and its one value's text. */
const constantLine = (constant: Command["constants"][number]): string =>
	`${Str.toLowerCase(constant.wireName)}: ${Option.getOrElse(decodeText(constant.value), () => constant.value)}`

/**
 * The lines a command's dry run must print in its head, read from its `--describe` entry: its request line, its JSON
 * content type and each constant header with its one value.
 */
const expectedHead = (command: Command): readonly string[] => [
	`${command.method} ${base}${command.pathTemplate} HTTP/1.1`,
	"content-type: application/json",
	...Arr.map(
		Arr.filter(command.constants, (constant) => constant.location === "header"),
		constantLine
	)
]

/** The text kinds a field's schema states with nothing that makes it a file, and the metavar help shows for each. */
const textKinds: ReadonlySet<string> = new Set(["integer", "number", "string"])

/**
 * What help must show after a flag's name: the type a body field's schema states, where it states one text kind and
 * no encoding (a string, an integer, a number, whatever constraints sit beside it in an `allOf`), and otherwise
 * anything, so a metavar is only held to what the specification itself says.
 */
const metavarOf = (value: Json, flag: Flag): string => {
	const node = Option.filter(
		flag.location === "body" ? nodeOf(value, flag.pointer) : Option.none(),
		isObject
	)
	const stated = Option.flatMap(node, (schema) =>
		Arr.some(["contentEncoding", "contentMediaType", "format"], (key) => Record.has(schema, key))
			? Option.none()
			: Option.filter(textAt(schema, "type"), (type) => textKinds.has(type))
	)

	return Option.match(stated, { onNone: () => "", onSome: (type) => `${type} ` })
}

/** Runs the built bin with `args` and no environment, answering its standard output. */
const runBin = (built: Built, step: string, args: readonly string[]) =>
	spawn(built.id, step, [process.execPath, built.bin, ...args], { cwd: built.dir, env: {} })

/** The findings of one command: its help, and its dry run held to the request its operation describes. */
const exerciseCommand = (built: Built, command: Command) =>
	Effect.gen(function* exerciseOne() {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const words = Arr.join(command.path, " ")
		const name = `${built.id}: ${words}`
		const failed = (output: string) =>
			CorpusRunFailed.make({ id: built.id, output, step: `${words} body` })
		const help = yield* runBin(built, `${words} --help`, [...command.path, "--help"])
		const shown = [
			`${command.method} ${command.pathTemplate}`,
			...Arr.map(command.flags, (flag) => `--${flag.name} ${metavarOf(built.value, flag)}`)
		]
		const unshown = Arr.map(
			Arr.filter(shown, (text) => !Str.includes(text)(help)),
			(text) => `${name}: --help does not show ${jsonTextOf(text)}`
		)
		const schema = bodySchemaOf(built.value, command)
		if (Option.isNone(schema) || Arr.some(command.flags, (flag) => flag.location !== "body")) {
			return [
				...unshown,
				`${name}: the benchmark sends JSON bodies alone, and this command takes other input`
			]
		}

		const walk: Walk = { arrays: 0, following: [], resource: built.value }
		const value = yield* valueOf(schema.value, walk).pipe(
			Effect.mapError((cause) => failed(cause.reason))
		)
		const body = jsonTextOf(value)
		const file = path.join(built.dir, `${Arr.join(command.path, "-")}.body.json`)
		yield* fs.writeFileString(file, body).pipe(Effect.mapError((cause) => failed(cause.message)))
		const printed = yield* runBin(built, `${words} --dry-run`, [
			"--base-url",
			base,
			...command.path,
			"--body-file",
			file,
			"--dry-run"
		])
		const [head, ...rest] = Str.split(printed, "\n\n")
		const lines = Str.split(head, "\n")
		const unprinted = Arr.map(
			Arr.filter(expectedHead(command), (line) => !lines.includes(line)),
			(line) => `${name}: --dry-run does not print ${jsonTextOf(line)}`
		)
		const sent = Arr.join(rest, "\n\n") === `${body}\n`

		return [
			...unshown,
			...unprinted,
			...(sent ? [] : [`${name}: --dry-run does not print the body it was given`])
		]
	})

/** The names directly under `group` in the command tree. */
const childrenOf = (commands: readonly Command[], group: readonly string[]): readonly string[] =>
	Arr.dedupe(
		Arr.flatMap(commands, (command) =>
			Arr.every(group, (word, at) => command.path[at] === word)
				? Option.toArray(Arr.get(command.path, group.length))
				: []
		)
	)

/** The findings of one group's `--help`, the root's among them: it lists every name under it. */
const exerciseGroup = (built: Built, group: readonly string[]) =>
	Effect.map(runBin(built, `${Arr.join(group, " ")} --help`, [...group, "--help"]), (help) =>
		Arr.flatMap(childrenOf(built.commands, group), (child) =>
			Str.includes(`  ${child}`)(help)
				? []
				: [`${built.id}: ${Arr.join(group, " ")} --help does not list ${child}`]
		)
	)

/** Every group above a command, the root's empty path among them, once each. */
const groupsOf = (commands: readonly Command[]): readonly (readonly string[])[] => {
	const separator = "\u0000"
	const joined = Arr.dedupe(
		Arr.flatMap(commands, (command) =>
			Array.from({ length: command.path.length }, (_, length) =>
				Arr.join(Arr.take(command.path, length), separator)
			)
		)
	)

	return Arr.map(joined, (group) => (group === "" ? [] : Str.split(group, separator)))
}

/**
 * The benchmark's exercise of a built CLI (corpus/tools/benchmark.ts): the root's and every group's `--help`, each
 * listing the names under it; and for every command its `--help`, which shows its request and every flag (a text
 * field's with the type its schema states), and its `--dry-run` with a JSON body built from its operation's schema,
 * which must print the request line, content type and constant headers its `--describe` entry states, then the body
 * given byte for byte. They run at once, one a core.
 */
export const exerciseCommands = (built: Built) =>
	Effect.gen(function* exercise() {
		const concurrency = availableParallelism()
		const groupFindings = yield* Effect.forEach(
			groupsOf(built.commands),
			(group) => exerciseGroup(built, group),
			{ concurrency }
		)
		const commandFindings = yield* Effect.forEach(
			built.commands,
			(command) => exerciseCommand(built, command),
			{ concurrency }
		)

		return [...Arr.flatten(groupFindings), ...Arr.flatten(commandFindings)]
	})
