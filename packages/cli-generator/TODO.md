# TODO

- The writer leaves the empty directories a failed run created: Effect's FileSystem has no remove-if-empty (rmdir). Once it has one (an upstream patch with a repro under ~/Documents/grizzle/upstream/), the writer removes exactly the directories it created, and only while they are empty.
