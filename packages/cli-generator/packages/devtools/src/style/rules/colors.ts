import { Array as Arr, Option } from "effect"
import { perClass } from "#style/rules/per-class.ts"
import type { Candidate, ExplainedClass } from "#style/types.ts"
import { COLOR_UTILITIES } from "#style/utilities.ts"

type ColorValue = NonNullable<Extract<Candidate, { kind: "functional" }>["value"]>

/** The value of a color utility; only the color roots are read, so `font-black` is a weight, not a color. */
const colorValueOf = ({ candidate }: ExplainedClass): Option.Option<ColorValue> => {
	if (candidate.kind !== "functional" || !Arr.contains(COLOR_UTILITIES, candidate.root)) {
		return Option.none()
	}
	return Option.fromNullOr(candidate.value)
}

/** Color utilities name the theme's tokens: bg-blue-500 and text-gray-700 (Tailwind's palette) are refused;
 * bg-primary and text-muted-foreground are tokens. */
export const noInvalidColor = perClass((explained, theme) =>
	Option.flatMap(colorValueOf(explained), (value) =>
		value.kind === "named" && theme.colors.has(value.value) && !theme.colorTokens.has(value.value)
			? Option.some({
					message: `Color "${value.value}" is Tailwind's palette, not a design token.`,
					suggestion: "Use a theme color token, such as primary or muted-foreground."
				})
			: Option.none()
	)
)
