export interface DesktopBridge {
  connect(address: string): Promise<string | null>;
  retry(): void;
  edit(): void;
}
