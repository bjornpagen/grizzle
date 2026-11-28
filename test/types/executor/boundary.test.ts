/**
 * The executor's boundary (test/types/executor/boundary.ts): over every source a harness has handed baseArtifacts by
 * every door a compiled program passes on its way to a run (a role's, a login's and a bench gate's compiled
 * query's artifacts, and runWrite over runtimeEntry), a probe compiles exactly when an installation stands behind its
 * source, ParamSource `planned` or `recorded`, and is refused for `unserved` written out, the `unserved` constant and a
 * source of any kind; and runWrite takes an entry exactly when a door minted it. Each probe and each entry is a cell of
 * the box; a batch's cells are one program, checked disarmed. Oracle: the box's own source kind, and whether a door
 * minted the entry.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { boundaryBox } from "#test/types/executor/boundary.dictionary.ts"
import { boundaryProgram } from "#test/types/executor/boundary.ts"

/**
 * Over every source by every door to a run, a compiled program reaches the executor exactly when an installation stands
 * behind its source, and runWrite takes exactly a minted entry.
 */
export const boundary = boxAgreement(finite(word(boundaryBox)), {
	box: "every source a harness hands baseArtifacts (planned, recorded, unserved written out, the unserved constant, a source of any kind) by every door to a run, and an entry's parts minted and unminted",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: boundaryProgram,
	oracle: {
		kind: "specification",
		name: "the box's own source kind, and whether a door minted the entry"
	},
	kept: [],
	kills: []
})
