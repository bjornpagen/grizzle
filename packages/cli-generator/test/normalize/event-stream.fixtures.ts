/** What the properties of event-stream.test.ts read: its spaces, models and helpers. */

import type { Json } from "@bjornpagen/grizzle-text/utf8"
import {
	type Aimed,
	aimed,
	array,
	constant,
	element,
	type Gen,
	map,
	oneOf,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Record as Rec } from "effect"
import { fixedDocumentUri } from "#model/brands.ts"
import type { EventContract } from "#model/entities.ts"
import { childPointer, formatPointer } from "#model/pointer.ts"
import { normalizeResponses } from "#normalize/responses.ts"
import { normalizeSchemas } from "#normalize/schemas.ts"
import { resolve } from "#resolve/index.ts"

/** How a branch is written: inline in the union, behind a `$ref` to a component, or through an `allOf` member. */
type Placement = "inline" | "reference" | "composed"

/** How a branch names its event: by `const`, by a one-member `enum`, or not at all. */
type Naming =
	| Readonly<{ kind: "const"; name: string }>
	| Readonly<{ kind: "enum"; name: string }>
	| Readonly<{ kind: "none" }>

/** A branch's `x-stream`: absent, one of its forms, or a malformed value. */
type Role =
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "role"; role: "end" | "error" | "ready" }>
	| Readonly<{ kind: "retry"; equals: string }>
	| Readonly<{ kind: "next"; next: string }>
	| Readonly<{ kind: "malformed"; value: Json }>

/** One branch of a generated item schema. */
type Branch = Readonly<{
	placement: Placement
	naming: Naming
	data: DataForm
	role: Role
}>

/**
 * How a branch's data is declared: JSON, JSON with a `contentSchema` written inline, as a bare `$ref` to the component
 * `Content`, or as that `$ref` beside an asserting keyword (`maxProperties`), text, or not at all.
 */
type DataForm =
	| "json"
	| "checked"
	| "checked by reference"
	| "checked by asserting reference"
	| "text"
	| "none"

/**
 * A branch's data form: JSON, text and undeclared each three times as often as each checked form, since two checked
 * branches of one name read alike only through a bare `$ref` (an inline schema and an asserting `$ref` are each their
 * own site's), and a name repeated alike stays as reachable as the other features.
 */
const dataForm: Gen<DataForm> = weighted([
	[3, constant("json")],
	[1, constant("checked")],
	[1, constant("checked by reference")],
	[1, constant("checked by asserting reference")],
	[3, constant("text")],
	[3, constant("none")]
])

/** Whether a data form declares JSON. */
const isJsonForm = (form: DataForm): boolean => form !== "text" && form !== "none"

/** The component a referring `contentSchema` names. */
const contentComponent = "Content"

/** A generated item schema: a union of branches, or one branch standing alone. */
type ItemSchema = Readonly<{
	union: "oneOf" | "anyOf" | "single"
	branches: Arr.NonEmptyReadonlyArray<Branch>
}>

/** The features the reading reaches. */
export type ReadingFeature =
	| "inline branch"
	| "branch behind a reference"
	| "branch through allOf"
	| "anyOf union"
	| "schema alone"
	| "role refused as malformed"
	| "role on an unnamed branch"
	| "retry rule on text data"
	| "event named twice"
	| "event named twice alike"
	| "retry rule read"
	| "JSON data for other events"
	| "open contract"
	| "closed contract"
	| "ready role with its next event"
	| "next naming no event"
	| "data its contentSchema checks"
	| "data a bare $ref checks"
	| "data a $ref beside an asserting keyword checks"

const eventName: Gen<string> = element(["ready", "end", "error", "upsert"])

const naming: Gen<Naming> = oneOf([
	map(eventName, (name): Naming => ({ kind: "const", name })),
	map(eventName, (name): Naming => ({ kind: "enum", name })),
	constant<Naming>({ kind: "none" })
])

