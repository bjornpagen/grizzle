/**
 * The domain module as a property. A generated set of JSON Schema definitions, some reachable from the request roots
 * and some not, prints to `domain/schemas.ts`, which TypeScript parses with no syntax diagnostic and oxfmt, under the
 * options docs/printer.md names, leaves unchanged. It exports exactly the reachable definitions, each under the name
 * the identifier map gives it and each after every definition it reads outside a `Schema.suspend`; the same set in
 * another order prints the same bytes; no `default`, `example` or `examples` value reaches it; and no reachable
 * definition prints the empty module. A planted fault is refused with its reason: a reachable definition that is no
 * schema object, one the importer rejects, a reachable key the identifier map leaves out, two reachable keys given one
 * name, and a name Effect would export differently.
 *
 * Plants, each applied to src/emit/domain.ts, seen to fail this suite and reverted: none yet.
 */
import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { drawn, explore } from "@superstarter/testing/explore"
import { required } from "@superstarter/testing/features"
import {
	boolean,
	element,
	type Gen,
	int,
	map,
	oneOf,
	shuffled,
	subarray,
	uniqueArray,
	weighted
} from "@superstarter/testing/gen"
import { notesOnly } from "@superstarter/testing/sense"
import { searched } from "@superstarter/testing/vitest"
import {
	Array as Arr,
	Cause,
	Duration,
	Effect,
	Exit,
	Formatter,
	Option,
	Order,
	Predicate,
	Record,
	String as Str
} from "effect"
import { format } from "oxfmt"
import type { FormatConfig } from "oxfmt"
import {
	type Node,
	type SourceFile,
	ScriptKind,
	isArrowFunction,
	isIdentifier,
	isTypeAliasDeclaration,
	isVariableStatement
} from "typescript/ast"
import { API } from "typescript/sync"
import { emitDomainSchemas } from "#emit/domain.ts"
import type { Json } from "#model/pointer.ts"
import { domainIdentifiers } from "#names/domain.ts"
import { SafeIdentifier } from "#names/fold.ts"
import { defaultLimits } from "#resolve/index.ts"

const FORMAT_OPTIONS: FormatConfig = {
	jsdoc: { commentLineStrategy: "multiline", lineWrappingStyle: "balance" }
}

/** Definition keys: short, long past the line, folding to the same stem, and named like Effect's own exports. */
const KEYS: Arr.NonEmptyReadonlyArray<string> = [
	"User",
	"user_update",
	"my-schema",
	"Schema",
	"Command",
	"Customer_balance_resource_cash_balance_transaction_resource_applied_to_payment_transaction",
	"D0",
	"D1",
	"Tag"
]

const PROPERTY_KEYS: Arr.NonEmptyReadonlyArray<string> = [
	"id",
	"name",
	"total_pretax_credit_amounts",
	"weird key",
	"x",
	"é"
]

/** A value no definition may carry into the module. */
const SENTINEL = "never-printed-annotation"

const ref = (key: string): Json => ({ $ref: `#/$defs/${key}` })

const annotations: Gen<Readonly<Record<string, Json>>> = (s) =>
	Record.fromEntries(
		Arr.map(
			s.draw(subarray(["default", "example", "examples"])),
			(key) => [key, key === "examples" ? [SENTINEL] : SENTINEL] as const
		)
	)

const leafGen = (keys: Arr.NonEmptyReadonlyArray<string>): Gen<Json> =>
	weighted<Json>([
		[2, () => ({ type: "string" })],
		[1, (s) => ({ type: "string", minLength: s.draw(int(0, 3)), maxLength: s.draw(int(4, 9)) })],
		[1, () => ({ type: "integer" })],
		[1, () => ({ type: "boolean" })],
		[
			1,
			(s) => ({
				enum: Arr.map(
					Arr.range(0, s.draw(int(1, 10))),
					(index) => `${s.draw(element(["s", "a_much_longer_state_name"]))}_${index}`
				)
			})
		],
		[3, map(element(keys), ref)]
	])

const nodeGen = (keys: Arr.NonEmptyReadonlyArray<string>, depth: number): Gen<Json> =>
	depth === 0
		? leafGen(keys)
		: weighted<Json>([
				[3, leafGen(keys)],
				[1, (s) => ({ type: "array", items: s.draw(nodeGen(keys, depth - 1)) })],
				[
					1,
					(s) => ({
						anyOf: s.draw(
							shuffled([s.draw(nodeGen(keys, depth - 1)), { type: "null" }], { min: 2, max: 2 })
						)
					})
				],
				[1, (s) => ({ type: ["array", "null"], items: s.draw(map(element(keys), ref)) })],
				[1, (s) => ({ type: "object", additionalProperties: s.draw(nodeGen(keys, depth - 1)) })],
				[1, (s) => ({ anyOf: [s.draw(map(element(keys), ref)), s.draw(map(element(keys), ref))] })],
				[2, objectGen(keys, depth - 1)]
			])

