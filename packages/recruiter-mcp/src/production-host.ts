import { BlockList, isIP } from "node:net";

const LOOPBACK_IPV4 = new BlockList();
LOOPBACK_IPV4.addSubnet("127.0.0.0", 8, "ipv4");

const NON_PUBLIC_IPV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC_IPV4.addSubnet(network, prefix, "ipv4");
}

const LOOPBACK_IPV6 = new BlockList();
LOOPBACK_IPV6.addAddress("::1", "ipv6");

const NON_PUBLIC_IPV6 = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::ffff:0:0", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  NON_PUBLIC_IPV6.addSubnet(network, prefix, "ipv6");
}

export type NonProductionHostnameReason = "localhost" | "loopback" | "non_public_ip";

/** Reject literal local/special-use hosts before release tooling sends credentials or trusts evidence. */
export function classifyNonProductionHostname(value: string): NonProductionHostnameReason | null {
  const normalized = value.toLowerCase().replace(/\.$/, "");
  const hostname = normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return "localhost";

  const family = isIP(hostname);
  if (family === 4) {
    if (LOOPBACK_IPV4.check(hostname, "ipv4")) return "loopback";
    if (NON_PUBLIC_IPV4.check(hostname, "ipv4")) return "non_public_ip";
  }
  if (family === 6) {
    if (LOOPBACK_IPV6.check(hostname, "ipv6")) return "loopback";
    if (NON_PUBLIC_IPV6.check(hostname, "ipv6")) return "non_public_ip";
  }
  return null;
}
