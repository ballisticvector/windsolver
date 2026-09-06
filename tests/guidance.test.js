"use strict";

// AGENTS.md and CLAUDE.md are one document under two names, because the two
// agents that read this repository look for different filenames.
//
// This is not tidiness. They drifted for two PRs without anyone noticing: the
// roughness dead end — "do not spend another run on z0" — was written into
// CLAUDE.md and not into AGENTS.md, so the file whose whole job is to stop a
// repeat of a finished investigation was missing it for the agent most likely
// to repeat it. A stale warning reads exactly like an absent one.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

test("AGENTS.md and CLAUDE.md say the same thing", () => {
  const agents = fs.readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
  const claude = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");
  expect(claude).toBe(agents);
});
