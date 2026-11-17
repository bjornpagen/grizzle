/** What the properties of command-tree.test.ts read: the group tables and command trees they draw, and their models. */

import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	map,
	oneOf,
	option,
	subset,
	uniqueArray
} from "@bjornpagen/testing/gen"
import {
	Array as Arr,
	Console,
	Effect,
	Option,
	Order,
	Predicate,
	Record,
	Schema,
	String as Str
} from "effect"
import { Command } from "effect/cli"
import * as BaseUrl from "#runtime-src/runtime/base-url.ts"
import * as Describe from "#runtime-src/runtime/describe.ts"
import * as Groups from "#runtime-src/runtime/groups.ts"
import { printed, recordingConsole } from "#test/support/console.ts"

/** A group table row as drawn: the header fields a stub carries. */
export type EntrySketch = Readonly<{
	name: string
	alias: Option.Option<string>
	description: Option.Option<string>
	shortDescription: Option.Option<string>
	unlisted: boolean
}>

/** One group table and the argv the root is built for. */
export type Selection = Readonly<{
	entries: ReadonlyArray<EntrySketch>
	args: ReadonlyArray<string>
}>

/** What a selection case reaches. */
export type SelectionFeature =
	| "a name selects its group"
	| "an alias selects its group"
	| "a trigger loads every group"
	| "a token holding a name selects nothing"
	| "a near-miss trigger loads nothing"
	| "no group selected"
	| "a stub keeps its alias"
	| "a stub keeps its description"
	| "a stub keeps its short description"
	| "an unlisted stub"

const NAMES = ["users", "teams", "billing", "pets"] as const

const ALIASES = ["t", "u", "tm", "b"] as const

const nameOf: Gen<string> = element(NAMES)

const entryOf =
	(name: string): Gen<EntrySketch> =>
	(source) => ({
		name,
		alias: option(element(ALIASES))(source),
		description: option(constant(`${name} and their members`))(source),
		shortDescription: option(constant(`${name} in short`))(source),
		unlisted: boolean(source)
	})

const entries: Gen<ReadonlyArray<EntrySketch>> = uniqueArray(nameOf, entryOf, { min: 1, max: 3 })

const triggers = ["--describe", "--describe=true", "--completions", "--completions=zsh"] as const

const nearTriggers = ["--describer", "-describe", "describe", "--completion"] as const

const holding = (name: string): Gen<string> =>
	element([`--${name}`, `${name}-list`, `--name=${name}`, `${name}s`])

const token: Gen<string> = oneOf<string>([
	nameOf,
	element(ALIASES),
	(source) => holding(nameOf(source))(source),
	element(triggers),
	element(nearTriggers),
	element(["list", "--help", "--version", "ping", "--base-url", "x", "--output"])
])

const selection: Gen<Selection> = (source) => ({
	entries: entries(source),
	args: array(token, { min: 0, max: 5 })(source)
})

const isTrigger = (arg: string): boolean =>
	Arr.some(
		["--describe", "--completions"],
		(name) => arg === name || Str.startsWith(`${name}=`)(arg)
	)

/** Whether the model selects `entry` under `args`: a trigger anywhere, or the name or alias as a whole token. */
const selectedInModel = (entry: EntrySketch, args: ReadonlyArray<string>): boolean =>
	Arr.some(args, isTrigger) ||
	Arr.some(args, (arg) => arg === entry.name || Option.contains(entry.alias, arg))

