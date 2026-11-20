/**
 * What the property of command-names.test.ts reads: up to three operations, each at its own path with its own words so
 * no two of their names collide, each named by one source (Fern's or Forge's extensions, a tag and its operationId, the
 * author config, an operationId alone, or its route, tagged or not), with up to two `x-forge-aliases` entries, each in
 * a group of its own or beside its primary, named by Forge or Fern, or at the root by an operationId of its own, and
 * with a request body emitCli cannot express or none; the author config adds a scheme or none. The model is design
 * 8.1's `commandNames`, in design 8.3's command order, beside the report's refusals and its author-supplied schemes.
 */

import {
	aimed,
	type Aimed,
	constant,
	element,
	type Gen,
	option,
	subset,
	weighted
} from "@bjornpagen/testing/gen"
import { jsonText, type Json } from "@bjornpagen/grizzle-text/utf8"
import { Array as Arr, Effect, FileSystem, Option, Path, Record } from "effect"
import { generate } from "#generate.ts"
import { fixedDocumentUri } from "#model/brands.ts"
import { formatPointer } from "#model/pointer.ts"
import type { CommandNameSource, GroupNameSource } from "#names/plan.ts"

/** An operation's place: its path, method and words are the slot's alone. */
type Slot = 0 | 1 | 2

/** How an operation's primary command is named: one source, its group and command as that source gives them. */
type Primary =
	| Readonly<{ source: "x-fern" }>
	| Readonly<{ source: "x-forge"; nested: boolean }>
	| Readonly<{ source: "tag" }>
	| Readonly<{ source: "config" }>
	| Readonly<{ source: "operationId" }>
	| Readonly<{ source: "route"; tagged: boolean }>

/**
 * One usable `x-forge-aliases` entry: named by Forge's or Fern's keys, a group and a method, or by an operationId of its
 * own at the root, since an entry naming no group is usable only so (normalize/operations.ts aliasOf).
 */
type Alias =
	| Readonly<{ source: "x-forge" | "x-fern"; group: Arr.NonEmptyReadonlyArray<string> }>
	| Readonly<{ source: "operationId" }>

type OperationCase = Readonly<{
	slot: Slot
	primary: Primary
	aliases: ReadonlyArray<Alias>
	refused: boolean
}>

/** The operations in slot order, and the scheme the author config adds. */
export type NamesCase = Readonly<{
	operations: ReadonlyArray<OperationCase>
	scheme: Option.Option<string>
}>

/** A name as an extension or the author config spells it, and the command name it folds to. */
type Spelled = readonly [spelled: string, folded: string]

/** One slot's words: its route, and the names each source gives its operation and its aliases. */
type Words = Readonly<{
	path: string
	method: "get" | "post" | "patch"
	route: string
	operationId: Spelled
	tag: string
	fern: Readonly<{ group: string; method: Spelled }>
	forge: Readonly<{
		group: string
		nested: readonly [outer: string, inner: string]
		method: string
	}>
	config: Readonly<{ group: string; command: string }>
	aliases: readonly [
		Readonly<{ group: string; method: Spelled; operationId: Spelled }>,
		Readonly<{ group: string; method: Spelled; operationId: Spelled }>
	]
}>

