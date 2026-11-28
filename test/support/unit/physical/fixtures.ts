import * as Result from "@bjornpagen/grizzle-text/base/result"
import { Array as Arr } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { IndexRequest } from "#compiler/ir/products.ts"
import { noLive } from "#compiler/live/notify.ts"
import {
	type InstallExtension,
	noCarriers,
	noCertificates,
	noContribution,
	noFences,
	noWorldViews,
	noCalls,
	servesNoParams
} from "#compiler/physical/install/extension.ts"

/** An installer extension that contributes `requests` to the index engine, as the workload extension contributes its
 * programs' access paths, each asked by a program of its own, `request <n>` by its place, of the login `test`. */
export const requesting = (requests: ReadonlyArray<IndexRequest>): InstallExtension => ({
	contribute: () =>
		Result.ok({
			...noContribution,
			indexRequests: Arr.map(requests, (request, at) => ({
				request,
				askedBy: [
					{
						kind: "program" as const,
						login: "test",
						program: `request ${at}`,
						at: SourceLoc(`request ${at}`, [])
					}
				] as const
			}))
		}),
	params: servesNoParams,
	certifies: noCertificates,
	carriers: noCarriers,
	calls: noCalls,
	live: noLive,
	fences: noFences,
	worldViews: noWorldViews
})
