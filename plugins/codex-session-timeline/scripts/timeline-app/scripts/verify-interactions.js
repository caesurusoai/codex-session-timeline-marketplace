#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

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
  const url =
    process.argv[2] ||
    "http://127.0.0.1:8787/?session=019ecc30-81ee-7500-b353-95ec0d0a18b4";
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector(".timeline-svg");

  const initialMarkers = await page.locator(".marker-clickable").count();
  const initialSpans = await page.locator(".span-clickable").count();
  if (initialSpans > 0) {
    await page.locator(".span-clickable").first().click({ force: true });
  } else if (initialMarkers > 0) {
    await page.locator(".marker-clickable").first().click({ force: true });
  }
  const inspectorVisible = await page.locator("#marker-popover-card:not([hidden])").count();
  const inspectorTitle = inspectorVisible
    ? await page.locator("#marker-popover-title").innerText()
    : "";

  await page.locator("#filter-events").uncheck({ force: true });
  const markersAfterFilterOff = await page.locator(".marker-clickable").count();
  await page.locator("#filter-events").check({ force: true });
  const markersAfterFilterOn = await page.locator(".marker-clickable").count();

  await page.locator("#timeline-zoom-in").click({ force: true });
  const beforeDomain = await page.locator(".timeline-svg").getAttribute("data-domain-start");
  await page.locator(".minimap-svg").scrollIntoViewIfNeeded();
  const minimap = await page.locator(".minimap-svg").boundingBox();
  if (minimap) {
    await page.mouse.move(minimap.x + minimap.width * 0.05, minimap.y + minimap.height / 2);
    await page.mouse.down();
    await page.mouse.move(minimap.x + minimap.width * 0.22, minimap.y + minimap.height / 2);
    await page.mouse.up();
  }
  const afterDomain = await page.locator(".timeline-svg").getAttribute("data-domain-start");
  const readout = await page.locator("#timeline-readout").innerText();

  await page.locator("#queues-tab").click({ force: true });
  const queueTimelineVisible = await page.locator(".queue-timeline-svg").count();
  const queueLabels = queueTimelineVisible
    ? await page.locator(".queue-timeline-svg .lane-label").evaluateAll((labels) =>
        labels.map((label) => label.getAttribute("aria-label") || label.textContent || ""),
      )
    : [];
  const queueActivityTargets = queueTimelineVisible
    ? await page.locator(".queue-activity-clickable").count()
    : 0;
  const queueHasUuidLabels = queueLabels.some((label) =>
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i.test(label),
  );

  await browser.close();
  console.log(
    JSON.stringify(
      {
        url,
        initialSpans,
        initialMarkers,
        inspectorVisible,
        inspectorTitle,
        markersAfterFilterOff,
        markersAfterFilterOn,
        minimapChangedWindow: beforeDomain !== afterDomain,
        readout,
        queueTimelineVisible,
        queueLabels,
        queueActivityTargets,
        queueHasUuidLabels,
        consoleErrors,
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
