import { queueVideocityDownload } from "./mcp.js";
import { isHttpUrl, selectDownloadUrl } from "./url-target.js";

const CONTEXT_MENU_ID = "videocity-download";
const DOWNLOAD_URL_MESSAGE = "videocity-download-url";

type DownloadUrlMessage = {
  type: typeof DOWNLOAD_URL_MESSAGE;
  url: string;
};

type DownloadUrlResponse = {
  ok: true;
  assetId: string;
  jobId: string;
} | {
  ok: false;
  error: string;
};

function isDownloadUrlMessage(value: unknown): value is DownloadUrlMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "url" in value &&
    value.type === DOWNLOAD_URL_MESSAGE &&
    typeof value.url === "string"
  );
}

function notify(title: string, message: string): void {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/videocity-128.png",
    title,
    message,
  });
}

function installContextMenu(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: "Download full source to Videocity",
      contexts: ["link", "page"],
    });
  });
}

async function queueUrl(url: string): Promise<DownloadUrlResponse> {
  if (!isHttpUrl(url)) {
    return { ok: false, error: "This URL cannot be downloaded." };
  }

  try {
    const result = await queueVideocityDownload(url);
    notify("Videocity download queued", `${result.assetId} (${result.jobId})`);
    return { ok: true, assetId: result.assetId, jobId: result.jobId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notify("Videocity download failed", message);
    return { ok: false, error: message };
  }
}

async function handleContextClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> {
  const url = selectDownloadUrl({
    linkUrl: info.linkUrl,
    pageUrl: info.pageUrl,
    tabUrl: tab?.url,
  });

  if (!url || !isHttpUrl(url)) {
    notify("Videocity", "This URL cannot be downloaded.");
    return;
  }

  await queueUrl(url);
}

chrome.runtime.onInstalled.addListener(installContextMenu);
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return;
  void handleContextClick(info, tab);
});
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse: (response: DownloadUrlResponse) => void) => {
  if (!isDownloadUrlMessage(message)) return false;

  void queueUrl(message.url).then(sendResponse);
  return true;
});