const role: Gen<Role> = oneOf([
	constant<Role>({ kind: "none" }),
	map(element<"end" | "error" | "ready">(["ready", "end", "error"]), (value): Role => ({
		kind: "role",
		role: value
	})),
	map(element(["safe", "yes"]), (equals): Role => ({ kind: "retry", equals })),
	map(element(["end", "upsert", "gone"]), (next): Role => ({ kind: "next", next })),
	map(
		element<Json>([
			"ready",
			{ role: "item" },
			{ role: "ready", extra: 1 },
			{ role: "ready", retryWhen: { pointer: "/error/retry", equals: "safe" } },
			{ role: "error", retryWhen: { pointer: "error/retry", equals: "safe" } }
		]),
		(value): Role => ({ kind: "malformed", value })
	)
])

const branch: Gen<Branch> = (source) => ({
	placement: element<Placement>(["inline", "reference", "composed"])(source),
	naming: naming(source),
	data: dataForm(source),
	role: role(source)
})

const itemSchema: Gen<ItemSchema> = (source) => ({
	union: element<ItemSchema["union"]>(["oneOf", "anyOf", "single"])(source),
	branches: [branch(source), ...array(branch, { min: 0, max: 3 })(source)]
})

/**
 * A union of one drawn branch written twice, named and with no role: an event named twice alike, which the item
 * generator draws about once in hundreds of item schemas.
 */
const twiceAlike: Gen<ItemSchema> = (source) => {
	const twice: Branch = {
		...branch(source),
		naming: { kind: "const", name: eventName(source) },
		role: { kind: "none" }
	}
	return { union: element<"oneOf" | "anyOf">(["oneOf", "anyOf"])(source), branches: [twice, twice] }
}

/** Item schemas, aimed at an event named twice alike while it is pending. */
export const itemSpace: Aimed<ItemSchema, ReadingFeature> = aimed(itemSchema, [
	["event named twice alike", twiceAlike]
])

const mediaPointer = "/paths/~1a/get/responses/200/content/text~1event-stream"

/** The `x-stream` value a role writes, if any. */
const roleValue = (value: Role): Option.Option<Json> => {
	switch (value.kind) {
		case "none":
			return Option.none()
		case "role":
			return Option.some({ role: value.role })
		case "retry":
			return Option.some({
				role: "error",
				retryWhen: { pointer: "/error/retry", equals: value.equals }
			})
		case "next":
			return Option.some({ role: "ready", next: value.next })
		case "malformed":
			return Option.some(value.value)
	}
}

/** The `contentSchema` member a data form writes beside its media type, if any. */
const contentSchemaOf = (form: DataForm): Readonly<Record<string, Json>> => {
	const ref = `#/components/schemas/${contentComponent}`
	switch (form) {
		case "checked":
			return { contentSchema: { type: "object" } }
		case "checked by reference":
			return { contentSchema: { $ref: ref } }
		case "checked by asserting reference":
			return { contentSchema: { $ref: ref, maxProperties: 3 } }
		case "json":
		case "text":
		case "none":
			return {}
	}
}

/** The `properties` a branch declares. */
const propertiesOf = (written: Branch): Json => ({
	...(written.naming.kind === "const" ? { event: { const: written.naming.name } } : {}),
	...(written.naming.kind === "enum" ? { event: { enum: [written.naming.name] } } : {}),
	...(written.data === "none"
		? {}
		: {
				data: {
					type: "string",
					contentMediaType: written.data === "text" ? "text/plain" : "application/json",
					...contentSchemaOf(written.data)
				}
			})
})

/** The component name of branch `index`. */
const componentName = (index: number): string => `Branch${index}`

/** A branch as the union lists it, and the component it stands for when it is written behind a `$ref`. */
const branchSchema = (
	written: Branch,
	index: number
): Readonly<{ listed: Json; component: Option.Option<Json> }> => {
	const annotation = Option.match(roleValue(written.role), {
		onNone: () => ({}),
		onSome: (value) => ({ "x-stream": value })
	})
	const body = { type: "object", properties: propertiesOf(written), ...annotation }
	switch (written.placement) {
		case "inline":
			return { listed: body, component: Option.none() }
		case "reference":
			return {
				listed: { $ref: `#/components/schemas/${componentName(index)}` },
				component: Option.some(body)
			}
		case "composed":
			return {
				listed: {
					allOf: [{ $ref: `#/components/schemas/${componentName(index)}` }],
					...annotation
				},
				component: Option.some({ type: "object", properties: propertiesOf(written) })
			}
	}
}

