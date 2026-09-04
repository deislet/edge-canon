import path from "node:path";

export class ModuleGraphValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ModuleGraphValidationError";
    this.code = code;
  }
}

function reject(code, message) {
  throw new ModuleGraphValidationError(code, message);
}

function validArtifactModulePath(value) {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("/")
    && !value.includes("\\")
    && path.posix.normalize(value) === value
    && !value.startsWith("../");
}

export function validateRuntimeModuleGraph(modules, selectedRuntimeModules = []) {
  if (!Array.isArray(modules) || !Array.isArray(selectedRuntimeModules)) {
    reject("EC_ARTIFACT_MODULE_GRAPH_INVALID", "runtime module graph input is invalid");
  }
  const runtimeModules = new Set(selectedRuntimeModules);
  if (runtimeModules.size !== selectedRuntimeModules.length
      || selectedRuntimeModules.some((value) => typeof value !== "string" || value.length === 0)) {
    reject("EC_ARTIFACT_MODULE_GRAPH_INVALID", "selected runtime module list is invalid");
  }
  const modulePaths = new Set();
  for (const module of modules) {
    if (!module || !validArtifactModulePath(module.path) || !Array.isArray(module.imports) || modulePaths.has(module.path)) {
      reject("EC_ARTIFACT_MODULE_GRAPH_INVALID", "runtime module inventory is invalid");
    }
    modulePaths.add(module.path);
  }

  let fileEdges = 0;
  let runtimeEdges = 0;
  for (const module of modules) {
    for (const specifier of module.imports) {
      if (typeof specifier !== "string" || specifier.length === 0) {
        reject("EC_ARTIFACT_MODULE_GRAPH_INVALID", "runtime module edge is invalid");
      }
      if (runtimeModules.has(specifier)) {
        runtimeEdges += 1;
        continue;
      }
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        // Never include the specifier in the diagnostic: URL and registry
        // spellings can contain credentials even though they are forbidden.
        reject("EC_ARTIFACT_MODULE_EXTERNAL", "external runtime module edge is forbidden");
      }
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(module.path), specifier));
      if (!validArtifactModulePath(resolved) || !modulePaths.has(resolved)) {
        reject("EC_ARTIFACT_MODULE_MISSING", "relative runtime module edge is not in the artifact");
      }
      fileEdges += 1;
    }
  }
  return { moduleCount: modulePaths.size, fileEdges, runtimeEdges, closed: true };
}
