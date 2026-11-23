import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { IndexRequest } from "#compiler/ir/products.ts"
import { noLive } from "#compiler/live/notify.ts"
import {
	type InstallExtension,
	noCarriers,
	noCertificates,
	noContribution,
	noFences,
	noCalls,
	servesNoParams
} from "#compiler/physical/install/extension.ts"

/** An installer extension that contributes `requests` to the index engine, as the workload extension contributes its
 * programs' access paths. */
export const requesting = (requests: ReadonlyArray<IndexRequest>): InstallExtension => ({
	contribute: () => Result.ok({ ...noContribution, indexRequests: requests }),
	params: servesNoParams,
	certifies: noCertificates,
	carriers: noCarriers,
	calls: noCalls,
	live: noLive,
	fences: noFences
})