/** The branches the document holds: every one of a union, the first alone for a schema that stands alone. */
const branchesOf = (schema: ItemSchema): Arr.NonEmptyReadonlyArray<Branch> =>
	schema.union === "single" ? [Arr.headNonEmpty(schema.branches)] : schema.branches

/** The document that holds the item schema. */
const documentOf = (schema: ItemSchema): Json => {
	const written = Arr.map(branchesOf(schema), branchSchema)
	const components = Rec.fromEntries(
		Arr.flatMap(written, (each, index) =>
			Option.match(each.component, {
				onNone: () => [],
				onSome: (component) => [[componentName(index), component]]
			})
		)
	)
	const listed = Arr.map(written, (each) => each.listed)
	const item = schema.union === "single" ? Arr.headNonEmpty(listed) : { [schema.union]: listed }
	return {
		openapi: "3.2.0",
		info: { title: "t", version: "1" },
		components: { schemas: { ...components, [contentComponent]: { type: "object" } } },
		paths: {
			"/a": {
				get: {
					responses: {
						"200": { description: "ok", content: { "text/event-stream": { itemSchema: item } } }
					}
				}
			}
		}
	}
}

/** Where a branch of the item schema stands once its reference is followed. */
const branchPointer = (schema: ItemSchema, written: Branch, index: number): string => {
	if (written.placement === "reference") {
		return `/components/schemas/${componentName(index)}`
	}
	const item = childPointer(mediaPointer, "itemSchema")
	return schema.union === "single"
		? item
		: childPointer(childPointer(item, schema.union), String(index))
}

/** The reading the specification states: the contract, or the first finding with its pointer. */
type Expected =
	| Readonly<{ kind: "contract"; contract: Option.Option<EventContract> }>
	| Readonly<{ kind: "refused"; code: string; pointer: string; scope: string }>

const nameOf = (written: Branch): Option.Option<string> =>
	written.naming.kind === "none" ? Option.none() : Option.some(written.naming.name)

/**
 * Where branch `index`'s `data` property's `contentSchema` stands, and so its store key (resolve/canonical.ts defsKey,
 * the pointer of a site in the entry document): in the union where the branch is inline, else in its component.
 */
const contentSchemaPointer = (schema: ItemSchema, written: Branch, index: number): string =>
	childPointer(
		childPointer(
			childPointer(
				written.placement === "inline"
					? branchPointer(schema, written, index)
					: `/components/schemas/${componentName(index)}`,
				"properties"
			),
			"data"
		),
		"contentSchema"
	)

/**
 * How a branch's data reads: text, JSON, or JSON its `contentSchema` checks, named by that schema's store key: the
 * use site's own (its pointer) for an inline schema and for a `$ref` beside an asserting keyword, the target
 * component's name for a bare `$ref`.
 */
const dataOf = (schema: ItemSchema, written: Branch, index: number): Row["data"] => {
	switch (written.data) {
		case "checked":
		case "checked by asserting reference":
			return { json: contentSchemaPointer(schema, written, index) }
		case "checked by reference":
			return { json: contentComponent }
		case "json":
			return "json"
		case "text":
		case "none":
			return "text"
	}
}

/** A named branch's row. */
const rowOf = (schema: ItemSchema, written: Branch, index: number, name: string): Row => {
	const data = dataOf(schema, written, index)
	switch (written.role.kind) {
		case "none":
			return { data, name, role: "item" }
		case "role":
			return { data, name, role: written.role.role }
		case "retry":
			return {
				data: data === "text" ? "json" : data,
				name,
				retryWhen: { equals: written.role.equals, pointer: formatPointer(["error", "retry"]) },
				role: "error"
			}
		case "next":
			return { data, name, next: written.role.next, role: "ready" }
		case "malformed":
			return { data, name, role: "item" }
	}
}

/** The finding a branch alone raises, if any, in the order the reading checks them. */
const branchFinding = (written: Branch): Option.Option<string> => {
	if (written.role.kind === "malformed") {
		return Option.some("MED-18/stream-role-invalid")
	}
	if (written.role.kind !== "none" && written.naming.kind === "none") {
		return Option.some("MED-18/stream-role-unnamed")
	}
	return written.role.kind === "retry" && !isJsonForm(written.data)
		? Option.some("MED-18/stream-retry-not-json")
		: Option.none()
}