const objectGen =
	(keys: Arr.NonEmptyReadonlyArray<string>, depth: number): Gen<Json> =>
	(s) => {
		const properties = s.draw(
			uniqueArray(
				element(PROPERTY_KEYS),
				(key) => map(nodeGen(keys, depth), (node) => [key, node] as const),
				{ min: 0, max: 4 }
			)
		)
		return {
			type: "object",
			properties: Record.fromEntries(properties),
			required: s.draw(subarray(Arr.map(properties, ([key]) => key))),
			...(s.draw(boolean) ? { additionalProperties: false } : {}),
			...s.draw(annotations)
		}
	}

/** A definition set: its keys in a drawn order, each with its schema, the roots, and the set in another order. */
type DomainCase = Readonly<{
	definitions: Arr.NonEmptyReadonlyArray<readonly [string, Json]>
	roots: ReadonlyArray<string>
	reordered: ReadonlyArray<readonly [string, Json]>
}>

const caseGen: Gen<DomainCase> = (s) => {
	const first = s.draw(element(KEYS))
	const keys: Arr.NonEmptyReadonlyArray<string> = [
		first,
		...s.draw(
			shuffled(
				Arr.filter(KEYS, (key) => key !== first),
				{ min: 0, max: 5 }
			)
		)
	]
	const definitions = Arr.map(
		keys,
		(key) =>
			[
				key,
				s.draw(
					weighted<Json>([
						[3, objectGen(keys, 1)],
						[1, nodeGen(keys, 2)]
					])
				)
			] as const
	)
	return {
		definitions,
		roots: s.draw(subarray(keys)),
		reordered: s.draw(shuffled(definitions, { min: definitions.length, max: definitions.length }))
	}
}

const isList = (value: Json): value is ReadonlyArray<Json> => Arr.isArray(value)

const isObject = (value: Json): value is Readonly<Record<string, Json>> =>
	Predicate.isObject(value) && !isList(value)

/** Every `$ref` key a schema reads, at any depth. */
const referencesOf = (schema: Json): ReadonlyArray<string> => {
	if (isList(schema)) {
		return Arr.flatMap(schema, referencesOf)
	}
	if (!isObject(schema)) {
		return []
	}
	const own = Option.match(Record.get(schema, "$ref"), {
		onNone: () => [],
		onSome: (target) => (Predicate.isString(target) ? [Str.slice("#/$defs/".length)(target)] : [])
	})
	return [...own, ...Arr.flatMap(Record.values(schema), referencesOf)]
}

/** The keys reachable from the roots through `$ref`, each once. */
const reachableFrom = (
	definitions: ReadonlyArray<readonly [string, Json]>,
	roots: ReadonlyArray<string>
): ReadonlyArray<string> => {
	const readsOf = (key: string): ReadonlyArray<string> =>
		Arr.flatMap(definitions, ([name, schema]) => (name === key ? referencesOf(schema) : []))
	const walk = (
		seen: ReadonlyArray<string>,
		pending: ReadonlyArray<string>
	): ReadonlyArray<string> =>
		Option.match(Arr.head(pending), {
			onNone: () => seen,
			onSome: (key) =>
				Arr.contains(seen, key)
					? walk(seen, Arr.drop(pending, 1))
					: walk([...seen, key], [...Arr.drop(pending, 1), ...readsOf(key)])
		})
	return walk([], roots)
}

/** One exported definition as printed: its name, and the names it reads outside an arrow function. */
type Exported = Readonly<{ name: string; reads: ReadonlyArray<string> }>

const eagerReads = (node: Node): ReadonlyArray<string> =>
	isArrowFunction(node)
		? []
		: [
				...(isIdentifier(node) ? [node.text] : []),
				...Arr.flatMap(Arr.fromIterable(node.childrenIter()), eagerReads)
			]

/** The module's exported constants in order, and its exported type aliases. */
const exportsOf = (
	file: SourceFile
): Readonly<{ constants: ReadonlyArray<Exported>; types: ReadonlyArray<string> }> => ({
	constants: Arr.flatMap(file.statements, (statement) =>
		isVariableStatement(statement)
			? Arr.flatMap(statement.declarationList.declarations, (declaration) =>
					isIdentifier(declaration.name) && declaration.initializer !== undefined
						? [{ name: declaration.name.text, reads: eagerReads(declaration.initializer) }]
						: []
				)
			: []
	),
	types: Arr.flatMap(file.statements, (statement) =>
		isTypeAliasDeclaration(statement) ? [statement.name.text] : []
	)
})

