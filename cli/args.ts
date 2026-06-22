const COMMANDS = new Set(["serve", "status", "sessions", "continue", "chat", "help"]);

export function parseCliArgs(argv = []) {
  const args = Array.from(argv);
  const command = args[0] && !args[0].startsWith("-") ? args.shift() : "help";
  if (!COMMANDS.has(command)) {
    return { command: "help", error: `unknown command: ${command}` };
  }

  const result = {
    command,
    plain: false,
    url: null,
    token: null,
    session: null,
    target: null,
    passthrough: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--plain") {
      result.plain = true;
    } else if (arg === "--url") {
      result.url = requireValue(args, ++i, "--url");
    } else if (arg === "--token") {
      result.token = requireValue(args, ++i, "--token");
    } else if (arg === "--session") {
      result.session = requireValue(args, ++i, "--session");
    } else if (arg === "--") {
      result.passthrough = args.slice(i + 1);
      break;
    } else if (command === "continue" && !result.target) {
      result.target = arg;
    } else {
      result.passthrough.push(arg);
    }
  }

  return result;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function helpText() {
  return `Hana CLI

Usage:
  hana serve [-- server args]        Start a headless HanaAgent Server
  hana status                       Show local server and agent status
  hana sessions                     List recent sessions
  hana continue [index|path]        Continue a recent session
  hana chat [--plain]               Open chat

Connection options:
  --url <baseUrl>                   Connect to a specific HanaAgent Server
  --token <token>                   Bearer token for that server
  --session <path>                  Chat in a specific session
`;
}
