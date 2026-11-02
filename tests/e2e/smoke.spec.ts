import { expect, test } from "@playwright/test";

test("app shell loads and the API answers", async ({ page, request }) => {
  const health = await request.get("/api/health");
  expect(health.ok()).toBe(true);
  expect(health.headers()["content-type"]).toContain("application/json");

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation").first()).toBeVisible();
});