/** A contract row as its encoded form holds it. */
type Row = EventContract["events"][number]

/** Whether two rows say the same of their event: its data, its role, and its retry rule. */
const sameRow = (left: Row, right: Row): boolean =>
	(typeof left.data === "string" || typeof right.data === "string"
		? left.data === right.data
		: left.data.json === right.data.json) &&
	left.role === right.role &&
	("retryWhen" in left
		? "retryWhen" in right &&
			left.retryWhen.equals === right.retryWhen.equals &&
			left.retryWhen.pointer === right.retryWhen.pointer
		: !("retryWhen" in right)) &&
	("next" in left ? "next" in right && left.next === right.next : !("next" in right))

/** The specification of the reading, over the generated branches. */
export const expectedOf = (schema: ItemSchema): Expected => {
	const findings = Arr.flatMap(branchesOf(schema), (written, index) =>
		Option.match(branchFinding(written), {
			onNone: () => [],
			onSome: (code) => [
				{ code, pointer: childPointer(branchPointer(schema, written, index), "x-stream") }
			]
		})
	)
	const first = Arr.head(findings)
	if (Option.isSome(first)) {
		return { kind: "refused", ...first.value, scope: "operation" }
	}
	const named = Arr.flatMap(branchesOf(schema), (written, index) =>
		Option.match(nameOf(written), {
			onNone: () => [],
			onSome: (name) => [{ index, row: rowOf(schema, written, index, name), written }]
		})
	)
	const twice = Arr.findFirst(named, (each, at) =>
		Arr.some(
			Arr.take(named, at),
			(earlier) => earlier.row.name === each.row.name && !sameRow(earlier.row, each.row)
		)
	)
	if (Option.isSome(twice)) {
		return {
			kind: "refused",
			code: "MED-18/stream-event-twice",
			pointer: branchPointer(schema, twice.value.written, twice.value.index),
			scope: "operation"
		}
	}
	const rows: ReadonlyArray<Row> = Arr.map(named, (each) => each.row)
	const events = Arr.dedupeWith(rows, (left, right) => left.name === right.name)
	const stray = Arr.findFirst(named, ({ row }) => {
		if (!("next" in row)) {
			return false
		}
		const { next } = row
		return !Arr.some(events, (event) => event.name === next)
	})
	if (Option.isSome(stray)) {
		return {
			kind: "refused",
			code: "MED-18/stream-role-invalid",
			pointer: childPointer(
				branchPointer(schema, stray.value.written, stray.value.index),
				"x-stream"
			),
			scope: "operation"
		}
	}
	const unnamed = Arr.filter(branchesOf(schema), (written) => written.naming.kind === "none")
	if (Arr.isReadonlyArrayNonEmpty(events) && !Arr.isReadonlyArrayNonEmpty(unnamed)) {
		return { kind: "contract", contract: Option.some({ events, otherwise: { _tag: "Closed" } }) }
	}
	const data =
		Arr.isReadonlyArrayNonEmpty(unnamed) &&
		Arr.every(unnamed, (written) => isJsonForm(written.data))
			? "json"
			: "text"
	return {
		kind: "contract",
		contract:
			events.length === 0 && data === "text"
				? Option.none()
				: Option.some({ events, otherwise: { _tag: "Open", data } })
	}
}

/** The document resolved as the generator resolves it. */
const resolutionOf = (schema: ItemSchema) =>
	resolve({
		document: fixedDocumentUri("file:///spec/openapi.json"),
		line: "3.2",
		value: documentOf(schema)
	})

/**
 * Every key a contract's rows name for their data's schema that the document's schema store (normalize/schemas.ts
 * normalizeSchemas) does not hold: none, or the emitter could not find the schema it checks the data against.
 */
export const unstoredKeys = (schema: ItemSchema, expected: Expected) =>
	Effect.gen(function* () {
		const resolution = yield* resolutionOf(schema)
		const stored = (yield* normalizeSchemas(resolution)).definitions
		const named =
			expected.kind === "contract"
				? Option.match(expected.contract, {
						onNone: () => [],
						onSome: (contract) =>
							Arr.flatMap(contract.events, (event) =>
								typeof event.data === "string" ? [] : [event.data.json]
							)
					})
				: []
		return Arr.filter(named, (key) => !stored.has(key))
	})

