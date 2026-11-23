import type { Equivalent, Family } from "@bjornpagen/testing/mutants"
import { setSemantics, sqlWorld } from "#test/support/mutation/families.ts"

/**
 * What grizzle's mutation runs add to the library's operators (test.config.ts's `mutation`, which only
 * `toolchain-test mutate` loads): its two operator families (families.ts) and the mutants judged equivalent.
 */
export const families: ReadonlyArray<Family<string>> = [setSemantics, sqlWorld]

/**
 * The mutants judged equivalent, each by its file and id with the argument that no property can kill it: mutate gives
 * each no trial and leaves it out of its score and its survivors, and refuses to run while one names a mutant its file
 * no longer has. Carried from the old mutation tester's triage (test/support/mutation/triage.json at bf4f43bb), each
 * found among its file's current mutants.
 */
export const equivalent: ReadonlyArray<Equivalent> = [
	{
		file: "packages/engine/src/lower/shapes/page/compile.ts",
		mutant: "91fa50a4d2",
		why: "A heterogeneous union has a key only when every two of its arms, those of one heading group included, fix different literals on a key column (logical/props.ts unionProps), and the page compiler refuses a heterogeneous union without one (logical/order.ts). So the arms of a paged heading group are pairwise disjoint, and UNION ALL over them delivers what UNION does; a group of overlapping arms is refused before this code runs."
	},
	{
		file: "packages/engine/src/deploy/render/naming.ts",
		mutant: "a83e00d3e8",
		why: "derivedMigrationName (deploy/render/naming.ts) never reads one change twice: a theory field's column and a manifest column object (a stored tag's) are never the same column, and no identity is added, dropped, changed or retired at once, so leaving out the deduplication, or keying it by identity alone, names the same changes."
	},
	{
		file: "packages/engine/src/sql/print.ts",
		mutant: "7a9f7b7e9a",
		why: "A non-associative operator's left operand (sql/print.ts) parenthesized from two levels up instead of one: only more parentheses, which PostgreSQL reads to the same tree."
	},
	{
		file: "packages/engine/src/lower/conservative/expr/ops.ts",
		mutant: "5e3549f616",
		why: "A connective's or construct's operand count (lower/conservative/expr/ops.ts): the validated DAG gives AND, OR, LEAST and GREATEST at least one operand, NOT one and BETWEEN three, so the count tests never decide."
	},
	{
		file: "packages/engine/src/lower/conservative/expr/ops.ts",
		mutant: "b67d63b869",
		why: "A connective's or construct's operand count (lower/conservative/expr/ops.ts): the validated DAG gives AND, OR, LEAST and GREATEST at least one operand, NOT one and BETWEEN three, so the count tests never decide."
	},
	{
		file: "packages/engine/src/check/recursion/termination.ts",
		mutant: "4ffa9d0ab9",
		why: "isPureState without its data test (check/recursion/termination.ts): counter() runs only for a term that reads state, and a counter term's operands are the state variable and a literal, so a state variable a data match also binds makes the term read nothing and form() returns data before counter() looks."
	},
	{
		file: "packages/engine/src/check/checker.ts",
		mutant: "530436806e",
		why: "A refusal's wording (check/checker.ts MissingDiscriminant): which of two phrases explains the missing discriminant; the reason and location are unchanged."
	},
	{
		file: "packages/engine/src/check/checker.ts",
		mutant: "a47f32a29b",
		why: "Order completion without its fixed test (check/checker.ts complete): a column the attachment's correlation fixes holds one value across each parent's child rows, so appending it as a key changes no order."
	},
	{
		file: "packages/engine/src/logical/annotate.ts",
		mutant: "1e2658132a",
		why: "sameKeySets always false (logical/annotate.ts) restates a Base over a view whose stamped keys already equal the view's: the rebuilt node carries the same primary key, keys and claims, a new node of identical content, so no reading of the DAG changes."
	},
	{
		file: "packages/engine/src/analysis/theory/fill.ts",
		mutant: "85b33b5379",
		why: "pairLaw (analysis/theory/fill.ts) is read only for a fold plane's pair on the predecessor axis, whose from is the plane's before: a law column only that plane carries, or an accumulated field, which Namings.refuseMisnamed (theory/families.ts) refuses when a second statement fills it, so no other pair of the axis has that from and the from alone picks the pair."
	},
	{
		file: "packages/engine/src/logical/props.ts",
		mutant: "732fc7ff89",
		why: "Without the shortcut (logical/props.ts regionProps givenBy), a determinant's column the source fixes is given by its hidden attribute or a bound member of its class; determinantsOf lists the empty determinant first, whose dependency from the region's lateral reads alone reaches every column the source fixes, so the longer from is reached exactly when the shorter is and every closure is unchanged."
	},
	{
		file: "packages/engine/src/check/checker.ts",
		mutant: "565bf34df6",
		why: "Without the reserved test (check/checker.ts services), a search source reading a label the checker reserved is refused UnsupportedOperation at the same stage all the same: a read of the enclosing rule's region is an outer read, which outerRefusal (check/approximate) refuses, and no description puts a recursion's self source inside a search, which the decoder refuses outside a recursive step; only the wording differs."
	},
	{
		file: "packages/engine/src/lower/shapes/take/index.ts",
		mutant: "b6fe869595",
		why: "keyedOn's empty column set (lower/shapes/take) is keyed exactly when the empty key holds, where the physical analysis already bounds the source's maxCard by one (analysis/physical/rules.ts finish), so the bound differs only between at most zero and at most one rows; the take's shape reads it only against lateralMax and as a factor floored at one, so no shape changes."
	},
	{
		file: "packages/engine/src/lower/conservative/vector/index.ts",
		mutant: "30579e9f42",
		why: "The conservative nearest search (lower/conservative/vector) orders by its score first; listing the score again among the tie columns after it orders nothing the first key did not."
	},
	{
		file: "packages/engine/src/laws/model/plan.ts",
		mutant: "cad8b65485",
		why: "The hash index candidates of a reverse index (laws/model/plan.ts): a planned column is a field or a law column, so taking every column after the fields instead of the law columns alone lists the fields again, none of them hashable once the first pass found none, and then the law columns in their order: find returns the same column."
	},
	{
		file: "packages/engine/src/check/checker.ts",
		mutant: "4e74938438",
		why: "The rostered discriminant of a heterogeneous union (check/checker.ts) tried with no closed-id column: clashes over no column holds, since every arm's tuple over no column is the empty tuple and a heterogeneous union has two groups of at least one arm each, so the discriminant falls back to the literal columns as when the empty list is skipped."
	},
	{
		file: "packages/engine/src/write/put/choose.ts",
		mutant: "99ae2e726d",
		why: "uniqueBesideKey's test that an object compares every primary-key field (write/put/choose.ts) never decides: an installed unique object besides the arbiter that reads only primary-key fields and compares every one of them would hold apart only facts of one primary key, and none is installed (a key over a selected side of the whole primary key installs no object of its own: test/unit/write/put/choose.test.ts sees its MERGE either way), while one reading a field outside the key made the put the pair (candidateKey) first."
	},
	{
		file: "packages/engine/src/laws/model/plan.ts",
		mutant: "a9a1ea325c",
		why: "An axis pair repeating a base pair (laws/model/plan.ts carried pairs) at the target base's first column: no axis carries one, since a riding containment's carried pairs are those after the axis key (theory/families.ts ridesOf) and a fold's and a tree's pairs are their own columns, so the skip never fires at any index, and a pair whose target is a base column with another source is refused either way."
	},
	{
		file: "packages/engine/src/check/checker.ts",
		mutant: "6752760fe9",
		why: "#lateNegations (check/checker.ts) without its early return for a rule with no negation returns no late negation instead of none: the early path then negates nothing and the late loop runs over nothing, so the head stands as built either way, and the slots it reads on the way are pure lookups."
	},
	{
		file: "packages/engine/src/write/schedule/plan.ts",
		mutant: "2c91f7ce7f",
		why: "directReads (write/schedule/plan.ts) with nothing carried walks the member's inputs (inputsOf, edgesOf deduplicated) and collects every Base relation, which is meta.reads, a Base's relation and its inputs' (ir/dag.ts relNode); its one reader asks only whether a written relation is among them."
	},
	{
		file: "packages/engine/src/deploy/diff/diff.ts",
		mutant: "1d7c7ab1ac",
		why: "The ledger's privileges (deploy/diff/diff.ts, ledger.ts ledgerPrivilegesObject) are one grant of SELECT on the ledger to every login's role: revoking it from every role the source granted and granting the target's to its roles leaves the roles the target names holding it and no other, as revoking it only from the roles the target drops does, inside the migration file's one transaction."
	},
	{
		file: "packages/engine/src/deploy/render/naming.ts",
		mutant: "0794b56874",
		why: "A readable identity's label (deploy/render/naming.ts label) keeping the dot after its schema: the label feeds only changeMigrationName, whose words fold every run of other characters into one underscore, so the dot joins the one after the verb and the name is unchanged."
	},
	{
		file: "packages/engine/src/deploy/ledger/ledger.ts",
		mutant: "050a0b7d40",
		why: "The ledger rows statement's output names (deploy/ledger/ledger.ts, c0 to c6 instead of c1 to c7): the migrate runner reads its rows by position (adapter/migrate/ledger.ts ledgerRowOf), so no reader names them."
	},
	{
		file: "packages/engine/src/scalar/compute/registry.ts",
		mutant: "d8d27e5028",
		why: "admitsArity admitting no operand to a variadic native (scalar/compute/registry.ts) never decides: a variadic native enters an expression only through overloadOf, whose admits refuses an empty operand list, and every rewrite keeps an expression's arity (ir/expr.ts), so the lowering's arity tests never meet zero operands."
	},
	{
		file: "packages/engine/src/deploy/diff/diff.ts",
		mutant: "fdd1aba3ad",
		why: "The owned clause of a set-aside relation's marker (deploy/diff/diff.ts ownedAside) when it owns nothing: every table grizzle installs has a primary key, which its own index carries, and every stored derived relation's table a unique index, its inherited key, so a table or a stored table set aside always owns a key or an index (diff/aside.ts ownedBy) and the clause is always due."
	},
	{
		file: "packages/engine/src/scalar/aggregate.ts",
		mutant: "b98fe11d6e",
		why: "A refusal's wording (scalar/aggregate.ts unaryOverload): under the mutant the AVG(money) branch tests a sum over money, which sumOverloads defines, so it never fires, and a mean over money is refused by the next branch, UnsupportedOperation at the same location, saying money has no native AVG instead of naming the numeric cast that expresses one."
	},
	{
		file: "packages/engine/src/scalar/aggregate.ts",
		mutant: "a72c0e66a3",
		why: "A refusal's wording (scalar/aggregate.ts unaryOverload): without the AVG(money) branch, a mean over money, which avgOverloads lacks, is refused by the next branch, UnsupportedOperation at the same location, saying money has no native AVG instead of naming the numeric cast that expresses one."
	},
	{
		file: "packages/engine/src/scalar/aggregate.ts",
		mutant: "b88fdf8aca",
		why: "A refusal's wording (scalar/aggregate.ts unaryOverload): under the mutant the AVG(money) branch asks for an overload of a mean over money, which avgOverloads lacks, so it never fires, and a mean over money is refused by the next branch, UnsupportedOperation at the same location, saying money has no native AVG instead of naming the numeric cast that expresses one."
	},
	{
		file: "packages/engine/src/scalar/aggregate.ts",
		mutant: "963b4b9374",
		why: "A refusal's wording (scalar/aggregate.ts unaryOverload): under the mutant a mean over any type avgOverloads lacks takes the AVG(money) branch, and every one is refused there as by the next branch, UnsupportedOperation at the same location; only the phrase differs, naming money's numeric cast for a type that is not money."
	},
	{
		file: "packages/engine/src/deploy/admission/roles.ts",
		mutant: "188714fde7",
		why: "The tables whose row security an installation enables, which the drift check meets with a role's filtered tables (deploy/admission/roles.ts roleExpectation secured): an installation creates a policy only beside its table's ENABLE ROW LEVEL SECURITY (physical/ddl/roles.ts addRowSecurity), so every filtered table is among the tables whose row security is enabled, which are among the tables altered at all; met with the filtered tables, either set gives the filtered tables."
	},
	{
		file: "packages/engine/src/deploy/admission/roles.ts",
		mutant: "d6ba282dbd",
		why: "Whether a default privilege's revoke names one of PostgreSQL's own defaults' grantees (deploy/admission/roles.ts sameGrantee): its second grantee is always a built-in default's, PUBLIC, so a revoke naming a role answers false whether or not the role's name is compared."
	},
	{
		file: "packages/engine/src/scalar/aggregate.ts",
		mutant: "e54edf063b",
		why: "The AVG(money) refusal's test (scalar/aggregate.ts unaryOverload) without its name: sumOverloads defines a sum over money, so an aggregate over money with no overload is a mean, and the branch fires for exactly the calls it did."
	},
	{
		file: "packages/engine/src/deploy/admission/roles.ts",
		mutant: "8aa321d7c6",
		why: "Which of PostgreSQL's own default privileges an installation's revokes leave (deploy/admission/roles.ts defaultPrivilegesExpectations): every manifest that alters a default privilege is an installation's, whose PUBLIC revokes (physical/ddl/roles.ts publicRevokes) take ALL on functions and on types from PUBLIC everywhere, both of the defaults, so none is left whether or not each revoke is read."
	},
	{
		file: "packages/grizzle/src/adapter/reader/execution.ts",
		mutant: "ea0f9f76fc",
		why: "Whether two delivered rows of one identity hold the same bytes (adapter/reader/execution.ts sameCells): a bytes cell's identity is the SHA-256 digest of its bytes (scalar/values/bytes.ts BytesDigest), so two cells of one identity whose bytes differ are a SHA-256 collision, which no answer PostgreSQL computes holds; the comparison it drops never fails."
	},
	{
		file: "packages/grizzle/src/adapter/admission/roles.ts",
		mutant: "e74c1fb9d3",
		why: "A stored setting's name before its '=' (adapter/admission/roles.ts storedSettings), refused under the mutant at one character: PostgreSQL defines no configuration parameter of one character, and a custom one is two or more names joined by a dot, so pg_db_role_setting holds no such setting for either reading to tell apart."
	},
	{
		file: "packages/engine/src/sql/print.ts",
		mutant: "b2d0b154d4",
		why: "A boolean literal typed by a named type called boolean (sql/print.ts printLiteral), printed bare instead of cast: the one named type a boolean literal takes is a contract's domain over boolean, whose predicate the host checks every literal against when it is built, so the cast adds no check, and PostgreSQL coerces a bare boolean into the domain wherever the literal is stored, compared or delivered, both readings of the same values."
	},
	{
		file: "packages/engine/src/write/insert/input.ts",
		mutant: "0e9db3a302",
		why: "Whether an input nothing proves holds no repeated row (write/insert/input.ts unproved), the proof of a described member read through a carrier or by an entry's outside check: a carrier holds its member's rows as a set after their casts into the relation's types (write/carriers/carriers.ts memberRows, SELECT DISTINCT unless the member's lowering is a set and every cast keeps its value), so a DISTINCT over it removes nothing, and an outside check reads a member only to find whether some row lies outside its entry, which a repeated row cannot change."
	},
	{
		file: "packages/engine/src/lower/shapes/take/decorrelate.ts",
		mutant: "b49e7a3923",
		why: "Decorrelation with no outer constant (lower/shapes/take/decorrelate.ts candidateAt): rewrite then sets the region, every chain link and the take to bodies equal to their own, occurrences in their order with no constant dropped or binding added, headings with nothing appended, the take's correlation with nothing added, so everyParentTakes returns the same DAG rebuilt, its certificates and both artifacts' SQL byte for byte."
	}
]