/** The situations a selection case reaches, read from the sketch and the model. */
export const selectionFeatures = (drawn: Selection): ReadonlyArray<SelectionFeature> => {
	const triggered = Arr.some(drawn.args, isTrigger)
	const unselected = Arr.filter(drawn.entries, (entry) => !selectedInModel(entry, drawn.args))
	const facts: ReadonlyArray<readonly [boolean, SelectionFeature]> = [
		[
			!triggered && Arr.some(drawn.entries, (entry) => drawn.args.includes(entry.name)),
			"a name selects its group"
		],
		[
			!triggered &&
				Arr.some(
					drawn.entries,
					(entry) =>
						!drawn.args.includes(entry.name) &&
						Arr.some(drawn.args, (arg) => Option.contains(entry.alias, arg))
				),
			"an alias selects its group"
		],
		[triggered && drawn.entries.length > 1 && drawn.args.length > 1, "a trigger loads every group"],
		[
			Arr.some(unselected, (entry) =>
				Arr.some(drawn.args, (arg) => arg !== entry.name && Str.includes(entry.name)(arg))
			),
			"a token holding a name selects nothing"
		],
		[
			!triggered && Arr.some(drawn.args, (arg) => Arr.contains(nearTriggers, arg)),
			"a near-miss trigger loads nothing"
		],
		[unselected.length === drawn.entries.length, "no group selected"],
		[Arr.some(unselected, (entry) => Option.isSome(entry.alias)), "a stub keeps its alias"],
		[
			Arr.some(unselected, (entry) => Option.isSome(entry.description)),
			"a stub keeps its description"
		],
		[
			Arr.some(unselected, (entry) => Option.isSome(entry.shortDescription)),
			"a stub keeps its short description"
		],
		[Arr.some(unselected, (entry) => entry.unlisted), "an unlisted stub"]
	]
	return Arr.flatMap(facts, ([holds, feature]) => (holds ? [feature] : []))
}

const unselectedArgs: Gen<ReadonlyArray<string>> = array(
	element(["list", "--help", "ping", "--users", "users-list"]),
	{
		min: 0,
		max: 3
	}
)

const aliasedStub: Gen<Selection> = (source) => ({
	entries: [{ ...entryOf("teams")(source), alias: Option.some("t") }],
	args: unselectedArgs(source)
})

const lone = (name: string): EntrySketch => ({
	name,
	alias: Option.none(),
	description: Option.none(),
	shortDescription: Option.none(),
	unlisted: false
})

const atLeastTwo = (drawn: ReadonlyArray<EntrySketch>): ReadonlyArray<EntrySketch> =>
	drawn.length > 1
		? drawn
		: [...drawn, lone(Arr.some(drawn, (entry) => entry.name === "pets") ? "teams" : "pets")]

/** Selections, with a constructed case for each situation a plain draw reaches rarely. */
export const selections = {
	space: selection,
	nameSelects: map(selection, (drawn): Selection => ({
		entries: drawn.entries,
		args: [
			...Arr.filter(drawn.args, (arg) => !isTrigger(arg)),
			...Arr.take(
				Arr.map(drawn.entries, (entry) => entry.name),
				1
			)
		]
	})),
	aliasSelects: map(aliasedStub, (drawn): Selection => ({
		entries: drawn.entries,
		args: [...drawn.args, "t"]
	})),
	triggerLoadsAll: map(selection, (drawn): Selection => ({
		entries: atLeastTwo(drawn.entries),
		args: ["list", "--describe"]
	})),
	holdingName: map(selection, (drawn): Selection => ({
		entries: drawn.entries,
		args: Arr.flatMap(Arr.take(drawn.entries, 1), (entry) => [
			`--${entry.name}`,
			`${entry.name}-list`,
			"--name=x"
		])
	})),
	nearMissTrigger: map(selection, (drawn): Selection => ({
		entries: drawn.entries,
		args: ["--describer", "list"]
	})),
	aliasedStub
} as const

/** The header fields of a stub, as root help reads them. */
type Fields = Readonly<{
	alias: string | undefined
	description: string | undefined
	name: string
	shortDescription: string | undefined
	unlisted: boolean
}>

const fieldsOfCommand = (command: Command.Command.Any): Fields => ({
	alias: command.alias,
	description: command.description,
	name: command.name,
	shortDescription: command.shortDescription,
	unlisted: command.unlisted
})

const headerOf = (entry: EntrySketch): Groups.Header => ({
	name: entry.name,
	unlisted: entry.unlisted,
	...Option.match(entry.alias, { onNone: () => ({}), onSome: (alias) => ({ alias }) }),
	...Option.match(entry.description, {
		onNone: () => ({}),
		onSome: (description) => ({ description })
	}),
	...Option.match(entry.shortDescription, {
		onNone: () => ({}),
		onSome: (shortDescription) => ({ shortDescription })
	})
})

