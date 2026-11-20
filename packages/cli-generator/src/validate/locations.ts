import { Array as Arr, Effect, Option, Order, Record, Schema, String as Str } from "effect"
import { JsonPointer } from "#model/brands.ts"
import { isPointerWithin } from "#model/pointer.ts"

type Pointer = typeof JsonPointer.Type

/**
 * The part of one validator error the diagnostic layer reads.
 */
export interface ErrorUnit {
	readonly absoluteKeywordLocation: string
	readonly instanceLocation: string
	readonly keyword: string
}

/**
 * The errors at one deepest instance location, with the ancestor errors that wrap them.
 */
export interface ErrorGroup {
	readonly context: readonly ErrorUnit[]
	readonly deepest: readonly ErrorUnit[]
	readonly pointer: Pointer
}

/**
 * An `instanceLocation` is not `#` followed by a percent-encoded JSON Pointer.
 */
export class InvalidInstanceLocation extends Schema.TaggedError<
	InvalidInstanceLocation,
	{ readonly brand: unique symbol }
>()("InvalidInstanceLocation", { location: Schema.String }) {}

const decodePointer = Schema.decodeUnknownEffect(JsonPointer)

/**
 * The fragment of an `instanceLocation`: after its `#`, or after the `#*` with which the library
 * marks the location of a property name, as `propertyNames` checks it.
 */
const fragmentOf = (instanceLocation: string): string =>
	Str.slice(Str.startsWith("#*")(instanceLocation) ? 2 : 1)(instanceLocation)

/**
 * Strips the `#` (or the `#*` of a property name) and percent-decodes an error's
 * `instanceLocation` into a JSON Pointer (design 3.2 Error locations). Custom code: the library
 * reports URI fragments, the model compares pointers.
 */
const decodeLocation = (
	instanceLocation: string
): Effect.Effect<Pointer, InvalidInstanceLocation> => {
	const invalid = () => InvalidInstanceLocation.make({ location: instanceLocation })

	return Str.startsWith("#")(instanceLocation)
		? Effect.try({
				catch: invalid,
				try: () => decodeURIComponent(fragmentOf(instanceLocation))
			}).pipe(Effect.flatMap(decodePointer), Effect.mapError(invalid))
		: Effect.fail(invalid())
}

interface Located {
	readonly pointer: Pointer
	readonly unit: ErrorUnit
}

const byPointer = Order.mapInput(Order.String, (located: Located) => located.pointer)

const samePointer = (self: Located, that: Located): boolean => self.pointer === that.pointer

/**
 * The errors under their deepest locations. The first deepest location in pointer order that lies
 * within a context error owns it.
 */
const groupLocated = (located: readonly Located[]): readonly ErrorGroup[] => {
	const deepestItems: ReadonlySet<Located> = new Set(
		Arr.filter(
			located,
			(item) =>
				!Arr.some(
					located,
					(other) => other.pointer !== item.pointer && isPointerWithin(item.pointer, other.pointer)
				)
		)
	)
	const leaves = Arr.sort(Arr.dedupeWith(deepestItems, samePointer), byPointer)
	const unitsAt = Arr.groupBy(located, (item) => item.pointer)
	const ownerOf = (item: Located): Option.Option<Located> =>
		Arr.findFirst(leaves, (other) => isPointerWithin(item.pointer, other.pointer))
	const contextOf = (leaf: Located): readonly ErrorUnit[] =>
		Arr.map(
			Arr.filter(
				located,
				(item) => !deepestItems.has(item) && Option.exists(ownerOf(item), (owner) => owner === leaf)
			),
			(item) => item.unit
		)

	return Arr.map(leaves, (leaf): ErrorGroup => ({
		context: contextOf(leaf),
		deepest: Arr.map(
			Option.getOrElse(Record.get(unitsAt, leaf.pointer), (): readonly Located[] => []),
			(item) => item.unit
		),
		pointer: leaf.pointer
	}))
}

/**
 * Groups errors under their deepest decoded location, in pointer order. An error at a location
 * with a deeper error beneath it is context of the first such deepest location.
 */
export const groupErrors = (
	errors: readonly ErrorUnit[]
): Effect.Effect<readonly ErrorGroup[], InvalidInstanceLocation> =>
	Effect.forEach(errors, (unit) =>
		decodeLocation(unit.instanceLocation).pipe(
			Effect.map((pointer): Located => ({ pointer, unit }))
		)
	).pipe(Effect.map(groupLocated))
