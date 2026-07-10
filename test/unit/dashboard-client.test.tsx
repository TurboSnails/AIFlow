import { test, expect } from "bun:test";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { App } from "../../src/dashboard/client/src/App";

test("App renders runs list route", () => {
  const html = renderToString(
    <StaticRouter location="/">
      <App />
    </StaticRouter>
  );
  expect(html).toContain("Runs");
});

test("App renders kanban route", () => {
  const html = renderToString(
    <StaticRouter location="/runs/r1/kanban">
      <App />
    </StaticRouter>
  );
  expect(html).toContain("Kanban:");
  expect(html).toContain("r1");
});

test("App renders debate route", () => {
  const html = renderToString(
    <StaticRouter location="/runs/r1/debate">
      <App />
    </StaticRouter>
  );
  expect(html).toContain("Debate:");
  expect(html).toContain("r1");
});

test("App renders review route", () => {
  const html = renderToString(
    <StaticRouter location="/runs/r1/review">
      <App />
    </StaticRouter>
  );
  expect(html).toContain("Review:");
  expect(html).toContain("r1");
});
