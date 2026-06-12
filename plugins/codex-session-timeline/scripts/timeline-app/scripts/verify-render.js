#!/usr/bin/env node
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");

function loadPlaywright() {
  try {
    return require("playwright");
  } catch {
    const bundledPath = path.join(
      os.homedir(),
      ".cache",
      "codex-runtimes",
      "codex-primary-runtime",
      "dependencies",
      "node",
      "node_modules",
      "playwright",
    );
    if (fs.existsSync(bundledPath)) return require(bundledPath);
    throw new Error("Playwright is not available. Install it or run this from a Codex desktop runtime.");
  }
}

const { chromium } = loadPlaywright();

async function main() {
  const root = path.resolve(__dirname, "..");
  const url =
    process.argv[2] ||
    "http://127.0.0.1:8787/?session=019e994f-92eb-7e11-862f-3c2b76a74757";
  const browser = await chromium.launch({ headless: true });
  const consoleErrors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  await page.goto(url, { waitUntil: "networkidle" });
  const statusText = await page.locator("#status").innerText();
  const metricTexts = await page
    .locator(".metric .value")
    .evaluateAll((nodes) => nodes.map((n) => n.textContent));
  const timelineBox = await page.locator(".timeline-svg").boundingBox();
  const subagentRows = await page.locator("#subagent-table tbody tr").count();
  const queueRows = await page.locator("#queue-table tbody tr").count();
  const desktopScreenshot = path.join(root, "dashboard-desktop.png");
  await page.screenshot({ path: desktopScreenshot, fullPage: true });

  const mobileErrors = [];
  const mobile = await browser.newPage({ viewport: { width: 390, height: 900 }, isMobile: true });
  mobile.on("console", (msg) => {
    if (msg.type() === "error") mobileErrors.push(msg.text());
  });
  await mobile.goto(url, { waitUntil: "networkidle" });
  const mobileTimelineBox = await mobile.locator(".timeline-svg").boundingBox();
  const mobileScreenshot = path.join(root, "dashboard-mobile.png");
  await mobile.screenshot({ path: mobileScreenshot, fullPage: true });
  await browser.close();

  console.log(
    JSON.stringify(
      {
        url,
        statusText,
        metricTexts,
        timelineBox,
        subagentRows,
        queueRows,
        consoleErrors,
        mobileTimelineBox,
        mobileErrors,
        desktopScreenshot,
        mobileScreenshot,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
