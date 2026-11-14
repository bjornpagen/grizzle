/**
 * A generated CLI calling a live grizzle server over HTTP answers what grizzle's in-process `once` answers.
 *
 * Grizzle's checkout at the commit this repository pins (vendor/grizzle) runs the driver (test/support/grizzle.ts,
 * test/fixtures/grizzle/driver.ts), which installs one login twice: twin A served over HTTP by grizzle's own handler,
 * twin B called in process. The generator builds the CLI from the login's OpenAPI document as `grizzle generate` writes
 * it, its author config binding A's origin. Each case stores drawn items in both twins, then makes one to four drawn
 * calls, each through the CLI against A and through B's `once`, in the same order, the CLI's by field flags or by one
 * whole `--body`. The login's members are a set read by an int8 floor, a set read by a refined text, a key, an ordered
 * read paged from either end or from a key, a read at the call's instant bound to the database's clock, a put whose
 * items carry every carrier the fixture holds, and a deletion of every item.
 *
 * The oracle is B's answer, encoded as grizzle's server frames encode it:
 *
 * - rows: the CLI exits 0 and prints `reset`, one `upsert` per row and `ready`, then `end` for the instant read alone;
 *   its rows are B's, a set read's as a set and the ordered read's in the order its upserts' `after` keys chain them;
 * - an outcome: the CLI exits 0 and prints the `outcome`, then `end`, the outcome B's;
 * - a CallError: the CLI exits 1 and prints the `error` event last, after the read's `reset` where the read was refused
 *   as it ran, its CallError B's, an `input` refusal's kind and retry alone, since the HTTP door words a fault its own
 *   way; or, for `input` alone, the CLI exits 2 and prints nothing, having refused the body before sending it.
 *
 * The CLI asserts no `pattern` (SCH-37), so a value grizzle's spelling refuses (an int8, a decimal, a refined text) or
 * a float4 no binary32 number is reaches the server, and is the `input` it answers there.
 *
 * A CallError whose `retry` is `safe`, from either side, is no answer of the call's: nothing committed, so the call is
 * made again, as `--retries` makes it, until it is answered. A case draws a focus, a required feature or none, and the
 * case aimed at it; while the floor and the steered phase still miss a feature, it aims at one of those instead
 * (Case.steering), so each is reached on every run seed. A case may run as long as grizzle lets one case of its own
 * searches run (test/support/limits.ts caseHang), which the driver reports: its calls wait on the same cluster.
 *
 * Plants, each applied to the generator, seen to fail this suite on a private cluster, and reverted: sse.ts eventSteps
 * writing no `upsert` after a stream's first (rows lost); sse.ts eventSteps ending the stream at its first `upsert`
 * (no `ready`); flatten.ts oneValue taking every closed object with members for the one value `{}` (a read's params
 * sent as `{}`, its flags gone).
 */