/** The reading the generator made: the contract its alternative carries, or its first refusal. */
export const actualOf = (schema: ItemSchema) =>
	Effect.gen(function* () {
		const resolution = yield* resolutionOf(schema)
		const normalized = yield* normalizeResponses(resolution, "/paths/~1a/get/responses", {
			method: "GET",
			path: "/a"
		})
		const refusal = Arr.findFirst(
			normalized.diagnostics,
			(diagnostic) => diagnostic.severity === "refusal"
		)
		if (Option.isSome(refusal)) {
			const refused: Expected = {
				kind: "refused",
				code: refusal.value.code,
				pointer: refusal.value.pointer,
				scope: refusal.value.scope
			}
			return refused
		}
		const alternative = Arr.head(
			Arr.flatMap(normalized.responses, (response) => response.alternatives)
		)
		const contract = Option.flatMap(alternative, (found) => Option.fromUndefinedOr(found.events))
		const read: Expected = { kind: "contract", contract }
		return read
	})

/** The features a generated item schema reaches, read from its specification. */
export const readingFeatures = (
	schema: ItemSchema,
	expected: Expected
): ReadonlyArray<ReadingFeature> => {
	const namedRead = (form: DataForm) =>
		expected.kind === "contract" &&
		Arr.some(
			branchesOf(schema),
			(written) => written.data === form && written.naming.kind !== "none"
		)
	const placed = (placement: Placement) =>
		Arr.some(branchesOf(schema), (written) => written.placement === placement)
	const names = Arr.getSomes(Arr.map(branchesOf(schema), nameOf))
	const features: ReadonlyArray<readonly [ReadingFeature, boolean]> = [
		["inline branch", placed("inline")],
		["branch behind a reference", placed("reference")],
		["branch through allOf", placed("composed")],
		["anyOf union", schema.union === "anyOf"],
		["schema alone", schema.union === "single"],
		[
			"role refused as malformed",
			expected.kind === "refused" && expected.code === "MED-18/stream-role-invalid"
		],
		[
			"role on an unnamed branch",
			expected.kind === "refused" && expected.code === "MED-18/stream-role-unnamed"
		],
		[
			"retry rule on text data",
			expected.kind === "refused" && expected.code === "MED-18/stream-retry-not-json"
		],
		[
			"event named twice",
			expected.kind === "refused" && expected.code === "MED-18/stream-event-twice"
		],
		[
			"event named twice alike",
			expected.kind === "contract" && Arr.dedupe(names).length < names.length
		],
		[
			"retry rule read",
			expected.kind === "contract" &&
				Option.exists(expected.contract, (contract) =>
					Arr.some(contract.events, (event) => "retryWhen" in event)
				)
		],
		[
			"JSON data for other events",
			expected.kind === "contract" &&
				Option.exists(
					expected.contract,
					(contract) => contract.otherwise._tag === "Open" && contract.otherwise.data === "json"
				)
		],
		["open contract", expected.kind === "contract" && Option.isNone(expected.contract)],
		[
			"closed contract",
			expected.kind === "contract" &&
				Option.exists(expected.contract, (contract) => contract.otherwise._tag === "Closed")
		],
		[
			"ready role with its next event",
			expected.kind === "contract" &&
				Option.exists(expected.contract, (contract) =>
					Arr.some(contract.events, (event) => "next" in event)
				)
		],
		[
			"next naming no event",
			expected.kind === "refused" &&
				expected.code === "MED-18/stream-role-invalid" &&
				!Arr.some(branchesOf(schema), (written) => written.role.kind === "malformed")
		],
		[
			"data its contentSchema checks",
			expected.kind === "contract" &&
				Option.exists(expected.contract, (contract) =>
					Arr.some(contract.events, (event) => typeof event.data !== "string")
				)
		],
		["data a bare $ref checks", namedRead("checked by reference")],
		["data a $ref beside an asserting keyword checks", namedRead("checked by asserting reference")]
	]
	return Arr.flatMap(features, ([feature, reached]) => (reached ? [feature] : []))
}
