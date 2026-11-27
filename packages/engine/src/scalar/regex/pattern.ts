import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { admitSpelling, type PatternValue } from "#compiler/ir/pattern.ts"
import { formSource, type LexicalTarget } from "#compiler/scalar/lexical.ts"
import type { MatchAdmission } from "#compiler/scalar/regex/admit.ts"

/**
 * A Text.matches pattern: its source, in grizzle's pattern grammar under the flags "u", admitted where the pattern
 * was made, inside PostgreSQL's regex compile space and matched by some text (admit.ts admitMatch), and its pattern
 * value, its language's key beside that source, which a description holds as the match's literal. Its doors are its
 * admission (Pattern.admitted, which Text.pattern opens) and grizzle's own lexical forms (Pattern.ofForm), so a
 * Text.matches over a Pattern reads its value and admits nothing again.
 */
export class Pattern<S extends string = string> {
	readonly source: S
	readonly value: PatternValue

	private constructor(source: S, value: PatternValue) {
		this.source = source
		this.value = value
	}

	/** Whether `value` is a Pattern: one of its doors made it. */
	static is(value: unknown): value is Pattern {
		return value instanceof Pattern
	}

	/** The pattern its admission admitted. */
	static admitted<S extends string>(
		admission: Extract<MatchAdmission<S>, { readonly kind: "admitted" }>
	): Pattern<S> {
		return Object.freeze(new Pattern(admission.source, admission.value))
	}

	/**
	 * The pattern of a lexical form (scalar/lexical.ts formSource), grizzle's own, which the lexical forms' admission
	 * suite holds to the admission, so a refusal here is a defect: its pattern value is its source's (admitSpelling).
	 */
	static ofForm(target: LexicalTarget): Pattern {
		const source = formSource(target)
		const value = admitSpelling(source)
		if (!value.ok) {
			defect(`a lexical form's pattern its admission admits: /${source}/u`)
		}
		return Object.freeze(new Pattern(source, value.value))
	}
}