import { type Case as SearchCase, drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { constant, element, type Gen, int, shuffled, weighted } from "@bjornpagen/testing/gen"
import { exact, ordered, set, structuralHash } from "@bjornpagen/testing/oracle"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { fail } from "@effect/vitest/utils"
import { jsonTextOf } from "@superstarter/json"
import {
	Array as Arr,
	Console,
	Context,
	Duration,
	Effect,
	Formatter,
	Layer,
	Option,
	Record as Rec,
	Schema,
	String as Str
} from "effect"
import {
	buildPackage,
	type BuiltPackage,
	generateFixture,
	harnessLayer,
	runBin
} from "#test/support/cli-package.ts"
import { type GrizzleDriver, grizzleDriver } from "#test/support/grizzle.ts"

/** An item as the wire spells it: an int4 key, an int8, a numeric(12, 2), a money, a boolean, a float4, a name, a date, bytes, a uuid. */
type Item = Readonly<{
	id: number
	big: string
	amount: string
	cash: string
	flag: boolean
	ratio: number
	name: string
	day: string
	blob: string
	tag: string
}>

/** A page's anchor: either end, or the key (big, id) a page follows or precedes. */
type Anchor =
	| Readonly<{ kind: "start" }>
	| Readonly<{ kind: "end" }>
	| Readonly<{ kind: "after" | "before"; key: readonly [string, number] }>

/** One call of a member of the login, with what its body states. */
type Call =
	| Readonly<{ program: "atLeast"; floor: string }>
	| Readonly<{ program: "named"; name: string }>
	| Readonly<{ program: "item"; id: number | string }>
	| Readonly<{ program: "ranked"; anchor: Anchor; size: number }>
	| Readonly<{ program: "past" }>
	| Readonly<{ program: "put"; items: ReadonlyArray<Item> }>
	| Readonly<{ program: "clear" }>

type Program = Call["program"]

const programs: Arr.NonEmptyReadonlyArray<Program> = [
	"atLeast",
	"named",
	"item",
	"ranked",
	"past",
	"put",
	"clear"
]

/** How the CLI is given a call's body: by its field flags, or whole by `--body`. */
type By = "fields" | "body"

/** A case: the items stored in both twins, then the calls, in order. */
type Case = Readonly<{
	stored: ReadonlyArray<Item>
	calls: ReadonlyArray<Readonly<{ call: Call; by: By }>>
}>

/**
 * int8 spellings: around zero, past 2^53 and at the type's ends. None is near the database's clock in milliseconds, so
 * the instant read's `big <= now` is decided the same at every call.
 */
const bigs: Arr.NonEmptyReadonlyArray<string> = [
	"0",
	"5",
	"-3",
	"1700000000000",
	"9007199254740993",
	"-9007199254740993",
	"9223372036854775807",
	"-9223372036854775808"
]

const amounts: Arr.NonEmptyReadonlyArray<string> = [
	"0",
	"1.5",
	"-3",
	"12.34",
	"-0.01",
	"9999999999.99"
]
const cashes: Arr.NonEmptyReadonlyArray<string> = ["0", "2.25", "-0.5", "92233720368547758.07"]
/** float4 values that are binary32 numbers. */
const ratios: Arr.NonEmptyReadonlyArray<number> = [0, 0.5, -1.25, 16777216]
const names: Arr.NonEmptyReadonlyArray<string> = ["a", "abc", "zz", "abcdefgh"]
const days: Arr.NonEmptyReadonlyArray<string> = [
	"2024-02-29",
	"1999-12-31",
	"0001-01-01",
	"9999-12-31"
]
const blobs: Arr.NonEmptyReadonlyArray<string> = ["", "AA==", "AAEC", "/w=="]
const tags: Arr.NonEmptyReadonlyArray<string> = [
	"00000000-0000-0000-0000-000000000000",
	"123e4567-e89b-12d3-a456-426614174000",
	"ffffffff-ffff-ffff-ffff-ffffffffffff"
]

/** Spellings the server refuses where the CLI, asserting no pattern, sends them: an int8, a decimal at scale 3, a name. */
const badBigs: Arr.NonEmptyReadonlyArray<string> = ["1.5", "x", "9223372036854775808"]
const badAmounts: Arr.NonEmptyReadonlyArray<string> = ["1.005", "12345678901"]
const badNames: Arr.NonEmptyReadonlyArray<string> = ["ZZ", "", "abcdefghi"]
/** A float4 value no binary32 number is. */
const badRatio = 0.1

/** An item of id `id` whose every value its field admits. */
const storableItem =
	(id: number): Gen<Item> =>
	(source) => ({
		id,
		big: source.draw(element(bigs)),
		amount: source.draw(element(amounts)),
		cash: source.draw(element(cashes)),
		flag: source.draw(element([true, false])),
		ratio: source.draw(element(ratios)),
		name: source.draw(element(names)),
		day: source.draw(element(days)),
		blob: source.draw(element(blobs)),
		tag: source.draw(element(tags))
	})

/**
 * An item a put states: storable twice as often as it holds one value the server refuses to parse, an int8, a decimal
 * or a float4, so most puts reach the database and its law.
 */
const putItem =
	(id: number): Gen<Item> =>
	(source) => {
		const item = source.draw(storableItem(id))
		const kind = source.draw(
			weighted<"storable" | "big" | "amount" | "ratio">([
				[6, constant("storable")],
				[1, constant("big")],
				[1, constant("amount")],
				[1, constant("ratio")]
			])
		)
		switch (kind) {
			case "storable":
				return item
			case "big":
				return { ...item, big: source.draw(element(badBigs)) }
			case "amount":
				return { ...item, amount: source.draw(element(badAmounts)) }
			case "ratio":
				return { ...item, ratio: badRatio }
		}
	}

/** Stored ids: the law refuses an id below 1. */
const storedIds: Arr.NonEmptyReadonlyArray<number> = [1, 2, 3, 4, 5, 6]

/** Ids a call names: the stored ones, the refused 0, and one never stored. */
const calledIds: Arr.NonEmptyReadonlyArray<number> = [0, 1, 2, 3, 4, 5, 6, 7]

const anchorGen =
	(stored: ReadonlyArray<Item>): Gen<Anchor> =>
	(source) => {
		const kind = source.draw(element(["start", "end", "after", "before"] as const))
		if (kind === "start" || kind === "end") {
			return { kind }
		}
		const known = Arr.map(stored, (item): readonly [string, number] => [item.big, item.id])
		const fresh: readonly [string, number] = [
			source.draw(element(bigs)),
			source.draw(element(calledIds))
		]
		const key = source.draw(element(Arr.append(known, fresh)))
		return { kind, key }
	}

const callGen =
	(stored: ReadonlyArray<Item>): Gen<Call> =>
	(source) => {
		const program = source.draw(element(programs))
		switch (program) {
			case "atLeast":
				return { program, floor: source.draw(element([...bigs, ...badBigs])) }
			case "named":
				return { program, name: source.draw(element([...names, ...badNames])) }
			case "item":
				return { program, id: source.draw(element<number | string>([...calledIds, "x"])) }
			case "ranked":
				return { program, anchor: source.draw(anchorGen(stored)), size: source.draw(int(1, 4)) }
			case "past":
			case "clear":
				return { program }
			case "put": {
				const ids = source.draw(shuffled(calledIds, { min: 1, max: 3 }))
				return { program, items: Arr.map(ids, (id) => source.draw(putItem(id))) }
			}
		}
	}

const caseGen: Gen<Case> = (source) => {
	const ids = source.draw(shuffled(storedIds, { min: 0, max: 5 }))
	const stored = Arr.map(ids, (id) => source.draw(storableItem(id)))
	const count = source.draw(int(1, 4))
	return {
		stored,
		calls: Array.from({ length: count }, () => ({
			call: source.draw(callGen(stored)),
			by: source.draw(element<By>(["fields", "body"]))
		}))
	}
}

/** A case made to reach `feature`: the stored items and the one call that reach it, then any calls, every other choice drawn. */
const caseFor =
	(feature: Feature): Gen<Case> =>
	(source) => {
		const by = source.draw(element<By>(["fields", "body"]))
		const ids = source.draw(shuffled(storedIds, { min: 1, max: 5 }))
		const stored = Arr.map(ids, (id) => source.draw(storableItem(id)))
		const aimedAt = (items: ReadonlyArray<Item>, call: Call, callBy: By): Case => ({
			stored: items,
			calls: [
				{ call, by: callBy },
				...Array.from({ length: source.draw(int(0, 2)) }, () => ({
					call: source.draw(callGen(items)),
					by: source.draw(element<By>(["fields", "body"]))
				}))
			]
		})
		switch (feature) {
			case "field flags":
				return aimedAt(stored, source.draw(callGen(stored)), "fields")
			case "a whole body":
				return aimedAt(stored, source.draw(callGen(stored)), "body")
			case "a set read":
				return aimedAt(stored, { program: "atLeast", floor: "-9223372036854775808" }, by)
			case "an empty read":
				return aimedAt([], { program: "atLeast", floor: source.draw(element(bigs)) }, by)
			case "a key":
				return aimedAt(stored, { program: "item", id: source.draw(element(calledIds)) }, by)
			case "an ordered read from its start":
				return aimedAt(
					stored,
					{
						program: "ranked",
						anchor: { kind: "start" },
						size: source.draw(int(1, 4))
					},
					by
				)
			case "an ordered read from its end":
				return aimedAt(
					stored,
					{
						program: "ranked",
						anchor: { kind: "end" },
						size: source.draw(int(1, 4))
					},
					by
				)
			case "an ordered read from a key": {
				const kind = source.draw(element(["after", "before"] as const))
				const anchor = source.draw(anchorGen(stored))
				return aimedAt(
					stored,
					{
						program: "ranked",
						anchor:
							anchor.kind === "after" || anchor.kind === "before"
								? { ...anchor, kind }
								: { kind, key: [Arr.headNonEmpty(bigs), 1] },
						size: source.draw(int(1, 4))
					},
					by
				)
			}
			case "an instant read":
				return aimedAt(stored, { program: "past" }, by)
			case "a write accepted":
				return aimedAt(
					[],
					{
						program: "put",
						items: [source.draw(storableItem(source.draw(element(storedIds))))]
					},
					by
				)
			case "a write unchanged":
				return aimedAt(stored, { program: "put", items: Arr.take(stored, 1) }, by)
			case "a deletion":
				return aimedAt(stored, { program: "clear" }, by)
			case "a write a law refuses":
				return aimedAt(stored, { program: "put", items: [source.draw(storableItem(0))] }, by)
			case "an input the server refuses":
				return aimedAt(stored, { program: "atLeast", floor: source.draw(element(badBigs)) }, by)
			case "an input the CLI refuses":
				return aimedAt(stored, { program: "item", id: "x" }, by)
			case "an int8 past 2^53":
				return aimedAt(
					[{ ...source.draw(storableItem(1)), big: "9007199254740993" }],
					{
						program: "atLeast",
						floor: "-9223372036854775808"
					},
					by
				)
			case "a call the server said to make again, made again":
				return source.draw(caseGen)
		}
	}

/** The required features, each a case aims at while it is pending. */
const FEATURES: Arr.NonEmptyReadonlyArray<Feature> = [
	"field flags",
	"a whole body",
	"a set read",
	"an empty read",
	"a key",
	"an ordered read from its start",
	"an ordered read from its end",
	"an ordered read from a key",
	"an instant read",
	"a write accepted",
	"a write unchanged",
	"a deletion",
	"a write a law refuses",
	"an input the server refuses",
	"an input the CLI refuses",
	"an int8 past 2^53"
]

/** A focus, or none, each half the time: none draws any case. */
const FOCUS: Gen<Option.Option<Feature>> = weighted([
	[1, constant(Option.none())],
	[1, (source) => Option.some(source.draw(element(FEATURES)))]
])

/** The case a run draws: while features are pending, one aimed at one of those (Case.steering); otherwise its focus's. */
const aimed = (focus: Option.Option<Feature>, k: SearchCase<Feature>): Gen<Case> =>
	Option.match(
		Option.orElse(
			Option.flatMap(k.steering, (pending) =>
				Option.map(
					Arr.match(
						Arr.filter(FEATURES, (feature) => pending.names(feature)),
						{ onEmpty: () => Option.none(), onNonEmpty: Option.some }
					),
					(pendingFeatures) => k.draw(element(pendingFeatures))
				)
			),
			() => focus
		),
		{ onNone: () => caseGen, onSome: caseFor }
	)

/** A call's whole request body. */
const bodyOf = (call: Call): Schema.Json => {
	switch (call.program) {
		case "atLeast":
			return { params: { floor: call.floor }, facts: {} }
		case "named":
			return { params: { name: call.name }, facts: {} }
		case "item":
			return { params: { id: call.id }, facts: {} }
		case "ranked":
			return { params: {}, facts: {}, window: { anchor: call.anchor, size: call.size } }
		case "past":
		case "clear":
			return { params: {}, facts: {} }
		case "put":
			return { params: {}, facts: { put: { Item: call.items } } }
	}
}

/** A call's field flags: each member the command takes from a flag, every constant member left to the CLI. */
const fieldArgs = (call: Call): ReadonlyArray<string> => {
	switch (call.program) {
		case "atLeast":
			return [`--params.floor=${call.floor}`]
		case "named":
			return [`--params.name=${call.name}`]
		case "item":
			return [`--params.id=${String(call.id)}`]
		case "ranked":
			return [`--window.anchor=${jsonTextOf(call.anchor)}`, `--window.size=${String(call.size)}`]
		case "past":
		case "clear":
			return []
		case "put":
			return [`--facts.put=${jsonTextOf({ Item: call.items })}`]
	}
}

/** The author config: the login's names, A's origin bound, plain HTTP allowed for the loopback server. */
const configOf = (url: string): string =>
	jsonTextOf({
		package: { name: "gz-eocg", version: "1.0.0" },
		binName: "gz-eocg",
		envPrefix: "GZ_EOCG",
		acceptedOrigins: [url],
		allowInsecure: true
	})

const Installed = Schema.Struct({
	url: Schema.String,
	document: Schema.String,
	caseHangMillis: Schema.Int
})

/** A CallError as the frames encode it: its kind, its retry and its payload's members. */
const CallErrorJson = Schema.StructWithRest(
	Schema.Struct({ kind: Schema.String, retry: Schema.String }),
	[Schema.Record(Schema.String, Schema.Json)]
)

/** B's answer to one call (test/fixtures/grizzle/driver.ts Answer). */
const Answer = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("rows"), rows: Schema.Array(Schema.Json) }),
	Schema.Struct({ kind: Schema.Literal("outcome"), outcome: Schema.Json }),
	Schema.Struct({ kind: Schema.Literal("error"), error: CallErrorJson })
])
type Answer = typeof Answer.Type

