/**
 * The NVIDIA GPU this machine has, and the torch build that can use it.
 *
 * PyPI's torch wheels for Windows are built without CUDA (the Linux ones
 * carry it), so a `uv tool install qwen-tts` on a Windows laptop with a
 * GeForce in it ran the model on the CPU, several times slower than speech,
 * and nothing said so. The CUDA builds live on PyTorch's own package index,
 * one index per CUDA generation, and the driver says which generation it
 * can run. Asked only from a setup flow or from Check Setup: it starts
 * nvidia-smi, and nothing on the activation path may start a process.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface NvidiaDriver {
  /** The CUDA version the driver supports, as "13.1". */
  cuda: string;
  /** The first GPU's name, as "NVIDIA GeForce RTX 3060 Laptop GPU". */
  gpu: string;
}

/** The driver's report, or undefined where there is no NVIDIA driver to ask. */
export function nvidiaDriver(): Promise<NvidiaDriver | undefined> {
  return new Promise((resolve) => {
    execFile("nvidia-smi", [], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
      if (err) {
        return resolve(undefined);
      }
      const cuda = /CUDA Version:\s*(\d+\.\d+)/.exec(stdout)?.[1];
      if (!cuda) {
        return resolve(undefined);
      }
      execFile(
        "nvidia-smi",
        ["--query-gpu=name", "--format=csv,noheader"],
        { timeout: 10_000, windowsHide: true },
        (err2, names) => {
          const gpu = err2 ? "" : (names.split("\n")[0] ?? "").trim();
          resolve({ cuda, gpu: gpu || "NVIDIA GPU" });
        }
      );
    });
  });
}

/**
 * PyTorch's wheel index for this driver, or undefined where the default
 * build already fits: no NVIDIA driver, or a platform whose PyPI wheels
 * carry CUDA. Each index holds the builds of one CUDA generation, and a
 * driver runs its own generation and the ones before it. A package that
 * pins torch 2.6 (Chatterbox) has no build past the 12.6 generation.
 */
export function torchIndexFor(
  driver: NvidiaDriver | undefined,
  platform: NodeJS.Platform = process.platform,
  torch26 = false
): string | undefined {
  if (!driver || platform !== "win32") {
    return undefined;
  }
  const [major, minor] = driver.cuda.split(".").map(Number);
  let generation: string | undefined;
  if (major >= 13) {
    generation = "cu130";
  } else if (major === 12 && minor >= 8) {
    generation = "cu128";
  } else if (major === 12) {
    generation = "cu126";
  }
  if (torch26 && generation) {
    generation = "cu126";
  }
  return generation && `https://download.pytorch.org/whl/${generation}`;
}

/** The uv arguments that make torch come from that index, if there is one. */
export function torchIndexArgs(index: string | undefined): string[] {
  return index ? ["--index", index] : [];
}

/**
 * Whether the torch installed in a virtualenv was built with CUDA, read
 * from the files it ships rather than by importing it: the CUDA runtime
 * library is only there in the CUDA builds. Undefined when torch is not
 * installed there at all.
 */
export function torchHasCuda(venv: string, platform: NodeJS.Platform = process.platform): boolean | undefined {
  const roots: string[] = [];
  if (platform === "win32") {
    roots.push(path.join(venv, "Lib", "site-packages"));
  } else {
    try {
      const lib = path.join(venv, "lib");
      for (const py of fs.readdirSync(lib)) {
        roots.push(path.join(lib, py, "site-packages"));
      }
    } catch {
      /* no lib directory: no torch either */
    }
  }
  for (const root of roots) {
    const lib = path.join(root, "torch", "lib");
    if (!fs.existsSync(lib)) {
      continue;
    }
    const cudaLib = platform === "win32" ? "c10_cuda.dll" : "libc10_cuda.so";
    return fs.existsSync(path.join(lib, cudaLib));
  }
  return undefined;
}

/** The virtualenv an interpreter belongs to: Scripts/python.exe or bin/python, two levels up. */
export function venvOf(python: string): string {
  return path.dirname(path.dirname(python));
}

/** torchHasCuda for the virtualenv an interpreter belongs to; undefined without one. */
export function torchCudaOf(python: string | undefined): boolean | undefined {
  return python ? torchHasCuda(venvOf(python)) : undefined;
}
