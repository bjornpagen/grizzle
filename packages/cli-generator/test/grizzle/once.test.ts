/**
 * A generated CLI calling a live grizzle server over HTTP answers what grizzle's own HTTP door answers the same call.
 *
 * The tier's twins (twins.ts) are one login (world.ts) installed twice on the generator's local cluster through grizzle's
 * command line, as an application installs it: twin A served over HTTP by grizzle's handler, twin B by the same handler
 * in process. The generator builds the CLI from the login's OpenAPI document as `grizzle generate` writes it, its
 * author config binding A's origin. Each case stores drawn items in both twins, then makes one to four drawn calls, each
 * through the CLI against A and through B's handler, in the same order, the CLI's by field flags or by one whole
 * `--body`. The login's members are a set read by an int8 floor, a set read by a refined text, a key, an ordered read
 * paged from either end, from a key or at a position, a read at the call's instant bound to the database's clock, a
 * put whose items carry every carrier the fixture holds, and a deletion of every item.
 *
 * The oracle is B's answer, its events as grizzle's handler frames them:
 *
 * - rows: the CLI exits 0 and prints `reset`, one `upsert` per row and `ready`, then `end` for the instant read alone;
 *   its rows are B's, a set read's as a set and the ordered read's in the order its upserts' `after` keys chain them;
 * - an outcome: the CLI exits 0 and prints the `outcome`, then `end`, the outcome B's;
 * - a CallError: the CLI exits 1 and prints the `error` event last, after the read's `reset` where the read was refused
 *   as it ran, its CallError B's, an `input` refusal's kind and retry alone, since the CLI's body states the call's
 *   members as its flags spell them; or, for `input` alone, the CLI exits 2 and prints nothing, having refused the
 *   body before sending it.
 *
 * A case may follow a read first (`--follow`: a set read by its floor or name, a key, or a page from either end), over
 * stored items whose int8 lies inside the type's ends: once the CLI has printed its `ready`, a put through the CLI
 * stores an item the read sees (at the greatest or least int8 for a floor or a page, of the read's name, or the key's
 * own item changed), and the same put runs on B. The followed CLI must then print the change, upserts and removes
 * only, and `ready` again; interrupted, it exits 130, and the rows its events leave are B's answer to the read after
 * the put.
 *
 * The CLI asserts no `pattern` (SCH-37), so a value grizzle's spelling refuses (an int8, a decimal, a refined text) or
 * a float4 no binary32 number is reaches the server, and is the `input` it answers there.
 *
 * A CallError whose `retry` is `safe`, from either side, is no answer of the call's: nothing committed, so the call is
 * made again, as `--retries` makes it, until it is answered. Its budget is the count the suite stated before it was
 * converted to a property: 16 independent cases, and up to 32 steered while a situation is unreached.
 */
