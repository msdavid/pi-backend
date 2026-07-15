/**
 * `/skill:name` RPC invocability (WP-3.5, §20.4).
 *
 * Pi registers every loaded skill as a `/skill:name` command (skills.md "Skill
 * Commands"). In RPC/SDK mode (`createAgentSession`), these commands are
 * available over the API surface once the skills are materialized into the
 * session — there is **no** additional backend work. This module documents the
 * path and provides a small seam the session manager uses.
 *
 * **Path (§20.4):**
 * 1. The session manager calls {@link resolveSessionSkills} +
 *    {@link materializeSessionSkillsToDirectory} (or {@link buildSkillsOverride})
 *    at session start — the skills land in Pi's discovery scope.
 * 2. Pi's `DefaultResourceLoader` indexes each skill (name + description only —
 *    progressive disclosure) and registers the `/skill:<name>` command.
 * 3. A client invokes `/skill:<name> [args]` via the same RPC/SDK channel used
 *    for any other slash command; Pi loads the full `SKILL.md` on demand and
 *    executes the skill.
 *
 * `invokeSkillCommand` is therefore a pure passthrough: it asserts the skills
 * are materialized (returns the canonical command string) and hands the actual
 * execution to Pi's command dispatcher. There is nothing backend-specific to
 * implement here — §20.4 is satisfied by materialization alone.
 */

import { ApiError } from "../errors.js";
import type { ResolvedSkill } from "./materialize.js";

/** Canonical `/skill:<name>` command for an attached skill (§20.4). */
export function skillCommand(skill: Pick<ResolvedSkill, "name">): string {
  return `/skill:${skill.name}`;
}

/** Validate that the requested skill is among the session's materialized set. */
export function assertSkillInvokable(
  name: string,
  materialized: ResolvedSkill[],
): string {
  const hit = materialized.find((s) => s.name === name);
  if (!hit) {
    throw new ApiError(
      404,
      "not_found",
      `skill not attached to session: ${name}`,
    );
  }
  return skillCommand(hit);
}
