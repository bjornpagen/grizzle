import { Array as Arr, Option, Record as Rec, Result } from "effect"
import type { EventContract, EventData, RetryWhen, StreamEvent } from "#model/entities.ts"
import { isJsonPointer } from "#model/pointer.ts"
import type { Json } from "#model/pointer.ts"
import { childKey, nodeOption, settle } from "#normalize/document-set.ts"
import { schemaKeyAt } from "#normalize/schemas.ts"
import { keyOf } from "#resolve/canonical.ts"
import type { CanonicalKey } from "#resolve/canonical.ts"
import type { Resolution } from "#resolve/index.ts"
import {
	anything,
	array,
	boolean,
	literal,
	member,
	members,
	number,
	optionalMember,
	refine,
	string,
	struct,
	union
} from "#runtime/read.ts"
import type { Members, Reader, ReadIssues } from "#runtime/read.ts"
import { isJsonFamily } from "#runtime/sequential.ts"

/**
 * Why an `itemSchema`'s event contract is refused, each at the place it names: an `x-stream` that is not one of its
 * forms; an `x-stream` on a branch that names no event; a `retryWhen` on an event whose data is not JSON; one event
 * named by two branches that say different things of it.
 */
export type EventStreamFinding =
	| Readonly<{ at: CanonicalKey; code: "MED-18/stream-role-invalid" }>
	| Readonly<{ at: CanonicalKey; code: "MED-18/stream-role-unnamed" }>
	| Readonly<{ at: CanonicalKey; code: "MED-18/stream-retry-not-json" }>
	| Readonly<{ at: CanonicalKey; code: "MED-18/stream-event-twice" }>

/**
 * A schema node read by `read` when it is an object: none where it is no object or `read` refuses one of the members it
 * reads. The members it does not read are any.
 */
const objectRead =
	<A>(read: (object: Members) => Result.Result<A, ReadIssues>) =>
	(node: Json): Option.Option<A> =>
		Result.getSuccess(Result.flatMap(members(node), read))

/** The lists a union schema names its branches in. */
const readUnion = objectRead((object) =>
	struct(
		object,
		{
			anyOf: optionalMember(object, "anyOf", array(anything)),
			oneOf: optionalMember(object, "oneOf", array(anything))
		},
		anything
	)
)

/** The schemas a schema composes and the properties it declares. */
const readComposed = objectRead((object) =>
	struct(
		object,
		{
			allOf: optionalMember(object, "allOf", array(anything)),
			properties: optionalMember(object, "properties", members)
		},
		anything
	)
)

/** The keywords that may fix a schema to one value. */
const readConstant = objectRead((object) =>
	struct(
		object,
		{
			const: optionalMember(object, "const", anything),
			enum: optionalMember(object, "enum", array(anything))
		},
		anything
	)
)

/** The keywords that say what a string schema's content is: its media type, and the schema that checks it. */
const readContentMedia = objectRead((object) =>
	struct(
		object,
		{
			contentMediaType: optionalMember(object, "contentMediaType", string),
			contentSchema: optionalMember(object, "contentSchema", anything)
		},
		anything
	)
)

/** A schema's `x-stream`, when it has one. */
const readAnnotation = objectRead((object) => optionalMember(object, "x-stream", anything))

/** An event's name as a schema admits it: a string. */
const readName = (value: unknown): Option.Option<string> => Result.getSuccess(string(value))

/**
 * The forms of `x-stream`: a role; a failure role with the pointer and value that say retrying is safe; or a ready role
 * with the name of the one event that follows it. Any other member refuses the form.
 */
type StreamRole =
	| Readonly<{ retryWhen: RetryWhen; role: "error" }>
	| Readonly<{ next: string; role: "ready" }>
	| Readonly<{ role: "end" | "error" | "ready" }>

