import { regex } from "arkregex"
import { Array as Arr, Effect, Option, Schema, String as Str } from "effect"
import { tokenOf, valuesFromToken } from "#tape.ts"

/**
 * What a case was drawn under: steered by the required situations still pending when its window began, named by
 * their places among the suite's declared requirements in ascending order, or unsteered, as a rotating
 * case and a kept case are. A property that steers decodes one tape into different programs under different steering,
 * so a replay draws under exactly what its case was drawn under.
 */
const Drawn = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("unsteered") }),
	Schema.Struct({ kind: Schema.Literal("steered"), pending: Schema.Array(Schema.Int) })
])

export type Drawn = typeof Drawn.Type

/** One case as a replay runs it again: what it was drawn under, and every value of its tape, the property's own draws
 * and observations included. */
export const ReplayCase = Schema.Struct({ drawn: Drawn, values: Schema.Array(Schema.Int) })

export type ReplayCase = typeof ReplayCase.Type

/** A replay request: the suite whose streams give way to one case, and that case. */
export type Replay = Readonly<{ suite: string; replayed: ReplayCase }>

/** A `TEST_REPLAY` value that is no replay token. */
class ReplayTokenUnreadable extends Schema.TaggedError<
	ReplayTokenUnreadable,
	{ readonly brand: unique symbol }
>()("ReplayTokenUnreadable", { token: Schema.String, message: Schema.String }) {}

const NIBBLE = 4

const UNSTEERED = "-"

/** A steering field: `-`, or a hexadecimal mask. */
const STEERING = regex("^(-|[0-9a-f]+)$")

/** A tape field: base-36 whole numbers joined by dots, or nothing for an empty tape. */
const VALUES = regex("^(-?[0-9a-z]+([.]-?[0-9a-z]+)*)?$")

/** The hexadecimal mask whose bit `i` is set when requirement `i` is among `pending`, most significant digit first. */
const maskOf = (pending: ReadonlyArray<number>): string => {
	const nibbles = new Uint8Array(
		Arr.reduce(pending, 1, (width, place) => Math.max(width, Math.floor(place / NIBBLE) + 1))
	)
	for (const place of pending) {
		const at = Math.floor(place / NIBBLE)
		nibbles[at] = (nibbles[at] ?? 0) | (1 << (place % NIBBLE))
	}
	return Arr.join(
		Arr.map(Arr.reverse(Arr.fromIterable(nibbles)), (nibble) => nibble.toString(16)),
		""
	)
}

/** The requirements a mask sets, ascending. */
const pendingOfMask = (mask: string): ReadonlyArray<number> =>
	Arr.flatMap(Arr.reverse(Str.split(mask, "")), (digit, at) => {
		const nibble = Number.parseInt(digit, 16)
		return Arr.filter(
			Arr.makeBy(NIBBLE, (bit) => at * NIBBLE + bit),
			(place) => (nibble & (1 << (place % NIBBLE))) !== 0
		)
	})

const steeringOf = (drawn: Drawn): string => {
	switch (drawn.kind) {
		case "unsteered":
			return UNSTEERED
		case "steered":
			return maskOf(drawn.pending)
	}
}

const drawnOf = (steering: string): Drawn =>
	steering === UNSTEERED
		? { kind: "unsteered" }
		: { kind: "steered", pending: pendingOfMask(steering) }

/**
 * A case's replay token, as `TEST_REPLAY` takes it: `<suite>:<steering>:<tape>`. The steering is `-` for an unsteered
 * case, and otherwise a hexadecimal mask whose bit `i` is set when the suite's requirement `i` was still pending ("0"
 * when none was); the tape is its values in base 36, joined by dots.
 */
export const replayTokenOf = (suite: string, replayed: ReplayCase): string =>
	`${suite}:${steeringOf(replayed.drawn)}:${tokenOf(Float64Array.from(replayed.values), replayed.values.length)}`

/** The replay a token names. A suite's label may hold colons; the token's last two fields never do. */
export const replayOf = (token: string): Effect.Effect<Replay, ReplayTokenUnreadable> => {
	const unreadable = ReplayTokenUnreadable.make({
		token,
		message: `TEST_REPLAY='${token}' is no replay token: a token is <suite>:<steering>:<tape>, as a failure prints it`
	})
	const tapeAt = Str.lastIndexOf(":")(token)
	const steeringAt = Option.flatMap(tapeAt, (at) => Str.lastIndexOf(":")(Str.slice(0, at)(token)))
	return Option.match(Option.all([steeringAt, tapeAt]), {
		onNone: () => Effect.fail(unreadable),
		onSome: ([steeringStart, tapeStart]) => {
			const suite = Str.slice(0, steeringStart)(token)
			const steering = Str.slice(steeringStart + 1, tapeStart)(token)
			const tape = Str.slice(tapeStart + 1)(token)
			return Str.isNonEmpty(suite) && STEERING.test(steering) && VALUES.test(tape)
				? Effect.succeed({
						suite,
						replayed: {
							drawn: drawnOf(steering),
							values: Arr.fromIterable(valuesFromToken(tape))
						}
					})
				: Effect.fail(unreadable)
		}
	})
}