const fieldsOfEntry = (entry: EntrySketch): Fields => ({
	alias: Option.getOrUndefined(entry.alias),
	description: Option.getOrUndefined(entry.description),
	name: entry.name,
	shortDescription: Option.getOrUndefined(entry.shortDescription),
	unlisted: entry.unlisted
})

/** One table entry's slot of a built root: the loaded group, or the stub's fields and children. */
export type Slot =
	| Readonly<{ kind: "loaded"; name: string; loads: number }>
	| Readonly<{ kind: "stub"; fields: Fields; children: number; loads: number }>

/** What `Groups.selected` and `Groups.root` answer for one selection: the selected names and each table slot. */
export type Built = Readonly<{
	selected: ReadonlyArray<string>
	root: string
	children: ReadonlyArray<string>
	slots: ReadonlyArray<Slot>
}>

const leaf = (name: string) => Command.make(name)

/** What the runtime builds for `drawn`: every entry's group loaded by a counting loader, or stubbed. */
export const actualBuilt = (drawn: Selection): Effect.Effect<Built> =>
	Effect.gen(function* () {
		const loaded = Arr.map(drawn.entries, (entry) => ({
			group: Command.make(entry.name).pipe(Command.withSubcommands([leaf("list")])),
			count: { value: 0 }
		}))
		const table: ReadonlyArray<Groups.Entry<never, never>> = Arr.map(
			Arr.zip(drawn.entries, loaded),
			([entry, module]) => ({
				...headerOf(entry),
				load: () => {
					module.count.value += 1
					return Promise.resolve({ group: module.group })
				}
			})
		)
		const header = (groups: ReadonlyArray<Groups.Group<never, never>>) =>
			Command.make("cli").pipe(Command.withSubcommands([...groups, leaf("ping"), leaf("hello")]))
		const built = yield* Groups.root([...table], header, drawn.args)
		const children = Arr.flatMap(built.subcommands, (group) => group.commands)
		return {
			selected: Arr.map(
				Arr.filter(table, (entry) => Groups.selected(entry, drawn.args)),
				(entry) => entry.name
			),
			root: built.name,
			children: Arr.map(children, (child) => child.name),
			slots: Arr.map(Arr.zip(loaded, children), ([module, child]): Slot =>
				child === module.group
					? { kind: "loaded", name: child.name, loads: module.count.value }
					: {
							kind: "stub",
							fields: fieldsOfCommand(child),
							children: child.subcommands.length,
							loads: module.count.value
						}
			)
		}
	})

/** What the model expects for `drawn`: selected entries loaded once, every other entry a header-only stub, never loaded. */
export const expectedBuilt = (drawn: Selection): Built => ({
	selected: Arr.map(
		Arr.filter(drawn.entries, (entry) => selectedInModel(entry, drawn.args)),
		(entry) => entry.name
	),
	root: "cli",
	children: [...Arr.map(drawn.entries, (entry) => entry.name), "ping", "hello"],
	slots: Arr.map(drawn.entries, (entry): Slot =>
		selectedInModel(entry, drawn.args)
			? { kind: "loaded", name: entry.name, loads: 1 }
			: { kind: "stub", fields: fieldsOfEntry(entry), children: 0, loads: 0 }
	)
})

/** A command's binding as drawn: the operation `--describe` reads and the command's flag bindings. */
export type BindingSketch = Readonly<{
	method: string
	pathTemplate: string
	pointer: string
	request: ReadonlyArray<string>
	responses: ReadonlyArray<string>
	refused: ReadonlyArray<readonly [media: string, fields: ReadonlyArray<string>]>
	security: ReadonlyArray<ReadonlyArray<string>>
	servers: Option.Option<ReadonlyArray<string>>
	flags: ReadonlyArray<Describe.ParameterBinding & Readonly<{ name: string }>>
	constants: ReadonlyArray<Describe.ConstantBinding>
}>

/** A command of the drawn tree: its name, its binding when it has one, and its children. */
export type NodeSketch = Readonly<{
	name: string
	binding: Option.Option<BindingSketch>
	children: ReadonlyArray<NodeSketch>
}>

/** The root's servers: a declared table, the generator's undeclared `/`, or no Servers service. */
export type RootServers =
	| Readonly<{ kind: "declared"; urls: Arr.NonEmptyReadonlyArray<string> }>
	| Readonly<{ kind: "undeclared" }>
	| Readonly<{ kind: "absent" }>