/** One line the CLI prints per event. */
const Printed = Schema.fromJsonString(Schema.Struct({ data: Schema.Json, event: Schema.String }))
type Printed = typeof Printed.Type

const ResetData = Schema.Struct({ key: Schema.Array(Schema.String) })
const UpsertData = Schema.Struct({ row: Schema.Json, after: Schema.optionalKey(Schema.Json) })
const OutcomeData = Schema.Struct({ outcome: Schema.Json })
const ErrorData = Schema.Struct({ error: CallErrorJson })
const isErrorData = Schema.is(ErrorData)
const OutcomeKind = Schema.Struct({ kind: Schema.String })
const RowFields = Schema.Record(Schema.String, Schema.Json)

/** What one CLI run left: its exit code, each event it printed, and its stderr. */
type Ran = Readonly<{ exitCode: number; printed: ReadonlyArray<Printed>; stderr: string }>

/**
 * Whether a run ended at a CallError the server says is safe to make again (live/events.ts callErrors `retry`): nothing
 * committed and the failure is not the call's own, such as `unavailable` while the server's live leader comes back
 * after its connection was lost. Such an answer is no answer of the call's: the property makes the call again, as
 * `--retries` does, until the server answers it.
 */
const saysAgain = (ran: Ran): boolean =>
	ran.exitCode === 1 &&
	Option.exists(
		Arr.last(ran.printed),
		(line) => line.event === "error" && isErrorData(line.data) && line.data.error.retry === "safe"
	)