const WORDS: Readonly<Record<Slot, Words>> = {
	0: {
		path: "/alpha",
		method: "get",
		route: "get-alpha",
		operationId: ["listTagged", "list-tagged"],
		tag: "things",
		fern: { group: "billing", method: ["getInvoice", "get-invoice"] },
		forge: { group: "zones", nested: ["accounts", "members"], method: "edit" },
		config: { group: "inventory", command: "show-all" },
		aliases: [
			{ group: "dns", method: ["editZone", "edit-zone"], operationId: ["pauseZone", "pause-zone"] },
			{
				group: "legacy",
				method: ["updateZone", "update-zone"],
				operationId: ["haltZone", "halt-zone"]
			}
		]
	},
	1: {
		path: "/beta",
		method: "post",
		route: "post-beta",
		operationId: ["createNote", "create-note"],
		tag: "notes",
		fern: { group: "ledger", method: ["postEntry", "post-entry"] },
		forge: { group: "sites", nested: ["teams", "seats"], method: "add" },
		config: { group: "storage", command: "put-all" },
		aliases: [
			{ group: "memo", method: ["addMemo", "add-memo"], operationId: ["pinNote", "pin-note"] },
			{
				group: "archive",
				method: ["fileNote", "file-note"],
				operationId: ["dropNote", "drop-note"]
			}
		]
	},
	2: {
		path: "/gamma",
		method: "patch",
		route: "patch-gamma",
		operationId: ["renameItem", "rename-item"],
		tag: "items",
		fern: { group: "catalog", method: ["patchItem", "patch-item"] },
		forge: { group: "shelves", nested: ["vaults", "boxes"], method: "move" },
		config: { group: "stock", command: "relabel" },
		aliases: [
			{
				group: "labels",
				method: ["markItem", "mark-item"],
				operationId: ["lockItem", "lock-item"]
			},
			{ group: "bins", method: ["binItem", "bin-item"], operationId: ["wipeItem", "wipe-item"] }
		]
	}
}

const document = fixedDocumentUri("file:///names/openapi.json")

const configDocument = fixedDocumentUri("file:///names/author-config.json")

const pointerOf = (op: OperationCase): string => {
	const words = WORDS[op.slot]
	return formatPointer(["paths", words.path, words.method])
}

/** The group segments and the command a primary is named by, with the source of each. */
type Named = Readonly<{
	segments: ReadonlyArray<string>
	command: string
	group: GroupNameSource
	source: CommandNameSource
}>

const primaryNamed = (words: Words, primary: Primary): Named => {
	switch (primary.source) {
		case "x-fern":
			return {
				segments: [words.fern.group],
				command: words.fern.method[1],
				group: "x-fern",
				source: "x-fern"
			}
		case "x-forge":
			return {
				segments: primary.nested ? words.forge.nested : [words.forge.group],
				command: words.forge.method,
				group: "x-forge",
				source: "x-forge"
			}
		case "tag":
			return {
				segments: [words.tag],
				command: words.operationId[1],
				group: "tag",
				source: "operationId"
			}
		case "config":
			return {
				segments: [words.config.group],
				command: words.config.command,
				group: "config",
				source: "config"
			}
		case "operationId":
			return { segments: [], command: words.operationId[1], group: "none", source: "operationId" }
		case "route":
			return primary.tagged
				? { segments: [words.tag], command: words.route, group: "tag", source: "route" }
				: { segments: [], command: words.route, group: "none", source: "route" }
	}
}

const aliasIndexes = [0, 1] as const

/** Each alias with its index, the first two at most. */
const indexed = (op: OperationCase): ReadonlyArray<readonly [Alias, 0 | 1]> =>
	Arr.zip(op.aliases, aliasIndexes)

const aliasNamed = (words: Words, alias: Alias, index: 0 | 1): Named =>
	alias.source === "operationId"
		? {
				segments: [],
				command: words.aliases[index].operationId[1],
				group: "none",
				source: "operationId"
			}
		: {
				segments: alias.group,
				command: words.aliases[index].method[1],
				group: alias.source,
				source: alias.source
			}

/** One command of the model: its operation, its names, and its alias index. */
type Entry = Readonly<{ op: OperationCase; named: Named; alias: Option.Option<0 | 1> }>

/** An operation's commands in plan order: its primary, then its aliases in their order. */
const entriesOf = (op: OperationCase): ReadonlyArray<Entry> => {
	const words = WORDS[op.slot]
	const primary = primaryNamed(words, op.primary)
	return [
		{ op, named: primary, alias: Option.none() },
		...Arr.map(indexed(op), ([alias, index]) => ({
			op,
			named: aliasNamed(words, alias, index),
			alias: Option.some(index)
		}))
	]
}

