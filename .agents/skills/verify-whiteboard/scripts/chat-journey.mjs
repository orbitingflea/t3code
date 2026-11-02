// Drives the embedded chat of a `wb-verify.sh up --chat` run the way a user does and saves
// screenshots to the run's evidence/. Usage: node chat-journey.mjs <run directory>
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

const repo = NodeURL.fileURLToPath(new URL("../../../../", import.meta.url));
const { chromium } = NodeModule.createRequire(`${repo}fork/whiteboard/package.json`)(
  "playwright-core",
);
const { boardRoom } = await import(`${repo}fork/whiteboard/web/room.mjs`);

const run = process.argv[2];
if (!run) throw new Error("usage: node chat-journey.mjs <run directory>");
const env = Object.fromEntries(
  NodeFS.readFileSync(`${run}/env`, "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split(/=(.*)/s).slice(0, 2)),
);
if (env.WB_VERIFY_CHAT !== "1") throw new Error("this run has no chat; start one with up --chat");
const project = `${env.WB_VERIFY_RUN}/project`;
const evidence = `${env.WB_VERIFY_RUN}/evidence`;
const steps = [];

const browser = await chromium.launch({
  executablePath: "/opt/google/chrome/chrome",
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const shot = (name) => page.screenshot({ path: `${evidence}/chat-${name}.png` });
const pass = (step) => {
  steps.push(step);
  console.error(`ok   ${step}`);
};

try {
  await page.goto(env.WHITEBOARD_URL);
  await page.waitForSelector(".tl-canvas");
  const chat = page.frameLocator('iframe[title="T3 Code chat"]');
  const composer = chat.getByTestId("composer-editor");
  const noProject = chat.getByText("Add a project to start your first thread.");
  await composer.or(noProject).first().waitFor();
  await shot("1-loaded");
  pass("chat loads inside the board through /chat/");

  if (await noProject.isVisible()) {
    // Without a project T3 opens its setup dialog, which hides the page behind it from roles.
    await chat.getByRole("button", { name: "Close" }).click();
    await chat.getByRole("button", { name: "Add project" }).click();
    await chat.getByText("Local folder").click();
    // The folder field starts with "~/", which would resolve under the run's private HOME.
    await page.keyboard.press("Control+A");
    await page.keyboard.type(`${project}/`);
    await page.keyboard.press("Enter");
    pass(`added project ${project}`);
  }
  await composer.waitFor();

  const room = boardRoom(project);
  await page.waitForFunction((want) => localStorage.getItem("wb-room") === want, room);
  const note = `project room note ${Date.now()}`;
  NodeChildProcess.execFileSync(`${repo}.agents/skills/verify-whiteboard/scripts/wb-verify.sh`, [
    "wb",
    env.WB_VERIFY_RUN,
    "write",
    "--room",
    room,
    "--type",
    "note",
    "--at",
    "200,150",
    "--text",
    note,
  ]);
  await page.getByTestId("canvas").getByText(note).waitFor();
  await shot("2-project-room");
  pass(`board follows the chat's project to room ${room}`);

  await page.getByTestId("tools.region-ref").click();
  await page.mouse.move(300, 300);
  await page.mouse.down();
  await page.mouse.move(520, 450, { steps: 10 });
  await page.mouse.up();
  await chat.getByRole("button", { name: /^Preview board:\/\/r\// }).waitFor();
  await shot("3-region-ref");
  pass(
    `region tool inserts ${JSON.stringify((await composer.innerText()).trim())} into the composer`,
  );

  const divider = page.getByRole("separator");
  await divider.focus();
  await page.keyboard.press("End");
  await page.locator(".wb-show").waitFor();
  await shot("4-chat-collapsed");
  await page.locator(".wb-show").click();
  await page.waitForFunction(
    () => document.querySelector(".chat-slot")?.getBoundingClientRect().width > 200,
  );
  pass("collapsed chat comes back with the board's Chat button");

  const box = await divider.boundingBox();
  await page.mouse.move(box.x + box.width / 2, 450);
  await page.mouse.down();
  await page.mouse.move(2, 450, { steps: 20 });
  await page.mouse.up();
  const boardButton = chat.getByRole("button", { name: "Board", exact: true });
  await boardButton.waitFor();
  await shot("5-board-collapsed");
  await boardButton.click();
  await page.waitForFunction(
    () => document.querySelector(".tl-canvas")?.getBoundingClientRect().width > 200,
  );
  await shot("6-restored");
  pass("collapsed board comes back with the chat's Board button");
} catch (error) {
  await shot("failed").catch(() => {});
  throw error;
} finally {
  await browser.close();
}
console.log(JSON.stringify({ evidence, steps }, null, 2));
