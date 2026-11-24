/**
 * The DbConfig agreement (test/support/agreement/dbconfig.ts): over the reader's every setting left out and given a
 * stranger, and every password, verify and driver channel, the types take exactly what DbLayer.make's reader admits,
 * and every type-only contract holds. Each block's keys, omission, stranger, channel case and relabelling is a cell of
 * the box; a batch's cells are one program, checked disarmed. Oracle: the reader itself (connection/config.ts,
 * pool/served.ts), over the settings its own rosters name.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { configProgram } from "#test/support/agreement/dbconfig.ts"
import { configBox } from "#test/types/api/config.dictionary.ts"
import { boxAgreement } from "#test/types/batch/agreement.ts"

/**
 * Over the reader's every setting left out and given a stranger, and every password, verify and driver channel, the
 * types take exactly what DbLayer.make's reader admits and every type-only contract holds.
 */
export const config = boxAgreement(finite(word(configBox)), {
	box: "each block's keys, every setting of the reader's rosters left out and a stranger in each block, for a login whose role reads no context and one whose role reads Session; every password, verify and driver by login; and every config by the login it names",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: configProgram,
	oracle: {
		kind: "second-implementation",
		name: "DbLayer.make's reader (connection/config.ts, pool/served.ts) over its own rosters"
	},
	kept: [],
	kills: [
		{
			file: "packages/grizzle/src/adapter/connection/config.ts",
			original: 'export const poolSettings = ["max"] as const',
			replacement: 'export const poolSettings = ["max", "maxUses"] as const',
			why: "The reader's pool roster (connection/config.ts poolSettings) gains a setting the type does not state; the agreement's program fails."
		}
	]
})
