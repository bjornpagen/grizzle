README: a trigger disabled by ALTER TABLE ... DISABLE TRIGGER still sets the TriggerDesc hint flags, so it costs every row
its work (a lock, every stored generated column, a leaked bitmap), with a patch for master

Status: ready to send, NOT sent. Nothing in this folder has gone to any list, site or PostgreSQL remote. The owner
sends it, by hand.

1. WHAT THIS IS
   - The cost: SetTriggerFlags() sets the trig_* flags from tgtype alone, for disabled triggers too, and the executor
     reads them to decide whether to look for triggers. With only a disabled BEFORE ROW UPDATE trigger, an UPDATE locks
     each row before updating it (a lock WAL record, and the locker left on the new tuple's xmax), computes every
     stored generated column whatever it assigns, and leaks about 41 bytes a row (upstream/update-lock-mode-key-columns).
     On 19.0, 100,000 rows: 100,000 generation expressions where none was needed, 5.6 MB more WAL, 730 ms where 450 ms
     sufficed (EVIDENCE.txt 3). A disabled BEFORE INSERT trigger stops COPY's batching, a disabled AFTER trigger with a
     transition table keeps statements capturing, disabled row triggers stop postgres_fdw's direct modify.
   - Not a wrong result: a performance defect, in every supported release, since the flags were introduced in their
     present form (2ec993a7cbd, 9.1; EVIDENCE.txt 2). No earlier report was found.
   - v1, ours: SetTriggerFlags() returns early for tgenabled = TRIGGER_DISABLED, which TriggerEnabled() never fires.
     Enabling or disabling a trigger invalidates the relcache entry, so the flags follow it. Triggers enabled for origin
     or replica only still set them (session_replication_role changes without an invalidation). The one behaviour
     change, a view's INSTEAD OF trigger disabled by a hand edit of pg_trigger (DISABLE TRIGGER is refused on views), is
     called out in the email (EVIDENCE.txt 1).

2. WHAT TO SEND, TO WHOM
   - A new thread on pgsql-hackers: no thread on it exists (bug-reporting.html 5.1 asks first), it comes with a patch
     (https://wiki.postgresql.org/wiki/Submitting_a_Patch), and it is a performance improvement with one behaviour
     change for the list to weigh, not a pgsql-bugs report. Plain text.
   - email.txt is that message, To pgsql-hackers alone.
   - Attach v1-0001-Don-t-let-disabled-triggers-set-the-trigger-hint-.patch and repro.sql. Attach, don't paste.
   - Before sending, in a PostgreSQL clone at master:
         git am v1-0001-*.patch
         git commit --amend --reset-author    # sets your sending address as the author; From: is the GitHub noreply
                                              # address
         git format-patch -v1 -1
     The sending address is deliberately not written anywhere in this public repository.
   - Afterwards, once the message is in the archive: add it to the open commitfest (https://commitfest.postgresql.org/,
     community account), as a performance item.

3. HOW TO APPLY AND TEST
       git clone https://git.postgresql.org/git/postgresql.git && cd postgresql
       git am .../v1-0001-*.patch
       meson setup build -Dcassert=true -Dtap_tests=enabled      # TAP needs Perl's IPC::Run
       ninja -C build && meson test -C build                     # every suite
   - The kill: take the early return out of SetTriggerFlags(), keeping the test, and triggers fails at the disabled
     UPDATE: a NOTICE that the generation was computed, and unlocked = f (EVIDENCE.txt 4).
   - The cost, against any build, unpatched and patched: psql -X -v n=100000 -f repro.sql, which reports generations,
     WAL bytes, time and rows left locked for no trigger, a disabled and an enabled BEFORE ROW UPDATE trigger.

4. FILES
   v1-0001-...patch   the patch, git format-patch of the commit on master 892cfb4cbfe: trigger.c and the regression test
   email.txt          the message to send
   EVIDENCE.txt       the cause in the source, its history, before and after numbers, the tests
   repro.sql          the reproduction the email inlines in short
   NOTES.txt          grizzle's side

5. CHECKLIST: PostgreSQL contribution policy, applied
  A. GATES BEFORE REPORTING
  [x] Check whether the problem is already known: web searches for SetTriggerFlags, trig_update_before_row, disabled
      triggers' per-row cost and GetTupleForTrigger with DISABLE TRIGGER find nothing on it (EVIDENCE.txt 2).
  [x] Check the current development branch: master 892cfb4cbfe, built and measured (EVIDENCE.txt 3).
  [x] A released version is affected: 19.0 measured.
  [x] Don't duplicate a discussion: a new thread, with a cross-reference to the ExecUpdateLockMode reply.
  B. REPORT CONTENT
  [x] A self-contained reproduction runnable with psql -X: repro.sql, inline in short in email.txt.
  [x] Observed and expected behaviour, version and platform: email.txt, EVIDENCE.txt.
  [x] Plain text, no confidentiality footer.
  C. PATCH
  [x] Against current master, one patch, git format-patch, v1.
  [x] Commit message in the project's style: summary line, cause, effect with numbers, fix, its soundness, the one
      behaviour change.
  [x] A regression test, which fails without the fix (EVIDENCE.txt 4).
  [x] Builds with assertions; meson test, every suite including TAP, passes on master.
  [x] pgindent clean, git diff --check clean.
  [x] Back branches: not proposed (a performance change); the email says the patch applies to REL_19_STABLE and
      REL_18_STABLE as is, checked with git apply --check, untested there.
  [ ] The author line: the owner sets it before sending (section 2).
  [ ] The commitfest entry, after the message reaches the archive.
