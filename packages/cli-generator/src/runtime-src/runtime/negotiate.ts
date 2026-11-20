import { regex } from "arkregex"
import { Array as Arr, Effect, Option, Record as Rec, String as Str } from "effect"
import { Flag } from "effect/cli"
import { UsageError } from "#domain/errors.ts"
import { isJsonFamily, mediaEssence as essence } from "#runtime/sequential.ts"

/**
 * An operation's declared media: request keys, and response keys per response key, in document
 * order. `refused` lists, per request key, the body properties refused at `field` scope (design
 * 8.5); absent, none is. It is the one list the form serializer's `--body` guard reads.
 */
export interface MediaDeclaration {
	readonly refused?: { readonly [requestKey: string]: readonly string[] }
	readonly request: readonly string[]
	readonly responses: { readonly [responseKey: string]: readonly string[] }
}

/**
 * The declared request key, and the type sent in `Content-Type` (the operator's concrete type for a
 * range key).
 */
export interface RequestMedia {
	readonly contentType: string
	readonly key: string
}

const contentTypeFlagName = "--content-type"

const acceptFlagName = "--accept"

/**
 * A concrete media type, as an RFC 9110 token pair. No `*`, no parameters, nothing a header could
 * not carry. `major` is the type before the `/`.
 */
const concreteType = regex("^(?<major>[!#$%&'+.^_`|~0-9a-z-]+)/[!#$%&'+.^_`|~0-9a-z-]+$", "u")

/**
 * A concrete media type and its major type, read once from a text `concreteType` matches.
 */
interface Concrete {
	readonly major: string
	readonly type: string
}

const concreteOf = (text: string): Option.Option<Concrete> =>
	Option.map(Option.fromNullOr(concreteType.exec(text)), (match) => ({
		major: match.groups.major,
		type: text
	}))

/**
 * Plain optional strings: the declared choices are listed in help, and a refused value is never
 * echoed.
 */
export const contentTypeFlag = Flag.String("content-type").pipe(Flag.optional)

export const acceptFlag = Flag.String("accept").pipe(Flag.optional)

const isRange = (key: string): boolean => Str.endsWith("/*")(essence(key))

const rangeMatches = (range: string, concrete: Concrete): boolean =>
	range === "*/*" || range === `${concrete.major}/*`

/**
 * The declared key a concrete type falls under: exact, then `type/*`, then `*` over `*`.
 */
const matchDeclared = (declared: readonly string[], concrete: Concrete): Option.Option<string> =>
	Arr.findFirst(declared, (key) => essence(key) === concrete.type).pipe(
		Option.orElse(() =>
			Arr.findFirst(
				declared,
				(key) => essence(key) !== "*/*" && isRange(key) && rangeMatches(essence(key), concrete)
			)
		),
		Option.orElse(() => Arr.findFirst(declared, (key) => essence(key) === "*/*"))
	)

const refuse = (flag: string, reason: string) =>
	Effect.fail(UsageError.make({ flag, message: `${flag} ${reason}` }))

const named = (value: string): string => Str.toLowerCase(Str.trim(value))

/**
 * `--content-type` chooses among the declared request keys; the default is the first JSON-family
 * key, else the first key. A range key needs a concrete `--content-type` inside it. A refused value
 * is never echoed.
 */
export const selectRequestMedia = (
	media: MediaDeclaration,
	chosen: Option.Option<string>
): Effect.Effect<RequestMedia, UsageError> =>
	Option.match(Arr.head(media.request), {
		onNone: () =>
			refuse(contentTypeFlagName, "does not apply: the operation declares no request media"),
		onSome: (first) =>
			Option.match(chosen, {
				onNone: () => {
					const key =
						media.request.length === 1
							? first
							: Option.getOrElse(Arr.findFirst(media.request, isJsonFamily), () => first)

					return isRange(key)
						? refuse(contentTypeFlagName, "must name a concrete media type for this operation")
						: Effect.succeed({ contentType: key, key })
				},
				onSome: (value) =>
					Option.match(
						Option.flatMap(concreteOf(named(value)), (concrete) =>
							Option.map(matchDeclared(media.request, concrete), (key) => ({
								contentType: isRange(key) ? concrete.type : key,
								key
							}))
						),
						{
							onNone: () =>
								refuse(contentTypeFlagName, "names a media type this operation does not declare"),
							onSome: Effect.succeed
						}
					)
			})
	})

/**
 * The `Accept` value: the declared response media in document order, once each, narrowed to the
 * JSON family where JSON and other alternatives coexist, or the one `--accept` names. `None` when
 * no response declares content.
 */
export const accept = (
	media: MediaDeclaration,
	chosen: Option.Option<string>
): Effect.Effect<Option.Option<string>, UsageError> => {
	const declared = Arr.dedupe(Arr.flatten(Rec.values(media.responses)))

	return Option.match(chosen, {
		onNone: () => {
			const json = Arr.filter(declared, isJsonFamily)
			const listed = json.length > 0 && json.length < declared.length ? json : declared

			return Effect.succeed(
				Arr.isReadonlyArrayNonEmpty(listed) ? Option.some(Arr.join(listed, ", ")) : Option.none()
			)
		},
		onSome: (value) =>
			Option.match(
				Option.filter(concreteOf(named(value)), (concrete) =>
					Option.isSome(matchDeclared(declared, concrete))
				),
				{
					onNone: () =>
						refuse(acceptFlagName, "names a media type this operation does not declare"),
					onSome: (concrete) => Effect.succeedSome(concrete.type)
				}
			)
	})
}

/**
 * The most specific declared response key for a response `Content-Type`, or `undefined` when none
 * is declared or the response carries none (the body is then output as raw bytes).
 */
export const dispatchResponse = (
	declared: readonly string[],
	actual: string | undefined
): string | undefined =>
	Option.getOrUndefined(
		Option.flatMap(
			Option.flatMap(Option.map(Option.fromUndefinedOr(actual), essence), concreteOf),
			(concrete) => matchDeclared(declared, concrete)
		)
	)
