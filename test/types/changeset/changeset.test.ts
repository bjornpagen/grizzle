/**
 * The ChangeSet type/engine agreement (test/support/agreement/changesets.ts): every drawn ChangeSet, and its
 * application through a role's Db, typechecks exactly when the engine builds, compiles and binds it; a refusal's
 * Refusal names the engine's reason; and an admitted ChangeSet's parameters, writes, read-backs and level, and its
 * application's channels, are the engine's, each asserted exactly. Each ChangeSet is a block of one program a batch
 * checks disarmed, beside pantry's import and the mapped served calls, the batch's own. Oracle: the engine's
 * construction, compilation and binding of each drawn ChangeSet. The witnesses plant every fault and reach every
 * construct, every verdict and every Refusal of the write path; the kept cases, each a case a run's own stream once drew
 * failing, replay by their tokens before any stream.
 */
import { ReplayToken } from "@bjornpagen/testing/property"
import {
	changeSetAimed,
	changeSetProgram,
	changeSetReached,
	changeSetRefusals,
	changeSetRequired,
	changeSetServed
} from "#test/support/agreement/changesets.ts"
import { agreement } from "#test/types/batch/agreement.ts"

/**
 * Over drawn ChangeSets, the types admit exactly what the engine builds, compiles and binds, name its refusal, and infer
 * its parameters, writes, read-backs and channels.
 */
export const changeSet = agreement(changeSetAimed, {
	situations: [
		"admitted",
		"refused",
		...changeSetRefusals,
		...changeSetServed,
		...changeSetRequired
	],
	notes: changeSetReached,
	checking: "disarmed",
	program: changeSetProgram,
	oracle: {
		kind: "second-implementation",
		name: "the engine's construction, compilation and binding of each drawn ChangeSet"
	},
	kept: [
		{
			token: ReplayToken(
				"test/types/changeset/changeset.test.ts#changeSet:-:0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.3.0.0.0.0.0.0.8.0.0.0.0.0.d.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.3.0.0.0.0.0.0.0.0.0.0.1.1.0.1.2.4.2.0.0.0.0.0.4.0.0.0"
			),
			reason:
				"a put whose query reads a parameter, applied with none, beside a tree's node inserted at one key twice with different rows: bind judged the key before it read the parameters, so the engine answered invariant-rejected where the types refuse the call (TEST_SEED=3)",
			since: "2026-11-16"
		},
		{
			token: ReplayToken(
				"test/types/changeset/changeset.test.ts#changeSet:-:c.0.0.0.0.0.g.0.0.0.g.g.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.f.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.6.2.3.4.1.0.4.0.1.0.0.1.1.0.0"
			),
			reason:
				"a Ledger fact whose money field holds a bare bigint, beside two Budget facts at one key with different cents: normalization judged Budget's key before it admitted Ledger's facts, so the engine answered invariant-rejected where the types refuse the fact (TEST_SEED=34)",
			since: "2026-11-16"
		},
		{
			token: ReplayToken(
				"test/types/changeset/changeset.test.ts#changeSet:-:0.2.0.d.d.8.8.d.0.8.3.3.8.8.3.d.8.8.3.0.8.3.8.0.3.3.8.d.d.8.8.d.3.0.8.8.8.8.8.3.3.3.0.0.0.0.0.3.0.0.0.0.0.0.0.d.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.3.0.0.0.0.0.0.0.0.0.1.1u.0.0.0.0.0.0.1"
			),
			reason:
				"a delete of Order, a family's owner, applied by the clerk, whose write list names Order and not Line: the delete removes Order's lines whole, which the engine refuses as outside the role, as the types do, where the generator read the clerk's write list as one that holds the delete, so a delete of Bin and one of Cart applied by the clerk were expected admitted (TEST_SEED=133331041)",
			since: "2026-11-16"
		}
	],
	kills: [
		{
			file: "packages/engine/src/types/schema/relation.ts",
			original: "type NoClaims = Readonly<Record<string, string>>",
			replacement: "type NoClaims = unknown",
			why: "A fact whose key no literal types claims unknown (types/schema/relation.ts NoClaims), which collapses its array's claims, so a key conflict beside such a fact is admitted, the floor's witness of \"a key conflict beside a fact no literal keys\" refused by the engine; the agreement's program fails."
		},
		{
			file: "packages/engine/src/types/changeset/changeset.ts",
			original:
				'\t\tEditsOnce<Done, EditsWith<Last, S, R>> &\n\t\tPutBesideDoomed<Last["puts"], DoomedBy<S, R>>,',
			replacement: "\t\tEditsOnce<Done, EditsWith<Last, S, R>>,",
			why: "delete drops PutBesideDoomed, so a whole delete after a put in one stratum is admitted; the agreement's program fails."
		},
		{
			file: "packages/engine/src/types/changeset/changeset.ts",
			original: "type DoomedRefusal<Meets> = Meets extends true",
			replacement: "type DoomedRefusal<Meets> = Meets extends never",
			why: "A put beside a whole delete of its row in one stratum is admitted (DoomedRefusal never refuses); the agreement's program fails."
		},
		{
			file: "packages/engine/src/write/frontend/compile.ts",
			original: "\t\tif (edited !== undefined) {",
			replacement: '\t\tif (edited !== undefined && edited.op !== "put") {',
			why: "The engine compiles a put beside a whole delete of its row in one stratum (write/frontend/compile.ts skips its refusal for a put), which the types refuse: the agreement's program fails, and so does the floor's, its three put-beside-a-whole-delete faults admitted."
		},
		{
			file: "packages/engine/src/types/changeset/changeset.ts",
			original: '\t(D1[number] | L1 | D2[number] | L2)["doomed"]\n] extends [never]',
			replacement: '\t(D1[number] | L1 | D2[number] | L2)["doomed"]\n] extends [unknown]',
			why: "A union's UnionDoomed never refuses, so one operand's put of a row the other removes whole in an aligned stratum is admitted; the agreement's program fails."
		},
		{
			file: "packages/engine/src/types/changeset/changeset.ts",
			original: "type DeletedCheck<M, F, R> = MemberFit<M, F, R, false>",
			replacement: "type DeletedCheck<M, F, R> = MemberFit<M, F, R, true>",
			why: "A delete's facts are judged at the primary key, so two facts at one key that differ elsewhere, which a delete admits, are refused; the agreement's program fails."
		},
		{
			file: "packages/engine/src/types/changeset/changeset.ts",
			original:
				"\tIsTreeRow<S, R> extends true ? Pick<Written<R>, TreeRootOf<S, R> & keyof Written<R>> : Written<R>",
			replacement:
				"\tIsTreeRow<S, R> extends true ? Written<R> & Pick<Written<R>, TreeRootOf<S, R> & keyof Written<R>> : Written<R>",
			why: "A tree's delete takes the whole written row (DeletedRow), not its root fields alone, so a tree deleted by its root is refused; the agreement's program fails."
		}
	]
})
