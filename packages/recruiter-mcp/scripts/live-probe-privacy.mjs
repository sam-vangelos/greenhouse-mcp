/**
 * READ-ONLY live probe, scoped to the req Sam authorised (Research Engineer - Brazil,
 * job 5059946004 / req 1118).
 *
 * Every Greenhouse call below is a GET. The only POST is the standard OAuth2 client-credentials
 * token exchange, which mints a short-lived read token and mutates nothing. No move, reject,
 * patch, or delete is issued anywhere in this file.
 */
const ID = process.env.GH_ID;
const SECRET = process.env.GH_SECRET;
const JOB_ID = Number(process.env.PROBE_JOB_ID || 5059946004);

const tokenRes = await fetch("https://auth.greenhouse.io/token", {
  method: "POST",
  headers: {
    Authorization: `Basic ${Buffer.from(`${ID}:${SECRET}`).toString("base64")}`,
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: "grant_type=client_credentials",
});
if (!tokenRes.ok) {
  console.log("TOKEN FAILED", tokenRes.status, (await tokenRes.text()).slice(0, 300));
  process.exit(1);
}
const { access_token } = await tokenRes.json();
console.log("token minted OK\n");

async function get(path) {
  const res = await fetch(`https://harvest.greenhouse.io${path}`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!res.ok) return { error: res.status, body: (await res.text()).slice(0, 200) };
  return { data: await res.json() };
}
const show = (label, r, fn) =>
  console.log(r.error ? `${label}: ERROR ${r.error} ${r.body}` : `${label}: ${fn(r.data)}`);

console.log("=== Q1  CONFIDENTIAL JOBS (finding 3 blast radius) ===");
const conf = await get("/v3/jobs?confidential=true&per_page=100&fields=id,name,confidential");
show("  count", conf, (d) => `${d.length}${d.length ? " -> ids " + d.slice(0, 8).map((j) => j.id).join(",") : "  (exclusion set is EMPTY in this tenant)"}`);

console.log("\n=== Q2  USER ROLES (finding 2 live validity) ===");
const roles = await get("/v3/user_roles?per_page=100");
show("  roles", roles, (d) =>
  JSON.stringify(d.map((r) => ({ id: r.id, type: r.role_type, name: r.name }))));

console.log("\n=== Q3  APPLICATIONS DEFAULT FIELDS (my phase-0 assumption) ===");
const apps = await get("/v3/applications?per_page=2");
show("  keys", apps, (d) => {
  const row = d[0] || {};
  return `${JSON.stringify(Object.keys(row))}\n  has candidate_id = ${Object.prototype.hasOwnProperty.call(row, "candidate_id")}`;
});

console.log("\n=== Q4  PRIVATE CANDIDATES EXIST? (finding 5) ===");
const cands = await get("/v3/candidates?per_page=200&fields=id,private");
show("  sample", cands, (d) => {
  const priv = d.filter((c) => c.private === true);
  return `${d.length} sampled, ${priv.length} private${priv.length ? " -> ids " + priv.slice(0, 5).map((c) => c.id).join(",") : ""}\n  'private' present on row = ${Object.prototype.hasOwnProperty.call(d[0] || {}, "private")}`;
});

console.log(`\n=== Q5  THE AUTHORISED REQ ${JOB_ID} — is a stage move SAFE here? ===`);
const job = await get(`/v3/jobs?ids=${JOB_ID}&fields=id,name,confidential,status`);
show("  job", job, (d) => JSON.stringify(d[0] || null));
const stages = await get(`/v3/job_interview_stages?job_ids=${JOB_ID}&per_page=100`);
show("  stages", stages, (d) =>
  JSON.stringify(d.map((s) => ({ id: s.id, name: s.name, sort: s.sort_order }))));
const jobApps = await get(`/v3/applications?job_ids=${JOB_ID}&per_page=200`);
show("  applications", jobApps, (d) => {
  const byStage = {};
  for (const a of d) byStage[a.stage_name || "(none)"] = (byStage[a.stage_name || "(none)"] || 0) + 1;
  return `${d.length} total -> ${JSON.stringify(byStage)}`;
});
