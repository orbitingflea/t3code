import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { ScrollToEndButton } from "../../components/chat/TimelineOverlays";
import { scrollToEndBottom, WORKING_INDICATOR_RESERVE_PX } from "./chatWorkingIndicator.logic";
import { WorkingIndicatorLayer } from "./ChatWorkingIndicator";

const environmentId = EnvironmentId.make("working-indicator-layout");
const COMPOSER_INSET = 120;
const LONG_SUMMARY =
  "3 new messages from the agent about the deploy, the lint job and the flaky end-to-end suite";

const intersects = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

it.each([
  [361, 662],
  [1280, 800],
])(
  "keeps the working line clear of Scroll to end, aligned with the composer and click-through at %ix%i",
  async (width, height) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(width, height);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    await using screen = await render(
      <div className="relative h-dvh w-full">
        <button type="button" data-under className="absolute inset-0" />
        <ScrollToEndButton
          bottom={scrollToEndBottom(COMPOSER_INSET, COMPOSER_INSET, WORKING_INDICATOR_RESERVE_PX)}
          summary={LONG_SUMMARY}
          onScrollToEnd={() => undefined}
        />
        <WorkingIndicatorLayer
          startedAt="2026-11-21T00:00:00.000Z"
          environmentId={environmentId}
          composerInset={COMPOSER_INSET}
        />
        <div className="chat-composer-lane absolute inset-x-0 bottom-0">
          <div
            data-composer-stack
            className="mx-auto w-full max-w-(--chat-content-max-width)"
            style={{ height: COMPOSER_INSET }}
          />
        </div>
      </div>,
    );
    const query = (selector: string) => screen.container.querySelector(selector)!;
    const layer = query("[data-chat-working-indicator]");
    await expect.element(page.getByText(/^Working for /)).toBeVisible();
    const pill = layer.firstElementChild!.firstElementChild!.getBoundingClientRect();

    expect(
      intersects(
        layer.getBoundingClientRect(),
        query("[data-scroll-to-end]").getBoundingClientRect(),
      ),
    ).toBe(false);
    expect(getComputedStyle(layer).pointerEvents).toBe("none");
    const hit = document.elementFromPoint(pill.left + pill.width / 2, pill.top + pill.height / 2);
    expect(hit).toBe(query("[data-under]"));
    expect(pill.left).toBe(query("[data-composer-stack]").getBoundingClientRect().left);
  },
);
