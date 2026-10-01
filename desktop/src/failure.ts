export interface Failure { title: string; detail: string }

const UNREACHABLE: Failure = { title: "The daemon's host didn't answer", detail: "Check your network connection, VPN or Tailscale." };
const NOT_SHORE: Failure = {
  title: "Something answered, but not Shore's browser listener",
  detail: "Check the port and scheme. The browser client listens on [daemon.web] bind_addr (port 7340 unless changed) and uses https:// only when tls_cert is set. Port 7320 is the CLI's.",
};

export function describeLoadFailure(error: string): Failure {
  switch (error) {
    case "ERR_CONNECTION_REFUSED":
      return { title: "Nothing is listening at this address", detail: "Check that the daemon is running and that [daemon.web] is enabled for this host and port." };
    case "ERR_NAME_NOT_RESOLVED":
    case "ERR_NAME_RESOLUTION_FAILED":
      return { title: "This host name doesn't resolve", detail: "Check the spelling. For a Tailscale name, check that Tailscale is connected." };
    case "ERR_CONNECTION_TIMED_OUT":
    case "ERR_TIMED_OUT":
    case "ERR_ADDRESS_UNREACHABLE":
    case "ERR_INTERNET_DISCONNECTED":
    case "ERR_NETWORK_CHANGED":
    case "ERR_CONNECTION_FAILED":
      return UNREACHABLE;
    case "ERR_EMPTY_RESPONSE":
    case "ERR_INVALID_HTTP_RESPONSE":
    case "ERR_INVALID_RESPONSE":
    case "ERR_CONNECTION_CLOSED":
    case "ERR_CONNECTION_RESET":
      return NOT_SHORE;
    case "ERR_UNSAFE_PORT":
      return { title: "This port is blocked", detail: "Chromium refuses connections to this port. Move [daemon.web] bind_addr to another one, such as 7340." };
  }
  if (error.startsWith("ERR_CERT_") || error.startsWith("ERR_SSL_")) {
    return { title: "The HTTPS connection failed", detail: "Check daemon.web.tls_cert, or use http:// if the listener doesn't use TLS." };
  }
  return { title: "Shore couldn't load", detail: error };
}

export function describeHttpFailure(status: number): Failure {
  if (status === 503) return { title: "The daemon isn't ready yet", detail: "It answered but hasn't finished starting. Shore loads as soon as it's ready." };
  return { title: `The server answered with HTTP ${String(status)}`, detail: "Check that this address points at the daemon's browser listener." };
}

const RETRY_SECONDS = [2, 5, 10, 30];

export function retryDelay(attempt: number): number {
  return RETRY_SECONDS[Math.min(Math.max(attempt, 1), RETRY_SECONDS.length) - 1] ?? 30;
}
