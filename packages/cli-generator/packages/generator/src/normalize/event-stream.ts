import { Array as Arr, Option, Record as Rec, Result, Schema } from "effect"
import type { EventContract, EventData } from "#model/entities.ts"
import { RetryWhen, StreamEvent } from "#model/entities.ts"
import { childKey, nodeOption, settle } from "#normalize/document-set.ts"
import { schemaKeyAt } from "#normalize/schemas.ts"
import { keyOf } from "#resolve/canonical.ts"
import type { CanonicalKey } from "#resolve/canonical.ts"
import type { Resolution } from "#resolve/index.ts"
import { isJsonFamily } from "#runtime-src/runtime/sequential.ts"

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

const Union = Schema.Struct({
	anyOf: Schema.optionalKey(Schema.Array(Schema.Unknown)),
	oneOf: Schema.optionalKey(Schema.Array(Schema.Unknown))
})

const Composed = Schema.Struct({
	allOf: Schema.optionalKey(Schema.Array(Schema.Unknown)),
	properties: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
})

const Constant = Schema.Struct({
	const: Schema.optionalKey(Schema.Unknown),
	enum: Schema.optionalKey(Schema.Array(Schema.Unknown))
})

const ContentMedia = Schema.Struct({
	contentMediaType: Schema.optionalKey(Schema.String),
	contentSchema: Schema.optionalKey(Schema.Unknown)
})

const Annotated = Schema.Struct({ "x-stream": Schema.optionalKey(Schema.Unknown) })

/**
 * The forms of `x-stream`: a role; a failure role with the pointer and value that say retrying is safe; or a ready role
 * with the name of the one event that follows it. Any other member refuses the form.
 */
const StreamRole = Schema.Union([
	Schema.Struct({ retryWhen: RetryWhen, role: Schema.Literal("error") }),
	Schema.Struct({ next: Schema.String, role: Schema.Literal("ready") }),
	Schema.Struct({ role: Schema.Literals(["end", "error", "ready"]) })
])

const strict = { onExcessProperty: "error" } as const

const decodeUnion = Schema.decodeUnknownOption(Union)

const decodeComposed = Schema.decodeUnknownOption(Composed)

const decodeConstant = Schema.decodeUnknownOption(Constant)

const decodeContentMedia = Schema.decodeUnknownOption(ContentMedia)

const decodeAnnotated = Schema.decodeUnknownOption(Annotated)

const decodeRole = Schema.decodeUnknownOption(StreamRole, strict)

const decodeName = Schema.decodeUnknownOption(Schema.String)

/** Whether two events' data read alike: both text, both JSON no schema checks, or both JSON one schema checks. */
const sameData = (left: typeof EventData.Type, right: typeof EventData.Type): boolean =>
	typeof left === "string" || typeof right === "string" ? left === right : left.json === right.json

/**
 * Whether two rows say the same of their event: its data, its role and its retry rule. A union's derived equivalence
 * cannot be used: a row without a retry rule also matches the member that has one, so the two would compare equal.
 */
const sameRow = (left: typeof StreamEvent.Type, right: typeof StreamEvent.Type): boolean =>
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
): Readonly<{ at: CanonicalKey; node: Option.Option<unknown> }> => {
	const settled = settle(resolution, at)

	return { at: settled, node: nodeOption(resolution, settled) }
}

/**
 * The branches of an `itemSchema`: the members of its `oneOf`, else of its `anyOf`, each after its references; a
 * schema with neither is its own one branch.
 */
