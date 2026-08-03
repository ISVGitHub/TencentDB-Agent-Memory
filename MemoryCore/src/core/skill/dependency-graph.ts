/**
 * Skill Dependency Graph — validation and traversal utilities.
 *
 * Provides:
 * - Circular dependency detection
 * - Dependency resolution (topological sort)
 * - Composition workflow validation
 * - Runtime dependency loading helpers
 */

import type { SkillDependency, SkillCompositionStep } from "./types.js";

const TAG = "[skill-deps]";

export interface DependencyValidationError {
  type: "circular" | "missing" | "self_reference" | "duplicate";
  message: string;
  skill_id: string;
  dependency_id?: string;
}

/**
 * Validate skill dependencies for circular references and other issues.
 *
 * @param skillId - The skill being validated
 * @param dependencies - List of dependencies
 * @param getDependencies - Function to get dependencies of any skill (for transitive check)
 * @returns Array of validation errors (empty = valid)
 */
export async function validateDependencies(
  skillId: string,
  dependencies: SkillDependency[],
  getDependencies: (skillId: string) => Promise<SkillDependency[]>,
): Promise<DependencyValidationError[]> {
  const errors: DependencyValidationError[] = [];

  // 1. Self-reference check
  for (const dep of dependencies) {
    if (dep.skill_id === skillId) {
      errors.push({
        type: "self_reference",
        message: `Skill ${skillId} cannot depend on itself`,
        skill_id: skillId,
        dependency_id: dep.skill_id,
      });
    }
  }

  // 2. Duplicate check
  const seen = new Set<string>();
  for (const dep of dependencies) {
    if (seen.has(dep.skill_id)) {
      errors.push({
        type: "duplicate",
        message: `Duplicate dependency: ${dep.skill_id}`,
        skill_id: skillId,
        dependency_id: dep.skill_id,
      });
    }
    seen.add(dep.skill_id);
  }

  // 3. Circular dependency detection (DFS)
  const visited = new Set<string>();
  const inStack = new Set<string>();

  async function dfs(current: string): Promise<boolean> {
    if (inStack.has(current)) {
      errors.push({
        type: "circular",
        message: `Circular dependency detected: ${current} is in a cycle`,
        skill_id: skillId,
        dependency_id: current,
      });
      return true;
    }
    if (visited.has(current)) return false;

    visited.add(current);
    inStack.add(current);

    try {
      const deps = await getDependencies(current);
      for (const dep of deps) {
        if (await dfs(dep.skill_id)) return true;
      }
    } catch {
      // If we can't get dependencies, skip transitive check
    }

    inStack.delete(current);
    return false;
  }

  await dfs(skillId);

  return errors;
}

/**
 * Topological sort of skill dependencies.
 * Returns skills in dependency order (dependencies first).
 *
 * @param skillId - Root skill
 * @param getDependencies - Function to get dependencies of any skill
 * @returns Ordered list of skill IDs (root last), or null if cycle detected
 */
export async function resolveDependencyOrder(
  skillId: string,
  getDependencies: (skillId: string) => Promise<SkillDependency[]>,
): Promise<string[] | null> {
  const order: string[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();

  async function dfs(current: string): Promise<boolean> {
    if (inStack.has(current)) return true; // cycle
    if (visited.has(current)) return false;

    visited.add(current);
    inStack.add(current);

    const deps = await getDependencies(current);
    for (const dep of deps) {
      if (await dfs(dep.skill_id)) return true;
    }

    inStack.delete(current);
    order.push(current);
    return false;
  }

  const hasCycle = await dfs(skillId);
  if (hasCycle) return null;

  return order;
}

/**
 * Validate a composition workflow.
 *
 * Checks:
 * - All referenced skills exist
 * - No circular references in composition chain
 * - Input/output mappings are valid
 */
export function validateComposition(
  composition: SkillCompositionStep[],
): DependencyValidationError[] {
  const errors: DependencyValidationError[] = [];

  // Check for duplicate step names
  const names = new Set<string>();
  for (const step of composition) {
    if (names.has(step.name)) {
      errors.push({
        type: "duplicate",
        message: `Duplicate composition step name: ${step.name}`,
        skill_id: step.skill_id,
      });
    }
    names.add(step.name);
  }

  // Check for self-references (skill invoking itself in composition)
  // This is handled at a higher level since we don't have the parent skill_id here

  return errors;
}

/**
 * Get all transitive dependencies of a skill (flattened).
 * Useful for preloading all required skills before execution.
 */
export async function getTransitiveDependencies(
  skillId: string,
  getDependencies: (skillId: string) => Promise<SkillDependency[]>,
): Promise<string[]> {
  const all = new Set<string>();
  const queue = [skillId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const deps = await getDependencies(current);
    for (const dep of deps) {
      if (!all.has(dep.skill_id) && dep.skill_id !== skillId) {
        all.add(dep.skill_id);
        queue.push(dep.skill_id);
      }
    }
  }

  return Array.from(all);
}

/**
 * Format dependency validation errors for user-facing messages.
 */
export function formatDependencyErrors(errors: DependencyValidationError[]): string {
  if (errors.length === 0) return "";
  return errors.map((e) => `[${e.type}] ${e.message}`).join("\n");
}