const keyOf = (segments: ReadonlyArray<string>): string => Arr.join(segments, "/")

/**
 * Design 8.3's command order: the groups in first-use order over the commands in plan order, each group's commands
 * before its child groups, then the root's commands.
 */
const commandOrder = (entries: ReadonlyArray<Entry>): ReadonlyArray<Entry> => {
	const groups = Arr.dedupeWith(
		Arr.flatMap(entries, (entry) =>
			Arr.map(entry.named.segments, (_, index) => Arr.take(entry.named.segments, index + 1))
		),
		(left: ReadonlyArray<string>, right: ReadonlyArray<string>) => keyOf(left) === keyOf(right)
	)
	const walk = (group: ReadonlyArray<string>): ReadonlyArray<Entry> => [
		...Arr.filter(entries, (entry) => keyOf(entry.named.segments) === keyOf(group)),
		...Arr.flatMap(
			Arr.filter(
				groups,
				(child) =>
					child.length === group.length + 1 && keyOf(Arr.take(child, group.length)) === keyOf(group)
			),
			walk
		)
	]
	return [
		...Arr.flatMap(
			Arr.filter(groups, (group) => group.length === 1),
			walk
		),
		...Arr.filter(entries, (entry) => entry.named.segments.length === 0)
	]
}

/** One listed command as the property compares it. */
type Listed = Readonly<{
	path: ReadonlyArray<string>
	group: GroupNameSource
	command: CommandNameSource
	alias: Option.Option<number>
	document: string
	pointer: string
}>

/** What the report holds of a run: its command names, its refusals by code and pointer, its author-supplied schemes. */
export type Outcome = Readonly<{
	commandNames: ReadonlyArray<Listed>
	refusals: ReadonlyArray<readonly [code: string, pointer: string]>
	authorSuppliedSchemes: Option.Option<ReadonlyArray<Readonly<{ key: string; name: string }>>>
}>

const emitted = (c: NamesCase): ReadonlyArray<Entry> =>
	Arr.filter(commandOrder(Arr.flatMap(c.operations, entriesOf)), (entry) => !entry.op.refused)

/**
 * Design 8.1: every emitted command in command order, with its visible path, its operation's use site, the source of
 * each of its names and an alias's index; one `EMT-1/unsupported-body` refusal at each operation whose body emitCli
 * cannot express, none of whose names is listed; and each scheme the author config adds, keyed by its config key, with
 * the field absent when it adds none.
 */
export const expectedOf = (c: NamesCase): Outcome => ({
	commandNames: Arr.map(emitted(c), (entry) => ({
		path: [...entry.named.segments, entry.named.command],
		group: entry.named.group,
		command: entry.named.source,
		alias: entry.alias,
		document,
		pointer: pointerOf(entry.op)
	})),
	refusals: Arr.map(
		Arr.filter(c.operations, (op) => op.refused),
		(op) => ["EMT-1/unsupported-body", pointerOf(op)] as const
	),
	authorSuppliedSchemes: Option.map(c.scheme, (name) => [
		{ key: `security.add.schemes.${name}`, name }
	])
})

const primaryFields = (words: Words, primary: Primary): Readonly<Record<string, Json>> => {
	switch (primary.source) {
		case "x-fern":
			return {
				operationId: words.operationId[0],
				"x-fern-sdk-group-name": words.fern.group,
				"x-fern-sdk-method-name": words.fern.method[0]
			}
		case "x-forge":
			return {
				operationId: words.operationId[0],
				"x-fern-sdk-method-name": "ignored",
				"x-forge-group-name": primary.nested
					? Arr.join(words.forge.nested, ".")
					: words.forge.group,
				"x-forge-method-name": words.forge.method
			}
		case "tag":
		case "config":
			return { operationId: words.operationId[0], tags: [words.tag] }
		case "operationId":
			return { operationId: words.operationId[0] }
		case "route":
			return primary.tagged ? { tags: [words.tag] } : {}
	}
}

