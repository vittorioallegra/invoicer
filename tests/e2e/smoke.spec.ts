import { expect, test } from "@playwright/test";

test("the API answers and an anonymous visitor lands on the login screen", async ({
  page,
  request,
}) => {
  const health = await request.get("/api/health");
  expect(health.ok()).toBe(true);
  expect(health.headers()["content-type"]).toContain("application/json");
  expect((await request.get("/api/features")).status()).toBe(401);

  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeVisible();
});

test("the setup screen asks for the setup token on a fresh install", async ({ page }) => {
  await page.goto("/setup");
  await expect(page.getByLabel("Setup token")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create owner account" })).toBeVisible();
});
