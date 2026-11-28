/**
 * No served statement is DDL (test/types/served/ddl.ts): over each statement family of SqlStatement through each door
 * that holds a served statement's AST, from its builder to its served file, and a PL/pgSQL statement's data-modifying
 * and INTO statements, a door takes a DML statement and refuses a DDL statement, a transaction's control and a stored
 * table's fill; and no PL/pgSQL statement's kind is a DDL statement's. Each family through each door is a cell of the
 * box, and so are the PL/pgSQL statement's kinds; a batch's cells are one program, checked disarmed. Oracle: the
 * representation's own contract (sql/ast.ts Dml, PlStatement), that a served call and the rule judge send DML alone, so
 * a connection's life after install writes no catalog row.
 */
import { word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { boxAgreement } from "#test/support/types/batch/agreement.ts"
import { servedDdlBox } from "#test/types/served/ddl.dictionary.ts"
import { servedDdlProgram } from "#test/types/served/ddl.ts"

/** Over each statement family through each door of a served statement, a door takes DML alone. */
export const noServedStatementIsDdl = boxAgreement(finite(word(servedDdlBox)), {
	box: "each statement family of SqlStatement (Dml, Ddl, TransactionControl, FillStored) through each door that holds a served statement's AST, and the PL/pgSQL statement's kinds",
	situations: [],
	notes: () => [],
	checking: "disarmed",
	program: servedDdlProgram,
	oracle: {
		kind: "specification",
		name: "sql/ast.ts Dml and PlStatement: a served call and the rule judge send DML alone"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/write/program/artifact.ts",
			original: "\treadonly spec: StatementSpec<WriteParamSlot>\n\treadonly ast: Dml\n",
			replacement:
				'\treadonly spec: StatementSpec<WriteParamSlot>\n\treadonly ast: import("#compiler/sql/ast.ts").SqlStatement\n',
			why: "An artifact's statement holds any statement, as it did, so a DDL statement, a transaction's control and a stored table's fill reach a served file; the program fails, each refusal's directive at that door unused."
		}
	]
})
