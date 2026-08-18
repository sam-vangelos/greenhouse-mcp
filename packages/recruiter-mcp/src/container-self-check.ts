import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMemoryAuditSink } from "./audit.js";
import { createRecruiterMcpServer } from "./server.js";
import { parseResumeDocument } from "./tools/resume.js";
import { PILOT_TOOL_NAMES, RECRUITER_TOOL_DEFINITIONS } from "./tools/register.js";

const PDF_FIXTURE = "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNjYgPj4Kc3RyZWFtCkJUIC9GMSAxMiBUZiA3MiA3MjAgVGQgKFBERiByZXN1bWU6IGRpc3RyaWJ1dGVkIHN5c3RlbXMgZW5naW5lZXIpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzMTEgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MzIKJSVFT0YK";
const DOCX_FIXTURE = "UEsDBAoAAAAIADCf9Fx5bjPX6AAAAK0BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH1QyU7DMBD9FWuuKHHggBCK0wPLETiUDxjZk8SqN3nc0v49Tlt6QIXjzFv1+tXeO7GjzDYGBbdtB4KCjsaGScHn+rV5AMEFg0EXAyk4EMNq6NeHRCyqNrCCuZT0KCXrmTxyGxOFiowxeyz1zJNMqDc4kbzrunupYygUSlMWDxj6Zxpx64p42df3qUcmxyCeTsQlSwGm5KzGUnG5C+ZXSnNOaKvyyOHZJr6pBJBXExbk74Cz7r0Ok60h8YG5vKGvLPkVs5Em6q2vyvZ/mys94zhaTRf94pZy1MRcF/euvSAebfjpL49zD99QSwMECgAAAAAAMJ/0XAAAAAAAAAAAAAAAAAYAAABfcmVscy9QSwMECgAAAAgAMJ/0XJv9N+qtAAAAKQEAAAsAAABfcmVscy8ucmVsc43POw7CMAwG4KtE3mlaBoRQ0y4IqSsqB7ASN61oHkrCo7cnAwNFDIy2f3+W6/ZpZnanECdnBVRFCYysdGqyWsClP232wGJCq3B2lgQsFKFt6jPNmPJKHCcfWTZsFDCm5A+cRzmSwVg4TzZPBhcMplwGzT3KK2ri27Lc8fBpwNpknRIQOlUB6xdP/9huGCZJRydvhmz6ceIrkWUMmpKAhwuKq3e7yCzwpuarF5sXUEsDBAoAAAAAADCf9FwAAAAAAAAAAAAAAAAFAAAAd29yZC9QSwMECgAAAAgAMJ/0XJS4I1i7AAAA/QAAABEAAAB3b3JkL2RvY3VtZW50LnhtbEWOu27DMAxFf0XQ3sjtEASG7QwpujZDA3RVJNYRYJEGydTx30dyhy6H4AOHtzs+8mR+gSUR9vZ111gDGCgmHHt7+fp4OVgj6jH6iRB6u4LY49AtbaRwz4BqigClXXp7U51b5yTcIHvZ0QxYdj/E2WtpeXQLcZyZAogUf57cW9PsXfYJbVVeKa61zhVcocP75+nbMEj51ZqYRDld7wrRyCoKWUraMSEAd66eV/LGTSIQ9MxuG/zZ3X/y4QlQSwECFAAKAAAACAAwn/RceW4z1+gAAACtAQAAEwAAAAAAAAAAAAAAAAAAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAAoAAAAAADCf9FwAAAAAAAAAAAAAAAAGAAAAAAAAAAAAEAAAABkBAABfcmVscy9QSwECFAAKAAAACAAwn/Rcm/036q0AAAApAQAACwAAAAAAAAAAAAAAAAA9AQAAX3JlbHMvLnJlbHNQSwECFAAKAAAAAAAwn/RcAAAAAAAAAAAAAAAABQAAAAAAAAAAABAAAAATAgAAd29yZC9QSwECFAAKAAAACAAwn/RclLgjWLsAAAD9AAAAEQAAAAAAAAAAAAAAAAA2AgAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAUABQAgAQAAIAMAAAAA";

export async function runContainerSelfCheck(): Promise<Record<string, unknown>> {
  const env = {
    GREENHOUSE_RECRUITER_ALLOWED_TOOLS: PILOT_TOOL_NAMES.join(","),
    GREENHOUSE_RECRUITER_SCOPE_SIGNING_SECRET: "container-self-check-scope-secret-32-characters",
  } as NodeJS.ProcessEnv;
  const { server, registeredTools } = createRecruiterMcpServer({
    session: {
      subject: "container-self-check",
      email: "container-self-check@example.invalid",
      surface: "chatgpt_desktop",
      client: "chatgpt_codex_host",
      tokenId: "container-self-check",
      issuedAt: "2026-01-01T00:00:00.000Z",
    },
    env,
    auditSink: createMemoryAuditSink(),
    configureGreenhouse: false,
    scopedReader: { scopedRead: async () => { throw new Error("container self-check never invokes a data tool"); } },
  });
  assertExactCatalog(registeredTools, "registered catalog");

  const client = new Client({ name: "greenhouse-recruiter-container-self-check", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    const listedNames = listed.tools.map((tool) => tool.name);
    assertExactCatalog(listedNames, "MCP tools/list catalog");
    const unsafe = listed.tools.filter((tool) =>
      tool.annotations?.readOnlyHint !== true ||
      tool.annotations?.destructiveHint !== false ||
      tool.annotations?.idempotentHint !== true
    ).map((tool) => tool.name);
    if (unsafe.length > 0) throw new Error(`unsafe MCP tool annotations: ${unsafe.join(",")}`);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }

  const [pdf, docx] = await Promise.all([
    parseResumeDocument(Buffer.from(PDF_FIXTURE, "base64"), "pdf", { timeoutMs: 10_000 }),
    parseResumeDocument(Buffer.from(DOCX_FIXTURE, "base64"), "docx", { timeoutMs: 10_000 }),
  ]);
  if (!pdf.text.includes("PDF resume: distributed systems engineer")) throw new Error("PDF parser self-check failed");
  if (!docx.text.includes("DOCX resume: distributed systems engineer")) throw new Error("DOCX parser self-check failed");

  return {
    ok: true,
    transport: "in_memory",
    authenticatedHttpSimulated: false,
    catalogToolCount: PILOT_TOOL_NAMES.length,
    hiddenToolCount: RECRUITER_TOOL_DEFINITIONS.length - PILOT_TOOL_NAMES.length,
    catalogOrder: true,
    readOnlyAnnotations: true,
    pdfParser: true,
    docxParser: true,
  };
}

function assertExactCatalog(actual: string[], label: string): void {
  const expected = new Set<string>(PILOT_TOOL_NAMES);
  const duplicates = actual.filter((name, index) => actual.indexOf(name) !== index);
  const missing = PILOT_TOOL_NAMES.filter((name) => !actual.includes(name));
  const unexpected = actual.filter((name) => !expected.has(name));
  const orderMatch = actual.every((name, index) => name === PILOT_TOOL_NAMES[index]);
  if (actual.length !== PILOT_TOOL_NAMES.length || duplicates.length > 0 || missing.length > 0 || unexpected.length > 0 || !orderMatch) {
    throw new Error(`${label} mismatch: ${JSON.stringify({ expectedCount: PILOT_TOOL_NAMES.length, actualCount: actual.length, duplicates, missing, unexpected, orderMatch })}`);
  }
}
