import { selectXPostUrl } from "./x-post-target.js";

const DOWNLOAD_URL_MESSAGE = "videobook-download-url";
const BUTTON_ATTR = "data-videobook-download-button";
const CYAN = "rgb(66, 223, 244)";
const SUCCESS = "rgb(0, 186, 124)";
const ERROR = "rgb(244, 33, 46)";

type DownloadResponse = {
  ok: true;
  assetId: string;
  jobId: string;
} | {
  ok: false;
  error: string;
};

function icon(color: string): string {
  return [
    `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">`,
    `<circle cx="10" cy="10" r="6.5" fill="${color}"></circle>`,
    `</svg>`,
  ].join("");
}

function sendDownload(url: string): Promise<DownloadResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: DOWNLOAD_URL_MESSAGE, url }, (response: DownloadResponse | undefined) => {
      const error = chrome.runtime.lastError;
      if (error) {
        resolve({ ok: false, error: error.message ?? "Unable to reach Videobook extension." });
        return;
      }

      resolve(response ?? { ok: false, error: "Videobook extension did not respond." });
    });
  });
}

function setButtonState(button: HTMLButtonElement, color: string, title: string): void {
  button.innerHTML = icon(color);
  button.title = title;
  button.setAttribute("aria-label", title);
}

function findActionBar(article: Element): Element | null {
  const groups = article.querySelectorAll('[role="group"]');
  for (const group of groups) {
    if (
      group.querySelector('[data-testid="reply"]') ||
      group.querySelector('[data-testid="retweet"]') ||
      group.querySelector('[data-testid="like"]') ||
      group.querySelector('[data-testid="bookmark"]')
    ) {
      return group;
    }
  }

  return null;
}

function findPostUrl(article: Element): string | null {
  const anchors = Array.from(
    article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]'),
    (anchor) => anchor.href,
  );
  return selectXPostUrl(anchors, window.location.href);
}

async function handleClick(button: HTMLButtonElement, url: string): Promise<void> {
  if (button.dataset.videobookState === "loading") return;

  button.dataset.videobookState = "loading";
  setButtonState(button, CYAN, "Queueing in Videobook...");
  button.style.opacity = "0.55";

  const result = await sendDownload(url);
  if (result.ok) {
    button.dataset.videobookState = "queued";
    button.style.opacity = "1";
    setButtonState(button, SUCCESS, "Queued in Videobook");
  } else {
    button.dataset.videobookState = "error";
    button.style.opacity = "1";
    setButtonState(button, ERROR, result.error);
  }

  window.setTimeout(() => {
    button.dataset.videobookState = "idle";
    button.style.opacity = "1";
    setButtonState(button, CYAN, "Download full source to Videobook");
  }, 2500);
}

function createButton(url: string): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.setAttribute(BUTTON_ATTR, "true");
  wrapper.style.display = "flex";
  wrapper.style.alignItems = "center";
  wrapper.style.justifyContent = "center";

  const button = document.createElement("button");
  button.type = "button";
  button.dataset.videobookState = "idle";
  button.style.appearance = "none";
  button.style.background = "transparent";
  button.style.border = "0";
  button.style.borderRadius = "9999px";
  button.style.cursor = "pointer";
  button.style.display = "flex";
  button.style.alignItems = "center";
  button.style.justifyContent = "center";
  button.style.margin = "0";
  button.style.padding = "0";
  button.style.width = "34px";
  button.style.height = "34px";
  setButtonState(button, CYAN, "Download full source to Videobook");

  button.addEventListener("mouseenter", () => {
    button.style.background = "rgba(66, 223, 244, 0.12)";
  });
  button.addEventListener("mouseleave", () => {
    button.style.background = "transparent";
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void handleClick(button, url);
  });

  wrapper.append(button);
  return wrapper;
}

function injectIntoArticle(article: Element): void {
  if (article.querySelector(`[${BUTTON_ATTR}]`)) return;

  const url = findPostUrl(article);
  if (!url) return;

  const actionBar = findActionBar(article);
  if (!actionBar) return;

  actionBar.append(createButton(url));
}

function injectButtons(): void {
  for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
    injectIntoArticle(article);
  }
}

injectButtons();

const observer = new MutationObserver(() => {
  injectButtons();
});

observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
});
