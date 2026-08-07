// Bun inlines `import ... with { type: "text" }` at build time, the same way it
// inlines `.toml` (see `toml.d.ts`). Used to keep prompt templates in the
// `prompts/` tree that owns them rather than copied into a string literal here.
declare module "*.md" {
  const value: string;
  export default value;
}
