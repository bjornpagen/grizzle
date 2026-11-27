import { maxMigrationNameLength } from "#compiler/plan/usage.ts"

/**
 * The command line's usage, which the bin answers without loading the command line (bin.ts): what `--help` prints and
 * when a command line asks for it, and where its arguments begin in process.argv. It loads no module but the layout of
 * a migration folder's name, whose bound the usage states, so `grizzle --help` loads none of the engine.
 */

/**
 * Where the command line's own arguments begin in process.argv, after Node's executable and the program's entry point
 * (https://nodejs.org/docs/v26.13.0/api/process.html#processargv: "The first element will be process.execPath. [...] If
 * a program entry point was provided, the second element will be the absolute path to it. The remaining elements are
 * additional command-line arguments.").
 *
 * @formatConstant Node's process.argv: its executable, the program's entry point, then the arguments
 */
export const argumentsStart = 2

/** What `--help` prints: the usage of every command and option. */
export const helpText = `Usage:
  grizzle generate <config> [--name <name>] [--schema <schema>] [--rename <old>=<new>]... [--drop <old>]...
                   [--phases]
      draft the next migration from the schemas' changes
  grizzle generate <config> --custom --name <name> [--schema <schema>] [--phases]
      an empty migration for data steps
  grizzle draft-key <config> [generate's options]
      the key of the draft generate makes with these options: the SHA-256 of every input it reads
  grizzle check <config> [--phases]
      generated, resolved and untampered? (offline)
  grizzle migrate <config>
      apply pending migrations, then check the database against the snapshot as drift does
  grizzle drift <config>
      does the database match the snapshot? (applies nothing; migrate ends with this check)
  grizzle names <config>
      each hashed object's PostgreSQL name and what it is
  grizzle roles <config>
      the installation's PostgreSQL roles in the cluster
  grizzle uninstall <config>
      drop the installation's schemas, with every row they hold, and its roles

<config> is the configuration file, whose default export is defineConfig({ ... }): an absolute path, or
one relative to the directory grizzle runs in. migrate, drift, roles and uninstall connect with the
configuration's connection only.

Options of generate and draft-key, as --flag value or --flag=value, anywhere after the command:
  --custom          an empty folder for data steps, named by --name
  --name <name>     the folder's name: lowercase words joined by _ or -, at most ${maxMigrationNameLength} characters;
                    without it a drafted folder is named after its change
  --schema <name>   only this configured schema (its declared name or PostgreSQL schema);
                    accepted only when the configuration declares several schemas, and required
                    there with --custom, --rename or --drop
  --rename <old>=<new>
                    a rename the draft makes, once per name: Relation=Relation,
                    Relation.field=Relation.field, Roster#handle=Roster#handle or @login=@login;
                    a handle keeps its code, and a login its role, with its password and grants
  --drop <old>      a drop the draft makes, once per name: Relation, Relation.field, Roster#handle or
                    @login; every drop of a name the schema no longer holds is declared, by --rename
                    or --drop
  --phases          report each phase on stderr as it starts and ends, a line each:
                    grizzle phase <phase> <start|end> t=<s> cpu=<s> heapUsed=<MB> heapTotal=<MB>
                    rss=<MB> external=<MB>, then grizzle phase done ... peakHeapUsed=<MB>;
                    check takes it too`

/** Whether an argument asks for the usage: `--help` or `-h`. */
const isHelp = (arg: string): boolean => arg === "--help" || arg === "-h"

/**
 * Whether a command line asks for the usage alone: no argument, or `--help` or `-h` anywhere in it, before or after the
 * command, which the bin answers before it loads the command line, and the command line's parse alike (args.ts
 * parseArgs).
 */
export const helpAsked = (argv: ReadonlyArray<string>): boolean => {
	if (argv.length === 0) {
		return true
	}
	for (const arg of argv) {
		if (isHelp(arg)) {
			return true
		}
	}
	return false
}