import { jsonText } from "@bjornpagen/grizzle-text/utf8"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import {
	aimed,
	constant,
	element,
	type Gen,
	int,
	shuffled,
	weighted
} from "@bjornpagen/testing/gen"
import { exact, ordered, set, structuralHash } from "@bjornpagen/testing/oracle"
import { type Case, property } from "@bjornpagen/testing/property"
import { HARDENED_FLAGS } from "@bjornpagen/testing/runner"
import {
	Array as Arr,
	type Cause,
	Console,
	Effect,
	Formatter,
	Option,
	Queue,
	Record as Rec,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { Json } from "#model/pointer.ts"
import {
	anything,
	array,
	member,
	object,
	optionalMember,
	property as propertyOf,
	type Reader,
	record,
	string
} from "#runtime/read.ts"
import {
	type CallError,
	called,
	endsSafeAgain,
	errorData,
	type Event,
	json,
	lastOf,
	readText,
	readValue,
	store,
	type Twins,
	twinsNeed
} from "#test/grizzle/twins.ts"
import { runBin } from "#test/support/cli-package.ts"
import { chunkText, streamText } from "#test/support/stdio.ts"

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

/** A page's anchor: either end, the key (big, id) a page follows or precedes, or a position, the rows before it. */
type Anchor =
	| Readonly<{ kind: "start" }>
	| Readonly<{ kind: "end" }>
	| Readonly<{ kind: "after" | "before"; key: readonly [string, number] }>
	| Readonly<{ kind: "at"; position: number }>

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

/** A read the CLI may follow past its `ready`: a set read by a floor or a name, a key, or a page from either end. */
type LiveRead =
	| Readonly<{ program: "atLeast"; floor: string }>
	| Readonly<{ program: "named"; name: string }>
	| Readonly<{ program: "item"; id: number }>
	| Readonly<{ program: "ranked"; anchor: Readonly<{ kind: "start" | "end" }>; size: number }>

/**
 * A followed read: the read the CLI follows past its `ready` (`--follow`), and the item a put stores once the read is
 * ready, which the read sees, so the change must reach the followed CLI.
 */
type Follow = Readonly<{ read: LiveRead; by: By; write: Item; writeBy: By }>

/** A scenario: the items stored in both twins, perhaps a followed read first, then the calls, in order. */
type Scenario = Readonly<{
	stored: ReadonlyArray<Item>
	follow: Option.Option<Follow>
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

/** The int8 type's ends, which a followed read's put takes so its item sorts first or last. */
const greatest = "9223372036854775807"
const least = "-9223372036854775808"

/** int8 spellings strictly between the type's ends: what a followed read's stored items hold. */
const innerBigs: Arr.NonEmptyReadonlyArray<string> = [
	"0",
	"5",
	"-3",
	"1700000000000",
	"9007199254740993"
]

/** An item of id `id` whose every value its field admits, its int8 one of `among`. */
const storableWithin =
	(id: number, among: Arr.NonEmptyReadonlyArray<string>): Gen<Item> =>
	(source) => ({
		...source.draw(storableItem(id)),
		big: source.draw(element(among))
	})

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

/** The positions a page is read at: the first row, within the stored items, and past every one. */
const positionGen: Gen<number> = int(0, storedIds.length + 1)

const anchorGen =
	(stored: ReadonlyArray<Item>): Gen<Anchor> =>
	(source) => {
		const kind = source.draw(element(["start", "end", "after", "before", "at"] as const))
		if (kind === "start" || kind === "end") {
			return { kind }
		}
		if (kind === "at") {
			return { kind, position: source.draw(positionGen) }
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

/** The id no stored item takes, which a followed read's put gives a new item. */
const freshId = 7

/**
 * A followed read over `stored`, whose items hold no int8 at the type's ends, and the put its change comes from, made
 * so the read sees it: a new item at the greatest int8 for a floor and a page from the start (it sorts first), at the
 * least for a page from the end (it sorts last), of the read's name for a name, and the key's own item changed, or new
 * where none is stored, for a key.
 */
const followGen =
	(stored: ReadonlyArray<Item>): Gen<Follow> =>
	(source) => {
		const by = source.draw(element<By>(["fields", "body"]))
		const writeBy = source.draw(element<By>(["fields", "body"]))
		const fresh = source.draw(storableItem(freshId))
		const read = source.draw(element(["atLeast", "named", "item", "ranked"] as const))
		switch (read) {
			case "atLeast":
				return {
					read: { program: read, floor: source.draw(element(bigs)) },
					by,
					write: { ...fresh, big: greatest },
					writeBy
				}
			case "named": {
				const name = source.draw(element(names))
				return { read: { program: read, name }, by, write: { ...fresh, name }, writeBy }
			}
			case "item": {
				const id = source.draw(element(storedIds))
				const write = Option.match(
					Arr.findFirst(stored, (item) => item.id === id),
					{
						onNone: () => source.draw(storableItem(id)),
						onSome: (item) => ({ ...item, flag: !item.flag })
					}
				)
				return { read: { program: read, id }, by, write, writeBy }
			}
			case "ranked": {
				const kind = source.draw(element(["start", "end"] as const))
				return {
					read: { program: read, anchor: { kind }, size: source.draw(int(1, 4)) },
					by,
					write: { ...fresh, big: kind === "start" ? greatest : least },
					writeBy
				}
			}
		}
	}

/** The calls after a case's followed read: one to four, each drawn over `stored`. */
const callsGen =
	(stored: ReadonlyArray<Item>, min: number): Gen<Scenario["calls"]> =>
	(source) =>
		Array.from({ length: source.draw(int(min, 4)) }, () => ({
			call: source.draw(callGen(stored)),
			by: source.draw(element<By>(["fields", "body"]))
		}))

/** A case with a followed read first: items whose int8 lies inside the type's ends, the read, then calls. */
const followedCase: Gen<Scenario> = (source) => {
	const ids = source.draw(shuffled(storedIds, { min: 0, max: 5 }))
	const stored = Arr.map(ids, (id) => source.draw(storableWithin(id, innerBigs)))
	return {
		stored,
		follow: Option.some(source.draw(followGen(stored))),
		calls: source.draw(callsGen(stored, 0))
	}
}

/** Any case: a followed read first one time in four, else one to four calls over any stored items. */
const caseGen: Gen<Scenario> = (source) => {
	if (
		source.draw(
			weighted([
				[1, constant(true)],
				[3, constant(false)]
			])
		)
	) {
		return source.draw(followedCase)
	}
	const ids = source.draw(shuffled(storedIds, { min: 0, max: 5 }))
	const stored = Arr.map(ids, (id) => source.draw(storableItem(id)))
	return { stored, follow: Option.none(), calls: source.draw(callsGen(stored, 1)) }
}

/** A case made to reach `feature`: the stored items and the one call that reach it, then any calls, every other choice drawn. */
const caseFor =
	(feature: Feature): Gen<Scenario> =>
	(source) => {
		const by = source.draw(element<By>(["fields", "body"]))
		const ids = source.draw(shuffled(storedIds, { min: 1, max: 5 }))
		const stored = Arr.map(ids, (id) => source.draw(storableItem(id)))
		const aimedAt = (items: ReadonlyArray<Item>, call: Call, callBy: By): Scenario => ({
			stored: items,
			follow: Option.none(),
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
			case "an ordered read at a position":
				return aimedAt(
					stored,
					{
						program: "ranked",
						anchor: { kind: "at", position: source.draw(positionGen) },
						size: source.draw(int(1, 4))
					},
					by
				)
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
			case "a live change reaching a followed read":
				return source.draw(followedCase)
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
	"an ordered read at a position",
	"an instant read",
	"a write accepted",
	"a write unchanged",
	"a deletion",
	"a write a law refuses",
	"an input the server refuses",
	"an input the CLI refuses",
	"an int8 past 2^53",
	"a live change reaching a followed read"
]

/** The feature an ordered read reaches by its anchor's kind. */
const orderedReadFrom: { readonly [K in Anchor["kind"]]: Feature } = {
	start: "an ordered read from its start",
	end: "an ordered read from its end",
	after: "an ordered read from a key",
	before: "an ordered read from a key",
	at: "an ordered read at a position"
}

/** A call's whole request body. */
const bodyOf = (call: Call): Json => {
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
			return [`--window.anchor=${jsonText(call.anchor)}`, `--window.size=${String(call.size)}`]
		case "past":
		case "clear":
			return []
		case "put":
			return [`--facts.put=${jsonText({ Item: call.items })}`]
	}
}

/** A call's arguments after its command: its field flags, or its whole body as `--body`. */
const argsOf = (call: Call, by: By): ReadonlyArray<string> =>
	by === "fields" ? fieldArgs(call) : [`--body=${jsonText(bodyOf(call))}`]

/** B's answer to one call: a read's rows in its order, a write's outcome, or its CallError, as its events give them. */
type Answer =
	| Readonly<{ kind: "rows"; rows: ReadonlyArray<Json> }>
	| Readonly<{ kind: "outcome"; outcome: Json }>
	| Readonly<{ kind: "error"; error: CallError }>

/** One line the CLI prints per event: its data and its name. */
const printedLine: Reader<Event> = object(
	(line) => ({ data: member(line, "data", json), event: member(line, "event", string) }),
	anything
)

/** A `reset` event's data: the key fields of the rows that follow. */
const resetKey: Reader<ReadonlyArray<string>> = propertyOf("key", array(string))

/** An `upsert` event's data: its row, and the key of the row it follows where the read is ordered. */
const upsertData = object(
	(data) => ({ row: member(data, "row", json), after: optionalMember(data, "after", json) }),
	anything
)

/** A `remove` event's data: the key of the row it takes out. */
const removeKey: Reader<Json> = propertyOf("key", json)

/** An `outcome` event's data: the outcome. */
const outcomeData: Reader<Json> = propertyOf("outcome", json)

/** An outcome's kind. */
const outcomeKind: Reader<string> = propertyOf("kind", string)

/** A row's fields, by name. */
const rowFields = record(string, json)

/** Each event line of a run's stdout, read; a line that is no event fails the case. */
const printedOf = (stdout: string) =>
	Effect.forEach(Arr.filter(Str.split("\n")(stdout), Str.isNonEmpty), (line) =>
		readText("a line the CLI printed", printedLine, line)
	)

/** What one CLI run left: its exit code, each event it printed, and its stderr. */
type Ran = Readonly<{ exitCode: number; printed: ReadonlyArray<Event>; stderr: string }>

/**
 * Whether a run ended at a CallError the server says is safe to make again (live/events.ts callErrors `retry`): nothing
 * committed and the failure is not the call's own, such as `unavailable` while the server's live leader comes back
 * after its connection was lost. Such an answer is no answer of the call's: the property makes the call again, as
 * `--retries` does, until the server answers it.
 */
const saysAgain = (ran: Ran): boolean => ran.exitCode === 1 && endsSafeAgain(ran.printed)

type Feature =
	| "field flags"
	| "a whole body"
	| "a set read"
	| "an empty read"
	| "a key"
	| "an ordered read from its start"
	| "an ordered read from its end"
	| "an ordered read from a key"
	| "an ordered read at a position"
	| "an instant read"
	| "a write accepted"
	| "a write unchanged"
	| "a deletion"
	| "a write a law refuses"
	| "an input the server refuses"
	| "an input the CLI refuses"
	| "an int8 past 2^53"
	| "a live change reaching a followed read"
	| "a call the server said to make again, made again"

/** The events' names, in order. */
const eventsOf = (printed: ReadonlyArray<Event>): ReadonlyArray<string> =>
	Arr.map(printed, (line) => line.event)

/** A difference, or none, as one call's check reports it. */
type Difference = Option.Option<string>

const agree: Difference = Option.none()

const differ = (text: string): Difference => Option.some(text)

/** The values of `row` at `fields`, in order: the row's key under the reset's key fields. */
const keyOf = (fields: ReadonlyArray<string>, row: Json) =>
	Effect.map(readValue("an upserted row", rowFields, row), (fieldsOfRow) =>
		Arr.map(fields, (field): Json => Option.getOrElse(Rec.get(fieldsOfRow, field), () => null))
	)

/**
 * The rows a read's events leave, in order: each upsert's row taken out where its key stood, then put after the row
 * its `after` key names, first for null, where the read is ordered, and last where it is a set; each remove's key taken
 * out. None where an `after` names no row the read holds.
 */
const folded = (fields: ReadonlyArray<string>, printed: ReadonlyArray<Event>, isOrdered: boolean) =>
	Effect.gen(function* () {
		let rows: ReadonlyArray<Readonly<{ key: Json; row: Json }>> = []
		for (const line of printed) {
			if (line.event === "remove") {
				const key = yield* readValue("a remove's data", removeKey, line.data)
				rows = Arr.filter(rows, (entry) => Option.isSome(exact(entry.key, key)))
			}
			if (line.event === "upsert") {
				const upsert = yield* readValue("an upsert's data", upsertData, line.data)
				const key = yield* keyOf(fields, upsert.row)
				const after = Option.getOrElse(upsert.after, () => null)
				const kept = Arr.filter(rows, (entry) => Option.isSome(exact(entry.key, key)))
				const at = !isOrdered
					? Option.some(kept.length)
					: after === null
						? Option.some(0)
						: Option.map(
								Arr.findFirstIndex(kept, (entry) => Option.isNone(exact(entry.key, after))),
								(index) => index + 1
							)
				const inserted = Option.flatMap(at, (index) =>
					Arr.insertAt(kept, index, { key, row: upsert.row })
				)
				if (Option.isNone(inserted)) {
					return Option.none<ReadonlyArray<Json>>()
				}
				rows = inserted.value
			}
		}
		return Option.some(Arr.map(rows, (entry) => entry.row))
	})

/** The key fields a read's `reset` names, none where it printed no reset first. */
const resetFields = (printed: ReadonlyArray<Event>) =>
	Option.match(Arr.head(printed), {
		onNone: () => Effect.succeed<ReadonlyArray<string>>([]),
		onSome: (line) =>
			line.event === "reset"
				? readValue("a reset's data", resetKey, line.data)
				: Effect.succeed<ReadonlyArray<string>>([])
	})

/** The rows `printed` leaves compared with `rows`: as a list where the read is ordered, as a set otherwise. */
const sameRows = (
	fields: ReadonlyArray<string>,
	printed: ReadonlyArray<Event>,
	rows: ReadonlyArray<Json>,
	isOrdered: boolean
) =>
	Effect.map(folded(fields, printed, isOrdered), (left) =>
		Option.match(left, {
			onNone: () => differ("an upsert follows a key no row it read holds"),
			onSome: (list) =>
				isOrdered ? ordered(exact)(list, rows) : set(structuralHash, exact)(list, rows)
		})
	)

/** Whether an int8 spelling lies past 2^53 either way, where a JavaScript number holds no integer exactly. */
const past53 = (big: string): boolean => {
	const digits = Str.startsWith("-")(big) ? Str.slice(1)(big) : big
	return digits.length > 16 || (digits.length === 16 && digits > "9007199254740992")
}

/** A row's int8. */
const rowBig: Reader<string> = propertyOf("big", string)

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
				const fields = yield* resetFields(ran.printed)
				const bigsSeen = yield* Effect.forEach(answer.rows, (row) =>
					readValue("a row grizzle's door answered", rowBig, row)
				)
				if (Arr.some(bigsSeen, past53)) {
					reached.push("an int8 past 2^53")
				}
				switch (call.program) {
					case "ranked": {
						reached.push(orderedReadFrom[call.anchor.kind])
						return { difference: yield* sameRows(fields, ran.printed, answer.rows, true), reached }
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
				return { difference: yield* sameRows(fields, ran.printed, answer.rows, false), reached }
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
					line === undefined ? null : yield* readValue("an outcome's data", outcomeData, line.data)
				const kind = yield* readValue(
					"the outcome grizzle's door answered",
					outcomeKind,
					answer.outcome
				)
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
				const printed = yield* readValue("an error's data", errorData, line.data)
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

/**
 * B's answer as its events give it: the `error` they end at, else the `outcome` they hold, else the rows a read's
 * events leave, in order where the read is ordered.
 */
const answerOf = (call: Call, events: ReadonlyArray<Event>) =>
	Effect.gen(function* () {
		const refused = Arr.findFirst(events, (event) => event.event === "error")
		if (Option.isSome(refused)) {
			const error = yield* readValue("an error's data", errorData, refused.value.data)
			const answer: Answer = { kind: "error", error }
			return answer
		}
		const outcome = Arr.findFirst(events, (event) => event.event === "outcome")
		if (Option.isSome(outcome)) {
			const answered = yield* readValue("an outcome's data", outcomeData, outcome.value.data)
			const answer: Answer = { kind: "outcome", outcome: answered }
			return answer
		}
		const fields = yield* resetFields(events)
		const rows = yield* Effect.flatMap(
			folded(fields, events, call.program === "ranked"),
			Effect.fromOption
		)
		const answer: Answer = { kind: "rows", rows }
		return answer
	})

/**
 * `effect`, which says on stderr what it was doing when it is interrupted, as a case is at its hang guard: the report
 * names the case, and this line the step of it that did not end.
 */
const during = <A, E, R>(step: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
	Effect.onInterrupt(effect, () => Console.error(`grizzle once: interrupted while ${step}`))

/** The command of `program`, as the CLI names it. */
const commandOf = (twins: Twins, program: Program) =>
	Effect.fromOption(Option.fromUndefinedOr(twins.commands.get(program)))

/** A failed case naming the call, what the CLI printed and what B answered. */
const differs = (
	what: string,
	difference: string,
	printed: ReadonlyArray<Event>,
	stderr: string,
	answer: Answer
) =>
	assert.fail(
		`${what}: ${difference}\nthe CLI printed:\n${Arr.join(
			Arr.map(printed, (line) => jsonText(line)),
			"\n"
		)}\nits stderr:\n${stderr}\ngrizzle's door answered:\n${jsonText(answer)}`
	)

/** A generated CLI answers every call as grizzle's own HTTP door answers it (see the header). */
export const grizzleOnce = property.explore(
	aimed(
		caseGen,
		Arr.map(FEATURES, (feature) => [feature, caseFor(feature)] as const)
	),
	{
		needs: { twins: twinsNeed },
		situations: FEATURES satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ twins: twinsOf }, notes: Case<Feature>) =>
			(c) =>
				Effect.gen(function* () {
					const twins = yield* twinsOf
					/** The CLI's run of `call`, by `by`, made again while it ends at an error safe to make again. */
					const cliRun = (call: Call, by: By) =>
						Effect.repeat(
							Effect.gen(function* () {
								const command = yield* commandOf(twins, call.program)
								const run = yield* during(
									`the CLI's ${call.program} by ${by}`,
									runBin(twins.built, {
										args: [...command, "--base-url", twins.url, ...argsOf(call, by)],
										env: {},
										stdin: new Uint8Array(0)
									})
								)
								const stdout = yield* chunkText(run.stdout)
								const printed = yield* printedOf(stdout)
								const stderr = yield* chunkText(run.stderr)
								const ran: Ran = { exitCode: run.exitCode, printed, stderr }
								return ran
							}),
							{
								while: (answered) => {
									const again = saysAgain(answered)
									if (again) {
										notes.note("a call the server said to make again, made again")
									}
									return again
								}
							}
						)
					/** B's answer to `call`, asked again while it answers an error safe to make again. */
					const onceOf = (call: Call) =>
						Effect.repeat(
							during(
								`grizzle's door answering ${call.program}`,
								Effect.flatMap(
									called(twins, twins.b, call.program, bodyOf(call), lastOf(call.program)),
									(events) => answerOf(call, events)
								)
							),
							{
								while: (answered) => answered.kind === "error" && answered.error.retry === "safe"
							}
						)
					yield* during("storing the case's items", store(twins, c.stored))
					if (Option.isSome(c.follow)) {
						const follow = c.follow.value
						const write: Call = { program: "put", items: [follow.write] }
						const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
						const command = yield* commandOf(twins, follow.read.program)
						const handle = yield* spawner.spawn(
							ChildProcess.make(
								process.execPath,
								[
									...HARDENED_FLAGS,
									twins.built.bin,
									...command,
									"--base-url",
									twins.url,
									"--follow",
									...argsOf(follow.read, follow.by)
								],
								{ cwd: twins.built.dir, env: {}, extendEnv: false }
							)
						)
						const lines = yield* Queue.unbounded<string, Cause.Done>()
						yield* Effect.forkScoped(
							Stream.runForEach(Stream.splitLines(streamText(handle.stdout)), (line) =>
								Queue.offer(lines, line)
							).pipe(Effect.ensuring(Queue.end(lines)))
						)
						const seen: Array<Event> = []
						/** The followed CLI's events through its next `ready`, false where its stream ended first. */
						const throughReady = during(
							`the CLI following ${follow.read.program} by ${follow.by}`,
							Effect.gen(function* () {
								for (;;) {
									const line = yield* Effect.option(Queue.take(lines))
									if (Option.isNone(line)) {
										return false
									}
									const printed = yield* readText(
										"a line the followed CLI printed",
										printedLine,
										line.value
									)
									seen.push(printed)
									if (printed.event === "ready") {
										return true
									}
								}
							})
						)
						const readyFirst = yield* throughReady
						const before = seen.length
						const written = yield* cliRun(write, follow.writeBy)
						const writtenOnce = yield* onceOf(write)
						if (written.exitCode !== 0 || writtenOnce.kind !== "outcome") {
							return differs(
								`put by ${follow.writeBy}, made while ${follow.read.program} was followed`,
								"the put a followed read sees did not store its item",
								written.printed,
								written.stderr,
								writtenOnce
							)
						}
						const readyAgain = readyFirst && (yield* throughReady)
						if (readyAgain) {
							yield* Effect.ignore(handle.kill({ killSignal: "SIGINT" }))
						}
						const exitCode = yield* during(
							"the followed CLI's exit once interrupted",
							handle.exitCode
						)
						const answer = yield* onceOf(follow.read)
						const live = Arr.map(Arr.drop(seen, before), (line) => line.event)
						const fields = yield* resetFields(seen)
						const difference =
							!readyAgain || answer.kind !== "rows"
								? differ("the followed stream ended before the put's change reached it")
								: Arr.isReadonlyArrayEmpty(live) ||
									  !Arr.every(
											Arr.dropRight(live, 1),
											(event) => event === "upsert" || event === "remove"
									  )
									? differ(`the put's change arrived as ${Formatter.format(live)}`)
									: exitCode !== 130
										? differ(`the followed CLI exited ${exitCode} when interrupted, not 130`)
										: yield* sameRows(fields, seen, answer.rows, follow.read.program === "ranked")
						if (Option.isSome(difference)) {
							return differs(
								`${follow.read.program} followed by ${follow.by}`,
								difference.value,
								seen,
								"",
								answer
							)
						}
						notes.noteAll([
							"a live change reaching a followed read",
							follow.by === "fields" ? "field flags" : "a whole body"
						])
					}
					for (const { call, by } of c.calls) {
						notes.note(by === "fields" ? "field flags" : "a whole body")
						const ran = yield* cliRun(call, by)
						const answer = yield* onceOf(call)
						const verdict = yield* judged(call, ran, answer)
						notes.noteAll(verdict.reached)
						if (Option.isSome(verdict.difference)) {
							return differs(
								`${call.program} by ${by}`,
								verdict.difference.value,
								ran.printed,
								ran.stderr,
								answer
							)
						}
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "grizzle's own HTTP door answering the same call in process, on a twin installation of the login"
		},
		kept: [],
		budget: { runs: 16, steered: 32 },
		kills: [
			{
				file: "packages/cli-generator/src/runtime-src/runtime/sse.ts",
				original: '\tFlag.map((follow): StopAt => (follow ? "terminal" : "ready"))',
				replacement: '\tFlag.map((follow): StopAt => (follow ? "ready" : "ready"))',
				why: "--follow stops at the first ready as an unfollowed read does, so the CLI exits before the put made once it printed ready reaches it, and a live change never reaches a followed read; the property fails."
			}
		]
	}
)

/** The login's live reads, whose streams go on past their `ready`: the set reads, the key and the page. */
const liveReads = ["atLeast", "named", "ranked", "item"] as const

/** The login's reads answered at their call's instant alone: the clocked `past` and the answered(...) `listed`. */
const answeredReads = ["past", "listed"] as const

/** A live read of the login, with its liveness. */
const liveGen: Gen<readonly [string, boolean]> = (source) =>
	[source.draw(element(liveReads)), true] as const

/** A read of the login answered at its call's instant alone, with its liveness. */
const answeredGen: Gen<readonly [string, boolean]> = (source) =>
	[source.draw(element(answeredReads)), false] as const

/** One read of the login and whether it is live: a live one or an answered one, then one read of it. */
const readGen: Gen<readonly [string, boolean]> = (source) =>
	source.draw(
		weighted([
			[1, liveGen],
			[1, answeredGen]
		])
	)

/** What the follow property reaches: a live read's command, and an answered read's. */
type FollowFeature = "a live read's command" | "an answered read's command"

/**
 * A generated CLI offers --follow exactly for a live read: an answered read's operation (an answered(...) or a clocked
 * member's) says in its `ready`'s x-stream that `end` follows it, so its command's help lists no --follow, while every
 * live read's lists it.
 */
export const grizzleFollowsLiveReadsAlone = property.explore(
	aimed(readGen, [
		["a live read's command", liveGen],
		["an answered read's command", answeredGen]
	] as const),
	{
		needs: { twins: twinsNeed },
		situations: ["a live read's command", "an answered read's command"] satisfies ReadonlyArray<
			Reached<FollowFeature>
		>,
		check:
			({ twins: twinsOf }, notes: Case<FollowFeature>) =>
			([program, live]) =>
				Effect.gen(function* () {
					const twins = yield* twinsOf
					const command = yield* Effect.fromOption(
						Option.fromUndefinedOr(twins.commands.get(program))
					)
					const run = yield* runBin(twins.built, {
						args: [...command, "--help"],
						env: {},
						stdin: new Uint8Array(0)
					})
					const help = `${yield* chunkText(run.stdout)}${yield* chunkText(run.stderr)}`
					notes.note(live ? "a live read's command" : "an answered read's command")
					assert.equal(
						Str.includes("--follow")(help),
						live,
						`${program}'s help ${live ? "lists" : "lists no"} --follow:\n${help}`
					)
				}),
		oracle: {
			kind: "specification",
			name: "each read's liveness as the login declares it: answered(...) and clocked reads answered once, every other live"
		},
		kept: [],
		budget: { runs: 6, steered: 6 },
		kills: [
			{
				file: "packages/cli-generator/src/emit/cli.ts",
				original: '\t\t\t\t\t(event) => event.role === "ready" && !("next" in event)',
				replacement: '\t\t\t\t\t(event) => event.role === "ready"',
				why: "Every command whose stream names a ready offers --follow, an answered read's too, whose stream ends at its ready: answered treated as live; the property fails."
			}
		]
	}
)