/** Each exported constant that reads another before that one is declared. */
const outOfOrder = (constants: ReadonlyArray<Exported>): ReadonlyArray<string> => {
	const names = Arr.map(constants, (constant) => constant.name)
	return Arr.getSomes(
		Arr.map(constants, (constant, index) =>
			Arr.some(
				constant.reads,
				(read) => Arr.contains(names, read) && !Arr.contains(Arr.take(names, index), read)
			)
				? Option.some(constant.name)
				: Option.none()
		)
	)
}

const identifiersOf = (definitions: ReadonlyArray<readonly [string, Json]>) =>
	domainIdentifiers(Arr.map(definitions, ([key]) => key))

const emitted = (
	definitions: ReadonlyArray<readonly [string, Json]>,
	roots: ReadonlyArray<string>,
	identifiers: ReturnType<typeof domainIdentifiers>
) => emitDomainSchemas(new Map(definitions), roots, identifiers, defaultLimits)

type Feature =
	| "the empty module"
	| "a recursive definition"
	| "mutually recursive definitions"
	| "an unreachable definition"
	| "an annotation left out"
	| "a long name"
	| "a folded name"
	| "a name Effect also exports"
	| "a closed object"
	| "a nullable member"

const typescript = Effect.acquireRelease(
	Effect.sync(() => new API()),
	(api) => Effect.sync(() => api.close())
)

const parsedExports = (api: API, text: string) =>
	Effect.acquireUseRelease(
		Effect.sync(() => api.createSourceFile("/schemas.ts", text, { scriptKind: ScriptKind.TS })),
		(retained) => Effect.sync(() => exportsOf(retained.sourceFile)),
		(retained) => Effect.sync(() => retained.dispose())
	)

const featuresOf = (
	drawnCase: DomainCase,
	reachable: ReadonlyArray<string>,
	text: string,
	types: ReadonlyArray<string>
): ReadonlyArray<Feature> => {
	const readsItself = (key: string) =>
		Arr.contains(
			reachableFrom(
				drawnCase.definitions,
				Arr.flatMap(drawnCase.definitions, ([name, schema]) =>
					name === key ? referencesOf(schema) : []
				)
			),
			key
		)
	const keysOf = (schema: Json): ReadonlyArray<string> =>
		isList(schema)
			? Arr.flatMap(schema, keysOf)
			: isObject(schema)
				? [...Record.keys(schema), ...Arr.flatMap(Record.values(schema), keysOf)]
				: []
	const keys = Arr.flatMap(drawnCase.definitions, ([, schema]) => keysOf(schema))
	return [
		...(text === "export {};\n" ? (["the empty module"] as const) : []),
		...(Arr.some(reachable, readsItself) ? (["a recursive definition"] as const) : []),
		...(types.length > 1 ? (["mutually recursive definitions"] as const) : []),
		...(reachable.length < drawnCase.definitions.length
			? (["an unreachable definition"] as const)
			: []),
		...(Arr.some(keys, (key) => key === "default" || key === "example" || key === "examples")
			? (["an annotation left out"] as const)
			: []),
		...(Arr.some(reachable, (key) => key.length > 60) ? (["a long name"] as const) : []),
		...(Arr.some(reachable, (key) => Str.includes("_")(key) || Str.includes("-")(key))
			? (["a folded name"] as const)
			: []),
		...(Arr.some(reachable, (key) => key === "Schema" || key === "Command")
			? (["a name Effect also exports"] as const)
			: []),
		...(Arr.contains(keys, "additionalProperties") ? (["a closed object"] as const) : []),
		...(Str.includes("Schema.NullOr")(text) || Str.includes("Schema.Null")(text)
			? (["a nullable member"] as const)
			: [])
	]
}

type Fault =
	| "a definition that is no schema object"
	| "a schema the importer rejects"
	| "a key the identifier map leaves out"
	| "two keys given one name"
	| "a name Effect exports differently"

type Reason = "identifier-mismatch" | "import-failed" | "unsupported-definition"

/** A definition set with one planted fault on a reachable key, and the reason it must be refused for. */
type Planted = Readonly<{
	definitions: ReadonlyArray<readonly [string, Json]>
	roots: ReadonlyArray<string>
	identifiers: ReturnType<typeof domainIdentifiers>
	fault: Fault
	reason: Reason
}>

