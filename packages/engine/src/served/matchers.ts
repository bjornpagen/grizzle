import type { ParamDecl } from "#compiler/ir/products.ts"
import type { PatternSource } from "#compiler/ir/scalar.ts"
import type { ServedMatcher } from "#compiler/scalar/regex/matcher.ts"
import { ProgramPatterns, typePatterns } from "#compiler/scalar/regex/patterns.ts"
import type { ServedMember, ServedRoleForm, ServedVariants } from "#compiler/served/forms.ts"

/** The patterns a declared parameter's values are judged by: its type's, or each of its heading's column types'. */
const paramPatterns = (decl: ParamDecl): ReadonlyArray<PatternSource> =>
	decl.kind === "scalar"
		? typePatterns(decl.type)
		: decl.heading.flatMap((c) => typePatterns(c.type))

/**
 * The patterns a ChangeSet's variants read: each write's declared parameters', which its codecs and its read-backs'
 * judge, and the patterns its binding's evaluator and its witness's judge read (runtime/write/fill.ts Evaluation).
 */
const variantPatterns = (variants: ServedVariants): ReadonlyArray<PatternSource> => {
	switch (variants.kind) {
		case "change": {
			const { params, binding } = variants.change.program
			return [
				...params.flatMap(paramPatterns),
				...binding.evaluation.patterns,
				...binding.witness.evaluation.patterns
			]
		}
		case "split":
			return [...variantPatterns(variants.holding), ...variantPatterns(variants.lacking)]
	}
}

/** The patterns a member's calls read: a read's, a key's and a page's parameters', and a ChangeSet's variants'. */
const memberPatterns = (member: ServedMember): ReadonlyArray<PatternSource> => {
	switch (member.kind) {
		case "read":
		case "key":
		case "paged":
			return member.read.params.flatMap(paramPatterns)
		case "change":
			return variantPatterns(member.variants)
		case "refresh":
			return []
	}
}

/**
 * Every pattern a served login's roles read, each with its automaton, parsed once here, at generate (served/forms.ts
 * ServedFile matchers): what its layer judges every refined value by, so a load parses none.
 */
export const servedMatchers = (
	roles: ReadonlyArray<ServedRoleForm>
): ReadonlyArray<ServedMatcher> =>
	ProgramPatterns.of(roles.flatMap((role) => role.members.flatMap(memberPatterns))).served()
