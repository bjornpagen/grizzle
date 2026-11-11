import { Array as Arr, Option, Order, String as Str } from "effect"
import { type ClassSaying, perClass } from "#style/rules/per-class.ts"
import type { ExplainedClass, Theme } from "#style/types.ts"

const MAX_LEVENSHTEIN_DISTANCE = 2

/** Tailwind's `group` and `peer` markers compile to no CSS of their own: the group-* and peer-* variants select
 * the element that carries them, by name after a slash when it has one. */
const VARIANT_ANCHORS: ReadonlyArray<string> = ["group", "peer"]

const isMarkerName = (name: string): boolean =>
	Str.isNonEmpty(name) &&
	Arr.every(
		Arr.fromIterable(name),
		(character) =>
			(character >= "a" && character <= "z") ||
			(character >= "A" && character <= "Z") ||
			(character >= "0" && character <= "9") ||
			character === "_" ||
			character === "-"
	)

const isVariantAnchor = (className: string): boolean => {
	const [anchor, name, ...rest] = Str.split("/")(className)
	return (
		Arr.contains(VARIANT_ANCHORS, anchor) &&
		!Arr.isReadonlyArrayNonEmpty(rest) &&
		(name === undefined || isMarkerName(name))
	)
}

/** One row of the edit-distance table: the distances from the first `i` characters of `a`, whose last is
 * `character`, to every prefix of `b`; none when the previous row is too short. */
const nextRow = (
	input: Readonly<{
		previous: ReadonlyArray<number>
		character: string
		b: ReadonlyArray<string>
		i: number
	}>
): Option.Option<ReadonlyArray<number>> => {
	const { previous, character, b, i } = input
	const current = [i]
	for (let j = 1; j <= b.length; j += 1) {
		const cost = Option.contains(Arr.get(b, j - 1), character) ? 0 : 1
		const above = previous[j]
		const left = current[j - 1]
		const diagonal = previous[j - 1]
		if (above === undefined || left === undefined || diagonal === undefined) {
			return Option.none()
		}
		current.push(Math.min(above + 1, left + 1, diagonal + cost))
	}
	return Option.some(current)
}

const levenshtein = (a: string, b: string): number => {
	const left = Arr.fromIterable(a)
	const right = Arr.fromIterable(b)
	const last = Arr.reduce(
		left,
		Option.some<ReadonlyArray<number>>(Arr.makeBy(right.length + 1, (index) => index)),
		(row, character, index) =>
			Option.flatMap(row, (previous) => nextRow({ previous, character, b: right, i: index + 1 }))
	)
	return Option.getOrElse(
		Option.flatMap(last, (row) => Arr.get(row, right.length)),
		() => left.length + right.length
	)
}

const closestOf = (typed: string, tokens: ReadonlyArray<string>): Option.Option<string> =>
	Option.filter(
		Arr.head(Arr.sortWith(tokens, (token) => levenshtein(typed, token), Order.Number)),
		(token) => levenshtein(typed, token) <= MAX_LEVENSHTEIN_DISTANCE
	)

/** "hover:bg-prmary" with root "bg" and the token "primary" becomes "hover:bg-primary". */
const correctedOf = (className: string, root: string, token: string): string => {
	const prefix = Option.match(Str.lastIndexOf(root)(className), {
		onNone: () => "",
		onSome: (index) => Str.slice(0, index)(className)
	})
	return `${prefix}${root}-${token}`
}

/** A hint for a class that does not compile, from the theme: an empty vocabulary means a broken @theme chain, a
 * close token name a typo. A root that takes bare values only has no hint. */
const hintOf = ({ candidate, text }: ExplainedClass, theme: Theme): Option.Option<string> => {
	if (candidate.kind !== "functional" || candidate.value?.kind !== "named") {
		return Option.none()
	}
	const { root } = candidate
	const typed = candidate.value.value
	return Option.flatMap(Option.fromUndefinedOr(theme.vocabularies.get(root)), (vocabulary) => {
		if (!Arr.isReadonlyArrayNonEmpty(vocabulary.tokens)) {
			return Option.some(
				`The design system has no ${Arr.join(vocabulary.namespaces, " or ")} tokens: check the @theme import chain.`
			)
		}
		return Option.map(
			closestOf(typed, vocabulary.tokens),
			(token) => `Did you mean "${correctedOf(text, root, token)}"?`
		)
	})
}

/**
 * Every class compiles to CSS. A class that does not is reported whatever it looks like; the theme's hint, when
 * there is one, is a suggestion, not the reason to report.
 */
export const noUnresolvedClass = perClass((explained, theme) => {
	if (explained.compiled !== undefined || isVariantAnchor(explained.text)) {
		return Option.none()
	}
	const message = `Class "${explained.text}" does not compile.`
	return Option.some(
		Option.match(hintOf(explained, theme), {
			onNone: (): ClassSaying => ({ message }),
			onSome: (suggestion): ClassSaying => ({ message, suggestion })
		})
	)
})
