import { Array as Arr, Option, String as Str } from "effect"
import { soleVariableOf } from "#style/css.ts"
import { perClass } from "#style/rules/per-class.ts"
import type { ExplainedClass, Theme, Variant } from "#style/types.ts"

/** The variants whose arbitrary values select structure (an attribute, a relation, a position) rather than set a
 * breakpoint or a support query: the second spelling of a design scale is what the rule refuses. */
const STRUCTURAL_VARIANTS: ReadonlyArray<string> = [
	"aria",
	"data",
	"has",
	"not",
	"in",
	"nth",
	"nth-last",
	"nth-of-type",
	"nth-last-of-type"
]

/** A selector or value that reaches for a query or a variable is no structure. */
const isQueryLike = (text: string): boolean => Str.includes("@")(text) || Str.includes("var(")(text)

/** Why a variant is an arbitrary design value, when it is one: a breakpoint or query spelled `[...]`, an arbitrary
 * modifier, or a structural selector that reaches for a query or variable. */
const arbitraryVariantOf = (variant: Variant): Option.Option<string> => {
	switch (variant.kind) {
		case "static":
			return Option.none()
		case "compound":
			return variant.modifier?.kind === "arbitrary"
				? Option.some(`/[${variant.modifier.value}]`)
				: arbitraryVariantOf(variant.variant)
		case "arbitrary":
			return isQueryLike(variant.selector) ? Option.some(`[${variant.selector}]`) : Option.none()
		case "functional": {
			if (variant.modifier?.kind === "arbitrary") {
				return Option.some(`/[${variant.modifier.value}]`)
			}
			if (variant.value?.kind !== "arbitrary") {
				return Option.none()
			}
			const structural =
				Arr.contains(STRUCTURAL_VARIANTS, variant.root) && !isQueryLike(variant.value.value)
			return structural ? Option.none() : Option.some(`${variant.root}-[${variant.value.value}]`)
		}
	}
}

/** What is arbitrary about a class, when anything is: a variant, an arbitrary property, an arbitrary modifier, or
 * an arbitrary value that is not exactly `var(--token)` naming a theme variable that is a design token. */
const arbitraryPartOf = ({ candidate }: ExplainedClass, theme: Theme): Option.Option<string> => {
	if (candidate.kind === "unparsed") {
		return Option.none()
	}
	const variant = Arr.findFirst(candidate.variants, (found) =>
		Option.isSome(arbitraryVariantOf(found))
	)
	if (Option.isSome(variant)) {
		return arbitraryVariantOf(variant.value)
	}
	switch (candidate.kind) {
		case "static":
			return Option.none()
		case "arbitrary":
			return Option.some(`[${candidate.property}:${candidate.value}]`)
		case "functional": {
			if (candidate.modifier?.kind === "arbitrary") {
				return Option.some(candidate.modifier.value)
			}
			const value = candidate.value
			return value?.kind === "arbitrary" &&
				!Option.exists(soleVariableOf(value.value), (variable) => theme.tokens.has(variable))
				? Option.some(value.value)
				: Option.none()
		}
	}
}

/**
 * A class takes its values from the theme. An arbitrary value is refused unless it is exactly `var(--token)` naming
 * a theme variable that is a design token: `rounded-[var(--radius-md)]`, `border-(length:--spacing-hairline)`
 * and `bg-(--color-primary)` pass, `bg-[red]`, `text-[13px]`, `z-[999]`, `shadow-[0_4px_rgba(0,0,0,.1)]` and
 * `bg-[var(--color-blue-500)]` (Tailwind's palette) do not. Arbitrary properties (`[padding:37px]`) and arbitrary
 * modifiers (`bg-primary/[0.5]`) are refused outright, and so are arbitrary breakpoints and queries (`min-[800px]:`,
 * `supports-[display:grid]:`). An arbitrary variant that selects structure (`data-[size=sm]:`, `[&_svg]:`) sets no
 * value, so it passes.
 */
export const noArbitraryValue = perClass((explained, theme) =>
	Option.map(arbitraryPartOf(explained, theme), (part) => ({
		message: `Arbitrary value "${part}" in "${explained.text}" is not a theme token.`,
		suggestion:
			"Use the theme's named utility (p-4, rounded-md, bg-primary), a named variant, or var(--token) naming a theme variable."
	}))
)
