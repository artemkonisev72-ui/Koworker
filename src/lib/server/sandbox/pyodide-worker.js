import { parentPort } from "worker_threads";
import { loadPyodide } from "pyodide";
if (!parentPort) {
  throw new Error("pyodide-worker must be run in a worker_thread");
}
let pyodide = null;
let currentStdout = "";
async function init() {
  pyodide = await loadPyodide({
    // Перехватываем stdout/stderr на уровне Pyodide, не используя process.stdout.fd
    // (в worker_threads fd === undefined, что и вызывало ошибку)
    stdout: (s) => {
      currentStdout += s + "\n";
    },
    stderr: (s) => {
      currentStdout += s + "\n";
    }
  });
  await pyodide.loadPackage(["sympy", "numpy"]);
  parentPort.postMessage({ type: "ready" });
}
async function runTask(id, code) {
  if (!pyodide) {
    parentPort.postMessage({ id, ok: false, error: "Pyodide not initialized" });
    return;
  }
  currentStdout = "";
  try {
    await pyodide.runPythonAsync(code);
    parentPort.postMessage({ id, ok: true, stdout: currentStdout.trim() });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    parentPort.postMessage({ id, ok: false, error });
  } finally {
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
