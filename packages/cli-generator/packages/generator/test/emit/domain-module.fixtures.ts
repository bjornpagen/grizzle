/** What the properties of domain-module.test.ts read: its spaces, models and helpers. */

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
	weighted,
	type Weighted
} from "@bjornpagen/testing/gen"
import { syntaxOf } from "@bjornpagen/testing/syntax"
import { Array as Arr, Option, Order, Predicate, Record, String as Str } from "effect"
import type { FormatConfig } from "oxfmt"
import {
	isArrowFunction,
	isIdentifier,
	isTypeAliasDeclaration,
	isVariableStatement,
	type Node,
	type SourceFile
} from "typescript/ast"
import { emitDomainSchemas } from "#emit/domain.ts"
import type { Json } from "#model/pointer.ts"
import { domainIdentifiers } from "#names/domain.ts"
import { SafeIdentifier } from "#names/fold.ts"

export const FORMAT_OPTIONS: FormatConfig = {
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
export const SENTINEL = "never-printed-annotation"

const ref = (key: string): Json => ({ $ref: `#/$defs/${key}` })

const annotations: Gen<Readonly<Record<string, Json>>> = (s) =>
	Record.fromEntries(
		Arr.map(
			s.draw(subarray(["default", "example", "examples"])),
			(key) => [key, key === "examples" ? [SENTINEL] : SENTINEL] as const
		)
	)

/**
 * The keys a reference may name: any key once the schema descends into the instance (a property, an item, an
 * additional property), and in place (the definition itself, or a branch of its `anyOf`) only a key drawn after the
 * definition's own. The domain emitter reads the validation copy, which never holds a cycle of references that returns to
 * a schema without descending into the instance (normalize/schemas.ts breakAliasCycles makes each such site `{}`), so
 * the draw never builds one.
 */
type Reach = Readonly<{ all: Arr.NonEmptyReadonlyArray<string>; inPlace: ReadonlyArray<string> }>

const descended = (reach: Reach): Reach => ({ all: reach.all, inPlace: reach.all })

/** A reference to one of `keys`, none when there is no key to name. */
const refTo = (keys: ReadonlyArray<string>): ReadonlyArray<Gen<Json>> =>
	Arr.isReadonlyArrayNonEmpty(keys) ? [map(element(keys), ref)] : []

const leafGen = (reach: Reach): Gen<Json> =>
	weighted<Json>([
		[2, () => ({ type: "string" })],
		[1, (s) => ({ type: "string", minLength: s.draw(int(0, 3)), maxLength: s.draw(int(4, 9)) })],
		[1, () => ({ type: "integer" })],
		[1, () => ({ type: "boolean" })],
		[
			1,
			(s) => ({
				enum: Array.from(
					{ length: s.draw(int(1, 10)) + 1 },
					(_, index) => `${s.draw(element(["s", "a_much_longer_state_name"]))}_${index}`
				)
			})
		],
		...Arr.map(refTo(reach.inPlace), (target): Weighted<Json> => [3, target])
	])

const nodeGen = (reach: Reach, depth: number): Gen<Json> =>
	depth === 0
		? leafGen(reach)
		: weighted<Json>([
				[3, leafGen(reach)],
				[1, (s) => ({ type: "array", items: s.draw(nodeGen(descended(reach), depth - 1)) })],
				[
					1,
					(s) => ({
						anyOf: s.draw(
							shuffled([s.draw(nodeGen(reach, depth - 1)), { type: "null" }], { min: 2, max: 2 })
						)
					})
				],
				[1, (s) => ({ type: ["array", "null"], items: s.draw(map(element(reach.all), ref)) })],
				[
					1,
					(s) => ({
						type: "object",
						additionalProperties: s.draw(nodeGen(descended(reach), depth - 1))
					})
				],
				...Arr.map(refTo(reach.inPlace), (target): Weighted<Json> => [
					1,
					(s) => ({ anyOf: [s.draw(target), s.draw(target)] })
				]),
				[2, objectGen(reach.all, depth - 1)]
			])

const objectGen =
	(keys: Arr.NonEmptyReadonlyArray<string>, depth: number): Gen<Json> =>
	(s) => {
		const properties = s.draw(
			uniqueArray(
				element(PROPERTY_KEYS),
				(key) => map(nodeGen({ all: keys, inPlace: keys }, depth), (node) => [key, node] as const),
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

export const caseGen: Gen<DomainCase> = (s) => {
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
		(key, index) =>
			[
				key,
				s.draw(
					weighted<Json>([
						[3, objectGen(keys, 1)],
						[1, nodeGen({ all: keys, inPlace: Arr.drop(keys, index + 1) }, 2)]
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
export const reachableFrom = (
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
export const outOfOrder = (constants: ReadonlyArray<Exported>): ReadonlyArray<string> => {
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

export const identifiersOf = (definitions: ReadonlyArray<readonly [string, Json]>) =>
	domainIdentifiers(Arr.map(definitions, ([key]) => key))

export const emitted = (
	definitions: ReadonlyArray<readonly [string, Json]>,
	roots: ReadonlyArray<string>,
	identifiers: ReturnType<typeof domainIdentifiers>
) => emitDomainSchemas(new Map(definitions), roots, identifiers)

export type Feature =
	| "the empty module"
	| "a recursive definition"
	| "an alias named before its recursive target"
	| "an alias named after its recursive target"
	| "mutually recursive definitions"
	| "an unreachable definition"
	| "an annotation left out"
	| "a long name"
	| "a folded name"
	| "a name Effect also exports"
	| "a closed object"
	| "a nullable member"

export const parsedExports = (text: string) => syntaxOf("/schemas.ts", text, exportsOf)

export const featuresOf = (
	drawnCase: DomainCase,
	identifiers: ReturnType<typeof domainIdentifiers>,
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
	const aliased = (key: string): ReadonlyArray<string> =>
		Arr.flatMap(drawnCase.definitions, ([name, schema]) =>
			name === key && isObject(schema) && Record.keys(schema).length === 1
				? referencesOf(schema)
				: []
		)
	return [
		...(text === "export {};\n" ? (["the empty module"] as const) : []),
		...(Arr.some(reachable, readsItself) ? (["a recursive definition"] as const) : []),
		...Arr.flatMap(reachable, (key) =>
			Arr.flatMap(
				Arr.filter(aliased(key), (target) => readsItself(target)),
				(target: string) =>
					Option.toArray(
						Option.flatMap(Option.fromUndefinedOr(identifiers.get(key)), (alias) =>
							Option.map(Option.fromUndefinedOr(identifiers.get(target)), (recursive): Feature =>
								Order.String(alias, recursive) < 0
									? "an alias named before its recursive target"
									: "an alias named after its recursive target"
							)
						)
					)
			)
		),
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

export type Fault =
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

export const plantedGen: Gen<Planted> = (s) => {
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
