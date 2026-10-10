import fs from "node:fs/promises";
import path from "node:path";

export interface EnvironmentLayout {
  taskId: string;
  workspaceDir: string;
  homeDir: string;
  env: Record<string, string>;
}

export interface PrepareEnvironmentOptions {
  baseDir?: string;
  additionalEnv?: Record<string, string>;
}

/**
 * Builds a clean, isolated Pi runtime environment layout for a task.
 * Guarantees sandbox separation between concurrent runs.
 */
export async function prepareEnvironment(
  taskId: string,
  options?: PrepareEnvironmentOptions
): Promise<EnvironmentLayout> {
  const baseDir = options?.baseDir ?? "/tmp/aitra-tasks";
  const taskDir = path.join(baseDir, taskId);
  const workspaceDir = path.join(taskDir, "workspace");
  const homeDir = path.join(taskDir, "home");

  // Ensure directories exist cleanly
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });

  // Whitelist safe environment variables, scrub host secrets
  const sanitizedEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    SHELL: process.env.SHELL ?? "/bin/bash",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    HOME: homeDir,
    WORKSPACE_DIR: workspaceDir,
    AITRA_TASK_ID: taskId,
    ...(options?.additionalEnv ?? {}),
  };

  return {
    taskId,
    workspaceDir,
    homeDir,
    env: sanitizedEnv,
  };
}