const branchesOf = (resolution: Resolution, root: CanonicalKey): ReadonlyArray<CanonicalKey> => {
	const union = Option.flatMap(nodeOption(resolution, root), decodeUnion)
	const listed = Option.flatMap(union, (found) =>
		Option.orElse(
			Option.map(
				Option.filter(Option.fromUndefinedOr(found.oneOf), Arr.isReadonlyArrayNonEmpty),
				(members) => ["oneOf", members.length] as const
			),
			() =>
				Option.map(
					Option.filter(Option.fromUndefinedOr(found.anyOf), Arr.isReadonlyArrayNonEmpty),
					(members) => ["anyOf", members.length] as const
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
		const members = Option.getOrElse(
			Option.flatMap(Option.flatMap(nodeOption(resolution, at), decodeComposed), (composed) =>
				Option.fromUndefinedOr(composed.allOf)
			),
			(): ReadonlyArray<unknown> => []
		)

		return [
			at,
			...Arr.flatMap(members, (_, index) =>
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
		Option.exists(
			Option.flatMap(nodeOption(resolution, at), decodeComposed),
			(composed) => composed.properties !== undefined && Rec.has(composed.properties, name)
		)
	).pipe(Option.map((at) => schemaAt(resolution, childKey(at, "properties", name))))

/**
 * The one string a schema admits, by `const` or a one-member `enum`.
 */
const constantOf = (node: Option.Option<unknown>): Option.Option<string> =>
	Option.flatMap(Option.flatMap(node, decodeConstant), (constant) =>
		constant.const === undefined
			? Option.flatMap(
					Option.filter(Option.fromUndefinedOr(constant.enum), (members) => members.length === 1),
					(members) => Option.flatMap(Arr.head(members), decodeName)
				)
			: decodeName(constant.const)
	)

/**
 * How a branch's event data reads: `text` unless its `data` property's `contentMediaType` is JSON; then checked
 * against its `contentSchema`, named by the store key of its site (schemas.ts schemaKeyAt, which normalize stores as a
 * root of its own), where it has one, else JSON no schema checks.
 */
const dataOf = (resolution: Resolution, branch: CanonicalKey): typeof EventData.Type =>
	Option.match(
		Option.flatMap(propertyOf(resolution, branch, "data"), (data) =>
			Option.map(
				Option.filter(Option.flatMap(data.node, decodeContentMedia), (media) =>
					Option.exists(Option.fromUndefinedOr(media.contentMediaType), isJsonFamily)
				),
				(media) => ({ at: data.at, schema: media.contentSchema !== undefined })
			)
		),
		{
			onNone: (): typeof EventData.Type => "text",
			onSome: ({ at, schema }): typeof EventData.Type =>
				schema ? { json: schemaKeyAt(resolution, childKey(at, "contentSchema")) } : "json"
		}
	)

/** The roles of `x-stream` a branch's data may be text under: every form but a failure with its retry rule. */
type PlainRole = Exclude<typeof StreamRole.Type, { readonly retryWhen: unknown }>

/** The failure role with its retry rule, which only JSON data carries. */
type RetryRole = Extract<typeof StreamRole.Type, { readonly retryWhen: unknown }>

/** JSON event data: JSON no schema checks, or JSON its `contentSchema` checks. */
type JsonData = Exclude<typeof EventData.Type, "text">

/**
 * What one branch says: the event it names, if any, its data, and its `x-stream` role: none or a plain role over any
 * data, or a failure with its retry rule over JSON data, so a retry rule on text data is no reading at all.
 */
type BranchReading =
	| Readonly<{
			at: CanonicalKey
			name: Option.Option<string>
			data: typeof EventData.Type
			role: Option.Option<PlainRole>
	  }>
	| Readonly<{ at: CanonicalKey; name: Option.Option<string>; data: JsonData; retry: RetryRole }>

const readBranch = (
	resolution: Resolution,
	branch: CanonicalKey
): Result.Result<BranchReading, EventStreamFinding> => {
	const annotation = Option.flatMap(
		Option.flatMap(nodeOption(resolution, branch), decodeAnnotated),
		(annotated) => Option.fromUndefinedOr(annotated["x-stream"])
	)
	const at = childKey(branch, "x-stream")
	const decoded = Option.map(annotation, decodeRole)
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
const rowOf = (name: string, reading: BranchReading): typeof StreamEvent.Type => {
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
): Result.Result<Option.Option<typeof EventContract.Encoded>, EventStreamFinding> => {
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

	const rows: ReadonlyArray<typeof StreamEvent.Type> = Arr.map(named, ([, row]) => row)
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