/** One `--describe` case: the root's children and the root servers around the run. */
export type Tree = Readonly<{ children: ReadonlyArray<NodeSketch>; servers: RootServers }>

/** What a describe case reaches. */
export type TreeFeature =
	| "an operation-level servers override"
	| "root servers inherited"
	| "the undeclared root server"
	| "no Servers service"
	| "a refused field"
	| "a constant parameter"
	| "an unbound group"
	| "a nested bound command"
	| "flags out of name order"

const LOCATIONS = ["path", "query", "header", "cookie", "body", "querystring"] as const

const MEDIA = [
	"application/json",
	"application/merge-patch+json",
	"application/x-www-form-urlencoded",
	"text/plain"
] as const

const flagName: Gen<string> = element(["id", "if-match", "name", "limit", "avatar", "x-trace"])

const flagBinding =
	(name: string): Gen<Describe.ParameterBinding & Readonly<{ name: string }>> =>
	(source) => {
		const location = element(LOCATIONS)(source)
		return {
			name,
			location,
			pointer: `/paths/~1x/get/parameters/${name}`,
			wireName: location === "body" ? `/${name}` : name
		}
	}

const constantBinding: Gen<Describe.ConstantBinding> = (source) => {
	const name = element(["version", "kind"])(source)
	return {
		location: element(LOCATIONS)(source),
		pointer: `/components/parameters/${name}`,
		value: element(['"v1"', "2", "true"])(source),
		wireName: name
	}
}

const url: Gen<string> = element([
	"https://api.example.com/{version}",
	"https://eu.example.com",
	"/v2",
	"https://api.example.com"
])

const bindingOf: Gen<BindingSketch> = (source) => {
	const request = subset(MEDIA, { min: 0, max: 3 })(source)
	return {
		method: element(["GET", "PATCH", "PUT", "POST", "DELETE"])(source),
		pathTemplate: element(["/users", "/users/{id}", "/users/{id}/avatar"])(source),
		pointer: element(["/paths/~1users/get", "/paths/~1users~1{id}/patch"])(source),
		request,
		responses: subset(["200", "204", "4XX", "default", "201"], { min: 1, max: 4 })(source),
		refused: Arr.flatMap(request, (media) =>
			boolean(source)
				? [[media, subset(["avatar", "name", "tags"], { min: 1, max: 2 })(source)] as const]
				: []
		),
		security: array(subset(["bearerAuth", "apiKey", "session"], { min: 0, max: 2 }), {
			min: 0,
			max: 3
		})(source),
		servers: option(array(url, { min: 0, max: 2 }))(source),
		flags: uniqueArray(flagName, flagBinding, { min: 0, max: 4 })(source),
		constants: array(constantBinding, { min: 0, max: 2 })(source)
	}
}

const nodeName: Gen<string> = element(["users", "update", "list", "set-avatar", "teams", "show"])

const leafNode =
	(name: string): Gen<NodeSketch> =>
	(source) => ({
		name,
		binding: option(bindingOf)(source),
		children: []
	})

const branchNode =
	(name: string): Gen<NodeSketch> =>
	(source) => ({
		name,
		binding: option(bindingOf)(source),
		children: uniqueArray(nodeName, leafNode, { min: 0, max: 3 })(source)
	})

const rootServers: Gen<RootServers> = oneOf<RootServers>([
	map(array(url, { min: 1, max: 2 }), (urls): RootServers =>
		Arr.isReadonlyArrayNonEmpty(urls) ? { kind: "declared", urls } : { kind: "undeclared" }
	),
	constant<RootServers>({ kind: "undeclared" }),
	constant<RootServers>({ kind: "absent" })
])

const tree: Gen<Tree> = (source) => ({
	children: uniqueArray(nodeName, branchNode, { min: 1, max: 3 })(source),
	servers: rootServers(source)
})

