# Save fixtures

Each file was written by the commit in its name, using that commit's own code (gzipped JSON). They are loaded by
`tests/save-compat.test.ts`, which must keep passing: old saves never stop loading and never lose data.

| File | Era |
|---|---|
| `valley-v1-before-dragon-609ca20` | Valley save v1 before the dragon existed |
| `valley-v1-dragon-df6bf74` | Valley save v1 with the dragon |
| `continent-v1-edits-fd09d48` | first continent saves: region edits only |
| `continent-v1-villages-1ccdf01` | with villages and bridges (newer generator), no living world |
| `continent-v1-life-pack-d55b216` | living world; the traveller's pack is a set of counts |
| `continent-v1-life-rpg-df6bf74` | characters (level, attributes, skills, equipment, pack, quests) |
| `server-v1-d55b216` | server file v1 (pack counts, taken finds at the top level) |
| `server-v2-df6bf74` | server file v2 (characters, the rules' world state inside `life`) |

## Adding a fixture when a format changes

Before changing a save format:
1. Generate a fixture of the current format with the current code.
2. Commit it.
3. Write the migration and its test.

The generator is `fixture-gen.test.ts.txt`. To use it:
1. Copy it into `tests/` as `fixture-gen.test.ts`, in a checkout (or `git worktree`) of the commit that writes the
   format.
2. Run `FIXTURE_OUT=<dir> FIXTURE_TAG=<commit> npx vitest run tests/fixture-gen.test.ts` there.
