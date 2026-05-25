import { spawn } from "node:child_process";
import * as path from "node:path";

export interface CompileResult {
  pdfPath: string | null;
  log: string;
  success: boolean;
}

export interface ShellResult {
  success: boolean;
  log: string;
}

export function runShell(command: string, cwd: string): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [], { cwd, shell: true });
    let buffer = "";
    child.stdout.on("data", (chunk) => (buffer += chunk.toString()));
    child.stderr.on("data", (chunk) => (buffer += chunk.toString()));
    child.on("error", (err) => {
      resolve({ success: false, log: `Failed to run: ${err.message}` });
    });
    child.on("exit", (code) => {
      resolve({ success: code === 0, log: buffer });
    });
  });
}

export function compile(
  texPath: string,
  command: string,
  extraArgs: string[],
): Promise<CompileResult> {
  return new Promise((resolve) => {
    const cwd = path.dirname(texPath);
    const fileName = path.basename(texPath);
    const baseName = path.basename(texPath, path.extname(texPath));
    const args = [...extraArgs, fileName];

    const child = spawn(command, args, {
      cwd,
      shell: process.platform === "win32",
    });

    let buffer = "";
    child.stdout.on("data", (chunk) => (buffer += chunk.toString()));
    child.stderr.on("data", (chunk) => (buffer += chunk.toString()));

    child.on("error", (err) => {
      resolve({
        pdfPath: null,
        log: `Failed to start ${command}: ${err.message}\nIs ${command} on PATH?`,
        success: false,
      });
    });

    child.on("exit", (code) => {
      const pdfPath = path.join(cwd, `${baseName}.pdf`);
      resolve({
        pdfPath: code === 0 ? pdfPath : null,
        log: buffer,
        success: code === 0,
      });
    });
  });
}