/** A failure role's `retryWhen`: the JSON Pointer into its data and the scalar there that says retrying is safe. */
const retryWhen: Reader<RetryWhen> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(
			object,
			{
				equals: member(object, "equals", union([string, number, boolean])),
				pointer: member(object, "pointer", refine(string, isJsonPointer, "a JSON Pointer"))
			},
			false
		)
	)

/** An `x-stream` read as one of its forms, each closed. */
const streamRole: Reader<StreamRole> = union([
	(value) =>
		Result.flatMap(members(value), (object) =>
			struct(
				object,
				{
					retryWhen: member(object, "retryWhen", retryWhen),
					role: member(object, "role", literal("error"))
				},
				false
			)
		),
	(value) =>
		Result.flatMap(members(value), (object) =>
			struct(
				object,
				{ next: member(object, "next", string), role: member(object, "role", literal("ready")) },
				false
			)
		),
	(value) =>
		Result.flatMap(members(value), (object) =>
			struct(
				object,
				{
					role: member(object, "role", union([literal("end"), literal("error"), literal("ready")]))
				},
				false
			)
		)
])

/** Whether two events' data read alike: both text, both JSON no schema checks, or both JSON one schema checks. */
const sameData = (left: EventData, right: EventData): boolean =>
	typeof left === "string" || typeof right === "string" ? left === right : left.json === right.json

/**
 * Whether two rows say the same of their event: its data, its role and its retry rule. A union's derived equivalence
 * cannot be used: a row without a retry rule also matches the member that has one, so the two would compare equal.
 */
const sameRow = (left: StreamEvent, right: StreamEvent): boolean =>
	sameData(left.data, right.data) &&
	left.role === right.role &&
	("retryWhen" in left
		? "retryWhen" in right &&
			left.retryWhen.equals === right.retryWhen.equals &&
			left.retryWhen.pointer === right.retryWhen.pointer
		: !("retryWhen" in right)) &&
	("next" in left ? "next" in right && left.next === right.next : !("next" in right))

/**
 * The schema at a key after its references, and its node.
 */
const schemaAt = (
	resolution: Resolution,
	at: CanonicalKey
): Readonly<{ at: CanonicalKey; node: Option.Option<Json> }> => {
	const settled = settle(resolution, at)

	return { at: settled, node: nodeOption(resolution, settled) }
}

/**
 * The branches of an `itemSchema`: the members of its `oneOf`, else of its `anyOf`, each after its references; a
 * schema with neither is its own one branch.
 */
const branchesOf = (resolution: Resolution, root: CanonicalKey): ReadonlyArray<CanonicalKey> => {
	const listed = Option.flatMap(Option.flatMap(nodeOption(resolution, root), readUnion), (found) =>
		Option.orElse(
			Option.map(
				Option.filter(found.oneOf, Arr.isReadonlyArrayNonEmpty),
				(branches) => ["oneOf", branches.length] as const
			),
			() =>
				Option.map(
					Option.filter(found.anyOf, Arr.isReadonlyArrayNonEmpty),
					(branches) => ["anyOf", branches.length] as const
				)
		)
	)

	return Option.match(listed, {
		onNone: () => [root],
		onSome: ([keyword, count]) =>
			Array.from({ length: count }, (_, index) =>
				settle(resolution, childKey(root, keyword, String(index)))
			)
	})
}

/**
 * A branch and every schema its `allOf` composes, depth first, each after its references and each once.
 */
const composedOf = (resolution: Resolution, branch: CanonicalKey): ReadonlyArray<CanonicalKey> => {
	const seen = new Set<string>()
	const walk = (at: CanonicalKey): ReadonlyArray<CanonicalKey> => {
		if (seen.has(keyOf(at))) {
			return []
		}

		seen.add(keyOf(at))
		const composes = Option.getOrElse(
			Option.flatMap(
				Option.flatMap(nodeOption(resolution, at), readComposed),
				(composed) => composed.allOf
			),
			(): ReadonlyArray<unknown> => []
		)

		return [
			at,
			...Arr.flatMap(composes, (_, index) =>
				walk(settle(resolution, childKey(at, "allOf", String(index))))
			)
		]
	}

	return walk(branch)
}

