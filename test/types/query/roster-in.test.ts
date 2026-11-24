/**
 * A membership test over a roster term narrows the term's found type to the handles it lists, as the WHERE holds them
 * (test/types/query/roster-in.ts): r.in or Logic.in in a rule's WHERE, alone, in a conjunction or twice, restricts the
 * variable and every variable equated with it (types/evidence/evidence.ts MembershipStates, FoundOf), so a read that
 * keeps rows out by it finds no handle it excluded, and its consumer needs no check of its own (metis's delivery reads
 * kept a host re-check of the status their WHERE already holds); a disjunction states nothing, and a text term keeps its
 * type. Each filter is a cell of the box; a batch's cells are one program, checked disarmed. Oracle: the specification,
 * the WHERE's own restriction.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/types/batch/agreement.ts"
import { rosterInBox } from "#test/types/query/roster-in.dictionary.ts"
import { rosterInProgram } from "#test/types/query/roster-in.ts"

/** A roster term a membership test restricts is found as the handles the test lists, by the WHERE's own rule. */
export const rosterIn = boxAgreement(finite(word(rosterInBox)), {
	box: "a rule over a roster status, its mirror and a text label, its WHERE a membership test alone, by Logic.in, in a conjunction, in a disjunction, twice, as one of two predicates either of which runs, with an equated variable found, or over the text term",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: rosterInProgram,
	oracle: { kind: "specification", name: "the WHERE's own restriction of the roster term" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/types/evidence/evidence.ts",
			original: "export type FoundOf<H, Stated> = [RestrictedKeys<Stated>] extends [never]\n",
			replacement: "export type FoundOf<H, Stated> = [never] extends [never]\n",
			why: "find types its records by the head's terms alone, the whole roster wherever a membership test restricts it: metis's six delivery reads keep a host re-check (listedOf) of the status their WHERE holds, and the program fails."
		},
		{
			file: "packages/engine/src/types/evidence/evidence.ts",
			original: "type MustState<X> = MustFix<X> | MustEqual<X> | MustRestrict<X>\n",
			replacement: "type MustState<X> = MustFix<X> | MustEqual<X>\n",
			why: "where collects no membership test's restriction, which StatesOf reads through MustState: every found status is the whole roster."
		},
		{
			file: "packages/engine/src/types/evidence/evidence.ts",
			original:
				"\t\t: Extract<V, RestrictedTo<St, Closure<EqualitiesOf<St>, OriginKey<X> & string>>>\n",
			replacement: "\t\t: Extract<V, RestrictedTo<St, OriginKey<X> & string>>\n",
			why: "A variable equated with the restricted one is found as the whole roster, though the WHERE holds it to the same handles."
		}
	]
})