const plantedGen: Gen<Planted> = (s) => {
	const base = s.draw(caseGen)
	const [[root], ...others] = base.definitions
	const replaced = (schema: Json) => [[root, schema] as const, ...others]
	const identifiers = identifiersOf(base.definitions)
	const roots = [root, ...Arr.filter(base.roots, (key) => key !== root)]
	return s.draw(
		oneOf<Planted>([
			() => ({
				definitions: replaced(true),
				roots,
				identifiers,
				fault: "a definition that is no schema object",
				reason: "unsupported-definition"
			}),
			() => ({
				definitions: replaced({ not: { type: "string" } }),
				roots,
				identifiers,
				fault: "a schema the importer rejects",
				reason: "import-failed"
			}),
			() => ({
				definitions: replaced({ type: "string" }),
				roots,
				identifiers: new Map(Arr.filter(Arr.fromIterable(identifiers), ([key]) => key !== root)),
				fault: "a key the identifier map leaves out",
				reason: "identifier-mismatch"
			}),
			() => ({
				definitions: [[root, { type: "string" }], ["Other", { type: "integer" }], ...others],
				roots: [root, "Other", ...Arr.filter(base.roots, (key) => key !== root)],
				identifiers: new Map([
					...Arr.fromIterable(identifiers),
					[root, SafeIdentifier.make("Shared")],
					["Other", SafeIdentifier.make("Shared")]
				]),
				fault: "two keys given one name",
				reason: "identifier-mismatch"
			}),
			() => ({
				definitions: replaced({ type: "string" }),
				roots,
				identifiers: new Map([
					...Arr.fromIterable(identifiers),
					[root, SafeIdentifier.make("Schema")]
				]),
				fault: "a name Effect exports differently",
				reason: "identifier-mismatch"
			})
		])
	)
}

describe("emit: the domain module", () => {
	it.effect(
		"a definition set prints its reachable definitions in dependency order, the same in any order, in the layout the formatter keeps",
		(ctx) =>
			searched(
				ctx,
				Effect.scoped(
					Effect.gen(function* () {
						const api = yield* typescript
						return yield* explore(
							{
								suite: "domain module",
								draw: drawn(caseGen),
								literal: Formatter.format,
								coverage: required<Feature>(
									[
										"the empty module",
										"a recursive definition",
										"mutually recursive definitions",
										"an unreachable definition",
										"an annotation left out",
										"a long name",
										"a folded name",
										"a name Effect also exports",
										"a closed object",
										"a nullable member"
									],
									{ cases: 800, sense: notesOnly }
								),
								kept: [],
								runs: 200,
								shrink: { kind: "bounded", candidates: 200 },
								concurrency: 1,
								steerEvery: 100,
								caseHang: Duration.seconds(20)
							},
							(drawnCase, k) =>
								Effect.gen(function* () {
									const identifiers = identifiersOf(drawnCase.definitions)
									const file = yield* emitted(drawnCase.definitions, drawnCase.roots, identifiers)
									const again = yield* emitted(drawnCase.reordered, drawnCase.roots, identifiers)
									const formatted = yield* Effect.promise(() =>
										format("schemas.ts", file.content, FORMAT_OPTIONS)
									)
									const syntax =
										api.transpileModule(file.content, {
											fileName: "schemas.ts",
											reportDiagnostics: true
										}).diagnostics ?? []
									const exported = yield* parsedExports(api, file.content)
									const reachable = reachableFrom(drawnCase.definitions, drawnCase.roots)
									k.noteAll(featuresOf(drawnCase, reachable, file.content, exported.types))
									deepStrictEqual(
										{
											path: file.path,
											reordered: again.content,
											formatted: formatted.code,
											syntax: syntax.length,
											exported: Arr.sort(
												Arr.map(exported.constants, (constant) => constant.name),
												Order.String
											),
											outOfOrder: outOfOrder(exported.constants),
											annotations: Str.includes(SENTINEL)(file.content)
										},
										{
											path: "src/domain/schemas.ts",
											reordered: file.content,
											formatted: file.content,
											syntax: 0,
											exported: Arr.sort(
												Arr.getSomes(
													Arr.map(reachable, (key) => Option.fromUndefinedOr(identifiers.get(key)))
												),
												Order.String
											),
											outOfOrder: [],
											annotations: false
										}
									)
								})
						)
					})
				)
			)
	)

	it.effect(
		"a definition set holding one planted fault is refused with that fault's reason",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "domain refusals",
						draw: drawn(plantedGen),
						literal: Formatter.format,
						coverage: required<Fault>(
							[
								"a definition that is no schema object",
								"a schema the importer rejects",
								"a key the identifier map leaves out",
								"two keys given one name",
								"a name Effect exports differently"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 100,
						shrink: { kind: "bounded", candidates: 100 },
						concurrency: 1,
						steerEvery: 50,
						caseHang: Duration.seconds(20)
					},
					(planted, k) =>
						Effect.map(
							Effect.exit(emitted(planted.definitions, planted.roots, planted.identifiers)),
							(exit) => {
								k.note(planted.fault)
								deepStrictEqual(
									Exit.match(exit, {
										onSuccess: () => Option.none<string>(),
										onFailure: (cause) =>
											Option.map(Cause.findErrorOption(cause), (error) =>
												error._tag === "DomainEmitError" ? error.reason : error._tag
											)
									}),
									Option.some(planted.reason)
								)
							}
						)
				)
			)
	)
})