const bindingOfFixed: BindingSketch = {
	method: "PATCH",
	pathTemplate: "/users/{id}",
	pointer: "/paths/~1users~1{id}/patch",
	request: ["application/json", "application/x-www-form-urlencoded"],
	responses: ["200", "4XX", "default"],
	refused: [["application/x-www-form-urlencoded", ["avatar"]]],
	security: [["bearerAuth"], ["apiKey", "session"]],
	servers: Option.none(),
	flags: [
		{
			name: "name",
			location: "body",
			pointer: "/components/schemas/U/properties/name",
			wireName: "/name"
		},
		{
			name: "id",
			location: "path",
			pointer: "/paths/~1users~1{id}/patch/parameters/0",
			wireName: "id"
		}
	],
	constants: [
		{
			location: "query",
			pointer: "/components/parameters/version",
			value: '"v1"',
			wireName: "version"
		}
	]
}

/** Command trees, with a constructed case for the situations a plain draw reaches rarely. */
export const trees = {
	space: tree,
	nested: map(tree, (drawn): Tree => ({
		servers: drawn.servers,
		children: [
			{
				name: "users",
				binding: Option.none(),
				children: [{ name: "update", binding: Option.some(bindingOfFixed), children: [] }]
			},
			...Arr.filter(drawn.children, (child) => child.name !== "users")
		]
	})),
	absent: map(tree, (drawn): Tree => ({ ...drawn, servers: { kind: "absent" } }))
} as const

const walkSketch = (
	nodes: ReadonlyArray<NodeSketch>,
	path: ReadonlyArray<string>
): ReadonlyArray<readonly [ReadonlyArray<string>, NodeSketch]> =>
	Arr.flatMap(nodes, (node) => [
		[[...path, node.name], node] as const,
		...walkSketch(node.children, [...path, node.name])
	])

/** The situations a describe case reaches. */
export const treeFeatures = (drawn: Tree): ReadonlyArray<TreeFeature> => {
	const nodes = walkSketch(drawn.children, [])
	const bound = Arr.flatMap(nodes, ([path, node]) =>
		Option.toArray(Option.map(node.binding, (binding) => [path, binding] as const))
	)
	const facts: ReadonlyArray<readonly [boolean, TreeFeature]> = [
		[
			Arr.some(bound, ([, binding]) => Option.isSome(binding.servers)),
			"an operation-level servers override"
		],
		[
			drawn.servers.kind === "declared" &&
				Arr.some(bound, ([, binding]) => Option.isNone(binding.servers)),
			"root servers inherited"
		],
		[
			drawn.servers.kind === "undeclared" &&
				Arr.some(bound, ([, binding]) => Option.isNone(binding.servers)),
			"the undeclared root server"
		],
		[drawn.servers.kind === "absent" && bound.length > 0, "no Servers service"],
		[Arr.some(bound, ([, binding]) => binding.refused.length > 0), "a refused field"],
		[Arr.some(bound, ([, binding]) => binding.constants.length > 0), "a constant parameter"],
		[
			Arr.some(nodes, ([, node]) => Option.isNone(node.binding) && node.children.length > 0),
			"an unbound group"
		],
		[Arr.some(bound, ([path]) => path.length > 1), "a nested bound command"],
		[
			Arr.some(bound, ([, binding]) =>
				Arr.some(
					binding.flags,
					(flag, at) => at > 0 && (binding.flags[at - 1]?.name ?? "") > flag.name
				)
			),
			"flags out of name order"
		]
	]
	return Arr.flatMap(facts, ([holds, feature]) => (holds ? [feature] : []))
}

const commandBinding = (binding: BindingSketch): Describe.CommandBinding => ({
	...(binding.constants.length > 0 ? { constants: binding.constants } : {}),
	operation: {
		media: {
			request: binding.request,
			responses: Record.fromEntries(Arr.map(binding.responses, (key) => [key, []])),
			...(binding.refused.length > 0 ? { refused: Record.fromEntries(binding.refused) } : {})
		},
		method: binding.method,
		origin: { document: "openapi.json", pointer: binding.pointer },
		pathTemplate: binding.pathTemplate,
		security: binding.security,
		...(Option.isSome(binding.servers)
			? { servers: { servers: Arr.map(binding.servers.value, (server) => ({ url: server })) } }
			: {})
	},
	parameters: Record.fromEntries(
		Arr.map(binding.flags, (flag) => [
			flag.name,
			{ location: flag.location, pointer: flag.pointer, wireName: flag.wireName }
		])
	)
})

