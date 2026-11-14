/**
 * An SSE response's event contract is read from its media type's `itemSchema` as the event lifecycle states it: each
 * branch of its `oneOf` or `anyOf` union, or the schema itself, names an event by its `event` property's one value; its
 * data is JSON when its `data` property's `contentMediaType` is; its `x-stream` gives its role, a ready role perhaps
 * with the one event that follows it (`next`). A union whose every branch names its event is closed; otherwise the
 * branches that name no event say how other events' data prints. A malformed `x-stream`, one on an unnamed branch, a
 * `retryWhen` on text data, one event named twice with different rows and a `next` naming no event of the contract are
 * refused at operation scope, so a lifecycle is never guessed.
 *
 * Generated item schemas: unions of up to four branches, each written inline, behind a `$ref` or through `allOf`, its
 * event named by `const` or a one-member `enum` or not at all, its data JSON (with a `contentSchema` or none, the
 * row then naming that schema by its store key: inline, a bare `$ref` to a component, or a `$ref` beside an asserting
 * keyword), text or undeclared, its `x-stream` absent,
 * one of its forms (a ready role with a `next` among them), or malformed. Oracle: the reading's specification, applied
 * to the generated branches; and every key a row names for its data's schema is one the document's schema store
 * (normalizeSchemas) holds, so the emitter finds the schema the data is checked against.
 *
 * Features: each placement, each union form, each finding, a contract with a retry rule, JSON data for other events,
 * the open contract, a closed contract, a ready role with its next event, a name repeated with the same row.
 *
 * Plants (~/.cache/effect-openapi-cli-generator/plants): event-stream-role-ignored.patch (a malformed `x-stream` reads
 * as no role); and, applied to src/normalize/event-stream.ts, seen to fail and reverted, a `next` naming no event
 * accepted, a union whose every branch names its event read as open, dataOf ignoring a `contentSchema`, and schemas.ts
 * sitesOf storing only a `contentSchema` that holds no `$ref` (the asserting reference's own key unstored).
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, constant, element, type Gen, map, oneOf, weighted } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, Option, Record as Rec, Schema } from "effect"
import { DocumentUri } from "#model/brands.ts"
import { EventContract } from "#model/entities.ts"
import { childPointer } from "#model/pointer.ts"
import type { Json } from "#model/pointer.ts"
import { normalizeResponses } from "#normalize/responses.ts"
import { normalizeSchemas } from "#normalize/schemas.ts"
import { defaultLimits, resolve } from "#resolve/index.ts"

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
type ReadingFeature =
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
	| Readonly<{ kind: "contract"; contract: Option.Option<typeof EventContract.Encoded> }>
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
				retryWhen: { equals: written.role.equals, pointer: "/error/retry" },
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
type Row = (typeof EventContract.Encoded)["events"][number]

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
const expectedOf = (schema: ItemSchema): Expected => {
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

const encodeContract = Schema.encodeEffect(EventContract)

/** The document resolved as the generator resolves it. */
const resolutionOf = (schema: ItemSchema) =>
	Effect.flatMap(Schema.decodeEffect(DocumentUri)("file:///spec/openapi.json"), (document) =>
		resolve({ document, line: "3.2", value: documentOf(schema) })
	)

/**
 * Every key a contract's rows name for their data's schema that the document's schema store (normalize/schemas.ts
 * normalizeSchemas) does not hold: none, or the emitter could not find the schema it checks the data against.
 */
const unstoredKeys = (schema: ItemSchema, expected: Expected) =>
	Effect.gen(function* () {
		const resolution = yield* resolutionOf(schema)
		const stored = (yield* normalizeSchemas(resolution, defaultLimits)).definitions
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
const actualOf = (schema: ItemSchema) =>
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
		const contract = yield* Effect.transposeOption(
			Option.map(
				Option.flatMap(alternative, (found) => Option.fromUndefinedOr(found.events)),
				encodeContract
			)
		)
		const read: Expected = { kind: "contract", contract }
		return read
	})

/** The features a generated item schema reaches, read from its specification. */
const readingFeatures = (schema: ItemSchema, expected: Expected): ReadonlyArray<ReadingFeature> => {
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

describe("an SSE response's event contract", () => {
	it.effect(
		"is read from its itemSchema's branches as the lifecycle states it, or refused at operation scope",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "normalize/event-stream",
						oracle: {
							kind: "specification",
							name: "the event lifecycle's reading, applied to the generated branches"
						},
						draw: drawn(itemSchema),
						literal: Formatter.format,
						coverage: required<ReadingFeature>(
							[
								"inline branch",
								"branch behind a reference",
								"branch through allOf",
								"anyOf union",
								"schema alone",
								"role refused as malformed",
								"role on an unnamed branch",
								"retry rule on text data",
								"event named twice",
								"event named twice alike",
								"retry rule read",
								"JSON data for other events",
								"open contract",
								"closed contract",
								"ready role with its next event",
								"next naming no event",
								"data its contentSchema checks",
								"data a bare $ref checks",
								"data a $ref beside an asserting keyword checks"
							],
							{ cases: 2000, sense: notesOnly }
						),
						kept: [],
						runs: 500,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.seconds(10)
					},
					(schema, c) =>
						Effect.gen(function* () {
							const expected = expectedOf(schema)
							const actual = yield* actualOf(schema)
							c.noteAll(readingFeatures(schema, expected))
							deepStrictEqual(actual, expected)
							const unstored = yield* unstoredKeys(schema, actual)
							deepStrictEqual(unstored, [], "every data schema a row names is stored")
						})
				)
			)
	)
})
