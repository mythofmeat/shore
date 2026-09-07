export class ToolLoopStop extends Error {
  constructor() {
    super("Tool workflow finished");
    this.name = "ToolLoopStop";
  }
}
