import { formSource, type LexicalTarget } from "#compiler/scalar/lexical.ts"
import type { MatchAdmission } from "#compiler/scalar/regex/admit.ts"

/**
 * A Compute.matches pattern: its source, in grizzle's pattern grammar under the flags "u", admitted where the pattern
 * was made, inside PostgreSQL's regex compile space and matched by some text (admit.ts admitMatch). Its doors are its
 * admission (Pattern.admitted, which Compute.pattern opens) and grizzle's own lexical forms (Pattern.ofForm), so a
 * Compute.matches over a Pattern reads its source and admits nothing again.
 */
export class Pattern<S extends string = string> {
	readonly source: S

	private constructor(source: S) {
		this.source = source
	}

	/** Whether `value` is a Pattern: one of its doors made it. */
	static is(value: unknown): value is Pattern {
		return value instanceof Pattern
	}

	/** The pattern its admission admitted. */
	static admitted<S extends string>(
		admission: Extract<MatchAdmission<S>, { readonly kind: "admitted" }>
	): Pattern<S> {
		return Object.freeze(new Pattern(admission.source))
	}

	/**
	 * The pattern of a lexical form (scalar/lexical.ts formSource), grizzle's own, which the lexical forms' admission
	 * suite holds to the admission, so none is admitted when it is made.
	 */
	static ofForm(target: LexicalTarget): Pattern {
		return Object.freeze(new Pattern(formSource(target)))
	}
}
