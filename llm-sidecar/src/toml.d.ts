// Bun imports `.toml` files natively (parsed object), and `bun build` inlines
// them into the bundle. Typed as `unknown` here; `capabilities.ts` casts to its
// validated `CapabilitiesDoc` shape.
declare module "*.toml" {
  const value: unknown;
  export default value;
}
