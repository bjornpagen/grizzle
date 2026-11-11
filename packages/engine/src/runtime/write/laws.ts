import type { LawId } from "#compiler/core/ids.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { ConstraintLaw, ConstraintLawOf, DomainUse } from "#compiler/laws/model/model.ts"

/** The laws of the columns `uses` a domain types, each once, in use order. */
export const usesLaws = (
	uses: NonEmptyReadonlyArray<DomainUse>
): NonEmptyReadonlyArray<ConstraintLawOf> => {
	const [first, ...rest] = uses
	const seen = new Set<LawId>([first.law.law])
	const laws: [ConstraintLawOf, ...Array<ConstraintLawOf>] = [first.law]
	for (const { law } of rest) {
		if (!seen.has(law.law)) {
			seen.add(law.law)
			laws.push(law)
		}
	}
	return laws
}

/**
 * Every law a violation of `c` can report, with its description: a domain's that types stored columns its uses' laws
 * (usesLaws), and any other's its own.
 */
export const constraintLawsOf = (c: ConstraintLaw): NonEmptyReadonlyArray<ConstraintLawOf> =>
	c.kind === "domainConstraint" ? usesLaws(c.uses) : c.laws