const EXTENSION_KEYS = {
	"x-forge": { group: "x-forge-group-name", method: "x-forge-method-name" },
	"x-fern": { group: "x-fern-sdk-group-name", method: "x-fern-sdk-method-name" }
} as const

const aliasJson = (words: Words, alias: Alias, index: 0 | 1): Json => {
	if (alias.source === "operationId") {
		return { operationId: words.aliases[index].operationId[0] }
	}
	const keys = EXTENSION_KEYS[alias.source]
	return {
		[keys.group]: Arr.join(alias.group, "."),
		[keys.method]: words.aliases[index].method[0]
	}
}

const UNSUPPORTED_BODY: Json = {
	content: { "text/event-stream": { schema: { type: "string" } } },
	required: true
}

const operationJson = (op: OperationCase): Json => {
	const words = WORDS[op.slot]
	return {
		responses: { "200": { description: "ok" } },
		...primaryFields(words, op.primary),
		...(Arr.isReadonlyArrayNonEmpty(op.aliases)
			? {
					"x-forge-aliases": Arr.map(indexed(op), ([alias, index]) =>
						aliasJson(words, alias, index)
					)
				}
			: {}),
		...(op.refused ? { requestBody: UNSUPPORTED_BODY } : {})
	}
}

const documentJson = (c: NamesCase): Json => ({
	info: { title: "names", version: "1" },
	openapi: "3.1.1",
	paths: Record.fromEntries(
		Arr.map(c.operations, (op) => {
			const words = WORDS[op.slot]
			return [words.path, { [words.method]: operationJson(op) }] as const
		})
	)
})

const configJson = (c: NamesCase): Json => {
	const overrides = Arr.flatMap(c.operations, (op) => {
		const words = WORDS[op.slot]
		return op.primary.source === "config"
			? [
					[
						words.operationId[0],
						{ command: words.config.command, group: words.config.group }
					] as const
				]
			: []
	})
	return {
		binName: "example",
		package: { name: "example-cli", version: "1.0.0" },
		...(Arr.isReadonlyArrayNonEmpty(overrides)
			? { naming: { operations: Record.fromEntries(overrides) } }
			: {}),
		...Option.match(c.scheme, {
			onNone: () => ({}),
			onSome: (name) => ({
				security: {
					add: {
						requirement: [{ [name]: [] }],
						schemes: { [name]: { scheme: "bearer", type: "http" } }
					}
				}
			})
		})
	}
}

/** Generates the case's document and config under `dir` and reads the report generate writes. */
export const outcomeOf = (c: NamesCase, dir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const specPath = path.join(dir, "openapi.json")
		const configPath = path.join(dir, "author-config.json")
		yield* fs.writeFileString(specPath, jsonText(documentJson(c)))
		yield* fs.writeFileString(configPath, jsonText(configJson(c)))
		const { report } = yield* generate(
			{
				document,
				outDir: path.join(dir, "out"),
				source: { _tag: "File", path: specPath },
				strict: false
			},
			{ document: configDocument, path: configPath }
		)
		const outcome: Outcome = {
			commandNames: Arr.map(report.commandNames, (name) => ({
				path: name.path,
				group: name.group,
				command: name.command,
				alias: Option.fromUndefinedOr(name.alias),
				document: name.document,
				pointer: name.pointer
			})),
			refusals: Arr.map(report.refusals, (refusal): readonly [code: string, pointer: string] => [
				refusal.code,
				refusal.pointer
			]),
			authorSuppliedSchemes: Option.fromUndefinedOr(report.authorSuppliedSchemes)
		}
		return outcome
	})

export type NamesFeature =
	| `a command named by ${CommandNameSource}`
	| `a group named by ${GroupNameSource}`
	| "a nested group"
	| "an alias in a group of its own"
	| "an alias at the root"
	| "an alias beside its primary"
	| "a second alias"
	| "a group's commands before its child group"
	| "a root command before a group's in plan order"
	| "an operation emitCli refuses"
	| "an author-supplied scheme"

