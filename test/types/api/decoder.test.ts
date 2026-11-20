/**
 * A served login's decoder type (test/types/api/decoder.ts): over a box of logins, one for each kind of member the
 * decision of a login's live reads reads, ServedLogin<typeof L>["decoder"] is exactly the arm L's real served file
 * holds, NoDecoder for a login that serves no read and DecoderLogin for one that does, which roleNameOf takes with no
 * narrowing, and AnyLogin's is every arm. Each login is a cell of the box, and so is AnyLogin; a batch's cells are one
 * program, checked armed. Oracle: the decoder of each login's served file, compiled as generate compiles it and read
 * off the served value.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { decoderBox } from "#test/types/api/decoder.dictionary.ts"
import { decoderProgram } from "#test/types/api/decoder.ts"
import { boxAgreement } from "#test/types/batch/agreement.ts"

/**
 * A served login's decoder is exactly the arm its login's served file holds, NoDecoder or DecoderLogin, which
 * roleNameOf takes with no narrowing, and every arm for AnyLogin.
 */
export const decoder = boxAgreement(finite(word(decoderBox)), {
	box: "a login for each kind of member a login's live reads decide by (none, a ChangeSet alone, two workloads of ChangeSets, a clocked read alone, a query, a paged query, a key, a deferrable read, a ChangeSet beside a query), and AnyLogin",
	situations: [],
	notes: () => [],
	checking: "armed",
	program: decoderProgram,
	oracle: {
		kind: "second-implementation",
		name: "the decoder each login's served file names, compiled as generate compiles it"
	},
	kept: [],
	kills: [
		{
			file: "packages/grizzle/src/adapter/types/layer.ts",
			original: "\treadonly decoder: DecoderOf<L>",
			replacement: "\treadonly decoder: ServedDecoder",
			why: "Every served login's decoder is typed as the union (ServedDecoder), whatever its login; the program fails."
		},
		{
			file: "packages/grizzle/src/adapter/types/layer.ts",
			original: "\t\t? [Extract<ShapeOf<P[keyof P]>, ReadShape>] extends [never]",
			replacement:
				'\t\t? [Extract<ShapeOf<P[keyof P]>, ReadShape | "instantSet" | "instantList">] extends [never]',
			why: "The decision of a login's live reads (adapter/types/layer.ts WorkloadReads) counts a clocked read as a read, so a login serving a clocked read alone is typed DecoderLogin; the program fails."
		}
	]
})
