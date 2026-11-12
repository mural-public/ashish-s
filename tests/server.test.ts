import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/server";

const app = createApp();

describe("GET /health", () => {
  it("responds 200 with ok=true", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, service: "contractor-pay" });
  });
});

describe("error handler", () => {
  it("returns 404-style error envelope for unknown routes", async () => {
    const res = await request(app).get("/does-not-exist");
    expect(res.status).toBe(404);
  });
});