type Feature =
	| "field flags"
	| "a whole body"
	| "a set read"
	| "an empty read"
	| "a key"
	| "an ordered read from its start"
	| "an ordered read from its end"
	| "an ordered read from a key"
	| "an instant read"
	| "a write accepted"
	| "a write unchanged"
	| "a deletion"
	| "a write a law refuses"
	| "an input the server refuses"
	| "an input the CLI refuses"
	| "an int8 past 2^53"
	| "a call the server said to make again, made again"

/** The events' names, in order. */
const eventsOf = (printed: ReadonlyArray<Printed>): ReadonlyArray<string> =>
	Arr.map(printed, (line) => line.event)

/** A difference, or none, as one call's check reports it. */
type Difference = Option.Option<string>

const agree: Difference = Option.none()

const differ = (text: string): Difference => Option.some(text)

/** The values of `row` at `fields`, in order: the row's key under the reset's key fields. */
const keyOf = (fields: ReadonlyArray<string>, row: Schema.Json) =>
	Effect.map(Schema.decodeUnknownEffect(RowFields)(row), (record) =>
		Arr.map(fields, (field): Schema.Json => Option.getOrElse(Rec.get(record, field), () => null))
	)

/**
 * The ordered read's rows as its upserts place them: each upsert's row removed where its key stood, then put after the
 * row its `after` key names, first for null; none where an `after` names no row the read holds.
 */
