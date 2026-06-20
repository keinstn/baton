import { describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/dashboard/http.js";

const targets = [
  { name: "implementer", url: "http://127.0.0.1:8787" },
  { name: "reviewer", url: "http://127.0.0.1:8788" },
];

async function startTestServer() {
  const server = await startDashboardServer({
    host: "127.0.0.1",
    port: 0,
    targets,
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  return { server, baseUrl };
}

describe("dashboard HTTP server", () => {
  it("GET / returns 200 HTML containing target names", async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      const body = await res.text();
      expect(body).toContain("implementer");
      expect(body).toContain("reviewer");
    } finally {
      await server.close();
    }
  });

  it("GET / embeds TARGETS script with instance URLs", async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const res = await fetch(`${baseUrl}/`);
      const body = await res.text();
      expect(body).toContain("const TARGETS =");
      expect(body).toContain("http://127.0.0.1:8787");
      expect(body).toContain("http://127.0.0.1:8788");
    } finally {
      await server.close();
    }
  });

  it("HEAD / returns 200 with no body", async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const res = await fetch(`${baseUrl}/`, { method: "HEAD" });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
    } finally {
      await server.close();
    }
  });

  it("POST / returns 405", async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const res = await fetch(`${baseUrl}/`, { method: "POST" });
      expect(res.status).toBe(405);
    } finally {
      await server.close();
    }
  });

  it("GET /unknown returns 404", async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const res = await fetch(`${baseUrl}/unknown`);
      expect(res.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("GET / includes safeHref scheme-check function to prevent javascript: XSS", async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const res = await fetch(`${baseUrl}/`);
      const body = await res.text();
      expect(body).toContain("safeHref");
      expect(body).toContain('u.protocol === "https:"');
      expect(body).toContain('u.protocol === "http:"');
    } finally {
      await server.close();
    }
  });

  it("GET / includes Array.isArray guards for running/retrying to handle malformed payloads", async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const res = await fetch(`${baseUrl}/`);
      const body = await res.text();
      expect(body).toContain("Array.isArray(snap.running)");
      expect(body).toContain("Array.isArray(snap.retrying)");
      expect(body).toContain("Number.isFinite");
    } finally {
      await server.close();
    }
  });

  it("GET / includes setInterval auto-refresh", async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const res = await fetch(`${baseUrl}/`);
      const body = await res.text();
      expect(body).toContain("setInterval(fetchAll,");
    } finally {
      await server.close();
    }
  });

  it("script-safe TARGETS: </script> in name/URL does not break the script block", async () => {
    const server = await startDashboardServer({
      host: "127.0.0.1",
      port: 0,
      targets: [
        {
          name: "bad</script><script>alert(1)//",
          url: "http://127.0.0.1:1234",
        },
      ],
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      const body = await res.text();
      // The raw </script> sequence must not appear inside the script block
      expect(body).not.toContain("</script><script>");
      // The data must still be embedded (as Unicode escapes)
      expect(body).toContain("\\u003c/script\\u003e");
    } finally {
      await server.close();
    }
  });
});