/**
 * The schema of a branch's property `name`: the first schema the branch composes that declares it, after its
 * references.
 */
const propertyOf = (
	resolution: Resolution,
	branch: CanonicalKey,
	name: string
): Option.Option<ReturnType<typeof schemaAt>> =>
	Arr.findFirst(composedOf(resolution, branch), (at) =>
		Option.exists(Option.flatMap(nodeOption(resolution, at), readComposed), (composed) =>
			Option.exists(composed.properties, (properties) => Rec.has(properties, name))
		)
	).pipe(Option.map((at) => schemaAt(resolution, childKey(at, "properties", name))))

/**
 * The one string a schema admits, by `const` or a one-member `enum`.
 */
const constantOf = (node: Option.Option<Json>): Option.Option<string> =>
	Option.flatMap(Option.flatMap(node, readConstant), (constant) =>
		Option.match(constant.const, {
			onNone: () =>
				Option.flatMap(
					Option.filter(constant.enum, (values) => values.length === 1),
					(values) => Option.flatMap(Arr.head(values), readName)
				),
			onSome: readName
		})
	)

/**
 * How a branch's event data reads: `text` unless its `data` property's `contentMediaType` is JSON; then checked
 * against its `contentSchema`, named by the store key of its site (schemas.ts schemaKeyAt, which normalize stores as a
 * root of its own), where it has one, else JSON no schema checks.
 */
const dataOf = (resolution: Resolution, branch: CanonicalKey): EventData =>
	Option.match(
		Option.flatMap(propertyOf(resolution, branch, "data"), (data) =>
			Option.map(
				Option.filter(Option.flatMap(data.node, readContentMedia), (media) =>
					Option.exists(media.contentMediaType, isJsonFamily)
				),
				(media) => ({ at: data.at, schema: Option.isSome(media.contentSchema) })
			)
		),
		{
			onNone: (): EventData => "text",
			onSome: ({ at, schema }): EventData =>
				schema ? { json: schemaKeyAt(resolution, childKey(at, "contentSchema")) } : "json"
		}
	)

/** The roles of `x-stream` a branch's data may be text under: every form but a failure with its retry rule. */
type PlainRole = Exclude<StreamRole, { readonly retryWhen: unknown }>

/** The failure role with its retry rule, which only JSON data carries. */
type RetryRole = Extract<StreamRole, { readonly retryWhen: unknown }>

/** JSON event data: JSON no schema checks, or JSON its `contentSchema` checks. */
type JsonData = Exclude<EventData, "text">

/**
 * What one branch says: the event it names, if any, its data, and its `x-stream` role: none or a plain role over any
 * data, or a failure with its retry rule over JSON data, so a retry rule on text data is no reading at all.
 */
type BranchReading =
	| Readonly<{
			at: CanonicalKey
			name: Option.Option<string>
			data: EventData
			role: Option.Option<PlainRole>
	  }>
	| Readonly<{ at: CanonicalKey; name: Option.Option<string>; data: JsonData; retry: RetryRole }>

const readBranch = (
	resolution: Resolution,
	branch: CanonicalKey
): Result.Result<BranchReading, EventStreamFinding> => {
	const annotation = Option.flatten(Option.flatMap(nodeOption(resolution, branch), readAnnotation))
	const at = childKey(branch, "x-stream")
	const decoded = Option.map(annotation, (value) => Result.getSuccess(streamRole(value)))
	const name = constantOf(
		Option.flatMap(propertyOf(resolution, branch, "event"), (event) => event.node)
	)
	const data = dataOf(resolution, branch)
	if (Option.exists(decoded, Option.isNone)) {
		return Result.fail({ at, code: "MED-18/stream-role-invalid" })
	}

	const read = Option.flatten(decoded)
	if (Option.isSome(read) && Option.isNone(name)) {
		return Result.fail({ at, code: "MED-18/stream-role-unnamed" })
	}

	if (Option.isNone(read) || !("retryWhen" in read.value)) {
		return Result.succeed({
			at: branch,
			name,
			data,
			role: Option.filter(read, (role): role is PlainRole => !("retryWhen" in role))
		})
	}

	return data === "text"
		? Result.fail({ at, code: "MED-18/stream-retry-not-json" })
		: Result.succeed({ at: branch, name, data, retry: read.value })
}