const placed = (fields: ReadonlyArray<string>, upserts: ReadonlyArray<typeof UpsertData.Type>) =>
	Effect.gen(function* () {
		let rows: ReadonlyArray<Readonly<{ key: Schema.Json; row: Schema.Json }>> = []
		for (const upsert of upserts) {
			const key = yield* keyOf(fields, upsert.row)
			const after = Option.getOrElse(Option.fromUndefinedOr(upsert.after), () => null)
			const kept = Arr.filter(rows, (entry) => Option.isSome(exact(entry.key, key)))
			const at =
				after === null
					? Option.some(0)
					: Option.map(
							Arr.findFirstIndex(kept, (entry) => Option.isNone(exact(entry.key, after))),
							(index) => index + 1
						)
			if (Option.isNone(at)) {
				return Option.none<ReadonlyArray<Schema.Json>>()
			}
			const inserted = Arr.insertAt(kept, at.value, { key, row: upsert.row })
			if (Option.isNone(inserted)) {
				return Option.none<ReadonlyArray<Schema.Json>>()
			}
			rows = inserted.value
		}
		return Option.some(Arr.map(rows, (entry) => entry.row))
	})

/** Whether an int8 spelling lies past 2^53 either way, where a JavaScript number holds no integer exactly. */
const past53 = (big: string): boolean => {
	const digits = Str.startsWith("-")(big) ? Str.slice(1)(big) : big
	return digits.length > 16 || (digits.length === 16 && digits > "9007199254740992")
}

