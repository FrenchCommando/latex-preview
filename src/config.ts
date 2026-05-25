import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";

export interface ProjectConfig {
  mainFile: string;
  debounceMs: number;
  latexCommand: string;
  latexArgs: string[];
  figureWatch: string[];
  figureCommand: string;
}

export const DEFAULT_CONFIG: ProjectConfig = {
  mainFile: "",
  debounceMs: 200,
  latexCommand: "texify",
  latexArgs: ["--pdf", "--batch"],
  figureWatch: [],
  figureCommand: "",
};

export const CONFIG_FILENAME = "latex-preview.json";

export async function loadConfig(
  workspaceRoot: string | null,
  output: vscode.OutputChannel,
): Promise<ProjectConfig> {
  if (!workspaceRoot) return { ...DEFAULT_CONFIG };
  const configPath = path.join(workspaceRoot, CONFIG_FILENAME);
  let text: string;
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return { ...DEFAULT_CONFIG };
    output.appendLine(`Failed to read ${CONFIG_FILENAME}: ${stringifyError(err)}`);
    return { ...DEFAULT_CONFIG };
  }

  let parsed: Partial<ProjectConfig>;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    output.appendLine(`Invalid JSON in ${CONFIG_FILENAME}: ${stringifyError(err)}`);
    vscode.window.showErrorMessage(
      `LaTeX Preview: ${CONFIG_FILENAME} is not valid JSON. See output for details.`,
    );
    return { ...DEFAULT_CONFIG };
  }

  return { ...DEFAULT_CONFIG, ...parsed };
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
