import { refinedConstants } from "#compiler/check/refinement/index.ts"
import * as Result from "#compiler/core/result.ts"
import { noLive } from "#compiler/live/notify.ts"
import { constantValidationObjects } from "#compiler/lower/shapes/refined/index.ts"
import { noTextDomainUses } from "#compiler/physical/ddl/domains.ts"
import {
	type InstallExtension,
	noCarriers,
	noHolds,
	noCertificates,
	noContribution
} from "#compiler/physical/install/extension.ts"

/** The installer extension that adds the closed payloads' validation object to an installation's Publish phase: every
 * closed text payload and contract payload with a nontrivial refinement is cast to its domain there, where the domain
 * holds the target's constraints alone, so an installation whose closed facts violate their refinement fails the
 * transaction that would publish it. The statements are `constantValidationObjects`'; every installation runs this
 * extension. */
export const refinedConstantsExtension: InstallExtension = {
	contribute: (b) =>
		Result.map(constantValidationObjects(b.names, refinedConstants(b.checked)), (objects) => {
			for (const o of objects) {
				b.add(
					{
						kind: o.kind,
						ident: { kind: "text", text: o.ident },
						ddl: o.ddl,
						reasons: o.reasons,
						phase: o.phase
					},
					[]
				)
			}
			return noContribution
		}),
	textDomainUses: noTextDomainUses,
	certifies: noCertificates,
	carriers: noCarriers,
	holds: noHolds,
	live: noLive
}