const BigOf = Schema.Struct({ big: Schema.String })

/**
 * Whether the CLI's run answers what B answered (see the header), and the features it reached: none, or the
 * difference.
 */
const judged = (call: Call, ran: Ran, answer: Answer) =>
	Effect.gen(function* () {
		const events = eventsOf(ran.printed)
		const reached: Array<Feature> = []
		switch (answer.kind) {
			case "rows": {
				const instant = call.program === "past"
				const expected = [
					"reset",
					...Arr.map(answer.rows, () => "upsert"),
					"ready",
					...(instant ? ["end"] : [])
				]
				if (ran.exitCode !== 0 || !Arr.makeEquivalence(Str.Equivalence)(events, expected)) {
					return {
						difference: differ(
							`exit ${ran.exitCode} and events ${Formatter.format(events)}, not exit 0 and ${Formatter.format(expected)}`
						),
						reached
					}
				}
				const [reset] = ran.printed
				const fields =
					reset === undefined ? [] : (yield* Schema.decodeUnknownEffect(ResetData)(reset.data)).key
				const upserts = yield* Effect.forEach(
					Arr.filter(ran.printed, (line) => line.event === "upsert"),
					(line) => Schema.decodeUnknownEffect(UpsertData)(line.data)
				)
				const bigsSeen = yield* Effect.forEach(answer.rows, (row) =>
					Schema.decodeUnknownEffect(BigOf)(row)
				)
				if (Arr.some(bigsSeen, (row) => past53(row.big))) {
					reached.push("an int8 past 2^53")
				}
				switch (call.program) {
					case "ranked": {
						reached.push(
							call.anchor.kind === "start"
								? "an ordered read from its start"
								: call.anchor.kind === "end"
									? "an ordered read from its end"
									: "an ordered read from a key"
						)
						const rows = yield* placed(fields, upserts)
						return {
							difference: Option.match(rows, {
								onNone: () => differ("an upsert follows a key no row it read holds"),
								onSome: (list) => ordered(exact)(list, answer.rows)
							}),
							reached
						}
					}
					case "item":
						reached.push("a key")
						break
					case "past":
						reached.push("an instant read")
						break
					case "atLeast":
					case "named":
						reached.push(Arr.isReadonlyArrayEmpty(answer.rows) ? "an empty read" : "a set read")
						break
					case "put":
					case "clear":
						return { difference: differ("a write answered rows"), reached }
				}
				return {
					difference: set(structuralHash, exact)(
						Arr.map(upserts, (upsert) => upsert.row),
						answer.rows
					),
					reached
				}
			}
			case "outcome": {
				if (
					ran.exitCode !== 0 ||
					!Arr.makeEquivalence(Str.Equivalence)(events, ["outcome", "end"])
				) {
					return {
						difference: differ(
							`exit ${ran.exitCode} and events ${Formatter.format(events)}, not exit 0, outcome and end`
						),
						reached
					}
				}
				const [line] = ran.printed
				const printed =
					line === undefined
						? null
						: (yield* Schema.decodeUnknownEffect(OutcomeData)(line.data)).outcome
				const kind = (yield* Schema.decodeUnknownEffect(OutcomeKind)(answer.outcome)).kind
				reached.push(
					call.program === "clear"
						? "a deletion"
						: kind === "unchanged"
							? "a write unchanged"
							: "a write accepted"
				)
				return { difference: exact(printed, answer.outcome), reached }
			}
			case "error": {
				const input = answer.error.kind === "input"
				if (input && ran.exitCode === 2) {
					reached.push("an input the CLI refuses")
					return {
						difference: Arr.isReadonlyArrayEmpty(ran.printed)
							? agree
							: differ(`a body refused before sending printed ${Formatter.format(events)}`),
						reached
					}
				}
				const resets = Arr.dropRight(events, 1)
				if (
					ran.exitCode !== 1 ||
					Arr.last(events).pipe(Option.getOrElse(() => "")) !== "error" ||
					!Arr.every(resets, (event) => event === "reset") ||
					resets.length > 1
				) {
					return {
						difference: differ(
							`exit ${ran.exitCode} and events ${Formatter.format(events)}, not exit 1 and the error last`
						),
						reached
					}
				}
				const line = yield* Effect.fromOption(Arr.last(ran.printed))
				const printed = (yield* Schema.decodeUnknownEffect(ErrorData)(line.data)).error
				if (input) {
					reached.push("an input the server refuses")
				}
				if (answer.error.kind === "refused") {
					reached.push("a write a law refuses")
				}
				return {
					difference: input
						? exact(
								{ kind: printed.kind, retry: printed.retry },
								{ kind: answer.error.kind, retry: answer.error.retry }
							)
						: exact(printed, answer.error),
					reached
				}
			}
		}
	})

