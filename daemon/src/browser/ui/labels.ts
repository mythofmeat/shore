export function fieldLabel(key: string): string {
  const words = key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return words === "" ? key : words[0]?.toUpperCase() + words.slice(1);
}
