/**
 * The plan.
 *
 * The statements.
 */
const verificationRules = [
	"context",
	"realizationCoverage",
	"pinnedSetForm",
	"unprovedUnionAll",
	"unrealizableDistinct",
	"unprovedMultiplicity",
	"certificate",
	"missingCertificate",
	"statementRoles",
	"statementAudit",
	"statementText",
	"placeholders",
	"paramTypes",
	"paramCodec",
	"resultColumns",
	"dependencies",
	"attachment",
	"merge",
	"artifacts"
] as const
type VerificationRule = (typeof verificationRules)[number]

/**
 * The problems of a lowering the test kernel's verification finds (verify/index.ts checkedLowering).
 *
 * Verification collects every problem it finds rather than stopping at the first, so a failing property names each
 * broken rule. A problem names its rule, where it is (a node, a statement, a placeholder, a certificate) and what is
 * missing, as constant phrases over identifiers and column names.
 */
export interface VerificationProblem {
	readonly rule: VerificationRule
	/** A node, a statement or a certificate, by identifier and position only. */
	readonly where: string
	readonly detail: string
}

export const problem = (
	rule: VerificationRule,
	where: string,
	detail: string
): VerificationProblem => ({
	rule,
	where,
	detail
})

/** A problem as one line of a failing property's message. */
export const problemText = (p: VerificationProblem): string =>
	`${p.rule} at ${p.where}: ${p.detail}`