/** The suite's fixture: the driver, the CLI built from the login's document, and each program's command. */
class GrizzleFixture extends Context.Service<
	GrizzleFixture,
	Readonly<{
		driver: GrizzleDriver
		url: string
		caseHangMillis: number
		built: BuiltPackage
		commands: Readonly<Record<Program, ReadonlyArray<string>>>
	}>
>()("effect-openapi-cli-generator/test/grizzle/once.test/GrizzleFixture") {}

const fixture = Layer.effect(
	GrizzleFixture,
	Effect.gen(function* () {
		const driver = yield* grizzleDriver
		const installed = yield* Effect.flatMap(
			driver.ask({ op: "install" }),
			Schema.decodeUnknownEffect(Installed)
		)
		const generated = yield* generateFixture({
			spec: { path: "openapi.json", text: installed.document },
			config: { path: "author-config.json", text: configOf(installed.url) },
			authorFiles: []
		})
		const built = yield* buildPackage(generated)
		const names = generated.result.report.commandNames
		const commandOf = (program: Program) =>
			Effect.fromOption(
				Arr.findFirst(names, (name) => name.pointer === `/paths/~1server~1app~1${program}/post`)
			).pipe(Effect.map((name) => name.path))
		const commands: Record<Program, ReadonlyArray<string>> = {
			atLeast: yield* commandOf("atLeast"),
			named: yield* commandOf("named"),
			item: yield* commandOf("item"),
			ranked: yield* commandOf("ranked"),
			past: yield* commandOf("past"),
			put: yield* commandOf("put"),
			clear: yield* commandOf("clear")
		}
		return { driver, url: installed.url, caseHangMillis: installed.caseHangMillis, built, commands }
	})
).pipe(Layer.provideMerge(harnessLayer))

