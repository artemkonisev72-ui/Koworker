import { parentPort } from "worker_threads";
import { loadPyodide } from "pyodide";
import { SANDBOX_BOOTSTRAP } from "../../sandbox/shared.js";
if (!parentPort) {
  throw new Error("pyodide-worker must be run in a worker_thread");
}
let pyodide = null;
let currentStdout = "";
async function init() {
  pyodide = await loadPyodide({
    stdout: (s) => {
      currentStdout += s + "\n";
    },
    stderr: (s) => {
      currentStdout += s + "\n";
    }
  });
  await pyodide.loadPackage(["numpy", "mpmath", "sympy"]);
  await pyodide.runPythonAsync(SANDBOX_BOOTSTRAP);
  parentPort.postMessage({ type: "ready" });
}
async function runTask(id, code) {
  if (!pyodide) {
    parentPort.postMessage({ id, ok: false, error: "Pyodide not initialized" });
    return;
  }
  currentStdout = "";
  try {
    pyodide.globals.set("__sandbox_code", code);
    await pyodide.runPythonAsync("_run_sandbox(__sandbox_code)");
    parentPort.postMessage({ id, ok: true, stdout: currentStdout.trim() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort.postMessage({ id, ok: false, error: message });
  } finally {
    try {
      pyodide.globals.delete("__sandbox_code");
    } catch {
    }
    currentStdout = "";
  }
}
parentPort.on("message", (msg) => {
  runTask(msg.id, msg.code).catch((err) => {
    parentPort.postMessage({
      id: msg.id,
      ok: false,
      error: String(err)
    });
  });
});
init().catch((err) => {
  parentPort.postMessage({ type: "init_error", error: String(err) });
  process.exit(1);
});
