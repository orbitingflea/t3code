import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { RightPanelSheet } from "../../components/RightPanelSheet";
import { WhiteboardBoardButton } from "./WhiteboardSidebar";

function Harness(props: { readonly sheetOpen: boolean; readonly animationDurationMs?: number }) {
  const [open, setOpen] = useState(props.sheetOpen);
  return (
    <>
      <WhiteboardBoardButton />
      <RightPanelSheet
        animationDurationMs={props.animationDurationMs ?? 0}
        open={open}
        onClose={() => setOpen(false)}
      >
        <span>#66</span>
        <button type="button" onClick={() => setOpen(false)}>
          Close panel
        </button>
      </RightPanelSheet>
    </>
  );
}

function appRoot() {
  const root = document.createElement("div");
  root.id = "root";
  return root;
}

const boardButton = (screen: Awaited<ReturnType<typeof render>>) =>
  screen.getByRole("button", { name: "Board", includeHidden: true });

describe("WhiteboardBoardButton", () => {
  it("gives way to the open right panel sheet, which starts under it at phone width", async () => {
    await page.viewport(361, 662);
    await using screen = await render(<Harness sheetOpen />, {
      container: appRoot(),
      router: false,
    });

    await expect.element(page.getByText("#66")).toBeVisible();
    await expect.element(boardButton(screen)).not.toBeVisible();
  });

  it("stays away while the sheet slides out", async () => {
    await page.viewport(361, 662);
    await using screen = await render(<Harness sheetOpen animationDurationMs={60_000} />, {
      container: appRoot(),
      router: false,
    });
    await expect.element(boardButton(screen)).not.toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Close panel" }));

    await expect
      .element(page.getByText("#66"))
      .toSatisfy((tab) => tab.closest("[data-ending-style]") !== null);
    await expect.element(boardButton(screen)).not.toBeVisible();
  });

  it("stays while the right panel sheet is closed", async () => {
    await page.viewport(361, 662);
    await using screen = await render(<Harness sheetOpen={false} />, {
      container: appRoot(),
      router: false,
    });

    await expect.element(boardButton(screen)).toBeVisible();
  });

  it("comes back once the sheet has closed", async () => {
    await page.viewport(361, 662);
    await using screen = await render(<Harness sheetOpen />, {
      container: appRoot(),
      router: false,
    });
    await expect.element(boardButton(screen)).not.toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Close panel" }));

    await expect.element(boardButton(screen)).toBeVisible();
  });

  it("stays beside the wider sheet that starts clear of it", async () => {
    await page.viewport(800, 900);
    await using screen = await render(<Harness sheetOpen />, {
      container: appRoot(),
      router: false,
    });

    await expect.element(page.getByText("#66")).toBeVisible();
    await expect.element(boardButton(screen)).toBeVisible();
  });
});