const isPrefix = (prefix: ReadonlyArray<string>, segments: ReadonlyArray<string>): boolean =>
	segments.length > prefix.length && keyOf(Arr.take(segments, prefix.length)) === keyOf(prefix)

/** Where an alias's group is: the root, its primary's top-level group, or a group of its own. */
const placedOf = (op: OperationCase, alias: Alias): NamesFeature => {
	if (alias.source === "operationId") {
		return "an alias at the root"
	}
	const primary = primaryNamed(WORDS[op.slot], op.primary)
	return keyOf(alias.group) === keyOf(Arr.take(primary.segments, 1))
		? "an alias beside its primary"
		: "an alias in a group of its own"
}

/** The situations a case's emitted commands, refusals and scheme reach. */
export const featuresOf = (c: NamesCase): ReadonlyArray<NamesFeature> => {
	const listed = Arr.filter(Arr.flatMap(c.operations, entriesOf), (entry) => !entry.op.refused)
	const grouped = Arr.filter(listed, (entry) => Arr.isReadonlyArrayNonEmpty(entry.named.segments))
	const firstGrouped = Arr.findFirstIndex(listed, (entry) =>
		Arr.isReadonlyArrayNonEmpty(entry.named.segments)
	)
	const firstRoot = Arr.findFirstIndex(listed, (entry) => entry.named.segments.length === 0)
	return Arr.dedupe([
		...Arr.flatMap(listed, (entry): ReadonlyArray<NamesFeature> => [
			`a command named by ${entry.named.source}`,
			`a group named by ${entry.named.group}`,
			...(entry.named.segments.length > 1 ? ["a nested group" as const] : []),
			...Option.match(entry.alias, {
				onNone: () => [],
				onSome: (index) => (index === 1 ? ["a second alias" as const] : [])
			})
		]),
		...Arr.flatMap(c.operations, (op) =>
			op.refused ? [] : Arr.map(op.aliases, (alias) => placedOf(op, alias))
		),
		...(Arr.some(grouped, (parent) =>
			Arr.some(grouped, (child) => isPrefix(parent.named.segments, child.named.segments))
		)
			? ["a group's commands before its child group" as const]
			: []),
		...(Option.isSome(firstRoot) &&
		Option.isSome(firstGrouped) &&
		firstRoot.value < firstGrouped.value
			? ["a root command before a group's in plan order" as const]
			: []),
		...(Arr.some(c.operations, (op) => op.refused)
			? ["an operation emitCli refuses" as const]
			: []),
		...(Option.isSome(c.scheme) ? ["an author-supplied scheme" as const] : [])
	])
}

const SLOTS: ReadonlyArray<Slot> = [0, 1, 2]

const anySlot = element<Slot>([0, 1, 2])

const anyPrimary = element<Primary>([
	{ source: "x-fern" },
	{ source: "x-forge", nested: false },
	{ source: "x-forge", nested: true },
	{ source: "tag" },
	{ source: "config" },
	{ source: "operationId" },
	{ source: "route", tagged: false },
	{ source: "route", tagged: true }
])

const anyExtension = element(["x-forge", "x-fern"] as const)

/** An alias in a group of its own, at the root, or beside its primary when the primary has a group. */
const aliasAt =
	(slot: Slot, primary: Primary, index: 0 | 1): Gen<Alias> =>
	(s) => {
		const words = WORDS[slot]
		const own: Alias = { source: s.draw(anyExtension), group: [words.aliases[index].group] }
		const root: Alias = { source: "operationId" }
		return Arr.match(Arr.take(primaryNamed(words, primary).segments, 1), {
			onEmpty: () => s.draw(element([own, root])),
			onNonEmpty: (top) =>
				s.draw(element([own, root, { source: s.draw(anyExtension), group: top }]))
		})
	}

const anyRefused = weighted([
	[3, constant(false)],
	[1, constant(true)]
])

const anyScheme = option(element(["token", "session"]))