const decoder = new TextDecoder()

/**
 * `effect`, which says on stderr what it was doing when it is interrupted, as a case is at its hang guard: the report
 * names the case, and this line the step of it that did not end.
 */
const during = <A, E, R>(step: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
	Effect.onInterrupt(effect, () => Console.error(`grizzle once: interrupted while ${step}`))

layer(fixture, { excludeTestServices: true })("a generated CLI against a grizzle server", (it) => {
	it.effect("answers every call as grizzle's in-process once answers it", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { driver, url, caseHangMillis, built, commands } = yield* GrizzleFixture
				return yield* explore(
					{
						suite: "grizzle once",
						oracle: {
							kind: "second-implementation",
							name: "grizzle's in-process once of the same call on a twin installation, encoded as its server frames encode it"
						},
						draw: drawn(FOCUS),
						literal: Formatter.format,
						coverage: required<Feature>(FEATURES, { cases: 32, sense: notesOnly }),
						kept: [],
						runs: 16,
						shrink: { kind: "bounded", candidates: 24 },
						concurrency: 1,
						steerEvery: 1,
						caseHang: Duration.millis(caseHangMillis)
					},
					(focus, notes) =>
						Effect.gen(function* () {
							const c = notes.draw(aimed(focus, notes))
							yield* during(
								"storing the case's items",
								driver.ask({ op: "store", stored: c.stored })
							)
							for (const { call, by } of c.calls) {
								notes.note(by === "fields" ? "field flags" : "a whole body")
								const body = bodyOf(call)
								const args = by === "fields" ? fieldArgs(call) : [`--body=${jsonTextOf(body)}`]
								const cli = Effect.gen(function* () {
									const finished = yield* during(
										`the CLI's ${call.program} by ${by}`,
										runBin(built, {
											args: [...commands[call.program], "--base-url", url, ...args],
											env: {},
											stdin: new Uint8Array(0)
										})
									)
									const lines = Arr.filter(
										Str.split("\n")(decoder.decode(finished.stdout)),
										Str.isNonEmpty
									)
									const printed = yield* Effect.forEach(lines, (line) =>
										Schema.decodeEffect(Printed)(line)
									)
									const ran: Ran = {
										exitCode: finished.exitCode,
										printed,
										stderr: decoder.decode(finished.stderr)
									}
									return ran
								})
								const once = during(
									`grizzle's once of ${call.program}`,
									Effect.flatMap(
										driver.ask({ op: "once", program: call.program, body }),
										Schema.decodeUnknownEffect(Answer)
									)
								)
								const ran = yield* Effect.repeat(cli, {
									while: (answered) => {
										const again = saysAgain(answered)
										if (again) {
											notes.note("a call the server said to make again, made again")
										}
										return again
									}
								})
								const answer = yield* Effect.repeat(once, {
									while: (answered) => answered.kind === "error" && answered.error.retry === "safe"
								})
								const verdict = yield* judged(call, ran, answer)
								notes.noteAll(verdict.reached)
								if (Option.isSome(verdict.difference)) {
									return fail(
										`${call.program} by ${by}: ${verdict.difference.value}\nthe CLI printed:\n${Arr.join(
											Arr.map(ran.printed, (line) => jsonTextOf(line)),
											"\n"
										)}\nits stderr:\n${ran.stderr}\ngrizzle's once answered:\n${jsonTextOf(answer)}`
									)
								}
							}
						})
				)
			})
		)
	)
})
