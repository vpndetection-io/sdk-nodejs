import { lib, typeChecked } from "@mslm/libjs-eslint-config";

export default [
  { ignores: ["dist/**", "node_modules/**", "spec/**", "integration/**", "src/generated/**", "**/*.gen.ts"] },
  ...lib,
  typeChecked(import.meta.dirname),
];
