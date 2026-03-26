/**
 * Maps `process.versions.modules` (NODE_MODULE_VERSION) to the Node.js release line
 * that introduced that ABI. Source of truth: Node's ABI registry
 * https://github.com/nodejs/node/blob/main/doc/abi_version_registry.json
 * (entries with runtime "node" only; stable preferred over *-pre where both exist).
 */
const NODE_ABI_TO_FIRST_RELEASE: Record<number, string> = {
  141: "25.0.0",
  137: "24.0.0",
  131: "23.0.0",
  127: "22.0.0",
  120: "21.0.0",
  115: "20.0.0",
  111: "19.0.0",
  108: "18.0.0",
  102: "17.0.0",
  93: "16.0.0",
  88: "15.0.0",
  83: "14.0.0",
  79: "13",
  72: "12",
  67: "11",
  64: "10",
  59: "9",
  57: "8",
  51: "7",
  48: "6",
  47: "5",
  46: "4",
};

/** Human-readable label for a NODE_MODULE_VERSION, e.g. "Node.js 22.x (ABI from 22.0.0)". */
export function describeNodeModuleVersion(modules: number): string {
  const first = NODE_ABI_TO_FIRST_RELEASE[modules];
  if (first) {
    const major = first.split(".")[0];
    return `Node.js ${major}.x (ABI from ${first}; module ${modules})`;
  }
  return `module ${modules} (no mapped release in zmail; see Node abi_version_registry.json)`;
}

/**
 * Parses the standard dlopen error from a mismatched native addon.
 * Example: "... using NODE_MODULE_VERSION 108. This version of Node.js requires NODE_MODULE_VERSION 127."
 */
export function parseNodeAbiMismatchMessage(message: string): {
  addonModule: number;
  runtimeModule: number;
} | null {
  const m = message.match(
    /NODE_MODULE_VERSION\s+(\d+)\.\s+This version of Node\.js requires\s+NODE_MODULE_VERSION\s+(\d+)/i
  );
  if (!m) return null;
  return { addonModule: Number(m[1]), runtimeModule: Number(m[2]) };
}

/** One or two lines explaining ABI numbers in plain language; empty if not parsed. */
export function formatNodeAbiMismatchExplanation(message: string): string[] {
  const parsed = parseNodeAbiMismatchMessage(message);
  if (!parsed) return [];
  const { addonModule, runtimeModule } = parsed;
  return [
    `The native addon was built for ${describeNodeModuleVersion(addonModule)}.`,
    `This process is ${describeNodeModuleVersion(runtimeModule)}.`,
  ];
}
