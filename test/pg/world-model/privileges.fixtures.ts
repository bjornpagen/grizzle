/** What the property of privileges.test.ts reads: its installations and what its tampered migrate must reach. */
import { type Situations } from "@bjornpagen/testing/features"
import { constant, element, type Gen, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { educationInstall } from "#test/support/fixtures/education/index.ts"
import { generatedDocsInstalls } from "#test/support/worlds/drive/suite.ts"
import { knownNonEmpty } from "#test/support/worlds/generate/domain.ts"
import { perturbationKinds } from "#test/support/worlds/invalid/catalog.ts"
import {
	docsEditorInstall,
	docsInstall,
	docsOneShareInstall
} from "#test/support/worlds/model/bases/docs.ts"
import type { InstallSpec, WorldFeature } from "#test/support/worlds/model/types.ts"

/**
 * An installation of the documents base's worlds, drawn, or its README-shaped one (whose roles hold whole entries beside
 * claim-filled writable ones, deferred laws a writer meets at COMMIT) over the base or its
 * one-share variant (whose one share per document is a key on Share's `doc`, met at its statement), that variant
 * with an editor beside (whose every fact outside an entry it writes it sees through a relation it holds whole, or not
 * at all), or the education fixture's.
 */
export const installs: Gen<InstallSpec> = oneOf([
	generatedDocsInstalls,
	element([docsInstall, docsOneShareInstall, docsEditorInstall]),
	constant(educationInstall)
])

/**
 * What the tampered-migrate suite must reach: a complete migrate over each perturbation kind of the catalog
 * (invalid/catalog.ts perturbationKinds), whose outcome the model predicts as the drift check that ends the run judges
 * what the folder left of it.
 */
export const tamperMigratedRequired: Situations<WorldFeature> = knownNonEmpty(
	Arr.map(perturbationKinds, (kind): WorldFeature => `migration-over:${kind}`),
	"the perturbation kinds of the catalog"
)