/** A command of a drawn tree: plain, its input empty and nothing beyond the platform required. */
type Plain = ReturnType<typeof leaf>

const commandOf = (node: NodeSketch): Plain => {
	const named = Command.make(node.name).pipe(
		Command.withSubcommands(Arr.map(node.children, commandOf))
	)
	return Option.match(node.binding, {
		onNone: () => named,
		onSome: (binding) => named.pipe(Command.annotate(Describe.Binding, commandBinding(binding)))
	})
}

/** What `--describe` printed for `drawn`: the lines it wrote, with the root's servers provided as the drawn case says. */
export const describeLines = (drawn: Tree) =>
	Effect.suspend(() => {
		const lines = printed()
		const root = Command.make("example").pipe(
			Command.withSubcommands(Arr.map(drawn.children, commandOf)),
			Command.withGlobalFlags([Describe.describeFlag])
		)
		const run = Command.runWith(root, { version: "0.0.0" })(["--describe"]).pipe(
			Effect.provideService(Console.Console, recordingConsole(lines, "")),
			Effect.as(lines.log)
		)
		const table = serversTable(drawn.servers)
		return Option.isSome(table)
			? run.pipe(
					Effect.provideService(BaseUrl.Servers, { table: table.value, envPrefix: "EXAMPLE" })
				)
			: run
	})

const serversTable = (servers: RootServers): Option.Option<BaseUrl.ServersTable> => {
	switch (servers.kind) {
		case "declared":
			return Option.some({
				boundOrigins: [],
				defaultServer: 0,
				servers: Arr.map(servers.urls, (server) => ({ url: server }))
			})
		case "undeclared":
			return Option.some({ boundOrigins: [], servers: [{ url: "/" }] })
		case "absent":
			return Option.none()
	}
}

const rootUrls = (servers: RootServers): ReadonlyArray<string> => {
	switch (servers.kind) {
		case "declared":
			return servers.urls
		case "undeclared":
			return ["/"]
		case "absent":
			return []
	}
}

const byFlagName = Order.mapInput(Order.String, (flag: Readonly<{ name: string }>) => flag.name)

/** The document the model expects: every bound command in tree order, its effective servers and its sorted flags. */
export const expectedDescription = (drawn: Tree): typeof Describe.Description.Type => ({
	commands: Arr.flatMap(walkSketch(drawn.children, []), ([path, node]) =>
		Option.toArray(
			Option.map(node.binding, (binding) => ({
				constants: binding.constants,
				document: "openapi.json",
				flags: Arr.sort(
					Arr.map(binding.flags, (flag) => ({
						location: flag.location,
						name: flag.name,
						pointer: flag.pointer,
						wireName: flag.wireName
					})),
					byFlagName
				),
				method: binding.method,
				path,
				pathTemplate: binding.pathTemplate,
				pointer: binding.pointer,
				refusedFields: Arr.flatMap(binding.request, (media) =>
					Arr.flatMap(binding.refused, ([refusedMedia, fields]) =>
						refusedMedia === media ? Arr.map(fields, (name) => ({ mediaType: media, name })) : []
					)
				),
				requestMedia: binding.request,
				responses: Record.keys(Record.fromEntries(Arr.map(binding.responses, (key) => [key, 0]))),
				security: binding.security,
				servers: Option.getOrElse(binding.servers, () => rootUrls(drawn.servers))
			}))
		)
	),
	describeVersion: 1
})

/** The printed document, decoded by its own codec. */
export const decodeDescription = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Describe.Description)
)

const decodeTree = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

const keysSorted = (value: unknown): boolean => {
	if (Arr.isArray(value)) {
		return Arr.every(value, keysSorted)
	}
	if (!Predicate.isObject(value)) {
		return true
	}
	const keys = Record.keys(value)
	return (
		Arr.every(keys, (key, at) => at === 0 || (keys[at - 1] ?? "") < key) &&
		Arr.every(Record.values(value), keysSorted)
	)
}

/** Whether every object of the printed text lists its fields in alphabetical order. */
export const fieldsAlphabetical = (text: string) => Effect.map(decodeTree(text), keysSorted)
