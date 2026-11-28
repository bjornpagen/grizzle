import { Array as Arr, String as Str } from "effect"
import { batchOwned, caseOwned, type Owner, type Program } from "#test/support/types/batch/batch.ts"
import { readmeFixture, type StatedRefusal } from "#test/types/examples/documents.ts"

/**
 * The README's fixture as a batch's program: the fixture whole, so every refusal the README states is checked in the
 * program it stands in. Each directive of the batch's refusals, and the line it claims, are that refusal's own lines;
 * every other line, the other refusals' among them, is the batch's, so every batch judges every claim of the README.
 */
export const readmeProgram = (refusals: Arr.NonEmptyReadonlyArray<StatedRefusal>): Program => {
	const owners = new Map<number, Owner>()
	for (const [at, refusal] of refusals.entries()) {
		owners.set(refusal.line, caseOwned(at))
		owners.set(refusal.line + 1, caseOwned(at))
	}
	return [
		{
			file: "readme.ts",
			parts: Arr.map(Str.split(readmeFixture, "\n"), (text, index) => ({
				owner: owners.get(index + 1) ?? batchOwned,
				lines: [text]
			}))
		}
	]
}
