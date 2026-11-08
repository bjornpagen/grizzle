#!/bin/sh
# Writes the reproduction project to a fresh temporary directory and runs the given fallow binary's unused class member
# check on it: `sh repro.sh <path to fallow> [--type-aware]`. Only Cell.never is unused.
set -eu
fallow="$1"
shift
dir="$(mktemp -d)"
mkdir "$dir/src"
cat > "$dir/package.json" <<'JSON'
{ "name": "repro", "private": true, "type": "module", "main": "src/main.ts" }
JSON
cat > "$dir/tsconfig.json" <<'JSON'
{
	"compilerOptions": {
		"target": "esnext",
		"module": "nodenext",
		"strict": true,
		"noEmit": true,
		"allowImportingTsExtensions": true
	},
	"include": ["src"]
}
JSON
cat > "$dir/src/cell.ts" <<'TS'
export class Cell {
	viaInstance(): number {
		return 1
	}
	viaAnnotatedParameter(): number {
		return 2
	}
	viaInterfaceProperty(): number {
		return 3
	}
	viaUnionPropertyEveryArm(): number {
		return 4
	}
	viaUnionPropertyNarrowedByIf(): number {
		return 5
	}
	viaUnionPropertyNarrowedBySwitch(): number {
		return 6
	}
	viaMethodReturningUnion(): number {
		return 7
	}
	never(): number {
		return 8
	}
}
TS
cat > "$dir/src/main.ts" <<'TS'
import { Cell } from "./cell.ts"

interface Holder {
	readonly cell: Cell
}

type Both = { readonly kind: "x"; readonly cell: Cell } | { readonly kind: "y"; readonly cell: Cell }

type Bound = { readonly kind: "cell"; readonly cell: Cell } | { readonly kind: "none" }

export const a = new Cell().viaInstance()

export const b = (c: Cell): number => c.viaAnnotatedParameter()

export const c = (h: Holder): number => h.cell.viaInterfaceProperty()

export const d = (v: Both): number => v.cell.viaUnionPropertyEveryArm()

export const e = (v: Bound): number => (v.kind === "cell" ? v.cell.viaUnionPropertyNarrowedByIf() : 0)

export const f = (v: Bound): number => {
	switch (v.kind) {
		case "cell":
			return v.cell.viaUnionPropertyNarrowedBySwitch()
		case "none":
			return 0
	}
}

export class Checker {
	#bound(cell: Cell): Bound {
		return { kind: "cell", cell }
	}

	g(cell: Cell): number {
		const r = this.#bound(cell)
		return r.kind === "cell" ? r.cell.viaMethodReturningUnion() : 0
	}
}
TS
cd "$dir"
"$fallow" --version
"$fallow" dead-code --unused-class-members "$@" || true
rm -rf "$dir"