/** The contract's row of a branch read under the name `name`. */
const rowOf = (name: string, reading: BranchReading): StreamEvent => {
	if ("retry" in reading) {
		return {
			data: reading.data,
			name,
			retryWhen: reading.retry.retryWhen,
			role: reading.retry.role
		}
	}

	const { data } = reading

	return Option.match(reading.role, {
		onNone: () => ({ data, name, role: "item" }),
		onSome: (role) =>
			"next" in role
				? { data, name, next: role.next, role: role.role }
				: { data, name, role: role.role }
	})
}

/**
 * Read the event contract of a `text/event-stream` media type's `itemSchema` at `site` (design of the event lifecycle):
 * each branch of its union, or the schema itself when it is no union, names an event when its `event` property admits
 * one string; its data is JSON when its `data` property's `contentMediaType` is; and its `x-stream` gives its role.
 * A union whose every branch names its event is `Closed`: an event of any other type breaks the contract. Otherwise
 * the branches that name no event say how the data of an event of any other type prints, JSON only when every such
 * branch says JSON. `None` when the contract names no event and prints other data as text, which is the open contract
 * every stream has without one. A ready role's `next` names an event of the contract. A malformed `x-stream`, one on an unnamed branch, a `retryWhen` on text data, or one event
 * named twice with different rows is a finding, so the stream's lifecycle is never guessed.
 */
export const readEventContract = (
	resolution: Resolution,
	site: CanonicalKey
): Result.Result<Option.Option<EventContract>, EventStreamFinding> => {
	const read = Result.all(
		Arr.map(branchesOf(resolution, settle(resolution, site)), (branch) =>
			readBranch(resolution, branch)
		)
	)
	if (Result.isFailure(read)) {
		return Result.fail(read.failure)
	}

	const named = Arr.flatMap(read.success, (branch) =>
		Option.match(branch.name, {
			onNone: () => [],
			onSome: (name) => [[branch, rowOf(name, branch)] as const]
		})
	)
	const unnamed = Arr.filter(read.success, (branch) => Option.isNone(branch.name))
	const twice = Arr.findFirst(named, ([, row], index) =>
		Arr.some(
			Arr.take(named, index),
			([, earlier]) => earlier.name === row.name && !sameRow(earlier, row)
		)
	)
	if (Option.isSome(twice)) {
		return Result.fail({ at: twice.value[0].at, code: "MED-18/stream-event-twice" })
	}

	const rows: ReadonlyArray<StreamEvent> = Arr.map(named, ([, row]) => row)
	const events = Arr.dedupeWith(rows, (left, right) => left.name === right.name)
	const strays = Arr.findFirst(
		named,
		([, row]) => "next" in row && !Arr.some(events, (event) => event.name === row.next)
	)
	if (Option.isSome(strays)) {
		return Result.fail({
			at: childKey(strays.value[0].at, "x-stream"),
			code: "MED-18/stream-role-invalid"
		})
	}

	if (Arr.isReadonlyArrayNonEmpty(events) && !Arr.isReadonlyArrayNonEmpty(unnamed)) {
		return Result.succeed(Option.some({ events, otherwise: { _tag: "Closed" } }))
	}

	const data =
		Arr.isReadonlyArrayNonEmpty(unnamed) && Arr.every(unnamed, (branch) => branch.data !== "text")
			? "json"
			: "text"

	return Result.succeed(
		events.length === 0 && data === "text"
			? Option.none()
			: Option.some({ events, otherwise: { _tag: "Open", data } })
	)
}
