export interface CommandContext {
  sessionId?: string;
  workspacePath: string;
  runtime?: unknown;
  [key: string]: unknown;
}

export interface Command {
  name: string;
  description: string;
  /** Handler receives the raw argument string after the command name. */
  handler(args: string, context: CommandContext): Promise<string> | string;
  pluginId?: string;
}

export class CommandRegistry {
  private commands = new Map<string, Command>();

  register(command: Command): void {
    const name = command.name.replace(/^\//, '');
    this.commands.set(name, command);
  }

  unregister(name: string): boolean {
    return this.commands.delete(name.replace(/^\//, ''));
  }

  get(name: string): Command | undefined {
    return this.commands.get(name.replace(/^\//, ''));
  }

  list(): Command[] {
    return [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async run(name: string, args: string, context: CommandContext): Promise<string> {
    const command = this.get(name);
    if (!command) throw new Error(`unknown command /${name}`);
    return command.handler(args, context);
  }

  /** True if a string starts with a registered slash command. */
  parse(input: string): { name: string; args: string } | undefined {
    const m = input.trim().match(/^\/([a-zA-Z0-9_-]+)\s*(.*)$/s);
    if (!m) return undefined;
    const name = m[1]!;
    if (!this.commands.has(name)) return undefined;
    return { name, args: m[2] ?? '' };
  }
}