const operationAt =
	(slot: Slot): Gen<OperationCase> =>
	(s) => {
		const primary = s.draw(anyPrimary)
		const count = s.draw(element([0, 1, 2] as const))
		return {
			slot,
			primary,
			aliases: Arr.map(Arr.take(aliasIndexes, count), (index) =>
				s.draw(aliasAt(slot, primary, index))
			),
			refused: s.draw(anyRefused)
		}
	}

const anyCase: Gen<NamesCase> = (s) => ({
	operations: Arr.map(s.draw(subset(SLOTS, { min: 1, max: 3 })), (slot) =>
		s.draw(operationAt(slot))
	),
	scheme: s.draw(anyScheme)
})

/** One emitted operation at a drawn slot, as `shape` states it from the slot's words, and a drawn scheme. */
const single =
	(shape: (words: Words) => Omit<OperationCase, "slot">): Gen<NamesCase> =>
	(s) => {
		const slot = s.draw(anySlot)
		return { operations: [{ slot, ...shape(WORDS[slot]) }], scheme: s.draw(anyScheme) }
	}

const primaryOnly = (primary: Primary): Gen<NamesCase> =>
	single(() => ({ primary, aliases: [], refused: false }))

/** Cases aimed at every naming source, each alias placement, nesting, the walk's order, a refusal and a scheme. */
export const namesSpace: Aimed<NamesCase, NamesFeature> = aimed(anyCase, [
	["a command named by config", primaryOnly({ source: "config" })],
	["a command named by operationId", primaryOnly({ source: "tag" })],
	["a command named by route", primaryOnly({ source: "route", tagged: false })],
	["a command named by x-fern", primaryOnly({ source: "x-fern" })],
	["a command named by x-forge", primaryOnly({ source: "x-forge", nested: false })],
	["a group named by config", primaryOnly({ source: "config" })],
	["a group named by none", primaryOnly({ source: "operationId" })],
	["a group named by tag", primaryOnly({ source: "route", tagged: true })],
	["a group named by x-fern", primaryOnly({ source: "x-fern" })],
	["a group named by x-forge", primaryOnly({ source: "x-forge", nested: false })],
	["a nested group", primaryOnly({ source: "x-forge", nested: true })],
	[
		"an alias in a group of its own",
		single((words) => ({
			primary: { source: "tag" },
			aliases: [{ source: "x-forge", group: [words.aliases[0].group] }],
			refused: false
		}))
	],
	[
		"an alias at the root",
		single(() => ({
			primary: { source: "x-fern" },
			aliases: [{ source: "operationId" }],
			refused: false
		}))
	],
	[
		"an alias beside its primary",
		single((words) => ({
			primary: { source: "x-fern" },
			aliases: [{ source: "x-forge", group: [words.fern.group] }],
			refused: false
		}))
	],
	[
		"a second alias",
		single((words) => ({
			primary: { source: "x-forge", nested: false },
			aliases: [
				{ source: "x-forge", group: [words.aliases[0].group] },
				{ source: "x-fern", group: [words.aliases[1].group] }
			],
			refused: false
		}))
	],
	[
		"a group's commands before its child group",
		single((words) => ({
			primary: { source: "x-forge", nested: true },
			aliases: [{ source: "x-fern", group: [words.forge.nested[0]] }],
			refused: false
		}))
	],
	[
		"a root command before a group's in plan order",
		(s) => ({
			operations: [
				{ slot: 0, primary: { source: "operationId" }, aliases: [], refused: false },
				{ slot: 1, primary: { source: "tag" }, aliases: [], refused: false }
			],
			scheme: s.draw(anyScheme)
		})
	],
	[
		"an operation emitCli refuses",
		(s) => ({
			operations: [
				{
					slot: 0,
					primary: { source: "tag" },
					aliases: [{ source: "x-forge", group: [WORDS[0].aliases[0].group] }],
					refused: true
				},
				s.draw(operationAt(1))
			],
			scheme: s.draw(anyScheme)
		})
	],
	["an author-supplied scheme", (s) => ({ ...s.draw(anyCase), scheme: Option.some("token") })]
])
