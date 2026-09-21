/**
 * The environment variable AI Engine sets on every provider subprocess it launches for an
 * orchestrated task. Its presence, with any non-empty value, is one of the independent signals a
 * caller uses to recognise that it is itself running inside an AI Engine-managed provider session
 * — and therefore must never delegate back into AI Engine.
 */
export const MANAGED_TASK_ENV = "AI_ENGINE_MANAGED_TASK";

/**
 * The marker value for a task: the task id itself, never empty. Detection treats an empty value as
 * "not marked", so an absent id must not silently disable the marker — an empty id (which a real
 * orchestrated task never has) is replaced by a fixed non-empty placeholder rather than passed on.
 * The id is otherwise passed through untouched: nothing here parses or validates it, and detection
 * deliberately does not either.
 */
export function managedTaskMarker(taskId: string): string {
  return taskId.length > 0 ? taskId : "unknown";
}

/**
 * A copy of `base` with the managed-task marker added. Everything else in the environment is
 * preserved exactly as it was; an inherited marker (a session nested inside another) is replaced by
 * this task's own. `base` is never modified.
 */
export function withManagedTaskMarker(base: NodeJS.ProcessEnv, taskId: string): NodeJS.ProcessEnv {
  return { ...base, [MANAGED_TASK_ENV]: managedTaskMarker(taskId) };
}
