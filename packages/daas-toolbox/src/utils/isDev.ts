// Module-scoped declaration so consumers don't need @types/node.
// Bundlers statically replace `process.env.NODE_ENV`; the typeof guard keeps
// unbundled browser environments from throwing a ReferenceError.
declare const process: { env: { NODE_ENV?: string } };

const isDev =
  typeof process !== "undefined" && (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test");

export default isDev;
